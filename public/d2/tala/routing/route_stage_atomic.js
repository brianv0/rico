// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of the Go package d2layouts/d2talalayout/internal/routing (D2 v0.9.0), file(s): route_stage_guard.go (the atomic
// route-stage machinery: routeMutationSnapshot, captureRouteMutations, validateRouteStageGeometry, routeStageGraphBoundingBox and
// runAtomicRouteStage*). The work-guard half is route_stage_guard.js.
//
// Differences from Go: a JS array has no spare capacity, so the capacity based charges (`cap(edge.Points)`) are `edge.points.length`;
// Go's `defer` + `recover` is try/catch (a non-GoError exception is the Go panic: restore, rethrow).

import * as geo from '../../geo.js';
import * as label from '../../label.js';
import { errorf } from '../goerrors.js';
import * as invariant from '../invariant.js';
import * as lg from '../layoutgraph.js';
import { fixedBoundingBox } from '../graphbounds.js';
import { goRound } from '../../gomath.js';
import { newRouteWorkGuard } from './route_stage_guard.js';
import { snapshotPointer, snapshotEdge, restoreEdge } from './snapshot.js';

/** routeMutationSnapshot: { graph, cellSize, costs, nodes: Map<Node, pointerSnapshot>, nodeGraphs: Map<Node, Graph>, edges: Map<Edge, edgeSnapshot> } */
export class RouteMutationSnapshot {
  constructor() {
    this.graph = null;
    this.cellSize = 0;
    this.costs = null;
    this.nodes = new Map();
    this.nodeGraphs = new Map();
    this.edges = new Map();
  }

  restore() {
    if (this.graph !== null) {
      this.graph.cellSize = this.cellSize;
      this.graph.restoreRoutingCosts(this.costs);
    }
    for (const [node, topLeft] of this.nodes) {
      node.topLeft = topLeft.restore();
      node.graph = this.nodeGraphs.get(node);
    }
    for (const [edge, state] of this.edges) restoreEdge(state, edge);
  }
}

/**
 * captureRouteMutations records every route reachable through the collections used by post-processing. captureEdge preserves the
 * exact slice header, backing array, point identities, and point values.
 */
export function captureRouteMutations(g, extraEdges, guard) {
  const snapshot = new RouteMutationSnapshot();
  snapshot.graph = g;
  if (g !== null) {
    snapshot.cellSize = g.cellSize;
    snapshot.costs = g.routingCosts();
  }
  const nodeQueue = [];
  const captureNode = (node) => {
    guard.step();
    if (node === null) return;
    if (snapshot.nodes.has(node)) return;
    snapshot.nodes.set(node, snapshotPointer(node.topLeft));
    snapshot.nodeGraphs.set(node, node.graph);
    nodeQueue.push(node);
  };
  const capture = (edge) => {
    // Charge every reference before de-duplication. A hostile repeated-edge slice must not turn snapshot discovery into unaccounted
    // linear work.
    guard.step();
    if (edge === null) return;
    if (snapshot.edges.has(edge)) return;

    for (let index = 0; index < edge.points.length; index++) guard.step();
    snapshot.edges.set(edge, snapshotEdge(edge));
    captureNode(edge.from);
    captureNode(edge.to);
  };
  if (g !== null) {
    for (const edge of g.edges) capture(edge);
    for (const node of g.nodes) {
      captureNode(node);
      if (node === null) continue;
      for (const edge of node.edges) capture(edge);
    }
  }
  for (const edge of extraEdges ?? []) capture(edge);
  // A route stage temporarily rewrites graph references not just for graph members but also for container, cluster, and sequence
  // descendants. Walk each unique descendant once so rollback covers those references and any positions a route helper may move.
  for (let index = 0; index < nodeQueue.length; index++) {
    const node = nodeQueue[index];
    let nodeGraph = node.graph;
    if (nodeGraph === null) nodeGraph = g;
    if (nodeGraph === null) continue;
    if (node.isContainer()) {
      for (const child of nodeGraph.containers.get(node) ?? []) captureNode(child);
    }
    if (node.isClusterVessel()) {
      const cluster = nodeGraph.clusters.get(node);
      if (cluster !== undefined && cluster !== null) {
        for (const child of cluster.nodes) captureNode(child);
      }
    }
    const sequence = nodeGraph.sequences.get(node);
    if (sequence !== undefined && sequence !== null) {
      for (const child of sequence.nodes) captureNode(child);
    }
  }
  guard.finish();
  return snapshot;
}

