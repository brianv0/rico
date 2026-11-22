// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of result.go and result_validate.go of the Go package d2layouts/d2talalayout (D2 v0.9.0, Copyright 2022 Terrastruct Inc.):
// the score of a completed seed attempt, its validation against the immutable input (topology, metadata, geometry) and the seedResult
// record. Errors are thrown (GoError), see docs/d2-tala-port.md. The checks that the adapter shares (isFiniteResultNumber,
// validateResultCoordinate, validateResultDimension) are in d2talalayout.js (adapter_validate.go's half).

import * as geo from '../geo.js';
import * as label from '../label.js';
import * as d2fonts from '../fonts.js';
import { goV } from '../gomath.js';
import { quote } from '../url.js';
import { errorf, isPanic } from './goerrors.js';
import * as slices from './goslices.js';
import * as grouping from './grouping.js';
import * as quality from './quality.js';
import { EDGE_STYLE_FIELDS } from './layoutgraph.js';
import { isFiniteResultNumber, validateResultCoordinate, validateResultDimension } from './d2talalayout.js';

// ---- result.go ----

/** layoutScore is the stable ordering value for a completed layout attempt. Lower penalty is better; area breaks otherwise equal penalties. */
export class LayoutScore {
  constructor(penalty, area) {
    this.penalty = penalty;
    this.area = area;
  }

  /** compare reports whether score sorts before (-1), with (0), or after (1) other. */
  compare(other) {
    const comparison = comparePenalty(this.penalty, other.penalty);
    if (comparison !== 0) return comparison;
    return compareArea(this.area, other.area);
  }
}

export function compareArea(left, right) {
  const leftValid = isFiniteResultNumber(left) && left >= 0;
  const rightValid = isFiniteResultNumber(right) && right >= 0;
  if (leftValid && !rightValid) return -1;
  if (!leftValid && rightValid) return 1;
  if (!leftValid) return 0;
  return slices.compare(left, right);
}

export function comparePenalty(left, right) {
  const leftFinite = isFiniteResultNumber(left);
  const rightFinite = isFiniteResultNumber(right);
  if (leftFinite && !rightFinite) return -1;
  if (!leftFinite && rightFinite) return 1;
  if (!leftFinite) return 0;
  // Approximate equality is not transitive, so using a tolerance here can
  // make the selected seed depend on the order that workers finish.
  return slices.compare(left, right);
}

/**
 * evaluateSeedResult validates a completed local attempt against its immutable input and computes its ordering score. Returns a seedResult:
 * {bindings, graph, sequenceEdges (a Set of BigInt IDs), score (LayoutScore)}.
 */
export function evaluateSeedResult(ctx, input, graph) {
  const err = ctx.err();
  if (err) throw err;
  if (input.graph == null) throw errorf('TALA seed input is empty');
  if (graph == null) throw errorf('TALA seed result is empty');
  try {
    validateCompletedGraph(ctx, graph);
  } catch (e) {
    throw wrap('validate TALA seed result', e);
  }
  let sequenceEdges;
  try {
    sequenceEdges = validateLayoutResultTopology(ctx, input.graph, graph);
  } catch (e) {
    throw wrap('validate TALA seed result topology', e);
  }
  try {
    validateLayoutResultMetadata(ctx, input.graph, graph, sequenceEdges);
  } catch (e) {
    throw wrap('validate TALA seed result metadata', e);
  }
  const [penalty, area] = quality.evaluateWithArea(ctx, graph);
  if (!isFiniteResultNumber(penalty)) throw errorf('TALA seed result has a non-finite score');
  return {
    bindings: input.bindings,
    graph,
    sequenceEdges,
    score: new LayoutScore(penalty, area),
  };
}

/** fmt.Errorf("%s: %w", prefix, e) for an error that is a Go error value; a panic (TypeError ...) passes through. */
function wrap(prefix, e) {
  if (isPanic(e)) throw e;
  return errorf(`${prefix}: ${e.message}`, e);
}

