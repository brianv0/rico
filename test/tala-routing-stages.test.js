// Replay of recorded Go stage runs (test/fixtures/tala-routing-stages.json, made with tools/d2ref/tala/routestagecheck.mjs --save from xdump's
// `routecases`) through the JS stage half of the routing port: no Go needed. Every case is Go's graph before a stage with its deep state and
// Go's graph after it; the whole comparison against Go is `node tools/d2ref/tala/routestagecheck.mjs check <corpus>`.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as bigjson from '../public/d2/tala/bigjson.js';
import * as context from '../public/d2/tala/context.js';
import * as routing from '../public/d2/tala/routing/index.js';
import { checkCase } from '../tools/d2ref/tala/routestagecheck.mjs';

const cases = bigjson.parse(fs.readFileSync(new URL('./fixtures/tala-routing-stages.json', import.meta.url), 'utf8'));

for (const c of cases) {
  test(`routing stage ${c.kind}: ${c.name} is identical to Go`, () => {
    assert.equal(checkCase(c), null);
  });
}

test('routing stages: the stage functions the engine looks up exist', () => {
  for (const name of ['routeGraph', 'routeGraphWithWorkLimit', 'simplifyEdgeRoutes', 'shortcutEdgeRoutes', 'straightEdgesFallback', 'traceEdgesToShapeBorder',
    'balanceEdgeSegments', 'nudgeEdgeChannels', 'fixClusterEdgeBranching', 'reorderDuplicates', 'swapAllEdgePorts', 'crosshatch', 'routeEdges']) {
    assert.equal(typeof routing[name], 'function', name);
  }
});

test('routing stages: a canceled context fails the stage and leaves the graph as it was', () => {
  const c = cases.find((x) => x.kind === 'balance');
  const [canceled, cancel] = context.withCancel(context.background());
  cancel();
  assert.throws(() => routing.balanceEdgeSegments(canceled, loadForTest(c)), /context canceled/);
});

import { loadGraph } from '../tools/d2ref/tala/pkgcheck.mjs';
function loadForTest(c) {
  return loadGraph(c);
}
