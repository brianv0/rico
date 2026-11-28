import {
  parsePrRef, parseCommitRef, parseBranchRef, parseBranchPath, isBranchName, commitMessageParts, commitPath, parseCommitPath, patchPosition, previewLines, prPath, parsePrPath, resolveRepoPath, parsePatch, clampRange, wordCount, trimBlock, locateLine, buildLineComment, buildPrComment, parseQuote, findQuote, quoteParts, canSuggest, suggestionBody, lineDiff, parseSuggestion, mapPosition, positionSlope,
  formatQuote, plainQuote, coversWholeLines, buildFileTree, statBlocks, diffAnchor, parsePatchRows,
} from './lib.js';
import { diagramLang, renderDiagram, frameDoc } from './diagrams.js';
import { icon } from './icons.js';
import { initSuggest, rememberPr, showNeedsReview, showExplore } from './suggest.js';
import { patchHunkRanges, patchDeletions, oldToNewMap, wordDiff, diffGroups } from './lib.js';
import { detectSpec, buildSteps, referencePlan, referencesFromListing, referencesFromText, findMarkers, buildIdIndexByUnit, ID_SRC, ROLE_HINT, ROLE_LABEL } from './spec.js';
import { sinceChanges, reanchor, inlineDiff, pairBlocks } from './anchor.js';

const $ = (s) => document.querySelector(s);
// The page shows every changed markdown file as a card (like GitHub). All the selection / anchoring /
// quote code works on "the active file": `doc`, `margin` and `state.file/lines/diff` follow use(view).
let doc = null;
let margin = null;
const docwrap = $('#main');
const composer = $('#composer');

// GitHub-style code colours (highlight.js, loaded before this module); falls back to plain text.
const highlight = (str, lang) => {
  try { if (window.hljs && lang && window.hljs.getLanguage(lang)) return window.hljs.highlight(str, { language: lang, ignoreIllegals: true }).value; } catch { /* plain */ }
  return '';
};
const md = window.markdownit({ html: !!window.DOMPurify, linkify: true, highlight });
// Stamp every block with its source line range (markdown-it's token.map): data-l="start0-end0".
md.core.ruler.push('rico_lines', (state) => {
  for (const t of state.tokens) {
    if (!t.map) continue;
    if (t.nesting === 1 || t.type === 'fence' || t.type === 'code_block' || t.type === 'hr') {
      t.attrSet('data-l', `${t.map[0]}-${t.map[1]}`);
      if (t.type === 'fence') t.attrSet('data-k', 'fence');
    }
  }
});
const defaultLink = md.renderer.rules.link_open || ((tokens, i, o, _e, self) => self.renderToken(tokens, i, o));
md.renderer.rules.link_open = (tokens, i, o, e, self) => {
  if (!(tokens[i].attrGet('href') || '').startsWith('#')) { // fragment links stay in the page
    tokens[i].attrSet('target', '_blank');
    tokens[i].attrSet('rel', 'noopener noreferrer');
  }
  return defaultLink(tokens, i, o, e, self);
};

// ----- GitHub markdown features: task lists, alerts, heading anchors, table alignment, raw HTML -----
const ALERTS = { note: ['Note', 'info'], tip: ['Tip', 'light-bulb'], important: ['Important', 'report'], warning: ['Warning', 'alert'], caution: ['Caution', 'stop'] };
const slugify = (t) => t.toLowerCase().trim().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s+/g, '-');

md.core.ruler.push('rico_github', (st) => {
  const T = st.tokens;
  const seen = new Map();
  for (let i = 0; i < T.length; i++) {
    const t = T[i];
    // - [ ] / - [x] task list items
    if (t.type === 'list_item_open' && T[i + 1]?.type === 'paragraph_open' && T[i + 2]?.type === 'inline') {
      const first = T[i + 2].children[0];
      const m = first && first.type === 'text' && /^\[([ xX])\]\s+/.exec(first.content);
      if (m) {
        first.content = first.content.slice(m[0].length);
        const cb = new st.Token('html_inline', '', 0);
        cb.content = `<input type="checkbox" class="task-list-item-checkbox" disabled${m[1] === ' ' ? '' : ' checked'}> `;
        T[i + 2].children.unshift(cb);
        t.attrJoin('class', 'task-list-item');
        for (let j = i - 1; j >= 0; j--) {
          if ((T[j].type === 'bullet_list_open' || T[j].type === 'ordered_list_open') && T[j].level === t.level - 1) { T[j].attrJoin('class', 'contains-task-list'); break; }
        }
      }
    }
    // > [!NOTE] / TIP / IMPORTANT / WARNING / CAUTION alerts
    if (t.type === 'blockquote_open' && T[i + 1]?.type === 'paragraph_open' && T[i + 2]?.type === 'inline') {
      const inl = T[i + 2];
      const first = inl.children[0];
      const m = first && first.type === 'text' && /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/i.exec(first.content);
      if (m) {
        const kind = m[1].toLowerCase();
        first.content = first.content.slice(m[0].length);
        if (!first.content) inl.children.splice(0, inl.children[1]?.type === 'softbreak' ? 2 : 1);
        let depth = 0;
        let j = i;
        for (; j < T.length; j++) { if (T[j].type === 'blockquote_open') depth++; if (T[j].type === 'blockquote_close' && --depth === 0) break; }
        t.tag = 'div'; t.attrJoin('class', `markdown-alert markdown-alert-${kind}`); T[j].tag = 'div';
        const po = new st.Token('paragraph_open', 'p', 1); po.block = true; po.attrJoin('class', 'markdown-alert-title');
        const pi = new st.Token('inline', '', 0); pi.content = ''; pi.children = [];
        const ic = new st.Token('html_inline', '', 0); ic.content = `${icon(ALERTS[kind][1])}${ALERTS[kind][0]}`; pi.children.push(ic);
        const pc = new st.Token('paragraph_close', 'p', -1); pc.block = true;
        const drop = inl.children.length ? [] : [i + 1, i + 2, i + 3]; // the marker was the whole paragraph
        T.splice(i + 1, 0, po, pi, pc);
        if (drop.length) T.splice(i + 4, 3);
      }
    }
    // headings get GitHub's hover permalink icon
    if (t.type === 'heading_open' && T[i + 1]?.type === 'inline') {
      const text = T[i + 1].children.filter((c) => c.type === 'text' || c.type === 'code_inline').map((c) => c.content).join('');
      let slug = slugify(text);
      const n = seen.get(slug) || 0;
      seen.set(slug, n + 1);
      if (n) slug += `-${n}`;
      const a = new st.Token('html_inline', '', 0);
      a.content = `<a class="anchor" aria-label="Permalink: ${md.utils.escapeHtml(text)}" data-slug="${slug}" href="#${slug}">${icon('link', { cls: 'octicon-link' })}</a>`;
      T[i + 1].children.unshift(a);
      t.attrSet('data-slug', slug);
    }
    // markdown-it aligns table cells with style="text-align:x"; styles are stripped, so use align=
    if (t.type === 'th_open' || t.type === 'td_open') {
      const m = /text-align:\s*(\w+)/.exec(t.attrGet('style') || '');
      if (m) { t.attrs = t.attrs.filter((x) => x[0] !== 'style'); t.attrSet('align', m[1]); }
    }
  }
});

// Raw HTML blocks pass through (sanitized below); tag the first element with its source lines so a
// selection inside it still maps to the right place.
md.renderer.rules.html_block = (tokens, i) => {
  const t = tokens[i];
  const stamped = t.map ? t.content.replace(/^(\s*<[a-zA-Z][^\s>/]*)/, `$1 data-l="${t.map[0]}-${t.map[1]}" data-k="html"`) : t.content;
  return stamped;
};

// Relative links and images resolve against the PR's head commit, as on GitHub. This runs as a
// sanitizer hook so it covers markdown and raw HTML alike.
function repoUrl(kind, path, frag = '') {
  const p = state.pr;
  const origin = new URL(p.url).origin;
  return `${origin}/${p.owner}/${p.repo}/${kind}/${p.headSha}/${path.split('/').map(encodeURIComponent).join('/')}${frag}`;
}
const fileDir = () => (state.file ? state.file.filename.split('/').slice(0, -1).join('/') : '');
if (window.DOMPurify) {
  window.DOMPurify.addHook('uponSanitizeElement', (node, data) => {
    if (data.tagName === 'input') data.allowedTags.input = node.getAttribute('type') === 'checkbox' && node.hasAttribute('disabled'); // only task-list boxes
  });
  window.DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A' && node.hasAttribute('href')) {
      const href = node.getAttribute('href');
      if (!href.startsWith('#') && state.pr) {
        const path = resolveRepoPath(fileDir(), href);
        if (path) node.setAttribute('href', repoUrl('blob', path, href.includes('#') ? '#' + href.split('#').slice(1).join('#') : ''));
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
      }
    }
    if (node.tagName === 'IMG' && node.hasAttribute('src')) {
      const path = state.pr ? resolveRepoPath(fileDir(), node.getAttribute('src')) : null;
      if (path && /\.(png|jpe?g|gif|webp|svg|avif|bmp|ico)$/i.test(path)) node.setAttribute('src', '/api/raw?' + new URLSearchParams({ owner: state.pr.owner, repo: state.pr.repo, ref: state.pr.headSha, path }));
      else if (path) node.removeAttribute('src'); // not an image we can serve: do not request it
      node.setAttribute('loading', 'lazy');
      node.setAttribute('referrerpolicy', 'no-referrer');
    }
  });
}
const SANITIZE = { FORBID_TAGS: ['style', 'form', 'textarea', 'select', 'button', 'link', 'meta', 'base', 'iframe', 'object', 'embed'], FORBID_ATTR: ['style'], ADD_ATTR: ['target'] };
const safeHtml = (html) => (window.DOMPurify ? window.DOMPurify.sanitize(html, SANITIZE) : html);

// ```d2, ```mermaid and ```dot (graphviz) fences render as diagrams (client-side, optional dependencies loaded on demand);
// the source stays one click away.
const LANG_NAME = { d2: 'D2', mermaid: 'Mermaid', dot: 'Graphviz' };
const defaultFence = md.renderer.rules.fence;
md.renderer.rules.fence = (tokens, i, o, e, self) => {
  const t = tokens[i];
  const lang = diagramLang(t.info);
  if (lang) {
    return `<figure class="dia" data-l="${t.attrGet('data-l')}" data-k="diagram" data-lang="${lang}"><div class="dia-out" title="Click the diagram to comment on it, or a node or edge to comment on its line"><span class="dia-wait">Rendering diagram…</span></div>`
      + `<details class="dia-src"><summary>${LANG_NAME[lang]} source</summary><pre><code>${md.utils.escapeHtml(t.content)}</code></pre></details></figure>\n`;
  }
  return defaultFence(tokens, i, o, e, self);
};

// Separate renderer for comment bodies (no line stamping; raw HTML stays off).
const mdc = window.markdownit({ html: !!window.DOMPurify, linkify: true, breaks: true });
mdc.renderer.rules.link_open = md.renderer.rules.link_open;

const state = {
  threads: [], // existing PR review threads
  removed: [], // paths of threads on removed (LEFT-side) lines: not placeable in the rendered view
  leftThreads: [], // those threads, shown under their lines in the source diff

  pr: null, // {owner, repo, number, headSha, files, ...}
  file: null, // current file entry
  lines: [],
  diff: { hunks: [], added: new Set() },
  prThreads: [], // PR-level ("issue") comments: placed in the margin by their quote, or listed under General
  me: null, // login of the viewer ("your own comments"); null when signed out
  preview: false, // signed out in the hosted app: read-only
  pendingReview: null, // the viewer's pending GitHub review on this PR: {id, databaseId} | null
  canThread: false, // GraphQL worked: thread ids and permissions are known
  pending: null, // composer draft: {start, end, quote, anchor, range}
  viewed: new Set(), // files marked "Viewed" (on GitHub when it says so, else kept in this browser)
  dismissed: new Set(), // files GitHub ticked as viewed that have changed since
  viewedSync: false, // viewed marks are GitHub's (GraphQL answered)
  closedDirs: new Set(), // collapsed folders in the file tree
  spec: null, // spec review: {info, on, changed, refs, refFiles, steps, ids}
  treeMode: 'steps', // sidebar: the review steps, or every file
  since: null, // the baseline commit the page marks changes against: {sha, kind, label} | null
  baselines: [], // the baselines on offer
  reanchored: new Map(), // `${thread id}@${head}` -> where its text is now (see anchor.js)
};
const views = new Map(); // path -> file view {file, card, doc, margin, lines, diff, ...}
let cur = null; // the active view


// ---------- status / api ----------
let needSignin = false;
const signinUrl = () => '/auth/login?return=' + encodeURIComponent(location.pathname + location.search);
function status(msg, err = false) {
  const el = $('#status');
  el.textContent = msg || '';
  el.classList.toggle('err', !!err);
  if (err && needSignin && !document.querySelector('#who a')) { // hosted: the session is missing or was revoked
    const a = el.appendChild(el.ownerDocument.createElement('a'));
    a.href = signinUrl();
    a.textContent = ' Sign in with GitHub';
  }
  needSignin = false;
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  const text = await res.text();
  if (!res.ok) {
    let m = text;
    let signin = false;
    try { const j = JSON.parse(text); m = j.error || m; if (j.signin) { needSignin = true; signin = true; } } catch { /* plain text */ }
    throw Object.assign(new Error(m), { signin, status: res.status });
  }
  return text;
}
/** POST JSON to one of our own write routes and parse the reply. */
const apiPost = (path, body) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Rico': '1' }, body: JSON.stringify(body) }).then(JSON.parse);
const isCommit = () => state.pr?.kind === 'commit';
// GitHub's "Apply suggestion" belongs to pull requests: on a commit a ```suggestion block would be dead text
const suggestable = (sel) => (isCommit() ? { ok: false, reason: 'Suggestions need a pull request; this is a single commit.' } : canSuggest(sel));
// a write names its PR by number, or its commit by sha (the server routes commit comments by that)
const prRef = () => (isCommit() ? { owner: state.pr.owner, repo: state.pr.repo, sha: state.pr.sha } : { owner: state.pr.owner, repo: state.pr.repo, number: state.pr.number });
const where = () => (isCommit() ? 'commit' : 'pull request');

// hosted mode shows who is signed in; locally the server's own token is used and there is nothing to sign into
async function showWho() {
  const who = $('#who');
  try {
    const res = await fetch('/api/me');
    const me = await res.json().catch(() => ({}));
    state.me = me.login || null;
    state.meAvatar = me.avatar || null;
    state.preview = !!me.preview;
    document.body.dataset.auth = (res.ok && me.preview) || (res.status === 401 && me.signin) ? 'preview' : 'user'; // what the start page offers
    if ((res.ok && me.preview) || (res.status === 401 && me.signin)) { // signed out (or the token was revoked at GitHub): reading public PRs
      state.preview = true;
      who.innerHTML = '<span class="chip" title="You can read public pull requests. Sign in to comment, reply and post reviews.">Preview · read-only</span>';
      const a = who.appendChild(el('a', 'btn btn-primary', 'Sign in with GitHub'));
      a.href = signinUrl();
    } else if (res.ok && me.hosted) {
      // just the avatar; who you are and Sign out are in its menu
      who.innerHTML = `<details class="menu" id="account"><summary aria-label="Account: ${esc(me.login)}" title="${esc(me.login)}">${me.avatar ? `<img alt="" src="${esc(me.avatar)}">` : `<span class="btn">${esc(me.login)}</span>`}</summary><div class="menu-pop"><div class="menu-head">Signed in as <b>${esc(me.login)}</b></div></div></details>`;
      const pop = who.querySelector('.menu-pop');
      const out = pop.appendChild(el('button', 'menu-item'));
      out.innerHTML = `${icon('sign-out')} Sign out`;
      out.type = 'button';
      out.addEventListener('click', async () => { await fetch('/auth/logout', { method: 'POST', headers: { 'X-Rico': '1' } }); location.reload(); });
    }
  } catch { /* offline: leave it empty */ }
}

// ---------- persistence ----------
// Comments live on GitHub now; only the review summary, "viewed" marks and unsent text stay in this browser.
const prKey = () => `rico:${state.pr.owner}/${state.pr.repo}${isCommit() ? '@' + state.pr.sha : '#' + state.pr.number}`;
const storeKey = () => `${prKey()}:${state.pr.headSha}`;
function save() {
  try { localStorage.setItem(storeKey(), JSON.stringify({ summary: $('#summary').value })); } catch { /* private mode */ }
}
const viewedKey = () => prKey() + ':viewed'; // per PR, not per commit: a push no longer forgets what you have read
function saveViewed() { try { localStorage.setItem(viewedKey(), JSON.stringify([...state.viewed])); } catch { /* ignore */ } }
function restore() {
  state.viewed = new Set();
  state.dismissed = new Set();
  try { state.viewed = new Set(JSON.parse(localStorage.getItem(viewedKey()) || localStorage.getItem(storeKey() + ':viewed') || '[]')); } catch { /* ignore */ }
  const vf = state.pr.viewedFiles; // GitHub's own marks win, so they follow the reviewer between github.com and here
  state.viewedSync = !!vf && state.pr.kind !== 'commit';
  if (vf) {
    state.viewed = new Set(Object.entries(vf).filter(([, st]) => st === 'VIEWED').map(([f]) => f));
    state.dismissed = new Set(Object.entries(vf).filter(([, st]) => st === 'DISMISSED').map(([f]) => f));
  }
  $('#summary').value = '';
  try {
    const v = JSON.parse(localStorage.getItem(storeKey()) || 'null');
    if (v) $('#summary').value = v.summary || '';
  } catch { /* ignore */ }
}
// Unsent text (the comment box, reply boxes) survives a reload or a sign-in round trip. Keyed by PR, not commit.
const draftKey = (k) => `${prKey()}:draft:${k}`;
function draftGet(k) { try { return JSON.parse(localStorage.getItem(draftKey(k)) || 'null'); } catch { return null; } }
function draftSet(k, v) {
  try { if (v == null || v === '') localStorage.removeItem(draftKey(k)); else localStorage.setItem(draftKey(k), JSON.stringify(v)); } catch { /* ignore */ }
}

// ---------- loading ----------
const EAGER = 8; // load this many files up front; the rest load on demand
const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

// The address bar always names the PR (and the commit it was loaded at) and the open file, so it can be shared.
// Opening a file replaces the history entry; loading a different PR (push) adds one, so Back returns to the previous PR.
const samePr = (at, p) => !!(at && p && at.instance === 'github.com' && (p.kind === 'commit' ? !!at.sha && !at.number && p.sha.startsWith(at.sha) : at.number === p.number)
  && at.owner.toLowerCase() === p.owner.toLowerCase() && at.repo.toLowerCase() === p.repo.toLowerCase());
const hereAt = () => parsePrPath(location.pathname) || parseCommitPath(location.pathname) || parseBranchPath(location.pathname);
function syncUrl(filename, push = false) {
  if (!state.pr) return;
  const p = state.pr;
  // a commit opened from a branch keeps the branch in its link, so it can follow the branch later (see refreshComments)
  const params = new URLSearchParams({ ...(p.kind === 'commit' && p.branch ? { branch: p.branch } : {}), ...(filename ? { file: filename } : {}), ...(state.since && p.kind !== 'commit' ? { since: state.since.sha.slice(0, 7) } : {}) });
  const q = params.size ? '?' + params : '';
  const url = (p.kind === 'commit' ? commitPath(p) : prPath({ owner: p.owner, repo: p.repo, number: p.number }, p.headSha)) + q;
  if (location.pathname + location.search + location.hash === url) return;
  if (push && !samePr(hereAt(), p)) history.pushState(null, '', url);
  else history.replaceState(null, '', url);
}

async function loadPr(ref, wantFile, wantSha = '', push = false, wantBranch = '') {
  const commit = parseCommitRef(ref);
  const branch = !commit && parseBranchRef(ref);
  const parsed = commit || branch || parsePrRef(ref);
  if (!parsed) return status('That does not look like a GitHub PR, commit or branch link (try https://github.com/owner/repo/pull/123, owner/repo#123, https://github.com/owner/repo/commit/abc1234 or https://github.com/owner/repo/tree/my-branch).', true);
  status(commit ? 'Loading commit…' : branch ? `Loading the latest commit on ${branch.branch}…` : 'Loading PR…');
  try {
    const pr = await api('/api/pr?ref=' + encodeURIComponent(ref)).then(JSON.parse);
    if (pr.kind === 'commit' && !pr.branch && isBranchName(wantBranch)) pr.branch = wantBranch; // a pinned commit, still following its branch
    state.pr = pr;
    if (pr.kind !== 'commit') rememberPr(pr);
    if (wantSha && pr.headSha && !pr.headSha.startsWith(wantSha)) {
      setTimeout(() => status(`This link was made at commit ${wantSha}; the PR is now at ${pr.headSha.slice(0, 7)}, so lines and comments may have moved.`, true), 0);
    }
    applyComments(pr);
    state.placed = new Map();
    state.stale = null;
    $('#stale').hidden = true;
    state.lastSig = JSON.stringify([pr.comments, pr.prComments, pr.pendingReview]);
    etags = {};
    restore();
    state.reanchored = new Map();
    setupSpec(pr);
    chooseBaselines(pr, push ? '' : new URLSearchParams(location.search).get('since') || '');
    renderHeader();
    renderPanel();
    buildCards();
    renderFiles();
    renderSpecBar();
    renderSinceBar();
    if (!pr.files.length) {
      syncUrl('', push);
      $('#cards').innerHTML = `<p class="empty">This ${pr.kind === 'commit' ? 'commit' : 'PR'} changes no markdown files.</p>`;
      $('#legend').hidden = true;
      status('');
      return;
    }
    const order = orderedFiles();
    const first = order.find((x) => x.filename === wantFile) || order[0];
    syncUrl(wantFile && first.filename === wantFile ? wantFile : '', push);
    use(views.get(first.filename)); // active before anything renders
    const eager = [first, ...order.filter((f) => f !== first)].slice(0, state.spec?.on ? 16 : EAGER);
    await Promise.all(eager.map((f) => loadView(views.get(f.filename)).catch((e) => status(e.message, true))));
    // Do NOT force the first file active again here: the user may have opened another file while these loads ran.
    if (wantFile && cur === views.get(first.filename)) scrollToCard(first.filename);
    renderFiles();
    renderSpecBar();
    restoreComposer();
    schedulePoll();
    resolveRefs(); // spec review: the unchanged neighbours (spec.md beside plan.md), added as they are found
  } catch (e) {
    status(e.message, true);
    return;
  }
  status('');
}

