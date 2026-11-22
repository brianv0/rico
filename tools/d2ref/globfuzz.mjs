// Grammar fuzzer for globs, boards, classes, vars and imports (the parts of d2ir the corpus mutation fuzzer reaches rarely):
//   node globfuzz.mjs [count] [seed] > globfuzz.jsonl && node diff.mjs ir globfuzz.jsonl && node diff.mjs graph globfuzz.jsonl
import { } from 'node:fs';

const [count = '1500', seed = '1'] = process.argv.slice(2);
let x = Number(seed) >>> 0 || 1;
const rnd = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const chance = (p) => rnd() < p;

const names = ['a', 'b', 'c', 'x', 'y', 'ab', 'bc', 'cab', 'A', 'Ab', 'x1', 'x2', 'shape', 'label', 'style', 'class'];
const globs = ['*', '**', '***', 'a*', '*b', '*a*', 'x*', '*1', '*c*b', '**.a', '*.a', 'a.*', '*.*', '**.x*', '***.b', 'ab*', '*b*c'];
const objName = () => pick(names.slice(0, 13));
const path = () => { const n = 1 + Math.floor(rnd() * 3); return Array.from({ length: n }, () => (chance(0.45) ? pick(globs) : objName())).join('.'); };
const plainPath = () => { const n = 1 + Math.floor(rnd() * 3); return Array.from({ length: n }, objName).join('.'); };
const props = ['style.fill: red', 'style.opacity: 0.5', 'label: hi', 'shape: circle', 'class: k', 'style.stroke: blue', 'icon: https://x.y/z.png', 'near: top-center', 'width: 20', 'link: layers.l1'];
const arrow = () => pick(['->', '<-', '<->', '--']);

function value(depth, ctx) {
  const r = rnd();
  if (r < 0.35) return pick(props.slice(0, 7)).replace(/^[^:]*: /, '');
  if (depth > 2) return pick(['v1', '"q q"', '7', 'true', 'null']);
  return '{\n' + block(depth + 1, ctx) + '}';
}

function stmt(depth, ctx) {
  const r = rnd();
  const g = () => (chance(0.5) ? path() : plainPath());
  if (r < 0.2) return g();
  if (r < 0.34) return `${g()}: ${chance(0.5) ? pick(['hello', '"w w"', '3']) : value(depth, ctx)}`;
  if (r < 0.52) return `${g()} ${arrow()} ${g()}${chance(0.3) ? `: {\n${pick(props)}\n}` : chance(0.2) ? ': lbl' : ''}`;
  if (r < 0.6) return `(${g()} ${arrow()} ${g()})[${pick(['0', '1', '*', '2'])}]${chance(0.6) ? `: {${pick(props.slice(0, 7))}}` : ''}`;
  if (r < 0.68) return pick(props);
  if (r < 0.74) return `${g()}.${pick(props)}`;
  if (r < 0.78 && depth > 0) return `&${pick(['shape', 'label', 'style.fill', 'class'])}: ${pick(['circle', 'red', 'hi', 'k'])}`;
  if (r < 0.8 && depth > 0) return `!&${pick(['shape', 'label'])}: ${pick(['circle', 'hi'])}`;
  if (r < 0.84) return `${g()}: null`;
  if (r < 0.87) return `${g()}: suspend`;
  if (r < 0.9 && ctx.vars) return `${g()}: \${${pick(['v', 'w', 'm.k'])}}`;
  if (r < 0.92 && ctx.imports) return `${g()}: @${pick(ctx.imports)}`;
  if (r < 0.94 && ctx.imports && depth <= 1) return `...@${pick(ctx.imports)}`;
  if (r < 0.96) return `${g()}.class: ${pick(['k', 'k2', 'k, k2'])}`;
  return `${g()}: {\n${block(depth + 1, ctx)}}`;
}

function block(depth, ctx) {
  const n = 1 + Math.floor(rnd() * (depth === 0 ? 8 : 4));
  const out = [];
  for (let i = 0; i < n; i++) out.push(stmt(depth, ctx));
  return out.join('\n') + '\n';
}

function board(ctx) {
  const kind = pick(['layers', 'scenarios', 'steps']);
  const n = 1 + Math.floor(rnd() * 3);
  let s = `${kind}: {\n`;
  for (let i = 0; i < n; i++) s += `  ${kind === 'layers' ? 'l' + (i + 1) : kind[0] + (i + 1)}: {\n${block(1, ctx)}  }\n`;
  return s + '}\n';
}

function program() {
  const ctx = { vars: chance(0.3), imports: chance(0.25) ? ['lib', 'lib.a', 'lib2'] : null };
  let s = '';
  if (ctx.vars) s += `vars: {\n  v: val\n  w: ${chance(0.5) ? 'val2' : '{ x: 1 }'}\n  m: { k: kk }\n}\n`;
  if (chance(0.4)) s += `classes: {\n  k: {${pick(props.slice(0, 6))}}\n  k2: {style.stroke-width: 3; ${chance(0.3) ? 'class: k' : 'shape: square'}}\n}\n`;
  const n = 1 + Math.floor(rnd() * 3);
  const parts = [];
  for (let i = 0; i < n; i++) parts.push(block(0, ctx));
  if (chance(0.3)) parts.push(board(ctx));
  if (chance(0.15)) parts.splice(Math.floor(rnd() * (parts.length + 1)), 0, pick(['*.style.fill: green\n', '**.style.opacity: 0.4\n', '*: {style.stroke: red}\n', '* -> *\n', '**: {label: g}\n', '***.style.fill: pink\n']));
  s += parts.join('');
  const c = { from: `globfuzz:${seed}`, path: 'index.d2', text: s };
  if (ctx.imports) {
    c.fs = {
      'lib.d2': chance(0.5) ? 'a: {x; y}\nb -> a\n*.style.stroke: green\n' : 'a: {style.fill: red; c}\nq\n',
      'lib2.d2': block(1, { vars: false, imports: null }),
    };
  }
  return c;
}

for (let i = 0; i < Number(count); i++) console.log(JSON.stringify(program()));
