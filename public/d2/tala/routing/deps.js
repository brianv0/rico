// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// The functions of the Go packages hierarchy, labeling, loops and quality that the routing package imports (D2 v0.9.0,
// d2layouts/d2talalayout/internal/{hierarchy,labeling,loops,quality}), as a minimal, documented dependency surface.
//
// The real modules are merged now (hierarchy.js, labeling.js): this file re-exports them under the names the routing core uses. What the CORE of routing needs from each:
//   hierarchy.IsHorizontal(nodes)                      ovg_hierarchy.js (newOVGForHierarchy)      -- implemented here (12 lines of Go)
//   labeling.PositionArrowheadLabel(edge, isTarget, route), labeling.PositionedArrowheadLabel
//                                                      ovg_edge_router.js, slingshot.js, route_line.js  -- implemented here (35 lines)
//   labeling.PlaceNewEdges(ctx, graph, edges)          standalone_router.go (RouteEdges), coordinator stage -- NOT needed by the core
//   loops.*, quality.*                                 coordinator.go, nudge_channels.go, shortcut_routes.go, port_interior_balance.go
//                                                      (second half of the package) -- NOT needed by the core
// The "real" modules must keep these exact names and semantics.

import * as hierarchyModule from '../hierarchy.js';
import * as labelingModule from '../labeling.js';

/** internal/hierarchy: routing only needs isHorizontal */
export const hierarchy = { isHorizontal: hierarchyModule.isHorizontal };

/** internal/labeling: PositionedArrowheadLabel is the rendered box reserved beside one end of an edge route. */
export const PositionedArrowheadLabel = labelingModule.PositionedArrowheadLabel;

export const labeling = {
  positionArrowheadLabel: labelingModule.positionArrowheadLabel,
  placeNewEdges: labelingModule.placeNewEdges,
};
