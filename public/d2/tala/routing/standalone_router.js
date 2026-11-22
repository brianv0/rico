// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of the Go package d2layouts/d2talalayout/internal/routing (D2 v0.9.0), file(s): standalone_router.go (RouteEdges, the
// router D2 calls to route edges on an already laid out graph).

import { errorf } from '../goerrors.js';
import * as lg from '../layoutgraph.js';
import { labeling } from './deps.js';
import { defaultOVGBuildLimits } from './ovg_resource.js';
import { maxRouteStageWorkUnits } from './route_limits.js';
import { runAtomicRouteStageAfterPreflight } from './route_stage_atomic.js';
import { routeAdditionalEdgesWithLimits } from './coordinator.js';
import { tryStraightEdgeFallbackGuarded, reorderDuplicatesInEdgesGuarded, traceToShapeBorderGuarded } from './standalone_route_guard.js';
import { isSpecialEdgeForBalancing, balanceRegularEdgesGuarded } from './postprocess.js';

export function hasCompleteEdgeRoute(edge) {
  if (edge.points.length < 2) return false;
  for (const point of edge.points) {
    if (point === null) return false;
  }
  return true;
}

/** RouteEdges(ctx, g, edges): mutates the edges (routes, label positions) */
export function routeEdges(ctx, g, edges) {
  routeEdgesWithBudgets(ctx, g, edges, defaultOVGBuildLimits(), maxRouteStageWorkUnits);
}

export function routeEdgesWithBudgets(ctx, g, edges, ovgLimits, workLimit) {
  if (g === null || g === undefined) throw errorf('cannot route edges on a nil graph');
  if (ctx === null || ctx === undefined) throw errorf('cannot route edges without a context');
  const ctxErr = ctx.err();
  if (ctxErr) throw ctxErr;
  // Reject caller-owned selections before using their length as an allocation hint. Accepted selections are charged again inside the
  // atomic boundary.
  if (edges.length > lg.MaxTopologyReferences) {
    throw errorf(`TALA EdgeRouting selected edge references exceed limit ${lg.MaxTopologyReferences}`);
  }
  lg.validate(ctx, 'RouteEdges', g);
  if (edges.length === 0) return;
  if (g.nodes.length === 0) throw errorf('cannot route edges on an empty graph');
  // A valid selection is duplicate-free and contains only graph edges, so it can never be larger than the graph inventory. Check before
  // map allocation.
  if (edges.length > g.edges.length) {
    throw errorf(`selected edge count ${edges.length} exceeds graph edge count ${g.edges.length}`);
  }

  const graphNodes = new Set();
  for (let index = 0; index < g.nodes.length; index++) {
    const node = g.nodes[index];
    if (node === null) throw errorf(`graph node at index ${index} is nil`);
    graphNodes.add(node);
  }
  const graphEdges = new Set();
  for (let index = 0; index < g.edges.length; index++) {
    const edge = g.edges[index];
    if (edge === null) throw errorf(`graph edge at index ${index} is nil`);
    if (edge.from === null || edge.to === null || edge.from.topLeft === null || edge.to.topLeft === null) {
      throw errorf(`graph edge ${edge.idValue()} has unplaced or missing endpoints`);
    }
    if (!graphNodes.has(edge.from)) throw errorf(`graph edge ${edge.idValue()} source node does not belong to the graph`);
    if (!graphNodes.has(edge.to)) throw errorf(`graph edge ${edge.idValue()} target node does not belong to the graph`);
    graphEdges.add(edge);
  }
  const selected = new Set();
  for (const edge of edges) {
    if (edge === null) throw errorf('cannot route a nil edge');
    if (!graphEdges.has(edge)) throw errorf(`edge ${edge.idValue()} does not belong to the graph`);
    if (selected.has(edge)) throw errorf(`edge ${edge.idValue()} was selected more than once`);
    selected.add(edge);
  }
  for (const edge of g.edges) {
    if (selected.has(edge)) continue;
    if (!hasCompleteEdgeRoute(edge)) throw errorf(`unselected edge ${edge.idValue()} has no complete route`);
  }

  // Standalone routing is one API transaction and one aggregate post-routing work budget. OVG construction and label placement retain
  // their independent derived-resource guards inside this exact rollback boundary.
  runAtomicRouteStageAfterPreflight(ctx, 'EdgeRouting', g, edges, workLimit, (guard) => {
    guard.add(g.nodes.length);
    g.computeCellSize();

    routeAdditionalEdgesWithLimits(ctx, g, edges, ovgLimits);
    guard.step();

    for (const edge of edges) {
      if (edge.hasTableColumn()) {
        guard.step();
        continue;
      }
      tryStraightEdgeFallbackGuarded(g, edge, guard);
    }

    const lockedEdges = [];
    for (const edge of g.edges) {
      guard.step();
      if (!selected.has(edge)) lockedEdges.push(edge);
    }
    const regularEdges = [];
    for (const edge of edges) {
      guard.step();
      if (isSpecialEdgeForBalancing(g, edge)) {
        lockedEdges.push(edge);
        continue;
      }
      regularEdges.push(edge);
    }
    balanceRegularEdgesGuarded(g, lockedEdges, regularEdges, guard);
    for (const edge of edges) traceToShapeBorderGuarded(edge, guard);
    reorderDuplicatesInEdgesGuarded(edges, guard);
    guard.step();
    labeling.placeNewEdges(ctx, g, edges);
    guard.finish();
  });
}
