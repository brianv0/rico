// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of the Go package d2layouts/d2talalayout/internal/routing (D2 v0.9.0), file(s): nudge_channels.go (NudgeEdgeChannels).
//
// math.Hypot is Go's algorithm (placementcost.goHypot), not Math.hypot.

import * as geo from '../../geo.js';
import { errorsIs } from '../goerrors.js';
import * as quality from '../quality.js';
import { _internals as placementcostInternals } from '../placementcost.js';

const { goHypot } = placementcostInternals;
import { maxRouteStageWorkUnits } from './route_limits.js';
import { errRouteStageWorkLimit, stableSortRouteValues } from './route_stage_guard.js';
import { runAtomicRouteStage, captureRouteMutations } from './route_stage_atomic.js';
import { segmentSpacingBuffer } from './tuning.js';
import { Range } from './tunnel.js';
import { nodeSegmentsGuarded, edgeSegmentsGuarded, routeSegmentBounds, removeDuplicatePointsGuarded } from './balance_route_guard.js';
import { balanceCollinearOverlap } from './balance_crossings.js';
import { copyRoutePoints, changedRouteIsClear, hasFixedBalancingPorts } from './port_interior_balance.js';
import { isSpecialEdgeForBalancing } from './postprocess.js';
import { isNonSharedCrossing } from './cost.js';
import { copyOwn } from './snapshot.js';

export const channelEpsilon = 1e-6;

// This optional postpass admits only small channel systems. Quadratic discovery must not consume a successful layout's routing budget.
export const maxChannelSegments = 256;

export function nudgeEdgeChannels(ctx, g) {
  try {
    nudgeChannelsWithLimit(ctx, g, maxRouteStageWorkUnits);
  } catch (err) {
    if (errorsIs(err, errRouteStageWorkLimit)) return;
    throw err;
  }
}

/** channelGroup: { segments, position, lower, upper, fixed, nodeClearance (a Range or null) } */
class ChannelGroup {
  constructor() {
    this.segments = [];
    this.position = 0;
    this.lower = 0;
    this.upper = 0;
    this.fixed = false;
    this.nodeClearance = null;
  }
}

/** channelArc: { from, to, separate } (legs of a single route may meet to remove an unnecessary bend) */
const newChannelArc = (from, to, separate) => ({ from, to, separate });

/** channelProblem: { groups, arcs } */
const newChannelProblem = () => ({ groups: [], arcs: [] });

/**
 * nudgeChannelsGuarded uses WueOrtho's separation-constraint idea with fixed boxes and ports: https://arxiv.org/html/2309.01671v2#S2.SS0.SSS0.Px7.
 * This bounded special case solves gap feasibility on a DAG, not the paper's complete LP. It retains the existing drawing unless one of
 * its feasible extremal or midpoint solutions improves wire length or spacing.
 */
export function nudgeChannelsGuarded(g, guard) {
  for (const horizontal of [true, false]) {
    const problem = buildChannelProblem(g, horizontal, guard);
    if (problem.groups.length === 0) continue;
    const snapshot = captureRouteMutations(g, null, guard);
    const closed = channelInventoryIsClosed(g, snapshot, guard);
    if (!closed) return;
    const beforePoints = copyRoutePoints(g.edges, guard);
    const beforeMetrics = quality.inspect(guard.ctx, g);
    const changed = applyChannelProblem(g, problem, horizontal, guard);
    if (!changed) continue;
    const afterMetrics = quality.inspect(guard.ctx, g);
    if (afterMetrics.routeObstructions > beforeMetrics.routeObstructions ||
      afterMetrics.crossings > beforeMetrics.crossings || afterMetrics.textOcclusions > beforeMetrics.textOcclusions ||
      afterMetrics.routeLength > beforeMetrics.routeLength + channelEpsilon) {
      snapshot.restore();
      continue;
    }
    for (const edge of g.edges) {
      let moved = false;
      for (let i = 0; i < edge.points.length; i++) {
        const point = edge.points[i];
        const b = beforePoints.get(edge)[i];
        if (!(point.x === b.x && point.y === b.y)) {
          moved = true;
          break;
        }
      }
      if (!moved) continue;
      edge.points = removeDuplicatePointsGuarded(edge.points, guard);
    }
  }
}

