// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of D2's d2layouts package (D2 v0.9.0, Copyright 2022 Terrastruct Inc.): d2layouts.go.
// LayoutNested lays out nested diagrams (grids, sequence diagrams, constant nears) first, then the graph itself with the
// core layout (dagre), then injects the nested graphs back and routes the edges that cross graph boundaries.
// Conventions as in d2graph.js; errors are thrown as Error (Go returns them).

import * as d2graph from './d2graph.js';
import * as d2grid from './d2grid.js';
import * as d2near from './d2near.js';
import * as d2sequence from './d2sequence.js';
import * as geo from './geo.js';
import * as label from './label.js';
import { goLower } from './ast.js';
import { goFixed } from './gomath.js';

export const DefaultGraphType = '';
export const ConstantNearGraph = 'constant-near';
export const GridDiagram = 'grid-diagram';
export const SequenceDiagram = 'sequence-diagram';

class GraphInfo {
  constructor() {
    this.isConstantNear = false;
    this.diagramType = DefaultGraphType;
  }

  isDefault() {
    return !this.isConstantNear && this.diagramType === DefaultGraphType;
  }
}

/** sort.SliceStable on elements: JavaScript's sort is stable, the comparators here are strict weak orders */
function sliceStable(x, less) {
  x.sort((a, b) => (less(a, b) ? -1 : less(b, a) ? 1 : 0));
}

export function saveChildrenOrder(container) {
  const objectOrder = new Map();
  (container.childrenArray || []).forEach((obj, i) => objectOrder.set(obj.absID(), i));
  return () => {
    if (!container.childrenArray) return;
    const ids = new Map(container.childrenArray.map((o) => [o, objectOrder.get(o.absID()) ?? 0]));
    sliceStable(container.childrenArray, (a, b) => ids.get(a) < ids.get(b));
  };
}

export function saveOrder(g) {
  const objectOrder = new Map();
  (g.objects || []).forEach((obj, i) => objectOrder.set(obj.absID(), i));
  const edgeOrder = new Map();
  (g.edges || []).forEach((edge, i) => edgeOrder.set(edge.absID(), i));
  const restoreRootOrder = saveChildrenOrder(g.root);
  return () => {
    if (g.objects) {
      const ids = new Map(g.objects.map((o) => [o, objectOrder.get(o.absID()) ?? 0]));
      sliceStable(g.objects, (a, b) => ids.get(a) < ids.get(b));
    }
    if (g.edges) {
      const idx = new Map(g.edges.map((e) => [e, edgeOrder.get(e.absID())]));
      sliceStable(g.edges, (a, b) => {
        const iIndex = idx.get(a), jIndex = idx.get(b);
        const iHas = iIndex !== undefined, jHas = jIndex !== undefined;
        if (iHas && jHas) return iIndex < jIndex;
        return iHas;
      });
    }
    restoreRootOrder();
  };
}

/**
 * @param {d2graph.Graph} g
 * @param {GraphInfo} graphInfo
 * @param {(g: d2graph.Graph) => void} coreLayout
 * @param {(g: d2graph.Graph, edges: d2graph.Edge[]) => void} edgeRouter
 */
