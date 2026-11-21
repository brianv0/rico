// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of D2's d2graph package (oss.terrastruct.com/d2 v0.7.2, Copyright 2022 Terrastruct Inc.): the graph that
// d2compiler builds from the IR. d2graph.go, layout.go, seqdiagram.go and grid_diagram.go; not serde.go (the exec plugin's
// wire format) and not Graph.SetDimensions (the layout stage), though the functions it is made of are here.
//
// Same names (camelCase), same control flow. Conventions that differ from Go because JavaScript has no embedding or typed nil:
//  - Go's `Object` is `GraphObject` (it would shadow JavaScript's). Its embedded `*geo.Box` is the property `box`
//    (null until layout), and its embedded `Attributes` is `attributes`: Go's `obj.Shape.Value` is `obj.attributes.shape.value`.
//    Edge embeds Attributes the same way. `Object.LabelPosition` (*string) is `labelPosition`; the Scalar of the same Go name
//    that lives in Attributes is `attributes.labelPosition`.
//  - nil slices are null (so "edges": null prints like Go), nil pointers are null, Children is a Map or null.
//  - d2ast.String / d2ast.Scalar values are boxes (`{ unquoted_string: node }`, see ast.js), as in d2ir.js.
//  - Every class has the toJSON() that json.Marshal of the Go struct would give (names from the json tags, omitempty).
//  - Go copies structs on assignment; where that is observable, clone() or an explicit copy is used.

import {
  unbox, scalarString, rawString, equalFold, goLower, posBefore,
  ReservedKeywords, ReservedKeywordHolders, NearConstants, FillPatterns, TextTransforms, Range, isSpace,
} from './ast.js';
import { format } from './format.js';
import { parseKey } from './parser.js';
import * as d2target from './target.js';
import * as d2fonts from './fonts.js';
import * as color from './color.js';
import * as geo from './geo.js';
import * as label from './label.js';
import * as shape from './shape.js';
import * as d2themescatalog from './themes.js';
import { getTextDimensions, getTextDimensionsWithMono, measureMarkdown, findMeasured } from './textmeasure.js';
import { atoi as strconvAtoi, parseBool as strconvParseBool, parseFloat64 } from './strconv.js';
import { sprintf } from './gofmt.js';
import { sortSlice } from './gosort.js';

export const INNER_LABEL_PADDING = 5;
export const DEFAULT_SHAPE_SIZE = 100.;
export const MIN_SHAPE_SIZE = 5;

const ss = scalarString;
const isUnquoted = (b) => !!b.unquoted_string;
const lc = goLower;
/** `append(a, items...)` on a possibly-nil slice. */
const append = (a, ...items) => (a ? [...a, ...items] : items);
const goMax = (a, b) => (a > b ? a : b);
const goTrimSpace = (s) => { let a = 0, b = s.length; while (a < b && isSpace(s[a])) a++; while (b > a && isSpace(s[b - 1])) b--; return s.slice(a, b); };

// ---- Graph ----

export class Graph {
  constructor() {
    /** fs.FS (json "-") */
    this.fs = null;
    /** *Graph (json "-") */
    this.parent = null;
    this.name = '';
    /**
     * IsFolderOnly indicates a board or scenario itself makes no modifications from its
     * base. Folder only boards do not have a render and are used purely for organizing
     * the board tree.
     */
    this.isFolderOnly = false;
    this.ast = null;
    /** BaseAST is the AST of the original graph without inherited fields and edges (json "-") */
    this.baseAST = null;

    this.root = null;
    this.legend = null;
    this.edges = null;
    this.objects = null;

    this.layers = null;
    this.scenarios = null;
    this.steps = null;

    this.theme = null;

    /** Object.Level uses the location of a nested graph */
    this.rootLevel = 0;

    /**
     * Currently this holds data embedded from source code configuration variables
     * Plugins only have access to exported graph, so this data structure allows
     * carrying arbitrary metadata that any plugin might handle
     */
    this.data = null;
  }

  toJSON() {
    const o = { name: this.name, isFolderOnly: this.isFolderOnly, ast: this.ast, root: this.root };
    if (this.legend) o.legend = this.legend;
    o.edges = this.edges;
    o.objects = this.objects;
    if (this.layers && this.layers.length) o.layers = this.layers;
    if (this.scenarios && this.scenarios.length) o.scenarios = this.scenarios;
    if (this.steps && this.steps.length) o.steps = this.steps;
    if (this.theme) o.theme = this.theme;
    if (this.rootLevel !== 0) o.rootLevel = this.rootLevel;
    if (this.data && Object.keys(this.data).length) o.data = Object.fromEntries(Object.keys(this.data).sort().map((k) => [k, this.data[k]]));
    return o;
  }

  rootBoard() {
    let g = this;
    while (g.parent !== null) g = g.parent;
    return g;
  }

  IDA() {
    if (this === null) return null;
    let parts = [];

    let current = this;
    while (current !== null) {
      if (current.name !== '') parts.push(current.name);
      current = current.parent;
    }

    for (let i = 0; i < Math.trunc(parts.length / 2); i++) {
      const j = parts.length - 1 - i;
      [parts[i], parts[j]] = [parts[j], parts[i]];
    }

    if (parts.length === 0) return ['root'];

    parts = ['root', ...parts];

    const g = this;
    if (g.parent !== null) {
      let containerName = '';
      if ((g.parent.layers || []).length > 0) {
        for (const l of g.parent.layers) {
          if (l === g) { containerName = 'layers'; break; }
        }
      }
      if ((g.parent.scenarios || []).length > 0) {
        for (const s of g.parent.scenarios) {
          if (s === g) { containerName = 'scenarios'; break; }
        }
      }
      if ((g.parent.steps || []).length > 0) {
        for (const s of g.parent.steps) {
          if (s === g) { containerName = 'steps'; break; }
        }
      }
      if (containerName !== '') parts = [...parts.slice(0, 1), containerName, ...parts.slice(1)];
    }

    return parts;
  }

  texts() {
    let texts = null;

    const capsLock = this.theme !== null && this.theme.specialRules.capsLock;

    for (const obj of this.objects || []) {
      if (obj.attributes.label.value !== '') {
        obj.attributes.applyTextTransform();
        const text = obj.text();
        if (capsLock && !equalFold(obj.attributes.shape.value, d2target.ShapeCode)) {
          if (obj.attributes.language !== 'latex' && !obj.attributes.style.noneTextTransform()) text.text = goUpper(text.text);
        }
        texts = appendTextDedup(texts, text);
      }
      if (obj.class !== null) {
        let fontSize = d2fonts.FONT_SIZE_L;
        if (obj.attributes.style.fontSize !== null) [fontSize] = strconvAtoi(obj.attributes.style.fontSize.value);
        for (const field of obj.class.fields || []) texts = appendTextDedup(texts, field.text(fontSize));
        for (const method of obj.class.methods || []) texts = appendTextDedup(texts, method.text(fontSize));
      } else if (obj.sqlTable !== null) {
        let colFontSize = d2fonts.FONT_SIZE_L;
        if (obj.attributes.style.fontSize !== null) [colFontSize] = strconvAtoi(obj.attributes.style.fontSize.value);
        for (const column of obj.sqlTable.columns || []) {
          for (const t of column.texts(colFontSize)) texts = appendTextDedup(texts, t);
        }
      }
    }
    for (const edge of this.edges || []) {
      if (edge.attributes.label.value !== '') {
        edge.attributes.applyTextTransform();
        const text = edge.text();
        if (capsLock && !edge.attributes.style.noneTextTransform()) text.text = goUpper(text.text);
        texts = appendTextDedup(texts, text);
      }
      if (edge.srcArrowhead !== null && edge.srcArrowhead.label.value !== '') {
        const t = edge.text();
        t.text = edge.srcArrowhead.label.value;
        texts = appendTextDedup(texts, t);
      }
      if (edge.dstArrowhead !== null && edge.dstArrowhead.label.value !== '') {
        const t = edge.text();
        t.text = edge.dstArrowhead.label.value;
        texts = appendTextDedup(texts, t);
      }
    }

    for (const board of this.layers || []) for (const t of board.texts() || []) texts = appendTextDedup(texts, t);
    for (const board of this.scenarios || []) for (const t of board.texts() || []) texts = appendTextDedup(texts, t);
    for (const board of this.steps || []) for (const t of board.texts() || []) texts = appendTextDedup(texts, t);

    return texts;
  }

  getBoard(name) {
    for (const l of this.layers || []) if (l.name === name) return l;
    for (const l of this.scenarios || []) if (l.name === name) return l;
    for (const l of this.steps || []) if (l.name === name) return l;
    return null;
  }

  sortObjectsByAST() {
    const objects = (this.objects || []).length ? [...this.objects] : null; // append([]*Object(nil), g.Objects...)
    sortSlice(objects || [], (i, j) => {
      const o1 = objects[i];
      const o2 = objects[j];
      if ((o1.references || []).length === 0 || (o2.references || []).length === 0) return i < j;
      const r1 = o1.references[0];
      const r2 = o2.references[0];
      // If they are variable substitutions, leave them alone, as their
      // references reflect where the variable is, not where the substitution is
      if (r1.isVar || r2.isVar) return i < j;
      return rangeBefore(unbox(r1.key.path[r1.keyPathIndex]).range, unbox(r2.key.path[r2.keyPathIndex]).range);
    });
    this.objects = objects;
  }

  sortEdgesByAST() {
    const edges = (this.edges || []).length ? [...this.edges] : null; // append([]*Edge(nil), g.Edges...)
    sortSlice(edges || [], (i, j) => {
      const e1 = edges[i];
      const e2 = edges[j];
      if ((e1.references || []).length === 0 || (e2.references || []).length === 0) return i < j;
      return rangeBefore(e1.references[0].edge.range, e2.references[0].edge.range);
    });
    this.edges = edges;
  }

  /**
   * ApplyTheme applies themes on the graph level
   * This is different than on the render level, which only changes colors
   * A theme applied on the graph level applies special rules that change the graph
   * @returns {string|null} error message
   */
  applyTheme(themeID) {
    const theme = d2themescatalog.find(themeID);
    if (!d2themescatalog.themeExists(themeID)) return `theme ${themeID} not found`;
    this.theme = theme;
    return null;
  }

  printString() {
    let buf = 'Objects: [';
    for (const obj of this.objects || []) buf += `${obj.absID()}, `;
    buf += ']';
    return buf;
  }

