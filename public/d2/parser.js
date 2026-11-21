// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of D2's d2parser package (oss.terrastruct.com/d2 v0.7.2, Copyright 2022 Terrastruct Inc.).
// Same algorithm, same error messages, same AST (see ast.js). Go's streaming reader with its
// peek/commit/rewind buffers is modelled over an array of code points with an index.

import {
  Range, AstError, pos, advance, subtract, advanceString, subtractString, posEq,
  boxKind, unbox, boxType, scalarBox, scalarString, isSpace, trimRightSpace, utf8Len,
} from './ast.js';

const isDigit = (ch) => /^\p{Nd}$/u.test(ch);
const isLetter = (ch) => /^\p{L}$/u.test(ch);
// Go's strings.EqualFold against an ASCII word (ſ and the Kelvin sign fold to s and k).
const foldEq = (s, word) => s.length <= word.length * 3 && s.replace(/ſ/g, 's').replace(/K/g, 'k').toLowerCase() === word;

export class ParseError {
  constructor() { this.errs = []; }
  empty() { return this.errs.length === 0; }
  get message() { return this.errs.map((e) => e.message).join('\n'); }
  toString() { return this.message; }
  toJSON() { return { errs: this.errs }; }
}

/**
 * Parse D2 source. Like Go, the returned map is always usable; errors are collected, not thrown.
 * utf16: count columns/bytes in UTF-16 code units (what the WASM build does for JS callers).
 * parseError: an existing ParseError to append to (d2ir uses one for the whole compile); the returned err is then
 * non-null if it holds any error, including earlier ones, as in Go.
 * @returns {{ ast: object, err: ParseError|null }}
 */
export function parse(path, text, { utf16 = false, parseError = null } = {}) {
  const p = new Parser(path, text, utf16);
  if (parseError) p.err = parseError; // Go's ParseOptions.ParseError: collect into the caller's errors
  const ast = p.parseMap(true);
  return { ast, err: p.err.empty() ? null : p.err };
}

function only(fn, what, text) {
  const p = new Parser('', text, false);
  const v = fn(p);
  if (!p.err.empty()) throw new Error(`failed to parse ${what} ${JSON.stringify(text)}: ${p.err.message}`);
  if (!v) throw new Error(`empty ${what}: ${JSON.stringify(text)}`);
  return v;
}
export const parseKey = (key) => only((p) => p.parseKey(), 'key', key);
export const parseMapKey = (mk) => only((p) => p.parseMapKey(), 'map key', mk);
export const parseValue = (v) => only((p) => unbox(p.parseValue()), 'value', v);

class Parser {
  constructor(path, text, utf16) {
    this.path = path;
    this.u16 = utf16;
    this.cs = Array.from(text); // code points
    this.i = 0; // index of the next unconsumed code point
    this.la = 0; // number of peeked (lookahead) code points after i
    this.pos = pos();
    this.laPos = pos();
    this.readerPos = pos();
    this.fetched = 0; // code points ever pulled from the "reader": Go's readerPos only moves on fresh reads
    this.ioerr = false;
    this.err = new ParseError();
    this.inEdgeGroup = false;
    this.depth = 0;
  }

  errorf(start, end, msg) {
    const r = new Range(this.path, start, end);
    this.err.errs.push(new AstError(r, `${r}: ${msg}`));
  }
  range(start) { return new Range(this.path, start, start); }

  // Go's _readRune: the code point at index j, tracking readerPos and EOF the way the buffered reader does.
  fetch(j) {
    if (j < this.cs.length) {
      if (j >= this.fetched) { this.readerPos = this.laPos; this.fetched = j + 1; }
      return this.cs[j];
    }
    if (!this.ioerr) { this.readerPos = this.laPos; this.ioerr = true; }
    this.rewind();
    return null;
  }
  read() {
    const r = this.fetch(this.i);
    if (r === null) return null;
    this.i++;
    this.pos = this.laPos = advance(this.pos, r, this.u16);
    return r;
  }
  replay(r) {
    this.pos = subtract(this.pos, r, this.u16);
    this.i--;
    this.la = 0;
    this.laPos = this.pos;
  }
  peek() {
    const r = this.fetch(this.i + this.la);
    if (r === null) return null;
    this.la++;
    this.laPos = advance(this.laPos, r, this.u16);
    return r;
  }
  peekn(n) {
    let s = '';
    for (let k = 0; k < n; k++) {
      const r = this.peek();
      if (r === null) return [s, true];
      s += r;
    }
    return [s, false];
  }
  readNotSpace() {
    for (;;) {
      const r = this.read();
      if (r === null || !isSpace(r)) return r;
    }
  }
  /** Next non-space code point without consuming; newlines = how many '\n' were skipped. r is null at EOF. */
  peekNotSpace() {
    let newlines = 0;
    for (;;) {
      const r = this.peek();
      if (r === null) return [null, 0];
      if (isSpace(r)) { if (r === '\n') newlines++; continue; }
      return [r, newlines];
    }
  }
  commit() { this.i += this.la; this.la = 0; this.pos = this.laPos; }
  rewind() {
    if (this.la === 0) return;
    this.la = 0;
    this.laPos = this.pos;
  }

