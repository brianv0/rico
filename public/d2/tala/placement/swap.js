// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of the Go package d2layouts/d2talalayout/internal/placement (D2 v0.9.0, github.com/d2lang/d2, Copyright 2022
// Terrastruct Inc.): swap.go.

import * as geo from '../../geo.js';
import * as lg from '../layoutgraph.js';
import * as placementcost from '../placementcost.js';
import { commitErr, tryGo } from './types.js';

const { Orientation } = geo;

export function swapPositions(nodeA, nodeB) {
  const tmpX = nodeA.topLeft.x;
  const tmpY = nodeA.topLeft.y;

  nodeA.moveWithChildren(nodeB.topLeft.x - nodeA.topLeft.x, nodeB.topLeft.y - nodeA.topLeft.y);

  nodeB.moveWithChildren(tmpX - nodeB.topLeft.x, tmpY - nodeB.topLeft.y);
}

export function smartSwapPositions(nodeA, nodeB) {
  const tmpX = nodeA.topLeft.x;
  const tmpY = nodeA.topLeft.y;

  const o = nodeA.orientation(nodeB);
  if (o === Orientation.Left) {
    nodeA.moveAbsWithChildren(nodeB.topLeft.x + nodeB.width - nodeA.width, nodeA.topLeft.y);
    nodeB.moveAbsWithChildren(tmpX, nodeB.topLeft.y);
  } else if (o === Orientation.Right) {
    nodeA.moveAbsWithChildren(nodeB.topLeft.x, nodeA.topLeft.y);
    nodeB.moveAbsWithChildren(tmpX + nodeA.width - nodeB.width, nodeB.topLeft.y);
  } else if (o === Orientation.Top) {
    nodeA.moveAbsWithChildren(nodeA.topLeft.x, nodeB.topLeft.y + nodeB.height - nodeA.height);
    nodeB.moveAbsWithChildren(nodeB.topLeft.x, tmpY);
  } else if (o === Orientation.Bottom) {
    nodeA.moveAbsWithChildren(nodeA.topLeft.x, nodeB.topLeft.y);
    nodeB.moveAbsWithChildren(nodeB.topLeft.x, tmpY + nodeA.height - nodeB.height);
  } else if (o === Orientation.TopLeft) {
    nodeA.moveAbsWithChildren(nodeB.topLeft.x + nodeB.width - nodeA.width, nodeB.topLeft.y + nodeB.height - nodeA.height);
    nodeB.moveAbsWithChildren(tmpX, tmpY);
  } else if (o === Orientation.TopRight) {
    nodeA.moveAbsWithChildren(nodeB.topLeft.x, nodeB.topLeft.y + nodeB.height - nodeA.height);
    nodeB.moveAbsWithChildren(tmpX + nodeA.width - nodeB.width, tmpY);
  } else if (o === Orientation.BottomLeft) {
    nodeA.moveAbsWithChildren(nodeB.topLeft.x + nodeB.width - nodeA.width, nodeB.topLeft.y);
    nodeB.moveAbsWithChildren(tmpX, tmpY + nodeA.height - nodeB.height);
  } else if (o === Orientation.BottomRight) {
    nodeA.moveAbsWithChildren(nodeB.topLeft.x, nodeB.topLeft.y);
    nodeB.moveAbsWithChildren(tmpX + nodeA.width - nodeB.width, tmpY + nodeA.height - nodeB.height);
  }
}

const pcOpts = { edgeAbductions: null, includeNodeSizes: true, enforceMinimumGap: false, penalizeDirection: true };

