// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of the Go package d2layouts/d2talalayout/internal/routing (D2 v0.9.0), file(s): ovg.go.
//
// Orthogonal Visibility Graph. Go maps are: OccupiedPoints map[geo.Point]*OVGNode -> PointMap; VerticalEdges/HorizontalEdges
// map[float64][]*OVGEdge -> Map; Ports/Centers map[*Node]... -> Map (insertion order; Go's order is random and the OVG does not depend
// on it, see docs/d2-tala-port.md "routing core"). Guards throw where Go returns an error.

import * as geo from '../../geo.js';
import { goRound } from '../../gomath.js';
import { sortSlice } from '../../gosort.js';
import { MinPortClearance } from '../layoutgraph.js';
import { PointMap } from '../layoutgraph.js';
import { OVGNode, directionsAny, directionsHas } from './ovg_node.js';
import { OVGEdge, nonNilEquals } from './ovg_edge.js';
import {
  newOVGBuildGuard, checkedOVGSliceCapacity, checkedOVGIntersectionCount, checkedOVGEdgeCapacity,
  newOVGPointProximityIndex, newOVGPortIndex, fixedOverlapsForBuild,
} from './ovg_resource.js';
import { extraInterestingPointLayers, ovgPadding, overshootAmount, nodeProximityThreshold } from './tuning.js';
import { buildTunnels } from './tunnel.js';
import { treeEdgePathForBuild, isSentinelEdgeSource } from './tree_routes.js';
import * as hier from './ovg_hierarchy.js';
import { newOVGForHierarchy } from './ovg_hierarchy.js';

const { Orientation } = geo;

const numCmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Orthogonal Visibility Graph */
export class OVG {
  constructor(nodesInsideBoundingBox) {
    this.nodesInsideBoundingBox = nodesInsideBoundingBox;
    this.nodes = [];
    this.occupiedPoints = new PointMap(); // PointMap<OVGNode>
    this.edges = [];
    this.verticalEdges = new Map(); // Map<float64, OVGEdge[]>
    this.horizontalEdges = new Map();
    this.ports = new Map(); // Map<Node, OVGNode[]>
    this.centers = new Map(); // Map<Node, OVGNode>

    this.fixedOverlapsCache = []; // [{graph, nodes, overlaps}]
    this.buildGuard = null;
  }

  addNodeUnchecked(node) {
    this.nodes.push(node);
    this.occupiedPoints.set(node.point, node);
  }

  addNode(node) {
    const occupant = this.occupiedPoints.get(node.point);
    if (occupant !== undefined) return occupant;
    this.addNodeUnchecked(node);
    return node;
  }

  connect(nodeA, nodeB) {
    if (nodeA.isNodeCenter && !nodeB.isPort() || nodeB.isNodeCenter && !nodeA.isPort()) {
      // only ports can connect to center
      return null;
    }

    const edge = new OVGEdge(nodeA, nodeB);
    this.edges.push(edge);
    nodeA.addEdge(edge);
    nodeB.addEdge(edge);
    if (edge.isVertical()) {
      appendTo(this.verticalEdges, nodeA.x, edge);
    } else if (edge.isHorizontal()) {
      appendTo(this.horizontalEdges, nodeA.y, edge);
    }
    // this distance doesn't change as the OVG nodes don't move around so it is safe to precompute it here and just use it later
    // on during edge routing
    edge.distance = geo.euclideanDistance(nodeA.x, nodeA.y, nodeB.x, nodeB.y);
    return edge;
  }

  removeIsolatedNodes(guard) {
    guard.check();
    const newNodes = [];

    for (const n of this.nodes) {
      guard.step();
      if (n.edges.length > 0) newNodes.push(n);
    }

    this.nodes = newNodes;
    guard.check();
  }

  reindexOccupiedPoints() {
    this.occupiedPoints = new PointMap();
    for (const node of this.nodes) this.occupiedPoints.set(node.point, node);
  }

  /** For each tala.Node, get the ports and add them as OVG Nodes */
  addPorts(g, guard) {
    guard.check();
    // If all of a container's children have no connections, there's no need to consider them for pathing
    const skipPathing = new Set();
    for (const children of g.containers.values()) {
      guard.step();
      let has = false;
      for (const child of children) {
        guard.step();
        if (child.edges.length > 0) {
          has = true;
          break;
        }
      }
      if (!has) {
        for (const child of children) {
          guard.step();
          skipPathing.add(child);
        }
      }
    }

    // Add ports
    for (const node of this.nodesInsideBoundingBox) {
      guard.step();
      if (skipPathing.has(node)) continue;
      // most shapes have 12 ports (3 on each side)
      this.ports.set(node, []);
      const snapPoints = node.snapPointPercentages();
      for (let i = 0; i < snapPoints.length; i++) {
        const relativePoints = snapPoints[i];
        guard.step();
        for (const point of relativePoints) {
          guard.step();
          const port = guard.addPoint(this, geo.newPoint(node.topLeft.x + goRound(node.width * point.XPercentage), node.topLeft.y + goRound(node.height * point.YPercentage)));
          this.ports.get(node).push(port);
          let direction = Orientation.TopLeft; // Go's zero value
          if (i === 0) direction = Orientation.Top;
          else if (i === 1) direction = Orientation.Left;
          else if (i === 2) direction = Orientation.Bottom;
          else if (i === 3) direction = Orientation.Right;
          port.addPortOwner(node, direction, false);
        }
      }

      const ports = this.ports.get(node);
      for (const index of node.centerPortIndices()) {
        guard.step();
        ports[index].setCenterPort(node);
      }
    }
    guard.check();
  }

