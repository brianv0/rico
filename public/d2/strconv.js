// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of the parts of Go's strconv (Go 1.24, BSD-3-Clause, Copyright 2009 The Go Authors) that d2compiler
// and d2graph use on user text: Atoi, ParseFloat (64 bit), ParseBool and their error messages. Results are
// [value, errorMessage|null]; Go's NumError text is `strconv.<Func>: parsing "<s>": <reason>`.
//
// Numbers are JS doubles, so an Atoi result beyond 2^53 is rounded (Go prints the int64 exactly; the range checks D2
// does on it are unaffected, and the diff compares JSON numbers as doubles).

import { quote } from './url.js';

const numError = (fn, s, reason) => `strconv.${fn}: parsing ${quote(s)}: ${reason}`;
const ERR_SYNTAX = 'invalid syntax';
const ERR_RANGE = 'value out of range';

const lower = (c) => c | 0x20;
const isDigit = (c) => c >= 48 && c <= 57;

/** Atoi on a (JS) string; the string is treated as UTF-8 bytes, so any non-ASCII is a syntax error. */
export function atoi(s) {
  const fn = 'Atoi';
  let i = 0;
  let neg = false;
  if (s === '') return [0, numError(fn, s, ERR_SYNTAX)];
  if (s[0] === '+') i = 1;
  else if (s[0] === '-') { neg = true; i = 1; }
  if (i >= s.length) return [0, numError(fn, s, ERR_SYNTAX)];
  // ParseUint's loop: a syntax error or an overflow is reported at the first character that causes it
  const maxUint64 = (1n << 64n) - 1n;
  const cutoff = maxUint64 / 10n + 1n;
  let n = 0n;
  let overflow = false;
  for (let k = i; k < s.length; k++) {
    const c = s.charCodeAt(k);
    if (!isDigit(c)) return [0, numError(fn, s, ERR_SYNTAX)];
    if (n >= cutoff) { overflow = true; break; }
    n *= 10n;
    const n1 = n + BigInt(c - 48);
    if (n1 > maxUint64) { overflow = true; break; }
    n = n1;
  }
  // int is 64 bits
  if (overflow || (!neg && n > 9223372036854775807n)) {
    return neg ? [-Number(9223372036854775808n), numError(fn, s, ERR_RANGE)] : [Number(9223372036854775807n), numError(fn, s, ERR_RANGE)];
  }
  if (neg && n > 9223372036854775808n) return [-Number(9223372036854775808n), numError(fn, s, ERR_RANGE)];
  return [Number(neg ? -n : n), null];
}

/** ParseBool */
export function parseBool(s) {
  switch (s) {
    case '1': case 't': case 'T': case 'true': case 'TRUE': case 'True': return [true, null];
    case '0': case 'f': case 'F': case 'false': case 'FALSE': case 'False': return [false, null];
  }
  return [false, numError('ParseBool', s, ERR_SYNTAX)];
}

// ---- ParseFloat ----

function underscoreOK(s) {
  let saw = '^';
  let i = 0;
  if (s.length >= 1 && (s[0] === '-' || s[0] === '+')) s = s.slice(1);
  let hex = false;
  if (s.length >= 2 && s[0] === '0' && (lower(s.charCodeAt(1)) === 98 || lower(s.charCodeAt(1)) === 111 || lower(s.charCodeAt(1)) === 120)) {
    i = 2;
    saw = '0';
    hex = lower(s.charCodeAt(1)) === 120;
  }
  for (; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (isDigit(c) || (hex && lower(c) >= 97 && lower(c) <= 102)) { saw = '0'; continue; }
    if (s[i] === '_') {
      if (saw !== '0') return false;
      saw = '_';
      continue;
    }
    if (saw === '_') return false;
    saw = '!';
  }
  return saw !== '_';
}

function commonPrefixLenIgnoreCase(s, prefix) {
  let n = Math.min(prefix.length, s.length);
  for (let i = 0; i < n; i++) {
    let c = s.charCodeAt(i);
    if (c >= 65 && c <= 90) c += 32;
    if (c !== prefix.charCodeAt(i)) return i;
  }
  return n;
}

// special: [value, consumed, ok]
function special(s) {
  if (s.length === 0) return [0, 0, false];
  let sign = 1;
  let nsign = 0;
  let c = s[0];
  let fall = false;
  if (c === '+' || c === '-') {
    if (c === '-') sign = -1;
    nsign = 1;
    s = s.slice(1);
    fall = true;
  }
  if (fall || c === 'i' || c === 'I') {
    let n = commonPrefixLenIgnoreCase(s, 'infinity');
    if (n > 3 && n < 8) n = 3;
    if (n === 3 || n === 8) return [sign * Infinity, nsign + n, true];
  } else if (c === 'n' || c === 'N') {
    if (commonPrefixLenIgnoreCase(s, 'nan') === 3) return [NaN, 3, true];
  }
  return [0, 0, false];
}

