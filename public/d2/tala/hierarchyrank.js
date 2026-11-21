// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of the rank files of the Go package d2layouts/d2talalayout/internal/hierarchy (rank.go, rank_graph.go, rank_simplex.go,
// rank_queue.go; D2 v0.9.0, github.com/d2lang/d2, Copyright 2022 Terrastruct Inc.): hierarchical rank assignment by the network
// simplex of Gansner et al. (IEEE TSE 19(3), 1993) with Bland's rule and an exact primal/dual optimality certificate.
//
// The Go code uses int64 with checked arithmetic. The JS port uses numbers: every quantity is bounded by the engine ceilings
// (weights <= MaxEngineEdges, levels <= nodes, objective <= weight*span sums), far below 2^53, so the int64 overflow branches are
// unreachable; the checked helpers report "overflow" (null) when a result leaves the safe integer range, which Go reaches only
// beyond 2^63. Errors are thrown (goerrors.js).

import { errorf } from './goerrors.js';
import * as invariant from './invariant.js';
import * as limits from './limits.js';
import { sortSlice } from '../gosort.js';

const MaxInt64 = 9223372036854775807; // math.MaxInt64 as a float: only compared with small values
const MaxInt = 9223372036854775807;

/** slices.SortFunc(s, cmp): the same pdqsort as sort.Slice with less(i, j) = cmp(s[i], s[j]) < 0. */
const slicesSortFunc = (s, cmp) => sortSlice(s, (i, j) => cmp(s[i], s[j]) < 0);

/** cmp.Compare for numbers and BigInts. */
const cmpCompare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---- rank_queue.go ----

/** nodeMinHeap is a small priority queue for stable Kahn traversal. Node indexes already follow entity-ID order. */
class NodeMinHeap {
  constructor(capacity = 0) {
    this.h = [];
  }

  get length() {
    return this.h.length;
  }

  push(node) {
    const h = this.h;
    h.push(node);
    for (let child = h.length - 1; child > 0;) {
      const parent = Math.trunc((child - 1) / 2);
      if (h[parent] <= h[child]) break;
      const t = h[parent]; h[parent] = h[child]; h[child] = t;
      child = parent;
    }
  }

  pop() {
    const old = this.h;
    const root = old[0];
    const last = old[old.length - 1];
    old.length -= 1;
    if (old.length > 0) {
      old[0] = last;
      for (let parent = 0; ;) {
        const left = parent * 2 + 1;
        if (left >= old.length) break;
        let child = left;
        const right = left + 1;
        if (right < old.length && old[right] < old[left]) child = right;
        if (old[parent] <= old[child]) break;
        const t = old[parent]; old[parent] = old[child]; old[child] = t;
        parent = child;
      }
    }
    return root;
  }
}

// ---- rank.go ----

/** rankResult: {nodeToLevel: Map<Node, number>, levelCount} Levels are zero based; levelCount is zero only for an empty graph. */

/**
 * rankDAG minimizes the weighted sum of edge spans subject to every edge spanning at least one level. It returns a normalized
 * deterministic optimum. The input must be a connected simple DAG.
 */
export function rankDAG(ctx, g) {
  try {
    return rankDAGWithLimit(ctx, g, limits.MaxOptimizationWorkUnits);
  } catch (err) {
    if (err.name !== 'GoError') throw err;
    throw errorf(`TALA RankDAG failed: ${err.message}`, err);
  }
}

export function rankDAGWithLimit(ctx, g, workLimit) {
  const guard = limits.newOptimizationWorkGuard(ctx, 'RankDAG', workLimit);
  const problem = newRankProblem(g, guard);
  if (problem.nodes.length === 0) {
    guard.finish();
    return { nodeToLevel: new Map(), levelCount: 0 };
  }

  const initialLevels = problem.longestPathLevels(guard);
  if (problem.edges.length === 0) {
    guard.finish();
    return { nodeToLevel: new Map([[problem.nodes[0], 0]]), levelCount: 1 };
  }

  const [levels, dualValue] = problem.solve(initialLevels, guard);
  const [result, primalValue] = problem.makeResult(levels, guard);
  if (primalValue !== dualValue) {
    throw invariant.errorf(`optimality certificate failed: primal cost ${primalValue}, dual value ${dualValue}`);
  }
  guard.finish();
  return result;
}

