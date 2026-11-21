// The GitHub half of Rico, shared by the local Node server and the Cloudflare Worker.
// Web-standard APIs only (fetch, Uint8Array): no Node built-ins, so it runs in both.
import { parsePrRef } from '../public/lib.js';

const MD_RE = /\.(md|markdown|mdown|mdx)$/i;
// '.' and '..' as owner/repo would normalise away in the API path (fetch collapses dot segments),
// letting a crafted ref escape the /repos/{owner}/{repo}/ prefix.
const NAME_RE = /^(?!\.+$)[\w.-]+$/;
const IMG = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon' };

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
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

/**
 * @param {{ getToken: () => string, apiUrl?: string }} opts  getToken may throw an HttpError(401) when signed out.
 */
export function createGithub({ getToken, apiUrl = 'https://api.github.com' }) {
  const API = apiUrl.replace(/\/$/, '');

  async function gh(apiPath, { method = 'GET', body, accept, binary = false } = {}) {
    const res = await fetch(API + apiPath, {
      method,
      headers: {
        ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}), // no token: anonymous (preview) requests
        Accept: accept || 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'rico',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const buf = binary && res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
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
      const keep = [401, 403, 404, 422].includes(res.status);
      throw new HttpError(keep ? res.status : 502, `GitHub: ${msg}`);
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

  async function apiMe() {
    const u = await ghJson('/user');
    return { login: u.login, avatar: u.avatar_url || null };
  }

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
      isPrivate: !!pull.base?.repo?.private,
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

  const encPath = (file) => file.split('/').map(encodeURIComponent).join('/');

  async function apiFile(q) {
    const { owner, repo } = repoParams(q);
    const file = q.get('path') || '';
    const ref = q.get('ref') || '';
    if (!file || file.includes('..') || !/^[0-9a-f]{7,64}$/i.test(ref)) throw new HttpError(400, 'bad path/ref');
    return gh(`/repos/${owner}/${repo}/contents/${encPath(file)}?ref=${ref}`, { accept: 'application/vnd.github.raw+json' });
  }

  // Images referenced by relative path from a markdown file, served from the PR's head commit.
  async function apiRaw(q) {
    const { owner, repo } = repoParams(q);
    const file = q.get('path') || '';
    const ref = q.get('ref') || '';
    const type = IMG[(file.split('.').pop() || '').toLowerCase()];
    if (!file || file.includes('..') || !/^[0-9a-f]{7,64}$/i.test(ref) || !type) throw new HttpError(400, 'bad path/ref (images only)');
    const data = await gh(`/repos/${owner}/${repo}/contents/${encPath(file)}?ref=${ref}`, { accept: 'application/vnd.github.raw+json', binary: true });
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

  /**
   * Route one /api request. Returns a Response (so the Node server and the Worker share all of this).
   * `readBody` parses the JSON body of a POST.
   */
  async function route(method, url, readBody) {
    const j = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    try {
      const p = url.pathname;
      if (method === 'GET' && p === '/api/me') return j(200, await apiMe());
      if (method === 'GET' && p === '/api/pr') return j(200, await apiPr(url.searchParams));
      if (method === 'GET' && p === '/api/raw') {
        const { type, data } = await apiRaw(url.searchParams);
        return new Response(data, { status: 200, headers: { 'Content-Type': type, 'Cache-Control': 'private, max-age=300', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'", 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff' } });
      }
      if (method === 'GET' && p === '/api/file') return new Response(await apiFile(url.searchParams), { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
      if (method === 'POST' && p === '/api/review') return j(200, await apiReview(await readBody()));
      if (method === 'POST' && p === '/api/reply') return j(200, await apiReply(await readBody()));
      throw new HttpError(404, 'not found');
    } catch (e) {
      return j(e.status || 500, { error: e.message || String(e), ...(e.extra || {}) });
    }
  }

  return { route };
}
