// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of the Go package d2layouts/d2talalayout/internal/routing (D2 v0.9.0), file(s): coordinator.go, the part that
// route_line.js (the core) does not hold: the flavor workers and their selection, finalizeSelectedRoutes, reorderSelectedRoutes,
// routeEdgesWithResourceGuards, routeAdditionalEdges*, routeSentinelEdge, routeInSShape, StraightEdgesFallback, ReorderDuplicates and
// Crosshatch.
//
// The flavor workers run in parallel in Go and their responses are sorted back to the declared router order before anything looks at
// them (see "Determinism" in docs/d2-tala-port.md): here they run one after another in that order. A Go panic of a worker (a JS
// non-GoError exception) is recorded for the coordinator like `runRouteFlavorWorker` does; every worker still runs and only the
// lowest-indexed panic is reported.

import * as geo from '../../geo.js';
import { sortSlice } from '../../gosort.js';
import { GoError, errorf, errorsIs } from '../goerrors.js';
import { withCancel } from '../context.js';
import * as invariant from '../invariant.js';
import { PointMap, isCandidateRejection, sortNodesByID } from '../layoutgraph.js';
import * as loops from '../loops.js';
import { OVGNode } from './ovg_node.js';
import { Route } from './route.js';
import { nonNilEquals } from './ovg_edge.js';
import { newOVGEdgeRouterWithWorkLimit } from './ovg_edge_router.js';
import { buildOVGFromGraphWithGuard, buildOVGFromGraphWithLimits } from './ovg.js';
import { treeEdgePath } from './tree_routes.js';
import { makeLoopRoute } from './loop_router.js';
import { GenerateRouteResponse, ShortestToLongest, LongestToShortest, Default, TopDownLeftRight, routeLine } from './route_line.js';
import { errRouteSearchWorkLimit, maxRouteSearchFlavors, maxRouteSearchWorkUnits } from './route_search_guard.js';
import { errRouteStageWorkLimit, maxRouteStageWorkUnits } from './route_stage_guard.js';
import { checkEdgeRoutingCanceled } from './work.js';
import { estimateRouteCost } from './cost.js';
import { lowerJitterThreshold, nonOrthogonalFactor } from './tuning.js';
import { runAtomicRouteStage } from './route_stage_atomic.js';
import { isDescendantOfWithRouteGuard } from './tunnel.js';

/**
 * runRouteFlavorWorker(ctx, index, router, straightLineFallback, worker) -> { index, response, workerPanic }. `worker(router, ctx,
 * straightLineFallback)` returns a GenerateRouteResponse.
 */
function runRouteFlavorWorker(ctx, index, router, straightLineFallback, worker) {
  const flavor = router !== null ? router.flavor : '';
  const result = { index, response: new GenerateRouteResponse(), workerPanic: null };
  result.response.flavor = flavor;
  try {
    result.response = worker(router, ctx, straightLineFallback);
    // The coordinator owns flavor identity and ordering. Do not trust worker output for either, even though the production worker
    // currently sets both.
    result.response.flavor = flavor;
  } catch (recovered) {
    const response = new GenerateRouteResponse();
    response.flavor = flavor;
    return { index, response, workerPanic: { flavor } };
  }
  return result;
}

const workerPanicError = (p) => invariant.errorf(`edge routing flavor ${p.flavor} violated an invariant`);

/** generateRouteFlavorResponses(ctx, routers, straightLineFallback): GenerateRouteResponse[] (throws the Go error) */
export function generateRouteFlavorResponses(ctx, routers, straightLineFallback) {
  return generateRouteFlavorResponsesWith(ctx, routers, straightLineFallback, (router, c, fallback) => router.generateRoutes(c, fallback));
}

export function generateRouteFlavorResponsesWith(ctx, routers, straightLineFallback, worker) {
  if (routers.length > maxRouteSearchFlavors) {
    throw errorf(
      `${errRouteSearchWorkLimit.message}: edge routing declared ${routers.length} flavors; limit ${maxRouteSearchFlavors}`,
      errRouteSearchWorkLimit,
    );
  }
  const [workerCtx, cancelWorkers] = withCancel(ctx);
  try {
    const results = [];
    for (let i = 0; i < routers.length; i++) {
      const result = runRouteFlavorWorker(workerCtx, i, routers[i], straightLineFallback, worker);
      results.push(result);
      // A panic invalidates the whole routing attempt (the coordinator reports the first panic in router order), but every worker is
      // still drained: Go cancels its siblings, which only matters to workers that look at their context.
    }
    return collectRouteFlavorResponses(ctx, results);
  } finally {
    cancelWorkers();
  }
}

