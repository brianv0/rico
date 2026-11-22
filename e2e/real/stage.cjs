// Live regression suite: drives real Chromium against Rico talking to REAL GitHub, on the throwaway PRs of brianv0/rico
// (#1 prose + threads, #5 Mermaid, #6 D2, #8 Graphviz). Complements e2e/run.mjs (fake GitHub, runs on every PR): this one
// catches what a fake cannot (GitHub hiding pending comments from REST, OAuth/session, the deployed bundle, real fonts).
//
//   Read-only (default): node e2e/real/stage.cjs                 posts nothing
//   Writes:              RICO_WRITE=1 node e2e/real/stage.cjs    comments / replies / pending review on PR #1 only
//
// Target (pick one):
//   RICO_URL=https://stage.ricorico.dev RICO_STORAGE=e2e/real/.auth.json   a deployed Rico, signed in via a saved session
//        node e2e/real/stage.cjs --login   opens a headed browser; sign in with GitHub once and the session is saved
//   GITHUB_TOKEN=<token with repo scope>                                    (no RICO_URL) starts a local `node server.js`
//
// Safety: writes only ever touch brianv0/rico PRs 1-8, every body starts with "REAL-STAGE:", and a cleanup pass
// (before and after) deletes every REAL-STAGE comment and discards any pending review. A SUBMITTED review cannot be deleted
// on GitHub, so submitting is off unless RICO_SUBMIT=1 (it leaves a review summary behind).
const { chromium } = require('playwright');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = 'brianv0/rico';
const WRITE = process.env.RICO_WRITE === '1';
const SUBMIT = process.env.RICO_SUBMIT === '1';
const STORAGE = process.env.RICO_STORAGE || path.join(__dirname, '.auth.json');
const PREFIX = 'REAL-STAGE:';
const WRITE_PR = 1; // the only PR the write tests may touch
const ALLOWED = new Set([1, 2, 3, 4, 5, 6, 7, 8]);

let failed = false;
let nfail = 0;
let page;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = async (name, fn) => {
  try { await fn(); console.log('ok   ' + name); } catch (e) {
    failed = true;
    console.log('FAIL ' + name + '\n     ' + String(e.message).split('\n').slice(0, 4).join(' | ').slice(0, 500));
    await page?.screenshot({ path: path.join(__dirname, `fail-${++nfail}.png`) }).catch(() => {});
  }
};

// ---------- target ----------
async function startTarget() {
  if (process.env.RICO_URL) return { base: process.env.RICO_URL.replace(/\/$/, ''), stop() {} };
  if (!process.env.GITHUB_TOKEN) throw new Error('set RICO_URL (a deployed Rico) or GITHUB_TOKEN (to start a local server)');
  const PORT = 4400 + Math.floor(Math.random() * 400);
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..', '..'), env: { ...process.env, PORT } });
  await new Promise((resolve, reject) => { srv.stdout.on('data', (d) => String(d).includes('running') && resolve()); srv.on('exit', () => reject(new Error('local server exited'))); });
  return { base: `http://localhost:${PORT}`, stop: () => srv.kill() };
}

// ---------- page helpers ----------
const prUrl = (base, n) => { assert.ok(ALLOWED.has(n), `PR #${n} is not a throwaway test PR`); return `${base}/github.com/${REPO}/${n}`; };
async function openPr(base, n, { frames = 0 } = {}) {
  await page.goto(prUrl(base, n));
  await page.waitForFunction(() => window.__rico?.state?.file && document.querySelector('#doc')?.textContent.length > 50, null, { timeout: 60000 });
  if (frames) await page.waitForFunction((k) => document.querySelectorAll('#doc iframe.dia-frame').length >= k, frames, { timeout: 90000 });
  await page.waitForFunction(() => !document.querySelector('#doc .dia-wait'), null, { timeout: 90000 }).catch(() => {});
}
const clickText = (re) => page.evaluate((src) => { const b = [...document.querySelectorAll('button')].find((x) => new RegExp(src).test(x.textContent.trim())); if (!b) throw new Error('no button ' + src); b.click(); }, re.source);
const setValue = (el, v) => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };

