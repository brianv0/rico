// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of the Go package d2layouts/d2talalayout/internal/routing (D2 v0.9.0), file(s): ovg_edge_set.go.
//
// The Go set stores OVGEdge VALUES (struct copies) and keys its duplicate set by the struct (From and To pointers, Distance): here
// the slices hold OVGEdge copies and `edges` is a Map<from, Map<to, Set<distance>>>.

import { intersects } from './geometry.js';
import { chargeSkippedRouteWork } from './work.js';
import { OVGEdge } from './ovg_edge.js';

/** sort.SearchFloat64s: the smallest index i with slice[i] >= val. */
function searchFloat64s(slice, val) {
  let lo = 0, hi = slice.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (!(slice[mid] >= val)) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** sort.Search: the smallest index in [0, n) at which f is true. */
function sortSearch(n, f) {
  let lo = 0, hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (!f(mid)) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Keeps OVG edges as one set for vertical edges and other set of horizontal ones. Can quickly check for intersections/overlaps. */
export class OvgEdgeSet {
  constructor() {
    this.horizontalEdges = new Map(); // Map<float64, OVGEdge[]>
    this.verticalEdges = new Map();
    this.horizontals = [];
    this.verticals = [];
    this.edges = new Map(); // Map<OVGNode, Map<OVGNode, Set<number>>>
  }

  hasEdge(edge) {
    const to = this.edges.get(edge.from);
    if (to === undefined) return false;
    const ds = to.get(edge.to);
    return ds !== undefined && ds.has(edge.distance);
  }

  putEdge(edge) {
    let to = this.edges.get(edge.from);
    if (to === undefined) {
      to = new Map();
      this.edges.set(edge.from, to);
    }
    let ds = to.get(edge.to);
    if (ds === undefined) {
      ds = new Set();
      to.set(edge.to, ds);
    }
    ds.add(edge.distance);
  }

  /** insertSortedFloat64 inserts a value into a sorted slice while maintaining order. */
  insertSortedFloat64(slice, val) {
    const i = searchFloat64s(slice, val);
    if (i < slice.length && slice[i] === val) return; // Already exists
    slice.splice(i, 0, val);
  }

  /** insertSortedEdge inserts an edge into a sorted edge slice while maintaining order. Edges are sorted by their minimum coordinate. */
  insertSortedEdge(edges, edge, isVertical) {
    const getMinCoord = (e) => {
      if (isVertical) {
        if (e.from.y < e.to.y) return e.from.y;
        return e.to.y;
      }
      if (e.from.x < e.to.x) return e.from.x;
      return e.to.x;
    };

    const edgeMinCoord = getMinCoord(edge);

    // Binary search for insertion point
    const i = sortSearch(edges.length, (j) => getMinCoord(edges[j]) >= edgeMinCoord);
    edges.splice(i, 0, edge.copy());
  }

  add(edge) {
    if (this.hasEdge(edge)) return;
    this.putEdge(edge);

    if (edge.isVertical()) {
      if (!this.verticalEdges.has(edge.from.x)) {
        this.verticalEdges.set(edge.from.x, []);
        this.insertSortedFloat64(this.verticals, edge.from.x);
      }
      const edges = this.verticalEdges.get(edge.from.x);
      this.insertSortedEdge(edges, edge, true);
    } else if (edge.isHorizontal()) {
      if (!this.horizontalEdges.has(edge.from.y)) {
        this.horizontalEdges.set(edge.from.y, []);
        this.insertSortedFloat64(this.horizontals, edge.from.y);
      }
      const edges = this.horizontalEdges.get(edge.from.y);
      this.insertSortedEdge(edges, edge, false);
    }
  }

  /**
   * addGuarded reserves every sorted-slice shift before mutating the set. The duplicate lookup itself is also accounted, and a
   * guard failure leaves the set unchanged.
   */
  addGuarded(edge, guard) {
    guard.step();
    if (this.hasEdge(edge)) return;
    if (edge.isVertical()) {
      if (!this.verticalEdges.has(edge.from.x)) guard.add(this.verticals.length + 1);
      const list = this.verticalEdges.get(edge.from.x);
      guard.add((list === undefined ? 0 : list.length) + 1);
    } else if (edge.isHorizontal()) {
      if (!this.horizontalEdges.has(edge.from.y)) guard.add(this.horizontals.length + 1);
      const list = this.horizontalEdges.get(edge.from.y);
      guard.add((list === undefined ? 0 : list.length) + 1);
    }
    this.add(edge);
    guard.check();
  }

  intersectsWithGuarded(edge, guard) {
    return this.intersectsWithChecked(edge, guard);
  }

  intersectsWithChecked(edge, guard) {
    const step = () => {
      if (guard == null) return;
      guard.step();
    };
    if (edge.isHorizontal()) {
      let minX = edge.from.x, maxX = edge.to.x;
      if (maxX < minX) { const t = minX; minX = maxX; maxX = t; }

      // check for overlaps
      for (const e of this.horizontalEdges.get(edge.from.y) ?? []) {
        step();
        if (e.from.x < e.to.x) {
          if (maxX <= e.from.x) {
            // horizontalEdges is ordered by minX, so no following edges have a minX less than this one
            break;
          }
          if (e.to.x <= minX) continue;
        } else {
          if (maxX <= e.to.x) break;
          if (e.from.x <= minX) continue;
        }
        if (!edge.sharePoints(e)) return true;
      }

      const y = edge.from.y;
      // The axes are sorted. Charge the skipped prefix as before, but begin geometry checks at the first line that can cross this segment.
      const start = sortSearch(this.verticals.length, (i) => !(this.verticals[i] < minX));
      chargeSkippedRouteWork(guard, start);
      // check for crossings
      for (let vi = start; vi < this.verticals.length; vi++) {
        const lineCoordinate = this.verticals[vi];
        step();
        // when edge is horizontal, lineCoordinate is the X of vertical lines so we filter out the vertical lines outside the span of
        // edge as they won't intersect; similarly, it happens when edge is vertical and we filter the horizontal ones
        if (lineCoordinate < minX) continue;
        if (maxX < lineCoordinate) break;
        for (const e of this.verticalEdges.get(lineCoordinate) ?? []) {
          step();
          if (e.from.y < e.to.y) {
            if (y < e.from.y) break;
            if (e.to.y < y) continue;
          } else {
            if (y < e.to.y) break;
            if (e.from.y < y) continue;
          }
          if (!edge.sharePoints(e)) return true;
        }
      }
    } else if (edge.isVertical()) {
      let minY = edge.from.y, maxY = edge.to.y;
      if (maxY < minY) { const t = minY; minY = maxY; maxY = t; }
      // check for overlaps
      for (const e of this.verticalEdges.get(edge.from.x) ?? []) {
        step();
        if (e.from.y < e.to.y) {
          if (maxY <= e.from.y) {
            // verticalEdges is ordered by minY, so no following edges have a minY less than this one
            break;
          }
          if (e.to.y <= minY) continue;
        } else {
          if (maxY <= e.to.y) break;
          if (e.from.y <= minY) continue;
        }
        if (!edge.sharePoints(e)) return true;
      }

      const x = edge.from.x;
      const start = sortSearch(this.horizontals.length, (i) => !(this.horizontals[i] < minY));
      chargeSkippedRouteWork(guard, start);
      for (let hi = start; hi < this.horizontals.length; hi++) {
        const lineCoordinate = this.horizontals[hi];
        step();
        if (lineCoordinate < minY) continue;
        if (maxY < lineCoordinate) break;
        for (const e of this.horizontalEdges.get(lineCoordinate) ?? []) {
          step();
          if (e.from.x < e.to.x) {
            if (x < e.from.x) break;
            if (e.to.x < x) continue;
          } else {
            if (x < e.to.x) break;
            if (e.from.x < x) continue;
          }
          if (!edge.sharePoints(e)) return true;
        }
      }
    }
    return false;
  }

  overlappingEdgesGuarded(edge, guard) {
    return this.overlappingEdgesChecked(edge, guard);
  }

  overlappingEdgesChecked(edge, guard) {
    const overlapping = [];
    let maybeOverlap = [];
    if (edge.isVertical()) maybeOverlap = this.verticalEdges.get(edge.from.x) ?? [];
    else if (edge.isHorizontal()) maybeOverlap = this.horizontalEdges.get(edge.from.y) ?? [];

    for (const e of maybeOverlap) {
      if (guard != null) guard.step();
      if (intersects(edge.from.point, edge.to.point, e.from.point, e.to.point)) overlapping.push(e);
    }

    return overlapping;
  }
}

export function newOvgEdgeSet() {
  return new OvgEdgeSet();
}

export { OVGEdge };
