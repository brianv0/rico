# Keyboard Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move between review threads with `j` and `k`, and show the shortcuts with `?`.

**Architecture:** One document-level `keydown` handler in `public/app.js` that decides, from the event, whether to act; it calls the existing `focusThread` helper. A small overlay lists the shortcuts.

**Tech Stack:** plain JavaScript ES modules, Playwright against the fake GitHub.

**Spec:** `docs/superpowers/specs/2026-11-28-keyboard-nav-design.md`

## Global Constraints

- Plain letters only: never act when Ctrl, Alt or Meta is held.
- Never act while an input, textarea, select or menu has focus.

## Review Focus

- Does the guard in Task 1 cover every place a reviewer can be typing?
- Does `?` in Task 2 clash with the browser's own shortcuts on any layout?

---

### Task 1: The handler

**Files:**
- Modify: `public/app.js` (next to the `]` / `[` handler)
- Test: `e2e/keys.mjs`

**Interfaces:**
- Consumes: `focusThread(thread)` and the list of threads on the current file.
- Produces: `j` and `k` move to the next and previous thread.

- [ ] **Step 1: Write the failing test**

```js
await step('j and k move between threads, and do nothing while typing', async () => {
  await page.keyboard.press('j');
  await page.waitForSelector('#margin .thread.flash');
  await page.click('#c-body');
  await page.keyboard.type('jjj');
  assert.equal(await page.inputValue('#c-body'), 'jjj'); // typed, not navigated
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `node e2e/keys.mjs`
Expected: FAIL, no thread is flashed

- [ ] **Step 3: Add the handler**

```js
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
  if (e.target.closest?.('input, textarea, select, summary, [contenteditable]')) return;
  if (e.key !== 'j' && e.key !== 'k') return;
  moveThread(e.key === 'j' ? 1 : -1);
});
```

- [ ] **Step 4: Run it and see it pass**

Run: `node e2e/keys.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add public/app.js e2e/keys.mjs
git commit -m "Keys: j and k move between threads"
```

### Task 2: The shortcut overlay

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/style.css`

**Interfaces:**
- Consumes: the handler from Task 1, so the overlay can list its keys.
- Produces: `?` opens a list of the shortcuts; Escape closes it.

Task 1 comes first so the overlay describes keys that exist.

- [ ] **Step 1: Add the overlay markup and styles**

A `<dialog id="keys">` with a short table of the keys.

- [ ] **Step 2: Open it on `?`**

Reuse the guard from Task 1 so it never opens while typing.

- [ ] **Step 3: Commit**

```bash
git add public/index.html public/app.js public/style.css
git commit -m "Keys: ? shows the shortcuts"
```
