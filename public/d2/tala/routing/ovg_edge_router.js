// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of the Go package d2layouts/d2talalayout/internal/routing (D2 v0.9.0), file(s): ovg_edge_router.go.
//
// ovgEdgeRouter keeps the state for the OVG edge search with data structures to quickly check if a given edge is already in some
// route or if it intersects with other routes. Go's (T, error) results are returned as T and thrown as GoError. The methods defined
// in slingshot.go are installed from slingshot.js (they take the router as `this`). `generateRoutes` returns a GenerateRouteResponse
// (errors in `err`) like Go's; the other methods throw.

import * as geo from '../../geo.js';
import * as shape from '../../shape.js';
import { goV } from '../../gomath.js';
import { sortStableFunc } from '../goslices.js';
import { GoError, errorf, errorsIs } from '../goerrors.js';
import * as invariant from '../invariant.js';
import { Node, ErrInvalidCandidate, PointMap, MinRouteNodeClearance, MinArrowheadClearance, newEdge } from '../layoutgraph.js';
import { tablePortIndex } from '../nodeshape.js';
import { OVGNode, directionsAny } from './ovg_node.js';
import { newOVGEdge } from './ovg_edge.js';
import { newOvgEdgeSet } from './ovg_edge_set.js';
import { PriorityQueue } from './priority_queue.js';
import { Route } from './route.js';
import { segmentIntersectsBox } from './geometry.js';
import { idealTurnAxes } from './turns.js';
import { labeling } from './deps.js';
import {
  basicallyInfinity, idealTurnAxisTolerance, idealTurnMultiplier, idealTurnEvenClusterMultiplier, nodeProximityPenalty,
  pathNodeProximityFloor, turnEndpointClearance,
} from './tuning.js';
import { newRouteSearchWorkGuard, maxRouteSearchWorkUnits, errRouteSearchWorkLimit, routeSearchIsDescendantOf, fixedOverlapsForRoute } from './route_search_guard.js';
import {
  ShortestToLongest, LongestToShortest, TopDownLeftRight, GenerateRouteResponse, routeLineChecked,
} from './route_line.js';
import {
  filterEdgeAncestorsGuarded, sourceAndTargetClusterNodesGuarded, edgeCanOverlapEdgesGuarded, positionedArrowheadLabelCostGuarded,
} from './standalone_route_guard.js';
import { checkEdgeRoutingCanceled, isContextTermination } from './work.js';
import * as sling from './slingshot.js';

const { Orientation } = geo;

/** maps from the pool: a fresh map (the pool only reuses allocations). */
export function borrowPortMap() {
  return new PointMap();
}

export function returnPortMap(/* m */) {}

class SearchNodeContext {
  constructor() {
    this.verticalDistance = Infinity;
    this.horizontalDistance = Infinity;
    this.verticalEntry = null;
    this.horizontalEntry = null;
  }
}

/** Runs fn and returns [value, null] or [undefined, err] for a GoError (a returned error); anything else (a panic) propagates. */
function attempt(fn) {
  try {
    return [fn(), null];
  } catch (err) {
    if (err instanceof GoError) return [undefined, err];
    throw err;
  }
}

export class OvgEdgeRouter {
  constructor() {
    this.flavor = '';
    this.graph = null;
    this.ovg = null;
    this.edges = [];
    this.routes = [];
    this.routedEdges = [];
    this.positionedLabels = []; // PositionedArrowheadLabel[]
    this.pointToRoute = new PointMap(); // PointMap<Route[]>
    this.turnCost = 0;
    this.crossingCost = 0;
    this.nonCenterPortCost = 0;
    this.edgeSet = null;
    this.hasNearbyEdge = new Set(); // Set<OVGEdge>
    this.overlappingRoutes = new Map(); // Map<OVGEdge, Route[]>
    this.fixedOverlaps = null;
    this.fixedOverlapsSet = false;
    this.verticalHops = [];
    this.horizontalHops = [];
    this.nodeContext = [];
    this.searchQueue = new PriorityQueue();
    // Usually, edge routing occurs before label placement. When the router is used independently, labels are already placed and the
    // edges should move out of the way.
    this.considerNodeLabels = false;
    this.work = null;
  }

  bindWork(ctx) {
    if (this.work === null) {
      this.work = newRouteSearchWorkGuard(ctx, this.flavor, maxRouteSearchWorkUnits);
      return;
    }
    this.work.bind(ctx);
  }

  routeLine(ctx, edge) {
    this.bindWork(ctx);
    let fromPort, toPort, cost;
    try {
      [fromPort, toPort, cost] = routeLineChecked(this.graph, edge, this.routedEdges, this.routes, () => this.work.step(), this.work);
    } catch (err) {
      if (err instanceof GoError && errorsIs(err, ErrInvalidCandidate)) {
        const fromCenter = this.ovg.centers.get(edge.from);
        const toCenter = this.ovg.centers.get(edge.to);
        let fromPort2 = null, toPort2 = null;
        const segment = geo.newSegment(fromCenter.point, toCenter.point);
        let intersections = edge.from.box.intersections(segment);
        if (intersections.length > 0) {
          fromPort2 = intersections[0];
          segment.Start = fromPort2;
        }
        intersections = edge.to.box.intersections(segment);
        if (intersections.length > 0) toPort2 = intersections[0];
        // These only happen when there's overlap. It'll look terrible regardless, so just make it work
        if (fromPort2 === null) fromPort2 = fromCenter.point;
        if (toPort2 === null) toPort2 = toCenter.point;
        const ovgNodes = [fromCenter, new OVGNode(fromPort2), new OVGNode(toPort2), toCenter];
        return [ovgNodes, geo.euclideanDistance(fromCenter.x, fromCenter.y, toCenter.x, toCenter.y)];
      }
      throw err;
    }
    const ovgNodes = [
      this.ovg.centers.get(edge.from),
      this.ovg.occupiedPoints.get(fromPort),
      this.ovg.occupiedPoints.get(toPort),
      this.ovg.centers.get(edge.to),
    ];
    return [ovgNodes, cost];
  }

  /** generateRoutes(ctx, straightLineFallback): GenerateRouteResponse */
  generateRoutes(ctx, straightLineFallback) {
    const resp = new GenerateRouteResponse();
    resp.flavor = this.flavor;
    const [, bindErr] = attempt(() => this.bindWork(ctx));
    if (bindErr !== null) {
      resp.err = bindErr;
      if (this.work !== null) attempt(() => this.work.finish());
      return resp;
    }
    resp.work = this.work;
    try {
      this.generateRoutesInto(resp, ctx, straightLineFallback);
    } finally {
      const [, finishErr] = attempt(() => this.work.finish());
      if (resp.err === null && finishErr !== null) {
        resp.err = finishErr;
        resp.routes = null;
      }
    }
    return resp;
  }

