// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of the Go package d2layouts/d2talalayout/internal/routing (D2 v0.9.0), file(s): ovg_edge.go.

export class OVGEdge {
  constructor(from = null, to = null) {
    this.from = from;
    this.to = to;
    this.distance = 0;
  }

  /** Go value copy of an OVGEdge (the edge set stores values). */
  copy() {
    const e = new OVGEdge(this.from, this.to);
    e.distance = this.distance;
    return e;
  }

  isVertical() {
    return this.from.x === this.to.x;
  }

  isHorizontal() {
    return this.from.y === this.to.y;
  }

  sharePoints(other) {
    return (nonNilEquals(this.from.point, other.from.point) ||
      nonNilEquals(this.from.point, other.to.point) ||
      nonNilEquals(this.to.point, other.from.point) ||
      nonNilEquals(this.to.point, other.to.point));
  }
}

export function newOVGEdge(from, to) {
  return new OVGEdge(from, to);
}

/** geo.Point.Equals skipping nil check */
export function nonNilEquals(p1, p2) {
  return p1.x === p2.x && p1.y === p2.y;
}
