// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of the Go package d2layouts/d2talalayout/internal/loops (D2 v0.9.0, github.com/d2lang/d2, Copyright 2022
// Terrastruct Inc.): deterministic self-edge routes and the node extents (node.loopOffsets) those routes reserve during placement.

import * as geo from '../geo.js';
import * as label from '../label.js';
import { goRound } from '../gomath.js';
import { sortStableFunc } from './goslices.js';

const { Orientation } = geo;

const sharedPortLoopGap = 30.0;

/** nonNilEquals compares two optional points by value (geometry.go). */
const nonNilEquals = (first, second) => first != null && second != null && first.x === second.x && first.y === second.y;

/** ComputeOffsets refreshes loop extents for every graph node. */
export function computeOffsets(g) {
  for (const node of g.nodes) updateOffsets(node);
}

/** UpdateOffsets refreshes the space reserved around node for self-edge routes. */
export function updateOffsets(node) {
  // need to set node TopLeft because the node position is required to get the ports
  // which are required for routing
  const tlIsNil = node.topLeft === null;
  if (tlIsNil) node.topLeft = new geo.Point(0, 0);
  computeOffsets_(node);
  if (tlIsNil) node.topLeft = null;
}

/** computeLoopOffsets precomputes loops and their contribution to node bounds for later delta and bounding-box calculations. */
function computeOffsets_(node) {
  node.loopOffsets = new Map();

  const [tl, br] = node.boundingBox(null);
  const [loopTL, loopBR] = node.boundingBox(null);
  for (const edge of routeLoops(node)) {
    if (!edge.isLoop()) continue;
    const [eTL, eBR] = edge.boundingBoxValues();
    loopTL.x = Math.min(loopTL.x, eTL.x);
    loopTL.y = Math.min(loopTL.y, eTL.y);
    loopBR.x = Math.max(loopBR.x, eBR.x);
    loopBR.y = Math.max(loopBR.y, eBR.y);
    // need to reset because if these are set based on `0, 0`, graph bounding box breaks during placement
    // as nodes move around during placement and these edge points would stay at `0, 0`
    // the graph would reach a bad state
    edge.points = [];
  }

  if (nonNilEquals(tl, loopTL) && nonNilEquals(br, loopBR)) return;

  const lo = node.loopOffsets;
  lo.set(Orientation.Left, goRound(Math.abs(tl.x - loopTL.x)));
  lo.set(Orientation.Right, goRound(Math.abs(br.x - loopBR.x)));
  lo.set(Orientation.Top, goRound(Math.abs(tl.y - loopTL.y)));
  lo.set(Orientation.Bottom, goRound(Math.abs(br.y - loopBR.y)));

  lo.set(Orientation.TopLeft, Math.max(lo.get(Orientation.Top), lo.get(Orientation.Left)));
  lo.set(Orientation.TopRight, Math.max(lo.get(Orientation.Top), lo.get(Orientation.Right)));
  lo.set(Orientation.BottomLeft, Math.max(lo.get(Orientation.Bottom), lo.get(Orientation.Left)));
  lo.set(Orientation.BottomRight, Math.max(lo.get(Orientation.Bottom), lo.get(Orientation.Right)));
}

/** loopPorts works as sort of context for a given ports pair while routing loops */
class LoopPorts {
  constructor(from, to, fromDirection, toDirection) {
    this.verticalOffset = 0;
    this.horizontalOffset = 0;
    this.hasSourceArrowhead = null; // *bool
    this.hasTargetArrowhead = null; // *bool
    this.sourceArrowhead = '';
    this.targetArrowhead = '';
    this.from = from;
    this.fromDirection = fromDirection;
    this.to = to;
    this.toDirection = toDirection;
  }
}

const newLoopPorts = (from, to, fromDirection, toDirection) => new LoopPorts(from, to, fromDirection, toDirection);

/** Route computes every self-edge route for node. */
export function route(n) {
  return routeLoops(n);
}

