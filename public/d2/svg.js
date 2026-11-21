// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of D2's lib/svg package (github.com/d2lang/d2 v0.9.0, Copyright 2022 Terrastruct Inc.):
// the SVG path builder the shapes use, path splitting, and XML escaping / ids.

import { Point, Segment, BezierCurve, euclideanDistance, newPoint } from './geo.js';
import { goRound, float32, goV, goFixed, goLog10 } from './gomath.js';

// ---- number.go ----

/**
 * FormatFloat serializes an SVG coordinate with the same six decimal places as %f, but omits redundant trailing zeros. Keeping
 * the original rounding is important: formatting the full float or reducing precision changes geometry.
 */
export function formatFloat(value) {
  // Most laid-out coordinates are integers. The upper bound is exclusive because float64(math.MaxInt64) rounds up to 2^63.
  if (value >= -(2 ** 63) && value < 2 ** 63) {
    const integer = Math.trunc(value);
    if (value === integer) {
      if (integer === 0 && Object.is(value, -0)) return '-0';
      return BigInt(integer).toString();
    }
  }
  let s = goFixed(value, 6);
  if (s.includes('.')) {
    s = s.replace(/0+$/, '');
    if (s.endsWith('.')) s = s.slice(0, -1);
  }
  return s;
}

// ---- path.go ----

// TODO probably use math.Big
function chopPrecision(f) {
  // bring down to float32 precision before rounding for consistency across architectures
  const result = goRound(float32(f * 10000) / 10000);
  // Ensure negative zero becomes positive zero
  if (result === 0) return 0;
  return result;
}

/**
 * PathCommandKind identifies one of the renderer-neutral path operations produced by SvgPathContext. SvgPathContext
 * normalizes horizontal and vertical SVG commands to PathCommandLine so consumers only need to handle absolute move, line,
 * cubic, and close operations.
 */
export const PathCommandMove = 0, PathCommandLine = 1, PathCommandCubic = 2, PathCommandClose = 3;

/** PathCommand contains absolute path geometry. End is used by move, line, and cubic commands; Control1 and Control2 by cubic ones. */
const zeroPoint = () => newPoint(0, 0);
const pathCommand = (Kind, Control1, Control2, End) => ({ Kind, Control1: Control1 ?? zeroPoint(), Control2: Control2 ?? zeroPoint(), End: End ?? zeroPoint() });

export class SvgPathContext {
  constructor(tl, sx, sy) {
    this.Path = [];
    this.Commands = [];
    this.commands = [];
    this.Start = null;
    this.Current = null;
    this.TopLeft = tl.copy();
    this.ScaleX = sx;
    this.ScaleY = sy;
  }
  relative(base, dx, dy) { return newPoint(chopPrecision(base.x + this.ScaleX * dx), chopPrecision(base.y + this.ScaleY * dy)); }
  absolute(x, y) { return this.relative(this.TopLeft, x, y); }

