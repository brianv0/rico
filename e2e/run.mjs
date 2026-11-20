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

// Where is `t` on screen right now? Searches the active document's text across element boundaries
// (syntax highlighting splits code into many spans). Optionally scrolls it to the middle first.
const textBox = (t, scroll) => page.evaluate(([t, scroll]) => {
  const w = document.createTreeWalker(document.getElementById('doc'), NodeFilter.SHOW_TEXT);
  const nodes = [];
  let full = '';
  for (let n = w.nextNode(); n; n = w.nextNode()) { nodes.push({ n, start: full.length }); full += n.data; }
  const i = full.indexOf(t);
  if (i < 0) throw new Error('no text ' + t);
  const locate = (pos) => { for (let k = nodes.length - 1; k >= 0; k--) if (nodes[k].start <= pos) return { node: nodes[k].n, off: pos - nodes[k].start }; };
  const a = locate(i);
  const z = locate(i + t.length - 1);
  if (scroll) a.node.parentElement.scrollIntoView({ block: 'center' });
  const r = document.createRange(); r.setStart(a.node, a.off); r.setEnd(z.node, z.off + 1);
  const rects = r.getClientRects(); const first = rects[0]; const last = rects[rects.length - 1];
  return { l: first.left, r: last.right, y: first.top + first.height / 2 };
}, [t, scroll]);

// Wait until the composer reflects *this* selection. (Focusing its textarea clears the document
// selection, so compare against the composer's own copy of the quote, not getSelection().)
const settle = async (from, to) => {
  // the selection first offers two margin icons; the "lines" one opens the composer with the default quote choice
  await page.waitForFunction(([a, z]) => { const p = window.__rico.state.sel; return !!p && !document.getElementById('selbar').hidden && p.quote.includes(a) && p.quote.includes(z); }, [from.slice(0, 4), to.slice(0, 4)], { timeout: 5000 });
  await page.click('#sb-lines');
  await page.waitForFunction(([a, z]) => {
    const p = window.__rico.state.pending;
    return !!p && !document.getElementById('composer').hidden && p.quote.includes(a) && p.quote.includes(z);
  }, [from.slice(0, 4), to.slice(0, 4)], { timeout: 5000 });
};

