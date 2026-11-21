// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of the Go package d2layouts/d2talalayout/internal/packing (D2 v0.9.0): it arranges and compacts disconnected graph
// components without changing their internal layout or routed edge geometry (BinPack, pipeline stages 18 and 32) and combines laid-out
// subgraphs for node placement (CombineSubgraphs). Line for line from binpack.go, guard.go, routed_container.go, combine.go,
// combine_snapshot.go and snapshot.go. Conventions: see layoutgraph.js and docs/d2-tala-port.md (errors are thrown, Go pointers are
// references, `x.copy()` is a Go value copy). The spare slice capacity that Go's exact-slice snapshots preserve does not exist for JS
// arrays, so CombineSubgraphs' snapshots restore the visible elements only.

import * as geo from '../geo.js';
import { goRound, goPow } from '../gomath.js';
import { utf8Len } from '../ast.js';
import { parseFloat64 } from '../strconv.js';
import { sortSlice } from '../gosort.js';
import * as lg from './layoutgraph.js';
import * as limits from './limits.js';
import * as invariant from './invariant.js';
import * as graphbounds from './graphbounds.js';
import { errorf, isPanic } from './goerrors.js';

const subgraphPadding = 20.0;
const subgraphSquareDampener = 0.5;

const Orientation = geo.Orientation;

// ---- snapshot.go: pointerSnapshot[geo.Point] ----

/** snapshotPointer: a pointer and a copy of what it points to (a nil pointer gives the zero value). */
function snapshotPointer(pointer) {
  if (pointer === null || pointer === undefined) return { pointer: null, value: new geo.Point(0, 0) };
  return { pointer, value: pointer.copy() };
}

/** restore writes the copy back into the same object and returns it (null for a nil snapshot). */
function restorePointerSnapshot(snapshot) {
  if (snapshot.pointer === null) return null;
  snapshot.pointer.x = snapshot.value.x;
  snapshot.pointer.y = snapshot.value.y;
  return snapshot.pointer;
}

// ---- binpack.go ----

/**
 * Pack recursively arranges disconnected subgraphs into compact containers. Containers may shrink but never grow, and packing may
 * interleave subgraph bounding boxes while preserving edge lengths. Hierarchy subgraphs remain separate to avoid obstructing routes.
 */
export function pack(ctx, g, root) {
  const guard = newWorkGuard(ctx, limits.MaxBinPackWorkUnits);
  packAtomic(ctx, g, root, guard);
}

/** Pack with a chosen work limit; returns the work units used (a thrown GoError carries them in `used`): the harness's XPackLimit. */
export function packWithLimit(ctx, g, root, limit) {
  const guard = newWorkGuard(ctx, limit);
  try {
    packAtomic(ctx, g, root, guard);
  } catch (e) {
    if (e && e.name === 'GoError') e.used = guard.used();
    throw e;
  }
  return guard.used();
}

function packAtomic(ctx, g, root, guard) {
  if (guard === null) throw errorf('TALA BinPack requires a work guard');
  ctx = lg.contextWithTransactionWorkGuard(ctx, guard);
  const state = lg.newGraphStateSnapshot({ captureEdgeRoutes: true });
  state.updateWithWorkGuard(g, guard);
  const snapshot = new lg.Transaction();
  snapshot.graph = g;
  snapshot.priorGraphState = state;
  let complete = false;
  try {
    packGuarded(ctx, g, root, guard);
    guard.finish();
    complete = true;
  } catch (recovered) {
    // defer: a panic and an incomplete run both roll back (a panic is then re-raised, an error is returned)
    snapshot.rollback();
    throw recovered;
  }
  if (!complete) snapshot.rollback();
}

function containersAt(g, root) {
  const children = g.containers.get(root);
  return children === undefined ? [] : children;
}

