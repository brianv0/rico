// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of the Go package d2layouts/d2talalayout/internal/routing (D2 v0.9.0), file(s): the parts of coordinator.go that
// the router core calls: GenerateRouteResponse, RouteGenerationFlavor, routeLine / routeLineGuarded / routeLineChecked,
// edgeCanOverlapEdges, isVerticalOrHorizontalOverlap, findOverlappingEdges, sourceAndTargetClusterNodes, maxSideLength and
// hasSharpAngleToBorder. The rest of coordinator.go (flavor workers, finalizeSelectedRoutes, routeEdgesWithResourceGuards,
// routeSentinelEdge, the straight-edge fallback and crosshatch stages, ...) is the second half of the package.
//
// Go's `checkWork func() error` is a function that throws; `guard` is a workBudget or null.

import * as geo from '../../geo.js';
import { ErrInvalidCandidate, Nodes, Edges, PointMap, newEdge } from '../layoutgraph.js';
import { AxisAlignmentTolerance } from '../layoutgraph.js';
import { checkEdgeRoutingCanceled } from './work.js';
import { minStraightEdgeAngle, nonOrthogonalFactor } from './tuning.js';
import { filterEdgeAncestors } from './filter.js';
import { intersects } from './geometry.js';
import { estimateRouteCost } from './cost.js';
import { labeling } from './deps.js';
import { portEdgesGuarded, edgeHasDuplicateInGuarded, sourceAndTargetClusterNodesGuarded, filterEdgeAncestorsGuarded, overlappingEdgesGuarded, edgeCanOverlapEdgesGuarded, positionedArrowheadLabelCostGuarded } from './standalone_route_guard.js';
import { estimateRouteCostGuarded, routeIntersectsNodeGuarded } from './cluster_route_guard.js';
import { positionedArrowheadLabelCost } from './slingshot.js';

const { Orientation } = geo;

export class GenerateRouteResponse {
  constructor() {
    this.routes = null; // Route[]
    this.distance = 0;
    this.err = null;
    this.flavor = '';
    this.work = null; // RouteSearchWorkGuard
  }
}

/** RouteGenerationFlavor is a string. */
export const ShortestToLongest = 'ShortestToLongest';
export const LongestToShortest = 'LongestToShortest';
export const Default = 'Default';
export const TopDownLeftRight = 'TopDownLeftRight';

/** routeLine(ctx, g, edge, allEdges, routes): [fromPort, toPort, cost] */
export function routeLine(ctx, g, edge, allEdges, routes) {
  return routeLineChecked(g, edge, allEdges, routes, () => checkEdgeRoutingCanceled(ctx), null);
}

export function routeLineGuarded(g, edge, allEdges, routes, guard) {
  return routeLineChecked(g, edge, allEdges, routes, () => guard.step(), guard);
}

