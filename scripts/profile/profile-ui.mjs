// Browser-side profile of Rico's UI. Real Chromium (CDP) against the real server + a zero-latency synthetic
// GitHub, so what is measured is the client: parsing, DOM build, layout, margin placement, interactions.
// usage: node scripts/profile/profile-ui.mjs [--cpu]   (--cpu prints the hottest functions per scenario)
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startSynth } from './synth.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CPU = process.argv.includes('--cpu');
const THROTTLE = Number(process.env.CPU_THROTTLE || 1); // 4 ~ a mid-range laptop

const browser = await chromium.launch();

const metrics = async (cdp) => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
const diff = (a, b) => ({
  script: (b.ScriptDuration - a.ScriptDuration) * 1000,
  layout: (b.LayoutDuration - a.LayoutDuration) * 1000,
  style: (b.RecalcStyleDuration - a.RecalcStyleDuration) * 1000,
  layouts: b.LayoutCount - a.LayoutCount,
  styles: b.RecalcStyleCount - a.RecalcStyleCount,
  nodes: b.Nodes,
});
const fmt = (d, wall) => `wall=${wall.toFixed(0)}ms script=${d.script.toFixed(0)} layout=${d.layout.toFixed(0)} style=${d.style.toFixed(0)} (${d.layouts} layouts, ${d.styles} style recalcs) nodes=${d.nodes}`;

function hot(profile, n = 8) {
  const self = new Map();
  const byId = new Map(profile.nodes.map((x) => [x.id, x]));
  const dt = profile.timeDeltas;
  profile.samples.forEach((id, i) => {
    const f = byId.get(id).callFrame;
    const k = `${f.functionName || '(anon)'} ${f.url.split('/').pop()}:${f.lineNumber + 1}`;
    self.set(k, (self.get(k) || 0) + (dt[i] || 0) / 1000);
  });
  return [...self].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `      ${v.toFixed(0).padStart(5)}ms  ${k}`).join('\n');
}

async function scenario(name, synthOpts, { interact = true } = {}) {
  const fake = await startSynth({ latencyMs: 0, ...synthOpts });
  const port = 4500 + Math.floor(Math.random() * 400);
  const srv = spawn('node', ['server.js'], { cwd: root, env: { ...process.env, PORT: port, GITHUB_TOKEN: 't', GITHUB_API_URL: `http://127.0.0.1:${fake.port}` } });
  await new Promise((r) => srv.stdout.on('data', (d) => String(d).includes('running') && r()));
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  if (THROTTLE > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
  if (CPU) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 200 }); }
  console.log(`\n## ${name}`);

  // warm the static assets once so we time rendering, not first-ever script download
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => !!window.__rico);

  const m0 = { ScriptDuration: 0, LayoutDuration: 0, RecalcStyleDuration: 0, LayoutCount: 0, RecalcStyleCount: 0 };
  const t0 = Date.now();
  if (CPU) await cdp.send('Profiler.start');
  await page.goto(`http://127.0.0.1:${port}/github.com/acme/docs/7`);
  const eager = Math.min(synthOpts.files, 8);
  await page.waitForFunction((n) => { const r = window.__rico; return r && r.state.pr && [...r.views.values()].filter((v) => v.loaded).length >= n; }, eager, { timeout: 120000 });
  if (synthOpts.diagrams) await page.waitForFunction(() => { const f = [...document.querySelectorAll('figure.dia')]; return f.length && f.every((x) => x.querySelector('.dia-frame, .dia-err')); }, null, { timeout: 120000 });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const wall = Date.now() - t0;
  const m1 = await metrics(cdp);
  console.log(`  load+render (${eager} files x ${synthOpts.lines} lines, ${synthOpts.threads} threads): ${fmt(diff(m0, m1), wall)}`);
  if (CPU) { const { profile } = await cdp.send('Profiler.stop'); console.log('    hottest self time:\n' + hot(profile)); }

  if (interact) {
    const rs0 = await metrics(cdp);
    const tr = Date.now();
    await page.setViewportSize({ width: 1300, height: 900 }); // fires window resize -> layoutAll over every loaded file
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const rs1 = await metrics(cdp);
    console.log(`  window resize (layoutAll): ${fmt(diff(rs0, rs1), Date.now() - tr)}`);

    const sc0 = await metrics(cdp);
    const ts = Date.now();
    await page.evaluate(async () => {
      const h = document.scrollingElement.scrollHeight;
      for (let y = 0; y < h; y += 400) { window.scrollTo(0, y); await new Promise((r) => requestAnimationFrame(r)); }
    });
    const sc1 = await metrics(cdp);
    console.log(`  scroll top->bottom: ${fmt(diff(sc0, sc1), Date.now() - ts)}`);

    // a selection spanning ~40 blocks, then mouseup, as a real drag would end
    for (const span of [5, 40, 400]) {
      const r = await page.evaluate(async (span) => {
        const d = document.getElementById('doc');
        const leaves = [...d.querySelectorAll('[data-l]')].filter((e) => !e.querySelector('[data-l]') && e.textContent.trim());
        if (leaves.length < 3) return null;
        const a = leaves[1], b = leaves[Math.min(leaves.length - 1, 1 + span)];
        a.scrollIntoView({ block: 'start' });
        const range = document.createRange();
        range.setStart(a.firstChild?.nodeType === 3 ? a.firstChild : a, 0);
        range.setEndAfter(b);
        const s = window.getSelection();
        s.removeAllRanges(); s.addRange(range);
        const t = performance.now();
        document.getElementById('cards').dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 300, clientY: 300 }));
        await new Promise((res) => setTimeout(res, 0));
        const ms = performance.now() - t;
        const ok = !!window.__rico.state.sel;
        s.removeAllRanges();
        return { ms, ok, blocks: Math.min(span, leaves.length - 2) };
      }, span);
      if (r) console.log(`  select ~${r.blocks} blocks -> selection bar: ${r.ms.toFixed(0)}ms (sel ${r.ok ? 'set' : 'NOT set'})`);
    }
  }
  await page.close();
  srv.kill();
  await fake.close();
}

const S = (files, lines, threads, diagrams = 0) => ({ files, lines, threads, diagrams });
if (process.env.ONLY === 'diagrams') {
  await scenario('1 file, 300 lines, 10 mermaid + 10 d2 diagrams', S(1, 300, 0, 10), { interact: false });
  await scenario('4 files, 200 lines, 5+5 diagrams each (same sources repeat per file)', S(4, 200, 0, 5), { interact: false });
  await browser.close();
  process.exit(0);
}
await scenario('1 file, 200 lines, 0 threads', S(1, 200, 0));
await scenario('1 file, 1000 lines, 0 threads', S(1, 1000, 0));
await scenario('1 file, 4000 lines, 0 threads', S(1, 4000, 0));
await scenario('1 file, 1000 lines, 100 threads', S(1, 1000, 100));
await scenario('1 file, 1000 lines, 400 threads', S(1, 1000, 400));
await scenario('8 files x 500 lines, 80 threads', S(8, 500, 80));
await browser.close();
