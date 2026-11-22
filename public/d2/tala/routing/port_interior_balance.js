// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of the Go package d2layouts/d2talalayout/internal/routing (D2 v0.9.0), file(s): port_interior_balance.go.

import { DIAMOND_TYPE } from '../../shape.js';
import * as quality from '../quality.js';
import { captureRouteMutations } from './route_stage_atomic.js';
import { balanceRegularEdgesGuarded } from './postprocess.js';
import { lineIntersectsUnrelatedNode, sameRouteDirection } from './edge_simplify.js';

export function hasFixedBalancingPorts(edge) {
  return edge.hasTableColumn() || edge.from.shape.getType() === DIAMOND_TYPE || edge.to.shape.getType() === DIAMOND_TYPE;
}

/**
 * balancePortInteriorsGuarded gives fixed-port routes a separate conservative balancing pass. Other routes, endpoints, and their approach
 * segments act as immutable corridor boundaries. Reject the whole tentative batch if moving connected bends creates an obstruction,
 * crossing, or substantial detour.
 */
export function balancePortInteriorsGuarded(g, guard) {
  const selected = [], locked = [];
  for (const e of g.edges) {
    guard.step();
    const fromTree = g.nodeToTree !== null && g.nodeToTree.has(e.from);
    const toTree = g.nodeToTree !== null && g.nodeToTree.has(e.to);
    if (hasFixedBalancingPorts(e) && !e.isCurve && !e.isLoop() && !fromTree && !toTree && e.points.length >= 6) selected.push(e);
    else locked.push(e);
  }
  if (selected.length === 0) return;
  const beforeMetrics = quality.inspect(guard.ctx, g);
  const snapshot = captureRouteMutations(g, null, guard);
  const before = copyRoutePoints(selected, guard);
  balanceRegularEdgesGuarded(g, locked, selected, guard);
  for (const e of selected) {
    const valid = changedRouteIsClear(g, e, before.get(e), true, guard);
    if (!valid) {
      snapshot.restore();
      return;
    }
  }
  const afterMetrics = quality.inspect(guard.ctx, g);
  if (afterMetrics.routeObstructions > beforeMetrics.routeObstructions || afterMetrics.crossings > beforeMetrics.crossings ||
    afterMetrics.textOcclusions > beforeMetrics.textOcclusions || afterMetrics.routeLength > beforeMetrics.routeLength * 1.1) {
    snapshot.restore();
  }
}

/** copyRoutePoints(edges, guard): Map<Edge, Point[]> of value copies */
export function copyRoutePoints(edges, guard) {
  const result = new Map();
  for (const e of edges) {
    guard.add(e.points.length + 1);
    result.set(e, e.points.map((p) => p.copy()));
  }
  return result;
}

const pointEq = (a, b) => a.x === b.x && a.y === b.y;

export function changedRouteIsClear(g, e, before, fixedPorts, guard) {
  if (e.points.length < 2 || before.length < 2) return false;
  if (fixedPorts && (!pointEq(e.points[0], before[0]) || !pointEq(e.points[e.points.length - 1], before[before.length - 1]) ||
    !sameRouteDirection(before[0], before[1], e.points[0], e.points[1]) ||
    !sameRouteDirection(before[before.length - 2], before[before.length - 1], e.points[e.points.length - 2], e.points[e.points.length - 1]))) {
    return false;
  }
  for (let i = 1; i < e.points.length; i++) {
    const a = e.points[i - 1], b = e.points[i];
    let unchanged = false;
    for (let j = 1; j < before.length; j++) {
      guard.step();
      if (pointEq(a, before[j - 1]) && pointEq(b, before[j])) {
        unchanged = true;
        break;
      }
    }
    if (unchanged) continue;
    if (a.x !== b.x && a.y !== b.y) return false;
    const blocked = lineIntersectsUnrelatedNode(g, e, a, b, guard);
    if (blocked) return false;
  }
  return true;
}