/** swapOptimize swaps node positions when doing so lowers placement cost. */
export function swapOptimize(ctx, nodes, g) {
  ctx = lg.ensureTransactionWorkGuard(ctx, 'SwapOptimizeTransactions')[0];
  const symmetryCost = g.cellSize;
  let swapMade = false;

  const measure = (n) => {
    let l = placementcost.nodeEdgeLength(ctx, n, pcOpts);
    const columnCrossingCost = placementcost.columnCrossingCost(ctx, n, null);
    const symmetry = placementcost.nodeSymmetry(ctx, n, null);
    l += columnCrossingCost;
    l -= symmetry * symmetryCost * n.edges.length;
    return l;
  };

  const txn = g.newRequestTransaction(ctx, { affectContainers: true });
  for (const node of nodes) {
    if (g.nodeToTree !== null && g.nodeToTree.has(node)) continue;
    if (node.hierarchy !== null) continue;
    if (node.fixedTopLeft !== null) continue;
    if (node.edges.length === 0 && !node.hasLeakyEdge()) continue;

    let bestSmartSwapped = false;
    let bestSwapCandidate = null;
    let bestSwapEdgeLength = Infinity;

    const currentGlobalL = placementcost.edgeLength(ctx, g, pcOpts);
    const currentL1 = measure(node);
    const currentCrossings = placementcost.graphEdgeCrossings(ctx, g);

    for (const swapCandidate of g.containers.get(node.container) ?? []) {
      if (swapCandidate === node) continue;
      if (g.nodeToTree !== null && g.nodeToTree.has(swapCandidate)) continue;
      if (swapCandidate.hierarchy !== null) continue;
      if (swapCandidate.fixedTopLeft !== null) continue;

      txn.addOp(() => {
        swapPositions(node, swapCandidate);
        return null;
      });

      let swappedL1 = 0;
      let swappedGlobalL = 0;
      let swappedCrossings = 0;
      let err = commitErr(txn, ctx);
      if (err === null) {
        try {
          swappedL1 = measure(node);
          swappedGlobalL = placementcost.edgeLength(ctx, g, pcOpts);
          swappedCrossings = placementcost.graphEdgeCrossings(ctx, g);
        } catch (e) {
          txn.rollback();
          txn.clear();
          throw e;
        }
      } else if (!lg.isCandidateRejection(err)) {
        throw err;
      }

      txn.rollback();
      txn.clear();

      txn.addOp(() => {
        smartSwapPositions(node, swapCandidate);
        return null;
      });

      err = commitErr(txn, ctx);

      let smartSwappedL1 = 0;
      let smartSwappedGlobalL = 0;
      let smartSwappedCrossings = 0;
      if (err === null) {
        try {
          smartSwappedL1 = measure(node);
          smartSwappedGlobalL = placementcost.edgeLength(ctx, g, pcOpts);
          smartSwappedCrossings = placementcost.graphEdgeCrossings(ctx, g);
        } catch (e) {
          txn.rollback();
          txn.clear();
          throw e;
        }
      } else if (!lg.isCandidateRejection(err)) {
        throw err;
      }

      txn.rollback();
      txn.clear();

      const pc = (a, b) => geo.precisionCompare(a, b, geo.PRECISION);
      if (swappedGlobalL === 0 && smartSwappedGlobalL === 0) continue;
      if (swappedL1 !== 0 && smartSwappedL1 === 0) {
        if (swappedCrossings <= currentCrossings && pc(swappedL1, currentL1) < 0 && pc(swappedGlobalL, currentGlobalL) < 0 && pc(swappedGlobalL, bestSwapEdgeLength) < 0) {
          bestSwapEdgeLength = swappedGlobalL;
          bestSmartSwapped = false;
          bestSwapCandidate = swapCandidate;
        }
      } else if (smartSwappedL1 !== 0 && swappedL1 === 0) {
        if (smartSwappedCrossings <= currentCrossings && pc(smartSwappedL1, currentL1) < 0 && pc(smartSwappedGlobalL, currentGlobalL) < 0 && pc(smartSwappedGlobalL, bestSwapEdgeLength) < 0) {
          bestSwapEdgeLength = smartSwappedGlobalL;
          bestSmartSwapped = true;
          bestSwapCandidate = swapCandidate;
        }
      } else if (swappedL1 !== 0 && smartSwappedL1 !== 0) {
        if (pc(smartSwappedL1, swappedL1) < 0) {
          if (smartSwappedCrossings <= currentCrossings && pc(smartSwappedL1, currentL1) < 0 && pc(smartSwappedGlobalL, currentGlobalL) < 0 && pc(smartSwappedGlobalL, bestSwapEdgeLength) < 0) {
            bestSwapEdgeLength = smartSwappedGlobalL;
            bestSmartSwapped = true;
            bestSwapCandidate = swapCandidate;
          }
        } else if (swappedCrossings <= currentCrossings && pc(swappedL1, currentL1) < 0 && pc(swappedGlobalL, currentGlobalL) < 0 && pc(swappedGlobalL, bestSwapEdgeLength) < 0) {
          bestSwapEdgeLength = swappedGlobalL;
          bestSmartSwapped = false;
          bestSwapCandidate = swapCandidate;
        }
      } else {
        // They can both be 0 if the node is just a container, in which case we compare globals
        if (swappedGlobalL !== 0 && smartSwappedGlobalL === 0) {
          if (swappedCrossings <= currentCrossings && pc(swappedGlobalL, currentGlobalL) < 0 && pc(swappedGlobalL, bestSwapEdgeLength) < 0) {
            bestSwapEdgeLength = swappedGlobalL;
            bestSmartSwapped = false;
            bestSwapCandidate = swapCandidate;
          }
        } else if (swappedGlobalL === 0 && smartSwappedGlobalL !== 0) {
          if (smartSwappedCrossings <= currentCrossings && pc(smartSwappedGlobalL, currentGlobalL) < 0 && pc(smartSwappedGlobalL, bestSwapEdgeLength) < 0) {
            bestSwapEdgeLength = smartSwappedGlobalL;
            bestSmartSwapped = true;
            bestSwapCandidate = swapCandidate;
          }
        } else if (pc(swappedGlobalL, smartSwappedGlobalL) < 0) {
          if (swappedCrossings <= currentCrossings && pc(swappedGlobalL, currentGlobalL) < 0 && pc(swappedGlobalL, bestSwapEdgeLength) < 0) {
            bestSwapEdgeLength = swappedGlobalL;
            bestSmartSwapped = false;
            bestSwapCandidate = swapCandidate;
          }
        } else if (smartSwappedCrossings <= currentCrossings && pc(smartSwappedGlobalL, currentGlobalL) < 0 && pc(smartSwappedGlobalL, bestSwapEdgeLength) < 0) {
          bestSwapEdgeLength = smartSwappedGlobalL;
          bestSmartSwapped = true;
          bestSwapCandidate = swapCandidate;
        }
      }
    }

    if (bestSwapCandidate !== null) {
      swapMade = true;
      txn.addOp(() => {
        if (bestSmartSwapped) smartSwapPositions(node, bestSwapCandidate);
        else swapPositions(node, bestSwapCandidate);
        return null;
      });
      txn.commit(ctx);
      txn.clear();
      txn.updateState();
    }
  }

  return swapMade;
}
