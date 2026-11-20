import {
  parsePrRef, resolveRepoPath, parsePatch, clampRange, wordCount, trimBlock, locateLine, buildReview,
  formatQuote, plainQuote, coversWholeLines, buildFileTree, statBlocks, diffAnchor, parsePatchRows,
} from './lib.js';
import { diagramLang, renderDiagram, frameDoc } from './diagrams.js';
import { icon } from './icons.js';

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
const md = window.markdownit({ html: false, linkify: true, highlight });
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
  tokens[i].attrSet('target', '_blank');
  tokens[i].attrSet('rel', 'noopener noreferrer');
  return defaultLink(tokens, i, o, e, self);
};

// Relative images come from the PR head commit via the local server.
const defaultImage = md.renderer.rules.image || ((tokens, i, o, _e, self) => self.renderToken(tokens, i, o));
md.renderer.rules.image = (tokens, i, o, e, self) => {
  const t = tokens[i];
  if (state.pr && state.file) {
    const dir = state.file.filename.split('/').slice(0, -1).join('/');
    const p = resolveRepoPath(dir, t.attrGet('src'));
    if (p) t.attrSet('src', '/api/raw?' + new URLSearchParams({ owner: state.pr.owner, repo: state.pr.repo, ref: state.pr.headSha, path: p }));
  }
  t.attrSet('loading', 'lazy');
  return defaultImage(tokens, i, o, e, self);
};

// ```d2 and ```mermaid fences render as diagrams (client-side, optional dependencies loaded on demand);
// the source stays one click away.
const LANG_NAME = { d2: 'D2', mermaid: 'Mermaid' };
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
const mdc = window.markdownit({ html: false, linkify: true, breaks: true });
mdc.renderer.rules.link_open = md.renderer.rules.link_open;

const state = {
  threads: [], // existing PR review threads
  removed: [], // paths of threads on removed (LEFT-side) lines we cannot place

  pr: null, // {owner, repo, number, headSha, files, ...}
  file: null, // current file entry
  lines: [],
  diff: { hunks: [], added: new Set() },
  comments: [],
  pending: null, // composer draft: {start, end, quote, anchor, range}
  viewed: new Set(), // files marked "Viewed" (kept in this browser)
  closedDirs: new Set(), // collapsed folders in the file tree
};
const views = new Map(); // path -> file view {file, card, doc, margin, lines, diff, ...}
let cur = null; // the active view


// ---------- status / api ----------
function status(msg, err = false) {
  const el = $('#status');
  el.textContent = msg || '';
  el.classList.toggle('err', !!err);
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  const text = await res.text();
  if (!res.ok) {
    let m = text;
    try { m = JSON.parse(text).error || m; } catch { /* plain text */ }
    throw new Error(m);
  }
  return text;
}

// ---------- persistence ----------
const storeKey = () => `rico:${state.pr.owner}/${state.pr.repo}#${state.pr.number}:${state.pr.headSha}`;
function save() {
  try { localStorage.setItem(storeKey(), JSON.stringify({ comments: state.comments, summary: $('#summary').value })); } catch { /* private mode */ }
}
const viewedKey = () => storeKey() + ':viewed';
function saveViewed() { try { localStorage.setItem(viewedKey(), JSON.stringify([...state.viewed])); } catch { /* ignore */ } }
function restore() {
  state.viewed = new Set();
  try { state.viewed = new Set(JSON.parse(localStorage.getItem(viewedKey()) || '[]')); } catch { /* ignore */ }
  state.comments = [];
  $('#summary').value = '';
  try {
    const v = JSON.parse(localStorage.getItem(storeKey()) || 'null');
    if (v) { state.comments = v.comments || []; $('#summary').value = v.summary || ''; }
  } catch { /* ignore */ }
}

// ---------- loading ----------
const EAGER = 8; // load this many files up front; the rest load on demand
const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