// Click an element inside the n-th diagram frame, return what the composer says, then close it.
// spec: {kind: 'sel', sel, text?} (a CSS selector, optionally filtered by text) | {kind: 'title', cls, key} (Graphviz group by <title>)
async function clickDiagram(n, spec) {
  const pt = await page.evaluate(async ([n, spec]) => {
    const frame = document.querySelectorAll('#doc iframe.dia-frame')[n];
    frame.scrollIntoView({ block: 'center' });
    await new Promise((r) => setTimeout(r, 400)); // the frame resizes itself to its diagram after it loads
    const d = frame.contentDocument;
    let el;
    if (spec.kind === 'title') { // click the group's label: the middle of an edge's or a cluster's box can be empty space
      const g = [...d.querySelectorAll(`g.${spec.cls}`)].find((x) => x.querySelector(':scope > title')?.textContent === spec.key);
      el = g && (g.querySelector('text') || g);
    }
    else el = [...d.querySelectorAll(spec.sel)].find((e) => !spec.text || e.textContent.trim().replace(/\s+/g, ' ') === spec.text);
    if (!el) throw new Error('no element ' + JSON.stringify(spec));
    el.scrollIntoView({ block: 'center', inline: 'center' });
    frame.scrollIntoView({ block: 'center' });
    await new Promise((r) => setTimeout(r, 200));
    const fr = frame.getBoundingClientRect(); const r = el.getBoundingClientRect();
    return { x: fr.left + r.left + r.width / 2, y: fr.top + r.top + r.height / 2 };
  }, [n, spec]);
  await page.mouse.click(pt.x, pt.y);
  await page.waitForSelector('#composer:not([hidden])', { timeout: 5000 });
  const range = (await page.locator('#c-range').innerText()).trim();
  await page.keyboard.press('Escape');
  return range;
}
const frameInfo = () => page.evaluate(() => [...document.querySelectorAll('#doc iframe.dia-frame')].map((f) => { const s = f.contentDocument.querySelector('svg'); const vb = (s?.getAttribute('viewBox') || '').split(/[ ,]+/).map(Number); return { svg: !!s, vbw: vb[2], w: s ? Math.round(s.getBoundingClientRect().width) : 0, h: Math.round(f.getBoundingClientRect().height) }; }));
const diaErrors = () => page.evaluate(() => [...document.querySelectorAll('#doc .dia-err')].map((e) => e.innerText));

