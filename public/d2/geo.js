// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of D2's lib/geo package (oss.terrastruct.com/d2 v0.7.2, Copyright 2022 Terrastruct Inc.).
// Go's math.Sin/Cos/Acos/Atan2/Pow can differ from V8 in the last bit; sqrt, abs, min, max and round do not.

import { goRound, goPow, float32, goV, goFixed, goInt } from './gomath.js';

// ---- math.go ----

export function euclideanDistance(x1, y1, x2, y2) {
  if (x1 === x2) return Math.abs(y1 - y2);
  else if (y1 === y2) return Math.abs(x1 - x2);
  return Math.sqrt((x1 - x2) * (x1 - x2) + (y1 - y2) * (y1 - y2));
}

/** compare a and b and consider them equal if the difference is less than e. */
export function precisionCompare(a, b, e) {
  if (Math.abs(a - b) < e) return 0;
  if (a < b) return -1;
  return 1;
}

/** truncates floats to keep up to 3 digits after the decimal point. */
export const truncateDecimals = (v) => goInt(v * 1000) / 1000; // float64(int(v*1000)) / 1000: int() of NaN or out of range is MinInt64

export function sign(i) {
  if (i < 0) return -1;
  if (i > 0) return 1;
  return 0;
}

// ---- orientation.go ----

export const Orientation = Object.freeze({
  TopLeft: 0, TopRight: 1, BottomLeft: 2, BottomRight: 3, Top: 4, Right: 5, Bottom: 6, Left: 7, NONE: 8,
});
const { TopLeft, TopRight, BottomLeft, BottomRight, Top, Right, Bottom, Left, NONE } = Orientation;
const ORIENTATION_NAMES = ['TopLeft', 'TopRight', 'BottomLeft', 'BottomRight', 'Top', 'Right', 'Bottom', 'Left'];

export const orientationToString = (o) => ORIENTATION_NAMES[o] ?? '';

export function sameSide(o1, o2) {
  const sides = [
    [TopLeft, Top, TopRight],
    [BottomLeft, Bottom, BottomRight],
    [Left, TopLeft, BottomLeft],
    [Right, TopRight, BottomRight],
  ];
  for (const sameSides of sides) {
    if (sameSides.includes(o1) && sameSides.includes(o2)) return true;
  }
  return false;
}
export const isDiagonal = (o) => o === TopLeft || o === TopRight || o === BottomLeft || o === BottomRight;
export const isHorizontal = (o) => o === Left || o === Right;
export const isVertical = (o) => o === Top || o === Bottom;
export function getOpposite(o) {
  switch (o) {
    case TopLeft: return BottomRight;
    case TopRight: return BottomLeft;
    case BottomLeft: return TopRight;
    case BottomRight: return TopLeft;
    case Top: return Bottom;
    case Bottom: return Top;
    case Right: return Left;
    case Left: return Right;
    default: return o;
  }
}

// ---- vector.go ----

/** A N-Dimensional Vector with components (x, y, z, ...) based on the origin. */
export class Vector extends Array {
  addLength(length) { return this.unit().multiply(this.len() + length); }
  add(b) { const c = new Vector(); for (let i = 0; i < this.length; i++) c.push(this[i] + b[i]); return c; }
  minus(b) { const c = new Vector(); for (let i = 0; i < this.length; i++) c.push(this[i] - b[i]); return c; }
  multiply(v) { const c = new Vector(); for (let i = 0; i < this.length; i++) c.push(this[i] * v); return c; }
  /** Go's Vector.Length (Array.length is taken by JS). */
  len() { let sum = 0.0; for (const comp of this) sum += comp * comp; return Math.sqrt(sum); }
  unit() { return this.multiply(1 / this.len()); }
  toPoint() { return new Point(this[0], this[1]); }
  radians() { return float32(Math.atan2(this[1], this[0])); }
  degrees() { return this.radians() * 180 / Math.PI; }
  reverse() { return this.multiply(-1); }
  // keep derived arrays (map/filter/slice) from calling the Array(n) constructor with a number
  static get [Symbol.species]() { return Array; }
}
export const newVector = (...components) => { const v = new Vector(); for (const c of components) v.push(c); return v; };
export const newVectorFromProperties = (length, angleInRadians) => newVector(length * Math.sin(angleInRadians), length * Math.cos(angleInRadians));

