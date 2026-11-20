import {
  parsePrRef, parsePatch, clampRange, wordCount, trimBlock, locateLine, buildReview,
} from './lib.js';

const $ = (s) => document.querySelector(s);
const doc = $('#doc');
const docwrap = $('#docwrap');
const composer = $('#composer');

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

const state = {
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
}

function paintBlocks() {
  const wholeFileAdded = state.file.status === 'added';
  for (const el of doc.querySelectorAll('[data-l]')) {
    el.classList.remove('chg', 'ctx', 'out', 'has-c', 'pending');
    if (el.querySelector('[data-l]')) continue; // only leaf blocks get markers
    const b = blockLines(el);
    let changed = false;
    for (let l = b.s; l <= b.e && !changed; l++) changed = state.diff.added.has(l);
    if (changed && !wholeFileAdded) el.classList.add('chg');
    else if (state.diff.hunks.some((h) => overlaps(b, h.start, h.end))) el.classList.add('ctx');
    else el.classList.add('out');
    if (state.comments.some((c) => c.path === state.file.filename && overlaps(b, c.start, c.end))) el.classList.add('has-c');
  }
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
  const r = document.createRange();
  r.setStart(block, 0);
  r.setEnd(node, offset);
  const before = r.toString();
  return locateLine(state.lines, bounds, {
    which,
    fence: block.dataset.k === 'fence',
    renderedTotal: wordCount(block.textContent),
    wordsBefore: wordCount(before),
    midWord: which === 'start' && /\S$/.test(before) && /\S/.test(node.data[offset] || ''),
    newlinesBefore: (which === 'end' ? before.replace(/\n$/, '') : before).split('\n').length - 1,
  });
}

function describeSelection(range) {
  const span = textSpan(range);
  if (!span) return null;
  const a = lineAt(span.first.node, span.first.s, 'start');
  const b = lineAt(span.last.node, span.last.e, 'end');
  if (a == null || b == null) return null;
  const start = Math.min(a, b);
  const end = Math.max(a, b);
  const quote = range.toString().replace(/\n{3,}/g, '\n\n').trim();
  return { start, end, quote, anchor: clampRange(start, end, state.diff.hunks), range: range.cloneRange() };
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
  rEl.textContent = rt.text;
  rEl.classList.toggle('warn', rt.warn);
  $('#c-body').value = '';
  composer.hidden = false;
  setSelHighlight(sel.range);
  placeComposer(sel.range);
  $('#c-body').focus({ preventScroll: true });
}

function placeComposer(range) {
  const wrap = docwrap.getBoundingClientRect();
  const rects = range.getClientRects();
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
  });
  save();
  hideComposer();
  window.getSelection().removeAllRanges();
  paintBlocks();
  renderPanel();
  renderFiles();
}

$('#c-add').addEventListener('click', addComment);
$('#c-cancel').addEventListener('click', () => { hideComposer(); window.getSelection().removeAllRanges(); });
$('#c-body').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); addComment(); }
  if (e.key === 'Escape') { hideComposer(); window.getSelection().removeAllRanges(); }
});
window.addEventListener('resize', () => { if (state.pending) placeComposer(state.pending.range); });

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
    del.addEventListener('click', () => {
      state.comments = state.comments.filter((x) => x.id !== c.id);
      save(); paintBlocks(); renderPanel(); renderFiles();
    });
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
window.__rico = { state, describeSelection };