async function loadPr(ref, wantFile) {
  const parsed = parsePrRef(ref);
  if (!parsed) return status('That does not look like a GitHub PR link (try https://github.com/owner/repo/pull/123 or owner/repo#123).', true);
  status('Loading PR…');
  try {
    const pr = await api('/api/pr?ref=' + encodeURIComponent(ref)).then(JSON.parse);
    state.pr = pr;
    ({ threads: state.threads, removed: state.removed } = groupThreads(pr.comments || []));
    restore();
    renderHeader();
    renderPanel();
    buildCards();
    renderFiles();
    if (!pr.files.length) {
      $('#cards').innerHTML = '<p class="empty">This PR changes no markdown files.</p>';
      $('#legend').hidden = true;
      status('');
      return;
    }
    const first = pr.files.find((x) => x.filename === wantFile) || pr.files[0];
    use(views.get(first.filename)); // active before anything renders
    const eager = [first, ...pr.files.filter((f) => f !== first)].slice(0, EAGER);
    await Promise.all(eager.map((f) => loadView(views.get(f.filename)).catch((e) => status(e.message, true))));
    use(views.get(first.filename));
    if (wantFile) scrollToCard(first.filename);
    renderFiles();
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

// ----- file tree (all changed files; markdown ones open here, the rest link to GitHub) -----
function renderFiles() {
  const nav = $('#files');
  nav.textContent = '';
  const p = state.pr;
  if (!p) return;
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
      const count = state.threads.filter((t) => t.path === n.path).length + state.comments.filter((c) => c.path === n.path).length;
      const inner = `${icon(stIcon, { cls: stCls })}<span class="nm" title="${esc(n.path)}">${esc(n.name)}</span>`
        + (state.viewed.has(n.path) ? `<span class="tick" title="Viewed">${icon('check')}</span>` : '')
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
        row.href = `${p.url}/files`;
        row.target = '_blank';
        row.rel = 'noopener noreferrer';
        row.title = 'Not reviewable in Rico: opens on GitHub';
        diffAnchor(n.path).then((h) => { row.href = `${p.url}/files#${h}`; }).catch(() => {});
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
  for (const f of state.pr.files) {
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
  stat.innerHTML = `<span class="add">+${f.additions}</span><span class="del">−${f.deletions}</span><span class="sqs">${[...statBlocks(f.additions, f.deletions)].map((c) => `<i class="sq ${c === 'n' ? '' : c}"></i>`).join('')}</span>`;
  const seg = el('div', 'seg');
  seg.setAttribute('role', 'group');
  seg.setAttribute('aria-label', 'Display');
  const mk = (label, mode, pressed) => { const b = el('button', null, label); b.type = 'button'; b.dataset.mode = mode; b.setAttribute('aria-pressed', String(pressed)); return b; };
  seg.append(mk('Rendered', 'rendered', true), mk('Source diff', 'source', false));
  const viewed = el('label', 'viewed');
  const vcb = el('input');
  vcb.type = 'checkbox';
  vcb.checked = state.viewed.has(f.filename);
  viewed.append(vcb, ' Viewed');
  head.append(chev, name, copy, stat, seg, viewed);

  const v = {
    file: f, card, lines: [], diff: { hunks: [], added: new Set() }, rows: [], loaded: false, loading: null, mode: 'rendered', marginItems: [],
    doc: el('div', 'rico-doc markdown-body'), margin: el('div', 'rico-margin'), src: el('div', 'rico-src'),
  };
  const body = el('div', 'file-body');
  body.append(v.doc, v.margin);
  const more = el('button', 'btn load-more', 'Load file');
  more.type = 'button';
  more.addEventListener('click', () => openFile(f.filename));
  v.doc.append(more);
  card.append(head, body, v.src);
  card.classList.toggle('collapsed', vcb.checked);
  chev.addEventListener('click', () => { const c = card.classList.toggle('collapsed'); chev.setAttribute('aria-expanded', String(!c)); if (!c) openFile(f.filename); });
  vcb.addEventListener('change', () => {
    if (vcb.checked) state.viewed.add(f.filename); else state.viewed.delete(f.filename);
    card.classList.toggle('collapsed', vcb.checked); // GitHub collapses a file once it is viewed
    chev.setAttribute('aria-expanded', String(!vcb.checked));
    saveViewed(); renderFiles();
  });
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
const refreshAll = () => { for (const v of views.values()) if (v.loaded) withView(v, paintBlocks); };
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
      v.doc.textContent = '';
      v.loaded = true;
      withView(v, () => renderDoc(text));
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
  history.replaceState(null, '', '#' + new URLSearchParams({ pr: $('#pr').value, f: filename }));
  scrollToCard(filename);
  renderFiles();
}

function setMode(v, mode) {
  v.mode = mode;
  v.card.classList.toggle('src', mode === 'source');
  for (const b of v.card.querySelectorAll('.seg button')) b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
  if (mode === 'source') renderSource(v);
  else withView(v, layoutMargin);
}
function renderSource() { /* source diff view: added below */ }

// ---------- rendering the document ----------
const blockLines = (el) => {
  const [a, b] = el.dataset.l.split('-').map(Number);
  return trimBlock(state.lines, a, b);
};
const overlaps = (b, s, e) => b.s <= e && b.e >= s;

function renderDoc(text) {
  doc.innerHTML = md.render(text);
  $('#legend').hidden = false;
  paintBlocks();
  renderDiagrams(cur); // async; diagrams fill in when their renderer is ready
}

function paintBlocks() {
  const wholeFileAdded = state.file.status === 'added';
  for (const el of doc.querySelectorAll('[data-l]')) {
    el.classList.remove('chg', 'ctx', 'out', 'has-c', 'has-t', 'hl', 'pending');
    if (el.querySelector('[data-l]')) continue; // only leaf blocks get markers
    const b = blockLines(el);
    let changed = false;
    for (let l = b.s; l <= b.e && !changed; l++) changed = state.diff.added.has(l);
    if (changed && !wholeFileAdded) el.classList.add('chg');
    else if (state.diff.hunks.some((h) => overlaps(b, h.start, h.end))) el.classList.add('ctx');
    else el.classList.add('out');
    if (state.comments.some((c) => c.path === state.file.filename && overlaps(b, c.start, c.end))) el.classList.add('has-c');
    if (state.threads.some((t) => t.path === state.file.filename && overlaps(b, t.start, t.end))) el.classList.add('has-t');
  }
  renderMargin();
}

// ---------- existing review threads + drafts in the margin ----------
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
  for (const { root, msgs } of groups.values()) {
    if (root.side === 'LEFT') { removed.push(root.path); continue; } // line numbers refer to the base file
    msgs.sort((a, b) => (a.id === root.id ? -1 : b.id === root.id ? 1 : Date.parse(a.createdAt) - Date.parse(b.createdAt)));
    const end = root.line ?? root.originalLine ?? 1;
    const start = Math.min(end, root.startLine ?? root.originalStartLine ?? end);
    threads.push({ id: root.id, path: root.path, start, end, msgs, outdated: root.line == null, fileLevel: root.line == null && root.originalLine == null });
  }
  return { threads, removed };
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

function msgEl(c) {
  const d = el('div', 'msg');
  const who = el('div', 'who');
  const when = el('a', null, `commented ${ago(c.createdAt)}`);
  if (/^https:\/\//.test(c.url || '')) { when.href = c.url; when.target = '_blank'; when.rel = 'noopener noreferrer'; }
  who.append(avatarEl(c.user, c.avatar), el('b', null, c.user), when);
  if (ASSOC[c.assoc]) who.append(el('span', 'badge', ASSOC[c.assoc]));
  const text = el('div', 'text markdown-body');
  text.innerHTML = mdc.render(c.body);
  d.append(who, text);
  return d;
}

function threadCard(th) {
  const owner = cur; // the file this thread belongs to (callbacks may run while another file is active)
  const card = el('div', 'thread' + (th.outdated ? ' outdated' : ''));
  card.dataset.id = th.id;
  th.msgs.forEach((m, i) => {
    const d = msgEl(m);
    if (i === 0 && (th.outdated || th.fileLevel)) d.querySelector('.who').append(el('span', 'badge', th.fileLevel ? 'File comment' : 'Outdated'));
    card.append(d);
  });
  const acts = el('div', 'tacts');
  const replyBtn = el('button', 'btn', 'Reply');
  replyBtn.type = 'button';
  replyBtn.addEventListener('click', () => {
    const form = el('div', 'reply');
    const ta = el('textarea');
    ta.rows = 2; ta.placeholder = 'Reply… (Ctrl/Cmd+Enter to send)';
    const row = el('div', 'row');
    const send = el('button', 'btn btn-primary', 'Reply'); send.type = 'button';
    const cancel = el('button', 'btn', 'Cancel'); cancel.type = 'button';
    const err = el('div', 'err');
    const doSend = async () => {
      const text = ta.value.trim();
      if (!text) return;
      send.disabled = true;
      try {
        const res = await api('/api/reply', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Rico': '1' },
          body: JSON.stringify({ owner: state.pr.owner, repo: state.pr.repo, number: state.pr.number, commentId: th.id, text }),
        }).then(JSON.parse);
        th.msgs.push(res);
        withView(owner, renderMargin);
      } catch (e) { err.textContent = e.message; send.disabled = false; }
    };
    send.addEventListener('click', doSend);
    cancel.addEventListener('click', () => { form.remove(); replyBtn.hidden = false; withView(owner, layoutMargin); });
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); doSend(); } if (e.key === 'Escape') cancel.click(); });
    row.append(send, cancel);
    form.append(ta, row, err);
    replyBtn.hidden = true;
    acts.before(form);
    ta.focus();
    withView(owner, layoutMargin);
  });
  acts.append(replyBtn);
  card.append(acts);
  return card;
}

