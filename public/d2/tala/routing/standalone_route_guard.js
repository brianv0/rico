// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of the Go package d2layouts/d2talalayout/internal/routing (D2 v0.9.0), file(s): standalone_route_guard.go.
// (RouteWorkGuard.reserveSort, the first function of that file, is a method in route_stage_guard.js.)

import * as geo from '../../geo.js';
import * as label from '../../label.js';
import { sortSlice } from '../../gosort.js';
import { GoError } from '../goerrors.js';
import { PointMap, Node, Edges, isCandidateRejection } from '../layoutgraph.js';
import { RouteSearchWorkGuard } from './route_search_guard.js';
import { orientation } from './geometry.js';
import { nonNilEquals } from './ovg_edge.js';
import { estimateRouteCostGuarded } from './cluster_route_guard.js';
import { routeLineGuarded, edgeCanOverlapEdges, isVerticalOrHorizontalOverlap } from './route_line.js';
import { lowerJitterThreshold, nonOrthogonalFactor } from './tuning.js';
import { snapshotPointer } from './snapshot.js';
import { traceToShapeBorder } from './trace.js';

/** portEdgesGuarded(edges, node, guard): PointMap<Edge[]> */
export function portEdgesGuarded(edges, node, guard) {
  const portEdges = new PointMap();
  for (const edge of edges) {
    guard.step();
    let port;
    if (edge.from === node) port = edge.sourcePort();
    else if (edge.to === node) port = edge.targetPort();
    else continue;
    if (port !== null) {
      if (!portEdges.has(port)) portEdges.set(port, []);
      portEdges.get(port).push(edge);
    }
  }
  return portEdges;
}

export function edgeHasDuplicateInGuarded(edge, edges, guard) {
  for (const otherEdge of edges) {
    guard.step();
    if (otherEdge.isDuplicateOf(edge)) return true;
  }
  return false;
}

export function tryStraightEdgeFallbackGuarded(g, edge, guard) {
  guard.step();
  const originalCost = estimateRouteCostGuarded(g.edges, edge, guard);
  let fromPort, toPort, lineCost;
  try {
    [fromPort, toPort, lineCost] = routeLineGuarded(g, edge, g.edges, null, guard);
  } catch (err) {
    if (err instanceof GoError && isCandidateRejection(err)) {
      // A straight replacement is optional. Preserve the current route when no valid line exists.
      return;
    }
    throw err;
  }

  if (edge.points.length === 4 && geo.euclideanDistance(
    edge.points[1].x,
    edge.points[1].y,
    edge.points[2].x,
    edge.points[2].y,
  ) <= lowerJitterThreshold) {
    lineCost /= nonOrthogonalFactor;
  }
  guard.step();
  if (lineCost < originalCost) edge.points = [fromPort, toPort];
}

export function filterEdgeAncestorsGuarded(edge, nodes, guard) {
  const nonAncestors = [];
  for (const node of nodes) {
    guard.step();
    if (node !== edge.from && node !== edge.to && (edge.from.isDescendantOf(node) || edge.to.isDescendantOf(node))) continue;
    nonAncestors.push(node);
  }
  return nonAncestors;
}

/** Returns [sourceClusterNodes, targetClusterNodes] (Map<Node, true>, as Go's map[*Node]bool). */
export function sourceAndTargetClusterNodesGuarded(g, source, target, guard) {
  const sourceClusterNodes = new Map();
  const targetClusterNodes = new Map();

  for (const cluster of g.clusters.values()) {
    guard.step();
    let isSource = false;
    let isTarget = false;
    for (const clusterNode of cluster.nodes) {
      guard.step();
      if (clusterNode === source) isSource = true;
      if (clusterNode === target) isTarget = true;
    }
    if (isSource) {
      for (const clusterNode of cluster.nodes) {
        guard.step();
        if (clusterNode !== source) sourceClusterNodes.set(clusterNode, true);
      }
    }
    if (isTarget) {
      for (const clusterNode of cluster.nodes) {
        guard.step();
        if (clusterNode !== target) targetClusterNodes.set(clusterNode, true);
      }
    }
  }
  return [sourceClusterNodes, targetClusterNodes];
}

