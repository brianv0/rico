// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of the part of Go's encoding/xml (Go 1.24, BSD-3-Clause, Copyright 2009 The Go Authors) that
// d2compiler runs on rendered Markdown: `xml.Unmarshal([]byte(rendered), &v)` into an interface{}, which reads the first
// element with Decoder.Skip and so enforces the whole of Decoder.Token's strict syntax and element matching
// for that element. Nothing is built from the tokens; only the error (if any) is reported.
//
// The decoder works on bytes: the input is a JS string, converted to a UTF-8 "binary string" (one char per byte) first.

import { enc, dec, quote } from './url.js';

// unicode.RangeTables `first` and `second` of xml.go ([lo, hi, stride] triples), for (Letter | '_' | ':') and NameChar.
const FIRST = [58,58,1,65,90,1,95,95,1,97,122,1,192,214,1,216,246,1,248,255,1,256,305,1,308,318,1,321,328,1,330,382,1,384,451,1,461,496,1,500,501,1,506,535,1,592,680,1,699,705,1,902,902,1,904,906,1,908,908,1,910,929,1,931,974,1,976,982,1,986,992,2,994,1011,1,1025,1036,1,1038,1103,1,1105,1116,1,1118,1153,1,1168,1220,1,1223,1224,1,1227,1228,1,1232,1259,1,1262,1269,1,1272,1273,1,1329,1366,1,1369,1369,1,1377,1414,1,1488,1514,1,1520,1522,1,1569,1594,1,1601,1610,1,1649,1719,1,1722,1726,1,1728,1742,1,1744,1747,1,1749,1749,1,1765,1766,1,2309,2361,1,2365,2365,1,2392,2401,1,2437,2444,1,2447,2448,1,2451,2472,1,2474,2480,1,2482,2482,1,2486,2489,1,2524,2525,1,2527,2529,1,2544,2545,1,2565,2570,1,2575,2576,1,2579,2600,1,2602,2608,1,2610,2611,1,2613,2614,1,2616,2617,1,2649,2652,1,2654,2654,1,2674,2676,1,2693,2699,1,2701,2701,1,2703,2705,1,2707,2728,1,2730,2736,1,2738,2739,1,2741,2745,1,2749,2784,35,2821,2828,1,2831,2832,1,2835,2856,1,2858,2864,1,2866,2867,1,2870,2873,1,2877,2877,1,2908,2909,1,2911,2913,1,2949,2954,1,2958,2960,1,2962,2965,1,2969,2970,1,2972,2972,1,2974,2975,1,2979,2980,1,2984,2986,1,2990,2997,1,2999,3001,1,3077,3084,1,3086,3088,1,3090,3112,1,3114,3123,1,3125,3129,1,3168,3169,1,3205,3212,1,3214,3216,1,3218,3240,1,3242,3251,1,3253,3257,1,3294,3294,1,3296,3297,1,3333,3340,1,3342,3344,1,3346,3368,1,3370,3385,1,3424,3425,1,3585,3630,1,3632,3632,1,3634,3635,1,3648,3653,1,3713,3714,1,3716,3716,1,3719,3720,1,3722,3725,3,3732,3735,1,3737,3743,1,3745,3747,1,3749,3751,2,3754,3755,1,3757,3758,1,3760,3760,1,3762,3763,1,3773,3773,1,3776,3780,1,3904,3911,1,3913,3945,1,4256,4293,1,4304,4342,1,4352,4352,1,4354,4355,1,4357,4359,1,4361,4361,1,4363,4364,1,4366,4370,1,4412,4416,2,4428,4432,2,4436,4437,1,4441,4441,1,4447,4449,1,4451,4457,2,4461,4462,1,4466,4467,1,4469,4510,41,4520,4523,3,4526,4527,1,4535,4536,1,4538,4538,1,4540,4546,1,4587,4592,5,4601,4601,1,7680,7835,1,7840,7929,1,7936,7957,1,7960,7965,1,7968,8005,1,8008,8013,1,8016,8023,1,8025,8027,2,8029,8029,1,8031,8061,1,8064,8116,1,8118,8124,1,8126,8126,1,8130,8132,1,8134,8140,1,8144,8147,1,8150,8155,1,8160,8172,1,8178,8180,1,8182,8188,1,8486,8486,1,8490,8491,1,8494,8494,1,8576,8578,1,12295,12295,1,12321,12329,1,12353,12436,1,12449,12538,1,12549,12588,1,19968,40869,1,44032,55203,1];
const SECOND = [45,46,1,48,57,1,183,183,1,720,721,1,768,837,1,864,865,1,903,903,1,1155,1158,1,1425,1441,1,1443,1465,1,1467,1469,1,1471,1471,1,1473,1474,1,1476,1600,124,1611,1618,1,1632,1641,1,1648,1648,1,1750,1756,1,1757,1759,1,1760,1764,1,1767,1768,1,1770,1773,1,1776,1785,1,2305,2307,1,2364,2364,1,2366,2380,1,2381,2381,1,2385,2388,1,2402,2403,1,2406,2415,1,2433,2435,1,2492,2492,1,2494,2495,1,2496,2500,1,2503,2504,1,2507,2509,1,2519,2519,1,2530,2531,1,2534,2543,1,2562,2620,58,2622,2623,1,2624,2626,1,2631,2632,1,2635,2637,1,2662,2671,1,2672,2673,1,2689,2691,1,2748,2748,1,2750,2757,1,2759,2761,1,2763,2765,1,2790,2799,1,2817,2819,1,2876,2876,1,2878,2883,1,2887,2888,1,2891,2893,1,2902,2903,1,2918,2927,1,2946,2947,1,3006,3010,1,3014,3016,1,3018,3021,1,3031,3031,1,3047,3055,1,3073,3075,1,3134,3140,1,3142,3144,1,3146,3149,1,3157,3158,1,3174,3183,1,3202,3203,1,3262,3268,1,3270,3272,1,3274,3277,1,3285,3286,1,3302,3311,1,3330,3331,1,3390,3395,1,3398,3400,1,3402,3405,1,3415,3415,1,3430,3439,1,3633,3633,1,3636,3642,1,3654,3654,1,3655,3662,1,3664,3673,1,3761,3761,1,3764,3769,1,3771,3772,1,3782,3782,1,3784,3789,1,3792,3801,1,3864,3865,1,3872,3881,1,3893,3897,2,3902,3903,1,3953,3972,1,3974,3979,1,3984,3989,1,3991,3991,1,3993,4013,1,4017,4023,1,4025,4025,1,8400,8412,1,8417,12293,3876,12330,12335,1,12337,12341,1,12441,12442,1,12445,12446,1,12540,12542,1];