  /** the body of generateRoutes: fills `resp` (resp.err on the failures that Go returns early with) */
  generateRoutesInto(resp, ctx, straightLineFallback) {
    let totalDistance = 0.0;
    for (const edge of this.edges) {
      const [, stepErr] = attempt(() => this.work.step());
      if (stepErr !== null) {
        resp.err = stepErr;
        return;
      }
      let distance;
      let ovgNodes;
      let err;

      [ovgNodes, err] = attempt(() => this.slingshot(ctx, edge));
      if (err === null) {
        distance = ovgNodes[1];
        ovgNodes = ovgNodes[0];
      }
      if (err !== null) {
        if (straightLineFallback) {
          [ovgNodes, err] = attempt(() => this.routeLine(ctx, edge));
          if (err === null) {
            distance = ovgNodes[1];
            ovgNodes = ovgNodes[0];
          }
        }
        if (err !== null) {
          resp.err = err;
          return;
        }
      }
      if (ovgNodes === null || ovgNodes.length <= 1) {
        [ovgNodes, err] = attempt(() => this.search(ctx, edge));
        if (err === null) {
          distance = ovgNodes[1];
          ovgNodes = ovgNodes[0];
        }
        if (err !== null && isContextTermination(err)) {
          resp.err = err;
          return;
        }
        if (err !== null) {
          if (straightLineFallback) {
            [ovgNodes, err] = attempt(() => this.routeLine(ctx, edge));
            if (err === null) {
              distance = ovgNodes[1];
              ovgNodes = ovgNodes[0];
            }
          }
          if (err !== null) {
            resp.err = err;
            return;
          }
        }
        if (ovgNodes === null || ovgNodes.length <= 1) {
          const message = `Route '${edge.debugID()}' has size ${ovgNodes === null ? 0 : ovgNodes.length}`;
          resp.err = invariant.newError(message);
          return;
        }
      }

      totalDistance += distance;
      const [, addErr] = attempt(() => this.addRoute(new Route({
        gEdge: edge,
        ovgNodes,
        fromPort: ovgNodes[1].point.copy(),
        toPort: ovgNodes[ovgNodes.length - 2].point.copy(),
      })));
      if (addErr !== null) {
        resp.err = addErr;
        return;
      }
    }

    resp.routes = this.routes;
    resp.distance = totalDistance;
  }

  /**
   * Among center ports, slightly favor going through center ports where the mirrored center port is occupied. So if a node has a
   * route going through its left center port, another route going through the right center port looks nicely symmetrical.
   */
  centerSymmetricalPorts(ctx, gSource, gTarget, sourcePortsUsed, targetPortsUsed) {
    const nodeIsCenterSymmetricalPort = new Set();
    this.work.reserveSum((this.ovg.ports.get(gSource) ?? []).length, (this.ovg.ports.get(gTarget) ?? []).length);
    const sourceMirroredPorts = gSource.mirroredPorts();
    const targetMirroredPorts = gTarget.mirroredPorts();
    for (const port of this.ovg.ports.get(gSource) ?? []) {
      this.work.step();
      // If this is a port number that has a mirror
      const mirroredPort = sourceMirroredPorts.get(port.point);
      if (mirroredPort !== undefined) {
        // If the mirrored port is occupied, making this one desirable
        if (sourcePortsUsed.has(mirroredPort)) nodeIsCenterSymmetricalPort.add(port);
      }
    }
    // Do the same thing for target ports
    for (const port of this.ovg.ports.get(gTarget) ?? []) {
      this.work.step();
      const mirroredPort = targetMirroredPorts.get(port.point);
      if (mirroredPort !== undefined) {
        if (targetPortsUsed.has(mirroredPort)) nodeIsCenterSymmetricalPort.add(port);
      }
    }

    checkEdgeRoutingCanceled(ctx);
    return nodeIsCenterSymmetricalPort;
  }

  /** returns [sourcePortsUsed, targetPortsUsed, duplicateSourcePortsUsed, duplicateTargetPortsUsed, sharedClusterSourcePortsUsed, sharedClusterTargetPortsUsed] */
  usedPorts(ctx, gSource, gTarget, source, target, sourceClusterNodes, targetClusterNodes, undesirableClusterArrangement) {
    const sourcePortsUsed = new PointMap();
    const targetPortsUsed = new PointMap();
    const duplicateSourcePortsUsed = new PointMap();
    const duplicateTargetPortsUsed = new PointMap();
    const sharedClusterSourcePortsUsed = new PointMap();
    const sharedClusterTargetPortsUsed = new PointMap();

    for (const node of [source, target]) {
      this.work.step();
      // we might process the same route, but since it's just assigning to maps, it's fine
      for (const route of this.pointToRoute.get(node.point) ?? []) {
        this.work.step();
        if ((route.gEdge.from !== gSource) && (route.gEdge.to !== gSource) && (route.gEdge.from !== gTarget) && (route.gEdge.to !== gTarget)) continue;

        // note ports of duplicate connections
        if ((route.gEdge.from === gSource) && (route.gEdge.to === gTarget)) {
          duplicateSourcePortsUsed.set(route.fromPort, true);
          duplicateTargetPortsUsed.set(route.toPort, true);
        }

        // If we're going to or coming from a cluster, then we penalize going through port nodes which are not shared by other nodes
        // of the cluster, which has the effect of making cluster nodes share routes
        // ClusterPortSharing Step 1.
        // we want the same port if a cluster route has the same source or target so record it here
        if (!undesirableClusterArrangement) {
          if (route.gEdge.to === gTarget) {
            if (sourceClusterNodes.has(route.gEdge.from)) sharedClusterTargetPortsUsed.set(route.toPort, true);
          }
          if (route.gEdge.from === gSource) {
            if (targetClusterNodes.has(route.gEdge.to)) sharedClusterSourcePortsUsed.set(route.fromPort, true);
          }
        }

        for (const routeNode of route.ovgNodes) {
          this.work.step();
          for (const portNode of this.ovg.ports.get(gSource) ?? []) {
            this.work.step();
            if (routeNode === portNode) {
              sourcePortsUsed.set(portNode.point, true);
              break;
            }
          }
          for (const portNode of this.ovg.ports.get(gTarget) ?? []) {
            this.work.step();
            if (routeNode === portNode) {
              targetPortsUsed.set(portNode.point, true);
              break;
            }
          }
        }
      }
    }
    checkEdgeRoutingCanceled(ctx);
    return [sourcePortsUsed, targetPortsUsed, duplicateSourcePortsUsed, duplicateTargetPortsUsed, sharedClusterSourcePortsUsed, sharedClusterTargetPortsUsed];
  }

