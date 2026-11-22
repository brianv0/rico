// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of D2's d2exporter package (D2 v0.9.0, Copyright 2022 Terrastruct Inc.): export.go.
// Turns a laid out d2graph.Graph into a d2target.Diagram. Conventions as in d2graph.js (obj.box.TopLeft.x for Go's
// obj.TopLeft.X, obj.attributes.label for obj.Label, ...).

import { scalarString, LabelPositionsMapping } from './ast.js';
import { parseKey } from './parser.js';
import * as d2target from './target.js';
import * as d2fonts from './fonts.js';
import * as color from './color.js';
import * as label from './label.js';
import { parseRequestURI as urlParseRequestURI, enc, dec } from './url.js';
import { atoi as strconvAtoi, parseBool as strconvParseBool, parseFloat64 } from './strconv.js';
import { float32, goInt } from './gomath.js';

const ss = scalarString;
const lc = (s) => s.toLowerCase();
const num = (x) => parseFloat64(x)[0];
const int = (x) => strconvAtoi(x)[0];
const bool = (x) => strconvParseBool(x)[0];

/**
 * Export builds the diagram of a board (not its sub-boards).
 * @returns {d2target.Diagram}
 */
export function exportDiagram(g, fontFamily, monoFontFamily) {
  const diagram = d2target.newDiagram();
  applyStyles(diagram.root, g.root);
  if (g.root.attributes.label.mapKey === null) diagram.root.label = g.name;
  else diagram.root.label = g.root.attributes.label.value;
  diagram.name = g.name;
  diagram.isFolderOnly = g.isFolderOnly;
  if (fontFamily === null || fontFamily === undefined) fontFamily = d2fonts.SourceSansPro;
  if (g.theme !== null && g.theme.specialRules.mono) fontFamily = d2fonts.SourceCodePro;
  diagram.fontFamily = fontFamily;
  if (monoFontFamily === null || monoFontFamily === undefined) diagram.monoFontFamily = d2fonts.SourceCodePro;
  else diagram.monoFontFamily = monoFontFamily;

  const objects = g.objects || [];
  diagram.shapes = new Array(objects.length);
  for (let i = 0; i < objects.length; i++) diagram.shapes[i] = toShape(objects[i], g);

  const edges = g.edges || [];
  diagram.connections = new Array(edges.length);
  for (let i = 0; i < edges.length; i++) diagram.connections[i] = toConnection(edges[i], g.theme);

  if (g.legend !== null) {
    const legend = new d2target.Legend();
    legend.label = g.legend.label;

    if ((g.legend.objects || []).length > 0) {
      legend.shapes = g.legend.objects.map((obj) => toShape(obj, g));
    }
    if ((g.legend.edges || []).length > 0) {
      legend.connections = g.legend.edges.map((edge) => toConnection(edge, g.theme));
    }
    diagram.legend = legend;
  }

  return diagram;
}

