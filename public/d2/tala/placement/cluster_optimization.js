// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of the Go package d2layouts/d2talalayout/internal/placement (D2 v0.9.0, github.com/d2lang/d2, Copyright 2022
// Terrastruct Inc.): cluster_optimization.go.

import * as geo from '../../geo.js';
import { goRound } from '../../gomath.js';
import { errorf } from '../goerrors.js';
import * as grouping from '../grouping.js';
import * as lg from '../layoutgraph.js';
import * as placementcost from '../placementcost.js';
import { reduceGapToNeighbors } from './gapreduction.js';
import { axisForArrangement, clusterExternalConnectedNodes, commitErr, forwardDirection } from './types.js';

const { Orientation } = geo;

/** optimizeClustersRollback */
export class OptimizeClustersRollback {
  constructor(graph, cellSize) {
    this.graph = graph;
    this.graphState = null;
    this.desiredArrangement = { cluster: null, arrangement: '', set: false };
    this.cellSize = cellSize;
    this.costs = null;
  }

  recordDesiredArrangement(cluster, arrangement) {
    const rollback = this;
    // The first transaction snapshot contains every later cluster's entry value. Only a change made before that snapshot
    // exists needs a separate journal.
    if (rollback.graphState !== null || rollback.desiredArrangement.set || cluster.desiredArrangement === arrangement) return;
    rollback.desiredArrangement = { cluster, arrangement: cluster.desiredArrangement, set: true };
  }

  recordGraphState(txn) {
    if (this.graphState !== null) return false;
    this.graphState = txn.priorGraphState;
    return true;
  }

  capturePlacementCosts(guard) {
    const rollback = this;
    if (rollback.costs !== null) return;
    const cacheEntries = rollback.graph.edgeLengthCacheEntries();
    if (cacheEntries > lg.MaxTopologyReferences) {
      throw errorf(`TALA OptimizeClustersTransactions edge-length cache entries exceed limit ${lg.MaxTopologyReferences}`);
    }
    for (let i = 0; i < cacheEntries; i++) guard.step();
    const costs = rollback.graph.snapshotPlacementCosts();
    guard.finish();
    rollback.costs = costs;
  }

  restore() {
    const rollback = this;
    if (rollback.graphState !== null) lg.restoreGraphState(rollback.graph, rollback.graphState);
    if (rollback.desiredArrangement.set) rollback.desiredArrangement.cluster.desiredArrangement = rollback.desiredArrangement.arrangement;
    rollback.graph.cellSize = rollback.cellSize;
    if (rollback.costs !== null) rollback.costs.restore();
  }
}

export function alignConnectedNodes(c, horizontally) {
  const externalNodes = clusterExternalConnectedNodes(c);
  if (externalNodes.length === 0) return;

  // align every node center with cluster center
  for (const n of externalNodes) {
    if (n.fixedTopLeft !== null) continue;
    // Don't want it to travel too far, risk of messing up other things
    if (!n.overlapsAlongDimension(c.vessel, !horizontally, true)) continue;
    let xDelta = 0.0;
    let yDelta = 0.0;
    if (horizontally) xDelta = goRound(c.vessel.topLeft.x + c.vessel.width / 2 - n.topLeft.x - n.width / 2);
    else yDelta = goRound(c.vessel.topLeft.y + c.vessel.height / 2 - n.topLeft.y - n.height / 2);
    n.moveWithChildren(xDelta, yDelta);
  }
}

export function alignVessel(c, horizontally) {
  const externalNodes = clusterExternalConnectedNodes(c);
  if (externalNodes.length === 0) return;

  let avgExternalX = 0.0;
  let avgExternalY = 0.0;
  for (const n of externalNodes) {
    avgExternalX += n.center().x;
    avgExternalY += n.center().y;
  }
  avgExternalX /= externalNodes.length;
  avgExternalY /= externalNodes.length;

  let xDelta = 0.0;
  let yDelta = 0.0;
  // align cluster center with avg external node center
  if (horizontally) xDelta = avgExternalX - c.vessel.width / 2 - c.vessel.topLeft.x;
  else yDelta = avgExternalY - c.vessel.height / 2 - c.vessel.topLeft.y;

  c.vessel.topLeft.x += goRound(xDelta);
  c.vessel.topLeft.y += goRound(yDelta);
}

