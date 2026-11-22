// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of the Go package d2layouts/d2talalayout/internal/routing (D2 v0.9.0), file(s): tunnel.go.

import * as geo from '../../geo.js';
import { goRound } from '../../gomath.js';
import { STEP_WEDGE_WIDTH } from '../../shape.js';
import { segmentSpacingBuffer } from './tuning.js';

export class TunnelEntry {
  constructor(node, ovgNode) {
    this.node = node;
    this.ovgNode = ovgNode;
  }
}

export function newTunnelEntry(node, ovgNode) {
  // Tunnel endpoints are unrestricted ports. Register their owner when the entry is created so every production port uses the same
  // per-owner metadata representation before OVG canonicalization.
  ovgNode.addPortMetadata(node, { directions: 0, isCenterPort: false });
  return new TunnelEntry(node, ovgNode);
}

export class Tunnel {
  constructor(entryA, entryB) {
    this.entryA = entryA;
    this.entryB = entryB;
  }
}

export function newTunnel(entryA, entryB) {
  return new Tunnel(entryA, entryB);
}

export class Range {
  constructor(start, end) {
    this.start = start;
    this.end = end;
  }

  length() {
    return this.end - this.start;
  }
}

/** tunnelRangesBetween(g, nodeA, nodeB, filterOutShortTunnels, guard: OvgBuildGuard): [ranges | null, visibleHorizontally] */
export function tunnelRangesBetween(g, nodeA, nodeB, filterOutShortTunnels, guard) {
  guard.check();
  return tunnelRangesBetweenChecked(
    g,
    nodeA,
    nodeB,
    filterOutShortTunnels,
    () => guard.step(),
    () => guard.check(),
    (descendant, ancestor) => guard.isDescendantOf(descendant, ancestor),
  );
}

/** tunnelRangesBetweenGuarded(g, nodeA, nodeB, filterOutShortTunnels, guard: RouteWorkGuard) */
export function tunnelRangesBetweenGuarded(g, nodeA, nodeB, filterOutShortTunnels, guard) {
  return tunnelRangesBetweenChecked(
    g,
    nodeA,
    nodeB,
    filterOutShortTunnels,
    () => guard.step(),
    () => guard.check(),
    (descendant, ancestor) => isDescendantOfWithRouteGuard(descendant, ancestor, guard),
  );
}

export function isDescendantOfWithRouteGuard(descendant, ancestor, guard) {
  for (let current = descendant; ;) {
    guard.step();
    if (ancestor === current) return true;
    if (current === null) return false;
    if (current.container !== null) current = current.container;
    else if (current.cluster !== null) current = current.cluster.vessel;
    else if (current.sequence !== null) current = current.sequence.vessel;
    else return ancestor === null;
  }
}