  /** Basically Dijkstra's shortest path with some other checks for overlap and alternative routes. Returns [ovgNodes, distance]. */
  search(ctx, gEdge) {
    this.bindWork(ctx);
    const g = this.ovg;
    const originalGraph = this.graph;
    const gSource = gEdge.from;
    const gTarget = gEdge.to;
    const source = g.centers.get(gSource);
    const target = g.centers.get(gTarget);
    const routePoints = [null, null];

    // Preallocate needed data structures with appropriate capacity
    const nodeCount = this.ovg.nodes.length;
    // Account zeroing the three node-indexed arrays before allocating them.
    this.work.reserveProduct(nodeCount, 3);

    // Get maps from pool to reduce allocations
    const fromFacingPorts = borrowPortMap();
    const toFacingPorts = borrowPortMap();

    // Arrays for tracking state during path finding
    this.verticalHops = new Array(nodeCount).fill(null);
    this.horizontalHops = new Array(nodeCount).fill(null);
    this.nodeContext = new Array(nodeCount).fill(null);
    const verticalHops = this.verticalHops;
    const horizontalHops = this.horizontalHops;
    const nodeContext = this.nodeContext;

    // Pre-allocate slices for temp storage with reasonable capacity
    let occupiedEdges = [];
    let overlappingEdges = [];
    const nodeLabelBoxes = [];

    // Fill nodeLabelBoxes if we need to consider node labels
    if (this.considerNodeLabels) {
      for (const n of originalGraph.nodes) {
        this.work.step();
        if (n === gSource || n === gTarget) continue;
        if (n.label !== null && n.label.text !== '') {
          const fakeLabelNode = new Node();
          fakeLabelNode.box = new geo.Box(n.labelTopLeft(n.label.position, n.label.width, n.label.height), n.label.width, n.label.height);
          fakeLabelNode.d2ID = n.label.text;
          fakeLabelNode.graph = originalGraph;
          fakeLabelNode.setShape(shape.SQUARE_TYPE);
          nodeLabelBoxes.push(fakeLabelNode);
        }
      }
    }

    let overlap = false;
    // That's fine, could be overlapped
    const fromOrientation = gSource.orientation(gTarget);
    if (fromOrientation === Orientation.NONE) overlap = true;
    const toOrientation = gTarget.orientation(gSource);
    if (toOrientation === Orientation.NONE) overlap = true;

    const [quickRoute, distance] = this.quickRoute(ctx, gEdge, overlap, fromOrientation);
    if (quickRoute !== null) return [quickRoute, distance];

    let nonAncestors = null;
    if (gEdge.sourceArrowheadLabel !== null || gEdge.targetArrowheadLabel !== null) {
      nonAncestors = filterEdgeAncestorsGuarded(gEdge, this.graph.nodes, this.work);
    }

    const sourceContainer = gSource.container;
    const targetContainer = gTarget.container;
    const isSourceDescendantOfTarget = routeSearchIsDescendantOf(this.work, gSource, gTarget);
    const isTargetDescendantOfSource = routeSearchIsDescendantOf(this.work, gTarget, gSource);

    // Fast access to find if a node is a cluster node (cluster nodes sharing routes is nice)
    const [sourceClusterNodes, targetClusterNodes] = sourceAndTargetClusterNodesGuarded(originalGraph, gSource, gTarget, this.work);
    const isSourceCluster = sourceClusterNodes.size > 0;
    const isTargetCluster = targetClusterNodes.size > 0;

    const undesirableClusterArrangement = this.isUndesirableClusterArrangement(gSource, gTarget);

    // These ports are populated source/target is a cluster, and the orientation is nonambiguous (e.g. not diagonal). When such a
    // case arises, we want to prefer edges that make the connections face-to-face

    let allowSrcPortSharing = false, allowDstPortSharing = false;
    let preferFacingPorts = false;
    let nonFacingPortsCost = 0.0;
    if ((isSourceCluster || isTargetCluster) && !undesirableClusterArrangement) {
      // use facing ports for properly arranged clusters
      preferFacingPorts = true;
      nonFacingPortsCost = this.turnCost * 2;
      allowSrcPortSharing = true;
      allowDstPortSharing = true;
      for (const port of gSource.portsByOrientation(geo.getOpposite(fromOrientation))) {
        this.work.step();
        fromFacingPorts.set(port, true);
      }
      for (const port of gTarget.portsByOrientation(geo.getOpposite(toOrientation))) {
        this.work.step();
        toFacingPorts.set(port, true);
      }
    }

    let sharedRouteCost = basicallyInfinity;
    const blockedSourcePorts = borrowPortMap();
    const blockedTargetPorts = borrowPortMap();

    if (!gEdge.hasTableColumn()) {
      this.work.reserveProduct((this.ovg.ports.get(gSource) ?? []).length, (this.ovg.ports.get(gTarget) ?? []).length);
      // Copy overlapping ports into our pooled maps
      const sourceOverlaps = gSource.overlappingPorts(gTarget);
      for (const [k, v] of sourceOverlaps.entries()) blockedSourcePorts.set(k, v);
      const targetOverlaps = gTarget.overlappingPorts(gSource);
      for (const [k, v] of targetOverlaps.entries()) blockedTargetPorts.set(k, v);
    } else {
      const [sourcePorts, targetPorts] = this.tablePorts(gEdge, gSource, gTarget, false);
      if (gEdge.isBetweenTableColumns()) {
        sharedRouteCost = basicallyInfinity / 10;
        allowSrcPortSharing = true;
        allowDstPortSharing = true;
        for (const port of this.ovg.ports.get(gSource) ?? []) {
          this.work.step();
          if (!sourcePorts.has(port)) blockedSourcePorts.set(port.point, true);
        }
        for (const port of this.ovg.ports.get(gTarget) ?? []) {
          this.work.step();
          if (!targetPorts.has(port)) blockedTargetPorts.set(port.point, true);
        }
        for (const e of gSource.edges) {
          this.work.step();
          targetClusterNodes.set(gSource.adjacent(e), true);
        }
        for (const e of gTarget.edges) {
          this.work.step();
          sourceClusterNodes.set(gTarget.adjacent(e), true);
        }
      } else if (gEdge.fromTableColumnIndex !== null) {
        allowSrcPortSharing = true;
        for (const port of this.ovg.ports.get(gSource) ?? []) {
          this.work.step();
          if (!sourcePorts.has(port)) blockedSourcePorts.set(port.point, true);
        }
        for (const e of gTarget.edges) {
          this.work.step();
          sourceClusterNodes.set(gTarget.adjacent(e), true);
        }
      } else if (gEdge.toTableColumnIndex !== null) {
        allowDstPortSharing = true;
        for (const port of this.ovg.ports.get(gTarget) ?? []) {
          this.work.step();
          if (!targetPorts.has(port)) blockedTargetPorts.set(port.point, true);
        }
        for (const e of gSource.edges) {
          this.work.step();
          targetClusterNodes.set(gSource.adjacent(e), true);
        }
      }
    }

    const axes = idealTurnAxes(gSource, gTarget);

    const [sourcePortsUsed, targetPortsUsed, duplicateSourcePortsUsed, duplicateTargetPortsUsed, sharedClusterSourcePortsUsed, sharedClusterTargetPortsUsed] = this.usedPorts(
      ctx, gSource, gTarget, source, target, sourceClusterNodes, targetClusterNodes, undesirableClusterArrangement,
    );
    const nodeIsCenterSymmetricalPort = this.centerSymmetricalPorts(ctx, gSource, gTarget, sourcePortsUsed, targetPortsUsed);

    if (!this.fixedOverlapsSet) {
      this.fixedOverlaps = fixedOverlapsForRoute(originalGraph.nodes, this.work);
      this.fixedOverlapsSet = true;
    }
    const fixedOverlaps = this.fixedOverlaps;

    // Create the initial source node context
    const sourceContext = new SearchNodeContext();
    nodeContext[source.index] = sourceContext;

    // Priority queue storage is reusable because a flavor routes its edges sequentially.
    this.searchQueue.reset();
    const pq = this.searchQueue;

    // Each node can be visited twice -- once from each direction. Seed the vertical state first to make the equal-cost source
    // preference explicit.
    pq.push(0, source, false, this.work);
    pq.push(0, source, true, this.work);

    while (!pq.empty()) {
      this.work.step();
      // Get the least distance node, regardless of direction
      let leastDistanceEntry;
      try {
        leastDistanceEntry = pq.pop(this.work);
      } catch (err) {
        if (!(err instanceof GoError)) throw err;
        if (errorsIs(err, errRouteSearchWorkLimit) || isContextTermination(err)) throw err;
        throw invariant.newError(`Path not found for '${gEdge.debugID()}'. Error ${err.message}`);
      }
      const isFromHorizontal = leastDistanceEntry.isHorizontal;
      const leastDistanceNode = leastDistanceEntry.node;
      const leastDistance = leastDistanceEntry.priority;

      if (leastDistanceNode === target) {
        const routeNodes = this.bestRoute(ctx, gSource, gTarget, source, target, nodeContext, verticalHops, horizontalHops);
        return [routeNodes, leastDistance];
      }

      let lastNode;
      if (isFromHorizontal) lastNode = horizontalHops[leastDistanceNode.index];
      else lastNode = verticalHops[leastDistanceNode.index];

      // Reset occupiedEdges array for reuse
      occupiedEdges = [];
      if ((leastDistanceNode !== source) && (leastDistanceNode !== target)) {
        const pointRoutes = this.pointToRoute.get(leastDistanceNode.point) ?? [];
        for (const route of pointRoutes) {
          this.work.step();
          occupiedEdges.push(route.gEdge);
        }
      }

      const isOnNodeOfRoute = occupiedEdges.length > 0;
      const areAllOccupiedRoutesShareable = edgeCanOverlapEdgesGuarded(gEdge, occupiedEdges, sourceClusterNodes, targetClusterNodes, this.work);

      for (const e of leastDistanceNode.edges) {
        this.work.step();
        const adjacentNode = leastDistanceNode.adjacent(e);
        if (adjacentNode === lastNode) continue;

        // Prevent exiting source port node at weird angles
        const sourcePort = leastDistanceNode.portMetadataFor(gSource);
        if (sourcePort !== undefined) {
          const validExit = directionsAny(sourcePort.directions, (direction) => {
            // When overlapped, the requirements are relaxed a little.
            if (overlap) {
              switch (direction) {
                case Orientation.Top:
                case Orientation.Bottom:
                  return adjacentNode.point.y !== leastDistanceNode.point.y;
                case Orientation.Right:
                case Orientation.Left:
                  return adjacentNode.point.x !== leastDistanceNode.point.x;
                default:
                  return true;
              }
            }

            switch (direction) {
              case Orientation.Top:
                return adjacentNode.point.y < leastDistanceNode.point.y;
              case Orientation.Bottom:
                return adjacentNode.point.y > leastDistanceNode.point.y;
              case Orientation.Right:
                return adjacentNode.point.x > leastDistanceNode.point.x;
              case Orientation.Left:
                return adjacentNode.point.x < leastDistanceNode.point.x;
              default:
                return true;
            }
          });
          if (!validExit) continue;
        }

        const targetPort = adjacentNode.portMetadataFor(gTarget);
        if (targetPort !== undefined) {
          if (blockedTargetPorts.has(adjacentNode.point)) continue;

          // Prevent approaching target port node from weird angles. Coincident rounded ports can represent several sides of the
          // same node, so one valid approach is enough.
          const validApproach = directionsAny(targetPort.directions, (direction) => {
            if (overlap) {
              switch (direction) {
                case Orientation.Top:
                case Orientation.Bottom:
                  return adjacentNode.point.y !== leastDistanceNode.point.y;
                case Orientation.Right:
                case Orientation.Left:
                  return adjacentNode.point.x !== leastDistanceNode.point.x;
                default:
                  return true;
              }
            }

            switch (direction) {
              case Orientation.Top:
                return adjacentNode.point.y > leastDistanceNode.point.y;
              case Orientation.Bottom:
                return adjacentNode.point.y < leastDistanceNode.point.y;
              case Orientation.Right:
                return adjacentNode.point.x < leastDistanceNode.point.x;
              case Orientation.Left:
                return adjacentNode.point.x > leastDistanceNode.point.x;
              default:
                return true;
            }
          });
          if (!validApproach) continue;
        }

        if (leastDistanceNode !== source && adjacentNode !== target &&
          !adjacentNode.isPortOf(gSource) &&
          !adjacentNode.isPortOf(gTarget)) {
          // Cannot go through a container unless the target or source is a descendant of that container (or is that container)
          if (adjacentNode.container !== null) {
            const sourceInside = routeSearchIsDescendantOf(this.work, sourceContainer, adjacentNode.container);
            const targetInside = routeSearchIsDescendantOf(this.work, targetContainer, adjacentNode.container);
            if (!sourceInside && !targetInside) {
              if (!fixedOverlaps.has(adjacentNode.container)) continue;
            }
          }
        }

        // only use adjacent nodes that are vertically or horizontally aligned with leastDistanceNode (no diagonals), unless using
        // source/target center
        if ((adjacentNode !== target) && (leastDistanceNode !== source)) {
          if ((adjacentNode.point.x !== leastDistanceNode.point.x) && (adjacentNode.point.y !== leastDistanceNode.point.y)) continue;
        }

        if (adjacentNode.isPortOf(gSource)) {
          if (blockedSourcePorts.has(adjacentNode.point)) continue;
        }

        let nextDistance;
        if (leastDistanceNode === source) {
          nextDistance = 1;
          // To avoid overlapping duplicate edges, avoid using the same source port as a duplicate edge
          if (!allowSrcPortSharing && duplicateSourcePortsUsed.get(adjacentNode.point) === true) nextDistance = basicallyInfinity;
          // ClusterPortSharing Step 2a.
          // penalize not using the same source port if another node in the cluster already connects to that source
          if (sharedClusterSourcePortsUsed.size > 0) {
            if (!sharedClusterSourcePortsUsed.has(adjacentNode.point)) {
              // If it takes more than 2 turns to get there, not worth sharing
              nextDistance += (2 * this.turnCost);
            }
          }
          if (!fromFacingPorts.has(adjacentNode.point) && preferFacingPorts) nextDistance += nonFacingPortsCost;

          // Looks nicer when arrows come out of center ports
          if (!adjacentNode.isCenterPortOf(gSource)) {
            nextDistance += this.nonCenterPortCost;
          } else if (!nodeIsCenterSymmetricalPort.has(adjacentNode)) {
            // Looks even slightly nicer when it comes out a port that has an edge going through the symmetrical port
            // Only prefer it all else being equal
            nextDistance += 1;
          }
        } else {
          nextDistance = e.distance;
        }

        // Cannot go outside a container if both the source and target are inside that container
        // but for nested going to parent, there may not be enough paths otherwise, so we allow that
        if (sourceContainer !== null && sourceContainer === targetContainer && !(isSourceDescendantOfTarget || isTargetDescendantOfSource)) {
          if (adjacentNode.container === null || adjacentNode.container !== sourceContainer) {
            // Note: penalty is if adjacent is outside the source container, and the edge from least distance to adjacent enters a
            // different container
            if (leastDistanceNode.container !== adjacentNode.container) nextDistance += this.turnCost * 4;
          }
        }

        // Penalize routing between ports of the same node
        if (leastDistanceNode.sharesPortOwner(adjacentNode)) nextDistance += this.turnCost * 4;

        // APPLY SPECIAL WEIGHTS --------------
        if (adjacentNode === target) {
          nextDistance = 1;
          // To avoid overlapping duplicate edges, don't use the same target port as a duplicate edge
          if (!allowDstPortSharing && duplicateTargetPortsUsed.get(leastDistanceNode.point) === true) nextDistance = basicallyInfinity;
          // ClusterPortSharing Step 2b.
          // penalize not using the same target port if another node in the cluster already connects to that target
          if (sharedClusterTargetPortsUsed.size > 0) {
            if (!sharedClusterTargetPortsUsed.has(leastDistanceNode.point)) {
              // If it takes more than 2 turns to get there, not worth sharing
              nextDistance += (2 * this.turnCost);
            }
          }
          if (!toFacingPorts.has(leastDistanceNode.point) && preferFacingPorts) nextDistance += nonFacingPortsCost;

          if (leastDistanceNode.isPortOf(gTarget)) {
            if (!leastDistanceNode.isCenterPortOf(gTarget)) {
              nextDistance += this.nonCenterPortCost;
            } else if (!nodeIsCenterSymmetricalPort.has(leastDistanceNode)) {
              nextDistance += 1;
            }
          }
        } else if (adjacentNode.isNodeCenter) {
          nextDistance = basicallyInfinity;
        } else {
          // Reset overlappingEdges array for reuse
          overlappingEdges = [];
          let isProhibitedSharing = false;

          if ((leastDistanceNode !== source) && (leastDistanceNode !== target)) {
            const routesOnEdge = this.overlappingRoutes.get(e) ?? [];
            for (const route of routesOnEdge) {
              this.work.reserveProduct(route.ovgNodes.length + 1, 2);
              overlappingEdges.push(route.gEdge);
              if (gEdge.isDirected() && route.isOpposingColinear(leastDistanceNode, adjacentNode)) {
                isProhibitedSharing = true;
                break;
              }
              if (adjacentNode.isTunnel) {
                // A tunnel route cannot overlap an entirely other route
                if (route.isEntireColinear(adjacentNode, leastDistanceNode) || route.isEntireColinear(leastDistanceNode, adjacentNode)) {
                  isProhibitedSharing = true;
                  break;
                }
              }
            }
          }

          if (!isProhibitedSharing) {
            const canOverlap = edgeCanOverlapEdgesGuarded(gEdge, overlappingEdges, sourceClusterNodes, targetClusterNodes, this.work);
            isProhibitedSharing = overlappingEdges.length > 0 && !canOverlap;
          }

          let isAdjacentNodeOnRoute = false;
          if (!isProhibitedSharing && (leastDistanceNode !== source) && (leastDistanceNode !== target)) {
            isAdjacentNodeOnRoute = (this.pointToRoute.get(adjacentNode.point) ?? []).length > 0;
          }

          if (!isProhibitedSharing && !isOnNodeOfRoute && !isAdjacentNodeOnRoute && (leastDistanceNode !== source)) {
            if (this.hasNearbyEdge.has(e)) isProhibitedSharing = true;
          }

          if (isProhibitedSharing) {
            nextDistance = sharedRouteCost;
          } else {
            let isCrossing = false;
            // There's two cases of crossing:
            // 1. When an OVG node is at the intersection
            // 2. When there isn't

            // Case 1
            if (isOnNodeOfRoute && !isAdjacentNodeOnRoute && !areAllOccupiedRoutesShareable) isCrossing = true;

            // Case 2
            if (!isCrossing && (leastDistanceNode !== source)) {
              // If coming from source or going towards target, it'll intersect with other edges, and that's fine
              // Even if node is not on a route, still have to check for if it's crossing while not sharing a node.
              isCrossing = this.edgeSet.intersectsWithGuarded(e, this.work);
            }

            if (isCrossing) nextDistance += this.crossingCost;
          }
        }

        // Check intersection with positioned labels (avoiding allocation)
        for (let i = 0; i < this.positionedLabels.length; i++) {
          this.work.step();
          if (segmentIntersectsBox(e.from.point, e.to.point, this.positionedLabels[i].box)) {
            nextDistance += basicallyInfinity;
            break;
          }
        }

        // Check intersection with node label boxes
        for (const labelBox of nodeLabelBoxes) {
          this.work.step();
          if (segmentIntersectsBox(e.from.point, e.to.point, labelBox.box)) nextDistance += this.turnCost;
        }

        // Handle arrow labels
        if (leastDistanceNode.isPortOf(gSource)) {
          if (gEdge.sourceArrowheadLabel !== null) {
            routePoints[0] = leastDistanceNode.point;
            routePoints[1] = adjacentNode.point;
            const al = labeling.positionArrowheadLabel(gEdge, false, routePoints.slice());
            const labelCost = positionedArrowheadLabelCostGuarded(al.copy(), nonAncestors, this.positionedLabels, this.routes, null, this.work);
            nextDistance += labelCost;
          }
        }
        if (adjacentNode.isPortOf(gTarget)) {
          if (gEdge.targetArrowheadLabel !== null) {
            routePoints[0] = leastDistanceNode.point;
            routePoints[1] = adjacentNode.point;
            const al = labeling.positionArrowheadLabel(gEdge, true, routePoints.slice());
            const labelCost = positionedArrowheadLabelCostGuarded(al.copy(), nonAncestors, this.positionedLabels, this.routes, null, this.work);
            nextDistance += labelCost;
          }
        }

        // Don't count coming from source or heading to target as turns
        if (lastNode !== null && ((adjacentNode !== target) && (leastDistanceNode !== source)) && (lastNode !== source)) {
          const turns = (!isFromHorizontal && (adjacentNode.point.x !== leastDistanceNode.point.x)) ||
            (isFromHorizontal && (adjacentNode.point.y !== leastDistanceNode.point.y));
          if (turns) {
            // Knock off a few points for turning at an ideal axis
            let multiplier = 1.0;
            for (const idealTurnAxis of axes) {
              this.work.step();
              if (idealTurnAxis.isX) {
                if (Math.abs(adjacentNode.point.x - idealTurnAxis.val) <= idealTurnAxisTolerance) {
                  multiplier = idealTurnMultiplier;
                  break;
                }
              } else if (Math.abs(adjacentNode.point.y - idealTurnAxis.val) <= idealTurnAxisTolerance) {
                multiplier = idealTurnMultiplier;
                break;
              }
            }
            if (multiplier !== 1.0) {
              if (gEdge.from.cluster !== null && (gSource.cluster.arrangement === gSource.cluster.desiredArrangement) && gEdge.from.cluster.nodes.length % 2 === 0) {
                multiplier = idealTurnEvenClusterMultiplier;
              }
            }
            // Turns right or left
            if (!isFromHorizontal && (adjacentNode.point.x !== leastDistanceNode.point.x)) {
              nextDistance += (this.turnCost * multiplier);
              // Not allowed to turn too close to the target, looks ugly but you gotta do what you gotta do for weird situations
              // like child routing to container
              if (!(isSourceDescendantOfTarget || isTargetDescendantOfSource)) {
                if (leastDistanceNode.distanceToBoundary(gTarget) <= turnEndpointClearance) nextDistance += this.turnCost;
                if (leastDistanceNode.distanceToBoundary(gSource) <= turnEndpointClearance) nextDistance += this.turnCost;
              }
            }
            // Turns up or down
            if (isFromHorizontal && (adjacentNode.point.y !== leastDistanceNode.point.y)) {
              nextDistance += (this.turnCost * multiplier);
              if (!(isSourceDescendantOfTarget || isTargetDescendantOfSource)) {
                if (leastDistanceNode.distanceToBoundary(gTarget) <= turnEndpointClearance) nextDistance += this.turnCost;
                if (leastDistanceNode.distanceToBoundary(gSource) <= turnEndpointClearance) nextDistance += this.turnCost;
              }
            }
          }
        }

        // All else being equal, penalize taking routes that are too close to nodes
        if (leastDistanceNode !== source && adjacentNode !== target && adjacentNode.isNearPort !== null && adjacentNode.isNearPort.size > 0) {
          if (adjacentNode.isNearPort.has(gSource)) nextDistance += nodeProximityPenalty;
          else if (adjacentNode.isNearPort.has(gTarget)) nextDistance += nodeProximityPenalty;
        }

        const maybeNewDistance = leastDistance + nextDistance;

        // Create node context if it doesn't exist
        if (nodeContext[adjacentNode.index] === null) nodeContext[adjacentNode.index] = new SearchNodeContext();

        // Horizontal path
        if (adjacentNode.point.y === leastDistanceNode.point.y) {
          if (maybeNewDistance < nodeContext[adjacentNode.index].horizontalDistance) {
            // If we already visited this node horizontally, enqueue the current hop to potentially be revisited
            if (horizontalHops[adjacentNode.index] !== null) {
              pq.push(
                nodeContext[horizontalHops[adjacentNode.index].index].horizontalDistance,
                horizontalHops[adjacentNode.index],
                true,
                this.work,
              );
            }

            // Create or update entry
            if (nodeContext[adjacentNode.index].horizontalEntry === null) {
              const horizontalEntry = pq.push(maybeNewDistance, adjacentNode, true, this.work);
              nodeContext[adjacentNode.index].horizontalEntry = horizontalEntry;
            } else {
              pq.decrease(nodeContext[adjacentNode.index].horizontalEntry, maybeNewDistance, this.work);
            }

            nodeContext[adjacentNode.index].horizontalDistance = maybeNewDistance;
            horizontalHops[adjacentNode.index] = leastDistanceNode;
          }
        } else if (maybeNewDistance < nodeContext[adjacentNode.index].verticalDistance) { // Vertical path
          // If we already visited this node vertically, enqueue the current hop to potentially be revisited
          if (verticalHops[adjacentNode.index] !== null) {
            pq.push(
              nodeContext[verticalHops[adjacentNode.index].index].verticalDistance,
              verticalHops[adjacentNode.index],
              false,
              this.work,
            );
          }

          // Create or update entry
          if (nodeContext[adjacentNode.index].verticalEntry === null) {
            const verticalEntry = pq.push(maybeNewDistance, adjacentNode, false, this.work);
            nodeContext[adjacentNode.index].verticalEntry = verticalEntry;
          } else {
            pq.decrease(nodeContext[adjacentNode.index].verticalEntry, maybeNewDistance, this.work);
          }

          nodeContext[adjacentNode.index].verticalDistance = maybeNewDistance;
          verticalHops[adjacentNode.index] = leastDistanceNode;
        }
      }
    }

    throw errorf(`path not found for '${gEdge.debugID()}'. Queue is empty`);
  }

