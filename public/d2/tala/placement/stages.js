// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of the Go package d2layouts/d2talalayout/internal/placement (D2 v0.9.0, github.com/d2lang/d2, Copyright 2022
// Terrastruct Inc.): stages.go, the stage entry points of the pipeline (Prescale, Prepare, Place, NormalizeGaps, Align, Swap,
// TransposeAll, Normalize, Pad). The pipeline (engine.js) resolves them by name through stagepkgs.js.

import { goRound } from '../../gomath.js';
import * as invariant from '../invariant.js';
import * as labeling from '../labeling.js';
import * as lg from '../layoutgraph.js';
import * as loops from '../loops.js';
import * as placementcost from '../placementcost.js';
import * as proximity from '../proximity.js';
import { alignAxes } from './alignment.js';
import { direct } from './direct.js';
import { gapNormalization } from './gapreduction.js';
import { orientationContext } from './container_orientation.js';
import { placeNodes } from './node_placement.js';
import { swapOptimize } from './swap.js';
import { transpose } from './transpose.js';
import {
  backwardDirection, forwardDirection, horizontalAxis, placementPadding, verticalAxis,
} from './types.js';

export function prescale(graph) {
  for (const node of graph.nodes) {
    if (node.aspectRatio1()) {
      const size = Math.max(node.width, node.height);
      node.width = size;
      node.height = size;
    }
    scaleBasedOnEdges(node);
  }
}

export function scaleBasedOnEdges(node) {
  if (node.fixedTopLeft !== null || node.desiredWidth !== null || node.desiredHeight !== null || node.isTable() || node.isClass() || node.edges.length === 0) return;
  const edgeCounts = new Map();
  for (const edge of node.edges) {
    const adjacent = node.adjacent(edge);
    if (adjacent !== node) edgeCounts.set(adjacent, (edgeCounts.get(adjacent) ?? 0) + 1);
  }
  let totalEdges = 0;
  let maxEdgesToAdjacent = 0;
  for (const count of edgeCounts.values()) {
    totalEdges += count;
    maxEdgesToAdjacent = Math.max(maxEdgesToAdjacent, count);
  }
  let sidesForEdges = 4.0;
  if (edgeCounts.size < 4) sidesForEdges = edgeCounts.size;
  const edgesPerSide = Math.max(maxEdgesToAdjacent, Math.trunc(Math.ceil(totalEdges / sidesForEdges)));
  if (edgesPerSide === 1) return;
  let minLength = (edgesPerSide + 1) * placementcost.SideEdgeSpacing;
  if (minLength < Math.min(node.width, node.height)) return;
  let xRatio = 1.0;
  let yRatio = 1.0;
  if (node.aspectRatio1()) {
    if (node.width < minLength) {
      xRatio = minLength / node.width;
      yRatio = minLength / node.height;
      node.width = minLength;
      node.height = minLength;
    }
  } else {
    if (node.width < minLength) {
      xRatio = minLength / node.width;
      node.width = minLength;
    }
    if (node.height < minLength) {
      yRatio = minLength / node.height;
      node.height = minLength;
    }
  }
  if (node.fontSize === null) return;
  const minRatio = Math.min(xRatio, yRatio);
  let bestRatio = 1.0;
  let fontSize = node.fontSize;
  let closestDistance = Infinity;
  for (const size of talaFontSizes()) {
    const fontRatio = size / node.fontSize;
    const distance = Math.abs(fontRatio - minRatio);
    if (distance < closestDistance) {
      fontSize = size;
      closestDistance = distance;
      bestRatio = fontRatio;
    }
  }
  if (bestRatio > minRatio) {
    minLength = Math.ceil(minLength * bestRatio / minRatio);
    if (node.width < minLength) node.width = minLength;
    if (node.height < minLength) node.height = minLength;
  }
  node.fontSize = fontSize;
  if (node.label !== null) {
    node.label.width = Math.ceil(node.label.width * bestRatio);
    node.label.height = Math.ceil(node.label.height * bestRatio);
  }
}

/** talaFontSizes returns the adapter-supported layout font scale by value so callers cannot mutate shared engine state. */
export function talaFontSizes() {
  return [13, 14, 16, 20, 24, 28, 32];
}

export function prepare(graph) {
  loops.computeOffsets(graph);
  labeling.initialize(graph);
  graph.computeNodeSpacing();
}

/** normalizeGapsRollback */
class NormalizeGapsRollback {
  constructor(graph, txn, graphState, cellSize, routingCosts) {
    this.graph = graph;
    this.txn = txn;
    this.graphState = graphState;
    this.cellSize = cellSize;
    this.routingCosts = routingCosts;
  }

  restore() {
    lg.restoreGraphState(this.graph, this.graphState);
    this.graph.cellSize = this.cellSize;
    if (!this.txn.restorePlacementCosts()) this.graph.restoreRoutingCosts(this.routingCosts);
  }
}

