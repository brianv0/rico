// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of the Go package d2layouts/d2talalayout/internal/placement (D2 v0.9.0, github.com/d2lang/d2, Copyright 2022
// Terrastruct Inc.): container_orientation.go.

import * as geo from '../../geo.js';
import { goRound } from '../../gomath.js';
import { withValue } from '../context.js';
import * as grouping from '../grouping.js';
import * as lg from '../layoutgraph.js';
import * as limits from '../limits.js';
import { compaction } from './compaction.js';
import { horizontalAxis, verticalAxis } from './types.js';

const containerOrientationDisabled = Symbol('containerOrientationDisabled');

/**
 * A container footprint can change the later placement of its siblings. Until those later operations validate self-loop
 * envelopes, leave loop-bearing layouts on their existing placement path. This scan happens once per attempt.
 */
export function orientationContext(ctx, g) {
  const guard = limits.newWorkGuard(ctx, 'ContainerOrientationPreflight', limits.MaxEngineWorkUnits);
  for (const e of g.edges) {
    guard.step();
    if (e.isLoop()) return withValue(ctx, containerOrientationDisabled, true);
  }
  guard.finish();
  return ctx;
}

/**
 * orientSourceInterior aligns the internal flow of a small source container with its surrounding flow, before the parent is
 * fitted around the result. The optional move is local: it does not add another complete layout attempt.
 */
export function orientSourceInterior(ctx, g, root, obstacles) {
  const cerr = ctx.err();
  if (cerr) throw cerr;
  if (ctx.value(containerOrientationDisabled) === true || root === null || g.nodes.length < 3 || g.nodes.length > 16 ||
      obstacles.length !== 0 || root.fixedTopLeft !== null || root.cluster !== null || root.sequence !== null ||
      root.forceHierarchy || root.graph.direction(root) !== geo.Orientation.NONE) {
    return;
  }
  const direction = g.direction(root.owningContainer());
  if (!geo.isVertical(direction) || root.edges.length < 3) return;
  const guard = limits.newWorkGuard(ctx, 'ContainerOrientation', limits.MaxEngineWorkUnits);
  const destinations = new Set();
  for (const e of root.edges) {
    guard.step();
    const [from, to, ok] = e.directedEndpoints();
    if (!ok || from !== root || to === root) return;
    destinations.add(to);
  }
  if (destinations.size < 2) return;
  const local = new Map();
  for (const n of g.nodes) {
    if (n.isContainer() || n.hierarchy !== null || n.fixedTopLeft !== null || n.sequence !== null || g.isTreeSentinel(n) ||
        g.isSequenceVessel(n) || n.herdAssignment !== null) {
      return;
    }
    // Self-loop envelopes do not turn with the boxes. Keep their established placement until orientation can preserve that
    // extra route clearance.
    if (n.loopOffsets !== null) {
      for (const offset of n.loopOffsets.values()) {
        if (offset > 0) return;
      }
    }
    local.set(n, true);
  }
  for (const n of g.nodes) {
    for (const near of n.nears) {
      if (!local.get(near)) return;
    }
  }
  const flow = interiorFlow(g, local, guard);
  // A quarter-turn needs a clear transverse flow to improve. Disconnected contents, balanced cycles and already vertical
  // compositions are left alone.
  if (flow.across <= flow.along + 1e-9 || Math.abs(flow.x) <= 1e-9) return;
  let turn = 1.0;
  if ((flow.x < 0) !== (direction === geo.Orientation.Top)) turn = -1;

  const [beforeWidth, beforeHeight] = orientationFootprintSize(g, root);
  const txn = g.newRequestTransaction(ctx, { ignoreContainerEscape: true });
  txn.addOp(() => {
    const centers = new Map();
    for (const n of g.nodes) centers.set(n, n.center());
    for (const n of g.nodes) {
      guard.step();
      const c = g.clusters.get(n);
      if (c) {
        c.arrangement = lg.flipArrangement(c.arrangement);
        c.desiredArrangement = c.arrangement;
        // Preserve the group's logical member order, but recalculate spacing for its new axis, including icon and
        // outside-label room.
        c.padding = grouping.paddingBetween(c, true);
        c.resize(n);
      }
      const p = centers.get(n);
      n.topLeft = geo.newPoint(goRound(-turn * p.y - n.width / 2), goRound(turn * p.x - n.height / 2));
    }
    g.syncNestedGeometry();
    const oldCell = g.cellSize;
    g.cellSize = 1;
    try {
      for (const axis of [horizontalAxis, verticalAxis]) {
        compaction(ctx, g, { axis, includeSizes: true, factor: 1, transition: true });
      }
      g.syncNestedGeometry();
      const [tl, br] = g.boundingBox();
      const [width, height] = orientationFootprintSize(g, root);
      if (br.x - tl.x > limits.MaxGraphSize || br.y - tl.y > limits.MaxGraphSize ||
          !(width >= 0 && height >= 0 && width <= limits.MaxGraphSize && height <= limits.MaxGraphSize)) {
        throw lg.ErrInvalidCandidate;
      }
      // Upright boxes can expand substantially during a quarter-turn. Allow at most one additional original footprint,
      // including the containing shape, label room, and authored minimum dimensions.
      const rejected = width * height > 2 * beforeWidth * beforeHeight;
      if (rejected) throw lg.ErrNonImprovingCandidate;
      const after = interiorFlow(g, local, guard);
      let sign = 1.0;
      if (direction === geo.Orientation.Top) sign = -1;
      if (sign * after.y <= sign * flow.y + 1e-9) throw lg.ErrNonImprovingCandidate;
      guard.finish();
      return null;
    } finally {
      g.cellSize = oldCell;
    }
  });
  // Commit validates node clearances and restores positions, dimensions and cluster metadata on rejection or error. Root
  // fitting happens after success.
  try {
    txn.commit(ctx);
  } catch (err) {
    if (lg.isCandidateRejection(err)) return;
    throw err;
  }
}

