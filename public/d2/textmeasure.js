// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// The part of D2's lib/textmeasure that d2ir calls (oss.terrastruct.com/d2 v0.7.2, Copyright 2022 Terrastruct Inc.):
// ReplaceSubstitutionsMarkdown. Go finds the text nodes with goldmark; there is no markdown parser in this port
// yet, so the code spans, fenced code blocks and indented code blocks that goldmark skips are found with a small
// line scanner. Everything else is treated as text.

// Go's strings.ReplaceAll(s, "${k}", v) for each variable, in map order (insertion order here).
function replaceVariables(s, vars) {
  for (const [k, v] of vars) s = s.split('${' + k + '}').join(v);
  return s;
}

const HTML_BLOCK_TAGS = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
const RE_HTML_START = [
  [/^ {0,3}<(script|pre|style|textarea)(\s|>|$)/i, /<\/(script|pre|style|textarea)>/i],
  [/^ {0,3}<!--/, /-->/],
  [/^ {0,3}<\?/, /\?>/],
  [/^ {0,3}<![A-Za-z]/, />/],
  [/^ {0,3}<!\[CDATA\[/, /\]\]>/],
  [new RegExp('^ {0,3}</?(' + HTML_BLOCK_TAGS + ')(\\s|/?>|$)', 'i'), null],
];
const RE_HTML_7 = /^ {0,3}(<[A-Za-z][A-Za-z0-9-]*(\s+[A-Za-z_:][A-Za-z0-9_.:-]*(\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>|<\/[A-Za-z][A-Za-z0-9-]*\s*>)\s*$/;
const RE_LIST = /^( {0,3})([-+*]|\d{1,9}[.)])( +|$)/;

/**
 * Spans [start, end) of mdText that goldmark does not make Text nodes of: code blocks, code spans, HTML, link
 * destinations. A line scanner for the block structure (fences, indented code, HTML blocks, list indentation) and
 * regular expressions for the inline parts; blockquotes and reference definitions are not modelled.
 */
function codeSpans(md) {
  const spans = [];
  const lines = md.split('\n');
  let off = 0, fence = null, fenceFrom = 0, html = null, inPara = false;
  const listIndents = []; // content indent of the open list items
  for (const rawLine of lines) {
    const end = off + rawLine.length;
    // leading tabs count as columns up to the next multiple of 4
    const line = rawLine.replace(/^[ \t]+/, (w) => { let col = 0; for (const ch of w) col = ch === '\t' ? (col + 4) & ~3 : col + 1; return ' '.repeat(col); });
    const blank = line.trim() === '';
    const indent = /^ */.exec(line)[0].length;
    const span = () => spans.push([off, end + 1]);
    if (fence) {
      span();
      const c = new RegExp('^ {0,3}' + (fence[0] === '`' ? '`' : '~') + '{' + fence.length + ',}\\s*$');
      if (c.test(line.slice(Math.min(fenceFrom, indent)))) { fence = null; inPara = false; }
      off = end + 1;
      continue;
    }
    if (html) {
      span();
      if (html.end ? html.end.test(line) : blank) html = null;
      off = end + 1;
      inPara = false;
      continue;
    }
    if (blank) { inPara = false; off = end + 1; continue; }
    while (listIndents.length && indent < listIndents[listIndents.length - 1] && !inPara) listIndents.pop();
    const base = listIndents.length ? listIndents[listIndents.length - 1] : 0;
    const from = base > 0 ? Math.min(base, indent) : 0;
    const sub = line.slice(from);
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(sub);
    const lm = RE_LIST.exec(sub);
    if (m && !(m[1][0] === '`' && sub.slice(m[0].length).includes('`'))) {
      fence = m[1];
      fenceFrom = from;
      span();
      inPara = false;
    } else if (indent - base >= 4 && !inPara) {
      span();
    } else if (!lm && RE_HTML_START.some(([st, en], k) => { if (!st.test(line.slice(base))) return false; html = { end: en }; if (en && en.test(line.slice(line.search(st) + 1))) html = null; return true; })) {
      span();
      if (html === null) inPara = false;
    } else if (!lm && !inPara && RE_HTML_7.test(line.slice(base))) {
      html = { end: null };
      span();
    } else {
      if (lm) {
        while (listIndents.length && from + lm[1].length < listIndents[listIndents.length - 1]) listIndents.pop(); // a sibling item
        listIndents.push(from + lm[1].length + lm[2].length + (lm[3].length > 4 || lm[3] === '' ? 1 : lm[3].length));
        inPara = true;
      } else inPara = true;
    }
    off = end + 1;
  }
  const inSpan = (i) => spans.some(([a, b]) => i >= a && i < b);
  // inline code spans: a backtick run closed by a run of the same length
  let i = 0;
  while (i < md.length) {
    if (inSpan(i)) { i++; continue; }
    if (md[i] === '\\') { i += 2; continue; }
    if (md[i] !== '`') { i++; continue; }
    let j = i;
    while (md[j] === '`') j++;
    const run = j - i;
    let k = j, found = -1;
    while (k < md.length) {
      if (md[k] !== '`') { k++; continue; }
      let e = k;
      while (md[e] === '`') e++;
      if (e - k === run) { found = e; break; }
      k = e;
    }
    if (found < 0) { i = j; continue; }
    spans.push([i, found]);
    i = found;
  }
  // autolinks, inline HTML, and link destinations
  const inline = [/<[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*>/g, /<[^\s<>@]+@[^\s<>]+>/g, /<\/?[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>/g, /<!--[\s\S]*?-->/g, /(?<=\]\()[^)\s]*/g];
  for (const re of inline) for (const mm of md.matchAll(re)) if (!inSpan(mm.index)) spans.push([mm.index, mm.index + mm[0].length]);
  return spans;
}

/** Go's textmeasure.ReplaceSubstitutionsMarkdown(mdText, variables); variables is a Map of name to value. */
export function replaceSubstitutionsMarkdown(mdText, variables) {
  if (variables.size === 0 || !mdText.includes('${')) return mdText;
  const spans = codeSpans(mdText);
  let out = '', pos = 0;
  const flush = (a, b) => { out += replaceVariables(mdText.slice(a, b), variables); };
  for (const [a, b] of spans.sort((x, y) => x[0] - y[0])) {
    if (a < pos) continue;
    flush(pos, a);
    out += mdText.slice(a, Math.min(b, mdText.length));
    pos = Math.min(b, mdText.length);
  }
  flush(pos, mdText.length);
  return out;
}