  startAt(p) {
    this.Start = p;
    this.Commands.push(`M ${goV(p.x)} ${goV(p.y)}`);
    this.commands.push(pathCommand(PathCommandMove, null, null, p.copy()));
    this.Current = p.copy();
  }
  Z() {
    this.Path.push(new Segment(this.Current.copy(), this.Start.copy()));
    this.Commands.push('Z');
    this.commands.push(pathCommand(PathCommandClose));
    this.Current = this.Start.copy();
  }
  L(isLowerCase, x, y) {
    let endPoint;
    if (isLowerCase) endPoint = this.relative(this.Current, x, y);
    else endPoint = this.absolute(x, y);
    this.Path.push(new Segment(this.Current.copy(), endPoint));
    this.Commands.push(`L ${goV(endPoint.x)} ${goV(endPoint.y)}`);
    this.commands.push(pathCommand(PathCommandLine, null, null, endPoint.copy()));
    this.Current = endPoint.copy();
  }
  C(isLowerCase, x1, y1, x2, y2, x3, y3) {
    const p = (x, y) => (isLowerCase ? this.relative(this.Current, x, y) : this.absolute(x, y));
    const points = [this.Current.copy(), p(x1, y1), p(x2, y2), p(x3, y3)];
    this.Path.push(new BezierCurve(points));
    this.Commands.push(`C ${goV(points[1].x)} ${goV(points[1].y)} ${goV(points[2].x)} ${goV(points[2].y)} ${goV(points[3].x)} ${goV(points[3].y)}`);
    this.commands.push(pathCommand(PathCommandCubic, points[1].copy(), points[2].copy(), points[3].copy()));
    this.Current = points[3].copy();
  }
  H(isLowerCase, x) {
    let endPoint;
    if (isLowerCase) {
      endPoint = this.relative(this.Current, x, 0);
    } else {
      endPoint = this.absolute(x, 0);
      endPoint.y = this.Current.y;
    }
    this.Path.push(new Segment(this.Current.copy(), endPoint.copy()));
    this.Commands.push(`H ${goV(endPoint.x)}`);
    this.commands.push(pathCommand(PathCommandLine, null, null, endPoint.copy()));
    this.Current = endPoint.copy();
  }
  V(isLowerCase, y) {
    let endPoint;
    if (isLowerCase) {
      endPoint = this.relative(this.Current, 0, y);
    } else {
      endPoint = this.absolute(0, y);
      endPoint.x = this.Current.x;
    }
    this.Path.push(new Segment(this.Current.copy(), endPoint));
    this.Commands.push(`V ${goV(endPoint.y)}`);
    this.commands.push(pathCommand(PathCommandLine, null, null, endPoint.copy()));
    this.Current = endPoint.copy();
  }
  /** PathCommands returns a defensive copy of the absolute typed path commands. */
  pathCommands() {
    return this.commands.map((c) => ({ Kind: c.Kind, Control1: c.Control1.copy(), Control2: c.Control2.copy(), End: c.End.copy() }));
  }
  pathData() { return this.Commands.join(' '); }
}
export const newSVGPathContext = (tl, sx, sy) => new SvgPathContext(tl, sx, sy);

/** returns [scaledDashSize, scaledGapSize] */
export function getStrokeDashAttributes(strokeWidth, dashGapSize) {
  // as the stroke width gets thicker, the dash gap gets smaller
  const scale = goLog10(-0.6 * strokeWidth + 10.6) * 0.5 + 0.5;
  const scaledDashSize = strokeWidth * dashGapSize;
  const scaledGapSize = scale * scaledDashSize;
  return [scaledDashSize, scaledGapSize];
}

/**
 * Given control points p1, p2, p3, p4, calculate the segment of this bezier curve from t0 -> t1 where {0 <= t0 < t1 <= 1}.
 * Uses De Casteljau's algorithm. Returns [q1, q2, q3, q4].
 */
export function bezierCurveSegment(p1, p2, p3, p4, t0, t1) {
  const u0 = 1 - t0, u1 = 1 - t1;

  const q1 = new Point(
    (u0 * u0 * u0) * p1.x + (3 * t0 * u0 * u0) * p2.x + (3 * t0 * t0 * u0) * p3.x + t0 * t0 * t0 * p4.x,
    (u0 * u0 * u0) * p1.y + (3 * t0 * u0 * u0) * p2.y + (3 * t0 * t0 * u0) * p3.y + t0 * t0 * t0 * p4.y,
  );
  const q2 = new Point(
    (u0 * u0 * u1) * p1.x + (2 * t0 * u0 * u1 + u0 * u0 * t1) * p2.x + (t0 * t0 * u1 + 2 * u0 * t0 * t1) * p3.x + t0 * t0 * t1 * p4.x,
    (u0 * u0 * u1) * p1.y + (2 * t0 * u0 * u1 + u0 * u0 * t1) * p2.y + (t0 * t0 * u1 + 2 * u0 * t0 * t1) * p3.y + t0 * t0 * t1 * p4.y,
  );
  const q3 = new Point(
    (u0 * u1 * u1) * p1.x + (t0 * u1 * u1 + 2 * u0 * t1 * u1) * p2.x + (2 * t0 * t1 * u1 + u0 * t1 * t1) * p3.x + t0 * t1 * t1 * p4.x,
    (u0 * u1 * u1) * p1.y + (t0 * u1 * u1 + 2 * u0 * t1 * u1) * p2.y + (2 * t0 * t1 * u1 + u0 * t1 * t1) * p3.y + t0 * t1 * t1 * p4.y,
  );
  const q4 = new Point(
    (u1 * u1 * u1) * p1.x + (3 * t1 * u1 * u1) * p2.x + (3 * t1 * t1 * u1) * p3.x + t1 * t1 * t1 * p4.x,
    (u1 * u1 * u1) * p1.y + (3 * t1 * u1 * u1) * p2.y + (3 * t1 * t1 * u1) * p3.y + t1 * t1 * t1 * p4.y,
  );
  return [q1, q2, q3, q4];
}

