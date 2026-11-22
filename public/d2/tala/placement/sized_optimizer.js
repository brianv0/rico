// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of the Go package d2layouts/d2talalayout/internal/placement (D2 v0.9.0, github.com/d2lang/d2, Copyright 2022
// Terrastruct Inc.): sized_optimizer.go, the second (sized) part of the node placement optimizer. The spatial index methods of
// optimizer_spatial_index.go are installed on the prototype.

import * as geo from '../../geo.js';
import { goRound } from '../../gomath.js';
import { errorf } from '../goerrors.js';
import * as lg from '../layoutgraph.js';
import * as limits from '../limits.js';
import * as placementcost from '../placementcost.js';
import * as proximity from '../proximity.js';
import { compare as cmpCompare, sortFunc } from '../goslices.js';
import {
  chargeOptimizerScoring, chargeOptimizerTranspose, optimizerDoesOverlap, optimizerFixedOrigin, optimizerIsDescendantOf, optimizerMedian,
  optimizerMedianToNeighbors, optimizerSwapPositions, withOptimizerPositionsSwapped, captureOptimizerMutationStateInto,
  OptimizerMutationSnapshot, maxOptimizerPlacementCandidates,
} from './optimization_guard.js';
import { OptimizerSpatialIndex, spatialIndexMethods } from './optimizer_spatial_index.js';
import { captureOptimizerCandidateMovement, restoreNodePositions, roundToNearestCellSize } from './types.js';
import { transpose } from './transpose.js';

const pointKey = (x, y) => `${x},${y}`;

export class SizedOptimizer {
  constructor() {
    this.mutationScratch = new OptimizerMutationSnapshot();
    this.g = null;
    this.edgeAbductions = null; // []*EdgeAbduction (a nil slice is null)
    this.randGenerator = null;
    this.fixedOrigin = null;
    this.symmetryCost = 0;
    this.cellSize = 0;
    this.obstacles = [];
    this.checkedPositions = null; // Set of "x,y" (map[geo.Point]struct{})
    this.placementScratch = { seen: null, points: null };
    this.spatialIndex = new OptimizerSpatialIndex();
  }
}

Object.assign(SizedOptimizer.prototype, spatialIndexMethods);

export function iterPlacementsAroundPoint(node, x, y, minimizingSelf, apply) {
  const width = node.width;
  const height = node.height;
  x *= node.graph.cellSize;
  y *= node.graph.cellSize;
  const increment = node.graph.cellSize;
  if (apply(x, y) || !minimizingSelf) return;
  for (let currentX = x - width; currentX <= x; currentX += increment) {
    for (let currentY = y - height; currentY <= y; currentY += increment) {
      if (currentX === x && currentY === y) continue;
      if (apply(currentX, currentY)) return;
    }
  }
}

/**
 * withHubSpokesSuppressed temporarily removes a hub's spoke edges while fn evaluates placements. The original edge slice and
 * ordering are restored on success, error, or panic.
 */
export function withHubSpokesSuppressed(node, spokes, guard, fn) {
  if (node === null) throw errorf('TALA LocalOptimize cannot suppress spokes on a nil hub');
  if (spokes.length > limits.MaxEngineNodes || node.edges.length > limits.MaxEngineEdges) {
    throw errorf('TALA LocalOptimize hub suppression inputs exceed engine limits');
  }
  const originalEdges = node.edges;
  const removed = new Array(originalEdges.length).fill(false);
  try {
    for (const spoke of spokes) {
      guard.step();
      if (spoke === null) throw errorf('TALA LocalOptimize found a nil hub spoke');
      for (let i = 0; i < originalEdges.length; i++) {
        const edge = originalEdges[i];
        guard.step();
        if (removed[i]) continue;
        if (edge === null || (edge.from !== node && edge.to !== node)) throw errorf('TALA LocalOptimize found a malformed hub edge');
        if (node.adjacent(edge) === spoke) {
          removed[i] = true;
          break;
        }
      }
    }
    const workingEdges = [];
    for (let i = 0; i < originalEdges.length; i++) {
      guard.step();
      if (!removed[i]) workingEdges.push(originalEdges[i]);
    }
    node.edges = workingEdges;
    return fn();
  } finally {
    node.edges = originalEdges;
  }
}

