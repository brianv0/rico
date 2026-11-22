// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of the Go package d2layouts/d2talalayout/internal/placement (D2 v0.9.0, github.com/d2lang/d2, Copyright 2022
// Terrastruct Inc.): optimizer_spatial_index.go. The index methods of the sized optimizer that live in this file in Go
// (rebuildSpatialIndex, indexedIsOccupied, indexedDoesOverlap, nodeMayMoveDescendants, indexedCanMove) are installed on
// SizedOptimizer.prototype by sized_optimizer.js, which imports this file.

import { errorf } from '../goerrors.js';
import * as limits from '../limits.js';
import { nonNilEquals } from './types.js';
import { optimizerCanMove, optimizerDoesOverlap, optimizerIsOccupied } from './optimization_guard.js';

export const optimizerSpatialIndexMinNodes = 96;

export function optimizerIndexFinite(value) {
  return !Number.isNaN(value) && Number.isFinite(value);
}

export function optimizerIndexFiniteBox(node) {
  if (node === null || node.topLeft === null || node.width < 0 || node.height < 0) return false;
  return optimizerIndexFinite(node.topLeft.x) && optimizerIndexFinite(node.topLeft.y) &&
    optimizerIndexFinite(node.width) && optimizerIndexFinite(node.height) &&
    optimizerIndexFinite(node.topLeft.x + node.width) && optimizerIndexFinite(node.topLeft.y + node.height);
}

const pointKey = (p) => `${p.x},${p.y}`;

/**
 * optimizerSpatialIndex is rebuilt once for each node considered by the sized optimizer. Candidate evaluation may move that
 * node repeatedly, but all other boxes remain fixed; queries skip the moving node by identity.
 */
export class OptimizerSpatialIndex {
  constructor() {
    this.graph = null;
    this.nodeCount = 0;
    this.occupancyUsable = false;
    this.spatialUsable = false;
    this.entries = []; // {graphIndex, left, top, right, bottom}
    this.maxRight = [];
    this.candidates = [];
    this.occupied = null; // Map<string, {graphIndex, generation}>
    this.occupancyGeneration = 0;
  }

  rebuild(g, guard) {
    const index = this;
    if (g === null) throw errorf(`TALA ${guard.location} spatial index requires a graph`);
    if (g.nodes.length > limits.MaxEngineNodes) {
      throw errorf(`TALA ${guard.location} spatial index node count exceeds limit ${limits.MaxEngineNodes}`);
    }

    index.graph = g;
    index.nodeCount = g.nodes.length;
    index.occupancyUsable = true;
    index.spatialUsable = g.nodes.length >= optimizerSpatialIndexMinNodes;
    index.entries = [];
    index.candidates = [];

    index.occupancyGeneration++;
    // Avoid clearing map buckets on every optimizer node while bounding stale coordinate retention when accepted moves
    // continually introduce new keys.
    const maxRetained = Math.max(64, 4 * g.nodes.length);
    if (index.occupied !== null && index.occupied.size > maxRetained) {
      index.occupied.clear();
      index.occupancyGeneration = 1;
    }
    if (index.occupied === null) index.occupied = new Map();

    for (let graphIndex = 0; graphIndex < g.nodes.length; graphIndex++) {
      const node = g.nodes[graphIndex];
      guard.step();
      if (node === null) throw errorf(`TALA ${guard.location} found a nil graph node`);
      if (node.topLeft === null) continue;
      if (!optimizerIndexFinite(node.topLeft.x) || !optimizerIndexFinite(node.topLeft.y)) {
        index.occupancyUsable = false;
        index.spatialUsable = false;
        continue;
      }
      const key = pointKey(node.topLeft);
      const entry = index.occupied.get(key);
      if (entry === undefined || entry.generation !== index.occupancyGeneration) {
        index.occupied.set(key, { graphIndex, generation: index.occupancyGeneration });
      }

      if (!index.spatialUsable) continue;
      if (!optimizerIndexFiniteBox(node)) {
        // The legacy predicates have intentionally unusual behavior for NaN, infinities, and negative dimensions. Retain that
        // behavior by using their full scan rather than forcing those values into an ordering.
        index.spatialUsable = false;
        continue;
      }
      index.entries.push({
        graphIndex,
        left: node.topLeft.x,
        top: node.topLeft.y,
        right: node.topLeft.x + node.width,
        bottom: node.topLeft.y + node.height,
      });
    }

    if (!index.spatialUsable || index.entries.length === 0) {
      guard.finish();
      return;
    }
    guard.addSort(index.entries.length);
    index.entries.sort((a, b) => {
      if (a.left !== b.left) {
        if (a.left < b.left) return -1;
        if (b.left < a.left) return 1;
        return 0;
      }
      return a.graphIndex < b.graphIndex ? -1 : a.graphIndex > b.graphIndex ? 1 : 0;
    });

    index.maxRight = new Array(4 * index.entries.length).fill(0);
    index.buildMaxRight(1, 0, index.entries.length);
    guard.finish();
  }

  buildMaxRight(treeIndex, low, high) {
    const index = this;
    if (high - low === 1) {
      index.maxRight[treeIndex] = index.entries[low].right;
      return index.maxRight[treeIndex];
    }
    const middle = low + Math.trunc((high - low) / 2);
    const leftMax = index.buildMaxRight(treeIndex * 2, low, middle);
    const rightMax = index.buildMaxRight(treeIndex * 2 + 1, middle, high);
    index.maxRight[treeIndex] = Math.max(leftMax, rightMax);
    return index.maxRight[treeIndex];
  }