/** Returns [ranges, visibleHorizontally]; `ranges` is null where Go returns a nil slice. */
export function tunnelRangesBetweenChecked(g, nodeA, nodeB, filterOutShortTunnels, step, check, isDescendant) {
  step();
  const visibleHorizontally = nodeA.visibilityGraphCandidate(true, false, true, nodeB, 0);
  let visibleVertically = false;
  if (!visibleHorizontally) {
    step();
    visibleVertically = nodeA.visibilityGraphCandidate(false, false, true, nodeB, 0);
    if (!visibleVertically) return [null, false];
  }

  let ranges;
  {
    let start, end;
    if (visibleHorizontally) {
      start = Math.max(nodeA.topLeft.y, nodeB.topLeft.y);
      end = Math.min(nodeA.topLeft.y + nodeA.height, nodeB.topLeft.y + nodeB.height);
    } else {
      let nodeARight = nodeA.topLeft.x + nodeA.width;
      let nodeBRight = nodeB.topLeft.x + nodeB.width;

      // sequence nodes have shorter ranges along Top/Bottom (except last node in sequence)
      if (nodeA.sequence !== null && nodeA.sequence.last() !== nodeA) nodeARight -= STEP_WEDGE_WIDTH;
      if (nodeB.sequence !== null && nodeB.sequence.last() !== nodeB) nodeBRight -= STEP_WEDGE_WIDTH;

      start = Math.max(nodeA.topLeft.x, nodeB.topLeft.x);
      end = Math.min(nodeARight, nodeBRight);
    }
    step();
    ranges = [new Range(start, end)];
  }

  for (const otherN of g.nodes) {
    step();
    if (otherN === nodeA || otherN === nodeB) continue;
    const otherBelowA = isDescendant(otherN, nodeA);
    const aBelowOther = isDescendant(nodeA, otherN);
    const otherBelowB = isDescendant(otherN, nodeB);
    const bBelowOther = isDescendant(nodeB, otherN);
    if (otherBelowA || aBelowOther || otherBelowB || bBelowOther) continue;

    // We're reusing a function that assumes order, so the different order matters
    if (otherN.isBlocked(nodeA, nodeB, true, visibleHorizontally) || otherN.isBlocked(nodeB, nodeA, true, visibleHorizontally)) {
      return [null, false];
    }
    // Skip ones not in between
    if (visibleHorizontally) {
      if (!((nodeA.topLeft.x < otherN.topLeft.x && otherN.topLeft.x < nodeB.topLeft.x) ||
        (nodeB.topLeft.x < otherN.topLeft.x && otherN.topLeft.x < nodeA.topLeft.x))) {
        continue;
      }
    } else if (!((nodeA.topLeft.y < otherN.topLeft.y && otherN.topLeft.y < nodeB.topLeft.y) ||
      (nodeB.topLeft.y < otherN.topLeft.y && otherN.topLeft.y < nodeA.topLeft.y))) {
      continue;
    }

    let newRanges = [];
    // For every range, a partial obstruction can do one of the following
    // (a) delete it entirely (it obscures the whole range)
    // (b) split it into 2 (it obscures a middle subrange of a range)
    // (c) shorten it (it obscures a non-middle subrange)
    // (d) nothing (it doesn't overlap with any ranges)
    for (const r of ranges) {
      step();
      if (visibleHorizontally) {
        // (a)
        if (otherN.topLeft.y <= r.start && (otherN.topLeft.y + otherN.height) >= r.end) continue;
        // (b)
        if (otherN.topLeft.y > r.start && (otherN.topLeft.y + otherN.height) < r.end) {
          newRanges.push(new Range(r.start, otherN.topLeft.y), new Range(otherN.topLeft.y + otherN.height, r.end));
          continue;
        }
        // (c) obscures start
        if (otherN.topLeft.y <= r.start && (otherN.topLeft.y + otherN.height) < r.end && (otherN.topLeft.y + otherN.height) > r.start) {
          newRanges.push(new Range(otherN.topLeft.y + otherN.height, r.end));
          continue;
        }
        // (c) obscures end
        if (otherN.topLeft.y > r.start && (otherN.topLeft.y + otherN.height) >= r.end && otherN.topLeft.y < r.end) {
          newRanges.push(new Range(r.start, otherN.topLeft.y));
          continue;
        }

        // (d)
        newRanges.push(r);
      } else {
        if (otherN.topLeft.x <= r.start && (otherN.topLeft.x + otherN.width) >= r.end) continue;
        if (otherN.topLeft.x > r.start && (otherN.topLeft.x + otherN.width) < r.end) {
          newRanges.push(new Range(r.start, otherN.topLeft.x), new Range(otherN.topLeft.x + otherN.width, r.end));
          continue;
        }
        if (otherN.topLeft.x <= r.start && (otherN.topLeft.x + otherN.width) < r.end && (otherN.topLeft.x + otherN.width) > r.start) {
          newRanges.push(new Range(otherN.topLeft.x + otherN.width, r.end));
          continue;
        }
        if (otherN.topLeft.x > r.start && (otherN.topLeft.x + otherN.width) >= r.end && otherN.topLeft.x < r.end) {
          newRanges.push(new Range(r.start, otherN.topLeft.x));
          continue;
        }
        newRanges.push(r);
      }
    }
    ranges = [];
    check();
    // Filter out the ranges that are too short for even one tunnel
    for (const s of newRanges) {
      step();
      if (!filterOutShortTunnels || s.length() >= segmentSpacingBuffer) ranges.push(s);
    }
  }

  return [ranges, visibleHorizontally];
}

