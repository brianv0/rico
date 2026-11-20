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
const cspBlocked = [];
page.on('console', (m) => { if (m.type() !== 'error') return; if (/violates the following Content Security Policy/.test(m.text())) cspBlocked.push(m.text()); else errors.push(m.text()); });
let failed = false;
let nfail = 0;
const step = async (name, fn) => { try { await fn(); console.log('ok   ' + name); } catch (e) { failed = true; console.log('FAIL ' + name + '\n     ' + e.message.split('\n').slice(0, 6).join(' | ')); await page.screenshot({ path: path.join(root, 'e2e', `fail-${++nfail}.png`) }).catch(() => {}); } };

// Where is `t` on screen right now? Optionally scroll it to the middle of the window first.
const textBox = (t, scroll) => page.evaluate(([t, scroll]) => {
  const w = document.createTreeWalker(document.getElementById('doc'), NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    const i = n.data.indexOf(t);
    if (i < 0) continue;
    if (scroll) n.parentElement.scrollIntoView({ block: 'center' });
    const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + t.length);
    const b = r.getBoundingClientRect();
    return { l: b.left, r: b.right, y: b.top + b.height / 2 };
  }
  throw new Error('no text ' + t);
}, [t, scroll]);

// Wait until the composer reflects *this* selection. (Focusing its textarea clears the document
// selection, so compare against the composer's own copy of the quote, not getSelection().)
const settle = (from, to) => page.waitForFunction(([a, z]) => {
  const p = window.__rico.state.pending;
  return !!p && !document.getElementById('composer').hidden && p.quote.includes(a) && p.quote.includes(z);
}, [from.slice(0, 4), to.slice(0, 4)], { timeout: 5000 });

// Drag from the start of `from` to the end of `to` with the real mouse (both must fit on screen).
async function drag(from, to) {
  const A = await textBox(from, true), B = await textBox(to, false);
  await page.mouse.move(A.l + 1, A.y);
  await page.mouse.down();
  await page.mouse.move((A.l + B.r) / 2, (A.y + B.y) / 2, { steps: 5 });
  await page.mouse.move(B.r - 0.5, B.y, { steps: 5 });
  await page.mouse.up();
  await settle(from, to);
}
// For ranges taller than the window: click the start, scroll, then shift+click the end.
async function shiftSelect(from, to) {
  const A = await textBox(from, true);
  await page.mouse.click(A.l + 1, A.y);
  const B = await textBox(to, true);
  await page.keyboard.down('Shift');
  await page.mouse.click(B.r - 0.5, B.y);
  await page.keyboard.up('Shift');
  await settle(from, to);
}
const composerText = () => page.locator('#c-range').innerText();
const quote = () => page.evaluate(() => window.__rico.state.pending?.quote);

await page.goto(`http://localhost:${PORT}/`);
await page.fill('#pr', 'https://github.com/acme/docs/pull/7');
await page.click('#load button');
await page.waitForSelector('#doc h1');

