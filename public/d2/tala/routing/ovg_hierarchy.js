// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of the Go package d2layouts/d2talalayout/internal/routing (D2 v0.9.0), file(s): ovg_hierarchy.go.
//
// `hierarchy.IsHorizontal` is the one function of the (not yet ported) hierarchy package this file needs: see ./deps.js.

import * as geo from '../../geo.js';
import { goInt } from '../../gomath.js';
import { sortSlice } from '../../gosort.js';
import { newBuildOVG } from './ovg.js';
import { directionsTransformed } from './ovg_node.js';
import { ovgPadding } from './tuning.js';
import { hierarchy as hierarchyDeps } from './deps.js';

const { Orientation } = geo;

/** the hierarchy level of a node (Go: Node.HierarchyLevel(): n.Hierarchy.level[n], 0 when missing). */
const hierarchyLevel = (n) => n.hierarchy.level.get(n) ?? 0;

// The methods of OVG that ovg_hierarchy.go defines are functions with `this` = the OVG, installed on OVG's prototype by ovg.js
// (`ovg.addHierarchyLevelNodes(...)` calls `addHierarchyLevelNodes.call(ovg, ...)`), so this module does not import the class.
export function newOVGForHierarchy(g, h, guard) {
  guard.check();
  // only for SQL Table hierarchies
  // ports must be added before we transpose because transpose can change the node size and then the ports positions
  // (see ovg_hierarchy.go for the drawing): adding the ports first and then transposing them later with the node gives the
  // expected result, adding them after transposing creates them in the wrong position
  const levels = h.levels();
  const nodes = [];
  for (const n of levels.keys()) {
    guard.step();
    nodes.push(n);
  }
  guard.reserveSortWork(nodes.length);
  nodes.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)); // slices.SortFunc(cmp.Compare(a.ID, b.ID)): IDs are unique
  guard.check();

  const defers = [];
  try {
    const ovg = newBuildOVG(nodes, guard);
    ovg.addPorts(g, guard);

    // if the current direction is Left or Top, we need to mirror for the OVG creation, then mirror back at the very end
    switch (nodes[0].containerDirection()) {
      case Orientation.Left:
        guard.reserveHierarchyTransform(ovg, nodes.length);
        for (const node of nodes) node.mirror(true, false);
        ovg.transformHierarchyOVGNodes((node) => {
          node.x = -node.x;
        }, (direction) => mirrorPortDirection(direction, true, false));
        defers.push(() => {
          for (const node of nodes) node.mirror(true, false);
          ovg.transformHierarchyOVGNodes((node) => {
            node.x = -node.x;
          }, (direction) => mirrorPortDirection(direction, true, false));
        });
        guard.check();
        break;
      case Orientation.Top:
        guard.reserveHierarchyTransform(ovg, nodes.length);
        for (const node of nodes) node.mirror(false, true);
        ovg.transformHierarchyOVGNodes((node) => {
          node.y = -node.y;
        }, (direction) => mirrorPortDirection(direction, false, true));
        defers.push(() => {
          for (const node of nodes) node.mirror(false, true);
          ovg.transformHierarchyOVGNodes((node) => {
            node.y = -node.y;
          }, (direction) => mirrorPortDirection(direction, false, true));
        });
        guard.check();
        break;
    }

    // the hierarchy must be Top to Bottom, Left to Right when creating the OVG
    // if `isHorizontalHierarchy`, the hierarchy is transposed to vertical, the OVG is created, and then transposed back
    guard.reserveWork(nodes.length);
    const isHorizontalHierarchy = hierarchyDeps.isHorizontal(nodes);
    if (isHorizontalHierarchy) {
      guard.reserveHierarchyTransform(ovg, ovg.nodesInsideBoundingBox.length);
      ovg.transpose();
      defers.push(() => {
        ovg.transpose();
      });
      guard.check();
    }

    ovg.addNodesIntersections(g, guard);
    ovg.addHierarchyLevelNodes(g, h, guard);
    const [tl, br] = guard.ovgBoundingBox(ovg);
    ovg.addNewBoundaryLayers(g, tl, br, guard);
    ovg.addCornerNodes(g, tl, br, guard);
    guard.check();

    return ovg;
  } finally {
    for (let i = defers.length - 1; i >= 0; i--) defers[i]();
  }
}

