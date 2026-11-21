// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of the Go package d2layouts/d2talalayout/internal/routing (D2 v0.9.0), file(s): cluster_route_guard.go.

import * as geo from '../../geo.js';
import { goPow } from '../../gomath.js';
import { CrossingCostWeight } from '../layoutgraph.js';
import { isNonSharedCrossing } from './cost.js';
import { turnPenalty } from './tuning.js';

export function estimateRouteCostGuarded(edges, edge, guard) {
  let length = 0.0;
  for (let index = 0; index < edge.points.length - 1; index++) {
    guard.step();
    length += geo.euclideanDistance(
      edge.points[index].x,
      edge.points[index].y,
      edge.points[index + 1].x,
      edge.points[index + 1].y,
    );
  }
  let cost = length * goPow(turnPenalty, edge.points.length - 2);

  let crossingCount = 0;
  for (const otherEdge of edges) {
    guard.step();
    if (otherEdge === edge) continue;
    for (let edgeSegment = 0; edgeSegment < edge.points.length - 1; edgeSegment++) {
      for (let otherSegment = 0; otherSegment < otherEdge.points.length - 1; otherSegment++) {
        guard.step();
        if (isNonSharedCrossing(edge, otherEdge, edgeSegment, otherSegment)) crossingCount++;
      }
    }
  }
  cost += CrossingCostWeight * crossingCount;
  return cost;
}

export function routeIntersectsNodeGuarded(nodes, edge, guard) {
  for (const otherNode of nodes) {
    guard.step();
    if (edge.from.isDescendantOf(otherNode) || edge.to.isDescendantOf(otherNode)) continue;
    for (let index = 0; index < edge.points.length - 1; index++) {
      guard.step();
      if (otherNode.passesThrough(edge.points[index], edge.points[index + 1])) return true;
    }
  }
  return false;
}