// ----- pull request header, tabs, toolbar -----
function renderHeader() {
  const p = state.pr;
  $('#prhead').hidden = false;
  $('#toolbar').hidden = false;
  document.body.classList.toggle('is-commit', p.kind === 'commit');
  $('#commit-note').hidden = p.kind !== 'commit';
  if (p.kind !== 'commit') $('#commit-info').hidden = true;
  $('#c-kind').hidden = p.kind !== 'commit';
  $('#c-add').textContent = p.kind === 'commit' ? 'Comment on commit' : 'Comment';
  $('#legend-where').textContent = p.kind === 'commit' ? 'commit' : 'pull request';
  $('#review-btn').hidden = p.kind === 'commit'; // commit comments are posted one at a time: there is no review to finish
  if (p.kind === 'commit') return renderCommitHeader(p);
  document.title = `${p.title} · Pull Request #${p.number} · ${p.owner}/${p.repo} · Rico`;
  $('#pr-title').textContent = p.title;
  $('#pr-num').textContent = `#${p.number}`;
  const st = p.merged ? 'merged' : p.draft ? 'draft' : p.state === 'closed' ? 'closed' : 'open';
  const ic = { open: 'git-pull-request', merged: 'git-merge', closed: 'git-pull-request-closed', draft: 'git-pull-request-draft' }[st];
  const badge = $('#pr-state');
  badge.className = `State State--${st}`;
  badge.innerHTML = `${icon(ic)} ${{ open: 'Open', merged: 'Merged', closed: 'Closed', draft: 'Draft' }[st]}`;
  const meta = $('#pr-meta');
  meta.textContent = '';
  const ref = (name) => el('span', 'commit-ref', name);
  const n = p.commits;
  meta.append(el('b', null, p.author || 'someone'), ` ${p.merged ? 'merged' : 'wants to merge'} ${n ?? ''}${n == null ? '' : ` commit${n === 1 ? '' : 's'}`} into `, ref(p.baseRef), ' from ', ref(p.headRef));
  const comments = (p.issueComments || 0) + (p.reviewComments || 0);
  const tabs = [
    ['Conversation', 'comment-discussion', p.url, comments],
    ['Commits', 'git-commit', `${p.url}/commits`, p.commits],
    ['Checks', 'check-circle-fill', `${p.url}/checks`, null],
    ['Files changed', 'diff', null, p.changedFiles],
  ];
  const nav = $('#tabs');
  nav.textContent = '';
  for (const [label, ico, href, count] of tabs) {
    const a = el('a');
    a.innerHTML = `${icon(ico)}<span>${label}</span>`;
    if (count != null) a.append(Object.assign(el('span', 'Counter'), { textContent: String(count) }));
    if (href) { a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer'; } else a.setAttribute('aria-current', 'page');
    nav.append(a);
  }
  $('#totals').innerHTML = `<b>${p.changedFiles}</b> changed file${p.changedFiles === 1 ? '' : 's'} &nbsp;<span class="add">+${p.additions}</span> <span class="del">−${p.deletions}</span>`;
}

// A single commit: its message, who made it, and its parent (what the diff is against). Commit comments only.
function renderCommitHeader(p) {
  document.title = `${p.title} · ${p.owner}/${p.repo}@${p.sha.slice(0, 7)} · Rico`;
  $('#pr-title').textContent = p.title;
  $('#pr-num').textContent = p.sha.slice(0, 7);
  const badge = $('#pr-state');
  badge.className = 'State State--commit';
  badge.innerHTML = `${icon('git-commit')} Commit`;
  const meta = $('#pr-meta');
  meta.textContent = '';
  const ref = (sha) => { const a = el('a', 'commit-ref', sha.slice(0, 7)); a.href = `${new URL(p.url).origin}/${p.owner}/${p.repo}/commit/${sha}`; a.target = '_blank'; a.rel = 'noopener noreferrer'; return a; };
  const msg = commitMessageParts(p.message);
  const person = (login, avatar) => { const s = el('span', 'person'); s.append(avatarEl(login, avatar), el('b', null, login)); return s; };
  meta.append(person(p.author || p.authorName || 'someone', p.authorAvatar));
  if (msg.coAuthors.length) meta.append(` and ${msg.coAuthors.map((c) => c.name).join(', ')}`);
  meta.append(` authored${p.createdAt ? ' ' + ago(p.createdAt) : ''}`);
  const differs = p.committer && p.committer !== p.author && p.committerName !== p.authorName;
  if (differs) meta.append(' and ', person(p.committer, p.committerAvatar), ` committed${p.committedAt ? ' ' + ago(p.committedAt) : ''}`);
  if (p.verified) { const v = el('span', 'Label Label--success', 'Verified'); v.title = 'GitHub verified this commit’s signature'; meta.append(' ', v); }
  meta.append(' · ', ref(p.sha));
  const copy = el('button', 'btn-link copy');
  copy.type = 'button'; copy.title = 'Copy the full SHA'; copy.setAttribute('aria-label', 'Copy the full SHA');
  copy.innerHTML = icon('copy');
  copy.addEventListener('click', () => navigator.clipboard?.writeText(p.sha).catch(() => {}));
  meta.append(copy);
  if (p.branch) { // opened from a branch: the address bar pins this commit and keeps following the branch
    const b = el('a', 'commit-ref', p.branch);
    b.href = `${new URL(p.url).origin}/${p.owner}/${p.repo}/tree/${p.branch.split('/').map(encodeURIComponent).join('/')}`;
    b.target = '_blank'; b.rel = 'noopener noreferrer';
    meta.append(' · on ', b, ' ');
    const latest = el('button', 'btn btn-sm', 'Check for newer');
    latest.type = 'button';
    latest.id = 'branch-latest';
    latest.title = `Look for a newer commit on ${p.branch}`;
    latest.addEventListener('click', async () => {
      if (state.stale) return goLatest();
      latest.disabled = true; latest.textContent = 'Checking…';
      await refreshComments(true);
      latest.disabled = false;
      latest.textContent = state.stale ? 'Go to latest' : 'Up to date';
      if (!state.stale) setTimeout(() => { if (latest.isConnected && !state.stale) latest.textContent = 'Check for newer'; }, 2500);
    });
    meta.append(latest);
  }
  // the rest of the message, as GitHub shows it under the title (trailers like Co-authored-by sit in the line above)
  const info = $('#commit-info');
  info.textContent = '';
  if (msg.body) info.append(el('pre', 'commit-body', msg.body));
  const extra = msg.trailers.filter((t) => !/^co-authored-by$/i.test(t.key));
  if (extra.length) info.append(el('div', 'commit-trailers', extra.map((t) => `${t.key}: ${t.value}`).join('\n')));
  info.hidden = !info.childNodes.length;
  if (p.parents?.length) meta.append(` · ${p.parents.length > 1 ? 'parents' : 'parent'} `, ...p.parents.flatMap((s, i) => (i ? [' + ', ref(s)] : [ref(s)])));
  else meta.append(' · no parent (the first commit)');
  // Say plainly where comments go: on the commit page, not in a pull request's conversation (GitHub keeps them apart too)
  const note = $('#commit-note');
  note.textContent = '';
  note.append(el('span', 'cn-icon'), el('b', null, p.branch ? `You are reviewing the latest commit on ${p.branch}, not the whole branch.` : 'You are reviewing a single commit.'), ` Comments here are commit comments: they appear on the commit’s own page on GitHub, not in any pull request, and each sits on one line. No reviews, suggestions or resolving.`);
  note.querySelector('.cn-icon').innerHTML = icon('git-commit');
  if (p.pulls?.length) {
    const line = el('div', 'cn-prs');
    line.append(`This commit is in ${p.pulls.length === 1 ? 'a pull request' : 'pull requests'}; to comment in the review, open `);
    p.pulls.forEach((pr, i) => {
      if (i) line.append(', ');
      const link = el('a', null, `#${pr.number} ${pr.title}`);
      link.href = prPath({ owner: p.owner, repo: p.repo, number: pr.number });
      link.title = `Review pull request #${pr.number} in Rico (${pr.state})`;
      line.append(link);
    });
    line.append('.');
    note.append(line);
  }
  $('#c-kind').innerHTML = `${icon('git-commit')} Commit comment on <code>${esc(p.sha.slice(0, 7))}</code>`;
  const nav = $('#tabs');
  nav.textContent = '';
  const a = el('a');
  a.innerHTML = `${icon('git-commit')}<span>On GitHub</span>`;
  if (p.commitComments) a.append(Object.assign(el('span', 'Counter'), { textContent: String(p.commitComments) }));
  a.href = p.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
  const files = el('a');
  files.innerHTML = `${icon('diff')}<span>Files changed</span>`;
  files.append(Object.assign(el('span', 'Counter'), { textContent: String(p.changedFiles) }));
  files.setAttribute('aria-current', 'page');
  nav.append(files, a);
  $('#totals').innerHTML = `<b>${p.changedFiles}</b> changed file${p.changedFiles === 1 ? '' : 's'} &nbsp;<span class="add">+${p.additions}</span> <span class="del">−${p.deletions}</span>`;
}

// ----- file tree (all changed files; markdown ones open here, the rest link to GitHub) -----
function renderFiles() {
  const nav = $('#files');
  nav.textContent = '';
  const p = state.pr;
  if (!p) return;
  const steps = !!state.spec?.on && state.treeMode === 'steps';
  $('#tree-mode').hidden = !state.spec?.on;
  for (const b of $('#tree-mode').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.tree === state.treeMode));
  if (steps) return renderSteps(nav);
  const all = p.allFiles || p.files;
  const reviewable = new Set(p.files.map((f) => f.filename));
  const filter = $('#tree-filter').value.trim().toLowerCase();
  const matches = (n) => (n.type === 'file' ? n.path.toLowerCase().includes(filter) : n.children.some(matches));
  const viewedN = p.files.filter((f) => state.viewed.has(f.filename)).length;
  $('#viewed-count').textContent = p.files.length ? `${viewedN} / ${p.files.length} markdown files viewed` : '';
  const walk = (nodes, depth) => {
    for (const n of nodes) {
      if (filter && !matches(n)) continue;
      if (n.type === 'dir') {
        const open = filter || !state.closedDirs.has(n.path);
        const row = el('div', 'tree-dir');
        row.style.setProperty('--depth', depth);
        row.tabIndex = 0;
        row.setAttribute('role', 'button');
        row.setAttribute('aria-expanded', String(!!open));
        row.innerHTML = `${icon(open ? 'chevron-down' : 'chevron-right')}${icon(open ? 'file-directory-open-fill' : 'file-directory-fill', { cls: 'fold' })}<span class="nm">${esc(n.name)}</span>`;
        const toggle = () => { if (state.closedDirs.has(n.path)) state.closedDirs.delete(n.path); else state.closedDirs.add(n.path); renderFiles(); };
        row.addEventListener('click', toggle);
        row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
        nav.append(row);
        if (open) walk(n.children, depth + 1);
        continue;
      }
      const f = n.file;
      const stIcon = { added: 'diff-added', removed: 'diff-removed', renamed: 'diff-renamed' }[f.status] || 'diff-modified';
      const stCls = { added: 'st-added', removed: 'st-removed', renamed: 'st-renamed' }[f.status] || 'st-modified';
      const count = state.threads.filter((t) => t.path === n.path).length;
      const inner = `${icon(stIcon, { cls: stCls })}<span class="nm" title="${esc(n.path)}">${esc(n.name)}</span>`
        + (state.viewed.has(n.path) ? `<span class="tick" title="Viewed">${icon('check')}</span>` : state.dismissed.has(n.path) ? `<span class="tick changed" title="Viewed before, but changed since" aria-label="Changed since you viewed it">●</span>` : '')
        + (count ? `<span class="Counter" title="${count} comment${count > 1 ? 's' : ''}">${count}</span>` : '');
      let row;
      if (reviewable.has(n.path)) {
        row = el('button', 'tree-file');
        row.type = 'button';
        row.dataset.path = n.path;
        if (cur && cur.file.filename === n.path) row.setAttribute('aria-current', 'true');
        row.addEventListener('click', () => openFile(n.path));
      } else { // not markdown (or deleted): GitHub is the place to review it
        row = el('a', 'tree-file dim');
        const filesUrl = p.kind === 'commit' ? p.url : `${p.url}/files`;
        row.href = filesUrl;
        row.target = '_blank';
        row.rel = 'noopener noreferrer';
        row.title = 'Not reviewable in Rico: opens on GitHub';
        diffAnchor(n.path).then((h) => { row.href = `${filesUrl}#${h}`; }).catch(() => {});
      }
      row.style.setProperty('--depth', depth);
      row.innerHTML = inner;
      nav.append(row);
    }
  };
  walk(buildFileTree(all), 0);
}

// ----- file cards -----
function buildCards() {
  const host = $('#cards');
  host.textContent = '';
  views.clear();
  cur = null; doc = null; margin = null;
  hideComposer();
  for (const f of orderedFiles()) {
    const v = makeView(f);
    views.set(f.filename, v);
    host.append(v.card);
  }
  $('#legend').hidden = false;
}

function makeView(f) {
  const card = el('section', 'file-card');
  card.dataset.path = f.filename;
  const slash = f.filename.lastIndexOf('/');
  const head = el('header', 'file-header');
  const chev = el('button', 'chev');
  chev.type = 'button';
  chev.innerHTML = icon('chevron-down');
  chev.setAttribute('aria-label', 'Collapse file');
  chev.setAttribute('aria-expanded', 'true');
  const name = el('div', 'fname');
  name.innerHTML = `${esc(f.filename.slice(0, slash + 1))}<b>${esc(f.filename.slice(slash + 1))}</b>`;
  const copy = el('button', 'btn-link copy');
  copy.type = 'button';
  copy.title = 'Copy path';
  copy.setAttribute('aria-label', 'Copy path');
  copy.innerHTML = icon('copy');
  copy.addEventListener('click', () => { navigator.clipboard?.writeText(f.filename).catch(() => {}); });
  const stat = el('span', 'diffstat');
  if (f.ref) stat.innerHTML = `<span class="badge ref" title="This file is not part of the PR. It is here to read beside the changes; comments on it go on the pull request.">Unchanged · for reference</span>`;
  else stat.innerHTML = `<span class="add">+${f.additions}</span><span class="del">−${f.deletions}</span><span class="sqs">${[...statBlocks(f.additions, f.deletions)].map((c) => `<i class="sq ${c === 'n' ? '' : c}"></i>`).join('')}</span>`;
  const seg = el('div', 'seg');
  seg.setAttribute('role', 'group');
  seg.setAttribute('aria-label', 'Display');
  const mk = (label, mode, pressed) => { const b = el('button', null, label); b.type = 'button'; b.dataset.mode = mode; b.setAttribute('aria-pressed', String(pressed)); return b; };
  seg.append(mk('Rendered', 'rendered', true), ...(f.ref ? [] : [mk('Source diff', 'source', false)]));
  const viewed = el('label', 'viewed');
  const vcb = el('input');
  vcb.type = 'checkbox';
  vcb.checked = state.viewed.has(f.filename);
  viewed.append(vcb, ' Viewed');
  viewed.hidden = !!f.ref;
  head.append(chev, name, copy, stat, seg, viewed);

  const v = {
    file: f, card, lines: [], diff: { hunks: [], added: new Set() }, rows: [], loaded: false, loading: null, mode: 'rendered', marginItems: [],
    doc: el('div', 'rico-doc markdown-body'), margin: el('div', 'rico-margin'), src: el('div', 'rico-src'),
  };
  v.track = el('div', 'rico-track'); // the cards; in synced mode this slides inside the sticky margin
  v.margin.append(v.track);
  v.up = el('button', 'cnt up'); v.down = el('button', 'cnt down'); // "▲ 3 above" / "▼ 8 below": threads outside the visible margin
  for (const b of [v.up, v.down]) { b.type = 'button'; b.hidden = true; }
  v.margin.append(v.up, v.down);
  v.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); // ribbons tying each card to its text
  v.svg.setAttribute('class', 'rico-ribbons');
  v.svg.setAttribute('aria-hidden', 'true');
  const body = el('div', 'file-body');
  body.append(v.doc, v.margin, v.svg);
  const more = el('button', 'btn load-more', 'Load file');
  more.type = 'button';
  more.addEventListener('click', () => openFile(f.filename));
  v.doc.append(more);
  v.vcb = vcb;
  v.chev = chev;
  v.next = el('div', 'file-next'); // spec review: on to the next artifact
  v.next.hidden = true;
  card.append(head, body, v.src, v.next);
  card.classList.toggle('collapsed', vcb.checked || !!f.ref);
  if (f.ref) chev.setAttribute('aria-expanded', 'false');
  chev.addEventListener('click', () => { const c = card.classList.toggle('collapsed'); chev.setAttribute('aria-expanded', String(!c)); if (!c) openFile(f.filename); });
  vcb.addEventListener('change', () => setViewed(f.filename, vcb.checked));
  seg.addEventListener('click', (e) => { const b = e.target.closest('button[data-mode]'); if (b) setMode(v, b.dataset.mode); });
  return v;
}

// Point the shared selection / anchoring code at one file. `#doc` / `#margin` mark the active ones.
function use(v) {
  if (!v) return;
  if (cur && cur !== v) { cur.doc.removeAttribute('id'); cur.margin.removeAttribute('id'); }
  cur = v;
  v.doc.id = 'doc';
  v.margin.id = 'margin';
  state.file = v.file;
  state.lines = v.lines;
  state.diff = v.diff;
  doc = v.doc;
  margin = v.margin;
  marginItems = v.marginItems;
}
function withView(v, fn) {
  const prev = cur;
  use(v);
  try { return fn(); } finally { if (prev) use(prev); }
}
const viewOfNode = (n) => {
  const e = n && (n.nodeType === 1 ? n : n.parentElement);
  const c = e && e.closest && e.closest('.file-card');
  return c ? views.get(c.dataset.path) || null : null;
};
const afterChange = () => { renderPanel(); renderFiles(); };
const refreshView = (v) => { if (v.mode === 'source') renderSource(v); else withView(v, renderMargin); afterChange(); };
const refreshAll = () => { for (const v of views.values()) if (v.loaded) { if (v.mode === 'source') renderSource(v); else withView(v, paintBlocks); } afterChange(); };
const scrollToCard = (path) => views.get(path)?.card.scrollIntoView({ block: 'start' });

async function loadView(v) {
  if (v.loaded) return;
  if (!v.loading) {
    v.loading = (async () => {
      const q = new URLSearchParams({ owner: state.pr.owner, repo: state.pr.repo, path: v.file.filename, ref: state.pr.headSha });
      const text = await api('/api/file?' + q);
      v.lines = text.split(/\r?\n/);
      v.diff = parsePatch(v.file.patch);
      v.rows = parsePatchRows(v.file.patch);
      v.oldText = null;
      v.oldLines = null;
      if (state.pr.baseSha && v.rows.some((r) => r.type === 'del')) { // removed blocks are drawn from the old version
        try {
          const q2 = new URLSearchParams({ owner: state.pr.owner, repo: state.pr.repo, path: v.file.previous || v.file.filename, ref: state.pr.baseSha });
          v.oldText = await api('/api/file?' + q2);
          v.oldLines = v.oldText.split(/\r?\n/);
        } catch { /* a bonus: without the old file the Source diff still shows removals */ }
      }
      v.doc.textContent = '';
      v.text = text;
      v.loaded = true;
      withView(v, () => renderDoc(text));
      afterViewLoad(v);
      new ResizeObserver(() => { cancelAnimationFrame(v.raf); v.raf = requestAnimationFrame(() => withView(v, layoutMargin)); }).observe(v.doc);
    })().finally(() => { v.loading = null; });
  }
  await v.loading;
}

async function openFile(filename) {
  const v = views.get(filename);
  if (!v) return;
  hideComposer();
  v.card.classList.remove('collapsed');
  if (!v.loaded) {
    status('Loading file…');
    try { await loadView(v); } catch (e) { status(e.message, true); return; }
    status('');
  }
  use(v);
  syncUrl(filename);
  scrollToCard(filename);
  renderFiles();
  renderSpecBar();
}

function setMode(v, mode) {
  hideComposer();
  v.mode = mode;
  v.card.classList.toggle('src', mode === 'source');
  for (const b of v.card.querySelectorAll('.seg button')) b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
  if (mode === 'source') renderSource(v);
  else withView(v, layoutMargin);
}
// ----- source diff view -----
const mdLine = (text) => {
  try { if (window.hljs) return window.hljs.highlight(text, { language: 'markdown', ignoreIllegals: true }).value; } catch { /* plain */ }
  return esc(text);
};

function renderSource(v) {
  const wrap = v.src;
  wrap.textContent = '';
  if (!v.rows.length) {
    wrap.append(el('div', 'src-empty', v.file.status === 'renamed' ? 'File renamed without changes.' : 'No textual diff is available for this file.'));
    return;
  }
  withView(v, () => {
    const path = v.file.filename;
    const all = [...state.threads, ...state.leftThreads].filter((t) => t.path === path);
    const placed = new Set();
    const table = el('table', 'diff-table');
    const tb = el('tbody');
    const cols = el('colgroup'); // explicit widths: the first row is a one-cell hunk header, which would otherwise split the columns evenly
    for (const w of [56, 56, 22, 0]) { const c = el('col'); if (w) c.style.width = `${w}px`; cols.append(c); }
    table.append(cols, tb);
    v.srcRows = [];
    const threadRow = (cards) => {
      const tr = el('tr', 'thread-row');
      const td = el('td');
      td.colSpan = 4;
      td.append(...cards);
      tr.append(td);
      return tr;
    };
    const numCell = (side, line, plus) => {
      const td = el('td', 'd-num');
      td.dataset.side = side;
      if (line != null) {
        td.dataset.line = line;
        td.append(String(line));
        if (plus) {
          const b = el('button', 'd-plus', '+');
          b.type = 'button';
          b.setAttribute('aria-label', `Add a comment to ${side === 'LEFT' ? 'removed ' : ''}line ${line}`);
          td.append(b);
        }
      }
      return td;
    };
    for (const r of v.rows) {
      if (r.type === 'hunk') {
        const tr = el('tr', 'd-hunk');
        const td = el('td');
        td.colSpan = 4;
        td.textContent = r.text;
        tr.append(td);
        tb.append(tr);
        continue;
      }
      if (r.type === 'meta') { const tr = el('tr', 'd-meta'); const td = el('td'); td.colSpan = 4; td.textContent = r.text; tr.append(td); tb.append(tr); continue; }
      const tr = el('tr', `d-row d-${r.type}`);
      tr.dataset.old = r.old ?? '';
      tr.dataset.new = r.new ?? '';
      const mark = el('td', 'd-mark', r.type === 'add' ? '+' : r.type === 'del' ? '−' : '');
      const code = el('td', 'd-code');
      code.innerHTML = mdLine(r.text);
      tr.append(numCell('LEFT', r.old, r.type === 'del'), numCell('RIGHT', r.new, r.type !== 'del'), mark, code);
      tb.append(tr);
      v.srcRows.push(tr);
      // existing threads and pending comments sit directly under the line they are about
      const side = r.type === 'del' ? 'LEFT' : 'RIGHT';
      const line = side === 'LEFT' ? r.old : r.new;
      const here = all.filter((t) => !t.outdated && t.side === side && t.end === line);
      // context lines exist on both sides: a LEFT thread on a context line sits under it too
      const ctxLeft = r.type === 'ctx' ? all.filter((t) => !t.outdated && t.side === 'LEFT' && t.end === r.old) : [];
      const cards = [...here, ...ctxLeft].map((t) => { placed.add(t.id); return threadCard(t); });
      if (cards.length) tb.append(threadRow(cards));
    }
    const rest = all.filter((t) => !placed.has(t.id));
    if (rest.length) { // outdated threads: GitHub files them away from the lines they used to be on
      const note = el('div', 'src-note', `${rest.length} outdated thread${rest.length > 1 ? 's' : ''} (their lines have since changed)`);
      tb.append(threadRow([note, ...rest.map((t) => threadCard(t))]));
    }
    wrap.append(table);
    v.srcHunks = patchHunkRanges(v.rows);
  });
}

