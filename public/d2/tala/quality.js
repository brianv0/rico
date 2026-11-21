// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of the Go package d2layouts/d2talalayout/internal/quality (D2 v0.9.0): evaluation of completed layouts. It reads
// layoutgraph's positioned graph model without mutating it; lower scores are better. The penalty and the area decide which seed TALA
// prints, so every float operation is the Go one in the same order. Line for line from score.go, scoring.go, evaluation_guard.go,
// crossings.go, inspection*.go and labels.go. Conventions: see layoutgraph.js and docs/d2-tala-port.md (errors are thrown).
//
//  - `evaluateWithArea(ctx, graph)` returns [penalty, area]; `evaluate` returns a `Score` ({penalty, area}); `inspect` returns the
//    `Metrics` object {nodeOverlaps, routeObstructions, textOcclusions, crossings, detour, routeLength}.
//  - `evaluateWithAreaLimit(ctx, graph, limit)` and `inspectWithLimit` are the unexported Go functions that also report the work
//    units used: they return [penalty, area, used] and [metrics, used].

import * as geo from '../geo.js';
import * as label from '../label.js';
import * as lg from './layoutgraph.js';
import * as limits from './limits.js';
import * as labeling from './labeling.js';
import { errorf } from './goerrors.js';

// ---- score.go ----

/** Score preserves the original TALA penalty and separate area tie-breaker. */
export class Score {
  constructor(penalty = 0, area = 0) {
    this.penalty = penalty;
    this.area = area;
  }

  /** Compare orders penalties exactly, then areas, with the same handling of non-finite values as the original seed-result comparator. */
  compare(other) {
    const comparison = compareNumber(this.penalty, other.penalty, false);
    if (comparison !== 0) return comparison;
    return compareNumber(this.area, other.area, true);
  }
}

/** Evaluate adapts the original evaluator for bounded refinement callers. */
export function evaluate(ctx, graph) {
  const [penalty, area] = evaluateWithArea(ctx, graph);
  return new Score(penalty, area);
}

/** cmp.Compare of two float64 values (NaN sorts before everything else, equal to itself). */
function cmpCompare(x, y) {
  const xNaN = Number.isNaN(x), yNaN = Number.isNaN(y);
  if (xNaN) return yNaN ? 0 : -1;
  if (yNaN) return 1;
  if (x < y) return -1;
  if (x > y) return 1;
  return 0;
}

function compareNumber(left, right, nonnegative) {
  const leftValid = finite(left) && (!nonnegative || left >= 0);
  const rightValid = finite(right) && (!nonnegative || right >= 0);
  if (leftValid && !rightValid) return -1;
  if (!leftValid && rightValid) return 1;
  if (!leftValid) return 0;
  return cmpCompare(left, right);
}

function finite(value) {
  return !Number.isNaN(value) && value !== Infinity && value !== -Infinity;
}

// ---- evaluation_guard.go ----

// maxEvaluationWorkUnits bounds the complete candidate-scoring pass.
const maxEvaluationWorkUnits = 50_000_000;

function newEvaluationWorkGuard(ctx, limit) {
  const guard = limits.newWorkGuard(ctx, 'Evaluate', limit);
  if (limit < 0) throw errorf('TALA Evaluate work limit must not be negative');
  return guard;
}

function chargeEvaluationWork(guard, amount) {
  if (amount < 0) throw errorf('TALA Evaluate work charge must not be negative');
  guard.add(amount);
}

/**
 * chargeEvaluationAreaWork accounts a conservative upper bound for the legacy bounding-box kernel before it runs. This is deliberately
 * charged up front: Area may scan all nodes for each outside label and walks each route again for edge and arrowhead-label bounds.
 */
function chargeEvaluationAreaWork(g, guard) {
  chargeEvaluationWork(guard, g.nodes.length);
  for (const node of g.nodes) {
    if (node.label !== null && label.isOutside(node.label.position)) {
      // Bounding-box calculation can ask each of Leftmost, Topmost, Rightmost, and Bottommost to scan the complete node set.
      for (let i = 0; i < 4; i++) chargeEvaluationWork(guard, g.nodes.length);
    }
  }
  for (const edge of g.edges) {
    let multiplier = 1; // Edge bounding-box calculation always walks the route.
    if (edge.label !== null && edge.points.length !== 0 && edge.label.position !== label.Unset) multiplier++;
    if (edge.sourceArrowheadLabel !== null) multiplier++;
    if (edge.targetArrowheadLabel !== null) multiplier++;
    for (let i = 0; i < multiplier; i++) chargeEvaluationWork(guard, edge.points.length);
  }
}

