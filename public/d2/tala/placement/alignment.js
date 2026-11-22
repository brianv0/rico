// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of the Go package d2layouts/d2talalayout/internal/placement (D2 v0.9.0, github.com/d2lang/d2, Copyright 2022
// Terrastruct Inc.): alignment.go.

import * as geo from '../../geo.js';
import { goRound } from '../../gomath.js';
import * as lg from '../layoutgraph.js';
import * as placementcost from '../placementcost.js';
import { commitErr, intersectsOtherNode, withinMaxSize } from './types.js';

const { Orientation } = geo;

const pc = (a, b) => geo.precisionCompare(a, b, geo.PRECISION);

/**
 * alignAxes tries to align connected nodes that currently differ on both axes. Below, a and b can be lined up. If b has more
 * connections, consider its subgraph.
 */
export function alignAxes(ctx, g, txn) {
  const cerr = ctx.err();
  if (cerr) throw cerr;
  let changed = false;

  const fixedNodes = g.fixedNodes();

  // Note: the edge from rootSentinel to tree root is not excluded here since if the root moves, all connected nodes are moved so
  // it should move the whole tree with it which would be okay
  const isTreeEdge = g.treeEdgeMap();
  g.addIsolatedTreeEdges(isTreeEdge);
  // Tree nodes may be connected nodes when they are containers, so exclude them from the connected-node search.
  const excluded = [];
  for (const n of g.nodes) {
    if (g.nodeToTree !== null && g.nodeToTree.has(n)) excluded.push(n);
  }
  excluded.push(...fixedNodes);
  excluded.push(null); // last node is replaced with e.To/e.From below

  let edgeAbductions = null; // a nil slice until a sequence contributes abductions
  for (const seq of g.sequences.values()) {
    if (seq.edgeAbductions.length > 0) edgeAbductions = (edgeAbductions ?? []).concat(seq.edgeAbductions);
  }

  // need to compute it here because as we align a single edge, it may end up aligning other edges and it would affect the actual
  // count on the fly
  let hasTableColumns = false;
  const pcOpts = { edgeAbductions, includeNodeSizes: true, enforceMinimumGap: false, penalizeDirection: true };
  const initialLength = placementcost.edgeLength(ctx, g, pcOpts);
  let nInitialAlignedTableColumns = 0;
  for (const e of g.edges) {
    if (e.hasTableColumn()) {
      hasTableColumns = true;
      if (e.isAxisAligned()) nInitialAlignedTableColumns++;
    }
  }

  for (const e of g.edges) {
    if (isTreeEdge.has(e)) continue;
    if (e.isAxisAligned()) continue;
    if (e.from.hierarchy !== null || e.to.hierarchy !== null) continue;
    txn.clear();
    txn.updateState();

    const [xDiff, yDiff] = alignmentDeltas(e, g);

    let dxBest = 0;
    let dyBest = 0;
    let bestNodes = null;
    let bestEdgeLength = placementcost.edgeLength(ctx, g, pcOpts);
    const containerAlignment = placementcost.containerAlignmentCost(ctx, g);
    bestEdgeLength += containerAlignment;
    // Try to move e.From
    {
      excluded[excluded.length - 1] = e.to;
      const connectedNodes = e.from.connectedNodeSet(excluded, g);
      const [edgeLength, dx, dy] = tryMove(ctx, txn, g, e, connectedNodes, edgeAbductions, xDiff, yDiff);
      if (pc(edgeLength, bestEdgeLength) < 0) {
        bestEdgeLength = edgeLength;
        dxBest = dx;
        dyBest = dy;
        bestNodes = connectedNodes;
      } else if (e.hasTableColumn() && pc(edgeLength, bestEdgeLength) === 0) {
        // aligning ports in tables might be a sort of micromovement that doesn't change that much and it results in the new
        // length being equal to the old one at our precision level, but still, the aligned ports look better
        bestEdgeLength = edgeLength;
        dxBest = dx;
        dyBest = dy;
        bestNodes = connectedNodes;
      }
    }

    // Try to move e.To
    {
      excluded[excluded.length - 1] = e.from;
      const connectedNodes = e.to.connectedNodeSet(excluded, g);
      const [edgeLength, dx, dy] = tryMove(ctx, txn, g, e, connectedNodes, edgeAbductions, -xDiff, -yDiff);
      if (pc(edgeLength, bestEdgeLength) < 0) {
        dxBest = dx;
        dyBest = dy;
        bestNodes = connectedNodes;
      } else if (e.hasTableColumn() && pc(edgeLength, bestEdgeLength) === 0) {
        dxBest = dx;
        dyBest = dy;
        bestNodes = connectedNodes;
      }
    }

    if (bestNodes !== null && bestNodes.length > 0) {
      txn.addOp(() => {
        changed = true;
        for (const n of bestNodes) n.translate(dxBest, dyBest);
        return null;
      });
      txn.commit(ctx);
    }
  }

  if (hasTableColumns && changed) {
    // column alignment can cause small changes in edge length that that "stay the same" at our precision comparison. To handle it
    // properly, we also count the number of aligned edges
    let nAlignedTableColumns = 0;
    for (const e of g.edges) {
      if (e.hasTableColumn() && e.isAxisAligned()) nAlignedTableColumns++;
    }
    // Without more aligned columns, accept only a strict edge-length improvement.
    if (nAlignedTableColumns <= nInitialAlignedTableColumns) {
      let edgeLength = placementcost.edgeLength(ctx, g, pcOpts);
      const containerAlignment2 = placementcost.containerAlignmentCost(ctx, g);
      edgeLength += containerAlignment2;
      changed = pc(edgeLength, initialLength) === -1;
    }
  }

  return changed;
}

