// Unit tests of the TALA T1 packages (public/d2/tala/{loops,grouping,proximity,trees,goslices}.js): ports of cheap Go tests of the packages.
// The comparisons against Go itself are the diff stages of tools/d2ref/tala (t1diff.mjs stages, diff.mjs talat1ops); these need no Go.
import test from 'node:test';
import assert from 'node:assert/strict';
import { newRand } from '../public/d2/gorand.js';
import * as context from '../public/d2/tala/context.js';
import { errorsIs } from '../public/d2/tala/goerrors.js';
import * as lg from '../public/d2/tala/layoutgraph.js';
import * as geo from '../public/d2/geo.js';
import * as shape from '../public/d2/shape.js';
import * as loops from '../public/d2/tala/loops.js';
import * as grouping from '../public/d2/tala/grouping.js';
import * as proximity from '../public/d2/tala/proximity.js';
import * as trees from '../public/d2/tala/trees.js';
import * as limits from '../public/d2/tala/limits.js';
import { sortFunc, sortStableFunc, compare } from '../public/d2/tala/goslices.js';

const ctx = () => context.background();
const canceled = () => {
  const [c, cancel] = context.withCancel(ctx());
  cancel();
  return c;
};

test('goslices: SortStableFunc keeps the order of equal elements, SortFunc sorts', () => {
  let x = 12345;
  const rnd = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x; };
  for (const n of [0, 1, 2, 19, 20, 21, 40, 41, 100, 333]) {
    const items = Array.from({ length: n }, (_, i) => ({ i, k: rnd() % 7 }));
    const stable = items.slice();
    sortStableFunc(stable, (a, b) => compare(a.k, b.k));
    for (let j = 1; j < stable.length; j++) {
      assert.ok(stable[j - 1].k < stable[j].k || (stable[j - 1].k === stable[j].k && stable[j - 1].i < stable[j].i));
    }
    const plain = items.slice();
    sortFunc(plain, (a, b) => compare(a.k, b.k));
    for (let j = 1; j < plain.length; j++) assert.ok(plain[j - 1].k <= plain[j].k);
  }
  assert.equal(compare(NaN, 1), -1);
  assert.equal(compare(NaN, NaN), 0);
  assert.equal(compare(1, NaN), 1);
  assert.equal(compare(2n, 10n), -1);
});

// ---- loops ----

test('loops: edgesInOrder preserves equal label order (TestEdgesInOrderPreservesEqualLabelOrder)', () => {
  const node = lg.newNode(1n, 10, 10);
  const labeled = (width, height) => {
    const edge = lg.newEdge(node, node);
    edge.label = new lg.Label('', 0, width, height);
    return edge;
  };
  const firstEqual = labeled(10, 10);
  const larger = labeled(20, 10);
  const secondEqual = labeled(20, 5);
  const smaller = labeled(5, 10);
  const input = [firstEqual, larger, secondEqual, smaller];
  assert.deepEqual(loops._edgesInOrder(input), [smaller, firstEqual, secondEqual, larger]);
  assert.deepEqual(input, [firstEqual, larger, secondEqual, smaller]);
});

test('loops: edgesInOrder keeps one-sided arrows in input order, NaN label areas tie', () => {
  const node = lg.newNode(1n, 10, 10);
  const targetOnly = lg.newEdge(node, node);
  targetOnly.targetArrowhead = lg.TriangleArrowhead;
  const sourceOnly = lg.newEdge(node, node);
  sourceOnly.sourceArrowhead = lg.TriangleArrowhead;
  const plain = lg.newEdge(node, node);
  assert.deepEqual(loops._edgesInOrder([targetOnly, plain, sourceOnly]), [targetOnly, sourceOnly, plain]);

  const nonFinite = lg.newEdge(node, node);
  nonFinite.label = new lg.Label('', 0, NaN, 10);
  const finite = lg.newEdge(node, node);
  finite.label = new lg.Label('', 0, 10, 10);
  const got = loops._edgesInOrder([nonFinite, finite]);
  assert.equal(got[0], nonFinite);
  assert.equal(got[1], finite);
});