// Click a line's "+" (or its number) to comment on it; shift-click another line on the same side
// to extend to a range. A multi-line comment must stay inside one hunk, so the range stops there.
function onLineClick(v, cell, shift) {
  if (state.pending && $('#c-body').value.trim()) return;
  const side = cell.dataset.side;
  const line = Number(cell.dataset.line);
  if (!line) return;
  let start = line;
  let end = line;
  const hunk = (v.srcHunks || []).map((h) => (side === 'LEFT' ? h.left : h.right)).find((r) => r && line >= r.start && line <= r.end);
  if (shift && v.srcAnchor && v.srcAnchor.side === side && hunk && v.srcAnchor.line >= hunk.start && v.srcAnchor.line <= hunk.end) {
    start = Math.min(v.srcAnchor.line, line);
    end = Math.max(v.srcAnchor.line, line);
  } else v.srcAnchor = { side, line };
  const numOf = (tr) => Number(side === 'LEFT' ? tr.dataset.old : tr.dataset.new); // '' (no number on this side) becomes 0
  const rows = v.srcRows.filter((tr) => numOf(tr) >= start && numOf(tr) <= end);
  const text = rows.map((tr) => tr.querySelector('.d-code').textContent).join('\n');
  const segments = [{ kind: 'code', lang: '', text }];
  const range = document.createRange();
  range.selectNodeContents(rows[rows.length - 1]);
  const rect = rows[0].getBoundingClientRect();
  const last = rows[rows.length - 1].getBoundingClientRect();
  showComposer({
    start, end, side, quote: text, segments, quoteMd: formatQuote(segments), anchor: { start, end, exact: true },
    includeDefault: false, // GitHub already shows these lines
    range, rows, view: v, about: '',
    rect: { left: rect.left, right: last.right, top: rect.top, bottom: last.bottom, width: last.right - rect.left, height: last.bottom - rect.top },
  });
}



// ---------- rendering the document ----------
// Removed blocks (GitHub's red blocks) are drawn from the OLD file, so their data-l is in old line numbers.
const isRemoved = (el) => !!(el && el.closest && el.closest('.rm'));
const linesOf = (el) => (isRemoved(el) ? (cur && cur.oldLines) || [] : state.lines);
const blockLines = (el) => {
  const [a, b] = el.dataset.l.split('-').map(Number);
  return trimBlock(linesOf(el), a, b);
};
const overlaps = (b, s, e) => b.s <= e && b.e >= s;
const leafBlocks = (root) => [...root.querySelectorAll('[data-l]')].filter((e) => !e.querySelector('[data-l]'));

// Put the blocks that were removed back where they were, in red, like GitHub's rich diff.
function renderRemoved(v) {
  if (!v.oldText) return;
  const runs = patchDeletions(v.rows);
  if (!runs.length) return;
  const old = el('div');
  old.innerHTML = safeHtml(md.render(v.oldText));
  const oldLeaves = leafBlocks(old).map((e) => { const [a, z] = e.dataset.l.split('-').map(Number); return { e, b: trimBlock(v.oldLines, a, z) }; });
  const newLeaves = leafBlocks(v.doc).map((e) => ({ e, b: blockLines(e) }));
  const used = new Set();
  for (const run of runs) {
    const mine = oldLeaves.filter((l) => !used.has(l.e) && overlaps(l.b, run.oldStart, run.oldEnd));
    mine.forEach((l) => used.add(l.e));
    const ti = newLeaves.findIndex((l) => l.b.e >= run.afterNew + 1); // the first block that comes after the removal
    const target = ti >= 0 ? newLeaves[ti] : null;
    const prev = ti > 0 ? newLeaves[ti - 1] : ti < 0 ? newLeaves[newLeaves.length - 1] || null : null;
    const clones = mine.map((l) => placeRemoved(v, old, l.e, target, prev, run.afterNew));
    // word-level marks: pair the removed blocks with the changed new blocks that follow, by position within the run
    if (ti >= 0) {
      const added = []; // the changed blocks that follow the removal directly: a removal and an addition elsewhere are not one edit
      for (const l of newLeaves.slice(ti)) { let ch = false; for (let n = l.b.s; n <= l.b.e && !ch; n++) ch = v.diff.added.has(n); if (!ch) break; added.push(l); }
      clones.forEach((c, i) => { if (c && added[i] && !(mergeWordsOn && mergeWords(c, added[i].e))) markWords(c, added[i].e); });
    }
  }
}

// GitHub-style merged paragraph: the new block keeps its place, and the words that were removed are shown inline (struck
// through) where they used to be, next to the inserted ones (underlined). The old block stays in the document, collapsed
// (.away), as the anchor for comments on old lines. Selection code reads three kinds of text inside such a block:
// unchanged and inserted words are the new file (RIGHT), words inside .wdel are the old file (LEFT).
let mergeWordsOn = (() => { try { return localStorage.getItem('rico:merge') !== 'off'; } catch { return true; } })();
function mergeWords(oldEl, newEl) {
  const tag = oldEl.tagName;
  if (tag !== newEl.tagName || !/^(P|H[1-6]|LI)$/.test(tag) || newEl.querySelector('ul,ol') || oldEl.querySelector('ul,ol') || newEl.querySelector('.wdel')) return false;
  const oldText = oldEl.textContent;
  const newText = newEl.textContent;
  const { groups, same } = diffGroups(oldText, newText, 3);
  if (!same || !groups.length) return false; // nothing in common: it is a rewrite, keep the two whole blocks
  wrapRanges(newEl, groups.filter((g) => g.ins).map((g) => g.ins), 'wa');
  for (const g of groups.filter((x) => x.del).reverse()) insertDeleted(newEl, g.at, oldText.slice(g.del[0], g.del[1]).replace(/\s+/g, ' '), newText);
  newEl.classList.add('wmerge');
  newEl.dataset.lo = oldEl.dataset.l;
  oldEl.closest('.rm').classList.add('away');
  return true;
}

function insertDeleted(root, at, text, newText) {
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.parentElement.closest('.wdel') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) });
  let ref = null;
  for (let n = w.nextNode(), pos = 0; n; n = w.nextNode()) {
    const end = pos + n.data.length;
    if (at >= pos && at < end) { ref = at > pos ? n.splitText(at - pos) : n; break; }
    pos = end;
  }
  let anchor = ref;
  while (anchor && anchor.parentNode !== root && !anchor.previousSibling && anchor.parentNode.classList.contains('wa')) anchor = anchor.parentNode; // before the insertion, not inside it
  const insHere = !!(anchor && anchor.classList && anchor.classList.contains('wa'));
  const d = el('del', 'wdel', text);
  const frag = document.createDocumentFragment();
  if (at > 0 && !/\s/.test(newText[at - 1])) frag.append(' ');
  frag.append(d);
  if (at < newText.length && !/\s/.test(newText[at]) && !insHere) frag.append(' ');
  (anchor ? anchor.parentNode : root).insertBefore(frag, anchor || null);
}

// Wrap the words that differ between a removed block and its new counterpart (text nodes only: the text and data-l stay the same).
function markWords(oldEl, newEl) {
  if (oldEl.tagName !== newEl.tagName || /^(PRE|FIGURE|TABLE|UL|OL)$/.test(oldEl.tagName)) return;
  const d = wordDiff(oldEl.textContent, newEl.textContent);
  if (!d.same || (!d.del.length && !d.add.length)) return; // nothing in common: it is a rewrite, keep the whole-block marks
  wrapRanges(oldEl, d.del, 'wd');
  wrapRanges(newEl, d.add, 'wa');
}

function wrapRanges(root, ranges, cls) {
  if (!ranges.length) return;
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  for (let n = w.nextNode(), pos = 0; n; n = w.nextNode()) { nodes.push({ n, s: pos }); pos += n.data.length; }
  for (const { n, s } of nodes.reverse()) { // back to front, so splitting a node never shifts the ones still to do
    const e = s + n.data.length;
    for (const [a, z] of [...ranges].reverse()) {
      const from = Math.max(a, s) - s;
      const to = Math.min(z, e) - s;
      if (from >= to) continue;
      const mid = n.splitText(from);
      mid.splitText(to - from);
      const span = el('span', cls);
      mid.replaceWith(span);
      span.append(mid);
    }
  }
}

function placeRemoved(v, oldRoot, L, target, prev, afterNew) {
  const isDia = L.matches('figure.dia');
  let clone;
  if (isDia) { // a removed diagram is shown as its source
    const pre = el('pre');
    const code = el('code');
    code.dataset.l = L.dataset.l;
    code.dataset.k = 'fence';
    code.textContent = L.querySelector('pre code').textContent;
    pre.append(code);
    clone = pre;
  } else clone = L.cloneNode(true);
  const kind = L.tagName;
  if (!isDia && (kind === 'LI' || kind === 'TR')) { // an item or a row goes back inside its list or table
    clone.classList.add('rm');
    clone.title = 'Removed in this PR';
    if (target && target.e.tagName === kind && target.e.parentNode) { target.e.parentNode.insertBefore(clone, target.e); return clone; }
    if (prev && prev.e.tagName === kind && prev.b.e === afterNew && prev.e.parentNode) { prev.e.parentNode.insertBefore(clone, prev.e.nextSibling); return clone; }
  }
  let inner = clone; // otherwise a standalone block, wrapped in clones of its old ancestors (list, table, blockquote…)
  if (!isDia) for (let a = L.parentElement; a && a !== oldRoot; a = a.parentElement) { const c = a.cloneNode(false); c.append(inner); inner = c; }
  const wrap = el('div', 'rm');
  wrap.title = 'Removed in this PR';
  wrap.append(inner);
  let top = target && target.e;
  while (top && top.parentNode !== v.doc) top = top.parentNode;
  v.doc.insertBefore(wrap, top || null);
  return clone;
}

function renderDoc(text) {
  doc.innerHTML = safeHtml(md.render(text));
  $('#legend').hidden = false;
  renderRemoved(cur);
  decorateSpec(cur);
  paintBlocks();
  repaintSince(cur);
  renderDiagrams(cur); // async; diagrams fill in when their renderer is ready
}

function paintBlocks() {
  const wholeFileAdded = state.file.status === 'added';
  for (const el of doc.querySelectorAll('[data-l]')) {
    el.classList.remove('chg', 'ctx', 'out', 'gone', 'has-c', 'has-t', 'hl', 'pending');
    if (el.querySelector('[data-l]')) continue; // only leaf blocks get markers
    const b = blockLines(el);
    if (isRemoved(el)) { // old-numbered: only left-side comments and threads concern it
      el.classList.add('gone');
      if (state.leftThreads.some((t) => t.path === state.file.filename && overlaps(b, t.start, t.end))) el.classList.add('has-t');
      continue;
    }
    let changed = false;
    for (let l = b.s; l <= b.e && !changed; l++) changed = state.diff.added.has(l);
    if (changed && !wholeFileAdded) el.classList.add('chg');
    else if (state.diff.hunks.some((h) => overlaps(b, h.start, h.end))) el.classList.add('ctx');
    else el.classList.add('out');
    if (state.threads.some((t) => t.pending && t.path === state.file.filename && overlaps(b, t.start, t.end))) el.classList.add('has-c');
    if (state.threads.some((t) => t.path === state.file.filename && overlaps(b, t.start, t.end))) el.classList.add('has-t');
  }
  renderMargin();
}

// ---------- threads in the margin (existing, pending, and the one you just posted) ----------
function groupThreads(list) {
  const byId = new Map(list.map((c) => [c.id, c]));
  const rootOf = (c) => { let r = c; for (let i = 0; r.replyTo && byId.has(r.replyTo) && i < 50; i++) r = byId.get(r.replyTo); return r; };
  const groups = new Map();
  for (const c of list) {
    const r = rootOf(c);
    if (!groups.has(r.id)) groups.set(r.id, { root: r, msgs: [] });
    groups.get(r.id).msgs.push(c);
  }
  const threads = [];
  const removed = [];
  const left = [];
  for (const { root, msgs } of groups.values()) {
    msgs.sort((a, b) => (a.id === root.id ? -1 : b.id === root.id ? 1 : Date.parse(a.createdAt) - Date.parse(b.createdAt)));
    const end = root.line ?? root.originalLine ?? 1;
    const start = Math.min(end, root.startLine ?? root.originalStartLine ?? end);
    const th = { id: root.id, kind: 'review', path: root.path, start, end, msgs, side: root.side === 'LEFT' ? 'LEFT' : 'RIGHT', outdated: root.line == null, fileLevel: root.line == null && root.originalLine == null, info: root.thread || null, pending: !!root.pending };
    if (th.side === 'LEFT') { removed.push(root.path); left.push(th); continue; } // base-file line numbers: shown in the source diff
    threads.push(th);
  }
  return { threads, removed, left };
}

const issueThread = (c) => ({ id: 'i' + c.id, kind: 'issue', msgs: [c], side: 'RIGHT' });

/** Take comments from the server (the PR, or a refresh), keeping the ones still being posted. */
function applyComments(data) {
  const local = [...state.threads, ...state.leftThreads].filter((t) => t.local);
  const g = groupThreads(data.comments || []);
  for (const t of g.threads) applyReanchor(t);
  state.threads = g.threads;
  state.leftThreads = g.left;
  state.removed = g.removed;
  for (const t of local) (t.side === 'LEFT' ? state.leftThreads : state.threads).push(t);
  state.prThreads = [...(data.prComments || []).map(issueThread), ...state.prThreads.filter((t) => t.local)];
  if (data.viewer) state.me = data.viewer;
  state.pendingReview = data.pendingReview || null;
  state.canThread = !!data.canThread;
}

const hue = (str) => [...str].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) % 360, 7);
function ago(iso) {
  const d = (Date.now() - Date.parse(iso)) / 1000;
  if (!(d >= 0)) return '';
  for (const [name, sec] of [['year', 31536000], ['month', 2592000], ['day', 86400], ['hour', 3600], ['minute', 60]]) {
    if (d >= sec) { const n = Math.floor(d / sec); return n === 1 && name === 'day' ? 'yesterday' : `${n} ${name}${n > 1 ? 's' : ''} ago`; }
  }
  return 'just now';
}
const ASSOC = { OWNER: 'Owner', MEMBER: 'Member', COLLABORATOR: 'Collaborator', CONTRIBUTOR: 'Contributor', FIRST_TIME_CONTRIBUTOR: 'First-time contributor' };
function avatarEl(user, url) {
  const initial = () => { const a = el('span', 'av', (user[0] || '?').toUpperCase()); a.style.background = `hsl(${hue(user)} 55% 42%)`; return a; };
  if (!url) return initial();
  const img = el('img', 'avatar');
  img.alt = '';
  img.src = url;
  img.loading = 'lazy';
  img.referrerPolicy = 'no-referrer';
  img.addEventListener('error', () => img.replaceWith(initial()), { once: true });
  return img;
}

const EMOJI = { '+1': '👍', '-1': '👎', laugh: '😄', hooray: '🎉', confused: '😕', heart: '❤️', rocket: '🚀', eyes: '👀' };
const btn = (label, cls = 'btn', title) => { const b = el('button', cls, label); b.type = 'button'; if (title) b.title = title; return b; };
/** Show an error under a form; a signed-out failure also offers the way back in (the typed text is already saved). */
function showErr(node, e) {
  node.textContent = e.message || String(e);
  if (e.signin || (state.preview && /sign in/i.test(e.message || ''))) {
    const a = node.appendChild(el('a', null, ' Sign in with GitHub'));
    a.href = signinUrl();
    node.append(' — your text is saved and will be here when you are back.');
  }
}

function reactionsRow(c, th, rerender, host) {
  const row = el('div', 'reacts');
  const err = el('div', 'err');
  const toggle = async (content) => {
    const mine = (c.reactions || []).find((r) => r.content === content && r.mine);
    if (mine && !c.nodeId) return;
    const before = JSON.stringify(c.reactions || []);
    const list = (c.reactions || []).map((r) => ({ ...r }));
    const cur1 = list.find((r) => r.content === content);
    if (mine) { cur1.count--; cur1.mine = false; } else if (cur1) { cur1.count++; cur1.mine = true; } else list.push({ content, count: 1, mine: true });
    c.reactions = list.filter((r) => r.count > 0);
    rerender();
    try {
      await apiPost('/api/reaction', { ...prRef(), kind: th.kind, commentId: c.id, content, ...(mine ? { remove: true, nodeId: c.nodeId } : {}) });
    } catch (e) { c.reactions = JSON.parse(before); rerender(); showErr(err, e); host.append(err); }
  };
  for (const r of c.reactions || []) {
    const b = btn(`${EMOJI[r.content] || r.content} ${r.count}`, 'react' + (r.mine ? ' mine' : ''), `${r.content}${r.mine ? ' (you)' : ''}`);
    b.disabled = state.preview;
    b.addEventListener('click', () => toggle(r.content));
    row.append(b);
  }
  let add = null;
  if (!state.preview) { // the ☺ lives in the comment's header, so a comment without reactions costs no extra row
    add = btn('☺', 'react add', 'Add a reaction');
    add.setAttribute('aria-label', 'Add a reaction');
    add.addEventListener('click', () => {
      const old = host.querySelector('.picker');
      if (old) return old.remove();
      const pick = el('span', 'picker');
      for (const [k, e] of Object.entries(EMOJI)) { const b = btn(e, 'react', k); b.addEventListener('click', () => toggle(k)); pick.append(b); }
      host.append(pick);
    });
  }
  return { row: row.childNodes.length ? row : null, add };
}

/** A ```suggestion block reads as a diff against the lines it replaces, like on GitHub. */
function showSuggestions(text, th) {
  for (const code of text.querySelectorAll('pre > code.language-suggestion')) {
    const next = code.textContent.replace(/\n$/, '');
    const old = th.kind === 'review' && th.side !== 'LEFT' && !th.outdated ? views.get(th.path)?.lines?.slice(th.start - 1, th.end) : null;
    const box = el('div', 'sugg');
    box.append(el('div', 'sugg-head', 'Suggested change'));
    for (const r of old ? lineDiff(old, next === '' ? [] : next.split('\n')) : (next === '' ? [] : next.split('\n')).map((t) => ({ type: 'add', text: t }))) {
      const row = el('div', 'sg-' + r.type);
      row.append(el('span', 'sg-mark', r.type === 'add' ? '+' : r.type === 'del' ? '−' : ' '), el('code', null, r.text || ' '));
      box.append(row);
    }
    code.parentElement.replaceWith(box);
  }
}

