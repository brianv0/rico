// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of the Go package d2layouts/d2talalayout/internal/placement (D2 v0.9.0, github.com/d2lang/d2, Copyright 2022
// Terrastruct Inc.): dejitter.go.

import * as geo from '../../geo.js';
import { goRound } from '../../gomath.js';
import * as lg from '../layoutgraph.js';
import * as placementcost from '../placementcost.js';
import { commitErr, jitterThreshold, signFlipPadding } from './types.js';

/**
 * dejitter performs micro-movements on nodes to remove the jittery connections that can be straightened out with slight
 * adjustments in one direction. E.g. jittery line:
 *              +--------->
 *   +-----------+
 */
export function dejitter(ctx, g) {
  let guard;
  [ctx, guard] = lg.ensureTransactionWorkGuard(ctx, 'DejitterTransactions');
  let dejittered = false;
  const txn = g.newRequestTransaction(ctx, { affectContainers: true });
  if (g.nodes.length === 0) return false;
  let rollback = null;
  let complete = false;
  try {
    for (const node of g.nodes) {
      if (node.cluster !== null) continue;
      // Too much trouble to have to jitter all children too
      if (node.isContainer()) continue;
      if (g.nodeToTree !== null && g.nodeToTree.has(node)) continue;
      if (node.sequence !== null) continue;
      if (node.fixedTopLeft !== null) continue;

      const prevSymmetry = placementcost.nodeSymmetry(ctx, node, null);
      for (const edge of node.edges) {
        // No jitter possible with less than 3 segments
        if (edge.numSegments() < 3) continue;
        if (node.adjacent(edge).cluster !== null) continue;

        let pointBeforeBends = null;
        let pointOnNode = null;
        const lastTwoBends = [];
        // Skip the first of each since it's the port
        if (edge.from === node) {
          lastTwoBends.push(edge.points[1], edge.points[2]);
          pointBeforeBends = edge.points[3];
          pointOnNode = edge.points[0];
        } else if (edge.to === node) {
          lastTwoBends.push(edge.points[edge.points.length - 2], edge.points[edge.points.length - 3]);
          pointBeforeBends = edge.points[edge.points.length - 4];
          pointOnNode = edge.points[edge.points.length - 1];
        }

        // Only a jitter if the last two bends fall within threshold
        if (geo.euclideanDistance(lastTwoBends[0].x, lastTwoBends[0].y, lastTwoBends[1].x, lastTwoBends[1].y) > jitterThreshold) continue;

        // A vertical line moves horizontally to the second bend's X to straighten it.
        const isVerticalLine = lastTwoBends[0].y === lastTwoBends[1].y;

        // TODO: support correcting U-turns. Leave them unchanged here because they are not straightforward to collapse safely.
        // A U-turn has both the point before the bends and the point on the node on one side of the bends.
        if (isVerticalLine) {
          if ((pointBeforeBends.y > lastTwoBends[0].y) && (pointOnNode.y > lastTwoBends[0].y)) continue;
          if ((pointBeforeBends.y < lastTwoBends[0].y) && (pointOnNode.y < lastTwoBends[0].y)) continue;
        } else {
          if ((pointBeforeBends.x > lastTwoBends[0].x) && (pointOnNode.x > lastTwoBends[0].x)) continue;
          if ((pointBeforeBends.x < lastTwoBends[0].x) && (pointOnNode.x < lastTwoBends[0].x)) continue;
        }

        if (isVerticalLine) {
          if (lastTwoBends[1].x === lastTwoBends[0].x) continue;
        } else if (lastTwoBends[1].y === lastTwoBends[0].y) {
          continue;
        }

        // ---- from here on we know it is a jitter line

        // Look for other connected edges which are straight lines
        let hasAnotherConnectedStraightEdge = false;
        for (const otherEdge of node.edges) {
          if (otherEdge === edge) continue;
          if (otherEdge.numSegments() > 1) continue;
          // If the jittering one is vertical, we only look for other vertical ones
          if (otherEdge.from === node) {
            if (isVerticalLine && (otherEdge.points[0].x === otherEdge.points[1].x)) {
              hasAnotherConnectedStraightEdge = true;
              break;
            }
            if (!isVerticalLine && (otherEdge.points[0].y === otherEdge.points[1].y)) {
              hasAnotherConnectedStraightEdge = true;
              break;
            }
          } else {
            if (isVerticalLine && (otherEdge.points[otherEdge.points.length - 1].x === otherEdge.points[otherEdge.points.length - 2].x)) {
              hasAnotherConnectedStraightEdge = true;
              break;
            }
            if (!isVerticalLine && (otherEdge.points[otherEdge.points.length - 1].y === otherEdge.points[otherEdge.points.length - 2].y)) {
              hasAnotherConnectedStraightEdge = true;
              break;
            }
          }
        }
        // Don't want to move other nodes
        if (hasAnotherConnectedStraightEdge) continue;

        // ---- from here on we know there is no adjacent node connected via a tangent straight line

        let delta;
        if (isVerticalLine) delta = goRound(lastTwoBends[1].x - lastTwoBends[0].x);
        else delta = goRound(lastTwoBends[1].y - lastTwoBends[0].y);

        // Sometimes it'll get real close to a sign flip but not yet. We want to prevent these super short edges, so we'll
        // extend delta a little to consider those a sign flip
        let signFlipDelta;
        if (delta < 0) signFlipDelta = delta - signFlipPadding;
        else signFlipDelta = delta + signFlipPadding;

        // A sign flip is when there's movement on the endpoint but not the bend, and the new endpoint ends up on the other
        // axis of the bend (potentially going into the node). For edges that are opposite directions (one vert one horiz), the
        // concern is that the jitter causes it to go past the nearest bend. For edges that are same directions, the concern is
        // that the jitter causes it to go past the second nearest bend
        let signFlip = false;
        // Map of the original edge to its closest two segments
        const newSegments = new Map();

        // Note that the edge itself is included in this search when it's opposite direction, as it needs to be checked for new
        // intersections as well
        for (const otherEdge of node.edges) {
          let isOtherEdgeVertical;
          const op = otherEdge.points;
          if (otherEdge.from === node) isOtherEdgeVertical = op[0].x === op[1].x;
          else isOtherEdgeVertical = op[op.length - 1].x === op[op.length - 2].x;

          // This can happen if they are really close to each other. Diagonal points should be free to move around for the
          // purpose of dejitter
          const isOtherEdgeDiagonal = (op.length === 2) && (op[0].x !== op[1].x) && (op[0].y !== op[1].y);
          // The distance will be so small we don't have to worry about new intersections, and sign flips can't happen
          if (isOtherEdgeDiagonal) continue;

          // Moving horizontally and edge vertical (move both x distance)
          if (isVerticalLine && isOtherEdgeVertical) {
            let second;
            let third;
            if (otherEdge.from === node) {
              second = 1;
              third = 2;
              newSegments.set(otherEdge, [
                geo.newPoint(op[0].x + delta, op[0].y),
                geo.newPoint(op[1].x + delta, op[1].y),
              ]);
            } else {
              second = op.length - 2;
              third = op.length - 3;
              newSegments.set(otherEdge, [
                geo.newPoint(op[op.length - 1].x + delta, op[op.length - 1].y),
                geo.newPoint(op[op.length - 2].x + delta, op[op.length - 2].y),
              ]);
            }
            if (otherEdge !== edge) {
              if (((op[second].x + signFlipDelta < op[third].x) && (op[second].x > op[third].x)) ||
                  ((op[second].x + signFlipDelta > op[third].x) && (op[second].x < op[third].x))) {
                signFlip = true;
              }
            }
          }
          // Moving horizontally and edge horizontal (move closest x distance)
          if (isVerticalLine && !isOtherEdgeVertical) {
            let first;
            let second;
            if (otherEdge.from === node) {
              first = 0;
              second = 1;
              newSegments.set(otherEdge, [geo.newPoint(op[0].x + delta, op[0].y), op[1]]);
            } else {
              first = op.length - 1;
              second = op.length - 2;
              newSegments.set(otherEdge, [geo.newPoint(op[op.length - 1].x + delta, op[op.length - 1].y), op[op.length - 2]]);
            }
            if (((op[first].x + signFlipDelta < op[second].x) && (op[first].x > op[second].x)) ||
                ((op[first].x + signFlipDelta > op[second].x) && (op[first].x < op[second].x))) {
              signFlip = true;
            }
          }
          // Moving vertical and edge horizontal (move both y distance)
          if (!isVerticalLine && !isOtherEdgeVertical) {
            let second;
            let third;
            if (otherEdge.from === node) {
              second = 1;
              third = 2;
              newSegments.set(otherEdge, [
                geo.newPoint(op[0].x, op[0].y + delta),
                geo.newPoint(op[1].x, op[1].y + delta),
              ]);
            } else {
              second = op.length - 2;
              third = op.length - 3;
              newSegments.set(otherEdge, [
                geo.newPoint(op[op.length - 1].x, op[op.length - 1].y + delta),
                geo.newPoint(op[op.length - 2].x, op[op.length - 2].y + delta),
              ]);
            }
            if (otherEdge !== edge) {
              if (((op[second].y + signFlipDelta < op[third].y) && (op[second].y > op[third].y)) ||
                  ((op[second].y + signFlipDelta > op[third].y) && (op[second].y < op[third].y))) {
                signFlip = true;
              }
            }
          }
          // Moving vertical and edge vertical (move closest y distance)
          if (!isVerticalLine && isOtherEdgeVertical) {
            let first;
            let second;
            if (otherEdge.from === node) {
              first = 0;
              second = 1;
              newSegments.set(otherEdge, [geo.newPoint(op[0].x, op[0].y + delta), op[1]]);
            } else {
              first = op.length - 1;
              second = op.length - 2;
              newSegments.set(otherEdge, [geo.newPoint(op[op.length - 1].x, op[op.length - 1].y + delta), op[op.length - 2]]);
            }
            if (((op[first].y + signFlipDelta < op[second].y) && (op[first].y > op[second].y)) ||
                ((op[first].y + signFlipDelta > op[second].y) && (op[first].y < op[second].y))) {
              signFlip = true;
            }
          }

          if (signFlip) break;
        }

        if (signFlip) continue;

        let intersects = false;
        for (const [segmentEdge, newSegment] of newSegments) {
          // Check for intersections on other nodes
          for (const otherNode of g.nodes) {
            if (otherNode === node) continue;
            // Can intersect with a container if one endpoint is inside it
            if (segmentEdge.from.isDescendantOf(otherNode)) continue;
            if (segmentEdge.to.isDescendantOf(otherNode)) continue;
            // It can touch the node it's connected to
            if (((otherNode !== segmentEdge.to) && (otherNode !== segmentEdge.from)) && otherNode.passesThrough(newSegment[0], newSegment[1])) {
              intersects = true;
              break;
            }
          }
          if (intersects) break;
        }
        if (intersects) continue;

        // ---- from here on we know there is no object intersection introduced by updating all the edges to avoid the jitter, so
        // we can safely shift to dejitter

        let numEdgesPassedThrough = 0;
        for (const otherEdge of g.edges) {
          if (otherEdge.from === node || otherEdge.to === node) continue;

          for (let i = 0; i < otherEdge.points.length - 1; i++) {
            if (node.passesThrough(otherEdge.points[i], otherEdge.points[i + 1])) numEdgesPassedThrough++;
          }
        }

        if (rollback === null) {
          const state = lg.newGraphStateSnapshot({ captureEdgeRoutes: true });
          state.updateWithWorkGuard(g, guard);
          rollback = new lg.Transaction();
          rollback.graph = g;
          rollback.priorGraphState = state;
        }

        txn.addOp(() => {
          // Tentatively commit the node
          if (isVerticalLine) node.topLeft.x += delta;
          else node.topLeft.y += delta;

          let newNumEdgesPassedThrough = 0;
          for (const otherEdge of g.edges) {
            if (otherEdge.from === node || otherEdge.to === node) continue;

            for (let i = 0; i < otherEdge.points.length - 1; i++) {
              if (node.passesThrough(otherEdge.points[i], otherEdge.points[i + 1])) newNumEdgesPassedThrough++;
            }
          }

          const currSymmetry = placementcost.nodeSymmetry(ctx, node, null);
          if (newNumEdgesPassedThrough > numEdgesPassedThrough) throw lg.ErrNonImprovingCandidate;
          else if (node.container !== null && node.spillsOutOf(node.container)) throw lg.ErrInvalidCandidate;
          else if (currSymmetry < prevSymmetry) throw lg.ErrNonImprovingCandidate;
          return null;
        });

        const cerr = commitErr(txn, ctx);
        if (cerr !== null) {
          txn.clear();
          if (lg.isCandidateRejection(cerr)) continue;
          throw cerr;
        }
        txn.updateState();
        txn.clear();

        // ---- from here on we know jittering this node does not introduce any more route intersections

        // Commit new segments
        for (const otherEdge of node.edges) {
          let isOtherEdgeVertical;
          const op = otherEdge.points;
          if (otherEdge.from === node) isOtherEdgeVertical = op[0].x === op[1].x;
          else isOtherEdgeVertical = op[op.length - 1].x === op[op.length - 2].x;

          const isOtherEdgeDiagonal = (op.length === 2) && (op[0].x !== op[1].x) && (op[0].y !== op[1].y);
          // If it's diagonal, we just need to update the one point on the node that's moved
          if (isOtherEdgeDiagonal) {
            if (isVerticalLine) {
              if (otherEdge.from === node) op[0].x += delta;
              else op[op.length - 1].x += delta;
            } else if (otherEdge.from === node) {
              op[0].y += delta;
            } else {
              op[op.length - 1].y += delta;
            }
          } else {
            // Moving horizontally and edge vertical (move both x distance)
            if (isVerticalLine && isOtherEdgeVertical) {
              if (otherEdge.from === node) {
                op[0].x += delta;
                op[1].x += delta;
              } else {
                op[op.length - 1].x += delta;
                op[op.length - 2].x += delta;
              }
            }
            // Moving horizontally and edge horizontal (move closest x distance)
            if (isVerticalLine && !isOtherEdgeVertical) {
              if (otherEdge.from === node) op[0].x += delta;
              else op[op.length - 1].x += delta;
            }
            // Moving vertical and edge horizontal (move both y distance)
            if (!isVerticalLine && !isOtherEdgeVertical) {
              if (otherEdge.from === node) {
                op[0].y += delta;
                op[1].y += delta;
              } else {
                op[op.length - 1].y += delta;
                op[op.length - 2].y += delta;
              }
            }
            // Moving vertical and edge vertical (move closest y distance)
            if (!isVerticalLine && isOtherEdgeVertical) {
              if (otherEdge.from === node) op[0].y += delta;
              else op[op.length - 1].y += delta;
            }
          }
        }

        // Remove the two defunct points corresponding to the old bends
        if (edge.from === node) {
          // This should remove 1 and 2
          edge.points.splice(1, 2);
        } else {
          edge.points.splice(edge.points.length - 3, 2);
        }
        dejittered = true;
      }
    }
    if (dejittered) guard.finish();
    complete = true;
    return dejittered;
  } finally {
    if (rollback !== null && !complete) rollback.rollback();
  }
}