  /** For all OVG Nodes added from ports, take their x/y cartesian product to create a grid of OVG Nodes */
  addNodesIntersections(g, guard) {
    guard.check();
    const xCandidates = new Set();
    const yCandidates = new Set();

    for (const node of this.nodes) {
      guard.step();
      xCandidates.add(node.point.x);
      yCandidates.add(node.point.y);
    }

    this.addIntersections(g, xCandidates, yCandidates, guard);
  }

  addIntersections(g, xs, ys, guard) {
    guard.check();
    const candidateCount = checkedOVGIntersectionCount(xs.size, ys.size);
    // Reserve the complete Cartesian product before allocating its orderings or entering the loop. This makes a limit failure
    // deterministic and cheap.
    guard.reserveCandidates(candidateCount);
    guard.reserveWork(candidateCount);

    const xOrder = [];
    for (const x of xs) {
      guard.check();
      xOrder.push(x);
    }
    guard.reserveSortWork(xOrder.length);
    xOrder.sort(numCmp);

    const yOrder = [];
    for (const y of ys) {
      guard.check();
      yOrder.push(y);
    }
    guard.reserveSortWork(yOrder.length);
    yOrder.sort(numCmp);

    const graphNodes = g.nodes;
    const fixedOverlaps = fixedOverlapsForBuild(this, g, graphNodes, guard);
    const portIndex = newOVGPortIndex(this.ports, g, fixedOverlaps, guard);
    const proximityIndex = newOVGPointProximityIndex(g, xOrder, guard);

    // TODO don't have cross section of port nodes from container to descendants
    // Cross section of all the port nodes
    for (const px of xOrder) {
      guard.check();
      for (const py of yOrder) {
        guard.check();
        // Can't be too close to any port or node
        const tooClose = portIndex.tooClose(px, py, MinPortClearance, guard);
        if (tooClose) continue;
        // Charge candidate inspection before doing any geometry, but keep the candidate on the stack until it survives both
        // rejection filters.
        guard.step();
        const candidatePoint = new geo.Point(px, py);
        const nearNode = proximityIndex.pointNear(px, py, guard);
        if (nearNode) continue;
        const candidate = new OVGNode(candidatePoint);
        const unobstructed = candidate.hasUnobstructedLineToPorts(this, portIndex, 2, guard);
        if (unobstructed) {
          const n = new OVGNode(geo.newPoint(px, py));
          guard.addNode(this, n);
        }
      }
    }
    guard.check();
  }

  /** For each edge in tala.Edges, add nodes on the edge perimeter (bounding box) and half-way through the bounding box */
  addEdgesNodes(g, guard) {
    guard.check();
    const graphNodes = g.nodes;
    const fixedOverlaps = fixedOverlapsForBuild(this, g, graphNodes, guard);
    const portIndex = newOVGPortIndex(this.ports, g, fixedOverlaps, guard);
    for (const edge of g.edges) {
      guard.step();
      if (edge.isLoop()) continue;
      if (edge.from.hierarchy !== null && edge.to.hierarchy !== null && edge.to.hierarchy === edge.from.hierarchy) {
        // if the edge is between two nodes in the same hierarchy, it was already handled by the hierarchical OVG routine
        // though, there can be edges between nodes in two different hierarchies; in that case, these points must be created
        continue;
      }
      let fillPoints = this.perimeterPoints(edge.from, edge.to, guard);
      const halfwayPoints = this.halfwayPoints(edge.from, edge.to, guard);
      fillPoints = fillPoints.concat(halfwayPoints);
      for (const fillPoint of fillPoints) {
        guard.step();
        guard.step();
        const nearNode = guard.pointNearGraphNode(g, fillPoint);
        if (nearNode) continue;
        const candidate = new OVGNode(fillPoint);
        const unobstructed = candidate.hasUnobstructedLineToPorts(this, portIndex, 1, guard);
        if (unobstructed) {
          const fillPointNode = new OVGNode(fillPoint);
          guard.addNode(this, fillPointNode);
        }
      }
    }
    guard.check();
  }

  perimeterPoints(node, otherNode, guard) {
    let fillPoints = [];
    // Perimeter points
    const top = Math.min(node.topLeft.y, otherNode.topLeft.y) - overshootAmount;
    const bottom = Math.max(node.topLeft.y + node.height, otherNode.topLeft.y + otherNode.height) + overshootAmount;
    const left = Math.min(node.topLeft.x, otherNode.topLeft.x) - overshootAmount;
    const right = Math.max(node.topLeft.x + node.width, otherNode.topLeft.x + otherNode.width) + overshootAmount;

    for (const graphNode of [node, otherNode]) {
      guard.step();
      const topPorts = guard.portsByOrientation(this, graphNode, Orientation.Top);
      for (const portNode of topPorts) {
        guard.step();
        fillPoints.push(geo.newPoint(portNode.point.x, top));
      }
      const bottomPorts = guard.portsByOrientation(this, graphNode, Orientation.Bottom);
      for (const portNode of bottomPorts) {
        guard.step();
        fillPoints.push(geo.newPoint(portNode.point.x, bottom));
      }
      const leftPorts = guard.portsByOrientation(this, graphNode, Orientation.Left);
      for (const portNode of leftPorts) {
        guard.step();
        fillPoints.push(geo.newPoint(left, portNode.point.y));
      }
      const rightPorts = guard.portsByOrientation(this, graphNode, Orientation.Right);
      for (const portNode of rightPorts) {
        guard.step();
        fillPoints.push(geo.newPoint(right, portNode.point.y));
      }
    }

    fillPoints.push(geo.newPoint(left, top));
    fillPoints.push(geo.newPoint(right, top));
    fillPoints.push(geo.newPoint(left, bottom));
    fillPoints.push(geo.newPoint(right, bottom));
    guard.check();
    return fillPoints;
  }

