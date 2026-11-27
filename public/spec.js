// Spec-driven development, as a reviewer sees it.
//
// AI spec-driven workflows (Spec Kit, OpenSpec, Superpowers) all write markdown artifacts into the repo and ask a human to
// review them before the agent goes on. This module recognises which workflow a pull request belongs to from its changed
// paths, puts the artifacts in the order a reviewer should read them, and finds the open questions and ids inside them.
// Pure functions only (no DOM, no network), so the same code runs in the browser and in the tests.
//
// Layouts are taken from each project's own templates and docs. Presets and custom schemas can move things, so every
// result carries a `confidence` and the page lets the reviewer switch the mode off or pick another framework.

const natural = (a, b) => String(a).localeCompare(String(b), 'en', { numeric: true });
const base = (p) => p.slice(p.lastIndexOf('/') + 1);

export const ROLE_LABEL = {
  constitution: 'Constitution', spec: 'Spec', checklist: 'Checklist', plan: 'Plan', research: 'Research', 'data-model': 'Data model',
  contract: 'Contract', quickstart: 'Quickstart', tasks: 'Tasks', proposal: 'Proposal', delta: 'Spec changes', current: 'Current spec',
  design: 'Design', 'main-spec': 'Main spec', other: 'Other',
};

/** A short prompt for what to check in each kind of artifact (shown under the step; our wording, not the frameworks'). */
export const ROLE_HINT = {
  spec: 'Is every requirement testable? Are the [NEEDS CLARIFICATION] questions answered, and is anything out of scope?',
  checklist: 'Does the checklist cover what the spec promises?',
  plan: 'Does the plan follow the spec and the constitution, with no surprise technology or scope?',
  research: 'Do the decisions here match the plan?',
  'data-model': 'Do the entities cover every requirement in the spec?',
  contract: 'Do the interfaces cover every requirement in the spec?',
  quickstart: 'Could someone follow this and see the feature work?',
  tasks: 'Does every requirement map to a task, in a sensible order?',
  proposal: 'Does this match what was asked? Is anything out of scope?',
  delta: 'Is every requirement testable, with at least one scenario?',
  current: 'What the spec says today, for comparison with the changes above.',
  design: 'Does the design fit the goal, and are the alternatives fair?',
  constitution: 'The project rules the plan must follow.',
};

// ---------- the frameworks ----------

const SPECKIT_ORDER = { spec: 10, checklist: 20, plan: 30, research: 40, 'data-model': 50, contract: 60, quickstart: 70, tasks: 80 };
function speckitRole(rel) {
  if (rel === 'spec.md') return 'spec';
  if (/^checklists\/.+\.md$/i.test(rel)) return 'checklist';
  if (rel === 'plan.md') return 'plan';
  if (rel === 'research.md') return 'research';
  if (rel === 'data-model.md') return 'data-model';
  if (/^contracts\/.+\.md$/i.test(rel)) return 'contract';
  if (rel === 'quickstart.md') return 'quickstart';
  if (rel === 'tasks.md') return 'tasks';
  return null;
}
export const SPECKIT_CONSTITUTION = ['.specify/memory/constitution.md', 'memory/constitution.md'];

function detectSpeckit(paths) {
  const dirs = new Map();
  const units = [];
  let matched = 0;
  for (const path of paths) {
    if (SPECKIT_CONSTITUTION.includes(path)) {
      units.push({ key: 'constitution', title: 'Constitution', dir: base(path) === path ? '' : path.slice(0, path.lastIndexOf('/')), order: -1, files: [{ path, role: 'constitution', order: 0 }], sure: true });
      matched++;
      continue;
    }
    const m = /^specs\/([^/]+)\/(.+)$/.exec(path);
    if (!m) continue;
    const role = speckitRole(m[2]);
    if (!role) continue;
    matched++;
    if (!dirs.has(m[1])) dirs.set(m[1], { key: `specs/${m[1]}`, title: m[1], dir: `specs/${m[1]}`, order: 0, files: [], sure: /^\d{3,}-/.test(m[1]) });
    dirs.get(m[1]).files.push({ path, role, order: SPECKIT_ORDER[role] });
  }
  for (const u of dirs.values()) {
    u.files.sort((a, b) => a.order - b.order || natural(a.path, b.path));
    u.sure = u.sure || new Set(u.files.map((f) => f.role)).size >= 2;
    units.push(u);
  }
  units.sort((a, b) => a.order - b.order || natural(a.title, b.title));
  return { units, matched, confidence: units.some((u) => u.sure) ? 'high' : 'low' };
}

