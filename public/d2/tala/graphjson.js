// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of the Go package d2layouts/d2talalayout/internal/graphjson (D2 v0.9.0): the fixture representation of a TALA
// layout graph and its reconstruction. A serialized graph is a plain object with exactly the keys of Go's JSON encoding (the JSON tags,
// or the Go field name where a field has no tag: `CellSize`, `Containers`' siblings `Clusters`... see the field lists below); entity
// IDs are BigInt, map keys are decimal strings. `marshal` prints it as JSON text (bigjson.js), `unmarshal` reads JSON text with Go's
// DisallowUnknownFields and case-insensitive key matching. Omitted fields follow Go's omitempty rules.
//
// serialize(ctx, graph) -> object; deserialize(ctx, object, out); marshal(ctx, graph) -> text; unmarshal(ctx, text, out).

import * as geo from '../geo.js';
import * as label from '../label.js';
import * as limits from './limits.js';
import { errorf } from './goerrors.js';
import * as bigjson from './bigjson.js';
import * as lg from './layoutgraph.js';

const { Orientation } = geo;

const newWorkGuard = (ctx, location) => limits.newWorkGuard(ctx, location, limits.MaxEngineWorkUnits);

const maxEngineNodes = limits.MaxEngineNodes;
const maxEngineEdges = limits.MaxEngineEdges;
const maxEngineTopologyReferences = lg.MaxSerializationTopologyReferences;
const maxEngineRoutePoints = lg.MaxSerializationRoutePoints;
const maxEngineTopologyDepth = lg.MaxTopologyDepth;
const maxEnginePreflightWork = lg.MaxSerializationPreflightWork;

// ---- direction.go ----

function serializeDirection(direction) {
  switch (direction) {
    case Orientation.Top: return 'up';
    case Orientation.Bottom: return 'down';
    case Orientation.Left: return 'left';
    case Orientation.Right: return 'right';
    default: return '';
  }
}

function deserializeDirection(direction) {
  switch (direction) {
    case 'up': return Orientation.Top;
    case 'down': return Orientation.Bottom;
    case 'left': return Orientation.Left;
    case 'right': return Orientation.Right;
    default: return Orientation.NONE;
  }
}

// ---- representation.go ----

/** The JSON keys of each record (Go struct field order). */
export const FIELDS = {
  label: ['Text', 'Position', 'Width', 'Height'],
  icon: ['Position'],
  point: ['x', 'y'],
  scalar: ['value'],
  style: ['opacity', 'stroke', 'fill', 'fillPattern', 'strokeWidth', 'strokeDash', 'borderRadius', 'shadow', '3d', 'multiple', 'font',
    'fontSize', 'fontColor', 'animated', 'bold', 'italic', 'underline', 'filled', 'doubleBorder', 'textTransform'],
  node: ['id', 'd2id', 'isInvisible', 'width', 'height', 'topLeft', 'fixedTopLeft', 'desiredWidth', 'desiredHeight', 'nears', 'fontSize',
    'shapeType', 'label', 'icon', 'numColumns', 'is3D', 'isMultiple', 'forceHierarchy'],
  edge: ['id', 'originalId', 'd2id', 'from', 'isInvisible', 'to', 'points', 'minWidth', 'minHeight', 'labelPercentage', 'label',
    'fromTableColumnIndex', 'toTableColumnIndex', 'style', 'sourceArrowhead', 'targetArrowhead', 'sourceArrowheadLabel', 'targetArrowheadLabel'],
  abduction: ['Edge', 'OriginallyFromNode', 'OriginallyToNode', 'CurrentFromNode', 'CurrentToNode'],
  cluster: ['Nodes', 'Arrangement', 'DesiredArrangement', 'EdgeAbductions', 'Container', 'FixedSize', 'Padding'],
  sequence: ['Nodes', 'EdgeAbductions', 'Container'],
  tree: ['Node', 'Children', 'SentinelEdge', 'Orientation'],
  hierarchy: ['Levels'],
  graph: ['nodes', 'edges', 'CellSize', 'isRootHierarchy', 'containers', 'hubs', 'clusters', 'sequences', 'clusterVessels', 'sequenceVessels',
    'trees', 'hierarchies', 'directions', 'crossingCost', 'turnCost', 'nonCenterPortCost'],
};

// style key (JSON) <-> EdgeStyle property
const STYLE_KEYS = lg.EDGE_STYLE_FIELDS.map((f) => [f === 'threeDee' ? '3d' : f, f]);

// ---- serialization helpers ----

function serializePoint(point) {
  if (point === null) return null;
  return { x: point.x, y: point.y };
}

function deserializePoint(point) {
  if (point === null || point === undefined) return null;
  return geo.newPoint(point.x, point.y);
}

function serializeLabel(l) {
  if (l === null) return null;
  return { Text: l.text, Position: label.positionString(l.position), Width: l.width, Height: l.height };
}

function serializeIcon(i) {
  if (i === null) return null;
  return { Position: label.positionString(i.position) };
}

function deserializeLabel(l, guard) {
  if (l === null || l === undefined) return null;
  guard.step();
  return new lg.Label(l.Text, label.fromString(l.Position), l.Width, l.Height);
}

function deserializeIcon(i, guard) {
  if (i === null || i === undefined) return null;
  guard.step();
  const icon = new lg.Icon();
  icon.position = label.fromString(i.Position);
  return icon;
}

function serializeStyle(style) {
  const out = {};
  for (const [key, prop] of STYLE_KEYS) {
    if (style[prop] !== null) out[key] = { value: style[prop].value };
  }
  return out;
}

function deserializeStyle(style) {
  const out = new lg.EdgeStyle();
  for (const [key, prop] of STYLE_KEYS) {
    const s = style[key];
    out[prop] = s === null || s === undefined ? null : new lg.StyleScalar(s.value);
  }
  return out;
}

/** edgeSerializationIDs assigns a stable, serialization-only ID to every edge whose ID is unset. */
class EdgeSerializationIDs {
  constructor() {
    this.byEdge = new Map();
    this.used = new Set();
    this.next = -1n;
  }

  reference(edge) {
    if (edge === null) return 0n;
    if (this.byEdge.has(edge)) return this.byEdge.get(edge);
    if (edge.id !== 0n) {
      this.byEdge.set(edge, edge.id);
      return edge.id;
    }
    for (;;) {
      const candidate = this.next;
      this.next--;
      if (candidate === 0n) continue;
      if (this.used.has(candidate)) continue;
      this.used.add(candidate);
      this.byEdge.set(edge, candidate);
      return candidate;
    }
  }
}