// ---------- write helpers (PR #1) ----------
async function selectText(snippet, occurrence, chars = 26) {
  const box = await page.evaluate(([snippet, occurrence, chars]) => {
    const w = document.createTreeWalker(document.getElementById('doc'), NodeFilter.SHOW_TEXT);
    let seen = -1;
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const i = n.data.indexOf(snippet);
      if (i < 0 || ++seen !== occurrence) continue;
      n.parentElement.scrollIntoView({ block: 'center' });
      const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + chars);
      const b = r.getBoundingClientRect();
      return { x0: b.left + 1, x1: b.right - 1, y: b.top + b.height / 2 };
    }
    throw new Error('text not found: ' + snippet);
  }, [snippet, occurrence, chars]);
  await page.mouse.move(box.x0, box.y);
  await page.mouse.down();
  await page.mouse.move(box.x1, box.y, { steps: 8 });
  await page.mouse.up();
  await page.waitForFunction(() => !document.getElementById('selbar').hidden, null, { timeout: 5000 });
}
// Select text in the ADDED paragraph, open the composer with the first (Comment) pill button, type, and click `button`.
async function composeOnAddedParagraph(body, button) {
  await selectText('Rico lets a reviewer read the rendered markdown', 1);
  await page.locator('#selbar button').first().click();
  await page.waitForSelector('#composer:not([hidden])');
  await page.evaluate(([setSrc, body]) => { const ta = document.getElementById('c-body'); new Function('el', 'v', setSrc)(ta, body); }, [`(${setValue.toString()})(el, v)`, body]);
  await clickText(button);
}
const threadWith = (text) => page.waitForFunction((t) => [...document.querySelectorAll('.thread')].some((x) => x.textContent.includes(t)), text, { timeout: 30000 });
const threadState = (text) => page.evaluate((t) => { const th = [...document.querySelectorAll('.thread')].find((x) => x.textContent.includes(t)); return th ? { cls: th.className, msgs: th.querySelectorAll('.msg').length, text: th.innerText } : null; }, text);
const waitReview = (src) => page.waitForFunction((re) => new RegExp(re).test([...document.querySelectorAll('button')].find((b) => /^(Finish review|Review changes)/.test(b.textContent.trim()))?.textContent.trim().replace(/\s+/g, ' ') || ''), src, { timeout: 30000 });
const reviewButton = () => page.evaluate(() => [...document.querySelectorAll('button')].find((b) => /^(Finish review|Review changes)/.test(b.textContent.trim()))?.textContent.trim().replace(/\s+/g, ' '));
// Delete a message: the confirmation ("Really delete?") expires after a couple of seconds, so both clicks happen in one go.
const deleteMsg = (text) => page.evaluate(async (t) => {
  const m = [...document.querySelectorAll('.msg')].find((x) => x.textContent.includes(t));
  if (!m) return false;
  [...m.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Delete').click();
  await new Promise((r) => setTimeout(r, 250));
  [...m.querySelectorAll('button')].find((b) => /Really delete/.test(b.textContent)).click();
  return true;
}, text);
const discardPending = () => page.evaluate(async () => {
  const f = (re) => [...document.querySelectorAll('button')].find((b) => re.test(b.textContent.trim()));
  if (!f(/^Finish review/)) return false;
  f(/^Finish review/).click(); await new Promise((r) => setTimeout(r, 500));
  f(/^Discard review$/).click(); await new Promise((r) => setTimeout(r, 250));
  f(/Really discard/).click(); return true;
});
async function cleanup(base) {
  await openPr(base, WRITE_PR);
  for (let i = 0; i < 12; i++) { // newest first: a thread's replies go before its root
    const t = await page.evaluate((p) => [...document.querySelectorAll('.msg')].filter((m) => m.textContent.includes(p)).map((m) => m.innerText.split('\n').find((l) => l.includes(p))).pop(), PREFIX);
    if (!t) break;
    await deleteMsg(t);
    await sleep(2500);
  }
  if ((await reviewButton()).startsWith('Finish review')) { await discardPending(); await sleep(3000); }
}

// ---------- the suite ----------
(async () => {
  if (process.argv.includes('--login')) {
    const target = await startTarget();
    const b = await chromium.launch({ headless: false });
    const ctx = await b.newContext();
    const p = await ctx.newPage();
    await p.goto(target.base);
    console.log('Sign in with GitHub in the browser window; the session is saved when "Sign out" appears.');
    await p.waitForSelector('text=Sign out', { timeout: 300000 });
    await ctx.storageState({ path: STORAGE });
    console.log('saved ' + STORAGE);
    await b.close(); target.stop();
    return;
  }

  const target = await startTarget();
  const base = target.base;
  const browser = await chromium.launch();
  const ctxOpts = { viewport: { width: 1447, height: 900 }, colorScheme: 'dark' };
  if (process.env.RICO_URL && fs.existsSync(STORAGE)) ctxOpts.storageState = STORAGE;
  const ctx = await browser.newContext(ctxOpts);
  page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const reqs = [];
  page.on('request', (r) => reqs.push(r.url()));
  const signedIn = !process.env.RICO_URL || fs.existsSync(STORAGE);

  // ----- read-only -----
  await step('Mermaid (#5): 2 diagrams render without errors; clicking a node opens the composer on its line', async () => {
    await openPr(base, 5, { frames: 2 });
    assert.deepEqual(await diaErrors(), []);
    assert.ok((await frameInfo()).every((f) => f.svg), 'every frame holds an SVG');
    assert.equal(await clickDiagram(0, { kind: 'sel', sel: 'g.node', text: 'Select text' }), 'Comments on line 25');
  });
  await step('D2 (#6): the JavaScript port draws (no WASM request), fonts load, node click maps to its line', async () => {
    reqs.length = 0;
    await openPr(base, 6, { frames: 2 });
    assert.deepEqual(await diaErrors(), []);
    assert.equal(reqs.filter((u) => /\/vendor\/d2\.js/.test(u)).length, 0, 'the WASM build must not be needed');
    assert.ok(reqs.some((u) => /\/d2\/d2lib\.js/.test(u)), 'the JS port is loaded');
    const fonts = await page.evaluate(async () => Promise.all([...document.querySelectorAll('#doc iframe.dia-frame')].map(async (f) => { await Promise.race([f.contentDocument.fonts.ready, new Promise((r) => setTimeout(r, 15000))]); return [...f.contentDocument.fonts].map((x) => x.status); })));
    assert.ok(fonts.every((s) => s.length && s.every((x) => x === 'loaded')), 'diagram fonts loaded: ' + JSON.stringify(fonts));
    assert.equal(await clickDiagram(0, { kind: 'sel', sel: 'text', text: 'Select text' }), 'Comments on line 27');
  });
  await step('D2 (#6): a diagram is never drawn larger than its natural (viewBox) width', async () => {
    await openPr(base, 6, { frames: 2 });
    for (const f of await frameInfo()) assert.ok(f.w <= f.vbw + 1, `drawn ${f.w}px wide, natural ${f.vbw}px`);
  });
  await step('Graphviz (#8): nodes, edges and clusters map to their source lines', async () => {
    await openPr(base, 8, { frames: 2 });
    assert.deepEqual(await diaErrors(), []);
    assert.equal(await clickDiagram(0, { kind: 'title', cls: 'node', key: 'select' }), 'Comments on line 27');
    assert.equal(await clickDiagram(0, { kind: 'title', cls: 'edge', key: 'choose->pending' }), 'Comments on line 39');
    assert.equal(await clickDiagram(0, { kind: 'title', cls: 'cluster', key: 'cluster_review' }), 'Comments on lines 31–36');
  });
  for (const scheme of ['dark', 'light']) {
    await step(`Graphviz (#8) in the ${scheme} theme: no white page; dark inverts the colours`, async () => {
      const c = await browser.newContext({ ...ctxOpts, colorScheme: scheme });
      const p = await c.newPage();
      const saved = page; page = p;
      try {
        await openPr(base, 8, { frames: 2 });
        const r = await p.evaluate(() => { const d = document.querySelector('#doc iframe.dia-frame').contentDocument; return { bg: getComputedStyle(d.querySelector('g.graph > polygon')).fill, filter: getComputedStyle(d.querySelector('svg')).filter }; });
        assert.match(r.bg, /rgba\(0, 0, 0, 0\)|transparent/);
        assert.equal(/invert/.test(r.filter), scheme === 'dark', 'filter: ' + r.filter);
      } finally { page = saved; await c.close(); }
    });
  }
  await step('comment column: 340-560px with the file tree open, wider when it is collapsed', async () => {
    await openPr(base, 1);
    const w = () => page.evaluate(() => Math.round(document.querySelector('.rico-margin').getBoundingClientRect().width));
    const open = await w();
    assert.ok(open >= 340 && open <= 560, `open: ${open}px`);
    await page.evaluate(() => document.querySelector('[aria-label="Toggle file tree"]').click());
    await sleep(800);
    const closed = await w();
    await page.evaluate(() => document.querySelector('[aria-label="Toggle file tree"]').click());
    assert.ok(closed > open && closed <= 560, `collapsed: ${closed}px vs open ${open}px`);
  });
  await step('existing review threads show as cards in the margin', async () => {
    await openPr(base, 1);
    assert.ok((await page.locator('.thread').count()) >= 5);
  });

  // ----- writes (PR #1, REAL-STAGE: only) -----
  if (!WRITE) console.log('skip writes (set RICO_WRITE=1)');
  else if (!signedIn) console.log('skip writes (no session: run with --login first, or use GITHUB_TOKEN locally)');
  else {
    try {
      await cleanup(base);
      await step('write: a single comment on an added line appears as a thread', async () => {
        await openPr(base, WRITE_PR);
        await composeOnAddedParagraph(`${PREFIX} single`, /^Comment$/);
        await threadWith(`${PREFIX} single`);
        await sleep(2500); // a card that failed to post stays as a dashed draft with "Not posted: <reason>"
        const t = await threadState(`${PREFIX} single`);
        assert.ok(!/Not posted/.test(t.text), t.text.replace(/\n+/g, ' | '));
        assert.ok(/Reply/.test(t.text), 'posted threads have a Reply button: ' + t.text.replace(/\n+/g, ' | '));
      });
      await step('write: reply, edit and delete the reply', async () => {
        await page.evaluate(async (t) => { const th = [...document.querySelectorAll('.thread')].find((x) => x.textContent.includes(t)); [...th.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Reply').click(); await new Promise((r) => setTimeout(r, 300)); const ta = th.querySelector('.reply textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, 'REAL-STAGE: reply'); ta.dispatchEvent(new Event('input', { bubbles: true })); th.querySelector('.reply .btn-primary').click(); }, `${PREFIX} single`);
        await page.waitForFunction(() => [...document.querySelectorAll('.msg')].some((m) => m.textContent.includes('REAL-STAGE: reply')), null, { timeout: 30000 });
        await page.evaluate(async () => { const m = [...document.querySelectorAll('.msg')].find((x) => x.textContent.includes('REAL-STAGE: reply')); [...m.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Edit').click(); await new Promise((r) => setTimeout(r, 300)); const ta = m.querySelector('textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, 'REAL-STAGE: reply (edited)'); ta.dispatchEvent(new Event('input', { bubbles: true })); [...m.querySelectorAll('button')].find((b) => /Update/.test(b.textContent)).click(); });
        await page.waitForFunction(() => [...document.querySelectorAll('.msg')].some((m) => m.textContent.includes('reply (edited)') && !m.querySelector('textarea')), null, { timeout: 30000 });
        assert.equal(await deleteMsg('REAL-STAGE: reply (edited)'), true);
        await page.waitForFunction(() => ![...document.querySelectorAll('.msg')].some((m) => m.textContent.includes('reply (edited)')), null, { timeout: 30000 });
      });
      await step('write: resolve and reopen a thread', async () => {
        await page.evaluate(async (t) => { const th = [...document.querySelectorAll('.thread')].find((x) => x.textContent.includes(t)); [...th.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Resolve').click(); }, `${PREFIX} single`);
        await page.waitForFunction((t) => [...document.querySelectorAll('.thread.resolved')].some((x) => x.textContent.includes(t)), `${PREFIX} single`, { timeout: 30000 });
        await page.evaluate(async (t) => { const f = () => [...document.querySelectorAll('.thread')].find((x) => x.textContent.includes(t)); [...f().querySelectorAll('button')].find((b) => b.textContent.trim() === 'Show').click(); await new Promise((r) => setTimeout(r, 300)); [...f().querySelectorAll('button')].find((b) => /Reopen/.test(b.textContent)).click(); }, `${PREFIX} single`);
        await page.waitForFunction((t) => { const th = [...document.querySelectorAll('.thread')].find((x) => x.textContent.includes(t)); return th && !th.classList.contains('resolved'); }, `${PREFIX} single`, { timeout: 30000 });
      });
      await step('write: delete the comment', async () => {
        assert.equal(await deleteMsg(`${PREFIX} single`), true);
        await page.waitForFunction((t) => ![...document.querySelectorAll('.thread')].some((x) => x.textContent.includes(t)), `${PREFIX} single`, { timeout: 30000 });
      });
      await step('write: a pending review survives a reload, can be edited, and discards cleanly', async () => {
        await openPr(base, WRITE_PR);
        await composeOnAddedParagraph(`${PREFIX} pending`, /^(Start a review|Add to review)$/);
        await page.waitForFunction(() => document.querySelector('.thread.pending'), null, { timeout: 30000 }); // not the dashed draft: the saved pending comment
        await threadWith(`${PREFIX} pending`);
        await waitReview('^Finish review 1');
        assert.match((await threadState(`${PREFIX} pending`)).cls, /pending/);
        await openPr(base, WRITE_PR); // a hard reload: GitHub's REST hides pending comments, Rico must load them another way
        await threadWith(`${PREFIX} pending`);
        await waitReview('^Finish review 1');
        await page.evaluate(async () => { const m = [...document.querySelectorAll('.thread.pending .msg')].find((x) => x.textContent.includes('REAL-STAGE: pending')); [...m.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Edit').click(); await new Promise((r) => setTimeout(r, 300)); const ta = m.querySelector('textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, 'REAL-STAGE: pending (edited)'); ta.dispatchEvent(new Event('input', { bubbles: true })); [...m.querySelectorAll('button')].find((b) => /Update/.test(b.textContent)).click(); });
        await page.waitForFunction(() => [...document.querySelectorAll('.thread.pending .msg')].some((m) => m.textContent.includes('pending (edited)') && !m.querySelector('textarea')), null, { timeout: 30000 });
        assert.equal(await discardPending(), true);
        await page.waitForFunction(() => !document.querySelector('.thread.pending'), null, { timeout: 30000 });
        await waitReview('^Review changes');
      });
      if (SUBMIT) console.log('RICO_SUBMIT=1: submitting a review leaves a review summary on GitHub that cannot be deleted; not implemented in this run');
    } finally {
      await cleanup(base).catch((e) => console.log('cleanup failed: ' + e.message));
    }
  }

  await step('no page errors', async () => assert.deepEqual(errors, []));
  await browser.close();
  target.stop();
  console.log(failed ? '\nFAILED' : '\nall live checks passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
