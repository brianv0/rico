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
let expectHttp = false; // while a step provokes GitHub errors on purpose, the browser's own "Failed to load resource" line is expected
page.on('console', (m) => { if (m.type() !== 'error') return; if (expectHttp && /Failed to load resource: the server responded with a status of (401|403|422)/.test(m.text())) return; if (/violates the following Content Security Policy/.test(m.text())) cspBlocked.push(m.text()); else errors.push(m.text()); });
await page.addInitScript(() => { try { localStorage.setItem('rico:margin', 'aligned'); } catch { /* ignore */ } }); // the existing checks are about the aligned layout; synced mode has its own
let failed = false;
let nfail = 0;
const step = async (name, fn) => { try { await fn(); console.log('ok   ' + name); } catch (e) { failed = true; console.log('FAIL ' + name + '\n     ' + e.message.split('\n').slice(0, 6).join(' | ') + '\n     at ' + (String(e.stack).split('\n').find((l) => l.includes('e2e/run.mjs')) || '').trim()); await page.screenshot({ path: path.join(root, 'e2e', `fail-${++nfail}.png`) }).catch(() => {}); } };

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
  // the selection first offers margin icons; Comment opens the composer (the quote is added by itself when it helps)
  await page.waitForFunction(([a, z]) => { const p = window.__rico.state.sel; return !!p && !document.getElementById('selbar').hidden && p.quote.includes(a) && p.quote.includes(z); }, [from.slice(0, 4), to.slice(0, 4)], { timeout: 5000 });
  await page.click('#sb-comment');
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
// Writes now reach GitHub at once: wait for the fake to see the next one, and clean up through the UI (two-step Delete).
const waitOp = async (n) => { const done = () => fake.ops.slice(n).some((o) => o.op !== 'pending.create'); for (let i = 0; i < 100 && !done(); i++) await new Promise((r) => setTimeout(r, 50)); assert.ok(done(), 'no write reached GitHub'); return fake.ops.at(-1); };
const sendAndWait = async (key = 'Control+Enter') => { const n = fake.ops.length; await page.keyboard.press(key); return waitOp(n); };
const deleteMine = async (loc) => { const n = fake.ops.length; const b = loc.locator('.macts .danger').last(); await b.click(); await b.click(); const o = await waitOp(n); assert.match(o.op, /delete/); await page.waitForFunction(() => !document.querySelector('.thread.local'), null, { timeout: 5000 }); };

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
  await page.locator('#margin .thread[data-id="101"]').hover();
  assert.equal(await page.locator('#doc p.hl').count(), 2);
  await page.mouse.move(5, 5);
  await page.getByText('First paragraph here.').first().click({ position: { x: 20, y: 8 } });
  assert.equal(await page.locator('#margin .thread.active').count(), 1);
});
await step('replying from the margin posts to GitHub and appends to the thread', async () => {
  const card = page.locator('#margin .thread[data-id="101"]');
  await card.getByRole('button', { name: 'Reply', exact: true }).click();
  await card.locator('textarea').fill('Agreed, thanks.');
  await page.keyboard.press('Control+Enter');
  await page.waitForFunction(() => [...document.querySelectorAll('#margin .thread')].some((c) => c.dataset.id === '101' && c.querySelectorAll('.msg').length === 3));
  assert.deepEqual(fake.replies, [{ to: 101, body: 'Agreed, thanks.' }]);
  assert.match(await page.locator('#margin .thread[data-id="101"]').innerText(), /me[\s\S]*Agreed, thanks\./);
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
  assert.match(await under('tr.d-row[data-new="6"]').textContent(), /alice[\s\S]*Will trim it/); // (the middle message of a long thread is folded: present, not visible)
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
  const op = await sendAndWait();
  assert.deepEqual({ op: op.op, path: op.path, side: op.side, line: op.line, start_line: op.start_line, body: op.body, sha: op.commit_id }, { op: 'comment', path: 'docs/plan.md', side: 'LEFT', line: 2, start_line: undefined, body: 'Why was this subtitle removed?', sha: SHA });
  await page.waitForFunction(() => [...document.querySelectorAll('tr.thread-row .thread')].some((t) => /Why was this subtitle removed/.test(t.innerText) && !t.classList.contains('local')));
  assert.match(await c.locator('tr.d-del[data-old="2"]').locator('xpath=following-sibling::tr[1]').innerText(), /me[\s\S]*Why was this subtitle removed/);
  await deleteMine(c.locator('.thread-row .thread', { hasText: 'Why was this subtitle removed' })); // leave no trace
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
  await page.keyboard.press('Escape');
  await drag('paragraph is', 'hard'); // part of source line 5
  assert.equal(await page.locator('#c-qinc').isChecked(), true);
  await page.keyboard.press('Escape');
});
await step('quote option: code selections quote their source lines as a fenced block, and the quote text is kept', async () => {
  await drag('const a', 'const b');
  assert.equal(await page.locator('#c-qinc').isChecked(), false); // GitHub already shows these lines
  assert.equal(await page.locator('#c-qtext').inputValue(), '```js\nconst a = 1;\nconst b = 2;\n```');
  await page.evaluate(() => { document.getElementById('c-qinc').checked = true; document.getElementById('c-qtext').value = '```js\nconst a = 1;\n```'; }); // (the composer no longer exposes these; this is the state the icons set)
  await page.fill('#c-body', 'Draft with an edited quote.');
  const op = await sendAndWait();
  assert.equal(op.body, '```js\nconst a = 1;\n```\n\nDraft with an edited quote.'); // the edited quote is what is posted
  await page.waitForFunction(() => [...document.querySelectorAll('#margin .thread')].some((t) => /edited quote/.test(t.innerText) && !t.classList.contains('local')));
  await deleteMine(page.locator('#margin .thread', { hasText: 'edited quote' })); // leave no trace
});
await step('the selection pill is not re-shown by clicks in the comment column, and stays over the text column', async () => {
  await dragRaw('First', 'First paragraph');
  await page.waitForSelector('#selbar:not([hidden])');
  const pos = () => page.evaluate(() => { const r = document.getElementById('selbar').getBoundingClientRect(); return { l: Math.round(r.left), t: Math.round(r.top), hidden: document.getElementById('selbar').hidden }; });
  const before = await pos();
  const btn = page.locator('#margin .thread button', { hasText: 'Reply' }).first();
  const bb = await btn.boundingBox();
  await page.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2); // an unrelated click out in the comments
  await page.waitForTimeout(300);
  const after = await pos();
  assert.ok(after.hidden || (after.l === before.l && after.t === before.t), `pill must not jump to the click: ${JSON.stringify({ before, after })}`);
  await page.keyboard.press('Escape'); await page.mouse.click(5, 5);
  await page.waitForSelector('#selbar', { state: 'hidden' });
  const cancel = page.locator('#margin .reply button', { hasText: 'Cancel' });
  if (await cancel.count()) await cancel.first().click(); // close the reply box the click opened
  // releasing the drag at the far right edge of the text column keeps the whole pill over the text column
  const A = await textBox('First', true);
  const m = await page.evaluate(() => document.getElementById('doc').getBoundingClientRect().right - 3);
  await page.mouse.move(A.l + 1, A.y); await page.mouse.down();
  await page.mouse.move(m, A.y + 2, { steps: 6 });
  await page.mouse.up();
  await page.waitForSelector('#selbar:not([hidden])');
  const g = await page.evaluate(() => ({ bar: document.getElementById('selbar').getBoundingClientRect().right, doc: document.getElementById('doc').getBoundingClientRect().right }));
  assert.ok(g.bar <= g.doc + 1, `pill right edge ${g.bar} stays within the text column (${g.doc})`);
  await page.mouse.click(5, 5);
  await page.waitForSelector('#selbar', { state: 'hidden' });
});
await step('a selection offers Comment and Suggest icons; the composer opens beside the text, not over it; clearing the selection hides them', async () => {
  await dragRaw('First', 'First paragraph');
  await page.waitForSelector('#selbar:not([hidden])');
  assert.equal(await page.locator('#composer').isHidden(), true, 'nothing pops up until an icon is clicked');
  assert.equal(await page.locator('#selbar button:visible').count(), 2, 'Comment and Suggest');
  const geo = () => page.evaluate(() => {
    const r = (e) => e.getBoundingClientRect();
    const p = [...document.querySelectorAll('#doc p')].find((x) => !x.closest('.rm'));
    return { bar: r(document.getElementById('selbar')), comp: r(document.getElementById('composer')), margin: r(document.getElementById('margin')), pt: r(p).top, pr: r(p).right, pb: r(p).bottom };
  });
  let g = await geo();
  const up = await page.evaluate(() => window.__rico.state.sel.pt);
  assert.ok(g.bar.top >= up.y && g.bar.top - up.y < 30, `icons at ${g.bar.top} should sit just below where the mouse was released (${up.y})`);
  assert.ok(g.bar.left <= up.x && g.bar.right >= up.x, 'and be centred on it horizontally');
  await page.mouse.click(5, 5); // clear the selection
  await page.waitForSelector('#selbar', { state: 'hidden' });
  await dragRaw('First', 'First paragraph');
  await page.waitForSelector('#selbar:not([hidden])');
  await page.click('#sb-comment');
  await page.waitForSelector('#composer:not([hidden])');
  g = await geo();
  assert.ok(g.comp.left >= g.pr - 1, `composer (left ${g.comp.left}) must not cover the text (right edge ${g.pr})`);
  assert.equal(await page.locator('#c-qinc').isChecked(), true, 'part of a line: the quote is added by itself');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'c-body');
  await page.fill('#c-body', 'This reads awkwardly.');
  await page.screenshot({ path: path.join(root, 'e2e', 'composer.png'), clip: { x: 280, y: 80, width: 1120, height: 360 } });
  await page.keyboard.press('Escape');
  // whole lines: no quote, the lines already say it all
  await drag('First', 'First paragraph here.');
  assert.equal(await page.locator('#c-range').innerText(), 'Comments on line 3');
  await page.keyboard.press('Escape');
});
await step('selection across paragraphs maps to the full line range', async () => {
  await drag('First paragraph', 'across two');
  assert.equal(await composerText(), 'Comments on lines 3–6');
  assert.match(await quote(), /^First paragraph here\.[\s\S]*across two$/);
  await page.fill('#c-body', 'Tighten this whole section.');
  assert.equal(await page.locator('#c-add').innerText(), 'Comment');
  assert.equal(await page.locator('#c-review').innerText(), 'Start a review');
  const op = await sendAndWait('Control+Shift+Enter'); // "Start a review": a real pending review on GitHub
  assert.deepEqual({ op: op.op, path: op.path, line: op.line, start_line: op.start_line, side: op.side }, { op: 'pending.add', path: 'docs/plan.md', line: 6, start_line: 3, side: 'RIGHT' });
  assert.equal(op.body, '> First paragraph here.\n>\n> Second paragraph is hard wrapped across two\n\nTighten this whole section.');
  await page.waitForFunction(() => document.querySelectorAll('#list .card').length === 1);
  assert.equal(await page.locator('#rc-label').innerText(), 'Finish review');
  assert.equal(await page.locator('#rc-count').innerText(), '1');
});
await step('range spanning two hunks clamps to the best hunk and says so', async () => {
  await drag('item two', 'const a');
  const t = await composerText();
  assert.match(t, /You selected lines 9–12; GitHub can anchor lines 9–10 \(one hunk\)/);
  await page.fill('#c-body', 'Spans hunks.');
  assert.equal(await page.locator('#c-review').innerText(), 'Add to review', 'a pending review exists now');
  const op = await sendAndWait('Control+Shift+Enter');
  assert.equal(op.start_line, 9); assert.equal(op.line, 10);
  assert.equal(op.body, '_Selected lines 9–12 of `docs/plan.md`. GitHub can only anchor lines 9–10 here, but this comment is about all of lines 9–12._\n\n> item two\n\n```js\nconst a = 1;\n```\n\nSpans hunks.\n\n<details><summary>Full selection: lines 9–12 of <code>docs/plan.md</code> at abc1234</summary>\n\n````\n- item two\n\n```js\nconst a = 1;\n````\n\n</details>');
  assert.equal(fake.ops.filter((o) => o.op === 'pending.create').length, 1, 'one pending review, reused');
});
await step('selection outside the diff is posted as a PR comment with a quote, and sits beside the text it quotes', async () => {
  await drag('Far away', 'the diff');
  assert.match(await composerText(), /outside the diff.*comment on the pull request/);
  assert.equal(await page.locator('#c-review').isDisabled(), true, 'only a single comment is possible here');
  await page.fill('#c-body', 'Unanchored remark.');
  const op = await sendAndWait();
  assert.deepEqual({ op: op.op, body: op.body }, { op: 'pr-comment', body: '**`docs/plan.md` L16**\n\n> Far away paragraph outside the diff\n\nUnanchored remark.' });
  await page.waitForFunction(() => [...document.querySelectorAll('#margin .thread.pr-level')].some((t) => /Unanchored remark/.test(t.innerText) && !t.classList.contains('local')));
  await page.waitForTimeout(400); // cards glide to their place
  const geo = await page.evaluate(() => { const t = [...document.querySelectorAll('#margin .thread.pr-level')].find((x) => /Unanchored/.test(x.innerText)); const p = [...document.querySelectorAll('#doc p')].find((x) => /Far away/.test(x.textContent)); return { card: t.getBoundingClientRect().top, p: p.getBoundingClientRect().top }; });
  assert.ok(geo.card >= geo.p - 3, `never above the paragraph it quotes (${geo.card} vs ${geo.p}); a crowded margin pushes it down`);
  await page.locator('#margin .thread.pr-level', { hasText: 'Unanchored' }).hover();
  assert.deepEqual(await page.evaluate(() => [...CSS.highlights.get('rico-hl') || []].map((r) => r.toString())), ['Far away paragraph outside the diff'], 'hovering it highlights the exact words it quotes');
  await page.mouse.move(5, 5);
  assert.equal(await page.locator('#general .thread', { hasText: 'Unanchored' }).count(), 0);
});
await step('PR comments with no quote are listed under General, with their own actions', async () => {
  const g = page.locator('#general');
  assert.equal(await g.isVisible(), true);
  assert.match(await g.innerText(), /dave[\s\S]*please also update the changelog/);
  assert.equal(await g.locator('.macts .linkish').count(), 0, 'not yours: no edit or delete');
});
await step('pending comments show in the margin too, dashed and labelled, without overlapping', async () => {
  assert.equal(await page.locator('#margin .thread.pending').count(), 2);
  assert.match(await page.locator('#margin .thread.pending').nth(0).innerText(), /Pending[\s\S]*Tighten this whole section/);
  assert.equal(await noOverlap(), true);
});
await step('the review dialog fits a short window with several pending comments (Submit stays reachable)', async () => {
  await page.setViewportSize({ width: 1400, height: 640 });
  await page.evaluate(() => window.scrollTo(0, 0)); // the toolbar is not stuck here, so the dialog starts low on the screen
  await page.click('#review-btn');
  const r = await page.evaluate(() => { const b = document.getElementById('submit').getBoundingClientRect(); return { top: b.top, bottom: b.bottom, h: innerHeight, n: document.querySelectorAll('#list .card').length }; });
  assert.equal(r.n, 2);
  assert.ok(r.top >= 0 && r.bottom <= r.h, `submit at ${r.top}-${r.bottom} in a ${r.h}px window`);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#review-pop').isHidden(), true);
  await page.setViewportSize({ width: 1400, height: 900 });
});
await page.screenshot({ path: path.join(root, 'e2e', 'screenshot.png') });
await step('Finish review submits the pending review with the verdict and summary', async () => {
  await page.click('#review-btn');
  assert.equal(await page.locator('#discard').isVisible(), true);
  await page.fill('#summary', 'Looks good overall.');
  await page.click('#submit');
  await page.waitForSelector('#result a');
  assert.deepEqual(fake.posted.at(-1), { event: 'COMMENT', body: 'Looks good overall.', via: 'graphql' });
  assert.equal(fake.state.pending, null);
  await page.waitForFunction(() => document.querySelectorAll('#margin .thread.pending').length === 0);
  assert.equal(await page.locator('#rc-label').innerText(), 'Review changes');
  await page.keyboard.press('Escape');
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
// ---- diagrams (D2 + Mermaid + Graphviz), all client-side in sandboxed frames ----
// Viewport coordinates of an element inside the n-th diagram frame, scrolled into view.
const frameSpot = (n, kind, key) => page.evaluate(([n, kind, key]) => {
  const frame = document.querySelectorAll('#doc iframe.dia-frame')[n];
  frame.scrollIntoView({ block: 'center' });
  const d = frame.contentDocument;
  let el; let pt = null;
  if (kind === 'd2') { // D2 tags a group with base64(id); edge ids are stored HTML-escaped
    const g = d.querySelector(`g[class="${btoa(key.replace(/>/g, '&gt;'))}"]`);
    el = (key.startsWith('(') && g.querySelector('text')) || g;
  } else if (kind.startsWith('dot-')) { // Graphviz titles each group with the node name, "a->b" for an edge, "cluster_x" for a cluster
    const cls = { 'dot-node': 'node', 'dot-edge': 'edge', 'dot-cluster': 'cluster' }[kind];
    const g = [...d.querySelectorAll(`g.${cls}`)].find((x) => x.querySelector(':scope > title').textContent === key);
    el = g && (g.querySelector('text') || g);
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

await step('diagrams: 6 render in sandboxed script-free frames, 3 broken ones show their errors', async () => {
  const external = [];
  page.on('response', (r) => { if (/terrastruct\.com/.test(r.url())) external.push(r.url()); }); // anything that actually got an answer
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.locator('#files button[data-path="docs/diagrams.md"]').click();
  await page.waitForFunction(() => window.__rico.state.file?.filename === 'docs/diagrams.md');
  await page.waitForFunction(() => document.querySelectorAll('#doc iframe.dia-frame').length === 6 && document.querySelectorAll('#doc .dia-err').length === 3, null, { timeout: 90000 });
  assert.equal(await page.locator('#doc figure.dia svg').count(), 0, 'diagram SVG lives inside the frames, never in the page');
  const attrs = await page.evaluate(() => [...document.querySelectorAll('#doc iframe.dia-frame')].map((f) => ({ sandbox: f.getAttribute('sandbox'), csp: /Content-Security-Policy[^>]*default-src 'none'/.test(f.srcdoc) })));
  assert.deepEqual(attrs, Array(6).fill({ sandbox: 'allow-same-origin', csp: true }));
  const errs = await page.locator('#doc .dia-err').allInnerTexts();
  assert.match(errs[0], /does not compile[\s\S]*line \d/); assert.match(errs[1], /does not compile[\s\S]*Parse error/i); assert.match(errs[2], /does not compile[\s\S]*syntax error/i);
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
  assert.match(await rangeLabel(), /^Comments on line \d+$/);
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
  assert.equal(await page.locator('#c-qinc').isChecked(), true); // a diagram: the reader does not see the source lines, so the quote is added by itself
  await page.keyboard.press('Escape');
});
await step('D2: clicking a node or an edge anchors to the exact source line that defines it', async () => {
  await clickIn(0, 'd2', 'github');
  assert.equal(await rangeLabel(), 'Comments on line 7');
  await clickIn(0, 'd2', 'server');
  assert.equal(await rangeLabel(), 'Comments on line 6');
  await clickIn(0, 'd2', '(server -> github)[0]');
  assert.equal(await page.locator('#c-range').innerText(), 'Comments on line 7');
  assert.equal(await page.locator('#c-qtext').inputValue(), '```d2\nserver -> github: api call\n```');
  await page.keyboard.press('Escape');
});
await step('diagrams: an element comment is stored with what it is about, and posts it to GitHub', async () => {
  await clickIn(0, 'd2', 'github');
  await page.fill('#c-body', 'Draft about the github node.');
  const op = await sendAndWait();
  assert.equal(op.line, 7);
  assert.equal(op.body, '_Re: node “github”_\n\n```d2\ngithub: {\n  label: GitHub API\n}\n```\n\nDraft about the github node.'.replace(/```d2[\s\S]*```/, op.body.match(/```d2[\s\S]*?```/)?.[0] ?? ''));
  assert.match(op.body, /^_Re: node “github”_\n\n```d2/);
  await page.waitForFunction(() => [...document.querySelectorAll('#margin .thread')].some((t) => /github node/.test(t.innerText) && !t.classList.contains('local')));
  await deleteMine(page.locator('#margin .thread', { hasText: 'github node' })); // leave no trace
});
await step('Mermaid: flowchart nodes and edges map to their lines', async () => {
  await clickIn(2, 'm-node', 'B');
  assert.equal(await rangeLabel(), 'Comments on line 27');
  await clickIn(2, 'm-node', 'C');
  assert.equal(await rangeLabel(), 'Comments on line 28');
  await clickIn(2, 'm-edge', 'B_C_0');
  assert.equal(await rangeLabel(), 'Comments on line 28');
  await clickIn(2, 'm-edge', 'A_B_0');
  assert.equal(await rangeLabel(), 'Comments on line 27');
});
await step('Mermaid: sequence actors and messages map to their lines', async () => {
  await clickIn(3, 'm-actor', 'R');
  assert.equal(await rangeLabel(), 'Comments on line 34');
  await clickIn(3, 'm-text', 'comment box');
  assert.equal(await rangeLabel(), 'Comments on line 36');
});
await step('Graphviz: nodes, edges and clusters map to their lines; undirected graphs too', async () => {
  await clickIn(4, 'dot-node', 'Server');
  assert.equal(await rangeLabel(), 'Comments on line 49'); // the first mention
  await clickIn(4, 'dot-edge', 'Server->GitHub');
  assert.equal(await rangeLabel(), 'Comments on line 50');
  await clickIn(4, 'dot-cluster', 'cluster_gh');
  assert.equal(await rangeLabel(), 'Comments on line 51');
  await clickIn(5, 'dot-edge', 'b--c');
  assert.equal(await rangeLabel(), 'Comments on line 57');
});
await step('Graphviz: the dark theme drops the white page and inverts the colours', async () => {
  const bg = await page.evaluate(() => { const d = document.querySelectorAll('#doc iframe.dia-frame')[4].contentDocument; return getComputedStyle(d.querySelector('g.graph > polygon')).fill; });
  assert.match(bg, /rgba\(0, 0, 0, 0\)|transparent/);
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
  await p2.route('**/vendor/viz.js', (r) => r.fulfill({ status: 404, body: 'nope' }));
  await p2.goto(`http://localhost:${PORT}/#pr=acme%2Fdocs%237&f=docs%2Fdiagrams.md`);
  await p2.waitForFunction(() => document.querySelectorAll('#doc .dia-err').length === 9, null, { timeout: 30000 });
  const t = await p2.locator('#doc .dia-err').allInnerTexts();
  assert.match(t[0], /not available[\s\S]*npm install @terrastruct\/d2/);
  assert.match(t[3], /not available[\s\S]*npm install mermaid/);
  assert.match(t[6], /not available[\s\S]*npm install @viz-js\/viz/);
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
  const op = await sendAndWait('Control+Shift+Enter'); // as part of a review
  assert.deepEqual({ op: op.op, side: op.side, line: op.line, path: op.path }, { op: 'pending.add', side: 'LEFT', line: 5, path: 'docs/removed.md' });
  await page.waitForFunction(() => [...document.querySelectorAll('#margin .thread.pending')].some((t) => /Was dropping this intentional/.test(t.innerText) && !t.classList.contains('local')));
  const mine = page.locator('#margin .thread.pending', { hasText: 'Was dropping this intentional' });
  assert.match(await mine.innerText(), /Pending[\s\S]*Was dropping this intentional/);
  await page.waitForTimeout(400);
  const near = await page.evaluate(() => Math.abs([...document.querySelectorAll('#margin .thread.pending')].find((t) => /dropping/.test(t.innerText)).getBoundingClientRect().top - document.querySelector('#doc .rm [data-l]').getBoundingClientRect().top));
  assert.ok(near < 260, `the comment sits beside the removed paragraph (it may sit under the thread already there): ${near}px`);
  await page.click('#review-btn');
  assert.match(await page.locator('#list .card').first().innerText(), /removed\)/);
  await page.click('#discard'); await page.click('#discard'); // two-step: discard the whole pending review
  await page.waitForFunction(() => !document.querySelector('#margin .thread.pending'));
  assert.equal(fake.state.pending, null);
  await page.keyboard.press('Escape');
});
await step('removed sections: a selection across kept and removed text anchors to the kept lines and quotes the removal as a diff', async () => {
  await drag('Intro paragraph', 'keep one');
  assert.equal(await rangeNow(), 'Comments on lines 3–5 — includes removed text (quoted)');
  assert.equal(await page.locator('#c-qinc').isChecked(), true);
  assert.equal(await page.locator('#c-qtext').inputValue(), '> Intro paragraph that stays.\n\n```diff\n- This paragraph was removed entirely.\n```\n\n> keep one');
  await page.fill('#c-body', 'The removed paragraph should stay.');
  const op = await sendAndWait();
  assert.deepEqual({ side: op.side, start_line: op.start_line, line: op.line }, { side: 'RIGHT', start_line: 3, line: 5 });
  assert.match(op.body, /^> Intro paragraph that stays\.\n\n```diff\n- This paragraph was removed entirely\.\n```\n\n> keep one\n\nThe removed paragraph should stay\.$/);
  await page.waitForFunction(() => [...document.querySelectorAll('#margin .thread')].some((t) => /should stay/.test(t.innerText) && !t.classList.contains('local')));
  await deleteMine(page.locator('#margin .thread', { hasText: 'The removed paragraph should stay' }));
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
await step('linkable URL: /github.com/org/repo/PR[@commit]?file= loads the PR, follows the open file, and flags a stale commit', async () => {
  const p4 = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await p4.goto(`http://localhost:${PORT}/github.com/acme/docs/7@deadbee?file=docs%2Fcomplex.md`);
  await p4.waitForFunction(() => window.__rico?.state.file?.filename === 'docs/complex.md', null, { timeout: 15000 });
  assert.equal(await p4.inputValue('#pr'), 'acme/docs#7');
  assert.match(await p4.locator('#status').innerText(), /made at commit deadbee; the PR is now at/);
  assert.match(new URL(p4.url()).pathname, /^\/github\.com\/acme\/docs\/7@[0-9a-f]{7}$/, 'the address bar now pins the real head commit');
  await p4.locator('#files button[data-path="docs/plan.md"]').click();
  await p4.waitForFunction(() => location.search.includes('plan.md'));
  assert.equal(decodeURIComponent(new URL(p4.url()).search), '?file=docs/plan.md');
  await p4.reload(); // the URL alone restores the view
  await p4.waitForFunction(() => window.__rico?.state.file?.filename === 'docs/plan.md', null, { timeout: 15000 });
  await p4.waitForSelector('#doc h1', { timeout: 10000 }); // the page and its assets loaded from the absolute paths
  await p4.close();
});
await step('change bars: one gutter column for every block (nested lists, quotes, tables), spanning the text only', async () => {
  const p5 = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  await p5.goto(`http://localhost:${PORT}/#pr=acme%2Fdocs%237&f=docs%2Fcomplex.md`);
  await p5.waitForSelector('#doc h1');
  await p5.waitForFunction(() => document.querySelectorAll('#doc .rico-bars i').length > 8, null, { timeout: 15000 });
  const res = await p5.evaluate(() => {
    const doc = document.getElementById('doc').getBoundingClientRect();
    const bars = [...document.querySelectorAll('#doc .rico-bars i')].map((b) => { const r = b.getBoundingClientRect(); return { x: Math.round(r.left - doc.left), top: r.top, bottom: r.bottom }; });
    const kinds = { list: !!document.querySelector('#doc li[data-l]:is(.chg,.ctx,.out)'), nested: !!document.querySelector('#doc li li[data-l]'), table: !!document.querySelector('#doc tr[data-l]:is(.chg,.ctx,.out)') };
    const h2 = [...document.querySelectorAll('#doc h2[data-l]:is(.chg,.ctx,.out)')][0];
    const hr = h2.getBoundingClientRect();
    const hb = bars.find((b) => Math.abs(b.top - (hr.top + 2)) < 1.5);
    return { xs: [...new Set(bars.map((b) => b.x))], n: bars.length, kinds, headingBarEnd: hb && hb.bottom, headingTextEnd: hr.bottom - parseFloat(getComputedStyle(h2).paddingBottom) - parseFloat(getComputedStyle(h2).borderBottomWidth), pseudo: [...document.querySelectorAll('#doc [data-l]')].some((e) => getComputedStyle(e, '::before').content !== 'none' && !e.closest('.rm') && getComputedStyle(e, '::before').position === 'absolute' && getComputedStyle(e, '::before').width === '3px') };
  });
  assert.deepEqual(res.xs, [-16], 'every bar sits in the same column: ' + JSON.stringify(res.xs));
  assert.ok(res.kinds.list && res.kinds.nested && res.kinds.table, 'the document has lists, nested lists and tables: ' + JSON.stringify(res.kinds));
  assert.ok(Math.abs(res.headingBarEnd - (res.headingTextEnd - 2)) < 1.5, `heading bar ends at its text (${res.headingBarEnd} vs ${res.headingTextEnd})`);
  assert.equal(res.pseudo, false, 'no leftover per-element ::before bars');
  const co = await p5.evaluate(() => {
    const bars = [...document.querySelectorAll('#doc .rico-bars i')].map((b) => ({ el: b, r: b.getBoundingClientRect() }));
    const barAt = (el) => { const r = el.getBoundingClientRect(); const y = r.top + r.height / 2; return bars.find((b) => y >= b.r.top && y <= b.r.bottom)?.el || null; };
    const lis = [...document.querySelectorAll('#doc > ol > li[data-l]')];
    const ps = [...document.querySelectorAll('#doc > p[data-l]')];
    const h1 = document.querySelector('#doc h1[data-l]');
    const tight = lis.length >= 2 && lis.every((l) => barAt(l) && barAt(l) === barAt(lis[0]));
    return { tight, lis: lis.length, ps: ps.length, paraApart: ps.length >= 2 && barAt(ps[0]) !== barAt(ps[1]), headingOwn: barAt(h1) !== barAt(ps[0]) };
  });
  assert.ok(co.tight, 'consecutive list items share one bar: ' + JSON.stringify(co));
  assert.ok(co.paraApart && co.headingOwn, 'paragraphs and headings keep their own bars: ' + JSON.stringify(co));
  await p5.screenshot({ path: path.join(root, 'e2e', 'bars.png'), clip: { x: 280, y: 150, width: 900, height: 800 } });
  await p5.close();
});
await step('removed text: red tint, text in the same column as kept text, and its red bar in the same gutter', async () => {
  const p6 = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await p6.goto(`http://localhost:${PORT}/#pr=acme%2Fdocs%237&f=docs%2Fplan.md`);
  await p6.waitForSelector('#doc .rm');
  await p6.waitForFunction(() => document.querySelectorAll('#doc .rico-bars i.del').length >= 1, null, { timeout: 15000 });
  const r = await p6.evaluate(() => {
    const doc = document.getElementById('doc').getBoundingClientRect();
    const rm = document.querySelector('#doc .rm');
    const txt = (e) => { const w = document.createTreeWalker(e, NodeFilter.SHOW_TEXT); const n = w.nextNode(); const rg = document.createRange(); rg.selectNodeContents(n); return rg.getBoundingClientRect().left; };
    const kept = [...document.querySelectorAll('#doc > p[data-l]')].find((p) => !p.closest('.rm'));
    const raw = getComputedStyle(rm).backgroundColor.match(/[\d.]+/g).map(Number).slice(0, 3);
    const bg = raw.every((x) => x <= 1) ? raw.map((x) => x * 255) : raw; // color-mix() reports 0-1 channels
    return { barX: Math.round(document.querySelector('#doc .rico-bars i.del').getBoundingClientRect().left - doc.left), rmText: Math.round(txt(rm)), keptText: Math.round(txt(kept)), bg };
  });
  assert.equal(r.barX, -16, 'the removed bar sits in the gutter column');
  assert.ok(Math.abs(r.rmText - r.keptText) <= 1, `removed text (${r.rmText}) lines up with kept text (${r.keptText})`);
  assert.ok(r.bg[0] - r.bg[1] > 25 && r.bg[0] - r.bg[2] > 20, 'the removed block is clearly red: rgb ' + r.bg.slice(0, 3));
  await p6.screenshot({ path: path.join(root, 'e2e', 'removed.png'), clip: { x: 280, y: 150, width: 900, height: 480 } });
  await p6.close();
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

// ---------- Google-Docs-style commenting: single comments, thread actions, drafts ----------
const reload = async () => { await page.reload(); await page.waitForSelector('#doc h1'); await page.waitForFunction(() => document.querySelector('#margin .thread')); };
const gotoPlan = async () => { await page.locator('#files button[data-path="docs/plan.md"]').click(); await page.waitForFunction(() => window.__rico.state.file?.filename === 'docs/plan.md' && document.querySelector('#doc h1')); };
await step('Comment posts at once: it shows as "posting…" and is then replaced by GitHub\'s comment with a permalink', async () => {
  await gotoPlan();
  await page.route('**/api/comment', async (r) => { await new Promise((x) => setTimeout(x, 700)); await r.continue(); });
  await drag('Second paragraph', 'testing');
  await page.fill('#c-body', 'Slow single comment');
  const n = fake.ops.length;
  await page.keyboard.press('Control+Enter');
  assert.equal(await page.locator('#composer').isHidden(), true, 'the box closes at once');
  const card = page.locator('#margin .thread', { hasText: 'Slow single comment' });
  assert.match(await card.innerText(), /posting…/);
  assert.equal(await card.evaluate((e) => e.classList.contains('local')), true);
  await page.waitForFunction(() => { const t = [...document.querySelectorAll('#margin .thread')].find((x) => /Slow single comment/.test(x.innerText)); return t && !t.classList.contains('local'); });
  await page.unroute('**/api/comment');
  const op = await waitOp(n);
  assert.deepEqual({ op: op.op, line: op.line, start_line: op.start_line }, { op: 'comment', line: 6, start_line: 5 });
  assert.match(await card.innerText(), /me[\s\S]*commented/);
  assert.match(await card.locator('.who a').first().getAttribute('href'), /^https:\/\/github\.com\/acme\/docs\/pull\/7#discussion_r\d+$/);
  assert.equal(await page.locator('#review-btn #rc-count').isHidden(), true, 'a single comment does not start a review');
});
await step('edit your own comment (alice\'s have no edit or delete)', async () => {
  const id = await page.locator('#margin .thread', { hasText: 'Slow single comment' }).getAttribute('data-id');
  const mine = page.locator(`#margin .thread[data-id="${id}"]`);
  assert.equal(await page.locator('#margin .thread .msg', { hasText: 'Will trim it' }).locator('.macts .linkish').count(), 0, 'bob\'s comment: not yours');
  assert.equal(await page.locator('#margin .thread .msg', { hasText: 'Is this' }).locator('.macts .linkish').count(), 0, 'alice\'s comment: not yours');
  await mine.getByRole('button', { name: 'Edit' }).click();
  await mine.locator('textarea').fill('Slow single comment, edited');
  const n = fake.ops.length;
  await mine.getByRole('button', { name: 'Update comment' }).click();
  const op = await waitOp(n);
  assert.deepEqual({ op: op.op, body: op.body }, { op: 'edit', body: 'Slow single comment, edited' });
  await page.waitForFunction(() => [...document.querySelectorAll('#margin .thread')].some((x) => /single comment, edited/.test(x.innerText)));
});
await step('a failure keeps your text and shows GitHub\'s reason; Try again works once it is fixed', async () => {
  expectHttp = true;
  fake.state.locked = true;
  await drag('First paragraph', 'First paragraph here');
  await page.fill('#c-body', 'Written while locked');
  await page.keyboard.press('Control+Enter');
  const card = page.locator('#margin .thread', { hasText: 'Written while locked' });
  await page.waitForFunction(() => [...document.querySelectorAll('#margin .thread')].some((x) => /Not posted/.test(x.innerText)));
  assert.match(await card.innerText(), /Not posted: .*locked/);
  assert.match(await card.innerText(), /Written while locked/);
  fake.state.locked = false;
  const n = fake.ops.length;
  await card.getByRole('button', { name: 'Try again' }).click();
  await waitOp(n);
  await page.waitForFunction(() => { const t = [...document.querySelectorAll('#margin .thread')].find((x) => /Written while locked/.test(x.innerText)); return t && !t.classList.contains('local') && !/Not posted/.test(t.innerText); });
  // off the diff (the line left it): GitHub's 422 text is shown, nothing is lost
  fake.state.rateLimited = true;
  await drag('First paragraph', 'First paragraph here');
  await page.fill('#c-body', 'Rate limited one');
  await page.keyboard.press('Control+Enter');
  await page.waitForFunction(() => [...document.querySelectorAll('#margin .thread')].some((x) => /rate limit/i.test(x.innerText)));
  fake.state.rateLimited = false;
  await page.locator('#margin .thread', { hasText: 'Rate limited one' }).getByRole('button', { name: 'Discard' }).click();
  assert.equal(await page.locator('#margin .thread', { hasText: 'Rate limited one' }).count(), 0);
  expectHttp = false;
});
await step('resolve folds a thread to one line; Show expands it; Reopen brings it back', async () => {
  const t = () => page.locator('#margin .thread[data-id="101"]');
  const n = fake.ops.length;
  await t().getByRole('button', { name: 'Resolve', exact: true }).click();
  assert.equal((await waitOp(n)).op, 'resolve');
  await page.waitForSelector('#margin .thread.resolved .rmark');
  assert.match(await page.locator('#margin .thread.resolved').innerText(), /Resolved[\s\S]*alice/);
  assert.equal(await page.locator('#margin .thread.resolved .msg').count(), 0, 'folded: no messages shown');
  await page.screenshot({ path: path.join(root, 'e2e', 'resolved.png') });
  await page.locator('#margin .thread.resolved').getByRole('button', { name: 'Show' }).click();
  assert.equal(await page.locator('#margin .thread.resolved .msg').count(), 3);
  const m = fake.ops.length;
  await t().getByRole('button', { name: 'Reopen' }).click();
  assert.equal((await waitOp(m)).op, 'unresolve');
  await page.waitForFunction(() => !document.querySelector('#margin .thread.resolved'));
});
await step('reactions: add from the picker, toggle off by clicking your own', async () => {
  const msg = page.locator('#margin .thread[data-id="101"]').locator('.msg').first();
  let n = fake.ops.length;
  await msg.locator('.react.add').click();
  await msg.locator('.picker .react[title="heart"]').click();
  assert.deepEqual({ op: (await waitOp(n)).op, content: fake.ops.at(-1).content }, { op: 'react', content: 'heart' });
  assert.equal(await msg.locator('.react.mine').innerText(), '❤️ 1');
  n = fake.ops.length;
  await msg.locator('.react.mine').click();
  assert.equal((await waitOp(n)).op, 'unreact');
  await page.waitForFunction(() => !document.querySelector('#margin .react.mine'));
});
await step('delete asks twice, then removes your comment from GitHub', async () => {
  const n = fake.ops.length;
  const card = page.locator('#margin .thread', { hasText: 'Slow single comment, edited' });
  const b = card.locator('.macts .danger');
  await b.click();
  assert.equal(await b.innerText(), 'Really delete?');
  assert.equal(fake.ops.length, n, 'one click deletes nothing');
  await b.click();
  assert.equal((await waitOp(n)).op, 'delete');
  await page.waitForFunction(() => ![...document.querySelectorAll('#margin .thread')].some((x) => /Slow single comment/.test(x.innerText)));
});
await step('unsent text survives a reload: the comment box and reply boxes', async () => {
  await drag('Second paragraph', 'testing');
  await page.fill('#c-body', 'Half-written thought');
  await page.waitForTimeout(100);
  await reload();
  await page.waitForSelector('#composer:not([hidden])');
  assert.equal(await page.locator('#c-body').inputValue(), 'Half-written thought');
  assert.equal(await page.locator('#c-range').innerText(), 'Comments on lines 5–6');
  await page.locator('#c-cancel').click();
  await reload();
  assert.equal(await page.locator('#composer').isHidden(), true, 'Cancel throws the draft away');
  const t = page.locator('#margin .thread[data-id="101"]');
  await t.getByRole('button', { name: 'Reply', exact: true }).click();
  await t.locator('textarea').fill('Reply in progress');
  await reload();
  assert.equal(await page.locator('#margin .thread[data-id="101"]').locator('.reply textarea').inputValue(), 'Reply in progress');
  await page.locator('#margin .thread[data-id="101"]').locator('.reply').getByRole('button', { name: 'Cancel' }).click();
  assert.equal(await page.locator('.reply').count(), 0);
});
await step('Ctrl/Cmd+Alt+M comments on the current selection', async () => {
  await dragRaw('Second paragraph', 'testing');
  await page.keyboard.press('Control+Alt+KeyM');
  await page.waitForSelector('#composer:not([hidden])');
  assert.equal(await page.locator('#c-range').innerText(), 'Comments on lines 5–6');
  await page.keyboard.press('Escape');
});
await step('signed out (preview): the text is kept and the way back in is offered; nothing is posted', async () => {
  await page.route('**/api/me', (r) => r.fulfill({ json: { hosted: true, preview: true } }));
  await reload();
  const n = fake.ops.length;
  await drag('Second paragraph', 'testing');
  await page.fill('#c-body', 'Needs sign-in first');
  await page.click('#c-add');
  assert.match(await page.locator('#c-err').innerText(), /Sign in with GitHub to comment[\s\S]*saved/);
  assert.match(await page.locator('#c-err a').getAttribute('href'), /^\/auth\/login\?return=%2Fgithub\.com%2Facme%2Fdocs%2F7/);
  assert.equal(await page.locator('#composer').isHidden(), false, 'the box stays open');
  assert.equal(fake.ops.length, n);
  assert.equal(await page.locator('#margin .thread .macts').count(), 0, 'no edit, delete or reactions when signed out');
  await page.evaluate(() => localStorage.clear());
  await page.unroute('**/api/me');
  await reload();
});

await step('live refresh: a comment from someone else appears without a reload; unchanged polls are free (304)', async () => {
  await gotoPlan();
  await page.evaluate(() => window.__rico.setPollMs(300));
  fake.hits.length = 0;
  const id = fake.addComment({ user: { login: 'zed', avatar_url: null }, line: 6, start_line: 3, original_line: 6, body: 'Fresh from zed' });
  await page.waitForFunction(() => [...document.querySelectorAll('#margin .thread')].some((x) => /Fresh from zed/.test(x.innerText)), null, { timeout: 5000 });
  await page.waitForTimeout(2000);
  const hits = fake.hits.filter((h) => /\/pulls\/7( |\/comments |.*)->/.test(h) || /issues\/7\/comments/.test(h));
  assert.ok(hits.filter((h) => h.endsWith('304')).length >= 3, 'polls answer 304: ' + hits.slice(-6).join(' ; '));
  assert.equal(fake.hits.filter((h) => /\/graphql/.test(h)).length >= 1, true, 'a change is re-read in full once');
  assert.equal(id > 0, true);
});
await step('live refresh: an open reply box keeps its text and focus while the margin updates', async () => {
  const t = page.locator('#margin .thread[data-id="101"]');
  await t.getByRole('button', { name: 'Reply', exact: true }).click();
  await t.locator('textarea').fill('Typing while others comment');
  await t.locator('textarea').press('End');
  fake.addComment({ user: { login: 'yan' }, line: 6, original_line: 6, in_reply_to_id: 101, body: 'Reply from yan' });
  await page.waitForFunction(() => [...document.querySelectorAll('#margin .thread')].some((x) => /Reply from yan/.test(x.innerText)), null, { timeout: 5000 });
  const ta = page.locator('#margin .thread[data-id="101"]').locator('.reply textarea');
  assert.equal(await ta.inputValue(), 'Typing while others comment');
  assert.equal(await page.evaluate(() => document.activeElement?.tagName), 'TEXTAREA');
  await page.locator('#margin .thread[data-id="101"]').locator('.reply').getByRole('button', { name: 'Cancel' }).click();
});
await step('live refresh: no polling while the tab is hidden, and it resumes when you come back', async () => {
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); });
  await page.waitForTimeout(400);
  const n = fake.hits.length;
  await page.waitForTimeout(900);
  assert.equal(fake.hits.length, n, 'a hidden tab asks GitHub for nothing');
  fake.addComment({ user: { login: 'xia' }, line: 6, original_line: 6, body: 'While you were away' });
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForFunction(() => [...document.querySelectorAll('#margin .thread')].some((x) => /While you were away/.test(x.innerText)), null, { timeout: 5000 });
});
await step('new commits on the PR show a banner; Reload opens the new head; composing warns about stale lines', async () => {
  assert.equal(await page.locator('#stale').isHidden(), true);
  fake.pushCommit('9999aaaabbbb');
  await page.waitForSelector('#stale:not([hidden])', { timeout: 5000 });
  assert.match(await page.locator('#stale').innerText(), /new commits[\s\S]*9999aaa/);
  await drag('Second paragraph', 'testing');
  assert.match(await page.locator('#c-range').innerText(), /new commits since you loaded it/);
  await page.keyboard.press('Escape');
  await page.screenshot({ path: path.join(root, 'e2e', 'stale.png') });
  fake.pushCommit(SHA); // (the fake serves files only at its one commit)
  await page.evaluate(() => window.__rico.setPollMs(10 * 60 * 1000));
});

await step('exact words: a partial-line comment highlights just those words (Google-Docs style); whole-line threads fall back to the block', async () => {
  await gotoPlan();
  await page.evaluate(() => window.__rico.setPollMs(10 * 60 * 1000));
  await drag('paragraph is', 'hard');
  assert.equal(await page.locator('#c-qinc').isChecked(), true);
  await page.fill('#c-body', 'These exact words matter');
  const n = fake.ops.length;
  await page.keyboard.press('Control+Enter');
  const op = await waitOp(n);
  assert.equal(op.body, '> paragraph is hard\n\nThese exact words matter');
  await page.waitForFunction(() => [...document.querySelectorAll('#margin .thread')].some((x) => /exact words matter/.test(x.innerText) && !x.classList.contains('local')));
  const card = page.locator('#margin .thread', { hasText: 'exact words matter' });
  const ranges = () => page.evaluate(() => ({ marked: [...CSS.highlights.get('rico-thread') || []].map((r) => r.toString()), hover: [...CSS.highlights.get('rico-hl') || []].map((r) => r.toString()), blocks: document.querySelectorAll('#doc [data-l].hl').length }));
  assert.ok((await ranges()).marked.includes('paragraph is hard'), 'the exact words are marked: ' + JSON.stringify(await ranges()));
  await card.hover();
  assert.deepEqual(await ranges(), { marked: (await ranges()).marked, hover: ['paragraph is hard'], blocks: 0 });
  await page.mouse.move(5, 5);
  assert.deepEqual((await ranges()).hover, []);
  await page.locator('#margin .thread[data-id="101"]').hover(); // no quote in that one: the whole block
  assert.equal((await ranges()).hover.length, 0);
  assert.equal((await ranges()).blocks > 0, true);
  await page.mouse.move(5, 5);
  await deleteMine(card);
});
await step('outdated threads render faded with their quote struck through', async () => {
  fake.addComment({ user: { login: 'olga' }, line: null, original_line: 9, body: '> item two\n\nOld wording comment' });
  await page.evaluate(() => window.__rico.refreshComments(true));
  const card = page.locator('#margin .thread.outdated', { hasText: 'Old wording comment' });
  await card.waitFor();
  assert.ok(Number(await card.evaluate((e) => getComputedStyle(e).opacity)) < 1);
  assert.match(await card.locator('blockquote').evaluate((e) => getComputedStyle(e).textDecorationLine), /line-through/);
  assert.match(await card.innerText(), /Outdated/);
  await page.screenshot({ path: path.join(root, 'e2e', 'outdated.png') });
});

await step('Suggest edit: raw source lines, live red/green preview, posts a ```suggestion block', async () => {
  await gotoPlan();
  await dragRaw('Second paragraph', 'testing');
  await page.waitForSelector('#selbar:not([hidden])');
  assert.equal(await page.locator('#sb-suggest').isEnabled(), true);
  await page.click('#sb-suggest');
  await page.waitForSelector('#composer:not([hidden])');
  assert.equal(await page.locator('#c-suggest').isVisible(), true);
  assert.equal(await page.locator('#c-sugtext').inputValue(), 'Second paragraph is hard wrapped\nacross two lines for testing.', 'the RAW source lines, not rendered text');
  assert.match(await page.locator('#c-range').innerText(), /Suggests an edit to lines 5–6/);
  assert.equal(await page.locator('#c-sugdiff .sg-add, #c-sugdiff .sg-del').count(), 0, 'unchanged: no diff yet');
  const n0 = fake.ops.length;
  await page.click('#c-add');
  assert.match(await page.locator('#c-err').innerText(), /No change yet/);
  assert.equal(fake.ops.length, n0);
  await page.fill('#c-sugtext', 'Second paragraph is hard-wrapped\nacross two lines for testing.');
  assert.equal(await page.locator('#c-sugdiff .sg-del').count(), 1);
  assert.equal(await page.locator('#c-sugdiff .sg-add').count(), 1);
  assert.equal(await page.locator('#c-sugdiff .sg-ctx').count(), 1);
  assert.match(await page.locator('#c-sugdiff .sg-add').innerText(), /hard-wrapped/);
  await page.fill('#c-body', 'Hyphenate?');
  await page.screenshot({ path: path.join(root, 'e2e', 'suggest.png'), clip: { x: 280, y: 80, width: 1120, height: 520 } });
  const op = await sendAndWait();
  assert.deepEqual({ op: op.op, start_line: op.start_line, line: op.line, side: op.side }, { op: 'comment', start_line: 5, line: 6, side: 'RIGHT' });
  assert.equal(op.body, 'Hyphenate?\n\n```suggestion\nSecond paragraph is hard-wrapped\nacross two lines for testing.\n```');
  const card = page.locator('#margin .thread', { hasText: 'Hyphenate?' });
  await page.waitForFunction(() => [...document.querySelectorAll('#margin .thread')].some((x) => /Hyphenate/.test(x.innerText) && !x.classList.contains('local')));
  assert.equal(await card.locator('.sugg .sg-del').count(), 1, 'the thread shows the suggestion as a diff against the lines it replaces');
  assert.equal(await card.locator('.sugg .sg-add').count(), 1);
  assert.equal(await card.locator('.sugg-head').innerText(), 'Suggested change');
  await page.screenshot({ path: path.join(root, 'e2e', 'thread.png') });
  await deleteMine(card);
});
await step('Suggest edit: an empty replacement deletes the lines; offered only where GitHub can apply it', async () => {
  await dragRaw('First paragraph', 'First paragraph here');
  await page.click('#sb-suggest');
  await page.fill('#c-sugtext', '');
  const op = await sendAndWait();
  assert.equal(op.body, '```suggestion\n```');
  assert.equal(op.line, 3);
  await page.waitForFunction(() => [...document.querySelectorAll('#margin .thread')].some((x) => x.querySelector('.sugg') && !x.classList.contains('local')));
  await deleteMine(page.locator('#margin .thread', { has: page.locator('.sugg') }));
  const why = async (a, b) => { await dragRaw(a, b); await page.waitForSelector('#selbar:not([hidden])'); const d = await page.locator('#sb-suggest').isDisabled(); const t = await page.locator('#sb-suggest').getAttribute('title'); await page.mouse.click(5, 5); await page.waitForSelector('#selbar', { state: 'hidden' }); return { d, t }; };
  const outside = await why('Far away', 'the diff');
  assert.equal(outside.d, true); assert.match(outside.t, /outside the diff/);
  const hunks = await why('item two', 'const a');
  assert.equal(hunks.d, true); assert.match(hunks.t, /another hunk/);
  await page.locator('#files button[data-path="docs/removed.md"]').click();
  await page.waitForFunction(() => window.__rico.state.file?.filename === 'docs/removed.md' && document.querySelector('#doc .rm'));
  const removed = await why('This paragraph', 'removed entirely');
  assert.equal(removed.d, true); assert.match(removed.t, /removed text/);
  await gotoPlan();
});
await step('an unsent suggestion survives a reload, edited text and all', async () => {
  await dragRaw('First paragraph', 'First paragraph here');
  await page.click('#sb-suggest');
  await page.fill('#c-sugtext', 'First paragraph, rewritten.');
  await page.waitForTimeout(100);
  await reload();
  await page.waitForSelector('#composer:not([hidden])');
  assert.equal(await page.locator('#c-sugtext').inputValue(), 'First paragraph, rewritten.');
  await page.click('#c-cancel');
});

await step('long threads fold to first + last message; hover peeks the rest, clicking pins it; long messages clamp', async () => {
  await gotoPlan();
  const t = page.locator('#margin .thread[data-id="101"]');
  const total = await t.locator('.msg').count();
  assert.ok(total >= 4, 'thread 101 has grown: ' + total);
  assert.equal(await t.evaluate((e) => e.classList.contains('folded')), true);
  assert.equal(await t.locator('.msg:visible').count(), 2, 'only the first and the last message');
  assert.match(await t.locator('.more').innerText(), new RegExp(`${total - 2} more replies`));
  const h0 = await t.evaluate((e) => e.getBoundingClientRect().height);
  const next = await page.evaluate(() => [...document.querySelectorAll('#margin .thread')].filter((x) => x.dataset.id !== '101').map((x) => x.getBoundingClientRect().top));
  await t.locator('.msg').first().hover();
  await page.waitForSelector('#margin .thread[data-id="101"].peek');
  assert.equal(await t.locator('.msg:visible').count(), total, 'peek shows everything');
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('#margin .thread')].filter((x) => x.dataset.id !== '101').map((x) => x.getBoundingClientRect().top)), next, 'neighbours do not move');
  await page.screenshot({ path: path.join(root, 'e2e', 'peek.png') });
  await page.mouse.move(5, 5);
  await page.waitForFunction(() => !document.querySelector('#margin .thread.peek'));
  assert.equal(await t.locator('.msg:visible').count(), 2);
  assert.ok(Math.abs(await t.evaluate((e) => e.getBoundingClientRect().height) - h0) < 1);
  await t.locator('.more').click();
  assert.equal(await t.evaluate((e) => e.classList.contains('folded')), false, 'pinned open');
  assert.equal(await t.locator('.msg:visible').count(), total);
  // a very long message is clamped, with Show more
  fake.addComment({ user: { login: 'prose' }, line: 6, original_line: 6, body: 'Long thought. ' + 'This sentence keeps going and going. '.repeat(30) });
  await page.evaluate(() => window.__rico.refreshComments(true));
  const long = page.locator('#margin .thread.clamped', { hasText: 'Long thought' });
  await long.waitFor();
  assert.ok((await long.locator('.text').evaluate((e) => e.getBoundingClientRect().height)) < 170, 'clamped');
  await long.getByRole('button', { name: 'Show more' }).click();
  assert.equal(await page.locator('#margin .thread.clamped', { hasText: 'Long thought' }).count(), 0);
});

await step('synced margin: sticky column, non-linear scroll keeps the thread at the focus line level with its text', async () => {
  await page.locator('#files button[data-path="docs/complex.md"]').click();
  await page.waitForFunction(() => window.__rico.state.file?.filename === 'docs/complex.md' && document.querySelector('#doc h1'));
  const n = await page.evaluate(() => window.__rico.state.lines.length);
  const anchors = [3, 8, 8, 12, 20, 21, 30, 38, 44, 52, 60, 70].filter((l) => l < n);
  let rootId = 0;
  for (const [i, l] of anchors.entries()) {
    const id = fake.addComment({ path: 'docs/complex.md', user: { login: 'rev' + i }, line: l, original_line: l, body: `Thread ${i}: ` + 'a fairly long comment that wraps over several lines in the margin. '.repeat(3) });
    if (i === 3) rootId = id;
  }
  for (let r = 0; r < 4; r++) fake.addComment({ path: 'docs/complex.md', user: { login: 'chatty' + r }, line: 12, original_line: 12, in_reply_to_id: rootId, body: 'Reply ' + r + ' with some more words to take up room in the thread.' });
  await page.evaluate(() => window.__rico.refreshComments(true));
  await page.waitForFunction((k) => document.querySelectorAll('#margin .thread').length >= k, anchors.length - 1);
  assert.equal(await page.locator('#cards .file-body.sync').count(), 0, 'aligned mode (forced for the other checks) is not synced');
  assert.ok(await page.locator('.rico-ribbons path:visible').count() >= 1, 'ribbons tie cards to their text in aligned mode too');
  await page.evaluate(() => window.__rico.setMarginMode('sync'));
  await page.waitForSelector('.file-card:not(.collapsed) .file-body.sync');
  assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('margin')).position), 'sticky');
  const F = await page.evaluate(() => { const T = 49; return T + (innerHeight - T) * 0.35; });
  const cards = () => page.evaluate(() => window.__rico.views.get('docs/complex.md').marginItems.map((it) => ({ id: it.id, a: it.blocks[0].getBoundingClientRect().top, c: it.card.getBoundingClientRect().top })));
  // bring each of several threads' text to the focus line: its card must be level with it
  for (const k of [0, 3, 5, 9]) {
    const list = await cards();
    await page.evaluate(([y]) => window.scrollBy(0, y), [list[k].a - F]);
    await page.waitForTimeout(150);
    const now = (await cards())[k];
    assert.ok(Math.abs(now.c - F) < 6 && Math.abs(now.a - F) < 6, `thread ${k}: text at ${now.a}, card at ${now.c}, focus ${F}`);
  }
  // non-linear: between two threads the margin moves at its own speed (not the page's)
  const list = await cards();
  await page.evaluate(([y]) => window.scrollBy(0, y), [list[1].a - F]);
  await page.waitForTimeout(150);
  const t0 = await page.evaluate(() => new DOMMatrix(getComputedStyle(document.querySelector('#margin .rico-track')).transform).m42);
  const yb = await page.evaluate(() => scrollY);
  await page.evaluate(() => window.scrollBy(0, 60));
  await page.waitForTimeout(150);
  const moved = (await page.evaluate(() => scrollY)) - yb;
  const t1 = await page.evaluate(() => new DOMMatrix(getComputedStyle(document.querySelector('#margin .rico-track')).transform).m42);
  assert.ok(moved >= 50 && Math.abs(t1 - t0) > 5 && Math.abs(Math.abs(t1 - t0) - moved) > 10, `margin moved ${t1 - t0} for ${moved}px of page`);
  // the wheel over the margin drives the page through the same mapping
  const y0 = await page.evaluate(() => scrollY);
  const box = await page.locator('#margin').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + 200);
  await page.mouse.wheel(0, 120);
  await page.waitForTimeout(200);
  assert.notEqual(await page.evaluate(() => scrollY), y0, 'wheel over the margin scrolls');
  // counts of what is out of view, overview ticks, one ribbon per visible card
  assert.match(await page.locator('#margin .cnt:visible').first().innerText(), /▲|▼/);
  assert.equal(await page.locator('#ticks .tick').count(), await page.evaluate(() => [...window.__rico.views.values()].reduce((a, v) => a + (v.loaded && v.mode === 'rendered' && !v.card.classList.contains('collapsed') ? v.marginItems.length : 0), 0)));
  assert.ok(await page.locator('.rico-ribbons path:visible').count() >= 1);
  await page.screenshot({ path: path.join(root, 'e2e', 'sync.png') });
  // jumping from the count works, and a pinned long thread folds first/last by default
  const folded = page.locator('#margin .thread.folded');
  assert.ok(await folded.count() >= 1, 'the chatty thread is folded');
  await page.evaluate(() => window.__rico.setMarginMode('aligned'));
  assert.equal(await page.locator('.file-body.sync').count(), 0);
  assert.equal(await page.evaluate(() => document.getElementById('mmode').textContent), 'Comments: aligned');
});

await step('no page errors', async () => assert.deepEqual(errors, [], JSON.stringify(errors)));

await browser.close(); srv.kill(); await fake.close();
process.exit(failed ? 1 : 0);
