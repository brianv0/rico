// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of the Go package d2layouts/d2talalayout/internal/routing (D2 v0.9.0), file(s): loop_router.go.

import { OVGNode } from './ovg_node.js';
import { Route } from './route.js';

/** makeLoopRoute makes a `Route` based on the edge points */
export function makeLoopRoute(e, ovg) {
  const nodes = [];
  nodes.push(ovg.centers.get(e.from));
  for (const p of e.points) nodes.push(new OVGNode(p));
  nodes.push(ovg.centers.get(e.to));
  return new Route({
    gEdge: e,
    fromPort: e.points[0].copy(),
    toPort: e.points[e.points.length - 1].copy(),
    ovgNodes: nodes,
  });
}
