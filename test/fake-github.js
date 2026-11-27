// A tiny fake of the GitHub REST endpoints Rico uses. Shared by the server tests and the e2e run.
import http from 'node:http';
import fs from 'node:fs';

export const COMPLEX = fs.readFileSync(new URL('./fixtures/complex.md', import.meta.url), 'utf8');
export const DIAGRAMS = fs.readFileSync(new URL('./fixtures/diagrams.md', import.meta.url), 'utf8');
const DIAGRAM_LINES = DIAGRAMS.replace(/\n$/, '').split('\n');
const DIAGRAM_PATCH = `@@ -0,0 +1,${DIAGRAM_LINES.length} @@\n` + DIAGRAM_LINES.map((l) => '+' + l).join('\n');
export const GITHUBMD = fs.readFileSync(new URL('./fixtures/github.md', import.meta.url), 'utf8');
const GH_LINES = GITHUBMD.replace(/\n$/, '').split('\n');
const GH_PATCH = `@@ -0,0 +1,${GH_LINES.length} @@\n` + GH_LINES.map((l) => '+' + l).join('\n');
const COMPLEX_LINES = COMPLEX.replace(/\n$/, '').split('\n');
const COMPLEX_PATCH = `@@ -0,0 +1,${COMPLEX_LINES.length} @@\n` + COMPLEX_LINES.map((l) => '+' + l).join('\n');
export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');
// a real 1x1 PNG as a data: URL, so avatars never trigger a request
export const AVATAR = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
export const SHA = 'abc1234def5678';
// GitHub diffs against the merge base, which is not the base branch tip: keep them different on purpose
export const BASE_SHA = 'bbbb2222cccc3333';
export const MERGE_BASE = 'dddd0000eeee1111';
const fx = (n) => fs.readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');
export const REMOVED_NEW = fx('removed.new.md');
export const REMOVED_OLD = fx('removed.old.md');
export const REMOVED_PATCH = fx('removed.patch');
export const PLAN_OLD = fx('plan.old.md');
export const FILE = [
  '# Plan', '', 'First paragraph here.', '', 'Second paragraph is hard wrapped', 'across two lines for testing.', '',
  '- item one', '- item two', '', '```js', 'const a = 1;', 'const b = 2;', '```', '', 'Far away paragraph outside the diff.', '',
].join('\n');
export const PATCH = [
  '@@ -1,8 +1,10 @@', ' # Plan', '-Old subtitle that was removed', ' ', '+First paragraph here.', ' ', '+Second paragraph is hard wrapped',
  '+across two lines for testing.', ' ', ' - item one', ' - item two', ' ',
  '@@ -11,2 +12,3 @@', ' const a = 1;', '+const b = 2;', ' ```',
].join('\n');

// A second PR, laid out the way Spec Kit writes a feature: plan.md and tasks.md change; spec.md and the constitution do not.
export const SHA8 = 'a8a8a8a8a8a8a8';
export const BASE8 = 'b8b8b8b8b8b8b8';
export const SPEC8 = [
  '# Feature Specification: Login', '', '### User Story 1 - Sign in with a password (Priority: P1)', '', 'A user can sign in.', '', '## Requirements', '',
  '- **FR-001**: System MUST accept an email and password.', '- **FR-002**: System MUST lock the account after five failures.',
  '- **FR-003**: System MUST support [NEEDS CLARIFICATION: SSO, OAuth or neither?]', '', '- **SC-001**: Users sign in within two seconds.', '',
].join('\n');
export const PLAN8 = [
  '# Implementation Plan: Login', '', '**Language**: TypeScript or [NEEDS CLARIFICATION: Go?]', '', 'This plan covers FR-001 and FR-002 using a session cookie.', '',
  '## Constitution Check', '', 'Follows the project rules.', '',
].join('\n');
export const TASKS8 = [
  '# Tasks: Login', '', '## Phase 1: Setup', '', '- [ ] T001 Create the project in src/', '- [ ] T002 [P] Configure linting', '',
  '## Phase 2: User Story 1', '', '- [ ] T010 [US1] Write the login test in tests/login.test.ts (FR-001)', '- [ ] T011 [US1] Implement login in src/login.ts after T010', '',
].join('\n');
export const CHECKLIST8 = '# Specification Quality Checklist\n\n- [x] Requirements are testable\n- [ ] No [NEEDS CLARIFICATION] markers remain\n';
export const CONSTITUTION8 = '# Constitution\n\n## I. Test first\n\nTests come before code.\n';
const lines8 = (t) => t.replace(/\n$/, '').split('\n');
const add8 = (t) => `@@ -0,0 +1,${lines8(t).length} @@\n` + lines8(t).map((l) => '+' + l).join('\n');

