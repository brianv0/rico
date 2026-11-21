# Rico — formal specification

Companion to [`requirements.md`](requirements.md). That document says *what the product should do and why*; this one states the
core of it **precisely enough to check**: a domain model, functions with pre/postconditions, invariants, and state machines, plus
normative UI rules written as testable predicates.

**How to read the checking status.**
- ✅ **Tested** — an executable property in `test/properties.test.js` (200 seeded random cases each; run `node --test test/properties.test.js`).
  I confirmed the suite can fail by injecting two bugs into `lib.js` (clamp choosing the *smallest* overlap; `start_side` hard-coded) — INV-A1 and INV-R2 caught them; the code was restored.
- 🔶 **Specified, partly covered** — by the existing unit or e2e tests, not by a property.
- ⬜ **Specified, unchecked** — nothing verifies it today (this is where the formal model is *ahead* of the test suite).
- ❌ **Violated** — the current code does not satisfy it; ties to a gap in `requirements.md` §15.

Keywords **MUST / MUST NOT / SHOULD / MAY** are used as in RFC 2119.

---

## 1. Domain model

```
Side      = {LEFT, RIGHT}                       LEFT = base/old file line numbers, RIGHT = head/new file line numbers
Line      = ℕ⁺                                  1-based
Range     = {s, e}  with  1 ≤ s ≤ e
Hunk      = {left: Range | ∅, right: Range | ∅}  contiguous lines of one @@ block, per side
Patch     = Row*,  Row = hunk | ctx(o,n) | add(n) | del(o) | meta
              add has only n, del only o, ctx both          (INV-D3)
Diff(F)   = ⟨hunks_R, added⟩ derived from Patch(F)         hunks_R = right ranges of all hunks, added ⊆ ⋃ hunks_R
Selection = ⟨range: DOM range, side, [s,e], segments, touchesRemoved⟩
Anchor    = ⟨s, e, exact⟩ | ⊥                       ⊥ = "outside the diff"
Draft     = ⟨id, path, side, [s,e], anchor: Anchor|⊥, quote, body, includeQuote, quoteMd, about⟩
Thread    = ⟨id, path, side, [s,e], msgs⁺, outdated, fileLevel⟩    outdated ⇔ root.line = null
Queue     = Draft* , keyed by (owner, repo, number, headSha)       persisted in the browser only
Review    = ⟨commit_id, event ∈ {COMMENT, APPROVE, REQUEST_CHANGES}, body?, comments: Inline*⟩
Inline    = ⟨path, line, side, body, [start_line, start_side]⟩
```

**Environment.** `GitHub` is the only system of record. The UI process owns `Queue`, `Viewed ⊆ Path`, `Theme ∈ {auto, light, dark}`.
Hosted mode adds a `Session`. Rico never mutates GitHub except through two operations: `postReview(Review)` and `postReply(threadId, text)`.

---

## 2. Functions, with contracts

### 2.1 `clampRange(s, e, H) → Anchor | ⊥`  (`lib.js`)
*Pre:* `s ≤ e`, `H` a list of `Range`s (RIGHT hunks for RIGHT comments, LEFT hunks for LEFT comments).
*Post:*
1. `result = ⊥ ⇔ ∀h∈H. [s,e] ∩ h = ∅`.
2. Otherwise `result.[s,e] ⊆ [s,e]` **and** `⊆ h` for a single `h∈H` — GitHub's one-hunk rule.
3. `|result|` is the maximum of `|[s,e] ∩ h|` over `h∈H` (ties: first hunk).
4. `result.exact ⇔ result.[s,e] = [s,e]`.

⇒ **INV-A1** ✅ (checks 1–4), **INV-A2** ✅ idempotence: `clamp(clamp(x)) = clamp(x)` with `exact = true`.