function newEdgeSerializationIDs(g, guard) {
  const ids = new EdgeSerializationIDs();

  const reserveEdge = (edge) => {
    guard.step();
    if (edge !== null && edge !== undefined && edge.id !== 0n) ids.used.add(edge.id);
  };
  const seenNodes = new Set();
  const reserveNode = (node) => {
    guard.step();
    if (node === null || node === undefined) return;
    if (seenNodes.has(node)) return;
    seenNodes.add(node);
    for (const edge of node.edges) reserveEdge(edge);
  };

  for (const edge of g.edges) reserveEdge(edge);
  for (const node of g.nodes) reserveNode(node);
  for (const [container, children] of g.containers) {
    reserveNode(container);
    for (const child of children) reserveNode(child);
  }
  for (const [vessel, cluster] of g.clusters) {
    reserveNode(vessel);
    if (cluster === null) continue;
    reserveNode(cluster.container);
    for (const node of cluster.nodes) reserveNode(node);
    for (const abduction of cluster.edgeAbductions) {
      if (abduction !== null) reserveEdge(abduction.edge);
    }
  }
  for (const [vessel, sequence] of g.sequences) {
    reserveNode(vessel);
    if (sequence === null) continue;
    reserveNode(sequence.container);
    for (const node of sequence.nodes) reserveNode(node);
    for (const abduction of sequence.edgeAbductions) {
      if (abduction !== null) reserveEdge(abduction.edge);
    }
  }
  for (const [rootSentinel, roots] of g.trees) {
    reserveNode(rootSentinel);
    const stack = [];
    for (let i = roots.length - 1; i >= 0; i--) stack.push(roots[i]);
    while (stack.length > 0) {
      const tree = stack.pop();
      if (tree === null) throw errorf('cannot serialize a nil tree');
      reserveNode(tree.node);
      reserveEdge(tree.sentinelEdge);
      for (let i = tree.children.length - 1; i >= 0; i--) stack.push(tree.children[i]);
    }
  }

  // Allocate unset references in the same stable order used by the serialized representation. In particular, do not let per-node
  // adjacency order decide IDs later used by fixture references and deterministic output.
  for (const edge of g.edges) {
    guard.step();
    ids.reference(edge);
  }
  for (const vessel of g.clusterOrder()) {
    for (const abduction of g.clusters.get(vessel).edgeAbductions) {
      guard.step();
      if (abduction !== null) ids.reference(abduction.edge);
    }
  }
  for (const vessel of g.sequenceOrder()) {
    for (const abduction of g.sequences.get(vessel).edgeAbductions) {
      guard.step();
      if (abduction !== null) ids.reference(abduction.edge);
    }
  }
  for (const rootSentinel of g.treeOrder()) {
    const roots = g.trees.get(rootSentinel);
    const stack = [];
    for (let i = roots.length - 1; i >= 0; i--) stack.push(roots[i]);
    while (stack.length > 0) {
      const tree = stack.pop();
      guard.step();
      ids.reference(tree.sentinelEdge);
      for (let i = tree.children.length - 1; i >= 0; i--) stack.push(tree.children[i]);
    }
  }

  guard.finish();
  return ids;
}

const keyOf = (id) => id.toString();

function serializeNode(node, guard) {
  const nears = [];
  for (const n of node.orderedNears_()) {
    guard.step();
    nears.push(n.entityID());
  }

  const out = { id: node.id };
  if (node.d2ID !== null) out.d2id = node.d2ID;
  if (node.isInvisible) out.isInvisible = true;
  out.width = node.width;
  out.height = node.height;
  out.topLeft = serializePoint(node.topLeft);
  if (node.fixedTopLeft !== null) out.fixedTopLeft = serializePoint(node.fixedTopLeft);
  if (node.desiredWidth !== null) out.desiredWidth = node.desiredWidth;
  if (node.desiredHeight !== null) out.desiredHeight = node.desiredHeight;
  if (nears.length > 0) out.nears = nears;
  if (node.fontSize !== null) out.fontSize = node.fontSize;
  out.shapeType = node.shapeType();
  if (node.label !== null) out.label = serializeLabel(node.label);
  if (node.icon !== null) out.icon = serializeIcon(node.icon);
  const numColumns = node.numColumns();
  if (numColumns !== 0) out.numColumns = numColumns;
  if (node.is3D) out.is3D = true;
  if (node.isMultiple) out.isMultiple = true;
  if (node.forceHierarchy) out.forceHierarchy = true;
  return out;
}

function serializeEdge(edge, edgeIDs, guard) {
  const points = [];
  for (const point of edge.points) {
    guard.step();
    points.push(serializePoint(point));
  }

  const serializedID = edgeIDs.reference(edge);
  const out = { id: serializedID };
  if (serializedID !== edge.id) out.originalId = edge.id;
  if (edge.d2ID !== null) out.d2id = edge.d2ID;
  out.from = lg.nodeIDForSerialization(edge.from);
  if (edge.isInvisible) out.isInvisible = true;
  out.to = lg.nodeIDForSerialization(edge.to);
  out.points = points;
  out.minWidth = edge.minWidth;
  out.minHeight = edge.minHeight;
  out.labelPercentage = edge.labelPercentage;
  if (edge.label !== null) out.label = serializeLabel(edge.label);
  if (edge.fromTableColumnIndex !== null) out.fromTableColumnIndex = edge.fromTableColumnIndex;
  if (edge.toTableColumnIndex !== null) out.toTableColumnIndex = edge.toTableColumnIndex;
  out.style = serializeStyle(edge.style);
  out.sourceArrowhead = edge.sourceArrowhead;
  out.targetArrowhead = edge.targetArrowhead;
  if (edge.sourceArrowheadLabel !== null) out.sourceArrowheadLabel = serializeLabel(edge.sourceArrowheadLabel);
  if (edge.targetArrowheadLabel !== null) out.targetArrowheadLabel = serializeLabel(edge.targetArrowheadLabel);
  return out;
}

function serializeTree(t, edgeIDs, guard) {
  if (t === null) throw errorf('cannot serialize a nil tree');

  // Use explicit frames instead of recursive calls. validateEngineGraph has already rejected cycles and excessive depth, while the guard
  // bounds every child occurrence (including repeated shared subtrees).
  const result = { Children: new Array(t.children.length) };
  const stack = [{ tree: t, out: result, child: 0 }];
  while (stack.length > 0) {
    const current = stack[stack.length - 1];
    if (current.child < current.tree.children.length) {
      const child = current.tree.children[current.child];
      const childOut = {};
      current.out.Children[current.child] = childOut;
      current.child++;
      if (child === null) throw errorf('cannot serialize a nil tree child');
      guard.step();
      childOut.Children = new Array(child.children.length);
      stack.push({ tree: child, out: childOut, child: 0 });
      continue;
    }

    const node = serializeNode(current.tree.node, guard);
    if (current.tree.sentinelEdge === null) throw errorf('cannot serialize a tree with a nil sentinel edge');
    const edge = serializeEdge(current.tree.sentinelEdge, edgeIDs, guard);
    // key order of Go's struct: Node, Children, SentinelEdge, Orientation
    const children = current.out.Children;
    delete current.out.Children;
    current.out.Node = node;
    current.out.Children = children;
    current.out.SentinelEdge = edge;
    current.out.Orientation = current.tree.orientation;
    stack.pop();
  }
  return result;
}

function serializeAbductions(list, edgeIDs, guard) {
  const abductions = [];
  for (const abduction of list) {
    guard.step();
    abductions.push({
      Edge: edgeIDs.reference(abduction.edge),
      OriginallyFromNode: lg.nodeIDForSerialization(abduction.originallyFrom),
      OriginallyToNode: lg.nodeIDForSerialization(abduction.originallyTo),
      CurrentFromNode: lg.nodeIDForSerialization(abduction.currentFrom),
      CurrentToNode: lg.nodeIDForSerialization(abduction.currentTo),
    });
  }
  return abductions;
}

/**
 * Serialize validates graph bounds before walking any nested topology, then observes ctx throughout the bounded serialization. The
 * preflight is deliberately inside this lowest-level entry point so cloning and fixture encoding cannot accidentally bypass it.
 */
