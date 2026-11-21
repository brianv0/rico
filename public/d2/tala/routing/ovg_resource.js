// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of the Go package d2layouts/d2talalayout/internal/routing (D2 v0.9.0), file(s): ovg_resource.go.
//
// Counters are JS numbers (uint64 in Go); `ovgBuildLimits` is { intersectionCandidates, nodes, edges, work }.

import { errorf, errorsNew } from '../goerrors.js';
import { background } from '../context.js';
import * as limits from '../limits.js';
import * as geo from '../../geo.js';
import { MinRouteNodeClearance } from '../layoutgraph.js';
import { cachedContextErr } from './work.js';
import { OVGNode, directionsAny } from './ovg_node.js';
import { nonNilEquals } from './ovg_edge.js';
import { routeAggregateWorkFromContext } from './route_stage_guard.js';
import {
  maxOVGIntersectionCandidates, maxOVGNodes, maxOVGEdges, maxOVGWorkUnits, routeStageContextCheckStride,
} from './route_limits.js';

export { maxOVGIntersectionCandidates, maxOVGNodes, maxOVGEdges, maxOVGWorkUnits };

export const errOVGResourceLimit = errorsNew('TALA OVG resource limit exceeded');

/** The largest Go int as a JS number (the int limit of allocation capacities). */
const maxIntAsUint64 = () => Number.MAX_SAFE_INTEGER;

export function defaultOVGBuildLimits() {
  return {
    intersectionCandidates: maxOVGIntersectionCandidates,
    nodes: maxOVGNodes,
    edges: maxOVGEdges,
    work: maxOVGWorkUnits,
  };
}

export class OvgBuildGuard {
  constructor(ctx, ovgLimits) {
    this.ctx = ctx;
    this.done = ctx.hasDone();
    // aggregate is shared by all OVGs and route-search flavors in one public routing operation. EdgeRoutingStage also reuses this
    // entire guard across subgraphs, making its resource counters stage-wide rather than per graph.
    this.aggregate = routeAggregateWorkFromContext(ctx);

    this.limits = ovgLimits;
    this.candidates = 0;
    this.nodes = 0;
    this.edges = 0;
    this.work = 0;
  }

  check() {
    const err = cachedContextErr(this.ctx, this.done);
    if (err) throw errorf(`EdgeRouting: ${err.message}`, err);
  }

  reserve(resource, field, amount, limit) {
    this.check();
    const [next, ok] = limits.checkedAddUint64(this[field], amount);
    if (!ok) throw ovgResourceOverflow(resource);
    if (next > limit) throw ovgResourceExceeded(resource, next, limit);
    this[field] = next;
  }

  reserveCandidates(amount) {
    this.reserve('intersection candidate count', 'candidates', amount, this.limits.intersectionCandidates);
  }

  reserveNodes(amount) {
    this.reserve('node count', 'nodes', amount, this.limits.nodes);
  }

  reserveEdges(amount) {
    this.reserve('edge count', 'edges', amount, this.limits.edges);
  }

  reserveWork(amount) {
    const [next, ok] = limits.checkedAddUint64(this.work, amount);
    if (!ok) {
      this.check();
      throw ovgResourceOverflow('work units');
    }
    if (next > this.limits.work) {
      this.check();
      throw ovgResourceExceeded('work units', next, this.limits.work);
    }
    // Synthetic contexts without Done retain per-operation Err polling. Standard contexts poll at a bounded stride, avoiding a
    // channel select in every inner OVG scan while still checking before any resource-limit result.
    if (!this.done || amount === 0 ||
      Math.floor(this.work / routeStageContextCheckStride) !== Math.floor(next / routeStageContextCheckStride)) {
      this.check();
    }
    this.work = next;
    if (this.aggregate !== null) this.aggregate.add(amount);
  }

  step() {
    this.reserveWork(1);
  }

  reserveSortWork(length) {
    if (length < 2) {
      this.check();
      return;
    }
    let levels = 0;
    for (let remaining = length - 1; remaining > 0; remaining = Math.floor(remaining / 2)) levels++;
    const [work, ok] = limits.checkedMulUint64(length, levels);
    if (!ok) throw ovgResourceOverflow('sort work units');
    this.reserveWork(work);
  }

  addNode(ovg, node) {
    this.step();
    const occupant = ovg.occupiedPoints.get(node.point);
    if (occupant !== undefined) return occupant;
    this.reserveNodes(1);
    ovg.addNodeUnchecked(node);
    return node;
  }

