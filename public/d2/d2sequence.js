// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of D2's d2layouts/d2sequence package (D2 v0.9.0, Copyright 2022 Terrastruct Inc.):
// layout.go, constants.go and sequence_diagram.go. Conventions as in d2graph.js.

import * as d2graph from './d2graph.js';
import * as d2target from './target.js';
import * as geo from './geo.js';
import * as label from './label.js';
import * as shape from './shape.js';
import { keyPathHasGlob, goLower } from './ast.js';
import { sortSlice } from './gosort.js';
import { goRound } from './gomath.js';

// units of space on the left/right when computing the space required between actors
export const HORIZONTAL_PAD = 40.;
export const LABEL_HORIZONTAL_PAD = 60.;

// units of space on the top/bottom when computing the space required between messages
// TODO lower
export const VERTICAL_PAD = 40.;

export const MIN_ACTOR_DISTANCE = 150.;

export const MIN_ACTOR_WIDTH = 100.;

export const SELF_MESSAGE_HORIZONTAL_TRAVEL = 80.;

export const GROUP_CONTAINER_PADDING = 12.;

export const EDGE_GROUP_LABEL_PADDING = 20.;

// min vertical distance between messages
export const MIN_MESSAGE_DISTANCE = 30.;

// default size
export const SPAN_BASE_WIDTH = 12.;

// as the spans start getting nested, their size grows
export const SPAN_DEPTH_GROWTH_FACTOR = 8.;

// when a span has a single messages
export const MIN_SPAN_HEIGHT = 30.;

export const SPAN_MESSAGE_PAD = 10.;

export const LIFELINE_STROKE_WIDTH = 2;

export const LIFELINE_STROKE_DASH = 6;

// pad when the actor has the label placed OutsideMiddleBottom so that the lifeline is not so close to the text
export const LIFELINE_LABEL_PAD = 5.;

export const LIFELINE_Z_INDEX = 1;
export const SPAN_Z_INDEX = 2;
export const GROUP_Z_INDEX = 3;
export const MESSAGE_Z_INDEX = 4;
export const NOTE_Z_INDEX = 5;

const MAX_INT32 = 2147483647;
const get0 = (m, k) => m.get(k) ?? 0;
const pos = (s) => label.positionString(s);

