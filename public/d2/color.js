// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of D2's lib/color package (oss.terrastruct.com/d2 v0.7.2, Copyright 2022 Terrastruct Inc.), with
// the parts of github.com/mazznoer/csscolorparser v0.1.5 (MIT) and github.com/lucasb-eyer/go-colorful v1.2.0 (MIT)
// that it uses: Parse, Color.Hsl, Hsl, Clamped and Hex.
//
// Go's `(T, error)` returns become: return T, or throw an Error carrying Go's error message.

import { goTrimSpace, goFields, goFixed, goPow, sha1Hex, parseFloatGo } from './gomath.js';

// ---- csscolorparser ----

const NAMED_CSS = {aliceblue: [240, 248, 255], antiquewhite: [250, 235, 215], aqua: [0, 255, 255], aquamarine: [127, 255, 212], azure: [240, 255, 255], beige: [245, 245, 220], bisque: [255, 228, 196], black: [0, 0, 0], blanchedalmond: [255, 235, 205], blue: [0, 0, 255], blueviolet: [138, 43, 226], brown: [165, 42, 42], burlywood: [222, 184, 135], cadetblue: [95, 158, 160], chartreuse: [127, 255, 0], chocolate: [210, 105, 30], coral: [255, 127, 80], cornflowerblue: [100, 149, 237], cornsilk: [255, 248, 220], crimson: [220, 20, 60], cyan: [0, 255, 255], darkblue: [0, 0, 139], darkcyan: [0, 139, 139], darkgoldenrod: [184, 134, 11], darkgray: [169, 169, 169], darkgreen: [0, 100, 0], darkgrey: [169, 169, 169], darkkhaki: [189, 183, 107], darkmagenta: [139, 0, 139], darkolivegreen: [85, 107, 47], darkorange: [255, 140, 0], darkorchid: [153, 50, 204], darkred: [139, 0, 0], darksalmon: [233, 150, 122], darkseagreen: [143, 188, 143], darkslateblue: [72, 61, 139], darkslategray: [47, 79, 79], darkslategrey: [47, 79, 79], darkturquoise: [0, 206, 209], darkviolet: [148, 0, 211], deeppink: [255, 20, 147], deepskyblue: [0, 191, 255], dimgray: [105, 105, 105], dimgrey: [105, 105, 105], dodgerblue: [30, 144, 255], firebrick: [178, 34, 34], floralwhite: [255, 250, 240], forestgreen: [34, 139, 34], fuchsia: [255, 0, 255], gainsboro: [220, 220, 220], ghostwhite: [248, 248, 255], gold: [255, 215, 0], goldenrod: [218, 165, 32], gray: [128, 128, 128], green: [0, 128, 0], greenyellow: [173, 255, 47], grey: [128, 128, 128], honeydew: [240, 255, 240], hotpink: [255, 105, 180], indianred: [205, 92, 92], indigo: [75, 0, 130], ivory: [255, 255, 240], khaki: [240, 230, 140], lavender: [230, 230, 250], lavenderblush: [255, 240, 245], lawngreen: [124, 252, 0], lemonchiffon: [255, 250, 205], lightblue: [173, 216, 230], lightcoral: [240, 128, 128], lightcyan: [224, 255, 255], lightgoldenrodyellow: [250, 250, 210], lightgray: [211, 211, 211], lightgreen: [144, 238, 144], lightgrey: [211, 211, 211], lightpink: [255, 182, 193], lightsalmon: [255, 160, 122], lightseagreen: [32, 178, 170], lightskyblue: [135, 206, 250], lightslategray: [119, 136, 153], lightslategrey: [119, 136, 153], lightsteelblue: [176, 196, 222], lightyellow: [255, 255, 224], lime: [0, 255, 0], limegreen: [50, 205, 50], linen: [250, 240, 230], magenta: [255, 0, 255], maroon: [128, 0, 0], mediumaquamarine: [102, 205, 170], mediumblue: [0, 0, 205], mediumorchid: [186, 85, 211], mediumpurple: [147, 112, 219], mediumseagreen: [60, 179, 113], mediumslateblue: [123, 104, 238], mediumspringgreen: [0, 250, 154], mediumturquoise: [72, 209, 204], mediumvioletred: [199, 21, 133], midnightblue: [25, 25, 112], mintcream: [245, 255, 250], mistyrose: [255, 228, 225], moccasin: [255, 228, 181], navajowhite: [255, 222, 173], navy: [0, 0, 128], oldlace: [253, 245, 230], olive: [128, 128, 0], olivedrab: [107, 142, 35], orange: [255, 165, 0], orangered: [255, 69, 0], orchid: [218, 112, 214], palegoldenrod: [238, 232, 170], palegreen: [152, 251, 152], paleturquoise: [175, 238, 238], palevioletred: [219, 112, 147], papayawhip: [255, 239, 213], peachpuff: [255, 218, 185], peru: [205, 133, 63], pink: [255, 192, 203], plum: [221, 160, 221], powderblue: [176, 224, 230], purple: [128, 0, 128], rebeccapurple: [102, 51, 153], red: [255, 0, 0], rosybrown: [188, 143, 143], royalblue: [65, 105, 225], saddlebrown: [139, 69, 19], salmon: [250, 128, 114], sandybrown: [244, 164, 96], seagreen: [46, 139, 87], seashell: [255, 245, 238], sienna: [160, 82, 45], silver: [192, 192, 192], skyblue: [135, 206, 235], slateblue: [106, 90, 205], slategray: [112, 128, 144], slategrey: [112, 128, 144], snow: [255, 250, 250], springgreen: [0, 255, 127], steelblue: [70, 130, 180], tan: [210, 180, 140], teal: [0, 128, 128], thistle: [216, 191, 216], tomato: [255, 99, 71], turquoise: [64, 224, 208], violet: [238, 130, 238], wheat: [245, 222, 179], white: [255, 255, 255], whitesmoke: [245, 245, 245], yellow: [255, 255, 0], yellowgreen: [154, 205, 50]};

