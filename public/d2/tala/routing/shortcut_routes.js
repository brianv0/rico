// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of the Go package d2layouts/d2talalayout/internal/routing (D2 v0.9.0), file(s): shortcut_routes.go
// (ShortcutEdgeRoutes).

import * as geo from '../../geo.js';
import * as label from '../../label.js';
import { errorsIs } from '../goerrors.js';
import * as quality from '../quality.js';
import { labeling } from './deps.js';
import { maxRouteStageWorkUnits } from './route_limits.js';
import { errRouteStageWorkLimit } from './route_stage_guard.js';
import { runAtomicRouteStage, captureRouteMutations } from './route_stage_atomic.js';
import { segmentSpacingBuffer } from './tuning.js';
import { sameRouteDirection, orthogonalSegmentEntersNode } from './edge_simplify.js';
import { changedRouteIsClear } from './port_interior_balance.js';
import { channelInventoryIsClosed, channelCoordinate } from './nudge_channels.js';
import { copyOwn } from './snapshot.js';

export const maxShortcutInput = 256;
export const maxShortcutRoute = 32;
export const shortcutEpsilon = 1e-6;

const pointEq = (a, b) => a.x === b.x && a.y === b.y;
const isInf = (v) => v === Infinity || v === -Infinity;

/**
 * ShortcutEdgeRoutes is a bounded bend-reduction postpass with fixed boxes and ports. WueOrtho's routing step chooses bend-minimal
 * shortest paths (https://arxiv.org/html/2309.01671v2#S2), motivating this local adaptation: replace a subchain by either rectilinear L,
 * retaining only strict bend wins. It is not a shortest-path solver and does not change the routing grid.
 */
export function shortcutEdgeRoutes(ctx, g) {
  try {
    shortcutRoutesWithLimit(ctx, g, maxRouteStageWorkUnits);
  } catch (err) {
    if (errorsIs(err, errRouteStageWorkLimit)) return; // The atomic stage has already restored the entire drawing.
    throw err;
  }
}

export function shortcutInputTooLarge(g) {
  if (g === null) return false;
  if (g.nodes.length > maxShortcutInput || g.edges.length > maxShortcutInput) return true;
  let remaining = maxShortcutInput;
  for (const e of g.edges) {
    if (e !== null) {
      if (e.points.length > remaining) return true;
      remaining -= e.points.length;
    }
  }
  return false;
}

export function shortcutRoutesWithLimit(ctx, g, limit) {
  if (ctx != null && g != null) {
    let err = ctx.err();
    if (err) throw err;
    if (shortcutInputTooLarge(g)) {
      // Oversized inputs are optional no-ops, before validation/snapshot allocation. Malformed admitted inputs retain stage validation.
      err = ctx.err();
      if (err) throw err;
      return;
    }
  }
  runAtomicRouteStage(ctx, 'ShortcutEdgeRoutes', g, null, limit, (guard) => {
    shortcutRoutesGuarded(g, guard);
  });
}

