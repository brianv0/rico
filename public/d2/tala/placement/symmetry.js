// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of the Go package d2layouts/d2talalayout/internal/placement (D2 v0.9.0, github.com/d2lang/d2, Copyright 2022
// Terrastruct Inc.): symmetry.go.

import * as geo from '../../geo.js';
import * as lg from '../layoutgraph.js';
import * as placementcost from '../placementcost.js';
import { commitErr } from './types.js';

/**
 * balanceSymmetry centers simple nodes among neighbors aligned on one side. (Go: BalanceSymmetry; the unexported twin names
 * of this package are only used inside it.)
 */
export function balanceSymmetry(ctx, g) {
  let guard;
  [ctx, guard] = lg.ensureTransactionWorkGuard(ctx, 'BalanceSymmetryTransactions');
  if (g.nodes.length === 0) return;
  let rollbackState = null;
  let complete = false;
  try {
    // Gap normalization takes care of cases where the adjacents are on opposite ends. So the only case we care about is when all
    // the adjacents are aligned on one end. And we just nudge to be in the middle of the alignment
    for (const n of g.nodes) {
      if (!isSimple(g, n)) continue;
      if (n.edges.length < 2) continue;
      let sameSide = true;
      const adjacentsM = new Set();
      for (let i = 0; i < n.edges.length - 1; i++) {
        const e1 = n.edges[i];
        const e2 = n.edges[i + 1];
        if (e1.fromTableColumnIndex !== null || e1.toTableColumnIndex !== null) continue;
        if (e2.fromTableColumnIndex !== null || e2.toTableColumnIndex !== null) continue;
        const adj1 = n.adjacent(e1);
        const adj2 = n.adjacent(e2);
        const o1 = n.orientation(adj1);
        const o2 = n.orientation(adj2);
        if (!geo.sameSide(o1, o2)) {
          sameSide = false;
          break;
        }
        adjacentsM.add(adj1);
        adjacentsM.add(adj2);
      }
      if (!sameSide) continue;
      if (adjacentsM.size < 2) continue;
      const adjacents = [...adjacentsM];
      if (placementcost.axisScore(adjacents) !== 1.0) continue;
      // Fails to look symmetrical if uneven adjacents
      let maxArea = -Infinity;
      for (const adj of adjacents) maxArea = Math.max(maxArea, adj.width * adj.height);
      let uneven = false;
      for (const adj of adjacents) {
        if (adj.width * adj.height < (0.5 * maxArea)) {
          uneven = true;
          break;
        }
      }
      if (uneven) continue;
      let isHorizontal = true;
      if (geo.isVertical(adjacents[0].orientation(adjacents[1]))) isHorizontal = false;
      const txn = g.newRequestTransactionWithWorkGuard(ctx, guard, { affectContainers: true });
      if (rollbackState === null) rollbackState = txn.priorGraphState;
      txn.addOp(() => {
        const center = lg.Nodes.center(adjacents);
        const nCenter = n.center();
        if (isHorizontal) n.moveWithChildren(Math.floor(center.x - nCenter.x), 0);
        else n.moveWithChildren(0, Math.floor(center.y - nCenter.y));
        return null;
      });
      const err = commitErr(txn, ctx);
      if (err !== null) {
        if (!lg.isCandidateRejection(err)) throw err;
      }
    }
    complete = true;
  } finally {
    if (!complete && rollbackState !== null) lg.restoreGraphState(g, rollbackState);
  }
}

/**
 * isSimple reports whether node participates only as a regular placement node, rather than as or inside one of the engine's
 * structured graph forms.
 */
export function isSimple(graph, node) {
  return !(node.isContainer() || graph.isTreeSentinel(node) || node.isClusterVessel() || graph.isSequenceVessel(node) || node.cluster !== null || node.hierarchy !== null);
}