const rankMinSpan = 1;

class RankProblem {
  constructor(nodes, edges, outgoingStart, pivotOrder) {
    this.nodes = nodes;
    this.edges = edges; // [{from, to, weight, id}]
    this.outgoingStart = outgoingStart;
    this.pivotOrder = pivotOrder;
  }

  makeResult(levels, guard) {
    let minLevel = MaxInt64;
    let maxLevel = -MaxInt64 - 1;
    for (const level of levels) {
      guard.step();
      minLevel = Math.min(minLevel, level);
      maxLevel = Math.max(maxLevel, level);
    }

    let primalValue = 0;
    for (const edge of this.edges) {
      guard.step();
      const span = checkedSubInt64(levels[edge.to], levels[edge.from]);
      if (span === null) throw errorf('edge span overflow');
      if (span < rankMinSpan) throw invariant.errorf(`infeasible span ${span}`);
      const weightedSpan = checkedMulInt64(edge.weight, span);
      if (weightedSpan === null) throw errorf('objective overflow');
      primalValue = checkedAddInt64(primalValue, weightedSpan);
      if (primalValue === null) throw errorf('objective overflow');
    }

    const levelRange = checkedSubInt64(maxLevel, minLevel);
    if (levelRange === null || levelRange > MaxInt - 1) throw errorf('level count overflow');
    const result = {
      nodeToLevel: new Map(),
      levelCount: levelRange + 1,
    };
    for (let node = 0; node < levels.length; node++) {
      const level = levels[node];
      guard.step();
      const normalized = checkedSubInt64(level, minLevel);
      if (normalized === null) throw errorf('normalized level overflow');
      if (normalized > MaxInt) throw errorf('normalized level overflow');
      result.nodeToLevel.set(this.nodes[node], normalized);
    }
    return [result, primalValue];
  }

  /** longestPathLevels: initial feasible levels by Kahn's algorithm with the smallest ready node first. */
  longestPathLevels(guard) {
    const indegree = new Array(this.nodes.length).fill(0);
    for (const edge of this.edges) {
      guard.step();
      indegree[edge.to]++;
    }

    const ready = new NodeMinHeap();
    for (let node = 0; node < indegree.length; node++) {
      const degree = indegree[node];
      guard.step();
      if (degree === 0) {
        ready.push(node);
        guard.step();
      }
    }

    const levels = new Array(this.nodes.length).fill(0);
    let visited = 0;
    while (ready.length > 0) {
      guard.step();
      const u = ready.pop();
      visited++;
      for (let edgeIndex = this.outgoingStart[u]; edgeIndex < this.outgoingStart[u + 1]; edgeIndex++) {
        guard.step();
        const edge = this.edges[edgeIndex];
        const candidate = checkedAddInt64(levels[u], rankMinSpan);
        if (candidate === null) throw errorf('initial level overflow');
        levels[edge.to] = Math.max(levels[edge.to], candidate);
        indegree[edge.to]--;
        if (indegree[edge.to] === 0) {
          ready.push(edge.to);
          guard.step();
        }
      }
    }
    if (visited !== this.nodes.length) throw errorf('input graph contains a directed cycle');
    return levels;
  }

  solve(initialLevels, guard) {
    const solver = newRankSimplex(this, guard);
    const levels = initialLevels.slice();
    const tree = solver.feasibleTree(levels, guard);
    solver.optimize(levels, tree, guard);
    const dualValue = solver.certify(levels, tree, guard);
    return [levels, dualValue];
  }
}

// checked int64 arithmetic: the result, or null when it does not fit (see the header)
function checkedSubInt64(a, b) {
  const r = a - b;
  return Number.isSafeInteger(r) ? r : null;
}

function checkedAddInt64(a, b) {
  const r = a + b;
  return Number.isSafeInteger(r) ? r : null;
}

