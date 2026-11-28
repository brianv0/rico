// The Cloudflare Worker, run in-process with a stubbed `fetch` standing in for GitHub.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import { seal, open } from '../src/session.js';

const env = { GITHUB_CLIENT_ID: 'cid', GITHUB_CLIENT_SECRET: 'csecret', SESSION_SECRET: 'sekrit', ASSETS: { fetch: async (r) => new Response('asset:' + new URL(r.url).pathname) } };
const ORIGIN = 'https://rico.example.dev';
const calls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(String(url));
  calls.push({ url: u.toString(), opts });
  if (u.hostname === 'api.github.com' && opts.method === 'DELETE' && u.pathname === '/applications/cid/token') {
    return JSON.parse(opts.body).access_token === 'gho_usertoken' ? new Response(null, { status: 204 }) : Response.json({ message: 'Not Found' }, { status: 404 });
  }
  if (u.pathname === '/login/oauth/access_token') {
    const b = JSON.parse(opts.body);
    return Response.json(b.code === 'good' ? { access_token: 'gho_usertoken', scope: b.redirect_uri.includes('priv') ? 'repo' : 'public_repo' } : { error: 'bad_verification_code', error_description: 'The code passed is incorrect or expired.' });
  }
  if (u.hostname === 'api.github.com' && u.pathname === '/user') {
    return opts.headers.Authorization === 'Bearer gho_usertoken' ? Response.json({ login: 'octo', avatar_url: 'a' }) : Response.json({ message: 'Bad credentials' }, { status: 401 });
  }
  if (u.hostname === 'api.github.com' && /^\/repos\/o\/(pub|priv)\/pulls\/1$/.test(u.pathname)) {
    return Response.json({ title: 'T', state: 'open', head: { sha: 'abc1234', ref: 'h' }, base: { sha: 'def5678', ref: 'main', repo: { private: u.pathname.includes('priv') } }, user: { login: 'u' } });
  }
  if (u.hostname === 'api.github.com' && opts.method === 'POST' && /^\/repos\/o\/r\/(issues|pulls)\/1\/comments$/.test(u.pathname)) {
    return Response.json({ id: 77, user: { login: 'octo' }, body: 'x', created_at: 't', html_url: 'h' }, { status: 201 });
  }
  if (u.hostname === 'api.github.com' && /\/pulls\/1\/(files|comments)$/.test(u.pathname)) return Response.json([]);
  if (u.hostname === 'api.github.com' && u.pathname === '/repos/o/pub/contents/specs/001-x') return Response.json([{ name: 'spec.md', path: 'specs/001-x/spec.md', type: 'file', sha: 'zz' }]);
  if (u.hostname === 'api.github.com' && u.pathname.startsWith('/repos/o/gone')) return Response.json({ message: 'Not Found' }, { status: 404 });
  if (u.hostname === 'api.github.com' && u.pathname === '/repos/o/r/pulls/1/reviews') return Response.json({ id: 9, html_url: 'h', state: 'COMMENTED' });
  return Response.json({ message: 'Not Found' }, { status: 404 });
};
test.after(() => { globalThis.fetch = realFetch; });

const req = (p, init = {}) => new Request(ORIGIN + p, init);
const cookieOf = (res, name) => { const c = res.headers.getSetCookie().find((x) => x.startsWith(name + '=')); return c ? c.split(';')[0] : null; };

async function signIn() {
  const l = await worker.fetch(req('/auth/login?return=/github.com/o/r/1?file=a.md'), env);
  const state = new URL(l.headers.get('Location')).searchParams.get('state');
  const flow = cookieOf(l, 'rico_oauth');
  const cb = await worker.fetch(req(`/auth/callback?code=good&state=${state}`, { headers: { Cookie: flow } }), env);
  return { l, cb, cookie: cookieOf(cb, 'rico_session') };
}

test('sessions are sealed: round-trip, tamper-proof, expiring, key-bound', async () => {
  const s = await seal('k', { t: 'tok' }, 1000);
  assert.equal((await open('k', s)).t, 'tok');
  assert.equal(await open('other', s), null);
  assert.equal(await open('k', s.slice(0, -2) + (s.endsWith('AA') ? 'BB' : 'AA')), null);
  assert.equal(await open('k', await seal('k', { t: 'x' }, -1)), null);
  assert.equal(await open('k', 'garbage'), null);
  assert.ok(!s.includes('tok'), 'the token is not readable in the cookie');
});

