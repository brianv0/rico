// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of D2's d2layouts/d2elklayout package (D2 v0.9.0, Copyright 2022 Terrastruct Inc.):
// layout.go, descendant_shifter.go and spatial_index.go, the Go glue that adapts D2 graphs to ELK.
// (wasm.go, the legacy raw-WASM ConvertGraph export, is not ported.)
//
// Coordinates are relative to parents.
// See https://www.eclipse.org/elk/documentation/tooldevelopers/graphdatastructure/coordinatesystem.html
//
// In v0.9.0 the glue calls elk-go, a native Go port of ELK that follows official ELK.js 0.12.0. Here the same graph goes to ELK.js 0.12.0
// itself (npm elkjs, EPL-2.0 OR GPL-3.0-or-later), vendored in vendor/elk.js (see vendor/README.txt) and called synchronously through its worker
// dispatcher: no Web Worker, no `eval`, nothing asynchronous. The module is a dynamic import in d2lib.js, so the default (dagre) path never loads it.

import * as d2graph from './d2graph.js';
import * as d2target from './target.js';
import * as geo from './geo.js';
import * as label from './label.js';
import * as shape from './shape.js';
import { goInt, go2Max } from './gomath.js';
import { Dispatcher } from './vendor/elk.js';

// ---- the ELK JSON graph (the Go structs and their JSON tags; encoding/json's omitempty rules are in toJSON) ----

/** Go's zero-value omission of `omitempty`: 0, "", false, nil and empty slices are left out. */
const isZero = (v) => v === 0 || v === '' || v === false || v === null || v === undefined || (Array.isArray(v) && v.length === 0);

class ELKNode {
  constructor(init = {}) {
    this.id = '';
    this.x = 0;
    this.y = 0;
    this.width = 0;
    this.height = 0;
    this.children = [];
    this.ports = [];
    this.labels = [];
    this.layoutOptions = null;
    Object.assign(this, init);
  }

  toJSON() {
    const o = { id: this.id, x: this.x, y: this.y, width: this.width, height: this.height };
    if (!isZero(this.children)) o.children = this.children;
    if (!isZero(this.ports)) o.ports = this.ports;
    if (!isZero(this.labels)) o.labels = this.labels;
    if (this.layoutOptions !== null) o.layoutOptions = this.layoutOptions;
    return o;
  }
}

class ELKPort {
  constructor(init = {}) {
    this.id = '';
    this.x = 0;
    this.y = 0;
    this.width = 0;
    this.height = 0;
    this.layoutOptions = null;
    Object.assign(this, init);
  }

  toJSON() {
    const o = { id: this.id, x: this.x, y: this.y, width: this.width, height: this.height };
    if (this.layoutOptions !== null) o.layoutOptions = this.layoutOptions;
    return o;
  }
}

class ELKLabel {
  constructor(init = {}) {
    this.text = '';
    this.x = 0;
    this.y = 0;
    this.width = 0;
    this.height = 0;
    this.layoutOptions = null;
    Object.assign(this, init);
  }

  toJSON() {
    const o = { text: this.text, x: this.x, y: this.y, width: this.width, height: this.height };
    if (this.layoutOptions !== null) o.layoutOptions = this.layoutOptions;
    return o;
  }
}

class ELKEdge {
  constructor(init = {}) {
    this.id = '';
    this.sources = null;
    this.targets = null;
    this.sections = [];
    this.labels = [];
    this.container = '';
    Object.assign(this, init);
  }

  toJSON() {
    const o = { id: this.id, sources: this.sources, targets: this.targets };
    if (!isZero(this.sections)) o.sections = this.sections;
    if (!isZero(this.labels)) o.labels = this.labels;
    o.container = this.container;
    return o;
  }
}

class ELKGraph {
  constructor(init = {}) {
    this.id = '';
    this.layoutOptions = null;
    this.children = [];
    this.edges = [];
    Object.assign(this, init);
  }

  toJSON() {
    const o = { id: this.id, layoutOptions: this.layoutOptions };
    if (!isZero(this.children)) o.children = this.children;
    if (!isZero(this.edges)) o.edges = this.edges;
    return o;
  }
}

export const South = 'SOUTH';
export const North = 'NORTH';
export const East = 'EAST';
export const West = 'WEST';

export const Down = 'DOWN';
export const Up = 'UP';
export const Right = 'RIGHT';
export const Left = 'LEFT';

/**
 * ConfigurableOpts: { algorithm, nodeSpacing, padding, edgeNodeSpacing, selfLoopSpacing } (Go field names, camelCase), JSON tags
 * elk.algorithm, spacing.nodeNodeBetweenLayers, elk.padding, spacing.edgeNodeBetweenLayers, elk.spacing.nodeSelfLoop.
 */
class ConfigurableOpts {
  constructor(init = {}) {
    this.algorithm = '';
    this.nodeSpacing = 0;
    this.padding = '';
    this.edgeNodeSpacing = 0;
    this.selfLoopSpacing = 0;
    Object.assign(this, init);
  }
}

export const DefaultOpts = new ConfigurableOpts({
  algorithm: 'layered',
  nodeSpacing: 70.0,
  padding: '[top=50,left=50,bottom=50,right=50]',
  edgeNodeSpacing: 40.0,
  selfLoopSpacing: 50.0,
});

/**
 * HydrateOpts of d2plugin's elk plugin: the options as JSON with the Go tags (what `--elk-algorithm`, `--elk-nodeNodeBetweenLayers`,
 * `--elk-padding`, `--elk-edgeNodeBetweenLayers`, `--elk-nodeSelfLoop` set). Fields that are left out are Go zero values (json.Unmarshal into a
 * zero ConfigurableOpts), not the defaults.
 */
export function hydrateOpts(opts) {
  if (opts === null || opts === undefined) return null;
  const o = new ConfigurableOpts();
  const num = (v, name) => {
    if (typeof v !== 'number' || !Number.isInteger(v)) throw new Error(`non-ELK layout options given for ELK`);
    return v;
  };
  if ('elk.algorithm' in opts) o.algorithm = String(opts['elk.algorithm']);
  if ('spacing.nodeNodeBetweenLayers' in opts) o.nodeSpacing = num(opts['spacing.nodeNodeBetweenLayers']);
  if ('elk.padding' in opts) o.padding = String(opts['elk.padding']);
  if ('spacing.edgeNodeBetweenLayers' in opts) o.edgeNodeSpacing = num(opts['spacing.edgeNodeBetweenLayers']);
  if ('elk.spacing.nodeSelfLoop' in opts) o.selfLoopSpacing = num(opts['elk.spacing.nodeSelfLoop']);
  return o;
}

class ElkOpts {
  constructor(init = {}) {
    this.edgeNode = 0;
    this.fixedAlignment = '';
    this.thoroughness = 0;
    this.edgeEdgeBetweenLayersSpacing = 0;
    this.direction = '';
    this.hierarchyHandling = '';
    this.inlineEdgeLabels = false;
    this.forceNodeModelOrder = false;
    this.considerModelOrder = '';
    this.cycleBreakingStrategy = '';

    this.selfLoopDistribution = '';

    this.nodeSizeConstraints = '';
    this.contentAlignment = '';
    this.nodeSizeMinimum = '';

    this.portSide = '';
    this.portConstraints = '';

    this.ConfigurableOpts = new ConfigurableOpts();
    const { ConfigurableOpts: c, ...rest } = init;
    Object.assign(this, rest);
    if (c !== undefined) this.ConfigurableOpts = c;
  }

