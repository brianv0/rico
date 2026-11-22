// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of patch.go of the Go package d2layouts/d2talalayout (D2 v0.9.0, Copyright 2022 Terrastruct Inc.): applying a selected TALA
// graph (or a set of routed edges) to the original D2 graph through a fully validated patch. Building the patch is the part that can fail;
// apply() only assigns, so the D2 graph is either updated completely or not at all. Errors are thrown (GoError).
//
// Names: d2Patch is {graph, objects, edges, destinations, replaceEdges, finalEdges}; the D2 graph's own fields are the JS port's
// (object.box, object.labelPosition (string or null), object.attributes.labelDimensions, object.iconPosition, object.attributes.style.fontSize,
// edge.labelPosition, edge.labelPercentage, edge.attributes.labelDimensions, edge.route, edge.isCurve, edge.dst).

import * as label from '../label.js';
import * as d2graph from '../d2graph.js';
import * as d2target from '../target.js';
import { goInt } from '../gomath.js';
import { quote } from '../url.js';
import { errorf } from './goerrors.js';
import { validateResultEdge, validateResultNode } from './result.js';

export function preferContextError(ctx, operation, err) {
  const cause = ctx.err();
  if (cause) return errorf(`tala ${operation} stopped: ${cause.message}`, cause);
  return err;
}

const checkCtx = (ctx) => {
  const err = ctx.err();
  if (err) throw err;
};

/** applySeedResult applies one validated result through a non-failing patch. Cancellation before the commit leaves graph unchanged. */
export function applySeedResult(ctx, graph, result) {
  let err = ctx.err();
  if (err) throw errorf(`TALA layout canceled before apply: ${err.message}`, err);
  if (result.graph == null) throw errorf('TALA evaluated seed is empty');
  if (result.bindings.objectIDs == null || result.bindings.edgeIDs == null || result.bindings.edgeDestinations == null) {
    throw errorf('TALA evaluated seed has no D2 bindings');
  }
  const patch = buildLayoutPatch(ctx, graph, result.graph, result.bindings, result.sequenceEdges);
  err = ctx.err();
  if (err) throw errorf(`TALA layout canceled before apply: ${err.message}`, err);
  commitLayoutPatch(ctx, patch);
}

/**
 * commitLayoutPatch is the layout commit point. A caller that deliberately salvages a completed result after a deadline must supply a live
 * context to applySeedResult.
 */
export function commitLayoutPatch(ctx, patch) {
  const err = ctx.err();
  if (err) throw errorf(`tala layout stopped before commit: ${err.message}`, err);
  applyPatch(patch);
}

/** commitRoutePatch is the routing commit point. Routing does not salvage work after either form of context cancellation. */
export function commitRoutePatch(ctx, patch) {
  const err = ctx.err();
  if (err) throw errorf(`tala edge routing canceled before commit: ${err.message}`, err);
  applyPatch(patch);
}

/** d2Patch.apply */
export function applyPatch(patch) {
  for (const update of patch.objects) {
    update.box.TopLeft = update.topLeft;
    update.box.Width = update.width;
    update.box.Height = update.height;
    if (update.label !== null) {
      update.object.labelPosition = update.label.position;
      update.object.attributes.labelDimensions = update.label.dimensions;
    }
    if (update.icon !== null) {
      update.object.iconPosition = update.icon;
    }
    if (update.font !== null) {
      if (update.font.existing !== null) {
        update.font.existing.value = update.font.value;
      } else {
        update.object.attributes.style.fontSize = update.font.replacement;
      }
    }
  }
  for (const update of patch.edges) {
    if (update.label !== null) {
      update.edge.labelPosition = update.label.position;
      update.edge.labelPercentage = update.label.percentage;
      if (update.label.dimensions !== null) {
        update.edge.attributes.labelDimensions = new d2target.TextDimensions(update.label.dimensions.width, update.label.dimensions.height);
      }
    }
    update.edge.route = update.route;
    update.edge.isCurve = update.curve;
  }
  for (const update of patch.destinations) {
    update.edge.dst = update.destination;
  }
  if (patch.replaceEdges) {
    // Go: a nil slice when there is no edge (the D2 graph JSON prints null)
    patch.graph.edges = patch.finalEdges.length === 0 ? null : patch.finalEdges;
  }
}

