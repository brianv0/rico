// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of D2's d2ast package (oss.terrastruct.com/d2 v0.7.2, Copyright 2022 Terrastruct Inc.).
//
// Nodes keep Go's JSON shape exactly: properties are the Go JSON field names, and "boxes" are objects
// with one non-null member (`{ map_key: Key }`, `{ unquoted_string: UnquotedString }`, ...). So
// JSON.stringify(ast) matches what the Go/WASM build returns, and Go code ports line for line.

/** Position: zero-based line and column, plus a byte offset (UTF-8 bytes, or UTF-16 units in utf16 mode). */
export const pos = (line = 0, column = 0, byte = 0) => ({ line, column, byte });

const width = (ch, utf16) => {
  if (utf16) return ch.length;
  const c = ch.codePointAt(0);
  return c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
};
export function advance(p, ch, utf16) {
  const n = width(ch, utf16);
  return ch === '\n' ? { line: p.line + 1, column: 0, byte: p.byte + n } : { line: p.line, column: p.column + n, byte: p.byte + n };
}
export function subtract(p, ch, utf16) {
  if (ch === '\n') throw new Error('d2ast: cannot subtract newline from Position');
  const n = width(ch, utf16);
  return { line: p.line, column: p.column - n, byte: p.byte - n };
}
export const advanceString = (p, s, utf16) => { for (const ch of s) p = advance(p, ch, utf16); return p; };
export const subtractString = (p, s, utf16) => { for (const ch of s) p = subtract(p, ch, utf16); return p; };
export const posEq = (a, b) => a.line === b.line && a.column === b.column && a.byte === b.byte;
export const posBefore = (a, b) => (a.byte !== b.byte && a.byte !== -1 && b.byte !== -1 ? a.byte < b.byte : a.line !== b.line ? a.line < b.line : a.column < b.column);
const posText = (p) => `${p.line}:${p.column}:${p.byte}`;

export class Range {
  constructor(path = '', start = pos(), end = pos()) { this.path = path; this.start = start; this.end = end; }
  /** "path:line:col" (1-based), as used at the start of error messages. */
  toString() { return (this.path ? this.path + ':' : '') + `${this.start.line + 1}:${this.start.column + 1}`; }
  /** Go's compact text encoding: "path,l:c:b-l:c:b". */
  toJSON() { return `${this.path},${posText(this.start)}-${posText(this.end)}`; }
  static parse(s) {
    const i = s.lastIndexOf('-'), j = s.lastIndexOf(',', i);
    const p = (t) => { const [l, c, b] = t.split(':').map(Number); return pos(l, c, b); };
    return new Range(s.slice(0, j), p(s.slice(j + 1, i)), p(s.slice(i + 1)));
  }
}

export class AstError extends Error {
  constructor(range, message) { super(message); this.range = range; }
  toJSON() { return { range: this.range, errmsg: this.message }; }
}

// Box member names in Go's Unbox() order.
const MAP_NODE = ['comment', 'block_comment', 'substitution', 'import', 'map_key'];
const ARRAY_NODE = ['comment', 'block_comment', 'substitution', 'import', 'null', 'boolean', 'number', 'unquoted_string', 'double_quoted_string', 'single_quoted_string', 'block_string', 'array', 'map'];
const VALUE = ['null', 'suspension', 'boolean', 'number', 'unquoted_string', 'double_quoted_string', 'single_quoted_string', 'block_string', 'array', 'map', 'import'];
const SCALAR = VALUE.slice(0, 8);
const STRING = SCALAR.slice(4);
const KINDS = [...new Set([...ARRAY_NODE, ...VALUE, 'map_key'])];

/** The kind of a box: the name of its set member ('map_key', 'unquoted_string', ...), or null if empty. */
export function boxKind(box) {
  if (!box) return null;
  for (const k of KINDS) if (box[k]) return k;
  return null;
}
/** Go's Unbox(): the node inside a box (or null). */
export const unbox = (box) => { const k = boxKind(box); return k ? box[k] : null; };
const pick = (box, keys) => { const o = {}; if (box) for (const k of keys) if (box[k]) o[k] = box[k]; return o; };
export const scalarBox = (vb) => pick(vb, SCALAR);
export const stringBox = (vb) => pick(vb, STRING);
export const isMapNodeKind = (k) => MAP_NODE.includes(k);

/** Box a node by kind, e.g. box('map', m) -> { map: m }. */
export const box = (kind, n) => (n ? { [kind]: n } : {});