function inTable(t, r) {
  for (let i = 0; i < t.length; i += 3) {
    if (r < t[i]) return false;
    if (r <= t[i + 1]) return t[i + 2] === 1 || (r - t[i]) % t[i + 2] === 0;
  }
  return false;
}

/** utf8.DecodeRune on a binary string at i: [rune, size]; invalid is [0xFFFD, 1]. */
function decodeRune(b, i) {
  const c = b.charCodeAt(i);
  if (c < 0x80) return [c, 1];
  let need = 0, min = 0, cp = 0;
  if (c >= 0xc2 && c <= 0xdf) { need = 1; min = 0x80; cp = c & 0x1f; }
  else if (c >= 0xe0 && c <= 0xef) { need = 2; min = 0x800; cp = c & 0x0f; }
  else if (c >= 0xf0 && c <= 0xf4) { need = 3; min = 0x10000; cp = c & 0x07; }
  else return [0xFFFD, 1];
  if (i + need >= b.length) return [0xFFFD, 1];
  for (let k = 1; k <= need; k++) {
    const cc = b.charCodeAt(i + k);
    if ((cc & 0xc0) !== 0x80) return [0xFFFD, 1];
    cp = (cp << 6) | (cc & 0x3f);
  }
  if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp < 0xe000)) return [0xFFFD, 1];
  return [cp, need + 1];
}