// ---- result_validate.go ----

/**
 * validateLayoutResultTopology binds a completed workspace to its immutable input while allowing sequence-defining edges to be consumed by the
 * layoutgraph. All other input records must still be present with the same identity and endpoints, and the result may not introduce extra
 * records. Returns the Set of the IDs of the sequence-defining edges.
 */
export function validateLayoutResultTopology(ctx, expected, actual) {
  const sequenceEdges = grouping.sequenceDefiningEdges(ctx, expected);
  validateTopology(ctx, expected, actual, sequenceEdges);
  return sequenceEdges;
}

const checkCtx = (ctx) => {
  const err = ctx.err();
  if (err) throw err;
};

export function validateTopology(ctx, expected, actual, allowedMissingEdges) {
  if (expected == null || actual == null) throw errorf('cannot compare nil graph topology');
  if (expected.nodes.length !== actual.nodes.length) {
    throw errorf(`node count changed from ${expected.nodes.length} to ${actual.nodes.length}`);
  }
  const expectedNodes = new Set();
  for (const node of expected.nodes) {
    checkCtx(ctx);
    if (node === null) throw errorf('input contains a nil node');
    if (expectedNodes.has(node.id)) throw errorf(`input contains duplicate node ID ${node.id}`);
    expectedNodes.add(node.id);
  }
  for (const node of actual.nodes) {
    checkCtx(ctx);
    if (!expectedNodes.has(node.id)) throw errorf(`result contains unexpected node ID ${node.id}`);
  }

  const expectedEdges = new Map();
  for (const edge of expected.edges) {
    checkCtx(ctx);
    if (edge === null || edge.from === null || edge.to === null) throw errorf('input contains an edge with a nil endpoint');
    if (expectedEdges.has(edge.id)) throw errorf(`input contains duplicate edge ID ${edge.id}`);
    expectedEdges.set(edge.id, { from: edge.from.id, to: edge.to.id });
  }
  const actualEdges = new Set();
  for (const edge of actual.edges) {
    checkCtx(ctx);
    if (edge === null || edge.from === null || edge.to === null) throw errorf('result contains an edge with a nil endpoint');
    if (actualEdges.has(edge.id)) throw errorf(`result contains duplicate edge ID ${edge.id}`);
    actualEdges.add(edge.id);
    const want = expectedEdges.get(edge.id);
    if (want === undefined) throw errorf(`result contains unexpected edge ID ${edge.id}`);
    if (edge.from.id !== want.from || edge.to.id !== want.to) {
      throw errorf(`edge ${edge.id} endpoints changed from ${want.from}->${want.to} to ${edge.from.id}->${edge.to.id}`);
    }
  }
  for (const id of expectedEdges.keys()) {
    checkCtx(ctx);
    if (actualEdges.has(id)) continue;
    if (allowedMissingEdges.has(id)) continue;
    throw errorf(`result is missing edge ID ${id}`);
  }
}

/**
 * validateLayoutResultMetadata checks the immutable geometry semantics that a completed layout attempt must preserve. Attempt-owned boxes,
 * routes, font-size values, mutable node-label geometry, edge-label positions, Near relationships, and derived layout structures deliberately
 * remain outside this comparison. Near relationships can be both inferred and removed by hierarchy/cluster processing. Fixed-position and
 * desired-size values are bound as metadata, but whether the result satisfies those constraints is an output-validity concern, not an
 * immutable-metadata concern.
 */
