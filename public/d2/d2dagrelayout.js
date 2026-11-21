// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of D2's d2layouts/d2dagrelayout package (D2 v0.9.0, Copyright 2022 Terrastruct Inc.):
// layout.go and object_mapper.go, the Go glue around dagre.
//
// In v0.9.0 the glue calls dagro, a native Go port of dagre 3.1.1. Here the same calls go to dagre 3.1.1 itself (npm
// @dagrejs/dagre, MIT), vendored in vendor/dagre.js with the three source corrections dagro applies to it (see
// vendor/README.txt). dagre is an ES module without module state, so nothing needs `eval`.

import { sortSlice } from './gosort.js';
import * as d2graph from './d2graph.js';
import * as d2target from './target.js';
import * as geo from './geo.js';
import * as label from './label.js';
import * as shape from './shape.js';
import { goRound, goInt } from './gomath.js';
import { quote as goQuote } from './url.js';
import dagre from './vendor/dagre.js';

export const MIN_RANK_SEP = 60;
export const EDGE_LABEL_GAP = 20;
export const DEFAULT_PADDING = 30.;
export const MIN_SPACING = 10.;

export const DefaultOpts = { nodesep: 60, edgesep: 20 };

/** Kept for callers of the previous (JS runtime based) engine: dagre is imported statically now, there is nothing to load. */
export async function loadDagre() {}

// ---- object mapper (object_mapper.go) ----

class ObjectMapper {
  constructor() {
    this.objToID = new Map();
    this.idToObj = new Map();
  }

  register(obj) {
    const id = String(this.idToObj.size);
    this.idToObj.set(id, obj);
    this.objToID.set(obj, id);
  }

  toID(obj) {
    return this.objToID.get(obj) ?? '';
  }

  toObj(id) {
    return this.idToObj.get(id) ?? null;
  }
}

const get0 = (m, k) => m.get(k) ?? 0;

// ---- Layout ----

/** DefaultLayout */
export function defaultLayout(g) {
  return layout(g, null);
}

/**
 * Layout runs dagre on the graph g.
 * @returns {void} throws Error('failed to dagre layout: ...') on failure (as Go wraps its error)
 */
export function layout(g, opts) {
  try {
    layout_(g, opts);
  } catch (e) {
    if (e && e.name === 'NeedLatex') throw e;
    const err = new Error(`failed to dagre layout: ${e && e.message !== undefined ? e.message : e}`);
    err.cause = e;
    throw err;
  }
}