function draftCard(c) {
  const card = el('div', 'thread draft');
  const msg = el('div', 'msg');
  const who = el('div', 'who');
  who.append(el('b', null, 'You'), el('span', 'badge', 'Pending'), el('span', null, 'not posted yet'));
  const text = el('div', 'text', c.body);
  text.style.whiteSpace = 'pre-wrap';
  msg.append(who, text);
  const acts = el('div', 'tacts');
  const del = el('button', 'btn', 'Delete'); del.type = 'button';
  del.addEventListener('click', () => deleteComment(c.id));
  acts.append(del);
  card.append(msg, acts);
  return card;
}

function deleteComment(id) {
  state.comments = state.comments.filter((x) => x.id !== id);
  save(); refreshAll(); renderPanel(); renderFiles();
}

let marginItems = [];
function renderMargin() {
  if (!cur || !margin) return;
  margin.textContent = '';
  marginItems = cur.marginItems = [];
  if (!state.file) return;
  const path = state.file.filename;
  const leaves = [...doc.querySelectorAll('[data-l]')].filter((e) => !e.querySelector('[data-l]')).map((e) => ({ e, b: blockLines(e) }));
  const raw = [
    ...state.threads.filter((t) => t.path === path).map((t) => ({ card: threadCard(t), start: t.start, end: t.end, id: t.id })),
    ...state.comments.filter((c) => c.path === path).map((c) => ({ card: draftCard(c), start: c.start, end: c.end, id: c.id })),
  ];
  for (const it of raw) {
    let blocks = leaves.filter((l) => overlaps(l.b, it.start, it.end)).map((l) => l.e);
    if (!blocks.length && leaves.length) { // outdated lines that no longer exist: nearest block
      const dist = (l) => (l.b.e < it.start ? it.start - l.b.e : l.b.s - it.end);
      blocks = [leaves.reduce((a, b) => (dist(b) < dist(a) ? b : a)).e];
    }
    it.blocks = blocks;
    it.card.addEventListener('mouseenter', () => it.blocks.forEach((b) => b.classList.add('hl')));
    it.card.addEventListener('mouseleave', () => it.blocks.forEach((b) => b.classList.remove('hl')));
    margin.append(it.card);
    marginItems.push(it);
  }
  const removedHere = state.removed.filter((p) => p === path).length; // only this file's
  if (removedHere) {
    const n = el('div', 'note', `${removedHere} thread${removedHere > 1 ? 's' : ''} on removed lines not shown here.`);
    n.dataset.note = '1';
    margin.append(n);
  }
  layoutMargin();
}