  parseMap(isFileMap) {
    const m = { range: this.range(this.pos), nodes: null };
    if (!isFileMap) {
      m.range.start = subtract(m.range.start, '{', this.u16);
      this.depth++;
    }
    try {
      for (;;) {
        const r = this.readNotSpace();
        if (r === null) {
          if (!isFileMap) this.errorf(m.range.start, this.readerPos, 'maps must be terminated with }');
          return m;
        }
        if (r === ';') continue;
        if (r === '}') {
          if (isFileMap) {
            this.errorf(subtract(this.pos, r, this.u16), this.pos, 'unexpected map termination character } in file map');
            continue;
          }
          return m;
        }

        const n = this.parseMapNode(r);
        if (unbox(n)) (m.nodes ||= []).push(n);
        if (n.block_comment) continue; // anything after a block comment is ok

        const after = this.pos;
        for (;;) {
          const [r2, newlines] = this.peekNotSpace();
          if (r2 === null || newlines !== 0 || r2 === ';' || r2 === '}' || r2 === '#') { this.rewind(); break; }
          this.commit();
        }
        if (!posEq(after, this.pos)) {
          if (unbox(n)) {
            if (n.map_key && unbox(n.map_key.value)) {
              const ps = n.map_key.value.block_string ? '. See https://d2lang.com/tour/text#advanced-block-strings.' : '';
              this.errorf(after, this.pos, `unexpected text after ${boxType(n.map_key.value)}${ps}`);
            } else {
              this.errorf(after, this.pos, `unexpected text after ${boxType(n)}`);
            }
          } else {
            this.errorf(after, this.pos, 'invalid text beginning unquoted key');
          }
        }
      }
    } finally {
      m.range.end = this.pos;
      if (!isFileMap) this.depth--;
    }
  }

  // Shared by parseMapNode and parseArrayNode: comments, block comments, ...$spreads and ...@imports.
  parseSpecialNode(r) {
    if (r === '#') return { comment: this.parseComment() };
    if (r === '"') {
      const [s, eof] = this.peekn(2);
      if (!eof) {
        if (s === '""') { this.commit(); return { block_comment: this.parseBlockComment() }; }
        this.rewind();
      }
    } else if (r === '.') {
      const [s, eof] = this.peekn(2);
      if (!eof) {
        if (s !== '..') this.rewind();
        else {
          const r2 = this.peek();
          if (r2 !== null) {
            if (r2 === '$') { this.commit(); return { substitution: this.parseSubstitution(true) }; }
            if (r2 === '@') { this.commit(); return { import: this.parseImport(true) }; }
            this.rewind();
          }
        }
      }
    }
    return null;
  }

  parseMapNode(r) {
    const special = this.parseSpecialNode(r);
    if (special) return special;
    this.replay(r);
    const mk = this.parseMapKey();
    return mk ? { map_key: mk } : {};
  }

  parseComment() {
    const c = { range: this.range(subtract(this.pos, '#', this.u16)), value: '' };
    const sb = [];
    this.parseCommentLine(sb);
    for (;;) {
      const [r, newlines] = this.peekNotSpace();
      if (r === null) break;
      if (r !== '#' || newlines >= 2) { this.rewind(); break; }
      this.commit();
      if (newlines === 1) sb.push('\n');
      this.parseCommentLine(sb);
    }
    c.value = sb.join('');
    c.range.end = this.pos;
    return c;
  }

  parseCommentLine(sb) {
    let first = true;
    for (;;) {
      const r = this.peek();
      if (r === null) return;
      if (r === '\n') { this.rewind(); return; }
      this.commit();
      if (first) { first = false; if (r === ' ') continue; }
      sb.push(r);
    }
  }

  parseBlockComment() {
    const bc = { range: this.range(subtractString(this.pos, '"""', this.u16)), value: '' };
    this.depth++;
    const sb = [];
    const done = () => {
      bc.value = trimCommonIndent(trimSpaceAfterLastNewline(sb.join('')));
      bc.range.end = this.pos;
      this.depth--;
      return bc;
    };
    const unterminated = () => { this.errorf(bc.range.start, this.readerPos, 'block comments must be terminated with """'); return done(); };

    for (;;) {
      const r = this.peek();
      if (r === null) return unterminated();
      if (!isSpace(r)) { this.rewind(); break; }
      this.commit();
      if (r === '\n') break;
    }
    for (;;) {
      const r = this.read();
      if (r === null) return unterminated();
      if (r !== '"') { sb.push(r); continue; }
      const [s, eof] = this.peekn(2);
      if (eof) return unterminated();
      if (s !== '""') { sb.push('"'); this.rewind(); continue; }
      this.commit();
      return done();
    }
  }

