// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of the Go package d2layouts/d2talalayout/internal/routing (D2 v0.9.0), file(s): swap_ports.go (SwapAllEdgePorts, the
// SwapEdgePorts stage).
//
// `map[geo.Orientation][]*Edge` is a Map keyed by the orientation number; `map[geo.Point]T` is a layoutgraph PointMap. Go ranges over
// the orientation map in random order: the orientations touch disjoint edges and only read node geometry, so the result does not
// depend on it (Map insertion order here).

import * as geo from '../../geo.js';
import { errorf } from '../goerrors.js';
import { PointMap } from '../layoutgraph.js';
import { maxRouteStageWorkUnits } from './route_limits.js';
import { runAtomicRouteStage } from './route_stage_atomic.js';
import { stableSortRouteValues } from './route_stage_guard.js';
import { pathNodeProximityFloor } from './tuning.js';
import { segmentIntersectsBox } from './geometry.js';
import { tunnelRangesBetweenGuarded } from './tunnel.js';

const { Orientation } = geo;

/**
 * SwapAllEdgePorts applies port swapping to every node under one atomic route-stage budget and rollback boundary.
 */
export function swapAllEdgePorts(ctx, graph) {
  swapAllEdgePortsWithWorkLimit(ctx, graph, maxRouteStageWorkUnits);
}

/** swapAllEdgePortsWithWorkLimit is SwapAllEdgePorts with an explicit budget for deterministic resource-boundary tests inside TALA. */
export function swapAllEdgePortsWithWorkLimit(ctx, graph, workLimit) {
  runAtomicRouteStage(ctx, 'SwapEdgePorts', graph, null, workLimit, (guard) => {
    for (const node of graph.nodes) {
      guard.step();
      swapEdgePortsGuarded(node, guard);
    }
  });
}

export function swapEdgePortsGuarded(n, guard) {
  const orientationToEdges = new Map();
  const portToEdges = new PointMap();
  for (const e of n.edges) {
    guard.step();
    // TODO: remove `len(e.Points) < 3` and handle straight edges
    if (e.isLoop() || e.points.length < 3 || e.hasTableColumn()) continue;
    if (e.hasLargeArrowheadLabel()) continue;
    const [p1, p2] = pointsAt(e, n);
    let o;
    if (p1.x < p2.x) o = Orientation.Right;
    else if (p1.x > p2.x) o = Orientation.Left;
    else if (p1.y < p2.y) o = Orientation.Bottom;
    else o = Orientation.Top;
    if (!orientationToEdges.has(o)) orientationToEdges.set(o, []);
    orientationToEdges.get(o).push(e);
    const list = portToEdges.get(p1);
    if (list === undefined) portToEdges.set(p1, [e]);
    else list.push(e);
  }

  const swappedSameSide = swapEdgesOnSameSide(n, orientationToEdges, portToEdges, guard);
  const swappedAdjacentSides = swapEdgesOnAdjacentSides(n, orientationToEdges, portToEdges, guard);

  return swappedAdjacentSides || swappedSameSide;
}

/** swapEdgesOnSameSide swaps edges on the same node side if they can be swapped */
export function swapEdgesOnSameSide(n, orientationToEdges, portToEdges, guard) {
  let swapped = false;
  for (const [o, edges] of orientationToEdges) {
    guard.step();
    // sorts by orientation
    if (geo.isVertical(o)) {
      stableSortRouteValues(edges, (a, b) => {
        const [p1, , p3] = pointsAt(a, n);
        const [q1, , q3] = pointsAt(b, n);
        if (p1.x === q1.x) return p3.x < q3.x;
        return p1.x < q1.x;
      }, guard);
    } else {
      stableSortRouteValues(edges, (a, b) => {
        const [p1, , p3] = pointsAt(a, n);
        const [q1, , q3] = pointsAt(b, n);
        if (p1.y === q1.y) return p3.y < q3.y;
        return p1.y < q1.y;
      }, guard);
    }
    for (let i = 0; i < edges.length - 1; i++) {
      guard.step();
      if (edgesIntersect(edges[i], edges[i + 1], n, o) && canSwapPorts(edges[i], edges[i + 1], n, portToEdges)) {
        const [p1, p2] = pointsAt(edges[i], n);
        const [q1, q2] = pointsAt(edges[i + 1], n);
        swapCoordinate(p1, q1, o);
        swapCoordinate(p2, q2, o);
        const doesNotPass = doesNotPassThroughNodesGuarded(n.graph, [n], p1, p2, q1, q2, guard);
        if (doesNotPass) {
          [edges[i], edges[i + 1]] = [edges[i + 1], edges[i]];
          swapped = true;
        } else {
          swapCoordinate(p1, q1, o);
          swapCoordinate(p2, q2, o);
        }
      }
    }
  }
  return swapped;
}