  /** add points halfway between node and otherNode */
  halfwayPoints(node, otherNode, guard) {
    const fillPoints = [];
    const orientation = node.orientation(otherNode);
    if (orientation === Orientation.NONE) {
      guard.check();
      return fillPoints;
    }
    // Halfway points
    // Fill from node to otherNode, which means if node is to the left of otherNode, we are filling rightwards, from node
    let fillTop = false;
    let fillRight = false;
    let fillBottom = false;
    let fillLeft = false;
    switch (orientation) {
      case Orientation.Top:
        fillBottom = true;
        break;
      case Orientation.TopLeft:
        fillBottom = true;
        fillRight = true;
        break;
      case Orientation.TopRight:
        fillBottom = true;
        fillLeft = true;
        break;
      case Orientation.Bottom:
        fillTop = true;
        break;
      case Orientation.BottomLeft:
        fillTop = true;
        fillRight = true;
        break;
      case Orientation.BottomRight:
        fillTop = true;
        fillLeft = true;
        break;
      case Orientation.Left:
        fillRight = true;
        break;
      case Orientation.Right:
        fillLeft = true;
        break;
    }

    let nodeTL = node.topLeft.copy();
    let nodeBR = geo.newPoint(goRound(nodeTL.x + node.width), goRound(nodeTL.y + node.height));

    let otherNodeTL = otherNode.topLeft.copy();
    let otherNodeBR = geo.newPoint(goRound(otherNodeTL.x + otherNode.width), goRound(otherNodeTL.y + otherNode.height));

    // all cluster nodes should use the same halfway points based on the whole cluster
    if (node.cluster !== null) {
      [nodeTL, nodeBR] = guard.tightBoundingBox(node.cluster.nodes);
    }
    if (otherNode.cluster !== null) {
      [otherNodeTL, otherNodeBR] = guard.tightBoundingBox(otherNode.cluster.nodes);
    }

    let nodePorts = this.ports.get(node) ?? [];
    let otherNodePorts = this.ports.get(otherNode) ?? [];
    if (node.sequence !== null) {
      [nodeTL, nodeBR] = guard.tightBoundingBox(node.sequence.nodes);
      // Go appends to the shared slice header (a copy here: the map's slice must not grow)
      nodePorts = nodePorts.slice();
      for (const n of node.sequence.nodes) {
        guard.step();
        if (n !== node) nodePorts.push(...(this.ports.get(n) ?? []));
      }
    }
    if (otherNode.sequence !== null) {
      [otherNodeTL, otherNodeBR] = guard.tightBoundingBox(otherNode.sequence.nodes);
      otherNodePorts = otherNodePorts.slice();
      for (const n of otherNode.sequence.nodes) {
        guard.step();
        if (n !== otherNode) otherNodePorts.push(...(this.ports.get(n) ?? []));
      }
    }

    if (fillTop) {
      const y = (nodeTL.y + otherNodeBR.y) / 2;
      for (const portNode of nodePorts) {
        guard.step();
        fillPoints.push(geo.newPoint(portNode.point.x, y));
      }
      for (const portNode of otherNodePorts) {
        guard.step();
        fillPoints.push(geo.newPoint(portNode.point.x, y));
      }
    }
    if (fillBottom) {
      const y = (otherNodeTL.y + nodeBR.y) / 2;
      for (const portNode of nodePorts) {
        guard.step();
        fillPoints.push(geo.newPoint(portNode.point.x, y));
      }
      for (const portNode of otherNodePorts) {
        guard.step();
        fillPoints.push(geo.newPoint(portNode.point.x, y));
      }
    }
    if (fillLeft) {
      const x = (nodeTL.x + otherNodeBR.x) / 2;
      for (const portNode of nodePorts) {
        guard.step();
        fillPoints.push(geo.newPoint(x, portNode.point.y));
      }
      for (const portNode of otherNodePorts) {
        guard.step();
        fillPoints.push(geo.newPoint(x, portNode.point.y));
      }
    }
    if (fillRight) {
      const x = (otherNodeTL.x + nodeBR.x) / 2;
      for (const portNode of nodePorts) {
        guard.step();
        fillPoints.push(geo.newPoint(x, portNode.point.y));
      }
      for (const portNode of otherNodePorts) {
        guard.step();
        fillPoints.push(geo.newPoint(x, portNode.point.y));
      }
    }

    // These are the corner points for the halfway fill points
    if (fillRight && fillBottom) {
      const x = (otherNodeTL.x + nodeBR.x) / 2;
      const y = (otherNodeTL.y + nodeBR.y) / 2;
      fillPoints.push(geo.newPoint(x, y));
    }

    if (fillRight && fillTop) {
      const x = (otherNodeTL.x + nodeBR.x) / 2;
      const y = (nodeTL.y + otherNodeBR.y) / 2;
      fillPoints.push(geo.newPoint(x, y));
    }

    if (fillLeft && fillTop) {
      const x = (nodeTL.x + otherNodeBR.x) / 2;
      const y = (nodeTL.y + otherNodeBR.y) / 2;
      fillPoints.push(geo.newPoint(x, y));
    }

    if (fillLeft && fillBottom) {
      const x = (nodeTL.x + otherNodeBR.x) / 2;
      const y = (otherNodeTL.y + nodeBR.y) / 2;
      fillPoints.push(geo.newPoint(x, y));
    }
    guard.check();
    return fillPoints;
  }