  /**
   * If two non-diagonal nodes are below (MinRouteNodeClearance+1) * 2 from each other and connected, there won't be a direct path,
   * and it'll take a roundabout path which can block other paths. To alleviate this, we directly connect fromFacingPort to
   * toFacingPort, no need to search. Returns [ovgNodes | null, distance].
   */
  quickRoute(ctx, gEdge, overlap, fromOrientation) {
    this.bindWork(ctx);
    checkEdgeRoutingCanceled(ctx);
    const g = this.ovg;
    const originalGraph = this.graph;
    const gSource = gEdge.from;
    const gTarget = gEdge.to;
    const source = g.centers.get(gSource);
    const target = g.centers.get(gTarget);
    if (!overlap && !geo.isDiagonal(fromOrientation) && gSource.distanceTo(gTarget, true) < 2 * (MinRouteNodeClearance + 1) && (gSource.distanceTo(gTarget, true) > MinArrowheadClearance)) {
      const edges = [];
      for (const route of this.routes) {
        this.work.add(route.ovgNodes.length + 1);
        const edge = newEdge(route.gEdge.from, route.gEdge.to);
        edge.points = route.createSegmentEndpoints();
        edge.sourceArrowhead = route.gEdge.sourceArrowhead;
        edge.targetArrowhead = route.gEdge.targetArrowhead;
        edge.sourceArrowheadLabel = route.gEdge.sourceArrowheadLabel;
        edge.targetArrowheadLabel = route.gEdge.targetArrowheadLabel;
        edge.label = route.gEdge.label;
        edges.push(edge);
      }
      checkEdgeRoutingCanceled(ctx);
      let sourcePort, targetPort, lineCost, err = null;
      try {
        [sourcePort, targetPort, lineCost] = routeLineChecked(originalGraph, gEdge, edges, null, () => this.work.step(), this.work);
      } catch (e) {
        if (!(e instanceof GoError)) throw e;
        err = e;
      }

      if (err === null) {
        return [[source, new OVGNode(sourcePort), new OVGNode(targetPort), target], lineCost];
      }
      if (isContextTermination(err)) throw err;
    }
    return [null, 0];
  }