/**
 * routeLoops routes loops in a rule based approach and sets the proper label position
 * edges are routed based on their arrowheads and label size
 * there are 4 possible positions for loops, one at each corner
 */
function routeLoops(n) {
  const availablePorts = makeLoopPorts(n);

  const routedEdges = [];
  for (const e of edgesInOrder(n.edges)) {
    if (!e.isLoop()) continue;

    routedEdges.push(e);
    const portsPair = findLoopPortsForEdge(e, availablePorts);
    e.points = routeLoop(portsPair);
    if (e.label !== null) {
      e.label.position = label.OutsideTopCenter;
    }
    [portsPair.verticalOffset, portsPair.horizontalOffset] = computeEdgeOffset(e);
    portsPair.hasSourceArrowhead = e.hasSourceArrow();
    portsPair.hasTargetArrowhead = e.hasTargetArrow();
    portsPair.sourceArrowhead = e.sourceArrowhead;
    portsPair.targetArrowhead = e.targetArrowhead;
  }
  return routedEdges;
}

/**
 * edgesInOrder sorts edges based on their arrowheads and label sizes
 * sorting by arrowhead is required so that, if a given `diamond` node has all edge types (->, --, <->)
 * the arrowheads will match the ports as expected (see `self_edges_all_shapes` test case)
 * then, sorts by label so that the smallest ones will use the routes closes to the shape, avoiding empty space
 */
function edgesInOrder(edges) {
  const sortedEdges = edges.slice();
  const arrowheadScore = (e) => {
    // ->
    if (e.hasSourceArrow() !== e.hasTargetArrow()) return 0;
    else if (e.hasSourceArrow()) return 1;
    return 2;
  };
  sortStableFunc(sortedEdges, (a, b) => {
    // 1st ->
    // 2nd <->
    // 3rd --
    if (a.hasSourceArrow() !== b.hasSourceArrow() || a.hasTargetArrow() !== b.hasTargetArrow()) {
      const aScore = arrowheadScore(a);
      const bScore = arrowheadScore(b);
      if (aScore < bScore) return -1;
      if (bScore < aScore) return 1;
      return 0;
    }

    // if arrowheads are equal, sort by label area
    let aArea = 0;
    let bArea = 0;
    if (a.label !== null) aArea = a.label.width * a.label.height;
    if (b.label !== null) bArea = b.label.width * b.label.height;
    if (aArea < bArea) return -1;
    if (bArea < aArea) return 1;
    return 0;
  });
  return sortedEdges;
}

/** findLoopPortsForEdge finds the ports that are using the same arrowheads in `availablePorts` */
function findLoopPortsForEdge(e, availablePorts) {
  // first find a matching set if it exists
  for (const ports of availablePorts) {
    if (ports.hasSourceArrowhead !== null && ports.hasTargetArrowhead !== null) {
      if (ports.sourceArrowhead === e.sourceArrowhead && ports.targetArrowhead === e.targetArrowhead) return ports;
    }
  }
  // look for an open pair
  for (const ports of availablePorts) {
    if (ports.hasSourceArrowhead === null && ports.hasTargetArrowhead === null) return ports;
  }
  // find a pair that have arrows at the same end
  for (const ports of availablePorts) {
    if (ports.hasSourceArrowhead !== null && ports.hasTargetArrowhead !== null &&
      ports.hasSourceArrowhead === e.hasSourceArrow() && ports.hasTargetArrowhead === e.hasTargetArrow()) return ports;
  }
  return null;
}

/**
 * makeLoopPorts makes the 4 possible port pairs, one at each corner, using the closest ports for each combination
 * closest ports because this avoids crossings with other routes
 * the ports order is related to edgesInOrder and the `shape: diamond` condition (see test case)
 * Four pairs are required because the declaration orientation makes source-only
 * and target-only arrows distinct categories in addition to -- and <->.
 */
