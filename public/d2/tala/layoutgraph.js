// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of the Go package d2layouts/d2talalayout/internal/layoutgraph (D2 v0.9.0, github.com/d2lang/d2, Copyright 2022
// Terrastruct Inc.): TALA's mutable layout graph (Graph, Node, Edge), the grouping records (Cluster, Sequence, Tree, Hierarchy,
// HerdAssignment), the topology mutations and their transactions, Clone, the validation preflights and the shared geometry.
// Every other TALA package reads and writes this state, so read this header before using it.
//
// CONVENTIONS (the whole TALA port follows them; docs/d2-tala-port.md has the rest)
//  - Go names are camelCase: Node.TopLeft -> node.topLeft, Node.D2ID -> node.d2ID, Edge.ID -> edge.id, Graph.Nodes -> graph.nodes.
//    When a Go type has an exported and an unexported member whose names differ only in the case of the first letter (the
//    exported wrappers of the *_access.go files, `Container` field vs `container()` method, `isContainer` field vs `IsContainer()`
//    method, ...), the exported one keeps the plain camelCase name and the UNEXPORTED twin gets a trailing underscore:
//    node.container is the Container field, node.container_() the container() method; node.isContainer() is the exported method,
//    node.isContainer_ the unexported field. Check the list in docs/d2-tala-port.md before adding a member.
//  - Go's embedded geo.Box in Node is `node.box` (a geo.Box with TopLeft/Width/Height, shared with the node's shape, like Go's &n.Box);
//    node.topLeft, node.width, node.height read and write it. The embedded nodeshape.Shape interface is node.shape, and its methods
//    are forwarded (node.portIndices(o), node.snapPointPercentages(), node.getInnerBox(), ...).
//  - EntityID (int64) is a BigInt everywhere (vessel and sequence IDs are random 63-bit values). Compare with < and ===,
//    never mix with numbers. Node.ID of a nil container is 0n.
//  - Pointers are references (null = nil): `node.topLeft` is shared by every holder, so Go value copies (`tl := *node.TopLeft`) are
//    written `.copy()`. Go slices are arrays (nil and empty slices are not distinguished unless the Go code does; a nil slice is [] or
//    null where the Go code tests `== nil`). map[*Node]T is Map, map[*Node]struct{} is Set (insertion order; Go's order is random,
//    so wherever Go code ranges over a map and the order matters the Go code sorts), map[geo.Point]T is PointMap.
//  - Errors are thrown (goerrors.js): a Go function returning (T, error) returns T and throws a GoError. Panics throw GoPanic.
//  - context.Context is context.js; guards are limits.js WorkGuard (workStepper = any object with step() and finish()).
//  - `Nodes` and `Edges` (Go slice types with methods) are the namespaces `Nodes.*` and `Edges.*` taking an array first.

import * as geo from '../geo.js';
import * as label from '../label.js';
import * as shape from '../shape.js';
import { goInt, goRound, goV } from '../gomath.js';
import * as invariant from './invariant.js';
import * as limits from './limits.js';
import { GoError, errorf, errorsNew, errorsIs, GoPanic, isPanic } from './goerrors.js';
import * as nodeshape from './nodeshape.js';
import { newPool } from './typedpool.js';
import { withValue } from './context.js';
import * as labelgeom from './labelgeom.js';
import { sortSlice } from '../gosort.js';

const { Orientation } = geo;

// ---- geometry_policy.go ----

export const AxisAlignmentTolerance = 1.0;
export const NodeGap = 20;
export const ConnectedNodeGap = 60;
export const TableNodeGap = 2 * ConnectedNodeGap;
export const ContainerPadding = 60;
export const MaxIconSize = 64;
export const MinArrowheadClearance = 20.0;
export const MinPortClearance = 20.0;
export const MinRouteNodeClearance = 20.0;
export const TreeParentSpacing = 100.0;
export const CrossingCostWeight = 0.48 * 0.48 * 0.48;

// ---- graph.go / node.go / edge.go constants ----

const minCellSize = 10.0;
const turnPenaltyMultiplier = 0.125;
// Keep the exact value because center-port route scoring is output-sensitive.
const centerPortMultiplier = 0.04287499999999999;
const defaultIconSize = 32.0;
const threeDOffset = 15.0;
const multipleOffset = 10.0;
const edgeStrokeWidth = 3.0;
const MIN_INT = -9223372036854775808; // math.MinInt
const MAX_INT = 9223372036854775807; // math.MaxInt (as a double: only used as a "larger than any level" bound)

// ---- work.go ----

const maxEngineNodes = limits.MaxEngineNodes;
const maxEngineEdges = limits.MaxEngineEdges;
const maxEngineWorkUnits = limits.MaxEngineWorkUnits;
const maxTransactionWorkUnits = limits.MaxTransactionWorkUnits;
const maxTransactionOverlapReferences = limits.MaxTransactionOverlapReferences;
const maxBinPackWorkUnits = limits.MaxBinPackWorkUnits;
const maxGraphSize = limits.MaxGraphSize;
const maxCompactionCandidateCount = limits.MaxGraphSize + 3;

/** workStepper with no accounting. */
const unboundedWork = { step() {}, finish() {} };

// ---- shape.go ----

const stepType = nodeshape.Step;
const circleType = nodeshape.Circle;
const hexagonType = nodeshape.Hexagon;
const tableType = nodeshape.Table;
const classType = nodeshape.Class;
const textType = nodeshape.Text;
const codeType = nodeshape.Code;
const imageType = nodeshape.Image;

// ---- errors.go ----

/** ErrInvalidCandidate rejects a speculative layout candidate whose geometry cannot be committed. */
export const ErrInvalidCandidate = errorsNew('invalid layout candidate');
/** ErrNonImprovingCandidate rejects a valid candidate that does not improve the current layout. */
export const ErrNonImprovingCandidate = errorsNew('layout candidate did not improve');

/** IsCandidateRejection reports whether err rejects only the current speculative candidate. Callers must propagate every other error. */
export function isCandidateRejection(err) {
  return errorsIs(err, ErrInvalidCandidate) || errorsIs(err, ErrNonImprovingCandidate);
}

// ---- geometry.go ----

/** nonNilEquals compares two optional points by value. */
function nonNilEquals(first, second) {
  return first != null && second != null && first.x === second.x && first.y === second.y;
}

/** The canonical map key of a geo.Point (Go: a map[geo.Point]T key compares x and y as floats). */
const pointKey = (p) => `${p.x},${p.y}`;

/**
 * map[geo.Point]V. Keys are point values (x, y); entries iterate in insertion order (Go's order is random). The stored key is a copy.
 */
export class PointMap {
  constructor() {
    this.m = new Map();
  }

  get size() {
    return this.m.size;
  }

  set(p, v) {
    const k = pointKey(p);
    const e = this.m.get(k);
    if (e) e[1] = v;
    else this.m.set(k, [new geo.Point(p.x, p.y), v]);
    return this;
  }

  get(p) {
    const e = this.m.get(pointKey(p));
    return e === undefined ? undefined : e[1];
  }

  has(p) {
    return this.m.has(pointKey(p));
  }

  delete(p) {
    return this.m.delete(pointKey(p));
  }

  clear() {
    this.m.clear();
  }

  /** [point, value] pairs (the points are the map's own copies: do not mutate). */
  entries() {
    return this.m.values();
  }

  keys() {
    return [...this.m.values()].map((e) => e[0]);
  }

  values() {
    return [...this.m.values()].map((e) => e[1]);
  }
}

// ---- value types ----

/** Spacing is four floats (unexported fields in Go: top, bottom, left, right); a zero value is `new Spacing()`. */
export class Spacing {
  constructor(top = 0, bottom = 0, left = 0, right = 0) {
    this.top = top;
    this.bottom = bottom;
    this.left = left;
    this.right = right;
  }

  copy() {
    return new Spacing(this.top, this.bottom, this.left, this.right);
  }

  isZero() {
    return this.top === 0 && this.bottom === 0 && this.left === 0 && this.right === 0;
  }
}

/** UniformSpacing */
export const uniformSpacing = (value) => new Spacing(value, value, value, value);

/** Label is the label state attached to a layout node or edge. */
export class Label {
  constructor(text = '', position = label.Unset, width = 0, height = 0) {
    this.text = text;
    this.position = position;
    this.width = width;
    this.height = height;
    this.positionFixed_ = false;
  }

  /** PositionFixed reports whether Position was supplied by the caller and must be preserved by automatic label placement. */
  positionFixed() {
    return this.positionFixed_;
  }

  /** FixPosition marks Position as supplied by the caller. */
  fixPosition() {
    this.positionFixed_ = true;
  }
}

/** Icon is the icon-placement state attached to a layout node. */
export class Icon {
  constructor() {
    this.position = label.Unset;
    this.positionFixed_ = false;
  }

  positionFixed() {
    return this.positionFixed_;
  }

  fixPosition() {
    this.positionFixed_ = true;
  }
}

/** Arrowhead is TALA's layout-time arrowhead value (a string). */
export const NoArrowhead = 'none';
export const TriangleArrowhead = 'triangle';

/** StyleScalar carries the value of one edge style attribute. */
export class StyleScalar {
  constructor(value = '') {
    this.value = value;
  }
}

const EDGE_STYLE_FIELDS = ['opacity', 'stroke', 'fill', 'fillPattern', 'strokeWidth', 'strokeDash', 'borderRadius', 'shadow', 'threeDee',
  'multiple', 'font', 'fontSize', 'fontColor', 'animated', 'bold', 'italic', 'underline', 'filled', 'doubleBorder', 'textTransform'];

/** EdgeStyle is the complete style record carried through TALA's layout graph (every field is a StyleScalar or null). */
export class EdgeStyle {
  constructor() {
    for (const f of EDGE_STYLE_FIELDS) this[f] = null;
  }
}
export { EDGE_STYLE_FIELDS };

/** LongDistanceNeighborRequirements records the space a node needs to expose its parallel edges to a distant neighbor. */
export class LongDistanceNeighborRequirements {
  constructor(edgeCount = 0, maxWidth = 0, maxHeight = 0) {
    this.edgeCount = edgeCount;
    this.maxWidth = maxWidth;
    this.maxHeight = maxHeight;
  }
}

/** ClusterArrangement */
export const Row = 'Row';
export const Column = 'Column';
export const flipArrangement = (ca) => (ca === Row ? Column : Row);

// ---- herding.go ----

export class HerdAssignment {
  constructor() {
    this.oppositeSidePaired = new Set();
    this.sameSidePaired = new Set();
    this.orientation = 0; // zero value of geo.Orientation is TopLeft
    this.val = 0;
  }

  copy() {
    const c = new HerdAssignment();
    c.oppositeSidePaired = new Set(this.oppositeSidePaired);
    c.sameSidePaired = new Set(this.sameSidePaired);
    c.orientation = this.orientation;
    c.val = this.val;
    return c;
  }

  sameSidePairCount() {
    return this.sameSidePaired.size;
  }

  oppositeSidePairCount() {
    return this.oppositeSidePaired.size;
  }

  pairSameSide(node) {
    this.sameSidePaired.add(node);
  }

  pairOppositeSide(node) {
    this.oppositeSidePaired.add(node);
  }
}

export const newHerdAssignment = () => new HerdAssignment();

// ---- hierarchy.go ----

/** Hierarchy records the level assigned to each member of a directed, layered subgraph. */
export class Hierarchy {
  constructor() {
    this.level = new Map();
    this.levelCount = 0;
  }

  /** Levels returns the hierarchy's node-to-level mapping (mutated in place by the hierarchy algorithms). */
  levels() {
    if (this.level === null) this.level = new Map();
    return this.level;
  }

  /** ReplaceLevels atomically replaces the node-to-level mapping. */
  replaceLevels(levels) {
    this.level = levels;
  }
}

export const newHierarchy = () => new Hierarchy();

// ---- Cluster / Sequence / Tree records (their methods are below) ----

export class Cluster {
  constructor() {
    this.vessel = null;
    this.nodes = [];
    this.arrangement = '';
    this.desiredArrangement = '';
    this.graph = null;
    this.edgeAbductions = [];
    this.padding = 0;
    this.fixedSize = false;
    this.container = null;
  }
}

export class Sequence {
  constructor() {
    this.vessel = null;
    this.nodes = [];
    this.graph = null;
    this.edgeAbductions = [];
    this.container = null;
  }
}

export class Tree {
  constructor(node = null) {
    this.node = node;
    this.parent = null;
    this.children = [];
    this.sentinelEdge = null;
    this.orientation = 0; // geo.Orientation zero value (TopLeft)
  }
}

/** NewTree */
export const newTree = (node) => new Tree(node);

/** isActive of a possibly nil cluster: true while the vessel is in the graph replacing the cluster nodes. */
export const clusterIsActive = (c) => c != null && c.vessel.graph !== null;
/** isActive of a possibly nil sequence. */
export const sequenceIsActive = (s) => s != null && s.vessel.graph !== null;

// ---- Graph ----

export class Graph {
  constructor() {
    // Unfortunate, but because we represent root as nil, we need to indicate root hierarchy as a field in graph
    this.isRootHierarchy = false;
    this.nodes = [];
    this.edges = [];
    this.cellSize = 0;

    // ovg
    this.crossingCost_ = 0;
    this.turnCost_ = 0;
    this.nonCenterPortCost_ = 0;

    this.containers = new Map(); // Map<Node|null, Node[]>
    this.clusters = new Map(); // Map<Node, Cluster>
    this.trees = new Map(); // Map<Node, Tree[]>
    this.nodeToTree = null; // Map<Node, Tree> | null
    this.hubs = new Map(); // Map<Node, Node[]>
    this.sequences = new Map(); // Map<Node, Sequence>
    this.directions = new Map(); // Map<Node|null, geo.Orientation>
    this.commonUncleSiblings = null; // Map<Node, Node[]> | null
    this.edgeLengthCache = new Map(); // Map<uint64 state, float64> | null
  }
}

/** NewGraph */
export const newGraph = () => new Graph();

// ---- Node ----

export class Node {
  constructor() {
    this.d2ID = null; // string | null
    this.id = 0n;
    this.box = new geo.Box(null, 0, 0);
    this.edges = [];
    this.nears = new Set();
    this.graph = null;
    this.fontSize = null; // number | null

    this.shape = null; // nodeshape.Shape
    this.shapeType_ = nodeshape.Square;

    this.forceHierarchy = false;

    this.container = null;
    this.cluster = null;
    this.sequence = null;
    this.herdAssignment = null;
    this.hierarchy = null;

    this.label = null;
    this.icon = null;

    this.fixedTopLeft = null;

    this.desiredWidth = null;
    this.desiredHeight = null;

    this.loopOffsets = null; // Map<geo.Orientation, number> | null
    this.margin = new Spacing();
    this.padding = new Spacing();

    this.isClusterVessel_ = false;
    this.isContainer_ = false;

    this.is3D = false;
    this.isMultiple = false;
    this.isInvisible = false;

    this.longDistanceNeighborRequirements = null; // Map<Node, LongDistanceNeighborRequirements> | null
  }

  get topLeft() { return this.box.TopLeft; }
  set topLeft(p) { this.box.TopLeft = p; }
  get width() { return this.box.Width; }
  set width(w) { this.box.Width = w; }
  get height() { return this.box.Height; }
  set height(h) { this.box.Height = h; }
}

// ---- Edge ----

export class Edge {
  constructor(from = null, to = null) {
    this.d2ID = null;
    this.id = 0n;
    this.from = from;
    this.to = to;
    this.points = [];

    this.sourceArrowhead = '';
    this.targetArrowhead = '';
    this.sourceArrowheadLabel = null;
    this.targetArrowheadLabel = null;

    this.minWidth = 0;
    this.minHeight = 0;
    this.label = null;
    this.labelPercentage = 0;
    this.isCurve = false;

    this.fromTableColumnIndex = null;
    this.toTableColumnIndex = null;

    this.isInvisible = false;
    this.style = new EdgeStyle();

    this.hierarchyRankWeight_ = 0;
    this.hierarchyRankWeightSet = false;
  }
}

/** NewEdge */
export const newEdge = (from, to) => new Edge(from, to);

/** EdgeSegment is a geo.Segment owned by an edge (`start`/`end` are the Segment's Start/End). */
export class EdgeSegment extends geo.Segment {
  constructor(start, end, edge) {
    super(start, end);
    this.edge = edge;
  }

  owner() {
    return this.edge;
  }
}

export const newEdgeSegment = (start, end, edge) => new EdgeSegment(start, end, edge);

// ==== graph.go ====

/** g.Containers[node] (nil slice for a missing key) */
const containersOf = (g, node) => g.containers.get(node) ?? [];

Object.assign(Graph.prototype, {
  /** Direction reports the layout direction assigned to container. */
  direction(container) {
    const d = this.directions.get(container);
    if (d !== undefined) return d;
    return Orientation.NONE;
  },

  isBadStateContext(node, graphState, ignoreContainerEscape, guard) {
    const [bad, skipOverlapCheck] = this.isStructurallyBadStateContext(node, graphState, ignoreContainerEscape, guard);
    if (bad) return bad;
    if (skipOverlapCheck) {
      guard.finish();
      return false;
    }
    return this.hasBadOverlapStateContext(node, graphState, guard);
  },

  /**
   * isStructurallyBadStateContext checks the linear-time node invariants that do not depend on any other non-descendant graph node.
   * Returns [bad, skipOverlapCheck].
   */
  isStructurallyBadStateContext(node, graphState, ignoreContainerEscape, guard) {
    return this.isStructurallyBadStateWithFixedOriginContext(node, graphState, ignoreContainerEscape, null, false, guard);
  },

  isStructurallyBadStateWithFixedOriginContext(node, graphState, ignoreContainerEscape, fixedOrigin, fixedOriginCached, guard) {
    if (node == null || node.topLeft == null) {
      throw invariant.newError('transaction bad-state check received an incomplete node');
    }
    guard.step();
    // No need to check if cluster node is in bad state, the vessel covers it
    // Right now only happens when checking if containers bad state, since cluster nodes are still containers
    if (node.cluster !== null) return [false, true];
    if (!ignoreContainerEscape) {
      const c = node.container_();
      if (c !== null && c.topLeft !== null && node.topLeft !== null && !c.surrounds(node, 0)) return [true, false];
      if (node.isContainer_) {
        for (const child of containersOf(this, node)) {
          guard.step();
          if (child == null || child.topLeft == null) throw invariant.newError('transaction container has an incomplete child');
          if (!node.surrounds(child, 0)) return [true, false];
        }
      }
    }

    // Nothing should be past the fixed origin. Transactions cache the first fixed origin for each container once per commit;
    // standalone callers retain the legacy lookup path.
    let pastFixedOrigin;
    if (fixedOriginCached) {
      pastFixedOrigin = fixedOrigin !== null && (node.topLeft.x < fixedOrigin.x || node.topLeft.y < fixedOrigin.y);
    } else {
      pastFixedOrigin = node.isPointPastFixedOrigin(node.topLeft.x, node.topLeft.y, true);
    }
    if (pastFixedOrigin) return [true, false];

    if (node.fixedTopLeft !== null && graphState !== null) {
      let originalPoint = new geo.Point();
      const original = graphState.nodeGeometry.get(node);
      if (original !== undefined && original.topLeft.pointer !== null) originalPoint = original.topLeft.value;
      if (node.topLeft.x !== originalPoint.x || node.topLeft.y !== originalPoint.y) return [true, false];
    }
    return [false, false];
  },

  hasBadOverlapStateContext(node, graphState, guard) {
    if (node == null || node.topLeft == null) throw invariant.newError('transaction overlap check received an incomplete node');
    if (node.cluster !== null) return false;
    let pairwiseExceptions = null;
    if (graphState !== null) pairwiseExceptions = graphState.existingOverlaps;

    let exceptions = null;
    if (node.isContainer_ || node.isClusterVessel_ || this.sequences.get(node) != null) {
      exceptions = this.allDescendantNodesGuarded(node, true, guard);
    }
    // doesOverlapWithDimensionsContext already skips node identity, so only descendants and ancestors need to be materialized as exceptions.
    if (node.container !== null || node.cluster !== null || node.sequence !== null) {
      const ancestors = this.ancestorsOfGuarded(node, guard);
      exceptions = (exceptions ?? []).concat(ancestors);
    }
    return this.doesOverlapWithDimensionsContext(node, node.topLeft, node.width, node.height, exceptions, pairwiseExceptions, guard);
  },

  addNodeUnchecked(node) {
    this.nodes.push(node);
    node.graph = this;
  },

  addNodeToContainer(container, node) {
    const list = this.containers.get(container);
    if (list === undefined) this.containers.set(container, [node]);
    else list.push(node);
    node.container = container;
    if (container !== null) container.isContainer_ = true;
  },

  addNewNodeToContainer(container, node) {
    this.addNodeUnchecked(node);
    this.addNodeToContainer(container, node);
  },

  addNode(node) {
    const [occupant, is] = this.isOccupied(node.topLeft);
    if (!is) {
      this.addNodeUnchecked(node);
      return node;
    }
    return occupant;
  },

  removeNode(node) {
    this.nodes = this.nodes.filter((n) => n !== node);
  },

  addEdge(edge) {
    if (this.edges.includes(edge)) return;
    this.edges.push(edge);
  },

  computeCellSize() {
    let minHeight = Infinity;
    let minWidth = Infinity;
    let maxHeight = -Infinity;
    let maxWidth = -Infinity;

    for (const node of this.nodes) {
      minWidth = Math.min(minWidth, node.width);
      minHeight = Math.min(minHeight, node.height);
      maxWidth = Math.max(maxWidth, node.width);
      maxHeight = Math.max(maxHeight, node.height);
    }

    const minLength = Math.min(minWidth, minHeight);
    const maxLength = Math.max(maxWidth, maxHeight);

    if (maxLength < (3.0 * minLength)) {
      this.cellSize = Math.ceil(maxLength);
    } else {
      this.cellSize = Math.ceil((3.0 * minLength) / 2.0);
    }
    this.cellSize = Math.max(this.cellSize, minCellSize);
  },

  disconnect(edge) {
    edge.from.removeEdge(edge);
    edge.to.removeEdge(edge);
    this.edges = this.edges.filter((e) => e !== edge);
  },

  connect(nodeA, nodeB) {
    const edge = newEdge(nodeA, nodeB);
    this.edges.push(edge);
    nodeA.addEdge(edge);
    if (nodeA !== nodeB) nodeB.addEdge(edge);
    return edge;
  },

  doesOverlapWithDimensionsContext(node, p, newWidth, newHeight, exceptions, pairwiseExceptions, guard) {
    if (node == null || p == null) throw invariant.newError('overlap check received an incomplete node');
    const right = p.x + newWidth;
    const bottom = p.y + newHeight;
    let exceptionSet = null;
    if (exceptions !== null && exceptions.length > 0) {
      exceptionSet = new Set();
      for (const exception of exceptions) {
        guard.step();
        exceptionSet.add(exception);
      }
    }
    // Every candidate comparison uses the same moved-node exception set. Resolve it once instead of repeating an outer-map lookup for every graph node.
    const pairwiseNodeExceptions = pairwiseExceptions ? pairwiseExceptions.get(node) : undefined;

    for (const otherNode of this.nodes) {
      guard.step();
      if (otherNode == null) throw invariant.newError('overlap check encountered a nil graph node');
      if (otherNode === node) continue;
      if (otherNode.topLeft !== null) {
        // This heuristic is only a trial filter; the transaction constructor uses the proven graph-wide padding above as its construction bound.
        const maxSafeDelta = 500.0;
        if (p.x > otherNode.topLeft.x + otherNode.width + maxSafeDelta ||
          p.x + newWidth + maxSafeDelta < otherNode.topLeft.x ||
          p.y > otherNode.topLeft.y + otherNode.height + maxSafeDelta ||
          p.y + newHeight + maxSafeDelta < otherNode.topLeft.y) {
          continue;
        }
        // Distant boxes cannot overlap regardless of the exception sets. Test geometry first so sparse layouts avoid two map probes per box.
        if (pairwiseNodeExceptions !== undefined && pairwiseNodeExceptions.has(otherNode)) continue;
        if (exceptionSet !== null && exceptionSet.has(otherNode)) continue;
        const delta = node.deltaToGuarded(otherNode, p, guard);

        // Standard overlap test
        if ((p.x < (otherNode.topLeft.x + otherNode.width + delta)) && ((right + delta) > otherNode.topLeft.x) &&
          (p.y < (otherNode.topLeft.y + otherNode.height + delta)) && ((bottom + delta) > otherNode.topLeft.y)) {
          return true;
        }
      }
    }
    guard.finish();
    return false;
  },

  /** WouldOverlapWithWorkGuard reports whether placing node at point overlaps an unexcepted graph node while charging the complete comparison. */
  wouldOverlapWithWorkGuard(node, point, exceptions, pairwiseExceptions, guard) {
    if (guard == null) throw errorf('TALA overlap check requires a work guard');
    if (node == null) {
      return this.doesOverlapWithDimensionsContext(node, point, 0, 0, exceptions, pairwiseExceptions, guard);
    }
    return this.doesOverlapWithDimensionsContext(node, point, node.width, node.height, exceptions, pairwiseExceptions, guard);
  },

  /** [node, found] */
  isOccupied(p) {
    for (const n of this.nodes) {
      if (n.topLeft !== null && p != null && nonNilEquals(n.topLeft, p)) return [n, true];
    }
    return [null, false];
  },

  bounds() {
    const [tl, br] = this.boundingBox_(true);
    if (tl === null || br === null) return [null, null];
    // Placement consumes a pixel-aligned graph box even when edge points are fractional.
    return [geo.newPoint(goRound(tl.x), goRound(tl.y)), geo.newPoint(goRound(br.x), goRound(br.y))];
  },

  unroundedBounds() {
    return this.boundingBox_(false);
  },

  boundingBox_(roundNodeDimensions) {
    let tl, br;
    if (roundNodeDimensions) [tl, br] = Nodes.fixedBounds(this.nodes);
    else [tl, br] = Nodes.unroundedFixedBounds(this.nodes);
    if (tl === null || br === null) return [null, null];

    let minX = tl.x;
    let minY = tl.y;
    let maxX = br.x;
    let maxY = br.y;

    for (const edge of this.edges) {
      const [edgeTL, edgeBR] = edge.boundingBoxValues_();
      if (!(edgeTL.x === Infinity || edgeTL.x === -Infinity)) {
        minX = Math.min(minX, edgeTL.x);
        minY = Math.min(minY, edgeTL.y);
        maxX = Math.max(maxX, edgeBR.x);
        maxY = Math.max(maxY, edgeBR.y);
      }
    }

    return [geo.newPoint(minX, minY), geo.newPoint(maxX, maxY)];
  },

  turnCostValue() {
    if (this.turnCost_ !== 0.0) return this.turnCost_;
    const cost = turnPenaltyMultiplier * this.edges.length * this.maxEdgeLength();
    this.turnCost_ = cost;
    return cost;
  },

  nonCenterPortCostValue() {
    if (this.nonCenterPortCost_ !== 0.0) return this.nonCenterPortCost_;
    if (this.edges.length === 0) return 0;
    let cost = centerPortMultiplier * this.edges.length * this.maxEdgeLength();

    // For certain diagrams, the `cost` above can be smaller than the distance between ports and then edge routing doesn't prefer
    // center ports as expected; the routine below estimates another cost based on the min node size
    let minSize = Infinity;
    for (const n of this.nodes) {
      if (n.isContainer_) continue;
      minSize = Math.min(minSize, n.height);
      minSize = Math.min(minSize, n.width);
    }

    if (minSize !== Infinity) cost = Math.max(cost, minSize / 3.);
    this.nonCenterPortCost_ = cost;
    return cost;
  },

  crossingCostValue() {
    if (this.crossingCost_ !== 0.0) return this.crossingCost_;
    // c * (m * l_max)
    const cost = CrossingCostWeight * this.edges.length * this.maxEdgeLength();
    this.crossingCost_ = cost;
    return cost;
  },

  resetTurnCost_() {
    this.turnCost_ = 0;
  },

  maxEdgeLength() {
    let hasLength = false;
    let maxLength = ConnectedNodeGap;
    for (const n of this.nodes) {
      if (n.topLeft === null) continue;
      for (const e of n.edges) {
        const adj = n.adjacent_(e);
        if (adj.topLeft === null) continue;
        hasLength = true;
        const distance = n.distanceTo_(adj, true);
        maxLength = Math.max(maxLength, distance);
      }
    }
    if (!hasLength) return 0.0;
    return maxLength;
  },

  /** SplitSubgraphs partitions the graph into sets of mutually reachable nodes. */
  splitSubgraphs(ctx, options) {
    return this.splitSubgraphsWithOwnership(ctx, options, null, null);
  },

  /**
   * splitSubgraphsWithOwnership optionally records every Node.Graph value changed by the split in `ownership.journal` (pass an
   * object `{journal: null}`; a Map<Node, Graph> on return). Reachability includes the bounded Near closure.
   */
  splitSubgraphsWithOwnership(ctx, options, ownership, sharedGuard) {
    let guard = sharedGuard;
    if (guard === null) {
      validateEngineGraph(ctx, 'SplitSubgraphs', this);
      guard = limits.newWorkGuard(ctx, 'SplitSubgraphs', maxEngineWorkUnits);
    } else {
      guard.finish();
    }
    const originalGraphReferences = new Map();
    let complete = false;
    try {
      for (const node of this.nodes) {
        guard.step();
        if (node != null) originalGraphReferences.set(node, node.graph);
      }
      const graphs = [];
      if (this.nodes.length === 0) {
        complete = true;
        return graphs;
      }

      const added = new Set();
      const nodeToSubgraph = new Map();
      const addReachable = (startingNode, subgraph) => {
        const reachableNodes = startingNode.allReachableNodesGuarded(options.includeContainers, options.includeNears, options.traverseTrees, null, guard);
        for (const node of reachableNodes) {
          guard.step();
          if (added.has(node)) continue;
          if (!originalGraphReferences.has(node)) {
            if (originalGraphReferences.size >= maxEngineNodes) {
              throw errorf(`TALA SplitSubgraphs unique node ownership exceeds limit ${maxEngineNodes}`);
            }
            originalGraphReferences.set(node, node.graph);
          }
          subgraph.addNodeUnchecked(node);
          added.add(node);
          nodeToSubgraph.set(node, subgraph);
        }
      };

      const fixedNodes = [];
      for (const node of this.nodes) {
        guard.step();
        if (node.fixedTopLeft !== null) fixedNodes.push(node);
      }
      if (fixedNodes.length > 0) {
        // create first subgraph with all fixed nodes; it will be placed at 0,0 in CombineSubgraphs so fixed locations are accurate
        const subgraph = newGraph();
        subgraph.copyEntitiesFrom(this);

        for (const startingNode of fixedNodes) addReachable(startingNode, subgraph);

        graphs.push(subgraph);
      }

      for (const startingNode of this.nodes) {
        guard.step();
        if (added.has(startingNode)) continue;

        const subgraph = newGraph();
        subgraph.copyEntitiesFrom(this);
        addReachable(startingNode, subgraph);

        graphs.push(subgraph);
      }

      // Each original edge is considered once. This preserves the original graph's edge order without the quadratic duplicate scan in
      // AddEdge. In the unusual case where a traversal deliberately omits one endpoint into another subgraph, retain the edge in both
      // subgraphs as the old endpoint scan did.
      const seenEdges = new Map();
      const appendEdge = (graph, edge) => {
        let graphEdges = seenEdges.get(graph);
        if (graphEdges === undefined) {
          graphEdges = new Set();
          seenEdges.set(graph, graphEdges);
        }
        if (graphEdges.has(edge)) return;
        graphEdges.add(edge);
        graph.edges.push(edge);
      };
      for (const edge of this.edges) {
        guard.step();
        const fromGraph = nodeToSubgraph.get(edge.from);
        const toGraph = nodeToSubgraph.get(edge.to);
        if (fromGraph !== undefined) appendEdge(fromGraph, edge);
        if (toGraph !== undefined && toGraph !== fromGraph) appendEdge(toGraph, edge);
      }
      guard.finish();

      if (ownership !== null) ownership.journal = originalGraphReferences;
      complete = true;
      return graphs;
    } finally {
      if (!complete) {
        for (const [node, graph] of originalGraphReferences) node.graph = graph;
      }
    }
  },

  area_() {
    if (this.nodes.length === 0) return 0;
    const [topLeft, bottomRight] = this.unroundedBounds();
    return Math.abs(topLeft.x - bottomRight.x) * Math.abs(topLeft.y - bottomRight.y);
  },

  containerRDFSOrder_(root) {
    let order = [];

    if (root !== null && !root.isContainer_) return order;

    for (let i = containersOf(this, root).length - 1; i >= 0; i--) {
      const child = containersOf(this, root)[i];
      if (child.isContainer_) {
        order = order.concat(this.containerRDFSOrder_(child));
        order.push(child);
        continue;
      }

      if (child.isClusterVessel_) {
        const cluster = this.clusters.get(child);
        for (let j = cluster.nodes.length - 1; j >= 0; j--) {
          const cNode = cluster.nodes[j];
          if (cNode.isContainer_) {
            order = order.concat(this.containerRDFSOrder_(cNode));
            order.push(cNode);
          }
        }
        continue;
      }
    }

    return order;
  },

  containerRDFSOrderContext(root, guard) {
    let order = [];
    if (root !== null && !root.isContainer_) return order;

    const children = containersOf(this, root);
    for (let i = children.length - 1; i >= 0; i--) {
      guard.step();
      const child = children[i];

      if (child.isContainer_) {
        const descendants = this.containerRDFSOrderContext(child, guard);
        order = order.concat(descendants);
        order.push(child);
        continue;
      }
      if (child.isClusterVessel_) {
        const cluster = this.clusters.get(child);
        for (let j = cluster.nodes.length - 1; j >= 0; j--) {
          const clusterNode = cluster.nodes[j];
          guard.step();

          if (clusterNode.isContainer_) {
            const descendants = this.containerRDFSOrderContext(clusterNode, guard);
            order = order.concat(descendants);
            order.push(clusterNode);
          }
        }
      }
    }
    return order;
  },

  syncNested() {
    for (const n of this.nodes) {
      if (n.isContainer_) n.positionContainerChildren_(true);
      if (n.isClusterVessel_) {
        const c = this.clusters.get(n);
        c.syncGeometry();
        // Since cluster nodes can themselves be containers, we can't merely move all children nodes, we must also care to give container children padding
        for (const cn of c.nodes) {
          if (cn.isContainer_) {
            const padding = this.containerPadding_(cn, true);
            for (const child of containersOf(this, cn)) child.moveNodeWithChildren(padding.left, padding.top);
          }
        }
      }
      const seq = this.sequences.get(n);
      if (seq !== undefined) seq.syncGeometry();
    }
  },

  /**
   * includeClusterNodes should be included when the purpose is to move all nodes. But if the purpose is to find nodes to perform
   * operations on, the cluster nodes should not be included (vessels will be included). Does not include current node.
   */
  allDescendantNodes_(node, includeClusterNodes) {
    return this.allDescendantNodesGuarded(node, includeClusterNodes, unboundedWork);
  },

  allDescendantNodesGuarded(node, includeClusterNodes, guard) {
    const seen = new Set();
    const stack = [];
    const descendants = [];
    if (node !== null) seen.add(node);
    const pushChildren = (parent) => {
      // Push in reverse traversal order so the iterative walk retains the old container-before-cluster-before-sequence preorder.
      const sequence = parent === null ? undefined : this.sequences.get(parent);
      if (sequence != null) {
        for (let i = sequence.nodes.length - 1; i >= 0; i--) {
          guard.step();
          stack.push({ node: sequence.nodes[i], emit: includeClusterNodes });
        }
      }
      if (parent !== null && parent.isClusterVessel_) {
        const cluster = this.clusters.get(parent);
        if (cluster != null) {
          for (let i = cluster.nodes.length - 1; i >= 0; i--) {
            guard.step();
            stack.push({ node: cluster.nodes[i], emit: includeClusterNodes });
          }
        }
      }
      if (parent === null || parent.isContainer_) {
        const children = containersOf(this, parent);
        for (let i = children.length - 1; i >= 0; i--) {
          guard.step();
          stack.push({ node: children[i], emit: true });
        }
      }
    };
    pushChildren(node);

    while (stack.length > 0) {
      guard.step();
      const current = stack.pop();
      if (current.node === null) continue;
      if (seen.has(current.node)) continue;
      seen.add(current.node);
      if (current.emit) descendants.push(current.node);
      pushChildren(current.node);
    }
    guard.finish();
    return descendants;
  },

  ancestorsOfGuarded(node, guard) {
    const seen = new Set();
    const nodes = [];
    for (let current = node; current !== null;) {
      guard.step();
      if (seen.has(current)) throw invariant.newError('cycle in transaction ancestry');
      seen.add(current);
      if (seen.size > maxEngineNodes) throw invariant.newError('transaction ancestry exceeds node limit');
      if (current !== node) {
        // don't include node itself
        nodes.push(current);
      }
      if (current.container !== null) current = current.container;
      else if (current.cluster !== null) current = current.cluster.vessel;
      else if (current.sequence !== null) current = current.sequence.vessel;
      else break;
    }
    guard.finish();
    return nodes;
  },

  isTreeSentinel_(n) {
    return this.trees.has(n);
  },

  isSequence(n) {
    return this.sequences.has(n);
  },

  copyEntitiesFrom(other) {
    this.containers = other.containers;
    this.clusters = other.clusters;
    this.trees = other.trees;
    this.nodeToTree = other.nodeToTree;
    this.sequences = other.sequences;
    this.hubs = other.hubs;
    this.directions = other.directions;
    this.commonUncleSiblings = other.commonUncleSiblings;
    // TODO maybe not
    this.isRootHierarchy = other.isRootHierarchy;
  },

  fixedNodes_() {
    return Nodes.fixedNodes_(this.nodes);
  },

  hasFixedNode_() {
    return Nodes.hasFixedNode_(this.nodes);
  },

  containerFixedOrigin_(container) {
    for (const n of this.nodes) {
      if (n.container_() !== container) continue;
      const p = n.fixedOrigin_();
      if (p !== null) return p;
    }
    return null;
  },

  /** the amount of padding the container should have on each side (more padding if there are icons); container may be the nil container */
  containerPadding_(container, considerChildren) {
    let padding = ContainerPadding;
    const spacing = new Spacing(padding, padding, padding, padding);
    if (container === null) return spacing;
    if (container.shapeType_ === circleType) {
      // Circles just need padding so the corner of child doesn't touch corner of circle
      // Optically, there will be a lot of padding on the sides even given a small value
      padding /= 4.;
    }

    if (container.icon !== null && container.shapeType_ !== imageType) {
      // we don't know if the icon will be placed at an inside position, but leave enough padding so it has that option
      // Note: we don't know what the exact icon size will be until the final layout size so we use max
      padding = MaxIconSize + 2 * label.PADDING;
    }

    if (container.label !== null && !label.isOutside(container.label.position)) {
      // First ensure total container width/height can accommodate label
      const labelWidth = container.label.width + 2 * label.PADDING;
      const labelHeight = container.label.height + 2 * label.PADDING;

      switch (container.label.position) {
        case label.InsideTopLeft: case label.InsideTopCenter: case label.InsideTopRight:
          spacing.top = Math.max(spacing.top, labelHeight);
          break;
        case label.InsideBottomLeft: case label.InsideBottomCenter: case label.InsideBottomRight:
          spacing.bottom = Math.max(spacing.bottom, labelHeight);
          break;
        case label.InsideMiddleLeft:
          spacing.left = Math.max(spacing.left, labelWidth);
          break;
        case label.InsideMiddleRight:
          spacing.right = Math.max(spacing.right, labelWidth);
          break;
      }

      // Ensure total width/height can accommodate label
      const minContainerWidth = labelWidth + spacing.left + spacing.right;
      if (container.width < minContainerWidth) {
        const extraPadding = Math.ceil((minContainerWidth - container.width) / 2);
        spacing.left = Math.max(spacing.left, extraPadding);
        spacing.right = Math.max(spacing.right, extraPadding);
      }

      const minContainerHeight = labelHeight + spacing.top + spacing.bottom;
      if (container.height < minContainerHeight) {
        const extraPadding = Math.ceil((minContainerHeight - container.height) / 2);
        spacing.top = Math.max(spacing.top, extraPadding);
        spacing.bottom = Math.max(spacing.bottom, extraPadding);
      }
    }

    if (considerChildren) {
      let hasChildWithIcon = false;
      const childrenMargin = new Spacing();
      for (const child of containersOf(this, container)) {
        if (!hasChildWithIcon && child.icon !== null && child.shapeType_ !== imageType && !child.icon.positionFixed()) hasChildWithIcon = true;
        childrenMargin.left = Math.max(childrenMargin.left, child.margin.left);
        childrenMargin.right = Math.max(childrenMargin.right, child.margin.right);
        childrenMargin.top = Math.max(childrenMargin.top, child.margin.top);
        childrenMargin.bottom = Math.max(childrenMargin.bottom, child.margin.bottom);
      }
      spacing.left = Math.max(spacing.left, container.padding.left + childrenMargin.left);
      spacing.right = Math.max(spacing.right, container.padding.right + childrenMargin.right);
      spacing.top = Math.max(spacing.top, container.padding.top + childrenMargin.top);
      spacing.bottom = Math.max(spacing.bottom, container.padding.bottom + childrenMargin.bottom);

      if (hasChildWithIcon) {
        // we don't know if the icon will be placed at an inside position, but leave enough padding so it has that option
        padding = MaxIconSize + 2 * label.PADDING;
      }
    }

    if (container.shapeType_ === circleType) {
      spacing.top /= 4.;
      spacing.left /= 4.;
      spacing.bottom /= 4.;
      spacing.right /= 4.;
    }

    spacing.left = Math.max(spacing.left, Math.max(container.padding.left, padding));
    spacing.right = Math.max(spacing.right, Math.max(container.padding.right, padding));
    spacing.top = Math.max(spacing.top, Math.max(container.padding.top, padding));
    spacing.bottom = Math.max(spacing.bottom, Math.max(container.padding.bottom, padding));

    return spacing;
  },
});