function checkedMulInt64(a, b) {
  if (a === 0 || b === 0) return 0;
  const product = a * b;
  return Number.isSafeInteger(product) ? product : null;
}

// ---- rank_graph.go ----

function newRankProblem(g, guard) {
  if (g === null || g === undefined) throw errorf('graph is required');
  if (g.nodes.length > limits.MaxEngineNodes) throw errorf(`node count exceeds limit ${limits.MaxEngineNodes}`);
  if (g.edges.length > limits.MaxEngineEdges) throw errorf(`edge count exceeds limit ${limits.MaxEngineEdges}`);

  const nodes = g.nodes.slice();
  guard.addSort(nodes.length);
  slicesSortFunc(nodes, (a, b) => {
    if (a === null) {
      if (b === null) return 0;
      return -1;
    }
    if (b === null) return 1;
    return cmpCompare(a.id, b.id);
  });

  const index = new Map();
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    guard.step();
    if (node === null) throw errorf('nil node');
    if (i > 0 && nodes[i - 1].id === node.id) throw errorf(`duplicate node ID ${node.id}`);
    if (index.has(node)) throw errorf(`duplicate node ${node.debugID()}`);
    index.set(node, i);
  }

  const edges = []; // {edge, from, to}
  const seenEdges = new Set();
  const seenEdgeIDs = new Set();
  const seenEndpoints = new Set(); // from * nodes + to
  for (const edge of g.edges) {
    guard.step();
    if (edge === null || edge.from === null || edge.to === null) throw errorf('edge has a nil endpoint');
    const from = index.get(edge.from);
    const to = index.get(edge.to);
    if (from === undefined || to === undefined) throw errorf(`edge ${edge.id} references a node outside the graph`);
    if (from === to) throw errorf(`self edge on ${edge.from.debugID()}`);
    if (edge.hasSourceArrow() || !edge.hasTargetArrow()) throw errorf('canonical source-to-target directed edges required');
    const weight = edge.hierarchyRankWeight();
    if (weight <= 0 || weight > limits.MaxEngineEdges) throw errorf(`edge ${edge.id} has invalid rank weight ${weight}`);
    if (seenEdges.has(edge)) throw errorf(`duplicate edge reference ${edge.id}`);
    if (seenEdgeIDs.has(edge.id)) throw errorf(`duplicate edge ID ${edge.id}`);
    const pair = from * nodes.length + to;
    if (seenEndpoints.has(pair)) throw errorf(`duplicate directed edge ${edge.from.debugID()} -> ${edge.to.debugID()}`);
    seenEdges.add(edge);
    seenEdgeIDs.add(edge.id);
    seenEndpoints.add(pair);
    edges.push({ edge, from, to });
  }

  guard.addSort(edges.length);
  slicesSortFunc(edges, (a, b) => {
    let order = cmpCompare(a.from, b.from);
    if (order !== 0) return order;
    order = cmpCompare(a.to, b.to);
    if (order !== 0) return order;
    return cmpCompare(a.edge.id, b.edge.id);
  });

  const incidentCounts = new Map();
  let incidentReferences = 0;
  for (const node of nodes) {
    for (const edge of node.edges) {
      guard.step();
      incidentReferences++;
      if (incidentReferences > limits.MaxEngineEdges * 2) throw errorf(`incident edge references exceed limit ${limits.MaxEngineEdges * 2}`);
      if (edge === null || (edge.from !== node && edge.to !== node)) throw errorf(`malformed incident edge on ${node.debugID()}`);
      if (!seenEdges.has(edge)) throw errorf(`node ${node.debugID()} references an edge outside the graph`);
      let counts = incidentCounts.get(edge);
      if (counts === undefined) counts = { from: 0, to: 0 };
      if (edge.from === node) counts.from++;
      else counts.to++;
      incidentCounts.set(edge, counts);
    }
  }
  for (const edge of edges) {
    guard.step();
    const counts = incidentCounts.get(edge.edge) ?? { from: 0, to: 0 };
    if (!(counts.from === 1 && counts.to === 1)) {
      throw errorf(`edge ${edge.edge.id} must appear once on each endpoint; got source=${counts.from} target=${counts.to}`);
    }
  }

  if (nodes.length > 1) {
    const seen = new Array(nodes.length).fill(false);
    seen[0] = true;
    const queue = [0];
    for (let head = 0; head < queue.length; head++) {
      const u = queue[head];
      for (const edge of nodes[u].edges) {
        guard.step();
        const v = index.get(nodes[u].adjacent(edge));
        if (!seen[v]) {
          seen[v] = true;
          queue.push(v);
        }
      }
    }
    if (queue.length !== nodes.length) throw errorf('input graph is disconnected');
  }

  const problemEdges = new Array(edges.length);
  const outgoingStart = new Array(nodes.length + 1).fill(0);
  for (let i = 0; i < edges.length; i++) {
    const edge = edges[i];
    guard.step();
    problemEdges[i] = { from: edge.from, to: edge.to, weight: edge.edge.hierarchyRankWeight(), id: edge.edge.id };
    outgoingStart[edge.from + 1]++;
  }
  for (let node = 0; node < nodes.length; node++) {
    guard.step();
    outgoingStart[node + 1] += outgoingStart[node];
  }
  const pivotOrder = new Array(problemEdges.length);
  for (let edgeIndex = 0; edgeIndex < pivotOrder.length; edgeIndex++) {
    guard.step();
    pivotOrder[edgeIndex] = edgeIndex;
  }
  guard.addSort(pivotOrder.length);
  slicesSortFunc(pivotOrder, (a, b) => cmpCompare(problemEdges[a].id, problemEdges[b].id));
  return new RankProblem(nodes, problemEdges, outgoingStart, pivotOrder);
}

