// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of D2's d2renderers/d2svg package (github.com/d2lang/d2 v0.9.0, Copyright 2022 Terrastruct Inc.):
// d2svg.go, class.go, table.go, markdown.go (the native Markdown SVG painter), theme.go (the stylesheet pruning) and the
// font corpus scan (font_corpus.go). `render(diagram, opts)` is Go's `Render(diagram, opts)`; `diagram` is the
// d2target.Diagram as `diagramFromJSON` / d2lib's `compile` gives it, `opts` is RenderOpts with camelCase names:
// {pad, sketch, center, themeID, darkThemeID, themeOverrides, darkThemeOverrides, scale, masterID, noXMLTag, salt, omitVersion}
// plus `fonts`: 'embed' (Go-identical: base64 WOFF subsets of the bundled fonts) or 'external' (see fontsEmbed docs).
//
// Pieces that are not in this file are loaded on demand through `hooks` (see `prepare`): the font subsetter (d2svgfonts.js,
// needs the font tables under public/d2/fonts/), the Markdown layout (mdlayout.js), syntax highlighting (highlight.js),
// sketch mode and LaTeX (not ported: they throw `Deferred`).

import * as color from './color.js';
import * as geo from './geo.js';
import * as label from './label.js';
import * as shape from './shape.js';
import * as d2fonts from './fonts.js';
import * as d2target from './target.js';
import * as themes from './themes.js';
import * as svg from './svg.js';
import { formatFloat } from './svg.js';
import * as textmeasure from './textmeasure.js';
import * as urlmod from './url.js';
import { goRound, goInt, goFixed, goV } from './gomath.js';
import { FillPatterns } from './ast.js';
import { TooltipIcon, LinkIcon, BaseStylesheet, dots, lines } from './d2svgassets.js';
import { pruneThemeCSS, pruneThemeCSSWithClasses, collectFontCorporaAndClasses, restrictFontCorpora } from './d2svgcorpus.js';

export const DEFAULT_PADDING = 100;
export const VERSION = 'v0.8.1-HEAD'; // lib/version.Version of the v0.9.0 module (sic)

const appendixIconRadius = 16;

// Legend constants
const LEGEND_PADDING = 20;
const LEGEND_ITEM_SPACING = 15;
const LEGEND_ICON_SIZE = 24;
const LEGEND_FONT_SIZE = 14;
const LEGEND_CORNER_PADDING = 10;

const multipleOffset = geo.newVector(d2target.MULTIPLE_OFFSET, -d2target.MULTIPLE_OFFSET);

export { TooltipIcon, LinkIcon, BaseStylesheet };

/** A case the port does not cover (sketch, LaTeX, a code language without a lexer): the harness counts these as deferred. */
export class Deferred extends Error {
  constructor(reason) { super(`not ported: ${reason}`); this.name = 'Deferred'; this.reason = reason; }
}

/** Pluggable parts, filled by `prepare` (or by the caller). */
export const hooks = {
  /** (family, style) -> TTF/WOFF subsetter: {getEncodedSubset(family, style, corpus)} (d2svgfonts.js) */
  fonts: null,
  /** {layoutMarkdown(markdown, ruler, fontFamily, monoFontFamily, fontSize) -> MarkdownLayout} (mdlayout.js) */
  markdown: null,
  /** {highlight(language, text) -> null | {light: [[type, text]...], dark: ..., styles...}} (highlight.js) */
  highlight: null,
  /** textmeasure.Ruler, created on first use */
  ruler: null,
  /** patternassets: {paperSVG(), grainSVG(), streakSVG()} (d2svgpatterns.js) */
  patterns: null,
};

function getRuler() {
  if (hooks.ruler == null) hooks.ruler = textmeasure.newRuler();
  return hooks.ruler;
}

class Buf {
  constructor() { this.s = ''; }
  write(x) { this.s += x; }
  toString() { return this.s; }
}

