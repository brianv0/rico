// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of the Go package d2layouts/d2talalayout/internal/placement (D2 v0.9.0, github.com/d2lang/d2, Copyright 2022
// Terrastruct Inc.): transpose.go.

import * as geo from '../../geo.js';
import { goRound } from '../../gomath.js';
import { GoError } from '../goerrors.js';
import * as lg from '../layoutgraph.js';
import * as limits from '../limits.js';
import * as placementcost from '../placementcost.js';
import { optimizeCluster } from './cluster_optimization.js';
import { roundToNearestCellSize } from './types.js';

/**
 * transpose rotates the one or two node branch of `node` around its neighbor when that is more symmetrical. `edgeAbductions` is
 * null for Go's nil slice. Returns whether the layout changed.
 *
 * C is the current node:
 *   X
 *   |
 *   E -- A        We can transpose C-B around A to get     E -- A -- C -- B
 *   |    |                                                 |
 *   D    C                                                 D
 *        |
 *        B
 */
export function transpose(ctx, g, node, edgeAbductions) {
  ctx = lg.ensureTransactionWorkGuard(ctx, 'TransposeTransactions')[0];
  if (node.hierarchy !== null) return false;
  if (g.nodeToTree !== null && g.nodeToTree.has(node)) return false;
  if (g.isTreeSentinel(node)) return false;
  if (node.fixedTopLeft !== null) return false;
  // Maybe re-enable when I see a use case
  for (const e of edgeAbductions ?? []) {
    if (e.originallyFrom === node || e.originallyTo === node) return false;
    if (e.currentFrom === node || e.currentTo === node) return false;
  }
  if (node.edges.length !== 2 && node.edges.length !== 1) return false;
  const reachabilityGuard = limits.newWorkGuard(ctx, 'TransposeReachability', limits.MaxEngineWorkUnits);
  const reachableFrom = (start, includeContainers, ignore) => start.allReachableNodesContext(includeContainers, false, true, ignore, reachabilityGuard);

  // Need to account for this case too, whereby the container should be the one moving

  let transposeNodes = null;
  let centerNode = null;
  if (node.edges.length === 1) {
    const nodeA = node.adjacent(node.edges[0]);
    if (nodeA.isDescendantOf(node) || node.isDescendantOf(nodeA)) return false;
    if (geo.isDiagonal(node.orientation(nodeA))) return false;
    const ancestor = node.nearestSharedAncestor(nodeA);

    centerNode = nodeA;
    if (edgeAbductions === null) {
      let curr = node;
      while (curr.owningContainer() !== ancestor) curr = curr.owningContainer();

      transposeNodes = reachableFrom(curr, false, new Set([nodeA]));
      if (transposeNodes.some((n) => nodeA.isDescendantOf(n))) return false;
    } else {
      transposeNodes = [node];
    }
  } else {
    const nodeA = node.adjacent(node.edges[0]);
    const nodeB = node.adjacent(node.edges[1]);

    if (nodeA.isDescendantOf(node) || node.isDescendantOf(nodeA)) return false;
    if (nodeB.isDescendantOf(node) || node.isDescendantOf(nodeB)) return false;

    const ancestorA = node.nearestSharedAncestor(nodeA);
    const ancestorB = node.nearestSharedAncestor(nodeB);

    const connectedToA = reachableFrom(nodeA, true, new Set([node, ancestorA]));
    if (connectedToA.includes(nodeB)) return false;

    const nodeAOrientation = node.orientation(nodeA);
    const nodeBOrientation = node.orientation(nodeB);

    if (geo.isDiagonal(nodeAOrientation) || geo.isDiagonal(nodeBOrientation)) return false;

    const reachableNodesA = reachableFrom(nodeA, false, new Set([node, ancestorA]));
    const reachableNodesB = reachableFrom(nodeB, false, new Set([node, ancestorB]));

    // Rotate the side with less nodes around the side with more nodes
    if (reachableNodesA.length >= reachableNodesB.length) {
      if (edgeAbductions === null) {
        let curr = node;
        while (curr.owningContainer() !== ancestorB) curr = curr.owningContainer();

        transposeNodes = reachableFrom(curr, false, new Set([nodeA]));
        if (transposeNodes.some((n) => nodeA.isDescendantOf(n))) return false;
      } else {
        transposeNodes = reachableNodesB.concat([node]);
      }

      centerNode = nodeA;
    } else {
      if (edgeAbductions === null) {
        let curr = node;
        while (curr.owningContainer() !== ancestorA) curr = curr.owningContainer();

        transposeNodes = reachableFrom(curr, false, new Set([nodeB]));
        if (transposeNodes.some((n) => nodeB.isDescendantOf(n))) return false;
      } else {
        transposeNodes = reachableNodesA.concat([node]);
      }
      centerNode = nodeB;
    }
  }
  reachabilityGuard.finish();

  for (const n of transposeNodes) {
    if (n.fixedOrigin() !== null) return false;
  }

  const calcLength = () => {
    if (edgeAbductions === null) {
      return placementcost.edgeLength(ctx, g, { edgeAbductions: null, includeNodeSizes: true, enforceMinimumGap: false, penalizeDirection: true });
    }
    let sum = placementcost.nodeEdgeLength(ctx, node, { edgeAbductions, includeNodeSizes: true, enforceMinimumGap: false, penalizeDirection: true });
    for (const e of node.edges) {
      const length = placementcost.nodeEdgeLength(ctx, node.adjacent(e), { edgeAbductions, includeNodeSizes: true, enforceMinimumGap: false, penalizeDirection: true });
      sum += length;
    }
    return sum;
  };

  let bestLength = calcLength();
  let bestRotations = -1;

  const txn = g.newRequestTransaction(ctx, { affectContainers: true });

  // Rotate all around
  for (let i = 0; i < 3; i++) {
    txn.addOp(() => {
      for (const n of transposeNodes) {
        rotateAround(n, g, centerNode, i + 1, edgeAbductions !== null);
        if (n.isClusterVessel()) optimizeCluster(ctx, g.clusters.get(n), true);
      }
      return null;
    });

    let err = null;
    try {
      txn.commit(ctx);
    } catch (e) {
      if (!(e instanceof GoError)) throw e;
      err = e;
    }
    if (err === null) {
      let length;
      try {
        length = calcLength();
      } catch (scoreErr) {
        txn.rollback();
        txn.clear();
        throw scoreErr;
      }
      if (geo.precisionCompare(length, bestLength, geo.PRECISION) < 0) {
        bestLength = length;
        bestRotations = i + 1;
      }
    } else if (!lg.isCandidateRejection(err)) {
      throw err;
    }

    txn.rollback();
    txn.clear();
  }

  if (bestRotations !== -1) {
    txn.addOp(() => {
      for (const n of transposeNodes) {
        rotateAround(n, g, centerNode, bestRotations, edgeAbductions !== null);
        if (n.isClusterVessel()) optimizeCluster(ctx, g.clusters.get(n), true);
      }
      return null;
    });
    txn.commit(ctx);
    return true;
  }

  return false;
}