// Drag from the start of `from` to the end of `to` with the real mouse (both must fit on screen).
async function drag(from, to) { await dragRaw(from, to); await settle(from, to); }
async function dragRaw(from, to) {
  const A = await textBox(from, true), B = await textBox(to, false);
  await page.mouse.move(A.l + 1, A.y);
  await page.mouse.down();
  await page.mouse.move((A.l + B.r) / 2, (A.y + B.y) / 2, { steps: 5 });
  await page.mouse.move(B.r - 0.5, B.y, { steps: 5 });
  await page.mouse.up();
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
  assert.equal(await page.locator('#files button').count(), 5);
});
await step('blocks carry source lines and diff classes', async () => {
  const cls = await page.evaluate(() => [...document.querySelectorAll('#doc > [data-l]')].map((e) => e.tagName + ':' + e.dataset.l + ':' + e.className).join(' | '));
  assert.match(cls, /P:2-3:chg/); assert.match(cls, /P:15-16:out/);
});
const noOverlap = () => page.evaluate(() => { const r = [...document.querySelectorAll('#margin .thread')].map((e) => e.getBoundingClientRect()).sort((a, b) => a.top - b.top); return r.every((x, i) => i === 0 || x.top >= r[i - 1].bottom - 0.5); });
// the first <p> that is not a removed block (plan.md now shows its removed subtitle above it)
const keptP = () => page.evaluate(() => { const p = [...document.querySelectorAll('#doc p')].find((x) => !x.closest('.rm')); const r = p.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; });
await step('existing threads appear in the margin, aligned with their text (left-side ones beside removed blocks)', async () => {
  const cards = page.locator('#margin .thread');
  assert.equal(await cards.count(), 3); // 101 (+ reply), 103 (outdated) and 105 (left side, now beside the removed subtitle)
  const main = cards.filter({ hasText: 'Will trim it' });
  const t = await main.innerText();
  assert.match(t, /alice/); assert.match(t, /bob/);
  assert.equal(await main.locator('strong').innerText(), 'too long');
  assert.match(await cards.filter({ hasText: 'Outdated note' }).innerText(), /carol[\s\S]*Outdated/);
  // the thread on line 3-6 sits level with the paragraph it is about; the left-side one with the removed block
  const tops = await page.evaluate(() => {
    const top = (e) => e.getBoundingClientRect().top;
    const card = (txt) => [...document.querySelectorAll('#margin .thread')].find((c) => c.innerText.includes(txt));
    return { main: top(card('Will trim it')), p: top([...document.querySelectorAll('#doc p')].find((x) => !x.closest('.rm'))), left: top(card('On a removed line')), rm: top(document.querySelector('#doc .rm [data-l]')) }; // the removed text itself (the red box has padding around it)
  });
  assert.ok(Math.abs(tops.left - tops.rm) < 3, `left thread ${tops.left} vs removed block ${tops.rm}`);
  assert.ok(tops.main >= tops.p - 3 && tops.main - tops.p < 220, `thread ${tops.main} vs paragraph ${tops.p}`); // never above its text; pushed down only by the card above it
  assert.equal(await noOverlap(), true);
  assert.equal(await page.locator('#margin .note').count(), 0, 'every thread has a place now');
  assert.equal(await page.locator('#doc .has-t').count(), 4); // the removed subtitle + lines 3-6 (two paragraphs) + the list item
});
await step('hovering a thread highlights its text; clicking text activates the thread', async () => {
  await page.locator('#margin .thread', { hasText: 'Will trim it' }).hover();
  assert.equal(await page.locator('#doc p.hl').count(), 2);
  await page.mouse.move(5, 5);
  await page.getByText('First paragraph here.').first().click({ position: { x: 20, y: 8 } });
  assert.equal(await page.locator('#margin .thread.active').count(), 1);
});
await step('replying from the margin posts to GitHub and appends to the thread', async () => {
  const card = page.locator('#margin .thread', { hasText: 'Will trim it' });
  await card.getByRole('button', { name: 'Reply' }).click();
  await card.locator('textarea').fill('Agreed, thanks.');
  await page.keyboard.press('Control+Enter');
  await page.waitForFunction(() => [...document.querySelectorAll('#margin .thread')].some((c) => c.innerText.includes('Will trim it') && c.querySelectorAll('.msg').length === 3));
  assert.deepEqual(fake.replies, [{ to: 101, body: 'Agreed, thanks.' }]);
  assert.match(await page.locator('#margin .thread', { hasText: 'Will trim it' }).innerText(), /me[\s\S]*Agreed, thanks\./);
  assert.equal(await noOverlap(), true);
});
// ---- source diff view ----
const card = (path) => page.locator(`.file-card[data-path="${path}"]`);
await step('source diff: unified diff with both line numbers, hunks and GitHub diff colours', async () => {
  const c = card('docs/plan.md');
  await c.getByRole('button', { name: 'Source diff' }).click();
  assert.equal(await c.locator('.rico-src .d-add').count(), 4);
  assert.equal(await c.locator('.rico-src .d-del').count(), 1);
  assert.equal(await c.locator('.rico-src .d-hunk').count(), 2);
  const del = c.locator('.d-del').first();
  assert.equal(await del.locator('.d-num[data-side="LEFT"]').innerText(), '2'); // a removed line has only an old number
  assert.equal(await del.locator('.d-num[data-side="RIGHT"]').innerText(), '');
  const add = c.locator('.d-add').first();
  assert.equal(await add.locator('.d-num[data-side="RIGHT"]').innerText(), '3'); // an added line has only a new number
  const bg = (loc) => loc.evaluate((e) => getComputedStyle(e).backgroundColor);
  assert.notEqual(await bg(add.locator('.d-code')), 'rgba(0, 0, 0, 0)'); assert.notEqual(await bg(del.locator('.d-code')), 'rgba(0, 0, 0, 0)');
  assert.notEqual(await bg(add.locator('.d-code')), await bg(del.locator('.d-code')), 'additions and deletions are coloured differently');
  assert.equal(await c.locator('.rico-doc').isHidden(), true);
  assert.equal(await c.getByRole('button', { name: 'Source diff' }).getAttribute('aria-pressed'), 'true');
});
await step('source diff: existing threads sit under their lines, left-side ones under the removed line', async () => {
  const c = card('docs/plan.md');
  const under = (sel) => c.locator(sel).locator('xpath=following-sibling::tr[1]');
  assert.equal(await under('tr.d-row[data-new="6"]').getAttribute('class'), 'thread-row');
  assert.match(await under('tr.d-row[data-new="6"]').innerText(), /alice[\s\S]*Will trim it/);
  assert.match(await under('tr.d-del[data-old="2"]').innerText(), /On a removed line/);
  assert.match(await c.locator('.src-note').innerText(), /1 outdated thread/);
});
await step('source diff: "+" comments on a line, shift-click extends inside the hunk, removed lines use the LEFT side', async () => {
  const c = card('docs/plan.md');
  const num = (side, line) => c.locator(`.d-num[data-side="${side}"][data-line="${line}"]`);
  const range = () => page.locator('#c-range').innerText();
  await num('RIGHT', 3).hover();
  await num('RIGHT', 3).locator('.d-plus').click();
  await page.waitForSelector('#composer:not([hidden])');
  assert.equal(await range(), 'Comments on line 3');
  assert.equal(await page.locator('#doc .d-sel, .d-sel').count(), 1);
  await page.keyboard.press('Escape');
  await num('RIGHT', 5).click(); await page.keyboard.press('Escape');
  await num('RIGHT', 6).click({ modifiers: ['Shift'] });
  assert.equal(await range(), 'Comments on lines 5–6');
  assert.equal(await page.locator('.d-sel').count(), 2);
  await page.keyboard.press('Escape');
  await num('RIGHT', 13).click({ modifiers: ['Shift'] }); // another hunk: a range cannot cross it, so this starts fresh
  assert.equal(await range(), 'Comments on line 13');
  await page.keyboard.press('Escape');
  await num('LEFT', 2).click(); // the removed line
  assert.equal(await range(), 'Comments on removed line 2');
  await page.fill('#c-body', 'Why was this subtitle removed?');
  await page.keyboard.press('Control+Enter');
  const last = await page.evaluate(() => window.__rico.state.comments.at(-1));
  assert.deepEqual({ side: last.side, start: last.start, end: last.end, exact: last.anchor.exact, inc: last.includeQuote }, { side: 'LEFT', start: 2, end: 2, exact: true, inc: false });
  assert.match(await c.locator('tr.d-del[data-old="2"]').locator('xpath=following-sibling::tr[1]').innerText(), /Pending[\s\S]*Why was this subtitle removed/);
  await c.locator('.thread-row .thread.draft').getByRole('button', { name: 'Delete' }).click(); // leave no trace
  assert.equal(await page.evaluate(() => window.__rico.state.comments.length), 0);
});
await step('source diff: switching back to Rendered restores the document and its margin threads', async () => {
  const c = card('docs/plan.md');
  await c.getByRole('button', { name: 'Rendered' }).click();
  assert.equal(await c.locator('.rico-doc').isVisible(), true);
  assert.equal(await c.locator('.rico-src').isHidden(), true);
  assert.equal(await c.locator('.rico-margin .thread').count(), 3);
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
await step('a selection offers two margin icons; the composer opens beside the text, not over it; clearing the selection hides them', async () => {
  await dragRaw('First', 'First paragraph here.');
  await page.waitForSelector('#selbar:not([hidden])');
  assert.equal(await page.locator('#composer').isHidden(), true, 'nothing pops up until an icon is clicked');
  assert.equal(await page.locator('#selbar button').count(), 2);
  const geo = () => page.evaluate(() => {
    const r = (e) => e.getBoundingClientRect();
    const p = [...document.querySelectorAll('#doc p')].find((x) => !x.closest('.rm'));
    return { bar: r(document.getElementById('selbar')), comp: r(document.getElementById('composer')), margin: r(document.getElementById('margin')), pt: r(p).top, pr: r(p).right, pb: r(p).bottom };
  });
  let g = await geo();
  const selBottom = await page.evaluate(() => { const r = window.getSelection().getRangeAt(0).getClientRects(); return r[r.length - 1].bottom; });
  assert.ok(g.bar.top >= selBottom && g.bar.top - selBottom < 16, `icons at ${g.bar.top} should sit just under the selection (bottom ${selBottom})`);
  await page.mouse.click(5, 5); // clear the selection
  await page.waitForSelector('#selbar', { state: 'hidden' });
  await dragRaw('First', 'First paragraph here.');
  await page.waitForSelector('#selbar:not([hidden])');
  await page.click('#sb-quote');
  await page.waitForSelector('#composer:not([hidden])');
  g = await geo();
  assert.ok(g.comp.left >= g.pr - 1, `composer (left ${g.comp.left}) must not cover the text (right edge ${g.pr})`);
  assert.equal(await page.locator('#c-qinc').isChecked(), true, 'the quote icon includes the quote');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'c-body');
  await page.fill('#c-body', 'This reads awkwardly.');
  await page.screenshot({ path: path.join(root, 'e2e', 'composer.png'), clip: { x: 280, y: 80, width: 1120, height: 360 } });
  await page.keyboard.press('Escape');
  // the other icon: lines only, no quote when the lines already say it all
  await drag('First', 'First paragraph here.');
  assert.equal(await page.locator('#c-range').innerText(), 'Comments on line 3');
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
  assert.match(await page.locator('#margin .thread.draft').nth(0).innerText(), /Pending[\s\S]*Tighten this whole section/);
  assert.equal(await noOverlap(), true);
});
await step('the review dialog fits a short window with several pending comments (Submit stays reachable)', async () => {
  await page.setViewportSize({ width: 1400, height: 640 });
  await page.evaluate(() => window.scrollTo(0, 0)); // the toolbar is not stuck here, so the dialog starts low on the screen
  await page.click('#review-btn');
  const r = await page.evaluate(() => { const b = document.getElementById('submit').getBoundingClientRect(); return { top: b.top, bottom: b.bottom, h: innerHeight, n: document.querySelectorAll('#list .card').length }; });
  assert.equal(r.n, 3);
  assert.ok(r.top >= 0 && r.bottom <= r.h, `submit at ${r.top}-${r.bottom} in a ${r.h}px window`);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#review-pop').isHidden(), true);
  await page.setViewportSize({ width: 1400, height: 900 });
});
await page.screenshot({ path: path.join(root, 'e2e', 'screenshot.png') });
await step('review is posted with correct anchors', async () => {
  await page.click('#review-btn');
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
  await page.locator('#files button[data-path="docs/complex.md"]').click();
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
  // images are lazy-loaded, so bring it into view and wait for it rather than racing the browser
  await page.locator('#doc img').first().scrollIntoViewIfNeeded();
  await page.waitForFunction(() => { const i = document.querySelector('#doc img'); return i && i.complete && i.naturalWidth === 1; }, null, { timeout: 15000 });
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
  await page.locator('#files button[data-path="docs/diagrams.md"]').click();
  await page.waitForFunction(() => window.__rico.state.file?.filename === 'docs/diagrams.md');
  await page.waitForFunction(() => document.querySelectorAll('#doc iframe.dia-frame').length === 4 && document.querySelectorAll('#doc .dia-err').length === 2, null, { timeout: 90000 });
  assert.equal(await page.locator('#doc figure.dia svg').count(), 0, 'diagram SVG lives inside the frames, never in the page');
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

// ---- removed sections (GitHub's rich diff draws deleted blocks in red) ----
const rangeNow = () => page.locator('#c-range').innerText();
await step('removed sections: deleted paragraph, list item, table row, old wording and old code appear in red where they were', async () => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.locator('#files button[data-path="docs/removed.md"]').click();
  await page.waitForFunction(() => window.__rico.state.file?.filename === 'docs/removed.md' && document.querySelector('#doc h1'));
  const order = await page.evaluate(() => [...document.querySelectorAll('#doc [data-l]')].filter((e) => !e.querySelector('[data-l]'))
    .map((e) => (e.closest('.rm') ? '−' : '') + e.textContent.trim().replace(/\s+/g, ' ')));
  assert.deepEqual(order, [
    'Release notes', 'Intro paragraph that stays.',
    '−This paragraph was removed entirely.', 'keep one', '−removed item', 'keep two', 'added item', // the paragraph before the list, the item inside it
    'Name Value', 'a 1', '−b 2', 'c 3', // the row inside the table, right above its replacement
    '−Old wording of the closing paragraph.', 'New wording of the closing paragraph.',
    '−old();', 'fresh();',
  ]);
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('#doc .rm')].map((e) => e.tagName)), ['DIV', 'LI', 'TR', 'DIV', 'DIV']);
  assert.equal(await page.locator('#legend').innerText().then((t) => /removed/.test(t)), true);
});
await step('removed sections: red background, normal text colour, and no phantom table column', async () => {
  const r = await page.evaluate(() => {
    const css = (e, k) => getComputedStyle(e)[k];
    const rm = document.querySelector('#doc .rm p, #doc .rm [data-l]'); const kept = [...document.querySelectorAll('#doc p')].find((p) => !p.closest('.rm'));
    const table = document.querySelector('#doc table'); const row = table.rows[1]; const cell = row.cells[0];
    return { bg: css(document.querySelector('#doc .rm'), 'backgroundColor'), color: css(rm, 'color'), keptColor: css(kept, 'color'), gap: Math.round(cell.getBoundingClientRect().left - row.getBoundingClientRect().left), cols: [...table.rows].map((x) => x.cells.length) };
  });
  assert.notEqual(r.bg, 'rgba(0, 0, 0, 0)');
  assert.equal(r.color, r.keptColor, 'removed text keeps the normal text colour; only the background is red');
  assert.ok(r.gap < 6, 'a table row must start at the table edge, not after an empty column: ' + r.gap);
  assert.deepEqual(r.cols, [2, 2, 2, 2]);
});
await step('removed sections: left-side thread sits beside the removed block, the other beside its kept text', async () => {
  assert.equal(await page.locator('#margin .thread').count(), 2);
  assert.equal(await page.locator('#margin .note').count(), 0);
  const y = await page.evaluate(() => {
    const top = (e) => e.getBoundingClientRect().top;
    const card = (t) => [...document.querySelectorAll('#margin .thread')].find((c) => c.innerText.includes(t));
    const li = [...document.querySelectorAll('#doc li')].find((l) => l.textContent.trim() === 'keep one');
    return { left: top(card('Why drop this paragraph')), rm: top(document.querySelector('#doc .rm [data-l]')), right: top(card('be bold')), li: top(li) };
  });
  assert.ok(Math.abs(y.left - y.rm) < 3, `left thread ${y.left} vs removed paragraph ${y.rm}`);
  assert.ok(y.right >= y.li - 3, `thread on "keep one" ${y.right} vs the item ${y.li}`);
  assert.equal(await page.locator('#doc .gone.has-t').count(), 1);
});
await step('removed sections: selecting removed text comments on the OLD lines (LEFT side)', async () => {
  await drag('This paragraph', 'removed entirely');
  assert.equal(await rangeNow(), 'Comments on removed line 5');
  const sel = await page.evaluate(() => { const p = window.__rico.state.pending; return { side: p.side, start: p.start, end: p.end, exact: p.anchor?.exact }; });
  assert.deepEqual(sel, { side: 'LEFT', start: 5, end: 5, exact: true });
  assert.equal(await page.locator('#c-qinc').isChecked(), false); // GitHub already shows that line
  await page.fill('#c-body', 'Was dropping this intentional?');
  await page.keyboard.press('Control+Enter');
  const c = await page.evaluate(() => window.__rico.state.comments.at(-1));
  assert.deepEqual({ side: c.side, start: c.start, end: c.end }, { side: 'LEFT', start: 5, end: 5 });
  assert.match(await page.locator('#margin .thread.draft').innerText(), /Pending[\s\S]*Was dropping this intentional/);
  const near = await page.evaluate(() => Math.abs(document.querySelector('#margin .thread.draft').getBoundingClientRect().top - document.querySelector('#doc .rm [data-l]').getBoundingClientRect().top));
  assert.ok(near < 160, 'the draft sits beside the removed paragraph (it may sit under the thread already there)');
  assert.match(await page.locator('#list .card').first().innerText(), /removed\)/);
  await page.locator('#margin .thread.draft').getByRole('button', { name: 'Delete' }).click();
  assert.equal(await page.evaluate(() => window.__rico.state.comments.length), 0);
});
await step('removed sections: a selection across kept and removed text anchors to the kept lines and quotes the removal as a diff', async () => {
  await drag('Intro paragraph', 'keep one');
  assert.equal(await rangeNow(), 'Comments on lines 3–5 — includes removed text (quoted)');
  assert.equal(await page.locator('#c-qinc').isChecked(), true);
  assert.equal(await page.locator('#c-qtext').inputValue(), '> Intro paragraph that stays.\n\n```diff\n- This paragraph was removed entirely.\n```\n\n> keep one');
  await page.fill('#c-body', 'The removed paragraph should stay.');
  await page.keyboard.press('Control+Enter');
  const c = await page.evaluate(() => window.__rico.state.comments.at(-1));
  assert.deepEqual({ side: c.side, start: c.start, end: c.end, exact: c.anchor.exact, inc: c.includeQuote }, { side: 'RIGHT', start: 3, end: 5, exact: true, inc: true });
  await page.locator('#margin .thread.draft').getByRole('button', { name: 'Delete' }).click();
});
await step('removed sections: removed list items and table rows are commentable on their old lines', async () => {
  const r = await page.evaluate(() => {
    const R = window.__rico;
    const of = (sel) => { const rg = document.createRange(); rg.selectNodeContents(document.querySelector(sel)); const d = R.describeSelection(rg); return d && { side: d.side, start: d.start, end: d.end }; };
    return { li: of('#doc li.rm'), tr: of('#doc tr.rm'), code: of('#doc .rm pre code') };
  });
  assert.deepEqual(r.li, { side: 'LEFT', start: 8, end: 8 });
  assert.deepEqual(r.tr, { side: 'LEFT', start: 14, end: 14 });
  assert.equal(r.code.side, 'LEFT'); assert.equal(r.code.start, 19); // the removed line inside the old fence
});
await step('removed sections: line mapping is exact for every block; removed blocks map onto the OLD file', async () => {
  const res = await page.evaluate(() => {
    const R = window.__rico; const view = R.views.get('docs/removed.md');
    const norm = (t) => t.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ');
    const words = (t) => norm(t).split(/\s+/).filter(Boolean);
    const leaves = [...document.querySelectorAll('#doc [data-l]')].filter((e) => !e.querySelector('[data-l]'));
    const bad = []; let n = 0;
    leaves.forEach((leaf, i) => {
      const rg = document.createRange(); rg.selectNodeContents(leaf);
      const d = R.describeSelection(rg); n++;
      const removed = !!leaf.closest('.rm');
      const lines = removed ? view.oldLines : R.state.lines;
      if (!d) return bad.push({ i, why: 'null', text: leaf.textContent.slice(0, 30) });
      if (d.side !== (removed ? 'LEFT' : 'RIGHT')) bad.push({ i, why: 'side ' + d.side });
      const w = words(rg.toString());
      const has = (ln, word) => { let k = ln; while (k >= 1 && !words(lines[k - 1] || '').length) k++; return words(lines[k - 1] || '').includes(word); };
      if (w[0] && !has(d.start, w[0])) bad.push({ i, first: w[0], start: d.start, line: lines[d.start - 1] });
    });
    return { n, bad };
  });
  assert.ok(res.n >= 14, 'only ' + res.n + ' blocks');
  assert.deepEqual(res.bad, [], JSON.stringify(res.bad));
});
await step('a click made while the initial load is still running is not undone when that load finishes', async () => {
  const p3 = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await p3.goto(`http://localhost:${PORT}/#pr=acme%2Fdocs%237&f=docs%2Fplan.md`);
  // complex.md is quick; removed.md is held up fetching its old version. Click the quick one while the slow one is pending.
  await p3.waitForFunction(() => window.__rico?.views.get('docs/complex.md')?.loaded && !window.__rico.views.get('docs/removed.md')?.loaded, null, { timeout: 15000 });
  await p3.locator('#files button[data-path="docs/complex.md"]').click();
  assert.equal(await p3.evaluate(() => window.__rico.state.file.filename), 'docs/complex.md');
  await p3.waitForFunction(() => [...window.__rico.views.values()].every((v) => v.loaded), null, { timeout: 15000 }); // the slow load finishes
  await p3.waitForTimeout(500);
  assert.equal(await p3.evaluate(() => window.__rico.state.file.filename), 'docs/complex.md', 'the file the user chose stays active');
  assert.equal(await p3.evaluate(() => document.querySelectorAll('[id="doc"]').length), 1, 'exactly one active document');
  await p3.close();
});
await step('removed sections: Source diff and Rendered show the same threads', async () => {
  const c = card('docs/removed.md');
  await c.getByRole('button', { name: 'Source diff' }).click();
  assert.match(await c.locator('tr.d-del[data-old="5"]').locator('xpath=following-sibling::tr[1]').innerText(), /Why drop this paragraph/);
  await c.getByRole('button', { name: 'Rendered' }).click();
  assert.equal(await c.locator('.rico-margin .thread').count(), 2);
});

