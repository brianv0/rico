// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of D2's d2target package (github.com/d2lang/d2 v0.9.0, Copyright 2022 Terrastruct Inc.):
// Diagram, Shape, Connection, Text, Config, ... as classes whose properties are Go's JSON tag names
// (`shape['3d']`, `shape['double-border']`), with Go's zero values (nil slices are null, nil pointers are null) and
// a toJSON() that reproduces json.Marshal exactly: field order and omitempty included, because Diagram.hashID hashes
// those bytes. Go's embedded structs (Class, SQLTable, Text) are flattened into Shape and Connection, as they are in
// the JSON. Go copies structs by value; use clone() where Go assigns or appends a Shape/Connection/Diagram.
//
// Icon is Go's *url.URL: any object with that struct's JSON fields (Scheme, Opaque, User, Host, Path, RawPath,
// OmitHost, ForceQuery, RawQuery, Fragment, RawFragment), or null. A port of net/url is not part of this file.

import * as d2fonts from './fonts.js';
import * as color from './color.js';
import * as geo from './geo.js';
import * as label from './label.js';
import * as shape from './shape.js';
import * as svg from './svg.js';
import * as textmeasure from './textmeasure.js';
import { goFixed, go2Min, go2Max, goInt } from './gomath.js';
import { equalFold, goLower } from './ast.js';

export const DEFAULT_ICON_SIZE = 32;
export const MAX_ICON_SIZE = 64;

export const SHADOW_SIZE_X = 3;
export const SHADOW_SIZE_Y = 5;
export const THREE_DEE_OFFSET = 15;
export const MULTIPLE_OFFSET = 10;

export const INNER_BORDER_OFFSET = 5;

export const BG_COLOR = color.N7;
export const FG_COLOR = color.N1;

export const MIN_ARROWHEAD_STROKE_WIDTH = 2;
export const ARROWHEAD_PADDING = 2.;

export const CONNECTION_ICON_LABEL_GAP = 8;

export const BorderOffset = geo.newVector(5, 5);

// ---- encoding/json ----

/**
 * json.Marshal for values built from this file's classes: objects and toJSON() in insertion order, HTML-safe string
 * escaping (<, >, &, U+2028, U+2029), "-0" for negative zero. Numbers must be finite.
 */
export function goMarshal(v, hash = false) {
  if (v === null || v === undefined) return 'null';
  switch (typeof v) {
    case 'boolean': return v ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(v)) throw new Error(`json: unsupported value: ${v}`);
      return Object.is(v, -0) ? '-0' : JSON.stringify(v);
    case 'string': return marshalString(v);
    case 'object':
      if (typeof v.toJSON === 'function') return goMarshal(v.toJSON(), hash);
      if (Array.isArray(v)) return '[' + v.map((x) => goMarshal(x, hash)).join(',') + ']';
      return '{' + Object.keys(v).filter((k) => v[k] !== undefined).map((k) => marshalString(k) + ':' + (hash && k === 'icon' && v[k] !== null && typeof v[k] === 'object' ? marshalHashURL(v[k]) : goMarshal(v[k], hash))).join(',') + '}';
  }
  throw new Error(`json: unsupported type: ${typeof v}`);
}

// json.Marshal follows the declaration order of struct fields. Go 1.26 reorganized net/url.URL, which would change diagram hashes
// (and every SVG identifier derived from them) without changing the diagram, so Diagram.Bytes keeps URL values in the order used
// through Go 1.25 (marshalHashJSON in d2target.go). Applied only to the icon fields of Shape, Connection and Root.
const legacyURLFieldOrder = ['Scheme', 'Opaque', 'User', 'Host', 'Path', 'RawPath', 'OmitHost', 'ForceQuery', 'RawQuery', 'Fragment', 'RawFragment'];
function marshalHashURL(u) {
  const o = typeof u.toJSON === 'function' ? u.toJSON() : u;
  const keys = Object.keys(o);
  if (keys.length !== legacyURLFieldOrder.length || !legacyURLFieldOrder.every((k) => keys.includes(k))) throw new Error(`decode icon URL for stable diagram hash: got ${keys.length} fields, want ${legacyURLFieldOrder.length}`);
  return '{' + legacyURLFieldOrder.map((k) => marshalString(k) + ':' + goMarshal(o[k])).join(',') + '}';
}

function marshalString(s) {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    switch (c) {
      case 0x5c: out += '\\\\'; break;
      case 0x22: out += '\\"'; break;
      case 0x08: out += '\\b'; break;
      case 0x0c: out += '\\f'; break;
      case 0x0a: out += '\\n'; break;
      case 0x0d: out += '\\r'; break;
      case 0x09: out += '\\t'; break;
      case 0x3c: out += '\\u003c'; break;
      case 0x3e: out += '\\u003e'; break;
      case 0x26: out += '\\u0026'; break;
      case 0x2028: out += '\\u2028'; break;
      case 0x2029: out += '\\u2029'; break;
      default:
        if (c < 0x20) out += '\\u00' + (c >> 4).toString(16) + (c & 0xf).toString(16);
        else if (c >= 0xd800 && c <= 0xdfff) out += '\\ufffd'; // lone surrogate: invalid UTF-8 in Go
        else out += ch;
    }
  }
  return out + '"';
}

/** hash/fnv New32a over the UTF-8 bytes of the strings */
function fnv32a(...strings) {
  let h = 2166136261;
  for (const s of strings) {
    for (const b of new TextEncoder().encode(s)) {
      h ^= b;
      h = Math.imul(h, 16777619) >>> 0;
    }
  }
  return h >>> 0;
}

const isEmpty = (a) => a == null || (Array.isArray(a) && a.length === 0);
const deepClone = (v) => (v === null || v === undefined ? v : Array.isArray(v) ? v.map(deepClone) : typeof v === 'object' ? cloneObject(v) : v);
function cloneObject(o) {
  const out = Object.create(Object.getPrototypeOf(o));
  for (const k of Object.keys(o)) out[k] = deepClone(o[k]);
  return out;
}

// ---- Config ----

export class Config {
  constructor(init = {}) {
    this.sketch = null;
    this.themeID = null;
    this.darkThemeID = null;
    this.pad = null;
    this.center = null;
    this.layoutEngine = null;
    this.themeOverrides = null;
    this.darkThemeOverrides = null;
    /** a data structure for holding user-defined data, useful for plugins that allow users to configure within source code */
    this.data = null;
    Object.assign(this, init);
  }
  toJSON() {
    const o = {
      sketch: this.sketch, themeID: this.themeID, darkThemeID: this.darkThemeID, pad: this.pad, center: this.center, layoutEngine: this.layoutEngine,
    };
    if (this.themeOverrides != null) o.themeOverrides = this.themeOverrides;
    if (this.darkThemeOverrides != null) o.darkThemeOverrides = this.darkThemeOverrides;
    if (this.data != null && Object.keys(this.data).length > 0) {
      // maps marshal with sorted keys
      o.data = Object.fromEntries(Object.keys(this.data).sort().map((k) => [k, this.data[k]]));
    }
    return o;
  }
  clone() { return deepClone(this); }
}