  /** remove obj and all descendants from graph, as a new Graph */
  extractAsNestedGraph(obj) {
    const [descendantObjects, edges] = pluckObjAndEdges(this, obj);

    const tempGraph = newGraph();
    tempGraph.rootLevel = obj.level() - 1;
    tempGraph.root.childrenArray = [obj];
    tempGraph.root.children.set(lc(obj.id), obj);

    for (const descendantObj of descendantObjects || []) descendantObj.graph = tempGraph;
    tempGraph.objects = descendantObjects;
    tempGraph.edges = edges;

    obj.parent.removeChild(obj);
    obj.parent = tempGraph.root;

    return tempGraph;
  }

  injectNestedGraph(tempGraph, parent) {
    const obj = tempGraph.root.childrenArray[0];
    const dx = 0 - obj.box.TopLeft.x;
    const dy = 0 - obj.box.TopLeft.y;
    obj.moveWithDescendants(dx, dy);
    for (const e of tempGraph.edges || []) e.move(dx, dy);
    obj.parent = parent;
    for (const o of tempGraph.objects || []) o.graph = this;
    this.objects = append(this.objects, ...(tempGraph.objects || []));
    parent.children.set(lc(obj.id), obj);
    parent.childrenArray = append(parent.childrenArray, obj);
    this.edges = append(this.edges, ...(tempGraph.edges || []));
  }
}

const rangeBefore = (r1, r2) => posBefore(r1.start, r2.start);

export function newGraph() {
  const d = new Graph();
  d.root = new GraphObject();
  d.root.graph = d;
  d.root.parent = null;
  d.root.children = new Map();
  return d;
}

export class Legend {
  constructor() {
    this.label = '';
    this.objects = null;
    this.edges = null;
  }
  toJSON() {
    const o = {};
    if (this.label !== '') o.label = this.label;
    if (this.objects && this.objects.length) o.objects = this.objects;
    if (this.edges && this.edges.length) o.edges = this.edges;
    return o;
  }
}

// ---- Scalar ----

/**
 * TODO consider having different Scalar types
 * Right now we'll hold any types in Value and just convert, e.g. floats
 */
export class Scalar {
  constructor(value = '', mapKey = null) {
    this.value = value;
    /** *d2ast.Key (json "-") */
    this.mapKey = mapKey;
  }
  toJSON() { return { value: this.value }; }
}

// ---- Attributes, Style ----

export class Style {
  constructor() {
    this.opacity = null;
    this.stroke = null;
    this.fill = null;
    this.fillPattern = null;
    this.strokeWidth = null;
    this.strokeDash = null;
    this.borderRadius = null;
    this.shadow = null;
    this.threeDee = null;
    this.multiple = null;
    this.font = null;
    this.fontSize = null;
    this.fontColor = null;
    this.animated = null;
    this.bold = null;
    this.italic = null;
    this.underline = null;
    this.filled = null;
    this.doubleBorder = null;
    this.textTransform = null;
  }

  toJSON() {
    const o = {};
    const put = (k, v) => { if (v !== null) o[k] = v; };
    put('opacity', this.opacity);
    put('stroke', this.stroke);
    put('fill', this.fill);
    put('fillPattern', this.fillPattern);
    put('strokeWidth', this.strokeWidth);
    put('strokeDash', this.strokeDash);
    put('borderRadius', this.borderRadius);
    put('shadow', this.shadow);
    put('3d', this.threeDee);
    put('multiple', this.multiple);
    put('font', this.font);
    put('fontSize', this.fontSize);
    put('fontColor', this.fontColor);
    put('animated', this.animated);
    put('bold', this.bold);
    put('italic', this.italic);
    put('underline', this.underline);
    put('filled', this.filled);
    put('doubleBorder', this.doubleBorder);
    put('textTransform', this.textTransform);
    return o;
  }

  /**
   * NoneTextTransform will return a boolean if the text should not have any
   * transformation applied. This should overwrite theme specific transformations
   * like `CapsLock` from the `terminal` theme.
   */
  noneTextTransform() {
    return this.textTransform !== null && this.textTransform.value === 'none';
  }

  /** @returns {string|null} the error message */
  apply(key, value) {
    const s = this;
    switch (key) {
      case 'opacity': {
        if (s.opacity === null) break;
        const [f, err] = parseFloat64(value);
        if (err !== null || (f < 0 || f > 1)) return 'expected "opacity" to be a number between 0.0 and 1.0';
        s.opacity.value = value;
        break;
      }
      case 'stroke':
        if (s.stroke === null) break;
        if (!color.validColor(value)) return 'expected "stroke" to be a valid named color ("orange"), a hex code ("#f0ff3a"), or a gradient ("linear-gradient(red, blue)")';
        s.stroke.value = value;
        break;
      case 'fill':
        if (s.fill === null) break;
        if (!color.validColor(value)) return 'expected "fill" to be a valid named color ("orange"), a hex code ("#f0ff3a"), or a gradient ("linear-gradient(red, blue)")';
        s.fill.value = value;
        break;
      case 'fill-pattern':
        if (s.fillPattern === null) break;
        if (!FillPatterns.includes(lc(value))) return sprintf('expected "fill-pattern" to be one of: %s', FillPatterns.join(', '));
        s.fillPattern.value = value;
        break;
      case 'stroke-width': {
        if (s.strokeWidth === null) break;
        const [f, err] = strconvAtoi(value);
        if (err !== null || (f < 0 || f > 15)) return 'expected "stroke-width" to be a number between 0 and 15';
        s.strokeWidth.value = value;
        break;
      }
      case 'stroke-dash': {
        if (s.strokeDash === null) break;
        const [f, err] = strconvAtoi(value);
        if (err !== null || (f < 0 || f > 10)) return 'expected "stroke-dash" to be a number between 0 and 10';
        s.strokeDash.value = value;
        break;
      }
      case 'border-radius': {
        if (s.borderRadius === null) break;
        const [f, err] = strconvAtoi(value);
        if (err !== null || (f < 0)) return 'expected "border-radius" to be a number greater or equal to 0';
        s.borderRadius.value = value;
        break;
      }
      case 'shadow': {
        if (s.shadow === null) break;
        const [, err] = strconvParseBool(value);
        if (err !== null) return 'expected "shadow" to be true or false';
        s.shadow.value = value;
        break;
      }
      case '3d': {
        if (s.threeDee === null) break;
        const [, err] = strconvParseBool(value);
        if (err !== null) return 'expected "3d" to be true or false';
        s.threeDee.value = value;
        break;
      }
      case 'multiple': {
        if (s.multiple === null) break;
        const [, err] = strconvParseBool(value);
        if (err !== null) return 'expected "multiple" to be true or false';
        s.multiple.value = value;
        break;
      }
      case 'font':
        if (s.font === null) break;
        if (!Object.prototype.hasOwnProperty.call(d2fonts.D2_FONT_TO_FAMILY, lc(value))) return sprintf('"%v" is not a valid font in our system', value);
        s.font.value = lc(value);
        break;
      case 'font-size': {
        if (s.fontSize === null) break;
        const [f, err] = strconvAtoi(value);
        if (err !== null || (f < 8 || f > 100)) return 'expected "font-size" to be a number between 8 and 100';
        s.fontSize.value = value;
        break;
      }
      case 'font-color':
        if (s.fontColor === null) break;
        if (!color.validColor(value)) return 'expected "font-color" to be a valid named color ("orange"), a hex code ("#f0ff3a"), or a gradient ("linear-gradient(red, blue)")';
        s.fontColor.value = value;
        break;
      case 'animated': {
        if (s.animated === null) break;
        const [, err] = strconvParseBool(value);
        if (err !== null) return 'expected "animated" to be true or false';
        s.animated.value = value;
        break;
      }
      case 'bold': {
        if (s.bold === null) break;
        const [, err] = strconvParseBool(value);
        if (err !== null) return 'expected "bold" to be true or false';
        s.bold.value = value;
        break;
      }
      case 'italic': {
        if (s.italic === null) break;
        const [, err] = strconvParseBool(value);
        if (err !== null) return 'expected "italic" to be true or false';
        s.italic.value = value;
        break;
      }
      case 'underline': {
        if (s.underline === null) break;
        const [, err] = strconvParseBool(value);
        if (err !== null) return 'expected "underline" to be true or false';
        s.underline.value = value;
        break;
      }
      case 'filled': {
        if (s.filled === null) break;
        const [, err] = strconvParseBool(value);
        if (err !== null) return 'expected "filled" to be true or false';
        s.filled.value = value;
        break;
      }
      case 'double-border': {
        if (s.doubleBorder === null) break;
        const [, err] = strconvParseBool(value);
        if (err !== null) return 'expected "double-border" to be true or false';
        s.doubleBorder.value = value;
        break;
      }
      case 'text-transform':
        if (s.textTransform === null) break;
        if (!TextTransforms.includes(lc(value))) return sprintf('expected "text-transform" to be one of (%s)', TextTransforms.join(', '));
        s.textTransform.value = value;
        break;
      default:
        return sprintf('unknown style key: %s', key);
    }
    return null;
  }
}

export class Attributes {
  constructor() {
    this.label = new Scalar();
    this.labelDimensions = new d2target.TextDimensions();

    this.style = new Style();
    /** *url.URL */
    this.icon = null;
    this.iconStyle = new Style();
    this.tooltip = null;
    this.link = null;

    this.widthAttr = null;
    this.heightAttr = null;

    this.top = null;
    this.left = null;

    /** TODO consider separate Attributes struct for shape-specific and edge-specific; Shapes only */
    this.nearKey = null;
    this.language = '';
    /** TODO: default to ShapeRectangle instead of empty string */
    this.shape = new Scalar();

    this.direction = new Scalar();
    this.constraint = null;

    this.gridRows = null;
    this.gridColumns = null;
    this.gridGap = null;
    this.verticalGap = null;
    this.horizontalGap = null;

    this.labelPosition = null;
    this.iconPosition = null;
    this.tooltipPosition = null;

    /** These names are attached to the rendered elements in SVG so that users can target them however they like outside of D2 */
    this.classes = null;
  }

  toJSON() {
    const o = { label: this.label, labelDimensions: this.labelDimensions, style: this.style };
    if (this.icon !== null) o.icon = this.icon;
    o.iconStyle = this.iconStyle;
    if (this.tooltip !== null) o.tooltip = this.tooltip;
    if (this.link !== null) o.link = this.link;
    if (this.widthAttr !== null) o.width = this.widthAttr;
    if (this.heightAttr !== null) o.height = this.heightAttr;
    if (this.top !== null) o.top = this.top;
    if (this.left !== null) o.left = this.left;
    o.near_key = this.nearKey;
    if (this.language !== '') o.language = this.language;
    o.shape = this.shape;
    o.direction = this.direction;
    o.constraint = this.constraint;
    if (this.gridRows !== null) o.gridRows = this.gridRows;
    if (this.gridColumns !== null) o.gridColumns = this.gridColumns;
    if (this.gridGap !== null) o.gridGap = this.gridGap;
    if (this.verticalGap !== null) o.verticalGap = this.verticalGap;
    if (this.horizontalGap !== null) o.horizontalGap = this.horizontalGap;
    if (this.labelPosition !== null) o.labelPosition = this.labelPosition;
    if (this.iconPosition !== null) o.iconPosition = this.iconPosition;
    if (this.tooltipPosition !== null) o.tooltipPosition = this.tooltipPosition;
    if (this.classes && this.classes.length) o.classes = this.classes;
    return o;
  }