function packGuarded(ctx, g, root, guard) {
  const checkCanceled = () => guard.step();
  checkCanceled();
  const [edgesPlaced, graphIncidentEdges] = allEdgesHaveCompleteRoutesGuarded(g, root, guard);

  // Pack more nested before less nested
  for (const n of containersAt(g, root)) {
    checkCanceled();
    if (n.isContainer()) packGuarded(ctx, g, n, guard);
  }
  // For this container level, split subgraphs into 3 categories:
  // 0. Fixed nodes and their subgraphs cannot move
  // 1. Cross-container subgraphs (have edges to another container) cannot move
  // 2. Contained subgraphs can move
  const crossContainerSubgraphs = [];
  const containedSubgraphs = [];
  const added = new Set();

  // we create the fixedNodesSubgraph first to ensure no subgraph with a fixed node is packed
  // for simplicity we add all nodes to the fixedNodesSubgraph list instead of creating one for each fixed subgraph
  const fixedNodesSubgraph = [];
  for (const n of containersAt(g, root)) {
    checkCanceled();
    if (n.fixedTopLeft === null) continue;

    const reachable = n.allReachableNodesContext(true, true, false, new Set([root]), guard);
    for (const rn of reachable) {
      guard.step();
      if (!added.has(rn)) fixedNodesSubgraph.push(rn);
      added.add(rn);
    }
  }

  let visitErr = null;
  let shouldVisit = () => true;
  if (root !== null) {
    shouldVisit = (n) => {
      if (visitErr !== null) return false;
      let inside;
      try {
        inside = binPackIsDescendantOf(n, root, guard);
      } catch (e) {
        if (isPanic(e)) throw e;
        visitErr = e;
        return false;
      }
      return inside;
    };
  }

  // 1. get subgraphs contained in root
  // 2. get subgraphs not contained in root
  // 3. filter out subgraphs contained in root from subgraphs not contained in root
  const contained = new Set();
  for (const n of containersAt(g, root)) {
    checkCanceled();
    if (added.has(n)) continue;

    const reachable = n.reachableNodesContext(shouldVisit, true, true, false, new Set([root]), guard);
    if (visitErr !== null) throw visitErr;
    let cross = false;
    for (const rn of reachable) {
      guard.step();
      if (rn.hierarchy !== null) {
        cross = true;
        break;
      }
      const hasExternalEdge = binPackHasExternalConnection(g, rn, root, false, edgesPlaced, guard);
      if (hasExternalEdge) {
        cross = true;
        break;
      }
      const hasExternalNear = binPackHasExternalConnection(g, rn, root, true, false, guard);
      if (hasExternalNear) {
        cross = true;
        break;
      }
    }
    if (!cross) {
      for (const rn of reachable) {
        guard.step();
        added.add(rn);
        contained.add(rn);
      }
      containedSubgraphs.push(reachable);
    }
  }
  for (const n of containersAt(g, root)) {
    checkCanceled();
    if (added.has(n)) continue;
    const filtered = [];
    const allReachable = n.allReachableNodesContext(true, false, false, new Set([root]), guard);
    for (const rn of allReachable) {
      guard.step();
      if (contained.has(rn)) continue;
      filtered.push(rn);
    }

    for (const rn of filtered) {
      guard.step();
      added.add(rn);
    }
    crossContainerSubgraphs.push(filtered);
  }

  if (containedSubgraphs.length === 0) {
    checkCanceled();
    return;
  }

  let packed = crossContainerSubgraphs;
  let toPack = containedSubgraphs;

  if (fixedNodesSubgraph.length > 0) packed.push(fixedNodesSubgraph);

  const rootTL = binPackContainerTopLeft(g, root, toPack[0], guard);

  const originalScore = binPackScoreGuarded(containersAt(g, root), root, guard);
  const originalPos = new Map();
  const originalPosOrder = [];
  const originalRoute = new Map();
  const originalRouteOrder = [];
  const returnIfCanceled = () => checkCanceled();

  // Move out of the way
  for (const ns of toPack) {
    guard.step();
    for (const n of ns) {
      guard.step();
      if (!originalPos.has(n)) {
        originalPos.set(n, snapshotPointer(n.topLeft));
        originalPosOrder.push(n);
      }
      n.translate(100000, 100000);
      if (edgesPlaced) {
        for (const e of n.edges) {
          guard.step();
          if (originalRoute.has(e)) continue;
          const route = [];
          for (const p of e.points) {
            guard.step();
            route.push(p.copy());
          }
          originalRoute.set(e, route);
          originalRouteOrder.push(e);
        }
      }
    }
  }

  if (packed.length === 0) {
    const [currTL] = graphbounds.boundingBox(toPack[0], guard);
    const offsetX = rootTL.x - currTL.x;
    const offsetY = rootTL.y - currTL.y;
    for (const n of toPack[0]) {
      guard.step();
      n.translate(offsetX, offsetY);
    }
    if (edgesPlaced) {
      const moved = new Set();
      for (const n of toPack[0]) {
        guard.step();
        for (const e of n.edges) {
          guard.step();
          if (moved.has(e)) continue;
          moved.add(e);
          for (const p of e.points) {
            guard.step();
            p.x += (n.topLeft.x - originalPos.get(n).value.x);
            p.y += (n.topLeft.y - originalPos.get(n).value.y);
          }
        }
      }
    }
    packed = [toPack[0]];
    toPack = toPack.slice(1);
  }
  returnIfCanceled();

  let packedRootChildren = [];
  let packedSegments = [];
  // If edges are already placed, use their actual routes
  // Otherwise consider multiple possible good routes
  if (edgesPlaced) {
    const edges = [];
    const unique = new Set();
    for (const ns of packed) {
      guard.step();
      for (const n of ns) {
        guard.step();
        if (n === root) continue;
        const inside = binPackIsDescendantOf(n, root, guard);
        if (!inside) continue;
        for (const e of n.edges) {
          guard.step();
          if (!unique.has(e)) {
            unique.add(e);
            edges.push(e);
          }
        }
      }
    }
    const hSegments = routedEdgeSegments(edges, true, guard);
    const vSegments = routedEdgeSegments(edges, false, guard);
    for (const s of hSegments) {
      guard.step();
      packedSegments.push(s);
    }
    for (const s of vSegments) {
      guard.step();
      packedSegments.push(s);
    }
    for (const ns of packed) {
      guard.step();
      for (const n of ns) {
        guard.step();
        if (n.container === root) packedRootChildren.push(n);
      }
    }
  } else {
    packedSegments = [];
    for (const ns of packed) {
      guard.step();
      for (const n of ns) {
        guard.step();
        if (n.container === root) packedRootChildren.push(n);
      }
      const [xd, yd] = binPackSmallestDeltas(toPack, guard);

      // We only care about segments of packed nodes that are descendants of root
      // There's no chance of collision of a subgraph with a more nested node or less nested node
      const filtered = [];
      for (const n of ns) {
        guard.step();
        if (n === root) continue;
        const inside = binPackIsDescendantOf(n, root, guard);
        if (inside) filtered.push(n);
      }
      const segments = estimateRouteSegments(filtered, g, xd, yd, guard);
      for (const segment of segments) {
        guard.step();
        packedSegments.push(segment);
      }
    }
  }

  const occupied = new lg.PointMap();

  let canMoveLeft = true;
  let canMoveRight = true;
  let canMoveTop = true;
  let canMoveBottom = true;

  if (edgesPlaced && root !== null) {
    for (const e of root.edges) {
      guard.step();
      let seg;
      if (e.from === root) {
        seg = geo.newSegment(e.points[0], e.points[1]);
      } else {
        seg = geo.newSegment(e.points[e.points.length - 1], e.points[e.points.length - 2]);
      }
      if (seg.Start.y === seg.End.y) {
        if (seg.Start.x < seg.End.x) canMoveRight = false;
        if (seg.Start.x > seg.End.x) canMoveLeft = false;
      } else if (seg.Start.x === seg.End.x) {
        if (seg.Start.y < seg.End.y) canMoveBottom = false;
        if (seg.Start.y > seg.End.y) canMoveTop = false;
      } else {
        // It's a diagonal line, can't risk any movement
        canMoveRight = false;
        canMoveLeft = false;
        canMoveTop = false;
        canMoveBottom = false;
        break;
      }
    }
  }

  let failed = false;
  // place greedily
  // TODO perhaps there's better algorithms here
  // Maybe we can multithread race some random orders and get the best scored one
  while (toPack.length > 0) {
    returnIfCanceled();
    const candidates = [];
    const set = new lg.PointMap();
    const hierarchyBoxes = binPackHierarchyBoxes(packed, guard);

    const tl = geo.newPoint(rootTL.x, rootTL.y);
    if (!set.has(tl)) {
      candidates.push(tl);
      set.set(tl, true);
    }

    let packedTLX = Infinity;
    let packedTLY = Infinity;
    for (const ns of packed) {
      guard.step();
      const [tl2] = graphbounds.boundingBox(ns, guard);
      packedTLX = Math.min(packedTLX, tl2.x);
      packedTLY = Math.min(packedTLY, tl2.y);
      const canPlaceWithin = ns[0].hierarchy === null;
      const placementCandidates = placementCandidatesGuarded(ns, root, canPlaceWithin, edgesPlaced, guard);
      for (const p of placementCandidates) {
        guard.step();
        if (occupied.has(p)) continue;
        const insideHierarchy = binPackPointInHierarchy(hierarchyBoxes, p, guard);
        if (insideHierarchy) continue;
        if (!set.has(p)) {
          candidates.push(p);
          set.set(p, true);
        }
      }
    }

    const currPacking = toPack[0];
    toPack = toPack.slice(1);
    const [currPackingTL, currPackingBR] = graphbounds.fixedBoundingBox(currPacking, guard);
    const currPackingWidth = currPackingBR.x - currPackingTL.x;
    const currPackingHeight = currPackingBR.y - currPackingTL.y;

    // TODO ideally the placement candidates should also take into account which direction it can move
    if (canMoveTop) candidates.push(geo.newPoint(packedTLX, packedTLY - currPackingHeight - subgraphPadding));
    if (canMoveLeft) candidates.push(geo.newPoint(packedTLX - currPackingWidth - subgraphPadding, packedTLY));
    if (canMoveTop && canMoveLeft) {
      candidates.push(geo.newPoint(packedTLX - currPackingWidth - subgraphPadding, packedTLY - currPackingHeight - subgraphPadding));
    }

    const txn = g.newRequestTransaction(ctx, { ignoreContainerEscape: true, affectEdgeRoutes: edgesPlaced });

    const [currTL] = graphbounds.boundingBox(currPacking, guard);
    const packedWithCurr = [];
    for (const node of packedRootChildren) {
      guard.step();
      packedWithCurr.push(node);
    }
    for (const node of currPacking) {
      guard.step();
      packedWithCurr.push(node);
    }
    let bestScore = Infinity;

    for (const n of currPacking) {
      guard.step();
      const original = originalPos.get(n).value;
      const og = original.copy();
      if (!set.has(og)) {
        candidates.push(og);
        set.set(og, true);
      }
    }
    const [packedXD, packedYD] = binPackSmallestDeltas(packed, guard);

    let bestCandidate = null;
    for (const p of candidates) {
      returnIfCanceled();
      txn.clear();
      txn.addOp(() => {
        const offsetX = p.x - currTL.x;
        const offsetY = p.y - currTL.y;
        for (const n of currPacking) {
          guard.step();
          n.translate(offsetX, offsetY);
        }
      });
      try {
        txn.commit(ctx);
      } catch (err) {
        if (isPanic(err)) throw err;
        if (lg.isCandidateRejection(err)) {
          // TODO handle candidate overlap with the root before committing.
          continue;
        }
        checkCanceled();
        throw err;
      }
      // Not allowed to expand out of containers
      if (root !== null) {
        const packedInContainer = [];
        for (const n of packedWithCurr) {
          try {
            guard.step();
          } catch (e) {
            txn.rollback();
            throw e;
          }
          if (n.container === root) packedInContainer.push(n);
        }
        let tl3, br3;
        try {
          [tl3, br3] = graphbounds.boundingBox(packedInContainer, guard);
        } catch (e) {
          txn.rollback();
          throw e;
        }
        const w = br3.x - tl3.x, h = br3.y - tl3.y;
        const innerBox = root.innerBox();
        if (w > innerBox.Width || h > innerBox.Height) {
          txn.rollback();
          continue;
        }
      }
      if (!edgesPlaced) {
        // Not allowed for any node to go into the bounding box of a placed hierarchy
        let is = false;
        for (const n of currPacking) {
          let topLeftInside, bottomRightInside;
          try {
            const [tl4, br4] = graphbounds.nodeBoundingBox(n, null, guard);
            topLeftInside = binPackPointInHierarchy(hierarchyBoxes, tl4, guard);
            bottomRightInside = binPackPointInHierarchy(hierarchyBoxes, br4, guard);
          } catch (e) {
            txn.rollback();
            throw e;
          }
          if (topLeftInside || bottomRightInside) {
            is = true;
            break;
          }
        }
        if (is) {
          txn.rollback();
          continue;
        }
      }
      let blocked;
      try {
        blocked = blocksRoutesWithDeltasGuarded(g, currPacking, packed, packedSegments, packedXD, packedYD, guard);
      } catch (e) {
        txn.rollback();
        throw e;
      }
      if (blocked) {
        txn.rollback();
        continue;
      }
      let score;
      try {
        score = binPackScoreGuarded(packedWithCurr, root, guard);
      } catch (e) {
        txn.rollback();
        throw e;
      }
      if (score < bestScore) {
        bestScore = score;
        bestCandidate = p;
      }
      txn.rollback();
    }
    returnIfCanceled();

    if (bestCandidate === null) {
      failed = true;
      break;
    }

    txn.clear();
    txn.addOp(() => {
      const offsetX = bestCandidate.x - currTL.x;
      const offsetY = bestCandidate.y - currTL.y;
      for (const n of currPacking) {
        guard.step();
        n.translate(offsetX, offsetY);
      }
      if (edgesPlaced) {
        const moved = new Set();
        for (const n of currPacking) {
          guard.step();
          for (const e of n.edges) {
            guard.step();
            if (moved.has(e)) continue;
            moved.add(e);
            for (const p of e.points) {
              guard.step();
              p.x += (n.topLeft.x - originalPos.get(n).value.x);
              p.y += (n.topLeft.y - originalPos.get(n).value.y);
            }
          }
        }
      }
    });
    try {
      txn.commit(ctx);
    } catch (err) {
      if (isPanic(err)) throw err;
      checkCanceled();
      throw err;
    }
    occupied.set(bestCandidate, true);

    for (const node of currPacking) {
      guard.step();
      packedRootChildren.push(node);
    }
    packed.push(currPacking);
    const [xd, yd] = binPackSmallestDeltas(toPack, guard);

    if (edgesPlaced) {
      const edges = [];
      const unique = new Set();
      for (const n of currPacking) {
        guard.step();
        if (n === root) continue;
        const inside = binPackIsDescendantOf(n, root, guard);
        if (!inside) continue;
        for (const e of n.edges) {
          guard.step();
          if (!unique.has(e)) {
            unique.add(e);
            edges.push(e);
          }
        }
      }
      const hSegments = routedEdgeSegments(edges, true, guard);
      const vSegments = routedEdgeSegments(edges, false, guard);
      for (const s of hSegments) {
        guard.step();
        packedSegments.push(s);
      }
      for (const s of vSegments) {
        guard.step();
        packedSegments.push(s);
      }
    } else {
      const filtered = [];
      for (const n of currPacking) {
        guard.step();
        if (n === root) continue;
        const inside = binPackIsDescendantOf(n, root, guard);
        if (inside) filtered.push(n);
      }

      const segments = estimateRouteSegments(filtered, g, xd, yd, guard);
      for (const segment of segments) {
        guard.step();
        packedSegments.push(segment);
      }
    }
  }
  returnIfCanceled();

  let afterBinPackScore;
  if (failed) {
    afterBinPackScore = Infinity;
  } else {
    afterBinPackScore = binPackScoreGuarded(containersAt(g, root), root, guard);
  }
  if (originalScore < afterBinPackScore) {
    for (const node of originalPosOrder) {
      guard.step();
      node.topLeft = restorePointerSnapshot(originalPos.get(node));
    }
    binPackSyncClusters(g, guard);
    binPackSyncSequences(g, guard);
    failed = true;
  } else if (root !== null && root.cluster === null) {
    // record state to revert to if fitting to the children's packed position causes a bad state
    // we need to save positions of packed children not in toPack
    const descendants = g.allDescendantNodesWithWorkGuard(root, true, guard);
    for (const node of descendants) {
      guard.step();
      if (!originalPos.has(node)) {
        originalPos.set(node, snapshotPointer(node.topLeft));
        originalPosOrder.push(node);
      }
    }

    const rootX = root.topLeft.x;
    const rootY = root.topLeft.y;
    const rootWidth = root.width, rootHeight = root.height;
    const originalRootBox = new geo.Box(geo.newPoint(rootX, rootY), rootWidth, rootHeight);

    binPackWrapChildren(root, guard);
    let routedContainerHandled = false;
    if (edgesPlaced) {
      const decision = binPackCanUseRoutedContainerBox(g, root, originalRootBox, graphIncidentEdges, guard);
      switch (decision) {
        case routedContainerDeferToSideConstraints:
          break;
        case routedContainerUseProposedBox:
          routedContainerHandled = true;
          break;
        case routedContainerKeepOriginalBox:
          routedContainerHandled = true;
          // Unsupported shapes, detached endpoints, and route geometry cut
          // by the proposed shrink retain the exact routed box.
          root.topLeft.x = rootX;
          root.topLeft.y = rootY;
          root.width = rootWidth;
          root.height = rootHeight;
          break;
        default:
          throw errorf('TALA BinPack received an invalid routed-container decision');
      }
    }
    if (!routedContainerHandled) {
      if (!canMoveLeft) root.topLeft.x = rootX;
      if (!canMoveTop) root.topLeft.y = rootY;
      if (!canMoveRight) root.width = rootWidth;
      if (!canMoveBottom) root.height = rootHeight;
      // wrapChildren preserves the aspect ratio of circles and other square
      // shapes. Restoring one route-constrained side independently can break
      // that invariant, so retain the larger constrained dimension on both
      // axes. The child-fit and bad-state checks below still reject an unsafe
      // expansion and restore the complete original box.
      if (root.aspectRatio1()) {
        const size = Math.max(root.width, root.height);
        root.width = size;
        root.height = size;
      }
    }

    let childrenFit = true;
    const innerBox = root.innerBox();
    for (const child of containersAt(g, root)) {
      guard.step();
      if (!lg.covers(innerBox, child.box)) {
        childrenFit = false;
        break;
      }
    }
    const badState = g.isBadStateWithWorkGuard(root, null, false, guard);
    if (!childrenFit || badState) {
      for (const node of originalPosOrder) {
        guard.step();
        node.topLeft = restorePointerSnapshot(originalPos.get(node));
      }
      root.topLeft.x = rootX;
      root.topLeft.y = rootY;
      root.width = rootWidth;
      root.height = rootHeight;
      failed = true;
    }
  }
  // Transactions don't deal with edge routes, so rollback manually
  if (failed) {
    for (const edge of originalRouteOrder) {
      guard.step();
      const route = originalRoute.get(edge);
      for (let i = 0; i < route.length; i++) {
        guard.step();
        const p = route[i];
        edge.points[i].x = p.x;
        edge.points[i].y = p.y;
      }
    }
  }
  guard.finish();
}

