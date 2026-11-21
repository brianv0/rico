import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import markdownit from 'markdown-it';
import { init, compile } from '../public/d2/d2lib.js';
import { renderAsync, renderMultiboardAsync, Deferred } from '../public/d2/d2svg.js';
import { zlibCompress } from '../public/d2/flate.js';
import { getEncodedSubset } from '../public/d2/fontsubset.js';
import { firstLineSegmentInString } from '../public/d2/linebreak.js';

await init({ markdownit });

test('flate: the zlib streams (a port of Go compress/zlib at the default level) inflate to the input', () => {
  let seed = 7;
  const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  for (const size of [0, 1, 20, 33, 127, 128, 1000, 5000, 70000, 140000]) {
    for (const kind of ['random', 'text', 'sparse']) {
      const b = new Uint8Array(size);
      for (let i = 0; i < size; i++) b[i] = kind === 'random' ? (rnd() * 256) | 0 : kind === 'text' ? 97 + ((rnd() * rnd() * 6) | 0) : rnd() < 0.05 ? (rnd() * 256) | 0 : 0;
      const z = zlibCompress(b);
      assert.deepEqual(new Uint8Array(zlib.inflateSync(z)), b, `${kind} ${size}`);
    }
  }
});

test('fonts: a subset is a WOFF with only the glyphs asked for', async () => {
  const { loadFont } = await import('../public/d2/d2svgfonts.js');
  await loadFont('SourceSansPro-Regular.ttf');
  const { readFile } = await import('node:fs/promises');
  const ttf = new Uint8Array(await readFile(new URL('../public/d2/fonts/SourceSansPro-Regular.ttf', import.meta.url)));
  const url = getEncodedSubset(ttf, 'hello hello');
  assert.match(url, /^data:application\/font-woff;base64,/);
  const bytes = Buffer.from(url.split(',')[1], 'base64');
  assert.equal(bytes.toString('latin1', 0, 4), 'wOFF');
  assert.ok(bytes.length < 6000, `a subset of 5 letters is small (${bytes.length})`);
});

test('linebreak: UAX 14 segments like uniseg', () => {
  const segs = [];
  let rest = 'hello world foo-bar (x) a/b';
  let state = -1;
  while (rest) {
    const [seg, r, , ns] = firstLineSegmentInString(rest, state);
    if (!seg) break;
    segs.push(seg);
    rest = r;
    state = ns;
  }
  assert.deepEqual(segs, ['hello ', 'world ', 'foo-', 'bar ', '(x) ', 'a/', 'b']);
});

test('d2svg renders a compiled diagram: fonts embedded (default) or referenced (external)', async () => {
  const ro = {};
  const { diagram, err } = await compile('a -> b: hello\nb.shape: circle', {}, ro);
  assert.equal(err, null);
  const embedded = await renderAsync(diagram, { ...ro, fonts: 'embed' });
  assert.match(embedded, /^<\?xml version="1.0" encoding="utf-8"\?><svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
  assert.match(embedded, /<marker id="mk-d2-/);
  assert.match(embedded, /src: url\("data:application\/font-woff;base64,/);
  const external = await renderAsync(diagram, { ...ro, fonts: 'external', fontBaseURL: '/d2/fonts/' });
  assert.ok(!external.includes('base64'));
  assert.match(external, /src: url\("\/d2\/fonts\/SourceSansPro-Bold\.ttf"\)/);
  assert.ok(external.length < embedded.length);
  // the same hash and geometry either way
  assert.equal(external.match(/class="(d2-\d+) d2-svg"/)[1], embedded.match(/class="(d2-\d+) d2-svg"/)[1]);
});

test('d2svg: Markdown labels are native SVG text, boards render separately, sketch is deferred', async () => {
  const ro = {};
  const { diagram } = await compile('m: |md\n  # Title\n\n  - **bold** item\n|\nlayers: { l: { x } }', {}, ro);
  const svg = await renderAsync(diagram, { ...ro, fonts: 'external' });
  assert.match(svg, /<g class="md md-native">/);
  assert.ok(!svg.includes('foreignObject'));
  assert.equal((await renderMultiboardAsync(diagram, { ...ro, fonts: 'external' })).length, 2);
  await assert.rejects(renderAsync(diagram, { ...ro, sketch: true, fonts: 'external' }), (e) => e instanceof Deferred && e.reason === 'sketch');
});
