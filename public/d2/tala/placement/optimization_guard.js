// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of the Go package d2layouts/d2talalayout/internal/placement (D2 v0.9.0, github.com/d2lang/d2, Copyright 2022
// Terrastruct Inc.): optimization_guard.go, the work-guarded helpers of the placement optimizers.

import { sortSlice } from '../../gosort.js';
import { errorf } from '../goerrors.js';
import * as lg from '../layoutgraph.js';
import * as limits from '../limits.js';
import { nonNilEquals, restoreNodePositions, snapshotPointer, restorePointer } from './types.js';

// A work limit bounds CPU, but retaining every unique placement until that limit is reached could still consume too much
// memory. This independent cap keeps the reusable placement buffer and its deduplication map predictable.
export const maxOptimizerPlacementCandidates = 1_000_000;
export const maxRetainedPlacementCandidates = 16_384;

const MAX_UINT64 = 18446744073709551615;

export function optimizerIsDescendantOf(descendant, ancestor, guard) {
  const seen = new Set();
  for (let current = descendant; ;) {
    guard.step();
    if (current === ancestor) return true;
    if (current === null) return ancestor === null;
    if (seen.has(current)) throw errorf(`TALA ${guard.location} found a cycle in node ancestry at ${current.debugID()}`);
    if (seen.size >= limits.MaxEngineNodes) throw errorf(`TALA ${guard.location} ancestry exceeds node limit ${limits.MaxEngineNodes}`);
    seen.add(current);
    if (current.container !== null) current = current.container;
    else if (current.cluster !== null) current = current.cluster.vessel;
    else if (current.sequence !== null) current = current.sequence.vessel;
    else current = null;
  }
}

export function optimizerTreeRoot(tree, guard) {
  const seen = new Set();
  while (tree !== null && tree.parent !== null) {
    guard.step();
    if (seen.has(tree)) throw errorf(`TALA ${guard.location} found a cycle in tree ancestry`);
    if (seen.size >= limits.MaxEngineNodes) throw errorf(`TALA ${guard.location} tree ancestry exceeds node limit ${limits.MaxEngineNodes}`);
    seen.add(tree);
    tree = tree.parent;
  }
  return tree;
}

export function optimizerFixedOrigin(g, container, guard) {
  if (g === null) throw errorf(`TALA ${guard.location} fixed-origin lookup requires a graph`);
  if (g.nodes.length > limits.MaxEngineNodes) throw errorf(`TALA ${guard.location} fixed-origin node count exceeds limit ${limits.MaxEngineNodes}`);
  for (const node of g.nodes) {
    guard.step();
    if (node === null || node.owningContainer() !== container) continue;
    const origin = node.fixedOrigin();
    if (origin !== null) return origin;
  }
  return null;
}

export function optimizerOrderedNears(node, guard) {
  if (node === null) throw errorf(`TALA ${guard.location} cannot order nears for a nil node`);
  if (node.nears.size > limits.MaxEngineNodes) throw errorf(`TALA ${guard.location} near count exceeds limit ${limits.MaxEngineNodes}`);
  const nears = [];
  for (const near of node.nears) {
    guard.step();
    if (near === null) throw errorf(`TALA ${guard.location} found a nil near on ${node.debugID()}`);
    nears.push(near);
  }
  guard.addSort(nears.length);
  lg.sortNodesByID(nears);
  return nears;
}

export function appendBoundedOptimizerNodes(dst, src, guard) {
  if (dst.length > lg.MaxTopologyReferences - src.length) {
    throw errorf(`TALA ${guard.location} optimizer node references exceed limit ${lg.MaxTopologyReferences}`);
  }
  return dst.concat(src);
}

