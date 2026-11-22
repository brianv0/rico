// The GitHub half of Rico, shared by the local Node server and the Cloudflare Worker.
// Web-standard APIs only (fetch, Uint8Array): no Node built-ins, so it runs in both.
import { parsePrRef } from '../public/lib.js';
import { fetchIcon } from './icon.js';

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
  nodeId: c.node_id || null,
  updatedAt: c.updated_at || c.created_at || null,
  reactions: restReactions(c.reactions),
});

// GitHub's reaction names: REST uses '+1', GraphQL uses THUMBS_UP.
export const REACTIONS = { '+1': 'THUMBS_UP', '-1': 'THUMBS_DOWN', laugh: 'LAUGH', hooray: 'HOORAY', confused: 'CONFUSED', heart: 'HEART', rocket: 'ROCKET', eyes: 'EYES' };
const REACTION_REST = Object.fromEntries(Object.entries(REACTIONS).map(([k, v]) => [v, k]));
function restReactions(r) {
  if (!r) return [];
  return Object.keys(REACTIONS).filter((k) => r[k] > 0).map((k) => ({ content: k, count: r[k], mine: false }));
}

const compactIssue = (c) => ({
  id: c.id,
  user: c.user?.login || 'ghost',
  body: c.body || '',
  createdAt: c.created_at,
  updatedAt: c.updated_at || c.created_at,
  url: c.html_url,
  avatar: c.user?.avatar_url || null,
  assoc: c.author_association || null,
  nodeId: c.node_id || null,
  reactions: restReactions(c.reactions),
});

const PENDING_Q = `query($owner:String!,$repo:String!,$number:Int!){
  repository(owner:$owner,name:$repo){pullRequest(number:$number){id reviews(first:5,states:PENDING){nodes{id databaseId viewerDidAuthor}}}}}`;

const THREADS_Q = `query($owner:String!,$repo:String!,$number:Int!,$after:String){
  viewer{login}
  repository(owner:$owner,name:$repo){pullRequest(number:$number){
    id
    reviews(first:5,states:PENDING){nodes{id databaseId viewerDidAuthor}}
    reviewThreads(first:100,after:$after){pageInfo{hasNextPage endCursor}
      nodes{id path line originalLine startLine originalStartLine diffSide startDiffSide isResolved isOutdated viewerCanResolve viewerCanUnresolve viewerCanReply
        comments(first:100){nodes{id databaseId state lastEditedAt body createdAt updatedAt url authorAssociation author{login avatarUrl} replyTo{databaseId} viewerCanUpdate viewerCanDelete viewerCanReact reactionGroups{content viewerHasReacted reactors{totalCount}}}}}}
  }}}`;

const PR_FIELDS = '... on PullRequest{number title state isDraft updatedAt author{login} repository{nameWithOwner}}';
const PR_ONE_Q = `query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){number title state isDraft updatedAt author{login} repository{nameWithOwner}}}}`;