export function validateRouteStageGeometry(g, extraEdges, guard) {
  extraEdges = extraEdges ?? [];
  if (extraEdges.length > lg.MaxTopologyReferences) {
    throw errorf(`TALA ${guard.location} extra edge references exceed limit ${lg.MaxTopologyReferences}`);
  }
  const finite = (value) => !Number.isNaN(value) && !(value === Infinity || value === -Infinity);
  const seenNodes = new Set();
  const graphNodes = new Set();
  const validateNode = (node, description) => {
    guard.step();
    if (node === null) throw errorf(`TALA ${guard.location} contains a nil ${description}`);
    if (seenNodes.has(node)) return;
    seenNodes.add(node);
    if (node.topLeft === null) throw errorf(`TALA ${guard.location} ${description} has no position`);
  };
  for (let index = 0; index < g.nodes.length; index++) {
    const node = g.nodes[index];
    validateNode(node, `graph node at index ${index}`);
    graphNodes.add(node);
  }

  const seen = new Set();
  let routePointCapacity = 0;
  const validateEdge = (edge, requireGraphEndpoints) => {
    guard.step();
    if (edge === null) throw errorf(`TALA ${guard.location} contains a nil edge`);
    if (seen.has(edge)) return;
    seen.add(edge);
    if (requireGraphEndpoints) {
      if (!graphNodes.has(edge.from)) throw errorf(`graph edge ${edge.idValue()} source node does not belong to the graph`);
      if (!graphNodes.has(edge.to)) throw errorf(`graph edge ${edge.idValue()} target node does not belong to the graph`);
    }
    const capacity = edge.points.length;
    if (routePointCapacity > lg.MaxRoutePoints || capacity > lg.MaxRoutePoints - routePointCapacity) {
      throw errorf(`TALA ${guard.location} route point capacity exceeds limit ${lg.MaxRoutePoints}`);
    }
    routePointCapacity += capacity;
    if (edge.points.length === 1) {
      throw invariant.errorf(`edge ${edge.idValue()} has an incomplete route: expected at least two points, got 1`);
    }
    for (const item of [
      { name: 'label', label: edge.label },
      { name: 'source arrowhead label', label: edge.sourceArrowheadLabel },
      { name: 'target arrowhead label', label: edge.targetArrowheadLabel },
    ]) {
      if (item.label !== null && item.label.position !== label.Unset && !label.isEdgePosition(item.label.position)) {
        throw invariant.errorf(`edge ${edge.idValue()} ${item.name} has an invalid edge position`);
      }
    }
    validateNode(edge.from, `edge ${edge.idValue()} source`);
    validateNode(edge.to, `edge ${edge.idValue()} target`);
    for (const point of edge.points) {
      guard.step();
      if (point === null) throw errorf(`TALA ${guard.location} edge ${edge.idValue()} contains a nil route point`);
      if (!finite(point.x) || !finite(point.y)) {
        throw errorf(`TALA ${guard.location} edge ${edge.idValue()} has a non-finite route point`);
      }
    }
  };
  for (const edge of g.edges) validateEdge(edge, true);
  for (const node of g.nodes) {
    for (const edge of node.edges) validateEdge(edge, false);
  }
  for (const edge of extraEdges) validateEdge(edge, false);
  guard.finish();
}