// ==== node.go ====

/** Level of a possibly nil node. */
function nodeLevel(n) {
  if (n === null) return 0;
  if (clusterIsActive(n.cluster)) return nodeLevel(n.cluster.vessel);
  if (sequenceIsActive(n.sequence)) return nodeLevel(n.sequence.vessel);
  return 1 + nodeLevel(n.container);
}

/** newNode */
export function newNode(id, width, height) {
  const node = new Node();
  node.id = id;
  node.box = new geo.Box(null, width, height);
  node.edges = [];
  node.nears = new Set();
  node.setShape('');
  return node;
}

/** covers (unexported): does b1 cover b2 */
function covers_(b1, b2) {
  return (b2.TopLeft.x >= b1.TopLeft.x) &&
    (b2.TopLeft.y >= b1.TopLeft.y) &&
    (b2.TopLeft.x + b2.Width <= b1.TopLeft.x + b1.Width) &&
    (b2.TopLeft.y + b2.Height <= b1.TopLeft.y + b1.Height);
}

/** Covers reports whether outer completely contains inner (geo.Box values). */
export function covers(outer, inner) {
  return covers_(outer, inner);
}

/** LabelBoxFits reports whether outer completely contains inner. */
export const labelBoxFits = (outer, inner) => covers_(outer, inner);

/**
 * boxesOverlapWithPadding reports whether the interiors of two axis-aligned boxes overlap, treating a gap smaller than padding as
 * overlap. Boundary contact, including a gap exactly equal to padding, is not an overlap.
 */
function boxesOverlapWithPadding(b1, b2, padding) {
  const b1Right = b1.TopLeft.x + b1.Width;
  const b2Right = b2.TopLeft.x + b2.Width;
  if (b1.TopLeft.x >= b2Right + padding || b2.TopLeft.x >= b1Right + padding) return false;

  const b1Bottom = b1.TopLeft.y + b1.Height;
  const b2Bottom = b2.TopLeft.y + b2.Height;
  return b1.TopLeft.y < b2Bottom + padding && b2.TopLeft.y < b1Bottom + padding;
}

function sortNodesByID_(nodes) {
  if (nodes.length < 2) return;
  sortSlice(nodes, (i, j) => nodes[i].entityID() < nodes[j].entityID());
}

/** SortNodesByID gives sibling layout domains the engine's stable node order. */
export function sortNodesByID(nodes) {
  sortNodesByID_(nodes);
}

const nodeDistanceBox = (node, includeSize) => {
  const box = new geo.Box(node.topLeft, 0, 0);
  if (includeSize) {
    box.Width = node.width;
    box.Height = node.height;
  }
  return box;
};

/** distanceBetweenBoxes returns the shortest Euclidean distance between two closed, axis-aligned boxes. */
function distanceBetweenBoxes(b1, b2) {
  const dx = intervalGap(b1.TopLeft.x, b1.TopLeft.x + b1.Width, b2.TopLeft.x, b2.TopLeft.x + b2.Width);
  const dy = intervalGap(b1.TopLeft.y, b1.TopLeft.y + b1.Height, b2.TopLeft.y, b2.TopLeft.y + b2.Height);
  return geo.euclideanDistance(0, 0, dx, dy);
}

function intervalGap(aStart, aEnd, bStart, bEnd) {
  if (aEnd < bStart) return bStart - aEnd;
  if (bEnd < aStart) return aStart - bEnd;
  return 0;
}

/** segmentIntersectsBox (TODO: extract to `geo` package in Go) */
function segmentIntersectsBox(p1, p2, box) {
  if (p1 == null || p2 == null || box == null || box.TopLeft == null) return false;

  let left = box.TopLeft.x, right = box.TopLeft.x + box.Width;
  if (left > right) [left, right] = [right, left];
  let top = box.TopLeft.y, bottom = box.TopLeft.y + box.Height;
  if (top > bottom) [top, bottom] = [bottom, top];
  // A NaN box boundary cannot contain a point or survive the clipping below.
  if (left !== left || right !== right || top !== top || bottom !== bottom) return false;

  // Reject a segment only when both endpoints lie outside the same box side.
  if ((p1.x < left && p2.x < left) || (p1.x > right && p2.x > right) ||
    (p1.y < top && p2.y < top) || (p1.y > bottom && p2.y > bottom)) {
    return false;
  }

  const contains = (p) => left <= p.x && p.x <= right && top <= p.y && p.y <= bottom;
  if (contains(p1) || contains(p2)) return true;

  // Clip the segment against the closed box. Both endpoints are outside here, so a zero-length clipped interval is a single-point
  // tangency rather than a crossover.
  let tEnter = 0.0, tExit = 1.0;
  const clipAxis = (start, delta, minCoord, maxCoord) => {
    if (delta === 0) return minCoord <= start && start <= maxCoord;
    let t1 = (minCoord - start) / delta;
    let t2 = (maxCoord - start) / delta;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tEnter = Math.max(tEnter, t1);
    tExit = Math.min(tExit, t2);
    return tEnter <= tExit;
  };

  if (!clipAxis(p1.x, p2.x - p1.x, left, right) || !clipAxis(p1.y, p2.y - p1.y, top, bottom)) return false;
  return tEnter < tExit;
}

/** orientation returns a positive value for a clockwise turn, a negative value for a counter-clockwise turn, and zero for collinear points. */
function orientation(p, q, r) {
  const pqX = q.x - p.x;
  const pqY = q.y - p.y;
  const prX = r.x - p.x;
  const prY = r.y - p.y;
  return pqY * prX - pqX * prY;
}

function intersects(p1, q1, p2, q2) {
  const p2Side = orientation(p1, q1, p2);
  const q2Side = orientation(p1, q1, q2);
  const p1Side = orientation(p2, q2, p1);
  const q1Side = orientation(p2, q2, q1);

  if (p2Side === 0 && q2Side === 0 && p1Side === 0 && q1Side === 0) {
    return closedIntervalsOverlap(p1.x, q1.x, p2.x, q2.x) && closedIntervalsOverlap(p1.y, q1.y, p2.y, q2.y);
  }

  return straddlesLine(p2Side, q2Side) && straddlesLine(p1Side, q1Side);
}

function straddlesLine(side1, side2) {
  return side1 === 0 || side2 === 0 || (side1 < 0) !== (side2 < 0);
}

function closedIntervalsOverlap(a1, a2, b1, b2) {
  const aMin = Math.min(a1, a2), aMax = Math.max(a1, a2);
  const bMin = Math.min(b1, b2), bMax = Math.max(b1, b2);
  return aMin <= bMax && bMin <= aMax;
}

/** reachabilityIsDescendantOf preserves isDescendantOf's ancestry precedence while charging every parent hop. */
function reachabilityIsDescendantOf(maybeDescendant, maybeAncestor, guard) {
  if (guard == null) throw errorf('TALA reachability ancestry requires a work guard');
  for (let current = maybeDescendant; ; current = ancestryParent(current)) {
    guard.step();
    if (maybeAncestor === current) return true;
    if (current === null) return false;
  }
}

// ---- Nodes ----

export const Nodes = {
  leftmost(ns, node) {
    for (const n of ns) {
      if (n === node) continue;
      if (n.topLeft === null) continue;
      if (n.topLeft.x < node.topLeft.x) return false;
    }
    return true;
  },

  topmost(ns, node) {
    for (const n of ns) {
      if (n === node) continue;
      if (n.topLeft === null) continue;
      if (n.topLeft.y < node.topLeft.y) return false;
    }
    return true;
  },

  rightmost(ns, node) {
    for (const n of ns) {
      if (n === node) continue;
      if (n.topLeft === null) continue;
      if (n.topLeft.x + n.width > node.topLeft.x + node.width) return false;
    }
    return true;
  },

  bottommost(ns, node) {
    for (const n of ns) {
      if (n === node) continue;
      if (n.topLeft === null) continue;
      if (n.topLeft.y + n.height > node.topLeft.y + node.height) return false;
    }
    return true;
  },

  debugID(ns) {
    return '[' + ns.map((n) => n.debugID()).join(', ') + ']';
  },

  setGraphReference_(ns, g) {
    for (const n of ns) {
      n.graph = g;
      for (const child of g.allDescendantNodes_(n, true)) child.graph = g;
    }
  },

  setGraphReference(ns, g) {
    Nodes.setGraphReference_(ns, g);
  },

  adjacentCount(nodes) {
    let sum = 0;
    for (const n of nodes) sum += n.edges.length;
    return sum;
  },

  numAdjacent(nodes) {
    return Nodes.adjacentCount(nodes);
  },

  /**
   * 1. Algorithm is to seed clusters with nodes which connected/near and further than a threshold distance
   * 2. Do recursive scans in the threshold distance perimeter
   * ---- if the scan finds a node which is not part of a cluster, it becomes part of the scanning node's cluster
   * ---- if the scan finds a node which is part of a cluster, that cluster is merged into the scanning node's cluster
   */
  clusters(nodes, distanceThreshold) {
    return Nodes.clustersWithWorkGuard(nodes, distanceThreshold, null);
  },

  distanceClusters(nodes, threshold) {
    return Nodes.clusters(nodes, threshold);
  },

  distanceClustersWithWorkGuard(nodes, threshold, guard) {
    if (guard == null) throw errorf('TALA DistanceClusters requires a work guard');
    return Nodes.clustersWithWorkGuard(nodes, threshold, guard);
  },

  clustersWithWorkGuard(nodes, distanceThreshold, guard) {
    const charge = (units) => {
      if (guard === null) return;
      guard.add(units);
    };
    const finish = () => {
      if (guard === null) return;
      guard.finish();
    };
    const chargeSort = (length) => {
      for (let width = 1; width < length; width *= 2) {
        charge(length);
        if (width > Math.trunc(length / 2)) break;
      }
    };

    const nodeToCluster = new Map();

    let nextGeneratedClusterID = 0;
    const createCluster = (node) => {
      if (!nodeToCluster.has(node)) {
        const clusterID = nextGeneratedClusterID;
        nextGeneratedClusterID++;
        nodeToCluster.set(node, clusterID);
      }
    };

    const seedNodes = [];
    const maybeAddSeedNodes = (n, adj) => {
      const d = n.distance(adj, true);
      if (geo.precisionCompare(d, distanceThreshold, geo.PRECISION) > 0) seedNodes.push(n, adj);
    };
    // Step 1
    for (const n of nodes) {
      charge(1 + n.edges.length + n.nears.size);
      for (const e of n.edges) {
        const adj = n.adjacent_(e);
        maybeAddSeedNodes(n, adj);
      }
      chargeSort(n.nears.size);
      for (let near of n.orderedNears_()) {
        if (near.cluster !== null) {
          near = near.cluster.vessel;
        } else if (near.sequence !== null) {
          near = near.sequence.vessel;
        } else {
          let tree = n.graph.nodeToTree === null ? undefined : n.graph.nodeToTree.get(near);
          if (tree !== undefined) {
            if (guard === null) {
              near = tree.root().sentinelNode();
            } else {
              while (tree.parent !== null) {
                guard.step();
                tree = tree.parent;
              }
              near = tree.sentinelNode();
            }
          }
        }
        if (near.container !== n.container) continue;
        maybeAddSeedNodes(n, near);
      }
    }

    if (seedNodes.length < 2) {
      finish();
      return [];
    }

    // Step 2
    const mergeNodesInPerimeter = (n) => {
      charge(nodes.length);
      const clusterID = nodeToCluster.get(n);
      for (const otherN of nodes) {
        if (otherN === n) continue;
        if (otherN.fixedTopLeft !== null) continue;
        // TODO: consider caching this distance & comparison as it's the same computed a few lines above
        const d = n.distance(otherN, true);
        if (geo.precisionCompare(d, distanceThreshold, geo.PRECISION) > 0) continue;
        const otherClusterID = nodeToCluster.get(otherN);
        const inCluster = otherClusterID !== undefined;
        if (inCluster && otherClusterID === clusterID) continue;

        nodeToCluster.set(otherN, nodeToCluster.get(n));
        if (!inCluster) mergeNodesInPerimeter(otherN);
      }
    };

    charge(seedNodes.length);
    for (const node of seedNodes) {
      if (node.fixedTopLeft !== null) continue;
      createCluster(node);
      mergeNodesInPerimeter(node);
    }

    charge(nodes.length);
    if (!Nodes.hasFixedNode_(nodes)) {
      if (nodeToCluster.size !== nodes.length) {
        throw new GoPanic(`Clustered nodes: ${nodeToCluster.size}. Total: ${nodes.length}`);
      }
    }

    const clusterMapping = new Map();
    charge(nodeToCluster.size);
    for (const [node, clusterID] of nodeToCluster) {
      if (!clusterMapping.has(clusterID)) clusterMapping.set(clusterID, []);
      clusterMapping.get(clusterID).push(node);
    }

    for (const cluster of clusterMapping.values()) {
      chargeSort(cluster.length);
      sortNodesByID_(cluster);
    }

    const clusterIDs = [];
    charge(clusterMapping.size);
    for (const clusterID of clusterMapping.keys()) clusterIDs.push(clusterID);
    chargeSort(clusterIDs.length);
    clusterIDs.sort((a, b) => a - b);

    const clusters = [];
    charge(clusterIDs.length);
    for (const clusterID of clusterIDs) clusters.push(clusterMapping.get(clusterID));

    finish();
    return clusters;
  },

  center_(nodes) {
    const [tl, br] = Nodes.bounds(nodes);
    return geo.newPoint(tl.x + (br.x - tl.x) / 2, tl.y + (br.y - tl.y) / 2);
  },

  center(nodes) {
    return Nodes.center_(nodes);
  },

  centerWithWorkGuard_(nodes, guard) {
    const [tl, br] = Nodes.boundsWithWorkGuard(nodes, guard);
    return geo.newPoint(tl.x + (br.x - tl.x) / 2, tl.y + (br.y - tl.y) / 2);
  },

  centerWithWorkGuard(nodes, guard) {
    if (guard == null) throw errorf('TALA Center requires a work guard');
    return Nodes.centerWithWorkGuard_(nodes, guard);
  },

  bounds(nodes) {
    return Nodes.boundingBox_(nodes, true);
  },

  /** BoundingBox */
  boundingBox(nodes) {
    return Nodes.bounds(nodes);
  },

  boundingBoxWithWorkGuard(nodes, guard) {
    if (guard == null) throw errorf('TALA BoundingBox requires a work guard');
    return Nodes.boundsWithWorkGuard(nodes, guard);
  },

  /** [tl, br]; [null, null] when a node has no position */
  boundsWithWorkGuard(nodes, guard) {
    if (nodes.length === 0) {
      guard.finish();
      return [geo.newPoint(-Infinity, -Infinity), geo.newPoint(Infinity, Infinity)];
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const node of nodes) {
      guard.step();
      if (node.topLeft === null) return [null, null];
      if (node.label !== null && label.isOutside(node.label.position)) {
        // An outside label can scan the complete peer set along each axis.
        guard.add(2 * nodes.length);
      }
      const [tl, br] = node.boundingBoxValues(nodes, true);
      minX = Math.min(minX, tl.x);
      minY = Math.min(minY, tl.y);
      maxX = Math.max(maxX, br.x);
      maxY = Math.max(maxY, br.y);
    }

    guard.finish();
    return [geo.newPoint(minX, minY), geo.newPoint(maxX, maxY)];
  },

  unroundedBounds(nodes) {
    return Nodes.boundingBox_(nodes, false);
  },

  boundingBox_(nodes, roundDimensions) {
    if (nodes.length === 0) return [geo.newPoint(-Infinity, -Infinity), geo.newPoint(Infinity, Infinity)];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const node of nodes) {
      if (node.topLeft === null) return [null, null];
      const [tl, br] = node.boundingBoxValues(nodes, roundDimensions);
      minX = Math.min(minX, tl.x);
      minY = Math.min(minY, tl.y);
      maxX = Math.max(maxX, br.x);
      maxY = Math.max(maxY, br.y);
    }

    return [geo.newPoint(minX, minY), geo.newPoint(maxX, maxY)];
  },

  /** for nodes in the same container, return the bounding box accounting for any fixed node offset */
  fixedBounds(nodes) {
    let [tl, br] = Nodes.bounds(nodes);
    const fixedOrigin = Nodes.fixedOrigin(nodes);
    if (fixedOrigin !== null) tl = fixedOrigin;
    return [tl, br];
  },

  fixedBoundingBox(nodes) {
    return Nodes.fixedBounds(nodes);
  },

  unroundedFixedBounds(nodes) {
    let [tl, br] = Nodes.unroundedBounds(nodes);
    const fixedOrigin = Nodes.fixedOrigin(nodes);
    if (fixedOrigin !== null) tl = fixedOrigin;
    return [tl, br];
  },

  intersectsNode_(ns, edge) {
    // Check for intersections on other nodes
    for (const otherNode of ns) {
      // Can intersect with a container if one endpoint is inside it
      if (edge.from.isDescendantOf_(otherNode)) continue;
      if (edge.to.isDescendantOf_(otherNode)) continue;

      for (let i = 0; i < edge.points.length - 1; i++) {
        if (otherNode.passesThrough_(edge.points[i], edge.points[i + 1])) return true;
      }
    }
    return false;
  },

  intersectsNode(ns, edge) {
    return Nodes.intersectsNode_(ns, edge);
  },

  // if this graph is a subgraph, return the container of the least nested node; normally this is the nil container
  subgraphContainer(nodes) {
    let root = null;
    let minLevel = MAX_INT;
    for (const n of nodes) {
      const c = n.container_();
      if (c === null) return null;
      const level = c.containerLevel_();
      if (level < minLevel) {
        minLevel = level;
        root = c;
      }
    }
    return root;
  },

  fixedNodes_(nodes) {
    const fixed = [];
    for (const n of nodes) {
      if (n.fixedTopLeft !== null) fixed.push(n);
    }
    return fixed;
  },

  fixedNodes(nodes) {
    return Nodes.fixedNodes_(nodes);
  },

  hasFixedNode_(nodes) {
    for (const n of nodes) {
      if (n.fixedTopLeft !== null) return true;
    }
    return false;
  },

  hasFixedNode(nodes) {
    return Nodes.hasFixedNode_(nodes);
  },

  /**
   * If container A has child B at (80,30) with a FixedTopLeft of (70,20) (ignoring padding) then the FixedOrigin point of the nodes
   * [B,C] should be at (10,10), despite their bounding box TL being at (80,30). This way when A positions itself around its children,
   * it has the space for B's FixedTopLeft to be correct.
   */
  fixedOrigin(nodes) {
    const container = Nodes.subgraphContainer(nodes);
    for (const child of nodes) {
      if (child.container_() !== container) continue;
      // the origin is the same for all fixed nodes in the container (see note above)
      const p = child.fixedOrigin_();
      if (p !== null) return p;
    }
    return null;
  },
};

// ---- Node ----

