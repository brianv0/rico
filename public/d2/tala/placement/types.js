// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of the Go package d2layouts/d2talalayout/internal/placement (D2 v0.9.0, github.com/d2lang/d2, Copyright 2022
// Terrastruct Inc.): types.go, tuning.go, axis.go, moves.go, metrics.go, candidate_movement.go, cluster_connections.go.
// Shared helpers of the placement files in this directory (docs/d2-tala-port.md has the conventions).

import * as geo from '../../geo.js';
import { goRound } from '../../gomath.js';
import { sortSlice } from '../../gosort.js';
import { errorf, GoError } from '../goerrors.js';
import * as lg from '../layoutgraph.js';
import * as limits from '../limits.js';
import * as placementcost from '../placementcost.js';
import { chargeOptimizerScoring, optimizerCanMove, optimizerFixedOrigin, optimizerMoveNodeAbs, captureOptimizerNodePositions } from './optimization_guard.js';

// ---- tuning.go ----

export const compactionFactor = 3.0;
export const nodePlacementIterations = 90;
export const placementPadding = 1000.0;
export const jitterThreshold = 80.0;
export const signFlipPadding = 5.0;
export const largeGapThreshold = 0.5;

// ---- types.go ----

export const maxCompactionCandidateCount = limits.MaxGraphSize + 3;

/** pointerSnapshot[geo.Point]: remembers the pointer and a copy of its value. */
export function snapshotPointer(pointer) {
  if (pointer === null || pointer === undefined) return { pointer: null, x: 0, y: 0 };
  return { pointer, x: pointer.x, y: pointer.y };
}

export function restorePointer(snapshot) {
  if (snapshot.pointer === null) return null;
  snapshot.pointer.x = snapshot.x;
  snapshot.pointer.y = snapshot.y;
  return snapshot.pointer;
}

export function restoreNodePositions(snapshots) {
  for (const snapshot of snapshots) snapshot.node.topLeft = restorePointer(snapshot.topLeft);
}

export function snapshotNodePositionsContext(ctx, location, nodes) {
  const guard = limits.newWorkGuard(ctx, location, limits.MaxEngineWorkUnits);
  const seen = new Set();
  const snapshots = [];
  const queue = [];
  const enqueue = (node, graph) => {
    if (node === null) return;
    if (seen.has(node)) return;
    if (seen.size >= limits.MaxEngineNodes) throw errorf(`TALA ${location} unique node count exceeds limit ${limits.MaxEngineNodes}`);
    guard.step();
    seen.add(node);
    snapshots.push({ node, topLeft: snapshotPointer(node.topLeft) });
    queue.push({ node, graph });
  };
  for (const node of nodes) {
    if (node !== null) enqueue(node, node.graph);
  }
  for (let index = 0; index < queue.length; index++) {
    const current = queue[index];
    if (current.graph === null) continue;
    const node = current.node;
    if (node.isContainer()) {
      for (const child of current.graph.containers.get(node) ?? []) enqueue(child, current.graph);
    }
    if (node.isClusterVessel()) {
      const cluster = current.graph.clusters.get(node);
      if (cluster) {
        for (const child of cluster.nodes) enqueue(child, current.graph);
      }
    }
    const sequence = current.graph.sequences.get(node);
    if (sequence) {
      for (const child of sequence.nodes) enqueue(child, current.graph);
    }
  }
  guard.finish();
  return snapshots;
}

export function nonNilEquals(first, second) {
  return first.x === second.x && first.y === second.y;
}

export function roundToPreviousCellSize(value, cellSize) {
  return Math.floor(value / cellSize) * cellSize;
}

export function roundToNearestCellSize(value, cellSize) {
  return goRound(value / cellSize) * cellSize;
}

export function numPointsWithinManhattanDistance(distance) {
  return Math.trunc(Math.ceil(Math.pow(distance, 2) + Math.pow(distance + 1, 2)));
}

// ---- axis.go ----

export const invalidAxis = 0;
export const horizontalAxis = 1;
export const verticalAxis = 2;

export const axisValid = (axis) => axis === horizontalAxis || axis === verticalAxis;
export const axisIsHorizontal = (axis) => axis === horizontalAxis;
export function axisOpposite(axis) {
  switch (axis) {
    case horizontalAxis: return verticalAxis;
    case verticalAxis: return horizontalAxis;
    default: return invalidAxis;
  }
}