const clamp0_1 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);
const modulo = (x, y) => ((x % y) + y) % y;

function hueToRgb(n1, n2, h) {
  h = modulo(h, 6);
  if (h < 1) return n1 + ((n2 - n1) * h);
  if (h < 3) return n2;
  if (h < 4) return n1 + ((n2 - n1) * (4 - h));
  return n1;
}

/** h = 0..360; s, l = 0..1; returns [r, g, b] in 0..1 */
function hslToRgb(h, s, l) {
  if (s === 0) return [l, l, l];
  let n2;
  if (l < 0.5) n2 = l * (1 + s);
  else n2 = l + s - (l * s);
  const n1 = 2 * l - n2;
  h /= 60;
  return [clamp0_1(hueToRgb(n1, n2, h + 2)), clamp0_1(hueToRgb(n1, n2, h)), clamp0_1(hueToRgb(n1, n2, h - 2))];
}

function hwbToRgb(hue, white, black) {
  if (white + black >= 1) {
    const gray = white / (white + black);
    return [gray, gray, gray];
  }
  let [r, g, b] = hslToRgb(hue, 1, 0.5);
  r = r * (1 - white - black) + white;
  g = g * (1 - white - black) + white;
  b = b * (1 - white - black) + white;
  return [r, g, b];
}

function hsvToHsl(H, S, V) {
  const h = H;
  let s = S;
  const l = (2 - S) * V / 2;
  if (l !== 0) {
    if (l === 1) s = 0;
    else if (l < 0.5) s = S * V / (l * 2);
    else s = S * V / (2 - l * 2);
  }
  return [h, s, l];
}

function hsvToRgb(H, S, V) {
  const [h, s, l] = hsvToHsl(H, S, V);
  return hslToRgb(h, s, l);
}

function normalizeAngle(t) {
  t = t % 360;
  if (t < 0) t += 360;
  return t;
}

/** R, G, B, A values in the range 0..1 */
export const newColor = (R, G, B, A) => ({ R, G, B, A });

export const fromHsv = (h, s, v, a) => { const [r, g, b] = hsvToRgb(normalizeAngle(h), clamp0_1(s), clamp0_1(v)); return newColor(r, g, b, clamp0_1(a)); };
export const fromHsl = (h, s, l, a) => { const [r, g, b] = hslToRgb(normalizeAngle(h), clamp0_1(s), clamp0_1(l)); return newColor(r, g, b, clamp0_1(a)); };
export const fromHwb = (h, w, b, a) => { const [r, g, bb] = hwbToRgb(normalizeAngle(h), clamp0_1(w), clamp0_1(b)); return newColor(r, g, bb, clamp0_1(a)); };

const fromLinear = (x) => (x >= 0.0031308 ? 1.055 * Math.pow(x, 1.0 / 2.4) - 0.055 : 12.92 * x);
export const fromLinearRGB = (r, g, b, a) => newColor(fromLinear(r), fromLinear(g), fromLinear(b), clamp0_1(a));

export function fromOklab(l, a, b, alpha) {
  const l_ = goPow(l + 0.3963377774 * a + 0.2158037573 * b, 3);
  const m_ = goPow(l - 0.1055613458 * a - 0.0638541728 * b, 3);
  const s_ = goPow(l - 0.0894841775 * a - 1.2914855480 * b, 3);

  const R = 4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_;
  const G = -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_;
  const B = -0.0041960863 * l_ - 0.7034186147 * m_ + 1.7076147010 * s_;

  return fromLinearRGB(R, G, B, alpha);
}

export const fromOklch = (l, c, h, alpha) => fromOklab(l, c * Math.cos(h), c * Math.sin(h), alpha);

const black = newColor(0, 0, 0, 1);

function parseFloat_(s) {
  return parseFloatGo(goTrimSpace(s));
}

/** returns [result, ok, percentage] */
function parsePercentOrFloat(s) {
  if (s.endsWith('%')) {
    const [f, ok] = parseFloat_(s.slice(0, -1));
    if (ok) return [f / 100, true, true];
    return [0, false, true];
  }
  const [f, ok] = parseFloat_(s);
  return [f, ok, false];
}