export function layoutNested(g, graphInfo, coreLayout, edgeRouter) {
  g.root.box = new geo.Box(null, 0, 0);

  // Before we can layout these nodes, we need to handle all nested diagrams first.
  const extracted = new Map();
  const extractedOrder = [];
  let extractedEdges = null;
  let extractedEdgeIDs = null;

  let constantNears = null;
  const restoreOrder = saveOrder(g);
  {
    // Iterate top-down from Root so all nested diagrams can process their own contents
    let queue = [...(g.root.childrenArray || [])];
    let batchedExtractions = null;
    let extractionBatch = null;
    if (graphInfo.diagramType !== GridDiagram) {
      const specs = collectNestedExtractions(g);
      if (specs.length > 1) {
        extractionBatch = extractSubgraphs(g, specs);
        batchedExtractions = extractionBatch.extractions;
        queue = specs.map((spec) => spec.container);
      }
    }

    while (queue.length > 0) {
      let curr = queue[0];
      queue = queue.slice(1);

      const isGridCellContainer = graphInfo.diagramType === GridDiagram && curr.isContainer() && curr.parent === g.root;
      let gi = nestedGraphInfo(curr);
      const batched = batchedExtractions !== null ? batchedExtractions.get(curr) : undefined;
      if (batched !== undefined) gi = batched.graphInfo;

      if (isGridCellContainer && gi.isDefault()) {
        // if we are in a grid diagram, and our children have descendants
        // we need to run layout on them first, even if they are not special diagram types

        // First we extract the grid cell container as a nested graph with includeSelf=true
        // resulting in externalEdges=[A, C] and nestedGraph.Edges=[B]
        let [nestedGraph, externalEdges, externalEdgeIDs] = extractSubgraph(curr, true);

        // Then we layout curr as a nested graph and re-inject it
        const id = curr.absID();
        layoutNested(nestedGraph, new GraphInfo(), coreLayout, edgeRouter);
        injectNested(g.root, nestedGraph, false);
        g.edges = [...(g.edges || []), ...externalEdges];
        restoreOrder();

        // layout can replace Objects so we need to update the references we are holding onto (curr + externalEdges)
        const idToObj = new Map();
        for (const o of g.objects || []) idToObj.set(o.absID(), o);
        const lookup = (idStr) => {
          const o = idToObj.get(idStr);
          if (o === undefined) throw new Error(`could not find object ${goQuote(idStr)} after layout`);
          return o;
        };
        curr = lookup(id);
        for (let i = 0; i < externalEdges.length; i++) {
          const e = externalEdges[i];
          e.src = lookup(externalEdgeIDs[i].srcID);
          e.dst = lookup(externalEdgeIDs[i].dstID);
        }

        // position nested graph (excluding curr) relative to curr
        const dx = 0 - curr.box.TopLeft.x;
        const dy = 0 - curr.box.TopLeft.y;
        for (const o of nestedGraph.objects || []) {
          if (o === curr) continue;
          o.box.TopLeft.x += dx;
          o.box.TopLeft.y += dy;
        }
        for (const e of nestedGraph.edges || []) e.move(dx, dy);

        // Then after re-injecting everything, we extract curr with includeSelf=false,
        // and externalEdges=[C], nestedGraph.Edges=[B], and graph.Edges=[A].
        // This will leave A in the graph to be routed by grid layout, and C will have cross-graph edge routing
        [nestedGraph, externalEdges, externalEdgeIDs] = extractSubgraph(curr, false);
        extractedEdges = [...(extractedEdges || []), ...externalEdges];
        extractedEdgeIDs = [...(extractedEdgeIDs || []), ...externalEdgeIDs];

        extracted.set(id, nestedGraph);
        extractedOrder.push(id);
        continue;
      }

      if (!gi.isDefault()) {
        // empty grid or sequence can have 0 objects..
        const wasBatched = batched !== undefined;
        if (!wasBatched && !gi.isConstantNear && (curr.children === null || curr.children.size === 0)) continue;

        // There is a nested diagram here, so extract its contents and process in the same way
        let nestedGraph, externalEdges, externalEdgeIDs;
        if (batched !== undefined) {
          nestedGraph = batched.nestedGraph;
          externalEdges = batched.externalEdges;
          externalEdgeIDs = batched.externalEdgeIDs;
        } else {
          [nestedGraph, externalEdges, externalEdgeIDs] = extractSubgraph(curr, gi.isConstantNear);
        }
        extractedEdges = [...(extractedEdges || []), ...externalEdges];
        extractedEdgeIDs = [...(extractedEdgeIDs || []), ...externalEdgeIDs];

        let nestedInfo = gi;
        const nearKey = curr.attributes.nearKey;
        if (gi.isConstantNear) {
          // layout nested as a non-near
          nestedInfo = new GraphInfo();
          curr.attributes.nearKey = null;
        }

        try {
          layoutNested(nestedGraph, nestedInfo, coreLayout, edgeRouter);
        } catch (err) {
          if (batched !== undefined) rollbackAfter(extractionBatch, batched.index);
          throw err;
        }
        // coreLayout can overwrite graph contents with newly created *Object pointers
        // so we need to update `curr` with nestedGraph's value
        if (gi.isConstantNear) curr = nestedGraph.root.childrenArray[0];

        if (gi.isConstantNear) curr.attributes.nearKey = nearKey;
        else {
          fitToGraph(curr, nestedGraph, new geo.Spacing());
          curr.box.TopLeft = geo.newPoint(0, 0);
        }

        if (gi.isConstantNear) {
          // near layout will inject these nestedGraphs
          (constantNears ||= []).push(nestedGraph);
        } else {
          // We will restore the contents after running layout with child as the placeholder
          // We need to reference using ID because there may be a new object to use after coreLayout
          const id = curr.absID();
          extracted.set(id, nestedGraph);
          extractedOrder.push(id);
        }
      } else if ((curr.childrenArray || []).length > 0) queue = [...queue, ...curr.childrenArray];
    }

    // We can now run layout with accurate sizes of nested layout containers
    // Layout according to the type of diagram
    if ((g.objects || []).length > 0) {
      switch (graphInfo.diagramType) {
        case GridDiagram:
          d2grid.layout(g);
          break;
        case SequenceDiagram:
          d2sequence.layout(g, coreLayout);
          break;
        default:
          coreLayout(g);
      }
    }

    if (constantNears !== null && constantNears.length > 0) d2near.layout(g, constantNears);

    const idToObj = new Map();
    for (const o of g.objects || []) idToObj.set(o.absID(), o);

    // With the layout set, inject all the extracted graphs
    for (const id of extractedOrder) {
      const nestedGraph = extracted.get(id);
      // we have to find the object by ID because coreLayout can replace the Objects in graph
      const obj = idToObj.get(id);
      if (obj === undefined) throw new Error(`could not find object ${goQuote(id)} after layout`);
      injectNested(obj, nestedGraph, true);
      positionNested(obj, nestedGraph);
    }

    if (extractedEdges !== null && extractedEdges.length > 0) {
      // update map with injected objects
      for (const o of g.objects || []) idToObj.set(o.absID(), o);

      // Restore cross-graph edges and route them
      g.edges = [...(g.edges || []), ...extractedEdges];
      for (let i = 0; i < extractedEdges.length; i++) {
        const e = extractedEdges[i];
        const ids = extractedEdgeIDs[i];
        // update object references
        const src = idToObj.get(ids.srcID);
        if (src === undefined) throw new Error(`could not find object ${goQuote(ids.srcID)} after layout`);
        e.src = src;
        const dst = idToObj.get(ids.dstID);
        if (dst === undefined) throw new Error(`could not find object ${goQuote(ids.dstID)} after layout`);
        e.dst = dst;
      }

      edgeRouter(g, extractedEdges);
      // need to update pointers if plugin performs edge routing
      for (let i = 0; i < extractedEdges.length; i++) {
        const e = extractedEdges[i];
        const ids = extractedEdgeIDs[i];
        const src = idToObj.get(ids.srcID);
        if (src === undefined) throw new Error(`could not find object ${goQuote(ids.srcID)} after routing`);
        e.src = src;
        const dst = idToObj.get(ids.dstID);
        if (dst === undefined) throw new Error(`could not find object ${goQuote(ids.dstID)} after routing`);
        e.dst = dst;
      }
    }

    validateObjectPositions(g.objects);
  }
  // Go's `defer restoreOrder()`; after an error the graph is not used any more
  restoreOrder();
}