const getNormalVector = (x1, y1, x2, y2) => [y1 - y2, x2 - x1];
export function getUnitNormalVector(x1, y1, x2, y2) {
  const [normalX, normalY] = getNormalVector(x1, y1, x2, y2);
  const length = euclideanDistance(x1, y1, x2, y2);
  return [normalX / length, normalY / length];
}

// ---- point.go ----

export class RelativePoint {
  constructor(xPercentage, yPercentage) { this.XPercentage = xPercentage; this.YPercentage = yPercentage; }
}
export const newRelativePoint = (xPercentage, yPercentage) => new RelativePoint(truncateDecimals(xPercentage), truncateDecimals(yPercentage));

export class Point {
  constructor(x = 0, y = 0) { this.x = x; this.y = y; }
  /** Go's (*Point).Equals, nil-safe on both sides: Point.equals(a, b). */
  static equals(p1, p2) {
    if (p1 == null) return p2 == null;
    if (p2 == null) return false;
    return p1.x === p2.x && p1.y === p2.y;
  }
  equals(p2) { return Point.equals(this, p2); }
  compare(p2) {
    const xCompare = sign(this.x - p2.x);
    if (xCompare === 0) return sign(this.y - p2.y);
    return xCompare;
  }
  copy() { return new Point(this.x, this.y); }

  /** orientation of pFrom (this) to pTo */
  getOrientation(pTo) {
    const pFrom = this;
    if (pFrom.y < pTo.y) {
      if (pFrom.x < pTo.x) return TopLeft;
      if (pFrom.x > pTo.x) return TopRight;
      return Top;
    }
    if (pFrom.y > pTo.y) {
      if (pFrom.x < pTo.x) return BottomLeft;
      if (pFrom.x > pTo.x) return BottomRight;
      return Bottom;
    }
    if (pFrom.x < pTo.x) return Left;
    if (pFrom.x > pTo.x) return Right;
    return NONE;
  }
  toString() { return `(${goV(this.x)}, ${goV(this.y)})`; }

  distanceToLine(p1, p2) {
    const a = this.x - p1.x;
    const b = this.y - p1.y;
    const c = p2.x - p1.x;
    const d = p2.y - p1.y;
    const dot = (a * c) + (b * d);
    const lenSq = (c * c) + (d * d);
    let param = -1.0;
    if (lenSq !== 0) param = dot / lenSq;
    let xx, yy;
    if (param < 0.0) { xx = p1.x; yy = p1.y; }
    else if (param > 1.0) { xx = p2.x; yy = p2.y; }
    else { xx = p1.x + (param * c); yy = p1.y + (param * d); }
    const dx = this.x - xx;
    const dy = this.y - yy;
    return Math.sqrt((dx * dx) + (dy * dy));
  }
  /** Moves the given point by Vector. */
  addVector(v) { return this.toVector().add(v).toPoint(); }
  /** Creates a Vector of the size between start and endpoint, pointing to endpoint. */
  vectorTo(endpoint) { return endpoint.toVector().minus(this.toVector()); }
  formattedCoordinates() { return `${Math.trunc(this.x)},${Math.trunc(this.y)}`; }
  /** returns true if point p is on orthogonal segment between points a and b */
  onOrthogonalSegment(a, b) {
    const p = this;
    if (a.x < b.x) { if (p.x < a.x || b.x < p.x) return false; }
    else if (p.x < b.x || a.x < p.x) return false;
    if (a.y < b.y) { if (p.y < a.y || b.y < p.y) return false; }
    else if (p.y < b.y || a.y < p.y) return false;
    return true;
  }
  toVector() { return newVector(this.x, this.y); }
  transpose() { const t = this.x; this.x = this.y; this.y = t; }
  /** point t% of the way between a (this) and b */
  interpolate(b, t) { return newPoint(this.x * (1.0 - t) + b.x * t, this.y * (1.0 - t) + b.y * t); }
  truncateFloat32() { this.x = float32(this.x); this.y = float32(this.y); }
  truncateDecimals() { this.x = truncateDecimals(this.x); this.y = truncateDecimals(this.y); }
}
export const newPoint = (x, y) => new Point(x, y);