test('login redirects to GitHub with client id, callback url, scope and a state', async () => {
  const { l } = await signIn();
  assert.equal(l.status, 302);
  const u = new URL(l.headers.get('Location'));
  assert.equal(u.origin + u.pathname, 'https://github.com/login/oauth/authorize');
  assert.equal(u.searchParams.get('client_id'), 'cid');
  assert.equal(u.searchParams.get('redirect_uri'), ORIGIN + '/auth/callback');
  assert.equal(u.searchParams.get('scope'), 'public_repo', 'public repositories only by default');
  assert.match(l.headers.getSetCookie()[0], /rico_oauth=.*HttpOnly.*SameSite=Lax.*Secure/);
});

test('callback: valid code signs in, stores the token only in an encrypted HttpOnly cookie, and returns to the page', async () => {
  const { cb, cookie } = await signIn();
  assert.equal(cb.status, 302);
  assert.equal(cb.headers.get('Location'), '/github.com/o/r/1?file=a.md');
  assert.ok(cookie && !cookie.includes('gho_usertoken'));
  assert.match(cb.headers.getSetCookie().find((c) => c.startsWith('rico_session=')), /HttpOnly/);
  const sent = JSON.parse(calls.findLast((c) => c.url.endsWith('/login/oauth/access_token')).opts.body);
  assert.deepEqual([sent.client_id, sent.client_secret, sent.code], ['cid', 'csecret', 'good']);
});

test('callback rejects a wrong or missing state, a bad code, and an offsite return path', async () => {
  const l = await worker.fetch(req('/auth/login?return=//evil.example'), env);
  const state = new URL(l.headers.get('Location')).searchParams.get('state');
  const flow = cookieOf(l, 'rico_oauth');
  assert.equal((await worker.fetch(req('/auth/callback?code=good&state=nope', { headers: { Cookie: flow } }), env)).status, 400);
  assert.equal((await worker.fetch(req(`/auth/callback?code=good&state=${state}`), env)).status, 400, 'no state cookie (CSRF)');
  assert.equal((await worker.fetch(req(`/auth/callback?code=bad&state=${state}`, { headers: { Cookie: flow } }), env)).status, 400);
  const ok = await worker.fetch(req(`/auth/callback?code=good&state=${state}`, { headers: { Cookie: flow } }), env);
  assert.equal(ok.headers.get('Location'), '/', '//evil.example is not an acceptable return path');
});

test('api: signed out is preview mode; signed in reaches GitHub with the user token', async () => {
  const out = await worker.fetch(req('/api/me'), env);
  assert.equal(out.status, 200);
  assert.deepEqual(await out.json(), { hosted: true, preview: true });
  const { cookie } = await signIn();
  const me = await worker.fetch(req('/api/me', { headers: { Cookie: cookie } }), env);
  assert.deepEqual(await me.json(), { login: 'octo', avatar: 'a', hosted: true, private: false });
  assert.equal(calls.findLast((c) => c.url.endsWith('/user')).opts.headers.Authorization, 'Bearer gho_usertoken');
});

test('usage: each signed-in /api/me writes the login to AU; preview and failures write nothing', async () => {
  const points = [];
  const usageEnv = { ...env, AU: { writeDataPoint: (p) => points.push(p) } };
  await worker.fetch(req('/api/me'), usageEnv); // signed out
  assert.equal(points.length, 0);
  const { cookie } = await signIn();
  await worker.fetch(req('/api/me', { headers: { Cookie: cookie } }), usageEnv);
  await worker.fetch(req('/api/me', { headers: { Cookie: cookie } }), usageEnv);
  assert.equal(points.length, 2);
  assert.deepEqual(points[0], { indexes: ['octo'], blobs: ['octo', 'load', ''], doubles: [1] });
  assert.deepEqual(points[1], points[0], 'the same user, the same index');
  const broken = { ...env, AU: { writeDataPoint: () => { throw new Error('down'); } } };
  assert.equal((await worker.fetch(req('/api/me', { headers: { Cookie: cookie } }), broken)).status, 200, 'a failing dataset never breaks the app');
});