export function newSizedOptimizer(ctx, g, root, abductions, randGenerator, obstacles) {
  if (g === null) throw errorf('TALA LocalOptimize requires a graph');
  if (g.nodes.length > limits.MaxEngineNodes) throw errorf(`TALA LocalOptimize node count exceeds limit ${limits.MaxEngineNodes}`);
  if (g.edges.length > limits.MaxEngineEdges) throw errorf(`TALA LocalOptimize edge count exceeds limit ${limits.MaxEngineEdges}`);
  if (abductions !== null && abductions.length > limits.MaxEngineEdges) {
    throw errorf(`TALA LocalOptimize edge abduction count exceeds limit ${limits.MaxEngineEdges}`);
  }
  if (obstacles !== null && obstacles.length > lg.MaxTopologyReferences) {
    throw errorf(`TALA LocalOptimize obstacle count exceeds limit ${lg.MaxTopologyReferences}`);
  }
  if (g.cellSize < 1 || Number.isNaN(g.cellSize) || !Number.isFinite(g.cellSize) || Math.trunc(g.cellSize) !== g.cellSize) {
    throw errorf('TALA LocalOptimize requires a finite positive integer cell size');
  }
  const guard = limits.newOptimizationWorkGuard(ctx, 'LocalOptimizeSetup', limits.MaxOptimizationWorkUnits);
  for (const node of g.nodes) {
    guard.step();
    if (node === null || node.graph === null) throw errorf('TALA LocalOptimize found a node without a graph');
    if (node.edges.length > limits.MaxEngineEdges || node.nears.size > limits.MaxEngineNodes) {
      throw errorf(`TALA LocalOptimize node ${node.debugID()} adjacency references exceed engine limits`);
    }
    if (node.graph.cellSize !== g.cellSize) throw errorf(`cell size mismatch for node ${node.debugID()}`);
  }
  const optim = new SizedOptimizer();
  optim.g = g;
  optim.edgeAbductions = abductions;
  optim.randGenerator = randGenerator;
  optim.fixedOrigin = g.containerFixedOrigin(root);
  optim.symmetryCost = g.cellSize;
  optim.cellSize = g.cellSize;
  optim.obstacles = obstacles ?? [];
  for (const n of g.nodes) {
    guard.step();

    // Pre-process all edge abductions that affect this node
    const abductedEdges = new Set();
    const adjReplacements = new Map();
    for (const ea of optim.edgeAbductions ?? []) {
      guard.step();
      if (ea === null || ea.edge === null) throw errorf('TALA LocalOptimize found a nil edge abduction');
      if (ea.currentFrom === n || ea.currentTo === n) {
        if (ea.originallyFrom !== null || ea.originallyTo !== null) {
          abductedEdges.add(ea.edge);
          continue;
        }
        const adj = n.adjacent(ea.edge);
        if (ea.currentFrom === n && ea.originallyTo !== null) adjReplacements.set(adj, ea.originallyTo);
        else if (ea.currentTo === n && ea.originallyFrom !== null) adjReplacements.set(adj, ea.originallyFrom);
      }
    }

    const cellSizeInt = Math.trunc(optim.cellSize);
    const spaceReqs = new Map();

    for (const edge of n.edges) {
      guard.step();
      if (edge === null || (edge.from !== n && edge.to !== n)) {
        throw errorf(`TALA LocalOptimize found a malformed incident edge on ${n.debugID()}`);
      }
      if (abductedEdges.has(edge)) continue;

      let adj = n.adjacent(edge);
      const replacement = adjReplacements.get(adj);
      if (replacement !== undefined) adj = replacement;

      let requirements = spaceReqs.get(adj);
      if (requirements === undefined) {
        requirements = new lg.LongDistanceNeighborRequirements();
        spaceReqs.set(adj, requirements);
      }
      requirements.edgeCount++;
      if (edge.minWidth > requirements.maxWidth) requirements.maxWidth = edge.minWidth;
      if (edge.minHeight > requirements.maxHeight) requirements.maxHeight = edge.minHeight;
    }

    for (const requirements of spaceReqs.values()) {
      guard.step();
      if (requirements.edgeCount < 3) continue;
      if (requirements.maxWidth <= cellSizeInt && requirements.maxHeight <= cellSizeInt) continue;

      n.longDistanceNeighborRequirements = spaceReqs;
      break;
    }
  }

  guard.finish();
  return optim;
}

SizedOptimizer.prototype.optimize = function (ctx, temp) {
  return this.optimizeWithLimit(ctx, temp, limits.MaxOptimizationWorkUnits);
};

