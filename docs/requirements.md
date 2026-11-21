# Rico — requirements specification (with a UI/UX focus)

**Status of this document.** This is a *reverse-engineered and forward-looking* specification. It was written from a read-through
of the repository at commit `ced64ea` (`public/app.js`, `style.css`, `lib.js`, `src/*`, README, `docs/architecture.md`, the test
and e2e suites). Nothing here was verified by running the app, so the **Status** tags are code-reading judgements, not test results.

- **[Built]** the code does this today.
- **[Partial]** it exists but has a hole worth closing.
- **[Gap]** the requirement is implied by the product's goals but the code does not meet it.
- **[Decision]** a choice the product owner has to make; options and a recommendation are in §14.

Priority: **P0** (the product is wrong without it), **P1** (expected by the target user), **P2** (polish / later).

---

## 1. Product definition

### 1.1 Problem
GitHub reviews markdown the way it reviews code: as line diffs. A reviewer of a design doc, RFC, spec or README must mentally
render the markdown, and cannot comment on "this paragraph and the table under it" without picking line numbers. Prose
reviewers (PMs, designers, tech writers, staff engineers) want to review the document *as it will be read*.

### 1.2 Product statement
Rico is a review surface for the **markdown files in a GitHub pull request**. It shows the rendered document with the PR's
changes marked in place, lets the reviewer select any span of text (across blocks, into diagrams), and turns each selection
into a **native GitHub review comment**. GitHub remains the system of record; Rico stores nothing of its own except
the reviewer's unposted drafts, in their own browser.

### 1.3 Positioning constraints (non-negotiable)
| ID | Constraint |
|----|------------|
| PC-1 | Output is real PR reviews/comments through GitHub's REST API (`path`, `line`, `start_line`, `side`, `commit_id`). Teammates who never open Rico see normal comments. |
| PC-2 | No Rico-owned database or accounts. State lives in GitHub, the browser (`localStorage`), and (hosted) an encrypted session. |
| PC-3 | Rico reviews **markdown only**. Everything else defers to GitHub (links out). It never tries to replace GitHub's code review. |
| PC-4 | The reviewer never loses a typed comment to a Rico bug or a network failure. |

### 1.4 Out of scope
Code review; merge/close/label/assign actions; the Conversation, Commits and Checks tabs; resolving/unresolving threads (until GraphQL is adopted, see FR-THR-9);
GitHub Enterprise instances (the URL scheme names the instance but only `github.com` is accepted); real-time multi-user presence; storing comments outside GitHub.

---

## 2. Users and jobs to be done

| Persona | Who | Core job | What "good" feels like |
|---|---|---|---|
| **Prose reviewer** (primary) | PM, designer, writer, tech lead reviewing an RFC | "Tell the author *this sentence* is wrong, and the paragraph after it contradicts it." | Never thinks about line numbers; selection → comment in ≤3 gestures. |
| **Author** (secondary) | Wrote the doc | "See what reviewers said next to the text it's about, reply, and check I addressed it." | Threads sit beside their text like Google Docs; replies are one click. |
| **Maintainer** (secondary) | Reviews a doc-heavy PR next to code | "Skim every changed doc quickly and mark them viewed." | File tree, Viewed progress, diffstat, jump to GitHub for non-markdown files. |
| **Visitor** (tertiary, hosted) | Follows a shared link | "Read this PR's docs without signing in." | Read-only preview; clear prompt to sign in only when they try to write. |
| **Operator** (internal) | Runs the Worker or local server | "Deploy, rotate secrets, know it is safe." | Minimal config; security headers; revocable sessions. |

**Environment assumptions.** Desktop browser with a mouse is the primary device (wide screens, ≥1150 px, so the margin fits).
Laptops and narrower windows must work. Touch devices are a secondary, currently-unmet target (see §11.4).

---

## 3. Design principles (the tie-breakers for every UI decision)

1. **Review the document, not the diff.** The rendered view is the default and the hero; the Source diff is a precise escape hatch.
2. **Look like GitHub where GitHub is right.** Reuse Primer colours, badges, tabs, file cards, "Viewed", the *Review changes* dialog. Familiarity is a feature; deviate only where rich comments need it (the margin, the selection pill).
3. **Be honest about what GitHub will do.** GitHub only accepts comments on lines inside the diff, one side, one hunk. Whenever Rico must clamp, quote or demote a comment to the summary, it says so *before* the reviewer commits to it.
4. **A selection is a thought, not a transaction.** Creating a comment must be cheap and reversible; posting is a separate, deliberate step (the review).
5. **Never lose work.** Drafts persist; failures keep the queue; dismissing is never silent when text has been typed.
6. **Show, don't gate.** Visibility of state (what's changed, commentable, pending, viewed) is always on screen, not behind a mode.
7. **Colour is never the only signal.** Every colour-coded meaning also has a shape, label or position (see §11.1).
8. **Untrusted content stays untrusted.** Markdown, HTML and diagram source come from PR authors; they can render, never execute.

---

## 4. Information architecture

```
┌ Top bar: brand · PR input · status · theme · identity ───────────────────────────────┐
├ PR header: title #n · state badge · "X wants to merge N commits into base from head"  │
│            tabs: Conversation↗ Commits↗ Checks↗ [Files changed]                       │
├ Sticky toolbar: [tree toggle] totals (+/−) ················· [Review changes (n) ▾]   │
├ File tree (296px, sticky) │ Main: legend · stacked file cards                         │
│  filter · viewed n/N      │   card header (sticky): ▾ path 📋 +n −n ▪▪▪ [Rendered|Source] ☐Viewed
│  folders · status icons   │   card body: rendered doc (≤920px) │ margin (300px): threads/drafts
│  comment counts           │   floating: selection pill → composer (in the margin)    │
└───────────────────────────┴───────────────────────────────────────────────────────────┘
```

**Surfaces and their single responsibility**