const C = (o) => ({ side: 'RIGHT', path: 'docs/plan.md', author_association: 'MEMBER', user: { login: 'alice', avatar_url: AVATAR }, created_at: '2026-11-18T10:00:00Z', html_url: 'https://github.com/acme/docs/pull/7#discussion_r' + o.id, line: null, original_line: null, ...o });
export const COMMENTS = [
  C({ id: 101, line: 6, start_line: 3, original_line: 6, original_start_line: 3, body: 'Is this **too long**?' }),
  C({ id: 102, in_reply_to_id: 101, line: 6, user: { login: 'bob' }, created_at: '2026-11-19T09:00:00Z', body: 'Will trim it.' }),
  C({ id: 103, line: null, original_line: 9, user: { login: 'carol' }, body: 'Outdated note on the list.' }),
  C({ id: 104, path: 'other.md', line: 1, body: 'Different file.' }),
  C({ id: 105, side: 'LEFT', line: 2, body: 'On a removed line.' }),
  C({ id: 106, path: 'src/x.js', line: 1, body: 'Not markdown.' }),
  C({ id: 301, path: 'docs/removed.md', side: 'LEFT', line: 5, original_line: 5, body: 'Why drop this paragraph?' }),
  C({ id: 302, path: 'docs/removed.md', line: 5, original_line: 5, body: 'Should "keep one" be bold?' }),
];

// A single commit (the PR's head, diffing against MERGE_BASE as its parent) and its commit comments, anchored by diff position.
// In PATCH, position 7 is new line 6 ('+across two lines…'), position 2 is old line 2 (the removed subtitle).
const CC = (o) => ({ path: 'docs/plan.md', commit_id: SHA, author_association: 'MEMBER', user: { login: 'alice', avatar_url: AVATAR }, created_at: '2026-11-18T10:00:00Z', html_url: `https://github.com/acme/docs/commit/${SHA}#commitcomment-${o.id}`, line: null, position: null, ...o });
export const COMMIT_COMMENTS = [
  CC({ id: 701, position: 7, line: 6, body: 'Wrap this tighter?' }),
  CC({ id: 702, position: 7, line: 6, user: { login: 'me', avatar_url: AVATAR }, created_at: '2026-11-19T10:00:00Z', body: 'Agreed.' }),
  CC({ id: 703, position: 2, line: null, body: 'Keep the subtitle.' }),
  CC({ id: 704, path: null, body: 'Nice commit overall.' }),
  CC({ id: 705, path: 'src/x.js', position: 1, line: 1, body: 'Not markdown.' }),
];

/**
 * Start the fake. Returns {port, posted, replies, ops, state, close()}.
 *  posted:  submitted review bodies (REST `POST /reviews`, or GraphQL submit);  replies: replies posted to threads
 *  ops:     every write as {op, ...}, in order;  hits: "METHOD path -> status" for every request (to check 304s)
 *  state:   mutable: comments, issueComments, pending (the viewer's pending review), resolved (Set of root ids),
 *           reactions, headSha, version (bumped on every change: it drives the ETags), plus failure switches
 *           locked / rateLimited / graphql (false = GraphQL unavailable)
 */