export function appendOptimizerTreeNears(nears, tree, guard) {
  if (tree === null) return nears;
  const stack = [tree];
  const seen = new Set([tree]);
  while (stack.length > 0) {
    guard.step();
    const current = stack.pop();
    if (current === null) throw errorf(`TALA ${guard.location} found a nil tree node`);
    if (current.node === null) throw errorf(`TALA ${guard.location} found a tree entry without a node`);
    const ordered = optimizerOrderedNears(current.node, guard);
    nears = appendBoundedOptimizerNodes(nears, ordered, guard);
    if (current.children.length > limits.MaxEngineNodes) {
      throw errorf(`TALA ${guard.location} tree child references exceed limit ${limits.MaxEngineNodes}`);
    }
    for (let i = current.children.length - 1; i >= 0; i--) {
      const child = current.children[i];
      guard.step();
      if (child === null) throw errorf(`TALA ${guard.location} found a nil tree child`);
      if (seen.has(child)) throw errorf(`TALA ${guard.location} found a cycle or shared child in a tree`);
      if (seen.size >= limits.MaxEngineNodes) throw errorf(`TALA ${guard.location} tree exceeds node limit ${limits.MaxEngineNodes}`);
      seen.add(child);
      stack.push(child);
    }
  }
  return nears;
}

const nodeToTreeGet = (graph, node) => (graph.nodeToTree === null ? undefined : graph.nodeToTree.get(node));

export function optimizerAdjacents(node, edgeAbductions, guard) {
  if (node === null || node.graph === null) throw errorf(`TALA ${guard.location} adjacency lookup requires a node with a graph`);
  if (node.edges.length > limits.MaxEngineEdges || edgeAbductions.length > limits.MaxEngineEdges) {
    throw errorf(`TALA ${guard.location} adjacency inputs exceed edge limit ${limits.MaxEngineEdges}`);
  }
  let adjacents = [];
  const usedEdgeAbductions = new Array(edgeAbductions.length).fill(false);
  for (const edge of node.edges) {
    guard.step();
    if (edge === null || (edge.from !== node && edge.to !== node)) {
      throw errorf(`TALA ${guard.location} found a malformed incident edge on ${node.debugID()}`);
    }
    const adjacentNode = node.adjacent(edge);
    if (adjacentNode === null || adjacentNode.topLeft === null) continue;
    let addNode = adjacentNode;
    for (let i = 0; i < edgeAbductions.length; i++) {
      const edgeAbduction = edgeAbductions[i];
      guard.step();
      if (edgeAbduction === null) throw errorf(`TALA ${guard.location} found a nil edge abduction`);
      if (usedEdgeAbductions[i]) continue;
      if (edgeAbduction.currentFrom === node && edgeAbduction.currentTo === adjacentNode && edgeAbduction.originallyTo !== null) {
        usedEdgeAbductions[i] = true;
        addNode = edgeAbduction.originallyTo;
        break;
      }
      if (edgeAbduction.currentFrom === adjacentNode && edgeAbduction.currentTo === node && edgeAbduction.originallyFrom !== null) {
        usedEdgeAbductions[i] = true;
        addNode = edgeAbduction.originallyFrom;
        break;
      }
    }
    adjacents.push(addNode);
  }
  if (adjacents.length !== 0) return adjacents;

  const orderedNears = optimizerOrderedNears(node, guard);
  for (let near of orderedNears) {
    if (lg.clusterIsActive(near.cluster)) near = near.cluster.vessel;
    else if (lg.sequenceIsActive(near.sequence)) near = near.sequence.vessel;
    const tree = nodeToTreeGet(node.graph, near);
    if (tree !== undefined) {
      const root = optimizerTreeRoot(tree, guard);
      if (root === null || root.sentinelNode() === null) throw errorf(`TALA ${guard.location} found a tree without a sentinel`);
      near = root.sentinelNode();
    }
    if (near === null || near.topLeft === null) continue;
    const isDescendant = optimizerIsDescendantOf(near, node.container, guard);
    if (isDescendant) adjacents.push(near);
  }
  if (adjacents.length !== 0) return adjacents;

  let nears = [];
  if (node.isClusterVessel()) {
    const cluster = node.graph.clusters.get(node);
    if (cluster === undefined || cluster === null) throw errorf(`TALA ${guard.location} found a cluster vessel without a cluster`);
    for (const clusterNode of cluster.nodes) {
      guard.step();
      const ordered = optimizerOrderedNears(clusterNode, guard);
      nears = appendBoundedOptimizerNodes(nears, ordered, guard);
    }
  }
  const sequence = node.graph.sequences.get(node);
  if (sequence) {
    for (const sequenceNode of sequence.nodes) {
      guard.step();
      const ordered = optimizerOrderedNears(sequenceNode, guard);
      nears = appendBoundedOptimizerNodes(nears, ordered, guard);
    }
  }
  const treeRoots = node.graph.trees.get(node) ?? [];
  if (treeRoots.length > limits.MaxEngineNodes) throw errorf(`TALA ${guard.location} tree roots exceed node limit ${limits.MaxEngineNodes}`);
  for (const tree of treeRoots) nears = appendOptimizerTreeNears(nears, tree, guard);
  for (const near of nears) {
    guard.step();
    let addNode = near;
    if (lg.clusterIsActive(near.cluster)) addNode = near.cluster.vessel;
    else if (lg.sequenceIsActive(near.sequence)) addNode = near.sequence.vessel;
    const tree = nodeToTreeGet(node.graph, addNode);
    if (tree !== undefined) {
      const root = optimizerTreeRoot(tree, guard);
      if (root === null || root.sentinelNode() === null) throw errorf(`TALA ${guard.location} found a tree without a sentinel`);
      addNode = root.sentinelNode();
    }
    if (addNode !== null && addNode.topLeft !== null) adjacents.push(addNode);
  }
  return adjacents;
}