/** collectRouteFlavorResponses: the tail of Go's collector once every worker has joined (results are in declared order already). */
function collectRouteFlavorResponses(ctx, results) {
  for (const result of results) {
    if (result.workerPanic !== null) throw workerPanicError(result.workerPanic);
  }
  const ctxErr = ctx.err();
  if (ctxErr !== null && ctxErr !== undefined) throw errorf(`EdgeRouting: ${ctxErr.message}`, ctxErr);
  return results.map((result) => result.response);
}

/** successfulRouteFlavorResponses(responses): Map<flavor, GenerateRouteResponse> (throws the first error when none succeeded) */
export function successfulRouteFlavorResponses(responses) {
  const successful = new Map();
  let firstError = null;
  for (const response of responses) {
    if (response.err !== null) {
      // An ordinary flavor can fail while another valid flavor succeeds. The whole-stage aggregate is different: once exhausted,
      // accepting a flavor that happened to finish first would make the resource bound depend on goroutine scheduling and let total
      // routing work exceed its contract.
      if (errorsIs(response.err, errRouteStageWorkLimit)) throw response.err;
      if (firstError === null) firstError = response.err;
      continue;
    }
    successful.set(response.flavor, response);
  }

  if (successful.size > 0) return successful;
  if (firstError !== null) throw firstError;
  throw invariant.newError('edge routing produced no flavor responses');
}

/**
 * finalizeSelectedRoutes accounts route grouping, sorting, reversal, and point materialization against the winning flavor's remaining
 * budget. All fallible work completes before graph edges are changed, preserving route atomicity. `selectedEdges` is a Set or null.
 */
export function finalizeSelectedRoutes(ctx, g, routes, selectedEdges, work, reorderParallelEdges) {
  if (work === null) throw invariant.newError('selected edge-routing flavor has no work guard');
  if (g === null) throw invariant.newError('selected edge-routing flavor has no graph');
  work.bind(ctx);
  let finished = false;
  try {
    if (selectedEdges !== null) {
      const selectedRoutes = [];
      const found = new Set();
      for (const route of routes) {
        work.step();
        if (route === null) throw invariant.newError('selected edge-routing flavor produced a nil route');
        if (!selectedEdges.has(route.gEdge)) continue;
        if (found.has(route.gEdge)) throw invariant.newError('selected edge-routing flavor produced duplicate routes for an edge');
        found.add(route.gEdge);
        selectedRoutes.push(route);
      }
      if (found.size !== selectedEdges.size) throw invariant.newError('selected edge-routing flavor omitted a requested edge');
      routes = selectedRoutes;
    }

    for (const route of routes) {
      work.step();
      if (route === null || route.gEdge === null || route.gEdge.from === null || route.gEdge.to === null || route.ovgNodes.length < 2) {
        throw invariant.newError('selected edge-routing flavor produced an invalid route');
      }
      for (const node of route.ovgNodes) {
        work.step();
        if (node === null || node.point === null) throw invariant.newError('selected edge-routing flavor produced an invalid route node');
      }
    }

    if (reorderParallelEdges) reorderSelectedRoutes(g, routes, work);

    work.add(routes.length);
    const updates = [];
    for (const route of routes) {
      work.step();
      work.add(route.ovgNodes.length);
      updates.push({ edge: route.gEdge, points: route.createSegmentEndpoints() });
    }
    work.finish();

    // The commit contains no fallible work. A route-search error or cancellation above therefore leaves every graph edge
    // byte-for-byte unchanged.
    for (const update of updates) update.edge.points = update.points;
    finished = true;
  } finally {
    if (!finished) {
      try { work.finish(); } catch (ignored) { /* _ = work.finish() */ }
    }
  }
}