// ---- rank_simplex.go ----

/**
 * rankSimplex is the graphical network-simplex formulation from Gansner, Koutsofios, North, and Vo, "A Technique for Drawing
 * Directed Graphs," IEEE TSE 19(3), 1993, section 2.3. It works directly with feasible ranks, tight spanning trees, and the cut
 * values of tree edges.
 */
class RankSimplex {
  constructor(problem, incidentStart, incidentEdges, balance, scratch) {
    this.problem = problem;
    this.incidentStart = incidentStart;
    this.incidentEdges = incidentEdges;
    this.balance = balance;
    this.scratch = scratch;
  }

  /**
   * feasibleTree implements figure 2-2 of Gansner et al. Starting from the longest-path feasible ranking, it grows a maximal tree of
   * tight edges. When that tree does not span, it shifts the tree by the minimum boundary slack so at least one more edge becomes
   * tight. The graph stays feasible throughout.
   */
  feasibleTree(levels, guard) {
    const nodeCount = this.problem.nodes.length;
    const tree = new Array(this.problem.edges.length).fill(false);
    const inTree = new Array(nodeCount).fill(false);
    inTree[0] = true;
    let treeNodeCount = 1;
    let queue = [0];

    const growTight = () => {
      for (let head = 0; head < queue.length; head++) {
        guard.step();
        const node = queue[head];
        for (let i = this.incidentStart[node]; i < this.incidentStart[node + 1]; i++) {
          guard.step();
          const edgeIndex = this.incidentEdges[i];
          const edge = this.problem.edges[edgeIndex];
          let other = edge.from;
          if (other === node) other = edge.to;
          if (inTree[other]) continue;
          const slack = rankSlack(edge, levels);
          if (slack !== 0) continue;
          tree[edgeIndex] = true;
          inTree[other] = true;
          treeNodeCount++;
          queue.push(other);
        }
      }
      queue = [];
    };
    growTight();

    let boundary = [];
    while (treeNodeCount < nodeCount) {
      let bestSlack = MaxInt64;
      boundary = [];
      for (const edgeIndex of this.problem.pivotOrder) {
        guard.step();
        const edge = this.problem.edges[edgeIndex];
        if (inTree[edge.from] === inTree[edge.to]) continue;
        const slack = rankSlack(edge, levels);
        if (slack < bestSlack) {
          bestSlack = slack;
          boundary = [edgeIndex];
        } else if (slack === bestSlack) {
          boundary.push(edgeIndex);
        }
      }
      if (boundary.length === 0) throw invariant.newError('could not construct a spanning feasible tree');

      const selected = this.problem.edges[boundary[0]];
      const selectedTailInTree = inTree[selected.from];
      let delta = bestSlack;
      if (!selectedTailInTree) {
        delta = checkedSubInt64(0, bestSlack);
        if (delta === null) throw errorf('feasible-tree shift overflow');
      }
      for (let node = 0; node < inTree.length; node++) {
        guard.step();
        if (!inTree[node]) continue;
        const v = checkedAddInt64(levels[node], delta);
        if (v === null) throw errorf('feasible-tree level overflow');
        levels[node] = v;
      }

      // All minimum-slack boundary edges whose slack decreased are now tight. Add them in canonical edge order, then traverse any
      // tight component reached through their outside endpoints.
      for (const edgeIndex of boundary) {
        guard.step();
        const edge = this.problem.edges[edgeIndex];
        if (inTree[edge.from] === inTree[edge.to]) continue;
        const tailInTree = inTree[edge.from];
        if (bestSlack !== 0 && tailInTree !== selectedTailInTree) continue;
        const slack = rankSlack(edge, levels);
        if (slack !== 0) continue;
        let outside = edge.from;
        if (tailInTree) outside = edge.to;
        tree[edgeIndex] = true;
        inTree[outside] = true;
        treeNodeCount++;
        queue.push(outside);
      }
      if (queue.length === 0) throw invariant.newError('feasible-tree shift did not add a node');
      growTight();
    }
    return tree;
  }