export function axisForArrangement(arrangement) {
  if (arrangement === lg.Column) return horizontalAxis;
  return verticalAxis;
}

export const invalidDirection = 0;
export const forwardDirection = 1;
export const backwardDirection = 2;

export const directionValid = (direction) => direction === forwardDirection || direction === backwardDirection;
export const directionIsForward = (direction) => direction === forwardDirection;
export function directionOpposite(direction) {
  switch (direction) {
    case forwardDirection: return backwardDirection;
    case backwardDirection: return forwardDirection;
    default: return invalidDirection;
  }
}

// ---- candidate_movement.go ----

/**
 * optimizerCandidateMovement reuses the candidate search's existing rollback snapshot as its stable movement set. Scoring only
 * changes geometry, so every trial visits the same descendants in the same order.
 */
export class OptimizerCandidateMovement {
  constructor(positions, descendantWork) {
    this.positions = positions;
    this.descendantWork = descendantWork;
  }

  moveAbs(x, y, guard) {
    const movement = this;
    const node = movement.positions[0].node;
    if (node.topLeft === null) throw errorf(`TALA ${guard.location} cannot move an unpositioned node`);
    if (node.topLeft.x === x && node.topLeft.y === y) {
      guard.step();
      return;
    }
    // Replay the original walk's Step calls instead of batching them: custom contexts and resource failures keep the same
    // observation boundaries.
    for (let i = 0; i < movement.descendantWork; i++) guard.step();
    const descendants = movement.positions.slice(1);
    for (const position of descendants) {
      guard.step();
      if (position.node.topLeft === null) throw errorf(`TALA ${guard.location} cannot move an unpositioned descendant`);
    }
    const dx = x - node.topLeft.x;
    const dy = y - node.topLeft.y;
    node.translate(dx, dy);
    for (const position of descendants) {
      guard.step();
      position.node.translate(dx, dy);
    }
  }
}

export function captureOptimizerCandidateMovement(node, guard) {
  const before = guard.used();
  const positions = captureOptimizerNodePositions([node], guard);
  // Single-root capture charges one Step for each retained position in addition to the descendant walk. Retain the latter's
  // charge so every trial preserves the original work boundary and cancellation polling sequence.
  return new OptimizerCandidateMovement(positions, guard.used() - before - positions.length);
}

// ---- cluster_connections.go ----

/**
 * clusterExternalConnectedNodes returns the positioned endpoints outside the cluster that remain in the cluster nodes' current
 * placement graph. The edge-abduction order is significant.
 */
export function clusterExternalConnectedNodes(cluster) {
  const currentGraph = cluster.nodes[0].graph;
  const set = new Set();
  const externalNodes = [];
  for (const edgeAbduction of cluster.edgeAbductions) {
    if (edgeAbduction.originallyFrom === null && edgeAbduction.originallyTo !== null) {
      if (edgeAbduction.currentFrom.topLeft !== null && edgeAbduction.currentFrom.graph === currentGraph) {
        if (!set.has(edgeAbduction.currentFrom)) {
          externalNodes.push(edgeAbduction.currentFrom);
          set.add(edgeAbduction.currentFrom);
        }
      }
    } else if (edgeAbduction.originallyTo === null && edgeAbduction.originallyFrom !== null) {
      if (edgeAbduction.currentTo.topLeft !== null && edgeAbduction.currentTo.graph === currentGraph) {
        if (!set.has(edgeAbduction.currentTo)) {
          externalNodes.push(edgeAbduction.currentTo);
          set.add(edgeAbduction.currentTo);
        }
      }
    }
  }
  return externalNodes;
}

// ---- moves.go ----