function layoutMargin() {
  if (!margin) return;
  const wide = !matchMedia('(max-width: 1150px)').matches;
  const note = margin.querySelector('[data-note]');
  if (!wide) { margin.style.height = ''; for (const it of marginItems) it.card.style.top = ''; if (note) note.style.top = ''; return; }
  const base = margin.getBoundingClientRect().top;
  const placed = marginItems
    .map((it) => ({ it, want: it.blocks.length ? it.blocks[0].getBoundingClientRect().top - base : 0 }))
    .sort((a, b) => a.want - b.want);
  let y = 0;
  for (const { it, want } of placed) {
    const top = Math.max(want, y);
    it.card.style.top = top + 'px';
    y = top + it.card.offsetHeight + 8;
  }
  if (note) { note.style.top = y + 'px'; y += note.offsetHeight + 8; }
  margin.style.height = Math.max(y, doc.offsetHeight) + 'px';
}

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
  if (!v || v.mode !== 'rendered') return;
  use(v);
  if (!window.getSelection().isCollapsed) return;
  const fig = e.target.closest && e.target.closest('.dia-out');
  if (fig && e.target === fig) onDiagramClick(fig.closest('figure'), null);
  const b = e.target.closest && e.target.closest('[data-l]');
  if (b) activateAt(b.querySelector('[data-l]') ? b : b);
});