  /**
   * optimize performs the feasible-tree exchanges in figure 2-1. The paper requires an anti-cycling rule for degenerate (zero-shift)
   * pivots. We use the finite smallest-index rule of Bland (Mathematics of Operations Research 2(2), 1977): the first negative-cut
   * tree edge leaves, and minimum-slack entering-edge ties use the first edge.
   */
  optimize(levels, tree, guard) {
    for (;;) {
      this.computeCutValues(tree, guard);
      const cutValue = this.scratch.cutValue;
      let leaving = -1;
      for (const edgeIndex of this.problem.pivotOrder) {
        guard.step();
        if (tree[edgeIndex] && cutValue[edgeIndex] < 0) {
          leaving = edgeIndex;
          break;
        }
      }
      if (leaving < 0) return;

      this.computeHeadComponent(tree, leaving, guard);
      const head = this.scratch.head;
      let entering = -1;
      let minimumSlack = MaxInt64;
      for (const edgeIndex of this.problem.pivotOrder) {
        guard.step();
        const edge = this.problem.edges[edgeIndex];
        if (tree[edgeIndex] || !head[edge.from] || head[edge.to]) continue;
        const slack = rankSlack(edge, levels);
        if (slack < minimumSlack) {
          minimumSlack = slack;
          entering = edgeIndex;
        }
      }
      if (entering < 0) throw invariant.errorf(`negative cut on edge ${this.problem.edges[leaving].id} has no entering edge`);

      for (let node = 0; node < head.length; node++) {
        guard.step();
        if (!head[node]) continue;
        const v = checkedAddInt64(levels[node], minimumSlack);
        if (v === null) throw errorf('simplex level overflow');
        levels[node] = v;
      }
      const slack = rankSlack(this.problem.edges[entering], levels);
      if (slack !== 0) throw invariant.errorf(`entering edge ${this.problem.edges[entering].id} has slack ${slack} after exchange`);
      tree[leaving] = false;
      tree[entering] = true;
    }
  }