export function reorderSelectedRoutes(g, routes, work) {
  work.add(routes.length);
  const buckets = [];
  const grouped = new Set();
  for (let index = 0; index < routes.length; index++) {
    const route = routes[index];
    work.step();
    if (grouped.has(route)) continue;
    const bucket = [route];
    grouped.add(route);
    for (const other of routes.slice(index + 1)) {
      work.step();
      if (grouped.has(other)) continue;
      const canSwap = route.canSwapEdgesGuarded(other, routes, work);
      if (canSwap) {
        bucket.push(other);
        grouped.add(other);
      }
    }
    if (bucket.length > 1) buckets.push(bucket);
  }

  work.add(g.edges.length);
  const edgeIndices = new Map();
  for (let index = 0; index < g.edges.length; index++) {
    work.step();
    edgeIndices.set(g.edges[index], index);
  }

  for (const bucket of buckets) {
    work.step();
    work.reserveSort(bucket.length);
    // Sort bucket from left-right or top-bottom.
    sortSlice(bucket, (i, j) => {
      const e1 = bucket[i];
      const e2 = bucket[j];
      const n1 = e1.gEdge.from;
      const n2 = e1.gEdge.to;
      if (geo.isVertical(n1.orientation(n2))) {
        if (e1.gEdge.from === e2.gEdge.from) return e1.fromPort.x < e2.fromPort.x;
        return e1.fromPort.x < e2.toPort.x;
      }
      if (e1.gEdge.from === e2.gEdge.from) return e1.fromPort.y < e2.fromPort.y;
      return e1.fromPort.y < e2.toPort.y;
    });

    work.add(bucket.length);
    const edges = new Array(bucket.length);
    for (let index = 0; index < bucket.length; index++) {
      work.step();
      edges[index] = bucket[index].gEdge;
    }
    work.reserveSort(edges.length);
    sortSlice(edges, (i, j) => {
      let left = edgeIndices.get(edges[i]);
      if (left === undefined) left = -1;
      let right = edgeIndices.get(edges[j]);
      if (right === undefined) right = -1;
      return left < right;
    });

    for (let index = 0; index < bucket.length; index++) {
      const route = bucket[index];
      work.step();
      if (route.gEdge.from !== edges[index].from) {
        work.add(route.ovgNodes.length);
        const t = route.fromPort;
        route.fromPort = route.toPort;
        route.toPort = t;
        route.ovgNodes.reverse();
      }
      route.gEdge = edges[index];
    }
  }
  work.check();
}

/** pickBestFlavor: the fixed order comparison of both route functions; returns [bestRoutes, bestWork] */
function pickBestResponse(flavors, flavorToResponse) {
  let bestRoutes = null;
  let bestWork = null;
  let leastDistance = Infinity;
  // compare responses in fixed order
  for (const flavor of flavors) {
    const response = flavorToResponse.get(flavor);
    if (response !== undefined) {
      if (geo.precisionCompare(response.distance, leastDistance, geo.PRECISION) < 0) {
        leastDistance = response.distance;
        bestRoutes = response.routes;
        bestWork = response.work;
      }
    }
  }
  return [bestRoutes ?? [], bestWork];
}

/** routeEdgesWithResourceGuards(ctx, g, nearbyNodes, ovgGuard, searchWorkLimit): OVG */
export function routeEdgesWithResourceGuards(ctx, g, nearbyNodes, ovgGuard, searchWorkLimit) {
  const ovg = buildOVGFromGraphWithGuard(g, nearbyNodes, ovgGuard);

  // Route all tree edges first, then route the remaining edges
  const existingRoutes = [];
  const isTreeEdge = g.treeEdgeMap();
  g.addIsolatedTreeEdges(isTreeEdge);

  const existingPortArrowheads = new Map(); // Map<OVGNode, Set<Arrowhead>>
  const isRouted = new Set();
  for (const node of g.nodes) {
    // we route each tree edge by iterating over the tree nodes, and routing with its sentinel edge
    // this way we know the edge parent/child relation (tree.Node is the child), and that the node is in nodeToTree (not a rootSentinel)
    const tree = g.nodeToTree === null ? undefined : g.nodeToTree.get(node);
    if (tree !== undefined) {
      // we don't route the edge from tree root to rootSentinel here since the root may move relative to the rootSentinel
      if (!isTreeEdge.has(tree.sentinelEdge)) continue;

      let route;
      try {
        route = routeSentinelEdge(tree, ovg.ports, ovg.centers, existingPortArrowheads);
      } catch (err) {
        if (err instanceof GoError) continue;
        throw err;
      }

      existingRoutes.push(route);
      const fromPort = route.ovgNodes[1];
      const toPort = route.ovgNodes[route.ovgNodes.length - 2];
      if (!existingPortArrowheads.has(fromPort)) existingPortArrowheads.set(fromPort, new Set());
      if (!existingPortArrowheads.has(toPort)) existingPortArrowheads.set(toPort, new Set());
      existingPortArrowheads.get(fromPort).add(tree.sentinelEdge.sourceArrowhead);
      existingPortArrowheads.get(toPort).add(tree.sentinelEdge.targetArrowhead);
      isRouted.add(tree.sentinelEdge);
    } else {
      for (const routedEdge of loops.route(node)) {
        existingRoutes.push(makeLoopRoute(routedEdge, ovg));
        isRouted.add(routedEdge);
      }
    }
  }
  const unroutedEdges = [];
  for (const e of g.edges) {
    if (!isRouted.has(e)) unroutedEdges.push(e);
  }

  // cache these ahead of time
  g.crossingCost();
  g.turnCost();
  g.nonCenterPortCost();

  let flavors = [ShortestToLongest, LongestToShortest, Default];
  if (g.nodes[0].hierarchy !== null) flavors = [TopDownLeftRight];
  const routers = [];
  for (const flavor of flavors) {
    const router = newOVGEdgeRouterWithWorkLimit(ctx, flavor, ovg, g, existingRoutes, unroutedEdges, searchWorkLimit);
    routers.push(router);
  }
  const responses = generateRouteFlavorResponses(ctx, routers, true);

  const flavorToResponse = successfulRouteFlavorResponses(responses);
  const [bestRoutes, bestWork] = pickBestResponse(flavors, flavorToResponse);

  finalizeSelectedRoutes(ctx, g, bestRoutes, null, bestWork, true);

  return ovg;
}