  toJSON() {
    const o = {};
    if (this.edgeNode !== 0) o['elk.spacing.edgeNode'] = this.edgeNode;
    if (this.fixedAlignment !== '') o['elk.layered.nodePlacement.bk.fixedAlignment'] = this.fixedAlignment;
    if (this.thoroughness !== 0) o['elk.layered.thoroughness'] = this.thoroughness;
    if (this.edgeEdgeBetweenLayersSpacing !== 0) o['elk.layered.spacing.edgeEdgeBetweenLayers'] = this.edgeEdgeBetweenLayersSpacing;
    o['elk.direction'] = this.direction;
    if (this.hierarchyHandling !== '') o['elk.hierarchyHandling'] = this.hierarchyHandling;
    if (this.inlineEdgeLabels) o['elk.edgeLabels.inline'] = this.inlineEdgeLabels;
    if (this.forceNodeModelOrder) o['elk.layered.crossingMinimization.forceNodeModelOrder'] = this.forceNodeModelOrder;
    if (this.considerModelOrder !== '') o['elk.layered.considerModelOrder.strategy'] = this.considerModelOrder;
    if (this.cycleBreakingStrategy !== '') o['elk.layered.cycleBreaking.strategy'] = this.cycleBreakingStrategy;

    if (this.selfLoopDistribution !== '') o['elk.layered.edgeRouting.selfLoopDistribution'] = this.selfLoopDistribution;

    if (this.nodeSizeConstraints !== '') o['elk.nodeSize.constraints'] = this.nodeSizeConstraints;
    if (this.contentAlignment !== '') o['elk.contentAlignment'] = this.contentAlignment;
    if (this.nodeSizeMinimum !== '') o['elk.nodeSize.minimum'] = this.nodeSizeMinimum;

    if (this.portSide !== '') o['elk.port.side'] = this.portSide;
    if (this.portConstraints !== '') o['elk.portConstraints'] = this.portConstraints;

    const c = this.ConfigurableOpts;
    if (c.algorithm !== '') o['elk.algorithm'] = c.algorithm;
    if (c.nodeSpacing !== 0) o['spacing.nodeNodeBetweenLayers'] = c.nodeSpacing;
    if (c.padding !== '') o['elk.padding'] = c.padding;
    if (c.edgeNodeSpacing !== 0) o['spacing.edgeNodeBetweenLayers'] = c.edgeNodeSpacing;
    o['elk.spacing.nodeSelfLoop'] = c.selfLoopSpacing;
    return o;
  }
}

const port_spacing = 40.;
const edge_node_spacing = 40;

// ---- graph stats ----

/**
 * elkGraphStats contains the D2-specific graph-wide measurements used while
 * adapting a graph to ELK. Keeping them here avoids rescanning every edge for
 * every object and container.
 */
class ElkGraphStats {
  constructor() {
    this.degrees = new Map(); // object -> {incoming, outgoing}
    this.selfLoopLabelMax = new Map(); // object -> {width, height}
  }

  maxSelfLoopLabel(parent, isWidth) {
    const size = this.selfLoopLabelMax.get(parent) || { width: 0, height: 0 };
    if (isWidth) return size.width;
    return size.height;
  }
}

function collectELKGraphStats(g) {
  const stats = new ElkGraphStats();
  for (const edge of g.edges || []) {
    const srcDegree = stats.degrees.get(edge.src) || { incoming: 0, outgoing: 0 };
    srcDegree.outgoing++;
    stats.degrees.set(edge.src, srcDegree);

    const dstDegree = stats.degrees.get(edge.dst) || { incoming: 0, outgoing: 0 };
    dstDegree.incoming++;
    stats.degrees.set(edge.dst, dstDegree);

    if (edge.src !== edge.dst || edge.attributes.label.value === '' || edge.src.parent === null) continue;
    const parent = edge.src.parent;
    const labelSize = stats.selfLoopLabelMax.get(parent) || { width: 0, height: 0 };
    labelSize.width = go2Max(labelSize.width, edge.attributes.labelDimensions.width);
    labelSize.height = go2Max(labelSize.height, edge.attributes.labelDimensions.height);
    stats.selfLoopLabelMax.set(parent, labelSize);
  }
  return stats;
}

function newRootLayoutOptions(opts) {
  return new ElkOpts({
    thoroughness: 8,
    edgeEdgeBetweenLayersSpacing: 50,
    edgeNode: edge_node_spacing,
    hierarchyHandling: 'INCLUDE_CHILDREN',
    fixedAlignment: 'BALANCED',
    considerModelOrder: 'NODES_AND_EDGES',
    cycleBreakingStrategy: 'GREEDY_MODEL_ORDER',
    nodeSizeConstraints: 'MINIMUM_SIZE',
    contentAlignment: 'H_CENTER V_CENTER',
    ConfigurableOpts: new ConfigurableOpts({
      algorithm: opts.algorithm,
      nodeSpacing: opts.nodeSpacing,
      edgeNodeSpacing: opts.edgeNodeSpacing,
      selfLoopSpacing: opts.selfLoopSpacing,
    }),
  });
}

function newContainerLayoutOptions(opts) {
  return new ElkOpts({
    thoroughness: 8,
    edgeEdgeBetweenLayersSpacing: 50,
    hierarchyHandling: 'INCLUDE_CHILDREN',
    fixedAlignment: 'BALANCED',
    edgeNode: edge_node_spacing,
    // ELK 0.12 crashes on compound subgraphs when model-order
    // processing is enabled below the root. Keep it disabled there.
    considerModelOrder: 'NONE',
    cycleBreakingStrategy: 'GREEDY',
    nodeSizeConstraints: 'MINIMUM_SIZE',
    contentAlignment: 'H_CENTER V_CENTER',
    ConfigurableOpts: new ConfigurableOpts({
      nodeSpacing: opts.nodeSpacing,
      edgeNodeSpacing: opts.edgeNodeSpacing,
      selfLoopSpacing: opts.selfLoopSpacing,
      padding: opts.padding,
    }),
  });
}

// ---- the engine (elk-go's LayoutJSON, here ELK.js's dispatcher) ----

let dispatcher = null;
let lastMessage = null;

/** The ELK constructor of elkjs registers these on creation; ELK's core algorithms (fixed, box, random) are always there. */
const ALGORITHMS = ['layered', 'stress', 'mrtree', 'radial', 'force', 'sporeOverlap', 'sporeCompaction', 'rectpacking'];

function dispatch(msg) {
  if (dispatcher === null) {
    dispatcher = new Dispatcher({ postMessage: (m) => { lastMessage = m; } });
    dispatcher.saveDispatch({ data: { id: 0, cmd: 'register', algorithms: ALGORITHMS } });
    if (lastMessage !== null && lastMessage.error !== undefined) {
      const err = lastMessage.error;
      dispatcher = null;
      throw err;
    }
  }
  lastMessage = null;
  dispatcher.saveDispatch({ data: msg });
  return lastMessage;
}

/** a GWT exception (a Java Throwable or a JS error) as text */
function errorText(err) {
  if (err instanceof Error) return err.message;
  if (err !== null && typeof err === 'object') {
    try {
      const s = String(err);
      if (s !== '[object Object]') return s;
    } catch (e) { /* fall through */ }
    if (err.message !== undefined) return String(err.message);
  }
  return String(err);
}

let observer = null;

/** For the test harness (tools/d2ref/elkcmp.mjs): fn(rawGraphJSON, layoutAnswerOrNull, errorTextOrNull) is called for every ELK layout; null removes it. */
export function setObserver(fn) {
  observer = fn;
}

/** elk.LayoutJSON on an already marshalled graph: the parsed JSON graph with its layout (computed in place) */
function layoutJSON(raw) {
  const graph = JSON.parse(raw);
  const res = dispatch({ id: 1, cmd: 'layout', graph, layoutOptions: {}, options: {} });
  if (res === null) throw new Error('layout ELK graph: no answer');
  if (res.error !== undefined) {
    if (observer !== null) observer(raw, null, errorText(res.error));
    throw new Error(`layout ELK graph: ${errorText(res.error)}`);
  }
  if (observer !== null) observer(raw, res.data, null);
  return res.data;
}

/** json.Marshal refuses NaN and Inf */
function marshal(v) {
  return JSON.stringify(v, (_, x) => {
    if (typeof x === 'number' && !Number.isFinite(x)) {
      throw new Error(`json: unsupported value: ${Number.isNaN(x) ? 'NaN' : x > 0 ? '+Inf' : '-Inf'}`);
    }
    return x;
  });
}

// ---- Layout ----

/** DefaultLayout */
export function defaultLayout(g) {
  return layout(g, null);
}