const isInCharacterRange = (r) => r === 0x09 || r === 0x0A || r === 0x0D || (r >= 0x20 && r <= 0xD7FF) || (r >= 0xE000 && r <= 0xFFFD) || (r >= 0x10000 && r <= 0x10FFFF);

function isNameByte(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 58 || c === 46 || c === 45;
}

function isName(s) {
  if (s.length === 0) return false;
  let [c, n] = decodeRune(s, 0);
  if (c === 0xFFFD && n === 1) return false;
  if (!inTable(FIRST, c)) return false;
  let i = n;
  while (i < s.length) {
    [c, n] = decodeRune(s, i);
    i += n;
    if (c === 0xFFFD && n === 1) return false;
    if (!inTable(FIRST, c) && !inTable(SECOND, c)) return false;
  }
  return true;
}

const EOF = Symbol('EOF');
const entity = { lt: '<', gt: '>', amp: '&', apos: "'", quot: '"' };

/** A SyntaxError: msg is Go's Msg. */
class SyntaxError_ {
  constructor(msg) { this.msg = msg; this.syntax = true; }
}
class PlainError {
  constructor(msg) { this.msg = msg; this.syntax = false; }
}

class Decoder {
  constructor(data) {
    this.data = data; // binary string
    this.pos = 0;
    this.buf = '';
    this.stk = []; // open elements: {local, space}
    this.needClose = false;
    this.toClose = null;
    this.nextByte = -1;
    this.err = null;
  }

  syntaxError(msg) { return new SyntaxError_(msg); }

  // getc reads a single byte; on EOF returns -1 and leaves EOF in this.err.
  getc() {
    if (this.err !== null) return -1;
    let b;
    if (this.nextByte >= 0) { b = this.nextByte; this.nextByte = -1; }
    else {
      if (this.pos >= this.data.length) { this.err = EOF; return -1; }
      b = this.data.charCodeAt(this.pos++);
    }
    return b;
  }
  ungetc(b) { this.nextByte = b; }
  mustgetc() {
    const b = this.getc();
    if (b < 0 && this.err === EOF) this.err = this.syntaxError('unexpected EOF');
    return b;
  }

  space() {
    for (;;) {
      const b = this.getc();
      if (b < 0) return;
      if (b === 32 || b === 13 || b === 10 || b === 9) continue;
      this.ungetc(b);
      return;
    }
  }

  // readName appends a name to this.buf; false if there is none (or on error, with this.err set).
  readName() {
    let b = this.mustgetc();
    if (b < 0) return false;
    if (b < 0x80 && !isNameByte(b)) { this.ungetc(b); return false; }
    this.buf += String.fromCharCode(b);
    for (;;) {
      b = this.mustgetc();
      if (b < 0) return false;
      if (b < 0x80 && !isNameByte(b)) { this.ungetc(b); break; }
      this.buf += String.fromCharCode(b);
    }
    return true;
  }

  name() {
    this.buf = '';
    if (!this.readName()) return null;
    const b = this.buf;
    if (!isName(b)) { this.err = this.syntaxError('invalid XML name: ' + dec(b)); return null; }
    return b;
  }

  nsname() {
    const s = this.name();
    if (s === null) return null;
    if (s.split(':').length - 1 > 1) return null;
    const i = s.indexOf(':');
    if (i < 0 || i === 0 || i === s.length - 1) return { space: '', local: s };
    return { space: s.slice(0, i), local: s.slice(i + 1) };
  }