/** %#v of a string */
function goQuote(s) {
  return JSON.stringify(s);
}

export function defaultRouter(graph, edges) {
  for (const e of edges) {
    // TODO replace simple straight line edge routing
    e.route = [e.src.box.center(), e.dst.box.center()];
    e.traceToShape(e.route, 0, 1);
    if (e.attributes.label.value !== '') e.labelPosition = label.positionString(label.InsideMiddleCenter);
  }
}

export function nestedGraphInfo(obj) {
  const gi = new GraphInfo();
  if (obj.graph.rootLevel === 0 && obj.isConstantNear()) gi.isConstantNear = true;
  if (obj.isSequenceDiagram()) gi.diagramType = SequenceDiagram;
  else if (obj.isGridDiagram()) gi.diagramType = GridDiagram;
  return gi;
}

/** the Go code's `edgeIDs` struct is {srcID, dstID} */

// collectNestedExtractions returns the topmost nested diagrams in the same
// breadth-first order used by LayoutNested. Their object sets are disjoint, so
// they can be partitioned out of the parent graph together.
function collectNestedExtractions(g) {
  let queue = [...(g.root.childrenArray || [])];
  const specs = [];
  while (queue.length > 0) {
    const curr = queue[0];
    queue = queue.slice(1);
    const gi = nestedGraphInfo(curr);
    if (!gi.isDefault()) {
      if (!gi.isConstantNear && (curr.children === null || curr.children.size === 0)) continue;
      specs.push({ container: curr, includeSelf: gi.isConstantNear, graphInfo: gi });
      continue;
    }
    queue = [...queue, ...(curr.childrenArray || [])];
  }
  return specs;
}