export function validateLayoutResultMetadata(ctx, expected, actual, allowedMissingEdges) {
  if (expected == null || actual == null) throw errorf('cannot compare nil graph metadata');
  checkCtx(ctx);
  if (expected.isRootHierarchy !== actual.isRootHierarchy) throw errorf('root hierarchy metadata changed');
  if (!sameDirectionMetadata(ctx, expected, actual)) throw errorf('graph direction metadata changed');

  const expectedNodes = new Map();
  for (const node of expected.nodes) {
    checkCtx(ctx);
    if (node === null) throw errorf('input contains a nil node');
    expectedNodes.set(node.id, node);
  }
  for (const node of actual.nodes) {
    checkCtx(ctx);
    if (node === null) throw errorf('result contains a nil node');
    const input = expectedNodes.get(node.id) ?? null;
    if (input === null) throw errorf(`result contains unexpected node ID ${node.id}`);
    if (input.shapeType() !== node.shapeType()) {
      throw errorf(`node ${node.id} shape changed from ${quote(input.shapeType())} to ${quote(node.shapeType())}`);
    }
    if ((input.container === null) !== (node.container === null) ||
      (input.container !== null && input.container.id !== node.container.id)) {
      throw errorf(`node ${node.id} container ownership changed`);
    }
    if (input.numColumns() !== node.numColumns()) {
      throw errorf(`node ${node.id} table column count changed from ${input.numColumns()} to ${node.numColumns()}`);
    }
    if (input.is3D !== node.is3D) throw errorf(`node ${node.id} 3D outline metadata changed`);
    if (input.isMultiple !== node.isMultiple) throw errorf(`node ${node.id} multiple outline metadata changed`);
    if (input.isInvisible !== node.isInvisible) throw errorf(`node ${node.id} visibility metadata changed`);
    if (!sameOptionalValue(input.fixedTopLeft, node.fixedTopLeft)) throw errorf(`node ${node.id} fixed position metadata changed`);
    if (!sameOptionalValue(input.desiredWidth, node.desiredWidth) || !sameOptionalValue(input.desiredHeight, node.desiredHeight)) {
      throw errorf(`node ${node.id} desired-size metadata changed`);
    }
    if (input.forceHierarchy !== node.forceHierarchy) throw errorf(`node ${node.id} forced-hierarchy metadata changed`);
    if (!sameLabelIdentity(input.label, node.label)) throw errorf(`node ${node.id} label identity changed`);
    if (input.label !== null && input.label.position !== label.Unset && input.label.position !== node.label.position) {
      throw errorf(`node ${node.id} fixed label position changed`);
    }
    if ((input.icon === null) !== (node.icon === null)) throw errorf(`node ${node.id} icon presence changed`);
    if (input.icon !== null && input.icon.position !== label.Unset && input.icon.position !== node.icon.position) {
      throw errorf(`node ${node.id} fixed icon position changed`);
    }
    if (!isValidResultFontSize(input.fontSize, node.fontSize)) {
      throw errorf(`node ${node.id} font size is outside the layout output domain`);
    }
  }

  const expectedEdges = new Map();
  for (const edge of expected.edges) {
    checkCtx(ctx);
    if (edge === null) throw errorf('input contains a nil edge');
    expectedEdges.set(edge.id, edge);
  }
  const actualEdges = new Set();
  for (const edge of actual.edges) {
    checkCtx(ctx);
    if (edge === null) throw errorf('result contains a nil edge');
    actualEdges.add(edge.id);
    const input = expectedEdges.get(edge.id) ?? null;
    if (input === null) throw errorf(`result contains unexpected edge ID ${edge.id}`);
    if (input.sourceArrowhead !== edge.sourceArrowhead || input.targetArrowhead !== edge.targetArrowhead) {
      throw errorf(`edge ${edge.id} arrowhead metadata changed`);
    }
    if (!sameImmutableLabel(input.sourceArrowheadLabel, edge.sourceArrowheadLabel)) {
      throw errorf(`edge ${edge.id} source arrowhead label metadata changed`);
    }
    if (!sameImmutableLabel(input.targetArrowheadLabel, edge.targetArrowheadLabel)) {
      throw errorf(`edge ${edge.id} target arrowhead label metadata changed`);
    }
    if (input.minWidth !== edge.minWidth || input.minHeight !== edge.minHeight) {
      throw errorf(`edge ${edge.id} minimum geometry changed`);
    }
    if (!sameOptionalValue(input.fromTableColumnIndex, edge.fromTableColumnIndex) ||
      !sameOptionalValue(input.toTableColumnIndex, edge.toTableColumnIndex)) {
      throw errorf(`edge ${edge.id} table column attachment metadata changed`);
    }
    if (input.isInvisible !== edge.isInvisible) throw errorf(`edge ${edge.id} visibility metadata changed`);
    if (!sameImmutableEdgeStyle(input.style, edge.style)) throw errorf(`edge ${edge.id} style metadata changed`);
    if (!sameEdgeLabelMetadata(input.label, edge.label)) throw errorf(`edge ${edge.id} label identity or dimensions changed`);
  }
  for (const id of expectedEdges.keys()) {
    checkCtx(ctx);
    if (actualEdges.has(id)) continue;
    if (allowedMissingEdges.has(id)) continue;
    throw errorf(`result is missing edge ID ${id}`);
  }
}

