// Generator of D2 programs for the routing core check: the structures that exercise the OVG and the router in different ways (SQL tables
// with column edges, trees, hierarchies with every container direction and self loops, clusters of nodes that share a target, arrowhead labels,
// nested containers with edges across them, sequence-like chains, duplicate edges). Seeded; one JSON case per line:
//   node tala/routingfuzz.mjs [count=400] [seed=1] > tala-routingfuzz.jsonl
//   node tala/routingcheck.mjs routing tala-routingfuzz.jsonl --seeds 1,2
const [count = '400', seed = '1'] = process.argv.slice(2);
let x = (Number(seed) >>> 0) || 1;
const rnd = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
const int = (n) => Math.floor(rnd() * n);
const pick = (a) => a[int(a.length)];
const chance = (p) => rnd() < p;
const dirs = ['up', 'down', 'left', 'right'];
const arrows = ['triangle', 'arrow', 'diamond', 'circle', 'box', 'cf-one', 'cf-many'];
const shapes = ['rectangle', 'square', 'circle', 'oval', 'diamond', 'hexagon', 'cylinder', 'queue', 'page', 'person', 'cloud'];
const name = (i) => `n${i}`;
const label = () => pick(['', '', 'x', 'label', 'a longer label', 'two\\nlines']);

function edge(a, b, extra = {}) {
  const attrs = [];
  const l = label();
  if (l) attrs.push(`label: "${l}"`);
  if (chance(0.15)) attrs.push(`source-arrowhead: {shape: ${pick(arrows)}${chance(0.4) ? '; label: s' : ''}}`);
  if (chance(0.25)) attrs.push(`target-arrowhead: {shape: ${pick(arrows)}${chance(0.4) ? '; label: t' : ''}}`);
  if (extra.bidirectional) return `${a} <-> ${b}${attrs.length ? `: {${attrs.join('; ')}}` : ''}`;
  const op = pick(['->', '->', '->', '--', '<-']);
  return `${a} ${op} ${b}${attrs.length ? `: {${attrs.join('; ')}}` : ''}`;
}

function tables() {
  const n = 2 + int(7);
  const lines = [];
  if (chance(0.4)) lines.push(`direction: ${pick(dirs)}`);
  const cols = [];
  for (let i = 0; i < n; i++) {
    const c = 1 + int(5);
    cols.push(c);
    lines.push(`t${i}: {\n  shape: sql_table\n${Array.from({ length: c }, (_, k) => `  c${k}: ${pick(['int', 'string', 'text'])}${chance(0.3) ? ' {constraint: primary_key}' : ''}`).join('\n')}\n}`);
  }
  const m = n + int(2 * n);
  for (let k = 0; k < m; k++) {
    const a = int(n), b = int(n);
    lines.push(`t${a}.c${int(cols[a])} -> t${b}.c${int(cols[b])}${chance(0.2) ? `: ${label() || 'fk'}` : ''}`);
  }
  if (chance(0.3)) lines.push(`t${int(n)} -> t${int(n)}`);
  return lines.join('\n');
}

function tree() {
  const n = 3 + int(14);
  const lines = [];
  lines.push(`direction: ${pick(dirs)}`);
  for (let i = 1; i < n; i++) lines.push(edge(name(Math.floor((i - 1) / (1 + int(3)))), name(i)));
  if (chance(0.4)) lines.push(edge(name(int(n)), name(int(n))));
  if (chance(0.3)) lines.push(edge(name(int(n)), name(int(n))));
  return lines.join('\n');
}

function hierarchy() {
  const n = 3 + int(12);
  const lines = [`direction: ${pick(dirs)}`];
  for (let i = 0; i < n; i++) if (chance(0.3)) lines.push(`${name(i)}.shape: ${pick(shapes)}`);
  const m = n + int(2 * n);
  for (let k = 0; k < m; k++) {
    const a = int(n), b = int(n);
    lines.push(edge(name(a), name(b)));
  }
  if (chance(0.5)) lines.push(edge(name(0), name(0)));
  if (chance(0.3)) {
    lines.push(`c: {\n  direction: ${pick(dirs)}\n  ${name(0)}\n  ${name(1)}\n  ${edge(name(0), name(1))}\n}`);
  }
  return lines.join('\n');
}

function clusters() {
  const k = 3 + int(5);
  const lines = [`direction: ${pick(dirs)}`];
  for (let i = 0; i < k; i++) lines.push(edge(`c${i}`, 'hub'));
  if (chance(0.6)) for (let i = 0; i < k; i++) lines.push(edge('hub2', `d${i}`));
  if (chance(0.5)) for (let i = 0; i < 1 + int(3); i++) lines.push(edge(`c${int(k)}`, `e${i}`));
  if (chance(0.4)) lines.push(edge('hub', 'hub2'));
  return lines.join('\n');
}

function containers() {
  const lines = [`direction: ${pick(dirs)}`];
  const groups = 2 + int(4);
  const members = [];
  for (let g = 0; g < groups; g++) {
    const sz = 1 + int(4);
    const body = [];
    if (chance(0.3)) body.push(`direction: ${pick(dirs)}`);
    for (let i = 0; i < sz; i++) { body.push(`m${i}${chance(0.2) ? `: {shape: ${pick(shapes)}}` : ''}`); members.push(`g${g}.m${i}`); }
    for (let i = 1; i < sz; i++) if (chance(0.6)) body.push(edge(`m${i - 1}`, `m${i}`));
    lines.push(`g${g}: {\n  ${body.join('\n  ')}\n}`);
  }
  const m = groups + int(2 * groups);
  for (let k = 0; k < m; k++) lines.push(edge(pick(members), pick(members)));
  if (chance(0.4)) lines.push(edge(`g${int(groups)}`, pick(members)));
  return lines.join('\n');
}

function labeled() {
  const n = 2 + int(7);
  const lines = [`direction: ${pick(dirs)}`];
  for (let i = 0; i < n; i++) lines.push(`${name(i)}: ${chance(0.5) ? 'a node label' : name(i)} ${chance(0.3) ? `{shape: ${pick(shapes)}}` : ''}`.trim());
  const m = n + int(n);
  for (let k = 0; k < m; k++) lines.push(edge(name(int(n)), name(int(n)), { bidirectional: chance(0.2) }));
  return lines.join('\n');
}

function dense() {
  const n = 4 + int(9);
  const lines = [];
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (i !== j && chance(0.35)) lines.push(`${name(i)} -> ${name(j)}`);
  if (!lines.length) lines.push('a -> b');
  return lines.join('\n');
}

const makers = [tables, tables, tree, tree, hierarchy, hierarchy, hierarchy, clusters, clusters, containers, containers, labeled, dense];
const out = [];
for (let i = 0; i < Number(count); i++) {
  const text = pick(makers)() + '\n';
  out.push(JSON.stringify({ name: `routingfuzz:${seed}:${i}`, path: 'f.d2', text, layout: 'tala' }));
}
console.log(out.join('\n'));