  /**
   * ApplyTextTransform will alter the `Label.Value` of the current object based
   * on the specification of the `text-transform` styling option. This function
   * has side-effects!
   */
  applyTextTransform() {
    const a = this;
    if (a.style.noneTextTransform()) return;

    if (a.style.textTransform !== null && a.style.textTransform.value === 'uppercase') a.label.value = goUpper(a.label.value);
    if (a.style.textTransform !== null && a.style.textTransform.value === 'lowercase') a.label.value = lc(a.label.value);
    if (a.style.textTransform !== null && a.style.textTransform.value === 'capitalize') a.label.value = titleCase(a.label.value);
  }

  toArrowhead() {
    let filled = null;
    if (this.style.filled !== null) {
      const [v] = strconvParseBool(this.style.filled.value);
      filled = v;
    }
    return d2target.toArrowhead(this.shape.value, filled);
  }
}

// Go's strings.ToUpper maps per code point (see goLower).
function goUpper(s) {
  let o = '';
  for (const c of s) {
    const u = c.toUpperCase();
    o += Array.from(u).length === 1 ? u : c;
  }
  return o;
}

// golang.org/x/text/cases Title(language.Und).String: the first letter of each word upper-cased (title case), the
// rest lower-cased. Approximation: words are runs of letters, marks, digits and apostrophes; x/text's word
// segmentation and its special cases (e.g. Dutch "ij") are not modelled. Only reached through
// `text-transform: capitalize` in Texts/SetDimensions.
function titleCase(s) {
  return s.replace(/[\p{L}\p{M}\p{N}'’]+/gu, (w) => {
    const chars = Array.from(w);
    return goUpper(chars[0]) + chars.slice(1).map((c) => lc(c)).join('');
  });
}

// ---- References ----

export class Reference {
  constructor() {
    this.key = null;
    this.keyPathIndex = 0;

    this.mapKey = null;
    this.mapKeyEdgeIndex = 0;
    this.scope = null;
    this.scopeObj = null;
    this.scopeAST = null;
    this.isVar = false;
  }
  toJSON() { return { key: this.key, key_path_index: this.keyPathIndex, map_key_edge_index: this.mapKeyEdgeIndex }; }
  copy() { return Object.assign(new Reference(), this); }

  mapKeyEdgeDest() { return this.key === this.mapKey.edges[this.mapKeyEdgeIndex].dst; }
  inEdge() { return this.key !== this.mapKey.key; }
}

export class EdgeReference {
  constructor() {
    this.edge = null;

    this.mapKey = null;
    this.mapKeyEdgeIndex = 0;
    this.scope = null;
    this.scopeObj = null;
    this.scopeAST = null;
  }
  toJSON() { return { map_key_edge_index: this.mapKeyEdgeIndex }; }
}

// ---- Object ----

export class ContainerLevel {
  /** LabelSize of a container at level l (Go's `ContainerLevel(l).LabelSize()`) */
  static labelSize(l) {
    // Largest to smallest
    if (l === 1) return d2fonts.FONT_SIZE_XXL;
    if (l === 2) return d2fonts.FONT_SIZE_XL;
    if (l === 3) return d2fonts.FONT_SIZE_L;
    return d2fonts.FONT_SIZE_M;
  }
}

/** Go's d2graph.Object ("TODO maybe rename to Shape") */
export class GraphObject {
  constructor() {
    this.graph = null;
    this.parent = null;

    /**
     * IDVal is the actual value of the ID whereas ID is the value in d2 syntax.
     * e.g. ID:    "yes'\""
     *      IDVal: yes'"
     *
     * ID allows joining on . naively and construct a valid D2 key path
     */
    this.id = '';
    this.idVal = '';
    /** *d2ast.Map (json "-") */
    this.map = null;
    this.references = null;

    /** the embedded *geo.Box */
    this.box = null;
    this.labelPosition = null;
    this.iconPosition = null;

    this.contentAspectRatio = null;

    this.class = null;
    this.sqlTable = null;

    this.children = null;
    this.childrenArray = null;

    /** the embedded Attributes */
    this.attributes = new Attributes();

    this.zIndex = 0;
  }

  toJSON() {
    const o = { id: this.id, id_val: this.idVal };
    if (this.references && this.references.length) o.references = this.references;
    if (this.box !== null) o.box = this.box;
    if (this.labelPosition !== null) o.labelPosition = this.labelPosition;
    if (this.iconPosition !== null) o.iconPosition = this.iconPosition;
    if (this.contentAspectRatio !== null) o.contentAspectRatio = this.contentAspectRatio;
    if (this.class !== null) o.class = this.class;
    if (this.sqlTable !== null) o.sql_table = this.sqlTable;
    o.attributes = this.attributes;
    o.zIndex = this.zIndex;
    return o;
  }

  getFill() {
    const obj = this;
    let level = obj.level();
    const shape_ = obj.attributes.shape.value;

    if (equalFold(shape_, d2target.ShapeSQLTable) || equalFold(shape_, d2target.ShapeClass)) return color.N1;

    if (obj.isSequenceDiagramNote()) return color.N7;
    else if (obj.isSequenceDiagramGroup()) return color.N5;
    else if (obj.parent !== null && obj.parent.isSequenceDiagram()) return color.B5; // nil-safe method in Go

    // fill for spans
    const sd = obj.outerSequenceDiagram();
    if (sd !== null) {
      level -= sd.level();
      if (level === 1) return color.B3;
      else if (level === 2) return color.B4;
      else if (level === 3) return color.B5;
      else if (level === 4) return color.N6;
      return color.N7;
    }

    if (obj.isSequenceDiagram()) return color.N7;

    if (shape_ === '' || equalFold(shape_, d2target.ShapeSquare) || equalFold(shape_, d2target.ShapeCircle) || equalFold(shape_, d2target.ShapeOval) || equalFold(shape_, d2target.ShapeRectangle) || equalFold(shape_, d2target.ShapeHierarchy)) {
      if (level === 1) {
        if (!obj.isContainer()) return color.B6;
        return color.B4;
      } else if (level === 2) return color.B5;
      else if (level === 3) return color.B6;
      return color.N7;
    }

    if (equalFold(shape_, d2target.ShapeCylinder) || equalFold(shape_, d2target.ShapeStoredData) || equalFold(shape_, d2target.ShapePackage)) {
      if (level === 1) return color.AA4;
      return color.AA5;
    }

    if (equalFold(shape_, d2target.ShapeStep) || equalFold(shape_, d2target.ShapePage) || equalFold(shape_, d2target.ShapeDocument)) {
      if (level === 1) return color.AB4;
      return color.AB5;
    }

    if (equalFold(shape_, d2target.ShapePerson) || equalFold(shape_, d2target.ShapeC4Person)) return color.B3;
    if (equalFold(shape_, d2target.ShapeDiamond)) return color.N4;
    if (equalFold(shape_, d2target.ShapeCloud) || equalFold(shape_, d2target.ShapeCallout)) return color.N7;
    if (equalFold(shape_, d2target.ShapeQueue) || equalFold(shape_, d2target.ShapeParallelogram) || equalFold(shape_, d2target.ShapeHexagon)) return color.N5;

    return color.N7;
  }

  /** dashGapSize is an interface{} in Go: `!= 0.0` is true for anything that is not the number 0 */
  getStroke(dashGapSize) {
    const obj = this;
    const shape_ = obj.attributes.shape.value;
    if (equalFold(shape_, d2target.ShapeCode) || equalFold(shape_, d2target.ShapeText)) return color.N1;
    if (equalFold(shape_, d2target.ShapeClass) || equalFold(shape_, d2target.ShapeSQLTable)) return color.N7;
    if (dashGapSize !== 0) return color.B2;
    return color.B1;
  }

  /** Level returns a ContainerLevel (a number) */
  level() {
    if (this.parent === null) return this.graph.rootLevel;
    return 1 + this.parent.level();
  }

  isContainer() { return this.children !== null && this.children.size > 0; }

  hasOutsideBottomLabel() {
    if (this === null) return false;
    switch (this.attributes.shape.value) {
      case d2target.ShapeImage: case d2target.ShapePerson: return true;
      default: return false;
    }
  }

  hasLabel() {
    if (this === null) return false;
    switch (this.attributes.shape.value) {
      case d2target.ShapeText: case d2target.ShapeClass: case d2target.ShapeSQLTable: case d2target.ShapeCode: return false;
      default: return this.attributes.label.value !== '';
    }
  }

  hasIcon() { return this.attributes.icon !== null && this.attributes.shape.value !== d2target.ShapeImage; }

  absID() {
    if (this.parent !== null && this.parent.id !== '') return this.parent.absID() + '.' + this.id;
    return this.id;
  }

  absIDArray() {
    if (this.parent === null) return null;
    return append(this.parent.absIDArray(), this.id);
  }

  text() {
    const obj = this;
    let isBold = !obj.isContainer() && obj.attributes.shape.value !== 'text';
    let isItalic = false;
    if (obj.attributes.style.bold !== null && obj.attributes.style.bold.value === 'true') isBold = true;
    if (obj.attributes.style.italic !== null && obj.attributes.style.italic.value === 'true') isItalic = true;
    let fontSize = d2fonts.FONT_SIZE_M;

    if (obj.class !== null || obj.sqlTable !== null) fontSize = d2fonts.FONT_SIZE_L;

    if (obj.outerSequenceDiagram() === null) {
      // Note: during grid layout when children are temporarily removed `IsContainer` is false
      if ((obj.isContainer() || obj.isGridDiagram()) && obj.attributes.shape.value !== 'text') fontSize = ContainerLevel.labelSize(obj.level());
    } else isBold = false;
    if (obj.attributes.style.fontSize !== null) [fontSize] = strconvAtoi(obj.attributes.style.fontSize.value);
    // Class and Table objects have Label set to header
    if (obj.class !== null || obj.sqlTable !== null) fontSize += d2target.HeaderFontAdd;
    if (obj.class !== null) isBold = false;
    return new d2target.MText({
      text: obj.attributes.label.value,
      fontSize,
      isBold,
      isItalic,
      language: obj.attributes.language,
      shape: obj.attributes.shape.value,

      dimensions: new d2target.TextDimensions(obj.attributes.labelDimensions.width, obj.attributes.labelDimensions.height),
    });
  }