export function overlappingEdgesGuarded(start, end, otherEdges, guard) {
  const overlappingEdges = [];
  for (const edge of otherEdges) {
    guard.step();
    for (let index = 0; index < edge.points.length - 1; index++) {
      guard.step();
      if (isVerticalOrHorizontalOverlap(start, end, edge.points[index], edge.points[index + 1])) {
        overlappingEdges.push(edge);
        break;
      }
    }
  }
  return overlappingEdges;
}

export function edgeCanOverlapEdgesGuarded(edge, otherEdges, sourceClusterNodes, targetClusterNodes, guard) {
  if (otherEdges.length === 0) {
    // add(0) polls the context, so the general path below performs eleven identical polls before edgeCanOverlapEdges returns
    // true. A standard cancellable context exposes a Done signal, making one poll sufficient. Retain the legacy sequence for
    // synthetic contexts that expose cancellation only through Err.
    if (guard instanceof RouteSearchWorkGuard && guard.done) {
      guard.check();
      return true;
    }
  }
  // edgeCanOverlapEdges makes a bounded number of full passes over otherEdges. Reserve its worst-case comparisons before calling
  // it so ordinary output and unstable-order behavior remain byte-for-byte unchanged.
  for (let pass = 0; pass < 10; pass++) guard.add(otherEdges.length);
  guard.check();
  return edgeCanOverlapEdges(edge, otherEdges, sourceClusterNodes, targetClusterNodes);
}

/** positionedArrowheadLabelCostGuarded(positioned: PositionedArrowheadLabel, nodes, labels, routes, edges, guard) */
export function positionedArrowheadLabelCostGuarded(positioned, nodes, labels, routes, edges, guard) {
  for (const other of labels) {
    guard.step();
    if (positioned.edge === other.edge && positioned.isTarget === other.isTarget) continue;
    if (positioned.box.overlaps(other.box)) {
      if (positioned.text === other.text) continue;
      return Infinity;
    }
  }

  const graph = positioned.edge.from.graph;
  const fakeLabelNode = new Node();
  fakeLabelNode.box = positioned.box.copy();
  fakeLabelNode.graph = graph;
  let overlapCount = 0;
  for (const node of nodes) {
    guard.step();
    if (fakeLabelNode.labelBoxesOverlap(node, label.PADDING)) overlapCount++;
  }
  let penalty = 4 * graph.turnCostValue() * overlapCount;

  let overlappingEdgeCount = 0;
  for (const route of routes ?? []) {
    guard.step();
    if (route.gEdge === positioned.edge) continue;
    for (let index = 1; index < route.ovgNodes.length; index++) {
      guard.step();
      if (fakeLabelNode.overlapsLine(route.ovgNodes[index - 1].point, route.ovgNodes[index].point, 0)) {
        overlappingEdgeCount++;
        break;
      }
    }
  }
  for (const edge of edges ?? []) {
    guard.step();
    if (edge === positioned.edge) continue;
    for (let index = 1; index < edge.points.length; index++) {
      guard.step();
      if (fakeLabelNode.overlapsLine(edge.points[index - 1], edge.points[index], 0)) {
        overlappingEdgeCount++;
        break;
      }
    }
  }
  penalty += graph.turnCostValue() * overlappingEdgeCount;
  return penalty;
}

export function edgeIsStraightGuarded(edge, guard) {
  if (edge.points.length < 2) {
    guard.step();
    return false;
  }
  let first = edge.points[0];
  let second = edge.points[1];
  for (let index = 2; index < edge.points.length; index++) {
    guard.step();
    if (orientation(first, second, edge.points[index]) !== 0) return false;
    first = second;
    second = edge.points[index];
  }
  return true;
}

export function edgeHasOverlappingEndGuarded(edge, guard) {
  const start = edge.points[0];
  const end = edge.points[edge.points.length - 1];
  for (const fromEdge of edge.from.edges) {
    guard.step();
    if (fromEdge !== edge && (nonNilEquals(fromEdge.points[0], start) || nonNilEquals(fromEdge.points[fromEdge.points.length - 1], start))) return true;
  }
  for (const toEdge of edge.to.edges) {
    guard.step();
    if (toEdge !== edge && (nonNilEquals(toEdge.points[0], end) || nonNilEquals(toEdge.points[toEdge.points.length - 1], end))) return true;
  }
  return false;
}