  addPoint(ovg, point) {
    this.step();
    const occupant = ovg.occupiedPoints.get(point);
    if (occupant !== undefined) return occupant;
    this.reserveNodes(1);
    const node = new OVGNode(point);
    ovg.addNodeUnchecked(node);
    return node;
  }

  /**
   * newDerivedNode accounts for a temporary OVG node before allocating it. The node may later also consume a slot in one or more
   * OVGs; those memberships are deliberately counted separately by addNode.
   */
  newDerivedNode(point) {
    this.step();
    this.reserveNodes(1);
    return new OVGNode(point);
  }

  newCandidateNode(point) {
    this.step();
    return new OVGNode(point);
  }

  addNodeUnchecked(ovg, node) {
    this.step();
    this.reserveNodes(1);
    ovg.addNodeUnchecked(node);
  }

  connect(ovg, nodeA, nodeB) {
    this.step();
    if (nodeA.isNodeCenter && !nodeB.isPort() || nodeB.isNodeCenter && !nodeA.isPort()) return null;
    this.reserveEdges(1);
    return ovg.connect(nodeA, nodeB);
  }

  pointNearGraphNode(graph, point) {
    for (const node of graph.nodes) {
      this.step();
      // It is valid for visibility nodes to lie on container boundaries.
      if (node.isContainer()) continue;
      if (node.isPointNear(point)) return true;
    }
    return false;
  }

  tightBoundingBox(nodes) {
    if (nodes.length === 0) {
      this.check();
      return [geo.newPoint(-Infinity, -Infinity), geo.newPoint(Infinity, Infinity)];
    }
    if (nodes[0].topLeft === null) {
      this.check();
      return [null, null];
    }

    let minX = nodes[0].topLeft.x;
    let minY = nodes[0].topLeft.y;
    let maxX = nodes[0].topLeft.x + nodes[0].width;
    let maxY = nodes[0].topLeft.y + nodes[0].height;
    for (const node of nodes) {
      this.step();
      if (node.topLeft === null) return [null, null];
      minX = Math.min(minX, node.topLeft.x);
      minY = Math.min(minY, node.topLeft.y);
      maxX = Math.max(maxX, node.topLeft.x + node.width);
      maxY = Math.max(maxY, node.topLeft.y + node.height);
    }
    this.check();
    return [geo.newPoint(minX, minY), geo.newPoint(maxX, maxY)];
  }

  ovgBoundingBox(ovg) {
    if (ovg.nodes.length === 0) {
      this.check();
      return [geo.newPoint(-Infinity, -Infinity), geo.newPoint(Infinity, Infinity)];
    }
    let minX = ovg.nodes[0].x;
    let minY = ovg.nodes[0].y;
    let maxX = ovg.nodes[0].x;
    let maxY = ovg.nodes[0].y;
    for (const node of ovg.nodes) {
      this.step();
      minX = Math.min(minX, node.x);
      minY = Math.min(minY, node.y);
      maxX = Math.max(maxX, node.x);
      maxY = Math.max(maxY, node.y);
    }
    this.check();
    return [geo.newPoint(minX, minY), geo.newPoint(maxX, maxY)];
  }

  portsByOrientation(ovg, owner, orientation) {
    const ports = [];
    const own = ovg.ports.get(owner) ?? [];
    const seen = new Set();
    for (const port of own) {
      this.step();
      if (seen.has(port)) continue;
      seen.add(port);
      if (port.hasPortDirection(owner, orientation)) ports.push(port);
    }
    this.check();
    return ports;
  }

  passesThroughAllowingPorts(node, p1, p2, direction, ports) {
    if (ports.length === 0) {
      const r = node.passesThrough(p1, p2);
      this.check();
      return r;
    }
    // A port can exempt a segment only when it points outwards in the supplied direction. Most visibility nodes have no port owner
    // (NONE), so do this invariant direction check before scanning a shape's complete port list.
    let allowsPort = false;
    switch (direction) {
      case geo.Orientation.Top:
        allowsPort = p1.x === p2.x && p1.y > p2.y;
        break;
      case geo.Orientation.Bottom:
        allowsPort = p1.x === p2.x && p1.y < p2.y;
        break;
      case geo.Orientation.Left:
        allowsPort = p1.y === p2.y && p1.x > p2.x;
        break;
      case geo.Orientation.Right:
        allowsPort = p1.y === p2.y && p1.x < p2.x;
        break;
    }
    if (allowsPort) {
      for (const port of ports) {
        this.step();
        if (nonNilEquals(port.point, p1) || nonNilEquals(port.point, p2)) return false;
      }
    }
    const r = node.passesThrough(p1, p2);
    this.check();
    return r;
  }