// extractSubgraphs is the one-pass equivalent of calling ExtractSubgraph for
// each disjoint nested diagram in order. An edge crossing two nested diagrams
// belongs to the first extraction, matching the sequential implementation.
function extractSubgraphs(g, specs) {
  const extractions = new Map();
  const batch = { g, specs, extractions, restoreParentOrder: [] };
  const ownerIndex = new Map();
  const parentOrderSaved = new Set();
  specs.forEach((spec, i) => {
    ownerIndex.set(spec.container, i);
    let restoreInto = spec.container;
    if (spec.includeSelf) {
      restoreInto = spec.container.parent;
      if (restoreInto !== null) {
        if (!parentOrderSaved.has(restoreInto)) {
          parentOrderSaved.add(restoreInto);
          batch.restoreParentOrder.push(saveChildrenOrder(restoreInto));
        }
      }
    }
    const nestedGraph = d2graph.newGraph();
    nestedGraph.data = cloneGraphData(g.data);
    nestedGraph.rootLevel = spec.container.level();
    if (spec.includeSelf) nestedGraph.rootLevel--;
    nestedGraph.root.attributes = copyAttributes(spec.container.attributes);
    nestedGraph.root.box = new geo.Box(null, 0, 0);
    nestedGraph.root.labelPosition = spec.container.labelPosition;
    nestedGraph.root.iconPosition = spec.container.iconPosition;
    extractions.set(spec.container, {
      nestedGraph,
      externalEdges: [],
      externalEdgeIDs: [],
      graphInfo: spec.graphInfo,
      index: i,
      restoreInto,
    });
  });

  const objectOwner = new Map();
  const findOwner = (obj) => {
    if (objectOwner.has(obj)) return [objectOwner.get(obj), true];
    for (let ancestor = obj; ancestor !== null; ancestor = ancestor.parent) {
      const owner = ownerIndex.get(ancestor);
      if (owner === undefined) continue;
      if (specs[owner].includeSelf || ancestor !== obj) return [owner, true];
      break;
    }
    return [0, false];
  };

  const remainingObjects = [];
  for (const obj of g.objects || []) {
    const [owner, ok] = findOwner(obj);
    if (!ok) {
      remainingObjects.push(obj);
      continue;
    }
    objectOwner.set(obj, owner);
    const extraction = extractions.get(specs[owner].container);
    extraction.nestedGraph.objects = [...(extraction.nestedGraph.objects || []), obj];
  }
  g.objects = remainingObjects;

  const remainingEdges = [];
  for (const edge of g.edges || []) {
    const [srcOwner, srcNested] = findOwner(edge.src);
    if (d2sequence.isLifelineEnd(edge.dst)) {
      if (srcNested) {
        const extraction = extractions.get(specs[srcOwner].container);
        extraction.nestedGraph.edges = [...(extraction.nestedGraph.edges || []), edge];
      } else remainingEdges.push(edge);
      continue;
    }

    const [dstOwner, dstNested] = findOwner(edge.dst);
    if (srcNested && dstNested && srcOwner === dstOwner) {
      const extraction = extractions.get(specs[srcOwner].container);
      extraction.nestedGraph.edges = [...(extraction.nestedGraph.edges || []), edge];
      continue;
    }
    if (!srcNested && !dstNested) {
      remainingEdges.push(edge);
      continue;
    }

    let owner = srcOwner;
    if (!srcNested || (dstNested && dstOwner < owner)) owner = dstOwner;
    const extraction = extractions.get(specs[owner].container);
    extraction.externalEdges.push(edge);
    extraction.externalEdgeIDs.push({ srcID: edge.src.absID(), dstID: edge.dst.absID() });
  }
  g.edges = remainingEdges;

  // Mutate parent/root references only after all memberships have been
  // classified; doing so earlier would change ancestry for later diagrams.
  for (const spec of specs) {
    const extraction = extractions.get(spec.container);
    for (const obj of extraction.nestedGraph.objects || []) obj.graph = extraction.nestedGraph;
    if (spec.includeSelf) {
      if (spec.container.parent !== null) spec.container.parent.removeChild(spec.container);
      extraction.nestedGraph.root.childrenArray = [spec.container];
      spec.container.parent = extraction.nestedGraph.root;
      extraction.nestedGraph.root.children.set(goLower(spec.container.id), spec.container);
    } else {
      extraction.nestedGraph.root.childrenArray = [...(extraction.nestedGraph.root.childrenArray || []), ...(spec.container.childrenArray || [])];
      for (const child of spec.container.childrenArray || []) {
        child.parent = extraction.nestedGraph.root;
        extraction.nestedGraph.root.children.set(goLower(child.id), child);
      }
      if (spec.container.children !== null) spec.container.children.clear();
      spec.container.childrenArray = null;
    }
  }

  return batch;
}

