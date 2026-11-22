// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of the Go package d2layouts/d2talalayout/internal/placementcost (D2 v0.9.0, github.com/d2lang/d2, Copyright 2022
// Terrastruct Inc.): the objective functions of node placement (edge length with obstruction, direction, cluster, table-column, herd
// and symmetry terms, axis alignment, edge crossings, flow continuity) and the graph-owned cache of EdgeLength.
//
// Port notes (docs/d2-tala-port.md has the conventions):
//  - Options are plain objects {edgeAbductions: EdgeAbduction[] | null, includeNodeSizes, enforceMinimumGap, penalizeDirection}
//    (Go's EdgeLengthOptions; a nil EdgeAbductions slice is null, which is not the same as an empty one: nil makes the cluster
//    abductions of the graph apply).
//  - Errors are thrown (GoError). `ctx` is context.js; the cancellation polls of the scoring loops are kept (every 64 iterations).
//  - EdgeLength's cache key is the FNV-1a 64 bit hash of the Go source, computed with two 32 bit halves and returned as a BigInt
//    (graph.edgeLengthCache is a Map keyed by it). Go's goroutines (min(nodes, GOMAXPROCS) workers, 1 up to 10 nodes) each write costs[i],
//    and the sum is then taken in node order, which is the float sequence of the sequential branch: JS sums sequentially.
//  - Pools (sync.Pool scratch) only reuse allocations: the JS scratch objects are plain fresh values.
//  - math.Hypot is Go's algorithm (hypot.go), not Math.hypot.
//  - The exported Go name keeps the plain camelCase name; the unexported twin gets a trailing underscore (NodeSymmetry/nodeSymmetry_).

import * as geo from '../geo.js';
import { errorf, GoPanic } from './goerrors.js';
import * as lg from './layoutgraph.js';

const { Orientation } = geo;

const invalidEdgeLengthState = 0n;

const scoringCancellationCheckInterval = 64;
const sizelessDirectionDeltaFactor = 0.25;
const symmetryToleranceBand = 1.0;

/** SideEdgeSpacing is the minimum spacing used to distinguish aligned side ports. */
export const SideEdgeSpacing = 40.0;
/** IdealGapSize is the target separation between connected node boundaries. */
export const IdealGapSize = 2.5 * lg.ConnectedNodeGap;

// Experimental placement preferences. The completed-layout score is unchanged.
const flowSpineWeight = 1.0;
const flowBranchWeight = 1.0;

const MaxFloat64 = Number.MAX_VALUE;

/** Go's math.Hypot (the portable algorithm, also what the amd64 assembly computes). */
function goHypot(p, q) {
  p = Math.abs(p);
  q = Math.abs(q);
  if (p === Infinity || q === Infinity) return Infinity;
  if (Number.isNaN(p) || Number.isNaN(q)) return NaN;
  if (p < q) {
    const t = p;
    p = q;
    q = t;
  }
  if (p === 0) return 0;
  q = q / p;
  return p * Math.sqrt(1 + q * q);
}

const containersOf = (g, node) => g.containers.get(node) ?? [];

// ---- symmetry.go: cancellation polls ----

function scoringCancellationError(ctx, iteration) {
  if (iteration % scoringCancellationCheckInterval !== 0) return;
  checkScoringCancellation(ctx);
}

// Keep the interval check small enough to inline into the scoring loops. The context call and error formatting are only needed at a
// polling boundary.
function checkScoringCancellation(ctx) {
  const err = ctx.err();
  if (err) throw errorf(`EdgeLength: ${err.message}`, err);
}

function checkScoringSlice(ctx, length) {
  for (let start = 0; start < length; start += scoringCancellationCheckInterval) scoringCancellationError(ctx, start);
}

// ---- axis.go ----

/** AxisScore measures how strongly nodes share one visual axis. */
export function axisScore(nodes) {
  if (nodes.length < 2) return 1;
  if (nodes.length === 2) {
    if (geo.isDiagonal(nodes[0].orientation(nodes[1]))) return 0;
    return 1;
  }

  let largestWidth = -Infinity;
  let largestWidthNode = null;
  let largestHeight = -Infinity;
  let largestHeightNode = null;
  for (const node of nodes) {
    if (node.width > largestWidth) {
      largestWidth = node.width;
      largestWidthNode = node;
    }
    if (node.height > largestHeight) {
      largestHeight = node.height;
      largestHeightNode = node;
    }
  }

  let verticallyAligned = true;
  for (const node of nodes) {
    if (node === largestHeightNode) continue;
    if (!geo.isHorizontal(node.orientation(largestHeightNode))) {
      verticallyAligned = false;
      break;
    }
  }
  if (verticallyAligned) {
    const center = largestHeightNode.center();
    let score = 0.0;
    for (const node of nodes) {
      if (node === largestHeightNode) continue;
      let nodeScore = 0.0;
      for (const fraction of [0.25, 0.5, 0.75]) {
        const y = largestHeightNode.topLeft.y + fraction * largestHeightNode.height;
        if (node.overlapsLine(geo.newPoint(center.x, y), geo.newPoint(node.center().x, y), 0)) nodeScore += 0.33;
      }
      if (node.height < 0.25 * largestHeightNode.height) nodeScore *= 3;
      else if (node.height < 0.75 * largestHeightNode.height) nodeScore *= 2;
      if (nodeScore === 0.99) score++;
      else score += nodeScore;
    }
    return Math.max(0.33, score / (nodes.length - 1));
  }

  let horizontallyAligned = true;
  for (const node of nodes) {
    if (node === largestWidthNode) continue;
    if (!geo.isVertical(node.orientation(largestWidthNode))) {
      horizontallyAligned = false;
      break;
    }
  }
  if (horizontallyAligned) {
    const center = largestWidthNode.center();
    let score = 0.0;
    for (const node of nodes) {
      if (node === largestWidthNode) continue;
      let nodeScore = 0.0;
      for (const fraction of [0.25, 0.5, 0.75]) {
        const x = largestWidthNode.topLeft.x + fraction * largestWidthNode.width;
        if (node.overlapsLine(geo.newPoint(x, center.y), geo.newPoint(x, node.center().y), 0)) nodeScore += 0.33;
      }
      if (node.width < 0.25 * largestWidthNode.width) nodeScore *= 3;
      else if (node.width < 0.75 * largestWidthNode.width) nodeScore *= 2;
      if (nodeScore === 0.99) score++;
      else score += nodeScore;
    }
    return Math.max(0.33, score / (nodes.length - 1));
  }
  return 0;
}

// ---- cluster.go ----

/** clusterExactlyTwoExternalConnectedNodes: [first, second, exactlyTwo] */
function clusterExactlyTwoExternalConnectedNodes(cluster) {
  const currentGraph = cluster.nodes[0].graph;
  let first = null;
  let second = null;
  let moreThanTwo = false;
  for (const edgeAbduction of cluster.edgeAbductions) {
    let externalNode = null;
    if (edgeAbduction.originallyFrom === null && edgeAbduction.originallyTo !== null) {
      // edge coming into cluster
      if (edgeAbduction.currentFrom.topLeft !== null && edgeAbduction.currentFrom.graph === currentGraph) externalNode = edgeAbduction.currentFrom;
    } else if (edgeAbduction.originallyTo === null && edgeAbduction.originallyFrom !== null) {
      // edge exiting from cluster
      if (edgeAbduction.currentTo.topLeft !== null && edgeAbduction.currentTo.graph === currentGraph) externalNode = edgeAbduction.currentTo;
    }
    if (externalNode === null || externalNode === first || externalNode === second) continue;
    if (first === null) {
      first = externalNode;
      continue;
    }
    if (second === null) {
      second = externalNode;
      continue;
    }
    moreThanTwo = true;
  }
  return [first, second, !moreThanTwo && first !== null && second !== null];
}

// ---- geometry.go ----

function directionCompass(direction) {
  switch (direction) {
    case Orientation.BottomLeft: return -3;
    case Orientation.Left: return -2;
    case Orientation.TopLeft: return -1;
    case Orientation.Top: return 0;
    case Orientation.TopRight: return 1;
    case Orientation.Right: return 2;
    case Orientation.BottomRight: return 3;
    case Orientation.Bottom: return 4;
    default: return 0;
  }
}

function compassDelta(first, second) {
  let delta = second - first;
  if (delta > 4) delta -= 8;
  else if (delta < -4) delta += 8;
  return delta;
}

/** Go's % keeps the sign of the dividend, which JS % does too. */
function compassAxisDelta(first, second) {
  first = (first + 4) % 4;
  second = (second + 4) % 4;
  const delta = second - first;
  if (delta === 3) return -1;
  return delta;
}

function distanceToPoint(node, point, includeSizes) {
  const box = new geo.Box(node.topLeft, 0, 0);
  if (includeSizes) {
    box.Width = node.width;
    box.Height = node.height;
  }
  const pointBox = new geo.Box(point, 0, 0);
  return distanceBetweenBoxes(box, pointBox);
}

function placementDistance(first, second, includeSizes) {
  const distance = first.distanceTo(second, includeSizes);
  let xCenter = Math.abs(first.topLeft.x - second.topLeft.x);
  let yCenter = Math.abs(first.topLeft.y - second.topLeft.y);
  if (includeSizes) {
    xCenter = Math.abs((first.topLeft.x + first.width / 2) - (second.topLeft.x + second.width / 2)) / (first.width + second.width);
    yCenter = Math.abs((first.topLeft.y + first.height / 2) - (second.topLeft.y + second.height / 2)) / (first.height + second.height);
  }
  return distance + Math.min(xCenter, yCenter) / 20;
}

function distanceBetweenBoxes(first, second) {
  const dx = intervalGap(first.TopLeft.x, first.TopLeft.x + first.Width, second.TopLeft.x, second.TopLeft.x + second.Width);
  const dy = intervalGap(first.TopLeft.y, first.TopLeft.y + first.Height, second.TopLeft.y, second.TopLeft.y + second.Height);
  return geo.euclideanDistance(0, 0, dx, dy);
}

function intervalGap(firstStart, firstEnd, secondStart, secondEnd) {
  if (firstEnd < secondStart) return secondStart - firstEnd;
  if (secondEnd < firstStart) return firstStart - secondEnd;
  return 0;
}

function sizelessOrientation(node, other) {
  if (node.topLeft === null || other.topLeft === null) return Orientation.NONE;
  if (node.topLeft.y < other.topLeft.y) {
    if (node.topLeft.x < other.topLeft.x) return Orientation.TopLeft;
    if (other.topLeft.x < node.topLeft.x) return Orientation.TopRight;
    return Orientation.Top;
  }
  if (other.topLeft.y < node.topLeft.y) {
    if (node.topLeft.x < other.topLeft.x) return Orientation.BottomLeft;
    if (other.topLeft.x < node.topLeft.x) return Orientation.BottomRight;
    return Orientation.Bottom;
  }
  if (other.topLeft.x < node.topLeft.x) return Orientation.Right;
  if (node.topLeft.x < other.topLeft.x) return Orientation.Left;
  return Orientation.NONE;
}

function depth(node) {
  if (node === null) return 0;
  return 1 + depth(node.container);
}

function distanceBetweenTableColumns(graph, edge, from, to) {
  let [fromPort, toPort, hasFromPort, hasToPort, orientation] = edge.facingTablePortValues(from, to);
  if (orientation === Orientation.NONE) {
    if (from === null) from = edge.from;
    if (to === null) to = edge.to;
    const [topLeft, bottomRight] = lg.Nodes.boundingBox([from, to]);
    return 2 * geo.euclideanDistance(topLeft.x, topLeft.y, bottomRight.x, bottomRight.y);
  }
  let multiplier = 2.0;
  if (orientation === Orientation.Left || orientation === Orientation.Right) multiplier = 1;
  if (!hasFromPort) fromPort = new geo.Point(from.topLeft.x + from.width / 2, from.topLeft.y + from.height / 2);
  if (!hasToPort) toPort = new geo.Point(to.topLeft.x + to.width / 2, to.topLeft.y + to.height / 2);
  let gapCost = 0.0;
  if (Math.abs(fromPort.x - toPort.x) < IdealGapSize) gapCost = 2 * graph.cellSize;
  return multiplier * (gapCost + geo.euclideanDistance(fromPort.x, fromPort.y, toPort.x, toPort.y));
}