const htmlEscape = (s) => s.replace(/[&'<>"]/g, (c) => (c === '&' ? '&amp;' : c === "'" ? '&#39;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&#34;'));

const utf8 = new TextEncoder();
function b64url(str) {
  const bytes = utf8.encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_');
}

// fnv.New32a over s+"lalalas" as fmt.Sprint(uint32)
function hash(s) {
  const secret = 'lalalas';
  const bytes = utf8.encode(s + secret);
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return String(h >>> 0);
}

const iconString = (icon) => (icon instanceof urlmod.URL ? icon : Object.assign(new urlmod.URL(), icon)).toString();

// ---- integer checks (int is 64 bit) ----

const MAXINT = (1n << 63n) - 1n;
const MININT = -MAXINT - 1n;
const invalidPaddingError = (pad) => new Error(`padding ${pad} produces invalid SVG dimensions`);
const checkedIntAdd = (a, b) => { const s = a + b; return s > MAXINT || s < MININT ? null : s; };
const checkedIntSub = (a, b) => { const s = a - b; return s > MAXINT || s < MININT ? null : s; };

function validatePadding(tl, br, pad) {
  const bpad = BigInt(Math.trunc(pad));
  if (bpad < MININT || bpad > MAXINT) throw invalidPaddingError(pad);
  const doublePad = checkedIntAdd(bpad, bpad);
  if (doublePad === null) throw invalidPaddingError(pad);
  for (const [lo, hi] of [[BigInt(tl.x), BigInt(br.x)], [BigInt(tl.y), BigInt(br.y)]]) {
    if (checkedIntSub(lo, bpad) === null) throw invalidPaddingError(pad);
    const size = checkedIntSub(hi, lo);
    if (size === null) throw invalidPaddingError(pad);
    if (checkedIntAdd(size, doublePad) === null) throw invalidPaddingError(pad);
  }
  return Number(bpad);
}

/** returns [left, top, width, height] or null */
function expandDimensions(left, top, width, height, amount) {
  const a = BigInt(amount);
  const doubleAmount = checkedIntAdd(a, a);
  if (doubleAmount === null) return null;
  const left64 = checkedIntSub(BigInt(left), a);
  if (left64 === null) return null;
  const top64 = checkedIntSub(BigInt(top), a);
  if (top64 === null) return null;
  const width64 = checkedIntAdd(BigInt(width), doubleAmount);
  if (width64 === null) return null;
  const height64 = checkedIntAdd(BigInt(height), doubleAmount);
  if (height64 === null) return null;
  return [Number(left64), Number(top64), Number(width64), Number(height64)];
}

function fontToFamily(fontFamily) {
  return Object.prototype.hasOwnProperty.call(d2fonts.D2_FONT_TO_FAMILY, fontFamily) ? d2fonts.D2_FONT_TO_FAMILY[fontFamily] : null;
}

/** the shared body of dimensions/RenderLegend: [totalHeight, maxLabelWidth, itemCount] (before the final padding) */
function legendMetrics(diagram, ruler) {
  let totalHeight = LEGEND_PADDING + LEGEND_FONT_SIZE + LEGEND_ITEM_SPACING;
  let maxLabelWidth = 0;
  let itemCount = 0;
  for (const list of [diagram.legend.shapes ?? [], diagram.legend.connections ?? []]) {
    for (const s of list) {
      if (s.label === '') continue;
      const mtext = new d2target.MText({ text: s.label, fontSize: LEGEND_FONT_SIZE });
      const dims = textmeasure.getTextDimensions(null, ruler, mtext, fontToFamily(s.fontFamily));
      maxLabelWidth = Math.max(maxLabelWidth, dims.width);
      totalHeight += Math.max(dims.height, LEGEND_ICON_SIZE) + LEGEND_ITEM_SPACING;
      itemCount++;
    }
  }
  if (itemCount > 0) totalHeight -= Math.trunc(LEGEND_ITEM_SPACING / 2);
  return [totalHeight, maxLabelWidth, itemCount];
}

const hasLegend = (diagram) => diagram.legend != null && ((diagram.legend.shapes ?? []).length > 0 || (diagram.legend.connections ?? []).length > 0);

/** returns [left, top, width, height] */
function dimensions(diagram, pad, tl, br) {
  let left = tl.x - pad;
  let top = tl.y - pad;
  let width = br.x - tl.x + pad * 2;
  let height = br.y - tl.y + pad * 2;

  // Account for legend dimensions if present
  if (hasLegend(diagram)) {
    const ruler = getRuler();
    if (ruler != null) {
      let [totalHeight, maxLabelWidth, itemCount] = legendMetrics(diagram, ruler);

      if (itemCount > 0 && (diagram.legend.connections ?? []).length > 0) totalHeight += LEGEND_PADDING * 1.5;
      else totalHeight += 24; // LEGEND_PADDING * 1.2

      if (totalHeight > 0 && maxLabelWidth > 0) {
        const legendWidth = LEGEND_PADDING * 2 + LEGEND_ICON_SIZE + LEGEND_PADDING + maxLabelWidth;
        let legendY = br.y - totalHeight;
        if (legendY < tl.y) legendY = tl.y;

        const legendRight = br.x + LEGEND_CORNER_PADDING + legendWidth;
        if (left + width < legendRight) width = legendRight - left + Math.trunc(pad / 2);

        if (legendY < top) {
          const diffY = top - legendY;
          top -= diffY;
          height += diffY;
        }

        const legendBottom = legendY + totalHeight;
        if (top + height < legendBottom) height = legendBottom - top + Math.trunc(pad / 2);
      }
    }
  }
  return [left, top, width, height];
}

export function renderLegend(buf, diagram, diagramHash, theme) {
  if (!hasLegend(diagram)) return;

  const [tl, br] = diagram.boundingBox();
  const ruler = getRuler();

  let [totalHeight, maxLabelWidth, itemCount] = legendMetrics(diagram, ruler);

  if (itemCount > 0 && (diagram.legend.connections ?? []).length > 0) totalHeight += LEGEND_PADDING * 1.5;
  else totalHeight += 24; // LEGEND_PADDING * 1.2

  const legendWidth = LEGEND_PADDING * 2 + LEGEND_ICON_SIZE + LEGEND_PADDING + maxLabelWidth;
  const legendX = br.x + LEGEND_CORNER_PADDING;
  let legendY = br.y - totalHeight;
  if (legendY < tl.y) legendY = tl.y;

  const shadowEl = themes.newThemableElement('rect', theme);
  shadowEl.Fill = '#F7F7FA';
  shadowEl.Stroke = '#DEE1EB';
  shadowEl.Style = 'stroke-width: 1px; filter: drop-shadow(0px 2px 3px rgba(0, 0, 0, 0.1))';
  shadowEl.X = legendX;
  shadowEl.Y = legendY;
  shadowEl.Width = legendWidth;
  shadowEl.Height = totalHeight;
  shadowEl.Rx = 4;
  buf.write(shadowEl.render());

  const legendEl = themes.newThemableElement('rect', theme);
  legendEl.Fill = '#ffffff';
  legendEl.Stroke = '#DEE1EB';
  legendEl.Style = 'stroke-width: 1px';
  legendEl.X = legendX;
  legendEl.Y = legendY;
  legendEl.Width = legendWidth;
  legendEl.Height = totalHeight;
  legendEl.Rx = 4;
  buf.write(legendEl.render());

  let legendLabel = 'Legend';
  if (diagram.legend.label !== '') legendLabel = diagram.legend.label;
  buf.write(`<text class="text-bold" x="${legendX + LEGEND_PADDING}" y="${legendY + LEGEND_PADDING + LEGEND_FONT_SIZE}" style="font-size: ${LEGEND_FONT_SIZE + 2}px;">${htmlEscape(legendLabel)}</text>`);

  let currentY = legendY + LEGEND_PADDING * 2 + LEGEND_FONT_SIZE;

  let shapeCount = 0;
  for (const s of diagram.legend.shapes ?? []) {
    if (s.label === '') continue;

    const iconX = legendX + LEGEND_PADDING;
    const iconY = currentY;

    buf.write(renderLegendShapeIcon(s, iconX, iconY, diagramHash, theme));

    const mtext = new d2target.MText({ text: s.label, fontSize: LEGEND_FONT_SIZE });
    const dims = textmeasure.getTextDimensions(null, ruler, mtext, fontToFamily(s.fontFamily));

    const rowHeight = Math.max(dims.height, LEGEND_ICON_SIZE);
    const textY = currentY + Math.trunc(rowHeight / 2) + goInt(dims.height * 0.3);

    buf.write(`<text class="text" x="${iconX + LEGEND_ICON_SIZE + LEGEND_PADDING}" y="${textY}" style="font-size: ${LEGEND_FONT_SIZE}px;">${htmlEscape(s.label)}</text>`);

    currentY += rowHeight + LEGEND_ITEM_SPACING;
    shapeCount++;
  }

  if (shapeCount > 0 && (diagram.legend.connections ?? []).length > 0) {
    currentY += Math.trunc(LEGEND_ITEM_SPACING / 2);

    const separatorEl = themes.newThemableElement('line', theme);
    separatorEl.X1 = legendX + LEGEND_PADDING;
    separatorEl.Y1 = currentY;
    separatorEl.X2 = legendX + legendWidth - LEGEND_PADDING;
    separatorEl.Y2 = currentY;
    separatorEl.Stroke = '#DEE1EB';
    separatorEl.StrokeDashArray = '2,2';
    buf.write(separatorEl.render());

    currentY += LEGEND_ITEM_SPACING;
  }

  for (const c of diagram.legend.connections ?? []) {
    if (c.label === '') continue;

    const iconX = legendX + LEGEND_PADDING;
    const iconY = currentY + Math.trunc(LEGEND_ICON_SIZE / 2);

    buf.write(renderLegendConnectionIcon(c, iconX, iconY, theme));

    const mtext = new d2target.MText({ text: c.label, fontSize: LEGEND_FONT_SIZE });
    const dims = textmeasure.getTextDimensions(null, ruler, mtext, fontToFamily(c.fontFamily));

    const rowHeight = Math.max(dims.height, LEGEND_ICON_SIZE);
    const textY = currentY + Math.trunc(rowHeight / 2) + goInt(dims.height * 0.2);

    buf.write(`<text class="text" x="${iconX + LEGEND_ICON_SIZE + LEGEND_PADDING}" y="${textY}" style="font-size: ${LEGEND_FONT_SIZE}px;">${htmlEscape(c.label)}</text>`);

    currentY += rowHeight + LEGEND_ITEM_SPACING;
  }
}

const copyStruct = (o) => Object.assign(Object.create(Object.getPrototypeOf(o)), o);

function renderLegendShapeIcon(s, x, y, diagramHash, theme) {
  const iconShape = copyStruct(s);
  const sizeFactor = 5;
  iconShape.pos = new d2target.Point(0, 0);
  iconShape.width = LEGEND_ICON_SIZE * sizeFactor;
  iconShape.height = LEGEND_ICON_SIZE * sizeFactor;
  iconShape.label = '';
  const buf = new Buf();
  const appendixBuf = new Buf();
  const finalBuf = new Buf();
  finalBuf.write(`<g transform="translate(${x}, ${y}) scale(${formatFloat(1.0 / sizeFactor)})">`);
  drawShape(buf, appendixBuf, diagramHash, iconShape, false, theme, newMarkdownRenderer(null, null, theme));

  finalBuf.write(buf.s);
  finalBuf.write('</g>');
  return finalBuf.s;
}

function renderLegendConnectionIcon(c, x, y, theme) {
  const finalBuf = new Buf();
  const buf = new Buf();

  const sizeFactor = 2;

  const legendConn = d2target.baseConnection();

  legendConn.id = c.id;
  legendConn.srcArrow = c.srcArrow;
  legendConn.dstArrow = c.dstArrow;
  legendConn.strokeDash = c.strokeDash;
  legendConn.strokeWidth = c.strokeWidth;
  legendConn.stroke = c.stroke;
  legendConn.fill = c.fill;
  legendConn.borderRadius = c.borderRadius;
  legendConn.opacity = c.opacity;
  legendConn.animated = c.animated;

  const startX = 0.0;
  const midY = 0.0;
  const width = LEGEND_ICON_SIZE * sizeFactor;

  legendConn.route = [new geo.Point(startX, midY), new geo.Point(startX + width, midY)];

  const legendHash = `legend-${hash(`${c.id}-${x}-${y}`)}`;

  const markers = new Set();
  const idToShape = new Map();

  finalBuf.write(`<g transform="translate(${x}, ${y}) scale(${formatFloat(1.0 / sizeFactor)})">`);

  drawConnection(buf, legendHash, legendConn, markers, idToShape, false, theme, newMarkdownRenderer(null, null, theme));

  finalBuf.write(buf.s);
  finalBuf.write('</g>');
  return finalBuf.s;
}

function arrowheadMarkerID(diagramHash, isTarget, connection) {
  const arrowhead = isTarget ? connection.dstArrow : connection.srcArrow;
  return `mk-${diagramHash}-${hash(`${arrowhead},${isTarget},${connection.strokeWidth},${connection.stroke}`)}`;
}

function arrowheadMarker(isTarget, id, connection, inlineTheme) {
  const F = formatFloat;
  const arrowhead = isTarget ? connection.dstArrow : connection.srcArrow;
  const strokeWidth = connection.strokeWidth;
  let [width, height] = d2target.arrowheadDimensions(arrowhead, strokeWidth);
  const sw = `stroke-width="${connection.strokeWidth}"`;

  let path;
  switch (arrowhead) {
    case d2target.ArrowArrowhead: {
      const polygonEl = themes.newThemableElement('polygon', inlineTheme);
      polygonEl.Fill = connection.stroke;
      polygonEl.ClassName = 'connection';
      polygonEl.Attributes = sw;

      if (isTarget) {
        polygonEl.Points = `${F(0)},${F(0)} ${F(width)},${F(height / 2)} ${F(0)},${F(height)} ${F(width / 4)},${F(height / 2)}`;
      } else {
        polygonEl.Points = `${F(0)},${F(height / 2)} ${F(width)},${F(0)} ${F(width * 3 / 4)},${F(height / 2)} ${F(width)},${F(height)}`;
      }
      path = polygonEl.render();
      break;
    }
    case d2target.UnfilledTriangleArrowhead: {
      const polygonEl = themes.newThemableElement('polygon', inlineTheme);
      polygonEl.Fill = d2target.BG_COLOR;
      polygonEl.Stroke = connection.stroke;
      polygonEl.ClassName = 'connection';
      polygonEl.Attributes = sw;

      const inset = strokeWidth / 2;
      if (isTarget) {
        polygonEl.Points = `${F(inset)},${F(inset)} ${F(width - inset)},${F(height / 2.0)} ${F(inset)},${F(height - inset)}`;
      } else {
        polygonEl.Points = `${F(width - inset)},${F(inset)} ${F(inset)},${F(height / 2.0)} ${F(width - inset)},${F(height - inset)}`;
      }
      path = polygonEl.render();
      break;
    }
    case d2target.TriangleArrowhead: {
      const polygonEl = themes.newThemableElement('polygon', inlineTheme);
      polygonEl.Fill = connection.stroke;
      polygonEl.ClassName = 'connection';
      polygonEl.Attributes = sw;

      if (isTarget) {
        polygonEl.Points = `${F(0)},${F(0)} ${F(width)},${F(height / 2.0)} ${F(0)},${F(height)}`;
      } else {
        polygonEl.Points = `${F(width)},${F(0)} ${F(0)},${F(height / 2.0)} ${F(width)},${F(height)}`;
      }
      path = polygonEl.render();
      break;
    }
    case d2target.LineArrowhead: {
      const polylineEl = themes.newThemableElement('polyline', inlineTheme);
      polylineEl.Fill = color.None;
      polylineEl.ClassName = 'connection';
      polylineEl.Stroke = connection.stroke;
      polylineEl.Attributes = sw;

      if (isTarget) {
        polylineEl.Points = `${F(strokeWidth / 2)},${F(strokeWidth / 2)} ${F(width - strokeWidth / 2)},${F(height / 2)} ${F(strokeWidth / 2)},${F(height - strokeWidth / 2)}`;
      } else {
        polylineEl.Points = `${F(width - strokeWidth / 2)},${F(strokeWidth / 2)} ${F(strokeWidth / 2)},${F(height / 2)} ${F(width - strokeWidth / 2)},${F(height - strokeWidth / 2)}`;
      }
      path = polylineEl.render();
      break;
    }
    case d2target.FilledDiamondArrowhead: {
      const polygonEl = themes.newThemableElement('polygon', inlineTheme);
      polygonEl.ClassName = 'connection';
      polygonEl.Fill = connection.stroke;
      polygonEl.Attributes = sw;

      // both directions print the same points
      polygonEl.Points = `${F(0)},${F(height / 2.0)} ${F(width / 2.0)},${F(0)} ${F(width)},${F(height / 2.0)} ${F(width / 2.0)},${F(height)}`;
      path = polygonEl.render();
      break;
    }
    case d2target.DiamondArrowhead: {
      const polygonEl = themes.newThemableElement('polygon', inlineTheme);
      polygonEl.ClassName = 'connection';
      polygonEl.Fill = d2target.BG_COLOR;
      polygonEl.Stroke = connection.stroke;
      polygonEl.Attributes = sw;

      if (isTarget) {
        polygonEl.Points = `${F(0)},${F(height / 2.0)} ${F(width / 2)},${F(height / 8)} ${F(width)},${F(height / 2.0)} ${F(width / 2.0)},${F(height * 0.9)}`;
      } else {
        polygonEl.Points = `${F(width / 8)},${F(height / 2.0)} ${F(width * 0.6)},${F(height / 8)} ${F(width * 1.1)},${F(height / 2.0)} ${F(width * 0.6)},${F(height * 7 / 8)}`;
      }
      path = polygonEl.render();
      break;
    }
    case d2target.FilledCircleArrowhead: {
      const radius = width / 2;

      const circleEl = themes.newThemableElement('circle', inlineTheme);
      circleEl.Cy = radius;
      circleEl.R = radius - strokeWidth / 2;
      circleEl.Fill = connection.stroke;
      circleEl.ClassName = 'connection';
      circleEl.Attributes = sw;

      if (isTarget) circleEl.Cx = radius + strokeWidth / 2;
      else circleEl.Cx = radius - strokeWidth / 2;

      path = circleEl.render();
      break;
    }
    case d2target.CircleArrowhead: {
      const radius = width / 2;

      const circleEl = themes.newThemableElement('circle', inlineTheme);
      circleEl.Cy = radius;
      circleEl.R = radius - strokeWidth;
      circleEl.Fill = d2target.BG_COLOR;
      circleEl.Stroke = connection.stroke;
      circleEl.Attributes = sw;

      if (isTarget) circleEl.Cx = radius + strokeWidth / 2;
      else circleEl.Cx = radius - strokeWidth / 2;

      path = circleEl.render();
      break;
    }
    case d2target.CrossArrowhead: {
      const inset = strokeWidth / 8;
      const rotationAngle = Math.PI / 4;
      const origin = geo.newPoint(width / 2, height / 2);
      const newOrigin = geo.newPoint(Math.cos(rotationAngle) * origin.x - Math.sin(rotationAngle) * origin.y, Math.sin(rotationAngle) * origin.x + Math.cos(rotationAngle) * origin.y);

      const crossEl = themes.newThemableElement('polygon', inlineTheme);
      crossEl.Points = `${F(0)},${F(height / 2 + inset)} ${F(width / 2 - inset)},${F(height / 2 + inset)} ${F(width / 2 - inset)},${F(height)} ${F(width / 2 + inset)},${F(height)}, ${F(width / 2 + inset)},${F(height / 2 + inset)} ${F(width)},${F(height / 2 + inset)} ${F(width)},${F(height / 2 - inset)} ${F(width / 2 + inset)},${F(height / 2 - inset)} ${F(width / 2 + inset)},${F(0)} ${F(width / 2 - inset)},${F(0)} ${F(width / 2 - inset)},${F(height / 2 - inset)} ${F(0)},${F(height / 2 - inset)}`;
      crossEl.Transform = `translate(${F(-newOrigin.x + width / 2)}, ${F(-newOrigin.y + height / 2)}) rotate(45)`;

      const childPathEl = themes.newThemableElement('path', inlineTheme);
      if (isTarget) childPathEl.D = `M${F(width / 2)},${F(height / 2)} ${F(width)},${F(height / 2)}`;
      else childPathEl.D = `M${F(width / 2)},${F(height / 2)} ${F(0)},${F(height / 2)}`;

      const gEl = themes.newThemableElement('g', inlineTheme);
      gEl.Fill = d2target.BG_COLOR;
      gEl.Stroke = connection.stroke;
      gEl.ClassName = 'connection';
      gEl.Attributes = sw;
      gEl.Content = `${crossEl.render()}${childPathEl.render()}`;
      path = gEl.render();
      break;
    }
    case d2target.FilledBoxArrowhead: {
      const polygonEl = themes.newThemableElement('polygon', inlineTheme);
      polygonEl.ClassName = 'connection';
      polygonEl.Fill = connection.stroke;
      polygonEl.Attributes = sw;

      // both directions print the same points
      polygonEl.Points = `${F(0)},${F(0)} ${F(0)},${F(height)} ${F(width)},${F(height)} ${F(width)},${F(0)}`;
      path = polygonEl.render();
      break;
    }
    case d2target.BoxArrowhead: {
      const polygonEl = themes.newThemableElement('polygon', inlineTheme);
      polygonEl.ClassName = 'connection';
      polygonEl.Fill = d2target.BG_COLOR;
      polygonEl.Stroke = connection.stroke;
      polygonEl.Attributes = sw;
      polygonEl.Style = `${polygonEl.Style}stroke-linejoin:miter;`;

      const inset = strokeWidth / 2;
      // both directions print the same points
      polygonEl.Points = `${F(inset)},${F(inset)} ${F(inset)},${F(height - inset)} ${F(width - inset)},${F(height - inset)} ${F(width - inset)},${F(inset)}`;
      path = polygonEl.render();
      break;
    }
    case d2target.CfOne: case d2target.CfMany: case d2target.CfOneRequired: case d2target.CfManyRequired: {
      const offset = 3.0 + connection.strokeWidth * 1.8;

      let modifierEl;
      if (arrowhead === d2target.CfOneRequired || arrowhead === d2target.CfManyRequired) {
        modifierEl = themes.newThemableElement('path', inlineTheme);
        modifierEl.D = `M${F(offset)},${F(0)} ${F(offset)},${F(height)}`;
        modifierEl.Fill = d2target.BG_COLOR;
        modifierEl.Stroke = connection.stroke;
        modifierEl.ClassName = 'connection';
        modifierEl.Attributes = sw;
      } else {
        modifierEl = themes.newThemableElement('circle', inlineTheme);
        modifierEl.Cx = offset / 2.0 + 2.0;
        modifierEl.Cy = height / 2.0;
        modifierEl.R = offset / 2.0;
        modifierEl.Fill = d2target.BG_COLOR;
        modifierEl.Stroke = connection.stroke;
        modifierEl.ClassName = 'connection';
        modifierEl.Attributes = sw;
      }

      const childPathEl = themes.newThemableElement('path', inlineTheme);
      if (arrowhead === d2target.CfMany || arrowhead === d2target.CfManyRequired) {
        childPathEl.D = `M${F(width - 3.0)},${F(height / 2.0)} ${F(width + offset)},${F(height / 2.0)} M${F(offset + 3.0)},${F(height / 2.0)} ${F(width + offset)},${F(0)} M${F(offset + 3.0)},${F(height / 2.0)} ${F(width + offset)},${F(height)}`;
      } else {
        childPathEl.D = `M${F(width - 3.0)},${F(height / 2.0)} ${F(width + offset)},${F(height / 2.0)} M${F(offset * 2.0)},${F(0)} ${F(offset * 2.0)},${F(height)}`;
      }

      const gEl = themes.newThemableElement('g', inlineTheme);
      if (!isTarget) gEl.Transform = `scale(-1) translate(-${F(width)}, -${F(height)})`;
      gEl.Fill = d2target.BG_COLOR;
      gEl.Stroke = connection.stroke;
      gEl.ClassName = 'connection';
      gEl.Attributes = sw;
      gEl.Content = `${modifierEl.render()}${childPathEl.render()}`;
      path = gEl.render();
      break;
    }
    default:
      return '';
  }

  let refX;
  const refY = height / 2;
  switch (arrowhead) {
    case d2target.DiamondArrowhead:
      if (isTarget) refX = width - 0.6 * strokeWidth;
      else refX = width / 8 + 0.6 * strokeWidth;
      width *= 1.1;
      break;
    default:
      if (isTarget) refX = width - 1.5 * strokeWidth;
      else refX = 1.5 * strokeWidth;
  }

  return [
    `<marker id="${id}" markerWidth="${F(width)}" markerHeight="${F(height)}" refX="${F(refX)}" refY="${F(refY)}"`,
    `viewBox="${F(0)} ${F(0)} ${F(width)} ${F(height)}"`,
    'orient="auto" markerUnits="userSpaceOnUse">',
    path,
    '</marker>',
  ].join(' ');
}

/** compute the (dx, dy) adjustment to apply to get the arrowhead-adjusted end point */
function arrowheadAdjustment(start, end, arrowhead, edgeStrokeWidth, shapeStrokeWidth) {
  let distance = (edgeStrokeWidth + shapeStrokeWidth) / 2.0;
  if (arrowhead !== d2target.NoArrowhead) distance += edgeStrokeWidth;

  const v = geo.newVector(end.x - start.x, end.y - start.y);
  return v.unit().multiply(-distance).toPoint();
}

const noShape = { strokeWidth: 0 };

function getArrowheadAdjustments(connection, idToShape) {
  const route = connection.route;
  const srcShape = idToShape.get(connection.src) ?? noShape;
  const dstShape = idToShape.get(connection.dst) ?? noShape;

  const sourceAdjustment = arrowheadAdjustment(route[1], route[0], connection.srcArrow, connection.strokeWidth, srcShape.strokeWidth);

  const targetAdjustment = arrowheadAdjustment(route[route.length - 2], route[route.length - 1], connection.dstArrow, connection.strokeWidth, dstShape.strokeWidth);
  return [sourceAdjustment, targetAdjustment];
}

/** returns the path's d attribute for the given connection */
function pathData(connection, srcAdj, dstAdj) {
  const F = formatFloat;
  const path = [];
  const route = connection.route;

  path.push(`M ${F(route[0].x + srcAdj.x)} ${F(route[0].y + srcAdj.y)}`);

  if (connection.isCurve) {
    let i = 1;
    for (; i < route.length - 3; i += 3) {
      path.push(`C ${F(route[i].x)} ${F(route[i].y)} ${F(route[i + 1].x)} ${F(route[i + 1].y)} ${F(route[i + 2].x)} ${F(route[i + 2].y)}`);
    }
    // final curve target adjustment
    path.push(`C ${F(route[i].x)} ${F(route[i].y)} ${F(route[i + 1].x)} ${F(route[i + 1].y)} ${F(route[i + 2].x + dstAdj.x)} ${F(route[i + 2].y + dstAdj.y)}`);
  } else {
    for (let i = 1; i < route.length - 1; i++) {
      const prevSource = route[i - 1];
      const prevTarget = route[i];
      const currTarget = route[i + 1];
      const prevVector = prevSource.vectorTo(prevTarget);
      const currVector = prevTarget.vectorTo(currTarget);

      const dist = geo.euclideanDistance(prevTarget.x, prevTarget.y, currTarget.x, currTarget.y);

      const connectionBorderRadius = connection.borderRadius;
      const units = Math.min(connectionBorderRadius, dist / 2);

      const prevTranslations = prevVector.unit().multiply(units).toPoint();
      const currTranslations = currVector.unit().multiply(units).toPoint();

      path.push(`L ${F(prevTarget.x - prevTranslations.x)} ${F(prevTarget.y - prevTranslations.y)}`);

      // If the segment length is too small, instead of drawing 2 arcs, just skip this segment and bezier curve to the next one
      if (units < connectionBorderRadius && i < route.length - 2) {
        const nextTarget = route[i + 2];
        const nextVector = geo.newVector(nextTarget.x - currTarget.x, nextTarget.y - currTarget.y);
        i++;
        const nextTranslations = nextVector.unit().multiply(units).toPoint();

        // These 2 bezier control points aren't just at the corner -- they are reflected at the corner, which causes the curve to be ~tangent to the corner,
        // which matches how the two arcs look
        path.push(`C ${F(prevTarget.x + prevTranslations.x)} ${F(prevTarget.y + prevTranslations.y)} ${F(currTarget.x - nextTranslations.x)} ${F(currTarget.y - nextTranslations.y)} ${F(currTarget.x + nextTranslations.x)} ${F(currTarget.y + nextTranslations.y)}`);
      } else {
        path.push(`S ${F(prevTarget.x)} ${F(prevTarget.y)} ${F(prevTarget.x + currTranslations.x)} ${F(prevTarget.y + currTranslations.y)}`);
      }
    }

    const lastPoint = route[route.length - 1];
    path.push(`L ${F(lastPoint.x + dstAdj.x)} ${F(lastPoint.y + dstAdj.y)}`);
  }

  return path.join(' ');
}

function makeLabelMask(labelTL, width, height, opacity) {
  return makeLabelMaskWithTransform(labelTL, width, height, opacity, null);
}

function makeLabelMaskWithTransform(labelTL, width, height, opacity, shapePos) {
  let fill = 'black';
  if (opacity !== 1) fill = `rgba(0,0,0,${goFixed(opacity, 2)})`;

  let x = labelTL.x - 2;
  let y = labelTL.y;

  // In sketch mode, shapes use transform="translate(shapePos.X, shapePos.Y)"
  // so we need to adjust mask coordinates to account for this transform
  if (shapePos != null) {
    x -= shapePos.x;
    y -= shapePos.y;
  }

  return `<rect x="${formatFloat(x)}" y="${formatFloat(y)}" width="${width + 4}" height="${height}" fill="${fill}"></rect>`;
}

/**
 * border label mask is minimal, intending to only cover the portion of the border that passes through the label
 * otherwise, when the inside background and outside background colors don't match, there's a bigger discrepancy
 */
function makeBorderLabelMask(labelPosition, labelTL, labelWidth, labelHeight, shapeBox, strokeWidth, opacity, shapePos) {
  let fill = 'black';
  if (opacity !== 1) fill = `rgba(0,0,0,${goFixed(opacity, 2)})`;

  // In sketch mode, multiply stroke width by 3 for mask calculations to account for
  // the hand-drawn style that can be wider and more irregular
  let effectiveStrokeWidth = strokeWidth;
  if (shapePos != null) effectiveStrokeWidth *= 3;

  let maskX, maskY, maskWidth, maskHeight;

  switch (labelPosition) {
    case label.BorderTopLeft: case label.BorderTopCenter: case label.BorderTopRight:
      maskX = labelTL.x - 2;
      maskY = shapeBox.TopLeft.y - effectiveStrokeWidth / 2;
      maskWidth = labelWidth + 4;
      maskHeight = effectiveStrokeWidth;
      break;

    case label.BorderBottomLeft: case label.BorderBottomCenter: case label.BorderBottomRight:
      maskX = labelTL.x - 2;
      maskY = shapeBox.TopLeft.y + shapeBox.Height - effectiveStrokeWidth / 2;
      maskWidth = labelWidth + 4;
      maskHeight = effectiveStrokeWidth;
      break;

    case label.BorderLeftTop: case label.BorderLeftMiddle: case label.BorderLeftBottom:
      maskX = shapeBox.TopLeft.x - effectiveStrokeWidth / 2;
      maskY = labelTL.y - 2;
      maskWidth = effectiveStrokeWidth;
      maskHeight = labelHeight + 4;
      break;

    case label.BorderRightTop: case label.BorderRightMiddle: case label.BorderRightBottom:
      maskX = shapeBox.TopLeft.x + shapeBox.Width - effectiveStrokeWidth / 2;
      maskY = labelTL.y - 2;
      maskWidth = effectiveStrokeWidth;
      maskHeight = labelHeight + 4;
      break;

    default:
      // never gets here
      return '';
  }

  // In sketch mode, adjust coordinates to account for shape transform
  if (shapePos != null) {
    maskX -= shapePos.x;
    maskY -= shapePos.y;
  }

  return `<rect x="${formatFloat(maskX)}" y="${formatFloat(maskY)}" width="${formatFloat(maskWidth)}" height="${formatFloat(maskHeight)}" fill="${fill}"></rect>`;
}

// ---- code highlighting (chroma) ----

const svgEscaper = (s) => s.replace(/[&<>" \t]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : c === ' ' ? '&#160;' : '&#160;&#160;&#160;&#160;'));

/**
 * The tokens of a code label for the light ("github") and dark ("catppuccin-mocha") styles, via the highlight hook:
 * [{svgStyles: {tokenType: attrString}, background: '#rrggbb', lines: [[{type, value}...]...]} x 2]
 */
function highlightCode(language, text) {
  if (hooks.highlight == null) throw new Deferred(`code language ${language} (no highlighter loaded)`);
  const out = hooks.highlight.highlight(language, text);
  if (out == null) throw new Deferred(`code language ${language}`);
  return out;
}

function renderCodeLines(writer, lines, svgStyles, lineHeight) {
  lines.forEach((tokens, index) => {
    writer.write(`<text class="text-mono" x="0" y="${formatFloat(1 + index * lineHeight)}em">`);
    for (const token of tokens) {
      let text = svgEscaper(token.value);
      const attr = hooks.highlight.styleAttr(svgStyles, token.type);
      if (attr !== '') text = `<tspan ${attr}>${text}</tspan>`;
      writer.write(text);
    }
    writer.write('</text>');
  });
}

function drawConnection(writer, diagramHash, connection, markers, idToShape, sketch, inlineTheme, markdown) {
  let labelMask = '';
  let opacityStyle = '';
  if (connection.opacity !== 1.0) opacityStyle = ` style='opacity:${formatFloat(connection.opacity)}'`;

  const classes = [b64url(svg.escapeText(connection.id))];
  classes.push(...(connection.classes ?? []));
  const classStr = ` class="${classes.join(' ')}"`;

  writer.write(`<g${classStr}${opacityStyle}>`);
  let markerStart = '';
  if (connection.srcArrow !== d2target.NoArrowhead) {
    const id = arrowheadMarkerID(diagramHash, false, connection);
    if (!markers.has(id)) {
      const marker = arrowheadMarker(false, id, connection, inlineTheme);
      if (marker === '') throw new Error(`received empty arrow head marker for: ${JSON.stringify(connection)}`);
      writer.write(marker);
      markers.add(id);
    }
    markerStart = `marker-start="url(#${id})" `;
  }

  let markerEnd = '';
  if (connection.dstArrow !== d2target.NoArrowhead) {
    const id = arrowheadMarkerID(diagramHash, true, connection);
    if (!markers.has(id)) {
      const marker = arrowheadMarker(true, id, connection, inlineTheme);
      if (marker === '') throw new Error(`received empty arrow head marker for: ${JSON.stringify(connection)}`);
      writer.write(marker);
      markers.add(id);
    }
    markerEnd = `marker-end="url(#${id})" `;
  }

  if (connection.icon != null) {
    const iconPos = connection.getIconPosition();
    if (iconPos != null) {
      let connectionIconClipPath = '';
      if (connection.iconBorderRadius !== 0) connectionIconClipPath = ` clip-path="inset(0 round ${formatFloat(connection.iconBorderRadius)}px)"`;
      writer.write(`<image href="${htmlEscape(iconString(connection.icon))}" x="${formatFloat(iconPos.x)}" y="${formatFloat(iconPos.y)}" width="${d2target.DEFAULT_ICON_SIZE}" height="${d2target.DEFAULT_ICON_SIZE}"${connectionIconClipPath} />`);
    }
  }

  let labelTL = null;
  if (connection.label !== '') {
    labelTL = connection.getLabelTopLeft();
    labelTL.x = goRound(labelTL.x);
    labelTL.y = goRound(labelTL.y);

    const maskTL = labelTL.copy();
    let width = connection.labelWidth;
    const height = connection.labelHeight;

    if (connection.icon != null) {
      width += d2target.CONNECTION_ICON_LABEL_GAP + d2target.DEFAULT_ICON_SIZE;
      maskTL.x -= d2target.CONNECTION_ICON_LABEL_GAP + d2target.DEFAULT_ICON_SIZE;
    }

    if (label.isOnEdge(label.fromString(connection.labelPosition))) labelMask = makeLabelMask(maskTL, width, height, 1);
    else labelMask = makeLabelMask(maskTL, width, height, 0.75);
  } else if (connection.icon != null) {
    const iconPos = connection.getIconPosition();
    if (iconPos != null) {
      const maskTL = new geo.Point(iconPos.x, iconPos.y);
      if (label.isOnEdge(label.fromString(connection.iconPosition))) labelMask = makeLabelMask(maskTL, d2target.DEFAULT_ICON_SIZE, d2target.DEFAULT_ICON_SIZE, 1);
      else labelMask = makeLabelMask(maskTL, d2target.DEFAULT_ICON_SIZE, d2target.DEFAULT_ICON_SIZE, 0.75);
    }
  }

  const [srcAdj, dstAdj] = getArrowheadAdjustments(connection, idToShape);
  const path = pathData(connection, srcAdj, dstAdj);
  const mask = `mask="url(#${diagramHash})"`;

  if (sketch) {
    throw new Deferred('sketch');
  } else {
    let animatedClass = '';
    if (connection.animated) animatedClass = ' animated-connection';

    // If connection is animated and bidirectional
    if (connection.animated && ((connection.dstArrow === d2target.NoArrowhead && connection.srcArrow === d2target.NoArrowhead) || (connection.dstArrow !== d2target.NoArrowhead && connection.srcArrow !== d2target.NoArrowhead))) {
      // There is no pure CSS way to animate bidirectional connections in two directions, so we split it up
      const [path1, path2] = svg.splitPath(path, 0.5);

      const pathEl1 = themes.newThemableElement('path', inlineTheme);
      pathEl1.D = path1;
      pathEl1.Fill = color.None;
      pathEl1.Stroke = connection.stroke;
      pathEl1.ClassName = `connection${animatedClass}`;
      pathEl1.Style = connection.cssStyle();
      pathEl1.Style += 'animation-direction: reverse;';
      pathEl1.Attributes = `${markerStart}${mask}`;
      writer.write(pathEl1.render());

      const pathEl2 = themes.newThemableElement('path', inlineTheme);
      pathEl2.D = path2;
      pathEl2.Fill = color.None;
      pathEl2.Stroke = connection.stroke;
      pathEl2.ClassName = `connection${animatedClass}`;
      pathEl2.Style = connection.cssStyle();
      pathEl2.Attributes = `${markerEnd}${mask}`;
      writer.write(pathEl2.render());
    } else {
      const pathEl = themes.newThemableElement('path', inlineTheme);
      pathEl.D = path;
      pathEl.Fill = color.None;
      pathEl.Stroke = connection.stroke;
      pathEl.ClassName = `connection${animatedClass}`;
      pathEl.Style = connection.cssStyle();
      pathEl.Attributes = `${markerStart}${markerEnd}${mask}`;
      writer.write(pathEl.render());
    }
  }

  if (connection.label !== '') {
    const richLabelLink = connection.link !== '' && connection.language !== '';
    if (richLabelLink) {
      const l = svg.escapeText(connection.link);
      writer.write(`<a href="${l}" xlink:href="${l}">`);
    }
    if (connection.language === 'latex') {
      throw new Deferred('latex');
    } else if (connection.language === 'markdown') {
      const layout = markdown.layout(connection.label, connection.fontFamily, connection.fontSize);
      writer.write(markdown.render(layout, labelTL.x, labelTL.y, connection.labelWidth, connection.labelHeight,
        connection.getFontColor(), connection.fill, connection.link !== '', connection.underline));
    } else if (connection.language !== '') {
      const hl = highlightCode(connection.language, connection.label);
      for (const isLight of [true, false]) {
        const h = isLight ? hl.light : hl.dark;
        const cls = isLight ? 'light-code' : 'dark-code';
        let fontSize = '';
        if (connection.fontSize !== d2fonts.FONT_SIZE_M) fontSize = ` style="font-size:${connection.fontSize}"`;
        writer.write(`<g transform="translate(${formatFloat(labelTL.x)} ${formatFloat(labelTL.y)})" class="${cls}"${fontSize}>`);

        renderCodeLines(writer, h.lines, h.svgStyles, textmeasure.CODE_LINE_HEIGHT);
        writer.write('</g>');
      }
    } else {
      let fontClass = 'text';
      if (connection.fontFamily === 'mono') fontClass = 'text-mono';
      if (connection.bold) fontClass += '-bold';
      else if (connection.italic) fontClass += '-italic';
      if (connection.underline) fontClass += ' text-underline';
      if (connection.fill !== color.Empty) {
        const rectEl = themes.newThemableElement('rect', inlineTheme);
        rectEl.Rx = 10;
        rectEl.X = labelTL.x - 4;
        rectEl.Y = labelTL.y - 3;
        rectEl.Width = connection.labelWidth + 8;
        rectEl.Height = connection.labelHeight + 6;
        rectEl.Fill = connection.fill;
        writer.write(rectEl.render());
      }

      const textEl = themes.newThemableElement('text', inlineTheme);
      textEl.X = labelTL.x + connection.labelWidth / 2;
      textEl.Y = labelTL.y + connection.fontSize;
      textEl.ClassName = fontClass;
      textEl.Style = `text-anchor:middle;font-size:${connection.fontSize}px`;
      textEl.Content = renderText(connection.label, textEl.X, connection.labelHeight);

      if (connection.link !== '') {
        textEl.ClassName += ' text-underline text-link';
        const l = svg.escapeText(connection.link);
        writer.write(`<a href="${l}" xlink:href="${l}">`);
      } else {
        textEl.Fill = connection.getFontColor();
      }

      writer.write(textEl.render());

      if (connection.link !== '') writer.write('</a>');
    }
    if (richLabelLink) writer.write('</a>');
  }

  if (connection.srcLabel != null && connection.srcLabel.label !== '') {
    writer.write(renderArrowheadLabel(connection, connection.srcLabel.label, false, inlineTheme));
  }
  if (connection.dstLabel != null && connection.dstLabel.label !== '') {
    writer.write(renderArrowheadLabel(connection, connection.dstLabel.label, true, inlineTheme));
  }
  writer.write('</g>');
  return labelMask;
}

function renderArrowheadLabel(connection, text, isDst, inlineTheme) {
  let width, height;
  if (isDst) {
    width = connection.dstLabel.labelWidth;
    height = connection.dstLabel.labelHeight;
  } else {
    width = connection.srcLabel.labelWidth;
    height = connection.srcLabel.labelHeight;
  }

  const labelTL = connection.getArrowheadLabelPosition(isDst);

  // svg text is positioned with the center of its baseline
  const baselineCenter = { x: labelTL.x + width / 2., y: labelTL.y + connection.fontSize };

  const textEl = themes.newThemableElement('text', inlineTheme);
  textEl.X = baselineCenter.x;
  textEl.Y = baselineCenter.y;
  textEl.Fill = d2target.FG_COLOR;
  if (isDst) {
    if (connection.dstLabel.color !== '') textEl.Fill = connection.dstLabel.color;
  } else if (connection.srcLabel.color !== '') textEl.Fill = connection.srcLabel.color;
  textEl.ClassName = 'text-italic';
  textEl.Style = `text-anchor:middle;font-size:${connection.fontSize}px`;
  textEl.Content = renderText(text, textEl.X, height);
  return textEl.render();
}

function renderOval(tl, width, height, fill, fillPattern, stroke, style, inlineTheme) {
  const el = themes.newThemableElement('ellipse', inlineTheme);
  el.Rx = width / 2;
  el.Ry = height / 2;
  el.Cx = tl.x + el.Rx;
  el.Cy = tl.y + el.Ry;
  el.Fill = fill;
  el.Stroke = stroke;
  el.FillPattern = fillPattern;
  el.ClassName = 'shape';
  el.Style = style;
  return el.render();
}

function renderDoubleOval(tl, width, height, fill, fillStroke, stroke, style, inlineTheme) {
  const innerTL = tl.addVector(geo.newVector(d2target.INNER_BORDER_OFFSET, d2target.INNER_BORDER_OFFSET));
  return renderOval(tl, width, height, fill, fillStroke, stroke, style, inlineTheme) + renderOval(innerTL, width - 10, height - 10, fill, '', stroke, style, inlineTheme);
}

function defineGradients(writer, cssGradient) {
  const gradient = color.parseGradient(cssGradient);
  writer.write(`<defs>${color.gradientToSVG(gradient)}</defs>`);
}

function defineShadowFilter(writer) {
  writer.write(`<defs>
	<filter id="shadow-filter" width="200%" height="200%" x="-50%" y="-50%">
		<feGaussianBlur stdDeviation="1.7 " in="SourceGraphic"></feGaussianBlur>
		<feFlood flood-color="#3d4574" flood-opacity="0.4" result="ShadowFeFlood" in="SourceGraphic"></feFlood>
		<feComposite in="ShadowFeFlood" in2="SourceAlpha" operator="in" result="ShadowFeComposite"></feComposite>
		<feOffset dx="3" dy="5" result="ShadowFeOffset" in="ShadowFeComposite"></feOffset>
		<feBlend in="SourceGraphic" in2="ShadowFeOffset" mode="normal" result="ShadowFeBlend"></feBlend>
	</filter>
</defs>`);
}

function darkenOr(fill) {
  try { return color.darken(fill); } catch (e) { return fill; }
}

function render3DRect(diagramHash, targetShape, inlineTheme) {
  const moveTo = (p) => `M${p.x + targetShape.pos.x},${p.y + targetShape.pos.y}`;
  const lineTo = (p) => `L${p.x + targetShape.pos.x},${p.y + targetShape.pos.y}`;
  const P = (x, y) => new d2target.Point(x, y);
  const T = d2target.THREE_DEE_OFFSET;
  const W = targetShape.width;
  const H = targetShape.height;

  // draw border all in one path to prevent overlapping sections
  const borderSegments = [];
  borderSegments.push(moveTo(P(0, 0)));
  for (const v of [P(T, -T), P(W + T, -T), P(W + T, H - T), P(W, H), P(0, H), P(0, 0), P(W, 0), P(W, H)]) borderSegments.push(lineTo(v));
  // move to top right to draw last segment without overlapping
  borderSegments.push(moveTo(P(W, 0)));
  borderSegments.push(lineTo(P(W + T, -T)));
  const border = themes.newThemableElement('path', inlineTheme);
  border.D = borderSegments.join(' ');
  border.Fill = color.None;
  const [, borderStroke] = themes.shapeTheme(targetShape);
  border.Stroke = borderStroke;
  const borderStyle = targetShape.cssStyle();
  border.Style = borderStyle;
  const renderedBorder = border.render();

  // create mask from border stroke, to cut away from the shape fills
  const maskID = `border-mask-${diagramHash}-${svg.escapeText(targetShape.id)}`;
  const borderMask = [
    `<defs><mask id="${maskID}" maskUnits="userSpaceOnUse" x="${targetShape.pos.x}" y="${targetShape.pos.y - T}" width="${W + T}" height="${H + T}">`,
    `<rect x="${targetShape.pos.x}" y="${targetShape.pos.y - T}" width="${W + T}" height="${H + T}" fill="white"></rect>`,
    `<path d="${borderSegments.join('')}" style="${borderStyle};stroke:#000;fill:none;opacity:1;"/></mask></defs>`,
  ].join('\n');

  // render the main rectangle without stroke and the border mask
  const mainShape = themes.newThemableElement('rect', inlineTheme);
  mainShape.X = targetShape.pos.x;
  mainShape.Y = targetShape.pos.y;
  mainShape.Width = W;
  mainShape.Height = H;
  mainShape.setMaskUrl(maskID);
  const [mainShapeFill] = themes.shapeTheme(targetShape);
  mainShape.Fill = mainShapeFill;
  mainShape.FillPattern = targetShape.fillPattern;
  mainShape.Stroke = color.None;
  mainShape.Style = targetShape.cssStyle();
  const mainShapeRendered = mainShape.render();

  // render the side shapes in the darkened color without stroke and the border mask
  const sidePoints = [];
  for (const v of [P(0, 0), P(T, -T), P(W + T, -T), P(W + T, H - T), P(W, H), P(W, 0)]) sidePoints.push(`${v.x + targetShape.pos.x},${v.y + targetShape.pos.y}`);
  const darkerColor = darkenOr(targetShape.fill);
  const sideShape = themes.newThemableElement('polygon', inlineTheme);
  sideShape.Fill = darkerColor;
  sideShape.Points = sidePoints.join(' ');
  sideShape.setMaskUrl(maskID);
  sideShape.Style = targetShape.cssStyle();
  const renderedSides = sideShape.render();

  return borderMask + mainShapeRendered + renderedSides + renderedBorder;
}

function render3DHexagon(diagramHash, targetShape, inlineTheme) {
  const moveTo = (p) => `M${p.x + targetShape.pos.x},${p.y + targetShape.pos.y}`;
  const lineTo = (p) => `L${p.x + targetShape.pos.x},${p.y + targetShape.pos.y}`;
  const scale = (n, f) => goInt(n * f);
  const halfYFactor = 43.6 / 87.3;
  const P = (x, y) => new d2target.Point(x, y);
  const T = d2target.THREE_DEE_OFFSET;
  const W = targetShape.width;
  const H = targetShape.height;

  // draw border all in one path to prevent overlapping sections
  const borderSegments = [];
  // start from the top-left
  borderSegments.push(moveTo(P(scale(W, 0.25), 0)));
  const Y_OFFSET = Math.trunc(T / 2);
  // The following iterates through the sidepoints in clockwise order from top-left, then the main points in clockwise order from bottom-right
  for (const v of [
    P(scale(W, 0.25) + T, -Y_OFFSET),
    P(scale(W, 0.75) + T, -Y_OFFSET),
    P(W + T, scale(H, halfYFactor) - Y_OFFSET),
    P(scale(W, 0.75) + T, H - Y_OFFSET),
    P(scale(W, 0.75), H),
    P(scale(W, 0.25), H),
    P(0, scale(H, halfYFactor)),
    P(scale(W, 0.25), 0),
    P(scale(W, 0.75), 0),
    P(W, scale(H, halfYFactor)),
    P(scale(W, 0.75), H),
  ]) borderSegments.push(lineTo(v));
  for (const v of [P(scale(W, 0.75), 0), P(W, scale(H, halfYFactor)), P(scale(W, 0.75), H)]) {
    borderSegments.push(moveTo(v));
    borderSegments.push(lineTo(P(v.x + T, v.y - Y_OFFSET)));
  }
  const border = themes.newThemableElement('path', inlineTheme);
  border.D = borderSegments.join(' ');
  border.Fill = color.None;
  const [, borderStroke] = themes.shapeTheme(targetShape);
  border.Stroke = borderStroke;
  const borderStyle = targetShape.cssStyle();
  border.Style = borderStyle;
  const renderedBorder = border.render();

  const mainPoints = [];
  for (const v of [P(scale(W, 0.25), 0), P(scale(W, 0.75), 0), P(W, scale(H, halfYFactor)), P(scale(W, 0.75), H), P(scale(W, 0.25), H), P(0, scale(H, halfYFactor))]) {
    mainPoints.push(`${v.x + targetShape.pos.x},${v.y + targetShape.pos.y}`);
  }

  const mainPointsPoly = mainPoints.join(' ');
  // create mask from border stroke, to cut away from the shape fills
  const maskID = `border-mask-${diagramHash}-${svg.escapeText(targetShape.id)}`;
  const borderMask = [
    `<defs><mask id="${maskID}" maskUnits="userSpaceOnUse" x="${targetShape.pos.x}" y="${targetShape.pos.y - T}" width="${W + T}" height="${H + T}">`,
    `<rect x="${targetShape.pos.x}" y="${targetShape.pos.y - T}" width="${W + T}" height="${H + T}" fill="white"></rect>`,
    `<path d="${borderSegments.join('')}" style="${borderStyle};stroke:#000;fill:none;opacity:1;"/></mask></defs>`,
  ].join('\n');
  // render the main hexagon without stroke and the border mask
  const mainShape = themes.newThemableElement('polygon', inlineTheme);
  mainShape.X = targetShape.pos.x;
  mainShape.Y = targetShape.pos.y;
  mainShape.Points = mainPointsPoly;
  mainShape.setMaskUrl(maskID);
  const [mainShapeFill] = themes.shapeTheme(targetShape);
  mainShape.FillPattern = targetShape.fillPattern;
  mainShape.Fill = mainShapeFill;
  mainShape.Stroke = color.None;
  mainShape.Style = targetShape.cssStyle();
  const mainShapeRendered = mainShape.render();

  // render the side shapes in the darkened color without stroke and the border mask
  const sidePoints = [];
  for (const v of [
    P(scale(W, 0.25) + T, -Y_OFFSET),
    P(scale(W, 0.75) + T, -Y_OFFSET),
    P(W + T, scale(H, halfYFactor) - Y_OFFSET),
    P(scale(W, 0.75) + T, H - Y_OFFSET),
    P(scale(W, 0.75), H),
    P(W, scale(H, halfYFactor)),
    P(scale(W, 0.75), 0),
    P(scale(W, 0.25), 0),
  ]) sidePoints.push(`${v.x + targetShape.pos.x},${v.y + targetShape.pos.y}`);
  // TODO make darker color part of the theme? or just keep this bypass
  const darkerColor = darkenOr(targetShape.fill);
  const sideShape = themes.newThemableElement('polygon', inlineTheme);
  sideShape.Fill = darkerColor;
  sideShape.Points = sidePoints.join(' ');
  sideShape.setMaskUrl(maskID);
  sideShape.Style = targetShape.cssStyle();
  const renderedSides = sideShape.render();

  return borderMask + mainShapeRendered + renderedSides + renderedBorder;
}

function drawShape(writer, appendixWriter, diagramHash, targetShape, sketch, inlineTheme, markdown) {
  let labelMask = '';
  let closingTag = '</g>';
  if (targetShape.link !== '') {
    const l = svg.escapeText(targetShape.link);
    writer.write(`<a href="${l}" xlink:href="${l}">`);
    closingTag += '</a>';
  }
  // Opacity is a unique style, it applies to everything for a shape
  let opacityStyle = '';
  if (targetShape.opacity !== 1.0) opacityStyle = ` style='opacity:${formatFloat(targetShape.opacity)}'`;

  // this clipPath must be defined outside `g` element
  if (targetShape.borderRadius !== 0 && (targetShape.type === d2target.ShapeClass || targetShape.type === d2target.ShapeSQLTable)) {
    writer.write(clipPathForBorderRadius(diagramHash, targetShape));
  }
  let iconClipPathID = '';
  if (targetShape.iconBorderRadius !== 0 && targetShape.type === d2target.ShapeImage) {
    // Set the icon's border-radius to half of it's smaller dimension in case it exceeds that
    // https://www.w3.org/Style/CSS/Tracker/issues/29?changelog
    targetShape = copyStruct(targetShape);
    targetShape.iconBorderRadius = Math.min(targetShape.iconBorderRadius, Math.trunc(Math.min(targetShape.width, targetShape.height) / 2));
    iconClipPathID = `${diagramHash}-${svg.svgID(targetShape.id)}-icon`;
    writer.write(applyIconBorderRadius(iconClipPathID, targetShape));
  }
  const classes = [b64url(svg.escapeText(targetShape.id))];
  if (targetShape.animated) classes.push('animated-shape');
  classes.push(...(targetShape.classes ?? []));
  const classStr = ` class="${classes.join(' ')}"`;
  writer.write(`<g${classStr}${opacityStyle}>`);
  const tl = geo.newPoint(targetShape.pos.x, targetShape.pos.y);
  const width = targetShape.width;
  const height = targetShape.height;
  const [fill, stroke] = themes.shapeTheme(targetShape);
  const style = targetShape.cssStyle();
  const shapeType = Object.prototype.hasOwnProperty.call(d2target.DSL_SHAPE_TO_SHAPE_TYPE, targetShape.type) ? d2target.DSL_SHAPE_TO_SHAPE_TYPE[targetShape.type] : '';

  const s = shape.newShape(shapeType, geo.newBox(tl, width, height));
  if (shapeType === shape.CLOUD_TYPE && targetShape.contentAspectRatio != null) s.setInnerBoxAspectRatio(targetShape.contentAspectRatio);

  let shadowAttr = '';
  if (targetShape.shadow) {
    switch (targetShape.type) {
      case d2target.ShapeText: case d2target.ShapeCode: case d2target.ShapeClass: case d2target.ShapeSQLTable:
        break;
      default:
        shadowAttr = 'filter="url(#shadow-filter)" ';
    }
  }

  let blendModeClass = '';
  if (targetShape.blend) blendModeClass = ' blend';

  writer.write(`<g class="shape${blendModeClass}" ${shadowAttr}>`);

  let multipleTL = null;
  if (targetShape.multiple) multipleTL = tl.addVector(multipleOffset);

  switch (targetShape.type) {
    case d2target.ShapeClass:
      if (sketch) throw new Deferred('sketch');
      drawClass(writer, diagramHash, targetShape, inlineTheme);
      addAppendixItems(appendixWriter, diagramHash, targetShape, s, markdown);
      writer.write('</g>');
      writer.write(closingTag);
      return labelMask;
    case d2target.ShapeSQLTable:
      if (sketch) throw new Deferred('sketch');
      drawTable(writer, diagramHash, targetShape, inlineTheme);
      addAppendixItems(appendixWriter, diagramHash, targetShape, s, markdown);
      writer.write('</g>');
      writer.write(closingTag);
      return labelMask;
    case d2target.ShapeOval:
      if (targetShape['double-border']) {
        if (targetShape.multiple) writer.write(renderDoubleOval(multipleTL, width, height, fill, '', stroke, style, inlineTheme));
        if (sketch) throw new Deferred('sketch');
        writer.write(renderDoubleOval(tl, width, height, fill, targetShape.fillPattern, stroke, style, inlineTheme));
      } else {
        if (targetShape.multiple) writer.write(renderOval(multipleTL, width, height, fill, '', stroke, style, inlineTheme));
        if (sketch) throw new Deferred('sketch');
        writer.write(renderOval(tl, width, height, fill, targetShape.fillPattern, stroke, style, inlineTheme));
      }
      break;

    case d2target.ShapeImage: {
      const el = themes.newThemableElement('image', inlineTheme);
      el.X = targetShape.pos.x;
      el.Y = targetShape.pos.y;
      el.Width = targetShape.width;
      el.Height = targetShape.height;
      el.Href = htmlEscape(iconString(targetShape.icon));
      el.Fill = fill;
      el.Stroke = stroke;
      el.Style = style;
      if (targetShape.iconBorderRadius !== 0) el.ClipPath = iconClipPathID;
      writer.write(el.render());
      break;
    }

    // TODO should standardize "" to rectangle
    case d2target.ShapeRectangle: case d2target.ShapeSequenceDiagram: case d2target.ShapeHierarchy: case '': {
      let borderRadius = Number.MAX_VALUE;
      if (targetShape.borderRadius !== 0) borderRadius = targetShape.borderRadius;
      const O = d2target.INNER_BORDER_OFFSET;
      if (targetShape['3d']) {
        writer.write(render3DRect(diagramHash, targetShape, inlineTheme));
      } else if (!targetShape['double-border']) {
        if (targetShape.multiple) {
          const el = themes.newThemableElement('rect', inlineTheme);
          el.X = targetShape.pos.x + 10;
          el.Y = targetShape.pos.y - 10;
          el.Width = targetShape.width;
          el.Height = targetShape.height;
          el.Fill = fill;
          el.Stroke = stroke;
          el.Style = style;
          el.Rx = borderRadius;
          writer.write(el.render());
        }
        if (sketch) throw new Deferred('sketch');
        const el = themes.newThemableElement('rect', inlineTheme);
        el.X = targetShape.pos.x;
        el.Y = targetShape.pos.y;
        el.Width = targetShape.width;
        el.Height = targetShape.height;
        el.Fill = fill;
        el.FillPattern = targetShape.fillPattern;
        el.Stroke = stroke;
        el.Style = style;
        el.Rx = borderRadius;

        if (targetShape.label !== '' && label.isBorder(label.fromString(targetShape.labelPosition))) el.Mask = `url(#${diagramHash})`;

        writer.write(el.render());
      } else {
        if (targetShape.multiple) {
          let el = themes.newThemableElement('rect', inlineTheme);
          el.X = targetShape.pos.x + 10;
          el.Y = targetShape.pos.y - 10;
          el.Width = targetShape.width;
          el.Height = targetShape.height;
          el.Fill = fill;
          el.FillPattern = targetShape.fillPattern;
          el.Stroke = stroke;
          el.Style = style;
          el.Rx = borderRadius;
          writer.write(el.render());

          el = themes.newThemableElement('rect', inlineTheme);
          el.X = targetShape.pos.x + 10 + O;
          el.Y = targetShape.pos.y - 10 + O;
          el.Width = targetShape.width - 2 * O;
          el.Height = targetShape.height - 2 * O;
          el.Fill = fill;
          el.Stroke = stroke;
          el.Style = style;
          el.Rx = borderRadius;
          writer.write(el.render());
        }
        if (sketch) throw new Deferred('sketch');
        let el = themes.newThemableElement('rect', inlineTheme);
        el.X = targetShape.pos.x;
        el.Y = targetShape.pos.y;
        el.Width = targetShape.width;
        el.Height = targetShape.height;
        el.Fill = fill;
        el.FillPattern = targetShape.fillPattern;
        el.Stroke = stroke;
        el.Style = style;
        el.Rx = borderRadius;
        writer.write(el.render());

        el = themes.newThemableElement('rect', inlineTheme);
        el.X = targetShape.pos.x + O;
        el.Y = targetShape.pos.y + O;
        el.Width = targetShape.width - 2 * O;
        el.Height = targetShape.height - 2 * O;
        el.Fill = 'transparent';
        el.Stroke = stroke;
        el.Style = style;
        el.Rx = borderRadius;
        writer.write(el.render());
      }
      break;
    }
    case d2target.ShapeHexagon:
      if (targetShape['3d']) {
        writer.write(render3DHexagon(diagramHash, targetShape, inlineTheme));
      } else {
        if (targetShape.multiple) {
          const multiplePathData = shape.newShape(shapeType, geo.newBox(multipleTL, width, height)).getSVGPathData();
          const el = themes.newThemableElement('path', inlineTheme);
          el.Fill = fill;
          el.Stroke = stroke;
          el.Style = style;
          for (const pd of multiplePathData) {
            el.D = pd;
            writer.write(el.render());
          }
        }

        if (sketch) throw new Deferred('sketch');
        const el = themes.newThemableElement('path', inlineTheme);
        el.Fill = fill;
        el.FillPattern = targetShape.fillPattern;
        el.Stroke = stroke;
        el.Style = style;
        for (const pd of s.getSVGPathData()) {
          el.D = pd;
          writer.write(el.render());
        }
      }
      break;
    case d2target.ShapeText: case d2target.ShapeCode:
      break;
    default: {
      if (targetShape.multiple) {
        const multiplePathData = shape.newShape(shapeType, geo.newBox(multipleTL, width, height)).getSVGPathData();
        const el = themes.newThemableElement('path', inlineTheme);
        el.Fill = fill;
        el.Stroke = stroke;
        el.Style = style;
        for (const pd of multiplePathData) {
          el.D = pd;
          writer.write(el.render());
        }
      }

      if (sketch) throw new Deferred('sketch');
      const el = themes.newThemableElement('path', inlineTheme);
      el.Fill = fill;
      el.FillPattern = targetShape.fillPattern;
      el.Stroke = stroke;
      el.Style = style;

      if (targetShape.label !== '' && label.isBorder(label.fromString(targetShape.labelPosition))) el.Mask = `url(#${diagramHash})`;

      for (const pd of s.getSVGPathData()) {
        el.D = pd;
        writer.write(el.render());
      }
    }
  }

  // Closes the class=shape
  writer.write('</g>');

  if (targetShape.icon != null && targetShape.type !== d2target.ShapeImage && targetShape.opacity !== 0) {
    const iconPosition = label.fromString(targetShape.iconPosition);
    let box;
    if (label.isOutside(iconPosition)) box = s.getBox();
    else box = s.getInnerBox();
    const iconSize = d2target.getIconSize(box, targetShape.iconPosition);

    const itl = label.getPointOnBox(iconPosition, box, label.PADDING, iconSize, iconSize);

    let shapeIconClipPath = '';
    if (targetShape.iconBorderRadius !== 0) shapeIconClipPath = ` clip-path="inset(0 round ${targetShape.iconBorderRadius}px)"`;
    writer.write(`<image href="${htmlEscape(iconString(targetShape.icon))}" x="${formatFloat(itl.x)}" y="${formatFloat(itl.y)}" width="${iconSize}" height="${iconSize}"${shapeIconClipPath} />`);
  }

  if (targetShape.label !== '' && targetShape.opacity !== 0) {
    let labelPosition = label.fromString(targetShape.labelPosition);
    // The foreignObject Markdown renderer historically defaulted an unset
    // label position to the middle of the shape. Keep that behavior when the
    // native label viewport is smaller than an explicitly sized shape.
    if (targetShape.language === 'markdown' && labelPosition === label.Unset) labelPosition = label.InsideMiddleCenter;
    let box;
    if (label.isOutside(labelPosition) || label.isBorder(labelPosition)) {
      box = s.getBox().copy();
      // if it is 3d/multiple, place label using box around those
      if (targetShape['3d']) {
        let offsetY = d2target.THREE_DEE_OFFSET;
        if (targetShape.type === d2target.ShapeHexagon) offsetY = Math.trunc(offsetY / 2);
        box.TopLeft.y -= offsetY;
        box.Height += offsetY;
        box.Width += d2target.THREE_DEE_OFFSET;
      } else if (targetShape.multiple) {
        box.TopLeft.y -= d2target.MULTIPLE_OFFSET;
        box.Height += d2target.MULTIPLE_OFFSET;
        box.Width += d2target.MULTIPLE_OFFSET;
      }
    } else {
      box = s.getInnerBox();
    }
    const labelTL = label.getPointOnBox(labelPosition, box, label.PADDING, targetShape.labelWidth, targetShape.labelHeight);

    if (label.isBorder(labelPosition)) {
      if (sketch) labelMask = makeBorderLabelMask(labelPosition, labelTL, targetShape.labelWidth, targetShape.labelHeight, box, targetShape.strokeWidth, 1.0, tl);
      else labelMask = makeBorderLabelMask(labelPosition, labelTL, targetShape.labelWidth, targetShape.labelHeight, box, targetShape.strokeWidth, 1.0, null);
    }

    let fontClass = 'text';
    if (targetShape.fontFamily === 'mono') fontClass = 'text-mono';
    if (targetShape.bold) fontClass += '-bold';
    else if (targetShape.italic) fontClass += '-italic';
    if (targetShape.underline) fontClass += ' text-underline';

    if (targetShape.language === 'latex') {
      throw new Deferred('latex');
    } else if (targetShape.language === 'markdown') {
      const layout = markdown.layout(targetShape.label, targetShape.fontFamily, targetShape.fontSize);
      writer.write(markdown.render(layout, labelTL.x, labelTL.y, targetShape.labelWidth, targetShape.labelHeight,
        targetShape.getFontColor(), targetShape.fill, targetShape.link !== '', targetShape.underline));
    } else if (targetShape.language !== '') {
      const hl = highlightCode(targetShape.language, targetShape.label);
      for (const isLight of [true, false]) {
        const h = isLight ? hl.light : hl.dark;
        const cls = isLight ? 'light-code' : 'dark-code';
        let fontSize = '';
        if (targetShape.fontSize !== d2fonts.FONT_SIZE_M) fontSize = ` style="font-size:${targetShape.fontSize}"`;
        writer.write(`<g transform="translate(${formatFloat(box.TopLeft.x)} ${formatFloat(box.TopLeft.y)})" class="${cls}"${fontSize}>`);
        const rectEl = themes.newThemableElement('rect', inlineTheme);
        rectEl.Width = targetShape.width;
        rectEl.Height = targetShape.height;
        rectEl.Stroke = targetShape.stroke;
        rectEl.ClassName = 'shape';
        rectEl.Style = `fill:${h.background};stroke-width:${targetShape.strokeWidth};`;
        writer.write(rectEl.render());
        // Padding = 0.5em
        const padding = targetShape.fontSize / 2.;
        writer.write(`<g transform="translate(${formatFloat(padding)} ${formatFloat(padding)})">`);

        renderCodeLines(writer, h.lines, h.svgStyles, textmeasure.CODE_LINE_HEIGHT);
        writer.write('</g></g>');
      }
    } else {
      if (targetShape.labelFill !== '') {
        const rectEl = themes.newThemableElement('rect', inlineTheme);
        rectEl.X = labelTL.x;
        rectEl.Y = labelTL.y;
        rectEl.Width = targetShape.labelWidth;
        rectEl.Height = targetShape.labelHeight;
        rectEl.Fill = targetShape.labelFill;
        writer.write(rectEl.render());
      }
      const textEl = themes.newThemableElement('text', inlineTheme);
      textEl.X = labelTL.x + targetShape.labelWidth / 2;
      // text is vertically positioned at its baseline which is at labelTL+FontSize
      textEl.Y = labelTL.y + targetShape.fontSize;
      textEl.Fill = targetShape.getFontColor();
      textEl.ClassName = fontClass;
      textEl.Style = `text-anchor:middle;font-size:${targetShape.fontSize}px`;
      textEl.Content = renderText(targetShape.label, textEl.X, targetShape.labelHeight);
      writer.write(textEl.render());
    }
  }
  if (targetShape.tooltip !== '' && targetShape.tooltipPosition === '') {
    writer.write(`<title>${svg.escapeText(targetShape.tooltip)}</title>`);
  }
  addAppendixItems(appendixWriter, diagramHash, targetShape, s, markdown);

  writer.write(closingTag);
  return labelMask;
}

/** this func helps define a clipPath for shape class and sql_table to draw border-radius */
function clipPathForBorderRadius(diagramHash, shp) {
  const F = formatFloat;
  const box = geo.newBox(geo.newPoint(shp.pos.x, shp.pos.y), shp.width, shp.height);
  const topX = box.TopLeft.x + box.Width;
  const topY = box.TopLeft.y;
  const R = shp.borderRadius;

  let out = `<clipPath id="${diagramHash}-${svg.svgID(shp.id)}">`;
  out += `<path d="M ${F(box.TopLeft.x)} ${F(box.TopLeft.y + R)} L ${F(box.TopLeft.x)} ${F(box.TopLeft.y + R)} S ${F(box.TopLeft.x)} ${F(box.TopLeft.y)} ${F(box.TopLeft.x + R)} ${F(box.TopLeft.y)} `;
  out += `L ${F(box.TopLeft.x + box.Width - R)} ${F(box.TopLeft.y)} L ${F(topX - R)} ${F(topY)} `;

  out += `S ${F(topX)} ${F(topY)} ${F(topX)} ${F(topY + R)} `;
  out += `L ${F(topX)} ${F(topY + box.Height - R)} `;

  if ((shp.columns ?? []).length !== 0) {
    out += `L ${F(topX)} ${F(topY + box.Height)} L ${F(box.TopLeft.x)} ${F(box.TopLeft.y + box.Height)}`;
  } else {
    out += `S ${F(topX)}  ${F(topY + box.Height)} ${F(topX - R)} ${F(topY + box.Height)} `;
    out += `L ${F(box.TopLeft.x + R)} ${F(box.TopLeft.y + box.Height)} `;
    out += `S ${F(box.TopLeft.x)} ${F(box.TopLeft.y + box.Height)} ${F(box.TopLeft.x)} ${F(box.TopLeft.y + box.Height - R)}`;
    out += `L ${F(box.TopLeft.x)} ${F(box.TopLeft.y + R)}`;
  }
  out += `Z ${F(box.TopLeft.x)} ${F(box.TopLeft.y)}" `;
  return `${out}fill="none" /> </clipPath>`;
}

function applyIconBorderRadius(clipPathID, shp) {
  const F = formatFloat;
  const box = geo.newBox(geo.newPoint(shp.pos.x, shp.pos.y), shp.width, shp.height);
  const topX = box.TopLeft.x + box.Width;
  const topY = box.TopLeft.y;
  const R = shp.iconBorderRadius;

  let out = `<clipPath id="${clipPathID}">`;
  out += `<path d="M ${F(box.TopLeft.x)} ${F(box.TopLeft.y + R)} L ${F(box.TopLeft.x)} ${F(box.TopLeft.y + R)} S ${F(box.TopLeft.x)} ${F(box.TopLeft.y)} ${F(box.TopLeft.x + R)} ${F(box.TopLeft.y)} `;
  out += `L ${F(box.TopLeft.x + box.Width - R)} ${F(box.TopLeft.y)} L ${F(topX - R)} ${F(topY)} `;

  out += `S ${F(topX)} ${F(topY)} ${F(topX)} ${F(topY + R)} `;
  out += `L ${F(topX)} ${F(topY + box.Height - R)} `;
  out += `S ${F(topX)}  ${F(topY + box.Height)} ${F(topX - R)} ${F(topY + box.Height)} `;
  out += `L ${F(box.TopLeft.x + R)} ${F(box.TopLeft.y + box.Height)} `;
  out += `S ${F(box.TopLeft.x)} ${F(box.TopLeft.y + box.Height)} ${F(box.TopLeft.x)} ${F(box.TopLeft.y + box.Height - R)}`;
  out += `L ${F(box.TopLeft.x)} ${F(box.TopLeft.y + R)}`;
  out += `Z ${F(box.TopLeft.x)} ${F(box.TopLeft.y)}" `;
  return `${out}fill="none" /> </clipPath>`;
}

function addAppendixItems(writer, diagramHash, targetShape, s, markdown) {
  let p1 = null;
  let p2 = null;
  if (targetShape.tooltip !== '' || targetShape.link !== '') {
    const bothIcons = targetShape.tooltip !== '' && targetShape.link !== '';
    let corner = geo.newPoint(targetShape.pos.x + targetShape.width, targetShape.pos.y);
    const center = geo.newPoint(targetShape.pos.x + targetShape.width / 2., targetShape.pos.y + targetShape.height / 2.);
    const offset = geo.newVector(-2 * appendixIconRadius, 0);
    let leftOnShape = false;
    switch (s.getType()) {
      case shape.STEP_TYPE: case shape.HEXAGON_TYPE: case shape.QUEUE_TYPE: case shape.PAGE_TYPE:
        // trace straight left for these
        center.y = targetShape.pos.y;
        break;
      case shape.PACKAGE_TYPE:
        // trace straight down
        center.x = targetShape.pos.x + targetShape.width;
        break;
      case shape.CIRCLE_TYPE: case shape.OVAL_TYPE: case shape.DIAMOND_TYPE:
      case shape.PERSON_TYPE: case shape.CLOUD_TYPE: case shape.CYLINDER_TYPE:
        if (bothIcons) {
          leftOnShape = true;
          corner = corner.addVector(offset);
        }
        break;
    }
    const v1 = center.vectorTo(corner);
    p1 = shape.traceToShapeBorder(s, corner, corner.addVector(v1));
    if (bothIcons) {
      if (leftOnShape) {
        // these shapes should have p1 on shape border
        p2 = p1.addVector(offset.reverse());
        [p1, p2] = [p2, p1];
      } else {
        p2 = p1.addVector(offset);
      }
    }
  }

  if (targetShape.tooltip !== '') {
    if (targetShape.tooltipPosition !== '') {
      writer.write(renderPositionedTooltip(targetShape, targetShape.tooltipPosition, markdown));
    } else {
      const x = goInt(Math.ceil(p1.x));
      const y = goInt(Math.ceil(p1.y));

      writer.write(`<g transform="translate(${x - appendixIconRadius} ${y - appendixIconRadius})" class="appendix-icon"><title>${svg.escapeText(targetShape.tooltip)}</title>${sprintfIcon(TooltipIcon, diagramHash, svg.svgID(targetShape.id))}</g>`);
    }
  }
  if (targetShape.link !== '') {
    if (p2 == null) p2 = p1;
    const x = goInt(Math.ceil(p2.x));
    const y = goInt(Math.ceil(p2.y));
    writer.write(`<g transform="translate(${x - appendixIconRadius} ${y - appendixIconRadius})" class="appendix-icon">${sprintfIcon(LinkIcon, diagramHash, svg.svgID(targetShape.id))}</g>`);
  }
}

// fmt.Sprintf(icon, a, b) for the two %[1]s / %[2]s verbs of tooltip.svg and link.svg
const sprintfIcon = (tpl, a, b) => tpl.replace(/%\[1\]s/g, a).replace(/%\[2\]s/g, b);

function calculateTooltipPosition(targetShape, tooltipPosition, tooltipWidth, tooltipHeight) {
  const shapeX = targetShape.pos.x;
  const shapeY = targetShape.pos.y;
  const shapeWidth = targetShape.width;
  const shapeHeight = targetShape.height;

  const [x, y] = d2target.calculateTooltipPosition(shapeX, shapeY, shapeWidth, shapeHeight, tooltipWidth, tooltipHeight, tooltipPosition);

  let tailDirection, tailX, tailY;
  switch (tooltipPosition) {
    case 'top-left':
      tailDirection = 'bottom'; tailX = 20; tailY = tooltipHeight; break;
    case 'top-center':
      tailDirection = 'bottom'; tailX = tooltipWidth / 2; tailY = tooltipHeight; break;
    case 'top-right':
      tailDirection = 'bottom'; tailX = tooltipWidth - 20; tailY = tooltipHeight; break;
    case 'center-left':
      tailDirection = 'right'; tailX = tooltipWidth; tailY = tooltipHeight / 2; break;
    case 'center-right':
      tailDirection = 'left'; tailX = 0; tailY = tooltipHeight / 2; break;
    case 'bottom-left':
      tailDirection = 'top'; tailX = 20; tailY = 0; break;
    case 'bottom-center':
      tailDirection = 'top'; tailX = tooltipWidth / 2; tailY = 0; break;
    case 'bottom-right':
      tailDirection = 'top'; tailX = tooltipWidth - 20; tailY = 0; break;
    default:
      tailDirection = 'bottom'; tailX = tooltipWidth / 2; tailY = tooltipHeight;
  }
  return [x, y, tailDirection, tailX, tailY];
}

function renderTooltipTail(tailDirection, tailX, tailY, inlineTheme) {
  const F = formatFloat;
  const tailSize = 8.0;
  let path;

  switch (tailDirection) {
    case 'top':
      path = `M ${F(tailX - tailSize / 2)} ${F(tailY)} L ${F(tailX + tailSize / 2)} ${F(tailY)} L ${F(tailX)} ${F(tailY - tailSize)} Z`;
      break;
    case 'bottom':
      path = `M ${F(tailX - tailSize / 2)} ${F(tailY)} L ${F(tailX + tailSize / 2)} ${F(tailY)} L ${F(tailX)} ${F(tailY + tailSize)} Z`;
      break;
    case 'left':
      path = `M ${F(tailX)} ${F(tailY - tailSize / 2)} L ${F(tailX)} ${F(tailY + tailSize / 2)} L ${F(tailX - tailSize)} ${F(tailY)} Z`;
      break;
    case 'right':
      path = `M ${F(tailX)} ${F(tailY - tailSize / 2)} L ${F(tailX)} ${F(tailY + tailSize / 2)} L ${F(tailX + tailSize)} ${F(tailY)} Z`;
      break;
    default:
      return '';
  }
  const tail = themes.newThemableElement('path', inlineTheme);
  tail.D = path;
  tail.Fill = color.N7;
  tail.Stroke = color.N5;
  tail.Attributes = 'stroke-width="1"';
  return tail.render();
}

function renderPositionedTooltip(targetShape, tooltipPosition, markdown) {
  if (targetShape.tooltip === '' || tooltipPosition === '') return '';

  const layout = markdown.layout(targetShape.tooltip, targetShape.fontFamily, d2fonts.FONT_SIZE_M);
  const tooltipWidth = layout.Width + 20;
  const tooltipHeight = layout.Height + 20;
  const [x, y, tailDirection, tailX, tailY] = calculateTooltipPosition(targetShape, tooltipPosition, tooltipWidth, tooltipHeight);

  const tooltipContent = markdown.render(layout, x + 10, y + 10, layout.Width, layout.Height, color.N1, '', false, false);

  const tooltipBox = themes.newThemableElement('rect', markdown.inlineTheme);
  tooltipBox.X = x;
  tooltipBox.Y = y;
  tooltipBox.Width = tooltipWidth;
  tooltipBox.Height = tooltipHeight;
  tooltipBox.Rx = 4;
  tooltipBox.Ry = 4;
  tooltipBox.Fill = color.N7;
  tooltipBox.Stroke = color.N5;
  tooltipBox.Attributes = 'stroke-width="1"';

  const tail = renderTooltipTail(tailDirection, tailX + x, tailY + y, markdown.inlineTheme);

  return `<g class="positioned-tooltip">${tooltipBox.render()}${tail}${tooltipContent}</g>`;
}

export function renderText(text, x, height) {
  if (!text.includes('\n')) return svg.escapeText(text);
  const rendered = [];
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    let dy = height / lines.length;
    if (i === 0) dy = 0;
    let escaped = svg.escapeText(line);
    if (escaped === '') {
      // if there are multiple newlines in a row we still need text for the tspan to render
      escaped = ' ';
    }
    rendered.push(`<tspan x="${formatFloat(x)}" dy="${formatFloat(dy)}">${escaped}</tspan>`);
  });
  return rendered.join('');
}

// ---- class.go ----

function classHeader(diagramHash, shp, box, text, textWidth, textHeight, fontSize, inlineTheme) {
  const rectEl = themes.newThemableElement('rect', inlineTheme);
  rectEl.X = box.TopLeft.x;
  rectEl.Y = box.TopLeft.y;
  rectEl.Width = box.Width;
  rectEl.Height = box.Height;
  rectEl.Fill = shp.fill;
  rectEl.FillPattern = shp.fillPattern;
  rectEl.ClassName = 'class_header';
  if (shp.borderRadius !== 0) rectEl.ClipPath = `${diagramHash}-${shp.id}`;
  let str = rectEl.render();

  if (text !== '') {
    const tl = label.getPointOnBox(label.InsideMiddleCenter, box, 0, textWidth, textHeight);

    const textEl = themes.newThemableElement('text', inlineTheme);
    textEl.X = tl.x + textWidth / 2;
    textEl.Y = tl.y + fontSize;
    textEl.Fill = shp.getFontColor();
    textEl.ClassName = 'text-mono';
    textEl.Style = `text-anchor:middle;font-size:${goV(4 + fontSize)}px;`;
    textEl.Content = renderText(text, textEl.X, textHeight);
    str += textEl.render();
  }
  return str;
}

function classRow(shp, box, prefix, nameText, typeText, fontSize, underline, inlineTheme) {
  const prefixTL = label.getPointOnBox(label.InsideMiddleLeft, box, d2target.PrefixPadding, box.Width, fontSize);
  const typeTR = label.getPointOnBox(label.InsideMiddleRight, box, d2target.TypePadding, 0, fontSize);

  const textEl = themes.newThemableElement('text', inlineTheme);
  textEl.X = prefixTL.x;
  textEl.Y = prefixTL.y + fontSize * 3 / 4;
  textEl.Fill = shp.primaryAccentColor;
  textEl.ClassName = 'text-mono';
  textEl.Style = `text-anchor:start;font-size:${goV(fontSize)}px`;
  textEl.Content = prefix;
  let out = textEl.render();

  textEl.X = prefixTL.x + d2target.PrefixWidth;
  textEl.Fill = shp.fill;
  textEl.ClassName = 'text-mono';
  if (underline) textEl.ClassName += ' text-underline';
  textEl.Content = svg.escapeText(nameText);
  out += textEl.render();

  textEl.X = typeTR.x;
  textEl.Y = typeTR.y + fontSize * 3 / 4;
  textEl.Fill = shp.secondaryAccentColor;
  textEl.ClassName = 'text-mono';
  textEl.Style = `text-anchor:end;font-size:${goV(fontSize)}px`;
  textEl.Content = svg.escapeText(typeText);
  out += textEl.render();

  return out;
}

function drawClass(writer, diagramHash, targetShape, inlineTheme) {
  const el = themes.newThemableElement('rect', inlineTheme);
  el.X = targetShape.pos.x;
  el.Y = targetShape.pos.y;
  el.Width = targetShape.width;
  el.Height = targetShape.height;
  [el.Fill, el.Stroke] = themes.shapeTheme(targetShape);
  el.FillPattern = targetShape.fillPattern;
  el.Style = targetShape.cssStyle();
  if (targetShape.borderRadius !== 0) {
    el.Rx = targetShape.borderRadius;
    el.Ry = targetShape.borderRadius;
  }
  writer.write(el.render());

  const fields = targetShape.fields ?? [];
  const methods = targetShape.methods ?? [];
  const box = geo.newBox(geo.newPoint(targetShape.pos.x, targetShape.pos.y), targetShape.width, targetShape.height);
  const rowHeight = box.Height / (2 + fields.length + methods.length);
  const headerBox = geo.newBox(box.TopLeft, box.Width, Math.max(2 * rowHeight, targetShape.labelHeight + 2 * label.PADDING));

  writer.write(classHeader(diagramHash, targetShape, headerBox, targetShape.label, targetShape.labelWidth, targetShape.labelHeight, targetShape.fontSize, inlineTheme));

  const rowBox = geo.newBox(box.TopLeft.copy(), box.Width, rowHeight);
  rowBox.TopLeft.y += headerBox.Height;
  for (const f of fields) {
    writer.write(classRow(targetShape, rowBox, d2target.classVisibilityToken(f), f.name, f.type, targetShape.fontSize, f.underline, inlineTheme));
    rowBox.TopLeft.y += rowHeight;
  }

  const lineEl = themes.newThemableElement('line', inlineTheme);

  if (targetShape.borderRadius !== 0 && methods.length === 0) {
    lineEl.X1 = rowBox.TopLeft.x + targetShape.borderRadius;
    lineEl.Y1 = rowBox.TopLeft.y;
    lineEl.X2 = rowBox.TopLeft.x + rowBox.Width - targetShape.borderRadius;
    lineEl.Y2 = rowBox.TopLeft.y;
  } else {
    lineEl.X1 = rowBox.TopLeft.x;
    lineEl.Y1 = rowBox.TopLeft.y;
    lineEl.X2 = rowBox.TopLeft.x + rowBox.Width;
    lineEl.Y2 = rowBox.TopLeft.y;
  }

  lineEl.Stroke = targetShape.fill;
  lineEl.Style = 'stroke-width:1';
  writer.write(lineEl.render());

  for (const m of methods) {
    writer.write(classRow(targetShape, rowBox, d2target.classVisibilityToken(m), m.name, m.return, targetShape.fontSize, m.underline, inlineTheme));
    rowBox.TopLeft.y += rowHeight;
  }

  if (targetShape.icon != null && targetShape.type !== d2target.ShapeImage) {
    const iconPosition = label.fromString(targetShape.iconPosition);
    const iconSize = d2target.getIconSize(box, targetShape.iconPosition);

    const tl = label.getPointOnBox(iconPosition, box, label.PADDING, iconSize, iconSize);

    writer.write(`<image href="${htmlEscape(iconString(targetShape.icon))}" x="${formatFloat(tl.x)}" y="${formatFloat(tl.y)}" width="${iconSize}" height="${iconSize}" />`);
  }
}

// ---- table.go ----

function tableHeader(diagramHash, shp, box, text, textWidth, textHeight, fontSize, inlineTheme) {
  const rectEl = themes.newThemableElement('rect', inlineTheme);
  rectEl.X = box.TopLeft.x;
  rectEl.Y = box.TopLeft.y;
  rectEl.Width = box.Width;
  rectEl.Height = box.Height;
  rectEl.Fill = shp.fill;
  rectEl.FillPattern = shp.fillPattern;
  rectEl.ClassName = 'class_header';
  if (shp.borderRadius !== 0) rectEl.ClipPath = `${diagramHash}-${shp.id}`;
  let str = rectEl.render();

  if (text !== '') {
    const tl = label.getPointOnBox(label.InsideMiddleLeft, box, d2target.HeaderPadding, shp.width, textHeight);

    const textEl = themes.newThemableElement('text', inlineTheme);
    textEl.X = tl.x;
    textEl.Y = tl.y + textHeight * 3 / 4;
    textEl.Fill = shp.getFontColor();
    textEl.ClassName = 'text';
    textEl.Style = `text-anchor:start;font-size:${goV(4 + fontSize)}px`;
    textEl.Content = svg.escapeText(text);
    str += textEl.render();
  }
  return str;
}

function tableRow(shp, box, nameText, typeText, constraintText, fontSize, longestNameWidth, longestTypeWidth, inlineTheme) {
  // Row is made up of name, type, and constraint
  // e.g. | diagram   int   FK |
  const nameTL = label.getPointOnBox(label.InsideMiddleLeft, box, d2target.NamePadding, 0, fontSize);

  const textEl = themes.newThemableElement('text', inlineTheme);
  textEl.X = nameTL.x;
  textEl.Y = nameTL.y + fontSize * 3 / 4;
  textEl.Fill = shp.primaryAccentColor;
  textEl.ClassName = 'text';
  textEl.Style = `text-anchor:start;font-size:${goV(fontSize)}px`;
  textEl.Content = svg.escapeText(nameText);
  let out = textEl.render();

  textEl.X += longestNameWidth + d2target.TypePadding;
  textEl.Fill = shp.neutralAccentColor;
  textEl.Content = svg.escapeText(typeText);
  out += textEl.render();

  textEl.X = box.TopLeft.x + (box.Width - d2target.NamePadding);
  textEl.Fill = shp.secondaryAccentColor;
  textEl.Style = `text-anchor:end;font-size:${goV(fontSize)}px`;
  textEl.Content = constraintText;
  out += textEl.render();

  return out;
}

function drawTable(writer, diagramHash, targetShape, inlineTheme) {
  const rectEl = themes.newThemableElement('rect', inlineTheme);
  rectEl.X = targetShape.pos.x;
  rectEl.Y = targetShape.pos.y;
  rectEl.Width = targetShape.width;
  rectEl.Height = targetShape.height;
  [rectEl.Fill, rectEl.Stroke] = themes.shapeTheme(targetShape);
  rectEl.FillPattern = targetShape.fillPattern;
  rectEl.ClassName = 'shape';
  rectEl.Style = targetShape.cssStyle();
  if (targetShape.borderRadius !== 0) {
    rectEl.Rx = targetShape.borderRadius;
    rectEl.Ry = targetShape.borderRadius;
  }
  writer.write(rectEl.render());

  const columns = targetShape.columns ?? [];
  const box = geo.newBox(geo.newPoint(targetShape.pos.x, targetShape.pos.y), targetShape.width, targetShape.height);
  const rowHeight = box.Height / (1 + columns.length);
  const headerBox = geo.newBox(box.TopLeft, box.Width, rowHeight);

  writer.write(tableHeader(diagramHash, targetShape, headerBox, targetShape.label, targetShape.labelWidth, targetShape.labelHeight, targetShape.fontSize, inlineTheme));

  let longestNameWidth = 0;
  let longestTypeWidth = 0;
  for (const f of columns) {
    longestNameWidth = Math.max(longestNameWidth, f.name.labelWidth);
    longestTypeWidth = Math.max(longestTypeWidth, f.type.labelWidth);
  }

  const rowBox = geo.newBox(box.TopLeft.copy(), box.Width, rowHeight);
  rowBox.TopLeft.y += headerBox.Height;
  columns.forEach((f, idx) => {
    writer.write(tableRow(targetShape, rowBox, f.name.label, f.type.label, d2target.sqlConstraintAbbr(f), targetShape.fontSize, longestNameWidth, longestTypeWidth, inlineTheme));
    rowBox.TopLeft.y += rowHeight;

    const lineEl = themes.newThemableElement('line', inlineTheme);
    if (idx === columns.length - 1 && targetShape.borderRadius !== 0) {
      lineEl.X1 = rowBox.TopLeft.x + targetShape.borderRadius;
      lineEl.Y1 = rowBox.TopLeft.y;
      lineEl.X2 = rowBox.TopLeft.x + rowBox.Width - targetShape.borderRadius;
      lineEl.Y2 = rowBox.TopLeft.y;
    } else {
      lineEl.X1 = rowBox.TopLeft.x;
      lineEl.Y1 = rowBox.TopLeft.y;
      lineEl.X2 = rowBox.TopLeft.x + rowBox.Width;
      lineEl.Y2 = rowBox.TopLeft.y;
    }
    lineEl.Stroke = targetShape.fill;
    lineEl.Style = 'stroke-width:2';
    writer.write(lineEl.render());
  });

  if (targetShape.icon != null && targetShape.type !== d2target.ShapeImage) {
    const iconPosition = label.fromString(targetShape.iconPosition);
    const iconSize = d2target.getIconSize(box, targetShape.iconPosition);

    const tl = label.getPointOnBox(iconPosition, box, label.PADDING, iconSize, iconSize);

    writer.write(`<image href="${htmlEscape(iconString(targetShape.icon))}" x="${formatFloat(tl.x)}" y="${formatFloat(tl.y)}" width="${iconSize}" height="${iconSize}" />`);
  }
}

// ---- markdown.go (native Markdown SVG) ----

class MarkdownRenderer {
  constructor(fontFamily, monoFontFamily, inlineTheme) {
    this.fontFamily = fontFamily ?? d2fonts.SourceSansPro;
    this.monoFontFamily = monoFontFamily ?? d2fonts.SourceCodePro;
    this.inlineTheme = inlineTheme;
    this.corpus = '';
  }

  layout(markdown, fontName, fontSize) {
    let fontFamily = this.fontFamily;
    if (fontName.toLowerCase() === 'mono') {
      fontFamily = this.monoFontFamily;
    } else if (fontName !== '' && fontName.toLowerCase() !== 'default') {
      const family = fontToFamily(fontName.toLowerCase());
      if (family != null) fontFamily = family;
    }
    return this.layoutWithFont(markdown, fontFamily, this.monoFontFamily, fontSize);
  }

  layoutWithFont(markdown, fontFamily, monoFontFamily, fontSize) {
    if (hooks.markdown == null) throw new Deferred('markdown (layout not loaded)');
    const layout = hooks.markdown.layoutMarkdown(markdown, getRuler(), fontFamily, monoFontFamily, fontSize);
    this.corpus += layout.Corpus;
    return layout;
  }

  render(layout, x, y, width, height, foreground, background, disableLinks, underline) {
    let out = `<svg x="${formatFloat(x)}" y="${formatFloat(y)}" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" overflow="hidden">`;

    if (background !== '' && background !== color.None && background !== 'transparent') {
      const backgroundEl = themes.newThemableElement('rect', this.inlineTheme);
      backgroundEl.Width = width;
      backgroundEl.Height = height;
      backgroundEl.Fill = background;
      out += backgroundEl.render();
    }

    const rolePaint = {
      Foreground: this.fillPaint(foreground),
      ForegroundStroke: this.strokePaint(foreground),
      Muted: this.fillPaint(color.N2),
      MutedStroke: this.strokePaint(color.N2),
      Accent: this.fillPaint(color.B2),
      Border: this.fillPaint(color.B1),
      BorderMuted: this.fillPaint(color.B2),
      Canvas: this.fillPaint(color.N7),
      CanvasSubtle: this.fillPaint(color.N6),
      NeutralMuted: this.fillPaint(color.N6),
    };
    out += layout.svg({ Class: 'md md-native', RolePaint: rolePaint, DisableLinks: disableLinks, Underline: underline });
    out += '</svg>';
    return out;
  }

  fillPaint(value) { return this.paint(value, 'fill'); }

  strokePaint(value) { return this.paint(value, 'stroke'); }

  paint(value, property) {
    if (value === '') value = color.N1;
    if (color.isThemeColor(value)) {
      const paint = { Class: `${property}-${value}`, Color: '' };
      if (this.inlineTheme != null) paint.Color = themes.resolveThemeColor(this.inlineTheme, value);
      return paint;
    }
    if (color.isGradient(value)) value = `url('#${color.uniqueGradientID(value)}')`;
    return { Class: '', Color: value };
  }

  generatedCorpus() { return this.corpus; }
}

export const newMarkdownRenderer = (fontFamily, monoFontFamily, inlineTheme) => new MarkdownRenderer(fontFamily, monoFontFamily, inlineTheme);

// ---- font embedding ----

const nativeMarkdownTextPattern = /<text\b[^>]*\bclass="[^"]*\bmd-text\b[^"]*"[^>]*>([^<]*)<\/text>/g;

/** html.UnescapeString for the entities the Markdown painter can emit */
function htmlUnescapeBasic(s) {
  return s.replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z0-9]+);/g, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp < 0xe000) ? String.fromCodePoint(cp) : '�';
    }
    const t = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' }[e];
    return t === undefined ? m : t;
  });
}