/**
 * Layout runs ELK on the graph g. opts is a ConfigurableOpts (see hydrateOpts) or null for the defaults.
 * @returns {void} throws Error('failed to ELK layout: ...') on failure (as Go wraps its error)
 */
export function layout(g, opts) {
  try {
    layout_(g, opts);
  } catch (e) {
    if (e && e.name === 'NeedLatex') throw e;
    const err = new Error(`failed to ELK layout: ${e && e.message !== undefined ? e.message : e}`);
    err.cause = e;
    throw err;
  }
}

function layout_(g, opts) {
  if (opts === null || opts === undefined) opts = DefaultOpts;
  const graphStats = collectELKGraphStats(g);

  const elkGraph = new ELKGraph({
    id: '',
    layoutOptions: newRootLayoutOptions(opts),
  });
  if (elkGraph.layoutOptions.ConfigurableOpts.selfLoopSpacing === DefaultOpts.selfLoopSpacing) {
    // +5 for a tiny bit of padding
    elkGraph.layoutOptions.ConfigurableOpts.selfLoopSpacing = go2Max(elkGraph.layoutOptions.ConfigurableOpts.selfLoopSpacing, Math.trunc(graphStats.maxSelfLoopLabel(g.root, g.root.attributes.direction.value === 'down' || g.root.attributes.direction.value === '' || g.root.attributes.direction.value === 'up') / 2) + 5);
  }
  switch (g.root.attributes.direction.value) {
    case 'down':
      elkGraph.layoutOptions.direction = Down;
      break;
    case 'up':
      elkGraph.layoutOptions.direction = Up;
      break;
    case 'right':
      elkGraph.layoutOptions.direction = Right;
      break;
    case 'left':
      elkGraph.layoutOptions.direction = Left;
      break;
    default:
      elkGraph.layoutOptions.direction = Down;
  }

  // set label and icon positions for ELK
  for (const obj of g.objects || []) positionLabelsIcons(obj);

  const adjustments = new Map();
  const elkNodes = new Map();
  const elkEdges = new Map();

  // BFS
  const walk = (obj, parent, fn) => {
    if (obj.parent !== null) fn(obj, parent);
    for (const ch of obj.childrenArray || []) walk(ch, obj, fn);
  };

  walk(g.root, null, (obj, parent) => {
    const degree = graphStats.degrees.get(obj) || { incoming: 0, outgoing: 0 };
    const incoming = degree.incoming;
    const outgoing = degree.outgoing;
    if (incoming >= 2 || outgoing >= 2) {
      switch (g.root.attributes.direction.value) {
        case 'right': case 'left':
          if (obj.attributes.heightAttr === null) {
            obj.box.Height = Math.max(obj.box.Height, Math.max(incoming, outgoing) * port_spacing);
          }
          break;
        default:
          if (obj.attributes.widthAttr === null) {
            obj.box.Width = Math.max(obj.box.Width, Math.max(incoming, outgoing) * port_spacing);
          }
      }
    }

    if (obj.hasLabel() && obj.hasIcon()) {
      // this gives shapes extra height for their label if they also have an icon
      obj.box.Height += obj.attributes.labelDimensions.height + label.PADDING;
    }

    const [margin] = obj.spacingOpt(label.PADDING, label.PADDING, false);
    const width = margin.Left + obj.box.Width + margin.Right;
    const height = margin.Top + obj.box.Height + margin.Bottom;
    adjustments.set(obj, margin);

    const n = new ELKNode({
      id: obj.absID(),
      width,
      height,
    });

    if ((obj.childrenArray || []).length > 0) {
      n.layoutOptions = newContainerLayoutOptions(opts);
      if (n.layoutOptions.ConfigurableOpts.selfLoopSpacing === DefaultOpts.selfLoopSpacing) {
        n.layoutOptions.ConfigurableOpts.selfLoopSpacing = go2Max(n.layoutOptions.ConfigurableOpts.selfLoopSpacing, Math.trunc(graphStats.maxSelfLoopLabel(obj, g.root.attributes.direction.value === 'down' || g.root.attributes.direction.value === '' || g.root.attributes.direction.value === 'up') / 2) + 5);
      }

      switch (elkGraph.layoutOptions.direction) {
        case Down: case Up:
          n.layoutOptions.nodeSizeMinimum = `(${goInt(Math.ceil(height))}, ${goInt(Math.ceil(width))})`;
          break;
        case Right: case Left:
          n.layoutOptions.nodeSizeMinimum = `(${goInt(Math.ceil(width))}, ${goInt(Math.ceil(height))})`;
          break;
      }
    } else {
      n.layoutOptions = new ElkOpts({
        selfLoopDistribution: 'EQUALLY',
      });
    }

    if (obj.isContainer()) {
      let padding = parsePadding(opts.padding);
      padding = adjustPadding(obj, width, height, padding);
      n.layoutOptions.ConfigurableOpts.padding = paddingString(padding);
    }

    if (obj.hasLabel()) {
      n.labels.push(new ELKLabel({
        text: obj.attributes.label.value,
        width: obj.attributes.labelDimensions.width,
        height: obj.attributes.labelDimensions.height,
      }));
    }

    if (parent === g.root) {
      elkGraph.children.push(n);
    } else {
      elkNodes.get(parent).children.push(n);
    }

    if (obj.sqlTable !== null) {
      n.layoutOptions.portConstraints = 'FIXED_POS';
      const columns = obj.sqlTable.columns || [];
      const colHeight = n.height / (columns.length + 1);
      n.ports = [];
      let srcSide, dstSide;
      switch (elkGraph.layoutOptions.direction) {
        case Left:
          srcSide = West; dstSide = East;
          break;
        default:
          srcSide = East; dstSide = West;
      }
      columns.forEach((col, i) => {
        n.ports.push(new ELKPort({
          id: srcPortID(obj, col.name.label),
          y: (i + 1) * colHeight + colHeight / 2,
          layoutOptions: new ElkOpts({ portSide: srcSide }),
        }));
        n.ports.push(new ELKPort({
          id: dstPortID(obj, col.name.label),
          y: (i + 1) * colHeight + colHeight / 2,
          layoutOptions: new ElkOpts({ portSide: dstSide }),
        }));
      });
    }

    elkNodes.set(obj, n);
  });

  let srcSide, dstSide;
  switch (elkGraph.layoutOptions.direction) {
    case Up:
      srcSide = North; dstSide = South;
      break;
    default:
      srcSide = South; dstSide = North;
  }

  // ports of an object on a side: the key is Go's struct{obj, side}
  const ports = new Map();
  const portsAppend = (obj, side, p) => {
    let sides = ports.get(obj);
    if (sides === undefined) ports.set(obj, sides = new Map());
    let list = sides.get(side);
    if (list === undefined) sides.set(side, list = []);
    list.push(p);
  };

  (g.edges || []).forEach((edge, ei) => {
    let src, dst;

    if (edge.srcTableColumnIndex !== null) {
      src = srcPortID(edge.src, edge.src.sqlTable.columns[edge.srcTableColumnIndex].name.label);
    } else if (edge.src.sqlTable !== null) {
      const p = new ELKPort({
        id: `${srcPortID(edge.src, '__root__')}.${ei}`,
        layoutOptions: new ElkOpts({ portSide: srcSide }),
      });
      src = p.id;
      elkNodes.get(edge.src).ports.push(p);
      portsAppend(edge.src, srcSide, p);
    } else {
      src = edge.src.absID();
    }

    if (edge.dstTableColumnIndex !== null) {
      dst = dstPortID(edge.dst, edge.dst.sqlTable.columns[edge.dstTableColumnIndex].name.label);
    } else if (edge.dst.sqlTable !== null) {
      const p = new ELKPort({
        id: `${dstPortID(edge.dst, '__root__')}.${ei}`,
        layoutOptions: new ElkOpts({ portSide: dstSide }),
      });
      dst = p.id;
      elkNodes.get(edge.dst).ports.push(p);
      portsAppend(edge.dst, dstSide, p);
    } else {
      dst = edge.dst.absID();
    }

    const e = new ELKEdge({
      id: edge.absID(),
      sources: [src],
      targets: [dst],
    });
    if (edge.attributes.label.value !== '') {
      e.labels.push(new ELKLabel({
        text: edge.attributes.label.value,
        width: edge.attributes.labelDimensions.width,
        height: edge.attributes.labelDimensions.height,
        layoutOptions: new ElkOpts({
          inlineEdgeLabels: true,
        }),
      }));
    }
    elkGraph.edges.push(e);
    elkEdges.set(edge, e);
  });

  for (const [obj, sides] of ports) {
    for (const [, list] of sides) {
      const width = elkNodes.get(obj).width;
      const spacing = width / (list.length + 1);
      list.forEach((p, i) => {
        p.x = (i + 1) * spacing;
      });
    }
  }

  const raw = marshal(elkGraph);

  let jsonOut;
  try {
    jsonOut = layoutJSON(raw);
  } catch (e) {
    throw new Error(`native ELK layout failed: ${e.message}`);
  }

  // json.Unmarshal(jsonOut, &elkGraph): the answer overwrites what it carries (position, size, edge sections) in the structures built above
  unmarshalLayout(elkGraph, jsonOut);

  const byID = new Map();
  walk(g.root, null, (obj, parent) => {
    const n = elkNodes.get(obj);

    let parentX = 0.0;
    let parentY = 0.0;
    if (parent !== null && parent !== g.root) {
      parentX = parent.box.TopLeft.x;
      parentY = parent.box.TopLeft.y;
    }
    obj.box.TopLeft = geo.newPoint(parentX + n.x, parentY + n.y);
    obj.box.Width = Math.ceil(n.width);
    obj.box.Height = Math.ceil(n.height);

    byID.set(obj.absID(), obj);
  });

  for (const edge of g.edges || []) {
    const e = elkEdges.get(edge);

    let parentX = 0.0;
    let parentY = 0.0;
    if (e.container !== '') {
      parentX = byID.get(e.container).box.TopLeft.x;
      parentY = byID.get(e.container).box.TopLeft.y;
    }

    const points = [];
    for (const s of e.sections || []) {
      points.push(new geo.Point(parentX + s.startPoint.x, parentY + s.startPoint.y));
      for (const bp of s.bendPoints || []) {
        points.push(new geo.Point(parentX + bp.x, parentY + bp.y));
      }
      points.push(new geo.Point(parentX + s.endPoint.x, parentY + s.endPoint.y));
    }
    edge.route = points;
  }

  const objEdges = new Map();
  for (const e of g.edges || []) {
    if (!objEdges.has(e.src)) objEdges.set(e.src, []);
    objEdges.get(e.src).push(e);
    if (e.dst !== e.src) {
      if (!objEdges.has(e.dst)) objEdges.set(e.dst, []);
      objEdges.get(e.dst).push(e);
    }
  }
  const descendantShifter = newDescendantShifter(g);

  for (const obj of g.objects || []) {
    if (adjustments.has(obj)) {
      const margin = adjustments.get(obj);
      const edges = objEdges.get(obj) || [];
      // also move edges with the shrinking sides
      if (margin.Left > 0) {
        for (const e of edges) {
          const l = e.route.length;
          if (e.src === obj && e.route[0].x === obj.box.TopLeft.x) {
            e.route[0].x += margin.Left;
          }
          if (e.dst === obj && e.route[l - 1].x === obj.box.TopLeft.x) {
            e.route[l - 1].x += margin.Left;
          }
        }
        obj.box.TopLeft.x += margin.Left;
        descendantShifter.shift(obj, margin.Left / 2, 0);
        obj.box.Width -= margin.Left;
      }
      if (margin.Right > 0) {
        for (const e of edges) {
          const l = e.route.length;
          if (e.src === obj && e.route[0].x === obj.box.TopLeft.x + obj.box.Width) {
            e.route[0].x -= margin.Right;
          }
          if (e.dst === obj && e.route[l - 1].x === obj.box.TopLeft.x + obj.box.Width) {
            e.route[l - 1].x -= margin.Right;
          }
        }
        descendantShifter.shift(obj, -margin.Right / 2, 0);
        obj.box.Width -= margin.Right;
      }
      if (margin.Top > 0) {
        for (const e of edges) {
          const l = e.route.length;
          if (e.src === obj && e.route[0].y === obj.box.TopLeft.y) {
            e.route[0].y += margin.Top;
          }
          if (e.dst === obj && e.route[l - 1].y === obj.box.TopLeft.y) {
            e.route[l - 1].y += margin.Top;
          }
        }
        obj.box.TopLeft.y += margin.Top;
        descendantShifter.shift(obj, 0, margin.Top / 2);
        obj.box.Height -= margin.Top;
      }
      if (margin.Bottom > 0) {
        for (const e of edges) {
          const l = e.route.length;
          if (e.src === obj && e.route[0].y === obj.box.TopLeft.y + obj.box.Height) {
            e.route[0].y -= margin.Bottom;
          }
          if (e.dst === obj && e.route[l - 1].y === obj.box.TopLeft.y + obj.box.Height) {
            e.route[l - 1].y -= margin.Bottom;
          }
        }
        descendantShifter.shift(obj, 0, -margin.Bottom / 2);
        obj.box.Height -= margin.Bottom;
      }
    }
  }

  for (const edge of g.edges || []) {
    let points = edge.route;

    let startIndex = 0, endIndex = points.length - 1;
    const start = points[startIndex];
    const end = points[endIndex];

    let originalSrcTL = null, originalDstTL = null;
    // if the edge passes through 3d/multiple, use the offset box for tracing to border
    const [srcDx, srcDy] = edge.src.getModifierElementAdjustments();
    if (srcDx !== 0 || srcDy !== 0) {
      if (start.x > edge.src.box.TopLeft.x + srcDx &&
        start.y < edge.src.box.TopLeft.y + edge.src.box.Height - srcDy) {
        originalSrcTL = edge.src.box.TopLeft.copy();
        edge.src.box.TopLeft.x += srcDx;
        edge.src.box.TopLeft.y -= srcDy;
      }
    }
    const [dstDx, dstDy] = edge.dst.getModifierElementAdjustments();
    if (dstDx !== 0 || dstDy !== 0) {
      if (end.x > edge.dst.box.TopLeft.x + dstDx &&
        end.y < edge.dst.box.TopLeft.y + edge.dst.box.Height - dstDy) {
        originalDstTL = edge.dst.box.TopLeft.copy();
        edge.dst.box.TopLeft.x += dstDx;
        edge.dst.box.TopLeft.y -= dstDy;
      }
    }

    [startIndex, endIndex] = edge.traceToShape(points, startIndex, endIndex);
    points = points.slice(startIndex, endIndex + 1);

    if (edge.attributes.label.value !== '') {
      edge.labelPosition = label.positionString(label.InsideMiddleCenter);
    }

    edge.route = points;

    // undo 3d/multiple offset
    if (originalSrcTL !== null) {
      edge.src.box.TopLeft.x = originalSrcTL.x;
      edge.src.box.TopLeft.y = originalSrcTL.y;
    }
    if (originalDstTL !== null) {
      edge.dst.box.TopLeft.x = originalDstTL.x;
      edge.dst.box.TopLeft.y = originalDstTL.y;
    }
  }

  deleteBends(g);
  deconflictSelfLoopLabels(g);
}