// ---------- diagrams (D2, Mermaid) ----------
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
    frame.srcdoc = frameDoc(res.svg);
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
  sel.aboutShort = hit ? `${hit.kind} “${hit.label}”` : '';
  sel.rect = rect;
  showComposer(sel);
  markElement(hit ? hit.el : null);
}

// ---------- selection -> source lines ----------
function textSpan(range) {
  const walker = document.createTreeWalker(doc, NodeFilter.SHOW_TEXT);
  let first = null;
  let last = null;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!range.intersectsNode(n)) continue;
    let s = n === range.startContainer ? range.startOffset : 0;
    let e = n === range.endContainer ? range.endOffset : n.data.length;
    while (s < e && /\s/.test(n.data[s])) s++;
    while (e > s && /\s/.test(n.data[e - 1])) e--;
    if (e <= s) continue;
    if (!first) first = { node: n, s, e };
    last = { node: n, s, e };
  }
  return first ? { first, last } : null;
}

function lineAt(node, offset, which) {
  const block = node.parentElement && node.parentElement.closest('[data-l]');
  if (!block || !doc.contains(block)) return null;
  const bounds = blockLines(block);
  if (block.dataset.k === 'diagram' && !node.parentElement.closest('.dia-src pre code')) return which === 'start' ? bounds.s : bounds.e;
  const codeEl = block.dataset.k === 'diagram' ? block.querySelector('.dia-src pre code') : block;
  const r = document.createRange();
  r.setStart(codeEl, 0);
  r.setEnd(node, offset);
  const before = r.toString();
  return locateLine(state.lines, bounds, {
    which,
    fence: block.dataset.k === 'fence' || block.dataset.k === 'diagram',
    renderedTotal: wordCount(block.textContent),
    wordsBefore: wordCount(before),
    midWord: which === 'start' && /\S$/.test(before) && /\S/.test(node.data[offset] || ''),
    newlinesBefore: (which === 'end' ? before.replace(/\n$/, '') : before).split('\n').length - 1,
  });
}