Object.assign(Node.prototype, {
  /** HasLeakyEdge checks if 1. node is a container 2. a descendant has an edge going outside the container */
  hasLeakyEdge() {
    if (!this.isContainer_) return false;

    let hasLeakyEdge = false;
    this.dfsWalk((descendant) => {
      if (descendant === this) return false;
      for (const e of descendant.edges) {
        const adj = descendant.adjacent_(e);
        if (!adj.isDescendantOf_(this)) {
          hasLeakyEdge = true;
          return true;
        }
      }
      return false;
    });
    return hasLeakyEdge;
  },

  fitNodeToGraph(g, padding) {
    const [tl, br] = Nodes.fixedBounds(g.nodes);
    this.expandForLabels(tl, br);
    this.fitToBoundingBox_(tl, br, padding);
  },

  fitToBoundingBox_(tl, br, padding) {
    let width = br.x - tl.x;
    let height = br.y - tl.y;
    if (this.label !== null && !label.isOutside(this.label.position)) {
      const minWidth = this.label.width - padding.left - padding.right + label.PADDING * 4;
      const minHeight = this.label.height - padding.top - padding.bottom + label.PADDING * 4;
      if (this.desiredWidth === null) width = Math.max(width, minWidth);
      if (this.desiredHeight === null) height = Math.max(height, minHeight);
    }
    // TODO move type Spacing to d2 and update GetDimensionsToFit for all shapes
    const [fitWidth, fitHeight] = this.getDimensionsToFit(width, height, padding.left + padding.right, padding.top + padding.bottom);
    if (this.desiredWidth !== null) this.width = Math.max(fitWidth, this.desiredWidth);
    else this.width = fitWidth;
    if (this.desiredHeight !== null) this.height = Math.max(fitHeight, this.desiredHeight);
    else this.height = fitHeight;
  },

  fitToBoundingBox(topLeft, bottomRight, padding) {
    this.fitToBoundingBox_(topLeft, bottomRight, padding);
  },

  /** [tl, br] (fresh points) of this node's bounds. */
  bounds(allNodes) {
    return this.boundsWithRounding(allNodes, true);
  },

  boundsWithRounding(allNodes, roundDimensions) {
    return this.boundingBoxValues(allNodes, roundDimensions);
  },

  /** boundingBoxValues returns [tl, br] as fresh points. allNodes is an array or null (Go nil). */
  boundingBoxValues(allNodes, roundDimensions) {
    const tl = this.topLeft.copy();
    const br = new geo.Point(tl.x + this.width, tl.y + this.height);
    if (roundDimensions) {
      br.x = goRound(br.x);
      br.y = goRound(br.y);
    }
    const [dx, dy] = this.modifierElementAdjustments_();
    if (dx !== 0 || dy !== 0) {
      tl.y -= dy;
      br.x += dx;
    }
    tl.x -= this.loopOffset(Orientation.Left);
    tl.y -= this.loopOffset(Orientation.Top);
    br.x += this.loopOffset(Orientation.Right);
    br.y += this.loopOffset(Orientation.Bottom);

    if (this.label !== null && label.isOutside(this.label.position) && allNodes !== null) {
      const labelTL = this.labelTopLeft(this.label.position, this.label.width, this.label.height);

      // include 2x padding so that outside labels will always be closest to their own node
      const boundaryOutsidePadding = label.PADDING;
      // If the node is at the boundary, there won't be ambiguity
      const outsidePadding = 2. * label.PADDING;

      if (labelTL.x < tl.x) {
        if (Nodes.leftmost(allNodes, this)) tl.x = Math.floor(labelTL.x - boundaryOutsidePadding);
        else tl.x = Math.floor(labelTL.x - outsidePadding);
      }
      if (labelTL.y < tl.y) {
        if (Nodes.topmost(allNodes, this)) tl.y = Math.floor(labelTL.y - boundaryOutsidePadding);
        else tl.y = Math.floor(labelTL.y - outsidePadding);
      }
      if (labelTL.x > br.x) {
        if (Nodes.rightmost(allNodes, this)) br.x = Math.ceil(labelTL.x + this.label.width + boundaryOutsidePadding);
        else br.x = Math.ceil(labelTL.x + this.label.width + outsidePadding);
      }

      if (labelTL.y > br.y) {
        if (Nodes.bottommost(allNodes, this)) br.y = Math.ceil(labelTL.y + this.label.height + boundaryOutsidePadding);
        else br.y = Math.ceil(labelTL.y + this.label.height + outsidePadding);
      }
    }
    if (this.icon !== null && this.shapeType_ !== imageType && label.isOutside(this.icon.position) && allNodes !== null) {
      const iconSize = MaxIconSize;
      const iconTL = this.labelTopLeft(this.icon.position, iconSize, iconSize);

      const outsidePadding = 2. * label.PADDING;

      const left = Math.floor(iconTL.x - outsidePadding);
      if (left < tl.x) tl.x = left;
      const top = Math.floor(iconTL.y - outsidePadding);
      if (top < tl.y) tl.y = top;
      const right = Math.ceil(iconTL.x + iconSize + outsidePadding);
      if (right > br.x) br.x = right;
      const bottom = Math.ceil(iconTL.y + iconSize + outsidePadding);
      if (bottom > br.y) br.y = bottom;
    }
    return [tl, br];
  },

  /** loopOffsets[o] (0 for a missing key or a nil map) */
  loopOffset(o) {
    if (this.loopOffsets === null) return 0;
    return this.loopOffsets.get(o) ?? 0;
  },

  // TODO: verify whether this correctly finds all overlapping ports.
  /** PointMap of the ports (as points) that both nodes have. */
  overlappingPorts_(n2) {
    const overlaps = new PointMap();

    // Don't count container overlaps
    if (this.isDescendantOf_(n2) || n2.isDescendantOf_(this)) return overlaps;

    const n1Ports = this.ports_();
    const n2Ports = n2.ports_();
    for (const n1Port of n1Ports) {
      const found = n2Ports.some((p) => p.x === n1Port.x && p.y === n1Port.y);
      if (found) overlaps.set(n1Port, true);
    }

    return overlaps;
  },

  overlappingPorts(other) {
    return this.overlappingPorts_(other);
  },

  debugID() {
    if (this === null) return 'nil';
    if (this.d2ID !== null) return this.d2ID;
    if (this.isClusterVessel_) return 'Cluster vessel of: ' + this.graph.clusters.get(this).debugID();
    if (this.graph !== null && this.graph.sequences.size > 0) {
      const s = this.graph.sequences.get(this);
      if (s !== undefined) return 'Sequence vessel of: ' + s.debugID();
    }
    return this.id.toString();
  },

  level() {
    return nodeLevel(this);
  },

  adjacent_(e) {
    if (this === e.from) return e.to;
    return e.from;
  },

  adjacent(edge) {
    return this.adjacent_(edge);
  },

  initIcon() {
    this.icon = new Icon();
  },

  setShape(shapeType) {
    // The shape retains this exact box pointer so its geometry follows node moves and resizes.
    const r = nodeshape.newShape(shapeType, this.box);
    if (r !== null) {
      this.shape = r[0];
      this.shapeType_ = r[1];
    }
  },

  /** ShapeType reports the node's canonical shape type. */
  shapeType() {
    return this.shape.getType();
  },

  /** NumColumns reports the number of columns in a table-shaped node. */
  numColumns() {
    return nodeshape.numColumns(this.shape);
  },

  setNumColumns(numColumns) {
    nodeshape.setNumColumns(this.shape, numColumns);
  },

  addNear(otherN) {
    if (this == null || otherN == null || this === otherN) return;
    this.nears.add(otherN);
    otherN.nears.add(this);
  },

  entityID() {
    return this.id;
  },

  deltaTo_(n2, atPoint) {
    return this.deltaToGuarded(n2, atPoint, null);
  },

  deltaTo(other, at) {
    return this.deltaTo_(other, at);
  },

  deltaToGuarded(n2, atPoint, guard) {
    const n1 = this;
    if (n1 == null || n2 == null || atPoint == null) throw invariant.newError('spacing check received incomplete nodes');
    // n1 may have multiple edges to n2. We want to get the largest distance that we need to maintain
    let maxEdgeWidth = MIN_INT;
    let maxEdgeHeight = MIN_INT;
    let isConnected = false;
    for (const e of n1.edges) {
      if (guard !== null) guard.step();
      if (e == null || e.from == null || e.to == null) throw invariant.newError('spacing check encountered an incomplete edge');
      // TODO (Sun Apr 10 16:07:25 2022) this doesn't take edge abductions into consideration, so it may not find a minWidth to a child
      if (n1.adjacent_(e) === n2) {
        isConnected = true;
        if (e.minWidth > maxEdgeWidth) maxEdgeWidth = e.minWidth;
        if (e.minHeight > maxEdgeHeight) maxEdgeHeight = e.minHeight;
      }
    }

    let horizontalDelta, verticalDelta;
    if (isConnected) {
      horizontalDelta = ConnectedNodeGap;
      verticalDelta = ConnectedNodeGap;
    } else {
      horizontalDelta = NodeGap;
      verticalDelta = NodeGap;
    }

    if (n1.shapeType_ === tableType || n2.shapeType_ === tableType) horizontalDelta = TableNodeGap;

    if (maxEdgeHeight > verticalDelta) verticalDelta = maxEdgeHeight;
    if (maxEdgeWidth > horizontalDelta) horizontalDelta = maxEdgeWidth;

    // Ordinary unlabeled boxes often require the same gap in every direction. In that case the orientation and directional-margin
    // switches cannot affect the result; retain the edge scan above for its validation and work.
    const n1Loops = n1.loopOffsets !== null && n1.loopOffsets.size > 0;
    const n2Loops = n2.loopOffsets !== null && n2.loopOffsets.size > 0;
    if (horizontalDelta === verticalDelta && !n1Loops && !n2Loops && n1.margin.isZero() && n2.margin.isZero()) {
      return horizontalDelta;
    }
    const o = n1.orientationAtPoint(n2, atPoint);

    if (n1Loops || n2Loops) {
      let loopDeltas = NodeGap;
      if (n1Loops) loopDeltas += goInt(n1.loopOffset(geo.getOpposite(o)));
      if (n2Loops) loopDeltas += goInt(n2.loopOffset(o));
      if (loopDeltas > horizontalDelta) horizontalDelta = loopDeltas;
      if (loopDeltas > verticalDelta) verticalDelta = loopDeltas;
    }

    let n1LabelWidth = 0, n1LabelHeight = 0, n2LabelWidth = 0, n2LabelHeight = 0;
    switch (geo.getOpposite(o)) {
      case Orientation.Bottom:
        n1LabelHeight = goInt(n1.margin.bottom);
        break;
      case Orientation.Top:
        n1LabelHeight = goInt(n1.margin.top);
        break;
      case Orientation.Right:
        n1LabelWidth = goInt(n1.margin.right);
        break;
      case Orientation.Left:
        n1LabelWidth = goInt(n1.margin.left);
        break;
      case Orientation.BottomLeft:
        n1LabelWidth = goInt(n1.margin.left);
        n1LabelHeight = goInt(n1.margin.bottom);
        break;
      case Orientation.BottomRight:
        n1LabelWidth = goInt(n1.margin.right);
        n1LabelHeight = goInt(n1.margin.bottom);
        break;
      case Orientation.TopLeft:
        n1LabelWidth = goInt(n1.margin.left);
        n1LabelHeight = goInt(n1.margin.top);
        break;
      case Orientation.TopRight:
        n1LabelWidth = goInt(n1.margin.right);
        n1LabelHeight = goInt(n1.margin.top);
        break;
    }
    switch (o) {
      case Orientation.Bottom:
        n2LabelHeight = goInt(n2.margin.bottom);
        break;
      case Orientation.Top:
        n2LabelHeight = goInt(n2.margin.top);
        break;
      case Orientation.Right:
        n2LabelWidth = goInt(n2.margin.right);
        break;
      case Orientation.Left:
        n2LabelWidth = goInt(n2.margin.left);
        break;
      case Orientation.BottomLeft:
        n2LabelWidth = goInt(n2.margin.left);
        n2LabelHeight = goInt(n2.margin.bottom);
        break;
      case Orientation.BottomRight:
        n2LabelWidth = goInt(n2.margin.right);
        n2LabelHeight = goInt(n2.margin.bottom);
        break;
      case Orientation.TopLeft:
        n2LabelWidth = goInt(n2.margin.left);
        n2LabelHeight = goInt(n2.margin.top);
        break;
      case Orientation.TopRight:
        n2LabelWidth = goInt(n2.margin.right);
        n2LabelHeight = goInt(n2.margin.top);
        break;
    }
    if (horizontalDelta < n1LabelWidth + n2LabelWidth) horizontalDelta = n1LabelWidth + n2LabelWidth;
    if (verticalDelta < n1LabelHeight + n2LabelHeight) verticalDelta = n1LabelHeight + n2LabelHeight;

    switch (o) {
      case Orientation.Top: case Orientation.Bottom:
        return verticalDelta;
      case Orientation.Left: case Orientation.Right:
        return horizontalDelta;
      default:
        if (horizontalDelta < verticalDelta) return horizontalDelta;
        return verticalDelta;
    }
  },

  updateSpacing() {
    const n = this;
    if (n.label !== null && n.label.positionFixed()) {
      const width = n.label.width + 2 * label.PADDING;
      const height = n.label.height + 2 * label.PADDING;
      switch (n.label.position) {
        case label.OutsideTopLeft: case label.OutsideTopCenter: case label.OutsideTopRight:
          n.margin.top = height;
          break;
        case label.OutsideBottomLeft: case label.OutsideBottomCenter: case label.OutsideBottomRight:
          n.margin.bottom = height;
          break;
        case label.OutsideLeftTop: case label.OutsideLeftMiddle: case label.OutsideLeftBottom:
          n.margin.left = width;
          break;
        case label.OutsideRightTop: case label.OutsideRightMiddle: case label.OutsideRightBottom:
          n.margin.right = width;
          break;
        case label.InsideTopLeft: case label.InsideTopCenter: case label.InsideTopRight:
          n.padding.top = height;
          break;
        case label.InsideBottomLeft: case label.InsideBottomCenter: case label.InsideBottomRight:
          n.padding.bottom = height;
          break;
        case label.InsideMiddleLeft:
          n.padding.left = width;
          break;
        case label.InsideMiddleRight:
          n.padding.right = width;
          break;
      }
    }

    if (n.icon !== null && n.icon.positionFixed()) {
      const iconSize = MaxIconSize + 2 * label.PADDING;
      switch (n.icon.position) {
        case label.OutsideTopLeft: case label.OutsideTopCenter: case label.OutsideTopRight:
          n.margin.top = Math.max(n.margin.top, iconSize);
          break;
        case label.OutsideBottomLeft: case label.OutsideBottomCenter: case label.OutsideBottomRight:
          n.margin.bottom = Math.max(n.margin.bottom, iconSize);
          break;
        case label.OutsideLeftTop: case label.OutsideLeftMiddle: case label.OutsideLeftBottom:
          n.margin.left = Math.max(n.margin.left, iconSize);
          break;
        case label.OutsideRightTop: case label.OutsideRightMiddle: case label.OutsideRightBottom:
          n.margin.right = Math.max(n.margin.right, iconSize);
          break;
        case label.InsideTopLeft: case label.InsideTopCenter: case label.InsideTopRight:
          n.padding.top = Math.max(n.padding.top, iconSize);
          break;
        case label.InsideBottomLeft: case label.InsideBottomCenter: case label.InsideBottomRight:
          n.padding.bottom = Math.max(n.padding.bottom, iconSize);
          break;
        case label.InsideMiddleLeft:
          n.padding.left = Math.max(n.padding.left, iconSize);
          break;
        case label.InsideMiddleRight:
          n.padding.right = Math.max(n.padding.right, iconSize);
          break;
      }
    }

    const [dx, dy] = n.modifierElementAdjustments_();
    if (dx !== 0 || dy !== 0) {
      n.margin.top += dy;
      n.margin.right += dx;
    }
  },

  /** A covers B but not C, B does not cover A */
  covers(n2) {
    return covers_(this.box, n2.box);
  },

  doesOverlapCalc(n2, delta) {
    return boxesOverlapWithPadding(this.box, n2.box, delta);
  },

  /** DoesOverlapExact reports whether node boxes overlap without clearance padding. */
  doesOverlapExact(n2) {
    return this.doesOverlapCalc(n2, 0);
  },

  /** doesOverlapAt returns whether placing n1 at p overlaps with n2 */
  doesOverlapAt_(n2, p) {
    const delta = this.deltaTo_(n2, p);
    const b1 = new geo.Box(p, this.width, this.height);
    return boxesOverlapWithPadding(b1, n2.box, delta);
  },

  doesOverlapAt(other, point) {
    return this.doesOverlapAt_(other, point);
  },

  doesOverlap_(n2) {
    const delta = this.deltaTo_(n2, this.topLeft);
    return this.doesOverlapCalc(n2, delta);
  },

  doesOverlap(other) {
    return this.doesOverlap_(other);
  },

  /** for 2 overlapping nodes, return the area of the overlap */
  overlapArea(otherNode) {
    const node = this;
    // area of overlap is area of rect from middle 2 xs and middle 2 ys
    const xs = [node.topLeft.x, node.topLeft.x + node.width, otherNode.topLeft.x, otherNode.topLeft.x + otherNode.width];
    const ys = [node.topLeft.y, node.topLeft.y + node.height, otherNode.topLeft.y, otherNode.topLeft.y + otherNode.height];

    xs.sort(numCmp);
    ys.sort(numCmp);

    const width = xs[2] - xs[1];
    const height = ys[2] - ys[1];

    return width * height;
  },

  addEdge(e) {
    this.edges.push(e);
  },

  removeEdge(e) {
    const i = this.edges.indexOf(e);
    if (i >= 0) this.edges.splice(i, 1);
  },

  isPointNear_(point) {
    const node = this;
    return (((node.topLeft.x - MinRouteNodeClearance) <= point.x) && ((node.topLeft.x + node.width + MinRouteNodeClearance) >= point.x)) &&
      (((node.topLeft.y - MinRouteNodeClearance) <= point.y) && ((node.topLeft.y + node.height + MinRouteNodeClearance) >= point.y));
  },

  isPointNear(point) {
    return this.isPointNear_(point);
  },

  isPointOnNode(point) {
    const node = this;
    return ((node.topLeft.x <= point.x) && ((node.topLeft.x + node.width) >= point.x)) &&
      ((node.topLeft.y <= point.y) && ((node.topLeft.y + node.height) >= point.y));
  },

  containsPointOnBox(point) {
    return this.isPointOnNode(point);
  },

  distanceTo_(nodeB, includeSizes) {
    return distanceBetweenBoxes(nodeDistanceBox(this, includeSizes), nodeDistanceBox(nodeB, includeSizes));
  },

  distanceTo(other, includeSizes) {
    return this.distanceTo_(other, includeSizes);
  },

  isAdjacentTo_(nodeB, includeSizes) {
    const d = this.distanceTo_(nodeB, includeSizes);
    if (includeSizes) {
      if (d <= this.graph.cellSize) return true;
    } else if (d <= 1.0) {
      return true;
    }
    return false;
  },

  isAdjacentTo(other, includeSizes) {
    return this.isAdjacentTo_(other, includeSizes);
  },

  isWithinBounds_(tl, br) {
    const node = this;
    if (node.topLeft.x > br.x) return false;
    if (node.topLeft.y > br.y) return false;
    if (node.topLeft.x + node.width < tl.x) return false;
    if (node.topLeft.y + node.height < tl.y) return false;

    return true;
  },

  isWithinBounds(topLeft, bottomRight) {
    return this.isWithinBounds_(topLeft, bottomRight);
  },

  distanceBetweenCenters(nodeB, includeSizes) {
    const nodeA = this;
    const c = 1.0 / 20.0;

    let xCenter = Math.abs(nodeA.topLeft.x - nodeB.topLeft.x);
    let yCenter = Math.abs(nodeA.topLeft.y - nodeB.topLeft.y);

    if (includeSizes) {
      const nodeAWidth = nodeA.width;
      const nodeAHeight = nodeA.height;
      const nodeBWidth = nodeB.width;
      const nodeBHeight = nodeB.height;

      xCenter = Math.abs((nodeA.topLeft.x + nodeAWidth / 2) - (nodeB.topLeft.x + nodeBWidth / 2)) / (nodeAWidth + nodeBWidth);
      yCenter = Math.abs((nodeA.topLeft.y + nodeAHeight / 2) - (nodeB.topLeft.y + nodeBHeight / 2)) / (nodeAHeight + nodeBHeight);
    }

    return c * Math.min(xCenter, yCenter);
  },

  isBlocked(nodeA, nodeB, includeSizes, isHorizontal) {
    const node = this;
    // Check that node is in front of nodeA and behind nodeB (in between)
    if (isHorizontal) {
      if (includeSizes) {
        if (!((node.topLeft.x >= (nodeA.topLeft.x + nodeA.width)) && ((node.topLeft.x + node.width) <= nodeB.topLeft.x))) return false;
      } else if (!((node.topLeft.x >= nodeA.topLeft.x) && (node.topLeft.x <= nodeB.topLeft.x))) {
        return false;
      }
    } else if (includeSizes) {
      if (!((node.topLeft.y >= (nodeA.topLeft.y + nodeA.height)) && ((node.topLeft.y + node.height) <= nodeB.topLeft.y))) return false;
    } else if (!((node.topLeft.y >= nodeA.topLeft.y) && (node.topLeft.y <= nodeB.topLeft.y))) {
      return false;
    }

    // Check that node blocks nodeA from nodeB
    if (isHorizontal) {
      if (includeSizes) {
        if ((node.topLeft.y <= Math.max(nodeA.topLeft.y, nodeB.topLeft.y)) &&
          ((node.topLeft.y + node.height) >= Math.min(nodeA.topLeft.y + nodeA.height, nodeB.topLeft.y + nodeB.height))) {
          return true;
        }
      } else if ((node.topLeft.y <= Math.max(nodeA.topLeft.y, nodeB.topLeft.y)) &&
        (node.topLeft.y >= Math.min(nodeA.topLeft.y, nodeB.topLeft.y))) {
        return true;
      }
    } else if (includeSizes) { // Same as horizontal, just axis flipped
      if ((node.topLeft.x <= Math.max(nodeA.topLeft.x, nodeB.topLeft.x)) &&
        ((node.topLeft.x + node.width) >= Math.min(nodeA.topLeft.x + nodeA.width, nodeB.topLeft.x + nodeB.width))) {
        return true;
      }
    } else if ((node.topLeft.x <= Math.max(nodeA.topLeft.x, nodeB.topLeft.x)) &&
      (node.topLeft.x >= Math.min(nodeA.topLeft.x, nodeB.topLeft.x))) {
      return true;
    }

    return false;
  },

  distance(nodeB, includeSizes) {
    return this.distanceTo_(nodeB, includeSizes) + this.distanceBetweenCenters(nodeB, includeSizes);
  },

  /** HAS TO BE DIAGONAL FROM EACH OTHER: [x, y] */
  orthogonalDistanceTo_(nodeB) {
    const nodeA = this;
    let x, y;
    const rightA = nodeA.topLeft.x + nodeA.width;
    const bottomA = nodeA.topLeft.y + nodeA.height;
    const rightB = nodeB.topLeft.x + nodeB.width;
    const bottomB = nodeB.topLeft.y + nodeB.height;

    if (nodeA.topLeft.x < nodeB.topLeft.x) x = Math.max(0, nodeB.topLeft.x - rightA);
    else x = Math.max(0, nodeA.topLeft.x - rightB);

    if (nodeA.topLeft.y < nodeB.topLeft.y) y = Math.max(0, nodeB.topLeft.y - bottomA);
    else y = Math.max(0, nodeA.topLeft.y - bottomB);

    return [x, y];
  },

  orthogonalDistanceTo(other) {
    return this.orthogonalDistanceTo_(other);
  },

  center_() {
    return geo.newPoint(this.topLeft.x + this.width / 2, this.topLeft.y + this.height / 2);
  },

  center() {
    return this.center_();
  },

  overlapsAlongDimension_(n2, isHorizontal, includeSizes) {
    const n1 = this;
    if (isHorizontal) {
      if (includeSizes) {
        if (n1.topLeft.y > (n2.topLeft.y + n2.height)) return false;
        if ((n1.topLeft.y + n1.height) < n2.topLeft.y) return false;
      } else {
        if (n1.topLeft.y > n2.topLeft.y) return false;
        if (n1.topLeft.y < n2.topLeft.y) return false;
      }
    } else if (includeSizes) {
      if (n1.topLeft.x > (n2.topLeft.x + n2.width)) return false;
      if ((n1.topLeft.x + n1.width) < n2.topLeft.x) return false;
    } else {
      if (n1.topLeft.x > n2.topLeft.x) return false;
      if (n1.topLeft.x < n2.topLeft.x) return false;
    }
    return true;
  },

  overlapsAlongDimension(other, horizontal, includeSizes) {
    return this.overlapsAlongDimension_(other, horizontal, includeSizes);
  },

  /** isVisibilityGraphCandidate checks for nodes which are in between given parameters node and otherNode */
  isVisibilityGraphCandidate(isHorizontal, checkSide, includeSizes, otherNode, padding) {
    const node = this;
    if (isHorizontal) {
      if (checkSide && (node.topLeft.x >= otherNode.topLeft.x)) return false;
      if (includeSizes) {
        if (node.topLeft.y > (otherNode.topLeft.y + otherNode.height + padding)) return false;
        if ((node.topLeft.y + node.height + padding) < otherNode.topLeft.y) return false;
      } else {
        if (node.topLeft.y > otherNode.topLeft.y) return false;
        if (node.topLeft.y < otherNode.topLeft.y) return false;
      }
    } else {
      if (checkSide && (node.topLeft.y >= otherNode.topLeft.y)) return false;
      if (includeSizes) {
        if (node.topLeft.x > (otherNode.topLeft.x + otherNode.width + padding)) return false;
        if ((node.topLeft.x + node.width + padding) < otherNode.topLeft.x) return false;
      } else {
        if (node.topLeft.x > otherNode.topLeft.x) return false;
        if (node.topLeft.x < otherNode.topLeft.x) return false;
      }
    }

    return true;
  },

  visibilityGraphCandidate(horizontal, checkSide, includeSizes, other, padding) {
    return this.isVisibilityGraphCandidate(horizontal, checkSide, includeSizes, other, padding);
  },

  passesThrough_(p1, p2) {
    return segmentIntersectsBox(p1, p2, this.box);
  },

  passesThrough(first, second) {
    return this.passesThrough_(first, second);
  },

  /** return true if the point is within the node's bounding box with delta padding */
  containsPoint_(p, delta) {
    const node = this;
    return node.topLeft.x - delta <= p.x &&
      node.topLeft.x + node.width + delta >= p.x &&
      node.topLeft.y - delta <= p.y &&
      node.topLeft.y + node.height + delta >= p.y;
  },

  containsPoint(point, padding) {
    return this.containsPoint_(point, padding);
  },

  /** return true if the line overlaps the node bounding box */
  overlapsLine_(p1, p2, delta) {
    const node = this;
    if (node.containsPoint_(p1, delta) || node.containsPoint_(p2, delta)) return true;

    const l = node.topLeft.x - delta;
    const r = node.topLeft.x + node.width + delta;
    const t = node.topLeft.y - delta;
    const b = node.topLeft.y + node.height + delta;

    const tl = geo.newPoint(l, t);
    const br = geo.newPoint(r, b);
    const tr = geo.newPoint(r, t);
    const bl = geo.newPoint(l, b);

    return intersects(tl, tr, p1, p2) ||
      intersects(tr, br, p1, p2) ||
      intersects(br, bl, p1, p2) ||
      intersects(bl, tl, p1, p2);
  },

  overlapsLine(start, end, delta) {
    return this.overlapsLine_(start, end, delta);
  },

  /** Surrounds (a nil receiver surrounds everything: use Node.surroundsNode for a possibly nil node) */
  surrounds(other, withPadding) {
    const node = this;
    return node.topLeft.x + withPadding < other.topLeft.x &&
      node.topLeft.x + node.width - withPadding > other.topLeft.x + other.width &&
      node.topLeft.y + withPadding < other.topLeft.y &&
      node.topLeft.y + node.height - withPadding > other.topLeft.y + other.height;
  },

  /**
   * orientation returns the orientation of node relative to otherNode.
   * E.g. node ---> otherNode, here, node is to the left of otherNode, so Left would be returned
   */
  orientation_(otherNode) {
    const node = this;
    if (node.topLeft === null || otherNode.topLeft === null) return Orientation.NONE;
    if ((node.topLeft.y + node.height) < otherNode.topLeft.y) {
      if ((node.topLeft.x + node.width) < otherNode.topLeft.x) return Orientation.TopLeft;
      if ((otherNode.topLeft.x + otherNode.width) < node.topLeft.x) return Orientation.TopRight;
      return Orientation.Top;
    }

    if ((otherNode.topLeft.y + otherNode.height) < node.topLeft.y) {
      if ((node.topLeft.x + node.width) < otherNode.topLeft.x) return Orientation.BottomLeft;
      if ((otherNode.topLeft.x + otherNode.width) < node.topLeft.x) return Orientation.BottomRight;
      return Orientation.Bottom;
    }

    if ((otherNode.topLeft.x + otherNode.width) < node.topLeft.x) return Orientation.Right;

    if ((node.topLeft.x + node.width) < otherNode.topLeft.x) return Orientation.Left;

    return Orientation.NONE;
  },

  orientation(other) {
    return this.orientation_(other);
  },

  orientationAtPoint(otherNode, point) {
    const node = this;
    // This is an optimized version that doesn't temporarily modify node's position
    if (point == null || otherNode.topLeft === null) return Orientation.NONE;

    // Simulate node being at point instead of its actual position
    if ((point.y + node.height) < otherNode.topLeft.y) {
      if ((point.x + node.width) < otherNode.topLeft.x) return Orientation.TopLeft;
      if ((otherNode.topLeft.x + otherNode.width) < point.x) return Orientation.TopRight;
      return Orientation.Top;
    }

    if ((otherNode.topLeft.y + otherNode.height) < point.y) {
      if ((point.x + node.width) < otherNode.topLeft.x) return Orientation.BottomLeft;
      if ((otherNode.topLeft.x + otherNode.width) < point.x) return Orientation.BottomRight;
      return Orientation.Bottom;
    }

    if ((otherNode.topLeft.x + otherNode.width) < point.x) return Orientation.Right;

    if ((point.x + node.width) < otherNode.topLeft.x) return Orientation.Left;

    return Orientation.NONE;
  },

  /** allReachableNodesGuarded returns all connected nodes in BFS order. This includes itself at index 0. */
  allReachableNodesGuarded(includeContainers, includeNears, traverseTrees, ignore, guard) {
    return this.reachableNodesGuarded(() => true, includeContainers, includeNears, traverseTrees, ignore, guard);
  },

  allReachableNodesContext(includeContainers, includeNears, traverseTrees, ignore, guard) {
    return this.allReachableNodesGuarded(includeContainers, includeNears, traverseTrees, ignore, guard);
  },

  reachableNodesContext(shouldVisit, includeContainers, includeNears, traverseTrees, ignore, guard) {
    return this.reachableNodesGuarded(shouldVisit, includeContainers, includeNears, traverseTrees, ignore, guard);
  },

  reachableNodesGuarded(shouldVisit, includeContainers, includeNears, traverseTrees, ignore, guard) {
    const node = this;
    const reachableNodes = [];
    const visitQueue = [node];
    let head = 0;

    const reachedOrVisited = new Set([node]);

    const queue = (n) => {
      if (ignore !== null && ignore.has(n)) return;
      if (reachedOrVisited.has(n)) return;
      if (!shouldVisit(n)) return;
      reachedOrVisited.add(n);
      visitQueue.push(n);
    };

    while (head < visitQueue.length) {
      guard.step();
      const curr = visitQueue[head++];
      let includeNode = true;
      if (traverseTrees) {
        if (node.graph.nodeToTree !== null && node.graph.nodeToTree.has(curr)) includeNode = false;
      }
      if (includeNode) reachableNodes.push(curr);
      reachedOrVisited.add(curr);

      for (const e of curr.edges) {
        guard.step();
        const adjacentNode = curr.adjacent_(e);
        queue(adjacentNode);
      }

      if (traverseTrees) {
        const trees = node.graph.trees.get(curr);
        if (trees !== undefined) {
          for (const tree of trees) {
            guard.step();
            queue(tree.node);
          }
        } else {
          const tree = node.graph.nodeToTree === null ? undefined : node.graph.nodeToTree.get(curr);
          if (tree !== undefined) {
            if (tree.parent !== null) queue(tree.parent.node);
            else queue(tree.sentinelNode());
            for (const c of tree.children) {
              guard.step();
              queue(c.node);
            }
          }
        }
      }
      if (includeNears) {
        let nears = curr.orderedNears_();
        if (curr.isClusterVessel_) {
          for (const cn of node.graph.clusters.get(curr).nodes) nears = nears.concat(cn.orderedNears_());
        }
        for (let near of nears) {
          guard.step();
          if (clusterIsActive(near.cluster)) near = near.cluster.vessel;
          else if (sequenceIsActive(near.sequence)) near = near.sequence.vessel;
          if (near.container !== node.container) continue;
          queue(near);
        }
      }

      if (includeContainers) {
        if (curr.sequence !== null) {
          for (const step of curr.sequence.nodes) {
            guard.step();
            queue(step);
          }
        }
        if (curr.isClusterVessel_) {
          for (const n of node.graph.clusters.get(curr).nodes) {
            guard.step();
            queue(n);
          }
        }

        for (const otherNode of node.graph.nodes) {
          guard.step();
          if (reachedOrVisited.has(otherNode)) continue;
          let isDescendant = reachabilityIsDescendantOf(curr, otherNode, guard);
          if (!isDescendant) isDescendant = reachabilityIsDescendantOf(otherNode, curr, guard);
          if (isDescendant) queue(otherNode);
        }
      }
    }
    return reachableNodes;
  },

  connectionTo_(otherNode) {
    for (const e of this.edges) {
      if (this.adjacent_(e) === otherNode) return e;
    }
    return null;
  },

  connectionTo(other) {
    return this.connectionTo_(other);
  },

  /** spillsOutOfNode detects whether the node has both a corner inside the container and a corner outside the container node */
  spillsOutOf_(node2) {
    const node1 = this;
    const corners = [
      node1.topLeft,
      geo.newPoint(node1.topLeft.x + node1.width, node1.topLeft.y),
      geo.newPoint(node1.topLeft.x + node1.width, node1.topLeft.y + node1.height),
      geo.newPoint(node1.topLeft.x, node1.topLeft.y + node1.height),
    ];

    let hasInside = false;
    let hasOutside = false;

    for (const corner of corners) {
      if (node2.isPointOnNode(corner)) hasInside = true;
      else hasOutside = true;
    }

    return hasInside && hasOutside;
  },

  spillsOutOf(container) {
    return this.spillsOutOf_(container);
  },

  /**
   * connectedNodes returns all nodes (including this one) that should move with it. This includes nodes with a path to it, nodes in
   * the same container. TODO for some reason e.From.Graph isn't populated with containers, so we pass mainGraph instead.
   * (Go ranges over mainGraph.Clusters and mainGraph.Containers here: their order is random, so the result order is not stable in
   * Go; this port uses insertion order.)
   */
  connectedNodes_(excludedNodes, mainGraph) {
    const node = this;
    const nodes = [];
    const queue = [node];
    let head = 0;
    const inQueue = new Set([node]);

    const excludedSet = new Set(excludedNodes);

    const addQueue = (n) => {
      if (!inQueue.has(n)) {
        queue.push(n);
        inQueue.add(n);
      }
    };

    while (head < queue.length) {
      const curr = queue[head++];
      let isAncestorOrDescendantOfExcluded = false;
      for (const excluded of excludedNodes) {
        if (curr.isDescendantOf_(excluded)) {
          isAncestorOrDescendantOfExcluded = true;
          break;
        }
        if (excluded.isDescendantOf_(curr) && !node.isDescendantOf_(curr)) {
          isAncestorOrDescendantOfExcluded = true;
          break;
        }
      }
      if (isAncestorOrDescendantOfExcluded) continue;
      nodes.push(curr);
      for (const e of curr.edges) {
        const connected = curr.adjacent_(e);
        if (excludedSet.has(connected)) continue;
        addQueue(connected);
      }

      // If the current is a cluster vessel, a cluster node may be a container, which we should include the children of
      if (curr.isClusterVessel_) {
        for (const n of mainGraph.clusters.get(curr).nodes) {
          if (n.isContainer_) {
            for (const child of containersOf(mainGraph, n)) addQueue(child);
          }
        }
      }

      // If the current is a child of a cluster node container, we should include that cluster vessel
      for (const [vessel, cluster] of mainGraph.clusters) {
        for (const n of cluster.nodes) {
          if (n.isContainer_) {
            let nodeIsChild = false;
            let excludedNodeIsChild = false;
            for (const child of containersOf(mainGraph, n)) {
              if (child === curr) nodeIsChild = true;
              if (excludedSet.has(child)) {
                excludedNodeIsChild = true;
                break;
              }
            }
            if (excludedNodeIsChild) continue;
            if (nodeIsChild) addQueue(vessel);
          }
        }
      }

      for (const [container, children] of mainGraph.containers) {
        if (container === null) continue;
        if (excludedSet.has(container)) continue;

        // If the node is part a container, include the container (which will include all children downstream) ...
        let nodeIsChild = false;
        let excludedNodeIsChild = false;

        for (const child of children) {
          if (child === curr) nodeIsChild = true;
          if (excludedSet.has(child)) {
            excludedNodeIsChild = true;
            break;
          }
        }
        // ... unless an excluded node is also within that container
        if (excludedNodeIsChild) continue;
        if (nodeIsChild) addQueue(container);

        // If the node is a container, everything within it is included
        if (curr === container) {
          for (const child of containersOf(mainGraph, curr)) addQueue(child);
        }
      }
    }

    return nodes;
  },

  connectedNodes(excluded, graph) {
    return this.connectedNodes_(excluded, graph);
  },

  area_() {
    return this.width * this.height;
  },

  /** Area returns a node's rectangular area. */
  area() {
    return this.area_();
  },

  /** LabelTopLeft returns the top-left point for a label of the given size and position relative to node. */
  labelTopLeft(labelPosition, width, height) {
    let box;
    if (label.isOutside(labelPosition)) box = this.getBox();
    else box = this.innerBox();

    return label.getPointOnBox(labelPosition, box, label.PADDING, width, height);
  },

  /** NodeOverlapCount reports how many nodes overlap node within delta. */
  nodeOverlapCount(nodes, delta) {
    let count = 0;
    for (const otherNode of nodes) {
      if (this.doesOverlapCalc(otherNode, delta)) count++;
    }
    return count;
  },

  ports_() {
    const n = this;
    const ports = [];
    for (const relativePoints of n.snapPointPercentages()) {
      for (const point of relativePoints) {
        ports.push(new geo.Point(n.topLeft.x + goRound(n.width * point.XPercentage), n.topLeft.y + goRound(n.height * point.YPercentage)));
      }
    }
    return ports;
  },

  /** Ports returns the node's port points (fresh geo.Point values). */
  ports() {
    return this.ports_();
  },

  /** [point, ok] */
  nthPortValue(index) {
    const n = this;
    let i = 0;
    for (const relativePoints of n.snapPointPercentages()) {
      for (const point of relativePoints) {
        if (i === index) {
          return [new geo.Point(n.topLeft.x + goRound(n.width * point.XPercentage), n.topLeft.y + goRound(n.height * point.YPercentage)), true];
        }
        i++;
      }
    }
    return [new geo.Point(), false];
  },

  nthPort(index) {
    const [port, ok] = this.nthPortValue(index);
    if (!ok) return null;
    return port;
  },

  pointToPortOrientation(p) {
    for (const o of [Orientation.Top, Orientation.Right, Orientation.Left, Orientation.Bottom]) {
      const indices = this.portIndices(o);
      for (const i of indices) {
        const port = this.nthPort(i);
        if (p.equals(port)) return o;
      }
    }
    return Orientation.NONE;
  },

  portOrientation(point) {
    return this.pointToPortOrientation(point);
  },

  nthPortOnSideValue(orientation, n) {
    const indices = this.portIndices(orientation);
    return this.nthPortValue(indices[n]);
  },

  /** [point, ok] */
  tableColumnPortValue(orientation, columnIndex) {
    const r = nodeshape.tableColumnPortValue(this.shape, orientation, columnIndex);
    if (r[1]) return r;
    return this.nthPortOnSideValue(orientation, columnIndex);
  },

  centerPorts_() {
    const ports = this.ports_();
    const indices = this.centerPortIndices();

    const centerPorts = [];
    for (const index of indices) centerPorts.push(ports[index]);
    return centerPorts;
  },

  centerPorts() {
    return this.centerPorts_();
  },

  portsByOrientation_(orientation) {
    const ports = this.ports_();
    const indices = this.portIndices(orientation);

    const portsForOrientation = [];
    for (const index of indices) portsForOrientation.push(ports[index]);
    return portsForOrientation;
  },

  portsByOrientation(orientation) {
    return this.portsByOrientation_(orientation);
  },

  /** PointMap<Point> of port -> mirrored port */
  mirroredPorts_() {
    const ports = this.ports_();

    const portToMirrored = new PointMap();
    for (const [index, mirrorIndex] of this.mirroredPortIndices()) portToMirrored.set(ports[index], ports[mirrorIndex]);
    return portToMirrored;
  },

  mirroredPorts() {
    return this.mirroredPorts_();
  },

  mirror_(x, y) {
    const node = this;
    // When mirroring, we need to consider the loop offsets otherwise, the node bounding box can change can end up in the wrong position.
    let topOffset = 0, bottomOffset = 0, leftOffset = 0, rightOffset = 0;
    if (node.loopOffsets !== null && node.loopOffsets.size > 0) {
      topOffset = node.loopOffset(Orientation.Top);
      leftOffset = node.loopOffset(Orientation.Left);
      rightOffset = node.loopOffset(Orientation.Right);
      bottomOffset = node.loopOffset(Orientation.Bottom);
    }
    if (x) node.topLeft.x = -node.topLeft.x - node.width + leftOffset - rightOffset;
    if (y) node.topLeft.y = -node.topLeft.y - node.height + topOffset - bottomOffset;
  },

  mirror(x, y) {
    this.mirror_(x, y);
  },

  moveNodeAbsWithChildren(x, y) {
    if (this.topLeft !== null && this.topLeft.x === x && this.topLeft.y === y) return;
    this.moveNodeWithChildren(x - this.topLeft.x, y - this.topLeft.y);
  },

  moveAbsWithChildren(x, y) {
    this.moveNodeAbsWithChildren(x, y);
  },

  moveNodeWithChildren(dx, dy) {
    if (dx === 0 && dy === 0) return;
    this.translate_(dx, dy);
    for (const child of this.graph.allDescendantNodes_(this, true)) child.translate_(dx, dy);
  },

  moveWithChildren(dx, dy) {
    this.moveNodeWithChildren(dx, dy);
  },

  translate_(dx, dy) {
    this.topLeft.x += dx;
    this.topLeft.y += dy;
  },

  translate(dx, dy) {
    this.translate_(dx, dy);
  },

  positionContainerChildren_(withPadding) {
    const n = this;
    if (!n.isContainer_) return;
    const children = containersOf(n.graph, n);
    let padding = new Spacing();
    if (withPadding) padding = n.graph.containerPadding_(n, false);
    const [tl, br] = Nodes.fixedBounds(children);
    n.expandForLabels(tl, br);
    const innerTL = n.insidePlacement(br.x - tl.x, br.y - tl.y, padding);
    const dx = innerTL.x - tl.x;
    const dy = innerTL.y - tl.y;
    for (const childN of children) childN.moveNodeWithChildren(dx, dy);
  },

  positionContainerChildren(withPadding) {
    this.positionContainerChildren_(withPadding);
  },

  canContain() {
    const n = this;
    return n.shapeType_ !== imageType &&
      n.shapeType_ !== codeType &&
      n.shapeType_ !== tableType &&
      n.shapeType_ !== classType &&
      n.shapeType_ !== textType;
  },

  /**
   * Make enough room for label to be center positioned. Even though labels are placed at the last step, the most common is for long
   * labels to be outside centered top or bottom. So we pre-emptively make enough room for it.
   */
  expandForLabels(tl, br) {
    const children = containersOf(this.graph, this);

    for (const child of children) {
      if (child.label !== null && (child.topLeft.x === tl.x || child.topLeft.x + child.width === br.x)) {
        if (child.label.width > child.width) {
          tl.x = Math.min(tl.x, Math.floor(child.topLeft.x + (child.width / 2. - child.label.width / 2.)));
          br.x = Math.max(br.x, Math.ceil(child.topLeft.x + child.width - (child.width / 2. - child.label.width / 2.)));
        }
      }
    }
  },

  wrapChildren_() {
    const n = this;
    if (!n.isContainer_) return;
    const children = containersOf(n.graph, n);
    const padding = n.graph.containerPadding_(n, false);
    const [tl, br] = Nodes.fixedBounds(children);
    n.expandForLabels(tl, br);
    n.fitToBoundingBox_(tl, br, padding);
    const innerTL = n.insidePlacement(br.x - tl.x, br.y - tl.y, padding);
    n.translate_(tl.x - innerTL.x, tl.y - innerTL.y);
  },

  wrapChildren() {
    this.wrapChildren_();
  },

  /** InsidePlacement returns the top-left point (a fresh geo.Point) at which content of the given size and padding fits inside n. */
  insidePlacement(width, height, padding) {
    const n = this;
    const padX = padding.left + padding.right;
    const padY = padding.top + padding.bottom;
    // TODO update d2's GetInsidePlacement to take Spacing
    const p = n.shape.getInsidePlacement(width, height, padX, padY);

    if (n.shape.getType() === shape.CIRCLE_TYPE) {
      const totalWidth = width + padX;
      const totalHeight = height + padY;

      const innerBox = n.shape.getInnerBox();
      if (innerBox.Width > totalWidth) p.x += (innerBox.Width - totalWidth) / 2.;
      if (innerBox.Height > totalHeight) p.y += (innerBox.Height - totalHeight) / 2.;
    }

    // always round the results from shape
    p.x = goRound(p.x);
    p.y = goRound(p.y);
    p.x -= goRound(padX / 2) - padding.left;
    p.y -= goRound(padY / 2) - padding.top;
    return p;
  },

  /** InnerBox returns n's rounded content box. */
  innerBox() {
    // always round the results from shape
    const box = this.shape.getInnerBox();
    return new geo.Box(new geo.Point(goRound(box.TopLeft.x), goRound(box.TopLeft.y)), goRound(box.Width), goRound(box.Height));
  },

  isMajorityTarget_() {
    let counter = 0;
    for (const e of this.edges) {
      if (e.isDirected_()) {
        if (e.isTargetedTo_(this)) counter++;
        else counter--;
      }
    }
    return counter > 0;
  },

  isMajorityTarget() {
    return this.isMajorityTarget_();
  },

  /** IconSize returns the icon size appropriate for iconPosition on n. */
  iconSize(iconPosition) {
    const n = this;
    const minDimension = Math.min(n.width, n.height);
    let size;
    if (iconPosition === label.InsideMiddleCenter) size = 0.5 * minDimension;
    else size = Math.min(minDimension, Math.max(defaultIconSize, 0.5 * minDimension));
    size = Math.min(size, MaxIconSize);

    if (!label.isOutside(iconPosition)) {
      const box = n.innerBox();
      size = Math.min(Math.max(0, box.Width - 2 * label.PADDING), size);
      size = Math.min(Math.max(0, box.Height - 2 * label.PADDING), size);
    }
    return size;
  },

  orderedNears_() {
    const nears = [];
    for (const near of this.nears) nears.push(near);
    sortNodesByID_(nears);
    return nears;
  },

  orderedNears() {
    return this.orderedNears_();
  },

  dfsWalk(applyFunc) {
    const n = this;
    if (applyFunc(n)) return true; // stop early if apply returns true

    if (n.isContainer_) {
      for (const childNode of containersOf(n.graph, n)) {
        if (childNode.dfsWalk(applyFunc)) return true;
      }
    }

    if (n.isClusterVessel_) {
      for (const cn of n.graph.clusters.get(n).nodes) {
        if (cn.dfsWalk(applyFunc)) return true;
      }
    } else {
      const s = n.graph.sequences.get(n);
      if (s !== undefined) {
        for (const step of s.nodes) {
          if (step.dfsWalk(applyFunc)) return true;
        }
      }
    }
    return false;
  },

  rdfsWalk(applyFunc) {
    const n = this;
    if (n.isContainer_) {
      for (const childNode of containersOf(n.graph, n)) childNode.rdfsWalk(applyFunc);
    }

    if (n.isClusterVessel_) {
      for (const cn of n.graph.clusters.get(n).nodes) cn.rdfsWalk(applyFunc);
    } else {
      const s = n.graph.sequences.get(n);
      if (s !== undefined) {
        for (const step of s.nodes) step.rdfsWalk(applyFunc);
      }
    }

    applyFunc(n);
  },

  walkRDFS(apply) {
    this.rdfsWalk(apply);
  },

  container_() {
    if (clusterIsActive(this.cluster)) return this.cluster.vessel.container;
    else if (sequenceIsActive(this.sequence)) return this.sequence.vessel.container;
    return this.container;
  },

  containerLevel_() {
    let level = 0;
    for (let curr = this; curr !== null; curr = curr.container_()) level++;
    return level;
  },

  containerLevel() {
    return this.containerLevel_();
  },

  /**
   * returns the most nested container that is an ancestor of both n and otherNode. In this example X.nearestSharedAncestor(Y) returns B;
   * C, D, and E are nearer to the nodes X and Y, but are not a shared ancestor. A and nil are shared ancestors, but are further than B.
   */
  nearestSharedAncestor_(otherNode) {
    let container = this.container_();
    let otherContainer = otherNode.container_();
    if (container === null || otherContainer === null) return null;
    let nLevel = this.containerLevel_();
    let otherLevel = otherNode.containerLevel_();

    while (container !== otherContainer) {
      if (nLevel === otherLevel) {
        container = container.container_();
        nLevel--;
        otherContainer = otherContainer.container_();
        otherLevel--;
      } else if (nLevel > otherLevel) {
        container = container.container_();
        nLevel--;
      } else {
        otherContainer = otherContainer.container_();
        otherLevel--;
      }
      if (container === null || otherContainer === null) return null;
    }
    return container;
  },

  nearestSharedAncestor(other) {
    return this.nearestSharedAncestor_(other);
  },

  transpose_() {
    const n = this;
    [n.box.Width, n.box.Height] = [n.box.Height, n.box.Width];
    n.topLeft.transpose();
    [n.padding.left, n.padding.top] = [n.padding.top, n.padding.left];
    [n.padding.right, n.padding.bottom] = [n.padding.bottom, n.padding.right];
    [n.margin.left, n.margin.top] = [n.margin.top, n.margin.left];
    [n.margin.right, n.margin.bottom] = [n.margin.bottom, n.margin.right];
  },

  transpose() {
    this.transpose_();
  },

  /** ContainerDirection reports the layout direction of n's owning container. */
  containerDirection() {
    return this.graph.direction(this.container_());
  },

  pad(padding) {
    const pad = padding;
    this.translate_(-pad, -pad);
    this.width += 2 * pad;
    this.height += 2 * pad;
  },

  /** [dx, dy] */
  modifierElementAdjustments_() {
    let dx = 0, dy = 0;
    if (this.is3D) {
      if (this.shapeType_ === hexagonType) dy = threeDOffset / 2;
      else dy = threeDOffset;
      dx = threeDOffset;
    } else if (this.isMultiple) {
      dy = multipleOffset;
      dx = multipleOffset;
    }
    return [dx, dy];
  },

  modifierElementAdjustments() {
    return this.modifierElementAdjustments_();
  },

  // ---- the methods Node gets from its embedded nodeshape.Shape (and geo.Box) ----
  snapPointPercentages() { return this.shape.snapPointPercentages(); },
  mirroredPortIndices() { return this.shape.mirroredPortIndices(); },
  centerPortIndices() { return this.shape.centerPortIndices(); },
  portIndices(orientation) { return this.shape.portIndices(orientation); },
  centerPortIndex(orientation) { return this.shape.centerPortIndex(orientation); },
  labelPositionPreferences(tier) { return this.shape.labelPositionPreferences(tier); },
  getType() { return this.shape.getType(); },
  getBox() { return this.shape.getBox(); },
  getInnerBox() { return this.shape.getInnerBox(); },
  getInsidePlacement(w, h, padX, padY) { return this.shape.getInsidePlacement(w, h, padX, padY); },
  getDimensionsToFit(w, h, padX, padY) { return this.shape.getDimensionsToFit(w, h, padX, padY); },
  getDefaultPadding() { return this.shape.getDefaultPadding(); },
  is(shapeType) { return this.shape.is(shapeType); },
  aspectRatio1() { return this.shape.aspectRatio1(); },
  isRectangular() { return this.shape.isRectangular(); },
  perimeter() { return this.shape.perimeter(); },
});

const numCmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0); // slices.Sort on float64 (no NaN in practice)

// ==== layout.go ====

/** EdgeAbduction represents the temporary transfer of an edge from a descendant container to the ancestor child so node placement can operate on containers. */
export class EdgeAbduction {
  constructor() {
    this.edge = null;
    this.originallyFrom = null;
    this.originallyTo = null;
    this.currentFrom = null;
    this.currentTo = null;
  }
}

/** maybeDescendant.isDescendantOf(maybeAncestor) for a possibly nil maybeDescendant. */
export function isDescendantOf(maybeDescendant, maybeAncestor) {
  if (maybeAncestor === maybeDescendant) return true;
  if (maybeDescendant === null) return false;
  if (maybeDescendant.container !== null) return isDescendantOf(maybeDescendant.container, maybeAncestor);
  if (maybeDescendant.cluster !== null) return isDescendantOf(maybeDescendant.cluster.vessel, maybeAncestor);
  if (maybeDescendant.sequence !== null) return isDescendantOf(maybeDescendant.sequence.vessel, maybeAncestor);
  // Covers the case of nil ancestor
  return maybeAncestor === null;
}

Node.prototype.isDescendantOf_ = function (maybeAncestor) {
  return isDescendantOf(this, maybeAncestor);
};
Node.prototype.isDescendantOf = function (ancestor) {
  return isDescendantOf(this, ancestor);
};

Object.assign(Graph.prototype, {
  /** ClusterRDFSOrder returns cluster vessels in reverse depth-first container order. */
  clusterRDFSOrder() {
    const order = [];

    const dfsContainerOrder = this.containerRDFSOrder_(null).concat([null]);
    for (const container of dfsContainerOrder) {
      for (const child of containersOf(this, container)) {
        if (child.isClusterVessel_) order.push(child);
      }
    }

    return order;
  },

  /** ClusterOrder returns cluster vessels in stable ID order. */
  clusterOrder() {
    const order = [...this.clusters.keys()];
    sortNodesByID_(order);
    return order;
  },

  /** TreeOrder returns tree sentinels in stable ID order. */
  treeOrder() {
    const order = [...this.trees.keys()];
    sortNodesByID_(order);
    return order;
  },

  /** SequenceOrder returns sequence vessels in stable ID order. */
  sequenceOrder() {
    const order = [...this.sequences.keys()];
    sortNodesByID_(order);
    return order;
  },

  applyEdgeAbductions_(edgeAbductions) {
    for (const edgeAbduction of edgeAbductions) {
      if (edgeAbduction.originallyFrom !== null && edgeAbduction.currentFrom !== null && edgeAbduction.originallyFrom !== edgeAbduction.currentFrom) {
        edgeAbduction.edge.reconnect_(edgeAbduction.currentFrom, false);
      }
      if (edgeAbduction.originallyTo !== null && edgeAbduction.currentTo !== null && edgeAbduction.originallyTo !== edgeAbduction.currentTo) {
        edgeAbduction.edge.reconnect_(edgeAbduction.currentTo, true);
      }
    }
  },

  applyEdgeAbductions(abductions) {
    this.applyEdgeAbductions_(abductions);
  },

  restoreEdgeAbductions_(edgeAbductions) {
    const g = this;
    const nodes = new Set();
    const queue = [...g.nodes];
    for (let head = 0; head < queue.length; head++) {
      const node = queue[head];
      nodes.add(node);
      if (node.isContainer_) queue.push(...containersOf(g, node));
      const s = g.sequences.get(node);
      if (s !== undefined) queue.push(...s.nodes);
      if (node.isClusterVessel_) queue.push(...g.clusters.get(node).nodes);
    }
    // Assign edges back to children
    const remainingAbductions = [];
    for (const edgeAbduction of edgeAbductions) {
      let existsFrom = nodes.has(edgeAbduction.originallyFrom);
      if (edgeAbduction.originallyFrom === null) existsFrom = nodes.has(edgeAbduction.currentFrom);
      let existsTo = nodes.has(edgeAbduction.originallyTo);
      if (edgeAbduction.originallyTo === null) existsTo = nodes.has(edgeAbduction.currentTo);
      if (!existsFrom || !existsTo) {
        remainingAbductions.push(edgeAbduction);
        continue;
      }
      if (edgeAbduction.originallyFrom !== null) {
        // If it is a cluster child, assign back to vessel
        if (edgeAbduction.originallyFrom.cluster !== null) edgeAbduction.originallyFrom = edgeAbduction.originallyFrom.cluster.vessel;
        // If it is a sequence child, assign back to vessel
        if (edgeAbduction.originallyFrom.sequence !== null) edgeAbduction.originallyFrom = edgeAbduction.originallyFrom.sequence.vessel;

        // If simple cluster abduction, edge didn't change
        if (edgeAbduction.currentFrom !== edgeAbduction.originallyFrom) edgeAbduction.edge.reconnect_(edgeAbduction.originallyFrom, false);
      }
      if (edgeAbduction.originallyTo !== null) {
        if (edgeAbduction.originallyTo.cluster !== null) edgeAbduction.originallyTo = edgeAbduction.originallyTo.cluster.vessel;
        if (edgeAbduction.originallyTo.sequence !== null) edgeAbduction.originallyTo = edgeAbduction.originallyTo.sequence.vessel;
        if (edgeAbduction.currentTo !== edgeAbduction.originallyTo) edgeAbduction.edge.reconnect_(edgeAbduction.originallyTo, true);
      }
    }
    return remainingAbductions;
  },

  restoreEdgeAbductions(edgeAbductions) {
    return this.restoreEdgeAbductions_(edgeAbductions);
  },

  /**
   * Edge abduction temporarily reassigns edges between a container's descendants to the container's children, to make node placement
   * work on containers instead of moving around container children. We still store data on these edge reassignments so that
   * 1. we can revert back after node placement 2. we can resolve the true location of nodes within containers for median and edge
   * length calculations. (Go ranges over fromGraph.Clusters and fromGraph.Sequences to collect the existing abductions; this port
   * uses insertion order.)
   */
  abductEdges_(container, toGraph) {
    const fromGraph = this;
    const edgeAbductions = [];
    for (const cluster of fromGraph.clusters.values()) edgeAbductions.push(...cluster.edgeAbductions);
    for (const sequence of fromGraph.sequences.values()) edgeAbductions.push(...sequence.edgeAbductions);

    const used = new Array(edgeAbductions.length).fill(false);
    const containerAbductions = [];
    // Find the edges which are connected to a descendant at one end and to a child at another end
    for (const edge of fromGraph.edges) {
      let fromAChild = false;
      let toAChild = false;

      let fromAChildDescendant = false;
      let toAChildDescendant = false;

      let fromChildAncestor = null;
      let toChildAncestor = null;

      for (const child of containersOf(fromGraph, container)) {
        if (child === edge.from) {
          fromAChild = true;
        } else if (edge.from.isDescendantOf_(child)) {
          fromAChildDescendant = true;
          fromChildAncestor = child;
        }
        if (child === edge.to) {
          toAChild = true;
        } else if (edge.to.isDescendantOf_(child)) {
          toAChildDescendant = true;
          toChildAncestor = child;
        }
      }

      if ((fromAChild && (edge.from === toChildAncestor)) || (toAChild && (edge.to === fromChildAncestor))) {
        // This is an intra-container edge (points from a child into a descendant of child, or vice versa)
        // Do nothing special for now, just ignore the edge during placement and restore it at the end to avoid panics
        const ea = new EdgeAbduction();
        ea.edge = edge;
        ea.originallyTo = edge.to;
        ea.originallyFrom = edge.from;
        containerAbductions.push(ea);
        edge.from.removeEdge(edge);
        edge.to.removeEdge(edge);
      } else if (fromAChild && toAChild) {
        toGraph.addEdge(edge);
        for (let i = 0; i < edgeAbductions.length; i++) {
          const ea = edgeAbductions[i];
          if (used[i]) continue;
          if (ea.currentFrom === edge.from && ea.currentTo === edge.to) {
            const containerAbduction = new EdgeAbduction();
            containerAbduction.edge = edge;
            containerAbduction.currentFrom = edge.from;
            containerAbduction.currentTo = edge.to;
            if (ea.originallyFrom !== null) containerAbduction.originallyFrom = ea.originallyFrom;
            else containerAbduction.originallyTo = ea.originallyTo;
            used[i] = true;
            containerAbductions.push(containerAbduction);
            break;
          }
        }
      } else if (fromAChildDescendant && toAChild) {
        // Else, if the edge is connected at one end to a child and another to a nested child, then temporarily reassign
        const ea = new EdgeAbduction();
        ea.edge = edge;
        ea.originallyFrom = edge.from;
        ea.currentFrom = fromChildAncestor;
        ea.currentTo = edge.to;
        containerAbductions.push(ea);
        edge.reconnect_(fromChildAncestor, false);
        toGraph.addEdge(edge);
      } else if (toAChildDescendant && fromAChild) {
        const ea = new EdgeAbduction();
        ea.edge = edge;
        ea.originallyTo = edge.to;
        ea.currentTo = toChildAncestor;
        ea.currentFrom = edge.from;
        containerAbductions.push(ea);
        edge.reconnect_(toChildAncestor, true);
        toGraph.addEdge(edge);
      } else if (fromAChildDescendant && toAChildDescendant && (fromChildAncestor !== toChildAncestor)) {
        // Edge can also be from one child descendant to another. But if they are the same ancestor, then leave it be
        const ea = new EdgeAbduction();
        ea.edge = edge;
        ea.originallyTo = edge.to;
        ea.originallyFrom = edge.from;
        ea.currentTo = toChildAncestor;
        ea.currentFrom = fromChildAncestor;
        containerAbductions.push(ea);
        edge.reconnect_(fromChildAncestor, false);
        edge.reconnect_(toChildAncestor, true);
        toGraph.addEdge(edge);
      }
    }

    // For every edge abduction, the current or original pointer at to or from can be a vessel
    for (const containerAbduction of containerAbductions) {
      for (let i = 0; i < edgeAbductions.length; i++) {
        const ea = edgeAbductions[i];
        if (used[i]) continue;
        let match = false;

        if (containerAbduction.originallyFrom === null) { // Must have abducted To
          if (containerAbduction.currentFrom === ea.currentFrom && containerAbduction.originallyTo === ea.currentTo) match = true;
        } else if (containerAbduction.originallyTo === null) { // Must have abducted From
          if (containerAbduction.currentTo === ea.currentTo && containerAbduction.originallyFrom === ea.currentFrom) match = true;
        } else if (containerAbduction.originallyTo === ea.currentTo && containerAbduction.originallyFrom === ea.currentFrom) { // Must have abducted both
          match = true;
        }
        if (match) {
          used[i] = true;
          if (ea.originallyFrom !== null) containerAbduction.originallyFrom = ea.originallyFrom;
          else containerAbduction.originallyTo = ea.originallyTo;
          break;
        }
      }
    }

    return containerAbductions;
  },

  abductEdges(container, toGraph) {
    return this.abductEdges_(container, toGraph);
  },

  computeNodeSpacing() {
    for (const node of this.nodes) node.updateSpacing();
  },
});

// ==== edge.go ====

/** facingTablePortValues */
function facingTablePortValues(orientation) {
  return { from: new geo.Point(), to: new geo.Point(), hasFrom: false, hasTo: false, orientation };
}

export const Edges = {
  /** return map (PointMap<Edge[]>) to lookup the edges connected to each port of the node */
  portEdges_(edges, node) {
    const portEdges = new PointMap();
    for (const edge of edges) {
      let port;
      if (edge.from === node) port = edge.sourcePort();
      else if (edge.to === node) port = edge.targetPort();
      else continue;
      if (port === null) continue;

      if (!portEdges.has(port)) portEdges.set(port, []);
      portEdges.get(port).push(edge);
    }
    return portEdges;
  },

  portEdges(edges, node) {
    return Edges.portEdges_(edges, node);
  },
};

Object.assign(Edge.prototype, {
  equivalentStyles(e2) {
    return this.stylesMatchOneWay(e2) && e2.stylesMatchOneWay(this);
  },

  stylesMatchOneWay(e2) {
    const e1 = this;
    for (const k of ['opacity', 'stroke', 'strokeWidth', 'strokeDash', 'animated']) {
      if (e1.style[k] !== null) {
        if (!(e2.style[k] !== null && e2.style[k].value === e1.style[k].value)) return false;
      }
    }
    return true;
  },

  isTreeEdge_() {
    if (this.from.graph.nodeToTree !== null && this.from.graph.nodeToTree.has(this.from)) return true;
    if (this.to.graph.nodeToTree !== null && this.to.graph.nodeToTree.has(this.to)) return true;
    return false;
  },

  isTreeEdge() {
    return this.isTreeEdge_();
  },

  sourcePort() {
    if (this.points.length === 0) return null;
    return this.points[0];
  },

  targetPort() {
    if (this.points.length === 0) return null;
    return this.points[this.points.length - 1];
  },

  entityID() {
    return this.id;
  },

  idValue() {
    return this.entityID();
  },

  isLoop_() {
    return this.from === this.to;
  },

  isLoop() {
    return this != null && this.isLoop_();
  },

  hasSourceArrow() {
    return this.sourceArrowhead !== '' && this.sourceArrowhead !== NoArrowhead;
  },

  hasTargetArrow() {
    return this.targetArrowhead !== '' && this.targetArrowhead !== NoArrowhead;
  },

  isDirected_() {
    return this.hasSourceArrow() !== this.hasTargetArrow();
  },

  isDirected() {
    return this.isDirected_();
  },

  isBidirectional_() {
    return this.hasSourceArrow() && this.hasTargetArrow();
  },

  isBidirectional() {
    return this.isBidirectional_();
  },

  isUndirected_() {
    return !this.hasSourceArrow() && !this.hasTargetArrow();
  },

  isUndirected() {
    return this.isUndirected_();
  },

  /**
   * directedEndpoints returns the semantic source and target of a directed edge: [from, to, ok]. Edge.From and Edge.To preserve
   * declaration order, so a source-arrow-only edge points from To to From.
   */
  directedEndpoints_() {
    if (this == null || !this.isDirected_()) return [null, null, false];
    if (this.hasSourceArrow()) return [this.to, this.from, true];
    return [this.from, this.to, true];
  },

  directedEndpoints() {
    return this.directedEndpoints_();
  },

  ownArrowheadsMatch_() {
    return this.sourceArrowhead === this.targetArrowhead;
  },

  ownArrowheadsMatch() {
    return this.ownArrowheadsMatch_();
  },

  hasMatchingArrowheads(otherEdge) {
    const edge = this;
    if (edge.sourceArrowhead === otherEdge.sourceArrowhead && edge.targetArrowhead === otherEdge.targetArrowhead) return true;
    if (edge.sourceArrowhead === otherEdge.targetArrowhead && edge.targetArrowhead === otherEdge.sourceArrowhead) return true;
    return false;
  },

  matchingArrowheads(other) {
    return this.hasMatchingArrowheads(other);
  },

  hasArrowTo_(node) {
    return (node === this.from && this.hasSourceArrow()) || (node === this.to && this.hasTargetArrow());
  },

  hasArrowTo(node) {
    return this.hasArrowTo_(node);
  },

  arrowheadTo_(node) {
    if (node === this.from) return this.sourceArrowhead;
    return this.targetArrowhead;
  },

  arrowheadTo(node) {
    return this.arrowheadTo_(node);
  },

  debugID() {
    const e = this;
    let arrow = '-';
    if (e.hasSourceArrow()) arrow = '<' + arrow;
    if (e.hasTargetArrow()) arrow += '>';
    if (!e.hasSourceArrow() && !e.hasTargetArrow()) arrow += '-';
    let from = e.from.debugID();
    if (e.fromTableColumnIndex !== null) from = `${from}[${e.fromTableColumnIndex}]`;
    let to = e.to.debugID();
    if (e.toTableColumnIndex !== null) to = `${to}[${e.toTableColumnIndex}]`;
    let lbl = '';
    if (e.label !== null) lbl = ': ' + e.label.text;
    return `${from} ${arrow} ${to}${lbl}`;
  },

  isBetweenTableColumns_() {
    return this.fromTableColumnIndex !== null && this.toTableColumnIndex !== null;
  },

  isBetweenTableColumns() {
    return this.isBetweenTableColumns_();
  },

  hasTableColumn_() {
    return this.fromTableColumnIndex !== null || this.toTableColumnIndex !== null;
  },

  hasTableColumn() {
    return this.hasTableColumn_();
  },

  isClusterEdge_() {
    return this.from.cluster !== null || this.to.cluster !== null;
  },

  /** IsClusterEdge reports whether either endpoint is currently represented by a cluster grouping. */
  isClusterEdge() {
    return this != null && this.isClusterEdge_();
  },

  euclideanDistance_() {
    return this.from.distance(this.to, true);
  },

  euclideanDistance() {
    return this.euclideanDistance_();
  },

  segmentCount() {
    // One point for source and one for target centers = 2 for a straight line
    return this.points.length - 1;
  },

  numSegments() {
    return this.segmentCount();
  },

  /**
   * reconnect takes care of reassigning an edge
   * 1. Update the other endpoint's adjacent nodes to replace old one with new
   * 2. Update the new endpoint's adjacent nodes to include the other endpoint
   * 3. Remove the other endpoint from the old endpoint's adjacent nodes
   * 4. Reassign the edge pointers
   */
  reconnect_(newEndpoint, isTo) {
    const e = this;
    if (isTo) {
      e.to.removeEdge(e);
      newEndpoint.addEdge(e);

      e.to = newEndpoint;
    } else {
      e.from.removeEdge(e);
      newEndpoint.addEdge(e);

      e.from = newEndpoint;
    }
  },

  reconnect(node, to) {
    this.reconnect_(node, to);
  },

  /** isAxisAligned checks if the connected ends are axis aligned. Test is to draw a line through the center and see if it overlaps */
  isAxisAligned_() {
    const e = this;
    if (e.from === null || e.to === null) return false;

    if (e.hasTableColumn_()) {
      const ports = e.facingTablePorts(null, null);
      if (ports.hasFrom && ports.hasTo) {
        if (geo.precisionCompare(ports.from.y, ports.to.y, AxisAlignmentTolerance) === 0) return true;
      } else if (ports.hasFrom) {
        if (geo.precisionCompare(ports.from.y, e.to.topLeft.y + e.to.height / 2, AxisAlignmentTolerance) === 0) return true;
      } else if (ports.hasTo) {
        if (geo.precisionCompare(ports.to.y, e.from.topLeft.y + e.from.height / 2, AxisAlignmentTolerance) === 0) return true;
      } else if (geo.precisionCompare(e.from.topLeft.x, e.to.topLeft.x, AxisAlignmentTolerance) === 0) {
        // if the tables are stacked, consider them aligned one of the sides is aligned
        return true;
      } else if (geo.precisionCompare(e.from.topLeft.x + e.from.width, e.to.topLeft.x + e.to.width, AxisAlignmentTolerance) === 0) {
        return true;
      }
      return false;
    }

    // Horizontal alignment
    if (geo.precisionCompare(e.from.topLeft.y + e.from.height / 2, e.to.topLeft.y + e.to.height / 2, AxisAlignmentTolerance) === 0) return true;

    // Vertical alignment
    if (geo.precisionCompare(e.from.topLeft.x + e.from.width / 2, e.to.topLeft.x + e.to.width / 2, AxisAlignmentTolerance) === 0) return true;

    return false;
  },

  isAxisAligned() {
    return this.isAxisAligned_();
  },

  isDuplicateOf_(otherEdge) {
    const edge = this;
    if (otherEdge.to === edge.to && otherEdge.from === edge.from) return true;
    if (otherEdge.from === edge.to && otherEdge.to === edge.from) return true;
    return false;
  },

  isDuplicateOf(other) {
    return this.isDuplicateOf_(other);
  },

  hasDuplicateIn_(edges) {
    for (const otherEdge of edges) {
      if (otherEdge.isDuplicateOf_(this)) return true;
    }
    return false;
  },

  hasDuplicateIn(edges) {
    return this.hasDuplicateIn_(edges);
  },

  length() {
    return geo.Route.length(this.points);
  },

  /** LabelTopLeft returns the top-left point for a label of the given size and position on edge. */
  labelTopLeft(labelPosition, width, height) {
    const [point] = label.getPointOnRoute(labelPosition, this.points, edgeStrokeWidth, this.labelPercentage, width, height);
    return point;
  },

  bounds() {
    return this.boundingBoxValues_();
  },

  boundingBox() {
    return this.bounds();
  },

  /** [tl, br] (fresh geo.Point values) */
  boundingBoxValues_() {
    const e = this;
    const tl = new geo.Point(Infinity, Infinity);
    const br = new geo.Point(-Infinity, -Infinity);

    for (const p of e.points) {
      tl.x = Math.min(tl.x, p.x);
      tl.y = Math.min(tl.y, p.y);
      br.x = Math.max(br.x, p.x);
      br.y = Math.max(br.y, p.y);
    }

    if (e.label !== null && e.points.length !== 0 && e.label.position !== label.Unset) {
      const labelTL = e.labelTopLeft(e.label.position, e.label.width, e.label.height);
      tl.x = Math.min(tl.x, labelTL.x);
      tl.y = Math.min(tl.y, labelTL.y);
      br.x = Math.max(br.x, labelTL.x + e.label.width);
      br.y = Math.max(br.y, labelTL.y + e.label.height);
    }
    if (e.points.length > 0) {
      let lbl = e.sourceArrowheadLabel;
      if (lbl !== null) {
        const labelTL = labelgeom.arrowheadTopLeft(e.points, false, e.sourceArrowhead, e.targetArrowhead, lbl.width, lbl.height);
        tl.x = Math.min(tl.x, labelTL.x);
        tl.y = Math.min(tl.y, labelTL.y);
        br.x = Math.max(br.x, labelTL.x + lbl.width);
        br.y = Math.max(br.y, labelTL.y + lbl.height);
      }
      lbl = e.targetArrowheadLabel;
      if (lbl !== null) {
        const labelTL = labelgeom.arrowheadTopLeft(e.points, true, e.sourceArrowhead, e.targetArrowhead, lbl.width, lbl.height);
        tl.x = Math.min(tl.x, labelTL.x);
        tl.y = Math.min(tl.y, labelTL.y);
        br.x = Math.max(br.x, labelTL.x + lbl.width);
        br.y = Math.max(br.y, labelTL.y + lbl.height);
      }
    }

    tl.x = goRound(tl.x);
    tl.y = goRound(tl.y);
    br.x = goRound(br.x);
    br.y = goRound(br.y);
    return [tl, br];
  },

  boundingBoxValues() {
    return this.boundingBoxValues_();
  },

  isTargetedTo_(n) {
    return this.hasArrowTo_(n);
  },

  isTargetedTo(node) {
    return this.isTargetedTo_(node);
  },

  /**
   * facingTablePorts returns the ports related to the connected tables if they are properly aligned. If one table is on top of the
   * other, there's no way to choose the proper direction and then there are no ports to return.
   * Returns {from, to, hasFrom, hasTo, orientation}.
   */
  facingTablePorts(abductionFrom, abductionTo) {
    const e = this;
    if (!e.hasTableColumn_()) return facingTablePortValues(Orientation.NONE);
    let from = e.from;
    if (abductionFrom != null) from = abductionFrom;
    let to = e.to;
    if (abductionTo != null) to = abductionTo;
    const orientation = from.orientation_(to);
    const ports = facingTablePortValues(orientation);
    switch (orientation) {
      case Orientation.TopLeft: case Orientation.BottomLeft: case Orientation.Left:
        if (e.fromTableColumnIndex !== null) [ports.from, ports.hasFrom] = from.tableColumnPortValue(Orientation.Right, e.fromTableColumnIndex);
        if (e.toTableColumnIndex !== null) [ports.to, ports.hasTo] = to.tableColumnPortValue(Orientation.Left, e.toTableColumnIndex);
        return ports;
      case Orientation.Right: case Orientation.TopRight: case Orientation.BottomRight:
        if (e.fromTableColumnIndex !== null) [ports.from, ports.hasFrom] = from.tableColumnPortValue(Orientation.Left, e.fromTableColumnIndex);
        if (e.toTableColumnIndex !== null) [ports.to, ports.hasTo] = to.tableColumnPortValue(Orientation.Right, e.toTableColumnIndex);
        return ports;
    }
    return facingTablePortValues(Orientation.NONE);
  },

  /** FacingTablePortValues: [from, to, hasFrom, hasTo, orientation] */
  facingTablePortValues(from, to) {
    const ports = this.facingTablePorts(from, to);
    return [ports.from, ports.to, ports.hasFrom, ports.hasTo, ports.orientation];
  },

  hasLargeArrowheadLabel() {
    const e = this;
    // len(string) counts bytes in Go
    const byteLen = (s) => new TextEncoder().encode(s).length;
    return (e.sourceArrowheadLabel !== null && byteLen(e.sourceArrowheadLabel.text) > 3) ||
      (e.targetArrowheadLabel !== null && byteLen(e.targetArrowheadLabel.text) > 3);
  },

  isStraight_() {
    const e = this;
    let p = e.points[0];
    let q = e.points[1];
    for (let i = 2; i < e.points.length; i++) {
      if (orientation(p, q, e.points[i]) !== 0) return false;
      p = q;
      q = e.points[i];
    }
    return true;
  },

  isStraight() {
    return this.isStraight_();
  },

  hasOverlappingEnd_() {
    const e = this;
    const start = e.points[0];
    const end = e.points[e.points.length - 1];

    for (const fromEdge of e.from.edges) {
      if (fromEdge === e) continue;

      if (nonNilEquals(fromEdge.points[0], start) || nonNilEquals(fromEdge.points[fromEdge.points.length - 1], start)) return true;
    }
    for (const toEdge of e.to.edges) {
      if (toEdge === e) continue;

      if (nonNilEquals(toEdge.points[0], end) || nonNilEquals(toEdge.points[toEdge.points.length - 1], end)) return true;
    }
    return false;
  },

  hasOverlappingEnd() {
    return this.hasOverlappingEnd_();
  },

  /** HierarchyRankWeight returns the authored-edge multiplicity represented by a temporary hierarchy DAG edge. */
  hierarchyRankWeight() {
    if (this == null || !this.hierarchyRankWeightSet) return 1;
    return this.hierarchyRankWeight_;
  },

  /** SetHierarchyRankWeight records temporary hierarchy DAG metadata (kept out of graph serialization). */
  setHierarchyRankWeight(weight) {
    this.hierarchyRankWeight_ = weight;
    this.hierarchyRankWeightSet = true;
  },
});