/** returns [result, ok, percentage] */
function parsePercentOr255(s) {
  if (s.endsWith('%')) {
    const [f, ok] = parseFloat_(s.slice(0, -1));
    if (ok) return [f / 100, true, true];
    return [0, false, true];
  }
  const [f, ok] = parseFloat_(s);
  if (ok) return [f / 255, true, false];
  return [0, false, false];
}

/** result angle in degrees (not normalized): [angle, ok] */
function parseAngle(s) {
  if (s.endsWith('deg')) return parseFloat_(s.slice(0, -3));
  if (s.endsWith('grad')) {
    const [f, ok] = parseFloat_(s.slice(0, -4));
    if (ok) return [f / 400 * 360, true];
    return [0, false];
  }
  if (s.endsWith('rad')) {
    const [f, ok] = parseFloat_(s.slice(0, -3));
    if (ok) return [f / Math.PI * 180, true];
    return [0, false];
  }
  if (s.endsWith('turn')) {
    const [f, ok] = parseFloat_(s.slice(0, -4));
    if (ok) return [f * 360, true];
    return [0, false];
  }
  return parseFloat_(s);
}

/** map t which is in range [a, b] to range [c, d] */
const remap = (t, a, b, c, d) => (t - a) * ((d - c) / (b - a)) + c;

function parseHex(s) {
  const c = { R: 0, G: 0, B: 0, A: 1 };
  let ok = true;
  const hexToByte = (ch) => {
    const b = ch.charCodeAt(0);
    if (b >= 0x30 && b <= 0x39) return b - 0x30;
    if (b >= 0x61 && b <= 0x66) return b - 0x61 + 10;
    ok = false;
    return 0;
  };
  // Go strings are bytes: a multi-byte character makes the length differ
  const bytes = new TextEncoder().encode(s);
  const chars = Array.from(bytes, (x) => String.fromCharCode(x));
  const n = chars.length;
  if (n === 6 || n === 8) {
    c.R = (hexToByte(chars[0]) << 4) + hexToByte(chars[1]);
    c.R /= 255;
    c.G = ((hexToByte(chars[2]) << 4) + hexToByte(chars[3])) / 255;
    c.B = ((hexToByte(chars[4]) << 4) + hexToByte(chars[5])) / 255;
    if (n === 8) c.A = ((hexToByte(chars[6]) << 4) + hexToByte(chars[7])) / 255;
  } else if (n === 3 || n === 4) {
    c.R = (hexToByte(chars[0]) * 17) / 255;
    c.G = (hexToByte(chars[1]) * 17) / 255;
    c.B = (hexToByte(chars[2]) * 17) / 255;
    if (n === 4) c.A = (hexToByte(chars[3]) * 17) / 255;
  } else {
    ok = false;
  }
  return [c, ok];
}

