// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of the Go package d2layouts/d2talalayout/internal/routing (D2 v0.9.0): the resource-limit constants of
// ovg_resource.go, route_search_guard.go and route_stage_guard.go, gathered in one leaf module so that those files can import each
// other without an import cycle at module evaluation (they re-export what they own).

// OVG construction derives a visibility graph whose size can be much larger than the input graph. These limits bound the memory
// and CPU cost of one routing attempt independently of the adapter's input limits.
export const maxOVGIntersectionCandidates = 1_000_000;
export const maxOVGNodes = 200_000;
export const maxOVGEdges = 500_000;
// maxOVGWorkUnits bounds actual OVG construction and query work, including index construction.
export const maxOVGWorkUnits = 250_000_000;

// Production routing declares at most three alternative flavors.
export const maxRouteSearchFlavors = 3;
// maxRouteSearchWorkUnits is calibrated against representative routing corpora (larger measured per-flavor peak 51,125,738).
export const maxRouteSearchWorkUnits = 120_000_000;
export const routeSearchContextCheckStride = 1024;

// Route post-processing contains several intentionally quadratic searches.
export const maxRouteStageWorkUnits = 50_000_000;
export const routeStageContextCheckStride = 1024;
// EdgeRoutingStage owns OVG construction, up to three concurrent route flavors, and its stage-level discovery/rollback work.
export const maxEdgeRoutingStageWorkUnits = maxOVGWorkUnits + maxRouteSearchFlavors * maxRouteSearchWorkUnits + maxRouteStageWorkUnits;
