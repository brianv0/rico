import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFake, SHA, SHA8, FILE, PNG, AVATAR, MERGE_BASE } from './fake-github.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let fake;
const procs = [];

async function startRico(env) {
  const p = spawn(process.execPath, ['server.js'], { cwd: root, env: { PATH: '/nonexistent', PORT: '0', ...env } });
  procs.push(p);
  // port 0: the OS picks a free port (random ports collided now and then), and Rico prints the one it got
  const port = await new Promise((r, j) => {
    let out = '';
    p.stdout.on('data', (d) => { out += d; const m = /running at http:\/\/localhost:(\d+)/.exec(out); if (m) r(Number(m[1])); });
    p.on('exit', (code) => j(new Error(`rico exited (${code})`)));
  });
  return port;
}
const get = (port, p, headers = {}) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: p, headers }, (res) => {
    const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => { const raw = Buffer.concat(chunks); resolve({ status: res.statusCode, headers: res.headers, body: raw.toString('utf8'), raw, type: res.headers['content-type'] }); });
  }).on('error', reject);
});
const post = (port, p, body, headers = { 'X-Rico': '1' }) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } }, (res) => {
    let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b }));
  });
  req.on('error', reject); req.end(JSON.stringify(body));
});

let port;
before(async () => {
  fake = await startFake();
  port = await startRico({ GITHUB_TOKEN: 't', GITHUB_API_URL: `http://127.0.0.1:${fake.port}` });
});
after(async () => { procs.forEach((p) => p.kill()); await fake.close(); });

test('GET /api/pr lists only non-removed markdown files, with patches', async () => {
  const r = await get(port, '/api/pr?ref=' + encodeURIComponent('https://github.com/acme/docs/pull/7'));
  assert.equal(r.status, 200);
  const j = JSON.parse(r.body);
  assert.equal(j.headSha, SHA);
  assert.equal(j.title, 'Plan v2');
  assert.deepEqual(j.files.map((f) => f.filename), ['docs/plan.md', 'docs/complex.md', 'docs/diagrams.md', 'docs/github.md', 'docs/removed.md']);
  // every changed file is sent for the file tree, markdown or not (the removed one included? no: GitHub lists it, so do we)
  assert.deepEqual(j.allFiles.map((f) => f.filename), ['docs/plan.md', 'docs/complex.md', 'docs/diagrams.md', 'docs/github.md', 'docs/removed.md', 'src/x.js', 'docs/old.md']);
  assert.deepEqual({ d: j.draft, m: j.merged, c: j.commits, n: j.changedFiles, a: j.authorAvatar, s: j.state }, { d: false, m: false, c: 2, n: 7, a: AVATAR, s: 'open' });
  assert.match(j.files[0].patch, /^@@ -1,8 \+1,10 @@/);
});

test('GET /api/pr rejects unparseable refs and surfaces GitHub 404s', async () => {
  assert.equal((await get(port, '/api/pr?ref=nonsense')).status, 400);
  const r = await get(port, '/api/pr?ref=acme/docs%2399');
  assert.equal(r.status, 404);
  assert.match(JSON.parse(r.body).error, /Not Found/);
});

test('GET /api/file returns raw markdown and validates input', async () => {
  const q = (o) => '/api/file?' + new URLSearchParams({ owner: 'acme', repo: 'docs', path: 'docs/plan.md', ref: SHA, ...o });
  const ok = await get(port, q({}));
  assert.equal(ok.status, 200);
  assert.equal(ok.body, FILE);
  assert.equal((await get(port, q({ path: '../secret.md' }))).status, 400);
  assert.equal((await get(port, q({ ref: 'main; rm -rf' }))).status, 400);
  assert.equal((await get(port, q({ owner: '../x' }))).status, 400);
});

