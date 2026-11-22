// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// The syntax highlighting of code labels (`shape: code`, `|python ... |` blocks), a port of the parts of chroma v2.27.0
// (github.com/alecthomas/chroma, MIT, Copyright (C) 2017 Alec Thomas) that d2svg/code.go and d2svg.go use: the RegexLexer engine
// (regexp.go, mutators.go, emitters.go), lexers.Get / the fallback lexer, SplitTokensIntoLines, and the two styles ("github" and
// "catppuccin-mocha") reduced to what StyleEntryToSVG prints per token type.
//
// The lexers themselves are chroma's own definitions, exported by tools/d2ref `chromadump` (+ genlexers.mjs) as one JSON file each
// under public/d2/lexers/ and loaded on demand (lexers/index.json has the name/alias/extension table of all of them). chroma matches
// with regexp2 (.NET syntax): the patterns run on regexp2.js, a port of that engine, so the tokens are chroma's for any text. Languages
// chroma resolves to the fallback lexer use it, exactly as Go does.

import { Deferred, NeedAsset } from './d2svg.js';
import { Regexp } from './regexp2.js';
import { utf8Len } from './ast.js';

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
    if (e[0] === 'ug') e[3].forEach(walk);
  };
  for (const rules of Object.values(lexer.rules)) for (const [, em] of rules) walk(em);
  if (lexer.root) for (const rules of Object.values(lexer.root.rules)) for (const [, em] of rules) walk(em); // a delegating lexer's root
  if (lexer.wrap === 'markdown') out.add('YAML'); // front matter
  return out;
}

const resolveName = (language) => index.names[language] ?? index.names[language.toLowerCase()];

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
  const compiledLexer = { name: lexer.name, ensureNL: !!lexer.nl, rules: expanded, source: lexer };
  if (lexer.wrap) {
    compiledLexer.wrap = lexer.wrap;
    if (lexer.root) compiledLexer.root = compile(lexer.root);
    if (lexer.mapping) {
      // TypeRemappingLexer's lookup table: type -> word -> new type ('' for every token of the type)
      compiledLexer.lut = new Map();
      for (const [from, to, words] of lexer.mapping) {
        if (!compiledLexer.lut.has(from)) compiledLexer.lut.set(from, new Map());
        for (const w of words && words.length > 0 ? words : ['']) compiledLexer.lut.get(from).set(w, to);
      }
    }
  }
  return compiledLexer;
}

const fallbackLexer = compile({
  name: 'fallback',
  rules: { root: [['.+', ['t', 'Text'], 0], ['\\n', ['t', 'Text'], 0]] },
});

