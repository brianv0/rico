// A document that changes while you review it: line diffs that scale, "what changed since", and finding a comment's text again
// after the file was edited. Pure functions (no DOM, no network), shared by the page and the tests.

import { diffGroups } from './lib.js';

// ---------- line diff ----------

/** Myers' O(ND) diff over arrays of small integers. -> ops [{type: 'ctx' | 'del' | 'add', a, b}] or null when more than maxD edits are needed. */
function myers(a, b, maxD) {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, maxD);
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= n && y >= m) return backtrack(trace, n, m, off, d);
    }
  }
  return null;
}

function backtrack(trace, n, m, off, D) {
  let x = n;
  let y = m;
  const ops = [];
  for (let d = D; d > 0; d--) {
    const v = trace[d]; // the furthest-reaching points after round d - 1
    const k = x - y;
    const down = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]);
    const pk = down ? k + 1 : k - 1;
    const px = v[off + pk];
    const py = px - pk;
    const sx = down ? px : px + 1; // where this round's diagonal run starts
    const sy = down ? py + 1 : py;
    while (x > sx && y > sy) { x--; y--; ops.push({ type: 'ctx', a: x, b: y }); }
    if (down) ops.push({ type: 'add', a: -1, b: py }); else ops.push({ type: 'del', a: px, b: -1 });
    x = px;
    y = py;
  }
  while (x > 0 && y > 0) { x--; y--; ops.push({ type: 'ctx', a: x, b: y }); }
  return ops.reverse();
}

/**
 * Line diff of two arrays of strings, fast on the usual case (a few edits in a long document): the common head and tail are
 * trimmed, then Myers runs on the rest. Past `maxD` edits it gives up on matching and reports the middle as replaced.
 *   -> [{type: 'ctx' | 'del' | 'add', a: index in `a` (or -1), b: index in `b` (or -1)}]
 */
export function diffLines(a, b, maxD = 1500) {
  const ids = new Map();
  const id = (s) => { let i = ids.get(s); if (i === undefined) { i = ids.size; ids.set(s, i); } return i; };
  const x = a.map(id);
  const y = b.map(id);
  let head = 0;
  while (head < x.length && head < y.length && x[head] === y[head]) head++;
  let tail = 0;
  while (tail < x.length - head && tail < y.length - head && x[x.length - 1 - tail] === y[y.length - 1 - tail]) tail++;
  const ops = [];
  for (let i = 0; i < head; i++) ops.push({ type: 'ctx', a: i, b: i });
  const ma = x.slice(head, x.length - tail);
  const mb = y.slice(head, y.length - tail);
  let mid = ma.length && mb.length ? myers(Int32Array.from(ma), Int32Array.from(mb), maxD) : null;
  if (!mid) {
    mid = [];
    for (let i = 0; i < ma.length; i++) mid.push({ type: 'del', a: i, b: -1 });
    for (let j = 0; j < mb.length; j++) mid.push({ type: 'add', a: -1, b: j });
  }
  for (const o of mid) ops.push({ type: o.type, a: o.a < 0 ? -1 : o.a + head, b: o.b < 0 ? -1 : o.b + head });
  for (let i = 0; i < tail; i++) ops.push({ type: 'ctx', a: x.length - tail + i, b: y.length - tail + i });
  return ops;
}

/**
 * What changed in a document between two versions, in the numbers a page needs (all line numbers 1-based).
 *   added:  Set of new-file lines that are new or changed
 *   runs:   each stretch of change, in order: {oldFrom, oldTo (both 0 when nothing was removed), newFrom, newTo (0 when nothing was added),
 *           afterNew: how many new lines come before it, oldLines: the removed text}
 */
export function sinceChanges(oldLines, newLines) {
  const ops = diffLines(oldLines, newLines);
  const added = new Set();
  const runs = [];
  let run = null;
  let seenNew = 0;
  for (const o of ops) {
    if (o.type === 'ctx') { run = null; seenNew++; continue; }
    if (!run) { run = { oldFrom: 0, oldTo: 0, newFrom: 0, newTo: 0, afterNew: seenNew, oldLines: [] }; runs.push(run); }
    if (o.type === 'del') { if (!run.oldFrom) run.oldFrom = o.a + 1; run.oldTo = o.a + 1; run.oldLines.push(oldLines[o.a]); }
    else { added.add(o.b + 1); if (!run.newFrom) run.newFrom = o.b + 1; run.newTo = o.b + 1; seenNew++; }
  }
  return { added, runs };
}

