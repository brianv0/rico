// End-to-end for a single commit: commit comments (flat, one line each, no reviews), in a real browser against the fake.
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
const PORT = 4800 + Math.floor(Math.random() * 400);
const srv = spawn('node', ['server.js'], { cwd: root, env: { ...process.env, PORT, GITHUB_TOKEN: 't', GITHUB_API_URL: `http://127.0.0.1:${fake.port}` } });
await new Promise((r) => srv.stdout.on('data', (d) => String(d).includes('running') && r()));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/Content Security Policy/.test(m.text())) errors.push(m.text()); });
let failed = false;
const step = async (name, fn) => { try { await fn(); console.log('ok   ' + name); } catch (e) { failed = true; console.log('FAIL ' + name + '\n     ' + e.message.split('\n').slice(0, 6).join(' | ')); await page.screenshot({ path: path.join(root, 'e2e', 'fail-commit.png') }).catch(() => {}); } };
const S = () => page.evaluate(() => { const s = window.__rico.state; return { threads: s.threads.map((t) => ({ id: t.id, end: t.end, n: t.msgs.length, local: !!t.local })), left: s.leftThreads.length, general: s.prThreads.length }; });

try {
  await step('a commit link loads: header, threads, and the address bar names the commit', async () => {
    await page.goto(`http://127.0.0.1:${PORT}/`);
    await page.fill('#pr', `https://github.com/acme/docs/commit/${SHA}`);
    await page.press('#pr', 'Enter');
    await page.waitForFunction(() => window.__rico.state.pr?.kind === 'commit' && document.querySelector('#margin .thread'), null, { timeout: 8000 });
    assert.equal(await page.textContent('#pr-title'), 'Tighten the plan');
    assert.match(await page.textContent('#pr-state'), /Commit/);
    assert.equal(await page.isHidden('#review-btn'), true);
    assert.match(await page.textContent('#commit-note'), /single commit.*not in any pull request/s);
    assert.equal(await page.getAttribute('#commit-note .cn-prs a', 'href'), '/github.com/acme/docs/7'); // the PR it belongs to, to review there instead
    assert.equal(new URL(page.url()).pathname, `/github.com/acme/docs/commit/${SHA}`);
    const s = await S();
    assert.deepEqual(s.threads.find((t) => t.id === 701), { id: 701, end: 6, n: 2, local: false }); // 701 + its same-line follow-up
    assert.equal(s.left, 1);
    assert.equal(s.general, 1);
  });

  await step('selecting two lines posts ONE commit comment on the last line, by diff position, with the range in words', async () => {
    const box = await page.evaluate(() => {
      const p = [...document.querySelectorAll('#doc p')].find((e) => e.textContent.includes('First paragraph'));
      const q = [...document.querySelectorAll('#doc p')].find((e) => e.textContent.includes('Second paragraph'));
      p.scrollIntoView({ block: 'center' });
      const a = p.getBoundingClientRect(); const b = q.getBoundingClientRect();
      return { x1: a.left + 2, y1: a.top + a.height / 2, x2: b.right - 2, y2: b.bottom - 4 };
    });
    await page.mouse.move(box.x1, box.y1); await page.mouse.down(); await page.mouse.move(box.x2, box.y2, { steps: 8 }); await page.mouse.up();
    await page.waitForSelector('#selbar:not([hidden])');
    assert.equal(await page.isDisabled('#sb-suggest'), true); // suggestions are a PR feature
    await page.click('#sb-comment');
    await page.waitForSelector('#composer:not([hidden])');
    assert.equal(await page.isHidden('#c-review'), true);
    assert.match(await page.textContent('#c-kind'), /Commit comment on abc1234/);
    assert.equal(await page.textContent('#c-add'), 'Comment on commit');
    assert.match(await page.textContent('#c-range'), /one line/);
    await page.fill('#c-body', 'Tighten these.');
    await page.click('#c-add');
    await page.waitForFunction(() => window.__rico.state.threads.some((t) => !t.local && t.msgs[0].body.includes('Tighten these.')), null, { timeout: 5000 });
    const op = fake.ops.filter((o) => o.op === 'commit-comment').at(-1);
    assert.equal(op.path, 'docs/plan.md');
    assert.equal(op.position, 7); // new line 6
    assert.match(op.body, /Selected lines 3–6 of `docs\/plan.md`/);
    assert.match(op.body, /Tighten these\./);
  });

  await step('reply in a thread posts another comment on the same line', async () => {
    await new Promise((r) => setTimeout(r, 800)); // let the refresh after the last post re-render the margin
    const card = page.locator('#margin .thread[data-id="701"]');
    await card.locator('.tacts button', { hasText: 'Reply' }).click({ force: true });
    await card.locator('.reply textarea').fill('Will do.');
    await card.locator('.reply button', { hasText: 'Reply' }).click({ force: true });
    await page.waitForFunction(() => window.__rico.state.threads.find((t) => t.id === 701)?.msgs.some((m) => m.body === 'Will do.'), null, { timeout: 5000 });
    const op = fake.ops.filter((o) => o.op === 'commit-comment').at(-1);
    assert.deepEqual({ path: op.path, position: op.position, body: op.body }, { path: 'docs/plan.md', position: 7, body: 'Will do.' });
  });
  await step('a general comment whose quote is a code block sits beside the lines its header names', async () => {
    fake.state.commitComments.push({ id: 7900, path: null, position: null, line: null, commit_id: SHA, user: { login: 'carol', avatar_url: null }, author_association: 'MEMBER', created_at: '2026-11-20T10:00:00Z', html_url: 'https://github.com/acme/docs/commit/x#commitcomment-7900', body: '**`docs/plan.md` L16**\n\n```\nnot findable as prose\n```\n\nConvert to D2?' });
    fake.state.version++;
    await page.evaluate(() => window.__rico.refreshComments(true));
    await page.waitForFunction(() => window.__rico.state.placed.get('i7900') === 'docs/plan.md', null, { timeout: 5000 });
    assert.equal(await page.locator('#general .thread[data-id="i7900"]').count(), 0);
    assert.equal(await page.locator('.rico-margin .thread[data-id="i7900"]').count(), 1);
    fake.state.commitComments.pop(); fake.state.version++;
  });

  await step('a PR shows none of it', async () => {
    await page.click('#commit-note .cn-prs a');
    await page.waitForFunction(() => window.__rico?.state.pr?.number === 7 && !window.__rico.state.pr.kind, null, { timeout: 8000 });
    assert.equal(await page.isHidden('#commit-note'), true);
    assert.equal(await page.isVisible('#review-btn'), true);
    assert.equal(await page.textContent('#c-add'), 'Comment');
  });
  await page.goBack();
  await page.waitForFunction(() => window.__rico?.state.pr?.kind === 'commit', null, { timeout: 8000 });
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: path.join('/tmp/claude-0/-home-user-rico/fe79f8af-5a9f-5061-b889-1cf9fd7e3416/scratchpad', 'commit.png') });
  await step('no page errors', async () => assert.deepEqual(errors, []));
} finally {
  await browser.close(); srv.kill(); await fake.close();
}
process.exit(failed ? 1 : 0);