function detectOpenspec(paths) {
  const changes = new Map();
  const main = [];
  let matched = 0;
  const unit = (key, title, order) => { if (!changes.has(key)) changes.set(key, { key, title, dir: key, order, files: [], sure: true }); return changes.get(key); };
  for (const path of paths) {
    let m = /^openspec\/changes\/archive\/([^/]+)\/(proposal|design|tasks)\.md$/.exec(path);
    if (m) { unit(`openspec/changes/archive/${m[1]}`, `${m[1]} (archived)`, 2).files.push({ path, role: m[2] === 'proposal' ? 'proposal' : m[2], order: { proposal: 10, design: 30, tasks: 40 }[m[2]] }); matched++; continue; }
    m = /^openspec\/changes\/archive\/([^/]+)\/specs\/(.+)\/spec\.md$/.exec(path);
    if (m) { unit(`openspec/changes/archive/${m[1]}`, `${m[1]} (archived)`, 2).files.push({ path, role: 'delta', order: 20, domain: m[2] }); matched++; continue; }
    m = /^openspec\/changes\/([^/]+)\/(proposal|design|tasks)\.md$/.exec(path);
    if (m && m[1] !== 'archive') { unit(`openspec/changes/${m[1]}`, m[1], 0).files.push({ path, role: m[2], order: { proposal: 10, design: 30, tasks: 40 }[m[2]] }); matched++; continue; }
    m = /^openspec\/changes\/([^/]+)\/specs\/(.+)\/spec\.md$/.exec(path);
    if (m && m[1] !== 'archive') { unit(`openspec/changes/${m[1]}`, m[1], 0).files.push({ path, role: 'delta', order: 20, domain: m[2] }); matched++; continue; }
    m = /^openspec\/specs\/(.+)\/spec\.md$/.exec(path);
    if (m) { main.push({ path, role: 'main-spec', order: 10, domain: m[1] }); matched++; }
  }
  const units = [...changes.values()];
  for (const u of units) u.files.sort((a, b) => a.order - b.order || natural(a.domain || a.path, b.domain || b.path));
  if (main.length) units.push({ key: 'openspec/specs', title: 'Main specs', dir: 'openspec/specs', order: 1, files: main.sort((a, b) => natural(a.domain, b.domain)), sure: true });
  units.sort((a, b) => a.order - b.order || natural(a.title, b.title));
  return { units, matched, confidence: 'high' };
}

const SP_RE = /^docs\/superpowers\/(specs|plans)\/(.+\.md)$/;
const spSlug = (file) => file.replace(/\.md$/, '').replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/-design$/, '');
function detectSuperpowers(paths) {
  const byTopic = new Map();
  let matched = 0;
  for (const path of paths) {
    const m = SP_RE.exec(path);
    if (!m) continue;
    matched++;
    const slug = spSlug(base(m[2]));
    if (!byTopic.has(slug)) byTopic.set(slug, { key: `superpowers/${slug}`, title: slug, dir: 'docs/superpowers', order: 0, files: [], sure: true, date: (/^(\d{4}-\d{2}-\d{2})-/.exec(base(m[2])) || [])[1] || '' });
    byTopic.get(slug).files.push(m[1] === 'specs' ? { path, role: 'design', order: 10 } : { path, role: 'plan', order: 20 });
  }
  const units = [...byTopic.values()];
  for (const u of units) u.files.sort((a, b) => a.order - b.order || natural(a.path, b.path));
  units.sort((a, b) => natural(a.date, b.date) || natural(a.title, b.title));
  units.forEach((u, i) => { u.order = i; });
  return { units, matched, confidence: 'high' };
}

export const FRAMEWORKS = [
  { id: 'speckit', name: 'Spec Kit', detect: detectSpeckit },
  { id: 'openspec', name: 'OpenSpec', detect: detectOpenspec },
  { id: 'superpowers', name: 'Superpowers', detect: detectSuperpowers },
];

