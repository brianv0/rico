// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of the Go package d2layouts/d2talalayout/internal/routing (D2 v0.9.0), file(s): balance_route_guard.go and
// balance_crossings.go.

import * as geo from '../../geo.js';
import { newEdgeSegment } from '../layoutgraph.js';

/** removeDuplicatePointsGuarded(points, guard): the new point list (the input array itself when it has at most one point) */
export function removeDuplicatePointsGuarded(points, guard) {
  if (points.length <= 1) {
    guard.step();
    return points;
  }

  const result = [points[0]];
  for (let index = 1; index < points.length; index++) {
    guard.step();
    const previous = points[index - 1];
    const current = points[index];
    if (previous.x !== current.x || previous.y !== current.y) result.push(current);
  }

  if (result.length === 1) {
    const secondPoint = result[0].copy();
    secondPoint.x++;
    result.push(secondPoint);
  }
  return result;
}

export function nodeSegmentsGuarded(nodes, isHorizontal, guard) {
  const out = [];
  for (const node of nodes) {
    guard.step();
    if (isHorizontal) {
      out.push(new geo.Segment(node.topLeft, geo.newPoint(node.topLeft.x + node.width, node.topLeft.y)));
      out.push(new geo.Segment(geo.newPoint(node.topLeft.x, node.topLeft.y + node.height), geo.newPoint(node.topLeft.x + node.width, node.topLeft.y + node.height)));
    } else {
      out.push(new geo.Segment(node.topLeft, geo.newPoint(node.topLeft.x, node.topLeft.y + node.height)));
      out.push(new geo.Segment(geo.newPoint(node.topLeft.x + node.width, node.topLeft.y), geo.newPoint(node.topLeft.x + node.width, node.topLeft.y + node.height)));
    }
  }
  return out;
}

export function edgeSegmentsGuarded(edges, isHorizontal, guard) {
  const out = [];
  for (const edge of edges) {
    guard.step();
    for (let index = 0; index < edge.points.length - 1; index++) {
      guard.step();
      let start = null, end = null;
      if (isHorizontal) {
        if (edge.points[index].y === edge.points[index + 1].y) {
          if (edge.points[index].x < edge.points[index + 1].x) {
            start = edge.points[index];
            end = edge.points[index + 1];
          } else {
            start = edge.points[index + 1];
            end = edge.points[index];
          }
        }
      } else if (edge.points[index].x === edge.points[index + 1].x) {
        if (edge.points[index].y < edge.points[index + 1].y) {
          start = edge.points[index];
          end = edge.points[index + 1];
        } else {
          start = edge.points[index + 1];
          end = edge.points[index];
        }
      }
      if (start !== null && end !== null) out.push(newEdgeSegment(start, end, edge));
    }
  }
  return out;
}

/**
 * routeSegmentBounds is the cancellable equivalent of geo.Segment.GetBounds. Keep its comparisons byte-for-byte equivalent so successful
 * layouts do not change while long locked-segment scans become interruptible. Returns [floor, ceil].
 */
export function routeSegmentBounds(segment, segments, buffer, guard) {
  let ceil = Infinity;
  let floor = -Infinity;
  if (segment.Start.x === segment.End.x && segment.Start.y === segment.End.y) {
    guard.step();
    return [floor, ceil];
  }
  const isHorizontal = segment.Start.x === segment.End.x;
  for (const otherSegment of segments) {
    guard.step();
    if (isHorizontal) {
      if (otherSegment.End.y < segment.Start.y - buffer) continue;
      if (otherSegment.Start.y > segment.End.y + buffer) continue;
      if (otherSegment.Start.x <= segment.Start.x) floor = Math.max(floor, otherSegment.Start.x);
      if (otherSegment.Start.x > segment.Start.x) ceil = Math.min(ceil, otherSegment.Start.x);
    } else {
      if (otherSegment.End.x < segment.Start.x - buffer) continue;
      if (otherSegment.Start.x > segment.End.x + buffer) continue;
      if (otherSegment.Start.y <= segment.Start.y) floor = Math.max(floor, otherSegment.Start.y);
      if (otherSegment.Start.y > segment.Start.y) ceil = Math.min(ceil, otherSegment.Start.y);
    }
  }
  return [floor, ceil];
}

export function evenlyDistributeGuarded(floor, ceil, count, guard) {
  if (count <= 0 || floor >= ceil) {
    guard.step();
    return [];
  }
  const increment = Math.floor((ceil - floor) / (count + 1));
  if (increment <= 0) {
    guard.step();
    return [];
  }
  const out = [];
  for (let index = 1; index <= count; index++) {
    guard.step();
    out.push(floor + index * increment);
  }
  return out;
}

export const balanceOrderPreserved = 0;
export const balanceOrderReversed = 1;
export const balanceOrderContactChanged = 2;

/**
 * checkBalanceOrder checks a batch against parallel routes that belong to another movement range. Such routes are not locked yet when
 * the narrowest range is balanced, but moving past one can drag an attached elbow across it. Sorting within each batch alone cannot
 * preserve this ordering.
 *
 * Check every member, including partial shared trunks, before changing any coordinates. Rejecting the whole proposal preserves shared
 * routes; the caller still locks the unchanged batch so balancing always makes progress.
 */
export function checkBalanceOrder(batch, batchSet, segments, proposed, isHorizontal, guard) {
  let moving = false;
  for (let i = 0; i < batch.length; i++) {
    const segment = batch[i];
    guard.step();
    let old = segment.Start.y;
    if (isHorizontal) old = segment.Start.x;
    if (proposed[i] !== old) {
      moving = true;
      break;
    }
  }
  if (!moving) return balanceOrderPreserved;
  let status = balanceOrderPreserved;
  // Skip batch members before scanning proposals. A parallel bundle already balanced together needs only a linear scan when no outside
  // routes exist.
  for (const other of segments) {
    guard.step();
    if (batchSet.has(other)) continue;
    for (let i = 0; i < batch.length; i++) {
      const segment = batch[i];
      guard.step();
      // Segments of one route may meet while eliminating an elbow. Preserve ordering between distinct routes, not within a route.
      if (segment.owner() === other.owner()) continue;
      let old = segment.Start.y, position = other.Start.y;
      let start = segment.Start.x, end = segment.End.x;
      let otherStart = other.Start.x, otherEnd = other.End.x;
      if (isHorizontal) {
        old = segment.Start.x;
        position = other.Start.x;
        start = segment.Start.y;
        end = segment.End.y;
        otherStart = other.Start.y;
        otherEnd = other.End.y;
      }
      if (proposed[i] === old) continue;
      // Closed intervals matter: an elbow at the end of either segment moves with it, so touching intervals can also acquire a crossing.
      if (Math.max(start, end) < Math.min(otherStart, otherEnd) || Math.max(otherStart, otherEnd) < Math.min(start, end)) continue;
      if (old === position || proposed[i] === position) {
        // Creating a shared coordinate or splitting one is not a crossing improvement: crossing counts omit collinear contact.
        return balanceOrderContactChanged;
      }
      if ((old < position) !== (proposed[i] < position)) {
        status = balanceOrderReversed;
        // Keep checking: a later relation may prohibit fallback.
      }
    }
  }
  return status;
}
