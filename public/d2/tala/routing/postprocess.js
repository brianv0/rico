// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of the Go package d2layouts/d2talalayout/internal/routing (D2 v0.9.0), file(s): postprocess.go (BalanceEdgeSegments,
// FixClusterEdgeBranching).
//
// Go keys `lockedEdgeSegments` by the EdgeSegment VALUE (two point pointers and the edge pointer): here by the identities of those three
// objects (`segmentKey`). `segmentRanges` is keyed by the Range value (start, end floats).

import { DIAMOND_TYPE } from '../../shape.js';
import { goRound } from '../../gomath.js';
import { errorf } from '../goerrors.js';
import { Row, Column } from '../layoutgraph.js';
import { maxRouteStageWorkUnits } from './route_limits.js';
import { runAtomicRouteStage } from './route_stage_atomic.js';
import { stableSortRouteValues } from './route_stage_guard.js';
import { segmentSpacingBuffer, unboundedSegmentMove } from './tuning.js';
import { Range } from './tunnel.js';
import { estimateRouteCostGuarded, routeIntersectsNodeGuarded } from './cluster_route_guard.js';
import {
  removeDuplicatePointsGuarded, nodeSegmentsGuarded, edgeSegmentsGuarded, routeSegmentBounds, evenlyDistributeGuarded,
  checkBalanceOrder, balanceOrderPreserved, balanceOrderReversed, balanceOrderContactChanged,
} from './balance_route_guard.js';
import { balanceReversalRemovesCrossings } from './balance_crossings.js';
import { hasFixedBalancingPorts, balancePortInteriorsGuarded } from './port_interior_balance.js';

export function balanceEdgeSegments(ctx, g) {
  balanceEdgeSegmentsWithLimit(ctx, g, maxRouteStageWorkUnits);
}

export function balanceEdgeSegmentsWithLimit(ctx, g, workLimit) {
  runAtomicRouteStage(ctx, 'BalanceEdgeSegments', g, null, workLimit, (guard) => {
    balanceEdgeSegmentsGuarded(g, guard);
  });
}

export function balanceEdgeSegmentsGuarded(g, guard) {
  // Special nodes get special routing, don't mess with them
  const specialEdges = [];
  const regularEdges = [];
  for (const e of g.edges) {
    guard.step();
    if (e.points.length < 2) throw errorf(`TALA BalanceEdgeSegments edge ${e.idValue()} has an incomplete route`);
    if (isSpecialEdgeForBalancing(g, e)) {
      specialEdges.push(e);
      continue;
    }
    regularEdges.push(e);
  }

  balanceRegularEdgesGuarded(g, specialEdges, regularEdges, guard);
  balancePortInteriorsGuarded(g, guard);
}

/** isSpecialEdgeForBalancing identifies routes whose ports or rule-generated geometry balancing must leave unchanged. */
export function isSpecialEdgeForBalancing(g, e) {
  if (g.nodeToTree !== null && g.nodeToTree.has(e.from)) return true;
  if (g.nodeToTree !== null && g.nodeToTree.has(e.to)) return true;
  if (e.hasTableColumn() || e.isLoop()) return true;
  // We want edges locked to diamond ports strictly.
  if (e.from.shape.getType() === DIAMOND_TYPE || e.to.shape.getType() === DIAMOND_TYPE) return true;
  // When node A (width even) aligns with node B (width odd), the centers can end up misaligned by 1.
  const first = e.points[0];
  const last = e.points[e.points.length - 1];
  return Math.abs(first.x - last.x) === 1 || Math.abs(first.y - last.y) === 1;
}

// identities for segmentKey (point objects and edges)
const objectIDs = new WeakMap();
let nextObjectID = 1;
function objectID(o) {
  let id = objectIDs.get(o);
  if (id === undefined) {
    id = nextObjectID++;
    objectIDs.set(o, id);
  }
  return id;
}

/** the identity of an EdgeSegment value: Go compares the struct (Start and End pointers, owning edge) */
const segmentKey = (s) => `${objectID(s.Start)}:${objectID(s.End)}:${objectID(s.edge)}`;

