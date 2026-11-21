// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of the Go package d2layouts/d2talalayout/internal/routing (D2 v0.9.0), file(s): route.go.

import { nonNilEquals } from './ovg_edge.js';

/** geo.Point value equality (Go struct comparison `a == b`). */
const pointEq = (a, b) => a.x === b.x && a.y === b.y;

export class Route {
  /** init: { gEdge, ovgNodes, fromPort (a geo.Point VALUE: the Go field is not a pointer), toPort } */
  constructor(init = {}) {
    this.gEdge = init.gEdge ?? null;
    this.ovgNodes = init.ovgNodes ?? null;
    this.fromPort = init.fromPort ?? null;
    this.toPort = init.toPort ?? null;
  }

  createSegmentEndpoints() {
    const points = [];

    points.push(this.ovgNodes[1].point.copy());
    for (let i = 2; i < this.ovgNodes.length - 2; i++) {
      const lastPoint = this.ovgNodes[i - 1].point;
      const currentPoint = this.ovgNodes[i].point;
      const nextPoint = this.ovgNodes[i + 1].point;
      if ((currentPoint.x === lastPoint.x) && (currentPoint.x !== nextPoint.x)) {
        points.push(currentPoint.copy());
      } else if ((currentPoint.y === lastPoint.y) && (currentPoint.y !== nextPoint.y)) {
        points.push(currentPoint.copy());
      }
    }
    points.push(this.ovgNodes[this.ovgNodes.length - 2].point.copy());
    return points;
  }

  /** The entire route is colinear */
  isEntireColinear(from, to) {
    const r = this;
    if (from.y === to.y) {
      const y = from.y;
      let minX = from.x, maxX = to.x;
      if (maxX < minX) { const t = minX; minX = maxX; maxX = t; }
      for (let i = 1; i < r.ovgNodes.length - 2; i++) {
        const rFrom = r.ovgNodes[i], rTo = r.ovgNodes[i + 1];
        if (rFrom.y !== y || rTo.y !== y) return false;
        let rMinX = rFrom.x, rMaxX = rTo.x;
        if (rMaxX < rMinX) { const t = rMinX; rMinX = rMaxX; rMaxX = t; }
        if (rMinX < minX || rMaxX > maxX) return false;
      }
      return true;
    }

    if (from.x === to.x) {
      const x = from.x;
      let minY = from.y, maxY = to.y;
      if (maxY < minY) { const t = minY; minY = maxY; maxY = t; }
      for (let i = 1; i < r.ovgNodes.length - 2; i++) {
        const rFrom = r.ovgNodes[i], rTo = r.ovgNodes[i + 1];
        if (rFrom.x !== x || rTo.x !== x) return false;
        let rMinY = rFrom.y, rMaxY = rTo.y;
        if (rMaxY < rMinY) { const t = rMinY; rMinY = rMaxY; rMaxY = t; }
        if (rMinY < minY || rMaxY > maxY) return false;
      }
      return true;
    }

    return false;
  }