export function serialize(ctx, g) {
  if (ctx == null) throw errorf('TALA SerializeGraph requires a context');
  if (g == null) throw errorf('cannot serialize a nil graph');
  lg.validateForSerialization(ctx, g);
  const guard = newWorkGuard(ctx, 'SerializeGraph');

  const edgeIDs = newEdgeSerializationIDs(g, guard);
  const inSerializedNodes = new Set();
  const serializedNodes = [];
  for (const node of g.nodes) {
    serializedNodes.push(serializeNode(node, guard));
    inSerializedNodes.add(node);
  }
  for (const vessel of g.clusterOrder()) {
    guard.step();
    if (!inSerializedNodes.has(vessel)) inSerializedNodes.add(vessel);
    for (const n of g.clusters.get(vessel).nodes) {
      guard.step();
      if (!inSerializedNodes.has(n)) {
        serializedNodes.push(serializeNode(n, guard));
        inSerializedNodes.add(n);
      }
    }
  }
  for (const vessel of g.sequenceOrder()) {
    guard.step();
    if (!inSerializedNodes.has(vessel)) inSerializedNodes.add(vessel);
    for (const n of g.sequences.get(vessel).nodes) {
      guard.step();
      if (!inSerializedNodes.has(n)) {
        serializedNodes.push(serializeNode(n, guard));
        inSerializedNodes.add(n);
      }
    }
  }

  const serializedEdges = [];
  for (const edge of g.edges) serializedEdges.push(serializeEdge(edge, edgeIDs, guard));

  // serialize in a fixed order based on node id
  const containers = {};
  if (g.containers.size > 0) {
    const ordered = lg.containerOrderForSerialization(g, guard);
    if (g.containers.size !== ordered.length + 1) {
      throw errorf(`g.Containers length (${g.containers.size}) does not match rdfs ordered container length (${ordered.length + 1})`);
    }
    for (const containerNode of ordered.concat([null])) {
      guard.step();
      const newvals = [];
      for (const node of (g.containers.get(containerNode) ?? [])) {
        guard.step();
        if (!inSerializedNodes.has(node)) {
          throw errorf(`error while serializing: node ${node.debugID()} is missing from g.Nodes but is a child of ${containerNode === null ? 'nil' : containerNode.debugID()} in g.Containers`);
        }
        newvals.push(lg.nodeIDForSerialization(node));
      }
      containers[keyOf(lg.nodeIDForSerialization(containerNode))] = newvals;
    }
  }

  const clusters = {};
  const clusterVessels = {};
  for (const vessel of g.clusterOrder()) {
    guard.step();
    const clusterNodes = [];
    const cluster = g.clusters.get(vessel);
    for (const node of cluster.nodes) {
      guard.step();
      if (!inSerializedNodes.has(node)) {
        throw errorf(`error while serializing: node ${node.debugID()} is missing from g.Nodes but is in cluster ${vessel.debugID()} in g.Clusters`);
      }
      clusterNodes.push(lg.nodeIDForSerialization(node));
    }

    const abductions = serializeAbductions(cluster.edgeAbductions, edgeIDs, guard);

    clusters[keyOf(lg.nodeIDForSerialization(vessel))] = {
      Nodes: clusterNodes,
      Arrangement: cluster.arrangement,
      DesiredArrangement: cluster.desiredArrangement,
      EdgeAbductions: abductions,
      Container: lg.nodeIDForSerialization(cluster.container),
      FixedSize: cluster.fixedSize,
      Padding: cluster.padding,
    };
    clusterVessels[keyOf(lg.nodeIDForSerialization(vessel))] = serializeNode(vessel, guard);
  }

  const sequences = {};
  const sequenceVessels = {};
  for (const vessel of g.sequenceOrder()) {
    guard.step();
    const sequenceNodes = [];
    const seq = g.sequences.get(vessel);
    for (const node of seq.nodes) {
      guard.step();
      if (!inSerializedNodes.has(node)) {
        throw errorf(`error while serializing: node ${lg.nodeIDForSerialization(node)} is missing from g.Nodes but is in sequence ${lg.nodeIDForSerialization(vessel)} in g.Sequences`);
      }
      sequenceNodes.push(lg.nodeIDForSerialization(node));
    }

    const abductions = serializeAbductions(seq.edgeAbductions, edgeIDs, guard);

    sequences[keyOf(lg.nodeIDForSerialization(vessel))] = {
      Nodes: sequenceNodes,
      EdgeAbductions: abductions,
      Container: lg.nodeIDForSerialization(seq.container),
    };
    sequenceVessels[keyOf(lg.nodeIDForSerialization(vessel))] = serializeNode(vessel, guard);
  }

  const hubs = {};
  if (g.hubs.size > 0) {
    for (const n of g.hubOrder()) {
      guard.step();
      const newvals = [];
      for (const node of g.hubs.get(n)) {
        guard.step();
        if (!inSerializedNodes.has(node)) {
          throw errorf(`error while serializing: node ${node.debugID()} is missing from g.Nodes but is a spoke of ${n.debugID()} in g.Hubs`);
        }
        newvals.push(lg.nodeIDForSerialization(node));
      }
      hubs[keyOf(lg.nodeIDForSerialization(n))] = newvals;
    }
  }

  const trees = {};
  for (const rootSentinel of g.treeOrder()) {
    for (const root of g.trees.get(rootSentinel)) {
      guard.step();
      const serialized = serializeTree(root, edgeIDs, guard);
      const rootID = keyOf(lg.nodeIDForSerialization(rootSentinel));
      if (!trees[rootID]) trees[rootID] = [];
      trees[rootID].push(serialized);
    }
  }

  const seenHierarchies = new Set();
  const hierarchies = [];
  for (const node of g.nodes) {
    guard.step();
    if (node.hierarchy === null) continue;
    else if (seenHierarchies.has(node.hierarchy)) continue;
    seenHierarchies.add(node.hierarchy);

    const nodeToLevel = {};
    for (const [n, level] of lg.hierarchyLevelsForSerialization(node.hierarchy)) {
      guard.step();
      nodeToLevel[keyOf(n.id)] = level;
    }
    hierarchies.push({ Levels: nodeToLevel });
  }

  const directions = {};
  for (const [container, dir] of g.directions) {
    guard.step();
    directions[keyOf(lg.nodeIDForSerialization(container))] = serializeDirection(dir);
  }
  guard.finish();
  const [crossingCost, turnCost, nonCenterPortCost] = lg.costsForSerialization(g);

  const out = { nodes: serializedNodes, edges: serializedEdges, CellSize: g.cellSize };
  if (g.isRootHierarchy) out.isRootHierarchy = true;
  out.containers = containers;
  if (Object.keys(hubs).length > 0) out.hubs = hubs;
  if (Object.keys(clusters).length > 0) out.clusters = clusters;
  if (Object.keys(sequences).length > 0) out.sequences = sequences;
  if (Object.keys(clusterVessels).length > 0) out.clusterVessels = clusterVessels;
  if (Object.keys(sequenceVessels).length > 0) out.sequenceVessels = sequenceVessels;
  if (Object.keys(trees).length > 0) out.trees = trees;
  if (hierarchies.length > 0) out.hierarchies = hierarchies;
  if (Object.keys(directions).length > 0) out.directions = directions;
  out.crossingCost = crossingCost;
  out.turnCost = turnCost;
  out.nonCenterPortCost = nonCenterPortCost;
  return out;
}

