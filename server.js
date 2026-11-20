#!/usr/bin/env node
// Rico server: serves the UI and proxies a handful of GitHub API calls so the token never
// reaches the browser. Node >= 18, no dependencies.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { parsePrRef } from './public/lib.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const API = (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, '');
const MD_RE = /\.(md|markdown|mdown|mdx)$/i;
const NAME_RE = /^[\w.-]+$/;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

let cachedToken = null;
function token() {
  if (cachedToken) return cachedToken;
  let t = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!t) {
    try {
      t = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      /* no gh */
    }
  }
  if (!t) throw new HttpError(401, 'No GitHub token. Set GITHUB_TOKEN (or GH_TOKEN), or run `gh auth login`, then retry.');
  return (cachedToken = t);
}

async function gh(apiPath, { method = 'GET', body, accept, binary = false } = {}) {
  const res = await fetch(API + apiPath, {
    method,
    headers: {
      Authorization: `Bearer ${token()}`,
      Accept: accept || 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'rico',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const buf = binary && res.ok ? Buffer.from(await res.arrayBuffer()) : null;
  const text = binary && res.ok ? '' : await res.text();
  if (!res.ok) {
    let msg = text;
    try {
      const j = JSON.parse(text);
      msg = j.message || msg;
      if (j.errors) msg += ' ' + JSON.stringify(j.errors);
    } catch {
      /* not json */
    }
    throw new HttpError(res.status === 401 || res.status === 403 || res.status === 404 || res.status === 422 ? res.status : 502, `GitHub: ${msg}`);
  }
  return binary ? buf : text;
}

const ghJson = async (p, o) => JSON.parse(await gh(p, o));

function repoParams(q) {
  const owner = q.get('owner');
  const repo = q.get('repo');
  if (!NAME_RE.test(owner || '') || !NAME_RE.test(repo || '')) throw new HttpError(400, 'bad owner/repo');
  return { owner, repo };
}

const compact = (c) => ({
  id: c.id,
  replyTo: c.in_reply_to_id ?? null,
  path: c.path,
  line: c.line ?? null,
  originalLine: c.original_line ?? null,
  startLine: c.start_line ?? null,
  originalStartLine: c.original_start_line ?? null,
  side: c.side || 'RIGHT',
  user: c.user?.login || 'ghost',
  body: c.body || '',
  createdAt: c.created_at,
  url: c.html_url,
  avatar: c.user?.avatar_url || null,
  assoc: c.author_association || null,
});

async function apiPr(q) {
  const ref = parsePrRef(q.get('ref'));
  if (!ref) throw new HttpError(400, 'Could not parse that as a GitHub PR (try https://github.com/owner/repo/pull/123 or owner/repo#123).');
  const { owner, repo, number } = ref;
  const base = `/repos/${owner}/${repo}/pulls/${number}`;
  const pull = await ghJson(base);
  const files = [];
  for (let page = 1; page <= 30; page++) {
    const batch = await ghJson(`${base}/files?per_page=100&page=${page}`);
    files.push(...batch);
    if (batch.length < 100) break;
  }
  // The version GitHub diffs against is the merge base, not necessarily the base branch tip.
  let baseSha = pull.base.sha;
  try {
    const cmp = await ghJson(`/repos/${owner}/${repo}/compare/${pull.base.sha}...${pull.head.sha}?per_page=1`);
    if (cmp.merge_base_commit?.sha) baseSha = cmp.merge_base_commit.sha;
  } catch { /* fall back to the base sha */ }
  const comments = [];
  for (let page = 1; page <= 30; page++) {
    const batch = await ghJson(`${base}/comments?per_page=100&page=${page}`);
    comments.push(...batch);
    if (batch.length < 100) break;
  }
  return {
    owner,
    repo,
    number,
    comments: comments.filter((c) => MD_RE.test(c.path || '')).map(compact),
    title: pull.title,
    state: pull.state,
    url: pull.html_url,
    draft: !!pull.draft,
    merged: !!pull.merged,
    commits: pull.commits ?? null,
    changedFiles: pull.changed_files ?? files.length,
    additions: pull.additions ?? files.reduce((n, f) => n + f.additions, 0),
    deletions: pull.deletions ?? files.reduce((n, f) => n + f.deletions, 0),
    issueComments: pull.comments ?? 0,
    reviewComments: pull.review_comments ?? 0,
    createdAt: pull.created_at || null,
    authorAvatar: pull.user?.avatar_url || null,
    author: pull.user?.login,
    headSha: pull.head.sha,
    baseSha,
    headRef: pull.head.ref,
    baseRef: pull.base.ref,
    // every changed file, for the file tree (GitHub shows them all); only markdown gets reviewed here
    allFiles: files.map((f) => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions })),
    files: files
      .filter((f) => MD_RE.test(f.filename) && f.status !== 'removed')
      .map((f) => ({
        filename: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        previous: f.previous_filename || null,
        patch: f.patch ?? null,
      })),
  };
}

async function apiFile(q) {
  const { owner, repo } = repoParams(q);
  const file = q.get('path') || '';
  const ref = q.get('ref') || '';
  if (!file || file.includes('..') || !/^[0-9a-f]{7,64}$/i.test(ref)) throw new HttpError(400, 'bad path/ref');
  const enc = file.split('/').map(encodeURIComponent).join('/');
  return gh(`/repos/${owner}/${repo}/contents/${enc}?ref=${ref}`, { accept: 'application/vnd.github.raw+json' });
}

const IMG = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.avif': 'image/avif', '.bmp': 'image/bmp', '.ico': 'image/x-icon' };

// Images referenced by relative path from a markdown file, served from the PR's head commit.
async function apiRaw(q) {
  const { owner, repo } = repoParams(q);
  const file = q.get('path') || '';
  const ref = q.get('ref') || '';
  const type = IMG[path.extname(file).toLowerCase()];
  if (!file || file.includes('..') || !/^[0-9a-f]{7,64}$/i.test(ref) || !type) throw new HttpError(400, 'bad path/ref (images only)');
  const enc = file.split('/').map(encodeURIComponent).join('/');
  const data = await gh(`/repos/${owner}/${repo}/contents/${enc}?ref=${ref}`, { accept: 'application/vnd.github.raw+json', binary: true });
  return { type, data };
}

async function apiReview(body) {
  const { owner, repo, number, review } = body || {};
  if (!NAME_RE.test(owner || '') || !NAME_RE.test(repo || '') || !Number.isInteger(number)) throw new HttpError(400, 'bad request');
  if (!['COMMENT', 'APPROVE', 'REQUEST_CHANGES'].includes(review?.event)) throw new HttpError(400, 'bad event');
  const out = await ghJson(`/repos/${owner}/${repo}/pulls/${number}/reviews`, { method: 'POST', body: review });
  return { id: out.id, url: out.html_url, state: out.state };
}

async function apiReply(body) {
  const { owner, repo, number, commentId, text } = body || {};
  if (!NAME_RE.test(owner || '') || !NAME_RE.test(repo || '') || !Number.isInteger(number) || !Number.isInteger(commentId)) throw new HttpError(400, 'bad request');
  if (typeof text !== 'string' || !text.trim() || text.length > 65536) throw new HttpError(400, 'empty or too long reply');
  const out = await ghJson(`/repos/${owner}/${repo}/pulls/${number}/comments/${commentId}/replies`, { method: 'POST', body: { body: text } });
  return compact(out);
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

// Diagram renderers are optional dependencies, served from node_modules when installed.
const NM = path.join(path.dirname(fileURLToPath(import.meta.url)), 'node_modules');
const VENDOR = {
  '/vendor/github-markdown.css': path.join(NM, 'github-markdown-css', 'github-markdown.css'),
  '/vendor/hljs.js': path.join(NM, '@highlightjs', 'cdn-assets', 'highlight.min.js'),
  '/vendor/hljs-light.css': path.join(NM, '@highlightjs', 'cdn-assets', 'styles', 'github.min.css'),
  '/vendor/hljs-dark.css': path.join(NM, '@highlightjs', 'cdn-assets', 'styles', 'github-dark.min.css'),
  '/vendor/purify.js': path.join(NM, 'dompurify', 'dist', 'purify.min.js'),
  '/vendor/d2.js': path.join(NM, '@terrastruct', 'd2', 'dist', 'browser', 'index.js'),
  '/vendor/mermaid.js': path.join(NM, 'mermaid', 'dist', 'mermaid.min.js'),
};

function serveStatic(req, res) {
  const url = new URL(req.url, 'http://x');
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const vendor = Object.hasOwn(VENDOR, rel) ? VENDOR[rel] : null;
  const file = vendor || path.normalize(path.join(ROOT, rel));
  if ((!vendor && !file.startsWith(ROOT + path.sep)) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    // a linkable PR path like /github.com/o/r/7@abc1234 is the single-page app; a missing asset stays a 404
    if (!path.extname(rel) && !rel.startsWith('/api/') && !rel.startsWith('/vendor/')) {
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
      fs.createReadStream(path.join(ROOT, 'index.html')).pipe(res);
      return;
    }
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 2_000_000) {
        reject(new HttpError(413, 'body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new HttpError(400, 'invalid json'));
      }
    });
    req.on('error', reject);
  });
}

