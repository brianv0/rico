// The other modes of tala/rootcheck.mjs: validate (error injection into the result validation), score, driver, compound.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as bigjson from '../../../public/d2/tala/bigjson.js';
import * as graphjson from '../../../public/d2/tala/graphjson.js';
import * as lg from '../../../public/d2/tala/layoutgraph.js';
import { background, withCancel } from '../../../public/d2/tala/context.js';
import { registerPackage } from '../../../public/d2/tala/stagepkgs.js';
import * as engine from '../../../public/d2/tala/engine.js';
import * as result from '../../../public/d2/tala/result.js';
import { runGo, loadCases } from './rootlib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

const clone = (v) => bigjson.parse(bigjson.stringify(v));
const flagOf = (flags) => (n, d) => { const i = flags.indexOf(n); return i < 0 ? d : flags[i + 1] ?? true; };

// a small deterministic generator (mulberry32)
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sortKeys = (v) => (Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v);
function firstDiff(a, b, p = '$') {
  if (JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b))) return null;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) { const d = firstDiff(a[k], b[k], `${p}.${k}`); if (d) return d; }
  }
  return { path: p, got: JSON.stringify(a)?.slice(0, 300), want: JSON.stringify(b)?.slice(0, 300) };
}

// ---- validate: error injection -----------------------------------------------------------------------------------------------------------

const sameID = (a, b) => BigInt(a) === BigInt(b);

/** replaces node ID `from` by `to` everywhere in a graphjson value */
function renameNode(g, from, to) {
  const fix = (v) => (v !== null && v !== undefined && typeof v !== 'object' && sameID(v, from) ? to : v);
  for (const n of g.nodes) {
    n.id = fix(n.id);
    if (n.nears) n.nears = n.nears.map(fix);
  }
  for (const e of g.edges) { e.from = fix(e.from); e.to = fix(e.to); }
  for (const key of ['containers', 'hubs']) {
    if (!g[key]) continue;
    const out = {};
    for (const [k, list] of Object.entries(g[key])) out[sameID(k, from) ? String(to) : k] = list.map(fix);
    g[key] = out;
  }
}

const pickOf = (rand, list) => list[Math.floor(rand() * list.length)];
const STYLE_KEYS = ['opacity', 'stroke', 'fill', 'fillPattern', 'strokeWidth', 'strokeDash', 'borderRadius', 'shadow', '3d', 'multiple', 'font', 'fontSize', 'fontColor', 'animated', 'bold', 'italic', 'underline', 'filled', 'doubleBorder', 'textTransform'];