/**
 * Recognise the workflow from a PR's changed paths. `force` is a framework id to use whatever the paths look like.
 *   -> {id, name, confidence: 'high' | 'low', units: [{key, title, dir, files: [{path, role, order}]}], paths: Set} | null
 */
export function detectSpec(paths, force = '') {
  const list = (paths || []).filter(Boolean);
  let best = null;
  for (const fw of FRAMEWORKS) {
    if (force && fw.id !== force) continue;
    const r = fw.detect(list);
    if (r.matched && (!best || r.matched > best.matched)) best = { ...r, id: fw.id, name: fw.name };
  }
  if (!best) return null;
  return { id: best.id, name: best.name, confidence: best.confidence, units: best.units, paths: new Set(best.units.flatMap((u) => u.files.map((f) => f.path))) };
}

// ---------- reference files: what a reviewer needs beside the changes, but the PR does not touch ----------

/**
 * What to look up on GitHub so unchanged neighbours can sit beside the changed files.
 *   dirs:   directories to list (the unchanged siblings of a changed artifact, e.g. specs/001-x/spec.md next to plan.md)
 *   probes: single files to try (a 404 just means "not there")
 */
export function referencePlan(info, changed = new Set()) {
  const out = { dirs: [], probes: [] };
  if (!info) return out;
  const known = new Set(changed);
  const probe = (path, role, unit, order) => { if (!known.has(path) && !out.probes.some((p) => p.path === path)) out.probes.push({ path, role, unit, order }); };
  if (info.id === 'speckit') {
    for (const u of info.units) {
      if (u.key === 'constitution') continue;
      out.dirs.push({ dir: u.dir, unit: u.key }, { dir: `${u.dir}/checklists`, unit: u.key }); // spec.md sits in the feature folder, requirements.md in its checklists/
    }
    if (info.units.some((u) => u.key !== 'constitution')) probe(SPECKIT_CONSTITUTION[0], 'constitution', '_before', -1);
  } else if (info.id === 'openspec') {
    for (const u of info.units) for (const f of u.files) if (f.role === 'delta' && f.domain && !u.key.includes('/archive/')) probe(`openspec/specs/${f.domain}/spec.md`, 'current', u.key, f.order + 0.5);
  }
  return out;
}

/** Turn one directory listing (names relative to `dir`) into reference entries for the files the PR did not change. */
export function referencesFromListing(info, unitKey, entries, changed = new Set()) {
  const u = info?.units.find((x) => x.key === unitKey);
  if (!u || info.id !== 'speckit') return [];
  const out = [];
  for (const e of entries || []) {
    if (e.type && e.type !== 'file') continue;
    const path = e.path || `${u.dir}/${e.name}`;
    const rel = path.slice(u.dir.length + 1);
    const role = speckitRole(rel);
    if (!role || changed.has(path)) continue;
    out.push({ path, role, unit: unitKey, order: SPECKIT_ORDER[role] });
  }
  return out;
}

/** Files a document points at that a reviewer will want to open (Superpowers plans name their spec). */
export function referencesFromText(info, path, text) {
  if (!info || info.id !== 'superpowers' || !SP_RE.test(path) || !path.includes('/plans/')) return [];
  const m = /\*\*Spec:\*\*\s*`?([^\s`)]+\.md)`?/.exec(text || '');
  if (!m) return [];
  const spec = m[1].replace(/^\.\//, '');
  return [{ path: spec, role: 'design', unit: info.units.find((u) => u.files.some((f) => f.path === path))?.key || '', order: 10 }];
}

// ---------- the review order ----------

/**
 * The artifacts in the order a reviewer should read them: changed files and unchanged references interleaved by role, grouped
 * by feature / change, with any other changed markdown last.
 *   changed:    Set of reviewable (markdown, not removed) changed paths
 *   references: [{path, role, unit, order}] already confirmed to exist
 *   -> [{path, role, label, ref: boolean, unit: key | '', unitTitle}]
 */
export function buildSteps(info, changed, references = []) {
  const steps = [];
  const seen = new Set();
  const add = (s) => { if (!seen.has(s.path)) { seen.add(s.path); steps.push(s); } };
  if (info) {
    const before = references.filter((r) => r.unit === '_before').sort((a, b) => a.order - b.order);
    for (const r of before) add({ path: r.path, role: r.role, label: ROLE_LABEL[r.role] || r.role, ref: true, unit: '', unitTitle: '' });
    for (const u of info.units) {
      const items = [
        ...u.files.filter((f) => changed.has(f.path)).map((f) => ({ path: f.path, role: f.role, order: f.order, ref: false })),
        ...references.filter((r) => r.unit === u.key).map((r) => ({ path: r.path, role: r.role, order: r.order, ref: true })),
      ].sort((a, b) => a.order - b.order || natural(a.path, b.path));
      for (const it of items) add({ path: it.path, role: it.role, label: ROLE_LABEL[it.role] || it.role, ref: it.ref, unit: u.key, unitTitle: u.title });
    }
  }
  for (const p of [...changed].sort(natural)) add({ path: p, role: 'other', label: ROLE_LABEL.other, ref: false, unit: '', unitTitle: info ? 'Other files' : '' });
  return steps;
}

// ---------- markers and ids inside a document ----------

const fenced = (lines) => {
  let open = '';
  return lines.map((l) => {
    const m = /^\s*(```+|~~~+)/.exec(l);
    if (m) { if (!open) { open = m[1][0]; return true; } if (m[1][0] === open) { open = ''; return true; } }
    return !!open;
  });
};