/** chroma's matchRules: the first rule that matches at pos (regexp2 on the runes of the text), with the texts of its groups */
function matchRules(lexer, runes, pos, rules) {
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];
    if (rule.re === null) {
      const l = rule.lexer;
      const flags = (l.nm ? '' : 'm') + (l.i ? 'i' : '') + (l.s ? 's' : '');
      rule.re = new Regexp('\\G' + (flags ? '(?' + flags + ')' : '') + '(?:' + rule.pattern + ')');
    }
    const groups = rule.re.matchAt(runes, pos);
    if (groups !== null) return { rule, groups };
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
    case 'ug': {
      // UsingByGroup: the lexer named by group e[1] tokenises group e[2] (when chroma knows that name); the other groups use their emitters
      if (e[3].length !== groups.length - 1) throw new Error('UsingByGroup expects number of emitters to be the same as len(groups)-1');
      const name = resolveName(groups[e[1]]);
      let sub = null;
      if (name !== undefined) {
        sub = compiled.get(name) ?? null;
        if (sub === null) {
          if (index.files[name] === undefined) throw new Deferred(`code language ${groups[e[1]]}`);
          throw new NeedAsset('lexer', index.files[name]);
        }
      }
      for (let i = 1; i < groups.length; i++) {
        if (i === e[2] && sub !== null) out.push(...tokenise(sub, groups[e[2]]));
        else if (e[3][i - 1]) emit(e[3][i - 1], [groups[i]], st, out);
      }
      break;
    }
    case 'fn': {
      // the EmitterFuncs of chroma's rst and http lexers
      const tok = (type, value) => out.push({ type, value });
      switch (e[1]) {
        case 'rstCodeBlock': {
          tok('Punctuation', groups[1]); tok('Text', groups[2]); tok('OperatorWord', groups[3]); tok('Punctuation', groups[4]); tok('Text', groups[5]);
          tok('Keyword', groups[6]); tok('Text', groups[7]);
          const code = groups.slice(8).join('');
          const name = resolveName(groups[6]);
          if (name === undefined) tok('LiteralString', code);
          else {
            const sub = compiled.get(name);
            if (sub === undefined) {
              if (index.files[name] === undefined) throw new Deferred(`code language ${groups[6]}`);
              throw new NeedAsset('lexer', index.files[name]);
            }
            out.push(...tokenise(sub, code));
          }
          break;
        }
        case 'httpHeaderBlock':
          tok('Name', groups[1]); tok('Text', groups[2]); tok('Operator', groups[3]); tok('Text', groups[4]); tok('Literal', groups[5]); tok('Text', groups[6]);
          break;
        case 'httpContinuousHeaderBlock':
          tok('Text', groups[1]); tok('Literal', groups[2]); tok('Text', groups[3]);
          break;
        case 'httpContentBlock':
          tok('Generic', groups[0]);
          break;
        default:
          throw new Error('emitter function ' + e[1]);
      }
      break;
    }
    case 'us':
      out.push(...tokeniseRegex(st.lexer, groups[0], { state: e[1], nested: true }));
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
function tokeniseRegex(lexer, text, options = { state: 'root', ensureLF: true }) {
  const opts = { state: 'root', ...options };
  if (opts.ensureLF) text = ensureLF(text);
  let newlineAdded = false;
  if (!opts.nested && lexer.ensureNL && !text.endsWith('\n')) {
    text += '\n';
    newlineAdded = true;
  }
  // chroma works on []rune: positions and lengths are in code points (a lone surrogate, invalid in Go's UTF-8, decodes to U+FFFD)
  const runes = Array.from(text, (c) => { const r = c.codePointAt(0); return r >= 0xd800 && r <= 0xdfff ? 0xfffd : r; });
  const str = (from, to) => String.fromCodePoint(...runes.slice(from, to));
  const st = { lexer, state: opts.state, stack: [opts.state], pos: 0 };
  const out = [];
  const end = newlineAdded ? runes.length - 1 : runes.length;
  let stuck = 0;
  while (st.pos < end && st.stack.length > 0) {
    if (++stuck > 100000) throw new Error('chroma lexer made no progress'); // chroma loops forever here
    st.state = st.stack[st.stack.length - 1];
    const selected = lexer.rules[st.state];
    if (selected === undefined) throw new Error('unknown state ' + st.state);
    const m = matchRules(lexer, runes, st.pos, selected);
    if (m === null) {
      if (runes[st.pos] === 0x0a && st.state !== opts.state) {
        st.stack = [opts.state];
        continue;
      }
      stuck = 0;
      st.pos++;
      out.push({ type: 'Error', value: str(st.pos - 1, st.pos) });
      continue;
    }
    if (m.groups[0] !== '') stuck = 0;
    st.pos += runeCount(m.groups[0]);
    if (m.rule.mutator) mutate(m.rule.mutator, st);
    if (m.rule.emitter) emit(m.rule.emitter, m.groups, st, out);
  }
  if (st.pos !== runes.length && st.stack.length === 0) {
    out.push({ type: 'Error', value: str(st.pos, runes.length) });
    st.pos = runes.length;
  }
  return out.filter((t) => t.type !== 'Ignore');
}

const runeCount = (s) => { let n = s.length; for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) { n--; i++; } } return n; };

// ---- the lexers that wrap a RegexLexer: DelegatingLexer, TypeRemappingLexer and the markdown lexer ----

const encoder = new TextEncoder(), decoder = new TextDecoder();

/** chroma.Coalesce: empty tokens are dropped, neighbours of the same type are joined (up to 8192 bytes) */
function coalesce(tokens) {
  const out = [];
  let prev = null;
  for (const t of tokens) {
    if (t.value.length === 0) continue;
    if (prev === null) prev = { ...t };
    else if (prev.type === t.type && utf8Len(prev.value) < 8192) prev.value += t.value;
    else { out.push(prev); prev = { ...t }; }
  }
  if (prev !== null) out.push(prev);
  return out;
}

/** chroma's splitToken: [left, right] at a byte offset (null is EOF) */
function splitToken(t, offset) {
  if (t === null) return [null, null];
  if (offset === 0) return [null, t];
  const bytes = encoder.encode(t.value);
  if (offset === bytes.length) return [t, null];
  return [{ ...t, value: decoder.decode(bytes.subarray(0, offset)) }, { ...t, value: decoder.decode(bytes.subarray(offset)) }];
}

