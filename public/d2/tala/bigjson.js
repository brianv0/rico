// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JSON with exact 64-bit integers, for the TALA port (D2 v0.9.0, d2layouts/d2talalayout): entity IDs are int64 in Go, some are random
// 63-bit values, and JSON.parse would round them. parse() returns a BigInt for every integer token that a double cannot hold exactly
// (and a Number for everything else); stringify() prints BigInt as digits. The graphjson codec converts every ID field to BigInt itself.

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/** JSON.parse with integer tokens beyond 2^53 as BigInt. */
export function parse(text) {
  let i = 0;
  const n = text.length;
  const err = (msg) => new SyntaxError(`${msg} at ${i}`);
  const ws = () => { while (i < n && (text[i] === ' ' || text[i] === '\n' || text[i] === '\r' || text[i] === '\t')) i++; };
  const value = () => {
    ws();
    const c = text[i];
    if (c === '{') {
      i++;
      const o = {};
      ws();
      if (text[i] === '}') { i++; return o; }
      for (;;) {
        ws();
        if (text[i] !== '"') throw err('expected a key');
        const k = string();
        ws();
        if (text[i] !== ':') throw err('expected :');
        i++;
        const v = value();
        Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
        ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === '}') { i++; return o; }
        throw err('expected , or }');
      }
    }
    if (c === '[') {
      i++;
      const a = [];
      ws();
      if (text[i] === ']') { i++; return a; }
      for (;;) {
        a.push(value());
        ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === ']') { i++; return a; }
        throw err('expected , or ]');
      }
    }
    if (c === '"') return string();
    if (text.startsWith('true', i)) { i += 4; return true; }
    if (text.startsWith('false', i)) { i += 5; return false; }
    if (text.startsWith('null', i)) { i += 4; return null; }
    const m = /^-?(?:0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i, i + 400));
    if (!m) throw err('unexpected token');
    i += m[0].length;
    if (m[1] === undefined && m[2] === undefined) {
      const b = BigInt(m[0]);
      if (b > MAX_SAFE || b < -MAX_SAFE) return b;
      return Number(m[0]);
    }
    return Number(m[0]);
  };
  const string = () => {
    const start = i;
    i++;
    while (i < n && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
    i++;
    return JSON.parse(text.slice(start, i));
  };
  const v = value();
  ws();
  if (i < n) throw err('trailing data');
  return v;
}

/** JSON.stringify with BigInt as digits; `sortKeys` sorts object keys (canonical form for comparisons). */
export function stringify(v, sortKeys = false) {
  const out = [];
  const w = (x) => {
    if (typeof x === 'bigint') out.push(x.toString());
    else if (x === null || x === undefined) out.push('null');
    else if (Array.isArray(x)) {
      out.push('[');
      x.forEach((e, k) => { if (k) out.push(','); w(e); });
      out.push(']');
    } else if (typeof x === 'object') {
      const keys = sortKeys ? Object.keys(x).sort() : Object.keys(x);
      out.push('{');
      let first = true;
      for (const k of keys) {
        if (x[k] === undefined) continue;
        if (!first) out.push(',');
        first = false;
        out.push(JSON.stringify(k), ':');
        w(x[k]);
      }
      out.push('}');
    } else out.push(JSON.stringify(x));
  };
  w(v);
  return out.join('');
}

/** Numbers within the safe range for BigInts that fit (so values from parse() and from the port compare equal). */
export function normalize(v) {
  if (typeof v === 'bigint') return (v <= MAX_SAFE && v >= -MAX_SAFE) ? Number(v) : v;
  if (Array.isArray(v)) return v.map(normalize);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v)) o[k] = normalize(v[k]);
    return o;
  }
  return v;
}

/** For comparisons: BigInt that fits a double becomes a Number, any other BigInt a string "123n". */
export function plain(v) {
  if (typeof v === 'bigint') return (v <= MAX_SAFE && v >= -MAX_SAFE) ? Number(v) : `${v}n`;
  if (Array.isArray(v)) return v.map(plain);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v)) o[k] = plain(v[k]);
    return o;
  }
  return v;
}