  isDescendantOf(descendant, ancestor) {
    for (let current = descendant; ;) {
      this.step();
      if (ancestor === current) return true;
      if (current === null) return false;
      if (current.container !== null) current = current.container;
      else if (current.cluster !== null) current = current.cluster.vessel;
      else if (current.sequence !== null) current = current.sequence.vessel;
      else return ancestor === null;
    }
  }

  hasFixedAncestor(node) {
    for (let current = node; current !== null; current = current.owningContainer()) {
      this.step();
      if (current.fixedTopLeft !== null) return true;
    }
    return false;
  }

  sameNodes(a, b) {
    if (a.length !== b.length) {
      this.check();
      return false;
    }
    for (let i = 0; i < a.length; i++) {
      this.step();
      if (a[i] !== b[i]) return false;
    }
    this.check();
    return true;
  }

  isRestrictedSequencePort(node) {
    const owners = node.portOwners();
    if (owners.size === 0) {
      this.check();
      return false;
    }
    for (const [owner, metadata] of owners) {
      this.step();
      if (owner.sequence === null) return false;
      if (directionsAny(metadata.directions, (direction) => {
        switch (direction) {
          case geo.Orientation.Left:
            return owner.sequence.first() === owner;
          case geo.Orientation.Right:
            return owner.sequence.last() === owner;
          default:
            return true;
        }
      })) {
        return false;
      }
    }
    this.check();
    return true;
  }

  containerRDFSOrder(graph, root) {
    let order = [];
    if (root !== null && !root.isContainer()) {
      this.check();
      return order;
    }
    const children = graph.containers.get(root) ?? [];
    for (let ci = children.length - 1; ci >= 0; ci--) {
      const child = children[ci];
      this.step();

      if (child.isContainer()) {
        const descendants = this.containerRDFSOrder(graph, child);
        order = order.concat(descendants);
        order.push(child);
        continue;
      }
      if (child.isClusterVessel()) {
        const cluster = graph.clusters.get(child);
        for (let ni = cluster.nodes.length - 1; ni >= 0; ni--) {
          const clusterNode = cluster.nodes[ni];
          this.step();

          if (!clusterNode.isContainer()) continue;
          const descendants = this.containerRDFSOrder(graph, clusterNode);
          order = order.concat(descendants);
          order.push(clusterNode);
        }
      }
    }
    this.check();
    return order;
  }

  /**
   * reserveHierarchyTransform accounts for a complete, non-interruptible coordinate transform before it mutates graph or OVG
   * state. Preflighting the whole transform lets the existing inverse defers remain infallible.
   */
  reserveHierarchyTransform(ovg, graphNodeCount) {
    this.reserveWork(graphNodeCount);
    for (const node of ovg.nodes) {
      this.step(); // preflight scan
      this.reserveWork(2); // point transform and reindex
      for (let i = 0; i < node.portOwners().size; i++) {
        this.step(); // preflight scan
        this.reserveWork(1); // direction transform
      }
    }
    this.check();
  }

  hasCoordinateWithin(sortedValues, coordinate, distance) {
    let low = 0, high = sortedValues.length;
    const threshold = coordinate - distance;
    while (low < high) {
      this.step();
      const mid = (low + high) >>> 1;
      if (sortedValues[mid] < threshold) low = mid + 1;
      else high = mid;
    }
    const r = low < sortedValues.length && sortedValues[low] <= coordinate + distance;
    this.check();
    return r;
  }
}

/** newOVGBuildGuard(ctx, limits) */
export function newOVGBuildGuard(ctx, ovgLimits) {
  if (ctx == null) ctx = background();
  const guard = new OvgBuildGuard(ctx, ovgLimits);
  guard.check();
  return guard;
}

export function ovgResourceOverflow(resource) {
  return errorf(`${errOVGResourceLimit.message}: ${resource} arithmetic overflow`, errOVGResourceLimit);
}

export function ovgResourceExceeded(resource, requested, limit) {
  return errorf(`${errOVGResourceLimit.message}: ${resource} ${requested} exceeds limit ${limit}`, errOVGResourceLimit);
}