// readFloat: {mantissa: BigInt, exp, neg, trunc, hex, i, ok}
function readFloat(s) {
  const r = { mantissa: 0n, exp: 0, neg: false, trunc: false, hex: false, i: 0, ok: false };
  let i = 0;
  let underscores = false;
  if (i >= s.length) return r;
  if (s[i] === '+') i++;
  else if (s[i] === '-') { r.neg = true; i++; }

  let base = 10n;
  let maxMantDigits = 19;
  let expChar = 101; // 'e'
  if (i + 2 < s.length && s[i] === '0' && lower(s.charCodeAt(i + 1)) === 120) {
    base = 16n;
    maxMantDigits = 16;
    i += 2;
    expChar = 112; // 'p'
    r.hex = true;
  }
  let sawdot = false, sawdigits = false;
  let nd = 0, ndMant = 0, dp = 0;
  loop:
  for (; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 95) { underscores = true; continue; }
    if (c === 46) {
      if (sawdot) break loop;
      sawdot = true;
      dp = nd;
      continue;
    }
    if (isDigit(c)) {
      sawdigits = true;
      if (c === 48 && nd === 0) { dp--; continue; }
      nd++;
      if (ndMant < maxMantDigits) { r.mantissa = r.mantissa * base + BigInt(c - 48); ndMant++; }
      else if (c !== 48) r.trunc = true;
      continue;
    }
    if (base === 16n && lower(c) >= 97 && lower(c) <= 102) {
      sawdigits = true;
      nd++;
      if (ndMant < maxMantDigits) { r.mantissa = r.mantissa * 16n + BigInt(lower(c) - 97 + 10); ndMant++; }
      else r.trunc = true;
      continue;
    }
    break;
  }
  r.i = i;
  if (!sawdigits) return r;
  if (!sawdot) dp = nd;

  if (base === 16n) { dp *= 4; ndMant *= 4; }

  if (i < s.length && lower(s.charCodeAt(i)) === expChar) {
    i++;
    r.i = i;
    if (i >= s.length) return r;
    let esign = 1;
    if (s[i] === '+') i++;
    else if (s[i] === '-') { i++; esign = -1; }
    r.i = i;
    if (i >= s.length || !isDigit(s.charCodeAt(i))) return r;
    let e = 0;
    for (; i < s.length && (isDigit(s.charCodeAt(i)) || s[i] === '_'); i++) {
      if (s[i] === '_') { underscores = true; continue; }
      if (e < 10000) e = e * 10 + s.charCodeAt(i) - 48;
    }
    r.i = i;
    dp += e * esign;
  } else if (base === 16n) {
    return r; // Must have exponent.
  }

  if (r.mantissa !== 0n) r.exp = dp - ndMant;

  if (underscores && !underscoreOK(s.slice(0, i))) return r;

  r.ok = true;
  return r;
}

// atofHex: the correctly rounded double of mantissa * 2^exp (mantissa carries a sticky bit when trunc); [value, rangeError]
function atofHex(mantissa, exp, neg, trunc) {
  if (mantissa === 0n) return [neg ? -0 : 0, false];
  let m = mantissa;
  if (trunc) m = (m << 1n) | 1n, exp -= 1;
  const bits = m.toString(2).length;
  if (bits > 53) {
    const shift = BigInt(bits - 53);
    const rem = m & ((1n << shift) - 1n);
    const half = 1n << (shift - 1n);
    m >>= shift;
    exp += Number(shift);
    if (rem > half || (rem === half && (m & 1n) === 1n)) m += 1n;
  }
  let f = Number(m);
  // scale by 2^exp in steps to avoid intermediate overflow/underflow
  let over = false;
  while (exp > 0) { const st = Math.min(exp, 1000); f *= 2 ** st; exp -= st; }
  while (exp < 0) { const st = Math.min(-exp, 1000); f /= 2 ** st; exp += st; }
  if (!Number.isFinite(f)) over = true;
  return [neg ? -f : f, over];
}

/** ParseFloat(s, 64) -> [value, errorMessage|null] */
export function parseFloat64(s) {
  const fn = 'ParseFloat';
  let [val, n, ok] = special(s);
  let f = 0, err = null;
  if (ok) f = val;
  else {
    const r = readFloat(s);
    n = r.i;
    if (!r.ok) return [0, numError(fn, s, ERR_SYNTAX)];
    if (r.hex) {
      let over;
      [f, over] = atofHex(r.mantissa, r.exp, r.neg, r.trunc);
      if (over) err = numError(fn, s, ERR_RANGE);
    } else {
      f = Number(s.slice(0, n).replace(/_/g, ''));
      if (!Number.isFinite(f)) err = numError(fn, s, ERR_RANGE);
    }
  }
  if (n !== s.length) return [0, numError(fn, s, ERR_SYNTAX)];
  return [f, err];
}