test('POST /api/review forwards the review and returns its url', async () => {
  const review = { commit_id: SHA, event: 'COMMENT', body: 'hi', comments: [{ path: 'docs/plan.md', line: 6, start_line: 3, side: 'RIGHT', start_side: 'RIGHT', body: 'x' }] };
  const r = await post(port, '/api/review', { owner: 'acme', repo: 'docs', number: 7, review });
  assert.equal(r.status, 200);
  assert.match(JSON.parse(r.body).url, /pullrequestreview-1/);
  assert.deepEqual(fake.posted.at(-1), review);
});

test('POST /api/review validates input and relays GitHub 422s', async () => {
  const base = { owner: 'acme', repo: 'docs', number: 7 };
  assert.equal((await post(port, '/api/review', { ...base, review: { event: 'DELETE' } })).status, 400);
  assert.equal((await post(port, '/api/review', { ...base, number: '7', review: { event: 'COMMENT' } })).status, 400);
  const bad = await post(port, '/api/review', { ...base, review: { event: 'COMMENT', comments: [{ path: 'a.md', line: 99, side: 'RIGHT', body: 'x' }] } });
  assert.equal(bad.status, 422);
  assert.match(JSON.parse(bad.body).error, /part of the diff/);
});

test('POST without the X-Rico header is refused (cross-site protection)', async () => {
  const r = await post(port, '/api/review', { owner: 'acme', repo: 'docs', number: 7, review: { event: 'COMMENT' } }, {});
  assert.equal(r.status, 403);
});

test('requests with a foreign Host header are refused (DNS rebinding)', async () => {
  assert.equal((await get(port, '/api/pr?ref=acme/docs%237', { Host: 'evil.example' })).status, 403);
  assert.equal((await get(port, '/', { Host: 'evil.example' })).status, 403);
});

test('static files are served and cannot escape public/', async () => {
  const idx = await get(port, '/');
  assert.equal(idx.status, 200);
  assert.match(idx.body, /<title>Rico<\/title>/);
  assert.equal((await get(port, '/lib.js')).status, 200);
  assert.equal((await get(port, '/..%2fserver.js')).status, 404);
  assert.equal((await get(port, '/%2e%2e/package.json')).status, 404);
});

test('every response carries the backstop security headers', async () => {
  for (const p of ['/', '/style.css', '/api/pr?ref=acme/docs%237', '/api/file?x=1', '/nope']) {
    const r = await get(port, p);
    assert.match(r.headers['content-security-policy'], /frame-ancestors 'self'/, p);
    assert.equal(r.headers['x-frame-options'], 'DENY', p);
    assert.equal(r.headers['x-content-type-options'], 'nosniff', p);
  }
  const raw = await get(port, '/api/raw?' + new URLSearchParams({ owner: 'acme', repo: 'docs', path: 'docs/img/x.png', ref: SHA }));
  assert.equal(raw.headers['x-frame-options'], 'DENY');
  assert.equal(raw.headers['x-content-type-options'], 'nosniff');
  assert.match(raw.headers['content-security-policy'], /^default-src 'none'/); // stricter than the page CSP: a navigated-to SVG stays inert
});

test('dot segments are rejected as owner/repo (fetch would collapse them out of the API path)', async () => {
  const file = '/api/file?' + new URLSearchParams({ owner: '..', repo: 'docs', path: 'docs/plan.md', ref: SHA });
  assert.equal((await get(port, file)).status, 400);
  const raw = '/api/raw?' + new URLSearchParams({ owner: 'acme', repo: '..', path: 'docs/img/x.png', ref: SHA });
  assert.equal((await get(port, raw)).status, 400);
  assert.equal((await get(port, '/api/pr?ref=' + encodeURIComponent('../docs#7'))).status, 400);
  assert.equal((await get(port, '/api/pr?ref=' + encodeURIComponent('https://github.com/../docs/pull/7'))).status, 400);
  assert.equal((await get(port, '/api/pr?ref=' + encodeURIComponent('https://github.com/docs/../pull/7'))).status, 400);
});