export function addHierarchyLevelNodes(g, hierarchy, guard) {
  guard.check();
  const levelToNodes = new Map();
  for (const [n, level] of hierarchy.levels()) {
    guard.step();
    if (!levelToNodes.has(level)) levelToNodes.set(level, []);
    levelToNodes.get(level).push(n);
  }
  for (let level = 0; level < levelToNodes.size; level++) {
    guard.step();
    const list = levelToNodes.get(level) ?? [];
    guard.reserveSortWork(list.length);
    sortSlice(list, (i, j) => list[i].topLeft.x < list[j].topLeft.x);
  }
  const [tl, br] = guard.ovgBoundingBox(this);
  // Align the bounds to ovgPadding so OVG nodes line up across levels.
  // Subtract one interval to leave at least one OVG node before the first node.
  tl.x -= ovgPadding;
  tl.x = Math.floor(tl.x / ovgPadding) * ovgPadding;
  const width = Math.ceil((br.x - tl.x) / ovgPadding) * ovgPadding;
  // Add one interval to leave at least one OVG node after the last node.
  br.x = tl.x + width + ovgPadding;
  const ys = new Set();
  for (let level = 1; level < levelToNodes.size; level++) {
    guard.step();
    const levelYs = this.addBoundaryNodesAboveLevelNodes(levelToNodes.get(level - 1) ?? [], levelToNodes.get(level) ?? [], tl.x, br.x, guard);
    this.addPortAlignedNodes(levelToNodes.get(level - 1) ?? [], levelToNodes.get(level) ?? [], levelYs, guard);
    for (const y of levelYs) ys.add(y);
  }

  const xs = this.addLevelNodes(levelToNodes, tl.x, br.x, guard);
  this.addIntersections(g, xs, ys, guard);
}

/**
 * addBoundaryNodesAboveLevelNodes adds nodes between two levels at the graph boundaries (see ovg_hierarchy.go for the drawing).
 * Note: boundary nodes are padded considering the "tl, br" change in `ovg.forHierarchicalGraph`. Returns the Y coordinates.
 */
export function addBoundaryNodesAboveLevelNodes(nodesAbove, nodesBelow, leftX, rightX, guard) {
  guard.check();
  let nodesBelowMinY = Infinity;
  let nEdgesAbove = 1.0;
  for (const node of nodesBelow) {
    guard.step();
    // top is the closest to 0, 0 in SVG space
    nodesBelowMinY = Math.min(nodesBelowMinY, node.topLeft.y);
    for (const e of node.edges) {
      guard.step();
      const adj = node.adjacent(e);
      if (e.isLoop() || adj.hierarchy === null) {
        // hierarchical nodes can be connected to nodes outside the hierarchy
        continue;
      }
      if (hierarchyLevel(adj) < hierarchyLevel(node)) nEdgesAbove++;
    }
  }

  let nodesAboveMaxY = -Infinity;
  for (const node of nodesAbove) {
    guard.step();
    nodesAboveMaxY = Math.max(nodesAboveMaxY, node.topLeft.y + node.height);
  }

  const levelDistance = (nodesBelowMinY - nodesAboveMaxY);
  const maxHorizontalLines = levelDistance / ovgPadding;
  const nHorizontalLines = Math.min(nEdgesAbove, maxHorizontalLines);
  let pad = Math.ceil(levelDistance / nHorizontalLines);
  pad = Math.max(pad, ovgPadding);

  // these will form the horizontal lines above `nodesBelow`
  const ys = [];
  let y = nodesBelowMinY;
  const count = goInt(nHorizontalLines) - 1;
  for (let i = 0; i < count; i++) {
    guard.step();
    y -= pad;
    ys.push(y);
    guard.addPoint(this, geo.newPoint(leftX, y));
    guard.addPoint(this, geo.newPoint(rightX, y));
  }
  guard.check();
  return ys;
}