/**
 * Open questions a reviewer is being asked to settle: `[NEEDS CLARIFICATION: …]`, TBD, TODO (not inside code). A question has its
 * reason after the colon; Spec Kit's own checklist says "No [NEEDS CLARIFICATION] markers remain", which is not one.
 * -> [{line, kind, text}]
 */
export function findMarkers(lines) {
  const code = fenced(lines);
  const out = [];
  lines.forEach((l, i) => {
    if (code[i]) return;
    for (const m of l.matchAll(/\[NEEDS CLARIFICATION:\s*([^\]\s][^\]]*)\]|\bTBD\b|\bTODO\b/g)) out.push({ line: i + 1, kind: m[0].startsWith('[') ? 'clarify' : 'todo', text: (m[1] || m[0]).trim() });
  });
  return out;
}

/** The pattern (as source, flags added by the caller) that finds an id in running text. */
export const ID_SRC = String.raw`\b(?:(?:FR|NFR|SC)-\d{1,4}|T\d{3,4}|US\d{1,3}|Task \d{1,3})\b`;
const normId = (s) => String(s).replace(/\s+/g, ' ').trim();
export { normId as normalizeId };

/** Where each id is defined in one document. -> [{id, line, kind}] (line is 1-based) */
export function indexIds(lines) {
  const code = fenced(lines);
  const out = [];
  lines.forEach((l, i) => {
    if (code[i]) return;
    let m;
    if ((m = /^\s*(?:[-*+]|\d+\.)\s+\*\*((?:FR|NFR|SC)-\d{1,4})\*\*/.exec(l)) || (m = /^#{2,6}\s+((?:FR|NFR|SC)-\d{1,4})\b/.exec(l))) out.push({ id: m[1], line: i + 1, kind: 'requirement' });
    else if ((m = /^\s*(?:[-*+]\s+)?(?:\[[ xX]\]\s+)?(T\d{3,4})\b/.exec(l))) out.push({ id: m[1], line: i + 1, kind: 'task' });
    else if ((m = /^#{2,6}\s+User Story (\d{1,3})\b/i.exec(l))) out.push({ id: `US${m[1]}`, line: i + 1, kind: 'story' });
    else if ((m = /^#{2,6}\s+Task (\d{1,3})\b/.exec(l))) out.push({ id: `Task ${m[1]}`, line: i + 1, kind: 'task' });
  });
  return out;
}

/**
 * One id -> definition table over several documents, read in review order (the first definition wins, so FR-001 resolves to the
 * spec, not to a plan that repeats it).  entries: [{path, lines}]  ->  Map(id -> {path, line, kind})
 */
export function buildIdIndex(entries) {
  const map = new Map();
  for (const e of entries) for (const d of indexIds(e.lines)) if (!map.has(d.id)) map.set(d.id, { path: e.path, line: d.line, kind: d.kind });
  return map;
}

/** Counts for the step list: open markers and defined ids in one document. */
export function summarize(lines) {
  const markers = findMarkers(lines);
  return { questions: markers.filter((m) => m.kind === 'clarify').length, todos: markers.filter((m) => m.kind === 'todo').length, ids: indexIds(lines).length };
}