test('without any token, API calls fail with a helpful 401', async () => {
  const p2 = await startRico({ GITHUB_API_URL: `http://127.0.0.1:${fake.port}` });
  const r = await get(p2, '/api/pr?ref=acme/docs%237');
  assert.equal(r.status, 401);
  assert.match(JSON.parse(r.body).error, /GITHUB_TOKEN/);
});

test('GET /api/pr includes markdown review comments in compact form', async () => {
  const j = JSON.parse((await get(port, '/api/pr?ref=acme/docs%237')).body);
  assert.deepEqual(j.comments.map((c) => c.id), [101, 102, 103, 104, 105, 301, 302]); // src/x.js dropped
  const { canUpdate, canDelete, pending, edited, reactions, nodeId, thread, updatedAt, ...base } = j.comments[0];
  assert.equal(edited, false);
  assert.deepEqual({ canUpdate, canDelete, pending, reactions, nodeId, thread: thread.id }, { canUpdate: false, canDelete: false, pending: false, reactions: [], nodeId: 'PRRC_101', thread: 'PRRT_101' });
  assert.deepEqual(base, {
    id: 101, replyTo: null, path: 'docs/plan.md', line: 6, originalLine: 6, startLine: 3, originalStartLine: 3,
    side: 'RIGHT', user: 'alice', bot: false, commit: null, originalCommit: null, body: 'Is this **too long**?', createdAt: '2026-11-18T10:00:00Z', url: 'https://github.com/acme/docs/pull/7#discussion_r101', avatar: AVATAR, assoc: 'MEMBER',
  });
  assert.equal(j.comments[1].replyTo, 101);
  assert.equal(j.comments[2].line, null);
});

test('POST /api/reply replies to a thread and validates input', async () => {
  const ok = await post(port, '/api/reply', { owner: 'acme', repo: 'docs', number: 7, commentId: 101, text: 'Thanks!' });
  assert.equal(ok.status, 200);
  assert.equal(JSON.parse(ok.body).replyTo, 101);
  assert.deepEqual(fake.replies.at(-1), { to: 101, body: 'Thanks!' });
  assert.equal((await post(port, '/api/reply', { owner: 'acme', repo: 'docs', number: 7, commentId: 101, text: '  ' })).status, 400);
  assert.equal((await post(port, '/api/reply', { owner: 'acme', repo: 'docs', number: 7, commentId: '101', text: 'x' })).status, 400);
  assert.equal((await post(port, '/api/reply', { owner: 'acme', repo: 'docs', number: 7, commentId: 101, text: 'x' }, {})).status, 403);
});

test('GET /api/raw serves repo images byte-for-byte, and only images', async () => {
  const q = (o) => '/api/raw?' + new URLSearchParams({ owner: 'acme', repo: 'docs', path: 'docs/img/x.png', ref: SHA, ...o });
  const ok = await get(port, q({}));
  assert.equal(ok.status, 200);
  assert.equal(ok.type, 'image/png');
  assert.deepEqual(ok.raw, PNG);
  assert.equal((await get(port, q({ path: 'docs/plan.md' }))).status, 400); // not an image: refuse to be a file proxy
  assert.equal((await get(port, q({ path: '../x.png' }))).status, 400);
  assert.equal((await get(port, q({ path: 'docs/img/missing.png' }))).status, 404);
});

test('GET /vendor/d2.js serves the optional D2 bundle when it is installed', { skip: !fs.existsSync(path.join(root, 'node_modules/@terrastruct/d2/dist/browser/index.js')) && 'optional dependency not installed' }, async () => {
  const r = await get(port, '/vendor/d2.js');
  assert.equal(r.status, 200);
  assert.match(r.type, /javascript/);
  assert.ok(r.raw.length > 1_000_000, 'bundle should be several MB');
  assert.match(r.body.slice(0, 200000), /export|D2/);
});