/** csscolorparser.Parse: parses a CSS color string; throws on failure (Go: returns black and an error) */
export function parse(s) {
  const input = s;
  s = goTrimSpace(s.toLowerCase());

  if (s === 'transparent') return newColor(0, 0, 0, 0);

  // Predefined name / keyword
  if (Object.prototype.hasOwnProperty.call(NAMED_CSS, s)) {
    const c = NAMED_CSS[s];
    return newColor(c[0] / 255, c[1] / 255, c[2] / 255, 1);
  }

  // Hexadecimal
  if (s.startsWith('#')) {
    const [c, ok] = parseHex(s.slice(1));
    if (ok) return c;
    throw new Error(`Invalid hex color, ${input}`);
  }

  const op = s.indexOf('(');

  if (op !== -1 && s.endsWith(')')) {
    const fname = goTrimSpace(s.slice(0, op));
    let alpha = 1.0;
    let okA = true;
    s = s.slice(op + 1, s.length - 1);
    s = s.replaceAll(',', ' ');
    s = s.replaceAll('/', ' ');
    const params = goFields(s);

    if (fname === 'rgb' || fname === 'rgba') {
      if (params.length !== 3 && params.length !== 4) throw new Error(`${fname}() format needs 3 or 4 parameters, ${input}`);
      const [r, okR] = parsePercentOr255(params[0]);
      const [g, okG] = parsePercentOr255(params[1]);
      const [b, okB] = parsePercentOr255(params[2]);
      if (params.length === 4) [alpha, okA] = parsePercentOrFloat(params[3]);
      if (okR && okG && okB && okA) return newColor(clamp0_1(r), clamp0_1(g), clamp0_1(b), clamp0_1(alpha));
      throw new Error(`Wrong ${fname}() components, ${input}`);
    } else if (fname === 'hsl' || fname === 'hsla') {
      if (params.length !== 3 && params.length !== 4) throw new Error(`${fname}() format needs 3 or 4 parameters, ${input}`);
      const [h, okH] = parseAngle(params[0]);
      const [s_, okS] = parsePercentOrFloat(params[1]);
      const [l, okL] = parsePercentOrFloat(params[2]);
      if (params.length === 4) [alpha, okA] = parsePercentOrFloat(params[3]);
      if (okH && okS && okL && okA) return fromHsl(h, s_, l, alpha);
      throw new Error(`Wrong ${fname}() components, ${input}`);
    } else if (fname === 'hwb' || fname === 'hwba') {
      if (params.length !== 3 && params.length !== 4) throw new Error(`hwb() format needs 3 or 4 parameters, ${input}`);
      const [H, okH] = parseAngle(params[0]);
      const [W, okW] = parsePercentOrFloat(params[1]);
      const [B, okB] = parsePercentOrFloat(params[2]);
      if (params.length === 4) [alpha, okA] = parsePercentOrFloat(params[3]);
      if (okH && okW && okB && okA) return fromHwb(H, W, B, alpha);
      throw new Error(`Wrong hwb() components, ${input}`);
    } else if (fname === 'hsv' || fname === 'hsva') {
      if (params.length !== 3 && params.length !== 4) throw new Error(`hsv() format needs 3 or 4 parameters, ${input}`);
      const [h, okH] = parseAngle(params[0]);
      const [s_, okS] = parsePercentOrFloat(params[1]);
      const [v, okV] = parsePercentOrFloat(params[2]);
      if (params.length === 4) [alpha, okA] = parsePercentOrFloat(params[3]);
      if (okH && okS && okV && okA) return fromHsv(h, s_, v, alpha);
      throw new Error(`Wrong hsv() components, ${input}`);
    } else if (fname === 'oklab') {
      if (params.length !== 3 && params.length !== 4) throw new Error(`oklab() format needs 3 or 4 parameters, ${input}`);
      const [l, okL] = parsePercentOrFloat(params[0]);
      let [a, okA2, fmtA] = parsePercentOrFloat(params[1]);
      let [b, okB, fmtB] = parsePercentOrFloat(params[2]);
      let okAlpha = true;
      if (params.length === 4) [alpha, okAlpha] = parsePercentOrFloat(params[3]);
      if (okL && okA2 && okB && okAlpha) {
        if (fmtA) a = remap(a, -1.0, 1.0, -0.4, 0.4);
        if (fmtB) b = remap(b, -1.0, 1.0, -0.4, 0.4);
        return fromOklab(Math.max(l, 0), a, b, alpha);
      }
      throw new Error(`Wrong oklab() components, ${input}`);
    } else if (fname === 'oklch') {
      if (params.length !== 3 && params.length !== 4) throw new Error(`oklch() format needs 3 or 4 parameters, ${input}`);
      const [l, okL] = parsePercentOrFloat(params[0]);
      let [c, okC, fmtC] = parsePercentOrFloat(params[1]);
      const [h, okH] = parseAngle(params[2]);
      if (params.length === 4) [alpha, okA] = parsePercentOrFloat(params[3]);
      if (okL && okC && okH && okA) {
        if (fmtC) c = c * 0.4;
        return fromOklch(Math.max(l, 0), Math.max(c, 0), h * Math.PI / 180, alpha);
      }
      throw new Error(`Wrong oklch() components, ${input}`);
    }
  }

  // RGB hexadecimal format without '#' prefix
  const [c2, ok2] = parseHex(s);
  if (ok2) return c2;

  throw new Error(`Invalid color format, ${input}`);
}

// ---- go-colorful ----

const clamp01 = (v) => Math.max(0.0, Math.min(v, 1.0));

/** colorful.Color.Hsl: [h, s, l] */
function colorfulHsl(col) {
  const min = Math.min(Math.min(col.R, col.G), col.B);
  const max = Math.max(Math.max(col.R, col.G), col.B);
  let h, s;
  const l = (max + min) / 2;

  if (min === max) {
    s = 0;
    h = 0;
  } else {
    if (l < 0.5) s = (max - min) / (max + min);
    else s = (max - min) / (2.0 - max - min);

    if (max === col.R) h = (col.G - col.B) / (max - min);
    else if (max === col.G) h = 2.0 + (col.B - col.R) / (max - min);
    else h = 4.0 + (col.R - col.G) / (max - min);

    h *= 60;

    if (h < 0) h += 360;
  }
  return [h, s, l];
}

/** colorful.Hsl */
function colorfulFromHsl(h, s, l) {
  if (s === 0) return { R: l, G: l, B: l };

  let r, g, b;
  let t1, t2, tr, tg, tb;

  if (l < 0.5) t1 = l * (1.0 + s);
  else t1 = l + s - l * s;

  t2 = 2 * l - t1;
  h /= 360;
  tr = h + 1.0 / 3.0;
  tg = h;
  tb = h - 1.0 / 3.0;

  if (tr < 0) tr++;
  if (tr > 1) tr--;
  if (tg < 0) tg++;
  if (tg > 1) tg--;
  if (tb < 0) tb++;
  if (tb > 1) tb--;

  // Red
  if (6 * tr < 1) r = t2 + (t1 - t2) * 6 * tr;
  else if (2 * tr < 1) r = t1;
  else if (3 * tr < 2) r = t2 + (t1 - t2) * (2.0 / 3.0 - tr) * 6;
  else r = t2;

  // Green
  if (6 * tg < 1) g = t2 + (t1 - t2) * 6 * tg;
  else if (2 * tg < 1) g = t1;
  else if (3 * tg < 2) g = t2 + (t1 - t2) * (2.0 / 3.0 - tg) * 6;
  else g = t2;

  // Blue
  if (6 * tb < 1) b = t2 + (t1 - t2) * 6 * tb;
  else if (2 * tb < 1) b = t1;
  else if (3 * tb < 2) b = t2 + (t1 - t2) * (2.0 / 3.0 - tb) * 6;
  else b = t2;

  return { R: r, G: g, B: b };
}

