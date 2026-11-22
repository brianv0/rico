// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// A small port of Go's fmt.Sprintf (Go 1.24, BSD-3-Clause, Copyright 2009 The Go Authors) for the one place D2 needs it
// with user text as the format: d2compiler's errorf passes messages that already contain user values (a font name, a theme
// key) back through Sprintf, so a stray `%d` in the user's text prints as `%!d(MISSING)`. Supported verbs on string and
// number arguments: %v %s %q %d, the `#` `+` `-` ` ` `0` flags, width and precision; %% and the error forms
// %!verb(MISSING), %!(NOVERB), %!verb(type=value), %!(EXTRA ...). Not modelled: argument indexes (`%[1]d`) and `*` widths
// with arguments (the formats D2 builds never use them; with no arguments `*` prints %!(BADWIDTH)/%!(BADPREC)).

import { quote } from './url.js';

const typeName = (a) => (typeof a === 'string' ? 'string' : typeof a === 'number' ? (Number.isInteger(a) ? 'int' : 'float64') : typeof a === 'boolean' ? 'bool' : 'interface {}');

function pad(s, width, minus, zero) {
  const len = Array.from(s).length;
  if (width <= len) return s;
  const fill = (zero && !minus ? '0' : ' ').repeat(width - len);
  return minus ? s + fill : fill + s;
}

const tooLarge = (x) => x > 1e6 || x < -1e6;

// parsenum converts ASCII to integer: [num, isnum, newi]
function parsenum(s, start, end) {
  if (start >= end) return [0, false, end];
  let num = 0, isnum = false, newi = start;
  for (; newi < end && s[newi] >= '0' && s[newi] <= '9'; newi++) {
    if (tooLarge(num)) return [0, false, end]; // Overflow
    num = num * 10 + Number(s[newi]);
    isnum = true;
  }
  return [num, isnum, newi];
}

// parseArgNumber returns the value of the bracketed number, minus 1: [index, wid, ok]
function parseArgNumber(format, i0) {
  const len = format.length - i0;
  if (len < 3) return [0, 1, false];
  for (let i = 1; i < len; i++) {
    if (format[i0 + i] === ']') {
      const [width, ok, newi] = parsenum(format.slice(i0), 1, i);
      if (!ok || newi !== i) return [0, i + 1, false];
      return [width - 1, i + 1, true];
    }
  }
  return [0, 1, false];
}

/** Sprintf(format, ...args). Arguments: strings, numbers, booleans, or objects with toString(). */
export function sprintf(format, ...args) {
  const f = Array.from(format);
  const end = f.length;
  const p = { out: '', goodArgNum: true, reordered: false };
  let argNum = 0;

  const argNumber = (argNum, i, numArgs) => {
    if (f.length <= i || f[i] !== '[') return [argNum, i, false];
    p.reordered = true;
    const [index, wid, ok] = parseArgNumber(f, i);
    if (ok && index >= 0 && index < numArgs) return [index, i + wid, true];
    p.goodArgNum = false;
    return [argNum, i + wid, ok];
  };
  const intFromArg = (argNum) => {
    let num = 0, isInt = false, newArgNum = argNum;
    if (argNum < args.length) {
      isInt = typeof args[argNum] === 'number' && Number.isInteger(args[argNum]);
      num = isInt ? args[argNum] : 0;
      newArgNum = argNum + 1;
      if (tooLarge(num)) { num = 0; isInt = false; }
    }
    return [num, isInt, newArgNum];
  };

  for (let i = 0; i < end;) {
    p.goodArgNum = true;
    const lasti = i;
    while (i < end && f[i] !== '%') i++;
    if (i > lasti) p.out += f.slice(lasti, i).join('');
    if (i >= end) break;
    i++; // Process one verb

    let sharp = false, plus = false, minus = false, space = false, zero = false;
    let wid = 0, widPresent = false, prec = 0, precPresent = false;
    simpleFormat:
    for (; i < end; i++) {
      switch (f[i]) {
        case '#': sharp = true; break;
        case '0': zero = true; break;
        case '+': plus = true; break;
        case '-': minus = true; break;
        case ' ': space = true; break;
        default: break simpleFormat;
      }
    }

    let afterIndex;
    [argNum, i, afterIndex] = argNumber(argNum, i, args.length);

    if (i < end && f[i] === '*') {
      i++;
      [wid, widPresent, argNum] = intFromArg(argNum);
      if (!widPresent) p.out += '%!(BADWIDTH)';
      if (wid < 0) { wid = -wid; minus = true; zero = false; }
      afterIndex = false;
    } else {
      [wid, widPresent, i] = parsenum(f, i, end);
      if (afterIndex && widPresent) p.goodArgNum = false; // "%[3]2d"
    }

    if (i + 1 < end && f[i] === '.') {
      i++;
      if (afterIndex) p.goodArgNum = false; // "%[3].2d"
      [argNum, i, afterIndex] = argNumber(argNum, i, args.length);
      if (i < end && f[i] === '*') {
        i++;
        [prec, precPresent, argNum] = intFromArg(argNum);
        if (prec < 0) { prec = 0; precPresent = false; }
        if (!precPresent) p.out += '%!(BADPREC)';
        afterIndex = false;
      } else {
        [prec, precPresent, i] = parsenum(f, i, end);
        if (!precPresent) { prec = 0; precPresent = true; }
      }
    }

    if (!afterIndex) [argNum, i, afterIndex] = argNumber(argNum, i, args.length);

    if (i >= end) { p.out += '%!(NOVERB)'; break; }

    const verb = f[i];
    i++;

    if (verb === '%') p.out += '%';
    else if (!p.goodArgNum) p.out += `%!${verb}(BADINDEX)`;
    else if (argNum >= args.length) p.out += `%!${verb}(MISSING)`;
    else {
      p.out += printArg(args[argNum], verb, { sharp, plus, minus, space, zero, wid: widPresent ? wid : -1, prec: precPresent ? prec : -1 });
      argNum++;
    }
  }

  if (!p.reordered && argNum < args.length) {
    p.out += '%!(EXTRA ' + args.slice(argNum).map((a) => `${typeName(a)}=${typeof a === 'string' ? a : String(a)}`).join(', ') + ')';
  }
  return p.out;
}

