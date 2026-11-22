// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of the Go package d2layouts/d2talalayout/internal/placement (D2 v0.9.0, github.com/d2lang/d2, Copyright 2022
// Terrastruct Inc.): gapreduction.go.

import * as geo from '../../geo.js';
import { compare as cmpCompare, sortFunc } from '../goslices.js';
import { errorf, errorsIs } from '../goerrors.js';
import * as lg from '../layoutgraph.js';
import * as placementcost from '../placementcost.js';
import {
  axisIsHorizontal, axisValid, commitErr, directionIsForward, directionOpposite, directionValid, largeGapThreshold,
} from './types.js';

const pcOpts = { edgeAbductions: null, includeNodeSizes: true, enforceMinimumGap: false, penalizeDirection: false };

/** gapNormalizationOptions is {axis, direction, costTxn}; gapReductionOptions adds attemptRecoverSymmetry. */
export function gapNormalization(ctx, nodes, txn, g, options) {
  if (!axisValid(options.axis)) throw errorf('TALA GapNormalization requires an axis');
  if (!directionValid(options.direction)) throw errorf('TALA GapNormalization requires a direction');
  ctx = lg.ensureTransactionWorkGuard(ctx, 'GapNormalizationTransactions')[0];
  // We gap reduce by order of most connected nodes to least connected. This should achieve the effect of bringing nodes into
  // central areas of the diagram instead of isolated nodes dragging stuff to it
  const sortedByConnections = nodes.slice();
  sortFunc(sortedByConnections, (a, b) => {
    const order = cmpCompare(b.edges.length, a.edges.length);
    if (order !== 0) return order;
    return cmpCompare(a.id, b.id);
  });

  let changed = false;

  // whole trees can move towards other nodes but we don't want to move within trees
  for (const node of sortedByConnections) {
    if (g.nodeToTree !== null && g.nodeToTree.has(node)) continue;
    if (node.hierarchy !== null) continue;
    const candidateTxn = txn.cloneGeometryContext();
    txn.addOp(() => {
      reduceGapToNeighbors(ctx, node, candidateTxn, {
        axis: options.axis,
        direction: options.direction,
        attemptRecoverSymmetry: true,
        costTxn: options.costTxn,
      });
      return null;
    });
    const err = commitErr(txn, ctx);
    if (err !== null) {
      if (!lg.isCandidateRejection(err)) throw err;
    } else {
      txn.updateState();
      changed = true;
    }
    txn.clear();
  }

  return changed;
}

/** Assumes ahead is ahead of behind when forwards is true */
export function isBetween(node, behind, ahead, isHorizontal, forwards) {
  const delta = behind.deltaTo(node, behind.topLeft);
  if (isHorizontal) {
    if ((node.topLeft.y + node.height) < behind.topLeft.y - delta) return false;
    if (node.topLeft.y > behind.topLeft.y + behind.height + delta) return false;

    if (!forwards) [behind, ahead] = [ahead, behind];
    // n is behind behind
    if (node.topLeft.x + node.width < behind.topLeft.x + behind.width) return false;
    // n is ahead of ahead
    if (node.topLeft.x > ahead.topLeft.x) return false;
  } else {
    if ((node.topLeft.x + node.width) < behind.topLeft.x - delta) return false;
    if (node.topLeft.x > behind.topLeft.x + behind.width + delta) return false;

    if (!forwards) [behind, ahead] = [ahead, behind];
    if (node.topLeft.y + node.height < behind.topLeft.y + behind.height) return false;
    if (node.topLeft.y > ahead.topLeft.y) return false;
  }
  return true;
}

/** Assumes otherNode is ahead of node when forwards is true */
export function nearestBetween(nodes, behind, ahead, inContainer, isHorizontal, forwards) {
  let nearest = null;
  for (const n of nodes) {
    if (n === behind || n === ahead) continue;
    if (n.owningContainer() !== inContainer) continue;
    if (!isBetween(n, behind, ahead, isHorizontal, forwards)) continue;
    if (nearest === null) {
      nearest = n;
      continue;
    }
    if (isHorizontal) {
      if (forwards) {
        if (n.topLeft.x < nearest.topLeft.x) nearest = n;
      } else if ((n.topLeft.x + n.width) > (nearest.topLeft.x + nearest.width)) {
        nearest = n;
      }
    } else if (forwards) {
      if (n.topLeft.y < nearest.topLeft.y) nearest = n;
    } else if ((n.topLeft.y + n.height) > (nearest.topLeft.y + nearest.height)) {
      nearest = n;
    }
  }

  return nearest;
}