### 2.2 `buildReview(Queue, summary, event, commitId) → Review`
*Post:*
- **INV-R1** ✅ *Conservation.* Each draft body appears exactly once, either as an `Inline` or inside `Review.body`; `|inline| = |{d : d.anchor ≠ ⊥}|`.
- **INV-R2** ✅ *GitHub well-formedness.* For anchored `d`: `line = anchor.e`; `start_line = anchor.s` and `start_side = side` **iff** `anchor.s < anchor.e`; `side = d.side` (default RIGHT).
- **INV-R3** ✅ *Nothing unanchored loses context.* Every `d` with `anchor = ⊥` appears in `Review.body` **with its quote**. `commit_id` and `event` are passed through unchanged.
- **INV-R4** ✅ *No silent clamping.* Every non-exact inline body states "Selected lines a–b; anchored to lines c–d."
- **INV-R5** ✅ Empty queue and blank summary ⇒ no `body`, no `comments`.

*Not yet specified by code* ⬜: ordering of `comments` (currently queue order); behaviour when two drafts anchor the same line (both posted).

### 2.3 Diff parsing (`parsePatch`, `parsePatchRows`, `patchHunkRanges`, `patchDeletions`, `oldToNewMap`)
- **INV-D1** ✅ `parsePatch.hunks = { h.right | h ∈ patchHunkRanges(rows), h.right ≠ ∅ }` and `added = { r.n | r ∈ rows, r.type = add }`. (Two independent parsers of the same text must agree.)
- **INV-D2** ✅ New numbers strictly increase over `add`/`ctx` rows; old numbers over `del`/`ctx` rows.
- **INV-D3** ✅ Side typing of rows as in §1.
- **INV-D4** ✅ `patchDeletions` partitions exactly the `del` rows into disjoint ascending runs.
- **INV-D5** ✅ `oldToNewMap` is defined exactly on `ctx` rows and maps `o ↦ n`.
- Consequence used by the UI: a `del` row is commentable on LEFT only; an `add` row on RIGHT only; a `ctx` row on both. 🔶 (unit-tested; the UI's choice of side from a click is not property-tested.)

### 2.4 Selection → source mapping (`locateLine`, `trimBlock`)
- **INV-S1** ✅ `trimBlock` returns `{s,e}` with `s = start+1`, `e ≥ s`, `e ≤ end`.
- **INV-S2** ✅ `locateLine(block, info) ∈ [block.s, block.e]` for *any* input — a mapping error can only make a comment coarser, never place it outside the block it was made in.
- **INV-S3** ✅ If rendered word count ≠ source word count, the result is the block edge (`s` for `start`, `e` for `end`). This is the safety valve behind "coarser but never wrong".
- **Spec (⬜, DOM-level):** for a selection whose ends lie in leaf blocks `B_a … B_z` (document order, new side), `[s,e] ⊇ [B_a.s … B_z.e]` is **not** required, but `B_a.s ≤ s` and `e ≤ B_z.e` MUST hold. Covered by e2e examples, not by a property.

### 2.5 Presentation helpers
- **INV-V1** ✅ `previewLines`: `|head| + omitted + |tail| = total`; a gap marker MUST NOT hide fewer than 2 lines.
- **INV-V2** ✅ `statBlocks` = 5 squares of the form `g*r*n*`; `g` present ⇔ additions > 0; `r` present ⇔ deletions > 0.
- **INV-V3** ✅ `buildFileTree` contains every file exactly once; at each level directories precede files.
- **INV-Q1** ✅ `formatQuote`: `[] ↦ ""`; every opened code fence is closed; `plainQuote` keeps one entry per segment.

### 2.6 Addressing and safety
- **INV-U1** ✅ `parsePrPath(prPath(ref, sha))` returns `ref`, with `sha` truncated to 7 characters.
- **INV-U2** ✅ `.`/`..` MUST NOT be accepted as owner or repo (prevents `/repos/../x` collapsing out of the API prefix).

---

## 3. State machines

Notation: `state --event [guard] / action--> state`.

### 3.1 Selection, pill and composer
States: `Idle`, `Pill(sel)`, `Composer(sel, text)`. Let `dirty ⇔ text ≠ ""` (trimmed).

```
Idle         --select [mapped(sel)]              / showPill(sel)           --> Pill(sel)
Idle         --select [¬mapped(sel)]                                       --> Idle
Pill(sel)    --selectionCleared | Esc            / hidePill                --> Idle
Pill(sel)    --select'                           / showPill(sel')          --> Pill(sel')
Pill(sel)    --click(quote | lines)              / includeQuote := …       --> Composer(sel, "")
Composer(s,t)--select' [¬dirty]                  / replace                 --> Pill(sel')
Composer(s,t)--select' [dirty]                   / pulse                   --> Composer(s,t)      (never clobbers)
Composer(s,t)--selectionCleared [¬dirty ∧ ¬element ∧ ¬rows] / close        --> Idle
Composer(s,t)--⌘↵ | Add [t.trim ≠ ""]            / enqueue; persist        --> Idle
Composer(s,t)--⌘↵ | Add [t.trim = ""]            / focus                   --> Composer(s,t)
Composer(s,t)--Esc | Cancel                      / close                   --> Idle
```
- **SM-1** ⬜ `Composer` with `dirty` is never replaced by a new selection or pill. (Implemented in `onSelect` via the pulse; no test types text and then makes a second selection.)
- **SM-2** ❌ **Composer(dirty) MUST survive** `openFile`, `setMode`, and theme change. *Today* `openFile`/`setMode` call `hideComposer()` and the theme button reloads the page, so typed text is lost without warning. (Req. FR-CMP-10.) Required form: `--navigate | setMode | theme [dirty] / stash(t) --> …` and `Esc/Cancel [dirty] / confirm`.
- **SM-3** ❌ In `Pill`, a keyboard path MUST exist: `Pill(sel) --shortcut(c) --> Composer(sel,"")`. Today only a pointer click leaves `Pill`. (FR-SEL-4.)
- **SM-4** ❌ A signed-out visitor MUST NOT reach `Composer`: `Pill(sel) --click [preview] / explainSignIn --> Pill(sel)`. Today the composer opens and only the server rejects the write. (FR-ID-3.)

### 3.2 Draft lifecycle
```
         ⌘↵                 Submit ok               Delete
(none) ───────▶ Pending ───────────────▶ Posted    Pending ───▶ (none)
                  │  Edit(body)  ▲
                  └──────────────┘        Submit fail: Pending (unchanged)
```
- **DR-1** ⬜ A failed `postReview` leaves every draft `Pending` and re-enables Submit. (Implemented in the submit handler's `catch`/`finally`; no e2e forces a failure.) **DR-2** 🔶 A successful one empties the queue and the summary (e2e *review is posted with correct anchors* covers the post; Submit is disabled while in flight by construction).
- **DR-3** ❌ *Draft visibility across heads.* `Queue` is keyed by `headSha`. If the PR's head moves from `A` to `B` between sessions, `Queue(A)` is unreachable from the UI. **Spec:** on load, `Orphans = ⋃ Queue(x) for x ≠ head` MUST be listed with actions {re-anchor, discard}; re-anchoring SHOULD match each stored `quote` against the new file, and unmatched drafts MUST be flagged. (FR-ENT-6.)
- **DR-4** ⬜ `Queue` writes are atomic per change; a storage failure MUST be announced once (today silent).

### 3.3 Review submission
```
Closed --open--> Open --Esc | outside | ×--> Closed
Open --Submit [|Q|>0 ∨ summary≠""]--> Submitting --200--> Posted(url) → Queue := ∅
                                      Submitting --error--> Open + error(Queue intact)
```
- **RV-1** ⬜ Submit enabled ⇔ `|Q| > 0 ∨ summary.trim ≠ ""`.
- **RV-2** ✅(e2e) One review per Submit, pinned to `commitId = loaded head` (INV-R3).
- **RV-3** ⬜ SHOULD warn before Submit when `∃d. d.anchor = ⊥` (will go to the summary) or when `loaded head ≠ current head`. (FR-REV-8.)
- **RV-4** ⬜ Primary button label SHOULD reflect the verdict (`Submit approval` / `Request changes`). (FR-REV-9.)

### 3.4 File view
Per file `f`: `Unloaded → Loading → Loaded`, orthogonal flags `collapsed`, `mode ∈ {rendered, source}`, `viewed`.
- **FV-1** ⬜ `viewed ⇒ collapsed` at the moment of ticking (GitHub parity); un-collapsing a viewed file does not clear `viewed`.
- **FV-2** 🔶 Opening an unloaded file from the tree loads it, expands it, scrolls to it and updates the URL, in that order.
- **FV-3** ✅(e2e *a click made while the initial load is still running…*) Eager load is limited to the first 8 files; a user opening file `g` during that load MUST NOT be pulled back to the first file.
- **FV-4** ⬜ `activeFile` SHOULD follow scroll position, not just the last click. (FR-TREE-6.)

### 3.5 Identity and mode
`Mode ∈ {Local, Hosted(signedIn), Hosted(preview)}`.
- **ID-1** 🔶 Local: no sign-in UI. **ID-2** ✅(`worker.test.js` *preview…*) Preview: reads allowed for public PRs; every write returns 401 with `signin: true`; the UI links to sign-in. **ID-3** ✅(`worker.test.js` *split sessions…*) Sign-out deletes the KV entry (when bound) so a copied cookie is dead.
- **ID-4** ❌ In Preview, the UI MUST prevent *composing* (SM-4), not just posting.
- **ID-5** ⬜ After sign-in the user returns to the same `(PR, file)`; scroll position SHOULD be restored.

---

## 4. Layout and rendering constraints (checkable predicates)

Let `thread` rectangles be those in one file's margin, sorted by anchor top `t_i`, heights `h_i`, final tops `y_i`.

- **LY-1** ✅(by construction) `y_1 = t_1`; `y_{i+1} = max(t_{i+1}, y_i + h_i + 8)`. ⇒ **no overlap** and **no item above its anchor**.
- **LY-2** ✅ `marginHeight = max(y_n + h_n + 8, docHeight)`; therefore the margin never clips and never shortens the card.
- **LY-3** ✅ Layout is recomputed on resize, font load, image/diagram size change, thread expand/collapse, reply-box toggle, file load (ResizeObserver + explicit calls). 🔶 e2e covers some.
- **LY-4** ✅ Viewport `≤ 1150px` ⇒ margin is static (stacked); the composer falls back to selection-relative placement and flips above when it would leave the viewport.
- **LY-5** ⬜ *No overlap of composer and document text* when a margin exists (composer left ≥ margin left).
- **LY-6** ❌ **No horizontal page scroll** at 320, 768, 1150, 1440 px. Not asserted anywhere.
- **GU-1** ✅ Gutter class of a leaf block `b` (RIGHT blocks): `chg` if `b` contains an `added` line and file not newly added; else `ctx` if `b` intersects a hunk; else `out`. Removed blocks (`.rm`) carry only LEFT comments.

### Accessibility predicates (target; ⬜ unless noted)
- **A11Y-1** Every information-bearing colour has a non-colour equivalent (gutter bars, red/green blocks, drafts). ❌ gutter bars are colour-only.
- **A11Y-2** Every action reachable by pointer is reachable by keyboard: selection→comment (SM-3), diagram elements (FR-DIA-5), Source `+` (FR-SRC-5). ❌
- **A11Y-3** `prefers-reduced-motion: reduce` ⇒ no `pulse`, no animated `top`, no smooth scroll. ❌
- **A11Y-4** Status ⇒ `role=status`; errors ⇒ `role=alert`; both visible without scrolling. ❌ (FR-ERR-1)
- **A11Y-5** Contrast ≥ 4.5:1 text, ≥ 3:1 UI/graphics, both themes. ⬜ (the light-theme grey `--out` bar is ≈1.6:1).

---

## 5. Security properties (stated as safety invariants)

- **SEC-1** The GitHub token is never present in any response body or header sent to the browser. 🔶 (server/worker tests)
- **SEC-2** Every state-changing request carries `X-Rico: 1`; cross-site pages cannot satisfy this without a preflight the server never grants. 🔶
- **SEC-3** (local) Requests whose `Host` is not loopback are rejected (DNS-rebinding). 🔶
- **SEC-4** Every HTML response carries CSP, `X-Frame-Options: DENY`, `nosniff`. 🔶 Script-src is `'self'`; the only `eval`-shaped allowances are D2's WASM and its layout worker.
- **SEC-5** `∀ markdown/HTML m from a PR: render(m)` contains no `form, button, iframe, object, embed, style, link, meta, base`, no `style=` attribute, and only *disabled checkbox* `<input>`s. 🔶 (DOMPurify config + tests)
- **SEC-6** Diagram source executes nothing: rendered in `<iframe sandbox="allow-same-origin">` (no `allow-scripts`) with a CSP forbidding all network. 🔶
- **SEC-7** Relative image `src` resolves only to the PR head via `/api/raw`, only for image extensions; other relative targets are removed, not requested. 🔶
- **SEC-8** (hosted) A cached response is shared only if produced with the *preview* credential; authenticated responses are never edge-cached. ⬜ — worth a test, because the failure (leaking a private PR to anonymous visitors) is severe.

---

## 6. What this formalization does *not* establish
1. **It does not model the DOM.** The pure layer (§2) is property-tested; the bridge from a browser `Range` to `[s,e]` (§2.4 spec) and every state machine in §3 are specified here but verified only by example-based e2e tests, or not at all (⬜/❌).
2. **The ❌ items are real defects or omissions**, found by writing the contract and checking it against the code: SM-2, SM-3, SM-4/ID-4, DR-3, LY-6, A11Y-1…5. They match the P0/P1 list in `requirements.md` §15.
3. **Generators are my model of "well-formed".** `genPatch` produces valid diffs with correct `@@` counts; it does not generate malformed or adversarial patches (`\ No newline`, CRLF, hunks GitHub truncates for size). Add those before treating INV-D* as complete.
4. **No model checker was used.** The state machines are tables meant to be turned into a transition-coverage test (drive the UI through every edge once) or a small XState/TLA⁺ model if the composer logic keeps growing.

## 7. Suggested next steps (in order of payoff)
1. Fix and then lock SM-2 / SM-3 / SM-4 / DR-3 with e2e tests named after the rule IDs.
2. Add SEC-8 (cache never shares authenticated responses) to `test/worker.test.js`.
3. Extend generators with adversarial patches; add a round-trip property *render → select → anchor ⊆ block* in the headless e2e (§2.4 spec).
4. Add an `a11y` pass (axe in the existing Playwright run) for A11Y-1/3/4/5, and a viewport sweep for LY-6.

## 8. Traceability
| Rule(s) | Requirement(s) | Check |
|---|---|---|
| INV-A1/A2 | FR-CMP-3, PC-1 | `properties.test.js` |
| INV-R1–R5 | FR-REV-5, FR-CMP-4, PC-4 | `properties.test.js`, `lib.test.js` |
| INV-D1–D5 | FR-RND-3/4, FR-SRC-1, FR-THR-5 | `properties.test.js`, `lib.test.js` |
| INV-S1–S3 | FR-SEL-5 | `properties.test.js`, `lib.test.js`, e2e |
| INV-U1/U2 | FR-ENT-1/2, §10.3 | `properties.test.js`, `lib.test.js` |
| INV-V1–V3, INV-Q1 | FR-CARD-1, FR-TREE-1, FR-CMP-4 | `properties.test.js` |
| SM-1–SM-4 | FR-SEL-*, FR-CMP-*, FR-ID-3 | none yet (e2e covers only that selecting shows icons and clearing hides them) |
| DR-1–DR-4 | PC-4, FR-ENT-6, FR-CMP-8 | e2e posts a review (DR-2 partly); failure path unchecked |
| RV-1–RV-4 | FR-REV-* | e2e (RV-2, and Submit reachable in a short window) |
| LY-*, GU-1 | FR-THR-1, FR-RND-3, §9 | e2e (partial) |
| A11Y-* | §11 | none yet |
| SEC-* | §10.3 | `server.test.js`, `worker.test.js`, e2e |