// ==== cluster.go ====

/** ClusterGeometryWork for geometry that is not metered: step/finish do nothing and the movement operations are the plain ones. */
export const unmeteredGroupGeometry = {
  step() {},
  finish() {},
  moveNodeWithChildren(node, dx, dy) {
    node.moveNodeWithChildren(dx, dy);
  },
  positionContainerChildren(node) {
    node.positionContainerChildren_(false);
  },
};

Object.assign(Cluster.prototype, {
  /** Resize makes the cluster nodes consistent in size, and sizes the vessel to exact fit of cluster nodes. */
  resize(vessel) {
    this.resizeWithWork(vessel, unmeteredGroupGeometry);
  },

  resizeWithWork(vessel, work) {
    const c = this;
    if (c == null || vessel == null) throw invariant.newError('cluster is missing its vessel');
    if (!c.fixedSize) {
      const [nodeWidth, nodeHeight] = c.maximumsWithWork(work);

      for (const node of c.nodes) {
        work.step();
        node.width = nodeWidth;
        node.height = nodeHeight;
      }
    }
    const [nodeWidth, nodeHeight] = c.maximumsWithWork(work);
    if (c.arrangement === Row) {
      vessel.width = nodeWidth * c.nodes.length + c.padding * (c.nodes.length - 1);
      vessel.height = nodeHeight;
    }

    if (c.arrangement === Column) {
      vessel.width = nodeWidth;
      vessel.height = nodeHeight * c.nodes.length + c.padding * (c.nodes.length - 1);
    }
  },

  /** [maxWidth, maxHeight] */
  maximumsWithWork(work) {
    let maxWidth = 0.0, maxHeight = 0.0;
    for (const node of this.nodes) {
      work.step();
      if (node == null) throw invariant.newError('cluster contains a nil node');
      maxWidth = Math.max(maxWidth, node.width);
    }
    for (const node of this.nodes) {
      work.step();
      maxHeight = Math.max(maxHeight, node.height);
    }
    work.finish();
    return [maxWidth, maxHeight];
  },

  /** ArrangeClusterNodes moves the inner cluster nodes to their respective positions within the cluster. Idempotent. */
  arrangeClusterNodes() {
    this.arrangeNodesWithWork(unmeteredGroupGeometry);
  },

  arrangeNodesWithWork(work) {
    const c = this;
    // Hasn't been initialized yet, which is fine since we arrange all cluster nodes every time for simplicity
    if (c.vessel.topLeft === null) {
      work.finish();
      return;
    }

    if (c.arrangement === Row) {
      let position = c.vessel.topLeft.x;
      const vesselCenter = c.vessel.topLeft.y + c.vessel.height / 2;

      for (const node of c.nodes) {
        work.step();
        if (node.topLeft !== null) {
          const dx = position - node.topLeft.x;
          const dy = goRound(vesselCenter - (node.topLeft.y + node.height / 2));
          work.moveNodeWithChildren(node, dx, dy);
        } else {
          node.topLeft = geo.newPoint(position, goRound(vesselCenter - node.height / 2));
          work.positionContainerChildren(node);
        }
        position += node.width + c.padding;
      }
    }

    if (c.arrangement === Column) {
      let position = c.vessel.topLeft.y;
      const vesselCenter = c.vessel.topLeft.x + c.vessel.width / 2;

      for (const node of c.nodes) {
        work.step();
        if (node.topLeft !== null) {
          const dx = goRound(vesselCenter - (node.topLeft.x + node.width / 2));
          const dy = position - node.topLeft.y;
          work.moveNodeWithChildren(node, dx, dy);
        } else {
          node.topLeft = geo.newPoint(goRound(vesselCenter - node.width / 2), position);
          work.positionContainerChildren(node);
        }
        position += node.height + c.padding;
      }
    }
    work.finish();
  },

  debugID() {
    return '[' + this.nodes.map((n) => n.debugID()).join(', ') + ']; Arrangement: ' + this.arrangement;
  },

  /** SyncGeometry resizes the cluster vessel and arranges its visible members. */
  syncGeometry() {
    this.syncGeometryWithWork(unmeteredGroupGeometry);
  },

  syncGeometryWithWork(work) {
    const c = this;
    if (work == null) throw invariant.newError('cluster geometry requires work accounting');
    work.step();
    if (c == null || c.vessel == null) throw invariant.newError('cluster is missing its vessel');
    c.resizeWithWork(c.vessel, work);
    c.arrangeNodesWithWork(work);
  },

  isActive_() {
    return this != null && this.vessel.graph !== null;
  },

  isActive() {
    return this.isActive_();
  },
});

Graph.prototype.syncClusters = function () {
  if (this.clusters.size === 0) return;

  const sync = (n) => {
    if (n.isClusterVessel_) this.clusters.get(n).syncGeometry();
  };
  for (const n of this.nodes) n.rdfsWalk(sync);
};

// ==== sequence.go ====

/** SequenceAdvance is the horizontal distance from one step's top-left to the next. */
export function sequenceAdvance(width) {
  if (width <= 0) return 0;
  let wedge = shape.STEP_WEDGE_WIDTH;
  if (width <= wedge) wedge = width / 2;
  return width - wedge;
}

Object.assign(Sequence.prototype, {
  /** findAbductedNodeByEdge searches for the edge abduction related to the given edge and then returns the original node */
  findAbductedNodeByEdge(e) {
    const s = this;
    for (const ea of s.edgeAbductions) {
      if (e !== ea.edge) continue;
      if (ea.currentFrom === s.vessel) return ea.originallyFrom;
      if (ea.currentTo === s.vessel) return ea.originallyTo;
    }
    return null;
  },

  abductedNodeByEdge(edge) {
    return this.findAbductedNodeByEdge(edge);
  },

  /** SyncGeometry resizes the sequence vessel and arranges its visible steps. */
  syncGeometry() {
    this.syncGeometryWithWork(unmeteredGroupGeometry);
  },

  syncGeometryWithWork(work) {
    const s = this;
    if (work == null) throw invariant.newError('sequence geometry requires work accounting');
    work.step();
    if (s == null || s.vessel == null) throw invariant.newError('sequence is missing its vessel');
    s.resizeWithWork(work);
    s.arrangeStepsWithWork(work);
  },

  resizeWithWork(work) {
    const s = this;
    let width = 0.0;
    let offset = 0.0;
    let height = 0.0;
    for (const n of s.nodes) {
      work.step();
      if (n == null) throw invariant.newError('sequence contains a nil step');
      width = Math.max(width, offset + Math.max(0, n.width));
      offset += sequenceAdvance(n.width);
      height = Math.max(height, Math.max(0, n.height));
    }
    s.vessel.width = width;
    s.vessel.height = height;
  },

  /** ArrangeSteps places visible sequence steps relative to the vessel. */
  arrangeSteps() {
    this.arrangeStepsWithWork(unmeteredGroupGeometry);
  },

  arrangeStepsWithWork(work) {
    const s = this;
    // hasn't been initialized yet
    if (s.vessel.topLeft === null) {
      work.finish();
      return;
    }

    const tl = s.vessel.topLeft.copy();
    for (const n of s.nodes) {
      work.step();
      n.topLeft = tl.copy();
      tl.x += sequenceAdvance(n.width);
    }
    work.finish();
  },

  /** PlaceVessel positions the sequence vessel at the top-left of its steps. */
  placeVessel() {
    const topLeft = geo.newPoint(Infinity, Infinity);
    for (const node of this.nodes) {
      if (node.topLeft === null) return;
      topLeft.x = Math.min(topLeft.x, node.topLeft.x);
      topLeft.y = Math.min(topLeft.y, node.topLeft.y);
    }
    this.vessel.topLeft = topLeft;
  },

  first() {
    return this.nodes[0];
  },

  last() {
    return this.nodes[this.nodes.length - 1];
  },

  isActive_() {
    return this != null && this.vessel.graph !== null;
  },

  isActive() {
    return this.isActive_();
  },

  debugID() {
    return '[' + this.nodes.map((n) => n.debugID()).join(', ') + ']';
  },
});

Graph.prototype.syncSequences = function () {
  if (this.sequences.size === 0) return;

  const sync = (n) => {
    const sequence = this.sequences.get(n);
    if (sequence !== undefined) sequence.syncGeometry();
  };
  for (const n of this.nodes) n.rdfsWalk(sync);
};

// ==== tree.go ====

Object.assign(Tree.prototype, {
  recordInternalTreeEdges(isTreeEdge) {
    if (this.parent !== null && this.sentinelEdge !== null) isTreeEdge.set(this.sentinelEdge, true);
    for (const c of this.children) c.recordInternalTreeEdges(isTreeEdge);
  },

  /** tree is either the source or target of its sentinel edge, return true if it is the source */
  isSentinelEdgeSource() {
    return this.sentinelEdge.from === this.node;
  },

  /** return the node this tree is connected to via its sentinel edge */
  sentinelNode_() {
    if (this.isSentinelEdgeSource()) return this.sentinelEdge.to;
    return this.sentinelEdge.from;
  },

  sentinelNode() {
    return this.sentinelNode_();
  },

  root() {
    if (this.parent === null) return this;
    return this.parent.root();
  },
});

Object.assign(Graph.prototype, {
  /** Map<Edge, boolean> of the internal tree edges (not the edge between the tree root and the rootSentinel) */
  buildIsTreeEdgeMap() {
    const isTreeEdge = new Map();
    for (const rootSentinel of this.treeOrder()) {
      for (const root of this.trees.get(rootSentinel)) root.recordInternalTreeEdges(isTreeEdge);
    }
    return isTreeEdge;
  },

  treeEdgeMap() {
    return this.buildIsTreeEdgeMap();
  },

  isIsolatedTree(node) {
    if (node.isContainer_) return false;
    // it is an isolated tree if all edges are to trees
    for (const edge of node.edges) {
      let isToTree = false;
      for (const root of (this.trees.get(node) ?? [])) {
        if (edge === root.sentinelEdge) {
          isToTree = true;
          break;
        }
      }
      if (!isToTree) return false;
    }
    return true;
  },

  addIsolatedTreeEdgesToMap(isTreeEdge) {
    for (const rootSentinel of this.treeOrder()) {
      if (this.isIsolatedTree(rootSentinel)) {
        for (const root of this.trees.get(rootSentinel)) {
          if (root.sentinelEdge !== null) isTreeEdge.set(root.sentinelEdge, true);
        }
      }
    }
  },

  addIsolatedTreeEdges(edges) {
    this.addIsolatedTreeEdgesToMap(edges);
  },
});

// ==== connected_set.go ====

Object.assign(Node.prototype, {
  /**
   * ConnectedNodeSet returns the same reachable set as ConnectedNodes, with no traversal-order guarantee. Use it only when all members
   * are treated equally; order-sensitive nearest-node tie breaking must continue using ConnectedNodes.
   */
  connectedNodeSet(excludedNodes, graph) {
    const node = this;
    // Tiny graphs and flat graphs have too little ownership scanning to amortize an index. Keep their existing traversal.
    if (graph.nodes.length < 32 || (graph.clusters.size === 0 && graph.containers.size <= 1)) {
      return node.connectedNodes_(excludedNodes, graph);
    }
    const excluded = new Set(excludedNodes);
    const excludedChildren = new Set();
    const ownersFirst = new Map();
    const ownersMore = new Map();
    const addOwner = (child, parent) => {
      if (!ownersFirst.has(child) || ownersFirst.get(child) === null) {
        ownersFirst.set(child, parent);
        return;
      }
      if (!ownersMore.has(child)) ownersMore.set(child, []);
      ownersMore.get(child).push(parent);
    };
    for (const [container, children] of graph.containers) {
      if (container === null) continue;
      let blocked = false;
      for (const child of children) {
        if (excluded.has(child)) {
          blocked = true;
          break;
        }
      }
      if (blocked) excludedChildren.add(container);
      if (blocked || excluded.has(container)) continue;
      for (const child of children) addOwner(child, container);
    }
    for (const [vessel, cluster] of graph.clusters) {
      for (const member of cluster.nodes) {
        if (!member.isContainer_ || excludedChildren.has(member)) continue;
        for (const child of containersOf(graph, member)) addOwner(child, vessel);
      }
    }
    const nodes = [];
    const queue = [node];
    const seen = new Set([node]);
    const add = (n) => {
      if (!seen.has(n)) {
        seen.add(n);
        queue.push(n);
      }
    };
    for (let head = 0; head < queue.length; head++) {
      const current = queue[head];
      let blocked = false;
      for (const e of excludedNodes) {
        if (current.isDescendantOf_(e) || (e.isDescendantOf_(current) && !node.isDescendantOf_(current))) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;
      nodes.push(current);
      for (const edge of current.edges) {
        const adjacent = current.adjacent_(edge);
        if (!excluded.has(adjacent)) add(adjacent);
      }
      if (current.isClusterVessel_) {
        for (const member of graph.clusters.get(current).nodes) {
          if (member.isContainer_) {
            for (const child of containersOf(graph, member)) add(child);
          }
        }
      }
      const owner = ownersFirst.get(current);
      if (owner !== undefined && owner !== null) add(owner);
      for (const o of (ownersMore.get(current) ?? [])) add(o);
      if (current !== null && !excluded.has(current) && !excludedChildren.has(current)) {
        for (const child of containersOf(graph, current)) add(child);
      }
    }
    return nodes;
  },
});

// ==== topology_preflight.go ====
// Go charges the spare CAPACITY of every slice here (cap(s) - len(s)); JS arrays have no capacity, so the spare capacity is 0.

const maxEngineTopologyReferences = 1_000_000;
const maxEngineRoutePoints = limits.MaxEngineRoutePoints;
const maxEngineTopologyDepth = limits.MaxEngineTreeDepth;
const maxEnginePreflightWork = maxEngineTopologyReferences * 8;

export const MaxTopologyDepth = maxEngineTopologyDepth;
export const MaxTopologyReferences = maxEngineTopologyReferences;
export const MaxRoutePoints = maxEngineRoutePoints;
export const MaxSerializationTopologyReferences = maxEngineTopologyReferences;
export const MaxSerializationRoutePoints = maxEngineRoutePoints;
export const MaxSerializationPreflightWork = maxEnginePreflightWork;

function validateNodeParentRelation(guard, nodes, relation, parentOf) {
  const state = new Map();
  const depths = new Map();
  for (const node of nodes) {
    if (state.get(node) === 2) continue;
    const path = [];
    let current = node;
    while (current !== null && (state.get(current) ?? 0) === 0) {
      guard.step();
      state.set(current, 1);
      path.push(current);
      current = parentOf(current);
    }
    if (current !== null && state.get(current) === 1) {
      throw errorf(`TALA engine ${relation} cycle detected at node ${current.id}`);
    }
    let depth = 0;
    if (current !== null) depth = depths.get(current) ?? 0;
    for (let i = path.length - 1; i >= 0; i--) {
      const p = path[i];
      depth++;
      if (depth > maxEngineTopologyDepth) throw errorf(`TALA engine ${relation} depth exceeds limit ${maxEngineTopologyDepth}`);
      depths.set(p, depth);
      state.set(p, 2);
    }
  }
}

/** ancestryParent matches the precedence used by isDescendantOf. Keep this separate from container. */
export function ancestryParent(node) {
  if (node === null) return null;
  if (node.container !== null) return node.container;
  if (node.cluster !== null) return node.cluster.vessel;
  if (node.sequence !== null) return node.sequence.vessel;
  return null;
}

/** AncestryParent returns the parent relation used by layout ancestry checks. */
Node.prototype.ancestryParent = function () {
  return ancestryParent(this);
};

/**
 * The bounded inventory both preflights share (Go repeats the closures in validateCombineNodeTopology and validateEngineGraph, which differ
 * only in their message prefix: "TALA CombineSubgraphs" / "TALA engine").
 */
function newInventory(guard, prefix, kindOfNilMessage, withTrees) {
  const inv = {
    referenceCount: 0,
    routePointCount: 0,
    nodes: new Set(),
    edges: new Set(),
    clusters: new Set(),
    sequences: new Set(),
    trees: new Set(),
    abductions: new Set(),
    herds: new Set(),
    hierarchies: new Set(),
    nodeQueue: [],
    edgeQueue: [],
    clusterQueue: [],
    sequenceQueue: [],
    treeQueue: [],
    abductionQueue: [],
    herdQueue: [],
    hierarchyQueue: [],
  };
  const addReference = (kind) => {
    if (inv.referenceCount >= maxEngineTopologyReferences) {
      throw errorf(`${prefix} topology references exceed limit ${maxEngineTopologyReferences} while visiting ${kind}`);
    }
    inv.referenceCount++;
    guard.step();
  };
  inv.structuralNil = (kind) => errorf(kindOfNilMessage(kind));
  inv.accountSpareCapacity = (kind, length, capacity) => {
    if (capacity < length) throw errorf(`${prefix} ${kind} has invalid slice capacity`);
    const spare = capacity - length;
    if (spare > maxEngineTopologyReferences - inv.referenceCount) {
      throw errorf(`${prefix} topology references exceed limit ${maxEngineTopologyReferences} while reserving ${kind} capacity`);
    }
    inv.referenceCount += spare;
    guard.check();
  };
  inv.queueNode = (node, required, kind) => {
    if (node == null) {
      if (required) throw inv.structuralNil(kind);
      return;
    }
    addReference(kind);
    if (inv.nodes.has(node)) return;
    if (inv.nodes.size >= maxEngineNodes) throw errorf(`${prefix} unique node count exceeds limit ${maxEngineNodes}`);
    inv.nodes.add(node);
    inv.nodeQueue.push(node);
  };
  inv.queueEdge = (edge, required, kind) => {
    if (edge == null) {
      if (required) throw inv.structuralNil(kind);
      return;
    }
    addReference(kind);
    if (inv.edges.has(edge)) return;
    if (inv.edges.size >= maxEngineEdges) throw errorf(`${prefix} unique edge count exceeds limit ${maxEngineEdges}`);
    inv.edges.add(edge);
    inv.edgeQueue.push(edge);
  };
  const queueSimple = (set, queue) => (item, required, kind) => {
    if (item == null) {
      if (required) throw inv.structuralNil(kind);
      return;
    }
    addReference(kind);
    if (!set.has(item)) {
      set.add(item);
      queue.push(item);
    }
  };
  inv.queueCluster = queueSimple(inv.clusters, inv.clusterQueue);
  inv.queueSequence = queueSimple(inv.sequences, inv.sequenceQueue);
  inv.queueTree = queueSimple(inv.trees, inv.treeQueue);
  inv.queueAbduction = queueSimple(inv.abductions, inv.abductionQueue);
  inv.queueHerd = queueSimple(inv.herds, inv.herdQueue);
  inv.queueHierarchy = queueSimple(inv.hierarchies, inv.hierarchyQueue);

  /** drain: the work loop of the inventory, in the order of the Go switch. */
  inv.drain = () => {
    const idx = { node: 0, edge: 0, cluster: 0, sequence: 0, tree: 0, abduction: 0, herd: 0, hierarchy: 0 };
    while (idx.node < inv.nodeQueue.length || idx.edge < inv.edgeQueue.length || idx.cluster < inv.clusterQueue.length ||
      idx.sequence < inv.sequenceQueue.length || (withTrees && idx.tree < inv.treeQueue.length) || idx.abduction < inv.abductionQueue.length ||
      idx.herd < inv.herdQueue.length || idx.hierarchy < inv.hierarchyQueue.length) {
      if (idx.node < inv.nodeQueue.length) {
        const node = inv.nodeQueue[idx.node++];
        inv.queueNode(node.container, false, 'node container');
        inv.accountSpareCapacity('node edges', node.edges.length, node.edges.length);
        for (const edge of node.edges) inv.queueEdge(edge, true, 'node edge');
        for (const near of node.nears) inv.queueNode(near, true, 'near node');
        if (node.longDistanceNeighborRequirements !== null) {
          for (const neighbor of node.longDistanceNeighborRequirements.keys()) inv.queueNode(neighbor, true, 'long-distance neighbor requirement key');
        }
        inv.queueCluster(node.cluster, false, 'node cluster');
        inv.queueSequence(node.sequence, false, 'node sequence');
        inv.queueHerd(node.herdAssignment, false, 'node herd assignment');
        inv.queueHierarchy(node.hierarchy, false, 'node hierarchy');
      } else if (idx.edge < inv.edgeQueue.length) {
        const edge = inv.edgeQueue[idx.edge++];
        inv.queueNode(edge.from, true, 'edge source');
        inv.queueNode(edge.to, true, 'edge target');
        const pointCapacity = edge.points.length;
        if (pointCapacity > maxEngineRoutePoints - inv.routePointCount) {
          throw errorf(`${prefix} route point count exceeds limit ${maxEngineRoutePoints}`);
        }
        inv.routePointCount += pointCapacity;
        for (const point of edge.points) {
          if (point == null) throw inv.structuralNil('edge route point');
          guard.step();
        }
      } else if (idx.cluster < inv.clusterQueue.length) {
        const cluster = inv.clusterQueue[idx.cluster++];
        inv.queueNode(cluster.vessel, true, 'cluster vessel');
        inv.queueNode(cluster.container, false, 'cluster container');
        inv.accountSpareCapacity('cluster nodes', cluster.nodes.length, cluster.nodes.length);
        for (const node of cluster.nodes) inv.queueNode(node, true, 'cluster node');
        inv.accountSpareCapacity('cluster edge abductions', cluster.edgeAbductions.length, cluster.edgeAbductions.length);
        for (const abduction of cluster.edgeAbductions) inv.queueAbduction(abduction, true, 'cluster edge abduction');
      } else if (idx.sequence < inv.sequenceQueue.length) {
        const sequence = inv.sequenceQueue[idx.sequence++];
        inv.queueNode(sequence.vessel, true, 'sequence vessel');
        inv.queueNode(sequence.container, false, 'sequence container');
        inv.accountSpareCapacity('sequence nodes', sequence.nodes.length, sequence.nodes.length);
        for (const node of sequence.nodes) inv.queueNode(node, true, 'sequence node');
        inv.accountSpareCapacity('sequence edge abductions', sequence.edgeAbductions.length, sequence.edgeAbductions.length);
        for (const abduction of sequence.edgeAbductions) inv.queueAbduction(abduction, true, 'sequence edge abduction');
      } else if (withTrees && idx.tree < inv.treeQueue.length) {
        const tree = inv.treeQueue[idx.tree++];
        inv.queueNode(tree.node, true, 'tree node');
        inv.queueTree(tree.parent, false, 'tree parent');
        inv.queueEdge(tree.sentinelEdge, false, 'tree sentinel edge');
        inv.accountSpareCapacity('tree children', tree.children.length, tree.children.length);
        for (const child of tree.children) inv.queueTree(child, true, 'tree child');
      } else if (idx.abduction < inv.abductionQueue.length) {
        const abduction = inv.abductionQueue[idx.abduction++];
        inv.queueEdge(abduction.edge, true, 'abducted edge');
        for (const [n, kind] of [
          [abduction.originallyFrom, 'abduction original source'],
          [abduction.originallyTo, 'abduction original target'],
          [abduction.currentFrom, 'abduction current source'],
          [abduction.currentTo, 'abduction current target'],
        ]) inv.queueNode(n, false, kind);
      } else if (idx.herd < inv.herdQueue.length) {
        const herd = inv.herdQueue[idx.herd++];
        for (const node of herd.oppositeSidePaired) inv.queueNode(node, true, 'opposite-side herd node');
        for (const node of herd.sameSidePaired) inv.queueNode(node, true, 'same-side herd node');
      } else if (idx.hierarchy < inv.hierarchyQueue.length) {
        const hierarchy = inv.hierarchyQueue[idx.hierarchy++];
        for (const node of hierarchy.level.keys()) inv.queueNode(node, true, 'hierarchy level node');
      }
    }
  };
  return inv;
}

/**
 * validateCombineNodeTopology validates node-owned records across all graphs as one bounded inventory. Split subgraphs intentionally share
 * the large graph-owned entity maps, but each subgraph has its own Nodes and Edges slices.
 */
function validateCombineNodeTopology(ctx, graphs) {
  const guard = limits.newWorkGuard(ctx, 'CombineSubgraphs', maxEngineWorkUnits);
  guard.setLimit(maxEnginePreflightWork);

  const inv = newInventory(guard, 'TALA CombineSubgraphs', (kind) => `TALA CombineSubgraphs node-owned topology contains nil ${kind}`, false);

  for (const graph of graphs) {
    if (graph == null) throw errorf('TALA CombineSubgraphs received a nil graph');
    graph.nodes.forEach((node, i) => {
      if (node == null) throw errorf(`TALA CombineSubgraphs graph node at index ${i} is nil`);
      inv.queueNode(node, true, 'graph node');
    });
    graph.edges.forEach((edge, i) => {
      if (edge == null) throw errorf(`TALA CombineSubgraphs graph edge at index ${i} is nil`);
      inv.queueEdge(edge, true, 'graph edge');
    });
  }

  inv.drain();

  validateNodeParentRelation(guard, inv.nodes, 'container parent', (node) => node.container);
  validateNodeParentRelation(guard, inv.nodes, 'effective container parent', (node) => node.container_());
  validateNodeParentRelation(guard, inv.nodes, 'ancestry parent', ancestryParent);
  guard.finish();
}

/**
 * validateEngineGraph performs a bounded, iterative walk of every runtime topology reference before layout code allocates snapshots or
 * starts work. It intentionally validates structural safety rather than semantic layout policy, which belongs at the adapter boundary.
 */
export function validateEngineGraph(ctx, location, graph) {
  if (graph == null) throw errorf('TALA engine requires a graph');
  const guard = limits.newWorkGuard(ctx, location, maxEngineWorkUnits);
  guard.setLimit(maxEnginePreflightWork);

  const inv = newInventory(guard, 'TALA engine', (kind) => `TALA engine topology contains nil ${kind}`, true);

  inv.accountSpareCapacity('graph nodes', graph.nodes.length, graph.nodes.length);
  graph.nodes.forEach((node, i) => {
    if (node == null) throw errorf(`graph node at index ${i} is nil`);
    inv.queueNode(node, true, 'graph node');
  });
  inv.accountSpareCapacity('graph edges', graph.edges.length, graph.edges.length);
  graph.edges.forEach((edge, i) => {
    if (edge == null) throw errorf(`graph edge at index ${i} is nil`);
    if (edge.from == null || edge.to == null) throw errorf(`graph edge ${edge.entityID()} has unplaced or missing endpoints`);
    inv.queueEdge(edge, true, 'graph edge');
  });

  for (const [container, children] of graph.containers) {
    inv.queueNode(container, false, 'container key');
    inv.accountSpareCapacity('container children', children.length, children.length);
    for (const child of children) inv.queueNode(child, true, 'container child');
  }
  for (const [vessel, cluster] of graph.clusters) {
    inv.queueNode(vessel, true, 'cluster vessel key');
    inv.queueCluster(cluster, true, 'cluster record');
  }
  for (const [vessel, sequence] of graph.sequences) {
    inv.queueNode(vessel, true, 'sequence vessel key');
    inv.queueSequence(sequence, true, 'sequence record');
  }
  for (const [root, roots] of graph.trees) {
    // Root-sentinel trees are intentionally keyed by nil.
    inv.queueNode(root, false, 'tree root key');
    inv.accountSpareCapacity('tree roots', roots.length, roots.length);
    for (const tree of roots) inv.queueTree(tree, true, 'tree root');
  }
  if (graph.nodeToTree !== null) {
    for (const [node, tree] of graph.nodeToTree) {
      inv.queueNode(node, true, 'node-to-tree key');
      inv.queueTree(tree, true, 'node-to-tree value');
    }
  }
  for (const [hub, spokes] of graph.hubs) {
    inv.queueNode(hub, true, 'hub key');
    inv.accountSpareCapacity('hub spokes', spokes.length, spokes.length);
    for (const spoke of spokes) inv.queueNode(spoke, true, 'hub spoke');
  }
  for (const node of graph.directions.keys()) inv.queueNode(node, false, 'direction key');
  if (graph.commonUncleSiblings !== null) {
    for (const [node, siblings] of graph.commonUncleSiblings) {
      inv.queueNode(node, true, 'common-sibling key');
      inv.accountSpareCapacity('common siblings', siblings.length, siblings.length);
      for (const sibling of siblings) inv.queueNode(sibling, true, 'common sibling');
    }
  }

  inv.drain();
  const nodes = inv.nodes;
  const trees = inv.trees;

  // Validate parent chains independently of the declared container map so a stale or hidden parent pointer cannot introduce recursion or
  // excessive depth into later snapshot/layout walks.
  validateNodeParentRelation(guard, nodes, 'container parent', (node) => node.container);

  // Active clusters and sequences override Node.Container in container. Validate that effective parent relation separately.
  validateNodeParentRelation(guard, nodes, 'effective container parent', (node) => node.container_());
  validateNodeParentRelation(guard, nodes, 'ancestry parent', ancestryParent);

  // Every descendant walk in the engine follows the union of direct containers, active cluster membership, and active sequence membership.
  const descendantChildren = (node) => {
    const children = [];
    if (node === null || node.isContainer_) children.push(...containersOf(graph, node));
    if (node !== null && node.isClusterVessel_) {
      const cluster = graph.clusters.get(node);
      if (cluster == null) throw errorf(`TALA engine cluster vessel ${node.id} has no cluster record`);
      children.push(...cluster.nodes);
    }
    if (graph.sequences.has(node)) {
      const sequence = graph.sequences.get(node);
      if (sequence == null) throw inv.structuralNil('sequence record');
      children.push(...sequence.nodes);
    }
    return children;
  };
  const descendantColor = new Map();
  const descendantHeight = new Map();
  const descendantStarts = [];
  if (graph.containers.has(null)) descendantStarts.push(null);
  for (const node of nodes) {
    if (node !== null) descendantStarts.push(node);
  }
  for (const start of descendantStarts) {
    if ((descendantColor.get(start) ?? 0) !== 0) continue;
    const children0 = descendantChildren(start);
    descendantColor.set(start, 1);
    const stack = [{ node: start, children: children0, index: 0 }];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (frame.index >= frame.children.length) {
        const ownHeight = frame.node === null ? 0 : 1;
        let height = ownHeight;
        for (const child of frame.children) {
          const childHeight = ownHeight + (descendantHeight.get(child) ?? 0);
          if (childHeight > height) height = childHeight;
        }
        if (height > maxEngineTopologyDepth) throw errorf(`TALA engine descendant depth exceeds limit ${maxEngineTopologyDepth}`);
        descendantHeight.set(frame.node, height);
        descendantColor.set(frame.node, 2);
        stack.pop();
        continue;
      }
      const child = frame.children[frame.index];
      frame.index++;
      guard.step();
      switch (descendantColor.get(child) ?? 0) {
        case 1:
          throw errorf(`TALA engine descendant cycle detected at node ${child.id}`);
        case 0: {
          const children = descendantChildren(child);
          descendantColor.set(child, 1);
          stack.push({ node: child, children, index: 0 });
        }
      }
    }
  }

  // Tree child links and parent links are both traversed because either side can be stale independently.
  const treeColor = new Map();
  const treeHeight = new Map();
  for (const start of trees) {
    if ((treeColor.get(start) ?? 0) !== 0) continue;
    treeColor.set(start, 1);
    const stack = [{ tree: start, index: 0 }];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (frame.index >= frame.tree.children.length) {
        let height = 1;
        for (const child of frame.tree.children) {
          const childHeight = (treeHeight.get(child) ?? 0) + 1;
          if (childHeight > height) height = childHeight;
        }
        if (height > maxEngineTopologyDepth) throw errorf(`TALA engine tree depth exceeds limit ${maxEngineTopologyDepth}`);
        treeHeight.set(frame.tree, height);
        treeColor.set(frame.tree, 2);
        stack.pop();
        continue;
      }
      const child = frame.tree.children[frame.index];
      frame.index++;
      guard.step();
      switch (treeColor.get(child) ?? 0) {
        case 1:
          throw errorf('TALA engine tree child cycle detected');
        case 0:
          treeColor.set(child, 1);
          stack.push({ tree: child, index: 0 });
      }
    }
  }
  const parentState = new Map();
  const parentDepth = new Map();
  for (const start of trees) {
    if (parentState.get(start) === 2) continue;
    const path = [];
    let current = start;
    while (current !== null && (parentState.get(current) ?? 0) === 0) {
      guard.step();
      parentState.set(current, 1);
      path.push(current);
      current = current.parent;
    }
    if (current !== null && parentState.get(current) === 1) throw errorf('TALA engine tree parent cycle detected');
    let depth = 0;
    if (current !== null) depth = parentDepth.get(current) ?? 0;
    for (let i = path.length - 1; i >= 0; i--) {
      const p = path[i];
      depth++;
      if (depth > maxEngineTopologyDepth) throw errorf(`TALA engine tree depth exceeds limit ${maxEngineTopologyDepth}`);
      parentDepth.set(p, depth);
      parentState.set(p, 2);
    }
  }

  // A serialized tree is a value tree, not a graph: every runtime Tree must therefore have exactly one owning root/parent path.
  const ownedTrees = new Map();
  const treeByNode = new Map();
  for (const roots of graph.trees.values()) {
    for (const root of roots) {
      const stack = [{ tree: root, parent: null }];
      while (stack.length > 0) {
        const frame = stack.pop();
        guard.step();
        if (ownedTrees.has(frame.tree)) {
          const owner = ownedTrees.get(frame.tree);
          if (frame.parent === null) throw errorf('TALA engine tree is listed as more than one root');
          if (owner === frame.parent) throw errorf('TALA engine tree is repeated under one parent');
          throw errorf('TALA engine tree is shared by multiple parents');
        }
        ownedTrees.set(frame.tree, frame.parent);
        const existing = treeByNode.get(frame.tree.node);
        if (existing !== undefined && existing !== frame.tree) throw errorf(`TALA engine node ${frame.tree.node.id} is owned by multiple trees`);
        treeByNode.set(frame.tree.node, frame.tree);

        for (let i = frame.tree.children.length - 1; i >= 0; i--) {
          const child = frame.tree.children[i];
          if (child.parent !== frame.tree) throw errorf('TALA engine tree child has an inconsistent parent');
          stack.push({ tree: child, parent: frame.tree });
        }
      }
    }
  }
  for (const roots of graph.trees.values()) {
    for (const root of roots) {
      if (root.parent === null) continue;
      // Placement-tree construction temporarily attaches an installed root beneath a placement-only wrapper.
      if (ownedTrees.has(root.parent)) throw errorf('TALA engine tree root also has an installed parent');
      let occurrences = 0;
      for (const child of root.parent.children) {
        guard.step();
        if (child === root) occurrences++;
      }
      if (occurrences !== 1) throw errorf('TALA engine tree root has an inconsistent placement parent');
    }
  }

  // NodeToTree is derived state and may legitimately be absent on a freshly constructed graph. When present alongside an installed forest,
  // however, it must be the exact inverse of Tree.Node.
  const nodeToTree = graph.nodeToTree ?? new Map();
  for (const [node, tree] of nodeToTree) {
    if (tree.node !== node) throw errorf('TALA engine node-to-tree alias does not match the tree node');
    if (ownedTrees.size > 0) {
      if (!ownedTrees.has(tree)) throw errorf('TALA engine node-to-tree alias references a tree outside the installed forest');
    }
  }
  if (nodeToTree.size > 0 && ownedTrees.size > 0) {
    if (nodeToTree.size !== treeByNode.size) throw errorf('TALA engine node-to-tree aliases do not cover the installed forest');
    for (const [node, tree] of treeByNode) {
      if (nodeToTree.get(node) !== tree) throw errorf('TALA engine node-to-tree aliases do not match the installed forest');
    }
  }

  guard.finish();
}