const HOST_OK = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

const server = http.createServer(async (req, res) => {
  const send = (status, body, type = 'application/json') => {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
  try {
    // Defend the local token against DNS rebinding and cross-site requests.
    if (!HOST_OK.test(req.headers.host || '')) throw new HttpError(403, 'bad host');
    const url = new URL(req.url, 'http://x');
    if (!url.pathname.startsWith('/api/')) return serveStatic(req, res);
    if (req.method === 'POST' && req.headers['x-rico'] !== '1') throw new HttpError(403, 'missing X-Rico header');
    if (req.method === 'GET' && url.pathname === '/api/pr') return send(200, await apiPr(url.searchParams));
    if (req.method === 'GET' && url.pathname === '/api/raw') {
      const { type, data } = await apiRaw(url.searchParams);
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'private, max-age=300', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'", 'X-Content-Type-Options': 'nosniff' });
      return res.end(data);
    }
    if (req.method === 'GET' && url.pathname === '/api/file') return send(200, await apiFile(url.searchParams), 'text/plain; charset=utf-8');
    if (req.method === 'POST' && url.pathname === '/api/review') return send(200, await apiReview(await readJson(req)));
    if (req.method === 'POST' && url.pathname === '/api/reply') return send(200, await apiReply(await readJson(req)));
    throw new HttpError(404, 'not found');
  } catch (e) {
    send(e.status || 500, { error: e.message || String(e) });
  }
});

const argPort = process.argv.indexOf('--port');
const port = Number(argPort > 0 ? process.argv[argPort + 1] : process.env.PORT || 4317);
server.listen(port, '127.0.0.1', () => {
  console.log(`Rico running at http://localhost:${port}`);
  if (!process.env.GITHUB_TOKEN && !process.env.GH_TOKEN) console.log('Using `gh auth token` for GitHub access (or set GITHUB_TOKEN).');
});