  parseMapKey() {
    const mk = { range: this.range(this.pos), primary: {}, value: {} };
    const done = () => {
      mk.range.end = this.pos;
      return !mk.key && !mk.edges ? null : mk;
    };

    // ! & and & filters
    let r = this.peek();
    if (r === null) return done();
    if (r === '!') {
      const r2 = this.peek();
      if (r2 === null) return done();
      if (r2 === '&') { this.commit(); mk.not_ampersand = true; } else this.rewind();
    } else if (r === '&') {
      this.commit();
      mk.ampersand = true;
    } else {
      this.rewind();
    }

    r = this.peek();
    if (r === null) return done();
    if (r === '(') { this.commit(); this.parseEdgeGroup(mk); return done(); }
    this.rewind();

    const k = this.parseKey();
    if (k) mk.key = k;

    const [r2, newlines] = this.peekNotSpace();
    if (r2 === null) return done();
    if (newlines > 0) { this.rewind(); return done(); }
    switch (r2) {
      case '(':
        this.commit();
        this.parseEdgeGroup(mk);
        return done();
      case '<': case '>': case '-':
        this.rewind();
        delete mk.key;
        this.parseEdges(mk, k);
        this.parseMapKeyValue(mk);
        return done();
      default:
        this.rewind();
        this.parseMapKeyValue(mk);
        return done();
    }
  }

  parseMapKeyValue(mk) {
    const [r, newlines] = this.peekNotSpace();
    if (r === null) return;
    if (newlines > 0) { this.rewind(); return; }
    const keyless = !mk.key && !mk.edges;
    if (r === '{') {
      this.rewind();
      if (keyless) return;
    } else if (r === ':') {
      this.commit();
      if (keyless) this.errorf(mk.range.start, this.pos, 'map value without key');
    } else {
      this.rewind();
      return;
    }
    mk.value = this.parseValue();
    if (!unbox(mk.value)) this.errorf(subtract(this.pos, ':', this.u16), this.pos, 'missing value after colon');

    const sb = scalarBox(mk.value);
    // A scalar followed by { on the same line is the primary value; the map is the value.
    if (unbox(sb)) {
      const [r2, nl] = this.peekNotSpace();
      if (r2 === null || nl > 0 || r2 !== '{') { this.rewind(); return; }
      this.commit();
      this.replay(r2);
      mk.primary = sb;
      mk.value = this.parseValue();
    }
  }

  parseEdgeGroup(mk) {
    // Keep parseUnquotedString from consuming the closing parenthesis.
    this.inEdgeGroup = true;
    try {
      const src = this.parseKey();
      this.parseEdges(mk, src);

      let [r, newlines] = this.peekNotSpace();
      if (r === null || newlines > 0) { this.rewind(); return; }
      if (r !== ')') {
        this.rewind();
        this.errorf(mk.range.start, this.pos, 'edge groups must be terminated with )');
        return;
      }
      this.commit();

      [r, newlines] = this.peekNotSpace();
      if (r === null || newlines > 0) { this.rewind(); return; }
      if (r === '[') { this.commit(); const ei = this.parseEdgeIndex(); if (ei) mk.edge_index = ei; } else this.rewind();

      [r, newlines] = this.peekNotSpace();
      if (r === null || newlines > 0) { this.rewind(); return; }
      if (r === '.') {
        this.commit();
        const ek = this.parseKey();
        if (ek) mk.edge_key = ek;
      } else this.rewind();

      this.inEdgeGroup = false;
      this.parseMapKeyValue(mk);
    } finally {
      this.inEdgeGroup = false;
    }
  }

  parseEdgeIndex() {
    const ei = { range: this.range(subtract(this.pos, '[', this.u16)), int: null, glob: false };
    const end = (v) => { ei.range.end = this.pos; return v; };

    let [r, newlines] = this.peekNotSpace();
    if (r === null || newlines > 0) { this.rewind(); return end(null); }

    if (isDigit(r)) {
      this.commit();
      let digits = r;
      for (;;) {
        [r, newlines] = this.peekNotSpace();
        if (r === null || newlines > 0) {
          this.rewind();
          this.errorf(ei.range.start, this.pos, 'unterminated edge index');
          return end(null);
        }
        if (r === ']') { this.rewind(); break; }
        this.commit();
        if (!isDigit(r)) {
          this.errorf(subtract(this.pos, r, this.u16), this.pos, 'unexpected character in edge index');
          continue;
        }
        digits += r;
      }
      ei.int = atoi(digits);
    } else if (r === '*') {
      this.commit();
      ei.glob = true;
    } else {
      this.errorf(subtract(this.pos, r, this.u16), this.pos, 'unexpected character in edge index');
    }

    [r, newlines] = this.peekNotSpace();
    if (r === null || newlines > 0 || r !== ']') {
      this.rewind();
      this.errorf(ei.range.start, this.pos, 'unterminated edge index');
      return end(ei);
    }
    this.commit();
    return end(ei);
  }