/** hash/fnv New32a: FNV-1a (32 bit) of the UTF-8 bytes */
function fnv32a(s) {
  const bytes = new TextEncoder().encode(s);
  let h = 0x811c9dc5;
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Layout runs the sequence diagram layout engine on objects of shape sequence_diagram
 *
 * 1. Run layout on sequence diagrams
 * 2. Set the resulting dimensions to the main graph shape
 */
export function layout(g, layout_) {
  // used in layout code
  g.root.attributes.shape.value = d2target.ShapeSequenceDiagram;

  const sd = layoutSequenceDiagram(g, g.root);
  g.root.box = geo.newBox(null, sd.getWidth() + GROUP_CONTAINER_PADDING * 2, sd.getHeight() + GROUP_CONTAINER_PADDING * 2);

  // the sequence diagram is the only layout engine if the whole diagram is
  // shape: sequence_diagram
  g.root.box.TopLeft = geo.newPoint(0, 0);

  const obj = g.root;

  obj.labelPosition = pos(label.InsideTopCenter);

  // shift the sequence diagrams as they are always placed at (0, 0) with some padding
  sd.shift(geo.newPoint(obj.box.TopLeft.x + GROUP_CONTAINER_PADDING, obj.box.TopLeft.y + GROUP_CONTAINER_PADDING));

  obj.children = new Map();
  obj.childrenArray = [];
  for (const child of sd.actors) {
    obj.children.set(goLower(child.id), child);
    obj.childrenArray.push(child);
  }
  for (const child of sd.groups) {
    if (child.parent.absID() === obj.absID()) {
      obj.children.set(goLower(child.id), child);
      obj.childrenArray.push(child);
    }
  }

  g.edges = [...(g.edges || []), ...sd.lifelines];
}

/** layoutSequenceDiagram finds the edges inside the sequence diagram and performs the layout on the object descendants */
function layoutSequenceDiagram(g, obj) {
  let edges = null;
  for (const edge of g.edges || []) {
    // both Src and Dst must be inside the sequence diagram
    if (obj === g.root || (edge.src.absID().startsWith(obj.absID() + '.') && edge.dst.absID().startsWith(obj.absID() + '.'))) {
      (edges ||= []).push(edge);
    }
  }

  const sd = newSequenceDiagram(obj.childrenArray, edges);
  sd.layout();
  return sd;
}

function getObjEarliestLineNum(o) {
  let min = MAX_INT32;
  for (const ref of o.references || []) {
    if (ref.mapKey === null) continue;
    if (keyPathHasGlob(ref.key)) continue;
    min = Math.min(min, ref.mapKey.range.start.line);
  }
  return min;
}

function getEdgeEarliestLineNum(e) {
  let min = MAX_INT32;
  for (const ref of e.references || []) {
    if (ref.mapKey === null) continue;
    if (keyPathHasGlob(ref.edge.src) || keyPathHasGlob(ref.edge.dst)) continue;
    min = Math.min(min, ref.mapKey.range.start.line);
  }
  return min;
}

/** slices.SortFunc(x, cmp) */
function sortFunc(x, cmp) {
  sortSlice(x, (i, j) => cmp(x[i], x[j]) < 0);
}
const cmpCompare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export class SequenceDiagram {
  constructor() {
    this.root = null;
    this.messages = null;
    this.lifelines = [];
    this.actors = null;
    this.groups = null;
    this.spans = [];
    this.notes = [];

    // can be either actors or spans
    // rank: left to right position of actors/spans (spans have the same rank as their parents)
    this.objectRank = new Map();

    // keep track of the first and last message of a given actor/span
    this.firstMessage = new Map();
    this.lastMessage = new Map();

    // the distance from actor[i] center to actor[i+1] center
    // every neighbor actors need different distances depending on the message labels between them
    this.actorXStep = null;

    this.yStep = 0;
    this.maxActorHeight = 0;

    this.verticalIndices = new Map();
  }

  layout() {
    this.placeActors();
    this.placeNotes();
    this.routeMessages();
    this.placeSpans();
    this.adjustRouteEndpoints();
    this.placeGroups();
    this.addLifelineEdges();
  }

  placeGroups() {
    const sd = this;
    const sorted = sd.groups.map((g, i) => [g, i]);
    sorted.sort((a, b) => (b[0].level() - a[0].level()) || (a[1] - b[1]));
    sd.groups = sorted.map((e) => e[0]);
    for (const group of sd.groups) {
      group.zIndex = GROUP_Z_INDEX;
      sd.placeGroup(group);
    }
    for (const group of sd.groups) sd.adjustGroupLabel(group);
  }

  placeGroup(group) {
    const sd = this;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const m of sd.messages || []) {
      if (m.containedBy(group)) {
        for (const p of m.route) {
          const labelHeight = m.attributes.labelDimensions.height / 2.;
          const edgePad = Math.max(labelHeight + GROUP_CONTAINER_PADDING, MIN_MESSAGE_DISTANCE / 2.);
          minX = Math.min(minX, p.x - HORIZONTAL_PAD);
          minY = Math.min(minY, p.y - edgePad);
          maxX = Math.max(maxX, p.x + HORIZONTAL_PAD);
          maxY = Math.max(maxY, p.y + edgePad);
        }
      }
    }
    // Groups should horizontally encompass all notes of the actor
    for (const n of sd.notes) {
      let inGroup = false;
      for (const ref of n.references || []) {
        if (keyPathHasGlob(ref.key)) continue;
        let curr = ref.scopeObj;
        while (curr !== null) {
          if (curr === group) {
            inGroup = true;
            break;
          }
          curr = curr.parent;
        }
        if (inGroup) break;
      }
      if (inGroup) {
        minX = Math.min(minX, n.box.TopLeft.x - HORIZONTAL_PAD);
        minY = Math.min(minY, n.box.TopLeft.y - MIN_MESSAGE_DISTANCE / 2.);
        maxX = Math.max(maxX, n.box.TopLeft.x + n.box.Width + HORIZONTAL_PAD);
        maxY = Math.max(maxY, n.box.TopLeft.y + n.box.Height + MIN_MESSAGE_DISTANCE / 2.);
      }
    }

    for (const ch of group.childrenArray || []) {
      for (const g of sd.groups) {
        if (ch === g) {
          minX = Math.min(minX, ch.box.TopLeft.x - GROUP_CONTAINER_PADDING);
          minY = Math.min(minY, ch.box.TopLeft.y - GROUP_CONTAINER_PADDING);
          maxX = Math.max(maxX, ch.box.TopLeft.x + ch.box.Width + GROUP_CONTAINER_PADDING);
          maxY = Math.max(maxY, ch.box.TopLeft.y + ch.box.Height + GROUP_CONTAINER_PADDING);
          break;
        }
      }
    }

    group.box = geo.newBox(geo.newPoint(minX, minY), maxX - minX, maxY - minY);
  }

  adjustGroupLabel(group) {
    const sd = this;
    if (!group.hasLabel()) return;

    const heightAdd = group.attributes.labelDimensions.height + Math.trunc(EDGE_GROUP_LABEL_PADDING / 2.);
    if (heightAdd < GROUP_CONTAINER_PADDING) return;

    group.box.Height += heightAdd;

    // Extend stuff within this group
    for (const g of sd.groups) {
      if (g.box.TopLeft.y < group.box.TopLeft.y && g.box.TopLeft.y + g.box.Height > group.box.TopLeft.y) g.box.Height += heightAdd;
    }
    for (const s of sd.spans) {
      if (s.box.TopLeft.y < group.box.TopLeft.y && s.box.TopLeft.y + s.box.Height > group.box.TopLeft.y) s.box.Height += heightAdd;
    }

    // Move stuff down
    for (const m of sd.messages || []) {
      if (Math.min(m.route[0].y, m.route[m.route.length - 1].y) > group.box.TopLeft.y) {
        for (const p of m.route) p.y += heightAdd;
      }
    }
    for (const s of sd.spans) {
      if (s.box.TopLeft.y > group.box.TopLeft.y) s.box.TopLeft.y += heightAdd;
    }
    for (const g of sd.groups) {
      if (g.box.TopLeft.y > group.box.TopLeft.y) g.box.TopLeft.y += heightAdd;
    }
    for (const n of sd.notes) {
      if (n.box.TopLeft.y > group.box.TopLeft.y) n.box.TopLeft.y += heightAdd;
    }
  }

  /** placeActors places actors bottom aligned, side by side with centers spaced by sd.actorXStep */
  placeActors() {
    const sd = this;
    let centerX = sd.actors[0].box.Width / 2.;
    for (let rank = 0; rank < sd.actors.length; rank++) {
      const actor = sd.actors[rank];
      let yOffset;
      if (actor.hasOutsideBottomLabel()) {
        if (actor.iconPosition === null) actor.labelPosition = pos(label.OutsideBottomCenter);
        yOffset = sd.maxActorHeight - actor.box.Height;
        if (actor.hasLabel()) yOffset -= actor.attributes.labelDimensions.height;
      } else {
        if (actor.attributes.icon !== null && actor.attributes.shape.value !== d2target.ShapeImage) {
          if (actor.labelPosition === null) actor.labelPosition = pos(label.OutsideTopCenter);
          if (actor.iconPosition === null) actor.iconPosition = pos(label.InsideMiddleCenter);
        } else if (actor.iconPosition === null) actor.labelPosition = pos(label.InsideMiddleCenter);
        yOffset = sd.maxActorHeight - actor.box.Height;
      }
      const halfWidth = actor.box.Width / 2.;
      actor.box.TopLeft = geo.newPoint(goRound(centerX - halfWidth), yOffset);
      if (rank !== sd.actors.length - 1) centerX += sd.actorXStep[rank];
    }
  }

  /**
   * addLifelineEdges adds a new edge for each actor in the graph that represents the its lifeline
   * . ┌──────────────┐
   * . │     actor    │
   * . └──────┬───────┘
   * .        │
   * .        │ lifeline
   * .        │
   * .        │
   */
  addLifelineEdges() {
    const sd = this;
    let endY = 0.;
    if ((sd.messages || []).length > 0) {
      const lastRoute = sd.messages[sd.messages.length - 1].route;
      for (const p of lastRoute) endY = Math.max(endY, p.y);
    }
    for (const note of sd.notes) endY = Math.max(endY, note.box.TopLeft.y + note.box.Height);
    for (const actor of sd.actors) endY = Math.max(endY, actor.box.TopLeft.y + actor.box.Height);
    endY += sd.yStep;

    for (const actor of sd.actors) {
      const actorBottom = actor.box.center();
      actorBottom.y = actor.box.TopLeft.y + actor.box.Height;
      if (actor.labelPosition === null) throw new Error('runtime error: invalid memory address or nil pointer dereference');
      if (actor.labelPosition === pos(label.OutsideBottomCenter) && actor.hasLabel()) {
        actorBottom.y += actor.attributes.labelDimensions.height + LIFELINE_LABEL_PAD;
      }
      const actorLifelineEnd = actor.box.center();
      actorLifelineEnd.y = endY;
      const style = new d2graph.Style();
      style.strokeDash = new d2graph.Scalar(String(LIFELINE_STROKE_DASH));
      style.strokeWidth = new d2graph.Scalar(String(LIFELINE_STROKE_WIDTH));
      if (actor.attributes.style.strokeDash !== null) style.strokeDash = new d2graph.Scalar(actor.attributes.style.strokeDash.value);
      if (actor.attributes.style.stroke !== null) style.stroke = new d2graph.Scalar(actor.attributes.style.stroke.value);

      const e = new d2graph.Edge();
      e.attributes.style = style;
      e.src = actor;
      e.srcArrow = false;
      e.dst = new d2graph.GraphObject();
      e.dst.id = lifelineEndID(actor.id);
      e.dstArrow = false;
      e.route = [actorBottom, actorLifelineEnd];
      e.zIndex = LIFELINE_Z_INDEX;
      sd.lifelines.push(e);
    }
  }

  placeNotes() {
    const sd = this;
    const rankToX = new Map();
    for (const actor of sd.actors) rankToX.set(get0(sd.objectRank, actor), actor.box.center().x);

    for (const note of sd.notes) {
      const verticalIndex = get0(sd.verticalIndices, note.absID());
      let y = sd.maxActorHeight + sd.yStep;

      for (const msg of sd.messages || []) {
        if (get0(sd.verticalIndices, msg.absID()) < verticalIndex) {
          if (msg.src === msg.dst) {
            // For self-messages, account for the full vertical space they occupy
            y += sd.yStep + Math.max(msg.attributes.labelDimensions.height, MIN_MESSAGE_DISTANCE) * 1.5;
          } else {
            y += sd.yStep + msg.attributes.labelDimensions.height;
          }
        }
      }
      for (const otherNote of sd.notes) {
        if (get0(sd.verticalIndices, otherNote.absID()) < verticalIndex) y += otherNote.box.Height + sd.yStep;
      }

      const x = get0(rankToX, get0(sd.objectRank, note)) - (note.box.Width / 2.);
      note.box.TopLeft = geo.newPoint(x, y);
      note.zIndex = NOTE_Z_INDEX;
    }
  }

  /**
   * placeSpans places spans over the object lifeline
   * . ┌──────────┐
   * . │  actor   │
   * . └────┬─────┘
   * .    ┌─┴──┐
   * .    │    │
   * .    |span|
   * .    │    │
   * .    └─┬──┘
   * .      │
   * .   lifeline
   * .      │
   */
  placeSpans() {
    const sd = this;
    // quickly find the span center X
    const rankToX = new Map();
    for (const actor of sd.actors) rankToX.set(get0(sd.objectRank, actor), actor.box.center().x);

    // places spans from most to least nested
    // the order is important because the only way a child span exists is if there's a message to it
    // however, the parent span might not have a message to it and then its position is based on the child position
    // or, there can be a message to it, but it comes after the child one meaning the top left position is still based on the child
    // and not on its own message
    const spanFromMostNested = sd.spans.map((s, i) => [s, i]);
    spanFromMostNested.sort((a, b) => (b[0].level() - a[0].level()) || (a[1] - b[1]));
    for (const [span] of spanFromMostNested) {
      // finds the position based on children
      let minChildY = Infinity;
      let maxChildY = -Infinity;
      for (const child of span.childrenArray || []) {
        minChildY = Math.min(minChildY, child.box.TopLeft.y);
        maxChildY = Math.max(maxChildY, child.box.TopLeft.y + child.box.Height);
      }

      // finds the position if there are messages to this span
      let minMessageY = Infinity;
      if (sd.firstMessage.has(span)) {
        const firstMessage = sd.firstMessage.get(span);
        if (firstMessage.src === firstMessage.dst || span === firstMessage.src) minMessageY = firstMessage.route[0].y;
        else minMessageY = firstMessage.route[firstMessage.route.length - 1].y;
      }
      let maxMessageY = -Infinity;
      if (sd.lastMessage.has(span)) {
        const lastMessage = sd.lastMessage.get(span);
        if (lastMessage.src === lastMessage.dst || span === lastMessage.dst) maxMessageY = lastMessage.route[lastMessage.route.length - 1].y;
        else maxMessageY = lastMessage.route[0].y;
      }

      // if it is the same as the child top left, add some padding
      let minY = Math.min(minMessageY, minChildY);
      if (minY === minChildY || minY === minMessageY) minY -= SPAN_MESSAGE_PAD;
      let maxY = Math.max(maxMessageY, maxChildY);
      if (maxY === maxChildY || maxY === maxMessageY) maxY += SPAN_MESSAGE_PAD;

      const height = Math.max(maxY - minY, MIN_SPAN_HEIGHT);
      // -1 because the actors count as 1 level
      const width = SPAN_BASE_WIDTH + ((span.level() - sd.root.level() - 2) * SPAN_DEPTH_GROWTH_FACTOR);
      const x = get0(rankToX, get0(sd.objectRank, span)) - (width / 2.);
      span.box = geo.newBox(geo.newPoint(x, minY), width, height);
      span.zIndex = SPAN_Z_INDEX;
    }
  }

  /**
   * routeMessages routes horizontal edges (messages) from Src to Dst lifeline (actor/span center)
   * in another step, routes are adjusted to spans borders when necessary
   */
  routeMessages() {
    const sd = this;
    let messageOffset = sd.maxActorHeight + sd.yStep;
    for (const message of sd.messages || []) {
      message.zIndex = MESSAGE_Z_INDEX;
      let noteOffset = 0.;
      for (const note of sd.notes) {
        if (get0(sd.verticalIndices, note.absID()) < get0(sd.verticalIndices, message.absID())) noteOffset += note.box.Height + sd.yStep;
      }

      let startX, endX;
      const startCenter = getCenter(message.src);
      if (startCenter !== null) startX = startCenter.x;
      else throw new Error(`could not find center of ${message.src.id}. Is it declared as an actor?`);
      const endCenter = getCenter(message.dst);
      if (endCenter !== null) endX = endCenter.x;
      else throw new Error(`could not find center of ${message.dst.id}. Is it declared as an actor?`);
      const isToDescendant = message.dst.absID().startsWith(message.src.absID() + '.');
      const isFromDescendant = message.src.absID().startsWith(message.dst.absID() + '.');
      const isSelfMessage = message.src === message.dst;

      let currSrc = message.src;
      while (!currSrc.parent.isSequenceDiagram()) currSrc = currSrc.parent;
      let currDst = message.dst;
      while (!currDst.parent.isSequenceDiagram()) currDst = currDst.parent;
      const isToSibling = currSrc === currDst;

      if (isSelfMessage || isToDescendant || isFromDescendant || isToSibling) {
        const midX = startX + Math.max(SELF_MESSAGE_HORIZONTAL_TRAVEL, message.attributes.labelDimensions.width / 2. + label.PADDING * 2);
        const startY = messageOffset + noteOffset;
        const endY = startY + Math.max(message.attributes.labelDimensions.height, MIN_MESSAGE_DISTANCE) * 1.5;
        message.route = [
          geo.newPoint(startX, startY),
          geo.newPoint(midX, startY),
          geo.newPoint(midX, endY),
          geo.newPoint(endX, endY),
        ];
        messageOffset = endY + sd.yStep - noteOffset;
      } else {
        // float64(message.LabelDimensions.Height/2.): int division of an untyped constant 2. converts to int 2 -> integer division in Go
        const startY = messageOffset + noteOffset + Math.trunc(message.attributes.labelDimensions.height / 2);
        message.route = [
          geo.newPoint(startX, startY),
          geo.newPoint(endX, startY),
        ];
        messageOffset = startY + Math.trunc(message.attributes.labelDimensions.height / 2) + sd.yStep - noteOffset;
      }

      if (message.attributes.label.value !== '') message.labelPosition = pos(label.InsideMiddleCenter);
    }
  }

  /**
   * adjustRouteEndpoints adjust the first and last points of message routes when they are spans
   * routeMessages() will route to the actor lifelife as a reference point and this function
   * adjust to span width when necessary
   */
  adjustRouteEndpoints() {
    const sd = this;
    for (const message of sd.messages || []) {
      const route = message.route;
      if (!sd.isActor(message.src)) {
        if (get0(sd.objectRank, message.src) <= get0(sd.objectRank, message.dst)) route[0].x += message.src.box.Width / 2.;
        else route[0].x -= message.src.box.Width / 2.;
      }
      if (!sd.isActor(message.dst)) {
        if (get0(sd.objectRank, message.src) < get0(sd.objectRank, message.dst)) route[route.length - 1].x -= message.dst.box.Width / 2.;
        else route[route.length - 1].x += message.dst.box.Width / 2.;
      }
    }
  }

  isActor(obj) {
    return obj.parent === this.root;
  }

  getWidth() {
    const sd = this;
    // the layout is always placed starting at 0, so the width is just the last actor
    const lastActor = sd.actors[sd.actors.length - 1];
    let rightmost = lastActor.box.TopLeft.x + lastActor.box.Width;

    for (const m of sd.messages || []) {
      for (const p of m.route) rightmost = Math.max(rightmost, p.x);
      // Self referential messages may have labels that extend further
      if (m.src === m.dst) rightmost = Math.max(rightmost, m.route[1].x + m.attributes.labelDimensions.width / 2.);
    }

    return rightmost;
  }

  getHeight() {
    return this.lifelines[0].route[1].y;
  }

  shift(tl) {
    const sd = this;
    const allObjects = [...sd.actors, ...sd.spans, ...sd.groups, ...sd.notes];
    for (const obj of allObjects) {
      obj.box.TopLeft.x += tl.x;
      obj.box.TopLeft.y += tl.y;
    }

    const allEdges = [...(sd.messages || []), ...sd.lifelines];
    for (const edge of allEdges) {
      for (const p of edge.route) {
        p.x += tl.x;
        p.y += tl.y;
      }
    }
  }
}

