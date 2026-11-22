// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of the Go package d2layouts/d2talalayout/internal/placement (D2 v0.9.0, github.com/d2lang/d2, Copyright 2022
// Terrastruct Inc.): compaction.go.

import * as geo from '../../geo.js';
import { goRound } from '../../gomath.js';
import { sortSlice } from '../../gosort.js';
import { errorf } from '../goerrors.js';
import * as invariant from '../invariant.js';
import * as lg from '../layoutgraph.js';
import * as limits from '../limits.js';
import * as placementcost from '../placementcost.js';
import {
  axisIsHorizontal, axisValid, maxCompactionCandidateCount, moveNodeToBest, nonNilEquals, restoreNodePositions,
  roundToPreviousCellSize, snapshotNodePositionsContext,
} from './types.js';

/**
 * compaction serves two functions: 1. Inflate nodes to create room for more optimal node placements (escaping local maximums);
 * 2. Reduce distance between nodes too far apart. We use compaction to inflate when transitioning from sizeless phase to sized
 * phase, which the transition flag is for.
 *
 * `options` is {edgeAbductions (null for a nil slice), axis, includeSizes, factor, transition, moveWorkLimit}.
 */
export function compaction(ctx, g, options) {
  if (!axisValid(options.axis)) throw errorf('TALA Compaction requires an axis');
  if (!(options.factor > 0) || Number.isNaN(options.factor) || !Number.isFinite(options.factor)) {
    throw errorf('TALA Compaction requires a finite positive factor');
  }
  const edgeAbductions = options.edgeAbductions ?? null;
  const isHorizontal = axisIsHorizontal(options.axis);
  const includeSizes = !!options.includeSizes;
  const factor = options.factor;
  const transition = !!options.transition;
  lg.validate(ctx, 'Compaction', g);
  const originalCosts = g.routingCosts();
  const originalPositions = snapshotNodePositionsContext(ctx, 'Compaction', g.nodes);
  let complete = false;
  try {
    const vEdges = visibilityEdges(ctx, g, isHorizontal, includeSizes);

    inflateAlongAxis(g, isHorizontal, includeSizes, factor, vEdges, transition);
    let err = ctx.err();
    if (err) throw errorf(`Compaction: ${err.message}`, err);

    // We're returning early during transition because the below calls assume no overlap. And during transition, there can be
    // temporary overlaps along a dimension. The main point of the transition is just to inflate anyway, there shouldn't be any
    // compacting needed because they inflate to the minimum possible value
    if (transition) {
      complete = true;
      return;
    }

    for (let i = 0; i < 20; i++) {
      const changed = shiftSubgraphs(ctx, g, isHorizontal, includeSizes, factor, edgeAbductions, vEdges);
      if (!changed) break;
    }
    let moveWorkLimit = options.moveWorkLimit ?? 0;
    if (moveWorkLimit === 0 || moveWorkLimit > limits.MaxOptimizationWorkUnits) moveWorkLimit = limits.MaxOptimizationWorkUnits;
    const movesGuard = limits.newOptimizationWorkGuard(ctx, 'CompactionMoves', moveWorkLimit);

    for (let i = 0; i < 20; i++) {
      const changed = compactAlongAxis(ctx, g, isHorizontal, includeSizes, factor, edgeAbductions, vEdges, movesGuard);
      if (!changed) break;
    }
    err = ctx.err();
    if (err) throw errorf(`Compaction: ${err.message}`, err);
    complete = true;
  } finally {
    if (!complete) {
      restoreNodePositions(originalPositions);
      g.restoreRoutingCosts(originalCosts);
    }
  }
}

export function orderedAlongAxis(g, isHorizontal) {
  const orderedNodes = g.nodes.slice();

  sortSlice(orderedNodes, (i, j) => {
    if (isHorizontal) {
      if (orderedNodes[i].topLeft.x === orderedNodes[j].topLeft.x) return orderedNodes[i].id < orderedNodes[j].id;
      return orderedNodes[i].topLeft.x < orderedNodes[j].topLeft.x;
    }
    if (orderedNodes[i].topLeft.y === orderedNodes[j].topLeft.y) return orderedNodes[i].id < orderedNodes[j].id;
    return orderedNodes[i].topLeft.y < orderedNodes[j].topLeft.y;
  });
  return orderedNodes;
}