/**
 * placementCandidates returns the candidate points in the graph that are suitable to pack more nodes/subgraphs at
 * if considerWithin is true, candidate points include points inside the bounding box of the graph
 * Currently (Sept 24, 2022), that is false during node placement stage and true for the more global packing stage.
 *
 * E.g., the "@" are always included
 * the "*" is included iff considerWithin is true
 * ┌─────────────┬───┬─*─────┐ @
 * │             │   │       │
 * │             └───┘ *     │
 * ├───┐ *       *           │
 * │   │                 ┌───┤ *
 * ├───┘ *               │   │
 * *                     └───┤ *
 * │      ┌───┐ *        *   │
 * │      │   │              │
 * └──────┴───┴─*────────────┘ @
 * @      *
 */
function placementCandidatesGuarded(nodes, root, considerWithin, edgesPlaced, guard) {
  const candidatePoints = [];
  const inContainer = [];
  for (const n of nodes) {
    guard.step();
    // Avoid placement points that'd move into different container
    if (n.container !== root) continue;
    inContainer.push(n);
    if (!considerWithin) continue;
    let sideDelta = subgraphPadding;
    if (n.isTable()) sideDelta = lg.TableNodeGap;
    if (edgesPlaced) {
      candidatePoints.push(geo.newPoint(n.topLeft.x + n.width + sideDelta, n.topLeft.y));
      candidatePoints.push(geo.newPoint(n.topLeft.x, n.topLeft.y + n.height + subgraphPadding));
      candidatePoints.push(geo.newPoint(n.topLeft.x + n.width + sideDelta, n.topLeft.y + n.height));
    } else {
      // Avoid placement points that are likely to cause obstructions
      let hasRight = false;
      let hasBottom = false;
      let hasBottomRight = false;
      for (const e of n.edges) {
        guard.step();
        const adj = n.adjacent(e);
        switch (n.orientation(adj)) {
          case Orientation.Left:
            hasRight = true;
            break;
          case Orientation.Top:
            hasBottom = true;
            break;
          case Orientation.TopLeft:
            hasBottomRight = true;
            break;
          default:
        }
        if (hasRight && hasBottom && hasBottomRight) break;
      }

      if (!hasRight) candidatePoints.push(geo.newPoint(n.topLeft.x + n.width + sideDelta, n.topLeft.y));
      if (!hasBottom) candidatePoints.push(geo.newPoint(n.topLeft.x, n.topLeft.y + n.height + subgraphPadding));
      if (!hasBottomRight) candidatePoints.push(geo.newPoint(n.topLeft.x + n.width + sideDelta, n.topLeft.y + n.height));
    }
  }

  const [graphTL, graphBR] = graphbounds.fixedBoundingBox(inContainer, guard);

  candidatePoints.push(geo.newPoint(graphBR.x, graphTL.y),
    geo.newPoint(graphBR.x, graphBR.y),
    geo.newPoint(graphTL.x, graphBR.y),
    geo.newPoint(graphBR.x + subgraphPadding, graphTL.y),
    geo.newPoint(graphBR.x + subgraphPadding, graphBR.y),
    geo.newPoint(graphTL.x, graphBR.y + subgraphPadding),
  );
  guard.finish();
  return candidatePoints;
}

/**
 * blocksRoutesWithDeltasGuarded checks if the given `packing` placement overlaps with some desired routes in `packed`
 * or if `packed` nodes overlap with routes in `packing`.
 * Desired routes are roughly estimated as L-shaped and S-shaped routes between connected nodes
 * For example, we want to avoid bin packing to the positions shown as `#` below
 * . ┌─────────┐
 * . │         │      #####
 * . │         ├──────#####
 * . └────┬────┘      #####
 * .      │               │
 * .      │          ┌────┴────┐
 * .      ####       │         │
 * .      ####───────┤         │
 * .      ####       └─────────┘
 * TODO: if top-right and bottom-left are available, it can overlap with one of them as it would be able
 * to generate a good route using the remaining one
 *
 * The function checks one candidate using the gaps for the immutable packed
 * set. BinPack evaluates many translations of the same
 * packing against that set, so its caller computes these deltas once per set
 * instead of rescanning every packed node for every candidate.
 */
function blocksRoutesWithDeltasGuarded(g, packing, packed, packedSegments, xd, yd, guard) {
  if (guard === null) throw errorf('TALA BinPack route check requires a work guard');
  const packingSegments = estimateRouteSegments(packing, g, xd, yd, guard);

  // check if `packed` nodes could block routes routes in `packing`
  for (const nodes of packed) {
    guard.step();
    for (const n of nodes) {
      guard.step();
      for (const seg of packingSegments) {
        guard.step();
        if (n.overlapsLine(seg.Start, seg.End, lg.NodeGap)) {
          guard.finish();
          return true;
        }
      }
    }
  }
  // check if `packing` nodes could block routes in `packed`
  for (const n of packing) {
    guard.step();
    for (const seg of packedSegments) {
      guard.step();
      if (n.overlapsLine(seg.Start, seg.End, lg.NodeGap)) {
        guard.finish();
        return true;
      }
    }
  }

  guard.finish();
  return false;
}

/** estimateRouteSegments generates all L-shaped and S-shaped estimates between connected nodes, sharing the complete BinPack operation's guard. */
function estimateRouteSegments(nodes, g, smallestXGap, smallestYGap, guard) {
  // just an estimate: 1 edge per node
  const segments = [];
  const unique = new Set();
  for (const n of nodes) {
    guard.step();
    for (const e of n.edges) {
      guard.step();
      if (unique.has(e)) continue;
      unique.add(e);
      const edgeSegments = estimateEdgeSegments(e, g, smallestXGap, smallestYGap, guard);
      for (const s of edgeSegments) segments.push(s);
    }
  }
  guard.finish();
  return segments;
}

function routedEdgeSegments(edges, isHorizontal, guard) {
  const out = [];
  for (const edge of edges) {
    guard.step();
    if (edge === null || edge === undefined) throw invariant.newError('BinPack routed segment scan encountered a nil edge');
    for (let index = 0; index < edge.points.length - 1; index++) {
      guard.step();
      const first = edge.points[index], second = edge.points[index + 1];
      if (first === null || second === null) throw invariant.newError('BinPack routed segment scan encountered a nil point');
      let start = null, end = null;
      if (isHorizontal) {
        if (first.y === second.y) {
          if (first.x < second.x) {
            start = first;
            end = second;
          } else {
            start = second;
            end = first;
          }
        }
      } else if (first.x === second.x) {
        if (first.y < second.y) {
          start = first;
          end = second;
        } else {
          start = second;
          end = first;
        }
      }
      if (start !== null && end !== null) out.push(lg.newEdgeSegment(start, end, edge));
    }
  }
  guard.finish();
  return out;
}

