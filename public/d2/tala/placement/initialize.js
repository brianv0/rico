// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of the Go package d2layouts/d2talalayout/internal/placement (D2 v0.9.0, github.com/d2lang/d2, Copyright 2022
// Terrastruct Inc.): initialize.go and stress_initialize.go, the initial node arrangements.

import * as geo from '../../geo.js';
import { exactDiv, goRound } from '../../gomath.js';
import { errorf } from '../goerrors.js';
import * as lg from '../layoutgraph.js';
import * as limits from '../limits.js';
import * as placementcost from '../placementcost.js';
import { newSizelessOptimizer } from './sizeless_optimizer.js';
import { compactionFactor, medianToNeighbors, occupied, restoreNodePositions, snapshotNodePositionsContext } from './types.js';
import { goCos, goPowPos, goSin } from './gotrig.js';

// ---- initialize.go ----

export function initializeNodes(ctx, g) {
  lg.validate(ctx, 'InitializeNodes', g);
  if (g.nodes.length === 0) return;
  const originalPositions = snapshotNodePositionsContext(ctx, 'InitializeNodes', g.nodes);
  let complete = false;
  try {
    const reachabilityGuard = limits.newWorkGuard(ctx, 'InitializeNodesReachability', limits.MaxEngineWorkUnits);
    const sizelessFactor = g.cellSize * compactionFactor;

    const init = (node) => {
      const cerr = ctx.err();
      if (cerr) throw errorf(`InitializeNodes: ${cerr.message}`, cerr);
      if (node.topLeft !== null) return;

      let leastDistance = Infinity;
      let leastDistancePoint = node.topLeft;

      const sizeless = newSizelessOptimizer(ctx, g, null);
      const candidates = nodeCandidatePositions(ctx, node, g, sizeless);
      for (const p of candidates) {
        const [, isOccupied] = occupied(g, p);
        if (isOccupied) continue;

        node.topLeft = p;

        let edgeLength;
        try {
          edgeLength = placementcost.nodeEdgeLength(ctx, node, { edgeAbductions: null, includeNodeSizes: false, enforceMinimumGap: false, penalizeDirection: true });
        } catch (e) {
          node.topLeft = null;
          throw e;
        }

        if (edgeLength < leastDistance) {
          leastDistance = edgeLength;
          leastDistancePoint = p;
        }

        node.topLeft = null;
      }

      node.topLeft = leastDistancePoint;
    };

    // the first subgraph has all the fixed node subgraphs (each may be disconnected)
    if (g.hasFixedNode()) {
      const fixedNodes = g.fixedNodes();
      const nodes = [];

      for (const fn of fixedNodes) {
        const reachable = fn.allReachableNodesContext(false, true, true, null, reachabilityGuard);
        nodes.push(...reachable);
        for (const n of reachable) n.topLeft = null;
      }

      for (const fn of fixedNodes) {
        fn.topLeft = geo.newPoint(Math.ceil(fn.fixedTopLeft.x / sizelessFactor), Math.ceil(fn.fixedTopLeft.y / sizelessFactor));
      }

      for (const n of nodes) init(n);
    } else {
      const bfsOrder = g.nodes[0].allReachableNodesContext(false, true, true, null, reachabilityGuard);

      for (const n of bfsOrder.slice(1)) n.topLeft = null;
      g.nodes[0].topLeft = geo.newPoint(g.nodes.length, g.nodes.length);

      for (const node of bfsOrder.slice(1)) init(node);
    }

    for (const node of g.nodes) {
      if (node.topLeft === null) throw errorf(`missed initializing node ${node.debugID()}`);
    }

    reachabilityGuard.finish();
    complete = true;
  } finally {
    if (!complete) restoreNodePositions(originalPositions);
  }
}

export function nodeCandidatePositions(ctx, node, g, opt) {
  const [floatMedianX, floatMedianY] = medianToNeighbors(node, false, []);
  const medianX = Math.floor(floatMedianX);
  const medianY = Math.floor(floatMedianY);
  const d = opt.FindClosestUnoccupiedDistance(ctx, node, geo.newPoint(medianX, medianY));
  let topLeftX = medianX - d - 2;
  let topLeftY = medianY - d - 2;
  const bottomRightX = medianX + d + 2;
  const bottomRightY = medianY + d + 2;
  if (g.hasFixedNode()) {
    topLeftX = Math.max(topLeftX, 0);
    topLeftY = Math.max(topLeftY, 0);
  }

  const positions = [];
  if (node.isMajorityTarget()) {
    // if it's, mainly, a target node, give preference to place it to bottom-right
    for (let x = bottomRightX; x >= topLeftX; x--) {
      for (let y = bottomRightY; y >= topLeftY; y--) positions.push(geo.newPoint(x, y));
    }
  } else {
    for (let x = topLeftX; x <= bottomRightX; x++) {
      for (let y = topLeftY; y <= bottomRightY; y++) positions.push(geo.newPoint(x, y));
    }
  }

  return positions;
}

// ---- stress_initialize.go ----

/** math.Hypot (the portable algorithm). */
function goHypot(p, q) {
  p = Math.abs(p);
  q = Math.abs(q);
  if (p === Infinity || q === Infinity) return Infinity;
  if (Number.isNaN(p) || Number.isNaN(q)) return NaN;
  if (p < q) {
    const t = p;
    p = q;
    q = t;
  }
  if (p === 0) return 0;
  q = q / p;
  return p * Math.sqrt(1 + q * q);
}

