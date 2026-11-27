import test from 'node:test';
import assert from 'node:assert/strict';
import { detectSpec, buildSteps, referencePlan, referencesFromListing, referencesFromText, findMarkers, indexIds, buildIdIndex, summarize, ID_SRC } from '../public/spec.js';

const speckit = ['README.md', 'specs/002-search/tasks.md', 'specs/001-login/plan.md', 'specs/001-login/spec.md', 'specs/001-login/tasks.md', 'specs/001-login/research.md', 'specs/001-login/data-model.md', 'specs/001-login/contracts/api.yaml', 'specs/001-login/quickstart.md', 'specs/001-login/checklists/requirements.md', 'src/app.js'];

test('Spec Kit: the feature folders are found and read spec -> checklist -> plan -> research -> data model -> quickstart -> tasks', () => {
  const s = detectSpec(speckit);
  assert.equal(s.id, 'speckit');
  assert.equal(s.confidence, 'high');
  assert.deepEqual(s.units.map((u) => u.title), ['001-login', '002-search']);
  assert.deepEqual(s.units[0].files.map((f) => f.role), ['spec', 'checklist', 'plan', 'research', 'data-model', 'quickstart', 'tasks']);
  assert.ok(!s.paths.has('specs/001-login/contracts/api.yaml')); // not markdown: GitHub is the place for it
  assert.ok(!s.paths.has('README.md'));
});

test('Spec Kit: a lone specs/<dir>/notes.md is not a spec; a lone tasks.md under an unnumbered folder is only a guess', () => {
  assert.equal(detectSpec(['specs/foo/notes.md', 'docs/a.md']), null);
  const guess = detectSpec(['specs/payments/tasks.md']);
  assert.equal(guess.id, 'speckit');
  assert.equal(guess.confidence, 'low');
  assert.equal(detectSpec(['specs/payments/spec.md', 'specs/payments/plan.md']).confidence, 'high'); // two kinds of artifact in one folder
});

test('Spec Kit: the constitution comes first, wherever it lives', () => {
  const s = detectSpec(['specs/001-a/spec.md', '.specify/memory/constitution.md']);
  assert.equal(s.units[0].key, 'constitution');
});

test('OpenSpec: proposal, spec changes, design, tasks; archived changes and main specs last', () => {
  const paths = [
    'openspec/changes/add-2fa/tasks.md', 'openspec/changes/add-2fa/design.md', 'openspec/changes/add-2fa/proposal.md',
    'openspec/changes/add-2fa/specs/auth/spec.md', 'openspec/changes/add-2fa/specs/audit/spec.md',
    'openspec/changes/archive/2025-01-24-old/proposal.md', 'openspec/specs/auth/spec.md', 'src/x.js',
  ];
  const s = detectSpec(paths);
  assert.equal(s.id, 'openspec');
  assert.deepEqual(s.units.map((u) => u.title), ['add-2fa', 'Main specs', '2025-01-24-old (archived)']);
  assert.deepEqual(s.units[0].files.map((f) => f.path.split('/').slice(3).join('/')), ['proposal.md', 'specs/audit/spec.md', 'specs/auth/spec.md', 'design.md', 'tasks.md']);
  assert.equal(detectSpec(['openspec/changes/archive/spec.md']), null); // "archive" is the folder, not a change
});

test('Superpowers: a design and its plan travel together, oldest first', () => {
  const paths = ['docs/superpowers/plans/2026-11-02-export.md', 'docs/superpowers/specs/2026-11-02-export-design.md', 'docs/superpowers/specs/2026-10-01-import-design.md', 'docs/guide.md'];
  const s = detectSpec(paths);
  assert.equal(s.id, 'superpowers');
  assert.deepEqual(s.units.map((u) => u.title), ['import', 'export']);
  assert.deepEqual(s.units[1].files.map((f) => f.role), ['design', 'plan']);
});

test('the framework with the most matching files wins; force picks one regardless', () => {
  const mixed = [...speckit.slice(2, 6), 'openspec/changes/x/proposal.md'];
  assert.equal(detectSpec(mixed).id, 'speckit');
  assert.equal(detectSpec(mixed, 'openspec').id, 'openspec');
  assert.equal(detectSpec(mixed, 'superpowers'), null);
  assert.equal(detectSpec([]), null);
  assert.equal(detectSpec(['docs/a.md', 'b.md']), null);
});

test('buildSteps: changed files and unchanged references in review order, other files last', () => {
  const info = detectSpec(['specs/001-login/plan.md', 'specs/001-login/tasks.md', 'README.md']);
  const changed = new Set(['specs/001-login/plan.md', 'specs/001-login/tasks.md', 'README.md']);
  const refs = [
    { path: 'specs/001-login/spec.md', role: 'spec', unit: 'specs/001-login', order: 10 },
    { path: '.specify/memory/constitution.md', role: 'constitution', unit: '_before', order: -1 },
  ];
  const steps = buildSteps(info, changed, refs);
  assert.deepEqual(steps.map((s) => [s.path, s.ref]), [
    ['.specify/memory/constitution.md', true], ['specs/001-login/spec.md', true], ['specs/001-login/plan.md', false], ['specs/001-login/tasks.md', false], ['README.md', false],
  ]);
  assert.equal(steps[1].unitTitle, '001-login');
  assert.equal(steps[4].unitTitle, 'Other files');
  // without a framework it is simply the changed files, in path order
  assert.deepEqual(buildSteps(null, new Set(['b.md', 'a.md'])).map((s) => s.path), ['a.md', 'b.md']);
});