/** each mutator returns its name, or null when it does not apply to these graphs; r = result, i = input (both graphjson values) */
const MUTATORS = [
  ['none', () => 'none'],
  ['drop-node', (r, i, R) => { if (!r.nodes.length) return null; r.nodes.splice(Math.floor(R() * r.nodes.length), 1); return 'drop-node'; }],
  ['node-nopos', (r, i, R) => { const n = pickOf(R, r.nodes); if (!n) return null; n.topLeft = null; return 'node-nopos'; }],
  ['node-x-huge', (r, i, R) => { const n = pickOf(R, r.nodes); if (!n) return null; n.topLeft = { x: 2e9, y: 3 }; return 'node-x-huge'; }],
  ['node-y-neg-huge', (r, i, R) => { const n = pickOf(R, r.nodes); if (!n) return null; n.topLeft = { x: 3, y: -1.5e9 }; return 'node-y-neg-huge'; }],
  ['node-w-zero', (r, i, R) => { const n = pickOf(R, r.nodes); if (!n) return null; n.width = 0; return 'node-w-zero'; }],
  ['node-h-neg', (r, i, R) => { const n = pickOf(R, r.nodes); if (!n) return null; n.height = -4; return 'node-h-neg'; }],
  ['node-w-huge', (r, i, R) => { const n = pickOf(R, r.nodes); if (!n) return null; n.width = 5e9; return 'node-w-huge'; }],
  ['node-bounds-overflow', (r, i, R) => { const n = pickOf(R, r.nodes); if (!n) return null; n.topLeft = { x: 1.7e308, y: 1 }; n.width = 1.7e308; return 'node-bounds-overflow'; }],
  ['node-label-w-neg', (r, i, R) => { const n = pickOf(R, r.nodes.filter((x) => x.label)); if (!n) return null; n.label.Width = -1; return 'node-label-w-neg'; }],
  ['node-label-h-huge', (r, i, R) => { const n = pickOf(R, r.nodes.filter((x) => x.label)); if (!n) return null; n.label.Height = 1e10; return 'node-label-h-huge'; }],
  ['node-id', (r, i, R) => { const n = pickOf(R, r.nodes); if (!n) return null; renameNode(r, n.id, 4999999999); return 'node-id'; }],
  ['node-shape', (r, i, R) => { const n = pickOf(R, r.nodes); if (!n) return null; n.shapeType = n.shapeType === 'Circle' ? 'Square' : 'Circle'; return 'node-shape'; }],
  ['node-columns', (r, i, R) => { const n = pickOf(R, r.nodes); if (!n) return null; n.numColumns = (n.numColumns || 0) + 1; return 'node-columns'; }],
  ['node-3d', (r, i, R) => { const n = pickOf(R, r.nodes); if (!n) return null; n.is3D = !n.is3D; return 'node-3d'; }],
  ['node-multiple', (r, i, R) => { const n = pickOf(R, r.nodes); if (!n) return null; n.isMultiple = !n.isMultiple; return 'node-multiple'; }],
  ['node-invisible', (r, i, R) => { const n = pickOf(R, r.nodes); if (!n) return null; n.isInvisible = !n.isInvisible; return 'node-invisible'; }],
  ['node-fixed', (r, i, R) => { const n = pickOf(R, r.nodes); if (!n) return null; n.fixedTopLeft = n.fixedTopLeft ? null : { x: 1, y: 2 }; return 'node-fixed'; }],
  ['node-fixed-moved', (r, i, R) => { const n = pickOf(R, r.nodes.filter((x) => x.fixedTopLeft)); if (!n) return null; n.fixedTopLeft = { x: n.fixedTopLeft.x + 1, y: n.fixedTopLeft.y }; return 'node-fixed-moved'; }],
  ['node-desired', (r, i, R) => { const n = pickOf(R, r.nodes); if (!n) return null; n.desiredWidth = (n.desiredWidth || 0) + 7; return 'node-desired'; }],
  ['node-desired-h', (r, i, R) => { const n = pickOf(R, r.nodes); if (!n) return null; if (n.desiredHeight) delete n.desiredHeight; else n.desiredHeight = 9; return 'node-desired-h'; }],
  ['node-force-hierarchy', (r, i, R) => { const n = pickOf(R, r.nodes); if (!n) return null; n.forceHierarchy = !n.forceHierarchy; return 'node-force-hierarchy'; }],
  ['node-label-text', (r, i, R) => { const n = pickOf(R, r.nodes.filter((x) => x.label)); if (!n) return null; n.label.Text += 'x'; return 'node-label-text'; }],
  ['node-label-drop', (r, i, R) => { const n = pickOf(R, r.nodes.filter((x) => x.label)); if (!n) return null; delete n.label; return 'node-label-drop'; }],
  ['node-label-position', (r, i, R) => { const n = pickOf(R, r.nodes.filter((x) => x.label)); if (!n) return null; n.label.Position = n.label.Position === 'INSIDE_TOP_LEFT' ? 'OUTSIDE_BOTTOM_RIGHT' : 'INSIDE_TOP_LEFT'; return 'node-label-position'; }],
  ['node-icon', (r, i, R) => { const n = pickOf(R, r.nodes); if (!n) return null; if (n.icon) delete n.icon; else n.icon = { Position: 'INSIDE_TOP_LEFT' }; return 'node-icon'; }],
  ['node-icon-position', (r, i, R) => { const n = pickOf(R, r.nodes.filter((x) => x.icon)); if (!n) return null; n.icon.Position = 'OUTSIDE_TOP_RIGHT'; return 'node-icon-position'; }],
  ['node-fontsize-bad', (r, i, R) => { const n = pickOf(R, r.nodes.filter((x) => x.fontSize)); if (!n) return null; n.fontSize = 7; return 'node-fontsize-bad'; }],
  ['node-fontsize-ok', (r, i, R) => { const n = pickOf(R, r.nodes.filter((x) => x.fontSize)); if (!n) return null; n.fontSize = n.fontSize === 28 ? 24 : 28; return 'node-fontsize-ok'; }],
  ['node-fontsize-drop', (r, i, R) => { const n = pickOf(R, r.nodes.filter((x) => x.fontSize)); if (!n) return null; delete n.fontSize; return 'node-fontsize-drop'; }],
  ['node-container', (r, i, R) => {
    const n = pickOf(R, r.nodes); if (!n) return null;
    for (const list of Object.values(r.containers)) { const k = list.findIndex((x) => sameID(x, n.id)); if (k >= 0) list.splice(k, 1); }
    const parents = Object.keys(r.containers).filter((k) => !sameID(k, 0) && !sameID(k, n.id));
    const target = parents.length && R() < 0.7 ? pickOf(R, parents) : '0';
    r.containers[target] = [...(r.containers[target] || []), n.id];
    return 'node-container';
  }],
  ['drop-edge', (r, i, R) => { if (!r.edges.length) return null; r.edges.splice(Math.floor(R() * r.edges.length), 1); return 'drop-edge'; }],
  ['drop-all-edges', (r) => { if (!r.edges.length) return null; r.edges = []; return 'drop-all-edges'; }],
  ['edge-id', (r, i, R) => { const e = pickOf(R, r.edges); if (!e) return null; e.id = 4888888888; return 'edge-id'; }],
  ['edge-dup', (r, i, R) => { const e = pickOf(R, r.edges); if (!e) return null; r.edges.push(clone(e)); return 'edge-dup'; }],
  ['edge-endpoints', (r, i, R) => { const e = pickOf(R, r.edges); if (!e || r.nodes.length < 2) return null; const other = r.nodes.find((n) => !sameID(n.id, e.to) && !sameID(n.id, e.from)); if (!other) return null; e.to = other.id; return 'edge-endpoints'; }],
  ['edge-swap', (r, i, R) => { const e = pickOf(R, r.edges); if (!e) return null; [e.from, e.to] = [e.to, e.from]; return 'edge-swap'; }],
  ['edge-short-route', (r, i, R) => { const e = pickOf(R, r.edges); if (!e) return null; e.points = e.points.slice(0, 1); return 'edge-short-route'; }],
  ['edge-no-route', (r, i, R) => { const e = pickOf(R, r.edges); if (!e) return null; e.points = []; return 'edge-no-route'; }],
  ['edge-point-x-huge', (r, i, R) => { const e = pickOf(R, r.edges.filter((x) => x.points.length)); if (!e) return null; e.points[Math.floor(R() * e.points.length)].x = 3e9; return 'edge-point-x-huge'; }],
  ['edge-point-y-huge', (r, i, R) => { const e = pickOf(R, r.edges.filter((x) => x.points.length)); if (!e) return null; e.points[Math.floor(R() * e.points.length)].y = -3e9; return 'edge-point-y-huge'; }],
  ['edge-point-null', (r, i, R) => { const e = pickOf(R, r.edges.filter((x) => x.points.length)); if (!e) return null; e.points[Math.floor(R() * e.points.length)] = null; return 'edge-point-null'; }],
  ['edge-percentage', (r, i, R) => { const e = pickOf(R, r.edges); if (!e) return null; e.labelPercentage = 1.5; return 'edge-percentage'; }],
  ['edge-percentage-neg', (r, i, R) => { const e = pickOf(R, r.edges); if (!e) return null; e.labelPercentage = -0.25; return 'edge-percentage-neg'; }],
  ['edge-label-w', (r, i, R) => { const e = pickOf(R, r.edges.filter((x) => x.label)); if (!e) return null; e.label.Width = -3; return 'edge-label-w'; }],
  ['edge-label-h-huge', (r, i, R) => { const e = pickOf(R, r.edges.filter((x) => x.label)); if (!e) return null; e.label.Height = 2e9; return 'edge-label-h-huge'; }],
  ['edge-label-text', (r, i, R) => { const e = pickOf(R, r.edges.filter((x) => x.label)); if (!e) return null; e.label.Text += '!'; return 'edge-label-text'; }],
  ['edge-label-add', (r, i, R) => { const e = pickOf(R, r.edges.filter((x) => !x.label)); if (!e) return null; e.label = { Text: 'new', Position: '', Width: 5, Height: 6 }; return 'edge-label-add'; }],
  ['edge-label-drop', (r, i, R) => { const e = pickOf(R, r.edges.filter((x) => x.label)); if (!e) return null; delete e.label; return 'edge-label-drop'; }],
  ['edge-label-position', (r, i, R) => { const e = pickOf(R, r.edges.filter((x) => x.label)); if (!e) return null; e.label.Position = 'UNLOCKED_TOP'; return 'edge-label-position'; }],
  ['edge-src-arrow', (r, i, R) => { const e = pickOf(R, r.edges); if (!e) return null; e.sourceArrowhead = e.sourceArrowhead === 'diamond' ? 'none' : 'diamond'; return 'edge-src-arrow'; }],
  ['edge-dst-arrow', (r, i, R) => { const e = pickOf(R, r.edges); if (!e) return null; e.targetArrowhead = e.targetArrowhead === 'diamond' ? 'none' : 'diamond'; return 'edge-dst-arrow'; }],
  ['edge-src-label', (r, i, R) => { const e = pickOf(R, r.edges); if (!e) return null; if (e.sourceArrowheadLabel) e.sourceArrowheadLabel.Text += 'x'; else e.sourceArrowheadLabel = { Text: 's', Position: '', Width: 3, Height: 4 }; return 'edge-src-label'; }],
  ['edge-dst-label-w', (r, i, R) => { const e = pickOf(R, r.edges.filter((x) => x.targetArrowheadLabel)); if (!e) return null; e.targetArrowheadLabel.Width += 1; return 'edge-dst-label-w'; }],
  ['edge-dst-label-neg', (r, i, R) => { const e = pickOf(R, r.edges.filter((x) => x.targetArrowheadLabel)); if (!e) return null; e.targetArrowheadLabel.Height = -1; return 'edge-dst-label-neg'; }],
  ['edge-dst-label-pos', (r, i, R) => { const e = pickOf(R, r.edges.filter((x) => x.targetArrowheadLabel)); if (!e) return null; e.targetArrowheadLabel.Position = 'INSIDE_TOP_LEFT'; return 'edge-dst-label-pos'; }],
  ['edge-min', (r, i, R) => { const e = pickOf(R, r.edges); if (!e) return null; e.minWidth += 1; return 'edge-min'; }],
  ['edge-min-h', (r, i, R) => { const e = pickOf(R, r.edges); if (!e) return null; e.minHeight += 1; return 'edge-min-h'; }],
  ['edge-column', (r, i, R) => { const e = pickOf(R, r.edges); if (!e) return null; e.fromTableColumnIndex = (e.fromTableColumnIndex ?? -1) + 1; return 'edge-column'; }],
  ['edge-column-to', (r, i, R) => { const e = pickOf(R, r.edges.filter((x) => x.toTableColumnIndex !== undefined)); if (!e) return null; delete e.toTableColumnIndex; return 'edge-column-to'; }],
  ['edge-invisible', (r, i, R) => { const e = pickOf(R, r.edges); if (!e) return null; e.isInvisible = !e.isInvisible; return 'edge-invisible'; }],
  ...STYLE_KEYS.map((k) => [`edge-style-${k}`, (r, i, R) => {
    const e = pickOf(R, r.edges); if (!e) return null;
    e.style = e.style || {};
    if (e.style[k]) delete e.style[k]; else e.style[k] = { value: 'x' };
    return `edge-style-${k}`;
  }]),
  ['edge-style-value', (r, i, R) => { const e = pickOf(R, r.edges.filter((x) => x.style && Object.keys(x.style).length)); if (!e) return null; const k = Object.keys(e.style)[0]; e.style[k] = { value: e.style[k].value + '1' }; return 'edge-style-value'; }],
  ['root-hierarchy', (r) => { r.isRootHierarchy = !r.isRootHierarchy; return 'root-hierarchy'; }],
  ['direction-root', (r) => { r.directions = { ...(r.directions || {}), 0: 'RIGHT' }; return 'direction-root'; }],
  ['direction-drop', (r) => { if (!r.directions || !Object.keys(r.directions).length) return null; delete r.directions[Object.keys(r.directions)[0]]; return 'direction-drop'; }],
  ['direction-node', (r, i, R) => { const n = pickOf(R, r.nodes); if (!n) return null; r.directions = { ...(r.directions || {}), [String(n.id)]: 'LEFT' }; return 'direction-node'; }],
  ['direction-change', (r) => { if (!r.directions || !Object.keys(r.directions).length) return null; const k = Object.keys(r.directions)[0]; r.directions[k] = r.directions[k] === 'UP' ? 'DOWN' : 'UP'; return 'direction-change'; }],
  ['extra-node', (r, i, R) => { const n = pickOf(R, r.nodes); if (!n) return null; const c = clone(n); c.id = 4777777777; c.d2id = 'extra'; r.nodes.push(c); r.containers['0'] = [...(r.containers['0'] || []), c.id]; return 'extra-node'; }],
  ['extra-edge', (r, i, R) => { const e = pickOf(R, r.edges); if (!e) return null; const c = clone(e); c.id = 4666666666; r.edges.push(c); return 'extra-edge'; }],
  ['dup-node', (r, i, R) => { const n = pickOf(R, r.nodes); if (!n) return null; r.nodes.push(clone(n)); return 'dup-node'; }],
  ['input-drop-edge', (r, i, R) => { if (!i.edges.length) return null; i.edges.splice(Math.floor(R() * i.edges.length), 1); return 'input-drop-edge'; }],
  ['input-dup-edge', (r, i, R) => { const e = pickOf(R, i.edges); if (!e) return null; i.edges.push(clone(e)); return 'input-dup-edge'; }],
  ['input-drop-node', (r, i, R) => { if (!i.nodes.length) return null; i.nodes.splice(Math.floor(R() * i.nodes.length), 1); return 'input-drop-node'; }],
  ['input-dup-node', (r, i, R) => { const n = pickOf(R, i.nodes); if (!n) return null; i.nodes.push(clone(n)); return 'input-dup-node'; }],
  ['input-label', (r, i, R) => { const n = pickOf(R, i.nodes.filter((x) => x.label)); if (!n) return null; n.label.Position = 'INSIDE_TOP_RIGHT'; return 'input-label'; }],
  ['input-icon', (r, i, R) => { const n = pickOf(R, i.nodes); if (!n) return null; n.icon = { Position: 'OUTSIDE_TOP_LEFT' }; return 'input-icon'; }],
  ['input-edge-label-pos', (r, i, R) => { const e = pickOf(R, i.edges.filter((x) => x.label)); if (!e) return null; e.label.Position = 'UNLOCKED_MIDDLE'; return 'input-edge-label-pos'; }],
  ['input-edge-arrow-label-pos', (r, i, R) => { const e = pickOf(R, i.edges.filter((x) => x.targetArrowheadLabel)); if (!e) return null; e.targetArrowheadLabel.Position = 'INSIDE_BOTTOM_RIGHT'; return 'input-edge-arrow-label-pos'; }],
];