/** strconv.ParseFloat ignoring the error: 0 when s is not a number */
function parseFloatGo(s) {
  if (s === undefined) return 0;
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return Number(s);
  if (/^[+-]?(inf|infinity)$/i.test(s)) return s[0] === '-' ? -Infinity : Infinity;
  if (/^[+-]?nan$/i.test(s)) return NaN;
  return 0;
}

/** Gets a certain line/curve's SVG path string. offsetIdx and pathData provide the points needed */
function getSVGPathString(pathType, offsetIdx, pathData) {
  const d = (k) => pathData[offsetIdx + k];
  switch (pathType) {
    case 'M': return `M ${d(1)} ${d(2)} `;
    case 'L': return `L ${d(1)} ${d(2)} `;
    case 'C': return `C ${d(1)} ${d(2)} ${d(3)} ${d(4)} ${d(5)} ${d(6)} `;
    case 'S': return `S ${d(1)} ${d(2)} ${d(3)} ${d(4)} `;
    default: throw new Error(`unknown svg path command "${pathData[offsetIdx]}"`);
  }
}

/** Gets how much to increment by on an SVG string to get to the next path command */
function getPathStringIncrement(pathType) {
  switch (pathType) {
    case 'M': return 3;
    case 'L': return 3;
    case 'C': return 7;
    case 'S': return 5;
    default: throw new Error(`unknown svg path command "${pathType}"`);
  }
}

/** This function finds the length of a path in SVG notation */
function pathLength(pathData) {
  let x = 0, y = 0, pathLength = 0;
  let prevPosition = new Point();
  let increment = 0;

  for (let i = 0; i < pathData.length; i += increment) {
    switch (pathData[i]) {
      case 'M':
        x = parseFloatGo(pathData[i + 1]);
        y = parseFloatGo(pathData[i + 2]);
        break;
      case 'L':
        x = parseFloatGo(pathData[i + 1]);
        y = parseFloatGo(pathData[i + 2]);
        pathLength += euclideanDistance(prevPosition.x, prevPosition.y, x, y);
        break;
      case 'C':
        x = parseFloatGo(pathData[i + 5]);
        y = parseFloatGo(pathData[i + 6]);
        pathLength += euclideanDistance(prevPosition.x, prevPosition.y, x, y);
        break;
      case 'S':
        x = parseFloatGo(pathData[i + 3]);
        y = parseFloatGo(pathData[i + 4]);
        pathLength += euclideanDistance(prevPosition.x, prevPosition.y, x, y);
        break;
      default:
        throw new Error(`unknown svg path command "${pathData[i]}"`);
    }
    prevPosition = new Point(x, y);
    increment = getPathStringIncrement(pathData[i]);
  }
  return pathLength;
}