/** evaluationIsDescendantOf is a cancellation- and budget-aware ancestry check. */
function evaluationIsDescendantOf(maybeDescendant, maybeAncestor, guard) {
  for (let depth = 0; ; depth++) {
    guard.step();
    if (maybeAncestor === maybeDescendant) return true;
    if (maybeDescendant === null) return false;
    if (depth >= lg.MaxTopologyDepth) throw errorf(`TALA Evaluate ancestry depth exceeds limit ${lg.MaxTopologyDepth}`);
    maybeDescendant = lg.ancestryParent(maybeDescendant);
    if (maybeDescendant === null) return maybeAncestor === null;
  }
}

// ---- scoring.go ----

/**
 * EvaluateWithArea returns the human-facing layout score and the graph area separately: [penalty, area]. Area is a strict
 * tie-breaker: encoding it into the float score made 100 smaller than 99 (0.1 versus 0.99) and could outweigh real layout differences.
 */
export function evaluateWithArea(ctx, graph) {
  const [score, area] = evaluateWithAreaLimit(ctx, graph, maxEvaluationWorkUnits);
  return [score, area];
}

/** Returns [score, area, used]; when it throws, `err.used` carries guard.Used() (Go returns it next to the error). */
export function evaluateWithAreaLimit(ctx, graph, workLimit) {
  if (graph === null) throw errorf('cannot evaluate a nil graph');
  // Keep this preflight at the quality boundary so candidate evaluation and direct internal callers receive the same resource bounds.
  // It runs before label-overlap scratch slices and maps are constructed.
  lg.validatePositionedGraph(ctx, 'Evaluate', graph);
  const guard = newEvaluationWorkGuard(ctx, workLimit);
  try {
    let score = 0.0;
    for (const e of graph.edges) {
      guard.step();
      if (e.from.cluster !== null || e.to.cluster !== null) continue;
      const turns = Math.max(0, e.points.length - 2);
      score += turns * 0.5;

      for (let i = 0; i < e.points.length - 1; i++) {
        guard.step();
        const curr = e.points[i];
        const next = e.points[i + 1];
        // Extra penalty for diagonals
        if (curr.x !== next.x && curr.y !== next.y) score += 3;
      }
    }
    const crossings = countNonSharedCrossings(graph.edges, guard);
    score += crossings;
    const labelScore = scoreExistingLabelPlacements(graph, guard);
    score += 1.0 - labelScore;
    chargeEvaluationAreaWork(graph, guard);
    const area = graph.area();
    guard.finish();
    return [score, area, guard.used()];
  } catch (e) {
    if (e && e.name === 'GoError') e.used = guard.used();
    throw e;
  }
}

// ---- crossings.go ----

function countNonSharedCrossings(edges, guard) {
  let crossingCount = 0;
  for (let i = 0; i < edges.length; i++) {
    const edge = edges[i];
    guard.step();
    for (let j = i + 1; j < edges.length; j++) {
      // Charge every pair even when one route has no segments. Iterating a large collection of incomplete routes is still quadratic work.
      guard.step();
      crossingCount += countEdgeCrossings(edge, edges[j], guard);
    }
  }
  return crossingCount;
}

function countEdgeCrossings(edge, other, guard) {
  let crossingCount = 0;
  for (let i = 0; i < edge.points.length - 1; i++) {
    guard.step();
    for (let j = 0; j < other.points.length - 1; j++) {
      guard.step();
      if (isNonSharedCrossing(edge, other, i, j)) crossingCount++;
    }
  }
  return crossingCount;
}

function isNonSharedCrossing(edge, other, edgeSegment, otherSegment) {
  if (!nonParallelIntersection(
    edge.points[edgeSegment],
    edge.points[edgeSegment + 1],
    other.points[otherSegment],
    other.points[otherSegment + 1],
  )) {
    return false;
  }

  // Skip intersections at the exact end of the segment to avoid counting bends off shared edges.
  const segmentStartX = edge.points[edgeSegment].x;
  const segmentStartY = edge.points[edgeSegment].y;
  if (segmentStartX === edge.points[edgeSegment + 1].x &&
    (segmentStartX === other.points[otherSegment].x || segmentStartX === other.points[otherSegment + 1].x)) {
    return false;
  }
  if (segmentStartY === edge.points[edgeSegment + 1].y &&
    (segmentStartY === other.points[otherSegment].y || segmentStartY === other.points[otherSegment + 1].y)) {
    return false;
  }
  return true;
}

