// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of the Go package d2layouts/d2talalayout/internal/placement (D2 v0.9.0, github.com/d2lang/d2, Copyright 2022
// Terrastruct Inc.): sizeless_optimizer.go, the first (sizeless) part of the optimization routine described in "Graph Compact
// Orthogonal Layout Algorithm" by Freivalds and Glagolevs.

import * as geo from '../../geo.js';
import { goFixed, goRound } from '../../gomath.js';
import { errorf, GoError } from '../goerrors.js';
import * as lg from '../layoutgraph.js';
import * as limits from '../limits.js';
import * as placementcost from '../placementcost.js';
import {
  chargeOptimizerScoring, optimizerFixedOrigin, optimizerIsDescendantOf, optimizerMedianToNeighbors, optimizerSwapPositions,
  withOptimizerPositionsSwapped, captureOptimizerMutationStateInto, OptimizerMutationSnapshot, maxOptimizerPlacementCandidates,
} from './optimization_guard.js';
import { captureOptimizerCandidateMovement, numPointsWithinManhattanDistance, restoreNodePositions } from './types.js';

/**
 * sizelessOptimizer holds the state during the first part (sizeless) of the optimization routine. `occupied` is
 * map[geo.Point]*Node (a PointMap).
 */
export class SizelessOptimizer {
  constructor() {
    this.mutationScratch = new OptimizerMutationSnapshot();
    this.nodes = [];
    this.g = null;
    this.randGenerator = null;
    this.occupied = null;
  }

  /** resetOccupied resets the occupied positions of the optimizer; useful if the nodes changed their positions outside optimize. */
  resetOccupied() {
    const optim = this;
    optim.occupied = new lg.PointMap();
    for (const n of optim.g.nodes) {
      if (n.topLeft === null) continue;
      optim.occupied.set(n.topLeft, n);
    }
  }

  /**
   * optimize optimizes sizeless node placement following the routine described in Graph Compact Orthogonal Layout Algorithm by
   * Freivalds and Glagolevs. Nodes are optimized in random order.
   */
  optimize(ctx, temp) {
    return this.optimizeWithLimit(ctx, temp, limits.MaxOptimizationWorkUnits);
  }

  optimizeWithLimit(ctx, temp, workLimit) {
    const optim = this;
    const guard = limits.newOptimizationWorkGuard(ctx, 'sizelessOptimizer.optimize', workLimit);
    if (optim === null || optim.g === null) throw errorf('TALA sizelessOptimizer.optimize requires an optimizer with a graph');
    if (optim.randGenerator === null) throw errorf('TALA sizelessOptimizer.optimize requires a random generator');
    try {
      const snapshot = captureOptimizerMutationStateInto(optim.g, guard, optim.mutationScratch);
      const occupiedRef = optim.occupied;
      const occupiedSnapshot = [];
      for (const [point, node] of optim.occupied.entries()) {
        guard.step();
        occupiedSnapshot.push([point, node]);
      }
      const restoreOccupied = () => {
        if (occupiedRef === null) {
          optim.occupied = null;
          return;
        }
        occupiedRef.clear();
        for (const [point, node] of occupiedSnapshot) occupiedRef.set(point, node);
        optim.occupied = occupiedRef;
      };
      let complete = false;
      try {
        optim.optimizeGuarded(ctx, temp, guard);
        guard.finish();
        complete = true;
      } finally {
        if (!complete) {
          snapshot.restore();
          restoreOccupied();
        }
      }
    } finally {
      optim.mutationScratch.release();
    }
  }

  optimizeGuarded(ctx, temp, guard) {
    const optim = this;
    if (optim.nodes.length > limits.MaxEngineNodes) {
      throw errorf(`TALA sizelessOptimizer.optimize node count exceeds limit ${limits.MaxEngineNodes}`);
    }

    const nodeIndices = new Array(optim.nodes.length);
    for (let i = 0; i < optim.nodes.length; i++) {
      guard.step();
      nodeIndices[i] = i;
    }
    limits.shuffle(nodeIndices, optim.randGenerator, guard);

    for (const nodeIndex of nodeIndices) {
      guard.step();
      const node = optim.nodes[nodeIndex];
      if (node === null || node.topLeft === null) throw errorf('TALA sizelessOptimizer.optimize found an unpositioned node');

      // we should always be able to move to the original position
      optim.occupied.delete(node.topLeft);
      const medianPoint = optim.medianPointGuarded(node, temp, guard);
      let distance;
      try {
        distance = optim.findClosestUnoccupiedDistanceGuarded(node, medianPoint, guard);
      } catch (e) {
        if (e instanceof GoError) throw errorf(`could not find an unoccupied distance for ${node.debugID()}: ${e.message}`, e);
        throw e;
      }
      const points = optim.placementPointsGuarded(node, medianPoint, distance, guard);
      limits.shuffle(points, optim.randGenerator, guard);

      const moved = optim.moveNodeToBestGuarded(ctx, node, points, guard);

      if (!moved) {
        const bestSwapCandidate = optim.bestSwapCandidateGuarded(ctx, node, guard);
        if (bestSwapCandidate !== null) {
          optimizerSwapPositions(node, bestSwapCandidate, guard);
          optim.occupied.set(bestSwapCandidate.topLeft, bestSwapCandidate);
        }
      }
      optim.occupied.set(node.topLeft, node);
    }
    guard.finish();
  }