export function nearestConnectedAhead(node, isHorizontal, forwards) {
  let nearest = null;

  for (const e of node.edges) {
    const adj = node.adjacent(e);
    if (isHorizontal) {
      if (forwards) {
        // if adj's left is behind node's right its not ahead
        if (adj.topLeft.x < (node.topLeft.x + node.width)) continue;
        if (nearest === null || adj.topLeft.x < nearest.topLeft.x) nearest = adj;
      } else {
        // if adj's right is ahead of node's left its not behind
        if ((adj.topLeft.x + adj.width) > node.topLeft.x) continue;
        if (nearest === null || (adj.topLeft.x + adj.width > nearest.topLeft.x + nearest.width)) nearest = adj;
      }
    } else if (forwards) {
      if (adj.topLeft.y < (node.topLeft.y + node.height)) continue;
      if (nearest === null || adj.topLeft.y < nearest.topLeft.y) nearest = adj;
    } else {
      if (adj.topLeft.y + adj.height > node.topLeft.y) continue;
      if (nearest === null || (adj.topLeft.y + adj.height) > (nearest.topLeft.y + nearest.height)) nearest = adj;
    }
  }

  return nearest;
}

/**
 * reduceGapToNeighbors attempts to reduce the gap between this node and its neighbors in front of it. Returns
 * [reduced, newEdgeLength]: true if reduced, false if no changes. If true, also the reduced global edge length.
 * `txn` may be null (the function then creates its own transaction). `options` is {axis, direction, attemptRecoverSymmetry, costTxn}.
 */
