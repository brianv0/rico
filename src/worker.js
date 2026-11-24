// Rico on Cloudflare Workers: signs people in with a GitHub OAuth app, keeps their token in an
// encrypted HttpOnly cookie, and proxies the same GitHub API calls as the local server. The static
// app (dist/) is served by Workers Assets. Nothing is stored server-side.
import { createGithub, HttpError } from './github.js';
import { seal, open, readCookie, setCookie } from './session.js';
import { secure } from './security.js';
import { parsePrPath } from '../public/lib.js';

const SESSION = 'rico_session';
const OAUTH = 'rico_oauth';
const SESSION_TTL = 30 * 24 * 3600 * 1000;
const OAUTH_TTL = 10 * 60 * 1000;

const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });
const page = (status, text) => new Response(`<!doctype html><meta charset="utf-8"><title>Rico</title><body style="font:16px system-ui;max-width:32em;margin:4em auto;padding:0 1em"><p>${text}</p><p><a href="/">Back to Rico</a></p>`, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
const safeReturn = (r) => (typeof r === 'string' && /^\/(?!\/)[^\\\s]*$/.test(r) ? r : '/');
const randomState = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');

// ---- sessions -------------------------------------------------------------------------------------
// Two modes, like oauth2-proxy's cookie and Redis session stores:
//  * cookie (no KV bound): the whole session, sealed with SESSION_SECRET, is the cookie.
//  * split (KV bound as SESSIONS): the token is sealed with a key made of SESSION_SECRET (server) AND a random
//    half that only the cookie carries, and the ciphertext lives in KV. The cookie alone has nothing in it, the KV
//    alone cannot be decrypted, and signing out deletes the KV entry, so a copied cookie stops working at once.
const b64u = (b) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const rand = (n) => b64u(crypto.getRandomValues(new Uint8Array(n)));

async function createSession(env, token) {
  if (!env.SESSIONS) return seal(env.SESSION_SECRET, { t: token }, SESSION_TTL);
  const sid = rand(16);
  const half = rand(32);
  await env.SESSIONS.put('s:' + sid, await seal(`${env.SESSION_SECRET}:${half}`, { t: token }, SESSION_TTL), { expirationTtl: SESSION_TTL / 1000 });
  return `v2.${sid}.${half}`;
}

async function readSession(env, cookieHeader) {
  const raw = readCookie(cookieHeader, SESSION);
  if (!raw) return null;
  if (!env.SESSIONS) return open(env.SESSION_SECRET, raw);
  const m = /^v2\.([\w-]+)\.([\w-]+)$/.exec(raw);
  if (!m) return null;
  const stored = await env.SESSIONS.get('s:' + m[1]);
  return stored ? open(`${env.SESSION_SECRET}:${m[2]}`, stored) : null;
}

async function destroySession(env, cookieHeader) {
  const m = /^v2\.([\w-]+)\.[\w-]+$/.exec(readCookie(cookieHeader, SESSION) || '');
  if (env.SESSIONS && m) await env.SESSIONS.delete('s:' + m[1]);
}

function missingConfig(env) {
  return ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'SESSION_SECRET'].filter((k) => !env[k]);
}

async function login(request, env, url) {
  const state = randomState();
  const sealed = await seal(env.SESSION_SECRET, { state, ret: safeReturn(url.searchParams.get('return')) }, OAUTH_TTL);
  const auth = new URL('/login/oauth/authorize', env.GITHUB_OAUTH_URL || 'https://github.com');
  auth.search = new URLSearchParams({ client_id: env.GITHUB_CLIENT_ID, redirect_uri: url.origin + '/auth/callback', scope: env.OAUTH_SCOPE || 'repo', state, allow_signup: 'false' });
  return new Response(null, { status: 302, headers: { Location: auth.toString(), 'Set-Cookie': setCookie(OAUTH, sealed, { maxAge: 600, secure: url.protocol === 'https:' }), 'Cache-Control': 'no-store' } });
}

async function callback(request, env, url) {
  const secure = url.protocol === 'https:';
  const clear = setCookie(OAUTH, '', { maxAge: 0, secure });
  const flow = await open(env.SESSION_SECRET, readCookie(request.headers.get('Cookie'), OAUTH));
  const state = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  if (url.searchParams.get('error')) return page(400, 'GitHub sign-in was cancelled or refused.');
  if (!flow || !state || flow.state !== state || !code) return page(400, 'That sign-in attempt is not valid or has expired. Please try again.');
  let tok;
  try {
    const r = await fetch(new URL('/login/oauth/access_token', env.GITHUB_OAUTH_URL || 'https://github.com'), {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'rico' },
      body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code, redirect_uri: url.origin + '/auth/callback' }),
    });
    tok = await r.json();
  } catch {
    return page(502, 'Could not reach GitHub to finish signing in.');
  }
  if (!tok.access_token) return page(400, `GitHub did not grant access${tok.error_description ? ': ' + tok.error_description : ''}.`);
  const session = await createSession(env, tok.access_token);
  const headers = new Headers({ Location: flow.ret || '/', 'Cache-Control': 'no-store' });
  headers.append('Set-Cookie', setCookie(SESSION, session, { maxAge: SESSION_TTL / 1000, secure }));
  headers.append('Set-Cookie', clear);
  return new Response(null, { status: 302, headers });
}

// Preview mode: signed-out visitors can read PUBLIC pull requests (never post). Requests use the optional PREVIEW_TOKEN
// secret (a token with no private access, only to lift GitHub's anonymous rate limit) or none, and good responses are
// cached at the edge for a minute so many visitors share one GitHub call.
const PREVIEW_GET = new Set(['/api/pr', '/api/file', '/api/raw', '/api/comments', '/api/icon']);
const PREVIEW_HINT = ' Preview mode only reads public repositories; sign in with GitHub for private ones.';