/** Returns [bestFromPort, bestToPort, bestCost]; throws ErrInvalidCandidate when no pair works. */
export function routeLineChecked(g, edge, allEdges, routes, checkWork, guard) {
  checkWork();
  const fromOrientation = edge.from.orientation(edge.to);
  if (fromOrientation === Orientation.NONE) throw ErrInvalidCandidate;
  const fromPorts = edge.from.portsByOrientation(geo.getOpposite(fromOrientation));

  const toOrientation = edge.to.orientation(edge.from);
  if (toOrientation === Orientation.NONE) throw ErrInvalidCandidate;
  const toPorts = edge.to.portsByOrientation(geo.getOpposite(toOrientation));

  let fromPortEdges, toPortEdges;
  if (guard === null) {
    fromPortEdges = Edges.portEdges(allEdges, edge.from);
    toPortEdges = Edges.portEdges(allEdges, edge.to);
  } else {
    fromPortEdges = portEdgesGuarded(allEdges, edge.from, guard);
    toPortEdges = portEdgesGuarded(allEdges, edge.to, guard);
  }
  // we filter out the current edge here to keep the logic for arrowhead matching simpler
  const filterEdge = (portEdges) => {
    const filteredEdges = [];
    for (const e of portEdges) {
      checkWork();
      if (e !== edge) filteredEdges.push(e);
    }
    return filteredEdges;
  };
  for (const [fromPort, portEdges] of [...fromPortEdges.entries()]) {
    const filteredEdges = filterEdge(portEdges);
    fromPortEdges.set(fromPort, filteredEdges);
  }
  for (const [toPort, portEdges] of [...toPortEdges.entries()]) {
    const filteredEdges = filterEdge(portEdges);
    toPortEdges.set(toPort, filteredEdges);
  }

  const fromNodeCenterPorts = new PointMap();
  for (const centerPort of edge.from.centerPorts()) fromNodeCenterPorts.set(centerPort, true);
  const toNodeCenterPorts = new PointMap();
  for (const centerPort of edge.to.centerPorts()) toNodeCenterPorts.set(centerPort, true);
  let sourceClusterNodes, targetClusterNodes;
  if (guard === null) {
    [sourceClusterNodes, targetClusterNodes] = sourceAndTargetClusterNodes(g, edge.from, edge.to);
  } else {
    [sourceClusterNodes, targetClusterNodes] = sourceAndTargetClusterNodesGuarded(g, edge.from, edge.to, guard);
  }

  let nonAncestors = null;
  if (edge.sourceArrowheadLabel !== null || edge.targetArrowheadLabel !== null) {
    if (guard === null) nonAncestors = filterEdgeAncestors(edge, g.nodes);
    else nonAncestors = filterEdgeAncestorsGuarded(edge, g.nodes, guard);
  }

  const positionedLabels = [];
  for (let i = 0; i < allEdges.length; i++) {
    const e = allEdges[i];
    checkWork();
    if (e === edge) continue;
    let route;
    if (routes !== null) route = routes[i].createSegmentEndpoints();
    else route = e.points;
    if (route.length === 0) continue;
    if (guard !== null) guard.add(route.length);
    let pal = labeling.positionArrowheadLabel(e, false, route);
    if (pal !== null) positionedLabels.push(pal.copy());
    pal = labeling.positionArrowheadLabel(e, true, route);
    if (pal !== null) positionedLabels.push(pal.copy());
  }

  let bestCost = Infinity;
  let bestFromPort = null, bestToPort = null;

  // for each pair, place an edge, get the cost, but multiply it by some penalty factor for being non-orthogonal
  for (let fromI = 0; fromI < fromPorts.length; fromI++) {
    const fromPort = fromPorts[fromI];
    checkWork();
    let fromPortCost = 0.0;
    // Note: remove fromPortEdges could be empty if there are no edges after filtering
    if (fromPortEdges.has(fromPort) && fromPortEdges.get(fromPort).length > 0) {
      const fromPortEdgesAtPort = fromPortEdges.get(fromPort);
      // we don't consider ports used by a duplicate edge
      let duplicate;
      if (guard === null) duplicate = edge.hasDuplicateIn(fromPortEdgesAtPort);
      else duplicate = edgeHasDuplicateInGuarded(edge, fromPortEdgesAtPort, guard);
      if (duplicate) {
        // Edge case option: consider ports used by a duplicate edge, as long as the pair of source and target ports are not both
        // the same (e.g. 1/2 shared ok)
        continue;
      }

      // if the port is to be shared, all the edges must match arrowheads
      let allMatch = true;
      for (const otherFromPortEdge of fromPortEdgesAtPort) {
        checkWork();
        if (otherFromPortEdge.from === edge.from) {
          // other edge source arrow must match
          if (edge.sourceArrowhead !== otherFromPortEdge.sourceArrowhead) {
            allMatch = false;
            break;
          }
        } else if (edge.sourceArrowhead !== otherFromPortEdge.targetArrowhead) {
          // other edge target arrow must match
          allMatch = false;
          break;
        }
      }
      if (!allMatch) continue;

      // sharing a port with matching arrowheads is not ideal so other source ports should be preferred
      if (edge.hasSourceArrow()) fromPortCost = maxSideLength(edge.from, fromOrientation) / 2.0;
    }

    for (let toI = 0; toI < toPorts.length; toI++) {
      const toPort = toPorts[toI];
      checkWork();
      let toPortCost = 0.0;
      if (toPortEdges.has(toPort) && toPortEdges.get(toPort).length > 0) {
        const toPortEdgesAtPort = toPortEdges.get(toPort);
        let duplicate;
        if (guard === null) duplicate = edge.hasDuplicateIn(toPortEdgesAtPort);
        else duplicate = edgeHasDuplicateInGuarded(edge, toPortEdgesAtPort, guard);
        if (duplicate) continue;

        let allMatch = true;
        for (const otherToPortEdge of toPortEdgesAtPort) {
          checkWork();
          if (otherToPortEdge.to === edge.to) {
            if (edge.targetArrowhead !== otherToPortEdge.targetArrowhead) {
              allMatch = false;
              break;
            }
          } else if (edge.targetArrowhead !== otherToPortEdge.sourceArrowhead) {
            allMatch = false;
            break;
          }
        }
        if (!allMatch) continue;

        toPortCost = maxSideLength(edge.to, toOrientation) / 2.0;
      }

      const edgeOption = newEdge(edge.from, edge.to);
      edgeOption.points = [fromPorts[fromI], toPorts[toI]];

      // don't consider option if edge crosses over another node
      let intersectsNode;
      if (guard === null) intersectsNode = Nodes.intersectsNode(g.nodes, edgeOption);
      else intersectsNode = routeIntersectsNodeGuarded(g.nodes, edgeOption, guard);
      if (intersectsNode) continue;

      const otherEdges = filterEdge(allEdges);

      let overlappingEdges;
      if (guard === null) overlappingEdges = findOverlappingEdges(fromPorts[fromI], toPorts[toI], otherEdges);
      else overlappingEdges = overlappingEdgesGuarded(fromPorts[fromI], toPorts[toI], otherEdges, guard);
      if (overlappingEdges.length > 0) {
        let canOverlap = false;
        if (guard === null) canOverlap = edgeCanOverlapEdges(edge, overlappingEdges, sourceClusterNodes, targetClusterNodes);
        else canOverlap = edgeCanOverlapEdgesGuarded(edge, overlappingEdges, sourceClusterNodes, targetClusterNodes, guard);
        if (!canOverlap) continue;
      }

      let routeCost;
      if (guard === null) routeCost = estimateRouteCost(otherEdges, edgeOption);
      else routeCost = estimateRouteCostGuarded(otherEdges, edgeOption, guard);
      let cost = fromPortCost + toPortCost + routeCost;

      if (fromPort.x !== toPort.x && fromPort.y !== toPort.y) {
        let isAxisAligned = false;
        // Reward axis-aligned lines
        if (geo.precisionCompare(fromPort.x, toPort.x, AxisAlignmentTolerance) === 0) isAxisAligned = true;
        if (geo.precisionCompare(fromPort.y, toPort.y, AxisAlignmentTolerance) === 0) isAxisAligned = true;
        if (!isAxisAligned) cost *= nonOrthogonalFactor;
      }

      // skip straight edges with sharp angles with source or target node
      if (hasSharpAngleToBorder(fromPorts[fromI], toPorts[toI], fromOrientation)) continue;
      if (hasSharpAngleToBorder(fromPorts[fromI], toPorts[toI], toOrientation)) continue;

      // Reward lines that go through center
      if (!fromNodeCenterPorts.has(fromPort)) cost += g.nonCenterPortCostValue();
      if (!toNodeCenterPorts.has(toPort)) cost += g.nonCenterPortCostValue();

      if (edge.sourceArrowheadLabel !== null) {
        const routePoints = [fromPorts[fromI], toPorts[toI]];
        const pal = labeling.positionArrowheadLabel(edge, false, routePoints);
        if (guard === null) {
          cost += positionedArrowheadLabelCost(pal, nonAncestors, positionedLabels, null, otherEdges);
        } else {
          const labelCost = positionedArrowheadLabelCostGuarded(pal, nonAncestors, positionedLabels, null, otherEdges, guard);
          cost += labelCost;
        }
      }
      if (edge.targetArrowheadLabel !== null) {
        const routePoints = [fromPorts[fromI], toPorts[toI]];
        const pal = labeling.positionArrowheadLabel(edge, true, routePoints);
        if (guard === null) {
          cost += positionedArrowheadLabelCost(pal, nonAncestors, positionedLabels, null, otherEdges);
        } else {
          const labelCost = positionedArrowheadLabelCostGuarded(pal, nonAncestors, positionedLabels, null, otherEdges, guard);
          cost += labelCost;
        }
      }

      // get the best cost of these pairs
      if (cost < bestCost) {
        bestFromPort = fromPorts[fromI];
        bestToPort = toPorts[toI];
        bestCost = cost;
      }
    }
  }

  if (bestCost === Infinity) throw ErrInvalidCandidate;

  return [bestFromPort, bestToPort, bestCost];
}

