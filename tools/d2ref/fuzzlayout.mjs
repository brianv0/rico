// Layout-targeted generator for the differential harness: random D2 programs built to stress the layout stage (dagre on nested
// containers, parallel / antiparallel / self edges, labels, directions, grids, sequence diagrams, constant nears, shapes with
// sizes, icons, 3d/multiple, scenarios): node fuzzlayout.mjs [count] [seed] > f.jsonl && node diff.mjs layout f.jsonl
import fs from 'node:fs';

const [count = '2000', seed = '1'] = process.argv.slice(2);
let x = Number(seed) >>> 0 || 1;
const rnd = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
const int = (n) => Math.floor(rnd() * n);
const pick = (a) => a[int(a.length)];
const chance = (p) => rnd() < p;

const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'x', 'y', 'z', 'api', 'db', 'cache', 'Queue', 'user', 'K8s', 'Ünïcode', '日本', 'long name here', 'w'];
const labels = ['', '', '', 'hello', 'a longer label text', 'multi\\nline\\nlabel', 'x', '日本語', 'wide label wide label wide label'];
const shapes = ['rectangle', 'square', 'page', 'parallelogram', 'document', 'cylinder', 'queue', 'package', 'step', 'callout', 'stored_data', 'person', 'diamond', 'oval', 'circle', 'hexagon', 'cloud', 'text', 'image', 'c4-person'];
const dirs = ['up', 'down', 'left', 'right'];
const nears = ['top-left', 'top-center', 'top-right', 'center-left', 'center-right', 'bottom-left', 'bottom-center', 'bottom-right'];
const labelNears = ['outside-top-left', 'outside-top-center', 'outside-top-right', 'outside-left-center', 'outside-right-center', 'outside-bottom-left', 'outside-bottom-center', 'outside-bottom-right', 'inside-top-left', 'inside-bottom-right', 'inside-middle-center'];

function node(depth) {
  const n = pick(names);
  let body = [];
  if (chance(0.3)) body.push(`shape: ${pick(shapes)}`);
  if (chance(0.15)) body.push(`width: ${20 + int(200)}`);
  if (chance(0.15)) body.push(`height: ${20 + int(150)}`);
  if (chance(0.12)) body.push(`label: ${JSON.stringify(pick(labels) || 'L')}`.replace(/\\\\n/g, '\\n'));
  if (chance(0.06)) body.push('style.3d: true');
  if (chance(0.06)) body.push('style.multiple: true');
  if (chance(0.05)) body.push('icon: https://icons.terrastruct.com/essentials/time.svg');
  if (chance(0.05)) body.push(`label.near: ${pick(labelNears)}`);
  if (chance(0.04)) body.push(`icon.near: ${pick(labelNears)}`);
  if (chance(0.05)) body.push(`direction: ${pick(dirs)}`);
  if (chance(0.04)) body.push(`style.stroke-width: ${1 + int(8)}`);
  if (depth < 3 && chance(0.35)) {
    for (let i = 0, k = 1 + int(4); i < k; i++) body.push(node(depth + 1));
    if (chance(0.5)) body.push(`${pick(names)} -> ${pick(names)}${chance(0.3) ? ': ' + pick(labels.filter(Boolean)) : ''}`);
  }
  if (!body.length) return n;
  return `${n}: {\n${body.map((l) => '  ' + l.replace(/\n/g, '\n  ')).join('\n')}\n}`;
}

function ref() {
  const parts = [pick(names)];
  if (chance(0.25)) parts.push(pick(names));
  if (chance(0.08)) parts.push(pick(names));
  return parts.join('.');
}

function edge() {
  const arrow = pick(['->', '->', '->', '<-', '<->', '--']);
  let s = `${ref()} ${arrow} ${chance(0.06) ? ref() + ' ' + arrow + ' ' : ''}${chance(0.08) ? ref() : ref()}`;
  const l = pick(labels);
  const body = [];
  if (chance(0.1)) body.push(`source-arrowhead.shape: ${pick(['diamond', 'circle', 'triangle', 'cf-many'])}`);
  if (chance(0.1)) body.push(`target-arrowhead.label: ${pick(['1', 'n'])}`);
  if (chance(0.05)) body.push('style.stroke-width: 6');
  if (l || body.length) s += `: ${l ? JSON.stringify(l).replace(/\\\\n/g, '\\n') : ''}`;
  if (body.length) s += ` {\n  ${body.join('\n  ')}\n}`;
  return s;
}

function sql() {
  const n = pick(names);
  return `${n}: {\n  shape: sql_table\n${Array.from({ length: 1 + int(5) }, (_, i) => `  col${i}: ${pick(['int', 'varchar(255)', 'timestamp with time zone', 'string'])}${chance(0.3) ? ' {constraint: ' + pick(['primary_key', 'foreign_key', 'unique']) + '}' : ''}`).join('\n')}\n}`;
}

function cls() {
  const n = pick(names);
  return `${n}: {\n  shape: class\n${Array.from({ length: 1 + int(4) }, (_, i) => `  ${pick(['+', '-', '#', ''])}field${i}: ${pick(['int', 'string', 'List<Map<K,V>>'])}`).join('\n')}\n${Array.from({ length: int(3) }, (_, i) => `  ${pick(['+', '-'])}method${i}(a, b): ${pick(['void', 'bool'])}`).join('\n')}\n}`;
}