// ---- obstruction_bounds.go ----

/**
 * obstructionBounds encloses the straight, L-shaped, and alternate midpoint routes considered by placement scoring. An obstacle
 * outside it cannot block any of those routes. It is only a rejection filter; intersecting boxes still go through the original
 * ancestry and segment predicates in their original order. A value {left, top, right, bottom, usable}; the zero value has usable false.
 */
const zeroBounds = Object.freeze({ left: 0, top: 0, right: 0, bottom: 0, usable: false });

function scoringNodeBounds(node) {
  if (node === null || node.topLeft === null) return zeroBounds;
  const x = node.topLeft.x;
  const y = node.topLeft.y;
  const right = x + node.width;
  const bottom = y + node.height;
  // Keep non-finite and overflow-prone trial geometry on the original path.
  const bound = MaxFloat64 / 8;
  const usable = x >= -bound && x <= bound && y >= -bound && y <= bound &&
    right >= -bound && right <= bound && bottom >= -bound && bottom <= bound;
  return { left: Math.min(x, right), top: Math.min(y, bottom), right: Math.max(x, right), bottom: Math.max(y, bottom), usable };
}

function boundsIncluding(bounds, other) {
  return {
    left: Math.min(bounds.left, other.left), top: Math.min(bounds.top, other.top),
    right: Math.max(bounds.right, other.right), bottom: Math.max(bounds.bottom, other.bottom),
    usable: bounds.usable && other.usable,
  };
}

function boundsExcludes(bounds, node) {
  if (!bounds.usable || node === null || node.topLeft === null) return false;
  const x = node.topLeft.x;
  const y = node.topLeft.y;
  const right = x + node.width;
  const bottom = y + node.height;
  // Paired comparisons also handle negative dimensions, and never reject a dimension containing NaN. Infinite obstacle bounds use
  // the original path.
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(right) || !Number.isFinite(bottom)) return false;
  return (x < bounds.left && right < bounds.left) ||
    (x > bounds.right && right > bounds.right) ||
    (y < bounds.top && bottom < bounds.top) ||
    (y > bounds.bottom && bottom > bounds.bottom);
}

// ---- graph.go: the EdgeLength cache key (FNV-1a 64) ----

// FNV-1a with 64-bit state kept as two uint32 halves. h = (h ^ byte) * 0x100000001b3 mod 2^64, where the prime is 2^40 + 0x1b3.
class Fnv64a {
  constructor() {
    this.hi = 0xcbf29ce4 >>> 0;
    this.lo = 0x84222325 >>> 0;
  }

  writeByte(b) {
    const lo = (this.lo ^ b) >>> 0;
    const hi = this.hi;
    const loProduct = lo * 0x1b3; // < 2^41: exact
    const carry = Math.floor(loProduct / 4294967296);
    this.lo = loProduct - carry * 4294967296;
    this.hi = (hi * 0x1b3 + carry + ((lo << 8) >>> 0)) % 4294967296;
  }

  /** the 8 bytes of a little-endian uint64 given as its halves */
  writeU64(hi, lo) {
    this.writeByte(lo & 0xff); this.writeByte((lo >>> 8) & 0xff); this.writeByte((lo >>> 16) & 0xff); this.writeByte((lo >>> 24) & 0xff);
    this.writeByte(hi & 0xff); this.writeByte((hi >>> 8) & 0xff); this.writeByte((hi >>> 16) & 0xff); this.writeByte((hi >>> 24) & 0xff);
  }

  /** Sum64 as a BigInt */
  sum64() {
    return (BigInt(this.hi) << 32n) | BigInt(this.lo);
  }
}

const f64view = new DataView(new ArrayBuffer(8));

/** binary.LittleEndian.PutUint64(b[:], math.Float64bits(f)); h.Write(b[:]) */
function writeFloat64(h, f) {
  f64view.setFloat64(0, f, true);
  h.writeU64(f64view.getUint32(4, true), f64view.getUint32(0, true));
}

/** uint64(id) of an int64 EntityID (BigInt) */
function writeEntityID(h, id) {
  if (id >= 0n && id < 4294967296n) {
    h.writeU64(0, Number(id));
    return;
  }
  const u = BigInt.asUintN(64, id);
  h.writeU64(Number(u >> 32n), Number(u & 0xffffffffn));
}

/** placementEdgeLengthState: the BigInt hash of everything EdgeLength reads, or 0n (invalid) when a node has no position. */
export function placementEdgeLengthState(graph, costs, options) {
  const h = new Fnv64a();

  // Process booleans
  let flags = 0;
  if (options.includeNodeSizes) flags |= 1 << 0;
  if (options.enforceMinimumGap) flags |= 1 << 1;
  if (options.penalizeDirection) flags |= 1 << 2;
  h.writeByte(flags);

  // Process graph costs
  writeFloat64(h, graph.cellSize);
  writeFloat64(h, costs.turn);
  writeFloat64(h, costs.nonCenterPort);
  writeFloat64(h, costs.crossing);

  // Process nodes
  for (const n of graph.nodes) {
    if (n.topLeft === null) return invalidEdgeLengthState;
    writeEntityID(h, n.id);

    writeFloat64(h, n.topLeft.x);
    writeFloat64(h, n.topLeft.y);

    writeFloat64(h, n.width);
    writeFloat64(h, n.height);

    for (const e of n.edges) writeEntityID(h, e.id);
  }

  // Process edge abductions
  for (const ea of options.edgeAbductions ?? []) {
    writeEntityID(h, ea.edge.id);
    if (ea.originallyFrom !== null) writeEntityID(h, ea.originallyFrom.id);
    if (ea.originallyTo !== null) writeEntityID(h, ea.originallyTo.id);
    if (ea.currentTo !== null) writeEntityID(h, ea.currentTo.id);
    if (ea.currentFrom !== null) writeEntityID(h, ea.currentFrom.id);
  }

  return h.sum64();
}

export function edgeLengthWorkerCount(nodeCount, gomaxprocs) {
  if (nodeCount <= 0) return 0;
  // Preserve the inexpensive sequential path for small graphs.
  if (nodeCount <= 10) return 1;
  if (gomaxprocs < 1) gomaxprocs = 1;
  return Math.min(nodeCount, gomaxprocs);
}

/** EdgeLength evaluates the graph's placement cost and may populate its graph-owned edge-length cache. */
export function edgeLength(ctx, graph, options) {
  let err = ctx.err();
  if (err) throw errorf(`EdgeLength: ${err.message}`, err);

  const edgeLengthState = placementEdgeLengthState(graph, graph.routingCosts(), options);
  if (edgeLengthState !== invalidEdgeLengthState) {
    const [d, ok] = graph.lookupEdgeLengthCost(edgeLengthState);
    if (ok) return d;
  }

  const symmetryCost = graph.cellSize;
  let totalSum = 0;

  // Go splits the nodes over goroutines and sums costs[i] in node order afterwards: the same float sequence as this loop.
  for (const n of graph.nodes) {
    let nl = nodeEdgeLength(ctx, n, options);
    if (options.includeNodeSizes) {
      const columnCrossingCost_ = columnCrossingCost(ctx, n, options.edgeAbductions ?? null);
      const symmetry = nodeSymmetry_(ctx, n, options.edgeAbductions ?? null, true);
      nl += columnCrossingCost_;
      nl -= symmetry * symmetryCost * n.edges.length;
    }
    err = ctx.err();
    if (err) throw errorf(`EdgeLength: ${err.message}`, err);
    totalSum += nl;
  }

  const crossings = graphEdgeCrossings(ctx, graph);
  totalSum += graph.crossingCost() * crossings;
  err = ctx.err();
  if (err) throw errorf(`EdgeLength: ${err.message}`, err);
  if (edgeLengthState !== invalidEdgeLengthState) graph.storeEdgeLengthCost(edgeLengthState, totalSum);

  return totalSum;
}

function countEdgeCrossingsExcludingSharedNodes(ctx, edges) {
  let crossings = 0;
  for (let i = 0; i < edges.length - 1; i++) {
    scoringCancellationError(ctx, i);
    const edge1 = edges[i];
    for (let j = i + 1; j < edges.length; j++) {
      scoringCancellationError(ctx, j - i - 1);
      const edge2 = edges[j];

      // Skip if edges share a common node
      if (edge1.from === edge2.from || edge1.from === edge2.to || edge1.to === edge2.from || edge1.to === edge2.to) continue;

      // Create segments and check if they cross
      if (lg.segmentsCross(edge1.from.center(), edge1.to.center(), edge2.from.center(), edge2.to.center())) crossings++;
    }
  }
  const err = ctx.err();
  if (err) throw errorf(`EdgeLength: ${err.message}`, err);
  return crossings;
}

/** GraphEdgeCrossings counts crossings between edges that do not share a node. */
export function graphEdgeCrossings(ctx, graph) {
  let err = ctx.err();
  if (err) throw errorf(`EdgeLength: ${err.message}`, err);
  if (graph.edges.length === 0) {
    err = ctx.err();
    if (err) throw errorf(`EdgeLength: ${err.message}`, err);
    return 0;
  }

  const groups = new Map(); // container level -> edges (Go: levelGroup + groups)
  for (let i = 0; i < graph.edges.length; i++) {
    const edge = graph.edges[i];
    scoringCancellationError(ctx, i);
    if (edge.from === null || edge.to === null || edge.from.topLeft === null || edge.to.topLeft === null) continue;
    const fromLevel = edge.from.containerLevel();
    const toLevel = edge.to.containerLevel();
    if (fromLevel !== toLevel) continue;

    let group = groups.get(fromLevel);
    if (group === undefined) {
      group = [];
      groups.set(fromLevel, group);
    }
    group.push(edge);
  }

  let totalCrossings = 0;
  for (const group of groups.values()) totalCrossings += countEdgeCrossingsExcludingSharedNodes(ctx, group);

  err = ctx.err();
  if (err) throw errorf(`EdgeLength: ${err.message}`, err);
  return totalCrossings;
}

/** ContainerAlignmentCost scores misalignment between peer containers. */
export function containerAlignmentCost(ctx, graph) {
  let err = ctx.err();
  if (err) throw errorf(`EdgeLength: ${err.message}`, err);
  let l = 0.0;
  for (let i = 0; i < graph.nodes.length - 1; i++) {
    scoringCancellationError(ctx, i);
    const n1 = graph.nodes[i];
    if (!n1.isContainer()) continue;
    for (let j = i + 1; j < graph.nodes.length; j++) {
      scoringCancellationError(ctx, j - i - 1);
      const n2 = graph.nodes[j];
      if (!n2.isContainer()) continue;
      if (n1.effectiveContainer() !== n2.effectiveContainer()) continue;
      if (n1.width === n2.width && n1.height === n2.height) {
        if (n1.topLeft.x !== n2.topLeft.x && n1.topLeft.y !== n2.topLeft.y) l += graph.nonCenterPortCost();
      }
    }
  }
  err = ctx.err();
  if (err) throw errorf(`EdgeLength: ${err.message}`, err);
  return l;
}

// ---- edge_length.go ----

/** NodesEdgeLength sums the edge-length cost rooted at each node in order. */
export function nodesEdgeLength(ctx, nodes, options) {
  let err = ctx.err();
  if (err) throw errorf(`EdgeLength: ${err.message}`, err);
  let result = 0.0;
  for (const node of nodes) result += nodeEdgeLength(ctx, node, options);
  err = ctx.err();
  if (err) throw errorf(`EdgeLength: ${err.message}`, err);
  return result;
}

/** the scratch state of one NodeEdgeLength (Go: edgeScratch, a pooled value) */
function newEdgeScratch() {
  return {
    used: [],
    nRepl: [],
    aRepl: [],
    clusterOrder: [],
    edgeAbductions: [],
    obstructionSets: [],
    obstructionAdded: null,
    labeledEdgeCount: null, // Map<"from,to", count>
  };
}