// rollbackAfter restores sibling diagrams that the batched fast path extracted
// ahead of the diagram whose recursive layout failed. The failing diagram and
// all earlier diagrams remain extracted, matching sequential ExtractSubgraph
// side effects at the same error point.
function rollbackAfter(batch, index) {
  for (let i = index + 1; i < batch.specs.length; i++) {
    const spec = batch.specs[i];
    const extraction = batch.extractions.get(spec.container);
    injectNested(extraction.restoreInto, extraction.nestedGraph, false);
    batch.g.edges = [...(batch.g.edges || []), ...extraction.externalEdges];
  }
  for (const restoreOrder of batch.restoreParentOrder) restoreOrder();
}

// Clone JSON-shaped source configuration for nested layout calls so a plugin
// cannot change the configuration of the parent or another nested diagram.
export function cloneGraphData(data) {
  if (data === null || data === undefined) return null;
  const clone = {};
  for (const key of Object.keys(data)) clone[key] = cloneGraphDataValue(data[key]);
  return clone;
}

function cloneGraphDataValue(value) {
  if (Array.isArray(value)) return value.map(cloneGraphDataValue);
  if (value !== null && typeof value === 'object') return cloneGraphData(value);
  return value;
}

function validateObjectPositions(objects) {
  for (const obj of objects || []) {
    if (obj.box.TopLeft === null) continue;
    if (Math.abs(obj.box.TopLeft.x) === Infinity || Math.abs(obj.box.TopLeft.y) === Infinity) {
      throw new Error(`object ${goQuote(obj.absID())} has invalid position with infinity value: x=${goFixed(obj.box.TopLeft.x)}, y=${goFixed(obj.box.TopLeft.y)}`);
    }
  }
}

export function extractSubgraph(container, includeSelf) {
  const nestedGraph = d2graph.newGraph();
  nestedGraph.data = cloneGraphData(container.graph.data);
  nestedGraph.rootLevel = container.level();
  if (includeSelf) nestedGraph.rootLevel--;
  nestedGraph.root.attributes = copyAttributes(container.attributes);
  nestedGraph.root.box = new geo.Box(null, 0, 0);
  nestedGraph.root.labelPosition = container.labelPosition;
  nestedGraph.root.iconPosition = container.iconPosition;

  const isNestedObject = (obj) => {
    if (includeSelf) return obj.isDescendantOf(container);
    return obj.parent.isDescendantOf(container);
  };

  // separate out nested edges
  const g = container.graph;
  const remainingEdges = [];
  const externalEdges = [];
  const externalEdgeIDs = [];
  for (const edge of g.edges || []) {
    const srcIsNested = isNestedObject(edge.src);
    if (d2sequence.isLifelineEnd(edge.dst)) {
      // special handling for lifelines since their edge.Dst is a special Object
      if (srcIsNested) nestedGraph.edges = [...(nestedGraph.edges || []), edge];
      else remainingEdges.push(edge);
      continue;
    }
    const dstIsNested = isNestedObject(edge.dst);
    if (srcIsNested && dstIsNested) {
      nestedGraph.edges = [...(nestedGraph.edges || []), edge];
    } else if (srcIsNested || dstIsNested) {
      externalEdges.push(edge);
      // we need these AbsIDs when reconnecting since parent references may become stale
      externalEdgeIDs.push({ srcID: edge.src.absID(), dstID: edge.dst.absID() });
    } else remainingEdges.push(edge);
  }
  g.edges = remainingEdges;

  // separate out nested objects
  const remainingObjects = [];
  for (const obj of g.objects || []) {
    if (isNestedObject(obj)) nestedGraph.objects = [...(nestedGraph.objects || []), obj];
    else remainingObjects.push(obj);
  }
  g.objects = remainingObjects;

  // update object and new root references
  for (const o of nestedGraph.objects || []) o.graph = nestedGraph;

  if (includeSelf) {
    // remove container parent's references
    if (container.parent !== null) container.parent.removeChild(container);

    // set root references
    nestedGraph.root.childrenArray = [container];
    container.parent = nestedGraph.root;
    nestedGraph.root.children.set(goLower(container.id), container);
  } else {
    // set root references
    nestedGraph.root.childrenArray = [...(nestedGraph.root.childrenArray || []), ...(container.childrenArray || [])];
    for (const child of container.childrenArray || []) {
      child.parent = nestedGraph.root;
      nestedGraph.root.children.set(goLower(child.id), child);
    }

    // remove container's references
    if (container.children !== null) container.children.clear();
    container.childrenArray = null;
  }

  return [nestedGraph, externalEdges, externalEdgeIDs];
}