test('usage: a comment posted through Rico is counted for its author, by kind; a failed or signed-out post is not', async () => {
  const points = [];
  const usageEnv = { ...env, AU: { writeDataPoint: (p) => points.push(p) } };
  const { cookie } = await signIn();
  const post = (p, body, c = cookie) => worker.fetch(req(p, { method: 'POST', headers: { 'X-Rico': '1', Cookie: c, Origin: ORIGIN }, body: JSON.stringify(body) }), usageEnv);
  await worker.fetch(req('/api/me', { headers: { Cookie: cookie } }), usageEnv);
  const id = 'octo';
  assert.equal((await post('/api/pr-comment', { owner: 'o', repo: 'r', number: 1, text: 'hi' })).status, 200);
  assert.equal((await post('/api/comment', { owner: 'o', repo: 'r', number: 1, comment: { commit_id: 'abc1234', path: 'a.md', line: 3, body: 'x' } })).status, 200);
  assert.deepEqual(points.slice(1).map((p) => p.blobs), [[id, 'comment', 'general'], [id, 'comment', 'line']], 'keyed by the same login as their app loads');
  assert.notEqual((await post('/api/pr-comment', { owner: 'o', repo: 'gone', number: 1, text: 'hi' })).status, 200);
  assert.notEqual((await post('/api/pr-comment', { owner: 'o', repo: 'r', number: 1, text: 'hi' }, '')).status, 200);
  assert.equal((await post('/api/review', { owner: 'o', repo: 'r', number: 1, review: { event: 'COMMENT' } })).status, 200);
  assert.equal(points.length, 3, 'failures, signed-out posts and non-comment writes add nothing');
});

test('api: a forged or tampered session cookie is just signed out; a revoked token asks to sign in again', async () => {
  assert.equal((await (await worker.fetch(req('/api/me', { headers: { Cookie: 'rico_session=AAAA' } }), env)).json()).preview, true);
  const revoked = await seal(env.SESSION_SECRET, { t: 'gho_revoked' }, 1e6);
  const res = await worker.fetch(req('/api/me', { headers: { Cookie: 'rico_session=' + revoked } }), env);
  assert.equal(res.status, 401);
  assert.equal((await res.json()).signin, true);
});

test('a revoked token also clears the session cookie, so the browser is signed out rather than stuck', async () => {
  const { cookie } = await signIn();
  const res = await worker.fetch(req('/api/me', { headers: { Cookie: await sealed({ t: 'gho_revoked' }) } }), env);
  assert.equal(res.status, 401);
  assert.equal((await res.json()).signin, true);
  assert.match(res.headers.get('Set-Cookie'), /rico_session=;.*Max-Age=0/);
  assert.ok(cookie);
});

test('api POSTs need the X-Rico header and a same-origin Origin', async () => {
  const { cookie } = await signIn();
  const body = JSON.stringify({ owner: 'o', repo: 'r', number: 1, review: { event: 'COMMENT', body: 'x' } });
  const post = (h) => worker.fetch(req('/api/review', { method: 'POST', body, headers: { Cookie: cookie, ...h } }), env);
  assert.equal((await post({})).status, 403);
  assert.equal((await post({ 'X-Rico': '1', Origin: 'https://evil.example' })).status, 403);
  const ok = await post({ 'X-Rico': '1', Origin: ORIGIN });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).id, 9);
});

test('logout clears the session; missing configuration is reported; everything else is the static app', async () => {
  const out = await worker.fetch(req('/auth/logout', { method: 'POST', headers: { 'X-Rico': '1' } }), env);
  assert.match(out.headers.get('Set-Cookie'), /rico_session=;.*Max-Age=0/);
  assert.equal((await worker.fetch(req('/auth/logout', { method: 'POST' }), env)).status, 403);
  const bad = await worker.fetch(req('/api/me'), { ...env, GITHUB_CLIENT_SECRET: '' });
  assert.equal(bad.status, 500);
  assert.match((await bad.json()).error, /GITHUB_CLIENT_SECRET/);
  assert.equal(await (await worker.fetch(req('/app.js'), env)).text(), 'asset:/app.js');
});