const armedDeletes = new Map(); // comment id -> when its Delete was first clicked
function msgEl(c, th, rerender) {
  const d = el('div', 'msg' + (c.failed ? ' failed' : ''));
  const who = el('div', 'who');
  const when = el('a', null, c.posting ? 'posting…' : `commented${isCommit() ? ` on ${state.pr.sha.slice(0, 7)}` : ''} ${ago(c.createdAt)}`);
  if (!c.posting && /^https:\/\//.test(c.url || '')) { when.href = c.url; when.target = '_blank'; when.rel = 'noopener noreferrer'; when.title = 'Link to this comment on GitHub'; }
  who.append(avatarEl(c.user, c.avatar), el('b', null, c.user), when);
  if (c.edited ?? (c.updatedAt && c.createdAt && Date.parse(c.updatedAt) - Date.parse(c.createdAt) > 2000)) who.append(el('span', 'edited', 'edited'));
  if (ASSOC[c.assoc]) who.append(el('span', 'badge', ASSOC[c.assoc]));
  if (c.pending) who.append(el('span', 'badge', 'Pending'));
  const text = el('div', 'text markdown-body');
  text.innerHTML = safeHtml(mdc.render(c.body));
  showSuggestions(text, th);
  const err = el('div', 'err');
  const rx = !c.posting && !c.failed ? reactionsRow(c, th, rerender, d) : { row: null, add: null };
  if (!c.posting && !c.failed && !state.preview && (c.canUpdate || c.canDelete || rx.add)) {
    const acts = el('span', 'macts');
    if (rx.add) acts.append(rx.add);
    if (c.canUpdate) {
      const edit = btn('Edit', 'linkish');
      edit.addEventListener('click', () => {
        const ta = el('textarea');
        ta.rows = 4; ta.value = c.body;
        const save1 = btn('Update comment', 'btn btn-primary');
        const cancel = btn('Cancel');
        const form = el('div', 'reply');
        const row = el('div', 'row');
        row.append(save1, cancel);
        form.append(ta, row, err);
        text.replaceWith(form);
        ta.focus();
        cancel.addEventListener('click', rerender);
        save1.addEventListener('click', async () => {
          if (!ta.value.trim()) return;
          save1.disabled = true;
          try {
            const res = await apiPost('/api/comment/edit', { ...prRef(), kind: th.kind, commentId: c.id, text: ta.value, pending: !!c.pending, nodeId: c.nodeId || null });
            c.body = res.body; c.updatedAt = res.updatedAt; c.edited = true;
            rerender();
          } catch (e) { showErr(err, e); save1.disabled = false; }
        });
      });
      acts.append(edit);
    }
    if (c.canDelete) {
      const armed = () => armedDeletes.get(c.id) > Date.now() - 4000; // survives a re-render and a refresh (new objects) between the two clicks
      const del = btn(armed() ? 'Really delete?' : 'Delete', 'linkish danger');
      del.addEventListener('click', async () => {
        if (!armed()) {
          armedDeletes.set(c.id, Date.now());
          del.textContent = 'Really delete?';
          setTimeout(() => { if (!armed() && del.isConnected) del.textContent = 'Delete'; }, 4100);
          return;
        }
        armedDeletes.delete(c.id);
        del.disabled = true;
        try {
          await apiPost('/api/comment/delete', { ...prRef(), kind: th.kind, commentId: c.id });
          th.msgs = th.msgs.filter((m) => m !== c);
          if (!th.msgs.length) removeThread(th);
          rerender();
          refreshComments(true);
        } catch (e) { showErr(err, e); del.disabled = false; del.textContent = 'Delete'; }
      });
      acts.append(del);
    }
    who.append(acts);
  }
  d.append(who, text);
  if (c.failed) {
    err.textContent = '';
    showErr(err, { message: `Not posted: ${c.failed}`, signin: c.signin });
    const row = el('div', 'row');
    const retry = btn('Try again', 'btn btn-primary');
    retry.addEventListener('click', () => th.retry && th.retry());
    const drop = btn('Discard');
    drop.addEventListener('click', () => { removeThread(th); rerender(); });
    row.append(retry, drop);
    d.append(err, row);
  } else { if (rx.row) d.append(rx.row); d.append(err); }
  return d;
}

function removeThread(th) {
  state.threads = state.threads.filter((t) => t !== th);
  state.leftThreads = state.leftThreads.filter((t) => t !== th);
  state.prThreads = state.prThreads.filter((t) => t !== th);
}

function threadCard(th, rerender) {
  const owner = cur; // the file this thread belongs to (callbacks may run while another file is active)
  rerender = rerender || (() => refreshView(owner));
  const resolved = !!th.info?.resolved;
  const card = el('div', 'thread' + (th.outdated ? ' outdated' : '') + (movedOrChanged(th) ? ' reanchored' + (th.reanchor.how === 'fuzzy' ? ' fuzzy' : '') : '') + (th.pending ? ' pending' : '') + (th.kind === 'issue' ? ' pr-level' : '') + (resolved ? ' resolved' : '') + (th.local ? ' local' : ''));
  card.dataset.id = th.id;
  if (resolved && !th.open) { // a resolved thread folds to one line, like Google Docs
    const first = th.msgs[0];
    const m = el('div', 'rmark');
    const show = btn('Show', 'linkish');
    show.addEventListener('click', () => { th.open = true; rerender(); });
    m.append(el('span', 'tick', '✓'), el('span', null, ' Resolved · '), el('b', null, first.user), el('span', 'rtext', ' ' + first.body.replace(/\s+/g, ' ').slice(0, 70)), show);
    card.append(m);
    return card;
  }
  // Long threads fold to the first and the last message; the middle sits behind a "more replies" row. Hovering a moment
  // (or focusing) PEEKS: the full card floats over its neighbours without moving them. Clicking PINS it open in place.
  const n = th.msgs.length;
  const draft = !!draftGet('reply:' + th.id);
  const folded = n >= 3 && !th.pinned && !draft;
  const clamped = !th.pinned && !draft && th.msgs.some((m) => m.body.length > 420);
  if (folded) card.classList.add('folded');
  if (clamped) card.classList.add('clamped');
  const mid = el('div', 'mid');
  th.msgs.forEach((m, i) => {
    const d = msgEl(m, th, rerender);
    if (i === 0 && (th.outdated || th.fileLevel)) d.querySelector('.who').append(el('span', 'badge', th.fileLevel ? 'File comment' : movedOrChanged(th) ? (th.reanchor.how === 'fuzzy' ? 'Outdated · probably here' : 'Outdated · moved') : state.reanchored.get(rkey(th)) === null ? 'Outdated · text not found' : 'Outdated'));
    if (m.bot) d.querySelector('.who')?.append(el('span', 'badge bot', 'agent'));
    if (i === 0 && th.kind === 'issue') d.querySelector('.who').append(el('span', 'badge', `On the ${where()}`));
    if (folded && i > 0 && i < n - 1) mid.append(d); else card.append(d);
    if (i === 0 && th.reanchor) { const tn = thenNowEl(th); if (tn) card.append(tn); }
    if (folded && i === 0) {
      const more = btn('', 'more linkish');
      const who = [...new Set(th.msgs.slice(1, -1).map((x) => x.user))];
      for (const u of who.slice(0, 3)) more.append(avatarEl(u, th.msgs.find((x) => x.user === u).avatar));
      more.append(el('span', null, `${n - 2} more repl${n - 2 === 1 ? 'y' : 'ies'}`));
      more.title = 'Show every reply';
      more.addEventListener('click', () => { th.pinned = true; rerender(); });
      card.append(more, mid);
    }
  });
  if (clamped || folded) {
    let timer = 0;
    card.addEventListener('mouseenter', () => { timer = setTimeout(() => card.classList.add('peek'), 300); });
    card.addEventListener('mouseleave', () => { clearTimeout(timer); card.classList.remove('peek'); });
    card.addEventListener('focusin', (e) => { if (e.target.matches(':focus-visible') && e.target.tagName !== 'TEXTAREA') card.classList.add('peek'); }); // keyboard focus peeks; a mouse click must not shift the layout under the pointer
    card.addEventListener('focusout', (e) => { if (!card.contains(e.relatedTarget)) card.classList.remove('peek'); });
  }
  if (clamped) {
    const more = btn('Show more', 'linkish showmore');
    more.addEventListener('click', () => { th.pinned = true; rerender(); });
    card.append(more);
  }
  if (th.local) return card;
  const acts = el('div', 'tacts');
  let restoreReply = null;
  if (th.kind === 'review' && th.info?.canReply !== false) {
    const replyBtn = btn('Reply');
    const openReply = (text = '', focus = true) => {
      const form = el('div', 'reply');
      const ta = el('textarea');
      ta.rows = 2; ta.placeholder = 'Reply… (Ctrl/Cmd+Enter to send)'; ta.value = text;
      th.pinned = true; card.classList.add('opened'); // replying shows the whole thread
      const row = el('div', 'row');
      const send = btn('Reply', 'btn btn-primary');
      const cancel = btn('Cancel');
      const err = el('div', 'err');
      const doSend = async () => {
        const body = ta.value.trim();
        if (!body) return;
        send.disabled = true;
        err.textContent = '';
        try {
          const res = await apiPost('/api/reply', { ...prRef(), commentId: th.id, text: body });
          res.canUpdate = res.canDelete = true;
          th.msgs.push(res);
          draftSet('reply:' + th.id, null);
          rerender();
        } catch (e) { showErr(err, e); send.disabled = false; }
      };
      send.addEventListener('click', doSend);
      cancel.addEventListener('click', () => { draftSet('reply:' + th.id, null); form.remove(); replyBtn.hidden = false; rerender(); });
      ta.addEventListener('input', () => draftSet('reply:' + th.id, ta.value));
      ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); doSend(); } if (e.key === 'Escape') cancel.click(); });
      row.append(send, cancel);
      form.append(ta, row, err);
      replyBtn.hidden = true;
      acts.before(form);
      if (focus) ta.focus();
      if (focus) withView(owner, layoutMargin);
    };
    replyBtn.addEventListener('click', () => openReply());
    acts.append(replyBtn);
    const saved = draftGet('reply:' + th.id);
    if (saved) restoreReply = () => openReply(saved, false);
  }
  if (th.kind === 'review' && !state.preview && th.info) {
    const flip = async (resolve) => {
      const b = card.querySelector('.rbtn');
      b.disabled = true;
      try {
        const out = await apiPost('/api/thread/resolve', { ...prRef(), threadId: th.info.id, resolved: resolve });
        Object.assign(th.info, { resolved: out.resolved, canResolve: out.canResolve, canUnresolve: out.canUnresolve });
        th.open = false;
        rerender();
      } catch (e) { b.disabled = false; const er = el('div', 'err'); showErr(er, e); card.append(er); }
    };
    if (resolved) { const b = btn('Reopen', 'btn rbtn'); b.disabled = !th.info.canUnresolve; b.addEventListener('click', () => flip(false)); acts.append(b); const hide = btn('Hide', 'linkish'); hide.addEventListener('click', () => { th.open = false; rerender(); }); acts.append(hide); }
    else if (th.info.canResolve) { const b = btn('Resolve', 'btn rbtn'); b.addEventListener('click', () => flip(true)); acts.append(b); }
  }
  if (acts.childNodes.length) card.append(acts);
  if (restoreReply) restoreReply(); // unsent reply text comes back with the card
  return card;
}

let marginItems = [];
state.placed = new Map(); // PR-level thread id -> the file whose margin shows it

// GitHub stores whole lines; the words a comment is about are found again from the quote it carries (no hidden metadata).
/** DOM Range over characters [start, end) of an element's text. */
function domRange(root, start, end) {
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const r = document.createRange();
  let pos = 0;
  let a = false;
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    const len = n.data.length;
    if (!a && start < pos + len) { r.setStart(n, Math.max(0, start - pos)); a = true; }
    if (a && end <= pos + len) { r.setEnd(n, Math.max(0, end - pos)); return r; }
    pos += len;
  }
  return null;
}
/** Ranges for the exact words of a quote, looked for (paragraph by paragraph, in order) in the given blocks. */
function quoteRanges(blocks, quote) {
  const out = [];
  let from = 0;
  for (const part of quoteParts(quote)) {
    for (let i = from; i < blocks.length; i++) {
      const hit = findQuote(blocks[i].textContent, part);
      const r = hit && domRange(blocks[i], hit.start, hit.end);
      if (r) { out.push(r); from = i; break; }
    }
  }
  return out;
}
/** Everything the margin marks as a comment's own words (all files), plus the hovered thread's. */
function paintQuoteHighlights() {
  if (!('highlights' in CSS)) return;
  const all = [];
  for (const v of views.values()) for (const it of v.marginItems || []) if (it.ranges?.length) all.push(...it.ranges);
  CSS.highlights.delete('rico-thread');
  if (all.length) CSS.highlights.set('rico-thread', new Highlight(...all));
}
function hoverRanges(ranges) {
  if (!('highlights' in CSS)) return;
  CSS.highlights.delete('rico-hl');
  if (ranges?.length) CSS.highlights.set('rico-hl', new Highlight(...ranges));
}

/** The block a PR-level comment's quote points at in this file, or null (it then lives under General). */
function issueBlocks(th, path, leaves) {
  const q = parseQuote(th.msgs[0].body);
  if (q.path && q.path !== path) return null;
  const hit = q.quote && leaves.find((l) => findQuote(l.e.textContent, q.quote));
  if (hit) return [hit.e];
  // No findable prose quote (a fenced code or diagram quote, or one shortened with "…"): the header Rico wrote,
  // **`path` L32–65**, still says which lines it is about. Lines are new-file lines: removed text is always in the diff.
  if (q.path !== path || !q.lines) return null;
  const blocks = leaves.filter((l) => overlaps(l.b, q.lines.start, q.lines.end)).map((l) => l.e);
  return blocks.length ? blocks : null;
}

/** PR-level comments nobody can point at: no quote, or the quoted text is not in any file shown. */
function renderGeneral() {
  const box = $('#general');
  if (!box) return;
  const items = state.prThreads.filter((t) => {
    if (state.placed.has(t.id)) return false;
    const q = parseQuote(t.msgs[0].body);
    const v = q.quote && q.path ? views.get(q.path) : null;
    return !(v && !v.loaded); // its file has not loaded yet: it may still find its place
  });
  box.textContent = '';
  box.hidden = !items.length;
  if (!items.length) return;
  box.append(el('h3', null, `General · ${items.length} comment${items.length > 1 ? 's' : ''} on the ${where()}`));
  for (const t of items) box.append(threadCard(t, renderGeneral));
}
function renderMargin() {
  if (!cur || !margin) return;
  cur.track.textContent = '';
  cur.svg.textContent = '';
  marginItems = cur.marginItems = [];
  if (!state.file) return;
  const path = state.file.filename;
  const all = leafBlocks(doc).map((e) => ({ e, b: blockLines(e), rm: isRemoved(e) }));
  const newLeaves = all.filter((l) => !l.rm);
  const oldLeaves = all.filter((l) => l.rm);
  const oldToNew = oldToNewMap(cur.rows);
  const raw = [
    ...state.threads.filter((t) => t.path === path).map((t) => ({ th: t, card: threadCard(t), start: t.start, end: t.end, id: t.id, side: 'RIGHT' })),
    ...state.leftThreads.filter((t) => t.path === path).map((t) => ({ th: t, card: threadCard(t), start: t.start, end: t.end, id: t.id, side: 'LEFT' })),
  ];
  for (const [id, p] of state.placed) if (p === path) state.placed.delete(id);
  for (const t of state.prThreads) { // PR-level comments that quote text from this file sit beside it
    const blocks = issueBlocks(t, path, newLeaves);
    if (!blocks) continue;
    state.placed.set(t.id, path);
    raw.push({ th: t, card: threadCard(t), start: 0, end: 0, id: t.id, side: 'RIGHT', blocks, fixed: true });
  }
  let unplaced = 0;
  for (const it of raw) {
    let blocks;
    if (it.fixed) blocks = it.blocks;
    else if (it.side === 'LEFT') {
      blocks = oldLeaves.filter((l) => overlaps(l.b, it.start, it.end)).map((l) => l.e); // beside the removed block it is about
      if (!blocks.length) { // a comment on an unchanged old line: its new-file counterpart
        const n = oldToNew.get(it.end);
        if (n) blocks = newLeaves.filter((l) => overlaps(l.b, n, n)).map((l) => l.e);
      }
      if (!blocks.length) { unplaced++; continue; }
    } else {
      blocks = newLeaves.filter((l) => overlaps(l.b, it.start, it.end)).map((l) => l.e);
      if (!blocks.length && newLeaves.length) { // outdated lines that no longer exist: nearest block
        it.exact = false;
        const dist = (l) => (l.b.e < it.start ? it.start - l.b.e : l.b.s - it.end);
        blocks = [newLeaves.reduce((a, b) => (dist(b) < dist(a) ? b : a)).e];
      }
    }
    it.blocks = blocks;
    it.th.sinceChanged = !!(state.since && blocks.some((b) => b.classList.contains('since')));
    if (it.th.sinceChanged) it.card.querySelector('.who')?.append(el('span', 'badge changed', 'Text changed'));
    const q = parseQuote(it.th.msgs[0].body).quote; // outdated lines found no block of their own, so there is nothing exact to show
    it.ranges = q && it.exact !== false ? quoteRanges(blocks, q) : [];
    it.card.addEventListener('mouseenter', () => { if (it.ranges.length) hoverRanges(it.ranges); else it.blocks.forEach((b) => b.classList.add('hl')); });
    it.card.addEventListener('mouseleave', () => { hoverRanges(null); it.blocks.forEach((b) => b.classList.remove('hl')); });
    cur.track.append(it.card);
    it.ribbon = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    cur.svg.append(it.ribbon);
    it.card.addEventListener('mouseenter', () => { it.hot = true; scheduleSync(); });
    it.card.addEventListener('mouseleave', () => { it.hot = false; scheduleSync(); });
    marginItems.push(it);
  }
  if (unplaced) { // the old file was unavailable, or the line is not part of what is shown
    const n = el('div', 'note', `${unplaced} thread${unplaced > 1 ? 's' : ''} on removed lines not shown here (see Source diff).`);
    n.dataset.note = '1';
    cur.track.append(n);
  }
  renderGeneral();
  paintQuoteHighlights();
  layoutMargin();
  scheduleTicks();
  scheduleQueue();
}

// Change bars: one fixed gutter column at the document's left edge, whatever the nesting, so they read as a clean
// line of marks like GitHub's rich diff. Each bar spans the element's text (not its heading padding or underline).
const COALESCE_GAP = 8; // px: tighter than a paragraph break (16px), looser than list items or table rows
function layoutBars(root) {
  let layer = root.querySelector(':scope > .rico-bars');
  if (!layer) {
    layer = el('div', 'rico-bars');
    layer.setAttribute('aria-hidden', 'true');
    root.prepend(layer);
  }
  const base = root.getBoundingClientRect().top;
  // two columns: the PR's own diff at the document's edge, and, beside the text, what changed since the baseline (amber; dashed
  // red where text was removed), so "changed in this PR" and "changed since I looked" can be told apart down the whole page
  const kindOf = (e) => (e.classList.contains('rm') ? 'del' : e.classList.contains('chg') ? 'chg' : e.classList.contains('ctx') ? 'ctx' : 'out');
  const sinceKind = (e) => (e.classList.contains('since-gone') ? 'sgone' : 'since');
  const what = state.since ? ({ review: 'your review', visit: 'your last visit' }[state.since.kind] || state.since.sha.slice(0, 7)) : '';
  const bars = [
    ...barRuns(root, '[data-l].chg, [data-l].ctx, [data-l].out, .rm', kindOf),
    ...(state.since ? barRuns(root, '[data-l].since, .since-gone', sinceKind) : []),
  ].map((x) => {
    const bar = document.createElement('i');
    bar.className = x.kind;
    bar.style.top = (x.top - base + 2) + 'px';
    bar.style.height = Math.max(4, x.bottom - x.top - 4) + 'px';
    if (x.kind === 'since') bar.title = `Changed since ${what}`;
    if (x.kind === 'sgone') bar.title = `Text removed since ${what}`;
    return bar;
  });
  layer.replaceChildren(...bars);
}

/** Group the elements matching `selector` into bars: tight neighbours of one kind share a bar. -> [{kind, top, bottom}] (viewport px) */
function barRuns(root, selector, kindOf) {
  const runs = [];
  for (const e of root.querySelectorAll(selector)) {
    const del = e.classList.contains('rm');
    if (del ? e.parentElement.closest('.rm') : e.closest('.rm')) continue; // only the outermost removed element gets a bar
    const r = e.getBoundingClientRect();
    if (!r.height) continue; // collapsed (a closed <details>) or hidden
    const cs = getComputedStyle(e);
    const bottom = r.bottom - (parseFloat(cs.paddingBottom) || 0) - (parseFloat(cs.borderBottomWidth) || 0);
    const kind = kindOf(e);
    const heading = !del && /^H[1-6]$/.test(e.tagName);
    // Neighbouring blocks of the same kind share one bar when they sit tight together (list items, table rows);
    // paragraph breaks and headings always start a new bar.
    const last = runs[runs.length - 1];
    // a run of removed blocks with nothing kept between them is one deletion, so it is one bar whatever the gap
    if (last && !heading && !last.heading && last.kind === kind && (del || r.top - last.rawBottom <= COALESCE_GAP)) {
      last.bottom = Math.max(last.bottom, bottom);
      last.rawBottom = Math.max(last.rawBottom, r.bottom);
    } else runs.push({ kind, heading, top: r.top, bottom, rawBottom: r.bottom });
  }
  return runs;
}

// ---------- margin layout: aligned beside the text, or synced (sticky, non-linear scroll) when comments outgrow the doc ----------
// Aligned: each card sits level with its text, pushed down by the cards above it. When that makes the margin much longer than
// the document, SYNCED takes over: the margin is a sticky, window-high column; the cards are stacked with no gaps, and as you
// scroll the margin slides so the thread at the focus line is level with its text. Between two threads the margin moves at the
// speed that brings the next card level exactly when its text arrives: fast through a long discussion, barely through plain text.
// Ribbons (SVG) tie every card to its words either way.
let marginMode = (() => { try { const m = localStorage.getItem('rico:margin'); return ['auto', 'aligned', 'sync'].includes(m) ? m : 'auto'; } catch { return 'auto'; } })();
const FOCUS = 0.35; // where in the window the "current" text is
const toolbarH = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--toolbar-h')) || 49;

function layoutMargin() {
  if (!margin) return;
  if (doc) layoutBars(doc);
  const v = cur;
  const wide = !matchMedia('(max-width: 1150px)').matches;
  const note = margin.querySelector('[data-note]');
  const body = margin.parentElement;
  v.pts = null;
  body.classList.remove('sync');
  v.track.style.transform = '';
  if (!wide) { margin.style.height = ''; for (const it of marginItems) it.card.style.top = ''; if (note) note.style.top = ''; v.up.hidden = v.down.hidden = true; return; }
  const docTop = doc.getBoundingClientRect().top;
  const placed = marginItems
    .map((it) => ({ it, want: it.blocks.length ? it.blocks[0].getBoundingClientRect().top - docTop : 0 }))
    .sort((a, b) => a.want - b.want);
  let y = 0;
  for (const { it, want } of placed) {
    const top = Math.max(want, y);
    it.card.style.top = top + 'px';
    y = top + it.card.offsetHeight + 8;
  }
  if (note) { note.style.top = y + 'px'; y += note.offsetHeight + 8; }
  const docH = doc.offsetHeight;
  const sync = marginMode === 'sync' ? marginItems.length > 0 : marginMode === 'auto' && y > docH * 1.25 && y > innerHeight * 1.5;
  if (!sync) { margin.style.height = Math.max(y, docH) + 'px'; v.up.hidden = v.down.hidden = true; scheduleSync(); return; }
  // synced: stack with no gaps, remember (text position -> card position) pairs
  margin.style.height = '';
  body.classList.add('sync');
  const pts = [];
  let m = 0;
  for (const { it, want } of placed) {
    it.card.style.top = m + 'px';
    pts.push({ d: want, m });
    m += it.card.offsetHeight + 8;
  }
  if (note) { note.style.top = m + 'px'; m += note.offsetHeight + 8; }
  const viewH = innerHeight - toolbarH() - 24;
  pts.push({ d: Math.max(docH, pts[pts.length - 1].d + 1), m: Math.max(pts[pts.length - 1].m, m - viewH * (1 - FOCUS)) }); // the last cards stay reachable at the end of the file
  v.pts = pts;
  v.trackH = m;
  scheduleSync();
}

const mapD = mapPosition;
const slopeAt = positionSlope;

let syncRaf = 0;
function scheduleSync() { if (!syncRaf) syncRaf = requestAnimationFrame(syncFrame); }
function syncFrame() {
  syncRaf = 0;
  const T = toolbarH();
  const F = T + (innerHeight - T) * FOCUS;
  for (const v of views.values()) {
    if (!v.loaded || v.mode !== 'rendered' || v.card.classList.contains('collapsed')) continue;
    const body = v.margin.parentElement;
    const br = body.getBoundingClientRect();
    if (br.bottom < -200 || br.top > innerHeight + 200) continue;
    const mr0 = v.margin.getBoundingClientRect();
    if (v.pts) { // slide the margin so the thread at the focus line is level with its text
      const d = F - v.doc.getBoundingClientRect().top;
      v.focusD = d;
      v.track.style.transform = `translateY(${F - mr0.top - mapD(v.pts, d)}px)`;
    }
    drawRibbons(v, br);
    drawCounts(v, F);
  }
}