/** pointsAt returns the points composing the two segments starting at n. */
export function pointsAt(e, n) {
  if (e.from === n) return [e.points[0], e.points[1], e.points[2]];
  return [e.points[e.points.length - 1], e.points[e.points.length - 2], e.points[e.points.length - 3]];
}

/** swapCoordinate swaps the coordinate (x/y) opposite to the given orienation, e.g., if `o` is vertical, swaps x */
export function swapCoordinate(p, q, o) {
  if (geo.isVertical(o)) [p.x, q.x] = [q.x, p.x];
  else [p.y, q.y] = [q.y, p.y];
}

export function doesNotPassThroughNodesGuarded(g, ns, p1, p2, q1, q2, guard) {
  OUTER:
  for (const node of g.nodes) {
    guard.step();
    for (const n of ns) {
      guard.step();
      if (node === n || n.isDescendantOf(node)) continue OUTER;
    }
    const pad = 2 * pathNodeProximityFloor;
    const paddedBox = geo.newBox(
      geo.newPoint(node.box.TopLeft.x - pad, node.box.TopLeft.y - pad),
      node.box.Width + pad * 2,
      node.box.Height + pad * 2,
    );
    if (segmentIntersectsBox(p1, p2, paddedBox) || segmentIntersectsBox(q1, q2, paddedBox)) return false;
  }
  return true;
}

/** edgesIntersect checks if the given edges intersect at `n` */
export function edgesIntersect(e1, e2, n, o) {
  const [p1, p2, p3] = pointsAt(e1, n);
  const [q1, q2, q3] = pointsAt(e2, n);
  switch (o) {
    case Orientation.Left: {
      const bottomIntersection = q2.x < p2.x && p3.y > q1.y;
      const topIntersection = p2.x < q2.x && q3.y < p1.y;
      return topIntersection || bottomIntersection;
    }
    case Orientation.Bottom: {
      const leftIntersection = p2.y > q2.y && q3.x < p1.x;
      const rightIntersection = q2.y > p2.y && p3.x > q1.x;
      return leftIntersection || rightIntersection;
    }
    case Orientation.Top: {
      const leftIntersection = p2.y < q2.y && q3.x < p1.x;
      const rightIntersection = q2.y < p2.y && p3.x > q1.x;
      return leftIntersection || rightIntersection;
    }
    case Orientation.Right: {
      const topIntersection = p2.x > q2.x && q3.y < p1.y;
      const bottomIntersection = q2.x > p2.x && p3.y > q1.y;
      return topIntersection || bottomIntersection;
    }
  }
  return false;
}

/**
 * canSwapPorts checks if the ports of the given edges can be swapped: ports can be swapped if they have only 1 edge each, or if they are
 * shared, if the edges have the same arrowhead
 */
export function canSwapPorts(e1, e2, n, portToEdges) {
  const [p1] = pointsAt(e1, n);
  const [p2] = pointsAt(e2, n);

  if ((portToEdges.get(p1) ?? []).length === 1 && (portToEdges.get(p2) ?? []).length === 1) {
    // only one edge at each port, so arrowheads don't matter
    return true;
  }

  // check if they have the same arrowheads
  const p1Arrowhead = e1.arrowheadTo(n);
  const p2Arrowhead = e2.arrowheadTo(n);
  return p1Arrowhead === p2Arrowhead;
}

