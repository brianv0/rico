// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of the Go package d2layouts/d2talalayout/internal/routing (D2 v0.9.0), file(s): slingshot.go.
//
// Slingshot is an optimization to attempt a rule-based routing before falling back to BFS search (gravitational slingshot). The
// terminology (vertical launch, anchor) and the drawings are in slingshot.go. The functions that are methods of ovgEdgeRouter in Go
// take the router as `this` here; ovg_edge_router.js installs them on OvgEdgeRouter.prototype (so this file does not import it).

import * as geo from '../../geo.js';
import * as label from '../../label.js';
import { Node, newEdge } from '../layoutgraph.js';
import { routeIntersectsNodeGuarded } from './cluster_route_guard.js';
import { nonNilEquals } from './ovg_edge.js';
import { newOVGEdge } from './ovg_edge.js';
import { labeling } from './deps.js';
import { filterEdgeAncestorsGuarded, edgeCanOverlapEdgesGuarded, positionedArrowheadLabelCostGuarded } from './standalone_route_guard.js';
import { idealTurnAxes } from './turns.js';

const { Orientation } = geo;

/**
 * launch simulates the route blasting off from source, going around the anchor, and landing on target. It returns the distance if
 * successful, with 0.0 meaning it crashed into a node along the way.
 */
export function launch(source, anchor, target, gEdge) {
  const nodes = this.ovg.nodesInsideBoundingBox;

  gEdge.points = [source.point, anchor.point];
  let intersects = routeIntersectsNodeGuarded(nodes, gEdge, this.work);
  if (intersects) return 0.0;

  gEdge.points = [target.point, anchor.point];
  intersects = routeIntersectsNodeGuarded(nodes, gEdge, this.work);
  if (intersects) return 0.0;

  const d = geo.euclideanDistance(source.x, source.y, anchor.x, anchor.y) + geo.euclideanDistance(target.x, target.y, anchor.x, anchor.y);

  return d;
}

export function findLaunchings(isVerticalLaunch, orientation, gSource) {
  const ovg = this.ovg;

  let direction = Orientation.NONE;
  switch (orientation) {
    case Orientation.TopLeft:
      direction = isVerticalLaunch ? Orientation.Bottom : Orientation.Right;
      break;
    case Orientation.TopRight:
      direction = isVerticalLaunch ? Orientation.Bottom : Orientation.Left;
      break;
    case Orientation.BottomLeft:
      direction = isVerticalLaunch ? Orientation.Top : Orientation.Right;
      break;
    case Orientation.BottomRight:
      direction = isVerticalLaunch ? Orientation.Top : Orientation.Left;
      break;
  }
  if (direction === Orientation.NONE) return null;

  const out = [];
  const seen = new Set();
  for (const port of ovg.ports.get(gSource) ?? []) {
    if (seen.has(port)) continue;
    seen.add(port);
    if (port.hasPortDirection(gSource, direction)) out.push(port);
  }
  return out;
}

export function findLandings(isVerticalLaunch, orientation, gTarget) {
  const ovg = this.ovg;

  let direction = Orientation.NONE;
  switch (orientation) {
    case Orientation.TopLeft:
      direction = isVerticalLaunch ? Orientation.Left : Orientation.Top;
      break;
    case Orientation.TopRight:
      direction = isVerticalLaunch ? Orientation.Right : Orientation.Top;
      break;
    case Orientation.BottomLeft:
      direction = isVerticalLaunch ? Orientation.Left : Orientation.Bottom;
      break;
    case Orientation.BottomRight:
      direction = isVerticalLaunch ? Orientation.Right : Orientation.Bottom;
      break;
  }
  if (direction === Orientation.NONE) return null;

  const out = [];
  const seen = new Set();
  for (const port of ovg.ports.get(gTarget) ?? []) {
    if (seen.has(port)) continue;
    seen.add(port);
    if (port.hasPortDirection(gTarget, direction)) out.push(port);
  }
  return out;
}

