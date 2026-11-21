// Generator of D2 programs that exercise what the T1 packages (loops, grouping, proximity, trees) work on: fans of identical leaves (clusters),
// step chains (sequences), trees hanging off cycles, self-loops with labels and arrowheads, hubs, nested containers with edges across their borders.
//   node tala/t1fuzz.mjs [count=500] [seed=1] > t1fuzz.jsonl      then: node tala/t1diff.mjs stages t1fuzz.jsonl --seeds 1,2,3
import fs from 'node:fs';

const [count = '500', seed = '1'] = process.argv.slice(2);
let x = (Number(seed) * 2654435761) >>> 0 || 1;
const rnd = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
const int = (n) => Math.floor(rnd() * n);
const pick = (a) => a[int(a.length)];
const chance = (p) => rnd() < p;

const shapes = ['rectangle', 'rectangle', 'rectangle', 'square', 'circle', 'oval', 'diamond', 'hexagon', 'cylinder', 'page', 'queue', 'person', 'cloud', 'package', 'parallelogram', 'document'];
const arrows = ['->', '->', '->', '<-', '<->', '--'];
const labels = ['', '', '', 'x', 'hello', 'a longer label', 'two\\nlines'];

function Builder() {
  const lines = [];
  let nextId = 0;
  const containers = []; // paths of containers (dotted)
  const nodes = []; // dotted paths of leaf nodes
  const fresh = (prefix) => `${prefix}${nextId++}`;
  const emitNode = (path, attrs = []) => {
    nodes.push(path);
    if (attrs.length) lines.push(`${path}: {\n${attrs.map((a) => '  ' + a).join('\n')}\n}`);
    else lines.push(path);
  };
  const edge = (a, b, opts = {}) => {
    const arrow = opts.arrow ?? pick(arrows);
    const l = opts.label ?? pick(labels);
    const body = [];
    if (chance(0.06)) body.push(`source-arrowhead.shape: ${pick(['diamond', 'circle', 'triangle'])}`);
    if (chance(0.06)) body.push(`target-arrowhead.shape: ${pick(['diamond', 'circle', 'triangle', 'cf-many'])}`);
    if (chance(0.04)) body.push(`target-arrowhead.label: n`);
    let s = `${a} ${arrow} ${b}`;
    if (l) s += `: "${l}"`;
    if (body.length) s += (l ? '' : ': ') + ` {\n  ${body.join('\n  ')}\n}`;
    lines.push(s);
  };
  return { lines, nodes, containers, fresh, emitNode, edge };
}

function shapeAttrs(sameShape) {
  const a = [];
  const s = sameShape ?? (chance(0.5) ? pick(shapes) : 'rectangle');
  if (s !== 'rectangle') a.push(`shape: ${s}`);
  return [a, s];
}

