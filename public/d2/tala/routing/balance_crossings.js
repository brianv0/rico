// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of the Go package d2layouts/d2talalayout/internal/routing (D2 v0.9.0), file(s): balance_crossings.go.

import { copyOwn } from './snapshot.js';
import { isNonSharedCrossing } from './cost.js';

/**
 * balanceReversalRemovesCrossings permits an otherwise rejected reversal only when it removes crossings without increasing them for any
 * affected route pair. This preserves useful uncrossing of routes that entered balancing in the wrong order. It is a fallback, not a
 * second scorer for every batch.
 *
 * Proposed point copies also move adjacent legs and respect pointer aliases. The graph stays untouched until the caller accepts the
 * entire batch.
 */
export function balanceReversalRemovesCrossings(g, batch, proposed, isHorizontal, guard) {
  const pointCopies = new Map(); // Map<Point, Point>
  for (let i = 0; i < batch.length; i++) {
    const segment = batch[i];
    guard.step();
    for (const point of [segment.Start, segment.End]) {
      guard.step();
      const candidate = point.copy();
      if (isHorizontal) candidate.x = proposed[i];
      else candidate.y = proposed[i];
      const previous = pointCopies.get(point);
      if (previous !== undefined && !(previous.x === candidate.x && previous.y === candidate.y)) return false;
      pointCopies.set(point, candidate);
    }
  }

  guard.add(g.edges.length);
  const candidates = new Array(g.edges.length).fill(null);
  const affected = [];
  for (let i = 0; i < g.edges.length; i++) {
    const edge = g.edges[i];
    guard.step();
    let changed = false;
    for (const point of edge.points) {
      guard.step();
      const candidate = pointCopies.get(point);
      if (candidate !== undefined && !(candidate.x === point.x && candidate.y === point.y)) changed = true;
    }
    if (!changed) continue;
    if (edge.isCurve) return false;
    guard.add(edge.points.length);
    const candidate = copyOwn(edge);
    candidate.points = new Array(edge.points.length);
    for (let j = 0; j < edge.points.length; j++) {
      const point = edge.points[j];
      guard.step();
      candidate.points[j] = point;
      const replacement = pointCopies.get(point);
      if (replacement !== undefined) candidate.points[j] = replacement;
      if (j > 0) {
        const before = edge.points[j - 1], after = candidate.points[j - 1];
        if ((before.x !== point.x && before.y !== point.y) || (after.x !== candidate.points[j].x && after.y !== candidate.points[j].y)) {
          return false;
        }
      }
    }
    candidates[i] = candidate;
    affected.push(i);
  }

  let improved = false;
  for (const i of affected) {
    guard.step();
    for (let j = 0; j < g.edges.length; j++) {
      const other = g.edges[j];
      guard.step();
      if (i === j || (candidates[j] !== null && j < i)) continue;
      // A curve's control polygon cannot prove its rendered crossings.
      if (other.isCurve) return false;
      let otherCandidate = candidates[j];
      if (otherCandidate === null) otherCandidate = other;
      let before = 0, after = 0;
      for (let a = 0; a + 1 < g.edges[i].points.length; a++) {
        guard.step();
        for (let b = 0; b + 1 < other.points.length; b++) {
          guard.step();
          if (isNonSharedCrossing(g.edges[i], other, a, b)) before++;
          if (isNonSharedCrossing(candidates[i], otherCandidate, a, b)) after++;
          // Dragged adjacent legs must not gain a new shared run. Existing shared trunks may extend as a crossing is removed.
          const oldOverlap = balanceCollinearOverlap(g.edges[i].points[a], g.edges[i].points[a + 1], other.points[b], other.points[b + 1]);
          const newOverlap = balanceCollinearOverlap(candidates[i].points[a], candidates[i].points[a + 1], otherCandidate.points[b], otherCandidate.points[b + 1]);
          if (oldOverlap === 0 && newOverlap > 0) return false;
        }
      }
      if (after > before) return false;
      improved = improved || after < before;
    }
  }
  return improved;
}

export function balanceCollinearOverlap(a, b, c, d) {
  if (a.x === b.x && c.x === d.x && a.x === c.x) {
    return Math.max(0, Math.min(Math.max(a.y, b.y), Math.max(c.y, d.y)) - Math.max(Math.min(a.y, b.y), Math.min(c.y, d.y)));
  }
  if (a.y === b.y && c.y === d.y && a.y === c.y) {
    return Math.max(0, Math.min(Math.max(a.x, b.x), Math.max(c.x, d.x)) - Math.max(Math.min(a.x, b.x), Math.min(c.x, d.x)));
  }
  return 0;
}