const clampedColor = (c) => ({ R: clamp01(c.R), G: clamp01(c.G), B: clamp01(c.B) });
const hex2 = (v) => (Math.trunc(v * 255.0 + 0.5) & 0xff).toString(16).padStart(2, '0');
const colorfulHex = (col) => `#${hex2(col.R)}${hex2(col.G)}${hex2(col.B)}`;

// ---- color.go ----

const themeColorRegex = /^(N[1-7]|B[1-6]|AA[245]|AB[45])$/;

export const isThemeColor = (colorString) => themeColorRegex.test(colorString);

export function darken(colorString) {
  if (isThemeColor(colorString)) {
    switch (true) {
      case colorString[0] === 'B':
        switch (colorString[1]) {
          case '1': case '2': return B1;
          case '3': return B2;
          case '4': return B3;
          case '5': return B4;
          case '6': return B5;
        }
        break;

      case colorString.slice(0, 2) === 'AA':
        switch (colorString[2]) {
          case '2': case '4': return AA2;
          case '5': return AA4;
        }
        break;

      case colorString.slice(0, 2) === 'AB':
        switch (colorString[2]) {
          case '4': return AB4;
          case '5': return AB5;
        }
        break;

      case colorString[0] === 'N':
        switch (colorString[1]) {
          case '1': case '2': return N1;
          case '3': return N2;
          case '4': return N3;
          case '5': return N4;
          case '6': return N5;
          case '7': return N6;
        }
        break;
    }

    throw new Error(`invalid color "${colorString}"`);
  }

  return darkenCSS(colorString);
}

function darkenCSS(colorString) {
  const c = parse(colorString);
  const [h, s, l] = colorfulHsl({ R: c.R, G: c.G, B: c.B });
  // decrease luminance by 10%
  return colorfulHex(clampedColor(colorfulFromHsl(h, s, l - 0.1)));
}

export function luminanceCategory(colorString) {
  // check if colorString matches the `url('#grad-<sha1-hash>')` format
  // which is used to refer to a <linearGradient> or <radialGradient> element.
  if (isURLGradientID(colorString)) return 'normal';
  const l = luminance(colorString);

  switch (true) {
    case l >= 0.88: return 'bright';
    case l >= 0.55: return 'normal';
    case l >= 0.30: return 'dark';
    default: return 'darker';
  }
}

export function luminance(colorString) {
  const c = parse(colorString);
  // https://stackoverflow.com/a/596243
  return 0.299 * c.R + 0.587 * c.G + 0.114 * c.B;
}

export const N1 = 'N1'; // foreground color
export const N2 = 'N2';
export const N3 = 'N3';
export const N4 = 'N4';
export const N5 = 'N5';
export const N6 = 'N6';
export const N7 = 'N7'; // background color

// Base Colors: used for containers
export const B1 = 'B1';
export const B2 = 'B2';
export const B3 = 'B3';
export const B4 = 'B4';
export const B5 = 'B5';
export const B6 = 'B6';

// Alternative colors A
export const AA2 = 'AA2';
export const AA4 = 'AA4';
export const AA5 = 'AA5';

// Alternative colors B
export const AB4 = 'AB4';
export const AB5 = 'AB5';

// Special
export const Empty = '';
export const None = 'none';

export const newRGB = (Red = 0, Green = 0, Blue = 0) => ({ Red, Green, Blue });

/** https://github.com/go-playground/colors/blob/main/rgb.go#L89 */
export function isLight(c) {
  const r = c.Red, g = c.Green, b = c.Blue;
  const hsp = Math.sqrt(0.299 * goPow(r, 2) + 0.587 * goPow(g, 2) + 0.114 * goPow(b, 2));
  return hsp > 130;
}

/** https://gist.github.com/CraigChilds94/6514edbc6a2db5e434a245487c525c75 */
export function hex2RGB(hex) {
  if (hex.length > 3 && hex[0] === '#') {
    hex = hex.slice(1);
  } else {
    throw new Error(`cannot parse hex color ${hex}`);
  }
  // strconv.ParseUint(hex, 16, 32)
  if (hex === '') throw new Error(`strconv.ParseUint: parsing "": invalid syntax`);
  if (!/^[0-9a-fA-F]+$/.test(hex)) throw new Error(`strconv.ParseUint: parsing "${hex}": invalid syntax`);
  const values = BigInt('0x' + hex);
  if (values > 0xffffffffn) throw new Error(`strconv.ParseUint: parsing "${hex}": value out of range`);
  const v = Number(values);
  return newRGB(Math.floor(v / 65536) & 0xff, Math.floor(v / 256) & 0xff, v & 0xff);
}

