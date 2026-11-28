# Export a Review as Markdown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a signed-in reviewer copy their whole review on a pull request as one markdown summary.

**Architecture:** A pure formatter in `public/export.js` turns the loaded threads and the verdict into a string. The review dialog gets a "Copy as markdown" button that calls it and writes the result to the clipboard. Nothing is stored and no route is added.

**Tech Stack:** plain JavaScript ES modules, `node:test`, Playwright against the fake GitHub.

**Spec:** `docs/superpowers/specs/2026-11-26-export-review-design.md`

## Global Constraints

- No new runtime dependencies.
- The formatter must not read the DOM or `window`: it takes data in and returns a string, so it is testable without a browser.
- Only the viewer's own threads and replies to them are exported.

## Review Focus

- Does the summary read well pasted into GitHub *and* into a plain text editor (Task 1)?
- Is the "include resolved threads" default the right one (Task 3, and the TBD in the design)?
- Does the button stay out of the way when there is nothing to export (Task 2)?

---

### Task 1: The formatter

**Files:**
- Create: `public/export.js`
- Test: `test/export.test.js`

**Interfaces:**
- Consumes: the thread shape the page already keeps (`{path, start, end, msgs: [{user, body}], info: {resolved}}`) and a verdict string.
- Produces: `formatReview({title, verdict, threads, includeResolved}) -> string`.

- [ ] **Step 1: Write the failing test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatReview } from '../public/export.js';

test('the summary starts with the verdict and the title, then one section per thread', () => {
  const md = formatReview({
    title: 'Plan v2', verdict: 'Request changes',
    threads: [{ path: 'docs/plan.md', start: 6, end: 6, msgs: [{ user: 'me', body: '> too long\n\nTrim it?' }, { user: 'bot', body: 'Done.' }], info: {} }],
  });
  assert.match(md, /^# Request changes: Plan v2\n/);
  assert.match(md, /## docs\/plan\.md, line 6/);
  assert.match(md, /\*\*me\*\*: Trim it\?/);
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `node --test test/export.test.js`
Expected: FAIL, `Cannot find module '../public/export.js'`

- [ ] **Step 3: Write the formatter**

```js
export function formatReview({ title, verdict, threads, includeResolved = false }) {
  const out = [`# ${verdict}: ${title}`, ''];
  for (const t of threads) {
    if (t.info?.resolved && !includeResolved) continue;
    out.push(`## ${t.path}, ${t.start === t.end ? 'line ' + t.start : `lines ${t.start}-${t.end}`}`, '');
    for (const m of t.msgs) out.push(`**${m.user}**: ${m.body.replace(/^>.*\n+/, '').trim()}`, '');
  }
  return out.join('\n').trimEnd() + '\n';
}
```

- [ ] **Step 4: Run it and see it pass**

Run: `node --test test/export.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add public/export.js test/export.test.js
git commit -m "Export: format a review as markdown"
```

### Task 2: The button

**Files:**
- Modify: `public/index.html:62-70` (the review dialog's footer)
- Modify: `public/app.js` (the review dialog handlers)
- Test: `e2e/export.mjs`

**Interfaces:**
- Consumes: `formatReview` from Task 1, and the page's `state.threads`.
- Produces: a "Copy as markdown" button in the review dialog, disabled when the viewer has no threads.

Task 1 must be done first: the button has nothing to call otherwise.

- [ ] **Step 1: Write the failing browser test**

```js
await step('Copy as markdown puts the review on the clipboard, and is off when there is nothing to copy', async () => {
  await page.click('#review-btn');
  assert.equal(await page.locator('#copy-md').isDisabled(), false);
  await page.click('#copy-md');
  const text = await page.evaluate(() => navigator.clipboard.readText());
  assert.match(text, /^# Comment: /);
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `node e2e/export.mjs`
Expected: FAIL, `locator('#copy-md')` not found

- [ ] **Step 3: Add the button and its handler**

```js
// TODO: grant clipboard-write in the test browser's context before this runs
$('#copy-md').addEventListener('click', async () => {
  const md = formatReview({ title: state.pr.title, verdict: verdictLabel(), threads: mineThreads() });
  await navigator.clipboard.writeText(md);
  status('Copied your review as markdown.');
});
```

- [ ] **Step 4: Run it and see it pass**

Run: `node e2e/export.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add public/index.html public/app.js e2e/export.mjs
git commit -m "Export: a Copy as markdown button in the review dialog"
```

### Task 3: Resolved threads

**Files:**
- Modify: `public/export.js`
- Modify: `public/app.js`
- Test: `test/export.test.js`

**Interfaces:**
- Consumes: `formatReview` from Task 1 (its `includeResolved` flag) and the button from Task 2.
- Produces: a checkbox next to the button, "Include resolved threads".

This is where the TBD in the design gets decided. Until it is, the default stays off, as Task 1 has it.

- [ ] **Step 1: Write the failing test**

```js
test('resolved threads are left out unless asked for', () => {
  const t = { path: 'a.md', start: 1, end: 1, msgs: [{ user: 'me', body: 'x' }], info: { resolved: true } };
  assert.doesNotMatch(formatReview({ title: 't', verdict: 'Comment', threads: [t] }), /a\.md/);
  assert.match(formatReview({ title: 't', verdict: 'Comment', threads: [t], includeResolved: true }), /a\.md/);
});
```

- [ ] **Step 2: Run it and see it pass**

Run: `node --test test/export.test.js`
Expected: PASS (Task 1 already handles the flag; this test pins it down)

- [ ] **Step 3: Add the checkbox**

Wire `#include-resolved` to the `includeResolved` argument in the handler from Task 2.

- [ ] **Step 4: Commit**

```bash
git add public/export.js public/app.js test/export.test.js
git commit -m "Export: a checkbox for resolved threads"
```