function makeLoopPorts(n) {
  const ports = n.ports();
  const topIndices = n.portIndices(Orientation.Top);
  const rightIndices = n.portIndices(Orientation.Right);
  const bottomIndices = n.portIndices(Orientation.Bottom);
  const leftIndices = n.portIndices(Orientation.Left);

  const [trTop, trRight] = closestPorts(ports, topIndices, rightIndices);
  const [blBottom, blLeft] = closestPorts(ports, bottomIndices, leftIndices);
  const [ltLeft, ltTop] = closestPorts(ports, leftIndices, topIndices);
  const [brRight, brBottom] = closestPorts(ports, rightIndices, bottomIndices);

  return [
    newLoopPorts(ltLeft, ltTop, Orientation.Left, Orientation.Top),
    newLoopPorts(trTop, trRight, Orientation.Top, Orientation.Right),
    newLoopPorts(blBottom, blLeft, Orientation.Bottom, Orientation.Left),
    newLoopPorts(brRight, brBottom, Orientation.Right, Orientation.Bottom),
  ];
}

function closestPorts(ports, sideA, sideB) {
  let closestA = new geo.Point(0, 0);
  let closestB = new geo.Point(0, 0);
  let minDistance = Infinity;

  for (const indexA of sideA) {
    for (const indexB of sideB) {
      const pa = ports[indexA];
      const pb = ports[indexB];
      const d = geo.euclideanDistance(pa.x, pa.y, pb.x, pb.y);
      if (d < minDistance) {
        minDistance = d;
        closestA = pa.copy();
        closestB = pb.copy();
      }
    }
  }

  return [closestA, closestB];
}

/**
 * routeLoop creates the route shown below with ports `*`, bend points and intersection (`#`)
 * . #───────────#
 * . │           │
 * . │      ┌────*───┐
 * . │      │        │
 * . #──────*        │
 * .        │  node  │
 * .        │        │
 * .        └────────┘
 */
function routeLoop(ports) {
  const p1 = makeBendPoint(ports.from, ports.fromDirection, ports.verticalOffset, ports.horizontalOffset);
  const p2 = makeBendPoint(ports.to, ports.toDirection, ports.verticalOffset, ports.horizontalOffset);
  const intersection = makeIntersectionPoint(p1, p2, ports.fromDirection);

  return [ports.from, p1, intersection, p2, ports.to];
}

function makeBendPoint(port, direction, verticalOffset, horizontalOffset) {
  switch (direction) {
    case Orientation.Top:
      return new geo.Point(port.x, port.y - verticalOffset - sharedPortLoopGap);
    case Orientation.Bottom:
      return new geo.Point(port.x, port.y + verticalOffset + sharedPortLoopGap);
    case Orientation.Left:
      return new geo.Point(port.x - horizontalOffset - sharedPortLoopGap, port.y);
    case Orientation.Right:
      return new geo.Point(port.x + horizontalOffset + sharedPortLoopGap, port.y);
  }
  return null;
}

function makeIntersectionPoint(from, to, fromDirection) {
  if (!geo.isVertical(fromDirection)) return new geo.Point(from.x, to.y);
  return new geo.Point(to.x, from.y);
}

/** computeEdgeOffset computes the offset to place the next loop considering the current `edge` and its label */
function computeEdgeOffset(edge) {
  let verticalOffset;
  let horizontalOffset;
  const points = edge.points;
  if (edge.points[0].x === edge.points[1].x) {
    verticalOffset = Math.abs(points[0].y - points[1].y);
    horizontalOffset = Math.abs(points[points.length - 1].x - points[points.length - 2].x);
  } else {
    verticalOffset = Math.abs(points[points.length - 1].y - points[points.length - 2].y);
    horizontalOffset = Math.abs(points[0].x - points[1].x);
  }

  if (edge.label !== null) {
    verticalOffset += edge.label.height;
    horizontalOffset += edge.label.width;
  }
  return [verticalOffset, horizontalOffset];
}
