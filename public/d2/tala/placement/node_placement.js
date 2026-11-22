// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of the Go package d2layouts/d2talalayout/internal/placement (D2 v0.9.0, github.com/d2lang/d2, Copyright 2022
// Terrastruct Inc.): node_placement.go (phase 1 of the algorithm: NodePlacement, pipeline stage 7).

import * as geo from '../../geo.js';
import { goRound } from '../../gomath.js';
import { newRand } from '../../gorand.js';
import { errorf, GoError } from '../goerrors.js';
import * as grouping from '../grouping.js';
import * as invariant from '../invariant.js';
import * as lg from '../layoutgraph.js';
import * as loops from '../loops.js';
import * as packing from '../packing.js';
import * as proximity from '../proximity.js';
import * as trees from '../trees.js';
import { compaction } from './compaction.js';
import { optimizeCluster } from './cluster_optimization.js';
import { direct } from './direct.js';
import { orientSourceInterior } from './container_orientation.js';
import { initializeByGraphDistance, initializeNodes } from './initialize.js';
import { newSizedOptimizer } from './sized_optimizer.js';
import { newSizelessOptimizer } from './sizeless_optimizer.js';
import { goPowPos } from './gotrig.js';
import {
  compactionFactor, horizontalAxis, nodePlacementIterations, axisOpposite, roundToPreviousCellSize, verticalAxis,
} from './types.js';

/**
 * placeNodes is phase 1 of the algorithm. `randomSeed` is a BigInt, `prevEdgeAbductions` null (Go nil) or an array,
 * `ancestorObstacles` an array of geo.Box.
 */
