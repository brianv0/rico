// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of the Go package d2layouts/d2talalayout/internal/labeling (D2 v0.9.0): placement of node labels, icons, edge labels
// and arrowhead labels on a routed layout graph (pipeline stage 33, PlaceLabels; also used by routing). Line for line from model.go,
// arrowhead.go, placement.go and guard.go. Conventions: see layoutgraph.js and docs/d2-tala-port.md (errors are thrown, Go pointers are
// references). `PositionedArrowheadLabel` embeds geo.Box in Go: here `label.box` is that Box (like `node.box`), and `topLeft`, `width`
// and `height` read it.

import * as geo from '../geo.js';
import * as label from '../label.js';
import * as shape from '../shape.js';
import * as lg from './layoutgraph.js';
import * as limits from './limits.js';
import * as labelgeom from './labelgeom.js';
import * as nodeshape from './nodeshape.js';
import { goRound } from '../gomath.js';
import { errorf } from './goerrors.js';

const Orientation = geo.Orientation;

/**
 * SharedSegmentClearance reserves space around shared route segments where an edge label would otherwise be ambiguous.
 */
export const SharedSegmentClearance = 2.5 * label.PADDING;
const placementSearchInterval = 0.025;

// ---- model.go ----

// The order of preferred edge-label positions.
const edgeLabelPreferenceOrder = [
  label.OutsideTopCenter,
  label.OutsideBottomCenter,
  label.OutsideTopLeft,
  label.OutsideTopRight,
  label.OutsideBottomLeft,
  label.OutsideBottomRight,
  label.InsideMiddleCenter,
  label.InsideMiddleLeft,
  label.InsideMiddleRight,
];

const nodeLabelPositionOrder = [
  label.InsideMiddleCenter,
  label.InsideTopCenter,
  label.InsideBottomCenter,
  label.InsideMiddleLeft,
  label.InsideMiddleRight,
  label.InsideTopLeft,
  label.InsideTopRight,
  label.InsideBottomLeft,
  label.InsideBottomRight,
  label.OutsideTopCenter,
  label.OutsideBottomCenter,
  label.OutsideLeftMiddle,
  label.OutsideRightMiddle,
  label.OutsideTopLeft,
  label.OutsideTopRight,
  label.OutsideBottomLeft,
  label.OutsideBottomRight,
  label.OutsideLeftTop,
  label.OutsideLeftBottom,
  label.OutsideRightTop,
  label.OutsideRightBottom,
];

const containerLabelPositionOrder = [
  label.InsideTopCenter,
  label.OutsideTopCenter,
  label.InsideBottomCenter,
  label.OutsideBottomCenter,
  label.OutsideTopLeft,
  label.OutsideTopRight,
  label.OutsideBottomLeft,
  label.OutsideBottomRight,
  label.OutsideLeftMiddle,
  label.OutsideRightMiddle,
  label.OutsideLeftTop,
  label.OutsideLeftBottom,
  label.OutsideRightTop,
  label.OutsideRightBottom,
  label.InsideTopLeft,
  label.InsideTopRight,
  label.InsideBottomLeft,
  label.InsideBottomRight,
  label.InsideMiddleLeft,
  label.InsideMiddleRight,
  label.InsideMiddleCenter,
];

const labelTiers = [nodeshape.Good, nodeshape.OK, nodeshape.Unideal, nodeshape.Bad];

/** Initialize reserves each explicit/default node-label and icon position before placement begins. */
export function initialize(graph) {
  for (const node of graph.nodes) {
    setDefaultLabelPlacement(node);
    if (node.icon !== null && node.icon.position !== label.Unset) node.icon.fixPosition();
  }
}

function setDefaultLabelPlacement(node) {
  if (node.label === null) return;
  if (node.label.position === label.Unset) {
    node.label.position = labelPositionPreferences(node)[0];
  } else {
    node.label.fixPosition();
  }
}

function compareLabelPositions(node, first, second) {
  const score = (position) => {
    let score = -1;
    labelTiers.forEach((tier, index) => {
      if (node.shape.labelPositionPreferences(tier).has(position)) score = index + 1;
    });
    return score;
  };
  const firstScore = score(first), secondScore = score(second);
  if (firstScore < secondScore) return 1;
  if (firstScore > secondScore) return -1;
  return 0;
}

function labelPositionPreferences(node) {
  const preferences = [];
  for (const tranche of labelPositionPreferenceTranches(node)) {
    for (const position of tranche) preferences.push(position);
  }
  return preferences;
}

function labelPositionPreferenceTranches(node) {
  let baseOrder = nodeLabelPositionOrder;
  if (node.isContainer()) baseOrder = containerLabelPositionOrder;
  const tranches = [];
  for (const tier of labelTiers) {
    const allowed = node.shape.labelPositionPreferences(tier);
    const tranche = [];
    for (const position of baseOrder) {
      if (allowed.has(position)) tranche.push(position);
    }
    tranches.push(tranche);
  }
  return tranches;
}

// ---- arrowhead.go ----

/** PositionedArrowheadLabel is the rendered box reserved beside one end of an edge route (`box` is the embedded geo.Box). */
export class PositionedArrowheadLabel {
  constructor(box, edge, isTarget, text) {
    this.box = box;
    this.edge = edge;
    this.isTarget = isTarget;
    this.text = text;
  }

  get topLeft() { return this.box.TopLeft; }
  get width() { return this.box.Width; }
  get height() { return this.box.Height; }
}

/**
 * PositionArrowheadLabel derives the renderer-compatible label box for one arrowhead. A null result means that endpoint has no
 * arrowhead label.
 */
export function positionArrowheadLabel(edge, isTarget, route) {
  if (edge === null) return null;
  let value = edge.sourceArrowheadLabel;
  if (isTarget) value = edge.targetArrowheadLabel;
  if (value === null) return null;
  const topLeft = labelgeom.arrowheadTopLeft(
    route,
    isTarget,
    String(edge.sourceArrowhead),
    String(edge.targetArrowhead),
    value.width,
    value.height,
  );
  return new PositionedArrowheadLabel(new geo.Box(topLeft, value.width, value.height), edge, isTarget, value.text);
}

// ---- guard.go ----

const maxLabelPlacementWorkUnits = limits.MaxLabelPlacementWorkUnits;
const maxLabelPlacementAncestryDepth = lg.MaxTopologyDepth;
const labelPlacementContextCheckStride = 64;

/** labelPlacementWorkGuard makes every unit of quadratic/candidate work both cancellable and bounded. */
class LabelPlacementWorkGuard {
  constructor(ctx, location, limit) {
    this.ctx = ctx;
    this.location = location;
    this.used = 0;
    this.limit = limit;
  }

  step() {
    this.add(1);
  }