/**
 * estimateEdgeSegments generates horizontal and vertical segments for the given edge.
 * It only generates the segments for diagonal edges, as these are the ones that can have S/L-shaped routes.
 * There's an exception for cluster vessels, in which is is allowed to be vertical or horizontal.
 * (the ASCII art of the Go source: L-shaped estimates 1-4 and S-shaped estimates 5-10 between two connected nodes)
 */
function estimateEdgeSegments(e, g, smallestXGap, smallestYGap, guard) {
  guard.step();
  if (e === null || e.from === null || e.to === null || e.from.topLeft === null || e.to.topLeft === null) {
    throw invariant.newError('BinPack segment estimate encountered an incomplete edge');
  }
  const o = e.from.orientation(e.to);

  // Straight lines only matter if they're long (can potentially fit other subgraphs)
  if (!geo.isDiagonal(o) && !e.from.isClusterVessel() && !e.to.isClusterVessel()) {
    const from = e.from.center();
    const to = e.to.center();

    if (geo.isHorizontal(o)) {
      if (Math.abs(from.x - to.x) > smallestXGap) return [geo.newSegment(from, to)];
    }

    if (geo.isVertical(o)) {
      if (Math.abs(from.y - to.y) > smallestYGap) return [geo.newSegment(from, to)];
    }

    return [];
  }

  // for clusters, as they can be properly aligned vertically or horizontally
  // generate the segments using the endpoints depending on the arrangement
  const clusterEndpoints = (c) => {
    const center = c.vessel.center();
    const [tl, br] = c.vessel.boundingBox(null);
    if (c.arrangement === lg.Row) return [geo.newPoint(tl.x, center.y), geo.newPoint(br.x, center.y)];
    if (c.arrangement === lg.Column) return [geo.newPoint(center.x, tl.y), geo.newPoint(center.x, br.y)];

    return [];
  };
  // for non-cluster nodes, it generates 10 segments
  const segments = [];
  let fromPoints;
  let toPoints;
  if (e.from.isClusterVessel()) fromPoints = clusterEndpoints(g.clusters.get(e.from));
  else fromPoints = [e.from.center()];
  if (e.to.isClusterVessel()) toPoints = clusterEndpoints(g.clusters.get(e.to));
  else toPoints = [e.to.center()];

  for (const from of fromPoints) {
    for (const to of toPoints) {
      guard.step();
      // L-shaped estimate (segments 1-4 in the method doc above)
      segments.push(geo.newSegment(from, geo.newPoint(from.x, to.y)));
      segments.push(geo.newSegment(geo.newPoint(from.x, to.y), to));
      segments.push(geo.newSegment(from, geo.newPoint(to.x, from.y)));
      segments.push(geo.newSegment(geo.newPoint(to.x, from.y), to));
      // S-shaped estimate (segments 5-10 in the method doc above)
      const midX = goRound((from.x + to.x) / 2.);
      segments.push(geo.newSegment(geo.newPoint(midX, from.y), geo.newPoint(midX, to.y)));
      const midY = goRound((from.y + to.y) / 2.);
      segments.push(geo.newSegment(geo.newPoint(from.x, midY), geo.newPoint(to.x, midY)));
    }
  }

  guard.finish();
  return segments;
}

// ---- guard.go ----

function newWorkGuard(ctx, limit) {
  const guard = limits.newWorkGuard(ctx, 'BinPack', limits.MaxEngineWorkUnits);
  guard.setLimit(limit);
  return guard;
}

function binPackScoreGuarded(nodes, root, guard) {
  const [topLeft, bottomRight] = graphbounds.fixedBoundingBox(nodes, guard);
  const width = bottomRight.x - topLeft.x;
  const height = bottomRight.y - topLeft.y;
  let desiredAxisPenalty = 0.;
  if (root !== null) {
    if (root.desiredWidth !== null && root.desiredHeight === null && width < root.desiredWidth) {
      desiredAxisPenalty = root.desiredWidth - width;
    } else if (root.desiredWidth === null && root.desiredHeight !== null && height < root.desiredHeight) {
      desiredAxisPenalty = root.desiredHeight - height;
    }
  }
  const score = width * height + goPow(width - height, 2.0) * subgraphSquareDampener +
    goPow(desiredAxisPenalty, 2.0) * subgraphSquareDampener;
  guard.finish();
  return score;
}

function binPackContainerTopLeft(g, container, children, guard) {
  const [topLeft, bottomRight] = graphbounds.fixedBoundingBox(children, guard);
  if (container === null) {
    guard.finish();
    return topLeft;
  }
  const padding = g.containerPadding(container, false);
  const inside = container.insidePlacement(bottomRight.x - topLeft.x, bottomRight.y - topLeft.y, padding);
  guard.finish();
  return inside;
}

function binPackIsDescendantOf(descendant, ancestor, guard) {
  const seen = new Set();
  for (;;) {
    guard.step();
    if (descendant === ancestor) return true;
    if (descendant === null) return false;
    if (seen.has(descendant)) throw invariant.newError('BinPack found a cycle in node ancestry');
    seen.add(descendant);
    if (descendant.container !== null) {
      descendant = descendant.container;
    } else if (descendant.cluster !== null && descendant.cluster.vessel !== null) {
      descendant = descendant.cluster.vessel;
    } else if (descendant.sequence !== null && descendant.sequence.vessel !== null) {
      descendant = descendant.sequence.vessel;
    } else {
      return ancestor === null;
    }
  }
}

function binPackHasExternalConnection(g, node, container, near, containerIsExternal, guard) {
  if (container === null) return false;
  const descendants = g.allDescendantNodesWithWorkGuard(node, true, guard);
  const toVisit = [];
  toVisit.push(node);
  for (const descendant of descendants) {
    guard.step();
    toVisit.push(descendant);
  }
  for (const current of toVisit) {
    guard.step();
    if (near) {
      const orderedNears = binPackOrderedNears(current, guard);
      for (const adjacent of orderedNears) {
        const inside = binPackIsDescendantOf(adjacent, container, guard);
        if (!inside) return true;
      }
      continue;
    }
    for (const edge of current.edges) {
      guard.step();
      const adjacent = current.adjacent(edge);
      // Once routes exist, moving a descendant connected to this container
      // translates the complete route and pulls the container endpoint off its
      // fixed border. Treat that attachment like a cross-container constraint.
      if (containerIsExternal && adjacent === container) return true;
      const inside = binPackIsDescendantOf(adjacent, container, guard);
      if (!inside) return true;
    }
  }
  guard.finish();
  return false;
}

function binPackOrderedNears(node, guard) {
  if (node === null) throw invariant.newError('BinPack cannot order nears for a nil node');
  if (node.nears.size > limits.MaxEngineNodes) throw invariant.newError('BinPack node near count exceeds node limit');
  const nears = [];
  for (const near of node.nears) {
    guard.step();
    if (near === null) throw invariant.newError('BinPack found a nil near');
    nears.push(near);
  }
  // Account for the comparison sort before entering the small, bounded legacy
  // sorter, so every recursive BinPack helper consumes the same stage budget.
  for (let width = nears.length; width > 1; width = Math.trunc((width + 1) / 2)) {
    for (let i = 0; i < nears.length; i++) guard.step();
  }
  lg.sortNodesByID(nears);
  guard.finish();
  return nears;
}

function binPackHierarchyBoxes(packed, guard) {
  const boxes = [];
  for (const nodes of packed) {
    guard.step();
    if (nodes.length === 0) throw invariant.newError('BinPack contains an empty packed subgraph');
    if (nodes[0].hierarchy === null) continue;
    const [topLeft, bottomRight] = graphbounds.boundingBox(nodes, guard);
    boxes.push({ topLeft, bottomRight });
  }
  guard.finish();
  return boxes;
}

function binPackPointInHierarchy(boxes, point, guard) {
  if (point === null) throw invariant.newError('BinPack hierarchy check received a nil point');
  for (const box of boxes) {
    guard.step();
    if (box.topLeft.x <= point.x && point.x <= box.bottomRight.x &&
      box.topLeft.y <= point.y && point.y <= box.bottomRight.y) {
      return true;
    }
  }
  guard.finish();
  return false;
}

function binPackWrapChildren(root, guard) {
  if (!root.isContainer()) return;
  const children = containersAt(root.graph, root);
  const padding = root.graph.containerPadding(root, false);
  const [topLeft, bottomRight] = graphbounds.fixedBoundingBox(children, guard);
  for (const child of children) {
    guard.step();
    if (child.label !== null && (child.topLeft.x === topLeft.x || child.topLeft.x + child.width === bottomRight.x) &&
      child.label.width > child.width) {
      topLeft.x = Math.min(topLeft.x, Math.floor(child.topLeft.x + (child.width / 2. - child.label.width / 2.)));
      bottomRight.x = Math.max(bottomRight.x, Math.ceil(child.topLeft.x + child.width - (child.width / 2. - child.label.width / 2.)));
    }
  }
  root.fitToBoundingBox(topLeft, bottomRight, padding);
  const inside = root.insidePlacement(bottomRight.x - topLeft.x, bottomRight.y - topLeft.y, padding);
  root.translate(topLeft.x - inside.x, topLeft.y - inside.y);
  guard.finish();
}

function binPackMoveNodeWithChildren(node, dx, dy, guard) {
  guard.step();
  if (dx === 0 && dy === 0) return;
  if (node === null || node.topLeft === null || node.graph === null) {
    throw invariant.newError('BinPack cannot move an unplaced node or a node without a graph');
  }
  node.translate(dx, dy);
  const descendants = node.graph.allDescendantNodesWithWorkGuard(node, true, guard);
  for (const child of descendants) {
    guard.step();
    if (child === null || child.topLeft === null) throw invariant.newError('BinPack cannot move an unplaced descendant');
    child.translate(dx, dy);
  }
  guard.finish();
}