export function undershot(n, target, orientation, isVerticalLaunch) {
  switch (orientation) {
    case Orientation.TopLeft:
      if (isVerticalLaunch && n.y < target.topLeft.y) return true;
      else if (!isVerticalLaunch && n.x < target.topLeft.x) return true;
      break;
    case Orientation.TopRight:
      if (isVerticalLaunch && n.y < target.topLeft.y) return true;
      else if (!isVerticalLaunch && n.x > target.topLeft.x + target.width) return true;
      break;
    case Orientation.BottomLeft:
      if (isVerticalLaunch && n.y > target.topLeft.y + target.height) return true;
      else if (!isVerticalLaunch && n.x < target.topLeft.x) return true;
      break;
    case Orientation.BottomRight:
      if (isVerticalLaunch && n.y > target.topLeft.y + target.height) return true;
      else if (!isVerticalLaunch && n.x > target.topLeft.x + target.width) return true;
      break;
  }
  return false;
}

/**
 * overshot returns true if n is past the target, given the orientation of the source. L routes can keep going until n is
 * completely past t; S routes are overshot when n reaches any part of t.
 */
export function overshot(n, target, orientation, isVerticalLaunch, forLRoute) {
  switch (orientation) {
    case Orientation.TopLeft:
      if (isVerticalLaunch) {
        if (forLRoute && n.y > target.topLeft.y + target.height) return true;
        if (!forLRoute && n.y > target.topLeft.y) return true;
      } else {
        if (forLRoute && n.x > target.topLeft.x + target.width) return true;
        if (!forLRoute && n.x > target.topLeft.x) return true;
      }
      break;
    case Orientation.TopRight:
      if (isVerticalLaunch) {
        if (forLRoute && n.y > target.topLeft.y + target.height) return true;
        if (!forLRoute && n.y > target.topLeft.y) return true;
      } else {
        if (forLRoute && n.x < target.topLeft.x) return true;
        if (!forLRoute && n.x < target.topLeft.x + target.width) return true;
      }
      break;
    case Orientation.BottomLeft:
      if (isVerticalLaunch) {
        if (forLRoute && n.y < target.topLeft.y) return true;
        if (!forLRoute && n.y < target.topLeft.y + target.height) return true;
      } else {
        if (forLRoute && n.x > target.topLeft.x + target.width) return true;
        if (!forLRoute && n.x > target.topLeft.x) return true;
      }
      break;
    case Orientation.BottomRight:
      if (isVerticalLaunch) {
        if (forLRoute && n.y < target.topLeft.y) return true;
        if (!forLRoute && n.y < target.topLeft.y + target.height) return true;
      } else {
        if (forLRoute && n.x < target.topLeft.x) return true;
        if (!forLRoute && n.x < target.topLeft.x + target.width) return true;
      }
      break;
  }
  return false;
}

export function isOnFlightPlan(prev, next, orientation, isVerticalLaunch) {
  switch (orientation) {
    case Orientation.TopLeft:
      if (isVerticalLaunch && next.x === prev.x && next.y > prev.y) return true;
      else if (!isVerticalLaunch && next.y === prev.y && next.x > prev.x) return true;
      break;
    case Orientation.TopRight:
      if (isVerticalLaunch && next.x === prev.x && next.y > prev.y) return true;
      else if (!isVerticalLaunch && next.y === prev.y && next.x < prev.x) return true;
      break;
    case Orientation.BottomLeft:
      if (isVerticalLaunch && next.x === prev.x && next.y < prev.y) return true;
      else if (!isVerticalLaunch && next.y === prev.y && next.x > prev.x) return true;
      break;
    case Orientation.BottomRight:
      if (isVerticalLaunch && next.x === prev.x && next.y < prev.y) return true;
      else if (!isVerticalLaunch && next.y === prev.y && next.x < prev.x) return true;
      break;
  }
  return false;
}

/**
 * If s and t exist in a vacuum, the choice of 1 and 2 is indistinguishable. But consider the x's: if s and t are connected to
 * those x's, route 1 likely impedes on their routes, while route 2 likely won't. So routes which are less likely to take up the
 * routing space of other nodes are preferred. Returns [preferred, isStrong].
 */
