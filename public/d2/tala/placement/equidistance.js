// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of the Go package d2layouts/d2talalayout/internal/placement (D2 v0.9.0, github.com/d2lang/d2, Copyright 2022
// Terrastruct Inc.): equidistance.go.

import * as geo from '../../geo.js';
import { goRound } from '../../gomath.js';
import * as lg from '../layoutgraph.js';
import * as limits from '../limits.js';
import * as placementcost from '../placementcost.js';
import { commitErr, restoreNodePositions, snapshotNodePositionsContext } from './types.js';

/**
 * Equidistance centers nodes between aligned neighbors.
 *
 * A ---------------- B ------ C
 * Move B to the midpoint of A and C.
 */
export function equidistance(ctx, g) {
  ctx = lg.ensureTransactionWorkGuard(ctx, 'EquidistanceTransactions')[0];
  lg.validate(ctx, 'Equidistance', g);
  const originalPositions = snapshotNodePositionsContext(ctx, 'Equidistance', g.nodes);
  let complete = false;
  try {
    const reachabilityGuard = limits.newWorkGuard(ctx, 'EquidistanceReachability', limits.MaxEngineWorkUnits);
    let movedHorizontally = false;
    let movedVertically = false;
    for (const n of g.nodes) {
      const movedHorizontally2 = equidistanceNodeGuarded(ctx, n, g, true, reachabilityGuard);
      const movedVertically2 = equidistanceNodeGuarded(ctx, n, g, false, reachabilityGuard);
      if (movedHorizontally2) movedHorizontally = true;
      if (movedVertically2) movedVertically = true;
    }
    // Try multiple times, because moving one may result in different symmetries for others
    if (movedHorizontally) {
      let movedAgain = false;
      for (let i = 0; i < 5; i++) {
        for (const n of g.nodes) {
          const m = equidistanceNodeGuarded(ctx, n, g, true, reachabilityGuard);
          if (m) movedAgain = true;
        }
        if (!movedAgain) break;
        movedAgain = false;
      }
    }
    if (movedVertically) {
      let movedAgain = false;
      for (let i = 0; i < 5; i++) {
        for (const n of g.nodes) {
          const m = equidistanceNodeGuarded(ctx, n, g, false, reachabilityGuard);
          if (m) movedAgain = true;
        }
        if (!movedAgain) break;
        movedAgain = false;
      }
    }

    reachabilityGuard.finish();
    complete = true;
    return movedHorizontally || movedVertically;
  } finally {
    if (!complete) restoreNodePositions(originalPositions);
  }
}

