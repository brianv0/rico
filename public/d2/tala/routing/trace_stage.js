// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of the Go package d2layouts/d2talalayout/internal/routing (D2 v0.9.0), file(s): trace.go, the stage entry point
// (the per-edge traceToShapeBorder is trace.js).

import { maxRouteStageWorkUnits } from './route_limits.js';
import { runAtomicRouteStage } from './route_stage_atomic.js';
import { traceToShapeBorderGuarded } from './standalone_route_guard.js';

/** TraceEdgesToShapeBorder trims every route endpoint to the rendered shape. */
export function traceEdgesToShapeBorder(ctx, graph) {
  traceEdgesToShapeBorderWithWorkLimit(ctx, graph, maxRouteStageWorkUnits);
}

export function traceEdgesToShapeBorderWithWorkLimit(ctx, graph, workLimit) {
  runAtomicRouteStage(ctx, 'TraceEdgesToShapeBorder', graph, null, workLimit, (guard) => {
    for (const edge of graph.edges) traceToShapeBorderGuarded(edge, guard);
  });
}