const TYPE = {
  comment: 'comment', block_comment: 'block comment', null: 'null', suspension: 'suspension', boolean: 'boolean',
  number: 'number', unquoted_string: 'unquoted string', double_quoted_string: 'double quoted string',
  single_quoted_string: 'single quoted string', substitution: 'substitution', import: 'import', array: 'array',
  map: 'map', map_key: 'map key',
};
/** Go's Type() for the node in a box: the user-facing name. */
export function boxType(b) {
  const k = boxKind(b);
  return k === 'block_string' ? b[k].tag + ' block string' : TYPE[k];
}

/** Go's ScalarString() for the node in a scalar/string box. */
export function scalarString(b) {
  const k = boxKind(b), n = k && b[k];
  switch (k) {
    case 'null': case 'suspension': return '';
    case 'boolean': return String(n.value);
    case 'number': return n.raw;
    case 'unquoted_string': case 'double_quoted_string': return n.value?.[0]?.string ?? '';
    case 'single_quoted_string': case 'block_string': return n.value;
    default: return '';
  }
}

// Go's unicode.IsSpace.
const SPACES = new Set([9, 10, 11, 12, 13, 32, 0x85, 0xA0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000]);
export const isSpace = (ch) => ch.length === 1 && SPACES.has(ch.charCodeAt(0));
export const trimRightSpace = (s) => { let i = s.length; while (i > 0 && isSpace(s[i - 1])) i--; return s.slice(0, i); };

/** Byte length of s in UTF-8 (Go's len(string)). */
export function utf8Len(s) {
  let n = 0;
  for (const ch of s) n += width(ch, false);
  return n;
}

// ---- helpers d2ir and d2format need (ported from d2ast) ----

/** Go's d2ast.MakeRange: parse the compact "path,l:c:b-l:c:b" text. */
export const makeRange = (s) => Range.parse(s);
/** Go's `r == d2ast.Range{}`. */
export const rangeIsZero = (r) => r.path === '' && posEq(r.start, pos()) && posEq(r.end, pos());
/** Go's Range.OneLine: starts and ends on the same line. */
export const rangeOneLine = (r) => r.start.line === r.end.line;
/** Go's Map.IsFileMap. */
export const isFileMap = (m) => m.range.start.line === 0 && m.range.start.column === 0;

const set = (...a) => new Set(a);
export const SimpleReservedKeywords = set('label', 'shape', 'icon', 'constraint', 'tooltip', 'link', 'near', 'width', 'height', 'direction', 'top', 'left', 'grid-rows', 'grid-columns', 'grid-gap', 'vertical-gap', 'horizontal-gap', 'class', 'vars');
export const ReservedKeywordHolders = set('style');
export const BoardKeywords = set('layers', 'scenarios', 'steps');
export const CompositeReservedKeywords = set('source-arrowhead', 'target-arrowhead', 'classes', 'constraint', 'label', 'icon', 'tooltip', 'style', 'layers', 'scenarios', 'steps');
export const StyleKeywords = set('opacity', 'stroke', 'fill', 'fill-pattern', 'stroke-width', 'stroke-dash', 'border-radius', 'font', 'font-size', 'font-color', 'bold', 'italic', 'underline', 'text-transform', 'shadow', 'multiple', 'double-border', '3d', 'animated', 'filled');
export const ReservedKeywords = new Set([...SimpleReservedKeywords, ...StyleKeywords, ...ReservedKeywordHolders, ...CompositeReservedKeywords]);

// Go's strings.ToLower maps per code point (U+0130 lowers to plain "i"); JS's toLowerCase uses full mappings and context.
export const goLower = (s) => { let o = ''; for (const c of s) { const l = c.toLowerCase(); o += c === '\u0130' ? 'i' : Array.from(l).length === 1 ? l : c; } return o; };
// A canonical member of c's simple-folding orbit. U+0130 and U+0131 have no orbit in Go (the Turkish i's).
const foldCp = (c) => {
  if (c === '\u0130' || c === '\u0131') return c;
  const u = c.toUpperCase();
  if (Array.from(u).length !== 1) return c;
  const l = u.toLowerCase();
  return Array.from(l).length === 1 ? l : u;
};
/** Go's strings.EqualFold (simple case folding). */
export function equalFold(a, b) {
  const x = Array.from(a), y = Array.from(b);
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i] && foldCp(x[i]) !== foldCp(y[i])) return false;
  return true;
}

// Go's unicode.IsSpace on the first and last code point of s.
const hasSurroundingWhitespace = (s) => { const a = Array.from(s); return isSpace(a[0]) || isSpace(a[a.length - 1]); };

export const UnquotedKeySpecials = '#;\n\\{}[]\'"|:.-<>*&()@&';
export const UnquotedValueSpecials = '#;\n\\{}[]\'"|$@';