/**
 * Route-stage snapshots can reach owners outside the graph's direct slices. Such owners are not obstacles in this bounded model, so do
 * not risk moving an uninspected route or node through an aliased point.
 */
export function channelInventoryIsClosed(g, snapshot, guard) {
  const nodes = new Set();
  const edges = new Set();
  for (const n of g.nodes) {
    guard.step();
    nodes.add(n);
  }
  for (const e of g.edges) {
    guard.step();
    edges.add(e);
  }
  for (const n of snapshot.nodes.keys()) {
    guard.step();
    if (!nodes.has(n)) return false;
  }
  for (const e of snapshot.edges.keys()) {
    guard.step();
    if (!edges.has(e)) return false;
  }
  return true;
}

export function nudgeChannelsWithLimit(ctx, g, limit) {
  if (ctx != null && g != null) {
    let err = ctx.err();
    if (err) throw err;
    if (channelInputTooLarge(g)) {
      // Admission scans at most maxChannelSegments edge references. Check cancellation again before returning without the atomic stage.
      err = ctx.err();
      if (err) throw err;
      return;
    }
  }
  runAtomicRouteStage(ctx, 'NudgeChannels', g, null, limit, (guard) => {
    nudgeChannelsGuarded(g, guard);
  });
}

/**
 * Oversized inputs are an optional no-op, so reject them before topology validation or rollback snapshots allocate proportional to the
 * whole graph. This is only admission, not validation: nil inputs and malformed admitted graphs still go through the existing
 * atomic-stage validation boundary.
 */
export function channelInputTooLarge(g) {
  if (g === null) return false;
  if (g.nodes.length > maxChannelSegments || g.edges.length > maxChannelSegments) return true;
  let remaining = maxChannelSegments;
  for (const edge of g.edges) {
    if (edge === null) continue;
    if (edge.points.length > remaining) return true;
    remaining -= edge.points.length;
  }
  return false;
}

export function channelCoordinate(p, horizontal) {
  if (horizontal) return p.x;
  return p.y;
}

