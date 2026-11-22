// D2 programs written to make TALA discover and place hierarchies (layered DAGs, containers inside and between layers, cycles,
// undirected and bidirectional edges, self loops, SQL tables with column edges, directions, labels, long edges that need dummy nodes),
// the corpus of D2's own tests has few of them. Output: cases of the tala-corpus.jsonl format.
//   node tala/hierfuzz.mjs [count=600] [seed=1] > tala-hierfuzz.jsonl
const count = Number(process.argv[2] || 600);
let x = Number(process.argv[3] || 1) >>> 0 || 1;
const rnd = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
const int = (n) => Math.floor(rnd() * n);
const pick = (a) => a[int(a.length)];
const chance = (p) => rnd() < p;

const labels = ['', '', '', 'yes', 'no', 'calls', 'a longer edge label', 'x\\ny', '1', 'n'];
const shapes = ['rectangle', 'rectangle', 'rectangle', 'rectangle', 'square', 'circle', 'cylinder', 'diamond', 'oval', 'queue', 'package', 'step', 'page', 'hexagon'];
const arrows = ['->', '->', '->', '->', '->', '<-', '<->', '--'];
const dirs = ['up', 'down', 'left', 'right'];

function nodeDecl(name, depth) {
  const body = [];
  if (chance(0.15)) body.push(`shape: ${pick(shapes)}`);
  if (chance(0.1)) body.push(`label: ${pick(['Service', 'DB', 'A very long node label here', 'x'])}`);
  if (chance(0.05)) body.push(`width: ${40 + int(160)}`);
  if (chance(0.05)) body.push(`height: ${30 + int(120)}`);
  return body.length ? `${name}: {\n  ${body.join('\n  ')}\n}` : name;
}

function edgeStmt(a, b) {
  const arrow = pick(arrows);
  const l = pick(labels);
  return `${a} ${arrow} ${b}${l ? `: ${l}` : ''}`;
}

function layered(prefix, nLevels, maxWidth, opts) {
  const levels = [];
  let id = 0;
  for (let l = 0; l < nLevels; l++) {
    const w = 1 + int(maxWidth);
    const row = [];
    for (let i = 0; i < w; i++) row.push(`${prefix}${id++}`);
    levels.push(row);
  }
  const lines = [];
  for (let l = 0; l < nLevels - 1; l++) {
    for (const a of levels[l]) {
      const k = 1 + int(2);
      for (let j = 0; j < k; j++) {
        const targetLevel = chance(0.15) && l + 2 < nLevels ? l + 2 + int(nLevels - l - 2) : l + 1;
        const b = pick(levels[targetLevel]);
        lines.push(edgeStmt(a, b));
      }
    }
    // make sure every node of the next level has a parent most of the time
    for (const b of levels[l + 1]) if (chance(0.85)) lines.push(edgeStmt(pick(levels[l]), b));
  }
  if (opts.cycle && chance(0.7)) lines.push(`${pick(levels[nLevels - 1])} -> ${pick(levels[0])}`);
  if (opts.back && chance(0.5)) lines.push(`${pick(levels[nLevels - 1])} -> ${pick(levels[1 + int(nLevels - 1)])}`);
  if (opts.self && chance(0.5)) lines.push(`${pick(levels.flat())} -> ${pick(levels.flat())}`);
  if (opts.parallel && chance(0.5)) { const a = pick(levels[0]), b = pick(levels[1]); lines.push(`${a} -> ${b}: p1`, `${a} -> ${b}: p2`, `${b} -> ${a}`); }
  for (const n of levels.flat()) if (chance(0.25)) lines.unshift(nodeDecl(n, 0));
  return { levels, lines };
}

function programLayered() {
  const { levels, lines } = layered('n', 3 + int(4), 1 + int(5), { cycle: chance(0.3), back: chance(0.2), self: chance(0.15), parallel: chance(0.2) });
  const body = [];
  if (chance(0.25)) body.push(`direction: ${pick(dirs)}`);
  return [...body, ...lines].join('\n');
}