function newSequenceDiagram(objects, messages) {
  const actors = [];
  const groups = [];

  sortFunc(objects, (a, b) => cmpCompare(getObjEarliestLineNum(a), getObjEarliestLineNum(b)));
  if (messages !== null) sortFunc(messages, (a, b) => cmpCompare(getEdgeEarliestLineNum(a), getEdgeEarliestLineNum(b)));

  for (const obj of objects) {
    if (obj.isSequenceDiagramGroup()) {
      let queue = [obj];
      // Groups may have more nested groups
      while (queue.length > 0) {
        const curr = queue[0];
        curr.labelPosition = pos(label.InsideTopLeft);
        groups.push(curr);
        queue = queue.slice(1);
        queue = [...queue, ...(curr.childrenArray || [])];
      }
    } else {
      actors.push(obj);
      if (obj.isSequenceDiagram()) {
        throw new Error(`actors in sequence diagrams cannot themselves be sequence diagrams: ${obj.absID()}`);
      }
    }
  }

  if (actors.length === 0) throw new Error('no actors declared in sequence diagram');

  const sd = new SequenceDiagram();
  sd.messages = messages;
  sd.actors = actors;
  sd.groups = groups;
  sd.actorXStep = new Array(actors.length - 1).fill(0);
  sd.yStep = MIN_MESSAGE_DISTANCE;
  sd.maxActorHeight = 0.;

  for (let rank = 0; rank < actors.length; rank++) {
    const actor = actors[rank];
    sd.root = actor.parent;
    sd.objectRank.set(actor, rank);

    if (actor.box.Width < MIN_ACTOR_WIDTH) {
      const dslShape = actor.attributes.shape.value.toLowerCase();
      switch (dslShape) {
        case d2target.ShapePerson: case d2target.ShapeOval: case d2target.ShapeSquare: case d2target.ShapeCircle:
          // scale shape up to min width uniformly
          actor.box.Height *= MIN_ACTOR_WIDTH / actor.box.Width;
      }
      actor.box.Width = MIN_ACTOR_WIDTH;
    }
    sd.maxActorHeight = Math.max(sd.maxActorHeight, actor.box.Height);

    let queue = [...(actor.childrenArray || [])];
    let maxNoteWidth = 0.;
    while (queue.length > 0) {
      const child = queue[0];
      queue = queue.slice(1);

      // spans are children of actors that have edges
      // edge groups are children of actors with no edges and children edges
      if (child.isSequenceDiagramNote()) {
        sd.verticalIndices.set(child.absID(), getObjEarliestLineNum(child));
        child.attributes.shape = new d2graph.Scalar(shape.PAGE_TYPE);
        sd.notes.push(child);
        sd.objectRank.set(child, rank);
        child.labelPosition = pos(label.InsideMiddleCenter);
        maxNoteWidth = Math.max(maxNoteWidth, child.box.Width);
      } else {
        // spans have no labels
        // TODO why not? Spans should be able to
        child.attributes.label = new d2graph.Scalar('');
        child.attributes.shape = new d2graph.Scalar(shape.SQUARE_TYPE);
        sd.spans.push(child);
        sd.objectRank.set(child, rank);
      }

      queue = [...queue, ...(child.childrenArray || [])];
    }

    if (rank !== actors.length - 1) {
      const actorHW = actor.box.Width / 2.;
      const nextActorHW = actors[rank + 1].box.Width / 2.;
      sd.actorXStep[rank] = Math.max(actorHW + nextActorHW + HORIZONTAL_PAD, MIN_ACTOR_DISTANCE);
      sd.actorXStep[rank] = Math.max(maxNoteWidth / 2. + HORIZONTAL_PAD, sd.actorXStep[rank]);
      if (rank > 0) sd.actorXStep[rank - 1] = Math.max(maxNoteWidth / 2. + HORIZONTAL_PAD, sd.actorXStep[rank - 1]);
    }
  }

  for (const message of sd.messages || []) {
    sd.verticalIndices.set(message.absID(), getEdgeEarliestLineNum(message));

    // ensures that long labels, spanning over multiple actors, don't make for large gaps between actors
    // by distributing the label length across the actors rank difference
    const rankDiff = Math.abs(get0(sd.objectRank, message.src) - get0(sd.objectRank, message.dst));
    if (rankDiff !== 0) {
      const distributedLabelWidth = message.attributes.labelDimensions.width / rankDiff;
      for (let rank = Math.min(get0(sd.objectRank, message.src), get0(sd.objectRank, message.dst)); rank <= Math.max(get0(sd.objectRank, message.src), get0(sd.objectRank, message.dst)) - 1; rank++) {
        sd.actorXStep[rank] = Math.max(sd.actorXStep[rank], distributedLabelWidth + LABEL_HORIZONTAL_PAD);
      }
    } else {
      // self edge
      const nextRank = get0(sd.objectRank, message.src);
      if (nextRank < sd.actorXStep.length) {
        const labelAdjust = message.attributes.labelDimensions.width + label.PADDING * 4;
        sd.actorXStep[nextRank] = Math.max(sd.actorXStep[nextRank], labelAdjust);
      }
    }
    sd.lastMessage.set(message.src, message);
    if (!sd.firstMessage.has(message.src)) sd.firstMessage.set(message.src, message);
    sd.lastMessage.set(message.dst, message);
    if (!sd.firstMessage.has(message.dst)) sd.firstMessage.set(message.dst, message);
  }

  sd.yStep += VERTICAL_PAD;
  sd.maxActorHeight += VERTICAL_PAD;
  if (sd.root.hasLabel()) sd.maxActorHeight += sd.root.attributes.labelDimensions.height;

  return sd;
}

function getCenter(obj) {
  if (obj === null) return null;
  else if (obj.box !== null && obj.box.TopLeft !== null) return obj.box.center();
  return getCenter(obj.parent);
}

const lifelineEndSuffix = '-lifeline-end';

/**
 * LifelineEndID returns the synthetic endpoint ID for an actor's lifeline.
 * The hash is formatted as an unsigned 32-bit value so the ID is stable across architectures.
 */
export function lifelineEndID(actorID) {
  return actorID + lifelineEndSuffix + '-' + String(fnv32a(actorID + lifelineEndSuffix));
}

/** IsLifelineEnd reports whether obj is a synthetic sequence-diagram lifeline endpoint. */
export function isLifelineEnd(obj) {
  // lifeline ends only have ID and no graph parent or box set
  if (obj === null || obj.graph !== null || obj.parent !== null || obj.box !== null) return false;
  const marker = lifelineEndSuffix + '-';
  const markerIndex = obj.id.lastIndexOf(marker);
  if (markerIndex < 0) return false;
  // Go slices the ID by bytes; the marker is ASCII, so the UTF-16 index is the same position
  return obj.id === lifelineEndID(obj.id.slice(0, markerIndex));
}