  newObject(ids) {
    const obj = this;
    const id = format('key_path', { range: new Range(), path: [rawString(ss(ids), true)] });
    let idval = id;
    let k = null;
    try { k = parseKey(id); } catch { k = null; }
    if (k !== null && (k.path || []).length > 0) idval = ss(k.path[0]);
    const child = new GraphObject();
    child.id = id;
    child.idVal = idval;
    child.attributes.label = new Scalar(idval);
    child.graph = obj.graph;
    child.parent = obj;
    child.children = new Map();

    obj.children.set(lc(id), child);
    obj.childrenArray = append(obj.childrenArray, child);

    if (obj.graph !== null) obj.graph.objects = append(obj.graph.objects, child);

    return child;
  }

  /** @param {string[]} ids @returns {[GraphObject|null, boolean]} */
  hasChild(ids) {
    const obj = this;
    if (ids.length === 0) return [obj, true];
    if (ids.length === 1 && ids[0] !== 'style') {
      if (ReservedKeywords.has(ids[0])) return [obj, true];
    }

    const id = ids[0];
    ids = ids.slice(1);

    const child = obj.children === null ? undefined : obj.children.get(lc(id));
    if (child === undefined) return [null, false];

    if (ids.length >= 1) return child.hasChild(ids);
    return [child, true];
  }

  hasEdge(mk) {
    const [ea, ok] = this.findEdges(mk);
    if (!ok) return [null, false];
    for (const e of ea || []) {
      if (e.index === mk.edge_index.int) return [e, true];
    }
    return [null, false];
  }

  /** TODO: remove edges []edge and scope each edge inside Object. */
  findEdges(mk) {
    const obj = this;
    if ((mk.edges || []).length !== 1) return [null, false];
    if (mk.edge_index.int === null || mk.edge_index.int === undefined) return [null, false];
    const ae = mk.edges[0];

    const [srcObj, srcID, err] = resolveUnderscoreKey(key(ae.src), obj);
    if (err !== null) return [null, false];
    const [dstObj, dstID, err2] = resolveUnderscoreKey(key(ae.dst), obj);
    if (err2 !== null) return [null, false];

    let src = srcID.join('.');
    let dst = dstID.join('.');
    if (srcObj.parent !== null) src = srcObj.absID() + '.' + src;
    if (dstObj.parent !== null) dst = dstObj.absID() + '.' + dst;

    let ea = null;
    for (const e of obj.graph.edges || []) {
      if (equalFold(src, e.src.absID()) &&
        ((ae.src_arrow === '<' && e.srcArrow) || (ae.src_arrow === '' && !e.srcArrow)) &&
        equalFold(dst, e.dst.absID()) &&
        ((ae.dst_arrow === '>' && e.dstArrow) || (ae.dst_arrow === '' && !e.dstArrow))) {
        ea = append(ea, e);
      }
    }
    return [ea, true];
  }

  /** @param {object[]} ida string boxes */
  ensureChildEdge(ida) {
    let obj = this;
    for (let i = 0; i < ida.length; i++) {
      switch (obj.attributes.shape.value) {
        case d2target.ShapeClass: case d2target.ShapeSQLTable:
          // This will only be called for connecting edges where we want to truncate to the
          // container.
          return obj;
        default:
          obj = obj.ensureChild(ida.slice(i, i + 1));
      }
    }
    return obj;
  }

  /**
   * EnsureChild grabs the child by ids or creates it if it does not exist including all
   * intermediate nodes.
   * @param {object[]} ida string boxes
   */
  ensureChild(ida) {
    let obj = this;
    ida = ida || [];
    const seq = obj.outerSequenceDiagram();
    if (seq !== null) {
      for (const c of seq.childrenArray || []) {
        if (c.id === ss(ida[0])) {
          if (obj.id === ss(ida[0])) {
            // In cases of a.a where EnsureChild is called on the parent a, the second a should
            // be created as a child of a and not as a child of the diagram. This is super
            // unfortunate code but alas.
            break;
          }
          obj = seq;
          break;
        }
      }
    }

    if (ida.length === 0) return obj;

    let is = ReservedKeywordHolders.has(ss(ida[0]));
    is = is && isUnquoted(ida[0]);
    if (ida.length === 1 && !is) {
      let ok = ReservedKeywords.has(ss(ida[0]));
      ok = ok && isUnquoted(ida[0]);
      if (ok) return obj;
    }

    const id = ida[0];
    ida = ida.slice(1);

    if (ss(id) === '_' && isUnquoted(id)) return obj.parent.ensureChild(ida);

    const head = format('key_path', { range: new Range(), path: [rawString(ss(id), true)] });
    let child = obj.children === null ? undefined : obj.children.get(lc(head));
    if (child === undefined) child = obj.newObject(id);

    if (ida.length >= 1) return child.ensureChild(ida);
    return child;
  }

  appendReferences(ida, ref, unresolvedObj) {
    const obj = this;
    ref.scopeObj = unresolvedObj;
    let numUnderscores = 0;
    for (let i = 0; i < ida.length; i++) {
      if (ida[i] === '_') {
        numUnderscores++;
        continue;
      }
      const [child, ok] = obj.hasChild(ida.slice(numUnderscores, i + 1));
      if (!ok) return;
      ref.keyPathIndex = i;
      child.references = append(child.references, ref.copy());
    }
  }

  /**
   * @param {object[]} mtexts
   * @param {object} ruler
   * @returns {[object|null, string|null]} dimensions, error message
   */
  getLabelSize(mtexts, ruler, fontFamily, monoFontFamily) {
    const obj = this;
    const shapeType = lc(obj.attributes.shape.value);

    if (obj.attributes.style.font !== null) fontFamily = d2fonts.D2_FONT_TO_FAMILY[obj.attributes.style.font.value];

    let dims = null;
    switch (shapeType) {
      case d2target.ShapeClass:
        dims = getTextDimensionsWithMono(mtexts, ruler, obj.text(), d2fonts.SourceCodePro, monoFontFamily);
        break;
      default:
        if (obj.attributes.language === 'latex') {
          // d2latex.Measure: not ported yet
          throw new Error('d2graph: latex labels are measured by d2latex, which is not ported');
        } else if (obj.attributes.language !== '' && shapeType !== d2target.ShapeCode) {
          let err;
          [dims, err] = getMarkdownDimensions(mtexts, ruler, obj.text(), fontFamily, monoFontFamily);
          if (err !== null) return [null, err];
        } else dims = getTextDimensions(mtexts, ruler, obj.text(), fontFamily);
    }

    if (shapeType === d2target.ShapeSQLTable && obj.attributes.label.value === '') {
      // measure with placeholder text to determine height
      const placeholder = obj.text();
      placeholder.text = 'Table';
      dims = getTextDimensions(mtexts, ruler, placeholder, fontFamily);
    }

    if (dims === null) {
      if (obj.text().text === '') return [new d2target.TextDimensions(0, 0), null];
      if (shapeType === d2target.ShapeImage) dims = new d2target.TextDimensions(0, 0);
      else return [null, `dimensions for object label ${goSharpV(obj.text())} not found`];
    }

    return [dims, null];
  }

  getDefaultSize(mtexts, ruler, fontFamily, monoFontFamily, labelDims, withLabelPadding) {
    const obj = this;
    labelDims = new d2target.TextDimensions(labelDims.width, labelDims.height);
    const dims = new d2target.TextDimensions();
    const dslShape = lc(obj.attributes.shape.value);

    if (dslShape === d2target.ShapeCode) {
      const fontSize = obj.text().fontSize;
      // 0.5em padding on each side
      labelDims.width += fontSize;
      labelDims.height += fontSize;
    } else if (withLabelPadding) {
      labelDims.width += INNER_LABEL_PADDING;
      labelDims.height += INNER_LABEL_PADDING;
    }

    switch (dslShape) {
      default:
        return [new d2target.TextDimensions(labelDims.width, labelDims.height), null];
      case d2target.ShapeText: {
        let w = labelDims.width;
        if (w < MIN_SHAPE_SIZE) w = MIN_SHAPE_SIZE;
        let h = labelDims.height;
        if (h < MIN_SHAPE_SIZE) h = MIN_SHAPE_SIZE;
        return [new d2target.TextDimensions(w, h), null];
      }

      case d2target.ShapeImage:
        return [new d2target.TextDimensions(128, 128), null];

      case d2target.ShapeClass: {
        let maxWidth = goMax(12, labelDims.width);

        let fontSize = d2fonts.FONT_SIZE_L;
        if (obj.attributes.style.fontSize !== null) [fontSize] = strconvAtoi(obj.attributes.style.fontSize.value);

        for (const f of obj.class.fields || []) {
          const fdims = getTextDimensionsWithMono(mtexts, ruler, f.text(fontSize), d2fonts.SourceCodePro, monoFontFamily);
          if (fdims === null) return [null, `dimensions for class field ${goSharpV(f.text(fontSize))} not found`];
          maxWidth = goMax(maxWidth, fdims.width);
        }
        for (const m of obj.class.methods || []) {
          const mdims = getTextDimensionsWithMono(mtexts, ruler, m.text(fontSize), d2fonts.SourceCodePro, monoFontFamily);
          if (mdims === null) return [null, `dimensions for class method ${goSharpV(m.text(fontSize))} not found`];
          maxWidth = goMax(maxWidth, mdims.width);
        }
        //    ┌─PrefixWidth ┌─CenterPadding
        // ┌─┬─┬───────┬──────┬───┬──┐
        // │ + getJobs()      Job[]  │
        // └─┴─┴───────┴──────┴───┴──┘
        //  └─PrefixPadding        └──TypePadding
        //     ├───────┤   +  ├───┤  = maxWidth
        dims.width = d2target.PrefixPadding + d2target.PrefixWidth + maxWidth + d2target.CenterPadding + d2target.TypePadding;

        // All rows should be the same height
        let anyRowText = null;
        if ((obj.class.fields || []).length > 0) anyRowText = obj.class.fields[0].text(fontSize);
        else if ((obj.class.methods || []).length > 0) anyRowText = obj.class.methods[0].text(fontSize);
        if (anyRowText !== null) {
          const rowTextDims = getTextDimensionsWithMono(mtexts, ruler, anyRowText, d2fonts.SourceCodePro, monoFontFamily);
          const rowHeight = rowTextDims.height + d2target.VerticalPadding;
          dims.height = rowHeight * ((obj.class.fields || []).length + (obj.class.methods || []).length) + goMax(2 * rowHeight, labelDims.height + 2 * label.PADDING);
        } else {
          dims.height = 2 * goMax(12, labelDims.height) + d2target.VerticalPadding;
        }
        break;
      }

      case d2target.ShapeSQLTable: {
        let maxNameWidth = 0;
        let maxTypeWidth = 0;
        let maxConstraintWidth = 0;

        let colFontSize = d2fonts.FONT_SIZE_L;
        if (obj.attributes.style.fontSize !== null) [colFontSize] = strconvAtoi(obj.attributes.style.fontSize.value);

        for (let i = 0; i < (obj.sqlTable.columns || []).length; i++) {
          // Note: we want to set dimensions of actual column not the for loop copy of the struct
          const c = obj.sqlTable.columns[i];

          const ctexts = c.texts(colFontSize);

          const nameDims = getTextDimensions(mtexts, ruler, ctexts[0], fontFamily);
          if (nameDims === null) return [null, `dimensions for sql_table name ${JSON.stringify(ctexts[0].text)} not found`];
          c.name.labelWidth = nameDims.width;
          c.name.labelHeight = nameDims.height;
          maxNameWidth = goMax(maxNameWidth, nameDims.width);

          const typeDims = getTextDimensions(mtexts, ruler, ctexts[1], fontFamily);
          if (typeDims === null) return [null, `dimensions for sql_table type ${JSON.stringify(ctexts[1].text)} not found`];
          c.type.labelWidth = typeDims.width;
          c.type.labelHeight = typeDims.height;
          maxTypeWidth = goMax(maxTypeWidth, typeDims.width);

          if ((c.constraint || []).length > 0) {
            const constraintDims = getTextDimensions(mtexts, ruler, ctexts[2], fontFamily);
            if (constraintDims === null) return [null, `dimensions for sql_table constraint ${JSON.stringify(ctexts[2].text)} not found`];
            maxConstraintWidth = goMax(maxConstraintWidth, constraintDims.width);
          }
        }

        // The rows get padded a little due to header font being larger than row font
        dims.height = goMax(12, labelDims.height * ((obj.sqlTable.columns || []).length + 1));
        const headerWidth = d2target.HeaderPadding + labelDims.width + d2target.HeaderPadding;
        let rowsWidth = d2target.NamePadding + maxNameWidth + d2target.TypePadding + maxTypeWidth + d2target.TypePadding + maxConstraintWidth;
        if (maxConstraintWidth !== 0) rowsWidth += d2target.ConstraintPadding;
        dims.width = goMax(12, goMax(headerWidth, rowsWidth));
        break;
      }
    }

    return [dims, null];
  }