  addTreeNodes(g, guard) {
    guard.check();
    const portArrowheads = new Map(); // Map<OVGNode, Set<Arrowhead>>
    // If there are trees in this subgraph, we need to add ovg nodes for the specific tree edge routes
    for (const node of g.nodes) {
      guard.step();
      const tree = g.nodeToTree === null ? undefined : g.nodeToTree.get(node);
      if (tree !== undefined) {
        const treePath = treeEdgePathForBuild(tree, this.ports, portArrowheads, guard);

        guard.addPoint(this, treePath.sourceMidpoint);
        guard.addPoint(this, treePath.targetMidpoint);
        // if the shape centers are misaligned, treePath may use a new parent-aligned port so we add it here
        if (isSentinelEdgeSource(tree)) {
          const port = guard.addNode(this, treePath.sourcePortNode);
          if (!port.isPortOf(node)) {
            this.ports.get(node).push(port);
            port.addPortOwner(node, geo.getOpposite(treePath.sourceOrientationToTarget), false);
          }

          if (!portArrowheads.has(treePath.targetPortNode)) portArrowheads.set(treePath.targetPortNode, new Set());
          portArrowheads.get(treePath.targetPortNode).add(tree.sentinelEdge.targetArrowhead);
        } else {
          const port = guard.addNode(this, treePath.targetPortNode);
          if (!port.isPortOf(node)) {
            this.ports.get(node).push(port);
            port.addPortOwner(node, treePath.sourceOrientationToTarget, false);
          }

          if (!portArrowheads.has(treePath.sourcePortNode)) portArrowheads.set(treePath.sourcePortNode, new Set());
          portArrowheads.get(treePath.sourcePortNode).add(tree.sentinelEdge.sourceArrowhead);
        }
      }
    }
    guard.check();
  }

  /** addNewBoundaryLayers adds new nodes at the graph boundaries (padded layers around the bounding box, see ovg.go for the drawing). */
  addNewBoundaryLayers(g, tl, br, guard) {
    guard.check();
    // Don't count containers for children obstruction. Pad boundaries with points to allow edges to reach around
    for (let i = 0.0; i < extraInterestingPointLayers; i++) {
      guard.step();
      // range over the slice header taken at loop start: nodes appended by addPoint are not visited
      const count = this.nodes.length;
      for (let k = 0; k < count; k++) {
        const node = this.nodes[k];
        guard.step();
        let point = null;
        if (node.point.y === tl.y) point = geo.newPoint(node.point.x, node.point.y - (ovgPadding * (i + 1)));
        if (node.point.y === br.y) point = geo.newPoint(node.point.x, node.point.y + (ovgPadding * (i + 1)));
        if (node.point.x === tl.x) point = geo.newPoint(node.point.x - (ovgPadding * (i + 1)), node.point.y);
        if (node.point.x === br.x) point = geo.newPoint(node.point.x + (ovgPadding * (i + 1)), node.point.y);

        if (point !== null) {
          const nearNode = guard.pointNearGraphNode(g, point);
          if (!nearNode) guard.addPoint(this, point);
        }
      }
    }
  }

  /** For each given OVG node, try to add a new node at the graph boundaries that make a direct connection to this node */
  addPortConnectionNodesAtBoundaries(g, tl, br, guard) {
    guard.check();
    // Don't count containers for children obstruction. Pad boundaries with points to allow edges to reach around
    for (let i = 0.0; i < extraInterestingPointLayers; i++) {
      guard.step();
      for (const [node, ports] of this.ports) {
        guard.step();
        let added = false;
        const seenPorts = new Set();
        for (const portNode of ports) {
          guard.step();
          if (seenPorts.has(portNode)) continue;
          seenPorts.add(portNode);
          const [portDirections] = portNode.portDirectionsFor(node);
          directionsAny(portDirections, (portDirection) => {
            guard.step();
            const topPoint = geo.newPoint(portNode.point.x, tl.y - (ovgPadding * (i + 1)));
            const bottomPoint = geo.newPoint(portNode.point.x, br.y + (ovgPadding * (i + 1)));
            const leftPoint = geo.newPoint(tl.x - (ovgPadding * (i + 1)), portNode.point.y);
            const rightPoint = geo.newPoint(br.x + (ovgPadding * (i + 1)), portNode.point.y);

            for (const boundaryPoint of [topPoint, bottomPoint, leftPoint, rightPoint]) {
              guard.step();
              let passesThroughARectangle = false;
              for (const rectangle of this.nodesInsideBoundingBox) {
                guard.step();
                const passesThrough = guard.passesThroughAllowingPorts(rectangle, portNode.point, boundaryPoint, portDirection, this.ports.get(rectangle) ?? []);
                if (passesThrough) {
                  // We make exception for container
                  let isRectangleNodeContainer = false;
                  if (rectangle.isContainer()) {
                    const descendant = guard.isDescendantOf(node, rectangle);
                    if (descendant) isRectangleNodeContainer = true;
                  }
                  if (!isRectangleNodeContainer) {
                    passesThroughARectangle = true;
                    break;
                  }
                }
              }
              if (passesThroughARectangle) continue;
              const nearNode = guard.pointNearGraphNode(g, boundaryPoint);
              if (!nearNode) {
                guard.addPoint(this, boundaryPoint);
                added = true;
              }
            }
            return false;
          });
        }
        if (!added) this.createPortsConnectionsToBoundaries(node, ports, tl, br, guard);
      }
    }
  }

