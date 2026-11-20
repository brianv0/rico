import {
  parsePrRef, resolveRepoPath, parsePatch, clampRange, wordCount, trimBlock, locateLine, buildReview,
  formatQuote, plainQuote, coversWholeLines,
} from './lib.js';
import { diagramLang, renderDiagram, frameDoc } from './diagrams.js';

const $ = (s) => document.querySelector(s);
const doc = $('#doc');
const docwrap = $('#docwrap');
const composer = $('#composer');
const margin = $('#margin');

const md = window.markdownit({ html: false, linkify: true });
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
};

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
function restore() {
  state.comments = [];
  $('#summary').value = '';
  try {
    const v = JSON.parse(localStorage.getItem(storeKey()) || 'null');
    if (v) { state.comments = v.comments || []; $('#summary').value = v.summary || ''; }
  } catch { /* ignore */ }
}

// ---------- loading ----------
async function loadPr(ref, wantFile) {
  const parsed = parsePrRef(ref);
  if (!parsed) return status('That does not look like a GitHub PR link (try https://github.com/owner/repo/pull/123 or owner/repo#123).', true);
  status('Loading PR…');
  try {
    const pr = await api('/api/pr?ref=' + encodeURIComponent(ref)).then(JSON.parse);
    state.pr = pr;
    ({ threads: state.threads, removed: state.removed } = groupThreads(pr.comments || []));
    restore();
    renderPrBar();
    renderFiles();
    renderPanel();
    status('');
    if (!pr.files.length) {
      doc.innerHTML = '<p class="empty">This PR changes no markdown files.</p>';
      $('#legend').hidden = true;
      return;
    }
    const f = pr.files.find((x) => x.filename === wantFile) || pr.files[0];
    await openFile(f.filename);
  } catch (e) {
    status(e.message, true);
  }
}

async function openFile(filename) {
  const f = state.pr.files.find((x) => x.filename === filename);
  if (!f) return;
  hideComposer();
  status('Loading file…');
  try {
    const q = new URLSearchParams({ owner: state.pr.owner, repo: state.pr.repo, path: f.filename, ref: state.pr.headSha });
    const text = await api('/api/file?' + q);
    state.file = f;
    state.lines = text.split(/\r?\n/);
    state.diff = parsePatch(f.patch);
    history.replaceState(null, '', '#' + new URLSearchParams({ pr: $('#pr').value, f: f.filename }));
    renderDoc(text);
    renderFiles();
    status('');
  } catch (e) {
    status(e.message, true);
  }
}

function renderPrBar() {
  const p = state.pr;
  const bar = $('#prbar');
  bar.textContent = '';
  const a = document.createElement('a');
  a.href = p.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
  a.textContent = `${p.owner}/${p.repo}#${p.number}`;
  bar.append(a, ` — ${p.title} (${p.headRef} → ${p.baseRef}, ${p.state})`);
}

function renderFiles() {
  const nav = $('#files');
  nav.textContent = '';
  if (!state.pr) return;
  for (const f of state.pr.files) {
    const b = document.createElement('button');
    b.type = 'button';
    if (state.file && state.file.filename === f.filename) b.setAttribute('aria-current', 'true');
    const n = state.comments.filter((c) => c.path === f.filename).length;
    const name = document.createElement('div');
    name.textContent = f.filename;
    const stat = document.createElement('div');
    stat.className = 'stat';
    stat.innerHTML = `<span class="add">+${f.additions}</span> −${f.deletions} · ${f.status}${n ? ` · ${n} comment${n > 1 ? 's' : ''}` : ''}`;
    b.append(name, stat);
    b.addEventListener('click', () => openFile(f.filename));
    nav.append(b);
  }
}

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
  renderDiagrams(); // async; diagrams fill in when their renderer is ready
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
  for (const [n, sec] of [['y', 31536000], ['mo', 2592000], ['d', 86400], ['h', 3600], ['m', 60]]) if (d >= sec) return `${Math.floor(d / sec)}${n} ago`;
  return 'just now';
}
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

function msgEl(c) {
  const d = el('div', 'msg');
  const who = el('div', 'who');
  const av = el('span', 'av', (c.user[0] || '?').toUpperCase());
  av.style.background = `hsl(${hue(c.user)} 55% 42%)`;
  const when = el('a', null, ago(c.createdAt));
  if (/^https:\/\//.test(c.url || '')) { when.href = c.url; when.target = '_blank'; when.rel = 'noopener noreferrer'; }
  who.append(av, el('b', null, c.user), when);
  const text = el('div', 'text');
  text.innerHTML = mdc.render(c.body);
  d.append(who, text);
  return d;
}

function threadCard(th) {
  const card = el('div', 'thread' + (th.outdated ? ' outdated' : ''));
  card.dataset.id = th.id;
  th.msgs.forEach((m, i) => {
    const d = msgEl(m);
    if (i === 0 && (th.outdated || th.fileLevel)) d.querySelector('.who').append(el('span', 'badge', th.fileLevel ? 'File comment' : 'Outdated'));
    card.append(d);
  });
  const acts = el('div', 'tacts');
  const replyBtn = el('button', null, 'Reply');
  replyBtn.type = 'button';
  replyBtn.addEventListener('click', () => {
    const form = el('div', 'reply');
    const ta = el('textarea');
    ta.rows = 2; ta.placeholder = 'Reply… (Ctrl/Cmd+Enter to send)';
    const row = el('div', 'row');
    const send = el('button', 'primary', 'Reply'); send.type = 'button';
    const cancel = el('button', null, 'Cancel'); cancel.type = 'button';
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
        renderMargin();
      } catch (e) { err.textContent = e.message; send.disabled = false; }
    };
    send.addEventListener('click', doSend);
    cancel.addEventListener('click', () => { form.remove(); replyBtn.hidden = false; layoutMargin(); });
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); doSend(); } if (e.key === 'Escape') cancel.click(); });
    row.append(send, cancel);
    form.append(ta, row, err);
    replyBtn.hidden = true;
    acts.before(form);
    ta.focus();
    layoutMargin();
  });
  acts.append(replyBtn);
  card.append(acts);
  return card;
}