  add(units) {
    if (units < 0) throw errorf(`TALA ${this.location} received a negative work estimate`);
    // Written this way rather than used+units > limit so the calculation cannot wrap before the comparison.
    if (this.used < 0 || this.used > this.limit || units > this.limit - this.used) {
      // Preserve cancellation as the primary failure when it races the budget boundary; otherwise callers could receive a resource
      // error after they had already canceled the work.
      this.check();
      throw errorf(`TALA ${this.location} work exceeds limit ${this.limit}`);
    }
    const previous = this.used;
    this.used += units;
    if (units === 0 || Math.floor(previous / labelPlacementContextCheckStride) !== Math.floor(this.used / labelPlacementContextCheckStride)) {
      this.check();
    }
  }

  check() {
    const err = this.ctx.err();
    if (err) throw errorf(`${this.location}: ${err.message}`, err);
  }
}

function newLabelPlacementWorkGuard(ctx, location, limit) {
  if (ctx === null || ctx === undefined) throw errorf(`TALA ${location} requires a context`);
  if (limit < 0) throw errorf(`TALA ${location} work limit must not be negative`);
  const guard = new LabelPlacementWorkGuard(ctx, location, limit);
  guard.check();
  return guard;
}

/**
 * captureLabelPlacement records only the state this algorithm owns. Keeping the original label/icon objects (rather than copying or
 * replacing them) preserves pointer identity for callers that retain aliases.
 */
function captureLabelPlacement(g, extraEdges) {
  const snapshot = { labels: [], icons: [], edgePercentages: [] };
  const seenLabels = new Set();
  const seenIcons = new Set();
  const seenEdges = new Set();

  const captureLabel = (value) => {
    if (value === null) return;
    if (seenLabels.has(value)) return;
    seenLabels.add(value);
    snapshot.labels.push({ label: value, position: value.position });
  };
  const captureIcon = (value) => {
    if (value === null) return;
    if (seenIcons.has(value)) return;
    seenIcons.add(value);
    snapshot.icons.push({ icon: value, position: value.position });
  };
  const captureEdge = (edge) => {
    if (edge === null) return;
    captureLabel(edge.label);
    if (seenEdges.has(edge)) return;
    seenEdges.add(edge);
    snapshot.edgePercentages.push({ edge, percentage: edge.labelPercentage });
  };

  if (g !== null) {
    for (const node of g.nodes) {
      if (node === null) continue;
      captureLabel(node.label);
      captureIcon(node.icon);
    }
    for (const edge of g.edges) captureEdge(edge);
  }
  for (const edge of extraEdges ?? []) captureEdge(edge);
  return snapshot;
}

function restoreLabelPlacement(snapshot) {
  for (const state of snapshot.labels) state.label.position = state.position;
  for (const state of snapshot.icons) state.icon.position = state.position;
  for (const state of snapshot.edgePercentages) state.edge.labelPercentage = state.percentage;
}

function nodeOverlapCount(node, nodes, delta, guard) {
  let count = 0;
  for (const otherNode of nodes) {
    guard.step();
    if (node.labelBoxesOverlap(otherNode, delta)) count++;
  }
  return count;
}

function partialNodeOverlapCount(node, nodes, delta, guard) {
  let count = 0;
  for (const otherNode of nodes) {
    guard.step();
    if (node.labelBoxesOverlap(otherNode, delta) && !otherNode.covers(node)) count++;
  }
  return count;
}

/** Returns [area, count]. */
function nodeOverlapArea(node, nodes, delta, partial, guard) {
  let area = 0.0;
  let overlapCount = 0;
  for (const otherNode of nodes) {
    guard.step();
    if (!node.labelBoxesOverlap(otherNode, delta) || (partial && otherNode.covers(node))) continue;
    if (delta === 0 || node.doesOverlapExact(otherNode)) {
      area += node.labelOverlapArea(otherNode);
      overlapCount++;
    }
    if (!otherNode.isContainer()) {
      area += node.area();
      overlapCount++;
    }
  }
  return [area, overlapCount];
}

function edgeOverlapCount(node, edges, delta, guard) {
  let count = 0;
  for (const edge of edges) {
    guard.step();
    for (let pointIndex = 1; pointIndex < edge.points.length; pointIndex++) {
      guard.step();
      if (node.overlapsLine(edge.points[pointIndex - 1], edge.points[pointIndex], delta)) count++;
    }
  }
  return count;
}

function collectLabelPlacementAncestors(node, guard) {
  const ancestors = [];
  for (let current = node, depth = 0; current !== null; depth++) {
    if (depth >= maxLabelPlacementAncestryDepth) {
      throw errorf(`TALA ${guard.location} container depth exceeds limit ${maxLabelPlacementAncestryDepth}`);
    }
    guard.step();
    ancestors.push(current);
    current = lg.effectiveContainer(current);
  }
  return ancestors;
}

function isLabelPlacementDescendantOf(maybeDescendant, maybeAncestor, guard) {
  for (let depth = 0; ; depth++) {
    if (maybeAncestor === maybeDescendant) return true;
    if (maybeDescendant === null) return false;
    if (depth >= maxLabelPlacementAncestryDepth) {
      throw errorf(`TALA ${guard.location} ancestry depth exceeds limit ${maxLabelPlacementAncestryDepth}`);
    }
    guard.step();
    if (maybeDescendant.container !== null) {
      maybeDescendant = maybeDescendant.container;
    } else if (maybeDescendant.cluster !== null) {
      maybeDescendant = maybeDescendant.cluster.vessel;
    } else if (maybeDescendant.sequence !== null) {
      maybeDescendant = maybeDescendant.sequence.vessel;
    } else {
      maybeDescendant = null;
    }
  }
}

function clusterBoundaryNodePlacement(node, nodes, orientation, guard) {
  for (const other of nodes) {
    guard.step();
    if (other === node || other.topLeft === null) continue;
    switch (orientation) {
      case Orientation.Left:
        if (other.topLeft.x < node.topLeft.x) return false;
        break;
      case Orientation.Top:
        if (other.topLeft.y < node.topLeft.y) return false;
        break;
      case Orientation.Right:
        if (other.topLeft.x + other.width > node.topLeft.x + node.width) return false;
        break;
      case Orientation.Bottom:
        if (other.topLeft.y + other.height > node.topLeft.y + node.height) return false;
        break;
      default:
    }
  }
  return true;
}

