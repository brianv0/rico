// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of the Go package d2layouts/d2talalayout/internal/placement (D2 v0.9.0, github.com/d2lang/d2, Copyright 2022
// Terrastruct Inc.): direct.go.

import * as geo from '../../geo.js';
import * as lg from '../layoutgraph.js';
import * as limits from '../limits.js';
import * as placementcost from '../placementcost.js';
import { restoreNodePositions, snapshotNodePositionsContext } from './types.js';

const { Orientation } = geo;

/** directionCounts is {left, right, top, bottom}. */
const newDirectionCounts = () => ({ left: 0, right: 0, top: 0, bottom: 0 });

function addDirectionCounts(counts, other) {
  counts.left += other.left;
  counts.right += other.right;
  counts.top += other.top;
  counts.bottom += other.bottom;
}

export function edgeDirectionCounts(edge) {
  const counts = newDirectionCounts();
  const [from, to, directed] = edge.directedEndpoints();
  if (!directed) return counts;
  switch (geo.getOpposite(from.orientation(to))) {
    case Orientation.Left:
      counts.left++;
      break;
    case Orientation.TopLeft:
      counts.top++;
      counts.left++;
      break;
    case Orientation.BottomLeft:
      counts.bottom++;
      counts.left++;
      break;
    case Orientation.Right:
      counts.right++;
      break;
    case Orientation.TopRight:
      counts.top++;
      counts.right++;
      break;
    case Orientation.BottomRight:
      counts.bottom++;
      counts.right++;
      break;
    case Orientation.Top:
      counts.top++;
      break;
    case Orientation.Bottom:
      counts.bottom++;
      break;
  }
  return counts;
}

/** cmp.Compare of ints */
const cmpInt = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export function compareDirectionCounts(a, b, preferred) {
  const order = cmpInt(b.count, a.count);
  if (order !== 0) return order;
  const aPreferred = a.direction === preferred;
  const bPreferred = b.direction === preferred;
  if (aPreferred && !bPreferred) return -1;
  if (!aPreferred && bPreferred) return 1;
  return 0;
}

/** directionCounts.transformsTo: returns {mirrorX, mirrorY}. */
export function transformsTo(counts, direction) {
  const values = [
    { direction: Orientation.Right, count: counts.right },
    { direction: Orientation.Bottom, count: counts.bottom },
    { direction: Orientation.Left, count: counts.left },
    { direction: Orientation.Top, count: counts.top },
  ];
  // slices.SortStableFunc over four elements with a strict weak ordering: Array.prototype.sort is stable.
  values.sort((a, b) => compareDirectionCounts(a, b, direction));
  const primary = values[0];
  let secondary = values[1];
  if (secondary.direction === geo.getOpposite(primary.direction)) secondary = values[2];
  if (direction === Orientation.NONE) {
    if (geo.isHorizontal(primary.direction)) direction = Orientation.Right;
    else direction = Orientation.Bottom;
  }
  let xDirection = Orientation.Right;
  let yDirection = Orientation.Bottom;
  if (geo.isHorizontal(direction)) xDirection = direction;
  else yDirection = direction;
  const transforms = { mirrorX: false, mirrorY: false };
  if (geo.isHorizontal(primary.direction)) transforms.mirrorX = primary.direction !== xDirection;
  else transforms.mirrorY = primary.direction !== yDirection;
  if (secondary.count > values[3].count) {
    if (geo.isHorizontal(secondary.direction)) transforms.mirrorX = secondary.direction !== xDirection;
    else transforms.mirrorY = secondary.direction !== yDirection;
  }
  return transforms;
}

export function containerEdgeDirections(graph, container) {
  const counted = new Set();
  const counts = newDirectionCounts();
  for (const node of graph.containers.get(container) ?? []) {
    if (node.graph !== graph) continue;
    for (const edge of node.edges) {
      if (counted.has(edge)) continue;
      counted.add(edge);
      addDirectionCounts(counts, edgeDirectionCounts(edge));
    }
  }
  return counts;
}