  /**
   * resizes the object to fit content of the given width and height in its inner box with the given padding.
   * this accounts for the shape of the object, and if there is a desired width or height set for the object
   */
  sizeToContent(contentWidth, contentHeight, paddingX, paddingY) {
    const obj = this;
    const dslShape = lc(obj.attributes.shape.value);
    const shapeType = d2target.DSL_SHAPE_TO_SHAPE_TYPE[dslShape];
    const s = shape.newShape(shapeType, geo.newBox(geo.newPoint(0, 0), contentWidth, contentHeight));

    let fitWidth, fitHeight;
    if (shapeType === shape.PERSON_TYPE) {
      fitWidth = contentWidth + paddingX;
      fitHeight = contentHeight + paddingY;
    } else [fitWidth, fitHeight] = s.getDimensionsToFit(contentWidth, contentHeight, paddingX, paddingY);

    let desiredWidth = 0;
    if (obj.attributes.widthAttr !== null) {
      [desiredWidth] = strconvAtoi(obj.attributes.widthAttr.value);
      obj.box.Width = desiredWidth;
    } else obj.box.Width = fitWidth;

    let desiredHeight = 0;
    if (obj.attributes.heightAttr !== null) {
      [desiredHeight] = strconvAtoi(obj.attributes.heightAttr.value);
      obj.box.Height = desiredHeight;
    } else obj.box.Height = fitHeight;

    if (obj.sqlTable !== null || obj.class !== null || obj.attributes.language !== '') {
      obj.box.Width = Math.max(desiredWidth, fitWidth);
      obj.box.Height = Math.max(desiredHeight, fitHeight);
    }

    if (s.aspectRatio1()) {
      const sideLength = Math.max(obj.box.Width, obj.box.Height);
      obj.box.Width = sideLength;
      obj.box.Height = sideLength;
    } else if (desiredHeight === 0 || desiredWidth === 0) {
      switch (shapeType) {
        case shape.PERSON_TYPE:
          [obj.box.Width, obj.box.Height] = shape.limitAR(obj.box.Width, obj.box.Height, shape.PERSON_AR_LIMIT);
          break;
        case shape.OVAL_TYPE:
          [obj.box.Width, obj.box.Height] = shape.limitAR(obj.box.Width, obj.box.Height, shape.OVAL_AR_LIMIT);
          break;
      }
    }
    if (shapeType === shape.CLOUD_TYPE) {
      const innerBox = s.getInnerBoxForContent(contentWidth, contentHeight);
      obj.contentAspectRatio = innerBox.Width / innerBox.Height;
    }
  }

  outerNearContainer() {
    let obj = this;
    while (obj !== null) {
      if (obj.attributes.nearKey !== null) return obj;
      obj = obj.parent;
    }
    return null;
  }

  isConstantNear() {
    const obj = this;
    if (obj.attributes.nearKey === null) return false;
    const keyPath = key(obj.attributes.nearKey);

    // interesting if there is a shape with id=top-left, then top-left isn't treated a constant near
    const [, isKey] = obj.graph.root.hasChild(keyPath);
    if (isKey) return false;
    return NearConstants.has(keyPath[0]);
  }

  /**
   * @param {object[]} srcID string boxes
   * @param {object[]} dstID string boxes
   * @returns {[Edge|null, string|null]} the edge, the error message
   */
  connect(srcID, dstID, srcArrow, dstArrow, label_) {
    const obj = this;
    for (const id of [srcID, dstID]) {
      for (const p of id) {
        if (ReservedKeywords.has(ss(p)) && isUnquoted(p)) return [null, 'cannot connect to reserved keyword'];
      }
    }

    const src = obj.ensureChildEdge(srcID);
    const dst = obj.ensureChildEdge(dstID);

    const e = new Edge();
    e.attributes.label = new Scalar(label_);
    e.src = src;
    e.srcArrow = srcArrow;
    e.dst = dst;
    e.dstArrow = dstArrow;
    e.initIndex();

    addSQLTableColumnIndices(e, srcID, dstID, obj, src, dst);

    obj.graph.edges = append(obj.graph.edges, e);
    return [e, null];
  }

  isDescendantOf(ancestor) {
    if (this === ancestor) return true;
    if (this.parent === null) return false;
    return this.parent.isDescendantOf(ancestor);
  }

  iterDescendants(apply) {
    for (const c of this.childrenArray || []) {
      apply(this, c);
      c.iterDescendants(apply);
    }
  }

  isMultiple() { return this.attributes.style.multiple !== null && this.attributes.style.multiple.value === 'true'; }
  is3D() { return this.attributes.style.threeDee !== null && this.attributes.style.threeDee.value === 'true'; }

  /** @returns {[geo.Spacing, geo.Spacing]} margin, padding */
  spacing() { return this.spacingOpt(2 * label.PADDING, 2 * label.PADDING, true); }

  /** @returns {[geo.Spacing, geo.Spacing]} margin, padding */
  spacingOpt(labelPadding, iconPadding, maxIconSize) {
    const obj = this;
    const margin = new geo.Spacing();
    const padding = new geo.Spacing();
    if (obj.hasLabel()) {
      let position = label.Unset;
      if (obj.labelPosition !== null) position = label.fromString(obj.labelPosition);

      let labelWidth = 0, labelHeight = 0;
      if (obj.attributes.labelDimensions.width > 0) labelWidth = obj.attributes.labelDimensions.width + labelPadding;
      if (obj.attributes.labelDimensions.height > 0) labelHeight = obj.attributes.labelDimensions.height + labelPadding;

      switch (position) {
        case label.OutsideTopLeft: case label.OutsideTopCenter: case label.OutsideTopRight:
          margin.Top = labelHeight; break;
        case label.OutsideBottomLeft: case label.OutsideBottomCenter: case label.OutsideBottomRight:
          margin.Bottom = labelHeight; break;
        case label.OutsideLeftTop: case label.OutsideLeftMiddle: case label.OutsideLeftBottom:
          margin.Left = labelWidth; break;
        case label.OutsideRightTop: case label.OutsideRightMiddle: case label.OutsideRightBottom:
          margin.Right = labelWidth; break;
        case label.InsideTopLeft: case label.InsideTopCenter: case label.InsideTopRight:
          padding.Top = labelHeight; break;
        case label.InsideBottomLeft: case label.InsideBottomCenter: case label.InsideBottomRight:
          padding.Bottom = labelHeight; break;
        case label.InsideMiddleLeft:
          padding.Left = labelWidth; break;
        case label.InsideMiddleRight:
          padding.Right = labelWidth; break;
      }
    }

    if (obj.hasIcon()) {
      let position = label.Unset;
      if (obj.iconPosition !== null) position = label.fromString(obj.iconPosition);

      let iconSize = d2target.MAX_ICON_SIZE + iconPadding;
      if (!maxIconSize) iconSize = d2target.getIconSize(obj.box, label.positionString(position)) + iconPadding;
      switch (position) {
        case label.OutsideTopLeft: case label.OutsideTopCenter: case label.OutsideTopRight:
          margin.Top = Math.max(margin.Top, iconSize); break;
        case label.OutsideBottomLeft: case label.OutsideBottomCenter: case label.OutsideBottomRight:
          margin.Bottom = Math.max(margin.Bottom, iconSize); break;
        case label.OutsideLeftTop: case label.OutsideLeftMiddle: case label.OutsideLeftBottom:
          margin.Left = Math.max(margin.Left, iconSize); break;
        case label.OutsideRightTop: case label.OutsideRightMiddle: case label.OutsideRightBottom:
          margin.Right = Math.max(margin.Right, iconSize); break;
        case label.InsideTopLeft: case label.InsideTopCenter: case label.InsideTopRight:
          padding.Top = Math.max(padding.Top, iconSize); break;
        case label.InsideBottomLeft: case label.InsideBottomCenter: case label.InsideBottomRight:
          padding.Bottom = Math.max(padding.Bottom, iconSize); break;
        case label.InsideMiddleLeft:
          padding.Left = Math.max(padding.Left, iconSize); break;
        case label.InsideMiddleRight:
          padding.Right = Math.max(padding.Right, iconSize); break;
      }
    }

    const [dx, dy] = obj.getModifierElementAdjustments();
    margin.Right += dx;
    margin.Top += dy;

    return [margin, padding];
  }