// Fenced code: language and the source lines between the fences.
function fenceInfo(b) {
  const open = state.lines[b.s - 1] || '';
  const m = /^\s*(`{3,}|~{3,})\s*([^\s`]*)/.exec(open);
  const closed = b.e > b.s && /^\s*(`{3,}|~{3,})\s*$/.test(state.lines[b.e - 1] || '');
  return m ? { lang: m[2], a: b.s + 1, b: closed ? b.e - 1 : b.e } : { lang: '', a: b.s, b: b.e };
}

// The relevant parts of a selection, one segment per block it touches, in order.
// Prose is the selected text; code (fences, indented code, D2) is the source lines themselves.
function segmentsFor(range) {
  const leaves = [...doc.querySelectorAll('[data-l]')].filter((e) => !e.querySelector('[data-l]') && range.intersectsNode(e));
  const segs = [];
  for (const el of leaves) {
    const r = document.createRange();
    r.selectNodeContents(el);
    if (range.compareBoundaryPoints(Range.START_TO_START, r) > 0) r.setStart(range.startContainer, range.startOffset);
    if (range.compareBoundaryPoints(Range.END_TO_END, r) < 0) r.setEnd(range.endContainer, range.endOffset);
    const k = el.dataset.k;
    if (k === 'fence' || k === 'diagram' || el.tagName === 'PRE') {
      const fi = fenceInfo(blockLines(el));
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
      segs.push({ kind: 'code', lang: k === 'diagram' ? el.dataset.lang : fi.lang, text: state.lines.slice(a - 1, z).join('\n') });
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

function finishSelection(start, end, segments, range) {
  const quote = plainQuote(segments);
  const anchor = clampRange(start, end, state.diff.hunks);
  // fence markers are not content: compare against the lines a reader would actually see
  const whole = coversWholeLines(quote, state.lines.slice(start - 1, end).filter((l) => !/^\s*(`{3,}|~{3,})/.test(l)));
  return {
    start, end, quote, segments, quoteMd: formatQuote(segments), anchor, range: range.cloneRange(),
    includeDefault: !anchor || !anchor.exact || !whole, // a quote only helps when it adds information
  };
}

function describeSelection(range) {
  const span = textSpan(range);
  if (!span) return null;
  const a = lineAt(span.first.node, span.first.s, 'start');
  const b = lineAt(span.last.node, span.last.e, 'end');
  if (a == null || b == null) return null;
  return finishSelection(Math.min(a, b), Math.max(a, b), segmentsFor(range), range);
}

function rangeText(start, end, anchor) {
  const span = start === end ? `line ${start}` : `lines ${start}–${end}`;
  if (!anchor) return { text: `${span} — outside the diff, so this goes into the review summary (quoted).`, warn: true };
  const aspan = anchor.start === anchor.end ? `line ${anchor.start}` : `lines ${anchor.start}–${anchor.end}`;
  if (anchor.exact) return { text: `Comments on ${aspan}`, warn: false };
  return { text: `You selected ${span}; GitHub can anchor ${aspan} (one hunk). The full quote is included.`, warn: true };
}

// ---------- composer (floats over the selection) ----------
function setSelHighlight(range) {
  if (!('highlights' in CSS)) return;
  CSS.highlights.delete('rico-sel');
  if (range) CSS.highlights.set('rico-sel', new Highlight(range));
}