/** Marshal encodes a graph in the internal fixture representation (JSON text). */
export function marshal(ctx, g) {
  return bigjson.stringify(serialize(ctx, g));
}

// ---- decoding: JSON object -> SerializedGraph (Go's json.Unmarshal with DisallowUnknownFields) ----

/** Keeps only known keys, matched like encoding/json (exact name first, then case-insensitively); unknown keys are an error. */
function strictKeys(obj, fields, what) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    throw errorf(`json: cannot unmarshal ${Array.isArray(obj) ? 'array' : typeof obj} into Go value of type graphjson.${what}`);
  }
  const out = {};
  for (const key of Object.keys(obj)) {
    let canonical = fields.includes(key) ? key : fields.find((f) => f.toLowerCase() === key.toLowerCase());
    if (canonical === undefined) throw errorf(`json: unknown field "${key}"`);
    out[canonical] = obj[key];
  }
  return out;
}

const toID = (v, what) => {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isInteger(v)) return BigInt(v);
  throw errorf(`json: cannot unmarshal ${typeof v} into Go struct field ${what} of type int64`);
};
const toNum = (v, what) => {
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  throw errorf(`json: cannot unmarshal ${typeof v} into Go struct field ${what} of type float64`);
};
const toInt = (v, what) => {
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  throw errorf(`json: cannot unmarshal ${typeof v} into Go struct field ${what} of type int`);
};
const toStr = (v, what) => {
  if (typeof v === 'string') return v;
  throw errorf(`json: cannot unmarshal ${typeof v} into Go struct field ${what} of type string`);
};
const toBool = (v, what) => {
  if (typeof v === 'boolean') return v;
  throw errorf(`json: cannot unmarshal ${typeof v} into Go struct field ${what} of type bool`);
};
const opt = (v, f) => (v === undefined || v === null ? null : f(v));
const arr = (v, f) => (v === undefined || v === null ? [] : v.map(f));
const mapKeysToIDs = (obj, what) => {
  const out = {};
  if (obj === undefined || obj === null) return out;
  for (const k of Object.keys(obj)) {
    if (!/^-?\d+$/.test(k)) throw errorf(`json: cannot unmarshal number ${k} into Go value of type int64`);
    out[k] = obj[k];
  }
  return out;
};

const decPoint = (p) => {
  const o = strictKeys(p, FIELDS.point, 'SerializedPoint');
  return { x: o.x === undefined ? 0 : toNum(o.x, 'x'), y: o.y === undefined ? 0 : toNum(o.y, 'y') };
};
const decLabel = (l) => {
  const o = strictKeys(l, FIELDS.label, 'SerializedLabel');
  return { Text: o.Text === undefined ? '' : toStr(o.Text, 'Text'), Position: o.Position === undefined ? '' : toStr(o.Position, 'Position'),
    Width: o.Width === undefined ? 0 : toNum(o.Width, 'Width'), Height: o.Height === undefined ? 0 : toNum(o.Height, 'Height') };
};
const decIcon = (i) => {
  const o = strictKeys(i, FIELDS.icon, 'SerializedIcon');
  return { Position: o.Position === undefined ? '' : toStr(o.Position, 'Position') };
};
const decStyle = (s) => {
  const o = strictKeys(s, FIELDS.style, 'SerializedStyle');
  const out = {};
  for (const k of Object.keys(o)) {
    if (o[k] === null) continue;
    const sc = strictKeys(o[k], FIELDS.scalar, 'SerializedScalar');
    out[k] = { value: sc.value === undefined ? '' : toStr(sc.value, 'value') };
  }
  return out;
};
const decNode = (n) => {
  const o = strictKeys(n, FIELDS.node, 'SerializedNode');
  return {
    id: o.id === undefined ? 0n : toID(o.id, 'SerializedNode.id'),
    d2id: opt(o.d2id, (v) => toStr(v, 'd2id')),
    isInvisible: o.isInvisible === undefined ? false : toBool(o.isInvisible, 'isInvisible'),
    width: o.width === undefined ? 0 : toNum(o.width, 'width'),
    height: o.height === undefined ? 0 : toNum(o.height, 'height'),
    topLeft: opt(o.topLeft, decPoint),
    fixedTopLeft: opt(o.fixedTopLeft, decPoint),
    desiredWidth: opt(o.desiredWidth, (v) => toNum(v, 'desiredWidth')),
    desiredHeight: opt(o.desiredHeight, (v) => toNum(v, 'desiredHeight')),
    nears: arr(o.nears, (v) => toID(v, 'nears')),
    fontSize: opt(o.fontSize, (v) => toInt(v, 'fontSize')),
    shapeType: o.shapeType === undefined ? '' : toStr(o.shapeType, 'shapeType'),
    label: opt(o.label, decLabel),
    icon: opt(o.icon, decIcon),
    numColumns: o.numColumns === undefined ? 0 : toInt(o.numColumns, 'numColumns'),
    is3D: o.is3D === undefined ? false : toBool(o.is3D, 'is3D'),
    isMultiple: o.isMultiple === undefined ? false : toBool(o.isMultiple, 'isMultiple'),
    forceHierarchy: o.forceHierarchy === undefined ? false : toBool(o.forceHierarchy, 'forceHierarchy'),
  };
};
const decEdge = (e) => {
  const o = strictKeys(e, FIELDS.edge, 'SerializedEdge');
  return {
    id: o.id === undefined ? 0n : toID(o.id, 'SerializedEdge.id'),
    originalId: opt(o.originalId, (v) => toID(v, 'originalId')),
    d2id: opt(o.d2id, (v) => toStr(v, 'd2id')),
    from: o.from === undefined ? 0n : toID(o.from, 'from'),
    isInvisible: o.isInvisible === undefined ? false : toBool(o.isInvisible, 'isInvisible'),
    to: o.to === undefined ? 0n : toID(o.to, 'to'),
    points: arr(o.points, (p) => (p === null ? null : decPoint(p))),
    minWidth: o.minWidth === undefined ? 0 : toInt(o.minWidth, 'minWidth'),
    minHeight: o.minHeight === undefined ? 0 : toInt(o.minHeight, 'minHeight'),
    labelPercentage: o.labelPercentage === undefined ? 0 : toNum(o.labelPercentage, 'labelPercentage'),
    label: opt(o.label, decLabel),
    fromTableColumnIndex: opt(o.fromTableColumnIndex, (v) => toInt(v, 'fromTableColumnIndex')),
    toTableColumnIndex: opt(o.toTableColumnIndex, (v) => toInt(v, 'toTableColumnIndex')),
    style: o.style === undefined || o.style === null ? {} : decStyle(o.style),
    sourceArrowhead: o.sourceArrowhead === undefined ? '' : toStr(o.sourceArrowhead, 'sourceArrowhead'),
    targetArrowhead: o.targetArrowhead === undefined ? '' : toStr(o.targetArrowhead, 'targetArrowhead'),
    sourceArrowheadLabel: opt(o.sourceArrowheadLabel, decLabel),
    targetArrowheadLabel: opt(o.targetArrowheadLabel, decLabel),
  };
};
const decAbduction = (a) => {
  const o = strictKeys(a, FIELDS.abduction, 'SerializedEdgeAbduction');
  const id = (k) => (o[k] === undefined ? 0n : toID(o[k], k));
  return { Edge: id('Edge'), OriginallyFromNode: id('OriginallyFromNode'), OriginallyToNode: id('OriginallyToNode'),
    CurrentFromNode: id('CurrentFromNode'), CurrentToNode: id('CurrentToNode') };
};
const decCluster = (c) => {
  const o = strictKeys(c, FIELDS.cluster, 'SerializedCluster');
  return {
    Nodes: arr(o.Nodes, (v) => toID(v, 'Nodes')),
    Arrangement: o.Arrangement === undefined ? '' : toStr(o.Arrangement, 'Arrangement'),
    DesiredArrangement: o.DesiredArrangement === undefined ? '' : toStr(o.DesiredArrangement, 'DesiredArrangement'),
    EdgeAbductions: arr(o.EdgeAbductions, decAbduction),
    Container: o.Container === undefined ? 0n : toID(o.Container, 'Container'),
    FixedSize: o.FixedSize === undefined ? false : toBool(o.FixedSize, 'FixedSize'),
    Padding: o.Padding === undefined ? 0 : toNum(o.Padding, 'Padding'),
  };
};
const decSequence = (s) => {
  const o = strictKeys(s, FIELDS.sequence, 'SerializedSequence');
  return { Nodes: arr(o.Nodes, (v) => toID(v, 'Nodes')), EdgeAbductions: arr(o.EdgeAbductions, decAbduction), Container: o.Container === undefined ? 0n : toID(o.Container, 'Container') };
};
const decTree = (t) => {
  const o = strictKeys(t, FIELDS.tree, 'SerializedTree');
  return {
    Node: o.Node === undefined ? decNode({}) : decNode(o.Node),
    Children: arr(o.Children, decTree),
    SentinelEdge: o.SentinelEdge === undefined ? decEdge({}) : decEdge(o.SentinelEdge),
    Orientation: o.Orientation === undefined ? 0 : toInt(o.Orientation, 'Orientation'),
  };
};
const decHierarchy = (h) => {
  const o = strictKeys(h, FIELDS.hierarchy, 'SerializedHierarchy');
  const levels = {};
  for (const k of Object.keys(mapKeysToIDs(o.Levels))) levels[k] = toInt(o.Levels[k], 'Levels');
  return { Levels: levels };
};
const decMap = (obj, f) => {
  const out = {};
  for (const k of Object.keys(mapKeysToIDs(obj))) out[k] = f(obj[k]);
  return out;
};