/**
 * A cluster is considered optimized when its orientation is perpendicular to its edges and it's aligned symmetrically to its
 * connected nodes. If we cannot rotate to the right orientation, then give up (wrongly oriented + symmetrical looks worse than
 * nonsymmetrical). If we are able to rotate to the right orientation (or we already are), then try to align. If it's diagonal,
 * use the one that matches the aspect ratio.
 */
export function optimizeCluster(ctx, c, onlyFlip) {
  return optimizeClusterWithRollback(ctx, c, onlyFlip, null);
}

const pcOpts = { edgeAbductions: null, includeNodeSizes: true, enforceMinimumGap: false, penalizeDirection: true };

export function optimizeClusterWithRollback(ctx, c, onlyFlip, rollback) {
  let guard;
  [ctx, guard] = lg.ensureTransactionWorkGuard(ctx, 'OptimizeClusterTransactions');
  let horizontalCount = 0;
  let verticalCount = 0;
  let changed = false;
  for (const externalNode of clusterExternalConnectedNodes(c)) {
    const orientation = c.vessel.orientation(externalNode);
    if (orientation === Orientation.NONE) continue;

    switch (orientation) {
      case Orientation.Left:
      case Orientation.Right:
        horizontalCount++;
        break;
      case Orientation.Top:
      case Orientation.Bottom:
        verticalCount++;
        break;
      default: {
        // Diagonal
        const xDistance = Math.abs(externalNode.center().x - c.vessel.center().x);
        const yDistance = Math.abs(externalNode.center().y - c.vessel.center().y);
        if (xDistance > yDistance) horizontalCount++;
        else if (yDistance > xDistance) verticalCount++;
      }
    }
  }

  let desiredArrangement = c.desiredArrangement;
  if (verticalCount > horizontalCount) desiredArrangement = lg.Row;
  else if (horizontalCount > verticalCount) desiredArrangement = lg.Column;
  if (rollback !== null) rollback.recordDesiredArrangement(c, desiredArrangement);
  c.desiredArrangement = desiredArrangement;

  let txn = null;
  let ownsRollbackState = false;
  if (c.arrangement !== desiredArrangement) {
    txn = c.graph.newRequestTransaction(ctx, { affectContainers: true });
    if (rollback !== null) ownsRollbackState = rollback.recordGraphState(txn);
    // first try flipping around center, if that fails try flipping around top left
    let tryCenter = true;
    const flipTxn = txn;
    txn.addOp(() => {
      switch (c.arrangement) {
        case lg.Column:
          c.arrangement = lg.Row;
          break;
        case lg.Row:
          c.arrangement = lg.Column;
          break;
      }
      c.padding = grouping.paddingBetween(c, true);
      c.syncGeometry();

      if (tryCenter) {
        // sync from column to row (top left is fixed), then centering
        switch (c.arrangement) {
          case lg.Column: {
            const [, originalHeight] = flipTxn.originalDimensions(c.vessel);
            const heightDelta = originalHeight - c.vessel.height;
            c.vessel.moveWithChildren(0, goRound(heightDelta / 2));
            break;
          }
          case lg.Row: {
            const [originalWidth] = flipTxn.originalDimensions(c.vessel);
            const widthDelta = originalWidth - c.vessel.width;
            c.vessel.moveWithChildren(goRound(widthDelta / 2), 0);
            break;
          }
        }
      }

      if (c.container !== null && c.container.topLeft !== null) {
        const children = c.graph.containers.get(c.container) ?? [];
        const [childrenTL, childrenBR] = lg.Nodes.fixedBoundingBox(children);
        const padding = c.graph.containerPadding(c.container, false);
        c.container.fitToBoundingBox(childrenTL, childrenBR, padding);
        c.container.positionContainerChildren(true);
      }
      return null;
    });
    let err = commitErr(txn, ctx);
    if (err !== null) {
      if (!lg.isCandidateRejection(err)) throw err;
      tryCenter = false;
      err = commitErr(txn, ctx);
      if (err !== null) {
        if (!lg.isCandidateRejection(err)) throw err;
        return changed;
      }
    }
    txn.updateState();
    txn.clear();
    changed = true;
  }

  if (!onlyFlip && c.arrangement === desiredArrangement) {
    // There's two ways alignment can happen, vessel moves or external nodes move. First try vessel move
    if (txn === null) {
      txn = c.graph.newRequestTransaction(ctx, { affectContainers: true });
      if (rollback !== null) ownsRollbackState = rollback.recordGraphState(txn);
    }
    if (rollback !== null) rollback.capturePlacementCosts(guard);
    let bestLength = placementcost.edgeLength(ctx, c.graph, pcOpts);
    let moveVessel = false;
    let moveNodes = false;

    txn.addOp(() => {
      switch (c.arrangement) {
        case lg.Column:
          alignVessel(c, false);
          break;
        case lg.Row:
          alignVessel(c, true);
          break;
      }
      return null;
    });
    let err = commitErr(txn, ctx);
    if (err === null) {
      let length;
      try {
        length = placementcost.edgeLength(ctx, c.graph, pcOpts);
      } catch (scoreErr) {
        txn.rollback();
        txn.clear();
        throw scoreErr;
      }
      if (geo.precisionCompare(length, bestLength, geo.PRECISION) < 0) {
        bestLength = length;
        moveVessel = true;
      }
    } else if (!lg.isCandidateRejection(err)) {
      throw err;
    }
    txn.rollback();
    txn.clear();

    txn.addOp(() => {
      switch (c.arrangement) {
        case lg.Column:
          alignConnectedNodes(c, false);
          break;
        case lg.Row:
          alignConnectedNodes(c, true);
          break;
      }
      return null;
    });
    err = commitErr(txn, ctx);
    if (err === null) {
      let length;
      try {
        length = placementcost.edgeLength(ctx, c.graph, pcOpts);
      } catch (scoreErr) {
        txn.rollback();
        txn.clear();
        throw scoreErr;
      }
      if (geo.precisionCompare(length, bestLength, geo.PRECISION) < 0) moveNodes = true;
    } else if (!lg.isCandidateRejection(err)) {
      throw err;
    }

    txn.rollback();
    txn.clear();

    if (moveNodes) {
      txn.addOp(() => {
        switch (c.arrangement) {
          case lg.Column:
            alignConnectedNodes(c, false);
            break;
          case lg.Row:
            alignConnectedNodes(c, true);
            break;
        }
        return null;
      });
      txn.commit(ctx);
      changed = true;
    } else if (moveVessel) {
      txn.addOp(() => {
        switch (c.arrangement) {
          case lg.Column:
            alignVessel(c, false);
            break;
          case lg.Row:
            alignVessel(c, true);
            break;
        }
        return null;
      });
      txn.commit(ctx);
      changed = true;
    }

    if (moveNodes || moveVessel) {
      // after flipping we may need to pull connected nodes closer
      txn.clear();
      if (ownsRollbackState) {
        // The first transaction's original graph state is the stage rollback point. Detach before a second refresh could
        // recycle that state as transaction scratch.
        txn = txn.cloneGeometryContext();
      }
      txn.updateState();
      txn.addOp(() => {
        reduceGapToNeighbors(ctx, c.vessel, null, {
          axis: axisForArrangement(c.arrangement),
          direction: forwardDirection,
          attemptRecoverSymmetry: true,
        });
        return null;
      });
      err = commitErr(txn, ctx);
      if (err !== null && !lg.isCandidateRejection(err)) throw err;
    }
  }

  return changed;
}

/** make clusters horizontal if cluster connections are above or below cluster */
export function optimizeClusters(ctx, g) {
  ctx = lg.ensureTransactionWorkGuard(ctx, 'OptimizeClustersTransactions')[0];
  const order = g.clusterRDFSOrder();
  if (order.length === 0) return false;
  return optimizeClustersAtomic(ctx, g, order);
}

export function optimizeClustersAtomic(ctx, g, order) {
  const rollback = new OptimizeClustersRollback(g, g.cellSize);
  let complete = false;
  try {
    let changed = false;
    for (const vessel of order) {
      const cluster = g.clusters.get(vessel);
      const changed2 = optimizeClusterWithRollback(ctx, cluster, false, rollback);
      if (changed2) changed = true;
    }
    complete = true;
    return changed;
  } finally {
    if (!complete) rollback.restore();
  }
}