  isUndesirableClusterArrangement(gSource, gTarget) {
    // If the cluster nodes are in a bad arrangement for the gSource->gTarget edge, e.g. c1 and c2 to t then they should not be
    // treated as clusters for the purposes of route searching. NOTE that this will only take effect if cluster optimizing is
    // included as a prior stage
    if (gSource.cluster !== null) {
      if (!clusterHasDesirableArrangementTo(gSource.cluster, gTarget)) return true;
    }
    if (gTarget.cluster !== null) {
      if (!clusterHasDesirableArrangementTo(gTarget.cluster, gSource)) return true;
    }
    return false;
  }

  /** bestRoute finds the lowest-cost route to target, choosing between vertical and horizontal hops. */
  bestRoute(ctx, gSource, gTarget, source, target, nodeContext, verticalHops, horizontalHops) {
    this.bindWork(ctx);
    const sequence = [];

    const axes = idealTurnAxes(gSource, gTarget);

    let curr = target;
    let prev = null;
    let next = null;
    const visited = new Set();
    while (curr !== null) {
      this.work.step();
      if (visited.has(curr)) {
        // Cycle detected, take corrective action
        break;
      }
      visited.add(curr);
      sequence.push(curr);

      let isHorizontal;
      const entry = nodeContext[curr.index];
      const verticalDistance = entry.verticalDistance;
      const horizontalDistance = entry.horizontalDistance;
      if ((verticalHops[curr.index] !== null) && (horizontalHops[curr.index] !== null)) {
        if (verticalDistance < horizontalDistance) {
          next = verticalHops[curr.index];
          isHorizontal = false;
        } else {
          next = horizontalHops[curr.index];
          isHorizontal = true;
        }
      } else if (verticalHops[curr.index] !== null) {
        next = verticalHops[curr.index];
        isHorizontal = false;
      } else {
        next = horizontalHops[curr.index];
        isHorizontal = true;
      }

      // Because the cost of a turn is baked into the node (node T) it turns into, and not the intersection (node I)
      // When another route comes in without a turn, it'll set lower weights from node T onwards, erasing the cost of turn,
      // But node I is not changed, and the best route would still be the one with the turn
      // So we reintroduce the cost to node I here. That way, we only turn if the cost of it PLUS the turn is better than the route
      // without the turn. If next is source, we're at a port and disregard the turn
      if ((prev !== null) && (next !== null) && (next !== source)) {
        // If the next one leads to a turn ...
        if (((prev.point.x === curr.point.x) && isHorizontal) || ((prev.point.y === curr.point.y) && !isHorizontal)) {
          let alternativeDistance = 0;
          let alternative = null;
          let multiplier = 1.0;

          for (const idealTurnAxis of axes) {
            this.work.step();
            if (idealTurnAxis.isX) {
              if (Math.abs(curr.point.x - idealTurnAxis.val) <= idealTurnAxisTolerance) {
                multiplier = idealTurnMultiplier;
                break;
              }
            } else if (Math.abs(curr.point.y - idealTurnAxis.val) <= idealTurnAxisTolerance) {
              multiplier = idealTurnMultiplier;
              break;
            }
          }
          if (multiplier !== 1.0) {
            if (gSource.cluster !== null && (gSource.cluster.arrangement === gSource.cluster.desiredArrangement) && gSource.cluster.nodes.length % 2 === 0) {
              multiplier = idealTurnEvenClusterMultiplier;
            }
          }
          // And the margin is only by turn distance ...
          if (isHorizontal && (geo.precisionCompare(horizontalDistance + this.turnCost * multiplier, verticalDistance, geo.PRECISION) > 0)) {
            // Then we should use the other direction
            alternativeDistance = verticalDistance;
            alternative = verticalHops[curr.index];
          }
          if (!isHorizontal && (geo.precisionCompare(verticalDistance + this.turnCost * multiplier, horizontalDistance, geo.PRECISION) > 0)) {
            alternativeDistance = horizontalDistance;
            alternative = horizontalHops[curr.index];
          }
          // If alternative is basically infinity, it'll cycle
          if (alternative !== null && alternativeDistance < basicallyInfinity) next = alternative;
        }
      }

      prev = curr;
      curr = next;
    }
    for (let left = 0, right = sequence.length - 1; left < right; left++, right--) {
      this.work.step();
      const t = sequence[left]; sequence[left] = sequence[right]; sequence[right] = t;
    }
    return sequence;
  }