  // ---- layout.go ----

  moveWithDescendants(dx, dy) {
    this.box.TopLeft.x += dx;
    this.box.TopLeft.y += dy;
    for (const child of this.childrenArray || []) child.moveWithDescendants(dx, dy);
  }

  moveWithDescendantsTo(x, y) {
    const dx = x - this.box.TopLeft.x;
    const dy = y - this.box.TopLeft.y;
    this.moveWithDescendants(dx, dy);
  }

  removeChild(child) {
    const parent = this;
    parent.children.delete(lc(child.id));
    for (let i = 0; i < (parent.childrenArray || []).length; i++) {
      if (parent.childrenArray[i] === child) {
        parent.childrenArray = [...parent.childrenArray.slice(0, i), ...parent.childrenArray.slice(i + 1)];
        break;
      }
    }
  }

  /**
   * ShiftDescendants moves Object's descendants (not including itself)
   * descendants' edges are also moved by the same dx and dy (the whole route is moved if both ends are a descendant)
   */
  shiftDescendants(dx, dy) {
    const obj = this;
    // also need to shift edges of descendants that are shifted
    const movedEdges = new Set();
    for (const e of obj.graph.edges || []) {
      const isSrcDesc = e.src.isDescendantOf(obj);
      const isDstDesc = e.dst.isDescendantOf(obj);

      if (isSrcDesc && isDstDesc) {
        movedEdges.add(e);
        for (const p of e.route || []) {
          p.x += dx;
          p.y += dy;
        }
      }
    }

    obj.iterDescendants((_, curr) => {
      curr.box.TopLeft.x += dx;
      curr.box.TopLeft.y += dy;
      for (const e of obj.graph.edges || []) {
        if (movedEdges.has(e)) continue;
        const isSrc = e.src === curr;
        const isDst = e.dst === curr;

        if (isSrc && isDst) {
          for (const p of e.route || []) {
            p.x += dx;
            p.y += dy;
          }
        } else if (isSrc) {
          if (dx === 0) e.shiftStart(dy, false);
          else if (dy === 0) e.shiftStart(dx, true);
          else {
            e.route[0].x += dx;
            e.route[0].y += dy;
          }
        } else if (isDst) {
          if (dx === 0) e.shiftEnd(dy, false);
          else if (dy === 0) e.shiftEnd(dx, true);
          else {
            e.route[e.route.length - 1].x += dx;
            e.route[e.route.length - 1].y += dy;
          }
        }

        if (isSrc || isDst) movedEdges.add(e);
      }
    });
  }

  /** GetModifierElementAdjustments returns width/height adjustments to account for shapes with 3d or multiple: [dx, dy] */
  getModifierElementAdjustments() {
    const obj = this;
    let dx = 0, dy = 0;
    if (obj.is3D()) {
      if (obj.attributes.shape.value === d2target.ShapeHexagon) dy = Math.trunc(d2target.THREE_DEE_OFFSET / 2); // an untyped integer constant expression: 15 / 2 is 7 in Go
      else dy = d2target.THREE_DEE_OFFSET;
      dx = d2target.THREE_DEE_OFFSET;
    } else if (obj.isMultiple()) {
      dy = d2target.MULTIPLE_OFFSET;
      dx = d2target.MULTIPLE_OFFSET;
    }
    return [dx, dy];
  }

  getMargin() {
    const obj = this;
    const margin = new geo.Spacing();

    if (obj.hasLabel() && obj.labelPosition !== null) {
      const position = label.fromString(obj.labelPosition);

      const labelWidth = obj.attributes.labelDimensions.width + label.PADDING;
      const labelHeight = obj.attributes.labelDimensions.height + label.PADDING;

      switch (position) {
        case label.OutsideTopLeft: case label.OutsideTopCenter: case label.OutsideTopRight:
          margin.Top = labelHeight; break;
        case label.OutsideBottomLeft: case label.OutsideBottomCenter: case label.OutsideBottomRight:
          margin.Bottom = labelHeight; break;
        case label.OutsideLeftTop: case label.OutsideLeftMiddle: case label.OutsideLeftBottom:
          margin.Left = labelWidth; break;
        case label.OutsideRightTop: case label.OutsideRightMiddle: case label.OutsideRightBottom:
          margin.Right = labelWidth; break;
      }

      // if an outside label is larger than the object add margin accordingly
      if (labelWidth > obj.box.Width) {
        const dx = labelWidth - obj.box.Width;
        switch (position) {
          case label.OutsideTopLeft: case label.OutsideBottomLeft:
            // label fixed at left will overflow on right
            margin.Right = dx; break;
          case label.OutsideTopCenter: case label.OutsideBottomCenter:
            margin.Left = Math.ceil(dx / 2);
            margin.Right = Math.ceil(dx / 2);
            break;
          case label.OutsideTopRight: case label.OutsideBottomRight:
            margin.Left = dx; break;
        }
      }
      if (labelHeight > obj.box.Height) {
        const dy = labelHeight - obj.box.Height;
        switch (position) {
          case label.OutsideLeftTop: case label.OutsideRightTop:
            margin.Bottom = dy; break;
          case label.OutsideLeftMiddle: case label.OutsideRightMiddle:
            margin.Top = Math.ceil(dy / 2);
            margin.Bottom = Math.ceil(dy / 2);
            break;
          case label.OutsideLeftBottom: case label.OutsideRightBottom:
            margin.Top = dy; break;
        }
      }
    }

    if (obj.hasIcon() && obj.iconPosition !== null) {
      const position = label.fromString(obj.iconPosition);

      const iconSize = d2target.MAX_ICON_SIZE + label.PADDING;
      switch (position) {
        case label.OutsideTopLeft: case label.OutsideTopCenter: case label.OutsideTopRight:
          margin.Top = Math.max(margin.Top, iconSize); break;
        case label.OutsideBottomLeft: case label.OutsideBottomCenter: case label.OutsideBottomRight:
          margin.Bottom = Math.max(margin.Bottom, iconSize); break;
        case label.OutsideLeftTop: case label.OutsideLeftMiddle: case label.OutsideLeftBottom:
          margin.Left = Math.max(margin.Left, iconSize); break;
        case label.OutsideRightTop: case label.OutsideRightMiddle: case label.OutsideRightBottom:
          margin.Right = Math.max(margin.Right, iconSize); break;
      }
    }

    const [dx, dy] = obj.getModifierElementAdjustments();
    margin.Right += dx;
    margin.Top += dy;
    return margin;
  }

  toShape() {
    const obj = this;
    let tl = obj.box.TopLeft;
    if (tl === null) tl = geo.newPoint(0, 0);
    const dslShape = lc(obj.attributes.shape.value);
    const shapeType = d2target.DSL_SHAPE_TO_SHAPE_TYPE[dslShape];
    const contentBox = geo.newBox(tl, obj.box.Width, obj.box.Height);
    const s = shape.newShape(shapeType, contentBox);
    if (shapeType === shape.CLOUD_TYPE && obj.contentAspectRatio !== null) s.setInnerBoxAspectRatio(obj.contentAspectRatio);
    return s;
  }

  getLabelTopLeft() {
    const obj = this;
    if (obj.labelPosition === null) return null;

    const s = obj.toShape();
    const labelPosition = label.fromString(obj.labelPosition);

    let box;
    if (label.isOutside(labelPosition)) box = s.getBox();
    else box = s.getInnerBox();

    return label.getPointOnBox(labelPosition, box, label.PADDING, obj.attributes.labelDimensions.width, obj.attributes.labelDimensions.height);
  }

  getIconTopLeft() {
    const obj = this;
    if (obj.iconPosition === null) return null;

    const s = obj.toShape();
    const iconPosition = label.fromString(obj.iconPosition);

    let box;
    if (label.isOutside(iconPosition)) box = s.getBox();
    else box = s.getInnerBox();

    return label.getPointOnBox(iconPosition, box, label.PADDING, d2target.MAX_ICON_SIZE, d2target.MAX_ICON_SIZE);
  }

  // ---- seqdiagram.go ----

  isSequenceDiagram() { return this !== null && this.attributes.shape.value === d2target.ShapeSequenceDiagram; }

  outerSequenceDiagram() {
    let obj = this;
    while (obj !== null) {
      obj = obj.parent;
      if (obj !== null && obj.isSequenceDiagram()) return obj;
    }
    return null;
  }

  /**
   * groups are objects in sequence diagrams that have no messages connected
   * and does not have a note as a child (a note can appear within a group, but it's a child of an actor)
   */
  isSequenceDiagramGroup() {
    const obj = this;
    if (obj.outerSequenceDiagram() === null) return false;
    for (const e of obj.graph.edges || []) {
      if (e.src === obj || e.dst === obj) return false;
    }
    for (const ch of obj.childrenArray || []) {
      // if the child contains a message, it's a span, not a note
      if (!ch.containsAnyEdge(obj.graph.edges)) return false;
    }
    return obj.containsAnyObject(obj.graph.objects) || obj.containsAnyEdge(obj.graph.edges);
  }

  /** notes are descendant of actors with no edges and no children */
  isSequenceDiagramNote() {
    const obj = this;
    if (obj.outerSequenceDiagram() === null) return false;
    return !obj.hasEdgeRef() && !obj.containsAnyEdge(obj.graph.edges) && (obj.childrenArray || []).length === 0 && !obj.containsAnyObject(obj.graph.objects);
  }

  hasEdgeRef() {
    for (const ref of this.references || []) {
      if (ref.mapKey !== null && (ref.mapKey.edges || []).length > 0) return true;
    }
    return false;
  }

  containsAnyObject(objects) {
    for (const o of objects || []) {
      if (o.containedBy(this)) return true;
    }
    return false;
  }

  containedBy(obj) {
    for (const ref of this.references || []) {
      let curr = ref.scopeObj;
      while (curr !== null) {
        if (curr === obj) return true;
        curr = curr.parent;
      }
    }
    return false;
  }

  containsAnyEdge(edges) {
    for (const e of edges || []) {
      if (e.containedBy(this)) return true;
    }
    return false;
  }

  // ---- grid_diagram.go ----

  isGridDiagram() {
    return this !== null && (this.attributes.gridRows !== null || this.attributes.gridColumns !== null);
  }

  closestGridDiagram() {
    if (this === null) return null;
    if (this.isGridDiagram()) return this;
    return this.parent === null ? null : this.parent.closestGridDiagram();
  }

  closestGridCell() {
    if (this === null) return null;
    // grid cells can be a nested grid diagram
    if (this.parent !== null && this.parent.isGridDiagram()) return this;
    return this.parent === null ? null : this.parent.closestGridCell();
  }