  /**
   * computeCutValues roots the undirected feasible tree at node zero. Summing the prescribed dual supplies from the leaves inward
   * gives every tree edge's cut value in linear time and stores the result in scratch.cutValue.
   */
  computeCutValues(tree, guard) {
    const nodeCount = this.problem.nodes.length;
    let treeEdgeCount = 0;
    for (const present of tree) {
      guard.step();
      if (present) treeEdgeCount++;
    }
    if (treeEdgeCount !== nodeCount - 1) throw invariant.errorf(`basis has ${treeEdgeCount} tree edges, want ${nodeCount - 1}`);

    const unvisited = -2;
    const parent = this.scratch.parent;
    const parentEdge = this.scratch.parentEdge;
    for (let node = 0; node < parent.length; node++) {
      guard.step();
      parent[node] = unvisited;
      parentEdge[node] = -1;
    }
    parent[0] = -1;
    const order = [];
    const stack = [0];
    while (stack.length > 0) {
      guard.step();
      const node = stack.pop();
      order.push(node);
      for (let i = this.incidentStart[node]; i < this.incidentStart[node + 1]; i++) {
        guard.step();
        const edgeIndex = this.incidentEdges[i];
        if (!tree[edgeIndex] || edgeIndex === parentEdge[node]) continue;
        const edge = this.problem.edges[edgeIndex];
        let other = edge.from;
        if (other === node) other = edge.to;
        if (parent[other] !== unvisited) throw invariant.errorf(`basis contains a cycle through edge ${edge.id}`);
        parent[other] = node;
        parentEdge[other] = edgeIndex;
        stack.push(other);
      }
    }
    if (order.length !== nodeCount) throw invariant.newError('basis is disconnected');

    const subtreeBalance = this.scratch.subtreeBalance;
    for (let node = 0; node < this.balance.length; node++) {
      guard.step();
      subtreeBalance[node] = this.balance[node];
    }
    const cutValue = this.scratch.cutValue;
    cutValue.fill(0);
    for (let i = order.length - 1; i > 0; i--) {
      guard.step();
      const node = order[i];
      const edgeIndex = parentEdge[node];
      const edge = this.problem.edges[edgeIndex];
      const amount = subtreeBalance[node];
      if (edge.from === node) {
        cutValue[edgeIndex] = amount;
      } else if (edge.to === node) {
        const v = checkedSubInt64(0, amount);
        if (v === null) throw errorf('cut-value overflow');
        cutValue[edgeIndex] = v;
      } else {
        throw invariant.errorf(`malformed tree edge ${edge.id}`);
      }
      const s = checkedAddInt64(subtreeBalance[parent[node]], amount);
      if (s === null) throw errorf('subtree-balance overflow');
      subtreeBalance[parent[node]] = s;
    }
    if (subtreeBalance[0] !== 0) throw invariant.errorf(`tree balance is ${subtreeBalance[0]}, want zero`);
  }

  /** computeHeadComponent stores the head component formed by removing leaving in scratch.head. */
  computeHeadComponent(tree, leaving, guard) {
    const head = this.scratch.head;
    head.fill(false);
    const start = this.problem.edges[leaving].to;
    head[start] = true;
    const queue = [start];
    for (let cursor = 0; cursor < queue.length; cursor++) {
      guard.step();
      const node = queue[cursor];
      for (let i = this.incidentStart[node]; i < this.incidentStart[node + 1]; i++) {
        guard.step();
        const edgeIndex = this.incidentEdges[i];
        if (edgeIndex === leaving || !tree[edgeIndex]) continue;
        const edge = this.problem.edges[edgeIndex];
        let other = edge.from;
        if (other === node) other = edge.to;
        if (!head[other]) {
          head[other] = true;
          queue.push(other);
        }
      }
    }
    if (queue.length === this.problem.nodes.length) throw invariant.errorf(`leaving edge ${this.problem.edges[leaving].id} does not cut the tree`);
  }