test('other /vendor paths are not served', async () => {
  assert.equal((await get(port, '/vendor/../server.js')).status, 404);
  assert.equal((await get(port, '/vendor/secret.js')).status, 404);
});

test('GET /vendor/mermaid.js serves the optional Mermaid bundle when it is installed', { skip: !fs.existsSync(path.join(root, 'node_modules/mermaid/dist/mermaid.min.js')) && 'optional dependency not installed' }, async () => {
  const r = await get(port, '/vendor/mermaid.js');
  assert.equal(r.status, 200);
  assert.match(r.type, /javascript/);
  assert.ok(r.raw.length > 1_000_000, 'bundle should be several MB');
});

test('GET /api/pr reports the merge base (what GitHub diffs against), not the base branch tip', async () => {
  const j = JSON.parse((await get(port, '/api/pr?ref=acme/docs%237')).body);
  assert.equal(j.baseSha, MERGE_BASE);
  assert.ok(j.files.every((f) => 'previous' in f));
});

test('the base version of a file can be fetched at the merge base', async () => {
  const q = (o) => '/api/file?' + new URLSearchParams({ owner: 'acme', repo: 'docs', path: 'docs/removed.md', ref: MERGE_BASE, ...o });
  const ok = await get(port, q({}));
  assert.equal(ok.status, 200);
  assert.match(ok.body, /This paragraph was removed entirely\./);
});

test('GET /api/suggest: the viewer pool, repo scope with an exact number, and text sanitising', async () => {
  const searches = () => fake.ops.filter((o) => o.op === 'search').at(-1).queries;
  let r = await get(port, '/api/suggest');
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.body).items[0], { owner: 'acme', repo: 'docs', number: 7, title: 'Update the docs', state: 'OPEN', draft: false, author: 'alice', updatedAt: '2026-11-20T00:00:00Z' });
  assert.deepEqual(searches().map((q) => q.split(' ')[1]), ['involves:@me', 'review-requested:@me']);
  r = await get(port, '/api/suggest?repo=acme/docs&number=99');
  assert.equal(JSON.parse(r.body).items[0].number, 99); // the exact PR comes first, whatever its age
  assert.match(searches()[0], /repo:acme\/docs/);
  await get(port, '/api/suggest?text=' + encodeURIComponent('fix user:evil "x"'));
  assert.ok(!searches()[0].includes(':evil') && !searches()[0].includes('"'), searches()[0]); // no qualifier smuggling
  assert.equal((await get(port, '/api/suggest?repo=../x')).status, 400);
});

test('GET /api/suggest?needs=review: open non-draft PRs awaiting the viewer, direct review requests first, then team ones; recent only; each PR once', async () => {
  const r = await get(port, '/api/suggest?needs=review');
  assert.equal(r.status, 200);
  const q = fake.ops.filter((o) => o.op === 'search').at(-1).queries;
  assert.equal(q.length, 2);
  assert.match(q[0], /^is:pr is:open archived:false draft:false user-review-requested:@me updated:>=\d{4}-\d\d-\d\d /, 'asked of the viewer directly, and recent');
  assert.match(q[1], /review-requested:@me -user-review-requested:@me updated:>=\d{4}-\d\d-\d\d /, 'then team requests');
  assert.ok(!q.some((x) => x.includes('involves')), 'not everything the viewer ever touched');
  assert.deepEqual(JSON.parse(r.body).items.map((i) => i.number), [7], 'both searches return PR 7: listed once');
});

