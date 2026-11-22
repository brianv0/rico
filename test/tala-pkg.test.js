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
  assert.throws(() => quality.evaluateWithArea(c, lg.newGraph()), /Evaluate: context canceled/);
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

// ---- ported Go tests: quality (inspection_test.go, scoring_test.go) ----

test('quality: Inspect finds repair triggers without changing the legacy score (TestInspectFindsRepairTriggersWithoutChangingLegacyScore)', () => {
  const [g, [a, b, obstacle]] = makeGraph([20, 20], [20, 20], [20, 20]);
  b.topLeft = geo.newPoint(100, 0);
  obstacle.topLeft = geo.newPoint(50, 30);
  for (let i = 0; i < 2; i++) {
    const edge = g.connect(a, b);
    edge.points = [geo.newPoint(10, 20), geo.newPoint(10, 40), geo.newPoint(110, 40), geo.newPoint(110, 20)];
    edge.label = new lg.Label('relationship', label.UnlockedMiddle, 40, 10);
    edge.labelPercentage = 0.5;
  }
  const before = quality.evaluate(ctx(), g);
  const metrics = quality.inspect(ctx(), g);
  assert.ok(metrics.routeObstructions > 0 && metrics.textOcclusions > 0 && metrics.detour > 0 && metrics.routeLength > 0, JSON.stringify(metrics));
  const after = quality.evaluate(ctx(), g);
  const [penalty, area] = quality.evaluateWithArea(ctx(), g);
  assert.deepEqual(before, after);
  assert.equal(after.penalty, penalty);
  assert.equal(after.area, area);
});

test('quality: Score ordering (TestScoreRetainsOriginalExactPenaltyAreaOrdering)', () => {
  const S = (penalty, area) => new quality.Score(penalty, area);
  const next = (x) => { const f = new Float64Array([x]); new BigUint64Array(f.buffer)[0] += 1n; return f[0]; }; // math.Nextafter(x, +Inf) for x > 0
  for (const [a, b, want] of [
    [S(1, 100), S(2, 1), -1],
    [S(1, 10), S(next(1), 1), -1],
    [S(1, 10), S(1, 20), -1],
    [S(NaN, 10), S(Infinity, 20), -1],
    [S(1, -1), S(1, 20), 1],
    [S(1, 100), S(NaN, 1), -1],
    [S(Infinity, 1), S(1, 100), 1],
    [S(1, 10), S(1, NaN), -1],
    [S(1, Infinity), S(1, 10), 1],
    [S(NaN, Infinity), S(Infinity, NaN), 0],
  ]) assert.equal(a.compare(b), want);
});

test('quality: Inspect rejects a canceled context (TestInspectRejectsCancellationBeforeWork)', () => {
  const [c, cancel] = context.withCancel(ctx());
  cancel();
  assert.throws(() => quality.inspect(c, lg.newGraph()), (e) => /Inspect: context canceled/.test(e.message));
});

test('quality: the evaluation work limit is exact (TestEvaluateWorkLimitIsExact)', () => {
  const [graph, [a, b, c, d]] = makeGraph([20, 20], [20, 20], [20, 20], [20, 20]);
  graph.nodes.forEach((node, index) => { node.topLeft = geo.newPoint(index * 40, 0); });
  graph.connect(a, c).points = [geo.newPoint(0, 0), geo.newPoint(100, 100)];
  graph.connect(b, d).points = [geo.newPoint(0, 100), geo.newPoint(100, 0)];
  const [wantScore, wantArea, required] = quality.evaluateWithAreaLimit(ctx(), graph, 50_000_000);
  assert.ok(required >= 2);
  const [gotScore, gotArea, exact] = quality.evaluateWithAreaLimit(ctx(), graph, required);
  assert.deepEqual([gotScore, gotArea, exact], [wantScore, wantArea, required]);
  assert.throws(() => quality.evaluateWithAreaLimit(ctx(), graph, required - 1), (e) => /TALA Evaluate work exceeds limit/.test(e.message) && e.used === required);
});