SizedOptimizer.prototype.optimizeWithLimit = function (ctx, temp, workLimit) {
  const optim = this;
  ctx = lg.ensureTransactionWorkGuard(ctx, 'LocalOptimizeTransactions')[0];
  const guard = limits.newOptimizationWorkGuard(ctx, 'LocalOptimize', workLimit);
  if (optim === null || optim.g === null) throw errorf('TALA LocalOptimize requires an optimizer with a graph');
  if (optim.randGenerator === null) throw errorf('TALA LocalOptimize requires a random generator');
  try {
    const snapshot = captureOptimizerMutationStateInto(optim.g, guard, optim.mutationScratch);
    let complete = false;
    try {
      const changed = optim.optimizeGuarded(ctx, temp, guard);
      guard.finish();
      complete = true;
      return changed;
    } finally {
      if (!complete) snapshot.restore();
    }
  } finally {
    optim.mutationScratch.release();
  }
};

SizedOptimizer.prototype.optimizeGuarded = function (ctx, temp, guard) {
  const optim = this;
  let changed = false;

  if (optim.g.nodes.length > limits.MaxEngineNodes) {
    throw errorf(`TALA LocalOptimize node count exceeds limit ${limits.MaxEngineNodes}`);
  }
  const nodeIndices = new Array(optim.g.nodes.length);
  for (let i = 0; i < optim.g.nodes.length; i++) {
    guard.step();
    nodeIndices[i] = i;
  }
  limits.shuffle(nodeIndices, optim.randGenerator, guard);

  for (const nodeIndex of nodeIndices) {
    guard.step();
    const node = optim.g.nodes[nodeIndex];
    if (node === null || node.topLeft === null) throw errorf('TALA LocalOptimize found an unpositioned graph node');
    if (node.fixedTopLeft !== null) continue;
    if (node.width > 100 * optim.cellSize || node.height > 100 * optim.cellSize) {
      // leave giant node where it is, we won't find an unoccupied point within 100 cellSize
      continue;
    }
    if (node.edges.length === 0) {
      let hasUsableNear = false;
      for (const near of node.nears) {
        guard.step();
        const isDescendant = optimizerIsDescendantOf(near, node.container, guard);
        if (isDescendant) {
          hasUsableNear = true;
          break;
        }
      }
      if (!hasUsableNear) continue;
    }
    if (optim.g.nodeToTree !== null && optim.g.nodeToTree.has(node)) continue;

    const protrudingChildren = optim.protrudingChildrenGuarded(node, guard);
    const minimizingSelf = protrudingChildren.length === 0;

    const medianPoint = optim.medianPointGuarded(node, temp, protrudingChildren, guard);
    // All candidate placements for this node see the same boxes for every other graph node. Build one ordered broad-phase
    // index and reuse it until the optimizer commits this node's final position.
    optim.rebuildSpatialIndex(guard);

    let checkedPositionsCache = null;
    // Making and using a cache takes many allocs. Only worth it when this node has to search through many siblings for overlap
    if (nodeIndices.length > 10) {
      if (optim.checkedPositions === null) optim.checkedPositions = new Set();
      else optim.checkedPositions.clear();
      checkedPositionsCache = optim.checkedPositions;
    }
    const d = optim.findClosestUnoccupiedDistanceGuarded(node, medianPoint, minimizingSelf, checkedPositionsCache, guard);

    const points = optim.fillPlacementPointsGuarded(node, medianPoint, d, minimizingSelf, optim.placementScratch, guard);
    limits.shuffle(points, optim.randGenerator, guard);

    // we want mustImprove to be true for the last 10 optimize calls where temp is 0
    const moved = optim.moveNodeToBestGuarded(ctx, node, points, temp === 0, guard);

    if (!moved) {
      const bestSwapCandidate = optim.bestSwapCandidateGuarded(ctx, node, guard);
      if (bestSwapCandidate !== null) {
        changed = true;
        optimizerSwapPositions(node, bestSwapCandidate, guard);
        optim.syncHerdFencesGuarded(guard);
      } else {
        chargeOptimizerTranspose(optim.g, node, optim.edgeAbductions, guard);
        const ok = transpose(ctx, optim.g, node, optim.edgeAbductions);
        guard.step();
        if (ok) {
          changed = true;
        } else {
          // The spokes don't need to move because in the next iteration they'll move
          const spokes = optim.g.hubs.get(node);
          if (spokes !== undefined && temp !== 0) {
            withHubSpokesSuppressed(node, spokes, guard, () => {
              const medianPoint2 = optim.medianPointGuarded(node, temp, protrudingChildren, guard);

              const d2 = optim.findClosestUnoccupiedDistanceGuarded(node, medianPoint2, minimizingSelf, checkedPositionsCache, guard);
              const points2 = optim.fillPlacementPointsGuarded(node, medianPoint2, d2, minimizingSelf, optim.placementScratch, guard);
              limits.shuffle(points2, optim.randGenerator, guard);
              optim.moveNodeToBestGuarded(ctx, node, points2, temp === 0, guard);
            });
          }
        }
      }
    } else {
      optim.syncHerdFencesGuarded(guard);
      changed = true;
    }
  }
  guard.finish();
  return changed;
};