  medianPointGuarded(node, temp, guard) {
    const optim = this;
    let [medianX, medianY] = optimizerMedianToNeighbors(node, false, [], guard);

    const cell = optim.g.cellSize;
    const fixedOrigin = optimizerFixedOrigin(optim.g, node.owningContainer(), guard);
    if (fixedOrigin !== null) {
      if (cell <= 0 || Number.isNaN(cell) || !Number.isFinite(cell)) {
        throw errorf(`TALA ${guard.location} fixed-origin placement requires a finite positive cell size`);
      }
      // we can't have node positions past the fixedOrigin so set a floor
      if (medianX < fixedOrigin.x / cell) {
        medianX = fixedOrigin.x / cell;
        medianX += temp;
      }
      if (medianY < fixedOrigin.y / cell) {
        medianY = fixedOrigin.y / cell;
        medianY += temp;
      }
    }

    medianX += (-temp + optim.randGenerator.float64() * (2.0 * temp));
    medianY += (-temp + optim.randGenerator.float64() * (2.0 * temp));

    if (fixedOrigin !== null) {
      medianX = Math.max(medianX, fixedOrigin.x / cell);
      medianY = Math.max(medianY, fixedOrigin.y / cell);
    }

    return geo.newPoint(goRound(medianX), goRound(medianY));
  }

  /** FindClosestUnoccupiedDistance finds the closest distance from `medianPoint` which is not occupied by any other node. */
  FindClosestUnoccupiedDistance(ctx, node, medianPoint) {
    const guard = limits.newOptimizationWorkGuard(ctx, 'sizelessOptimizer.optimize', limits.MaxOptimizationWorkUnits);
    return this.findClosestUnoccupiedDistanceGuarded(node, medianPoint, guard);
  }

  findClosestUnoccupiedDistanceGuarded(node, medianPoint, guard) {
    const optim = this;
    if (node === null || node.graph === null || medianPoint === null) {
      throw errorf(`TALA ${guard.location} placement search requires a node, graph, and median`);
    }
    const fixedOrigin = optimizerFixedOrigin(node.graph, node.owningContainer(), guard);
    if (fixedOrigin !== null) {
      if (node.graph.cellSize <= 0 || Number.isNaN(node.graph.cellSize) || !Number.isFinite(node.graph.cellSize)) {
        throw errorf(`TALA ${guard.location} fixed-origin placement requires a finite positive cell size`);
      }
      fixedOrigin.x = goRound(fixedOrigin.x / node.graph.cellSize);
      fixedOrigin.y = goRound(fixedOrigin.y / node.graph.cellSize);
    }
    const pastOrigin = (x, y) => fixedOrigin !== null && (x < fixedOrigin.x || y < fixedOrigin.y);

    for (let curr = 0; curr <= 100; curr++) {
      guard.step();
      // for points at the same distance we iterate right to left (& negative then positive)
      for (let x = curr, y = 0; x >= -curr; x--) {
        guard.step();
        if (y !== 0) {
          const p = geo.newPoint(medianPoint.x + x, medianPoint.y - y);
          if (!pastOrigin(p.x, p.y) && !optim.isOccupied(p)) return curr;
        }
        const p = geo.newPoint(medianPoint.x + x, medianPoint.y + y);
        if (!pastOrigin(p.x, p.y) && !optim.isOccupied(p)) return curr;
        if (x > 0) y++;
        else y--;
      }
    }
    throw errorf(`no unoccupied points within d=100 of p=${medianPoint.toString()}`);
  }

  isOccupied(p) {
    return this.occupied.has(p);
  }