// ---------- finding a comment's text again ----------

const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
// filler words say little about whether two paragraphs are the same one
const FILLER = new Set('a an the of to and or in on for is are was were be it its that this with as at by from but not if so then than into'.split(' '));
const wordsOf = (s) => (String(s).toLowerCase().match(/[\p{L}\p{N}_]+/gu) || []).filter((w) => !FILLER.has(w));

/** The text of `lines` as one whitespace-normalised string, with the line each character came from. */
function flatten(lines) {
  let text = '';
  const lineOf = [];
  lines.forEach((l, i) => {
    const t = norm(l);
    if (!t) return;
    if (text) { text += ' '; lineOf.push(i); }
    for (let c = 0; c < t.length; c++) lineOf.push(i);
    text += t;
  });
  return { text, lineOf };
}

function allIndexes(hay, needle) {
  const out = [];
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) out.push(i);
  return out;
}
const nearest = (list, hint, key) => (hint == null ? list[0] : list.reduce((best, x) => (Math.abs(key(x) - hint) < Math.abs(key(best) - hint) ? x : best)));

/**
 * Where is this text now? `orig` is the text a comment was made on (the lines at its original commit), `lines` the current file.
 *   opts.quote  the words the comment quoted, tried when the whole text is gone
 *   opts.hint   the comment's original first line, to choose between repeats
 * Tries, in order: the same lines (anywhere), the same words however the lines are wrapped, the quoted words, and a fuzzy match
 * on shared words that it only trusts when one place is clearly the best.
 *   -> {start, end, how: 'exact' | 'rewrapped' | 'quote' | 'fuzzy', score} (1-based lines) | null
 */
export function reanchor(orig, lines, opts = {}) {
  const need = (Array.isArray(orig) ? orig : String(orig || '').split('\n'));
  const want = need.map(norm);
  while (want.length && !want[want.length - 1]) want.pop();
  while (want.length && !want[0]) want.shift();
  if (!want.length || !lines.length) return null;
  const hint = opts.hint ?? null;

  // 1. the same lines, wherever they are now
  const k = want.length;
  const hits = [];
  for (let i = 0; i + k <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < k && ok; j++) ok = norm(lines[i + j]) === want[j];
    if (ok) hits.push(i);
  }
  if (hits.length) { const i = nearest(hits, hint == null ? null : hint - 1, (x) => x); return { start: i + 1, end: i + k, how: 'exact', score: 1 }; }

  // 2. the same words, wrapped differently or moved
  const flat = flatten(lines);
  const find = (needle, how) => {
    if (needle.length < 8) return null;
    const at = allIndexes(flat.text, needle);
    if (!at.length) return null;
    const i = nearest(at, hint == null ? null : hint - 1, (x) => flat.lineOf[x] ?? 0);
    return { start: flat.lineOf[i] + 1, end: flat.lineOf[i + needle.length - 1] + 1, how, score: 1 };
  };
  const whole = find(want.join(' '), 'rewrapped');
  if (whole) return whole;

  // 3. the words the comment quoted (head … tail when it was shortened)
  if (opts.quote) {
    const parts = norm(String(opts.quote).replace(/\n+/g, ' ')).split(/\s*…\s*/).filter(Boolean);
    if (parts.length) {
      const head = flat.text.indexOf(parts[0]);
      if (head >= 0 && parts[0].length >= 8) {
        let end = head + parts[0].length;
        if (parts.length > 1) { const tail = flat.text.indexOf(parts[parts.length - 1], end); if (tail >= 0) end = tail + parts[parts.length - 1].length; }
        return { start: flat.lineOf[head] + 1, end: flat.lineOf[end - 1] + 1, how: 'quote', score: 1 };
      }
    }
  }

  // 4. shared words: the paragraph that was reworded
  const needWords = wordsOf(want.join(' '));
  if (needWords.length < 4) return null;
  const count = (ws) => { const m = new Map(); for (const w of ws) m.set(w, (m.get(w) || 0) + 1); return m; };
  const needCount = count(needWords);
  const perLine = lines.map(wordsOf);
  const shares = perLine.map((ws) => ws.some((w) => needCount.has(w)));
  const scored = [];
  for (let i = 0; i < lines.length; i++) {
    if (!shares[i]) continue;
    for (const len of [k - 1, k, k + 1, k + 2]) {
      if (len < 1 || i + len > lines.length) continue;
      const ws = [];
      for (let j = i; j < i + len; j++) ws.push(...perLine[j]);
      if (!ws.length) continue;
      const have = count(ws);
      let common = 0;
      for (const [w, c] of needCount) common += Math.min(c, have.get(w) || 0);
      scored.push({ start: i, end: i + len - 1, score: (2 * common) / (needWords.length + ws.length) });
    }
  }
  scored.sort((x, y) => y.score - x.score || x.end - x.start - (y.end - y.start));
  const best = scored[0];
  if (!best || best.score < 0.55) return null;
  const rival = scored.find((s) => s.end < best.start || s.start > best.end); // the best place that is somewhere else
  if (rival && best.score < 0.9 && best.score - rival.score < 0.06) return null; // two places fit about equally well: do not guess
  let { start, end } = best;
  while (start < end && !shares[start]) start++;
  while (end > start && !shares[end]) end--;
  return { start: start + 1, end: end + 1, how: 'fuzzy', score: Math.round(best.score * 100) / 100 };
}