/** moveNodeToBest chooses the candidate with the lowest placement cost using the compaction stage's shared work guard. */
export function moveNodeToBest(ctx, graph, node, points, edgeAbductions, includeSizes, guard) {
  if (guard === null) throw errorf('TALA moveNodeToBest requires a work guard');
  guard.finish();

  const symmetryCost = graph.cellSize * node.edges.length;
  let leastDistance = Infinity;
  let leastDistancePoint = node.topLeft.copy();
  const currentX = node.topLeft.x;
  const currentY = node.topLeft.y;

  const fixedOrigin = optimizerFixedOrigin(graph, node.effectiveContainer(), guard);
  if (fixedOrigin !== null && !includeSizes) {
    fixedOrigin.x = goRound(fixedOrigin.x / graph.cellSize);
    fixedOrigin.y = goRound(fixedOrigin.y / graph.cellSize);
  }

  for (const point of points) {
    guard.step();
    if (point === null) throw errorf(`TALA ${guard.location} found a nil placement point`);
    const x = point.x;
    const y = point.y;
    if (fixedOrigin !== null && (x < fixedOrigin.x || y < fixedOrigin.y)) continue;
    let canMove = x === currentX && y === currentY;
    if (!canMove) canMove = optimizerCanMove(node, point, includeSizes, guard);
    if (!canMove) continue;
    optimizerMoveNodeAbs(node, x, y, guard);
    chargeOptimizerScoring(node, edgeAbductions, includeSizes, guard);
    let edgeLength = placementcost.nodeEdgeLength(ctx, node, { edgeAbductions, includeNodeSizes: includeSizes, enforceMinimumGap: false, penalizeDirection: true });
    if (includeSizes) {
      if (!(leastDistance === Infinity) && geo.precisionCompare(edgeLength - symmetryCost, leastDistance, geo.PRECISION) === 1) continue;
      const crossingCost = placementcost.columnCrossingCost(ctx, node, edgeAbductions);
      const symmetry = placementcost.nodeSymmetry(ctx, node, edgeAbductions);
      edgeLength += crossingCost;
      edgeLength -= symmetry * symmetryCost;
    }
    switch (geo.precisionCompare(edgeLength, leastDistance, geo.PRECISION)) {
      case -1:
        leastDistance = edgeLength;
        leastDistancePoint = point;
        break;
      case 0:
        if (point.x === currentX && point.y === currentY) {
          leastDistance = edgeLength;
          leastDistancePoint = point;
        }
        break;
    }
  }

  const err = ctx.err();
  if (err) throw errorf(`EdgeLength: ${err.message}`, err);
  if (leastDistance === Infinity) throw errorf('sizedOptimizer.moveNodeToBest: could not find any placement');
  optimizerMoveNodeAbs(node, leastDistancePoint.x, leastDistancePoint.y, guard);
  guard.finish();
  return node.topLeft.x !== currentX || node.topLeft.y !== currentY;
}

// ---- metrics.go ----

/** occupied reports whether point is the top-left position of a graph node: [node, ok]. */
export function occupied(graph, point) {
  for (const node of graph.nodes) {
    if (node.topLeft !== null && point !== null && node.topLeft.x === point.x && node.topLeft.y === point.y) return [node, true];
  }
  return [null, false];
}

/** withinMaxSize reports whether the graph fits inside the supported placement bounds. */
export function withinMaxSize(graph) {
  const [topLeft, bottomRight] = graph.boundingBox();
  const width = bottomRight.x - topLeft.x;
  const height = bottomRight.y - topLeft.y;
  return width <= limits.MaxGraphSize && height <= limits.MaxGraphSize;
}

/** intersectsOtherNode reports whether the center-to-center segment crosses an unrelated graph node. */
export function intersectsOtherNode(graph, first, second) {
  const firstCenter = first.center();
  const secondCenter = second.center();
  for (const other of graph.nodes) {
    if (other === first || other === second) continue;
    if (first.isDescendantOf(other) || second.isDescendantOf(other)) continue;
    if (other.isDescendantOf(first) || other.isDescendantOf(second)) continue;
    if (other.passesThrough(firstCenter, secondCenter)) return true;
  }
  return false;
}

export function median(nodes, includeSizes) {
  const orderedByX = nodes.slice();
  const orderedByY = nodes.slice();
  sortSlice(orderedByX, (i, j) => {
    const left = orderedByX[i];
    const right = orderedByX[j];
    let leftX = left.topLeft.x;
    let rightX = right.topLeft.x;
    if (includeSizes) {
      leftX += left.width / 2;
      rightX += right.width / 2;
    }
    if (leftX === rightX) return left.id < right.id;
    return leftX < rightX;
  });
  sortSlice(orderedByY, (i, j) => {
    const left = orderedByY[i];
    const right = orderedByY[j];
    let leftY = left.topLeft.y;
    let rightY = right.topLeft.y;
    if (includeSizes) {
      leftY += left.height / 2;
      rightY += right.height / 2;
    }
    if (leftY === rightY) return left.id < right.id;
    return leftY < rightY;
  });

  const middle = Math.trunc(nodes.length / 2);
  if (includeSizes) {
    let medianX = orderedByX[middle].topLeft.x + orderedByX[middle].width / 2;
    let medianY = orderedByY[middle].topLeft.y + orderedByY[middle].height / 2;
    if (nodes.length % 2 === 0) {
      medianX = (medianX + orderedByX[middle - 1].topLeft.x + orderedByX[middle - 1].width / 2) / 2;
      medianY = (medianY + orderedByY[middle - 1].topLeft.y + orderedByY[middle - 1].height / 2) / 2;
    }
    return [medianX / nodes[0].graph.cellSize, medianY / nodes[0].graph.cellSize];
  }
  let medianX = orderedByX[middle].topLeft.x + 0.5;
  let medianY = orderedByY[middle].topLeft.y + 0.5;
  if (nodes.length % 2 === 0) {
    medianX = (medianX + orderedByX[middle - 1].topLeft.x) / 2;
    medianY = (medianY + orderedByY[middle - 1].topLeft.y) / 2;
  }
  return [medianX, medianY];
}