/** orientation returns a positive value for a clockwise turn, a negative value for a counter-clockwise turn, and zero for collinear points. */
function orientation(p, q, r) {
  const pqX = q.x - p.x;
  const pqY = q.y - p.y;
  const prX = r.x - p.x;
  const prY = r.y - p.y;
  return pqY * prX - pqX * prY;
}

function equalSigns(a, b) {
  return (a > 0 && b > 0) || (a === 0 && b === 0) || (a < 0 && b < 0);
}

/** nonParallelIntersection reports whether segments ab and cd intersect at an angle. Collinear overlap is intentionally not a crossing. */
function nonParallelIntersection(a, b, c, d) {
  const abcOrientation = orientation(a, b, c);
  const abdOrientation = orientation(a, b, d);
  if (equalSigns(abcOrientation, abdOrientation)) return false;

  const cdaOrientation = orientation(c, d, a);
  const cdbOrientation = orientation(c, d, b);
  return !equalSigns(cdaOrientation, cdbOrientation);
}

// ---- inspection.go ----

/**
 * Inspect reads diagnostics without mutating the graph or influencing Score. Metrics describe a positioned drawing for bounded repair
 * triggers and safety checks: {nodeOverlaps, routeObstructions, textOcclusions, crossings, detour, routeLength}.
 */
export function inspect(ctx, graph) {
  return inspectWithLimit(ctx, graph, maxEvaluationWorkUnits)[0];
}

const newMetrics = () => ({ nodeOverlaps: 0, routeObstructions: 0, textOcclusions: 0, crossings: 0, detour: 0, routeLength: 0 });

/** Returns [metrics, used]; when it throws, `err.used` carries guard.Used(). */
export function inspectWithLimit(ctx, graph, workLimit) {
  if (graph === null) throw errorf('cannot evaluate a nil graph');
  lg.validatePositionedGraph(ctx, 'Inspect', graph);
  const guard = limits.newWorkGuard(ctx, 'Inspect', workLimit);
  const score = newMetrics();
  try {
    // Normalize by typical noncontainer dimensions, rather than drawing bounds:
    // opening empty space or expanding a container cannot make wire cheaper.
    let scale = 0.0, nodeCount = 0;
    for (const node of graph.nodes) {
      guard.step();
      if (!node.isContainer() && !node.isInvisible) {
        scale += (node.width + node.height) / 2;
        nodeCount++;
      }
    }
    scale = Math.max(1, scale / Math.max(1, nodeCount));
    const visible = [];
    for (const edge of graph.edges) {
      guard.step();
      if (edge.isInvisible) continue;
      visible.push(edge);
      let length = 0.0;
      for (let i = 1; i < edge.points.length; i++) {
        guard.step();
        const a = edge.points[i - 1], b = edge.points[i];
        length += Math.hypot(b.x - a.x, b.y - a.y);
      }
      score.routeLength += length / scale;
      if (edge.points.length < 2 || edge.isLoop()) continue;
      const first = edge.points[0], last = edge.points[edge.points.length - 1];
      const direct = Math.abs(last.x - first.x) + Math.abs(last.y - first.y);
      score.detour += Math.max(0, length - direct) / Math.max(scale, direct);
    }
    const crossings = countNonSharedCrossings(visible, guard);
    score.crossings = crossings;
    measureGeometry(graph, score, guard);
    measureLabels(graph, score, guard);
    if (!finite(score.routeLength) || !finite(score.detour)) throw errorf('TALA Inspect produced non-finite geometry');
    guard.finish();
    return [score, guard.used()];
  } catch (e) {
    if (e && e.name === 'GoError') e.used = guard.used();
    throw e;
  }
}

// ---- inspection_geometry.go ----

/**
 * measureGeometry counts occupied rectangular interiors. Container containment is intentional, and an edge may cross a boundary
 * enclosing either endpoint. Curved routes and nonrectangular silhouettes require renderer geometry and are deliberately not treated
 * as invalid based only on their bounding boxes.
 */