const pairKey = (from, to) => `${from},${to}`;

// Helper function to calculate midpoint and check semi-diagonal for horizontal directions: [mid, isSemiDiagonal]
function calculateHorizontalMidpoint(nodeReplacement, adjacentNodeReplacement) {
  const ceil = Math.min(nodeReplacement.topLeft.x + nodeReplacement.width, adjacentNodeReplacement.topLeft.x + adjacentNodeReplacement.width);
  const floor = Math.max(nodeReplacement.topLeft.x, adjacentNodeReplacement.topLeft.x);
  const mid = (floor + ceil) / 2.;
  const isSemiDiagonal = Math.abs(nodeReplacement.topLeft.x - adjacentNodeReplacement.topLeft.x) > SideEdgeSpacing ||
    Math.abs(nodeReplacement.topLeft.x + nodeReplacement.width - (adjacentNodeReplacement.topLeft.x + adjacentNodeReplacement.width)) > SideEdgeSpacing;
  return [mid, isSemiDiagonal];
}

// Helper function to calculate midpoint and check semi-diagonal for vertical directions: [mid, isSemiDiagonal]
function calculateVerticalMidpoint(nodeReplacement, adjacentNodeReplacement) {
  const ceil = Math.min(nodeReplacement.topLeft.y + nodeReplacement.height, adjacentNodeReplacement.topLeft.y + adjacentNodeReplacement.height);
  const floor = Math.max(nodeReplacement.topLeft.y, adjacentNodeReplacement.topLeft.y);
  const mid = (floor + ceil) / 2.;
  const isSemiDiagonal = Math.abs(nodeReplacement.topLeft.y - adjacentNodeReplacement.topLeft.y) > SideEdgeSpacing ||
    Math.abs(nodeReplacement.topLeft.y + nodeReplacement.height - (adjacentNodeReplacement.topLeft.y + adjacentNodeReplacement.height)) > SideEdgeSpacing;
  return [mid, isSemiDiagonal];
}

/** NodeEdgeLength evaluates the incident-edge cost rooted at node. */
export function nodeEdgeLength(ctx, node, options) {
  const err = ctx.err();
  if (err) throw errorf(`EdgeLength: ${err.message}`, err);
  const s = newEdgeScratch();
  const setup = prepareNodeEdgeLength(ctx, node, options, s);
  return evaluateNodeEdgeLength(ctx, node, options, s, setup);
}

function prepareNodeEdgeLength(ctx, node, options, s) {
  const includeSizes = options.includeNodeSizes;
  const directionPenalty = options.penalizeDirection;

  let edgeAbductions = options.edgeAbductions ?? null;
  if (edgeAbductions === null) {
    s.clusterOrder = [];
    for (const vessel of node.graph.clusters.keys()) s.clusterOrder.push(vessel);
    lg.sortNodesByID(s.clusterOrder);

    s.edgeAbductions = [];
    for (let i = 0; i < s.clusterOrder.length; i++) {
      scoringCancellationError(ctx, i);
      const cluster = node.graph.clusters.get(s.clusterOrder[i]);
      for (const ea of cluster.edgeAbductions) s.edgeAbductions.push(ea);
    }
    edgeAbductions = s.edgeAbductions;
  }

  s.used = new Array(edgeAbductions.length).fill(false);
  const usedEdgeAbductions = s.used;
  // putEdgeScratch clears retained storage before pooling it; this scan keeps cancellation bounded without clearing the same memory twice.
  checkScoringSlice(ctx, usedEdgeAbductions.length);

  s.nRepl = new Array(node.edges.length).fill(null);
  const nodeReplacements = s.nRepl;
  checkScoringSlice(ctx, nodeReplacements.length);

  s.aRepl = new Array(node.edges.length).fill(null);
  const adjReplacements = s.aRepl;
  checkScoringSlice(ctx, adjReplacements.length);

  for (let i = 0; i < node.edges.length; i++) {
    const e = node.edges[i];
    scoringCancellationError(ctx, i);
    const adjacentNode = node.adjacent(e);
    // These are sometimes replaced by container children
    let nodeReplacement = node;
    let adjacentNodeReplacement = adjacentNode;

    if (includeSizes) {
      for (let j = 0; j < edgeAbductions.length; j++) {
        const edgeAbduction = edgeAbductions[j];
        scoringCancellationError(ctx, j);
        if (usedEdgeAbductions[j]) continue;
        if (edgeAbduction.currentFrom === node && edgeAbduction.currentTo === adjacentNode) {
          usedEdgeAbductions[j] = true;
          if (edgeAbduction.originallyTo !== null) adjacentNodeReplacement = edgeAbduction.originallyTo;
          if (edgeAbduction.originallyFrom !== null) nodeReplacement = edgeAbduction.originallyFrom;
          break;
        }
        if (edgeAbduction.currentFrom === adjacentNode && edgeAbduction.currentTo === node) {
          usedEdgeAbductions[j] = true;
          if (edgeAbduction.originallyFrom !== null) adjacentNodeReplacement = edgeAbduction.originallyFrom;
          if (edgeAbduction.originallyTo !== null) nodeReplacement = edgeAbduction.originallyTo;
          break;
        }
      }
    }

    nodeReplacements[i] = nodeReplacement;
    adjReplacements[i] = adjacentNodeReplacement;
  }

  let direction = node.containerDirection();
  let directionFactor = 0;
  if (directionPenalty) {
    if (direction !== Orientation.NONE) {
      // heavily weight specified direction with sizes
      if (includeSizes) directionFactor = 6;
      else directionFactor = 1.5;
    } else {
      if (node.isTable()) {
        direction = Orientation.Right;
        directionFactor = .5;
      } else {
        // Check for nodes with more than 2 labeled edges to same node. Track both total edges and how many are "from" this node
        const edgeCounts = new Map();
        const fromCounts = new Map();
        let hasMultipleLabels = false;
        let multiLabelNode = null;

        if (includeSizes) {
          for (let i = 0; i < node.edges.length; i++) {
            const e = node.edges[i];
            scoringCancellationError(ctx, i);
            const nodeReplacement = nodeReplacements[i];
            // If this node is a container and the replacement is a child, the edge isn't actually connected
            if (nodeReplacement !== node) continue;
            const adjacentNodeReplacement = adjReplacements[i];
            if (adjacentNodeReplacement !== node.adjacent(e)) continue;
            if (e.label !== null) {
              if (adjacentNodeReplacement === nodeReplacement) continue;
              edgeCounts.set(adjacentNodeReplacement, (edgeCounts.get(adjacentNodeReplacement) ?? 0) + 1);
              let from = e.from;
              const [semanticFrom, , directed] = e.directedEndpoints();
              if (directed) from = semanticFrom;
              if (from === node) fromCounts.set(adjacentNodeReplacement, (fromCounts.get(adjacentNodeReplacement) ?? 0) + 1);
              if (edgeCounts.get(adjacentNodeReplacement) > 2) {
                hasMultipleLabels = true;
                multiLabelNode = adjacentNodeReplacement;
              }
            }
          }
        }

        if (hasMultipleLabels) {
          // If more edges are from this node to the target, use Left orientation. Otherwise use Right orientation
          if ((fromCounts.get(multiLabelNode) ?? 0) > Math.trunc(edgeCounts.get(multiLabelNode) / 2)) direction = Orientation.Left;
          else direction = Orientation.Right;
          directionFactor = 10;
        } else {
          // Default to bottom right if no multiple labeled edges
          direction = Orientation.BottomRight;
          directionFactor = .3;
        }
      }

      if (node.isClusterVessel()) {
        directionFactor = .2;
        switch (node.graph.clusters.get(node).arrangement) {
          case lg.Row:
            direction = Orientation.Bottom;
            break;
          case lg.Column:
            direction = Orientation.Right;
            break;
        }
      }
    }
  }

  // get the edges between each nodeReplacement and adjacentNodeReplacement
  for (let i = 0; i < node.edges.length; i++) {
    const edge = node.edges[i];
    scoringCancellationError(ctx, i);
    if (!includeSizes || edge.label === null) continue;
    if (s.labeledEdgeCount === null) s.labeledEdgeCount = new Map();
    const nodeReplacement = nodeReplacements[i];
    const adjacentNodeReplacement = adjReplacements[i];
    const pair = pairKey(nodeReplacement.id, adjacentNodeReplacement.id);
    s.labeledEdgeCount.set(pair, (s.labeledEdgeCount.get(pair) ?? 0) + 1);
  }

  return { direction, directionFactor };
}