test('GET /api/suggest?name=…: the exact PR from whichever candidate owner has that repo; missing repos are not errors', async () => {
  const r = await get(port, '/api/suggest?name=formwork&number=47&owners=' + encodeURIComponent('nobody,acme'));
  assert.equal(r.status, 200, r.body);
  assert.deepEqual(JSON.parse(r.body).items.map((p) => `${p.owner}/${p.repo}#${p.number} ${p.state}`), ['acme/formwork#47 MERGED']);
  assert.deepEqual(fake.ops.filter((o) => o.op === 'name-lookup').at(-1).vars, { name: 'formwork', n: 47, o0: 'nobody', o1: 'acme' });
  assert.equal((await get(port, '/api/suggest?name=formwork&number=x')).status, 400);
  assert.equal((await get(port, '/api/suggest?name=formwork&number=4&owners=../a')).status, 400);
});

// ---- a single commit: GitHub's commit comments ----
const commitRef = (o = {}) => ({ owner: 'acme', repo: 'docs', sha: SHA, ...o });

test('GET /api/pr loads a commit: its markdown files, diffed against its parent, with commit comments as threads', async () => {
  const r = await get(port, '/api/pr?ref=' + encodeURIComponent('https://github.com/acme/docs/commit/abc1234'));
  assert.equal(r.status, 200);
  const j = JSON.parse(r.body);
  assert.equal(j.kind, 'commit');
  assert.deepEqual({ sha: j.sha, head: j.headSha, base: j.baseSha, title: j.title, author: j.author, n: j.changedFiles }, { sha: SHA, head: SHA, base: MERGE_BASE, title: 'Tighten the plan', author: 'bob', n: 3 });
  assert.match(j.message, /^And drop the old subtitle\.\n\nCo-authored-by/);
  assert.deepEqual(j.files.map((f) => f.filename), ['docs/plan.md', 'docs/removed.md']);
  assert.equal(j.isPrivate, false);
  const by = Object.fromEntries(j.comments.map((c) => [c.id, c]));
  assert.deepEqual(Object.keys(by).map(Number), [701, 702, 703]); // src/x.js is not markdown; the general one is separate
  assert.deepEqual({ line: by[701].line, side: by[701].side, replyTo: by[701].replyTo }, { line: 6, side: 'RIGHT', replyTo: null }); // position 7 -> new line 6
  assert.equal(by[702].replyTo, 701); // same line: one thread, earliest first
  assert.deepEqual({ line: by[703].line, side: by[703].side }, { line: 2, side: 'LEFT' }); // position 2 -> the removed line
  assert.deepEqual({ me: by[702].canUpdate, alice: by[701].canUpdate }, { me: true, alice: false });
  assert.deepEqual(j.prComments.map((c) => c.body), ['Nice commit overall.']);
  assert.equal(j.pendingReview, null);
  assert.equal(j.canThread, false);
  assert.equal((await get(port, '/api/pr?ref=acme/docs@ffff999')).status, 422);
});

