// node genlexers.mjs < chroma.json: writes public/d2/lexers/*.json from `go run . chromadump <lexer names...>` (chroma v2.27.0):
// one file per lexer (its rules in a compact form), index.json (which names/aliases/extensions resolve to which lexer, the token type
// hierarchy and the SVG attributes of the two styles d2svg uses). The engine that runs them is public/d2/highlight.js.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const dump = JSON.parse(fs.readFileSync(0, 'utf8'));
const outDir = new URL('../../public/d2/lexers/', import.meta.url);
fs.mkdirSync(outDir, { recursive: true });

const attrs = (n) => n.a ?? {};

// the character classes of a pattern with two or more shorthand escapes of which one is negated
function quirkyClasses(pattern) {
  const out = [];
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === '\\') { i++; continue; }
    if (pattern[i] !== '[') continue;
    let j = i + 1;
    if (pattern[j] === '^') j++;
    if (pattern[j] === ']') j++;
    let sh = '';
    for (; j < pattern.length && pattern[j] !== ']'; j++) {
      if (pattern[j] === '\\') { if ('wWdDsS'.includes(pattern[j + 1])) sh += pattern[j + 1]; j++; }
    }
    if (sh.length >= 2 && /[WDS]/.test(sh)) out.push(pattern.slice(i, j + 1));
    i = j;
  }
  return out;
}

// a JavaScript character class of exactly these ASCII characters
function classOf(chars) {
  if (chars.length === 0) return '[^\\s\\S]';
  const hex = (c) => '\\x' + c.charCodeAt(0).toString(16).padStart(2, '0');
  let out = '[';
  for (let i = 0; i < chars.length;) {
    let j = i;
    while (j + 1 < chars.length && chars[j + 1].charCodeAt(0) === chars[j].charCodeAt(0) + 1) j++;
    out += j > i ? hex(chars[i]) + '-' + hex(chars[j]) : hex(chars[i]);
    i = j + 1;
  }
  return out + ']';
}
const states = (v) => (v === undefined ? [] : v.split('\x00'));

function emitter(n) {
  switch (n.n) {
    case 'token': return ['t', attrs(n).type];
    case 'bygroups': return ['g', n.c.map(emitterOrNone)];
    case 'using': return ['u', attrs(n).lexer];
    case 'usingself': return ['us', attrs(n).state];
    default: throw new Error('emitter ' + n.n);
  }
}
const emitterOrNone = (n) => (n.n === 'none' ? 0 : emitter(n));
function mutator(n) {
  switch (n.n) {
    case 'push': return ['push', ...states(attrs(n).state)];
    case 'pop': return ['pop', Number(attrs(n).depth)];
    case 'include': return ['inc', attrs(n).state];
    case 'combined': return ['comb', ...states(attrs(n).state)];
    case 'mutators': return ['muts', n.c.map(mutator)];
    default: throw new Error('mutator ' + n.n);
  }
}
const EMITTERS = new Set(['token', 'bygroups', 'using', 'usingself']);

const fileName = (name) => name.toLowerCase().replace(/#/g, 'sharp').replace(/\+/g, 'p').replace(/[^a-z0-9]+/g, '-');
const files = {};
for (const [name, tree] of Object.entries(dump.lexers)) {
  if (tree.error) { console.error('skipping', name, tree.error); continue; }
  const config = tree.c.find((c) => c.n === 'config');
  const rulesNode = tree.c.find((c) => c.n === 'rules');
  const flag = (tag) => config.c.some((c) => c.n === tag && c.t.trim() === 'true');
  const lexer = { name };
  const cfgName = config.c.find((c) => c.n === 'name').t.trim();
  lexer.name = cfgName;
  if (flag('case_insensitive')) lexer.i = 1;
  if (flag('dot_all')) lexer.s = 1;
  if (flag('not_multiline')) lexer.nm = 1;
  if (flag('ensure_nl')) lexer.nl = 1;
  lexer.rules = {};
  for (const st of rulesNode.c) {
    const list = [];
    for (const rule of st.c ?? []) {
      let em = 0, mu = 0;
      for (const ch of rule.c ?? []) {
        if (EMITTERS.has(ch.n)) em = emitter(ch);
        else mu = mutator(ch);
      }
      list.push([attrs(rule).pattern ?? '', em, mu]);
    }
    lexer.rules[attrs(st).name] = list;
  }
  // regexp2 does not combine several shorthand escapes (\w \W \d \D \s \S) of a character class the way JavaScript does when one of them
  // is negated (for example [^\W\d] matches digits). Ask regexp2 itself which ASCII characters such a class matches and keep that set.
  const quirky = new Set();
  for (const list of Object.values(lexer.rules)) for (const [pattern] of list) for (const cls of quirkyClasses(pattern)) quirky.add(cls);
  if (quirky.size > 0) {
    lexer.cls = {};
    const classes = [...quirky];
    const ascii = Array.from({ length: 127 }, (_, i) => String.fromCharCode(i + 1)); // NUL separates the corpus
    const req = classes.map((c) => JSON.stringify({ text: (lexer.i ? '(?i)' : '') + c, corpus: ascii.join('\u0000') })).join('\n');
    const out = execFileSync('go', ['run', '.', 'regexp2'], { cwd: new URL('.', import.meta.url), input: req, maxBuffer: 1 << 26 }).toString().trim().split('\n');
    classes.forEach((c, i) => {
      const r = JSON.parse(out[i]);
      if (r.err) throw new Error(c + ': ' + r.err);
      const chars = ascii.filter((_, k) => r.matches[k] !== null);
      lexer.cls[c] = classOf(chars);
    });
  }
  const f = `${fileName(cfgName)}.json`;
  fs.writeFileSync(new URL(f, outDir), JSON.stringify(lexer));
  files[cfgName] = f;
}

const index = { files, names: dump.names, types: dump.types, styles: dump.styles };
fs.writeFileSync(new URL('index.json', outDir), JSON.stringify(index));
console.log(Object.keys(files).join(', '));
