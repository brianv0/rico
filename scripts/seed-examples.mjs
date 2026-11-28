#!/usr/bin/env node
// Build the example pull requests in examples/ inside a GitHub repository (see examples/README.md).
//
//   node scripts/seed-examples.mjs owner/repo [--only name]... [--dry-run] [--dir path] [--force] [--trailer "text"]
//
// For each example <name> it makes two branches, <name>/base (from main, plus examples/<name>/base) and <name>/pr (from that,
// plus examples/<name>/head), pushes them, and opens a pull request <name>/pr -> <name>/base with the text in pr.md. An example whose
// pull request is already open is left alone, so it is safe to run again. An empty repository gets a first commit on main (its README).
// Needs GITHUB_TOKEN (or GH_TOKEN) to open the pull requests, and git able to push to the repository.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXAMPLES = path.join(root, 'examples');
const NAME_RE = /^[A-Za-z0-9._-]+$/;

/** pr.md: the first line is "# title", the rest is the description. */
export function parsePr(md) {
  const lines = String(md).replace(/\r/g, '').split('\n');
  const m = /^#\s+(\S.*)$/.exec(lines[0] || '');
  if (!m) throw new Error('pr.md must start with "# title"');
  return { title: m[1].trim(), body: lines.slice(1).join('\n').replace(/^\n+/, '').replace(/\s+$/, '') + '\n' };
}

/** Every file under dir, as paths relative to it ([] when it does not exist). */
export function filesIn(dir) {
  const out = [];
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r); else out.push(r);
    }
  };
  if (fs.existsSync(dir)) walk(dir, '');
  return out.sort();
}

/** The examples under `dir`: [{name, title, body, base: [paths], head: [paths]}], optionally only some. */
export function plan(dir = EXAMPLES, only = []) {
  const names = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'pr.md'))).map((e) => e.name).sort();
  for (const o of only) if (!names.includes(o)) throw new Error(`no example "${o}" (have: ${names.join(', ')})`);
  return names.filter((n) => !only.length || only.includes(n)).map((name) => ({
    name, ...parsePr(fs.readFileSync(path.join(dir, name, 'pr.md'), 'utf8')),
    base: filesIn(path.join(dir, name, 'base')), head: filesIn(path.join(dir, name, 'head')),
  }));
}

export function parseArgs(argv) {
  const a = { target: '', only: [], dryRun: false, dir: '', force: false, trailer: '' };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--dry-run') a.dryRun = true;
    else if (x === '--force') a.force = true;
    else if (x === '--only') a.only.push(argv[++i]);
    else if (x === '--dir') a.dir = argv[++i];
    else if (x === '--trailer') a.trailer = argv[++i];
    else if (x.startsWith('--')) throw new Error(`unknown option ${x}`);
    else if (!a.target) a.target = x;
    else throw new Error(`unexpected argument ${x}`);
  }
  const m = /^([^/\s]+)\/([^/\s]+)$/.exec(a.target);
  if (!m || !NAME_RE.test(m[1]) || !NAME_RE.test(m[2]) || m[1] === '.' || m[1] === '..' || m[2] === '.' || m[2] === '..') throw new Error('usage: seed-examples.mjs owner/repo [--only name] [--dry-run] [--dir path] [--force] [--trailer text]');
  return { ...a, owner: m[1], repo: m[2] };
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const examples = plan(EXAMPLES, a.only);
  if (a.dryRun) {
    for (const e of examples) console.log(`${e.name}: branch ${e.name}/base (+${e.base.length} files from main), ${e.name}/pr (+${e.head.length} files), PR "${e.title}"`);
    console.log(`(dry run: nothing was pushed to ${a.owner}/${a.repo})`);
    return;
  }
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) throw new Error('set GITHUB_TOKEN to open the pull requests');
  const api = async (method, p, body) => {
    const res = await fetch(`https://api.github.com${p}`, { method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'rico-seed', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    if (!res.ok) throw new Error(`GitHub ${method} ${p}: ${res.status} ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
  };

  const dir = a.dir ? path.resolve(a.dir) : fs.mkdtempSync(path.join(os.tmpdir(), 'rico-seed-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const tryGit = (...args) => { try { return git(...args); } catch { return null; } };
  if (!a.dir) execFileSync('git', ['clone', '-q', `https://github.com/${a.owner}/${a.repo}.git`, dir], { stdio: ['ignore', 'inherit', 'inherit'] });
  if (!tryGit('config', 'user.name')) { git('config', 'user.name', 'rico-seed'); git('config', 'user.email', 'rico-seed@users.noreply.github.com'); }
  const msg = (text) => (a.trailer ? `${text}\n\n${a.trailer}` : text);
  const put = (files, srcRoot) => { for (const f of files) { const to = path.join(dir, f); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(path.join(srcRoot, f), to); } };

  // main: an empty repository gets a first commit, so there is something to branch from
  if (tryGit('rev-parse', '--verify', 'main') === null) {
    if (tryGit('rev-parse', '--verify', 'HEAD') !== null) throw new Error('this repository has commits but no "main" branch; seed expects main');
    git('checkout', '-q', '-b', 'main');
    fs.copyFileSync(path.join(EXAMPLES, 'repo-README.md'), path.join(dir, 'README.md'));
    git('add', '-A');
    git('commit', '-q', '-m', msg('Add a README for the examples'));
    git('push', '-q', '-u', 'origin', 'main');
    console.log('main: first commit pushed');
  } else git('checkout', '-q', 'main');

  const results = [];
  for (const e of examples) {
    const open = await api('GET', `/repos/${a.owner}/${a.repo}/pulls?state=open&head=${encodeURIComponent(`${a.owner}:${e.name}/pr`)}&per_page=5`);
    if (open.length && !a.force) { console.log(`${e.name}: pull request #${open[0].number} is already open, left alone`); results.push([e.name, open[0].number]); continue; }
    const push = (branch) => git('push', '-q', ...(a.force ? ['--force'] : []), '-u', 'origin', branch);
    git('checkout', '-q', '-B', `${e.name}/base`, 'main');
    put(e.base, path.join(EXAMPLES, e.name, 'base'));
    git('add', '-A');
    git('commit', '-q', '--allow-empty', '-m', msg(`Example: ${e.name} (the base: what is already merged)`));
    push(`${e.name}/base`);
    git('checkout', '-q', '-B', `${e.name}/pr`, `${e.name}/base`);
    put(e.head, path.join(EXAMPLES, e.name, 'head'));
    git('add', '-A');
    git('commit', '-q', '-m', msg(`Example: ${e.name} (the pull request)`));
    push(`${e.name}/pr`);
    const pr = open[0] || await api('POST', `/repos/${a.owner}/${a.repo}/pulls`, { title: e.title, head: `${e.name}/pr`, base: `${e.name}/base`, body: e.body });
    console.log(`${e.name}: #${pr.number} ${pr.html_url}`);
    results.push([e.name, pr.number]);
    git('checkout', '-q', 'main');
  }
  console.log('\nOpen in Rico:');
  for (const [name, number] of results) console.log(`  ${name}: https://ricorico.dev/github.com/${a.owner}/${a.repo}/${number}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