function evaluateNodeEdgeLength(ctx, node, options, s, setup) {
  const includeSizes = options.includeNodeSizes;
  const directionPenalty = options.penalizeDirection;
  let minGapSize = 0.0;
  if (options.includeNodeSizes && options.enforceMinimumGap) minGapSize = node.graph.cellSize;
  const nodeReplacements = s.nRepl;
  const adjReplacements = s.aRepl;
  const { direction, directionFactor } = setup;
  const compass = directionCompass(direction);
  let totalDistance = 0.0;
  const nodeContainer = node.effectiveContainer();
  for (let i = 0; i < node.edges.length; i++) {
    const e = node.edges[i];
    scoringCancellationError(ctx, i);
    const adjacentNode = node.adjacent(e);
    // Used during initialization and when adjacent is outer container
    if (adjacentNode.topLeft === null) continue;
    let nodeReplacement = nodeReplacements[i];
    let adjacentNodeReplacement = adjReplacements[i];

    // If another node obstructs the direct path between two nodes, a more accurate heuristic penalizes this

    let nodeVal = null;
    let adjacentNodeVal = null;

    // Lazy calculation of centers and edge direction - only when needed
    let nodeCenter = null;
    let adjacentNodeCenter = null;
    let edgeDirection = Orientation.TopLeft;
    let edgeDirectionCalculated = false;
    let edgeDir = Orientation.TopLeft;

    const getCenters = () => {
      if (nodeCenter === null) {
        nodeCenter = nodeReplacement.center();
        adjacentNodeCenter = adjacentNodeReplacement.center();
      }
    };

    const getEdgeDirection = () => {
      if (!edgeDirectionCalculated) {
        if (includeSizes) edgeDirection = nodeReplacement.orientation(adjacentNodeReplacement);
        else edgeDirection = sizelessOrientation(nodeReplacement, adjacentNodeReplacement);
        edgeDirectionCalculated = true;
      }
      return edgeDirection;
    };

    let isDiagonal = false;
    let isSemiDiagonal = false;
    if (includeSizes) {
      edgeDir = getEdgeDirection();
      if (edgeDir === Orientation.NONE) {
        // This is okay
        continue;
      }
      // When the direction from A to C is Right, B obstructs the ideal straight line But A can still make a perfectly good L shape.
      // It should count as a turnCost for this B, but if B was covering the other L-shape too, it should count as 2. We call this a
      // "semi-diagonal"
      edgeDir = getEdgeDirection();
      if (geo.isDiagonal(edgeDir)) isDiagonal = true;
      switch (edgeDir) {
        case Orientation.Top: {
          const [mid, semiDiag] = calculateHorizontalMidpoint(nodeReplacement, adjacentNodeReplacement);
          nodeVal = geo.newPoint(mid, nodeReplacement.topLeft.y + nodeReplacement.height);
          adjacentNodeVal = geo.newPoint(mid, adjacentNodeReplacement.topLeft.y);
          isSemiDiagonal = semiDiag;
          break;
        }
        case Orientation.Bottom: {
          const [mid, semiDiag] = calculateHorizontalMidpoint(nodeReplacement, adjacentNodeReplacement);
          nodeVal = geo.newPoint(mid, nodeReplacement.topLeft.y);
          adjacentNodeVal = geo.newPoint(mid, adjacentNodeReplacement.topLeft.y + adjacentNodeReplacement.height);
          isSemiDiagonal = semiDiag;
          break;
        }
        case Orientation.Left: {
          const [mid, semiDiag] = calculateVerticalMidpoint(nodeReplacement, adjacentNodeReplacement);
          nodeVal = geo.newPoint(nodeReplacement.topLeft.x + nodeReplacement.width, mid);
          adjacentNodeVal = geo.newPoint(adjacentNodeReplacement.topLeft.x, mid);
          isSemiDiagonal = semiDiag;
          break;
        }
        case Orientation.Right: {
          const [mid, semiDiag] = calculateVerticalMidpoint(nodeReplacement, adjacentNodeReplacement);
          nodeVal = geo.newPoint(nodeReplacement.topLeft.x, mid);
          adjacentNodeVal = geo.newPoint(adjacentNodeReplacement.topLeft.x + adjacentNodeReplacement.width, mid);
          isSemiDiagonal = semiDiag;
          break;
        }
        case Orientation.TopLeft: case Orientation.TopRight: case Orientation.BottomLeft: case Orientation.BottomRight:
          getCenters();
          nodeVal = nodeCenter;
          adjacentNodeVal = adjacentNodeCenter;
          break;
      }
      if (nodeReplacement.cluster !== null || adjacentNodeReplacement.cluster !== null) {
        isSemiDiagonal = false;
        isDiagonal = false;
        getCenters();
        // if it's diagonal, you still have to use the boundaries, or else a line passes through innocent siblings
        switch (edgeDir) {
          case Orientation.Top: case Orientation.TopLeft: case Orientation.TopRight:
            nodeVal = geo.newPoint(nodeCenter.x, nodeReplacement.topLeft.y + nodeReplacement.height);
            adjacentNodeVal = geo.newPoint(adjacentNodeCenter.x, adjacentNodeReplacement.topLeft.y);
            break;
          case Orientation.Bottom: case Orientation.BottomLeft: case Orientation.BottomRight:
            nodeVal = geo.newPoint(nodeCenter.x, nodeReplacement.topLeft.y);
            adjacentNodeVal = geo.newPoint(adjacentNodeCenter.x, adjacentNodeReplacement.topLeft.y + adjacentNodeReplacement.height);
            break;
          case Orientation.Left:
            nodeVal = geo.newPoint(nodeReplacement.topLeft.x + nodeReplacement.width, nodeCenter.y);
            adjacentNodeVal = geo.newPoint(adjacentNodeReplacement.topLeft.x, adjacentNodeCenter.y);
            break;
          case Orientation.Right:
            nodeVal = geo.newPoint(nodeReplacement.topLeft.x, nodeCenter.y);
            adjacentNodeVal = geo.newPoint(adjacentNodeReplacement.topLeft.x + adjacentNodeReplacement.width, adjacentNodeCenter.y);
            break;
        }
      }
    } else {
      nodeVal = nodeReplacement.topLeft;
      adjacentNodeVal = adjacentNodeReplacement.topLeft;
    }

    // ... and the distance is a straight line
    let distance;
    if (includeSizes && e.hasTableColumn()) {
      let from = nodeReplacement;
      let to = adjacentNodeReplacement;
      if (node !== e.from) {
        const t = from;
        from = to;
        to = t;
      }
      distance = distanceBetweenTableColumns(node.graph, e, from, to);
    } else {
      if (nodeReplacement.cluster !== null || adjacentNodeReplacement.cluster !== null) {
        // I want to use the vessel of the cluster, otherwise during node placement, a connected node will jump back and forth between
        // optimizing each one.
        if (nodeReplacement.cluster !== null) distance = placementDistance(nodeReplacement.cluster.vessel, adjacentNodeReplacement, includeSizes);
        else distance = placementDistance(adjacentNodeReplacement.cluster.vessel, nodeReplacement, includeSizes);
      } else if (isDiagonal) {
        // the distance is the sum of that L shape
        distance = distanceToPoint(nodeReplacement, geo.newPoint(nodeVal.x, adjacentNodeVal.y), includeSizes) +
          distanceToPoint(adjacentNodeReplacement, geo.newPoint(nodeVal.x, adjacentNodeVal.y), includeSizes);
        if (includeSizes) distance += node.graph.turnCost();
      } else {
        distance = placementDistance(nodeReplacement, adjacentNodeReplacement, includeSizes);
      }
    }

    if (includeSizes && node.isContainer() && adjacentNode.isContainer() && nodeContainer === adjacentNode.effectiveContainer()) {
      let containerAlignmentPenalty = 0.;
      // If the widths are roughly equal in size, we want alignment on either one of the sides or the center
      if (Math.min(node.width, adjacentNode.width) > Math.max(node.width, adjacentNode.width) * 0.75) {
        if ((node.topLeft.x !== adjacentNode.topLeft.x) && (node.topLeft.x + node.width !== adjacentNode.topLeft.x + adjacentNode.width) &&
          ((node.topLeft.x + node.width) / 2 !== (adjacentNode.topLeft.x + adjacentNode.width) / 2)) {
          containerAlignmentPenalty = node.graph.turnCost();
        }
      }

      if (Math.min(node.height, adjacentNode.height) > Math.max(node.height, adjacentNode.height) * 0.75) {
        if ((node.topLeft.y !== adjacentNode.topLeft.y) && (node.topLeft.y + node.height !== adjacentNode.topLeft.y + adjacentNode.height) &&
          ((node.topLeft.y + node.height) / 2 !== (adjacentNode.topLeft.y + adjacentNode.height) / 2)) {
          containerAlignmentPenalty = node.graph.turnCost();
        }
      }

      distance += containerAlignmentPenalty;
    }

    if (includeSizes && !e.isBetweenTableColumns()) {
      const bounds = boundsIncluding(scoringNodeBounds(nodeReplacement), scoringNodeBounds(adjacentNodeReplacement));
      // for diagonals and semi-diagonals we want to see if both corners are covered by any obstructions
      let passesThroughCornerA = false;
      let passesThroughCornerB = false;

      const checkBestRouteBlocked = (otherNode) => {
        // Obstructions are initialized as siblings of endpoints, but we still need to eliminate cases. If the obstruction is one of
        // the end nodes (already checked). If the obstruction is a child of one of the end nodes (applicable when child connected to
        // its container)
        if (otherNode.isDescendantOf(nodeReplacement) || otherNode.isDescendantOf(adjacentNodeReplacement)) return false;
        if (isDiagonal) {
          if (!passesThroughCornerA &&
            (otherNode.passesThrough(nodeVal, geo.newPoint(nodeVal.x, adjacentNodeVal.y)) ||
              otherNode.passesThrough(adjacentNodeVal, geo.newPoint(nodeVal.x, adjacentNodeVal.y)))) {
            passesThroughCornerA = true;
          }
          if (!passesThroughCornerB &&
            (otherNode.passesThrough(nodeVal, geo.newPoint(adjacentNodeVal.x, nodeVal.y)) ||
              otherNode.passesThrough(adjacentNodeVal, geo.newPoint(adjacentNodeVal.x, nodeVal.y)))) {
            passesThroughCornerB = true;
          }
          if (passesThroughCornerA && passesThroughCornerB) return true;
        } else {
          if (otherNode.passesThrough(nodeVal, adjacentNodeVal)) return true;
        }
        return false;
      };

      // The L shape that goes clockwise
      let isL1Blocked = false;
      // The L shape that goes counterclockwise
      let isL2Blocked = false;

      if (isSemiDiagonal) {
        edgeDir = getEdgeDirection();
        switch (edgeDir) {
          case Orientation.Left: case Orientation.Right:
            if (Math.abs(nodeReplacement.topLeft.y - adjacentNodeReplacement.topLeft.y) <= SideEdgeSpacing) {
              isL1Blocked = true;
            } else if (Math.abs(nodeReplacement.topLeft.y + nodeReplacement.height - (adjacentNodeReplacement.topLeft.y + adjacentNodeReplacement.height)) <= SideEdgeSpacing) {
              isL2Blocked = true;
            }
            break;
          case Orientation.Top: case Orientation.Bottom:
            if (Math.abs(nodeReplacement.topLeft.x - adjacentNodeReplacement.topLeft.x) <= SideEdgeSpacing) {
              isL2Blocked = true;
            } else if (Math.abs(nodeReplacement.topLeft.x + nodeReplacement.width - (adjacentNodeReplacement.topLeft.x + adjacentNodeReplacement.width)) <= SideEdgeSpacing) {
              isL1Blocked = true;
            }
            break;
        }
      }

      // Only used for semi-diagonals
      const checkAlternateRouteBlocked = (otherNode) => {
        if (otherNode.isDescendantOf(nodeReplacement) || otherNode.isDescendantOf(adjacentNodeReplacement)) return false;
        getCenters();
        edgeDir = getEdgeDirection();
        switch (edgeDir) {
          case Orientation.Top: {
            const floor = Math.max(nodeReplacement.topLeft.x, adjacentNodeReplacement.topLeft.x);
            const ceil = Math.min(nodeReplacement.topLeft.x + nodeReplacement.width, adjacentNodeReplacement.topLeft.x + adjacentNodeReplacement.width);
            if (!isL2Blocked) {
              const minX = Math.min(nodeReplacement.topLeft.x, adjacentNodeReplacement.topLeft.x);
              const lowerMidX = minX + Math.abs(floor - minX) / 2.;
              if (nodeReplacement.topLeft.x < adjacentNodeReplacement.topLeft.x) {
                if (otherNode.passesThrough(geo.newPoint(lowerMidX, nodeCenter.y), geo.newPoint(lowerMidX, adjacentNodeCenter.y)) ||
                  otherNode.passesThrough(geo.newPoint(lowerMidX, adjacentNodeCenter.y), adjacentNodeCenter)) {
                  isL2Blocked = true;
                }
              }
              if (nodeReplacement.topLeft.x > adjacentNodeReplacement.topLeft.x) {
                if (otherNode.passesThrough(nodeCenter, geo.newPoint(lowerMidX, nodeCenter.y)) ||
                  otherNode.passesThrough(geo.newPoint(lowerMidX, adjacentNodeCenter.y), geo.newPoint(lowerMidX, nodeCenter.y))) {
                  isL2Blocked = true;
                }
              }
            }
            if (!isL1Blocked) {
              const maxX = Math.max(nodeReplacement.topLeft.x + nodeReplacement.width, adjacentNodeReplacement.topLeft.x + adjacentNodeReplacement.width);
              const upperMidX = maxX - Math.abs(ceil - maxX) / 2.;
              if (nodeReplacement.topLeft.x + nodeReplacement.width > adjacentNodeReplacement.topLeft.x + adjacentNodeReplacement.width) {
                if (otherNode.passesThrough(geo.newPoint(upperMidX, nodeCenter.y), geo.newPoint(upperMidX, adjacentNodeCenter.y)) ||
                  otherNode.passesThrough(adjacentNodeCenter, geo.newPoint(upperMidX, adjacentNodeCenter.y))) {
                  isL1Blocked = true;
                }
              }
              if (nodeReplacement.topLeft.x + nodeReplacement.width < adjacentNodeReplacement.topLeft.x + adjacentNodeReplacement.width) {
                if (otherNode.passesThrough(nodeCenter, geo.newPoint(upperMidX, nodeCenter.y)) ||
                  otherNode.passesThrough(geo.newPoint(upperMidX, adjacentNodeCenter.y), geo.newPoint(upperMidX, nodeCenter.y))) {
                  isL1Blocked = true;
                }
              }
            }
            break;
          }
          case Orientation.Bottom: {
            let t = nodeReplacement; nodeReplacement = adjacentNodeReplacement; adjacentNodeReplacement = t;
            t = nodeCenter; nodeCenter = adjacentNodeCenter; adjacentNodeCenter = t;

            const floor = Math.max(nodeReplacement.topLeft.x, adjacentNodeReplacement.topLeft.x);
            const ceil = Math.min(nodeReplacement.topLeft.x + nodeReplacement.width, adjacentNodeReplacement.topLeft.x + adjacentNodeReplacement.width);
            if (!isL2Blocked) {
              const minX = Math.min(nodeReplacement.topLeft.x, adjacentNodeReplacement.topLeft.x);
              const lowerMidX = minX + Math.abs(floor - minX) / 2.;
              if (nodeReplacement.topLeft.x < adjacentNodeReplacement.topLeft.x) {
                if (otherNode.passesThrough(geo.newPoint(lowerMidX, nodeCenter.y), geo.newPoint(lowerMidX, adjacentNodeCenter.y)) ||
                  otherNode.passesThrough(geo.newPoint(lowerMidX, adjacentNodeCenter.y), adjacentNodeCenter)) {
                  isL2Blocked = true;
                }
              }
              if (nodeReplacement.topLeft.x > adjacentNodeReplacement.topLeft.x) {
                if (otherNode.passesThrough(nodeCenter, geo.newPoint(lowerMidX, nodeCenter.y)) ||
                  otherNode.passesThrough(geo.newPoint(lowerMidX, adjacentNodeCenter.y), geo.newPoint(lowerMidX, nodeCenter.y))) {
                  isL2Blocked = true;
                }
              }
            }
            if (!isL1Blocked) {
              const maxX = Math.max(nodeReplacement.topLeft.x + nodeReplacement.width, adjacentNodeReplacement.topLeft.x + adjacentNodeReplacement.width);
              const upperMidX = maxX - Math.abs(ceil - maxX) / 2.;
              if (nodeReplacement.topLeft.x + nodeReplacement.width > adjacentNodeReplacement.topLeft.x + adjacentNodeReplacement.width) {
                if (otherNode.passesThrough(geo.newPoint(upperMidX, nodeCenter.y), geo.newPoint(upperMidX, adjacentNodeCenter.y)) ||
                  otherNode.passesThrough(adjacentNodeCenter, geo.newPoint(upperMidX, adjacentNodeCenter.y))) {
                  isL1Blocked = true;
                }
              }
              if (nodeReplacement.topLeft.x + nodeReplacement.width < adjacentNodeReplacement.topLeft.x + adjacentNodeReplacement.width) {
                if (otherNode.passesThrough(nodeCenter, geo.newPoint(upperMidX, nodeCenter.y)) ||
                  otherNode.passesThrough(geo.newPoint(upperMidX, adjacentNodeCenter.y), geo.newPoint(upperMidX, nodeCenter.y))) {
                  isL1Blocked = true;
                }
              }
            }

            t = nodeReplacement; nodeReplacement = adjacentNodeReplacement; adjacentNodeReplacement = t;
            t = nodeCenter; nodeCenter = adjacentNodeCenter; adjacentNodeCenter = t;
            break;
          }
          case Orientation.Left: {
            const floor = Math.max(nodeReplacement.topLeft.y, adjacentNodeReplacement.topLeft.y);
            const ceil = Math.min(nodeReplacement.topLeft.y + nodeReplacement.height, adjacentNodeReplacement.topLeft.y + adjacentNodeReplacement.height);
            if (!isL1Blocked) {
              const minY = Math.min(nodeReplacement.topLeft.y, adjacentNodeReplacement.topLeft.y);
              const lowerMidY = minY + Math.abs(floor - minY) / 2.;
              if (nodeReplacement.topLeft.y < adjacentNodeReplacement.topLeft.y) {
                if (otherNode.passesThrough(geo.newPoint(nodeCenter.x, lowerMidY), geo.newPoint(adjacentNodeCenter.x, lowerMidY)) ||
                  otherNode.passesThrough(adjacentNodeCenter, geo.newPoint(adjacentNodeCenter.x, lowerMidY))) {
                  isL1Blocked = true;
                }
              }
              if (nodeReplacement.topLeft.y > adjacentNodeReplacement.topLeft.y) {
                if (otherNode.passesThrough(nodeCenter, geo.newPoint(nodeCenter.x, lowerMidY)) ||
                  otherNode.passesThrough(geo.newPoint(adjacentNodeCenter.x, lowerMidY), geo.newPoint(nodeCenter.x, lowerMidY))) {
                  isL1Blocked = true;
                }
              }
            }
            if (!isL2Blocked) {
              const maxY = Math.max(nodeReplacement.topLeft.y + nodeReplacement.height, adjacentNodeReplacement.topLeft.y + adjacentNodeReplacement.height);
              const upperMidY = maxY - Math.abs(ceil - maxY) / 2.;
              if (nodeReplacement.topLeft.y + nodeReplacement.height > adjacentNodeReplacement.topLeft.y + adjacentNodeReplacement.height) {
                if (otherNode.passesThrough(geo.newPoint(nodeCenter.x, upperMidY), geo.newPoint(adjacentNodeCenter.x, upperMidY)) ||
                  otherNode.passesThrough(adjacentNodeCenter, geo.newPoint(adjacentNodeCenter.x, upperMidY))) {
                  isL2Blocked = true;
                }
              }
              if (nodeReplacement.topLeft.y + nodeReplacement.height < adjacentNodeReplacement.topLeft.y + adjacentNodeReplacement.height) {
                if (otherNode.passesThrough(nodeCenter, geo.newPoint(nodeCenter.x, upperMidY)) ||
                  otherNode.passesThrough(geo.newPoint(adjacentNodeCenter.x, upperMidY), geo.newPoint(nodeCenter.x, upperMidY))) {
                  isL2Blocked = true;
                }
              }
            }
            break;
          }
          case Orientation.Right: {
            // Use same code as geo.Left but swap, then swap back after
            let t = nodeReplacement; nodeReplacement = adjacentNodeReplacement; adjacentNodeReplacement = t;
            t = nodeCenter; nodeCenter = adjacentNodeCenter; adjacentNodeCenter = t;

            const floor = Math.max(nodeReplacement.topLeft.y, adjacentNodeReplacement.topLeft.y);
            const ceil = Math.min(nodeReplacement.topLeft.y + nodeReplacement.height, adjacentNodeReplacement.topLeft.y + adjacentNodeReplacement.height);
            if (!isL1Blocked) {
              const minY = Math.min(nodeReplacement.topLeft.y, adjacentNodeReplacement.topLeft.y);
              const lowerMidY = minY + Math.abs(floor - minY) / 2.;
              if (nodeReplacement.topLeft.y < adjacentNodeReplacement.topLeft.y) {
                if (otherNode.passesThrough(geo.newPoint(nodeCenter.x, lowerMidY), geo.newPoint(adjacentNodeCenter.x, lowerMidY)) ||
                  otherNode.passesThrough(adjacentNodeCenter, geo.newPoint(adjacentNodeCenter.x, lowerMidY))) {
                  isL1Blocked = true;
                }
              }
              if (nodeReplacement.topLeft.y > adjacentNodeReplacement.topLeft.y) {
                if (otherNode.passesThrough(nodeCenter, geo.newPoint(nodeCenter.x, lowerMidY)) ||
                  otherNode.passesThrough(geo.newPoint(adjacentNodeCenter.x, lowerMidY), geo.newPoint(nodeCenter.x, lowerMidY))) {
                  isL1Blocked = true;
                }
              }
            }
            if (!isL2Blocked) {
              const maxY = Math.max(nodeReplacement.topLeft.y + nodeReplacement.height, adjacentNodeReplacement.topLeft.y + adjacentNodeReplacement.height);
              const upperMidY = maxY - Math.abs(ceil - maxY) / 2.;
              if (nodeReplacement.topLeft.y + nodeReplacement.height > adjacentNodeReplacement.topLeft.y + adjacentNodeReplacement.height) {
                if (otherNode.passesThrough(geo.newPoint(nodeCenter.x, upperMidY), geo.newPoint(adjacentNodeCenter.x, upperMidY)) ||
                  otherNode.passesThrough(adjacentNodeCenter, geo.newPoint(adjacentNodeCenter.x, upperMidY))) {
                  isL2Blocked = true;
                }
              }
              if (nodeReplacement.topLeft.y + nodeReplacement.height < adjacentNodeReplacement.topLeft.y + adjacentNodeReplacement.height) {
                if (otherNode.passesThrough(nodeCenter, geo.newPoint(nodeCenter.x, upperMidY)) ||
                  otherNode.passesThrough(geo.newPoint(adjacentNodeCenter.x, upperMidY), geo.newPoint(nodeCenter.x, upperMidY))) {
                  isL2Blocked = true;
                }
              }
            }
            t = nodeReplacement; nodeReplacement = adjacentNodeReplacement; adjacentNodeReplacement = t;
            t = nodeCenter; nodeCenter = adjacentNodeCenter; adjacentNodeCenter = t;
            break;
          }
          default:
            throw new GoPanic('did not expect diagonal');
        }

        if (isL1Blocked && isL2Blocked) return true;

        return false;
      };

      let bestRouteBlocked = false;
      let alternateRouteBlocked = !isSemiDiagonal;
      s.obstructionSets = [];
      s.obstructionAdded = new Set();
      const ancestor = nodeReplacement.nearestSharedAncestor(adjacentNodeReplacement);

      let curr = nodeReplacement.effectiveContainer();
      for (;;) {
        if (s.obstructionAdded.has(curr)) break;
        s.obstructionSets.push(containersOf(node.graph, curr));
        s.obstructionAdded.add(curr);
        if (curr === null) break;
        curr = curr.effectiveContainer();
        if (curr === ancestor) break;
      }

      curr = adjacentNodeReplacement.effectiveContainer();
      for (;;) {
        if (s.obstructionAdded.has(curr)) break;
        s.obstructionSets.push(containersOf(node.graph, curr));
        s.obstructionAdded.add(curr);
        if (curr === null) break;
        curr = curr.effectiveContainer();
        if (curr === ancestor) break;
      }

      for (let obstructionSetIndex = 0; obstructionSetIndex < s.obstructionSets.length; obstructionSetIndex++) {
        const obstructions = s.obstructionSets[obstructionSetIndex];
        scoringCancellationError(ctx, obstructionSetIndex);
        for (let i = 0; i < obstructions.length; i++) {
          scoringCancellationError(ctx, i);
          const obstruction = obstructions[i];
          if (boundsExcludes(bounds, obstruction)) continue;
          if (nodeReplacement.isDescendantOf(obstruction) || adjacentNodeReplacement.isDescendantOf(obstruction)) continue;
          // Used during initialization, or sibling coming from subgraph that hasn't gone yet
          if (obstruction.topLeft === null) continue;
          if (obstruction.graph !== nodeReplacement.graph) {
            // not in the same subgraph, can happen during placement
            continue;
          }
          if (obstruction === nodeReplacement || obstruction === adjacentNodeReplacement) continue;
          if (obstruction.isClusterVessel()) {
            if ((nodeReplacement.cluster !== null && nodeReplacement.cluster.vessel === obstruction) ||
              (adjacentNodeReplacement.cluster !== null && adjacentNodeReplacement.cluster.vessel === obstruction)) {
              // Penalties are calculated elsewhere below for cluster nodes, so don't double count
              continue;
            }
          }

          if (!bestRouteBlocked && checkBestRouteBlocked(obstruction)) bestRouteBlocked = true;
          if (bestRouteBlocked && !alternateRouteBlocked && checkAlternateRouteBlocked(obstruction)) alternateRouteBlocked = true;
          if (bestRouteBlocked && alternateRouteBlocked) break;
        }
        if (bestRouteBlocked && alternateRouteBlocked) break;
      }
      if (bestRouteBlocked) {
        let passThroughCost;
        // Penalize deeply for obstructing cluster
        if (nodeReplacement.cluster !== null || adjacentNodeReplacement.cluster !== null) {
          passThroughCost = node.graph.turnCost() * 2;
        } else if (isDiagonal) {
          // When it's diagonal, the shortest route would've been an L shaped, so to turn it in an S-shape is only one extra turn
          passThroughCost = node.graph.turnCost();
        } else if (isSemiDiagonal) {
          if (alternateRouteBlocked) {
            passThroughCost = node.graph.turnCost() * 2;
          } else {
            // Just an L-shape
            passThroughCost = node.graph.turnCost();
          }
        } else {
          // When it's straight, takes 2 extra turns to get around the obstruction
          passThroughCost = node.graph.turnCost() * 2;
        }
        distance += passThroughCost;
      }

      const badClusterArrangementPenalty = node.graph.turnCost();

      if (nodeReplacement.cluster !== null) {
        switch (nodeReplacement.cluster.arrangement) {
          case lg.Row:
            edgeDir = getEdgeDirection();
            switch (edgeDir) {
              case Orientation.Left: case Orientation.Right:
                distance += badClusterArrangementPenalty * 2;
            }
            break;
          case lg.Column:
            edgeDir = getEdgeDirection();
            switch (edgeDir) {
              case Orientation.Top: case Orientation.Bottom:
                distance += badClusterArrangementPenalty * 2;
            }
            break;
        }

        // This is a unique penalty because otherwise, two nodes could sit above the cluster (if it's a row) and avoid all other
        // penalties (including symmetry)
        const thisClusterDirection = nodeReplacement.cluster.vessel.orientation(adjacentNodeReplacement);
        const [firstExternalNode, secondExternalNode, exactlyTwo] = clusterExactlyTwoExternalConnectedNodes(nodeReplacement.cluster);
        if (exactlyTwo) {
          let otherClusterNode;
          if (firstExternalNode === adjacentNodeReplacement) otherClusterNode = secondExternalNode;
          else otherClusterNode = firstExternalNode;
          const otherClusterDirection = nodeReplacement.cluster.vessel.orientation(otherClusterNode);

          // Penalize being on the same side as other external
          distance += clusterSidePenalty(nodeReplacement.cluster.arrangement, otherClusterDirection, thisClusterDirection, badClusterArrangementPenalty);
        }
        // Reward being aligned with center when on the right side
        let cost = node.graph.turnCost();
        switch (nodeReplacement.cluster.arrangement) {
          case lg.Row:
            switch (thisClusterDirection) {
              case Orientation.Top: case Orientation.Bottom:
                cost = Math.abs(nodeReplacement.cluster.vessel.center().x - adjacentNodeReplacement.center().x);
            }
            break;
          case lg.Column:
            switch (thisClusterDirection) {
              case Orientation.Right: case Orientation.Left:
                cost = Math.abs(nodeReplacement.cluster.vessel.center().y - adjacentNodeReplacement.center().y);
            }
            break;
        }
        distance += cost;
      }
      if (adjacentNodeReplacement.cluster !== null) {
        switch (adjacentNodeReplacement.cluster.arrangement) {
          case lg.Row:
            edgeDir = getEdgeDirection();
            switch (edgeDir) {
              case Orientation.Left: case Orientation.Right:
                distance += badClusterArrangementPenalty * 2;
            }
            break;
          case lg.Column:
            edgeDir = getEdgeDirection();
            switch (edgeDir) {
              case Orientation.Top: case Orientation.Bottom:
                distance += badClusterArrangementPenalty * 2;
            }
            break;
        }

        const thisClusterDirection = adjacentNodeReplacement.cluster.vessel.orientation(nodeReplacement);
        const [firstExternalNode, secondExternalNode, exactlyTwo] = clusterExactlyTwoExternalConnectedNodes(adjacentNodeReplacement.cluster);
        if (exactlyTwo) {
          let otherClusterNode;
          if (firstExternalNode === nodeReplacement) otherClusterNode = secondExternalNode;
          else otherClusterNode = firstExternalNode;
          const otherClusterDirection = adjacentNodeReplacement.cluster.vessel.orientation(otherClusterNode);

          distance += clusterSidePenalty(adjacentNodeReplacement.cluster.arrangement, otherClusterDirection, thisClusterDirection, badClusterArrangementPenalty);
        }

        let cost = node.graph.turnCost();
        switch (adjacentNodeReplacement.cluster.arrangement) {
          case lg.Row:
            switch (thisClusterDirection) {
              case Orientation.Top: case Orientation.Bottom:
                cost = Math.abs(adjacentNodeReplacement.cluster.vessel.center().x - nodeReplacement.center().x);
            }
            break;
          case lg.Column:
            switch (thisClusterDirection) {
              case Orientation.Right: case Orientation.Left:
                cost = Math.abs(adjacentNodeReplacement.cluster.vessel.center().y - nodeReplacement.center().y);
            }
            break;
        }
        distance += cost;
      }
    }

    if (includeSizes && e.isBetweenTableColumns()) {
      let columnIndex;
      if (e.from === nodeReplacement) columnIndex = e.toTableColumnIndex;
      else columnIndex = e.fromTableColumnIndex;
      for (let i = 0; i < adjacentNodeReplacement.edges.length; i++) {
        const e2 = adjacentNodeReplacement.edges[i];
        scoringCancellationError(ctx, i);
        if (!e2.isBetweenTableColumns()) continue;
        const otherTable = adjacentNodeReplacement.adjacent(e2);
        let otherColumnIndex;
        if (e2.from === otherTable) otherColumnIndex = e2.toTableColumnIndex;
        else otherColumnIndex = e2.fromTableColumnIndex;

        const directionToOther = nodeReplacement.orientation(otherTable);

        let sameSide = false;
        // The other table has to be on the same side as us for this crossing calculation to matter
        const otherEdgeDirection = otherTable.orientation(adjacentNodeReplacement);
        edgeDir = getEdgeDirection();
        switch (edgeDir) {
          case Orientation.BottomRight: case Orientation.Right: case Orientation.TopRight:
            switch (otherEdgeDirection) {
              case Orientation.BottomRight: case Orientation.Right: case Orientation.TopRight:
                sameSide = true;
            }
            break;
          case Orientation.BottomLeft: case Orientation.Left: case Orientation.TopLeft:
            switch (otherEdgeDirection) {
              case Orientation.BottomLeft: case Orientation.Left: case Orientation.TopLeft:
                sameSide = true;
            }
            break;
        }

        if (sameSide) {
          switch (directionToOther) {
            // The other table is below us
            case Orientation.TopRight: case Orientation.Top: case Orientation.TopLeft:
              // The other table connects to column higher than ours
              if (otherColumnIndex < columnIndex) distance += node.graph.crossingCost();
              break;
            // The other table is above us
            case Orientation.BottomRight: case Orientation.Bottom: case Orientation.BottomLeft:
              // The other table connects to column lower than ours
              if (otherColumnIndex > columnIndex) distance += node.graph.crossingCost();
              break;
          }
        }
      }
    }

    // If the distance is less than the minGapSize (and it's enforced), we don't want to reward that
    distance = Math.max(distance, minGapSize);

    // Add a penalty according to edge direction
    let outerNode = nodeReplacement;
    if (nodeReplacement.container !== adjacentNodeReplacement.container) {
      if (depth(nodeReplacement) > depth(adjacentNodeReplacement)) outerNode = adjacentNodeReplacement;
    }
    if (directionPenalty && (e.isDirected() || outerNode.containerDirection() !== Orientation.NONE)) {
      edgeDir = getEdgeDirection();
      let from = e.from;
      const [semanticFrom, , directed] = e.directedEndpoints();
      if (directed) from = semanticFrom;
      if (from === node) edgeDir = geo.getOpposite(edgeDir);

      let directionUsed = edgeDir;

      // For clusters, we care more about alignment in center than compass direction. So coalesce diagonal directions to the same direction
      if (nodeReplacement.cluster !== null || adjacentNodeReplacement.cluster !== null) {
        switch (direction) {
          case Orientation.Left:
            switch (directionUsed) {
              case Orientation.TopLeft: case Orientation.BottomLeft:
                directionUsed = Orientation.Left;
            }
            break;
          case Orientation.Right:
            switch (directionUsed) {
              case Orientation.TopRight: case Orientation.BottomRight:
                directionUsed = Orientation.Right;
            }
            break;
          case Orientation.Top:
            switch (directionUsed) {
              case Orientation.TopLeft: case Orientation.TopRight:
                directionUsed = Orientation.Top;
            }
            break;
          case Orientation.Bottom:
            switch (directionUsed) {
              case Orientation.BottomLeft: case Orientation.BottomRight:
                directionUsed = Orientation.Bottom;
            }
            break;
        }
      }

      let dirDelta = Math.abs(compassDelta(compass, directionCompass(directionUsed)));
      if (!e.isDirected()) {
        // if there is a container direction set, also apply to bidirectional edges using compassAxisDelta for most of the weight, and
        // still slightly preferring the edge direction as defined this way `direction:right; a <-> b` will weight layout [a]<->[b]
        // slightly better than [b]<->[a]
        dirDelta = 0.1 * dirDelta + 0.9 * Math.abs(compassAxisDelta(compass, directionCompass(directionUsed)));
      }
      let baseCost = node.graph.cellSize;
      if (!includeSizes) baseCost = 1.;
      distance += directionFactor * dirDelta * baseCost * sizelessDirectionDeltaFactor;
    }

    if (includeSizes) {
      if (e.hasLargeArrowheadLabel()) {
        edgeDir = getEdgeDirection();
        if (!geo.isHorizontal(edgeDir)) distance += 10 * node.graph.turnCost();
      } else if (e.label !== null) {
        if (!directionPenalty || !geo.isVertical(direction)) {
          const pair = pairKey(nodeReplacement.id, adjacentNodeReplacement.id);
          const count = s.labeledEdgeCount === null ? 0 : (s.labeledEdgeCount.get(pair) ?? 0);
          // with 2 vertical edges a label can go on each side without obstructing each other
          if (count > 2) {
            edgeDir = getEdgeDirection();
            if (!geo.isHorizontal(edgeDir)) {
              // penalize labeled edges with many duplicates if they are not horizontal
              distance += count * node.graph.turnCost();
            }
          }
        }
      }
    }

    totalDistance += distance;
  }

  // We don't care about getting as close as possible to all Nears, we just want to get close to one of them. Since Nears are
  // symmetrical (if node A has node B and C as Nears, nodes B and C will have A too), they'll end up clustering together
  if (node.nears.size > 0) {
    let minDistanceToNear = Infinity;
    let nearIndex = 0;
    for (const near of node.nears) {
      scoringCancellationError(ctx, nearIndex);
      nearIndex++;
      // Not initialized
      if (near.topLeft === null) {
        minDistanceToNear = 0;
        continue;
      }
      const distance = node.distanceTo(near, includeSizes);
      minDistanceToNear = Math.min(minDistanceToNear, distance);
    }
    totalDistance += minDistanceToNear;
  }

  if (node.herdAssignment !== null && includeSizes) {
    let d = 0.0;
    switch (node.herdAssignment.orientation) {
      case Orientation.Bottom:
        d = node.herdAssignment.val - (node.topLeft.y + node.height);
        break;
      case Orientation.Top:
        d = node.topLeft.y - node.herdAssignment.val;
        break;
      case Orientation.Left:
        d = node.topLeft.x - node.herdAssignment.val;
        break;
      case Orientation.Right:
        d = node.herdAssignment.val - (node.topLeft.x + node.width);
        break;
    }

    if (d >= 0) {
      totalDistance += d;
    } else {
      // extra penalty since it makes all other sheep further from herd fence
      totalDistance -= (d - node.graph.cellSize);
    }
  }

  // add a penalty for common uncle siblings not being aligned
  const siblings = node.graph.commonUncleSiblings === null ? undefined : node.graph.commonUncleSiblings.get(node);
  if (siblings !== undefined) {
    const axisScore_ = axisScore(siblings);
    let cost = node.graph.cellSize;
    if (!includeSizes) cost = 1.;
    totalDistance += cost * (1. - axisScore_) * (siblings.length - 1);
  }

  const err = ctx.err();
  if (err) throw errorf(`EdgeLength: ${err.message}`, err);
  if (includeSizes) totalDistance += flowContinuityCost(node, s);
  return totalDistance;
}