function measureGeometry(g, score, guard) {
  for (let i = 0; i < g.nodes.length; i++) {
    const node = g.nodes[i];
    guard.step();
    if (node.isInvisible || !node.isRectangular()) continue;
    for (let k = i + 1; k < g.nodes.length; k++) {
      const other = g.nodes[k];
      guard.step();
      if (other.isInvisible || !other.isRectangular() || !boxesOverlapWithPadding(node.box, other.box, 0)) continue;
      const related = relatedNodes(node, other, guard);
      if (!related) score.nodeOverlaps++;
    }
    for (const edge of g.edges) {
      guard.step();
      if (edge.isInvisible || edge.isCurve) continue;
      const ancestor = endpointAncestor(edge, node, guard);
      if (ancestor && edge.from !== node && edge.to !== node) continue;
      for (let k = 1; k < edge.points.length; k++) {
        guard.step();
        // The first/last approach may begin inside a shape before border tracing. Later reentry into an endpoint is an obstacle.
        if ((k === 1 && edge.from === node) || (k === edge.points.length - 1 && edge.to === node)) continue;
        if (segmentEntersBox(node.box, edge.points[k - 1], edge.points[k])) {
          score.routeObstructions++;
          break; // One obstruction per edge/node, independent of subdivision.
        }
      }
    }
  }
}

function relatedNodes(a, b, guard) {
  const yes = evaluationIsDescendantOf(a, b, guard);
  if (yes) return yes;
  return evaluationIsDescendantOf(b, a, guard);
}

function endpointAncestor(edge, node, guard) {
  const yes = evaluationIsDescendantOf(edge.from, node, guard);
  if (yes) return yes;
  return evaluationIsDescendantOf(edge.to, node, guard);
}

/**
 * An open-rectangle slab intersection: touching or following a border does not occlude the interior. This also handles diagonal
 * segments without sampling.
 */
function segmentEntersBox(box, a, b) {
  if (box.Width <= 0 || box.Height <= 0 || (a.x === b.x && a.y === b.y)) return false;
  let low = 0.0, high = 1.0;
  const axes = [
    [a.x, b.x - a.x, box.TopLeft.x, box.TopLeft.x + box.Width],
    [a.y, b.y - a.y, box.TopLeft.y, box.TopLeft.y + box.Height],
  ];
  for (const axis of axes) {
    const start = axis[0], delta = axis[1], minValue = axis[2], maxValue = axis[3];
    if (delta === 0) {
      if (start <= minValue || start >= maxValue) return false;
      continue;
    }
    let first = (minValue - start) / delta, last = (maxValue - start) / delta;
    if (first > last) [first, last] = [last, first];
    low = Math.max(low, first);
    high = Math.min(high, last);
    if (low >= high) return false;
  }
  return low < high;
}

// ---- inspection_labels.go ----

/**
 * measureLabels treats all rendered label and icon boxes consistently, including loop and arrowhead labels. Padding-only near misses do
 * not trigger repair.
 */
function measureLabels(g, score, guard) {
  guard.step();
  const labels = [];
  const appendLabel = (box, node, edge) => {
    if (box.Width > 0 && box.Height > 0) labels.push({ box, node, edge });
  };
  for (const node of g.nodes) {
    guard.step();
    if (node.isInvisible) continue;
    if (node.label !== null && node.label.position !== label.Unset) {
      if (label.isOutside(node.label.position)) chargeEvaluationWork(guard, 4 * g.nodes.length);
      appendLabel(new geo.Box(node.labelTopLeft(node.label.position, node.label.width, node.label.height), node.label.width, node.label.height), node, null);
    }
    if (node.icon !== null && !node.isImage()) {
      if (label.isOutside(node.icon.position)) chargeEvaluationWork(guard, 4 * g.nodes.length);
      const size = node.iconSize(node.icon.position);
      appendLabel(new geo.Box(node.labelTopLeft(node.icon.position, size, size), size, size), node, null);
    }
  }
  const visibleEdges = [];
  for (const edge of g.edges) {
    guard.step();
    if (edge.isInvisible) continue;
    visibleEdges.push(edge);
    if (edge.points.length < 2) continue;
    if (edge.label !== null && edge.label.position !== label.Unset) {
      chargeEvaluationWork(guard, edge.points.length);
      appendLabel(labelBox(edge), null, edge);
    }
    if (edge.sourceArrowheadLabel !== null) {
      chargeEvaluationWork(guard, edge.points.length);
      appendLabel(labeling.positionArrowheadLabel(edge, false, edge.points).box, null, edge);
    }
    if (edge.targetArrowheadLabel !== null) {
      chargeEvaluationWork(guard, edge.points.length);
      appendLabel(labeling.positionArrowheadLabel(edge, true, edge.points).box, null, edge);
    }
  }
  for (let i = 0; i < labels.length; i++) {
    const placed = labels[i];
    guard.step();
    for (let k = 0; k < i; k++) {
      const other = labels[k];
      guard.step();
      if (boxesOverlapWithPadding(placed.box, other.box, 0)) score.textOcclusions++;
    }
    for (const node of g.nodes) {
      guard.step();
      if (node.isInvisible || !node.isRectangular()) continue;
      if (!boxesOverlapWithPadding(placed.box, node.box, 0)) continue;
      let ancestor = false;
      if (placed.node !== null) {
        ancestor = evaluationIsDescendantOf(placed.node, node, guard);
      } else {
        ancestor = endpointAncestor(placed.edge, node, guard);
        // Labels may be inside enclosing containers, but must remain outside the shapes to which their edge connects.
        ancestor = ancestor && node !== placed.edge.from && node !== placed.edge.to;
      }
      if (ancestor && boxCovers(node.box, placed.box)) continue;
      score.textOcclusions++;
    }
    for (const edge of visibleEdges) {
      guard.step();
      if (edge === placed.edge || edge.isCurve) continue;
      let overlap = false;
      for (let j = 1; j < edge.points.length; j++) {
        guard.step();
        if (segmentEntersBox(placed.box, edge.points[j - 1], edge.points[j])) {
          overlap = true;
          break;
        }
      }
      if (overlap) score.textOcclusions++;
    }
  }
}