| Surface | Responsibility | One thing it must not do |
|---|---|---|
| Top bar | Choose the PR; show global status/identity | Hold review state |
| PR header | Orient: what PR, what state, how big | Offer actions that Rico can't perform |
| Toolbar | Aggregate review state; the only "Submit" entry point | Scroll away (stays sticky) |
| File tree | Navigate and show per-file progress | Hide non-markdown files (they appear, dimmed, linking out) |
| File card | Read one document and its comments | Mix modes (a card is Rendered *or* Source) |
| Margin | Existing threads + your drafts, aligned to text | Overlap text or itself |
| Selection pill | Offer the two comment intents for the current selection | Persist after the selection is gone |
| Composer | Capture one comment body for one selection | Auto-post |
| Review dialog | Review queue + summary + verdict + Submit | Be the only place a draft can be edited (see FR-CMP-9) |

---

## 5. Functional requirements

### 5.1 Entry, loading and addressing (FR-ENT)

| ID | Requirement | P | Status |
|----|-------------|---|--------|
| FR-ENT-1 | Accept `https://github.com/o/r/pull/N`, `o/r#N`, and Rico's own `/github.com/o/r/N[@sha]?file=path` paths; reject anything else with a message that shows the accepted forms. | P0 | Built |
| FR-ENT-2 | The address bar always names *instance, repo, PR, head commit loaded, open file*, so any state is shareable. Older `#pr=` links keep working. | P0 | Built |
| FR-ENT-3 | If the PR's head has moved past the commit in the link, say so ("lines and comments may have moved"). | P0 | Built, but see FR-ENT-6 |
| FR-ENT-4 | Loading is progressive: header, tree and card shells immediately; first 8 files eagerly; the rest on demand ("Load file"). The user may open another file while loading; the load must not steal focus back. | P0 | Built |
| FR-ENT-5 | Empty and first-run states are helpful: landing text + example PRs; "This PR changes no markdown files" with a pointer to GitHub. | P1 | Built (empty-PR state could link to the Files tab) |
| FR-ENT-6 | When the stale-commit warning shows, offer **Load latest** and **Keep this commit** as actions, not just text. Drafts are keyed by head SHA, so moving to a new head *orphans* them (the user can't see them). Provide a way to see drafts from older commits and re-anchor or discard them. | P0 | **Gap** |
| FR-ENT-7 | Deep link to a *thread or draft* (e.g. `?thread=<id>`) so an author can send "see this comment" links. | P2 | Gap |
| FR-ENT-8 | Loading and error states are visible wherever the user is looking (see FR-ERR-1). | P0 | Partial |

### 5.2 PR chrome (FR-CHR)

| ID | Requirement | P | Status |
|----|-------------|---|--------|
| FR-CHR-1 | Title, number, Open/Draft/Merged/Closed badge with the correct icon, author, commit count, base ← head refs. | P0 | Built |
| FR-CHR-2 | Tabs mirror GitHub with counts; Conversation/Commits/Checks open GitHub in a new tab (`rel=noopener noreferrer`); Files changed is current. The links must visibly read as "leaves Rico" (external-link affordance). | P1 | Partial (no external indicator) |
| FR-CHR-3 | Toolbar totals: changed files, +additions, −deletions — whole PR, not just markdown. Make clear when markdown files are a subset ("3 of 12 files are markdown"). | P1 | Partial |
| FR-CHR-4 | Page `<title>` reflects PR title/number/repo so tabs are distinguishable. | P2 | Built |
| FR-CHR-5 | Closed/merged PRs: comments can still be posted (GitHub allows it) but the UI says "This PR is merged/closed" near Review changes so the reviewer isn't surprised. | P2 | Gap |

### 5.3 File tree and files (FR-TREE, FR-CARD)

| ID | Requirement | P | Status |
|----|-------------|---|--------|
| FR-TREE-1 | Show *every* changed file in a collapsible folder tree, single-child chains merged, with status icons (added/modified/removed/renamed) and per-file comment counts (existing threads + your drafts). | P0 | Built |
| FR-TREE-2 | Markdown files open in Rico; non-markdown and deleted files are dimmed and link to their diff on GitHub, announced as such (tooltip today; also an accessible name, see §11.2). | P0 | Built / Partial |
| FR-TREE-3 | Filter box narrows by path substring and expands matching folders. Filter must also support clearing with Esc and show "no matches". | P1 | Partial (no empty message) |
| FR-TREE-4 | "n / N markdown files viewed" progress. | P1 | Built |
| FR-TREE-5 | Tree can be hidden (toolbar toggle) and the layout reflows; the hidden state is remembered. | P2 | Built / not remembered |
| FR-TREE-6 | The tree highlights the file the reader is *currently looking at while scrolling*, not only the last clicked one. | P1 | Gap |
| FR-TREE-7 | Keyboard: arrow keys move through rows, Enter opens, ←/→ collapse/expand; `j`/`k` next/previous file. | P1 | Gap (rows are focusable; no arrow model) |
| FR-CARD-1 | Each file is a card with a **sticky** header: collapse chevron, path (filename bold), copy path, `+N −N` and the five-square diffstat, a **Rendered / Source diff** segmented control, and a **Viewed** checkbox. | P0 | Built |
| FR-CARD-2 | Ticking **Viewed** collapses the card (as on GitHub), updates the tree tick and progress, and is remembered per PR+commit in this browser. Viewed is *local*; this must be stated once (tooltip) because on GitHub it syncs to the account. | P1 | Built / undisclosed |
| FR-CARD-3 | Unloaded files show a clear "Load file" control; opening a file from the tree scrolls to its card, expands it, updates the URL. | P0 | Built |
| FR-CARD-4 | Renamed files (with or without edits) and pure renames (no patch) are handled: previous path is shown; a rename with no content change says so and doesn't offer empty views. | P1 | Built |
| FR-CARD-5 | Large documents (≥2,000 lines) stay responsive: lazy files, no layout thrash from the margin on every scroll. | P1 | Built (tested on PR #4) |
| FR-CARD-6 | Auto-collapse very large added files by default (GitHub does this) with "Load diff"-style expansion. | P2 | Gap |

### 5.4 Rendered document view (FR-RND)

| ID | Requirement | P | Status |
|----|-------------|---|--------|
| FR-RND-1 | Render GitHub-flavoured markdown faithfully using GitHub's own CSS: tables with alignment, task lists, alerts (`> [!NOTE]` etc.), heading permalinks (hover), `<details>`, syntax-highlighted code, safe raw HTML, autolinks. Unsupported: footnotes, emoji shortcodes (documented). | P0 | Built |
| FR-RND-2 | Relative links resolve to the file at the PR's head commit on GitHub; relative images are served from the head commit through the app (images only; other types are not requested). In-page `#` links scroll within the card. | P0 | Built |
| FR-RND-3 | **Change markers in the gutter**: green = block contains changed lines; blue = unchanged but commentable (inside a hunk); grey = outside the diff (comment goes to the summary). Legend always visible above the cards. Added files are not painted as all-changed. | P0 | Built |
| FR-RND-4 | **Removed content is shown in place, in red,** from the merge-base version, above its replacement: paragraphs, list items (back in their list), table rows (back in their table), code blocks, removed diagrams (as source). Hover says "Removed in this PR". If the old file can't be fetched, say removals are visible in Source diff (not silent). | P0 | Built / Partial (the fallback is only noted in the margin when threads exist) |
| FR-RND-5 | Word-level change highlighting inside a modified paragraph (today the whole old paragraph is shown red above the whole new one). | P1 | Gap (documented limit) |
| FR-RND-6 | Reading width: body max ~920 px with a 300 px margin beside it; ≥1150 px shows margin on the side, below that threads stack under the document. | P1 | Built |
| FR-RND-7 | Images: lazy, no referrer; broken image shows alt text rather than collapsing layout; large images don't break the margin alignment (re-layout on load). | P1 | Partial (ResizeObserver covers reflow) |
| FR-RND-8 | A **document outline** (headings) for long docs, in the tree sidebar or as a popover, with the same hover permalinks. | P2 | Gap |

### 5.5 Diagrams (FR-DIA)

| ID | Requirement | P | Status |
|----|-------------|---|--------|
| FR-DIA-1 | `d2` and `mermaid` fences render client-side, on demand, in a sandboxed `iframe` with no scripts and a CSP blocking all network. Source is one click away ("D2 source"). | P0 | Built |
| FR-DIA-2 | Hover a node/edge → highlight + tooltip "Comment on node *X*". Click → composer opens naming the element and anchored to the line(s) that define it (D2 container nodes cover their whole `{}` block; elements defined on several lines list the other lines). Click empty space → comment on the whole block. | P0 | Built |
| FR-DIA-3 | Compile errors appear inline with line detail; source opens automatically. If the optional renderer isn't installed, say so with the install hint — it must not look like a broken diagram. | P0 | Built |
| FR-DIA-4 | Height cap with **Expand / Shrink**; diagram redraws in the active theme colours. | P1 | Built |
| FR-DIA-5 | Diagram element commenting is reachable **without a mouse**: a list of elements (focusable) next to or inside the "source" disclosure, or line-level commenting in the source pane. Provide a text alternative (`title` is currently the only label). | P1 | Gap |
| FR-DIA-6 | Mermaid types beyond flowchart and sequence fall back to whole-block comments; say so on hover ("Comment on this diagram"). | P2 | Partial |

### 5.6 Selecting and commenting (FR-SEL, FR-CMP) — the heart of the product

**Interaction model (as built, to be preserved):**
`select text` → a **pill with two icons appears just under the mouse-up point** → click an icon → a **composer opens in the margin beside the selection** (selection stays highlighted) → type → `Ctrl/Cmd+Enter` → the comment is queued as a **draft** (dashed card in the margin, counted on *Review changes*) → later, *Submit review* posts everything as one review.

| ID | Requirement | P | Status |
|----|-------------|---|--------|
| FR-SEL-1 | Any selection in the rendered document is a valid comment target, including across paragraphs, list items, table cells, headings, code and diagrams, and across *removed and kept* text. | P0 | Built |
| FR-SEL-2 | The pill appears within ~100 ms of releasing the mouse and **below** the release point, never covering the selection's text, and is clamped to the viewport/main column. Pressing **Esc** or clearing the selection dismisses it; clicking the pill must not clear the selection. | P0 | Built |
| FR-SEL-3 | **Two intents, always labelled.** "Comment and quote the text" (quote ON) and "Comment on the selected lines" (quote only when it adds information). Today they are two similar speech-bubble glyphs distinguished only by an inner mark and a tooltip. Requirement: each must have a visible text label or a first-use hint, and the difference ("with quote" vs "lines only") must be explainable in ≤1 line. | P0 | **Partial — discoverability risk** |
| FR-SEL-4 | **Keyboard selection** (Shift+arrows) shows the pill at the end of the selection; the pill's buttons must be reachable by keyboard, and there must be a direct shortcut (e.g. `c` or `Ctrl/Cmd+Alt+M`) to open the composer for the current selection. | P0 | **Gap** (keyup shows the pill, but nothing moves focus into it; focus-stealing Tab collapses the selection) |
| FR-SEL-5 | Selection maps to source lines using the parser's block ranges, refined by word position inside hard-wrapped paragraphs; falls back to the whole block when unsure (always correct, coarser). | P0 | Built |
| FR-SEL-6 | Selecting inside an existing thread, the margin, or UI chrome never triggers the pill. | P0 | Built (guarded by `v.doc.contains`) |
| FR-SEL-7 | A fresh selection replaces an **empty** composer; it never clobbers a composer with typed text — instead the composer **pulses** to say "finish this one first". | P0 | Built |
| FR-SEL-8 | Selection **highlight persists** while the composer is open even though focus moved to the textarea (CSS Custom Highlight API; graceful fallback where unsupported). | P1 | Built |
| FR-CMP-1 | The composer opens in the **margin, vertically aligned to the selection**, never over the text; where there is no margin (narrow layout) it opens below/above the selection and flips to stay on screen. | P0 | Built |
| FR-CMP-2 | The composer shows: what is being commented on (quote preview), a one-line **range statement**, a body field, **Add review comment** and **Cancel**. Autofocus the body without scrolling the page. | P0 | Built |
| FR-CMP-3 | **Range statement must be truthful and plain**: "Comments on lines 12–15", or a warning when clamped ("You selected 12–40; GitHub can anchor 12–20 (one hunk). The full quote is included."), or when outside the diff ("goes into the review summary (quoted)"). Warnings use the attention colour *and* an icon/prefix. | P0 | Built / Partial (no icon) |
| FR-CMP-4 | **Quote handling:** the quote is shown only when it will be posted; long quotes show first 5 + gap marker + last 5 lines; unanchored comments always carry the quote; the quote text is editable before adding (currently hidden behind the icon's choice — the *edit* affordance is no longer reachable in the UI). | P1 | **Partial** — `#c-qedit` and `#c-qinc` live in a `hidden` container, so users can no longer toggle or edit the quote |
| FR-CMP-5 | `Ctrl/Cmd+Enter` adds; `Esc` cancels. A visible hint states both (placeholder text today). | P0 | Built |
| FR-CMP-6 | Empty body: Add does nothing visible except focusing the field — also disable the button or show "Write a comment" so it doesn't feel broken. | P2 | Partial |
| FR-CMP-7 | After adding: composer closes, selection clears, the block gets the "has comment" mark, the draft appears in the margin, Review-changes count and tree counts update, URL/scroll unchanged. | P0 | Built |
| FR-CMP-8 | Drafts persist in `localStorage` per PR + head commit, survive reload, and are keyed so private-mode failure degrades to "works until you close the tab" *and tells the user*. | P0 | Built / silent failure |
| FR-CMP-9 | **Edit and delete a draft from where you see it.** The margin draft currently offers only **Delete**; editing exists only inside the Review dialog. Offer Edit in the margin (inline, same textarea behaviour as reply). | P1 | **Gap** |
| FR-CMP-10 | **Unsaved composer text is preserved** across incidental events: the theme switch currently reloads the page and discards an open composer; accidental navigation, file switches and re-renders should too (at minimum, a `beforeunload` warning when composer text exists). | P0 | **Gap** (theme reload; `setMode`/`openFile` call `hideComposer()` and silently drop typed text) |
| FR-CMP-11 | Comment body supports GitHub-flavoured markdown (it is posted as such); a lightweight **Write / Preview** toggle and a "supports Markdown" hint. | P2 | Gap |
| FR-CMP-12 | **Diff-line comments in Source view**: hover `+` on a line number, click to comment, Shift-click to extend within a hunk; removed lines post to the `LEFT` side; selected rows highlighted; same composer. | P0 | Built |

### 5.7 Threads and the margin (FR-THR)

| ID | Requirement | P | Status |
|----|-------------|---|--------|
| FR-THR-1 | Existing review threads appear in a margin beside their anchored block, vertically aligned and **pushed down, never overlapping**, re-flowed on resize, image/font load and expand/collapse. | P0 | Built |
| FR-THR-2 | Each message shows avatar (with initial fallback), author, relative time linking to GitHub, association badge (Owner/Member/Collaborator/Contributor/First-time), GitHub-flavoured body. | P0 | Built |
| FR-THR-3 | **Hover a thread highlights its text; click highlighted text scrolls to/pulses its thread.** | P0 | Built |
| FR-THR-4 | **Outdated** threads (their lines no longer exist) are labelled, placed at the nearest block, and visually quieter; file-level comments labelled "File comment". | P0 | Built |
| FR-THR-5 | **Left-side threads** sit beside the matching removed block, or beside the new-file counterpart for unchanged old lines; if neither is renderable, a note points to Source diff. | P1 | Built |
| FR-THR-6 | Drafts are visually distinct (dashed/attention colour, "Pending · not posted yet") and sorted with threads by position. | P0 | Built |
| FR-THR-7 | **Reply** posts *immediately* to GitHub (not queued into the review). The button must say so ("Reply" → "Reply · posts now" or a helper line) because the rest of the product is deliberately batched; the inconsistency surprises people. Failed replies keep their text and show the error. | P0 | **Partial** (works; mental-model not disclosed) |
| FR-THR-8 | When many threads cluster, the margin must stay usable: collapse long threads ("Show 3 more replies"), and show a count when the margin is much taller than the doc. | P1 | Gap |
| FR-THR-9 | **Resolved/unresolved state** (needs GraphQL): show resolved threads collapsed; allow resolve/unresolve; filter "unresolved only". | P1 | Gap (known limit) |
| FR-THR-10 | **Refresh**: pick up new comments from collaborators without a full reload (button + stale indicator), preserving drafts. | P1 | Gap |
| FR-THR-11 | Emoji reactions and edit/delete of *your own posted* comments. | P2 | Gap |

### 5.8 Source diff view (FR-SRC)

| ID | Requirement | P | Status |
|----|-------------|---|--------|
| FR-SRC-1 | Unified diff with old and new line numbers, `+`/`−` marks, Primer's add/del/hunk colours in both themes, markdown syntax colouring per line, preserved whitespace and wrapping. | P0 | Built |
| FR-SRC-2 | Threads and drafts appear inline under their line; left-side ones under the removed line; outdated ones grouped under a count note. | P0 | Built |
| FR-SRC-3 | Files with no patch (rename-only, binary, too large): explain which and why, and link to GitHub. | P1 | Built / Partial |
| FR-SRC-4 | **Expand hidden context** between/around hunks ("Show 20 more lines"). | P1 | Gap (documented limit) |
| FR-SRC-5 | The `+` affordance appears on hover **and on keyboard focus**; touch has a visible target. | P1 | Gap (hover-only today) |
| FR-SRC-6 | Mode choice per file is retained when navigating; a "unified/split" option is out of scope. | P2 | Partial |

### 5.9 Review dialog and submission (FR-REV)

| ID | Requirement | P | Status |
|----|-------------|---|--------|
| FR-REV-1 | The green **Review changes (n)** button in the sticky toolbar opens a popover "Finish your review": summary textarea, **Comment / Approve / Request changes** (with GitHub's descriptions), the pending list, **Submit review**. | P0 | Built |
| FR-REV-2 | The popover is sized to fit the viewport so **Submit is always reachable**; `Esc` and outside-click close it; focus goes to the summary. Add `aria-modal`/focus trap semantics or make it explicitly non-modal and keep Tab order sane. | P0 | Built / Partial (no trap) |
| FR-REV-3 | Each pending item: file · line range (· "removed"), quote preview, anchoring note, body, **Edit / Delete**; clicking the location **navigates to the comment** (opens the file, scrolls to it). | P0 | Built |
| FR-REV-4 | Submit is enabled with ≥1 comment *or* a non-empty summary; disabled otherwise (with a reason on hover). | P0 | Built |
| FR-REV-5 | All comments become **one review** at the loaded `commit_id`. Unanchorable comments become quoted entries in the review body. | P0 | Built |
| FR-REV-6 | **Success state**: "Review posted — open on GitHub", queue cleared, drafts removed from margins, counts reset. | P0 | Built |
| FR-REV-7 | **Failure state**: message from GitHub (with sign-in prompt where relevant), button re-enabled, *comments still queued* (said explicitly). Specific explanations for the common failures — own-PR approval ("can't approve your own PR"), closed PR, stale `commit_id`/line no longer in diff, rate limit, 403 scope. | P0 | Partial (message passes through; no friendly mapping) |
| FR-REV-8 | **Pre-submit sanity** (non-blocking): "n comments are on a commit that is no longer the PR head", "k comments will be in the summary because they are outside the diff". | P1 | Gap |
| FR-REV-9 | Approving/Requesting changes needs a confirmation affordance *proportional to risk*: Approve/Request-changes button label changes (e.g. "Submit approval") so the verdict is unmistakable. | P1 | Gap (always "Submit review") |
| FR-REV-10 | Submitting twice is impossible (button disabled in flight; idempotence note for flaky networks). | P0 | Built |
| FR-REV-11 | The summary draft persists with the comments. | P1 | Built |

### 5.10 Identity, modes and theme (FR-ID, FR-THM)

| ID | Requirement | P | Status |
|----|-------------|---|--------|
| FR-ID-1 | **Local mode:** uses the operator's token; no sign-in UI; token never reaches the browser. | P0 | Built |
| FR-ID-2 | **Hosted mode:** GitHub OAuth sign-in; header shows avatar + login + **Sign out**; sign-out revokes the session server-side when KV is bound. | P0 | Built |
| FR-ID-3 | **Preview mode (signed out):** public PRs readable; header shows a "Preview · read-only" chip and a primary **Sign in with GitHub**. Every write affordance either hides or, when triggered, explains and offers sign-in — a signed-out visitor must not type a comment before learning they can't post it. | P0 | **Partial** (writes are rejected server-side with a sign-in link; the composer still opens and accepts text) |
| FR-ID-4 | After sign-in the user **returns to exactly where they were** (PR, file, scroll anchor). | P0 | Built (`return=`) / scroll not restored |
| FR-ID-5 | Session expiry/revocation mid-review shows "Sign in again" inline and **does not discard drafts**. | P0 | Built (status link) |
| FR-ID-6 | **Scope transparency:** OAuth requests `repo` by default (needed for private repos). Before consent the sign-in button/landing explains what Rico can access and offers the public-only path. | P1 | Gap |
| FR-THM-1 | Theme: **Auto (follow system) / Light / Dark**, remembered; every surface, the markdown CSS, code colours and diagrams follow it. | P0 | Built |
| FR-THM-2 | Changing theme must not destroy the page state (see FR-CMP-10): re-theme in place instead of `location.reload()`. | P1 | **Gap** |
| FR-THM-3 | Contrast meets WCAG AA in both themes for text, badges, counters, and the gutter bars (see §11.1). No flash of wrong theme on load (the init script is external because of CSP). | P0 | Partial / Built |

### 5.11 Errors, status and feedback (FR-ERR)

| ID | Requirement | P | Status |
|----|-------------|---|--------|
| FR-ERR-1 | Status and errors appear in a **persistent, visible place near the user's attention**. Today a single line in the (non-sticky) top bar carries all of them, so a failure while scrolled down is invisible. Use a toast/banner in the sticky toolbar region, announced via `role="status"` / `role="alert"`. | P0 | **Gap** |
| FR-ERR-2 | Every error says *what happened, whether work is safe, what to do next* ("Couldn't load file X · your comments are safe · Retry"). Retries exist for loads. | P1 | Partial |
| FR-ERR-3 | Loading indicators for anything >300 ms: PR load, file load, diagram render, review submit. | P1 | Partial |
| FR-ERR-4 | Rate-limit (60/h anonymous) gets an explicit message with a sign-in suggestion rather than a raw GitHub string. | P1 | Gap |
| FR-ERR-5 | Offline: authored drafts keep working; Submit explains. | P2 | Gap |

---

## 6. End-to-end user journeys (acceptance scenarios)

Each journey is an acceptance test the UI must satisfy; items marked ⚠ are failing today per §5.

**J1 — Review a doc PR in one sitting (prose reviewer).**
1. Paste `owner/repo#123` → header, tree and the first file appear; URL becomes `/github.com/owner/repo/123@abc1234`.
2. Skim: green bars show what changed; red blocks show what was removed; the legend explains the colours.
3. Select a sentence → pill under the cursor → "quote" icon → composer in the margin → type → `⌘↵`. Draft appears, counter reads **1**.
4. Select across a paragraph and the table below → composer says "Comments on lines 40–52" (or clamps, honestly).
5. Click a node in a Mermaid diagram → composer names "node “Auth”" → comment.
6. Tick **Viewed** on each file; tree shows 3/3.
7. *Review changes* → write summary → **Request changes** → Submit → "Review posted — open on GitHub". Queue empty.
Pass criteria: no line numbers typed by hand; no step requires leaving the page; the posted comments on GitHub sit on the intended lines with correct quotes.

**J2 — Author responds to feedback.**
Open the PR link from the notification → threads sit beside text; hover a thread → text highlights; click **Reply** → type → `⌘↵` → reply posted *now*. ⚠ UI must say replies post immediately (FR-THR-7). ⚠ New comments from others should be fetchable without reload (FR-THR-10).

**J3 — Interrupted review.**
Type half a comment, close the laptop. Reopen → drafts present; the half-typed composer text is *not* (⚠ FR-CMP-10: at least warn before it is lost). Change theme mid-comment ⚠ today discards the composer.

**J4 — PR moves under the reviewer.**
Reviewer has 5 drafts at commit A; author pushes commit B. Reload shows the latest. ⚠ Drafts (keyed by A) vanish silently (FR-ENT-6). Required: banner "5 drafts are on an older commit — Review / Move to latest / Discard".

**J5 — Signed-out visitor.**
Open a shared link → preview chip, read everything. Select text → pill appears. ⚠ Required: clicking it explains "Sign in to comment" and offers the button instead of opening a composer that cannot post (FR-ID-3). After sign-in, return to the same file.

**J6 — Mixed selection over removed and kept text.**
Select from a red block into the green replacement → composer shows "anchored to the new lines you covered; removed text quoted as a diff". Posted comment contains a fenced `diff` quote.

**J7 — Large/unusual PRs.**
2,000-line doc scrolls smoothly and the margin does not jank; a pure rename shows "renamed without changes"; a PR with 40 files lazy-loads after the first 8; a deleted file is dimmed in the tree.

**J8 — Keyboard-only reviewer.** ⚠ Currently not completable. Required: Tab to the document → Shift+arrows to select → shortcut opens composer → type → `⌘↵` → Tab to *Review changes* → Space → choose verdict → Submit, with visible focus throughout.

---

## 7. Interaction specifications

### 7.1 Selection pill and composer states
```
IDLE ──select text──▶ PILL(sel) ──Esc / selection cleared──▶ IDLE
PILL ──click quote|lines icon──▶ COMPOSER(sel, includeQuote)
COMPOSER ──type──▶ COMPOSER(dirty)
COMPOSER(empty) ──new selection──▶ PILL(new sel)        (replaces)
COMPOSER(dirty) ──new selection──▶ COMPOSER(dirty) + pulse   (never clobbers)
COMPOSER ──⌘↵ / Add──▶ DRAFT queued ──▶ IDLE
COMPOSER ──Esc / Cancel──▶ IDLE   (⚠ if dirty: ask or stash; today it discards)
```
- Pill: 34 px circular buttons, 6 px padding, pill radius, shadow, 12 px below the pointer. ≥44 px target on touch.
- Composer: 260–440 px wide, in the margin; blockquote preview (max 16 em, scroll), range statement, textarea (3 rows, vertical resize), primary + secondary buttons. Border = accent colour to tie it to the selection highlight; `pulse` animation 0.5 s.
- Selection highlight: translucent accent via `::highlight(rico-sel)`; diagram elements use a glow; source-diff rows use a tint.

### 7.2 Margin layout algorithm (behavioural spec)
1. Each item (thread/draft) has a target = top of its first anchored block.
2. Sort by target; place each at `max(target, previousBottom + 8 px)`.
3. Margin height = `max(last bottom, document height)`.
4. Recompute on: window resize, font ready, image load, diagram fit, expand/shrink, reply form open/close, file load.
5. Below 1150 px: margin becomes a static stack under the doc.
Must not: overlap items; animate on every scroll; cause horizontal scroll.

### 7.3 Navigation and scroll behaviour
- Opening a file from the tree: expand → scroll to card top, offset for sticky toolbar + header (scroll-margin 101 px).
- Clicking a pending item's location: close popover → open file → centre the block.
- Clicking a highlighted block: scroll its thread into view and pulse it 1.8 s.
- URL is updated with `replaceState` (no history spam); it reflects the **last opened** file, not the scroll position (FR-TREE-6).

### 7.4 Keyboard map (target)
| Key | Action | Status |
|---|---|---|
| `⌘/Ctrl+Enter` | Add comment / send reply | Built |
| `Esc` | Dismiss pill → composer → review popover (innermost first) | Built |
| `c` (with selection) | Open composer for the selection | Gap |
| `j` / `k` | Next / previous file | Gap |
| `v` | Toggle Viewed on current file | Gap |
| `r` | Open Review changes | Gap |
| `?` | Shortcut help | Gap |
| Arrows / Enter / Space in tree | Navigate / open / toggle | Partial |

---

## 8. Content and microcopy requirements
- **Voice:** plain, specific, no blame. Say the consequence, not the mechanism: "goes into the review summary (quoted)" rather than "outside the diff hunks".
- **Always-on teaching moments (one line each):** legend; "Select any text…" landing line; composer range statement; "your comments are still queued".
- **Terminology** (keep consistent with the glossary): *comment* (one anchored note), *thread* (comment + replies), *draft/pending* (queued, unposted), *review* (the posted batch), *anchor*, *hunk*, *outdated*. Avoid "quote on/off", "side", "LEFT/RIGHT" in user-facing text; use "removed lines".
- **Counts** are never zero-padded or hidden inconsistently: the toolbar badge hides at 0; the tree badge hides at 0.
- **Times:** relative ("commented 2 days ago") with the absolute time on hover (currently link-only — add `title`).

---

## 9. Responsive and device behaviour

| Width | Layout |
|---|---|
| ≥1150 px | Tree · document · margin side by side. Composer in the margin. |
| 800–1149 px | Tree · document; margin stacks under the document; composer opens below/above the selection. |
| <800 px | Tree stacks above (consider collapsing it by default); cards full width; body padding 16 px. Review popover ≤92 vw. |

Requirements: no horizontal page scroll at any width; sticky header + toolbar together must leave ≥50 % of a 700 px-tall viewport for content (the stacked sticky bars are ~93 px — acceptable; verify with the popover open on small laptops).

**Touch (secondary target) — [Gap]**: selection handling listens to `mouseup`/`keyup` only. On touch, selection handles produce `selectionchange` but not a reliable `mouseup`, so the pill likely never appears. Requirement: derive the pill from `selectionchange` (debounced) as well, position it above the selection (avoiding the OS callout), 44 px targets, and make the `+` in the Source diff always visible.

---

## 10. Non-functional requirements

### 10.1 Performance
| ID | Target |
|----|--------|
| NFR-P-1 | First meaningful paint of the PR header and tree: ≤1.5 s after the PR API responds (excluding GitHub latency). |
| NFR-P-2 | Pill appears ≤100 ms after mouse-up; composer opens ≤100 ms after click on a 2,000-line doc. |
| NFR-P-3 | Margin reflow ≤16 ms for ≤50 threads; no layout work on scroll. |
| NFR-P-4 | Hosted: edge-cache good public GET responses ~1 min; never cache authenticated responses. |
| NFR-P-5 | Static assets are vendored and cacheable; the diagram renderers load only when a diagram exists. |

### 10.2 Reliability and data integrity
- NFR-R-1 Posted review contains exactly the queued comments at the loaded commit; no duplicates on retry (disable-in-flight; consider an idempotency check by re-reading recent reviews after an ambiguous failure).
- NFR-R-2 Draft storage is versioned (`rico:owner/repo#n:sha`); on schema changes, old drafts are migrated or surfaced, never ignored.
- NFR-R-3 Selection→line mapping failures degrade to the enclosing block, never to a wrong line. (Covered by `lib.test.js`/e2e; keep a regression test per bug.)

### 10.3 Security and privacy (UI-visible parts in bold)
- Token never reaches the browser; hosted token only in an encrypted `HttpOnly` cookie (optionally split with KV, **revoked on sign-out**).
- Local server binds to loopback, rejects foreign `Host`, requires `X-Rico` on POST.
- CSP, `X-Frame-Options: DENY`, `nosniff`; all markdown/HTML sanitised (DOMPurify, forbidden tags/attrs, only disabled checkbox inputs); links `noopener noreferrer`; images `no-referrer`; diagrams in a script-less, network-less sandbox.
- **The UI must never render a PR's raw HTML in a way that can phish within the Rico origin** (no forms, buttons, iframes) — already forbidden; keep it tested.
- **Privacy:** the only data in the browser is drafts, viewed flags, theme. Disclose this in one place ("Stored in this browser only").

### 10.4 Compatibility
Evergreen Chrome, Edge, Firefox, Safari (last 2 majors). The CSS Custom Highlight API is progressive (fallback = native selection). Node ≥ 18 local; Cloudflare Workers hosted. `color-mix()` and `:has` use needs a floor of Safari 16.2/ Chrome 111 — state it.

### 10.5 Observability (hosted)
No analytics by default. If added: opt-in, no content, no PR names. Errors surfaced to the operator via Worker logs with request ids that the UI can display ("Reference: abc123") in unexpected-error messages.

### 10.6 Testability
- Pure logic stays in `lib.js` with unit tests; UI behaviour is covered by headless e2e (real mouse drags) and the OS-level xdotool suite; real-GitHub read-only checks on four fixed `[test]` PRs.
- New requirements in this document should land with an e2e for the journey they affect (J1–J8).

---

## 11. Accessibility requirements (WCAG 2.2 AA)

### 11.1 Perception
- **Colour is not the only signal** (principle 7). Today the gutter bars (green/blue/grey) and red removed blocks rely on colour. Add a non-colour cue: bar patterns or a tiny label on hover/focus ("changed", "commentable", "outside diff"), a `✕`/"Removed" visually-hidden label for red blocks, and `+`/`−` markers in Source.
- Contrast: body text ≥4.5:1; UI components and focus rings ≥3:1; gutter bars ≥3:1 against the page in both themes (the grey `--out` bar in light theme is ~1.6:1 — fails as a signal; it is informational but should be fixed or paired with a label).
- Text resizes to 200 % without loss; respects `prefers-reduced-motion` (the `pulse`, smooth scroll and `top` transitions must be disabled).

### 11.2 Operability
- Everything operable by keyboard (§7.4), including selection → comment (FR-SEL-4), thread replies, the review dialog, tree navigation, diagram elements (FR-DIA-5), Source `+` (FR-SRC-5).
- Visible focus on every control (`:focus-visible` outline exists; verify on the pill, which sets `outline: 0`).
- No keyboard traps; `Esc` always backs out one level.
- Touch targets ≥24 px (AA) and ideally 44 px.

### 11.3 Understandability / robustness
- Landmarks: header, nav (tabs; files), main; headings per file card (`h2` with the path) so screen-reader users can jump between files.
- Live regions: status messages (`role=status`), errors (`role=alert`), "Review posted" announcement; new draft announced ("Comment added, 3 pending").
- Dialog semantics for the review popover (`aria-modal` or documented non-modal behaviour, focus returns to the button on close).
- Icon-only buttons have `aria-label`s (most do); the tree's dimmed external links must say "opens on GitHub".
- Margin cards are associated with their text (`aria-describedby` from block → thread) or reachable in reading order.
- Diagrams get an accessible name and a text alternative (the source disclosure counts only if it is announced).

---

## 12. Visual and brand requirements
- Visual language is **GitHub Primer** (light/dark tokens in `style.css :root`); Rico's own identity is limited to the blue speech-bubble mark and the "rich comments" subtitle. Keep deviations deliberate and few: the margin, the pill, the composer, the diagram frame.
- Spacing: 4/8/16 px rhythm; radii 6 px (controls), 12 px (popover), pill for the selection bar; shadows only on floating layers (pill, composer, popover, active thread).
- Typography: system UI stack, 14 px UI, 16 px document, mono 12 px for paths/diff/quotes.
- Colour roles: **success** = additions/primary action; **danger** = removals/errors; **accent** = selection, links, focus; **attention** = drafts and warnings; **done** = merged/renamed. A role must never change meaning between surfaces.
- Motion: ≤150 ms eases for layout moves, one 500 ms attention pulse; all disabled under reduced-motion.

---

## 13. Known limitations that shape requirements (from the README, restated as requirements to revisit)
1. Whole-block red/green, no word-level diff (FR-RND-5).
2. No resolved-thread state (FR-THR-9).
3. One hunk per multi-line comment (clamp + quote, FR-CMP-3).
4. Conversation/Commits/Checks live on GitHub.
5. No context expansion in Source (FR-SRC-4); no emoji shortcodes/footnotes.
6. Mermaid element mapping limited to flowcharts/sequence.
7. Anonymous GitHub rate limit (60/h per IP) mitigated by a scope-less `PREVIEW_TOKEN`.

---

## 14. Decisions needed from the product owner

| # | Question | Options | Recommendation |
|---|----------|---------|----------------|
| D1 | **What is the primary device?** | Desktop-only; desktop + tablet; fully mobile | Desktop first, but fix touch selection (cheap) and declare phones "read-only" for now. |
| D2 | **Two selection icons, or one?** | Keep both with labels; one "Comment" button with a quote toggle inside the composer; one button, quote decided by Rico | Keep the two intents but **label them** ("Comment · with quote" / "Comment · lines only"), or collapse to one button + a visible *Include quote* checkbox (the control already exists but was hidden). Test with 3–5 reviewers. |
| D3 | **Reply: immediate or batched?** | Immediate (today); batched into the review | Immediate is simpler and matches author workflows; label it. Revisit if reviewers expect one atomic review. |
| D4 | **Who is the hosted audience?** | Public-repo reviewers; private orgs | If private orgs, add an explicit consent/scopes explainer and a "public only" sign-in. |
| D5 | **Viewed: local or synced to GitHub?** | Local (today); sync via GraphQL `markFileAsViewed` | Sync only if/when GraphQL is adopted for resolved threads; otherwise disclose "local". |
| D6 | **Resolve threads?** | Not in scope; read-only status; full resolve/unresolve | Adopt GraphQL once; show status + resolve — the largest author-side gap. |
| D7 | **Drafts across pushes** | Orphan (today); re-anchor by quote text; ask | Re-anchor by matching the stored quote in the new head; show unmatched ones as "needs attention". |
| D8 | **Local-first scope:** is the local server a supported product or a dev tool? | Supported; dev-only | Supported — it is the zero-setup path; keep it equal in features. |

---

## 15. Prioritised gap list (derived from the status tags)

**P0 — fix before calling the UX complete**
1. FR-ERR-1 — errors/status visible where the user is (sticky region, `role=alert`).
2. FR-CMP-10 / FR-THM-2 — never destroy an open composer (theme reload, file switch, mode switch).
3. FR-ENT-6 — stale-head handling: actions + visible orphaned drafts.
4. FR-SEL-4 — keyboard path from selection to composer (and touch path, §9).
5. FR-SEL-3 — label or merge the two icons; restore a visible way to include/edit the quote (FR-CMP-4).
6. FR-ID-3 — preview visitors should be told, not discovered, that they can't post.
7. FR-THR-7 — disclose that replies post immediately.

**P1**
8. FR-CMP-9 edit drafts in the margin; FR-REV-7/8/9 clearer failure mapping, pre-submit sanity, verdict-specific submit label.
9. FR-THR-9/10 resolved state and refresh; FR-TREE-6/7 scroll-spy and tree keyboard model.
10. FR-SRC-4/5 context expansion and keyboard `+`; FR-DIA-5 keyboard diagram commenting.
11. §11 accessibility pass (non-colour change cues, contrast of the grey bar, reduced motion, live regions, headings per file).
12. FR-ID-6 scope transparency; FR-ERR-4 rate-limit messaging.

**P2** FR-RND-5 word-level diff; FR-RND-8 outline; FR-ENT-7 thread deep links; FR-CMP-11 markdown preview; shortcuts help (`?`); auto-collapse huge files.

---

## 16. Traceability
| Source of truth | Requirements it grounds |
|---|---|
| `public/app.js` (selection, composer, margin, source diff, review dialog) | §5.6–5.9, §7 |
| `public/lib.js` (anchoring, clamp, quote, review building, tree) | FR-SEL-5, FR-CMP-3/4, FR-REV-5 |
| `public/style.css` | §9, §11.1, §12 |
| `src/worker.js`, `src/session.js`, `src/security.js` | FR-ID-*, §10.3 |
| `README.md`, `docs/architecture.md` | PC-*, §13 |
| `e2e/run.mjs`, `test/*.test.js` | §10.6, journeys J1–J7 |