/** the "penalize being on the same side as other external" switch of both cluster blocks of evaluateNodeEdgeLength */
function clusterSidePenalty(arrangement, otherClusterDirection, thisClusterDirection, penalty) {
  let added = 0;
  switch (arrangement) {
    case lg.Row:
      switch (otherClusterDirection) {
        // The other node is below us
        case Orientation.TopLeft: case Orientation.Top: case Orientation.TopRight:
          switch (thisClusterDirection) {
            // The other node is below us, so we don't want this node below us
            case Orientation.TopLeft: case Orientation.Top: case Orientation.TopRight:
              added += penalty;
          }
          break;
        case Orientation.BottomLeft: case Orientation.Bottom: case Orientation.BottomRight:
          switch (thisClusterDirection) {
            case Orientation.BottomLeft: case Orientation.Bottom: case Orientation.BottomRight:
              added += penalty;
          }
          break;
      }
      break;
    case lg.Column:
      switch (otherClusterDirection) {
        case Orientation.TopLeft: case Orientation.Left: case Orientation.BottomLeft:
          switch (thisClusterDirection) {
            case Orientation.TopLeft: case Orientation.Left: case Orientation.BottomLeft:
              added += penalty;
          }
          break;
        case Orientation.TopRight: case Orientation.Right: case Orientation.BottomRight:
          switch (thisClusterDirection) {
            case Orientation.TopRight: case Orientation.Right: case Orientation.BottomRight:
              added += penalty;
          }
          break;
      }
      break;
  }
  return added;
}