SizedOptimizer.prototype.medianPointGuarded = function (node, temp, protrudingChildren, guard) {
  const optim = this;
  const width = node.width / optim.cellSize;
  const height = node.height / optim.cellSize;
  let [medianX, medianY] = optimizerMedianToNeighbors(node, true, optim.edgeAbductions ?? [], guard);

  const fixedOrigin = optimizerFixedOrigin(optim.g, node.owningContainer(), guard);
  if (fixedOrigin !== null) {
    // we can't have node positions past the fixedOrigin so set a floor
    if (medianX < fixedOrigin.x / optim.cellSize) {
      medianX = fixedOrigin.x / optim.cellSize;
      // normally the random movement is within [-temp*width, temp*width], but anything left of the fixed origin is invalid so
      // make it [0, 2*temp*width]
      medianX += temp * width;
    }
    if (medianY < fixedOrigin.y / optim.cellSize) {
      medianY = fixedOrigin.y / optim.cellSize;
      medianY += temp * height;
    }
  }

  medianX += ((-1.0 * temp * width) + optim.randGenerator.float64() * (2.0 * temp * width));
  medianY += ((-1.0 * temp * height) + optim.randGenerator.float64() * (2.0 * temp * height));

  if (protrudingChildren.length > 0) {
    const [childrenMedianX, childrenMedianY] = optimizerMedian(protrudingChildren, true, guard);
    medianX -= (childrenMedianX - node.topLeft.x / optim.cellSize);
    medianY -= (childrenMedianY - node.topLeft.y / optim.cellSize);
  }

  if (fixedOrigin !== null) {
    medianX = Math.max(medianX, fixedOrigin.x / optim.cellSize);
    medianY = Math.max(medianY, fixedOrigin.y / optim.cellSize);
  }

  return geo.newPoint(goRound(medianX * optim.cellSize), goRound(medianY * optim.cellSize));
};

SizedOptimizer.prototype.protrudingChildrenGuarded = function (node, guard) {
  // If this container were being placed, its median would be the bottom-most node, but that doesn't reflect where we want the
  // node to be. We want the node to be placed such that the median of its children with protruding edges is at the calculated
  // median.
  const protrudingChildren = [];
  for (const ea of this.edgeAbductions ?? []) {
    guard.step();
    if (ea === null) throw errorf('TALA LocalOptimize found a nil edge abduction');
    if (ea.currentFrom === node && ea.originallyFrom !== null) protrudingChildren.push(ea.originallyFrom);
    if (ea.currentTo === node && ea.originallyTo !== null) protrudingChildren.push(ea.originallyTo);
  }
  return protrudingChildren;
};

SizedOptimizer.prototype.findClosestUnoccupiedDistanceGuarded = function (node, p, minimizingSelf, checked, guard) {
  const optim = this;
  if (node === null || node.graph === null || node.topLeft === null || p === null) {
    throw errorf(`TALA ${guard.location} placement search requires a positioned node, graph, and point`);
  }
  if (optim.cellSize <= 0 || Number.isNaN(optim.cellSize) || !Number.isFinite(optim.cellSize)) {
    throw errorf(`TALA ${guard.location} placement search requires a finite positive cell size`);
  }
  if (checked !== null && checked.size > maxOptimizerPlacementCandidates) {
    throw errorf(`${limits.ErrOptimizationResourceLimit.message}: TALA ${guard.location} checked placement count exceeds limit ${maxOptimizerPlacementCandidates}`, limits.ErrOptimizationResourceLimit);
  }
  // example with distance=3, we iterate points from least to most distance; for points at the same distance we iterate right
  // to left (& negative then positive)
  const cellSize = optim.cellSize;

  // For each candidate "ring" (curr is in grid units, then scaled by cellSize)
  for (let curr = 0.0; curr <= 100.0; curr++) {
    guard.step();
    const currCell = curr * cellSize;

    // Start with x at the ring's rightmost point and y = 0. The candidate point offsets are defined relative to p.
    let x = currCell;
    let y = 0.0;

    // Continue until x goes below -currCell.
    while (x >= -currCell) {
      guard.step();
      // Check the candidate at (x, -y) if y is nonzero.
      if (y !== 0) {
        const candidate = new geo.Point(roundToNearestCellSize(p.x + x, cellSize), roundToNearestCellSize(p.y - y, cellSize));
        // Enforce fixed-origin constraint if needed.
        if (optim.fixedOrigin === null || (candidate.x >= optim.fixedOrigin.x && candidate.y >= optim.fixedOrigin.y)) {
          const unoccupied = optim.findUnoccupiedGuarded(x, -y, node.width, node.height, minimizingSelf, node, p, checked, guard);
          if (unoccupied) return curr;
        }
      }
      // Check candidate at (x, y)
      const candidate = new geo.Point(roundToNearestCellSize(p.x + x, cellSize), roundToNearestCellSize(p.y + y, cellSize));
      if (optim.fixedOrigin === null || (candidate.x >= optim.fixedOrigin.x && candidate.y >= optim.fixedOrigin.y)) {
        const unoccupied = optim.findUnoccupiedGuarded(x, y, node.width, node.height, minimizingSelf, node, p, checked, guard);
        if (unoccupied) return curr;
      }

      // Update y: if x > 0, increment y by cellSize; otherwise, decrement y.
      if (x > 0) y += cellSize;
      else y -= cellSize;
      x -= cellSize;
    }
  }
  throw errorf(`could not find closest unoccupied distance for p=${p.toString()}, node=${node.debugID()}`);
};