  addCornerNodes(g, tl, br, guard) {
    guard.check();
    // Fill in the corners of boundary points
    for (let i = 0.0; i < extraInterestingPointLayers; i++) {
      guard.step();
      const points = [
        new geo.Point(tl.x - (ovgPadding * (i + 1)), tl.y - (ovgPadding * (i + 1))),
        new geo.Point(br.x + (ovgPadding * (i + 1)), tl.y - (ovgPadding * (i + 1))),
        new geo.Point(br.x + (ovgPadding * (i + 1)), br.y + (ovgPadding * (i + 1))),
        new geo.Point(tl.x - (ovgPadding * (i + 1)), br.y + (ovgPadding * (i + 1))),
      ];

      for (const point of points) {
        const nearNode = guard.pointNearGraphNode(g, point);
        if (!nearNode) guard.addPoint(this, point);
      }
    }
    guard.check();
  }

  addTunnels(g, guard) {
    guard.check();
    const tunnels = buildTunnels(g, guard);
    for (const tunnel of tunnels) {
      guard.step();
      for (const entry of [tunnel.entryA, tunnel.entryB]) {
        guard.step();
        const candidate = entry.ovgNode;
        const canonical = guard.addNode(this, candidate);
        if (canonical !== candidate) {
          for (const [owner, metadata] of candidate.portOwners()) {
            guard.step();
            canonical.addPortMetadata(owner, metadata);
          }
          entry.ovgNode = canonical;
        }
        entry.ovgNode.isTunnel = true;
        if (!this.ports.has(entry.node)) this.ports.set(entry.node, []);
        this.ports.get(entry.node).push(entry.ovgNode);
      }

      guard.connect(this, tunnel.entryA.ovgNode, tunnel.entryB.ovgNode);
    }
    guard.check();
  }

  connectPortsToCenter(guard) {
    guard.check();
    for (const node of this.nodesInsideBoundingBox) {
      guard.step();
      const centerNode = guard.newCandidateNode(node.center());
      this.centers.set(node, centerNode);
      // We don't care that it's the center of an invisible node, since that's not special
      if (!node.isInvisible) centerNode.isNodeCenter = true;
      guard.addNodeUnchecked(this, centerNode);
      for (const portNode of this.ports.get(node) ?? []) {
        guard.connect(this, centerNode, portNode);
      }
    }
    guard.check();
  }

  mapNodesToContainer(g, guard) {
    guard.check();
    const dfsContainerOrder = guard.containerRDFSOrder(g, null);
    for (const ovgNode of this.nodes) {
      guard.step();
      for (const container of dfsContainerOrder) {
        guard.step();
        if (container.containsPointOnBox(ovgNode.point)) {
          ovgNode.container = container;
          break;
        }
      }
    }
  }

  /**
   * connectNodes connects all OVG nodes to the nearest node on the left, top, right and bottom if the edge doesn't go through any
   * graph node. It collects the nodes of each row and column, sorts each from smallest to largest by the opposite coordinate and
   * connects node[i] with node[i+1] unless the edge goes through a graph node (sweep line algorithm).
   */
  connectNodes(g, guard) {
    guard.check();
    if (this.edges.length > guard.edges) guard.reserveEdges(this.edges.length - guard.edges);
    // Create edges
    const horizontal = new Map();
    const vertical = new Map();
    let eligibleNodeCount = 0;
    for (const node of this.nodes) {
      guard.step();
      // Tunnels can only connect to each other (and to their node centers)
      if (node.isTunnel) continue;

      // sequence steps should only connect from certain sides
      const restricted = guard.isRestrictedSequencePort(node);
      if (restricted) continue;

      eligibleNodeCount++;
      appendTo(horizontal, node.y, node);
      appendTo(vertical, node.x, node);
    }

    const sortLines = (lines) => {
      const coords = [];
      for (const coord of lines.keys()) {
        guard.step();
        coords.push(coord);
      }
      guard.reserveSortWork(coords.length);
      coords.sort(numCmp);

      return coords;
    };

    // Each eligible node appears in one horizontal and one vertical sweep. The two sweeps therefore add at most (n-h) + (n-v) edges.
    const h = horizontal.size;
    const v = vertical.size;
    checkedOVGEdgeCapacity(this.edges.length, eligibleNodeCount, h, v, guard.limits.edges, Number.MAX_SAFE_INTEGER);
    // we need to copy existing edges (e.g., we already connect the nodes when adding tunnels)
    this.edges = this.edges.slice();
    const boundingNodes = this.nodesInsideBoundingBox;
    const fixedOverlaps = fixedOverlapsForBuild(this, g, boundingNodes, guard);
    const horizontalLines = sortLines(horizontal);
    for (const y of horizontalLines) {
      guard.step();
      this.connectNodesOnSameLine(horizontal.get(y), y, true, fixedOverlaps, guard);
    }

    const verticalLines = sortLines(vertical);
    for (const x of verticalLines) {
      guard.step();
      this.connectNodesOnSameLine(vertical.get(x), x, false, fixedOverlaps, guard);
    }
  }

