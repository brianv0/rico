// Unit tests of the CORE of the TALA routing port (public/d2/tala/routing/*.js). The comparison against Go itself is
// tools/d2ref/tala/routingcheck.mjs (all recorded RouteGraph calls of the corpus); these are the cheap ones that need no Go: a few ports of
// the Go package's own tests and the replay of calls that Go recorded (test/fixtures/tala-routing-calls.json, made with tala/xdump.bin's
// `routing` mode).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as geo from '../public/d2/geo.js';
import * as context from '../public/d2/tala/context.js';
import * as lg from '../public/d2/tala/layoutgraph.js';
import * as bigjson from '../public/d2/tala/bigjson.js';
import { errorsIs } from '../public/d2/tala/goerrors.js';
import * as routing from '../public/d2/tala/routing/core.js';
import { checkCall } from '../tools/d2ref/tala/routingreplay.mjs';

const ctx = () => context.background();

test('routing: priority queue pops in priority order, then insertion order; decrease reorders', () => {
  const q = new routing.PriorityQueue();
  const large = q.push(3, null, false, null);
  const medium = q.push(2, null, false, null);
  const small = q.push(1, null, false, null);
  for (const want of [small, medium, large]) assert.equal(q.pop(null), want);
  assert.ok(q.empty());
  assert.throws(() => q.pop(null), /empty priority queue/);

  const q2 = new routing.PriorityQueue();
  const entry = q2.push(3, null, false, null);
  q2.push(2, null, false, null);
  q2.decrease(entry, 1, null);
  assert.equal(q2.pop(null), entry);
  assert.throws(() => q2.decrease(entry, 0, null), /not in the priority queue|empty/);

  // equal priorities are popped in insertion order whatever the heap shape
  const q3 = new routing.PriorityQueue();
  const entries = Array.from({ length: 50 }, () => q3.push(7, null, false, null));
  for (const want of entries) assert.equal(q3.pop(null), want);
});

test('routing: ideal turn axes follow the box arrangement', () => {
  const source = lg.newNode(1n, 20, 20);
  source.topLeft = geo.newPoint(100, 100);
  const target = lg.newNode(2n, 20, 20);
  target.topLeft = geo.newPoint(0, 0);
  assert.deepEqual(routing.idealTurnAxes(source, target), [{ isX: true, val: 60 }, { isX: false, val: 60 }]);
  target.topLeft = geo.newPoint(105, 105);
  assert.deepEqual(routing.idealTurnAxes(source, target), []);
});

test('routing: crossings of routes and the guarded cost', () => {
  const first = new lg.Edge();
  first.points = [geo.newPoint(0, 0), geo.newPoint(10, 10)];
  const second = new lg.Edge();
  second.points = [geo.newPoint(0, 10), geo.newPoint(10, 0)];
  assert.equal(routing.countNonSharedCrossings(first, second), 1);
  const want = first.length() + lg.CrossingCostWeight;
  assert.equal(routing.estimateRouteCost([first, second], first), want);

  const guard = routing.newRouteWorkGuard(ctx(), 'route cost', 4);
  assert.equal(routing.estimateRouteCostGuarded([first, second], first, guard), want);
  assert.equal(guard.used, 4);
  const limited = routing.newRouteWorkGuard(ctx(), 'route cost', 3);
  assert.throws(() => routing.estimateRouteCostGuarded([first, second], first, limited), (e) => errorsIs(e, routing.errRouteStageWorkLimit));
});

test('routing: segments against boxes and orientation', () => {
  const box = geo.newBox(geo.newPoint(10, 10), 10, 10);
  assert.ok(routing.segmentIntersectsBox(geo.newPoint(0, 15), geo.newPoint(30, 15), box));
  assert.ok(!routing.segmentIntersectsBox(geo.newPoint(0, 5), geo.newPoint(30, 5), box));
  assert.ok(routing.segmentIntersectsBox(geo.newPoint(0, 0), geo.newPoint(30, 30), box));
  assert.ok(!routing.segmentIntersectsBox(geo.newPoint(0, 30), geo.newPoint(9, 30), box));
  assert.ok(routing.intersects(geo.newPoint(0, 0), geo.newPoint(4, 0), geo.newPoint(2, 0), geo.newPoint(8, 0))); // collinear overlap
  assert.ok(!routing.intersects(geo.newPoint(0, 0), geo.newPoint(1, 0), geo.newPoint(2, 0), geo.newPoint(8, 0)));
});

test('routing: the OVG edge set finds overlaps and crossings, and its guard charges the work', () => {
  const n = (x, y) => new routing.OVGNode(geo.newPoint(x, y));
  const set = new routing.OvgEdgeSet();
  const a = n(0, 0), b = n(10, 0), c = n(5, -5), d = n(5, 5);
  set.add(new routing.OVGEdge(a, b));
  assert.ok(set.intersectsWithGuarded(new routing.OVGEdge(c, d), null)); // crosses the horizontal edge
  assert.ok(!set.intersectsWithGuarded(new routing.OVGEdge(n(20, -5), n(20, 5)), null));
  // an overlap on the same line that does not share a point
  assert.ok(set.intersectsWithGuarded(new routing.OVGEdge(n(2, 0), n(7, 0)), null));
  assert.equal(set.overlappingEdgesGuarded(new routing.OVGEdge(n(2, 0), n(7, 0)), null).length, 1);
  const guard = routing.newRouteWorkGuard(ctx(), 'edge set', 1000);
  set.addGuarded(new routing.OVGEdge(c, d), guard);
  assert.ok(guard.used > 0);
});

test('routing: route search work guard limit, flavors and telemetry', () => {
  const guard = routing.newRouteSearchWorkGuard(ctx(), routing.Default, 3);
  guard.step(); guard.step(); guard.step();
  assert.throws(() => guard.step(), (e) => errorsIs(e, routing.errRouteSearchWorkLimit) && /flavor Default work exceeds limit 3/.test(e.message));
  const telemetry = new routing.SearchTelemetry();
  const guard2 = routing.newRouteSearchWorkGuard(routing.withSearchTelemetry(ctx(), telemetry), routing.Default, 100);
  guard2.step();
  guard2.finish();
  assert.deepEqual(telemetry.workSamples(), [1]);
});

test('routing: the calls Go recorded replay to identical OVGs, routes, distances and work counts', () => {
  const calls = bigjson.parse(fs.readFileSync(new URL('./fixtures/tala-routing-calls.json', import.meta.url), 'utf8'));
  let n = 0;
  for (const [name, list] of Object.entries(calls)) {
    for (const { stage, call } of list) {
      assert.equal(checkCall(call, {}), null, `${name} stage ${stage}`);
      n++;
    }
  }
  assert.ok(n >= 5);
});
