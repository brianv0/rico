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

test('d2lib compiles boards and fails clearly for elk', async () => {
  const r = await compile('a\nlayers: { l: { b } }');
  assert.equal(r.diagram.layers.length, 1);
  const elk = await compile('a -> b', { layout: 'elk' });
  assert.equal(elk.err.name, 'ElkNotPorted');
});
