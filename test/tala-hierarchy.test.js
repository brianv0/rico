// Unit tests of the TALA hierarchy and placementcost ports (public/d2/tala/hierarchy.js, hierarchyrank.js, placementcost.js). The
// comparisons against Go itself are the diff stages talahierrank, talahiersimple, talahierstage, talahiercompound, talapcscore and
// talapcunit of tools/d2ref (they need Go); these are the cheap ones, ported from the Go tests of the packages (rank_correctness_test.go,
// edge_length tests) plus the fixed answers of the hash and hypot.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as context from '../public/d2/tala/context.js';
import * as geo from '../public/d2/geo.js';
import * as lg from '../public/d2/tala/layoutgraph.js';
import * as hierarchy from '../public/d2/tala/hierarchy.js';
import { rankDAG, rankDAGWithLimit } from '../public/d2/tala/hierarchyrank.js';
import * as pc from '../public/d2/tala/placementcost.js';

const ctx = () => context.background();

/** a rank graph from [from, to, weight] triples (ids 1..n, edge ids in declaration order) */
function rankGraph(n, edges) {
  const g = lg.newGraph();
  const nodes = [];
  for (let i = 1; i <= n; i++) nodes.push(g.addNode(lg.newNode(BigInt(i), 10, 10)));
  edges.forEach(([a, b, w = 1], i) => {
    const e = g.connect(nodes[a - 1], nodes[b - 1]);
    e.sourceArrowhead = lg.NoArrowhead;
    e.targetArrowhead = lg.TriangleArrowhead;
    e.id = BigInt(i + 1);
    e.setHierarchyRankWeight(w);
  });
  return [g, nodes];
}

const levels = (r, nodes) => nodes.map((n) => r.nodeToLevel.get(n));

test('rankDAG: chain, diamond, and the shortest span of a long edge', () => {
  let [g, nodes] = rankGraph(3, [[1, 2], [2, 3]]);
  let r = rankDAG(ctx(), g);
  assert.deepEqual(levels(r, nodes), [0, 1, 2]);
  assert.equal(r.levelCount, 3);

  [g, nodes] = rankGraph(4, [[1, 2], [1, 3], [2, 4], [3, 4]]);
  r = rankDAG(ctx(), g);
  assert.deepEqual(levels(r, nodes), [0, 1, 1, 2]);

  // 1 -> 2 -> 3 -> 4 and 1 -> 4: the optimum keeps the chain, the long edge spans 3 levels
  [g, nodes] = rankGraph(4, [[1, 2], [2, 3], [3, 4], [1, 4]]);
  r = rankDAG(ctx(), g);
  assert.deepEqual(levels(r, nodes), [0, 1, 2, 3]);
});

test('rankDAG: weights decide which edge is stretched (the optimum is not the longest path)', () => {
  // 1 -> 2 (weight 1), 1 -> 3 (weight 1), 3 -> 2 (weight 1) and 3 -> 4 (weight 5): moving 4 next to 3 is cheapest
  const [g, nodes] = rankGraph(4, [[1, 2], [1, 3], [3, 2], [3, 4, 5]]);
  const r = rankDAG(ctx(), g);
  assert.deepEqual(levels(r, nodes), [0, 2, 1, 2]);
  assert.equal(r.levelCount, 3);
});

test('rankDAG: errors', () => {
  assert.throws(() => rankDAG(ctx(), rankGraph(3, [[1, 2], [2, 3], [3, 1]])[0]), /TALA RankDAG failed: input graph contains a directed cycle/);
  assert.throws(() => rankDAG(ctx(), rankGraph(3, [[1, 2]])[0]), /input graph is disconnected/);
  assert.throws(() => rankDAG(ctx(), rankGraph(2, [[1, 1]])[0]), /self edge on 1/);
  assert.throws(() => rankDAG(ctx(), rankGraph(2, [[1, 2, 0]])[0]), /invalid rank weight 0/);
  assert.throws(() => rankDAG(ctx(), rankGraph(2, [[1, 2], [1, 2]])[0]), /duplicate directed edge/);
  const empty = rankDAG(ctx(), lg.newGraph());
  assert.equal(empty.levelCount, 0);
  assert.equal(empty.nodeToLevel.size, 0);
  const [one] = rankGraph(1, []);
  assert.equal(rankDAG(ctx(), one).levelCount, 1);
});

test('rankDAG: the optimization work budget is exact and deterministic', () => {
  const [g] = rankGraph(6, [[1, 2], [2, 3], [3, 4], [1, 5], [5, 6], [6, 4], [2, 6]]);
  assert.doesNotThrow(() => rankDAGWithLimit(ctx(), g, 100000));
  let used = 0;
  // the smallest limit that succeeds is where the exact unit count is hit: both limit-1 and the limit behave as expected
  for (let limit = 1; limit < 100000; limit++) {
    try { rankDAGWithLimit(ctx(), rankGraph(6, [[1, 2], [2, 3], [3, 4], [1, 5], [5, 6], [6, 4], [2, 6]])[0], limit); used = limit; break; } catch (e) { assert.match(e.message, /work exceeds limit/); }
  }
  assert.ok(used > 50 && used < 5000, `unit count ${used}`);
});

