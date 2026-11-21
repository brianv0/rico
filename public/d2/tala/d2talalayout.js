// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of the root of the Go package d2layouts/d2talalayout (D2 v0.9.0, Copyright 2022 Terrastruct Inc.): the D2 <-> TALA
// adapter. This file has the D2 -> TALA translation (adapter.go, adapter_validate.go, limits.go, seedgraph.go) and the seed plan
// (layout.go: Options, layoutPlan, normalizeSeeds, seedsFromData). The engine call (runSeed, seed selection), the result validation and
// the patch back onto the D2 graph (layout.go's Layout, result.go, result_validate.go, patch.go) are the engine stage's.
//
// translateGraph(ctx, g, talaGraph, loadExistingLayout) fills `talaGraph` (a layoutgraph.Graph) from a D2 graph whose objects have been
// sized (SetDimensions) and returns the bindings {objectIDs, edgeIDs, edgeDestinations} (Maps keyed by the D2 object/edge).

import * as geo from '../geo.js';
import * as label from '../label.js';
import { goInt, goV } from '../gomath.js';
import { quote } from '../url.js';
import * as d2target from '../target.js';
import * as d2ast from '../ast.js';
import * as d2graph from '../d2graph.js';
import * as d2sequence from '../d2sequence.js';
import * as strconv from '../strconv.js';
import { errorf } from './goerrors.js';
import * as limits from './limits.js';
import * as lg from './layoutgraph.js';

// ---- limits.go ----

// Keep adapter preflight aligned with the native engine limits.
const maxInputNodes = limits.MaxEngineNodes;
const maxInputEdges = limits.MaxEngineEdges;
const maxInputRoutePoints = limits.MaxEngineRoutePoints;
const maxInputTreeDepth = limits.MaxEngineTreeDepth;

/** maxResultCoordinate keeps geometry within the range safely consumed by D2's integer render dimensions. */
export const maxResultCoordinate = 1_000_000_000;

// ---- layout.go: options and the seed plan ----

const maxSeeds = 16;
const maxSeedEntries = maxSeeds * 4;
const defaultMaxSeedConcurrency = 4;

/** DefaultOptions returns an independent copy of the package defaults ({seeds: [1n, 2n, 3n], maxConcurrency}). */
export function defaultOptions() {
  return { seeds: [1n, 2n, 3n], maxConcurrency: defaultMaxSeedConcurrency };
}

/** normalizeSeeds: at least one seed, at most 16 unique ones (first-seen order). Seeds are BigInt (int64). */
export function normalizeSeeds(seeds) {
  if (seeds.length === 0) throw errorf('tala requires at least one seed');
  if (seeds.length > maxSeedEntries) throw errorf(`tala accepts at most ${maxSeedEntries} seed entries`);

  const unique = [];
  const seen = new Set();
  for (const seed of seeds) {
    if (seen.has(seed)) continue;
    seen.add(seed);
    unique.push(seed);
    if (unique.length > maxSeeds) throw errorf(`tala supports at most ${maxSeeds} unique seeds`);
  }
  return unique;
}

/** The text fmt.Sprint gives to a JSON value (float64 / string / bool). */
const sprint = (v) => (typeof v === 'number' ? goV(v) : typeof v === 'bigint' ? v.toString() : String(v));

/** strconv.ParseInt(s, 10, 64): [BigInt, ok] */
function parseInt64(s) {
  if (!/^[+-]?\d+$/.test(s)) return [0n, false];
  const v = BigInt(s);
  if (v > 9223372036854775807n || v < -9223372036854775808n) return [0n, false];
  return [v, true];
}

/** seedsFromData reads the `tala-seeds` list of the graph's data (a JS array of numbers or numeric strings). */
export function seedsFromData(raw) {
  if (!Array.isArray(raw)) throw errorf('tala-seeds must be a list of signed 64-bit integers');
  if (raw.length > maxSeedEntries) throw errorf(`tala accepts at most ${maxSeedEntries} seed entries`);

  const seeds = [];
  raw.forEach((rawSeed, i) => {
    const [seed, ok] = parseInt64(sprint(rawSeed));
    if (!ok) throw errorf(`invalid tala seed at index ${i} (${sprint(rawSeed)}): must be a signed 64-bit integer`);
    seeds.push(seed);
  });
  return seeds;
}

/** layoutPlan returns [seeds, concurrency]. `graph.data` is the d2-config data map (or null). */
export function layoutPlan(graph, opts) {
  const defaults = defaultOptions();
  if (opts === null || opts === undefined) opts = defaults;

  let seeds = opts.seeds;
  if (seeds === null || seeds === undefined) seeds = defaults.seeds;
  seeds = seeds.map((s) => BigInt(s));
  if (graph.data !== null && graph.data !== undefined) {
    const raw = graph.data instanceof Map ? graph.data.get('tala-seeds') : graph.data['tala-seeds'];
    if (raw !== undefined) seeds = seedsFromData(raw);
  }

  seeds = normalizeSeeds(seeds);
  let concurrency = opts.maxConcurrency ?? 0;
  if (concurrency === 0) concurrency = defaults.maxConcurrency;
  if (concurrency < 0 || concurrency > maxSeeds) throw errorf(`tala MaxConcurrency must be between 1 and ${maxSeeds}, or zero for the default`);
  if (concurrency > seeds.length) concurrency = seeds.length;
  return [seeds, concurrency];
}