/**
 * interiorFlow gives each distinct directed adjacency one vote, normalized by its Manhattan length so a single long edge cannot
 * dominate the orientation. `local` is Map<Node, bool>.
 */
export function interiorFlow(g, local, guard) {
  const flow = { x: 0, y: 0, across: 0, along: 0 };
  const seen = new Map(); // [2]*Node key: from -> Set(to)
  for (const e of g.edges) {
    guard.step();
    const [from, to, ok] = e.directedEndpoints();
    if (!ok || from === to || !local.get(from) || !local.get(to)) continue;
    let tos = seen.get(from);
    if (tos === undefined) {
      tos = new Set();
      seen.set(from, tos);
    }
    if (tos.has(to)) continue;
    tos.add(to);
    const a = from.center();
    const b = to.center();
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.abs(dx) + Math.abs(dy);
    if (length === 0) continue;
    flow.x += dx / length;
    flow.across += Math.abs(dx) / length;
    flow.y += dy / length;
    flow.along += Math.abs(dy) / length;
  }
  guard.finish();
  return flow;
}

/**
 * Use the actual fitting path, including label room, shape geometry and authored minimum dimensions. Its only mutations are
 * Width/Height; restore both before returning so optional admission does not resize the parent early.
 */
export function orientationFitsContainer(g, root) {
  const [width, height] = orientationFootprintSize(g, root);
  return width >= 0 && height >= 0 && width <= limits.MaxGraphSize && height <= limits.MaxGraphSize;
}

/** Fitting mutates only the containing node's dimensions. Restore those values so observing the footprint never resizes the parent early. */
export function orientationFootprintSize(g, root) {
  const oldWidth = root.width;
  const oldHeight = root.height;
  try {
    root.fitToGraph(g, g.containerPadding(root, false));
    return [root.width, root.height];
  } finally {
    root.width = oldWidth;
    root.height = oldHeight;
  }
}