export function routeAdditionalEdgesWithLimits(ctx, g, edges, limits) {
  return routeAdditionalEdgesWithResourceLimits(ctx, g, edges, limits, maxRouteSearchWorkUnits);
}

export function routeAdditionalEdgesWithResourceLimits(ctx, g, edges, limits, searchWorkLimit) {
  const newEdges = new Set();
  for (const e of edges) newEdges.add(e);

  const ovg = buildOVGFromGraphWithLimits(ctx, g, null, limits);
  const guard = ovg.buildGuard;

  const existingRoutes = [];
  for (const e of g.edges) {
    guard.step();
    if (newEdges.has(e)) continue;

    const ovgNodes = [];
    let lastPoint = null;

    const addPoint = (p) => {
      guard.step();
      // Skip if this point is the same as the last one
      if (lastPoint !== null && lastPoint.x === p.x && lastPoint.y === p.y) return;
      lastPoint = p;

      let ovgNode = ovg.occupiedPoints.get(p);
      if (ovgNode !== undefined) {
        ovgNodes.push(ovgNode);
      } else {
        ovgNode = new OVGNode(p);
        // The base OVG was indexed before authoritative routes were added.
        ovgNode.index = ovg.nodes.length;
        ovgNodes.push(ovgNode);
        guard.addNodeUnchecked(ovg, ovgNode);
      }

      // Only connect if we have at least 2 different points
      if (ovgNodes.length > 1) guard.connect(ovg, ovgNodes[ovgNodes.length - 2], ovgNodes[ovgNodes.length - 1]);
    };

    addPoint(e.from.center());
    for (const p of e.points) addPoint(p);
    addPoint(e.to.center());

    // Only create route if we have at least 2 different points
    if (ovgNodes.length > 1) {
      existingRoutes.push(new Route({
        gEdge: e,
        ovgNodes,
        fromPort: e.points[0].copy(),
        toPort: e.points[e.points.length - 1].copy(),
      }));
    }
  }

  // cache these ahead of time
  g.crossingCost();
  g.turnCost();
  g.nonCenterPortCost();

  let flavors = [ShortestToLongest, LongestToShortest, Default];
  if (g.nodes[0].hierarchy !== null) flavors = [TopDownLeftRight];
  const routers = [];
  for (const flavor of flavors) {
    const router = newOVGEdgeRouterWithWorkLimit(ctx, flavor, ovg, g, existingRoutes, edges, searchWorkLimit);
    router.considerNodeLabels = true;
    routers.push(router);
  }
  const responses = generateRouteFlavorResponses(ctx, routers, true);

  const flavorToResponse = successfulRouteFlavorResponses(responses);
  const [bestRoutes, bestWork] = pickBestResponse(flavors, flavorToResponse);

  finalizeSelectedRoutes(ctx, g, bestRoutes, newEdges, bestWork, false);

  return ovg;
}

/**
 * For Trees, ideal route between parent & child is S shaped bend or straight line. Returns a Route; throws a GoError when no S shaped
 * route exists. `portNodes` is Map<Node, OVGNode[]>, `centers` Map<Node, OVGNode>, `portArrowheads` Map<OVGNode, Set<Arrowhead>>.
 */
export function routeSentinelEdge(tree, portNodes, centers, portArrowheads) {
  // Note: we are the child node since we are considering the sentinel edge
  const edge = tree.sentinelEdge;
  const treePath = treeEdgePath(tree, portNodes, portArrowheads);

  const nodesFromSourcePortToTargetPort = routeInSShape(treePath);

  // validate route
  for (const n of nodesFromSourcePortToTargetPort) {
    if (n.isPort()) {
      let validOwner = false;
      for (const owner of n.portOwners()) {
        if (edge.from.isDescendantOf(owner) || edge.to.isDescendantOf(owner)) {
          validOwner = true;
          break;
        }
      }
      if (!validOwner) throw errorf('routing through other node\'s port');
    }
  }

  const ovgNodes = [];
  ovgNodes.push(centers.get(edge.from));
  for (const n of nodesFromSourcePortToTargetPort) ovgNodes.push(n);
  ovgNodes.push(centers.get(edge.to));

  return new Route({
    gEdge: edge,
    ovgNodes,
    fromPort: treePath.sourcePortNode.point.copy(),
    toPort: treePath.targetPortNode.point.copy(),
  });
}

