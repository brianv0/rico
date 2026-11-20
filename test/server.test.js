import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFake, SHA, FILE } from './fake-github.js';

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
    let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b }));
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
  assert.deepEqual(j.files.map((f) => f.filename), ['docs/plan.md']);
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