/**
 * findUnoccupied is a tailored closest-unoccupied-distance search over placements around a node. It is called often enough to
 * warrant a specialized implementation.
 */
SizedOptimizer.prototype.findUnoccupiedGuarded = function (x, y, width, height, minimizingSelf, node, p, checked, guard) {
  const optim = this;
  guard.step();
  let skip = false;
  if (checked !== null) {
    const key = pointKey(x, y);
    if (checked.has(key)) {
      skip = true;
    } else {
      if (checked.size >= maxOptimizerPlacementCandidates) {
        throw errorf(`${limits.ErrOptimizationResourceLimit.message}: TALA ${guard.location} checked placement count exceeds limit ${maxOptimizerPlacementCandidates}`, limits.ErrOptimizationResourceLimit);
      }
      checked.add(key);
    }
  }

  if (!skip) {
    const occupied = optim.isPointOccupiedGuarded(x, y, p, node, guard);
    if (!occupied) return true;
  }

  if (!minimizingSelf) return false;

  for (let i = x - width; i <= x; i += optim.cellSize) {
    for (let j = y - height; j <= y; j += optim.cellSize) {
      guard.step();
      // Already attempted above
      if (i === x && j === y) continue;
      if (checked !== null) {
        const key = pointKey(i, j);
        if (checked.has(key)) continue;
        if (checked.size >= maxOptimizerPlacementCandidates) {
          throw errorf(`${limits.ErrOptimizationResourceLimit.message}: TALA ${guard.location} checked placement count exceeds limit ${maxOptimizerPlacementCandidates}`, limits.ErrOptimizationResourceLimit);
        }
        checked.add(key);
      }
      const occupied = optim.isPointOccupiedGuarded(i, j, p, node, guard);
      if (!occupied) return true;
    }
  }
  return false;
};

SizedOptimizer.prototype.isPointOccupiedGuarded = function (x, y, p, node, guard) {
  const optim = this;
  const point = geo.newPoint(p.x + x, p.y + y);
  point.x = roundToNearestCellSize(point.x, optim.cellSize);
  point.y = roundToNearestCellSize(point.y, optim.cellSize);
  if (optim.fixedOrigin !== null && (point.x < optim.fixedOrigin.x || point.y < optim.fixedOrigin.y)) return true;
  const [, occupied] = optim.indexedIsOccupied(point, guard);
  if (!occupied) {
    const overlaps = optim.indexedDoesOverlap(node, point, [node], guard);
    if (!overlaps) return false;
  }
  return true;
};

/**
 * fillPlacementPointsGuarded fills caller-owned scratch so the optimizer can reuse candidate storage across its
 * generate-shuffle-score loop. Returns the scratch points (geo.Point values).
 */
