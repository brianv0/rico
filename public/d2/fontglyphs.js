// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// The bundled TrueType faces (public/d2/fonts/*.ttf, loaded on demand) and a reader for the parts of them that
// golang.org/x/image/font/sfnt reads when lib/textmeasure measures text with the *original* font (measureFontAdvance,
// measureFontWidth, used for Markdown with characters outside the 353 runes of fonts/metrics.json): the cmap (the widest
// supported subtable, like sfnt's parseCmap), the hmtx advances and the outline point boxes of simple and compound glyphs
// (the same records `go run . fontmetrics` dumps for the atlas runes, see tools/d2ref/fontmetrics.go).

const faces = new Map(); // file name -> Uint8Array
const parsed = new Map(); // file name -> FullFont

/** where the font files are served from (default: fonts/ next to this module) */
let baseURL = new URL('./fonts/', import.meta.url);
export function setFontBaseURL(u) { baseURL = new URL(u, import.meta.url); }

/** Registers a face by file name (for callers that load the bytes themselves). */
export function setFont(file, bytes) { faces.set(file, bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)); parsed.delete(file); }

/** the bytes of a loaded face, or undefined */
export const fontBytes = (file) => faces.get(file);

/** Loads one font file (fetch in browsers, fs in Node). */
export async function loadFont(file) {
  if (faces.has(file)) return;
  const u = new URL(file, baseURL);
  if (typeof process !== 'undefined' && process.versions?.node && u.protocol === 'file:') {
    const fs = await import('node:fs/promises');
    faces.set(file, new Uint8Array(await fs.readFile(u)));
  } else {
    const res = await fetch(u);
    if (!res.ok) throw new Error(`d2svg: cannot load font ${u}: ${res.status}`);
    faces.set(file, new Uint8Array(await res.arrayBuffer()));
  }
}

/** the parsed face of a loaded font file, or null when it is not loaded */
export function fullFont(file) {
  let f = parsed.get(file);
  if (f === undefined) {
    const bytes = faces.get(file);
    if (bytes === undefined) return null;
    f = new FullFont(bytes);
    parsed.set(file, f);
  }
  return f;
}

// platformEncodingWidth of sfnt's cmap.go
function platformEncodingWidth(pid, psid) {
  if (pid === 0) return psid === 3 ? 2 : psid === 4 ? 4 : 0;
  if (pid === 1) return psid === 0 ? 1 : 0;
  if (pid === 3) return psid === 0 || psid === 1 ? 2 : psid === 10 ? 4 : 0;
  return 0;
}