function applyTheme(shape, obj, theme) {
  shape.stroke = obj.getStroke(shape.strokeDash);
  shape.fill = obj.getFill();
  if (obj.attributes.shape.value === d2target.ShapeText) shape.color = color.N1;
  if (obj.attributes.shape.value === d2target.ShapeSQLTable || obj.attributes.shape.value === d2target.ShapeClass) {
    shape.primaryAccentColor = color.B2;
    shape.secondaryAccentColor = color.AA2;
    shape.neutralAccentColor = color.N2;
  }

  const children = (obj.childrenArray || []).length;
  // Theme options that change more than color
  if (theme !== null) {
    if (theme.specialRules.outerContainerDoubleBorder) {
      if (obj.level() === 1 && children > 0) shape['double-border'] = true;
    }
    if (theme.specialRules.containerDots) {
      if (children > 0) shape.fillPattern = 'dots';
    } else if (theme.specialRules.allPaper) {
      shape.fillPattern = 'paper';
    }
    if (theme.specialRules.mono) shape.fontFamily = 'mono';
    if (theme.specialRules.c4 && children > 0) {
      if (obj.attributes.style.fill === null) shape.fill = 'transparent';
      if (obj.attributes.style.stroke === null) shape.stroke = color.AA2;
      if (obj.attributes.style.strokeDash === null) shape.strokeDash = 5;
      if (obj.attributes.style.fontColor === null) shape.color = color.N1;
    }
    if (theme.specialRules.c4 && obj.level() === 1 && children === 0 &&
      obj.attributes.shape.value !== d2target.ShapePerson && obj.attributes.shape.value !== d2target.ShapeC4Person) {
      if (obj.attributes.style.fill === null) shape.fill = color.B6;
      if (obj.attributes.style.stroke === null) shape.stroke = color.B5;
    }
    if (theme.specialRules.c4 && (obj.attributes.shape.value === d2target.ShapePerson || obj.attributes.shape.value === d2target.ShapeC4Person)) {
      if (obj.attributes.style.fill === null) shape.fill = color.B2;
      if (obj.attributes.style.stroke === null) shape.stroke = color.B1;
    }
    if (theme.specialRules.c4 && obj.level() > 1 && children === 0 &&
      obj.attributes.shape.value !== d2target.ShapePerson && obj.attributes.shape.value !== d2target.ShapeC4Person) {
      if (obj.attributes.style.fill === null) shape.fill = color.B4;
      if (obj.attributes.style.stroke === null) shape.stroke = color.B3;
    }
  }
}

function applyStyles(shape, obj) {
  const style = obj.attributes.style;
  if (style.opacity !== null) shape.opacity = num(style.opacity.value);
  if (style.strokeDash !== null) shape.strokeDash = num(style.strokeDash.value);
  if (style.fill !== null) shape.fill = style.fill.value;
  else if (obj.attributes.shape.value === d2target.ShapeText) shape.fill = 'transparent';
  if (style.fillPattern !== null) shape.fillPattern = style.fillPattern.value;
  if (style.stroke !== null) shape.stroke = style.stroke.value;
  if (style.strokeWidth !== null) shape.strokeWidth = int(style.strokeWidth.value);
  if (style.shadow !== null) shape.shadow = bool(style.shadow.value);
  if (style.threeDee !== null) shape['3d'] = bool(style.threeDee.value);
  if (style.multiple !== null) shape.multiple = bool(style.multiple.value);
  if (style.borderRadius !== null) shape.borderRadius = int(style.borderRadius.value);

  if (style.fontColor !== null) shape.color = style.fontColor.value;
  if (style.italic !== null) shape.italic = bool(style.italic.value);
  if (style.bold !== null) shape.bold = bool(style.bold.value);
  if (style.underline !== null) shape.underline = bool(style.underline.value);
  if (style.font !== null) shape.fontFamily = style.font.value;
  if (style.doubleBorder !== null) shape['double-border'] = bool(style.doubleBorder.value);
  if (obj.attributes.iconStyle.borderRadius !== null) shape.iconBorderRadius = int(obj.attributes.iconStyle.borderRadius.value);
}