export function placeNodes(ctx, g, root, randomSeed, prevEdgeAbductions, ancestorObstacles) {
  ancestorObstacles = ancestorObstacles ?? [];
  // Edge cases
  if (g.nodes.length === 0) return;

  if (g.nodes.length === 1) {
    const node = g.nodes[0];
    if (node.fixedTopLeft !== null) node.topLeft = node.fixedTopLeft.copy();
    else node.topLeft = geo.newPoint(0, 0);
    g.syncNestedGeometry();
    // there may be trees that need to be reconnected to this node
    trees.place(ctx, g, root);
    direct(ctx, g, g.nodes, root, {});
    return;
  }

  // This graph is one undergoing node placement in this call
  const childrenGraph = lg.newGraph();
  childrenGraph.copyEntitiesFrom(g);

  // Add every direct child of the current root to the new graph
  for (const child of g.containers.get(root) ?? []) childrenGraph.addNodeUnchecked(child);
  if (childrenGraph.nodes.length === 0) return;

  // When performing layout for a fixed child A, if child B is also fixed it creates an obstacle to try to avoid for A's children
  // layout. We want to take the ancestor obstacles for layout at this level, and translate them to be relative to this root node.
  // Note: it isn't always possible to avoid overlaps depending on the fixed positions. Note: we don't know final sizes of A and B.
  const fixedObstacles = [];
  for (const n of lg.Nodes.fixedNodes(g.containers.get(root) ?? [])) {
    // TODO improve by computing minimum width/height (width >= widest child + padding, width >= rightmost fixed child)
    const box = new geo.Box(n.fixedTopLeft.copy(), n.width, n.height);
    fixedObstacles.push(box);
  }

  // The deferred functions of the Go code, run in reverse order when the function ends (normally or not).
  const defers = [];
  try {
    if (root !== null && root.fixedTopLeft !== null && ancestorObstacles.length > 1) {
      const dx = -root.fixedTopLeft.x - lg.ContainerPadding;
      const dy = -root.fixedTopLeft.y - lg.ContainerPadding;
      if (dx !== 0 || dy !== 0) {
        for (const b of ancestorObstacles) {
          b.TopLeft.x += dx;
          b.TopLeft.y += dy;
        }
        defers.push(() => {
          for (const b of ancestorObstacles) {
            b.TopLeft.x -= dx;
            b.TopLeft.y -= dy;
          }
        });
      }
    }

    const edgeAbductions = g.abductEdges(root, childrenGraph);
    let abductionsRestored = false;
    defers.push(() => {
      if (abductionsRestored) return;
      g.restoreEdgeAbductions(edgeAbductions);
      lg.Nodes.setGraphReference(g.nodes, g);
    });

    const childrenOrder = placeChildrenOrder(ctx, g.containers.get(root) ?? [], edgeAbductions);
    for (const child of childrenOrder) {
      if (child.hierarchy !== null) continue;
      // If the direct child is a container with more children, then recurse first. So we go from most nested to least (root)
      if (child.isContainer()) {
        placeNodes(ctx, g, child, randomSeed, edgeAbductions, fixedObstacles);
        loops.updateOffsets(child);
        // descendant may have placed trees so we need to update containers map
        childrenGraph.containers = g.containers;
      }
      if (child.isClusterVessel()) {
        for (const n of g.clusters.get(child).nodes) {
          if (n.isContainer()) {
            placeNodes(ctx, g, n, randomSeed, edgeAbductions, fixedObstacles);
            childrenGraph.containers = g.containers;
          }
        }
      }
    }

    // we don't know how the subgraphs will be combined (unless it is only one), but we can try to layout each subgraph assuming
    // it is the only one and therefore it should try to avoid fixed ancestors; then when we combine subgraphs, we can also avoid
    // fixed ancestors

    proximity.assignNears(ctx, childrenGraph, root, prevEdgeAbductions ?? []);
    proximity.assignHerds(ctx, childrenGraph, root, prevEdgeAbductions ?? []);
    const [subgraphs, splitOwnership] = childrenGraph.splitSubgraphsTracked(ctx, { includeNears: true, traverseTrees: true }, null);
    let splitCommitted = false;
    defers.push(() => {
      if (!splitCommitted) {
        // SplitSubgraphs redirects every reachable node to a temporary graph, including Near-only nodes outside g.Nodes.
        // Restore their exact prior owners if any later placement work fails or panics.
        splitOwnership.restore();
      }
    });
    for (const subgraph of subgraphs) {
      subgraph.computeCellSize();
      // Put all the nested nodes Graph reference as the subgraph. There are calls that use the node's graph reference
      lg.Nodes.setGraphReference(subgraph.nodes, subgraph);

      // TODO: this must be a better check, like only select the nodes that must be placed. probably, we want to skip placing
      // nodes that were already placed
      if (subgraph.nodes[0].hierarchy === null) {
        const rng = newRand(randomSeed);
        placeNodesOrthogonally(ctx, root, subgraph, edgeAbductions, rng, ancestorObstacles, randomSeed);
        for (const n of subgraph.nodes) {
          if (n.isClusterVessel()) optimizeCluster(ctx, subgraph.clusters.get(n), true);
        }
      }

      trees.place(ctx, subgraph, root);
      // Tree nodes and edges have been restored within subgraph but we need to also add these back to g
      for (const n of subgraph.nodes) {
        for (const treeRoot of g.trees.get(n) ?? []) {
          for (const tree of trees.descendants(treeRoot).concat([treeRoot])) {
            g.addNodeUnchecked(tree.node);
            g.addEdge(tree.sentinelEdge);
          }
        }
      }
      // reconnectTree restores the node to subgraph.Containers[root] but if the slice grows from an append,
      // subgraph.Containers[root] will be a different slice than g.Containers[root] so we need to sync the entry in g.Containers
      g.containers.set(root, subgraph.containers.get(root));
      for (const otherSubgraph of subgraphs) otherSubgraph.containers.set(root, subgraph.containers.get(root));

      // To determine within mirroring which container contents are reachable and should be recursively mirrored, the edges need
      // to be temporarily restored
      subgraph.restoreEdgeAbductions(edgeAbductions);
      try {
        direct(ctx, subgraph, subgraph.nodes, root, {});
      } catch (e) {
        // directErr: Go applies the abductions again and returns the error (a panic skips the re-application)
        if (e instanceof GoError) subgraph.applyEdgeAbductions(edgeAbductions);
        throw e;
      }
      subgraph.applyEdgeAbductions(edgeAbductions);

      validatePlacedNodes(root, subgraph.nodes);
    }
    const combined = packing.combineSubgraphs(ctx, g, subgraphs, ancestorObstacles);

    orientSourceInterior(ctx, combined, root, ancestorObstacles);
    // Set the dimensions of the root according to outcome of node placement
    if (root !== null) {
      root.fitToGraph(combined, g.containerPadding(root, false));
      // The root may be a cluster node, in which case all the other cluster nodes have to also be resized
      for (const c of g.clusters.values()) {
        const is = c.nodes.includes(root);
        if (is) c.resize(c.vessel);
      }
    }

    g.restoreEdgeAbductions(edgeAbductions);
    lg.Nodes.setGraphReference(g.nodes, g);
    abductionsRestored = true;
    splitCommitted = true;
  } finally {
    for (let i = defers.length - 1; i >= 0; i--) defers[i]();
  }
}