/** Place is stage 7. `seed` is a BigInt. */
export function place(ctx, graph, seed) {
  if (graph === null) throw invariant.newError('Place requires a graph');
  const priorCommonUncleSiblings = graph.commonUncleSiblings;
  let ownership = null;
  let complete = false;
  try {
    graph.commonUncleSiblings = proximity.commonUncleSiblings(graph);
    ownership = lg.snapshotNodeGraphOwnership(ctx, graph);
    ctx = orientationContext(ctx, graph);
    placeNodes(ctx, graph, null, seed, null, null);
    const nodes = [];
    for (const node of graph.nodes) {
      nodes.push(node);
      nodes.push(...graph.allDescendantNodes(node, true));
    }
    for (const node of nodes) node.graph = graph;
    graph.computeCellSize();
    graph.resetTurnCost();
    complete = true;
  } finally {
    if (complete) {
      // Successful placement does not retain transient proximity hints.
      graph.commonUncleSiblings = null;
    } else {
      if (ownership !== null) ownership.restore();
      graph.commonUncleSiblings = priorCommonUncleSiblings;
    }
  }
}

export function normalizeGaps(ctx, graph) {
  let guard;
  [ctx, guard] = lg.ensureTransactionWorkGuard(ctx, 'GapNormalizationTransactions');
  const txn = graph.newRequestTransaction(ctx, { affectContainers: true });
  const rollback = new NormalizeGapsRollback(graph, txn, txn.preservePriorGraphState(), graph.cellSize, graph.routingCosts());
  let complete = false;
  try {
    const bidirectional = (nodes, axis) => {
      const forward = gapNormalization(ctx, nodes, txn, graph, { axis, direction: forwardDirection, costTxn: txn });
      const backward = gapNormalization(ctx, nodes, txn, graph, { axis, direction: backwardDirection, costTxn: txn });
      return forward || backward;
    };
    let changed = false;
    const containers = graph.containerRDFSOrder(null, guard);
    for (const container of containers) {
      const nodes = graph.allDescendantNodes(container, false);
      for (const axis of [horizontalAxis, verticalAxis]) {
        const current = bidirectional(nodes, axis);
        changed = changed || current;
      }
    }
    for (const axis of [horizontalAxis, verticalAxis]) {
      const current = bidirectional(graph.nodes, axis);
      changed = changed || current;
    }
    graph.resetTurnCost();
    graph.syncSequences();
    graph.syncClusters();
    guard.finish();
    complete = true;
    return changed;
  } finally {
    if (!complete) rollback.restore();
  }
}

export function align(ctx, graph) {
  ctx = lg.ensureTransactionWorkGuard(ctx, 'AlignAxesTransactions')[0];
  if (graph.cellSize === 0) graph.computeCellSize();
  const txn = graph.newRequestTransaction(ctx, { affectContainers: true });
  for (let i = 0; i < 100; i++) {
    const changed = alignAxes(ctx, graph, txn);
    if (!changed) break;
  }
}

export function swap(ctx, graph) {
  ctx = lg.ensureTransactionWorkGuard(ctx, 'SwapStuffTransactions')[0];
  graph.computeCellSize();
  for (let i = 0; i < 4; i++) {
    const changed = swapOptimize(ctx, graph.nodes, graph);
    if (!changed) break;
  }
  direct(ctx, graph, graph.nodes, null, { checkEdgeLength: true });
}

export function transposeAll(ctx, graph) {
  ctx = lg.ensureTransactionWorkGuard(ctx, 'TransposeStageTransactions')[0];
  graph.computeCellSize();
  for (const node of graph.nodes) transpose(ctx, graph, node, null);
}

export function normalize(graph) {
  let minX = Infinity;
  let minY = Infinity;
  if (graph.hasFixedNode()) {
    minX = placementPadding;
    minY = placementPadding;
  } else {
    for (const node of graph.nodes) {
      minX = Math.min(minX, node.topLeft.x);
      minY = Math.min(minY, node.topLeft.y);
    }
    for (const edge of graph.edges) {
      for (const point of edge.points) {
        minX = Math.min(minX, Math.floor(point.x));
        minY = Math.min(minY, Math.floor(point.y));
      }
      if (edge.label !== null) {
        const topLeft = edge.labelTopLeft(edge.label.position, edge.label.width, edge.label.height);
        minX = Math.min(minX, Math.floor(topLeft.x));
        minY = Math.min(minY, Math.floor(topLeft.y));
      }
    }
  }
  for (const node of graph.nodes) {
    node.topLeft.x -= minX;
    node.topLeft.y -= minY;
  }
  for (const edge of graph.edges) {
    for (const point of edge.points) {
      point.x -= minX;
      point.y -= minY;
    }
  }
}

export function pad(graph) {
  for (const node of graph.nodes) {
    node.topLeft.x += placementPadding;
    node.topLeft.y += placementPadding;
  }
}