/** `nestedGraph.Root.Attributes = container.Attributes`: a copy of the struct, whose pointer fields stay shared */
function copyAttributes(a) {
  const c = new d2graph.Attributes();
  for (const k of Object.keys(a)) c[k] = a[k];
  const cp = (o) => Object.assign(Object.create(Object.getPrototypeOf(o)), o);
  for (const k of ['label', 'labelDimensions', 'style', 'iconStyle', 'shape', 'direction']) c[k] = cp(a[k]);
  return c;
}

export function injectNested(container, nestedGraph, isRoot) {
  const g = container.graph;
  for (const obj of nestedGraph.root.childrenArray || []) {
    obj.parent = container;
    if (container.children === null) container.children = new Map();
    container.children.set(goLower(obj.id), obj);
    container.childrenArray = [...(container.childrenArray || []), obj];
  }
  for (const obj of nestedGraph.objects || []) obj.graph = g;
  g.objects = [...(g.objects || []), ...(nestedGraph.objects || [])];
  g.edges = [...(g.edges || []), ...(nestedGraph.edges || [])];

  if (isRoot) {
    if (nestedGraph.root.labelPosition !== null) container.labelPosition = nestedGraph.root.labelPosition;
    if (nestedGraph.root.iconPosition !== null) container.iconPosition = nestedGraph.root.iconPosition;
    container.attributes = copyAttributes(nestedGraph.root.attributes);
  }
}

export function positionNested(container, nestedGraph) {
  // tl, _ := boundingBox(nestedGraph)
  // Note: assumes nestedGraph's layout has contents positioned relative to 0,0
  const dx = container.box.TopLeft.x; // - tl.X
  const dy = container.box.TopLeft.y; // - tl.Y
  if (dx === 0 && dy === 0) return;
  for (const o of nestedGraph.objects || []) {
    o.box.TopLeft.x += dx;
    o.box.TopLeft.y += dy;
  }
  for (const e of nestedGraph.edges || []) e.move(dx, dy);
}

function boundingBox(g) {
  if ((g.objects || []).length === 0) return [geo.newPoint(0, 0), geo.newPoint(0, 0)];
  const tl = geo.newPoint(Infinity, Infinity);
  const br = geo.newPoint(-Infinity, -Infinity);

  for (const obj of g.objects) {
    if (obj.box.TopLeft === null) throw new Error(obj.absID());
    tl.x = Math.min(tl.x, obj.box.TopLeft.x);
    tl.y = Math.min(tl.y, obj.box.TopLeft.y);
    br.x = Math.max(br.x, obj.box.TopLeft.x + obj.box.Width);
    br.y = Math.max(br.y, obj.box.TopLeft.y + obj.box.Height);
  }

  return [tl, br];
}

export function fitToGraph(container, nestedGraph, padding) {
  let width = nestedGraph.root.box.Width;
  let height = nestedGraph.root.box.Height;
  if (width === 0 || height === 0) {
    const [tl, br] = boundingBox(nestedGraph);
    width = br.x - tl.x;
    height = br.y - tl.y;
  }
  container.box.Width = padding.Left + width + padding.Right;
  container.box.Height = padding.Top + height + padding.Bottom;
}

export { GraphInfo };