/** the (input, result) pairs of layout events of roottrace outputs: the adapter graph and the final graph, and the seeds' graphs */
function basePairs(events) {
  const out = [];
  for (const ev of events) {
    if (ev.kind !== 'layout' || !ev.final || !ev.adapter) continue;
    out.push({ input: ev.adapter, result: ev.final });
  }
  return out;
}

async function validate(file, flags) {
  const flag = flagOf(flags);
  const nBases = Number(flag('--bases', 90));
  const perBase = Number(flag('--per', 24));
  const seed = Number(flag('--seed', 1));
  const cache = flag('--cache', '/tmp/rootcheck-bases.json');
  let bases;
  if (fs.existsSync(cache) && !flags.includes('--refresh')) bases = bigjson.parse(fs.readFileSync(cache, 'utf8'));
  else {
    const cases = loadCases(file);
    const outs = runGo('roottrace', cases, 10);
    bases = outs.flatMap((o) => basePairs(o.events || []));
    fs.writeFileSync(cache, bigjson.stringify(bases));
  }
  const R = rng(seed);
  // spread the bases over the whole list, prefer the bigger ones (more nodes and edges to mutate)
  const picked = [];
  const order = bases.map((b, k) => k).sort(() => R() - 0.5);
  for (const k of order) { if (picked.length < nBases) picked.push(bases[k]); }
  const cases = [];
  for (const base of picked) {
    const names = new Set();
    for (let t = 0; t < perBase * 3 && names.size < perBase; t++) {
      const [name, f] = pickOf(R, MUTATORS);
      if (names.has(name)) continue;
      const r = clone(base.result), i = clone(base.input);
      let label;
      try { label = f(r, i, R); } catch (e) { continue; }
      if (!label) continue;
      names.add(name);
      cases.push({ mutation: label, graph: r, args: { input: i } });
    }
  }
  const goOut = runGo('rootcheck', cases, 40);
  const ctx = background();
  let same = 0, skipped = 0, unmarshalSame = 0;
  const bad = [];
  const kinds = {};
  const msgs = new Set();
  for (const [k, c] of cases.entries()) {
    const want = goOut[k];
    if (want.panic) { skipped++; continue; }
    const got = jsRootCheck(ctx, c);
    // Go names an ARBITRARY missing edge (it ranges over a map): with several edges missing the ID is not comparable
    const unstable = (o) => (c.mutation === 'drop-all-edges' ? JSON.parse(JSON.stringify(o).replace(/missing edge ID \d+/g, 'missing edge ID N')) : o);
    const d = firstDiff(unstable(got), unstable(bigjson.plain(want)));
    kinds[c.mutation] ||= { n: 0, fail: 0 };
    kinds[c.mutation].n++;
    if (want.inputErr || want.resultErr) unmarshalSame += d ? 0 : 1;
    if (d) { bad.push({ k, mutation: c.mutation, ...d }); kinds[c.mutation].fail++; } else {
      same++;
      for (const f of ['completed', 'topology', 'metadata', 'evaluate']) if (want[f]) msgs.add(String(want[f]).replace(/\d+/g, 'N'));
    }
  }
  console.log(`validate: ${same}/${cases.length - skipped} identical to Go (${picked.length} base graphs, ${Object.keys(kinds).length} mutations; ${unmarshalSame} rejected by Unmarshal alike on both sides); ${msgs.size} distinct error messages`);
  if (flags.includes('--msgs')) console.log([...msgs].sort().join('\n'));
  for (const b of bad.slice(0, Number(flag('--show', 6)))) console.log(`\n#${b.k} ${b.mutation}\n  at ${b.path}\n  got  ${b.got}\n  want ${b.want}`);
  process.exitCode = bad.length ? 1 : 0;
}