/** decodeGraph: the JSON value (as parsed by bigjson) -> a normalized SerializedGraph. */
export function decodeGraph(value) {
  if (value === null) return null;
  const o = strictKeys(value, FIELDS.graph, 'SerializedGraph');
  return {
    nodes: arr(o.nodes, decNode),
    edges: arr(o.edges, decEdge),
    CellSize: o.CellSize === undefined ? 0 : toNum(o.CellSize, 'CellSize'),
    isRootHierarchy: o.isRootHierarchy === undefined ? false : toBool(o.isRootHierarchy, 'isRootHierarchy'),
    containers: decMap(o.containers, (v) => arr(v, (x) => toID(x, 'containers'))),
    hubs: decMap(o.hubs, (v) => arr(v, (x) => toID(x, 'hubs'))),
    clusters: decMap(o.clusters, decCluster),
    sequences: decMap(o.sequences, decSequence),
    clusterVessels: decMap(o.clusterVessels, decNode),
    sequenceVessels: decMap(o.sequenceVessels, decNode),
    trees: decMap(o.trees, (v) => arr(v, decTree)),
    hierarchies: arr(o.hierarchies, decHierarchy),
    directions: decMap(o.directions, (v) => toStr(v, 'directions')),
    crossingCost: o.crossingCost === undefined ? 0 : toNum(o.crossingCost, 'crossingCost'),
    turnCost: o.turnCost === undefined ? 0 : toNum(o.turnCost, 'turnCost'),
    nonCenterPortCost: o.nonCenterPortCost === undefined ? 0 : toNum(o.nonCenterPortCost, 'nonCenterPortCost'),
  };
}

// ---- preflight.go ----

const deepEqual = (a, b) => {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => k in b && deepEqual(a[k], b[k]));
};

/**
 * validateSerializedGraphForDeserialization bounds and validates the value topology before reconstruction allocates runtime records or
 * mutates any caller-visible object.
 */