// ---- labels.go ----

function scoreExistingLabelPlacements(g, guard) {
  guard.step();

  const placedBoxes = [];
  let totalScore = 0.0;

  // Arrowhead labels and loop labels reserve space before ordinary node and edge labels are scored.
  for (const edge of g.edges) {
    guard.step();
    if (edge.sourceArrowheadLabel !== null) {
      chargeEvaluationWork(guard, edge.points.length);
      placedBoxes.push(labeling.positionArrowheadLabel(edge, false, edge.points).box);
    }
    if (edge.targetArrowheadLabel !== null) {
      chargeEvaluationWork(guard, edge.points.length);
      placedBoxes.push(labeling.positionArrowheadLabel(edge, true, edge.points).box);
    }
  }

  for (const edge of g.edges) {
    guard.step();
    if (edge.isLoop() && edge.label !== null) {
      chargeEvaluationWork(guard, edge.points.length);
      placedBoxes.push(labelBox(edge));
    }
  }

  for (const node of g.nodes) {
    guard.step();

    if (node.icon !== null && !node.isImage()) {
      const iconSize = node.iconSize(node.icon.position);
      const iconBox = new geo.Box(node.labelTopLeft(node.icon.position, iconSize, iconSize), iconSize, iconSize);
      placedBoxes.push(iconBox);

      const nodeOverlaps = nodeOverlapCount(iconBox, g.nodes, 0, guard);
      const edgeOverlaps = edgeOverlapCount(iconBox, g.edges, 0, guard);
      const labelOverlaps = boxOverlapCount(iconBox, placedBoxes, 0, guard);
      totalScore += scoreNodeLabelOverlaps(nodeOverlaps, edgeOverlaps, labelOverlaps - 1);
    }

    if (node.label === null) continue;
    const nodeLabelBox = new geo.Box(
      node.labelTopLeft(node.label.position, node.label.width, node.label.height), node.label.width, node.label.height);

    const siblingsAndChildren = [];
    for (const sibling of containersAt(g, node.container)) {
      guard.step();
      if (sibling !== node) siblingsAndChildren.push(sibling);
    }
    if (node.isContainer()) {
      for (const child of containersAt(g, node)) {
        guard.step();
        siblingsAndChildren.push(child);
      }
    }

    const ancestors = [];
    for (let current = node, depth = 0; current !== null; current = lg.effectiveContainer(current), depth++) {
      guard.step();
      if (depth >= lg.MaxTopologyDepth) throw errorf(`TALA Evaluate container depth exceeds limit ${lg.MaxTopologyDepth}`);
      ancestors.push(current);
    }

    const siblingOverlaps = nodeOverlapCount(nodeLabelBox, siblingsAndChildren, label.PADDING, guard);
    const ancestorOverlaps = partialNodeOverlapCount(nodeLabelBox, ancestors, label.PADDING, guard);
    const edgeOverlaps = edgeOverlapCount(nodeLabelBox, g.edges, label.PADDING - 1, guard);
    const labelOverlaps = boxOverlapCount(nodeLabelBox, placedBoxes, label.PADDING, guard);
    totalScore += scoreNodeLabelOverlaps(siblingOverlaps + ancestorOverlaps, edgeOverlaps, labelOverlaps);
    placedBoxes.push(nodeLabelBox);
  }

  const sharedSegments = findSharedSegments(g.edges, guard);
  const sharedSegmentBoxes = [];
  for (const segment of sharedSegments) {
    guard.step();
    const topLeft = segment.Start.copy();
    let width = segment.End.x - segment.Start.x;
    let height = segment.End.y - segment.Start.y;
    if (segment.End.x === segment.Start.x) {
      width = 2 * labeling.SharedSegmentClearance;
      topLeft.x -= labeling.SharedSegmentClearance;
    } else {
      height = 2 * labeling.SharedSegmentClearance;
      topLeft.y -= labeling.SharedSegmentClearance;
    }
    sharedSegmentBoxes.push(new geo.Box(topLeft, width, height));
  }

  for (const edge of g.edges) {
    guard.step();
    if (edge.label === null || edge.isLoop()) continue;
    chargeEvaluationWork(guard, edge.points.length);
    const edgeLabelBox = labelBox(edge);

    const otherEdges = [];
    for (const other of g.edges) {
      guard.step();
      if (other !== edge) otherEdges.push(other);
    }

    const ancestors = [], nonAncestors = [];
    for (const node of g.nodes) {
      guard.step();
      const fromDescendant = evaluationIsDescendantOf(edge.from, node, guard);
      const toDescendant = evaluationIsDescendantOf(edge.to, node, guard);
      if (node !== edge.from && node !== edge.to && (fromDescendant || toDescendant)) ancestors.push(node);
      else nonAncestors.push(node);
    }

    const ancestorOverlapArea = nodeOverlapArea(edgeLabelBox, ancestors, label.PADDING, true, guard);
    const nonAncestorOverlapArea = nodeOverlapArea(edgeLabelBox, nonAncestors, label.PADDING, false, guard);
    const edgeOverlaps = edgeOverlapCount(edgeLabelBox, otherEdges, label.PADDING, guard);
    const labelOverlaps = boxOverlapCount(edgeLabelBox, placedBoxes, 0, guard);
    const almostLabelOverlaps = boxOverlapCount(edgeLabelBox, placedBoxes, label.PADDING, guard);
    const sharedSegmentOverlaps = boxOverlapCount(edgeLabelBox, sharedSegmentBoxes, label.PADDING, guard);

    totalScore += scoreEdgeLabelOverlaps(
      edgeLabelBox.Width * edgeLabelBox.Height,
      ancestorOverlapArea + nonAncestorOverlapArea,
      0,
      edgeOverlaps,
      almostLabelOverlaps,
      labelOverlaps,
      sharedSegmentOverlaps,
    );
    placedBoxes.push(edgeLabelBox);
  }

  return 1 / (1 + totalScore);
}

