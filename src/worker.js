// Rico on Cloudflare Workers: signs people in with a GitHub OAuth app, keeps their token in an
// encrypted HttpOnly cookie, and proxies the same GitHub API calls as the local server. The static
// app (dist/) is served by Workers Assets. Nothing is stored server-side.
import { createGithub, HttpError } from './github.js';
import { seal, open, readCookie, setCookie } from './session.js';

const SESSION = 'rico_session';
const OAUTH = 'rico_oauth';
const SESSION_TTL = 30 * 24 * 3600 * 1000;
const OAUTH_TTL = 10 * 60 * 1000;

const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });
const page = (status, text) => new Response(`<!doctype html><meta charset="utf-8"><title>Rico</title><body style="font:16px system-ui;max-width:32em;margin:4em auto;padding:0 1em"><p>${text}</p><p><a href="/">Back to Rico</a></p>`, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
const safeReturn = (r) => (typeof r === 'string' && /^\/(?!\/)[^\\\s]*$/.test(r) ? r : '/');
const randomState = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');

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
  const session = await seal(env.SESSION_SECRET, { t: tok.access_token }, SESSION_TTL);
  const headers = new Headers({ Location: flow.ret || '/', 'Cache-Control': 'no-store' });
  headers.append('Set-Cookie', setCookie(SESSION, session, { maxAge: SESSION_TTL / 1000, secure }));
  headers.append('Set-Cookie', clear);
  return new Response(null, { status: 302, headers });
}

async function api(request, env, url) {
  // cross-site requests and forged POSTs: a custom header forces a CORS preflight, and Origin must match
  if (request.method === 'POST') {
    const origin = request.headers.get('Origin');
    if (request.headers.get('X-Rico') !== '1' || (origin && origin !== url.origin)) return json(403, { error: 'forbidden' });
  }
  const sess = await open(env.SESSION_SECRET, readCookie(request.headers.get('Cookie'), SESSION));
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
  if (url.pathname === '/api/me' && res.ok) return json(200, { ...(await res.json()), hosted: true });
  return res;
}

export default {
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
        return json(200, { ok: true }, { 'Set-Cookie': setCookie(SESSION, '', { maxAge: 0, secure: url.protocol === 'https:' }) });
      }
      if (p.startsWith('/api/')) return api(request, env, url);
      return json(404, { error: 'not found' });
    }
    return env.ASSETS.fetch(request); // the app; unknown paths fall back to index.html (see wrangler.toml)
  },
};