function binPackPositionContainerChildren(node, guard) {
  guard.step();
  if (node === null || !node.isContainer()) return;
  if (node.graph === null) throw invariant.newError('BinPack container has no graph');
  const children = containersAt(node.graph, node);
  const [topLeft, bottomRight] = graphbounds.fixedBoundingBox(children, guard);
  for (const child of children) {
    guard.step();
    if (child === null || child.topLeft === null) throw invariant.newError('BinPack container contains an unplaced child');
    if (child.label !== null && (child.topLeft.x === topLeft.x || child.topLeft.x + child.width === bottomRight.x) &&
      child.label.width > child.width) {
      topLeft.x = Math.min(topLeft.x, Math.floor(child.topLeft.x + (child.width / 2. - child.label.width / 2.)));
      bottomRight.x = Math.max(bottomRight.x, Math.ceil(child.topLeft.x + child.width - (child.width / 2. - child.label.width / 2.)));
    }
  }
  const inside = node.insidePlacement(bottomRight.x - topLeft.x, bottomRight.y - topLeft.y, new lg.Spacing());
  const dx = inside.x - topLeft.x;
  const dy = inside.y - topLeft.y;
  for (const child of children) binPackMoveNodeWithChildren(child, dx, dy, guard);
  guard.finish();
}

/** binPackClusterGeometryWork implements layoutgraph's ClusterGeometryWork over the BinPack guard. */
class BinPackClusterGeometryWork {
  constructor(guard) {
    this.guard = guard;
  }

  step() { this.guard.step(); }
  finish() { this.guard.finish(); }
  moveNodeWithChildren(node, dx, dy) { binPackMoveNodeWithChildren(node, dx, dy, this.guard); }
  positionContainerChildren(node) { binPackPositionContainerChildren(node, this.guard); }
}

function binPackReverseDFSWalk(root, apply, guard) {
  if (root === null) throw invariant.newError('BinPack reverse traversal contains a nil node');
  const stack = [{ node: root, phase: 0, index: 0 }];
  const active = new Set([root]);
  while (stack.length > 0) {
    guard.step();
    const frame = stack[stack.length - 1];
    const graph = frame.node.graph;
    if (graph === null) throw invariant.newError('BinPack reverse traversal found a node without a graph');
    let children = [];
    switch (frame.phase) {
      case 0:
        if (frame.node.isContainer()) children = containersAt(graph, frame.node);
        break;
      case 1:
        if (frame.node.isClusterVessel()) {
          const cluster = graph.clusters.get(frame.node);
          if (cluster === undefined || cluster === null) throw invariant.newError('BinPack reverse traversal found a cluster vessel without a cluster');
          children = cluster.nodes;
        } else {
          const sequence = graph.sequences.get(frame.node);
          if (sequence !== undefined && sequence !== null) children = sequence.nodes;
        }
        break;
      default:
        apply(frame.node);
        active.delete(frame.node);
        stack.pop();
        continue;
    }
    if (frame.index >= children.length) {
      frame.phase++;
      frame.index = 0;
      continue;
    }
    const child = children[frame.index];
    frame.index++;
    if (child === null) throw invariant.newError('BinPack reverse traversal contains a nil child');
    if (active.has(child)) throw invariant.newError('BinPack reverse traversal found a topology cycle');
    active.add(child);
    stack.push({ node: child, phase: 0, index: 0 });
  }
  guard.finish();
}

function binPackSyncClusters(graph, guard) {
  if (graph === null) throw invariant.newError('BinPack cannot synchronize a nil graph');
  if (graph.clusters.size === 0) {
    guard.finish();
    return;
  }
  const work = new BinPackClusterGeometryWork(guard);
  for (const root of graph.nodes) {
    guard.step();
    binPackReverseDFSWalk(root, (node) => {
      if (!node.isClusterVessel()) return;
      graph.clusters.get(node).syncGeometryWithWork(work);
    }, guard);
  }
  guard.finish();
}

function binPackSyncSequences(graph, guard) {
  if (graph === null) throw invariant.newError('BinPack cannot synchronize a nil graph');
  if (graph.sequences.size === 0) {
    guard.finish();
    return;
  }
  for (const root of graph.nodes) {
    guard.step();
    binPackReverseDFSWalk(root, (node) => {
      const sequence = graph.sequences.get(node);
      if (sequence === undefined || sequence === null) return;
      sequence.syncGeometryWithWork(guard);
    }, guard);
  }
  guard.finish();
}

function binPackSmallestDeltas(subgraphs, guard) {
  let x = Infinity, y = Infinity;
  for (const subgraph of subgraphs) {
    guard.step();
    const [topLeft, bottomRight] = graphbounds.boundingBox(subgraph, guard);
    x = Math.min(x, bottomRight.x - topLeft.x);
    y = Math.min(y, bottomRight.y - topLeft.y);
  }
  guard.finish();
  return [x, y];
}

/**
 * allEdgesHaveCompleteRoutesGuarded enforces the all-or-none route state that BinPack relies on. Once routes exist, connected components
 * move as rigid bodies and routed container geometry becomes a packing constraint. Treating a partially routed graph as wholly unrouted
 * would skip both protections while leaving the complete routes in place.
 *
 * The graph-owned edge list and every affected node-owned edge list must also agree exactly. Otherwise a complete route omitted from
 * either inventory could evade route-aware packing and be detached or cut by a move or container shrink. Self-loops occur once in both
 * inventories. Returns [routed, incidentEdges].
 */
function allEdgesHaveCompleteRoutesGuarded(graph, root, guard) {
  if (graph === null) throw invariant.newError('BinPack received a nil graph');
  let descendants;
  if (root === null) {
    descendants = graph.nodes;
  } else {
    descendants = graph.allDescendantNodesWithWorkGuard(root, true, guard);
  }
  const affectedNodes = [];
  if (root !== null) affectedNodes.push(root);
  for (const d of descendants) affectedNodes.push(d);
  const affectedNodeSet = new Set();
  for (const node of affectedNodes) {
    guard.step();
    if (node === null || node.graph !== graph) throw invariant.newError('BinPack affected-node inventory is malformed');
    if (affectedNodeSet.has(node)) throw invariant.errorf(`BinPack affected-node inventory repeats node ${node.id}`);
    affectedNodeSet.add(node);
  }

  const expectedNodeEdges = new Map();
  const expectedNodeEdgeTotals = new Map();
  for (const node of affectedNodes) expectedNodeEdges.set(node, new Map());
  const affectedGraphEdges = new Set();
  let routedEdges = 0;
  const incidentEdges = [];
  const bump = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);
  for (let edgeIndex = 0; edgeIndex < graph.edges.length; edgeIndex++) {
    const edge = graph.edges[edgeIndex];
    guard.step();
    if (edge === null) throw invariant.errorf(`BinPack found a nil edge at index ${edgeIndex}`);
    if (edge.from === null || edge.to === null) throw invariant.errorf(`BinPack edge ${edge.id} has a nil endpoint`);
    if (edge.from.graph !== graph || edge.to.graph !== graph) {
      throw invariant.errorf(`BinPack edge ${edge.id} has an endpoint owned by another graph`);
    }
    let edgeAffectsRoot = false;
    if (affectedNodeSet.has(edge.from)) {
      edgeAffectsRoot = true;
      bump(expectedNodeEdges.get(edge.from), edge);
      bump(expectedNodeEdgeTotals, edge.from);
    }
    if (edge.to !== edge.from) {
      if (affectedNodeSet.has(edge.to)) {
        edgeAffectsRoot = true;
        bump(expectedNodeEdges.get(edge.to), edge);
        bump(expectedNodeEdgeTotals, edge.to);
      }
    }
    if (edgeAffectsRoot) {
      if (affectedGraphEdges.has(edge)) throw invariant.errorf(`BinPack graph edge inventory repeats affected edge ${edge.id}`);
      affectedGraphEdges.add(edge);
    }
    if (edge.points.length === 0) continue;
    if (edge.points.length < 2) {
      throw invariant.errorf(`BinPack edge ${edge.id} has an incomplete route with ${edge.points.length} point(s)`);
    }
    for (let pointIndex = 0; pointIndex < edge.points.length; pointIndex++) {
      guard.step();
      if (edge.points[pointIndex] === null) {
        throw invariant.errorf(`BinPack edge ${edge.id} has a nil route point at index ${pointIndex}`);
      }
    }
    routedEdges++;
    if (root !== null && (edge.from === root || edge.to === root)) incidentEdges.push(edge);
  }
  if (routedEdges !== 0 && routedEdges !== graph.edges.length) {
    throw invariant.errorf(`BinPack graph is partially routed: ${routedEdges} of ${graph.edges.length} edges have routes`);
  }

  for (const node of affectedNodes) {
    const actualNodeEdges = new Map();
    for (let edgeIndex = 0; edgeIndex < node.edges.length; edgeIndex++) {
      const edge = node.edges[edgeIndex];
      guard.step();
      if (edge === null) {
        throw invariant.errorf(`BinPack node ${node.id} edge inventory contains a nil edge at index ${edgeIndex}`);
      }
      if (edge.from !== node && edge.to !== node) {
        throw invariant.errorf(`BinPack node ${node.id} edge inventory contains non-incident edge ${edge.id}`);
      }
      bump(actualNodeEdges, edge);
      const expectedOccurrences = expectedNodeEdges.get(node).get(edge) ?? 0;
      if (actualNodeEdges.get(edge) > expectedOccurrences) {
        throw invariant.errorf(
          `BinPack node ${node.id} edge inventory has ${actualNodeEdges.get(edge)} occurrence(s) of edge ${edge.id}; graph requires ${expectedOccurrences}`,
        );
      }
    }
    if (node.edges.length !== (expectedNodeEdgeTotals.get(node) ?? 0)) {
      throw invariant.errorf(
        `BinPack node ${node.id} edge inventory has ${node.edges.length} occurrence(s); graph requires ${expectedNodeEdgeTotals.get(node) ?? 0}`,
      );
    }
  }
  if (routedEdges === 0) {
    guard.finish();
    return [false, null];
  }
  guard.finish();
  return [true, incidentEdges];
}

// ---- routed_container.go ----

const routedContainerDeferToSideConstraints = 0;
const routedContainerKeepOriginalBox = 1;
const routedContainerUseProposedBox = 2;

const routedContainerTop = 1;
const routedContainerLeft = 2;
const routedContainerBottom = 4;
const routedContainerRight = 8;