/**
 * alignmentDeltas computes the X and Y deltas required to center-align the connected nodes. Exceptions: for edges between table
 * columns, return the delta to align the columns; for sequences, return the delta to align with the sequence step.
 */
export function alignmentDeltas(e, g) {
  if (e.hasTableColumn()) {
    const [fromPort, toPort, hasFromPort, hasToPort] = e.facingTablePortValues(null, null);
    if (hasFromPort && hasToPort) {
      return [0, toPort.y - fromPort.y];
    } else if (hasFromPort) {
      return [0, (e.to.topLeft.y + e.to.height / 2) - fromPort.y];
    } else if (hasToPort) {
      return [0, toPort.y - (e.from.topLeft.y + e.from.height / 2)];
    }
    // Align tables to the left to avoid issues like the one in the Go comment that can happen if we center align the tables
    return [e.to.topLeft.x - e.from.topLeft.x, 0];
  }
  let from = e.from;
  const fromSeq = g.sequences.get(from);
  if (fromSeq !== undefined) from = fromSeq.abductedNodeByEdge(e);
  let to = e.to;
  const toSeq = g.sequences.get(to);
  if (toSeq !== undefined) to = toSeq.abductedNodeByEdge(e);

  let yDiff = goRound((to.topLeft.y + to.height / 2) - (from.topLeft.y + from.height / 2));
  let xDiff = goRound((to.topLeft.x + to.width / 2) - (from.topLeft.x + from.width / 2));

  if (geo.isHorizontal(e.from.orientation(e.to))) {
    xDiff = 0;
  } else if (geo.isVertical(e.from.orientation(e.to))) {
    yDiff = 0;
  } else {
    const [xDiff2, yDiff2] = e.from.orthogonalDistanceTo(e.to);
    if (xDiff2 < lg.ConnectedNodeGap) yDiff = 0;
    if (yDiff2 < lg.ConnectedNodeGap) xDiff = 0;
  }
  return [xDiff, yDiff];
}

/** returns [bestLen, dx, dy] */
export function tryMove(ctx, txn, g, e, connectedNodes, edgeAbductions, xDiff, yDiff) {
  let bestEdgeLength = Infinity;
  let bestAttempt = new geo.Point(0, 0);
  const attempts = [];

  if (pc(yDiff, 0.0) !== 0) {
    // e.From tries to slide up or down to e.To
    attempts.push(geo.newPoint(0, yDiff));
  }

  if (pc(xDiff, 0.0) !== 0) {
    // e.From tries to slide left or right to e.To
    attempts.push(geo.newPoint(xDiff, 0));
  }

  for (const attempt of attempts) {
    txn.addOp(() => {
      if (!attemptShift(g, e, connectedNodes, attempt.x, attempt.y)) throw lg.ErrInvalidCandidate;
      return null;
    });

    const err = commitErr(txn, ctx);
    if (err === null) {
      let edgeLength;
      try {
        edgeLength = placementcost.edgeLength(ctx, g, { edgeAbductions, includeNodeSizes: true, enforceMinimumGap: false, penalizeDirection: true });
        const containerAlignment = placementcost.containerAlignmentCost(ctx, g);
        edgeLength += containerAlignment;
      } catch (scoreErr) {
        txn.rollback();
        txn.clear();
        throw scoreErr;
      }
      if (pc(edgeLength, bestEdgeLength) < 1) {
        bestEdgeLength = edgeLength;
        bestAttempt = attempt.copy();
      }
    } else if (!lg.isCandidateRejection(err)) {
      throw err;
    }
    txn.clear();
    txn.rollback();
  }

  return [bestEdgeLength, bestAttempt.x, bestAttempt.y];
}

/** Returns true if no obvious problems with the shift */
export function attemptShift(g, aligningEdge, nodes, x, y) {
  for (const n of nodes) n.translate(x, y);

  if (!withinMaxSize(g)) return false;

  // Shifting is only good if it results in a direct line. It'd be undesirable if, after shifting, there are nodes in between
  // obscuring the alignment. This includes any connected nodes. Note that this function already excludes ancestor containers by
  // default.
  if (intersectsOtherNode(g, aligningEdge.from, aligningEdge.to)) return false;

  return true;
}