function draftCard(c) {
  const card = el('div', 'thread draft');
  const who = el('div', 'who');
  who.append(el('b', null, 'You'), el('span', 'badge', 'Draft — not posted yet'));
  const text = el('div', 'text', c.body);
  text.style.whiteSpace = 'pre-wrap';
  const acts = el('div', 'tacts');
  const del = el('button', null, 'Delete'); del.type = 'button';
  del.addEventListener('click', () => deleteComment(c.id));
  acts.append(del);
  card.append(who, text, acts);
  return card;
}

function deleteComment(id) {
  state.comments = state.comments.filter((x) => x.id !== id);
  save(); paintBlocks(); renderPanel(); renderFiles();
}

let marginItems = [];
function renderMargin() {
  margin.textContent = '';
  marginItems = [];
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
doc.addEventListener('click', (e) => {
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
        layoutMargin();
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
  const fit = () => { frame.style.height = Math.ceil(svg.getBoundingClientRect().height) + 4 + 'px'; layoutMargin(); };
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
    onDiagramClick(fig, hit(e.target), frame);
  }, true);
}

async function renderDiagrams() {
  for (const fig of [...doc.querySelectorAll('figure.dia')]) {
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
  layoutMargin();
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
  if (!doc.contains(range.commonAncestorContainer)) return;
  if (state.pending && $('#c-body').value.trim()) { // don't clobber a draft
    composer.classList.remove('pulse');
    void composer.offsetWidth;
    composer.classList.add('pulse');
    return;
  }
  const sel = describeSelection(range);
  if (sel) showComposer(sel);
}

doc.addEventListener('mouseup', () => setTimeout(onSelect, 0));
doc.addEventListener('keyup', (e) => { if (e.shiftKey || e.key === 'Shift') setTimeout(onSelect, 0); });

function addComment() {
  const p = state.pending;
  const body = $('#c-body').value.trim();
  if (!p || !body) return $('#c-body').focus();
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
  paintBlocks();
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
window.addEventListener('resize', () => { layoutMargin(); if (state.pending) placeComposer(state.pending.range, state.pending.rect); });
let raf = 0;
new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(layoutMargin); }).observe(doc);
document.fonts?.ready.then(layoutMargin);

// ---------- review panel ----------
function renderPanel() {
  const list = $('#list');
  list.textContent = '';
  $('#count').textContent = state.comments.length ? `(${state.comments.length})` : '';
  if (!state.comments.length) list.innerHTML = '<p class="empty">No comments yet. Select text in the document to add one.</p>';
  for (const c of state.comments) {
    const card = document.createElement('div');
    card.className = 'card';
    const where = document.createElement('div');
    where.className = 'where';
    const link = document.createElement('a');
    link.textContent = `${c.path} · ${c.start === c.end ? 'L' + c.start : `L${c.start}–${c.end}`}`;
    link.addEventListener('click', async () => {
      if (!state.file || state.file.filename !== c.path) await openFile(c.path);
      const el = [...doc.querySelectorAll('[data-l].has-c')].find((e) => overlaps(blockLines(e), c.start, c.end));
      el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
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
    edit.type = 'button'; edit.textContent = 'Edit';
    edit.addEventListener('click', () => {
      const ta = document.createElement('textarea');
      ta.value = c.body; ta.rows = 3;
      const ok = document.createElement('button');
      ok.type = 'button'; ok.textContent = 'Save'; ok.className = 'primary';
      ok.addEventListener('click', () => { c.body = ta.value.trim() || c.body; save(); renderPanel(); });
      body.replaceWith(ta);
      acts.replaceChildren(ok);
      ta.focus();
    });
    const del = document.createElement('button');
    del.type = 'button'; del.textContent = 'Delete';
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
      event: $('#event').value,
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
    save(); paintBlocks(); renderPanel(); renderFiles();
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

// ---------- boot ----------
$('#load').addEventListener('submit', (e) => { e.preventDefault(); loadPr($('#pr').value); });
const h = new URLSearchParams(location.hash.slice(1));
if (h.get('pr')) { $('#pr').value = h.get('pr'); loadPr(h.get('pr'), h.get('f')); }
renderPanel();

// test hook
window.__rico = { state, describeSelection, groupThreads };