/** Go's FlatUnquotedString / FlatDoubleQuotedString: a node with one plain string and a zero range. */
export const flatUnquotedString = (s) => ({ range: new Range(), value: [{ string: s }] });
export const flatDoubleQuotedString = (s) => ({ range: new Range(), value: [{ string: s }] });

/** Go's RawString, returning a string box: s in the most aesthetically pleasing AST string. */
export function rawString(s, inKey) {
  const dq = () => ({ double_quoted_string: flatDoubleQuotedString(s) });
  if (s === '') return dq();
  if (inKey) {
    for (let i = 0; i < s.length; i++) {
      const r = s[i];
      if (r === '-' && i + 1 < s.length && s[i + 1] !== '-') continue;
      if (UnquotedKeySpecials.includes(r)) {
        if (!s.includes('"')) return dq();
        if (s.includes('\n')) return dq();
        return { single_quoted_string: { range: new Range(), raw: '', value: s } };
      }
    }
  } else if (s === 'null' || s === 'suspend' || s === 'unsuspend' || [...UnquotedValueSpecials].some((c) => s.includes(c))) {
    if (!s.includes('"') && !s.includes('$')) return dq();
    if (s.includes('\n')) return dq();
    return { single_quoted_string: { range: new Range(), raw: '', value: s } };
  }
  if (hasSurroundingWhitespace(s)) return dq();
  return { unquoted_string: flatUnquotedString(s) };
}

/** Go's MakeKeyPathString: a KeyPath over the given string boxes (re-rendered with RawString). */
export const makeKeyPathString = (a) => ({ range: new Range(), path: a && a.length ? a.map((el) => rawString(scalarString(el), true)) : null });
/** Go's KeyPath.IDA. */
export const keyPathIDA = (kp) => { const ida = []; for (const el of kp.path || []) ida.push(el); return ida.length ? ida : null; };

// Go's `kp *KeyPath` methods are nil-safe.
const isGlob = (el) => el.unquoted_string && el.unquoted_string.pattern?.length > 0;
export const isDoubleGlob = (p) => p.length === 3 && p[0] === '*' && p[1] === '' && p[2] === '*';
export const isTripleGlob = (p) => p.length === 5 && p[0] === '*' && p[1] === '' && p[2] === '*' && p[3] === '' && p[4] === '*';
export const keyPathHasGlob = (kp) => !!kp && (kp.path || []).some(isGlob);
export const keyPathFirstGlob = (kp) => (kp ? (kp.path || []).findIndex(isGlob) : -1);
export const keyPathHasTripleGlob = (kp) => !!kp && (kp.path || []).some((el) => el.unquoted_string && isTripleGlob(el.unquoted_string.pattern || []));
export const keyPathHasMultiGlob = (kp) => !!kp && (kp.path || []).some((el) => el.unquoted_string && (isDoubleGlob(el.unquoted_string.pattern || []) || isTripleGlob(el.unquoted_string.pattern || [])));
export const keyPathLast = (kp) => kp.path[kp.path.length - 1];
export const keyPathEquals = (a, b) => a.path.length === b.path.length && a.path.every((id, i) => scalarString(id) === scalarString(b.path[i]));

export const keyHasGlob = (mk) => keyPathHasGlob(mk.key) || (mk.edges || []).some((e) => keyPathHasGlob(e.src) || keyPathHasGlob(e.dst)) || !!(mk.edge_index && mk.edge_index.glob) || keyPathHasGlob(mk.edge_key);
export const keyHasTripleGlob = (mk) => keyPathHasTripleGlob(mk.key) || (mk.edges || []).some((e) => keyPathHasTripleGlob(e.src) || keyPathHasTripleGlob(e.dst)) || keyPathHasTripleGlob(mk.edge_key);
export const keyHasMultiGlob = (mk) => keyPathHasMultiGlob(mk.key) || (mk.edges || []).some((e) => keyPathHasMultiGlob(e.src) || keyPathHasMultiGlob(e.dst)) || keyPathHasMultiGlob(mk.edge_key);
export const keySupportsGlobFilters = (mk) => (keyPathHasGlob(mk.key) && !(mk.edges || []).length) || !!(mk.edge_index && mk.edge_index.glob && !mk.edge_key) || keyPathHasGlob(mk.edge_key);
export const mapHasFilter = (m) => (m.nodes || []).some((n) => n.map_key && (n.map_key.ampersand || n.map_key.not_ampersand));
export const keyCopy = (mk) => ({ ...mk });