  /**
   * OVG routes only overlap if both OVG nodes share the same route. As all routes are either vertical or horizontal, there is no
   * overlap between n1 and n3 when they can't share a route; with tunnel nodes we need to check for all vertical edges at the same
   * X (see ovg_edge_router.go for the drawings).
   */
  findOverlappingRoutes(start, end) {
    const overlappingRoutes = [];
    const routeSet = new Set();

    // find all overlapping edges
    const overlaps = this.edgeSet.overlappingEdgesGuarded(newOVGEdge(start, end), this.work);
    for (const overlapping of overlaps) {
      this.work.step();
      for (const rf of this.pointToRoute.get(overlapping.from.point) ?? []) {
        this.work.step();
        for (const rt of this.pointToRoute.get(overlapping.to.point) ?? []) {
          this.work.step();
          // find the route that contains the edge; only add the route if not seen before
          if (!routeSet.has(rt) && rt === rf) {
            routeSet.add(rt);
            overlappingRoutes.push(rt);
          }
        }
      }
    }
    return overlappingRoutes;
  }

  addRoute(route) {
    const dups = new Set();
    let routeNodes = route.ovgNodes;
    if (route.gEdge.isLoop()) {
      // The source and target centers are the same node for a loop.
      routeNodes = routeNodes.slice(1);
    }
    for (let i = 0; i < routeNodes.length; i++) {
      const n = routeNodes[i];
      this.work.step();
      if (dups.has(n)) {
        throw errorf(`found duplicate OVGNode (&{X:${goV(n.point.x)} Y:${goV(n.point.y)}}) at index ${i} in route ${route.gEdge.debugID()}`);
      }
      dups.add(n);
    }

    if (route.gEdge.sourceArrowheadLabel !== null) {
      this.work.add(route.ovgNodes.length);
      const routePoints = route.createSegmentEndpoints();
      const al = labeling.positionArrowheadLabel(route.gEdge, false, routePoints);
      this.positionedLabels.push(al.copy());
    }
    if (route.gEdge.targetArrowheadLabel !== null) {
      this.work.add(route.ovgNodes.length);
      const routePoints = route.createSegmentEndpoints();
      const al = labeling.positionArrowheadLabel(route.gEdge, true, routePoints);
      this.positionedLabels.push(al.copy());
    }

    this.routes.push(route);
    this.routedEdges.push(route.gEdge);
    for (let i = 0; i < route.ovgNodes.length; i++) {
      this.work.step();
      const start = route.ovgNodes[i];
      let list = this.pointToRoute.get(start.point);
      if (list === undefined) {
        list = [];
        this.pointToRoute.set(start.point, list);
      }
      list.push(route);

      if (i > 0 && i < route.ovgNodes.length - 2) {
        // only keep edges of the OVG path, ignore edges from port to center
        const end = route.ovgNodes[i + 1];
        this.edgeSet.addGuarded(newOVGEdge(start, end), this.work);
      }
    }

    if (!route.gEdge.isInvisible) {
      for (let i = 1; i < route.ovgNodes.length - 2; i++) {
        this.work.step();
        const routeNode = route.ovgNodes[i];
        const nextRouteNode = route.ovgNodes[i + 1];
        if (routeNode.x === nextRouteNode.x) {
          // vertical
          let routeTop = routeNode.y, routeBottom = nextRouteNode.y;
          if (routeBottom < routeTop) { const t = routeTop; routeTop = routeBottom; routeBottom = t; }
          // Route coordinates may be fractional, so scan the indexed axes rather than iterating integer coordinates around routeNode.X.
          for (const [x, ovgEdges] of this.ovg.verticalEdges) {
            this.work.step();
            if (Math.abs(x - routeNode.x) > pathNodeProximityFloor) continue;
            for (const ovgEdge of ovgEdges) {
              this.work.step();
              let edgeTop = ovgEdge.from.y, edgeBottom = ovgEdge.to.y;
              if (edgeBottom < edgeTop) { const t = edgeTop; edgeTop = edgeBottom; edgeBottom = t; }
              if (!(edgeBottom < routeTop || routeBottom < edgeTop)) {
                this.hasNearbyEdge.add(ovgEdge);
                if (x === routeNode.x) {
                  let rl = this.overlappingRoutes.get(ovgEdge);
                  if (rl === undefined) { rl = []; this.overlappingRoutes.set(ovgEdge, rl); }
                  rl.push(route);
                }
              }
            }
          }
        } else {
          let routeLeft = routeNode.x, routeRight = nextRouteNode.x;
          if (routeRight < routeLeft) { const t = routeLeft; routeLeft = routeRight; routeRight = t; }
          for (const [y, ovgEdges] of this.ovg.horizontalEdges) {
            this.work.step();
            if (Math.abs(y - routeNode.y) > pathNodeProximityFloor) continue;
            for (const ovgEdge of ovgEdges) {
              this.work.step();
              let edgeLeft = ovgEdge.from.x, edgeRight = ovgEdge.to.x;
              if (edgeRight < edgeLeft) { const t = edgeLeft; edgeLeft = edgeRight; edgeRight = t; }
              if (!(edgeRight < routeLeft || routeRight < edgeLeft)) {
                this.hasNearbyEdge.add(ovgEdge);
                if (y === routeNode.y) {
                  let rl = this.overlappingRoutes.get(ovgEdge);
                  if (rl === undefined) { rl = []; this.overlappingRoutes.set(ovgEdge, rl); }
                  rl.push(route);
                }
              }
            }
          }
        }
      }
    }
    this.work.check();
  }

