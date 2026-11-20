// Server-side GitHub profile: how many upstream calls, how serialized, what a reload costs.
// usage: node scripts/profile/profile-server.mjs [latencyMs=120]
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startSynth } from './synth.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LAT = Number(process.argv[2] || 120);

async function scenario(name, synthOpts, { fileFetches = 0 } = {}) {
  const fake = await startSynth({ latencyMs: LAT, ...synthOpts });
  const port = 4900 + Math.floor(Math.random() * 90);
  const srv = spawn('node', ['server.js'], { cwd: root, env: { ...process.env, PORT: port, GITHUB_TOKEN: 't', GITHUB_API_URL: `http://127.0.0.1:${fake.port}` } });
  await new Promise((r) => srv.stdout.on('data', (d) => String(d).includes('running') && r()));
  const get = async (p) => {
    const t = performance.now();
    const r = await fetch(`http://127.0.0.1:${port}${p}`);
    const b = await r.text();
    return { ms: performance.now() - t, bytes: Buffer.byteLength(b), status: r.status, h: r.headers };
  };
  const summarize = (label) => {
    const l = fake.log;
    let maxPar = 0;
    for (const a of l) maxPar = Math.max(maxPar, l.filter((b) => b.start < a.end && b.end > a.start).length);
    const cost = l.filter((x) => x.status !== 304).length;
    console.log(`  ${label}: upstream calls=${l.length} (rate-limit cost=${cost}) max-parallel=${maxPar} upstream-bytes=${l.reduce((n, x) => n + x.bytes, 0)}`);
  };
  console.log(`\n## ${name}  (upstream latency ${LAT}ms)`);
  fake.reset();
  const pr = await get('/api/pr?ref=acme/docs%237');
  console.log(`  /api/pr: ${pr.ms.toFixed(0)}ms, ${(pr.bytes / 1024).toFixed(0)}KB to browser, all-serial floor=${fake.log.length * LAT}ms`);
  summarize('cold /api/pr');
  fake.reset();
  const pr2 = await get('/api/pr?ref=acme/docs%237');
  console.log(`  /api/pr again (reload/refresh): ${pr2.ms.toFixed(0)}ms`);
  summarize('warm /api/pr');
  fake.reset();
  const n = Math.min(fileFetches || synthOpts.files, synthOpts.files);
  const q = (i) => `/api/file?owner=acme&repo=docs&ref=abc1234def5678&path=docs/f${i}.md`;
  const f1 = await get(q(0));
  console.log(`  /api/file Cache-Control: ${f1.h.get('cache-control')}  (sha-pinned content is immutable)`);
  fake.reset();
  const t = performance.now();
  await Promise.all(Array.from({ length: n }, (_, i) => get(q(i))));
  console.log(`  first-paint file loads (${n} files, parallel): ${(performance.now() - t).toFixed(0)}ms`);
  summarize(`${n} x /api/file`);
  fake.reset();
  await get(q(0));
  summarize('same file fetched again');
  srv.kill();
  await fake.close();
}

await scenario('small PR: 3 md files, 6 comments', { files: 3, lines: 200, threads: 6 });
await scenario('medium PR: 12 md files, 20 non-md, 250 comments', { files: 12, lines: 300, extraNonMd: 20, threads: 250 }, { fileFetches: 8 });
await scenario('large PR: 40 md files, 400 non-md, 600 comments', { files: 40, lines: 300, extraNonMd: 400, threads: 600 }, { fileFetches: 8 });