SizedOptimizer.prototype.fillPlacementPointsGuarded = function (node, median, minUnocc, minimizingSelf, scratch, guard) {
  const optim = this;
  if (node === null || node.topLeft === null || median === null) {
    throw errorf(`TALA ${guard.location} placement generation requires a positioned node and median`);
  }
  if (minUnocc < 0 || minUnocc > 100 || Number.isNaN(minUnocc) || !Number.isFinite(minUnocc)) {
    throw errorf(`TALA ${guard.location} placement distance must be finite and within [0, 100]`);
  }
  if (optim.cellSize <= 0 || Number.isNaN(optim.cellSize) || !Number.isFinite(optim.cellSize)) {
    throw errorf(`TALA ${guard.location} placement generation requires a finite positive cell size`);
  }
  if (scratch.seen === null) scratch.seen = new Set();
  if (scratch.points === null) scratch.points = [];

  // Clear data structures for reuse
  for (let k = 0; k < scratch.seen.size; k++) guard.step();
  scratch.seen.clear();
  scratch.points = [];

  // Calculate distance and estimate capacity
  const dist = minUnocc + 1;

  // The add function checks for duplicates and adds valid points
  let addErr = null;
  const add = (offX, offY) => {
    if (addErr !== null) return true;
    try {
      guard.step();
    } catch (e) {
      addErr = e;
      return true;
    }
    const pX = roundToNearestCellSize(median.x + offX, optim.cellSize);
    const pY = roundToNearestCellSize(median.y + offY, optim.cellSize);

    // Early rejection based on fixed origin
    const fo = optim.fixedOrigin;
    if (fo !== null && (pX < fo.x || pY < fo.y)) return false;

    // Encode coordinates to a single 64-bit value for map lookup: uint64(uint32(ix))<<32 | uint64(uint32(iy))
    const ix = Math.trunc(pX / optim.cellSize);
    const iy = Math.trunc(pY / optim.cellSize);
    const key = `${ix >>> 0},${iy >>> 0}`;

    // Check if duplicate
    if (scratch.seen.has(key)) return false;
    if (scratch.points.length >= maxOptimizerPlacementCandidates) {
      addErr = errorf(`${limits.ErrOptimizationResourceLimit.message}: TALA LocalOptimize placement candidates exceed limit ${maxOptimizerPlacementCandidates}`, limits.ErrOptimizationResourceLimit);
      return true;
    }

    // Add to seen and points collections
    scratch.seen.add(key);
    scratch.points.push(new geo.Point(pX, pY));
    return false;
  };

  // Generate placement points in diamond pattern
  for (let x = dist; x >= -dist; x--) {
    guard.step();
    const maxY = dist - Math.abs(x);
    for (let y = 0.0; y <= maxY; y++) {
      guard.step();
      // Generate points in both positive and negative Y directions
      if (y !== 0) iterPlacementsAroundPoint(node, x, -y, minimizingSelf, add);
      iterPlacementsAroundPoint(node, x, y, minimizingSelf, add);
      if (addErr !== null) throw addErr;
    }
  }

  // Process long-distance neighbor requirements.
  const data = node.longDistanceNeighborRequirements;
  if (data !== null) {
    if (data.size > lg.MaxTopologyReferences) {
      throw errorf(`TALA ${guard.location} long-distance neighbor references exceed limit ${lg.MaxTopologyReferences}`);
    }
    const cell = Math.trunc(optim.cellSize);

    const neighbors = [];
    for (const adjacent of data.keys()) {
      guard.step();
      neighbors.push(adjacent);
    }
    guard.addSort(neighbors.length);
    sortFunc(neighbors, (a, b) => cmpCompare(a.idValue(), b.idValue()));

    for (const adj of neighbors) {
      guard.step();
      const requirements = data.get(adj);
      if (adj === null || adj.topLeft === null) throw errorf(`TALA ${guard.location} found an unpositioned long-distance neighbor`);
      const maxW = requirements.maxWidth;
      const maxH = requirements.maxHeight;

      // Pre-calculate common values
      const ax = adj.topLeft.x - median.x;
      const ay = adj.topLeft.y - median.y;

      // Add specific placement points for width
      if (maxW > cell) {
        add(Math.floor((ax - node.width - maxW) / cell) * cell, ay);
        add(Math.ceil((ax + adj.width + maxW) / cell) * cell, ay);
      }

      // Add specific placement points for height
      if (maxH > cell) {
        add(ax, Math.floor((ay - node.height - maxH) / cell) * cell);
        add(ax, Math.ceil((ay + adj.height + maxH) / cell) * cell);
      }
      if (addErr !== null) throw addErr;
    }
  }

  // Add current position for herd assignments
  if (node.herdAssignment !== null) {
    if (scratch.points.length >= maxOptimizerPlacementCandidates) {
      throw errorf(`${limits.ErrOptimizationResourceLimit.message}: TALA LocalOptimize placement candidates exceed limit ${maxOptimizerPlacementCandidates}`, limits.ErrOptimizationResourceLimit);
    }
    scratch.points.push(node.topLeft.copy());
  }

  // Preserve the original work charge even when the internal caller consumes the scratch slice directly.
  guard.add(scratch.points.length);
  return scratch.points;
};

