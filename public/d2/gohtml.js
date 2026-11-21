// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of Go's html.UnescapeString (Go 1.24, BSD-3-Clause, Copyright 2010 The Go Authors).
// Go works on bytes; the only bytes that matter here are ASCII ('&', '#', digits, letters, ';'), so UTF-16 code units
// give the same result. The numeric references use Go's int32 `rune` arithmetic, which wraps.

import { ENTITY, ENTITY2 } from './htmlentity.js';

const longestEntityWithoutSemicolon = 6;

let entity = null, entity2 = null;
function entityMaps() {
  if (entity) return [entity, entity2];
  entity = new Map();
  for (const e of ENTITY.split(' ')) { const i = e.lastIndexOf(':'); entity.set(e.slice(0, i), parseInt(e.slice(i + 1), 16)); }
  entity2 = new Map();
  for (const e of ENTITY2.split(' ')) { const [n, a, b] = e.split(':'); entity2.set(n, [parseInt(a, 16), parseInt(b, 16)]); }
  return [entity, entity2];
}

// Windows-1252 replacements for numeric references 0x80..0x9F.
const replacementTable = [
  0x20AC, 0x0081, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021, 0x02C6, 0x2030, 0x0160, 0x2039, 0x0152, 0x008D, 0x017D, 0x008F,
  0x0090, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014, 0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0x009D, 0x017E, 0x0178,
];

// utf8.EncodeRune: invalid runes (negative, surrogates, too large) are written as U+FFFD.
const encodeRune = (r) => (r < 0 || r > 0x10FFFF || (r >= 0xD800 && r <= 0xDFFF) ? '�' : String.fromCodePoint(r));

/** unescapeEntity at s[src] == '&': returns [replacement text, number of code units consumed]. */
function unescapeEntity(s, src) {
  const [entity, entity2] = entityMaps();
  const rest = s.length - src;
  let i = 1;

  if (rest <= 1) return ['&', 1];

  if (s[src + i] === '#') {
    if (rest <= 3) return ['&', 1]; // We need to have at least "&#.".
    i++;
    let c = s[src + i];
    let hex = false;
    if (c === 'x' || c === 'X') { hex = true; i++; }

    let x = 0;
    while (i < rest) {
      c = s[src + i];
      i++;
      if (hex) {
        if (c >= '0' && c <= '9') { x = (Math.imul(16, x) + c.charCodeAt(0) - 48) | 0; continue; }
        if (c >= 'a' && c <= 'f') { x = (Math.imul(16, x) + c.charCodeAt(0) - 97 + 10) | 0; continue; }
        if (c >= 'A' && c <= 'F') { x = (Math.imul(16, x) + c.charCodeAt(0) - 65 + 10) | 0; continue; }
      } else if (c >= '0' && c <= '9') { x = (Math.imul(10, x) + c.charCodeAt(0) - 48) | 0; continue; }
      if (c !== ';') i--;
      break;
    }

    if (i <= 3) return ['&', 1]; // No characters matched.

    if (x >= 0x80 && x <= 0x9F) x = replacementTable[x - 0x80];
    else if (x === 0 || (x >= 0xD800 && x <= 0xDFFF) || x > 0x10FFFF) x = 0xFFFD;
    return [encodeRune(x), i];
  }

  // Consume the maximum number of characters possible, with the consumed characters matching one of the named references.
  while (i < rest) {
    const c = s[src + i];
    i++;
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')) continue;
    if (c !== ';') i--;
    break;
  }

  const entityName = s.slice(src + 1, src + i);
  if (entityName.length === 0) {
    // No-op.
  } else {
    let x = entity.get(entityName);
    if (x) return [encodeRune(x), i];
    const x2 = entity2.get(entityName);
    if (x2) return [encodeRune(x2[0]) + encodeRune(x2[1]), i];
    let maxLen = entityName.length - 1;
    if (maxLen > longestEntityWithoutSemicolon) maxLen = longestEntityWithoutSemicolon;
    for (let j = maxLen; j > 1; j--) {
      x = entity.get(entityName.slice(0, j));
      if (x) return [encodeRune(x), j + 1];
    }
  }
  return [s.slice(src, src + i), i];
}

/** UnescapeString unescapes entities like "&lt;" to become "<". */
export function unescapeString(s) {
  const first = s.indexOf('&');
  if (first < 0) return s;
  let out = s.slice(0, first);
  let src = first;
  while (src < s.length) {
    const amp = s[src] === '&' ? src : s.indexOf('&', src);
    if (amp < 0) { out += s.slice(src); break; }
    out += s.slice(src, amp);
    const [r, n] = unescapeEntity(s, amp);
    out += r;
    src = amp + n;
  }
  return out;
}