  /**
   * connectNodesOnSameLine connects nodes on the same horizontal/vertical line. The nodes MUST be on the same line, so they are
   * sorted and the connection is just connecting to the next node in the list. See connectNodes for more details.
   */
  connectNodesOnSameLine(nodes, linePosition, isHorizontal, fixedOverlaps, guard) {
    guard.check();

    const intersectCandidates = [];
    for (const node of this.nodesInsideBoundingBox) {
      guard.step();
      if (fixedOverlaps.has(node)) continue;
      if (isHorizontal && node.topLeft.y <= linePosition && node.topLeft.y + node.height >= linePosition) {
        intersectCandidates.push(node);
      } else if (!isHorizontal && node.topLeft.x <= linePosition && node.topLeft.x + node.width >= linePosition) {
        intersectCandidates.push(node);
      }
    }
    guard.reserveSortWork(intersectCandidates.length);

    sortSlice(intersectCandidates, (i, j) => {
      if (isHorizontal) return intersectCandidates[i].topLeft.x < intersectCandidates[j].topLeft.x;
      return intersectCandidates[i].topLeft.y < intersectCandidates[j].topLeft.y;
    });

    guard.reserveSortWork(nodes.length);
    sortSlice(nodes, (i, j) => {
      if (isHorizontal) return nodes[i].x < nodes[j].x;
      return nodes[i].y < nodes[j].y;
    });

    let startIntersectionSearchAt = 0;
    for (let i = 0; i < nodes.length - 1; i++) {
      guard.step();
      const node = nodes[i];
      const closest = nodes[i + 1];
      const misdirected = this.isMisdirectedPortPair(node, closest, isHorizontal, guard);
      if (misdirected) continue;

      let shouldConnect = true;
      for (let j = startIntersectionSearchAt; j < intersectCandidates.length; j++) {
        guard.step();
        const rectangle = intersectCandidates[j];
        if ((isHorizontal && rectangle.topLeft.x > closest.x) || (!isHorizontal && rectangle.topLeft.y > closest.y)) {
          // here, rectangle is after closest to the right or to the bottom; since intersectCandidates is sorted, no other nodes
          // will intersect, so we can skip the test
          break;
        }

        const passesThrough = (from, to) => {
          let passes = true;
          directionsAny(from.portDirectionsForObstacle(rectangle), (direction) => {
            const pt = guard.passesThroughAllowingPorts(rectangle, from.point, to.point, direction, this.ports.get(rectangle) ?? []);
            if (!pt) {
              passes = false;
              return true;
            }
            return false;
          });
          return passes;
        };
        const c1 = passesThrough(node, closest);
        const c2 = passesThrough(closest, node);
        if (c1 && c2) {
          if (rectangle.sequence !== null) {
            // sequences will have top and bottom ports overlapped by previous sequence nodes, but this overlap shouldn't prevent
            // a connection with that port
            if (!isHorizontal) {
              if (rectangle.topLeft.y === closest.y || rectangle.topLeft.y + rectangle.height === node.y) continue;
            }
          }
          // Passing through a container is okay ...
          let isContainerException = false;
          if (rectangle.isContainer()) {
            // ... if at least one of the nodes is within the container
            if (rectangle.containsPointOnBox(node.point) || rectangle.containsPointOnBox(closest.point)) isContainerException = true;
          }

          if (!isContainerException) {
            shouldConnect = false;
            break;
          }
        } else {
          // this node didn't intersect with the current OVG, so we don't need to check any other nodes prior to it for the next
          // OVG nodes (the loop is on top of sorted nodes)
          startIntersectionSearchAt = j;
        }
      }

      if (shouldConnect) guard.connect(this, node, closest);
    }
  }

  /** Note: assumes first node is left(IsHorizontal=true) or above(IsHorizontal=false) second */
  isMisdirectedPortPair(first, second, isHorizontal, guard) {
    guard.check();
    const firstOwners = first.portOwners();
    const secondOwners = second.portOwners();
    if (firstOwners.size === 0 || secondOwners.size === 0) {
      guard.check();
      return false;
    }

    // A shared point can represent ports of several touching nodes. Reject the connection only if every possible owner pair is
    // misdirected; one valid interpretation is enough to make the OVG segment usable.
    for (const [firstOwner, firstMetadata] of firstOwners) {
      guard.step();
      for (const [secondOwner, secondMetadata] of secondOwners) {
        guard.step();
        if (firstOwner === secondOwner) return false;

        // Since first is left/above second, at least one pair of roles must face each other (not the other way around).
        let correctDirections = directionsHas(firstMetadata.directions, Orientation.Bottom) && directionsHas(secondMetadata.directions, Orientation.Top);
        if (isHorizontal) {
          correctDirections = directionsHas(firstMetadata.directions, Orientation.Right) && directionsHas(secondMetadata.directions, Orientation.Left);
        }
        // ports must face each other unless it is a descendant and an ancestor
        const firstBelowSecond = guard.isDescendantOf(firstOwner, secondOwner);
        const secondBelowFirst = guard.isDescendantOf(secondOwner, firstOwner);
        if (correctDirections || firstBelowSecond || secondBelowFirst) return false;
      }
    }
    guard.check();
    return true;
  }

