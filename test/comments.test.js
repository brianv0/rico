// Single comments, threads, pending reviews, reactions and live refresh, end to end through the local server against the fake GitHub.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFake, SHA } from './fake-github.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const cleanups = [];
after(async () => { for (const f of cleanups) await f(); });

/** A fresh fake GitHub and a Rico server in front of it; every test gets its own state. */
async function setup() {
  const fake = await startFake();
  const port = 5000 + Math.floor(Math.random() * 3000);
  const p = spawn(process.execPath, ['server.js'], { cwd: root, env: { PATH: '/nonexistent', PORT: String(port), GITHUB_TOKEN: 't', GITHUB_API_URL: `http://127.0.0.1:${fake.port}` } });
  await new Promise((r, j) => { p.stdout.on('data', (d) => String(d).includes('running') && r()); p.on('exit', () => j(new Error('rico exited'))); });
  cleanups.push(async () => { p.kill(); await fake.close(); });
  const call = async (method, url, body, headers = { 'X-Rico': '1' }) => {
    const r = await fetch(`http://127.0.0.1:${port}${url}`, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { /* plain */ }
    return { status: r.status, json, headers: r.headers };
  };
  const R = { owner: 'acme', repo: 'docs', number: 7 };
  return { fake, call, R, post: (u, b, h) => call('POST', u, b, h), get: (u) => call('GET', u) };
}
const line = (o = {}) => ({ commit_id: SHA, path: 'docs/plan.md', line: 6, side: 'RIGHT', body: 'Hello', ...o });

test('/api/me locally returns the token owner so "your own" works', async () => {
  const { get } = await setup();
  assert.deepEqual((await get('/api/me')).json, { hosted: false, login: 'me', avatar: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==' });
});

test('/api/pr carries PR-level comments, the viewer, thread state and per-comment permissions', async () => {
  const { get, fake } = await setup();
  const j = (await get('/api/pr?ref=acme/docs%237')).json;
  assert.equal(j.viewer, 'me');
  assert.equal(j.canThread, true);
  assert.deepEqual(j.prComments.map((c) => [c.id, c.user, c.canUpdate]), [[501, 'dave', false]]);
  const c = j.comments.find((x) => x.id === 101);
  assert.deepEqual(c.thread, { id: 'PRRT_101', resolved: false, canResolve: true, canUnresolve: true, canReply: true });
  assert.equal(c.canUpdate, false);
  assert.equal(j.comments.find((x) => x.id === 102).thread, undefined, 'only the root carries the thread');
  assert.equal(j.pendingReview, null);
  fake.state.resolved.add(101);
  assert.equal((await get('/api/pr?ref=acme/docs%237')).json.comments[0].thread.resolved, true);
});

test('without GraphQL the PR still loads; "yours" falls back to the login and there is no thread state', async () => {
  const { get, fake } = await setup();
  fake.state.graphql = false;
  const j = (await get('/api/pr?ref=acme/docs%237')).json;
  assert.equal(j.canThread, false);
  assert.equal(j.viewer, 'me');
  assert.equal(j.comments.find((c) => c.id === 101).thread, undefined);
  assert.equal(j.comments.find((c) => c.id === 101).canUpdate, false);
});

test('POST /api/comment posts one line comment with the commit, side and range', async () => {
  const { post, fake, R } = await setup();
  const r = await post('/api/comment', { ...R, comment: line({ start_line: 3, body: 'Single' }) });
  assert.equal(r.status, 200);
  assert.equal(r.json.body, 'Single');
  assert.equal(r.json.user, 'me');
  assert.deepEqual(fake.ops.at(-1), { op: 'comment', id: r.json.id, commit_id: SHA, path: 'docs/plan.md', line: 6, side: 'RIGHT', start_line: 3, start_side: 'RIGHT', body: 'Single' });
  const left = await post('/api/comment', { ...R, comment: line({ side: 'LEFT', line: 2 }) });
  assert.equal(left.json.side, 'LEFT');
  assert.equal(fake.ops.at(-1).start_side, undefined);
});

test('POST /api/comment validates, and passes GitHub\'s own reason through (422 off-diff, 403 locked, rate limit)', async () => {
  const { post, fake, R } = await setup();
  for (const bad of [line({ body: '  ' }), line({ line: 0 }), line({ path: '../x' }), line({ commit_id: 'zz' }), line({ start_line: 6 }), null]) assert.equal((await post('/api/comment', { ...R, comment: bad })).status, 400, JSON.stringify(bad));
  assert.equal((await post('/api/comment', { ...R, number: 'x', comment: line() })).status, 400);
  assert.equal((await post('/api/comment', { ...R, comment: line() }, {})).status, 403, 'needs X-Rico');
  const off = await post('/api/comment', { ...R, comment: line({ line: 40 }) });
  assert.equal(off.status, 422);
  assert.match(off.json.error, /must be part of the diff/);
  fake.state.locked = true;
  const locked = await post('/api/comment', { ...R, comment: line() });
  assert.equal(locked.status, 403);
  assert.match(locked.json.error, /locked/);
  fake.state.locked = false;
  fake.state.rateLimited = true;
  const rl = await post('/api/comment', { ...R, comment: line() });
  assert.equal(rl.status, 403);
  assert.match(rl.json.error, /rate limit/);
});

test('POST /api/pr-comment posts a normal PR comment, and edit/delete work on it', async () => {
  const { post, fake, R } = await setup();
  const r = await post('/api/pr-comment', { ...R, text: 'Outside the diff\n\n> quoted' });
  assert.equal(r.status, 200);
  assert.equal(r.json.user, 'me');
  assert.equal((await post('/api/pr-comment', { ...R, text: '' })).status, 400);
  const e = await post('/api/comment/edit', { ...R, kind: 'issue', commentId: r.json.id, text: 'Edited' });
  assert.equal(e.json.body, 'Edited');
  assert.equal(fake.ops.at(-1).op, 'edit-pr-comment');
  assert.equal((await post('/api/comment/delete', { ...R, kind: 'issue', commentId: r.json.id })).status, 200);
  assert.equal(fake.state.issueComments.some((c) => c.id === r.json.id), false);
  const other = await post('/api/comment/edit', { ...R, kind: 'issue', commentId: 501, text: 'nope' });
  assert.equal(other.status, 403);
});

test('edit and delete a review comment: yours only, and GitHub says why otherwise', async () => {
  const { post, fake, R } = await setup();
  const mine = (await post('/api/comment', { ...R, comment: line() })).json;
  const e = await post('/api/comment/edit', { ...R, commentId: mine.id, text: 'Better' });
  assert.equal(e.json.body, 'Better');
  assert.equal((await post('/api/comment/edit', { ...R, commentId: mine.id, text: ' ' })).status, 400);
  assert.equal((await post('/api/comment/edit', { ...R, commentId: 101, text: 'x' })).status, 403);
  assert.equal((await post('/api/comment/delete', { ...R, commentId: 101 })).status, 403);
  assert.equal((await post('/api/comment/delete', { ...R, commentId: 99999 })).status, 404);
  assert.equal((await post('/api/comment/delete', { ...R, commentId: mine.id })).status, 200);
  assert.equal(fake.state.comments.some((c) => c.id === mine.id), false);
});

test('resolve and reopen a thread through GraphQL', async () => {
  const { post, fake, R } = await setup();
  const r = await post('/api/thread/resolve', { ...R, threadId: 'PRRT_101', resolved: true });
  assert.deepEqual(r.json, { id: 'PRRT_101', resolved: true, canResolve: true, canUnresolve: true });
  assert.equal(fake.state.resolved.has(101), true);
  assert.equal((await post('/api/thread/resolve', { ...R, threadId: 'PRRT_101', resolved: false })).json.resolved, false);
  assert.deepEqual(fake.ops.map((o) => o.op).slice(-2), ['resolve', 'unresolve']);
  assert.equal((await post('/api/thread/resolve', { ...R, threadId: 'bad id!', resolved: true })).status, 400);
  assert.equal((await post('/api/thread/resolve', { ...R, threadId: 'PRRT_99999', resolved: true })).status, 422);
  fake.state.graphql = false;
  assert.equal((await post('/api/thread/resolve', { ...R, threadId: 'PRRT_101', resolved: true })).status, 403);
});

test('reactions: add over REST, remove over GraphQL, and they show up with "mine"', async () => {
  const { post, get, fake, R } = await setup();
  assert.equal((await post('/api/reaction', { ...R, commentId: 101, content: 'heart' })).status, 200);
  assert.equal((await post('/api/reaction', { ...R, kind: 'issue', commentId: 501, content: '+1' })).status, 200);
  assert.equal((await post('/api/reaction', { ...R, commentId: 101, content: 'nope' })).status, 400);
  const c = (await get('/api/pr?ref=acme/docs%237')).json.comments.find((x) => x.id === 101);
  assert.deepEqual(c.reactions, [{ content: 'heart', count: 1, mine: true }]);
  assert.equal((await post('/api/reaction', { ...R, commentId: 101, content: 'heart', remove: true, nodeId: c.nodeId })).status, 200);
  assert.deepEqual(fake.state.reactions.get(101), []);
  assert.equal((await post('/api/reaction', { ...R, commentId: 101, content: 'heart', remove: true })).status, 400);
});

test('pending review: first comment creates it, the next reuses it, an existing one is detected', async () => {
  const { post, get, fake, R } = await setup();
  const a = await post('/api/pending/add', { ...R, comment: line({ body: 'one' }) });
  assert.equal(a.status, 200);
  assert.equal(a.json.comment.pending, true);
  assert.equal(a.json.review.id, 'PRR_1');
  const b = await post('/api/pending/add', { ...R, comment: line({ line: 5, start_line: 3, body: 'two' }) });
  assert.equal(b.status, 200);
  assert.deepEqual(fake.ops.filter((o) => o.op === 'pending.create').length, 1, 'one pending review, reused');
  assert.equal(fake.ops.at(-1).start_line, 3);
  const j = (await get('/api/pr?ref=acme/docs%237')).json;
  assert.deepEqual(j.pendingReview, { id: 'PRR_1', databaseId: 55 });
  assert.deepEqual(j.comments.filter((c) => c.pending).map((c) => c.body), ['one', 'two']);
  const off = await post('/api/pending/add', { ...R, comment: line({ line: 40 }) });
  assert.equal(off.status, 422);
  assert.match(off.json.error, /part of the diff/);
});

test('an existing pending review (from github.com or another device) is picked up, not duplicated', async () => {
  const { post, get, fake, R } = await setup();
  fake.state.pending = { id: 'PRR_1', databaseId: 55 };
  assert.deepEqual((await get('/api/pr?ref=acme/docs%237')).json.pendingReview, { id: 'PRR_1', databaseId: 55 });
  assert.equal((await post('/api/pending/add', { ...R, comment: line() })).status, 200);
  assert.equal(fake.ops.filter((o) => o.op === 'pending.create').length, 0);
});

test('finish: submits the pending review with a verdict; without one it posts a plain review; discard deletes it', async () => {
  const { post, fake, R } = await setup();
  await post('/api/pending/add', { ...R, comment: line() });
  const f = await post('/api/pending/finish', { ...R, event: 'REQUEST_CHANGES', body: 'Please fix' });
  assert.deepEqual(f.json, { id: 77, url: 'https://github.com/acme/docs/pull/7#pullrequestreview-77', state: 'REQUEST_CHANGES' });
  assert.deepEqual(fake.ops.at(-1), { op: 'pending.submit', event: 'REQUEST_CHANGES', body: 'Please fix' });
  assert.equal(fake.state.comments.some((c) => c.pending), false);
  const plain = await post('/api/pending/finish', { ...R, event: 'APPROVE', body: '' });
  assert.equal(plain.json.state, 'COMMENTED');
  assert.equal(fake.posted.at(-1).event, 'APPROVE');
  assert.equal((await post('/api/pending/finish', { ...R, event: 'MERGE' })).status, 400);
  await post('/api/pending/add', { ...R, comment: line() });
  await post('/api/pending/discard', R);
  assert.equal(fake.state.pending, null);
  assert.equal(fake.state.comments.some((c) => c.pending), false);
});

test('a pending review blocks the old REST review and single comments: why the app goes through GraphQL', async () => {
  const { post, fake, R } = await setup();
  fake.state.pending = { id: 'PRR_1', databaseId: 55 };
  const single = await post('/api/comment', { ...R, comment: line() });
  assert.equal(single.status, 422);
  assert.match(single.json.error, /one pending review/);
  const review = await post('/api/review', { ...R, review: { event: 'COMMENT', body: 'x', comments: [] } });
  assert.equal(review.status, 422);
});

test('GET /api/comments: ETag round trip costs a 304 per resource when nothing changed', async () => {
  const { get, fake, R } = await setup();
  const q = (etags) => `/api/comments?owner=acme&repo=docs&number=7&etags=${encodeURIComponent(JSON.stringify(etags || {}))}`;
  const first = (await get(q())).json;
  assert.equal(first.unchanged, false);
  assert.equal(first.headSha, SHA);
  assert.ok(first.etags.pull && first.etags.rc && first.etags.ic);
  fake.hits.length = 0;
  const again = (await get(q(first.etags))).json;
  assert.deepEqual(again, { unchanged: true, etags: first.etags });
  assert.deepEqual(fake.hits.sort(), ['GET /repos/acme/docs/issues/7/comments -> 304', 'GET /repos/acme/docs/pulls/7 -> 304', 'GET /repos/acme/docs/pulls/7/comments -> 304']);
  // someone else comments: only what changed is re-read
  const id = fake.addComment({ user: { login: 'zed' }, line: 6, body: 'New from zed' });
  const changed = (await get(q(first.etags))).json;
  assert.equal(changed.unchanged, false);
  assert.ok(changed.comments.some((c) => c.id === id));
  assert.equal(changed.headSha, SHA);
  // a push: the head moves
  const base = (await get(q())).json;
  fake.pushCommit('ffff0000aaaa');
  const moved = (await get(q(base.etags))).json;
  assert.equal(moved.headSha, 'ffff0000aaaa');
  assert.equal((await get('/api/comments?owner=acme&repo=docs&number=x')).status, 400);
});

test('pending comments: edited through GraphQL (REST 404s on them); submitting is not an edit; a real edit is', async () => {
  const { post, get, fake, R } = await setup();
  const a = await post('/api/pending/add', { ...R, comment: line({ body: 'first draft' }) });
  const c = a.json.comment;
  assert.ok(c.nodeId && c.nodeId.startsWith('PRRC_'), 'the new comment carries its node id: ' + c.nodeId);
  const e = await post('/api/comment/edit', { ...R, kind: 'review', commentId: c.id, text: 'second draft', pending: true, nodeId: c.nodeId });
  assert.equal(e.status, 200);
  assert.equal(e.json.body, 'second draft');
  assert.deepEqual(fake.ops.at(-1), { op: 'edit', id: c.id, body: 'second draft', via: 'graphql' });
  const bad = await post('/api/comment/edit', { ...R, kind: 'review', commentId: c.id, text: 'x', pending: true });
  assert.equal(bad.status, 400, 'a pending edit needs the node id');
  const viaRest = await post('/api/comment/edit', { ...R, kind: 'review', commentId: c.id, text: 'x' });
  assert.equal(viaRest.status, 404, 'the REST path really is a 404 for pending comments');
  // submit: the comment is posted; GitHub touches updated_at, but that is not an edit...
  await post('/api/pending/finish', { ...R, event: 'COMMENT', body: '' });
  const mine = (await get('/api/pr?ref=acme/docs%237')).json.comments.find((x) => x.id === c.id);
  assert.equal(mine.pending, false);
  assert.equal(mine.edited, true, 'it WAS edited before submit (lastEditedAt is set)');
  const b = await post('/api/pending/add', { ...R, comment: line({ body: 'never edited' }) });
  await post('/api/pending/finish', { ...R, event: 'COMMENT', body: '' });
  const untouched = (await get('/api/pr?ref=acme/docs%237')).json.comments.find((x) => x.id === b.json.comment.id);
  assert.equal(untouched.edited, false, 'submitting alone must not show "edited"');
  assert.notEqual(untouched.updatedAt, untouched.createdAt, 'even though updated_at moved');
});
