// lists patterns by feature from a chromadump file: node dbg7.mjs chroma.json <regex> [maxPrint]
import fs from 'node:fs';
const dump = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const re = new RegExp(process.argv[3]);
const max = Number(process.argv[4] || 40);
const seen = new Map();
for (const [name, tree] of Object.entries(dump.lexers)) {
  if (tree.error) continue;
  const rulesNode = tree.c.find((c) => c.n === 'rules');
  for (const st of rulesNode.c) for (const rule of st.c ?? []) {
    const p = rule.a?.pattern ?? '';
    const m = p.match(new RegExp(re.source, 'g'));
    if (m) for (const x of m) { if (!seen.has(x)) seen.set(x, new Set()); seen.get(x).add(name); }
  }
}
const arr = [...seen.entries()].sort((a, b) => b[1].size - a[1].size);
console.log(arr.length, 'distinct');
for (const [x, s] of arr.slice(0, max)) console.log(JSON.stringify(x).padEnd(40), s.size, [...s].slice(0, 5).join(','));