export function balanceRegularEdgesGuarded(g, specialEdges, regularEdges, guard) {
  // Row and diamond ports fix the endpoint and its short approach segment, while longer interior corridors can still be balanced.
  const fixedPortPoints = new Set();
  for (const edge of regularEdges) {
    guard.step();
    if (!hasFixedBalancingPorts(edge)) continue;
    for (const point of edge.points.slice(0, Math.min(2, edge.points.length))) fixedPortPoints.add(point);
    for (const point of edge.points.slice(Math.max(0, edge.points.length - 2))) fixedPortPoints.add(point);
  }
  const isConnectedToUnitNode = (point) => {
    for (const node of g.nodes) {
      guard.step();
      if (node.width === 1 && node.height === 1) {
        // Check if point is on the node's border
        if ((point.x === node.topLeft.x || point.x === node.topLeft.x + 1) && (point.y === node.topLeft.y || point.y === node.topLeft.y + 1)) {
          return true;
        }
      }
    }
    return false;
  };

  const getSharedCluster = (edgeA, edgeB) => {
    const fromA = edgeA.from.cluster;
    const toA = edgeA.to.cluster;

    const fromB = edgeB.from.cluster;
    const toB = edgeB.to.cluster;
    if (fromA !== null && (fromA === fromB || fromA === toB)) return fromA;
    if (toA !== null && (toA === fromB || toA === toB)) return toA;
    return null;
  };

  const eq = (a, b) => Math.abs(a - b) <= 1;

  for (const isHorizontal of [true, false]) {
    const lockedSegments = nodeSegmentsGuarded(g.nodes, !isHorizontal, guard);
    const lockedEdgeSegments = new Map(); // segmentKey -> true
    // When we balance vertical segments horizontally, we get the vertical segments
    const allEdgeSegments = edgeSegmentsGuarded(regularEdges, !isHorizontal, guard);

    const edgeSegments = [];
    const fixedSegments = [];
    for (const segment of allEdgeSegments) {
      if (fixedPortPoints.has(segment.Start) || fixedPortPoints.has(segment.End)) {
        fixedSegments.push(segment);
        continue;
      }
      const startConnected = isConnectedToUnitNode(segment.Start);
      const endConnected = isConnectedToUnitNode(segment.End);
      if (!startConnected && !endConnected) edgeSegments.push(segment);
    }
    // Special edges shouldn't be moved, but they're still considered for bounds checking
    const specialEdgeSegments = fixedSegments;
    const guardedSpecialEdgeSegments = edgeSegmentsGuarded(specialEdges, !isHorizontal, guard);
    for (const specialEdgeSegment of guardedSpecialEdgeSegments) {
      guard.step();
      specialEdgeSegments.push(specialEdgeSegment);
    }
    // Regular edges shared with special edges should also be locked
    for (const s of edgeSegments) {
      for (const ses of specialEdgeSegments) {
        guard.step();
        if (!s.overlaps(ses, isHorizontal, 1)) continue;
        if (isHorizontal) {
          if (eq(s.Start.x, ses.Start.x)) {
            specialEdgeSegments.push(s);
            lockedEdgeSegments.set(segmentKey(s), true);
            break;
          }
        } else if (eq(s.Start.y, ses.Start.y)) {
          specialEdgeSegments.push(s);
          lockedEdgeSegments.set(segmentKey(s), true);
          break;
        }
      }
    }
    for (const s of specialEdgeSegments) lockedSegments.push(s);
    while (lockedEdgeSegments.size !== edgeSegments.length) {
      guard.step();
      let minRange = new Range(-Infinity, Infinity);
      const segmentRanges = new Map(); // `${start},${end}` -> EdgeSegment[]

      for (const es of edgeSegments) {
        guard.step();
        if (lockedEdgeSegments.has(segmentKey(es))) continue;
        let [floor, ceil] = routeSegmentBounds(es, lockedSegments, segmentSpacingBuffer, guard);
        if (isHorizontal) {
          if (floor === -Infinity) floor = es.Start.x - unboundedSegmentMove;
          if (ceil === Infinity) ceil = es.Start.x + unboundedSegmentMove;
        } else {
          if (floor === -Infinity) floor = es.Start.y - unboundedSegmentMove;
          if (ceil === Infinity) ceil = es.Start.y + unboundedSegmentMove;
        }

        const movementRange = new Range(floor, ceil);

        const rangeKey = `${movementRange.start},${movementRange.end}`;
        const bucket = segmentRanges.get(rangeKey);
        if (bucket === undefined) segmentRanges.set(rangeKey, [es]);
        else bucket.push(es);
        if (movementRange.length() < minRange.length()) minRange = movementRange;
      }

      // For all the segments which share the same min range, we want to further split them up by overlap
      // E.g. if two segments don't overlap, they can both take the 50% point between its range
      // But if they overlap, they share the same space, so have to evenly distribute at 33% and 66% points
      for (const s of segmentRanges.get(`${minRange.start},${minRange.end}`) ?? []) {
        guard.step();
        if (lockedEdgeSegments.has(segmentKey(s))) continue;
        const balanceBatch = [s];
        const balanceBatchSet = new Set([s]);
        for (const otherS of segmentRanges.get(`${minRange.start},${minRange.end}`) ?? []) {
          guard.step();
          if (s === otherS) continue;
          if (lockedEdgeSegments.has(segmentKey(otherS))) continue;
          let buffer = segmentSpacingBuffer;
          // Segments of the same edge don't need to maintain a buffer from each other
          if (s.owner() === otherS.owner()) buffer = 0;
          if (s.overlaps(otherS, isHorizontal, buffer)) {
            balanceBatch.push(otherS);
            balanceBatchSet.add(otherS);
          }
        }
        // Even if the same range is not shared, if a segment shares a route with another segment (even partially), it should be balanced
        // together to maintain shared route
        for (const otherS of edgeSegments) {
          guard.step();
          if (balanceBatchSet.has(otherS)) continue;
          if (lockedEdgeSegments.has(segmentKey(otherS))) continue;
          const cluster = getSharedCluster(s.owner(), otherS.owner());
          if (cluster !== null && cluster.arrangement === cluster.desiredArrangement) {
            // we usually want to balance cluster edge segments normally, but we want to balance cluster mid-segments in a combined range
            let shouldBalanceTogether;
            if (isHorizontal) shouldBalanceTogether = cluster.arrangement === Column && eq(s.Start.x, otherS.Start.x);
            else shouldBalanceTogether = cluster.arrangement === Row && eq(s.Start.y, otherS.Start.y);
            if (shouldBalanceTogether) {
              balanceBatch.push(otherS);
              balanceBatchSet.add(otherS);
              continue;
            }
          }
          if (!s.overlaps(otherS, isHorizontal, 1)) continue;
          let shared;
          if (isHorizontal) shared = eq(s.Start.x, otherS.Start.x);
          else shared = eq(s.Start.y, otherS.Start.y);
          if (shared) {
            balanceBatch.push(otherS);
            balanceBatchSet.add(otherS);
          }
        }
        stableSortRouteValues(balanceBatch, (a, b) => {
          let primaryDimensionI, primaryDimensionJ;
          let secondaryDimensionI, secondaryDimensionJ;
          if (isHorizontal) {
            primaryDimensionI = a.Start.x;
            primaryDimensionJ = b.Start.x;
            secondaryDimensionI = a.Start.y;
            secondaryDimensionJ = b.Start.y;
          } else {
            primaryDimensionI = a.Start.y;
            primaryDimensionJ = b.Start.y;
            secondaryDimensionI = a.Start.x;
            secondaryDimensionJ = b.Start.x;
          }
          if (primaryDimensionI === primaryDimensionJ) return secondaryDimensionI < secondaryDimensionJ;
          return primaryDimensionI < primaryDimensionJ;
        }, guard);
        // Among the overlapping segments, some may be on shared routes. They're shared intentionally, so we want to keep them shared.
        const distincts = new Set();
        for (const bs of balanceBatch) {
          guard.step();
          if (isHorizontal) distincts.add(goRound(bs.Start.x));
          else distincts.add(goRound(bs.Start.y));
        }

        // Now we take the overlapping segments with the same range of movement, and rebalance them
        const distributionVals = evenlyDistributeGuarded(minRange.start, minRange.end, distincts.size, guard);
        const proposed = new Array(balanceBatch.length);
        for (let i = 0; i < balanceBatch.length; i++) {
          const segment = balanceBatch[i];
          guard.step();
          proposed[i] = segment.Start.y;
          if (isHorizontal) proposed[i] = segment.Start.x;
        }

        for (let valIndex = 0, segmentIndex = 0; valIndex < distributionVals.length; valIndex++) {
          guard.step();
          let sharedCount = 0;
          while (segmentIndex + sharedCount < balanceBatch.length) {
            guard.step();
            if (isHorizontal) {
              if (eq(balanceBatch[segmentIndex].Start.x, balanceBatch[segmentIndex + sharedCount].Start.x)) sharedCount++;
              else break;
            } else if (eq(balanceBatch[segmentIndex].Start.y, balanceBatch[segmentIndex + sharedCount].Start.y)) {
              sharedCount++;
            } else {
              break;
            }
          }

          const val = distributionVals[valIndex];
          for (let i = segmentIndex; i < segmentIndex + sharedCount; i++) {
            guard.step();
            proposed[i] = val;
          }
          segmentIndex += sharedCount;
        }
        let order = checkBalanceOrder(balanceBatch, balanceBatchSet, allEdgeSegments, proposed, isHorizontal, guard);
        if (order !== balanceOrderContactChanged) {
          const specialOrder = checkBalanceOrder(balanceBatch, balanceBatchSet, guardedSpecialEdgeSegments, proposed, isHorizontal, guard);
          order = Math.max(order, specialOrder);
        }
        let accept = order === balanceOrderPreserved;
        if (order === balanceOrderReversed) {
          accept = balanceReversalRemovesCrossings(g, balanceBatch, proposed, isHorizontal, guard);
        }
        if (accept) {
          for (let i = 0; i < balanceBatch.length; i++) {
            const segment = balanceBatch[i];
            guard.step();
            if (isHorizontal) {
              segment.Start.x = proposed[i];
              segment.End.x = proposed[i];
            } else {
              segment.Start.y = proposed[i];
              segment.End.y = proposed[i];
            }
          }
        }
        for (const bs of balanceBatch) {
          guard.step();
          lockedEdgeSegments.set(segmentKey(bs), true);
          lockedSegments.push(bs);
        }
      }
    }
  }
  for (const e of regularEdges) {
    e.points = removeDuplicatePointsGuarded(e.points, guard);
  }
}