/**
 * This routine is heavily based on the algorithm proposed in Graph Compact Orthogonal Layout Algorithm by Freivalds and
 * Glagolevs. `seed` is optional (a BigInt).
 */
export function placeNodesOrthogonally(ctx, root, subgraph, edgeAbductions, randGenerator, obstacles, seed) {
  const fixed = subgraph.fixedNodes();
  let initialized = false;
  if (seed !== undefined && seed % 2n === 0n) initialized = initializeByGraphDistance(ctx, subgraph);
  if (!initialized) initializeNodes(ctx, subgraph);
  // After nodes in this nesting level have been initialized, the inner cluster nodes and container children need to also move
  subgraph.syncNestedGeometry();

  const numIterations = Math.trunc(nodePlacementIterations * Math.sqrt(subgraph.nodes.length));
  let temp = 2 * Math.sqrt(subgraph.nodes.length);
  const coolingFactor = goPowPos(0.2 / temp, 1.0 / numIterations);

  // run compaction every 9 iterations alternating between horizontal and vertical compaction
  const compactionIteration = 9;
  let compactionAxis = horizontalAxis;

  const sizeless = newSizelessOptimizer(ctx, subgraph, randGenerator);
  for (let i = 0; i < Math.trunc(numIterations / 2); i++) {
    const cerr = ctx.err();
    if (cerr) throw errorf(`PlaceNodes: ${cerr.message}`, cerr);
    sizeless.optimize(ctx, temp);

    if ((i % compactionIteration) === 0) {
      compaction(ctx, subgraph, { axis: compactionAxis, factor: compactionFactor });
      compactionAxis = axisOpposite(compactionAxis);
      sizeless.resetOccupied();
    }
    temp = temp * coolingFactor;
  }

  compaction(ctx, subgraph, { edgeAbductions, axis: horizontalAxis, includeSizes: true, factor: compactionFactor, transition: true });
  compaction(ctx, subgraph, { edgeAbductions, axis: verticalAxis, includeSizes: true, factor: compactionFactor, transition: true });

  // if there are fixed nodes, we want to shift them to their fixed top left positions
  if (fixed.length > 0) {
    const dx = fixed[0].fixedTopLeft.x - fixed[0].topLeft.x;
    const dy = fixed[0].fixedTopLeft.y - fixed[0].topLeft.y;
    for (const n of subgraph.nodes) n.moveWithChildren(dx, dy);
    for (const n of fixed) {
      // adjust precisely ignoring cell size alignment
      n.moveAbsWithChildren(n.fixedTopLeft.x, n.fixedTopLeft.y);
    }
  }

  validateCellSize(subgraph);
  for (const n of subgraph.nodes) {
    if (n.fixedTopLeft !== null) continue;

    let x = n.topLeft.x;
    let y = n.topLeft.y;
    if (n.topLeft.x % subgraph.cellSize !== 0) x = roundToPreviousCellSize(n.topLeft.x, subgraph.cellSize);
    if (n.topLeft.y % subgraph.cellSize !== 0) y = roundToPreviousCellSize(n.topLeft.y, subgraph.cellSize);
    if (x !== n.topLeft.x || y !== n.topLeft.y) n.moveAbsWithChildren(x, y);
  }

  validateGridAlignment(subgraph);

  // The turn cost is cached for edge length estimates, and we compute here
  subgraph.turnCost();
  // Since the compaction factor is rather high, we estimate the overall maxLength would actually be ~half it
  subgraph.halveTurnCost();

  const sized = newSizedOptimizer(ctx, subgraph, root, edgeAbductions, randGenerator, obstacles);

  proximity.syncHerdFences(subgraph);
  for (let i = Math.trunc(numIterations / 2) + 1; i < numIterations; i++) {
    const cerr = ctx.err();
    if (cerr) throw errorf(`PlaceNodes: ${cerr.message}`, cerr);
    sized.optimize(ctx, temp);

    if ((i % compactionIteration) === 0) {
      const factor = Math.max(1.0, 1.0 + (2.0 * (numIterations - i - 30) / (0.5 * numIterations)));
      compaction(ctx, subgraph, { edgeAbductions, axis: compactionAxis, includeSizes: true, factor });
      compactionAxis = axisOpposite(compactionAxis);

      grouping.joinDistancedClusters(ctx, subgraph);
      proximity.syncHerdFences(subgraph);
    }
    temp = temp * coolingFactor;
  }
  grouping.joinDistancedClusters(ctx, subgraph);
  proximity.syncHerdFences(subgraph);

  for (let i = 0; i < 10; i++) {
    const changed = sized.optimize(ctx, 0.0);
    if (!changed) break;
  }

  if (fixed.length > 0) {
    const dx = fixed[0].fixedTopLeft.x - fixed[0].topLeft.x;
    const dy = fixed[0].fixedTopLeft.y - fixed[0].topLeft.y;
    for (const n of subgraph.nodes) n.moveWithChildren(dx, dy);
    for (const n of fixed) {
      // adjust precisely ignoring cell size alignment
      n.topLeft = n.fixedTopLeft.copy();
    }
  }
}