function validateSerializedGraphForDeserialization(ctx, graph) {
  const guard = newWorkGuard(ctx, 'DeserializeGraph preflight');
  guard.setLimit(maxEnginePreflightWork);
  // Reject hostile top-level slices before their lengths are used as map capacity hints below.
  if (graph.nodes.length > maxEngineNodes) throw errorf(`TALA DeserializeGraph node records exceed limit ${maxEngineNodes}`);
  if (graph.edges.length > maxEngineEdges) throw errorf(`TALA DeserializeGraph edge records exceed limit ${maxEngineEdges}`);

  let nodeRecords = 0, edgeRecords = 0, references = 0, routePoints = 0;
  const addBounded = (current, count, limit, kind) => {
    if (count < 0 || count > limit - current) throw errorf(`TALA DeserializeGraph ${kind} exceed limit ${limit}`);
    guard.check();
    return current + count;
  };
  const addReferences = (count, kind) => { references = addBounded(references, count, maxEngineTopologyReferences, kind + ' references'); };
  const addRoutePoints = (count) => { routePoints = addBounded(routePoints, count, maxEngineRoutePoints, 'route points'); };

  const nodesByID = new Map();
  const topLevelNodeIDs = new Set();
  const addNode = (node, location) => {
    guard.step();
    nodeRecords = addBounded(nodeRecords, 1, maxEngineNodes, 'node records');
    if (node.id === 0n) throw errorf(`TALA DeserializeGraph ${location} uses reserved node ID 0`);
    if (nodesByID.has(node.id)) {
      if (!deepEqual(nodesByID.get(node.id), node)) throw errorf(`TALA DeserializeGraph node ID ${node.id} has inconsistent repeated records`);
    } else {
      nodesByID.set(node.id, node);
    }
    addReferences(node.nears.length, location);
  };

  const edgesBySerializedID = new Map();
  const effectiveEdgeIDs = new Map();
  const topLevelEdgeIDs = new Set();
  const addEdge = (edge, location) => {
    guard.step();
    edgeRecords = addBounded(edgeRecords, 1, maxEngineEdges, 'edge records');
    if (edge.id === 0n) throw errorf(`TALA DeserializeGraph ${location} uses reserved serialized edge ID 0`);
    let effectiveID = edge.id;
    if (edge.originalId !== null) {
      if (edge.id >= 0n || edge.originalId !== 0n) {
        throw errorf(`TALA DeserializeGraph ${location} has invalid original edge ID ${edge.originalId} for serialized ID ${edge.id}`);
      }
      effectiveID = edge.originalId;
    }
    if (effectiveID !== 0n) {
      if (effectiveEdgeIDs.has(effectiveID) && effectiveEdgeIDs.get(effectiveID) !== edge.id) {
        throw errorf(`TALA DeserializeGraph ${location} effective edge ID ${effectiveID} is also represented by serialized ID ${effectiveEdgeIDs.get(effectiveID)}`);
      }
      effectiveEdgeIDs.set(effectiveID, edge.id);
    }
    if (edgesBySerializedID.has(edge.id)) {
      if (!deepEqual(edgesBySerializedID.get(edge.id), edge)) throw errorf(`TALA DeserializeGraph edge ID ${edge.id} has inconsistent repeated records`);
    } else {
      edgesBySerializedID.set(edge.id, edge);
    }
    addRoutePoints(edge.points.length);
  };

  const count = (o) => Object.keys(o).length;
  addReferences(count(graph.containers), 'container map');
  addReferences(count(graph.hubs), 'hub map');
  addReferences(count(graph.clusters), 'cluster map');
  addReferences(count(graph.sequences), 'sequence map');
  addReferences(count(graph.clusterVessels), 'cluster vessel map');
  addReferences(count(graph.sequenceVessels), 'sequence vessel map');
  addReferences(count(graph.trees), 'tree map');
  addReferences(graph.hierarchies.length, 'hierarchy list');
  addReferences(count(graph.directions), 'direction map');

  graph.nodes.forEach((node, i) => {
    if (topLevelNodeIDs.has(node.id)) throw errorf(`TALA DeserializeGraph has duplicate node ID ${node.id} in top-level records`);
    topLevelNodeIDs.add(node.id);
    addNode(node, `node ${i}`);
  });
  graph.edges.forEach((edge, i) => {
    if (topLevelEdgeIDs.has(edge.id)) throw errorf(`TALA DeserializeGraph has duplicate edge ID ${edge.id} in top-level records`);
    topLevelEdgeIDs.add(edge.id);
    addEdge(edge, `edge ${i}`);
  });
  for (const [id, children] of Object.entries(graph.containers)) {
    guard.step();
    addReferences(children.length, `container ${id}`);
  }
  for (const [id, spokes] of Object.entries(graph.hubs)) {
    guard.step();
    addReferences(spokes.length, `hub ${id}`);
  }
  for (const [id, node] of Object.entries(graph.clusterVessels)) addNode(node, `cluster vessel ${id}`);
  for (const [id, node] of Object.entries(graph.sequenceVessels)) addNode(node, `sequence vessel ${id}`);
  for (const [id, cluster] of Object.entries(graph.clusters)) {
    guard.step();
    if (cluster.Container === BigInt(id)) throw errorf(`TALA DeserializeGraph cluster ${id} cannot contain itself`);
    addReferences(cluster.Nodes.length + cluster.EdgeAbductions.length, `cluster ${id}`);
  }
  for (const [id, sequence] of Object.entries(graph.sequences)) {
    guard.step();
    if (sequence.Container === BigInt(id)) throw errorf(`TALA DeserializeGraph sequence ${id} cannot contain itself`);
    addReferences(sequence.Nodes.length + sequence.EdgeAbductions.length, `sequence ${id}`);
  }

  const treeOwners = new Map();
  for (const [rootID, roots] of Object.entries(graph.trees)) {
    addReferences(roots.length, `tree root ${rootID}`);
    const stack = [];
    for (let i = roots.length - 1; i >= 0; i--) stack.push({ tree: roots[i], depth: 1, location: `tree ${rootID}[${i}]` });
    while (stack.length > 0) {
      const frame = stack.pop();
      guard.step();
      if (frame.depth > maxEngineTopologyDepth) throw errorf(`TALA DeserializeGraph tree depth exceeds limit ${maxEngineTopologyDepth}`);
      if (treeOwners.has(frame.tree.Node.id)) {
        throw errorf(`TALA DeserializeGraph tree node ${frame.tree.Node.id} has more than one tree owner (${treeOwners.get(frame.tree.Node.id)} and ${frame.location})`);
      }
      if (nodesByID.has(frame.tree.Node.id)) {
        if (!topLevelNodeIDs.has(frame.tree.Node.id)) {
          throw errorf(`TALA DeserializeGraph tree node ${frame.tree.Node.id} repeats a non-top-level node record`);
        }
      }
      treeOwners.set(frame.tree.Node.id, frame.location);
      addNode(frame.tree.Node, frame.location + ' node');
      addEdge(frame.tree.SentinelEdge, frame.location + ' sentinel edge');
      addReferences(frame.tree.Children.length, frame.location + ' children');
      for (let i = frame.tree.Children.length - 1; i >= 0; i--) {
        stack.push({ tree: frame.tree.Children[i], depth: frame.depth + 1, location: `${frame.location} child ${i}` });
      }
    }
  }
  const hierarchyOwners = new Map();
  graph.hierarchies.forEach((hierarchy, i) => {
    guard.step();
    addReferences(count(hierarchy.Levels), `hierarchy ${i}`);
    for (const nodeID of Object.keys(hierarchy.Levels)) {
      if (hierarchyOwners.has(nodeID)) {
        throw errorf(`TALA DeserializeGraph hierarchy node ${nodeID} appears in both hierarchy ${hierarchyOwners.get(nodeID)} and hierarchy ${i}`);
      }
      hierarchyOwners.set(nodeID, i);
    }
  });
  guard.finish();
}

// ---- deserialization ----

function deserializeTreeNode(g, serializedTree, parent, nodesByID, edgesByID, guard) {
  guard.step();
  let node = nodesByID.get(serializedTree.Node.id);
  if (node === undefined) {
    node = deserializeNode(g, serializedTree.Node, guard);
    for (const nearID of serializedTree.Node.nears) {
      guard.step();
      const near = nodesByID.get(nearID);
      if (near === undefined) throw errorf(`could not find tree node near of ID: ${nearID}`);
      node.addNear(near);
    }
    nodesByID.set(node.id, node);
  }

  let edge = edgesByID.get(serializedTree.SentinelEdge.id);
  if (edge === undefined) {
    edge = deserializeEdge(serializedTree.SentinelEdge, nodesByID, guard);
    edgesByID.set(serializedTree.SentinelEdge.id, edge);
  }

  const tree = new lg.Tree(node);
  tree.sentinelEdge = edge;
  tree.parent = parent;
  tree.orientation = serializedTree.Orientation;
  tree.children = [];
  return tree;
}

function deserializeTree(g, serializedRoot, nodesByID, edgesByID, guard) {
  const root = deserializeTreeNode(g, serializedRoot, null, nodesByID, edgesByID, guard);
  const stack = [{ serialized: serializedRoot, tree: root, nextChild: 0 }];
  while (stack.length > 0) {
    const current = stack[stack.length - 1];
    if (current.nextChild >= current.serialized.Children.length) {
      stack.pop();
      continue;
    }
    const serializedChild = current.serialized.Children[current.nextChild];
    current.nextChild++;
    const child = deserializeTreeNode(g, serializedChild, current.tree, nodesByID, edgesByID, guard);
    current.tree.children.push(child);
    stack.push({ serialized: serializedChild, tree: child, nextChild: 0 });
  }
  return root;
}

function deserializeEdge(edge, nodesByID, guard) {
  guard.step();
  if (!nodesByID.has(edge.from)) throw errorf(`error while deserializing: edge ${edge.id} has from node ${edge.from} which is missing from g.Nodes`);
  if (!nodesByID.has(edge.to)) throw errorf(`error while deserializing: edge ${edge.id} has to node ${edge.to} which is missing from g.Nodes`);
  const newedge = lg.newEdge(nodesByID.get(edge.from), nodesByID.get(edge.to));
  newedge.id = edge.id;
  if (edge.originalId !== null) newedge.id = edge.originalId;
  if (edge.d2id !== null) newedge.d2ID = edge.d2id;
  newedge.sourceArrowhead = edge.sourceArrowhead;
  newedge.targetArrowhead = edge.targetArrowhead;
  newedge.sourceArrowheadLabel = deserializeLabel(edge.sourceArrowheadLabel, guard);
  newedge.targetArrowheadLabel = deserializeLabel(edge.targetArrowheadLabel, guard);
  newedge.minWidth = edge.minWidth;
  newedge.minHeight = edge.minHeight;
  newedge.labelPercentage = edge.labelPercentage;
  if (edge.fromTableColumnIndex !== null) newedge.fromTableColumnIndex = edge.fromTableColumnIndex;
  if (edge.toTableColumnIndex !== null) newedge.toTableColumnIndex = edge.toTableColumnIndex;
  for (const point of edge.points) {
    guard.step();
    newedge.points.push(deserializePoint(point));
  }
  newedge.label = deserializeLabel(edge.label, guard);
  newedge.isInvisible = edge.isInvisible;
  newedge.style = deserializeStyle(edge.style);

  return newedge;
}

