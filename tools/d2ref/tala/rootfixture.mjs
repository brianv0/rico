// Builds test/fixtures/tala-root-replay.json: a few recorded Go traces (xdump roottrace) for test/tala-engine.test.js, so the replay of the root
// package (selection, validation, patch, edge-router patch, errors) runs without Go. Needs the Go harness and the corpus files.
//   node tala/rootfixture.mjs [out]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as bigjson from '../../../public/d2/tala/bigjson.js';
import { runGo, loadCases } from './rootlib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = process.argv[2] || path.join(here, '..', '..', '..', 'test', 'fixtures', 'tala-root-replay.json');
const e2e = loadCases(path.join(here, '..', 'tala-e2e.jsonl'));
const corpus = loadCases(path.join(here, '..', 'tala-corpus.jsonl'));
const wanted = [
  ['sanity/connection_label', e2e.find((c) => c.name === 'sanity/connection_label')],
  ['sanity/child_to_child', e2e.find((c) => c.name === 'sanity/child_to_child')],
];
// the rest are picked by what the trace contains
const candidates = [...e2e.slice(0, 160), ...corpus.filter((c, i) => i % 5 === 0).slice(0, 120), ...[521, 659, 835, 866, 1063].map((i) => corpus[i])];
const traces = runGo('roottrace', candidates, 10);
const have = (t, f) => (t.events || []).some(f);
// the smallest trace that has the property
const pick = (label, pred) => {
  let best = null;
  for (const [i, t] of traces.entries()) {
    if (t.panic || !pred(t, candidates[i])) continue;
    if (wanted.some((w) => w[1] === candidates[i])) continue;
    const size = bigjson.stringify(t).length;
    if (best === null || size < best.size) best = { size, c: candidates[i] };
  }
  if (best) wanted.push([label, best.c]);
};
pick('route events (nested layout with routed edges)', (t) => have(t, (e) => e.kind === 'route' && e.graph));
pick('compound candidate kept', (t) => have(t, (e) => e.compound === 'kept'));
pick('compound candidate rejected', (t) => have(t, (e) => e.compound === 'rejected'));
pick('every seed fails (the error text lists them)', (t) => have(t, (e) => e.err && /all TALA seed attempts failed/.test(e.err)));
pick('a D2 compile error (no layout call)', (t) => t.err && !(t.events || []).length);
pick('a TALA error that is not a seed failure', (t) => t.err && have(t, (e) => e.kind === 'layout' && e.err && !/all TALA/.test(e.err)));
const rows = [];
const cases = wanted.map(([, c]) => c);
const goOut = runGo('roottrace', cases, 5);
for (const [i, [label, c]] of wanted.entries()) {
  const o = goOut[i];
  rows.push({ label, case: { name: c.name, path: c.path, text: c.text, seeds: c.seeds, themeID: c.themeID ?? null }, trace: o });
}
fs.writeFileSync(out, bigjson.stringify(rows));
console.log(out, rows.length, 'traces', (fs.statSync(out).size / 1024) | 0, 'KB:', rows.map((r) => r.label).join(' | '));
