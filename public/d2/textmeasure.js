// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of D2's lib/textmeasure package (github.com/d2lang/d2 v0.9.0, Copyright 2022 Terrastruct Inc.),
// itself ported from github.com/faiface/pixel/tree/master/text.
//
// Go measures text with golang.org/x/image/font/opentype (sfnt, no hinting, 72 dpi; v0.7.2 used freetype/truetype) on D2's bundled TTFs. Here the same
// numbers come from fonts/metrics.json, a dump (tools/d2ref `fontmetrics`) of exactly what that path reads per font:
// cmap, hmtx/glyf-derived glyph records (advance, bearings, point bounding box or composite components), kern pairs,
// hhea ascent/descent and unitsPerEm. `loadGlyph` replays sfnt.Font.GlyphBounds (26.6 fixed-point rounding included)
// over those records, and the atlas code below is Go's, line for line. Canvas measureText is never used.

import { newPoint } from './geo.js';
import * as d2fonts from './fonts.js';
import { Graphemes, graphemeClusterCount } from './uniseg.js';
import { utf8Len, isSpace } from './ast.js';
import { parseBody } from './htmlparse.js';
import { inTable, Cf, ODICP, VS, PCM } from './uniprops.js';

export const TAB_SIZE = 4;
export const SIZELESS_FONT_SIZE = 0;
export const CODE_LINE_HEIGHT = 1.3;

/** Runes encompasses ASCII, Latin-1, and geometric shapes like black square */
export const Runes = [];
for (let r = 0x0000; r <= 0x007f; r++) Runes.push(r);
for (let r = 0x0080; r <= 0x00ff; r++) Runes.push(r);
for (let r = 0x25a0; r <= 0x25ff; r++) Runes.push(r);

const REPLACEMENT = 0xfffd;

// ---- fixed.Int26_6 helpers ----

const floor6 = (x) => Math.floor(x / 64); // Int26_6.Floor
const ceil6 = (x) => Math.floor((x + 63) / 64); // Int26_6.Ceil
const i2f = (i) => i / 64;
const fixedI = (i) => i * 64;

// ---- truetype.Font over the dumped tables ----

class TTFont {
  constructor(data) {
    this.upem = data.upem;
    this.ascent = data.ascent;
    this.descent = data.descent;
    this.cmap = data.cmap;
    this.glyphs = data.glyphs;
    this.kern = new Map();
    for (const [a, b, v] of data.kern) this.kern.set(a * 65536 + b, v);
  }
  /** Font.scale: x divided by fUnitsPerEm, rounded to the nearest integer */
  scale(x) {
    const half = Math.trunc(this.upem / 2);
    if (x >= 0) x += half; else x -= half;
    return Math.trunc(x / this.upem);
  }
  /** Font.Index(r); runes whose glyph can't be loaded are absent from the dump */
  index(r) { return this.cmap[r]; }
  hasGlyph(r) { return this.cmap[r] !== undefined; }
  /** the glyph record of glyph i (see fonts/metrics.json) */
  glyph(i) { return this.glyphs[i]; }
  /** Font.Kern(scale, i0, i1) */
  kernAt(scale, i0, i1) {
    const k = this.kern.get(i0 * 65536 + i1);
    if (k === undefined) return 0;
    return this.scale(scale * k);
  }
}

// sfnt.Font.GlyphBounds with font.HintingNone (what x/image/font/opentype, and so D2 v0.9.0's lib/textmeasure/fontface.go, uses).
// The advance is the hmtx advance scaled on its own; the bounds are the bounding box of the glyph's outline points in font units
// (compound glyphs: of their transformed, offset component points), scaled point by point with the Y axis flipped. The hmtx
// bearings, the phantom points and the glyph header box play no part (unlike freetype's GlyphBuf.Load, which v0.7.2 used).
function unitBounds(f, i, depth) {
  if (depth >= 32) throw new Error('sfnt: unsupported compound glyph');
  const rec = f.glyph(i);
  if (!rec) throw new Error('sfnt: cannot load glyph');
  if (rec.e) return null;
  if (!rec.c) return rec.b ? rec.b.slice() : null; // [minX, maxX, minY, maxY]
  let acc = null;
  for (const c of rec.c) {
    let b = unitBounds(f, c.g, depth + 1);
    if (!b) continue;
    if (c.t) {
      if (c.t[1] !== 0 || c.t[2] !== 0) throw new Error('textmeasure: non-diagonal component transform is not supported');
      // tform: (p * t + half) >> 14 for each point; monotone per axis, so the box corners are enough
      const tx = (x) => Math.floor((x * c.t[0] + (1 << 13)) / 16384);
      const ty = (y) => Math.floor((y * c.t[3] + (1 << 13)) / 16384);
      const xs = [tx(b[0]), tx(b[1])], ys = [ty(b[2]), ty(b[3])];
      b = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    }
    b = [b[0] + c.dx, b[1] + c.dx, b[2] + c.dy, b[3] + c.dy];
    acc = acc ? [Math.min(acc[0], b[0]), Math.max(acc[1], b[1]), Math.min(acc[2], b[2]), Math.max(acc[3], b[3])] : b;
  }
  return acc;
}