test('a PR page is the app (index.html), served without the asset handler\'s %40 redirect', async () => {
  // Workers Assets 307-redirects /…/7@abc to /…/7%40abc; the Worker serves "/" for PR paths so the link stays as made
  for (const p of ['/github.com/o/r/1', '/github.com/o/r/1@abc1234?file=a.md', '/github.com/o/r/1%40abc1234']) {
    const out = await worker.fetch(req(p), env);
    assert.equal(out.status, 200, p);
    assert.equal(await out.text(), 'asset:/', p);
  }
  assert.equal(await (await worker.fetch(req('/github.com/o/r/1@abc1234/x.js'), env)).text(), 'asset:/github.com/o/r/1@abc1234/x.js'); // not a PR path
});

// ---- split mode: the token is encrypted in KV with a key made of a server secret and a half held only by the cookie
const kv = () => { const m = new Map(); return { m, get: async (k) => m.get(k) ?? null, put: async (k, v) => void m.set(k, v), delete: async (k) => void m.delete(k) }; };

async function signInSplit(e) {
  const l = await worker.fetch(req('/auth/login'), e);
  const state = new URL(l.headers.get('Location')).searchParams.get('state');
  const cb = await worker.fetch(req(`/auth/callback?code=good&state=${state}`, { headers: { Cookie: cookieOf(l, 'rico_oauth') } }), e);
  return cookieOf(cb, 'rico_session');
}

test('split sessions: cookie holds no token, KV holds only ciphertext, and either half alone is useless', async () => {
  const e = { ...env, SESSIONS: kv() };
  const cookie = await signInSplit(e);
  assert.match(cookie, /^rico_session=v2\.[\w-]+\.[\w-]+$/);
  assert.equal(e.SESSIONS.m.size, 1);
  const [[key, stored]] = [...e.SESSIONS.m];
  assert.ok(key.startsWith('s:') && !stored.includes('gho_usertoken') && !cookie.includes('gho_usertoken'));
  const me = await worker.fetch(req('/api/me', { headers: { Cookie: cookie } }), e);
  assert.equal((await me.json()).login, 'octo');
  // the cookie without the KV entry
  assert.equal((await (await worker.fetch(req('/api/me', { headers: { Cookie: cookie } }), { ...e, SESSIONS: kv() })).json()).preview, true);
  // the KV entry with a different cookie half (or a plain old-style cookie)
  const [, sid] = cookie.split('=')[1].split('.');
  assert.equal((await (await worker.fetch(req('/api/me', { headers: { Cookie: `rico_session=v2.${sid}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA` } }), e)).json()).preview, true);
  assert.equal(await open(env.SESSION_SECRET, stored), null, 'the server secret alone cannot read the KV entry');
});

test('split sessions: signing out deletes the server half, so a copied cookie stops working', async () => {
  const e = { ...env, SESSIONS: kv() };
  const cookie = await signInSplit(e);
  const out = await worker.fetch(req('/auth/logout', { method: 'POST', headers: { 'X-Rico': '1', Cookie: cookie } }), e);
  assert.equal(out.status, 200);
  assert.equal(e.SESSIONS.m.size, 0);
  assert.equal((await (await worker.fetch(req('/api/me', { headers: { Cookie: cookie } }), e)).json()).preview, true, 'the replayed cookie is dead: back to preview');
});

// ---- hardening: every response carries the CSP / framing headers; '.' and '..' are not owner/repo names
test('every response, including the static app and errors, carries CSP and framing headers; /api/raw keeps its stricter CSP', async () => {
  for (const res of [await worker.fetch(req('/github.com/o/r/1'), env), await worker.fetch(req('/api/me'), { ...env, GITHUB_CLIENT_SECRET: '' }), await worker.fetch(req('/auth/login'), env)]) {
    assert.match(res.headers.get('Content-Security-Policy'), /frame-ancestors 'self'/);
    assert.equal(res.headers.get('X-Frame-Options'), 'DENY');
    assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff');
  }
});

test('api: "." and ".." are rejected as owner/repo before anything reaches GitHub', async () => {
  const { cookie } = await signIn();
  const before = calls.length;
  for (const p of ['/api/pr?owner=..&repo=r&number=1', '/api/pr?owner=o&repo=..&number=1', '/api/pr?owner=.&repo=r&number=1']) {
    assert.equal((await worker.fetch(req(p, { headers: { Cookie: cookie } }), env)).status, 400);
  }
  assert.equal(calls.slice(before).filter((c) => c.url.includes('/repos/')).length, 0);
});