export function shortcutRoutesGuarded(g, guard) {
  let boxes = null;
  let labelsReady = false;
  let inventoryChecked = false;
  for (const e of g.edges) {
    guard.step();
    const fromTree = g.nodeToTree !== null && g.nodeToTree.has(e.from);
    const toTree = g.nodeToTree !== null && g.nodeToTree.has(e.to);
    if (e.isInvisible || e.isCurve || e.isLoop() || fromTree || toTree ||
      e.label !== null || e.sourceArrowheadLabel !== null || e.targetArrowheadLabel !== null ||
      e.points.length < 5 || e.points.length > maxShortcutRoute || !shortcutOrthogonal(e.points)) {
      continue;
    }
    // A crossing or contact with a curved route cannot be certified from its control polygon. Leave these drawings to the existing router.
    let unsupported = false;
    for (const other of g.edges) {
      guard.step();
      unsupported = unsupported || other.isCurve || !shortcutOrthogonal(other.points);
    }
    if (unsupported) return;
    if (!labelsReady) {
      boxes = shortcutLabelBoxes(g, guard);
      labelsReady = true;
    }
    let best = e.points;
    let bestLength = shortcutLength(best);
    const beforeBends = shortcutBends(best);
    let bestBends = shortcutBends(best);
    for (let start = 0; start + 3 < e.points.length; start++) {
      for (let end = start + 3; end < e.points.length; end++) {
        for (const horizontal of [true, false]) {
          guard.add(e.points.length);
          const candidate = shortcutCandidate(e.points, start, end, horizontal);
          const length = shortcutLength(candidate);
          const bends = shortcutBends(candidate);
          if (bends >= beforeBends || bends > bestBends ||
            length > shortcutLength(e.points) + shortcutEpsilon ||
            (bends === bestBends && length >= bestLength - shortcutEpsilon)) {
            continue;
          }
          const safe = shortcutCandidateSafe(g, e, candidate, boxes, guard);
          if (safe) {
            best = candidate;
            bestLength = length;
            bestBends = bends;
          }
        }
      }
    }
    if (bestBends === beforeBends) continue;
    if (!inventoryChecked) {
      // Direct graph slices define the modeled obstacles. Route-stage ownership may reach other nodes/edges, so conservatively decline
      // these inputs before committing any uninspected geometry.
      const snapshot = captureRouteMutations(g, null, guard);
      const closed = channelInventoryIsClosed(g, snapshot, guard);
      if (!closed) return;
      inventoryChecked = true;
    }
    // The local guards are per node/label/edge pair; inspection is a final aggregate backstop, paid only for a geometrically viable
    // shortcut.
    const before = quality.inspect(guard.ctx, g);
    const original = e.points;
    e.points = best;
    const after = quality.inspect(guard.ctx, g);
    if (after.routeObstructions > before.routeObstructions || after.crossings > before.crossings ||
      after.textOcclusions > before.textOcclusions || after.routeLength > before.routeLength + shortcutEpsilon) {
      e.points = original;
    }
  }
}

export function shortcutOrthogonal(points) {
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (p === null || Number.isNaN(p.x) || Number.isNaN(p.y) || isInf(p.x) || isInf(p.y)) return false;
    if (i > 0 && (pointEq(p, points[i - 1]) || (p.x !== points[i - 1].x && p.y !== points[i - 1].y))) return false;
    if (i > 1 && !sameRouteDirection(points[i - 2], points[i - 1], points[i - 1], p) &&
      (points[i - 2].x === p.x || points[i - 2].y === p.y)) {
      return false; // A U-turn is not a harmless collinear vertex.
    }
  }
  return points.length >= 2;
}

export function shortcutLength(points) {
  let length = 0.0;
  for (let i = 1; i < points.length; i++) {
    length += Math.abs(points[i].x - points[i - 1].x) + Math.abs(points[i].y - points[i - 1].y);
  }
  return length;
}

export function shortcutBends(points) {
  let bends = 0;
  for (let i = 2; i < points.length; i++) {
    const a = points[i - 2], b = points[i - 1], c = points[i];
    if ((b.x - a.x) * (c.y - b.y) !== (b.y - a.y) * (c.x - b.x)) bends++;
  }
  return bends;
}

export function shortcutCandidate(points, start, end, horizontal) {
  let elbow = geo.newPoint(points[end].x, points[start].y);
  if (!horizontal) elbow = geo.newPoint(points[start].x, points[end].y);
  const raw = points.slice(0, start + 1);
  raw.push(elbow);
  for (const p of points.slice(end)) raw.push(p);
  const result = [];
  for (const p of raw) {
    if (result.length > 0 && pointEq(result[result.length - 1], p)) continue;
    while (result.length >= 2 && sameRouteDirection(result[result.length - 2], result[result.length - 1], result[result.length - 1], p)) {
      result.pop();
    }
    result.push(p);
  }
  return result;
}

