// statistics of regexp2 constructs over all chroma lexers (from chromadump output)
import fs from 'node:fs';
const dump = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
let n = 0, err = [];
const feats = {
  namedGroup: /\(\?(P?<[A-Za-z_]\w*>|'[A-Za-z_]\w*')/,
  balanced: /\(\?<[A-Za-z_0-9]*-[A-Za-z_0-9]+>/,
  lookahead: /\(\?=/, neglookahead: /\(\?!/, lookbehind: /\(\?<=/, neglookbehind: /\(\?<!/,
  atomic: /\(\?>/, inlineFlagsMid: /\(\?[a-z-]+[:)]/, comment: /\(\?#/,
  condGroup: /\(\?\(/, backref: /\\[1-9]/, namedBackref: /\\k[<']/, G: /\\G/, Z: /\\Z/, z: /\\z/, A: /\\A/, b: /\\b/, B: /\\B/,
  pL: /\\[pP]\{[^}]*\}/, w: /\\w/, W: /\\W/, d: /\\d/, s: /\\s/, S: /\\S/,
  possessive: /[*+?}]\+/, lazy: /[*+?}]\?/, subtraction: /-\[/, hexEsc: /\\x[0-9a-fA-F]{2}/, uEsc: /\\u[0-9a-fA-F]{4}/, ctrl: /\\c[A-Za-z]/, oct: /\\0\d*/,
  e: /\\e/, a: /\\a/, dollar: /\$/, caret: /\^/, dotAny: /\./, nonAscii: /[^\x00-\x7f]/, quantBrace: /\{\d+(,\d*)?\}/, bracketEscapeInClass: /\[[^\]]*\\[wWdDsS]/,
};
const counts = Object.fromEntries(Object.keys(feats).map((k) => [k, { rules: 0, lexers: new Set() }]));
const walkRules = (tree, f) => {
  const rulesNode = tree.c.find((c) => c.n === 'rules');
  for (const st of rulesNode.c) for (const rule of st.c ?? []) f(rule.a?.pattern ?? '');
};
const perLexer = {};
for (const [name, tree] of Object.entries(dump.lexers)) {
  if (tree.error) { err.push(name + ': ' + tree.error); continue; }
  n++;
  const config = tree.c.find((c) => c.n === 'config');
  const flag = (tag) => config.c.some((c) => c.n === tag && c.t.trim() === 'true');
  const cfgName = config.c.find((c) => c.n === 'name').t.trim();
  let rules = 0;
  walkRules(tree, (p) => {
    rules++;
    for (const [k, re] of Object.entries(feats)) if (re.test(p)) { counts[k].rules++; counts[k].lexers.add(cfgName); }
  });
  perLexer[cfgName] = rules;
}
console.log('lexers', n, 'errors', err.length, err.slice(0, 20));
console.log('total rules', Object.values(perLexer).reduce((a, b) => a + b, 0));
for (const [k, v] of Object.entries(counts)) console.log(k.padEnd(22), String(v.rules).padStart(6), String(v.lexers.size).padStart(4), [...v.lexers].slice(0, 8).join(', '));