function block(b, prefix) {
  const t = int(12);
  const p = (name) => (prefix ? `${prefix}.${name}` : name);
  // some nodes have a locked position (top and left together)
  const mk = (id, attrs = []) => { const path = p(id); b.emitNode(path, chance(0.06) && !attrs.some((a) => a.startsWith('shape: sql')) ? [...attrs, `top: ${int(400)}`, `left: ${int(400)}`] : attrs); return path; };
  if (t <= 2) {
    // fan of leaves (cluster candidates), out / in / both
    const hub = mk(b.fresh('h'));
    const k = 2 + int(6);
    const [attrs] = shapeAttrs(chance(0.7) ? 'rectangle' : undefined);
    const dir = pick(['out', 'out', 'in', 'both']);
    const arrow = pick(arrows);
    const label = chance(0.2) ? pick(labels) : '';
    const wh = chance(0.3) ? [`width: ${40 + int(80)}`, `height: ${30 + int(60)}`] : [];
    for (let i = 0; i < k; i++) {
      const leaf = mk(b.fresh('l'), [...attrs, ...(chance(0.15) ? [`width: ${30 + int(100)}`] : wh), ...(chance(0.1) ? [`label: ${pick(['X', 'Longer label', 'q'])}`] : [])]);
      if (dir !== 'in') b.edge(hub, leaf, { arrow, label });
      if (dir !== 'out') b.edge(leaf, hub, { arrow, label });
    }
    if (chance(0.4)) b.edge(hub, pick(b.nodes), {});
  } else if (t === 3) {
    // step chain (sequence)
    const k = 2 + int(5);
    const ids = [];
    for (let i = 0; i < k; i++) ids.push(mk(b.fresh('s'), ['shape: step', ...(chance(0.2) ? [`width: ${20 + int(120)}`] : [])]));
    for (let i = 1; i < k; i++) b.edge(ids[i - 1], ids[i], { arrow: '->', label: chance(0.1) ? 'go' : '' });
    if (chance(0.5)) b.edge(pick(b.nodes), pick(ids), {});
    if (chance(0.5)) {
      // a branching tree hanging off a step (a sequence vessel as the sentinel of trees)
      const stepNode = pick(ids);
      for (let i = 0, m = 2 + int(2); i < m; i++) {
        const kid = mk(b.fresh('t'));
        b.edge(stepNode, kid, { arrow: '->', label: '' });
        if (chance(0.5)) b.edge(kid, mk(b.fresh('t')), { arrow: '->', label: '' });
      }
    }
    if (chance(0.3)) b.edge(pick(ids), pick(b.nodes), {});
  } else if (t === 4 || t === 5) {
    // cycle core with trees
    const k = 3 + int(3);
    const core = [];
    for (let i = 0; i < k; i++) core.push(mk(b.fresh('c')));
    for (let i = 0; i < k; i++) b.edge(core[i], core[(i + 1) % k], { arrow: chance(0.8) ? '->' : pick(arrows) });
    const treeCount = 1 + int(3);
    for (let ti = 0; ti < treeCount; ti++) {
      const attach = pick(core);
      const dirOut = chance(0.6);
      const arrow = chance(0.15) ? '--' : '->';
      const grow = (parent, depth) => {
        const kids = depth === 0 ? 1 + int(3) : int(3);
        for (let i = 0; i < kids; i++) {
          const kid = mk(b.fresh('t'));
          if (dirOut) b.edge(parent, kid, { arrow, label: chance(0.15) ? pick(labels) : '' });
          else b.edge(kid, parent, { arrow, label: chance(0.15) ? pick(labels) : '' });
          if (depth < 2 && chance(0.6)) grow(kid, depth + 1);
        }
      };
      grow(attach, 0);
    }
  } else if (t === 6) {
    // self loops
    const n = mk(b.fresh('p'), shapeAttrs()[0]);
    const k = 1 + int(5);
    for (let i = 0; i < k; i++) b.edge(n, n, { arrow: pick(arrows), label: chance(0.6) ? pick(labels) : '' });
    if (chance(0.7)) b.edge(n, pick(b.nodes), {});
  } else if (t === 7) {
    // path / tree not attached to a core: isolated trees, stars
    const root = mk(b.fresh('r'));
    const k = 1 + int(4);
    const arrow = chance(0.2) ? '--' : '->';
    for (let i = 0; i < k; i++) {
      let prev = root;
      const len = 1 + int(3);
      for (let j = 0; j < len; j++) {
        const kid = mk(b.fresh('t'));
        if (chance(0.85)) b.edge(prev, kid, { arrow }); else b.edge(kid, prev, { arrow });
        prev = kid;
      }
    }
  } else if (t === 8) {
    // hub with spokes that also connect elsewhere
    const hub = mk(b.fresh('u'));
    const other = mk(b.fresh('u'));
    b.edge(hub, other, {});
    const k = 1 + int(4);
    for (let i = 0; i < k; i++) b.edge(hub, mk(b.fresh('v'), shapeAttrs()[0]), {});
    if (chance(0.5)) b.edge(other, mk(b.fresh('v')), {});
  } else if (t >= 10) {
    // a table with edges to its columns
    const tb = mk(b.fresh('T'), ['shape: sql_table']);
    const cols = 2 + int(3);
    const colNames = [];
    for (let i = 0; i < cols; i++) { const cn = `c${i}`; b.lines.push(`${tb}.${cn}: int`); colNames.push(`${tb}.${cn}`); }
    for (let i = 0, m = 1 + int(3); i < m; i++) {
      const other = mk(b.fresh('o'));
      if (chance(0.5)) b.edge(other, pick(colNames), {}); else b.edge(pick(colNames), other, {});
    }
    if (chance(0.5)) b.edge(pick(colNames), pick(colNames), {});
  } else {
    // a few free nodes with random edges
    const k = 2 + int(4);
    const ids = [];
    for (let i = 0; i < k; i++) ids.push(mk(b.fresh('n'), [...shapeAttrs()[0], ...(chance(0.2) ? [`width: ${30 + int(150)}`, `height: ${30 + int(100)}`] : [])]));
    const m = int(k + 2);
    for (let i = 0; i < m; i++) b.edge(pick(ids), pick(ids), {});
  }
}