  /**
   * isOpposingColinear returns true if the segment <from, to> spans colinearly in the opposite direction to any segment of the route.
   * This only applies to routes which are directed, otherwise there is no notion of opposite. If the segments share a single
   * endpoint, that doesn't count.
   */
  isOpposingColinear(from, to) {
    const r = this;
    if (!r.gEdge.isDirected()) return false;
    if (from.y === to.y) {
      const y = from.y;
      let minX = from.x, maxX = to.x;
      if (maxX < minX) { const t = minX; minX = maxX; maxX = t; }
      for (let i = 0; i < r.ovgNodes.length - 2; i++) {
        if (r.ovgNodes[i + 1].y !== y) {
          i++;
          continue;
        }
        if (r.ovgNodes[i].y !== y) continue;
        const rFrom = r.ovgNodes[i], rTo = r.ovgNodes[i + 1];
        if (rTo.x !== rFrom.x) {
          if (rFrom.x < rTo.x) {
            if (maxX < rFrom.x || rTo.x < minX) continue;
          } else if (maxX < rTo.x || rFrom.x < minX) {
            continue;
          }

          let rMinX = rFrom.x, rMaxX = rTo.x;
          if (rMaxX < rMinX) { const t = rMinX; rMinX = rMaxX; rMaxX = t; }

          if (rMinX <= from.x && from.x <= rMaxX && (to.x < rMinX || rMaxX < to.x)) {
            if (nonNilEquals(from.point, rFrom.point) || nonNilEquals(from.point, rTo.point)) return false;
          } else if (rMinX <= to.x && to.x <= rMaxX && (from.x < rMinX || rMaxX < from.x)) {
            if (nonNilEquals(to.point, rFrom.point) || nonNilEquals(to.point, rTo.point)) return false;
          }

          if ((rTo.x > rFrom.x) && (to.x < from.x)) return true;
          else if ((rTo.x < rFrom.x) && (to.x > from.x)) return true;
        }
      }
    } else if (from.x === to.x) {
      const x = from.x;
      let minY = from.y, maxY = to.y;
      if (maxY < minY) { const t = minY; minY = maxY; maxY = t; }
      for (let i = 0; i < r.ovgNodes.length - 2; i++) {
        if (r.ovgNodes[i + 1].x !== x) {
          i++;
          continue;
        }
        if (r.ovgNodes[i].x !== x) continue;
        const rFrom = r.ovgNodes[i], rTo = r.ovgNodes[i + 1];

        if (rTo.y !== rFrom.y) {
          if (rFrom.y < rTo.y) {
            if (maxY < rFrom.y || rTo.y < minY) continue;
          } else if (maxY < rTo.y || rFrom.y < minY) {
            continue;
          }

          let rMinY = rFrom.y, rMaxY = rTo.y;
          if (rMaxY < rMinY) { const t = rMinY; rMinY = rMaxY; rMaxY = t; }

          if (rMinY <= from.y && from.y <= rMaxY && (to.y < rMinY || rMaxY < to.y)) {
            if (nonNilEquals(from.point, rFrom.point) || nonNilEquals(from.point, rTo.point)) return false;
          } else if (rMinY <= to.y && to.y <= rMaxY && (from.y < rMinY || rMaxY < from.y)) {
            if (nonNilEquals(to.point, rFrom.point) || nonNilEquals(to.point, rTo.point)) return false;
          }

          if ((rTo.y > rFrom.y) && (to.y < from.y)) return true;
          else if ((rTo.y < rFrom.y) && (to.y > from.y)) return true;
        }
      }
    }

    return false;
  }

  /**
   * A route can swap edges with another route if: the two endpoints are the same nodes; no other edges are using the ports; the two
   * endpoints is not diagonal; the ports that the two routes are connected to on each node are on the same side; not self-route.
   */
  canSwapEdgesGuarded(r2, allRoutes, guard) {
    const r = this;
    if (r.gEdge.from === r.gEdge.to) return false;
    if (r2.gEdge.from === r2.gEdge.to) return false;
    if (!((r.gEdge.from === r2.gEdge.from && r.gEdge.to === r2.gEdge.to) ||
      (r.gEdge.from === r2.gEdge.to && r.gEdge.to === r2.gEdge.from))) {
      return false;
    }

    if (isDiagonalOrientation(r.gEdge.from.orientation(r.gEdge.to))) return false;

    if (r.gEdge.from === r2.gEdge.from && r.gEdge.to === r2.gEdge.to) {
      const o = r.gEdge.from.orientation(r.gEdge.to);
      if (isVerticalOrientation(o)) {
        if (r.fromPort.y !== r2.fromPort.y) return false;
        if (r.toPort.y !== r2.toPort.y) return false;
      }
      if (isHorizontalOrientation(o)) {
        if (r.fromPort.x !== r2.fromPort.x) return false;
        if (r.toPort.x !== r2.toPort.x) return false;
      }
    }

    for (const r3 of allRoutes) {
      if (guard != null) guard.step();
      if (r === r3 || r2 === r3) continue;
      if (pointEq(r.fromPort, r3.fromPort) || pointEq(r.fromPort, r3.toPort)) return false;
      if (pointEq(r.toPort, r3.fromPort) || pointEq(r.toPort, r3.toPort)) return false;
      if (pointEq(r2.fromPort, r3.fromPort) || pointEq(r2.fromPort, r3.toPort)) return false;
      if (pointEq(r2.toPort, r3.fromPort) || pointEq(r2.toPort, r3.toPort)) return false;
    }

    return true;
  }
}

import { isDiagonal as isDiagonalOrientation, isVertical as isVerticalOrientation, isHorizontal as isHorizontalOrientation } from '../../geo.js';

export { pointEq };