await step('only markdown files are listed; patch-less/non-md ignored', async () => {
  assert.equal(await page.locator('#files button').count(), 3);
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
await step('quote option: off when the selection covers whole lines, on when it is only part of them', async () => {
  await drag('across', 'testing'); // all of source line 6
  assert.equal(await page.locator('#c-qinc').isChecked(), false);
  assert.match(await page.locator('#c-qnote').innerText(), /already shows/);
  await page.keyboard.press('Escape');
  await drag('paragraph is', 'hard'); // part of source line 5
  assert.equal(await page.locator('#c-qinc').isChecked(), true);
  await page.keyboard.press('Escape');
});
await step('quote option: code selections quote their source lines as a fenced block, and the quote is editable', async () => {
  await drag('const a', 'const b');
  assert.equal(await page.locator('#c-qinc').isChecked(), false); // GitHub already shows these lines
  await page.locator('#c-qinc').check();
  await page.locator('#c-qedit').click();
  assert.equal(await page.locator('#c-qtext').inputValue(), '```js\nconst a = 1;\nconst b = 2;\n```');
  await page.locator('#c-qtext').fill('```js\nconst a = 1;\n```'); // trim to the relevant part
  await page.fill('#c-body', 'Draft with an edited quote.');
  await page.keyboard.press('Control+Enter');
  const c = await page.evaluate(() => window.__rico.state.comments.at(-1));
  assert.equal(c.quoteMd, '```js\nconst a = 1;\n```'); assert.equal(c.includeQuote, true);
  await page.locator('#margin .thread.draft', { hasText: 'edited quote' }).getByRole('button', { name: 'Delete' }).click(); // leave no trace
  assert.equal(await page.evaluate(() => window.__rico.state.comments.length), 0);
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
  assert.deepEqual({ ...a }, { path: 'docs/plan.md', line: 6, side: 'RIGHT', start_line: 3, start_side: 'RIGHT', body: '> First paragraph here.\n>\n> Second paragraph is hard wrapped across two\n\nTighten this whole section.' });
  assert.equal(b.start_line, 9); assert.equal(b.line, 10);
  assert.equal(b.body, '_Selected lines 9–12; anchored to lines 9–10._\n\n> item two\n\n```js\nconst a = 1;\n```\n\nSpans hunks.');
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
// ---- diagrams (D2 + Mermaid), all client-side in sandboxed frames ----
// Viewport coordinates of an element inside the n-th diagram frame, scrolled into view.
const frameSpot = (n, kind, key) => page.evaluate(([n, kind, key]) => {
  const frame = document.querySelectorAll('#doc iframe.dia-frame')[n];
  frame.scrollIntoView({ block: 'center' });
  const d = frame.contentDocument;
  let el; let pt = null;
  if (kind === 'd2') { // D2 tags a group with base64(id); edge ids are stored HTML-escaped
    const g = d.querySelector(`g[class="${btoa(key.replace(/>/g, '&gt;'))}"]`);
    el = (key.startsWith('(') && g.querySelector('text')) || g;
  } else if (kind === 'm-node') el = [...d.querySelectorAll('g.node')].find((g) => new RegExp(`flowchart-${key}-\\d+$`).test(g.id));
  else if (kind === 'm-actor') el = d.querySelector(`rect.actor-top[name="${key}"]`);
  else if (kind === 'm-text') el = [...d.querySelectorAll('text.messageText')].find((t) => t.textContent.trim() === key);
  else if (kind === 'm-edge') {
    el = d.querySelector(`path[id$="-L_${key}"]`);
    const m = el.getPointAtLength(el.getTotalLength() / 2); const c = el.getScreenCTM();
    pt = { x: m.x * c.a + m.y * c.c + c.e, y: m.x * c.b + m.y * c.d + c.f };
  }
  if (!el) throw new Error(`no ${kind} ${key}`);
  el.scrollIntoView({ block: 'center', inline: 'center' }); // the frame is height-capped and scrolls internally
  frame.scrollIntoView({ block: 'center' });
  if (kind === 'm-edge') { const m = el.getPointAtLength(el.getTotalLength() / 2); const c = el.getScreenCTM(); pt = { x: m.x * c.a + m.y * c.c + c.e, y: m.x * c.b + m.y * c.d + c.f }; }
  const fr = frame.getBoundingClientRect(); const r = el.getBoundingClientRect();
  return { x: fr.left + (pt ? pt.x : r.left + r.width / 2), y: fr.top + (pt ? pt.y : r.top + r.height / 2) };
}, [n, kind, key]);
const clickIn = async (n, kind, key) => { const p = await frameSpot(n, kind, key); await page.mouse.click(p.x, p.y); await page.waitForSelector('#composer:not([hidden])'); };
const rangeLabel = async () => { const t = await page.locator('#c-range').innerText(); await page.keyboard.press('Escape'); return t; };

await step('diagrams: 4 render in sandboxed script-free frames, 2 broken ones show their errors', async () => {
  const external = [];
  page.on('response', (r) => { if (/terrastruct\.com/.test(r.url())) external.push(r.url()); }); // anything that actually got an answer
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.locator('#files button', { hasText: 'docs/diagrams.md' }).click();
  await page.waitForFunction(() => window.__rico.state.file?.filename === 'docs/diagrams.md');
  await page.waitForFunction(() => document.querySelectorAll('#doc iframe.dia-frame').length === 4 && document.querySelectorAll('#doc .dia-err').length === 2, null, { timeout: 90000 });
  assert.equal(await page.locator('#doc svg').count(), 0, 'diagram SVG lives inside the frames, never in the page');
  const attrs = await page.evaluate(() => [...document.querySelectorAll('#doc iframe.dia-frame')].map((f) => ({ sandbox: f.getAttribute('sandbox'), csp: /Content-Security-Policy[^>]*default-src 'none'/.test(f.srcdoc) })));
  assert.deepEqual(attrs, Array(4).fill({ sandbox: 'allow-same-origin', csp: true }));
  const errs = await page.locator('#doc .dia-err').allInnerTexts();
  assert.match(errs[0], /does not compile[\s\S]*line \d/); assert.match(errs[1], /does not compile[\s\S]*Parse error/i);
  assert.equal(await page.locator('#doc figure.dia').nth(1).locator('details').evaluate((d) => d.open), true, 'source opens on error');
  await page.waitForTimeout(600);
  assert.deepEqual(external, [], 'the hostile icon URL must never be fetched');
  assert.ok(cspBlocked.some((m) => /terrastruct\.com/.test(m) && /img-src/.test(m)), 'the frame CSP must have blocked the icon request');
  assert.equal(await page.evaluate(() => window.__pwned), undefined);
});
await step('diagrams: clicking the hostile node (javascript: link) executes nothing', async () => {
  await clickIn(1, 'd2', 'x');
  assert.equal(await page.evaluate(() => window.__pwned), undefined);
  assert.equal(await page.evaluate(() => document.querySelectorAll('#doc iframe.dia-frame')[1].contentWindow.__pwned), undefined);
  assert.match(await rangeLabel(), /node “x”/);
});
await step('diagrams: tall diagrams are height-capped and can be expanded', async () => {
  const h = () => page.evaluate(() => document.querySelector('#doc iframe.dia-frame').getBoundingClientRect().height);
  const small = await h();
  assert.ok(small <= 381, 'capped at 380px, got ' + small);
  await page.locator('#doc figure.dia .dia-zoom').first().click();
  const big = await h();
  assert.ok(big > small, `expanded ${big} should exceed ${small}`);
  await page.locator('#doc figure.dia .dia-zoom').first().click();
  assert.equal(Math.round(await h()), Math.round(small));
  assert.equal(await page.locator('#composer').isHidden(), true, 'the Expand button must not open a comment');
});
await step('D2: clicking empty space in a diagram comments on the whole block and quotes the source', async () => {
  const p = await page.evaluate(() => { const f = document.querySelector('#doc iframe.dia-frame'); f.scrollIntoView({ block: 'center' }); const r = f.getBoundingClientRect(); return { x: r.left + 6, y: r.top + 6 }; });
  await page.mouse.click(p.x, p.y);
  await page.waitForSelector('#composer:not([hidden])');
  assert.equal(await page.locator('#c-range').innerText(), 'Comments on lines 5–8');
  assert.equal(await page.locator('#c-qtext').inputValue(), '```d2\nbrowser -> server: request\nserver -> github: api call\n```');
  assert.equal(await page.locator('#c-qinc').isChecked(), false); // GitHub already shows those lines
  await page.keyboard.press('Escape');
});
await step('D2: clicking a node or an edge anchors to the exact source line that defines it', async () => {
  await clickIn(0, 'd2', 'github');
  assert.equal(await rangeLabel(), 'Comments on line 7 — node “github”');
  await clickIn(0, 'd2', 'server');
  assert.equal(await rangeLabel(), 'Comments on line 6 — node “server” (also on line 7)');
  await clickIn(0, 'd2', '(server -> github)[0]');
  assert.equal(await page.locator('#c-range').innerText(), 'Comments on line 7 — edge “(server -> github)[0]”');
  assert.equal(await page.locator('#c-qtext').inputValue(), '```d2\nserver -> github: api call\n```');
  await page.keyboard.press('Escape');
});
await step('diagrams: an element comment is stored with what it is about, and posts it to GitHub', async () => {
  await clickIn(0, 'd2', 'github');
  await page.fill('#c-body', 'Draft about the github node.');
  await page.keyboard.press('Control+Enter');
  const c = await page.evaluate(() => window.__rico.state.comments.at(-1));
  assert.equal(c.about, 'node “github”'); assert.equal(c.start, 7);
  await page.locator('#margin .thread.draft', { hasText: 'github node' }).getByRole('button', { name: 'Delete' }).click(); // leave no trace
  assert.equal(await page.evaluate(() => window.__rico.state.comments.length), 0);
});
await step('Mermaid: flowchart nodes and edges map to their lines', async () => {
  await clickIn(2, 'm-node', 'B');
  assert.equal(await rangeLabel(), 'Comments on line 27 — node “B”');
  await clickIn(2, 'm-node', 'C');
  assert.equal(await rangeLabel(), 'Comments on line 28 — node “C”');
  await clickIn(2, 'm-edge', 'B_C_0');
  assert.equal(await rangeLabel(), 'Comments on line 28 — edge “B → C”');
  await clickIn(2, 'm-edge', 'A_B_0');
  assert.equal(await rangeLabel(), 'Comments on line 27 — edge “A → B”');
});
await step('Mermaid: sequence actors and messages map to their lines', async () => {
  await clickIn(3, 'm-actor', 'R');
  assert.equal(await rangeLabel(), 'Comments on line 34 — actor “R”');
  await clickIn(3, 'm-text', 'comment box');
  assert.equal(await rangeLabel(), 'Comments on line 36 — label “comment box”');
});
await step('diagrams: the composer opens next to the clicked element, not at the top of the diagram', async () => {
  await clickIn(2, 'm-node', 'C');
  const [cTop, fTop, spot] = await page.evaluate(() => { const f = document.querySelectorAll('#doc iframe.dia-frame')[2].getBoundingClientRect(); return [document.getElementById('composer').getBoundingClientRect().top, f.top, null]; });
  assert.ok(cTop > fTop, `composer ${cTop} should sit below the frame top ${fTop}`);
  assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('composer')).display !== 'none'), true);
  await page.keyboard.press('Escape');
});
await step('diagrams: selecting inside the opened source narrows to the selected line', async () => {
  await page.locator('#doc figure.dia').first().locator('summary').click();
  await drag('server -> github', 'api call');
  assert.equal(await page.locator('#c-range').innerText(), 'Comments on line 7');
  await page.keyboard.press('Escape');
});
await step('diagrams: a selection across text and a diagram quotes prose then the d2 source', async () => {
  await shiftSelect('An intro', 'Text between'); // taller than the window: click, scroll, shift+click
  assert.equal(await page.locator('#c-range').innerText(), 'Comments on lines 3–10');
  const md = await page.locator('#c-qtext').inputValue();
  assert.match(md, /^> An intro paragraph before the first diagram\.\n\n```d2\nbrowser -> server: request\nserver -> github: api call\n```\n\n> Text between/);
  await page.keyboard.press('Escape');
});
await step('diagrams: without the optional dependencies the source is shown with a clear message', async () => {
  const p2 = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await p2.route('**/vendor/d2.js', (r) => r.fulfill({ status: 404, body: 'nope' }));
  await p2.route('**/vendor/mermaid.js', (r) => r.fulfill({ status: 404, body: 'nope' }));
  await p2.goto(`http://localhost:${PORT}/#pr=acme%2Fdocs%237&f=docs%2Fdiagrams.md`);
  await p2.waitForFunction(() => document.querySelectorAll('#doc .dia-err').length === 6, null, { timeout: 30000 });
  const t = await p2.locator('#doc .dia-err').allInnerTexts();
  assert.match(t[0], /not available[\s\S]*npm install @terrastruct\/d2/);
  assert.match(t[3], /not available[\s\S]*npm install mermaid/);
  assert.equal(await p2.locator('#doc figure.dia').first().locator('details').evaluate((d) => d.open), true);
  await p2.close();
});

await step('no page errors', async () => assert.deepEqual(errors, [], JSON.stringify(errors)));

await browser.close(); srv.kill(); await fake.close();
process.exit(failed ? 1 : 0);
