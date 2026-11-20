// Computer-use style verification: real headed Chrome on Xvfb, OS-level mouse/keyboard via xdotool,
// screenshots of the actual screen. Playwright/CDP is used only to *read* geometry and state.
const { chromium } = require('playwright');
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const sh = (c) => execSync(c, { env: { ...process.env, DISPLAY: ':99', LC_ALL: 'C.UTF-8', LANG: 'C.UTF-8' }, encoding: 'utf8' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = (n) => sh(`import -window root ${__dirname}/out/${n}.png`);
const readState = () => { for (let i = 0; ; i++) { try { return JSON.parse(fs.readFileSync('/tmp/fake-state.json', 'utf8')); } catch (e) { if (i > 20) throw e; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); } } };
const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log((ok ? 'ok   ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); };

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
  // Find text across element boundaries (syntax highlighting splits code into many spans).
  const findText = (t) => page.evaluate((t) => {
    const w = document.createTreeWalker(document.getElementById('doc'), NodeFilter.SHOW_TEXT);
    const nodes = []; let full = '';
    for (let n = w.nextNode(); n; n = w.nextNode()) { nodes.push({ n, start: full.length }); full += n.data; }
    const i = full.indexOf(t);
    if (i < 0) return null;
    const loc = (pos) => { for (let k = nodes.length - 1; k >= 0; k--) if (nodes[k].start <= pos) return { node: nodes[k].n, off: pos - nodes[k].start }; };
    const a = loc(i), z = loc(i + t.length - 1);
    const r = document.createRange(); r.setStart(a.node, a.off); r.setEnd(z.node, z.off + 1);
    const rs = r.getClientRects(); const f = rs[0], l = rs[rs.length - 1];
    return { l: f.left, r: l.right, t: l.top, b: l.bottom };
  }, t);
  const textRect = findText;
  const centerOf = (sel, nth = 0) => page.evaluate(([s, n]) => { const e = document.querySelectorAll(s)[n]; const b = e.getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; }, [sel, nth]);
  // Real OS-level drag with intermediate moves.
  let shotBar = true;
  async function drag(from, to) {
    const a = await textRect(from), b = await textRect(to);
    const [x1, y1] = [a.l + 1, (a.t + a.b) / 2], [x2, y2] = [b.r - 0.5, (b.t + b.b) / 2];
    move(x1, y1); sh('xdotool mousedown 1');
    for (let i = 1; i <= 8; i++) { move(x1 + ((x2 - x1) * i) / 8, y1 + ((y2 - y1) * i) / 8); await sleep(25); }
    sh('xdotool mouseup 1'); await sleep(250);
    // the selection offers two margin icons; click the "lines" one with the real pointer
    await page.waitForSelector('#selbar:not([hidden])', { timeout: 3000 });
    if (shotBar) shot('os-selbar');
    shotBar = false;
    click(...(await centerOf('#sb-lines'))); await sleep(250);
  }
  const type = (t) => sh(`xdotool type --delay 35 -- '${t.replace(/'/g, "'\\''")}'`);

  shot('os-wide');
  const wide = await page.evaluate(() => getComputedStyle(document.querySelector('#margin .thread')).position);
  check('wide window uses the side margin layout', wide === 'absolute', wide);

  // 1. hover a thread with the real pointer
  const cardNamed = (t) => page.evaluate((t) => { const e = [...document.querySelectorAll('#margin .thread')].find((c) => c.innerText.includes(t)); const b = e.getBoundingClientRect(); return [b.left + b.width / 2, b.top + 20]; }, t);
  move(...(await cardNamed('Will trim it'))); await sleep(250);
  check('hovering a thread highlights its text', (await page.locator('#doc .hl').count()) === 2);
  shot('os-hover');
  move(5, 5);

  // 2. drag-select across two paragraphs
  await drag('First paragraph', 'across two');
  await page.waitForSelector('#composer:not([hidden])', { timeout: 3000 });
  check('composer floats over the selection', true);
  check('composer says lines 3–6', (await page.locator('#c-range').innerText()) === 'Comments on lines 3–6', await page.locator('#c-range').innerText());
  check('textarea has keyboard focus (typing goes straight in)', await page.evaluate(() => document.activeElement.id) === 'c-body');
  type('Tighten this whole section - it repeats itself.');
  await sleep(200); shot('os-composer');
  sh('xdotool key ctrl+Return'); await sleep(300);
  check('comment queued with the exact text typed', (await page.evaluate(() => window.__rico.state.comments.map((c) => c.body)))[0] === 'Tighten this whole section - it repeats itself.');

  // 3. selection spanning two hunks -> clamped, explained
  await drag('item two', 'const a');
  const note = await page.locator('#c-range').innerText();
  check('cross-hunk selection is clamped and explained', /GitHub can anchor lines 9–10 \(one hunk\)/.test(note), note);
  type('This spans a hunk boundary.'); sh('xdotool key ctrl+Return'); await sleep(300);

  // 4. reply from the margin using real clicks + keyboard
  click(...(await page.evaluate(() => { const c = [...document.querySelectorAll('#margin .thread')].find((x) => x.innerText.includes('Will trim it')); const b = c.querySelector('.tacts button').getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; }))); await sleep(250);
  type('Agreed - will shorten it.'); sh('xdotool key ctrl+Return'); await sleep(700);
  const replies = readState().replies;
  check('reply reached GitHub', replies.length === 1 && replies[0].to === 101 && replies[0].body === 'Agreed - will shorten it.', JSON.stringify(replies));
  shot('os-reply');

  // 5. submit the review with a real click
  await page.evaluate(() => window.scrollTo(0, 0));
  click(...(await centerOf('#review-btn'))); await page.waitForSelector('#review-pop:not([hidden])'); await sleep(200); // GitHub's flow: Review changes, then Submit
  click(...(await centerOf('#submit')));
  await page.waitForSelector('#result a', { timeout: 5000 });
  await sleep(500);
  const posted = readState().posted;
  check('review posted once', posted.length === 1);
  const c = posted[0].comments;
  check('multi-line anchor 3–6 on RIGHT', c[0].start_line === 3 && c[0].line === 6 && c[0].side === 'RIGHT' && c[0].body === '> First paragraph here.\n>\n> Second paragraph is hard wrapped across two\n\nTighten this whole section - it repeats itself.', JSON.stringify(c[0]));
  check('clamped anchor 9–10 carries the header, the prose quote and the code as a fenced block', c[1].start_line === 9 && c[1].line === 10 && c[1].body === '_Selected lines 9–12; anchored to lines 9–10._\n\n> item two\n\n```js\nconst a = 1;\n```\n\nThis spans a hunk boundary.', JSON.stringify(c[1]).slice(0, 200));
  shot('os-submitted');

  console.log(results.every(Boolean) ? 'ALL OK' : 'SOME FAILED');
  await browser.close();
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