/**
 * create the straight line or S shaped route between source and target ports; returns the ovg nodes along the way (including source and
 * target port)
 */
export function routeInSShape(treePath) {
  const sourceOrientationToTarget = treePath.sourceOrientationToTarget;
  // Create the route in 3 steps
  // 1. Route from source port to source midpoint
  // 2. Route from source midpoint to target midpoint
  // 3. Route from target midpoint to target port
  let current = treePath.sourcePortNode;
  const getAdjInDirection = (currentOrientationToAdjacent) => {
    let closestAdjNodeInDirection = null;
    for (const e of current.edges) {
      const adjNode = current.adjacent(e);
      switch (currentOrientationToAdjacent) {
        case geo.Orientation.Left:
          // if current is Left of adjacent, we want the closest y-aligned adjacent node to the Right of current
          if (current.point.y === adjNode.point.y && adjNode.point.x > current.point.x) {
            if (closestAdjNodeInDirection === null || adjNode.point.x < closestAdjNodeInDirection.point.x) closestAdjNodeInDirection = adjNode;
          }
          break;
        case geo.Orientation.Right:
          if (current.point.y === adjNode.point.y && adjNode.point.x < current.point.x) {
            if (closestAdjNodeInDirection === null || adjNode.point.x > closestAdjNodeInDirection.point.x) closestAdjNodeInDirection = adjNode;
          }
          break;
        case geo.Orientation.Top:
          if (current.point.x === adjNode.point.x && adjNode.point.y > current.point.y) {
            if (closestAdjNodeInDirection === null || adjNode.point.y < closestAdjNodeInDirection.point.y) closestAdjNodeInDirection = adjNode;
          }
          break;
        default:
          if (current.point.x === adjNode.point.x && adjNode.point.y < current.point.y) {
            if (closestAdjNodeInDirection === null || adjNode.point.y > closestAdjNodeInDirection.point.y) closestAdjNodeInDirection = adjNode;
          }
      }
    }
    return closestAdjNodeInDirection;
  };

  const nodes = [];
  nodes.push(treePath.sourcePortNode);

  // Step 1. source port to source midpoint
  while (!nonNilEquals(current.point, treePath.sourceMidpoint)) {
    current = getAdjInDirection(sourceOrientationToTarget);
    if (current === null) throw invariant.newError("couldn't find s shaped route (source port to source midpoint)");
    nodes.push(current);
  }

  // Step 2. source midpoint to target midpoint
  let crossDirection;
  if (sourceOrientationToTarget === geo.Orientation.Left || sourceOrientationToTarget === geo.Orientation.Right) {
    if (treePath.sourcePortNode.point.y < treePath.targetPortNode.point.y) crossDirection = geo.Orientation.Top;
    else crossDirection = geo.Orientation.Bottom;
  } else if (treePath.sourcePortNode.point.x < treePath.targetPortNode.point.x) {
    crossDirection = geo.Orientation.Left;
  } else {
    crossDirection = geo.Orientation.Right;
  }

  while (!nonNilEquals(current.point, treePath.targetMidpoint)) {
    current = getAdjInDirection(crossDirection);
    if (current === null) throw invariant.newError("couldn't find s shaped route (source midpoint to target midpoint)");
    nodes.push(current);
  }

  // Step 3. target midpoint to target port
  while (!nonNilEquals(current.point, treePath.targetPortNode.point)) {
    current = getAdjInDirection(sourceOrientationToTarget);
    if (current === null) throw invariant.newError("couldn't find s shaped route (target midpoint to target port)");
    nodes.push(current);
  }

  return nodes;
}

// | Consider straight edge alternatives for each edge.
// | For each edge we consider each pair of ports between the source and target nodes.
// | By default we don't consider an alternative if it uses an occupied port, but a port can be shared if:
// |   (1) it is not used by a duplicate edge, and (2) the edge and all edges at the port have matching arrowheads

class StraightEdgeFallbackRollback {
  constructor() {
    this.graph = null;
    this.costs = null;
    this.costsCaptured = false;
    this.firstChange = null;
    this.hasChange = false;
    this.moreChanges = [];
  }

  captureCosts(graph) {
    if (this.costsCaptured) return;
    this.graph = graph;
    this.costs = graph.routingCosts();
    this.costsCaptured = true;
  }

  record(edge, points) {
    const change = { edge, points };
    if (!this.hasChange) {
      this.firstChange = change;
      this.hasChange = true;
      return;
    }
    this.moreChanges.push(change);
  }