/**
 * shiftSubgraphs tries to move entire subgraphs of the visibility graph, for a more global attempt to close gaps. The primary
 * purpose is to escape local maximas, where no individual nodes would move closer to each other.
 */
export function shiftSubgraphs(ctx, g, isHorizontal, includeSizes, factor, edgeAbductions, vEdges) {
  let changed = false;
  const subgraphSet = new Map();
  let orderedSubgraphRoots = [];

  const orderedNodes = orderedAlongAxis(g, isHorizontal);

  for (const node of orderedNodes) {
    const nearestFromNode = nearestFrom(vEdges, node, isHorizontal, includeSizes);
    if (nearestFromNode === null) {
      subgraphSet.set(node, [node]);
      orderedSubgraphRoots.push(node);
    } else {
      let list = subgraphSet.get(nearestFromNode);
      if (list === undefined) {
        list = [];
        subgraphSet.set(nearestFromNode, list);
      }
      list.push(node);
    }
  }

  const filtered = [];
  for (const root of orderedSubgraphRoots) {
    let sgHasFixedNode = false;
    for (const n of subgraphSet.get(root)) {
      if (n.fixedTopLeft !== null) {
        sgHasFixedNode = true;
        break;
      }
    }
    if (sgHasFixedNode) subgraphSet.delete(root);
    else filtered.push(root);
  }
  orderedSubgraphRoots = filtered;
  const fixedNodes = g.fixedNodes();

  sortSlice(orderedSubgraphRoots, (i, j) => {
    if (isHorizontal) {
      if (orderedSubgraphRoots[i].topLeft.x === orderedSubgraphRoots[j].topLeft.x) return orderedSubgraphRoots[i].id < orderedSubgraphRoots[j].id;
      return orderedSubgraphRoots[i].topLeft.x < orderedSubgraphRoots[j].topLeft.x;
    }
    if (orderedSubgraphRoots[i].topLeft.y === orderedSubgraphRoots[j].topLeft.y) return orderedSubgraphRoots[i].id < orderedSubgraphRoots[j].id;
    return orderedSubgraphRoots[i].topLeft.y < orderedSubgraphRoots[j].topLeft.y;
  });

  const furthestBehindGlobal = globallyFurthestBehind(g, isHorizontal);
  for (const furthestBehind of orderedSubgraphRoots) {
    const subgraph = subgraphSet.get(furthestBehind);
    let possibleMoves;
    if (isHorizontal) {
      if (furthestBehind.topLeft.x === furthestBehindGlobal.topLeft.x) possibleMoves = candidateMoves(ctx, g, furthestBehind, factor, isHorizontal, includeSizes, 2, vEdges);
      else possibleMoves = candidateMoves(ctx, g, furthestBehind, factor, isHorizontal, includeSizes, 0, vEdges);
    } else if (furthestBehind.topLeft.y === furthestBehindGlobal.topLeft.y) {
      possibleMoves = candidateMoves(ctx, g, furthestBehind, factor, isHorizontal, includeSizes, 2, vEdges);
    } else {
      possibleMoves = candidateMoves(ctx, g, furthestBehind, factor, isHorizontal, includeSizes, 0, vEdges);
    }
    possibleMoves.push(furthestBehind.topLeft.copy());

    // shifting subgraphs shouldn't introduce any overlaps between subgraph nodes, but we still need to check for overlaps with
    // nodes not in this subgraph
    const nonSubgraphNodes = [];
    nonSubgraphNodes.push(...fixedNodes);
    for (const otherN of g.nodes) {
      const isIn = subgraph.includes(otherN);
      if (!isIn) nonSubgraphNodes.push(otherN);
    }

    let symmetryCost = 1.0;
    if (includeSizes) symmetryCost = g.cellSize;
    symmetryCost *= lg.Nodes.numAdjacent(subgraph);

    let bestEdgeDistance = placementcost.nodesEdgeLength(ctx, subgraph, { edgeAbductions, includeNodeSizes: includeSizes, enforceMinimumGap: false, penalizeDirection: true });
    let bestDelta = 0.0;

    const originalPositions = snapshotNodePositionsContext(ctx, 'Compaction', subgraph);
    for (const move of possibleMoves) {
      let delta;
      if (isHorizontal) delta = furthestBehind.topLeft.x - move.x;
      else delta = furthestBehind.topLeft.y - move.y;

      let overlaps = false;
      for (const n of subgraph) {
        const p = n.topLeft.copy();
        if (isHorizontal) p.x -= delta;
        else p.y -= delta;
        if (fixedNodes.length > 0) {
          if (n.pointPastFixedOrigin(p.x, p.y, includeSizes)) {
            overlaps = true;
            break;
          }
        }
        for (const otherN of nonSubgraphNodes) {
          if (includeSizes) {
            if (n.doesOverlapAt(otherN, p)) {
              overlaps = true;
              break;
            }
          } else if (nonNilEquals(otherN.topLeft, p)) {
            overlaps = true;
            break;
          }
        }
        if (overlaps) break;
      }
      if (overlaps) continue;

      for (const node of subgraph) {
        if (isHorizontal) node.moveWithChildren(-delta, 0);
        else node.moveWithChildren(0, -delta);
      }

      let edgeDistanceAfter;
      try {
        edgeDistanceAfter = placementcost.nodesEdgeLength(ctx, subgraph, { edgeAbductions, includeNodeSizes: includeSizes, enforceMinimumGap: false, penalizeDirection: true });
        if (includeSizes) {
          const symmetry = placementcost.nodesSymmetry(ctx, subgraph, edgeAbductions);
          edgeDistanceAfter -= symmetry * symmetryCost;
        }
      } catch (e) {
        restoreNodePositions(originalPositions);
        throw e;
      }

      restoreNodePositions(originalPositions);

      if (edgeDistanceAfter < bestEdgeDistance) {
        bestEdgeDistance = edgeDistanceAfter;
        bestDelta = delta;
      }
    }
    if (bestDelta !== 0) {
      changed = true;
      for (const node of subgraph) {
        if (isHorizontal) node.moveWithChildren(-bestDelta, 0);
        else node.moveWithChildren(0, -bestDelta);
      }
    }
  }
  return changed;
}