  // text reads a plain text section; quote >= 0 means a quoted attribute value. Returns null on failure (error in this.err).
  text(quote, cdata) {
    let b0 = 0, b1 = 0, trunc = 0;
    this.buf = '';
    Input:
    for (;;) {
      let b = this.getc();
      if (b < 0) {
        if (cdata) {
          if (this.err === EOF) this.err = this.syntaxError('unexpected EOF in CDATA section');
          return null;
        }
        break Input;
      }

      if (quote < 0 && b0 === 93 && b1 === 93 && b === 62) {
        if (cdata) { trunc = 2; break Input; }
        this.err = this.syntaxError('unescaped ]]> not in CDATA section');
        return null;
      }

      if (b === 60 && !cdata) {
        if (quote >= 0) { this.err = this.syntaxError('unescaped < inside quoted string'); return null; }
        this.ungetc(60);
        break Input;
      }
      if (quote >= 0 && b === quote) break Input;
      if (b === 38 && !cdata) {
        const before = this.buf.length;
        this.buf += '&';
        let text = '';
        let haveText = false;
        b = this.mustgetc();
        if (b < 0) return null;
        if (b === 35) {
          this.buf += '#';
          b = this.mustgetc();
          if (b < 0) return null;
          let base = 10;
          if (b === 120) {
            base = 16;
            this.buf += 'x';
            b = this.mustgetc();
            if (b < 0) return null;
          }
          const start = this.buf.length;
          while ((b >= 48 && b <= 57) || (base === 16 && b >= 97 && b <= 102) || (base === 16 && b >= 65 && b <= 70)) {
            this.buf += String.fromCharCode(b);
            b = this.mustgetc();
            if (b < 0) return null;
          }
          if (b !== 59) this.ungetc(b);
          else {
            const s = this.buf.slice(start);
            this.buf += ';';
            // strconv.ParseUint(s, base, 64): fails for "" and for values over 2^64-1
            if (s !== '') {
              const n = BigInt((base === 16 ? '0x' : '') + s);
              if (n <= 0xFFFFFFFFFFFFFFFFn && n <= 0x10FFFFn) {
                const r = Number(n);
                text = enc(r >= 0xD800 && r <= 0xDFFF ? '�' : String.fromCodePoint(r));
                haveText = true;
              }
            }
          }
        } else {
          this.ungetc(b);
          if (!this.readName()) {
            if (this.err !== null) return null;
          }
          b = this.mustgetc();
          if (b < 0) return null;
          if (b !== 59) this.ungetc(b);
          else {
            const name = this.buf.slice(before + 1);
            this.buf += ';';
            if (isName(name)) {
              if (Object.prototype.hasOwnProperty.call(entity, name)) { text = entity[name]; haveText = true; }
            }
          }
        }

        if (haveText) {
          this.buf = this.buf.slice(0, before) + text;
          b0 = 0; b1 = 0;
          continue Input;
        }
        let ent = this.buf.slice(before);
        if (ent[ent.length - 1] !== ';') ent += ' (no semicolon)';
        this.err = this.syntaxError('invalid character entity ' + dec(ent));
        return null;
      }

      // We must rewrite unescaped \r and \r\n into \n.
      if (b === 13) this.buf += '\n';
      else if (b1 === 13 && b === 10) { /* Skip \r\n--we already wrote \n. */ }
      else this.buf += String.fromCharCode(b);

      b0 = b1; b1 = b;
    }
    const data = this.buf.slice(0, this.buf.length - trunc);

    // Inspect each rune for being a disallowed character.
    for (let i = 0; i < data.length;) {
      const [r, size] = decodeRune(data, i);
      if (r === 0xFFFD && size === 1) { this.err = this.syntaxError('invalid UTF-8'); return null; }
      i += size;
      if (!isInCharacterRange(r)) { this.err = this.syntaxError('illegal character code U+' + r.toString(16).toUpperCase().padStart(4, '0')); return null; }
    }
    return data;
  }

  attrval() {
    const b = this.mustgetc();
    if (b < 0) return null;
    if (b === 34 || b === 39) return this.text(b, false);
    // Strict: unquoted attribute values are an error.
    this.err = this.syntaxError('unquoted or missing attribute value in element');
    return null;
  }