/**
 * json.Unmarshal of the layout answer into the structures the graph was built from: node x/y/width/height, edge sections and container.
 * (Children, edges and sections come back in the order they went in.)
 */
function unmarshalLayout(elkGraph, out) {
  const num = (v, old) => (typeof v === 'number' ? v : old);
  const nodes = (list, outList) => {
    (list || []).forEach((n, i) => {
      const o = (outList || [])[i];
      if (o === undefined || o === null) return;
      n.x = num(o.x, n.x);
      n.y = num(o.y, n.y);
      n.width = num(o.width, n.width);
      n.height = num(o.height, n.height);
      nodes(n.children, o.children);
    });
  };
  nodes(elkGraph.children, out.children);
  (elkGraph.edges || []).forEach((e, i) => {
    const o = (out.edges || [])[i];
    if (o === undefined || o === null) return;
    if (Array.isArray(o.sections)) e.sections = o.sections;
    if (typeof o.container === 'string') e.container = o.container;
  });
}

function srcPortID(obj, column) {
  return `${obj.absID()}.${column}.src`;
}

function dstPortID(obj, column) {
  return `${obj.absID()}.${column}.dst`;
}

/**
 * deconflictSelfLoopLabels keeps the usual centered label position unless two
 * labels on self loops around the same object materially overlap. Newer ELK
 * versions can place multiple fixed-port loops on the same side of an object,
 * making both route midpoints coincide. Moving only the later label preserves
 * the routed geometry and existing output for non-overlapping loops.
 */