export function preferLaunchingVertically(gSource, gTarget, orientation) {
  let numInVerticalLaunchSpace = 0;
  let numInHorizontalLaunchSpace = 0;

  let verticalSpaceSourceOrientations = [];
  let verticalSpaceTargetOrientations = [];
  let horizontalSpaceSourceOrientations = [];
  let horizontalSpaceTargetOrientations = [];

  switch (orientation) {
    case Orientation.TopLeft:
      verticalSpaceSourceOrientations = [Orientation.BottomLeft, Orientation.Bottom];
      verticalSpaceTargetOrientations = [Orientation.Left, Orientation.BottomLeft];
      horizontalSpaceSourceOrientations = [Orientation.TopRight, Orientation.Right];
      horizontalSpaceTargetOrientations = [Orientation.Top, Orientation.TopRight];
      break;
    case Orientation.TopRight:
      verticalSpaceSourceOrientations = [Orientation.BottomRight, Orientation.Bottom];
      verticalSpaceTargetOrientations = [Orientation.Right, Orientation.BottomRight];
      horizontalSpaceSourceOrientations = [Orientation.TopLeft, Orientation.Left];
      horizontalSpaceTargetOrientations = [Orientation.Top, Orientation.TopLeft];
      break;
    case Orientation.BottomLeft:
      verticalSpaceSourceOrientations = [Orientation.TopLeft, Orientation.Top];
      verticalSpaceTargetOrientations = [Orientation.Left, Orientation.TopLeft];
      horizontalSpaceSourceOrientations = [Orientation.BottomRight, Orientation.Right];
      horizontalSpaceTargetOrientations = [Orientation.Bottom, Orientation.BottomRight];
      break;
    case Orientation.BottomRight:
      verticalSpaceSourceOrientations = [Orientation.TopRight, Orientation.Top];
      verticalSpaceTargetOrientations = [Orientation.Right, Orientation.TopRight];
      horizontalSpaceSourceOrientations = [Orientation.BottomLeft, Orientation.Left];
      horizontalSpaceTargetOrientations = [Orientation.Bottom, Orientation.BottomLeft];
      break;
  }

  for (const e of gSource.edges) {
    const adj = gSource.adjacent(e);
    if (adj === gTarget) continue;
    const o = adj.orientation(gSource);
    if (o === Orientation.NONE) continue;
    if (verticalSpaceSourceOrientations.includes(o)) numInVerticalLaunchSpace++;
    if (horizontalSpaceSourceOrientations.includes(o)) numInHorizontalLaunchSpace++;
  }

  for (const e of gTarget.edges) {
    const adj = gTarget.adjacent(e);
    if (adj === gSource) continue;
    const o = adj.orientation(gTarget);
    if (o === Orientation.NONE) continue;
    if (verticalSpaceTargetOrientations.includes(o)) numInVerticalLaunchSpace++;
    else if (horizontalSpaceTargetOrientations.includes(o)) numInHorizontalLaunchSpace++;
  }

  // Even if there is no distinction, we don't just want to always prefer one or the other, as that can lead to weird looking
  // graphs. So we use node ID as a pseudo-random tiebreak
  if (numInVerticalLaunchSpace === numInHorizontalLaunchSpace) return [gSource.id < gTarget.id, false];
  return [numInVerticalLaunchSpace < numInHorizontalLaunchSpace, true];
}

/** fillPathGuarded(from, to): [filled, success] */
export function fillPathGuarded(from, to) {
  const out = [from];
  let curr = from;
  for (;;) {
    this.work.step();
    const prev = curr;
    for (const edge of curr.edges) {
      this.work.step();
      const adjacent = curr.adjacent(edge);
      let onPath = false;
      if (from.x === to.x && adjacent.x === curr.x) {
        onPath = from.y < to.y && curr.y < adjacent.y || from.y > to.y && curr.y > adjacent.y;
      } else if (from.y === to.y && adjacent.y === curr.y) {
        onPath = from.x < to.x && curr.x < adjacent.x || from.x > to.x && curr.x > adjacent.x;
      }
      if (onPath) {
        curr = adjacent;
        break;
      }
    }
    if (curr === prev) return [null, false];
    if (curr === to) break;
    out.push(curr);
  }
  return [out, true];
}

export class RouteChecker {
  constructor(compute) {
    this.mem = new Map(); // Map<OVGNode, Map<OVGNode, boolean>>
    this.compute = compute;
  }

  /** cacheCheck: [isShared, hit] */
  cacheCheck(from, to) {
    const m = this.mem.get(from);
    if (m !== undefined) {
      const is = m.get(to);
      if (is !== undefined) return [is, true];
    }
    return [false, false];
  }