/** addPortAlignedNodes adds OVG Nodes aligned with ports (up/down) at the Y coordinates of the level (see ovg_hierarchy.go). */
export function addPortAlignedNodes(nodesAbove, nodesBelow, ys, guard) {
  guard.check();
  for (const y of ys) {
    guard.step();
    for (const node of nodesAbove) {
      guard.step();
      const ports = guard.portsByOrientation(this, node, Orientation.Bottom);
      for (const port of ports) guard.addPoint(this, geo.newPoint(port.x, y));
    }
    for (const node of nodesBelow) {
      guard.step();
      const ports = guard.portsByOrientation(this, node, Orientation.Top);
      for (const port of ports) guard.addPoint(this, geo.newPoint(port.x, y));
    }
  }
  guard.check();
}

/** addLevelNodes creates port aligned nodes between ordered siblings. Returns the X coordinate of added nodes (a Set). */
export function addLevelNodes(levelToNodes, minXBound, maxXBound, guard) {
  guard.check();
  const xs = new Set();
  for (let l = 0; l < levelToNodes.size; l++) {
    guard.step();
    let isLastNode = false;
    let ni = 0;
    let node = levelToNodes.get(l)[ni];
    let ports = guard.portsByOrientation(this, node, Orientation.Left);
    for (let x = minXBound; x <= maxXBound; x += ovgPadding) {
      guard.step();
      xs.add(x);
      for (const port of ports) guard.addPoint(this, geo.newPoint(x, port.y));
      if (!isLastNode && x >= node.topLeft.x - ovgPadding) {
        // set `x` as the next X coordinate aligned with "common OVG nodes" (see the method docs)
        const nextX = node.topLeft.x + node.width;
        x = Math.ceil(nextX / ovgPadding) * ovgPadding;
        // now use the ports on the right of this node
        ports = guard.portsByOrientation(this, node, Orientation.Right);
        isLastNode = ni === levelToNodes.get(l).length - 1;
        if (!isLastNode) {
          // if there is other node to the right, use the left ports of this node too
          ni++;
          node = levelToNodes.get(l)[ni];
          const leftPorts = guard.portsByOrientation(this, node, Orientation.Left);
          ports = ports.concat(leftPorts);
        }
      }
    }
  }
  guard.check();
  return xs;
}

export function transpose() {
  // Transpose each canonical OVG point and each owner's complete direction set once. Ports may appear multiple times in Ports
  // when rounded snap points coincide, so iterating those slices would toggle shared points and metadata more than once.
  this.transformHierarchyOVGNodes((node) => {
    const t = node.point.x;
    node.point.x = node.point.y;
    node.point.y = t;
  }, transposePortDirection);
  for (const node of this.nodesInsideBoundingBox) node.transpose();
}

export function transformHierarchyOVGNodes(transformPoint, transformDirection) {
  for (const node of this.nodes) {
    transformPoint(node);
    for (const [owner, metadata] of [...node.portOwners()]) {
      node.setPortDirections(owner, directionsTransformed(metadata.directions, transformDirection));
    }
  }
  this.reindexOccupiedPoints();
}

export function transposePortDirection(direction) {
  switch (direction) {
    case Orientation.Top: return Orientation.Left;
    case Orientation.Bottom: return Orientation.Right;
    case Orientation.Left: return Orientation.Top;
    case Orientation.Right: return Orientation.Bottom;
    case Orientation.TopRight: return Orientation.BottomLeft;
    case Orientation.BottomLeft: return Orientation.TopRight;
    default: return direction;
  }
}

export function mirrorPortDirection(direction, x, y) {
  if (x) {
    switch (direction) {
      case Orientation.Left: direction = Orientation.Right; break;
      case Orientation.Right: direction = Orientation.Left; break;
      case Orientation.TopLeft: direction = Orientation.TopRight; break;
      case Orientation.TopRight: direction = Orientation.TopLeft; break;
      case Orientation.BottomLeft: direction = Orientation.BottomRight; break;
      case Orientation.BottomRight: direction = Orientation.BottomLeft; break;
    }
  }
  if (y) {
    switch (direction) {
      case Orientation.Top: direction = Orientation.Bottom; break;
      case Orientation.Bottom: direction = Orientation.Top; break;
      case Orientation.TopLeft: direction = Orientation.BottomLeft; break;
      case Orientation.TopRight: direction = Orientation.BottomRight; break;
      case Orientation.BottomLeft: direction = Orientation.TopLeft; break;
      case Orientation.BottomRight: direction = Orientation.TopRight; break;
    }
  }
  return direction;
}