// In Go `expected == actual` on two nil pointers is true and on one nil pointer false (these helpers compare pointers, nil or not).
function sameLabelIdentity(expected, actual) {
  if (expected === null || actual === null) return expected === actual;
  return expected.text === actual.text;
}

function sameEdgeLabelMetadata(expected, actual) {
  if (expected === null || actual === null) return expected === actual;
  return expected.text === actual.text && expected.width === actual.width && expected.height === actual.height;
}

function sameImmutableLabel(expected, actual) {
  if (expected === null || actual === null) return expected === actual;
  return expected.text === actual.text && expected.position === actual.position &&
    expected.width === actual.width && expected.height === actual.height;
}

/**
 * EquivalentStyles is intentionally a routing-specific comparison and omits renderer fields. Layout validation has a stronger contract: every
 * attempt must return each carried input style unchanged, including fields such as BorderRadius that other layout stages may consume.
 */
function sameImmutableEdgeStyle(expected, actual) {
  for (const f of EDGE_STYLE_FIELDS) {
    if (!sameOptionalValue(expected[f], actual[f])) return false;
  }
  return true;
}

/** sameOptionalValue: pointers to comparable values (numbers, strings, StyleScalar {value}, geo.Point {x, y}) */
function sameOptionalValue(expected, actual) {
  if (expected === null || actual === null || expected === undefined || actual === undefined) return (expected ?? null) === (actual ?? null);
  if (typeof expected === 'object') {
    if (expected instanceof geo.Point) return expected.x === actual.x && expected.y === actual.y;
    return expected.value === actual.value;
  }
  return expected === actual;
}

function isValidResultFontSize(expected, actual) {
  if (expected === null || actual === null) return expected === actual;
  return actual === expected || d2fonts.FontSizes.includes(actual);
}

function sameDirectionMetadata(ctx, expected, actual) {
  const canonical = (graph) => {
    const directions = new Map(); // key: 'root' or the node ID
    for (const [node, direction] of graph.directions) {
      checkCtx(ctx);
      const key = node === null ? 'root' : `id:${node.id}`;
      if (directions.has(key)) throw errorf('graph direction metadata repeats a canonical key');
      directions.set(key, direction);
    }
    return directions;
  };
  const expectedDirections = canonical(expected);
  const actualDirections = canonical(actual);
  if (expectedDirections.size !== actualDirections.size) return false;
  for (const [key, direction] of expectedDirections) {
    checkCtx(ctx);
    const actualDirection = actualDirections.get(key);
    if (actualDirection === undefined || actualDirection !== direction) return false;
  }
  return true;
}