test('commit comments: post by position, reply on the same line, general comment, edit, react, delete', async () => {
  let r = await post(port, '/api/comment', { ...commitRef(), comment: { path: 'docs/plan.md', position: 4, body: 'Hmm.', line: 3, side: 'RIGHT' } });
  assert.equal(r.status, 200);
  const c = JSON.parse(r.body);
  assert.deepEqual({ line: c.line, side: c.side, body: c.body }, { line: 3, side: 'RIGHT', body: 'Hmm.' });
  assert.deepEqual(fake.ops.at(-1), { op: 'commit-comment', id: c.id, path: 'docs/plan.md', position: 4, body: 'Hmm.' }); // only what GitHub takes
  assert.equal((await post(port, '/api/comment', { ...commitRef(), comment: { path: 'docs/plan.md', line: 3, body: 'x' } })).status, 400); // no position
  assert.equal((await post(port, '/api/comment', { ...commitRef({ sha: 'main; rm' }), comment: { path: 'docs/plan.md', position: 4, body: 'x' } })).status, 400);

  r = await post(port, '/api/reply', { ...commitRef(), commentId: 701, text: 'Done.' });
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(r.body).replyTo, 701);
  assert.deepEqual(fake.ops.at(-1), { op: 'commit-comment', id: JSON.parse(r.body).id, path: 'docs/plan.md', position: 7, body: 'Done.' });
  assert.equal((await post(port, '/api/reply', { ...commitRef(), commentId: 704, text: 'x' })).status, 400); // not on a line

  r = await post(port, '/api/pr-comment', { ...commitRef(), text: 'On the whole commit.' });
  assert.equal(r.status, 200);
  assert.deepEqual(fake.ops.at(-1), { op: 'commit-comment', id: JSON.parse(r.body).id, body: 'On the whole commit.' });

  r = await post(port, '/api/comment/edit', { ...commitRef(), kind: 'review', commentId: c.id, text: 'Hmm!' });
  assert.equal(JSON.parse(r.body).body, 'Hmm!');
  assert.deepEqual(fake.ops.at(-1), { op: 'edit-commit-comment', id: c.id, body: 'Hmm!' });
  r = await post(port, '/api/reaction', { ...commitRef(), kind: 'review', commentId: 701, content: 'heart' });
  assert.equal(r.status, 200);
  assert.deepEqual(fake.ops.at(-1), { op: 'react', kind: 'commit', id: 701, content: 'heart' });
  r = await post(port, '/api/comment/delete', { ...commitRef(), kind: 'review', commentId: c.id });
  assert.equal(r.status, 200);
  assert.deepEqual(fake.ops.at(-1), { op: 'delete-commit-comment', id: c.id });
});

test('a commit has no reviews or resolvable threads', async () => {
  for (const p of ['/api/pending/add', '/api/pending/finish', '/api/pending/discard', '/api/review']) {
    const r = await post(port, p, { ...commitRef(), event: 'COMMENT', comment: { path: 'docs/plan.md', line: 6, commit_id: SHA, body: 'x' } });
    assert.equal(r.status, 400, p);
    assert.match(JSON.parse(r.body).error, /only pull requests/);
  }
});

test('GET /api/comments?sha=…: a conditional refresh of the commit comments', async () => {
  const q = (etags) => '/api/comments?' + new URLSearchParams({ owner: 'acme', repo: 'docs', sha: SHA, etags: JSON.stringify(etags) });
  const first = JSON.parse((await get(port, q({}))).body);
  assert.equal(first.unchanged, false);
  assert.ok(first.comments.some((c) => c.id === 701));
  assert.equal(first.headSha, undefined); // a commit never moves
  const again = JSON.parse((await get(port, q(first.etags))).body);
  assert.equal(again.unchanged, true);
  assert.match(fake.hits.at(-1), /commits\/.*\/comments -> 304/);
  assert.equal((await get(port, '/api/comments?' + new URLSearchParams({ owner: 'acme', repo: 'docs', sha: 'nope' }))).status, 400);
});

test('GET /api/pr opens a branch as its tip commit, and says which branch', async () => {
  const r = await get(port, '/api/pr?ref=' + encodeURIComponent('https://github.com/acme/docs/tree/feature/plan-v2'));
  assert.equal(r.status, 200);
  const j = JSON.parse(r.body);
  assert.deepEqual({ kind: j.kind, sha: j.sha, branch: j.branch }, { kind: 'commit', sha: SHA, branch: 'feature/plan-v2' });
  assert.deepEqual(fake.ops.filter((o) => o.op === 'branch').at(-1), { op: 'branch', name: 'feature/plan-v2' });
  assert.equal((await get(port, '/api/pr?ref=' + encodeURIComponent('acme/docs@nope'))).status, 404);
  assert.equal((await get(port, '/api/pr?ref=' + encodeURIComponent('acme/docs@a/../b'))).status, 400);
});

test('a branch page path (even one that looks like a file) is the app', async () => {
  const r = await get(port, '/github.com/acme/docs/tree/release/v1.2');
  assert.equal(r.status, 200);
  assert.match(r.type, /html/);
});