  parseEdges(mk, src) {
    for (;;) {
      const e = { range: this.range(src ? src.range.start : this.pos), src, src_arrow: '', dst: null, dst_arrow: '' };
      e.range.end = pos();

      const [r, newlines] = this.peekNotSpace();
      if (r === null) return;
      if (newlines > 0) { this.rewind(); return; }
      if (r === '<' || r === '*') e.src_arrow = r;
      else if (r !== '-') { this.rewind(); return; }
      if (!src) {
        const start = subtract(this.laPos, r, this.u16);
        this.errorf(start, this.laPos, 'connection missing source');
        e.range.start = start;
      }
      this.commit();

      if (!this.parseEdge(e)) return;

      const dst = this.parseKey();
      if (!dst) {
        this.errorf(e.range.start, this.pos, 'connection missing destination');
      } else {
        e.dst = dst;
        e.range.end = dst.range.end;
      }
      (mk.edges ||= []).push(e);
      src = dst;
    }
  }

  parseEdge(e) {
    try {
      for (;;) {
        const r = this.peek();
        if (r === null) {
          this.errorf(e.range.start, this.readerPos, 'unterminated connection');
          return false;
        }
        switch (r) {
          case '>': case '*':
            e.dst_arrow = r;
            this.commit();
            return true;
          case '\\': {
            this.commit();
            const [r2, newlines] = this.peekNotSpace();
            if (r2 === null) continue;
            if (newlines === 0) {
              this.rewind();
              this.errorf(e.range.start, this.readerPos, 'only newline escapes are allowed in connections');
              return false;
            }
            if (newlines > 1) { this.rewind(); continue; }
            this.commit();
            this.replay(r2);
            break;
          }
          case '-':
            this.commit();
            break;
          default:
            this.rewind();
            return true;
        }
      }
    } finally {
      e.range.end = this.pos;
    }
  }

  parseKey() {
    const k = { range: this.range(this.pos), path: [] };
    const done = () => {
      if (k.path.length === 0) return null;
      k.range.end = unbox(k.path[k.path.length - 1]).range.end;
      for (const part of k.path) {
        if (!unbox(part)) continue;
        const n = utf8Len(scalarString(part));
        if (n > 518) {
          this.errorf(k.range.start, k.range.end, `key length ${n} exceeds maximum allowed length of 518`);
          break;
        }
      }
      return k;
    };

    for (;;) {
      let [r, newlines] = this.peekNotSpace();
      if (r === null) return done();
      if (newlines > 0 || r === '(') { this.rewind(); return done(); }
      if (r === '.') continue;
      this.rewind();

      const sb = this.parseString(true);
      const s = unbox(sb);
      if (!s) return done();
      if (sb.unquoted_string && scalarString(sb).startsWith('@')) {
        const v = scalarString(sb);
        this.errorf(s.range.start, s.range.end, `${v} is not a valid import, did you mean ...${v}?`);
      }
      if (k.path.length === 0) k.range.start = s.range.start;
      k.path.push(sb);

      [r, newlines] = this.peekNotSpace();
      if (r === null) return done();
      if (newlines > 0 || r !== '.') { this.rewind(); return done(); }
      this.commit();
    }
  }

  parseString(inKey) {
    const [r, newlines] = this.peekNotSpace();
    if (r === null || newlines > 0) { this.rewind(); return {}; }
    this.commit();
    switch (r) {
      case '"': return { double_quoted_string: this.parseDoubleQuotedString(inKey) };
      case "'": return { single_quoted_string: this.parseSingleQuotedString() };
      case '|': return { block_string: this.parseBlockString() };
      default: {
        this.replay(r);
        const s = this.parseUnquotedString(inKey);
        return s ? { unquoted_string: s } : {};
      }
    }
  }