/** inflateAlongAxis makes sure that the appropriate amount of distance (based on factor) between connected (in vGraph) nodes */
export function inflateAlongAxis(g, isHorizontal, includeSizes, factor, vEdges, transition) {
  const orderedNodes = orderedAlongAxis(g, isHorizontal);
  const hasFixedNode = g.hasFixedNode();

  for (const node of orderedNodes) {
    const nearestFromNode = nearestFrom(vEdges, node, isHorizontal, includeSizes);
    if (nearestFromNode === null) {
      // TODO reconsider this
      if (hasFixedNode && transition && node.fixedTopLeft === null) {
        // during transition we want all nodes to move to a cellSize even if they don't have a nearestFrom
        if (isHorizontal) node.moveAbsWithChildren(roundToPreviousCellSize(node.topLeft.x, g.cellSize), node.topLeft.y);
        else node.moveAbsWithChildren(node.topLeft.x, roundToPreviousCellSize(node.topLeft.y, g.cellSize));
      }
      continue;
    }
    // we don't want to move fixed nodes but we transitioning from sizeless to sized is an exception
    if (node.fixedTopLeft !== null && !transition) continue;

    // Edge case: During transition, because there are temporary overlaps, we want to maintain those overlaps for visibility
    // edges in the subsequent iteration of compaction. If one is connected and another is not, then that overlap can be lost.
    // So we force it to be maintained.
    let delta;
    if (transition) delta = lg.ConnectedNodeGap;
    else delta = node.deltaTo(nearestFromNode, node.topLeft);
    const floor = compactionFloor(g, nearestFromNode, factor, isHorizontal, includeSizes, delta);
    if (isHorizontal) {
      if (includeSizes) {
        if (floor * g.cellSize > node.topLeft.x) node.moveAbsWithChildren(floor * g.cellSize, node.topLeft.y);
      } else if (floor > node.topLeft.x) {
        node.moveAbsWithChildren(floor, node.topLeft.y);
      }
    } else if (includeSizes) {
      if (floor * g.cellSize > node.topLeft.y) node.moveAbsWithChildren(node.topLeft.x, floor * g.cellSize);
    } else if (floor > node.topLeft.y) {
      node.moveAbsWithChildren(node.topLeft.x, floor);
    }
  }
}