SizedOptimizer.prototype.moveNodeToBestGuarded = function (ctx, node, points, mustImprove, guard) {
  const optim = this;
  const scorer = placementcost.newNodeEdgeLengthScorer(node, {
    edgeAbductions: optim.edgeAbductions, includeNodeSizes: true, enforceMinimumGap: false, penalizeDirection: true,
  });
  try {
    const symmetryCost = optim.cellSize * node.edges.length;
    let leastDistance = Infinity;
    if (mustImprove) {
      chargeOptimizerScoring(node, optim.edgeAbductions, true, guard);
      leastDistance = scorer.score(ctx);
      const columnCrossingCost = placementcost.columnCrossingCost(ctx, node, optim.edgeAbductions);
      const symmetry = placementcost.nodeSymmetry(ctx, node, optim.edgeAbductions);
      leastDistance += columnCrossingCost;
      leastDistance -= symmetry * symmetryCost;
    }
    let leastDistancePoint = node.topLeft.copy();
    const currentNodeX = node.topLeft.x;
    const currentNodeY = node.topLeft.y;
    const movement = captureOptimizerCandidateMovement(node, guard);
    const originalPositions = movement.positions;
    let complete = false;
    try {
      for (let i = 0; i < points.length; i++) {
        guard.step();
        const point = points[i];
        const x = point.x;
        const y = point.y;
        if (optim.fixedOrigin !== null && (x < optim.fixedOrigin.x || y < optim.fixedOrigin.y)) continue;
        // If the candidate position is the original one, we should be able to move back to it (if we moved somewhere else in
        // this routine)
        let canMove = x === currentNodeX && y === currentNodeY;
        if (!canMove) canMove = optim.indexedCanMove(node, point, guard);
        if (canMove) {
          movement.moveAbs(x, y, guard);
          chargeOptimizerScoring(node, optim.edgeAbductions, true, guard);

          let edgeLength = scorer.score(ctx);
          if (!(leastDistance === Infinity) && geo.precisionCompare(edgeLength - symmetryCost, leastDistance, geo.PRECISION) === 1) {
            // no need to continue, this is clearly worse
            continue;
          }
          const columnCrossingCost = placementcost.columnCrossingCost(ctx, node, optim.edgeAbductions);
          const symmetry = placementcost.nodeSymmetry(ctx, node, optim.edgeAbductions);
          edgeLength += columnCrossingCost;
          edgeLength -= symmetry * symmetryCost;

          for (const o of optim.obstacles) {
            guard.step();
            if (o.TopLeft.x === -lg.ContainerPadding && o.TopLeft.y === -lg.ContainerPadding) continue;
            if (node.box.overlaps(o)) edgeLength += 3 * optim.g.turnCost();
          }

          switch (geo.precisionCompare(edgeLength, leastDistance, geo.PRECISION)) {
            case -1:
              leastDistance = edgeLength;
              leastDistancePoint = point;
              break;
            case 0:
              if (point.x === currentNodeX && point.y === currentNodeY) {
                leastDistance = edgeLength;
                leastDistancePoint = point;
              }
              break;
          }
        }
      }

      const err = ctx.err();
      if (err) throw errorf(`EdgeLength: ${err.message}`, err);
      if (leastDistance === Infinity) throw errorf('sizedOptimizer: could not find any placement');

      movement.moveAbs(leastDistancePoint.x, leastDistancePoint.y, guard);

      complete = true;
      return node.topLeft.x !== currentNodeX || node.topLeft.y !== currentNodeY;
    } finally {
      if (!complete) restoreNodePositions(originalPositions);
    }
  } finally {
    scorer.close();
  }
};