await step('GitHub markdown: task lists, alerts, tables, anchors, details, relative links, sanitized HTML', async () => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.locator('#files button[data-path="docs/github.md"]').click();
  await page.waitForFunction(() => window.__rico.state.file?.filename === 'docs/github.md' && document.querySelector('#doc h1'));
  const q = (sel) => page.locator('#doc ' + sel);
  assert.equal(await q('input.task-list-item-checkbox').count(), 2);
  assert.equal(await q('input.task-list-item-checkbox:checked').count(), 1);
  assert.equal(await q('input.task-list-item-checkbox:disabled').count(), 2);
  assert.equal(await q('ul.contains-task-list').count(), 1);
  assert.equal(await q('.markdown-alert-note .markdown-alert-title').innerText(), 'Note');
  assert.equal(await q('.markdown-alert-warning').count(), 1);
  const note = await q('.markdown-alert-note').innerText();
  assert.match(note, /Useful information/); assert.doesNotMatch(note, /\[!NOTE\]/);
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('#doc th')].map((t) => t.getAttribute('align'))), ['left', 'center', 'right']);
  assert.equal(await q('details > summary').innerText(), 'Click to expand');
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('#doc h1, #doc h2')].map((h) => h.dataset.slug)), ['github-features', 'tasks', 'tasks-1']);
  assert.equal(await q('h2 a.anchor').count(), 2);
  // raw HTML is sanitized like GitHub does: nothing executes, nothing dangerous remains
  assert.deepEqual(await page.evaluate(() => [window.__pwned2, window.__pwned3, window.__pwned4].map((x) => x === undefined)), [true, true, true]);
  assert.equal(await page.evaluate(() => document.querySelectorAll('#doc script, #doc [onerror], #doc a[href^="javascript:"]').length), 0);
  // relative links go to the file on GitHub at the PR's head commit; relative images load via the server
  const link = q('a:has-text("relative link")');
  assert.equal(await link.getAttribute('href'), `https://github.com/acme/docs/blob/${SHA}/docs/glossary.md#term`);
  assert.equal(await link.getAttribute('target'), '_blank');
  assert.match(await q('img[alt="relative image"]').getAttribute('src'), /^\/api\/raw\?/);
  await page.waitForFunction(() => { const i = document.querySelector('#doc img[alt="relative image"]'); return i && i.complete && i.naturalWidth > 0; });
  // an in-page anchor scrolls instead of rewriting the URL hash (which holds the PR)
  const before = page.url();
  await q('a:has-text("anchor link")').click();
  assert.equal(page.url(), before);
});
await step('GitHub markdown: line mapping stays exact in the presence of boxes, alerts, anchors and raw HTML', async () => {
  const res = await page.evaluate(() => {
    const doc = document.getElementById('doc'); const R = window.__rico; const lines = R.state.lines;
    const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ');
    const words = (s) => norm(s).split(/\s+/).filter(Boolean);
    const leaves = [...doc.querySelectorAll('[data-l]')].filter((e) => !e.querySelector('[data-l]'));
    const tn = (el) => { const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); const a = []; for (let n = w.nextNode(); n; n = w.nextNode()) if (n.data.trim()) a.push(n); return a; };
    const sel = (a, b) => { const A = tn(a), B = tn(b); if (!A.length || !B.length) return null; const r = document.createRange(); r.setStart(A[0], 0); const l = B[B.length - 1]; r.setEnd(l, l.data.length); return r; };
    const eff = (ln, dir) => { let k = ln; while (k >= 1 && k <= lines.length && !words(lines[k - 1]).length) k += dir; return k; };
    const bad = []; let n = 0;
    for (let i = 0; i < leaves.length; i++) for (const j of [i, Math.min(leaves.length - 1, i + 4)]) {
      const r = sel(leaves[i], leaves[j]); if (!r) continue; n++;
      const d = R.describeSelection(r); if (!d) { bad.push({ i, j, why: 'null' }); continue; }
      const w = words(r.toString());
      if (w[0] && !words(lines[eff(d.start, 1) - 1] || '').includes(w[0])) bad.push({ i, first: w[0], d: [d.start, d.end], line: lines[d.start - 1] });
      if (w.length && !words(lines[eff(d.end, -1) - 1] || '').includes(w[w.length - 1])) bad.push({ j, last: w[w.length - 1], d: [d.start, d.end], line: lines[d.end - 1] });
    }
    return { n, bad: bad.slice(0, 5) };
  });
  assert.ok(res.n > 20, 'only ' + res.n + ' checks');
  assert.deepEqual(res.bad, [], JSON.stringify(res.bad));
});

await step('no page errors', async () => assert.deepEqual(errors, [], JSON.stringify(errors)));

await browser.close(); srv.kill(); await fake.close();
process.exit(failed ? 1 : 0);