function deserializeNode(g, node, guard) {
  guard.step();
  for (let i = 0; i < node.nears.length; i++) guard.step();
  const n = lg.newNode(node.id, node.width, node.height);

  if (node.d2id !== null) n.d2ID = node.d2id;
  n.topLeft = deserializePoint(node.topLeft);
  n.fixedTopLeft = deserializePoint(node.fixedTopLeft);
  n.graph = g;
  if (node.fontSize !== null) n.fontSize = node.fontSize;
  if (node.desiredWidth !== null) n.desiredWidth = node.desiredWidth;
  if (node.desiredHeight !== null) n.desiredHeight = node.desiredHeight;
  n.setShape(node.shapeType);
  n.setNumColumns(node.numColumns);
  n.label = deserializeLabel(node.label, guard);
  n.icon = deserializeIcon(node.icon, guard);
  n.is3D = node.is3D;
  n.isMultiple = node.isMultiple;
  n.forceHierarchy = node.forceHierarchy;
  n.isInvisible = node.isInvisible;
  return n;
}

/**
 * Deserialize reconstructs graph while observing ctx throughout its topology walks. It publishes the reconstructed graph atomically after
 * every fallible operation and the final context check have succeeded. `graph` is a decoded graph (decodeGraph) or a JSON value.
 */
export function deserialize(ctx, graph, out) {
  if (graph === null || graph === undefined) throw errorf('cannot deserialize a nil graph');
  if (out === null || out === undefined) throw errorf('cannot deserialize into a nil graph');
  validateSerializedGraphForDeserialization(ctx, graph);
  const staged = new lg.Graph();
  deserializeGraphContext(ctx, graph, staged, out);
  lg.publishDeserializedGraph(out, staged, graph.crossingCost, graph.turnCost, graph.nonCenterPortCost);
}