// https://www.w3.org/TR/css-color-4/#svg-color
const namedRgbMap = {aliceblue: [240, 248, 255], antiquewhite: [250, 235, 215], aqua: [0, 255, 255], aquamarine: [127, 255, 212], azure: [240, 255, 255], beige: [245, 245, 220], bisque: [255, 228, 196], black: [0, 0, 0], blanchedalmond: [255, 235, 205], blue: [0, 0, 255], blueviolet: [138, 43, 226], brown: [165, 42, 42], burlywood: [222, 184, 135], cadetblue: [95, 158, 160], chartreuse: [127, 255, 0], chocolate: [210, 105, 30], coral: [255, 127, 80], cornflowerblue: [100, 149, 237], cornsilk: [255, 248, 220], crimson: [220, 20, 60], cyan: [0, 255, 255], darkblue: [0, 0, 139], darkcyan: [0, 139, 139], darkgoldenrod: [184, 134, 11], darkgray: [169, 169, 169], darkgreen: [0, 100, 0], darkgrey: [169, 169, 169], darkkhaki: [189, 183, 107], darkmagenta: [139, 0, 139], darkolivegreen: [85, 107, 47], darkorange: [255, 140, 0], darkorchid: [153, 50, 204], darkred: [139, 0, 0], darksalmon: [233, 150, 122], darkseagreen: [143, 188, 143], darkslateblue: [72, 61, 139], darkslategray: [47, 79, 79], darkslategrey: [47, 79, 79], darkturquoise: [0, 206, 209], darkviolet: [148, 0, 211], deeppink: [255, 20, 147], deepskyblue: [0, 191, 255], dimgray: [105, 105, 105], dimgrey: [105, 105, 105], dodgerblue: [30, 144, 255], firebrick: [178, 34, 34], floralwhite: [255, 250, 240], forestgreen: [34, 139, 34], fuchsia: [255, 0, 255], gainsboro: [220, 220, 220], ghostwhite: [248, 248, 255], gold: [255, 215, 0], goldenrod: [218, 165, 32], gray: [128, 128, 128], green: [0, 128, 0], greenyellow: [173, 255, 47], grey: [128, 128, 128], honeydew: [240, 255, 240], hotpink: [255, 105, 180], indianred: [205, 92, 92], indigo: [75, 0, 130], ivory: [255, 255, 240], khaki: [240, 230, 140], lavender: [230, 230, 250], lavenderblush: [255, 240, 245], lawngreen: [124, 252, 0], lemonchiffon: [255, 250, 205], lightblue: [173, 216, 230], lightcoral: [240, 128, 128], lightcyan: [224, 255, 255], lightgoldenrodyellow: [250, 250, 210], lightgray: [211, 211, 211], lightgreen: [144, 238, 144], lightgrey: [211, 211, 211], lightpink: [255, 182, 193], lightsalmon: [255, 160, 122], lightseagreen: [32, 178, 170], lightskyblue: [135, 206, 250], lightslategray: [119, 136, 153], lightslategrey: [119, 136, 153], lightsteelblue: [176, 196, 222], lightyellow: [255, 255, 224], lime: [0, 255, 0], limegreen: [50, 205, 50], linen: [250, 240, 230], magenta: [255, 0, 255], maroon: [128, 0, 0], mediumaquamarine: [102, 205, 170], mediumblue: [0, 0, 205], mediumorchid: [186, 85, 211], mediumpurple: [147, 112, 219], mediumseagreen: [60, 179, 113], mediumslateblue: [123, 104, 238], mediumspringgreen: [0, 250, 154], mediumturquoise: [72, 209, 204], mediumvioletred: [199, 21, 133], midnightblue: [25, 25, 112], muintcream: [245, 255, 250], mistyrose: [255, 228, 225], moccasin: [255, 228, 181], navajowhite: [255, 222, 173], navy: [0, 0, 128], oldlace: [253, 245, 230], olive: [128, 128, 0], olivedrab: [107, 142, 35], orange: [255, 165, 0], orangered: [255, 69, 0], orchid: [218, 112, 214], palegoldenrod: [238, 232, 170], palegreen: [152, 251, 152], paleturquoise: [175, 238, 238], palevioletred: [219, 112, 147], papayawhip: [255, 239, 213], peachpuff: [255, 218, 185], peru: [205, 133, 63], pink: [255, 192, 203], plum: [221, 160, 221], powderblue: [176, 224, 230], purple: [128, 0, 128], red: [255, 0, 0], rebeccapurple: [102, 51, 153], rosybrown: [188, 143, 143], royalblue: [65, 105, 225], saddlebrown: [139, 69, 19], salmon: [250, 128, 114], sandybrown: [244, 164, 96], seagreen: [46, 139, 87], seashell: [255, 245, 238], sienna: [160, 82, 45], silver: [192, 192, 192], skyblue: [135, 206, 235], slateblue: [106, 90, 205], slategray: [112, 128, 144], slategrey: [112, 128, 144], snow: [255, 250, 250], springgreen: [0, 255, 127], steelblue: [70, 130, 180], tan: [210, 180, 140], teal: [0, 128, 128], thistle: [216, 191, 216], tomato: [255, 99, 71], turquoise: [64, 224, 208], violet: [238, 130, 238], wheat: [245, 222, 179], white: [255, 255, 255], whitesmoke: [245, 245, 245], yellow: [255, 255, 0], yellowgreen: [154, 205, 50]};