  check(from, to) {
    const [is, ok] = this.cacheCheck(from, to);
    if (ok) return is;
    if (!this.mem.has(from)) this.mem.set(from, new Map());
    const result = this.compute(from, to);
    this.mem.get(from).set(to, result);
    return result;
  }
}

export function newFallibleRouteChecker(compute) {
  return new RouteChecker(compute);
}

export function arrowheadLabelOverlapPenalty(gEdge, route) {
  let penalty = 0;
  if (gEdge.sourceArrowheadLabel === null && gEdge.targetArrowheadLabel === null) return 0;

  const routePoints = [];
  for (let i = 1; i < route.length - 1; i++) {
    this.work.step();
    routePoints.push(route[i].point);
  }

  const nonAncestors = filterEdgeAncestorsGuarded(gEdge, this.graph.nodes, this.work);

  if (gEdge.sourceArrowheadLabel !== null) {
    const pal = labeling.positionArrowheadLabel(gEdge, false, routePoints);
    const cost = positionedArrowheadLabelCostGuarded(pal, nonAncestors, this.positionedLabels, this.routes, null, this.work);
    penalty += cost;
  }
  if (gEdge.targetArrowheadLabel !== null) {
    const pal = labeling.positionArrowheadLabel(gEdge, true, routePoints);
    const cost = positionedArrowheadLabelCostGuarded(pal, nonAncestors, this.positionedLabels, this.routes, null, this.work);
    penalty += cost;
  }
  return penalty;
}

/** positionedArrowheadLabelCost: the unguarded cost of a positioned arrowhead label (routes: Route[] | null, edges: Edge[]). */
export function positionedArrowheadLabelCost(pal, nodes, labels, routes, edges) {
  let penalty = 0;
  for (const other of labels) {
    if (pal.edge === other.edge && pal.isTarget === other.isTarget) continue;
    if (pal.box.overlaps(other.box)) {
      if (pal.text === other.text) continue;
      return Infinity;
    }
  }

  const graph = pal.edge.from.graph;
  const fakeLabelNode = new Node();
  fakeLabelNode.box = pal.box.copy();
  fakeLabelNode.graph = graph;
  penalty += 4 * graph.turnCostValue() * fakeLabelNode.nodeOverlapCount(nodes, label.PADDING);

  let overlappingEdgeCount = 0;
  // during edge routing we work with routes, afterwards we use edges
  for (const route of routes ?? []) {
    if (route.gEdge === pal.edge) continue;
    for (let i = 1; i < route.ovgNodes.length; i++) {
      if (fakeLabelNode.overlapsLine(route.ovgNodes[i - 1].point, route.ovgNodes[i].point, 0)) {
        overlappingEdgeCount++;
        break;
      }
    }
  }
  for (const edge of edges ?? []) {
    if (edge === pal.edge) continue;
    for (let i = 1; i < edge.points.length; i++) {
      if (fakeLabelNode.overlapsLine(edge.points[i - 1], edge.points[i], 0)) {
        overlappingEdgeCount++;
        break;
      }
    }
  }
  penalty += graph.turnCostValue() * overlappingEdgeCount;
  return penalty;
}