export function refineEdgeGuarded(g, e, guard) {
  guard.step();
  if (e.isLoop() || e.points.length <= 2 || e.isBetweenTableColumns() || e.isTreeEdge()) return false;
  const occupiedPorts = occupiedPortsGuarded(e.from, guard);
  const toPorts = occupiedPortsGuarded(e.to, guard);
  for (const [port] of toPorts.entries()) {
    guard.step();
    occupiedPorts.set(port, true);
  }

  if (isEdgeSShaped(e)) {
    return makeStraightLineGuarded(g, e, occupiedPorts, guard);
  } else if (isEdgeLShaped(e)) {
    return makeStraightLineGuarded(g, e, occupiedPorts, guard);
  } else if (isEdgeUShaped(e)) {
    return false;
  }

  let swapped = false;
  if (isSShaped(e.points.slice(0, 4))) {
    // the first 3 segments are S shaped, try to turn them into L shaped
    const p = sToLShapedBendPoint(e.points.slice(0, 4));
    const doesNotPass = doesNotPassThroughNodesGuarded(g, [e.from, e.to], e.points[0], p, p, e.points[3], guard);
    if (doesNotPass) {
      removeEdgePointsGuarded(e, guard, 1, 2, 3);
      insertEdgePointGuarded(e, p, 1, guard);
      swapped = true;
    }
  }

  return swapped;
}

/** the set of ports (PointMap point -> true) */
export function occupiedPortsGuarded(n, guard) {
  const ports = new PointMap();
  for (const e of n.edges) {
    guard.step();
    if (e.from === n) ports.set(e.sourcePort(), true);
    else ports.set(e.targetPort(), true);
  }
  return ports;
}

export function makeStraightLineGuarded(g, e, occupiedPorts, guard) {
  const fromPort = e.sourcePort();
  const toPort = e.targetPort();
  const step = pathNodeProximityFloor;
  const [ranges, isHorizontal] = tunnelRangesBetweenGuarded(g, e.from, e.to, false, guard);
  for (const r of ranges ?? []) {
    guard.step();
    // avoid having edges alined with the node boundaries
    for (let v = r.start + step; v <= r.end - step; v += step) {
      guard.step();
      let from, to;
      if (isHorizontal) {
        from = geo.newPoint(fromPort.x, v);
        to = geo.newPoint(toPort.x, v);
      } else {
        from = geo.newPoint(v, fromPort.y);
        to = geo.newPoint(v, toPort.y);
      }
      if (occupiedPorts.has(from)) continue;
      if (occupiedPorts.has(to)) continue;
      // the ports are free and tunnels ensure there's no node in between so we can make this edge a straight line
      e.points = [from, to];
      return true;
    }
  }
  return false;
}

/** sToLShapedBendPoint returns the bend point that transforms an S-shaped route into an L-shaped route. */
export function sToLShapedBendPoint(ps) {
  if (ps[0].x === ps[1].x) {
    // vertical
    return geo.newPoint(ps[1].x, ps[3].y);
  }
  return geo.newPoint(ps[3].x, ps[1].y);
}

export function isEdgeUShaped(e) {
  return isUShaped(e.points);
}

export function isEdgeSShaped(e) {
  return isSShaped(e.points);
}

export function isSShaped(ps) {
  return ps.length === 4 && !isUShaped(ps);
}

export function isUShaped(ps) {
  if (ps.length !== 4) return false;

  if (ps[0].x === ps[1].x) {
    const sameDirection = geo.sign(ps[0].y - ps[1].y) === geo.sign(ps[3].y - ps[2].y);
    const isHorizontal = ps[1].y === ps[2].y;
    return sameDirection && isHorizontal;
  }

  const sameDirection = geo.sign(ps[0].x - ps[1].x) === geo.sign(ps[3].x - ps[2].x);
  const isVertical = ps[1].x === ps[2].x;
  return sameDirection && isVertical;
}

export function isEdgeLShaped(e) {
  return isLShaped(e.points);
}

export function isLShaped(ps) {
  if (ps.length !== 3) return false;

  const isVertical = ps[0].x === ps[1].x;
  const isHorizontal = ps[1].y === ps[2].y;
  // either one of these
  return (isVertical && isHorizontal) || (!isVertical && !isHorizontal);
}

/** swapPoints swaps both X and Y of the given points */
export function swapPoints(p1, p2) {
  [p1.x, p2.x] = [p2.x, p1.x];
  [p1.y, p2.y] = [p2.y, p1.y];
}

export function copyEdgePointsGuarded(edge, guard) {
  const points = [];
  for (const point of edge.points) {
    guard.step();
    points.push(point.copy());
  }
  return points;
}