  /**
   * tablePorts finds the ports to connect the columns from source to target. By default, it returns ports on both sides of `source`
   * and `target`, `facingPorts` forces it to return ports on facing sides, if they exists (for example, if
   * source.Orientation(target) = geo.NONE, there are no facing ports). Returns [sourcePorts, targetPorts] as Set<OVGNode> (undefined
   * where Go returns a nil map).
   */
  tablePorts(edge, source, target, facingPorts) {
    const getPorts = (node, columnIndex, orientations) => {
      const ports = new Set();
      for (const o of orientations) {
        // Port-index derivation scans the node's incident edges to account for loop offsets before indexing the already-bounded
        // port slice.
        this.work.add(node.edges.length + 1);
        let [portIndex, isTableSide] = tablePortIndex(node.shape, o, columnIndex);
        if (!isTableSide) portIndex = node.portIndices(o)[columnIndex];
        ports.add(this.ovg.ports.get(node)[portIndex]);
      }
      return ports;
    };

    let sourceOrientations = [], targetOrientations = [];
    if (!facingPorts) {
      sourceOrientations = [Orientation.Right, Orientation.Left];
      targetOrientations = [Orientation.Right, Orientation.Left];
    } else {
      switch (source.orientation(target)) {
        case Orientation.Left:
        case Orientation.TopLeft:
        case Orientation.BottomLeft:
          sourceOrientations = [Orientation.Right];
          targetOrientations = [Orientation.Left];
          break;
        case Orientation.Right:
        case Orientation.TopRight:
        case Orientation.BottomRight:
          sourceOrientations = [Orientation.Left];
          targetOrientations = [Orientation.Right];
          break;
      }
    }

    let sourcePorts, targetPorts;
    if (edge.fromTableColumnIndex !== null) sourcePorts = getPorts(source, edge.fromTableColumnIndex, sourceOrientations);
    if (edge.toTableColumnIndex !== null) targetPorts = getPorts(target, edge.toTableColumnIndex, targetOrientations);
    return [sourcePorts, targetPorts];
  }
}