// ---- edge_length_scorer.go ----

/**
 * NodeEdgeLengthScorer reuses incident-edge topology during one candidate sweep. Geometry is read from live nodes on every score. The
 * caller must keep edges, abductions, container/cluster membership, labels and directions unchanged until close. In particular, a
 * scorer must not survive a topology-changing swap.
 */
export class NodeEdgeLengthScorer {
  constructor(node, options) {
    this.node = node;
    this.options = options;
    this.scratch = null;
    this.setup = null;
    this.prepChecks = 0;
  }

  /**
   * Score has the same value and cancellation checkpoints as NodeEdgeLength while the scorer's topology remains fixed. The caller
   * still charges the original scoring work budget for each candidate; reusing setup does not bypass limits.
   */
  score(ctx) {
    const err = ctx.err();
    if (err) throw errorf(`EdgeLength: ${err.message}`, err);
    if (this.node === null) throw errorf('EdgeLength: scorer is closed');
    if (this.scratch === null) {
      const s = newEdgeScratch();
      // Publish ownership before preparation so a caller's deferred Close also releases scratch if a malformed graph or context
      // panics during setup.
      this.scratch = s;
      const checks = { count: 0, err() { this.count++; return ctx.err(); } };
      let setup;
      try {
        setup = prepareNodeEdgeLength(checks, this.node, this.options, s);
      } catch (e) {
        this.scratch = null;
        throw e;
      }
      this.scratch = s;
      this.setup = setup;
      this.prepChecks = checks.count;
    } else {
      // Preparation only inspects topology. Replay its exact polls without repeating endpoint matching and label-count construction.
      // This keeps cancellation observability equal even for a context counting Err calls.
      for (let i = 0; i < this.prepChecks; i++) checkScoringCancellation(ctx);
    }
    return evaluateNodeEdgeLength(ctx, this.node, this.options, this.scratch, this.setup);
  }