test('quality: the work limit covers the scoring kernels (TestEvaluateWorkLimitCoversScoringKernels)', () => {
  const graph = lg.newGraph();
  const container = lg.newNode(1n, 240, 180);
  container.topLeft = geo.newPoint(-40, -40);
  graph.addNewNodeToContainer(null, container);
  const a = lg.newNode(2n, 40, 40);
  a.topLeft = geo.newPoint(0, 0);
  a.label = new lg.Label('A', label.OutsideTopCenter, 20, 12);
  const b = lg.newNode(3n, 40, 40);
  b.topLeft = geo.newPoint(120, 80);
  b.label = new lg.Label('B', label.InsideMiddleCenter, 20, 12);
  graph.addNewNodeToContainer(container, a);
  graph.addNewNodeToContainer(container, b);
  const first = graph.connect(a, b);
  first.points = [geo.newPoint(20, 20), geo.newPoint(70, 20), geo.newPoint(140, 100)];
  first.label = new lg.Label('first', label.InsideMiddleCenter, 28, 12);
  first.labelPercentage = 0.5;
  first.sourceArrowheadLabel = new lg.Label('source', label.Unset, 32, 12);
  const second = graph.connect(a, b);
  second.points = [geo.newPoint(20, 20), geo.newPoint(70, 20), geo.newPoint(140, 60)];
  second.label = new lg.Label('second', label.InsideMiddleCenter, 36, 12);
  second.labelPercentage = 0.5;
  const [wantScore, wantArea, required] = quality.evaluateWithAreaLimit(ctx(), graph, 50_000_000);
  assert.ok(required >= 100, String(required));
  assert.deepEqual(quality.evaluateWithAreaLimit(ctx(), graph, required), [wantScore, wantArea, required]);
  assert.throws(() => quality.evaluateWithAreaLimit(ctx(), graph, required - 1), (e) => /TALA Evaluate work exceeds limit/.test(e.message) && e.used === required);
});

test('quality: Evaluate preflights the engine node limit (TestEvaluatePreflightsEngineResources)', () => {
  const graph = lg.newGraph();
  graph.nodes = Array.from({ length: 10_001 }, (_, i) => {
    const n = lg.newNode(BigInt(i + 1), 1, 1);
    n.topLeft = geo.newPoint(i, 0);
    return n;
  });
  assert.throws(() => quality.evaluateWithArea(ctx(), graph), /TALA engine unique node count exceeds limit 10000/);
});

// ---- ported Go tests: labeling (arrowhead_test.go, placement_test.go, refine_test.go) ----

test('labeling: PositionArrowheadLabel owns the rendered record (TestPositionArrowheadLabelOwnsRenderedRecord)', () => {
  const edge = lg.newEdge(null, null);
  edge.points = [geo.newPoint(0, 0), geo.newPoint(100, 0)];
  edge.sourceArrowhead = lg.TriangleArrowhead;
  edge.targetArrowhead = lg.TriangleArrowhead;
  edge.sourceArrowheadLabel = new lg.Label('source', label.Unset, 30, 12);
  edge.targetArrowheadLabel = new lg.Label('target', label.Unset, 40, 14);
  for (const [isTarget, text, width, height, want] of [[false, 'source', 30, 12, [5, -20]], [true, 'target', 40, 14, [55, -22]]]) {
    const positioned = labeling.positionArrowheadLabel(edge, isTarget, edge.points);
    assert.ok(positioned);
    assert.equal(positioned.edge, edge);
    assert.equal(positioned.isTarget, isTarget);
    assert.equal(positioned.text, text);
    assert.deepEqual([positioned.width, positioned.height], [width, height]);
    assert.deepEqual([positioned.topLeft.x, positioned.topLeft.y], want);
  }
  assert.equal(labeling.positionArrowheadLabel(lg.newEdge(null, null), false, edge.points), null);
  assert.equal(labeling.positionArrowheadLabel(null, false, null), null);
});

test('labeling: the label percentage search range is mirror invariant (TestLabelPercentageSearchRangeIsMirrorInvariant)', () => {
  const from = lg.newNode(1n, 10, 10);
  from.cluster = new lg.Cluster();
  const to = lg.newNode(2n, 10, 10);
  const P = geo.newPoint;
  for (const [p1, p2, p3, want] of [
    [P(0, 0), P(100, 0), P(100, 100), 0.45],
    [P(0, 0), P(-100, 0), P(-100, 100), 0.45],
    [P(0, 0), P(0, 100), P(100, 100), 0.475],
    [P(0, 0), P(0, -100), P(100, -100), 0.475],
  ]) {
    const e = lg.newEdge(from, to);
    e.label = new lg.Label('', label.Unset, 20, 10);
    e.points = [p1, p2, p3];
    const r = labeling.labelPercentageSearchRange(e, e.length());
    assert.ok(Math.abs(r.start) <= 1e-12 && Math.abs(r.end - want) <= 1e-12, JSON.stringify(r));
  }
});