function showComposer(sel) {
  sel.view = sel.view || cur;
  state.pending = sel;
  $('#c-quote').textContent = sel.quote.length > 240 ? sel.quote.slice(0, 240) + '…' : sel.quote;
  const rt = rangeText(sel.start, sel.end, sel.anchor);
  const rEl = $('#c-range');
  rEl.textContent = rt.text + (sel.about ? ` — ${sel.about}` : '');
  rEl.classList.toggle('warn', rt.warn);
  const inc = $('#c-qinc');
  inc.checked = sel.includeDefault;
  inc.disabled = !sel.anchor; // unanchored comments live in the summary, where the quote is the only context
  $('#c-qnote').textContent = sel.anchor ? (sel.includeDefault ? '' : 'GitHub already shows these lines') : 'required: goes in the summary';
  $('#c-quote').classList.toggle('off', !inc.checked);
  $('#c-qtext').value = sel.quoteMd;
  $('#c-qtext').hidden = true;
  $('#c-qedit').setAttribute('aria-expanded', 'false');
  $('#c-body').value = '';
  composer.hidden = false;
  setSelHighlight(sel.about ? null : sel.range); // an element comment highlights the element, not the whole figure
  placeComposer(sel.range, sel.rect);
  $('#c-body').focus({ preventScroll: true });
}

function placeComposer(range, rect) {
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
  markElement(null);
  composer.hidden = true;
  state.pending = null;
  setSelHighlight(null);
}

function onSelect() {
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
  const sel = describeSelection(range);
  if (sel) showComposer(sel);
}

$('#cards').addEventListener('mouseup', () => setTimeout(onSelect, 0));
$('#cards').addEventListener('keyup', (e) => { if (e.shiftKey || e.key === 'Shift') setTimeout(onSelect, 0); });

function addComment() {
  const p = state.pending;
  const body = $('#c-body').value.trim();
  if (!p || !body) return $('#c-body').focus();
  use(p.view);
  state.comments.push({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    path: state.file.filename,
    start: p.start, end: p.end, quote: p.quote, anchor: p.anchor, body,
    about: p.aboutShort || '', // diagram element, so the comment says what it is about on GitHub
    includeQuote: p.anchor ? $('#c-qinc').checked : true,
    quoteMd: $('#c-qtext').value.trim(), // markdown actually posted; the user may have edited it
  });
  save();
  hideComposer();
  window.getSelection().removeAllRanges();
  refreshAll();
  renderPanel();
  renderFiles();
}

$('#c-qinc').addEventListener('change', () => $('#c-quote').classList.toggle('off', !$('#c-qinc').checked));
$('#c-qedit').addEventListener('click', () => {
  const t = $('#c-qtext');
  t.hidden = !t.hidden;
  $('#c-qedit').setAttribute('aria-expanded', String(!t.hidden));
  if (!t.hidden) t.focus(); else $('#c-body').focus();
  if (state.pending) placeComposer(state.pending.range);
});
$('#c-add').addEventListener('click', addComment);
$('#c-cancel').addEventListener('click', () => { hideComposer(); window.getSelection().removeAllRanges(); });
$('#c-body').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); addComment(); }
  if (e.key === 'Escape') { hideComposer(); window.getSelection().removeAllRanges(); }
});
const layoutAll = () => { for (const v of views.values()) if (v.loaded) withView(v, layoutMargin); };
window.addEventListener('resize', () => { layoutAll(); if (state.pending) placeComposer(state.pending.range, state.pending.rect); });
document.fonts?.ready.then(layoutAll);