test('GET /api/pr on a commit: who authored and committed it, and its signature', async () => {
  const j = JSON.parse((await get(port, '/api/pr?ref=acme/docs@abc1234')).body);
  assert.deepEqual({ a: j.author, c: j.committer, cn: j.committerName, v: j.verified, r: j.verification }, { a: 'bob', c: 'web-flow', cn: 'GitHub', v: true, r: 'valid' });
  assert.match(j.message, /Co-authored-by: Carol/);
});

test('GET /api/comments?sha=…&branch=…: follows the branch tip (conditionally) and reports a deleted branch', async () => {
  const q = (o) => '/api/comments?' + new URLSearchParams({ owner: 'acme', repo: 'docs', sha: SHA, branch: 'plan', ...o });
  const first = JSON.parse((await get(port, q({ etags: '{}' }))).body);
  assert.equal(first.headSha, SHA);
  const again = JSON.parse((await get(port, q({ etags: JSON.stringify(first.etags) }))).body);
  assert.equal(again.unchanged, true);
  assert.equal(again.headSha, undefined); // the branch answered 304 too: nothing new
  fake.state.branchTip = 'f'.repeat(40); fake.state.version++;
  const moved = JSON.parse((await get(port, q({ etags: JSON.stringify(first.etags) }))).body);
  assert.equal(moved.headSha, 'f'.repeat(40));
  fake.state.gone = 'plan';
  assert.equal(JSON.parse((await get(port, q({ etags: '{}' }))).body).branchGone, true);
  fake.state.gone = null; fake.state.branchTip = null; fake.state.version++;
  assert.equal((await get(port, q({ branch: 'a/../b' }))).status, 400);
});

test('GET /api/dir lists a directory at a commit, and validates its input', async () => {
  const q = (o) => '/api/dir?' + new URLSearchParams({ owner: 'acme', repo: 'docs', path: 'specs/001-login', ref: SHA8, ...o });
  const ok = await get(port, q({}));
  assert.equal(ok.status, 200);
  const names = JSON.parse(ok.body).map((e) => `${e.name}:${e.type}`);
  assert.deepEqual(names, ['spec.md:file', 'plan.md:file', 'tasks.md:file', 'contracts:dir']);
  assert.equal((await get(port, q({ path: '../x' }))).status, 400);
  assert.equal((await get(port, q({ path: '' }))).status, 400);
  assert.equal((await get(port, q({ ref: 'main' }))).status, 400);
  assert.equal((await get(port, q({ path: 'specs/none' }))).status, 404);
});

test('GET /api/pr: the commit each comment was made on, and whether a bot wrote it', async () => {
  fake.state.comments.find((c) => c.id === 101).original_commit_id = SHA;
  fake.state.comments.find((c) => c.id === 101).commit_id = SHA;
  fake.state.comments.find((c) => c.id === 102).user = { login: 'review-bot[bot]', type: 'Bot', avatar_url: AVATAR };
  fake.state.version++;
  const j = JSON.parse((await get(port, '/api/pr?ref=acme/docs%237')).body);
  const c101 = j.comments.find((c) => c.id === 101);
  const c102 = j.comments.find((c) => c.id === 102);
  assert.deepEqual({ o: c101.originalCommit, c: c101.commit, b: c101.bot }, { o: SHA, c: SHA, b: false });
  assert.equal(c102.bot, true);
  assert.equal(j.comments.find((c) => c.id === 103).originalCommit, null);
});