/** return true if gEdge can overlap with the other edges provided (sourceClusterNodes/targetClusterNodes: Map<Node, bool>) */
export function edgeCanOverlapEdges(edge, otherEdges, sourceClusterNodes, targetClusterNodes) {
  if (otherEdges.length === 0) return true;
  if (edge.targetArrowheadLabel !== null || edge.sourceArrowheadLabel !== null) return false;
  for (const e of otherEdges) {
    if (e.targetArrowheadLabel !== null || e.sourceArrowheadLabel !== null) return false;
    if (!edge.equivalentStyles(e)) return false;
  }

  let isClusterEdge = false;
  if (sourceClusterNodes !== null && sourceClusterNodes.size > 0) {
    let hasNonSourceClusterEdge = false;
    for (const otherEdge of otherEdges) {
      const isFromSourceCluster = sourceClusterNodes.has(otherEdge.from);
      const isToSourceCluster = sourceClusterNodes.has(otherEdge.to);
      if (!isFromSourceCluster && !isToSourceCluster) {
        hasNonSourceClusterEdge = true;
        break;
      }
    }
    if (!hasNonSourceClusterEdge) isClusterEdge = true;
  }
  if (!isClusterEdge && targetClusterNodes !== null && targetClusterNodes.size > 0) {
    let hasNonTargetClusterEdge = false;
    for (const otherEdge of otherEdges) {
      const isFromTargetCluster = targetClusterNodes.has(otherEdge.from);
      const isToTargetCluster = targetClusterNodes.has(otherEdge.to);
      if (!isFromTargetCluster && !isToTargetCluster) {
        hasNonTargetClusterEdge = true;
        break;
      }
    }
    if (!hasNonTargetClusterEdge) isClusterEdge = true;
  }

  // TODO find a better solution for edge routing with labels. Shared edges with labels require special handling unless they
  // belong to clusters.

  // if directed edges share a source or target, they can share an edge
  let allMatchingDirected = edge.isDirected();
  if (allMatchingDirected) {
    for (const otherEdge of otherEdges) {
      if (!otherEdge.isDirected()) {
        allMatchingDirected = false;
        break;
      }
      if (!(edge.to === otherEdge.to || edge.from === otherEdge.from)) {
        allMatchingDirected = false;
        break;
      }
      if (edge.targetArrowhead !== otherEdge.targetArrowhead || edge.sourceArrowhead !== otherEdge.sourceArrowhead) {
        allMatchingDirected = false;
        break;
      }
    }
  }
  if (allMatchingDirected) return true;

  // bidirectional / undirected edges can overlap as long as source/target arrowheads match and if they are part of the same cluster
  // or if all edges share a node
  // TODO support overlapping bidirectional edges with different source/target arrowheads.
  let allUndirected = false;
  const allBidirectional = edge.isBidirectional() && edge.ownArrowheadsMatch();
  if (allBidirectional) {
    for (const otherEdge of otherEdges) {
      if (!otherEdge.isBidirectional() || !edge.matchingArrowheads(otherEdge)) return false;
    }
  } else {
    allUndirected = edge.isUndirected();
    if (allUndirected) {
      for (const otherEdge of otherEdges) {
        if (!otherEdge.isUndirected()) return false;
      }
    }
  }
  if (!allBidirectional && !allUndirected) return false;

  // Note: ovg_edge_router treats edges between tables columns as clusters so those are also included here
  // if edges are of the same cluster, bidirectional / undirected edges can overlap
  if (isClusterEdge) return true;

  // Note: assuming no self-loops here (node appears once per edge)
  const nodeCounts = new Map();
  const inc = (n) => nodeCounts.set(n, (nodeCounts.get(n) ?? 0) + 1);
  inc(edge.from);
  inc(edge.to);
  for (const otherEdge of otherEdges) {
    inc(otherEdge.from);
    inc(otherEdge.to);
  }
  // if all edges are connected to a shared node, then they can overlap without it becoming unclear which nodes are connected
  let hasSharedNode = false;
  const totalEdgeCount = otherEdges.length + 1;
  for (const count of nodeCounts.values()) {
    if (count === totalEdgeCount) {
      hasSharedNode = true;
      break;
    }
  }
  return hasSharedNode;
}