const cellSizeBad = (cellSize) => cellSize <= 0 || Number.isNaN(cellSize) || !Number.isFinite(cellSize);

export function optimizerMedian(nodes, includeSizes, guard) {
  if (nodes.length === 0) throw errorf(`TALA ${guard.location} cannot compute a median without positioned neighbors`);
  if (nodes.length > lg.MaxTopologyReferences) throw errorf(`TALA ${guard.location} median inputs exceed limit ${lg.MaxTopologyReferences}`);
  if (nodes.length === 1) {
    const node = nodes[0];
    guard.step();
    if (node === null || node.topLeft === null) throw errorf(`TALA ${guard.location} cannot compute a median with an unpositioned neighbor`);
    guard.addSort(1);
    guard.addSort(1);
    if (includeSizes) {
      const cellSize = node.graph.cellSize;
      if (cellSizeBad(cellSize)) throw errorf(`TALA ${guard.location} requires a finite positive cell size`);
      return [(node.topLeft.x + node.width / 2) / cellSize, (node.topLeft.y + node.height / 2) / cellSize];
    }
    return [node.topLeft.x + 0.5, node.topLeft.y + 0.5];
  }
  const orderedByX = new Array(nodes.length);
  const orderedByY = new Array(nodes.length);
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    guard.step();
    if (node === null || node.topLeft === null) throw errorf(`TALA ${guard.location} cannot compute a median with an unpositioned neighbor`);
    orderedByX[i] = node;
    orderedByY[i] = node;
  }
  guard.addSort(nodes.length);
  sortSlice(orderedByX, (i, j) => {
    const iNode = orderedByX[i];
    const jNode = orderedByX[j];
    let iX = iNode.topLeft.x;
    let jX = jNode.topLeft.x;
    if (includeSizes) {
      iX += iNode.width / 2;
      jX += jNode.width / 2;
    }
    if (iX === jX) return iNode.id < jNode.id;
    return iX < jX;
  });
  guard.addSort(nodes.length);
  sortSlice(orderedByY, (i, j) => {
    const iNode = orderedByY[i];
    const jNode = orderedByY[j];
    let iY = iNode.topLeft.y;
    let jY = jNode.topLeft.y;
    if (includeSizes) {
      iY += iNode.height / 2;
      jY += jNode.height / 2;
    }
    if (iY === jY) return iNode.id < jNode.id;
    return iY < jY;
  });

  const middle = Math.trunc(nodes.length / 2);
  let medianX;
  let medianY;
  if (includeSizes) {
    medianX = orderedByX[middle].topLeft.x + orderedByX[middle].width / 2;
    medianY = orderedByY[middle].topLeft.y + orderedByY[middle].height / 2;
    if (nodes.length % 2 === 0) {
      medianX = (medianX + orderedByX[middle - 1].topLeft.x + orderedByX[middle - 1].width / 2) / 2;
      medianY = (medianY + orderedByY[middle - 1].topLeft.y + orderedByY[middle - 1].height / 2) / 2;
    }
    const cellSize = nodes[0].graph.cellSize;
    if (cellSizeBad(cellSize)) throw errorf(`TALA ${guard.location} requires a finite positive cell size`);
    medianX /= cellSize;
    medianY /= cellSize;
  } else {
    medianX = orderedByX[middle].topLeft.x + 0.5;
    medianY = orderedByY[middle].topLeft.y + 0.5;
    if (nodes.length % 2 === 0) {
      medianX = (medianX + orderedByX[middle - 1].topLeft.x) / 2;
      medianY = (medianY + orderedByY[middle - 1].topLeft.y) / 2;
    }
  }
  return [medianX, medianY];
}