export function validateCompletedGraph(ctx, graph) {
  if (graph == null) throw errorf('graph is nil');
  const nodes = new Set();
  const nodeIDs = new Set();
  graph.nodes.forEach((node, index) => {
    checkCtx(ctx);
    if (node === null) throw errorf(`node ${index} is nil`);
    if (nodes.has(node)) throw errorf(`node ${node.id} is repeated`);
    nodes.add(node);
    if (nodeIDs.has(node.id)) throw errorf(`node ID ${node.id} is duplicated`);
    nodeIDs.add(node.id);
    validateResultNode(node);
  });

  const edges = new Set();
  const edgeIDs = new Set();
  graph.edges.forEach((edge, index) => {
    checkCtx(ctx);
    if (edge === null) throw errorf(`edge ${index} is nil`);
    if (edges.has(edge)) throw errorf(`edge ${edge.id} is repeated`);
    edges.add(edge);
    if (edgeIDs.has(edge.id)) throw errorf(`edge ID ${edge.id} is duplicated`);
    edgeIDs.add(edge.id);
    if (!nodes.has(edge.from)) throw errorf(`edge ${edge.id} has a source outside the result graph`);
    if (!nodes.has(edge.to)) throw errorf(`edge ${edge.id} has a destination outside the result graph`);
    validateResultEdge(ctx, edge);
  });
}

/** fmt.Errorf("node %d: %w", id, err) around a validateResult* error */
function nodeError(node, e) {
  return errorf(`node ${node.id}: ${e.message}`, e);
}

export function validateResultNode(node) {
  if (node === null) throw errorf('node is nil');
  if (node.topLeft === null) throw errorf(`node ${node.id} has no position`);
  const check = (f) => {
    try {
      f();
    } catch (e) {
      throw nodeError(node, e);
    }
  };
  check(() => validateResultCoordinate('node x', node.topLeft.x));
  check(() => validateResultCoordinate('node y', node.topLeft.y));
  check(() => validateResultDimension('node width', node.width, false));
  check(() => validateResultDimension('node height', node.height, false));
  if (!isFiniteResultNumber(node.topLeft.x + node.width) || !isFiniteResultNumber(node.topLeft.y + node.height)) {
    throw errorf(`node ${node.id} bounds overflow`);
  }
  if (node.label !== null) {
    check(() => validateResultDimension('node label width', node.label.width, true));
    check(() => validateResultDimension('node label height', node.label.height, true));
  }
}

export function validateResultEdge(ctx, edge) {
  if (edge === null) throw errorf('edge is nil');
  if (edge.points.length < 2) throw errorf(`edge ${edge.id} has an incomplete route`);
  for (let index = 0; index < edge.points.length; index++) {
    const point = edge.points[index];
    if (index % 256 === 0) checkCtx(ctx);
    if (point === null) throw errorf(`edge ${edge.id} route point ${index} is nil`);
    try {
      validateResultCoordinate('route x', point.x);
    } catch (e) {
      throw errorf(`edge ${edge.id} point ${index}: ${e.message}`, e);
    }
    try {
      validateResultCoordinate('route y', point.y);
    } catch (e) {
      throw errorf(`edge ${edge.id} point ${index}: ${e.message}`, e);
    }
  }
  if (!isFiniteResultNumber(edge.labelPercentage) || edge.labelPercentage < 0 || edge.labelPercentage > 1) {
    throw errorf(`edge ${edge.id} has invalid label percentage ${goV(edge.labelPercentage)}`);
  }
  const labels = [
    { name: 'label', label: edge.label },
    { name: 'source arrowhead label', label: edge.sourceArrowheadLabel },
    { name: 'target arrowhead label', label: edge.targetArrowheadLabel },
  ];
  for (const item of labels) {
    if (item.label === null) continue;
    for (const [what, value] of [['width', item.label.width], ['height', item.label.height]]) {
      try {
        validateResultDimension(`${item.name} ${what}`, value, true);
      } catch (e) {
        throw errorf(`edge ${edge.id}: ${e.message}`, e);
      }
    }
  }
}