export function buildChannelProblem(g, horizontal, guard) {
  const result = newChannelProblem();
  const segments = edgeSegmentsGuarded(g.edges, !horizontal, guard);
  const fixedPoints = new Set();
  for (const n of g.nodes) fixedPoints.add(n.topLeft);
  const lockedEdges = new Map();
  for (const e of g.edges) {
    guard.step();
    if (e.points.length < 2) continue;
    fixedPoints.add(e.points[0]);
    fixedPoints.add(e.points[e.points.length - 1]);
    const fromTree = g.nodeToTree !== null && g.nodeToTree.has(e.from);
    const toTree = g.nodeToTree !== null && g.nodeToTree.has(e.to);
    lockedEdges.set(e, e.isCurve || e.isLoop() || fromTree || toTree || (isSpecialEdgeForBalancing(g, e) && !hasFixedBalancingPorts(e)));
    for (let i = 1; i < e.points.length; i++) {
      guard.step();
      const a = e.points[i - 1], b = e.points[i];
      if ((a.x !== b.x && a.y !== b.y) || (a.x === b.x && a.y === b.y)) lockedEdges.set(e, true);
    }
  }
  const parent = new Array(segments.length);
  for (let i = 0; i < parent.length; i++) parent[i] = i;
  const root = (i) => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    for (let j = 0; j < i; j++) {
      guard.step();
      const other = segments[j];
      if (channelCoordinate(s.Start, horizontal) === channelCoordinate(other.Start, horizontal) &&
        s.overlaps(other, horizontal, segmentSpacingBuffer)) {
        parent[root(i)] = root(j);
      }
    }
  }
  const byRoot = new Map();
  const groups = [];
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    guard.step();
    let group = byRoot.get(root(i));
    if (group === undefined) {
      group = new ChannelGroup();
      group.position = channelCoordinate(s.Start, horizontal);
      byRoot.set(root(i), group);
      groups.push(group);
    }
    group.segments.push(s);
    group.fixed = group.fixed || lockedEdges.get(s.owner()) === true || fixedPoints.has(s.Start) || fixedPoints.has(s.End);
    for (const n of g.nodes) {
      guard.step();
      if (n.width !== 1 || n.height !== 1) continue;
      for (const p of [s.Start, s.End]) {
        if ((p.x === n.topLeft.x || p.x === n.topLeft.x + 1) && (p.y === n.topLeft.y || p.y === n.topLeft.y + 1)) group.fixed = true;
      }
    }
  }
  const fixed = nodeSegmentsGuarded(g.nodes, !horizontal, guard);
  const nodeWalls = fixed.slice();
  for (const group of groups) {
    if (group.fixed) continue;
    const clearance = new Range(-Infinity, Infinity);
    for (const segment of group.segments) {
      const [lower, upper] = routeSegmentBounds(segment, nodeWalls, segmentSpacingBuffer, guard);
      // A narrow gap elsewhere in this component must not let wire shortening pull a route against a previously comfortable border.
      // Preserve short existing gaps; larger ones may contract to the ordinary spacing distance. These are absolute bounds, separate
      // from the shared gap variable, so clearance is not counted twice.
      if (lower !== -Infinity) clearance.start = Math.max(clearance.start, lower + Math.min(group.position - lower, segmentSpacingBuffer));
      if (upper !== Infinity) clearance.end = Math.min(clearance.end, upper - Math.min(upper - group.position, segmentSpacingBuffer));
    }
    group.nodeClearance = clearance;
  }
  const appendFixed = (group) => {
    for (const s of group.segments) fixed.push(s);
  };
  for (const group of groups) {
    if (group.fixed) appendFixed(group);
  }
  // A real wall must bound both sides. An arbitrary margin outside the drawing would turn repeated nudging into outward drift.
  for (let pass = 0; pass < 2; pass++) {
    for (const group of groups) {
      if (group.fixed) continue;
      group.lower = -Infinity;
      group.upper = Infinity;
      for (const s of group.segments) {
        const [lo, hi] = routeSegmentBounds(s, fixed, segmentSpacingBuffer, guard);
        group.lower = Math.max(group.lower, lo);
        group.upper = Math.min(group.upper, hi);
      }
      if (group.lower === Infinity || group.lower === -Infinity || group.upper === Infinity || group.upper === -Infinity ||
        group.lower > group.position || group.upper < group.position || group.lower >= group.upper) {
        group.fixed = true;
        appendFixed(group);
      }
    }
  }
  for (const group of groups) {
    if (!group.fixed) result.groups.push(group);
  }
  stableSortRouteValues(result.groups, (a, b) => a.position < b.position, guard);
  for (let i = 0; i < result.groups.length; i++) {
    const a = result.groups[i];
    for (let j = i + 1; j < result.groups.length; j++) {
      const b = result.groups[j];
      let linked = false, sameOwner = true;
      const owner = a.segments[0].owner();
      for (const s of a.segments) sameOwner = sameOwner && s.owner() === owner;
      for (const s of b.segments) sameOwner = sameOwner && s.owner() === owner;
      let buffer = segmentSpacingBuffer;
      if (sameOwner) buffer = 0;
      for (const s of a.segments) {
        for (const t of b.segments) {
          guard.step();
          linked = linked || s.overlaps(t, horizontal, buffer);
        }
      }
      if (linked) result.arcs.push(newChannelArc(i, j, !sameOwner));
    }
  }
  return result;
}

/**
 * solveChannelGap computes the earliest and latest feasible solutions of the same difference constraints. Their midpoint is feasible by
 * convexity. Returns [lo, hi, feasible].
 */
export function solveChannelGap(p, gap, guard) {
  const n = p.groups.length;
  guard.add(n * 2);
  const lo = new Array(n).fill(0), hi = new Array(n).fill(0);
  for (let i = 0; i < p.groups.length; i++) {
    const group = p.groups[i];
    lo[i] = group.lower + gap;
    hi[i] = group.upper - gap;
    if (group.nodeClearance !== null) {
      lo[i] = Math.max(lo[i], group.nodeClearance.start);
      hi[i] = Math.min(hi[i], group.nodeClearance.end);
    }
  }
  for (const arc of p.arcs) {
    guard.step();
    let separation = 0.0;
    if (arc.separate) separation = gap;
    lo[arc.to] = Math.max(lo[arc.to], lo[arc.from] + separation);
  }
  for (let index = p.arcs.length - 1; index >= 0; index--) {
    const arc = p.arcs[index];
    guard.step();
    let separation = 0.0;
    if (arc.separate) separation = gap;
    hi[arc.from] = Math.min(hi[arc.from], hi[arc.to] - separation);
  }
  for (let i = 0; i < lo.length; i++) {
    if (lo[i] > hi[i]) return [null, null, false];
  }
  return [lo, hi, true];
}