export function optimizerMedianToNeighbors(node, includeSizes, edgeAbductions, guard) {
  const adjacents = optimizerAdjacents(node, edgeAbductions, guard);
  return optimizerMedian(adjacents, includeSizes, guard);
}

export function optimizerDoesOverlap(node, point, exceptions, guard) {
  if (node === null || node.graph === null || point === null) throw errorf(`TALA ${guard.location} overlap check requires a node, graph, and point`);
  if (node.graph.nodes.length > limits.MaxEngineNodes || exceptions.length > limits.MaxEngineNodes) {
    throw errorf(`TALA ${guard.location} overlap inputs exceed node limit ${limits.MaxEngineNodes}`);
  }
  const right = point.x + node.width;
  const bottom = point.y + node.height;
  for (const otherNode of node.graph.nodes) {
    guard.step();
    if (otherNode === null) throw errorf(`TALA ${guard.location} found a nil graph node`);
    if (otherNode === node) continue;
    let excluded = false;
    for (const exception of exceptions) {
      guard.step();
      if (exception === otherNode) {
        excluded = true;
        break;
      }
    }
    if (excluded || otherNode.topLeft === null) continue;
    const maxSafeDelta = 500.0;
    if (point.x > otherNode.topLeft.x + otherNode.width + maxSafeDelta ||
        point.x + node.width + maxSafeDelta < otherNode.topLeft.x ||
        point.y > otherNode.topLeft.y + otherNode.height + maxSafeDelta ||
        point.y + node.height + maxSafeDelta < otherNode.topLeft.y) {
      continue;
    }
    guard.add(node.edges.length);
    const delta = node.deltaTo(otherNode, point);
    if (point.x < otherNode.topLeft.x + otherNode.width + delta && right + delta > otherNode.topLeft.x &&
        point.y < otherNode.topLeft.y + otherNode.height + delta && bottom + delta > otherNode.topLeft.y) {
      return true;
    }
  }
  return false;
}

/** [node, occupied] */
export function optimizerIsOccupied(g, point, guard) {
  if (g === null || point === null) throw errorf(`TALA ${guard.location} occupancy check requires a graph and point`);
  if (g.nodes.length > limits.MaxEngineNodes) throw errorf(`TALA ${guard.location} occupancy node count exceeds limit ${limits.MaxEngineNodes}`);
  for (const node of g.nodes) {
    guard.step();
    if (node === null) throw errorf(`TALA ${guard.location} found a nil graph node`);
    if (node.topLeft !== null && point !== null && nonNilEquals(node.topLeft, point)) return [node, true];
  }
  return [null, false];
}