/**
 * routeStageGraphBoundingBox preserves Graph.BoundingBox geometry while charging the stage aggregate for the existing outside-label
 * extremity scans and every edge-route scan. Returns [topLeft, bottomRight].
 */
export function routeStageGraphBoundingBox(g, guard) {
  if (g === null || guard === null) throw errorf('TALA EdgeRouting bounding box requires a graph and work guard');
  const [topLeft, bottomRight] = fixedBoundingBox(g.nodes, guard);
  if (topLeft === null || bottomRight === null) throw invariant.newError('EdgeRouting bounding box contains an unplaced node');
  let minX = topLeft.x, minY = topLeft.y;
  let maxX = bottomRight.x, maxY = bottomRight.y;
  for (const edge of g.edges) {
    guard.step();
    // Edge bounding-box calculation scans the route once for geometry. D2's positioned edge-label helper scans it twice, and each
    // arrowhead-label helper scans it three times. Charge those exact/conservative kernels before calling the legacy geometry
    // implementation.
    guard.add(edge.points.length);
    const chargeRouteScans = (scans) => {
      for (let i = 0; i < scans; i++) guard.add(edge.points.length);
    };
    if (edge.points.length !== 0 && edge.label !== null && edge.label.position !== label.Unset) chargeRouteScans(2);
    if (edge.points.length !== 0 && edge.sourceArrowheadLabel !== null) chargeRouteScans(3);
    if (edge.points.length !== 0 && edge.targetArrowheadLabel !== null) chargeRouteScans(3);
    const [edgeTopLeft, edgeBottomRight] = edge.boundingBoxValues();
    if (!(edgeTopLeft.x === Infinity || edgeTopLeft.x === -Infinity)) {
      minX = Math.min(minX, edgeTopLeft.x);
      minY = Math.min(minY, edgeTopLeft.y);
      maxX = Math.max(maxX, edgeBottomRight.x);
      maxY = Math.max(maxY, edgeBottomRight.y);
    }
  }
  guard.finish();
  return [geo.newPoint(goRound(minX), goRound(minY)), geo.newPoint(goRound(maxX), goRound(maxY))];
}

/**
 * runAtomicRouteStage provides one error boundary for each whole stage. A panic is deliberately rethrown after restoration so existing
 * invariant failure semantics remain unchanged. `fn(guard)` throws where Go's returns an error.
 */
export function runAtomicRouteStage(ctx, location, g, extraEdges, workLimit, fn) {
  lg.validate(ctx, location, g);
  runAtomicRouteStageAfterPreflight(ctx, location, g, extraEdges, workLimit, fn);
}

export function runAtomicRouteStageAfterPreflight(ctx, location, g, extraEdges, workLimit, fn) {
  const guard = newRouteWorkGuard(ctx, location, workLimit);
  runAtomicRouteStageWithGuard(g, extraEdges, guard, fn);
}

/**
 * runAtomicRouteStageWithGuard lets a whole pipeline stage use the same work budget for its own discovery kernels and the exact mutation
 * boundary. The caller is responsible for the graph topology preflight.
 */
export function runAtomicRouteStageWithGuard(g, extraEdges, guard, fn) {
  validateRouteStageGeometry(g, extraEdges, guard);
  runAtomicRouteStageWithValidatedGeometry(g, extraEdges, guard, fn);
}

/**
 * runAtomicRouteStageWithValidatedGeometry avoids charging the same geometry inventory twice when a caller must validate it before
 * choosing an early success path. The topology preflight remains the caller's responsibility.
 */
export function runAtomicRouteStageWithValidatedGeometry(g, extraEdges, guard, fn) {
  const snapshot = captureRouteMutations(g, extraEdges, guard);
  try {
    fn(guard);
    guard.finish();
  } catch (e) {
    // Go restores on a returned error and on a panic alike, then rethrows the panic.
    snapshot.restore();
    throw e;
  }
}