function drawRibbons(v, br) {
  const dr = v.doc.getBoundingClientRect();
  const mr = v.margin.getBoundingClientRect();
  const x1 = dr.right - br.left - 4;
  const x2 = mr.left - br.left;
  const clip = v.pts ? mr : null; // synced: cards outside the sticky window are not visible, so neither are their ribbons
  for (const it of v.marginItems || []) {
    if (!it.ribbon || !it.blocks?.length) continue;
    const ay = it.blocks[0].getBoundingClientRect().top + 12;
    const cy = it.card.getBoundingClientRect().top + 16;
    const hidden = (clip && (cy < clip.top || cy > clip.bottom)) || (ay < -40 && cy < -40) || (ay > innerHeight + 40 && cy > innerHeight + 40);
    it.ribbon.style.display = hidden ? 'none' : '';
    if (hidden) continue;
    const a = ay - br.top;
    const c = cy - br.top;
    const mx = (x1 + x2) / 2;
    it.ribbon.setAttribute('d', `M${x1} ${a} C${mx} ${a} ${mx} ${c} ${x2} ${c}`);
    it.ribbon.classList.toggle('on', !!it.hot || it.card.classList.contains('active') || it.card.classList.contains('peek'));
    it.ribbon.classList.toggle('resolved', !!it.th.info?.resolved);
  }
}

function drawCounts(v, F) {
  if (!v.pts) { v.up.hidden = v.down.hidden = true; return; }
  const mr = v.margin.getBoundingClientRect();
  const above = [];
  const below = [];
  for (const it of v.marginItems) {
    const r = it.card.getBoundingClientRect();
    if (r.bottom < mr.top + 4) above.push(it); else if (r.top > mr.bottom - 4) below.push(it);
  }
  const jump = (list, last) => () => { const it = last ? list[0] : list[list.length - 1]; if (it) window.scrollBy({ top: it.blocks[0].getBoundingClientRect().top - F, behavior: 'smooth' }); };
  v.up.hidden = !above.length;
  v.down.hidden = !below.length;
  v.up.textContent = `▲ ${above.length} above`;
  v.down.textContent = `▼ ${below.length} below`;
  v.up.onclick = jump(above, false);
  v.down.onclick = jump(below, true);
}

// the wheel over a synced margin scrolls the margin at its own speed (the page follows through the same mapping)
$('#cards').addEventListener('wheel', (e) => {
  const col = e.target.closest && e.target.closest('.rico-margin');
  if (!col || e.ctrlKey) return;
  const v = [...views.values()].find((x) => x.margin === col);
  if (!v?.pts || v.focusD == null) return;
  e.preventDefault();
  const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
  window.scrollBy(0, dy / slopeAt(v.pts, v.focusD));
}, { passive: false });
window.addEventListener('scroll', scheduleSync, { passive: true });

// a scrollbar-side overview: one tick per thread in the whole page, coloured by state; click to jump
function drawTicks() {
  let box = $('#ticks');
  if (!box) { box = el('div'); box.id = 'ticks'; box.setAttribute('aria-hidden', 'true'); document.body.append(box); }
  box.textContent = '';
  const total = document.documentElement.scrollHeight;
  for (const v of views.values()) {
    if (!v.loaded || v.mode !== 'rendered' || v.card.classList.contains('collapsed')) continue;
    for (const it of v.marginItems || []) {
      if (!it.blocks?.length) continue;
      const y = it.blocks[0].getBoundingClientRect().top + scrollY;
      const t = el('button', 'tick' + (it.th.info?.resolved ? ' resolved' : it.th.pending ? ' pending' : '') + (it.th.msgs.some((m) => m.user === state.me) ? ' mine' : ''));
      t.type = 'button';
      t.style.top = (y / total) * 100 + '%';
      t.title = `${it.th.msgs[0].user}: ${it.th.msgs[0].body.replace(/\s+/g, ' ').slice(0, 60)}`;
      t.addEventListener('click', () => window.scrollTo({ top: y - innerHeight * 0.3, behavior: 'smooth' }));
      box.append(t);
    }
    if (state.since) { // what changed since the baseline: one mark per stretch, so a long document shows where to look
      const runs = [];
      for (const e of v.doc.querySelectorAll('[data-l].since, .since-gone')) {
        const r = e.getBoundingClientRect();
        if (!r.height) continue;
        const top = r.top + scrollY;
        const last = runs[runs.length - 1];
        if (last && top - last.bottom <= 40) last.bottom = Math.max(last.bottom, top + r.height); else runs.push({ top, bottom: top + r.height });
      }
      for (const run of runs) {
        const t = el('button', 'tick since');
        t.type = 'button';
        t.style.top = (run.top / total) * 100 + '%';
        t.style.height = `max(4px, ${((run.bottom - run.top) / total) * 100}%)`;
        t.title = 'Changed since ' + ({ review: 'your review', visit: 'your last visit' }[state.since.kind] || state.since.sha.slice(0, 7));
        t.addEventListener('click', () => window.scrollTo({ top: run.top - innerHeight * 0.3, behavior: 'smooth' }));
        box.append(t);
      }
    }
    for (const q of v.doc.querySelectorAll('.spec-q:not(.todo)')) { // open questions: the places a spec still needs an answer
      const t = el('button', 'tick q');
      t.type = 'button';
      t.style.top = ((q.getBoundingClientRect().top + scrollY) / total) * 100 + '%';
      t.title = 'Open question: ' + q.textContent.slice(0, 80);
      t.addEventListener('click', () => { q.scrollIntoView({ block: 'center' }); flash(q); });
      box.append(t);
    }
  }
}
let ticksTimer = 0;
const scheduleTicks = () => { clearTimeout(ticksTimer); ticksTimer = setTimeout(drawTicks, 120); };

function activateAt(block) {
  const it = marginItems.find((m) => m.blocks.includes(block));
  if (!it) return;
  marginItems.forEach((m) => m.card.classList.remove('active'));
  it.card.classList.add('active');
  it.card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  setTimeout(() => it.card.classList.remove('active'), 1800);
}
$('#cards').addEventListener('click', (e) => {
  const v = viewOfNode(e.target);
  const cell = e.target.closest && e.target.closest('.d-num');
  if (cell && v && v.mode === 'source') { use(v); onLineClick(v, cell, e.shiftKey); return; }
  const link = e.target.closest && e.target.closest('a[href^="#"]');
  if (link && v) { // our own URL hash holds the PR, so keep fragment links in the page
    e.preventDefault();
    let slug = '';
    try { slug = decodeURIComponent(link.getAttribute('href').slice(1)); } catch { return; } // a malformed escape goes nowhere
    v.doc.querySelector(`[data-slug="${CSS.escape(slug)}"]`)?.scrollIntoView({ block: 'start' });
    return;
  }
  if (!v || v.mode !== 'rendered') return;
  use(v);
  if (!window.getSelection().isCollapsed) return;
  const fig = e.target.closest && e.target.closest('.dia-out');
  if (fig && e.target === fig) onDiagramClick(fig.closest('figure'), null);
  const b = e.target.closest && e.target.closest('[data-l]');
  if (b) activateAt(b.querySelector('[data-l]') ? b : b);
});

// ---------- diagrams (D2, Mermaid, Graphviz) ----------
// Each diagram is drawn inside a sandboxed iframe: no scripts, and a CSP that forbids all network
// requests, so untrusted diagram source can only draw. The frame is same-origin (and script-free) so
// we can see which node or edge was clicked and map it to its source line.
const diaCache = new Map(); // lang + source -> render result | {errors, unavailable}

function showDiagram(fig, res) {
  const out = fig.querySelector('.dia-out');
  out.textContent = '';
  const tools = fig.querySelector('.dia-tools');
  if (res.svg) {
    const frame = document.createElement('iframe');
    frame.className = 'dia-frame';
    frame.setAttribute('sandbox', 'allow-same-origin'); // deliberately NOT allow-scripts
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.title = `${LANG_NAME[fig.dataset.lang]} diagram`;
    frame.srcdoc = frameDoc(res.svg, res.css, res.fontSrc);
    frame.addEventListener('load', () => wireFrame(fig, frame, res));
    out.append(frame);
    // diagrams are capped in height so one big graph cannot push the document off-screen
    if (!tools) {
      const zoom = document.createElement('button');
      zoom.type = 'button';
      zoom.className = 'linkish dia-zoom';
      zoom.textContent = 'Expand';
      zoom.addEventListener('click', () => {
        const big = fig.classList.toggle('big');
        zoom.textContent = big ? 'Shrink' : 'Expand';
        layoutFor(fig);
      });
      const t = document.createElement('div');
      t.className = 'dia-tools';
      t.append(zoom, fig.querySelector('details'));
      fig.append(t);
    }
    return;
  }
  const box = document.createElement('div');
  box.className = 'dia-err';
  box.append(Object.assign(document.createElement('strong'), { textContent: res.unavailable ? 'Diagram rendering is not available' : 'This diagram does not compile' }));
  const ul = document.createElement('ul');
  for (const m of res.errors) ul.append(Object.assign(document.createElement('li'), { textContent: m }));
  box.append(ul);
  out.append(box);
  fig.querySelector('details').open = true; // show the source so the problem is visible
}

let hovered = null;
let marked = null; // the element a pending comment is about
const glow = (el, on) => { if (el) el.style.filter = on ? 'drop-shadow(0 0 4px #2f6fed)' : ''; };
function markElement(el) { glow(marked, false); marked = el; glow(marked, true); }

function wireFrame(fig, frame, res) {
  const d = frame.contentDocument;
  const svg = d && d.querySelector('svg');
  if (!svg) return;
  const fit = () => { frame.style.height = Math.ceil(svg.getBoundingClientRect().height) + 4 + 'px'; layoutFor(fig); };
  fit();
  new ResizeObserver(() => fit()).observe(frame);
  const hit = (t) => { try { return res.resolve(t); } catch { return null; } };
  d.addEventListener('mouseover', (e) => {
    const h = hit(e.target);
    if (hovered && hovered !== marked) glow(hovered, false);
    hovered = h ? h.el : null;
    if (hovered) glow(hovered, true);
    frame.title = h ? `Comment on ${h.kind} ${h.label}` : `${LANG_NAME[fig.dataset.lang]} diagram: click to comment`;
  });
  d.addEventListener('mouseout', () => { if (hovered && hovered !== marked) glow(hovered, false); hovered = null; });
  d.addEventListener('click', (e) => { // capture: also stops links inside the diagram from navigating
    e.preventDefault();
    e.stopPropagation();
    use(viewOfNode(fig)); // clicks inside the frame never reach the page's own handlers
    onDiagramClick(fig, hit(e.target), frame);
  }, true);
}

const layoutFor = (node) => { const v = viewOfNode(node); if (v) withView(v, layoutMargin); };

async function renderDiagrams(v) {
  for (const fig of [...v.doc.querySelectorAll('figure.dia')]) {
    if (!fig.isConnected) return; // the user switched files meanwhile
    const lang = fig.dataset.lang;
    const src = fig.querySelector('pre code').textContent;
    const key = lang + '\0' + src;
    let res = diaCache.get(key);
    if (!res) {
      try { res = await renderDiagram(lang, src); } catch (e) { res = { errors: e.messages || [String(e.message || e)], unavailable: !!e.unavailable }; }
      diaCache.set(key, res);
    }
    if (fig.isConnected) showDiagram(fig, res);
  }
  withView(v, layoutMargin);
}

// Clicking a diagram comments on its whole block; clicking a node or edge comments on the line(s)
// that define it, with the clicked element named in the composer.
function onDiagramClick(fig, hit, frame) {
  if (!state.file) return;
  if (state.pending && $('#c-body').value.trim()) return;
  const b = blockLines(fig);
  const fi = fenceInfo(b);
  let start = b.s;
  let end = b.e;
  let about = '';
  let rect = null;
  if (hit && hit.lines && hit.lines.length) {
    const first = hit.lines[0];
    start = Math.max(fi.a, Math.min(fi.b, fi.a + first.s));
    end = Math.max(start, Math.min(fi.b, fi.a + first.e));
    if ((fig.dataset.lang === 'd2' && hit.kind === 'node') || (fig.dataset.lang === 'dot' && hit.kind === 'cluster')) { // a container / cluster owns its whole { ... } block, not just its first line
      let depth = 0;
      for (let n = start; n <= fi.b; n++) {
        const l = (state.lines[n - 1] || '').replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '');
        for (const c of l) { if (c === '{') depth++; else if (c === '}') depth--; }
        if (depth <= 0) { end = Math.max(end, n); break; }
      }
    }
    const others = [...new Set(hit.lines.slice(1).map((l) => fi.a + l.s))].filter((n) => n !== start);
    about = `${hit.kind} “${hit.label}”${others.length ? ` (also on line${others.length > 1 ? 's' : ''} ${others.join(', ')})` : ''}`;
    if (frame) {
      const fr = frame.getBoundingClientRect();
      const er = hit.el.getBoundingClientRect();
      rect = { left: fr.left + er.left, right: fr.left + er.right, top: fr.top + er.top, bottom: fr.top + er.bottom, width: er.width, height: er.height };
    }
  }
  const cs = hit ? start : fi.a;
  const ce = hit ? end : fi.b;
  const range = document.createRange();
  range.selectNode(fig);
  const sel = finishSelection(start, end, [{ kind: 'code', lang: fig.dataset.lang, text: state.lines.slice(cs - 1, ce).join('\n') }], range);
  sel.about = about;
  sel.diagram = true;
  sel.includeDefault = true; // the raw source is not what the reader sees: say what was meant
  sel.aboutShort = hit ? `${hit.kind} “${hit.label}”` : '';
  sel.rect = rect;
  showComposer(sel);
  markElement(hit ? hit.el : null);
}

// ---------- selection -> source lines ----------
// Every non-blank piece of text the range covers, in order.
function spanNodes(range) {
  const walker = document.createTreeWalker(doc, NodeFilter.SHOW_TEXT);
  const out = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!range.intersectsNode(n)) continue;
    if (n.parentElement && n.parentElement.closest('.away')) continue; // a collapsed old block: its words are shown inline in the merged paragraph
    let s = n === range.startContainer ? range.startOffset : 0;
    let e = n === range.endContainer ? range.endOffset : n.data.length;
    while (s < e && /\s/.test(n.data[s])) s++;
    while (e > s && /\s/.test(n.data[e - 1])) e--;
    if (e > s) out.push({ node: n, s, e });
  }
  return out;
}
function textSpan(range) {
  const all = spanNodes(range);
  return all.length ? { first: all[0], last: all[all.length - 1] } : null;
}

const inDel = (n) => !!(n.parentElement && n.parentElement.closest('.wdel'));
// The words of a merged paragraph as one file reads them (skip = what the other file adds), up to a text position.
function kindText(block, stop, stopOffset, skip) {
  const w = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  let out = '';
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    if (n.parentElement.closest(skip)) continue;
    if (n === stop) return out + n.data.slice(0, stopOffset);
    out += n.data;
  }
  return out;
}

function lineAt(node, offset, which) {
  const block = node.parentElement && node.parentElement.closest('[data-l]');
  if (!block || !doc.contains(block)) return null;
  if (block.classList.contains('wmerge')) { // a merged paragraph: removed words count in the old file, the rest in the new one
    const old = inDel(node);
    const [a, z] = (old ? block.dataset.lo : block.dataset.l).split('-').map(Number);
    const lines = old ? (cur.oldLines || []) : state.lines;
    const skip = old ? '.wa' : '.wdel';
    const before = kindText(block, node, offset, skip);
    return locateLine(lines, trimBlock(lines, a, z), {
      which, fence: false, renderedTotal: wordCount(kindText(block, null, 0, skip)), wordsBefore: wordCount(before),
      midWord: which === 'start' && /\S$/.test(before) && /\S/.test(node.data[offset] || ''), newlinesBefore: 0,
    });
  }
  const bounds = blockLines(block);
  const lines = linesOf(block); // removed blocks are numbered in the old file
  if (block.dataset.k === 'diagram' && !node.parentElement.closest('.dia-src pre code')) return which === 'start' ? bounds.s : bounds.e;
  const codeEl = block.dataset.k === 'diagram' ? block.querySelector('.dia-src pre code') : block;
  const r = document.createRange();
  r.setStart(codeEl, 0);
  r.setEnd(node, offset);
  const before = r.toString();
  return locateLine(lines, bounds, {
    which,
    fence: block.dataset.k === 'fence' || block.dataset.k === 'diagram',
    renderedTotal: wordCount(block.textContent),
    wordsBefore: wordCount(before),
    midWord: which === 'start' && /\S$/.test(before) && /\S/.test(node.data[offset] || ''),
    newlinesBefore: (which === 'end' ? before.replace(/\n$/, '') : before).split('\n').length - 1,
  });
}

// Fenced code: language and the source lines between the fences.
function fenceInfo(b, lines = state.lines) {
  const open = lines[b.s - 1] || '';
  const m = /^\s*(`{3,}|~{3,})\s*([^\s`]*)/.exec(open);
  const closed = b.e > b.s && /^\s*(`{3,}|~{3,})\s*$/.test(lines[b.e - 1] || '');
  return m ? { lang: m[2], a: b.s + 1, b: closed ? b.e - 1 : b.e } : { lang: '', a: b.s, b: b.e };
}

// The relevant parts of a selection, one segment per block it touches, in order.
// Prose is the selected text; code (fences, indented code, D2) is the source lines themselves.
function segmentsFor(range, opts = {}) {
  const leaves = [...doc.querySelectorAll('[data-l]')].filter((e) => !e.querySelector('[data-l]') && !e.closest('.away') && range.intersectsNode(e));
  const segs = [];
  for (const el of leaves) {
    const r = document.createRange();
    r.selectNodeContents(el);
    if (range.compareBoundaryPoints(Range.START_TO_START, r) > 0) r.setStart(range.startContainer, range.startOffset);
    if (range.compareBoundaryPoints(Range.END_TO_END, r) < 0) r.setEnd(range.endContainer, range.endOffset);
    const k = el.dataset.k;
    const lines = linesOf(el);
    if (el.classList.contains('wmerge')) { // merged paragraph: the words kept or inserted are the quote; removed words are quoted as a diff when mixed
      const sp = spanNodes(r);
      const join = (xs) => xs.map((x) => x.node.data.slice(x.s, x.e)).join(' ').replace(/\s+/g, ' ').trim();
      const delText = join(sp.filter((x) => inDel(x.node)));
      const newText = join(sp.filter((x) => !inDel(x.node)));
      if (newText) segs.push({ kind: 'text', text: newText });
      if (delText) segs.push(opts.mixed ? { kind: 'code', lang: 'diff', text: `- ${delText}` } : { kind: 'text', text: delText });
      continue;
    }
    if (opts.mixed && isRemoved(el)) { // the selection spans removed and kept text: show what was removed as a diff
      const b = blockLines(el);
      segs.push({ kind: 'code', lang: 'diff', text: lines.slice(b.s - 1, b.e).map((l) => `- ${l}`).join('\n') });
      continue;
    }
    if (k === 'fence' || k === 'diagram' || el.tagName === 'PRE') {
      const fi = fenceInfo(blockLines(el), lines);
      let a = fi.a;
      let z = fi.b;
      const span = textSpan(r);
      // inside the code text itself: only the selected lines; on a rendered diagram: all of it
      if (span && (k !== 'diagram' || span.first.node.parentElement.closest('.dia-src pre code'))) {
        const la = lineAt(span.first.node, span.first.s, 'start');
        const lz = lineAt(span.last.node, span.last.e, 'end');
        if (la != null && lz != null) { a = Math.max(fi.a, Math.min(la, lz)); z = Math.min(fi.b, Math.max(la, lz)); }
        if (z < a) { a = fi.a; z = fi.b; }
      }
      segs.push({ kind: 'code', lang: k === 'diagram' ? el.dataset.lang : fi.lang, text: lines.slice(a - 1, z).join('\n') });
      continue;
    }
    let text;
    if (el.tagName === 'TR') {
      const cells = [...r.cloneContents().querySelectorAll('td,th')];
      text = cells.length ? cells.map((c) => c.textContent.trim()).join(' | ') : r.toString();
    } else text = r.toString();
    segs.push({ kind: 'text', text: text.replace(/\s*\n\s*/g, ' ').replace(/[ \t]+/g, ' ').trim() });
  }
  return segs.filter((x) => x.text.trim());
}

function finishSelection(start, end, segments, range, opts = {}) {
  const side = opts.side === 'LEFT' ? 'LEFT' : 'RIGHT';
  const lines = side === 'LEFT' ? (cur.oldLines || []) : state.lines;
  const quote = plainQuote(segments);
  // a comment must sit on lines inside the diff, on one side: old-file lines for LEFT, new-file lines for RIGHT
  const ranges = side === 'LEFT' ? patchHunkRanges(cur.rows).map((h) => h.left).filter(Boolean) : state.diff.hunks;
  const anchor = clampRange(start, end, ranges);
  // fence markers are not content: compare against the lines a reader would actually see
  const whole = coversWholeLines(quote, lines.slice(start - 1, end).filter((l) => !/^\s*(`{3,}|~{3,})/.test(l)));
  const touchesRemoved = !!opts.touchesRemoved;
  return {
    start, end, side, quote, segments, quoteMd: formatQuote(segments), anchor, range: range.cloneRange(), touchesRemoved,
    includeDefault: !anchor || !anchor.exact || !whole || touchesRemoved, // a quote only helps when it adds information
  };
}

// A selection is anchored to ONE side of the diff. Inside removed text it is a LEFT (old-file) comment; anything that
// includes kept or added text anchors to the new-file lines it covers, and removed text in between is quoted as a diff.
function describeSelection(range) {
  const sideOf = (n) => { const b = n.parentElement && n.parentElement.closest('[data-l]'); return b && doc.contains(b) ? (isRemoved(b) || inDel(n) ? 'LEFT' : 'RIGHT') : null; };
  const mapped = spanNodes(range).filter((x) => sideOf(x.node));
  if (!mapped.length) return null;
  const right = mapped.filter((x) => sideOf(x.node) === 'RIGHT');
  const use = right.length ? right : mapped;
  const a = lineAt(use[0].node, use[0].s, 'start');
  const z = lineAt(use[use.length - 1].node, use[use.length - 1].e, 'end');
  if (a == null || z == null) return null;
  const mixed = right.length > 0 && mapped.length > right.length;
  const side = right.length ? 'RIGHT' : 'LEFT';
  return finishSelection(Math.min(a, z), Math.max(a, z), segmentsFor(range, { mixed }), range, { side, touchesRemoved: mixed });
}

function rangeText(start, end, anchor, side = 'RIGHT') {
  const noun = side === 'LEFT' ? 'removed line' : 'line';
  const span = (x, y) => (x === y ? `${noun} ${x}` : `${noun}s ${x}–${y}`);
  if (!anchor) return { text: `${span(start, end)} — outside the diff, so it is posted as a comment on the ${where()}, with this quote.`, warn: true };
  if (anchor.exact) return { text: `Comments on ${span(anchor.start, anchor.end)}`, warn: false };
  return { text: `You selected ${span(start, end)}; GitHub can anchor ${span(anchor.start, anchor.end)} (${isCommit() ? 'a commit comment is on one line' : 'one hunk'}). The full quote is included.`, warn: true };
}