// printArg formats one argument (strings, integers and booleans; other verbs print the %!verb(type=value) form)
function printArg(arg, verb, fl) {
  const { sharp, plus, minus, space, zero, wid: width, prec } = fl;
  // structs that know how to print themselves (see GoRange)
  if (arg !== null && typeof arg === 'object' && typeof arg.goFormat === 'function') {
    const r = arg.goFormat(verb, fl);
    if (r !== null) return r;
  }
  const str = typeof arg === 'string' ? arg : arg === null || arg === undefined ? '<nil>' : String(arg);
  switch (verb) {
    case 'v':
      if (typeof arg === 'string') {
        let s = sharp ? quote(arg) : arg;
        if (!sharp && prec >= 0) s = Array.from(s).slice(0, prec).join('');
        return pad(s, width, minus, zero);
      }
      return pad(str, width, minus, zero);
    case 's':
      if (typeof arg === 'string' || (arg !== null && typeof arg === 'object')) {
        let s = str;
        if (prec >= 0) s = Array.from(s).slice(0, prec).join('');
        return pad(s, width, minus, zero);
      }
      return `%!s(${typeName(arg)}=${str})`;
    case 'q':
      if (typeof arg === 'string') return pad(quote(prec >= 0 ? Array.from(arg).slice(0, prec).join('') : arg), width, minus, zero);
      return `%!q(${typeName(arg)}=${str})`;
    case 'd':
      if (typeof arg === 'number' && Number.isInteger(arg)) {
        const sign = arg < 0 ? '-' : plus ? '+' : space ? ' ' : '';
        return pad(sign + String(Math.abs(arg)), width, minus, zero);
      }
      return `%!d(${typeName(arg)}=${str})`;
    default:
      return `%!${verb}(${typeName(arg)}=${str})`;
  }
}

/**
 * A d2ast.Range as an argument: `%v`/`%s`/`%q` use its String() (path:line:col), `%d` prints the struct
 * {%!d(string=path) {line col byte} {line col byte}}. Other verbs are not modelled.
 */
export class GoRange {
  constructor(range) { this.range = range; }
  toString() { return this.range.toString(); }
  goFormat(verb, fl) {
    const r = this.range;
    const { minus, zero, wid: width, prec } = fl;
    switch (verb) {
      case 'v': case 's': {
        let s = String(this);
        if (prec >= 0) s = Array.from(s).slice(0, prec).join('');
        return pad(s, width, minus, zero);
      }
      case 'q': return pad(quote(String(this)), width, minus, zero);
      case 'd': {
        const p = (x) => `{${x.line} ${x.column} ${x.byte}}`;
        return `{%!d(string=${r.path}) ${p(r.start)} ${p(r.end)}}`;
      }
    }
    return null;
  }
}