/** Returns [tl, br]. */
function clusterNodeBoundingBoxPlacement(node, nodes, guard) {
  if (node === null || node.topLeft === null) throw errorf(`TALA ${guard.location} cluster contains an unplaced node`);
  guard.step();
  const tl = node.topLeft.copy();
  const br = geo.newPoint(goRound(tl.x + node.width), goRound(tl.y + node.height));
  const [dx, dy] = node.modifierElementAdjustments();
  if (dx !== 0 || dy !== 0) {
    tl.y -= dy;
    br.x += dx;
  }
  tl.x -= node.loopOffset(Orientation.Left);
  tl.y -= node.loopOffset(Orientation.Top);
  br.x += node.loopOffset(Orientation.Right);
  br.y += node.loopOffset(Orientation.Bottom);

  if (node.label !== null && label.isOutside(node.label.position)) {
    const labelTopLeft = node.labelTopLeft(node.label.position, node.label.width, node.label.height);
    const boundaryPadding = label.PADDING;
    const outsidePadding = 2. * label.PADDING;
    if (labelTopLeft.x < tl.x) {
      const boundary = clusterBoundaryNodePlacement(node, nodes, Orientation.Left, guard);
      let padding = outsidePadding;
      if (boundary) padding = boundaryPadding;
      tl.x = Math.floor(labelTopLeft.x - padding);
    }
    if (labelTopLeft.y < tl.y) {
      const boundary = clusterBoundaryNodePlacement(node, nodes, Orientation.Top, guard);
      let padding = outsidePadding;
      if (boundary) padding = boundaryPadding;
      tl.y = Math.floor(labelTopLeft.y - padding);
    }
    if (labelTopLeft.x > br.x) {
      const boundary = clusterBoundaryNodePlacement(node, nodes, Orientation.Right, guard);
      let padding = outsidePadding;
      if (boundary) padding = boundaryPadding;
      br.x = Math.ceil(labelTopLeft.x + node.label.width + padding);
    }
    if (labelTopLeft.y > br.y) {
      const boundary = clusterBoundaryNodePlacement(node, nodes, Orientation.Bottom, guard);
      let padding = outsidePadding;
      if (boundary) padding = boundaryPadding;
      br.y = Math.ceil(labelTopLeft.y + node.label.height + padding);
    }
  }
  if (node.icon !== null && !node.isImage() && label.isOutside(node.icon.position)) {
    const iconSize = lg.MaxIconSize;
    const iconTopLeft = node.labelTopLeft(node.icon.position, iconSize, iconSize);
    const outsidePadding = 2. * label.PADDING;
    tl.x = Math.min(tl.x, Math.floor(iconTopLeft.x - outsidePadding));
    tl.y = Math.min(tl.y, Math.floor(iconTopLeft.y - outsidePadding));
    br.x = Math.max(br.x, Math.ceil(iconTopLeft.x + iconSize + outsidePadding));
    br.y = Math.max(br.y, Math.ceil(iconTopLeft.y + iconSize + outsidePadding));
  }
  return [tl, br];
}

/** Returns [orientation, index]. */
function clusterLabelPlacementOrientation(node, member, cluster, guard) {
  let clusterTopLeft = geo.newPoint(-Infinity, -Infinity);
  let clusterBottomRight = geo.newPoint(Infinity, Infinity);
  if (cluster.nodes.length > 0) {
    clusterTopLeft = geo.newPoint(Infinity, Infinity);
    clusterBottomRight = geo.newPoint(-Infinity, -Infinity);
    for (const clusterNode of cluster.nodes) {
      const [topLeft, bottomRight] = clusterNodeBoundingBoxPlacement(clusterNode, cluster.nodes, guard);
      clusterTopLeft.x = Math.min(clusterTopLeft.x, topLeft.x);
      clusterTopLeft.y = Math.min(clusterTopLeft.y, topLeft.y);
      clusterBottomRight.x = Math.max(clusterBottomRight.x, bottomRight.x);
      clusterBottomRight.y = Math.max(clusterBottomRight.y, bottomRight.y);
    }
  }
  const shell = lg.newNode(0n, clusterBottomRight.x - clusterTopLeft.x, clusterBottomRight.y - clusterTopLeft.y);
  shell.topLeft = clusterTopLeft;
  const orientation = node.orientation(shell);
  let index = -1;
  for (let candidateIndex = 0; candidateIndex < cluster.nodes.length; candidateIndex++) {
    guard.step();
    if (cluster.nodes[candidateIndex] === member) {
      index = candidateIndex;
      break;
    }
  }
  return [orientation, index];
}

function routeLengthPlacement(edge, guard) {
  let length = 0.0;
  for (let index = 1; index < edge.points.length; index++) {
    guard.step();
    const previous = edge.points[index - 1];
    const current = edge.points[index];
    length += geo.euclideanDistance(previous.x, previous.y, current.x, current.y);
  }
  return length;
}

function edgeLabelTopLeft(edge, position, width, height, guard) {
  // d2's route label helper walks the route once for total length and once to locate the requested distance. Reserve both passes before
  // entering it, then check again at the boundary.
  for (let pass = 0; pass < 2; pass++) guard.add(edge.points.length);
  const point = edge.labelTopLeft(position, width, height);
  guard.check();
  return point;
}

function positionedArrowheadLabel(edge, isTarget, guard) {
  // Arrowhead placement computes route length directly, then the label helper performs its own length and distance passes.
  for (let pass = 0; pass < 3; pass++) guard.add(edge.points.length);
  const positioned = positionArrowheadLabel(edge, isTarget, edge.points);
  guard.check();
  return positioned;
}