function deconflictSelfLoopLabels(g) {
  const materialOverlap = label.PADDING;
  const candidatePercentages = [0.4, 0.6, 0.3, 0.7, 0.2, 0.8, 0.1, 0.9];

  const placedByObject = new Map();
  for (const edge of g.edges || []) {
    if (edge.src !== edge.dst || edge.attributes.label.value === '' || edge.labelPosition === null || edge.route.length < 2) {
      continue;
    }

    const position = label.fromString(edge.labelPosition);
    let percentage = 0.0;
    if (edge.labelPercentage !== null) {
      percentage = edge.labelPercentage;
    }
    let box = edgeLabelBox(edge, position, percentage);
    if (box === null) {
      continue;
    }

    const placed = placedByObject.get(edge.src) || [];
    if (materiallyOverlapsAny(box, placed, materialOverlap)) {
      for (const candidate of candidatePercentages) {
        const candidateBox = edgeLabelBox(edge, label.UnlockedMiddle, candidate);
        if (candidateBox === null || overlapsAny(candidateBox, placed)) {
          continue;
        }
        edge.labelPosition = label.positionString(label.UnlockedMiddle);
        edge.labelPercentage = candidate;
        box = candidateBox;
        break;
      }
    }
    placedByObject.set(edge.src, [...placed, box]);
  }
}

function edgeLabelBox(edge, position, percentage) {
  const [topLeft] = label.getPointOnRoute(
    position,
    edge.route,
    0,
    percentage,
    edge.attributes.labelDimensions.width,
    edge.attributes.labelDimensions.height,
  );
  if (topLeft === null || topLeft === undefined) {
    return null;
  }
  return geo.newBox(topLeft, edge.attributes.labelDimensions.width, edge.attributes.labelDimensions.height);
}

function materiallyOverlapsAny(box, others, minimum) {
  for (const other of others) {
    const overlapWidth = Math.min(box.TopLeft.x + box.Width, other.TopLeft.x + other.Width) - Math.max(box.TopLeft.x, other.TopLeft.x);
    const overlapHeight = Math.min(box.TopLeft.y + box.Height, other.TopLeft.y + other.Height) - Math.max(box.TopLeft.y, other.TopLeft.y);
    if (overlapWidth > minimum && overlapHeight > minimum) {
      return true;
    }
  }
  return false;
}

function overlapsAny(box, others) {
  for (const other of others) {
    if (box.overlaps(other)) {
      return true;
    }
  }
  return false;
}

/**
 * deleteBends is a shim for ELK to delete unnecessary bends
 * see https://github.com/terrastruct/d2/issues/1030
 */
function deleteBends(g) {
  let hasCandidate = false;
  for (const edge of g.edges || []) {
    if (edge.src !== edge.dst && edge.route.length >= 4) {
      hasCandidate = true;
      break;
    }
  }
  if (!hasCandidate) {
    return;
  }
  const collisionIndex = newBendCollisionIndex(g);

  // Get rid of S-shapes at the source and the target
  // TODO there might be value in repeating this. removal of an S shape introducing another S shape that can still be removed
  for (const isSource of [true, false]) {
    for (let ei = 0; ei < g.edges.length; ei++) {
      const e = g.edges[ei];
      if (e.route.length < 4) {
        continue;
      }
      if (e.src === e.dst) {
        continue;
      }
      let endpoint;
      let start;
      let corner;
      let end;

      let columnIndex;
      if (isSource) {
        start = e.route[0];
        corner = e.route[1];
        end = e.route[2];
        endpoint = e.src;
        columnIndex = e.srcTableColumnIndex;
      } else {
        start = e.route[e.route.length - 1];
        corner = e.route[e.route.length - 2];
        end = e.route[e.route.length - 3];
        endpoint = e.dst;
        columnIndex = e.dstTableColumnIndex;
      }

      const isHorizontal = Math.ceil(start.y) === Math.ceil(corner.y);
      const [dx, dy] = endpoint.getModifierElementAdjustments();

      // Make sure it's still attached
      if (columnIndex !== null) {
        const rowHeight = endpoint.box.Height / (endpoint.sqlTable.columns.length + 1);
        const rowCenter = endpoint.box.TopLeft.y + rowHeight * (columnIndex + 1) + rowHeight / 2;

        // for row connections new Y coordinate should be within 1/3 row height from the row center
        if (Math.abs(end.y - rowCenter) > rowHeight / 3) {
          continue;
        }
      } else if (isHorizontal) {
        if (end.y <= endpoint.box.TopLeft.y + 10 - dy) {
          continue;
        }
        if (end.y >= endpoint.box.TopLeft.y + endpoint.box.Height - 10) {
          continue;
        }
      } else {
        if (end.x <= endpoint.box.TopLeft.x + 10) {
          continue;
        }
        if (end.x >= endpoint.box.TopLeft.x + endpoint.box.Width - 10 + dx) {
          continue;
        }
      }

      let newStart;
      if (isHorizontal) {
        newStart = geo.newPoint(start.x, end.y);
      } else {
        newStart = geo.newPoint(end.x, start.y);
      }

      const endpointShape = shape.newShape(d2target.DSL_SHAPE_TO_SHAPE_TYPE[endpoint.attributes.shape.value.toLowerCase()], endpoint.box);
      newStart = shape.traceToShapeBorder(endpointShape, newStart, end);

      // Check that the new segment doesn't collide with anything new

      const oldSegment = geo.newSegment(start, corner);
      const newSegment = geo.newSegment(newStart, end);

      const oldIntersects = collisionIndex.countObjectIntersects(e.src, e.dst, oldSegment);
      const newIntersects = collisionIndex.countObjectIntersects(e.src, e.dst, newSegment);

      if (newIntersects > oldIntersects) {
        continue;
      }

      const [oldCrossingsCount, oldOverlapsCount, oldCloseOverlapsCount, oldTouchingCount] = collisionIndex.countEdgeIntersects(g.edges[ei], oldSegment);
      const [newCrossingsCount, newOverlapsCount, newCloseOverlapsCount, newTouchingCount] = collisionIndex.countEdgeIntersects(g.edges[ei], newSegment);

      if (newCrossingsCount > oldCrossingsCount) {
        continue;
      }
      if (newOverlapsCount > oldOverlapsCount) {
        continue;
      }

      if (newCloseOverlapsCount > oldCloseOverlapsCount) {
        continue;
      }
      if (newTouchingCount > oldTouchingCount) {
        continue;
      }

      // commit
      if (isSource) {
        g.edges[ei].route = [newStart, ...e.route.slice(3)];
      } else {
        g.edges[ei].route = [...e.route.slice(0, e.route.length - 3), newStart];
      }
      collisionIndex.updateEdge(g.edges[ei]);
    }
  }

  // Get rid of ladders
  // ELK likes to do these for some reason
  // .   ┌─
  // . ┌─┘
  // . │
  // We want to transform these into L-shapes

  // Go's map[geo.Point]int: points are compared by value
  const pointKey = (p) => `${p.x},${p.y}`;
  const points = new Map();
  for (const e of g.edges) {
    for (const p of e.route) {
      points.set(pointKey(p), (points.get(pointKey(p)) || 0) + 1);
    }
  }

  for (let ei = 0; ei < g.edges.length; ei++) {
    const e = g.edges[ei];
    if (e.route.length < 6) {
      continue;
    }
    if (e.src === e.dst) {
      continue;
    }

    for (let i = 1; i < e.route.length - 3; i++) {
      const before = e.route[i - 1];
      const start = e.route[i];
      const corner = e.route[i + 1];
      const end = e.route[i + 2];
      const after = e.route[i + 3];

      const c = points.get(pointKey(corner)) || 0;
      if (c > 1) {
        // If corner is shared with another edge, they merge
        continue;
      }

      // S-shape on sources only concerned one segment, since the other was just along the bound of endpoint
      // These concern two segments

      let newCorner;
      if (Math.ceil(start.x) === Math.ceil(corner.x)) {
        newCorner = geo.newPoint(end.x, start.y);
        // not ladder
        if ((end.x > start.x) !== (start.x > before.x)) {
          continue;
        }
        if ((end.y > start.y) !== (after.y > end.y)) {
          continue;
        }
      } else {
        newCorner = geo.newPoint(start.x, end.y);
        if ((end.y > start.y) !== (start.y > before.y)) {
          continue;
        }
        if ((end.x > start.x) !== (after.x > end.x)) {
          continue;
        }
      }

      const oldS1 = geo.newSegment(start, corner);
      const oldS2 = geo.newSegment(corner, end);

      const newS1 = geo.newSegment(start, newCorner);
      const newS2 = geo.newSegment(newCorner, end);

      // Check that the new segments doesn't collide with anything new
      const oldIntersects = collisionIndex.countObjectIntersects(e.src, e.dst, oldS1) + collisionIndex.countObjectIntersects(e.src, e.dst, oldS2);
      const newIntersects = collisionIndex.countObjectIntersects(e.src, e.dst, newS1) + collisionIndex.countObjectIntersects(e.src, e.dst, newS2);

      if (newIntersects > oldIntersects) {
        continue;
      }

      const [oldCrossingsCount1, oldOverlapsCount1, oldCloseOverlapsCount1, oldTouchingCount1] = collisionIndex.countEdgeIntersects(g.edges[ei], oldS1);
      const [oldCrossingsCount2, oldOverlapsCount2, oldCloseOverlapsCount2, oldTouchingCount2] = collisionIndex.countEdgeIntersects(g.edges[ei], oldS2);
      const oldCrossingsCount = oldCrossingsCount1 + oldCrossingsCount2;
      const oldOverlapsCount = oldOverlapsCount1 + oldOverlapsCount2;
      const oldCloseOverlapsCount = oldCloseOverlapsCount1 + oldCloseOverlapsCount2;
      const oldTouchingCount = oldTouchingCount1 + oldTouchingCount2;

      const [newCrossingsCount1, newOverlapsCount1, newCloseOverlapsCount1, newTouchingCount1] = collisionIndex.countEdgeIntersects(g.edges[ei], newS1);
      const [newCrossingsCount2, newOverlapsCount2, newCloseOverlapsCount2, newTouchingCount2] = collisionIndex.countEdgeIntersects(g.edges[ei], newS2);
      const newCrossingsCount = newCrossingsCount1 + newCrossingsCount2;
      const newOverlapsCount = newOverlapsCount1 + newOverlapsCount2;
      const newCloseOverlapsCount = newCloseOverlapsCount1 + newCloseOverlapsCount2;
      const newTouchingCount = newTouchingCount1 + newTouchingCount2;

      if (newCrossingsCount > oldCrossingsCount) {
        continue;
      }
      if (newOverlapsCount > oldOverlapsCount) {
        continue;
      }

      if (newCloseOverlapsCount > oldCloseOverlapsCount) {
        continue;
      }
      if (newTouchingCount > oldTouchingCount) {
        continue;
      }

      // commit
      g.edges[ei].route = [...e.route.slice(0, i), newCorner, ...e.route.slice(i + 3)];
      collisionIndex.updateEdge(g.edges[ei]);
      break;
    }
  }
}

