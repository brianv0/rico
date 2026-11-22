// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of the Go package d2layouts/d2talalayout/internal/routing (D2 v0.9.0), file(s): edge_simplify.go.

import * as geo from '../../geo.js';
import { maxRouteStageWorkUnits } from './route_limits.js';
import { runAtomicRouteStage } from './route_stage_atomic.js';
import { intersects } from './geometry.js';

/**
 * simplifyEdgeRoutes post-processes edge routes to remove unnecessary bending caused by the constraint that routes have to go through OVG
 * nodes. It identifies unnecessary bends in routes and eliminates them when possible.
 */
export function simplifyEdgeRoutes(ctx, g) {
  simplifyEdgeRoutesWithLimit(ctx, g, maxRouteStageWorkUnits);
}

export function simplifyEdgeRoutesWithLimit(ctx, g, workLimit) {
  runAtomicRouteStage(ctx, 'SimplifyEdgeRoutes', g, null, workLimit, (guard) => {
    for (const edge of g.edges) {
      guard.step();
      for (let changed = true; changed;) {
        const newPoints = simplifyPoints(g, edge, guard);
        changed = newPoints.length < edge.points.length;
        if (changed) edge.points = newPoints;
      }
    }
  });
}

export function simplifyPoints(g, edge, guard) {
  const points = edge.points;

  if (points.length < 5) {
    guard.step();
    return points;
  }

  // Make a copy of the points to avoid modifying the original
  const result = [points[0]];
  let i = 0;

  // We want to find these and just simplify to L-shape
  while (i < points.length - 4) {
    guard.step();
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2];
    const p4 = points[i + 3];
    const p5 = points[i + 4];

    const vec1X = p2.x - p1.x, vec1Y = p2.y - p1.y; // p1->p2
    const vec2X = p3.x - p2.x, vec2Y = p3.y - p2.y; // p2->p3
    const vec3X = p4.x - p3.x; // p3->p4
    const vec4X = p5.x - p4.x, vec4Y = p5.y - p4.y; // p4->p5
    const vec3Y = p4.y - p3.y;

    const isHorizontal1 = isHorizontalSegment(p1, p2);
    const isVertical1 = isVerticalSegment(p1, p2);
    const isHorizontal2 = isHorizontalSegment(p2, p3);
    const isVertical2 = isVerticalSegment(p2, p3);
    const isHorizontal3 = isHorizontalSegment(p3, p4);
    const isVertical3 = isVerticalSegment(p3, p4);
    const isHorizontal4 = isHorizontalSegment(p4, p5);
    const isVertical4 = isVerticalSegment(p4, p5);

    // Pattern detection for special case:
    // 1. p2->p3 and p4->p5 are both vertical and going in opposite directions
    // 2. p1->p2 and p3->p4 are both horizontal and going in the same direction
    const isOppositeVerticals = isVertical2 && isVertical4 && ((vec2Y > 0 && vec4Y < 0) || (vec2Y < 0 && vec4Y > 0));

    const isSameHorizontals = isHorizontal1 && isHorizontal3 && ((vec1X > 0 && vec3X > 0) || (vec1X < 0 && vec3X < 0));

    // Alternative pattern:
    // 1. p2->p3 and p4->p5 are both horizontal and going in opposite directions
    // 2. p1->p2 and p3->p4 are both vertical and going in the same direction
    const isOppositeHorizontals = isHorizontal2 && isHorizontal4 && ((vec2X > 0 && vec4X < 0) || (vec2X < 0 && vec4X > 0));

    const isSameVerticals = isVertical1 && isVertical3 && ((vec1Y > 0 && vec3Y > 0) || (vec1Y < 0 && vec3Y < 0));

    // Check for the pattern described
    const patternFound = (isOppositeVerticals && isSameHorizontals) || (isOppositeHorizontals && isSameVerticals);

    let intersection = null;
    let hasObstruction = false;

    if (patternFound) {
      // Find the intersection point between the first segment (p1->p2) and fourth segment (p4->p5)
      intersection = findIntersectionPoint(p1, p2, p4, p5);

      // Both emitted legs must be legal. Checking only the extension of the first leg misses obstacles crossed by the second leg, and
      // can even reverse the approach into a fixed row port.
      hasObstruction = intersection === null;
      if (intersection !== null) {
        if (i === 0 && edge.from.containsPoint(p1, 1) && !sameRouteDirection(p1, p2, p1, intersection)) hasObstruction = true;
        if (i + 4 === points.length - 1 && edge.to.containsPoint(p5, 1) && !sameRouteDirection(p4, p5, intersection, p5)) hasObstruction = true;
        for (const leg of [[p1, intersection], [intersection, p5]]) {
          let blocked = lineIntersectsUnrelatedNode(g, edge, leg[0], leg[1], guard);
          hasObstruction = hasObstruction || blocked;
          blocked = lineIntersectsOtherEdges(g, edge, leg[0], leg[1], guard);
          hasObstruction = hasObstruction || blocked;
        }
      }
    }

    const canBeSimplified = patternFound && !hasObstruction;

    if (canBeSimplified) {
      // For a simplified route, we want: p1 -> intersection -> p5
      // p1 is already in the result array, so just add intersection and p5
      result.push(intersection);
      result.push(p5);

      i += 4;

      // Assume 1 simplification per edge
      break;
    } else {
      // If no pattern detected or it can't be simplified, keep the current point and move to the next
      result.push(p2);
      i++;
    }
  }

  // Add remaining points, making sure we don't go out of bounds
  const remainingStart = i + 1;
  if (remainingStart < points.length) {
    for (let j = remainingStart; j < points.length; j++) {
      guard.step();
      result.push(points[j]);
    }
  }

  return result;
}

