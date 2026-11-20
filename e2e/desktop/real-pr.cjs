// Drives real Chrome with OS-level input against LIVE GitHub on brianv0/rico#1. Dry by default;
// RICO_POST=1 submits a real review to that test PR. Run via: REAL_PR=1 bash e2e/desktop/run.sh
// Computer-use style verification: real headed Chrome on Xvfb, OS-level mouse/keyboard via xdotool,
// screenshots of the actual screen. Playwright/CDP is used only to *read* geometry and state.
const { chromium } = require('playwright');
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const sh = (c) => execSync(c, { env: { ...process.env, DISPLAY: ':99', LC_ALL: 'C.UTF-8', LANG: 'C.UTF-8' }, encoding: 'utf8' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = (n) => sh(`import -window root ${__dirname}/out/${n}.png`);
const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log((ok ? 'ok   ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); if (!ok) throw new Error('check failed: ' + name); };

(async () => {
  const browser = await chromium.connectOverCDP('http://localhost:9333');
  const page = browser.contexts()[0].pages()[0];
  const cdp = await browser.contexts()[0].newCDPSession(page);
  const { windowId } = await cdp.send('Browser.getWindowForTarget');
  await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
  await cdp.send('Browser.setWindowBounds', { windowId, bounds: { left: 0, top: 0, width: 1500, height: 950 } });
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForSelector('#doc h1');
  await sleep(600);

  // Calibrate client->screen offset using a real OS mouse move.
  await page.evaluate(() => { window.__m = null; addEventListener('mousemove', (e) => (window.__m = [e.clientX, e.clientY]), true); });
  sh('xdotool mousemove 400 400'); sh('xdotool mousemove 402 401'); await sleep(150);
  const m = await page.evaluate(() => window.__m);
  const off = [402 - m[0], 401 - m[1]];
  console.log('viewport origin on screen:', off, 'inner', await page.evaluate(() => [innerWidth, innerHeight]));
  const S = (x, y) => [Math.round(x + off[0]), Math.round(y + off[1])];
  const move = (x, y) => sh(`xdotool mousemove ${S(x, y).join(' ')}`);
  const click = (x, y) => { move(x, y); sh('xdotool click 1'); };
  const textRect = (t) => page.evaluate((t) => { const w = document.createTreeWalker(document.getElementById('doc'), NodeFilter.SHOW_TEXT); for (let n = w.nextNode(); n; n = w.nextNode()) { const i = n.data.indexOf(t); if (i >= 0) { const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + t.length); const b = r.getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom }; } } return null; }, t);
  const centerOf = (sel, nth = 0) => page.evaluate(([s, n]) => { const e = document.querySelectorAll(s)[n]; const b = e.getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; }, [sel, nth]);
  // Real OS-level drag with intermediate moves.
  const scrollTo = (t) => page.evaluate((t) => { const w = document.createTreeWalker(document.getElementById('doc'), NodeFilter.SHOW_TEXT); for (let n = w.nextNode(); n; n = w.nextNode()) if (n.data.includes(t)) { n.parentElement.scrollIntoView({ block: 'center' }); return; } }, t);
  // Click at the start, scroll, then shift+click at the end: how a person selects more than a screenful.
  async function shiftSelect(from, to) {
    await scrollTo(from); await sleep(250);
    const a = await textRect(from); move(a.l + 1, (a.t + a.b) / 2); sh('xdotool click 1'); await sleep(150);
    await scrollTo(to); await sleep(300);
    const b = await textRect(to); move(b.r - 0.5, (b.t + b.b) / 2);
    sh('xdotool keydown shift click 1 keyup shift'); await sleep(350);
  }
  async function drag(from, to) {
    await scrollTo(from); await sleep(250);
    const a = await textRect(from), b = await textRect(to);
    const [x1, y1] = [a.l + 1, (a.t + a.b) / 2], [x2, y2] = [b.r - 0.5, (b.t + b.b) / 2];
    move(x1, y1); sh('xdotool mousedown 1');
    for (let i = 1; i <= 8; i++) { move(x1 + ((x2 - x1) * i) / 8, y1 + ((y2 - y1) * i) / 8); await sleep(25); }
    sh('xdotool mouseup 1'); await sleep(250);
  }
  const type = (t) => sh(`xdotool type --delay 35 -- '${t.replace(/'/g, "'\\''")}'`);


  shot('real-1-loaded');
  const cards0 = await page.locator('#margin .thread').count();
  check('real threads visible in real Chrome', cards0 >= 5, 'cards=' + cards0);

  // B) selection spanning several hunks (taller than the window, so shift+click)
  await shiftSelect('Fenced code is handled', 'never written to disk');
  const b = await page.locator('#c-range').innerText();
  check('B: cross-hunk selection is clamped and explained', /GitHub can anchor lines \d+[\u2013-]\d+ \(one hunk\)/.test(b), b);
  type('REAL-TEST B: this spans several hunks, so Rico clamps it and quotes the rest.'); sh('xdotool key ctrl+Return'); await sleep(400);

  // C) selection in unchanged text (outside the diff)
  await drag('Review the', 'raw diff');
  const c = await page.locator('#c-range').innerText();
  check('C: unchanged text is routed to the review summary', /outside the diff/.test(c), c);
  type('REAL-TEST C: unchanged text, so it goes to the summary.'); sh('xdotool key ctrl+Return'); await sleep(400);
  shot('real-2-drafts');

  const drafts = await page.evaluate(() => window.__rico.state.comments.map((x) => ({ s: x.start, e: x.end, anchor: x.anchor, quote: x.quote.slice(0, 40) })));
  console.log('queued:', JSON.stringify(drafts));

  if (!process.env.RICO_POST) { console.log('dry run: NOT submitting (set RICO_POST=1 to post a real review to the test PR)'); console.log(results.every(Boolean) ? 'ALL OK (dry)' : 'SOME FAILED'); await browser.close(); return; }
  // add a summary and submit with real clicks
  click(...(await centerOf('#summary'))); type('Second real run: a clamped cross-hunk comment and an unanchorable one.');
  click(...(await centerOf('#submit')));
  await page.waitForSelector('#result a', { timeout: 30000 });
  const link = await page.locator('#result a').getAttribute('href');
  check('Rico reports the review was posted', /pullrequestreview/.test(link), link);
  shot('real-3-posted');
  console.log(results.every(Boolean) ? 'ALL OK' : 'SOME FAILED');
  await browser.close();
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