  parseUnquotedString(inKey) {
    const s = { range: this.range(this.pos), value: null };
    let lastNonSpace = this.pos;
    let sb = '', rawb = '';
    let lastPatternIndex = 0;
    const push = (v) => (s.value ||= []).push(v);
    const done = () => {
      s.range.end = lastNonSpace;
      const sv = trimRightSpace(sb), rawv = trimRightSpace(rawb);
      if (s.pattern && lastPatternIndex < sv.length) s.pattern.push(sv.slice(lastPatternIndex));
      if (sv === '') return s.value?.length ? s : null;
      push({ string: sv, raw_string: rawv });
      return s;
    };

    const [head, eof] = this.peekn(4);
    this.rewind();
    if (!eof && head === '...@') this.errorf(this.pos, advanceString(this.pos, '...@', this.u16), "unquoted strings cannot begin with ...@ as that's import spread syntax");

    for (;;) {
      let r = this.peek();
      if (r === null) return done();

      if (this.inEdgeGroup && r === ')') {
        const [r2, newlines] = this.peekNotSpace();
        if (r2 === null || newlines > 0) { this.rewind(); return done(); }
        if ('\n#{}[]:.'.includes(r2)) { this.rewind(); return done(); }
        this.rewind();
        this.peek();
        this.commit();
        lastNonSpace = this.pos;
        sb += r;
        rawb += r;
        continue;
      }

      if ('\n;#{}[]'.includes(r)) { this.rewind(); return done(); }
      if (inKey) {
        if (':.<>&'.includes(r)) { this.rewind(); return done(); }
        if (r === '-') {
          const r2 = this.peek();
          if (r2 === null) return done();
          if ('\n;#{}[]'.includes(r2)) {
            this.rewind();
            this.peek();
            this.commit();
            sb += r;
            rawb += r;
            return done();
          }
          if (r2 === '-' || r2 === '>' || r2 === '*') { this.rewind(); return done(); }
          sb += r;
          rawb += r;
          r = r2;
        }
      }

      if (r === '*') {
        (s.pattern ||= []).push(...(sb.length === 0 ? ['*'] : [sb.slice(lastPatternIndex), '*']));
        lastPatternIndex = sb.length + 1;
      }

      this.commit();
      if (!isSpace(r)) lastNonSpace = this.pos;

      if (!inKey && r === '$') {
        const subst = this.parseSubstitution(false);
        if (subst) {
          if (sb.length > 0) { push({ string: sb, raw_string: rawb }); sb = ''; rawb = ''; }
          push({ substitution: subst });
        }
        continue;
      }

      if (r !== '\\') { sb += r; rawb += r; continue; }

      const r2 = this.read();
      if (r2 === null) {
        this.errorf(subtract(this.pos, '\\', this.u16), this.readerPos, 'unfinished escape sequence');
        return done();
      }
      if (r2 === '\n') {
        const [r3, newlines] = this.peekNotSpace();
        if (r3 === null || newlines > 0) { this.rewind(); return done(); }
        this.commit();
        this.replay(r3);
        continue;
      }
      sb += decodeEscape(r2);
      rawb += '\\' + r2;
    }
  }

  parseDoubleQuotedString(inKey) {
    const s = { range: this.range(subtract(this.pos, '"', this.u16)), value: null };
    let sb = '', rawb = '';
    const push = (v) => (s.value ||= []).push(v);
    const done = () => {
      s.range.end = this.pos;
      if (sb.length > 0) push({ string: sb, raw_string: rawb });
      return s;
    };
    const unterminated = (end) => this.errorf(s.range.start, end, 'double quoted strings must be terminated with "');

    for (;;) {
      const r = this.peek();
      if (r === null) { unterminated(this.readerPos); return done(); }
      if (r === '\n') { this.rewind(); unterminated(this.pos); return done(); }
      this.commit();

      if (!inKey && r === '$') {
        const subst = this.parseSubstitution(false);
        if (subst) {
          if (sb.length > 0) { push({ string: sb }); sb = ''; } // Go resets sb but not rawb here
          push({ substitution: subst });
          continue;
        }
      }
      if (r === '"') return done();
      if (r !== '\\') { sb += r; rawb += r; continue; }

      const r2 = this.read();
      if (r2 === null) {
        this.errorf(subtract(this.pos, '\\', this.u16), this.readerPos, 'unfinished escape sequence');
        unterminated(this.readerPos);
        return done();
      }
      if (r2 === '\n') continue;
      sb += decodeEscape(r2);
      rawb += '\\' + r2;
    }
  }

  parseSingleQuotedString() {
    const s = { range: this.range(subtract(this.pos, "'", this.u16)), raw: '', value: '' };
    let sb = '';
    const done = () => { s.range.end = this.pos; s.value = sb; return s; };
    const unterminated = (end) => this.errorf(s.range.start, end, "single quoted strings must be terminated with '");

    for (;;) {
      let r = this.peek();
      if (r === null) { unterminated(this.readerPos); return done(); }
      if (r === '\n') { this.rewind(); unterminated(this.pos); return done(); }
      this.commit();

      if (r === "'") {
        r = this.peek();
        if (r === null) return done();
        if (r === "'") { this.commit(); sb += "'"; continue; }
        this.rewind();
        return done();
      }
      if (r !== '\\') { sb += r; continue; }

      const r2 = this.peek();
      if (r2 === null) continue;
      if (r2 === '\n') { this.commit(); continue; }
      sb += r;
      this.rewind();
    }
  }