export function isVerticalOrHorizontalOverlap(start, end, otherStart, otherEnd) {
  const bothVertical = start.x === end.x && otherStart.x === otherEnd.x;
  const bothHorizontal = start.y === end.y && otherStart.y === otherEnd.y;
  if (bothVertical || bothHorizontal) {
    if (intersects(otherStart, otherEnd, start, end)) return true;
  }
  return false;
}

export function findOverlappingEdges(start, end, otherEdges) {
  const overlappingEdges = [];
  for (const e of otherEdges) {
    for (let i = 0; i < e.points.length - 1; i++) {
      if (isVerticalOrHorizontalOverlap(start, end, e.points[i], e.points[i + 1])) {
        overlappingEdges.push(e);
        break;
      }
    }
  }
  return overlappingEdges;
}

/** Returns [sourceClusterNodes, targetClusterNodes] (Map<Node, true>). */
export function sourceAndTargetClusterNodes(g, source, target) {
  const sourceClusterNodes = new Map();
  const targetClusterNodes = new Map();

  for (const key of g.clusterOrder()) {
    const cluster = g.clusters.get(key);
    let isSource = false;
    let isTarget = false;
    for (const clusterNode of cluster.nodes) {
      if (clusterNode === source) isSource = true;
      if (clusterNode === target) isTarget = true;
    }

    if (isSource) {
      for (const clusterNode of cluster.nodes) {
        if (clusterNode === source) continue;
        sourceClusterNodes.set(clusterNode, true);
      }
    }

    if (isTarget) {
      for (const clusterNode of cluster.nodes) {
        if (clusterNode === target) continue;
        targetClusterNodes.set(clusterNode, true);
      }
    }
  }
  return [sourceClusterNodes, targetClusterNodes];
}

/** return the length of the side of the node; if orientation is on a corner return whichever side is longer */
export function maxSideLength(node, orientation) {
  if (orientation === Orientation.Top || orientation === Orientation.Bottom) return node.width;
  if (orientation === Orientation.Left || orientation === Orientation.Right) return node.height;
  return Math.max(node.width, node.height);
}

/** true if angle between line and border (based on orientation) is less than min angle */
export function hasSharpAngleToBorder(fromPoint, toPoint, orientation) {
  if (orientation === Orientation.Top || orientation === Orientation.Bottom) {
    // border is to bottom / top
    const dx = toPoint.x - fromPoint.x;
    const dy = toPoint.y - fromPoint.y;
    let angle = Math.abs(180 * Math.atan2(dy, dx) / Math.PI);
    if (angle > 90) angle = 180 - angle;
    return angle < minStraightEdgeAngle;
  }
  if (orientation === Orientation.Left || orientation === Orientation.Right) {
    const dx = toPoint.x - fromPoint.x;
    const dy = toPoint.y - fromPoint.y;
    let angle = Math.abs(180 * Math.atan2(dx, dy) / Math.PI);
    if (angle > 90) angle = 180 - angle;
    return angle < minStraightEdgeAngle;
  }
  return false;
}