function sortLabelPlacementEdges(edges, guard) {
  let items = new Array(edges.length);
  for (let index = 0; index < edges.length; index++) {
    const edge = edges[index];
    guard.step();
    const length = routeLengthPlacement(edge, guard);
    items[index] = { edge, length };
  }
  let buffer = new Array(items.length);
  const less = (left, right) => {
    if (right.edge.points.length === 2 && left.edge.points.length > 2) return true;
    if (left.edge.points.length === 2 && right.edge.points.length > 2) return false;
    return left.length < right.length;
  };
  for (let width = 1; width < items.length;) {
    for (let start = 0; start < items.length; start += 2 * width) {
      const middle = Math.min(start + width, items.length);
      const end = Math.min(start + 2 * width, items.length);
      let left = start, right = middle, output = start;
      while (left < middle && right < end) {
        guard.step();
        // Choose the left item for ties, matching sort.SliceStable.
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
  const sorted = new Array(items.length);
  for (let index = 0; index < items.length; index++) sorted[index] = items[index].edge;
  guard.check();
  return sorted;
}

function sortSharedSegmentGroup(segments, coordinate, checkWork) {
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
        if (checkWork !== null) checkWork();
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
        if (checkWork !== null) checkWork();
        buffer[output] = items[left];
        left++;
        output++;
      }
      while (right < end) {
        if (checkWork !== null) checkWork();
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

// ---- placement.go ----

function containersAt(g, root) {
  const children = g.containers.get(root);
  return children === undefined ? [] : children;
}

/** fakeNode builds a temporary `&layoutgraph.Node{Box: ..., D2ID: ..., Graph: g}` with a square shape. */
function fakeNode(topLeft, width, height, d2ID, g) {
  const n = new lg.Node();
  n.box = new geo.Box(topLeft, width, height);
  if (d2ID !== null) n.d2ID = d2ID;
  n.graph = g;
  n.setShape(shape.SQUARE_TYPE);
  return n;
}

/** Place chooses positions for every movable node label, icon, and routed edge label in graph. */
export function place(ctx, graph) {
  placeWithLimit(ctx, graph, maxLabelPlacementWorkUnits);
}

/**
 * place(ctx, g, workLimit) of the Go source: the work limit is a parameter so tests can exhaust it. Returns the work units used (a
 * thrown GoError carries them in `used`, 0 when the guard was never created: the harness's XPlaceLimit).
 */
export function placeWithLimit(ctx, g, workLimit) {
  const location = 'PlaceLabels';
  lg.validatePositionedGraphSelection(ctx, location, g, null);
  const snapshot = captureLabelPlacement(g, null);
  const holder = { guard: null };
  try {
    placeBody(ctx, g, workLimit, location, holder);
  } catch (e) {
    // a panic and an error both restore the labels, icons and percentages this pass owns
    restoreLabelPlacement(snapshot);
    if (e && e.name === 'GoError') e.used = holder.guard === null ? 0 : holder.guard.used;
    throw e;
  }
  return holder.guard.used;
}

function placeBody(ctx, g, workLimit, location, holder) {
  const guard = newLabelPlacementWorkGuard(ctx, location, workLimit);
  holder.guard = guard;
  const checkCanceled = () => guard.step();

  const placedFakeNodes = [];

  // add all arrowhead labels to placedFakeNodes
  for (const e of g.edges) {
    checkCanceled();
    if (e.sourceArrowheadLabel !== null) {
      const pal = positionedArrowheadLabel(e, false, guard);
      placedFakeNodes.push(fakeNode(pal.box.TopLeft, pal.box.Width, pal.box.Height, e.sourceArrowheadLabel.text, g));
    }
    if (e.targetArrowheadLabel !== null) {
      const pal = positionedArrowheadLabel(e, true, guard);
      placedFakeNodes.push(fakeNode(pal.box.TopLeft, pal.box.Width, pal.box.Height, e.targetArrowheadLabel.text, g));
    }
  }
  for (const e of g.edges) {
    checkCanceled();
    if (e.label !== null && (e.isLoop() || e.label.positionFixed())) {
      const topLeft = edgeLabelTopLeft(e, e.label.position, e.label.width, e.label.height, guard);
      placedFakeNodes.push(fakeNode(topLeft, e.label.width, e.label.height, e.label.text, g));
    }
  }

  // reposition node labels if label is on the same side as a used port or if there is an edge that passes nearby
  for (const node of g.nodes) {
    checkCanceled();
    const siblingsAndChildren = [];
    for (const n of containersAt(g, node.container)) {
      checkCanceled();
      if (n !== node) siblingsAndChildren.push(n);
    }
    if (node.isContainer()) {
      for (const child of containersAt(g, node)) {
        checkCanceled();
        siblingsAndChildren.push(child);
      }
    }

    const ancestors = collectLabelPlacementAncestors(node, guard);

    let bestIconPosition = label.Unset;
    let bestFakeNode = null;
    let bestScore = Infinity;
    if (node.icon !== null && !node.isImage()) {
      if (!node.icon.positionFixed()) {
        const iconPositions = labelPositionPreferences(node);
        for (const iconPosition of iconPositions) {
          checkCanceled();
          const iconSize = node.iconSize(iconPosition);
          const fakeIconNode = fakeNode(node.labelTopLeft(iconPosition, iconSize, iconSize), iconSize, iconSize, null, g);

          let nodeset = siblingsAndChildren;

          if (node.label !== null && node.label.positionFixed()) {
            const fixedLabelNode = fakeNode(
              node.labelTopLeft(node.label.position, node.label.width, node.label.height), node.label.width, node.label.height,
              node.label.text, g);
            nodeset = [...siblingsAndChildren, fixedLabelNode];
          }

          const nodeOverlaps = nodeOverlapCount(fakeIconNode, nodeset, 0, guard);
          const edgeOverlaps = edgeOverlapCount(fakeIconNode, g.edges, 0, guard);
          const labelOverlaps = nodeOverlapCount(fakeIconNode, placedFakeNodes, 0, guard);
          const score = scoreNodeLabelOverlaps(nodeOverlaps, edgeOverlaps, labelOverlaps);
          if (score < bestScore) {
            bestIconPosition = iconPosition;
            bestFakeNode = fakeIconNode;
            bestScore = score;
            if (score === 0) break;
          }
        }
      } else {
        const iconSize = node.iconSize(node.icon.position);
        const fakeIconNode = fakeNode(node.labelTopLeft(node.icon.position, iconSize, iconSize), iconSize, iconSize, null, g);
        bestFakeNode = fakeIconNode;
        bestIconPosition = node.icon.position;
      }
      checkCanceled();
      placedFakeNodes.push(bestFakeNode);
      node.icon.position = bestIconPosition;
    }

    if (node.label === null || node.label.positionFixed()) continue;

    if (node.icon !== null && !node.isImage()) {
      const iconSize = node.iconSize(node.icon.position);
      const fakeIconNode = fakeNode(node.labelTopLeft(node.icon.position, iconSize, iconSize), iconSize, iconSize, null, g);
      siblingsAndChildren.push(fakeIconNode);
    }

    bestScore = Infinity;
    let bestLabelPosition = label.Unset;
    const tranches = labelPositionPreferenceTranches(node);
    for (const tranch of tranches) {
      checkCanceled();
      // For each tranch, if there's multiple positions equally good, break ties with
      // slightly larger fake label box, so that the label goes on the side with the most empty space
      let tiedBest = [];
      let tiedBestFakeLabelNodes = [];
      for (const labelPosition of tranch) {
        checkCanceled();
        if (labelPosition === bestIconPosition) continue;
        const fakeLabelNode = fakeNode(
          node.labelTopLeft(labelPosition, node.label.width, node.label.height), node.label.width, node.label.height,
          node.label.text, g);
        // if an inside label escapes the node it is a bad placement
        if (!label.isOutside(labelPosition)) {
          // inside labels must fit inside node with label.PADDING on each side
          fakeLabelNode.padLabelCandidate(label.PADDING);
          if (!lg.labelBoxFits(node.innerBox(), fakeLabelNode.getBox())) continue;
          fakeLabelNode.padLabelCandidate(-label.PADDING);
        }

        // it must be label.PADDING-1 so that it does not overlap with edges at the node border
        //      │
        // ┌────▼─────┐
        // │  label   │
        // │          │
        // └──────────┘
        const siblingOverlaps = nodeOverlapCount(fakeLabelNode, siblingsAndChildren, label.PADDING, guard);
        const ancestorOverlaps = partialNodeOverlapCount(fakeLabelNode, ancestors, label.PADDING, guard);
        const edgeOverlaps = edgeOverlapCount(fakeLabelNode, g.edges, label.PADDING - 1, guard);
        const labelOverlaps = nodeOverlapCount(fakeLabelNode, placedFakeNodes, label.PADDING, guard);
        const score = scoreNodeLabelOverlaps(siblingOverlaps + ancestorOverlaps, edgeOverlaps, labelOverlaps);
        if (score < bestScore) {
          bestLabelPosition = labelPosition;
          bestFakeNode = fakeLabelNode;
          bestScore = score;
          if (label.isOutside(labelPosition) && label.isOutside(bestLabelPosition)) {
            tiedBest = [labelPosition];
            tiedBestFakeLabelNodes = [fakeLabelNode];
          } else {
            tiedBest = [];
            tiedBestFakeLabelNodes = [];
          }
        } else if (score === bestScore && compareLabelPositions(node, labelPosition, bestLabelPosition) === 0 &&
          label.isOutside(bestLabelPosition) && label.isOutside(labelPosition)) {
          tiedBest.push(labelPosition);
          tiedBestFakeLabelNodes.push(fakeLabelNode);
        }
      }
      if (tiedBest.length > 1) {
        let bestTiebreakScore = Infinity;
        let bestTieBreakLabelPosition = label.Unset;
        let bestTieBreakFakeNode = null;
        for (let i = 0; i < tiedBest.length; i++) {
          const labelPosition = tiedBest[i];
          checkCanceled();
          const tiebreakFakeLabelNode = fakeNode(
            node.labelTopLeft(labelPosition, node.label.width * 2, node.label.height * 2), node.label.width * 2, node.label.height * 2,
            node.label.text, g);
          // if an inside label escapes the node it is a bad placement
          if (!label.isOutside(labelPosition)) {
            // inside labels must fit inside node with label.PADDING on each side
            tiebreakFakeLabelNode.padLabelCandidate(label.PADDING);
            if (!lg.labelBoxFits(node.innerBox(), tiebreakFakeLabelNode.getBox())) continue;
            tiebreakFakeLabelNode.padLabelCandidate(-label.PADDING);
          }

          const siblingOverlaps = nodeOverlapCount(tiebreakFakeLabelNode, siblingsAndChildren, label.PADDING, guard);
          const ancestorOverlaps = partialNodeOverlapCount(tiebreakFakeLabelNode, ancestors, label.PADDING, guard);
          const edgeOverlaps = edgeOverlapCount(tiebreakFakeLabelNode, g.edges, label.PADDING - 1, guard);
          const labelOverlaps = nodeOverlapCount(tiebreakFakeLabelNode, placedFakeNodes, label.PADDING, guard);
          const score = scoreNodeLabelOverlaps(siblingOverlaps + ancestorOverlaps, edgeOverlaps, labelOverlaps);
          if (score < bestTiebreakScore) {
            bestTiebreakScore = score;
            bestTieBreakLabelPosition = labelPosition;
            bestTieBreakFakeNode = tiedBestFakeLabelNodes[i];
          }
        }
        bestLabelPosition = bestTieBreakLabelPosition;
        bestFakeNode = bestTieBreakFakeNode;
      }
    }
    checkCanceled();
    placedFakeNodes.push(bestFakeNode);

    node.label.position = bestLabelPosition;
  }

  // we want to find the best edge label position, avoiding overlapping with other nodes, edges, labels and shared edge segments
  // create fake nodes around shared segments to avoid having labels placed in these positions
  const sharedSegments = findSharedSegmentsChecked(g.edges, checkCanceled);
  const sharedSegmentFakeNodes = sharedSegmentNodes(sharedSegments, g, checkCanceled);

  let sortedEdges = [];
  for (const e of g.edges) {
    checkCanceled();
    if (e.label === null || e.isLoop() || e.label.positionFixed()) continue;
    sortedEdges.push(e);
  }

  sortedEdges = sortLabelPlacementEdges(sortedEdges, guard);

  for (const edge of sortedEdges) {
    checkCanceled();
    const [fakeNodeValue, position, percentage] = findBestEdgeLabelPosition(edge, g, placedFakeNodes, sharedSegmentFakeNodes, guard);
    placedFakeNodes.push(fakeNodeValue);
    edge.label.position = position;
    edge.labelPercentage = percentage;
  }

  guard.check();
}

/** the "create fake nodes around shared segments" loop shared by Place and PlaceNewEdges */
function sharedSegmentNodes(sharedSegments, g, checkCanceled) {
  const sharedSegmentFakeNodes = [];
  for (let i = 0; i < sharedSegments.length; i++) {
    const seg = sharedSegments[i];
    checkCanceled();
    const tl = seg.Start.copy();
    let width = seg.End.x - seg.Start.x;
    let height = seg.End.y - seg.Start.y;
    // generate a box around the shared segments
    // │  │  │
    // shared│
    // segment
    // │  │  │
    // │  │  │
    // │  │  │
    // │  │  │
    // └──┴──┘
    // |-----| fake box
    // |--| SharedSegmentClearance
    if (seg.End.x === seg.Start.x) {
      // vertical
      width = 2 * SharedSegmentClearance;
      tl.x -= SharedSegmentClearance;
    } else {
      // horizontal
      height = 2 * SharedSegmentClearance;
      tl.y -= SharedSegmentClearance;
    }
    sharedSegmentFakeNodes.push(fakeNode(tl, width, height, `fake_shared_segment_${i}`, g));
  }
  return sharedSegmentFakeNodes;
}

/** PlaceNewEdges chooses label positions only for edges, preserving all existing label placements in graph as obstacles. */
export function placeNewEdges(ctx, graph, edges) {
  placeNewEdgesWithLimit(ctx, graph, edges, maxLabelPlacementWorkUnits);
}

/** PlaceNewEdges with a chosen work limit; returns the work units used (see placeWithLimit). */
export function placeNewEdgesWithLimit(ctx, g, edges, workLimit) {
  const location = 'PlaceNewEdgeLabels';
  lg.validatePositionedGraphSelection(ctx, location, g, edges);
  const snapshot = captureLabelPlacement(g, edges);
  const holder = { guard: null };
  try {
    placeNewEdgesBody(ctx, g, edges, workLimit, location, holder);
  } catch (e) {
    restoreLabelPlacement(snapshot);
    if (e && e.name === 'GoError') e.used = holder.guard === null ? 0 : holder.guard.used;
    throw e;
  }
  return holder.guard.used;
}

function placeNewEdgesBody(ctx, g, edges, workLimit, location, holder) {
  const guard = newLabelPlacementWorkGuard(ctx, location, workLimit);
  holder.guard = guard;
  const checkCanceled = () => guard.step();

  const placedFakeNodes = [];

  const newEdges = new Set();
  for (const e of edges) {
    checkCanceled();
    newEdges.add(e);
  }

  // Reserve existing and caller-fixed edge labels, plus all arrowhead labels.
  for (const e of g.edges) {
    checkCanceled();
    if (e.sourceArrowheadLabel !== null) {
      const pal = positionedArrowheadLabel(e, false, guard);
      placedFakeNodes.push(fakeNode(pal.box.TopLeft, pal.box.Width, pal.box.Height, e.sourceArrowheadLabel.text, g));
    }
    if (e.targetArrowheadLabel !== null) {
      const pal = positionedArrowheadLabel(e, true, guard);
      placedFakeNodes.push(fakeNode(pal.box.TopLeft, pal.box.Width, pal.box.Height, e.targetArrowheadLabel.text, g));
    }

    if (e.label === null || e.isLoop()) continue;
    if (newEdges.has(e) && !e.label.positionFixed()) continue;

    const topLeft = edgeLabelTopLeft(e, e.label.position, e.label.width, e.label.height, guard);
    placedFakeNodes.push(fakeNode(topLeft, e.label.width, e.label.height, e.label.text, g));
  }

  for (const e of g.edges) {
    checkCanceled();
    if (e.isLoop() && e.label !== null) {
      const topLeft = edgeLabelTopLeft(e, e.label.position, e.label.width, e.label.height, guard);
      placedFakeNodes.push(fakeNode(topLeft, e.label.width, e.label.height, e.label.text, g));
    }
  }

  // reposition node labels if label is on the same side as a used port or if there is an edge that passes nearby
  for (const node of g.nodes) {
    checkCanceled();
    if (node.icon !== null && !node.isImage()) {
      const iconSize = node.iconSize(node.icon.position);
      placedFakeNodes.push(fakeNode(node.labelTopLeft(node.icon.position, iconSize, iconSize), iconSize, iconSize, null, g));
    }

    if (node.label === null || node.label.positionFixed()) continue;

    placedFakeNodes.push(fakeNode(
      node.labelTopLeft(node.label.position, node.label.width, node.label.height), node.label.width, node.label.height,
      node.label.text, g));
  }

  // we want to find the best edge label position, avoiding overlapping with other nodes, edges, labels and shared edge segments
  // create fake nodes around shared segments to avoid having labels placed in these positions
  const sharedSegments = findSharedSegmentsChecked(g.edges, checkCanceled);
  const sharedSegmentFakeNodes = sharedSegmentNodes(sharedSegments, g, checkCanceled);

  let sortedEdges = [];
  for (const e of edges) {
    checkCanceled();
    if (e.label === null || e.isLoop() || e.label.positionFixed()) continue;
    sortedEdges.push(e);
  }

  sortedEdges = sortLabelPlacementEdges(sortedEdges, guard);

  for (const edge of sortedEdges) {
    checkCanceled();
    const [fakeNodeValue, position, percentage] = findBestEdgeLabelPosition(edge, g, placedFakeNodes, sharedSegmentFakeNodes, guard);
    placedFakeNodes.push(fakeNodeValue);
    edge.label.position = position;
    edge.labelPercentage = percentage;
  }
  guard.check();
}

/** Returns [fakeNode, position, percentage]. */
function findBestEdgeLabelPosition(edge, g, placedFakeNodes, sharedSegmentFakeNodes, guard) {
  // we don't want to count the edge itself as overlapping, we already prefer outside labels
  const otherEdges = [];
  for (const otherEdge of g.edges) {
    guard.step();
    if (otherEdge === edge) continue;
    otherEdges.push(otherEdge);
  }

  const positions = [];
  if (label.isUnlocked(edge.label.position)) {
    // prefer the unlocked positions before trying other positions
    if (edge.label.position === label.UnlockedMiddle) {
      positions.push(label.UnlockedMiddle);
      positions.push(label.UnlockedTop);
      positions.push(label.UnlockedBottom);
    } else {
      positions.push(edge.label.position);
      positions.push(label.mirrored(edge.label.position));
      positions.push(label.UnlockedMiddle);
    }
    for (const p of edgeLabelPreferenceOrder) positions.push(p);
  } else if (edge.isClusterEdge()) {
    const pathShared = isClusterPathSharedChecked(edge, () => guard.step());
    if (!pathShared) {
      for (const p of edgeLabelPreferenceOrder) positions.push(p);
      positions.push(label.UnlockedTop);
      positions.push(label.UnlockedBottom);
      positions.push(label.UnlockedMiddle);
    } else {
      // Give preference for symmetrical placements for clustered nodes
      // .         label     ┌──────────┐
      // .        ┌──────────┤          │
      // .        │          │          │
      // .        │          └──────────┘
      // . ───────┤
      // .        │          ┌──────────┐
      // .        │          │          │
      // .        └──────────┤          │
      // .          label    └──────────┘
      if (edge.from.cluster !== null) {
        const [orientation, clusterIndex] = clusterLabelPlacementOrientation(edge.to, edge.from, edge.from.cluster, guard);
        switch (orientation) {
          case Orientation.Right:
          case Orientation.Top:
            if (clusterIndex < (edge.from.cluster.nodes.length - 1) / 2.) {
              positions.push(label.UnlockedTop);
            } else if (clusterIndex > (edge.from.cluster.nodes.length - 1) / 2.) {
              positions.push(label.UnlockedBottom);
            }
            break;
          case Orientation.Left:
          case Orientation.Bottom:
            if (clusterIndex < (edge.from.cluster.nodes.length - 1) / 2.) {
              positions.push(label.UnlockedBottom);
            } else if (clusterIndex > (edge.from.cluster.nodes.length - 1) / 2.) {
              positions.push(label.UnlockedTop);
            }
            break;
          default:
        }
      } else {
        const [orientation, clusterIndex] = clusterLabelPlacementOrientation(edge.from, edge.to, edge.to.cluster, guard);
        switch (orientation) {
          case Orientation.Left:
          case Orientation.Bottom:
            if (clusterIndex < (edge.to.cluster.nodes.length - 1) / 2.) {
              positions.push(label.UnlockedTop);
            } else if (clusterIndex > (edge.to.cluster.nodes.length - 1) / 2.) {
              positions.push(label.UnlockedBottom);
            }
            break;
          case Orientation.Right:
          case Orientation.Top:
            if (clusterIndex < (edge.to.cluster.nodes.length - 1) / 2.) {
              positions.push(label.UnlockedBottom);
            } else if (clusterIndex > (edge.to.cluster.nodes.length - 1) / 2.) {
              positions.push(label.UnlockedTop);
            }
            break;
          default:
        }
      }
      positions.push(label.UnlockedMiddle);
      for (const p of edgeLabelPreferenceOrder) positions.push(p);
    }
  } else {
    for (const p of edgeLabelPreferenceOrder) positions.push(p);
    positions.push(label.UnlockedTop);
    positions.push(label.UnlockedBottom);
    positions.push(label.UnlockedMiddle);
  }

  const ancestors = [], nonAncestors = [];
  for (const n of g.nodes) {
    guard.step();
    const fromDescendant = isLabelPlacementDescendantOf(edge.from, n, guard);
    const toDescendant = isLabelPlacementDescendantOf(edge.to, n, guard);
    if (n !== edge.from && n !== edge.to && (fromDescendant || toDescendant)) ancestors.push(n);
    else nonAncestors.push(n);
  }

  let bestLabelPosition = label.Unset;
  let bestLabelPercentage = 0;
  let bestLabelFakeNode = null;
  let bestScore = Infinity;

  const checkPosition = (labelPosition) => {
    guard.step();
    const topLeft = edgeLabelTopLeft(edge, labelPosition, edge.label.width, edge.label.height, guard);
    const fakeLabelNode = fakeNode(topLeft, edge.label.width, edge.label.height, edge.label.text, g);

    let edges = g.edges;
    if (label.isOnEdge(labelPosition)) edges = otherEdges;

    // Especially don't want labels of a cluster edge path intersecting other cluster edge paths
    // So count the other cluster edges as double
    if (edge.from.cluster !== null) {
      edges = edges.slice();
      for (const otherEdge of otherEdges) {
        guard.step();
        if (otherEdge.from.cluster === edge.from.cluster) edges.push(otherEdge);
      }
    } else if (edge.to.cluster !== null) {
      edges = edges.slice();
      for (const otherEdge of otherEdges) {
        guard.step();
        if (otherEdge.to.cluster === edge.to.cluster) edges.push(otherEdge);
      }
    }

    // it only counts as overlapping an ancestor if it is partially overlapping
    const [ancestorPartialOverlapArea, ancestorCount] = nodeOverlapArea(fakeLabelNode, ancestors, label.PADDING, true, guard);
    const [nonAncestorOverlapArea, nonAncestorCount] = nodeOverlapArea(fakeLabelNode, nonAncestors, label.PADDING, false, guard);
    const edgePaddingOverlaps = edgeOverlapCount(fakeLabelNode, edges, label.PADDING, guard);
    const edgeExactOverlaps = edgeOverlapCount(fakeLabelNode, edges, 0, guard);
    const edgeOverlaps = edgePaddingOverlaps + Math.trunc(Math.ceil(edgeExactOverlaps * 0.5));
    const almostLabelPaddingOverlaps = nodeOverlapCount(fakeLabelNode, placedFakeNodes, label.PADDING, guard);
    const almostLabelExactOverlaps = nodeOverlapCount(fakeLabelNode, placedFakeNodes, 0, guard);
    const almostLabelOverlaps = almostLabelPaddingOverlaps + Math.trunc(Math.ceil(almostLabelExactOverlaps * 0.5));
    const labelOverlaps = nodeOverlapCount(fakeLabelNode, placedFakeNodes, 0, guard);
    const sharedSegmentOverlap = nodeOverlapCount(fakeLabelNode, sharedSegmentFakeNodes, label.PADDING, guard);
    const score = scoreEdgeLabelOverlaps(
      fakeLabelNode.area(),
      ancestorPartialOverlapArea + nonAncestorOverlapArea,
      ancestorCount + nonAncestorCount,
      edgeOverlaps,
      almostLabelOverlaps,
      labelOverlaps,
      sharedSegmentOverlap,
    );
    if (score < bestScore) {
      bestLabelPosition = labelPosition;
      bestLabelFakeNode = fakeLabelNode;
      bestLabelPercentage = edge.labelPercentage;
      bestScore = score;
    }
  };

  let routeLength = 0.0;
  let routeLengthCalculated = false;
  // pick the label position based on how many nodes, edges and already placed labels overlap
  for (const labelPosition of positions) {
    guard.step();
    if (bestScore === 0) break;
    if (label.isUnlocked(labelPosition)) {
      if (edge.labelPercentage !== 0) {
        // if label percentage was set on the edge during layout, use it
        checkPosition(labelPosition);
      } else {
        if (!routeLengthCalculated) {
          routeLength = routeLengthPlacement(edge, guard);
          routeLengthCalculated = true;
        }
        const r = labelPercentageSearchRange(edge, routeLength);
        for (let i = r.start; i < r.end; i += placementSearchInterval) {
          guard.step();
          edge.labelPercentage = i;
          checkPosition(labelPosition);
          if (bestScore === 0) break;
        }
        edge.labelPercentage = 0;
      }
    } else {
      checkPosition(labelPosition);
    }
  }

  guard.check();
  return [bestLabelFakeNode, bestLabelPosition, bestLabelPercentage];
}

export function labelPercentageSearchRange(edge, length) {
  const halfHeight = edge.label.height / 2.;
  const halfWidth = edge.label.width / 2.;
  if (edge.from.cluster !== null) {
    // if the edge is coming from a cluster node
    // use only the first segment extension to find the placement
    // .          range.end    range.start
    // .               ├──────────┤
    // .                          ┌──────────┐
    // .               ┌──────────┤          │
    // .               │          │          │
    // . ┌─────┐       │          └──────────┘
    // . │     ◄───────┤
    // . │     │       │          ┌──────────┐
    // . └─────┘       │          │          │
    // .               └──────────┤          │
    // .                          └──────────┘
    const p1 = edge.points[0];
    const p2 = edge.points[1];
    if (p1.x === p2.x && Math.abs(p1.y - p2.y) > halfHeight) {
      const end = (Math.abs(p1.y - p2.y) - halfHeight) / length;
      return { start: 0, end: Math.min(1, end) };
    } else if (Math.abs(p1.x - p2.x) > halfWidth) {
      const end = (Math.abs(p1.x - p2.x) - halfWidth) / length;
      return { start: 0, end: Math.min(1, end) };
    }
  } else if (edge.to.cluster !== null) {
    // if the edge is going to a cluster node
    // use only the last segment extension to find the placement
    // .        range.start    range.end
    // .               ├──────────┤
    // .                          ┌──────────┐
    // .               ┌──────────►          │
    // .               │          │          │
    // . ┌─────┐       │          └──────────┘
    // . │     ├───────┤
    // . │     │       │          ┌──────────┐
    // . └─────┘       │          │          │
    // .               └──────────►          │
    // .                          └──────────┘
    const p1 = edge.points[edge.points.length - 1];
    const p2 = edge.points[edge.points.length - 2];
    if (p1.x === p2.x && Math.abs(p1.y - p2.y) > halfHeight) {
      const start = (length - Math.abs(p1.y - p2.y) + halfHeight) / length;
      return { start: Math.max(0, start), end: 1 };
    } else if (Math.abs(p1.x - p2.x) > halfWidth) {
      const start = (length - Math.abs(p1.x - p2.x) + halfWidth) / length;
      return { start: Math.max(0, start), end: 1 };
    }
  }
  return { start: 0, end: 1 };
}

/**
 * findSharedSegmentsChecked finds the longest shared vertical/horizontal segments
 * Below is an example for horizontal segments, but the same applies for vertical ones
 * Note that the segments are shown in different rows to make it easier to understand (in reality, they must be on the same Y)
 * Input segments:
 * .                                         ───────────
 * .      ───────                      ─────────
 * . ──────       ────────  ──────   ─────
 * . Result:
 * .      ─                            ─────────
 * just the small             shared segment among the 3 segments above
 * shared segment
 *
 * (Go ranges over maps keyed by the segment's coordinate here: the order of the groups only orders the result, which callers use as
 * a set; the JS Map iterates in insertion order.)
 */
export function findSharedSegmentsChecked(edges, checkCanceled) {
  if (checkCanceled !== null) checkCanceled();
  const verticalSegments = new Map();
  const horizontalSegments = new Map();

  // group vertical/horizontal segments by Y/X
  for (const edge of edges) {
    if (checkCanceled !== null) checkCanceled();
    for (let i = 0; i < edge.points.length - 1; i++) {
      if (checkCanceled !== null) checkCanceled();
      const segment = geo.newSegment(edge.points[i].copy(), edge.points[i + 1].copy());
      if (segment.Start.x === segment.End.x && segment.Start.y === segment.End.y) continue;
      if (segment.Start.x === segment.End.x) {
        if (segment.End.y < segment.Start.y) {
          // swap so segments are always top to bottom
          [segment.End.y, segment.Start.y] = [segment.Start.y, segment.End.y];
        }
        if (!verticalSegments.has(segment.Start.x)) verticalSegments.set(segment.Start.x, []);
        verticalSegments.get(segment.Start.x).push(segment);
      } else if (segment.Start.y === segment.End.y) {
        if (segment.End.x < segment.Start.x) {
          // swap so segments are always left to right
          [segment.End.x, segment.Start.x] = [segment.Start.x, segment.End.x];
        }
        if (!horizontalSegments.has(segment.Start.y)) horizontalSegments.set(segment.Start.y, []);
        horizontalSegments.get(segment.Start.y).push(segment);
      }
    }
  }

  const sharedSegments = [];
  const addSharedSegments = (segmentsByCoord, isHorizontalSegment) => {
    const coordinate = (p) => (isHorizontalSegment ? p.x : p.y);
    const setCoordinate = (p, v) => {
      if (isHorizontalSegment) p.x = v;
      else p.y = v;
    };

    for (const segments of segmentsByCoord.values()) {
      if (checkCanceled !== null) checkCanceled();
      if (segments.length === 1) continue;
      // Sort segments from starting positions (assumes segments are top to
      // bottom and left to right). The merge sort can stop between every
      // comparison; sort.Slice cannot propagate cancellation.
      sortSharedSegmentGroup(segments, coordinate, checkCanceled);

      let prev = segments[0];
      let shared = null;
      for (let i = 1; i < segments.length; i++) {
        if (checkCanceled !== null) checkCanceled();
        const curr = segments[i];
        // segments overlap
        if (coordinate(prev.End) > coordinate(curr.Start)) {
          // A long trunk can contain disjoint shared intervals.
          // Keep its exclusive label corridor between them available.
          if (shared !== null && coordinate(curr.Start) > coordinate(shared.End)) {
            sharedSegments.push(shared);
            shared = null;
          }
          if (shared === null) {
            shared = geo.newSegment(curr.Start.copy(), curr.Start.copy());
            // update the appropriate coordinate
            // curr  :   ─────────
            // prev  : ─────
            // shared:   ───
            setCoordinate(shared.End, Math.min(coordinate(prev.End), coordinate(curr.End)));
          } else {
            // extend the current ongoing overlap
            // shared before: ───
            // prev         : ─────────
            // curr         :         ───────────
            // shared now   : ─────────
            const minOverlap = Math.min(coordinate(prev.End), coordinate(curr.End));
            setCoordinate(shared.End, Math.max(coordinate(shared.End), minOverlap));
          }
        } else if (shared !== null) {
          // there's no need to extend the segment, so close it
          sharedSegments.push(shared);
          shared = null;
        }
        // keep prev as the longest segment
        if (coordinate(curr.End) > coordinate(prev.End)) prev = curr;
      }
      if (shared !== null) {
        // just in case the last segment had an overlap
        sharedSegments.push(shared);
      }
    }
  };

  addSharedSegments(verticalSegments, false);
  addSharedSegments(horizontalSegments, true);

  return sharedSegments;
}

function scoreEdgeLabelOverlaps(
  labelArea, nodeOverlapArea_,
  nodeOverlapCount_, edgeOverlapCount_,
  almostLabelOverlapCount, labelOverlapCount, sharedSegmentOverlapCount,
) {
  let score = (nodeOverlapArea_ / labelArea) * 2.;
  // avoid as much as possible overlapping with other labels
  score += labelOverlapCount * 10;
  score += almostLabelOverlapCount;
  // overlapping with other edges is worse than placing the label on a shared segment
  score += nodeOverlapCount_ * 2;
  score += edgeOverlapCount_ * 2;
  score += sharedSegmentOverlapCount;
  return score;
}

/** scoreNodeLabelOverlaps ranks a node-label candidate. A label-label overlap is deliberately twice as costly as a node or edge overlap. */
function scoreNodeLabelOverlaps(nodeOverlapCount_, edgeOverlapCount_, labelOverlapCount) {
  return nodeOverlapCount_ + edgeOverlapCount_ + 2 * labelOverlapCount;
}

/** isClusterPathSharedChecked checks if a given cluster edge has a shared path with the other cluster edges. */
export function isClusterPathSharedChecked(e, checkWork) {
  if (checkWork !== null) checkWork();
  let clusterNodes;
  let adjacentNode;
  let fromCluster = false;
  if (e.from.cluster !== null) {
    clusterNodes = e.from.cluster.nodes;
    adjacentNode = e.to;
    fromCluster = true;
  } else if (e.to.cluster !== null) {
    clusterNodes = e.to.cluster.nodes;
    adjacentNode = e.from;
  } else {
    return false;
  }

  let p1, p2;
  if (fromCluster) {
    // if the edge is coming from a cluster, only the last segment can be shared
    p1 = e.points[e.points.length - 1];
    p2 = e.points[e.points.length - 2];
  } else {
    // if the edge is going to a cluster, only the first segment can be shared
    p1 = e.points[0];
    p2 = e.points[1];
  }
  for (const n of clusterNodes) {
    if (checkWork !== null) checkWork();
    for (const ce of n.edges) {
      if (checkWork !== null) checkWork();
      if (ce === e) continue;
      if (n.adjacent(ce) !== adjacentNode) {
        // only checks edges to the same connected node
        continue;
      }
      let op1, op2;
      if (fromCluster) {
        op1 = ce.points[ce.points.length - 1];
        op2 = ce.points[ce.points.length - 2];
      } else {
        op1 = ce.points[0];
        op2 = ce.points[1];
      }
      if (p1.x === p2.x && op1.x === op2.x && p1.x === op1.x) {
        // both vertical and at same X
        if (Math.max(p1.y, p2.y) >= Math.min(op1.y, op2.y) &&
          Math.max(op1.y, op2.y) >= Math.min(p1.y, p2.y)) {
          // The closed intervals overlap.
          return true;
        }
      } else if (p1.y === p2.y && op1.y === op2.y && p1.y === op1.y) {
        // both horizontal and at same Y
        if (Math.max(p1.x, p2.x) >= Math.min(op1.x, op2.x) &&
          Math.max(op1.x, op2.x) >= Math.min(p1.x, p2.x)) {
          // The closed intervals overlap.
          return true;
        }
      }
    }
  }

  return false;
}