test('references: Spec Kit lists the feature folder and probes the constitution; OpenSpec probes the current spec of each delta', () => {
  const sk = detectSpec(['specs/001-login/plan.md']);
  const plan = referencePlan(sk, new Set(['specs/001-login/plan.md']));
  assert.deepEqual(plan.dirs, [{ dir: 'specs/001-login', unit: 'specs/001-login' }, { dir: 'specs/001-login/checklists', unit: 'specs/001-login' }]);
  assert.deepEqual(plan.probes.map((p) => p.path), ['.specify/memory/constitution.md']);
  const listing = [{ name: 'spec.md', type: 'file' }, { name: 'plan.md', type: 'file' }, { name: 'notes.txt', type: 'file' }, { name: 'contracts', type: 'dir' }, { name: 'tasks.md', type: 'file' }];
  assert.deepEqual(referencesFromListing(sk, 'specs/001-login', listing, new Set(['specs/001-login/plan.md'])).map((r) => [r.path, r.role]), [['specs/001-login/spec.md', 'spec'], ['specs/001-login/tasks.md', 'tasks']]);
  // the listing of checklists/ (names are relative to that folder, paths are not)
  const cl = referencesFromListing(sk, 'specs/001-login', [{ name: 'requirements.md', path: 'specs/001-login/checklists/requirements.md', type: 'file' }], new Set());
  assert.deepEqual(cl.map((r) => [r.path, r.role]), [['specs/001-login/checklists/requirements.md', 'checklist']]);

  const os = detectSpec(['openspec/changes/c/specs/auth/spec.md', 'openspec/changes/archive/old/specs/billing/spec.md']);
  const p2 = referencePlan(os, new Set());
  assert.deepEqual(p2.probes.map((p) => p.path), ['openspec/specs/auth/spec.md']); // archived changes already merged theirs
  assert.equal(referencePlan(null).probes.length, 0);
});

test('references: a Superpowers plan names the design it implements', () => {
  const info = detectSpec(['docs/superpowers/plans/2026-11-02-export.md']);
  const text = '# Export Implementation Plan\n\n> **For agentic workers:** …\n\n**Goal:** x\n**Spec:** `docs/superpowers/specs/2026-11-02-export-design.md`\n';
  assert.deepEqual(referencesFromText(info, 'docs/superpowers/plans/2026-11-02-export.md', text).map((r) => r.path), ['docs/superpowers/specs/2026-11-02-export-design.md']);
  assert.deepEqual(referencesFromText(info, 'docs/superpowers/plans/2026-11-02-export.md', 'no spec line'), []);
  assert.deepEqual(referencesFromText(info, 'docs/other.md', text), []);
});

test('markers: open questions are found outside code fences only', () => {
  const lines = ['# Spec', '- **FR-006**: System MUST authenticate users via [NEEDS CLARIFICATION: auth method not specified - email/password, SSO, OAuth?]', 'TBD later', '```', '[NEEDS CLARIFICATION: in code]', 'TODO', '```', 'Plain text.', 'a TODO here'];
  assert.deepEqual(findMarkers(lines).map((m) => [m.line, m.kind]), [[2, 'clarify'], [3, 'todo'], [9, 'todo']]);
  assert.equal(findMarkers(lines)[0].text, 'auth method not specified - email/password, SSO, OAuth?');
  assert.deepEqual(summarize(lines), { questions: 1, todos: 2, ids: 1 });
});

test('markers: a question has a reason; Spec Kit\'s checklist line that merely names the marker is not one', () => {
  assert.deepEqual(findMarkers(['- [ ] No [NEEDS CLARIFICATION] markers remain', '- [x] Requirements are testable']), []);
  assert.deepEqual(findMarkers(['text [NEEDS CLARIFICATION: ] empty']), []);
  assert.deepEqual(findMarkers(['text [NEEDS CLARIFICATION: which one?] more']).map((m) => [m.kind, m.text]), [['clarify', 'which one?']]);
});

test('ids: requirements, tasks and stories are indexed where they are defined, never inside code', () => {
  const lines = [
    '### User Story 1 - Log in (Priority: P1)', '- **FR-001**: System MUST accept a password.', '* **SC-001**: Users log in within 2s.', '## FR-002: heading form',
    '- [ ] T001 Create the project', '- [x] T010 [P] [US1] Contract test in tests/x.py', 'T011 [US1] bare task', '### Task 3: Importer', '```', '- **FR-099**: no', '```',
    'Mentions FR-001 and T010 in prose are not definitions.',
  ];
  assert.deepEqual(indexIds(lines).map((d) => [d.id, d.line, d.kind]), [['US1', 1, 'story'], ['FR-001', 2, 'requirement'], ['SC-001', 3, 'requirement'], ['FR-002', 4, 'requirement'], ['T001', 5, 'task'], ['T010', 6, 'task'], ['T011', 7, 'task'], ['Task 3', 8, 'task']]);
  const re = new RegExp(ID_SRC, 'g');
  assert.deepEqual('See FR-001, T010 and US2; also Task 3 but not T1 or FR-.'.match(re), ['FR-001', 'T010', 'US2', 'Task 3']);
});

test('the id index follows reading order: the first definition wins', () => {
  const spec = { path: 'spec.md', lines: ['- **FR-001**: in the spec'] };
  const plan = { path: 'plan.md', lines: ['- **FR-001**: repeated in the plan', '- **FR-002**: new'] };
  const idx = buildIdIndex([spec, plan]);
  assert.deepEqual(idx.get('FR-001'), { path: 'spec.md', line: 1, kind: 'requirement' });
  assert.equal(idx.get('FR-002').path, 'plan.md');
});