/**
 * initializeByGraphDistance is an experimental, bounded alternative starting arrangement. It gives distant parts of the graph
 * distinct space rather than minimizing only distances to already placed neighbors. The ordinary orthogonal optimizer still owns
 * the final placement.
 */
export function initializeByGraphDistance(ctx, g) {
  lg.validate(ctx, 'GraphDistanceInitialization', g);
  const n = g.nodes.length;
  if (n < 4 || n > 64 || g.edges.length > 256 || g.hasFixedNode()) return false;
  const index = new Map();
  for (let i = 0; i < g.nodes.length; i++) index.set(g.nodes[i], i);
  const d = new Array(n);
  for (let i = 0; i < n; i++) {
    d[i] = new Array(n).fill(0);
    for (let j = 0; j < n; j++) {
      if (i !== j) d[i][j] = Infinity;
    }
  }
  for (const edge of g.edges) {
    const i = index.get(edge.from);
    const j = index.get(edge.to);
    if (i !== undefined && j !== undefined && i !== j) {
      d[i][j] = 1;
      d[j][i] = 1;
    }
  }
  // Near-only or indirect connectivity falls back to ordinary initialization.
  for (let k = 0; k < n; k++) {
    const cerr = ctx.err();
    if (cerr) throw cerr;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) d[i][j] = Math.min(d[i][j], d[i][k] + d[k][j]);
    }
  }
  for (let i = 0; i < d.length; i++) {
    for (let j = 0; j < d[i].length; j++) {
      if (d[i][j] === Infinity) return false;
    }
  }
  const x = new Array(n).fill(0);
  const y = new Array(n).fill(0);
  for (let i = 0; i < x.length; i++) {
    const a = 2 * Math.PI * i / n;
    x[i] = Math.sqrt(n) * goCos(a);
    y[i] = Math.sqrt(n) * goSin(a);
  }
  // Pairwise relaxation of sum ((EuclideanDistance - graphDistance) / graphDistance)^2. Deterministic sweeps leave the
  // annealing RNG untouched.
  for (let sweep = 0; sweep < 48; sweep++) {
    const cerr = ctx.err();
    if (cerr) throw cerr;
    const eta = 0.7 * goPowPos(exactDiv('.02', '.7'), sweep / 47);
    for (let p = 0; p < n; p++) {
      const i = (p + sweep) % n;
      for (let q = p + 1; q < n; q++) {
        const j = (q + sweep) % n;
        let dx = x[i] - x[j];
        let dy = y[i] - y[j];
        let length = goHypot(dx, dy);
        if (length < 1e-9) {
          dx = 1e-6;
          dy = 1e-6;
          length = Math.sqrt(2) * 1e-6;
        }
        const mu = Math.min(1, eta / (d[i][j] * d[i][j]));
        const amount = 0.5 * mu * (length - d[i][j]) / length;
        x[i] -= dx * amount;
        y[i] -= dy * amount;
        x[j] += dx * amount;
        y[j] += dy * amount;
      }
    }
  }
  const order = new Array(n);
  for (let i = 0; i < order.length; i++) order[i] = i;
  stableSortByEdges(order, g);
  const occupiedCells = new Set();
  const points = new Array(n).fill(null);
  for (const i of order) {
    const cerr = ctx.err();
    if (cerr) throw cerr;
    const tx = x[i] * 2 + n;
    const ty = y[i] * 2 + n;
    const cx = Math.trunc(goRound(tx));
    const cy = Math.trunc(goRound(ty));
    let best = [cx, cy];
    let cost = Infinity;
    // n bounds the radius needed to find an unused integer cell.
    for (let radius = 0; radius <= n; radius++) {
      for (let xx = cx - radius; xx <= cx + radius; xx++) {
        for (let yy = cy - radius; yy <= cy + radius; yy++) {
          if (radius > 0 && xx !== cx - radius && xx !== cx + radius && yy !== cy - radius && yy !== cy + radius) continue;
          if (occupiedCells.has(`${xx},${yy}`)) continue;
          const c = goPowSquare(xx - tx) + goPowSquare(yy - ty);
          if (c < cost) {
            best = [xx, yy];
            cost = c;
          }
        }
      }
      if (cost < Infinity) break;
    }
    occupiedCells.add(`${best[0]},${best[1]}`);
    points[i] = geo.newPoint(best[0], best[1]);
  }
  const cerr = ctx.err();
  if (cerr) throw cerr;
  for (let i = 0; i < g.nodes.length; i++) g.nodes[i].topLeft = points[i];
  return true;
}

function stableSortByEdges(order, g) {
  // sort.SliceStable(order, less(i, j) = len(g.Nodes[order[i]].Edges) > len(g.Nodes[order[j]].Edges))
  const keyed = order.map((v) => [v, g.nodes[v].edges.length]);
  keyed.sort((a, b) => (a[1] > b[1] ? -1 : a[1] < b[1] ? 1 : 0));
  for (let i = 0; i < order.length; i++) order[i] = keyed[i][0];
}

/** math.Pow(v, 2) */
const goPowSquare = (v) => Math.pow(v, 2);
