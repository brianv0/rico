// End-to-end for reviewing AI spec-driven work: the spec review steps (a Spec Kit PR), what changed since your review,
// comments that were outdated and found again, the needs-you list and GitHub's viewed marks. Real browser, fake GitHub.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFake, AVATAR } from '../test/fake-github.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const fake = await startFake();
const PORT = 5200 + Math.floor(Math.random() * 400);
const srv = spawn('node', ['server.js'], { cwd: root, env: { ...process.env, PORT, GITHUB_TOKEN: 't', GITHUB_API_URL: `http://127.0.0.1:${fake.port}` } });
await new Promise((r) => srv.stdout.on('data', (d) => String(d).includes('running') && r()));
const browser = await chromium.launch();
const errors = [];
const newPage = async () => {
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } }); // a fresh context: nothing remembered from the last scenario
  const pg = await ctx.newPage();
  pg.on('pageerror', (e) => errors.push(e.message));
  await pg.addInitScript(() => { try { localStorage.setItem('rico:margin', 'aligned'); } catch { /* ignore */ } });
  return pg;
};
let page = await newPage();
let failed = false;
const step = async (name, fn) => { try { await fn(); console.log('ok   ' + name); } catch (e) { failed = true; console.log('FAIL ' + name + '\n     ' + e.message.split('\n').slice(0, 8).join(' | ')); await page.screenshot({ path: path.join(root, 'e2e', 'fail-spec.png') }).catch(() => {}); } };
const R = (fn, arg) => page.evaluate(fn, arg);
const open = (p) => page.goto(`http://127.0.0.1:${PORT}${p}`);
const cardPaths = () => R(() => [...document.querySelectorAll('#cards .file-card')].map((c) => c.dataset.path));

