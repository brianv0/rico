import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFake, SHA, FILE, PNG, AVATAR } from './fake-github.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let fake;
const procs = [];

async function startRico(env) {
  const port = 5000 + Math.floor(Math.random() * 3000);
  const p = spawn(process.execPath, ['server.js'], { cwd: root, env: { PATH: '/nonexistent', PORT: String(port), ...env } });
  procs.push(p);
  await new Promise((r, j) => { p.stdout.on('data', (d) => String(d).includes('running') && r()); p.on('exit', () => j(new Error('rico exited'))); });
  return port;
}
const get = (port, p, headers = {}) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: p, headers }, (res) => {
    const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => { const raw = Buffer.concat(chunks); resolve({ status: res.statusCode, body: raw.toString('utf8'), raw, type: res.headers['content-type'] }); });
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
  assert.deepEqual(j.files.map((f) => f.filename), ['docs/plan.md', 'docs/complex.md', 'docs/diagrams.md', 'docs/github.md']);
  // every changed file is sent for the file tree, markdown or not (the removed one included? no: GitHub lists it, so do we)
  assert.deepEqual(j.allFiles.map((f) => f.filename), ['docs/plan.md', 'docs/complex.md', 'docs/diagrams.md', 'docs/github.md', 'src/x.js', 'docs/old.md']);
  assert.deepEqual({ d: j.draft, m: j.merged, c: j.commits, n: j.changedFiles, a: j.authorAvatar, s: j.state }, { d: false, m: false, c: 2, n: 6, a: AVATAR, s: 'open' });
  assert.match(j.files[0].patch, /^@@ -1,7 \+1,10 @@/);
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

test('without any token, API calls fail with a helpful 401', async () => {
  const p2 = await startRico({ GITHUB_API_URL: `http://127.0.0.1:${fake.port}` });
  const r = await get(p2, '/api/pr?ref=acme/docs%237');
  assert.equal(r.status, 401);
  assert.match(JSON.parse(r.body).error, /GITHUB_TOKEN/);
});

test('GET /api/pr includes markdown review comments in compact form', async () => {
  const j = JSON.parse((await get(port, '/api/pr?ref=acme/docs%237')).body);
  assert.deepEqual(j.comments.map((c) => c.id), [101, 102, 103, 104, 105]); // src/x.js dropped
  assert.deepEqual(j.comments[0], {
    id: 101, replyTo: null, path: 'docs/plan.md', line: 6, originalLine: 6, startLine: 3, originalStartLine: 3,
    side: 'RIGHT', user: 'alice', body: 'Is this **too long**?', createdAt: '2026-11-18T10:00:00Z', url: 'https://github.com/acme/docs/pull/7#discussion_r101', avatar: AVATAR, assoc: 'MEMBER',
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