  /**
   * placementPointsGuarded generates points up to minUnoccupiedDistance+1 from medianPoint. The resulting points contain only
   * valid positions (unoccupied and positive if there are fixed position nodes).
   */
  placementPointsGuarded(node, medianPoint, minUnoccupiedDistance, guard) {
    const optim = this;
    if (node === null || node.graph === null || medianPoint === null) {
      throw errorf(`TALA ${guard.location} placement generation requires a node, graph, and median`);
    }
    if (minUnoccupiedDistance < 0 || minUnoccupiedDistance > 100 || Number.isNaN(minUnoccupiedDistance) || !Number.isFinite(minUnoccupiedDistance)) {
      throw errorf(`TALA ${guard.location} placement distance must be finite and within [0, 100]`);
    }
    const distance = minUnoccupiedDistance + 1;
    const capacity = numPointsWithinManhattanDistance(distance) + 1;
    if (capacity < 0 || capacity > maxOptimizerPlacementCandidates) {
      throw errorf(`${limits.ErrOptimizationResourceLimit.message}: TALA sizelessOptimizer.optimize placement candidates exceed limit ${maxOptimizerPlacementCandidates}`, limits.ErrOptimizationResourceLimit);
    }
    const points = [];

    const fixedOrigin = optimizerFixedOrigin(node.graph, node.owningContainer(), guard);
    if (fixedOrigin !== null) {
      if (node.graph.cellSize <= 0 || Number.isNaN(node.graph.cellSize) || !Number.isFinite(node.graph.cellSize)) {
        throw errorf(`TALA ${guard.location} fixed-origin placement requires a finite positive cell size`);
      }
      fixedOrigin.x = goRound(fixedOrigin.x / node.graph.cellSize);
      fixedOrigin.y = goRound(fixedOrigin.y / node.graph.cellSize);
    }
    const pastOrigin = (x, y) => fixedOrigin !== null && (x < fixedOrigin.x || y < fixedOrigin.y);

    for (let x = distance; x >= -distance; x--) {
      guard.step();
      for (let y = 0.0; y <= distance - Math.abs(x); y++) {
        guard.step();
        if (y !== 0) {
          const point = geo.newPoint(medianPoint.x + x, medianPoint.y - y);
          if (!pastOrigin(point.x, point.y) && !optim.isOccupied(point)) points.push(point);
        }
        const point = geo.newPoint(medianPoint.x + x, medianPoint.y + y);
        if (!pastOrigin(point.x, point.y) && !optim.isOccupied(point)) points.push(point);
      }
    }

    return points;
  }

