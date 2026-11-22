// node genlexers.mjs < chroma.json: writes public/d2/lexers/*.json from `go run . chromadump <lexer names...>` (chroma v2.27.0):
// one file per lexer (its rules in a compact form), index.json (which names/aliases/extensions resolve to which lexer, the token type
// hierarchy and the SVG attributes of the two styles d2svg uses). The engine that runs them is public/d2/highlight.js.
import fs from 'node:fs';

const dump = JSON.parse(fs.readFileSync(0, 'utf8'));
const outDir = new URL('../../public/d2/lexers/', import.meta.url);
fs.mkdirSync(outDir, { recursive: true });

const attrs = (n) => n.a ?? {};

const states = (v) => (v === undefined ? [] : v.split('\x00'));

function emitter(n) {
  switch (n.n) {
    case 'token': return ['t', attrs(n).type];
    case 'bygroups': return ['g', n.c.map(emitterOrNone)];
    case 'using': return attrs(n).lexer.startsWith('@fn:') ? ['fn', attrs(n).lexer.slice(4)] : ['u', attrs(n).lexer]; // @fn: a Go EmitterFunc, see chromawrap.go
    case 'usingself': return ['us', attrs(n).state];
    case 'usingbygroup': {
      const text = (tag) => Number(n.c.find((c) => c.n === tag).t.trim());
      return ['ug', text('sublexer_name_group'), text('code_group'), n.c.find((c) => c.n === 'emitters').c.map(emitterOrNone)];
    }
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
const EMITTERS = new Set(['token', 'bygroups', 'using', 'usingself', 'usingbygroup']);

const fileName = (name) => name.toLowerCase().replace(/#/g, 'sharp').replace(/\+/g, 'p').replace(/[^a-z0-9]+/g, '-');
const files = {};
/** one RegexLexer XML tree -> {name, i, s, nm, nl, rules} */
function convertLexer(tree) {
  const config = tree.c.find((c) => c.n === 'config');
  const rulesNode = tree.c.find((c) => c.n === 'rules');
  const flag = (tag) => config.c.some((c) => c.n === tag && c.t.trim() === 'true');
  const lexer = { name: config.c.find((c) => c.n === 'name').t.trim() };
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
  return lexer;
}
for (const [name, tree] of Object.entries(dump.lexers)) {
  if (tree.error) { console.error('skipping', name, tree.error); continue; }
  let lexer;
  if (tree.wrap === 'delegate') {
    // DelegatingLexer(root, language): the language lexer tokenises the text, its Other tokens are lexed again by the root lexer
    lexer = { ...convertLexer(tree.language), wrap: 'delegate' };
    lexer.root = convertLexer(tree.root);
  } else if (tree.wrap === 'remap') {
    // TypeRemappingLexer: [from, to, words] (no words: every token of that type)
    lexer = { ...convertLexer(tree.lexer), wrap: 'remap', mapping: tree.mapping };
  } else if (tree.wrap === 'http') {
    // the HTTP lexer lexes the body with the lexer of the Content-Type header
    lexer = { ...convertLexer(tree.lexer), wrap: 'http' };
  } else if (tree.wrap === 'markdown') {
    // the markdown lexer highlights a leading YAML front matter block with the YAML lexer
    lexer = { ...convertLexer(tree.lexer), wrap: 'markdown' };
  } else lexer = convertLexer(tree);
  const f = `${fileName(lexer.name)}.json`;
  // JSON.stringify keeps U+2028/U+2029 as they are: write them as escapes
  fs.writeFileSync(new URL(f, outDir), JSON.stringify(lexer).replace(/[\u2028\u2029]/g, (c) => '\\u' + c.charCodeAt(0).toString(16)));
  files[lexer.name] = f;
}

const index = { files, names: dump.names, mimes: dump.mimes, types: dump.types, styles: dump.styles };
fs.writeFileSync(new URL('index.json', outDir), JSON.stringify(index));
console.log(Object.keys(files).join(', '));
