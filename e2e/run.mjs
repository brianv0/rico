// End-to-end: fake GitHub API + real Rico server + headless Chromium with real mouse drags.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFake, SHA } from '../test/fake-github.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const fake = await startFake();
const apiPort = fake.port;

const PORT = 4400 + Math.floor(Math.random() * 400);
const srv = spawn('node', ['server.js'], { cwd: root, env: { ...process.env, PORT, GITHUB_TOKEN: 't', GITHUB_API_URL: `http://127.0.0.1:${apiPort}` } });
await new Promise((r) => srv.stdout.on('data', (d) => String(d).includes('running') && r()));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
let failed = false;
let nfail = 0;
const step = async (name, fn) => { try { await fn(); console.log('ok   ' + name); } catch (e) { failed = true; console.log('FAIL ' + name + '\n     ' + e.message.split('\n')[0]); await page.screenshot({ path: path.join(root, 'e2e', `fail-${++nfail}.png`) }).catch(() => {}); } };

// Drag from the start of `from` to the end of `to` with the real mouse.
async function drag(from, to) {
  const pts = await page.evaluate(([a, b]) => {
    const find = (t) => { const w = document.createTreeWalker(document.getElementById('doc'), NodeFilter.SHOW_TEXT); for (let n = w.nextNode(); n; n = w.nextNode()) { const i = n.data.indexOf(t); if (i >= 0) { const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + t.length); return r.getBoundingClientRect(); } } throw new Error('no text ' + t); };
    const A = find(a), B = find(b);
    return { x1: A.left + 1, y1: A.top + A.height / 2, x2: B.right - 0.5, y2: B.top + B.height / 2 };
  }, [from, to]);
  await page.mouse.move(pts.x1, pts.y1);
  await page.mouse.down();
  await page.mouse.move((pts.x1 + pts.x2) / 2, (pts.y1 + pts.y2) / 2, { steps: 5 });
  await page.mouse.move(pts.x2, pts.y2, { steps: 5 });
  await page.mouse.up();
  // Wait until the composer reflects *this* drag. (Focusing its textarea clears the document
  // selection, so compare against the composer's own copy of the quote, not getSelection().)
  await page.waitForFunction(([a, z]) => {
    const p = window.__rico.state.pending;
    return !!p && !document.getElementById('composer').hidden && p.quote.startsWith(a) && p.quote.endsWith(z);
  }, [from.slice(0, 4), to.slice(-3)], { timeout: 5000 });
}
const composerText = () => page.locator('#c-range').innerText();
const quote = () => page.evaluate(() => window.__rico.state.pending?.quote);

await page.goto(`http://localhost:${PORT}/`);
await page.fill('#pr', 'https://github.com/acme/docs/pull/7');
await page.click('#load button');
await page.waitForSelector('#doc h1');