  restore() {
    for (let index = this.moreChanges.length - 1; index >= 0; index--) {
      const change = this.moreChanges[index];
      change.edge.points = change.points;
    }
    if (this.hasChange) this.firstChange.edge.points = this.firstChange.points;
    if (this.costsCaptured) this.graph.restoreRoutingCosts(this.costs);
  }
}

function isStraightEdgeFallbackCandidate(edge, clusterNodes, isTreeEdge) {
  if (clusterNodes.has(edge.from)) return false;
  if (clusterNodes.has(edge.to)) return false;
  if (isTreeEdge.has(edge)) return false;
  if (edge.from.hierarchy !== null) return false;
  return !edge.hasTableColumn();
}

export function straightEdgesFallback(ctx, g) {
  checkEdgeRoutingCanceled(ctx);

  const clusterNodes = new Set();
  for (const cluster of g.clusters.values()) {
    checkEdgeRoutingCanceled(ctx);
    for (const cn of cluster.nodes) {
      checkEdgeRoutingCanceled(ctx);
      clusterNodes.add(cn);
    }
  }
  const isTreeEdge = g.treeEdgeMap();
  g.addIsolatedTreeEdges(isTreeEdge);
  checkEdgeRoutingCanceled(ctx);
  for (let index = 0; index < g.edges.length; index++) {
    const edge = g.edges[index];
    checkEdgeRoutingCanceled(ctx);
    if (!isStraightEdgeFallbackCandidate(edge, clusterNodes, isTreeEdge)) continue;
    straightEdgesFallbackFrom(ctx, g, clusterNodes, isTreeEdge, index);
    return;
  }
}

function straightEdgesFallbackFrom(ctx, g, clusterNodes, isTreeEdge, firstIndex) {
  const rollback = new StraightEdgeFallbackRollback();
  rollback.captureCosts(g);
  let complete = false;
  try {
    const edges = g.edges.slice(firstIndex);
    for (let offset = 0; offset < edges.length; offset++) {
      const edge = edges[offset];
      if (offset !== 0) {
        checkEdgeRoutingCanceled(ctx);
        if (!isStraightEdgeFallbackCandidate(edge, clusterNodes, isTreeEdge)) continue;
      }
      const originalPoints = edge.points;
      const changed = tryStraightEdgeFallback(ctx, g, edge);
      if (changed) rollback.record(edge, originalPoints);
    }
    checkEdgeRoutingCanceled(ctx);
    complete = true;
  } finally {
    if (!complete) rollback.restore();
  }
}

/** tryStraightEdgeFallback(ctx, g, edge): bool */
export function tryStraightEdgeFallback(ctx, g, edge) {
  checkEdgeRoutingCanceled(ctx);

  const originalCost = estimateRouteCost(g.edges, edge);
  let fromPort, toPort, lineCost;
  try {
    [fromPort, toPort, lineCost] = routeLine(ctx, g, edge, g.edges, null);
  } catch (err) {
    if (err instanceof GoError && isCandidateRejection(err)) {
      // A straight replacement is optional. Keep the original route when no valid line exists.
      return false;
    }
    throw err;
  }

  // If dejitter fails but the segment is really short, we would prefer a straight line (all else equivalent)
  if (edge.points.length === 4) {
    if (geo.euclideanDistance(edge.points[1].x, edge.points[1].y, edge.points[2].x, edge.points[2].y) <= lowerJitterThreshold) {
      // remove the straight line penalty from this line
      lineCost /= nonOrthogonalFactor;
    }
  }

  checkEdgeRoutingCanceled(ctx);
  if (lineCost < originalCost) {
    edge.points = [fromPort, toPort];
    return true;
  }
  return false;
}

/** ReorderDuplicates: reorderDuplicatesInEdges(ctx, g.Edges) */
export function reorderDuplicates(ctx, g) {
  reorderDuplicatesInEdges(ctx, g.edges);
}