/** Points: Go's `type Points []*Point`; functions take a plain array. */
export const Points = {
  equals(ps, other) {
    if (ps == null) return other == null;
    else if (other == null) return false;
    const set = new Set(ps.map((p) => `${p.x},${p.y}`));
    for (const o of other) if (!set.has(`${o.x},${o.y}`)) return false;
    return true;
  },
  getMedian(ps) {
    const xs = ps.map((p) => p.x).sort((a, b) => a - b);
    const ys = ps.map((p) => p.y).sort((a, b) => a - b);
    const middleIndex = Math.trunc(xs.length / 2);
    let medianX = xs[middleIndex];
    let medianY = ys[middleIndex];
    if (xs.length % 2 === 0) {
      medianX += xs[middleIndex - 1];
      medianX /= 2;
      medianY += ys[middleIndex - 1];
      medianY /= 2;
    }
    return new Point(medianX, medianY);
  },
  toString(points) { return points.map((p) => p.toString()).join(', '); },
};

/** point of intersection between line segments u and v (or null if they do not intersect) */
export function intersectionPoint(u0, u1, v0, v1) {
  const udx = u1.x - u0.x;
  const vdx = v1.x - v0.x;
  const uvdx = v0.x - u0.x;
  const udy = u1.y - u0.y;
  const vdy = v1.y - v0.y;
  const uvdy = v0.y - u0.y;

  const denom = (udy * vdx - udx * vdy);
  if (denom === 0) return null; // lines are parallel
  // Cramer's rule
  const s = (vdx * uvdy - vdy * uvdx) / denom;
  const t = (udx * uvdy - udy * uvdx) / denom;
  if (s < 0 || s > 1 || t < 0 || t > 1) return null;
  const intersection = new Point();
  intersection.x = u0.x + goRound(s * udx);
  intersection.y = u0.y + goRound(s * udy);
  return intersection;
}

/** a new array without the points flagged in toRemove */
export function removePoints(points, toRemove) {
  const without = [];
  for (let i = 0; i < points.length; i++) {
    if (toRemove[i]) continue;
    without.push(points[i]);
  }
  return without;
}

// ---- box.go ----