/** slingshot(ctx, gEdge): [ovgNodes | null, distance] */
export function slingshot(ctx, gEdge) {
  this.bindWork(ctx);
  this.work.step();
  const gSource = gEdge.from;
  const gTarget = gEdge.to;

  if (gSource.cluster !== null || gTarget.cluster !== null) return [null, 0.0];

  const orientation = gSource.orientation(gTarget);
  if (orientation === Orientation.NONE) return [null, 0.0];
  if (gEdge.hasTableColumn()) return [null, 0.0];
  if (!geo.isDiagonal(orientation)) return [null, 0.0];

  const router = this;
  const occupiedRouteChecker = newFallibleRouteChecker((from, to) => {
    const overlappingEdges = [];
    const overlappingRoutes = router.findOverlappingRoutes(from, to);
    for (const route of overlappingRoutes) {
      router.work.reserveProduct(route.ovgNodes.length + 1, 2);
      overlappingEdges.push(route.gEdge);
      if (gEdge.isDirected() && route.isOpposingColinear(from, to)) return true;
    }
    const canOverlap = edgeCanOverlapEdgesGuarded(gEdge, overlappingEdges, null, null, router.work);
    return overlappingEdges.length > 0 && !canOverlap;
  });

  const crossedRouteChecker = newFallibleRouteChecker((from, to) => router.edgeSet.intersectsWithGuarded(newOVGEdge(from, to), router.work));

  let shortestPath;
  let shortestFlight;

  let order = [false, true];
  this.work.reserveSum(gSource.edges.length, gTarget.edges.length);
  const [verticalPref, strongLaunchPref] = preferLaunchingVertically(gSource, gTarget, orientation);
  if (verticalPref) order = [true, false];

  if (!gEdge.isBetweenTableColumns()) {
    // as we route column to column, there's no way to get L shaped routes between tables
    [shortestPath, shortestFlight] = this.findLShapedRoute(
      ctx,
      this.routes,
      order,
      verticalPref,
      strongLaunchPref,
      gEdge,
      orientation,
      occupiedRouteChecker,
      crossedRouteChecker,
    );
    if (shortestFlight !== Infinity) {
      shortestFlight += this.turnCost;
      return [shortestPath, shortestFlight];
    }
  }

  return this.findSShapedRoute(
    ctx,
    order,
    verticalPref,
    strongLaunchPref,
    gEdge,
    orientation,
    occupiedRouteChecker,
    crossedRouteChecker,
  );
}

export function findLShapedRoute(ctx, routes, order, verticalPref, strongLaunchPref, gEdge, orientation, occupiedRouteChecker, crossedRouteChecker) {
  this.bindWork(ctx);
  this.work.step();
  const gSource = gEdge.from;
  const gTarget = gEdge.to;

  const source = this.ovg.centers.get(gSource);
  const target = this.ovg.centers.get(gTarget);

  let shortestPath = null;
  let shortestFlight = Infinity;

  const gEdgeCopy = newEdge(gSource, gTarget);

  for (const isVerticalLaunch of order) {
    this.work.step();
    if (isVerticalLaunch && gEdge.fromTableColumnIndex !== null) {
      // this can't happen
      continue;
    }
    let sourcePorts = null, targetPorts = null;
    if (gEdge.fromTableColumnIndex === null) {
      this.work.add((this.ovg.ports.get(gSource) ?? []).length);
      sourcePorts = this.findLaunchings(isVerticalLaunch, orientation, gSource);
    }
    if (gEdge.toTableColumnIndex === null) {
      this.work.add((this.ovg.ports.get(gTarget) ?? []).length);
      targetPorts = this.findLandings(isVerticalLaunch, orientation, gTarget);
    }
    if (gEdge.hasTableColumn()) {
      const [sPorts, tPorts] = this.tablePorts(gEdge, gSource, gTarget, true);
      sourcePorts = sourcePorts ?? [];
      targetPorts = targetPorts ?? [];
      for (const port of sPorts ?? []) sourcePorts.push(port);
      for (const port of tPorts ?? []) targetPorts.push(port);
    }
    sourcePorts = sourcePorts ?? [];
    targetPorts = targetPorts ?? [];

    for (const sPort of sourcePorts) {
      this.work.step();
      let curr = sPort;
      for (;;) {
        this.work.step();
        let next = null;
        for (const e of curr.edges) {
          this.work.step();
          const adj = curr.adjacent(e);

          if (isOnFlightPlan(curr, adj, orientation, isVerticalLaunch)) {
            next = adj;
            break;
          }
        }
        if (next === null || overshot(next, gTarget, orientation, isVerticalLaunch, true)) break;
        const occupied = occupiedRouteChecker.check(curr, next);
        if (occupied) break;
        curr = next;
        if (undershot(next, gTarget, orientation, isVerticalLaunch)) continue;
        for (const tPort of targetPorts) {
          this.work.step();
          if (isVerticalLaunch && next.y !== tPort.y) continue;
          if (!isVerticalLaunch && next.x !== tPort.x) continue;

          let d = this.launch(sPort, next, tPort, gEdgeCopy);
          if (d === 0.0) continue;

          let crossed = crossedRouteChecker.check(sPort, next);
          if (crossed) d += this.crossingCost;
          crossed = crossedRouteChecker.check(next, tPort);
          if (crossed) d += this.crossingCost;

          if (strongLaunchPref) {
            if (verticalPref && !isVerticalLaunch) d += this.crossingCost / 2.0;
            if (!verticalPref && isVerticalLaunch) d += this.crossingCost / 2.0;
          }
          if (d < shortestFlight) {
            let path = [source];
            let [p, ok] = this.fillPathGuarded(sPort, next);
            if (!ok) continue;
            path = path.concat(p);
            [p, ok] = this.fillPathGuarded(next, tPort);
            if (!ok) continue;
            p = p.concat([tPort]);
            // We already checked share for sPort to anchor
            let badShare = false;
            for (let i = 0; i < p.length - 2; i++) {
              this.work.step();
              const curr2 = p[i], next2 = p[i + 1];
              const occupied2 = occupiedRouteChecker.check(curr2, next2);
              if (occupied2) {
                badShare = true;
                break;
              }
            }
            if (badShare) continue;
            path = path.concat(p);
            path.push(target);

            // even if it is ok to share with a route, we don't want the exact same route
            let duplicateRoute = false;
            for (const r of routes) {
              this.work.step();
              if (nonNilEquals(r.fromPort, sPort.point) && nonNilEquals(r.toPort, tPort.point) && r.ovgNodes.length === path.length) {
                let isDuplicate = true;
                // check if points between ports are equal
                for (let i = 2; i < path.length - 2; i++) {
                  this.work.step();
                  if (!nonNilEquals(r.ovgNodes[i].point, path[i].point)) {
                    isDuplicate = false;
                    break;
                  }
                }
                if (isDuplicate) {
                  duplicateRoute = true;
                  break;
                }
              }
            }
            if (duplicateRoute) continue;

            const labelPenalty = this.arrowheadLabelOverlapPenalty(gEdge, path);
            d += labelPenalty;
            if (d < shortestFlight) {
              shortestFlight = d;
              shortestPath = path;
            }
          }
        }
      }
    }
  }

  return [shortestPath, shortestFlight];
}