/** delegatingLexer.Tokenise: the language lexer (this lexer's own rules) lexes the text; its Other tokens are lexed again by the root lexer and the language's tokens are inserted */
function tokeniseDelegating(lexer, text, options) {
  const tokens = coalesce(tokeniseRegex(lexer, text, options));
  let others = '';
  const insertions = [];
  let insert = null, offset = 0, last = null;
  for (const t of tokens) {
    if (t.type === 'Other') {
      if (last !== null && insert !== null && last.type !== 'Other') insert.end = offset;
      others += t.value;
    } else {
      if (last === null || last.type === 'Other') {
        insert = { start: offset, end: 0, tokens: [] };
        insertions.push(insert);
      }
      insert.tokens.push(t);
    }
    last = t;
    offset += utf8Len(t.value);
  }
  if (insertions.length === 0) return tokenise(lexer.root, text, options);
  const rootTokens = coalesce(tokenise(lexer.root, others, options));
  const out = [];
  offset = 0;
  let tokenIndex = 0, insertionIndex = 0;
  const nextToken = () => (tokenIndex >= rootTokens.length ? null : rootTokens[tokenIndex++]);
  const nextInsertion = () => (insertionIndex >= insertions.length ? null : insertions[insertionIndex++]);
  let t = nextToken();
  let i = nextInsertion();
  while (t !== null || i !== null) {
    if (t === null || (i !== null && i.start < offset + utf8Len(t.value))) {
      let l;
      [l, t] = splitToken(t, i.start - offset);
      if (l !== null) { out.push(l); offset += utf8Len(l.value); }
      out.push(...i.tokens);
      offset += i.end - i.start;
      if (t === null) t = nextToken();
      i = nextInsertion();
    } else {
      out.push(t);
      offset += utf8Len(t.value);
      t = nextToken();
    }
  }
  return out;
}

/** markdownLexer.splitFrontmatter: a leading `---` ... `---` block */
function splitFrontmatter(text) {
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) return null;
  let lineEnd = text.indexOf('\n');
  if (lineEnd < 0) return null;
  const trimCR = (s) => (s.endsWith('\r') ? s.slice(0, -1) : s);
  if (trimCR(text.slice(0, lineEnd)) !== '---') return null;
  for (let pos = lineEnd + 1; pos < text.length;) {
    const next = text.indexOf('\n', pos);
    if (next < 0) break;
    lineEnd = next;
    if (trimCR(text.slice(pos, lineEnd)) === '---') return [text.slice(0, lineEnd + 1), text.slice(lineEnd + 1)];
    pos = lineEnd + 1;
  }
  return null;
}

/** Lexer.Tokenise of any compiled lexer */
function tokenise(lexer, text, options) {
  switch (lexer.wrap) {
    case 'delegate':
      return tokeniseDelegating(lexer, text, options);
    case 'remap': {
      const out = [];
      for (const t of tokeniseRegex(lexer, text, options)) {
        const k = lexer.lut.get(t.type);
        const to = k === undefined ? undefined : k.get(t.value) ?? k.get('');
        out.push(to === undefined ? t : { ...t, type: to });
      }
      return out;
    }
    case 'http': {
      // httpBodyContentTyper.Tokenise: a Generic token after a Content-Type header is lexed with that MIME type's lexer
      let contentType = '', isContentType = false, pending = [];
      const out = [];
      for (const token of tokeniseRegex(lexer, text, options)) {
        if (token.type === 'Name' && token.value.toLowerCase() === 'content-type') isContentType = true;
        else if (token.type === 'Literal' && isContentType) {
          isContentType = false;
          contentType = token.value.trim();
          const pos = contentType.indexOf(';');
          if (pos > 0) contentType = contentType.slice(0, pos).trim();
        } else if (token.type === 'Generic' && contentType !== '') {
          let name = index.mimes[contentType];
          if (name === undefined && contentType.includes('+')) {
            contentType = contentType.slice(0, contentType.indexOf('/') + 1) + contentType.slice(contentType.lastIndexOf('+') + 1);
            name = index.mimes[contentType];
          }
          if (name === undefined) { out.push({ ...token, type: 'Text' }); continue; }
          const sub = compiled.get(name);
          if (sub === undefined) {
            if (index.files[name] === undefined) throw new Deferred(`code language ${name}`);
            throw new NeedAsset('lexer', index.files[name]);
          }
          // Go returns the first token of the sub lexer here; the rest of its iterator is only read when the main one is exhausted (and a later body replaces it)
          const toks = tokenise(sub, token.value);
          if (toks.length === 0) return out; // an exhausted sub iterator is EOF: the iteration ends
          out.push(toks[0]);
          pending = toks.slice(1);
          continue;
        }
        out.push(token);
      }
      return [...out, ...pending];
    }
    case 'markdown': {
      const parts = splitFrontmatter(text);
      if (parts === null) return tokeniseRegex(lexer, text, options);
      const yaml = compiled.get('YAML');
      if (yaml === undefined) throw new NeedAsset('lexer', index.files.YAML);
      return [...tokenise(yaml, parts[0], options), ...tokeniseRegex(lexer, parts[1], options)];
    }
    default:
      return tokeniseRegex(lexer, text, options);
  }
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
  const name = resolveName(language);
  let lexer;
  if (name === undefined) lexer = fallbackLexer;
  else {
    if (index.files[name] === undefined) throw new Deferred(`code language ${language}`);
    lexer = compiled.get(name);
    if (lexer === undefined) throw new NeedAsset('lexer', index.files[name]);
  }
  const tokens = tokenise(lexer, text);
  const lines = splitTokensIntoLines(tokens);
  const style = (n) => ({ lines, svgStyles: index.styles[n].svg, background: index.styles[n].background });
  return { light: style('github'), dark: style('catppuccin-mocha') };
}
