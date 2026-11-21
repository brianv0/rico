// distinct XML node kinds (emitters/mutators and their attributes) under the rules of a chromadump file: node regexnodes.mjs chroma.json
import fs from 'node:fs';
const dump = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const kinds = new Map();
const walk = (n, lexer, depth) => {
  const key = n.n + ' ' + Object.keys(n.a ?? {}).sort().join(',');
  if (!kinds.has(key)) kinds.set(key, new Set());
  kinds.get(key).add(lexer);
  for (const c of n.c ?? []) walk(c, lexer, depth + 1);
};
for (const [name, tree] of Object.entries(dump.lexers)) {
  if (tree.error) continue;
  const rules = tree.c.find((c) => c.n === 'rules');
  for (const st of rules.c) for (const rule of st.c ?? []) for (const ch of rule.c ?? []) walk(ch, name, 0);
}
for (const [k, v] of [...kinds].sort()) console.log(k.padEnd(40), v.size, [...v].slice(0, 4).join(', '));