export async function startFake() {
  const posted = [];
  const replies = [];
  const ops = [];
  const hits = [];
  let nextId = 1000;
  const state = {
    comments: COMMENTS.map((c) => ({ ...c })),
    commitComments: COMMIT_COMMENTS.map((c) => ({ ...c })),
    branchTip: null, // set to move the branches on (the fake still only serves SHA's contents)
    gone: null, // a branch name that has been deleted
    issueComments: [
      { id: 501, node_id: 'IC_501', user: { login: 'dave', avatar_url: AVATAR }, author_association: 'CONTRIBUTOR', created_at: '2026-11-17T08:00:00Z', updated_at: '2026-11-17T08:00:00Z', html_url: 'https://github.com/acme/docs/pull/7#issuecomment-501', body: 'General note: please also update the changelog.' },
    ],
    contents: new Map(), // `${ref}:${path}` -> text, served before the built-in files: lets a test give a file a history
    dirs: new Map(), // `${ref}:${dir}` -> [{name, path, type}]
    reviews: [], // submitted reviews on PR 7, as GitHub lists them
    viewedFiles: null, // {path: 'VIEWED' | 'UNVIEWED' | 'DISMISSED'}; null = GraphQL has no viewed state (the field is missing)
    pending: null, // {id, databaseId}
    resolved: new Set(),
    reactions: new Map(), // comment id -> [{content, mine}]
    headSha: SHA,
    version: 1,
    locked: false,
    rateLimited: false,
    graphql: true,
  };
  const bump = () => { state.version++; };
  const nodeOf = (c) => 'PRRC_' + c.id;
  const rootOf = (c) => { let r = c; while (r.in_reply_to_id) r = state.comments.find((x) => x.id === r.in_reply_to_id) || { ...r, in_reply_to_id: null }; return r; };
  const withReactions = (c) => {
    const rs = state.reactions.get(c.id) || [];
    const out = { ...c, node_id: nodeOf(c), updated_at: c.updated_at || c.created_at, reactions: { total_count: rs.length } };
    for (const r of rs) out.reactions[r.content] = (out.reactions[r.content] || 0) + 1;
    return out;
  };
  const etagFor = (key) => `"${key}-v${state.version}-${state.comments.length}-${state.issueComments.length}-${state.commitComments.length}-${state.headSha.slice(0, 4)}"`;

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const send = (o, s = 200, headers = {}) => { hits.push(`${req.method} ${u.pathname} -> ${s}`); res.writeHead(s, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(o)); };
    const json = send;
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => handle(raw));
    const text = (s, t = 'text/plain') => { hits.push(`${req.method} ${u.pathname} -> 200`); res.writeHead(200, { 'Content-Type': t }); res.end(s); };
    const cached = (key, body) => {
      const tag = etagFor(key);
      if (req.headers['if-none-match'] === tag) { hits.push(`${req.method} ${u.pathname} -> 304`); res.writeHead(304, { ETag: tag }); return res.end(); }
      return send(body(), 200, { ETag: tag });
    };
    const fail = () => {
      if (state.rateLimited) { json({ message: 'API rate limit exceeded for user ID 1.' }, 403); return true; }
      return false;
    };

    function graphql(q, v) {
      const data = (d) => json({ data: d });
      const err = (m) => json({ errors: [{ message: m }], data: null });
      if (!state.graphql) return json({ message: 'GraphQL is not available' }, 403);
      const pendingNode = () => (state.pending ? [{ id: state.pending.id, databaseId: state.pending.databaseId, viewerDidAuthor: true }] : []);
      if (q.includes('viewerViewedState')) {
        if (state.viewedFiles === null) return err("Field 'viewerViewedState' doesn't exist on type 'PullRequestChangedFile'");
        return data({ repository: { pullRequest: { id: 'PR_7', files: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: Object.entries(state.viewedFiles).map(([path, st]) => ({ path, viewerViewedState: st })) } } } });
      }
      if (q.includes('markFileAsViewed') || q.includes('unmarkFileAsViewed')) {
        const on = !q.includes('unmarkFileAsViewed');
        state.viewedFiles = { ...(state.viewedFiles || {}), [v.p]: on ? 'VIEWED' : 'UNVIEWED' };
        ops.push({ op: on ? 'viewed' : 'unviewed', path: v.p, pr: v.id });
        bump();
        return data({ [on ? 'markFileAsViewed' : 'unmarkFileAsViewed']: { clientMutationId: null } });
      }
      if (q.includes('reviewThreads') && v.number === 8) return data({ viewer: { login: 'me' }, repository: { pullRequest: { id: 'PR_8', reviews: { nodes: [] }, reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } });
      if (q.includes('reviewThreads')) {
        const roots = state.comments.filter((c) => !c.in_reply_to_id);
        const nodes = roots.map((r) => {
          const msgs = state.comments.filter((c) => rootOf(c).id === r.id);
          return {
            id: 'PRRT_' + r.id, path: r.path, line: r.line, originalLine: r.original_line ?? r.line, startLine: r.start_line ?? null, originalStartLine: r.original_start_line ?? r.start_line ?? null, diffSide: r.side, startDiffSide: r.start_side ?? null, isResolved: state.resolved.has(r.id), isOutdated: r.line == null, viewerCanResolve: true, viewerCanUnresolve: true, viewerCanReply: !state.locked,
            comments: { nodes: msgs.map((c) => ({
              id: 'PRRC_' + c.id, databaseId: c.id, state: c.pending ? 'PENDING' : 'SUBMITTED', lastEditedAt: c.edited_at || null, body: c.body, createdAt: c.created_at, updatedAt: c.updated_at || c.created_at, url: c.html_url, authorAssociation: c.author_association, author: { login: c.user.login, avatarUrl: c.user.avatar_url }, replyTo: c.in_reply_to_id ? { databaseId: c.in_reply_to_id } : null, viewerCanUpdate: c.user.login === 'me', viewerCanDelete: c.user.login === 'me', viewerCanReact: true,
              reactionGroups: Object.entries(Object.groupBy(state.reactions.get(c.id) || [], (x) => x.content)).map(([content, list]) => ({ content: Object.entries({ '+1': 'THUMBS_UP', '-1': 'THUMBS_DOWN', laugh: 'LAUGH', hooray: 'HOORAY', confused: 'CONFUSED', heart: 'HEART', rocket: 'ROCKET', eyes: 'EYES' }).find(([k]) => k === content)[1], viewerHasReacted: list.some((x) => x.mine), reactors: { totalCount: list.length } })),
            })) },
          };
        });
        return data({ viewer: { login: 'me' }, repository: { pullRequest: { id: 'PR_7', reviews: { nodes: pendingNode() }, reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } } });
      }
      if (q.includes('me:viewer{repository(name:')) { // "name#47": only acme has a repo of that name; the viewer ("me") does not
        ops.push({ op: 'name-lookup', vars: v });
        const pr = (owner) => ({ pullRequest: { number: v.n, title: 'Old one', state: 'MERGED', isDraft: false, updatedAt: '2025-01-01T00:00:00Z', author: { login: 'bob' }, repository: { nameWithOwner: `${owner}/${v.name}` } } });
        const d = { me: { repository: null } };
        Object.keys(v).filter((k) => /^o\d$/.test(k)).forEach((k) => { d[k] = v[k] === 'acme' ? pr('acme') : null; });
        return json({ data: d, errors: [{ type: 'NOT_FOUND', message: 'Could not resolve to a Repository' }] });
      }
      if (q.includes('search(query:')) { // PR autocomplete: record the search strings, answer each alias with one PR
        ops.push({ op: 'search', queries: Object.values(v) });
        const node = { number: 7, title: 'Update the docs', state: 'OPEN', isDraft: false, updatedAt: '2026-11-20T00:00:00Z', author: { login: 'alice' }, repository: { nameWithOwner: 'acme/docs' } };
        return data(Object.fromEntries(Object.keys(v).map((k) => ['s' + k.slice(1), { nodes: [node] }])));
      }
      if (q.includes('pullRequest(number:$number){number title')) return data({ repository: { pullRequest: { number: v.number, title: 'Exact one', state: 'CLOSED', isDraft: false, updatedAt: '2026-01-01T00:00:00Z', author: null, repository: { nameWithOwner: v.owner + '/' + v.repo } } } });
      if (q.includes('pullRequest(number:$number){id reviews')) return data({ repository: { pullRequest: { id: 'PR_7', reviews: { nodes: pendingNode() } } } });
      if (q.includes('addPullRequestReview(')) {
        if (state.pending) return err('User can only have one pending review per pull request');
        state.pending = { id: 'PRR_1', databaseId: 55 };
        ops.push({ op: 'pending.create', sha: v.sha });
        bump();
        return data({ addPullRequestReview: { pullRequestReview: state.pending } });
      }
      if (q.includes('addPullRequestReviewThread')) {
        if (!state.pending || v.r !== state.pending.id) return err('Could not resolve to a node with the global id of ' + v.r);
        if (v.line > 14) return err('Line must be part of the diff');
        const c = C({ id: ++nextId, path: v.path, line: v.line, side: v.side, body: v.body, user: { login: 'me', avatar_url: AVATAR }, pending: true, created_at: new Date().toISOString() });
        if (v.sl != null) { c.start_line = v.sl; c.start_side = v.ss; }
        state.comments.push(c);
        ops.push({ op: 'pending.add', id: c.id, path: v.path, line: v.line, side: v.side, start_line: v.sl, body: v.body });
        bump();
        return data({ addPullRequestReviewThread: { thread: {
          id: 'PRRT_' + c.id, path: c.path, line: c.line, originalLine: c.line, startLine: c.start_line ?? null, originalStartLine: c.start_line ?? null, diffSide: c.side, startDiffSide: c.start_side ?? null,
          comments: { nodes: [{ id: 'PRRC_' + c.id, databaseId: c.id, body: c.body, path: c.path, createdAt: c.created_at, url: c.html_url, authorAssociation: 'OWNER', author: { login: 'me', avatarUrl: AVATAR } }] },
        } } });
      }
      if (q.includes('updatePullRequestReviewComment')) {
        const c = state.comments.find((x) => 'PRRC_' + x.id === v.id);
        if (!c) return err('Could not resolve to a node with the global id of ' + v.id);
        c.body = v.b; c.updated_at = c.edited_at = new Date().toISOString();
        ops.push({ op: 'edit', id: c.id, body: v.b, via: 'graphql' });
        bump();
        return data({ updatePullRequestReviewComment: { pullRequestReviewComment: { databaseId: c.id, body: c.body, updatedAt: c.updated_at } } });
      }
      if (q.includes('submitPullRequestReview')) {
        if (!state.pending) return err('no pending review');
        for (const c of state.comments) if (c.pending) { delete c.pending; c.updated_at = new Date().toISOString(); } // like GitHub: submitting touches updated_at (not a real edit)
        state.pending = null;
        posted.push({ event: v.e, body: v.b, via: 'graphql' });
        ops.push({ op: 'pending.submit', event: v.e, body: v.b });
        bump();
        return data({ submitPullRequestReview: { pullRequestReview: { databaseId: 77, url: 'https://github.com/acme/docs/pull/7#pullrequestreview-77', state: v.e === 'COMMENT' ? 'COMMENTED' : v.e } } });
      }
      if (q.includes('deletePullRequestReview')) {
        state.comments = state.comments.filter((c) => !c.pending);
        state.pending = null;
        ops.push({ op: 'pending.discard' });
        bump();
        return data({ deletePullRequestReview: { pullRequestReview: { id: v.r } } });
      }
      if (q.includes('resolveReviewThread') || q.includes('unresolveReviewThread')) {
        const rid = Number(String(v.id).replace('PRRT_', ''));
        if (!state.comments.some((c) => c.id === rid)) return err('Could not resolve to a PullRequestReviewThread');
        const resolve = !q.includes('unresolveReviewThread');
        if (resolve) state.resolved.add(rid); else state.resolved.delete(rid);
        ops.push({ op: resolve ? 'resolve' : 'unresolve', thread: v.id });
        bump();
        const t = { id: v.id, isResolved: resolve, viewerCanResolve: true, viewerCanUnresolve: true };
        return data({ [resolve ? 'resolveReviewThread' : 'unresolveReviewThread']: { thread: t } });
      }
      if (q.includes('removeReaction')) {
        const id = Number(String(v.id).replace('PRRC_', ''));
        const content = { THUMBS_UP: '+1', THUMBS_DOWN: '-1', LAUGH: 'laugh', HOORAY: 'hooray', CONFUSED: 'confused', HEART: 'heart', ROCKET: 'rocket', EYES: 'eyes' }[v.c];
        state.reactions.set(id, (state.reactions.get(id) || []).filter((r) => !(r.mine && r.content === content)));
        ops.push({ op: 'unreact', id, content });
        bump();
        return data({ removeReaction: { reaction: { content: v.c } } });
      }
      return err('unsupported query in the fake');
    }

    function handle(rawBody) {
      if (req.headers.authorization !== 'Bearer t') return json({ message: 'Bad credentials' }, 401);
      if (u.pathname === '/user') return json({ login: 'me', avatar_url: AVATAR });
      if (u.pathname === '/graphql' && req.method === 'POST') { const b = JSON.parse(rawBody); return graphql(b.query, b.variables || {}); }
      let body = {};
      try { body = rawBody ? JSON.parse(rawBody) : {}; } catch { /* none */ }
      const isWrite = req.method !== 'GET';
      if (isWrite && fail()) return;

      const bm = /^\/repos\/acme\/docs\/branches\/(.+)$/.exec(u.pathname);
      if (bm && req.method === 'GET') { // two branches, both at the commit; GitHub decodes an encoded '/' in the name
        const name = decodeURIComponent(bm[1]);
        if (!['plan', 'feature/plan-v2'].includes(name)) return json({ message: 'Branch not found' }, 404);
        ops.push({ op: 'branch', name });
        if (name === state.gone) return json({ message: 'Branch not found' }, 404);
        return cached('br-' + name, () => ({ name, commit: { sha: state.branchTip || SHA } }));
      }
      if (u.pathname === '/repos/acme/docs' && req.method === 'GET') return json({ full_name: 'acme/docs', private: false });
      let cm = /^\/repos\/acme\/docs\/commits\/([0-9a-f]+)$/.exec(u.pathname);
      if (cm && req.method === 'GET') {
        if (!SHA.startsWith(cm[1])) return json({ message: 'No commit found for SHA: ' + cm[1] }, 422);
        const files = u.searchParams.get('page') > 1 ? [] : [
          { filename: 'docs/plan.md', status: 'modified', additions: 4, deletions: 1, patch: PATCH },
          { filename: 'docs/removed.md', status: 'modified', additions: 4, deletions: 6, patch: REMOVED_PATCH },
          { filename: 'src/x.js', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1 +1 @@\n-a\n+b' },
        ];
        return json({ sha: SHA, html_url: `https://github.com/acme/docs/commit/${SHA}`, commit: { message: 'Tighten the plan\n\nAnd drop the old subtitle.\n\nCo-authored-by: Carol <carol@example.com>\nSigned-off-by: Bob <bob@example.com>', author: { name: 'Bob', date: '2026-11-18T09:00:00Z' }, committer: { name: 'GitHub', date: '2026-11-18T09:05:00Z' }, verification: { verified: true, reason: 'valid' }, comment_count: state.commitComments.length }, author: { login: 'bob', avatar_url: AVATAR }, committer: { login: 'web-flow', avatar_url: AVATAR }, parents: [{ sha: MERGE_BASE }], stats: { additions: 9, deletions: 7 }, files });
      }
      if (u.pathname === `/repos/acme/docs/commits/${SHA}/pulls`) return json([{ number: 7, title: 'Plan v2', state: 'open', merged_at: null, html_url: 'https://github.com/acme/docs/pull/7' }]);
      if (u.pathname === `/repos/acme/docs/commits/${SHA}/comments` && req.method === 'GET') return cached('cc', () => state.commitComments.map(withReactions));
      if (u.pathname === `/repos/acme/docs/commits/${SHA}/comments` && req.method === 'POST') {
        if (!body.body) return json({ message: 'Validation Failed', errors: [{ field: 'body', code: 'missing_field' }] }, 422);
        if (body.path && !(body.position >= 1 && body.position <= 15)) return json({ message: 'Validation Failed', errors: [{ resource: 'CommitComment', code: 'invalid', field: 'position' }] }, 422);
        const c = CC({ id: ++nextId, path: body.path || null, position: body.position ?? null, line: body.line ?? null, body: body.body, user: { login: 'me', avatar_url: AVATAR }, author_association: 'OWNER', created_at: new Date().toISOString() });
        state.commitComments.push(c);
        ops.push({ op: 'commit-comment', id: c.id, ...body }); bump();
        return json(withReactions(c), 201);
      }
      cm = /^\/repos\/acme\/docs\/comments\/(\d+)(\/reactions)?$/.exec(u.pathname);
      if (cm) {
        const c = state.commitComments.find((x) => x.id === Number(cm[1]));
        if (!c) return json({ message: 'Not Found' }, 404);
        if (cm[2] && req.method === 'POST') {
          const list = state.reactions.get(c.id) || [];
          if (!list.some((r) => r.mine && r.content === body.content)) list.push({ content: body.content, mine: true });
          state.reactions.set(c.id, list);
          ops.push({ op: 'react', kind: 'commit', id: c.id, content: body.content }); bump();
          return json({ id: 9000 + list.length, content: body.content }, 201);
        }
        if (req.method === 'GET') return json(withReactions(c));
        if (c.user.login !== 'me') return json({ message: 'Must have admin rights to Repository.' }, 403);
        if (req.method === 'PATCH') { c.body = body.body; c.updated_at = new Date().toISOString(); ops.push({ op: 'edit-commit-comment', id: c.id, body: body.body }); bump(); return json(withReactions(c)); }
        if (req.method === 'DELETE') { state.commitComments = state.commitComments.filter((x) => x.id !== c.id); ops.push({ op: 'delete-commit-comment', id: c.id }); bump(); res.writeHead(204); return res.end(); }
      }
      if (u.pathname === '/repos/acme/docs/pulls/8' && req.method === 'GET') {
        return cached('pull8', () => ({ title: 'Login spec', state: 'open', draft: false, merged: false, commits: 1, changed_files: 4, additions: 40, deletions: 0, comments: 0, review_comments: 0, created_at: '2026-11-18T09:00:00Z', html_url: 'https://github.com/acme/docs/pull/8', user: { login: 'claude-bot', avatar_url: AVATAR }, head: { sha: SHA8, ref: 'spec/login' }, base: { ref: 'main', sha: BASE8 } }));
      }
      if (u.pathname === `/repos/acme/docs/compare/${BASE8}...${SHA8}`) return json({ merge_base_commit: { sha: BASE8 } });
      if (u.pathname === '/repos/acme/docs/pulls/8/files') {
        return json([
          { filename: 'specs/001-login/plan.md', status: 'added', additions: lines8(PLAN8).length, deletions: 0, patch: add8(PLAN8) },
          { filename: 'specs/001-login/tasks.md', status: 'added', additions: lines8(TASKS8).length, deletions: 0, patch: add8(TASKS8) },
          { filename: 'specs/001-login/contracts/api.yaml', status: 'added', additions: 3, deletions: 0, patch: '@@ -0,0 +1,3 @@\n+openapi: 3.0.0\n+info: {}\n+paths: {}' },
          { filename: 'src/login.ts', status: 'added', additions: 1, deletions: 0, patch: '@@ -0,0 +1 @@\n+export {}' },
        ]);
      }
      if (u.pathname === '/repos/acme/docs/pulls/8/comments' && req.method === 'GET') return cached('rc8', () => []);
      if (u.pathname === '/repos/acme/docs/issues/8/comments' && req.method === 'GET') return cached('ic8', () => []);
      if (u.pathname === '/repos/acme/docs/pulls/8/reviews' && req.method === 'GET') return json([]);
      if (u.pathname === '/repos/acme/docs/pulls/7/reviews' && req.method === 'GET') return json(state.reviews);
      { // directories and files at a given commit: anything a test registered, then PR 8's tree
        const cm8 = /^\/repos\/acme\/docs\/contents\/(.+)$/.exec(u.pathname);
        const ref = u.searchParams.get('ref');
        if (cm8 && req.method === 'GET') {
          const path = decodeURIComponent(cm8[1]);
          if (ref === 'deadbeefdead') return json({ message: 'No commit found for the ref deadbeefdead' }, 404); // a commit that was force-pushed away
          if (state.dirs.has(`${ref}:${path}`)) return json(state.dirs.get(`${ref}:${path}`));
          if (state.contents.has(`${ref}:${path}`)) return text(state.contents.get(`${ref}:${path}`));
          if (ref === SHA8) {
            const f8 = { 'specs/001-login/spec.md': SPEC8, 'specs/001-login/plan.md': PLAN8, 'specs/001-login/tasks.md': TASKS8, 'specs/001-login/checklists/requirements.md': CHECKLIST8, '.specify/memory/constitution.md': CONSTITUTION8 };
            if (path === 'specs/001-login') return json(['spec.md', 'plan.md', 'tasks.md'].map((name) => ({ name, path: `specs/001-login/${name}`, type: 'file' })).concat([{ name: 'contracts', path: 'specs/001-login/contracts', type: 'dir' }]));
            if (path === 'specs/001-login/checklists') return json([{ name: 'requirements.md', path: 'specs/001-login/checklists/requirements.md', type: 'file' }]);
            if (path === '.specify/memory') return json([{ name: 'constitution.md', path: '.specify/memory/constitution.md', type: 'file' }]);
            if (f8[path] !== undefined) return text(f8[path]);
            if (/^(specs|\.specify)\//.test(path)) return json({ message: 'Not Found' }, 404);
          }
        }
      }
      if (u.pathname === '/repos/acme/docs/pulls/7' && req.method === 'GET') {
        return cached('pull', () => ({ title: 'Plan v2', state: 'open', draft: false, merged: false, commits: 2, changed_files: 7, additions: 130, deletions: 9, comments: state.issueComments.length, review_comments: state.comments.length, created_at: '2026-11-18T09:00:00Z', html_url: 'https://github.com/acme/docs/pull/7', user: { login: 'bob', avatar_url: AVATAR }, head: { sha: state.headSha, ref: 'plan' }, base: { ref: 'main', sha: BASE_SHA } }));
      }
      if (u.pathname === `/repos/acme/docs/compare/${BASE_SHA}...${SHA}`) return json({ merge_base_commit: { sha: MERGE_BASE } });
      if (u.pathname === '/repos/acme/docs/pulls/7/comments' && req.method === 'GET') {
        // (real GitHub leaves a user's unsubmitted review comments out of this list: they are only visible through GraphQL)
        return cached('rc', () => [...state.comments].filter((c) => !c.pending).map(withReactions));
      }
      if (u.pathname === '/repos/acme/docs/pulls/7/comments' && req.method === 'POST') {
        if (state.locked) return json({ message: 'Unable to create comment because issue is locked.' }, 403);
        if (state.pending) return json({ message: 'Unprocessable Entity', errors: [{ message: 'user_id can only have one pending review per pull request' }] }, 422);
        if (!body.commit_id || !body.path || !body.body || !(body.line >= 1)) return json({ message: 'Validation Failed', errors: [{ resource: 'PullRequestReviewComment', code: 'missing_field' }] }, 422);
        if (body.line > 14 || (body.start_line && body.start_line < 1)) return json({ message: 'Unprocessable Entity', errors: [{ resource: 'PullRequestReviewComment', code: 'invalid', field: 'pull_request_review_thread.line', message: 'pull_request_review_thread.line must be part of the diff' }] }, 422);
        const c = C({ id: ++nextId, path: body.path, line: body.line, side: body.side || 'RIGHT', body: body.body, user: { login: 'me', avatar_url: AVATAR }, original_line: body.line, created_at: new Date().toISOString() });
        if (body.start_line) { c.start_line = body.start_line; c.start_side = body.start_side; }
        state.comments.push(c);
        ops.push({ op: 'comment', id: c.id, ...body });
        bump();
        return json(withReactions(c), 201);
      }
      let m = /^\/repos\/acme\/docs\/pulls\/comments\/(\d+)$/.exec(u.pathname);
      if (m) {
        const c = state.comments.find((x) => x.id === Number(m[1]));
        if (!c) return json({ message: 'Not Found' }, 404);
        // real GitHub hides unsubmitted (pending) review comments from this endpoint: GET is a 404 (found on staging)
        if (req.method === 'GET') return c.pending ? json({ message: 'Not Found' }, 404) : json(withReactions(c));
        if (c.user.login !== 'me') return json({ message: 'Must have admin rights to Repository.' }, 403);
        if (req.method === 'PATCH' && c.pending) return json({ message: 'Not Found' }, 404); // REST cannot edit pending comments either: GraphQL only
        if (req.method === 'PATCH') {
          if (!body.body) return json({ message: 'Validation Failed', errors: [{ field: 'body', code: 'missing_field' }] }, 422);
          c.body = body.body; c.updated_at = new Date().toISOString();
          ops.push({ op: 'edit', id: c.id, body: body.body }); bump();
          return json(withReactions(c));
        }
        if (req.method === 'DELETE') {
          state.comments = state.comments.filter((x) => x.id !== c.id);
          ops.push({ op: 'delete', id: c.id }); bump();
          hits.push(`DELETE ${u.pathname} -> 204`); res.writeHead(204); return res.end();
        }
      }
      m = /^\/repos\/acme\/docs\/(pulls|issues)\/comments\/(\d+)\/reactions$/.exec(u.pathname);
      if (m && req.method === 'POST') {
        const id = Number(m[2]);
        const list = state.reactions.get(id) || [];
        if (!['+1', '-1', 'laugh', 'hooray', 'confused', 'heart', 'rocket', 'eyes'].includes(body.content)) return json({ message: 'Validation Failed' }, 422);
        if (!list.some((r) => r.mine && r.content === body.content)) list.push({ content: body.content, mine: true });
        state.reactions.set(id, list);
        ops.push({ op: 'react', kind: m[1], id, content: body.content }); bump();
        return json({ id: 9000 + list.length, content: body.content }, 201);
      }
      if (u.pathname === '/repos/acme/docs/issues/7/comments' && req.method === 'GET') return cached('ic', () => state.issueComments.map((c) => ({ ...c, updated_at: c.updated_at || c.created_at })));
      if (u.pathname === '/repos/acme/docs/issues/7/comments' && req.method === 'POST') {
        if (state.locked) return json({ message: 'Unable to create comment because issue is locked.' }, 403);
        const c = { id: ++nextId, node_id: 'IC_' + nextId, user: { login: 'me', avatar_url: AVATAR }, author_association: 'OWNER', created_at: new Date().toISOString(), html_url: 'https://github.com/acme/docs/pull/7#issuecomment-' + nextId, body: body.body };
        state.issueComments.push(c);
        ops.push({ op: 'pr-comment', id: c.id, body: body.body }); bump();
        return json(c, 201);
      }
      m = /^\/repos\/acme\/docs\/issues\/comments\/(\d+)$/.exec(u.pathname);
      if (m) {
        const c = state.issueComments.find((x) => x.id === Number(m[1]));
        if (!c) return json({ message: 'Not Found' }, 404);
        if (c.user.login !== 'me') return json({ message: 'Must have admin rights to Repository.' }, 403);
        if (req.method === 'PATCH') { c.body = body.body; c.updated_at = new Date().toISOString(); ops.push({ op: 'edit-pr-comment', id: c.id, body: body.body }); bump(); return json(c); }
        if (req.method === 'DELETE') { state.issueComments = state.issueComments.filter((x) => x.id !== c.id); ops.push({ op: 'delete-pr-comment', id: c.id }); bump(); res.writeHead(204); return res.end(); }
      }
      const rm = /^\/repos\/acme\/docs\/pulls\/7\/comments\/(\d+)\/replies$/.exec(u.pathname);
      if (rm && req.method === 'POST') {
        if (state.locked) return json({ message: 'Unable to create comment because issue is locked.' }, 403);
        replies.push({ to: Number(rm[1]), ...body });
        const c = C({ id: ++nextId, in_reply_to_id: Number(rm[1]), line: 6, user: { login: 'me', avatar_url: AVATAR }, created_at: '2026-11-20T12:00:00Z', body: body.body });
        state.comments.push(c); bump();
        return json(withReactions(c), 201);
      }
      if (u.pathname === '/repos/acme/docs/pulls/7/files') {
        return json([
          { filename: 'docs/plan.md', status: 'modified', additions: 4, deletions: 1, patch: PATCH },
          { filename: 'docs/complex.md', status: 'added', additions: COMPLEX_LINES.length, deletions: 0, patch: COMPLEX_PATCH },
          { filename: 'docs/diagrams.md', status: 'added', additions: DIAGRAM_LINES.length, deletions: 0, patch: DIAGRAM_PATCH },
          { filename: 'docs/github.md', status: 'added', additions: GH_LINES.length, deletions: 0, patch: GH_PATCH },
          { filename: 'docs/removed.md', status: 'modified', additions: 4, deletions: 6, patch: REMOVED_PATCH },
          { filename: 'src/x.js', status: 'modified', additions: 1, deletions: 0 },
          { filename: 'docs/old.md', status: 'removed', additions: 0, deletions: 9 },
        ]);
      }
      if (u.pathname === '/repos/acme/docs/contents/docs/img/x.png' && u.searchParams.get('ref') === SHA) {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        return res.end(PNG);
      }
      if (u.searchParams.get('ref') === MERGE_BASE && u.pathname === '/repos/acme/docs/contents/docs/removed.md') { // slow on purpose: a click can land while the first load is still running
        return setTimeout(() => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end(REMOVED_OLD); }, 700);
      }
      if (u.searchParams.get('ref') === MERGE_BASE && u.pathname === '/repos/acme/docs/contents/docs/plan.md') return text(PLAN_OLD);
      const files = { 'removed.md': REMOVED_NEW, 'github.md': GITHUBMD, 'diagrams.md': DIAGRAMS, 'complex.md': COMPLEX, 'plan.md': FILE };
      const fm = /^\/repos\/acme\/docs\/contents\/docs\/([\w.]+)$/.exec(u.pathname);
      if (fm && files[fm[1]] !== undefined && u.searchParams.get('ref') === SHA) return text(files[fm[1]]);
      if (u.pathname === '/repos/acme/docs/pulls/7/reviews' && req.method === 'POST') {
        if (state.pending) return json({ message: 'Unprocessable Entity', errors: ['User can only have one pending review per pull request'] }, 422);
        if (body.comments?.some((c) => c.line > 14)) return json({ message: 'Unprocessable Entity', errors: ['line must be part of the diff'] }, 422);
        posted.push(body);
        return json({ id: 1, html_url: 'https://github.com/acme/docs/pull/7#pullrequestreview-1', state: 'COMMENTED' });
      }
      json({ message: 'Not Found ' + u.pathname }, 404);
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: server.address().port, posted, replies, ops, hits, state, close: () => new Promise((r) => server.close(r)),
    /** simulate another person commenting on the PR */
    addComment: (o) => { state.comments.push(C({ id: ++nextId, created_at: new Date().toISOString(), ...o })); bump(); return nextId; },
    pushCommit: (sha) => { state.headSha = sha; bump(); },
  };
}