export function checkedOVGIntersectionCount(xCount, yCount) {
  const [count, ok] = limits.checkedMulUint64(xCount, yCount);
  if (!ok) throw ovgResourceOverflow('intersection candidate count');
  return count;
}

export function checkedUint64ToInt(value, intLimit) {
  if (value > intLimit) throw ovgResourceExceeded('allocation capacity', value, intLimit);
  return value;
}

export function checkedOVGSliceCapacity(...lengths) {
  let total = 0;
  for (const length of lengths) {
    const [next, ok] = limits.checkedAddUint64(total, length);
    if (!ok) throw ovgResourceOverflow('allocation capacity');
    total = next;
  }
  return checkedUint64ToInt(total, maxIntAsUint64());
}

/**
 * checkedOVGEdgeCapacity computes the exact sweep upper bound used for slice preallocation. Every eligible node appears in one
 * horizontal and one vertical line, so the sweeps can add at most (n-h)+(n-v) edges.
 */
export function checkedOVGEdgeCapacity(existing, nodeCount, horizontalLines, verticalLines, edgeLimit, intLimit) {
  if (existing > edgeLimit) throw ovgResourceExceeded('edge count', existing, edgeLimit);

  let [twiceNodes, ok] = limits.checkedMulUint64(nodeCount, 2);
  if (!ok) throw ovgResourceOverflow('edge capacity');
  const [lineCount, ok2] = limits.checkedAddUint64(horizontalLines, verticalLines);
  if (!ok2 || twiceNodes < lineCount) throw ovgResourceOverflow('edge capacity');
  const newEdges = twiceNodes - lineCount;
  let [capacity, ok3] = limits.checkedAddUint64(existing, newEdges);
  if (!ok3) throw ovgResourceOverflow('edge capacity');
  if (capacity > edgeLimit) capacity = edgeLimit;
  return checkedUint64ToInt(capacity, intLimit);
}

// ovgPointProximityIndex is a build-local broad phase for the Cartesian intersection grid. Candidate X coordinates are known in
// advance, so each coordinate keeps graph nodes whose expanded box can contain a candidate. Nodes stay in graph order and the exact
// isPointNear predicate remains the final test.
export class OvgPointProximityIndex {
  constructor() {
    this.byX = new Map(); // Map<float64, Node[]>
  }

  pointNear(x, y, guard) {
    guard.step();
    const point = new geo.Point(x, y);
    for (const node of this.byX.get(x) ?? []) {
      guard.step();
      if (node.isPointNear(point)) return true;
    }
    return false;
  }
}

export function newOVGPointProximityIndex(graph, xs, guard) {
  const index = new OvgPointProximityIndex();
  for (const x of xs) {
    guard.step();
    for (const node of graph.nodes) {
      guard.step();
      if (node.isContainer()) continue;
      if (node.topLeft.x - MinRouteNodeClearance <= x && node.topLeft.x + node.width + MinRouteNodeClearance >= x) {
        let list = index.byX.get(x);
        if (list === undefined) { list = []; index.byX.set(x, list); }
        list.push(node);
      }
    }
  }
  guard.check();
  return index;
}

/** fixedOverlapsForBuild (a method of OVG in Go, ovg.fixedOverlapsForBuild): the per-OVG cache of the fixed-position overlaps. */
export function fixedOverlapsForBuild(ovg, graph, nodes, guard) {
  for (const entry of ovg.fixedOverlapsCache) {
    guard.step();
    const same = guard.sameNodes(entry.nodes, nodes);
    if (entry.graph === graph && same) return entry.overlaps;
  }

  const fixedNodes = [];
  for (const node of nodes) {
    guard.step();
    const fixed = guard.hasFixedAncestor(node);
    if (fixed) fixedNodes.push(node);
  }

  const overlaps = new Set();
  for (const node of fixedNodes) {
    if (overlaps.has(node)) continue;
    for (const other of nodes) {
      guard.step();
      const nodeBelowOther = guard.isDescendantOf(node, other);
      const otherBelowNode = guard.isDescendantOf(other, node);
      if (node === other || nodeBelowOther || otherBelowNode) continue;
      if (node.box.overlaps(other.box)) {
        overlaps.add(node);
        const fixed = guard.hasFixedAncestor(other);
        if (fixed) overlaps.add(other);
        break;
      }
    }
  }

  ovg.fixedOverlapsCache.push({ graph, nodes: [...nodes], overlaps });
  return overlaps;
}