export function loadGlyph(f, scale, idx) {
  const advanceWidth = f.scale(f.glyph(idx).a * scale);
  const u = unitBounds(f, idx, 0);
  // Y is flipped (OpenType's Y axis points up, the segments' down); f.scale rounds half away from zero, so -scale(y) = scale(-y)
  const bounds = u ? { minX: f.scale(u[0] * scale), minY: -f.scale(u[3] * scale), maxX: f.scale(u[1] * scale), maxY: -f.scale(u[2] * scale) }
    : { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return { advanceWidth, bounds };
}

// ---- atlas.go ----

class Rect {
  constructor(tl, br) { this.tl = tl; this.br = br; }
  w() { return this.br.x - this.tl.x; }
  h() { return this.br.y - this.tl.y; }
  /** norm returns the Rect in normal form */
  norm() {
    return new Rect(
      newPoint(Math.min(this.tl.x, this.br.x), Math.min(this.tl.y, this.br.y)),
      newPoint(Math.max(this.tl.x, this.br.x), Math.max(this.tl.y, this.br.y)),
    );
  }
  union(r2) {
    const r1 = this;
    const r = newRect();
    r.tl.x = Math.min(r1.tl.x, r2.tl.x);
    r.tl.y = Math.min(r1.tl.y, r2.tl.y);
    r.br.x = Math.max(r1.br.x, r2.br.x);
    r.br.y = Math.max(r1.br.y, r2.br.y);
    return r;
  }
}
const newRect = () => new Rect(newPoint(0, 0), newPoint(0, 0));

// fixed.Rectangle26_6
const fEmpty = (r) => r.minX >= r.maxX || r.minY >= r.maxY;
export function fUnion(r, s) {
  if (fEmpty(r)) return s;
  if (fEmpty(s)) return r;
  r = { ...r };
  if (r.minX > s.minX) r.minX = s.minX;
  if (r.minY > s.minY) r.minY = s.minY;
  if (r.maxX < s.maxX) r.maxX = s.maxX;
  if (r.maxY < s.maxY) r.maxY = s.maxY;
  return r;
}

/** the face: truetype.NewFace(ttf, {Size}) with no hinting */
class Face {
  constructor(ttf, size) {
    this.f = ttf;
    this.scale = Math.trunc(0.5 + size * 64);
    this.cache = new Map();
  }
  metrics() {
    const scale = this.scale;
    const fupe = this.f.upem;
    return {
      Height: scale,
      Ascent: Math.ceil(scale * (+this.f.ascent) / fupe),
      Descent: Math.ceil(scale * (-this.f.descent) / fupe),
    };
  }
  kern(r0, r1) {
    const i0 = this.f.index(r0);
    const i1 = this.f.index(r1);
    return this.f.kernAt(this.scale, i0 ?? 0, i1 ?? 0);
  }
  /** GlyphBounds: [bounds {minX,minY,maxX,maxY}, advance, ok] */
  glyphBounds(r) {
    if (!this.f.hasGlyph(r)) return [null, 0, false];
    let g = this.cache.get(r);
    if (!g) { g = loadGlyph(this.f, this.scale, this.f.index(r)); this.cache.set(r, g); }
    return [g.bounds, g.advanceWidth, true];
  }
}

class Atlas {
  /** NewAtlas: the union of the given rune sets (plus the replacement char) from the face */
  constructor(face, runeSets) {
    const seen = new Set();
    const runes = [REPLACEMENT];
    for (const set of runeSets) {
      for (const r of set) {
        if (!seen.has(r)) { runes.push(r); seen.add(r); }
      }
    }

    const [fixedMapping, fixedBounds] = makeSquareMapping(face, runes, fixedI(2));

    const bounds = new Rect(
      newPoint(i2f(fixedBounds.minX), i2f(fixedBounds.minY)),
      newPoint(i2f(fixedBounds.maxX), i2f(fixedBounds.maxY)),
    );

    const mapping = new Map();
    for (const [r, fg] of fixedMapping) {
      mapping.set(r, {
        dot: newPoint(i2f(fg.dotX), bounds.br.y - (i2f(fg.dotY) - bounds.tl.y)),
        frame: new Rect(
          newPoint(i2f(fg.frame.minX), bounds.br.y - (i2f(fg.frame.minY) - bounds.tl.y)),
          newPoint(i2f(fg.frame.maxX), bounds.br.y - (i2f(fg.frame.maxY) - bounds.tl.y)),
        ).norm(),
        advance: i2f(fg.advance),
      });
    }

    this.face = face;
    this.mapping = mapping;
    this.ascent = i2f(face.metrics().Ascent);
    this.descent = i2f(face.metrics().Descent);
    this.lineHeight = i2f(face.metrics().Height);
  }
  contains(r) { return this.mapping.has(r); }
  /** glyph returns the description of r within the atlas */
  glyph(r) { return this.mapping.get(r) ?? { dot: newPoint(0, 0), frame: newRect(), advance: 0 }; }
  /** Kern returns the kerning distance between runes r0 and r1 */
  kern(r0, r1) { return i2f(this.face.kern(r0, r1)); }
  /** DrawRune returns [rect2, frame, bounds, newDot] */
  drawRune(prevR, r, dot) {
    if (!this.contains(r)) r = REPLACEMENT;
    if (!this.contains(REPLACEMENT)) return [newRect(), newRect(), newRect(), dot];
    if (!this.contains(prevR)) prevR = REPLACEMENT;

    if (prevR >= 0) dot.x += this.kern(prevR, r);

    const glyph = this.glyph(r);

    const subbed = newPoint(dot.x - glyph.dot.x, dot.y - glyph.dot.y);

    const rect2 = new Rect(
      newPoint(glyph.frame.tl.x + subbed.x, glyph.frame.tl.y + subbed.y),
      newPoint(glyph.frame.br.x + subbed.x, glyph.frame.br.y + subbed.y),
    );
    let bounds = rect2;

    if (bounds.w() * bounds.h() !== 0) {
      bounds = new Rect(
        newPoint(bounds.tl.x, dot.y - this.descent),
        newPoint(bounds.br.x, dot.y + this.ascent),
      );
    }

    dot.x += glyph.advance;

    return [rect2, glyph.frame, bounds, dot];
  }
}

/** sort.Search */
function sortSearch(n, f) {
  let i = 0, j = n;
  while (i < j) {
    const h = Math.trunc((i + j) / 2);
    if (!f(h)) i = h + 1; else j = h;
  }
  return i;
}

/** finds an optimal glyph arrangement of the given runes, so that their common bounding box is as square as possible */
function makeSquareMapping(face, runes, padding) {
  const width = sortSearch(fixedI(1024 * 1024), (i) => {
    const [, bounds] = makeMapping(face, runes, padding, i);
    return bounds.maxX - bounds.minX >= bounds.maxY - bounds.minY;
  });
  return makeMapping(face, runes, padding, width);
}

/** arranges glyphs of the given runes into rows in such a way, that no glyph is located fully to the right of width */
function makeMapping(face, runes, padding, width) {
  const mapping = new Map();
  let bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  let dotX = 0, dotY = 0;
  const m = face.metrics();

  for (const r of runes) {
    const [b, advance, ok] = face.glyphBounds(r);
    if (!ok) continue;

    // this is important for drawing, artifacts arise otherwise
    let frame = { minX: fixedI(floor6(b.minX)), minY: fixedI(floor6(b.minY)), maxX: fixedI(ceil6(b.maxX)), maxY: fixedI(ceil6(b.maxY)) };

    dotX -= frame.minX;
    frame = { minX: frame.minX + dotX, minY: frame.minY + dotY, maxX: frame.maxX + dotX, maxY: frame.maxY + dotY };

    mapping.set(r, { dotX, dotY, frame, advance });
    bounds = fUnion(bounds, frame);

    dotX = frame.maxX;

    // padding + align to integer
    dotX += padding;
    dotX = fixedI(ceil6(dotX));

    // width exceeded, new row
    if (frame.maxX >= width) {
      dotX = 0;
      dotY += m.Ascent + m.Descent;

      // padding + align to integer
      dotY += padding;
      dotY = fixedI(ceil6(dotY));
    }
  }
  return [mapping, bounds];
}

// ---- metrics loading ----

let defaultMetrics = null;

/** Registers the parsed contents of fonts/metrics.json for newRuler() calls that pass no argument. */
export function setMetrics(m) { defaultMetrics = m; }

/** Loads fonts/metrics.json (next to this file) with fetch in browsers or fs in Node, and registers it. */
export async function loadMetrics(url) {
  const u = url ?? new URL('./fonts/metrics.json', import.meta.url);
  let text;
  if (typeof process !== 'undefined' && process.versions?.node && u.protocol === 'file:') {
    const fs = await import('node:fs/promises');
    text = await fs.readFile(u, 'utf8');
  } else {
    text = await (await fetch(u)).text();
  }
  defaultMetrics = JSON.parse(text);
  return defaultMetrics;
}

// ---- textmeasure.go ----

/** Ruler allows for efficient and convenient text measuring (Go's Ruler, trimmed down to measuring). */
export class Ruler {
  constructor(metrics) {
    const origin = newPoint(0, 0);
    this.Orig = origin;
    this.Dot = origin.copy();
    this.LineHeightFactor = 1.0;
    this.lineHeights = new Map();
    this.tabWidths = new Map();
    this.atlases = new Map();
    this.ttfs = new Map();
    this.fonts = new Map(); // parsed TTFont per metrics key

    this.metrics = metrics;
    this.prevR = -1;
    this.bounds = null;
    this.boundsWithDot = false;

    for (const fontFamily of d2fonts.FontFamilies) {
      for (const fontStyle of d2fonts.FontStyles) {
        const font = d2fonts.font(fontFamily, SIZELESS_FONT_SIZE, fontStyle);
        // Note: FontFaces lookup is size-agnostic
        const key = metrics.faces[`${fontFamily}-${fontStyle}`];
        if (key === undefined) continue;
        const fk = d2fonts.fontKey(font);
        if (!this.ttfs.has(fk)) {
          if (!this.fonts.has(key)) this.fonts.set(key, new TTFont(metrics.fonts[key]));
          this.ttfs.set(fk, this.fonts.get(key));
        }
      }
    }
    this.clear();
  }

  hasFontFamilyLoaded(fontFamily) {
    for (const fontStyle of d2fonts.FontStyles) {
      const font = d2fonts.font(fontFamily, SIZELESS_FONT_SIZE, fontStyle);
      if (!this.ttfs.has(d2fonts.fontKey(font))) return false;
    }
    return true;
  }

  addFontSize(font) {
    const sizeless = { ...font, Size: SIZELESS_FONT_SIZE };
    const ttf = this.ttfs.get(d2fonts.fontKey(sizeless));
    if (!ttf) throw new Error(`textmeasure: font ${font.Family} ${font.Style} is not loaded`);
    const face = new Face(ttf, font.Size);
    const atlas = new Atlas(face, [Runes]);
    const k = d2fonts.fontKey(font);
    this.atlases.set(k, atlas);
    this.lineHeights.set(k, atlas.lineHeight);
    this.tabWidths.set(k, atlas.glyph(0x20).advance * TAB_SIZE);
  }

  scaleUnicode(w, font, s) {
    const t = this;
    // Weird unicode stuff is going on when this is true
    // See https://github.com/rivo/uniseg#grapheme-clusters
    // This method is a good-enough approximation. It overshoots, but not by much.
    if (graphemeClusterCount(s) !== utf8Len(s)) {
      for (const line of s.split('\n')) {
        let [lineW] = t.measurePrecise(font, line);
        const gr = new Graphemes(line);

        const mono = d2fonts.font(d2fonts.SourceCodePro, font.Size, font.Style);
        while (gr.next()) {
          if (gr.width() === 1) continue;
          // For each grapheme which doesn't have width=1, the ruler measured wrongly.
          // So, replace the measured width with a scaled measurement of a monospace version
          let prevRune = 0;
          let dot = t.Orig.copy();
          let b = newRect();
          for (const r of gr.runes()) {
            let control;
            [dot, control] = t.controlRune(r, dot, font);
            if (control) continue;

            let bounds;
            [, , bounds, dot] = t.atlases.get(d2fonts.fontKey(font)).drawRune(prevRune, r, dot);
            b = b.union(bounds);

            prevRune = r;
          }
          lineW -= b.w();
          lineW += t.spaceWidth(mono) * gr.width();
        }
        w = Math.max(w, lineW);
      }
    }
    return w;
  }

  /**
   * scaleUnicodeLegacy preserves the approximation historically used by D2's Markdown box measurement while filtering controls
   * that browsers do not advance. (Native painting uses scaleUnicodeCSS, which is not ported.)
   */
  scaleUnicodeLegacy(w, fontSpec, s) {
    const t = this;
    if (graphemeClusterCount(s) === utf8Len(s)) return w;
    // Preserve the old fallback algorithm (including its original ink width) after removing controls that Blink gives no
    // advance. Uniseg can attach such a control to a visible narrow base (for example x + ZWJ), so filtering only wholly
    // invisible clusters still leaves an atlas replacement glyph. Keep wide emoji/CJK clusters intact: their variation
    // selectors, tags, and joiners can determine the browser's glyph and terminal-cell width.
    const [measurementText, filteredIgnorables] = legacyMeasurementText(s);
    if (filteredIgnorables) w = 0;
    for (const line of measurementText.split('\n')) {
      let [lineW] = t.measurePrecise(fontSpec, line);
      const lineFloor = lineW;
      const graphemes = new Graphemes(line);
      const mono = d2fonts.font(d2fonts.SourceCodePro, fontSpec.Size, fontSpec.Style);
      while (graphemes.next()) {
        if (graphemes.width() === 1) continue;
        let previous = 0;
        let dot = t.Orig.copy();
        let bounds = newRect();
        for (const r of graphemes.runes()) {
          let control;
          [dot, control] = t.controlRune(r, dot, fontSpec);
          if (control) continue;
          let glyphBounds;
          [, , glyphBounds, dot] = t.atlases.get(d2fonts.fontKey(fontSpec)).drawRune(previous, r, dot);
          bounds = bounds.union(glyphBounds);
          previous = r;
        }
        lineW -= bounds.w();
        lineW += t.spaceWidth(mono) * graphemes.width();
      }
      if (filteredIgnorables) lineW = Math.max(lineW, lineFloor);
      w = Math.max(w, lineW);
    }
    return w;
  }

  measureMono(font, s) {
    const originalBoundsWithDot = this.boundsWithDot;
    this.boundsWithDot = true;
    const [width, height] = this.measure(font, s);
    this.boundsWithDot = originalBoundsWithDot;
    return [width, height];
  }

  /** Measure: [width, height] ints */
  measure(font, s) {
    let [w, h] = this.measurePrecise(font, s);
    w = this.scaleUnicode(w, font, s);
    return [Math.ceil(w), Math.ceil(h)];
  }

  /** MeasurePrecise: [width, height] floats */
  measurePrecise(font, s) {
    if (!this.atlases.has(d2fonts.fontKey(font))) this.addFontSize(font);
    this.clear();
    this.drawBuf(font, s);
    const b = this.bounds;
    return [b.w(), b.h()];
  }

  /** clear removes all written text from the Ruler. The Dot field is reset to Orig. */
  clear() {
    this.prevR = -1;
    this.bounds = newRect();
    this.Dot = this.Orig.copy();
  }

  /**
   * controlRune checks if r is a control rune (newline, tab, ...). If it is, a new dot position and
   * true is returned. If r is not a control rune, the original dot and false is returned.
   */
  controlRune(r, dot, font) {
    const txt = this;
    const k = d2fonts.fontKey(font);
    switch (r) {
      case 0x0a: // '\n'
        dot.x = txt.Orig.x;
        dot.y -= txt.LineHeightFactor * txt.lineHeights.get(k);
        break;
      case 0x0d: // '\r'
        dot.x = txt.Orig.x;
        break;
      case 0x09: { // '\t'
        const tabWidth = txt.tabWidths.get(k);
        let rem = (dot.x - txt.Orig.x) % tabWidth; // math.Mod keeps the sign of the dividend, like JS %
        rem = rem % (rem + tabWidth);
        if (rem === 0) rem = tabWidth;
        dot.x += rem;
        break;
      }
      default:
        return [dot, false];
    }
    return [dot, true];
  }

  drawBuf(font, s) {
    const txt = this;
    const atlas = txt.atlases.get(d2fonts.fontKey(font));
    for (const ch of s) {
      let r = ch.codePointAt(0);
      if (r >= 0xd800 && r <= 0xdfff) r = REPLACEMENT; // invalid UTF-8 / lone surrogate decodes to RuneError

      let control;
      [txt.Dot, control] = txt.controlRune(r, txt.Dot, font);
      if (control) continue;

      let bounds;
      [, , bounds, txt.Dot] = atlas.drawRune(txt.prevR, r, txt.Dot);

      txt.prevR = r;

      if (txt.boundsWithDot) {
        txt.bounds = txt.bounds.union(new Rect(txt.Dot, txt.Dot));
        txt.bounds = txt.bounds.union(bounds);
      } else if (txt.bounds.w() * txt.bounds.h() === 0) {
        txt.bounds = bounds;
      } else {
        txt.bounds = txt.bounds.union(bounds);
      }
    }
  }

  spaceWidth(font) {
    if (!this.atlases.has(d2fonts.fontKey(font))) this.addFontSize(font);
    return this.atlases.get(d2fonts.fontKey(font)).glyph(0x20).advance;
  }
}

function legacyMeasurementText(s) {
  let out = '';
  let filtered = false;
  const graphemes = new Graphemes(s);
  while (graphemes.next()) {
    const runes = graphemes.runes();
    if (isDefaultIgnorableGrapheme(runes)) {
      filtered = true;
      continue;
    }
    if (graphemes.width() !== 1) {
      out += String.fromCodePoint(...runes);
      continue;
    }
    for (const r of runes) {
      if (isDefaultIgnorableRune(r)) {
        filtered = true;
        continue;
      }
      out += String.fromCodePoint(r);
    }
  }
  if (!filtered) return [s, false];
  return [out, true];
}

function isDefaultIgnorableGrapheme(runes) {
  for (const r of runes) if (!isDefaultIgnorableRune(r)) return false;
  return runes.length > 0;
}

export function isDefaultIgnorableRune(r) {
  // Blink gives most format controls and variation selectors no advance, but renders several controls and Unicode "default
  // ignorables" through fallback fonts. Follow that observed behavior instead of erasing the whole derived Unicode property.
  if (r === 0x00ad || // conditional; handled by line wrapping
    r === 0x180f || // Mongolian free variation selector four has fallback ink in Blink
    r === 0x3164 || r === 0xffa0 || // visibly advancing Hangul fillers
    (r >= 0xfff9 && r <= 0xfffb) || // interlinear annotations
    (r >= 0x13430 && r <= 0x1343f) || // Egyptian hieroglyph format controls
    (r >= 0x1bca0 && r <= 0x1bca3) || // visibly advancing shorthand controls
    inTable(PCM, r) ||
    (r < 0x10000 && isSpace(String.fromCharCode(r)))) return false;
  return inTable(Cf, r) || inTable(ODICP, r) || inTable(VS, r);
}

/** NewRuler. Needs the font metrics: pass the parsed metrics.json, or call loadMetrics()/setMetrics() first. */
export function newRuler(metrics) {
  const m = metrics ?? defaultMetrics;
  if (!m) throw new Error('textmeasure: font metrics not loaded (await loadMetrics() or setMetrics(json) first)');
  return new Ruler(m);
}

// ---- d2graph.GetTextDimensions / GetTextDimensionsWithMono (d2graph/d2graph.go) ----
// They live in d2graph upstream; they are here because they are the only callers of the ruler's plain-text paths.

/** d2graph.findMeasured: dimensions of an already measured identical text, or null */
export function findMeasured(mtexts, t1) {
  for (const t2 of mtexts ?? []) {
    if (t1.text !== t2.text) continue;
    if (t1.fontSize !== t2.fontSize) continue;
    if (t1.isBold !== t2.isBold) continue;
    if (t1.isItalic !== t2.isItalic) continue;
    if (t1.language !== t2.language) continue;
    return t2.dimensions;
  }
  return null;
}

export const newTextDimensions = (w, h) => ({ width: w, height: h });

const goTrimSpace = (s) => { let a = 0, b = s.length; while (a < b && isSpace(s[a])) a++; while (b > a && isSpace(s[b - 1])) b--; return s.slice(a, b); };
const isBlankLine = (s) => goTrimSpace(s) === '';

export function getTextDimensions(mtexts, ruler, t, fontFamily) {
  return getTextDimensionsWithMono(mtexts, ruler, t, fontFamily, null);
}

/** t is an MText ({text, fontSize, isBold, isItalic, language, ...}); returns {width, height} or null */
export function getTextDimensionsWithMono(mtexts, ruler, t, fontFamily, monoFontFamily) {
  const dims = findMeasured(mtexts, t);
  if (dims) return dims;

  if (ruler) {
    let w, h;
    if (t.language !== '' && t.language != null) {
      const originalLineHeight = ruler.LineHeightFactor;
      ruler.LineHeightFactor = CODE_LINE_HEIGHT;
      if (monoFontFamily != null) {
        [w, h] = ruler.measureMono(d2fonts.font(monoFontFamily, t.fontSize, d2fonts.FONT_STYLE_REGULAR), t.text);
      } else {
        [w, h] = ruler.measureMono(d2fonts.font(d2fonts.SourceCodePro, t.fontSize, d2fonts.FONT_STYLE_REGULAR), t.text);
      }
      ruler.LineHeightFactor = originalLineHeight;

      // count empty leading and trailing lines since ruler will not be able to measure it
      const lines = t.text.split('\n');
      let hasLeading = false;
      if (lines.length > 0 && isBlankLine(lines[0])) hasLeading = true;
      let numTrailing = 0;
      for (let i = lines.length - 1; i >= 0; i--) {
        if (isBlankLine(lines[i])) numTrailing++;
        else break;
      }
      if (hasLeading && numTrailing < lines.length) h += t.fontSize;
      h += Math.ceil(CODE_LINE_HEIGHT * (t.fontSize * numTrailing));
    } else {
      let style = d2fonts.FONT_STYLE_REGULAR;
      if (t.isBold) style = d2fonts.FONT_STYLE_BOLD;
      else if (t.isItalic) style = d2fonts.FONT_STYLE_ITALIC;
      if (fontFamily == null) fontFamily = d2fonts.SourceSansPro;
      [w, h] = ruler.measure(d2fonts.font(fontFamily, t.fontSize, style), t.text);
    }
    return newTextDimensions(w, h);
  }
  return null;
}

// ---- links.go / markdown.go ----

let markdownRenderer = null;

/**
 * Registers the markdown-it constructor (`markdownit` from the npm package, or the global of
 * public/vendor/markdown-it.min.js). Go renders with goldmark (Unsafe, XHTML, Strikethrough and Table extensions),
 * so markdown-it is configured to match: html and xhtmlOut on, no linkify/typographer, any link scheme allowed.
 */
export function setMarkdownIt(markdownit) {
  const md = markdownit({ html: true, xhtmlOut: true, linkify: false, typographer: false, breaks: false });
  md.validateLink = () => true;
  // goldmark keeps every numeric character reference that names a Unicode scalar value (control characters included, so
  // `&#6;` renders a raw U+0006, which d2compiler's XML check then rejects); markdown-it replaces the control ones with U+FFFD.
  md.inline.ruler.before('entity', 'numeric_entity', (state, silent) => {
    const pos = state.pos;
    if (state.src.charCodeAt(pos) !== 0x26 || pos + 1 >= state.posMax || state.src.charCodeAt(pos + 1) !== 0x23) return false;
    const match = state.src.slice(pos).match(/^&#((?:x[a-f0-9]{1,6}|[0-9]{1,7}));/i);
    if (!match) return false;
    if (!silent) {
      const code = match[1][0].toLowerCase() === 'x' ? parseInt(match[1].slice(1), 16) : parseInt(match[1], 10);
      const token = state.push('text_special', '', 0);
      token.content = code > 0 && code <= 0x10FFFF && !(code >= 0xD800 && code <= 0xDFFF) ? String.fromCodePoint(code) : '\uFFFD';
      token.markup = match[0];
      token.info = 'entity';
    }
    state.pos += match[0].length;
    return true;
  });
  // goldmark's strikethrough extension renders <del>
  md.renderer.rules.s_open = () => '<del>';
  md.renderer.rules.s_close = () => '</del>';
  // goldmark 1.8: table cell alignment is the `align` attribute (markdown-it: a style), and a blockquote always has a line
  // break after its opening tag.
  const alignCell = (tokens, idx, options, env, self) => {
    const t = tokens[idx];
    const m = /^text-align:(left|right|center)$/.exec(t.attrGet('style') || '');
    if (m) { t.attrs = t.attrs.filter((a) => a[0] !== 'style'); t.attrSet('align', m[1]); }
    return self.renderToken(tokens, idx, options);
  };
  md.renderer.rules.th_open = alignCell;
  md.renderer.rules.td_open = alignCell;
  md.renderer.rules.blockquote_open = () => '<blockquote>\n';
  // goldmark renders a line break after a tight list item's text when a block follows it (markdown-it only does that for
  // blocks drawn by renderToken), and gives an unterminated fenced code block at the end of the input its final newline.
  const afterHidden = (rule) => (tokens, idx, options, env, self) => (idx > 0 && tokens[idx - 1].hidden ? '\n' : '') + rule(tokens, idx, options, env, self);
  const rules = md.renderer.rules;
  rules.code_block = afterHidden(rules.code_block);
  rules.html_block = afterHidden(rules.html_block);
  const fence = rules.fence;
  rules.fence = afterHidden((tokens, idx, options, env, self) => {
    const t = tokens[idx];
    if (t.content !== '' && !t.content.endsWith('\n')) t.content += '\n';
    return fence(tokens, idx, options, env, self);
  });
  // goldmark 1.8 strips the leading whitespace of a paragraph's continuation lines before parsing its inlines (markdown-it keeps
  // it, which shows inside code spans).
  for (const name of ['paragraph', 'lheading']) {
    const fn = md.block.ruler.__rules__.find((r) => r.name === name).fn;
    const alt = md.block.ruler.__rules__.find((r) => r.name === name).alt;
    md.block.ruler.at(name, (state, startLine, endLine, silent) => {
      const before = state.tokens.length;
      const ok = fn(state, startLine, endLine, silent);
      if (ok && !silent) for (let i = before; i < state.tokens.length; i++) if (state.tokens[i].type === 'inline') state.tokens[i].content = state.tokens[i].content.replace(/\n[ \t]+/g, '\n');
      return ok;
    }, { alt });
  }
  // goldmark 1.8: a closing </pre> alone on a line does not start an HTML block (CommonMark: start condition 7 excludes pre).
  const htmlBlock = md.block.ruler.__rules__.find((r) => r.name === 'html_block').fn;
  md.block.ruler.at('html_block', (state, startLine, endLine, silent) => {
    const pos = state.bMarks[startLine] + state.tShift[startLine];
    if (/^<\/pre\s*>\s*$/i.test(state.src.slice(pos, state.eMarks[startLine]))) return false;
    return htmlBlock(state, startLine, endLine, silent);
  }, { alt: ['paragraph', 'reference', 'blockquote'] });
  markdownRenderer = md;
}

export function sanitizeLinks(input) {
  const re = /href="([^"]*)"/g;
  return input.replace(re, (href, value) => {
    value = value.replaceAll('&amp;', 'TEMP_AMP');
    value = value.replaceAll('&', '&amp;');
    value = value.replaceAll('TEMP_AMP', '&amp;');
    return `href="${value}"`;
  });
}