  /** TopGridDiagram returns the least nested (outermost) grid diagram */
  topGridDiagram() {
    if (this === null) return null;
    let gd = null;
    if (this.isGridDiagram()) gd = this;
    let curr = this.parent;
    while (curr !== null) {
      if (curr.isGridDiagram()) gd = curr;
      curr = curr.parent;
    }
    return gd;
  }
}

// ---- Edge ----

export class Edge {
  constructor() {
    this.index = 0;

    this.srcTableColumnIndex = null;
    this.dstTableColumnIndex = null;

    this.labelPosition = null;
    this.labelPercentage = null;

    this.isCurve = false;
    this.route = null;

    this.src = null;
    this.srcArrow = false;
    this.srcArrowhead = null;
    this.dst = null;
    /** TODO alixander (Mon Sep 12 2022): deprecate SrcArrow and DstArrow and just use SrcArrowhead and DstArrowhead */
    this.dstArrow = false;
    this.dstArrowhead = null;

    this.references = null;
    /** the embedded Attributes */
    this.attributes = new Attributes();

    this.zIndex = 0;
  }

  toJSON() {
    const o = { index: this.index };
    if (this.srcTableColumnIndex !== null) o.srcTableColumnIndex = this.srcTableColumnIndex;
    if (this.dstTableColumnIndex !== null) o.dstTableColumnIndex = this.dstTableColumnIndex;
    if (this.labelPosition !== null) o.labelPosition = this.labelPosition;
    if (this.labelPercentage !== null) o.labelPercentage = this.labelPercentage;
    o.isCurve = this.isCurve;
    if (this.route && this.route.length) o.route = this.route;
    o.src_arrow = this.srcArrow;
    if (this.srcArrowhead !== null) o.srcArrowhead = this.srcArrowhead;
    o.dst_arrow = this.dstArrow;
    if (this.dstArrowhead !== null) o.dstArrowhead = this.dstArrowhead;
    if (this.references && this.references.length) o.references = this.references;
    o.attributes = this.attributes;
    o.zIndex = this.zIndex;
    return o;
  }

  getAstEdge() { return this.references[0].edge; }

  getStroke(dashGapSize) {
    if (dashGapSize !== 0) return color.B2;
    return color.B1;
  }

  arrowString() {
    if (this.srcArrow && this.dstArrow) return '<->';
    if (this.srcArrow) return '<-';
    if (this.dstArrow) return '->';
    return '--';
  }

  text() {
    const e = this;
    let fontSize = d2fonts.FONT_SIZE_M;
    if (e.attributes.style.fontSize !== null) [fontSize] = strconvAtoi(e.attributes.style.fontSize.value);
    let isBold = false;
    if (e.attributes.style.bold !== null) [isBold] = strconvParseBool(e.attributes.style.bold.value);
    return new d2target.MText({
      text: e.attributes.label.value,
      fontSize,
      isBold,
      isItalic: true,
      language: e.attributes.language,

      dimensions: new d2target.TextDimensions(e.attributes.labelDimensions.width, e.attributes.labelDimensions.height),
    });
  }

  move(dx, dy) {
    for (const p of this.route || []) {
      p.x += dx;
      p.y += dy;
    }
  }

  absID() {
    const e = this;
    let srcIDA = e.src.absIDArray() || [];
    let dstIDA = e.dst.absIDArray() || [];

    let commonIDA = null;
    while (srcIDA.length > 1 && dstIDA.length > 1) {
      if (!equalFold(srcIDA[0], dstIDA[0])) break;
      commonIDA = append(commonIDA, srcIDA[0]);
      srcIDA = srcIDA.slice(1);
      dstIDA = dstIDA.slice(1);
    }

    let commonKey = '';
    if ((commonIDA || []).length > 0) commonKey = commonIDA.join('.') + '.';

    return `${commonKey}(${srcIDA.join('.')} ${e.arrowString()} ${dstIDA.join('.')})[${e.index}]`;
  }

  /**
   * TODO: Treat undirectional/bidirectional edge here and in HasEdge flipped. Same with
   * SrcArrow.
   */
  initIndex() {
    const e = this;
    for (const e2 of e.src.graph.edges || []) {
      if (e.src === e2.src &&
        e.srcArrow === e2.srcArrow &&
        e.dst === e2.dst &&
        e.dstArrow === e2.dstArrow) {
        e.index++;
      }
    }
  }

  // ---- seqdiagram.go ----

  containedBy(obj) {
    for (const ref of this.references || []) {
      let curr = ref.scopeObj;
      while (curr !== null) {
        if (curr === obj) return true;
        curr = curr.parent;
      }
    }
    return false;
  }

  getGroup() {
    for (const ref of this.references || []) {
      if (ref.scopeObj.isSequenceDiagramGroup()) return ref.scopeObj;
    }
    return null;
  }

  // ---- layout.go ----

  /**
   * ShiftStart moves the starting point of the route by delta either horizontally or vertically
   * if subsequent points are in line with the movement, they will be removed (unless it is the last point)
   * start                   end
   * . ├────┼────┼───┼────┼───┤   before
   * . ├──dx──►
   * .        ├──┼───┼────┼───┤   after
   */
  shiftStart(delta, isHorizontal) {
    const edge = this;
    const position = (p) => (isHorizontal ? p.x : p.y);

    const start = edge.route[0];
    const next = edge.route[1];
    const isIncreasing = position(start) < position(next);
    if (isHorizontal) start.x += delta;
    else start.y += delta;

    if (isIncreasing === (delta < 0)) {
      // nothing more to do when moving away from the next point
      return;
    }

    const isAligned = (p) => (isHorizontal ? p.y === start.y : p.x === start.x);
    const isPastStart = (p) => (delta > 0 ? position(p) < position(start) : position(p) > position(start));

    let needsRemoval = false;
    const toRemove = new Array(edge.route.length).fill(false);
    for (let i = 1; i < edge.route.length - 1; i++) {
      if (!isAligned(edge.route[i])) break;
      if (isPastStart(edge.route[i])) {
        toRemove[i] = true;
        needsRemoval = true;
      }
    }
    if (needsRemoval) edge.route = geo.removePoints(edge.route, toRemove);
  }

  /**
   * ShiftEnd moves the ending point of the route by delta either horizontally or vertically
   * if prior points are in line with the movement, they will be removed (unless it is the first point)
   */
  shiftEnd(delta, isHorizontal) {
    const edge = this;
    const position = (p) => (isHorizontal ? p.x : p.y);

    const end = edge.route[edge.route.length - 1];
    const prev = edge.route[edge.route.length - 2];
    const isIncreasing = position(prev) < position(end);
    if (isHorizontal) end.x += delta;
    else end.y += delta;

    if (isIncreasing === (delta > 0)) {
      // nothing more to do when moving away from the next point
      return;
    }

    const isAligned = (p) => (isHorizontal ? p.y === end.y : p.x === end.x);
    const isPastEnd = (p) => (delta > 0 ? position(p) < position(end) : position(p) > position(end));

    let needsRemoval = false;
    const toRemove = new Array(edge.route.length).fill(false);
    for (let i = edge.route.length - 2; i > 0; i--) {
      if (!isAligned(edge.route[i])) break;
      if (isPastEnd(edge.route[i])) {
        toRemove[i] = true;
        needsRemoval = true;
      }
    }
    if (needsRemoval) edge.route = geo.removePoints(edge.route, toRemove);
  }