function programContainers() {
  const nC = 2 + int(5);
  const cont = [];
  const lines = [];
  const inner = [];
  for (let c = 0; c < nC; c++) {
    const nm = `c${c}`;
    const kids = [];
    const k = 1 + int(4);
    for (let i = 0; i < k; i++) kids.push(`k${c}_${i}`);
    cont.push({ nm, kids });
    const body = [];
    if (chance(0.2)) body.push(`direction: ${pick(dirs)}`);
    if (chance(0.15)) body.push(`label: Group ${c}`);
    if (chance(0.25)) body.push('shape: hierarchy'); // forces the hierarchy of the container's children
    if (chance(0.15)) body.push(`shape: ${pick(['rectangle', 'package', 'queue', 'step', 'square'])}`);
    for (const kid of kids) body.push(chance(0.2) ? nodeDecl(kid, 1) : kid);
    if (chance(0.25) && kids.length > 1) body.push(edgeStmt(pick(kids), pick(kids)));
    // a nested container sometimes
    if (chance(0.2)) {
      const n2 = `s${c}`;
      const k2 = [`${n2}a`, `${n2}b`];
      body.push(`${n2}: {\n  ${k2.join('\n  ')}\n  ${k2[0]} -> ${k2[1]}\n}`);
      cont[cont.length - 1].kids.push(`${n2}.${k2[0]}`, `${n2}.${k2[1]}`);
    }
    inner.push(`${nm}: {\n  ${body.join('\n  ').replace(/\n/g, '\n  ')}\n}`);
  }
  const loose = [];
  const nL = int(4);
  for (let i = 0; i < nL; i++) loose.push(`z${i}`);
  // edges between containers, their members and loose nodes: mostly forward by index (a DAG at the container level)
  const refs = () => {
    const c = pick(cont);
    return chance(0.5) ? c.nm : `${c.nm}.${pick(c.kids)}`;
  };
  const items = [...cont.map((c, i) => ({ i, ref: () => (chance(0.5) ? c.nm : `${c.nm}.${pick(c.kids)}`) })), ...loose.map((z, i) => ({ i: nC + i, ref: () => z }))];
  const m = 2 + int(2 * items.length);
  for (let e = 0; e < m; e++) {
    const a = items[int(items.length)], b = items[int(items.length)];
    if (a === b && chance(0.8)) continue;
    const [f, t] = a.i <= b.i || chance(0.1) ? [a, b] : [b, a];
    lines.push(edgeStmt(f.ref(), t.ref()));
  }
  void refs;
  const body = [];
  if (chance(0.25)) body.push(`direction: ${pick(dirs)}`);
  return [...body, ...inner, ...loose, ...lines].join('\n');
}

function programTables() {
  const n = 2 + int(4);
  const tables = [];
  const lines = [];
  for (let t = 0; t < n; t++) {
    const cols = [];
    const k = 1 + int(5);
    for (let c = 0; c < k; c++) cols.push(`c${c}`);
    tables.push({ nm: `t${t}`, cols });
    lines.push(`t${t}: {\n  shape: sql_table\n  ${cols.map((c) => `${c}: ${pick(['int', 'varchar', 'text'])}${chance(0.2) ? ' {constraint: primary_key}' : ''}`).join('\n  ')}\n}`);
  }
  const m = 1 + int(2 * n);
  for (let e = 0; e < m; e++) {
    const a = int(n), b = int(n);
    if (a === b) continue;
    const [f, t] = a < b || chance(0.15) ? [a, b] : [b, a];
    lines.push(`${tables[f].nm}.${pick(tables[f].cols)} -> ${tables[t].nm}.${pick(tables[t].cols)}`);
  }
  if (chance(0.5)) for (let i = 0; i < 1 + int(3); i++) lines.push(`x${i} -> t${int(n)}`);
  if (chance(0.3)) lines.push(`${pick(tables).nm} -> ${pick(tables).nm}`);
  return lines.join('\n');
}

function programMixed() {
  // a layered core plus other layout structures that interact with hierarchy discovery (nears, trees, classes, grids, sequence-less)
  const { levels, lines } = layered('m', 3 + int(3), 1 + int(3), { cycle: chance(0.2), back: chance(0.2), self: chance(0.1), parallel: false });
  const extra = [];
  if (chance(0.3)) extra.push(`note: { shape: text; label: hello\n near: top-center }`);
  if (chance(0.3)) extra.push(`cls: {\n  shape: class\n  +a: int\n  +f(): void\n}`, `cls -> ${pick(levels.flat())}`);
  if (chance(0.3)) extra.push(`g: {\n  grid-rows: 2\n  a\n  b\n  c\n  d\n}`, `${pick(levels.flat())} -> g`);
  if (chance(0.3)) extra.push(`tree: {\n  r -> a\n  r -> b\n  r -> c\n}`);
  if (chance(0.3)) extra.push(`iso1`, `iso2`);
  return [...lines, ...extra].join('\n');
}

const makers = [programLayered, programLayered, programContainers, programContainers, programTables, programMixed];
for (let i = 0; i < count; i++) {
  let text = pick(makers)();
  if (chance(0.4)) text = `shape: hierarchy\n${text}`; // forces the root hierarchy
  console.log(JSON.stringify({ from: `hierfuzz/${i}`, path: `hierfuzz/${i}.d2`, text, layout: 'tala' }));
}