await step('only markdown files are listed; patch-less/non-md ignored', async () => {
  assert.equal(await page.locator('#files button').count(), 2);
});
await step('blocks carry source lines and diff classes', async () => {
  const cls = await page.evaluate(() => [...document.querySelectorAll('#doc > [data-l]')].map((e) => e.tagName + ':' + e.dataset.l + ':' + e.className).join(' | '));
  assert.match(cls, /P:2-3:chg/); assert.match(cls, /P:15-16:out/);
});
const noOverlap = () => page.evaluate(() => { const r = [...document.querySelectorAll('#margin .thread')].map((e) => e.getBoundingClientRect()).sort((a, b) => a.top - b.top); return r.every((x, i) => i === 0 || x.top >= r[i - 1].bottom - 0.5); });
await step('existing threads appear in the margin, aligned with their text', async () => {
  const cards = page.locator('#margin .thread');
  assert.equal(await cards.count(), 2); // other.md, LEFT-side and non-markdown comments are not shown
  const t = await cards.nth(0).innerText();
  assert.match(t, /alice/); assert.match(t, /bob/); assert.match(t, /Will trim it/);
  assert.equal(await cards.nth(0).locator('strong').innerText(), 'too long');
  assert.match(await cards.nth(1).innerText(), /carol[\s\S]*Outdated/);
  const [cardTop, pTop] = await page.evaluate(() => [document.querySelector('#margin .thread').getBoundingClientRect().top, document.querySelector('#doc p').getBoundingClientRect().top]);
  assert.ok(Math.abs(cardTop - pTop) < 3, `card ${cardTop} vs paragraph ${pTop}`);
  assert.equal(await noOverlap(), true);
  assert.match(await page.locator('#margin .note').innerText(), /1 thread on removed lines/);
  assert.equal(await page.locator('#doc .has-t').count(), 3); // lines 3-6 (two paragraphs) + the list item
});
await step('hovering a thread highlights its text; clicking text activates the thread', async () => {
  await page.locator('#margin .thread').nth(0).hover();
  assert.equal(await page.locator('#doc p.hl').count(), 2);
  await page.mouse.move(5, 5);
  await page.locator('#doc p').nth(0).click({ position: { x: 20, y: 8 } });
  assert.equal(await page.locator('#margin .thread.active').count(), 1);
});
await step('replying from the margin posts to GitHub and appends to the thread', async () => {
  const card = page.locator('#margin .thread').nth(0);
  await card.getByRole('button', { name: 'Reply' }).click();
  await card.locator('textarea').fill('Agreed, thanks.');
  await page.keyboard.press('Control+Enter');
  await page.waitForFunction(() => document.querySelectorAll('#margin .thread')[0].querySelectorAll('.msg').length === 3);
  assert.deepEqual(fake.replies, [{ to: 101, body: 'Agreed, thanks.' }]);
  assert.match(await page.locator('#margin .thread').nth(0).innerText(), /me[\s\S]*Agreed, thanks\./);
  assert.equal(await noOverlap(), true);
});
await step('selection inside one hard-wrapped paragraph narrows to a single line', async () => {
  await drag('across', 'testing');
  assert.equal(await composerText(), 'Comments on line 6');
  await page.keyboard.press('Escape');
});
await step('composer floats over the selection immediately', async () => {
  await drag('First', 'First paragraph here.');
  assert.equal(await page.locator('#composer').isVisible(), true);
  const [c, s] = await page.evaluate(() => [document.getElementById('composer').getBoundingClientRect().top, document.querySelector('#doc p').getBoundingClientRect().bottom]);
  assert.ok(c >= s - 2 && c - s < 40, `composer at ${c}, paragraph bottom ${s}`);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'c-body');
  await page.fill('#c-body', 'This reads awkwardly.');
  await page.screenshot({ path: path.join(root, 'e2e', 'composer.png'), clip: { x: 280, y: 80, width: 1120, height: 360 } });
  await page.keyboard.press('Escape');
});
await step('selection across paragraphs maps to the full line range', async () => {
  await drag('First paragraph', 'across two');
  assert.equal(await composerText(), 'Comments on lines 3–6');
  assert.match(await quote(), /^First paragraph here\.[\s\S]*across two$/);
  await page.fill('#c-body', 'Tighten this whole section.');
  await page.keyboard.press('Control+Enter');
  assert.equal(await page.locator('#list .card').count(), 1);
});
await step('range spanning two hunks clamps to the best hunk and says so', async () => {
  await drag('item two', 'const a');
  const t = await composerText();
  assert.match(t, /You selected lines 9–12; GitHub can anchor lines 9–10 \(one hunk\)/);
  await page.fill('#c-body', 'Spans hunks.');
  await page.keyboard.press('Control+Enter');
});
await step('selection outside the diff goes to the summary', async () => {
  await drag('Far away', 'the diff');
  assert.match(await composerText(), /outside the diff/);
  await page.fill('#c-body', 'Unanchored remark.');
  await page.keyboard.press('Control+Enter');
  assert.equal(await page.locator('#list .card').count(), 3);
});
await step('drafts show in the margin too, without overlapping', async () => {
  assert.equal(await page.locator('#margin .thread.draft').count(), 3);
  assert.match(await page.locator('#margin .thread.draft').nth(0).innerText(), /Draft[\s\S]*Tighten this whole section/);
  assert.equal(await noOverlap(), true);
});
await step('Submit stays reachable in a short window with several drafts queued', async () => {
  await page.setViewportSize({ width: 1400, height: 640 });
  const r = await page.evaluate(() => { const b = document.getElementById('submit').getBoundingClientRect(); return { top: b.top, bottom: b.bottom, h: innerHeight }; });
  assert.ok(r.top >= 0 && r.bottom <= r.h, `submit at ${r.top}-${r.bottom} in a ${r.h}px window`);
  await page.setViewportSize({ width: 1400, height: 900 });
});
await page.screenshot({ path: path.join(root, 'e2e', 'screenshot.png') });
await step('review is posted with correct anchors', async () => {
  await page.fill('#summary', 'Looks good overall.');
  await page.click('#submit');
  await page.waitForSelector('#result a');
  const posted = fake.posted[0];
  assert.equal(posted.commit_id, SHA);
  assert.equal(posted.event, 'COMMENT');
  const [a, b] = posted.comments;
  assert.deepEqual({ ...a }, { path: 'docs/plan.md', line: 6, side: 'RIGHT', start_line: 3, start_side: 'RIGHT', body: 'Tighten this whole section.' });
  assert.equal(b.start_line, 9); assert.equal(b.line, 10);
  assert.match(b.body, /^> item two[\s\S]*\n\nSpans hunks\.$/);
  assert.equal(posted.comments.length, 2);
  assert.match(posted.body, /Looks good overall\./);
  assert.match(posted.body, /L16\*\*\n> Far away paragraph outside the diff\n\nUnanchored remark\./);
});
await step('narrow screens stack comments under the text', async () => {
  await page.setViewportSize({ width: 1000, height: 900 });
  const [docBottom, cardTop, pos] = await page.evaluate(() => [document.getElementById('doc').getBoundingClientRect().bottom, document.querySelector('#margin .thread').getBoundingClientRect().top, getComputedStyle(document.querySelector('#margin .thread')).position]);
  assert.equal(pos, 'static'); assert.ok(cardTop >= docBottom - 1, `${cardTop} vs ${docBottom}`);
});
await step('line mapping is exact for every block and range in a complex document', async () => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.locator('#files button', { hasText: 'docs/complex.md' }).click();
  await page.waitForFunction(() => window.__rico.state.file?.filename === 'docs/complex.md' && document.querySelector('#doc h1'));
  const res = await page.evaluate(() => {
    const doc = document.getElementById('doc'), R = window.__rico, lines = R.state.lines;
    const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ');
    const words = (s) => norm(s).split(/\s+/).filter(Boolean);
    const hasWord = (line, w) => words(line).includes(w);
    const leaves = [...doc.querySelectorAll('[data-l]')].filter((e) => !e.querySelector('[data-l]'));
    const tn = (el) => { const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); const a = []; for (let n = w.nextNode(); n; n = w.nextNode()) if (n.data.trim()) a.push(n); return a; };
    const sel = (a, b) => { const A = tn(a), B = tn(b); if (!A.length || !B.length) return null; const r = document.createRange(); r.setStart(A[0], 0); const l = B[B.length - 1]; r.setEnd(l, l.data.length); return r; };
    const bad = []; let n = 0;
    const check = (i, j) => {
      const r = sel(leaves[i], leaves[j]); if (!r) return;
      const d = R.describeSelection(r); n++;
      if (!d) return bad.push({ i, j, why: 'null' });
      const w = words(r.toString()); const fw = w[0], lw = w[w.length - 1];
      const [s0, s1] = leaves[i].dataset.l.split('-').map(Number), [e0, e1] = leaves[j].dataset.l.split('-').map(Number);
      const p = [];
      if (d.start < s0 + 1 || d.start > s1) p.push('start outside first block');
      if (d.end < e0 + 1 || d.end > e1) p.push('end outside last block');
      // skip punctuation-only lines (e.g. a closing brace) at the edges when matching words
      const eff = (ln, dir) => { let k = ln; while (k >= 1 && k <= lines.length && !words(lines[k - 1]).length) k += dir; return k; };
      const ks = eff(d.start, 1), ke = eff(d.end, -1);
      if (fw && !hasWord(lines[ks - 1] || '', fw)) p.push(`first "${fw}" not on L${d.start}: ${lines[d.start - 1]}`);
      if (lw && !hasWord(lines[ke - 1] || '', lw)) p.push(`last "${lw}" not on L${d.end}: ${lines[d.end - 1]}`);
      if (p.length) bad.push({ tag: leaves[i].tagName, i, j, d: [d.start, d.end], p });
    };
    for (let i = 0; i < leaves.length; i++) { check(i, i); for (let j = i + 1; j < Math.min(leaves.length, i + 8); j++) check(i, j); }
    const tags = new Set(leaves.map((e) => e.tagName + (e.dataset.k || '')));
    return { n, tags: [...tags], bad: bad.slice(0, 6) };
  });
  for (const t of ['PRE', 'CODEfence', 'TR', 'LI', 'P', 'H2']) assert.ok(res.tags.includes(t) || t === 'PRE', 'fixture lacks ' + t);
  assert.ok(res.n > 150, 'only ' + res.n + ' checks');
  assert.equal(await page.evaluate(() => document.querySelector('#doc img').naturalWidth), 1, 'relative image should load from the PR head');
  assert.deepEqual(res.bad, [], JSON.stringify(res.bad));
});
await step('no page errors', async () => assert.deepEqual(errors, [], JSON.stringify(errors)));

await browser.close(); srv.kill(); await fake.close();
process.exit(failed ? 1 : 0);
