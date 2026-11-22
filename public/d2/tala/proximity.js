// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of the Go package d2layouts/d2talalayout/internal/proximity (D2 v0.9.0, github.com/d2lang/d2, Copyright 2022
// Terrastruct Inc.): discovers layout relationships between nearby nodes: common uncles, hubs (hubs.go), nears (nears.go) and herds
// (herding.go). Go's maps keyed by *Node are Maps/Sets; every place that ranges over such a map in Go sorts or builds a set first.

import * as geo from '../geo.js';
import { errorf } from './goerrors.js';
import * as invariant from './invariant.js';
import * as lg from './layoutgraph.js';
import * as limits from './limits.js';
import { sortFunc, compare } from './goslices.js';

const { Orientation } = geo;

// ============================== common_uncle.go ==============================

/**
 * CommonUncleSiblings finds siblings that connect to the same node at their parent's level. Placement uses the largest such set as a
 * proximity hint. Returns Map<Node, Node[]>.
 */
export function commonUncleSiblings(graph) {
  let uncleToCousins = new Map();
  const common = new Map();
  const orderedUncles = [];
  for (const container of graph.containerRDFSOrderUnbounded(null)) {
    const children = graph.containers.get(container) ?? [];
    for (const node of children) {
      for (const edge of node.edges) {
        const adjacent = node.adjacent(edge);
        if (adjacent.container === container.container) {
          if (!uncleToCousins.has(adjacent)) {
            orderedUncles.push(adjacent);
            uncleToCousins.set(adjacent, []);
          }
          if (!uncleToCousins.get(adjacent).includes(node)) {
            uncleToCousins.set(adjacent, [...uncleToCousins.get(adjacent), node]);
          }
        }
      }
    }
    for (const uncle of orderedUncles) {
      const siblings = uncleToCousins.get(uncle) ?? [];
      if (siblings.length < 2) continue;
      for (const sibling of siblings) {
        const existing = common.get(sibling);
        if (existing === undefined || existing.length < siblings.length) {
          common.set(sibling, siblings);
        }
      }
    }
    uncleToCousins = new Map();
  }
  return common;
}

// ============================== hubs.go ==============================

/** AddHubs discovers nodes that have both a leaf spoke and another connection within the same containing layout group. */
export function addHubs(ctx, graph) {
  lg.validate(ctx, 'AddHubs', graph);
  const guard = limits.newWorkGuard(ctx, 'AddHubs', limits.MaxEngineWorkUnits);
  const hubs = new Map();
  for (const node of graph.nodes) {
    guard.step();
    let hasConnected = false;
    const spokes = [];
    for (const edge of node.edges) {
      guard.step();
      const adjacent = node.adjacent(edge);
      if (adjacent.owningContainer() !== node.owningContainer()) continue;
      if (adjacent.edges.length === 1) spokes.push(adjacent);
      else hasConnected = true;
    }
    if (hasConnected && spokes.length > 0) hubs.set(node, spokes);
  }
  guard.finish();
  graph.hubs = hubs;
}

// ============================== nears.go ==============================

/** AssignNears marks otherwise unconnected siblings that share an external neighbor so placement keeps them close together. */
export function assignNears(ctx, graph, root, abductions) {
  assignNearsWithWorkLimit(ctx, graph, root, abductions, limits.MaxEngineWorkUnits);
}