try {
  // ---------------------------------------------------------------- Spec Kit
  await step('a Spec Kit PR is recognised, and its unchanged neighbours (spec.md, the constitution) join as steps in reading order', async () => {
    await open('/github.com/acme/docs/8');
    await page.waitForFunction(() => window.__rico.state.spec?.refs.length === 3 && window.__rico.state.spec.steps.length === 5, null, { timeout: 10000 });
    assert.match(await page.textContent('#spec-menu summary'), /Spec review · Spec Kit/);
    const want = ['.specify/memory/constitution.md', 'specs/001-login/spec.md', 'specs/001-login/checklists/requirements.md', 'specs/001-login/plan.md', 'specs/001-login/tasks.md'];
    assert.deepEqual(await cardPaths(), want);
    const collapsed = await R(() => [...document.querySelectorAll('#cards .file-card')].map((c) => c.classList.contains('collapsed')));
    assert.deepEqual(collapsed, [true, true, true, false, false]); // the references wait to be opened
    assert.match(await page.textContent('#cards .file-card[data-path$="spec.md"] .file-header'), /Unchanged · for reference/);
    assert.equal(await page.locator('#cards .file-card[data-path$="spec.md"] .viewed').isHidden(), true);
    assert.deepEqual(await R(() => [...document.querySelectorAll('#files .tree-file.step')].map((r) => r.querySelector('b').textContent)), ['Constitution', 'Spec', 'Checklist', 'Plan', 'Tasks']);
    assert.match(await page.textContent('#spec-pos'), /Step 4 of 5 · Plan/); // it opened on the first file that changed
    assert.equal(await page.locator('#files .tree-file.step.ref').count(), 3);
  });

  await step('open questions are marked, counted and ticked on the scrollbar; ids link to where they are defined', async () => {
    await page.waitForFunction(() => document.querySelectorAll('#cards .spec-q:not(.todo)').length === 2 && document.querySelectorAll('#cards .spec-id').length >= 3, null, { timeout: 8000 });
    assert.match(await page.textContent('#spec-q'), /2 open questions/);
    await page.waitForFunction(() => document.querySelectorAll('#ticks .tick.q').length === 1, null, { timeout: 4000 }); // the reference card is collapsed, so only plan.md's question has a place on the page
    assert.match(await page.textContent('#files .tree-file.step:nth-child(3)'), /\? 1/); // the unit header takes child 1, constitution is 2
    const ids = await R(() => [...document.querySelectorAll('#cards .file-card[data-path$="plan.md"] .spec-id')].map((e) => e.dataset.id));
    assert.deepEqual(ids, ['FR-001', 'FR-002']);
    // T010 mentions FR-001; the line that defines T010 does not link to itself, the one that says "after T010" does
    const tasks = await R(() => [...document.querySelectorAll('#cards .file-card[data-path$="tasks.md"] .spec-id')].map((e) => e.dataset.id));
    assert.ok(tasks.includes('T010') && tasks.includes('FR-001'));
    assert.equal(tasks.filter((t) => t === 'T010').length, 1);
    await page.click('#cards .file-card[data-path$="plan.md"] .spec-id[data-id="FR-001"]');
    await page.waitForFunction(() => window.__rico.state.file?.filename === 'specs/001-login/spec.md');
    assert.equal(await page.locator('#cards .file-card[data-path$="spec.md"]').evaluate((c) => c.classList.contains('collapsed')), false);
    await page.waitForSelector('#cards .file-card[data-path$="spec.md"] .spec-flash');
    assert.match(await page.textContent('#cards .file-card[data-path$="spec.md"] .spec-flash'), /FR-001/);
  });

  await step('Next marks the file viewed and moves on; on the last step it opens the review dialog', async () => {
    await page.click('#cards .file-card[data-path$="plan.md"] .file-next button');
    await page.waitForFunction(() => window.__rico.state.file?.filename === 'specs/001-login/tasks.md');
    assert.equal(await R(() => window.__rico.state.viewed.has('specs/001-login/plan.md')), true);
    assert.equal(await page.locator('#cards .file-card[data-path$="plan.md"]').evaluate((c) => c.classList.contains('collapsed')), true);
    assert.match(await page.textContent('#spec-pos'), /Step 5 of 5 · Tasks/);
    assert.equal((await page.textContent('#spec-next')).trim(), 'Finish review');
    assert.match(await page.textContent('#cards .file-card[data-path$="tasks.md"] .file-next .hint'), /map to a task/);
    await page.click('#spec-next');
    await page.waitForSelector('#review-pop:not([hidden])');
    await page.click('#review-close');
  });

  await step('the sidebar can show all files instead, and the workflow can be switched off and on again', async () => {
    await page.click('#tree-mode button[data-tree="files"]');
    assert.equal(await page.locator('#files .tree-file.step').count(), 0);
    assert.ok(await page.locator('#files .tree-file', { hasText: 'login.ts' }).count() >= 1);
    await page.click('#tree-mode button[data-tree="steps"]');
    await page.click('#spec-menu summary');
    await page.click('#spec-menu .menu-item:has-text("Off")');
    await page.waitForFunction(() => window.__rico.state.pr && window.__rico.state.spec?.pref === 'off' && window.__rico.state.spec.on === false && window.__rico.views.size === 2, null, { timeout: 8000 });
    assert.deepEqual(await cardPaths(), ['specs/001-login/plan.md', 'specs/001-login/tasks.md']); // the PR's own order, no references
    assert.match(await page.textContent('#spec-menu summary'), /Spec review: off/);
    assert.equal(await page.locator('.file-next:visible').count(), 0);
    await page.click('#spec-menu summary');
    await page.click('#spec-menu .menu-item:has-text("Auto-detect")');
    await page.waitForFunction(() => window.__rico.state.spec?.on && window.__rico.state.spec.steps.length === 5, null, { timeout: 8000 });
  });

  // ---------------------------------------------------------------- a second round of review
  const OLD = 'aaaa0000bbbb1111';
  const OLD_PLAN = [
    '# Plan', '', 'An older intro paragraph that was later deleted entirely.', '', 'First paragraph here, with the older wording about timeouts.', '',
    'Second paragraph is hard', 'wrapped across two lines for testing.', '', '- item one', '- item two', '', '```js', 'const a = 1;', '```', '',
  ].join('\n');
  fake.state.contents.set(`${OLD}:docs/plan.md`, OLD_PLAN);
  fake.state.reviews = [{ id: 1, user: { login: 'me' }, commit_id: OLD, submitted_at: '2026-11-19T12:00:00Z', state: 'COMMENTED' }];
  fake.state.viewedFiles = { 'docs/plan.md': 'DISMISSED', 'docs/complex.md': 'VIEWED' };
  const T = (o) => ({ side: 'RIGHT', path: 'docs/plan.md', author_association: 'MEMBER', user: { login: 'me', avatar_url: AVATAR }, created_at: '2026-11-19T12:00:00Z', html_url: 'https://github.com/acme/docs/pull/7#discussion_r' + o.id, line: null, commit_id: OLD, original_commit_id: OLD, ...o });
  fake.state.comments.push(
    T({ id: 901, original_start_line: 7, original_line: 8, body: '> Second paragraph is hard wrapped across two lines for testing.\n\nCan this be shorter?' }),
    T({ id: 902, original_line: 5, body: '> First paragraph here, with the older wording about timeouts.\n\nWhy mention timeouts?' }),
    T({ id: 903, in_reply_to_id: 902, original_line: 5, user: { login: 'review-bot[bot]', type: 'Bot', avatar_url: AVATAR }, created_at: '2026-11-20T09:00:00Z', body: 'Done: I trimmed the timeouts note.' }),
    T({ id: 904, original_line: 3, body: '> An older intro paragraph that was later deleted entirely.\n\nDrop this intro?' }),
  );
  fake.state.version++;
  page = await newPage();

  await step('a second round: outdated comments are found again, and say what changed', async () => {
    await open('/github.com/acme/docs/7?file=docs/plan.md');
    await page.waitForFunction(() => { const t = window.__rico.state.threads.find((x) => x.id === 902); return t?.reanchor && window.__rico.state.threads.find((x) => x.id === 901)?.reanchor; }, null, { timeout: 10000 });
    const info = await R(() => Object.fromEntries([901, 902, 904].map((id) => { const t = window.__rico.state.threads.find((x) => x.id === id); return [id, t.reanchor ? { how: t.reanchor.how, start: t.start, end: t.end } : null]; })));
    assert.deepEqual(info[901], { how: 'rewrapped', start: 5, end: 6 }); // the same words, wrapped differently
    assert.deepEqual(info[902], { how: 'fuzzy', start: 3, end: 3 }); // reworded: found by the words it shares
    assert.equal(info[904], null); // gone
    const where = await R(() => Object.fromEntries(window.__rico.views.get('docs/plan.md').marginItems.filter((m) => [901, 902].includes(m.th.id)).map((m) => [m.th.id, m.blocks[0].textContent.slice(0, 20)])));
    assert.ok(where[901].startsWith('Second paragraph is') && where[902].startsWith('First paragraph here')); // beside the text, not beside whatever now has the old line numbers
    const badge = (id) => page.locator(`#margin .thread[data-id="${id}"] .badge`).allTextContents();
    assert.ok((await badge(901)).includes('Outdated · moved'));
    assert.ok((await badge(902)).includes('Outdated · probably here'));
    assert.ok((await badge(902)).includes('agent')); // the reply is from a bot
    assert.ok((await badge(902)).includes('Text changed'));
    assert.ok((await badge(904)).includes('Outdated · text not found'));
    const tn = page.locator('#margin .thread[data-id="902"] .thennow');
    assert.equal(await tn.count(), 1);
    await tn.locator('summary').click();
    assert.match(await tn.locator('del').first().innerText(), /timeouts/);
    assert.equal(await page.locator('#margin .thread[data-id="901"] .thennow').count(), 0); // only re-wrapped: nothing to compare
  });

  await step('changes since your review are marked in the text (words, removals, new blocks), not for a mere re-wrap', async () => {
    assert.equal(await page.inputValue('#since-sel'), OLD);
    assert.match(new URL(page.url()).search, /since=aaaa000/);
    const doc = await R(() => {
      const d = window.__rico.views.get('docs/plan.md').doc;
      const blk = (t) => [...d.querySelectorAll('[data-l]')].find((e) => !e.querySelector('[data-l]') && e.textContent.startsWith(t));
      return {
        first: blk('First paragraph here.').classList.contains('since'),
        second: blk('Second paragraph is hard wrapped').classList.contains('since'),
        ghost: [...d.querySelectorAll('.sdel')].map((e) => e.dataset.t),
        gone: [...d.querySelectorAll('.since-gone')].map((e) => e.dataset.t),
        ghostInText: d.textContent.includes('timeouts'), // ghost words are not part of the text
      };
    });
    assert.equal(doc.first, true);
    assert.equal(doc.second, false);
    assert.ok(doc.ghost.some((t) => /timeouts/.test(t)));
    assert.ok(doc.gone.some((t) => /older intro paragraph/.test(t)));
    assert.equal(doc.ghostInText, false);
    assert.match(await page.textContent('#since-count'), /\d+ blocks? changed/);
    assert.equal(await page.locator('#legend-since').isVisible(), true);
    // files that did not exist then are new since then
    assert.equal(await page.locator('.file-card[data-path="docs/complex.md"]').evaluate((c) => c.classList.contains('since-new')), true);
    assert.equal(await page.locator('.file-card[data-path="docs/complex.md"] .since').count(), 0); // said once, on the header: not on every block
    await page.waitForFunction(() => /\d+ blocks? changed · 4 new files/.test(document.getElementById('since-count')?.textContent || ''), null, { timeout: 5000 }); // the slowest file counts when it has loaded
    assert.equal(await R(() => document.body.classList.contains('since-on')), true); // the PR's own marks step back while this layer is on
  });

  await step('the gutter: an amber column beside the text for what changed since, apart from the PR\'s own bars', async () => {
    const g = await R(() => {
      const d = document.getElementById('doc');
      const dr = d.getBoundingClientRect();
      const blk = (t) => [...d.querySelectorAll('[data-l]')].find((e) => !e.querySelector('[data-l]') && e.textContent.startsWith(t));
      const bars = [...d.querySelectorAll('.rico-bars i')].map((b) => { const r = b.getBoundingClientRect(); return { k: b.className, x: Math.round(r.left - dr.left), top: r.top, bottom: r.bottom, title: b.title }; });
      const over = (b, e) => { const r = e.getBoundingClientRect(); return b.top < r.bottom && b.bottom > r.top; };
      const first = blk('First paragraph here.');
      const second = blk('Second paragraph is hard wrapped');
      const gone = d.querySelector('.since-gone');
      return {
        since: bars.filter((b) => b.k === 'since'), sgone: bars.filter((b) => b.k === 'sgone'), pr: bars.filter((b) => ['chg', 'ctx', 'out'].includes(b.k)),
        onFirst: bars.filter((b) => b.k === 'since' && over(b, first)).length,
        sinceOnSecond: bars.filter((b) => b.k === 'since' && over(b, second)).length, prOnSecond: bars.filter((b) => b.k === 'chg' && over(b, second)).length,
        goneBar: bars.filter((b) => b.k === 'sgone' && over(b, gone)).length,
      };
    });
    assert.equal(g.onFirst, 1); // the reworded paragraph
    assert.equal(g.sinceOnSecond, 0); // only re-wrapped: in the PR's diff, not changed since
    assert.ok(g.prOnSecond >= 1);
    assert.equal(g.goneBar, 1); // the removed intro has its own (dashed) bar
    assert.ok(Math.min(...g.since.map((b) => b.x)) > Math.max(...g.pr.map((b) => b.x)), 'the since column sits nearer the text than the PR column');
    assert.match(g.since[0].title, /Changed since your review/);
    assert.match(g.sgone[0].title, /Text removed since your review/);
    await page.waitForFunction(() => document.querySelectorAll('#ticks .tick.since').length >= 1, null, { timeout: 4000 }); // and down the scrollbar, to see where to look in a long file
    assert.match(await page.locator('#ticks .tick.since').first().getAttribute('title'), /Changed since your review/);
  });

  await step('choosing the whole PR clears the marks; the baseline is in the link', async () => {
    await page.selectOption('#since-sel', '');
    await page.waitForFunction(() => document.querySelectorAll('#cards .since, #cards .sdel, #cards .since-gone').length === 0);
    await page.waitForFunction(() => document.querySelectorAll('#doc .rico-bars i.since, #doc .rico-bars i.sgone, #ticks .tick.since').length === 0, null, { timeout: 4000 }); // the gutter and the scrollbar clear with it
    assert.doesNotMatch(new URL(page.url()).search, /since=/);
    assert.equal(await page.locator('#legend-since').isHidden(), true);
    assert.equal(await R(() => document.body.classList.contains('since-on')), false);
    assert.equal(await R(() => window.__rico.state.threads.find((x) => x.id === 902).sinceChanged), false);
    await page.selectOption('#since-sel', OLD);
    await page.waitForSelector('#cards .since');
    assert.match(new URL(page.url()).search, /since=aaaa000/);
  });

  await step('the needs-you list: replies and changed text, not threads that only wrapped differently', async () => {
    await page.waitForSelector('#queue-bar:not([hidden])');
    assert.equal((await page.textContent('#queue-bar .Counter')).trim(), '2');
    await page.click('#queue-menu summary');
    const items = await page.locator('#queue-menu .queue-item').allTextContents();
    assert.equal(items.length, 2);
    assert.match(items[0], /plan\.md · line 3.*review-bot\[bot\] \(agent\) replied · text changed.*trimmed the timeouts/s);
    assert.match(items[1], /text changed.*Drop this intro/s);
    await page.click('#queue-menu .queue-item >> nth=0');
    await page.waitForSelector('#margin .thread[data-id="902"].flash');
    await page.keyboard.press(']'); // the next one
    await page.waitForSelector('#margin .thread[data-id="904"].flash');
    await page.keyboard.press('[');
    await page.waitForSelector('#margin .thread[data-id="902"].flash');
  });

  await step('viewed marks come from GitHub: shown, "changed since" noticed, and ticking one is saved there', async () => {
    assert.equal(await R(() => window.__rico.state.viewedSync), true);
    assert.equal(await R(() => window.__rico.state.viewed.has('docs/complex.md')), true);
    assert.equal(await page.locator('#files .tree-file[data-path="docs/plan.md"] .tick.changed').count(), 1);
    assert.equal(await page.locator('#files .tree-file[data-path="docs/complex.md"] .tick:not(.changed)').count(), 1);
    await page.check('.file-card[data-path="docs/github.md"] .viewed input');
    for (let i = 0; i < 40 && !fake.ops.some((o) => o.op === 'viewed' && o.path === 'docs/github.md'); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(fake.ops.some((o) => o.op === 'viewed' && o.path === 'docs/github.md'));
    await page.uncheck('.file-card[data-path="docs/github.md"] .viewed input');
    for (let i = 0; i < 40 && !fake.ops.some((o) => o.op === 'unviewed'); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(fake.ops.some((o) => o.op === 'unviewed' && o.path === 'docs/github.md'));
  });

  await step('a baseline that no longer exists (force-pushed away) is dropped, with a message, not shown as a wall of new text', async () => {
    await open('/github.com/acme/docs/7?file=docs/plan.md&since=deadbeefdead');
    await page.waitForFunction(() => /no longer in the repository/.test(document.getElementById('status').textContent), null, { timeout: 8000 });
    assert.equal(await R(() => window.__rico.state.since), null);
    assert.ok(!(await page.locator('#since-sel option').allTextContents()).some((t) => /deadbee/.test(t)));
    assert.equal(await page.locator('#cards .since').count(), 0);
  });

  await step('GitHub without the viewed field still loads and keeps marks in the browser', async () => {
    fake.state.viewedFiles = null;
    page = await newPage();
    await open('/github.com/acme/docs/7?file=docs/plan.md');
    await page.waitForFunction(() => window.__rico.state.pr && window.__rico.views.get('docs/plan.md')?.loaded);
    assert.equal(await R(() => window.__rico.state.viewedSync), false);
    const saved = () => fake.ops.filter((o) => /viewed/.test(o.op)).length;
    const before = saved();
    await page.check('.file-card[data-path="docs/github.md"] .viewed input');
    assert.equal(await R(() => window.__rico.state.viewed.has('docs/github.md')), true);
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(saved(), before, 'nothing is sent to GitHub when it has no viewed state');
    await open('/github.com/acme/docs/7?file=docs/plan.md');
    await page.waitForFunction(() => window.__rico.state.pr && window.__rico.state.viewed.size > 0);
    assert.equal(await R(() => window.__rico.state.viewed.has('docs/github.md')), true); // kept per PR in this browser
  });

  assert.deepEqual(errors, [], 'page errors: ' + errors.join(' | '));
  console.log('ok   no page errors');
} catch (e) {
  failed = true;
  console.log('FAIL ' + e.message);
}
await browser.close();
srv.kill();
await fake.close();
process.exit(failed ? 1 : 0);
