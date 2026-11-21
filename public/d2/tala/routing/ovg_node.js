// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of the Go package d2layouts/d2talalayout/internal/routing (D2 v0.9.0), file(s): ovg_node.go.
//
// OVGNode embeds *geo.Point in Go: `node.point` is the shared point, `node.x` and `node.y` read and write it. Port metadata per owner
// is { directions: portDirectionSet (a number: a bitmask over geo.Orientation TopLeft..NONE), isCenterPort }; Go's portDirectionSet
// methods are the free functions directionsHas, directionsAny and directionsTransformed.

import * as geo from '../../geo.js';

const { Orientation } = geo;

// A rounded OVG coordinate can represent more than one side of the same node. A 1x1 square, for example, has top and left snap
// points at the same point. Keep every valid role instead of letting the last side overwrite the first.
export function newPortDirectionSet(direction) {
  if (direction < Orientation.TopLeft || direction > Orientation.NONE) return 0;
  return 1 << direction;
}

export function directionsHas(directions, direction) {
  return (directions & newPortDirectionSet(direction)) !== 0;
}

/** any reports whether predicate accepts at least one represented direction. Empty metadata is unrestricted and therefore behaves like NONE. */
export function directionsAny(directions, predicate) {
  if (directions === 0) return predicate(Orientation.NONE);
  for (let direction = Orientation.TopLeft; direction <= Orientation.NONE; direction++) {
    if (directionsHas(directions, direction) && predicate(direction)) return true;
  }
  return false;
}

export function directionsTransformed(directions, transform) {
  let transformed = 0;
  directionsAny(directions, (direction) => {
    transformed |= newPortDirectionSet(transform(direction));
    return false;
  });
  return transformed;
}

export class OVGNode {
  constructor(p) {
    // Edges grows lazily. A large share of candidate visibility nodes are rejected before connection.
    this.point = p;
    this.edges = [];
    this.isNearPort = null; // Set<Node> | null
    // portOwnersByNode keeps port metadata per graph node. More than one graph node can legitimately have a port at the same
    // coordinate (for example, two shapes whose borders touch). The OVG canonicalizes nodes by coordinate, so a single owner and
    // direction cannot describe that point correctly.
    this.portOwnersByNode = null; // Map<Node, {directions, isCenterPort}> | null
    this.container = null;
    this.index = 0;
    this.isNodeCenter = false;
    this.isTunnel = false;
  }

  get x() { return this.point.x; }
  set x(v) { this.point.x = v; }
  get y() { return this.point.y; }
  set y(v) { this.point.y = v; }

  ensurePortOwners() {
    if (this.portOwnersByNode === null) this.portOwnersByNode = new Map();
  }

  addPortMetadata(owner, added) {
    if (owner === null) return;
    this.ensurePortOwners();

    const old = this.portOwnersByNode.get(owner);
    const metadata = old === undefined ? { directions: 0, isCenterPort: false } : { directions: old.directions, isCenterPort: old.isCenterPort };
    metadata.directions |= added.directions;
    metadata.isCenterPort = metadata.isCenterPort || added.isCenterPort;
    this.portOwnersByNode.set(owner, metadata);
  }

  addPortOwner(owner, direction, isCenterPort) {
    this.addPortMetadata(owner, { directions: newPortDirectionSet(direction), isCenterPort });
  }

  setCenterPort(owner) {
    const found = this.portMetadataFor(owner);
    if (found === undefined) return;
    this.addPortMetadata(owner, { directions: found.directions, isCenterPort: true });
  }

  /** portMetadataFor returns the metadata object or undefined (Go: (metadata, ok)). */
  portMetadataFor(owner) {
    if (this.portOwnersByNode === null) return undefined;
    return this.portOwnersByNode.get(owner);
  }

  isPort() {
    return this.portOwnersByNode !== null && this.portOwnersByNode.size > 0;
  }

  isPortOf(owner) {
    return this.portMetadataFor(owner) !== undefined;
  }

  /** portDirectionsFor returns [directions, ok]. */
  portDirectionsFor(owner) {
    const metadata = this.portMetadataFor(owner);
    return metadata === undefined ? [0, false] : [metadata.directions, true];
  }

  hasPortDirection(owner, direction) {
    const [directions, ok] = this.portDirectionsFor(owner);
    return ok && directionsHas(directions, direction);
  }

  portDirectionsForObstacle(owner) {
    return this.portDirectionsFor(owner)[0];
  }