function appendOnTrigger(buf, source, triggers, newContent) {
  for (const trigger of triggers) {
    if (source.includes(trigger)) {
      buf.write(newContent);
      break;
    }
  }
}

function appendFontOnTrigger(buf, source, triggers, corpora, cls, corpus, content) {
  if (corpora == null) {
    for (const trigger of triggers) {
      if (source.includes(trigger)) {
        buf.write(content(corpus));
        break;
      }
    }
  } else if (Object.prototype.hasOwnProperty.call(corpora, cls)) {
    buf.write(content(corpora[cls]));
  }
}

function fontFaceCSS(diagramHash, cls, key, subset) {
  return `
.${diagramHash} .${cls} {
	font-family: "${diagramHash}-font-${key}";
}
@font-face {
	font-family: ${diagramHash}-font-${key};
	src: url("${subset}");
}`;
}

/** Go's EmbedFonts. `fontsEmbed` is 'embed' or 'external' (see hooks.fonts). */
export function embedFonts(buf, diagramHash, source, fontFamily, monoFontFamily, corpus, corpora, fontsMode = 'embed') {
  // Markdown generates text that may not exist literally in the D2 source,
  // such as list markers and decoded entities. Include those rendered runs in
  // every font subset, including multi-board animations where render-local
  // Markdown layout state is not available here.
  for (const match of source.matchAll(nativeMarkdownTextPattern)) corpus += htmlUnescapeBasic(match[1]);
  corpora = restrictFontCorpora(corpora, corpus);
  buf.write('<style type="text/css"><![CDATA[');

  const ff = fontFamily ?? d2fonts.SourceSansPro;
  const mf = monoFontFamily ?? d2fonts.SourceCodePro;
  const subset = (family, style, c) => hooks.fonts.getEncodedSubset(family, style, c, fontsMode);
  const face = (cls, key, family, style) => (c) => fontFaceCSS(diagramHash, cls, key, subset(family, style, c));

  appendFontOnTrigger(buf, source, ['class="text"', 'class="text ', 'class="md"', 'class="md '], corpora, 'text', corpus, face('text', 'regular', ff, d2fonts.FONT_STYLE_REGULAR));
  appendFontOnTrigger(buf, source, ['text-semibold'], corpora, 'text-semibold', corpus, face('text-semibold', 'semibold', ff, d2fonts.FONT_STYLE_SEMIBOLD));

  appendOnTrigger(buf, source, ['text-underline'], `
.text-underline {
	text-decoration: underline;
}`);

  appendOnTrigger(buf, source, ['text-link'], `
.text-link {
	fill: blue;
}

.text-link:visited {
	fill: purple;
}`);

  appendOnTrigger(buf, source, ['animated-connection'], `
@keyframes dashdraw {
	from {
		stroke-dashoffset: 0;
	}
}
`);

  appendOnTrigger(buf, source, ['animated-shape'], `
@keyframes shapeappear {
    0%, 100% { transform: translateY(0); filter: drop-shadow(0px 0px 0px rgba(0,0,0,0)); }
    50% { transform: translateY(-4px); filter: drop-shadow(0px 12.6px 25.2px rgba(50,50,93,0.25)) drop-shadow(0px 7.56px 15.12px rgba(0,0,0,0.1)); }
}
.animated-shape {
	animation: shapeappear 1s linear infinite;
}
`);

  appendOnTrigger(buf, source, ['appendix-icon'], `
.appendix-icon {
	filter: drop-shadow(0px 0px 32px rgba(31, 36, 58, 0.1));
}`);

  appendFontOnTrigger(buf, source, ['text-bold', '<b>', '<strong>'], corpora, 'text-bold', corpus, face('text-bold', 'bold', ff, d2fonts.FONT_STYLE_BOLD));
  appendFontOnTrigger(buf, source, ['text-italic', '<em>', '<dfn>'], corpora, 'text-italic', corpus, face('text-italic', 'italic', ff, d2fonts.FONT_STYLE_ITALIC));
  appendFontOnTrigger(buf, source, ['text-mono', '<pre>', '<code>', '<kbd>', '<samp>'], corpora, 'text-mono', corpus, face('text-mono', 'mono', mf, d2fonts.FONT_STYLE_REGULAR));
  appendFontOnTrigger(buf, source, ['text-mono-semibold'], corpora, 'text-mono-semibold', corpus, face('text-mono-semibold', 'mono-semibold', mf, d2fonts.FONT_STYLE_SEMIBOLD));
  appendFontOnTrigger(buf, source, ['text-mono-bold'], corpora, 'text-mono-bold', corpus, face('text-mono-bold', 'mono-bold', mf, d2fonts.FONT_STYLE_BOLD));
  appendFontOnTrigger(buf, source, ['text-mono-italic'], corpora, 'text-mono-italic', corpus, face('text-mono-italic', 'mono-italic', mf, d2fonts.FONT_STYLE_ITALIC));

  appendOnTrigger(buf, source, ['sketch-overlay-bright'], `
.sketch-overlay-bright {
	fill: url(#streaks-bright-${diagramHash});
	mix-blend-mode: darken;
}`);
  appendOnTrigger(buf, source, ['sketch-overlay-normal'], `
.sketch-overlay-normal {
	fill: url(#streaks-normal-${diagramHash});
	mix-blend-mode: color-burn;
}`);
  appendOnTrigger(buf, source, ['sketch-overlay-dark'], `
.sketch-overlay-dark {
	fill: url(#streaks-dark-${diagramHash});
	mix-blend-mode: overlay;
}`);
  appendOnTrigger(buf, source, ['sketch-overlay-darker'], `
.sketch-overlay-darker {
	fill: url(#streaks-darker-${diagramHash});
	mix-blend-mode: lighten;
}`);

  buf.write(']]></style>');
}

