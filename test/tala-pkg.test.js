// Unit tests of the TALA packing, labeling and quality ports (public/d2/tala/{packing,labeling,quality}.js): the cheap behaviors of the Go
// tests of those packages that need no Go (several are the Go tests themselves). The comparisons against Go itself are the diff stages
// talapack, talaplace, talaquality, talacombine and talascore of tools/d2ref (tala/pkgcheck.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as geo from '../public/d2/geo.js';
import * as label from '../public/d2/label.js';
import * as context from '../public/d2/tala/context.js';
import * as lg from '../public/d2/tala/layoutgraph.js';
import * as graphjson from '../public/d2/tala/graphjson.js';
import * as packing from '../public/d2/tala/packing.js';
import * as labeling from '../public/d2/tala/labeling.js';
import * as quality from '../public/d2/tala/quality.js';

const ctx = () => context.background();

function makeGraph(...sizes) {
  const graph = lg.newGraph();
  const nodes = sizes.map(([width, height], i) => {
    const node = graph.addNode(lg.newNode(BigInt(i + 1), width, height));
    node.topLeft = geo.newPoint(0, 0);
    return node;
  });
  return [graph, nodes];
}

test('quality: area stays a separate tie-breaker of the penalty (TestEvaluateKeepsAreaAsSeparateTieBreaker)', () => {
  const [score99, area99] = quality.evaluateWithArea(ctx(), makeGraph([99, 1])[0]);
  const [score100, area100] = quality.evaluateWithArea(ctx(), makeGraph([100, 1])[0]);
  assert.equal(score99, score100);
  assert.equal(area99, 99);
  assert.equal(area100, 100);
});

test('quality: large and fractional areas are exact (TestEvaluateWithAreaPreservesLargeFractionalArea)', () => {
  for (const [width, height] of [[12.5, 3.25], [1_000_000_000, 1_000_000_000]]) {
    const graph = lg.newGraph();
    const node = graph.addNode(lg.newNode(1n, width, height));
    node.topLeft = geo.newPoint(0.25, 0.5);
    assert.equal(quality.evaluateWithArea(ctx(), graph)[1], width * height);
  }
});

test('quality: two diagonal routes that cross score 3 + 3 + 1', () => {
  const [graph, [a, b, c, d]] = makeGraph([2, 2], [2, 2], [2, 2], [2, 2]);
  const e1 = graph.connect(a, b);
  const e2 = graph.connect(c, d);
  e1.points = [geo.newPoint(0, 0), geo.newPoint(10, 10)];
  e2.points = [geo.newPoint(0, 10), geo.newPoint(10, 0)];
  const [penalty] = quality.evaluateWithArea(ctx(), graph);
  assert.equal(penalty, 7); // two diagonal segments (3 each), one crossing, no labels (1 - 1/(1+0))
  const m = quality.inspect(ctx(), graph);
  assert.equal(m.crossings, 1);
});

test('quality: a canceled context stops before any work (TestEvaluateCanceledBeforeWork)', () => {
  const [c, cancel] = context.withCancel(ctx());
  cancel();
  assert.throws(() => quality.evaluateWithArea(c, lg.newGraph()), /^GoError: Evaluate: context canceled$|Evaluate: context canceled/);
});

test('quality: the work limit counts edges without complete routes (TestEvaluateWorkLimitChargesEdgesWithoutCompleteRoutes)', () => {
  for (const routePoints of [0, 1]) {
    const [graph, [from, to]] = makeGraph([10, 10], [10, 10]);
    to.topLeft = geo.newPoint(20, 0);
    for (let i = 0; i < 1000; i++) {
      const edge = graph.connect(from, to);
      if (routePoints === 1) edge.points = [geo.newPoint(10, 5)];
    }
    const limit = 1500;
    assert.throws(() => quality.evaluateWithAreaLimit(ctx(), graph, limit), (e) => /TALA Evaluate work exceeds limit/.test(e.message) && e.used === limit + 1);
  }
});

test('quality: Score.compare orders penalties exactly, then areas, with non-finite values last', () => {
  const S = (p, a) => new quality.Score(p, a);
  assert.equal(S(1, 5).compare(S(2, 1)), -1);
  assert.equal(S(2, 1).compare(S(1, 5)), 1);
  assert.equal(S(1, 5).compare(S(1, 6)), -1);
  assert.equal(S(1, 5).compare(S(1, 5)), 0);
  assert.equal(S(NaN, 1).compare(S(1, 1)), 1);
  assert.equal(S(1, 1).compare(S(Infinity, 1)), -1);
  assert.equal(S(NaN, 1).compare(S(Infinity, 1)), 0);
  assert.equal(S(1, -1).compare(S(1, 5)), 1); // a negative area is not valid
  assert.equal(S(1, -1).compare(S(1, -2)), 0);
});