test('labeling: a shared cluster path needs overlapping intervals (TestIsClusterPathSharedRequiresOverlappingIntervals)', () => {
  const P = geo.newPoint;
  for (const [first, second, wantShared] of [
    [[P(-10, 0), P(0, 0), P(0, 10)], [P(10, 30), P(0, 30), P(0, 20)], false],
    [[P(-10, 0), P(0, 0), P(0, 10)], [P(10, 20), P(0, 20), P(0, 10)], true],
    [[P(0, -10), P(0, 0), P(10, 0)], [P(30, 10), P(30, 0), P(20, 0)], false],
    [[P(0, -10), P(0, 0), P(10, 0)], [P(20, 10), P(20, 0), P(10, 0)], true],
  ]) {
    const adjacent = lg.newNode(1n, 10, 10);
    const firstNode = lg.newNode(2n, 10, 10);
    const secondNode = lg.newNode(3n, 10, 10);
    const cluster = new lg.Cluster();
    cluster.nodes = [firstNode, secondNode];
    firstNode.cluster = cluster;
    secondNode.cluster = cluster;
    const firstEdge = lg.newEdge(firstNode, adjacent);
    firstEdge.points = first;
    const secondEdge = lg.newEdge(secondNode, adjacent);
    secondEdge.points = second;
    firstNode.edges = [firstEdge];
    secondNode.edges = [secondEdge];
    assert.equal(labeling.isClusterPathSharedChecked(firstEdge, null), wantShared);
  }
});

test('labeling: shared segments (TestFindSharedSegments)', () => {
  const P = geo.newPoint;
  const edge = (...pts) => { const e = lg.newEdge(null, null); e.points = pts; return e; };
  const e1 = edge(P(300, 300), P(200, 300), P(200, 200), P(100, 200));
  const e2 = edge(P(300, 350), P(200, 350), P(200, 100), P(300, 100));
  const e3 = edge(P(300, 100), P(50, 100), P(50, 150));
  const e4 = edge(P(300, 100), P(200, 100), P(200, 180), P(100, 180));
  const segments = labeling.findSharedSegmentsChecked([e1, e2, e3, e4], null);
  assert.equal(segments.length, 3);
  // e2 and e4 share 100..180; e2 alone occupies the exclusive 180..200 corridor, then e1 and e2 share 200..300
  const key = (a, b) => a[0] - b[0] || a[1] - b[1] || a[3] - b[3];
  const got = segments.map((s) => [s.Start.x, s.Start.y, s.End.x, s.End.y]).sort(key);
  assert.deepEqual(got, [[200, 100, 200, 180], [200, 100, 300, 100], [200, 200, 200, 300]].sort(key));
});

test('labeling: shared segments preserve exclusive gaps (TestSharedSegmentsPreserveExclusiveGaps)', () => {
  for (const vertical of [false, true]) {
    for (const reverse of [false, true]) {
      const edges = [];
      for (const interval of [[0, 100], [10, 20], [30, 40], [50, 50]]) {
        let a = geo.newPoint(interval[0], 0), b = geo.newPoint(interval[1], 0);
        if (vertical) { [a.x, a.y] = [a.y, a.x]; [b.x, b.y] = [b.y, b.x]; }
        if (reverse) [a, b] = [b, a];
        const edge = lg.newEdge(null, null);
        edge.points = [a, b];
        edges.push(edge);
      }
      const segments = labeling.findSharedSegmentsChecked(edges, null);
      const coordinate = (p) => (vertical ? p.y : p.x);
      assert.equal(segments.length, 2);
      assert.deepEqual(segments.map((s) => [coordinate(s.Start), coordinate(s.End)]), [[10, 20], [30, 40]]);
    }
  }
});