test('preview: signed-out visitors read public PRs anonymously (or with PREVIEW_TOKEN) but cannot post', async () => {
  const pr = await worker.fetch(req('/api/pr?ref=o/pub%231'), env);
  assert.equal(pr.status, 200);
  assert.equal((await pr.json()).title, 'T');
  assert.equal(calls.findLast((c) => c.url.includes('/pulls/1')).opts.headers.Authorization, undefined, 'anonymous: no token is sent');
  await worker.fetch(req('/api/pr?ref=o/pub%231'), { ...env, PREVIEW_TOKEN: 'ghp_public' });
  assert.equal(calls.findLast((c) => c.url.endsWith('/pulls/1')).opts.headers.Authorization, 'Bearer ghp_public');
  const review = await worker.fetch(req('/api/review', { method: 'POST', headers: { 'X-Rico': '1', Origin: ORIGIN }, body: '{}' }), env);
  assert.equal(review.status, 401);
  assert.equal((await review.json()).signin, true);
});

test('preview: a directory listing (for spec review) is readable signed out, and trimmed to name, path and type', async () => {
  const d = await worker.fetch(req('/api/dir?owner=o&repo=pub&path=specs/001-x&ref=abc1234'), env);
  assert.equal(d.status, 200);
  assert.deepEqual(await d.json(), [{ name: 'spec.md', path: 'specs/001-x/spec.md', type: 'file' }]);
  assert.equal((await worker.fetch(req('/api/dir?owner=o&repo=pub&path=specs/001-x&ref=abc1234', { method: 'POST', headers: { 'X-Rico': '1', Origin: ORIGIN }, body: '{}' }), env)).status, 401);
});

test('preview: private or missing repositories are not shown and point to sign-in', async () => {
  const priv = await worker.fetch(req('/api/pr?ref=o/priv%231'), env);
  assert.equal(priv.status, 404);
  const b = await priv.json();
  assert.equal(b.signin, true);
  assert.match(b.error, /public repositories/);
  assert.ok(!JSON.stringify(b).includes('"title"'), 'no private PR data is returned');
  const gone = await worker.fetch(req('/api/pr?ref=o/gone%231'), env);
  assert.equal(gone.status, 404);
  assert.equal((await gone.json()).signin, true);
});

const WRITE_ROUTES = ['/api/viewed', '/api/comment', '/api/pr-comment', '/api/comment/edit', '/api/comment/delete', '/api/thread/resolve', '/api/reaction', '/api/pending/add', '/api/pending/finish', '/api/pending/discard', '/api/reply', '/api/review'];

test('comment routes: signed out is 401 signin:true; every write needs X-Rico and the same Origin, whatever the method', async () => {
  for (const p of WRITE_ROUTES) {
    const out = await worker.fetch(req(p, { method: 'POST', headers: { 'X-Rico': '1', 'Content-Type': 'application/json' }, body: '{}' }), env);
    assert.equal(out.status, 401, p);
    assert.equal((await out.json()).signin, true, p);
    assert.equal((await worker.fetch(req(p, { method: 'POST', body: '{}' }), env)).status, 403, p + ' without X-Rico');
    assert.equal((await worker.fetch(req(p, { method: 'POST', headers: { 'X-Rico': '1', Origin: 'https://evil.example' }, body: '{}' }), env)).status, 403, p + ' cross-origin');
  }
  for (const m of ['PATCH', 'DELETE', 'PUT']) assert.equal((await worker.fetch(req('/api/comment', { method: m, body: '{}' }), env)).status, 403, m + ' is not a way around the check');
});

test('comment routes: signed in, a comment reaches GitHub as the user; /api/comments is readable in preview, without viewer powers', async () => {
  const { cookie } = await signIn();
  calls.length = 0;
  const post = await worker.fetch(req('/api/pr-comment', { method: 'POST', headers: { 'X-Rico': '1', Cookie: cookie, Origin: ORIGIN }, body: JSON.stringify({ owner: 'o', repo: 'r', number: 1, text: 'hi' }) }), env);
  const c = calls.find((x) => x.url.endsWith('/repos/o/r/issues/1/comments'));
  assert.equal(c.opts.method, 'POST');
  assert.equal(c.opts.headers.Authorization, 'Bearer gho_usertoken');
  assert.ok(post.status >= 200);
  // preview: the polling endpoint is allowed, and never asks GraphQL (viewer powers would be the preview token's)
  calls.length = 0;
  const prev = await worker.fetch(req('/api/comments?owner=o&repo=pub&number=1'), { ...env, PREVIEW_TOKEN: 'pt' });
  assert.notEqual(prev.status, 401);
  assert.ok(!calls.some((x) => x.url.includes('/graphql')), 'no GraphQL in preview');
});