/** A GraphQL search string may carry user text: keep words, '#', '/', '.', '-' and drop qualifier syntax (':', quotes). */
const searchText = (t) => String(t || '').replace(/[^\w .#/-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);

const prItem = (n) => {
  const [owner, repo] = (n.repository?.nameWithOwner || '').split('/');
  return { owner, repo, number: n.number, title: n.title, state: n.state, draft: !!n.isDraft, author: n.author?.login || null, updatedAt: n.updatedAt };
};

/**
 * @param {{ getToken: () => string, apiUrl?: string, readOnly?: boolean }} opts  readOnly: preview mode, never use the token's own permissions or pending reviews.  getToken may throw an HttpError(401) when signed out.
 */
export function createGithub({ getToken, apiUrl = 'https://api.github.com', readOnly = false }) {
  const API = apiUrl.replace(/\/$/, '');

  async function gh(apiPath, { method = 'GET', body, accept, binary = false, etag, raw = false } = {}) {
    const res = await fetch(API + apiPath, {
      method,
      headers: {
        ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}), // no token: anonymous (preview) requests
        Accept: accept || 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'rico',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(etag ? { 'If-None-Match': etag } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (raw && res.status === 304) return { status: 304, etag, text: '' };
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
    if (raw) return { status: res.status, etag: res.headers.get('ETag') || '', text };
    return binary ? buf : text;
  }
  async function gql(query, variables) {
    const out = JSON.parse(await gh('/graphql', { method: 'POST', body: { query, variables } }));
    if (out.errors?.length) { // GraphQL reports refusals in the body, not the status
      const msg = out.errors.map((e) => e.message).join('; ');
      throw new HttpError(/not accessible|forbidden|permission|locked/i.test(msg) ? 403 : 422, 'GitHub: ' + msg);
    }
    return out.data;
  }
  /** GraphQL where some parts may be missing (a repo that does not exist): keep the data that resolved. */
  async function gqlPartial(query, variables) {
    const out = JSON.parse(await gh('/graphql', { method: 'POST', body: { query, variables } }));
    if (!out.data) throw new HttpError(422, 'GitHub: ' + (out.errors || []).map((e) => e.message).join('; '));
    return out.data;
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

  async function pages(p) {
    const all = [];
    for (let page = 1; page <= 30; page++) {
      const batch = await ghJson(`${p}${p.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      all.push(...batch);
      if (batch.length < 100) break;
    }
    return all;
  }

  /** Review threads, the viewer's pending review and per-comment permissions, via GraphQL (null when unavailable). */
  async function graph(owner, repo, number) {
    if (readOnly || !getToken()) return null;
    try {
      const threads = [];
      let pending = null;
      let viewer = null;
      let prId = null;
      let after = null;
      for (let i = 0; i < 5; i++) {
        const d = await gql(THREADS_Q, { owner, repo, number, after });
        const pr = d.repository.pullRequest;
        viewer = d.viewer.login;
        prId = pr.id;
        pending = pending || pr.reviews.nodes.find((r) => r.viewerDidAuthor) || null;
        threads.push(...pr.reviewThreads.nodes);
        if (!pr.reviewThreads.pageInfo.hasNextPage) break;
        after = pr.reviewThreads.pageInfo.endCursor;
      }
      return { viewer, prId, pending, threads };
    } catch {
      return null; // GraphQL blocked or unavailable: fall back to what REST can tell us
    }
  }

  /**
   * Candidate PRs for the Load PR box's autocomplete, from one GraphQL request. The browser ranks and merges them.
   *   (nothing)            the viewer's own PRs (involves:@me) and those waiting for their review: the pool most typing is matched against
   *   repo=o/r [&text=]    PRs of that repo; with number=N also that exact PR, whatever its age
   *   owner=o [&text=]     PRs in repos of that user or org
   *   text=…               PRs whose title matches, anywhere
   */
  async function apiSuggest(q) {
    if (readOnly || !getToken()) throw new HttpError(401, 'Sign in with GitHub to search pull requests.');
    const name = q.get('name');
    if (name) { // "formwork#47": that PR in the viewer's own repo of that name, and in each candidate owner's
      const number = Number(q.get('number'));
      const owners = String(q.get('owners') || '').split(',').filter(Boolean).slice(0, 4);
      if (!NAME_RE.test(name) || !(number > 0) || !owners.every((o) => NAME_RE.test(o))) throw new HttpError(400, 'bad name lookup');
      const pr = `pullRequest(number:$n){number title state isDraft updatedAt author{login} repository{nameWithOwner}}`;
      const body = [`me:viewer{repository(name:$name){${pr}}}`, ...owners.map((_, i) => `o${i}:repository(owner:$o${i},name:$name){${pr}}`)].join(' ');
      const decl = ['$name:String!', '$n:Int!', ...owners.map((_, i) => `$o${i}:String!`)].join(',');
      const d = await gqlPartial(`query(${decl}){${body}}`, { name, n: number, ...Object.fromEntries(owners.map((o, i) => ['o' + i, o])) });
      const seen = new Set();
      const items = [];
      for (const v of Object.values(d)) {
        const n = (v?.repository || v)?.pullRequest;
        if (n && !seen.has(n.repository.nameWithOwner)) { seen.add(n.repository.nameWithOwner); items.push(prItem(n)); }
      }
      return { items };
    }
    const text = searchText(q.get('text'));
    const repo = q.get('repo');
    const owner = q.get('owner');
    const sort = 'sort:updated-desc';
    let queries;
    if (repo) {
      const [o, r] = repo.split('/');
      if (!NAME_RE.test(o || '') || !NAME_RE.test(r || '')) throw new HttpError(400, 'bad repo');
      queries = [`is:pr repo:${o}/${r} ${text} ${sort}`];
    } else if (owner) {
      if (!NAME_RE.test(owner)) throw new HttpError(400, 'bad owner');
      queries = [`is:pr user:${owner} ${text} ${sort}`];
    } else if (text) queries = [`is:pr in:title ${text} ${sort}`];
    else queries = [`is:pr involves:@me ${sort}`, `is:pr review-requested:@me ${sort}`];
    const vars = Object.fromEntries(queries.map((s, i) => ['q' + i, s]));
    const decl = queries.map((_, i) => `$q${i}:String!`).join(',');
    const body = queries.map((_, i) => `s${i}:search(query:$q${i},type:ISSUE,first:${text || repo || owner ? 10 : 30}){nodes{${PR_FIELDS}}}`).join(' ');
    const exact = repo && /^\d+$/.test(q.get('number') || '') ? Number(q.get('number')) : 0;
    const [d, one] = await Promise.all([
      gql(`query(${decl}){${body}}`, vars),
      exact && NAME_RE.test(repo.split('/')[0]) ? gql(PR_ONE_Q, { owner: repo.split('/')[0], repo: repo.split('/')[1], number: exact }).catch(() => null) : null,
    ]);
    const items = [];
    if (one?.repository?.pullRequest) items.push(prItem(one.repository.pullRequest));
    for (const k of Object.keys(d)) for (const n of d[k].nodes) if (n?.number) items.push(prItem(n));
    return { items };
  }

  /** Review comments (markdown files only), PR-level comments, and who may do what with them. */
  async function loadComments(owner, repo, number) {
    const base = `/repos/${owner}/${repo}`;
    const [rc, ic, g] = await Promise.all([pages(`${base}/pulls/${number}/comments`), pages(`${base}/issues/${number}/comments`).catch(() => []), graph(owner, repo, number)]);
    let viewer = g?.viewer || null;
    if (!viewer && !readOnly && getToken()) viewer = await apiMe().then((m) => m.login).catch(() => null);
    const caps = new Map();
    const threadOf = new Map();
    for (const t of g?.threads || []) {
      const first = t.comments.nodes[0]?.databaseId;
      if (first) threadOf.set(first, { id: t.id, resolved: t.isResolved, canResolve: t.viewerCanResolve, canUnresolve: t.viewerCanUnresolve, canReply: t.viewerCanReply });
      for (const n of t.comments.nodes) caps.set(n.databaseId, n);
    }
    const comments = rc.filter((c) => MD_RE.test(c.path || '')).map((c) => {
      const out = compact(c);
      const n = caps.get(c.id);
      out.canUpdate = n ? n.viewerCanUpdate : !!viewer && out.user === viewer;
      out.canDelete = n ? n.viewerCanDelete : !!viewer && out.user === viewer;
      if (n) {
        out.pending = n.state === 'PENDING';
        out.edited = !!n.lastEditedAt; // GitHub bumps updated_at when a review is submitted; only a real edit sets lastEditedAt
        out.reactions = n.reactionGroups.filter((r) => r.reactors.totalCount > 0).map((r) => ({ content: REACTION_REST[r.content], count: r.reactors.totalCount, mine: r.viewerHasReacted }));
      }
      if (threadOf.has(c.id)) out.thread = threadOf.get(c.id);
      return out;
    });
    // GitHub's REST list leaves the viewer's own PENDING review comments out (like the by-id read): add them from GraphQL, so a
    // pending review started here, on another device or on github.com shows up and survives a reload or a refresh.
    const haveIds = new Set(rc.map((c) => c.id));
    for (const t of g?.threads || []) {
      if (!MD_RE.test(t.path || '')) continue;
      for (const n of t.comments.nodes) {
        if (n.state !== 'PENDING' || haveIds.has(n.databaseId)) continue;
        const out = compact({
          id: n.databaseId, in_reply_to_id: n.replyTo?.databaseId ?? null, path: t.path, line: t.line, original_line: t.originalLine, start_line: t.startLine, original_start_line: t.originalStartLine,
          side: t.diffSide, user: { login: n.author?.login, avatar_url: n.author?.avatarUrl }, body: n.body, created_at: n.createdAt, updated_at: n.updatedAt, html_url: n.url, author_association: n.authorAssociation, node_id: n.id,
        });
        out.pending = true;
        out.canUpdate = n.viewerCanUpdate;
        out.canDelete = n.viewerCanDelete;
        out.edited = !!n.lastEditedAt;
        out.reactions = [];
        if (threadOf.has(n.databaseId)) out.thread = threadOf.get(n.databaseId);
        comments.push(out);
      }
    }
    const prComments = ic.map((c) => ({ ...compactIssue(c), canUpdate: !!viewer && (c.user?.login === viewer), canDelete: !!viewer && (c.user?.login === viewer) }));
    return { comments, prComments, viewer, pendingReview: g?.pending ? { id: g.pending.id, databaseId: g.pending.databaseId } : null, canThread: !!g };
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
    const loaded = await loadComments(owner, repo, number);
    return {
      owner,
      repo,
      number,
      ...loaded,
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


  // ---- writes: every one is a POST from the browser, the token stays here ----
  const SIDES = ['LEFT', 'RIGHT'];
  function ref(body) {
    const { owner, repo, number } = body || {};
    if (!NAME_RE.test(owner || '') || !NAME_RE.test(repo || '') || !Number.isInteger(number)) throw new HttpError(400, 'bad request');
    return { owner, repo, number };
  }
  function text(body) {
    if (typeof body !== 'string' || !body.trim() || body.length > 65536) throw new HttpError(400, 'empty or too long comment');
    return body;
  }
  /** Allow-list a review-comment payload: only what GitHub's API takes for a line comment. */
  function lineComment(c) {
    if (!c || typeof c.path !== 'string' || !c.path || c.path.includes('..') || !Number.isInteger(c.line) || c.line < 1 || !/^[0-9a-f]{7,64}$/i.test(c.commit_id || '')) throw new HttpError(400, 'bad comment');
    const side = SIDES.includes(c.side) ? c.side : 'RIGHT';
    const out = { commit_id: c.commit_id, path: c.path, line: c.line, side, body: text(c.body) };
    if (c.start_line != null) {
      if (!Number.isInteger(c.start_line) || c.start_line < 1 || c.start_line >= c.line) throw new HttpError(400, 'bad range');
      out.start_line = c.start_line;
      out.start_side = SIDES.includes(c.start_side) ? c.start_side : side;
    }
    return out;
  }
  const cid = (b) => { if (!Number.isInteger(b?.commentId)) throw new HttpError(400, 'bad comment id'); return b.commentId; };
  const kindPath = (b) => (b?.kind === 'issue' ? 'issues' : 'pulls');

  async function apiComment(b) {
    const { owner, repo, number } = ref(b);
    return compact(await ghJson(`/repos/${owner}/${repo}/pulls/${number}/comments`, { method: 'POST', body: lineComment(b.comment) }));
  }
  async function apiPrComment(b) {
    const { owner, repo, number } = ref(b);
    return compactIssue(await ghJson(`/repos/${owner}/${repo}/issues/${number}/comments`, { method: 'POST', body: { body: text(b.text) } }));
  }
  async function apiEdit(b) {
    const { owner, repo } = ref(b);
    if (b.pending === true) { // pending review comments are hidden from REST (PATCH is a 404): edit them through GraphQL
      if (typeof b.nodeId !== 'string' || !/^[\w=-]{4,100}$/.test(b.nodeId)) throw new HttpError(400, 'bad node id');
      const d = await gql('mutation($id:ID!,$b:String!){updatePullRequestReviewComment(input:{pullRequestReviewCommentId:$id,body:$b}){pullRequestReviewComment{databaseId body updatedAt}}}', { id: b.nodeId, b: text(b.text) });
      const c = d.updatePullRequestReviewComment.pullRequestReviewComment;
      return { id: c.databaseId, body: c.body, updatedAt: c.updatedAt, edited: true };
    }
    const out = await ghJson(`/repos/${owner}/${repo}/${kindPath(b)}/comments/${cid(b)}`, { method: 'PATCH', body: { body: text(b.text) } });
    return b.kind === 'issue' ? compactIssue(out) : compact(out);
  }
  async function apiDelete(b) {
    const { owner, repo } = ref(b);
    await gh(`/repos/${owner}/${repo}/${kindPath(b)}/comments/${cid(b)}`, { method: 'DELETE' });
    return { ok: true };
  }
  async function apiResolve(b) {
    if (typeof b?.threadId !== 'string' || !/^[\w=-]{4,100}$/.test(b.threadId)) throw new HttpError(400, 'bad thread id');
    const op = b.resolved ? 'resolveReviewThread' : 'unresolveReviewThread';
    const d = await gql(`mutation($id:ID!){${op}(input:{threadId:$id}){thread{id isResolved viewerCanResolve viewerCanUnresolve}}}`, { id: b.threadId });
    const t = d[op].thread;
    return { id: t.id, resolved: t.isResolved, canResolve: t.viewerCanResolve, canUnresolve: t.viewerCanUnresolve };
  }
  async function apiReact(b) {
    const { owner, repo } = ref(b);
    if (!Object.hasOwn(REACTIONS, b?.content)) throw new HttpError(400, 'bad reaction');
    const id = cid(b);
    if (b.remove) { // un-react by node id (REST would need the reaction's own id)
      if (typeof b.nodeId !== 'string' || !/^[\w=-]{4,100}$/.test(b.nodeId)) throw new HttpError(400, 'bad node id');
      await gql('mutation($id:ID!,$c:ReactionContent!){removeReaction(input:{subjectId:$id,content:$c}){reaction{content}}}', { id: b.nodeId, c: REACTIONS[b.content] });
      return { ok: true };
    }
    await gh(`/repos/${owner}/${repo}/${kindPath(b)}/comments/${id}/reactions`, { method: 'POST', body: { content: b.content } });
    return { ok: true };
  }

  // ---- a real GitHub pending review (GraphQL): "Start a review" / "Finish review" ----
  async function pendingState(owner, repo, number) {
    const g = await gql(PENDING_Q, { owner, repo, number }).catch(() => null);
    const pr = g?.repository?.pullRequest;
    if (!pr) throw new HttpError(502, 'GitHub: could not read the pull request (GraphQL)');
    return { prId: pr.id, review: pr.reviews.nodes.find((r) => r.viewerDidAuthor) || null };
  }
  async function apiPendingAdd(b) {
    const { owner, repo, number } = ref(b);
    const c = lineComment(b.comment);
    let { prId, review } = await pendingState(owner, repo, number);
    if (!review) { // GitHub allows one pending review per user per PR: reuse it when there is one
      const d = await gql('mutation($pr:ID!,$sha:GitObjectID){addPullRequestReview(input:{pullRequestId:$pr,commitOID:$sha}){pullRequestReview{id databaseId}}}', { pr: prId, sha: c.commit_id });
      review = d.addPullRequestReview.pullRequestReview;
    }
    // GitHub hides pending comments from the REST comments endpoints (a read-back by id is a 404), so the comment shown in the
    // margin is built from what the mutation itself returns.
    const d = await gql(
      `mutation($r:ID!,$path:String!,$line:Int!,$side:DiffSide!,$sl:Int,$ss:DiffSide,$body:String!){
        addPullRequestReviewThread(input:{pullRequestReviewId:$r,path:$path,line:$line,side:$side,startLine:$sl,startSide:$ss,body:$body}){thread{
          id path line originalLine startLine originalStartLine diffSide startDiffSide
          comments(first:1){nodes{id databaseId body path createdAt url authorAssociation author{login avatarUrl}}}}}}`,
      { r: review.id, path: c.path, line: c.line, side: c.side, sl: c.start_line ?? null, ss: c.start_side ?? null, body: c.body },
    );
    const t = d.addPullRequestReviewThread.thread;
    const n = t.comments.nodes[0];
    const out = compact({
      id: n.databaseId, path: n.path || t.path, line: t.line, original_line: t.originalLine, start_line: t.startLine, original_start_line: t.originalStartLine,
      side: t.diffSide, user: { login: n.author?.login, avatar_url: n.author?.avatarUrl }, body: n.body, created_at: n.createdAt, html_url: n.url, author_association: n.authorAssociation, node_id: n.id,
    });
    out.pending = true;
    out.canUpdate = out.canDelete = true;
    return { comment: out, review: { id: review.id, databaseId: review.databaseId ?? null } };
  }
  async function apiPendingFinish(b) {
    const { owner, repo, number } = ref(b);
    const event = b?.event;
    if (!['COMMENT', 'APPROVE', 'REQUEST_CHANGES'].includes(event)) throw new HttpError(400, 'bad event');
    const body = typeof b.body === 'string' ? b.body : '';
    const { review } = await pendingState(owner, repo, number);
    if (!review) { // nothing pending: a verdict on its own is a plain review
      const out = await ghJson(`/repos/${owner}/${repo}/pulls/${number}/reviews`, { method: 'POST', body: { event, ...(body.trim() ? { body } : {}) } });
      return { id: out.id, url: out.html_url, state: out.state };
    }
    const d = await gql('mutation($r:ID!,$e:PullRequestReviewEvent!,$b:String){submitPullRequestReview(input:{pullRequestReviewId:$r,event:$e,body:$b}){pullRequestReview{databaseId url state}}}', { r: review.id, e: event, b: body });
    const r = d.submitPullRequestReview.pullRequestReview;
    return { id: r.databaseId, url: r.url, state: r.state };
  }
  async function apiPendingDiscard(b) {
    const { owner, repo, number } = ref(b);
    const { review } = await pendingState(owner, repo, number);
    if (review) await gql('mutation($r:ID!){deletePullRequestReview(input:{pullRequestReviewId:$r}){pullRequestReview{id}}}', { r: review.id });
    return { ok: true };
  }

  // ---- live refresh: conditional requests, so an unchanged PR costs nothing against the rate limit ----
  async function apiRefresh(q) {
    const { owner, repo } = repoParams(q);
    const number = Number(q.get('number'));
    if (!Number.isInteger(number) || number < 1) throw new HttpError(400, 'bad number');
    let known = {};
    try { known = JSON.parse(q.get('etags') || '{}') || {}; } catch { /* first poll */ }
    const base = `/repos/${owner}/${repo}`;
    const probes = {
      pull: `${base}/pulls/${number}`,
      rc: `${base}/pulls/${number}/comments?per_page=100&sort=updated&direction=desc`,
      ic: `${base}/issues/${number}/comments?per_page=100`,
    };
    const got = {};
    await Promise.all(Object.entries(probes).map(async ([k, p]) => { got[k] = await gh(p, { raw: true, etag: typeof known[k] === 'string' ? known[k] : undefined }); }));
    const etags = Object.fromEntries(Object.entries(got).map(([k, r]) => [k, r.etag || '']));
    if (Object.values(got).every((r) => r.status === 304)) return { unchanged: true, etags };
    const out = { unchanged: false, etags, ...(await loadComments(owner, repo, number)) };
    if (got.pull.status !== 304) out.headSha = JSON.parse(got.pull.text).head?.sha || null;
    return out;
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
      if (method === 'GET' && p === '/api/suggest') return j(200, await apiSuggest(url.searchParams));
      if (method === 'GET' && p === '/api/pr') return j(200, await apiPr(url.searchParams));
      if (method === 'GET' && p === '/api/raw') {
        const { type, data } = await apiRaw(url.searchParams);
        return new Response(data, { status: 200, headers: { 'Content-Type': type, 'Cache-Control': 'private, max-age=300', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'", 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff' } });
      }
      if (method === 'GET' && p === '/api/icon') { // a D2 icon, fetched for the sandboxed diagram (see src/icon.js)
        const { type, data } = await fetchIcon(url.searchParams.get('u'));
        return new Response(data, { status: 200, headers: { 'Content-Type': type, 'Cache-Control': 'public, max-age=86400', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'", 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff' } });
      }
      if (method === 'GET' && p === '/api/file') return new Response(await apiFile(url.searchParams), { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
      if (method === 'POST' && p === '/api/review') return j(200, await apiReview(await readBody()));
      if (method === 'POST' && p === '/api/reply') return j(200, await apiReply(await readBody()));
      if (method === 'GET' && p === '/api/comments') return j(200, await apiRefresh(url.searchParams));
      const posts = { '/api/comment': apiComment, '/api/pr-comment': apiPrComment, '/api/comment/edit': apiEdit, '/api/comment/delete': apiDelete, '/api/thread/resolve': apiResolve, '/api/reaction': apiReact, '/api/pending/add': apiPendingAdd, '/api/pending/finish': apiPendingFinish, '/api/pending/discard': apiPendingDiscard };
      if (method === 'POST' && Object.hasOwn(posts, p)) return j(200, await posts[p](await readBody()));
      throw new HttpError(404, 'not found');
    } catch (e) {
      return j(e.status || 500, { error: e.message || String(e), ...(e.extra || {}) });
    }
  }

  return { route };
}