/** The tables of one face, with the lookups textmeasure.js needs (it matches the TTFont class there: upem, ascent, descent, index, scale, glyph). */
export class FullFont {
  constructor(bytes) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.dv = dv;
    const tables = {};
    for (let i = 0, n = dv.getUint16(4); i < n; i++) {
      const o = 12 + 16 * i;
      tables[String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3])] = [dv.getUint32(o + 8), dv.getUint32(o + 12)];
    }
    this.t = tables;
    const head = tables.head[0], hhea = tables.hhea[0], maxp = tables.maxp[0];
    this.upem = dv.getUint16(head + 18);
    this.locFmt = dv.getInt16(head + 50);
    this.numGlyphs = dv.getUint16(maxp + 4);
    this.numHM = dv.getUint16(hhea + 34);
    this.ascent = dv.getInt16(hhea + 4);
    this.descent = dv.getInt16(hhea + 6);
    this.cache = new Map();
    this.cmap = this.parseCmap();
  }

  /** sfnt's parseCmap: the first of the widest supported subtables; returns a rune -> glyph index function (0 = missing) */
  parseCmap() {
    const dv = this.dv, base = this.t.cmap[0];
    let best = null, bestWidth = 0;
    for (let i = 0, n = dv.getUint16(base + 2); i < n; i++) {
      const o = base + 4 + 8 * i;
      const width = platformEncodingWidth(dv.getUint16(o), dv.getUint16(o + 2));
      if (width <= bestWidth) continue;
      const off = base + dv.getUint32(o + 4);
      const format = dv.getUint16(off);
      if (!(format === 4 || format === 6 || format === 12 || (format === 0 && dv.getUint16(o) === 1 && dv.getUint16(o + 2) === 0))) continue;
      bestWidth = width;
      best = [off, format];
    }
    if (best === null) throw new Error('sfnt: unsupported cmap encodings');
    const [off, format] = best;
    switch (format) {
      case 0: return (r) => (r >= 0 && r < 256 ? dv.getUint8(off + 6 + r) : 0);
      case 6: {
        const first = dv.getUint16(off + 6), count = dv.getUint16(off + 8);
        return (r) => (r >= first && r < first + count ? dv.getUint16(off + 10 + 2 * (r - first)) : 0);
      }
      case 4: {
        const segX2 = dv.getUint16(off + 6), seg = segX2 / 2;
        const ends = off + 14, starts = ends + segX2 + 2, deltas = starts + segX2, rangeOffs = deltas + segX2;
        return (r) => {
          if (r < 0 || r > 0xffff) return 0;
          let lo = 0, hi = seg;
          while (lo < hi) {
            const m = (lo + hi) >> 1;
            if (r > dv.getUint16(ends + 2 * m)) lo = m + 1; else hi = m;
          }
          if (lo >= seg) return 0;
          const start = dv.getUint16(starts + 2 * lo);
          if (r < start) return 0;
          const ro = dv.getUint16(rangeOffs + 2 * lo);
          if (ro === 0) return (r + dv.getUint16(deltas + 2 * lo)) & 0xffff;
          const p = rangeOffs + 2 * lo + ro + 2 * (r - start);
          const g = dv.getUint16(p);
          return g === 0 ? 0 : (g + dv.getUint16(deltas + 2 * lo)) & 0xffff;
        };
      }
      default: { // 12
        const nGroups = dv.getUint32(off + 12), g0 = off + 16;
        return (r) => {
          let lo = 0, hi = nGroups;
          while (lo < hi) {
            const m = (lo + hi) >> 1;
            const o = g0 + 12 * m;
            if (r > dv.getUint32(o + 4)) lo = m + 1;
            else if (r < dv.getUint32(o)) hi = m;
            else return dv.getUint32(o + 8) + (r - dv.getUint32(o));
          }
          return 0;
        };
      }
    }
  }

  /** Font.scale: x divided by fUnitsPerEm, rounded to the nearest integer */
  scale(x) {
    const half = Math.trunc(this.upem / 2);
    if (x >= 0) x += half; else x -= half;
    return Math.trunc(x / this.upem);
  }

  /** Font.Kern: the bundled faces have no `kern` table */
  kernAt() { return 0; }

  /** GlyphIndex(r) */
  index(r) { return this.cmap(r); }

  /** the glyph record of glyph i as `go run . fontmetrics` dumps it: {a: advance, e: empty, b: [minX, maxX, minY, maxY], c: components}; null when sfnt fails on it */
  glyph(i) {
    let rec = this.cache.get(i);
    if (rec === undefined) {
      try { rec = this.loadRecord(i); } catch (e) { rec = null; }
      this.cache.set(i, rec);
    }
    return rec;
  }

  loadRecord(i) {
    const dv = this.dv;
    if (i < 0 || i >= this.numGlyphs) return null;
    let adv;
    const hmtx = this.t.hmtx[0];
    if (i >= this.numHM) adv = dv.getUint16(hmtx + 4 * (this.numHM - 1));
    else adv = dv.getUint16(hmtx + 4 * i);
    const loca = this.t.loca[0], glyf = this.t.glyf[0];
    let g0, g1;
    if (this.locFmt === 0) { g0 = 2 * dv.getUint16(loca + 2 * i); g1 = 2 * dv.getUint16(loca + 2 * i + 2); } else { g0 = dv.getUint32(loca + 4 * i); g1 = dv.getUint32(loca + 4 * i + 4); }
    const rec = { a: adv };
    if (g0 + 10 > g1) { rec.e = true; return rec; }
    const gl = glyf + g0;
    const ne = dv.getInt16(gl);
    if (ne < 0) {
      let off = gl + 10;
      rec.c = [];
      for (;;) {
        const flags = dv.getUint16(off);
        const c = { g: dv.getUint16(off + 2) };
        if (flags & 1) { c.dx = dv.getInt16(off + 4); c.dy = dv.getInt16(off + 6); off += 8; } else { c.dx = dv.getInt8(off + 4); c.dy = dv.getInt8(off + 5); off += 6; }
        if (!(flags & 2)) throw new Error('compound glyph transform vector');
        if (flags & 8) { const t = dv.getInt16(off); c.t = [t, 0, 0, t]; off += 2; } else if (flags & 64) { c.t = [dv.getInt16(off), 0, 0, dv.getInt16(off + 2)]; off += 4; } else if (flags & 128) {
          c.t = [dv.getInt16(off), dv.getInt16(off + 2), dv.getInt16(off + 4), dv.getInt16(off + 6)]; off += 8;
        }
        rec.c.push(c);
        if (!(flags & 32)) break;
      }
      return rec;
    }
    let offset = gl + 10, last = 0;
    for (let k = 0; k < ne; k++) { last = 1 + dv.getUint16(offset); offset += 2; }
    offset += 2 + dv.getUint16(offset);
    if (ne > 0) {
      const flags = [];
      while (flags.length < last) {
        const c = dv.getUint8(offset++);
        flags.push(c);
        if (c & 8) for (let cnt = dv.getUint8(offset++); cnt > 0; cnt--) flags.push(c);
      }
      const wrap16 = (v) => (v << 16) >> 16; // int16 arithmetic
      const xs = new Array(last), ys = new Array(last);
      let x = 0;
      for (let k = 0; k < last; k++) {
        const f = flags[k];
        if (f & 2) { const dx = dv.getUint8(offset++); x = wrap16(f & 16 ? x + dx : x - dx); } else if (!(f & 16)) { x = wrap16(x + dv.getInt16(offset)); offset += 2; }
        xs[k] = x;
      }
      let y = 0;
      for (let k = 0; k < last; k++) {
        const f = flags[k];
        if (f & 4) { const dy = dv.getUint8(offset++); y = wrap16(f & 32 ? y + dy : y - dy); } else if (!(f & 32)) { y = wrap16(y + dv.getInt16(offset)); offset += 2; }
        ys[k] = y;
      }
      rec.b = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    }
    return rec;
  }
}
