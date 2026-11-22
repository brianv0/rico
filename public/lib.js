// Pure logic shared by the browser UI, the server, and the tests. No DOM, no Node APIs.

/** Parse "https://github.com/o/r/pull/12/files", "o/r#12", "o/r/pull/12" -> {owner, repo, number} | null */
export function parsePrRef(input) {
  const s = String(input || '').trim();
  let m = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/i.exec(s);
  if (!m) m = /^([\w.-]+)\/([\w.-]+)(?:#|\/pull\/)(\d+)$/.exec(s);
  // '.' or '..' would normalise away in the API path (/repos/../x -> /x): never accept them as owner/repo
  if (!m || /^\.+$/.test(m[1]) || /^\.+$/.test(m[2])) return null;
  return { owner: m[1], repo: m[2], number: Number(m[3]) };
}

/** Shorten a long multi-line quote for display: the first `head` lines, a gap marker, the last `tail` lines. */
export function previewLines(text, head = 5, tail = 5) {
  const lines = String(text).split('\n');
  if (lines.length <= head + tail + 1) return { head: lines, omitted: 0, tail: [] };
  return { head: lines.slice(0, head), omitted: lines.length - head - tail, tail: lines.slice(-tail) };
}

/** The shareable page path for a PR: /github.com/owner/repo/7 or /github.com/owner/repo/7@abc1234 (the head commit). */
export function prPath({ owner, repo, number }, sha = '', instance = 'github.com') {
  return `/${instance}/${owner}/${repo}/${number}${sha ? '@' + String(sha).slice(0, 7) : ''}`;
}

/** Inverse of prPath. -> {instance, owner, repo, number, sha} | null */
export function parsePrPath(pathname) {
  const m = /^\/([\w.-]+\.[\w.-]+(?::\d+)?)\/([\w.-]+)\/([\w.-]+)\/(\d+)(?:@([0-9a-f]{4,40}))?\/?$/i.exec(String(pathname || ''));
  if (!m || /^\.+$/.test(m[2]) || /^\.+$/.test(m[3])) return null; // dot segments, as in parsePrRef
  return { instance: m[1].toLowerCase(), owner: m[2], repo: m[3], number: Number(m[4]), sha: m[5] || '' };
}

/**
 * Parse a unified-diff patch (as returned by GET /pulls/:n/files) into the RIGHT-side
 * line numbers GitHub will accept review comments on.
 *   hunks: [{start, end}]  contiguous RIGHT-side ranges (context + added lines)
 *   added: Set of added RIGHT-side line numbers
 */
export function parsePatch(patch) {
  const hunks = [];
  const added = new Set();
  if (!patch) return { hunks, added };
  let ln = 0;
  let remaining = 0;
  let cur = null;
  for (const raw of String(patch).split('\n')) {
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(raw);
    if (m) {
      ln = Number(m[1]);
      remaining = m[2] === undefined ? 1 : Number(m[2]);
      cur = { start: ln, end: ln - 1 };
      hunks.push(cur);
      continue;
    }
    if (!cur) continue;
    const c = raw[0];
    if (c === '-' || c === '\\') continue; // removed line / "no newline" marker: not on the RIGHT side
    if (remaining <= 0) continue;
    if (c === '+') added.add(ln);
    else if (c !== ' ' && raw !== '') continue;
    cur.end = ln;
    ln++;
    remaining--;
  }
  return { hunks: hunks.filter((h) => h.end >= h.start), added };
}

/**
 * Clamp a wanted source-line range to what GitHub can anchor a comment to.
 * A multi-line comment must sit inside one hunk, so pick the hunk with the largest overlap.
 * Returns {start, end, exact} or null when the range touches no hunk.
 */
export function clampRange(start, end, hunks) {
  let best = null;
  for (const h of hunks) {
    const s = Math.max(start, h.start);
    const e = Math.min(end, h.end);
    if (s > e) continue;
    const len = e - s + 1;
    if (!best || len > best.len) best = { start: s, end: e, len };
  }
  return best ? { start: best.start, end: best.end, exact: best.start === start && best.end === end } : null;
}

/** Number of "words" (whitespace-separated tokens containing a letter or digit). */
export function wordCount(text) {
  let n = 0;
  for (const t of String(text).split(/\s+/)) if (/[\p{L}\p{N}]/u.test(t)) n++;
  return n;
}

/** Words in one markdown source line, ignoring list/quote/heading markers that never render. */
export function srcWords(line) {
  let s = String(line);
  for (;;) {
    const next = s.replace(/^\s*(?:>|[-*+]|\d+[.)])\s+/, '').replace(/^\s*#{1,6}\s+/, '').replace(/^\s*\[[ xX]\]\s+/, '');
    if (next === s) break;
    s = next;
  }
  if (/^\s*\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/i.test(s)) return 0; // alert marker line
  return wordCount(s);
}

/** Which line (index into counts) holds word number `idx` (0-based)? Skips zero-word lines. */
export function lineForWord(counts, idx) {
  let acc = 0;
  for (let i = 0; i < counts.length; i++) {
    acc += counts[i];
    if (idx < acc) return i;
  }
  return counts.length - 1;
}

/** Trim blank lines off a markdown-it block map [start0, end0) -> 1-based inclusive {s, e}. */
export function trimBlock(lines, start0, end0) {
  let s = start0 + 1;
  let e = Math.min(end0, lines.length);
  while (e > s && !String(lines[e - 1] ?? '').trim()) e--;
  return { s, e };
}

/**
 * Locate the source line for one end of a selection inside a block.
 *  block: {s, e} 1-based inclusive; lines: all source lines
 *  info: {fence, renderedTotal, wordsBefore (words fully/partly before the point),
 *         newlinesBefore (code blocks), midWord, which: 'start'|'end'}
 * Falls back to the block's own bounds whenever the rendered text and the source disagree.
 */
export function locateLine(lines, block, info) {
  const { s, e } = block;
  const fallback = info.which === 'start' ? s : e;
  if (s === e) return s;
  if (info.fence) {
    const body = Math.max(0, info.newlinesBefore);
    return Math.min(e, Math.max(s, s + 1 + body));
  }
  const counts = lines.slice(s - 1, e).map(srcWords);
  const total = counts.reduce((a, b) => a + b, 0);
  if (!total || total !== info.renderedTotal) return fallback;
  const idx =
    info.which === 'start'
      ? Math.min(total - 1, Math.max(0, info.wordsBefore - (info.midWord ? 1 : 0)))
      : Math.min(total - 1, Math.max(0, info.wordsBefore - 1));
  return s + lineForWord(counts, idx);
}

/** Markdown blockquote of (truncated) text. */
export function quoteText(text, max = 600) {
  let t = String(text).replace(/\r/g, '').trim();
  if (t.length > max) t = t.slice(0, max).trimEnd() + '…';
  return t.split('\n').map((l) => (l ? '> ' + l : '>')).join('\n');
}

const fenceFor = (text) => { let n = 3; while (text.includes('`'.repeat(n))) n++; return '`'.repeat(n); };

/** Keep the head and the tail of a long string: "start … end". */
export function clipMiddle(text, max) {
  const t = String(text);
  if (t.length <= max) return t;
  const head = Math.ceil(max * 0.6);
  return t.slice(0, head).trimEnd() + ' … ' + t.slice(t.length - (max - head)).trimStart();
}
function clipLines(text, maxLines) {
  const ls = text.split('\n');
  if (ls.length <= maxLines) return text;
  const h = Math.ceil(maxLines / 2);
  return [...ls.slice(0, h), '…', ...ls.slice(ls.length - (maxLines - h))].join('\n');
}

/**
 * Format the relevant parts of a selection as markdown.
 *  segments: [{kind: 'text', text} | {kind: 'code', lang, text}] in document order.
 * Prose becomes a blockquote; code becomes a fenced block with its language. Long selections keep
 * their first and last parts with an ellipsis between, so the reader sees where it starts and ends.
 */
export function formatQuote(segments, { max = 700, maxCodeLines = 12 } = {}) {
  const segs = (segments || []).filter((x) => x && String(x.text).trim());
  if (!segs.length) return '';
  const render = (list) => {
    let md = '';
    let prevText = false;
    for (const x of list) {
      let piece;
      const isText = x.kind !== 'code';
      if (isText) piece = String(x.text).trim().split('\n').map((l) => (l.trim() ? '> ' + l : '>')).join('\n');
      else {
        const t = clipLines(String(x.text).replace(/\s+$/, ''), maxCodeLines);
        const f = fenceFor(t);
        piece = `${f}${x.lang || ''}\n${t}\n${f}`;
      }
      md += md ? (prevText && isText ? '\n>\n' : '\n\n') + piece : piece;
      prevText = isText;
    }
    return md;
  };
  let list = segs;
  let md = render(list);
  if (md.length > max && list.length > 2) {
    list = [list[0], { kind: 'text', text: '…' }, list[list.length - 1]];
    md = render(list);
  }
  if (md.length > max) {
    const per = Math.max(80, Math.floor(max / list.length));
    list = list.map((x) => (x.kind === 'code' ? x : { ...x, text: clipMiddle(x.text, per) }));
    md = render(list);
  }
  return md;
}

/** The selection as plain text (code is raw), for previews and the sidebar. */
export const plainQuote = (segments) => (segments || []).map((x) => String(x.text).trim()).filter(Boolean).join('\n\n');

/** Does the selection cover its anchored source lines entirely? (then a quote adds nothing) */
export function coversWholeLines(selectedText, srcLines) {
  const total = srcLines.reduce((n, l) => n + srcWords(l), 0);
  return total > 0 && wordCount(selectedText) === total;
}

const spanOf = (s, e) => (s === e ? `line ${s}` : `lines ${s}–${e}`);

/**
 * When GitHub can anchor only part of the selection, the whole range still travels with the comment: a collapsed
 * block holding the actual source lines (each cut to `maxLine` chars, long ranges to their head and tail).
 *   c: {path, start, end, side, lines (the source lines start..end), sha (commit those lines are from)}
 */
export function rangeDetails(c, { maxLine = 240, maxLines = 40 } = {}) {
  let lines = c.lines.map((l) => clipMiddle(String(l).replace(/\s+$/, ''), maxLine - 3));
  if (lines.length > maxLines) {
    const h = Math.ceil(maxLines / 2);
    lines = [...lines.slice(0, h), `… ${lines.length - maxLines} more lines …`, ...lines.slice(lines.length - (maxLines - h))];
  }
  const text = lines.join('\n');
  const f = fenceFor(text);
  const sha = c.sha ? ` at ${String(c.sha).slice(0, 7)}${c.side === 'LEFT' ? ' (old file)' : ''}` : '';
  return `<details><summary>Full selection: ${spanOf(c.start, c.end)} of <code>${c.path.replace(/[<&]/g, (x) => (x === '<' ? '&lt;' : '&amp;'))}</code>${sha}</summary>\n\n${f}\n${text}\n${f}\n\n</details>`;
}

/**
 * One review comment, formatted for GitHub's line-comment API ({path, line, side, start_line?, start_side?, body}).
 * The body is: an optional "Re:" note (a diagram element), a note when the range was clamped to the diff, the
 * quote (only when `includeQuote`, or by default when the anchor is not exact), then the comment itself.
 * Needs c.anchor; use buildPrComment for text outside the diff.
 */
export function buildLineComment(c) {
  const quote = c.quoteMd !== undefined ? c.quoteMd : quoteText(c.quote);
  const parts = [];
  if (c.about) parts.push(`_Re: ${c.about}_`); // which diagram element this is about
  if (!c.anchor.exact) { // GitHub can pin fewer lines than were selected: say the whole range, in words an agent can act on
    const old = c.side === 'LEFT' ? ' (old file)' : '';
    parts.push(`_Selected ${spanOf(c.start, c.end)} of \`${c.path}\`${old}. GitHub can only anchor ${spanOf(c.anchor.start, c.anchor.end)} here, but this comment is about all of ${spanOf(c.start, c.end)}._`);
  }
  const include = c.includeQuote !== undefined ? c.includeQuote : !c.anchor.exact;
  if (include && quote) parts.push(quote);
  parts.push(c.body);
  if (!c.anchor.exact && c.lines?.length) parts.push(rangeDetails(c));
  const side = c.side === 'LEFT' ? 'LEFT' : 'RIGHT'; // LEFT = a removed (or original-side) line in the source diff
  const item = { path: c.path, line: c.anchor.end, side, body: parts.join('\n\n') };
  if (c.anchor.start < c.anchor.end) {
    item.start_line = c.anchor.start;
    item.start_side = side;
  }
  return item;
}

// ---------- suggested edits ----------

/** Can this selection carry a GitHub suggestion? Only whole new-file lines inside one hunk can. */
export function canSuggest(sel) {
  if (!sel) return { ok: false, reason: 'Select some text first.' };
  if (sel.side === 'LEFT' || sel.touchesRemoved) return { ok: false, reason: 'Suggestions edit the new file, and this is removed text.' };
  if (!sel.anchor) return { ok: false, reason: 'This text is outside the diff, so GitHub cannot attach a suggestion to it.' };
  if (!sel.anchor.exact) return { ok: false, reason: 'Part of the selection is outside the diff or in another hunk. Select within one hunk.' };
  return { ok: true, reason: '' };
}

/** The comment body for a suggestion: an optional note, then a ```suggestion block holding the replacement lines. */
export function suggestionBody(newText, note = '') {
  const text = String(newText).replace(/\r/g, '').replace(/\n$/, '');
  let f = '```';
  while (text.includes(f)) f += '`';
  const block = text === '' ? `${f}suggestion\n${f}` : `${f}suggestion\n${text}\n${f}`; // an empty block deletes the lines
  return [String(note).trim(), block].filter(Boolean).join('\n\n');
}

/** Line diff for the live preview: [{type: 'ctx' | 'del' | 'add', text}] (LCS; falls back to replace-all for huge input). */
export function lineDiff(a, b) {
  const x = Array.isArray(a) ? a : String(a).split('\n');
  const y = Array.isArray(b) ? b : String(b).split('\n');
  if (x.length * y.length > 250000) return [...x.map((text) => ({ type: 'del', text })), ...y.map((text) => ({ type: 'add', text }))];
  const n = x.length;
  const m = y.length;
  const t = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) t[i][j] = x[i] === y[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) { out.push({ type: 'ctx', text: x[i] }); i++; j++; }
    else if (t[i + 1][j] >= t[i][j + 1]) out.push({ type: 'del', text: x[i++] });
    else out.push({ type: 'add', text: y[j++] });
  }
  while (i < n) out.push({ type: 'del', text: x[i++] });
  while (j < m) out.push({ type: 'add', text: y[j++] });
  return out;
}