  /**
   * createPortsConnectionsToBoundaries will create paths for isolated graph nodes. If the ports of a given node don't have a clear
   * path to the graph boundaries we might not be able to trace a route to this node; this adds a padded port node and nodes at the
   * graph boundaries that they can connect to (see ovg.go for the drawing).
   */
  createPortsConnectionsToBoundaries(owner, ports, tl, br, guard) {
    guard.check();
    const seenPorts = new Set();
    for (const port of ports) {
      guard.step();
      if (seenPorts.has(port)) continue;
      seenPorts.add(port);
      const [portDirections] = port.portDirectionsFor(owner);
      directionsAny(portDirections, (portDirection) => {
        guard.step();
        let newPoint;
        switch (portDirection) {
          case Orientation.Top:
            newPoint = geo.newPoint(port.x, port.y - MinPortClearance);
            break;
          case Orientation.Bottom:
            newPoint = geo.newPoint(port.x, port.y + MinPortClearance);
            break;
          case Orientation.Left:
            newPoint = geo.newPoint(port.x - MinPortClearance, port.y);
            break;
          case Orientation.Right:
            newPoint = geo.newPoint(port.x + MinPortClearance, port.y);
            break;
          default:
            return false;
        }
        const newNode = guard.addPoint(this, newPoint);

        // add nodes at the OVG boundary to connect with this new node
        for (let i = 1; i < extraInterestingPointLayers + 1; i++) {
          guard.step();
          switch (portDirection) {
            case Orientation.Top:
            case Orientation.Bottom:
              // left boundary
              guard.addPoint(this, geo.newPoint(tl.x - (ovgPadding * i), newNode.y));
              // right boundary
              guard.addPoint(this, geo.newPoint(br.x + (ovgPadding * i), newNode.y));
              break;
            case Orientation.Left:
            case Orientation.Right:
              // top boundary
              guard.addPoint(this, geo.newPoint(newNode.x, tl.y - (ovgPadding * i)));
              // bottom boundary
              guard.addPoint(this, geo.newPoint(newNode.x, br.y + (ovgPadding * i)));
              break;
          }
        }
        return false;
      });
    }
    guard.check();
  }

  /**
   * flagNodesNearPorts finds OVG Nodes that are lined up and too close to ports as they should be penalized during edge routing.
   * For each port, for each lined up adjacent: if adj is not too close continue, else flag adj as too close and follow its edges as
   * other nodes can be too close.
   */
  flagNodesNearPorts(guard) {
    guard.check();
    for (const [owner, ports] of this.ports) {
      guard.step();
      for (const port of ports) {
        guard.step();
        const seen = new Set();
        seen.add(port);
        let queue = [];
        for (const e of port.edges) {
          guard.step();
          const adj = port.adjacent_(e);
          if (adj.x !== port.x && adj.y !== port.y) continue;
          queue.push(adj);
        }
        let qi = 0;
        while (qi < queue.length) {
          guard.step();
          const curr = queue[qi++];
          if (seen.has(curr)) continue;
          seen.add(curr);

          // only check non-ports, or ports of other nodes; but, if adj is a port of the current graph node, also follow its adjacents
          if (!curr.isPortOf(owner)) {
            if (Math.abs(curr.y - port.y) >= nodeProximityThreshold) {
              // the current node is not too close to the port, so no need to investigate the adjacents
              continue;
            }
            if (Math.abs(curr.x - port.x) >= nodeProximityThreshold) continue;

            if (curr.isNearPort === null) curr.isNearPort = new Set();
            // `curr` is near the port
            curr.isNearPort.add(owner);
          }

          // follow other nodes, as they be near too
          for (const e of curr.edges) {
            guard.step();
            const adj = curr.adjacent_(e);
            if (adj.x !== port.x && adj.y !== port.y) continue;
            queue.push(adj);
          }
        }
      }
    }
    guard.check();
  }

  /** MarshalJSON: the object json.Marshal would print ({nodes:[{x,y}], edges:[{from,to}]}), nodes and edges sorted. */
  marshalJSON() {
    const serialized = { nodes: [], edges: [] };

    const nodeOrder = (n1, n2) => {
      if (n1.x === n2.x) return n1.y < n2.y;
      return n1.x < n2.x;
    };

    const sortedNodes = this.nodes.slice();
    sortSlice(sortedNodes, (i, j) => nodeOrder(sortedNodes[i], sortedNodes[j]));
    for (const node of sortedNodes) serialized.nodes.push({ x: node.x, y: node.y });

    const sortedEdges = this.edges.slice();
    sortSlice(sortedEdges, (i, j) => {
      if (sortedEdges[i].from === sortedEdges[j].from) return nodeOrder(sortedEdges[i].to, sortedEdges[j].to);
      return nodeOrder(sortedEdges[i].from, sortedEdges[j].from);
    });
    for (const edge of sortedEdges) {
      serialized.edges.push({ from: { x: edge.from.x, y: edge.from.y }, to: { x: edge.to.x, y: edge.to.y } });
    }
    return serialized;
  }

