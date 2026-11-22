// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// JavaScript port of D2's d2renderers/d2svg/theme.go (pruneThemeCSS) and font_corpus.go (github.com/d2lang/d2 v0.9.0,
// Copyright 2022 Terrastruct Inc.): which theme rules and which font characters a rendered SVG fragment needs.
// Both run Go's encoding/xml Decoder over the fragment; xml.js has the port of it.

import { Decoder } from './xml.js';
import { enc, dec } from './url.js';
import { isThemeColor } from './color.js';
import { goTrimSpace } from './gomath.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const lower = (s) => s.toLowerCase();
const equalFold = (a, b) => a.toLowerCase() === b.toLowerCase();
// strings.Fields
const fields = (s) => s.split(/[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/).filter((x) => x !== '');
const NON_ASCII_SPACE = /[\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/;

/** the tokens of a fragment, or null at the first error (decoder.Token() returned an error other than io.EOF) */
function tokenList(source) {
  const d = new Decoder(enc(source));
  const out = [];
  for (;;) {
    const t = d.token();
    if (t === null) {
      // d.err is EOF (the sentinel) for a clean end; a SyntaxError/PlainError otherwise
      if (d.err !== null && (d.err.syntax === true || d.err.syntax === false)) return null;
      return out;
    }
    out.push(t);
  }
}

const PREFIXES = ['fill-', 'stroke-', 'background-color-', 'color-', 'sketch-overlay-'];

function isPaletteClass(cls) {
  for (const prefix of PREFIXES) {
    if (cls.startsWith(prefix)) return isThemeColor(cls.slice(prefix.length));
  }
  return false;
}

/** pruneThemeCSS specializes a complete ThemeCSS stylesheet to the rendered SVG fragments. */
export function pruneThemeCSS(stylesheet, ...sources) {
  return pruneThemeCSSWithClasses(stylesheet, null, ...sources);
}

/** The font scan can supply body classes so only the small background fragments need a second XML pass. */
export function pruneThemeCSSWithClasses(stylesheet, used, ...sources) {
  if (stylesheet === '') return stylesheet;
  // appendix.Append adds this separator after Render, without an inline color.
  // Its text color uses the separate .appendix rule, which is never pruned.
  if (used == null) used = new Set();
  used.add('stroke-B2');
  for (const source of sources) {
    const toks = tokenList(source);
    // Preserve the existing output for custom/malformed SVG fragments.
    if (toks === null) return stylesheet;
    for (const t of toks) {
      if (t.kind !== 'start') continue;
      const local = dec(t.name.local);
      if (equalFold(local, 'script')) return stylesheet;
      for (const attr of t.attrs) {
        // Custom icon SVG can mutate classes at runtime. Keep all rules
        // when scripts, event handlers, or SMIL make class use dynamic.
        const name = lower(dec(attr.name.local));
        const value = dec(attr.value);
        if (name.startsWith('on') || (name === 'attributename' && equalFold(goTrimSpace(value), 'class'))) return stylesheet;
        if (name === 'href') {
          const v = goTrimSpace(value);
          if ((equalFold(local, 'use') && !v.startsWith('#')) || lower(v).startsWith('javascript:')) return stylesheet;
        }
        if (dec(attr.name.local) === 'class') {
          for (const cls of fields(value)) if (isPaletteClass(cls)) used.add(cls);
        }
      }
    }
  }
  return pruneThemeRules(stylesheet, used);
}

/**
 * Scan the simple palette selectors emitted by ThemeCSS, leaving all other rules intact. This recognizes the same
 * grammar as the original regexp, including its ASCII whitespace and class names.
 */
function pruneThemeRules(stylesheet, used) {
  let out = '';
  let copied = 0;
  for (let scan = 0; scan < stylesheet.length;) {
    const rel = stylesheet.indexOf('{', scan);
    if (rel < 0) break;
    const open = rel;
    scan = open + 1;
    const sel = themeRuleSelector(stylesheet, open);
    if (sel === null) continue;
    let [start, cls] = sel;
    let end = -1;
    for (let i = scan; i < stylesheet.length; i++) {
      const c = stylesheet[i];
      if (c === '{' || c === '}') { end = i; break; }
    }
    if (end < 0) break;
    if (stylesheet[end] !== '}') continue;
    scan = end + 1;
    if (!isPaletteClass(cls) || used.has(cls)) continue;
    while (start > copied && themeRuleWhitespace(stylesheet[start - 1])) start--;
    out += stylesheet.slice(copied, start);
    copied = scan;
  }
  if (copied === 0) return stylesheet;
  return out + stylesheet.slice(copied);
}

/** returns [start, class] or null */
function themeRuleSelector(stylesheet, open) {
  let start = open;
  while (start > 0 && themeRuleWord(stylesheet[start - 1])) start--;
  if (start === 0 || stylesheet[start - 1] !== '.') return null;
  const cls = stylesheet.slice(start, open);
  let value = '';
  if (cls.startsWith('sketch-overlay-')) {
    value = cls.slice('sketch-overlay-'.length);
    start--;
  } else {
    for (const prefix of ['fill-', 'stroke-', 'background-color-', 'color-']) {
      if (cls.startsWith(prefix)) {
        value = cls.slice(prefix.length);
        break;
      }
    }
    // The scoped form has exactly one space between its two classes.
    if (start < 3 || stylesheet[start - 2] !== ' ') return null;
    const end = start - 2;
    start = end;
    while (start > 0 && themeRuleWord(stylesheet[start - 1])) start--;
    if (start === end || start === 0 || stylesheet[start - 1] !== '.') return null;
    start--;
  }
  if (value === '') return null;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (!(c >= 'A' && c <= 'Z' || c >= '0' && c <= '9')) return null;
  }
  return [start, cls];
}

const themeRuleWord = (c) => c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c === '_' || c === '-';
const themeRuleWhitespace = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';

// ---- font_corpus.go ----

// This order is the cascade order of the font-family rules in EmbedFonts.
// In particular, matching text-mono-bold must not also match text-mono.
const embeddedFontClasses = ['text', 'text-semibold', 'text-bold', 'text-italic', 'text-mono', 'text-mono-semibold', 'text-mono-bold', 'text-mono-italic'];

/**
 * restrictFontCorpora narrows the freshly collected map in place only when its characters appeared in the legacy corpus.
 * `corpora` is null (keep the legacy source triggers and whole-diagram corpus) or an object class -> rendered characters.
 */
export function restrictFontCorpora(corpora, corpus) {
  if (corpora == null) return null;
  const allowed = new Array(128).fill(false);
  for (let i = 0; i < corpus.length; i++) {
    // Go ranges over the bytes of the UTF-8 corpus: any non-ASCII character has bytes >= 128
    const c = corpus.charCodeAt(i);
    if (c >= 128 || c === 127 || (c < 32 && c !== 10)) return null;
    allowed[c] = true;
  }
  for (const cls of Object.keys(corpora)) {
    for (const ch of corpora[cls]) {
      const r = ch.codePointAt(0);
      if (r >= 128 || !allowed[r]) {
        corpora[cls] = corpus;
        break;
      }
    }
  }
  return corpora;
}

/**
 * collectFontCorporaAndClasses is for the body fragment produced by Render, before its stylesheets are added. It follows
 * SVG text inheritance, including native Markdown runs and syntax-highlighted tspans. Returns [corpora, classes, ok];
 * `classes` (a Set) is non-null when the complete fragment passed the theme parser's safety checks.
 */
export function collectFontCorporaAndClasses(source) {
  const wrapped = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">' + source + '</svg>';
  const toks = tokenList(wrapped);
  if (toks === null) return [null, null, false];
  let stack = [{ font: -1, text: false, ignore: false }];
  const corpora = embeddedFontClasses.map(() => '');
  const classes = new Set();
  let classesSafe = true;
  for (const t of toks) {
    if (t.kind === 'start') {
      const local = dec(t.name.local);
      if (equalFold(local, 'script')) classesSafe = false;
      if (t.name.space !== '' && t.name.space !== SVG_NS) return [null, null, false];
      const current = { ...stack[stack.length - 1] };
      switch (local) {
        case 'style': case 'script': case 'foreignObject': case 'use': case 'tref': case 'textPath':
        case 'animate': case 'animateMotion': case 'animateTransform': case 'set':
          return [null, null, false];
        case 'title': case 'desc': case 'metadata':
          current.ignore = true;
          break;
        case 'text':
          current.text = true;
          break;
        case 'tspan': case 'a':
          break;
        default:
          if (current.text && !current.ignore) return [null, null, false];
      }

      // A class on the child overrides an inherited family, even if the
      // parent's class occurs later in the stylesheet. Only classes on
      // the same element compete according to stylesheet order.
      let localFont = -1;
      let classSeen = false;
      for (const attr of t.attrs) {
        // Match pruneThemeCSS's guards independently of the stricter
        // font guards, so neither specialization changes the other.
        const aname = dec(attr.name.local);
        const name = lower(aname);
        const value = dec(attr.value);
        if (name.startsWith('on') || (name === 'attributename' && equalFold(goTrimSpace(value), 'class'))) classesSafe = false;
        if (name === 'href') {
          const v = goTrimSpace(value);
          if ((equalFold(local, 'use') && !v.startsWith('#')) || lower(v).startsWith('javascript:')) classesSafe = false;
        }
        if (aname.startsWith('font-variant')) return [null, null, false];
        switch (aname) {
          case 'class': {
            if (attr.name.space !== '' || classSeen) return [null, null, false];
            classSeen = true;
            // The separate theme parser uses strings.Fields, which also splits Unicode whitespace.
            // Preserve that path for custom classes with different tokenization.
            if (NON_ASCII_SPACE.test(value)) classesSafe = false;
            for (const cls of value.split(/[ \t\n\r\f]+/)) {
              if (cls === '') continue;
              if (isPaletteClass(cls)) classes.add(cls);
              for (let i = 0; i < embeddedFontClasses.length; i++) {
                if (cls === embeddedFontClasses[i] && i > localFont) localFont = i;
              }
            }
            break;
          }
          case 'font-family': case 'text-transform': case 'direction': case 'unicode-bidi':
            return [null, null, false];
          case 'style':
            if (attr.name.space !== '' || !fontCorpusStyleSafe(value)) return [null, null, false];
            break;
          default:
            if (aname.startsWith('on')) return [null, null, false];
        }
      }
      if (localFont >= 0) current.font = localFont;
      stack.push(current);
    } else if (t.kind === 'end') {
      if (stack.length === 1) return [null, null, false];
      stack = stack.slice(0, -1);
    } else if (t.sub === 'chardata') {
      const current = stack[stack.length - 1];
      if (current.text && !current.ignore && t.data.length !== 0) {
        if (current.font < 0) return [null, null, false];
        // Keep whitespace too: code uses nonbreaking spaces, and text
        // layout can preserve ordinary spaces with xml:space.
        corpora[current.font] += dec(t.data);
      }
    } else if (t.sub === 'directive' || t.sub === 'procinst') {
      return [null, null, false];
    }
  }
  if (stack.length !== 1) return [null, null, false];
  const result = {};
  for (let i = 0; i < corpora.length; i++) {
    if (corpora[i].length !== 0) result[embeddedFontClasses[i]] = corpora[i];
  }
  // The legacy regular-face trigger is narrower than CSS class matching.
  // Customized SVG fragments may use another class first, or single quotes;
  // do not introduce a regular-family rule that the old output lacked.
  if (Object.prototype.hasOwnProperty.call(result, 'text') &&
    !source.includes('class="text"') && !source.includes('class="text ') &&
    !source.includes('class="md"') && !source.includes('class="md ')) return [null, null, false];
  return [result, classesSafe ? classes : null, true];
}

/**
 * Generated inline styles use simple declarations. Reject CSS syntax that could disguise a font-family override or change
 * the rendered characters. Font weight/style alone synthesize against the selected family.
 */
function fontCorpusStyleSafe(style) {
  if (/[\\/{}]/.test(style)) return false;
  for (const declaration of style.split(';')) {
    if (goTrimSpace(declaration) === '') continue;
    const colon = declaration.indexOf(':');
    if (colon < 0) return false;
    const property = lower(goTrimSpace(declaration.slice(0, colon)));
    if (property.startsWith('font-variant')) return false;
    switch (property) {
      case 'font': case 'font-family': case 'text-transform': case 'direction': case 'unicode-bidi': case 'all': case 'content':
        return false;
    }
  }
  return true;
}