/** FixClusterEdgeBranching resolves route branching at cluster boundaries. */
export function fixClusterEdgeBranching(ctx, g) {
  fixClusterEdgeBranchingWithLimit(ctx, g, maxRouteStageWorkUnits);
}

export function fixClusterEdgeBranchingWithLimit(ctx, g, workLimit) {
  runAtomicRouteStage(ctx, 'FixClusterEdgeBranching', g, null, workLimit, (guard) => {
    fixClusterEdgeBranchingGuarded(g, guard);
  });
}

export function fixClusterEdgeBranchingGuarded(g, guard) {
  for (const n of g.nodes) {
    guard.step();
    if (n.edges.length <= 1) continue;
    if (n.cluster !== null) continue;
    const isFrom = new Map();
    const clusterEdges = new Map();
    for (const e of n.edges) {
      guard.step();
      if (e.points.length !== 4) continue;
      const adj = n.adjacent(e);
      if (adj.cluster !== null) {
        if (adj.cluster.desiredArrangement !== adj.cluster.arrangement) continue;
        if (e.from === n) isFrom.set(adj.cluster, true);
        else isFrom.set(adj.cluster, false);
        if (!clusterEdges.has(adj.cluster)) clusterEdges.set(adj.cluster, [e]);
        else clusterEdges.get(adj.cluster).push(e);
      }
    }

    for (const [cluster, edges] of clusterEdges) {
      guard.step();
      let backOfCenterFound = false;
      let frontOfCenterFound = false;
      for (const e of edges) {
        guard.step();
        if (cluster.arrangement === Row) {
          if (isFrom.get(cluster)) {
            if (e.points[3].x < e.points[0].x) backOfCenterFound = true;
            if (e.points[3].x > e.points[0].x) frontOfCenterFound = true;
          } else {
            if (e.points[0].x < e.points[3].x) backOfCenterFound = true;
            if (e.points[0].x > e.points[3].x) frontOfCenterFound = true;
          }
        } else if (isFrom.get(cluster)) {
          if (e.points[3].y < e.points[0].y) backOfCenterFound = true;
          if (e.points[3].y > e.points[0].y) frontOfCenterFound = true;
        } else {
          if (e.points[0].y < e.points[3].y) backOfCenterFound = true;
          if (e.points[0].y > e.points[3].y) frontOfCenterFound = true;
        }
      }
      if (!backOfCenterFound || !frontOfCenterFound) continue;

      const originalP1 = new Map();
      const originalP2 = new Map();
      const potentialMovePoints = [];
      for (const e of edges) {
        guard.step();
        if (isFrom.get(cluster)) potentialMovePoints.push(e.points[1]);
        else potentialMovePoints.push(e.points[2]);
        originalP1.set(e, e.points[1].copy());
        originalP2.set(e, e.points[2].copy());
      }

      let bestPoint = null;
      let bestPointCost = 0;

      OUTER:
      for (const p of potentialMovePoints) {
        guard.step();
        for (const e of edges) {
          guard.step();
          e.points[1] = originalP1.get(e).copy();
          e.points[2] = originalP2.get(e).copy();
        }
        let cost = 0.0;
        for (const e of edges) {
          guard.step();
          const originalCost = estimateRouteCostGuarded(g.edges, e, guard);
          if (isFrom.get(cluster)) {
            if (e.points[1] === p) {
              cost += originalCost;
              continue;
            }
          } else if (e.points[2] === p) {
            cost += originalCost;
            continue;
          }
          if (isFrom.get(cluster)) {
            e.points[1] = p.copy();
            if (cluster.arrangement === Row) e.points[2].y = p.y;
            else e.points[2].x = p.x;
          } else {
            e.points[2] = p.copy();
            if (cluster.arrangement === Row) e.points[1].y = p.y;
            else e.points[1].x = p.x;
          }

          let revert = false;
          const intersectsNode = routeIntersectsNodeGuarded(g.nodes, e, guard);
          if (intersectsNode) revert = true;
          if (!revert) {
            const newCost = estimateRouteCostGuarded(g.edges, e, guard);
            cost += newCost;
            if (newCost > originalCost) revert = true;
          }
          if (revert) continue OUTER;
        }
        if (bestPoint === null || cost < bestPointCost) {
          bestPoint = p;
          bestPointCost = cost;
        }
      }

      for (const e of edges) {
        guard.step();
        e.points[1] = originalP1.get(e).copy();
        e.points[2] = originalP2.get(e).copy();
      }

      if (bestPoint !== null) {
        for (const e of edges) {
          guard.step();
          if (isFrom.get(cluster)) {
            e.points[1] = bestPoint.copy();
            if (cluster.arrangement === Row) e.points[2].y = bestPoint.y;
            else e.points[2].x = bestPoint.x;
          } else {
            e.points[2] = bestPoint.copy();
            if (cluster.arrangement === Row) e.points[1].y = bestPoint.y;
            else e.points[1].x = bestPoint.x;
          }
        }
      }
    }
  }

  guard.finish();
}