export function reorderDuplicatesInEdgesGuarded(edges, guard) {
  for (const edge of edges) {
    guard.step();
    if (edge.hasTableColumn() || edge.label === null) continue;
    const straight = edgeIsStraightGuarded(edge, guard);
    if (!straight) continue;
    const hasOverlappingEnd = edgeHasOverlappingEndGuarded(edge, guard);

    const duplicates = [];
    for (let index = 0; index < edges.length; index++) {
      const other = edges[index];
      guard.step();
      if (other === edge || !other.isDuplicateOf(edge)) continue;
      const otherStraight = edgeIsStraightGuarded(other, guard);
      if (!otherStraight) continue;
      let otherHasOverlappingEnd = false;
      if (hasOverlappingEnd) otherHasOverlappingEnd = true;
      else otherHasOverlappingEnd = edgeHasOverlappingEndGuarded(other, guard);
      if (otherHasOverlappingEnd) {
        let sourceArrow = edge.sourceArrowhead;
        let targetArrow = edge.targetArrowhead;
        if (other.from === edge.to) {
          const t = sourceArrow; sourceArrow = targetArrow; targetArrow = t;
        }
        if (other.targetArrowhead === targetArrow && other.sourceArrowhead === sourceArrow) duplicates.push(index);
      } else {
        duplicates.push(index);
      }
    }

    if (duplicates.length <= 1) continue;
    const start = edge.points[0];
    const end = edge.points[edge.points.length - 1];
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const sourceOrder = [edge];
    const targetOrder = [edge];
    for (const index of duplicates) {
      guard.step();
      sourceOrder.push(edges[index]);
      targetOrder.push(edges[index]);
    }

    guard.reserveSort(sourceOrder.length);
    guard.reserveSort(targetOrder.length);
    if (dy > dx) {
      sortSlice(sourceOrder, (i, j) => sourceOrder[i].points[0].x < sourceOrder[j].points[0].x);
      sortSlice(targetOrder, (i, j) => {
        const left = targetOrder[i], right = targetOrder[j];
        return left.points[left.points.length - 1].x < right.points[right.points.length - 1].x;
      });
    } else {
      sortSlice(sourceOrder, (i, j) => sourceOrder[i].points[0].y < sourceOrder[j].points[0].y);
      sortSlice(targetOrder, (i, j) => {
        const left = targetOrder[i], right = targetOrder[j];
        return left.points[left.points.length - 1].y < right.points[right.points.length - 1].y;
      });
    }

    let consistentOrder = true;
    for (let index = 0; index < sourceOrder.length; index++) {
      guard.step();
      if (sourceOrder[index] !== targetOrder[index]) {
        consistentOrder = false;
        break;
      }
    }
    if (!consistentOrder) continue;
    let currentIndex = -1;
    for (let index = 0; index < sourceOrder.length; index++) {
      guard.step();
      if (sourceOrder[index] === edge) {
        currentIndex = index;
        break;
      }
    }
    if (currentIndex === 0 || currentIndex === sourceOrder.length - 1) continue;
    const first = sourceOrder[0];
    const last = sourceOrder[sourceOrder.length - 1];
    if (first.label !== null && last.label !== null) continue;
    guard.step();

    if (last.label === null) {
      const t = edge.points; edge.points = last.points; last.points = t;
      if (last.from === edge.to) {
        reverseEdgeRouteGuarded(edge, guard);
        reverseEdgeRouteGuarded(last, guard);
      }
    } else if (first.label === null) {
      const t = edge.points; edge.points = first.points; first.points = t;
      if (first.from === edge.to) {
        reverseEdgeRouteGuarded(edge, guard);
        reverseEdgeRouteGuarded(first, guard);
      }
    }
  }
  guard.finish();
}

export function reverseEdgeRouteGuarded(edge, guard) {
  for (let left = 0, right = edge.points.length - 1; left < right; left++, right--) {
    guard.step();
    const t = edge.points[left]; edge.points[left] = edge.points[right]; edge.points[right] = t;
  }
}

export function traceToShapeBorderGuarded(edge, guard) {
  guard.step();
  if (edge === null || edge.from === null || edge.to === null || edge.points.length < 2) return;
  const fromPosition = snapshotPointer(edge.from.topLeft);
  const toPosition = snapshotPointer(edge.to.topLeft);
  try {
    traceToShapeBorder(edge);
  } catch (recovered) {
    if (recovered instanceof GoError) throw recovered; // a returned error never reaches Go's recover
    edge.from.topLeft = fromPosition.restore();
    edge.to.topLeft = toPosition.restore();
    throw recovered;
  }
  guard.step();
}

export { Edges };
