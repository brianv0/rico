// Unit tests of the TALA placement package (public/d2/tala/placement/): a replay of recorded Go pipelines (tools/d2ref/tala/placefixture.mjs)
// and cheap checks of the libm replacements. The full comparisons against Go are tools/d2ref/tala/placecheck.mjs (--full, --chain); no Go needed here.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as bigjson from '../public/d2/tala/bigjson.js';
import * as graphjson from '../public/d2/tala/graphjson.js';
import { background } from '../public/d2/tala/context.js';
import * as engine from '../public/d2/tala/engine.js';
import { goCos, goSin, goPowPos } from '../public/d2/tala/placement/gotrig.js';
import * as placement from '../public/d2/tala/placement/index.js';

test('placement exports every stage function the pipeline looks up', () => {
  for (const name of ['prescale', 'prepare', 'place', 'swap', 'transposeAll', 'align', 'balanceSymmetry', 'normalizeGaps', 'optimizeClusters', 'equidistance', 'dejitter', 'pad', 'normalize']) {
    assert.equal(typeof placement[name], 'function', name);
  }
});

test('gotrig: Go math.Sin/Cos known answers (amd64 pure-Go Cephes), special cases', () => {
  assert.equal(goCos(0), 1);
  assert.equal(goSin(0), 0);
  assert.ok(Object.is(goSin(-0), -0));
  assert.ok(Number.isNaN(goSin(Infinity)));
  assert.ok(Number.isNaN(goCos(NaN)));
  assert.equal(goCos(Math.PI / 2), 6.123233995736757e-17);
  assert.equal(goSin(Math.PI), 1.2246467991473515e-16);
  assert.equal(goPowPos(3, 2), 9);
  assert.equal(goPowPos(4, 0.5), 2);
});

test('replay of recorded Go pipelines: stages 0-20 identical (graph and deep state)', async () => {
  const t1 = await import('../tools/d2ref/tala/t1check.mjs');
  const { observeStages } = await import('../tools/d2ref/tala/enginecheck.mjs');
  const cases = bigjson.parse(fs.readFileSync(new URL('./fixtures/tala-placement-stages.json', import.meta.url), 'utf8'));
  assert.ok(cases.length >= 4);
  const ctx = background();
  for (const c of cases) {
    const byIndex = new Map(c.stages.map((s) => [s.index, s]));
    const g = t1.reconstruct(byIndex.get(-1));
    const p = new engine.Pipeline(g, BigInt(c.seed), false);
    const STOP = new Error('stop');
    let compared = 0;
    const restore = observeStages((index, name, graph) => {
      if (index > 20) throw STOP;
      const want = byIndex.get(index);
      const got = { index, graph: graphjson.serialize(ctx, graph), deep: t1.deepState(graph) };
      assert.equal(t1.firstDiff(bigjson.plain(got), bigjson.plain({ index, graph: want.graph, deep: want.deep })), null, `${c.name} stage ${index}`);
      compared++;
    });
    try {
      p.runAllStages(ctx);
    } catch (e) {
      if (e !== STOP && e.constructor?.name !== 'NotPorted') throw e;
    } finally {
      restore();
    }
    assert.equal(compared, 21, c.name);
  }
});
