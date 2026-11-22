import { test } from 'node:test';
import assert from 'node:assert/strict';
import markdownit from 'markdown-it';
import { init, compile } from '../public/d2/d2lib.js';

await init({ markdownit });

test('d2lib compiles and lays out with dagre', async () => {
  const { diagram, graph, err } = await compile('a -> b: hi\nc: {d}');
  assert.equal(err, null);
  assert.equal(graph.objects.length, 4);
  assert.deepEqual(diagram.shapes.map((s) => s.id), ['a', 'b', 'c', 'c.d']);
  assert.equal(diagram.connections[0].label, 'hi');
  assert.ok(diagram.connections[0].route.length >= 2);
});

test('d2lib reads imports from the fs option and reports parse errors', async () => {
  const ok = await compile('x: @y', { fs: { 'index.d2': 'x: @y', 'y.d2': 'q -> r' }, inputPath: 'index.d2' });
  assert.equal(ok.err, null);
  assert.deepEqual(ok.diagram.shapes.map((s) => s.id), ['x', 'x.q', 'x.r']);
  const bad = await compile('a: {');
  assert.equal(bad.diagram, null);
  assert.match(bad.err.message, /maps must be terminated/);
});

test('d2lib compiles boards', async () => {
  const r = await compile('a\nlayers: { l: { b } }');
  assert.equal(r.diagram.layers.length, 1);
});

test('d2lib lays out with ELK, loaded on demand (compile loads it; compileSync needs loadLayout)', async () => {
  const { compileSync } = await import('../public/d2/d2lib.js');
  const r = await compile('a -> b: hi\nc: {d}\nb -> c.d', { layout: 'elk' });
  assert.equal(r.err, null);
  assert.deepEqual(r.diagram.shapes.map((s) => s.id), ['a', 'b', 'c', 'c.d']);
  assert.ok(r.diagram.connections.every((c) => c.route.length >= 2));
  // the engine is also picked by d2-config
  const viaConfig = await compile('vars: {d2-config: {layout-engine: elk}}\na -> b');
  assert.equal(viaConfig.err, null);
  assert.equal(viaConfig.diagram.shapes.length, 2);
  // ELK options as the --elk-* flags give them
  const wide = await compile('a -> b', { layout: 'elk', elkOpts: { 'elk.algorithm': 'layered', 'spacing.nodeNodeBetweenLayers': 200, 'elk.padding': '[top=50,left=50,bottom=50,right=50]', 'spacing.edgeNodeBetweenLayers': 40, 'elk.spacing.nodeSelfLoop': 50 } });
  const dflt = await compile('a -> b', { layout: 'elk' });
  assert.ok(wide.diagram.shapes[1].pos.y > dflt.diagram.shapes[1].pos.y);
  assert.equal(typeof compileSync, 'function');
});
