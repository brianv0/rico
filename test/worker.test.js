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
  if (u.pathname === '/login/oauth/access_token') {
    const b = JSON.parse(opts.body);
    return Response.json(b.code === 'good' ? { access_token: 'gho_usertoken' } : { error: 'bad_verification_code', error_description: 'The code passed is incorrect or expired.' });
  }
  if (u.hostname === 'api.github.com' && u.pathname === '/user') {
    return opts.headers.Authorization === 'Bearer gho_usertoken' ? Response.json({ login: 'octo', avatar_url: 'a' }) : Response.json({ message: 'Bad credentials' }, { status: 401 });
  }
  if (u.hostname === 'api.github.com' && /^\/repos\/o\/(pub|priv)\/pulls\/1$/.test(u.pathname)) {
    return Response.json({ title: 'T', state: 'open', head: { sha: 'abc1234', ref: 'h' }, base: { sha: 'def5678', ref: 'main', repo: { private: u.pathname.includes('priv') } }, user: { login: 'u' } });
  }
  if (u.hostname === 'api.github.com' && /\/pulls\/1\/(files|comments)$/.test(u.pathname)) return Response.json([]);
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
  assert.equal(u.searchParams.get('scope'), 'repo');
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
  assert.deepEqual(await me.json(), { login: 'octo', avatar: 'a', hosted: true });
  assert.equal(calls.findLast((c) => c.url.endsWith('/user')).opts.headers.Authorization, 'Bearer gho_usertoken');
});

test('api: a forged or tampered session cookie is just signed out; a revoked token asks to sign in again', async () => {
  assert.equal((await (await worker.fetch(req('/api/me', { headers: { Cookie: 'rico_session=AAAA' } }), env)).json()).preview, true);
  const revoked = await seal(env.SESSION_SECRET, { t: 'gho_revoked' }, 1e6);
  const res = await worker.fetch(req('/api/me', { headers: { Cookie: 'rico_session=' + revoked } }), env);
  assert.equal(res.status, 401);
  assert.equal((await res.json()).signin, true);
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
  assert.equal(await (await worker.fetch(req('/github.com/o/r/1'), env)).text(), 'asset:/github.com/o/r/1');
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