export function name2RGB(name) {
  const key = name.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(namedRgbMap, key)) {
    const rgb = namedRgbMap[key];
    return newRGB(rgb[0], rgb[1], rgb[2]);
  }
  return newRGB();
}

export const NamedColors = ['currentcolor', 'transparent', 'aliceblue', 'antiquewhite', 'aqua', 'aquamarine', 'azure', 'beige', 'bisque', 'black', 'blanchedalmond', 'blue', 'blueviolet', 'brown', 'burlywood', 'cadetblue', 'chartreuse', 'chocolate', 'coral', 'cornflowerblue', 'cornsilk', 'crimson', 'cyan', 'darkblue', 'darkcyan', 'darkgoldenrod', 'darkgray', 'darkgrey', 'darkgreen', 'darkkhaki', 'darkmagenta', 'darkolivegreen', 'darkorange', 'darkorchid', 'darkred', 'darksalmon', 'darkseagreen', 'darkslateblue', 'darkslategray', 'darkslategrey', 'darkturquoise', 'darkviolet', 'deeppink', 'deepskyblue', 'dimgray', 'dimgrey', 'dodgerblue', 'firebrick', 'floralwhite', 'forestgreen', 'fuchsia', 'gainsboro', 'ghostwhite', 'gold', 'goldenrod', 'gray', 'grey', 'green', 'greenyellow', 'honeydew', 'hotpink', 'indianred', 'indigo', 'ivory', 'khaki', 'lavender', 'lavenderblush', 'lawngreen', 'lemonchiffon', 'lightblue', 'lightcoral', 'lightcyan', 'lightgoldenrodyellow', 'lightgray', 'lightgrey', 'lightgreen', 'lightpink', 'lightsalmon', 'lightseagreen', 'lightskyblue', 'lightslategray', 'lightslategrey', 'lightsteelblue', 'lightyellow', 'lime', 'limegreen', 'linen', 'magenta', 'maroon', 'mediumaquamarine', 'mediumblue', 'mediumorchid', 'mediumpurple', 'mediumseagreen', 'mediumslateblue', 'mediumspringgreen', 'mediumturquoise', 'mediumvioletred', 'midnightblue', 'mintcream', 'mistyrose', 'moccasin', 'navajowhite', 'navy', 'oldlace', 'olive', 'olivedrab', 'orange', 'orangered', 'orchid', 'palegoldenrod', 'palegreen', 'paleturquoise', 'palevioletred', 'papayawhip', 'peachpuff', 'peru', 'pink', 'plum', 'powderblue', 'purple', 'rebeccapurple', 'red', 'rosybrown', 'royalblue', 'saddlebrown', 'salmon', 'sandybrown', 'seagreen', 'seashell', 'sienna', 'silver', 'skyblue', 'slateblue', 'slategray', 'slategrey', 'snow', 'springgreen', 'steelblue', 'tan', 'teal', 'thistle', 'tomato', 'turquoise', 'violet', 'wheat', 'white', 'whitesmoke', 'yellow', 'yellowgreen'];

export const ColorHexRegex = /^#(([0-9a-fA-F]{2}){3}|([0-9a-fA-F]){3})$/;

export function validColor(color) {
  if (isGradient(color)) {
    let gradient;
    try { gradient = parseGradient(color); } catch { return false; }
    for (const colorStop of gradient.ColorStops) {
      try { parse(colorStop.Color); } catch { return false; }
    }
  } else if (!NamedColors.includes(color.toLowerCase()) && !ColorHexRegex.test(color)) {
    return false;
  }
  return true;
}

// ---- gradient.go ----

export const newGradient = () => ({ Type: '', Direction: '', ColorStops: [], ID: '' });

export function parseGradient(cssGradient) {
  cssGradient = goTrimSpace(cssGradient);

  const re = /^(linear-gradient|radial-gradient)\(([^\n]*)\)$/;
  const matches = re.exec(cssGradient);
  if (matches === null) throw new Error('invalid gradient syntax');

  const gradientType = matches[1];
  const params = matches[2];

  const gradient = newGradient();
  gradient.Type = gradientType.endsWith('-gradient') ? gradientType.slice(0, -'-gradient'.length) : gradientType;

  const paramList = splitParams(params);

  if (paramList.length === 0) throw new Error('no parameters in gradient');

  const firstParam = goTrimSpace(paramList[0]);

  if (gradient.Type === 'linear' && (firstParam.endsWith('deg') || firstParam.startsWith('to '))) {
    gradient.Direction = firstParam;
    const colorStops = paramList.slice(1);
    if (colorStops.length === 0) throw new Error('no color stops in gradient');
    gradient.ColorStops = parseColorStops(colorStops);
  } else if (gradient.Type === 'radial' && (firstParam === 'circle' || firstParam === 'ellipse')) {
    gradient.Direction = firstParam;
    const colorStops = paramList.slice(1);
    if (colorStops.length === 0) throw new Error('no color stops in gradient');
    gradient.ColorStops = parseColorStops(colorStops);
  } else {
    gradient.ColorStops = parseColorStops(paramList);
  }
  gradient.ID = uniqueGradientID(cssGradient);

  return gradient;
}