  /** @returns {[number, number]} newStart, newEnd */
  traceToShape(points, startIndex, endIndex) {
    const edge = this;
    const srcShape = edge.src.toShape();
    const dstShape = edge.dst.toShape();

    const startingSegment = new geo.Segment(points[startIndex + 1], points[startIndex]);
    // if an edge runs into an outside label, stop the edge at the label instead
    let overlapsOutsideLabel = false, overlapsOutsideIcon = false;
    if (edge.src.hasLabel()) {
      // assumes LabelPosition, LabelWidth, LabelHeight are all set if there is a label
      const labelPosition = label.fromString(edge.src.labelPosition);
      if (label.isOutside(labelPosition)) {
        const labelWidth = edge.src.attributes.labelDimensions.width;
        const labelHeight = edge.src.attributes.labelDimensions.height;
        const labelTL = label.getPointOnBox(labelPosition, edge.src.box, label.PADDING, labelWidth, labelHeight);

        const labelBox = geo.newBox(labelTL, labelWidth, labelHeight);
        // add left/right padding to box
        labelBox.TopLeft.x -= label.PADDING;
        labelBox.Width += 2 * label.PADDING;

        while (labelBox.contains(startingSegment.End) && startIndex + 1 > endIndex) {
          startingSegment.Start = startingSegment.End;
          startingSegment.End = points[startIndex + 2];
          startIndex++;
        }
        const intersections = labelBox.intersections(startingSegment);
        if (intersections.length > 0) {
          overlapsOutsideLabel = true;
          let p = intersections[0];
          if (intersections.length > 1) p = findOuterIntersection(labelPosition, intersections);
          // move starting segment to label intersection point
          points[startIndex] = p;
          startingSegment.End = p;
          // if the segment becomes too short, just merge it with the next segment
          if (startIndex + 1 < endIndex && startingSegment.length() < MIN_SEGMENT_LEN) {
            points[startIndex + 1] = points[startIndex];
            startIndex++;
          }
        }
      }
    }
    if (!overlapsOutsideLabel && edge.src.hasIcon()) {
      // assumes IconPosition is set if there is an Icon
      const iconPosition = label.fromString(edge.src.iconPosition);
      if (label.isOutside(iconPosition)) {
        const iconWidth = d2target.MAX_ICON_SIZE;
        const iconHeight = d2target.MAX_ICON_SIZE;
        const iconTL = label.getPointOnBox(iconPosition, edge.src.box, label.PADDING, iconWidth, iconHeight);

        const iconBox = geo.newBox(iconTL, iconWidth, iconHeight);
        while (iconBox.contains(startingSegment.End) && startIndex + 1 > endIndex) {
          startingSegment.Start = startingSegment.End;
          startingSegment.End = points[startIndex + 2];
          startIndex++;
        }
        const intersections = iconBox.intersections(startingSegment);
        if (intersections.length > 0) {
          overlapsOutsideIcon = true;
          let p = intersections[0];
          if (intersections.length > 1) p = findOuterIntersection(iconPosition, intersections);
          // move starting segment to icon intersection point
          points[startIndex] = p;
          startingSegment.End = p;
          // if the segment becomes too short, just merge it with the next segment
          if (startIndex + 1 < endIndex && startingSegment.length() < MIN_SEGMENT_LEN) {
            points[startIndex + 1] = points[startIndex];
            startIndex++;
          }
        }
      }
    }
    if (!overlapsOutsideLabel && !overlapsOutsideIcon) {
      const intersections = edge.src.box.intersections(startingSegment);
      if (intersections.length > 0) {
        // move starting segment to intersection point
        points[startIndex] = intersections[0];
        startingSegment.End = intersections[0];
        // if the segment becomes too short, just merge it with the next segment
        if (startIndex + 1 < endIndex && startingSegment.length() < MIN_SEGMENT_LEN) {
          points[startIndex + 1] = points[startIndex];
          startIndex++;
        }
      }
      // trace the edge to the specific shape's border
      points[startIndex] = shape.traceToShapeBorder(srcShape, points[startIndex], points[startIndex + 1]);
    }
    const endingSegment = new geo.Segment(points[endIndex - 1], points[endIndex]);
    overlapsOutsideLabel = false;
    overlapsOutsideIcon = false;
    if (edge.dst.hasLabel()) {
      // assumes LabelPosition, LabelWidth, LabelHeight are all set if there is a label
      const labelPosition = label.fromString(edge.dst.labelPosition);
      if (label.isOutside(labelPosition)) {
        const labelWidth = edge.dst.attributes.labelDimensions.width;
        const labelHeight = edge.dst.attributes.labelDimensions.height;
        const labelTL = label.getPointOnBox(labelPosition, edge.dst.box, label.PADDING, labelWidth, labelHeight);

        const labelBox = geo.newBox(labelTL, labelWidth, labelHeight);
        // add left/right padding to box
        labelBox.TopLeft.x -= label.PADDING;
        labelBox.Width += 2 * label.PADDING;
        while (labelBox.contains(endingSegment.Start) && endIndex - 1 > startIndex) {
          endingSegment.End = endingSegment.Start;
          endingSegment.Start = points[endIndex - 2];
          endIndex--;
        }
        const intersections = labelBox.intersections(endingSegment);
        if (intersections.length > 0) {
          overlapsOutsideLabel = true;
          let p = intersections[0];
          if (intersections.length > 1) p = findOuterIntersection(labelPosition, intersections);
          // move ending segment to label intersection point
          points[endIndex] = p;
          endingSegment.End = p;
          // if the segment becomes too short, just merge it with the previous segment
          if (endIndex - 1 > startIndex && endingSegment.length() < MIN_SEGMENT_LEN) {
            points[endIndex - 1] = points[endIndex];
            endIndex--;
          }
        }
      }
    }
    if (!overlapsOutsideLabel && edge.dst.hasIcon()) {
      // assumes IconPosition is set if there is an Icon
      const iconPosition = label.fromString(edge.dst.iconPosition);
      if (label.isOutside(iconPosition)) {
        const iconSize = d2target.getIconSize(edge.dst.box, label.positionString(iconPosition));
        const iconWidth = iconSize;
        const iconHeight = iconSize;
        const labelTL = label.getPointOnBox(iconPosition, edge.dst.box, label.PADDING, iconWidth, iconHeight);

        const iconBox = geo.newBox(labelTL, iconWidth, iconHeight);
        while (iconBox.contains(endingSegment.Start) && endIndex - 1 > startIndex) {
          endingSegment.End = endingSegment.Start;
          endingSegment.Start = points[endIndex - 2];
          endIndex--;
        }
        const intersections = iconBox.intersections(endingSegment);
        if (intersections.length > 0) {
          overlapsOutsideIcon = true;
          let p = intersections[0];
          if (intersections.length > 1) p = findOuterIntersection(iconPosition, intersections);
          // move ending segment to icon intersection point
          points[endIndex] = p;
          endingSegment.End = p;
          // if the segment becomes too short, just merge it with the previous segment
          if (endIndex - 1 > startIndex && endingSegment.length() < MIN_SEGMENT_LEN) {
            points[endIndex - 1] = points[endIndex];
            endIndex--;
          }
        }
      }
    }
    if (!overlapsOutsideLabel && !overlapsOutsideIcon) {
      const intersections = edge.dst.box.intersections(endingSegment);
      if (intersections.length > 0) {
        // move ending segment to intersection point
        points[endIndex] = intersections[0];
        endingSegment.End = intersections[0];
        // if the segment becomes too short, just merge it with the previous segment
        if (endIndex - 1 > startIndex && endingSegment.length() < MIN_SEGMENT_LEN) {
          points[endIndex - 1] = points[endIndex];
          endIndex--;
        }
      }
      points[endIndex] = shape.traceToShapeBorder(dstShape, points[endIndex], points[endIndex - 1]);
    }
    return [startIndex, endIndex];
  }
}

export const MIN_SEGMENT_LEN = 10;

function findOuterIntersection(labelPosition, intersections) {
  switch (labelPosition) {
    case label.OutsideTopLeft: case label.OutsideTopRight: case label.OutsideTopCenter:
      sortSlice(intersections, (i, j) => intersections[i].y < intersections[j].y);
      break;
    case label.OutsideBottomLeft: case label.OutsideBottomRight: case label.OutsideBottomCenter:
      sortSlice(intersections, (i, j) => intersections[i].y > intersections[j].y);
      break;
    case label.OutsideLeftTop: case label.OutsideLeftMiddle: case label.OutsideLeftBottom:
      sortSlice(intersections, (i, j) => intersections[i].x < intersections[j].x);
      break;
    case label.OutsideRightTop: case label.OutsideRightMiddle: case label.OutsideRightBottom:
      sortSlice(intersections, (i, j) => intersections[i].x > intersections[j].x);
      break;
  }
  return intersections[0];
}

// ---- functions ----

/** Key(k) is d2format.KeyPath(k): each element of the path, formatted as a key. */
export function key(k) {
  const ida = [];
  for (const s of k.path || []) {
    ida.push(format('key_path', { range: new Range(), path: [rawString(ss(s), true)] }));
  }
  return ida.length ? ida : null;
}
const keyOf = key;

/**
 * TODO: remove once not used anywhere
 * @returns {[GraphObject|null, string[]|null, string|null]} resolvedObj, resolvedIDA, error message
 */
export function resolveUnderscoreKey(ida, obj) {
  ida = ida || [];
  if (ida.length > 0 && !obj.isSequenceDiagram()) {
    const objSD = obj.outerSequenceDiagram();
    if (objSD !== null) {
      let referencesActor = false;
      for (const c of objSD.childrenArray || []) {
        if (c.id === ida[0]) {
          referencesActor = true;
          break;
        }
      }
      if (referencesActor) obj = objSD;
    }
  }

  let resolvedObj = obj;
  let resolvedIDA = ida;

  for (let i = 0; i < ida.length; i++) {
    const id = ida[i];
    if (id !== '_') continue;
    if (i !== 0 && ida[i - 1] !== '_') return [null, null, 'parent "_" can only be used in the beginning of paths, e.g. "_.x"'];
    if (resolvedObj === obj.graph.root) return [null, null, 'parent "_" cannot be used in the root scope'];
    if (i === ida.length - 1) return [null, null, 'invalid use of parent "_"'];
    resolvedObj = resolvedObj.parent;
    resolvedIDA = resolvedIDA.slice(1);
  }

  return [resolvedObj, resolvedIDA, null];
}

function addSQLTableColumnIndices(e, srcID, dstID, obj, src, dst) {
  if (src.attributes.shape.value === d2target.ShapeSQLTable) {
    if (src === dst) {
      // Ignore edge to column inside table.
      return;
    }
    const objAbsID = obj.absIDArray() || [];
    const srcAbsID = src.absIDArray() || [];
    if (objAbsID.length + srcID.length > srcAbsID.length) {
      const cols = src.sqlTable.columns || [];
      for (let i = 0; i < cols.length; i++) {
        // d2col is a copy of the column in Go; the assignment below does not reach the table
        if (cols[i].name.label === ss(srcID[srcID.length - 1])) {
          e.srcTableColumnIndex = i;
          break;
        }
      }
    }
  }
  if (dst.attributes.shape.value === d2target.ShapeSQLTable) {
    const objAbsID = obj.absIDArray() || [];
    const dstAbsID = dst.absIDArray() || [];
    if (objAbsID.length + dstID.length > dstAbsID.length) {
      const cols = dst.sqlTable.columns || [];
      for (let i = 0; i < cols.length; i++) {
        if (cols[i].name.label === ss(dstID[dstID.length - 1])) {
          e.dstTableColumnIndex = i;
          break;
        }
      }
    }
  }
}

function pluckObjAndEdges(g, obj) {
  let descendantsObjects = null, edges = null;
  for (let i = 0; i < (g.edges || []).length; i++) {
    const edge = g.edges[i];
    if (edge.src.isDescendantOf(obj) && edge.dst.isDescendantOf(obj)) {
      edges = append(edges, edge);
      g.edges = [...g.edges.slice(0, i), ...g.edges.slice(i + 1)];
      i--;
    }
  }

  for (let i = 0; i < (g.objects || []).length; i++) {
    const temp = g.objects[i];
    if (temp.isDescendantOf(obj)) {
      descendantsObjects = append(descendantsObjects, temp);
      g.objects = [...g.objects.slice(0, i), ...g.objects.slice(i + 1)];
      i--;
    }
  }

  return [descendantsObjects, edges];
}

/** `%#v` of a *d2target.MText, as it appears in the "dimensions for ... not found" errors */
function goSharpV(t) {
  return `&d2target.MText{Text:${JSON.stringify(t.text)}, FontSize:${t.fontSize}, IsBold:${t.isBold}, IsItalic:${t.isItalic}, IsUnderline:${t.isUnderline}, Language:${JSON.stringify(t.language)}, Shape:${JSON.stringify(t.shape)}, Dimensions:d2target.TextDimensions{Width:${t.dimensions.width}, Height:${t.dimensions.height}}}`;
}

/** @returns {[object|null, string|null]} dimensions, error message */
function getMarkdownDimensions(mtexts, ruler, t, fontFamily, monoFontFamily) {
  const dims = findMeasured(mtexts, t);
  if (dims) return [dims, null];

  if (ruler) {
    const [width, height] = measureMarkdown(t.text, ruler, fontFamily, monoFontFamily, t.fontSize);
    return [new d2target.TextDimensions(width, height), null];
  }

  if (goTrimSpace(t.text) === '') return [new d2target.TextDimensions(1, 1), null];

  return [null, 'text not pre-measured and no ruler provided'];
}

function appendTextDedup(texts, t) {
  if (getTextDimensions(texts, null, t, null) === null) return append(texts, t);
  return texts;
}

export { GraphObject as Object_ };
export { keyOf as Key };