export function optimizerCanMove(node, point, includeSizes, guard) {
  if (node === null || node.graph === null || point === null) throw errorf(`TALA ${guard.location} movement check requires a node, graph, and point`);
  if (nonNilEquals(node.topLeft, point)) return true;
  const [, occupied] = optimizerIsOccupied(node.graph, point, guard);
  if (occupied || !includeSizes) return !occupied;
  const overlaps = optimizerDoesOverlap(node, point, [], guard);
  return !overlaps;
}

/**
 * chargeOptimizerScoring accounts for the nested edge, abduction, blocker, and symmetry scans performed by the legacy scoring
 * helpers. `edgeAbductions` may be null (Go's nil slice).
 */
export function chargeOptimizerScoring(node, edgeAbductions, includeSymmetry, guard) {
  if (node === null || node.graph === null) throw errorf(`TALA ${guard.location} scoring requires a node with a graph`);
  const edges = node.edges.length + 1;
  let searchSpace = node.graph.nodes.length + (edgeAbductions === null ? 0 : edgeAbductions.length) + 1;
  if (includeSymmetry) {
    if (MAX_UINT64 - searchSpace < edges) {
      throw errorf(`${limits.ErrOptimizationResourceLimit.message}: ${guard.location} scoring work arithmetic overflow`, limits.ErrOptimizationResourceLimit);
    }
    searchSpace += edges;
  }
  guard.addProduct(edges, searchSpace);
}

/**
 * chargeOptimizerTranspose bounds the independent reachability, rotation, and scoring guards used by transpose under the
 * optimizer's single operation budget. `edgeAbductions` may be null (nil slice: that is not the same as an empty one here).
 */
export function chargeOptimizerTranspose(g, node, edgeAbductions, guard) {
  if (g === null || node === null || node.graph === null) throw errorf(`TALA ${guard.location} transpose requires a node with a graph`);
  const abductionCount = edgeAbductions === null ? 0 : edgeAbductions.length;
  if (g.nodes.length > limits.MaxEngineNodes || g.edges.length > limits.MaxEngineEdges || abductionCount > limits.MaxEngineEdges) {
    throw errorf(`TALA ${guard.location} transpose inputs exceed engine limits`);
  }
  for (const abduction of edgeAbductions ?? []) {
    guard.step();
    if (abduction === null) throw errorf(`TALA ${guard.location} found a nil edge abduction`);
  }
  if (node.hierarchy !== null || node.fixedTopLeft !== null || node.edges.length < 1 || node.edges.length > 2) {
    guard.step();
    return;
  }
  if ((g.nodeToTree !== null && g.nodeToTree.has(node)) || g.isTreeSentinel(node)) {
    guard.step();
    return;
  }

  const nodes = g.nodes.length + 1;
  const edges = g.edges.length + 1;
  const abductions = abductionCount + 1;
  // Reachability is performed several times while selecting a rotation side.
  for (let i = 0; i < 6; i++) guard.add(nodes + edges + abductions);
  // At most four trial rotations and one committed rotation are scored.
  for (let i = 0; i < 5; i++) {
    if (edgeAbductions === null) {
      guard.addProduct(nodes, edges);
      guard.addProduct(edges, edges);
    } else {
      guard.addProduct(node.edges.length + 1, nodes + abductions);
    }
  }
  // Rotating containers can translate descendants for each trial.
  for (let i = 0; i < 4; i++) guard.addProduct(nodes, nodes);
}