export class ThemeOverrides {
  constructor(init = {}) {
    for (const k of ['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7', 'b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'aa2', 'aa4', 'aa5', 'ab4', 'ab5']) this[k] = null;
    Object.assign(this, init);
  }
}

// ---- Diagram ----

export class Diagram {
  constructor(init = {}) {
    this.name = '';
    this.config = null;
    /** See docs on the same field in d2graph to understand what it means. */
    this.isFolderOnly = false;
    this.description = '';
    this.fontFamily = null;
    this.monoFontFamily = null;

    this.shapes = null;
    this.connections = null;

    this.root = new Shape();
    this.legend = null;
    // Maybe Icon can be used as a watermark in the root shape

    this.layers = null;
    this.scenarios = null;
    this.steps = null;
    Object.assign(this, init);
  }

  toJSON() {
    const o = { name: this.name };
    if (this.config != null) o.config = this.config;
    o.isFolderOnly = this.isFolderOnly;
    if (this.description !== '') o.description = this.description;
    if (this.fontFamily != null) o.fontFamily = this.fontFamily;
    if (this.monoFontFamily != null) o.monoFontFamily = this.monoFontFamily;
    o.shapes = this.shapes;
    o.connections = this.connections;
    o.root = this.root;
    if (this.legend != null) o.legend = this.legend;
    if (!isEmpty(this.layers)) o.layers = this.layers;
    if (!isEmpty(this.scenarios)) o.scenarios = this.scenarios;
    if (!isEmpty(this.steps)) o.steps = this.steps;
    return o;
  }

  clone() { return deepClone(this); }

  getBoard(boardPath) {
    const d = this;
    if (boardPath.length === 0) return d;

    const head = boardPath[0];

    if (boardPath.length === 1 && d.name === head) return d;

    switch (head) {
      case 'layers':
        if (boardPath.length < 2) return null;
        for (const b of d.layers ?? []) {
          if (b.name === boardPath[1]) return b.getBoard(boardPath.slice(2));
        }
        break;
      case 'scenarios':
        if (boardPath.length < 2) return null;
        for (const b of d.scenarios ?? []) {
          if (b.name === boardPath[1]) return b.getBoard(boardPath.slice(2));
        }
        break;
      case 'steps':
        if (boardPath.length < 2) return null;
        for (const b of d.steps ?? []) {
          if (b.name === boardPath[1]) return b.getBoard(boardPath.slice(2));
        }
        break;
    }

    for (const b of d.layers ?? []) {
      if (b.name === head) return b.getBoard(boardPath.slice(1));
    }
    for (const b of d.scenarios ?? []) {
      if (b.name === head) return b.getBoard(boardPath.slice(1));
    }
    for (const b of d.steps ?? []) {
      if (b.name === head) return b.getBoard(boardPath.slice(1));
    }
    return null;
  }

  /** Go's Bytes() as a string of the same JSON text (hashID encodes it as UTF-8) */
  bytes() {
    const diagram = this;
    let base = goMarshal(diagram.shapes, true) + goMarshal(diagram.connections, true) + goMarshal(diagram.root, true);

    if (diagram.config != null) base += goMarshal(diagram.config);

    for (const d of diagram.layers ?? []) base += d.bytes();
    for (const d of diagram.scenarios ?? []) base += d.bytes();
    for (const d of diagram.steps ?? []) base += d.bytes();

    return base;
  }

  hasShape(condition) {
    const diagram = this;
    for (const d of diagram.layers ?? []) if (d.hasShape(condition)) return true;
    for (const d of diagram.scenarios ?? []) if (d.hasShape(condition)) return true;
    for (const d of diagram.steps ?? []) if (d.hasShape(condition)) return true;
    for (const s of diagram.shapes ?? []) if (condition(s)) return true;
    return false;
  }

  /** salt is a string or null */
  hashID(salt) {
    const bytes = this.bytes();
    // CSS names can't start with numbers, so prepend a little something
    return `d2-${salt != null ? fnv32a(bytes, salt) : fnv32a(bytes)}`;
  }

  /** returns [topLeft, bottomRight] as Points */
  nestedBoundingBox() {
    const diagram = this;
    const [tl, br] = diagram.boundingBox();
    for (const list of [diagram.layers, diagram.scenarios, diagram.steps]) {
      for (const d of list ?? []) {
        const [tl2, br2] = d.nestedBoundingBox();
        tl.x = go2Min(tl.x, tl2.x);
        tl.y = go2Min(tl.y, tl2.y);
        br.x = go2Max(br.x, br2.x);
        br.y = go2Max(br.y, br2.y);
      }
    }
    return [tl, br];
  }

  /** returns [topLeft, bottomRight] as Points */
  boundingBox() {
    const diagram = this;
    if (isEmpty(diagram.shapes)) return [new Point(0, 0), new Point(0, 0)];
    let x1 = 2147483647; // math.MaxInt32
    let y1 = 2147483647;
    let x2 = -2147483648; // math.MinInt32
    let y2 = -2147483648;

    for (const targetShape of diagram.shapes) {
      const halfStroke = goInt(Math.ceil(targetShape.strokeWidth / 2.));
      x1 = go2Min(x1, targetShape.pos.x - halfStroke);
      y1 = go2Min(y1, targetShape.pos.y - halfStroke);
      x2 = go2Max(x2, targetShape.pos.x + targetShape.width + halfStroke);
      y2 = go2Max(y2, targetShape.pos.y + targetShape.height + halfStroke);

      if (targetShape.type === ShapeC4Person) {
        const headRadius = goInt(targetShape.width * 0.22);
        const headCenterY = goInt(targetShape.height * 0.18);
        const headTop = targetShape.pos.y + headCenterY - headRadius;
        y1 = go2Min(y1, headTop - targetShape.strokeWidth);
      }

      if (targetShape.tooltip !== '' || targetShape.link !== '') {
        if (targetShape.tooltipPosition !== '') {
          const [tooltipMinX, tooltipMinY, tooltipMaxX, tooltipMaxY] = calculateTooltipBounds(targetShape, diagram.fontFamily, diagram.monoFontFamily);
          x1 = go2Min(x1, tooltipMinX);
          y1 = go2Min(y1, tooltipMinY);
          x2 = go2Max(x2, tooltipMaxX);
          y2 = go2Max(y2, tooltipMaxY);
        } else {
          y1 = go2Min(y1, targetShape.pos.y - targetShape.strokeWidth - 16);
          x2 = go2Max(x2, targetShape.pos.x + targetShape.strokeWidth + targetShape.width + 16);
        }
      }
      if (targetShape.shadow) {
        y2 = go2Max(y2, targetShape.pos.y + targetShape.height + halfStroke + SHADOW_SIZE_Y);
        x2 = go2Max(x2, targetShape.pos.x + targetShape.width + halfStroke + SHADOW_SIZE_X);
      }

      if (targetShape['3d']) {
        let offsetY = THREE_DEE_OFFSET;
        if (targetShape.type === ShapeHexagon) offsetY = Math.trunc(offsetY / 2);
        y1 = go2Min(y1, targetShape.pos.y - offsetY - targetShape.strokeWidth);
        x2 = go2Max(x2, targetShape.pos.x + THREE_DEE_OFFSET + targetShape.width + targetShape.strokeWidth);
      }
      if (targetShape.multiple) {
        y1 = go2Min(y1, targetShape.pos.y - MULTIPLE_OFFSET - targetShape.strokeWidth);
        x2 = go2Max(x2, targetShape.pos.x + MULTIPLE_OFFSET + targetShape.width + targetShape.strokeWidth);
      }

      if (targetShape.icon != null && label.isOutside(label.fromString(targetShape.iconPosition))) {
        const contentBox = geo.newBox(geo.newPoint(0, 0), targetShape.width, targetShape.height);
        const s = shape.newShape(targetShape.type, contentBox);
        const size = getIconSize(s.getInnerBox(), targetShape.iconPosition);

        if (targetShape.iconPosition.startsWith('OUTSIDE_TOP')) {
          y1 = go2Min(y1, targetShape.pos.y - label.PADDING - size);
        } else if (targetShape.iconPosition.startsWith('OUTSIDE_BOTTOM')) {
          y2 = go2Max(y2, targetShape.pos.y + targetShape.height + label.PADDING + size);
        } else if (targetShape.iconPosition.startsWith('OUTSIDE_LEFT')) {
          x1 = go2Min(x1, targetShape.pos.x - label.PADDING - size);
        } else if (targetShape.iconPosition.startsWith('OUTSIDE_RIGHT')) {
          x2 = go2Max(x2, targetShape.pos.x + targetShape.width + label.PADDING + size);
        }
      }

      if (targetShape.label !== '') {
        const labelPosition = label.fromString(targetShape.labelPosition);

        const shapeType = Object.prototype.hasOwnProperty.call(DSL_SHAPE_TO_SHAPE_TYPE, targetShape.type) ? DSL_SHAPE_TO_SHAPE_TYPE[targetShape.type] : '';
        const s = shape.newShape(shapeType,
          geo.newBox(geo.newPoint(targetShape.pos.x, targetShape.pos.y), targetShape.width, targetShape.height));

        const labelTL = label.getPointOnBox(labelPosition, s.getBox(), label.PADDING, targetShape.labelWidth, targetShape.labelHeight);
        if (targetShape['3d']) {
          let offset = THREE_DEE_OFFSET;
          if (targetShape.type === ShapeHexagon) offset = Math.trunc(offset / 2);
          if (targetShape.labelPosition.startsWith('OUTSIDE_RIGHT')) labelTL.x += offset;
          if (targetShape.labelPosition.startsWith('OUTSIDE_TOP')) labelTL.y -= offset;
        }
        x1 = go2Min(x1, goInt(labelTL.x));
        y1 = go2Min(y1, goInt(labelTL.y));
        x2 = go2Max(x2, goInt(labelTL.x) + targetShape.labelWidth);
        y2 = go2Max(y2, goInt(labelTL.y) + targetShape.labelHeight);
      }
    }

    for (const connection of diagram.connections ?? []) {
      const halfStroke = goInt(Math.ceil(connection.strokeWidth / 2.));
      for (const point of connection.route ?? []) {
        x1 = go2Min(x1, goInt(Math.floor(point.x)) - halfStroke);
        y1 = go2Min(y1, goInt(Math.floor(point.y)) - halfStroke);
        x2 = go2Max(x2, goInt(Math.ceil(point.x)) + halfStroke);
        y2 = go2Max(y2, goInt(Math.ceil(point.y)) + halfStroke);
      }

      if (connection.label !== '') {
        const labelTL = connection.getLabelTopLeft();
        x1 = go2Min(x1, goInt(labelTL.x));
        y1 = go2Min(y1, goInt(labelTL.y));
        x2 = go2Max(x2, goInt(labelTL.x) + connection.labelWidth);
        y2 = go2Max(y2, goInt(labelTL.y) + connection.labelHeight);
      }
      if (connection.srcLabel != null && connection.srcLabel.label !== '') {
        const labelTL = connection.getArrowheadLabelPosition(false);
        x1 = go2Min(x1, goInt(labelTL.x));
        y1 = go2Min(y1, goInt(labelTL.y));
        x2 = go2Max(x2, goInt(labelTL.x) + connection.srcLabel.labelWidth);
        y2 = go2Max(y2, goInt(labelTL.y) + connection.srcLabel.labelHeight);
      }
      if (connection.dstLabel != null && connection.dstLabel.label !== '') {
        const labelTL = connection.getArrowheadLabelPosition(true);
        x1 = go2Min(x1, goInt(labelTL.x));
        y1 = go2Min(y1, goInt(labelTL.y));
        x2 = go2Max(x2, goInt(labelTL.x) + connection.dstLabel.labelWidth);
        y2 = go2Max(y2, goInt(labelTL.y) + connection.dstLabel.labelHeight);
      }
    }

    return [new Point(x1, y1), new Point(x2, y2)];
  }

  getNestedCorpus() {
    const diagram = this;
    let corpus = diagram.getCorpus();
    for (const d of diagram.layers ?? []) corpus += d.getNestedCorpus();
    for (const d of diagram.scenarios ?? []) corpus += d.getNestedCorpus();
    for (const d of diagram.steps ?? []) corpus += d.getNestedCorpus();
    return corpus;
  }

  getCorpus() {
    const diagram = this;
    let corpus = '';
    let appendixCount = 0;
    for (const s of diagram.shapes ?? []) {
      corpus += s.label;
      if (s.tooltip !== '') {
        corpus += s.tooltip;
        appendixCount++;
        corpus += String(appendixCount);
      }
      if (s.link !== '') {
        corpus += s.link;
        appendixCount++;
        corpus += String(appendixCount);
      }
      corpus += s.prettyLink;
      if (s.type === ShapeClass) {
        for (const cf of s.fields ?? []) corpus += classFieldText(cf, 0).text + classVisibilityToken(cf);
        for (const cm of s.methods ?? []) corpus += classMethodText(cm, 0).text + classVisibilityToken(cm);
      }
      if (s.type === ShapeSQLTable) {
        for (const c of s.columns ?? []) {
          for (const t of sqlColumnTexts(c, 0)) corpus += t.text;
          corpus += sqlConstraintAbbr(c);
        }
      }
    }
    for (const c of diagram.connections ?? []) {
      corpus += c.label;
      if (c.srcLabel != null) corpus += c.srcLabel.label;
      if (c.dstLabel != null) corpus += c.dstLabel.label;
    }

    if (diagram.legend != null) {
      if (diagram.legend.label !== '') corpus += diagram.legend.label;
      else corpus += 'Legend';
      for (const s of diagram.legend.shapes ?? []) corpus += s.label;
      for (const c of diagram.legend.connections ?? []) corpus += c.label;
    }

    return corpus;
  }
}

export class Legend {
  constructor(init = {}) {
    this.label = '';
    this.shapes = null;
    this.connections = null;
    Object.assign(this, init);
  }
  toJSON() {
    const o = {};
    if (this.label !== '') o.label = this.label;
    if (!isEmpty(this.shapes)) o.shapes = this.shapes;
    if (!isEmpty(this.connections)) o.connections = this.connections;
    return o;
  }
}

/** Where a tooltip is placed relative to its shape: [x, y] */
export function calculateTooltipPosition(shapeX, shapeY, shapeWidth, shapeHeight, tooltipWidth, tooltipHeight, position) {
  const padding = 10.0;
  let x, y;

  switch (position) {
    case 'top-left':
      x = shapeX;
      y = shapeY - tooltipHeight - padding;
      break;
    case 'top-center':
      x = shapeX + shapeWidth / 2 - tooltipWidth / 2;
      y = shapeY - tooltipHeight - padding;
      break;
    case 'top-right':
      x = shapeX + shapeWidth - tooltipWidth;
      y = shapeY - tooltipHeight - padding;
      break;
    case 'center-left':
      x = shapeX - tooltipWidth - padding;
      y = shapeY + shapeHeight / 2 - tooltipHeight / 2;
      break;
    case 'center-right':
      x = shapeX + shapeWidth + padding;
      y = shapeY + shapeHeight / 2 - tooltipHeight / 2;
      break;
    case 'bottom-left':
      x = shapeX;
      y = shapeY + shapeHeight + padding;
      break;
    case 'bottom-center':
      x = shapeX + shapeWidth / 2 - tooltipWidth / 2;
      y = shapeY + shapeHeight + padding;
      break;
    case 'bottom-right':
      x = shapeX + shapeWidth - tooltipWidth;
      y = shapeY + shapeHeight + padding;
      break;
    default:
      x = shapeX + shapeWidth / 2 - tooltipWidth / 2;
      y = shapeY - tooltipHeight - padding;
  }

  return [x, y];
}

const utf8ByteLength = (s) => new TextEncoder().encode(s).length;

/** [minX, minY, maxX, maxY] */
function calculateTooltipBounds(targetShape, diagramFontFamily, diagramMonoFontFamily) {
  if (targetShape.tooltip === '' || targetShape.tooltipPosition === '') return [0, 0, 0, 0];

  let tooltipWidth, tooltipHeight;

  // Go: ruler, err := textmeasure.NewRuler(); on any error fall back to a length-based estimate.
  // Here a missing metrics file or markdown-it registration lands in the same fallback.
  const fallback = () => {
    const textLength = utf8ByteLength(targetShape.tooltip);
    tooltipWidth = go2Min(textLength * 8 + 20, 200);
    tooltipHeight = 30;
  };
  try {
    const ruler = textmeasure.newRuler();
    let fontFamily = diagramFontFamily ?? null;
    if (fontFamily === null) fontFamily = d2fonts.SourceSansPro;
    let monoFontFamily = diagramMonoFontFamily ?? null;
    if (monoFontFamily === null) monoFontFamily = d2fonts.SourceCodePro;
    if (equalFold(targetShape.fontFamily, 'mono')) {
      fontFamily = monoFontFamily;
    } else if (targetShape.fontFamily !== '' && !equalFold(targetShape.fontFamily, 'default')) {
      const lower = goLower(targetShape.fontFamily);
      if (Object.prototype.hasOwnProperty.call(d2fonts.D2_FONT_TO_FAMILY, lower)) fontFamily = d2fonts.D2_FONT_TO_FAMILY[lower];
    }

    const [width, height] = textmeasure.measureMarkdown(targetShape.tooltip, ruler, fontFamily, monoFontFamily, d2fonts.FONT_SIZE_M);
    tooltipWidth = width + 20;
    tooltipHeight = height + 20;
  } catch {
    fallback();
  }

  const shapeX = targetShape.pos.x;
  const shapeY = targetShape.pos.y;
  const shapeWidth = targetShape.width;
  const shapeHeight = targetShape.height;

  const [x, y] = calculateTooltipPosition(shapeX, shapeY, shapeWidth, shapeHeight, tooltipWidth, tooltipHeight, targetShape.tooltipPosition);

  const minX = goInt(Math.floor(x));
  const minY = goInt(Math.floor(y));
  const maxX = goInt(Math.ceil(x)) + tooltipWidth;
  const maxY = goInt(Math.ceil(y)) + tooltipHeight;

  return [minX, minY, maxX, maxY];
}

export const newDiagram = () => {
  const d = new Diagram();
  d.root = new Shape({ fill: BG_COLOR });
  return d;
};

// ---- Text ----

/** Go's Text struct; Shape and Connection embed these fields flat. */
export class Text {
  constructor(init = {}) {
    this.label = '';
    this.fontSize = 0;
    this.fontFamily = '';
    this.language = '';
    this.color = '';

    this.italic = false;
    this.bold = false;
    this.underline = false;

    this.labelWidth = 0;
    this.labelHeight = 0;
    this.labelFill = '';
    Object.assign(this, init);
  }
  toJSON() { return textJSON(this, {}); }
  clone() { return deepClone(this); }
}

/** appends the Text fields in Go's order to o */
function textJSON(t, o) {
  o.label = t.label;
  o.fontSize = t.fontSize;
  o.fontFamily = t.fontFamily;
  o.language = t.language;
  o.color = t.color;
  o.italic = t.italic;
  o.bold = t.bold;
  o.underline = t.underline;
  o.labelWidth = t.labelWidth;
  o.labelHeight = t.labelHeight;
  if (t.labelFill !== '') o.labelFill = t.labelFill;
  return o;
}

// ---- Shape ----

export class Shape {
  constructor(init = {}) {
    this.id = '';
    this.type = '';

    this.classes = null;

    this.pos = new Point(0, 0);
    this.width = 0;
    this.height = 0;

    this.opacity = 0;
    this.strokeDash = 0;
    this.strokeWidth = 0;

    this.borderRadius = 0;

    this.fill = '';
    this.fillPattern = '';
    this.stroke = '';

    this.animated = false;
    this.shadow = false;
    this['3d'] = false;
    this.multiple = false;
    this['double-border'] = false;

    this.tooltip = '';
    this.link = '';
    this.prettyLink = '';
    this.icon = null;
    this.iconBorderRadius = 0;
    this.iconPosition = '';

    /** Whether the shape should allow shapes behind it to bleed through. Currently just used for sequence diagram groups */
    this.blend = false;

    // Class
    this.fields = null;
    this.methods = null;
    // SQLTable
    this.columns = null;

    this.contentAspectRatio = null;

    // Text
    this.label = '';
    this.fontSize = 0;
    this.fontFamily = '';
    this.language = '';
    this.color = '';
    this.italic = false;
    this.bold = false;
    this.underline = false;
    this.labelWidth = 0;
    this.labelHeight = 0;
    this.labelFill = '';

    this.labelPosition = '';
    this.tooltipPosition = '';

    this.zIndex = 0;
    this.level = 0;

    // These are used for special shapes, sql_table and class
    this.primaryAccentColor = '';
    this.secondaryAccentColor = '';
    this.neutralAccentColor = '';
    Object.assign(this, init);
  }

  toJSON() {
    const s = this;
    const o = { id: s.id, type: s.type };
    if (!isEmpty(s.classes)) o.classes = s.classes;
    o.pos = s.pos;
    o.width = s.width;
    o.height = s.height;
    o.opacity = s.opacity;
    o.strokeDash = s.strokeDash;
    o.strokeWidth = s.strokeWidth;
    o.borderRadius = s.borderRadius;
    o.fill = s.fill;
    if (s.fillPattern !== '') o.fillPattern = s.fillPattern;
    o.stroke = s.stroke;
    o.animated = s.animated;
    o.shadow = s.shadow;
    o['3d'] = s['3d'];
    o.multiple = s.multiple;
    o['double-border'] = s['double-border'];
    o.tooltip = s.tooltip;
    o.link = s.link;
    if (s.prettyLink !== '') o.prettyLink = s.prettyLink;
    o.icon = s.icon;
    if (s.iconBorderRadius !== 0) o.iconBorderRadius = s.iconBorderRadius;
    o.iconPosition = s.iconPosition;
    o.blend = s.blend;
    o.fields = s.fields;
    o.methods = s.methods;
    o.columns = s.columns;
    if (s.contentAspectRatio != null) o.contentAspectRatio = s.contentAspectRatio;
    textJSON(s, o);
    if (s.labelPosition !== '') o.labelPosition = s.labelPosition;
    if (s.tooltipPosition !== '') o.tooltipPosition = s.tooltipPosition;
    o.zIndex = s.zIndex;
    o.level = s.level;
    if (s.primaryAccentColor !== '') o.primaryAccentColor = s.primaryAccentColor;
    if (s.secondaryAccentColor !== '') o.secondaryAccentColor = s.secondaryAccentColor;
    if (s.neutralAccentColor !== '') o.neutralAccentColor = s.neutralAccentColor;
    return o;
  }

  clone() { return deepClone(this); }

  getFontColor() {
    const s = this;
    if (s.type === ShapeClass || s.type === ShapeSQLTable) {
      if (!color.isThemeColor(s.color)) return s.color;
      return s.stroke;
    }
    if (s.color !== color.Empty) return s.color;
    return color.N1;
  }

  /** TODO remove this function, just set fields on themeable */
  cssStyle() {
    const s = this;
    let out = '';

    out += `stroke-width:${s.strokeWidth};`;
    if (s.strokeDash !== 0) {
      const [dashSize, gapSize] = svg.getStrokeDashAttributes(s.strokeWidth, s.strokeDash);
      out += `stroke-dasharray:${goFixed(dashSize, 6)},${goFixed(gapSize, 6)};`;
    }
    return out;
  }

  setType(t) {
    // Some types are synonyms of other types, but with hinting for autolayout
    // They should only have one representation in the final export
    if (t.toLowerCase() === ShapeCircle) t = ShapeOval;
    else if (t.toLowerCase() === ShapeSquare) t = ShapeRectangle;
    this.type = t.toLowerCase();
  }

  getZIndex() { return this.zIndex; }

  getID() { return this.id; }
}

/** BaseShape */
export function baseShape() {
  return new Shape({
    opacity: 1,
    strokeDash: 0,
    strokeWidth: 2,
    bold: true,
    fontFamily: 'DEFAULT',
  });
}

// ---- Connection ----

export class Connection {
  constructor(init = {}) {
    this.id = '';

    this.classes = null;

    this.src = '';
    this.srcArrow = '';
    this.srcLabel = null;

    this.dst = '';
    this.dstArrow = '';
    this.dstLabel = null;

    this.opacity = 0;
    this.strokeDash = 0;
    this.strokeWidth = 0;
    this.stroke = '';
    this.fill = '';
    this.borderRadius = 0;

    // Text
    this.label = '';
    this.fontSize = 0;
    this.fontFamily = '';
    this.language = '';
    this.color = '';
    this.italic = false;
    this.bold = false;
    this.underline = false;
    this.labelWidth = 0;
    this.labelHeight = 0;
    this.labelFill = '';

    this.labelPosition = '';
    this.labelPercentage = 0;

    this.link = '';
    this.prettyLink = '';

    this.route = null;
    this.isCurve = false;

    this.animated = false;
    this.tooltip = '';
    this.icon = null;
    this.iconPosition = '';
    this.iconBorderRadius = 0;

    this.zIndex = 0;
    Object.assign(this, init);
  }

  toJSON() {
    const c = this;
    const o = { id: c.id };
    if (!isEmpty(c.classes)) o.classes = c.classes;
    o.src = c.src;
    o.srcArrow = c.srcArrow;
    if (c.srcLabel != null) o.srcLabel = c.srcLabel;
    o.dst = c.dst;
    o.dstArrow = c.dstArrow;
    if (c.dstLabel != null) o.dstLabel = c.dstLabel;
    o.opacity = c.opacity;
    o.strokeDash = c.strokeDash;
    o.strokeWidth = c.strokeWidth;
    o.stroke = c.stroke;
    if (c.fill !== '') o.fill = c.fill;
    if (c.borderRadius !== 0) o.borderRadius = c.borderRadius;
    textJSON(c, o);
    o.labelPosition = c.labelPosition;
    o.labelPercentage = c.labelPercentage;
    o.link = c.link;
    if (c.prettyLink !== '') o.prettyLink = c.prettyLink;
    o.route = c.route;
    if (c.isCurve) o.isCurve = c.isCurve;
    o.animated = c.animated;
    o.tooltip = c.tooltip;
    o.icon = c.icon;
    if (c.iconPosition !== '') o.iconPosition = c.iconPosition;
    if (c.iconBorderRadius !== 0) o.iconBorderRadius = c.iconBorderRadius;
    o.zIndex = c.zIndex;
    return o;
  }

  clone() { return deepClone(this); }

  getIconPosition() {
    const c = this;
    if (c.icon == null) return null;

    if (c.label !== '') {
      const labelTL = c.getLabelTopLeft();
      if (labelTL != null) {
        // Position icon to the left of the label with a small gap
        return new geo.Point(
          labelTL.x - CONNECTION_ICON_LABEL_GAP - DEFAULT_ICON_SIZE,
          labelTL.y + c.labelHeight / 2 - DEFAULT_ICON_SIZE / 2,
        );
      }
    }

    const [point] = label.getPointOnRoute(
      label.fromString(c.iconPosition),
      c.route,
      c.strokeWidth,
      -1,
      DEFAULT_ICON_SIZE,
      DEFAULT_ICON_SIZE,
    );
    return point;
  }

  getFontColor() {
    if (this.color !== color.Empty) return this.color;
    return color.N1;
  }

  cssStyle() {
    const c = this;
    let out = '';

    out += `stroke-width:${c.strokeWidth};`;
    let strokeDash = c.strokeDash;
    if (strokeDash === 0 && c.animated) strokeDash = 5;
    if (strokeDash !== 0) {
      const [dashSize, gapSize] = svg.getStrokeDashAttributes(c.strokeWidth, strokeDash);
      out += `stroke-dasharray:${goFixed(dashSize, 6)},${goFixed(gapSize, 6)};`;

      if (c.animated) {
        let dashOffset = -10;
        if (c.srcArrow !== NoArrowhead && c.dstArrow === NoArrowhead) dashOffset = 10;
        out += `stroke-dashoffset:${goFixed(dashOffset * (dashSize + gapSize), 6)};`;
        out += `animation: dashdraw ${goFixed(gapSize * 0.5, 6)}s linear infinite;`;
      }
    }
    return out;
  }

  getLabelTopLeft() {
    const c = this;
    const [point] = label.getPointOnRoute(
      label.fromString(c.labelPosition),
      c.route,
      c.strokeWidth,
      c.labelPercentage,
      c.labelWidth,
      c.labelHeight,
    );
    return point;
  }

  getArrowheadLabelPosition(isDst) {
    const connection = this;
    let width, height;
    if (isDst) {
      width = connection.dstLabel.labelWidth;
      height = connection.dstLabel.labelHeight;
    } else {
      width = connection.srcLabel.labelWidth;
      height = connection.srcLabel.labelHeight;
    }

    // get the start/end points of edge segment with arrowhead
    let index = 0;
    if (isDst) index = connection.route.length - 2;
    const start = connection.route[index], end = connection.route[index + 1];
    // Note: end to start to get normal towards unlocked top position
    const [normalX, normalY] = geo.getUnitNormalVector(end.x, end.y, start.x, start.y);

    // determine how much to move the label back from the very end of the edge
    // e.g. if normal points up {x: 0, y:1}, shift width/2 + padding to fit
    const shift = Math.abs(normalX) * (height / 2. + label.PADDING) +
      Math.abs(normalY) * (width / 2. + label.PADDING);

    const length = geo.Route.length(connection.route);
    let position;
    if (isDst) {
      position = 1.;
      if (length > 0) position -= shift / length;
    } else {
      position = 0.;
      if (length > 0) position = shift / length;
    }

    const strokeWidth = connection.strokeWidth;

    const [labelTL] = label.getPointOnRoute(label.UnlockedTop, connection.route, strokeWidth, position, width, height);

    let arrowSize = 0;
    if (isDst && connection.dstArrow !== NoArrowhead) {
      // Note: these dimensions are for rendering arrowheads on their side so we want the height
      [, arrowSize] = arrowheadDimensions(connection.dstArrow, strokeWidth);
    } else if (connection.srcArrow !== NoArrowhead) {
      [, arrowSize] = arrowheadDimensions(connection.srcArrow, strokeWidth);
    }

    if (arrowSize > 0) {
      // labelTL already accounts for strokeWidth and padding, we only want to shift further if the arrow is larger than this
      const offset = (arrowSize / 2 + ARROWHEAD_PADDING) - strokeWidth / 2 - label.PADDING;
      if (offset > 0) {
        labelTL.x += normalX * offset;
        labelTL.y += normalY * offset;
      }
    }

    return labelTL;
  }

  getZIndex() { return this.zIndex; }

  getID() { return this.id; }
}

/** BaseConnection */
export function baseConnection() {
  return new Connection({
    srcArrow: NoArrowhead,
    dstArrow: NoArrowhead,
    route: [],
    opacity: 1,
    strokeDash: 0,
    strokeWidth: 2,
    borderRadius: 10,
    italic: true,
    fontFamily: 'DEFAULT',
  });
}

// ---- Arrowhead ----

export const NoArrowhead = 'none';
export const ArrowArrowhead = 'arrow';
export const UnfilledTriangleArrowhead = 'unfilled-triangle';
export const TriangleArrowhead = 'triangle';
export const DiamondArrowhead = 'diamond';
export const FilledDiamondArrowhead = 'filled-diamond';
export const CircleArrowhead = 'circle';
export const FilledCircleArrowhead = 'filled-circle';
export const CrossArrowhead = 'cross';
export const BoxArrowhead = 'box';
export const FilledBoxArrowhead = 'filled-box';

/** For fat arrows */
export const LineArrowhead = 'line';

/** Crows feet notation */
export const CfOne = 'cf-one';
export const CfMany = 'cf-many';
export const CfOneRequired = 'cf-one-required';
export const CfManyRequired = 'cf-many-required';

export const DefaultArrowhead = TriangleArrowhead;

/** valid values for arrowhead.shape */
export const Arrowheads = new Set([NoArrowhead, ArrowArrowhead, TriangleArrowhead, DiamondArrowhead, CircleArrowhead, BoxArrowhead, CfOne, CfMany, CfOneRequired, CfManyRequired, CrossArrowhead]);

/** filled is true, false or null (Go's *bool) */
export function toArrowhead(arrowheadType, filled) {
  switch (arrowheadType) {
    case DiamondArrowhead:
      if (filled != null && filled) return FilledDiamondArrowhead;
      return DiamondArrowhead;
    case CircleArrowhead:
      if (filled != null && filled) return FilledCircleArrowhead;
      return CircleArrowhead;
    case NoArrowhead:
      return NoArrowhead;
    case ArrowArrowhead:
      return ArrowArrowhead;
    case TriangleArrowhead:
      if (filled != null && !filled) return UnfilledTriangleArrowhead;
      return TriangleArrowhead;
    case CrossArrowhead:
      return CrossArrowhead;
    case BoxArrowhead:
      if (filled != null && filled) return FilledBoxArrowhead;
      return BoxArrowhead;
    case CfOne:
      return CfOne;
    case CfMany:
      return CfMany;
    case CfOneRequired:
      return CfOneRequired;
    case CfManyRequired:
      return CfManyRequired;
    default:
      if (DefaultArrowhead === TriangleArrowhead && filled != null && !filled) return UnfilledTriangleArrowhead;
      return DefaultArrowhead;
  }
}

/** Arrowhead.Dimensions: [width, height] */
export function arrowheadDimensions(arrowhead, strokeWidth) {
  let baseWidth = 0, baseHeight = 0;
  let widthMultiplier = 0, heightMultiplier = 0;
  switch (arrowhead) {
    case ArrowArrowhead:
      baseWidth = 4;
      baseHeight = 4;
      widthMultiplier = 4;
      heightMultiplier = 4;
      break;
    case TriangleArrowhead:
      baseWidth = 4;
      baseHeight = 4;
      widthMultiplier = 3;
      heightMultiplier = 4;
      break;
    case UnfilledTriangleArrowhead:
      baseWidth = 7;
      baseHeight = 7;
      widthMultiplier = 3;
      heightMultiplier = 4;
      break;
    case LineArrowhead:
      widthMultiplier = 5;
      heightMultiplier = 8;
      break;
    case FilledDiamondArrowhead:
      baseWidth = 11;
      baseHeight = 7;
      widthMultiplier = 5.5;
      heightMultiplier = 3.5;
      break;
    case DiamondArrowhead:
      baseWidth = 11;
      baseHeight = 9;
      widthMultiplier = 5.5;
      heightMultiplier = 4.5;
      break;
    case CrossArrowhead:
      baseWidth = 7;
      baseHeight = 7;
      widthMultiplier = 5;
      heightMultiplier = 5;
      break;
    case FilledCircleArrowhead: case CircleArrowhead:
      baseWidth = 8;
      baseHeight = 8;
      widthMultiplier = 5;
      heightMultiplier = 5;
      break;
    case FilledBoxArrowhead: case BoxArrowhead:
      baseWidth = 6;
      baseHeight = 6;
      widthMultiplier = 5;
      heightMultiplier = 5;
      break;
    case CfOne: case CfMany: case CfOneRequired: case CfManyRequired:
      baseWidth = 9;
      baseHeight = 9;
      widthMultiplier = 4.5;
      heightMultiplier = 4.5;
      break;
  }

  const clippedStrokeWidth = go2Max(MIN_ARROWHEAD_STROKE_WIDTH, strokeWidth);
  return [baseWidth + clippedStrokeWidth * widthMultiplier, baseHeight + clippedStrokeWidth * heightMultiplier];
}

// ---- Point ----

/** d2target.Point: integer x, y (not geo.Point) */
export class Point {
  constructor(x = 0, y = 0) { this.x = x; this.y = y; }
}
export const newPoint = (x, y) => new Point(x, y);

// ---- shape types ----

export const ShapeRectangle = 'rectangle';
export const ShapeSquare = 'square';
export const ShapePage = 'page';
export const ShapeParallelogram = 'parallelogram';
export const ShapeDocument = 'document';
export const ShapeCylinder = 'cylinder';
export const ShapeQueue = 'queue';
export const ShapePackage = 'package';
export const ShapeStep = 'step';
export const ShapeCallout = 'callout';
export const ShapeStoredData = 'stored_data';
export const ShapePerson = 'person';
export const ShapeC4Person = 'c4-person';
export const ShapeDiamond = 'diamond';
export const ShapeOval = 'oval';
export const ShapeCircle = 'circle';
export const ShapeHexagon = 'hexagon';
export const ShapeCloud = 'cloud';
export const ShapeText = 'text';
export const ShapeCode = 'code';
export const ShapeClass = 'class';
export const ShapeSQLTable = 'sql_table';
export const ShapeImage = 'image';
export const ShapeSequenceDiagram = 'sequence_diagram';
export const ShapeHierarchy = 'hierarchy';

export const Shapes = [
  ShapeRectangle, ShapeSquare, ShapePage, ShapeParallelogram, ShapeDocument, ShapeCylinder, ShapeQueue, ShapePackage, ShapeStep, ShapeCallout,
  ShapeStoredData, ShapePerson, ShapeC4Person, ShapeDiamond, ShapeOval, ShapeCircle, ShapeHexagon, ShapeCloud, ShapeText, ShapeCode, ShapeClass,
  ShapeSQLTable, ShapeImage, ShapeSequenceDiagram, ShapeHierarchy,
];

export function isShape(s) {
  if (s === '') return true; // Default shape is rectangle.
  const l = s.toLowerCase();
  for (const s2 of Shapes) if (l === s2) return true;
  return false;
}

// ---- MText ----

export class MText {
  constructor(init = {}) {
    this.text = '';
    this.fontSize = 0;
    this.isBold = false;
    this.isItalic = false;
    this.isUnderline = false;
    this.language = '';
    this.shape = '';
    this.dimensions = new TextDimensions();
    Object.assign(this, init);
  }
  getColor(isItalic) {
    if (isItalic) return color.N2;
    return color.N1;
  }
  toJSON() {
    return {
      text: this.text, fontSize: this.fontSize, isBold: this.isBold, isItalic: this.isItalic, isUnderline: this.isUnderline,
      language: this.language, shape: this.shape, dimensions: this.dimensions,
    };
  }
}

export class TextDimensions {
  constructor(width = 0, height = 0) { this.width = width; this.height = height; }
}
export const newTextDimensions = (w, h) => new TextDimensions(w, h);

export const DSL_SHAPE_TO_SHAPE_TYPE = {
  '': shape.SQUARE_TYPE,
  [ShapeRectangle]: shape.SQUARE_TYPE,
  [ShapeSquare]: shape.REAL_SQUARE_TYPE,
  [ShapePage]: shape.PAGE_TYPE,
  [ShapeParallelogram]: shape.PARALLELOGRAM_TYPE,
  [ShapeDocument]: shape.DOCUMENT_TYPE,
  [ShapeCylinder]: shape.CYLINDER_TYPE,
  [ShapeQueue]: shape.QUEUE_TYPE,
  [ShapePackage]: shape.PACKAGE_TYPE,
  [ShapeStep]: shape.STEP_TYPE,
  [ShapeCallout]: shape.CALLOUT_TYPE,
  [ShapeStoredData]: shape.STORED_DATA_TYPE,
  [ShapePerson]: shape.PERSON_TYPE,
  [ShapeC4Person]: shape.C4_PERSON_TYPE,
  [ShapeDiamond]: shape.DIAMOND_TYPE,
  [ShapeOval]: shape.OVAL_TYPE,
  [ShapeCircle]: shape.CIRCLE_TYPE,
  [ShapeHexagon]: shape.HEXAGON_TYPE,
  [ShapeCloud]: shape.CLOUD_TYPE,
  [ShapeText]: shape.TEXT_TYPE,
  [ShapeCode]: shape.CODE_TYPE,
  [ShapeClass]: shape.CLASS_TYPE,
  [ShapeSQLTable]: shape.TABLE_TYPE,
  [ShapeImage]: shape.IMAGE_TYPE,
  [ShapeSequenceDiagram]: shape.SQUARE_TYPE,
  [ShapeHierarchy]: shape.SQUARE_TYPE,
};

export const SHAPE_TYPE_TO_DSL_SHAPE = {};
// Go builds this from a map in random order; SQUARE_TYPE is defined by several keys ('', rectangle,
// sequence_diagram, hierarchy), so it is then forced to rectangle. The other values have a single key each.
for (const [k, v] of Object.entries(DSL_SHAPE_TO_SHAPE_TYPE)) SHAPE_TYPE_TO_DSL_SHAPE[v] = k;
SHAPE_TYPE_TO_DSL_SHAPE[shape.SQUARE_TYPE] = ShapeRectangle;

export function getIconSize(box, position) {
  const iconPosition = label.fromString(position);

  const minDimension = goInt(Math.min(box.Width, box.Height));
  const halfMinDimension = goInt(Math.ceil(0.5 * minDimension));

  let size;

  if (iconPosition === label.InsideMiddleCenter) {
    size = halfMinDimension;
  } else {
    size = go2Min(minDimension, go2Max(DEFAULT_ICON_SIZE, halfMinDimension));
  }

  size = go2Min(size, MAX_ICON_SIZE);

  if (!label.isOutside(iconPosition)) {
    size = go2Min(size,
      go2Min(
        go2Max(goInt(box.Width) - 2 * label.PADDING, 0),
        go2Max(goInt(box.Height) - 2 * label.PADDING, 0),
      ));
  }

  return size;
}

// ---- class.go ----

export const PrefixPadding = 10;
export const PrefixWidth = 20;
export const CenterPadding = 50;
/** 10px of padding top and bottom so text doesn't look squished */
export const VerticalPadding = 20;

/** Go's d2target.Class: the fields and methods of a `shape: class`. */
export class Class {
  constructor(init = {}) {
    this.fields = null;
    this.methods = null;
    Object.assign(this, init);
  }
}

export class ClassField {
  constructor(init = {}) {
    this.name = '';
    this.type = '';
    this.visibility = '';
    this.underline = false;
    Object.assign(this, init);
  }
  text(fontSize) { return classFieldText(this, fontSize); }
  visibilityToken() { return classVisibilityToken(this); }
}

export class ClassMethod {
  constructor(init = {}) {
    this.name = '';
    this.return = '';
    this.visibility = '';
    this.underline = false;
    Object.assign(this, init);
  }
  text(fontSize) { return classMethodText(this, fontSize); }
  visibilityToken() { return classVisibilityToken(this); }
}

// the functions below also work on plain objects with the same fields
export function classFieldText(cf, fontSize) {
  return new MText({
    text: `${cf.name}${cf.type}`,
    fontSize,
    isBold: false,
    isItalic: false,
    isUnderline: cf.underline,
    shape: 'class',
  });
}

export function classMethodText(cm, fontSize) {
  return new MText({
    text: `${cm.name}${cm.return}`,
    fontSize,
    isBold: false,
    isItalic: false,
    isUnderline: cm.underline,
    shape: 'class',
  });
}

/** ClassField.VisibilityToken / ClassMethod.VisibilityToken */
export function classVisibilityToken(c) {
  switch (c.visibility) {
    case 'protected': return '#';
    case 'private': return '-';
    default: return '+';
  }
}

// ---- sqltable.go ----

export const NamePadding = 10;
export const TypePadding = 20;
export const ConstraintPadding = 20;
export const HeaderPadding = 10;

/** Setting table font size sets it for columns. The header needs to be a little larger for visual hierarchy */
export const HeaderFontAdd = 4;

/** Go's d2target.SQLTable: the columns of a `shape: sql_table`. */
export class SQLTable {
  constructor(init = {}) {
    this.columns = null;
    Object.assign(this, init);
  }
}

export class SQLColumn {
  constructor(init = {}) {
    this.name = new Text();
    this.type = new Text();
    this.constraint = null;
    this.reference = '';
    Object.assign(this, init);
  }
  texts(fontSize) { return sqlColumnTexts(this, fontSize); }
  constraintAbbr() { return sqlConstraintAbbr(this); }
}

export function sqlColumnTexts(c, fontSize) {
  return [
    new MText({ text: c.name.label, fontSize, isBold: false, isItalic: false, shape: 'sql_table' }),
    new MText({ text: c.type.label, fontSize, isBold: false, isItalic: false, shape: 'sql_table' }),
    new MText({ text: sqlConstraintAbbr(c), fontSize, isBold: false, isItalic: false, shape: 'sql_table' }),
  ];
}

export function sqlConstraintAbbr(c) {
  const constraints = (c.constraint ?? []).map((constraint) => {
    switch (constraint) {
      case 'primary_key': return 'PK';
      case 'foreign_key': return 'FK';
      case 'unique': return 'UNQ';
      default: return constraint;
    }
  });
  return constraints.join(', ');
}

// ---- JSON -> instances (Go's json.Unmarshal into these structs) ----

const textFromJSON = (o) => (o == null ? null : new Text(o));

export function shapeFromJSON(o) {
  const s = new Shape(o);
  s.pos = new Point(o.pos?.x ?? 0, o.pos?.y ?? 0);
  if (s.fields != null) s.fields = s.fields.map((f) => new ClassField(f));
  if (s.methods != null) s.methods = s.methods.map((m) => new ClassMethod(m));
  if (s.columns != null) {
    s.columns = s.columns.map((c) => new SQLColumn({ ...c, name: new Text(c.name), type: new Text(c.type) }));
  }
  return s;
}

export function connectionFromJSON(o) {
  const c = new Connection(o);
  c.srcLabel = textFromJSON(o.srcLabel);
  c.dstLabel = textFromJSON(o.dstLabel);
  if (c.route != null) c.route = c.route.map((p) => geo.newPoint(p.x, p.y));
  return c;
}

export function diagramFromJSON(o) {
  const d = new Diagram(o);
  if (o.config != null) {
    d.config = new Config(o.config);
    if (o.config.themeOverrides != null) d.config.themeOverrides = new ThemeOverrides(o.config.themeOverrides);
    if (o.config.darkThemeOverrides != null) d.config.darkThemeOverrides = new ThemeOverrides(o.config.darkThemeOverrides);
  }
  d.root = shapeFromJSON(o.root ?? {});
  if (d.shapes != null) d.shapes = d.shapes.map(shapeFromJSON);
  if (d.connections != null) d.connections = d.connections.map(connectionFromJSON);
  if (o.legend != null) {
    d.legend = new Legend(o.legend);
    if (d.legend.shapes != null) d.legend.shapes = d.legend.shapes.map(shapeFromJSON);
    if (d.legend.connections != null) d.legend.connections = d.legend.connections.map(connectionFromJSON);
  }
  for (const k of ['layers', 'scenarios', 'steps']) if (d[k] != null) d[k] = d[k].map(diagramFromJSON);
  return d;
}