function containersAt(g, root) {
  const children = g.containers.get(root);
  return children === undefined ? [] : children;
}

function labelBox(edge) {
  return new geo.Box(edge.labelTopLeft(edge.label.position, edge.label.width, edge.label.height), edge.label.width, edge.label.height);
}

function nodeOverlapCount(box, nodes, padding, guard) {
  let count = 0;
  for (const node of nodes) {
    guard.step();
    if (boxesOverlapWithPadding(box, node.box, padding)) count++;
  }
  return count;
}

function partialNodeOverlapCount(box, nodes, padding, guard) {
  let count = 0;
  for (const node of nodes) {
    guard.step();
    if (boxesOverlapWithPadding(box, node.box, padding) && !boxCovers(node.box, box)) count++;
  }
  return count;
}

function boxOverlapCount(box, others, padding, guard) {
  let count = 0;
  for (const other of others) {
    guard.step();
    if (boxesOverlapWithPadding(box, other, padding)) count++;
  }
  return count;
}

function nodeOverlapArea(box, nodes, padding, partial, guard) {
  let area = 0.0;
  for (const node of nodes) {
    guard.step();
    if (!boxesOverlapWithPadding(box, node.box, padding) || (partial && boxCovers(node.box, box))) continue;
    if (padding === 0 || boxesOverlapWithPadding(box, node.box, 0)) area += boxOverlapArea(box, node.box);
    if (!node.isContainer()) area += box.Width * box.Height;
  }
  return area;
}