function layout_(g, opts) {
  if (opts === null || opts === undefined) opts = DefaultOpts;

  const rootAttrs = { nodesep: opts.nodesep, edgesep: opts.edgesep, ranksep: 0, rankdir: '' };
  let isHorizontal = false;
  switch (g.root.attributes.direction.value) {
    case 'down':
      rootAttrs.rankdir = 'TB';
      break;
    case 'right':
      rootAttrs.rankdir = 'LR';
      isHorizontal = true;
      break;
    case 'left':
      rootAttrs.rankdir = 'RL';
      isHorizontal = true;
      break;
    case 'up':
      rootAttrs.rankdir = 'BT';
      break;
    default:
      rootAttrs.rankdir = 'TB';
  }

  const objects = g.objects || [];
  const edges = g.edges || [];

  // set label and icon positions for dagre
  for (const obj of objects) positionLabelsIcons(obj);

  let maxLabelWidth = 0;
  let maxLabelHeight = 0;
  for (const edge of edges) {
    const width = edge.attributes.labelDimensions.width;
    const height = edge.attributes.labelDimensions.height;
    maxLabelWidth = Math.max(maxLabelWidth, width);
    maxLabelHeight = Math.max(maxLabelHeight, height);
  }

  if (!isHorizontal) rootAttrs.ranksep = Math.max(100, maxLabelHeight + 40);
  else rootAttrs.ranksep = Math.max(100, maxLabelWidth + 40);

  const mapper = new ObjectMapper();
  for (const obj of objects) mapper.register(obj);
  const resolver = newEndpointResolver(g);
  // endpointPair is a comparable struct in Go: pairs are keyed by their two (object) ids
  const pairKey = (src, dst) => `${mapper.toID(src)}\u0000${mapper.toID(dst)}`;
  const resolvedEndpoints = new Map();
  const directedPairCounts = new Map();
  for (const edge of edges) {
    const [src, dst] = resolver.resolve(edge);
    resolvedEndpoints.set(edge, { src, dst });
    const k = pairKey(src, dst);
    directedPairCounts.set(k, get0(directedPairCounts, k) + 1);
  }

  const dagreGraph = new dagre.graphlib.Graph({ compound: true, multigraph: true }).setGraph({
    ranksep: rootAttrs.ranksep,
    edgesep: rootAttrs.edgesep,
    nodesep: rootAttrs.nodesep,
    rankdir: rootAttrs.rankdir,
  });
  for (const obj of objects) {
    const id = mapper.toID(obj);
    dagreGraph.setNode(id, {
      id,
      width: goInt(obj.box.Width),
      height: goInt(obj.box.Height),
    });
    if (obj.parent !== g.root) dagreGraph.setParent(id, mapper.toID(obj.parent));
  }

  for (const edge of edges) {
    const { src, dst } = resolvedEndpoints.get(edge);

    let width = edge.attributes.labelDimensions.width;
    let height = edge.attributes.labelDimensions.height;

    let numEdges = get0(directedPairCounts, pairKey(src, dst));
    if (src !== dst) numEdges += get0(directedPairCounts, pairKey(dst, src));

    // We want to leave some gap between multiple edges
    if (numEdges > 1) {
      switch (g.root.attributes.direction.value) {
        case 'down': case 'up': case '':
          width += EDGE_LABEL_GAP;
          break;
        case 'left': case 'right':
          height += EDGE_LABEL_GAP;
          break;
      }
    }

    dagreGraph.setEdge(mapper.toID(src), mapper.toID(dst), { width, height, labelpos: 'c' }, edge.absID());
  }

  dagre.layout(dagreGraph);

  for (const id of dagreGraph.nodes()) {
    const dn = dagreGraph.node(id);
    if (dn === null || typeof dn !== 'object') throw new Error(`dagro returned invalid node label for ${goQuote(id)}`);
    if (typeof dn.id !== 'string') throw new Error(`dagro returned node ${goQuote(id)} without an id`);
    const obj = mapper.toObj(dn.id);
    if (obj === null) throw new Error(`dagro returned unknown node id ${goQuote(dn.id)}`);
    const { x, y, width, height } = dn;
    if (typeof x !== 'number' || typeof y !== 'number' || typeof width !== 'number' || typeof height !== 'number') {
      throw new Error(`dagro returned invalid geometry for node ${goQuote(id)}`);
    }

    // dagre gives center of node
    obj.box.TopLeft = geo.newPoint(goRound(x - width / 2), goRound(y - height / 2));
    obj.box.Width = Math.ceil(width);
    obj.box.Height = Math.ceil(height);
  }

  const dagreEdges = dagreGraph.edges();
  if (dagreEdges.length !== edges.length) {
    throw new Error(`dagro returned ${dagreEdges.length} edges, expected ${edges.length}`);
  }
  for (let i = 0; i < edges.length; i++) {
    const edge = edges[i];
    const de = dagreGraph.edge(dagreEdges[i]);
    if (de === null || typeof de !== 'object') throw new Error(`dagro returned invalid edge label for ${goQuote(dagreEdges[i].name)}`);
    const dagrePoints = de.points;
    if (!Array.isArray(dagrePoints)) throw new Error(`dagro returned edge ${goQuote(dagreEdges[i].name)} without points`);

    let points = new Array(dagrePoints.length);
    for (let j = 0; j < dagrePoints.length; j++) {
      const p = geo.newPoint(dagrePoints[j].x, dagrePoints[j].y);
      if (edge.srcArrow && !edge.dstArrow) points[dagrePoints.length - j - 1] = p;
      else points[j] = p;
    }
    // Dagre 3.1 self-loop routes contain repeated control points. Remove only
    // consecutive duplicates so downstream tangent calculations never see a
    // zero-length segment.
    points = deduplicateRoutePoints(points);
    if (edge.src === edge.dst) {
      // The self-loop controls describe the loop outside the node, but do not
      // include usable node-facing endpoints. Center sentinels give
      // TraceToShape a direction from which to chop the route to each border.
      const center = edge.src.box.center();
      points = [center.copy(), ...points];
      points.push(center.copy());
    }
    if (points.length < 2) {
      throw new Error(`dagro returned edge ${goQuote(dagreEdges[i].name)} without a usable route`);
    }

    let startIndex = 0, endIndex = points.length - 1;
    let start = points[startIndex], end = points[endIndex];

    // chop where edge crosses the source/target boxes since container edges were routed to a descendant
    if (edge.src !== edge.dst) {
      for (let j = 1; j < points.length; j++) {
        const segment = geo.newSegment(points[j - 1], points[j]);
        let intersections = edge.src.box.intersections(segment);
        if (intersections.length > 0) {
          start = intersections[0];
          startIndex = j - 1;
        }

        intersections = edge.dst.box.intersections(segment);
        if (intersections.length > 0) {
          end = intersections[0];
          endIndex = j;
          break;
        }
      }
    }
    points = points.slice(startIndex, endIndex + 1);
    points[0] = start;
    points[points.length - 1] = end;

    edge.route = points;
  }

  adjustRankSpacing(g, rootAttrs.ranksep, isHorizontal);
  adjustCrossRankSpacing(g, rootAttrs.ranksep, !isHorizontal);
  fitContainerPadding(g, rootAttrs.ranksep, isHorizontal);

  for (const edge of edges) {
    let points = edge.route;
    let startIndex = 0, endIndex = points.length - 1;
    let start = points[startIndex], end = points[endIndex];

    // arrowheads can appear broken if segments are very short from dagre routing a point just outside the shape
    // to fix this, we try extending the previous segment into the shape instead of having a very short segment
    if (startIndex + 2 < points.length) {
      const newStartingSegment = geo.newSegment(start, points[startIndex + 1]);
      if (newStartingSegment.length() < d2graph.MIN_SEGMENT_LEN) {
        // we don't want a very short segment right next to the source because it will mess up the arrowhead
        // instead we want to extend the next segment into the shape border if possible
        const nextStart = points[startIndex + 1];
        const nextEnd = points[startIndex + 2];

        // Note: in other direction to extend towards source
        const nextSegment = geo.newSegment(nextStart, nextEnd);
        const v = nextSegment.toVector();
        const extendedStart = nextEnd.toVector().add(v.addLength(d2graph.MIN_SEGMENT_LEN)).toPoint();
        const extended = geo.newSegment(nextEnd, extendedStart);

        const intersections = edge.src.box.intersections(extended);
        if (intersections.length > 0) {
          startIndex++;
          points[startIndex] = intersections[0];
          start = points[startIndex];
        }
      }
    }
    if (endIndex - 2 >= 0) {
      const newEndingSegment = geo.newSegment(end, points[endIndex - 1]);
      if (newEndingSegment.length() < d2graph.MIN_SEGMENT_LEN) {
        // extend the prev segment into the shape border if possible
        const prevStart = points[endIndex - 2];
        const prevEnd = points[endIndex - 1];

        const prevSegment = geo.newSegment(prevStart, prevEnd);
        const v = prevSegment.toVector();
        const extendedEnd = prevStart.toVector().add(v.addLength(d2graph.MIN_SEGMENT_LEN)).toPoint();
        const extended = geo.newSegment(prevStart, extendedEnd);

        const intersections = edge.dst.box.intersections(extended);
        if (intersections.length > 0) {
          endIndex--;
          points[endIndex] = intersections[0];
          end = points[endIndex];
        }
      }
    }

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

    // build a curved path from the dagre route
    const vectors = [];
    for (let i = 1; i < points.length; i++) vectors.push(points[i - 1].vectorTo(points[i]));

    const path = [];
    path.push(points[0]);
    if (vectors.length > 1) {
      path.push(points[0].addVector(vectors[0].multiply(.8)));
      for (let i = 1; i < vectors.length - 2; i++) {
        const p = points[i];
        const v = vectors[i];
        path.push(p.addVector(v.multiply(.2)));
        path.push(p.addVector(v.multiply(.5)));
        path.push(p.addVector(v.multiply(.8)));
      }
      path.push(points[points.length - 2].addVector(vectors[vectors.length - 1].multiply(.2)));
      edge.isCurve = true;
    }
    path.push(points[points.length - 1]);

    edge.route = path;
    // compile needs to assign edge label positions
    if (edge.attributes.label.value !== '') edge.labelPosition = label.positionString(label.InsideMiddleCenter);

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
}

function deduplicateRoutePoints(points) {
  if (points.length < 2) return points;
  const deduplicated = [points[0]];
  for (const point of points.slice(1)) {
    if (!point.equals(deduplicated[deduplicated.length - 1])) deduplicated.push(point);
  }
  return deduplicated;
}

class EndpointResolver {
  constructor(g) {
    this.g = g;
    this.containers = new Map();
  }

  head(container) {
    return this.endpoints(container).head;
  }

  tail(container) {
    return this.endpoints(container).tail;
  }

  endpoints(container) {
    let endpoints = this.containers.get(container);
    if (endpoints === undefined) {
      const [head, tail] = getLongestEdgeChainEndpoints(this.g, container);
      endpoints = { head, tail };
      this.containers.set(container, endpoints);
    }
    return endpoints;
  }

  resolve(edge) {
    // dagre doesn't work with edges to containers so we connect container edges to their first child instead (going all the way down)
    // we will chop the edge where it intersects the container border so it only shows the edge from the container
    let src = edge.src;
    while (src.children !== null && src.children.size > 0 && src.class === null && src.sqlTable === null) {
      // We want to get the bottom node of sources, setting its rank higher than all children
      src = this.tail(src);
    }
    let dst = edge.dst;
    while (dst.children !== null && dst.children.size > 0 && dst.class === null && dst.sqlTable === null) {
      dst = this.head(dst);
    }
    if (edge.srcArrow && !edge.dstArrow) {
      // for `b <- a`, edge.Edge is `a -> b` and we expect this routing result
      [src, dst] = [dst, src];
    }
    return [src, dst];
  }
}

function newEndpointResolver(g) {
  return new EndpointResolver(g);
}

const MIN_INT32 = -2147483648;

class ContainerTopology {
  constructor(container) {
    this.container = container;
    this.hasIncoming = new Map();
    this.outgoing = new Map();
  }

  longestChainEndpoints() {
    const rank = new Map();
    const chainLength = new Map();

    for (const obj of this.container.childrenArray) {
      if (this.hasIncoming.get(obj) === true) continue;
      rank.set(obj, 1);
      chainLength.set(obj, 1);
      let queue = [obj];
      const visited = new Set();
      while (queue.length > 0) {
        const curr = queue[0];
        queue = queue.slice(1);
        if (visited.has(curr)) continue;
        visited.add(curr);
        for (const child of this.outgoing.get(curr) || []) {
          if (get0(rank, curr) + 1 > get0(rank, child)) {
            rank.set(child, get0(rank, curr) + 1);
            chainLength.set(obj, Math.max(get0(chainLength, obj), get0(rank, child)));
          }
          queue.push(child);
        }
      }
    }

    let maxChainLength = MIN_INT32;
    let maxRank = MIN_INT32;
    for (const obj of this.container.childrenArray) {
      maxChainLength = Math.max(maxChainLength, get0(chainLength, obj));
      maxRank = Math.max(maxRank, get0(rank, obj));
    }

    const heads = [], tails = [];
    for (const obj of this.container.childrenArray) {
      if (get0(rank, obj) === 1 && get0(chainLength, obj) === maxChainLength) heads.push(obj);
      if (get0(rank, obj) === maxRank) tails.push(obj);
    }

    let head = this.container.childrenArray[0];
    if (heads.length > 0) head = heads[Math.trunc(heads.length / 2)];
    return [head, tails[Math.trunc(tails.length / 2)]];
  }
}

function newContainerTopology(g, container) {
  const topology = new ContainerTopology(container);
  for (const edge of g.edges || []) {
    const src = inContainer(edge.src, container);
    const dst = inContainer(edge.dst, container);
    if (src === null || dst === null) continue;

    // The original head test counts every edge from anywhere in the
    // container to a direct child's subtree, including internal edges.
    if (dst !== container) topology.hasIncoming.set(dst, true);

    // Preserve edge order and duplicates: the breadth-first walk's rank
    // updates are order-sensitive even though the graph is usually acyclic.
    if (src !== dst) {
      if (!topology.outgoing.has(src)) topology.outgoing.set(src, []);
      topology.outgoing.get(src).push(dst);
    }
    // A container can enter the old traversal when an edge terminates on
    // it. From there, every edge whose source is inside it is reachable.
    if (src !== container && dst !== container) {
      if (!topology.outgoing.has(container)) topology.outgoing.set(container, []);
      topology.outgoing.get(container).push(dst);
    }
  }
  return topology;
}

function getLongestEdgeChainEndpoints(g, container) {
  return newContainerTopology(g, container).longestChainEndpoints();
}

function inContainer(obj, container) {
  if (obj === null) return null;
  if (obj === container) return obj;
  if (obj.parent === container) return obj;
  return inContainer(obj.parent, container);
}

function positionLabelsIcons(obj) {
  const hasChildren = (obj.childrenArray || []).length > 0;
  if (obj.attributes.icon !== null && obj.iconPosition === null) {
    if (hasChildren) {
      obj.iconPosition = label.positionString(label.OutsideTopLeft);
      if (obj.labelPosition === null) {
        obj.labelPosition = label.positionString(label.OutsideTopRight);
        return;
      }
    } else if (obj.sqlTable !== null || obj.class !== null || obj.attributes.language !== '') {
      obj.iconPosition = label.positionString(label.OutsideTopLeft);
    } else {
      obj.iconPosition = label.positionString(label.InsideMiddleCenter);
    }
  }
  if (obj.hasLabel() && obj.labelPosition === null) {
    if (hasChildren) obj.labelPosition = label.positionString(label.OutsideTopCenter);
    else if (obj.hasOutsideBottomLabel()) obj.labelPosition = label.positionString(label.OutsideBottomCenter);
    else if (obj.attributes.icon !== null) obj.labelPosition = label.positionString(label.InsideTopCenter);
    else obj.labelPosition = label.positionString(label.InsideMiddleCenter);
    if (obj.attributes.labelDimensions.width > obj.box.Width || obj.attributes.labelDimensions.height > obj.box.Height) {
      if (hasChildren) obj.labelPosition = label.positionString(label.OutsideTopCenter);
      else obj.labelPosition = label.positionString(label.OutsideBottomCenter);
    }
  }
}

function getRanks(g, isHorizontal) {
  const alignedObjects = new Map();
  for (const obj of g.objects || []) {
    if (!obj.isContainer()) {
      let key;
      if (!isHorizontal) key = Math.ceil(obj.box.TopLeft.y + obj.box.Height / 2);
      else key = Math.ceil(obj.box.TopLeft.x + obj.box.Width / 2);
      if (!alignedObjects.has(key)) alignedObjects.set(key, []);
      alignedObjects.get(key).push(obj);
    }
  }

  const levels = [];
  for (const l of alignedObjects.keys()) levels.push(l);
  sortSlice(levels, (i, j) => levels[i] < levels[j]);

  const ranks = [];
  const objectRanks = new Map();
  for (let i = 0; i < levels.length; i++) {
    const l = levels[i];
    for (const obj of alignedObjects.get(l)) objectRanks.set(obj, i);
    ranks.push(alignedObjects.get(l));
  }

  const startingParentRanks = new Map();
  const endingParentRanks = new Map();
  for (const obj of g.objects || []) {
    if (obj.isContainer()) continue;
    const r = get0(objectRanks, obj);
    // update all ancestor's min/max ranks
    for (let parent = obj.parent; parent !== null && parent !== g.root; parent = parent.parent) {
      if (!startingParentRanks.has(parent) || r < startingParentRanks.get(parent)) startingParentRanks.set(parent, r);
      if (!endingParentRanks.has(parent) || r > endingParentRanks.get(parent)) endingParentRanks.set(parent, r);
    }
  }

  return [ranks, objectRanks, startingParentRanks, endingParentRanks];
}

// shift everything down by distance if it is at or below start position
function shiftDown(g, start, distance, isHorizontal) {
  if (isHorizontal) {
    for (const edge of g.edges || []) {
      const first = edge.route[0], last = edge.route[edge.route.length - 1];
      if (start <= first.x) {
        const onStaticSrc = first.x === edge.src.box.TopLeft.x + edge.src.box.Width && edge.src.box.TopLeft.x < start;
        if (!onStaticSrc) {
          // src is not shifting and we are on src so don't shift
          first.x += distance;
        }
      }
      if (start <= last.x) {
        const onStaticDst = last.x === edge.dst.box.TopLeft.x + edge.dst.box.Width && edge.dst.box.TopLeft.x < start;
        if (!onStaticDst) last.x += distance;
      }
      for (let i = 1; i < edge.route.length - 1; i++) {
        const p = edge.route[i];
        if (p.x < start) continue;
        p.x += distance;
      }
    }
    for (const obj of g.objects || []) {
      if (obj.box.TopLeft.x < start) continue;
      obj.box.TopLeft.x += distance;
    }
  } else {
    for (const edge of g.edges || []) {
      const first = edge.route[0], last = edge.route[edge.route.length - 1];
      if (start <= first.y) {
        const onStaticSrc = first.y === edge.src.box.TopLeft.y + edge.src.box.Height && edge.src.box.TopLeft.y < start;
        if (!onStaticSrc) {
          // src is not shifting and we are on src so don't shift
          first.y += distance;
        }
      }
      if (start <= last.y) {
        const onStaticDst = last.y === edge.dst.box.TopLeft.y + edge.dst.box.Height && edge.dst.box.TopLeft.y < start;
        if (!onStaticDst) last.y += distance;
      }
      for (let i = 1; i < edge.route.length - 1; i++) {
        const p = edge.route[i];
        if (p.y < start) continue;
        p.y += distance;
      }
    }
    for (const obj of g.objects || []) {
      if (obj.box.TopLeft.y < start) continue;
      obj.box.TopLeft.y += distance;
    }
  }
}

function shiftUp(g, start, distance, isHorizontal) {
  if (isHorizontal) {
    for (const edge of g.edges || []) {
      const first = edge.route[0], last = edge.route[edge.route.length - 1];
      if (first.x <= start) {
        const onStaticSrc = first.x === edge.src.box.TopLeft.x && start < edge.src.box.TopLeft.x + edge.src.box.Width;
        if (!onStaticSrc) {
          // src is not shifting and we are on src so don't shift
          first.x -= distance;
        }
      }
      if (last.x <= start) {
        const onStaticDst = last.x === edge.dst.box.TopLeft.x && start < edge.dst.box.TopLeft.x + edge.dst.box.Width;
        if (!onStaticDst) last.x -= distance;
      }
      for (let i = 1; i < edge.route.length - 1; i++) {
        const p = edge.route[i];
        if (start < p.x) continue;
        p.x -= distance;
      }
    }
    for (const obj of g.objects || []) {
      if (start < obj.box.TopLeft.x) continue;
      obj.box.TopLeft.x -= distance;
    }
  } else {
    for (const edge of g.edges || []) {
      const first = edge.route[0], last = edge.route[edge.route.length - 1];
      if (first.y <= start) {
        // don't shift first edge point if src is not shifting and we are on src
        const onStaticSrc = first.y === edge.src.box.TopLeft.y && start < edge.src.box.TopLeft.y + edge.src.box.Height;
        if (!onStaticSrc) first.y -= distance;
      }
      if (last.y <= start) {
        const onStaticDst = last.y === edge.dst.box.TopLeft.y && start < edge.dst.box.TopLeft.y;
        if (!onStaticDst) last.y -= distance;
      }
      for (let i = 1; i < edge.route.length - 1; i++) {
        const p = edge.route[i];
        if (start < p.y) continue;
        p.y -= distance;
      }
    }
    for (const obj of g.objects || []) {
      if (start < obj.box.TopLeft.y) continue;
      obj.box.TopLeft.y -= distance;
    }
  }
}

class CrossRankIndex {
  constructor() {
    this.incident = new Map();
  }
}

function newCrossRankIndex(g) {
  const index = new CrossRankIndex();
  for (const edge of g.edges || []) {
    if (!index.incident.has(edge.src)) index.incident.set(edge.src, []);
    index.incident.get(edge.src).push(edge);
    if (edge.dst !== edge.src) {
      if (!index.incident.has(edge.dst)) index.incident.set(edge.dst, []);
      index.incident.get(edge.dst).push(edge);
    }
  }
  return index;
}

// shift down everything that is below start
// shift all nodes that are reachable via an edge or being directly below a shifting node or expanding container
// expand containers to wrap shifted nodes
function shiftReachableDownIndexed(g, index, obj, start, distance, isHorizontal, isMargin) {
  let q = [obj];

  const needsMove = new Set();
  const seen = new Set();
  const shifted = new Set();
  const shiftedEdges = new Set();
  const queue = (o) => {
    if (seen.has(o)) return;
    q.push(o);
  };

  // if object below is within this distance after shifting, also shift it
  const threshold = 100.;
  const checkBelow = (curr) => {
    const currBottom = curr.box.TopLeft.y + curr.box.Height;
    const currRight = curr.box.TopLeft.x + curr.box.Width;
    if (isHorizontal) {
      let originalRight = currRight;
      if (shifted.has(curr)) originalRight -= distance;
      for (const other of g.objects || []) {
        if (other === curr || curr.isDescendantOf(other)) continue;
        if (originalRight < other.box.TopLeft.x &&
          other.box.TopLeft.x < originalRight + distance + threshold &&
          curr.box.TopLeft.y < other.box.TopLeft.y + other.box.Height &&
          other.box.TopLeft.y < currBottom) {
          queue(other);
        }
      }
    } else {
      let originalBottom = currBottom;
      if (shifted.has(curr)) originalBottom -= distance;
      for (const other of g.objects || []) {
        if (other === curr || curr.isDescendantOf(other)) continue;
        if (originalBottom < other.box.TopLeft.y &&
          other.box.TopLeft.y < originalBottom + distance + threshold &&
          curr.box.TopLeft.x < other.box.TopLeft.x + other.box.Width &&
          other.box.TopLeft.x < currRight) {
          queue(other);
        }
      }
    }
  };

  const processQueue = () => {
    while (q.length > 0) {
      const curr = q[0];
      q = q.slice(1);
      if (seen.has(curr)) continue;
      // skip other objects behind start
      if (curr !== obj) {
        if (!needsMove.has(curr)) {
          if (isHorizontal) {
            if (curr.box.TopLeft.x < start) continue;
          } else if (curr.box.TopLeft.y < start) continue;
        }
      }

      if (isHorizontal) {
        let shift = needsMove.has(curr);
        if (!shift) {
          if (!isMargin) shift = start < curr.box.TopLeft.x;
          else shift = start <= curr.box.TopLeft.x;
        }

        if (shift) {
          curr.box.TopLeft.x += distance;
          shifted.add(curr);
        }
      } else {
        let shift = needsMove.has(curr);
        if (!shift) {
          if (!isMargin) shift = start < curr.box.TopLeft.y;
          else shift = start <= curr.box.TopLeft.y;
        }
        if (shift) {
          curr.box.TopLeft.y += distance;
          shifted.add(curr);
        }
      }
      seen.add(curr);

      if (curr.parent !== g.root && !curr.isDescendantOf(obj)) queue(curr.parent);

      for (const child of curr.childrenArray || []) queue(child);

      for (const e of index.incident.get(curr) || []) {
        if (shiftedEdges.has(e)) continue;
        if (e.src === curr && e.dst === curr) {
          if (isHorizontal) {
            for (const p of e.route) p.x += distance;
          } else {
            for (const p of e.route) p.y += distance;
          }
          shiftedEdges.add(e);
          continue;
        } else if (e.src === curr) {
          const last = e.route[e.route.length - 1];
          if (isHorizontal) {
            if (start <= last.x && e.dst.box.TopLeft.x + e.dst.box.Width < last.x + distance) needsMove.add(e.dst);
          } else if (start <= last.y && e.dst.box.TopLeft.y + e.dst.box.Height < last.y + distance) needsMove.add(e.dst);
          queue(e.dst);
          const first = e.route[0];
          let startIndex = 0;
          const wasShifted = shifted.has(curr);
          if (isHorizontal) {
            if (wasShifted && first.x < curr.box.TopLeft.x && first.x < start) {
              first.x += distance;
              startIndex++;
            }
            for (let i = startIndex; i < e.route.length; i++) {
              const p = e.route[i];
              if (start <= p.x) p.x += distance;
            }
          } else {
            if (wasShifted && first.y < curr.box.TopLeft.y && first.y < start) {
              first.y += distance;
              startIndex++;
            }
            for (let i = startIndex; i < e.route.length; i++) {
              const p = e.route[i];
              if (start <= p.y) p.y += distance;
            }
          }
          shiftedEdges.add(e);
        } else if (e.dst === curr) {
          const first = e.route[0];
          if (isHorizontal) {
            if (start <= first.x && e.src.box.TopLeft.x + e.src.box.Width < first.x + distance) needsMove.add(e.src);
          } else if (start <= first.y && e.src.box.TopLeft.y + e.src.box.Height < first.y + distance) needsMove.add(e.src);
          queue(e.src);
          const last = e.route[e.route.length - 1];
          let endIndex = e.route.length;
          const wasShifted = shifted.has(curr);
          if (isHorizontal) {
            if (wasShifted && last.x < curr.box.TopLeft.x && last.x < start) {
              last.x += distance;
              endIndex--;
            }
            for (let i = 0; i < endIndex; i++) {
              const p = e.route[i];
              if (start <= p.x) p.x += distance;
            }
          } else {
            if (wasShifted && last.y < curr.box.TopLeft.y && last.y < start) {
              last.y += distance;
              endIndex--;
            }
            for (let i = 0; i < endIndex; i++) {
              const p = e.route[i];
              if (start <= p.y) p.y += distance;
            }
          }
          shiftedEdges.add(e);
        }
      }

      // check for nodes below that need to move from the shift
      checkBelow(curr);
    }
  };

  processQueue();

  const grown = new Set();
  // Go ranges over the map `seen`, which processQueue() (called inside the loop) adds to: such entries "may be produced during the
  // iteration or may be skipped". A Go swiss map that grows while it is iterated keeps iterating its old table, so the entries added
  // by a grown parent's queue are not visited; a JS Set would visit them all. Iterating a snapshot is what Go shows (measured on
  // fuzzed layouts: visiting the added entries gives layouts that Go never prints).
  for (const o of [...seen]) {
    if (o.parent === g.root) continue;
    if (shifted.has(o.parent)) continue;
    if (grown.has(o.parent)) continue;

    for (let parent = o.parent; parent !== g.root; parent = parent.parent) {
      if (shifted.has(parent)) break;
      if (grown.has(parent)) break;

      if (isHorizontal) {
        if (parent.box.TopLeft.x < start) {
          parent.box.Width += distance;
          grown.add(parent);

          checkBelow(parent);
          processQueue();
        }
      } else if (parent.box.TopLeft.y < start) {
        parent.box.Height += distance;
        grown.add(parent);

        checkBelow(parent);
        processQueue();
      }
    }
  }

  const increasedMargins = new Set();
  const movedObjects = [];
  for (const o of shifted) movedObjects.push(o);
  for (const o of grown) movedObjects.push(o);
  for (const moved of movedObjects) {
    let counts = true;
    // check if any other shifted is directly above
    for (const other of movedObjects) {
      if (other === moved) continue;
      if (isHorizontal) {
        if (other.box.TopLeft.y + other.box.Height < moved.box.TopLeft.y ||
          moved.box.TopLeft.y + moved.box.Height < other.box.TopLeft.y) {
          // doesn't line up vertically
          continue;
        }

        // above and within threshold
        if (other.box.TopLeft.x < moved.box.TopLeft.x &&
          moved.box.TopLeft.x < other.box.TopLeft.x + other.box.Width + threshold) {
          counts = false;
          break;
        }
      } else {
        if (other.box.TopLeft.x + other.box.Width < moved.box.TopLeft.x ||
          moved.box.TopLeft.x + moved.box.Width < other.box.TopLeft.x) {
          // doesn't line up horizontally
          continue;
        }

        // above and within threshold
        if (other.box.TopLeft.y < moved.box.TopLeft.y &&
          moved.box.TopLeft.y < other.box.TopLeft.y + other.box.Height + threshold) {
          counts = false;
          break;
        }
      }
    }
    if (counts) increasedMargins.add(moved);
  }

  return increasedMargins;
}

function adjustRankSpacing(g, rankSep, isHorizontal) {
  const [ranks, objectRanks, startingParentRanks, endingParentRanks] = getRanks(g, isHorizontal);

  // shifting bottom rank down first, then moving up to next rank
  for (let rank = ranks.length - 1; rank >= 0; rank--) {
    let startingParents = [];
    let endingParents = [];
    for (const obj of ranks[rank]) {
      if (obj.parent === g.root) continue;
      if (endingParentRanks.has(obj.parent) && endingParentRanks.get(obj.parent) === rank) endingParents.push(obj.parent);
      if (startingParentRanks.has(obj.parent) && startingParentRanks.get(obj.parent) === rank) startingParents.push(obj.parent);
    }

    const startingAncestorPositions = new Map();
    while (startingParents.length > 0) {
      const ancestors = [];
      for (const parent of startingParents) {
        const [, padding] = parent.spacing();
        if (!startingAncestorPositions.has(parent)) startingAncestorPositions.set(parent, Infinity);
        let startPosition;
        if (isHorizontal) {
          const paddingIncrease = Math.max(0, padding.Left - rankSep / 2);
          startPosition = parent.box.TopLeft.x - paddingIncrease;
        } else {
          const paddingIncrease = Math.max(0, padding.Top - rankSep / 2);
          startPosition = parent.box.TopLeft.y - paddingIncrease;
        }
        startingAncestorPositions.set(parent, Math.min(startingAncestorPositions.get(parent), startPosition));
        for (const child of parent.childrenArray || []) {
          if (objectRanks.has(child)) {
            if (objectRanks.get(child) !== rank) continue;
          } else if (get0(startingParentRanks, child) !== rank) continue;
          const [margin] = child.spacing();
          if (isHorizontal) startPosition = child.box.TopLeft.x - margin.Left - padding.Left;
          else startPosition = child.box.TopLeft.y - margin.Top - padding.Top;
          startingAncestorPositions.set(parent, Math.min(startingAncestorPositions.get(parent), startPosition));
        }
        if (parent.parent !== g.root) ancestors.push(parent.parent);
      }
      startingParents = ancestors;
    }

    const endingAncestorPositions = new Map();
    while (endingParents.length > 0) {
      const ancestors = [];
      for (const parent of endingParents) {
        const [, padding] = parent.spacing();
        if (!endingAncestorPositions.has(parent)) endingAncestorPositions.set(parent, -Infinity);
        let endPosition;
        if (isHorizontal) endPosition = parent.box.TopLeft.x + parent.box.Width + padding.Right - rankSep / 2.;
        else endPosition = parent.box.TopLeft.y + parent.box.Height + padding.Bottom - rankSep / 2.;

        endingAncestorPositions.set(parent, Math.max(endingAncestorPositions.get(parent), endPosition));
        for (const child of parent.childrenArray || []) {
          if (objectRanks.has(child)) {
            if (objectRanks.get(child) !== rank) continue;
          } else if (get0(endingParentRanks, child) !== rank) continue;
          const [margin] = child.spacing();

          if (isHorizontal) endPosition = child.box.TopLeft.x + child.box.Width + margin.Right + padding.Right;
          else endPosition = child.box.TopLeft.y + child.box.Height + margin.Bottom + padding.Bottom;
          endingAncestorPositions.set(parent, Math.max(endingAncestorPositions.get(parent), endPosition));
        }
        if (parent.parent !== g.root) ancestors.push(parent.parent);
      }
      endingParents = ancestors;
    }

    const startingAdjustmentOrder = [];
    for (const ancestor of startingAncestorPositions.keys()) startingAdjustmentOrder.push(ancestor);
    // adjust starting ancestors top-down
    sortSlice(startingAdjustmentOrder, (i, j) => {
      const iPos = startingAncestorPositions.get(startingAdjustmentOrder[i]);
      const jPos = startingAncestorPositions.get(startingAdjustmentOrder[j]);
      return iPos < jPos;
    });

    const endingAdjustmentOrder = [];
    for (const ancestor of endingAncestorPositions.keys()) endingAdjustmentOrder.push(ancestor);

    // adjust ending ancestors bottom-up
    sortSlice(endingAdjustmentOrder, (i, j) => {
      const iPos = endingAncestorPositions.get(endingAdjustmentOrder[i]);
      const jPos = endingAncestorPositions.get(endingAdjustmentOrder[j]);
      return jPos < iPos;
    });

    for (const ancestor of endingAdjustmentOrder) {
      let position;
      if (isHorizontal) position = ancestor.box.TopLeft.x + ancestor.box.Width;
      else position = ancestor.box.TopLeft.y + ancestor.box.Height;
      const endDelta = endingAncestorPositions.get(ancestor) - position;
      if (endDelta > 0) {
        for (const obj of g.objects || []) {
          if (!obj.isContainer()) continue;
          const start = get0(startingParentRanks, obj);
          const end = get0(endingParentRanks, obj);
          if (start <= rank && rank <= end) {
            if (isHorizontal && position <= obj.box.TopLeft.x + obj.box.Width) obj.box.Width += endDelta;
            else if (!isHorizontal && position <= obj.box.TopLeft.y + obj.box.Height) obj.box.Height += endDelta;
          }
        }
        shiftDown(g, position, endDelta, isHorizontal);
      }
    }

    for (const ancestor of startingAdjustmentOrder) {
      let position;
      if (isHorizontal) position = ancestor.box.TopLeft.x;
      else position = ancestor.box.TopLeft.y;
      const startDelta = position - startingAncestorPositions.get(ancestor);
      if (startDelta > 0) {
        for (const obj of g.objects || []) {
          if (!obj.isContainer()) continue;
          const start = get0(startingParentRanks, obj);
          const end = get0(endingParentRanks, obj);
          if (start <= rank && rank <= end) {
            if (isHorizontal && obj.box.TopLeft.x <= position) obj.box.Width += startDelta;
            else if (!isHorizontal && obj.box.TopLeft.y <= position) obj.box.Height += startDelta;
          }
        }
        shiftUp(g, position, startDelta, isHorizontal);
      }
    }
  }
}

function adjustCrossRankSpacing(g, rankSep, isHorizontal) {
  const index = newCrossRankIndex(g);
  let prevMarginTop, prevMarginBottom, prevMarginLeft, prevMarginRight;
  if (isHorizontal) {
    prevMarginLeft = new Map();
    prevMarginRight = new Map();
  } else {
    prevMarginTop = new Map();
    prevMarginBottom = new Map();
  }
  for (const obj of g.objects || []) {
    if (obj.isGridDiagram()) continue;
    const [margin, padding] = obj.spacing();
    if (!isHorizontal) {
      if (prevMarginBottom.has(obj)) margin.Bottom -= prevMarginBottom.get(obj);
      if (margin.Bottom > 0) {
        const increased = shiftReachableDownIndexed(g, index, obj, obj.box.TopLeft.y + obj.box.Height, margin.Bottom, isHorizontal, true);
        for (const o of increased) prevMarginBottom.set(o, Math.max(get0(prevMarginBottom, o), margin.Bottom));
      }
      if (padding.Bottom > 0) {
        shiftReachableDownIndexed(g, index, obj, obj.box.TopLeft.y + obj.box.Height, padding.Bottom, isHorizontal, false);
        obj.box.Height += padding.Bottom;
      }
      if (prevMarginTop.has(obj)) margin.Top -= prevMarginTop.get(obj);
      if (margin.Top > 0) {
        const increased = shiftReachableDownIndexed(g, index, obj, obj.box.TopLeft.y, margin.Top, isHorizontal, true);
        for (const o of increased) prevMarginTop.set(o, Math.max(get0(prevMarginTop, o), margin.Top));
      }
      if (padding.Top > 0) {
        shiftReachableDownIndexed(g, index, obj, obj.box.TopLeft.y, padding.Top, isHorizontal, false);
        obj.box.Height += padding.Top;
      }
    } else {
      if (prevMarginRight.has(obj)) margin.Right -= prevMarginRight.get(obj);
      if (margin.Right > 0) {
        const increased = shiftReachableDownIndexed(g, index, obj, obj.box.TopLeft.x + obj.box.Width, margin.Right, isHorizontal, true);
        for (const o of increased) prevMarginRight.set(o, Math.max(get0(prevMarginRight, o), margin.Right));
      }
      if (padding.Right > 0) {
        shiftReachableDownIndexed(g, index, obj, obj.box.TopLeft.x + obj.box.Width, padding.Right, isHorizontal, false);
        obj.box.Width += padding.Right;
      }
      if (prevMarginLeft.has(obj)) margin.Left -= prevMarginLeft.get(obj);
      if (margin.Left > 0) {
        const increased = shiftReachableDownIndexed(g, index, obj, obj.box.TopLeft.x, margin.Left, isHorizontal, true);
        for (const o of increased) prevMarginLeft.set(o, Math.max(get0(prevMarginLeft, o), margin.Left));
      }
      if (padding.Left > 0) {
        shiftReachableDownIndexed(g, index, obj, obj.box.TopLeft.x, padding.Left, isHorizontal, false);
        obj.box.Width += padding.Left;
      }
    }
  }
}

function fitContainerPadding(g, rankSep, isHorizontal) {
  for (const obj of g.root.childrenArray || []) fitPadding(obj);
}

function fitPadding(obj) {
  const dslShape = obj.attributes.shape.value.toLowerCase();
  const shapeType = d2target.DSL_SHAPE_TO_SHAPE_TYPE[dslShape];
  // Note: there's no shape-specific padding/placement in dagre yet
  if (!obj.isContainer() || shapeType !== shape.SQUARE_TYPE) return;
  for (const child of obj.childrenArray || []) fitPadding(child);

  // we will compute a perfectly fit innerBox merging our padding with children's margin,
  // but we need to add padding and margin together if an outside child label will overlap with our inside label
  const [, padding] = obj.spacing();
  padding.Top = Math.max(padding.Top, DEFAULT_PADDING);
  padding.Bottom = Math.max(padding.Bottom, DEFAULT_PADDING);
  padding.Left = Math.max(padding.Left, DEFAULT_PADDING);
  padding.Right = Math.max(padding.Right, DEFAULT_PADDING);

  // where we are (current*) vs where we want to fit each side to (inner*)
  const currentTop = obj.box.TopLeft.y;
  const currentBottom = obj.box.TopLeft.y + obj.box.Height;
  const currentLeft = obj.box.TopLeft.x;
  const currentRight = obj.box.TopLeft.x + obj.box.Width;

  let innerTop = Infinity;
  let innerBottom = -Infinity;
  let innerLeft = Infinity;
  let innerRight = -Infinity;

  // we create boxes for our inside label and icon, and will check against overlaps with any internal boxes
  let labelPosition = label.Unset, iconPosition = label.Unset;
  let labelBox = null, iconBox = null;
  if (obj.hasLabel() && obj.labelPosition !== null) {
    labelPosition = label.fromString(obj.labelPosition);
    switch (labelPosition) {
      case label.InsideTopLeft: case label.InsideTopCenter: case label.InsideTopRight:
      case label.InsideBottomLeft: case label.InsideBottomCenter: case label.InsideBottomRight:
      case label.InsideMiddleLeft: case label.InsideMiddleRight: {
        const labelTL = obj.getLabelTopLeft();
        if (labelTL !== null) {
          labelBox = geo.newBox(labelTL, obj.attributes.labelDimensions.width + 2 * label.PADDING, obj.attributes.labelDimensions.height);
        }
      }
    }
  }
  if (obj.hasIcon() && obj.iconPosition !== null) {
    iconPosition = label.fromString(obj.iconPosition);
    switch (iconPosition) {
      case label.InsideTopLeft: case label.InsideTopCenter: case label.InsideTopRight:
      case label.InsideBottomLeft: case label.InsideBottomCenter: case label.InsideBottomRight:
      case label.InsideMiddleLeft: case label.InsideMiddleRight: {
        const iconTL = obj.getIconTopLeft();
        if (iconTL !== null) iconBox = geo.newBox(iconTL, d2target.MAX_ICON_SIZE, d2target.MAX_ICON_SIZE);
      }
    }
  }

  // update the inner positions for children's margin and collect the outside boxes that we cannot overlap with
  const innerBoxes = [];
  for (const child of obj.childrenArray || []) {
    const [margin] = child.spacing();
    const [dx, dy] = child.getModifierElementAdjustments();

    if (labelBox !== null || iconBox !== null) {
      if (child.hasLabel() && child.labelPosition !== null) {
        const childLabelPosition = label.fromString(child.labelPosition);
        if (label.isOutside(childLabelPosition)) {
          const childLabelTL = child.getLabelTopLeft();

          const childLabelBox = geo.newBox(
            childLabelTL,
            child.attributes.labelDimensions.width,
            child.attributes.labelDimensions.height,
          );
          innerBoxes.push(childLabelBox);
        }
      }
      if (child.hasIcon() && child.iconPosition !== null) {
        const childIconPosition = label.fromString(child.iconPosition);
        if (label.isOutside(childIconPosition)) {
          const childIconTL = child.getIconTopLeft();

          const childIconBox = geo.newBox(childIconTL, d2target.MAX_ICON_SIZE, d2target.MAX_ICON_SIZE);
          innerBoxes.push(childIconBox);
        }
      }
    }

    innerTop = Math.min(innerTop, child.box.TopLeft.y - dy - Math.max(margin.Top, padding.Top));
    innerBottom = Math.max(innerBottom, child.box.TopLeft.y + child.box.Height + Math.max(margin.Bottom, padding.Bottom));
    innerLeft = Math.min(innerLeft, child.box.TopLeft.x - Math.max(margin.Left, padding.Left));
    innerRight = Math.max(innerRight, child.box.TopLeft.x + child.box.Width + dx + Math.max(margin.Right, padding.Right));
  }

  // collect edge label boxes and update inner box for internal edges
  for (const edge of obj.graph.edges || []) {
    if (!edge.src.isDescendantOf(obj) || !edge.dst.isDescendantOf(obj)) continue;
    // check internal edge + their labels
    if (edge.attributes.label.value !== '') {
      let labelPosition = label.InsideMiddleCenter;
      if (edge.labelPosition !== null) labelPosition = label.fromString(edge.labelPosition);
      const labelWidth = edge.attributes.labelDimensions.width;
      const labelHeight = edge.attributes.labelDimensions.height;
      const [point] = label.getPointOnRoute(labelPosition, edge.route, 2, 0, labelWidth, labelHeight);

      if (labelBox !== null || iconBox !== null) innerBoxes.push(new geo.Box(point, labelWidth, labelHeight));

      innerTop = Math.min(innerTop, point.y - padding.Top);
      innerBottom = Math.max(innerBottom, point.y + labelHeight + padding.Bottom);
      innerLeft = Math.min(innerLeft, point.x - padding.Left);
      innerRight = Math.max(innerRight, point.x + labelWidth + padding.Right);
    }
    for (const point of edge.route) {
      innerTop = Math.min(innerTop, point.y - padding.Top);
      innerBottom = Math.max(innerBottom, point.y + padding.Bottom);
      innerLeft = Math.min(innerLeft, point.x - padding.Left);
      innerRight = Math.max(innerRight, point.x + padding.Right);
    }
  }

  // how much do we need to shrink each side
  let topDelta = innerTop - currentTop;
  let bottomDelta = currentBottom - innerBottom;
  let leftDelta = innerLeft - currentLeft;
  let rightDelta = currentRight - innerRight;

  if (topDelta > 0 || bottomDelta > 0 || leftDelta > 0 || rightDelta > 0) {
    let leftOverlap = 0, rightOverlap = 0, topOverlap = 0, bottomOverlap = 0;
    let labelSide, iconSide;
    if (labelBox !== null) {
      switch (labelPosition) {
        case label.InsideTopLeft: case label.InsideTopCenter: case label.InsideTopRight:
          labelSide = geo.Orientation.Top;
          break;
        case label.InsideBottomLeft: case label.InsideBottomCenter: case label.InsideBottomRight:
          labelSide = geo.Orientation.Bottom;
          break;
        case label.InsideMiddleLeft:
          labelSide = geo.Orientation.Left;
          break;
        case label.InsideMiddleRight:
          labelSide = geo.Orientation.Right;
          break;
        default:
          labelSide = geo.Orientation.NONE;
      }
      // move labelBox to its position with the merged delta and check for overlaps
      switch (labelSide) {
        case geo.Orientation.Top:
          if (topDelta > 0) labelBox.TopLeft.y += topDelta;
          break;
        case geo.Orientation.Bottom:
          if (bottomDelta > 0) labelBox.TopLeft.y -= bottomDelta;
          break;
        case geo.Orientation.Left:
          if (leftDelta > 0) labelBox.TopLeft.x += leftDelta;
          break;
        case geo.Orientation.Right:
          if (rightDelta > 0) labelBox.TopLeft.x -= rightDelta;
          break;
      }
      switch (labelSide) {
        case geo.Orientation.Top:
          if (topDelta > 0) {
            for (const box of innerBoxes) {
              if (labelBox.overlaps(box)) {
                const dy = labelBox.TopLeft.y + labelBox.Height - box.TopLeft.y;
                topOverlap = Math.max(topOverlap, dy);
              }
            }
          }
          break;
        case geo.Orientation.Bottom:
          if (bottomDelta > 0) {
            for (const box of innerBoxes) {
              if (labelBox.overlaps(box)) {
                const dy = box.TopLeft.y + box.Height - labelBox.TopLeft.y;
                bottomOverlap = Math.max(bottomOverlap, dy);
              }
            }
          }
          break;
        case geo.Orientation.Left:
          if (leftDelta > 0) {
            for (const box of innerBoxes) {
              if (labelBox.overlaps(box)) {
                const dx = labelBox.TopLeft.x + labelBox.Width - box.TopLeft.x;
                leftOverlap = Math.max(leftOverlap, dx);
              }
            }
          }
          break;
        case geo.Orientation.Right:
          if (rightDelta > 0) {
            for (const box of innerBoxes) {
              if (labelBox.overlaps(box)) {
                const dx = box.TopLeft.x + box.Width - labelBox.TopLeft.x;
                rightOverlap = Math.max(rightOverlap, dx);
              }
            }
          }
          break;
      }
    }
    if (iconBox !== null) {
      switch (iconPosition) {
        case label.InsideTopLeft: case label.InsideTopCenter: case label.InsideTopRight:
          iconSide = geo.Orientation.Top;
          break;
        case label.InsideBottomLeft: case label.InsideBottomCenter: case label.InsideBottomRight:
          iconSide = geo.Orientation.Bottom;
          break;
        case label.InsideMiddleLeft:
          iconSide = geo.Orientation.Left;
          break;
        case label.InsideMiddleRight:
          iconSide = geo.Orientation.Right;
          break;
        default:
          iconSide = geo.Orientation.NONE;
      }
      // move iconBox to its position with the merged delta and check for overlaps
      switch (iconSide) {
        case geo.Orientation.Top:
          if (topDelta > 0) iconBox.TopLeft.y += topDelta;
          break;
        case geo.Orientation.Bottom:
          if (bottomDelta > 0) iconBox.TopLeft.y -= bottomDelta;
          break;
        case geo.Orientation.Left:
          if (leftDelta > 0) iconBox.TopLeft.x += leftDelta;
          break;
        case geo.Orientation.Right:
          if (rightDelta > 0) iconBox.TopLeft.x -= rightDelta;
          break;
      }
      switch (iconSide) {
        case geo.Orientation.Top:
          if (topDelta > 0) {
            for (const box of innerBoxes) {
              if (iconBox.overlaps(box)) {
                const dy = iconBox.TopLeft.y + iconBox.Height - box.TopLeft.y;
                topOverlap = Math.max(topOverlap, dy);
              }
            }
          }
          break;
        case geo.Orientation.Bottom:
          if (bottomDelta > 0) {
            for (const box of innerBoxes) {
              if (iconBox.overlaps(box)) {
                const dy = box.TopLeft.y + box.Height - iconBox.TopLeft.y;
                bottomOverlap = Math.max(bottomOverlap, dy);
              }
            }
          }
          break;
        case geo.Orientation.Left:
          if (leftDelta > 0) {
            for (const box of innerBoxes) {
              if (iconBox.overlaps(box)) {
                const dx = iconBox.TopLeft.x + iconBox.Width - box.TopLeft.x;
                leftOverlap = Math.max(leftOverlap, dx);
              }
            }
          }
          break;
        case geo.Orientation.Right:
          if (rightDelta > 0) {
            for (const box of innerBoxes) {
              if (iconBox.overlaps(box)) {
                const dx = box.TopLeft.x + box.Width - iconBox.TopLeft.x;
                rightOverlap = Math.max(rightOverlap, dx);
              }
            }
          }
          break;
      }
    }

    if (leftOverlap > 0) leftDelta -= leftOverlap + MIN_SPACING;
    if (rightOverlap > 0) rightDelta -= rightOverlap + MIN_SPACING;
    if (topOverlap > 0) topDelta -= topOverlap + MIN_SPACING;
    if (bottomOverlap > 0) bottomDelta -= bottomOverlap + MIN_SPACING;
  }

  if (topDelta > 0) {
    topDelta = adjustDeltaForEdges(obj, currentTop, topDelta, false);
    if (topDelta > 0) {
      adjustEdges(obj, currentTop, topDelta, false);
      obj.box.TopLeft.y += topDelta;
      obj.box.Height -= topDelta;
    }
  }
  if (bottomDelta > 0) {
    bottomDelta = adjustDeltaForEdges(obj, currentBottom, -bottomDelta, false);
    if (bottomDelta > 0) {
      adjustEdges(obj, currentBottom, -bottomDelta, false);
      obj.box.Height -= bottomDelta;
    }
  }
  if (leftDelta > 0) {
    leftDelta = adjustDeltaForEdges(obj, currentLeft, leftDelta, true);
    if (leftDelta > 0) {
      adjustEdges(obj, currentLeft, leftDelta, true);
      obj.box.TopLeft.x += leftDelta;
      obj.box.Width -= leftDelta;
    }
  }
  if (rightDelta > 0) {
    rightDelta = adjustDeltaForEdges(obj, currentRight, -rightDelta, true);
    if (rightDelta > 0) {
      adjustEdges(obj, currentRight, -rightDelta, true);
      obj.box.Width -= rightDelta;
    }
  }
}

function adjustDeltaForEdges(obj, objPosition, delta, isHorizontal) {
  const isOnCollapsingSide = (p) => {
    let position;
    if (isHorizontal) position = p.x;
    else position = p.y;
    if (geo.precisionCompare(position, objPosition, 1) === 0) return false;
    // check for edges on side corners
    let isOnSide = false;
    if (isHorizontal) {
      if (geo.precisionCompare(p.y, obj.box.TopLeft.y, 1) === 0 ||
        geo.precisionCompare(p.y, obj.box.TopLeft.y + obj.box.Height, 1) === 0) {
        isOnSide = true;
      }
    } else if (geo.precisionCompare(p.x, obj.box.TopLeft.x, 1) === 0 ||
      geo.precisionCompare(p.x, obj.box.TopLeft.x + obj.box.Width, 1) === 0) {
      isOnSide = true;
    }
    if (!isOnSide) return false;
    const buffer = MIN_SPACING;
    let isInRange = false;
    if (delta > 0) {
      if (objPosition <= position && position <= objPosition + delta + buffer) isInRange = true;
    } else if (objPosition + delta - buffer <= position && position <= objPosition) isInRange = true;
    return isInRange;
  };
  let hasEdgeOnCollapsingSide = false;
  let outermost = objPosition + delta;
  for (const edge of obj.graph.edges || []) {
    if (edge.src === obj) {
      const p = edge.route[0];
      if (isOnCollapsingSide(p)) {
        hasEdgeOnCollapsingSide = true;
        const position = isHorizontal ? p.x : p.y;
        if (delta < 0) outermost = Math.max(outermost, position);
        else outermost = Math.min(outermost, position);
      }
    }
    if (edge.dst === obj) {
      const p = edge.route[edge.route.length - 1];
      if (isOnCollapsingSide(p)) {
        hasEdgeOnCollapsingSide = true;
        const position = isHorizontal ? p.x : p.y;
        if (delta < 0) outermost = Math.max(outermost, position);
        else outermost = Math.min(outermost, position);
      }
    }
  }
  let newMagnitude = Math.abs(delta);
  if (hasEdgeOnCollapsingSide) {
    // only reduce to outermost + DEFAULT_PADDING
    if (delta < 0) newMagnitude = Math.max(0, objPosition - (outermost + DEFAULT_PADDING));
    else newMagnitude = Math.max(0, (outermost - DEFAULT_PADDING) - objPosition);
  }
  return newMagnitude;
}

function adjustEdges(obj, objPosition, delta, isHorizontal) {
  const adjust = (p) => {
    const position = isHorizontal ? p.x : p.y;
    if (geo.precisionCompare(position, objPosition, 1) === 0) {
      if (isHorizontal) p.x += delta;
      else p.y += delta;
    } else {
      // check side corners
      let isOnSide = false;
      if (isHorizontal) {
        if (geo.precisionCompare(p.y, obj.box.TopLeft.y, 1) === 0 ||
          geo.precisionCompare(p.y, obj.box.TopLeft.y + obj.box.Height, 1) === 0) {
          isOnSide = true;
        }
      } else if (geo.precisionCompare(p.x, obj.box.TopLeft.x, 1) === 0 ||
        geo.precisionCompare(p.x, obj.box.TopLeft.x + obj.box.Width, 1) === 0) {
        isOnSide = true;
      }
      if (isOnSide) {
        let isInRange = false;
        if (delta > 0) {
          if (objPosition < position && position < objPosition + delta) isInRange = true;
        } else if (objPosition + delta < position && position < objPosition) isInRange = true;
        if (isInRange) {
          if (isHorizontal) p.x = objPosition + delta;
          else p.y = objPosition + delta;
        }
      }
    }
  };

  for (const edge of obj.graph.edges || []) {
    if (edge.src === obj) adjust(edge.route[0]);
    if (edge.dst === obj) adjust(edge.route[edge.route.length - 1]);
  }
}