/** findIntersectionPoint calculates the intersection point of the lines p1->p2 and p3->p4. This is used to find the intersection point between segments */
export function findIntersectionPoint(p1, p2, p3, p4) {
  if (isHorizontalSegment(p1, p2) && isVerticalSegment(p3, p4)) {
    return geo.newPoint(p4.x, p1.y);
  } else if (isVerticalSegment(p1, p2) && isHorizontalSegment(p3, p4)) {
    return geo.newPoint(p1.x, p4.y);
  }

  return null;
}

export function isHorizontalSegment(p1, p2) {
  return p1.y === p2.y;
}

export function isVerticalSegment(p1, p2) {
  return p1.x === p2.x;
}

/**
 * sameRouteDirection preserves the signed departure/approach direction, not merely the axis. A zero-length replacement cannot preserve a
 * port approach.
 */
export function sameRouteDirection(a, b, c, d) {
  return (b.x - a.x) * (d.x - c.x) + (b.y - a.y) * (d.y - c.y) > 0 &&
    (b.x - a.x) * (d.y - c.y) === (b.y - a.y) * (d.x - c.x);
}

/**
 * lineIntersectsUnrelatedNode checks every obstacle's open interior. Contact at an endpoint is legal; entering the endpoint's node from
 * its far side is not. Ancestor containers are allowed because their descendants route inside them.
 */
export function lineIntersectsUnrelatedNode(g, edge, p1, p2, guard) {
  for (const node of g.nodes) {
    guard.step();
    if (node.topLeft === null || node.width <= 0 || node.height <= 0) continue;
    if (node !== edge.from && node !== edge.to && (edge.from.isDescendantOf(node) || edge.to.isDescendantOf(node))) continue;
    if (orthogonalSegmentEntersNode(node, p1, p2)) return true;
  }
  return false;
}

/** `node` is any object with topLeft, width and height */
export function orthogonalSegmentEntersNode(node, a, b) {
  const epsilon = 1e-6;
  const left = node.topLeft.x + epsilon, right = node.topLeft.x + node.width - epsilon;
  const top = node.topLeft.y + epsilon, bottom = node.topLeft.y + node.height - epsilon;
  if (a.y === b.y) return top < a.y && a.y < bottom && Math.min(a.x, b.x) < right && Math.max(a.x, b.x) > left;
  if (a.x === b.x) return left < a.x && a.x < right && Math.min(a.y, b.y) < bottom && Math.max(a.y, b.y) > top;
  return true;
}

/** lineIntersectsOtherEdges checks if the line from p1 to p2 intersects with any other edges in the graph (excluding the edge being simplified) */
export function lineIntersectsOtherEdges(g, currentEdge, p1, p2, guard) {
  for (const edge of g.edges) {
    guard.step();
    if (edge === currentEdge) continue;

    if (edge.points.length < 2) continue;

    for (let i = 0; i < edge.points.length - 1; i++) {
      guard.step();
      if (intersects(p1, p2, edge.points[i], edge.points[i + 1])) return true;
    }
  }

  return false;
}