export function shortcutCandidateSafe(g, e, points, labels, guard) {
  if (!shortcutOrthogonal(points) || shortcutBends(points) >= shortcutBends(e.points) || shortcutLength(points) > shortcutLength(e.points) + shortcutEpsilon) {
    return false;
  }
  const candidate = copyOwn(e);
  candidate.points = points;
  let safe = changedRouteIsClear(g, candidate, e.points, true, guard);
  if (!safe) return safe;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const length = Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
    let minimum = segmentSpacingBuffer;
    let unchanged = false;
    for (let j = 1; j < e.points.length; j++) {
      guard.step();
      unchanged = unchanged || (pointEq(a, e.points[j - 1]) && pointEq(b, e.points[j]));
    }
    if (i === 1) minimum = Math.min(minimum, shortcutLength(e.points.slice(0, 2)));
    if (i === points.length - 1) minimum = Math.min(minimum, shortcutLength(e.points.slice(e.points.length - 2)));
    if (!unchanged && length + shortcutEpsilon < minimum) return false;
    for (let j = i + 2; j < points.length; j++) {
      guard.step();
      if (shortcutSegmentsMeet(a, b, points[j - 1], points[j])) return false;
    }
    if (unchanged) continue;
    for (const box of labels) {
      guard.step();
      if (orthogonalSegmentEntersNode({ topLeft: box.TopLeft, width: box.Width, height: box.Height }, a, b)) return false;
    }
    safe = shortcutWallClearance(g, e.points, a, b, guard);
    if (!safe) return safe;
    safe = shortcutParallelClearance(g, e, a, b, guard);
    if (!safe) return safe;
  }
  for (const other of g.edges) {
    if (other === e) continue;
    safe = shortcutContactsPreserved(e.points, points, other.points, guard);
    if (!safe) return safe;
  }
  return true;
}

/**
 * Compare actual intersection geometry rather than segment indices: reducing bends renumbers segments. New point contacts must already
 * lie on the old route; each new shared interval must be covered by old collinear geometry.
 */
export function shortcutContactsPreserved(before, after, other, guard) {
  for (let i = 1; i < after.length; i++) {
    for (let j = 1; j < other.length; j++) {
      guard.step();
      const a = after[i - 1], b = after[i], c = other[j - 1], d = other[j];
      if (!shortcutSegmentsMeet(a, b, c, d)) continue;
      if ((a.x === b.x) !== (c.x === d.x)) {
        let p = geo.newPoint(a.x, c.y);
        if (a.y === b.y) p = geo.newPoint(c.x, a.y);
        let covered = false;
        for (let k = 1; k < before.length; k++) {
          guard.step();
          covered = covered || shortcutPointOnSegment(p, before[k - 1], before[k]);
        }
        const [oldH, oldV] = shortcutThroughRays(before, p, guard);
        const [newH, newV] = shortcutThroughRays(after, p, guard);
        const [otherH, otherV] = shortcutThroughRays(other, p, guard);
        const newCrossing = (newH && otherV) || (newV && otherH);
        const oldCrossing = (oldH && otherV) || (oldV && otherH);
        if (!covered || (newCrossing && !oldCrossing)) return false;
        continue;
      }
      const horizontal = a.y === b.y;
      let position = a.x;
      if (horizontal) position = a.y;
      const lo = Math.max(Math.min(channelCoordinate(a, horizontal), channelCoordinate(b, horizontal)), Math.min(channelCoordinate(c, horizontal), channelCoordinate(d, horizontal)));
      const hi = Math.min(Math.max(channelCoordinate(a, horizontal), channelCoordinate(b, horizontal)), Math.max(channelCoordinate(c, horizontal), channelCoordinate(d, horizontal)));
      // Extend covered prefix without sorting or altering the old route.
      let cursor = lo;
      for (;;) {
        let next = cursor, containsPoint = false;
        for (let k = 1; k < before.length; k++) {
          guard.step();
          const u = before[k - 1], v = before[k];
          if ((horizontal && (u.y !== position || v.y !== position)) || (!horizontal && (u.x !== position || v.x !== position))) continue;
          const left = Math.min(channelCoordinate(u, horizontal), channelCoordinate(v, horizontal));
          const right = Math.max(channelCoordinate(u, horizontal), channelCoordinate(v, horizontal));
          if (left <= cursor + shortcutEpsilon && right >= cursor - shortcutEpsilon) {
            containsPoint = true;
            next = Math.max(next, right);
          }
        }
        if (containsPoint && next >= hi - shortcutEpsilon) break;
        if (next <= cursor + shortcutEpsilon) return false;
        cursor = next;
      }
    }
  }
  return true;
}

