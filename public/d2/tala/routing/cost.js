// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of the Go package d2layouts/d2talalayout/internal/routing (D2 v0.9.0), file(s): cost.go.

import { CrossingCostWeight } from '../layoutgraph.js';
import { goPow } from '../../gomath.js';
import { orientation } from './geometry.js';
import { turnPenalty } from './tuning.js';

/**
 * estimateRouteCost scores one candidate route against the routes that have already been selected. Crossing semantics belong to
 * routing: intersections at the exact end of an axis-aligned segment are bends off a shared route, not route crossings.
 */
export function estimateRouteCost(edges, edge) {
  let cost = edge.length();
  cost *= goPow(turnPenalty, edge.points.length - 2);

  let crossingCount = 0;
  for (const otherEdge of edges) {
    if (otherEdge === edge) continue;
    crossingCount += countNonSharedCrossings(edge, otherEdge);
  }
  cost += CrossingCostWeight * crossingCount;
  return cost;
}

export function countNonSharedCrossings(edge, otherEdge) {
  let crossingCount = 0;
  for (let edgeSegment = 0; edgeSegment < edge.points.length - 1; edgeSegment++) {
    for (let otherSegment = 0; otherSegment < otherEdge.points.length - 1; otherSegment++) {
      if (isNonSharedCrossing(edge, otherEdge, edgeSegment, otherSegment)) crossingCount++;
    }
  }
  return crossingCount;
}

export function isNonSharedCrossing(edge, otherEdge, edgeSegment, otherSegment) {
  if (!nonParallelIntersection(
    edge.points[edgeSegment],
    edge.points[edgeSegment + 1],
    otherEdge.points[otherSegment],
    otherEdge.points[otherSegment + 1],
  )) {
    return false;
  }

  // Skip intersections at the exact end of the segment to avoid counting bends off shared edges.
  const segmentStartX = edge.points[edgeSegment].x;
  const segmentStartY = edge.points[edgeSegment].y;
  if (segmentStartX === edge.points[edgeSegment + 1].x &&
    (segmentStartX === otherEdge.points[otherSegment].x || segmentStartX === otherEdge.points[otherSegment + 1].x)) {
    return false;
  }
  if (segmentStartY === edge.points[edgeSegment + 1].y &&
    (segmentStartY === otherEdge.points[otherSegment].y || segmentStartY === otherEdge.points[otherSegment + 1].y)) {
    return false;
  }
  return true;
}

export function equalSigns(first, second) {
  return first > 0 && second > 0 || first === 0 && second === 0 || first < 0 && second < 0;
}

/** nonParallelIntersection reports whether segments ab and cd intersect at an angle. Collinear overlap is intentionally not a routing crossing. */
export function nonParallelIntersection(a, b, c, d) {
  const abcOrientation = orientation(a, b, c);
  const abdOrientation = orientation(a, b, d);
  if (equalSigns(abcOrientation, abdOrientation)) return false;

  const cdaOrientation = orientation(c, d, a);
  const cdbOrientation = orientation(c, d, b);
  return !equalSigns(cdaOrientation, cdbOrientation);
}