  parseBlockString() {
    const bs = { range: this.range(subtract(this.pos, '|', this.u16)), quote: '', tag: '', value: '' };
    this.depth++;
    let sb = '';
    const done = () => {
      bs.value = trimCommonIndent(trimSpaceAfterLastNewline(sb));
      bs.range.end = this.pos;
      this.depth--;
      return bs;
    };
    const unterminated = () => { this.errorf(bs.range.start, this.readerPos, `block string must be terminated with ${bs.quote}|`); return done(); };

    // More quote symbols?
    for (;;) {
      const r = this.peek();
      if (r === null) return unterminated();
      if (isSpace(r) || isLetter(r) || isDigit(r) || r === '_') { this.rewind(); break; }
      this.commit();
      bs.quote += r;
    }
    // A tag?
    for (;;) {
      const r = this.peek();
      if (r === null) return unterminated();
      if (isSpace(r)) { this.rewind(); break; }
      this.commit();
      bs.tag += r;
    }
    if (bs.tag === '') bs.tag = 'md';

    // Skip whitespace up to and including the first newline.
    for (;;) {
      const r = this.peek();
      if (r === null) return unterminated();
      if (!isSpace(r)) {
        sb += ' '.repeat(this.depth * 2); // text on the first line has an implicit indent
        this.rewind();
        break;
      }
      this.commit();
      if (r === '\n') break;
    }

    let endHint = '|', endRest = '';
    if (bs.quote.length > 0) {
      const q = Array.from(bs.quote);
      endHint = q[q.length - 1];
      endRest = bs.quote.slice(endHint.length) + '|';
    }
    const restLen = Array.from(endRest).length;

    for (;;) {
      const r = this.read();
      if (r === null) return unterminated();
      if (r !== endHint) { sb += r; continue; }
      const [s, eof] = this.peekn(restLen);
      if (eof) return unterminated();
      if (s !== endRest) { sb += endHint; this.rewind(); continue; }
      this.commit();
      return done();
    }
  }

  parseArray() {
    const a = { range: this.range(subtract(this.pos, '[', this.u16)), nodes: null };
    this.depth++;
    try {
      for (;;) {
        const r = this.readNotSpace();
        if (r === null) {
          this.errorf(a.range.start, this.readerPos, 'arrays must be terminated with ]');
          return a;
        }
        if (r === ';') continue;
        if (r === ']') return a;

        const n = this.parseArrayNode(r);
        if (unbox(n)) (a.nodes ||= []).push(n);
        if (n.block_comment) continue;

        const after = this.pos;
        for (;;) {
          const [r2, newlines] = this.peekNotSpace();
          if (r2 === null || newlines !== 0 || r2 === ';' || r2 === ']' || r2 === '#') { this.rewind(); break; }
          this.commit();
        }
        if (!posEq(after, this.pos)) {
          if (unbox(n)) this.errorf(after, this.pos, `unexpected text after ${boxType(n)}`);
          else this.errorf(after, this.pos, 'invalid text beginning unquoted string');
        }
      }
    } finally {
      a.range.end = this.readerPos;
      this.depth--;
    }
  }

  parseArrayNode(r) {
    const special = this.parseSpecialNode(r);
    if (special) return special;
    this.replay(r);
    const vbox = this.parseValue();
    const us = vbox.unquoted_string;
    if (us && scalarString(vbox) === '' && !(us.value?.length > 0 && us.value[0].substitution)) {
      this.errorf(this.pos, advance(this.pos, r, this.u16), `unquoted strings cannot start on ${quoteRune(r)}`);
    }
    const { suspension, ...rest } = vbox; // array nodes cannot hold suspensions
    return rest;
  }

  parseValue() {
    const [r, newlines] = this.peekNotSpace();
    if (r === null || newlines > 0) { this.rewind(); return {}; }
    this.commit();
    switch (r) {
      case '[': return { array: this.parseArray() };
      case '{': return { map: this.parseMap(false) };
      case '@': return { import: this.parseImport(false) };
    }

    this.replay(r);
    const sb = this.parseString(false);
    if (!sb.unquoted_string) return sb;

    const s = sb.unquoted_string;
    const v = scalarString(sb);
    const at = (extra) => ({ range: s.range, ...extra });
    if (foldEq(v, 'null')) return { null: at() };
    if (foldEq(v, 'suspend')) return { suspension: at({ value: true }) };
    if (foldEq(v, 'unsuspend')) return { suspension: at({ value: false }) };
    if (foldEq(v, 'true')) return { boolean: at({ value: true }) };
    if (foldEq(v, 'false')) return { boolean: at({ value: false }) };
    const rat = ratString(v);
    if (rat !== null) return { number: at({ raw: v, value: rat }) };
    return sb;
  }

  parseSubstitution(spread) {
    const subst = { range: this.range(subtractString(this.pos, '$', this.u16)), spread, path: null };
    if (spread) subst.range.start = subtractString(subst.range.start, '...', this.u16);
    const end = (v) => { subst.range.end = this.pos; return v; };

    let [r, newlines] = this.peekNotSpace();
    if (r === null) return end(null);
    if (newlines > 0) { this.rewind(); return end(null); }
    if (r !== '{') {
      this.rewind();
      this.errorf(subst.range.start, this.readerPos, 'substitutions must begin on {');
      return end(null);
    }
    this.commit();

    const k = this.parseKey();
    if (k) subst.path = k.path;

    [r, newlines] = this.peekNotSpace();
    if (r === null) {
      this.errorf(subst.range.start, this.readerPos, 'substitutions must be terminated by }');
      return end(subst);
    }
    if (newlines > 0 || r !== '}') {
      this.rewind();
      this.errorf(subst.range.start, this.pos, 'substitutions must be terminated by }');
      return end(subst);
    }
    this.commit();
    return end(subst);
  }