// ---------- selection icons + composer (both sit in the right margin, like Google Docs) ----------
// Two icons: Comment (a speech bubble) and Suggest (a +/- change). The quote is added by itself when it helps.
const BUBBLE = '<path d="M3 2.5h14A1.5 1.5 0 0 1 18.5 4v9a1.5 1.5 0 0 1-1.5 1.5H9.5L5.5 18v-3.5H3A1.5 1.5 0 0 1 1.5 13V4A1.5 1.5 0 0 1 3 2.5Z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>';
const GLYPH_PLUS = '<path d="M10 5.6v5.6M7.2 8.4h5.6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" fill="none"/>';
$('#sb-comment').innerHTML = `<svg viewBox="0 0 20 20" aria-hidden="true">${BUBBLE}${GLYPH_PLUS}</svg>`;
$('#sb-suggest').innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 3.5h9.5a1.5 1.5 0 0 1 1.5 1.5v10a1.5 1.5 0 0 1-1.5 1.5H3A1.5 1.5 0 0 1 1.5 15V5A1.5 1.5 0 0 1 3 3.5Z" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M4.6 7.5h5.8M4.6 11.8h5.8M7.5 9.6v4.4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M15.5 2.5v5M13 5h5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
const selbar = $('#selbar');

function marginSlot(range, rect) {
  // where the margin column is, relative to #main, and the top of the thing being commented on
  const v = (state.pending && state.pending.view) || cur;
  if (!v || v.mode !== 'rendered' || getComputedStyle(v.margin).position === 'static' || !v.margin.offsetWidth) return null;
  const wrap = docwrap.getBoundingClientRect();
  const m = v.margin.getBoundingClientRect();
  const r = rect || range.getClientRects()[0] || range.getBoundingClientRect();
  return { left: m.left - wrap.left, width: m.width, top: r.top - wrap.top, wrap };
}

function showSelbar(sel, pt) {
  // a small pill just below where the mouse was released (or the end of the selection, for keyboard selection)
  state.sel = sel;
  const wrap = docwrap.getBoundingClientRect();
  if (!pt) {
    const rects = sel.rect ? [sel.rect] : sel.range.getClientRects();
    const last = rects[rects.length - 1] || sel.range.getBoundingClientRect();
    pt = { x: last.right, y: last.bottom - 8 };
  }
  sel.pt = pt;
  const cs = suggestable(sel);
  const sg = $('#sb-suggest');
  sg.disabled = !cs.ok;
  sg.title = cs.ok ? 'Suggest an edit' : `Can’t suggest here: ${cs.reason}`;
  selbar.hidden = false;
  const w = selbar.offsetWidth;
  selbar.style.top = (pt.y - wrap.top + 12) + 'px';
  // centred on the release point, but kept over the text column: never out over the comment cards
  const dr = (cur && cur.doc ? cur.doc : docwrap).getBoundingClientRect();
  const lo = Math.max(8, dr.left - wrap.left);
  const hi = Math.max(lo, Math.min(dr.right - wrap.left, wrap.width) - w - 8);
  selbar.style.left = Math.max(lo, Math.min(pt.x - wrap.left - w / 2, hi)) + 'px';
}
function hideSelbar() { selbar.hidden = true; state.sel = null; }

$('#sb-comment').addEventListener('mousedown', (e) => e.preventDefault()); // keep the text selection alive
$('#sb-suggest').addEventListener('mousedown', (e) => e.preventDefault());
$('#sb-suggest').addEventListener('click', () => {
  const sel = state.sel;
  if (!sel || !suggestable(sel).ok) return;
  hideSelbar();
  showComposer(sel, true);
});
$('#sb-comment').addEventListener('click', () => {
  const sel = state.sel;
  if (!sel) return;
  hideSelbar();
  showComposer(sel);
});

// the selection was cleared (click elsewhere, Esc, ...): the icons go away. An open composer manages itself.
document.addEventListener('selectionchange', () => {
  const s = window.getSelection();
  const gone = !s || s.isCollapsed || !s.rangeCount;
  if (state.pending) { // an empty composer closes when its selection is cleared elsewhere; a draft stays
    if (gone && !composer.contains(document.activeElement) && !$('#c-body').value.trim() && !state.pending.about && !state.pending.rows) hideComposer();
    return;
  }
  if (!selbar.hidden && gone) hideSelbar();
});
// Ctrl/Cmd+Alt+M: comment on the current selection (like Google Docs)
document.addEventListener('keydown', (e) => {
  if (!(e.code === 'KeyM' && e.altKey && (e.ctrlKey || e.metaKey))) return;
  e.preventDefault();
  if (state.pending) return $('#c-body').focus();
  const s = window.getSelection();
  if (!s || s.isCollapsed || !s.rangeCount || !state.file) return;
  const range = s.getRangeAt(0);
  const v = viewOfNode(range.commonAncestorContainer);
  if (!v || v.mode !== 'rendered') return;
  use(v);
  const sel = describeSelection(range);
  if (sel) { hideSelbar(); showComposer(sel); }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !selbar.hidden) { hideSelbar(); window.getSelection().removeAllRanges(); } });
document.addEventListener('mousedown', (e) => { if (!selbar.hidden && !selbar.contains(e.target)) setTimeout(() => { const s = window.getSelection(); if (!s || s.isCollapsed) hideSelbar(); }, 0); });
function setSelHighlight(range) {
  if (!('highlights' in CSS)) return;
  CSS.highlights.delete('rico-sel');
  if (range) CSS.highlights.set('rico-sel', new Highlight(range));
}

const SUG_PLACEHOLDER = 'Add a note (optional)…  (Ctrl/Cmd+Enter to post, Esc to dismiss)';
const srcOf = (sel) => state.lines.slice(sel.anchor.start - 1, sel.anchor.end);
function renderSugDiff() {
  const p = state.pending;
  const box = $('#c-sugdiff');
  box.textContent = '';
  if (!p?.suggest) return;
  const next = $('#c-sugtext').value.replace(/\n$/, '');
  for (const r of lineDiff(srcOf(p), next === '' ? [] : next.split('\n'))) {
    const row = el('div', 'sg-' + r.type);
    row.append(el('span', 'sg-mark', r.type === 'add' ? '+' : r.type === 'del' ? '−' : ' '), el('code', null, r.text || ' '));
    box.append(row);
  }
}
$('#c-sugtext').addEventListener('input', () => { renderSugDiff(); persistComposer(); placeComposer(state.pending.range, state.pending.rect); });

function showComposer(sel, suggest = sel.suggest) {
  sel.view = sel.view || cur;
  if (isCommit() && sel.anchor && sel.anchor.start < sel.anchor.end) { // a commit comment sits on one line: its last, and the body says the rest
    sel.anchor = { start: sel.anchor.end, end: sel.anchor.end, exact: false };
    sel.includeDefault = true;
  }
  sel.suggest = !!suggest && suggestable(sel).ok;
  state.pending = sel;
  const pv = previewLines(sel.quote);
  const q = $('#c-quote');
  q.textContent = '';
  q.append(pv.head.join('\n'));
  if (pv.omitted) {
    q.append(el('div', 'q-gap', `⋯ ${pv.omitted} more lines ⋯`));
    q.append(pv.tail.join('\n'));
  }
  const rt = rangeText(sel.start, sel.end, sel.anchor, sel.side);
  $('#c-err').textContent = '';
  const rv = $('#c-review');
  const batching = !!state.pendingReview || hasPending();
  rv.textContent = batching ? 'Add to review' : 'Start a review';
  rv.disabled = !sel.anchor;
  rv.hidden = isCommit(); // commits have no reviews
  rv.title = sel.anchor ? 'Keep this comment pending on GitHub until you finish the review' : `Text outside the diff can only be posted as a single comment on the ${where()}`;
  const rEl = $('#c-range');
  rEl.textContent = rt.text + (sel.touchesRemoved ? ' — includes removed text (quoted)' : '') + (state.stale ? ' — this PR has new commits since you loaded it; line numbers may have moved.' : '');
  rEl.classList.toggle('warn', rt.warn);
  const inc = $('#c-qinc');
  inc.checked = sel.includeDefault;
  inc.disabled = !sel.anchor; // unanchored comments live in the summary, where the quote is the only context
  $('#c-qnote').textContent = sel.anchor ? (sel.includeDefault ? '' : 'GitHub already shows these lines') : 'required: goes in the summary';
  $('#c-quote').hidden = !inc.checked;
  $('#c-qtext').value = sel.quoteMd;
  $('#c-qtext').hidden = true;
  $('#c-qedit').setAttribute('aria-expanded', 'false');
  $('#c-body').value = sel.body || '';
  $('#c-suggest').hidden = !sel.suggest;
  $('#c-body').placeholder = sel.suggest ? SUG_PLACEHOLDER : 'Leave a comment…  (Ctrl/Cmd+Enter to post, Esc to dismiss)';
  if (sel.suggest) {
    $('#c-sugtext').value = sel.sugText ?? srcOf(sel).join('\n');
    $('#c-quote').hidden = true;
    rEl.textContent = `Suggests an edit to ${sel.anchor.start === sel.anchor.end ? 'line ' + sel.anchor.start : `lines ${sel.anchor.start}–${sel.anchor.end}`} (whole lines; the author can apply it with one click)`;
    rEl.classList.remove('warn');
    renderSugDiff();
  }
  composer.hidden = false;
  setSelHighlight(sel.about || sel.rows ? null : sel.range); // an element or a diff line highlights itself, not a text range
  for (const r of sel.rows || []) r.classList.add('d-sel');
  placeComposer(sel.range, sel.rect);
  (sel.suggest ? $('#c-sugtext') : $('#c-body')).focus({ preventScroll: true });
}

function placeComposer(range, rect) {
  const slot = marginSlot(range, rect);
  if (slot) { // in the margin beside the selection, never over the text
    composer.style.width = Math.max(260, slot.width) + 'px';
    composer.style.left = slot.left + 'px';
    composer.style.top = slot.top + 'px';
    return;
  }
  composer.style.width = '';
  const wrap = docwrap.getBoundingClientRect();
  const rects = rect ? [rect] : range.getClientRects();
  const first = rects[0] || range.getBoundingClientRect();
  const last = rects[rects.length - 1] || first;
  const h = composer.offsetHeight;
  let top = last.bottom - wrap.top + 8; // below the selection by default
  if (last.bottom + h + 16 > window.innerHeight && first.top - h - 16 > 0) top = first.top - wrap.top - h - 8; // flip above
  const left = Math.max(8, Math.min(first.left - wrap.left, wrap.width - composer.offsetWidth - 8));
  composer.style.top = top + 'px';
  composer.style.left = left + 'px';
}

function hideComposer() {
  hideSelbar();
  markElement(null);
  for (const r of document.querySelectorAll('.d-sel')) r.classList.remove('d-sel');
  composer.hidden = true;
  state.pending = null;
  setSelHighlight(null);
}

function onSelect(pt) {
  if (!state.file) return;
  const s = window.getSelection();
  if (!s || s.isCollapsed || !s.rangeCount) return;
  const range = s.getRangeAt(0);
  const v = viewOfNode(range.commonAncestorContainer);
  if (!v || v.mode !== 'rendered' || !v.doc.contains(range.commonAncestorContainer)) return;
  use(v);
  if (state.pending && $('#c-body').value.trim()) { // don't clobber a draft
    composer.classList.remove('pulse');
    void composer.offsetWidth;
    composer.classList.add('pulse');
    return;
  }
  if (state.pending) hideComposer(); // a fresh selection replaces an empty composer
  const sel = describeSelection(range);
  if (sel) showSelbar(sel, pt); else hideSelbar();
}

// Only a gesture that STARTED in the document text can make a selection pill. A click on a comment card, "▼ 1 below",
// a button, etc. must not re-show it at the click point just because an old selection is still active.
let downInDoc = false;
$('#cards').addEventListener('mousedown', (e) => { downInDoc = !!(e.target.closest && e.target.closest('.rico-doc')); }, true);
$('#cards').addEventListener('mouseup', (e) => { if (!downInDoc) return; const pt = { x: e.clientX, y: e.clientY }; setTimeout(() => onSelect(pt), 0); });
$('#cards').addEventListener('keyup', (e) => { if (e.shiftKey || e.key === 'Shift') setTimeout(onSelect, 0); });

// Unsent text in the comment box survives a reload (or a sign-in round trip): everything but the live Range is saved.
function persistComposer() {
  const p = state.pending;
  const body = $('#c-body').value;
  const edited = !!p?.suggest && $('#c-sugtext').value !== srcOf(p).join('\n');
  if (!p || (!body.trim() && !edited) || !p.view) return draftSet('composer', null);
  const { start, end, side, quote, quoteMd, anchor, includeDefault, touchesRemoved, about, aboutShort, diagram, suggest } = p;
  draftSet('composer', { path: p.view.file.filename, start, end, side, quote, quoteMd, anchor, includeDefault, touchesRemoved, about, aboutShort, diagram, body, suggest, sugText: suggest ? $('#c-sugtext').value : undefined });
}

const hasPending = () => [...state.threads, ...state.leftThreads].some((t) => t.msgs.some((m) => m.pending));

async function submitComposer(mode) {
  const p = state.pending;
  let body = $('#c-body').value.trim();
  const err = $('#c-err');
  err.textContent = '';
  if (p?.suggest) { // a suggestion: the replacement lines are the comment, the note is optional
    const next = $('#c-sugtext').value;
    if (next.replace(/\n$/, '') === srcOf(p).join('\n')) return showErr(err, { message: 'No change yet: edit the lines above to suggest something.' });
    body = suggestionBody(next, body);
  } else if (!p || !body) return $('#c-body').focus();
  if (state.preview) { persistComposer(); return showErr(err, { message: 'Sign in with GitHub to comment.', signin: true }); }
  const view = p.view;
  const c = {
    path: view.file.filename, side: p.side || 'RIGHT', start: p.start, end: p.end, quote: p.quote, anchor: p.anchor, body,
    about: p.aboutShort || '', // diagram element, so the comment says what it is about on GitHub
    includeQuote: p.suggest ? false : p.anchor ? $('#c-qinc').checked : true, // a suggestion is its own quote
    quoteMd: $('#c-qtext').value.trim(), // markdown actually posted
    lines: (p.side === 'LEFT' ? view.oldLines || [] : view.lines).slice(p.start - 1, p.end), // the selected source lines, in case GitHub can anchor fewer
    sha: p.side === 'LEFT' ? state.pr.baseSha : state.pr.headSha,
  };
  draftSet('composer', null);
  hideComposer();
  window.getSelection().removeAllRanges();
  postThread(view, c, p.anchor && !isCommit() ? mode : 'single'); // text outside the diff can only be a PR (or commit) comment; a commit has no reviews
}

/** Show the comment in the margin at once ("posting…"), send it, then swap in GitHub's version (or the reason it failed). */
function postThread(view, c, mode) {
  const msg = { id: 'tmp' + Date.now(), user: state.me || 'you', avatar: state.meAvatar || null, body: '', createdAt: new Date().toISOString(), posting: true, reactions: [] };
  let th;
  let send;
  if (c.anchor) {
    const line = buildLineComment(c);
    msg.body = line.body;
    th = { id: msg.id, kind: 'review', path: c.path, start: c.anchor.start, end: c.anchor.end, side: line.side, msgs: [msg], outdated: false, fileLevel: false, info: null, local: true, pending: mode === 'review' };
    (th.side === 'LEFT' ? state.leftThreads : state.threads).push(th);
    const pos = isCommit() ? patchPosition(view.file.patch, line.line, line.side) : null;
    send = async () => (isCommit()
      ? (pos ? apiPost('/api/comment', { ...prRef(), comment: { path: line.path, position: pos, body: line.body, line: line.line, side: line.side } }) : Promise.reject(new Error('That line is not in this commit’s diff.')))
      : mode === 'review'
      ? (await apiPost('/api/pending/add', { ...prRef(), comment: { ...line, commit_id: state.pr.headSha } })).comment
      : apiPost('/api/comment', { ...prRef(), comment: { ...line, commit_id: state.pr.headSha } }));
  } else {
    msg.body = buildPrComment(c);
    th = { id: 'i' + msg.id, kind: 'issue', msgs: [msg], side: 'RIGHT', local: true };
    state.prThreads.push(th);
    send = () => apiPost('/api/pr-comment', { ...prRef(), text: msg.body });
  }
  const run = async () => {
    msg.posting = true; msg.failed = null;
    state.inflight = (state.inflight || 0) + 1;
    refreshView(view);
    let ok = false;
    try {
      const res = await send();
      res.canUpdate = res.canDelete = true;
      th.msgs[0] = res;
      th.local = false;
      th.id = th.kind === 'issue' ? 'i' + res.id : res.id;
      th.pending = !!res.pending;
      if (res.pending && !state.pendingReview) state.pendingReview = { id: null };
      ok = true;
    } catch (e) {
      msg.posting = false;
      msg.failed = /pending review/i.test(e.message) && mode !== 'review' ? `${e.message} (You have a pending review: use “Add to review”, or finish or discard it first.)` : e.message;
      msg.signin = e.signin;
    }
    state.inflight--;
    refreshView(view);
    if (ok) refreshComments(true); // learn the thread's id and what you may do with it
  };
  th.retry = run;
  run();
  return th;
}

$('#c-qedit').addEventListener('click', () => {
  const t = $('#c-qtext');
  t.hidden = !t.hidden;
  $('#c-qedit').setAttribute('aria-expanded', String(!t.hidden));
  if (!t.hidden) t.focus(); else $('#c-body').focus();
  if (state.pending) placeComposer(state.pending.range);
});
$('#c-add').addEventListener('click', () => submitComposer('single'));
$('#c-review').addEventListener('click', () => submitComposer('review'));
$('#c-body').addEventListener('input', persistComposer);
$('#c-cancel').addEventListener('click', () => { draftSet('composer', null); hideComposer(); window.getSelection().removeAllRanges(); });
for (const box of [$('#c-body'), $('#c-sugtext')]) box.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submitComposer(e.shiftKey ? 'review' : 'single'); }
  if (e.key === 'Escape') { draftSet('composer', null); hideComposer(); window.getSelection().removeAllRanges(); }
});
const layoutAll = () => { for (const v of views.values()) if (v.loaded) withView(v, layoutMargin); scheduleTicks(); };
window.addEventListener('resize', () => { layoutAll(); if (state.pending) placeComposer(state.pending.range, state.pending.rect); });
document.fonts?.ready.then(layoutAll);