function toShape(obj, g) {
  const shape = d2target.baseShape();
  shape.setType(obj.attributes.shape.value);
  shape.id = obj.absID();
  shape.classes = obj.attributes.classes;
  shape.zIndex = obj.zIndex;
  shape.level = obj.level();
  shape.pos = d2target.newPoint(goInt(obj.box.TopLeft.x), goInt(obj.box.TopLeft.y));
  shape.width = goInt(obj.box.Width);
  shape.height = goInt(obj.box.Height);
  shape.language = obj.attributes.language;

  const text = obj.text();
  shape.bold = text.isBold;
  shape.italic = text.isItalic;
  shape.fontSize = text.fontSize;

  if (obj.isSequenceDiagram()) shape.strokeWidth = 0;

  if (obj.isSequenceDiagramGroup()) {
    shape.strokeWidth = 0;
    shape.blend = true;
  }

  applyStyles(shape, obj);
  applyTheme(shape, obj, g.theme);
  shape.color = text.getColor(shape.italic);
  if (g.theme !== null && g.theme.specialRules.c4) {
    if (obj.attributes.style.fontColor === null) {
      if ((obj.childrenArray || []).length > 0) shape.color = color.N1;
      else shape.color = color.N7;
    }
  }
  applyStyles(shape, obj);

  switch (lc(obj.attributes.shape.value)) {
    case d2target.ShapeClass:
      shape.fields = obj.class.fields;
      shape.methods = obj.class.methods;
      // The label is the header for classes and tables, which is set in client to be 4 px larger than the object's set font size
      shape.fontSize -= d2target.HeaderFontAdd;
      break;
    case d2target.ShapeSQLTable:
      shape.columns = obj.sqlTable.columns;
      shape.fontSize -= d2target.HeaderFontAdd;
      break;
    case d2target.ShapeCloud:
      if (obj.contentAspectRatio !== null) shape.contentAspectRatio = obj.contentAspectRatio;
      break;
  }
  shape.label = text.text;
  shape.labelWidth = text.dimensions.width;

  shape.labelHeight = text.dimensions.height;
  if (obj.labelPosition !== null) {
    shape.labelPosition = obj.labelPosition;
    if (obj.isSequenceDiagramGroup()) shape.labelFill = shape.fill;
  }

  if (obj.attributes.tooltip !== null) shape.tooltip = obj.attributes.tooltip.value;
  if (obj.attributes.tooltipPosition !== null) shape.tooltipPosition = obj.attributes.tooltipPosition.value;
  if (obj.attributes.style.animated !== null) shape.animated = bool(obj.attributes.style.animated.value);
  if (obj.attributes.link !== null) {
    shape.link = obj.attributes.link.value;
    shape.prettyLink = toPrettyLink(g, obj.attributes.link.value);
  }
  shape.icon = obj.attributes.icon;
  if (obj.iconPosition !== null) shape.iconPosition = obj.iconPosition;

  return shape;
}

function toPrettyLink(g, link) {
  const { url: u, err } = urlParseRequestURI(link);
  const rawPath = u === null ? '' : enc(u.RawPath);
  if (err === null && u.Host !== '' && rawPath.length > 30) {
    return dec(enc(u.Scheme) + '://' + enc(u.Host) + rawPath.slice(0, 10) + '...' + rawPath.slice(rawPath.length - 10));
  } else if (err !== null) {
    let linkKey;
    try { linkKey = parseKey(link); } catch { return link; }
    let rootG = g;
    while (rootG.parent !== null) rootG = rootG.parent;
    const prettyLink = [];
    for (let i = 0; i < linkKey.path.length; i++) {
      const p = ss(linkKey.path[i]);
      if (i > 0) {
        if (p === 'layers' || p === 'scenarios' || p === 'steps') continue;
        rootG = rootG.getBoard(p);
        if (rootG === null) return link;
      }
      if (rootG.root.attributes.label.mapKey !== null) prettyLink.push(rootG.root.attributes.label.value);
      else prettyLink.push(rootG.name);
    }
    for (const l of prettyLink) {
      // If any part of it is blank, "x > > y" looks stupid, so just use the last
      if (l === '') return prettyLink[prettyLink.length - 1];
    }
    return prettyLink.join(' > ');
  }
  return link;
}