  // rawToken returns {kind: 'start'|'end'|'other', name} or null with this.err set.
  rawToken() {
    if (this.err !== null) return null;
    if (this.needClose) {
      this.needClose = false;
      return { kind: 'end', name: this.toClose };
    }

    let b = this.getc();
    if (b < 0) return null;

    if (b !== 60) {
      // Text section.
      this.ungetc(b);
      const data = this.text(-1, false);
      if (data === null) return null;
      return { kind: 'other' };
    }

    b = this.mustgetc();
    if (b < 0) return null;
    switch (b) {
      case 47: { // </: End element
        const name = this.nsname();
        if (name === null) {
          if (this.err === null) this.err = this.syntaxError('expected element name after </');
          return null;
        }
        this.space();
        b = this.mustgetc();
        if (b < 0) return null;
        if (b !== 62) { this.err = this.syntaxError('invalid characters between </' + dec(name.local) + ' and >'); return null; }
        return { kind: 'end', name };
      }

      case 63: { // <?: Processing instruction.
        const target = this.name();
        if (target === null) {
          if (this.err === null) this.err = this.syntaxError('expected target name after <?');
          return null;
        }
        this.space();
        this.buf = '';
        let b0 = 0;
        for (;;) {
          b = this.mustgetc();
          if (b < 0) return null;
          this.buf += String.fromCharCode(b);
          if (b0 === 63 && b === 62) break;
          b0 = b;
        }
        const data = this.buf.slice(0, this.buf.length - 2); // chop ?>

        if (target === 'xml') {
          const content = data;
          const ver = procInst('version', content);
          if (ver !== '' && ver !== '1.0') { this.err = new PlainError(`xml: unsupported version ${quoteBin(ver)}; only version 1.0 is supported`); return null; }
          const encoding = procInst('encoding', content);
          if (encoding !== '' && encoding !== 'utf-8' && encoding !== 'UTF-8' && encoding.toLowerCase() !== 'utf-8') {
            // d.CharsetReader is nil
            this.err = new PlainError(`xml: encoding ${quoteBin(encoding)} declared but Decoder.CharsetReader is nil`);
            return null;
          }
        }
        return { kind: 'other' };
      }

      case 33: { // <!: Maybe comment, maybe CDATA.
        b = this.mustgetc();
        if (b < 0) return null;
        switch (b) {
          case 45: { // <!-
            b = this.mustgetc();
            if (b < 0) return null;
            if (b !== 45) { this.err = this.syntaxError('invalid sequence <!- not part of <!--'); return null; }
            // Look for terminator.
            let b0 = 0, b1 = 0;
            for (;;) {
              b = this.mustgetc();
              if (b < 0) return null;
              if (b0 === 45 && b1 === 45) {
                if (b !== 62) { this.err = this.syntaxError('invalid sequence "--" not allowed in comments'); return null; }
                break;
              }
              b0 = b1; b1 = b;
            }
            return { kind: 'other' };
          }
          case 91: { // <![
            for (let i = 0; i < 6; i++) {
              b = this.mustgetc();
              if (b < 0) return null;
              if (b !== 'CDATA['.charCodeAt(i)) { this.err = this.syntaxError('invalid <![ sequence'); return null; }
            }
            const data = this.text(-1, true);
            if (data === null) return null;
            return { kind: 'other' };
          }
        }

        // Probably a directive: <!DOCTYPE ...>, <!ENTITY ...>, etc. Quoted angle brackets do not count for nesting.
        let inquote = 0;
        let depth = 0;
        for (;;) {
          b = this.mustgetc();
          if (b < 0) return null;
          if (inquote === 0 && b === 62 && depth === 0) break;
          // HandleB:
          for (;;) {
            if (b === inquote) inquote = 0;
            else if (inquote !== 0) { /* in quotes, no special action */ }
            else if (b === 39 || b === 34) inquote = b;
            else if (b === 62 && inquote === 0) depth--;
            else if (b === 60 && inquote === 0) {
              // Look for <!-- to begin comment.
              const s = '!--';
              let again = false;
              for (let i = 0; i < s.length; i++) {
                b = this.mustgetc();
                if (b < 0) return null;
                if (b !== s.charCodeAt(i)) { depth++; again = true; break; }
              }
              if (again) continue; // goto HandleB with the new b
              // Look for terminator.
              let b0 = 0, b1 = 0;
              for (;;) {
                b = this.mustgetc();
                if (b < 0) return null;
                if (b0 === 45 && b1 === 45 && b === 62) break;
                b0 = b1; b1 = b;
              }
            }
            break;
          }
        }
        return { kind: 'other' };
      }
    }

    // Must be an open element like <a href="foo">
    this.ungetc(b);

    const name = this.nsname();
    if (name === null) {
      if (this.err === null) this.err = this.syntaxError('expected element name after <');
      return null;
    }

    let empty = false;
    for (;;) {
      this.space();
      b = this.mustgetc();
      if (b < 0) return null;
      if (b === 47) {
        empty = true;
        b = this.mustgetc();
        if (b < 0) return null;
        if (b !== 62) { this.err = this.syntaxError('expected /> in element'); return null; }
        break;
      }
      if (b === 62) break;
      this.ungetc(b);

      const an = this.nsname();
      if (an === null) {
        if (this.err === null) this.err = this.syntaxError('expected attribute name in element');
        return null;
      }
      this.space();
      b = this.mustgetc();
      if (b < 0) return null;
      if (b !== 61) { this.err = this.syntaxError('attribute name without = in element'); return null; }
      this.space();
      const data = this.attrval();
      if (data === null) return null;
    }
    if (empty) { this.needClose = true; this.toClose = name; }
    return { kind: 'start', name };
  }