function edgeOverlapCount(box, edges, padding, guard) {
  let count = 0;
  for (const edge of edges) {
    for (let pointIndex = 1; pointIndex < edge.points.length; pointIndex++) {
      guard.step();
      if (boxOverlapsLine(box, edge.points[pointIndex - 1], edge.points[pointIndex], padding)) count++;
    }
  }
  return count;
}

function boxesOverlapWithPadding(first, second, padding) {
  const firstRight = first.TopLeft.x + first.Width;
  const secondRight = second.TopLeft.x + second.Width;
  if (first.TopLeft.x >= secondRight + padding || second.TopLeft.x >= firstRight + padding) return false;
  const firstBottom = first.TopLeft.y + first.Height;
  const secondBottom = second.TopLeft.y + second.Height;
  return first.TopLeft.y < secondBottom + padding && second.TopLeft.y < firstBottom + padding;
}

function boxCovers(outer, inner) {
  return inner.TopLeft.x >= outer.TopLeft.x &&
    inner.TopLeft.y >= outer.TopLeft.y &&
    inner.TopLeft.x + inner.Width <= outer.TopLeft.x + outer.Width &&
    inner.TopLeft.y + inner.Height <= outer.TopLeft.y + outer.Height;
}

function boxOverlapArea(first, second) {
  const xs = [first.TopLeft.x, first.TopLeft.x + first.Width, second.TopLeft.x, second.TopLeft.x + second.Width];
  const ys = [first.TopLeft.y, first.TopLeft.y + first.Height, second.TopLeft.y, second.TopLeft.y + second.Height];
  xs.sort(cmpCompare);
  ys.sort(cmpCompare);
  return (xs[2] - xs[1]) * (ys[2] - ys[1]);
}

function boxOverlapsLine(box, first, second, padding) {
  const contains = (point) => box.TopLeft.x - padding <= point.x &&
    box.TopLeft.x + box.Width + padding >= point.x &&
    box.TopLeft.y - padding <= point.y &&
    box.TopLeft.y + box.Height + padding >= point.y;
  if (contains(first) || contains(second)) return true;

  const left = box.TopLeft.x - padding;
  const right = box.TopLeft.x + box.Width + padding;
  const top = box.TopLeft.y - padding;
  const bottom = box.TopLeft.y + box.Height + padding;
  const topLeft = geo.newPoint(left, top);
  const topRight = geo.newPoint(right, top);
  const bottomRight = geo.newPoint(right, bottom);
  const bottomLeft = geo.newPoint(left, bottom);
  return segmentsIntersect(topLeft, topRight, first, second) ||
    segmentsIntersect(topRight, bottomRight, first, second) ||
    segmentsIntersect(bottomRight, bottomLeft, first, second) ||
    segmentsIntersect(bottomLeft, topLeft, first, second);
}

function segmentsIntersect(firstStart, firstEnd, secondStart, secondEnd) {
  const secondStartSide = orientation(firstStart, firstEnd, secondStart);
  const secondEndSide = orientation(firstStart, firstEnd, secondEnd);
  const firstStartSide = orientation(secondStart, secondEnd, firstStart);
  const firstEndSide = orientation(secondStart, secondEnd, firstEnd);
  if (secondStartSide === 0 && secondEndSide === 0 && firstStartSide === 0 && firstEndSide === 0) {
    return closedIntervalsOverlap(firstStart.x, firstEnd.x, secondStart.x, secondEnd.x) &&
      closedIntervalsOverlap(firstStart.y, firstEnd.y, secondStart.y, secondEnd.y);
  }
  return straddlesLine(secondStartSide, secondEndSide) && straddlesLine(firstStartSide, firstEndSide);
}

function straddlesLine(first, second) {
  return first === 0 || second === 0 || (first < 0) !== (second < 0);
}

function closedIntervalsOverlap(firstStart, firstEnd, secondStart, secondEnd) {
  const firstMin = Math.min(firstStart, firstEnd), firstMax = Math.max(firstStart, firstEnd);
  const secondMin = Math.min(secondStart, secondEnd), secondMax = Math.max(secondStart, secondEnd);
  return firstMin <= secondMax && secondMin <= firstMax;
}

function scoreNodeLabelOverlaps(nodeOverlaps, edgeOverlaps, labelOverlaps) {
  return nodeOverlaps + edgeOverlaps + 2 * labelOverlaps;
}