test('loops: a self edge reserves space around the node and leaves no route behind', () => {
  const g = lg.newGraph();
  const node = lg.newNode(1n, 100, 60);
  g.addNewNodeToContainer(null, node);
  node.topLeft = new geo.Point(0, 0);
  const edge = g.connect(node, node);
  edge.label = new lg.Label('x', 0, 20, 10);
  loops.computeOffsets(g);
  assert.equal(edge.points.length, 0);
  const [tl, br] = node.boundingBox(null);
  assert.ok(tl.x < 0 || tl.y < 0 || br.x > 100 || br.y > 60, 'the loop widens the bounding box');
  assert.equal(node.loopOffsets.get(geo.Orientation.TopLeft), Math.max(node.loopOffsets.get(geo.Orientation.Top), node.loopOffsets.get(geo.Orientation.Left)));
  const routed = loops.route(node);
  assert.deepEqual(routed, [edge]);
  assert.equal(edge.points.length, 5);
  assert.equal(edge.label.position, 2); // label.OutsideTopCenter
});

test('loops: a node without a position is routed at the origin and stays unpositioned', () => {
  const g = lg.newGraph();
  const node = lg.newNode(1n, 40, 40);
  g.addNewNodeToContainer(null, node);
  g.connect(node, node);
  loops.updateOffsets(node);
  assert.equal(node.topLeft, null);
  assert.ok(node.loopOffsets.size > 0);
});

// ---- grouping ----

const stepGraph = () => {
  const graph = lg.newGraph();
  const first = lg.newNode(1n, 20, 10);
  const second = lg.newNode(2n, 40, 30);
  first.setShape(shape.STEP_TYPE);
  second.setShape(shape.STEP_TYPE);
  graph.addNewNodeToContainer(null, first);
  graph.addNewNodeToContainer(null, second);
  graph.connect(first, second);
  return { graph, first, second };
};

test('grouping: a step pair becomes one sequence vessel with the first Int63 of the stream as ID, and can be rebuilt (TestSequenceCanBeRebuiltAfterCleanup)', () => {
  const { graph, first, second } = stepGraph();
  grouping.addSequences(ctx(), graph, newRand(1n));
  assert.equal(graph.sequences.size, 1);
  const [vessel] = [...graph.sequences.keys()];
  assert.equal(vessel.id, 5577006791947779410n); // rand.New(rand.NewSource(1)).Int63()
  assert.deepEqual(graph.nodes, [vessel]);
  grouping.cleanup(graph);
  assert.equal(first.connectionTo(second), null, 'the sequence-defining edge does not survive cleanup');
  assert.deepEqual(graph.nodes, [first, second]);
  grouping.addSequences(ctx(), graph, newRand(1n));
  assert.equal(graph.sequences.size, 1);
  assert.equal([...graph.sequences.keys()][0].id, vessel.id);
});

test('grouping: remembered inactive steps are not rediscovered (TestIdentifySequencesSkipsRememberedInactiveSteps)', () => {
  const { graph, first, second } = stepGraph();
  const remembered = new lg.Sequence();
  remembered.vessel = lg.newNode(3n, 0, 0);
  remembered.nodes = [first, second];
  remembered.graph = graph;
  first.sequence = remembered;
  second.sequence = remembered;
  const guard = limits.newWorkGuard(ctx(), 'IdentifySequences', limits.MaxEngineWorkUnits);
  assert.deepEqual(grouping._identifySequences(graph, [first, second], guard) ?? [], []);
});

test('grouping: sequenceDefiningEdges names the edges between steps', () => {
  const { graph } = stepGraph();
  const ids = grouping.sequenceDefiningEdges(ctx(), graph);
  assert.equal(ids.size, 1);
});