function jsRootCheck(ctx, c) {
  const inputGraph = lg.newGraph();
  try {
    graphjson.unmarshal(ctx, c.args.input, inputGraph);
  } catch (e) {
    return { inputErr: e.message };
  }
  const resultGraph = lg.newGraph();
  try {
    graphjson.unmarshal(ctx, c.graph, resultGraph);
  } catch (e) {
    return { resultErr: e.message };
  }
  const run = (f) => {
    try { f(); return ''; } catch (e) { if (e instanceof Error && e.name === 'GoError') return e.message; return 'panic'; }
  };
  let seq = null;
  const out = {};
  out.completed = run(() => result.validateCompletedGraph(ctx, resultGraph));
  out.topology = run(() => { seq = result.validateLayoutResultTopology(ctx, inputGraph, resultGraph); });
  out.metadata = run(() => result.validateLayoutResultMetadata(ctx, inputGraph, resultGraph, seq ?? new Set()));
  out.evaluate = run(() => result.evaluateSeedResult(ctx, { graph: inputGraph, bindings: null }, resultGraph));
  return out;
}

// ---- score ------------------------------------------------------------------------------------------------------------------------------

async function score() {
  const vals = [0, 1, 2.5, -1, -0.0, 1e300, 'NaN', '+Inf', '-Inf', 0.1, 99, 100];
  const pairs = [];
  for (const a of vals) for (const b of vals) for (const c of [0, 5, -3, '+Inf', 'NaN']) for (const d of [0, 5, -3, '+Inf', 'NaN']) pairs.push([a, c, b, d]);
  const goOut = runGo('rootscore', [{ args: { pairs } }], 1)[0];
  const num = (v) => (v === '+Inf' ? Infinity : v === '-Inf' ? -Infinity : v === 'NaN' ? NaN : v);
  let bad = 0;
  pairs.forEach(([p1, a1, p2, a2], k) => {
    const got = new result.LayoutScore(num(p1), num(a1)).compare(new result.LayoutScore(num(p2), num(a2)));
    if (got !== goOut.cmp[k]) { bad++; if (bad < 5) console.log('differs', [p1, a1, p2, a2], got, goOut.cmp[k]); }
  });
  console.log(`score: ${pairs.length - bad}/${pairs.length} comparisons identical to Go (layoutScore.compare: NaN, +-Inf, negative, zero areas)`);
  process.exitCode = bad ? 1 : 0;
}

export async function run(mode, file, flags) {
  if (mode === 'validate') return validate(file, flags);
  if (mode === 'score') return score();
  if (mode === 'driver') return (await import('./rootdriver.mjs')).driver(file, flags);
  if (mode === 'wiring') return (await import('./rootwiring.mjs')).wiring(file, flags);
  if (mode === 'compound') return (await import('./rootdriver.mjs')).compound(file, flags);
  console.error('usage: rootcheck.mjs replay|validate|score|driver|compound ...');
  process.exit(2);
}