export function assignNearsWithWorkLimit(ctx, graph, root, abductions, workLimit) {
  const guard = limits.newWorkGuard(ctx, 'AssignNears', workLimit);
  const uncles = new Map(); // Map<Node, Set<Node>>
  for (const abduction of abductions) {
    guard.step();
    if (abduction === null) throw invariant.newError('nil edge abduction while assigning nears');
    const originallyFrom = groupVessel(abduction.originallyFrom);
    const originallyTo = groupVessel(abduction.originallyTo);
    let uncle = null;
    let connected = null;
    for (const node of graph.containers.get(root) ?? []) {
      guard.step();
      const fromDescendant = isDescendantOf(originallyFrom, node, guard);
      const toDescendant = isDescendantOf(originallyTo, node, guard);
      if (fromDescendant) {
        uncle = abduction.currentTo;
        connected = node;
        break;
      } else if (toDescendant) {
        uncle = abduction.currentFrom;
        connected = node;
        break;
      }
    }
    if (uncle !== null && connected !== null) {
      if (!uncles.has(uncle)) uncles.set(uncle, new Set());
      uncles.get(uncle).add(connected);
    }
  }

  const orderedUncles = [];
  for (const uncle of uncles.keys()) {
    guard.step();
    orderedUncles.push(uncle);
  }
  lg.sortNodesByID(orderedUncles);

  const originalNears = new Map();
  const replacementNears = new Map();
  let nearReferences = 0;
  const mutableNears = (node) => {
    if (replacementNears.has(node)) return replacementNears.get(node);
    if (node.nears.size > lg.MaxTopologyReferences - nearReferences) {
      throw errorf(`TALA AssignNears topology references exceed limit ${lg.MaxTopologyReferences}`);
    }
    nearReferences += node.nears.size;
    originalNears.set(node, node.nears);
    const replacement = new Set();
    for (const near of node.nears) {
      guard.step();
      replacement.add(near);
    }
    replacementNears.set(node, replacement);
    return replacement;
  };
  const hasConnection = (node, other) => {
    for (const edge of node.edges) {
      guard.step();
      if (edge !== null && node.adjacent(edge) === other) return true;
    }
    return false;
  };

  for (const uncle of orderedUncles) {
    const nodes = [];
    for (const node of uncles.get(uncle)) {
      guard.step();
      nodes.push(node);
    }
    lg.sortNodesByID(nodes);
    if (nodes.length === 1) continue;
    for (let i = 0; i < nodes.length; i++) {
      const first = nodes[i];
      for (const second of nodes.slice(i + 1)) {
        guard.step();
        if (first.hierarchy !== null || second.hierarchy !== null) continue;
        const connectedPair = hasConnection(first, second);
        if (connectedPair) continue;
        const firstNears = mutableNears(first);
        const secondNears = mutableNears(second);
        if (!firstNears.has(second)) {
          if (nearReferences >= lg.MaxTopologyReferences) {
            throw errorf(`TALA AssignNears topology references exceed limit ${lg.MaxTopologyReferences}`);
          }
          firstNears.add(second);
          nearReferences++;
        }
        if (!secondNears.has(first)) {
          if (nearReferences >= lg.MaxTopologyReferences) {
            throw errorf(`TALA AssignNears topology references exceed limit ${lg.MaxTopologyReferences}`);
          }
          secondNears.add(first);
          nearReferences++;
        }
      }
    }
  }
  guard.finish();

  let complete = false;
  try {
    const commitOrder = [...replacementNears.keys()];
    lg.sortNodesByID(commitOrder);
    for (const node of commitOrder) {
      node.nears = replacementNears.get(node);
      guard.finish();
    }
    complete = true;
  } finally {
    if (!complete) {
      for (const [node, nears] of originalNears) node.nears = nears;
    }
  }
}

function groupVessel(node) {
  if (node === null) return null;
  if (node.cluster !== null) return node.cluster.vessel;
  if (node.sequence !== null) return node.sequence.vessel;
  return node;
}

function isDescendantOf(descendant, ancestor, guard) {
  for (;;) {
    guard.step();
    if (descendant === ancestor) return true;
    if (descendant === null) return false;
    if (descendant.container !== null) descendant = descendant.container;
    else if (descendant.cluster !== null) descendant = descendant.cluster.vessel;
    else if (descendant.sequence !== null) descendant = descendant.sequence.vessel;
    else descendant = null;
  }
}

// ============================== herding.go ==============================

const ctxErr = (ctx) => {
  const err = ctx.err();
  return err === null ? null : errorf(`AssignHerds: ${err.message}`, err);
};