export function buildTunnelsBetween(g, nodeA, nodeB, guard) {
  guard.check();
  const aBelowB = guard.isDescendantOf(nodeA, nodeB);
  const bBelowA = guard.isDescendantOf(nodeB, nodeA);
  if (aBelowB || bBelowA) return null;
  const [ranges, visibleHorizontally] = tunnelRangesBetween(g, nodeA, nodeB, true, guard);
  if (ranges === null) return null;

  let numEdgesToFit = 0.0;
  for (const otherE of nodeA.edges) {
    guard.step();
    if (nodeA.adjacent(otherE) === nodeB) numEdgesToFit++;
  }

  const tunnels = [];
  for (const r of ranges) {
    guard.step();
    if (visibleHorizontally) {
      const numTunnelsFit = Math.min(Math.floor((r.end - r.start) / segmentSpacingBuffer), numEdgesToFit);

      for (let i = 1.0; i <= numTunnelsFit; i++) {
        guard.step();
        const val = goRound(r.start + i * (r.end - r.start) / (numTunnelsFit + 1));
        const nodeAEntry = guard.newDerivedNode(geo.newPoint(0, val));
        const nodeBEntry = guard.newDerivedNode(geo.newPoint(0, val));
        guard.step();
        const tunnel = newTunnel(newTunnelEntry(nodeA, nodeAEntry), newTunnelEntry(nodeB, nodeBEntry));
        if (nodeA.topLeft.x > nodeB.topLeft.x) {
          tunnel.entryA.ovgNode.point.x = nodeA.topLeft.x;
          tunnel.entryB.ovgNode.point.x = nodeB.topLeft.x + nodeB.width;
        } else {
          tunnel.entryA.ovgNode.point.x = nodeA.topLeft.x + nodeA.width;
          tunnel.entryB.ovgNode.point.x = nodeB.topLeft.x;
        }
        tunnels.push(tunnel);
        numEdgesToFit--;
      }
    } else {
      const numTunnelsFit = Math.min(Math.floor((r.end - r.start) / segmentSpacingBuffer), numEdgesToFit);

      for (let i = 1.0; i <= numTunnelsFit; i++) {
        guard.step();
        const val = goRound(r.start + i * (r.end - r.start) / (numTunnelsFit + 1));
        const nodeAEntry = guard.newDerivedNode(geo.newPoint(val, 0));
        const nodeBEntry = guard.newDerivedNode(geo.newPoint(val, 0));
        guard.step();
        const tunnel = newTunnel(newTunnelEntry(nodeA, nodeAEntry), newTunnelEntry(nodeB, nodeBEntry));
        if (nodeA.topLeft.y > nodeB.topLeft.y) {
          tunnel.entryA.ovgNode.point.y = nodeA.topLeft.y;
          tunnel.entryB.ovgNode.point.y = nodeB.topLeft.y + nodeB.height;
        } else {
          tunnel.entryA.ovgNode.point.y = nodeA.topLeft.y + nodeA.height;
          tunnel.entryB.ovgNode.point.y = nodeB.topLeft.y;
        }
        tunnels.push(tunnel);
        numEdgesToFit--;
      }
    }
  }
  return tunnels;
}

export function buildTunnels(g, guard) {
  guard.check();
  const out = [];
  const specialNodes = new Set();
  for (const c of g.clusters.values()) {
    guard.step();
    for (const cn of c.nodes) {
      guard.step();
      specialNodes.add(cn);
    }
  }
  if (g.nodeToTree !== null) {
    for (const n of g.nodeToTree.keys()) {
      guard.step();
      specialNodes.add(n);
    }
  }

  const searched = new Map(); // Map<Node, Map<Node, boolean>>
  for (const n of g.nodes) {
    guard.step();
    if (specialNodes.has(n)) continue;
    if (n.isTable()) {
      // no tunnels for tables
      continue;
    }
    if (!searched.has(n)) searched.set(n, new Map());
    for (const e of n.edges) {
      guard.step();
      const adj = n.adjacent(e);
      if (adj === n) continue;
      if (specialNodes.has(adj)) continue;
      if (!searched.has(adj)) searched.set(adj, new Map());
      if (searched.get(n).has(adj)) continue;
      searched.get(n).set(adj, true);
      searched.get(adj).set(n, true);

      const tunnels = buildTunnelsBetween(g, n, adj, guard);
      if (tunnels !== null) out.push(...tunnels);
    }
  }

  return out;
}