export function optimizerDescendants(node, guard) {
  if (node === null || node.graph === null) throw errorf(`TALA ${guard.location} movement requires a node with a graph`);
  const g = node.graph;
  const seen = new Set([node]);
  const stack = [];
  const push = (child) => {
    guard.step();
    if (child === null) throw errorf(`TALA ${guard.location} found a nil descendant`);
    if (seen.has(child)) return;
    if (seen.size >= limits.MaxEngineNodes) throw errorf(`TALA ${guard.location} descendant count exceeds limit ${limits.MaxEngineNodes}`);
    seen.add(child);
    stack.push(child);
  };
  const pushChildren = (parent) => {
    const sequence = parent === null ? undefined : g.sequences.get(parent);
    if (sequence) {
      if (sequence.nodes.length > limits.MaxEngineNodes) {
        throw errorf(`TALA ${guard.location} sequence child references exceed node limit ${limits.MaxEngineNodes}`);
      }
      for (let i = sequence.nodes.length - 1; i >= 0; i--) push(sequence.nodes[i]);
    }
    if (parent !== null && parent.isClusterVessel()) {
      const cluster = g.clusters.get(parent);
      if (cluster) {
        if (cluster.nodes.length > limits.MaxEngineNodes) {
          throw errorf(`TALA ${guard.location} cluster child references exceed node limit ${limits.MaxEngineNodes}`);
        }
        for (let i = cluster.nodes.length - 1; i >= 0; i--) push(cluster.nodes[i]);
      }
    }
    if (parent === null || parent.isContainer()) {
      const children = g.containers.get(parent) ?? [];
      if (children.length > limits.MaxEngineNodes) {
        throw errorf(`TALA ${guard.location} container child references exceed node limit ${limits.MaxEngineNodes}`);
      }
      for (let i = children.length - 1; i >= 0; i--) push(children[i]);
    }
  };
  pushChildren(node);
  const descendants = [];
  while (stack.length > 0) {
    guard.step();
    const current = stack.pop();
    descendants.push(current);
    pushChildren(current);
  }
  return descendants;
}

export function optimizerMoveNodeAbs(node, x, y, guard) {
  if (node === null || node.topLeft === null) throw errorf(`TALA ${guard.location} cannot move an unpositioned node`);
  if (node.topLeft.x === x && node.topLeft.y === y) {
    guard.step();
    return;
  }
  // Most optimizer candidates are ordinary leaves. The general path below walks ownership maps and snapshots descendants
  // for atomic rollback, but those structures are provably empty for a non-container/non-vessel leaf.
  if (node.graph !== null && !node.isContainer() && !node.isClusterVessel() && !node.graph.sequences.get(node)) {
    node.translate(x - node.topLeft.x, y - node.topLeft.y);
    return;
  }
  const descendants = optimizerDescendants(node, guard);
  const snapshots = [{ node, topLeft: snapshotPointer(node.topLeft) }];
  for (const child of descendants) {
    guard.step();
    if (child.topLeft === null) throw errorf(`TALA ${guard.location} cannot move an unpositioned descendant`);
    snapshots.push({ node: child, topLeft: snapshotPointer(child.topLeft) });
  }
  let complete = false;
  try {
    const dx = x - node.topLeft.x;
    const dy = y - node.topLeft.y;
    node.translate(dx, dy);
    for (const child of descendants) {
      guard.step();
      child.translate(dx, dy);
    }
    complete = true;
  } finally {
    if (!complete) restoreNodePositions(snapshots);
  }
}

export function optimizerSwapPositions(nodeA, nodeB, guard) {
  if (nodeA === null || nodeB === null || nodeA.topLeft === null || nodeB.topLeft === null) {
    throw errorf(`TALA ${guard.location} cannot swap unpositioned nodes`);
  }
  const snapshots = captureOptimizerNodePositions([nodeA, nodeB], guard);
  let complete = false;
  try {
    const ax = nodeA.topLeft.x;
    const ay = nodeA.topLeft.y;
    optimizerMoveNodeAbs(nodeA, nodeB.topLeft.x, nodeB.topLeft.y, guard);
    optimizerMoveNodeAbs(nodeB, ax, ay, guard);
    complete = true;
  } finally {
    if (!complete) restoreNodePositions(snapshots);
  }
}

/** optimizerMutationSnapshot (one per optimizer: its arrays are reused scratch, cleared by release). */
export class OptimizerMutationSnapshot {
  constructor() {
    this.nodes = [];
    this.clusters = [];
    this.herds = [];
    this.costSnapshot = null;
  }

