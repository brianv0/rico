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

const fileName = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
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
    for (const rule of st.c) {
      let em = 0, mu = 0;
      for (const ch of rule.c ?? []) {
        if (EMITTERS.has(ch.n)) em = emitter(ch);
        else mu = mutator(ch);
      }
      list.push([attrs(rule).pattern ?? '', em, mu]);
    }
    lexer.rules[attrs(st).name] = list;
  }
  const f = `${fileName(cfgName)}.json`;
  fs.writeFileSync(new URL(f, outDir), JSON.stringify(lexer));
  files[cfgName] = f;
}

const index = { files, names: dump.names, types: dump.types, styles: dump.styles };
fs.writeFileSync(new URL('index.json', outDir), JSON.stringify(index));
console.log(Object.keys(files).join(', '));