// D2 renders an edge with this corner radius when no explicit edge style overrides it. TALA retains nil style provenance, so the safety
// proof must account for the renderer default instead of treating nil as a straight path.
const routedContainerDefaultEdgeBorderRadius = 10.;
const routedContainerMaxBorderRadiusTextBytes = 64;

/**
 * binPackCanUseRoutedContainerBox reports whether the box currently proposed on root preserves every affected routed segment and
 * supported root route attachment from original. It is intentionally narrow: root self-loops, root-to-descendant routes, and curved
 * routes keep the original box. A direct root route is required to supply the side-attachment contract for an admissible shrink;
 * descendant-only routed containers defer to BinPack's ordinary side constraints. The new box must remain inside the old one, and
 * every side touched by a root endpoint must remain geometrically identical. Preserving the complete side also keeps renderer-only
 * rounded corners from moving onto a fixed endpoint.
 */
function binPackCanUseRoutedContainerBox(graph, root, original, graphIncidentEdges, guard) {
  guard.step();
  if (graph === null || root === null || root.graph !== graph) return routedContainerKeepOriginalBox;
  if (graphIncidentEdges === null || graphIncidentEdges.length === 0) {
    // With no root-incident route, ordinary side constraints determine which
    // coordinates the wrapped box may change.
    guard.finish();
    return routedContainerDeferToSideConstraints;
  }
  if (root.topLeft === null || root.shape === null || original === null || original.TopLeft === null) {
    return routedContainerKeepOriginalBox;
  }

  const descendants = graph.allDescendantNodesWithWorkGuard(root, true, guard);
  const descendantSet = new Set();
  for (const node of descendants) {
    guard.step();
    if (node === null) return routedContainerKeepOriginalBox;
    descendantSet.add(node);
  }

  const affectedEdges = [];
  const affectedEdgeSet = new Set();
  for (const edge of graph.edges) {
    guard.step();
    if (edge === null || edge.from === null || edge.to === null) return routedContainerKeepOriginalBox;
    const fromDescendant = descendantSet.has(edge.from);
    const toDescendant = descendantSet.has(edge.to);
    if (edge.from !== root && edge.to !== root && !fromDescendant && !toDescendant) continue;
    if (affectedEdgeSet.has(edge)) return routedContainerKeepOriginalBox;
    affectedEdgeSet.add(edge);
    affectedEdges.push(edge);
  }
  const graphEdges = new Set();
  for (const edge of graphIncidentEdges) {
    guard.step();
    if (edge === null || (edge.from !== root && edge.to !== root)) return routedContainerKeepOriginalBox;
    if (graphEdges.has(edge)) return routedContainerKeepOriginalBox;
    if (!affectedEdgeSet.has(edge)) return routedContainerKeepOriginalBox;
    graphEdges.add(edge);
  }
  if (!root.isContainer() || !root.canContain() || !root.shape.isRectangular()) return routedContainerKeepOriginalBox;
  const [mdx, mdy] = root.modifierElementAdjustments();
  if (mdx !== 0 || mdy !== 0) return routedContainerKeepOriginalBox;
  if (!routedContainerBoxIsFinite(root.box) || !routedContainerBoxIsFinite(original)) return routedContainerKeepOriginalBox;
  if (!routedContainerBoxCovers(original, root.box)) return routedContainerKeepOriginalBox;
  if (root.fixedTopLeft !== null &&
    (root.topLeft.x !== original.TopLeft.x || root.topLeft.y !== original.TopLeft.y)) {
    return routedContainerKeepOriginalBox;
  }

  let checkedEndpoint = false;
  const rootEdges = new Set();
  for (const edge of root.edges) {
    guard.step();
    if (edge === null || edge.from === null || edge.to === null || edge.from === edge.to || edge.points.length < 2) {
      return routedContainerKeepOriginalBox;
    }
    if (!graphEdges.has(edge)) return routedContainerKeepOriginalBox;
    if (rootEdges.has(edge)) return routedContainerKeepOriginalBox;
    rootEdges.add(edge);
    let incident = false;
    if (edge.from === root) {
      incident = true;
      checkedEndpoint = true;
      guard.step();
      if (!routedContainerEndpointKeepsSides(original, root.box, edge.points[0])) return routedContainerKeepOriginalBox;
    }
    if (edge.to === root) {
      incident = true;
      checkedEndpoint = true;
      guard.step();
      if (!routedContainerEndpointKeepsSides(original, root.box, edge.points[edge.points.length - 1])) {
        return routedContainerKeepOriginalBox;
      }
    }
    if (!incident) return routedContainerKeepOriginalBox;
    let adjacent = edge.from;
    if (adjacent === root) adjacent = edge.to;
    const inside = binPackIsDescendantOf(adjacent, root, guard);
    if (inside) {
      // A route to a descendant may leave and re-enter the proposed
      // box even while its root endpoint remains attached.
      return routedContainerKeepOriginalBox;
    }
  }
  if (rootEdges.size !== graphEdges.size || !checkedEndpoint) return routedContainerKeepOriginalBox;
  const routesPreserved = routedContainerRoutesStayInsideShrink(affectedEdges, original, root.box, guard);
  guard.finish();
  if (routesPreserved) return routedContainerUseProposedBox;
  return routedContainerKeepOriginalBox;
}

/**
 * routedContainerRoutesStayInsideShrink proves that shrinking a routed container does not discard any part of an affected route that
 * was inside the original outer box. For each straight route segment, its intersection with the original rectangle is another
 * segment. Both clipped endpoints must be in the proposed rectangle; convexity then contains the complete clipped segment. This is
 * deliberately an engine outer-box invariant: layoutgraph does not carry arbitrary D2 node BorderRadius, so it does not claim
 * containment by a renderer-specific rounded node outline. Direct root attachments separately preserve their complete
 * endpoint-bearing side.
 */
function routedContainerRoutesStayInsideShrink(edges, original, proposed, guard) {
  for (const edge of edges) {
    guard.step();
    if (edge === null || edge.from === null || edge.to === null || edge.points.length < 2 || edge.isCurve) return false;

    for (const point of edge.points) {
      guard.step();
      if (!routedContainerPointIsFinite(point)) return false;
    }
    const roundedCornersPreserved = routedContainerRoundedCornersStayInsideShrink(edge, original, proposed, guard);
    if (!roundedCornersPreserved) return false;

    for (let index = 0; index < edge.points.length - 1; index++) {
      guard.step();
      const preserved = routedContainerSegmentStaysInsideShrink(original, proposed, edge.points[index], edge.points[index + 1], guard);
      if (!preserved) return false;
    }
  }
  guard.finish();
  return true;
}

/**
 * routedContainerRoundedCornersStayInsideShrink accounts for the renderer's rounded polyline corners. The ordinary rounded corner is a
 * cubic Bezier contained by the entry/corner/exit control hull. A hull wholly inside the proposed box is preserved; a hull wholly
 * outside one side of the original box never affected the container. Ambiguous hulls and the renderer's combined short-segment curve
 * fail closed.
 */
function routedContainerRoundedCornersStayInsideShrink(edge, original, proposed, guard) {
  let radius = routedContainerDefaultEdgeBorderRadius;
  if (edge.style.borderRadius !== null) {
    if (utf8Len(edge.style.borderRadius.value) > routedContainerMaxBorderRadiusTextBytes) return false;
    const [value, perr] = parseFloat64(edge.style.borderRadius.value);
    if (perr !== null) return false;
    radius = value;
  }
  if (!routedContainerCoordinateIsFinite(radius) || radius < 0) return false;

  for (let index = 1; index < edge.points.length - 1; index++) {
    guard.step();
    const previous = edge.points[index - 1], corner = edge.points[index], next = edge.points[index + 1];
    const incomingX = corner.x - previous.x, incomingY = corner.y - previous.y;
    const outgoingX = next.x - corner.x, outgoingY = next.y - corner.y;
    const incomingLength = Math.hypot(incomingX, incomingY);
    const outgoingLength = Math.hypot(outgoingX, outgoingY);
    if (!routedContainerCoordinateIsFinite(incomingLength) || incomingLength <= 0 ||
      !routedContainerCoordinateIsFinite(outgoingLength) || outgoingLength <= 0) {
      return false;
    }
    if (radius === 0) continue;
    if (incomingLength < radius || outgoingLength / 2 < radius) {
      // Short corners use a different effective radius and may combine
      // controls across vertices. This proof only admits the normal branch.
      return false;
    }

    const entry = new geo.Point(corner.x - incomingX / incomingLength * radius, corner.y - incomingY / incomingLength * radius);
    const exit = new geo.Point(corner.x + outgoingX / outgoingLength * radius, corner.y + outgoingY / outgoingLength * radius);
    if (!routedContainerPointIsFinite(entry) || !routedContainerPointIsFinite(exit) ||
      !routedContainerControlHullIsPreserved(original, proposed, entry, corner, exit)) {
      return false;
    }
  }
  return true;
}

function routedContainerControlHullIsPreserved(original, proposed, ...points) {
  let allInsideProposed = true;
  let allLeft = true, allTop = true, allRight = true, allBottom = true;
  const originalLeft = original.TopLeft.x, originalTop = original.TopLeft.y;
  const originalRight = originalLeft + original.Width;
  const originalBottom = originalTop + original.Height;
  for (const point of points) {
    if (!routedContainerPointIsFinite(point)) return false;
    allInsideProposed = allInsideProposed && proposed.contains(point);
    allLeft = allLeft && point.x < originalLeft;
    allTop = allTop && point.y < originalTop;
    allRight = allRight && point.x > originalRight;
    allBottom = allBottom && point.y > originalBottom;
  }
  return allInsideProposed || allLeft || allTop || allRight || allBottom;
}

/**
 * routedContainerSegmentStaysInsideShrink clips a straight segment to the closed original rectangle with Liang-Barsky. An empty
 * intersection is unaffected; otherwise both ends of the clipped segment must be contained by the closed proposed rectangle.
 */