  /** release clears graph references. It is also safe after an interrupted capture, when only a prefix was recorded. */
  release() {
    this.nodes = [];
    this.clusters = [];
    this.herds = [];
    this.costSnapshot = null;
  }

  restore() {
    const snapshot = this;
    for (const node of snapshot.nodes) {
      node.node.topLeft = restorePointer(node.topLeft);
      node.node.width = node.width;
      node.node.height = node.height;
    }
    for (const cluster of snapshot.clusters) {
      cluster.cluster.arrangement = cluster.arrangement;
      cluster.cluster.desiredArrangement = cluster.desired;
      cluster.cluster.padding = cluster.padding;
    }
    for (const herd of snapshot.herds) {
      // *herd.herd = herd.value: a struct copy (the paired sets are shared references, as in Go)
      herd.herd.oppositeSidePaired = herd.value.oppositeSidePaired;
      herd.herd.sameSidePaired = herd.value.sameSidePaired;
      herd.herd.orientation = herd.value.orientation;
      herd.herd.val = herd.value.val;
    }
    snapshot.costSnapshot.restore();
  }
}

export function captureOptimizerMutationState(g, guard) {
  return captureOptimizerMutationStateInto(g, guard, new OptimizerMutationSnapshot());
}

export function captureOptimizerMutationStateInto(g, guard, snapshot) {
  snapshot.release();
  if (g === null) throw errorf(`TALA ${guard.location} requires a graph`);
  if (g.nodes.length > limits.MaxEngineNodes) throw errorf(`TALA ${guard.location} snapshot node count exceeds limit ${limits.MaxEngineNodes}`);
  if (g.containers.size > limits.MaxEngineNodes + 1 || g.clusters.size > limits.MaxEngineNodes || g.sequences.size > limits.MaxEngineNodes) {
    throw errorf(`TALA ${guard.location} optimizer topology maps exceed node limit ${limits.MaxEngineNodes}`);
  }
  const cacheEntries = g.edgeLengthCacheEntries();
  if (cacheEntries > lg.MaxTopologyReferences) {
    throw errorf(`TALA ${guard.location} edge-length cache entries exceed limit ${lg.MaxTopologyReferences}`);
  }
  for (let i = 0; i < cacheEntries; i++) guard.step();
  const costSnapshot = g.snapshotPlacementCosts();
  guard.finish();
  snapshot.costSnapshot = costSnapshot;
  const seenNodes = new Set();
  const enqueue = (node) => {
    guard.step();
    if (node === null) throw errorf(`TALA ${guard.location} found a nil graph node`);
    if (seenNodes.has(node)) return;
    if (seenNodes.size >= limits.MaxEngineNodes) throw errorf(`TALA ${guard.location} snapshot node count exceeds limit ${limits.MaxEngineNodes}`);
    seenNodes.add(node);
    snapshot.nodes.push({ node, topLeft: snapshotPointer(node.topLeft), width: node.width, height: node.height });
  };
  for (const node of g.nodes) enqueue(node);
  // The snapshot already contains the queue in discovery order.
  for (let i = 0; i < snapshot.nodes.length; i++) {
    const node = snapshot.nodes[i].node;
    const containerChildren = g.containers.get(node) ?? [];
    if (containerChildren.length > limits.MaxEngineNodes) {
      throw errorf(`TALA ${guard.location} container child references exceed node limit ${limits.MaxEngineNodes}`);
    }
    for (const child of containerChildren) enqueue(child);
    const cluster = g.clusters.get(node);
    if (cluster) {
      if (cluster.nodes.length > limits.MaxEngineNodes) {
        throw errorf(`TALA ${guard.location} cluster child references exceed node limit ${limits.MaxEngineNodes}`);
      }
      for (const child of cluster.nodes) enqueue(child);
    }
    const sequence = g.sequences.get(node);
    if (sequence) {
      if (sequence.nodes.length > limits.MaxEngineNodes) {
        throw errorf(`TALA ${guard.location} sequence child references exceed node limit ${limits.MaxEngineNodes}`);
      }
      for (const child of sequence.nodes) enqueue(child);
    }
  }

  const seenClusters = new Set();
  for (const cluster of g.clusters.values()) {
    guard.step();
    if (cluster === null) continue;
    if (seenClusters.has(cluster)) continue;
    seenClusters.add(cluster);
    snapshot.clusters.push({ cluster, arrangement: cluster.arrangement, desired: cluster.desiredArrangement, padding: cluster.padding });
  }

  const seenHerds = new Set();
  for (const nodeSnapshot of snapshot.nodes) {
    guard.step();
    const herd = nodeSnapshot.node.herdAssignment;
    if (herd === null) continue;
    if (seenHerds.has(herd)) continue;
    seenHerds.add(herd);
    snapshot.herds.push({
      herd,
      value: { oppositeSidePaired: herd.oppositeSidePaired, sameSidePaired: herd.sameSidePaired, orientation: herd.orientation, val: herd.val },
    });
  }
  return snapshot;
}