export function buildLayoutPatch(ctx, g, result, bindings, sequenceEdges) {
  const patch = {
    graph: g,
    replaceEdges: true,
    objects: [],
    edges: [],
    destinations: [],
    finalEdges: [],
  };
  patch.destinations = buildDestinationPatches(g, bindings, null);

  const nodes = new Map();
  for (const node of result.nodes) {
    checkCtx(ctx);
    if (node === null) throw errorf('tala result contains a nil node');
    if (node.topLeft === null) throw errorf(`node ${node.debugID()} reconnected with no position`);
    if (nodes.has(node.id)) throw errorf(`tala result contains duplicate node ID ${node.id}`);
    nodes.set(node.id, node);
  }
  for (const object of g.objects ?? []) {
    checkCtx(ctx);
    const id = bindings.objectIDs.get(object);
    if (id === undefined) throw errorf(`could not reassociate graph object ${quote(object.absID())}`);
    const node = nodes.get(id);
    if (node === undefined) throw errorf(`could not reassociate graph node ${id}, object ID: ${object.absID()}`);
    patch.objects.push(buildObjectPatch(ctx, object, node));
  }

  const edges = new Map();
  for (const edge of result.edges) {
    checkCtx(ctx);
    if (edge === null) throw errorf('tala result contains a nil edge');
    if (edges.has(edge.id)) throw errorf(`tala result contains duplicate edge ID ${edge.id}`);
    edges.set(edge.id, edge);
  }
  for (const edge of g.edges ?? []) {
    checkCtx(ctx);
    const id = bindings.edgeIDs.get(edge);
    if (id === undefined) throw errorf(`could not reassociate D2 edge ${quote(edge.absID())}`);
    if (sequenceEdges.has(id)) continue;
    const resultEdge = edges.get(id);
    if (resultEdge === undefined) throw errorf(`could not reassociate graph edge ${id}`);
    patch.edges.push(buildEdgePatch(ctx, edge, resultEdge, true));
    patch.finalEdges.push(edge);
  }

  return patch;
}

export function buildRoutePatch(ctx, g, bindings, routed) {
  const patch = {
    graph: g,
    objects: [],
    edges: [],
    destinations: [],
    replaceEdges: true,
    finalEdges: [],
  };
  const updates = new Map();
  const addUpdates = (edges) => {
    for (const edge of edges) {
      checkCtx(ctx);
      if (edge === null) throw errorf('tala route result contains a nil edge');
      if (updates.has(edge.id)) throw errorf(`tala route result contains duplicate edge ID ${edge.id}`);
      updates.set(edge.id, edge);
    }
  };
  addUpdates(routed);
  const selectedIDs = new Set(updates.keys());
  patch.destinations = buildDestinationPatches(g, bindings, selectedIDs);

  let matched = 0;
  for (const edge of g.edges ?? []) {
    checkCtx(ctx);
    patch.finalEdges.push(edge);
    const id = bindings.edgeIDs.get(edge);
    if (id === undefined) throw errorf(`could not reassociate D2 edge ${quote(edge.absID())}`);
    const resultEdge = updates.get(id);
    if (resultEdge === undefined) continue;
    patch.edges.push(buildEdgePatch(ctx, edge, resultEdge, false));
    matched++;
  }
  if (matched !== updates.size) throw errorf(`could not reassociate ${updates.size - matched} routed edges`);
  return patch;
}

export function buildDestinationPatches(g, bindings, selectedIDs) {
  const patches = [];
  for (const edge of g.edges ?? []) {
    if (selectedIDs !== null) {
      const id = bindings.edgeIDs.get(edge);
      if (id === undefined) continue;
      if (!selectedIDs.has(id)) continue;
    }
    const destination = bindings.edgeDestinations.get(edge);
    if (destination === undefined) continue;
    patches.push({ edge, destination });
  }
  return patches;
}

export function buildObjectPatch(ctx, object, node) {
  checkCtx(ctx);
  if (object.box === null || object.box === undefined) throw errorf(`D2 object ${quote(object.absID())} has no box`);
  if (node.topLeft === null) throw errorf(`node ${node.debugID()} reconnected with no position`);
  validateResultNode(node);
  const patch = {
    object,
    box: object.box,
    topLeft: node.topLeft.copy(),
    width: node.width,
    height: node.height,
    label: null,
    icon: null,
    font: null,
  };
  if (node.label !== null) {
    patch.label = {
      position: label.positionString(node.label.position),
      dimensions: new d2target.TextDimensions(goInt(node.label.width), goInt(node.label.height)),
    };
  }
  if (node.icon !== null) {
    patch.icon = label.positionString(node.icon.position);
  }
  if (node.fontSize !== null) {
    const font = {
      existing: object.attributes.style.fontSize,
      replacement: null,
      value: String(node.fontSize),
    };
    if (font.existing === null) font.replacement = new d2graph.Scalar(font.value);
    patch.font = font;
  }
  return patch;
}

export function buildEdgePatch(ctx, edge, result, includeLabelDimensions) {
  validateResultEdge(ctx, result);
  const patch = {
    edge,
    label: null,
    route: new Array(result.points.length),
    curve: result.isCurve,
  };
  if (result.label !== null) {
    let position = result.label.position;
    let percentage = result.labelPercentage;
    if (edge.srcArrow && !edge.dstArrow) {
      position = label.mirrored(position);
      percentage = 1 - percentage;
    }
    patch.label = {
      position: label.positionString(position),
      percentage,
      dimensions: null,
    };
    if (includeLabelDimensions) {
      patch.label.dimensions = new d2target.TextDimensions(goInt(result.label.width), goInt(result.label.height));
    }
  }
  for (let i = 0; i < result.points.length; i++) {
    if (i % 256 === 0) checkCtx(ctx);
    if (edge.srcArrow && !edge.dstArrow) {
      patch.route[result.points.length - i - 1] = result.points[i].copy();
    } else {
      patch.route[i] = result.points[i].copy();
    }
  }
  return patch;
}