export function validatePlacedNodes(root, nodes) {
  for (const node of nodes) {
    if (node.topLeft === null) {
      throw invariant.errorf(`node ${node.id} was not placed under container ${root === null ? 0n : root.idValue()}`);
    }
  }
}

export function validateGridAlignment(g) {
  validateCellSize(g);
  for (const node of g.nodes) {
    if (node.fixedTopLeft !== null) continue;
    if (node.topLeft === null) throw invariant.errorf(`node ${node.id} has no position`);
    if (node.topLeft.x % g.cellSize !== 0 || node.topLeft.y % g.cellSize !== 0) {
      throw invariant.errorf(`node ${node.id} at (${node.topLeft.x}, ${node.topLeft.y}) is not aligned to cell size ${g.cellSize}`);
    }
  }
}

export function validateCellSize(g) {
  if (g.cellSize < 1 || Number.isNaN(g.cellSize) || !Number.isFinite(g.cellSize) || Math.trunc(g.cellSize) !== g.cellSize) {
    throw invariant.errorf(`invalid cell size ${g.cellSize}`);
  }
}

export function placeChildrenOrder(ctx, nodes, edgeAbductions) {
  const ctxErr = () => {
    const err = ctx.err();
    if (err) throw errorf(`PlaceChildrenOrder: ${err.message}`, err);
  };
  ctxErr();
  const expected = new Set();
  const connected = new Map();
  for (const node of nodes) {
    ctxErr();
    if (node === null) throw invariant.newError('container has a nil child');
    if (expected.has(node)) throw invariant.errorf(`container has duplicate child ${node.debugID()}`);
    expected.add(node);
    connected.set(node, new Set());
  }
  for (const edgeAbduction of edgeAbductions) {
    ctxErr();
    if (edgeAbduction === null) throw invariant.newError('child ordering has a nil edge abduction');
    const from = edgeAbduction.currentFrom;
    const to = edgeAbduction.currentTo;
    if (expected.has(from)) {
      if (expected.has(to)) connected.get(from).add(to);
    }
    if (expected.has(to)) {
      if (expected.has(from)) connected.get(to).add(from);
    }
  }

  const ordered = [];
  const orderedSet = new Set();
  const appendNode = (node) => {
    ordered.push(node);
    orderedSet.add(node);
    connected.delete(node);
  };
  for (const node of nodes) {
    ctxErr();
    const adj = connected.get(node);
    if (adj === undefined || adj.size === 0) appendNode(node);
  }

  while (ordered.length < nodes.length) {
    ctxErr();
    let leastDegree = nodes.length + 1;
    let start = null;
    for (const node of nodes) {
      const adjacent = connected.get(node);
      if (adjacent !== undefined && adjacent.size < leastDegree) {
        leastDegree = adjacent.size;
        start = node;
      }
    }
    if (start === null) throw invariant.newError('could not order all container children');

    const visited = new Set();
    const queue = [start];
    while (queue.length > 0) {
      ctxErr();
      const current = queue.shift();
      if (visited.has(current)) continue;
      visited.add(current);
      if (orderedSet.has(current)) continue;
      appendNode(current);
      for (const edgeAbduction of edgeAbductions) {
        let adjacent = null;
        if (edgeAbduction.currentFrom === current) adjacent = edgeAbduction.currentTo;
        else if (edgeAbduction.currentTo === current) adjacent = edgeAbduction.currentFrom;
        if (expected.has(adjacent)) queue.push(adjacent);
      }
    }
  }
  ctxErr();
  return ordered;
}