export function equidistanceNodeGuarded(ctx, n, g, isHorizontal, reachabilityGuard) {
  const cerr = ctx.err();
  if (cerr) throw cerr;
  if (n.hierarchy !== null) return false;
  if (g.nodeToTree !== null && g.nodeToTree.has(n)) return false;
  if (g.isTreeSentinel(n)) return false;
  if (n.fixedTopLeft !== null) return false;

  let nearestBack = null;
  let nearestFront = null;

  for (const e of n.edges) {
    const adj = n.adjacent(e);
    if (n.isDescendantOf(adj) || adj.isDescendantOf(n)) return false;
    if (isHorizontal) {
      // Left
      if (adj.topLeft.x + adj.width < n.topLeft.x) {
        if (nearestBack === null || adj.topLeft.x + adj.width > nearestBack.topLeft.x + nearestBack.width) nearestBack = adj;
      }
      // Right
      if (adj.topLeft.x > n.topLeft.x + n.width) {
        if (nearestFront === null || adj.topLeft.x < nearestFront.topLeft.x) nearestFront = adj;
      }
    } else {
      // Top
      if (adj.topLeft.y + adj.height < n.topLeft.y) {
        if (nearestBack === null || adj.topLeft.y + adj.height > nearestBack.topLeft.y + nearestBack.height) nearestBack = adj;
      }
      // Bottom
      if (adj.topLeft.y > n.topLeft.y + n.height) {
        if (nearestFront === null || adj.topLeft.y < nearestFront.topLeft.y) nearestFront = adj;
      }
    }
  }

  if (nearestBack === null || nearestFront === null) return false;

  let otherConnected = [];
  for (const e of n.edges) {
    const adj = n.adjacent(e);
    if (adj === nearestBack || adj === nearestFront) continue;
    if (isHorizontal) {
      if (!geo.isVertical(adj.orientation(n))) continue;
    } else if (!geo.isHorizontal(adj.orientation(n))) {
      continue;
    }
    if (adj.isDescendantOf(nearestBack) || nearestBack.isDescendantOf(adj)) continue;
    if (adj.isDescendantOf(nearestFront) || nearestFront.isDescendantOf(adj)) continue;

    const reachable = adj.allReachableNodesContext(false, true, true, new Set([n, nearestBack, nearestFront]), reachabilityGuard);

    for (const reachableN of reachable) {
      if (n.isDescendantOf(reachableN)) continue;
      if (reachableN.isDescendantOf(nearestBack) || nearestBack.isDescendantOf(reachableN)) continue;
      if (reachableN.isDescendantOf(nearestFront) || nearestFront.isDescendantOf(reachableN)) continue;
    }

    for (const reachableN of reachable) {
      if (!otherConnected.includes(reachableN)) otherConnected.push(reachableN);
    }
  }

  for (const c of otherConnected) {
    if (c.fixedTopLeft !== null) {
      otherConnected = [];
      break;
    }
  }

  const ancestorBack = n.nearestSharedAncestor(nearestBack);
  const ancestorFront = n.nearestSharedAncestor(nearestFront);

  // We want to be able to move the whole container
  while (n.owningContainer() !== null && !nearestBack.isDescendantOf(n.owningContainer()) && !nearestFront.isDescendantOf(n.owningContainer())) {
    n = n.owningContainer();
  }

  // If b is the nearest back in !isHorizontal, b's container is relevant and should be used. But if it's not (a is beside the
  // container), we don't care.
  while (nearestBack.owningContainer() !== ancestorBack) {
    const container = nearestBack.owningContainer();
    if (isHorizontal) {
      if (container.topLeft.x + container.width < n.topLeft.x) nearestBack = nearestBack.owningContainer();
      else break;
    } else if (container.topLeft.y + container.height < n.topLeft.y) {
      nearestBack = nearestBack.owningContainer();
    } else {
      break;
    }
  }
  while (nearestFront.owningContainer() !== ancestorFront) {
    const container = nearestFront.owningContainer();
    if (isHorizontal) {
      if (container.topLeft.x > n.topLeft.x + n.width) nearestFront = nearestFront.owningContainer();
      else break;
    } else if (container.topLeft.y > n.topLeft.y + n.height) {
      nearestFront = nearestFront.owningContainer();
    } else {
      break;
    }
  }

  const pcOpts = { edgeAbductions: null, includeNodeSizes: true, enforceMinimumGap: false, penalizeDirection: true };
  const originalLength = placementcost.edgeLength(ctx, g, pcOpts);

  let diffX = 0;
  let diffY = 0;
  if (isHorizontal) {
    const x = goRound((nearestBack.topLeft.x + nearestBack.width + nearestFront.topLeft.x) / 2 - n.width / 2);
    diffX = x - n.topLeft.x;
  } else {
    const y = goRound((nearestBack.topLeft.y + nearestBack.height + nearestFront.topLeft.y) / 2 - n.height / 2);
    diffY = y - n.topLeft.y;
  }

  const txn = g.newRequestTransaction(ctx, { affectContainers: true });

  let rolledBack = false;
  let soloMoveLength = 0;
  let connectedMoveLength = 0;

  // First try moving just the node by itself
  txn.addOp(() => {
    n.moveWithChildren(diffX, diffY);
    return null;
  });
  let err = commitErr(txn, ctx);
  if (err !== null) {
    if (!lg.isCandidateRejection(err)) throw err;
    rolledBack = true;
  }
  if (!rolledBack) {
    let newLength;
    try {
      newLength = placementcost.edgeLength(ctx, g, pcOpts);
    } catch (e) {
      txn.rollback();
      throw e;
    }
    if (geo.precisionCompare(newLength, originalLength, geo.PRECISION) <= 0) soloMoveLength = newLength;
    txn.rollback();
  }

  txn.clear();

  // Then try moving with connected
  if (otherConnected.length > 0) {
    rolledBack = false;
    txn.addOp(() => {
      for (const n2 of otherConnected.concat([n])) n2.moveWithChildren(diffX, diffY);
      return null;
    });
    err = commitErr(txn, ctx);
    if (err !== null) {
      if (!lg.isCandidateRejection(err)) throw err;
      rolledBack = true;
    }
    if (!rolledBack) {
      let newLength;
      try {
        newLength = placementcost.edgeLength(ctx, g, pcOpts);
      } catch (e) {
        txn.rollback();
        throw e;
      }
      if (geo.precisionCompare(newLength, originalLength, geo.PRECISION) <= 0) connectedMoveLength = newLength;
      txn.rollback();
    }
  }

  txn.clear();

  // Then use the best global edge length and move it there
  if (soloMoveLength === 0 && connectedMoveLength === 0) return false;
  txn.addOp(() => {
    if (soloMoveLength === 0 && connectedMoveLength > 0) {
      for (const n2 of otherConnected.concat([n])) n2.moveWithChildren(diffX, diffY);
    } else if (soloMoveLength > 0 && connectedMoveLength === 0) {
      n.moveWithChildren(diffX, diffY);
    } else if (geo.precisionCompare(soloMoveLength, connectedMoveLength, geo.PRECISION) < 0) {
      n.moveWithChildren(diffX, diffY);
    } else {
      for (const n2 of otherConnected.concat([n])) n2.moveWithChildren(diffX, diffY);
    }
    return null;
  });

  txn.commit(ctx);
  return true;
}