  /**
   * certify constructs the ranking LP's dual flow using only the final tight spanning tree. A tree cut value is exactly the unique
   * flow on that edge that satisfies the authored edge-weight balances. Nonnegative cut values provide dual feasibility; equality
   * with the independently computed primal objective in rankDAG then certifies exact optimality.
   */
  certify(levels, tree, guard) {
    this.computeCutValues(tree, guard);
    const cutValue = this.scratch.cutValue;
    const computedBalance = this.scratch.computedBalance;
    computedBalance.fill(0);
    let dualValue = 0;
    for (let edgeIndex = 0; edgeIndex < this.problem.edges.length; edgeIndex++) {
      const edge = this.problem.edges[edgeIndex];
      guard.step();
      let flow = 0;
      if (tree[edgeIndex]) {
        flow = cutValue[edgeIndex];
        if (flow < 0) throw invariant.errorf(`final tree edge ${edge.id} has negative cut value ${flow}`);
        const span = rankSpan(edge, levels);
        if (span !== rankMinSpan) throw invariant.errorf(`final tree edge ${edge.id} is not tight`);
      }
      let ok = true;
      let v = checkedAddInt64(computedBalance[edge.from], flow);
      if (v === null) ok = false;
      else computedBalance[edge.from] = v;
      if (ok) {
        v = checkedSubInt64(computedBalance[edge.to], flow);
        if (v === null) ok = false;
        else computedBalance[edge.to] = v;
      }
      if (!ok) throw errorf('certificate balance overflow');
      const contribution = checkedMulInt64(flow, rankMinSpan);
      if (contribution !== null) {
        v = checkedAddInt64(dualValue, contribution);
        if (v === null) ok = false;
        else dualValue = v;
      } else {
        ok = false;
      }
      if (!ok) throw errorf('dual value overflow');
    }
    for (let node = 0; node < this.balance.length; node++) {
      const want = this.balance[node];
      guard.step();
      if (computedBalance[node] !== want) {
        throw invariant.errorf(`certificate balance mismatch on node ${this.problem.nodes[node].debugID()}: got ${computedBalance[node]}, want ${want}`);
      }
    }
    return dualValue;
  }
}

function newRankSimplex(problem, guard) {
  const nodeCount = problem.nodes.length;
  const degree = new Array(nodeCount).fill(0);
  const balance = new Array(nodeCount).fill(0);
  for (const edge of problem.edges) {
    guard.step();
    degree[edge.from]++;
    degree[edge.to]++;
    let v = checkedAddInt64(balance[edge.from], edge.weight);
    if (v === null) throw errorf('supply overflow');
    balance[edge.from] = v;
    v = checkedSubInt64(balance[edge.to], edge.weight);
    if (v === null) throw errorf('demand overflow');
    balance[edge.to] = v;
  }

  const incidentStart = new Array(nodeCount + 1).fill(0);
  for (let node = 0; node < degree.length; node++) {
    guard.step();
    incidentStart[node + 1] = incidentStart[node] + degree[node];
  }
  const incidentEdges = new Array(problem.edges.length * 2).fill(0);
  const next = incidentStart.slice(0, nodeCount);
  for (const edgeIndex of problem.pivotOrder) {
    guard.step();
    const edge = problem.edges[edgeIndex];
    incidentEdges[next[edge.from]] = edgeIndex;
    next[edge.from]++;
    incidentEdges[next[edge.to]] = edgeIndex;
    next[edge.to]++;
  }

  let total = 0;
  for (const amount of balance) {
    guard.step();
    const t = checkedAddInt64(total, amount);
    if (t === null) throw errorf('balance overflow');
    total = t;
  }
  if (total !== 0) throw invariant.errorf(`unbalanced supplies: ${total}`);
  return new RankSimplex(problem, incidentStart, incidentEdges, balance, {
    parent: new Array(nodeCount).fill(0),
    parentEdge: new Array(nodeCount).fill(0),
    subtreeBalance: new Array(nodeCount).fill(0),
    cutValue: new Array(problem.edges.length).fill(0),
    head: new Array(nodeCount).fill(false),
    computedBalance: new Array(nodeCount).fill(0),
  });
}

function rankSlack(edge, levels) {
  const span = rankSpan(edge, levels);
  const slack = checkedSubInt64(span, rankMinSpan);
  if (slack === null) throw errorf('edge slack overflow');
  if (slack < 0) throw invariant.errorf(`infeasible span ${span}`);
  return slack;
}

function rankSpan(edge, levels) {
  const span = checkedSubInt64(levels[edge.to], levels[edge.from]);
  if (span === null) throw errorf('edge span overflow');
  return span;
}