function splitParams(params) {
  const parts = [];
  let buf = '';
  let nesting = 0;

  for (const r of params) {
    switch (r) {
      case ',':
        if (nesting === 0) {
          parts.push(buf);
          buf = '';
          continue;
        }
        break;
      case '(':
        nesting++;
        break;
      case ')':
        if (nesting > 0) nesting--;
        break;
    }
    buf += r;
  }
  if (buf.length > 0) parts.push(buf);
  return parts;
}

function parseColorStops(params) {
  const colorStops = [];
  for (let p of params) {
    p = goTrimSpace(p);
    const parts = goFields(p);

    switch (parts.length) {
      case 1:
        colorStops.push({ Color: parts[0], Position: '' });
        break;
      case 2:
        colorStops.push({ Color: parts[0], Position: parts[1] });
        break;
      default:
        continue;
    }
  }
  return colorStops;
}

export function gradientToSVG(gradient) {
  switch (gradient.Type) {
    case 'linear': return linearGradientToSVG(gradient);
    case 'radial': return radialGradientToSVG(gradient);
    default: return '';
  }
}

export function linearGradientToSVG(gradient) {
  const [x1, y1, x2, y2] = parseLinearGradientDirection(gradient.Direction);

  let sb = '';
  sb += `<linearGradient id="${gradient.ID}" `;
  sb += `x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">`;
  sb += '\n';

  const totalStops = gradient.ColorStops.length;
  gradient.ColorStops.forEach((cs, i) => {
    let offset = cs.Position;
    if (offset === '') {
      const offsetValue = i / (totalStops - 1) * 100;
      offset = `${goFixed(offsetValue, 2)}%`;
    }
    sb += `<stop offset="${offset}" stop-color="${cs.Color}" />`;
    sb += '\n';
  });
  sb += '</linearGradient>';
  return sb;
}

function parseLinearGradientDirection(direction) {
  let x1 = '0%', y1 = '0%', x2 = '0%', y2 = '100%';

  direction = goTrimSpace(direction);
  if (direction.startsWith('to ')) {
    let dir = direction.slice('to '.length);
    dir = goTrimSpace(dir);
    const parts = goFields(dir);
    let xStart = '50%', yStart = '50%';
    let xEnd = '50%', yEnd = '50%';

    let xDirSet = false, yDirSet = false;

    for (const part of parts) {
      switch (part) {
        case 'left':
          xStart = '100%';
          xEnd = '0%';
          xDirSet = true;
          break;
        case 'right':
          xStart = '0%';
          xEnd = '100%';
          xDirSet = true;
          break;
        case 'top':
          yStart = '100%';
          yEnd = '0%';
          yDirSet = true;
          break;
        case 'bottom':
          yStart = '0%';
          yEnd = '100%';
          yDirSet = true;
          break;
      }
    }

    if (!xDirSet) {
      xStart = '50%';
      xEnd = '50%';
    }

    if (!yDirSet) {
      yStart = '50%';
      yEnd = '50%';
    }

    x1 = xStart; y1 = yStart;
    x2 = xEnd; y2 = yEnd;
  } else if (direction.endsWith('deg')) {
    const angleStr = direction.slice(0, -'deg'.length);
    const [angle, ok] = parseFloatGo(goTrimSpace(angleStr));
    if (ok) {
      const cssAngle = angle;
      const svgAngle = (90 - cssAngle) * (Math.PI / 180);

      const x1f = 50.0;
      const y1f = 50.0;
      const x2f = x1f + 50 * Math.cos(svgAngle);
      const y2f = y1f + 50 * Math.sin(svgAngle);

      x1 = `${goFixed(x1f, 2)}%`;
      y1 = `${goFixed(y1f, 2)}%`;
      x2 = `${goFixed(x2f, 2)}%`;
      y2 = `${goFixed(y2f, 2)}%`;
    }
  }

  return [x1, y1, x2, y2];
}

export function radialGradientToSVG(gradient) {
  let sb = '';
  sb += `<radialGradient id="${gradient.ID}">`;
  sb += '\n';
  const totalStops = gradient.ColorStops.length;
  gradient.ColorStops.forEach((cs, i) => {
    let offset = cs.Position;
    if (offset === '') {
      const offsetValue = i / (totalStops - 1) * 100;
      offset = `${goFixed(offsetValue, 2)}%`;
    }
    sb += `<stop offset="${offset}" stop-color="${cs.Color}" />`;
    sb += '\n';
  });
  sb += '</radialGradient>';
  return sb;
}

export function uniqueGradientID(cssGradient) {
  return 'grad-' + sha1Hex(cssGradient);
}

export const GradientRegex = /^(linear|radial)-gradient\(([^\n]+)\)$/;

export const isGradient = (color) => GradientRegex.test(color);

export const URLGradientID = /^url\('#grad-[a-f0-9]{40}'\)$/;

export const isURLGradientID = (color) => URLGradientID.test(color);