export function clusterHasDesirableArrangementTo(cluster, node) {
  let bounds = cluster.vessel;
  if (!cluster.isActive()) {
    // The vessel may be out of sync after cluster placement. Cluster nodes remain arranged in visual order, so their first and last
    // boxes define the same routing extent used by the original implementation.
    const topLeft = cluster.nodes[0].topLeft.copy();
    const last = cluster.nodes[cluster.nodes.length - 1];
    const bottomRight = last.topLeft.copy();
    bottomRight.x += last.width;
    bottomRight.y += last.height;
    bounds = new Node();
    bounds.box = new geo.Box(topLeft, bottomRight.x - topLeft.x, bottomRight.y - topLeft.y);
  }
  switch (bounds.orientation(node)) {
    case Orientation.Top:
    case Orientation.Bottom:
      return cluster.arrangement === 'Row';
    case Orientation.Left:
    case Orientation.Right:
      return cluster.arrangement === 'Column';
    default:
      return false;
  }
}

// ovgEdgeRouter's methods that slingshot.go defines
for (const name of ['launch', 'findLaunchings', 'findLandings', 'fillPathGuarded', 'arrowheadLabelOverlapPenalty', 'slingshot', 'findLShapedRoute', 'findSShapedRoute']) {
  OvgEdgeRouter.prototype[name] = sling[name];
}

/**
 * sortEdges orders the edges of a flavor with Go's slices.SortStableFunc (goslices.js: the TopDownLeftRight comparator is not a strict weak
 * order for distinct nodes at the same position, so the algorithm matters).
 */
export function sortEdges(flavor, edges, clusterNodes) {
  const cmpNum = (a, b) => (a < b ? -1 : b < a ? 1 : 0);
  switch (flavor) {
    case ShortestToLongest:
      sortStableFunc(edges, (a, b) => {
        const aDistance = a.euclideanDistance();
        const bDistance = b.euclideanDistance();
        if (aDistance < bDistance) return -1;
        if (bDistance < aDistance) return 1;
        return 0;
      });
      break;
    case LongestToShortest:
      sortStableFunc(edges, (a, b) => {
        const aDistance = a.euclideanDistance();
        const bDistance = b.euclideanDistance();
        if (aDistance > bDistance) return -1;
        if (bDistance > aDistance) return 1;
        return 0;
      });
      break;
    case TopDownLeftRight:
      sortStableFunc(edges, (a, b) => {
        // Ensure that edge.From is above edge.To for both edges.
        let aFrom = a.from;
        let aTo = a.to;
        if (aFrom.topLeft.y > aTo.topLeft.y) { const t = aFrom; aFrom = aTo; aTo = t; }
        let bFrom = b.from;
        let bTo = b.to;
        if (bFrom.topLeft.y > bTo.topLeft.y) { const t = bFrom; bFrom = bTo; bTo = t; }

        if (aFrom.topLeft.y !== bFrom.topLeft.y) return cmpNum(aFrom.topLeft.y, bFrom.topLeft.y);
        // a and b start in the same row.
        if (aFrom !== bFrom) return cmpNum(aFrom.topLeft.x, bFrom.topLeft.x);
        // Same from node, maybe different targets.
        if (aTo.topLeft.y === bTo.topLeft.y) return cmpNum(aTo.topLeft.x, bTo.topLeft.x);
        // Return the top-most target.
        return cmpNum(aTo.topLeft.y, bTo.topLeft.y);
      });
      break;
  }

  // Clusters go first, looks best
  sortStableFunc(edges, (a, b) => {
    let connectedA = false;
    let connectedB = false;

    if (clusterNodes.has(a.from)) connectedA = true;
    else if (clusterNodes.has(a.to)) connectedA = true;
    if (clusterNodes.has(b.from)) connectedB = true;
    else if (clusterNodes.has(b.to)) connectedB = true;

    if (connectedA && !connectedB) return -1;
    if (!connectedA && connectedB) return 1;
    return 0;
  });
}

/** newOVGEdgeRouterWithWorkLimit(ctx, flavor, ovg, g, existingRoutes, edges, workLimit) */
export function newOVGEdgeRouterWithWorkLimit(ctx, flavor, ovg, g, existingRoutes, edges, workLimit) {
  const guard = newRouteSearchWorkGuard(ctx, flavor, workLimit);
  try {
    guard.add(edges.length);
    const orderedEdges = edges.slice();

    const clusterNodes = new Set();
    for (const c of g.clusters.values()) {
      guard.step();
      for (const cn of c.nodes) {
        guard.step();
        clusterNodes.add(cn);
      }
    }
    for (const edge of orderedEdges) {
      guard.step();
      if (edge === null || edge.from === null || edge.to === null) continue;
      guard.reserveSum(edge.from.edges.length, edge.to.edges.length);
    }
    guard.reserveSort(orderedEdges.length);
    guard.reserveSort(orderedEdges.length);
    sortEdges(flavor, orderedEdges, clusterNodes);

    const router = new OvgEdgeRouter();
    router.flavor = flavor;
    router.graph = g;
    router.ovg = ovg;
    router.routes = [];
    router.routedEdges = [];
    router.positionedLabels = [];
    router.edges = orderedEdges;
    router.pointToRoute = new PointMap();
    router.turnCost = g.turnCostValue();
    router.crossingCost = g.crossingCostValue();
    router.nonCenterPortCost = g.nonCenterPortCostValue();
    router.edgeSet = newOvgEdgeSet();
    router.hasNearbyEdge = new Set();
    router.overlappingRoutes = new Map();
    router.work = guard;

    for (const route of existingRoutes) {
      guard.step();
      router.addRoute(route);
    }

    guard.check();
    return router;
  } catch (err) {
    if (err instanceof GoError) {
      try { guard.finish(); } catch (ignored) { /* _ = guard.finish() */ }
    }
    throw err;
  }
}