test('makeSimpleDAG: undirected edges split, cycles are reversed, duplicates are merged with their weights', () => {
  const g = lg.newGraph();
  const a = g.addNode(lg.newNode(1n, 10, 10)), b = g.addNode(lg.newNode(2n, 10, 10)), c = g.addNode(lg.newNode(3n, 10, 10));
  const add = (x, y, src, tgt) => { const e = g.connect(x, y); e.sourceArrowhead = src; e.targetArrowhead = tgt; e.id = BigInt(g.edges.length); return e; };
  add(a, b, lg.NoArrowhead, lg.TriangleArrowhead);
  add(a, b, lg.NoArrowhead, lg.TriangleArrowhead); // parallel
  add(b, c, lg.NoArrowhead, lg.TriangleArrowhead);
  add(c, a, lg.NoArrowhead, lg.TriangleArrowhead); // closes a cycle
  add(a, c, lg.NoArrowhead, lg.NoArrowhead); // undirected
  add(b, b, lg.NoArrowhead, lg.TriangleArrowhead); // a loop
  const dag = hierarchy.makeSimpleDAG(ctx(), g);
  const summary = dag.edges.map((e) => `${e.from.id}>${e.to.id}:${e.hierarchyRankWeight()}`);
  const r = rankDAG(ctx(), dag); // a simple connected DAG the ranker accepts
  assert.equal(r.levelCount >= 3, true, summary.join(' '));
  assert.equal(new Set(summary.map((s) => s.split(':')[0])).size, summary.length, 'no duplicate arcs');
  assert.ok(summary.every((s) => !s.startsWith('2>2')), 'loops are gone');
});

test('hierarchy.isHorizontal: container direction or a table', () => {
  const g = lg.newGraph();
  const n = lg.newNode(1n, 10, 10);
  g.addNewNodeToContainer(null, n);
  assert.equal(hierarchy.isHorizontal([n]), false);
  assert.equal(hierarchy.isHorizontal([]), false);
  g.directions.set(null, 5 /* geo.Right */);
  assert.equal(hierarchy.isHorizontal([n]), true);
});

test('placementcost: the EdgeLength state hash is FNV-1a 64 (known answers)', () => {
  const { Fnv64a } = pc._internals;
  const h = new Fnv64a();
  assert.equal(h.sum64(), 0xcbf29ce484222325n); // the offset basis
  h.writeByte(0x61);
  assert.equal(h.sum64(), 0xaf63dc4c8601ec8cn); // FNV-1a 64 of "a"
  const s = new Fnv64a();
  for (const ch of 'foobar') s.writeByte(ch.charCodeAt(0));
  assert.equal(s.sum64(), 0x85944171f73967e8n); // FNV-1a 64 of "foobar"
});

test('placementcost: goHypot is Go math.Hypot (scale by the larger, then sqrt)', () => {
  const { goHypot } = pc._internals;
  assert.equal(goHypot(3, 4), 5);
  assert.equal(goHypot(0, 0), 0);
  assert.equal(goHypot(-5, 0), 5);
  assert.equal(goHypot(Infinity, NaN), Infinity);
  assert.ok(Number.isNaN(goHypot(NaN, 1)));
  assert.equal(goHypot(1e200, 1e200), 1e200 * Math.sqrt(2));
});

test('placementcost: worker count and compass helpers', () => {
  assert.equal(pc.edgeLengthWorkerCount(0, 4), 0);
  assert.equal(pc.edgeLengthWorkerCount(10, 4), 1);
  assert.equal(pc.edgeLengthWorkerCount(11, 4), 4);
  assert.equal(pc.edgeLengthWorkerCount(11, 0), 1);
  assert.equal(pc.edgeLengthWorkerCount(3, 4), 1);
  assert.equal(pc.SideEdgeSpacing, 40);
  assert.equal(pc.IdealGapSize, 150);
});

test('placementcost: EdgeLength caches by state and sums sequentially', () => {
  const g = lg.newGraph();
  const n1 = lg.newNode(1n, 40, 40), n2 = lg.newNode(2n, 40, 40), n3 = lg.newNode(3n, 40, 40);
  for (const [n, x, y] of [[n1, 0, 0], [n2, 200, 0], [n3, 0, 200]]) { n.topLeft = geo.newPoint(x, y); g.addNewNodeToContainer(null, n); }
  const e = g.connect(n1, n2);
  e.targetArrowhead = lg.TriangleArrowhead;
  e.id = 1n;
  g.computeCellSize();
  const opts = { edgeAbductions: null, includeNodeSizes: false, enforceMinimumGap: false, penalizeDirection: false };
  const a = pc.edgeLength(ctx(), g, opts);
  const entries = g.edgeLengthCacheEntries();
  const b = pc.edgeLength(ctx(), g, opts);
  assert.equal(a, b);
  assert.ok(entries >= 1);
  const zero = pc.placementEdgeLengthState(g, g.routingCosts(), opts);
  assert.equal(typeof zero, 'bigint');
  // a node without position makes the state invalid (0n) and the cache is not used
  n3.topLeft = null;
  assert.equal(pc.placementEdgeLengthState(g, g.routingCosts(), opts), 0n);
});