export function validate(ctx, operation, g) {
  validateEngineGraph(ctx, operation, g);
}

export function validateForSerialization(ctx, graph) {
  validateEngineGraph(ctx, 'SerializeGraph', graph);
}

export function validateSubgraphCombination(ctx, graphs) {
  validateCombineNodeTopology(ctx, graphs);
}

// ==== transaction_snapshot.go ====
// Go's snapshots copy struct values (`*node = s.value`) and slices including their spare capacity. In JS a snapshot of an object is a
// shallow copy of its own properties (value-typed members such as Spacing and EdgeStyle are copied explicitly), and a slice snapshot
// restores the contents and length of the ORIGINAL array object in place (JS arrays have no spare capacity).

const shallowCopy = (obj) => Object.assign(Object.create(Object.getPrototypeOf(obj)), obj);

/** pointerSnapshot: a pointer and a copy of what it pointed to (restoring writes the copy back into the same object). */
function snapshotPointer(pointer) {
  if (pointer == null) return { pointer: null, value: null };
  return { pointer, value: shallowCopy(pointer) };
}

function restorePointer(s) {
  if (s.pointer === null) return null;
  Object.assign(s.pointer, s.value);
  return s.pointer;
}

/** exactSliceSnapshot: the original array object and a copy of its elements. */
function captureExactSlice(values) {
  if (values === null) return { original: null, backing: null };
  return { original: values, backing: values.slice() };
}

function restoreExactSlice(s) {
  if (s.original === null) return null;
  s.original.splice(0, s.original.length, ...s.backing);
  return s.original;
}

function captureExactSliceMap(values) {
  const snapshot = { original: values, values: null };
  if (values === null) return snapshot;
  snapshot.values = new Map();
  for (const [key, items] of values) snapshot.values.set(key, captureExactSlice(items));
  return snapshot;
}

function restoreExactSliceMap(s) {
  if (s.original === null) return null;
  s.original.clear();
  for (const [key, items] of s.values) s.original.set(key, restoreExactSlice(items));
  return s.original;
}

/** cloneMapContents: null for an empty (or nil) Map/Set. */
function cloneMapContents(values) {
  if (values === null || values.size === 0) return null;
  return values instanceof Set ? new Set(values) : new Map(values);
}

/** restoreMap clears the ORIGINAL map and refills it from the snapshot copy; nil stays nil. */
function restoreMap(original, snapshot) {
  if (original === null) return null;
  original.clear();
  if (snapshot !== null) {
    if (original instanceof Set) for (const v of snapshot) original.add(v);
    else for (const [k, v] of snapshot) original.set(k, v);
  }
  return original;
}

function captureNode(node) {
  const value = Object.assign({}, node);
  value.margin = node.margin.copy();
  value.padding = node.padding.copy();
  return {
    value,
    boxTopLeft: node.box.TopLeft,
    boxWidth: node.box.Width,
    boxHeight: node.box.Height,
    topLeft: snapshotPointer(node.topLeft),
    fixedTopLeft: snapshotPointer(node.fixedTopLeft),
    label: snapshotPointer(node.label),
    icon: snapshotPointer(node.icon),
    edges: captureExactSlice(node.edges),
    nears: cloneMapContents(node.nears),
    loopOffsets: cloneMapContents(node.loopOffsets),
    longDistanceNeighborRequirements: cloneMapContents(node.longDistanceNeighborRequirements),
  };
}

function restoreNode(s, node) {
  restorePointer(s.topLeft);
  restorePointer(s.fixedTopLeft);
  restorePointer(s.label);
  restorePointer(s.icon);

  Object.assign(node, s.value); // *node = s.value
  node.margin = s.value.margin.copy();
  node.padding = s.value.padding.copy();
  node.box.TopLeft = s.boxTopLeft;
  node.box.Width = s.boxWidth;
  node.box.Height = s.boxHeight;
  node.edges = restoreExactSlice(s.edges);
  node.nears = restoreMap(s.value.nears, s.nears);
  node.loopOffsets = restoreMap(s.value.loopOffsets, s.loopOffsets);
  node.longDistanceNeighborRequirements = restoreMap(s.value.longDistanceNeighborRequirements, s.longDistanceNeighborRequirements);
}

function captureEdge(edge) {
  const value = Object.assign({}, edge);
  value.style = shallowCopy(edge.style);
  return {
    value,
    points: captureExactSlice(edge.points),
    pointValues: edge.points.map((p) => snapshotPointer(p)),
    label: snapshotPointer(edge.label),
    sourceArrowheadLabel: snapshotPointer(edge.sourceArrowheadLabel),
    targetArrowheadLabel: snapshotPointer(edge.targetArrowheadLabel),
  };
}

function restoreEdge(s, edge) {
  restorePointer(s.label);
  restorePointer(s.sourceArrowheadLabel);
  restorePointer(s.targetArrowheadLabel);
  // s.value.points retains the original slice header. Repair that backing array before reattaching it so rollback preserves aliases
  // to both the route slice and its point objects.
  for (const point of s.pointValues) restorePointer(point);
  const originalPoints = restoreExactSlice(s.points);

  Object.assign(edge, s.value);
  edge.style = shallowCopy(s.value.style);
  edge.points = originalPoints;
}

function captureGraph(graph) {
  return {
    isRootHierarchy: graph.isRootHierarchy,
    nodes: captureExactSlice(graph.nodes),
    edges: captureExactSlice(graph.edges),
    cellSize: graph.cellSize,
    containers: captureExactSliceMap(graph.containers),
    clustersRef: graph.clusters,
    clusters: cloneMapContents(graph.clusters),
    trees: captureExactSliceMap(graph.trees),
    nodeToTreeRef: graph.nodeToTree,
    nodeToTree: cloneMapContents(graph.nodeToTree),
    hubs: captureExactSliceMap(graph.hubs),
    sequencesRef: graph.sequences,
    sequences: cloneMapContents(graph.sequences),
    directionsRef: graph.directions,
    directions: cloneMapContents(graph.directions),
    commonSiblings: captureExactSliceMap(graph.commonUncleSiblings),
  };
}

function restoreGraphSnapshot(s, graph) {
  graph.isRootHierarchy = s.isRootHierarchy;
  graph.nodes = restoreExactSlice(s.nodes);
  graph.edges = restoreExactSlice(s.edges);
  graph.cellSize = s.cellSize;
  graph.containers = restoreExactSliceMap(s.containers);
  graph.clusters = restoreMap(s.clustersRef, s.clusters);
  graph.trees = restoreExactSliceMap(s.trees);
  graph.nodeToTree = restoreMap(s.nodeToTreeRef, s.nodeToTree);
  graph.hubs = restoreExactSliceMap(s.hubs);
  graph.sequences = restoreMap(s.sequencesRef, s.sequences);
  graph.directions = restoreMap(s.directionsRef, s.directions);
  graph.commonUncleSiblings = restoreExactSliceMap(s.commonSiblings);
}

/**
 * collectRuntimeObjectsContext follows every reference that can keep mutable layout state alive outside Graph.Nodes. Both full
 * transaction snapshots and narrower field snapshots use this one bounded traversal. (Go ranges over several maps here, so the order
 * of nodeOrder is not stable in Go; the work charged is.)
 */
function collectRuntimeObjectsContext(graph, guard, scope) {
  const nodes = new Set();
  let edges = null, clusters = null, sequences = null, trees = null, edgeAbductions = null, herds = null, hierarchies = null;

  const nodeQueue = [], edgeQueue = [], clusterQueue = [], sequenceQueue = [], treeQueue = [], abductionQueue = [], herdQueue = [], hierarchyQueue = [];
  let captureErr = null;
  const charge = () => {
    if (captureErr !== null) return false;
    try {
      guard.step();
    } catch (e) {
      if (isPanic(e)) throw e;
      captureErr = e;
    }
    return captureErr === null;
  };

  const addNode = (node) => {
    if (!charge()) return;
    if (node == null) return;
    if (nodes.has(node)) return;
    if (nodes.size >= maxEngineNodes) {
      captureErr = errorf(`TALA ${scope} node snapshot exceeds limit ${maxEngineNodes}`);
      return;
    }
    nodes.add(node);
    nodeQueue.push(node);
  };
  const addEdge = (edge) => {
    if (!charge()) return;
    if (edge == null) return;
    if (edges !== null && edges.has(edge)) return;
    if ((edges === null ? 0 : edges.size) >= maxEngineEdges) {
      captureErr = errorf(`TALA ${scope} edge snapshot exceeds limit ${maxEngineEdges}`);
      return;
    }
    if (edges === null) edges = new Set();
    edges.add(edge);
    edgeQueue.push(edge);
  };
  const addCluster = (cluster) => {
    if (!charge()) return;
    if (cluster == null) return;
    if (clusters !== null && clusters.has(cluster)) return;
    if ((clusters === null ? 0 : clusters.size) >= maxEngineNodes) {
      captureErr = errorf(`TALA ${scope} cluster snapshot exceeds limit ${maxEngineNodes}`);
      return;
    }
    if (clusters === null) clusters = new Set();
    clusters.add(cluster);
    clusterQueue.push(cluster);
  };
  const addSequence = (sequence) => {
    if (!charge()) return;
    if (sequence == null) return;
    if (sequences !== null && sequences.has(sequence)) return;
    if ((sequences === null ? 0 : sequences.size) >= maxEngineNodes) {
      captureErr = errorf(`TALA ${scope} sequence snapshot exceeds limit ${maxEngineNodes}`);
      return;
    }
    if (sequences === null) sequences = new Set();
    sequences.add(sequence);
    sequenceQueue.push(sequence);
  };
  const addTree = (tree) => {
    if (!charge()) return;
    if (tree == null) return;
    if (trees !== null && trees.has(tree)) return;
    if ((trees === null ? 0 : trees.size) >= maxEngineNodes) {
      captureErr = errorf(`TALA ${scope} tree snapshot exceeds limit ${maxEngineNodes}`);
      return;
    }
    if (trees === null) trees = new Set();
    trees.add(tree);
    treeQueue.push(tree);
  };
  const addEdgeAbduction = (abduction) => {
    if (!charge()) return;
    if (abduction == null) return;
    if (edgeAbductions !== null && edgeAbductions.has(abduction)) return;
    if ((edgeAbductions === null ? 0 : edgeAbductions.size) >= maxEngineEdges) {
      captureErr = errorf(`TALA ${scope} edge-abduction snapshot exceeds limit ${maxEngineEdges}`);
      return;
    }
    if (edgeAbductions === null) edgeAbductions = new Set();
    edgeAbductions.add(abduction);
    abductionQueue.push(abduction);
  };
  const addHerd = (herd) => {
    if (!charge()) return;
    if (herd == null) return;
    if (herds !== null && herds.has(herd)) return;
    if ((herds === null ? 0 : herds.size) >= maxEngineNodes) {
      captureErr = errorf(`TALA ${scope} herd snapshot exceeds limit ${maxEngineNodes}`);
      return;
    }
    if (herds === null) herds = new Set();
    herds.add(herd);
    herdQueue.push(herd);
  };
  const addHierarchy = (hierarchy) => {
    if (!charge()) return;
    if (hierarchy == null) return;
    if (hierarchies !== null && hierarchies.has(hierarchy)) return;
    if ((hierarchies === null ? 0 : hierarchies.size) >= maxEngineNodes) {
      captureErr = errorf(`TALA ${scope} hierarchy snapshot exceeds limit ${maxEngineNodes}`);
      return;
    }
    if (hierarchies === null) hierarchies = new Set();
    hierarchies.add(hierarchy);
    hierarchyQueue.push(hierarchy);
  };

  for (const node of graph.nodes) addNode(node);
  for (const edge of graph.edges) addEdge(edge);
  for (const [container, children] of graph.containers) {
    addNode(container);
    for (const child of children) addNode(child);
  }
  for (const [vessel, cluster] of graph.clusters) {
    addNode(vessel);
    addCluster(cluster);
  }
  for (const [vessel, sequence] of graph.sequences) {
    addNode(vessel);
    addSequence(sequence);
  }
  for (const [node, nodeTrees] of graph.trees) {
    addNode(node);
    for (const tree of nodeTrees) addTree(tree);
  }
  if (graph.nodeToTree !== null) {
    for (const [node, tree] of graph.nodeToTree) {
      addNode(node);
      addTree(tree);
    }
  }
  for (const [hub, hubNodes] of graph.hubs) {
    addNode(hub);
    for (const node of hubNodes) addNode(node);
  }
  if (graph.commonUncleSiblings !== null) {
    for (const [node, siblings] of graph.commonUncleSiblings) {
      addNode(node);
      for (const sibling of siblings) addNode(sibling);
    }
  }
  for (const node of graph.directions.keys()) addNode(node);
  if (captureErr !== null) throw captureErr;

  const idx = { node: 0, edge: 0, cluster: 0, sequence: 0, tree: 0, abduction: 0, herd: 0, hierarchy: 0 };
  while (idx.node < nodeQueue.length || idx.edge < edgeQueue.length || idx.cluster < clusterQueue.length ||
    idx.sequence < sequenceQueue.length || idx.tree < treeQueue.length || idx.abduction < abductionQueue.length ||
    idx.herd < herdQueue.length || idx.hierarchy < hierarchyQueue.length) {
    if (captureErr !== null) throw captureErr;
    if (idx.node < nodeQueue.length) {
      const node = nodeQueue[idx.node++];
      addNode(node.container);
      for (const near of node.nears) addNode(near);
      if (node.longDistanceNeighborRequirements !== null) for (const neighbor of node.longDistanceNeighborRequirements.keys()) addNode(neighbor);
      for (const edge of node.edges) addEdge(edge);
      addCluster(node.cluster);
      addSequence(node.sequence);
      addHerd(node.herdAssignment);
      addHierarchy(node.hierarchy);
    } else if (idx.edge < edgeQueue.length) {
      const edge = edgeQueue[idx.edge++];
      addNode(edge.from);
      addNode(edge.to);
    } else if (idx.cluster < clusterQueue.length) {
      const cluster = clusterQueue[idx.cluster++];
      addNode(cluster.vessel);
      addNode(cluster.container);
      for (const node of cluster.nodes) addNode(node);
      for (const abduction of cluster.edgeAbductions) addEdgeAbduction(abduction);
    } else if (idx.sequence < sequenceQueue.length) {
      const sequence = sequenceQueue[idx.sequence++];
      addNode(sequence.vessel);
      addNode(sequence.container);
      for (const node of sequence.nodes) addNode(node);
      for (const abduction of sequence.edgeAbductions) addEdgeAbduction(abduction);
    } else if (idx.tree < treeQueue.length) {
      const tree = treeQueue[idx.tree++];
      addNode(tree.node);
      addEdge(tree.sentinelEdge);
      addTree(tree.parent);
      for (const child of tree.children) addTree(child);
    } else if (idx.abduction < abductionQueue.length) {
      const abduction = abductionQueue[idx.abduction++];
      addEdge(abduction.edge);
      addNode(abduction.originallyFrom);
      addNode(abduction.originallyTo);
      addNode(abduction.currentFrom);
      addNode(abduction.currentTo);
    } else if (idx.herd < herdQueue.length) {
      const herd = herdQueue[idx.herd++];
      for (const node of herd.oppositeSidePaired) addNode(node);
      for (const node of herd.sameSidePaired) addNode(node);
    } else if (idx.hierarchy < hierarchyQueue.length) {
      const hierarchy = hierarchyQueue[idx.hierarchy++];
      for (const node of hierarchy.level.keys()) addNode(node);
    }
    if (captureErr !== null) throw captureErr;
  }

  return { nodes, nodeOrder: nodeQueue, edges, clusters, sequences, trees, edgeAbductions, herds, hierarchies };
}

// ==== node_graph_ownership.go ====

/** NodeGraphOwnershipSnapshot is a read-only capture of every pre-existing node owner reachable from a graph's runtime topology. */
export class NodeGraphOwnershipSnapshot {
  constructor(owners) {
    this.owners = owners;
  }

  /** Restore restores every graph pointer captured by the snapshot. */
  restore() {
    for (const owner of this.owners) owner.node.graph = owner.graph;
  }
}

/** SnapshotNodeGraphOwnership captures every node reachable through the graph's runtime topology. It does not mutate the graph. */
export function snapshotNodeGraphOwnership(ctx, graph) {
  if (graph == null) throw invariant.newError('node graph ownership snapshot requires a graph');
  const guard = limits.newWorkGuard(ctx, 'NodeGraphOwnershipSnapshot', maxEngineWorkUnits);
  const objects = collectRuntimeObjectsContext(graph, guard, 'ownership runtime');
  const owners = objects.nodeOrder.map((node) => {
    guard.step();
    return { node, graph: node.graph };
  });
  guard.finish();
  return new NodeGraphOwnershipSnapshot(owners);
}

/** NodeGraphOwnershipJournal records the graph pointer owned by each node before a subgraph split temporarily redirects it. */
export class NodeGraphOwnershipJournal {
  constructor(original) {
    this.original = original; // Map<Node, Graph> | null
  }

  restore() {
    for (const [node, graph] of this.original) node.graph = graph;
  }

  /** [graph, captured] */
  originalGraph(node) {
    if (this.original === null || !this.original.has(node)) return [null, false];
    return [this.original.get(node), true];
  }
}

Graph.prototype.splitSubgraphsTracked = function (ctx, options, work) {
  const ownership = { journal: null };
  const graphs = this.splitSubgraphsWithOwnership(ctx, options, ownership, work ?? null);
  return [graphs, new NodeGraphOwnershipJournal(ownership.journal)];
};

// ==== transaction.go ====

const transactionWorkGuardKey = Symbol('transactionWorkGuardKey');

/** GraphState is the rollback point of a Transaction. */
export class GraphState {
  constructor() {
    // nodeGeometry is also the transaction's deduplicated node set: Map<Node, {topLeft: pointerSnapshot, width, height}>.
    this.nodeGeometry = null;
    this.originalNodes = [];
    this.originalNodesRef = null;
    this.hasFixedTopLeft = false;

    this.clusterArrangements = null;
    this.clusterDesired = null;
    this.clusterPaddings = null;
    this.edgeGeometry = null;
    this.treeOrientations = null;

    // We don't want to be frozen due to some existing overlap, since many can be valid diagrams. We just care about not introducing new overlaps.
    this.existingOverlaps = null; // Map<Node, Set<Node>>
    this.existingExactOverlaps = null;
    this.captureTopology = false;
    this.captureEdgeRoutes = false;

    this.graph = null;
    this.nodes = null;
    this.edges = null;
    this.clusters = null;
    this.sequences = null;
    this.trees = null;
    this.edgeAbductions = null;
    this.herds = null;
    this.hierarchies = null;
  }
}

/** GraphStateSnapshotOptions: {captureTopology, captureEdgeRoutes}. NewGraphStateSnapshot creates an empty rollback snapshot. */
export function newGraphStateSnapshot(options) {
  const gs = new GraphState();
  gs.captureTopology = !!options.captureTopology;
  gs.captureEdgeRoutes = !!options.captureEdgeRoutes;
  return gs;
}

/** TransactionOptions: {affectContainers, ignoreContainerEscape, affectEdgeRoutes}. */

export class Transaction {
  constructor() {
    this.ops = [];
    this.graph = null;
    this.options = { affectContainers: false, ignoreContainerEscape: false, affectEdgeRoutes: false };
    this.guard = null;

    this.priorGraphState = null;
    this.spareGraphState = null;
    // placementCostSnapshot is optional stage-owned rollback data. Ordinary speculative Rollback deliberately ignores it.
    this.placementCostSnapshot = null;

    this.dirtyNodes = null;
    this.dirtyNodeMarks = [];
    this.fixedOrigins = null;

    this.overlapCandidates = [];
    this.overlapSweepNodes = [];
    this.overlapActiveNodes = [];
    this.overlapNodeIndices = null;
    this.overlapNodeIndexReady = false;
    this.priorGraphStateShared = false;
    this.overlapInvalidBoxes = [];
    this.exceptionMarks = [];
    this.exceptionGeneration = 0;
    this.descendantStack = [];
    this.descendantNodes = [];
    this.descendantSeen = null;
    this.descendantGeneration = 0;
  }
}

/** ContextWithTransactionWorkGuard lets a layout domain share one aggregate request budget with every speculative graph transaction it creates. */
export function contextWithTransactionWorkGuard(ctx, guard) {
  if (ctx == null || guard == null) return ctx;
  return withValue(ctx, transactionWorkGuardKey, guard);
}

/** [guard, ok] */
export function existingTransactionWorkGuard(ctx, location) {
  if (ctx == null) throw errorf(`TALA ${location} requires a context`);
  const guard = ctx.value(transactionWorkGuardKey);
  if (guard !== undefined && guard !== null) {
    guard.finish();
    return [guard, true];
  }
  return [null, false];
}

/** [ctx, guard] */
export function ensureTransactionWorkGuard(ctx, location) {
  const [existing, exists] = existingTransactionWorkGuard(ctx, location);
  if (exists) return [ctx, existing];
  const guard = limits.newWorkGuard(ctx, location, maxTransactionWorkUnits);
  return [withValue(ctx, transactionWorkGuardKey, guard), guard];
}

Graph.prototype.newRequestTransaction_ = function (ctx, options) {
  const [, guard] = ensureTransactionWorkGuard(ctx, 'Transaction');
  return this.newTransactionWithOptionsContext(ctx, options, guard);
};

/** NewRequestTransaction creates a request-scoped placement transaction. */
Graph.prototype.newRequestTransaction = function (ctx, options) {
  return this.newRequestTransaction_(ctx, options);
};

Graph.prototype.newRequestTransactionWithGuard = function (ctx, guard, options) {
  if (guard == null) throw errorf('TALA transaction requires a shared work guard');
  return this.newTransactionWithOptionsContext(ctx, options, guard);
};
Graph.prototype.newRequestTransactionWithWorkGuard = Graph.prototype.newRequestTransactionWithGuard;

export function restoreGraphState(graph, state) {
  const t = new Transaction();
  t.graph = graph;
  t.priorGraphState = state;
  t.rollback();
}

const cloneSlice = (values) => values.slice();

Object.assign(GraphState.prototype, {
  updateContext(g, guard) {
    const gs = this;
    if (g == null) throw errorf('TALA transaction graph is nil');
    if (guard == null) throw errorf('TALA transaction requires a work guard');
    if (g.nodes.length > maxEngineNodes) throw errorf(`TALA transaction node count exceeds limit ${maxEngineNodes}`);
    if (g.edges.length > maxEngineEdges) throw errorf(`TALA transaction edge count exceeds limit ${maxEngineEdges}`);
    for (const [name, count] of [
      ['container', g.containers.size],
      ['cluster', g.clusters.size],
      ['sequence', g.sequences.size],
      ['tree', g.trees.size],
      ['node-tree', g.nodeToTree === null ? 0 : g.nodeToTree.size],
      ['hub', g.hubs.size],
      ['direction', g.directions.size],
      ['sibling', g.commonUncleSiblings === null ? 0 : g.commonUncleSiblings.size],
    ]) {
      if (count > maxEngineNodes + 1) throw errorf(`TALA transaction ${name} map exceeds limit ${maxEngineNodes + 1}`);
    }

    // Reset or create maps all at once to minimize allocation overhead
    const totalNodes = Math.min(g.nodes.length, maxEngineNodes);
    if (gs.nodeGeometry === null || gs.nodeGeometry.size > 2 * totalNodes) gs.nodeGeometry = new Map();
    else gs.nodeGeometry.clear();
    gs.hasFixedTopLeft = false;

    const clusterCount = g.clusters.size;
    if (gs.clusterArrangements === null || gs.clusterArrangements.size > 2 * clusterCount) {
      gs.clusterArrangements = new Map();
      gs.clusterDesired = new Map();
      gs.clusterPaddings = new Map();
    } else {
      gs.clusterArrangements.clear();
      gs.clusterDesired.clear();
      gs.clusterPaddings.clear();
    }

    gs.originalNodesRef = g.nodes;
    gs.originalNodes = g.nodes.slice();

    const recordNode = (n) => {
      if (n === null) return false;
      if (gs.nodeGeometry.has(n)) return false;
      if (gs.nodeGeometry.size >= maxEngineNodes) throw errorf(`TALA transaction unique node snapshot exceeds limit ${maxEngineNodes}`);
      guard.step();
      const topLeft = snapshotPointer(n.topLeft);
      gs.nodeGeometry.set(n, { topLeft, width: n.width, height: n.height });
      gs.hasFixedTopLeft = gs.hasFixedTopLeft || n.fixedTopLeft !== null;
      return true;
    };

    const recordDescendants = (root) => {
      const queue = [root];
      while (queue.length > 0) {
        const node = queue.pop();
        const recorded = recordNode(node);
        if (!recorded) continue;
        const kids = containersOf(g, node);
        for (let i = 0; i < kids.length; i++) guard.step();
        queue.push(...kids);
      }
    };
    for (const n of g.nodes) recordDescendants(n);
    // Some speculative subgraphs keep descendants outside g.Nodes. Record map roots and values as well so rollback does not depend on slice membership.
    for (const [container, children] of g.containers) {
      guard.step();
      recordDescendants(container);
      for (const child of children) recordDescendants(child);
    }

    // Store cluster policy and nodes.
    for (const c of g.clusters.values()) {
      guard.step();
      if (c == null) continue;
      gs.clusterArrangements.set(c, c.arrangement);
      gs.clusterDesired.set(c, c.desiredArrangement);
      gs.clusterPaddings.set(c, c.padding);
      recordDescendants(c.vessel);
      recordDescendants(c.container);
      for (const n of c.nodes) recordDescendants(n);
    }

    // Store sequence nodes that may be temporarily removed from g.Nodes.
    for (const s of g.sequences.values()) {
      guard.step();
      if (s == null) continue;
      recordDescendants(s.vessel);
      recordDescendants(s.container);
      for (const n of s.nodes) recordDescendants(n);
    }

    if (gs.captureTopology) gs.captureRuntimeStateContext(g, guard);
    else gs.captureGeometryStateContext(g, guard);
    guard.finish();
  },

  /**
   * captureGeometryState records the fields changed by ordinary speculative placement transactions without walking and copying the graph's
   * ownership maps. Topology-changing transactions additionally call captureRuntimeState.
   */
  captureGeometryStateContext(graph, guard) {
    const gs = this;
    if (gs.captureEdgeRoutes) {
      const edges = new Set();
      for (const edge of graph.edges) {
        guard.step();
        if (edge == null) throw errorf('TALA geometry snapshot contains a nil edge');
        edges.add(edge);
      }
      for (const node of gs.nodeGeometry.keys()) {
        guard.step();
        for (const edge of node.edges) {
          guard.step();
          if (edge != null) edges.add(edge);
        }
      }
      gs.edgeGeometry = new Map();
      for (const edge of edges) {
        guard.step();
        for (let i = 0; i < edge.points.length; i++) guard.step();
        gs.edgeGeometry.set(edge, captureEdge(edge));
      }
    } else {
      gs.edgeGeometry = null;
    }

    gs.treeOrientations = new Map();
    if (graph.nodeToTree !== null) {
      for (const tree of graph.nodeToTree.values()) {
        guard.step();
        if (tree != null) gs.treeOrientations.set(tree, tree.orientation);
      }
    }
    guard.finish();
  },

  captureRuntimeStateContext(graph, guard) {
    const gs = this;
    const objects = collectRuntimeObjectsContext(graph, guard, 'transaction runtime');
    const { nodes, edges, clusters, sequences, trees, edgeAbductions, herds, hierarchies } = objects;

    guard.step();
    gs.graph = captureGraph(graph);
    gs.nodes = new Map();
    for (const node of nodes) {
      guard.step();
      gs.nodes.set(node, captureNode(node));
    }
    gs.edges = new Map();
    for (const edge of edges ?? []) {
      guard.step();
      for (let i = 0; i < edge.points.length; i++) guard.step();
      gs.edges.set(edge, captureEdge(edge));
    }
    gs.clusters = new Map();
    for (const cluster of clusters ?? []) {
      guard.step();
      gs.clusters.set(cluster, { value: shallowCopy(cluster), nodes: captureExactSlice(cluster.nodes), edgeAbductions: captureExactSlice(cluster.edgeAbductions) });
    }
    gs.sequences = new Map();
    for (const sequence of sequences ?? []) {
      guard.step();
      gs.sequences.set(sequence, { value: shallowCopy(sequence), nodes: captureExactSlice(sequence.nodes), edgeAbductions: captureExactSlice(sequence.edgeAbductions) });
    }
    gs.trees = new Map();
    for (const tree of trees ?? []) {
      guard.step();
      gs.trees.set(tree, { value: shallowCopy(tree), children: captureExactSlice(tree.children) });
    }
    gs.edgeAbductions = new Map();
    for (const abduction of edgeAbductions ?? []) {
      guard.step();
      gs.edgeAbductions.set(abduction, shallowCopy(abduction));
    }
    gs.herds = new Map();
    for (const herd of herds ?? []) {
      guard.step();
      gs.herds.set(herd, { value: shallowCopy(herd), oppositeSidePaired: cloneMapContents(herd.oppositeSidePaired), sameSidePaired: cloneMapContents(herd.sameSidePaired) });
    }
    gs.hierarchies = new Map();
    for (const hierarchy of hierarchies ?? []) {
      guard.step();
      gs.hierarchies.set(hierarchy, { value: shallowCopy(hierarchy), level: cloneMapContents(hierarchy.level) });
    }
    guard.finish();
  },

  /** UpdateWithWorkGuard */
  updateWithWorkGuard(g, guard) {
    this.updateContext(g, guard);
  },

  /** OwnedNodes returns every node whose state is owned by g, including graph nodes temporarily removed by tree or sequence preprocessing. */
  ownedNodes(g, guard) {
    const owned = new Set();
    for (const node of g.nodes) {
      guard.step();
      owned.add(node);
    }
    for (const node of this.nodes.keys()) {
      guard.step();
      if (node.graph === g) owned.add(node);
    }
    return owned;
  },

  tracksNode(node) {
    return this.nodes.has(node);
  },

  hasOriginalNodeOrder(g) {
    const gs = this;
    if (gs == null || g == null || gs.originalNodes.length !== g.nodes.length) return false;
    for (let i = 0; i < g.nodes.length; i++) {
      if (gs.originalNodes[i] !== g.nodes[i]) return false;
    }
    return true;
  },

  geometryChanged(node) {
    const gs = this;
    if (gs == null || node == null) return true;
    const original = gs.nodeGeometry.get(node);
    if (original === undefined) return true;
    if (node.topLeft === null) {
      return original.topLeft.pointer !== null || node.width !== original.width || node.height !== original.height;
    }
    return original.topLeft.pointer === null ||
      node.topLeft.x !== original.topLeft.value.x || node.topLeft.y !== original.topLeft.value.y ||
      node.width !== original.width || node.height !== original.height;
  },
});