test('/api/icon: signed-out preview can load a D2 icon from the icon host only, as an image with a locked-down CSP', async () => {
  const real = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url, opts) => { if (new URL(String(url)).hostname === 'icons.terrastruct.com') { asked.push(String(url)); return new Response('<svg xmlns="http://www.w3.org/2000/svg"/>', { status: 200, headers: { 'Content-Type': 'image/svg+xml' } }); } return real(url, opts); };
  try {
    const u = 'https://icons.terrastruct.com/essentials%2F092-graph%20bar.svg';
    const ok = await worker.fetch(req('/api/icon?u=' + encodeURIComponent(u)), env);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('Content-Type'), 'image/svg+xml');
    assert.match(ok.headers.get('Content-Security-Policy'), /default-src 'none'/);
    assert.deepEqual(asked, [u]);
    const bad = await worker.fetch(req('/api/icon?u=' + encodeURIComponent('https://evil.example/x.svg')), env);
    assert.equal(bad.status, 400);
    assert.equal(asked.length, 1); // the other host was never contacted
  } finally { globalThis.fetch = real; }
});

// ---- narrow scope, private opt-in, revoke on sign-out, rate limits, error reports

const scopeOf = async (path, e = env) => new URL((await worker.fetch(req(path), e)).headers.get('Location')).searchParams.get('scope');

test('scope: public_repo by default; private=1 is the explicit opt-in; both are configurable', async () => {
  assert.equal(await scopeOf('/auth/login'), 'public_repo');
  assert.equal(await scopeOf('/auth/login?private=1'), 'repo');
  assert.equal(await scopeOf('/auth/login?private=yes'), 'public_repo', 'only private=1 opts in');
  assert.equal(await scopeOf('/auth/login?private=1', { ...env, OAUTH_PRIVATE_SCOPE: 'repo read:org' }), 'repo read:org');
  assert.equal(await scopeOf('/auth/login', { ...env, OAUTH_SCOPE: 'repo' }), 'repo');
});

test('/api/me says whether private repositories are allowed, from the scope GitHub granted; a private PR hints at the opt-in', async () => {
  const { cookie } = await signIn();
  const me = await (await worker.fetch(req('/api/me', { headers: { Cookie: cookie } }), env)).json();
  assert.equal(me.private, false);
  const gone = await worker.fetch(req('/api/pr?ref=o/gone%231', { headers: { Cookie: cookie } }), env);
  assert.equal(gone.status, 404);
  assert.match((await gone.json()).error, /allow private repositories/i);
  // a session that was granted `repo` (also: one made before the scope was recorded) is private-capable and gets no hint
  const priv = await sealed({ t: 'gho_usertoken', s: 'repo' });
  assert.equal((await (await worker.fetch(req('/api/me', { headers: { Cookie: priv } }), env)).json()).private, true);
  const legacy = await sealed({ t: 'gho_usertoken' });
  assert.equal((await (await worker.fetch(req('/api/me', { headers: { Cookie: legacy } }), env)).json()).private, true);
  const g2 = await worker.fetch(req('/api/pr?ref=o/gone%231', { headers: { Cookie: priv } }), env);
  assert.doesNotMatch((await g2.json()).error, /allow private/i);
});
async function sealed(payload) { return 'rico_session=' + await seal(env.SESSION_SECRET, payload, 60000); }

