// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of the Go package d2layouts/d2talalayout/internal/graphbounds (D2 v0.9.0): work-accounted node-set and fixed-origin
// bounds shared by packing and routing. `guard` is a workStepper (step()/finish(); a limits.WorkGuard or layoutgraph's unbounded one):
// bounds never create or reset a budget, every scan is charged to the caller's guard. Points are geo.Point; errors are thrown.

import * as geo from '../geo.js';
import * as label from '../label.js';
import { goRound } from './../gomath.js';
import * as invariant from './invariant.js';
import * as lg from './layoutgraph.js';

const { Orientation } = geo;

function isExtreme(nodes, node, disqualifies, guard) {
  for (const other of nodes) {
    guard.step();
    if (other === node || other.topLeft === null) continue;
    if (disqualifies(other)) return false;
  }
  return true;
}

/**
 * NodeBoundingBox computes the packing-compatible bounds for one placed node: [topLeft, bottomRight]. When allNodes is non-null, outside
 * labels and icons reserve their exact boundary space and outside-label extremity scans consume the shared work budget.
 */
export function nodeBoundingBox(node, allNodes, guard) {
  guard.step();
  if (node === null || node === undefined || node.topLeft === null) throw invariant.newError('BinPack bounding box contains an unplaced node');
  const topLeft = node.topLeft.copy();
  const bottomRight = geo.newPoint(goRound(topLeft.x + node.width), goRound(topLeft.y + node.height));
  const [dx, dy] = node.modifierElementAdjustments();
  if (dx !== 0 || dy !== 0) {
    topLeft.y -= dy;
    bottomRight.x += dx;
  }
  topLeft.x -= node.loopOffset(Orientation.Left);
  topLeft.y -= node.loopOffset(Orientation.Top);
  bottomRight.x += node.loopOffset(Orientation.Right);
  bottomRight.y += node.loopOffset(Orientation.Bottom);

  if (node.label !== null && label.isOutside(node.label.position) && allNodes !== null) {
    const labelTopLeft = node.labelTopLeft(node.label.position, node.label.width, node.label.height);
    const boundaryPadding = label.PADDING;
    const outsidePadding = 2. * label.PADDING;
    if (labelTopLeft.x < topLeft.x) {
      const extreme = isExtreme(allNodes, node, (other) => other.topLeft.x < node.topLeft.x, guard);
      topLeft.x = Math.floor(labelTopLeft.x - (extreme ? boundaryPadding : outsidePadding));
    }
    if (labelTopLeft.y < topLeft.y) {
      const extreme = isExtreme(allNodes, node, (other) => other.topLeft.y < node.topLeft.y, guard);
      topLeft.y = Math.floor(labelTopLeft.y - (extreme ? boundaryPadding : outsidePadding));
    }
    if (labelTopLeft.x > bottomRight.x) {
      const extreme = isExtreme(allNodes, node, (other) => other.topLeft.x + other.width > node.topLeft.x + node.width, guard);
      bottomRight.x = Math.ceil(labelTopLeft.x + node.label.width + (extreme ? boundaryPadding : outsidePadding));
    }
    if (labelTopLeft.y > bottomRight.y) {
      const extreme = isExtreme(allNodes, node, (other) => other.topLeft.y + other.height > node.topLeft.y + node.height, guard);
      bottomRight.y = Math.ceil(labelTopLeft.y + node.label.height + (extreme ? boundaryPadding : outsidePadding));
    }
  }
  if (node.icon !== null && !node.isImage() && label.isOutside(node.icon.position) && allNodes !== null) {
    const iconSize = lg.MaxIconSize;
    const iconTopLeft = node.labelTopLeft(node.icon.position, iconSize, iconSize);
    const outsidePadding = 2. * label.PADDING;
    topLeft.x = Math.min(topLeft.x, Math.floor(iconTopLeft.x - outsidePadding));
    topLeft.y = Math.min(topLeft.y, Math.floor(iconTopLeft.y - outsidePadding));
    bottomRight.x = Math.max(bottomRight.x, Math.ceil(iconTopLeft.x + iconSize + outsidePadding));
    bottomRight.y = Math.max(bottomRight.y, Math.ceil(iconTopLeft.y + iconSize + outsidePadding));
  }
  return [topLeft, bottomRight];
}

/** BoundingBox computes the packing-compatible bounds for a node set: [topLeft, bottomRight]. */
export function boundingBox(nodes, guard) {
  if (nodes.length === 0) {
    guard.finish();
    return [geo.newPoint(-Infinity, -Infinity), geo.newPoint(Infinity, Infinity)];
  }
  let minX = Infinity, minY = Infinity;
  let maxX = -Infinity, maxY = -Infinity;
  for (const node of nodes) {
    const [topLeft, bottomRight] = nodeBoundingBox(node, nodes, guard);
    minX = Math.min(minX, topLeft.x);
    minY = Math.min(minY, topLeft.y);
    maxX = Math.max(maxX, bottomRight.x);
    maxY = Math.max(maxY, bottomRight.y);
  }
  guard.finish();
  return [geo.newPoint(minX, minY), geo.newPoint(maxX, maxY)];
}

function containerLevel(node, guard) {
  let level = 0;
  const seen = new Set();
  for (let current = node; current !== null; current = current.owningContainer()) {
    guard.step();
    if (seen.has(current)) throw invariant.newError('BinPack found a cycle in container ancestry');
    seen.add(current);
    level++;
  }
  return level;
}

function fixedOrigin(nodes, guard) {
  let container = null;
  let minimumLevel = Number.MAX_SAFE_INTEGER;
  for (const node of nodes) {
    guard.step();
    const current = node.owningContainer();
    if (current === null) {
      container = null;
      break;
    }
    const level = containerLevel(current, guard);
    if (level < minimumLevel) {
      minimumLevel = level;
      container = current;
    }
  }
  for (const child of nodes) {
    guard.step();
    if (child.owningContainer() !== container) continue;
    const origin = child.fixedOrigin();
    if (origin !== null) return origin;
  }
  guard.finish();
  return null;
}

/** FixedBoundingBox computes node-set bounds and substitutes the inherited fixed origin used by packing when a relevant child is pinned. */
export function fixedBoundingBox(nodes, guard) {
  let [topLeft, bottomRight] = boundingBox(nodes, guard);
  const origin = fixedOrigin(nodes, guard);
  if (origin !== null) topLeft = origin;
  guard.finish();
  return [topLeft, bottomRight];
}