function toConnection(edge, theme) {
  const connection = d2target.baseConnection();
  connection.id = edge.absID();
  connection.classes = edge.attributes.classes;
  connection.zIndex = edge.zIndex;
  const text = edge.text();

  if (edge.srcArrow) {
    connection.srcArrow = d2target.DefaultArrowhead;
    if (edge.srcArrowhead !== null) connection.srcArrow = edge.srcArrowhead.toArrowhead();
  }
  if (edge.srcArrowhead !== null) {
    if (edge.srcArrowhead.label.value !== '') {
      connection.srcLabel = new d2target.Text({
        label: edge.srcArrowhead.label.value,
        labelWidth: edge.srcArrowhead.labelDimensions.width,
        labelHeight: edge.srcArrowhead.labelDimensions.height,
      });
      if (edge.srcArrowhead.style.fontColor !== null) connection.srcLabel.color = edge.srcArrowhead.style.fontColor.value;
    }
  }
  if (edge.dstArrow) {
    connection.dstArrow = d2target.DefaultArrowhead;
    if (edge.dstArrowhead !== null) connection.dstArrow = edge.dstArrowhead.toArrowhead();
  }
  if (edge.dstArrowhead !== null) {
    if (edge.dstArrowhead.label.value !== '') {
      connection.dstLabel = new d2target.Text({
        label: edge.dstArrowhead.label.value,
        labelWidth: edge.dstArrowhead.labelDimensions.width,
        labelHeight: edge.dstArrowhead.labelDimensions.height,
      });
      if (edge.dstArrowhead.style.fontColor !== null) connection.dstLabel.color = edge.dstArrowhead.style.fontColor.value;
    }
  }
  const style = edge.attributes.style;
  if (theme !== null && theme.specialRules.noCornerRadius) connection.borderRadius = 0;
  if (style.borderRadius !== null) connection.borderRadius = num(style.borderRadius.value);

  if (style.opacity !== null) connection.opacity = num(style.opacity.value);

  if (style.strokeDash !== null) connection.strokeDash = num(style.strokeDash.value);
  connection.stroke = edge.getStroke(connection.strokeDash);
  if (style.stroke !== null) connection.stroke = style.stroke.value;

  if (style.strokeWidth !== null) connection.strokeWidth = int(style.strokeWidth.value);

  if (style.fill !== null) connection.fill = style.fill.value;

  connection.fontSize = text.fontSize;
  if (style.fontSize !== null) connection.fontSize = int(style.fontSize.value);

  if (style.animated !== null) connection.animated = bool(style.animated.value);

  if (edge.attributes.tooltip !== null) connection.tooltip = edge.attributes.tooltip.value;
  if (edge.attributes.icon !== null) {
    connection.icon = edge.attributes.icon;
    if (edge.attributes.iconPosition !== null) {
      connection.iconPosition = label.positionString(LabelPositionsMapping[edge.attributes.iconPosition.value]);
    } else connection.iconPosition = label.positionString(label.InsideMiddleCenter);
  }

  if (edge.attributes.iconStyle.borderRadius !== null) connection.iconBorderRadius = num(edge.attributes.iconStyle.borderRadius.value);

  if (style.italic !== null) connection.italic = bool(style.italic.value);

  connection.color = text.getColor(connection.italic);
  if (style.fontColor !== null) connection.color = style.fontColor.value;
  if (style.bold !== null) connection.bold = bool(style.bold.value);
  if (style.underline !== null) connection.underline = bool(style.underline.value);
  if (theme !== null && theme.specialRules.mono) connection.fontFamily = 'mono';
  if (style.font !== null) connection.fontFamily = style.font.value;
  if (edge.attributes.link !== null) connection.link = edge.attributes.link.value;
  connection.label = text.text;
  connection.labelWidth = text.dimensions.width;
  connection.labelHeight = text.dimensions.height;
  connection.language = edge.attributes.language;

  if (edge.labelPosition !== null) connection.labelPosition = edge.labelPosition;
  if (edge.labelPercentage !== null) connection.labelPercentage = float32(edge.labelPercentage);
  connection.route = [];
  for (const rp of edge.route || []) {
    const p = rp.copy();
    p.truncateDecimals();
    p.truncateFloat32();
    connection.route.push(p);
  }

  connection.isCurve = edge.isCurve;

  connection.src = edge.src.absID();
  connection.dst = edge.dst.absID();

  if (theme !== null && theme.specialRules.c4) {
    if (style.strokeDash === null) connection.strokeDash = 5;
    if (style.stroke === null) connection.stroke = color.AA4;
    if (style.fontColor === null) connection.color = color.N2;
  }

  return connection;
}