// ---- padding ----

/** shapePadding: { top, left, bottom, right } (ints) */
const newShapePadding = () => ({ top: 0, left: 0, bottom: 0, right: 0 });

/** strconv.ParseInt(s, 10, 64) of a run of ASCII digits: [value, ok] (ok is false when it overflows int64) */
function parseInt64(s) {
  const v = BigInt(s);
  if (v > 9223372036854775807n) return [0, false];
  return [Number(v), true];
}

/** parse out values from elk padding string. e.g. "[top=50,left=50,bottom=50,right=50]" */
function parsePadding(input) {
  const reTop = /top=(\d+)/;
  const reLeft = /left=(\d+)/;
  const reBottom = /bottom=(\d+)/;
  const reRight = /right=(\d+)/;

  const padding = newShapePadding();

  let submatches = reTop.exec(input);
  if (submatches !== null) {
    const [i, ok] = parseInt64(submatches[1]);
    if (ok) padding.top = i;
  }

  submatches = reLeft.exec(input);
  if (submatches !== null) {
    const [i, ok] = parseInt64(submatches[1]);
    if (ok) padding.left = i;
  }

  submatches = reBottom.exec(input);
  if (submatches !== null) {
    const [i, ok] = parseInt64(submatches[1]);
    if (ok) padding.bottom = i;
  }

  submatches = reRight.exec(input);
  // Go reads submatches[1] before checking len(submatches): a padding without `right=` panics
  if (submatches === null) {
    const err = new Error('runtime error: index out of range [1] with length 0');
    err.name = 'GoPanic';
    throw err;
  }
  const [i, ok] = parseInt64(submatches[1]);
  if (ok) padding.right = i;

  return padding;
}

function paddingString(padding) {
  return `[top=${padding.top},left=${padding.left},bottom=${padding.bottom},right=${padding.right}]`;
}

function adjustPadding(obj, width, height, padding) {
  if (!obj.isContainer()) {
    return padding;
  }

  // compute extra space padding for label/icon
  let extraTop = 0, extraBottom = 0, extraLeft = 0, extraRight = 0;
  if (obj.hasLabel() && obj.labelPosition !== null) {
    const labelHeight = obj.attributes.labelDimensions.height + 2 * label.PADDING;
    const labelWidth = obj.attributes.labelDimensions.width + 2 * label.PADDING;
    switch (label.fromString(obj.labelPosition)) {
      case label.InsideTopLeft: case label.InsideTopCenter: case label.InsideTopRight:
        // Note: for corners we only add height
        extraTop = labelHeight;
        break;
      case label.InsideBottomLeft: case label.InsideBottomCenter: case label.InsideBottomRight:
        extraBottom = labelHeight;
        break;
      case label.InsideMiddleLeft:
        extraLeft = labelWidth;
        break;
      case label.InsideMiddleRight:
        extraRight = labelWidth;
        break;
    }
  }
  if (obj.hasIcon() && obj.iconPosition !== null) {
    const iconSize = d2target.MAX_ICON_SIZE + 2 * label.PADDING;
    switch (label.fromString(obj.iconPosition)) {
      case label.InsideTopLeft: case label.InsideTopCenter: case label.InsideTopRight:
        extraTop = go2Max(extraTop, iconSize);
        break;
      case label.InsideBottomLeft: case label.InsideBottomCenter: case label.InsideBottomRight:
        extraBottom = go2Max(extraBottom, iconSize);
        break;
      case label.InsideMiddleLeft:
        extraLeft = go2Max(extraLeft, iconSize);
        break;
      case label.InsideMiddleRight:
        extraRight = go2Max(extraRight, iconSize);
        break;
    }
  }

  let maxChildWidth = -Infinity, maxChildHeight = -Infinity;
  for (const c of obj.childrenArray || []) {
    if (c.box.Width > maxChildWidth) {
      maxChildWidth = c.box.Width;
    }
    if (c.box.Height > maxChildHeight) {
      maxChildHeight = c.box.Height;
    }
  }
  // We don't know exactly what the shape dimensions will be after layout, but for more accurate innerBox dimensions,
  // we add the maxChildWidth and maxChildHeight with computed additions for the innerBox calculation
  width += maxChildWidth + (extraLeft + extraRight);
  height += maxChildHeight + (extraTop + extraBottom);
  const contentBox = geo.newBox(geo.newPoint(0, 0), width, height);
  const shapeType = d2target.DSL_SHAPE_TO_SHAPE_TYPE[obj.attributes.shape.value];
  const s = shape.newShape(shapeType, contentBox);
  const innerBox = s.getInnerBox();

  // If the shape inner box + label/icon height becomes greater than the default padding, we want to use that
  //
  // ┌OUTER───────────────────────────┬────────────────────────────────────────────┐
  // │                                │                                            │
  // │  ┌INNER──────── ┬ ─────────────│───────────────────────────────────────┐    │
  // │  │              │Label Padding │                                       │    │
  // │  │      ┌LABEL─ ┴ ─────────────│───────┐┬             ┌ICON── ┬ ────┐  │    │
  // │  │      │                      │       ││             │       │     │  │    │
  // │  │      │                      │       ││Label Height │   Icon│     │  │    │
  // │  │      └──────────────────────│───────┘┴             │ Height│     │  │    │
  // │  │                             │                      └────── ┴ ────┘  │    │
  // │  │                             │                                       │    │
  // │  │                             ┴Default ELK Padding                    │    │
  // │  │   ┌CHILD────────────────────────────────────────────────────────┐   │    │
  // │  │   │                                                             │   │    │
  // │  │   │                                                             │   │    │
  // │  │   │                                                             │   │    │
  // │  │   └─────────────────────────────────────────────────────────────┘   │    │
  // │  │                                                                     │    │
  // │  └─────────────────────────────────────────────────────────────────────┘    │
  // │                                                                             │
  // └─────────────────────────────────────────────────────────────────────────────┘

  // estimated shape innerBox padding
  const innerTop = goInt(Math.ceil(innerBox.TopLeft.y));
  const innerBottom = goInt(Math.ceil(height - (innerBox.TopLeft.y + innerBox.Height)));
  const innerLeft = goInt(Math.ceil(innerBox.TopLeft.x));
  const innerRight = goInt(Math.ceil(width - (innerBox.TopLeft.x + innerBox.Width)));

  padding.top = go2Max(padding.top, innerTop + extraTop);
  padding.bottom = go2Max(padding.bottom, innerBottom + extraBottom);
  padding.left = go2Max(padding.left, innerLeft + extraLeft);
  padding.right = go2Max(padding.right, innerRight + extraRight);

  return padding;
}