export function renderMarkdown(m) {
  if (!markdownRenderer) {
    if (globalThis.markdownit) setMarkdownIt(globalThis.markdownit);
    else throw new Error('textmeasure: markdown-it not registered (call setMarkdownIt(markdownit))');
  }
  return sanitizeLinks(markdownRenderer.render(m));
}

// these are css values from github-markdown.css so we can accurately compute the rendered dimensions
export const MarkdownFontSize = d2fonts.FONT_SIZE_M;
export const MarkdownLineHeight = 1.5;

const PaddingLeft_ul_ol_em = 2.;
const MarginBottom_ul = 16.;

const MarginTop_li_p = 16.;
const MarginTop_li_em = 0.25;
const MarginBottom_p = 16.;

const LineHeight_h = 1.25;
const MarginTop_h = 24;
const MarginBottom_h = 16;
const PaddingBottom_h1_h2_em = 0.3;
const BorderBottom_h1_h2 = 1;

const Height_hr_em = 0.25;
const MarginTopBottom_hr = 24;

const Padding_pre = 16;
const MarginBottom_pre = 16;
const LineHeight_pre = 1.45;
const FontSize_pre_code_em = 0.85;

const PaddingTopBottom_code_em = 0.2;
const PaddingLeftRight_code_em = 0.4;