export function reorderDuplicatesInEdges(ctx, edges) {
  const checkCanceled = () => {
    const err = ctx.err();
    if (err) throw errorf(`ReorderDuplicates: ${err.message}`, err);
  };
  checkCanceled();
  const snapshots = [];
  const seen = new Set();
  for (const edge of edges) {
    if (seen.has(edge)) continue;
    seen.add(edge);
    snapshots.push({ edge, points: edge.points, values: edge.points.slice() });
  }
  let complete = false;
  try {
    // look for labeled straight edges that have duplicates
    for (const e of edges) {
      checkCanceled();
      if (e.hasTableColumn()) continue;
      if (e.label === null || !e.isStraight()) continue;

      const hasOverlappingEnd = e.hasOverlappingEnd();

      const duplicates = [];
      for (let i = 0; i < edges.length; i++) {
        const other = edges[i];
        checkCanceled();
        if (other === e) continue;
        if (!other.isDuplicateOf(e) || !other.isStraight()) continue;
        // Note: only need to check for matching arrowheads if one of the edges overlaps another edge
        if (hasOverlappingEnd || other.hasOverlappingEnd()) {
          let sourceArrow = e.sourceArrowhead;
          let targetArrow = e.targetArrowhead;
          if (other.from === e.to) {
            // Note: since other is in opposite direction, we reverse points when swapping below
            [sourceArrow, targetArrow] = [targetArrow, sourceArrow];
          }
          if (other.targetArrowhead === targetArrow && other.sourceArrowhead === sourceArrow) duplicates.push(i);
        } else {
          duplicates.push(i);
        }
      }

      if (duplicates.length > 1) {
        const start = e.points[0];
        const end = e.points[e.points.length - 1];

        const dx = end.x - start.x;
        const dy = end.y - start.y;

        const sourceOrder = [];
        const targetOrder = [];

        sourceOrder.push(e);
        targetOrder.push(e);

        for (const i of duplicates) {
          const dup = edges[i];
          sourceOrder.push(dup);
          targetOrder.push(dup);
        }

        if (dy > dx) {
          sortSlice(sourceOrder, (i, j) => sourceOrder[i].points[0].x < sourceOrder[j].points[0].x);
          sortSlice(targetOrder, (i, j) => {
            const ei = targetOrder[i], ej = targetOrder[j];
            return ei.points[ei.points.length - 1].x < ej.points[ej.points.length - 1].x;
          });
        } else {
          sortSlice(sourceOrder, (i, j) => sourceOrder[i].points[0].y < sourceOrder[j].points[0].y);
          sortSlice(targetOrder, (i, j) => {
            const ei = targetOrder[i], ej = targetOrder[j];
            return ei.points[ei.points.length - 1].y < ej.points[ej.points.length - 1].y;
          });
        }
        checkCanceled();

        let consistentOrder = true;
        for (let i = 0; i < sourceOrder.length; i++) {
          if (sourceOrder[i] !== targetOrder[i]) {
            consistentOrder = false;
            break;
          }
        }
        if (!consistentOrder) continue;
        let currentIndex = -1;
        for (let i = 0; i < sourceOrder.length; i++) {
          if (sourceOrder[i] === e) {
            currentIndex = i;
            break;
          }
        }
        if (currentIndex === 0 || currentIndex === sourceOrder.length - 1) continue;
        const first = sourceOrder[0];
        const last = sourceOrder[sourceOrder.length - 1];
        if (first.label !== null && last.label !== null) continue;
        checkCanceled();

        if (last.label === null) {
          [e.points, last.points] = [last.points, e.points];
          if (last.from === e.to) {
            // need to reverse order of points
            e.points.reverse();
            last.points.reverse();
          }
        } else if (first.label === null) {
          [e.points, first.points] = [first.points, e.points];
          if (first.from === e.to) {
            e.points.reverse();
            first.points.reverse();
          }
        }
      }
    }
    checkCanceled();
    complete = true;
  } finally {
    if (!complete) {
      for (const snapshot of snapshots) {
        // copy(snapshot.points, snapshot.values): the old backing array gets its old contents back
        for (let i = 0; i < snapshot.values.length && i < snapshot.points.length; i++) snapshot.points[i] = snapshot.values[i];
        snapshot.edge.points = snapshot.points;
      }
    }
  }
}

export function crosshatch(ctx, g) {
  crosshatchWithWorkLimit(ctx, g, maxRouteStageWorkUnits);
}

export function crosshatchWithWorkLimit(ctx, g, workLimit) {
  runAtomicRouteStage(ctx, 'Crosshatch', g, null, workLimit, (guard) => {
    const vessels = [];
    for (const vessel of g.clusters.keys()) {
      guard.step();
      vessels.push(vessel);
    }
    sortNodesByID(vessels);
    for (const vessel of vessels) {
      guard.step();
      const cluster = g.clusters.get(vessel);
      if (cluster === undefined || cluster === null) throw invariant.newError('nil cluster while crosshatching routes');
      const externalEdges = externalEdgesForClusterGuarded(cluster, guard);
      if (externalEdges.length < 2) continue;

      const portToEdges = groupEdgesByClusterPortGuarded(cluster, externalEdges, guard);
      const ports = [];
      for (const [port] of portToEdges.entries()) {
        guard.step();
        ports.push(port);
      }
      sortSlice(ports, (i, j) => {
        if (ports[i].x !== ports[j].x) return ports[i].x < ports[j].x;
        return ports[i].y < ports[j].y;
      });
      for (const port of ports) {
        const edges = portToEdges.get(port);
        if (edges.length < 2) continue;
        for (const edge of edges) convertToStraightLineGuarded(g, edge, guard);
      }
    }
  });
}