async function preview(env, request, url) {
  if (url.pathname === '/api/me') return json(200, { hosted: true, preview: true });
  if (request.method !== 'GET' || !PREVIEW_GET.has(url.pathname)) return json(401, { error: 'Sign in with GitHub to comment.', signin: true });
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const key = new Request(url.toString(), { method: 'GET' });
  if (cache) { const hit = await cache.match(key); if (hit) return hit; }
  const github = createGithub({ apiUrl: env.GITHUB_API_URL || 'https://api.github.com', getToken: () => env.PREVIEW_TOKEN || '', readOnly: true });
  const res = await github.route('GET', url, async () => ({}));
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const gate = [401, 403, 404].includes(res.status);
    return json(res.status, { error: (body.error || 'GitHub error') + (gate ? PREVIEW_HINT : ''), signin: gate });
  }
  if (url.pathname === '/api/pr') {
    const text = await res.text();
    if (JSON.parse(text).isPrivate) return json(404, { error: 'GitHub: Not Found.' + PREVIEW_HINT, signin: true }); // never show private data without sign-in
    const out = new Response(text, { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' } });
    if (cache) await cache.put(key, out.clone());
    return out;
  }
  if (url.pathname === '/api/file') {
    const out = new Response(await res.text(), { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=60' } });
    if (cache) await cache.put(key, out.clone());
    return out;
  }
  return res;
}

async function api(request, env, url) {
  // cross-site requests and forged POSTs: a custom header forces a CORS preflight, and Origin must match
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const origin = request.headers.get('Origin');
    if (request.headers.get('X-Rico') !== '1' || (origin && origin !== url.origin)) return json(403, { error: 'forbidden' });
  }
  const sess = await readSession(env, request.headers.get('Cookie'));
  if (!sess?.t) return preview(env, request, url);
  const github = createGithub({
    apiUrl: env.GITHUB_API_URL || 'https://api.github.com',
    getToken: () => {
      if (!sess?.t) throw new HttpError(401, 'Sign in with GitHub to continue.');
      return sess.t;
    },
  });
  const res = await github.route(request.method, url, () => request.json().catch(() => { throw new HttpError(400, 'invalid json'); }));
  if (res.status === 401) { // not signed in, or GitHub revoked the token: either way, sign in again
    const body = await res.json().catch(() => ({}));
    return json(401, { error: body.error || 'Sign in with GitHub to continue.', signin: true });
  }
  if (url.pathname === '/api/me' && res.ok) {
    const me = await res.json();
    record(env, me.login, 'load');
    return json(200, { ...me, hosted: true });
  }
  if (request.method === 'POST' && res.ok && Object.hasOwn(COMMENT_KINDS, url.pathname)) {
    const out = await res.clone().json().catch(() => ({}));
    record(env, (out.comment || out).user, 'comment', COMMENT_KINDS[url.pathname]);
  }
  return res;
}

// ---- usage ----------------------------------------------------------------------------------------
// Distinct signed-in users (DAU / WAU / MAU) and the comments each one posts, when the AU Analytics Engine dataset
// (active_users) is bound, so the most active users can be named. Query it with `npm run usage`.
//   index1: the GitHub login, lowercased (logins are case-insensitive); blob1: the login as GitHub spells it
//   blob2: 'load' (an app load: /api/me) or 'comment' (a comment posted through Rico)
//   blob3: for a comment, which kind: 'line', 'general', 'reply' or 'pending' (added to a pending review)
// The first points (2026-11-24, before logins were stored) carry a 32-hex pseudonymous id instead, and some no blob2.
const COMMENT_KINDS = { '/api/comment': 'line', '/api/pr-comment': 'general', '/api/reply': 'reply', '/api/pending/add': 'pending' };

function record(env, login, event, kind = '') {
  if (!env.AU || typeof login !== 'string' || !login || login === 'ghost') return;
  try {
    env.AU.writeDataPoint({ indexes: [login.toLowerCase()], blobs: [login, event, kind], doubles: [1] }); // fire-and-forget
  } catch { /* usage counting must never break the app */ }
}

const worker = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;
    if (p.startsWith('/auth/') || p.startsWith('/api/')) {
      const missing = missingConfig(env);
      if (missing.length) return json(500, { error: `Server is not configured: missing ${missing.join(', ')}.` });
      if (p === '/auth/login' && request.method === 'GET') return login(request, env, url);
      if (p === '/auth/callback' && request.method === 'GET') return callback(request, env, url);
      if (p === '/auth/logout' && request.method === 'POST') {
        if (request.headers.get('X-Rico') !== '1') return json(403, { error: 'forbidden' });
        await destroySession(env, request.headers.get('Cookie'));
        return json(200, { ok: true }, { 'Set-Cookie': setCookie(SESSION, '', { maxAge: 0, secure: url.protocol === 'https:' }) });
      }
      if (p.startsWith('/api/')) return api(request, env, url);
      return json(404, { error: 'not found' });
    }
    // A PR page (/github.com/o/r/7@abc1234) is the app. Serve index.html for it here: left to Workers Assets, the
    // single-page fallback first 307-redirects the path to its canonical encoding (/github.com/o/r/7%40abc1234).
    if (parsePrPath(p) && (request.method === 'GET' || request.method === 'HEAD')) {
      return env.ASSETS.fetch(new Request(new URL('/', url), { method: request.method, headers: request.headers }));
    }
    return env.ASSETS.fetch(request); // the app; unknown paths fall back to index.html (see wrangler.toml)
  },
};

// every response, including the static app, carries the CSP / framing headers
export default { fetch: async (request, env) => secure(await worker.fetch(request, env)) };