function grid() {
  const n = chance(0.5) ? '' : pick(names) + ': {\n';
  const lines = [];
  if (chance(0.7)) lines.push(`grid-rows: ${1 + int(4)}`);
  if (chance(0.6)) lines.push(`grid-columns: ${1 + int(4)}`);
  if (chance(0.3)) lines.push(`grid-gap: ${int(40)}`);
  if (chance(0.2)) lines.push(`vertical-gap: ${int(40)}`);
  if (chance(0.2)) lines.push(`horizontal-gap: ${int(40)}`);
  if (!lines.length) lines.push('grid-rows: 2');
  for (let i = 0, k = 2 + int(10); i < k; i++) lines.push(chance(0.2) ? node(2) : `c${i}${chance(0.4) ? `: {width: ${20 + int(160)}; height: ${20 + int(100)}}` : ''}`);
  if (chance(0.3)) lines.push(`c0 -> c${1 + int(3)}`);
  if (chance(0.2)) lines.push('shape: grid');
  if (!n) return lines.join('\n');
  return n + lines.map((l) => '  ' + l.replace(/\n/g, '\n  ')).join('\n') + '\n}';
}

function sequence() {
  const actors = ['alice', 'bob', 'carol', 'dave'].slice(0, 2 + int(3));
  const lines = ['shape: sequence_diagram'];
  for (const a of actors) lines.push(chance(0.3) ? `${a}: ${pick(['Alice', 'Bob the builder', 'C'])}` : a);
  for (let i = 0, k = 2 + int(7); i < k; i++) {
    const a = pick(actors), b = pick(actors);
    lines.push(`${a} -> ${b}: ${pick(['hi', 'a longer message', 'call()', '"quoted: msg"'])}`);
  }
  if (chance(0.3)) lines.push(`${actors[0]}.span: {${actors[0]}.a -> ${actors[1]}: x}`.replace('span: ', 'a: ').replace(/\.a/, '.t1'));
  if (chance(0.3)) lines.push(`group: {\n  ${pick(actors)} -> ${pick(actors)}: in group\n}`);
  if (chance(0.2)) lines.push(`${pick(actors)}."a note"`);
  if (chance(0.15)) lines.push(`${pick(actors)}.n: "a note" {shape: text}`);
  if (chance(0.15)) lines.push(`${pick(actors)}.shape: ${pick(['person', 'cylinder', 'cloud'])}`);
  return lines.join('\n');
}

function program() {
  const lines = [];
  if (chance(0.5)) lines.push(`direction: ${pick(dirs)}`);
  const kind = rnd();
  if (kind < 0.07) return sequence();
  if (kind < 0.15) return grid();
  if (kind < 0.18) {
    return `outer: {\n${sequence().split('\n').map((l) => '  ' + l).join('\n')}\n}\n${lines.join('\n')}\n${node(1)}\n${edge()}\n${edge()}`;
  }
  if (kind < 0.21) return `g: {\n${grid().split('\n').map((l) => '  ' + l).join('\n')}\n}\n${lines.join('\n')}\n${node(1)}\n${edge()}`;
  for (let i = 0, k = 2 + int(7); i < k; i++) lines.push(node(0));
  if (chance(0.15)) lines.push(sql());
  if (chance(0.1)) lines.push(cls());
  if (chance(0.08)) lines.push(`${pick(names)}: |md\n  # Title\n  some *markdown* text\n  - item\n|`);
  if (chance(0.06)) lines.push(`${pick(names)}: |go\n  func main() {\n    fmt.Println("x")\n  }\n|`);
  if (chance(0.06)) lines.push(`${pick(names)}: {shape: text; label: "near"; near: ${pick(nears)}}`);
  if (chance(0.04)) lines.push(`${pick(names)}: {near: ${pick(nears)}}`);
  if (chance(0.05)) lines.push(`${pick(names)}: {\n  ${pick(names)}\n  ${pick(names)}\n  near: ${pick(nears)}\n}`);
  for (let i = 0, k = int(14); i < k; i++) lines.push(edge());
  if (chance(0.1)) { const r = ref(); lines.push(`${r} -> ${r}${chance(0.5) ? ': self' : ''}`); }
  if (chance(0.15)) { const a = ref(), b = ref(); lines.push(`${a} -> ${b}: one`, `${b} -> ${a}: two`, `${a} -> ${b}: three`); }
  if (chance(0.06)) lines.push('scenarios: {\n  s1: {\n    ' + node(0).replace(/\n/g, '\n    ') + '\n  }\n}');
  if (chance(0.05)) lines.push('layers: {\n  l1: {\n    ' + node(0).replace(/\n/g, '\n    ') + '\n  }\n}');
  if (chance(0.04)) lines.push('vars: {\n  d2-config: {\n    sketch: true\n  }\n}');
  return lines.join('\n');
}

for (let i = 0; i < Number(count); i++) console.log(JSON.stringify({ from: `fuzzlayout:${seed}:${i}`, path: 'f.d2', text: program() + '\n' }));