test('GET /api/pr: the viewer baseline is the commit of their latest submitted review or comment', async () => {
  fake.state.reviews = [];
  fake.state.comments = fake.state.comments.filter((c) => c.user.login !== 'me');
  fake.state.version++;
  assert.equal(JSON.parse((await get(port, '/api/pr?ref=acme/docs%237')).body).viewerBaseline, null);
  fake.state.reviews = [
    { id: 1, user: { login: 'me' }, commit_id: 'aaaa1111', submitted_at: '2026-11-10T10:00:00Z', state: 'COMMENTED' },
    { id: 2, user: { login: 'someone-else' }, commit_id: 'ffff9999', submitted_at: '2026-11-12T10:00:00Z', state: 'APPROVED' },
    { id: 3, user: { login: 'me' }, commit_id: 'bbbb2222', submitted_at: '2026-11-11T10:00:00Z', state: 'CHANGES_REQUESTED' },
    { id: 4, user: { login: 'me' }, commit_id: 'cccc3333', submitted_at: null, state: 'PENDING' },
  ];
  const b = JSON.parse((await get(port, '/api/pr?ref=acme/docs%237')).body).viewerBaseline;
  assert.deepEqual({ sha: b.sha, kind: b.kind }, { sha: 'bbbb2222', kind: 'review' });
  fake.state.reviews = [];
});

test('GET /api/pr: viewed files come from GitHub, and are null (not an error) when GitHub has no such field', async () => {
  fake.state.viewedFiles = null;
  const none = JSON.parse((await get(port, '/api/pr?ref=acme/docs%237')).body);
  assert.equal(none.viewedFiles, null);
  assert.equal(none.files.length, 5); // everything else still loads
  fake.state.viewedFiles = { 'docs/plan.md': 'VIEWED', 'docs/complex.md': 'DISMISSED', 'docs/github.md': 'UNVIEWED' };
  const some = JSON.parse((await get(port, '/api/pr?ref=acme/docs%237')).body);
  assert.deepEqual(some.viewedFiles, { 'docs/plan.md': 'VIEWED', 'docs/complex.md': 'DISMISSED', 'docs/github.md': 'UNVIEWED' });
});

test('POST /api/viewed marks and unmarks a file on GitHub, and validates input', async () => {
  fake.state.viewedFiles = {};
  const base = { owner: 'acme', repo: 'docs', number: 7, path: 'docs/plan.md' };
  assert.equal((await post(port, '/api/viewed', { ...base, viewed: true })).status, 200);
  assert.deepEqual(fake.state.viewedFiles, { 'docs/plan.md': 'VIEWED' });
  assert.equal((await post(port, '/api/viewed', { ...base, viewed: false })).status, 200);
  assert.deepEqual(fake.state.viewedFiles, { 'docs/plan.md': 'UNVIEWED' });
  assert.deepEqual(fake.ops.filter((o) => /viewed/.test(o.op)).map((o) => [o.op, o.path]), [['viewed', 'docs/plan.md'], ['unviewed', 'docs/plan.md']]);
  assert.equal((await post(port, '/api/viewed', { ...base, path: '../x', viewed: true })).status, 400);
  assert.equal((await post(port, '/api/viewed', { ...base, number: 'x', viewed: true })).status, 400);
  assert.equal((await post(port, '/api/viewed', { ...base, viewed: true, sha: SHA })).status, 400); // commits have no viewed marks
  fake.state.viewedFiles = null;
});

test('a Spec Kit PR loads with its markdown files, and its unchanged neighbours can be read at the head commit', async () => {
  const j = JSON.parse((await get(port, '/api/pr?ref=acme/docs%238')).body);
  assert.deepEqual(j.files.map((f) => f.filename), ['specs/001-login/plan.md', 'specs/001-login/tasks.md']);
  assert.equal(j.allFiles.length, 4);
  assert.equal(j.headSha, SHA8);
  const spec = await get(port, '/api/file?' + new URLSearchParams({ owner: 'acme', repo: 'docs', path: 'specs/001-login/spec.md', ref: SHA8 }));
  assert.match(spec.body, /\[NEEDS CLARIFICATION: SSO/);
  assert.equal((await get(port, '/api/file?' + new URLSearchParams({ owner: 'acme', repo: 'docs', path: '.specify/memory/missing.md', ref: SHA8 }))).status, 404);
});