export function hasFixedDescendant(node) {
  if (node.fixedTopLeft !== null) return true;
  if (node.isContainer()) {
    for (const child of node.graph.containers.get(node) ?? []) {
      if (hasFixedDescendant(child)) return true;
    }
  }
  if (node.isClusterVessel()) {
    for (const child of node.graph.clusters.get(node).nodes) {
      if (hasFixedDescendant(child)) return true;
    }
  } else {
    const sequence = node.graph.sequences.get(node);
    if (sequence) {
      for (const child of sequence.nodes) {
        if (hasFixedDescendant(child)) return true;
      }
    }
  }
  return false;
}

export function mirrorAxes(ctx, graph, mirrorX, mirrorY) {
  const guard = limits.newWorkGuard(ctx, 'MirrorAxesReachability', limits.MaxEngineWorkUnits);
  const reachableContainers = new Set();
  const visited = new Set();
  for (const node of graph.nodes) {
    if (visited.has(node)) continue;
    const reachable = node.allReachableNodesContext(true, true, false, null, guard);
    for (const current of reachable) {
      visited.add(current);
      reachableContainers.add(current.container);
    }
  }
  guard.finish();

  const originalPositions = snapshotNodePositionsContext(ctx, 'MirrorAxes', graph.nodes);
  const originalTreeOrientations = new Map();
  for (const snapshot of originalPositions) {
    const tree = graph.nodeToTree === null ? undefined : graph.nodeToTree.get(snapshot.node);
    if (tree !== undefined && tree !== null) originalTreeOrientations.set(tree, tree.orientation);
  }
  let complete = false;
  try {
    const mirrored = new Set();
    const mirrorNode = (node) => {
      guard.step();
      if (mirrored.has(node)) return;
      if (reachableContainers.has(node.effectiveContainer())) {
        node.mirror(mirrorX, mirrorY);
        mirrored.add(node);
        guard.finish();
        const tree = graph.nodeToTree === null ? undefined : graph.nodeToTree.get(node);
        if (tree !== undefined && tree !== null &&
            ((mirrorX && geo.isHorizontal(tree.orientation)) || (mirrorY && geo.isVertical(tree.orientation)))) {
          tree.orientation = geo.getOpposite(tree.orientation);
          guard.finish();
        }
      }
      node.positionContainerChildren(true);
      guard.finish();
    };
    for (const node of graph.nodes) {
      if (!mirrored.has(node)) node.walkRDFS(mirrorNode);
    }
    guard.finish();
    complete = true;
  } finally {
    if (!complete) {
      restoreNodePositions(originalPositions);
      for (const [tree, orientation] of originalTreeOrientations) tree.orientation = orientation;
    }
  }
}

/**
 * direct mirrors a placed subgraph toward its dominant edge direction when doing so preserves or improves the placement cost.
 * `options` is {checkEdgeLength}.
 */
export function direct(ctx, graph, nodes, container, options) {
  const cerr = ctx.err();
  if (cerr) throw cerr;
  if (nodes.length === 0 || nodes[0].hierarchy !== null) return;
  for (const node of nodes) {
    if (hasFixedDescendant(node)) return;
    const sequence = graph.sequences.get(node);
    if (sequence && sequence.edgeAbductions.length > 0) return;
    if (node.sequence !== null && node.sequence.edgeAbductions.length > 0) return;
  }
  const transforms = transformsTo(containerEdgeDirections(graph, container), graph.direction(container));
  if (!transforms.mirrorX && !transforms.mirrorY) return;
  if (!options.checkEdgeLength) {
    mirrorAxes(ctx, graph, transforms.mirrorX, transforms.mirrorY);
    return;
  }
  const pcOpts = { edgeAbductions: null, includeNodeSizes: true, enforceMinimumGap: false, penalizeDirection: true };
  const currentLength = placementcost.edgeLength(ctx, graph, pcOpts);
  const transaction = graph.newRequestTransaction(ctx, { affectContainers: true });
  transaction.addOp(() => { mirrorAxes(ctx, graph, transforms.mirrorX, transforms.mirrorY); return null; });
  try {
    transaction.commit(ctx);
  } catch (err) {
    if (lg.isCandidateRejection(err)) return;
    throw err;
  }
  let newLength;
  try {
    newLength = placementcost.edgeLength(ctx, graph, pcOpts);
  } catch (e) {
    transaction.rollback();
    throw e;
  }
  if (geo.precisionCompare(newLength, currentLength, geo.PRECISION) > 0) transaction.rollback();
}