function transactionFinite(value) {
  return Number.isFinite(value);
}

function transactionNodeHasFiniteBox(node) {
  return node != null && node.topLeft !== null &&
    transactionFinite(node.topLeft.x) && transactionFinite(node.topLeft.y) &&
    transactionFinite(node.width) && transactionFinite(node.height) &&
    transactionFinite(node.topLeft.x + node.width) && transactionFinite(node.topLeft.y + node.height) &&
    node.width >= 0 && node.height >= 0;
}

function transactionSweepPadding(g, guard) {
  let padding = TableNodeGap;
  let maxMargin = 0.0;
  let maxLoopOffset = 0.0;
  const edges = new Set();
  for (const node of g.nodes) {
    guard.step();
    if (node == null) throw errorf('TALA transaction contains a nil node');
    if (node.topLeft !== null) {
      if (!transactionNodeHasFiniteBox(node)) {
        // Empty containers deliberately use NaN/+Inf sentinel geometry until their final fit stage.
        if (node.isContainer_ && containersOf(g, node).length === 0) continue;
        throw invariant.errorf(`transaction node ${node.id} has invalid geometry (x=${goV(node.topLeft.x)} y=${goV(node.topLeft.y)} width=${goV(node.width)} height=${goV(node.height)})`);
      }
    }
    for (const margin of [node.margin.top, node.margin.right, node.margin.bottom, node.margin.left]) {
      if (!transactionFinite(margin)) throw invariant.errorf(`transaction node ${node.id} has non-finite margin`);
    }
    maxMargin = Math.max(maxMargin, node.margin.top, node.margin.right, node.margin.bottom, node.margin.left);
    if (node.loopOffsets !== null) {
      for (const offset of node.loopOffsets.values()) {
        guard.step();
        if (!transactionFinite(offset)) throw invariant.errorf(`transaction node ${node.id} has a non-finite loop offset`);
        if (offset > maxLoopOffset) maxLoopOffset = offset;
      }
    }
    // Direct internal callers can temporarily expose an edge through only one endpoint before graph.Edges is synchronized.
    for (const edge of node.edges) {
      guard.step();
      if (edge == null) throw errorf(`TALA transaction node ${node.id} contains a nil edge`);
      edges.add(edge);
    }
  }
  for (const edge of g.edges) {
    guard.step();
    if (edge == null) throw errorf('TALA transaction contains a nil edge');
    edges.add(edge);
  }
  for (const edge of edges) {
    guard.step();
    padding = Math.max(padding, edge.minWidth, edge.minHeight);
  }
  // deltaTo can combine one directional margin or loop offset from each node in the pair. Twice the graph maximum is therefore a proven
  // broad-phase bound for every exact predicate evaluated below.
  padding = Math.max(padding, 2 * maxMargin, NodeGap + 2 * maxLoopOffset);
  if (!transactionFinite(padding)) throw invariant.newError('transaction overlap padding is non-finite');
  guard.finish();
  return padding;
}

/** left.x then ID then index (the comparator of the sweep sorts) */
function sweepCompare(left, right) {
  if (left.node.topLeft.x !== right.node.topLeft.x) {
    if (left.node.topLeft.x < right.node.topLeft.x) return -1;
    if (right.node.topLeft.x < left.node.topLeft.x) return 1;
    return 0;
  }
  if (left.node.id !== right.node.id) return left.node.id < right.node.id ? -1 : 1;
  return left.index < right.index ? -1 : left.index > right.index ? 1 : 0;
}

/** [existingOverlaps, existingExactOverlaps] */
function buildTransactionOverlaps(g, guard) {
  return buildTransactionOverlapsWithReferenceLimit(g, guard, maxTransactionOverlapReferences);
}

function buildTransactionOverlapsWithReferenceLimit(g, guard, referenceLimit) {
  const padding = transactionSweepPadding(g, guard);
  const placed = [];
  g.nodes.forEach((node, index) => {
    guard.step();
    if (node.topLeft !== null && transactionNodeHasFiniteBox(node)) placed.push({ node, index });
  });
  guard.step();
  placed.sort(sweepCompare);

  const existingOverlaps = new Map();
  const existingExactOverlaps = new Map();
  let retainedReferences = 0;
  const addPair = (overlaps, first, second) => {
    if (referenceLimit < 2 || retainedReferences > referenceLimit - 2) throw errorf(`TALA transaction overlap references exceed limit ${referenceLimit}`);
    if (!overlaps.has(first)) overlaps.set(first, new Set());
    if (!overlaps.has(second)) overlaps.set(second, new Set());
    overlaps.get(first).add(second);
    overlaps.get(second).add(first);
    retainedReferences += 2;
  };

  let active = [];
  for (const current of placed) {
    guard.step();
    const kept = [];
    for (const other of active) {
      guard.step();
      // g.Nodes is a legacy public slice and malformed direct callers can repeat the same pointer. The sweep must not retain a self-overlap.
      if (other === current.node) continue;
      if (other.topLeft.x + other.width + padding <= current.node.topLeft.x) continue;
      kept.push(other);
      if (other.topLeft.y >= current.node.topLeft.y + current.node.height + padding ||
        current.node.topLeft.y >= other.topLeft.y + other.height + padding) {
        continue;
      }
      if (current.node.doesOverlapExact(other)) addPair(existingExactOverlaps, current.node, other);
      // Preserve the old ordered-pair semantics even if a malformed direct caller has asymmetric edge references.
      if (current.node.doesOverlap_(other) || other.doesOverlap_(current.node)) addPair(existingOverlaps, current.node, other);
    }
    kept.push(current.node);
    active = kept;
  }
  guard.finish();
  return [existingOverlaps, existingExactOverlaps];
}

/**
 * newTransactionWithOptionsContext constructs a transaction using a request-scoped work guard so production stages can share one aggregate
 * budget across all speculative candidates.
 */
Graph.prototype.newTransactionWithOptionsContext = function (ctx, options, guard) {
  const g = this;
  if (guard === null) {
    [, guard] = ensureTransactionWorkGuard(ctx, 'Transaction');
  } else if (ctx == null) {
    throw errorf('TALA transaction requires a context');
  }
  guard.finish();
  const graphState = new GraphState();
  graphState.captureEdgeRoutes = !!options.affectEdgeRoutes;
  graphState.updateContext(g, guard);

  const [existingOverlaps, existingExactOverlaps] = buildTransactionOverlaps(g, guard);

  graphState.existingOverlaps = existingOverlaps;
  graphState.existingExactOverlaps = existingExactOverlaps;
  const txn = new Transaction();
  txn.ops = [];
  txn.graph = g;
  txn.options = { affectContainers: !!options.affectContainers, ignoreContainerEscape: !!options.ignoreContainerEscape, affectEdgeRoutes: !!options.affectEdgeRoutes };
  txn.guard = guard;
  txn.priorGraphState = graphState;

  guard.finish();
  return txn;
};

Object.assign(Transaction.prototype, {
  /**
   * PreservePriorGraphState pins the current rollback point so a later UpdateState cannot recycle it as scratch. Callers may retain the
   * returned state for a larger atomic operation that spans multiple transaction commits.
   */
  preservePriorGraphState() {
    if (this == null) return null;
    this.priorGraphStateShared = true;
    return this.priorGraphState;
  },

  /** CapturePlacementCosts attaches an optional stage-owned cost rollback point to this transaction. */
  capturePlacementCosts(location) {
    const t = this;
    if (t == null || t.graph === null || t.guard === null) throw errorf(`TALA ${location} placement-cost snapshot requires an initialized transaction`);
    if (t.placementCostSnapshot !== null) return;
    const cacheEntries = t.graph.edgeLengthCacheEntries();
    if (cacheEntries > maxEngineTopologyReferences) throw errorf(`TALA ${location} edge-length cache entries exceed limit ${maxEngineTopologyReferences}`);
    for (let i = 0; i < cacheEntries; i++) t.guard.step();
    const costs = t.graph.snapshotPlacementCosts();
    t.guard.finish();
    t.placementCostSnapshot = costs;
  },

  /** RestorePlacementCosts restores a captured placement-cost rollback point and reports whether one was present. */
  restorePlacementCosts() {
    const t = this;
    if (t == null || t.placementCostSnapshot === null) return false;
    const costs = t.placementCostSnapshot;
    t.placementCostSnapshot = null;
    costs.restore();
    return true;
  },

  originalDimensions(node) {
    const geometry = this.priorGraphState.nodeGeometry.get(node);
    return [geometry.width, geometry.height];
  },

  updateState() {
    const t = this;
    // Existing-overlap exceptions intentionally remain anchored to transaction construction. Reusing a transaction updates the rollback
    // point, not which preexisting collisions are allowed.
    const previous = t.priorGraphState;
    let updated = t.spareGraphState;
    if (updated === null) updated = new GraphState();
    updated.captureTopology = previous.captureTopology;
    updated.captureEdgeRoutes = previous.captureEdgeRoutes;
    try {
      updated.updateContext(t.graph, t.guard);
    } catch (err) {
      if (isPanic(err)) throw err;
      // updateContext only mutates the spare snapshot. The prior rollback point remains exact, so a failed refresh can reject the accepted candidate.
      t.rollback();
      throw err;
    }
    updated.existingOverlaps = previous.existingOverlaps;
    updated.existingExactOverlaps = previous.existingExactOverlaps;
    t.priorGraphState = updated;
    if (t.priorGraphStateShared) {
      t.spareGraphState = null;
      t.priorGraphStateShared = false;
    } else {
      t.spareGraphState = previous;
    }
  },

  addOp(fn) {
    this.ops.push(fn);
  },

  repositionContainers(ctx) {
    const t = this;
    const smallestToLargest = [];
    for (const container of t.graph.containers.keys()) {
      t.guard.step();
      if (container === null || container.topLeft === null) continue;
      smallestToLargest.push(container);
    }
    sortSlice(smallestToLargest, (i, j) => {
      if (smallestToLargest[i].area_() === smallestToLargest[j].area_()) return smallestToLargest[i].id < smallestToLargest[j].id;
      return smallestToLargest[i].area_() < smallestToLargest[j].area_();
    });

    for (const container of smallestToLargest) {
      const err = ctx.err();
      if (err) throw err;
      container.wrapChildren_();
      t.guard.step();
    }
    t.guard.finish();
  },

  transactionBoxesMayInteract(first, second) {
    return transactionBoxesMayInteract(first, second);
  },

  collectFixedOrigins(ctx) {
    const t = this;
    if (t.fixedOrigins === null) t.fixedOrigins = new Map();
    else t.fixedOrigins.clear();
    if (!t.priorGraphState.hasFixedTopLeft) {
      t.guard.finish();
      return;
    }
    for (const node of t.graph.nodes) {
      t.guard.step();
      const err = ctx.err();
      if (err) throw err;
      if (node == null || node.topLeft === null || node.fixedTopLeft === null) continue;
      const container = node.container_();
      if (t.fixedOrigins.has(container)) continue;
      t.fixedOrigins.set(container, new geo.Point(node.topLeft.x - node.fixedTopLeft.x, node.topLeft.y - node.fixedTopLeft.y));
    }
    t.guard.finish();
  },

  /**
   * collectOverlapValidationNodes records geometry changes for the legacy non-exact-to-exact regression check. Returns useDirtyValidation.
   */
  collectOverlapValidationNodes(ctx) {
    const t = this;
    if (!t.priorGraphState.hasOriginalNodeOrder(t.graph)) return false;
    if (t.dirtyNodes === null) t.dirtyNodes = new Set();
    else t.dirtyNodes.clear();
    t.dirtyNodeMarks = new Array(t.graph.nodes.length).fill(false);

    t.graph.nodes.forEach((node, index) => {
      t.guard.step();
      const err = ctx.err();
      if (err) throw err;
      if (t.priorGraphState.geometryChanged(node)) {
        t.dirtyNodes.add(node);
        t.dirtyNodeMarks[index] = true;
      }
    });
    t.guard.finish();
    return true;
  },

  /**
   * buildPostStateOverlapCandidates builds the exact 500-unit broad phase used by doesOverlapWithDimensionsContext. Sparse geometry
   * transactions retain only pairs incident to a changed box; full geometry scans retain every pair. Candidate lists are sorted by
   * g.Nodes index so directional deltaTo and first-rejection order remain unchanged.
   */
  buildPostStateOverlapCandidates(ctx, dirtyOnly) {
    const t = this;
    const nodeCount = t.graph.nodes.length;
    if (nodeCount > maxEngineNodes) throw errorf(`TALA transaction node count exceeds limit ${maxEngineNodes}`);
    t.overlapCandidates = Array.from({ length: nodeCount }, () => []);
    t.overlapInvalidBoxes = new Array(nodeCount).fill(false);
    if (t.exceptionMarks.length < nodeCount) {
      const marks = new Array(nodeCount).fill(0);
      for (let i = 0; i < t.exceptionMarks.length; i++) marks[i] = t.exceptionMarks[i];
      t.exceptionMarks = marks;
    } else {
      t.exceptionMarks.length = nodeCount;
    }

    let rebuildNodeIndex = !dirtyOnly || !t.overlapNodeIndexReady;
    if (t.overlapNodeIndices === null) {
      t.overlapNodeIndices = new Map();
      rebuildNodeIndex = true;
    } else if (rebuildNodeIndex) {
      for (const node of t.overlapNodeIndices.keys()) t.overlapNodeIndices.set(node, []);
    }
    t.overlapSweepNodes = [];
    let hasInvalidBox = false;
    let dirtyCount = 0;
    t.graph.nodes.forEach((node, index) => {
      t.guard.step();
      const err = ctx.err();
      if (err) throw err;
      if (node == null) throw invariant.newError('transaction overlap check encountered a nil graph node');
      if (rebuildNodeIndex) {
        if (!t.overlapNodeIndices.has(node)) t.overlapNodeIndices.set(node, []);
        t.overlapNodeIndices.get(node).push(index);
      }
      if (dirtyOnly && t.dirtyNodeMarks[index]) dirtyCount++;
      if (node.topLeft === null) return;
      if (!transactionNodeHasFiniteBox(node)) {
        t.overlapInvalidBoxes[index] = true;
        hasInvalidBox = true;
        return;
      }
      t.overlapSweepNodes.push({ node, index });
    });
    t.overlapNodeIndexReady = dirtyOnly;

    let retainedReferences = 0;
    const addPair = (first, second) => {
      if (retainedReferences > maxTransactionOverlapReferences - 2) throw errorf(`TALA transaction overlap references exceed limit ${maxTransactionOverlapReferences}`);
      t.overlapCandidates[first].push(second);
      t.overlapCandidates[second].push(first);
      retainedReferences += 2;
    };

    // A sparse geometry trial is cheapest as changed-nodes x graph. When many boxes move, the sweep avoids scanning pairs that are far apart.
    const useDirtyScan = dirtyOnly && dirtyCount * 4 < nodeCount;
    if (useDirtyScan) {
      for (let first = 0; first < t.graph.nodes.length; first++) {
        const firstNode = t.graph.nodes[first];
        if (!t.dirtyNodeMarks[first] || firstNode.topLeft === null) continue;
        for (let second = 0; second < t.graph.nodes.length; second++) {
          const secondNode = t.graph.nodes[second];
          t.guard.step();
          if (second === first || firstNode === secondNode || secondNode.topLeft === null) continue;
          if (t.dirtyNodeMarks[second] && second < first) continue;
          if (!transactionBoxesMayInteract(firstNode, secondNode)) continue;
          addPair(first, second);
        }
      }
    } else {
      t.overlapSweepNodes.sort(sweepCompare);
      let active = [];
      for (const current of t.overlapSweepNodes) {
        t.guard.step();
        const kept = [];
        for (const other of active) {
          t.guard.step();
          // Equality remains active because the legacy broad phase only rejects a pair when there is a strict gap greater than 500.
          if (other.node.topLeft.x + other.node.width + 500 < current.node.topLeft.x) continue;
          kept.push(other);
          if (other.node === current.node || !transactionBoxesMayInteract(other.node, current.node)) continue;
          if (dirtyOnly) {
            if (!t.dirtyNodeMarks[other.index] && !t.dirtyNodeMarks[current.index]) continue;
          }
          addPair(other.index, current.index);
        }
        kept.push(current);
        active = kept;
      }
      t.overlapActiveNodes = active;

      // Non-finite or negative boxes deliberately follow legacy comparisons, whose NaN behavior cannot be represented by a numeric sweep ordering.
      if (hasInvalidBox) {
        for (let first = 0; first < nodeCount; first++) {
          for (let second = first + 1; second < nodeCount; second++) {
            if (!t.overlapInvalidBoxes[first] && !t.overlapInvalidBoxes[second]) continue;
            if (dirtyOnly) {
              if (!t.dirtyNodeMarks[first] && !t.dirtyNodeMarks[second]) continue;
            }
            t.guard.step();
            const firstNode = t.graph.nodes[first], secondNode = t.graph.nodes[second];
            if (firstNode === secondNode || firstNode.topLeft === null || secondNode.topLeft === null || !transactionBoxesMayInteract(firstNode, secondNode)) continue;
            addPair(first, second);
          }
        }
      }
    }

    for (const candidates of t.overlapCandidates) {
      t.guard.step();
      candidates.sort((a, b) => a - b);
    }
    t.guard.finish();
  },

  markOverlapException(node, generation) {
    for (const index of (this.overlapNodeIndices.get(node) ?? [])) this.exceptionMarks[index] = generation;
  },

  /**
   * markDescendantOverlapExceptions performs the same stable descendant walk as allDescendantNodesGuarded, but retains its stack, result
   * slice, and seen set across the thousands of speculative transaction checks in a layout.
   */
  markDescendantOverlapExceptions(node, includeClusterNodes, generation) {
    const t = this;
    t.descendantGeneration++;
    if (t.descendantGeneration === 0) {
      if (t.descendantSeen !== null) t.descendantSeen.clear();
      t.descendantGeneration = 1;
    }
    const seenGeneration = t.descendantGeneration;
    if (t.descendantSeen === null) t.descendantSeen = new Map();
    t.descendantStack = [];
    t.descendantNodes = [];
    if (node !== null) t.descendantSeen.set(node, seenGeneration);

    const pushChildren = (parent) => {
      const sequence = t.graph.sequences.get(parent);
      if (sequence != null) {
        for (let i = sequence.nodes.length - 1; i >= 0; i--) {
          t.guard.step();
          t.descendantStack.push({ node: sequence.nodes[i], emit: includeClusterNodes });
        }
      }
      if (parent !== null && parent.isClusterVessel_) {
        const cluster = t.graph.clusters.get(parent);
        if (cluster != null) {
          for (let i = cluster.nodes.length - 1; i >= 0; i--) {
            t.guard.step();
            t.descendantStack.push({ node: cluster.nodes[i], emit: includeClusterNodes });
          }
        }
      }
      if (parent === null || parent.isContainer_) {
        const children = containersOf(t.graph, parent);
        for (let i = children.length - 1; i >= 0; i--) {
          t.guard.step();
          t.descendantStack.push({ node: children[i], emit: true });
        }
      }
    };
    pushChildren(node);
    while (t.descendantStack.length > 0) {
      t.guard.step();
      const current = t.descendantStack.pop();
      if (current.node === null || t.descendantSeen.get(current.node) === seenGeneration) continue;
      t.descendantSeen.set(current.node, seenGeneration);
      if (current.emit) t.descendantNodes.push(current.node);
      pushChildren(current.node);
    }
    for (const descendant of t.descendantNodes) {
      t.guard.step();
      t.markOverlapException(descendant, generation);
    }
    t.guard.finish();
  },

  hasBadPostStateOverlap(nodeIndex) {
    const t = this;
    const node = t.graph.nodes[nodeIndex];
    if (node == null || node.topLeft === null) return node == null;
    if (node.cluster !== null) return false;

    t.exceptionGeneration++;
    if (t.exceptionGeneration === 0 || t.exceptionGeneration > 0xffffffff) {
      t.exceptionMarks.fill(0);
      t.exceptionGeneration = 1;
    }
    const generation = t.exceptionGeneration;
    if (node.isContainer_ || node.isClusterVessel_ || t.graph.sequences.get(node) != null) {
      t.markDescendantOverlapExceptions(node, true, generation);
    }
    if (node.container !== null || node.cluster !== null || node.sequence !== null) {
      const ancestors = t.graph.ancestorsOfGuarded(node, t.guard);
      for (const ancestor of ancestors) {
        t.guard.step();
        t.markOverlapException(ancestor, generation);
      }
    }

    const pairwiseExceptions = t.priorGraphState.existingOverlaps.get(node);
    const right = node.topLeft.x + node.width;
    const bottom = node.topLeft.y + node.height;
    for (const otherIndex of t.overlapCandidates[nodeIndex]) {
      t.guard.step();
      const other = t.graph.nodes[otherIndex];
      if (other == null) throw invariant.newError('transaction overlap check encountered a nil graph node');
      if ((pairwiseExceptions !== undefined && pairwiseExceptions.has(other)) || t.exceptionMarks[otherIndex] === generation) continue;
      if (other.topLeft === null || !transactionBoxesMayInteract(node, other)) continue;
      const delta = node.deltaToGuarded(other, node.topLeft, t.guard);
      if (node.topLeft.x < other.topLeft.x + other.width + delta && right + delta > other.topLeft.x &&
        node.topLeft.y < other.topLeft.y + other.height + delta && bottom + delta > other.topLeft.y) {
        return true;
      }
    }
    t.guard.finish();
    return false;
  },

  /**
   * Commit applies the queued operations and validates the result. A rejected trial is atomic: callers never observe a half-applied
   * graph (any exception, GoError or panic, rolls back first and is rethrown). Throws ErrInvalidCandidate for a rejected geometry.
   */
  commit(ctx) {
    const t = this;
    try {
      t.commit_(ctx);
    } catch (e) {
      t.rollback();
      throw e;
    }
  },

  commit_(ctx) {
    const t = this;
    if (ctx == null) throw errorf('TALA transaction commit requires a context');
    if (t.guard === null) throw errorf('TALA transaction commit requires a work guard');
    t.guard.finish();
    let cerr = ctx.err();
    if (cerr) throw cerr;
    for (const op of t.ops) {
      t.guard.step();
      cerr = ctx.err();
      if (cerr) throw cerr;
      op();
      cerr = ctx.err();
      if (cerr) throw cerr;
      // Syncing clusters will reposition cluster nodes, which may shrink containers. But repositioning containers can also expand clusters,
      // since cluster nodes can be containers.
      if (t.options.affectContainers) {
        t.repositionContainers(ctx);
        for (const container of t.graph.containers.keys()) {
          t.guard.step();
          cerr = ctx.err();
          if (cerr) throw cerr;
          if (container === null || container.topLeft === null) continue;
          const bad = t.graph.isBadStateContext(container, t.priorGraphState, t.options.ignoreContainerEscape, t.guard);
          if (bad) throw ErrInvalidCandidate;
        }
      }
      t.graph.syncClusters();
      t.graph.syncSequences();
      cerr = ctx.err();
      if (cerr) throw cerr;
    }

    const useDirtyValidation = t.collectOverlapValidationNodes(ctx);
    t.collectFixedOrigins(ctx);
    // Containment and fixed-position invariants remain graph-wide. Pairwise overlap is validated afterward from one stable post-state sweep.
    for (const n of t.graph.nodes) {
      t.guard.step();
      cerr = ctx.err();
      if (cerr) throw cerr;
      if (n == null) throw invariant.newError('transaction bad-state check received a nil node');
      if (n.topLeft === null) continue;
      const fixedOriginPointer = t.fixedOrigins.has(n.container_()) ? t.fixedOrigins.get(n.container_()) : null;
      const [bad] = t.graph.isStructurallyBadStateWithFixedOriginContext(n, t.priorGraphState, t.options.ignoreContainerEscape, fixedOriginPointer, true, t.guard);
      if (bad) throw ErrInvalidCandidate;
    }
    t.buildPostStateOverlapCandidates(ctx, useDirtyValidation);
    for (let nodeIndex = 0; nodeIndex < t.graph.nodes.length; nodeIndex++) {
      const n = t.graph.nodes[nodeIndex];
      if (t.overlapCandidates[nodeIndex].length === 0) continue;
      t.guard.step();
      cerr = ctx.err();
      if (cerr) throw cerr;
      if (n.topLeft === null) continue;
      const bad = t.hasBadPostStateOverlap(nodeIndex);
      if (bad) throw ErrInvalidCandidate;
    }

    // If a non-exact overlap became an exact overlap, that's bad
    for (const [n1, overlaps] of t.priorGraphState.existingOverlaps) {
      t.guard.step();
      cerr = ctx.err();
      if (cerr) throw cerr;
      for (const n2 of overlaps) {
        if (useDirtyValidation) {
          const firstChanged = t.dirtyNodes.has(n1);
          const secondChanged = t.dirtyNodes.has(n2);
          if (!firstChanged && !secondChanged) continue;
        }
        t.guard.step();
        cerr = ctx.err();
        if (cerr) throw cerr;
        let wasExact = false;
        const exact = t.priorGraphState.existingExactOverlaps.get(n1);
        if (exact !== undefined && exact.has(n2)) wasExact = true;
        if (!wasExact) {
          if (n1.doesOverlapExact(n2)) throw ErrInvalidCandidate;
        }
      }
    }

    cerr = ctx.err();
    if (cerr) throw cerr;
    t.guard.finish();
  },

  /** Clear only needs to be called if transaction will be reused */
  clear() {
    this.ops = [];
  },

  rollback() {
    const t = this;
    const state = t.priorGraphState;
    if (state.captureTopology) {
      restoreGraphSnapshot(state.graph, t.graph);

      for (const [cluster, snapshot] of state.clusters) {
        Object.assign(cluster, snapshot.value);
        cluster.nodes = restoreExactSlice(snapshot.nodes);
        cluster.edgeAbductions = restoreExactSlice(snapshot.edgeAbductions);
      }
      for (const [sequence, snapshot] of state.sequences) {
        Object.assign(sequence, snapshot.value);
        sequence.nodes = restoreExactSlice(snapshot.nodes);
        sequence.edgeAbductions = restoreExactSlice(snapshot.edgeAbductions);
      }
      for (const [tree, snapshot] of state.trees) {
        Object.assign(tree, snapshot.value);
        tree.children = restoreExactSlice(snapshot.children);
      }
      for (const [abduction, snapshot] of state.edgeAbductions) Object.assign(abduction, snapshot);
      for (const [herd, snapshot] of state.herds) {
        Object.assign(herd, snapshot.value);
        herd.oppositeSidePaired = restoreMap(snapshot.value.oppositeSidePaired, snapshot.oppositeSidePaired);
        herd.sameSidePaired = restoreMap(snapshot.value.sameSidePaired, snapshot.sameSidePaired);
      }
      for (const [hierarchy, snapshot] of state.hierarchies) {
        Object.assign(hierarchy, snapshot.value);
        hierarchy.level = restoreMap(snapshot.value.level, snapshot.level);
      }
      for (const [edge, snapshot] of state.edges) restoreEdge(snapshot, edge);
      for (const [node, snapshot] of state.nodes) restoreNode(snapshot, node);
      return;
    }

    for (const [node, geometry] of state.nodeGeometry) {
      node.topLeft = restorePointer(geometry.topLeft);
      node.width = geometry.width;
      node.height = geometry.height;
    }
    for (const [cluster, arrangement] of state.clusterArrangements) {
      cluster.arrangement = arrangement;
      cluster.desiredArrangement = state.clusterDesired.get(cluster);
      cluster.padding = state.clusterPaddings.get(cluster);
    }
    if (state.edgeGeometry !== null) {
      for (const [edge, snapshot] of state.edgeGeometry) restoreEdge(snapshot, edge);
    }
    for (const [tree, orientation] of state.treeOrientations) tree.orientation = orientation;
    state.originalNodesRef.splice(0, state.originalNodesRef.length, ...state.originalNodes);
    t.graph.nodes = state.originalNodesRef;
  },

  /**
   * CloneGeometryContext creates a nested speculative transaction that may only move geometry. GraphState snapshots are immutable for
   * such trials, so sharing the rollback point avoids cloning every node map and overlap-exception set.
   */
  cloneGeometryContext() {
    const t = this;
    if (t == null || t.priorGraphState === null || t.guard === null) throw errorf('TALA geometry transaction clone requires an initialized transaction');
    if (t.priorGraphState.captureTopology) throw errorf('TALA topology transaction requires an independent clone');
    t.guard.finish();
    // The source and clone now have equal read-only ownership of this rollback point.
    t.priorGraphStateShared = true;
    const c = new Transaction();
    c.ops = cloneSlice(t.ops);
    c.graph = t.graph;
    c.options = t.options;
    c.guard = t.guard;
    c.priorGraphState = t.priorGraphState;
    c.priorGraphStateShared = true;
    return c;
  },
});

/** The broad phase used by doesOverlapWithDimensionsContext. NaN values deliberately survive the comparisons. */
function transactionBoxesMayInteract(first, second) {
  if (first == null || second == null || first === second || first.topLeft === null || second.topLeft === null) return false;
  const maxSafeDelta = 500.0;
  return !(first.topLeft.x > second.topLeft.x + second.width + maxSafeDelta ||
    first.topLeft.x + first.width + maxSafeDelta < second.topLeft.x ||
    first.topLeft.y > second.topLeft.y + second.height + maxSafeDelta ||
    first.topLeft.y + first.height + maxSafeDelta < second.topLeft.y);
}

// ==== clone.go ====

/**
 * Clone returns the layout graph projection used for an independent layout attempt. It deliberately copies the stable graph state, not
 * transient optimizer state: derived caches, herd assignments, long-distance placement requirements, route diagnostics, margins,
 * paddings, loop offsets and fixed-label bookkeeping (Label/Icon positionFixed) are reset. The returned graph is published only after
 * the complete bounded copy has succeeded. Every graph-owned node, cluster, and sequence is rebound to the returned graph; inactive
 * cluster and sequence vessels remain detached.
 */
export function clone(ctx, source) {
  const staged = new Graph();
  cloneInto(ctx, source, staged);
  return staged;
}

function cloneInto(ctx, source, staged) {
  if (ctx == null) throw errorf('TALA CloneGraph requires a context');
  if (source == null) throw errorf('cannot clone a nil graph');
  validateEngineGraph(ctx, 'CloneGraph', source);
  const guard = limits.newWorkGuard(ctx, 'CloneGraph', limits.MaxEngineWorkUnits);

  const state = new GraphCloneState(source, staged, guard);
  state.copy();
  guard.finish();
}

class GraphCloneState {
  constructor(source, clone_, guard) {
    this.source = source;
    this.clone = clone_;
    this.guard = guard;

    this.nodesByID = new Map(); // Map<EntityID, Node>
    this.nodeRecordsByID = new Map();
    // Cluster and sequence members join Graph.Nodes in the codec's top-level node records; grouping vessels do not. Trees may reuse only the former.
    this.topLevelNodeIDs = new Set();
    this.nodesBySource = new Map();
    this.nodeRecords = [];
    this.treeNodeRecords = [];

    this.edgesBySource = new Map();
    this.edgesByID = new Map();

    this.clustersBySource = new Map();
    this.sequencesBySource = new Map();
  }

  copy() {
    const state = this;
    const inSerializedNodes = new Set();
    for (const node of state.source.nodes) {
      state.addNodeRecord(node);
      inSerializedNodes.add(node);
    }
    for (const vessel of state.source.clusterOrder()) {
      inSerializedNodes.add(vessel);
      for (const node of state.source.clusters.get(vessel).nodes) {
        if (inSerializedNodes.has(node)) continue;
        state.addNodeRecord(node);
        inSerializedNodes.add(node);
      }
    }
    for (const vessel of state.source.sequenceOrder()) {
      inSerializedNodes.add(vessel);
      for (const node of state.source.sequences.get(vessel).nodes) {
        if (inSerializedNodes.has(node)) continue;
        state.addNodeRecord(node);
        inSerializedNodes.add(node);
      }
    }

    state.clone.edges = [];
    for (const edge of state.source.edges) {
      state.guard.step();
      if (edge == null) throw errorf('cannot clone a nil edge');
      if (state.edgesBySource.has(edge)) throw errorf(`cannot clone duplicate edge record ${edge.id}`);
      if (edge.id !== 0n) {
        if (state.edgesByID.has(edge.id)) throw errorf(`cannot clone duplicate edge ID ${edge.id}`);
      }
      const cloned = state.copyEdge(edge);
      state.edgesBySource.set(edge, cloned);
      if (edge.id !== 0n) state.edgesByID.set(edge.id, cloned);
      cloned.from.addEdge(cloned);
      if (!cloned.isLoop_()) cloned.to.addEdge(cloned);
      state.clone.edges.push(cloned);
    }

    state.copyContainers();
    state.copyClusters();
    state.copySequences();
    state.copyHubs();
    state.copyAbductions();
    state.copyTrees();
    state.copyNears();
    state.copyHierarchies();
    state.copyDirections();

    const filtered = [];
    for (const sourceNode of state.nodeRecords) {
      state.guard.step();
      const node = state.nodesBySource.get(sourceNode);
      if (node.cluster !== null && clusterIsActive(node.cluster)) continue;
      if (node.sequence !== null && sequenceIsActive(node.sequence)) continue;
      filtered.push(node);
    }
    state.clone.nodes = filtered;
    state.clone.cellSize = state.source.cellSize;
    state.clone.isRootHierarchy = state.source.isRootHierarchy;
    state.clone.commonUncleSiblings = null;
    state.clone.edgeLengthCache = new Map();

    state.clone.crossingCost_ = state.source.crossingCost_;
    state.clone.turnCost_ = state.source.turnCost_;
    state.clone.nonCenterPortCost_ = state.source.nonCenterPortCost_;
  }