/** medianToNeighbors approximates the two-dimensional geometric median of a node's currently positioned placement neighbors. */
export function medianToNeighbors(node, includeSizes, abductions) {
  return median(adjacents(node, abductions), includeSizes);
}

export function adjacents(node, abductions) {
  const result = [];
  const used = new Array(abductions.length).fill(false);
  for (const edge of node.edges) {
    const adjacent = node.adjacent(edge);
    if (adjacent.topLeft === null) continue;
    let add = adjacent;
    for (let i = 0; i < abductions.length; i++) {
      const abduction = abductions[i];
      if (used[i]) continue;
      if (abduction.currentFrom === node && abduction.currentTo === adjacent && abduction.originallyTo !== null) {
        used[i] = true;
        add = abduction.originallyTo;
        break;
      }
      if (abduction.currentFrom === adjacent && abduction.currentTo === node && abduction.originallyFrom !== null) {
        used[i] = true;
        add = abduction.originallyFrom;
        break;
      }
    }
    result.push(add);
  }
  if (result.length !== 0) return result;

  for (let near of node.orderedNears()) {
    if (lg.clusterIsActive(near.cluster)) near = near.cluster.vessel;
    else if (lg.sequenceIsActive(near.sequence)) near = near.sequence.vessel;
    let tree = node.graph.nodeToTree === null ? undefined : node.graph.nodeToTree.get(near);
    if (tree !== undefined) {
      while (tree.parent !== null) tree = tree.parent;
      near = tree.sentinelNode();
    }
    if (near.topLeft !== null && lg.isDescendantOf(near, node.container)) result.push(near);
  }
  if (result.length !== 0) return result;

  const nears = [];
  if (node.isClusterVessel()) {
    for (const child of node.graph.clusters.get(node).nodes) nears.push(...child.orderedNears());
  }
  const sequence = node.graph.sequences.get(node);
  if (sequence) {
    for (const child of sequence.nodes) nears.push(...child.orderedNears());
  }
  for (const tree of node.graph.trees.get(node) ?? []) {
    const queue = [tree];
    while (queue.length > 0) {
      const current = queue.shift();
      nears.push(...current.node.orderedNears());
      queue.push(...current.children);
    }
  }
  for (const near of nears) {
    let add = near;
    if (lg.clusterIsActive(near.cluster)) add = near.cluster.vessel;
    else if (lg.sequenceIsActive(near.sequence)) add = near.sequence.vessel;
    let tree = node.graph.nodeToTree === null ? undefined : node.graph.nodeToTree.get(add);
    if (tree !== undefined) {
      while (tree.parent !== null) tree = tree.parent;
      add = tree.sentinelNode();
    }
    if (add.topLeft !== null) result.push(add);
  }
  return result;
}

// ---- helpers shared by the stage files (not Go functions) ----

/**
 * `err := txn.Commit(ctx)`: returns the GoError Go would have received (null on success). A JS panic (non-GoError exception)
 * propagates, as a Go panic does.
 */
export function commitErr(txn, ctx) {
  try {
    txn.commit(ctx);
    return null;
  } catch (e) {
    if (!(e instanceof GoError)) throw e;
    return e;
  }
}

/** Runs fn and returns [value, err] where err is the GoError it threw (Go's `v, err := f()`); a panic propagates. */
export function tryGo(fn) {
  try {
    return [fn(), null];
  } catch (e) {
    if (!(e instanceof GoError)) throw e;
    return [undefined, e];
  }
}