function scoreEdgeLabelOverlaps(
  labelArea, nodeOverlapArea_,
  nodeOverlapCount_, edgeOverlapCount_, almostLabelOverlapCount, labelOverlapCount, sharedSegmentOverlapCount,
) {
  let score = nodeOverlapArea_ / labelArea * 2;
  score += labelOverlapCount * 10;
  score += almostLabelOverlapCount;
  score += nodeOverlapCount_ * 2;
  score += edgeOverlapCount_ * 2;
  score += sharedSegmentOverlapCount;
  return score;
}

/** (Go ranges over maps keyed by the segment's coordinate: the order only orders a set of boxes that is counted.) */
function findSharedSegments(edges, guard) {
  guard.step();
  const vertical = new Map();
  const horizontal = new Map();
  for (const edge of edges) {
    guard.step();
    for (let i = 0; i < edge.points.length - 1; i++) {
      guard.step();
      const segment = geo.newSegment(edge.points[i].copy(), edge.points[i + 1].copy());
      if (segment.Start.x === segment.End.x) {
        if (segment.End.y < segment.Start.y) [segment.End.y, segment.Start.y] = [segment.Start.y, segment.End.y];
        if (!vertical.has(segment.Start.x)) vertical.set(segment.Start.x, []);
        vertical.get(segment.Start.x).push(segment);
      } else if (segment.Start.y === segment.End.y) {
        if (segment.End.x < segment.Start.x) [segment.End.x, segment.Start.x] = [segment.Start.x, segment.End.x];
        if (!horizontal.has(segment.Start.y)) horizontal.set(segment.Start.y, []);
        horizontal.get(segment.Start.y).push(segment);
      }
    }
  }

  const shared = [];
  const addGroups = (groups, isHorizontal) => {
    const coordinate = (point) => (isHorizontal ? point.x : point.y);
    const setCoordinate = (point, value) => {
      if (isHorizontal) point.x = value;
      else point.y = value;
    };

    for (const segments of groups.values()) {
      guard.step();
      if (segments.length === 1) continue;
      sortSharedSegments(segments, coordinate, guard);

      let previous = segments[0];
      let overlap = null;
      for (let i = 1; i < segments.length; i++) {
        guard.step();
        const current = segments[i];
        if (coordinate(previous.End) > coordinate(current.Start)) {
          if (overlap === null) {
            overlap = geo.newSegment(current.Start.copy(), current.Start.copy());
            setCoordinate(overlap.End, Math.min(coordinate(previous.End), coordinate(current.End)));
          } else {
            const minimumOverlap = Math.min(coordinate(previous.End), coordinate(current.End));
            setCoordinate(overlap.End, Math.max(coordinate(overlap.End), minimumOverlap));
          }
        } else if (overlap !== null) {
          shared.push(overlap);
          overlap = null;
        }
        if (coordinate(current.End) > coordinate(previous.End)) previous = current;
      }
      if (overlap !== null) shared.push(overlap);
    }
  };
  addGroups(vertical, false);
  addGroups(horizontal, true);
  return shared;
}

function sortSharedSegments(segments, coordinate, guard) {
  if (segments.length < 2) return;
  let buffer = new Array(segments.length);
  const less = (left, right) => {
    if (coordinate(left.Start) === coordinate(right.Start)) return coordinate(left.End) < coordinate(right.End);
    return coordinate(left.Start) < coordinate(right.Start);
  };
  let items = segments;
  for (let width = 1; width < items.length;) {
    for (let start = 0; start < items.length; start += 2 * width) {
      const middle = Math.min(start + width, items.length);
      const end = Math.min(start + 2 * width, items.length);
      let left = start, right = middle, output = start;
      while (left < middle && right < end) {
        guard.step();
        if (less(items[right], items[left])) {
          buffer[output] = items[right];
          right++;
        } else {
          buffer[output] = items[left];
          left++;
        }
        output++;
      }
      while (left < middle) {
        guard.step();
        buffer[output] = items[left];
        left++;
        output++;
      }
      while (right < end) {
        guard.step();
        buffer[output] = items[right];
        right++;
        output++;
      }
    }
    [items, buffer] = [buffer, items];
    if (width > Math.trunc(items.length / 2)) break;
    width *= 2;
  }
  if (items.length > 0 && items !== segments) {
    for (let i = 0; i < items.length; i++) segments[i] = items[i];
  }
}
