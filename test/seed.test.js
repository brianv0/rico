import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parsePr, filesIn, plan, parseArgs } from '../scripts/seed-examples.mjs';
import { detectSpec } from '../public/spec.js';

test('parsePr: the first line is the title, the rest the description', () => {
  assert.deepEqual(parsePr('# A title\n\nBody line.\n\nMore.\n\n'), { title: 'A title', body: 'Body line.\n\nMore.\n' });
  assert.throws(() => parsePr('no heading\nbody'), /must start with/);
});

test('filesIn lists nested files relative to the folder, sorted', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-'));
  fs.mkdirSync(path.join(d, 'a/b'), { recursive: true });
  fs.writeFileSync(path.join(d, 'z.md'), '');
  fs.writeFileSync(path.join(d, 'a/b/c.md'), '');
  assert.deepEqual(filesIn(d), ['a/b/c.md', 'z.md']);
  assert.deepEqual(filesIn(path.join(d, 'missing')), []);
});

test('the examples: each has a title, a description and files, and Rico recognises each as its own review flow', () => {
  const ex = plan();
  assert.deepEqual(ex.map((e) => e.name), ['openspec', 'spec-kit', 'superpowers']);
  const flow = { 'spec-kit': 'speckit', superpowers: 'superpowers', openspec: 'openspec' };
  for (const e of ex) {
    assert.ok(e.title.length > 10 && e.body.length > 200, e.name);
    assert.ok(e.base.length > 0 && e.head.length > 0, e.name);
    assert.deepEqual(e.base.filter((f) => e.head.includes(f)), [], `${e.name}: the pull request only adds files that are not in its base`);
    const found = detectSpec(e.head);
    assert.equal(found?.id, flow[e.name], e.name);
    assert.equal(found.confidence, 'high', e.name);
  }
  assert.throws(() => plan(undefined, ['nope']), /no example "nope"/);
  assert.deepEqual(plan(undefined, ['openspec']).map((e) => e.name), ['openspec']);
});

test('the examples are not mistaken for flows in this repository (their paths are not at its root)', () => {
  const all = plan().flatMap((e) => [...e.base, ...e.head].map((f) => `examples/${e.name}/${f}`));
  assert.equal(detectSpec(all), null);
});

test('parseArgs validates the target and the flags', () => {
  assert.deepEqual(parseArgs(['o/r', '--only', 'x', '--dry-run']), { target: 'o/r', only: ['x'], dryRun: true, dir: '', force: false, trailer: '', owner: 'o', repo: 'r' });
  for (const bad of [[], ['nonsense'], ['../r'], ['o/..'], ['o/r', 'extra'], ['o/r', '--wat']]) assert.throws(() => parseArgs(bad), undefined, JSON.stringify(bad));
});

test('--dry-run lists what would be made and pushes nothing', () => {
  const out = execFileSync(process.execPath, [path.join(import.meta.dirname, '../scripts/seed-examples.mjs'), 'o/r', '--dry-run'], { encoding: 'utf8' });
  assert.match(out, /openspec: branch openspec\/base \(\+2 files from main\), openspec\/pr \(\+5 files\)/);
  assert.match(out, /spec-kit: .*PR "Spec Kit: plan/);
  assert.match(out, /dry run: nothing was pushed to o\/r/);
});