export function rotateAround(n, g, centerNode, times, round) {
  for (let i = 0; i < times; i++) {
    const nodeCenter = n.center();

    // Translate node center to origin
    const translatedX = nodeCenter.x - centerNode.topLeft.x - centerNode.width / 2;
    const translatedY = nodeCenter.y - centerNode.topLeft.y - centerNode.height / 2;

    // Rotate 90 degrees counterclockwise
    const rotatedX = -translatedY;
    const rotatedY = translatedX;

    // Translate back
    const newCenterX = rotatedX + centerNode.topLeft.x + centerNode.width / 2;
    const newCenterY = rotatedY + centerNode.topLeft.y + centerNode.height / 2;

    // Calculate new top-left position
    let newTopLeftX = goRound(newCenterX - n.width / 2);
    let newTopLeftY = goRound(newCenterY - n.height / 2);

    if (round) {
      if (Math.trunc(newTopLeftX) % Math.trunc(g.cellSize) !== 0) newTopLeftX = roundToNearestCellSize(newTopLeftX, g.cellSize);
      if (Math.trunc(newTopLeftY) % Math.trunc(g.cellSize) !== 0) newTopLeftY = roundToNearestCellSize(newTopLeftY, g.cellSize);
    }

    n.moveAbsWithChildren(newTopLeftX, newTopLeftY);
  }
}