const edgeEquals = (a, b) => keyPathEquals(a.src, b.src) && a.src_arrow === b.src_arrow && keyPathEquals(a.dst, b.dst) && a.dst_arrow === b.dst_arrow;
// Go compares the *int pointers of the two indexes; two distinct non-nil indexes never match.
const edgeIndexEquals = (a, b) => (a.int === null || a.int === undefined ? !(b.int !== null && b.int !== undefined) : a === b) && a.glob === b.glob;
/** Go's Key.Equals. */
export function keyEquals(mk1, mk2) {
  if (!mk1 && !mk2) return true;
  if (!mk1 || !mk2) return false;
  if (!!mk1.ampersand !== !!mk2.ampersand) return false;
  if (!!mk1.not_ampersand !== !!mk2.not_ampersand) return false;
  if (!mk1.key !== !mk2.key) return false;
  if (!mk1.edge_index !== !mk2.edge_index) return false;
  if (mk1.edge_index && !edgeIndexEquals(mk1.edge_index, mk2.edge_index)) return false;
  if (!mk1.edge_key !== !mk2.edge_key) return false;
  const e1 = mk1.edges || [], e2 = mk2.edges || [];
  if (e1.length !== e2.length) return false;
  for (let i = 0; i < e1.length; i++) if (!edgeEquals(e1[i], e2[i])) return false;
  if (!mk1.value.map !== !mk2.value.map) {
    if (mk1.value.map && mk1.value.map.nodes?.length > 0) return false;
    if (mk2.value.map && mk2.value.map.nodes?.length > 0) return false;
  } else if (!unbox(mk1.value) !== !unbox(mk2.value)) return false;
  if (mk1.key) {
    if (mk1.key.path.length !== mk2.key.path.length) return false;
    if (!keyPathEquals(mk1.key, mk2.key)) return false;
  }
  if (mk1.edge_key) {
    if (mk1.edge_key.path.length !== mk2.edge_key.path.length) return false;
    if (!keyPathEquals(mk1.edge_key, mk2.edge_key)) return false;
  }
  if (mk1.value.map && mk1.value.map.nodes?.length > 0) {
    const n1 = mk1.value.map.nodes, n2 = mk2.value.map.nodes || [];
    if (n1.length !== n2.length) return false;
    for (let i = 0; i < n1.length; i++) if (!keyEquals(n1[i].map_key, n2[i].map_key)) return false;
  }
  if (unbox(mk1.value)) {
    if (!unbox(scalarBox(mk1.value)) !== !unbox(scalarBox(mk2.value))) return false;
    if (unbox(scalarBox(mk1.value)) && scalarString(scalarBox(mk1.value)) !== scalarString(scalarBox(mk2.value))) return false;
  }
  if (unbox(mk1.primary)) {
    if (!unbox(mk2.primary)) return false;
    if (scalarString(mk1.primary) !== scalarString(mk2.primary)) return false;
  }
  return true;
}

// Go's path.Join / path.Clean / path.Dir / path.Ext (slash paths).
export function pathClean(p) {
  if (p === '') return '.';
  const rooted = p[0] === '/';
  const out = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop();
      else if (!rooted) out.push('..');
    } else out.push(seg);
  }
  const s = (rooted ? '/' : '') + out.join('/');
  return s === '' ? '.' : s;
}
export const pathJoin = (...a) => { const e = a.filter((x) => x !== ''); return e.length ? pathClean(e.join('/')) : ''; };
export function pathDir(p) { const i = p.lastIndexOf('/'); return pathClean(p.slice(0, i + 1)); }
export function pathExt(p) { for (let i = p.length - 1; i >= 0 && p[i] !== '/'; i--) if (p[i] === '.') return p.slice(i); return ''; }

/** Go's Substitution.IDA (strings). */
export const substitutionIDA = (s) => (s.path || []).map((el) => scalarString(el));
/** Go's Import.IDA (string boxes after the first path element). */
export const importIDA = (i) => { const ida = i.path.slice(1); return ida.length ? ida : null; };
/** Go's Import.PathWithPre. */
export const importPathWithPre = (i) => (!i.path || i.path.length === 0 ? '' : pathJoin(i.pre, scalarString(i.path[0])));
export const importDir = (i) => pathDir(importPathWithPre(i));

/** Go's UnquotedString/DoubleQuotedString Coalesce. */
export function coalesce(s) {
  let b = '';
  for (const box of s.value || []) { if (box.string === undefined || box.string === null) break; b += box.string; }
  s.value = [{ string: b }];
}

/** Go's StringBox.IsUnquoted etc. for a string box. */
export const isUnquoted = (sb) => !!sb.unquoted_string;
