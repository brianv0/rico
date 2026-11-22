// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of the Go package d2layouts/d2talalayout/internal/routing (D2 v0.9.0), file(s): tree_routes.go.

import * as geo from '../../geo.js';
import { TreeParentSpacing } from '../layoutgraph.js';
import { OVGNode } from './ovg_node.js';
import { nonNilEquals } from './ovg_edge.js';
import { treeChildAlignmentTolerance } from './tuning.js';

/** TreeEdgePath: { sourcePortNode, targetPortNode, sourceMidpoint, targetMidpoint, sourceOrientationToTarget } */
export function isSentinelEdgeSource(tree) {
  return tree !== null && tree.sentinelEdge !== null && tree.sentinelEdge.from === tree.node;
}

/** get the S-shaped path information for the tree node's sentinelEdge */
export function treeEdgePath(t, portNodes, portArrowheads) {
  return treeEdgePathForBuild(t, portNodes, portArrowheads, null);
}

export function treeEdgePathForBuild(t, portNodes, portArrowheads, guard) {
  const step = () => {
    if (guard === null) return;
    guard.step();
  };
  step();
  const parent = t.sentinelNode();
  const child = t.node;

  const parentPortIndex = parent.centerPortIndex(t.orientation);
  const childPortIndex = child.centerPortIndex(geo.getOpposite(t.orientation));
  let parentPortNode = portNodes.get(parent)[parentPortIndex];
  let childPortNode = portNodes.get(child)[childPortIndex];

  const arrowheads = portArrowheads.get(parentPortNode);
  if (arrowheads !== undefined) {
    // check the arrowhead on the parent
    let arrowhead = t.sentinelEdge.targetArrowhead;
    if (!isSentinelEdgeSource(t)) arrowhead = t.sentinelEdge.sourceArrowhead;
    if (arrowheads.size > 0) {
      if (!arrowheads.has(arrowhead)) {
        let closestPort = null;
        let closestDistance = Infinity;
        // try to find a different port since we have a mismatched arrowhead
        for (const portIndex of parent.portIndices(t.orientation)) {
          step();
          if (portIndex === parentPortIndex) continue;
          let usePort = false;
          const port = portNodes.get(parent)[portIndex];
          const portHeads = portArrowheads.get(port);
          if (portHeads === undefined) usePort = true;
          else if (portHeads.has(arrowhead)) usePort = true;
          if (usePort) {
            const distance = geo.euclideanDistance(port.point.x, port.point.y, childPortNode.x, childPortNode.y);
            if (distance < closestDistance) {
              closestPort = port;
              closestDistance = distance;
            }
          }
        }
        if (closestPort !== null) parentPortNode = closestPort;
      }
    }
  }

  childPortNode = alignedPortNodeForBuild(t, parentPortNode, childPortNode, guard);
  // alignedPortNodeForBuild may synthesize a port so that a nearly aligned tree edge stays straight. addTreeNodes canonicalizes that
  // coordinate into the OVG and records it in the child's port list. Resolve it here on subsequent route lookups; otherwise
  // child-as-source routing starts from a fresh node with no OVG edges, and shared points lose their canonical owner metadata.
  for (const portNode of portNodes.get(child)) {
    step();
    if (nonNilEquals(portNode.point, childPortNode.point)) {
      childPortNode = portNode;
      break;
    }
  }

  const [parentMidpoint, childMidpoint] = treeEdgeMidpoints(parent, t.orientation, parentPortNode.point, childPortNode.point);

  // if we are the target, swap these around
  if (isSentinelEdgeSource(t)) {
    return {
      sourcePortNode: childPortNode,
      targetPortNode: parentPortNode,
      sourceMidpoint: childMidpoint,
      targetMidpoint: parentMidpoint,
      sourceOrientationToTarget: t.orientation,
    };
  }
  return {
    sourcePortNode: parentPortNode,
    targetPortNode: childPortNode,
    sourceMidpoint: parentMidpoint,
    targetMidpoint: childMidpoint,
    sourceOrientationToTarget: geo.getOpposite(t.orientation),
  };
}

export function alignedPortNodeForBuild(tree, parentPort, childPort, guard) {
  const isWithinThreshold = (a, b, t) => Math.abs(a - b) <= t;
  const parent = tree.sentinelNode();
  const child = tree.node;

  const endOfNodeBuffer = 5.0;

  // in some cases, parent.center = (100.5, 100) and child.center = (100, 150)
  // however, this is just a rounding error and then we compare equality by upto 1 in difference
  const nodesAreVerticallyAligned = isWithinThreshold(parent.center().x, child.center().x, treeChildAlignmentTolerance);
  const portsAreVerticallyMisaligned = parentPort.x !== childPort.x;
  if (geo.isVertical(tree.orientation) && nodesAreVerticallyAligned && portsAreVerticallyMisaligned) {
    if (child.topLeft.x + endOfNodeBuffer < parentPort.x && parentPort.x < child.topLeft.x + child.width - endOfNodeBuffer) {
      if (guard !== null) return guard.newDerivedNode(geo.newPoint(parentPort.x, childPort.y));
      return new OVGNode(geo.newPoint(parentPort.x, childPort.y));
    }
  }

  const nodesAreHorizontallyAligned = isWithinThreshold(parent.center().y, child.center().y, treeChildAlignmentTolerance);
  const portsAreHorizontallyMisaligned = parentPort.y !== childPort.y;
  if (geo.isHorizontal(tree.orientation) && nodesAreHorizontallyAligned && portsAreHorizontallyMisaligned) {
    if (child.topLeft.y + endOfNodeBuffer < parentPort.y && parentPort.y < child.topLeft.y + child.height - endOfNodeBuffer) {
      if (guard !== null) return guard.newDerivedNode(geo.newPoint(childPort.x, parentPort.y));
      return new OVGNode(geo.newPoint(childPort.x, parentPort.y));
    }
  }

  return childPort;
}

/**
 * treeEdgeMidpoints computes the two bends in a tree edge's S-shaped route. The bend distance is relative to the parent, even when
 * the child is farther away to accommodate an edge label.
 */
export function treeEdgeMidpoints(parent, treeOrientation, parentPortPosition, childPortPosition) {
  const parentMidpoint = new geo.Point();
  const childMidpoint = new geo.Point();
  switch (treeOrientation) {
    case geo.Orientation.Left: {
      parentMidpoint.y = parentPortPosition.y;
      childMidpoint.y = childPortPosition.y;
      const centerX = parent.topLeft.x - TreeParentSpacing / 2;
      parentMidpoint.x = centerX;
      childMidpoint.x = centerX;
      break;
    }
    case geo.Orientation.Right: {
      parentMidpoint.y = parentPortPosition.y;
      childMidpoint.y = childPortPosition.y;
      const centerX = parent.topLeft.x + parent.width + TreeParentSpacing / 2;
      parentMidpoint.x = centerX;
      childMidpoint.x = centerX;
      break;
    }
    case geo.Orientation.Top: {
      parentMidpoint.x = parentPortPosition.x;
      childMidpoint.x = childPortPosition.x;
      const centerY = parent.topLeft.y - TreeParentSpacing / 2;
      parentMidpoint.y = centerY;
      childMidpoint.y = centerY;
      break;
    }
    case geo.Orientation.Bottom: {
      parentMidpoint.x = parentPortPosition.x;
      childMidpoint.x = childPortPosition.x;
      const centerY = parent.topLeft.y + parent.height + TreeParentSpacing / 2;
      parentMidpoint.y = centerY;
      childMidpoint.y = centerY;
      break;
    }
  }
  return [parentMidpoint, childMidpoint];
}
