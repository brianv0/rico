// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// The syntax highlighting of code labels (`shape: code`, `|python ... |` blocks), a port of the parts of chroma v2.27.0
// (github.com/alecthomas/chroma, MIT, Copyright (C) 2017 Alec Thomas) that d2svg/code.go and d2svg.go use: the RegexLexer engine
// (regexp.go, mutators.go, emitters.go), lexers.Get / the fallback lexer, SplitTokensIntoLines, and the two styles ("github" and
// "catppuccin-mocha") reduced to what StyleEntryToSVG prints per token type.
//
// The lexers themselves are chroma's own definitions, exported by tools/d2ref `chromadump` (+ genlexers.mjs) as one JSON file each
// under public/d2/lexers/ and loaded on demand: python, go, bash/sh, javascript/js, typescript/ts, json, yaml (and the Go text
// template lexer that the Go lexer embeds). Every other language is `Deferred` (chroma has about 280; see lexers/index.json for the
// names). chroma matches with regexp2 (.NET syntax): the patterns are translated to JavaScript regular expressions, which is exact
// for ASCII text, so a code label with any other character is `Deferred` too.

import { Deferred, NeedAsset } from './d2svg.js';

const FILES_BASE = new URL('./lexers/', import.meta.url);

async function readJSON(file) {
  const u = new URL(file, FILES_BASE);
  if (typeof process !== 'undefined' && process.versions?.node && u.protocol === 'file:') {
    const fs = await import('node:fs/promises');
    return JSON.parse(await fs.readFile(u, 'utf8'));
  }
  const res = await fetch(u);
  if (!res.ok) throw new Error(`d2svg: cannot load ${u}: ${res.status}`);
  return res.json();
}

/** lexers/index.json: {files, names, types, styles} */
export const index = await readJSON('index.json');

const compiled = new Map(); // lexer name -> compiled lexer

/** Loads a lexer file (and the lexers it uses). */
export async function loadLexer(file) {
  const lexer = await readJSON(file);
  if (compiled.has(lexer.name)) return;
  compiled.set(lexer.name, compile(lexer));
  for (const dep of dependencies(lexer)) {
    const name = resolveName(dep);
    if (name !== undefined && index.files[name] !== undefined && !compiled.has(name)) await loadLexer(index.files[name]);
  }
}

function dependencies(lexer) {
  const out = new Set();
  const walk = (e) => {
    if (!e) return;
    if (e[0] === 'u') out.add(e[1]);
    if (e[0] === 'g') e[1].forEach(walk);
  };
  for (const rules of Object.values(lexer.rules)) for (const [, em] of rules) walk(em);
  return out;
}

const resolveName = (language) => index.names[language] ?? index.names[language.toLowerCase()];

// ---- regexp2 (.NET) -> JavaScript ----

class Unsupported extends Error {}

/** translates one rule pattern; returns a sticky RegExp. Exact for ASCII input (see the file header). */
function translate(pattern, lexer) {
  let flags = 'y';
  let multiline = !lexer.nm;
  let ignoreCase = !!lexer.i;
  let dotAll = !!lexer.s;
  // leading inline flag groups, e.g. (?s)(?i)
  for (;;) {
    const m = /^\(\?([imsn]+)\)/.exec(pattern);
    if (!m) break;
    for (const f of m[1]) {
      if (f === 'i') ignoreCase = true;
      else if (f === 's') dotAll = true;
      else if (f === 'm') multiline = true;
    }
    pattern = pattern.slice(m[0].length);
  }
  let out = '';
  let inClass = false;
  let classStart = 0, classOut = 0;
  let shorthands = ''; // the \w \W \d \D \s \S escapes of the current character class
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\') {
      const n = pattern[i + 1];
      if (inClass && n !== undefined && 'wWdDsS'.includes(n)) shorthands += n;
      if (n === 'p' || n === 'P') {
        // \p{L} and \p{N} on ASCII input
        const m = /^\\([pP])\{(L|N)\}/.exec(pattern.slice(i));
        if (!m) throw new Unsupported('\\p');
        const set = m[2] === 'L' ? 'A-Za-z' : '0-9';
        if (inClass) {
          if (m[1] === 'P') throw new Unsupported('\\P in class');
          out += set;
        } else out += (m[1] === 'P' ? '[^' : '[') + set + ']';
        i += m[0].length - 1;
        continue;
      }
      if (!inClass && n === 'A') { out += '(?<![\\s\\S])'; i++; continue; }
      if (!inClass && (n === 'Z' || n === 'z' || n === 'G')) throw new Unsupported('\\' + n);
      out += c + (n ?? '');
      i++;
      continue;
    }
    if (inClass) {
      if (c === ']') {
        inClass = false;
        // regexp2 does not combine several shorthand escapes of which one is negated the way JavaScript does (for example [^\W\d]
        // matches digits): the generator stored the ASCII set regexp2 matches for such a class
        if (shorthands.length >= 2 && /[WDS]/.test(shorthands)) {
          const cls = pattern.slice(classStart, i + 1);
          const set = lexer.cls?.[cls];
          if (set === undefined) throw new Unsupported('class with several shorthand escapes');
          out = out.slice(0, classOut) + set;
          continue;
        }
      }
      out += c;
      continue;
    }
    if (c === '[') {
      inClass = true;
      shorthands = '';
      classStart = i;
      classOut = out.length;
      out += c;
      if (pattern[i + 1] === '^') { out += '^'; i++; }
      // a ] right after [ or [^ is a literal in .NET; in JavaScript it would close the (empty) class
      if (pattern[i + 1] === ']') { out += '\\]'; i++; }
      continue;
    }
    if (c === '.') { out += dotAll ? '[\\s\\S]' : '[^\\n]'; continue; }
    if (c === '$') { out += multiline ? '(?=\\n|(?![\\s\\S]))' : '(?=\\n?$)'; continue; }
    if (c === '(' && pattern[i + 1] === '?' && /^\(\?(P?<[A-Za-z]|[imsn-]+[:)])/.test(pattern.slice(i))) throw new Unsupported('group syntax');
    out += c;
  }
  if (ignoreCase) flags += 'i';
  // multiline only matters for ^ ($ is rewritten above)
  if (multiline) flags += 'm';
  try {
    return new RegExp(out, flags);
  } catch (e) {
    throw new Unsupported(`pattern ${pattern}: ${e.message}`);
  }
}