const PaddingLR_blockquote_em = 1.;
const MarginBottom_blockquote = 16;
const BorderLeft_blockquote_em = 0.25;

const h1_em = 2.;
const h2_em = 1.5;
const h3_em = 1.25;
const h4_em = 1.;
const h5_em = 0.875;
const h6_em = 0.85;

export function headerToFontSize(baseFontSize, header) {
  switch (header) {
    case 'h1': return Math.trunc(h1_em * baseFontSize);
    case 'h2': return Math.trunc(h2_em * baseFontSize);
    case 'h3': return Math.trunc(h3_em * baseFontSize);
    case 'h4': return Math.trunc(h4_em * baseFontSize);
    case 'h5': return Math.trunc(h5_em * baseFontSize);
    case 'h6': return Math.trunc(h6_em * baseFontSize);
  }
  return 0;
}

/** The error of validateMarkdownSVGNodes: D2 v0.9.0 paints Markdown as native SVG, which supports a subset of HTML. */
export class MarkdownError extends Error {
  constructor(message) { super(message); this.name = 'MarkdownError'; }
}

const markdownSVGElements = new Set(['html', 'head', 'body',
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'blockquote', 'ul', 'ol', 'li', 'pre', 'code',
  'em', 'b', 'strong', 'del', 's', 'strike', 'a', 'br', 'hr', 'img',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th']);

function validateMarkdownSVGNodes(n) {
  if (n.type === 'element') {
    if (!markdownSVGElements.has(n.data)) throw new MarkdownError(`native Markdown SVG does not support HTML element <${n.data}>`);
  }
  for (let child = n.firstChild; child != null; child = child.nextSibling) validateMarkdownSVGNodes(child);
}

/**
 * MeasureMarkdown: [width, height] ints. D2 v0.9.0 calls LayoutMarkdown (lib/textmeasure/markdown_svg.go), whose dimensions are
 * the legacy box model below (the native SVG painting that shares that code belongs to the renderer). Throws MarkdownError when
 * the HTML has an element native SVG does not support.
 */
export function measureMarkdown(mdText, ruler, fontFamily, monoFontFamily, fontSize) {
  const render = renderMarkdown(mdText);
  const bodyNode = parseBody(render);
  validateMarkdownSVGNodes(bodyNode);

  const originalLineHeight = ruler.LineHeightFactor;
  ruler.boundsWithDot = true;
  ruler.LineHeightFactor = MarkdownLineHeight;
  try {
    // TODO consider setting a max width + (manual) text wrapping
    const bodyAttrs = ruler.measureNode(0, bodyNode, fontFamily, monoFontFamily, fontSize, d2fonts.FONT_STYLE_REGULAR);
    return [Math.ceil(bodyAttrs.width), Math.ceil(bodyAttrs.height)];
  } finally {
    ruler.LineHeightFactor = originalLineHeight;
    ruler.boundsWithDot = false;
  }
}

function hasPrev(n) {
  if (n.prevSibling == null) return false;
  if (goTrimSpace(n.prevSibling.data) === '') return hasPrev(n.prevSibling);
  return true;
}

function hasNext(n) {
  if (n.nextSibling == null) return false;
  // skip over empty text nodes
  if (goTrimSpace(n.nextSibling.data) === '') return hasNext(n.nextSibling);
  return true;
}

function getNext(n) {
  if (n == null) return null;
  if (goTrimSpace(n.data) === '') {
    const next = getNext(n.nextSibling);
    if (next != null) return next;
  }
  return n;
}

function getPrev(n) {
  if (n == null) return null;
  if (goTrimSpace(n.data) === '') {
    const next = getNext(n.prevSibling);
    if (next != null) return next;
  }
  return n;
}

function isBlockElement(elType) {
  switch (elType) {
    case 'blockquote': case 'div': case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': case 'hr':
    case 'li': case 'ol': case 'p': case 'pre': case 'ul':
    case 'table': case 'thead': case 'tbody': case 'tr': case 'td': case 'th': // Added table elements here
      return true;
    default:
      return false;
  }
}

function hasAncestorElement(n, elType) {
  if (n.parent == null) return false;
  if (n.parent.type === 'element' && n.parent.data === elType) return true;
  return hasAncestorElement(n.parent, elType);
}

const newBlock = () => ({ width: 0, height: 0, marginTop: 0, marginBottom: 0, extraData: null });
const blockIsNotEmpty = (b) => b != null && !(b.width === 0 && b.height === 0 && b.marginTop === 0 && b.marginBottom === 0 && b.extraData == null);

const trimCutset = (s) => s.replace(/^[\n\t\b]+|[\n\t\b]+$/g, '');

/** measures node dimensions to match rendering with styles in github-markdown.css */
Ruler.prototype.measureNode = function measureNode(depth, n, fontFamily, monoFontFamily, fontSize, fontStyle) {
  const ruler = this;
  if (fontFamily == null) fontFamily = d2fonts.SourceSansPro;
  const font = d2fonts.font(fontFamily, fontSize, fontStyle);

  let parentElementType = '';
  if (n.parent != null && n.parent.type === 'element') parentElementType = n.parent.data;

  switch (n.type) {
    case 'text': {
      if (trimCutset(n.data) === '') return newBlock();
      let str = n.data;
      const isCode = parentElementType === 'pre' || parentElementType === 'code';
      let spaceWidths = 0.;

      if (!isCode) {
        const spaceWidth = ruler.spaceWidth(font);
        // MeasurePrecise will not include leading or trailing whitespace, so we account for it here
        str = str.replaceAll('\n', ' ');
        str = str.replaceAll('\t', ' ');
        if (str.startsWith(' ')) {
          // consecutive leading/trailing spaces end up rendered as a single space
          str = str.slice(1);
          if (hasPrev(n)) spaceWidths += spaceWidth;
        }
        if (str.endsWith(' ')) {
          str = str.slice(0, -1);
          if (hasNext(n)) spaceWidths += spaceWidth;
        }
      } else if (str === '') {
        return newBlock();
      }

      let restore = null;
      if (parentElementType === 'pre') {
        const originalLineHeight = ruler.LineHeightFactor;
        ruler.LineHeightFactor = LineHeight_pre;
        restore = () => { ruler.LineHeightFactor = originalLineHeight; };
      }
      try {
        let [w, h] = ruler.measurePrecise(font, str);
        if (isCode) {
          w *= FontSize_pre_code_em;
          h *= FontSize_pre_code_em;
        } else {
          // The browser-era Markdown measurer applied its Unicode fallback correction only to proportional text.
          w = ruler.scaleUnicodeLegacy(w, font, str);
        }
        return { width: w + spaceWidths, height: h, marginTop: 0, marginBottom: 0, extraData: null };
      } finally {
        if (restore) restore();
      }
    }
    case 'element': {
      let isCode = false;
      let restore = null;
      try {
        switch (n.data) {
          case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': {
            fontSize = headerToFontSize(fontSize, n.data);
            fontStyle = d2fonts.FONT_STYLE_SEMIBOLD;
            const originalLineHeight = ruler.LineHeightFactor;
            ruler.LineHeightFactor = LineHeight_h;
            restore = () => { ruler.LineHeightFactor = originalLineHeight; };
            break;
          }
          case 'em':
            fontStyle = d2fonts.FONT_STYLE_ITALIC;
            break;
          case 'b': case 'strong':
            fontStyle = d2fonts.FONT_STYLE_BOLD;
            break;
          case 'pre': case 'code':
            if (monoFontFamily != null) fontFamily = monoFontFamily;
            else fontFamily = d2fonts.SourceCodePro;
            fontStyle = d2fonts.FONT_STYLE_REGULAR;
            isCode = true;
            break;
        }

        const block = newBlock();
        const lineHeightPx = fontSize * ruler.LineHeightFactor;

        if (n.firstChild != null) {
          const first = getNext(n.firstChild);
          const last = getPrev(n.lastChild);

          const blocks = [];
          let inlineBlock = null;
          // first create blocks from combined inline elements, then combine all blocks
          // inlineBlock will be non-null while inline elements are being combined into a block
          const endInlineBlock = () => {
            if (!isCode && inlineBlock.height > 0 && inlineBlock.height < lineHeightPx) inlineBlock.height = lineHeightPx;
            blocks.push({ ...inlineBlock });
            inlineBlock = null;
          };
          for (let child = n.firstChild; child != null; child = child.nextSibling) {
            const childBlock = ruler.measureNode(depth + 1, child, fontFamily, monoFontFamily, fontSize, fontStyle);

            if (child.type === 'element' && isBlockElement(child.data)) {
              if (inlineBlock != null) endInlineBlock();
              const nb = newBlock();
              nb.width = childBlock.width;
              nb.height = childBlock.height;
              if (child === first && n.data === 'blockquote') nb.marginTop = 0.;
              else nb.marginTop = childBlock.marginTop;
              if (child === last && n.data === 'blockquote') nb.marginBottom = 0.;
              else nb.marginBottom = childBlock.marginBottom;

              blocks.push(nb);
            } else if (child.type === 'element' && child.data === 'br') {
              if (inlineBlock != null) endInlineBlock();
              else block.height += lineHeightPx;
            } else if (blockIsNotEmpty(childBlock)) {
              if (inlineBlock == null) {
                // start inline block with child
                inlineBlock = childBlock;
              } else {
                // stack inline element dimensions horizontally
                inlineBlock.width += childBlock.width;
                inlineBlock.height = Math.max(inlineBlock.height, childBlock.height);

                inlineBlock.marginTop = Math.max(inlineBlock.marginTop, childBlock.marginTop);
                inlineBlock.marginBottom = Math.max(inlineBlock.marginBottom, childBlock.marginBottom);
              }
            }
          }
          if (inlineBlock != null) endInlineBlock();

          let prevMarginBottom = 0;
          for (let i = 0; i < blocks.length; i++) {
            const b = blocks[i];
            if (i === 0) {
              block.marginTop = Math.max(block.marginTop, b.marginTop);
            } else {
              const marginDiff = b.marginTop - prevMarginBottom;
              if (marginDiff > 0) block.height += marginDiff;
            }
            if (i === blocks.length - 1) {
              block.marginBottom = Math.max(block.marginBottom, b.marginBottom);
            } else {
              block.height += b.marginBottom;
              prevMarginBottom = b.marginBottom;
            }

            block.height += b.height;
            block.width = Math.max(block.width, b.width);
          }
        }

        switch (n.data) {
          case 'blockquote':
            block.width += 2 * PaddingLR_blockquote_em * fontSize + BorderLeft_blockquote_em * fontSize;
            block.marginBottom = Math.max(block.marginBottom, MarginBottom_blockquote);
            break;
          case 'p':
            if (parentElementType === 'li') block.marginTop = Math.max(block.marginTop, MarginTop_li_p);
            block.marginBottom = Math.max(block.marginBottom, MarginBottom_p);
            break;
          case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6':
            block.marginTop = Math.max(block.marginTop, MarginTop_h);
            block.marginBottom = Math.max(block.marginBottom, MarginBottom_h);
            switch (n.data) {
              case 'h1': case 'h2':
                block.height += PaddingBottom_h1_h2_em * fontSize + BorderBottom_h1_h2;
            }
            break;
          case 'li':
            block.width += PaddingLeft_ul_ol_em * fontSize;
            if (hasPrev(n)) block.marginTop = Math.max(block.marginTop, MarginTop_li_em * fontSize);
            break;
          case 'ol': case 'ul':
            if (hasAncestorElement(n, 'ul') || hasAncestorElement(n, 'ol')) {
              block.marginTop = 0;
              block.marginBottom = 0;
            } else {
              block.marginBottom = Math.max(block.marginBottom, MarginBottom_ul);
            }
            break;
          case 'pre':
            block.width += 2 * Padding_pre;
            block.height += 2 * Padding_pre;
            block.marginBottom = Math.max(block.marginBottom, MarginBottom_pre);
            break;
          case 'code':
            if (parentElementType !== 'pre') {
              block.width += 2 * PaddingLeftRight_code_em * fontSize;
              block.height += 2 * PaddingTopBottom_code_em * fontSize;
            }
            break;
          case 'hr':
            block.height += Height_hr_em * fontSize;
            block.marginTop = Math.max(block.marginTop, MarginTopBottom_hr);
            block.marginBottom = Math.max(block.marginBottom, MarginTopBottom_hr);
            break;
          case 'table': {
            let columnWidths = [];
            let tableHeight = 0;

            // Border width for table (outer border)
            const tableBorder = 1.0;

            // Iterate over child nodes (tbody, thead, tr)
            for (let child = n.firstChild; child != null; child = child.nextSibling) {
              if (child.type === 'element' && (child.data === 'tbody' || child.data === 'thead' || child.data === 'tfoot')) {
                const childAttrs = ruler.measureNode(depth + 1, child, fontFamily, monoFontFamily, fontSize, fontStyle);
                tableHeight += childAttrs.height;

                if (childAttrs.extraData && childAttrs.extraData.section) {
                  columnWidths = mergeColumnWidths(columnWidths, childAttrs.extraData.section);
                }
              } else if (child.type === 'element' && child.data === 'tr') {
                const rowAttrs = ruler.measureNode(depth + 1, child, fontFamily, monoFontFamily, fontSize, fontStyle);
                tableHeight += rowAttrs.height;

                if (rowAttrs.extraData && rowAttrs.extraData.row) {
                  columnWidths = mergeColumnWidths(columnWidths, [rowAttrs.extraData.row]);
                }
              }
            }

            // Calculate total table width including ALL borders
            let tableWidth = 0.0;
            if (columnWidths.length > 0) {
              // Add widths of all columns
              for (const colWidth of columnWidths) tableWidth += colWidth;

              // Add border for every column division (including outer borders)
              tableWidth += (columnWidths.length + 1) * tableBorder;
            }

            // Add outer borders to height
            tableHeight += 2 * tableBorder;

            block.width = tableWidth;
            block.height = tableHeight;
            break;
          }
          case 'thead': case 'tbody': case 'tfoot': {
            let sectionWidth = 0, sectionHeight = 0;
            const sectionColumnWidths = []; // [][]float64

            // Iterate over tr elements
            for (let child = n.firstChild; child != null; child = child.nextSibling) {
              if (child.type === 'element' && child.data === 'tr') {
                const childAttrs = ruler.measureNode(depth + 1, child, fontFamily, monoFontFamily, fontSize, fontStyle);
                sectionHeight += childAttrs.height;
                sectionWidth = Math.max(sectionWidth, childAttrs.width);

                if (childAttrs.extraData && childAttrs.extraData.row) sectionColumnWidths.push(childAttrs.extraData.row);
              }
            }

            block.width = sectionWidth;
            block.height = sectionHeight;
            block.extraData = { section: sectionColumnWidths }; // Pass column widths back to table
            break;
          }
          case 'td': case 'th': {
            // Apply semibold style to header cells
            let cellFontStyle = fontStyle;
            if (n.data === 'th') cellFontStyle = d2fonts.FONT_STYLE_SEMIBOLD;

            // Measure cell content with appropriate font style
            let cellContentWidth = 0, cellContentHeight = 0;

            for (let child = n.firstChild; child != null; child = child.nextSibling) {
              // Pass the header-specific font style to child measurements
              const childAttrs = ruler.measureNode(depth + 1, child, fontFamily, monoFontFamily, fontSize, cellFontStyle);
              cellContentWidth = Math.max(cellContentWidth, childAttrs.width);
              cellContentHeight += childAttrs.height;
            }

            block.width = cellContentWidth;
            block.height = cellContentHeight;
            break;
          }
          case 'tr': {
            let rowWidth = 0, rowHeight = 0;
            const cellWidths = [];

            const cellBorder = 1.0;
            const rowBorder = 1.0;

            let maxCellHeight = 0.0;
            let cellCount = 0;

            // Check if this row is in a thead to determine default font style for cells
            const inHeader = hasAncestorElement(n, 'thead');
            let rowFontStyle = fontStyle;
            if (inHeader) rowFontStyle = d2fonts.FONT_STYLE_SEMIBOLD;

            for (let child = n.firstChild; child != null; child = child.nextSibling) {
              if (child.type === 'element' && (child.data === 'td' || child.data === 'th')) {
                cellCount++;

                // Use semibold for th elements regardless of location
                let childFontStyle = rowFontStyle;
                if (child.data === 'th') childFontStyle = d2fonts.FONT_STYLE_SEMIBOLD;

                const childAttrs = ruler.measureNode(depth + 1, child, fontFamily, monoFontFamily, fontSize, childFontStyle);
                const cellPaddingH = 13.0 * 2;
                const cellPaddingV = 6.0 * 2;

                const cellWidth = childAttrs.width + cellPaddingH;
                const cellHeight = childAttrs.height + cellPaddingV;

                cellWidths.push(cellWidth);
                maxCellHeight = Math.max(maxCellHeight, cellHeight);
              }
            }

            if (cellCount > 0) {
              for (const w of cellWidths) rowWidth += w;
              rowWidth += (cellCount + 1) * cellBorder;
            }

            rowHeight = maxCellHeight + rowBorder;

            block.width = rowWidth;
            block.height = rowHeight;
            block.extraData = { row: cellWidths };
            break;
          }
        }
        if (block.height > 0 && block.height < lineHeightPx) block.height = lineHeightPx;
        return block;
      } finally {
        if (restore) restore();
      }
    }
  }
  return newBlock();
};

function mergeColumnWidths(existing, newRows) {
  for (const rowWidths of newRows) {
    for (let i = 0; i < rowWidths.length; i++) {
      const width = rowWidths[i];
      if (i >= existing.length) existing.push(width);
      else existing[i] = Math.max(existing[i], width);
    }
  }
  return existing;
}

// ---- substitutions.go (used by d2ir) ----
// Go finds the Text nodes with goldmark and substitutes in their source segments. markdown-it tokens carry no source
// offsets, so this is a line scanner for the spans goldmark skips (code, HTML, link destinations), written for d2ir.

// Go's strings.ReplaceAll(s, "${k}", v) for each variable, in map order (insertion order here).
function replaceVariables(s, vars) {
  for (const [k, v] of vars) s = s.split('${' + k + '}').join(v);
  return s;
}

const HTML_BLOCK_TAGS = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
const RE_HTML_START = [
  [/^ {0,3}<(script|pre|style|textarea)(\s|>|$)/i, /<\/(script|pre|style|textarea)>/i],
  [/^ {0,3}<!--/, /-->/],
  [/^ {0,3}<\?/, /\?>/],
  [/^ {0,3}<![A-Za-z]/, />/],
  [/^ {0,3}<!\[CDATA\[/, /\]\]>/],
  [new RegExp('^ {0,3}</?(' + HTML_BLOCK_TAGS + ')(\\s|/?>|$)', 'i'), null],
];
const RE_HTML_7 = /^ {0,3}(<[A-Za-z][A-Za-z0-9-]*(\s+[A-Za-z_:][A-Za-z0-9_.:-]*(\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>|<\/[A-Za-z][A-Za-z0-9-]*\s*>)\s*$/;
const RE_LIST = /^( {0,3})([-+*]|\d{1,9}[.)])( +|$)/;

/**
 * Spans [start, end) of mdText that goldmark does not make Text nodes of: code blocks, code spans, HTML, link
 * destinations. A line scanner for the block structure (fences, indented code, HTML blocks, list indentation) and
 * regular expressions for the inline parts; blockquotes and reference definitions are not modelled.
 */
function codeSpans(md) {
  const spans = [];
  const lines = md.split('\n');
  let off = 0, fence = null, fenceFrom = 0, html = null, inPara = false;
  const listIndents = []; // content indent of the open list items
  for (const rawLine of lines) {
    const end = off + rawLine.length;
    // leading tabs count as columns up to the next multiple of 4
    const line = rawLine.replace(/^[ \t]+/, (w) => { let col = 0; for (const ch of w) col = ch === '\t' ? (col + 4) & ~3 : col + 1; return ' '.repeat(col); });
    const blank = line.trim() === '';
    const indent = /^ */.exec(line)[0].length;
    const span = () => spans.push([off, end + 1]);
    if (fence) {
      span();
      const c = new RegExp('^ {0,3}' + (fence[0] === '`' ? '`' : '~') + '{' + fence.length + ',}\\s*$');
      if (c.test(line.slice(Math.min(fenceFrom, indent)))) { fence = null; inPara = false; }
      off = end + 1;
      continue;
    }
    if (html) {
      span();
      if (html.end ? html.end.test(line) : blank) html = null;
      off = end + 1;
      inPara = false;
      continue;
    }
    if (blank) { inPara = false; off = end + 1; continue; }
    while (listIndents.length && indent < listIndents[listIndents.length - 1] && !inPara) listIndents.pop();
    const base = listIndents.length ? listIndents[listIndents.length - 1] : 0;
    const from = base > 0 ? Math.min(base, indent) : 0;
    const sub = line.slice(from);
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(sub);
    const lm = RE_LIST.exec(sub);
    if (m && !(m[1][0] === '`' && sub.slice(m[0].length).includes('`'))) {
      fence = m[1];
      fenceFrom = from;
      span();
      inPara = false;
    } else if (indent - base >= 4 && !inPara) {
      span();
    } else if (!lm && RE_HTML_START.some(([st, en], k) => { if (!st.test(line.slice(base))) return false; html = { end: en }; if (en && en.test(line.slice(line.search(st) + 1))) html = null; return true; })) {
      span();
      if (html === null) inPara = false;
    } else if (!lm && !inPara && RE_HTML_7.test(line.slice(base))) {
      html = { end: null };
      span();
    } else {
      if (lm) {
        while (listIndents.length && from + lm[1].length < listIndents[listIndents.length - 1]) listIndents.pop(); // a sibling item
        listIndents.push(from + lm[1].length + lm[2].length + (lm[3].length > 4 || lm[3] === '' ? 1 : lm[3].length));
        inPara = true;
      } else inPara = true;
    }
    off = end + 1;
  }
  const inSpan = (i) => spans.some(([a, b]) => i >= a && i < b);
  // inline code spans: a backtick run closed by a run of the same length
  let i = 0;
  while (i < md.length) {
    if (inSpan(i)) { i++; continue; }
    if (md[i] === '\\') { i += 2; continue; }
    if (md[i] !== '`') { i++; continue; }
    let j = i;
    while (md[j] === '`') j++;
    const run = j - i;
    let k = j, found = -1;
    while (k < md.length) {
      if (md[k] !== '`') { k++; continue; }
      let e = k;
      while (md[e] === '`') e++;
      if (e - k === run) { found = e; break; }
      k = e;
    }
    if (found < 0) { i = j; continue; }
    spans.push([i, found]);
    i = found;
  }
  // autolinks, inline HTML, and link destinations
  const inline = [/<[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*>/g, /<[^\s<>@]+@[^\s<>]+>/g, /<\/?[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>/g, /<!--[\s\S]*?-->/g, /(?<=\]\()[^)\s]*/g];
  for (const re of inline) for (const mm of md.matchAll(re)) if (!inSpan(mm.index)) spans.push([mm.index, mm.index + mm[0].length]);
  return spans;
}

/** Go's textmeasure.ReplaceSubstitutionsMarkdown(mdText, variables); variables is a Map of name to value. */
export function replaceSubstitutionsMarkdown(mdText, variables) {
  if (variables.size === 0 || !mdText.includes('${')) return mdText;
  const spans = codeSpans(mdText);
  let out = '', pos = 0;
  const flush = (a, b) => { out += replaceVariables(mdText.slice(a, b), variables); };
  for (const [a, b] of spans.sort((x, y) => x[0] - y[0])) {
    if (a < pos) continue;
    flush(pos, a);
    out += mdText.slice(a, Math.min(b, mdText.length));
    pos = Math.min(b, mdText.length);
  }
  flush(pos, mdText.length);
  return out;
}