/**
 * Each node moves as far back as possible while making progress towards an adjacent node (this is a visibility edge). E.g. if
 * it's moving away from all nodes, then it shouldn't keep moving back, even if there's a gap between it and the nearest behind.
 */
export function compactAlongAxis(ctx, g, isHorizontal, includeSizes, factor, edgeAbductions, vEdges, guard) {
  let changed = false;

  const orderedNodes = orderedAlongAxis(g, isHorizontal);

  for (const node of orderedNodes) {
    if (node.fixedTopLeft !== null) continue;
    const possibleMoves = candidateMoves(ctx, g, node, factor, isHorizontal, includeSizes, 0, vEdges);
    possibleMoves.push(node.topLeft.copy());

    const moved = moveNodeToBest(ctx, g, node, possibleMoves, edgeAbductions, includeSizes, guard);
    if (moved) changed = true;
  }

  return changed;
}

export function visibilityEdges(ctx, g, isHorizontal, includeSizes) {
  const guard = limits.newWorkGuard(ctx, 'CompactionVisibility', limits.MaxEngineWorkUnits);
  const edges = [];
  for (const node of g.nodes) {
    guard.step();
    for (const otherNode of g.nodes) {
      guard.step();
      if (node.id === otherNode.id) continue;

      const delta = node.deltaTo(otherNode, node.topLeft);
      if (!node.visibilityGraphCandidate(isHorizontal, true, includeSizes, otherNode, delta)) continue;

      const blocked = isVisibilityGraphEdgeBlocked(g, isHorizontal, includeSizes, node, otherNode, guard);
      if (!blocked) edges.push(lg.newEdge(node, otherNode));
    }
  }

  guard.finish();
  return edges;
}

export function isVisibilityGraphEdgeBlocked(g, isHorizontal, includeSizes, nodeA, nodeB, guard) {
  for (const node of g.nodes) {
    guard.step();
    if (node.id === nodeA.id || node.id === nodeB.id) continue;

    if (node.isBlocked(nodeA, nodeB, includeSizes, isHorizontal)) return true;
  }

  return false;
}

export function nearestFrom(edges, node, isHorizontal, includeSizes) {
  let nearestBehind = null;

  let largestBehindDistance = -Infinity;

  for (const edge of edges) {
    if (edge.to === node) {
      if (isHorizontal) {
        if (includeSizes) {
          if (edge.from.topLeft.x + edge.from.width > largestBehindDistance) {
            largestBehindDistance = edge.from.topLeft.x + edge.from.width;
            nearestBehind = edge.from;
          }
        } else if (edge.from.topLeft.x > largestBehindDistance) {
          largestBehindDistance = edge.from.topLeft.x;
          nearestBehind = edge.from;
        }
      } else if (includeSizes) {
        if (edge.from.topLeft.y + edge.from.height > largestBehindDistance) {
          largestBehindDistance = edge.from.topLeft.y + edge.from.height;
          nearestBehind = edge.from;
        }
      } else if (edge.from.topLeft.y > largestBehindDistance) {
        largestBehindDistance = edge.from.topLeft.y;
        nearestBehind = edge.from;
      }
    }
  }

  return nearestBehind;
}

/**
 * compactionFloor returns the floor value along an axis that a node must satisfy, given the anchor. If include sizes, it returns
 * it as a number of cell size.
 */
export function compactionFloor(g, anchor, factor, isHorizontal, includeSizes, padding) {
  let floor;

  if (isHorizontal) {
    if (includeSizes) floor = Math.ceil((anchor.topLeft.x + (factor * anchor.width)) / g.cellSize);
    else floor = anchor.topLeft.x + Math.floor(factor);
  } else if (includeSizes) {
    floor = Math.ceil((anchor.topLeft.y + (factor * anchor.height)) / g.cellSize);
  } else {
    floor = anchor.topLeft.y + Math.floor(factor);
  }

  if (includeSizes) {
    let anchorVal;
    if (isHorizontal) anchorVal = anchor.topLeft.x + anchor.width;
    else anchorVal = anchor.topLeft.y + anchor.height;
    while ((floor * g.cellSize - anchorVal) <= padding) floor += 1;
  }

  return floor;
}