  parseImport(spread) {
    // (Go subtracts "$" here although the sigil is "@"; both are one unit wide.)
    const imp = { range: this.range(subtractString(this.pos, '$', this.u16)), spread, pre: '', path: null };
    if (spread) imp.range.start = subtractString(imp.range.start, '...', this.u16);

    for (;;) {
      const r = this.peek();
      if (r === null) break;
      if (r !== '.' && r !== '/') { this.rewind(); break; }
      imp.pre += r;
      this.commit();
    }

    const k = this.parseKey();
    if (k) {
      if (k.path[0].unquoted_string && k.path.length > 1 && k.path[1].unquoted_string && scalarString(k.path[1]) === 'd2') k.path.splice(1, 1);
      imp.path = k.path;
    }
    imp.range.end = this.pos;
    return imp;
  }
}

// Go's strconv.Atoi on a digit string (Unicode Nd digits other than 0-9 make it fail, giving 0).
const atoi = (s) => (/^[0-9]+$/.test(s) && s.length < 19 ? Number(s) : 0);

// https://go.dev/ref/spec#Rune_literals
const ESC = { a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', '"': '"' };
const decodeEscape = (r) => ESC[r] ?? r;

// Go's %q for a rune.
function quoteRune(r) {
  const c = r.codePointAt(0);
  const e = { "'": "\\'", '\\': '\\\\', '\x07': '\\a', '\b': '\\b', '\f': '\\f', '\n': '\\n', '\r': '\\r', '\t': '\\t', '\v': '\\v' }[r];
  if (e) return `'${e}'`;
  if (/^[\p{L}\p{M}\p{N}\p{P}\p{S} ]$/u.test(r)) return `'${r}'`;
  const hex = c.toString(16).padStart(c < 0x80 ? 2 : c < 0x10000 ? 4 : 8, '0');
  return `'${c < 0x80 ? '\\x' : c < 0x10000 ? '\\u' : '\\U'}${hex}'`;
}

export function trimSpaceAfterLastNewline(s) {
  const nl = s.lastIndexOf('\n');
  if (nl === -1) return trimRightSpace(s);
  const last = trimRightSpace(s.slice(nl + 1));
  return last.length === 0 ? s.slice(0, nl) : s.slice(0, nl + 1) + last;
}

function splitLeadingIndent(s, maxSpaces) {
  let indent = '', i = 0;
  for (const ch of s) {
    if (!isSpace(ch)) break;
    i += ch.length;
    indent += ch === '\t' ? '  ' : ch;
    if (maxSpaces > -1 && utf8Len(indent) === maxSpaces) break;
  }
  return [indent, s.slice(i)];
}

function trimIndent(s, indent) {
  const n = utf8Len(indent);
  return s.split('\n').map((l) => (l === '' ? l : splitLeadingIndent(l, n)[1])).join('\n');
}

export function trimCommonIndent(s) {
  let common = '';
  for (const l of s.split('\n')) {
    if (l === '') continue;
    const [indent, rest] = splitLeadingIndent(l, -1);
    if (indent === '') return s;
    if (rest === '') continue; // whitespace-only line
    if (common === '' || utf8Len(indent) < utf8Len(common)) common = indent;
  }
  return common === '' ? s : trimIndent(s, common);
}

// Go's big.Rat SetString (ratconv.go, natconv.go), printed the way Rat marshals to JSON ("2/5", "200"); null if s is
// not a number. Underscores between digits, 0b/0o/0x prefixes, hex floats with a "p" exponent and "a/b" are all accepted.
export function ratString(s) {
  if (s.length === 0) return null;
  let num, den;
  const sep = s.indexOf('/');
  if (sep >= 0) {
    const a = bigIntSetString(s.slice(0, sep));
    if (a === null) return null;
    const r = new ByteReader(s.slice(sep + 1));
    const b = natScan(r, 0, false);
    if (b.err || r.readByte() !== null) return null;
    if (b.val === 0n) return null;
    num = a;
    den = b.val;
  } else {
    const r = new ByteReader(s);
    const neg = scanSign(r);
    if (neg === null) return null;
    const m = natScan(r, 0, true);
    if (m.err) return null;
    const e = scanExponent(r);
    if (e.err) return null;
    if (r.readByte() !== null) return null;
    if (m.val === 0n) return '0';
    let exp2 = 0, exp5 = 0;
    if (m.count < 0) {
      const d = m.count;
      if (m.base === 10) { exp5 = d; exp2 = d; } else if (m.base === 2) exp2 = d; else if (m.base === 8) exp2 = d * 3; else exp2 = d * 4;
    }
    if (e.base === 10) { exp5 += e.exp; exp2 += e.exp; } else exp2 += e.exp;
    num = m.val;
    den = 1n;
    if (exp5 !== 0) {
      const n = Math.abs(exp5);
      if (n > 1e6) return null; // avoid excessively large exponents
      const pow5 = 5n ** BigInt(n);
      if (exp5 > 0) num *= pow5; else den = pow5;
    }
    if (exp2 < -1e7 || exp2 > 1e7) return null;
    if (exp2 > 0) num <<= BigInt(exp2); else if (exp2 < 0) den <<= BigInt(-exp2);
    if (neg) num = -num;
  }
  const g = gcd(num < 0n ? -num : num, den);
  if (g > 1n) { num /= g; den /= g; }
  return den === 1n ? String(num) : `${num}/${den}`;
}
const gcd = (a, b) => { while (b) [a, b] = [b, a % b]; return a || 1n; };

class ByteReader {
  constructor(s) { this.s = s; this.i = 0; }
  readByte() { return this.i < this.s.length ? this.s[this.i++] : null; }
  unreadByte() { this.i--; }
}
function scanSign(r) { // true if negative, null on a read error
  const ch = r.readByte();
  if (ch === null) return null;
  if (ch === '-') return true;
  if (ch !== '+') r.unreadByte();
  return false;
}
// big.Int SetString(s, 0)
function bigIntSetString(s) {
  const r = new ByteReader(s);
  const neg = scanSign(r);
  if (neg === null) return null;
  const m = natScan(r, 0, false);
  if (m.err || r.readByte() !== null) return null;
  return neg ? -m.val : m.val;
}
// nat.scan: returns { val, base, count, err }; count is the digit count, or minus the fractional digits if there was a period.
function natScan(r, base, fracOk) {
  let prev = '.', invalSep = false;
  let ch = r.readByte();
  let b = base, prefix = '';
  let count = 0;
  if (base === 0) {
    b = 10;
    if (ch === '0') {
      prev = '0';
      count = 1;
      ch = r.readByte();
      if (ch !== null) {
        switch (ch) {
          case 'b': case 'B': b = 2; prefix = 'b'; break;
          case 'o': case 'O': b = 8; prefix = 'o'; break;
          case 'x': case 'X': b = 16; prefix = 'x'; break;
          default: if (!fracOk) { b = 8; prefix = '0'; }
        }
        if (prefix !== '') {
          count = 0; // prefix is not counted
          if (prefix !== '0') ch = r.readByte();
        }
      }
    }
  }
  let val = 0n, dp = -1;
  const B = BigInt(b);
  while (ch !== null) {
    if (ch === '.' && fracOk) {
      fracOk = false;
      if (prev === '_') invalSep = true;
      prev = '.';
      dp = count;
    } else if (ch === '_' && base === 0) {
      if (prev !== '0') invalSep = true;
      prev = '_';
    } else {
      let d1 = 99;
      if (ch >= '0' && ch <= '9') d1 = ch.charCodeAt(0) - 48;
      else if (ch >= 'a' && ch <= 'z') d1 = ch.charCodeAt(0) - 97 + 10;
      else if (ch >= 'A' && ch <= 'Z') d1 = ch.charCodeAt(0) - 65 + 10; // b <= 36 always here
      if (d1 >= b) { r.unreadByte(); break; } // ch does not belong to number anymore
      prev = '0';
      count++;
      val = val * B + BigInt(d1);
    }
    ch = r.readByte();
  }
  let err = false;
  if (invalSep || prev === '_') err = true;
  if (count === 0) {
    // no digits found
    if (prefix === '0') return { val: 0n, base: 10, count: 1, err }; // only the octal prefix 0: decimal 0
    err = true;
  }
  if (dp >= 0) count = dp - count; // 0 <= dp <= count
  return { val, base: b, count, err };
}
// scanExponent(r, base2ok=true, sepOk=true): { exp, base, err }
function scanExponent(r) {
  let ch = r.readByte();
  if (ch === null) return { exp: 0, base: 10, err: false };
  let base;
  if (ch === 'e' || ch === 'E') base = 10;
  else if (ch === 'p' || ch === 'P') base = 2;
  else { r.unreadByte(); return { exp: 0, base: 10, err: false }; }
  let digits = '';
  ch = r.readByte();
  if (ch === '+' || ch === '-') {
    if (ch === '-') digits += '-';
    ch = r.readByte();
  }
  let prev = '.', invalSep = false, hasDigits = false;
  while (ch !== null) {
    if (ch >= '0' && ch <= '9') { digits += ch; prev = '0'; hasDigits = true; }
    else if (ch === '_') { if (prev !== '0') invalSep = true; prev = '_'; }
    else { r.unreadByte(); break; }
    ch = r.readByte();
  }
  if (!hasDigits) return { exp: 0, base, err: true };
  const n = BigInt(digits);
  if (n > 9223372036854775807n || n < -9223372036854775808n) return { exp: 0, base, err: true };
  if (invalSep || prev === '_') return { exp: Number(n), base, err: true };
  return { exp: Number(n), base, err: false };
}