function positionLabelsIcons(obj) {
  if (obj.attributes.icon !== null && obj.iconPosition === null) {
    if ((obj.childrenArray || []).length > 0) {
      obj.iconPosition = label.positionString(label.InsideTopLeft);
      if (obj.labelPosition === null) {
        obj.labelPosition = label.positionString(label.InsideTopRight);
        return;
      }
    } else if (obj.sqlTable !== null || obj.class !== null || obj.attributes.language !== '') {
      obj.iconPosition = label.positionString(label.OutsideTopLeft);
    } else {
      obj.iconPosition = label.positionString(label.InsideMiddleCenter);
    }
  }
  if (obj.hasLabel() && obj.labelPosition === null) {
    if ((obj.childrenArray || []).length > 0) {
      obj.labelPosition = label.positionString(label.InsideTopCenter);
    } else if (obj.hasOutsideBottomLabel()) {
      obj.labelPosition = label.positionString(label.OutsideBottomCenter);
    } else if (obj.attributes.icon !== null) {
      obj.labelPosition = label.positionString(label.InsideTopCenter);
    } else {
      obj.labelPosition = label.positionString(label.InsideMiddleCenter);
    }
    if (obj.attributes.labelDimensions.width > obj.box.Width || obj.attributes.labelDimensions.height > obj.box.Height) {
      if ((obj.childrenArray || []).length > 0) {
        obj.labelPosition = label.positionString(label.OutsideTopCenter);
      } else {
        obj.labelPosition = label.positionString(label.OutsideBottomCenter);
      }
    }
  }
}

// ---- descendant_shifter.go ----

/**
 * descendantShifter applies the same geometry updates as
 * d2graph.Object.ShiftDescendants while avoiding its repeated whole-graph edge
 * scans. ELK performs several sequential margin corrections per object, so the
 * shifter deliberately keeps each correction separate: ShiftStart/ShiftEnd may
 * simplify a route after each individual horizontal or vertical move.
 */
class DescendantShifter {
  constructor() {
    this.preorder = new Map();
    this.subtreeEnd = new Map();
    this.incident = new Map();
    this.seen = new Map();
    this.candidates = [];
    this.generation = 0;
  }

  inSubtree(root, obj) {
    const rootStart = this.preorder.get(root);
    const objStart = this.preorder.get(obj);
    return rootStart !== undefined && objStart !== undefined && rootStart <= objStart && objStart < this.subtreeEnd.get(root);
  }

  shift(root, dx, dy) {
    const s = this;
    if (dx === 0 && dy === 0) {
      return;
    }

    s.generation++;
    const generation = s.generation;
    const candidates = [];
    const addIncident = (obj) => {
      for (const edge of s.incident.get(obj) || []) {
        if (s.seen.get(edge) === generation) {
          continue;
        }
        s.seen.set(edge, generation);
        candidates.push(edge);
      }
    };

    // IsDescendantOf, used by the original implementation's first pass,
    // includes the object itself. Include root's incident edges so root self
    // loops and root-to-descendant edges preserve that behavior.
    addIncident(root);
    root.iterDescendants((_, descendant) => {
      descendant.box.TopLeft.x += dx;
      descendant.box.TopLeft.y += dy;
      addIncident(descendant);
    });
    s.candidates = candidates;

    for (const edge of candidates) {
      const srcInSubtree = s.inSubtree(root, edge.src);
      const dstInSubtree = s.inSubtree(root, edge.dst);
      if (srcInSubtree && dstInSubtree) {
        for (const point of edge.route) {
          point.x += dx;
          point.y += dy;
        }
        continue;
      }

      // The original second pass visits strict descendants only. An edge
      // from root to an outside object therefore remains unchanged.
      if (srcInSubtree && edge.src !== root) {
        shiftEdgeStart(edge, dx, dy);
      } else if (dstInSubtree && edge.dst !== root) {
        shiftEdgeEnd(edge, dx, dy);
      }
    }
  }
}

function newDescendantShifter(g) {
  const s = new DescendantShifter();
  let next = 0;
  const indexSubtree = (obj) => {
    s.preorder.set(obj, next);
    next++;
    for (const child of obj.childrenArray || []) {
      indexSubtree(child);
    }
    s.subtreeEnd.set(obj, next);
  };
  indexSubtree(g.root);

  for (const edge of g.edges || []) {
    if (!s.incident.has(edge.src)) s.incident.set(edge.src, []);
    s.incident.get(edge.src).push(edge);
    if (edge.dst !== edge.src) {
      if (!s.incident.has(edge.dst)) s.incident.set(edge.dst, []);
      s.incident.get(edge.dst).push(edge);
    }
  }
  return s;
}

function shiftEdgeStart(edge, dx, dy) {
  if (dx === 0) {
    edge.shiftStart(dy, false);
  } else if (dy === 0) {
    edge.shiftStart(dx, true);
  } else {
    edge.route[0].x += dx;
    edge.route[0].y += dy;
  }
}

function shiftEdgeEnd(edge, dx, dy) {
  if (dx === 0) {
    edge.shiftEnd(dy, false);
  } else if (dy === 0) {
    edge.shiftEnd(dx, true);
  } else {
    edge.route[edge.route.length - 1].x += dx;
    edge.route[edge.route.length - 1].y += dy;
  }
}

// ---- spatial_index.go ----

const bendIndexCellSize = 128.0;
const bendIndexMaxCells = 256;

function boundsForSegment(segment) {
  return {
    minX: Math.min(segment.Start.x, segment.End.x),
    minY: Math.min(segment.Start.y, segment.End.y),
    maxX: Math.max(segment.Start.x, segment.End.x),
    maxY: Math.max(segment.Start.y, segment.End.y),
  };
}

const expanded = (bounds, amount) => ({
  minX: bounds.minX - amount,
  minY: bounds.minY - amount,
  maxX: bounds.maxX + amount,
  maxY: bounds.maxY + amount,
});