test('grouping: AssignArrangement draws only for square clusters', () => {
  const mk = (w, h) => {
    const c = new lg.Cluster();
    c.nodes = [lg.newNode(1n, w, h), lg.newNode(2n, w, h)];
    return c;
  };
  const r = newRand(1n);
  assert.equal(grouping.assignArrangement(mk(30, 10), false, r), lg.Column);
  assert.equal(grouping.assignArrangement(mk(10, 30), false, r), lg.Row);
  assert.equal(grouping.assignArrangement(mk(10, 10), true, r), lg.Row);
  assert.equal(r.float64(), newRand(1n).float64(), 'no draw was consumed');
  assert.equal(grouping.assignArrangement(mk(10, 10), false, newRand(1n)), lg.Column); // first Float64 of seed 1 is 0.6046...
});

test('grouping: identical leaves around a hub form one cluster; ResetClusters and Cleanup undo it', () => {
  const g = lg.newGraph();
  const hub = lg.newNode(10n, 80, 40);
  g.addNewNodeToContainer(null, hub);
  const leaves = [1n, 2n, 3n].map((id) => lg.newNode(id, 60, 30));
  for (const l of leaves) {
    g.addNewNodeToContainer(null, l);
    g.connect(hub, l);
  }
  grouping.addClusters(ctx(), g, 1n, newRand(1n));
  assert.equal(g.clusters.size, 1);
  const [vessel, cluster] = [...g.clusters.entries()][0];
  assert.deepEqual(cluster.nodes, leaves);
  assert.equal(cluster.arrangement, lg.Column); // wider than tall: stacked
  assert.ok(vessel.isClusterVessel());
  assert.equal(g.nodes.length, 2);
  assert.equal(hub.edges.length, 3);
  assert.ok(hub.edges.every((e) => e.to === vessel));
  grouping.cleanup(g);
  assert.equal(g.nodes.length, 4);
  assert.ok(hub.edges.every((e) => leaves.includes(e.to)));

  // the same on a graph that is reset instead of cleaned up
  grouping.resetClusters(g);
  assert.equal(g.clusters.size, 0);
  assert.ok(leaves.every((l) => l.cluster === null));
});

test('grouping: cancellation leaves the graph untouched', () => {
  const { graph, first, second } = stepGraph();
  assert.throws(() => grouping.addSequences(canceled(), graph, newRand(1n)), (e) => errorsIs(e, context.Canceled) && /AddSequences/.test(e.message));
  assert.deepEqual(graph.nodes, [first, second]);
  assert.equal(graph.sequences.size, 0);
  assert.throws(() => grouping.addClusters(canceled(), graph, 1n, newRand(1n)), (e) => errorsIs(e, context.Canceled));
  assert.equal(graph.clusters.size, 0);
});

// ---- proximity ----

test('proximity: hubs are nodes with a leaf spoke and another connection in the same container (TestAddHubsFindsLeafSpokesInSameContainer)', () => {
  const graph = lg.newGraph();
  const [hub, spoke, connected, other] = [1n, 2n, 3n, 4n].map((id) => lg.newNode(id, 10, 10));
  for (const n of [hub, spoke, connected, other]) graph.addNewNodeToContainer(null, n);
  graph.connect(hub, spoke);
  graph.connect(hub, connected);
  graph.connect(connected, other);
  proximity.addHubs(ctx(), graph);
  assert.deepEqual(graph.hubs.get(hub), [spoke]);
  assert.deepEqual([...graph.hubs.keys()].map((n) => n.id).sort(), [1n, 3n]);
});

