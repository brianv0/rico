// Unit tests of the TALA foundation port (public/d2/tala/*.js, gorand.js). The comparisons against Go itself are the diff stages of
// tools/d2ref (talagraphjson, talaadapter, talarand, talanodeshape, talaops); these are the cheap ones that need no Go.
import test from 'node:test';
import assert from 'node:assert/strict';
import { newRand } from '../public/d2/gorand.js';
import * as limits from '../public/d2/tala/limits.js';
import * as context from '../public/d2/tala/context.js';
import * as invariant from '../public/d2/tala/invariant.js';
import { errorsIs } from '../public/d2/tala/goerrors.js';
import * as lg from '../public/d2/tala/layoutgraph.js';
import * as graphjson from '../public/d2/tala/graphjson.js';
import * as graphbounds from '../public/d2/tala/graphbounds.js';
import * as bigjson from '../public/d2/tala/bigjson.js';

const ctx = () => context.background();

test('gorand: the Go 1 stream of rand.NewSource(1)', () => {
  const r = newRand(1);
  assert.equal(r.int63(), 5577006791947779410n);
  assert.equal(r.int63(), 8674665223082153551n);
  assert.equal(r.int63(), 6129484611666145821n);
  const s = newRand(1);
  assert.equal(s.intn(100), 81); // rand.Seed(1); rand.Intn(100) == 81 (the Go tour)
  assert.equal(s.intn(100), 87);
  assert.equal(s.intn(100), 47);
});

test('gorand: Shuffle equals limits.shuffle and consumes the same stream', () => {
  for (const n of [0, 1, 2, 3, 10, 127, 1024]) {
    const a = Array.from({ length: n }, (_, i) => i), b = a.slice();
    const ra = newRand(991), rb = newRand(991);
    ra.shuffle(n, (i, j) => { [a[i], a[j]] = [a[j], a[i]]; });
    limits.shuffle(b, rb, limits.newOptimizationWorkGuard(ctx(), 'test', limits.MaxOptimizationWorkUnits));
    assert.deepEqual(b, a);
    assert.equal(rb.int63(), ra.int63());
  }
});

test('limits: WorkGuard limit and cancellation errors', () => {
  const guard = limits.newWorkGuard(ctx(), 'test', 2);
  guard.step();
  guard.step();
  assert.throws(() => guard.step(), /TALA test work exceeds limit 2/);
  const [c, cancel] = context.withCancel(ctx());
  cancel();
  assert.throws(() => limits.newWorkGuard(c, 'canceled test', 2), (e) => errorsIs(e, context.Canceled) && /canceled test/.test(e.message));
  const zero = limits.newWorkGuard(ctx(), 'zero', 0);
  assert.throws(() => zero.step(), /work exceeds limit 0/);
});

test('limits: OptimizationWorkGuard', () => {
  const g = limits.newOptimizationWorkGuard(ctx(), 'test', 0);
  assert.throws(() => g.step(), (e) => errorsIs(e, limits.ErrOptimizationResourceLimit));
  const h = limits.newOptimizationWorkGuard(ctx(), 'test', 100);
  h.addProduct(7, 6);
  assert.equal(h.used(), 42);
  h.addSort(8); // 8 * bits.Len(7)
  assert.equal(h.used(), 42 + 24);
});

test('invariant errors wrap ErrViolation', () => {
  assert.ok(errorsIs(invariant.newError('x'), invariant.ErrViolation));
  assert.equal(invariant.newError('x').message, 'layout invariant violated: x');
});

test('layoutgraph: containers, edges, clone and graphjson round trip', async () => {
  const geo = await import('../public/d2/geo.js');
  const g = lg.newGraph();
  const mk = (id, x, y) => { const n = lg.newNode(BigInt(id), 50, 40); n.topLeft = geo.newPoint(x, y); return n; };
  const a = mk(1, 0, 0), b = mk(2, 60, 60), c = mk(3, 160, 60), d = mk(4, 400, 0);
  a.width = 300; a.height = 200;
  g.addNewNodeToContainer(null, a);
  g.addNewNodeToContainer(a, b);
  g.addNewNodeToContainer(a, c);
  g.addNewNodeToContainer(null, d);
  const e1 = g.connect(b, d);
  e1.id = 10n;
  e1.targetArrowhead = lg.TriangleArrowhead;
  e1.sourceArrowhead = lg.NoArrowhead;
  assert.ok(a.isContainer());
  assert.equal(b.level(), 2);
  assert.equal(b.nearestSharedAncestor(c), a);
  assert.equal(b.nearestSharedAncestor(d), null);
  assert.deepEqual(g.allDescendantNodes(a, true).map((n) => n.id), [2n, 3n]);
  assert.deepEqual(g.containerRDFSOrderUnbounded(null).map((n) => n.id), [1n]);

  const copy = lg.clone(ctx(), g);
  assert.notEqual(copy.nodes[0], a);
  assert.equal(copy.nodes.length, 4);
  assert.equal(copy.edges[0].from.id, 2n);
  assert.equal(copy.edges[0].from.edges.length, 1);
  copy.nodes[1].topLeft.x = 999;
  assert.equal(b.topLeft.x, 60, 'a clone shares no geometry with its source');

  const text = graphjson.marshal(ctx(), g);
  const back = new lg.Graph();
  graphjson.unmarshal(ctx(), text, back);
  assert.equal(graphjson.marshal(ctx(), back), text);
  assert.throws(() => graphjson.unmarshal(ctx(), '{"nodes": [], "bogus": 1}', new lg.Graph()), /unknown field "bogus"/);
});

test('layoutgraph: a rejected transaction rolls the graph back', async () => {
  const geo = await import('../public/d2/geo.js');
  const g = lg.newGraph();
  const mk = (id, x, y) => { const n = lg.newNode(BigInt(id), 50, 40); n.topLeft = geo.newPoint(x, y); return n; };
  const a = mk(1, 0, 0), b = mk(2, 200, 0);
  g.addNewNodeToContainer(null, a);
  g.addNewNodeToContainer(null, b);
  const before = graphjson.marshal(ctx(), g);
  const tx = g.newRequestTransaction(ctx(), {});
  tx.addOp(() => b.moveNodeWithChildren(-190, 0)); // onto a
  assert.throws(() => tx.commit(ctx()), (e) => lg.isCandidateRejection(e));
  assert.equal(graphjson.marshal(ctx(), g), before);
  const ok = g.newRequestTransaction(ctx(), {});
  ok.addOp(() => b.moveNodeWithChildren(100, 0));
  ok.commit(ctx());
  assert.equal(b.topLeft.x, 300);
});

test('graphbounds: bounds of a node set', async () => {
  const geo = await import('../public/d2/geo.js');
  const mk = (id, x, y) => { const n = lg.newNode(BigInt(id), 50, 40); n.topLeft = geo.newPoint(x, y); return n; };
  const nodes = [mk(1, 0, 0), mk(2, 100, 30)];
  const guard = limits.newWorkGuard(ctx(), 'x', limits.MaxEngineWorkUnits);
  const [tl, br] = graphbounds.boundingBox(nodes, guard);
  assert.deepEqual([tl.x, tl.y, br.x, br.y], [0, 0, 150, 70]);
});

test('bigjson keeps 64-bit integers', () => {
  const v = bigjson.parse('{"id": 5577006791947779410, "n": 3, "f": 1.5}');
  assert.equal(v.id, 5577006791947779410n);
  assert.equal(v.n, 3);
  assert.equal(bigjson.stringify(v), '{"id":5577006791947779410,"n":3,"f":1.5}');
});

