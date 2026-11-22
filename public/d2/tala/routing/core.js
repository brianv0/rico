// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of the CORE of the Go package d2layouts/d2talalayout/internal/routing (D2 v0.9.0): the orthogonal visibility graph
// (OVG), the OVG edge router (Dijkstra search with the slingshot pre-pass) and everything they need. This module is the documented
// API BOUNDARY between the core (this directory) and the stage logic of the package (coordinator, post-processing, nudging, shortcuts,
// swap ports, edge simplification, balance, tree routes stage, RouteGraph, RouteEdges), which a later port builds on top of it.
//
// What the stage half can rely on (all exported below):
//   - OVG construction: buildOVGFromGraphWithLimits(ctx, g, nearbyNodes, limits) / buildOVGFromGraphWithGuard(g, nearbyNodes, guard),
//     defaultOVGBuildLimits(), newOVGBuildGuard(ctx, limits), the OVG / OVGNode / OVGEdge model and OVG.marshalJSON().
//   - The router: newOVGEdgeRouterWithWorkLimit(ctx, flavor, ovg, g, existingRoutes, edges, workLimit) -> OvgEdgeRouter with
//     generateRoutes(ctx, straightLineFallback) -> GenerateRouteResponse { routes, distance, err, flavor, work } and the router's
//     considerNodeLabels flag; the flavors (ShortestToLongest, LongestToShortest, Default, TopDownLeftRight); Route.
//   - routeLine / routeLineGuarded / routeLineChecked (straight-line candidates between ports), edgeCanOverlapEdges, the
//     estimateRouteCost helpers, the guarded standalone helpers (portEdgesGuarded, tryStraightEdgeFallbackGuarded,
//     reorderDuplicatesInEdgesGuarded, traceToShapeBorderGuarded, ...), makeLoopRoute, traceToShapeBorder, filterEdgeAncestors.
//   - The work guards: RouteWorkGuard (newRouteWorkGuard, stage aggregate, contextWithRouteAggregateWork), RouteSearchWorkGuard,
//     OvgBuildGuard, the limit constants, stableSortRouteValues, SearchTelemetry.
// Not here (the stage half): coordinator.go (generateRouteFlavorResponses, finalizeSelectedRoutes, reorderSelectedRoutes,
// routeEdgesWithResourceGuards, routeAdditionalEdgesWithResourceLimits, routeSentinelEdge, routeInSShape, StraightEdgesFallback,
// ReorderDuplicates, Crosshatch), graph_stage.go, standalone_router.go, postprocess.go, nudge_channels.go, shortcut_routes.go,
// swap_ports.go, edge_simplify.go, balance_crossings.go, port_interior_balance.go, balance_route_guard.go, and from
// route_stage_guard.go: captureRouteMutations, validateRouteStageGeometry, routeStageGraphBoundingBox, runAtomicRouteStage*.
// The functions of the packages hierarchy / labeling / loops / quality that the core uses are in ./deps.js.
//
// Conventions: docs/d2-tala-port.md ("Port conventions" and "routing core"). Errors are thrown (GoError); a GenerateRouteResponse
// carries its error in `err` as in Go.

export * from './tuning.js';
export * from './route_limits.js';
export * from './work.js';
export * from './geometry.js';
export * from './turns.js';
export * from './cost.js';
export * from './filter.js';
export * from './ovg_edge.js';
export * from './ovg_node.js';
export * from './ovg_edge_set.js';
export * from './priority_queue.js';
export * from './route.js';
export * from './route_search_guard.js';
export * from './route_stage_guard.js';
export * from './ovg_resource.js';
export * from './ovg.js';
export * from './ovg_hierarchy.js';
export * from './tunnel.js';
export * from './tree_routes.js';
export * from './ovg_edge_router.js';
export * from './slingshot.js';
export * from './route_line.js';
export * from './standalone_route_guard.js';
export * from './cluster_route_guard.js';
export * from './loop_router.js';
export * from './trace.js';
export * from './snapshot.js';
export { hierarchy as hierarchyDeps, labeling as labelingDeps, PositionedArrowheadLabel } from './deps.js';