  /** Close releases scratch and makes the scorer unusable. It is safe to call more than once. */
  close() {
    this.node = null;
    this.options = null;
    this.scratch = null;
    this.setup = null;
    this.prepChecks = 0;
  }
}

/** NewNodeEdgeLengthScorer starts an unprepared sweep. Preparation is lazy so cancellation and the caller's work charge occur at the original score point. */
export function newNodeEdgeLengthScorer(node, options) {
  return new NodeEdgeLengthScorer(node, options);
}

// ---- flow_continuity.go ----

const incomingDirection = 1;
const outgoingDirection = 2;

/**
 * flowContinuityCost treats paths through a node as a visual unit. An incoming and outgoing connection should have at least one
 * recognizable continuation; branches should leave enough angular room to read their separate attachments. A fixed, small
 * incident-degree limit bounds the pair work in every existing placement candidate. Group vessels, port-specific edges, and
 * cross-container abstractions retain their existing placement treatment.
 */
export function flowContinuityCost(node, s) {
  if (node.topLeft === null || node.edges.length < 2 || node.edges.length > 8 ||
    node.cluster !== null || node.sequence !== null || node.herdAssignment !== null ||
    containersOf(node.graph, node).length !== 0) {
    return 0;
  }
  const rays = [];
  let n = 0;
  const cx = node.topLeft.x + node.width / 2;
  const cy = node.topLeft.y + node.height / 2;
  for (let i = 0; i < node.edges.length; i++) {
    const e = node.edges[i];
    if (e.isInvisible || e.from === e.to || e.hasTableColumn() ||
      e.hasSourceArrow() === e.hasTargetArrow() || s.nRepl[i] !== node) {
      continue;
    }
    const adj = s.aRepl[i];
    if (adj === null || adj.topLeft === null || adj.container !== node.container) continue;
    let incoming = e.to === node;
    if (e.hasSourceArrow()) incoming = !incoming;
    let direction = outgoingDirection;
    if (incoming) direction = incomingDirection;
    let duplicate = false;
    for (let j = 0; j < n; j++) {
      if (rays[j].node === adj) {
        // Parallel edges share one geometric ray. Reciprocal edges retain both roles regardless of their declaration order.
        rays[j].directions |= direction;
        duplicate = true;
        break;
      }
    }
    if (duplicate) continue;
    const x = adj.topLeft.x + adj.width / 2 - cx;
    const y = adj.topLeft.y + adj.height / 2 - cy;
    const length = goHypot(x, y);
    if (length === 0) continue;
    rays[n] = { node: adj, x: x / length, y: y / length, directions: direction };
    n++;
  }
  let spine = Infinity;
  let branchSum = 0.0;
  let branches = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dot = Math.max(-1, Math.min(1, rays[i].x * rays[j].x + rays[i].y * rays[j].y));
      const a = rays[i].directions;
      const b = rays[j].directions;
      if ((a & incomingDirection) !== 0 && (b & outgoingDirection) !== 0 ||
        (a & outgoingDirection) !== 0 && (b & incomingDirection) !== 0) {
        spine = Math.min(spine, 1 + dot);
      }
      if ((a & b) !== 0) {
        // Directions less than 60 degrees apart compete for a small visual wedge at the attachment; wider angles incur no cost. A
        // reciprocal pair can also be a continuation, but each pair contributes to the branch average only once.
        branchSum += Math.max(0, 2 * dot - 1);
        branches++;
      }
    }
  }
  let cost = 0.0;
  if (spine !== Infinity) cost += flowSpineWeight * spine;
  if (branches > 0) cost += flowBranchWeight * branchSum / branches;
  return node.graph.turnCost() * cost;
}

// ---- symmetry.go ----

/** NodesSymmetry sums local symmetry scores for nodes in order. */
export function nodesSymmetry(ctx, nodes, edgeAbductions) {
  let err = ctx.err();
  if (err) throw errorf(`EdgeLength: ${err.message}`, err);
  let sum = 0.0;
  for (let i = 0; i < nodes.length; i++) {
    scoringCancellationError(ctx, i);
    sum += nodeSymmetry_(ctx, nodes[i], edgeAbductions, true);
  }
  err = ctx.err();
  if (err) throw errorf(`EdgeLength: ${err.message}`, err);
  return sum;
}

/** NodeSymmetry evaluates a node and the neighboring symmetry it contributes to. */
export function nodeSymmetry(ctx, node, edgeAbductions) {
  return nodeSymmetry_(ctx, node, edgeAbductions, true);
}

function nodeSymmetry_(ctx, node, edgeAbductions, checkNeighbors) {
  edgeAbductions = edgeAbductions ?? null;
  let err = ctx.err();
  if (err) throw errorf(`EdgeLength: ${err.message}`, err);
  let score = 0.0;
  let maxScore = 0;

  const abductions = edgeAbductions ?? []; // ranging over a nil slice
  const usedEdgeAbductions = new Array(abductions.length).fill(false);
  let dedupedAdjacentNodes = [];
  const added = new Set();

  // We consider container children with protruding edges like neighbors for symmetry, their score matters for the container score
  if (node.isContainer()) {
    const childNodes = [];
    // Within node placement, we use edge abductions to discern children; otherwise, the AdjacentNodes are correct
    if (edgeAbductions === null) {
      const children = containersOf(node.graph, node);
      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        scoringCancellationError(ctx, i);
        for (let j = 0; j < child.edges.length; j++) {
          const e = child.edges[j];
          scoringCancellationError(ctx, j);
          const adj = child.adjacent(e);
          // We only want to consider symmetry of child nodes with protrutions
          if (!lg.isDescendantOf(adj.container, node)) {
            added.add(child);
            childNodes.push(child);
            break;
          }
        }
      }
    } else {
      for (let i = 0; i < edgeAbductions.length; i++) {
        const edgeAbduction = edgeAbductions[i];
        scoringCancellationError(ctx, i);
        if (usedEdgeAbductions[i]) continue;
        if (edgeAbduction.currentFrom === node) {
          if (edgeAbduction.originallyFrom !== null) {
            usedEdgeAbductions[i] = true;
            if (added.has(edgeAbduction.originallyFrom)) continue;
            added.add(edgeAbduction.originallyFrom);
            childNodes.push(edgeAbduction.originallyFrom);
          }
        }
        if (edgeAbduction.currentTo === node) {
          if (edgeAbduction.originallyTo !== null) {
            usedEdgeAbductions[i] = true;
            if (added.has(edgeAbduction.originallyTo)) continue;
            added.add(edgeAbduction.originallyTo);
            childNodes.push(edgeAbduction.originallyTo);
          }
        }
      }
    }

    for (let i = 0; i < childNodes.length; i++) {
      scoringCancellationError(ctx, i);
      const symmetry = nodeSymmetry_(ctx, childNodes[i], edgeAbductions, checkNeighbors);
      score += symmetry;
      maxScore++;
    }
  }

  // If a node has multiple edges to node A on one side, and only 1 edge to node B on another symmetric side, count that as symmetrical
  for (let edgeIndex = 0; edgeIndex < node.edges.length; edgeIndex++) {
    const e = node.edges[edgeIndex];
    scoringCancellationError(ctx, edgeIndex);
    const adjacentNode = node.adjacent(e);
    let adjacentNodeReplacement = adjacentNode;

    // Let's say A and A's container are both connected to B. We've already considered A's symmetry above, so we should only count B
    // as an adjacent node if it's not connected to a child
    let isConnectedToChild = false;
    if (node.isContainer()) {
      for (let i = 0; i < abductions.length; i++) {
        const edgeAbduction = abductions[i];
        scoringCancellationError(ctx, i);
        if (edgeAbduction.currentFrom === node && edgeAbduction.currentTo === adjacentNode) {
          if (edgeAbduction.originallyFrom !== null) {
            isConnectedToChild = true;
            break;
          }
        }
        if (edgeAbduction.currentFrom === adjacentNode && edgeAbduction.currentTo === node) {
          usedEdgeAbductions[i] = true;
          if (edgeAbduction.originallyTo !== null) {
            isConnectedToChild = true;
            break;
          }
        }
      }
    }
    if (isConnectedToChild) continue;

    // If we're considering symmetry for node B in the above diagram, we'll want to resolve to adjacent node to A, not container for A
    for (let i = 0; i < abductions.length; i++) {
      const edgeAbduction = abductions[i];
      scoringCancellationError(ctx, i);
      if (usedEdgeAbductions[i]) continue;
      // For symmetry, use cluster vessels
      if (edgeAbduction.currentFrom !== null && edgeAbduction.currentFrom.isClusterVessel()) continue;
      if (edgeAbduction.currentTo !== null && edgeAbduction.currentTo.isClusterVessel()) continue;
      if (node.graph.isSequenceVessel(edgeAbduction.currentFrom) || node.graph.isSequenceVessel(edgeAbduction.currentTo)) continue;
      if (edgeAbduction.currentFrom === node && edgeAbduction.currentTo === adjacentNode) {
        usedEdgeAbductions[i] = true;
        if (edgeAbduction.originallyTo !== null) adjacentNodeReplacement = edgeAbduction.originallyTo;
        break;
      }
      if (edgeAbduction.currentFrom === adjacentNode && edgeAbduction.currentTo === node) {
        usedEdgeAbductions[i] = true;
        if (edgeAbduction.originallyFrom !== null) adjacentNodeReplacement = edgeAbduction.originallyFrom;
        break;
      }
    }

    // For clusters within containers, the Originally is pointed to the cluster node still
    if (lg.clusterIsActive(adjacentNodeReplacement.cluster)) adjacentNodeReplacement = adjacentNodeReplacement.cluster.vessel;
    else if (lg.sequenceIsActive(adjacentNodeReplacement.sequence)) adjacentNodeReplacement = adjacentNodeReplacement.sequence.vessel;

    if (added.has(adjacentNodeReplacement)) continue;

    dedupedAdjacentNodes.push(adjacentNodeReplacement);
    added.add(adjacentNodeReplacement);
  }

  // When we're resolving symmetry for children during node placement, all their edges were abducted to their containers, so here we find those
  for (let i = 0; i < abductions.length; i++) {
    const edgeAbduction = abductions[i];
    scoringCancellationError(ctx, i);
    let connectedNode = null;
    if (edgeAbduction.originallyFrom === node) {
      // When the adjacent node is also a container
      if (edgeAbduction.originallyTo !== null && edgeAbduction.currentTo !== null &&
        !edgeAbduction.currentTo.isClusterVessel() && !node.graph.isSequenceVessel(edgeAbduction.currentTo)) {
        connectedNode = edgeAbduction.originallyTo;
      } else {
        connectedNode = edgeAbduction.currentTo;
      }
    }
    if (edgeAbduction.originallyTo === node) {
      if (edgeAbduction.originallyFrom !== null && edgeAbduction.currentFrom !== null &&
        !edgeAbduction.currentFrom.isClusterVessel() && !node.graph.isSequenceVessel(edgeAbduction.currentFrom)) {
        connectedNode = edgeAbduction.originallyFrom;
      } else {
        connectedNode = edgeAbduction.currentFrom;
      }
    }
    if (connectedNode !== null) {
      if (added.has(connectedNode)) continue;

      dedupedAdjacentNodes.push(connectedNode);
      added.add(connectedNode);
    }
  }

  for (let i = 0; i < dedupedAdjacentNodes.length; i++) {
    scoringCancellationError(ctx, i);
    const d = node.distanceTo(dedupedAdjacentNodes[i], true);
    if (d > 1200) {
      dedupedAdjacentNodes = dedupedAdjacentNodes.slice(0, i).concat(dedupedAdjacentNodes.slice(i + 1));
      i--;
    }
  }

  const matched = new Array(dedupedAdjacentNodes.length).fill(false);
  const s = computeSymmetryScoreInto(ctx, node, dedupedAdjacentNodes, matched);
  score += s;
  maxScore += dedupedAdjacentNodes.length;

  // Node A may not have symmetry itself, but we still don't want it to move because it contributes to B's symmetry. So we check
  // neighbors, see that B is symmetrical, which makes A also symmetrical
  if (checkNeighbors) {
    for (let i = 0; i < dedupedAdjacentNodes.length; i++) {
      const adjacentNode = dedupedAdjacentNodes[i];
      scoringCancellationError(ctx, i);
      if (matched[i]) continue;
      const adjNodeSymm = nodeSymmetry_(ctx, adjacentNode, edgeAbductions, false);
      score += adjNodeSymm;
    }
  }

  // No adjacent nodes, not a container of a child with protruding edges
  if (maxScore === 0) return 0.0;
  err = ctx.err();
  if (err) throw errorf(`EdgeLength: ${err.message}`, err);
  return score / maxScore;
}