function externalEdgesForClusterGuarded(cluster, guard) {
  const externalEdges = [];
  for (const edgeAbduction of cluster.edgeAbductions) {
    guard.step();
    if (edgeAbduction === null || edgeAbduction.edge === null) throw invariant.newError('nil cluster edge abduction while crosshatching routes');
    externalEdges.push(edgeAbduction.edge);
  }
  return externalEdges;
}

/** Map<geo.Point value, Edge[]> as a PointMap */
function groupEdgesByClusterPortGuarded(cluster, edges, guard) {
  const portToEdges = new PointMap();

  for (const edge of edges) {
    guard.step();
    if (edge === null) throw invariant.newError('nil edge while grouping cluster ports');
    // Find which cluster node this edge connects to and get the port
    let clusterPort = null;
    for (const clusterNode of cluster.nodes) {
      guard.step();
      if (edge.from === clusterNode) {
        clusterPort = edge.sourcePort();
        break;
      } else if (edge.to === clusterNode) {
        clusterPort = edge.targetPort();
        break;
      }
    }

    if (clusterPort !== null) {
      const list = portToEdges.get(clusterPort);
      if (list === undefined) portToEdges.set(clusterPort, [edge]);
      else list.push(edge);
    }
  }

  return portToEdges;
}

function convertToStraightLineGuarded(g, edge, guard) {
  guard.step();
  if (edge === null || edge.from === null || edge.to === null || edge.from.topLeft === null || edge.to.topLeft === null) {
    throw invariant.newError('invalid edge while crosshatching routes');
  }
  const fromCenter = geo.newPoint(edge.from.topLeft.x + edge.from.width / 2, edge.from.topLeft.y + edge.from.height / 2);
  const toCenter = geo.newPoint(edge.to.topLeft.x + edge.to.width / 2, edge.to.topLeft.y + edge.to.height / 2);

  const fromBorder = findLineBorderIntersection(fromCenter, toCenter, edge.from);
  const toBorder = findLineBorderIntersection(toCenter, fromCenter, edge.to);

  if (fromBorder !== null && toBorder !== null) {
    const intersects = straightLineIntersectsNonAncestorNodesGuarded(g, edge, fromBorder, toBorder, guard);
    if (intersects) return;
    guard.finish();
    edge.points = [fromBorder, toBorder];
    guard.finish();
  }
}

/** findLineBorderIntersection finds where a line from nodeCenter towards targetPoint intersects the node's border */
export function findLineBorderIntersection(nodeCenter, targetPoint, node) {
  // Calculate direction vector
  const dx = targetPoint.x - nodeCenter.x;
  const dy = targetPoint.y - nodeCenter.y;

  if (dx === 0 && dy === 0) return nodeCenter;

  // Node boundaries
  const left = node.topLeft.x;
  const right = node.topLeft.x + node.width;
  const top = node.topLeft.y;
  const bottom = node.topLeft.y + node.height;

  let t = Infinity;

  // Check intersection with each edge of the rectangle
  if (dx > 0) {
    // Right edge intersection
    t = Math.min(t, (right - nodeCenter.x) / dx);
  } else if (dx < 0) {
    // Left edge intersection
    t = Math.min(t, (left - nodeCenter.x) / dx);
  }

  if (dy > 0) {
    // Bottom edge intersection
    t = Math.min(t, (bottom - nodeCenter.y) / dy);
  } else if (dy < 0) {
    // Top edge intersection
    t = Math.min(t, (top - nodeCenter.y) / dy);
  }

  if (t === Infinity || t <= 0) return nodeCenter;

  return geo.newPoint(nodeCenter.x + t * dx, nodeCenter.y + t * dy);
}

/**
 * straightLineIntersectsNonAncestorNodes checks if a straight line between two points intersects any nodes that are not ancestors of the
 * edge's endpoints
 */
function straightLineIntersectsNonAncestorNodesGuarded(g, edge, p1, p2, guard) {
  // Check intersection with all nodes in the graph
  for (const node of g.nodes) {
    guard.step();
    // Skip if this node is an ancestor of either endpoint
    const fromDescendant = isDescendantOfWithRouteGuard(edge.from, node, guard);
    const toDescendant = isDescendantOfWithRouteGuard(edge.to, node, guard);
    if (fromDescendant || toDescendant) continue;

    // Skip if this node is one of the endpoints
    if (node === edge.from || node === edge.to) continue;

    // Check if the straight line passes through this node
    if (node.passesThrough(p1, p2)) return true;
  }

  return false;
}