/** Pull the replacement lines out of a comment body's ```suggestion block (null when there is none). */
export function parseSuggestion(body) {
  const m = /(^|\n)(`{3,})suggestion[^\n]*\n([\s\S]*?)(?:\n)?\2[ \t]*(?:\n|$)/.exec(String(body || ''));
  return m ? m[3] : null;
}

/**
 * Text outside the diff cannot be a line comment: it becomes a normal PR comment that says where it is
 * (file and lines), quotes the text, and carries the comment. parseQuote reads the quote back to place it.
 */
export function buildPrComment(c) {
  const quote = c.quoteMd !== undefined ? c.quoteMd : quoteText(c.quote);
  const where = c.start === c.end ? `L${c.start}` : `L${c.start}–${c.end}`;
  return [`**\`${c.path}\` ${where}**`, c.about ? `_Re: ${c.about}_` : '', quote, c.body].filter(Boolean).join('\n\n');
}

/**
 * Turn queued comments into a GitHub "create review" payload (kept for batch posting through REST).
 * Comments that cannot be anchored to a diff line go into the review body, always with their quote.
 */
export function buildReview({ comments, summary, event, commitId }) {
  const inline = [];
  const loose = [];
  for (const c of comments) {
    const quote = c.quoteMd !== undefined ? c.quoteMd : quoteText(c.quote);
    if (c.anchor) inline.push(buildLineComment(c));
    else {
      const where = c.start === c.end ? `L${c.start}` : `L${c.start}–${c.end}`;
      loose.push(`**\`${c.path}\` ${where}**\n${quote}\n\n${c.body}`);
    }
  }
  const body = [summary?.trim(), ...loose].filter(Boolean).join('\n\n---\n\n');
  const out = { commit_id: commitId, event, comments: inline };
  if (body) out.body = body;
  return out;
}