export function shortcutPointOnSegment(p, a, b) {
  return ((a.x === b.x && p.x === a.x) || (a.y === b.y && p.y === a.y)) &&
    p.x >= Math.min(a.x, b.x) - shortcutEpsilon && p.x <= Math.max(a.x, b.x) + shortcutEpsilon &&
    p.y >= Math.min(a.y, b.y) - shortcutEpsilon && p.y <= Math.max(a.y, b.y) + shortcutEpsilon;
}

/**
 * For orthogonal segments, overlapping closed bounding boxes mean contact. Unlike line intersection, this also includes positive
 * collinear overlaps.
 */
export function shortcutSegmentsMeet(a, b, c, d) {
  return Math.max(Math.min(a.x, b.x), Math.min(c.x, d.x)) <= Math.min(Math.max(a.x, b.x), Math.max(c.x, d.x)) &&
    Math.max(Math.min(a.y, b.y), Math.min(c.y, d.y)) <= Math.min(Math.max(a.y, b.y), Math.max(c.y, d.y));
}

/**
 * Classify the whole route at a contact. Joining the two rays is equivalent to removing harmless collinear subdivisions, without touching
 * source slices. Segment-local endpoint tests miss a through-crossing at such a subdivision. Returns [horizontalThrough, verticalThrough].
 */
export function shortcutThroughRays(points, p, guard) {
  let left = false, right = false, above = false, below = false;
  for (let i = 1; i < points.length; i++) {
    guard.step();
    const a = points[i - 1], b = points[i];
    if (!shortcutPointOnSegment(p, a, b)) continue;
    if (a.y === b.y) {
      left = left || Math.min(a.x, b.x) < p.x;
      right = right || Math.max(a.x, b.x) > p.x;
    } else {
      above = above || Math.min(a.y, b.y) < p.y;
      below = below || Math.max(a.y, b.y) > p.y;
    }
  }
  return [left && right, above && below];
}

/**
 * A new parallel leg must retain min(previous gap,40) to every projected node wall, including container walls. With no old parallel leg
 * on that side of the wall, require40. Existing short port approaches are handled separately.
 */
export function shortcutWallClearance(g, before, a, b, guard) {
  const horizontal = a.y === b.y;
  const position = channelCoordinate(a, !horizontal);
  const lo = Math.min(channelCoordinate(a, horizontal), channelCoordinate(b, horizontal));
  const hi = Math.max(channelCoordinate(a, horizontal), channelCoordinate(b, horizontal));
  for (const n of g.nodes) {
    guard.step();
    const nlo = channelCoordinate(n.topLeft, horizontal);
    let nhi = nlo + n.height;
    let wall = n.topLeft.x;
    let walls = [wall, wall + n.width];
    if (horizontal) {
      nhi = nlo + n.width;
      wall = n.topLeft.y;
      walls = [wall, wall + n.height];
    }
    if (Math.min(hi, nhi) - Math.max(lo, nlo) <= shortcutEpsilon) continue;
    for (const w of walls) {
      const gap = Math.abs(position - w);
      if (gap >= segmentSpacingBuffer - shortcutEpsilon) continue;
      let minimum = segmentSpacingBuffer;
      for (let j = 1; j < before.length; j++) {
        guard.step();
        const u = before[j - 1], v = before[j];
        const oldPosition = channelCoordinate(u, !horizontal);
        if (oldPosition !== channelCoordinate(v, !horizontal) || (oldPosition - w) * (position - w) < 0) continue;
        const oldLo = Math.min(channelCoordinate(u, horizontal), channelCoordinate(v, horizontal));
        const oldHi = Math.max(channelCoordinate(u, horizontal), channelCoordinate(v, horizontal));
        if (Math.min(oldHi, nhi) - Math.max(oldLo, nlo) > shortcutEpsilon) minimum = Math.min(minimum, Math.abs(oldPosition - w));
      }
      if (gap + shortcutEpsilon < minimum) return false;
    }
  }
  return true;
}