export class Box {
  constructor(tl, width, height) { this.TopLeft = tl; this.Width = width; this.Height = height; }
  copy() { return new Box(this.TopLeft.copy(), this.Width, this.Height); }
  center() { return newPoint(this.TopLeft.x + this.Width / 2, this.TopLeft.y + this.Height / 2); }
  /** true if the segment comes within buffer of the box */
  intersects(s, buffer) {
    const b = this;
    const tl = newPoint(b.TopLeft.x - buffer, b.TopLeft.y - buffer);
    const tr = newPoint(tl.x + b.Width + buffer * 2, tl.y);
    const br = newPoint(tr.x, tr.y + b.Height + buffer * 2);
    const bl = newPoint(tl.x, br.y);
    if (intersectionPoint(s.Start, s.End, tl, tr)) return true;
    if (intersectionPoint(s.Start, s.End, tr, br)) return true;
    if (intersectionPoint(s.Start, s.End, br, bl)) return true;
    if (intersectionPoint(s.Start, s.End, bl, tl)) return true;
    return false;
  }
  intersections(s) {
    const b = this;
    const pts = [];
    const tl = b.TopLeft;
    const tr = newPoint(tl.x + b.Width, tl.y);
    const br = newPoint(tr.x, tr.y + b.Height);
    const bl = newPoint(tl.x, br.y);
    let p;
    if ((p = intersectionPoint(s.Start, s.End, tl, tr))) pts.push(p);
    if ((p = intersectionPoint(s.Start, s.End, tr, br))) pts.push(p);
    if ((p = intersectionPoint(s.Start, s.End, br, bl))) pts.push(p);
    if ((p = intersectionPoint(s.Start, s.End, bl, tl))) pts.push(p);
    return pts;
  }
  toString() { return `{TopLeft: ${this.TopLeft.toString()}, Width: ${goFixed(this.Width, 0)}, Height: ${goFixed(this.Height, 0)}}`; }
  contains(p) {
    const b = this;
    return !(p.x < b.TopLeft.x || b.TopLeft.x + b.Width < p.x || p.y < b.TopLeft.y || b.TopLeft.y + b.Height < p.y);
  }
  overlaps(b2) {
    const b1 = this;
    return (b1.TopLeft.x < (b2.TopLeft.x + b2.Width)) && ((b1.TopLeft.x + b1.Width) > b2.TopLeft.x) &&
      (b1.TopLeft.y < (b2.TopLeft.y + b2.Height)) && ((b1.TopLeft.y + b1.Height) > b2.TopLeft.y);
  }
}
export const newBox = (tl, width, height) => new Box(tl, width, height);

// ---- spacing.go ----

export class Spacing {
  constructor(Top = 0, Bottom = 0, Left = 0, Right = 0) { this.Top = Top; this.Bottom = Bottom; this.Left = Left; this.Right = Right; }
}

// ---- route.go ----

/** Go's `type Route []*Point`; functions take a plain array of Points. */
export const Route = {
  length(route) {
    let l = 0;
    for (let i = 0; i < route.length - 1; i++) {
      l += euclideanDistance(route[i].x, route[i].y, route[i + 1].x, route[i + 1].y);
    }
    return l;
  },
  /** the point at distance along the route, and the index of the segment it's on: [point, index] */
  getPointAtDistance(route, distance) {
    let remaining = distance;
    let curr, next;
    let length;
    for (let i = 0; i < route.length - 1; i++) {
      curr = route[i]; next = route[i + 1];
      length = euclideanDistance(curr.x, curr.y, next.x, next.y);
      if (remaining <= length) {
        const t = remaining / length;
        return [curr.interpolate(next, t), i];
      }
      remaining -= length;
    }
    // distance > length, so continue with last segment
    return [curr.interpolate(next, 1 + remaining / length), route.length - 2];
  },
  getBoundingBox(route) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of route) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    return [newPoint(minX, minY), newPoint(maxX, maxY)];
  },
};

// ---- segment.go ----