function routedContainerSegmentStaysInsideShrink(original, proposed, start, end, guard) {
  if (!routedContainerBoxIsFinite(original) || !routedContainerBoxIsFinite(proposed) ||
    !routedContainerPointIsFinite(start) || !routedContainerPointIsFinite(end)) {
    return false;
  }
  if (start.x === end.x && start.y === end.y) return false;
  const [originalEnter, originalExit, originalIntersects, valid] = routedContainerSegmentBoxInterval(original, start, end, guard);
  if (!valid) return false;
  if (!originalIntersects) return true;
  const [proposedEnter, proposedExit, proposedIntersects, valid2] = routedContainerSegmentBoxInterval(proposed, start, end, guard);
  if (!valid2) return false;
  return proposedIntersects && proposedEnter <= originalEnter && proposedExit >= originalExit;
}

/** Returns [enter, exit, intersects, valid]. */
function routedContainerSegmentBoxInterval(box, start, end, guard) {
  const dx = end.x - start.x, dy = end.y - start.y;
  if (!routedContainerCoordinateIsFinite(dx) || !routedContainerCoordinateIsFinite(dy)) return [0, 0, false, false];

  const left = box.TopLeft.x, top = box.TopLeft.y;
  const right = left + box.Width, bottom = top + box.Height;
  const constraints = [
    [-dx, start.x - left],
    [dx, right - start.x],
    [-dy, start.y - top],
    [dy, bottom - start.y],
  ];
  let tEnter = 0., tExit = 1.;
  for (const constraint of constraints) {
    guard.step();
    const p = constraint[0], q = constraint[1];
    if (p === 0) {
      if (q < 0) return [0, 0, false, true];
      continue;
    }
    const ratio = q / p;
    if (!routedContainerCoordinateIsFinite(ratio)) return [0, 0, false, false];
    if (p < 0) {
      if (ratio > tExit) return [0, 0, false, true];
      if (ratio > tEnter) tEnter = ratio;
    } else {
      if (ratio < tEnter) return [0, 0, false, true];
      if (ratio < tExit) tExit = ratio;
    }
  }
  return [tEnter, tExit, true, true];
}

function routedContainerEndpointKeepsSides(original, proposed, point) {
  const originalSides = routedContainerPointSides(original, point);
  if (originalSides === 0) return false;
  const originalLeft = original.TopLeft.x, originalTop = original.TopLeft.y;
  const originalRight = originalLeft + original.Width;
  const originalBottom = originalTop + original.Height;
  const proposedLeft = proposed.TopLeft.x, proposedTop = proposed.TopLeft.y;
  const proposedRight = proposedLeft + proposed.Width;
  const proposedBottom = proposedTop + proposed.Height;

  if ((originalSides & routedContainerTop) !== 0 &&
    (proposedTop !== originalTop || proposedLeft !== originalLeft || proposedRight !== originalRight)) {
    return false;
  }
  if ((originalSides & routedContainerLeft) !== 0 &&
    (proposedLeft !== originalLeft || proposedTop !== originalTop || proposedBottom !== originalBottom)) {
    return false;
  }
  if ((originalSides & routedContainerBottom) !== 0 &&
    (proposedBottom !== originalBottom || proposedLeft !== originalLeft || proposedRight !== originalRight)) {
    return false;
  }
  if ((originalSides & routedContainerRight) !== 0 &&
    (proposedRight !== originalRight || proposedTop !== originalTop || proposedBottom !== originalBottom)) {
    return false;
  }
  return true;
}

function routedContainerPointSides(box, point) {
  if (!routedContainerBoxIsFinite(box) || !routedContainerPointIsFinite(point)) return 0;
  const left = box.TopLeft.x, top = box.TopLeft.y;
  const right = left + box.Width, bottom = top + box.Height;
  let sides = 0;
  if (point.y === top && point.x >= left && point.x <= right) sides |= routedContainerTop;
  if (point.x === left && point.y >= top && point.y <= bottom) sides |= routedContainerLeft;
  if (point.y === bottom && point.x >= left && point.x <= right) sides |= routedContainerBottom;
  if (point.x === right && point.y >= top && point.y <= bottom) sides |= routedContainerRight;
  return sides;
}

function routedContainerPointIsFinite(point) {
  return point !== null && routedContainerCoordinateIsFinite(point.x) && routedContainerCoordinateIsFinite(point.y);
}

function routedContainerBoxCovers(outer, inner) {
  const outerRight = outer.TopLeft.x + outer.Width;
  const outerBottom = outer.TopLeft.y + outer.Height;
  const innerRight = inner.TopLeft.x + inner.Width;
  const innerBottom = inner.TopLeft.y + inner.Height;
  return inner.TopLeft.x >= outer.TopLeft.x && inner.TopLeft.y >= outer.TopLeft.y &&
    innerRight <= outerRight && innerBottom <= outerBottom;
}

function routedContainerBoxIsFinite(box) {
  return box !== null && box.TopLeft !== null && box.Width > 0 && box.Height > 0 &&
    routedContainerCoordinateIsFinite(box.TopLeft.x) && routedContainerCoordinateIsFinite(box.TopLeft.y) &&
    routedContainerCoordinateIsFinite(box.Width) && routedContainerCoordinateIsFinite(box.Height) &&
    routedContainerCoordinateIsFinite(box.TopLeft.x + box.Width) &&
    routedContainerCoordinateIsFinite(box.TopLeft.y + box.Height);
}

function routedContainerCoordinateIsFinite(value) {
  return !Number.isNaN(value) && value !== Infinity && value !== -Infinity;
}

// ---- combine_snapshot.go ----

function restoreCombineNodePositions(snapshots) {
  for (const snapshot of snapshots) snapshot.node.topLeft = restorePointerSnapshot(snapshot.topLeft);
}

/** snapshotCombineNodePositions captures every position that CombineSubgraphs can translate while preserving each point's exact identity. */
function snapshotCombineNodePositions(ctx, nodes) {
  const guard = limits.newWorkGuard(ctx, 'CombineSubgraphs', limits.MaxEngineWorkUnits);
  const seen = new Set();
  const snapshots = [];
  const queue = [];
  const enqueue = (node, graph) => {
    if (node === null) return;
    if (seen.has(node)) return;
    if (seen.size >= limits.MaxEngineNodes) {
      throw errorf(`TALA CombineSubgraphs unique node count exceeds limit ${limits.MaxEngineNodes}`);
    }
    guard.step();
    seen.add(node);
    snapshots.push({ node, topLeft: snapshotPointer(node.topLeft) });
    queue.push({ node, graph });
  };
  for (const node of nodes) {
    if (node !== null) enqueue(node, node.graph);
  }
  for (let index = 0; index < queue.length; index++) {
    const current = queue[index];
    if (current.graph === null) continue;
    const node = current.node;
    if (node.isContainer()) {
      for (const child of containersAt(current.graph, node)) enqueue(child, current.graph);
    }
    if (node.isClusterVessel()) {
      const cluster = current.graph.clusters.get(node);
      if (cluster !== undefined && cluster !== null) {
        for (const child of cluster.nodes) enqueue(child, current.graph);
      }
    }
    const sequence = current.graph.sequences.get(node);
    if (sequence !== undefined && sequence !== null) {
      for (const child of sequence.nodes) enqueue(child, current.graph);
    }
  }
  guard.finish();
  return snapshots;
}

// ---- combine.go ----

/** Snapshot of a Label/Icon-like object: a pointer and a copy of its fields (restoring writes the copy back into the same object). */
function snapshotObject(pointer) {
  if (pointer === null || pointer === undefined) return { pointer: null, value: null };
  return { pointer, value: Object.assign(Object.create(Object.getPrototypeOf(pointer)), pointer) };
}

function restoreObject(s) {
  if (s.pointer === null) return null;
  Object.assign(s.pointer, s.value);
  return s.pointer;
}

function captureCombineEdge(edge) {
  const value = Object.assign(Object.create(Object.getPrototypeOf(edge)), edge);
  value.style = Object.assign(Object.create(Object.getPrototypeOf(edge.style)), edge.style);
  return {
    value,
    d2ID: edge.d2ID,
    points: { original: edge.points, backing: edge.points.slice() },
    pointValues: edge.points.map((point) => snapshotPointer(point)),
    label: snapshotObject(edge.label),
    sourceArrowheadLabel: snapshotObject(edge.sourceArrowheadLabel),
    targetArrowheadLabel: snapshotObject(edge.targetArrowheadLabel),
    fromTableColumnIndex: edge.fromTableColumnIndex,
    toTableColumnIndex: edge.toTableColumnIndex,
  };
}

function restoreCombineEdge(snapshot, edge) {
  restoreObject(snapshot.label);
  restoreObject(snapshot.sourceArrowheadLabel);
  restoreObject(snapshot.targetArrowheadLabel);
  for (const point of snapshot.pointValues) restorePointerSnapshot(point);
  snapshot.points.original.splice(0, snapshot.points.original.length, ...snapshot.points.backing);
  const originalPoints = snapshot.points.original;
  Object.assign(edge, snapshot.value);
  edge.style = Object.assign(Object.create(Object.getPrototypeOf(snapshot.value.style)), snapshot.value.style);
  edge.d2ID = snapshot.d2ID;
  edge.points = originalPoints;
  edge.label = snapshot.label.pointer;
  edge.sourceArrowheadLabel = snapshot.sourceArrowheadLabel.pointer;
  edge.targetArrowheadLabel = snapshot.targetArrowheadLabel.pointer;
  edge.fromTableColumnIndex = snapshot.fromTableColumnIndex;
  edge.toTableColumnIndex = snapshot.toTableColumnIndex;
}