const sortIDKeys = (obj) => Object.keys(obj).map((k) => BigInt(k)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

function deserializeAbductions(list, id, kind, edgesByID, nodesByID, guard) {
  const edgeAbductions = [];
  for (const val of list) {
    guard.step();
    const edge = edgesByID.get(val.Edge);
    if (edge === undefined) throw errorf(`couldn't find edge abduction edge ${val.Edge} for ${kind} ${id}`);
    const find = (nid, what) => {
      const n = nodesByID.get(nid);
      if (nid !== 0n && n === undefined) throw errorf(`couldn't find edge abduction ${what} ${nid} for ${kind} ${id}`);
      return n === undefined ? null : n;
    };
    const ea = new lg.EdgeAbduction();
    ea.edge = edge;
    ea.originallyFrom = find(val.OriginallyFromNode, 'OriginallyFrom');
    ea.originallyTo = find(val.OriginallyToNode, 'OriginallyTo');
    ea.currentFrom = find(val.CurrentFromNode, 'CurrentFrom');
    ea.currentTo = find(val.CurrentToNode, 'CurrentTo');
    edgeAbductions.push(ea);
  }
  return edgeAbductions;
}

function deserializeGraphContext(ctx, graph, destination, owner) {
  const guard = newWorkGuard(ctx, 'DeserializeGraph');

  const nodes = [];
  const nodesByID = new Map();

  for (const node of graph.nodes) {
    guard.step();
    if (nodesByID.has(node.id)) throw errorf(`error while deserializing: duplicate node ID ${node.id}`);
    const newNode = deserializeNode(owner, node, guard);
    nodesByID.set(node.id, newNode);
    nodes.push(newNode);
  }

  const edges = [];
  const edgesByID = new Map();

  for (const edge of graph.edges) {
    guard.step();
    if (edgesByID.has(edge.id)) throw errorf(`error while deserializing: duplicate edge ID ${edge.id}`);
    const newedge = deserializeEdge(edge, nodesByID, guard);
    lg.addDecodedEdge(newedge.from, newedge);
    if (!newedge.isLoop_()) lg.addDecodedEdge(newedge.to, newedge);
    edgesByID.set(edge.id, newedge);
    edges.push(newedge);
  }

  // deserialize in a fixed order
  const containerOrder = [];
  for (const id of Object.keys(graph.containers)) {
    guard.step();
    containerOrder.push(BigInt(id));
  }
  containerOrder.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const containers = new Map();
  for (const containerID of containerOrder) {
    guard.step();
    const hasContainer = nodesByID.has(containerID);
    const container = hasContainer ? nodesByID.get(containerID) : null;
    if (containerID !== 0n && !hasContainer) throw errorf(`error while deserializing: missing container node ${containerID}`);

    const containerNodes = [];
    for (const nID of graph.containers[keyOf(containerID)]) {
      guard.step();
      const n = nodesByID.get(nID);
      if (n === undefined) throw errorf(`error while deserializing: container ${containerID} has node ${nID} which is missing from g.Nodes`);
      containerNodes.push(n);
      n.container = container;
    }

    containers.set(container, containerNodes);
    if (container !== null) lg.markDecodedContainer(container);
  }

  const hubOrder = [];
  for (const id of Object.keys(graph.hubs)) {
    guard.step();
    hubOrder.push(BigInt(id));
  }
  hubOrder.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const clusterOrder = [];
  for (const id of Object.keys(graph.clusters)) {
    guard.step();
    clusterOrder.push(BigInt(id));
  }
  clusterOrder.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const clusters = new Map();
  for (const id of clusterOrder) {
    guard.step();
    let vessel = null;
    if (nodesByID.has(id)) {
      vessel = nodesByID.get(id);
      lg.markDecodedClusterVessel(vessel);
    } else if (graph.clusterVessels[keyOf(id)] !== undefined) {
      const cv = graph.clusterVessels[keyOf(id)];
      if (cv.id !== id) throw errorf(`error while deserializing: cluster vessel key ${id} does not match node ID ${cv.id}`);
      vessel = deserializeNode(owner, cv, guard);
      lg.markDecodedClusterVessel(vessel);
      vessel.graph = null;
      nodesByID.set(id, vessel);
    }
    if (vessel === null) throw errorf(`error while deserializing: cluster ${id} has no node or serialized vessel`);
    const serializedCluster = graph.clusters[keyOf(id)];
    if (serializedCluster.Container !== 0n) {
      if (!nodesByID.has(serializedCluster.Container)) {
        throw errorf(`error while deserializing: cluster ${id} references missing container ${serializedCluster.Container}`);
      }
    }

    const clusterNodes = [];
    for (const nID of serializedCluster.Nodes) {
      guard.step();
      const n = nodesByID.get(nID);
      if (n === undefined) throw errorf(`error while deserializing: cluster ${id} has node ${nID} which is missing from g.Nodes`);
      clusterNodes.push(n);
    }

    const cluster = new lg.Cluster();
    cluster.vessel = vessel;
    cluster.arrangement = serializedCluster.Arrangement;
    cluster.desiredArrangement = serializedCluster.DesiredArrangement;
    cluster.graph = owner;
    cluster.container = nodesByID.get(serializedCluster.Container) ?? null;
    cluster.nodes = clusterNodes;
    cluster.padding = serializedCluster.Padding;
    cluster.fixedSize = serializedCluster.FixedSize;
    clusters.set(vessel, cluster);
    for (const n of clusterNodes) {
      guard.step();
      n.cluster = cluster;
    }
  }

  const sequenceOrder = [];
  for (const vessel of Object.keys(graph.sequences)) {
    guard.step();
    sequenceOrder.push(BigInt(vessel));
  }
  sequenceOrder.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const sequences = new Map();
  for (const id of sequenceOrder) {
    guard.step();
    let vessel = null;
    if (nodesByID.has(id)) {
      vessel = nodesByID.get(id);
    } else if (graph.sequenceVessels[keyOf(id)] !== undefined) {
      const sv = graph.sequenceVessels[keyOf(id)];
      if (sv.id !== id) throw errorf(`error while deserializing: sequence vessel key ${id} does not match node ID ${sv.id}`);
      vessel = deserializeNode(owner, sv, guard);
      vessel.graph = null;
      nodesByID.set(id, vessel);
    }
    if (vessel === null) throw errorf(`error while deserializing: sequence ${id} has no node or serialized vessel`);
    const seq = graph.sequences[keyOf(id)];
    if (seq.Nodes.length < 2) throw errorf(`error while deserializing: sequence ${id} has ${seq.Nodes.length} steps; want at least 2`);
    if (seq.Container !== 0n) {
      if (!nodesByID.has(seq.Container)) throw errorf(`error while deserializing: sequence ${id} references missing container ${seq.Container}`);
    }

    const sequenceNodes = [];
    for (const nID of seq.Nodes) {
      guard.step();
      const n = nodesByID.get(nID);
      if (n === undefined) throw errorf(`error while deserializing: sequence ${id} has node ${nID} which is missing from g.Nodes`);
      sequenceNodes.push(n);
    }

    const sequence = new lg.Sequence();
    sequence.vessel = vessel;
    sequence.graph = owner;
    sequence.container = nodesByID.get(seq.Container) ?? null;
    sequence.nodes = sequenceNodes;
    sequences.set(vessel, sequence);
    for (const n of sequenceNodes) {
      guard.step();
      n.sequence = sequence;
    }
  }

  const hubs = new Map();
  for (const id of hubOrder) {
    guard.step();
    const hub = nodesByID.get(id);
    if (hub === undefined) throw errorf(`error while deserializing: hub ${id} is missing from g.Nodes`);

    const spokes = [];
    for (const nID of graph.hubs[keyOf(id)]) {
      guard.step();
      const n = nodesByID.get(nID);
      if (n === undefined) throw errorf(`error while deserializing: hub ${id} has node ${nID} which is missing from g.Nodes`);
      spokes.push(n);
    }

    hubs.set(hub, spokes);
  }

  for (const id of clusterOrder) {
    guard.step();
    const edgeAbductions = deserializeAbductions(graph.clusters[keyOf(id)].EdgeAbductions, id, 'cluster', edgesByID, nodesByID, guard);
    const vessel = nodesByID.get(id);
    clusters.get(vessel).edgeAbductions = edgeAbductions;
  }

  for (const id of sequenceOrder) {
    guard.step();
    const edgeAbductions = deserializeAbductions(graph.sequences[keyOf(id)].EdgeAbductions, id, 'sequence', edgesByID, nodesByID, guard);
    const vessel = nodesByID.get(id);
    sequences.get(vessel).edgeAbductions = edgeAbductions;
  }

  const trees = new Map();
  for (const [rootSentinelIDKey, serializedTrees] of Object.entries(graph.trees)) {
    guard.step();
    const rootSentinelID = BigInt(rootSentinelIDKey);
    const found = nodesByID.get(rootSentinelID);
    if (rootSentinelID !== 0n && found === undefined) throw errorf(`error while deserializing: tree references missing root sentinel ${rootSentinelID}`);
    const rootSentinel = found === undefined ? null : found;
    for (const serializedTree of serializedTrees) {
      const t = deserializeTree(owner, serializedTree, nodesByID, edgesByID, guard);
      if (!trees.has(rootSentinel)) trees.set(rootSentinel, []);
      trees.get(rootSentinel).push(t);
    }
  }

  for (const node of graph.nodes) {
    guard.step();
    for (const nearID of node.nears) {
      guard.step();
      const near = nodesByID.get(nearID);
      if (near === undefined) throw errorf(`could not find node ${node.id} near node ${nearID}`);
      nodesByID.get(node.id).addNear(near);
    }
  }

  for (const serialized of graph.hierarchies) {
    guard.step();
    const levels = new Map();
    const hierarchy = lg.newDecodedHierarchy(levels);
    for (const [nodeIDKey, level] of Object.entries(serialized.Levels)) {
      guard.step();
      const node = nodesByID.get(BigInt(nodeIDKey));
      if (node === undefined) throw errorf(`error while deserializing: hierarchy references missing node ${nodeIDKey}`);
      levels.set(node, level);
      node.hierarchy = hierarchy;
    }
  }

  const directions = new Map();
  for (const [nodeIDKey, dirString] of Object.entries(graph.directions)) {
    guard.step();
    const nodeID = BigInt(nodeIDKey);
    const found = nodesByID.get(nodeID);
    if (nodeID !== 0n && found === undefined) throw errorf(`error while deserializing: direction references missing container ${nodeID}`);
    directions.set(found === undefined ? null : found, deserializeDirection(dirString));
  }

  const filtered = [];
  for (const n of nodes) {
    guard.step();
    if (lg.isActiveClusterForSerialization(n.cluster)) continue;
    if (lg.isActiveSequenceForSerialization(n.sequence)) continue;
    filtered.push(n);
  }
  // Derive every fallible auxiliary index before publishing any state to out. This keeps cancellation and malformed input atomic for
  // callers that deserialize over an existing graph.
  const nodeToTree = lg.buildNodeToTreeForDeserialization(trees, guard);
  guard.finish();

  destination.nodes = filtered;
  destination.edges = edges;
  destination.cellSize = graph.CellSize;
  destination.isRootHierarchy = graph.isRootHierarchy;
  destination.containers = containers;
  destination.hubs = hubs;
  destination.clusters = clusters;
  destination.sequences = sequences;
  destination.trees = trees;
  destination.nodeToTree = nodeToTree;
  destination.commonUncleSiblings = null;
  destination.directions = directions;
}

/**
 * Unmarshal decodes fixture JSON (text, or a value parsed by bigjson) into out and isolates unexpected internal invariant panics behind a
 * stable error, like Go.
 */
export function unmarshal(ctx, data, out) {
  try {
    let value = data;
    if (typeof data === 'string') {
      try {
        value = bigjson.parse(data);
      } catch (e) {
        throw errorf(e.message); // a syntax error is an ordinary error in Go, not a panic
      }
    }
    const sg = decodeGraph(value);
    deserialize(ctx, sg, out);
  } catch (e) {
    if (e && e.name === 'GoError') throw e;
    throw errorf('deserialize graph failed due to an internal invariant');
  }
}