test('logout revokes the token at GitHub (best effort) and still clears the session when GitHub fails', async () => {
  const { cookie } = await signIn();
  const before = calls.length;
  const out = await worker.fetch(req('/auth/logout', { method: 'POST', headers: { 'X-Rico': '1', Cookie: cookie } }), env);
  assert.deepEqual(await out.json(), { ok: true, revoked: true });
  const del = calls.slice(before).find((c) => c.opts.method === 'DELETE');
  assert.equal(del.url, 'https://api.github.com/applications/cid/token');
  assert.equal(del.opts.headers.Authorization, 'Basic ' + btoa('cid:csecret'));
  assert.equal(JSON.parse(del.opts.body).access_token, 'gho_usertoken');
  assert.match(out.headers.get('Set-Cookie'), /rico_session=;.*Max-Age=0/);
  // signed out already: nothing to revoke, no call
  const n = calls.length;
  assert.deepEqual(await (await worker.fetch(req('/auth/logout', { method: 'POST', headers: { 'X-Rico': '1' } }), env)).json(), { ok: true, revoked: false });
  assert.equal(calls.length, n);
  // GitHub unreachable: still signed out locally
  const real = globalThis.fetch;
  globalThis.fetch = async (u, o) => { if (o?.method === 'DELETE') throw new Error('network down'); return real(u, o); };
  try {
    const out2 = await worker.fetch(req('/auth/logout', { method: 'POST', headers: { 'X-Rico': '1', Cookie: cookie } }), env);
    assert.deepEqual(await out2.json(), { ok: true, revoked: false });
    assert.match(out2.headers.get('Set-Cookie'), /Max-Age=0/);
  } finally { globalThis.fetch = real; }
});

const limiter = (okCount) => { const seen = []; return { seen, limit: async ({ key }) => { seen.push(key); return { success: seen.length <= okCount }; } }; };

test('preview: a rate-limited visitor gets 429 with a sign-in hint; the limiter is keyed by IP; a missing limiter means no limit', async () => {
  const PREVIEW_LIMIT = limiter(1);
  const e = { ...env, PREVIEW_LIMIT };
  const hdr = { headers: { 'CF-Connecting-IP': '203.0.113.9' } };
  assert.equal((await worker.fetch(req('/api/pr?ref=o/pub%231', hdr), e)).status, 200);
  const limited = await worker.fetch(req('/api/pr?ref=o/pub%232', hdr), e);
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('Retry-After'), '60');
  const body = await limited.json();
  assert.equal(body.signin, true);
  assert.deepEqual(PREVIEW_LIMIT.seen, ['203.0.113.9', '203.0.113.9']);
  assert.equal((await worker.fetch(req('/api/pr?ref=o/pub%231'), env)).status, 200, 'no binding: unlimited');
  const broken = { ...env, PREVIEW_LIMIT: { limit: async () => { throw new Error('boom'); } } };
  assert.equal((await worker.fetch(req('/api/pr?ref=o/pub%231'), broken)).status, 200, 'a failing limiter must not take preview down');
});

test('client errors: POST /api/client-error logs one structured line; it needs X-Rico and the same origin, is size-capped and rate limited', async () => {
  const lines = [];
  const orig = console.error;
  console.error = (m) => lines.push(m);
  try {
    const post = (body, init = {}) => worker.fetch(req('/api/client-error', { method: 'POST', headers: { 'X-Rico': '1', 'User-Agent': 'UA/1', ...init.headers }, body: typeof body === 'string' ? body : JSON.stringify(body) }), init.env || env);
    const ok = await post({ message: 'x is not a function', stack: 's'.repeat(5000), source: 'https://rico.example.dev/app.js', line: 12, login: 'octo', cookie: 'secret' });
    assert.equal(ok.status, 204);
    assert.equal(lines.length, 1);
    const rec = JSON.parse(lines[0]);
    assert.equal(rec.event, 'client_error');
    assert.equal(rec.message, 'x is not a function');
    assert.equal(rec.stack.length, 1500, 'stack is clipped');
    assert.equal(rec.ua, 'UA/1');
    assert.deepEqual(Object.keys(rec).sort(), ['event', 'line', 'message', 'source', 'stack', 'ua'], 'nothing else the page sent is logged');
    assert.equal((await worker.fetch(req('/api/client-error', { method: 'POST', body: '{}' }), env)).status, 403, 'needs X-Rico');
    assert.equal((await post({ message: 'm' }, { headers: { Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await post('not json')).status, 400);
    assert.equal((await worker.fetch(req('/api/client-error'), env)).status, 405);
    assert.equal(lines.length, 1);
    const ERROR_LIMIT = limiter(0);
    assert.equal((await post({ message: 'm' }, { env: { ...env, ERROR_LIMIT } })).status, 429);
    assert.equal(lines.length, 1, 'a limited report is dropped');
  } finally { console.error = orig; }
});