test('proximity: AssignNears groups siblings with a common uncle (TestAssignNearsGroupsSiblingsWithCommonUncle)', () => {
  const graph = lg.newGraph();
  const root = lg.newNode(1n, 100, 100);
  const first = lg.newNode(2n, 10, 10);
  const second = lg.newNode(3n, 10, 10);
  const uncle = lg.newNode(4n, 10, 10);
  graph.addNewNodeToContainer(null, root);
  graph.addNewNodeToContainer(root, first);
  graph.addNewNodeToContainer(root, second);
  graph.addNewNodeToContainer(null, uncle);
  const abduction = (from) => Object.assign(new lg.EdgeAbduction(), { originallyFrom: from, currentFrom: root, currentTo: uncle });
  proximity.assignNears(ctx(), graph, root, [abduction(first), abduction(second)]);
  assert.ok(first.nears.has(second));
  assert.ok(second.nears.has(first));
});

test('proximity: AssignNears cancellation does not change nears', () => {
  const graph = lg.newGraph();
  const node = lg.newNode(1n, 10, 10);
  graph.addNewNodeToContainer(null, node);
  assert.throws(() => proximity.assignNears(canceled(), graph, null, []), (e) => errorsIs(e, context.Canceled));
  assert.equal(node.nears.size, 0);
});

test('proximity: CommonUncleSiblings uses the largest group (TestCommonUncleSiblingsUsesLargestGroup)', () => {
  const graph = lg.newGraph();
  const container = lg.newNode(1n, 100, 100);
  const [first, second, third] = [2n, 3n, 4n].map((id) => lg.newNode(id, 10, 10));
  const uncle = lg.newNode(5n, 10, 10);
  graph.addNewNodeToContainer(null, container);
  for (const n of [first, second, third]) {
    graph.addNewNodeToContainer(container, n);
    graph.connect(n, uncle);
  }
  graph.addNewNodeToContainer(null, uncle);
  const common = proximity.commonUncleSiblings(graph);
  for (const n of [first, second, third]) assert.equal(common.get(n).length, 3);
});

test('proximity: SyncHerdFences uses the graph bounds (TestSyncHerdFencesUsesGraphBounds)', () => {
  const graph = lg.newGraph();
  const top = lg.newNode(1n, 10, 10);
  const right = lg.newNode(2n, 10, 10);
  top.topLeft = new geo.Point(20, 30);
  right.topLeft = new geo.Point(100, 80);
  top.herdAssignment = lg.newHerdAssignment();
  top.herdAssignment.orientation = geo.Orientation.Top;
  right.herdAssignment = lg.newHerdAssignment();
  right.herdAssignment.orientation = geo.Orientation.Right;
  graph.addNode(top);
  graph.addNode(right);
  proximity.syncHerdFences(graph);
  assert.equal(top.herdAssignment.val, 30);
  assert.equal(right.herdAssignment.val, 110);
});

// ---- trees ----

test('trees: placement trees of an isolated tree merge roots of the same direction and arrowhead (TestBuildPlacementTreesForIsolatedTree)', () => {
  const g = lg.newGraph();
  const nodes = Array.from({ length: 13 }, (_, i) => {
    const n = lg.newNode(BigInt(i + 1), 10, 10);
    g.addNewNodeToContainer(null, n);
    return n;
  });
  const connect = (i, j, source, target) => {
    const e = g.connect(nodes[i], nodes[j]);
    if (source) e.sourceArrowhead = lg.TriangleArrowhead;
    if (target) e.targetArrowhead = lg.TriangleArrowhead;
  };
  // top tree
  connect(0, 1, false, true);
  connect(2, 1, false, true);
  connect(3, 1, false, true);
  // bottom tree
  connect(4, 0, false, true);
  connect(4, 5, false, true);
  connect(4, 6, false, true);
  // right top tree
  connect(0, 8, false, true);
  connect(8, 9, false, true);
  connect(8, 10, false, true);
  // right bottom tree
  connect(0, 7, false, false);
  connect(7, 11, false, true);
  connect(7, 12, false, true);

  const guard = limits.newWorkGuard(ctx(), 'ExtractTrees', limits.MaxEngineWorkUnits);
  g.trees = trees._extractTrees(g, guard);
  const placement = trees._buildPlacementTrees(g, limits.newWorkGuard(ctx(), 'GetPlacementTrees', limits.MaxEngineWorkUnits));
  assert.equal(placement.length, 3);
  for (const tree of placement) {
    if (tree.children.length === 2) {
      const set = new Set([tree.children[0].node, tree.children[1].node]);
      set.delete(nodes[7]);
      set.delete(nodes[8]);
      assert.equal(set.size, 0, 'expected nodes 7 and 8 to be siblings');
    } else if (tree.children.length === 1) {
      assert.ok([nodes[4], nodes[1]].includes(tree.children[0].node), 'only nodes 1 and 4 are isolated children');
    } else assert.fail('unexpected children count');
  }
});