SizedOptimizer.prototype.bestSwapCandidateGuarded = function (ctx, node, guard) {
  const optim = this;
  let minSwapL = Infinity;

  chargeOptimizerScoring(node, optim.edgeAbductions, true, guard);
  const opts = { edgeAbductions: optim.edgeAbductions, includeNodeSizes: true, enforceMinimumGap: false, penalizeDirection: true };
  let currentL1 = placementcost.nodeEdgeLength(ctx, node, opts);
  let columnCrossingCost = placementcost.columnCrossingCost(ctx, node, optim.edgeAbductions);
  let symmetry = placementcost.nodeSymmetry(ctx, node, optim.edgeAbductions);
  currentL1 += columnCrossingCost;
  currentL1 -= symmetry * optim.symmetryCost * node.edges.length;
  let bestSwapCandidate = null;

  const swapCandidateIndices = new Array(optim.g.nodes.length);
  for (let i = 0; i < optim.g.nodes.length; i++) {
    guard.step();
    swapCandidateIndices[i] = i;
  }
  limits.shuffle(swapCandidateIndices, optim.randGenerator, guard);

  for (const swapCandidateIndex of swapCandidateIndices) {
    guard.step();
    const swapCandidate = optim.g.nodes[swapCandidateIndex];
    if (swapCandidate === node) continue;
    if (swapCandidate.fixedTopLeft !== null) continue;
    if (!swapCandidate.isAdjacentTo(node, true)) continue;
    if (optim.g.nodeToTree !== null && optim.g.nodeToTree.has(swapCandidate)) continue;
    const firstOverlap = optim.indexedDoesOverlap(swapCandidate, node.topLeft, [node], guard);
    const secondOverlap = optim.indexedDoesOverlap(node, swapCandidate.topLeft, [swapCandidate], guard);
    if (firstOverlap || secondOverlap) continue;

    chargeOptimizerScoring(swapCandidate, optim.edgeAbductions, true, guard);
    let currentL2 = placementcost.nodeEdgeLength(ctx, swapCandidate, opts);
    columnCrossingCost = placementcost.columnCrossingCost(ctx, swapCandidate, optim.edgeAbductions);
    symmetry = placementcost.nodeSymmetry(ctx, swapCandidate, optim.edgeAbductions);
    currentL2 += columnCrossingCost;
    currentL2 -= symmetry * optim.symmetryCost * swapCandidate.edges.length;

    let swappedL1 = 0;
    let swappedL2 = 0;
    let validSwap = false;
    withOptimizerPositionsSwapped(node, swapCandidate, guard, () => {
      // Have to check for overlap again, since swapping two of different sizes may cause one to overlap with the other -- so,
      // no exceptions in this check
      const firstOverlap2 = optimizerDoesOverlap(swapCandidate, swapCandidate.topLeft, [], guard);
      const secondOverlap2 = optimizerDoesOverlap(node, node.topLeft, [], guard);
      if (firstOverlap2 || secondOverlap2) return null;
      validSwap = true;

      chargeOptimizerScoring(node, optim.edgeAbductions, true, guard);
      swappedL1 = placementcost.nodeEdgeLength(ctx, node, opts);
      columnCrossingCost = placementcost.columnCrossingCost(ctx, node, optim.edgeAbductions);
      symmetry = placementcost.nodeSymmetry(ctx, node, optim.edgeAbductions);
      swappedL1 += columnCrossingCost;
      swappedL1 -= symmetry * optim.symmetryCost * node.edges.length;

      // No need to compute it if we already know it won't be a good swap.
      if (geo.precisionCompare(swappedL1, currentL1, geo.PRECISION) < 0) {
        chargeOptimizerScoring(swapCandidate, optim.edgeAbductions, true, guard);
        swappedL2 = placementcost.nodeEdgeLength(ctx, swapCandidate, opts);
        columnCrossingCost = placementcost.columnCrossingCost(ctx, swapCandidate, optim.edgeAbductions);
        symmetry = placementcost.nodeSymmetry(ctx, swapCandidate, optim.edgeAbductions);
        swappedL2 += columnCrossingCost;
        swappedL2 -= symmetry * optim.symmetryCost * swapCandidate.edges.length;
      }
      return null;
    });
    if (!validSwap) continue;

    if (geo.precisionCompare(swappedL1, currentL1, geo.PRECISION) < 0 && geo.precisionCompare(swappedL1 + swappedL2, currentL1 + currentL2, geo.PRECISION) < 0 && geo.precisionCompare(swappedL1 + swappedL2, minSwapL, geo.PRECISION) < 0) {
      minSwapL = swappedL1 + swappedL2;
      bestSwapCandidate = swapCandidate;
    }
  }

  const err = ctx.err();
  if (err) throw errorf(`EdgeLength: ${err.message}`, err);
  return bestSwapCandidate;
};

SizedOptimizer.prototype.syncHerdFencesGuarded = function (guard) {
  // Preserve the legacy bounding-box semantics (outside labels, modifier elements, loop offsets, routed edges, and fixed
  // origins). Precharging the bounded quadratic scan keeps it under the shared operation budget.
  const nodes = this.g.nodes.length;
  guard.addProduct(nodes, nodes + 1);
  guard.add(this.g.edges.length);
  proximity.syncHerdFences(this.g);
  guard.finish();
};