  moveNodeToBestGuarded(ctx, node, points, guard) {
    const scorer = placementcost.newNodeEdgeLengthScorer(node, {
      edgeAbductions: null, includeNodeSizes: false, enforceMinimumGap: false, penalizeDirection: true,
    });
    try {
      let leastDistance = Infinity;
      let leastDistancePoint = node.topLeft.copy();
      const currentNodeX = node.topLeft.x;
      const currentNodeY = node.topLeft.y;
      const movement = captureOptimizerCandidateMovement(node, guard);
      const originalPositions = movement.positions;
      let complete = false;
      try {
        for (const point of points) {
          guard.step();
          if (point === null) throw errorf('TALA sizelessOptimizer.optimize found a nil placement point');
          const x = point.x;
          const y = point.y;
          movement.moveAbs(x, y, guard);
          chargeOptimizerScoring(node, null, false, guard);
          const edgeLength = scorer.score(ctx);
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

        const err = ctx.err();
        if (err) throw errorf(`EdgeLength: ${err.message}`, err);
        if (leastDistance === Infinity) throw errorf('sizelessOptimizer.moveNodeToBest: could not find any placement');

        movement.moveAbs(leastDistancePoint.x, leastDistancePoint.y, guard);

        complete = true;
        return node.topLeft.x !== currentNodeX || node.topLeft.y !== currentNodeY;
      } finally {
        if (!complete) restoreNodePositions(originalPositions);
      }
    } finally {
      scorer.close();
    }
  }

  bestSwapCandidateGuarded(ctx, node, guard) {
    const optim = this;
    chargeOptimizerScoring(node, null, false, guard);
    let minSwapL1 = placementcost.nodeEdgeLength(ctx, node, { edgeAbductions: null, includeNodeSizes: false, enforceMinimumGap: false, penalizeDirection: true });
    let bestSwapCandidate = null;

    const swapCandidates = optim.swapCandidatesGuarded(node, guard);
    limits.shuffle(swapCandidates, optim.randGenerator, guard);

    for (const swapCandidate of swapCandidates) {
      guard.step();
      chargeOptimizerScoring(swapCandidate, null, false, guard);
      const currentL2 = placementcost.nodeEdgeLength(ctx, swapCandidate, { edgeAbductions: null, includeNodeSizes: false, enforceMinimumGap: false, penalizeDirection: true });

      let swappedL1 = 0;
      let swappedL2 = 0;
      withOptimizerPositionsSwapped(node, swapCandidate, guard, () => {
        chargeOptimizerScoring(node, null, false, guard);
        swappedL1 = placementcost.nodeEdgeLength(ctx, node, { edgeAbductions: null, includeNodeSizes: false, enforceMinimumGap: false, penalizeDirection: true });
        // No need to compute it if we already know it won't be a good swap.
        if (geo.precisionCompare(swappedL1, minSwapL1, geo.PRECISION) < 0) {
          chargeOptimizerScoring(swapCandidate, null, false, guard);
          swappedL2 = placementcost.nodeEdgeLength(ctx, swapCandidate, { edgeAbductions: null, includeNodeSizes: false, enforceMinimumGap: false, penalizeDirection: true });
        }
        return null;
      });

      // Both positions have to be better than before
      if (geo.precisionCompare(swappedL1, minSwapL1, geo.PRECISION) < 0 && geo.precisionCompare(swappedL2, currentL2, geo.PRECISION) <= 0) {
        minSwapL1 = swappedL1;
        bestSwapCandidate = swapCandidate;
      }
    }

    const err = ctx.err();
    if (err) throw errorf(`EdgeLength: ${err.message}`, err);
    return bestSwapCandidate;
  }

  /** swapCandidatesGuarded finds the optimizable nodes adjacent to node. */
  swapCandidatesGuarded(node, guard) {
    const optim = this;
    const adjacent = [];
    const tl = node.topLeft;

    const adjacentNode = (xDiff, yDiff) => {
      guard.step();
      const other = optim.occupied.get(geo.newPoint(tl.x + xDiff, tl.y + yDiff));
      if (other !== undefined) {
        const canOptimize = canOptimizeNodeGuarded(other, optim.g, guard);
        if (canOptimize) return other;
      }
      return null;
    };

    const above = adjacentNode(0, -1);
    if (above !== null) adjacent.push(above);
    const below = adjacentNode(0, 1);
    if (below !== null) adjacent.push(below);
    const left = adjacentNode(-1, 0);
    if (left !== null) adjacent.push(left);
    const right = adjacentNode(1, 0);
    if (right !== null) adjacent.push(right);

    return adjacent;
  }
}

export function newSizelessOptimizer(ctx, g, randGenerator) {
  if (g === null) throw errorf('TALA sizelessOptimizer requires a graph');
  if (g.nodes.length > limits.MaxEngineNodes) throw errorf(`TALA sizelessOptimizer node count exceeds limit ${limits.MaxEngineNodes}`);
  if (g.edges.length > limits.MaxEngineEdges) throw errorf(`TALA sizelessOptimizer edge count exceeds limit ${limits.MaxEngineEdges}`);
  const guard = limits.newOptimizationWorkGuard(ctx, 'sizelessOptimizer.setup', limits.MaxOptimizationWorkUnits);
  for (const node of g.nodes) {
    guard.step();
    if (node === null || node.graph === null) throw errorf('TALA sizelessOptimizer found a node without a graph');
    if (node.edges.length > limits.MaxEngineEdges || node.nears.size > limits.MaxEngineNodes) {
      throw errorf(`TALA sizelessOptimizer node ${node.debugID()} adjacency references exceed engine limits`);
    }
    if (node.graph.cellSize !== g.cellSize) {
      throw errorf(`mismatch of cell size, graph=${goFixed(g.cellSize, 6)}, node=${goFixed(node.graph.cellSize, 6)}`);
    }
  }
  const optim = new SizelessOptimizer();
  optim.g = g;
  optim.randGenerator = randGenerator;
  optim.resetOccupied();
  for (const node of g.nodes) {
    guard.step();
    const canOptimize = canOptimizeNodeGuarded(node, g, guard);
    if (canOptimize) optim.nodes.push(node);
  }
  guard.finish();
  return optim;
}

/** canOptimizeNodeGuarded reports whether a node can be optimized: it must have edges (or nears), no fixed position, and not be in a tree. */
export function canOptimizeNodeGuarded(node, g, guard) {
  if (node === null || g === null) throw errorf(`TALA ${guard.location} found a nil optimizer node`);
  if (node.edges.length === 0) {
    let hasUsableNear = false;
    for (const near of node.nears) {
      guard.step();
      const usable = optimizerIsDescendantOf(near, node.container, guard);
      if (usable) {
        hasUsableNear = true;
        break;
      }
    }
    if (!hasUsableNear) return false;
  }
  if (node.fixedTopLeft !== null) return false;
  const inTree = g.nodeToTree !== null && g.nodeToTree.has(node);
  return !inTree;
}