export function captureOptimizerNodePositions(nodes, guard) {
  if (nodes.length <= 2) {
    let leaves = true;
    for (const node of nodes) {
      if (node === null) throw errorf(`TALA ${guard.location} found a nil node`);
      if (node.graph === null || node.isContainer() || node.isClusterVessel() || node.graph.sequences.get(node)) {
        leaves = false;
        break;
      }
    }
    if (leaves) {
      const snapshots = [];
      for (const node of nodes) {
        let duplicate = false;
        for (const snapshot of snapshots) {
          if (snapshot.node === node) {
            duplicate = true;
            break;
          }
        }
        if (duplicate) continue;
        guard.step();
        snapshots.push({ node, topLeft: snapshotPointer(node.topLeft) });
      }
      return snapshots;
    }
  }
  if (nodes.length === 1) {
    // optimizerDescendants already deduplicates its traversal, including the root.
    const descendants = optimizerDescendants(nodes[0], guard);
    const snapshots = new Array(descendants.length + 1);
    for (let i = 0; i < snapshots.length; i++) {
      guard.step();
      const node = i > 0 ? descendants[i - 1] : nodes[0];
      snapshots[i] = { node, topLeft: snapshotPointer(node.topLeft) };
    }
    return snapshots;
  }
  const seen = new Set();
  const snapshots = [];
  for (const node of nodes) {
    if (node === null) throw errorf(`TALA ${guard.location} found a nil node`);
    const all = [node];
    const descendants = optimizerDescendants(node, guard);
    all.push(...descendants);
    for (const current of all) {
      if (seen.has(current)) continue;
      if (seen.size >= limits.MaxEngineNodes) throw errorf(`TALA ${guard.location} position snapshot exceeds node limit ${limits.MaxEngineNodes}`);
      guard.step();
      seen.add(current);
      snapshots.push({ node: current, topLeft: snapshotPointer(current.topLeft) });
    }
  }
  return snapshots;
}

/**
 * withOptimizerPositionsSwapped owns the rollback point for a speculative swap and its scoring callback. Reuse this rollback
 * point, replaying the second capture's exact work and cancellation checkpoints.
 */
export function withOptimizerPositionsSwapped(nodeA, nodeB, guard, fn) {
  const before = guard.used();
  const snapshots = captureOptimizerNodePositions([nodeA, nodeB], guard);
  const captureWork = guard.used() - before;
  try {
    if (nodeA === null || nodeB === null || nodeA.topLeft === null || nodeB.topLeft === null) {
      throw errorf(`TALA ${guard.location} cannot swap unpositioned nodes`);
    }
    for (let i = 0; i < captureWork; i++) guard.step();
    const ax = nodeA.topLeft.x;
    const ay = nodeA.topLeft.y;
    optimizerMoveNodeAbs(nodeA, nodeB.topLeft.x, nodeB.topLeft.y, guard);
    optimizerMoveNodeAbs(nodeB, ax, ay, guard);
    return fn();
  } finally {
    restoreNodePositions(snapshots);
  }
}