/**
 * Two versions of a passage as one run of text with the changes marked: [{t: 'same' | 'del' | 'ins', text}], and how many
 * words they share (0 means it was rewritten, so a word-by-word view would only be noise).
 */
export function inlineDiff(a, b) {
  const { groups, same } = diffGroups(a, b, 2);
  const parts = [];
  const push = (t, text) => { if (text) parts.push({ t, text }); };
  let at = 0;
  for (const g of groups) {
    const stop = g.ins ? g.ins[0] : g.at;
    push('same', b.slice(at, stop));
    if (g.del) push('del', a.slice(g.del[0], g.del[1]));
    if (g.ins) { push('ins', b.slice(g.ins[0], g.ins[1])); at = g.ins[1]; } else at = stop;
  }
  push('same', b.slice(at));
  return { parts, same };
}

const dice = (x, y) => {
  if (!x.length || !y.length) return 0;
  const have = new Map();
  for (const w of y) have.set(w, (have.get(w) || 0) + 1);
  let common = 0;
  for (const w of x) { const c = have.get(w) || 0; if (c) { common++; have.set(w, c - 1); } }
  return (2 * common) / (x.length + y.length);
};

/** How alike two passages are, 0 to 1: the share of their words (filler aside) that they have in common. */
export function similarity(a, b) {
  const x = wordsOf(a);
  const y = wordsOf(b);
  return x.length && y.length ? dice(x, y) : norm(a) === norm(b) ? 1 : 0;
}

/**
 * Pair the old blocks of a changed document with the new ones that replaced them, by what they say (not by where they sit: a
 * line diff can split one rewritten paragraph into a removal here and an addition there).
 *   -> [[oldIndex, newIndex, similarity]], best matches first; blocks left out of it have no counterpart
 */
export function pairBlocks(olds, news, min = 0.35) {
  const ow = olds.map(wordsOf);
  const nw = news.map(wordsOf);
  const on = olds.map(norm);
  const nn = news.map(norm);
  const cand = [];
  for (let i = 0; i < olds.length; i++) for (let j = 0; j < news.length; j++) {
    const sim = on[i] === nn[j] ? 1 : dice(ow[i], nw[j]);
    if (sim >= min) cand.push([i, j, sim]);
  }
  cand.sort((p, q) => q[2] - p[2] || p[0] - q[0] || p[1] - q[1]);
  const usedO = new Set();
  const usedN = new Set();
  const out = [];
  for (const [i, j, sim] of cand) if (!usedO.has(i) && !usedN.has(j)) { usedO.add(i); usedN.add(j); out.push([i, j, sim]); }
  return out;
}