export function channelGap(p, positions) {
  let gap = Infinity;
  for (let i = 0; i < p.groups.length; i++) {
    const group = p.groups[i];
    gap = Math.min(gap, Math.min(positions[i] - group.lower, group.upper - positions[i]));
  }
  for (const arc of p.arcs) {
    if (arc.separate) gap = Math.min(gap, positions[arc.to] - positions[arc.from]);
  }
  return gap;
}

export function applyChannelProblem(g, p, horizontal, guard) {
  const parent = new Array(p.groups.length);
  for (let i = 0; i < parent.length; i++) parent[i] = i;
  const root = (i) => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  for (const arc of p.arcs) parent[root(arc.to)] = root(arc.from);
  const components = new Map();
  const order = [];
  for (let i = 0; i < p.groups.length; i++) {
    const id = root(i);
    if (!components.has(id)) order.push(id);
    if (!components.has(id)) components.set(id, []);
    components.get(id).push(i);
  }
  let changed = false;
  for (const id of order) {
    const local = newChannelProblem();
    const indices = new Map();
    for (const i of components.get(id)) {
      indices.set(i, local.groups.length);
      local.groups.push(p.groups[i]);
    }
    for (const arc of p.arcs) {
      if (indices.has(arc.from)) local.arcs.push(newChannelArc(indices.get(arc.from), indices.get(arc.to), arc.separate));
    }
    const positions = new Array(local.groups.length);
    for (let i = 0; i < local.groups.length; i++) positions[i] = local.groups[i].position;
    const oldGap = Math.max(0, channelGap(local, positions));
    let left = oldGap, right = Infinity;
    for (const group of local.groups) right = Math.min(right, (group.upper - group.lower) / 2);
    for (let iteration = 0; iteration < 32 && right - left > channelEpsilon; iteration++) {
      const mid = (left + right) / 2;
      const [, , feasible] = solveChannelGap(local, mid, guard);
      if (feasible) left = mid;
      else right = mid;
    }
    let bestLength = channelWireLength(g, null, guard);
    let bestGap = oldGap;
    let best = null;
    for (const gap of [oldGap, left]) {
      const [earliest, latest, feasible] = solveChannelGap(local, gap, guard);
      if (!feasible) continue;
      for (const fraction of [0, 1, 0.5]) {
        const candidate = new Array(positions.length);
        for (let i = 0; i < candidate.length; i++) candidate[i] = earliest[i] * (1 - fraction) + latest[i] * fraction;
        const [proposal, compatible] = channelPointProposal(local, candidate, horizontal, guard);
        if (!compatible) continue;
        const length = channelWireLength(g, proposal, guard);
        const actualGap = channelGap(local, candidate);
        // Pixel-level rounding changes alone are not a spacing benefit.
        if (length > bestLength + channelEpsilon || (Math.abs(length - bestLength) <= channelEpsilon && actualGap < bestGap + 1)) continue;
        const safe = channelProposalSafe(g, proposal, guard);
        if (!safe) continue;
        best = proposal;
        bestLength = length;
        bestGap = actualGap;
      }
    }
    if (best !== null) {
      for (const [original, candidate] of best) {
        guard.step();
        original.x = candidate.x;
        original.y = candidate.y;
      }
      changed = true;
    }
  }
  return changed;
}

/** returns [proposal: Map<Point, Point>, compatible] */
export function channelPointProposal(p, positions, horizontal, guard) {
  const proposal = new Map();
  for (let i = 0; i < p.groups.length; i++) {
    const group = p.groups[i];
    for (const s of group.segments) {
      for (const point of [s.Start, s.End]) {
        guard.step();
        const candidate = point.copy();
        if (horizontal) candidate.x = positions[i];
        else candidate.y = positions[i];
        const old = proposal.get(point);
        if (old !== undefined && !(old.x === candidate.x && old.y === candidate.y)) return [null, false];
        proposal.set(point, candidate);
      }
    }
  }
  return [proposal, true];
}