// ---- RegexLexer ----

function compile(lexer) {
  const rules = {};
  for (const [state, list] of Object.entries(lexer.rules)) {
    rules[state] = list.map(([pattern, emitter, mutator]) => ({ pattern, re: null, emitter, mutator, lexer }));
  }
  // expand include and combined mutators (chroma's MutateLexer pass), depth first
  const expanded = {};
  const expanding = new Set();
  const expand = (state) => {
    if (expanded[state]) return expanded[state];
    if (expanding.has(state)) throw new Error(`include cycle at ${state}`);
    expanding.add(state);
    const list = [];
    for (const rule of rules[state] ?? (() => { throw new Error(`invalid include state ${state}`); })()) {
      const m = rule.mutator;
      if (m && m[0] === 'inc') list.push(...expand(m[1]));
      else if (m && m[0] === 'comb') {
        const name = '__combined_' + m.slice(1).join('__');
        if (!expanded[name]) {
          const combined = [];
          for (const s of m.slice(1)) combined.push(...expand(s));
          expanded[name] = combined;
        }
        list.push({ ...rule, mutator: ['push', name] });
      } else list.push(rule);
    }
    expanding.delete(state);
    expanded[state] = list;
    return list;
  };
  for (const state of Object.keys(rules)) expand(state);
  return { name: lexer.name, ensureNL: !!lexer.nl, rules: expanded, source: lexer };
}

const fallbackLexer = compile({
  name: 'fallback',
  rules: { root: [['.+', ['t', 'Text'], 0], ['\\n', ['t', 'Text'], 0]] },
});

function matchRules(lexer, text, pos, rules) {
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];
    if (rule.re === null) rule.re = translate(rule.pattern, rule.lexer);
    rule.re.lastIndex = pos;
    const m = rule.re.exec(text);
    if (m !== null && m.index === pos) {
      return { rule, groups: Array.from(m, (g) => g ?? '') };
    }
  }
  return null;
}

function mutate(m, st) {
  switch (m[0]) {
    case 'push':
      if (m.length === 1) st.stack.push(st.state);
      else {
        for (const state of m.slice(1)) {
          if (state === '#pop') st.stack.pop();
          else st.stack.push(state);
        }
      }
      break;
    case 'pop':
      if (st.stack.length === 0) throw new Error('nothing to pop');
      st.stack.length -= m[1];
      break;
    case 'muts':
      for (const x of m[1]) mutate(x, st);
      break;
    default:
      throw new Error('mutator ' + m[0]);
  }
}

function emit(e, groups, st, out) {
  switch (e[0]) {
    case 't':
      out.push({ type: e[1], value: groups[0] });
      break;
    case 'g':
      if (e[1].length !== groups.length - 1) out.push({ type: 'Error', value: groups[0] });
      else {
        for (let i = 1; i < groups.length; i++) {
          if (e[1][i - 1]) emit(e[1][i - 1], [groups[i]], st, out);
        }
      }
      break;
    case 'us':
      out.push(...tokenise(st.lexer, groups[0], { state: e[1], nested: true }));
      break;
    case 'u': {
      const name = resolveName(e[1]);
      const sub = compiled.get(name);
      if (sub === undefined) throw new NeedAsset('lexer', index.files[name]);
      let toks = tokenise(sub, groups[0], { state: 'root', nested: true });
      // lexers.Go: UsingLexer(TypeRemappingLexer(GoTextTemplate, Other -> LiteralString))
      if (st.lexer.name === 'Go' && name === 'Go Text Template') toks = toks.map((t) => (t.type === 'Other' ? { ...t, type: 'LiteralString' } : t));
      out.push(...toks);
      break;
    }
    default:
      throw new Error('emitter ' + e[0]);
  }
}