/**
 * Read a comment body written by buildLineComment / buildPrComment back apart:
 *   {path, lines, about, quote, rest}  quote is the first prose blockquote (plain text, no "> "), null when there is none.
 * Only the lead-in lines (location header, "Re:" / "Selected" notes) may come before the quote, so a quote the
 * reviewer typed deeper in their own text is not mistaken for the selection.
 */
export function parseQuote(body) {
  const lines = String(body || '').replace(/\r/g, '').split('\n');
  let i = 0;
  let path = null;
  let about = null;
  const skipBlank = () => { while (i < lines.length && !lines[i].trim()) i++; };
  skipBlank();
  for (let guard = 0; guard < 3 && i < lines.length; guard++) {
    const l = lines[i].trim();
    let m;
    if ((m = /^\*\*`([^`]+)` (L\d+(?:–\d+)?)\*\*$/.exec(l))) path = m[1];
    else if ((m = /^_Re: (.*)_$/.exec(l))) about = m[1];
    else if (/^_Selected .*\._$/.test(l)) { /* clamp note */ } else break;
    i++;
    skipBlank();
  }
  const out = { path, about, quote: null, rest: lines.slice(i).join('\n').trim() };
  if (i < lines.length && /^>/.test(lines[i])) {
    const q = [];
    let j = i;
    for (; j < lines.length && /^>/.test(lines[j]); j++) q.push(lines[j].replace(/^>\s?/, ''));
    out.quote = q.join('\n').trim();
    out.rest = lines.slice(j).join('\n').trim();
  }
  return out;
}

/** A quote's paragraphs (a selection across blocks is quoted block by block), each to be found on its own. */
export function quoteParts(quote) {
  return String(quote || '').split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean);
}

/** Collapse whitespace runs to one space and trim; map[i] = index in the original string of normalized char i. */
export function normalizeWithMap(str) {
  const s = String(str);
  let text = '';
  const map = [];
  let space = false;
  for (let i = 0; i < s.length; i++) {
    if (/\s/.test(s[i])) { space = text.length > 0; continue; }
    if (space) { text += ' '; map.push(i); space = false; }
    text += s[i];
    map.push(i);
  }
  return { text, map };
}

/**
 * Where does a quote sit in a block of rendered text? Returns {start, end} offsets into `hay` (end exclusive) or null.
 * A quote shortened with "…" (head … tail) matches from its head to its tail.
 */
export function findQuote(hay, quote) {
  const h = normalizeWithMap(hay);
  const parts = normalizeWithMap(String(quote || '').replace(/\n+/g, ' ')).text.split(/\s*…\s*/).filter(Boolean);
  if (!parts.length) return null;
  const head = parts[0];
  const i = h.text.indexOf(head);
  if (i < 0) return null;
  let end = i + head.length;
  if (parts.length > 1) {
    const tail = parts[parts.length - 1];
    const j = h.text.indexOf(tail, end);
    if (j >= 0) end = j + tail.length;
  }
  return { start: h.map[i], end: h.map[end - 1] + 1 };
}

/**
 * Resolve a markdown image/link target to a repo-root-relative path, or null when it is not
 * a relative repo path (absolute URL, protocol-relative, data:, #anchor).
 *   fileDir: directory of the markdown file, e.g. "docs/guide" ("" for the repo root)
 */
export function resolveRepoPath(fileDir, src) {
  const raw = String(src || '').split(/[?#]/)[0];
  if (!raw || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(src)) return null;
  const parts = raw.startsWith('/') ? [] : String(fileDir || '').split('/').filter(Boolean);
  for (const seg of raw.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { if (!parts.length) return null; parts.pop(); continue; }
    try { parts.push(decodeURIComponent(seg)); } catch { return null; } // a broken %-escape must not abort the whole render
  }
  return parts.length ? parts.join('/') : null;
}


// ---------- diagrams: map a clicked element back to source lines ----------

/** D2 range "index,6:0:102-6:23:125" -> {s, e} (0-based lines) */
export function parseD2Range(r) {
  // the WASM build gives the string; the JS port gives a Range object whose toJSON() is that string (its toString() is something else)
  const str = typeof r === 'string' ? r : r && typeof r.toJSON === 'function' ? r.toJSON() : String(r || '');
  const m = /,(\d+):\d+:\d+-(\d+):\d+:\d+$/.exec(String(str || ''));
  return m ? { s: Number(m[1]), e: Number(m[2]) } : null;
}

/** D2 tags each SVG group with base64(id) as its first class; ids are HTML-escaped ("-&gt;"). */
export function decodeD2Class(cls) {
  try {
    const bin = atob(String(cls).split(/\s+/)[0]);
    const txt = new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
    return txt.replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  } catch { return null; }
}

/**
 * From a D2 compile result, which source lines define each shape and connection?
 *   shapes: Map(shape id -> [{s, e}...])  every reference, definition first
 *   conns:  Map(connection id -> [{s, e}])
 * Shapes pair with graph objects by position (both come from the same ordered list). Connections
 * pair with the edge statements in the AST in document order; if the counts disagree we map nothing
 * rather than guess.
 */
export function d2LineMaps(diagram, graph) {
  const shapes = new Map();
  const conns = new Map();
  const objs = graph?.objects || [];
  const shs = diagram?.shapes || [];
  if (objs.length === shs.length) {
    objs.forEach((o, i) => {
      const refs = (o.references || []).map((r) => parseD2Range(r.key?.range)).filter(Boolean);
      if (refs.length) shapes.set(shs[i].id, refs);
    });
  }
  const edges = [];
  const walk = (nodes) => {
    for (const n of nodes || []) {
      const mk = n.map_key;
      if (!mk) continue;
      for (const e of mk.edges || []) { const r = parseD2Range(e.range); if (r) edges.push(r); }
      walk(mk.value?.map?.nodes);
    }
  };
  walk(graph?.ast?.nodes);
  const cs = diagram?.connections || [];
  if (edges.length === cs.length) cs.forEach((c, i) => conns.set(c.id, [edges[i]]));
  return { shapes, conns };
}

const reEsc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ARROW = /(-->|---|==>|===|-\.->|-\.-|--[xo]|<-->|->>|-->>|-x|--\)|-\)|->|<-)/;

/**
 * Find the source line a clicked Mermaid element refers to.
 *  hint: {kind: 'node', id} | {kind: 'edge', from, to, n} | {kind: 'actor', id} | {kind: 'text', text}
 * Returns {s, e} (0-based lines) or null when nothing matches (the caller then uses the whole block).
 */
export function findMermaidLines(source, hint) {
  const lines = String(source).split('\n');
  const idx = (pred, from = 0) => { for (let i = from; i < lines.length; i++) if (pred(lines[i], i)) return i; return -1; };
  const word = (t) => new RegExp('(^|[^\\w])' + reEsc(t) + '([^\\w]|$)');
  const one = (i) => (i < 0 ? null : { s: i, e: i });
  if (!hint) return null;
  if (hint.kind === 'node') {
    const w = word(hint.id);
    const decl = new RegExp('(^|[^\\w])' + reEsc(hint.id) + '\\s*(\\[|\\(|\\{|>|\\)\\))');
    const i = idx((l) => decl.test(l));
    return one(i >= 0 ? i : idx((l) => w.test(l)));
  }
  if (hint.kind === 'edge') {
    const a = word(hint.from);
    const b = word(hint.to);
    const hits = [];
    lines.forEach((l, i) => {
      if (!ARROW.test(l) || !a.test(l) || !b.test(l)) return;
      const pa = l.search(a); const pb = l.slice(pa + 1).search(b);
      if (pb >= 0) hits.push(i);
    });
    return one(hits.length ? hits[Math.min(hint.n || 0, hits.length - 1)] : -1);
  }
  if (hint.kind === 'actor') {
    const w = word(hint.id);
    const decl = idx((l) => /^\s*(participant|actor)\b/.test(l) && w.test(l));
    return one(decl >= 0 ? decl : idx((l) => w.test(l)));
  }
  if (hint.kind === 'text' && hint.text) {
    const t = hint.text.trim();
    const colon = idx((l) => l.includes(':') && l.slice(l.indexOf(':') + 1).trim() === t); // sequence message
    return one(colon >= 0 ? colon : idx((l) => l.includes(t)));
  }
  return null;
}

/**
 * Split DOT source into tokens with their 0-based line: identifiers (quoted strings unescaped,
 * numerals, HTML-like <...> strings), the arrows "->" and "--", and single punctuation characters.
 * Comments (//, /* *\/ and lines starting with #) are skipped.
 */
export function dotTokens(source) {
  const src = String(source);
  const out = [];
  let i = 0;
  let line = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '\n') { line++; i++; continue; }
    if (/\s/.test(c)) { i++; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') line++; i++; }
      i += 2;
      continue;
    }
    if (c === '#' && (i === 0 || src[i - 1] === '\n')) { while (i < n && src[i] !== '\n') i++; continue; }
    const at = line;
    if (c === '"') {
      let t = '';
      i++;
      while (i < n && src[i] !== '"') {
        if (src[i] === '\\' && i + 1 < n) { if (src[i + 1] === '"') { t += '"'; i += 2; continue; } if (src[i + 1] === '\n') { line++; i += 2; continue; } t += src[i]; i++; continue; }
        if (src[i] === '\n') line++;
        t += src[i++];
      }
      i++;
      out.push({ t, line: at, type: 'id' });
      while (src[i] === ' ' && /^ *\+ *"/.test(src.slice(i, i + 12))) { // "a" + "b" concatenation
        i = src.indexOf('"', i + 1) + 1;
        let more = '';
        while (i < n && src[i] !== '"') { if (src[i] === '\n') line++; more += src[i++]; }
        i++;
        out[out.length - 1].t += more;
      }
      continue;
    }
    if (c === '<') {
      let depth = 0;
      let t = '';
      while (i < n) {
        if (src[i] === '<') depth++;
        else if (src[i] === '>') { depth--; if (depth === 0) { i++; break; } }
        if (src[i] === '\n') line++;
        t += src[i++];
      }
      out.push({ t: t.slice(1), line: at, type: 'id' });
      continue;
    }
    if ((c === '-' && (src[i + 1] === '>' || src[i + 1] === '-'))) { out.push({ t: src.slice(i, i + 2), line: at, type: 'arrow' }); i += 2; continue; }
    if (/[A-Za-z0-9_.\u0080-￿-]/.test(c)) {
      let t = '';
      while (i < n && /[A-Za-z0-9_.\u0080-￿-]/.test(src[i]) && !(src[i] === '-' && (src[i + 1] === '>' || src[i + 1] === '-'))) t += src[i++];
      out.push({ t, line: at, type: 'id' });
      continue;
    }
    out.push({ t: c, line: at, type: 'p' });
    i++;
  }
  return out;
}

/**
 * Find the source line a clicked Graphviz element refers to. Graphviz titles every SVG group with the
 * node name, "a->b" / "a--b" for an edge, or "cluster_x" for a cluster.
 *  hint: {kind: 'node', id} | {kind: 'edge', from, to, n} | {kind: 'cluster', id}
 * Returns {s, e} (0-based lines) or null when nothing matches (the caller then uses the whole block).
 * Only statement-level tokens count (attribute lists in [...] are skipped), so a label that happens to
 * contain a node's name is never mistaken for the node.
 */
export function findDotLines(source, hint) {
  if (!hint) return null;
  const toks = dotTokens(source);
  const one = (l) => (l == null ? null : { s: l, e: l });
  // statement-level tokens only: drop [...] attribute lists, "name = value" pairs and ports
  const flat = [];
  let depth = 0;
  for (let i = 0; i < toks.length; i++) {
    const k = toks[i];
    if (k.t === '[') { depth++; continue; }
    if (k.t === ']') { depth = Math.max(0, depth - 1); continue; }
    if (depth) continue;
    if (k.type === 'id' && toks[i + 1]?.t === '=') { i += 2; continue; } // attr = value
    if (k.t === ':' && toks[i + 1]?.type === 'id') { i += 1; if (toks[i + 1]?.t === ':' && toks[i + 2]?.type === 'id') i += 2; continue; } // port (and compass)
    flat.push(k);
  }
  if (hint.kind === 'cluster') {
    for (let i = 0; i < flat.length - 1; i++) if (flat[i].t === 'subgraph' && flat[i + 1].t === hint.id) return one(flat[i].line);
    return null;
  }
  if (hint.kind === 'node') {
    // a declaration (id followed by [attrs] or at statement start) wins over a mention inside an edge
    const idxs = [];
    toks.forEach((k, i) => { if (k.type === 'id' && k.t === hint.id) idxs.push(i); });
    for (const i of idxs) {
      const prev = toks[i - 1]?.t;
      if (toks[i + 1]?.t === '[' && prev !== '=' && prev !== '->' && prev !== '--') return one(toks[i].line);
    }
    const f = flat.find((k) => k.type === 'id' && k.t === hint.id && !/^(graph|node|edge|subgraph|digraph|strict)$/i.test(k.t));
    return one(f ? f.line : null);
  }
  if (hint.kind === 'edge') {
    // operands of each arrow: the id before/after it, or every id of a { a b } group
    const group = (from, dir) => {
      const t = flat[from];
      if (!t) return [];
      if (t.type === 'id') return [t.t];
      if (t.t === (dir < 0 ? '}' : '{')) {
        const ids = [];
        for (let j = from, d = 0; j >= 0 && j < flat.length; j += dir) {
          const x = flat[j];
          if (x.t === '{') d += dir; else if (x.t === '}') d -= dir;
          else if (x.type === 'id') ids.push(x.t);
          if (d === 0 && j !== from) break;
        }
        return ids;
      }
      return [];
    };
    const hits = [];
    flat.forEach((k, i) => {
      if (k.type !== 'arrow') return;
      for (const a of group(i - 1, -1)) for (const b of group(i + 1, 1)) {
        if ((a === hint.from && b === hint.to) || (hint.undirected && a === hint.to && b === hint.from)) hits.push(k.line);
      }
    });
    return one(hits.length ? hits[Math.min(hint.n || 0, hits.length - 1)] : null);
  }
  return null;
}

// ---------- GitHub-style page chrome helpers ----------

/**
 * Build the file tree GitHub shows: directories first, then files, both alphabetical, and chains of
 * single-child directories collapsed into one row ("docs/guide").
 *   -> [{type: 'dir', name, path, children} | {type: 'file', name, path, file}]
 */
export function buildFileTree(files) {
  const root = { type: 'dir', name: '', path: '', children: [] };
  for (const f of files) {
    const parts = f.filename.split('/');
    let node = root;
    parts.slice(0, -1).forEach((name, i) => {
      const p = parts.slice(0, i + 1).join('/');
      let next = node.children.find((c) => c.type === 'dir' && c.name === name);
      if (!next) { next = { type: 'dir', name, path: p, children: [] }; node.children.push(next); }
      node = next;
    });
    node.children.push({ type: 'file', name: parts[parts.length - 1], path: f.filename, file: f });
  }
  const finish = (n) => {
    n.children.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
    for (const c of n.children) if (c.type === 'dir') finish(c);
    for (let i = 0; i < n.children.length; i++) {
      let c = n.children[i];
      while (c.type === 'dir' && c.children.length === 1 && c.children[0].type === 'dir') { // docs -> guide  =>  docs/guide
        const only = c.children[0];
        c = { type: 'dir', name: `${c.name}/${only.name}`, path: only.path, children: only.children };
      }
      n.children[i] = c;
    }
  };
  finish(root);
  return root.children;
}

/** GitHub's five-square diffstat: 'g' added, 'r' removed, 'n' neutral, e.g. "gggrn". */
export function statBlocks(additions, deletions) {
  const total = additions + deletions;
  if (!total) return 'nnnnn';
  let g = Math.round((5 * additions) / total);
  let r = Math.round((5 * deletions) / total);
  if (additions > 0 && g === 0) g = 1;
  if (deletions > 0 && r === 0) r = 1;
  while (g + r > 5) { if (g >= r) g--; else r--; }
  return 'g'.repeat(g) + 'r'.repeat(r) + 'n'.repeat(5 - g - r);
}

/** GitHub's anchor for a file in the "Files changed" page: #diff-<sha256 of the path>. */
export async function diffAnchor(path) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(path));
  return 'diff-' + [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Unified-diff patch -> display rows with both line numbers (the source-diff view).
 *   {type:'hunk', text} | {type:'ctx'|'add'|'del', old, new, text} | {type:'meta', text}
 */
export function parsePatchRows(patch) {
  const rows = [];
  if (!patch) return rows;
  let o = 0;
  let n = 0;
  for (const raw of String(patch).split('\n')) {
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (m) { o = Number(m[1]); n = Number(m[2]); rows.push({ type: 'hunk', text: raw, oldStart: o, newStart: n }); continue; }
    if (!rows.length) continue;
    const c = raw[0];
    if (c === '+') rows.push({ type: 'add', old: null, new: n++, text: raw.slice(1) });
    else if (c === '-') rows.push({ type: 'del', old: o++, new: null, text: raw.slice(1) });
    else if (c === '\\') rows.push({ type: 'meta', text: raw });
    else if (c === ' ' || raw === '') rows.push({ type: 'ctx', old: o++, new: n++, text: raw.slice(1) });
  }
  while (rows.length && rows[rows.length - 1].type === 'ctx' && rows[rows.length - 1].text === '' && !/\n$/.test(String(patch)) && false) rows.pop();
  return rows;
}

/**
 * Per hunk, the contiguous line ranges on each side: a multi-line review comment must stay inside one.
 *   -> [{left: {start, end} | null, right: {start, end} | null}]
 */
export function patchHunkRanges(rows) {
  const out = [];
  let cur = null;
  for (const r of rows) {
    if (r.type === 'hunk') { cur = { left: null, right: null }; out.push(cur); continue; }
    if (!cur || r.type === 'meta') continue;
    if (r.old != null) cur.left = cur.left ? { start: cur.left.start, end: r.old } : { start: r.old, end: r.old };
    if (r.new != null) cur.right = cur.right ? { start: cur.right.start, end: r.new } : { start: r.new, end: r.new };
  }
  return out;
}

/**
 * Where did the removed lines sit? Runs of consecutive removed lines, each with the new-file line
 * they follow (0 = before the first line), so a removed block can be drawn where it used to be.
 *   -> [{oldStart, oldEnd, afterNew}]
 */
export function patchDeletions(rows) {
  const out = [];
  let lastNew = 0;
  let run = null;
  for (const r of rows) {
    if (r.type === 'hunk') { lastNew = Math.max(0, (r.newStart || 1) - 1); run = null; continue; }
    if (r.type === 'del') {
      if (run) run.oldEnd = r.old;
      else { run = { oldStart: r.old, oldEnd: r.old, afterNew: lastNew }; out.push(run); }
      continue;
    }
    if (r.type === 'meta') continue;
    run = null;
    lastNew = r.new;
  }
  return out;
}

/** Old line number -> new line number for the unchanged (context) lines of a patch. */
export function oldToNewMap(rows) {
  const m = new Map();
  for (const r of rows) if (r.type === 'ctx') m.set(r.old, r.new);
  return m;
}

// ---------- synced margin: text position -> margin position ----------

/**
 * Margin offset for a text position d. pts = [{d, m}] sorted by d (text position of a thread's anchor, margin position of
 * its card): linear between neighbours, 1:1 before the first and after the last. Never decreases, so it can be inverted.
 */
export function mapPosition(pts, d) {
  if (!pts.length) return d;
  if (d <= pts[0].d) return pts[0].m + (d - pts[0].d);
  for (let i = 1; i < pts.length; i++) {
    if (d <= pts[i].d) {
      const a = pts[i - 1];
      const b = pts[i];
      return b.d === a.d ? b.m : a.m + ((d - a.d) * (b.m - a.m)) / (b.d - a.d);
    }
  }
  const z = pts[pts.length - 1];
  return z.m + (d - z.d);
}

/** How many margin pixels one pixel of text is worth at d (never 0, so the wheel can always move). */
export const positionSlope = (pts, d) => Math.max(0.05, mapPosition(pts, d + 1) - mapPosition(pts, d));