const boundsOverlaps = (bounds, other) => bounds.minX <= other.maxX && other.minX <= bounds.maxX &&
  bounds.minY <= other.maxY && other.minY <= bounds.maxY;

/**
 * spatialIndex is an exact-query broad phase: it may return false positives,
 * but every item whose bounds overlap the query is returned. Very large or
 * non-finite entries are kept in a small fallback set instead of filling an
 * unbounded number of grid cells.
 */
class SpatialIndex {
  constructor() {
    this.cellSize = bendIndexCellSize;
    this.maxCells = bendIndexMaxCells;
    this.cells = new Map(); // "x,y" -> Set(item)
    this.large = new Set();
    this.entries = new Map(); // item -> {bounds, cells, large}
    this.seen = new Map();
    this.queryID = 0;
  }

  add(item, bounds) {
    const index = this;
    index.remove(item);
    const [cells, ok] = index.coveredCells(bounds);
    const entry = { bounds, cells, large: !ok };
    index.entries.set(item, entry);
    if (!ok) {
      index.large.add(item);
      return;
    }
    for (const cell of cells) {
      const key = `${cell.x},${cell.y}`;
      let items = index.cells.get(key);
      if (items === undefined) {
        items = new Set();
        index.cells.set(key, items);
      }
      items.add(item);
    }
  }

  remove(item) {
    const index = this;
    const entry = index.entries.get(item);
    if (entry === undefined) {
      return;
    }
    index.entries.delete(item);
    index.seen.delete(item);
    if (entry.large) {
      index.large.delete(item);
      return;
    }
    for (const cell of entry.cells) {
      const key = `${cell.x},${cell.y}`;
      const items = index.cells.get(key);
      if (items === undefined) continue;
      items.delete(item);
      if (items.size === 0) {
        index.cells.delete(key);
      }
    }
  }

  query(bounds, visit) {
    const index = this;
    const [cells, ok] = index.coveredCells(bounds);
    if (!ok) {
      for (const [item, entry] of [...index.entries]) {
        if (boundsOverlaps(entry.bounds, bounds)) {
          visit(item);
        }
      }
      return;
    }

    index.queryID++;
    const queryID = index.queryID;
    for (const cell of cells) {
      for (const item of [...(index.cells.get(`${cell.x},${cell.y}`) || [])]) {
        if (index.seen.get(item) === queryID) {
          continue;
        }
        index.seen.set(item, queryID);
        if (boundsOverlaps(index.entries.get(item).bounds, bounds)) {
          visit(item);
        }
      }
    }
    for (const item of [...index.large]) {
      if (index.seen.get(item) === queryID) {
        continue;
      }
      if (boundsOverlaps(index.entries.get(item).bounds, bounds)) {
        visit(item);
      }
    }
  }

  /** @returns {[Array<{x:number,y:number}>|null, boolean]} */
  coveredCells(bounds) {
    const index = this;
    if (!finiteBounds(bounds)) {
      return [null, false];
    }
    const minX = Math.floor(bounds.minX / index.cellSize);
    const maxX = Math.floor(bounds.maxX / index.cellSize);
    const minY = Math.floor(bounds.minY / index.cellSize);
    const maxY = Math.floor(bounds.maxY / index.cellSize);
    // Keep float-to-int conversion safe on every supported target, including
    // wasm32. Leave one unit of headroom so the inclusive loops below cannot
    // overflow when incrementing their final coordinate.
    const safeCellCoordinate = 2 ** 31 - 2;
    if (Math.abs(minX) > safeCellCoordinate || Math.abs(maxX) > safeCellCoordinate ||
      Math.abs(minY) > safeCellCoordinate || Math.abs(maxY) > safeCellCoordinate) {
      return [null, false];
    }
    const width = maxX - minX + 1;
    const height = maxY - minY + 1;
    if (width <= 0 || height <= 0 || width > index.maxCells ||
      height > index.maxCells || width * height > index.maxCells) {
      return [null, false];
    }
    const cells = [];
    for (let y = Math.trunc(minY); y <= Math.trunc(maxY); y++) {
      for (let x = Math.trunc(minX); x <= Math.trunc(maxX); x++) {
        cells.push({ x, y });
      }
    }
    return [cells, true];
  }
}

const finiteBounds = (bounds) => Number.isFinite(bounds.minX) && Number.isFinite(bounds.minY) &&
  Number.isFinite(bounds.maxX) && Number.isFinite(bounds.maxY);

class BendCollisionIndex {
  constructor() {
    this.objects = new SpatialIndex();
    this.segments = new SpatialIndex();
    this.edgeSegments = new Map();
  }

  updateEdge(edge) {
    const index = this;
    const previous = index.edgeSegments.get(edge) || [];
    for (const segment of previous) {
      index.segments.remove(segment);
    }
    const segments = [];
    for (let i = 0; i + 1 < edge.route.length; i++) {
      let segment;
      if (i < previous.length) {
        segment = previous[i];
      } else {
        segment = { edge: null, segment: null };
      }
      segment.edge = edge;
      segment.segment = new geo.Segment(edge.route[i], edge.route[i + 1]);
      segments.push(segment);
      index.segments.add(segment, boundsForSegment(segment.segment));
    }
    index.edgeSegments.set(edge, segments);
  }

  countObjectIntersects(src, dst, segment) {
    let count = 0;
    this.objects.query(boundsForSegment(segment), (obj) => {
      if (obj === src || obj === dst) {
        return;
      }
      if (obj.box.intersects(segment, edge_node_spacing - 1)) {
        count++;
      }
    });
    return count;
  }

  /** @returns {[number, number, number, number]} crossings, overlaps, close overlaps, touching */
  countEdgeIntersects(sourceEdge, segment) {
    const isHorizontal = Math.ceil(segment.Start.y) === Math.ceil(segment.End.y);
    let crossingsCount = 0;
    let overlapsCount = 0;
    let closeOverlapsCount = 0;
    let touchingCount = 0;
    const queryBounds = expanded(boundsForSegment(segment), edge_node_spacing / 2);
    this.segments.query(queryBounds, (other) => {
      if (other.edge === sourceEdge) {
        return;
      }
      const otherSegment = other.segment;
      const otherIsHorizontal = Math.ceil(otherSegment.Start.y) === Math.ceil(otherSegment.End.y);
      if (isHorizontal === otherIsHorizontal) {
        if (segment.overlaps(otherSegment, !isHorizontal, 0.)) {
          if (isHorizontal) {
            if (Math.abs(segment.Start.y - otherSegment.Start.y) < edge_node_spacing / 2.) {
              overlapsCount++;
              if (Math.abs(segment.Start.y - otherSegment.Start.y) < edge_node_spacing / 4.) {
                closeOverlapsCount++;
                if (Math.abs(segment.Start.y - otherSegment.Start.y) < 1.) {
                  touchingCount++;
                }
              }
            }
          } else {
            if (Math.abs(segment.Start.x - otherSegment.Start.x) < edge_node_spacing / 2.) {
              overlapsCount++;
              if (Math.abs(segment.Start.x - otherSegment.Start.x) < edge_node_spacing / 4.) {
                closeOverlapsCount++;
                // Preserve the existing predicate, including its use of Y
                // for vertical touching segments.
                if (Math.abs(segment.Start.y - otherSegment.Start.y) < 1.) {
                  touchingCount++;
                }
              }
            }
          }
        }
      } else if (segment.intersects(otherSegment)) {
        crossingsCount++;
      }
    });
    return [crossingsCount, overlapsCount, closeOverlapsCount, touchingCount];
  }
}

function newBendCollisionIndex(g) {
  const index = new BendCollisionIndex();
  const objectBuffer = edge_node_spacing - 1;
  for (const obj of g.objects || []) {
    const bounds = expanded({
      minX: obj.box.TopLeft.x,
      minY: obj.box.TopLeft.y,
      maxX: obj.box.TopLeft.x + obj.box.Width,
      maxY: obj.box.TopLeft.y + obj.box.Height,
    }, objectBuffer);
    index.objects.add(obj, bounds);
  }
  for (const edge of g.edges || []) {
    index.updateEdge(edge);
  }
  return index;
}