// ---------- review panel ----------
function renderPanel() {
  const list = $('#list');
  list.textContent = '';
  $('#count').textContent = state.comments.length ? `(${state.comments.length})` : '';
  const rc = $('#rc-count');
  rc.textContent = String(state.comments.length);
  rc.hidden = !state.comments.length;
  if (!state.comments.length) list.innerHTML = '<p class="empty">No pending comments. Select text in a file to add one.</p>';
  for (const c of state.comments) {
    const card = document.createElement('div');
    card.className = 'card';
    const where = document.createElement('div');
    where.className = 'where';
    const link = document.createElement('a');
    link.textContent = `${c.path} · ${c.start === c.end ? 'L' + c.start : `L${c.start}–${c.end}`}`;
    link.addEventListener('click', async () => {
      $('#review-pop').hidden = true;
      if (!state.file || state.file.filename !== c.path) await openFile(c.path);
      const target = [...doc.querySelectorAll('[data-l].has-c')].find((e) => overlaps(blockLines(e), c.start, c.end));
      target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
    where.append(link);
    const q = document.createElement('blockquote');
    q.textContent = c.quote;
    const rt = rangeText(c.start, c.end, c.anchor);
    const note = document.createElement('div');
    note.className = 'note' + (rt.warn ? ' warn' : '');
    note.textContent = rt.text;
    const body = document.createElement('div');
    body.className = 'body';
    body.textContent = c.body;
    const acts = document.createElement('div');
    acts.className = 'acts';
    const edit = document.createElement('button');
    edit.type = 'button'; edit.textContent = 'Edit'; edit.className = 'btn';
    edit.addEventListener('click', () => {
      const ta = document.createElement('textarea');
      ta.value = c.body; ta.rows = 3;
      const ok = document.createElement('button');
      ok.type = 'button'; ok.textContent = 'Save'; ok.className = 'btn btn-primary';
      ok.addEventListener('click', () => { c.body = ta.value.trim() || c.body; save(); renderPanel(); });
      body.replaceWith(ta);
      acts.replaceChildren(ok);
      ta.focus();
    });
    const del = document.createElement('button');
    del.type = 'button'; del.textContent = 'Delete'; del.className = 'btn';
    del.addEventListener('click', () => deleteComment(c.id));
    acts.append(edit, del);
    card.append(where, q, note, body, acts);
    list.append(card);
  }
  $('#submit').disabled = !state.comments.length && !$('#summary').value.trim();
}
$('#summary').addEventListener('input', () => { if (state.pr) save(); renderPanelButton(); });
const renderPanelButton = () => { $('#submit').disabled = !state.comments.length && !$('#summary').value.trim(); };

$('#submit').addEventListener('click', async () => {
  const btn = $('#submit');
  const out = $('#result');
  out.textContent = '';
  btn.disabled = true;
  btn.textContent = 'Submitting…';
  try {
    const review = buildReview({
      comments: state.comments,
      summary: $('#summary').value,
      event: document.querySelector('input[name="event"]:checked').value,
      commitId: state.pr.headSha,
    });
    const res = await api('/api/review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Rico': '1' },
      body: JSON.stringify({ owner: state.pr.owner, repo: state.pr.repo, number: state.pr.number, review }),
    }).then(JSON.parse);
    const a = document.createElement('a');
    a.href = res.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
    a.textContent = 'Review posted — open on GitHub';
    out.replaceChildren(a);
    state.comments = [];
    $('#summary').value = '';
    save(); refreshAll(); renderPanel(); renderFiles();
  } catch (e) {
    const d = document.createElement('div');
    d.className = 'err';
    d.textContent = e.message + ' — your comments are still queued.';
    out.replaceChildren(d);
  } finally {
    btn.textContent = 'Submit review';
    renderPanelButton();
  }
});

// ---------- review dialog, tree controls ----------
const pop = $('#review-pop');
const setPop = (open) => { pop.hidden = !open; $('#review-btn').setAttribute('aria-expanded', String(open)); if (open) $('#summary').focus({ preventScroll: true }); };
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
$('#brand-mark').innerHTML = icon('comment-discussion');
$('#rc-caret').innerHTML = icon('triangle-down');

// ---------- boot ----------
$('#load').addEventListener('submit', (e) => { e.preventDefault(); loadPr($('#pr').value); });
const h = new URLSearchParams(location.hash.slice(1));
if (h.get('pr')) { $('#pr').value = h.get('pr'); loadPr(h.get('pr'), h.get('f')); }
renderPanel();

// test hook
window.__rico = { state, views, use, openFile, describeSelection, groupThreads };