/**
 * Ideal: symmetrical through the center (two neighbors mirrored across a node). Not bad and still rewarded: a node with two
 * neighbors under its two corners, a smaller score. computeSymmetryScoreInto writes match state into caller-owned storage.
 */
function computeSymmetryScoreInto(ctx, node, neigh, matchedSlice) {
  let err = ctx.err();
  if (err) throw errorf(`EdgeLength: ${err.message}`, err);
  const n = neigh.length;
  if (n < 2) return 0;
  matchedSlice.fill(false, 0, n);

  let score = 0.0;

  const ownSiblings = containersOf(node.graph, node.container);
  let otherSiblings = null;

  for (let i = 0; i < neigh.length; i++) {
    const n1 = neigh[i];
    scoringCancellationError(ctx, i);
    if (matchedSlice[i]) continue;
    if (n1.container !== node.container) otherSiblings = containersOf(node.graph, n1.container);
    else otherSiblings = null;

    let bestIdx = -1;
    let best = 0.0;

    // When two nodes are considered mirrored for the sake of symmetry, we only want ones under the same container
    for (let j = i + 1; j < n; j++) {
      scoringCancellationError(ctx, j - i - 1);
      if (matchedSlice[j]) continue;
      const n2 = neigh[j];
      if (n1.container !== n2.container) continue;
      // When nodes vary by a lot in size, it also doesn't come off as symmetrical
      const area1 = n1.area();
      const area2 = n2.area();
      if (area1 > 2 * area2 || area2 > 2 * area1) continue;

      let ms = -Infinity;
      // The two nodes can be symmetrical across the x or y axis
      for (const isX of [true, false]) {
        let axis = node.topLeft.x + node.width / 2;
        if (!isX) axis = node.topLeft.y + node.height / 2;
        if (isMirrored(n1, n2, isX, axis)) {
          if (node.overlapsAlongDimension(n1, isX, true) && node.overlapsAlongDimension(n2, isX, true)) ms = 2;
          else ms = 0.5;
          // no need to continue, as there's no way n1-n2 is aligned both horizontally and vertically
          break;
        }
      }
      // skip obstruction search if the nodes aren't aligned
      if (ms < 0) continue;

      // We only want to count mirrored objects when they have no obstructions from node to it
      const isObstructed = obstructed(ctx, node, n1, n2, ownSiblings, otherSiblings);
      if (isObstructed) continue;

      if (ms > best) {
        best = ms;
        bestIdx = j;
        if (ms === 2) break;
      }
    }

    if (bestIdx !== -1) {
      matchedSlice[i] = true;
      matchedSlice[bestIdx] = true;
      score += best;
    }
  }

  err = ctx.err();
  if (err) throw errorf(`EdgeLength: ${err.message}`, err);
  return score;
}

function obstructed(ctx, center, a, b, sib1, sib2) {
  const bounds = boundsIncluding(boundsIncluding(scoringNodeBounds(center), scoringNodeBounds(a)), scoringNodeBounds(b));
  const check = (sibs) => {
    if (sibs === null) return false;
    for (let i = 0; i < sibs.length; i++) {
      const s = sibs[i];
      scoringCancellationError(ctx, i);
      if (s === null || s.topLeft === null || s.graph !== center.graph) continue;
      if (s === center || s === a || s === b) continue;
      if (boundsExcludes(bounds, s)) continue;
      if (center.isDescendantOf(s) || a.isDescendantOf(s) || b.isDescendantOf(s)) continue;
      if (s.isDescendantOf(center) || s.isDescendantOf(a) || s.isDescendantOf(b)) continue;
      if (s.passesThrough(center.center(), a.center()) || s.passesThrough(center.center(), b.center())) return true;
    }
    return false;
  };
  const isObstructed = check(sib1);
  if (isObstructed) return isObstructed;
  return check(sib2);
}

/** ColumnCrossingCost scores crossings between labeled table-column edges. */
export function columnCrossingCost(ctx, node, edgeAbductions) {
  const err = ctx.err();
  if (err) throw errorf(`EdgeLength: ${err.message}`, err);
  if (!node.isTable()) return 0;

  const abductions = edgeAbductions ?? [];
  const edgeToAbduction = new Map();
  const segments = [];
  for (let i = 0; i < abductions.length; i++) {
    scoringCancellationError(ctx, i);
    edgeToAbduction.set(abductions[i].edge, abductions[i]);
  }

  for (let i = 0; i < node.edges.length; i++) {
    const e = node.edges[i];
    scoringCancellationError(ctx, i);
    let fromPort;
    let toPort;
    let hasFromPort;
    let hasToPort;
    const abduction = edgeToAbduction.get(e);
    if (abduction !== undefined) {
      [fromPort, toPort, hasFromPort, hasToPort] = e.facingTablePortValues(abduction.originallyFrom, abduction.originallyTo);
    } else {
      [fromPort, toPort, hasFromPort, hasToPort] = e.facingTablePortValues(null, null);
    }

    if (!hasFromPort || !hasToPort) continue;
    segments.push(lg.newCrossingSegment(fromPort, toPort));
  }

  const crossings = lg.countSegmentCrossingsContext(ctx, segments);
  return lg.CrossingCostWeight * crossings * node.graph.cellSize;
}

/** isMirrored checks if nodeA is mirrored to nodeB along the given axis line. isXAxis = true means they are mirrored along a vertical line. */
function isMirrored(nodeA, nodeB, isXAxis, axisVal) {
  const nodeAtlX = nodeA.topLeft.x;
  const nodeAtlY = nodeA.topLeft.y;
  const nodeAbrX = nodeA.topLeft.x + nodeA.width;
  const nodeAbrY = nodeA.topLeft.y + nodeA.height;

  const nodeBtlX = nodeB.topLeft.x;
  const nodeBtlY = nodeB.topLeft.y;
  const nodeBbrX = nodeB.topLeft.x + nodeB.width;
  const nodeBbrY = nodeB.topLeft.y + nodeB.height;

  const symmetryTolerance = symmetryToleranceBand * nodeA.graph.cellSize;
  if (isXAxis) {
    if (nodeA.topLeft.x === nodeB.topLeft.x) return false;

    // The left edge of node A should be on other side of axisVal from right edge of node B
    if (nodeA.topLeft.x > nodeB.topLeft.x) {
      // Axis val must be in between
      if (!((axisVal > nodeBbrX) && (axisVal < nodeAtlX))) return false;
      // Their distances from the axis line should be roughly equal
      if (Math.abs((nodeAtlX - axisVal) - (axisVal - nodeBbrX)) > symmetryTolerance) return false;
    } else if (nodeA.topLeft.x < nodeB.topLeft.x) {
      if (!((axisVal > nodeAbrX) && (axisVal < nodeBtlX))) return false;
      if (Math.abs((nodeBtlX - axisVal) - (axisVal - nodeAbrX)) > symmetryTolerance) return false;
    }

    // Centers match
    return Math.abs(((nodeAtlY + nodeAbrY) / 2.0) - ((nodeBtlY + nodeBbrY) / 2.0)) <= symmetryTolerance;
  }
  if (nodeA.topLeft.y === nodeB.topLeft.y) return false;
  if (nodeA.topLeft.y > nodeB.topLeft.y) {
    if (!((axisVal > nodeBbrY) && (axisVal < nodeAtlY))) return false;
    if (Math.abs((nodeAtlY - axisVal) - (axisVal - nodeBbrY)) > symmetryTolerance) return false;
  } else if (nodeA.topLeft.y < nodeB.topLeft.y) {
    if (!((axisVal > nodeAbrY) && (axisVal < nodeBtlY))) return false;
    if (Math.abs((nodeBtlY - axisVal) - (axisVal - nodeAbrY)) > symmetryTolerance) return false;
  }

  // Centers match
  return Math.abs(((nodeAtlX + nodeAbrX) / 2.0) - ((nodeBtlX + nodeBbrX) / 2.0)) <= symmetryTolerance;
}

// exports for the checks of tools/d2ref (the Go side exports the same through overlay/placementcost/xdump_export.go)
export const _internals = {
  Fnv64a, goHypot, directionCompass, compassDelta, compassAxisDelta, sizelessOrientation, placementDistance, distanceBetweenTableColumns,
  clusterExactlyTwoExternalConnectedNodes, isMirrored, flowContinuityCost, prepareNodeEdgeLength, newEdgeScratch,
};