/**
 * Preserve the channel pass's readable spacing. For each projected parallel segment of another route, retain min(previous positive
 * gap,40); if there was no positive parallel gap, require40. Exact shared geometry is certified by shortcutContactsPreserved and is not
 * used to justify a new narrow corridor.
 */
export function shortcutParallelClearance(g, e, a, b, guard) {
  const horizontal = a.y === b.y;
  const position = channelCoordinate(a, !horizontal);
  const lo = Math.min(channelCoordinate(a, horizontal), channelCoordinate(b, horizontal));
  const hi = Math.max(channelCoordinate(a, horizontal), channelCoordinate(b, horizontal));
  for (const other of g.edges) {
    if (other === e) continue;
    for (let j = 1; j < other.points.length; j++) {
      guard.step();
      const c = other.points[j - 1], d = other.points[j];
      const wall = channelCoordinate(c, !horizontal);
      if (wall !== channelCoordinate(d, !horizontal)) continue;
      const otherLo = Math.min(channelCoordinate(c, horizontal), channelCoordinate(d, horizontal));
      const otherHi = Math.max(channelCoordinate(c, horizontal), channelCoordinate(d, horizontal));
      if (Math.min(hi, otherHi) - Math.max(lo, otherLo) <= shortcutEpsilon) continue;
      const gap = Math.abs(position - wall);
      if (gap <= shortcutEpsilon || gap >= segmentSpacingBuffer - shortcutEpsilon) continue;
      let minimum = segmentSpacingBuffer;
      for (let k = 1; k < e.points.length; k++) {
        guard.step();
        const u = e.points[k - 1], v = e.points[k];
        const oldPosition = channelCoordinate(u, !horizontal);
        if (oldPosition !== channelCoordinate(v, !horizontal)) continue;
        const oldLo = Math.min(channelCoordinate(u, horizontal), channelCoordinate(v, horizontal));
        const oldHi = Math.max(channelCoordinate(u, horizontal), channelCoordinate(v, horizontal));
        const oldGap = Math.abs(oldPosition - wall);
        if (oldGap > shortcutEpsilon && Math.min(oldHi, otherHi) - Math.max(oldLo, otherLo) > shortcutEpsilon) minimum = Math.min(minimum, oldGap);
      }
      if (gap + shortcutEpsilon < minimum) return false;
    }
  }
  return true;
}

export function shortcutLabelBoxes(g, guard) {
  const boxes = [];
  for (const n of g.nodes) {
    guard.add(1 + 4 * g.nodes.length);
    if (n.isInvisible) continue;
    if (n.label !== null && n.label.position !== label.Unset) {
      boxes.push(new geo.Box(n.labelTopLeft(n.label.position, n.label.width, n.label.height), n.label.width, n.label.height));
    }
    if (n.icon !== null && !n.isImage()) {
      const size = n.iconSize(n.icon.position);
      boxes.push(new geo.Box(n.labelTopLeft(n.icon.position, size, size), size, size));
    }
  }
  for (const e of g.edges) {
    guard.add(1 + 3 * e.points.length);
    if (e.isInvisible || e.points.length < 2) continue;
    if (e.label !== null && e.label.position !== label.Unset) {
      boxes.push(new geo.Box(e.labelTopLeft(e.label.position, e.label.width, e.label.height), e.label.width, e.label.height));
    }
    if (e.sourceArrowheadLabel !== null) boxes.push(labeling.positionArrowheadLabel(e, false, e.points).box);
    if (e.targetArrowheadLabel !== null) boxes.push(labeling.positionArrowheadLabel(e, true, e.points).box);
  }
  return boxes;
}
