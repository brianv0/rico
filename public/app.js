import {
  parsePrRef, previewLines, prPath, parsePrPath, resolveRepoPath, parsePatch, clampRange, wordCount, trimBlock, locateLine, buildReview,
  formatQuote, plainQuote, coversWholeLines, buildFileTree, statBlocks, diffAnchor, parsePatchRows,
} from './lib.js';
import { diagramLang, renderDiagram, frameDoc } from './diagrams.js';
import { icon } from './icons.js';
import { patchHunkRanges, patchDeletions, oldToNewMap } from './lib.js';

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
  comments: [],
  pending: null, // composer draft: {start, end, quote, anchor, range}
  viewed: new Set(), // files marked "Viewed" (kept in this browser)
  closedDirs: new Set(), // collapsed folders in the file tree
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
    try { const j = JSON.parse(text); m = j.error || m; if (j.signin) needSignin = true; } catch { /* plain text */ }
    throw new Error(m);
  }
  return text;
}

// hosted mode shows who is signed in; locally the server's own token is used and there is nothing to sign into
async function showWho() {
  const who = $('#who');
  try {
    const res = await fetch('/api/me');
    const me = await res.json().catch(() => ({}));
    if (res.ok && me.hosted) {
      who.innerHTML = `${me.avatar ? `<img alt="" src="${esc(me.avatar)}">` : ''}<span>${esc(me.login)}</span>`;
      const out = who.appendChild(el('button', 'btn', 'Sign out'));
      out.type = 'button';
      out.addEventListener('click', async () => { await fetch('/auth/logout', { method: 'POST', headers: { 'X-Rico': '1' } }); location.reload(); });
    } else if (res.status === 401 && me.signin) {
      const a = who.appendChild(el('a', 'btn btn-primary', 'Sign in with GitHub'));
      a.href = signinUrl();
    }
  } catch { /* offline: leave it empty */ }
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

// The address bar always names the PR (and the commit it was loaded at) and the open file, so it can be shared.
function syncUrl(filename) {
  if (!state.pr) return;
  const p = state.pr;
  const q = filename ? '?' + new URLSearchParams({ file: filename }) : '';
  const url = prPath({ owner: p.owner, repo: p.repo, number: p.number }, p.headSha) + q;
  if (location.pathname + location.search + location.hash !== url) history.replaceState(null, '', url);
}

async function loadPr(ref, wantFile, wantSha = '') {
  const parsed = parsePrRef(ref);
  if (!parsed) return status('That does not look like a GitHub PR link (try https://github.com/owner/repo/pull/123 or owner/repo#123).', true);
  status('Loading PR…');
  try {
    const pr = await api('/api/pr?ref=' + encodeURIComponent(ref)).then(JSON.parse);
    state.pr = pr;
    if (wantSha && pr.headSha && !pr.headSha.startsWith(wantSha)) {
      setTimeout(() => status(`This link was made at commit ${wantSha}; the PR is now at ${pr.headSha.slice(0, 7)}, so lines and comments may have moved.`, true), 0);
    }
    ({ threads: state.threads, removed: state.removed, left: state.leftThreads } = groupThreads(pr.comments || []));
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
    syncUrl(wantFile && first.filename === wantFile ? wantFile : '');
    use(views.get(first.filename)); // active before anything renders
    const eager = [first, ...pr.files.filter((f) => f !== first)].slice(0, EAGER);
    await Promise.all(eager.map((f) => loadView(views.get(f.filename)).catch((e) => status(e.message, true))));
    // Do NOT force the first file active again here: the user may have opened another file while these loads ran.
    if (wantFile && cur === views.get(first.filename)) scrollToCard(first.filename);
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
const refreshView = (v) => { if (v.mode === 'source') renderSource(v); else withView(v, renderMargin); };
const refreshAll = () => { for (const v of views.values()) if (v.loaded) { if (v.mode === 'source') renderSource(v); else withView(v, paintBlocks); } };
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
  syncUrl(filename);
  scrollToCard(filename);
  renderFiles();
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
      const drafts = state.comments.filter((c) => c.path === path && (c.side || 'RIGHT') === side && c.end === line);
      // context lines exist on both sides: a LEFT thread on a context line sits under it too
      const ctxLeft = r.type === 'ctx' ? all.filter((t) => !t.outdated && t.side === 'LEFT' && t.end === r.old) : [];
      const ctxLeftDrafts = r.type === 'ctx' ? state.comments.filter((c) => c.path === path && c.side === 'LEFT' && c.end === r.old) : [];
      const cards = [...here, ...ctxLeft].map((t) => { placed.add(t.id); return threadCard(t); });
      cards.push(...[...drafts, ...ctxLeftDrafts].map((c) => draftCard(c)));
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
    for (const l of mine) placeRemoved(v, old, l.e, target, prev, run.afterNew);
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
    if (target && target.e.tagName === kind && target.e.parentNode) { target.e.parentNode.insertBefore(clone, target.e); return; }
    if (prev && prev.e.tagName === kind && prev.b.e === afterNew && prev.e.parentNode) { prev.e.parentNode.insertBefore(clone, prev.e.nextSibling); return; }
  }
  let inner = clone; // otherwise a standalone block, wrapped in clones of its old ancestors (list, table, blockquote…)
  if (!isDia) for (let a = L.parentElement; a && a !== oldRoot; a = a.parentElement) { const c = a.cloneNode(false); c.append(inner); inner = c; }
  const wrap = el('div', 'rm');
  wrap.title = 'Removed in this PR';
  wrap.append(inner);
  let top = target && target.e;
  while (top && top.parentNode !== v.doc) top = top.parentNode;
  v.doc.insertBefore(wrap, top || null);
}

function renderDoc(text) {
  doc.innerHTML = safeHtml(md.render(text));
  $('#legend').hidden = false;
  renderRemoved(cur);
  paintBlocks();
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
      if (state.comments.some((c) => c.path === state.file.filename && c.side === 'LEFT' && overlaps(b, c.start, c.end))) el.classList.add('has-c');
      if (state.leftThreads.some((t) => t.path === state.file.filename && overlaps(b, t.start, t.end))) el.classList.add('has-t');
      continue;
    }
    let changed = false;
    for (let l = b.s; l <= b.e && !changed; l++) changed = state.diff.added.has(l);
    if (changed && !wholeFileAdded) el.classList.add('chg');
    else if (state.diff.hunks.some((h) => overlaps(b, h.start, h.end))) el.classList.add('ctx');
    else el.classList.add('out');
    if (state.comments.some((c) => c.path === state.file.filename && c.side !== 'LEFT' && overlaps(b, c.start, c.end))) el.classList.add('has-c');
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
  const left = [];
  for (const { root, msgs } of groups.values()) {
    msgs.sort((a, b) => (a.id === root.id ? -1 : b.id === root.id ? 1 : Date.parse(a.createdAt) - Date.parse(b.createdAt)));
    const end = root.line ?? root.originalLine ?? 1;
    const start = Math.min(end, root.startLine ?? root.originalStartLine ?? end);
    const th = { id: root.id, path: root.path, start, end, msgs, side: root.side === 'LEFT' ? 'LEFT' : 'RIGHT', outdated: root.line == null, fileLevel: root.line == null && root.originalLine == null };
    if (th.side === 'LEFT') { removed.push(root.path); left.push(th); continue; } // base-file line numbers: shown in the source diff
    threads.push(th);
  }
  return { threads, removed, left };
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
  text.innerHTML = safeHtml(mdc.render(c.body));
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
        refreshView(owner);
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
  const all = leafBlocks(doc).map((e) => ({ e, b: blockLines(e), rm: isRemoved(e) }));
  const newLeaves = all.filter((l) => !l.rm);
  const oldLeaves = all.filter((l) => l.rm);
  const oldToNew = oldToNewMap(cur.rows);
  const raw = [
    ...state.threads.filter((t) => t.path === path).map((t) => ({ card: threadCard(t), start: t.start, end: t.end, id: t.id, side: 'RIGHT' })),
    ...state.leftThreads.filter((t) => t.path === path).map((t) => ({ card: threadCard(t), start: t.start, end: t.end, id: t.id, side: 'LEFT' })),
    ...state.comments.filter((c) => c.path === path).map((c) => ({ card: draftCard(c), start: c.start, end: c.end, id: c.id, side: c.side === 'LEFT' ? 'LEFT' : 'RIGHT' })),
  ];
  let unplaced = 0;
  for (const it of raw) {
    let blocks;
    if (it.side === 'LEFT') {
      blocks = oldLeaves.filter((l) => overlaps(l.b, it.start, it.end)).map((l) => l.e); // beside the removed block it is about
      if (!blocks.length) { // a comment on an unchanged old line: its new-file counterpart
        const n = oldToNew.get(it.end);
        if (n) blocks = newLeaves.filter((l) => overlaps(l.b, n, n)).map((l) => l.e);
      }
      if (!blocks.length) { unplaced++; continue; }
    } else {
      blocks = newLeaves.filter((l) => overlaps(l.b, it.start, it.end)).map((l) => l.e);
      if (!blocks.length && newLeaves.length) { // outdated lines that no longer exist: nearest block
        const dist = (l) => (l.b.e < it.start ? it.start - l.b.e : l.b.s - it.end);
        blocks = [newLeaves.reduce((a, b) => (dist(b) < dist(a) ? b : a)).e];
      }
    }
    it.blocks = blocks;
    it.card.addEventListener('mouseenter', () => it.blocks.forEach((b) => b.classList.add('hl')));
    it.card.addEventListener('mouseleave', () => it.blocks.forEach((b) => b.classList.remove('hl')));
    margin.append(it.card);
    marginItems.push(it);
  }
  if (unplaced) { // the old file was unavailable, or the line is not part of what is shown
    const n = el('div', 'note', `${unplaced} thread${unplaced > 1 ? 's' : ''} on removed lines not shown here (see Source diff).`);
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
  const cell = e.target.closest && e.target.closest('.d-num');
  if (cell && v && v.mode === 'source') { use(v); onLineClick(v, cell, e.shiftKey); return; }
  const link = e.target.closest && e.target.closest('a[href^="#"]');
  if (link && v) { // our own URL hash holds the PR, so keep fragment links in the page
    e.preventDefault();
    const slug = decodeURIComponent(link.getAttribute('href').slice(1));
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
    if (fig.dataset.lang === 'd2' && hit.kind === 'node') { // a container node owns its whole { ... } block, not just its first line
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

function lineAt(node, offset, which) {
  const block = node.parentElement && node.parentElement.closest('[data-l]');
  if (!block || !doc.contains(block)) return null;
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
  const leaves = [...doc.querySelectorAll('[data-l]')].filter((e) => !e.querySelector('[data-l]') && range.intersectsNode(e));
  const segs = [];
  for (const el of leaves) {
    const r = document.createRange();
    r.selectNodeContents(el);
    if (range.compareBoundaryPoints(Range.START_TO_START, r) > 0) r.setStart(range.startContainer, range.startOffset);
    if (range.compareBoundaryPoints(Range.END_TO_END, r) < 0) r.setEnd(range.endContainer, range.endOffset);
    const k = el.dataset.k;
    const lines = linesOf(el);
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
  const sideOf = (n) => { const b = n.parentElement && n.parentElement.closest('[data-l]'); return b && doc.contains(b) ? (isRemoved(b) ? 'LEFT' : 'RIGHT') : null; };
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
  if (!anchor) return { text: `${span(start, end)} — outside the diff, so this goes into the review summary (quoted).`, warn: true };
  if (anchor.exact) return { text: `Comments on ${span(anchor.start, anchor.end)}`, warn: false };
  return { text: `You selected ${span(start, end)}; GitHub can anchor ${span(anchor.start, anchor.end)} (one hunk). The full quote is included.`, warn: true };
}

// ---------- selection icons + composer (both sit in the right margin, like Google Docs) ----------
// Two custom glyphs: a speech bubble holding a quotation mark, and one holding a pilcrow (the text's lines, no quote).
const BUBBLE = '<path d="M3 2.5h14A1.5 1.5 0 0 1 18.5 4v9a1.5 1.5 0 0 1-1.5 1.5H9.5L5.5 18v-3.5H3A1.5 1.5 0 0 1 1.5 13V4A1.5 1.5 0 0 1 3 2.5Z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>';
const GLYPH_QUOTE = '<path d="M6.4 6.2h2.6v2.7c0 1.4-.7 2.3-1.9 2.6l-.4-.9c.7-.3 1-.7 1-1.3H6.4Zm4.5 0h2.6v2.7c0 1.4-.7 2.3-1.9 2.6l-.4-.9c.7-.3 1-.7 1-1.3h-1.3Z" fill="currentColor"/>';
const GLYPH_PARA = '<path d="M11.3 5.3H8.6a2 2 0 0 0 0 4h.9v2.9h1.1V6.4h.7v5.8h1.1V6.4h.5V5.3h-1.6Z" fill="currentColor"/>';
$('#sb-quote').innerHTML = `<svg viewBox="0 0 20 20" aria-hidden="true">${BUBBLE}${GLYPH_QUOTE}</svg>`;
$('#sb-lines').innerHTML = `<svg viewBox="0 0 20 20" aria-hidden="true">${BUBBLE}${GLYPH_PARA}</svg>`;
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
  selbar.hidden = false;
  const w = selbar.offsetWidth;
  selbar.style.top = (pt.y - wrap.top + 12) + 'px';
  selbar.style.left = Math.max(8, Math.min(pt.x - wrap.left - w / 2, wrap.width - w - 8)) + 'px';
}
function hideSelbar() { selbar.hidden = true; state.sel = null; }

for (const [id, withQuote] of [['sb-quote', true], ['sb-lines', false]]) {
  const b = $('#' + id);
  b.addEventListener('mousedown', (e) => e.preventDefault()); // keep the text selection alive
  b.addEventListener('click', () => {
    const sel = state.sel;
    if (!sel) return;
    if (withQuote) sel.includeDefault = true; // else keep the default: a quote only when it adds information
    hideSelbar();
    showComposer(sel);
  });
}

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
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !selbar.hidden) { hideSelbar(); window.getSelection().removeAllRanges(); } });
document.addEventListener('mousedown', (e) => { if (!selbar.hidden && !selbar.contains(e.target)) setTimeout(() => { const s = window.getSelection(); if (!s || s.isCollapsed) hideSelbar(); }, 0); });
function setSelHighlight(range) {
  if (!('highlights' in CSS)) return;
  CSS.highlights.delete('rico-sel');
  if (range) CSS.highlights.set('rico-sel', new Highlight(range));
}

function showComposer(sel) {
  sel.view = sel.view || cur;
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
  const rEl = $('#c-range');
  rEl.textContent = rt.text + (sel.touchesRemoved ? ' — includes removed text (quoted)' : '');
  rEl.classList.toggle('warn', rt.warn);
  const inc = $('#c-qinc');
  inc.checked = sel.includeDefault;
  inc.disabled = !sel.anchor; // unanchored comments live in the summary, where the quote is the only context
  $('#c-qnote').textContent = sel.anchor ? (sel.includeDefault ? '' : 'GitHub already shows these lines') : 'required: goes in the summary';
  $('#c-quote').hidden = !inc.checked && !sel.diagram; // a diagram element's source is always shown: you can't see the raw text you are commenting on
  $('#c-qtext').value = sel.quoteMd;
  $('#c-qtext').hidden = true;
  $('#c-qedit').setAttribute('aria-expanded', 'false');
  $('#c-body').value = '';
  composer.hidden = false;
  setSelHighlight(sel.about || sel.rows ? null : sel.range); // an element or a diff line highlights itself, not a text range
  for (const r of sel.rows || []) r.classList.add('d-sel');
  placeComposer(sel.range, sel.rect);
  $('#c-body').focus({ preventScroll: true });
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

$('#cards').addEventListener('mouseup', (e) => { const pt = { x: e.clientX, y: e.clientY }; setTimeout(() => onSelect(pt), 0); });
$('#cards').addEventListener('keyup', (e) => { if (e.shiftKey || e.key === 'Shift') setTimeout(onSelect, 0); });

function addComment() {
  const p = state.pending;
  const body = $('#c-body').value.trim();
  if (!p || !body) return $('#c-body').focus();
  use(p.view);
  state.comments.push({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    path: state.file.filename,
    side: p.side || 'RIGHT', // LEFT: a removed line, commented on from the source diff
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
    link.textContent = `${c.path} · ${c.start === c.end ? 'L' + c.start : `L${c.start}–${c.end}`}${c.side === 'LEFT' ? ' (removed)' : ''}`;
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
$('#brand-mark').innerHTML = icon('comment-discussion');
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

// ---------- boot ----------
$('#load').addEventListener('submit', (e) => { e.preventDefault(); loadPr($('#pr').value); });
const h = new URLSearchParams(location.hash.slice(1));
const here = parsePrPath(location.pathname);
if (here) {
  const ref = `${here.owner}/${here.repo}#${here.number}`;
  $('#pr').value = here.instance === 'github.com' ? ref : '';
  if (here.instance !== 'github.com') status(`Only github.com is supported (this link is for ${here.instance}).`, true);
  else loadPr(ref, new URLSearchParams(location.search).get('file'), here.sha);
} else if (h.get('pr')) { $('#pr').value = h.get('pr'); loadPr(h.get('pr'), h.get('f')); } // older #pr=… links
renderPanel();
showWho();

// test hook
window.__rico = { state, views, use, openFile, describeSelection, groupThreads };