/** CombineSubgraphs arranges laid-out subgraphs and returns a combined graph view that shares the master graph's topology. */
export function combineSubgraphs(ctx, masterGraph, graphs, ancestorObstacles) {
  if (masterGraph === null) throw errorf('TALA CombineSubgraphs requires a master graph');
  lg.validate(ctx, 'CombineSubgraphs', masterGraph);
  if (graphs.length > limits.MaxEngineNodes) {
    throw errorf(`TALA CombineSubgraphs subgraph count ${graphs.length} exceeds limit ${limits.MaxEngineNodes}`);
  }
  // Go compares the map identities (reflect.Value.Pointer) of the graph-owned topology maps
  const identityOf = (graph) => [graph.containers, graph.clusters, graph.trees, graph.nodeToTree, graph.hubs, graph.sequences,
    graph.directions, graph.commonUncleSiblings];
  // Identical map identities mean identical graph-owned topology, so that expensive portion only needs one full preflight. Node-owned
  // topology is deliberately validated for every graph below as one distinct-record union.
  const validatedGraphOwnedTopologies = [identityOf(masterGraph)];
  const sameIdentity = (a, b) => a.every((m, i) => m === b[i]);
  const allGraphs = [masterGraph];
  for (const graph of graphs) {
    if (graph === null) throw errorf('TALA CombineSubgraphs received a nil subgraph');
    const identity = identityOf(graph);
    if (!validatedGraphOwnedTopologies.some((v) => sameIdentity(v, identity))) {
      lg.validate(ctx, 'CombineSubgraphs', graph);
      validatedGraphOwnedTopologies.push(identity);
    }
    allGraphs.push(graph);
  }
  lg.validateSubgraphCombination(ctx, allGraphs);

  const guard = limits.newWorkGuard(ctx, 'CombineSubgraphs', limits.MaxEngineWorkUnits);
  const allNodes = [];
  const uniqueNodes = new Set();
  const edgeSnapshots = new Map();
  let routePointCapacity = 0;
  const collectGraph = (graph) => {
    for (const node of graph.nodes) {
      guard.step();
      if (node === null) throw errorf('TALA CombineSubgraphs contains a nil node');
      if (!uniqueNodes.has(node)) {
        uniqueNodes.add(node);
        if (uniqueNodes.size > limits.MaxEngineNodes) {
          throw errorf(`TALA CombineSubgraphs unique node count exceeds limit ${limits.MaxEngineNodes}`);
        }
        allNodes.push(node);
      }
    }
    for (const edge of graph.edges) {
      guard.step();
      if (edge === null) throw errorf('TALA CombineSubgraphs contains a nil edge');
      if (edge.from === null || edge.to === null) throw errorf(`TALA CombineSubgraphs edge ${edge.id} has missing endpoints`);
      if (!edgeSnapshots.has(edge)) {
        if (edgeSnapshots.size >= limits.MaxEngineEdges) {
          throw errorf(`TALA CombineSubgraphs unique edge count exceeds limit ${limits.MaxEngineEdges}`);
        }
        // Go counts the slice capacity here; JS arrays have no spare capacity
        const capacity = edge.points.length;
        if (capacity > lg.MaxRoutePoints - routePointCapacity) {
          throw errorf(`TALA CombineSubgraphs route point count exceeds limit ${lg.MaxRoutePoints}`);
        }
        routePointCapacity += capacity;
        for (const point of edge.points) {
          guard.step();
          if (point === null) throw errorf(`TALA CombineSubgraphs edge ${edge.id} contains a nil route point`);
        }
        edgeSnapshots.set(edge, captureCombineEdge(edge));
      }
    }
  };
  collectGraph(masterGraph);
  for (const graph of graphs) collectGraph(graph);
  const nodeSnapshots = snapshotCombineNodePositions(ctx, allNodes);
  const nodeGraphReferences = new Map();
  for (const snapshot of nodeSnapshots) nodeGraphReferences.set(snapshot.node, snapshot.node.graph);
  let complete = false;
  try {
    const combined = combineSubgraphsBody(masterGraph, graphs, ancestorObstacles, guard);
    complete = true;
    return combined;
  } finally {
    if (!complete) {
      restoreCombineNodePositions(nodeSnapshots);
      for (const [node, graph] of nodeGraphReferences) node.graph = graph;
      for (const [edge, snapshot] of edgeSnapshots) restoreCombineEdge(snapshot, edge);
    }
  }
}

function combineSubgraphsBody(masterGraph, graphs, ancestorObstacles, guard) {
  const combined = lg.newGraph();
  combined.copyEntitiesFrom(masterGraph);
  if (graphs.length === 0) return combined;

  const combinedBR = geo.newPoint(-Infinity, -Infinity);
  let candidatePoints = [];

  // first subgraph (contains all fixed nodes) is always placed at 0,0
  const firstGraph = graphs[0];
  if (firstGraph.hasFixedNode()) {
    graphs = graphs.slice(1);
    const [, graphBR] = firstGraph.boundingBox();

    for (const n of firstGraph.nodes) {
      guard.step();
      combined.addNodeUnchecked(n);
      for (const child of masterGraph.allDescendantNodes(n, true)) {
        guard.step();
        combined.addNodeUnchecked(child);
      }
    }
    for (const edge of firstGraph.edges) {
      guard.step();
      combined.addEdge(edge);
    }

    combinedBR.x = Math.max(combinedBR.x, graphBR.x);
    combinedBR.y = Math.max(combinedBR.y, graphBR.y);

    // Add this graph's new candidate points (at 1,2,3 with and without subgraphPadding).
    //  ┌───┐ 1
    //  │ g │
    //  └───┘ 2
    //  3
    candidatePoints.push(
      geo.newPoint(graphBR.x, 0),
      geo.newPoint(graphBR.x, graphBR.y),
      geo.newPoint(0, graphBR.y),
      geo.newPoint(graphBR.x + subgraphPadding, 0),
      geo.newPoint(graphBR.x + subgraphPadding, graphBR.y),
      geo.newPoint(0, graphBR.y + subgraphPadding),
    );
  }

  const sortedByArea = graphs.slice();
  sortSlice(sortedByArea, (i, j) => sortedByArea[i].area() > sortedByArea[j].area());
  guard.finish();

  for (const graph of sortedByArea) {
    guard.step();
    const [graphTL, graphBR] = graph.boundingBox();

    let minCost = Infinity;
    let minOverlaps = Number.MAX_SAFE_INTEGER; // math.MaxInt
    // place the first graph at (0,0) so that combined's top left is always there
    let minCandidatePoint = geo.newPoint(0, 0);
    let minCandidatePointIndex = 0;

    // For each candidate point, see if it fits at that point
    // If it does, calculate the area and compare to see if it's the best point to place it
    for (let i = 0; i < candidatePoints.length; i++) {
      const candidatePoint = candidatePoints[i];
      guard.step();
      // points relative to graph top left would now be relative to the candidate point
      const offsetX = candidatePoint.x - graphTL.x;
      const offsetY = candidatePoint.y - graphTL.y;

      let collides = false;
      let ancestorOverlaps = 0;
      for (const node of graph.nodes) {
        guard.step();
        node.moveWithChildren(offsetX, offsetY);
        for (const otherNode of combined.nodes) {
          guard.step();
          if (node.doesOverlap(otherNode)) {
            collides = true;
            break;
          }
        }
        if (!collides) {
          for (const o of ancestorObstacles) {
            guard.step();
            if (o.TopLeft.x === -lg.ContainerPadding && o.TopLeft.y === -lg.ContainerPadding) continue;
            if (node.box.overlaps(o)) ancestorOverlaps++;
          }
        }
        node.moveWithChildren(-offsetX, -offsetY);
        if (collides) break;
      }
      if (collides) continue;
      if (ancestorOverlaps > minOverlaps) continue;

      // The new combined width is only (candidate point + graph width) if that is wider than the existing width (same for height)
      const newWidth = Math.max(combinedBR.x, candidatePoint.x + (graphBR.x - graphTL.x));
      const newHeight = Math.max(combinedBR.y, candidatePoint.y + (graphBR.y - graphTL.y));
      // A: Area
      // D: Deviation from square (squared)
      // Heuristic: A + cD
      // Note: the base cost is area, but we add an additional cost based on how far it is from being a square.
      // we square the difference between width and height to match area's unit (length^2)
      const cost = newWidth * newHeight + goPow(newWidth - newHeight, 2.0) * subgraphSquareDampener;

      if (ancestorOverlaps < minOverlaps || (ancestorOverlaps === minOverlaps && cost < minCost)) {
        minOverlaps = ancestorOverlaps;
        minCost = cost;
        minCandidatePoint = candidatePoint;
        minCandidatePointIndex = i;
      }
    }

    if (candidatePoints.length > 0) {
      // Remove the candidate point used
      candidatePoints[minCandidatePointIndex] = candidatePoints[candidatePoints.length - 1];
      candidatePoints[candidatePoints.length - 1] = null;
      candidatePoints = candidatePoints.slice(0, candidatePoints.length - 1);
    }

    // Since we are placing the graph at minCandidatePoint,
    // each point relative to the graph top left now needs to be relative to minCandidatePoint
    const offsetX = minCandidatePoint.x - graphTL.x;
    const offsetY = minCandidatePoint.y - graphTL.y;

    for (const n of graph.nodes) {
      guard.step();
      n.moveWithChildren(offsetX, offsetY);
      combined.addNodeUnchecked(n);
      for (const child of masterGraph.allDescendantNodes(n, true)) {
        guard.step();
        combined.addNodeUnchecked(child);
      }
    }
    for (const edge of graph.edges) {
      guard.step();
      for (const point of edge.points) {
        guard.step();
        point.x += offsetX;
        point.y += offsetY;
      }
      combined.addEdge(edge);
    }

    // update graph tl and br to be relative to combined
    graphTL.x += offsetX;
    graphTL.y += offsetY;
    graphBR.x += offsetX;
    graphBR.y += offsetY;

    combinedBR.x = Math.max(combinedBR.x, graphBR.x);
    combinedBR.y = Math.max(combinedBR.y, graphBR.y);

    // Add this graph's new candidate points (at 1,2,3 with and without subgraphPadding).
    //  ┌───┐ 1
    //  │ g │
    //  └───┘ 2
    //  3
    candidatePoints.push(
      geo.newPoint(graphBR.x, graphTL.y),
      geo.newPoint(graphBR.x, graphBR.y),
      geo.newPoint(graphTL.x, graphBR.y),
      geo.newPoint(graphBR.x + subgraphPadding, graphTL.y),
      geo.newPoint(graphBR.x + subgraphPadding, graphBR.y),
      geo.newPoint(graphTL.x, graphBR.y + subgraphPadding),
    );
  }

  guard.finish();
  return combined;
}
