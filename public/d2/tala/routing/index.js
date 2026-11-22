// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// The whole Go package d2layouts/d2talalayout/internal/routing (D2 v0.9.0): the core (./core.js: OVG, router, slingshot, guards) and the
// stage half (graph_stage, coordinator, standalone_router, postprocess, balance*, port_interior_balance, nudge_channels, shortcut_routes,
// swap_ports, edge_simplify, trace_stage, route_stage_atomic). The pipeline resolves its stage functions by name from this module
// (stagepkgs.js): routeGraph, routeGraphWithWorkLimit, simplifyEdgeRoutes, shortcutEdgeRoutes, straightEdgesFallback,
// traceEdgesToShapeBorder, balanceEdgeSegments, nudgeEdgeChannels, fixClusterEdgeBranching, reorderDuplicates, swapAllEdgePorts,
// crosshatch and routeEdges.

export * from './core.js';
export * from './route_stage_atomic.js';
export * from './coordinator.js';
export * from './graph_stage.js';
export * from './standalone_router.js';
export * from './postprocess.js';
export * from './balance_route_guard.js';
export * from './balance_crossings.js';
export * from './port_interior_balance.js';
export * from './edge_simplify.js';
export * from './swap_ports.js';
export * from './nudge_channels.js';
export * from './shortcut_routes.js';
export * from './trace_stage.js';