// ---- labeling and packing on a small graph read from graphjson ----

const graphJSON = (nodes, edges = []) => ({ nodes, edges, CellSize: 100, containers: { 0: nodes.map((n) => n.id) } });
const node = (id, x, y, w, h, extra = {}) => ({ id, d2id: `n${id}`, width: w, height: h, topLeft: { x, y }, fontSize: 16, shapeType: 'Square', ...extra });

test('labeling: Initialize fixes explicit positions and defaults the others', () => {
  const g = new lg.Graph();
  graphjson.unmarshal(ctx(), graphJSON([
    node(1, 0, 0, 100, 60, { label: { Text: 'a', Position: '', Width: 20, Height: 20 } }),
    node(2, 200, 0, 100, 60, { label: { Text: 'b', Position: 'OUTSIDE_TOP_CENTER', Width: 20, Height: 20 } }),
  ]), g);
  labeling.initialize(g);
  assert.equal(g.nodes[0].label.position, label.InsideMiddleCenter);
  assert.equal(g.nodes[0].label.positionFixed(), false);
  assert.equal(g.nodes[1].label.position, label.OutsideTopCenter);
  assert.equal(g.nodes[1].label.positionFixed(), true);
});

test('labeling: Place keeps a free label inside the node and restores the labels when the work limit is hit', () => {
  const g = new lg.Graph();
  graphjson.unmarshal(ctx(), graphJSON([
    node(1, 0, 0, 100, 60, { label: { Text: 'a', Position: 'INSIDE_MIDDLE_CENTER', Width: 20, Height: 20 } }),
  ]), g);
  const used = labeling.placeWithLimit(ctx(), g, 1e6);
  assert.ok(used > 0);
  assert.equal(g.nodes[0].label.position, label.InsideMiddleCenter);
  g.nodes[0].label.position = label.OutsideTopLeft;
  assert.throws(() => labeling.placeWithLimit(ctx(), g, 3), /TALA PlaceLabels work exceeds limit 3/);
  assert.equal(g.nodes[0].label.position, label.OutsideTopLeft); // restored
});

test('labeling: positionArrowheadLabel is null without a label', () => {
  const e = new lg.Edge(null, null);
  assert.equal(labeling.positionArrowheadLabel(e, false, []), null);
  assert.equal(labeling.positionArrowheadLabel(null, true, []), null);
});

test('packing: disconnected components are packed next to each other and the work limit rolls the graph back', () => {
  const build = () => {
    const g = new lg.Graph();
    graphjson.unmarshal(ctx(), graphJSON([node(1, 0, 0, 100, 60), node(2, 1000, 900, 100, 60), node(3, -500, 40, 80, 80)]), g);
    return g;
  };
  const g = build();
  packing.pack(ctx(), g, null);
  const boxes = g.nodes.map((n) => ({ x: n.topLeft.x, y: n.topLeft.y }));
  // the components were pulled together: the bounding box is much smaller than the starting spread
  const [tl, br] = g.boundingBox();
  assert.ok(br.x - tl.x < 600 && br.y - tl.y < 300, JSON.stringify(boxes));
  const g2 = build();
  const before = g2.nodes.map((n) => [n.topLeft.x, n.topLeft.y]);
  const used = packing.packWithLimit(ctx(), build(), null, 1e9);
  assert.throws(() => packing.packWithLimit(ctx(), g2, null, used - 1), /TALA BinPack work exceeds limit/);
  assert.deepEqual(g2.nodes.map((n) => [n.topLeft.x, n.topLeft.y]), before);
});

test('packing: a partially routed graph is rejected', () => {
  const g = new lg.Graph();
  graphjson.unmarshal(ctx(), graphJSON(
    [node(1, 0, 0, 100, 60), node(2, 300, 0, 100, 60), node(3, 600, 0, 100, 60)],
    [
      { id: 10, from: 1, to: 2, points: [{ x: 100, y: 30 }, { x: 300, y: 30 }], minWidth: 10, minHeight: 10, labelPercentage: 0, style: {}, sourceArrowhead: 'none', targetArrowhead: 'triangle' },
      { id: 11, from: 2, to: 3, points: [], minWidth: 10, minHeight: 10, labelPercentage: 0, style: {}, sourceArrowhead: 'none', targetArrowhead: 'triangle' },
    ],
  ), g);
  assert.throws(() => packing.pack(ctx(), g, null), /BinPack graph is partially routed: 1 of 2 edges have routes/);
});