  setPortDirections(owner, directions) {
    const metadata = this.portMetadataFor(owner);
    if (metadata === undefined) return;
    this.ensurePortOwners();
    this.portOwnersByNode.set(owner, { directions, isCenterPort: metadata.isCenterPort });
  }

  isCenterPortOf(owner) {
    const metadata = this.portMetadataFor(owner);
    return metadata !== undefined && metadata.isCenterPort;
  }

  portOwners() {
    return this.portOwnersByNode === null ? new Map() : this.portOwnersByNode;
  }

  sharesPortOwner(other) {
    if (this == null || other == null) return false;
    for (const owner of this.portOwners().keys()) {
      if (other.isPortOf(owner)) return true;
    }
    return false;
  }

  addEdge(e) {
    this.edges.push(e);
  }

  adjacent_(e) {
    if (this === e.from) return e.to;
    return e.from;
  }

  adjacent(edge) { return this.adjacent_(edge); }

  /**
   * hasUnobstructedLineToPorts checks if an OVG node has unobstructed lines to non-container ports. numNodes indicates how many
   * ports belonging to different nodes it must have lines to.
   */
  hasUnobstructedLineToPorts(ovg, portIndex, numNodes, guard) {
    guard.check();
    // Only care about ovg nodes which are port aligned
    let distinctPortNodeCount = 0;

    const aligned = portIndex.alignedOwners(this.x, this.y);
    const hasAlignedPort = aligned.byX.length > 0 || aligned.byY.length > 0;
    for (;;) {
      const [ownerIndex, ok] = aligned.next(guard);
      if (!ok) break;
      const gNode = portIndex.owners[ownerIndex];
      const portNodes = ovg.ports.get(gNode);
      for (const portNode of portNodes) {
        guard.step();
        if (portNode.x !== this.x && portNode.y !== this.y) continue;
        // Port nodes which can make a straight line between it, its shape's edge, and the point, are NOT candidates for
        // unobstructed path (a port on the same side line as the point)
        if (portNode.x === this.x && ((portNode.x === gNode.topLeft.x) || (portNode.x === gNode.topLeft.x + gNode.width))) continue;
        if (portNode.y === this.y && ((portNode.y === gNode.topLeft.y) || (portNode.y === gNode.topLeft.y + gNode.height))) continue;

        // Remove nodes which are obstructed from a port by another node
        let hasDirectLineToThisPort = true;
        let blockers = portIndex.horizontalBlockers.get(portNode.y);
        if (portNode.x === this.x) blockers = portIndex.verticalBlockers.get(portNode.x);
        if (blockers === undefined) blockers = [];
        for (const otherGNode of blockers) {
          guard.step();
          if (gNode === otherGNode) continue;
          if (gNode.isInvisible) continue;
          // don't count nodes of the same sequence as blocking each other
          if (gNode.sequence !== null && otherGNode.sequence !== null && gNode.sequence === otherGNode.sequence) continue;
          if (otherGNode.passesThrough(portNode.point, this.point)) {
            hasDirectLineToThisPort = false;
            break;
          }
        }

        if (hasDirectLineToThisPort) {
          distinctPortNodeCount++;
          if (distinctPortNodeCount === numNodes) return true;
          break;
        }
      }
    }

    guard.check();
    return !hasAlignedPort;
  }

  distanceToBoundary(nodeB) {
    const x1 = this.point.x;
    const y1 = this.point.y;

    const x2 = nodeB.topLeft.x;
    const y2 = nodeB.topLeft.y;
    const x2b = nodeB.topLeft.x + nodeB.width;
    const y2b = nodeB.topLeft.y + nodeB.height;

    const left = x2b < x1;
    const right = x1 < x2;
    const top = y2b < y1;
    const bottom = y1 < y2;

    if (top && left) return geo.euclideanDistance(x1, y1, x2b, y2b);
    else if (left && bottom) return geo.euclideanDistance(x1, y1, x2b, y2);
    else if (bottom && right) return geo.euclideanDistance(x1, y1, x2, y2);
    else if (right && top) return geo.euclideanDistance(x1, y1, x2, y2b);
    else if (left) return x1 - x2b;
    else if (right) return x2 - x1;
    else if (bottom) return y2 - y1;
    else if (top) return y1 - y2b;
    return 0;
  }
}

export function newOVGNode(p) {
  return new OVGNode(p);
}