/** Splits an SVG path into two SVG paths, with the first path being ~{percentage}% of the path: [path1, path2] */
export function splitPath(path, percentage) {
  let sumPathLens = 0, curPathLen = 0, x = 0, y = 0;
  let prevPosition = new Point();
  let path1 = '', path2 = '';
  let increment = 0;

  let pastHalf = false;
  const pathData = path.split(' ');
  const pathLen = pathLength(pathData);

  for (let i = 0; i < pathData.length; i += increment) {
    switch (pathData[i]) {
      case 'M':
        x = parseFloatGo(pathData[i + 1]);
        y = parseFloatGo(pathData[i + 2]);
        curPathLen = 0;
        break;
      case 'L':
        x = parseFloatGo(pathData[i + 1]);
        y = parseFloatGo(pathData[i + 2]);
        curPathLen = euclideanDistance(prevPosition.x, prevPosition.y, x, y);
        break;
      case 'C':
        x = parseFloatGo(pathData[i + 5]);
        y = parseFloatGo(pathData[i + 6]);
        curPathLen = euclideanDistance(prevPosition.x, prevPosition.y, x, y);
        break;
      case 'S':
        x = parseFloatGo(pathData[i + 3]);
        y = parseFloatGo(pathData[i + 4]);
        curPathLen = euclideanDistance(prevPosition.x, prevPosition.y, x, y);
        break;
      default:
        throw new Error(`unknown svg path command "${pathData[i]}"`);
    }

    const curPath = getSVGPathString(pathData[i], i, pathData);

    sumPathLens += curPathLen;

    if (pastHalf) { // add to path2
      path2 += curPath;
    } else if (sumPathLens < pathLen * percentage) { // add to path1
      path1 += curPath;
    } else { // transition from path1 -> path2
      const t = (pathLen * percentage - sumPathLens + curPathLen) / curPathLen;
      const f = (v) => goFixed(v, 6);

      switch (pathData[i]) {
        case 'M':
          path2 += `M ${pathData[i + 3]} ${pathData[i + 4]} `;
          break;
        case 'L':
          path1 += `L ${f((x - prevPosition.x) * t + prevPosition.x)} ${f((y - prevPosition.y) * t + prevPosition.y)} `;
          path2 += `M ${f((x - prevPosition.x) * t + prevPosition.x)} ${f((y - prevPosition.y) * t + prevPosition.y)} L ${f(x)} ${f(y)} `;
          break;
        case 'C': {
          const h1x = parseFloatGo(pathData[i + 1]);
          const h1y = parseFloatGo(pathData[i + 2]);
          const h2x = parseFloatGo(pathData[i + 3]);
          const h2y = parseFloatGo(pathData[i + 4]);

          const heading1 = new Point(h1x, h1y);
          const heading2 = new Point(h2x, h2y);
          const nextPoint = new Point(x, y);

          let [q1, q2, q3, q4] = bezierCurveSegment(prevPosition, heading1, heading2, nextPoint, 0, 0.5);
          path1 += `C ${f(q2.x)} ${f(q2.y)} ${f(q3.x)} ${f(q3.y)} ${f(q4.x)} ${f(q4.y)} `;

          [q1, q2, q3, q4] = bezierCurveSegment(prevPosition, heading1, heading2, nextPoint, 0.5, 1);
          path2 += `M ${f(q1.x)} ${f(q1.y)} C ${f(q2.x)} ${f(q2.y)} ${f(q3.x)} ${f(q3.y)} ${f(q4.x)} ${f(q4.y)} `;
          break;
        }
        case 'S':
          // Skip S curves because they are shorter and we can split along the connection to the next path instead
          path1 += `S ${pathData[i + 1]} ${pathData[i + 2]} ${pathData[i + 3]} ${pathData[i + 4]} `;
          path2 += `M ${pathData[i + 3]} ${pathData[i + 4]} `;
          break;
        default:
          throw new Error(`unknown svg path command "${pathData[i]}"`);
      }

      pastHalf = true;
    }

    increment = getPathStringIncrement(pathData[i]);
    prevPosition = new Point(x, y);
  }

  return [path1, path2];
}

// ---- text.go ----

const inCharacterRange = (r) => r === 0x09 || r === 0x0a || r === 0x0d || (r >= 0x20 && r <= 0xd7ff) || (r >= 0xe000 && r <= 0xfffd) || (r >= 0x10000 && r <= 0x10ffff);

/** xml.EscapeText */
export function escapeText(text) {
  let out = '';
  for (const ch of text) {
    const r = ch.codePointAt(0);
    switch (r) {
      case 0x22: out += '&#34;'; break;
      case 0x27: out += '&#39;'; break;
      case 0x26: out += '&amp;'; break;
      case 0x3c: out += '&lt;'; break;
      case 0x3e: out += '&gt;'; break;
      case 0x09: out += '&#x9;'; break;
      case 0x0a: out += '&#xA;'; break;
      case 0x0d: out += '&#xD;'; break;
      default:
        // a lone surrogate is invalid UTF-8 in Go: one U+FFFD byte-width-1 rune
        if (!inCharacterRange(r)) out += '�';
        else out += ch;
    }
  }
  return out;
}

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
/** base32 (standard alphabet, no padding) of the UTF-8 bytes of text */
export function svgID(text) {
  const bytes = new TextEncoder().encode(text);
  let out = '';
  let bits = 0, value = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
