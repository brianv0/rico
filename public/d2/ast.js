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