const ensureLF = (text) => text.replace(/\r\n?/g, '\n');

/** RegexLexer.Tokenise with default options; returns all tokens ({type, value}) */
function tokenise(lexer, text, options = { state: 'root', ensureLF: true }) {
  const opts = { state: 'root', ...options };
  if (opts.ensureLF) text = ensureLF(text);
  let newlineAdded = false;
  if (!opts.nested && lexer.ensureNL && !text.endsWith('\n')) {
    text += '\n';
    newlineAdded = true;
  }
  const st = { lexer, state: opts.state, stack: [opts.state], pos: 0 };
  const out = [];
  const end = newlineAdded ? text.length - 1 : text.length;
  while (st.pos < end && st.stack.length > 0) {
    st.state = st.stack[st.stack.length - 1];
    const selected = lexer.rules[st.state];
    if (selected === undefined) throw new Error('unknown state ' + st.state);
    const m = matchRules(lexer, text, st.pos, selected);
    if (m === null) {
      if (text[st.pos] === '\n' && st.state !== opts.state) {
        st.stack = [opts.state];
        continue;
      }
      st.pos++;
      out.push({ type: 'Error', value: text[st.pos - 1] });
      continue;
    }
    st.pos += m.groups[0].length;
    if (m.rule.mutator) mutate(m.rule.mutator, st);
    if (m.rule.emitter) emit(m.rule.emitter, m.groups, st, out);
  }
  if (st.pos !== text.length && st.stack.length === 0) {
    out.push({ type: 'Error', value: text.slice(st.pos) });
    st.pos = text.length;
  }
  return out.filter((t) => t.type !== 'Ignore');
}

/** chroma.SplitTokensIntoLines */
export function splitTokensIntoLines(tokens) {
  const out = [];
  let line = [];
  tokenLoop:
  for (let token of tokens) {
    while (token.value.includes('\n')) {
      const k = token.value.indexOf('\n');
      const head = token.value.slice(0, k + 1);
      token = { ...token, value: token.value.slice(k + 1) };
      line.push({ ...token, value: head });
      out.push(line);
      line = [];
      // If the tail token is empty, don't emit it.
      if (token.value.length === 0) continue tokenLoop;
    }
    line.push(token);
  }
  if (line.length > 0) out.push(line);
  // Strip empty trailing token line.
  if (out.length > 0) {
    const last = out[out.length - 1];
    if (last.length === 1 && last[0].value === '') out.pop();
  }
  return out;
}

// ---- d2svg's code.go: styleAttr ----

/** styleAttr(styles, tt): the SVG attributes of a token type (with the bold/italic CSS classes) */
export function styleAttr(styles, tt) {
  if (!(tt in styles)) {
    tt = index.types[tt]?.[1] ?? tt;
    if (!(tt in styles)) {
      tt = index.types[tt]?.[0] ?? tt;
      if (!(tt in styles)) return '';
    }
  }
  // Custom code
  let out = styles[tt];
  const classes = [];
  if (out.includes('font-weight="bold"')) {
    out = out.replace('font-weight="bold"', '');
    classes.push('text-mono-bold');
  }
  if (out.includes('font-style="italic"')) {
    out = out.replace('font-style="italic"', '');
    classes.push('text-mono-italic');
  }
  if (classes.length > 0) out += `class="${classes.join(' ')}"`;
  return out.trim();
}

/**
 * The tokens of a code label per style: {light, dark}, each {lines, svgStyles, background} (styles "github" and "catppuccin-mocha").
 * Throws NeedAsset when the lexer file is not loaded yet, Deferred for a language that is not ported.
 */
export function highlight(language, text) {
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 0x7f) throw new Deferred('code-non-ascii');
  const name = resolveName(language);
  let lexer;
  if (name === undefined) lexer = fallbackLexer;
  else {
    if (index.files[name] === undefined) throw new Deferred(`code language ${language}`);
    lexer = compiled.get(name);
    if (lexer === undefined) throw new NeedAsset('lexer', index.files[name]);
  }
  let tokens;
  try {
    tokens = tokenise(lexer, text);
  } catch (e) {
    if (e instanceof Unsupported) throw new Deferred(`code language ${language}`);
    throw e;
  }
  const lines = splitTokensIntoLines(tokens);
  const style = (n) => ({ lines, svgStyles: index.styles[n].svg, background: index.styles[n].background });
  return { light: style('github'), dark: style('catppuccin-mocha') };
}
