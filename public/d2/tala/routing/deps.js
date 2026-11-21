// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// The functions of the Go packages hierarchy, labeling, loops and quality that the routing package imports (D2 v0.9.0,
// d2layouts/d2talalayout/internal/{hierarchy,labeling,loops,quality}), as a minimal, documented dependency surface.
//
// Those packages are ported by other agents; when they are merged, replace the bodies below by re-exports of the real modules (the
// signatures are the Go ones, errors thrown). What the CORE of routing needs from each:
//   hierarchy.IsHorizontal(nodes)                      ovg_hierarchy.js (newOVGForHierarchy)      -- implemented here (12 lines of Go)
//   labeling.PositionArrowheadLabel(edge, isTarget, route), labeling.PositionedArrowheadLabel
//                                                      ovg_edge_router.js, slingshot.js, route_line.js  -- implemented here (35 lines)
//   labeling.PlaceNewEdges(ctx, graph, edges)          standalone_router.go (RouteEdges), coordinator stage -- NOT needed by the core
//   loops.*, quality.*                                 coordinator.go, nudge_channels.go, shortcut_routes.go, port_interior_balance.go
//                                                      (second half of the package) -- NOT needed by the core
// The "real" modules must keep these exact names and semantics.

import * as geo from '../../geo.js';
import * as labelgeom from '../labelgeom.js';
import { errorf } from '../goerrors.js';

/** internal/hierarchy/orientation.go */
export const hierarchy = {
  /**
   * IsHorizontal reports the orientation shared by hierarchy placement and hierarchy-aware routing. Entity-relationship diagrams use
   * horizontal hierarchy placement regardless of the container direction.
   */
  isHorizontal(nodes) {
    if (nodes.length === 0) return false;
    if (geo.isHorizontal(nodes[0].containerDirection())) return true;
    for (const node of nodes) {
      if (node !== null && node.isTable()) return true;
    }
    return false;
  },
};

/** internal/labeling/arrowhead.go: PositionedArrowheadLabel is the rendered box reserved beside one end of an edge route. */
export class PositionedArrowheadLabel {
  constructor(box, edge, isTarget, text) {
    this.box = box; // geo.Box (Go embeds it: label.Box)
    this.edge = edge;
    this.isTarget = isTarget;
    this.text = text;
  }

  /** Go value copy */
  copy() {
    return new PositionedArrowheadLabel(this.box.copy(), this.edge, this.isTarget, this.text);
  }
}

export const labeling = {
  /**
   * PositionArrowheadLabel derives the renderer-compatible label box for one arrowhead. null means that endpoint has no
   * arrowhead label.
   */
  positionArrowheadLabel(edge, isTarget, route) {
    if (edge === null) return null;
    let value = edge.sourceArrowheadLabel;
    if (isTarget) value = edge.targetArrowheadLabel;
    if (value === null) return null;
    const topLeft = labelgeom.arrowheadTopLeft(route, isTarget, String(edge.sourceArrowhead), String(edge.targetArrowhead), value.width, value.height);
    return new PositionedArrowheadLabel(geo.newBox(topLeft, value.width, value.height), edge, isTarget, value.text);
  },

  /** labeling.PlaceNewEdges(ctx, graph, edges): provided by the labeling port; the routing core does not call it. */
  placeNewEdges(/* ctx, graph, edges */) {
    throw errorf('routing deps: labeling.placeNewEdges is not ported yet (needs the labeling package)');
  },
};