test('labeling: fixed edge labels are preserved and reserve their space (TestLabelPlacementPreservesFixedEdgeLabelsAndReservesTheirSpace)', () => {
  for (const selected of [false, true]) {
    for (const position of [label.InsideMiddleCenter, label.OutsideTopCenter]) {
      const g = lg.newGraph();
      const a = g.addNode(lg.newNode(1n, 40, 40));
      a.topLeft = geo.newPoint(0, 0);
      const b = g.addNode(lg.newNode(2n, 40, 40));
      b.topLeft = geo.newPoint(300, 0);
      const fixed = g.connect(a, b);
      fixed.points = [geo.newPoint(40, 20), geo.newPoint(300, 20)];
      fixed.label = new lg.Label('fixed', position, 80, 20);
      fixed.label.fixPosition();
      fixed.labelPercentage = 0.25;
      const movable = g.connect(a, b);
      movable.points = fixed.points.map((p) => p.copy());
      movable.label = new lg.Label('automatic', label.Unset, 80, 20);
      const original = fixed.label;
      if (selected) labeling.placeNewEdges(ctx(), g, g.edges.slice());
      else labeling.place(ctx(), g);
      assert.equal(fixed.label, original);
      assert.equal(fixed.label.position, position);
      assert.equal(fixed.labelPercentage, 0.25);
      const box = (e) => ({ tl: e.labelTopLeft(e.label.position, e.label.width, e.label.height), w: e.label.width, h: e.label.height });
      const fa = box(fixed), mb = box(movable);
      assert.ok(!(fa.tl.x < mb.tl.x + mb.w && mb.tl.x < fa.tl.x + fa.w && fa.tl.y < mb.tl.y + mb.h && mb.tl.y < fa.tl.y + fa.h), 'the automatic label occupied the caller-fixed label rectangle');
    }
  }
});

// ---- CombineSubgraphs ----

/** a context whose Err() reports cancellation from its n-th call on (the guards poll Err at a stride and at every Finish) */
class CancelAtCall extends context.Context {
  constructor(n) {
    super(null);
    this.n = n;
    this.calls = 0;
    this.cancellable = true;
  }

  err() {
    this.calls++;
    return this.calls >= this.n ? context.Canceled : null;
  }
}

test('packing: CombineSubgraphs places the subgraphs without overlap and restores positions and routes when it fails midway', () => {
  const edgeJSON = (id, from, to, points) => ({ id, from, to, points, minWidth: 10, minHeight: 10, labelPercentage: 0, style: {}, sourceArrowhead: 'none', targetArrowhead: 'triangle' });
  const build = () => {
    const g = new lg.Graph();
    graphjson.unmarshal(ctx(), graphJSON(
      [node(1, 0, 0, 100, 60), node(2, 300, 0, 100, 60), node(3, 0, 0, 80, 80), node(4, 200, 200, 80, 80), node(5, 0, 0, 50, 50)],
      [
        edgeJSON(10, 1, 2, [{ x: 100, y: 30 }, { x: 300, y: 30 }]),
        edgeJSON(11, 3, 4, [{ x: 40, y: 80 }, { x: 40, y: 240 }, { x: 200, y: 240 }]),
      ],
    ), g);
    return g;
  };
  const snapshot = (g) => JSON.stringify([g.nodes.map((n) => [n.topLeft.x, n.topLeft.y]), g.edges.map((e) => e.points.map((p) => [p.x, p.y]))]);
  const split = (g) => {
    const [subgraphs, journal] = g.splitSubgraphsTracked(ctx(), { includeContainers: false, includeNears: true, traverseTrees: true }, null);
    for (const sg of subgraphs) lg.Nodes.setGraphReference(sg.nodes, sg);
    return [subgraphs, journal];
  };

  const g = build();
  const before = snapshot(g);
  const [subgraphs, journal] = split(g);
  assert.equal(subgraphs.length, 3);
  const combined = packing.combineSubgraphs(ctx(), g, subgraphs, []);
  journal.restore();
  assert.equal(combined.nodes.length, 5);
  assert.equal(combined.edges.length, 2);
  for (let i = 0; i < combined.nodes.length; i++) {
    for (let j = i + 1; j < combined.nodes.length; j++) assert.ok(!combined.nodes[i].doesOverlap(combined.nodes[j]), `nodes ${i} and ${j} overlap`);
  }
  assert.notEqual(snapshot(g), before);

  // cancel at the k-th Err() call: a failure restores every node position, route point and graph reference
  let failures = 0;
  for (let k = 1; k < 400; k++) {
    const h = build();
    const [sgs, jr] = split(h);
    const after = snapshot(h);
    try {
      packing.combineSubgraphs(new CancelAtCall(k), h, sgs, []);
      jr.restore();
      assert.notEqual(snapshot(h), after, 'a successful combine moves something');
      break;
    } catch (e) {
      failures++;
      assert.match(e.message, /canceled/);
      assert.equal(snapshot(h), after, `positions and routes restored (cancel at call ${k})`);
      jr.restore();
    }
  }
  assert.ok(failures >= 3, `the cancellation points were reached: ${failures}`);
});