// ---------- review panel: the viewer's pending GitHub review ----------
const pendingItems = () => [...state.threads, ...state.leftThreads].flatMap((t) => t.msgs.filter((m) => m.pending && !m.posting).map((m) => ({ t, m })));
function renderPanel() {
  const list = $('#list');
  if (!list) return;
  list.textContent = '';
  const items = pendingItems();
  $('#count').textContent = items.length ? `(${items.length})` : '';
  const rc = $('#rc-count');
  rc.textContent = String(items.length);
  rc.hidden = !items.length;
  $('#rc-label').textContent = items.length ? 'Finish review' : 'Review changes';
  $('#review-btn').title = items.length ? `${items.length} pending comment${items.length > 1 ? 's' : ''} on GitHub, waiting for you to finish the review` : 'Leave a verdict, or a summary';
  $('#discard').hidden = !items.length;
  // GitHub does not let you approve or request changes on your own pull request
  const own = !!state.pr && !!state.me && state.pr.author === state.me;
  for (const v of ['APPROVE', 'REQUEST_CHANGES']) document.querySelector(`input[name="event"][value="${v}"]`).closest('label').hidden = own;
  if (own) document.querySelector('input[name="event"][value="COMMENT"]').checked = true;
  if (!items.length) list.innerHTML = '<p class="empty">No pending comments. “Start a review” in a comment box keeps comments here, on GitHub, until you finish.</p>';
  for (const { t, m } of items) {
    const card = el('div', 'card');
    const where = el('div', 'where');
    const link = el('a', null, `${t.path} · ${t.start === t.end ? 'L' + t.start : `L${t.start}–${t.end}`}${t.side === 'LEFT' ? ' (removed)' : ''}`);
    link.addEventListener('click', async () => {
      $('#review-pop').hidden = true;
      if (!state.file || state.file.filename !== t.path) await openFile(t.path);
      document.querySelector(`.thread[data-id="${t.id}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
    where.append(link);
    const body = el('div', 'body', m.body);
    card.append(where, body);
    list.append(card);
  }
  renderPanelButton();
}
const renderPanelButton = () => {
  const ev = document.querySelector('input[name="event"]:checked')?.value;
  $('#submit').disabled = ev === 'COMMENT' && !pendingItems().length && !$('#summary').value.trim();
};
$('#summary').addEventListener('input', () => { if (state.pr) save(); renderPanelButton(); });
for (const r of document.querySelectorAll('input[name="event"]')) r.addEventListener('change', renderPanelButton);

$('#submit').addEventListener('click', async () => {
  const btn1 = $('#submit');
  const out = $('#result');
  out.textContent = '';
  btn1.disabled = true;
  btn1.textContent = 'Submitting…';
  try {
    const res = await apiPost('/api/pending/finish', { ...prRef(), event: document.querySelector('input[name="event"]:checked').value, body: $('#summary').value });
    const a = el('a', null, 'Review posted — open on GitHub');
    a.href = res.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
    out.replaceChildren(a);
    for (const { m } of pendingItems()) m.pending = false;
    for (const t of [...state.threads, ...state.leftThreads]) t.pending = false;
    state.pendingReview = null;
    $('#summary').value = '';
    save(); refreshAll();
    refreshComments(true);
  } catch (e) {
    const d = el('div', 'err');
    showErr(d, e);
    out.replaceChildren(d);
  } finally {
    btn1.textContent = 'Submit review';
    renderPanelButton();
  }
});

$('#discard').addEventListener('click', async () => {
  const b = $('#discard');
  if (b.dataset.armed !== '1') { b.dataset.armed = '1'; b.textContent = 'Really discard the review?'; setTimeout(() => { b.dataset.armed = ''; b.textContent = 'Discard review'; }, 4000); return; }
  b.dataset.armed = '';
  b.textContent = 'Discard review';
  try {
    await apiPost('/api/pending/discard', prRef());
    state.threads = state.threads.filter((t) => !t.pending);
    state.leftThreads = state.leftThreads.filter((t) => !t.pending);
    state.pendingReview = null;
    refreshAll();
    refreshComments(true);
  } catch (e) { const d = el('div', 'err'); showErr(d, e); $('#result').replaceChildren(d); }
});

$('#stale-reload').addEventListener('click', () => { const p = state.pr; if (p.kind === 'commit') { if (p.branch) goLatest(); return; } location.assign(prPath({ owner: p.owner, repo: p.repo, number: p.number }) + location.search); });

// ---------- unsent comment, after a reload or sign-in ----------
async function restoreComposer() {
  const d = draftGet('composer');
  if (!d || !state.pr || state.pending) return;
  const v = views.get(d.path);
  if (!v) return;
  try {
    if (!v.loaded) await loadView(v);
    use(v);
    if (v.mode !== 'rendered') return;
    const leaves = leafBlocks(v.doc).filter((e) => isRemoved(e) === (d.side === 'LEFT') && overlaps(blockLines(e), d.start, d.end));
    if (!leaves.length) return;
    const range = document.createRange();
    range.setStartBefore(leaves[0]);
    range.setEndAfter(leaves[leaves.length - 1]);
    showComposer({ ...d, range, view: v });
    leaves[0].scrollIntoView({ block: 'center' });
  } catch { /* the draft stays saved; nothing else to do */ }
}

// ---------- keeping the margin current ----------
let etags = {};
/**
 * Re-read the PR's comments (conditional requests: an unchanged PR answers 304 and costs nothing).
 * `force` ignores the saved ETags, e.g. right after our own write.
 */
async function refreshComments(force = false) {
  if (!state.pr || state.inflight) return;
  const p = state.pr;
  let data;
  try {
    data = await api('/api/comments?' + new URLSearchParams({ owner: p.owner, repo: p.repo, ...(p.kind === 'commit' ? { sha: p.sha, ...(p.branch ? { branch: p.branch } : {}) } : { number: p.number }), etags: force ? '{}' : JSON.stringify(etags) })).then(JSON.parse);
  } catch { return; } // a failed poll is not worth interrupting anyone for
  if (state.pr !== p) return; // another PR was opened meanwhile
  etags = data.etags || etags;
  if (data.branchGone) showStale(null, true);
  else if (data.headSha && data.headSha !== p.headSha) showStale(data.headSha);
  else if (data.headSha && state.stale) { state.stale = null; $('#stale').hidden = true; } // it moved back (a force-push undone)
  if (data.unchanged) return;
  const sig = JSON.stringify([data.comments, data.prComments, data.pendingReview]);
  if (sig === state.lastSig) return;
  state.lastSig = sig;
  const a = document.activeElement;
  const keep = a && a.tagName === 'TEXTAREA' && a.closest('.thread') ? { id: a.closest('.thread').dataset.id, from: a.selectionStart, to: a.selectionEnd } : null;
  const open = new Set([...state.threads, ...state.leftThreads].filter((t) => t.open).map((t) => t.id));
  applyComments(data);
  for (const t of [...state.threads, ...state.leftThreads]) if (open.has(t.id)) t.open = true;
  refreshAll();
  if (keep) {
    const ta = document.querySelector(`.thread[data-id="${keep.id}"] .reply textarea`);
    if (ta) { ta.focus({ preventScroll: true }); ta.setSelectionRange(keep.from, keep.to); }
  }
}

// Poll while the tab is visible. Conditional requests make an unchanged PR free; the shared preview server is asked rarely.
let pollTimer = 0;
let pollMs = 0; // test hook: window.__rico.setPollMs
const pollDelay = () => pollMs || (document.hidden ? 120000 : state.preview ? 120000 : 25000);
function schedulePoll() {
  clearTimeout(pollTimer);
  if (!state.pr) return;
  pollTimer = setTimeout(async () => {
    if (!document.hidden) await refreshComments();
    schedulePoll();
  }, pollDelay());
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && state.pr) { refreshComments(); schedulePoll(); } });

/** Open the branch's newest commit (a commit opened from a branch), keeping the open file. */
function goLatest() {
  const p = state.pr;
  const file = new URLSearchParams(location.search).get('file');
  location.assign(`/github.com/${p.owner}/${p.repo}/tree/${p.branch}` + (file ? '?' + new URLSearchParams({ file }) : ''));
}
function showStale(sha, gone = false) {
  const bar = $('#stale');
  if (!bar) return;
  state.stale = sha;
  bar.hidden = false;
  const p = state.pr;
  const btn1 = $('#stale-reload');
  btn1.hidden = !!gone;
  if (p.kind === 'commit') {
    bar.querySelector('.msg-text').textContent = gone
      ? `The branch ${p.branch} no longer exists on GitHub. This commit (${p.sha.slice(0, 7)}) and its comments are still here.`
      : `${p.branch} has moved on to ${sha.slice(0, 7)} since this commit (${p.sha.slice(0, 7)}).`;
    btn1.textContent = 'Go to latest';
    const b = $('#branch-latest');
    if (b) b.textContent = gone ? 'Branch deleted' : 'Go to latest';
    return;
  }
  btn1.textContent = 'Reload';
  bar.querySelector('.msg-text').textContent = `This pull request has new commits (${sha.slice(0, 7)}). Line numbers and comment positions here are from ${state.pr.headSha.slice(0, 7)}.`;
}

// ---------- viewed marks ----------
function setViewed(path, on) {
  if (on) state.viewed.add(path); else state.viewed.delete(path);
  state.dismissed.delete(path);
  const v = views.get(path);
  if (v) { v.vcb.checked = on; v.card.classList.toggle('collapsed', on); v.chev.setAttribute('aria-expanded', String(!on)); } // GitHub collapses a file once it is viewed
  saveViewed();
  renderFiles();
  renderSpecBar();
  if (state.viewedSync) { // GitHub's own mark: it follows the reviewer to github.com, and GitHub clears it when the file changes
    apiPost('/api/viewed', { owner: state.pr.owner, repo: state.pr.repo, number: state.pr.number, path, viewed: on }).catch((e) => status(`Could not save the viewed mark on GitHub: ${e.message}`, true));
  }
}

// ---------- spec review: the artifacts of an AI spec-driven workflow, in reading order ----------
// Spec Kit, OpenSpec and Superpowers all write markdown into the repo and ask a person to read it before the agent goes on.
// spec.js recognises the workflow from the changed paths; this turns that into a stepper, the unchanged neighbours (spec.md
// beside plan.md), and links between the ids and open questions inside the documents.
const specPref = () => { try { return localStorage.getItem('rico:spec') || 'auto'; } catch { return 'auto'; } };
const setSpecPref = (v) => { try { localStorage.setItem('rico:spec', v); } catch { /* ignore */ } };

function setupSpec(pr) {
  state.spec = null;
  if (pr.kind === 'commit') return;
  const pref = specPref();
  const paths = (pr.allFiles || []).filter((f) => f.status !== 'removed').map((f) => f.filename);
  const detected = detectSpec(paths);
  const info = pref === 'off' ? null : pref === 'auto' ? detected : detectSpec(paths, pref);
  const on = !!info && (info.confidence === 'high' || pref !== 'auto'); // a guess from one stray file is offered, not imposed
  const changed = new Set(pr.files.map((f) => f.filename));
  state.spec = { pref, detected, info, on, changed, refs: [], refFiles: [], idsByUnit: new Map(), steps: buildSteps(on ? info : null, changed, []) };
}

/** The files as cards, in the order they are read: the PR's own order, or the spec review steps. */
function orderedFiles() {
  const s = state.spec;
  if (!s?.on) return state.pr.files;
  const byPath = new Map([...state.pr.files, ...s.refFiles].map((f) => [f.filename, f]));
  return s.steps.map((st) => byPath.get(st.path)).filter(Boolean);
}

const refPrKey = () => `${state.pr.owner}/${state.pr.repo}@${state.pr.headSha}`;
const dirCache = new Map();
function listDir(dir) {
  if (!dir) return Promise.resolve([]);
  const k = `${refPrKey()}:${dir}`;
  if (!dirCache.has(k)) dirCache.set(k, api('/api/dir?' + new URLSearchParams({ owner: state.pr.owner, repo: state.pr.repo, path: dir, ref: state.pr.headSha })).then(JSON.parse).catch(() => []));
  return dirCache.get(k);
}
async function fileExists(path) {
  const i = path.lastIndexOf('/');
  return (await listDir(i < 0 ? '' : path.slice(0, i))).some((e) => e.path === path && e.type === 'file');
}

/** Find the unchanged neighbours (spec.md next to plan.md, the constitution, the current spec of each change) and add them as steps. */
async function resolveRefs() {
  const s = state.spec;
  const p = state.pr;
  if (!s?.on || !s.info || p.kind === 'commit') return;
  const plan = referencePlan(s.info, s.changed);
  const found = [];
  await Promise.all([
    ...plan.dirs.map(async ({ dir, unit }) => { found.push(...referencesFromListing(s.info, unit, await listDir(dir), s.changed)); }),
    ...plan.probes.map(async (pr) => { if (await fileExists(pr.path)) found.push(pr); }),
  ]);
  if (state.spec !== s || state.pr !== p) return; // another PR was opened meanwhile
  addRefs(found);
}

function addRefs(found) {
  const s = state.spec;
  const fresh = found.filter((r) => !s.changed.has(r.path) && !s.refs.some((x) => x.path === r.path));
  if (!fresh.length) return;
  s.refs.push(...fresh);
  for (const r of fresh) s.refFiles.push({ filename: r.path, status: 'reference', additions: 0, deletions: 0, previous: null, patch: null, ref: true, role: r.role });
  s.steps = buildSteps(s.info, s.changed, s.refs);
  for (const f of s.refFiles) if (!views.has(f.filename)) views.set(f.filename, makeView(f));
  const host = $('#cards');
  for (const f of orderedFiles()) { const v = views.get(f.filename); if (v) host.append(v.card); } // re-append in order: moves the cards
  renderFiles();
  renderSpecBar();
  for (const r of fresh) loadView(views.get(r.path)).catch(() => {}); // their open questions and ids matter to the reading
}

const stepIndex = (path = cur?.file.filename) => (state.spec?.on ? state.spec.steps.findIndex((x) => x.path === path) : -1);

function renderSteps(nav) {
  const s = state.spec;
  const own = s.steps.filter((x) => !x.ref);
  $('#viewed-count').textContent = `${own.filter((x) => state.viewed.has(x.path)).length} / ${own.length} files viewed`;
  const filter = $('#tree-filter').value.trim().toLowerCase();
  let unit = null;
  s.steps.forEach((st, i) => {
    if (filter && !st.path.toLowerCase().includes(filter)) return;
    if (st.unit !== unit) { unit = st.unit; if (st.unitTitle) nav.append(el('div', 'step-unit', st.unitTitle)); }
    const v = views.get(st.path);
    const row = el('button', 'tree-file step' + (st.ref ? ' ref' : ''));
    row.type = 'button';
    row.dataset.path = st.path;
    if (cur && cur.file.filename === st.path) row.setAttribute('aria-current', 'true');
    const q = v?.markers?.filter((m) => m.kind === 'clarify').length || 0;
    const n = state.threads.filter((t) => t.path === st.path).length;
    row.innerHTML = `<span class="stepno">${i + 1}</span><span class="nm" title="${esc(st.path)}"><b>${esc(st.label)}</b> <small>${esc(st.sub || st.path.split('/').pop())}</small></span>`
      + (st.ref ? '<span class="reftag" title="Not changed in this PR">unchanged</span>' : '')
      + (q ? `<span class="qcount" title="${q} open question${q > 1 ? 's' : ''}">? ${q}</span>` : '')
      + (state.viewed.has(st.path) ? `<span class="tick" title="Viewed">${icon('check')}</span>` : state.dismissed.has(st.path) ? '<span class="tick changed" title="Viewed before, but changed since">●</span>' : '')
      + (n ? `<span class="Counter" title="${n} comment${n > 1 ? 's' : ''}">${n}</span>` : '');
    row.addEventListener('click', () => openFile(st.path));
    nav.append(row);
  });
}

function renderSpecBar() {
  const bar = $('#spec-bar');
  const s = state.spec;
  bar.textContent = '';
  refreshFooters();
  if (!s || (!s.detected && s.pref === 'auto')) { bar.hidden = true; return; }
  bar.hidden = false;
  const menu = el('details', 'menu');
  menu.id = 'spec-menu';
  const sum = el('summary', 'btn spec-pill', s.on ? `Review flow · ${s.info.name}` : s.detected && s.pref !== 'off' ? `Review flow: ${s.detected.name}?` : 'Review flow: off');
  const pop = el('div', 'menu-pop spec-pop');
  const opt = (label, value, pressed, title) => {
    const b = el('button', 'menu-item', label);
    b.type = 'button';
    if (title) b.title = title;
    b.setAttribute('aria-pressed', String(!!pressed));
    b.addEventListener('click', () => { setSpecPref(value); menu.open = false; reloadPr(); });
    return b;
  };
  if (!s.on && s.detected) pop.append(opt(`Use the ${s.detected.name} review flow`, s.detected.id, false, 'Read the artifacts as a sequence: spec, plan, tasks'));
  pop.append(el('div', 'menu-head', 'Review flow'), opt('Auto-detect', 'auto', s.pref === 'auto'), opt('Spec Kit', 'speckit', s.pref === 'speckit'), opt('OpenSpec', 'openspec', s.pref === 'openspec'), opt('Superpowers', 'superpowers', s.pref === 'superpowers'), opt('Off: plain file list', 'off', s.pref === 'off'));
  menu.append(sum, pop);
  bar.append(menu);
  if (!s.on) return;
  const i = stepIndex();
  const total = s.steps.length;
  const prev = btn('‹', 'btn btn-icon', 'Previous step');
  prev.id = 'spec-prev';
  prev.disabled = i <= 0;
  prev.addEventListener('click', () => goStep(-1));
  const st = s.steps[i];
  const pos = el('span', 'spec-pos', i < 0 ? `${total} steps` : `Step ${i + 1} of ${total} · ${st.label}${st.sub ? ' · ' + st.sub : ''}`);
  pos.id = 'spec-pos';
  if (st && ROLE_HINT[st.role]) pos.title = ROLE_HINT[st.role];
  const nx = btn(i >= 0 && i === total - 1 ? 'Finish review' : 'Next ›', 'btn btn-primary', i >= 0 && i < total - 1 ? `Mark viewed and go to ${s.steps[i + 1].label}` : 'Open the review dialog');
  nx.id = 'spec-next';
  nx.addEventListener('click', () => goStep(1));
  bar.append(prev, pos, nx);
  const qn = s.steps.reduce((a, x) => a + (views.get(x.path)?.markers?.filter((m) => m.kind === 'clarify').length || 0), 0);
  if (qn) {
    const q = btn(`${qn} open question${qn > 1 ? 's' : ''}`, 'linkish qlink', 'Jump to the next [NEEDS CLARIFICATION]');
    q.id = 'spec-q';
    q.addEventListener('click', nextQuestion);
    bar.append(q);
  }
}

/** Under each card: what to look for here, and the way on to the next artifact. */
function refreshFooters() {
  const s = state.spec;
  for (const v of views.values()) { v.next.textContent = ''; v.next.hidden = true; }
  if (!s?.on) return;
  s.steps.forEach((st, i) => {
    const v = views.get(st.path);
    if (!v) return;
    v.next.hidden = false;
    if (ROLE_HINT[st.role]) v.next.append(el('span', 'hint', ROLE_HINT[st.role]));
    const nx = s.steps[i + 1];
    const b = btn(nx ? `Next: ${nx.label} · ${nx.sub || nx.path.split('/').pop()} →` : 'Finish review', 'btn');
    b.addEventListener('click', () => goStep(1, st.path));
    v.next.append(b);
  });
}

async function goStep(d, from = cur?.file.filename) {
  const s = state.spec;
  if (!s?.on) return;
  const i = stepIndex(from);
  if (d > 0 && i >= 0 && !s.steps[i].ref && !state.viewed.has(s.steps[i].path)) setViewed(s.steps[i].path, true);
  const j = i + d;
  if (j < 0) return;
  if (j >= s.steps.length) { setPop(true); return; } // the last step: time to finish the review
  await openFile(s.steps[j].path);
}

async function nextQuestion() {
  const qs = [...document.querySelectorAll('#cards .spec-q:not(.todo)')];
  if (!qs.length) return;
  state.qi = ((state.qi ?? -1) + 1) % qs.length;
  const q = qs[state.qi];
  const card = q.closest('.file-card');
  if (card?.classList.contains('collapsed')) await openFile(card.dataset.path);
  q.scrollIntoView({ block: 'center' });
  flash(q);
}
function flash(node, cls = 'spec-flash') { node.classList.add(cls); setTimeout(() => node.classList.remove(cls), 1800); }

// ids and open questions, drawn into the rendered text. They only wrap text nodes (the words stay the same), so selecting and
// commenting across them works as before.
const SPEC_SRC = `\\[NEEDS CLARIFICATION:\\s*[^\\]\\s][^\\]]*\\]|\\bTBD\\b|\\bTODO\\b|${ID_SRC}`;
function undecorateSpec(root) {
  for (const n of root.querySelectorAll('.spec-q, .spec-id')) n.replaceWith(document.createTextNode(n.textContent));
  root.normalize();
}
function decorateSpec(v) {
  const s = state.spec;
  if (!v?.doc || !v.loaded) return;
  undecorateSpec(v.doc);
  if (!s?.on) return;
  v.markers = findMarkers(v.lines);
  const skip = 'pre, code, .away, .rm, .wdel, .sdel, figure.dia, .load-more';
  const w = document.createTreeWalker(v.doc, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.parentElement && !n.parentElement.closest(skip) && new RegExp(SPEC_SRC).test(n.data) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT) });
  const nodes = [];
  for (let n = w.nextNode(); n; n = w.nextNode()) nodes.push(n);
  for (const n of nodes) {
    const frag = document.createDocumentFragment();
    let at = 0;
    let any = false;
    for (const m of n.data.matchAll(new RegExp(SPEC_SRC, 'g'))) {
      const t = m[0];
      let node;
      if (/^(\[|TBD$|TODO$)/.test(t)) {
        node = el('mark', 'spec-q' + (t.startsWith('[') ? '' : ' todo'), t);
        node.title = t.startsWith('[') ? 'An open question: someone has to settle this before the plan can go on' : 'Still to do';
      } else {
        const id = t.replace(/\s+/g, ' ');
        const def = idsFor(v.file.filename)?.get(id);
        if (!def) continue;
        const blk = n.parentElement.closest('[data-l]');
        if (def.path === v.file.filename && blk && overlaps(blockLines(blk), def.line, def.line)) continue; // this is where it is defined
        node = el('span', 'spec-id', t);
        node.dataset.id = id;
        node.tabIndex = 0;
        node.setAttribute('role', 'link');
        node.title = `Go to where ${id} is defined (${def.path.split('/').pop()}, line ${def.line})`;
      }
      frag.append(n.data.slice(at, m.index), node);
      at = m.index + t.length;
      any = true;
    }
    if (any) { frag.append(n.data.slice(at)); n.replaceWith(frag); }
  }
}

/** The id table follows reading order and grows as files load; documents already drawn are decorated again when it does. */
function afterViewLoad(v) {
  const s = state.spec;
  if (s?.on) {
    const count = () => [...s.idsByUnit.values()].reduce((a, m) => a + m.size, 0);
    const before = count();
    s.idsByUnit = buildIdIndexByUnit(s.steps.map((st) => ({ path: st.path, unit: st.unit, lines: views.get(st.path)?.lines })).filter((e) => e.lines?.length));
    for (const o of views.values()) if (o.loaded && (o === v || count() !== before) && o.mode !== 'source') decorateSpec(o);
    for (const r of referencesFromText(s.info, v.file.filename, v.text)) fileExists(r.path).then((ok) => { if (ok && state.spec === s) addRefs([r]); });
    renderFiles();
    renderSpecBar();
  }
  paintSince(v);
  reanchorThreads(v);
}

/** The ids defined in the same feature / change / plan as this file: a "Task 1" means the plan it is written in. */
const idsFor = (path) => state.spec?.idsByUnit.get(state.spec.steps.find((x) => x.path === path)?.unit || '');
async function gotoId(id, from) {
  const d = idsFor(from)?.get(id);
  if (!d) return status(`${id} is not defined in these files.`, true);
  await openFile(d.path);
  const v = views.get(d.path);
  const b = leafBlocks(v.doc).find((e) => !isRemoved(e) && overlaps(blockLines(e), d.line, d.line));
  if (b) { b.scrollIntoView({ block: 'center' }); flash(b); }
}
$('#cards').addEventListener('click', (e) => { const t = e.target.closest?.('.spec-id'); if (t) { e.preventDefault(); gotoId(t.dataset.id, t.closest('.file-card')?.dataset.path); } });
$('#cards').addEventListener('keydown', (e) => { const t = e.target.closest?.('.spec-id'); if (t && e.key === 'Enter') { e.preventDefault(); gotoId(t.dataset.id, t.closest('.file-card')?.dataset.path); } });
$('#tree-mode').addEventListener('click', (e) => { const b = e.target.closest('button[data-tree]'); if (b) { state.treeMode = b.dataset.tree; renderFiles(); } });

function reloadPr() {
  const p = state.pr;
  if (!p) return;
  loadPr(`${p.owner}/${p.repo}#${p.number}`, state.file?.filename || null, '', false);
}

// ---------- what changed since you last looked ----------
// The page shows the PR's whole diff (what GitHub lets you comment on). On top of that, "changes since" marks the words that
// changed after a baseline commit: your last review, your last visit, or any commit in the link. It is only drawn: commenting
// works exactly as before, against the PR's diff.
const sameSha = (a, b) => !!a && !!b && (a.startsWith(b) || b.startsWith(a));
function chooseBaselines(pr, wantSince) {
  state.since = null;
  state.baselines = [];
  if (pr.kind === 'commit' || !pr.headSha) return;
  const seenKey = `rico:seen:${pr.owner}/${pr.repo}#${pr.number}`;
  let seen = {};
  try { seen = JSON.parse(localStorage.getItem(seenKey) || '{}') || {}; } catch { /* ignore */ }
  let prev = seen.prev || '';
  if (seen.head && seen.head !== pr.headSha) prev = seen.head; // the head you saw last time, now behind
  try { localStorage.setItem(seenKey, JSON.stringify({ head: pr.headSha, prev })); } catch { /* ignore */ }
  const list = [];
  const b = pr.viewerBaseline;
  if (b && !sameSha(b.sha, pr.headSha)) list.push({ sha: b.sha, kind: 'review', label: `since your ${b.kind} (${b.sha.slice(0, 7)})` });
  if (prev && !sameSha(prev, pr.headSha) && !list.some((x) => sameSha(x.sha, prev))) list.push({ sha: prev, kind: 'visit', label: `since your last visit (${prev.slice(0, 7)})` });
  if (wantSince && !sameSha(wantSince, pr.headSha) && !list.some((x) => sameSha(x.sha, wantSince))) list.push({ sha: wantSince, kind: 'link', label: `since ${wantSince.slice(0, 7)}` });
  state.baselines = list;
  state.since = (wantSince ? list.find((x) => sameSha(x.sha, wantSince)) : list.find((x) => x.kind === 'review')) || null;
}

function renderSinceBar() {
  const bar = $('#since-bar');
  bar.textContent = '';
  document.body.classList.toggle('since-on', !!state.since && state.pr?.kind !== 'commit'); // the PR's own marks step back while this layer is on
  if (!state.pr || state.pr.kind === 'commit' || !state.baselines.length) { bar.hidden = true; $('#legend-since').hidden = true; return; }
  bar.hidden = false;
  const label = el('label', 'since-label', 'Changes ');
  const sel = el('select');
  sel.id = 'since-sel';
  sel.setAttribute('aria-label', 'Mark what changed since');
  sel.append(new Option('in the whole PR', ''), ...state.baselines.map((b) => new Option(b.label, b.sha)));
  sel.value = state.since ? state.since.sha : '';
  sel.addEventListener('change', () => setSince(sel.value));
  label.append(sel);
  bar.append(label);
  if (state.since) {
    const n = [...views.values()].reduce((a, v) => a + (v.sinceCount || 0), 0);
    const nf = [...views.values()].filter((v) => v.sinceNew).length;
    const c = el('span', 'since-count', `${n} block${n === 1 ? '' : 's'} changed${nf ? ` · ${nf} new file${nf === 1 ? '' : 's'}` : ''}`);
    c.id = 'since-count';
    bar.append(c);
  }
  $('#legend-since').hidden = !state.since;
  $('#legend-since-what').textContent = state.since ? ({ review: 'your review', visit: 'your last visit' }[state.since.kind] || state.since.sha.slice(0, 7)) : '';
}

function setSince(sha) {
  state.since = sha ? state.baselines.find((b) => b.sha === sha) || null : null;
  syncUrl(state.file?.filename || '');
  for (const v of views.values()) {
    if (!v.loaded) continue;
    if (state.since) paintSince(v);
    else { clearSince(v); withView(v, renderMargin); }
  }
  renderSinceBar();
}

function sinceLines(v, sha) {
  v.sinceCache = v.sinceCache || new Map();
  if (!v.sinceCache.has(sha)) {
    v.sinceCache.set(sha, api('/api/file?' + new URLSearchParams({ owner: state.pr.owner, repo: state.pr.repo, path: v.file.filename, ref: sha }))
      .then((t) => t.split(/\r?\n/))
      .catch((e) => { if (e.status === 404 && !/no commit found/i.test(e.message)) return null; throw e; })); // null: the file did not exist then
  }
  return v.sinceCache.get(sha);
}

async function paintSince(v) {
  if (!v.loaded) return;
  const since = state.since;
  if (!since) { clearSince(v); return; }
  let old;
  try { old = await sinceLines(v, since.sha); } catch (e) {
    if (state.since !== since) return;
    state.baselines = state.baselines.filter((b) => b !== since);
    state.since = null;
    for (const o of views.values()) if (o.loaded) clearSince(o);
    renderSinceBar();
    status(/no commit found|not found/i.test(e.message) ? `The commit ${since.sha.slice(0, 7)} is no longer in the repository (a force-push?), so the changes since then cannot be shown.` : e.message, true);
    return;
  }
  if (state.since !== since) return;
  v.sinceLines = { sha: since.sha, lines: old };
  paintSinceWith(v, old);
}
function repaintSince(v) { if (state.since && v.sinceLines?.sha === state.since.sha) paintSinceWith(v, v.sinceLines.lines); }

function clearSince(v) {
  v.card.classList.remove('since-new');
  v.sinceNew = false;
  for (const e of v.doc.querySelectorAll('.since')) e.classList.remove('since');
  for (const e of v.doc.querySelectorAll('.sdel, .since-gone')) e.remove();
  for (const e of v.doc.querySelectorAll('.sa')) e.replaceWith(...e.childNodes);
  v.doc.normalize();
  v.sinceCount = 0;
}

function paintSinceWith(v, old) {
  clearSince(v);
  const leaves = leafBlocks(v.doc).filter((e) => !isRemoved(e)).map((e) => ({ e, b: blockLines(e) }));
  if (old === null) { // the file is new since then: said once on its header, not on every block
    v.sinceNew = true;
    v.card.classList.add('since-new');
  } else {
    const { added, runs } = sinceChanges(old, v.lines);
    for (const l of leaves) {
      let ch = false;
      for (let n = l.b.s; n <= l.b.e && !ch; n++) ch = added.has(n);
      if (ch) { l.e.classList.add('since'); v.sinceCount++; }
    }
    if (runs.length) {
      const oldRoot = el('div');
      oldRoot.innerHTML = safeHtml(md.render(old.join('\n')));
      const oldLeaves = leafBlocks(oldRoot).map((e) => { const [a, z] = e.dataset.l.split('-').map(Number); return { e, b: trimBlock(old, a, z) }; });
      // every old block the diff touched, against every new block it touched: one paragraph can show up as a removal in one
      // stretch and an addition in another, so the pairing is by what the blocks say
      const olds = [];
      for (const run of runs) if (run.oldFrom) for (const l of oldLeaves) if (overlaps(l.b, run.oldFrom, run.oldTo) && !olds.some((x) => x.l === l)) olds.push({ l, afterNew: run.afterNew });
      const news = leaves.filter((l) => l.e.classList.contains('since'));
      const pairs = pairBlocks(olds.map((x) => x.l.e.textContent), news.map((l) => l.e.textContent));
      for (const [i, j] of pairs) {
        const o = olds[i].l.e;
        const w = news[j].e;
        if (o.tagName === w.tagName && o.textContent.replace(/\s+/g, ' ').trim() === w.textContent.replace(/\s+/g, ' ').trim()) { // only re-wrapped: the words are the same, so nothing changed
          w.classList.remove('since');
          v.sinceCount--;
          continue;
        }
        mergeSince(o, w);
      }
      const paired = new Set(pairs.map(([i]) => i));
      olds.forEach((x, i) => { if (!paired.has(i)) ghostGone(v, x.l.e.textContent, leaves, x.afterNew); }); // removed, with nothing that replaced it
    }
  }
  withView(v, renderMargin); // the cards say "text changed" for the blocks that did
  renderSinceBar();
  scheduleTicks();
}

// Words that changed since the baseline: inserted words are underlined, removed words are drawn as ghost text from an
// attribute (so they are not in the document's text: selecting, copying and anchoring never see them).
function mergeSince(oldEl, newEl) {
  if (oldEl.tagName !== newEl.tagName || !/^(P|H[1-6]|LI)$/.test(newEl.tagName) || newEl.querySelector('ul,ol') || oldEl.querySelector('ul,ol') || newEl.classList.contains('wmerge') || newEl.querySelector('.wdel')) return;
  const oldText = oldEl.textContent;
  const { groups, same } = diffGroups(oldText, newEl.textContent, 3);
  if (!same || !groups.length) return; // rewritten: the whole block is marked, which says it
  wrapRanges(newEl, groups.filter((g) => g.ins).map((g) => g.ins), 'sa');
  for (const g of groups.filter((x) => x.del)) ghostWords(newEl, g.at, oldText.slice(g.del[0], g.del[1]).replace(/\s+/g, ' '));
}
function ghostWords(root, at, text) {
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let ref = null;
  for (let n = w.nextNode(), pos = 0; n; n = w.nextNode()) {
    const end = pos + n.data.length;
    if (at >= pos && at < end) { ref = at > pos ? n.splitText(at - pos) : n; break; }
    pos = end;
  }
  let anchor = ref;
  while (anchor && anchor.parentNode !== root && !anchor.previousSibling && anchor.parentNode.classList.contains('sa')) anchor = anchor.parentNode; // before the insertion, not inside it
  const d = el('del', 'sdel');
  d.dataset.t = text;
  d.setAttribute('aria-hidden', 'true');
  (anchor ? anchor.parentNode : root).insertBefore(d, anchor || null);
}
function ghostGone(v, text, leaves, afterNew) {
  const g = el('div', 'since-gone');
  g.dataset.t = `Removed since ${state.since?.kind === 'review' ? 'your review' : 'then'}: ${text.replace(/\s+/g, ' ').trim().slice(0, 160)}`;
  g.setAttribute('aria-hidden', 'true');
  const next = leaves.find((l) => l.b.s > afterNew);
  let top = next && next.e;
  while (top && top.parentNode !== v.doc) top = top.parentNode;
  v.doc.insertBefore(g, top || null);
}

// ---------- comments whose lines have moved on ----------
// GitHub files a comment as "outdated" when the lines it was on change, and shows it where those lines used to be. Here the
// text it was about is found again in the current file (see reanchor in anchor.js), so the thread sits beside it, and says
// what changed in that passage since.
const origCache = new Map();
function origLines(path, sha) {
  const k = `${state.pr.owner}/${state.pr.repo}:${sha}:${path}`;
  if (!origCache.has(k)) origCache.set(k, api('/api/file?' + new URLSearchParams({ owner: state.pr.owner, repo: state.pr.repo, path, ref: sha })).then((t) => t.split(/\r?\n/)));
  return origCache.get(k);
}
const rkey = (th) => `${th.id}@${state.pr.headSha}`;
function applyReanchor(th) {
  if (!state.pr || !th.outdated || th.kind !== 'review' || th.side !== 'RIGHT') return;
  const r = state.reanchored.get(rkey(th));
  if (!r) return;
  th.reanchor = r;
  th.origText = r.origText;
  th.start = r.start;
  th.end = r.end;
}
const movedOrChanged = (th) => !!th.reanchor && (th.reanchor.how !== 'exact' || th.reanchor.start !== th.reanchor.origStart);
async function reanchorThreads(v) {
  const p = state.pr;
  const path = v.file.filename;
  let did = false;
  for (const th of state.threads.filter((t) => t.path === path && t.outdated && !t.fileLevel && !t.local && t.side === 'RIGHT')) {
    const key = rkey(th);
    const root = th.msgs[0];
    if (!root.originalCommit) continue; // GitHub did not say which commit it was made on: nothing to look the text up in
    if (!state.reanchored.has(key)) {
      let res = null;
      try {
        const orig = await origLines(path, root.originalCommit);
        const slice = orig.slice(th.start - 1, th.end);
        const r = reanchor(slice, v.lines, { quote: parseQuote(root.body).quote, hint: th.start });
        if (r) res = { ...r, origStart: th.start, origEnd: th.end, origText: slice.join('\n') };
      } catch { /* the old commit is gone, or GitHub refused: the thread stays where GitHub put it */ }
      if (state.pr !== p) return;
      state.reanchored.set(key, res);
    }
    applyReanchor(th);
    did = true;
  }
  if (did && state.pr === p) withView(v, renderMargin);
}

/** "What changed here": the passage a comment was made on, then and now, for a reworded passage. */
function thenNowEl(th) {
  const r = th.reanchor;
  const v = views.get(th.path);
  if (!r || !v?.lines) return null;
  const norm = (t) => t.replace(/\s+/g, ' ').trim();
  const then = norm(r.origText);
  const now = norm(v.lines.slice(r.start - 1, r.end).join('\n'));
  if (!then || then === now) return null; // moved or re-wrapped, not changed
  const { parts, same } = inlineDiff(then, now);
  const d = el('details', 'thennow');
  d.append(el('summary', null, r.how === 'fuzzy' ? 'What changed here (best match)' : 'What changed here'));
  const body = el('div', 'tn');
  if (same) for (const p of parts) body.append(p.t === 'same' ? document.createTextNode(p.text) : el(p.t === 'del' ? 'del' : 'ins', null, p.text));
  else { body.append(el('div', 'tn-then', then), el('div', 'tn-now', now)); }
  d.append(body);
  return d;
}

// ---------- needs you ----------
// The threads that are waiting on you: someone answered (an agent, usually), or the text you commented on changed.
let queueTimer = 0;
const scheduleQueue = () => { if (!queueTimer) queueTimer = setTimeout(() => { queueTimer = 0; updateQueue(); }, 0); };
function queueItems() {
  const me = state.me;
  if (!me || !state.pr || state.pr.kind === 'commit') return [];
  const isAuthor = state.pr.author === me;
  const order = new Map([...views.keys()].map((k, i) => [k, i]));
  const items = [];
  for (const th of state.threads) {
    if (th.kind !== 'review' || th.local || th.pending || th.info?.resolved) continue;
    const last = th.msgs[th.msgs.length - 1];
    const mine = th.msgs.some((m) => m.user === me);
    if (!mine && !isAuthor) continue; // other people's threads on other people's PRs are not yours to answer
    const reply = last.user !== me;
    const changed = !!th.sinceChanged || (th.outdated && !th.reanchor) || (!!th.reanchor && th.reanchor.how !== 'exact' && th.reanchor.how !== 'rewrapped');
    if (!reply && !(mine && changed)) continue;
    items.push({ th, reply, changed, bot: reply && !!last.bot });
  }
  return items.sort((a, b) => (order.get(a.th.path) ?? 1e9) - (order.get(b.th.path) ?? 1e9) || a.th.start - b.th.start);
}
function updateQueue() {
  const bar = $('#queue-bar');
  const items = queueItems();
  state.queue = items;
  const sig = items.map((it) => `${it.th.id}:${it.reply ? 'r' : ''}${it.changed ? 'c' : ''}:${it.th.msgs.length}`).join('|');
  if (bar.dataset.sig === sig && (items.length ? !bar.hidden : bar.hidden)) return; // nothing changed: leave the list alone (it may be open, or in the middle of a click)
  bar.dataset.sig = sig;
  const wasOpen = !!bar.querySelector('details[open]');
  bar.textContent = '';
  if (!items.length) { bar.hidden = true; return; }
  bar.hidden = false;
  const menu = el('details', 'menu');
  menu.id = 'queue-menu';
  menu.open = wasOpen;
  const sum = el('summary', 'btn');
  sum.innerHTML = `${icon('comment-discussion')} Needs you <span class="Counter">${items.length}</span>`;
  sum.title = 'Threads waiting on you. Press ] and [ to step through them.';
  const pop = el('div', 'menu-pop queue-pop');
  for (const it of items) {
    const last = it.th.msgs[it.th.msgs.length - 1];
    const b = el('button', 'menu-item queue-item');
    b.type = 'button';
    const why = [it.reply ? `${last.user}${it.bot ? ' (agent)' : ''} replied` : '', it.changed ? 'text changed' : ''].filter(Boolean).join(' · ');
    b.innerHTML = `<span class="qwhere">${esc(it.th.path.split('/').pop())} · line ${it.th.start}</span><span class="qwhy">${esc(why)}</span><span class="qtext">${esc((parseQuote(last.body).rest || last.body).replace(/\s+/g, ' ').slice(0, 100))}</span>`;
    b.addEventListener('click', () => { menu.open = false; state.qi = items.indexOf(it); focusThread(it.th); });
    pop.append(b);
  }
  menu.append(sum, pop);
  bar.append(menu);
}
async function focusThread(th) {
  await openFile(th.path);
  const v = views.get(th.path);
  const it = v?.marginItems?.find((m) => String(m.th.id) === String(th.id));
  if (it?.blocks?.[0]) it.blocks[0].scrollIntoView({ block: 'center' });
  const card = v?.margin.querySelector(`.thread[data-id="${CSS.escape(String(th.id))}"]`);
  if (card) { flash(card, 'flash'); (card.querySelector('.tacts button') || card).focus?.({ preventScroll: true }); }
}
document.addEventListener('keydown', (e) => {
  if ((e.key !== ']' && e.key !== '[') || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
  if (e.target.closest?.('input, textarea, select, summary, [contenteditable]')) return;
  const q = state.queue || [];
  if (!q.length) return;
  state.qi = ((state.qi ?? -1) + (e.key === ']' ? 1 : -1) + q.length) % q.length;
  e.preventDefault();
  focusThread(q[state.qi].th);
});

// ---------- review dialog, tree controls ----------
const pop = $('#review-pop');
// The dialog hangs off the toolbar, which only sticks once the page has scrolled: size it to the room that is
// actually left below it so Submit is always reachable.
const fitPop = () => { if (!pop.hidden) pop.style.maxHeight = Math.max(240, window.innerHeight - pop.getBoundingClientRect().top - 12) + 'px'; };
const setPop = (open) => {
  pop.hidden = !open;
  $('#review-btn').setAttribute('aria-expanded', String(open));
  if (open) { fitPop(); $('#summary').focus({ preventScroll: true }); }
};
window.addEventListener('resize', fitPop);
window.addEventListener('scroll', fitPop, { passive: true });
$('#review-btn').addEventListener('click', () => setPop(pop.hidden));
$('#review-close').addEventListener('click', () => setPop(false));
document.addEventListener('mousedown', (e) => { if (!pop.hidden && !e.target.closest('.review-wrap')) setPop(false); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !pop.hidden && !composer.contains(e.target)) setPop(false); });
$('#tree-filter').addEventListener('input', () => renderFiles());
$('#tree-toggle').innerHTML = icon('sidebar-collapse');
$('#tree-toggle').addEventListener('click', () => {
  const hidden = $('#layout').classList.toggle('tree-hidden');
  $('#tree-toggle').innerHTML = icon(hidden ? 'sidebar-expand' : 'sidebar-collapse');
  $('#tree-toggle').setAttribute('aria-expanded', String(!hidden));
  layoutAll();
});
$('#rc-caret').innerHTML = icon('triangle-down');

// ---------- theme: follow the system, or force light / dark ----------
const THEMES = ['auto', 'light', 'dark'];
const themeNow = () => { try { const t = localStorage.getItem('rico:theme'); return THEMES.includes(t) ? t : 'auto'; } catch { return 'auto'; } };
async function applyThemeSheets() {
  const t = themeNow();
  const media = (name, on) => { const l = document.querySelector(`link[href="/vendor/hljs-${name}.css"]`); if (l) l.media = t === 'auto' ? `(prefers-color-scheme: ${name})` : (t === name ? 'all' : 'not all'); };
  media('light'); media('dark');
  if (t === 'auto') return;
  try { // github-markdown-css switches on prefers-color-scheme inside one file; pin the branch we want
    const css = await (await fetch('/vendor/github-markdown.css')).text();
    const st = document.createElement('style');
    st.id = 'gmd-forced';
    st.textContent = css.replace(/@media \(prefers-color-scheme: (dark|light)\)/g, (_, k) => (k === t ? '@media all' : '@media not all'));
    document.head.append(st);
    document.getElementById('gmd')?.remove();
  } catch { /* keep the system-following sheet */ }
}
function setupTheme() {
  const b = $('#theme');
  const label = () => { b.textContent = { auto: 'Theme: auto', light: 'Theme: light', dark: 'Theme: dark' }[themeNow()]; };
  label();
  b.addEventListener('click', () => {
    const next = THEMES[(THEMES.indexOf(themeNow()) + 1) % THEMES.length];
    try { localStorage.setItem('rico:theme', next); } catch { /* private mode */ }
    location.reload(); // diagrams are rendered in the theme's colours, so start clean
  });
  applyThemeSheets();
}
setupTheme();
// the header's icon buttons, and its menus: one open at a time, closed by a click elsewhere or Escape
$('#load button').innerHTML = icon('arrow-right');
$('#settings > summary').innerHTML = icon('gear');
document.addEventListener('click', (e) => { for (const m of document.querySelectorAll('details.menu[open]')) if (!m.contains(e.target)) m.open = false; });
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  for (const m of document.querySelectorAll('details.menu[open]')) { m.open = false; m.querySelector('summary').focus(); }
});
document.addEventListener('toggle', (e) => {
  if (e.target.matches?.('details.menu') && e.target.open) for (const m of document.querySelectorAll('details.menu[open]')) if (m !== e.target) m.open = false;
}, true);
const MM = { auto: 'Comments: auto', aligned: 'Comments: aligned', sync: 'Comments: synced' };
const labelMargin = () => { $('#mmode').textContent = MM[marginMode]; };
$('#mmode').title = 'Comments column: auto switches to a synced, sticky column when the comments outgrow the document; aligned keeps each next to its text';
$('#mmode').addEventListener('click', () => { const order = ['auto', 'aligned', 'sync']; window.__rico.setMarginMode(order[(order.indexOf(marginMode) + 1) % 3]); });
labelMargin();