test('trees: Preprocess prunes branching trees off a cycle and Place puts them back around the core', () => {
  const g = lg.newGraph();
  const mk = (id, w = 40, h = 20) => {
    const n = lg.newNode(BigInt(id), w, h);
    g.addNewNodeToContainer(null, n);
    return n;
  };
  const [a, b, c] = [mk(1), mk(2), mk(3)];
  g.connect(a, b);
  g.connect(b, c);
  g.connect(c, a);
  const root = mk(4);
  const kids = [mk(5), mk(6), mk(7)];
  g.connect(a, root);
  for (const k of kids) g.connect(root, k);

  trees.preprocess(ctx(), g);
  assert.deepEqual(g.nodes.map((n) => n.id), [1n, 2n, 3n]);
  assert.equal(g.trees.size, 1);
  const [sentinel] = [...g.trees.keys()];
  assert.equal(sentinel, a);
  assert.equal(g.trees.get(a)[0].node, root);
  assert.equal(g.nodeToTree.size, 4);

  a.topLeft = new geo.Point(0, 0);
  b.topLeft = new geo.Point(200, 0);
  c.topLeft = new geo.Point(100, 150);
  g.computeCellSize();
  trees.place(ctx(), g, null);
  assert.equal(g.nodes.length, 7);
  assert.equal(g.edges.length, 7);
  for (const n of g.nodes) assert.notEqual(n.topLeft, null);
  const placed = trees.descendants(g.trees.get(a)[0]);
  assert.equal(placed.length, 3);
  // the children sit side by side below or beside their parent, none overlaps another
  for (let i = 0; i < g.nodes.length; i++) {
    for (let j = i + 1; j < g.nodes.length; j++) assert.equal(g.nodes[i].doesOverlap(g.nodes[j]), false, `${g.nodes[i].id} overlaps ${g.nodes[j].id}`);
  }
});

test('trees: a non-branching tree is put back into the graph', () => {
  const g = lg.newGraph();
  const nodes = [1, 2, 3, 4].map((id) => {
    const n = lg.newNode(BigInt(id), 40, 20);
    g.addNewNodeToContainer(null, n);
    return n;
  });
  g.connect(nodes[0], nodes[1]);
  g.connect(nodes[1], nodes[2]);
  g.connect(nodes[2], nodes[0]);
  g.connect(nodes[0], nodes[3]);
  trees.preprocess(ctx(), g);
  assert.equal(g.trees.size, 0);
  assert.equal(g.nodes.length, 4);
  assert.equal(g.edges.length, 4);
});

test('trees: cancellation rolls the graph back', () => {
  const g = lg.newGraph();
  const nodes = [1, 2].map((id) => {
    const n = lg.newNode(BigInt(id), 40, 20);
    g.addNewNodeToContainer(null, n);
    return n;
  });
  g.connect(nodes[0], nodes[1]);
  assert.throws(() => trees.preprocess(canceled(), g), (e) => errorsIs(e, context.Canceled));
  assert.equal(g.nodes.length, 2);
  assert.equal(g.edges.length, 1);
});