export function insertEdgePointGuarded(edge, point, index, guard) {
  if (index < 0 || index > edge.points.length) {
    throw errorf(`TALA ${guard.location} route insertion index ${index} is out of bounds`);
  }
  const points = [];
  for (let pointIndex = 0; pointIndex < edge.points.length; pointIndex++) {
    const existing = edge.points[pointIndex];
    guard.step();
    if (pointIndex === index) points.push(point);
    points.push(existing);
  }
  if (index === edge.points.length) points.push(point);
  edge.points = points;
}

export function removeEdgePointsGuarded(edge, guard, ...indices) {
  const capacity = edge.points.length - indices.length;
  if (capacity < 0) throw errorf(`TALA ${guard.location} route removal count exceeds route length`);
  const points = [];
  OUTER:
  for (let pointIndex = 0; pointIndex < edge.points.length; pointIndex++) {
    const point = edge.points[pointIndex];
    guard.step();
    for (const removeIndex of indices) {
      guard.step();
      if (pointIndex === removeIndex) continue OUTER;
    }
    points.push(point);
  }
  edge.points = points;
}

/** swapEdgesOnAdjacentSides swaps edges on adjacent sides (top/bottom with left/right) if they can be swapped */
export function swapEdgesOnAdjacentSides(n, orientationToEdges, portToEdges, guard) {
  let swapped = false;
  const topBottomEdges = [...(orientationToEdges.get(Orientation.Top) ?? []), ...(orientationToEdges.get(Orientation.Bottom) ?? [])];
  const leftRightEdges = [...(orientationToEdges.get(Orientation.Left) ?? []), ...(orientationToEdges.get(Orientation.Right) ?? [])];
  for (const aEdge of topBottomEdges) {
    guard.step();
    for (const bEdge of leftRightEdges) {
      guard.step();
      // we need to check the edge size here in case we were able to improve it
      if (aEdge.points.length <= 2) break;
      if (bEdge.points.length <= 2) continue;
      if (!canSwapPorts(aEdge, bEdge, n, portToEdges)) continue;
      const [a1, a2, a3] = pointsAt(aEdge, n);
      const [b1, b2, b3] = pointsAt(bEdge, n);

      const intersection = geo.intersectionPoint(a2, a3, b2, b3);
      if (intersection === null) continue;

      const aPoints = copyEdgePointsGuarded(aEdge, guard);
      const bPoints = copyEdgePointsGuarded(bEdge, guard);

      // swap the first segment of the edges
      swapPoints(a1, b1);
      swapPoints(a2, b2);

      const intersectionOffset = pathNodeProximityFloor / 2.0;
      // insert the intersection
      const aIntersection = intersection.copy();
      if (aEdge.from === n) insertEdgePointGuarded(aEdge, aIntersection, 2, guard);
      else insertEdgePointGuarded(aEdge, aIntersection, aEdge.points.length - 2, guard);
      // shifts the intersection segment a bit so that it doesn't look like a crossing anymore
      if (aIntersection.x === a2.x) {
        aIntersection.x += intersectionOffset;
        a2.x += intersectionOffset;
      } else {
        aIntersection.y -= intersectionOffset;
        a2.y -= intersectionOffset;
      }

      // same as above, but for the other edge
      const bIntersection = intersection.copy();
      if (bEdge.from === n) insertEdgePointGuarded(bEdge, bIntersection, 2, guard);
      else insertEdgePointGuarded(bEdge, bIntersection, bEdge.points.length - 2, guard);
      if (bIntersection.x === b2.x) {
        bIntersection.x += intersectionOffset;
        b2.x += intersectionOffset;
      } else {
        bIntersection.y -= intersectionOffset;
        b2.y -= intersectionOffset;
      }

      const aImproved = refineEdgeGuarded(n.graph, aEdge, guard);
      const bImproved = refineEdgeGuarded(n.graph, bEdge, guard);
      if (!aImproved && !bImproved) {
        // if none of the edges improved after splitting at the intersection return back as we got 2 extra bends in the place of a single
        // intersection
        aEdge.points = aPoints;
        bEdge.points = bPoints;
      } else {
        swapped = true;
      }
    }
  }
  return swapped;
}