/** channelWireLength(g, proposal (Map or null), guard) */
export function channelWireLength(g, proposal, guard) {
  let length = 0.0;
  for (const e of g.edges) {
    for (let i = 1; i < e.points.length; i++) {
      guard.step();
      let a = e.points[i - 1], b = e.points[i];
      if (proposal !== null) {
        let p = proposal.get(a);
        if (p !== undefined) a = p;
        p = proposal.get(b);
        if (p !== undefined) b = p;
      }
      length += goHypot(b.x - a.x, b.y - a.y);
    }
  }
  return length;
}

export function channelProposalSafe(g, proposal, guard) {
  const candidates = new Array(g.edges.length).fill(null);
  const changed = new Array(g.edges.length).fill(false);
  for (let index = 0; index < g.edges.length; index++) {
    const e = g.edges[index];
    const candidate = copyOwn(e);
    candidate.points = e.points.slice();
    for (let i = 0; i < e.points.length; i++) {
      const point = e.points[i];
      guard.step();
      const p = proposal.get(point);
      if (p !== undefined) {
        candidate.points[i] = p;
        changed[index] = changed[index] || !(p.x === point.x && p.y === point.y);
      }
    }
    candidates[index] = candidate;
    if (!changed[index]) continue;
    if (e.isCurve) return false;
    const safe = changedRouteIsClear(g, candidate, e.points, true, guard);
    if (!safe) return safe;
    let beforeLength = 0.0, afterLength = 0.0;
    const nonzero = [];
    for (let i = 0; i < candidate.points.length; i++) {
      const point = candidate.points[i];
      guard.step();
      if (Number.isNaN(point.x) || Number.isNaN(point.y) || point.x === Infinity || point.x === -Infinity || point.y === Infinity || point.y === -Infinity) {
        return false;
      }
      if (i > 0) {
        const old = e.points[i - 1], previous = candidate.points[i - 1];
        const before = goHypot(e.points[i].x - old.x, e.points[i].y - old.y);
        const after = goHypot(point.x - previous.x, point.y - previous.y);
        beforeLength += before;
        afterLength += after;
        if (after > channelEpsilon && after + channelEpsilon < Math.min(before, segmentSpacingBuffer)) return false;
      }
      const last = nonzero.length === 0 ? null : nonzero[nonzero.length - 1];
      if (last === null || !(last.x === point.x && last.y === point.y)) nonzero.push(point);
    }
    if (afterLength > beforeLength + channelEpsilon) return false;
    for (let i = 2; i < nonzero.length; i++) {
      const a = nonzero[i - 2], b = nonzero[i - 1], c = nonzero[i];
      if ((b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y) < 0) return false;
    }
    for (let i = 0; i + 1 < nonzero.length; i++) {
      for (let j = i + 2; j + 1 < nonzero.length; j++) {
        guard.step();
        if (new geo.Segment(nonzero[i], nonzero[i + 1]).intersects(new geo.Segment(nonzero[j], nonzero[j + 1]))) return false;
      }
    }
  }
  for (let i = 0; i < g.edges.length; i++) {
    const e = g.edges[i];
    for (let j = i + 1; j < g.edges.length; j++) {
      if (!changed[i] && !changed[j]) continue;
      const other = g.edges[j];
      if (e.isCurve || other.isCurve) return false;
      let beforeCrossings = 0, afterCrossings = 0;
      for (let a = 0; a + 1 < e.points.length; a++) {
        for (let b = 0; b + 1 < other.points.length; b++) {
          guard.step();
          if (isNonSharedCrossing(e, other, a, b)) beforeCrossings++;
          if (isNonSharedCrossing(candidates[i], candidates[j], a, b)) afterCrossings++;
          const oldOverlap = balanceCollinearOverlap(e.points[a], e.points[a + 1], other.points[b], other.points[b + 1]);
          const newOverlap = balanceCollinearOverlap(candidates[i].points[a], candidates[i].points[a + 1], candidates[j].points[b], candidates[j].points[b + 1]);
          if (oldOverlap === 0 && newOverlap > 0) return false;
          const oldContact = new geo.Segment(e.points[a], e.points[a + 1]).intersects(new geo.Segment(other.points[b], other.points[b + 1]));
          const newContact = new geo.Segment(candidates[i].points[a], candidates[i].points[a + 1]).intersects(new geo.Segment(candidates[j].points[b], candidates[j].points[b + 1]));
          if (!oldContact && newContact) return false;
        }
      }
      if (afterCrossings > beforeCrossings) return false;
    }
  }
  return true;
}