  addNodeRecord(source) {
    const state = this;
    state.guard.step();
    if (source == null) throw errorf('cannot clone a nil node');
    if (source.id === 0n) throw errorf('cannot clone reserved node ID 0');
    if (state.nodesByID.has(source.id)) throw errorf(`cannot clone duplicate node ID ${source.id}`);
    const cloned = copyNodeRecord(source, state.clone);
    state.nodesByID.set(source.id, cloned);
    state.nodeRecordsByID.set(source.id, source);
    state.topLevelNodeIDs.add(source.id);
    state.nodesBySource.set(source, cloned);
    state.nodeRecords.push(source);
    return cloned;
  }

  /**
   * copyAuxiliaryNodeRecord copies a node record embedded in another graph record, such as a grouping vessel or tree node. References
   * elsewhere in the graph are resolved by ID, but two distinct full records with the same ID cannot be merged. Returns [node, copied].
   */
  copyAuxiliaryNodeRecord(source, relation) {
    const state = this;
    if (source == null) throw errorf(`cannot clone ${relation}: nil node`);
    if (source.id === 0n) throw errorf(`cannot clone ${relation}: reserved node ID 0`);
    if (state.nodeRecordsByID.has(source.id)) {
      const declared = state.nodeRecordsByID.get(source.id);
      if (declared !== source) throw errorf(`cannot clone ${relation}: distinct node record reuses ID ${source.id}`);
      return [state.nodesByID.get(source.id), false];
    }

    const cloned = copyNodeRecord(source, state.clone);
    state.nodesByID.set(source.id, cloned);
    state.nodeRecordsByID.set(source.id, source);
    state.nodesBySource.set(source, cloned);
    return [cloned, true];
  }

  resolveNode(source, relation) {
    if (source === null) return null;
    this.guard.step();
    const cloned = this.nodesByID.get(source.id);
    if (cloned === undefined) throw errorf(`cannot clone ${relation}: node ${source.id} is not included in the graph`);
    this.nodesBySource.set(source, cloned);
    return cloned;
  }

  copyEdge(source) {
    const state = this;
    const from = state.resolveNode(source.from, 'edge source');
    const to = state.resolveNode(source.to, 'edge target');
    if (from === null || to === null) throw errorf(`cannot clone edge ${source.id} with a nil endpoint`);

    const cloned = newEdge(from, to);
    cloned.id = source.id;
    cloned.d2ID = source.d2ID;
    cloned.sourceArrowhead = source.sourceArrowhead;
    cloned.targetArrowhead = source.targetArrowhead;
    cloned.sourceArrowheadLabel = copyLabelRecord(source.sourceArrowheadLabel);
    cloned.targetArrowheadLabel = copyLabelRecord(source.targetArrowheadLabel);
    cloned.minWidth = source.minWidth;
    cloned.minHeight = source.minHeight;
    cloned.label = copyLabelRecord(source.label);
    cloned.labelPercentage = source.labelPercentage;
    cloned.fromTableColumnIndex = source.fromTableColumnIndex;
    cloned.toTableColumnIndex = source.toTableColumnIndex;
    cloned.isInvisible = source.isInvisible;
    cloned.style = copyEdgeStyle(source.style);
    for (const point of source.points) {
      state.guard.step();
      cloned.points.push(point.copy());
    }
    return cloned;
  }

  copyContainers() {
    const state = this;
    state.clone.containers = new Map();
    if (state.source.containers.size === 0) return;
    let order = state.source.containerRDFSOrderContext(null, state.guard);
    if (state.source.containers.size !== order.length + 1) {
      throw errorf(`cannot clone containers: map length ${state.source.containers.size} does not match hierarchy length ${order.length + 1}`);
    }
    order = order.concat([null]);
    for (const sourceContainer of order) {
      const container = state.resolveNode(sourceContainer, 'container');
      const children = containersOf(state.source, sourceContainer);
      const clonedChildren = [];
      for (const sourceChild of children) {
        if (sourceChild == null || state.nodeRecordsByID.get(sourceChild.id) !== sourceChild) {
          throw errorf('cannot clone container child: exact node record is not available');
        }
        const child = state.resolveNode(sourceChild, 'container child');
        if (child === null) throw errorf('cannot clone a nil container child');
        child.container = container;
        clonedChildren.push(child);
      }
      state.clone.containers.set(container, clonedChildren);
      if (container !== null) container.isContainer_ = true;
    }
  }

  copyClusters() {
    const state = this;
    state.clone.clusters = new Map();
    for (const sourceVessel of state.source.clusterOrder()) {
      state.guard.step();
      const sourceCluster = state.source.clusters.get(sourceVessel);
      if (sourceCluster == null) throw errorf(`cannot clone nil cluster for vessel ${sourceVessel.id}`);
      if (sourceCluster.vessel !== sourceVessel) throw errorf(`cannot clone cluster under vessel ${sourceVessel.id} because its record vessel differs`);
      if (sourceCluster.container !== null && sourceCluster.container.id === sourceVessel.id) {
        throw errorf(`cannot clone cluster ${sourceVessel.id} because it cannot contain itself`);
      }
      const [vessel, copied] = state.copyAuxiliaryNodeRecord(sourceVessel, 'cluster vessel');
      if (copied) vessel.graph = null;
      vessel.isClusterVessel_ = true;

      const container = state.resolveNode(sourceCluster.container, 'cluster container');
      const members = [];
      for (const sourceMember of sourceCluster.nodes) members.push(state.resolveNode(sourceMember, 'cluster member'));
      const cluster = new Cluster();
      cluster.vessel = vessel;
      cluster.nodes = members;
      cluster.arrangement = sourceCluster.arrangement;
      cluster.desiredArrangement = sourceCluster.desiredArrangement;
      cluster.graph = state.clone;
      cluster.padding = sourceCluster.padding;
      cluster.fixedSize = sourceCluster.fixedSize;
      cluster.container = container;
      state.clone.clusters.set(vessel, cluster);
      state.clustersBySource.set(sourceCluster, cluster);
      for (const member of members) {
        state.guard.step();
        member.cluster = cluster;
      }
    }
  }

  copySequences() {
    const state = this;
    state.clone.sequences = new Map();
    for (const sourceVessel of state.source.sequenceOrder()) {
      state.guard.step();
      const sourceSequence = state.source.sequences.get(sourceVessel);
      if (sourceSequence == null) throw errorf(`cannot clone nil sequence for vessel ${sourceVessel.id}`);
      if (sourceSequence.vessel !== sourceVessel) throw errorf(`cannot clone sequence under vessel ${sourceVessel.id} because its record vessel differs`);
      if (sourceSequence.container !== null && sourceSequence.container.id === sourceVessel.id) {
        throw errorf(`cannot clone sequence ${sourceVessel.id} because it cannot contain itself`);
      }
      if (sourceSequence.nodes.length < 2) {
        throw errorf(`cannot clone sequence ${sourceVessel.id} with ${sourceSequence.nodes.length} steps; want at least 2`);
      }
      const [vessel, copied] = state.copyAuxiliaryNodeRecord(sourceVessel, 'sequence vessel');
      if (copied) vessel.graph = null;

      const container = state.resolveNode(sourceSequence.container, 'sequence container');
      const members = [];
      for (const sourceMember of sourceSequence.nodes) members.push(state.resolveNode(sourceMember, 'sequence member'));
      const sequence = new Sequence();
      sequence.vessel = vessel;
      sequence.nodes = members;
      sequence.graph = state.clone;
      sequence.container = container;
      state.clone.sequences.set(vessel, sequence);
      state.sequencesBySource.set(sourceSequence, sequence);
      for (const member of members) {
        state.guard.step();
        member.sequence = sequence;
      }
    }
  }

  copyHubs() {
    const state = this;
    state.clone.hubs = new Map();
    for (const sourceHub of state.source.hubOrder()) {
      const hub = state.resolveNode(sourceHub, 'hub');
      const spokes = [];
      for (const sourceSpoke of state.source.hubs.get(sourceHub)) {
        if (sourceSpoke == null || state.nodeRecordsByID.get(sourceSpoke.id) !== sourceSpoke) {
          throw errorf('cannot clone hub spoke: exact node record is not included in the graph');
        }
        spokes.push(state.resolveNode(sourceSpoke, 'hub spoke'));
      }
      state.clone.hubs.set(hub, spokes);
    }
  }

  copyAbductions() {
    const state = this;
    const copyFor = (sourceAbductions) => {
      const cloned = [];
      for (const sourceAbduction of sourceAbductions) {
        state.guard.step();
        let edge = state.edgesBySource.get(sourceAbduction.edge) ?? null;
        if (edge === null && sourceAbduction.edge.id !== 0n) edge = state.edgesByID.get(sourceAbduction.edge.id) ?? null;
        if (edge === null) throw errorf(`cannot clone edge abduction for edge ${sourceAbduction.edge.id} before the edge is copied`);
        const ea = new EdgeAbduction();
        ea.edge = edge;
        ea.originallyFrom = state.resolveNode(sourceAbduction.originallyFrom, 'abduction original source');
        ea.originallyTo = state.resolveNode(sourceAbduction.originallyTo, 'abduction original target');
        ea.currentFrom = state.resolveNode(sourceAbduction.currentFrom, 'abduction current source');
        ea.currentTo = state.resolveNode(sourceAbduction.currentTo, 'abduction current target');
        cloned.push(ea);
      }
      return cloned;
    };

    for (const sourceVessel of state.source.clusterOrder()) {
      const sourceCluster = state.source.clusters.get(sourceVessel);
      state.clustersBySource.get(sourceCluster).edgeAbductions = copyFor(sourceCluster.edgeAbductions);
    }
    for (const sourceVessel of state.source.sequenceOrder()) {
      const sourceSequence = state.source.sequences.get(sourceVessel);
      state.sequencesBySource.get(sourceSequence).edgeAbductions = copyFor(sourceSequence.edgeAbductions);
    }
  }

  copyTrees() {
    const state = this;
    state.clone.trees = new Map();
    state.clone.nodeToTree = new Map();
    const treeOwnersByNodeID = new Set();

    const copyTree = (source, parent) => {
      state.guard.step();
      if (source.sentinelEdge === null) throw errorf('cannot clone a tree with a nil sentinel edge');
      if (source.node === null) throw errorf('cannot clone a tree with a nil node');
      if (treeOwnersByNodeID.has(source.node.id)) throw errorf(`cannot clone tree node ${source.node.id} with more than one tree owner`);
      treeOwnersByNodeID.add(source.node.id);
      const declared = state.nodeRecordsByID.get(source.node.id);
      if (declared === source.node) {
        if (!state.topLevelNodeIDs.has(source.node.id)) {
          throw errorf(`cannot clone tree node ${source.node.id} because it repeats a non-top-level node record`);
        }
      }

      const [node, copied] = state.copyAuxiliaryNodeRecord(source.node, 'tree node');
      if (copied) state.treeNodeRecords.push(source.node);

      let sentinel = state.edgesBySource.get(source.sentinelEdge) ?? null;
      if (sentinel === null && source.sentinelEdge.id !== 0n && (state.edgesByID.get(source.sentinelEdge.id) ?? null) !== null) {
        throw errorf(`cannot clone tree sentinel edge: distinct edge record reuses ID ${source.sentinelEdge.id}`);
      }
      if (sentinel === null) {
        sentinel = state.copyEdge(source.sentinelEdge);
        state.edgesBySource.set(source.sentinelEdge, sentinel);
        if (source.sentinelEdge.id !== 0n) state.edgesByID.set(source.sentinelEdge.id, sentinel);
      }
      const cloned = new Tree(node);
      cloned.parent = parent;
      cloned.sentinelEdge = sentinel;
      cloned.orientation = source.orientation;
      cloned.children = [];
      state.clone.nodeToTree.set(node, cloned);
      for (const sourceChild of source.children) cloned.children.push(copyTree(sourceChild, cloned));
      return cloned;
    };

    for (const sourceSentinel of state.source.treeOrder()) {
      const sentinel = state.resolveNode(sourceSentinel, 'tree root sentinel');
      const roots = [];
      for (const sourceRoot of state.source.trees.get(sourceSentinel)) roots.push(copyTree(sourceRoot, null));
      if (roots.length > 0) state.clone.trees.set(sentinel, roots);
    }
  }

  copyNears() {
    const state = this;
    for (const source of state.nodeRecords.concat(state.treeNodeRecords)) {
      const node = state.nodesBySource.get(source);
      for (const sourceNear of source.orderedNears_()) {
        state.guard.step();
        const near = state.resolveNode(sourceNear, 'near relation');
        node.addNear(near);
      }
    }
  }

  copyHierarchies() {
    const state = this;
    const seen = new Set();
    for (const sourceNode of state.source.nodes) {
      state.guard.step();
      const sourceHierarchy = sourceNode.hierarchy;
      if (sourceHierarchy === null) continue;
      if (seen.has(sourceHierarchy)) continue;
      seen.add(sourceHierarchy);
      const levels = new Map();
      const clonedHierarchy = new Hierarchy();
      clonedHierarchy.level = levels;
      for (const [sourceMember, level] of sourceHierarchy.level) {
        const member = state.resolveNode(sourceMember, 'hierarchy member');
        levels.set(member, level);
        member.hierarchy = clonedHierarchy;
      }
    }
  }

  copyDirections() {
    const state = this;
    state.clone.directions = new Map();
    for (const [sourceContainer, sourceDirection] of state.source.directions) {
      const container = state.resolveNode(sourceContainer, 'direction container');
      state.clone.directions.set(container, canonicalDirection(sourceDirection));
    }
  }
}

function copyNodeRecord(source, owner) {
  const cloned = newNode(source.id, source.width, source.height);
  cloned.d2ID = source.d2ID;
  cloned.topLeft = source.topLeft === null ? null : source.topLeft.copy();
  cloned.fixedTopLeft = source.fixedTopLeft === null ? null : source.fixedTopLeft.copy();
  cloned.graph = owner;
  cloned.fontSize = source.fontSize;
  cloned.desiredWidth = source.desiredWidth;
  cloned.desiredHeight = source.desiredHeight;
  cloned.setShape(source.shapeType());
  cloned.setNumColumns(source.numColumns());
  cloned.forceHierarchy = source.forceHierarchy;
  cloned.label = copyLabelRecord(source.label);
  cloned.icon = copyIconRecord(source.icon);
  cloned.is3D = source.is3D;
  cloned.isMultiple = source.isMultiple;
  cloned.isInvisible = source.isInvisible;
  return cloned;
}

function copyLabelRecord(source) {
  if (source === null) return null;
  return new Label(source.text, label.fromString(label.positionString(source.position)), source.width, source.height);
}

function copyIconRecord(source) {
  if (source === null) return null;
  const icon = new Icon();
  icon.position = label.fromString(label.positionString(source.position));
  return icon;
}

function copyEdgeStyle(source) {
  const style = new EdgeStyle();
  for (const f of EDGE_STYLE_FIELDS) style[f] = source[f] === null ? null : new StyleScalar(source[f].value);
  return style;
}

function canonicalDirection(direction) {
  switch (direction) {
    case Orientation.Top: case Orientation.Bottom: case Orientation.Left: case Orientation.Right:
      return direction;
    default:
      return Orientation.NONE;
  }
}

// ==== hub_spoke.go ====

Graph.prototype.hubOrder = function () {
  const order = [...this.hubs.keys()];
  sortNodesByID_(order);
  return order;
};

// ==== placement_cost.go ====

/** PlacementCostSnapshot is an opaque copy of graph-owned placement scoring state used to roll back a rejected optimizer candidate. */
export class PlacementCostSnapshot {
  constructor() {
    this.graph = null;
    this.cacheRef = null;
    this.cache = null;
    this.crossingCost = 0;
    this.turnCost = 0;
    this.nonCenterPortCost = 0;
  }

  /** Restore reinstates the captured costs and the exact cache map owned by the graph when the state was captured. */
  restore() {
    if (this == null || this.graph === null) return;
    if (this.cacheRef === null) {
      this.graph.edgeLengthCache = null;
    } else {
      this.cacheRef.clear();
      if (this.cache !== null) for (const [k, v] of this.cache) this.cacheRef.set(k, v);
      this.graph.edgeLengthCache = this.cacheRef;
    }
    this.graph.crossingCost_ = this.crossingCost;
    this.graph.turnCost_ = this.turnCost;
    this.graph.nonCenterPortCost_ = this.nonCenterPortCost;
  }
}

Object.assign(Graph.prototype, {
  /** LookupEdgeLengthCost reads one entry from the graph-owned placement cache: [cost, ok]. The state is a hash (BigInt or number). */
  lookupEdgeLengthCost(state) {
    if (this.edgeLengthCache === null || !this.edgeLengthCache.has(state)) return [0, false];
    return [this.edgeLengthCache.get(state), true];
  },

  /** StoreEdgeLengthCost writes one entry. It is a no-op when this graph has disabled placement caching. */
  storeEdgeLengthCost(state, cost) {
    if (this.edgeLengthCache !== null) this.edgeLengthCache.set(state, cost);
  },

  /** EdgeLengthCacheEntries reports the size of the graph-owned placement cache. */
  edgeLengthCacheEntries() {
    return this.edgeLengthCache === null ? 0 : this.edgeLengthCache.size;
  },

  /** ResetPlacementCosts clears route-derived scoring state without replacing the graph's cache map or changing whether caching is enabled. */
  resetPlacementCosts() {
    if (this.edgeLengthCache !== null) this.edgeLengthCache.clear();
    this.crossingCost_ = 0;
    this.turnCost_ = 0;
    this.nonCenterPortCost_ = 0;
  },

  /** SnapshotPlacementCosts copies graph-owned scoring state. */
  snapshotPlacementCosts() {
    const snapshot = new PlacementCostSnapshot();
    snapshot.graph = this;
    snapshot.cacheRef = this.edgeLengthCache;
    snapshot.crossingCost = this.crossingCost_;
    snapshot.turnCost = this.turnCost_;
    snapshot.nonCenterPortCost = this.nonCenterPortCost_;
    if (this.edgeLengthCache !== null) snapshot.cache = new Map(this.edgeLengthCache);
    return snapshot;
  },

  /** RoutingCosts: the cached routing-cost state that an atomic routing stage must restore on failure. */
  routingCosts() {
    return { crossing: this.crossingCost_, turn: this.turnCost_, nonCenterPort: this.nonCenterPortCost_ };
  },

  restoreRoutingCosts(state) {
    this.crossingCost_ = state.crossing;
    this.turnCost_ = state.turn;
    this.nonCenterPortCost_ = state.nonCenterPort;
  },

  crossingCost() {
    return this.crossingCostValue();
  },

  nonCenterPortCost() {
    return this.nonCenterPortCostValue();
  },

  turnCost() {
    return this.turnCostValue();
  },

  halveTurnCost() {
    this.turnCost_ /= 2;
  },

  resetTurnCost() {
    this.resetTurnCost_();
  },
});

// ==== positioned_validation.go ====

const maxPositionedRoutePoints = 1_000_000;

/**
 * ValidatePositionedGraphSelection checks the topology and positioned route geometry consumed by label placement and completed-layout
 * evaluation. extraEdges may repeat graph edges once (the normal route-only selection), but neither input list may contain aliases within itself.
 */
export function validatePositionedGraphSelection(ctx, operation, graph, extraEdges) {
  // Keep the central topology preflight first. Its graph-before-context error order is part of the direct engine API contract.
  validateEngineGraph(ctx, operation, graph);
  if (ctx == null) throw errorf(`TALA ${operation} requires a context`);
  let cerr = ctx.err();
  if (cerr) throw errorf(`${operation}: ${cerr.message}`, cerr);
  if (graph == null) throw errorf(`TALA ${operation} requires a graph`);
  extraEdges = extraEdges ?? [];
  if (graph.nodes.length > limits.MaxEngineNodes) throw errorf(`TALA ${operation} node count exceeds limit ${limits.MaxEngineNodes}`);
  if (graph.edges.length > limits.MaxEngineEdges) throw errorf(`TALA ${operation} edge count exceeds limit ${limits.MaxEngineEdges}`);
  if (extraEdges.length > limits.MaxEngineEdges) throw errorf(`TALA ${operation} requested edge count exceeds limit ${limits.MaxEngineEdges}`);

  let checks = 0;
  const checkContext = () => {
    checks++;
    if (checks % 64 !== 0) return;
    const err = ctx.err();
    if (err) throw errorf(`${operation}: ${err.message}`, err);
  };
  graph.nodes.forEach((node, index) => {
    checkContext();
    if (node == null) throw errorf(`TALA ${operation} graph node at index ${index} is nil`);
    if (node.topLeft === null) throw errorf(`TALA ${operation} graph node ${node.id} has no position`);
    if (node.cluster !== null && node.cluster.vessel === null) throw errorf(`TALA ${operation} graph node ${node.id} has a cluster without a vessel`);
    if (node.sequence !== null && node.sequence.vessel === null) throw errorf(`TALA ${operation} graph node ${node.id} has a sequence without a vessel`);
  });

  const seenGraphEdges = new Set();
  const seenRequestedEdges = new Set();
  const validatedEdges = new Set();
  let routePoints = 0;
  const validateEdge = (edge, index, kind, seenInList) => {
    checkContext();
    if (edge == null) throw errorf(`TALA ${operation} ${kind} at index ${index} is nil`);
    if (seenInList.has(edge)) throw errorf(`TALA ${operation} ${kind} at index ${index} repeats edge ${edge.entityID()}`);
    seenInList.add(edge);
    if (validatedEdges.has(edge)) return;
    validatedEdges.add(edge);
    if (edge.from == null || edge.to == null) throw errorf(`TALA ${operation} edge ${edge.entityID()} has missing endpoints`);
    if (edge.points.length > maxPositionedRoutePoints - routePoints) throw errorf(`TALA ${operation} route point count exceeds limit ${maxPositionedRoutePoints}`);
    routePoints += edge.points.length;
    edge.points.forEach((point, pointIndex) => {
      checkContext();
      if (point == null) throw errorf(`TALA ${operation} edge ${edge.entityID()} route point at index ${pointIndex} is nil`);
    });
    if ((edge.label !== null || edge.sourceArrowheadLabel !== null || edge.targetArrowheadLabel !== null) && edge.points.length < 2) {
      throw errorf(`TALA ${operation} labeled edge ${edge.entityID()} requires at least two route points`);
    }
  };
  graph.edges.forEach((edge, index) => validateEdge(edge, index, 'graph edge', seenGraphEdges));
  extraEdges.forEach((edge, index) => validateEdge(edge, index, 'requested edge', seenRequestedEdges));
  cerr = ctx.err();
  if (cerr) throw errorf(`${operation}: ${cerr.message}`, cerr);
}

export function validatePositionedGraph(ctx, operation, graph) {
  validatePositionedGraphSelection(ctx, operation, graph, null);
}

// ==== segment_crossing.go ====

const scoringCancellationCheckInterval = 64;

/** CrossingSegment is an oriented line segment used by crossing scoring: {start: geo.Point, end: geo.Point}. */
export const newCrossingSegment = (start, end) => ({ start, end });

function scoringCancellationError(ctx, iteration) {
  if (iteration % scoringCancellationCheckInterval !== 0) return;
  const err = ctx.err();
  if (err) throw errorf(`EdgeLength: ${err.message}`, err);
}

/**
 * CountSegmentCrossings counts intersections between segments while ignoring pairs with equal starts or equal ends. It is the common
 * geometric kernel used by layout cost evaluation and hierarchy rank optimization. Returns a number (int64 in Go).
 */
export function countSegmentCrossings(segments) {
  return countSegmentCrossingsWithCheck(segments, null);
}

/** CountSegmentCrossingsContext is CountSegmentCrossings with the layout engine's bounded cancellation checks. */
export function countSegmentCrossingsContext(ctx, segments) {
  let err = ctx.err();
  if (err) throw errorf(`EdgeLength: ${err.message}`, err);
  const crossings = countSegmentCrossingsWithCheck(segments, (iteration) => scoringCancellationError(ctx, iteration));
  err = ctx.err();
  if (err) throw errorf(`EdgeLength: ${err.message}`, err);
  return crossings;
}

function countSegmentCrossingsWithCheck(segments, checkCanceled) {
  let crossings = 0;
  for (let i = 0; i < segments.length - 1; i++) {
    if (checkCanceled !== null) checkCanceled(i);
    const iStart = segments[i].start;
    const iEnd = segments[i].end;
    let minX = iStart.x, maxX = iEnd.x;
    if (maxX < minX) [minX, maxX] = [maxX, minX];
    let minY = iStart.y, maxY = iEnd.y;
    if (maxY < minY) [minY, maxY] = [maxY, minY];
    for (let j = i + 1; j < segments.length; j++) {
      if (checkCanceled !== null) checkCanceled(j - i - 1);
      const jStart = segments[j].start;
      const jEnd = segments[j].end;
      if (jStart.x < jEnd.x) {
        if (jEnd.x < minX) continue;
        if (maxX < jStart.x) continue;
      } else {
        if (jStart.x < minX) continue;
        if (maxX < jEnd.x) continue;
      }
      if (jStart.y < jEnd.y) {
        if (jEnd.y < minY) continue;
        if (maxY < jStart.y) continue;
      } else {
        if (jStart.y < minY) continue;
        if (maxY < jEnd.y) continue;
      }

      if (nonNilEquals(iStart, jStart) || nonNilEquals(iEnd, jEnd)) continue;
      if (segmentsCross(iStart, iEnd, jStart, jEnd)) crossings++;
    }
  }
  return crossings;
}

/** SegmentsCross reports whether two finite segments intersect. Parallel and overlapping segments do not count as crossings. */
export function segmentsCross(u0, u1, v0, v1) {
  const denom = ((u1.y - u0.y) * (v1.x - v0.x) - (u1.x - u0.x) * (v1.y - v0.y));
  if (denom === 0) return false;
  const s = ((v1.x - v0.x) * (v0.y - u0.y) - (v1.y - v0.y) * (v0.x - u0.x)) / denom;
  if (s < 0 || s > 1) return false;
  const t = ((u1.x - u0.x) * (v0.y - u0.y) - (u1.y - u0.y) * (v0.x - u0.x)) / denom;
  return t >= 0 && t <= 1;
}

// ==== the exported access wrappers (structure_api.go, hierarchy_access.go, placement_access.go, routing_access.go, ...) ====
// (the ones that are plain aliases of a member defined above are already defined next to it)

Object.assign(Graph.prototype, {
  boundingBox() {
    return this.bounds();
  },

  area() {
    return this.area_();
  },

  fixedNodes() {
    return this.fixedNodes_();
  },

  hasFixedNode() {
    return this.hasFixedNode_();
  },

  allDescendantNodes(node, includeClusterNodes) {
    return this.allDescendantNodes_(node, includeClusterNodes);
  },

  allDescendantNodesWithWorkGuard(node, includeClusterNodes, guard) {
    return this.allDescendantNodesGuarded(node, includeClusterNodes, guard);
  },

  containerPadding(container, considerChildren) {
    return this.containerPadding_(container, considerChildren);
  },

  containerFixedOrigin(container) {
    return this.containerFixedOrigin_(container);
  },

  isTreeSentinel(node) {
    return this.isTreeSentinel_(node);
  },

  isSequenceVessel(node) {
    return this.isSequence(node);
  },

  /** ContainerRDFSOrder returns nested containers from innermost to outermost while charging the supplied request work budget. */
  containerRDFSOrder(root, guard) {
    return this.containerRDFSOrderContext(root, guard);
  },

  containerRDFSOrderUnbounded(root) {
    return this.containerRDFSOrder_(root);
  },

  syncNestedGeometry() {
    this.syncNested();
  },

  isBadStateWithWorkGuard(node, graphState, ignoreContainerEscape, guard) {
    return this.isBadStateContext(node, graphState, ignoreContainerEscape, guard);
  },

  /**
   * ReplaceEdgesUnchecked replaces graph edge ownership and rebuilds both endpoint incidence lists. The caller is responsible for
   * supplying valid graph-owned endpoints.
   */
  replaceEdgesUnchecked(edges) {
    for (const edge of this.edges) {
      edge.from.edges = [];
      edge.to.edges = [];
    }
    this.edges = edges;
    for (const edge of edges) {
      edge.from.addEdge(edge);
      edge.to.addEdge(edge);
    }
  },

  /**
   * buildNodeToTreeGuarded derives the auxiliary node index while preserving graphjson's established validation order and shared decode
   * work budget.
   */
  buildNodeToTreeGuarded(guard) {
    const g = this;
    const nodeToTree = new Map();
    const order = [];
    for (const rootSentinel of g.trees.keys()) {
      guard.step();
      order.push(rootSentinel);
    }
    sortNodesByID_(order);
    guard.finish();
    for (const rootSentinel of order) {
      guard.step();
      for (const root of g.trees.get(rootSentinel)) {
        if (root == null || root.node == null) throw invariant.newError('tree sentinel contains an incomplete root');
        const queue = [root];
        const seen = new Set();
        for (let index = 0; index < queue.length; index++) {
          guard.step();
          const current = queue[index];
          if (current == null || current.node == null) throw invariant.newError('tree preprocessing encountered an incomplete tree');
          if (seen.has(current)) throw invariant.newError('tree preprocessing encountered a repeated tree node');
          seen.add(current);
          nodeToTree.set(current.node, current);
          for (const child of current.children) {
            guard.step();
            queue.push(child);
          }
        }
      }
    }
    g.nodeToTree = nodeToTree;
    guard.finish();
  },
});

Object.assign(Node.prototype, {
  isPointPastFixedOrigin(x, y, includeSizes) {
    const node = this;
    const fixedOrigin = node.graph.containerFixedOrigin_(node.container_());
    if (fixedOrigin === null) return false;
    if (!includeSizes) {
      fixedOrigin.x = goRound(fixedOrigin.x / node.graph.cellSize);
      fixedOrigin.y = goRound(fixedOrigin.y / node.graph.cellSize);
    }
    return x < fixedOrigin.x || y < fixedOrigin.y;
  },

  pointPastFixedOrigin(x, y, includeSizes) {
    return this.isPointPastFixedOrigin(x, y, includeSizes);
  },

  fixedOrigin_() {
    if (this.topLeft !== null && this.fixedTopLeft !== null) {
      return geo.newPoint(this.topLeft.x - this.fixedTopLeft.x, this.topLeft.y - this.fixedTopLeft.y);
    }
    return null;
  },

  /** FixedOrigin returns the fixed-position origin inherited through a node's descendants. */
  fixedOrigin() {
    return this.fixedOrigin_();
  },

  /** OwningContainer resolves the active cluster or sequence vessel before falling back to the node's direct container. */
  owningContainer() {
    return this.container_();
  },

  /** EffectiveContainer returns the node's active layout container (null for a nil node: use effectiveContainer(node)). */
  effectiveContainer() {
    return this.container_();
  },

  isSequenceStep() {
    return this != null && this.shapeType_ === stepType;
  },

  sameShape(other) {
    return this != null && other != null && this.shapeType_ === other.shapeType_;
  },

  unmarkClusterVessel() {
    if (this != null) this.isClusterVessel_ = false;
  },

  setContainer(value) {
    if (this != null) this.isContainer_ = value;
  },

  isContainer() {
    return this != null && this.isContainer_;
  },

  isTable() {
    return this.shapeType_ === tableType;
  },

  isClass() {
    return this != null && this.shapeType_ === classType;
  },

  isImage() {
    return this != null && this.shapeType_ === imageType;
  },

  setClusterVessel(value) {
    this.isClusterVessel_ = value;
  },

  isClusterVessel() {
    return this != null && this.isClusterVessel_;
  },

  /** FitToGraph */
  fitToGraph(graph, padding) {
    this.fitNodeToGraph(graph, padding);
  },

  idValue() {
    return this.entityID();
  },

  addIncidentEdgeUnchecked(edge) {
    this.addEdge(edge);
  },

  /** PadLabelCandidate expands (or shrinks, for a negative value) a temporary node box by the same amount on every side. */
  padLabelCandidate(padding) {
    this.pad(padding);
  },

  labelBoxesOverlap(other, padding) {
    return this.doesOverlapCalc(other, padding);
  },

  labelOverlapArea(other) {
    return this.overlapArea(other);
  },

  boundingBox(allNodes) {
    return this.bounds(allNodes);
  },
});

/** EffectiveContainer of a possibly nil node. */
export const effectiveContainer = (n) => (n === null ? null : n.container_());


// ==== graphjson_access.go (the decoder's entry points) ====

export const costsForSerialization = (graph) => [graph.crossingCost_, graph.turnCost_, graph.nonCenterPortCost_];
export const nodeIDForSerialization = (node) => (node === null ? 0n : node.entityID());
export const orderedNearsForSerialization = (node) => node.orderedNears_();
export const containerOrderForSerialization = (graph, guard) => graph.containerRDFSOrderContext(null, guard);
export const addDecodedEdge = (node, edge) => node.addEdge(edge);
export const markDecodedContainer = (node) => { node.isContainer_ = true; };
export const markDecodedClusterVessel = (node) => { node.isClusterVessel_ = true; };
export const isActiveClusterForSerialization = (cluster) => clusterIsActive(cluster);
export const isActiveSequenceForSerialization = (sequence) => sequenceIsActive(sequence);
export const newDecodedHierarchy = (levels) => {
  const h = new Hierarchy();
  h.level = levels;
  return h;
};
export const hierarchyLevelsForSerialization = (hierarchy) => hierarchy.level;

/** BuildNodeToTreeForDeserialization derives the auxiliary tree index under the decoder's shared work budget. */
export function buildNodeToTreeForDeserialization(trees, guard) {
  const graph = new Graph();
  graph.trees = trees;
  graph.buildNodeToTreeGuarded(guard);
  return graph.nodeToTree;
}

/** PublishDeserializedGraph atomically replaces graph-owned state while retaining the destination graph's identity. */
export function publishDeserializedGraph(destination, staged, crossing, turn, nonCenterPort) {
  destination.isRootHierarchy = staged.isRootHierarchy;
  destination.nodes = staged.nodes;
  destination.edges = staged.edges;
  destination.cellSize = staged.cellSize;

  destination.crossingCost_ = crossing;
  destination.turnCost_ = turn;
  destination.nonCenterPortCost_ = nonCenterPort;
  destination.edgeLengthCache = new Map();

  destination.containers = staged.containers;
  destination.clusters = staged.clusters;
  destination.trees = staged.trees;
  destination.nodeToTree = staged.nodeToTree;
  destination.hubs = staged.hubs;
  destination.sequences = staged.sequences;
  destination.directions = staged.directions;
  destination.commonUncleSiblings = staged.commonUncleSiblings;
}