// ---------- boot ----------
$('#load').addEventListener('submit', (e) => { e.preventDefault(); $('#pr').blur(); loadPr($('#pr').value, null, '', true); });
initSuggest({ input: $('#pr'), list: $('#pr-list'), onPick: (ref) => { $('#pr').blur(); loadPr(ref, null, '', true); } });
// Back / Forward to another PR (or to the start page): load what the address bar now names. A fragment change within
// the same PR is not a new page.
window.addEventListener('popstate', () => {
  if (state.pr && samePr(hereAt(), state.pr)) return;
  location.reload();
});
const h = new URLSearchParams(location.hash.slice(1));
const here = hereAt();
if (here) {
  const ref = here.number ? `${here.owner}/${here.repo}#${here.number}` : here.branch ? `https://github.com/${here.owner}/${here.repo}/tree/${here.branch}` : `${here.owner}/${here.repo}@${here.sha}`;
  $('#pr').value = here.instance === 'github.com' ? ref : '';
  if (here.instance !== 'github.com') status(`Only github.com is supported (this link is for ${here.instance}).`, true);
  else loadPr(ref, new URLSearchParams(location.search).get('file'), here.number ? here.sha : '', false, here.number ? '' : new URLSearchParams(location.search).get('branch') || '');
} else if (h.get('pr')) { $('#pr').value = h.get('pr'); loadPr(h.get('pr'), h.get('f')); } // older #pr=… links
renderPanel();
const onExplore = location.pathname === '/explore';
if (onExplore) $('#cards .landing:not(#explore-page)').hidden = true; // no flash of the start page while we find out who is looking
showWho().then(() => {
  if (onExplore) { // Explore is for signed-out visitors: the signed-in start page has their own PRs
    if (!state.preview) return location.replace('/');
    document.title = 'Explore · Rico';
    $('#explore-page').hidden = false;
    showExplore($('#explore-list'));
  } else {
    const nr = document.getElementById('needs-review');
    if (nr && !state.preview) showNeedsReview(nr);
  }
});

// test hook
const setMergeWords = (on) => {
  mergeWordsOn = on;
  try { localStorage.setItem('rico:merge', on ? 'on' : 'off'); } catch { /* ignore */ }
  const b = $('#merge-toggle');
  if (b) b.setAttribute('aria-pressed', String(on));
  hideComposer();
  for (const v of views.values()) if (v.loaded && v.mode !== 'source') { v.doc.textContent = ''; withView(v, () => renderDoc(v.text)); }
  afterChange();
};
$('#merge-toggle')?.addEventListener('click', () => setMergeWords(!mergeWordsOn));
$('#merge-toggle')?.setAttribute('aria-pressed', String(mergeWordsOn));
window.__rico = { setSince, goStep, gotoId, focusThread, updateQueue, queueItems, setViewed, nextQuestion, setMergeWords, setMarginMode: (m) => { marginMode = m; try { localStorage.setItem('rico:margin', m); } catch { /* ignore */ } layoutAll(); labelMargin(); }, setPollMs: (n) => { pollMs = n; schedulePoll(); }, state, views, use, openFile, describeSelection, groupThreads, applyComments, refreshComments, postThread };