// ---- Render ----

/**
 * Render renders the diagram to an SVG document (a string). See the file header for `opts`.
 * Throws `Deferred` for the parts that are not ported (sketch, LaTeX, code languages without a lexer).
 */
export function render(diagram, opts) {
  let sketch = false;
  let pad = DEFAULT_PADDING;
  const [tl, br] = diagram.boundingBox();
  let themeID = themes.NeutralDefault.id;
  let darkThemeID = null; // DEFAULT_DARK_THEME: no theme selected
  let scale = null;
  if (opts != null) {
    if (opts.pad != null) pad = validatePadding(tl, br, opts.pad);
    if (opts.sketch != null && opts.sketch) sketch = true;
    if (opts.themeID != null) themeID = opts.themeID;
    darkThemeID = opts.darkThemeID ?? null;
    scale = opts.scale ?? null;
  } else {
    opts = {};
  }
  const fontsMode = opts.fonts ?? 'embed';

  const buf = new Buf();

  // only define shadow filter if a shape uses it
  for (const s of diagram.shapes ?? []) {
    if (s.shadow) {
      defineShadowFilter(buf);
      break;
    }
  }

  if (color.isGradient(diagram.root.fill)) defineGradients(buf, diagram.root.fill);
  if (color.isGradient(diagram.root.stroke)) defineGradients(buf, diagram.root.stroke);
  for (const s of diagram.shapes ?? []) {
    if (color.isGradient(s.fill)) defineGradients(buf, s.fill);
    if (color.isGradient(s.stroke)) defineGradients(buf, s.stroke);
    if (color.isGradient(s.color)) defineGradients(buf, s.color);
  }
  for (const c of diagram.connections ?? []) {
    if (color.isGradient(c.stroke)) defineGradients(buf, c.stroke);
    if (color.isGradient(c.fill)) defineGradients(buf, c.fill);
  }

  // Apply hash on IDs for targeting, to be specific for this diagram
  let diagramHash = diagram.hashID(opts.salt ?? null);
  // Some targeting is still per-board, like masks for connections
  const isolatedDiagramHash = diagramHash;
  if (opts.masterID != null && opts.masterID !== '') diagramHash = opts.masterID;

  // SVG has no notion of z-index. The z-index is effectively the order it's drawn.
  // So draw from the least nested to most nested
  const idToShape = new Map();
  const allObjects = [];
  for (const s of diagram.shapes ?? []) {
    idToShape.set(s.id, s);
    allObjects.push(s);
  }
  for (const c of diagram.connections ?? []) allObjects.push(c);

  sortObjects(allObjects);

  const appendixItemBuf = new Buf();

  const labelMasks = [];
  const markers = new Set();
  let inlineTheme = null;
  // We only want to inline when no dark theme is specified, otherwise the inline style will override the CSS
  if (darkThemeID == null) {
    inlineTheme = themes.find(themeID);
    themes.applyOverrides(inlineTheme, opts.themeOverrides);
  }
  const markdown = newMarkdownRenderer(diagram.fontFamily, diagram.monoFontFamily, inlineTheme);
  for (const obj of allObjects) {
    if (obj instanceof d2target.Connection) {
      const labelMask = drawConnection(buf, isolatedDiagramHash, obj, markers, idToShape, sketch, inlineTheme, markdown);
      if (labelMask !== '') labelMasks.push(labelMask);
    } else if (obj instanceof d2target.Shape) {
      const labelMask = drawShape(buf, appendixItemBuf, diagramHash, obj, sketch, inlineTheme, markdown);
      if (labelMask !== '') labelMasks.push(labelMask);
    } else {
      throw new Error('unknown object of type ' + typeof obj);
    }
  }
  // add all appendix items afterwards so they are always on top
  buf.write(appendixItemBuf.s);

  if (hasLegend(diagram)) {
    const legendBuf = new Buf();
    renderLegend(legendBuf, diagram, diagramHash, inlineTheme);
    buf.write(legendBuf.s);
  }

  // Note: we always want this since we reference it on connections even if there end up being no masked labels
  let [left, top, w, h] = dimensions(diagram, pad, tl, br);

  if (hasLegend(diagram)) {
    const ruler = getRuler();
    if (ruler != null) {
      let [totalHeight, maxLabelWidth] = legendMetrics(diagram, ruler);

      totalHeight += LEGEND_PADDING;

      if (totalHeight > 0 && maxLabelWidth > 0) {
        const legendWidth = LEGEND_PADDING * 2 + LEGEND_ICON_SIZE + LEGEND_PADDING + maxLabelWidth;

        let legendY = br.y - totalHeight;
        if (legendY < tl.y) legendY = tl.y;

        const legendRight = br.x + LEGEND_CORNER_PADDING + legendWidth;
        if (left + w < legendRight) w = legendRight - left + Math.trunc(pad / 2);

        if (legendY < top) {
          const diffY = top - legendY;
          top -= diffY;
          h += diffY;
        }

        const legendBottom = legendY + totalHeight;
        if (top + h < legendBottom) h = legendBottom - top + Math.trunc(pad / 2);
      }
    }
  }
  if (w < 0 || h < 0) throw invalidPaddingError(pad);
  buf.write([
    `<mask id="${isolatedDiagramHash}" maskUnits="userSpaceOnUse" x="${left}" y="${top}" width="${w}" height="${h}">`,
    `<rect x="${left}" y="${top}" width="${w}" height="${h}" fill="white"></rect>`,
    labelMasks.join('\n'),
    '</mask>',
  ].join('\n'));

  // Validate the theme before expanding the background, preserving error order.
  let themeStylesheet = '';
  if (opts.masterID == null || opts.masterID === '') {
    themeStylesheet = themeCSS(diagramHash, themeID, darkThemeID, opts.themeOverrides, opts.darkThemeOverrides);
  }

  // This shift is for background el to envelop the diagram
  const strokePadding = goInt(Math.ceil(diagram.root.strokeWidth / 2.));
  let ex = expandDimensions(left, top, w, h, strokePadding);
  if (ex === null) throw invalidPaddingError(pad);
  [left, top, w, h] = ex;
  const backgroundEl = themes.newThemableElement('rect', inlineTheme);
  // We don't want to change the document viewbox, only the background el
  backgroundEl.X = left;
  backgroundEl.Y = top;
  backgroundEl.Width = w;
  backgroundEl.Height = h;
  backgroundEl.Fill = diagram.root.fill;
  backgroundEl.Stroke = diagram.root.stroke;
  backgroundEl.FillPattern = diagram.root.fillPattern;
  backgroundEl.Rx = diagram.root.borderRadius;
  if (diagram.root.strokeDash !== 0) {
    const [dashSize, gapSize] = svg.getStrokeDashAttributes(diagram.root.strokeWidth, diagram.root.strokeDash);
    backgroundEl.StrokeDashArray = `${formatFloat(dashSize)}, ${formatFloat(gapSize)}`;
  }
  backgroundEl.Attributes = `stroke-width="${diagram.root.strokeWidth}"`;

  // This shift is for viewbox to envelop the background el
  ex = expandDimensions(left, top, w, h, strokePadding);
  if (ex === null) throw invalidPaddingError(pad);
  [left, top, w, h] = ex;

  let doubleBorderElStr = '';
  if (diagram.root['double-border']) {
    const offset = d2target.INNER_BORDER_OFFSET;

    ex = expandDimensions(left, top, w, h, strokePadding + offset);
    if (ex === null) throw invalidPaddingError(pad);
    [left, top, w, h] = ex;

    const backgroundEl2 = backgroundEl.copy();
    // No need to double-paint
    backgroundEl.Fill = 'transparent';

    backgroundEl2.X = left;
    backgroundEl2.Y = top;
    backgroundEl2.Width = w;
    backgroundEl2.Height = h;
    doubleBorderElStr = backgroundEl2.render();

    ex = expandDimensions(left, top, w, h, strokePadding);
    if (ex === null) throw invalidPaddingError(pad);
    [left, top, w, h] = ex;
  }

  const backgroundStr = backgroundEl.render();

  // generate style elements that will be appended to the SVG tag
  const upperBuf = new Buf();
  if (opts.masterID == null || opts.masterID === '') {
    let [corpora, classes, ok] = collectFontCorporaAndClasses(buf.s, BaseStylesheet);
    if (!ok) corpora = null;
    // Appendix postprocessing can add footnotes and numbered icons after
    // Render. Preserve both the old face selection and its whole corpus
    // whenever the diagram can receive that additional text.
    for (const s of diagram.shapes ?? []) {
      if (s.tooltip !== '' || s.link !== '' || s.prettyLink !== '') {
        corpora = null;
        break;
      }
    }
    // Must precede DefineFillPatterns, after all text is rendered.
    embedFonts(upperBuf, diagramHash, buf.s, diagram.fontFamily, diagram.monoFontFamily, diagram.getCorpus() + markdown.generatedCorpus(), corpora, fontsMode);

    if (classes == null) themeStylesheet = pruneThemeCSS(themeStylesheet, buf.s, backgroundStr, doubleBorderElStr);
    else themeStylesheet = pruneThemeCSSWithClasses(themeStylesheet, classes, backgroundStr, doubleBorderElStr);
    upperBuf.write(`<style type="text/css"><![CDATA[${BaseStylesheet}${themeStylesheet}]]></style>`);

    if (sketch) throw new Deferred('sketch');
  }

  const bufStr = buf.s;
  let patternDefs = '';
  for (const pattern of FillPatterns) {
    if (bufStr.includes(`${pattern}-overlay`) || diagram.root.fillPattern === pattern) {
      if (patternDefs === '') upperBuf.write('<style type="text/css"><![CDATA[');
      switch (pattern) {
        case 'dots': patternDefs += dots.replace(/%s/g, diagramHash); break;
        case 'lines': patternDefs += lines.replace(/%s/g, diagramHash); break;
        case 'grain': patternDefs += patternAsset('grainSVG').replace(/%\[1\]s/g, diagramHash); break;
        case 'paper': patternDefs += patternAsset('paperSVG').replace(/%\[1\]s/g, diagramHash); break;
      }
      upperBuf.write(`
.${pattern}-overlay {
	fill: url(#${pattern}-${diagramHash});
	mix-blend-mode: multiply;
}`);
    }
  }
  if (patternDefs !== '') {
    upperBuf.write(']]></style>');
    upperBuf.write('<defs>');
    upperBuf.write(patternDefs);
    upperBuf.write('</defs>');
  }

  let dims = '';
  if (scale != null) dims = ` width="${goInt(Math.ceil(scale * w))}" height="${goInt(Math.ceil(scale * h))}"`;

  let alignment = 'xMinYMin';
  if (opts.center != null && opts.center) alignment = 'xMidYMid';
  let fitToScreenWrapperOpening = '';
  let xmlTag = '';
  let fitToScreenWrapperClosing = '';
  let idAttr = '';
  let tag = 'g';
  // Many things change when this is rendering for animation
  if (opts.masterID == null || opts.masterID === '') {
    let dataD2Version = '';
    if (opts.omitVersion == null || !opts.omitVersion) dataD2Version = `data-d2-version="${VERSION}"`;
    fitToScreenWrapperOpening = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ${dataD2Version} preserveAspectRatio="${alignment} meet" viewBox="0 0 ${w} ${h}"${dims}>`;
    if (opts.noXMLTag == null || !opts.noXMLTag) xmlTag = '<?xml version="1.0" encoding="utf-8"?>';
    fitToScreenWrapperClosing = '</svg>';
    idAttr = 'd2-svg';
    tag = 'svg';
  }

  return `${xmlTag}${fitToScreenWrapperOpening}<${tag} class="${[diagramHash, idAttr].join(' ')}" width="${w}" height="${h}" viewBox="${left} ${top} ${w} ${h}">${doubleBorderElStr}${backgroundStr}${upperBuf.s}${buf.s}</${tag}>${fitToScreenWrapperClosing}`;
}

function patternAsset(name) {
  if (hooks.patterns == null) throw new Deferred(`pattern assets (${name}) not loaded`);
  return hooks.patterns[name]();
}

export function themeCSS(diagramHash, themeID, darkThemeID, overrides, darkOverrides) {
  if (themeID == null) themeID = themes.NeutralDefault.id;
  let out = singleThemeRulesets(diagramHash, themeID, overrides);

  if (darkThemeID != null) {
    const darkOut = singleThemeRulesets(diagramHash, darkThemeID, darkOverrides);
    out += `@media screen and (prefers-color-scheme:dark){${darkOut}}`;
  }

  return out;
}

function singleThemeRulesets(diagramHash, themeID, overrides) {
  let out = '';
  const theme = themes.find(themeID);
  themes.applyOverrides(theme, overrides);
  const c = theme.colors;

  // Global theme colors
  const entries = [
    ['N1', c.neutrals.n1], ['N2', c.neutrals.n2], ['N3', c.neutrals.n3], ['N4', c.neutrals.n4], ['N5', c.neutrals.n5], ['N6', c.neutrals.n6], ['N7', c.neutrals.n7],
    ['B1', c.b1], ['B2', c.b2], ['B3', c.b3], ['B4', c.b4], ['B5', c.b5], ['B6', c.b6],
    ['AA2', c.aa2], ['AA4', c.aa4], ['AA5', c.aa5], ['AB4', c.ab4], ['AB5', c.ab5],
  ];
  for (const property of ['fill', 'stroke', 'background-color', 'color']) {
    out += `
		${entries.map(([code, v]) => `.${diagramHash} .${property}-${code}{${property}:${v};}`).join('\n\t\t')}`;
  }

  // Appendix
  out += `.appendix text.text{fill:${c.neutrals.n1}}`;

  // Retain the Markdown custom properties for output compatibility and for
  // consumers that style the native .md group. Native D2 primitives use the
  // corresponding fill/stroke theme classes directly.
  out += `.md{--color-fg-default:${c.neutrals.n1};--color-fg-muted:${c.neutrals.n2};--color-fg-subtle:${c.neutrals.n3};--color-canvas-default:${c.neutrals.n7};--color-canvas-subtle:${c.neutrals.n6};--color-border-default:${c.b1};--color-border-muted:${c.b2};--color-neutral-muted:${c.neutrals.n6};--color-accent-fg:${c.b2};--color-accent-emphasis:${c.b2};--color-attention-subtle:${c.neutrals.n2};--color-danger-fg:red;}`;

  // Sketch style specific rulesets
  for (const [code, v] of [
    [color.B1, c.b1], [color.B2, c.b2], [color.B3, c.b3], [color.B4, c.b4], [color.B5, c.b5], [color.B6, c.b6],
    [color.AA2, c.aa2], [color.AA4, c.aa4], [color.AA5, c.aa5], [color.AB4, c.ab4], [color.AB5, c.ab5],
    [color.N1, c.neutrals.n1], [color.N2, c.neutrals.n2], [color.N3, c.neutrals.n3], [color.N4, c.neutrals.n4],
    [color.N5, c.neutrals.n5], [color.N6, c.neutrals.n6], [color.N7, c.neutrals.n7],
  ]) {
    const lc = color.luminanceCategory(v);
    out += `.sketch-overlay-${code}{fill:url(#streaks-${lc}-${diagramHash});mix-blend-mode:${blendMode(lc)}}`;
  }

  if (themes.isDark(theme)) {
    out += '.light-code{display: none}';
    out += '.dark-code{display: block}';
  } else {
    out += '.light-code{display: block}';
    out += '.dark-code{display: none}';
  }

  return out;
}

function blendMode(lc) {
  switch (lc) {
    case 'bright': return 'darken';
    case 'normal': return 'color-burn';
    case 'dark': return 'overlay';
    case 'darker': return 'lighten';
  }
  throw new Error('invalid luminance category');
}

/**
 * sortObjects sorts all diagrams objects (shapes and connections) in the desired drawing order
 * the sorting criteria is:
 * 1. zIndex, lower comes first
 * 2. two shapes with the same zIndex are sorted by their level (container nesting), containers come first
 * 3. two shapes with the same zIndex and same level, are sorted in the order they were exported
 * 4. shape and edge, shapes come first
 */
function sortObjects(allObjects) {
  const less = (a, b) => {
    // first sort by zIndex
    const iZIndex = a.getZIndex();
    const jZIndex = b.getZIndex();
    if (iZIndex !== jZIndex) return iZIndex < jZIndex;

    // then, if both are shapes, parents come before their children
    const iIsShape = a instanceof d2target.Shape;
    const jIsShape = b instanceof d2target.Shape;
    if (iIsShape && jIsShape) return a.level < b.level;

    // then, shapes come before connections
    const jIsConnection = b instanceof d2target.Connection;
    return iIsShape && jIsConnection;
  };
  allObjects.sort((a, b) => (less(a, b) ? -1 : less(b, a) ? 1 : 0));
}

export function renderMultiboard(diagram, opts) {
  let boards = [];
  for (const dl of diagram.layers ?? []) boards = boards.concat(renderMultiboard(dl, opts));
  for (const dl of diagram.scenarios ?? []) boards = boards.concat(renderMultiboard(dl, opts));
  for (const dl of diagram.steps ?? []) boards = boards.concat(renderMultiboard(dl, opts));

  if (!diagram.isFolderOnly) {
    const out = render(diagram, opts);
    return [out, ...boards];
  }
  return boards;
}