function program() {
  const b = Builder();
  const blocks = 1 + int(4);
  for (let i = 0; i < blocks; i++) block(b, '');
  // containers: wrap some blocks
  const cn = int(3);
  for (let i = 0; i < cn; i++) {
    const c = b.fresh('K');
    const inner = chance(0.3) ? `${c}.${b.fresh('J')}` : c;
    const sub = 1 + int(2);
    for (let j = 0; j < sub; j++) block(b, inner);
    if (chance(0.4)) b.lines.push(`${inner}.label: "Box ${i}"`);
    if (chance(0.15)) b.lines.push(`${c}.direction: ${pick(['up', 'down', 'left', 'right'])}`);
    // edges crossing the border
    const crossings = int(4);
    for (let j = 0; j < crossings; j++) b.edge(pick(b.nodes), pick(b.nodes), {});
  }
  // herds: containers whose children connect to the same outside nodes (the uncles) or to children of the other containers
  if (chance(0.5)) {
    const uncles = [b.fresh('U'), b.fresh('U'), b.fresh('U')].slice(0, 1 + int(3));
    for (const u of uncles) b.emitNode(u, chance(0.3) ? [`shape: ${pick(shapes)}`] : []);
    const boxes = [];
    for (let i = 0, k = 1 + int(3); i < k; i++) {
      const c = b.fresh('H');
      const kids = [];
      for (let j = 0, m = 2 + int(3); j < m; j++) {
        const kid = `${c}.${b.fresh('q')}`;
        b.emitNode(kid, chance(0.2) ? [`width: ${30 + int(120)}`, `height: ${20 + int(80)}`] : []);
        kids.push(kid);
      }
      boxes.push(kids);
      for (const kid of kids) if (chance(0.8)) b.edge(kid, pick(uncles), { arrow: pick(['->', '->', '--']), label: '' });
      if (chance(0.3)) b.edge(kids[0], kids[1], {});
    }
    for (let i = 1; i < boxes.length; i++) if (chance(0.6)) b.edge(pick(boxes[i - 1]), pick(boxes[i]), {});
    if (uncles.length > 1 && chance(0.5)) b.edge(uncles[0], uncles[1], {});
  }
  if (chance(0.3)) b.lines.push(`direction: ${pick(['up', 'down', 'left', 'right'])}`);
  // a few random extra edges
  const extra = int(3);
  for (let j = 0; j < extra; j++) if (b.nodes.length > 1) b.edge(pick(b.nodes), pick(b.nodes), {});
  return b.lines.join('\n');
}

const out = [];
for (let i = 0; i < Number(count); i++) out.push(JSON.stringify({ name: `t1fuzz:${seed}:${i}`, path: 'index.d2', text: program(), layout: 'tala' }));
fs.writeSync(1, out.join('\n') + '\n');