/** AssignHerds chooses a shared container side for siblings whose external cousins should remain mutually accessible during placement. */
export function assignHerds(ctx, graph, root, abductions) {
  let e = ctxErr(ctx);
  if (e !== null) throw e;
  const [grouped, cousins] = groupSheep(ctx, graph, root, abductions);
  let uncleOrder = [];
  for (const [uncle, nodes] of [...grouped]) {
    if (nodes.length <= 1) {
      grouped.delete(uncle);
      cousins.delete(uncle);
    } else {
      uncleOrder.push(uncle);
    }
  }
  sortFunc(uncleOrder, (a, b) => compare(a.id, b.id));

  const components = connectedHerds(ctx, uncleOrder, grouped);
  let unbiasedSide = 0;
  for (const component of components) {
    // Overlapping groups describe a single equality constraint: every member
    // must use the same side. Choose that side only after intersecting all
    // placed cousins' available sides, so a later uncle cannot change one
    // member and invalidate an earlier group.
    let sides = [Orientation.Top, Orientation.Right, Orientation.Bottom, Orientation.Left];
    let preferred = Orientation.NONE;
    for (const uncle of component.uncles) {
      e = ctxErr(ctx);
      if (e !== null) throw e;
      const children = graph.containers.get(uncle) ?? [];
      if (children.length === 0) throw invariant.errorf(`herding uncle ${uncle.debugID()} has no children`);
      if (children[0].topLeft === null) continue;
      for (const node of grouped.get(uncle) ?? []) {
        for (const cousin of cousins.get(uncle)?.get(node) ?? []) {
          const assignment = cousin.herdAssignment;
          if (assignment === null) continue;
          const orientation = assignment.orientation;
          if (!geo.isHorizontal(orientation) && !geo.isVertical(orientation)) {
            throw invariant.errorf(`cousin ${cousin.debugID()} has an invalid herd orientation`);
          }
          const bothSides = canUseBothSides(uncle, orientation);
          sides = sides.filter((side) => !(side !== geo.getOpposite(orientation) && !(bothSides && side === orientation)));
          if (preferred === Orientation.NONE) {
            preferred = geo.getOpposite(orientation);
            if (bothSides && assignment.sameSidePairCount() < assignment.oppositeSidePairCount()) {
              preferred = orientation;
            }
          }
        }
      }
    }
    if (sides.length === 0) {
      // Herding is a placement preference. Cousins on incompatible sides
      // can make that preference impossible for a valid graph; in that
      // case leave the entire connected herd free to place normally.
      for (const node of component.nodes) node.herdAssignment = null;
      continue;
    }
    if (preferred === Orientation.NONE) {
      preferred = sides[unbiasedSide % sides.length];
      unbiasedSide++;
    } else if (!sides.includes(preferred)) {
      preferred = sides[0];
    }
    for (const node of component.nodes) {
      node.herdAssignment = lg.newHerdAssignment();
      node.herdAssignment.orientation = preferred;
    }
    // Pair counts influence later herds, so record only the final choice.
    for (const uncle of component.uncles) {
      if (graph.containers.get(uncle)[0].topLeft === null) continue;
      for (const node of grouped.get(uncle) ?? []) {
        for (const cousin of cousins.get(uncle)?.get(node) ?? []) {
          if (cousin.herdAssignment === null) continue;
          if (preferred === cousin.herdAssignment.orientation) {
            node.herdAssignment.pairSameSide(uncle);
            cousin.herdAssignment.pairSameSide(uncle);
          } else {
            node.herdAssignment.pairOppositeSide(uncle);
            cousin.herdAssignment.pairOppositeSide(uncle);
          }
        }
      }
    }
  }
  applyVirally(ctx, uncleOrder, grouped);

  for (const uncle of uncleOrder) {
    for (const node of grouped.get(uncle) ?? []) {
      if (node.herdAssignment !== null && node.isClusterVessel()) {
        const cluster = graph.clusters.get(node);
        if ((node.herdAssignment.orientation === Orientation.Top || node.herdAssignment.orientation === Orientation.Bottom) && cluster.arrangement === lg.Column) {
          cluster.arrangement = lg.Row;
        } else if ((node.herdAssignment.orientation === Orientation.Left || node.herdAssignment.orientation === Orientation.Right) && cluster.arrangement === lg.Row) {
          cluster.arrangement = lg.Column;
        }
      }
    }
  }
}

/** connectedHerds joins groups that share a node, retaining deterministic order. */
function connectedHerds(ctx, herdOrder, herds) {
  const byNode = new Map();
  for (const uncle of herdOrder) {
    for (const node of herds.get(uncle) ?? []) {
      const list = byNode.get(node);
      if (list === undefined) byNode.set(node, [uncle]);
      else list.push(uncle);
    }
  }
  const seenUncles = new Set();
  const seenNodes = new Set();
  const components = [];
  for (const uncle of herdOrder) {
    if (seenUncles.has(uncle)) continue;
    const component = { nodes: [], uncles: [uncle] };
    seenUncles.add(uncle);
    for (let i = 0; i < component.uncles.length; i++) {
      const e = ctxErr(ctx);
      if (e !== null) throw e;
      for (const node of herds.get(component.uncles[i]) ?? []) {
        if (seenNodes.has(node)) continue;
        seenNodes.add(node);
        component.nodes.push(node);
        for (const related of byNode.get(node) ?? []) {
          if (!seenUncles.has(related)) {
            seenUncles.add(related);
            component.uncles.push(related);
          }
        }
      }
    }
    components.push(component);
  }
  return components;
}

