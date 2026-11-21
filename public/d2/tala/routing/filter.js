// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of the Go package d2layouts/d2talalayout/internal/routing (D2 v0.9.0), file(s): filter.go.

/**
 * filterEdgeAncestors removes container ancestors of either endpoint from the obstacle set used to route an edge. The endpoints
 * themselves remain so arrowhead-label placement can still account for their boxes.
 */
export function filterEdgeAncestors(edge, nodes) {
  const nonAncestors = [];
  for (const node of nodes) {
    if (node !== edge.from && node !== edge.to && (edge.from.isDescendantOf(node) || edge.to.isDescendantOf(node))) continue;
    nonAncestors.push(node);
  }
  return nonAncestors;
}