export function findSShapedRoute(ctx, order, verticalPref, strongLaunchPref, gEdge, orientation, occupiedRouteChecker, crossedRouteChecker) {
  this.bindWork(ctx);
  this.work.step();
  const gSource = gEdge.from;
  const gTarget = gEdge.to;

  const source = this.ovg.centers.get(gSource);
  const target = this.ovg.centers.get(gTarget);

  let shortestPath = null;
  let shortestFlight = Infinity;

  const gEdgeCopy = newEdge(gSource, gTarget);

  const nodes = this.ovg.nodesInsideBoundingBox;
  for (const isVerticalLaunch of order) {
    this.work.step();
    let sourcePorts = null, targetPorts = null;
    if (isVerticalLaunch && gEdge.fromTableColumnIndex !== null) {
      // this can't happen
      continue;
    }
    if (gEdge.fromTableColumnIndex === null) {
      this.work.add((this.ovg.ports.get(gSource) ?? []).length);
      sourcePorts = this.findLaunchings(isVerticalLaunch, orientation, gSource);
    }
    if (gEdge.toTableColumnIndex === null) {
      this.work.add((this.ovg.ports.get(gTarget) ?? []).length);
      targetPorts = this.findLandings(!isVerticalLaunch, orientation, gTarget);
    }
    if (gEdge.hasTableColumn()) {
      const [sPorts, tPorts] = this.tablePorts(gEdge, gSource, gTarget, true);
      sourcePorts = sourcePorts ?? [];
      targetPorts = targetPorts ?? [];
      for (const port of sPorts ?? []) sourcePorts.push(port);
      for (const port of tPorts ?? []) targetPorts.push(port);
    }
    sourcePorts = sourcePorts ?? [];
    targetPorts = targetPorts ?? [];

    const sourceAnchors = new Map();
    const targetAnchors = new Map();
    const sAnchorOrder = [];
    const tAnchorOrder = [];

    for (const sPort of sourcePorts) {
      this.work.step();
      let curr = sPort;
      for (;;) {
        this.work.step();
        let next = null;
        for (const e of curr.edges) {
          this.work.step();
          const adj = curr.adjacent(e);

          if (isOnFlightPlan(curr, adj, orientation, isVerticalLaunch)) {
            next = adj;
            break;
          }
        }
        if (next === null) break;
        if (overshot(next, gTarget, orientation, isVerticalLaunch, false)) break;
        const occupied = occupiedRouteChecker.check(curr, next);
        if (occupied) break;

        sourceAnchors.set(next, sPort);
        sAnchorOrder.push(next);
        curr = next;
      }
    }

    for (const tPort of targetPorts) {
      this.work.step();
      let curr = tPort;
      for (;;) {
        this.work.step();
        let next = null;
        for (const e of curr.edges) {
          this.work.step();
          const adj = curr.adjacent(e);

          if (isOnFlightPlan(curr, adj, geo.getOpposite(orientation), isVerticalLaunch)) {
            next = adj;
            break;
          }
        }
        if (next === null) break;
        if (overshot(next, gSource, geo.getOpposite(orientation), isVerticalLaunch, false)) break;
        const occupied = occupiedRouteChecker.check(curr, next);
        if (occupied) break;

        targetAnchors.set(next, tPort);
        tAnchorOrder.push(next);
        curr = next;
      }
    }

    const axes = idealTurnAxes(gSource, gTarget);
    // Prefer anchors closer to the midpoint
    this.work.reserveSort(sAnchorOrder.length);
    sAnchorOrder.sort((a, b) => {
      let aDistance, bDistance;
      if (isVerticalLaunch) {
        aDistance = Math.abs(a.y - axes[1].val);
        bDistance = Math.abs(b.y - axes[1].val);
      } else {
        aDistance = Math.abs(a.x - axes[0].val);
        bDistance = Math.abs(b.x - axes[0].val);
      }
      if (aDistance < bDistance) return -1;
      if (bDistance < aDistance) return 1;
      return 0;
    });

    for (const sAnchor of sAnchorOrder) {
      this.work.step();
      const sPort = sourceAnchors.get(sAnchor);
      for (const tAnchor of tAnchorOrder) {
        this.work.step();
        const tPort = targetAnchors.get(tAnchor);
        if (isVerticalLaunch && sAnchor.y !== tAnchor.y) continue;
        if (!isVerticalLaunch && sAnchor.x !== tAnchor.x) continue;
        let d = 0.0;
        const pairs = [
          [sPort, sAnchor],
          [sAnchor, tAnchor],
          [tAnchor, tPort],
        ];
        let intersects = false;
        for (const pair of pairs) {
          this.work.step();
          gEdgeCopy.points = [pair[0].point, pair[1].point];
          const intersectsNode = routeIntersectsNodeGuarded(nodes, gEdgeCopy, this.work);
          if (intersectsNode) {
            intersects = true;
            break;
          }
          d += geo.euclideanDistance(pair[0].x, pair[0].y, pair[1].x, pair[1].y);
          const crossed = crossedRouteChecker.check(pair[0], pair[1]);
          if (crossed) d += this.crossingCost;
        }
        if (intersects) continue;
        if (strongLaunchPref) {
          if (verticalPref && !isVerticalLaunch) d += this.crossingCost / 2.0;
          if (!verticalPref && isVerticalLaunch) d += this.crossingCost / 2.0;
        }
        if (d < shortestFlight) {
          let path = [source];
          let [p, ok] = this.fillPathGuarded(sPort, sAnchor);
          if (!ok) continue;
          path = path.concat(p);
          [p, ok] = this.fillPathGuarded(sAnchor, tAnchor);
          if (!ok) continue;
          // add this just for the share check
          p = p.concat([tAnchor]);
          // We already checked share for sPort to sAnchor and tPort to tAnchor
          let badShare = false;
          for (let i = 0; i < p.length - 2; i++) {
            this.work.step();
            const curr = p[i], next = p[i + 1];
            const occupied = occupiedRouteChecker.check(curr, next);
            if (occupied) {
              badShare = true;
              break;
            }
          }
          if (badShare) continue;
          path = path.concat(p.slice(0, p.length - 1));
          [p, ok] = this.fillPathGuarded(tAnchor, tPort);
          if (!ok) continue;
          path = path.concat(p);
          path.push(tPort);
          path.push(target);

          const labelPenalty = this.arrowheadLabelOverlapPenalty(gEdge, path);
          d += labelPenalty;
          if (d < shortestFlight) {
            shortestFlight = d;
            shortestPath = path;
          }
        }
      }
    }
  }

  if (shortestFlight !== Infinity) shortestFlight += this.turnCost * 2;

  return [shortestPath, shortestFlight];
}