/** ApplyVirally propagates each known herd orientation through its ordered groups. */
export function applyVirally(ctx, herdOrder, herds) {
  for (;;) {
    let e = ctxErr(ctx);
    if (e !== null) throw e;
    let end = true;
    for (const uncle of herdOrder) {
      e = ctxErr(ctx);
      if (e !== null) throw e;
      const nodes = herds.get(uncle) ?? [];
      let assignment = null;
      for (const node of nodes) {
        if (node.herdAssignment !== null && node.herdAssignment.orientation !== Orientation.NONE) {
          assignment = node.herdAssignment;
          break;
        }
      }
      if (assignment !== null) {
        for (const node of nodes) {
          if (node.herdAssignment === null) {
            end = false;
            node.herdAssignment = assignment.copy();
          } else if (node.herdAssignment.orientation !== Orientation.NONE && node.herdAssignment.orientation !== assignment.orientation) {
            throw invariant.errorf(
              `node ${node.debugID()} has herd orientation ${geo.orientationToString(node.herdAssignment.orientation)}; expected ${geo.orientationToString(assignment.orientation)}`,
            );
          }
        }
      }
    }
    if (end) return;
  }
}

/** CanUseBothSides reports whether node is long enough perpendicular to orientation to host herd members on both parallel sides. */
export function canUseBothSides(node, orientation) {
  const isWide = node.width >= 2 * node.height;
  const isTall = node.height >= 2 * node.width;
  return ((orientation === Orientation.Top || orientation === Orientation.Bottom) && isWide) ||
    ((orientation === Orientation.Left || orientation === Orientation.Right) && isTall);
}

/**
 * GroupSheep groups root's children by their external uncle and records the cousin connections that define each group.
 * Returns [byUncle: Map<Node, Node[]>, toCousin: Map<Node, Map<Node, Node[]>>].
 */
export function groupSheep(ctx, graph, root, abductions) {
  const byUncle = new Map();
  const toCousin = new Map();
  const used = new Array(abductions.length).fill(false);
  for (const node of graph.containers.get(root) ?? []) {
    const e = ctxErr(ctx);
    if (e !== null) throw e;
    for (let i = 0; i < abductions.length; i++) {
      const abduction = abductions[i];
      const e2 = ctxErr(ctx);
      if (e2 !== null) throw e2;
      if (used[i]) continue;
      if (abduction === null) throw invariant.newError('herding has a nil edge abduction');
      const from = groupVessel(abduction.originallyFrom);
      const to = groupVessel(abduction.originallyTo);
      let cousin = null;
      let current = null;
      if (abduction.originallyTo !== null && (from === node || descendantOf(from, node))) {
        if (abduction.currentTo !== null && !abduction.currentTo.isContainer()) continue;
        if (to === null || to.owningContainer() === null) continue;
        cousin = to;
        current = abduction.currentTo;
      } else if (abduction.originallyFrom !== null && (to === node || descendantOf(to, node))) {
        if (abduction.currentFrom !== null && !abduction.currentFrom.isContainer()) continue;
        if (from === null || from.owningContainer() === null) continue;
        cousin = from;
        current = abduction.currentFrom;
      }
      if (cousin === null) continue;
      used[i] = true;
      while (cousin.owningContainer() !== current) {
        if (cousin.cluster !== null) cousin = cousin.cluster.vessel;
        else if (cousin.sequence !== null) cousin = cousin.sequence.vessel;
        else cousin = cousin.owningContainer();
      }
      const uncle = cousin.owningContainer();
      if (uncle === null || !uncle.isContainer()) continue;
      if (!toCousin.has(uncle)) toCousin.set(uncle, new Map());
      const byNode = toCousin.get(uncle);
      if (!byNode.has(node)) {
        const list = byUncle.get(uncle);
        if (list === undefined) byUncle.set(uncle, [node]);
        else list.push(node);
      }
      const list = byNode.get(node);
      if (list === undefined) byNode.set(node, [cousin]);
      else list.push(cousin);
    }
  }
  return [byUncle, toCousin];
}

function descendantOf(node, ancestor) {
  while (node !== null) {
    if (node === ancestor) return true;
    if (node.container !== null) node = node.container;
    else if (node.cluster !== null) node = node.cluster.vessel;
    else if (node.sequence !== null) node = node.sequence.vessel;
    else node = null;
  }
  return ancestor === null;
}

/** SyncHerdFences updates the coordinate constraint for every assigned herd to the current graph boundary. */
export function syncHerdFences(graph) {
  const [topLeft, bottomRight] = graph.boundingBox();
  for (const node of graph.nodes) {
    if (node.herdAssignment === null || node.fixedTopLeft !== null) continue;
    switch (node.herdAssignment.orientation) {
      case Orientation.Top:
        node.herdAssignment.val = topLeft.y;
        break;
      case Orientation.Bottom:
        node.herdAssignment.val = bottomRight.y;
        break;
      case Orientation.Left:
        node.herdAssignment.val = topLeft.x;
        break;
      case Orientation.Right:
        node.herdAssignment.val = bottomRight.x;
        break;
    }
  }
}