  /** UnmarshalJSON: `serialized` is the parsed {nodes, edges} object; the OVG is reset to the decoded graph. */
  unmarshalJSON(serialized) {
    const fresh = new OVG(null);
    Object.assign(this, fresh);
    const positionToNode = new PointMap();
    for (const node of serialized.nodes) {
      const n = new OVGNode(geo.newPoint(node.x, node.y));
      this.addNodeUnchecked(n);
      positionToNode.set(n.point, n);
    }

    for (const edge of serialized.edges) {
      const from = geo.newPoint(edge.from.x, edge.from.y);
      const to = geo.newPoint(edge.to.x, edge.to.y);

      const fromNode = positionToNode.get(from);
      const toNode = positionToNode.get(to);
      if (fromNode === undefined || toNode === undefined) {
        throw new Error(`OVG edge references a missing endpoint: ${from} -> ${to}`);
      }
      this.connect(fromNode, toNode);
    }
  }

  mergePorts(other, guard) {
    guard.check();
    for (const [n, ports] of other.ports) {
      guard.reserveWork(ports.length + 1);
      const canonicalPorts = new Array(ports.length);
      for (let i = 0; i < ports.length; i++) {
        const port = ports[i];
        const canonical = guard.addNode(this, port);
        if (canonical !== port) {
          for (const [owner, metadata] of port.portOwners()) {
            guard.step();
            canonical.addPortMetadata(owner, metadata);
          }
        }
        canonicalPorts[i] = canonical;
      }
      this.ports.set(n, canonicalPorts);
    }
    guard.reserveWork(other.nodesInsideBoundingBox.length);
    this.nodesInsideBoundingBox = this.nodesInsideBoundingBox.concat(other.nodesInsideBoundingBox);
    guard.check();
  }

  mergeNonPorts(other, guard) {
    guard.check();
    for (const n of other.nodes) {
      guard.step();
      if (!n.isPort()) guard.addNode(this, n);
    }
    guard.check();
  }
}

// ovg_hierarchy.go's methods of OVG
for (const name of ['addHierarchyLevelNodes', 'addBoundaryNodesAboveLevelNodes', 'addPortAlignedNodes', 'addLevelNodes', 'transpose', 'transformHierarchyOVGNodes']) {
  OVG.prototype[name] = hier[name];
}

function appendTo(map, key, value) {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}

export function newOVG(nodesInsideBoundingBox) {
  return new OVG(nodesInsideBoundingBox);
}

export function newBuildOVG(nodesInsideBoundingBox, guard) {
  const ovg = newOVG(nodesInsideBoundingBox);
  ovg.buildGuard = guard;
  return ovg;
}

/** buildOVGFromGraphWithLimits(ctx, g, nearbyNodes, limits) */
export function buildOVGFromGraphWithLimits(ctx, g, nearbyNodes, ovgLimits) {
  const guard = newOVGBuildGuard(ctx, ovgLimits);
  return buildOVGFromGraphWithGuard(g, nearbyNodes, guard);
}

export function buildOVGFromGraphWithGuard(g, nearbyNodes, guard) {
  guard.check();
  const orthogonalNodeCapacity = checkedOVGSliceCapacity(g.nodes.length, nearbyNodes.length);
  void orthogonalNodeCapacity;
  const orthogonalNodes = [];
  orthogonalNodes.push(...nearbyNodes);

  const hierarchyOVGs = [];
  const seenHierarchies = new Set();
  for (const n of g.nodes) {
    guard.step();
    if (n.hierarchy === null) {
      orthogonalNodes.push(n);
    } else if (!seenHierarchies.has(n.hierarchy)) {
      seenHierarchies.add(n.hierarchy);
      const hierarchyOVG = newOVGForHierarchy(g, n.hierarchy, guard);
      hierarchyOVGs.push(hierarchyOVG);
    }
  }

  const ovg = newBuildOVG(orthogonalNodes, guard);
  ovg.addPorts(g, guard);
  for (const hOVG of hierarchyOVGs) {
    guard.step();
    ovg.mergePorts(hOVG, guard);
  }
  ovg.addNodesIntersections(g, guard);
  for (const hOVG of hierarchyOVGs) {
    guard.step();
    ovg.mergeNonPorts(hOVG, guard);
  }

  ovg.addEdgesNodes(g, guard);
  ovg.addTreeNodes(g, guard);
  const [tl, br] = guard.tightBoundingBox(ovg.nodesInsideBoundingBox);
  ovg.addNewBoundaryLayers(g, tl, br, guard);
  ovg.addPortConnectionNodesAtBoundaries(g, tl, br, guard);
  ovg.addCornerNodes(g, tl, br, guard);
  ovg.addTunnels(g, guard);

  // TODO if any OVG nodes are too close to container edge, split them
  ovg.connectNodes(g, guard);
  ovg.connectPortsToCenter(guard);
  ovg.removeIsolatedNodes(guard);
  ovg.mapNodesToContainer(g, guard);
  ovg.flagNodesNearPorts(guard);
  for (let i = 0; i < ovg.nodes.length; i++) {
    guard.step();
    ovg.nodes[i].index = i;
  }

  return ovg;
}

export { nonNilEquals };