  query(left, top, right, bottom, guard) {
    const index = this;
    index.candidates = [];
    if (!index.spatialUsable || index.entries.length === 0) {
      guard.finish();
      return index.candidates;
    }
    index.queryTree(1, 0, index.entries.length, left, top, right, bottom, guard);
    guard.addSort(index.candidates.length);
    index.candidates.sort((a, b) => a - b);
    guard.finish();
    return index.candidates;
  }

  queryTree(treeIndex, low, high, left, top, right, bottom, guard) {
    const index = this;
    guard.step();
    if (low >= high || index.maxRight[treeIndex] < left || index.entries[low].left > right) return;
    if (high - low === 1) {
      const entry = index.entries[low];
      if (entry.left <= right && entry.right >= left && entry.top <= bottom && entry.bottom >= top) {
        index.candidates.push(entry.graphIndex);
      }
      return;
    }
    const middle = low + Math.trunc((high - low) / 2);
    index.queryTree(treeIndex * 2, low, middle, left, top, right, bottom, guard);
    index.queryTree(treeIndex * 2 + 1, middle, high, left, top, right, bottom, guard);
  }

  /** [node, occupied] */
  isOccupied(g, point, guard) {
    const index = this;
    if (index.graph !== g || index.nodeCount !== g.nodes.length || !index.occupancyUsable ||
        !optimizerIndexFinite(point.x) || !optimizerIndexFinite(point.y)) {
      return optimizerIsOccupied(g, point, guard);
    }
    guard.step();
    const entry = index.occupied.get(pointKey(point));
    if (entry === undefined || entry.generation !== index.occupancyGeneration) {
      guard.finish();
      return [null, false];
    }
    if (entry.graphIndex < 0 || entry.graphIndex >= g.nodes.length) {
      throw errorf(`TALA ${guard.location} spatial occupancy index is stale`);
    }
    const result = [g.nodes[entry.graphIndex], true];
    guard.finish();
    return result;
  }

  doesOverlap(node, point, exceptions, guard) {
    const index = this;
    if (node === null || node.graph === null || point === null) {
      throw errorf(`TALA ${guard.location} overlap check requires a node, graph, and point`);
    }
    if (node.graph.nodes.length > limits.MaxEngineNodes || exceptions.length > limits.MaxEngineNodes) {
      throw errorf(`TALA ${guard.location} overlap inputs exceed node limit ${limits.MaxEngineNodes}`);
    }
    if (index.graph !== node.graph || index.nodeCount !== node.graph.nodes.length || !index.spatialUsable ||
        !optimizerIndexFinite(point.x) || !optimizerIndexFinite(point.y) ||
        !optimizerIndexFinite(node.width) || !optimizerIndexFinite(node.height) ||
        node.width < 0 || node.height < 0 ||
        !optimizerIndexFinite(point.x + node.width) || !optimizerIndexFinite(point.y + node.height)) {
      return optimizerDoesOverlap(node, point, exceptions, guard);
    }

    const maxSafeDelta = 500.0;
    const candidates = index.query(
      point.x - maxSafeDelta,
      point.y - maxSafeDelta,
      point.x + node.width + maxSafeDelta,
      point.y + node.height + maxSafeDelta,
      guard,
    );
    const right = point.x + node.width;
    const bottom = point.y + node.height;
    for (const graphIndex of candidates) {
      guard.step();
      const otherNode = node.graph.nodes[graphIndex];
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
      // The interval query is deliberately only a broad phase. Retain the historical directional spacing calculation and
      // strict comparisons.
      guard.add(node.edges.length);
      const delta = node.deltaTo(otherNode, point);
      if (point.x < otherNode.topLeft.x + otherNode.width + delta && right + delta > otherNode.topLeft.x &&
          point.y < otherNode.topLeft.y + otherNode.height + delta && bottom + delta > otherNode.topLeft.y) {
        return true;
      }
    }
    guard.finish();
    return false;
  }
}

// ---- the sizedOptimizer methods of optimizer_spatial_index.go (installed on SizedOptimizer.prototype) ----

export const spatialIndexMethods = {
  rebuildSpatialIndex(guard) {
    const optim = this;
    if (optim === null || optim.g === null) throw errorf(`TALA ${guard.location} spatial index requires an optimizer graph`);
    optim.spatialIndex.rebuild(optim.g, guard);
  },

  indexedIsOccupied(point, guard) {
    return this.spatialIndex.isOccupied(this.g, point, guard);
  },

  indexedDoesOverlap(node, point, exceptions, guard) {
    return this.spatialIndex.doesOverlap(node, point, exceptions, guard);
  },

  nodeMayMoveDescendants(node) {
    return node !== null && (node.isContainer() || node.isClusterVessel() || !!this.g.sequences.get(node));
  },

  indexedCanMove(node, point, guard) {
    const optim = this;
    if (node === null || node.graph === null || point === null) {
      throw errorf(`TALA ${guard.location} movement check requires a node, graph, and point`);
    }
    if (nonNilEquals(node.topLeft, point)) return true;
    // Candidate scoring moves descendants together with a container, cluster, or sequence vessel. Their indexed boxes would
    // become stale after the first trial point, so retain the legacy scan for those comparatively rare nodes.
    if (optim.nodeMayMoveDescendants(node)) return optimizerCanMove(node, point, true, guard);
    const [, occupied] = optim.indexedIsOccupied(point, guard);
    if (occupied) return !occupied;
    const overlaps = optim.indexedDoesOverlap(node, point, [], guard);
    return !overlaps;
  },
};
