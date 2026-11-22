// Sequence-diagram generator (actors, messages, self messages, spans, notes, groups, nested groups, labels, sizes): node fuzzseq.mjs [count] [seed]
const [count = '1000', seed = '1'] = process.argv.slice(2);
let x = Number(seed) >>> 0 || 1;
const rnd = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
const int = (n) => Math.floor(rnd() * n);
const pick = (a) => a[int(a.length)];
const msgs = ['hi', 'a somewhat longer message label', 'call()', 'x\\ny', '日本語', 'ok'];
for (let i = 0; i < Number(count); i++) {
  const actors = ['alice', 'bob', 'carol', 'dave', 'erin'].slice(0, 2 + int(4));
  const lines = ['shape: sequence_diagram'];
  for (const a of actors) {
    const body = [];
    if (rnd() < 0.2) body.push(`shape: ${pick(['person', 'cylinder', 'cloud', 'queue', 'circle'])}`);
    if (rnd() < 0.15) body.push(`width: ${40 + int(160)}`);
    if (rnd() < 0.15) body.push(`height: ${30 + int(100)}`);
    if (rnd() < 0.1) body.push('label: "A long actor label here"');
    lines.push(body.length ? `${a}: {\n  ${body.join('\n  ')}\n}` : a);
  }
  const msg = () => { const a = pick(actors), b = rnd() < 0.12 ? a : pick(actors); return `${a} ${pick(['->', '<-', '<->', '--'])} ${b}: ${pick(msgs)}`; };
  for (let k = 0, n = 1 + int(9); k < n; k++) lines.push(msg());
  for (let k = 0, n = int(3); k < n; k++) {
    const a = pick(actors), b = pick(actors);
    lines.push(`${a}.t${k}: {${a}.t${k} -> ${b}: ${pick(msgs)}}`.replace(/^(\S+)\.t(\d+): \{\S+ -> /, '$1.t$2 -> ').replace(/\}$/, ''));
  }
  if (rnd() < 0.5) lines.push(`grp: {\n  ${msg()}\n  ${msg()}\n${rnd() < 0.4 ? `  inner: {\n    ${msg()}\n  }\n` : ''}}`);
  if (rnd() < 0.3) lines.push(`${pick(actors)}."a note": {shape: text}`);
  if (rnd() < 0.3) lines.push(`${pick(actors)}.note1: "multi\\nline note"`);
  if (rnd() < 0.2) lines.push(`${pick(actors)}.span1 -> ${pick(actors)}.span2: spans`);
  console.log(JSON.stringify({ from: `fuzzseq:${seed}:${i}`, path: 'f.d2', text: lines.join('\n') + '\n' }));
}