export class OvgPortIndex {
  constructor() {
    this.xByY = new Map();
    this.yByX = new Map();
    this.owners = [];
    this.ownersByX = new Map();
    this.ownersByY = new Map();
    this.verticalBlockers = new Map();
    this.horizontalBlockers = new Map();
  }

  /**
   * Owner indexes are appended in ascending order during index construction. Merge the two axis lists so a query visits only
   * aligned owners, once each, in the same order as a full owners scan. Duplicate ports and owners aligned on both axes do not
   * count as distinct unobstructed graph nodes.
   */
  alignedOwners(x, y) {
    return new OvgAlignedOwners(this.ownersByX.get(x) ?? [], this.ownersByY.get(y) ?? []);
  }

  tooClose(x, y, distance, guard) {
    const tooClose = guard.hasCoordinateWithin(this.xByY.get(y) ?? [], x, distance);
    if (tooClose) return tooClose;
    return guard.hasCoordinateWithin(this.yByX.get(x) ?? [], y, distance);
  }
}

class OvgAlignedOwners {
  constructor(byX, byY) {
    this.byX = byX;
    this.byY = byY;
    this.ix = 0;
    this.iy = 0;
  }

  /** next returns [ownerIndex, ok]. */
  next(guard) {
    guard.step();
    const remX = this.byX.length - this.ix;
    const remY = this.byY.length - this.iy;
    if (remX === 0 && remY === 0) return [0, false];
    let owner;
    if (remY === 0 || remX > 0 && this.byX[this.ix] < this.byY[this.iy]) owner = this.byX[this.ix];
    else owner = this.byY[this.iy];
    while (this.ix < this.byX.length && this.byX[this.ix] === owner) {
      guard.step();
      this.ix++;
    }
    while (this.iy < this.byY.length && this.byY[this.iy] === owner) {
      guard.step();
      this.iy++;
    }
    return [owner, true];
  }
}

const sortFloats = (values) => values.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

/** newOVGPortIndex(ports: Map<Node, OVGNode[]>, graph, fixedOverlaps: Set<Node>, guard) */
export function newOVGPortIndex(ports, graph, fixedOverlaps, guard) {
  const index = new OvgPortIndex();
  const push = (m, k, v) => {
    const list = m.get(k);
    if (list === undefined) m.set(k, [v]);
    else list.push(v);
  };
  for (const [owner, nodePorts] of ports) {
    guard.step();
    const ownerIndex = index.owners.length;
    index.owners.push(owner);
    for (const port of nodePorts) {
      guard.step();
      push(index.xByY, port.y, port.x);
      push(index.yByX, port.x, port.y);
      push(index.ownersByX, port.x, ownerIndex);
      push(index.ownersByY, port.y, ownerIndex);
    }
  }
  for (const values of index.xByY.values()) {
    guard.reserveSortWork(values.length);
    sortFloats(values);
  }
  for (const values of index.yByX.values()) {
    guard.reserveSortWork(values.length);
    sortFloats(values);
  }

  // A port-to-candidate segment is axis aligned. Precompute the graph-order blockers that can intersect each port axis, then retain
  // passesThrough as the exact segment predicate at query time.
  if (graph !== null) {
    for (const x of index.ownersByX.keys()) {
      guard.step();
      for (const node of graph.nodes) {
        guard.step();
        if (node === null || node.topLeft === null || node.isContainer()) continue;
        if (fixedOverlaps.has(node)) continue;
        const left = Math.min(node.topLeft.x, node.topLeft.x + node.width);
        const right = Math.max(node.topLeft.x, node.topLeft.x + node.width);
        if (left <= x && x <= right) push(index.verticalBlockers, x, node);
      }
    }
    for (const y of index.ownersByY.keys()) {
      guard.step();
      for (const node of graph.nodes) {
        guard.step();
        if (node === null || node.topLeft === null || node.isContainer()) continue;
        if (fixedOverlaps.has(node)) continue;
        const top = Math.min(node.topLeft.y, node.topLeft.y + node.height);
        const bottom = Math.max(node.topLeft.y, node.topLeft.y + node.height);
        if (top <= y && y <= bottom) push(index.horizontalBlockers, y, node);
      }
    }
  }
  return index;
}