  // token returns the next significant token ({kind, name}) or null; the error is in this.err.
  token() {
    const t = this.rawToken();
    if (t === null) {
      if (this.err === EOF && this.stk.length > 0) this.err = this.syntaxError('unexpected EOF');
      return null;
    }
    if (t.kind === 'start') this.stk.push(t.name);
    else if (t.kind === 'end') {
      const s = this.stk.pop();
      const name = t.name;
      if (s === undefined) { this.err = this.syntaxError('unexpected end element </' + dec(name.local) + '>'); return null; }
      if (s.local !== name.local) { this.err = this.syntaxError('element <' + dec(s.local) + '> closed by </' + dec(name.local) + '>'); return null; }
      if (s.space !== name.space) {
        const ns = name.space === '' ? '""' : dec(name.space);
        this.err = this.syntaxError('element <' + dec(s.local) + '> in space ' + dec(s.space) + ' closed by </' + dec(name.local) + '> in space ' + ns);
        return null;
      }
    }
    return t;
  }

  // Skip reads tokens until the end of the element whose start has been read.
  skip() {
    let depth = 0;
    for (;;) {
      const t = this.token();
      if (t === null) return this.err;
      if (t.kind === 'start') depth++;
      else if (t.kind === 'end') {
        if (depth === 0) return null;
        depth--;
      }
    }
  }
}

// procInst parses the version in an XML processing instruction ("<?xml version="1.0" ?>").
function procInst(param, s) {
  // TODO: this parsing is somewhat lame and not exact.
  // It works for all actual cases, though.
  param = param + '=';
  let idx = s.indexOf(param);
  if (idx === -1) return '';
  s = s.slice(idx + param.length);
  if (s === '') return '';
  const v = s[0];
  if (v !== "'" && v !== '"') return '';
  idx = s.slice(1).indexOf(v);
  if (idx === -1) return '';
  return s.slice(1).slice(0, idx);
}

const quoteBin = (s) => quote(dec(s));

/**
 * xml.Unmarshal(data, &v) with v an interface{}: reads to the first start element and skips it.
 * @returns {null | {msg: string, syntax: boolean}} the error, as Go's SyntaxError.Msg or err.Error()
 */
export function unmarshalInterface(data) {
  const d = new Decoder(enc(data));
  // d.unmarshal: find the start element
  for (;;) {
    const t = d.token();
    if (t === null) return errResult(d.err);
    if (t.kind === 'start') break;
  }
  const err = d.skip();
  return err === null ? null : errResult(err);
}

function errResult(err) {
  if (err === EOF) return { msg: 'EOF', syntax: false };
  if (err.syntax) return { msg: err.msg, syntax: true };
  return { msg: err.msg, syntax: false };
}
