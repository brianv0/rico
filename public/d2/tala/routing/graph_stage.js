// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of the Go package d2layouts/d2talalayout/internal/routing (D2 v0.9.0), file(s): graph_stage.go (RouteGraph, the whole
// graph routing stage: EdgeRouting, pipeline stages 21 and 24).
//
// SubgraphRouteObserver is an object with `subgraphRouted(ovg)`, RouteCompletionObserver one with `routingCompleted()`; both may be
// null. Go's (bool, error) is the returned bool with the error thrown (the caller keeps its previous value when it throws).

import { errorf } from '../goerrors.js';
import * as invariant from '../invariant.js';
import * as lg from '../layoutgraph.js';
import { newRouteWorkGuard, contextWithRouteAggregateWork } from './route_stage_guard.js';
import { maxEdgeRoutingStageWorkUnits } from './route_limits.js';
import { maxRouteSearchWorkUnits } from './route_search_guard.js';
import { newOVGBuildGuard, defaultOVGBuildLimits } from './ovg_resource.js';
import { overshootAmount } from './tuning.js';
import { validateRouteStageGeometry, routeStageGraphBoundingBox, runAtomicRouteStageWithValidatedGeometry } from './route_stage_atomic.js';
import { routeEdgesWithResourceGuards } from './coordinator.js';
import { hasCompleteEdgeRoute } from './standalone_router.js';

/** GraphRouteOptions: { forceReroute, routesPreviouslyCompleted, observer, completionObserver } (all optional) */

/**
 * RouteGraph runs the complete graph-routing stage. The returned boolean is the updated value of RoutesPreviouslyCompleted; on error the
 * caller must retain its prior value.
 */
export function routeGraph(ctx, graph, options) {
  return routeGraphWithWorkLimit(ctx, graph, options, maxEdgeRoutingStageWorkUnits);
}

/** RouteGraphWithWorkLimit is RouteGraph with an explicit aggregate budget. */
export function routeGraphWithWorkLimit(ctx, graph, options, workLimit) {
  options = options ?? {};
  let routingComplete = !!options.routesPreviouslyCompleted;
  if (graph === null || graph === undefined) throw errorf('TALA EdgeRouting requires a graph');
  const guard = newRouteWorkGuard(ctx, 'EdgeRouting', workLimit);

  // Previously completed routes take an early success path below, but still cross the same topology, geometry, and resource boundary as
  // routes built here.
  lg.validate(ctx, 'EdgeRouting', graph);
  validateRouteStageGeometry(graph, null, guard);
  if (graph.edges.length === 0) {
    guard.finish();
    return routingComplete;
  }

  // Existing routes are authoritative only after this pipeline has completed its first routing pass. A fresh full layout must reroute
  // stale points from a previous layout after moving nodes.
  if (!options.forceReroute && options.routesPreviouslyCompleted) {
    let routedEdges = 0;
    for (const edge of graph.edges) {
      guard.step();
      if (edge.points.length === 0) continue;
      if (!hasCompleteEdgeRoute(edge)) {
        throw invariant.errorf(`edge ${edge.idValue()} has an incomplete route: expected at least two non-nil points, got ${edge.points.length}`);
      }
      routedEdges++;
    }
    if (routedEdges === graph.edges.length) {
      routingComplete = true;
      if (options.completionObserver) options.completionObserver.routingCompleted();
      guard.finish();
      return routingComplete;
    }
    if (routedEdges !== 0) {
      throw invariant.errorf(`graph is partially routed: ${routedEdges} of ${graph.edges.length} edges have routes`);
    }
  }

  runAtomicRouteStageWithValidatedGeometry(graph, null, guard, (guard) => {
    const routingCtx = contextWithRouteAggregateWork(ctx, guard);
    const ovgGuard = newOVGBuildGuard(routingCtx, defaultOVGBuildLimits());

    const [subgraphs, splitOwnership] = graph.splitSubgraphsTracked(ctx, { includeContainers: true, includeNears: true }, guard);
    // SplitSubgraphs intentionally points reachable nodes at temporary graphs. Restore the exact prior owner on every exit, including
    // Near-only nodes outside Graph.Nodes and failures before the normal restoration pass.
    try {
      guard.add(subgraphs.length);
      for (const subgraph of subgraphs) {
        guard.step();
        if (subgraph.edges.length === 0) continue;
        guard.add(subgraph.nodes.length);
        const [topLeft, bottomRight] = routeStageGraphBoundingBox(subgraph, guard);
        topLeft.x -= overshootAmount;
        topLeft.y -= overshootAmount;
        bottomRight.x += overshootAmount;
        bottomRight.y += overshootAmount;
        const nodesInBoundingBox = [];
        for (const otherSubgraph of subgraphs) {
          guard.step();
          if (otherSubgraph === subgraph) continue;
          for (const node of otherSubgraph.nodes) {
            guard.step();
            if (node.isWithinBounds(topLeft, bottomRight)) {
              // If another node not in this subgraph overlaps one of its nodes, it may sit on the center or block a port into the
              // center and therefore is not an obstruction.
              let overlapsSubgraph = false;
              for (const subgraphNode of subgraph.nodes) {
                guard.step();
                if (node.doesOverlapExact(subgraphNode)) {
                  overlapsSubgraph = true;
                  break;
                }
              }
              if (!overlapsSubgraph) nodesInBoundingBox.push(node);
            }
          }
        }

        guard.add(subgraph.nodes.length + subgraph.edges.length);
        subgraph.computeCellSize();
        const ovg = routeEdgesWithResourceGuards(routingCtx, subgraph, nodesInBoundingBox, ovgGuard, maxRouteSearchWorkUnits);
        // Observe cancellation or an exhausted aggregate budget after routing has mutated edges and before optional engine-owned
        // serialization.
        guard.step();
        if (options.observer) options.observer.subgraphRouted(ovg);
      }

      // SplitSubgraphs points members at their temporary graph. Restore every member and descendant once; repeated recursive
      // restoration is quadratic for deep containment trees.
      const seenNodes = new Set();
      const nodesToRestore = [];
      const enqueue = (node) => {
        guard.step();
        if (node === null) return;
        if (seenNodes.has(node)) return;
        seenNodes.add(node);
        nodesToRestore.push(node);
      };
      for (const subgraph of subgraphs) {
        for (const node of subgraph.nodes) enqueue(node);
      }
      for (let index = 0; index < nodesToRestore.length; index++) {
        const node = nodesToRestore[index];
        const [originalGraph, captured] = splitOwnership.originalGraph(node);
        if (captured) node.graph = originalGraph;
        else node.graph = graph;
        if (node.isContainer()) {
          for (const child of graph.containers.get(node) ?? []) enqueue(child);
        }
        if (node.isClusterVessel()) {
          const cluster = graph.clusters.get(node);
          if (cluster !== undefined && cluster !== null) {
            for (const child of cluster.nodes) enqueue(child);
          }
        }
        const sequence = graph.sequences.get(node);
        if (sequence !== undefined && sequence !== null) {
          for (const child of sequence.nodes) enqueue(child);
        }
      }

      routingComplete = true;
      if (options.completionObserver) options.completionObserver.routingCompleted();
    } finally {
      splitOwnership.restore();
    }
  });
  return routingComplete;
}