export function globallyFurthestBehind(g, isHorizontal) {
  let furthest = g.nodes[0];
  for (const n of g.nodes) {
    if (isHorizontal) {
      if (n.topLeft.x < furthest.topLeft.x) furthest = n;
    } else if (n.topLeft.y < furthest.topLeft.y) {
      furthest = n;
    }
  }
  return furthest;
}

/**
 * candidateMoves returns the points a node may move to while compacting toward the nearest node behind it. floorDecrease is
 * only safe to add when called with the node being the globally most behind.
 */
export function candidateMoves(ctx, g, node, factor, isHorizontal, includeSizes, floorDecrease, vEdges) {
  const guard = limits.newWorkGuard(ctx, 'CompactionCandidates', limits.MaxEngineWorkUnits);
  let nearestBehind = nearestFrom(vEdges, node, isHorizontal, includeSizes);

  // Node is at the start of visibility graph chain
  if (nearestBehind === null) nearestBehind = globallyFurthestBehind(g, isHorizontal);

  let floor = compactionFloor(g, nearestBehind, factor, isHorizontal, includeSizes, node.deltaTo(nearestBehind, node.topLeft));

  const hasFixed = g.hasFixedNode();

  if (isHorizontal) {
    // If it's same node or a node on another axis, no need add size buffer
    let nearestBehindAnotherAxis;
    if (includeSizes) {
      nearestBehindAnotherAxis = (nearestBehind.topLeft.y > node.topLeft.y + node.height) ||
        (nearestBehind.topLeft.y + nearestBehind.height < node.topLeft.y);
    } else {
      nearestBehindAnotherAxis = nearestBehind.topLeft.y !== node.topLeft.y;
    }
    if (nearestBehind.topLeft.x === node.topLeft.x || nearestBehindAnotherAxis) {
      if (includeSizes) {
        floor = nearestBehind.topLeft.x / g.cellSize;
        // with fixed positions floor may not be exactly on a cellSize
        if (hasFixed) floor = goRound(floor);
      } else {
        floor = nearestBehind.topLeft.x;
      }
    }
  } else {
    let nearestBehindAnotherAxis;
    if (includeSizes) {
      nearestBehindAnotherAxis = (nearestBehind.topLeft.x > node.topLeft.x + node.width) ||
        (nearestBehind.topLeft.x + nearestBehind.width < node.topLeft.x);
    } else {
      nearestBehindAnotherAxis = nearestBehind.topLeft.x !== node.topLeft.x;
    }
    if (nearestBehind.topLeft.y === node.topLeft.y || nearestBehindAnotherAxis) {
      if (includeSizes) {
        floor = nearestBehind.topLeft.y / g.cellSize;
        // with fixed positions floor may not be exactly on a cellSize
        if (hasFixed) floor = goRound(floor);
      } else {
        floor = nearestBehind.topLeft.y;
      }
    }
  }

  // Every node needs to include at least itself
  let ceil;
  if (isHorizontal) {
    if (includeSizes) ceil = node.topLeft.x / g.cellSize;
    else ceil = node.topLeft.x;
  } else if (includeSizes) {
    ceil = node.topLeft.y / g.cellSize;
  } else {
    ceil = node.topLeft.y;
  }
  const start = floor - floorDecrease;
  if (Number.isNaN(start) || !Number.isFinite(start) || Number.isNaN(ceil) || !Number.isFinite(ceil)) {
    throw invariant.newError('compaction candidate range is not finite');
  }
  if (start <= ceil) {
    const count = Math.floor(ceil - start) + 1;
    if (count > maxCompactionCandidateCount) {
      throw errorf(`TALA compaction candidate count ${count.toFixed(0)} exceeds limit ${maxCompactionCandidateCount}`);
    }
  }
  const positions = [];
  for (let i = start; i <= ceil; i++) {
    guard.step();
    let p;
    if (isHorizontal) {
      if (includeSizes) p = new geo.Point(i * g.cellSize, node.topLeft.y);
      else p = new geo.Point(i, node.topLeft.y);
    } else if (includeSizes) {
      p = new geo.Point(node.topLeft.x, i * g.cellSize);
    } else {
      p = new geo.Point(node.topLeft.x, i);
    }

    positions.push(p);
  }
  guard.finish();
  return positions;
}