export function reduceGapToNeighbors(ctx, node, txn, options) {
  const cerr = ctx.err();
  if (cerr) throw cerr;
  if (!axisValid(options.axis)) throw errorf('TALA gap reduction requires an axis');
  if (!directionValid(options.direction)) throw errorf('TALA gap reduction requires a direction');
  const isHorizontal = axisIsHorizontal(options.axis);
  const forwards = directionIsForward(options.direction);
  const attemptRecoverSymmetry = !!options.attemptRecoverSymmetry;
  const costTxn = options.costTxn ?? null;
  // Needed for calculating partial symmetry
  if (node.graph.cellSize === 0) node.graph.computeCellSize();

  let nearestAhead = nearestConnectedAhead(node, isHorizontal, forwards);
  if (nearestAhead === null) return [false, 0];
  // if nearest ahead is fixed or is within a fixed node, we can't pull it closer
  for (let c = nearestAhead.container; c !== null; c = c.container) {
    if (c.fixedTopLeft !== null) return [false, 0];
  }
  let excluded = [node];
  if (node.herdAssignment !== null) {
    // when normalizing the gap from `4` to `1`, it selects `c1`, `2`, `3`, `5`, `6` as connected nodes, however, `5` and `6`
    // shouldn't be considered because when moving the connected nodes towards `4` it will break the herd alignment
    for (const sibling of node.graph.containers.get(node.container) ?? []) {
      if (sibling === node || sibling.herdAssignment === null || nearestAhead.isDescendantOf(sibling)) continue;
      if (sibling.herdAssignment.orientation === node.herdAssignment.orientation) excluded.push(sibling);
    }
  }

  const sharedContainer = node.nearestSharedAncestor(nearestAhead);
  const nearestBetweenNode = nearestBetween(nearestAhead.connectedNodes(excluded, node.graph), node, nearestAhead, sharedContainer, isHorizontal, forwards);

  // we don't want fixed nodes preventing us from getting the actual nearest between (could be a fixed node's container) but we
  // only want to move connected nodes up until we reach a fixed node
  excluded = excluded.concat(node.graph.fixedNodes());
  const connectedNodes = nearestAhead.connectedNodeSet(excluded, node.graph);

  if (nearestBetweenNode !== null) nearestAhead = nearestBetweenNode;

  if (costTxn !== null) costTxn.capturePlacementCosts('GapNormalizationTransactions');
  const oldEdgeLength = placementcost.edgeLength(ctx, node.graph, pcOpts);
  let newEdgeLength = oldEdgeLength;

  const nodesInBetween = [];
  for (const n of node.graph.nodes) {
    if (n === node || n === nearestAhead) continue;
    const isAConnectedNode = connectedNodes.includes(n);
    if (isAConnectedNode) continue;
    if (forwards) {
      if (n.isBlocked(node, nearestAhead, true, isHorizontal)) nodesInBetween.push(n);
    } else if (n.isBlocked(nearestAhead, node, true, isHorizontal)) {
      nodesInBetween.push(n);
    }
  }

  let backwardTxn = null;
  // We try pulling the nearest ahead to any nodes in between
  for (let candidateNode of [node].concat(nodesInBetween)) {
    // if nearest ahead is less nested, we only want move it to the candidate's ancestor in the same container.
    // Note: we should always reach nearestAhead's Container, since it should be the outermost connected node
    while (candidateNode.owningContainer() !== nearestAhead.owningContainer()) {
      candidateNode = candidateNode.owningContainer();
      if (candidateNode === null) break;
    }
    if (candidateNode === null) continue;
    let gapSize;
    if (isHorizontal) {
      if (forwards) gapSize = nearestAhead.topLeft.x - (candidateNode.topLeft.x + candidateNode.width);
      else gapSize = candidateNode.topLeft.x - (nearestAhead.topLeft.x + nearestAhead.width);
    } else if (forwards) {
      gapSize = nearestAhead.topLeft.y - (candidateNode.topLeft.y + candidateNode.height);
    } else {
      gapSize = candidateNode.topLeft.y - (nearestAhead.topLeft.y + nearestAhead.height);
    }

    if (gapSize <= largeGapThreshold * node.graph.cellSize) continue;

    // TODO 150 seems a bit large for ideal gap size
    let delta = placementcost.IdealGapSize - gapSize;
    if (!forwards) delta = -delta;
    if (delta === 0) continue;

    let candidateEdgeLength = 0;
    if (txn === null) {
      txn = node.graph.newRequestTransaction(ctx, { affectContainers: true });
    } else {
      txn.clear();
      txn.updateState();
    }
    const deltaNow = delta;
    txn.addOp(() => {
      for (const n of connectedNodes) {
        if (isHorizontal) n.translate(deltaNow, 0);
        else n.translate(0, deltaNow);
      }
      node.graph.syncClusters();
      node.graph.syncSequences();
      candidateEdgeLength = placementcost.edgeLength(ctx, node.graph, pcOpts);

      // Before we commit to anything, we try to "recover symmetry" by running gap reduction on the opposite side. E.g. if
      // running on b, c might be brought closer and lose symmetry. But bringing a closer recovers that symmetry. There are 3
      // scenarios: 1. The gap reduction without backwards run is best; 2. The gap reduction plus backwards run is best; 3. No
      // gap reduction is best. There is a fourth, which is that gap reduction backwards is best, but that's checked in outer
      if (attemptRecoverSymmetry) {
        if (backwardTxn === null) backwardTxn = txn.cloneGeometryContext();
        backwardTxn.clear();
        backwardTxn.updateState();
        const mirroredTxn = backwardTxn.cloneGeometryContext();
        backwardTxn.addOp(() => {
          const [moved, mirroredEdgeLength] = reduceGapToNeighbors(ctx, node, mirroredTxn, {
            axis: options.axis,
            direction: directionOpposite(options.direction),
            costTxn: options.costTxn,
          });

          if (moved && (mirroredEdgeLength < candidateEdgeLength && mirroredEdgeLength < oldEdgeLength)) return null;
          throw lg.ErrNonImprovingCandidate;
        });
        const berr = commitErr(backwardTxn, ctx);
        if (berr !== null) {
          if (!lg.isCandidateRejection(berr)) throw berr;
        } else {
          // If the backward commit was successful, it means it was optimal
          return null;
        }
      }

      if (candidateEdgeLength >= oldEdgeLength) throw lg.ErrNonImprovingCandidate;

      return null;
    });
    const err = commitErr(txn, ctx);
    if (err !== null) {
      txn.clear();
      // Continue searching after an invalid candidate. A non-improving candidate cannot get better by searching farther forward.
      if (errorsIs(err, lg.ErrNonImprovingCandidate)) break;
      if (!errorsIs(err, lg.ErrInvalidCandidate)) throw err;
    } else {
      newEdgeLength = candidateEdgeLength;
      txn.clear();
      txn.updateState();
      break;
    }
  }

  // try moving non-fixed node to the side of its container

  if (node.container !== null && node.container !== nearestAhead.container && node.fixedTopLeft === null) {
    while (node.owningContainer() !== nearestAhead.owningContainer()) {
      const innerBox = node.container.innerBox();

      let gapSize;
      if (isHorizontal) {
        if (forwards) gapSize = innerBox.TopLeft.x + innerBox.Width - (node.topLeft.x + node.width);
        else gapSize = node.topLeft.x - innerBox.TopLeft.x;
      } else if (forwards) {
        gapSize = innerBox.TopLeft.y + innerBox.Height - (node.topLeft.y + node.height);
      } else {
        gapSize = node.topLeft.y - innerBox.TopLeft.y;
      }

      const padding = node.graph.containerPadding(node.container, true);
      let delta = gapSize;
      if (isHorizontal) {
        if (forwards) delta -= padding.right;
        else delta -= padding.left;
      } else if (forwards) {
        delta -= padding.bottom;
      } else {
        delta -= padding.top;
      }
      if (!forwards) delta = -delta;
      if (gapSize > largeGapThreshold * node.graph.cellSize && delta !== 0) {
        if (txn === null) {
          txn = node.graph.newRequestTransaction(ctx, { affectContainers: true });
        } else {
          txn.clear();
          txn.updateState();
        }
        const moveDelta = delta;
        txn.addOp(() => {
          if (isHorizontal) node.moveWithChildren(moveDelta, 0);
          else node.moveWithChildren(0, moveDelta);
          return null;
        });
        let rolledBack = false;
        const err = commitErr(txn, ctx);
        if (err !== null) {
          if (!lg.isCandidateRejection(err)) throw err;
          rolledBack = true;
        } else {
          let movedEdgeLength;
          try {
            movedEdgeLength = placementcost.edgeLength(ctx, node.graph, pcOpts);
          } catch (e) {
            txn.rollback();
            throw e;
          }

          if (geo.precisionCompare(movedEdgeLength, newEdgeLength, geo.PRECISION) >= 0) {
            txn.rollback();
            rolledBack = true;
          } else {
            newEdgeLength = movedEdgeLength;
          }
        }
        if (rolledBack) {
          txn.clear();
          // Alright so if moving to the side of the container obstructs something, you can move PADDING away from the next
          // thing in that axis. E.g. can't move A all the way to the side, but can move close to B whereby it's still
          // reducing distance
          let leastDistance = Infinity;
          for (const otherNode of node.graph.containers.get(node.owningContainer()) ?? []) {
            if (node === otherNode) continue;
            if (isHorizontal) {
              if (forwards) {
                const x = otherNode.topLeft.x - placementcost.IdealGapSize;
                if (x > node.topLeft.x + node.width) {
                  if (x - (node.topLeft.x + node.width) < leastDistance) leastDistance = x - (node.topLeft.x + node.width);
                }
              } else {
                const x = otherNode.topLeft.x + otherNode.width + placementcost.IdealGapSize;
                if (x < node.topLeft.x) {
                  if (node.topLeft.x - x < leastDistance) leastDistance = node.topLeft.x - x;
                }
              }
            } else if (forwards) {
              const y = otherNode.topLeft.y - placementcost.IdealGapSize;
              if (y > node.topLeft.y + node.height) {
                if (y - (node.topLeft.y + node.height) < leastDistance) leastDistance = y - (node.topLeft.y + node.height);
              }
            } else {
              const y = otherNode.topLeft.y + otherNode.height + placementcost.IdealGapSize;
              if (y < node.topLeft.y) {
                if (node.topLeft.y - y < leastDistance) leastDistance = node.topLeft.y - y;
              }
            }
          }
          if (leastDistance !== Infinity) {
            delta = leastDistance;
            if (!forwards) delta = -delta;
            const leastDelta = delta;
            txn.addOp(() => {
              if (isHorizontal) node.moveWithChildren(leastDelta, 0);
              else node.moveWithChildren(0, leastDelta);
              return null;
            });
            const err2 = commitErr(txn, ctx);
            if (err2 !== null) {
              if (!lg.isCandidateRejection(err2)) throw err2;
            } else {
              let movedEdgeLength;
              try {
                movedEdgeLength = placementcost.edgeLength(ctx, node.graph, pcOpts);
              } catch (e) {
                txn.rollback();
                throw e;
              }
              if (geo.precisionCompare(movedEdgeLength, newEdgeLength, geo.PRECISION) >= 0) {
                txn.rollback();
              } else {
                newEdgeLength = movedEdgeLength;
                txn.clear();
                txn.updateState();
              }
            }
          }
        }
      }
      node = node.owningContainer();
      if (node.container === null) break;
    }
  }
  return [newEdgeLength !== oldEdgeLength, newEdgeLength];
}