export class Segment {
  constructor(start, end) { this.Start = start; this.End = end; }
  overlaps(otherS, isHorizontal, buffer) {
    const s = this;
    if (isHorizontal) {
      if (Math.min(s.Start.y, s.End.y) - Math.max(otherS.Start.y, otherS.End.y) >= buffer) return false;
      if (Math.min(otherS.Start.y, otherS.End.y) - Math.max(s.Start.y, s.End.y) >= buffer) return false;
      return true;
    }
    if (Math.min(s.Start.x, s.End.x) - Math.max(otherS.Start.x, otherS.End.x) >= buffer) return false;
    if (Math.min(otherS.Start.x, otherS.End.x) - Math.max(s.Start.x, s.End.x) >= buffer) return false;
    return true;
  }
  intersects(otherSegment) { return intersectionPoint(this.Start, this.End, otherSegment.Start, otherSegment.End) != null; }
  toString() { return `${this.Start.toString()} -> ${this.End.toString()}`; }
  intersections(otherSegment) {
    const point = intersectionPoint(this.Start, this.End, otherSegment.Start, otherSegment.End);
    if (!point) return null;
    return [point];
  }
  /** floor and ceil of where the (orthogonal) segment can shift to: [floor, ceil] */
  getBounds(segments, buffer) {
    const segment = this;
    let ceil = Infinity;
    let floor = -Infinity;
    if (segment.Start.x === segment.End.x && segment.Start.y === segment.End.y) return [floor, ceil];
    const isHorizontal = segment.Start.x === segment.End.x;
    for (const otherSegment of segments) {
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
  length() { return euclideanDistance(this.Start.x, this.Start.y, this.End.x, this.End.y); }
  toVector() { return newVector(this.End.x - this.Start.x, this.End.y - this.Start.y); }
}
export const newSegment = (from, to) => new Segment(from, to);

// ---- bezier.go ----

/** How precise should comparisons be, avoid being too precise due to floating point issues */
export const PRECISION = 0.0001;

// Local types replacing gonum: control points of a bezier curve
function newBezierCurveImpl(cp) {
  if (cp.length === 0) return null;
  const c = cp.map((p) => ({ Point: { X: p.X, Y: p.Y }, Control: { X: 0, Y: 0 } }));
  let w;
  for (let i = 0; i < c.length; i++) {
    const p = c[i];
    switch (i) {
      case 0: w = 1; break;
      case 1: w = c.length - 1; break;
      default: w *= (c.length - i) / i;
    }
    c[i].Control.X = p.Point.X * w;
    c[i].Control.Y = p.Point.Y * w;
  }
  return c;
}
function pointAt(c, t) {
  c[0].Point = { ...c[0].Control };
  let u = t;
  for (let i = 0; i < c.length - 1; i++) {
    const p = c[i + 1];
    c[i + 1].Point = { X: p.Control.X * u, Y: p.Control.Y * u };
    u *= t;
  }
  const t1 = 1 - t;
  let tt = t1;
  const p = { ...c[c.length - 1].Point };
  for (let i = c.length - 2; i >= 0; i--) {
    p.X += c[i].Point.X * tt;
    p.Y += c[i].Point.Y * tt;
    tt *= t1;
  }
  return p;
}

export class BezierCurve {
  constructor(points) {
    this.points = points;
    this.curve = newBezierCurveImpl(points.map((p) => ({ X: p.x, Y: p.y })));
  }
  intersections(segment) {
    const bc = this;
    return computeIntersections(
      [bc.points[0].x, bc.points[1].x, bc.points[2].x, bc.points[3].x],
      [bc.points[0].y, bc.points[1].y, bc.points[2].y, bc.points[3].y],
      [segment.Start.x, segment.End.x],
      [segment.Start.y, segment.End.y],
    );
  }
  at(point) { const cp = pointAt(this.curve, point); return newPoint(cp.X, cp.Y); }
}
export const newBezierCurve = (points) => new BezierCurve(points);

export function computeIntersections(px, py, lx, ly) {
  const out = [];
  const A = ly[1] - ly[0];
  const B = lx[0] - lx[1];
  const C = lx[0] * (ly[0] - ly[1]) + ly[0] * (lx[1] - lx[0]);

  const bx = bezierCoeffs(px[0], px[1], px[2], px[3]);
  const by = bezierCoeffs(py[0], py[1], py[2], py[3]);

  const P = [0, 0, 0, 0];
  P[0] = A * bx[0] + B * by[0];
  P[1] = A * bx[1] + B * by[1];
  P[2] = A * bx[2] + B * by[2];
  P[3] = A * bx[3] + B * by[3] + C;

  const r = cubicRoots(P);

  for (let i = 0; i < 3; i++) {
    const t = r[i];
    const point = new Point(
      bx[0] * t * t * t + bx[1] * t * t + bx[2] * t + bx[3],
      by[0] * t * t * t + by[1] * t * t + by[2] * t + by[3],
    );
    let s;
    if ((lx[1] - lx[0]) !== 0) s = (point.x - lx[0]) / (lx[1] - lx[0]);
    else s = (point.y - ly[0]) / (ly[1] - ly[0]);

    const tLT0 = precisionCompare(t, 0, PRECISION) < 0;
    const tGT1 = precisionCompare(t, 1, PRECISION) > 0;
    const sLT0 = precisionCompare(s, 0, PRECISION) < 0;
    const sGT1 = precisionCompare(s, 1, PRECISION) > 0;
    if (!(tLT0 || tGT1 || sLT0 || sGT1)) out.push(point);
  }
  return out;
}

function cubicRoots(P) {
  if (precisionCompare(P[0], 0, PRECISION) === 0) {
    if (precisionCompare(P[1], 0, PRECISION) === 0) {
      let t = [0, 0, 0];
      t[0] = -1 * (P[3] / P[2]);
      t[1] = -1;
      t[2] = -1;
      for (let i = 0; i < 1; i++) {
        const tiLT0 = precisionCompare(t[i], 0, PRECISION) < 0;
        const tiGT1 = precisionCompare(t[i], 1, PRECISION) > 0;
        if (tiLT0 || tiGT1) t[i] = -1;
      }
      t = sortSpecial(t);
      return t;
    }

    let DQ = goPow(P[2], 2) - 4 * P[1] * P[3];
    if (precisionCompare(DQ, 0, PRECISION) >= 0) {
      DQ = Math.sqrt(DQ);
      let t = [0, 0, 0];
      t[0] = -1 * ((DQ + P[2]) / (2 * P[1]));
      t[1] = ((DQ - P[2]) / (2 * P[1]));
      t[2] = -1;
      // Go: this loop always returns on its first iteration
      for (let i = 0; i < 2; i++) {
        const tiLT0 = precisionCompare(t[i], 0, PRECISION) < 0;
        const tiGT1 = precisionCompare(t[i], 1, PRECISION) > 0;
        if (tiLT0 || tiGT1) t[i] = -1;
        t = sortSpecial(t);
        return t;
      }
    }
  }

  const a = P[0], b = P[1], c = P[2], d = P[3];
  const A = b / a;
  const B = c / a;
  const C = d / a;

  const Q = (3 * B - goPow(A, 2)) / 9;
  const R = (9 * A * B - 27 * C - 2 * goPow(A, 3)) / 54;
  const D = goPow(Q, 3) + goPow(R, 2);
  let Im;

  let t = [0, 0, 0];
  if (precisionCompare(D, 0, PRECISION) >= 0) {
    const S = sgn(R + Math.sqrt(D)) * Math.pow(Math.abs(R + Math.sqrt(D)), (1 / 3.0));
    const T = sgn(R - Math.sqrt(D)) * Math.pow(Math.abs(R - Math.sqrt(D)), (1 / 3.0));

    t[0] = -A / 3 + (S + T);
    t[1] = -A / 3 - (S + T) / 2;
    t[2] = -A / 3 - (S + T) / 2;
    Im = Math.abs(Math.sqrt(3) * (S - T) / 2);

    if (precisionCompare(Im, 0, PRECISION) !== 0) {
      t[1] = -1;
      t[2] = -1;
    }
  } else {
    const th = Math.acos(R / Math.sqrt(-goPow(Q, 3)));
    t[0] = 2 * Math.sqrt(-Q) * Math.cos(th / 3) - A / 3;
    t[1] = 2 * Math.sqrt(-Q) * Math.cos((th + 2 * Math.PI) / 3) - A / 3;
    t[2] = 2 * Math.sqrt(-Q) * Math.cos((th + 4 * Math.PI) / 3) - A / 3;
    Im = 0.0;
  }

  for (let i = 0; i < 3; i++) {
    const tiLT0 = precisionCompare(t[i], 0, PRECISION) < 0;
    const tiGT1 = precisionCompare(t[i], 1, PRECISION) > 0;
    if (tiLT0 || tiGT1) t[i] = -1;
  }
  t = sortSpecial(t);
  return t;
}

function sortSpecial(a) {
  let flip;
  let temp;
  for (;;) {
    flip = false;
    for (let i = 0; i < a.length - 1; i++) {
      const ai1GTEQ0 = precisionCompare(a[i + 1], 0, PRECISION) >= 0;
      const aiGTai1 = precisionCompare(a[i], a[i + 1], PRECISION) > 0;
      const aiLT0 = precisionCompare(a[i], 0, PRECISION) < 0;
      if ((ai1GTEQ0 && aiGTai1) || (aiLT0 && ai1GTEQ0)) {
        flip = true;
        temp = a[i];
        a[i] = a[i + 1];
        a[i + 1] = temp;
      }
    }
    if (!flip) break;
  }
  return a;
}

const sgn = (x) => (x < 0.0 ? -1 : 1);

function bezierCoeffs(P0, P1, P2, P3) {
  const Z = [0, 0, 0, 0];
  Z[0] = -P0 + 3 * P1 + -3 * P2 + P3;
  Z[1] = 3 * P0 - 6 * P1 + 3 * P2;
  Z[2] = -3 * P0 + 3 * P1;
  Z[3] = P0;
  return Z;
}

// ---- ellipse.go ----

export class Ellipse {
  constructor(center, rx, ry) { this.Center = center; this.Rx = rx; this.Ry = ry; }
  intersections(segment) {
    const e = this;
    const intersections = [];
    const a = e.Rx;
    const b = e.Ry;
    const a2 = a * a;
    const b2 = b * b;
    if (a <= 0 || b <= 0) return null;

    const x1 = segment.Start.x - e.Center.x;
    const y1 = segment.Start.y - e.Center.y;
    const x2 = segment.End.x - e.Center.x;
    const y2 = segment.End.y - e.Center.y;

    // vertical line (avoiding dividing by 0)
    if (x1 === x2) {
      const intersection1 = newPoint(x1, +b * Math.sqrt(a2 - x1 * x1) / a);
      const intersection2 = intersection1.copy();
      intersection2.y *= -1;

      const isPointOnLine = (p) => {
        const ps = [p.y, y1, y2];
        ps.sort((i, j) => i - j);
        return ps[1] === p.y;
      };

      if (isPointOnLine(intersection1)) intersections.push(intersection1);
      // when y = 0, intersection2 will be a duplicate of intersection1
      if (intersection2.y !== 0.0 && isPointOnLine(intersection2)) intersections.push(intersection2);

      for (const p of intersections) {
        p.x += e.Center.x;
        p.y += e.Center.y;
      }
      return intersections;
    }

    // y = mx + c
    const m = (y2 - y1) / (x2 - x1);
    const c = y1 - m * x1;
    const isPointOnLine = (p) => precisionCompare(p.distanceToLine(newPoint(x1, y1), newPoint(x2, y2)), 0, PRECISION) === 0;

    const denom = a2 * m * m + b2;
    const root = Math.sqrt(a2 * b2 * (denom - c * c));

    const intersection1 = newPoint((-m * c * a2 + root) / denom, (c * b2 + m * root) / denom);
    const intersection2 = newPoint((-m * c * a2 - root) / denom, (c * b2 - m * root) / denom);

    if (isPointOnLine(intersection1)) intersections.push(intersection1);
    if (!intersection1.equals(intersection2) && isPointOnLine(intersection2)) intersections.push(intersection2);

    for (const p of intersections) {
      p.x += e.Center.x;
      p.y += e.Center.y;
    }
    return intersections;
  }
}
export const newEllipse = (center, rx, ry) => new Ellipse(center, rx, ry);