// ---- adapter.go ----

const firstD2SpillEntityID = 1n << 32n;

/** hash/fnv New32a (FNV-1a) of the UTF-8 bytes */
function d2FNV32(id) {
  let h = 0x811c9dc5;
  for (const b of new TextEncoder().encode(id)) {
    h ^= b;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * allocateD2EntityIDs preserves the unsigned FNV-1a ID for every nonzero singleton bucket. Only colliding or root-reserved zero hashes
 * receive deterministic spill IDs above the uint32 range. `identities` is a list of {entity, absID}; returns Map<entity, BigInt>.
 */
function allocateD2EntityIDs(ctx, kind, identities) {
  if (ctx == null) throw errorf(`allocate D2 ${kind} IDs requires a context`);
  const hashed = new Array(identities.length);
  const bucketSizes = new Map();
  const seenAbsIDs = new Set();
  identities.forEach((identity, i) => {
    if (i % 256 === 0) {
      const err = ctx.err();
      if (err) throw err;
    }
    if (seenAbsIDs.has(identity.absID)) throw errorf(`D2 ${kind} ID ${quote(identity.absID)} is repeated`);
    seenAbsIDs.add(identity.absID);
    const hash = d2FNV32(identity.absID);
    hashed[i] = { entity: identity.entity, absID: identity.absID, hash };
    bucketSizes.set(hash, (bucketSizes.get(hash) ?? 0) + 1);
  });

  const allocated = new Map();
  const ambiguous = [];
  hashed.forEach((identity, i) => {
    if (i % 256 === 0) {
      const err = ctx.err();
      if (err) throw err;
    }
    if (identity.hash !== 0 && bucketSizes.get(identity.hash) === 1) {
      allocated.set(identity.entity, BigInt(identity.hash));
      return;
    }
    ambiguous.push(identity);
  });
  // slices.SortFunc with cmp.Compare(hash), cmp.Compare(absID): a total order on distinct absIDs (string compare is by bytes in Go)
  ambiguous.sort((a, b) => {
    if (a.hash !== b.hash) return a.hash < b.hash ? -1 : 1;
    return compareBytes(a.absID, b.absID);
  });
  const err = ctx.err();
  if (err) throw err;
  ambiguous.forEach((identity, i) => allocated.set(identity.entity, firstD2SpillEntityID + BigInt(i)));
  return allocated;
}

/** Go compares strings byte-wise (UTF-8), which is code point order. */
function compareBytes(a, b) {
  const x = Array.from(a), y = Array.from(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) {
    const cx = x[i].codePointAt(0), cy = y[i].codePointAt(0);
    if (cx !== cy) return cx < cy ? -1 : 1;
  }
  return x.length === y.length ? 0 : x.length < y.length ? -1 : 1;
}

function d2TALAEdgeAbsID(edge) {
  if (!isSupportedLifelineEdge(edge)) return edge.absID();
  const effectiveEdge = Object.assign(Object.create(Object.getPrototypeOf(edge)), edge);
  effectiveEdge.dst = edge.src;
  return effectiveEdge.absID();
}

/**
 * translateGraph: D2 graph -> TALA graph (adapter.go). `loadExistingLayout` also loads the objects' TopLeft and the edges' routes and
 * label positions (RouteEdges). Returns the bindings {objectIDs, edgeIDs, edgeDestinations}.
 */
export function translateGraph(ctx, g, talaGraph, loadExistingLayout) {
  const bindings = { objectIDs: new Map(), edgeIDs: new Map(), edgeDestinations: new Map() };
  let err = ctx.err();
  if (err) throw err;
  if (g == null || g.root == null) throw errorf('tala requires a D2 graph with a root object');
  if (talaGraph == null) throw errorf('tala requires a destination graph');
  const [visits, objects] = collectD2ObjectVisits(ctx, g.root);
  validateD2GraphStructure(g, visits, objects);
  validateD2Objects(ctx, visits, loadExistingLayout);
  validateD2Edges(ctx, g.edges ?? [], objects);
  const objectIdentities = visits.map((visit) => ({ entity: visit.object, absID: visit.object.absID() }));
  const objectIDs = allocateD2EntityIDs(ctx, 'object', objectIdentities);
  const gEdges = g.edges ?? [];
  const edgeIdentities = new Array(gEdges.length);
  const edgeAbsIDs = new Map();
  gEdges.forEach((edge, i) => {
    const absID = d2TALAEdgeAbsID(edge);
    edgeAbsIDs.set(edge, absID);
    edgeIdentities[i] = { entity: edge, absID };
  });
  const edgeIDs = allocateD2EntityIDs(ctx, 'edge', edgeIdentities);

  const toNode = new Map();
  if (g.root.attributes.direction.value !== '') talaGraph.directions.set(null, parseDirection(g.root.attributes.direction.value));
  if (g.root.attributes.shape.value === d2target.ShapeHierarchy) talaGraph.isRootHierarchy = true;

  for (const visit of visits) {
    err = ctx.err();
    if (err) throw err;
    const obj = visit.object, parent = visit.parent;
    const intID = objectIDs.get(obj);
    bindings.objectIDs.set(obj, intID);
    const n = lg.newNode(intID, obj.box.Width, obj.box.Height);
    if (obj.attributes.top !== null && obj.attributes.left !== null) {
      const [top] = parseD2IntegerAttribute(obj.id, 'top', obj.attributes.top, -maxResultCoordinate, maxResultCoordinate);
      const [left] = parseD2IntegerAttribute(obj.id, 'left', obj.attributes.left, -maxResultCoordinate, maxResultCoordinate);
      n.fixedTopLeft = geo.newPoint(left, top);
    }
    toNode.set(obj, n);
    if (obj.attributes.widthAttr !== null) {
      const [desiredWidth] = parseD2IntegerAttribute(obj.id, 'width', obj.attributes.widthAttr, 1, maxResultCoordinate);
      n.desiredWidth = desiredWidth;
    }
    if (obj.attributes.heightAttr !== null) {
      const [desiredHeight] = parseD2IntegerAttribute(obj.id, 'height', obj.attributes.heightAttr, 1, maxResultCoordinate);
      n.desiredHeight = desiredHeight;
    }

    if (loadExistingLayout) {
      if (obj.box.TopLeft !== null && obj.box.TopLeft !== undefined) n.topLeft = obj.box.TopLeft.copy();
    }

    if (d2target.isShape(obj.attributes.shape.value)) {
      const dslShape = obj.attributes.shape.value.toLowerCase();
      if (dslShape === d2target.ShapeHierarchy) n.forceHierarchy = true;
      if (Object.prototype.hasOwnProperty.call(d2target.DSL_SHAPE_TO_SHAPE_TYPE, dslShape)) {
        n.setShape(d2target.DSL_SHAPE_TO_SHAPE_TYPE[dslShape]);
      }
      if (obj.sqlTable !== null) n.setNumColumns((obj.sqlTable.columns ?? []).length);
    }
    if (obj.attributes.icon !== null) {
      n.initIcon();
      if (obj.iconPosition !== null) n.icon.position = label.fromString(obj.iconPosition);
    }
    if (obj.attributes.direction.value !== '') talaGraph.directions.set(n, parseDirection(obj.attributes.direction.value));

    n.fontSize = obj.text().fontSize;
    if (obj.class !== null || obj.sqlTable !== null) n.fontSize -= d2target.HeaderFontAdd;

    if (obj.hasLabel()) {
      n.label = new lg.Label(obj.attributes.label.value, label.Unset, obj.attributes.labelDimensions.width, obj.attributes.labelDimensions.height);
      if (obj.labelPosition !== null) n.label.position = label.fromString(obj.labelPosition);
    }

    if (obj.is3D()) n.is3D = true;
    if (obj.isMultiple()) n.isMultiple = true;

    if (obj.attributes.style.opacity !== null) {
      const [f, perr] = strconv.parseFloat64(obj.attributes.style.opacity.value);
      if (perr === null && f === 0) n.isInvisible = true;
    }
    if (!n.isInvisible) {
      let noFill = false;
      let noStroke = false;
      let noLabel = false;
      let noIcon = false;

      if (obj.attributes.style.fill !== null && d2ast.equalFold(obj.attributes.style.fill.value, 'transparent')) noFill = true;
      if (obj.attributes.style.strokeWidth !== null) {
        const [f, aerr] = strconv.atoi(obj.attributes.style.strokeWidth.value);
        if (aerr === null && f === 0) noStroke = true;
      }
      if (obj.attributes.style.stroke !== null && d2ast.equalFold(obj.attributes.style.stroke.value, 'transparent')) noStroke = true;
      if (obj.attributes.label.value === '') noLabel = true;
      if (obj.attributes.icon === null) noIcon = true;

      if (noFill && noStroke && noLabel && noIcon) n.isInvisible = true;
    }

    n.d2ID = obj.absID();

    talaGraph.addNewNodeToContainer(toNode.get(parent) ?? null, n);
  }

  for (const visit of visits) {
    err = ctx.err();
    if (err) throw err;
    const obj = visit.object;
    if (obj.attributes.nearKey !== null) {
      const nearKey = obj.attributes.nearKey;
      if (nearKey.path.length > maxInputTreeDepth) {
        throw errorf(`D2 object ${quote(obj.absID())} near key depth exceeds limit ${maxInputTreeDepth}`);
      }
      nearKey.path.forEach((part, partIndex) => {
        if (part == null || d2ast.unbox(part) == null) {
          throw errorf(`D2 object ${quote(obj.absID())} has an invalid near key part at index ${partIndex}`);
        }
      });
      const key = d2graph.key(nearKey) ?? [];
      if (key.length === 0) throw errorf(`D2 object ${quote(obj.absID())} has an empty near key`);
      const [near, found] = findD2Object(ctx, g.root, key);
      if (found) {
        const nearNode = toNode.get(near);
        if (nearNode === undefined) throw errorf(`D2 object ${quote(obj.absID())} has a near key outside the object tree`);
        toNode.get(obj).addNear(nearNode);
        continue;
      }
      if (key.length !== 1) throw errorf(`D2 object ${quote(obj.absID())} has a near key outside the object tree`);
      if (!d2ast.NearConstants.has(key[0])) throw errorf(`D2 object ${quote(obj.absID())} has a near key outside the object tree`);
    }
  }

  for (const e of gEdges) {
    err = ctx.err();
    if (err) throw err;
    if (e == null || e.src == null || e.dst == null) throw errorf('tala cannot translate an edge with a nil endpoint');

    // if connection is a <- b create it as src:b dst:a
    let talaEdge;
    const edgeID = edgeAbsIDs.get(e);
    let edgeSrc = e.src;
    let edgeDst = e.dst;
    let srcColumnIndex = e.srcTableColumnIndex;
    let dstColumnIndex = e.dstTableColumnIndex;
    const arrowheadLabel = (ah) => new lg.Label(ah.label.value, label.Unset, ah.labelDimensions.width, ah.labelDimensions.height);
    const filledOf = (ah) => {
      if (ah.style.filled === null) return null;
      const [v] = strconv.parseBool(ah.style.filled.value);
      return v;
    };
    if (e.srcArrow && !e.dstArrow) {
      [edgeSrc, edgeDst] = [edgeDst, edgeSrc];
      talaEdge = talaGraph.connect(toNode.get(edgeSrc), toNode.get(edgeDst));
      talaEdge.sourceArrowhead = lg.NoArrowhead;
      let ah = e.dstArrowhead;
      if (ah !== null) {
        if (ah.label.value !== '') talaEdge.sourceArrowheadLabel = arrowheadLabel(ah);
      }
      ah = e.srcArrowhead;
      if (ah !== null) {
        talaEdge.targetArrowhead = d2target.toArrowhead(ah.shape.value, filledOf(ah));
        if (ah.label.value !== '') talaEdge.targetArrowheadLabel = arrowheadLabel(ah);
      } else {
        talaEdge.targetArrowhead = lg.TriangleArrowhead;
      }
      [srcColumnIndex, dstColumnIndex] = [dstColumnIndex, srcColumnIndex];

      if (loadExistingLayout) {
        const route = e.route ?? [];
        for (let i = route.length - 1; i >= 0; i--) talaEdge.points.push(route[i].copy());
      }
    } else {
      // Pretend it's a self-loop, since sequence diagram lifelines aren't connected on both ends
      if (isSupportedLifelineEdge(e)) {
        edgeDst = edgeSrc;
        bindings.edgeDestinations.set(e, edgeDst);
      }
      talaEdge = talaGraph.connect(toNode.get(edgeSrc), toNode.get(edgeDst));
      let ah = e.srcArrowhead;
      if (ah !== null) {
        talaEdge.sourceArrowhead = d2target.toArrowhead(ah.shape.value, filledOf(ah));
        if (ah.label.value !== '') talaEdge.sourceArrowheadLabel = arrowheadLabel(ah);
      } else if (e.srcArrow) {
        talaEdge.sourceArrowhead = lg.TriangleArrowhead;
      } else {
        talaEdge.sourceArrowhead = lg.NoArrowhead;
      }
      ah = e.dstArrowhead;
      if (ah !== null) {
        talaEdge.targetArrowhead = d2target.toArrowhead(ah.shape.value, filledOf(ah));
        if (ah.label.value !== '') talaEdge.targetArrowheadLabel = arrowheadLabel(ah);
      } else if (e.dstArrow) {
        talaEdge.targetArrowhead = lg.TriangleArrowhead;
      } else {
        talaEdge.targetArrowhead = lg.NoArrowhead;
      }

      if (loadExistingLayout) {
        for (const p of (e.route ?? [])) talaEdge.points.push(p.copy());
      }
    }

    talaEdge.id = edgeIDs.get(e);
    bindings.edgeIDs.set(e, talaEdge.id);
    talaEdge.d2ID = edgeID;
    talaEdge.style = cloneStyle(e.attributes.style);
    const labelDims = e.attributes.labelDimensions;
    let minWidth = goInt(labelDims.width + 2 * label.PADDING);
    let minHeight = goInt(labelDims.height + 2 * label.PADDING);
    // TODO update minWidth/minHeight logic
    let l = talaEdge.sourceArrowheadLabel;
    if (l !== null) {
      const max = Math.max(l.width, l.height) + 5;
      minWidth += goInt(max);
      minHeight += goInt(max);
    }
    l = talaEdge.targetArrowheadLabel;
    if (l !== null) {
      const max = Math.max(l.width, l.height) + 5;
      minWidth += goInt(max);
      minHeight += goInt(max);
    }
    if (minWidth > maxResultCoordinate || minHeight > maxResultCoordinate) {
      throw errorf(`D2 edge ${quote(e.absID())} minimum dimensions exceed supported limit ${maxResultCoordinate}`);
    }
    talaEdge.minWidth = minWidth;
    talaEdge.minHeight = minHeight;

    if (e.attributes.label.value !== '') {
      talaEdge.label = new lg.Label(e.attributes.label.value, label.Unset, labelDims.width, labelDims.height);
      if (loadExistingLayout && e.labelPosition !== null) {
        talaEdge.label.position = label.fromString(e.labelPosition);
        if (e.labelPercentage !== null) talaEdge.labelPercentage = e.labelPercentage;
        if (e.srcArrow && !e.dstArrow) {
          // The route was reversed above. Preserve the label's physical position so rerouting reserves its actual box.
          talaEdge.label.position = label.mirrored(talaEdge.label.position);
          if (e.labelPercentage !== null || label.isUnlocked(talaEdge.label.position)) {
            talaEdge.labelPercentage = 1 - talaEdge.labelPercentage;
          }
        }
      }
    }

    if (edgeSrc.sqlTable !== null && srcColumnIndex !== null) talaEdge.fromTableColumnIndex = srcColumnIndex;
    if (edgeDst.sqlTable !== null && dstColumnIndex !== null) talaEdge.toTableColumnIndex = dstColumnIndex;
    if (e.attributes.style.opacity !== null) {
      const [f, perr] = strconv.parseFloat64(e.attributes.style.opacity.value);
      if (perr === null && f === 0) {
        talaEdge.isInvisible = true;
        talaEdge.minHeight = 0;
        talaEdge.minWidth = 0;
      }
    }
    if (e.attributes.style.stroke !== null && d2ast.equalFold(e.attributes.style.stroke.value, 'transparent')) {
      talaEdge.isInvisible = true;
    }
  }

  return bindings;
}

function cloneStyle(style) {
  // MapKey points back into the mutable D2 AST. TALA only consumes the scalar value, so do not retain that provenance in the isolated graph.
  const out = new lg.EdgeStyle();
  for (const f of lg.EDGE_STYLE_FIELDS) out[f] = style[f] === null ? null : new lg.StyleScalar(style[f].value);
  return out;
}

function parseDirection(direction) {
  switch (direction) {
    case 'up': return geo.Orientation.Top;
    case 'down': return geo.Orientation.Bottom;
    case 'left': return geo.Orientation.Left;
    case 'right': return geo.Orientation.Right;
    default: return geo.Orientation.NONE;
  }
}

// ---- seedgraph.go ----

/** newSeedInput translates a D2 graph into an isolated TALA input: {graph, bindings}. It reads but never mutates graph. */
export function newSeedInput(ctx, graph) {
  const err = ctx.err();
  if (err) throw err;
  const internal = lg.newGraph();
  const bindings = translateGraph(ctx, graph, internal, false);
  return { graph: internal, bindings };
}

// ---- adapter_validate.go ----

/** collectD2ObjectVisits validates the object tree and returns its non-root objects in D2's depth-first pre-order: [visits, objects]. */
function collectD2ObjectVisits(ctx, root) {
  if (root === null) throw errorf('tala requires a D2 graph with a root object');

  const stack = [{ object: root, parent: null, depth: 0 }];
  const parents = new Map();
  const objects = new Set();
  const visits = [];
  let scheduledObjects = 0;

  while (stack.length > 0) {
    const err = ctx.err();
    if (err) throw err;
    const visit = stack.pop();
    if (visit.object === null || visit.object === undefined) throw errorf(`D2 object tree contains a nil object at depth ${visit.depth}`);

    if (parents.has(visit.object)) {
      if (d2ObjectIsAncestor(visit.object, visit.parent, parents)) throw errorf(`D2 object ${quote(visit.object.id)} forms a ChildrenArray cycle`);
      throw errorf(`D2 object ${quote(visit.object.id)} is referenced more than once in ChildrenArray`);
    }
    if (visit.object.parent !== visit.parent) {
      throw errorf(`D2 object ${quote(visit.object.id)} has a Parent that does not match its ChildrenArray parent`);
    }
    if (visit.depth > maxInputTreeDepth) throw errorf(`D2 object nesting depth exceeds limit ${maxInputTreeDepth}`);
    parents.set(visit.object, visit.parent);

    if (visit.parent !== null) {
      if (visits.length === maxInputNodes) throw errorf(`D2 object count exceeds limit ${maxInputNodes}`);
      visits.push(visit);
      objects.add(visit.object);
    }

    const children = visit.object.childrenArray ?? [];
    if (children.length > maxInputNodes - scheduledObjects) throw errorf(`D2 object count exceeds limit ${maxInputNodes}`);
    scheduledObjects += children.length;
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push({ object: children[i], parent: visit.object, depth: visit.depth + 1 });
    }
  }

  return [visits, objects];
}

function d2ObjectIsAncestor(ancestor, object, parents) {
  while (object !== null && object !== undefined) {
    if (object === ancestor) return true;
    object = parents.get(object) ?? null;
  }
  return false;
}

function validateD2Objects(ctx, visits, requirePosition) {
  let tableColumns = 0;
  visits.forEach((visit, objectIndex) => {
    const err = ctx.err();
    if (err) throw err;
    const object = visit.object;
    if (object.box === null || object.box === undefined) throw errorf(`D2 object ${objectIndex} (${quote(object.id)}) has no box`);
    const tl = object.box.TopLeft ?? null;
    if (requirePosition && tl === null) throw errorf(`D2 object ${quote(object.id)} has no top-left position`);
    try {
      validateResultDimension('width', object.box.Width, false);
    } catch (e) {
      throw wrapObject(object, e);
    }
    try {
      validateResultDimension('height', object.box.Height, false);
    } catch (e) {
      throw wrapObject(object, e);
    }
    if (tl !== null) {
      for (const [name, v] of [['top-left x', tl.x], ['top-left y', tl.y], ['bottom-right x', tl.x + object.box.Width], ['bottom-right y', tl.y + object.box.Height]]) {
        try {
          validateResultCoordinate(name, v);
        } catch (e) {
          throw wrapObject(object, e);
        }
      }
    }
    try {
      validateD2TextDimensions('label', object.attributes.labelDimensions);
    } catch (e) {
      throw wrapObject(object, e);
    }
    validateD2Style('D2 object ' + quote(object.id), object.attributes.style);
    if (object.labelPosition !== null && !label.isShapePosition(label.fromString(object.labelPosition))) {
      throw errorf(`D2 object ${quote(object.id)} has invalid label position ${quote(object.labelPosition)}`);
    }
    if (object.iconPosition !== null && !label.isShapePosition(label.fromString(object.iconPosition))) {
      throw errorf(`D2 object ${quote(object.id)} has invalid icon position ${quote(object.iconPosition)}`);
    }
    if ((object.attributes.top === null) !== (object.attributes.left === null)) {
      throw errorf(`D2 object ${quote(object.id)} must set top and left together for a locked position`);
    }
    if (object.attributes.top !== null) parseD2IntegerAttribute(object.id, 'top', object.attributes.top, -maxResultCoordinate, maxResultCoordinate);
    if (object.attributes.left !== null) parseD2IntegerAttribute(object.id, 'left', object.attributes.left, -maxResultCoordinate, maxResultCoordinate);
    if (object.attributes.widthAttr !== null) parseD2IntegerAttribute(object.id, 'width', object.attributes.widthAttr, 1, maxResultCoordinate);
    if (object.attributes.heightAttr !== null) parseD2IntegerAttribute(object.id, 'height', object.attributes.heightAttr, 1, maxResultCoordinate);

    let fontSize = object.text().fontSize;
    if (object.class !== null || object.sqlTable !== null) fontSize -= d2target.HeaderFontAdd;
    if (fontSize <= 0 || fontSize > maxResultCoordinate) {
      throw errorf(`D2 object ${quote(object.id)} has unsupported effective font size ${fontSize}`);
    }

    if (object.sqlTable !== null) {
      if (object.attributes.shape.value !== d2target.ShapeSQLTable) {
        throw errorf(`D2 object ${quote(object.id)} has SQL columns but is not an SQL table`);
      }
      const columns = object.sqlTable.columns ?? [];
      if (columns.length > maxInputNodes - tableColumns) throw errorf(`D2 SQL table column count exceeds limit ${maxInputNodes}`);
      tableColumns += columns.length;
    }
  });
}

const wrapObject = (object, e) => errorf(`D2 object ${quote(object.id)}: ${e.message}`, e);

function validateD2Style(owner, style) {
  if (style.opacity !== null) {
    const [value, perr] = strconv.parseFloat64(style.opacity.value);
    if (perr !== null || Number.isNaN(value) || !Number.isFinite(value) || value < 0 || value > 1) {
      throw errorf(`${owner} has invalid opacity ${quote(style.opacity.value)}`);
    }
  }
  for (const [name, value, min] of [['stroke-width', style.strokeWidth, 0], ['font-size', style.fontSize, 1]]) {
    if (value === null) continue;
    const [v, aerr] = strconv.atoi(value.value);
    if (aerr !== null || v < min || v > maxResultCoordinate) throw errorf(`${owner} has invalid ${name} ${quote(value.value)}`);
  }
  for (const [name, value] of [['animated', style.animated], ['bold', style.bold], ['double-border', style.doubleBorder], ['filled', style.filled],
    ['italic', style.italic], ['multiple', style.multiple], ['shadow', style.shadow], ['3d', style.threeDee], ['underline', style.underline]]) {
    if (value === null) continue;
    const [, berr] = strconv.parseBool(value.value);
    if (berr !== null) throw errorf(`${owner} has invalid ${name} boolean ${quote(value.value)}`);
  }
}

/** parseD2IntegerAttribute: [value] (throws on an invalid attribute) */
function parseD2IntegerAttribute(objectID, name, scalar, minValue, maxValue) {
  const [value, err] = strconv.atoi(scalar.value);
  if (err !== null) throw errorf(`D2 object ${quote(objectID)} has invalid integer ${name} attribute ${quote(scalar.value)}`);
  if (value < minValue || value > maxValue) {
    throw errorf(`D2 object ${quote(objectID)} ${name} attribute must be between ${minValue} and ${maxValue}`);
  }
  return [value];
}

function validateD2TextDimensions(name, dimensions) {
  if (dimensions.width < 0 || dimensions.height < 0) throw errorf(`${name} dimensions must be nonnegative`);
  if (dimensions.width > maxResultCoordinate || dimensions.height > maxResultCoordinate) {
    throw errorf(`${name} dimensions exceed supported limit ${maxResultCoordinate}`);
  }
}

/** findD2Object: [object, found] */
function findD2Object(ctx, root, key) {
  if (key.length > maxInputTreeDepth) throw errorf(`D2 near key depth exceeds limit ${maxInputTreeDepth}`);
  let object = root;
  for (const id of key) {
    const err = ctx.err();
    if (err) throw err;
    if (object === null) throw errorf(`D2 near key traverses a nil object before ${quote(id)}`);
    const child = object.children === null ? undefined : object.children.get(d2ast.goLower(id));
    if (child === undefined) return [null, false];
    if (child === null) throw errorf(`D2 object ${quote(object.id)} has a nil child for near key part ${quote(id)}`);
    object = child;
  }
  return [object, true];
}

/**
 * validateRequestedD2Edges bounds subset validation before allocating maps or translating the graph. Every requested edge must be a
 * distinct member of g.
 */
export function validateRequestedD2Edges(g, edges) {
  if (edges.length > maxInputEdges) throw errorf(`requested D2 edge count exceeds limit ${maxInputEdges}`);
  const requested = new Set();
  edges.forEach((edge, index) => {
    if (edge == null) throw errorf(`requested D2 edge ${index} is nil`);
    if (requested.has(edge)) throw errorf(`requested D2 edge ${index} is repeated`);
    requested.add(edge);
  });
  if (g == null) return;
  const gEdges = g.edges ?? [];
  if (gEdges.length > maxInputEdges) throw errorf(`D2 edge count exceeds limit ${maxInputEdges}`);
  if (edges.length > gEdges.length) throw errorf(`requested D2 edge count ${edges.length} exceeds graph edge count ${gEdges.length}`);
  const graphEdges = new Set(gEdges);
  edges.forEach((edge, index) => {
    if (!graphEdges.has(edge)) throw errorf(`requested D2 edge ${index} is not in the graph`);
  });
}

/**
 * validateD2GraphStructure keeps D2's three public topology views coherent: the adapter traverses ChildrenArray, resolves near keys
 * through Children, and applies results through Graph.Objects.
 */
function validateD2GraphStructure(g, visits, objects) {
  if (g.root.graph !== g) throw errorf('D2 root object belongs to a different graph');

  const allObjects = [g.root, ...visits.map((v) => v.object)];
  for (const object of allObjects) {
    if (object.graph !== g) throw errorf(`D2 object ${quote(object.id)} belongs to a different graph`);
    const childrenSize = object.children === null ? 0 : object.children.size;
    const array = object.childrenArray ?? [];
    if (childrenSize !== array.length) throw errorf(`D2 object ${quote(object.id)} has inconsistent Children and ChildrenArray sets`);
    for (const child of array) {
      const mapped = object.children === null ? undefined : object.children.get(d2ast.goLower(child.id));
      if (mapped === undefined || mapped !== child) throw errorf(`D2 object ${quote(object.id)} has inconsistent Children and ChildrenArray sets`);
    }
  }

  const gObjects = g.objects ?? [];
  if (gObjects.length !== visits.length) throw errorf('D2 graph Objects and object tree contain different sets');
  const seen = new Set();
  gObjects.forEach((object, index) => {
    if (object == null) throw errorf(`D2 graph Objects contains nil at index ${index}`);
    if (seen.has(object)) throw errorf(`D2 graph Objects repeats object ${quote(object.id)}`);
    seen.add(object);
    if (!objects.has(object)) throw errorf(`D2 graph Objects contains object ${quote(object.id)} outside the object tree`);
  });
}

function isSupportedLifelineEdge(edge) {
  if (edge.srcArrow || edge.dstArrow || edge.srcArrowhead !== null || edge.dstArrowhead !== null) return false;
  return d2sequence.isLifelineEnd(edge.dst) && edge.dst.id === d2sequence.lifelineEndID(edge.src.id);
}

function validateD2Edges(ctx, edges, objects) {
  if (edges.length > maxInputEdges) throw errorf(`D2 edge count exceeds limit ${maxInputEdges}`);

  const seen = new Set();
  let routePoints = 0;
  edges.forEach((edge, edgeIndex) => {
    const err = ctx.err();
    if (err) throw err;
    if (edge == null) throw errorf(`D2 edge ${edgeIndex} is nil`);
    if (seen.has(edge)) throw errorf(`D2 edge ${edgeIndex} is repeated`);
    seen.add(edge);
    if (edge.src == null || edge.dst == null) throw errorf(`D2 edge ${edgeIndex} has a nil endpoint`);
    try {
      validateD2TextDimensions('label', edge.attributes.labelDimensions);
    } catch (e) {
      throw errorf(`D2 edge ${edgeIndex}: ${e.message}`, e);
    }
    validateD2Style(`D2 edge ${edgeIndex}`, edge.attributes.style);
    if (edge.labelPosition !== null && !label.isEdgePosition(label.fromString(edge.labelPosition))) {
      throw errorf(`D2 edge ${edgeIndex} has invalid label position ${quote(edge.labelPosition)}`);
    }
    const p = edge.labelPercentage;
    if (p !== null && (Number.isNaN(p) || !Number.isFinite(p) || p < 0 || p > 1)) {
      throw errorf(`D2 edge ${edgeIndex} has invalid label percentage ${goV(p)}: must be finite and between 0 and 1`);
    }
    if (edge.srcArrowhead !== null) {
      validateD2Arrowhead(edgeIndex, 'source', edge.srcArrowhead);
      try {
        validateD2TextDimensions('source arrowhead label', edge.srcArrowhead.labelDimensions);
      } catch (e) {
        throw errorf(`D2 edge ${edgeIndex}: ${e.message}`, e);
      }
    }
    if (edge.dstArrowhead !== null) {
      validateD2Arrowhead(edgeIndex, 'destination', edge.dstArrowhead);
      try {
        validateD2TextDimensions('destination arrowhead label', edge.dstArrowhead.labelDimensions);
      } catch (e) {
        throw errorf(`D2 edge ${edgeIndex}: ${e.message}`, e);
      }
    }
    if (!objects.has(edge.src)) throw errorf(`D2 edge ${edgeIndex} has a source outside the object tree`);
    if (!objects.has(edge.dst)) {
      if (!isSupportedLifelineEdge(edge)) throw errorf(`D2 edge ${edgeIndex} has a destination outside the object tree`);
    }
    validateD2TableColumnIndex(edgeIndex, 'source', edge.src, edge.srcTableColumnIndex);
    validateD2TableColumnIndex(edgeIndex, 'destination', edge.dst, edge.dstTableColumnIndex);

    const route = edge.route ?? [];
    if (route.length > maxInputRoutePoints - routePoints) throw errorf(`D2 route point count exceeds limit ${maxInputRoutePoints}`);
    if (route.length === 1) throw errorf(`D2 edge ${edgeIndex} route requires either zero or at least two points`);
    routePoints += route.length;
    route.forEach((point, pointIndex) => {
      if (pointIndex % 256 === 0) {
        const cerr = ctx.err();
        if (cerr) throw cerr;
      }
      if (point == null) throw errorf(`D2 edge ${edgeIndex} has a nil route point at index ${pointIndex}`);
      for (const [name, v] of [['route x', point.x], ['route y', point.y]]) {
        try {
          validateResultCoordinate(name, v);
        } catch (e) {
          throw errorf(`D2 edge ${edgeIndex} route point ${pointIndex}: ${e.message}`, e);
        }
      }
      if (pointIndex > 0 && point.x === route[pointIndex - 1].x && point.y === route[pointIndex - 1].y) {
        throw errorf(`D2 edge ${edgeIndex} has a degenerate route segment ending at index ${pointIndex}`);
      }
    });
  });
}

function validateD2Arrowhead(edgeIndex, endpoint, attributes) {
  if (attributes.shape.value !== '') {
    if (!d2target.Arrowheads.has(attributes.shape.value)) {
      throw errorf(`D2 edge ${edgeIndex} has unsupported ${endpoint} arrowhead ${quote(attributes.shape.value)}`);
    }
  }
  validateD2Style(`D2 edge ${edgeIndex} ${endpoint} arrowhead`, attributes.style);
}

function validateD2TableColumnIndex(edgeIndex, endpointName, object, index) {
  if (index === null) return;
  if (object.sqlTable === null) throw errorf(`D2 edge ${edgeIndex} has a ${endpointName} table column index for a non-table object`);
  const columns = object.sqlTable.columns ?? [];
  if (index < 0 || index >= columns.length) {
    throw errorf(`D2 edge ${edgeIndex} ${endpointName} table column index ${index} is outside table with ${columns.length} columns`);
  }
}

// result_validate.go: the checks the adapter shares with the result validation (the rest of that file is the engine stage's)

/** isFiniteResultNumber */
export const isFiniteResultNumber = (value) => !Number.isNaN(value) && Number.isFinite(value);

/** validateResultCoordinate: a finite coordinate within +-maxResultCoordinate (throws) */
export function validateResultCoordinate(name, value) {
  if (!isFiniteResultNumber(value) || Math.abs(value) > maxResultCoordinate) {
    throw errorf(`${name} is outside the finite supported range: ${goV(value)}`);
  }
}

/** validateResultDimension: finite, nonnegative, and (unless zeroAllowed) positive (throws) */
export function validateResultDimension(name, value, zeroAllowed) {
  if (!isFiniteResultNumber(value) || value < 0 || (!zeroAllowed && value === 0) || value > maxResultCoordinate) {
    throw errorf(`${name} is outside the supported range: ${goV(value)}`);
  }
}
