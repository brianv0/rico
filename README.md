# Rico — rich comments

Review a GitHub PR's markdown the way it will be read, in a page built to look like GitHub's **Files changed**.
Select any text, even across several paragraphs, and a comment box appears over the selection. Comments are posted
as a real PR review (`line` / `start_line` / `side` on the official REST API).

```bash
export GITHUB_TOKEN=...      # or just be logged in with `gh auth login`
npm install
npm start                    # http://localhost:4317
```

Paste a PR URL (or `owner/repo#123`). Your token stays on the local server and never reaches the browser.
Behind an HTTP(S) proxy? Node's `fetch` ignores `HTTPS_PROXY` unless you start with `NODE_USE_ENV_PROXY=1` (Node ≥ 22.21).

## Looks like GitHub
- **Page chrome:** PR title and number, Open / Draft / Merged / Closed badge, "X wants to merge N commits into
  *base* from *head*", the Conversation / Commits / Checks / Files changed tabs with counts (the others link to
  GitHub), a sticky toolbar with the totals, and the green **Review changes** button with its pending-comment count.
- **Review changes dialog:** "Finish your review" with a summary, Comment / Approve / Request changes, and your
  pending comments; Submit posts them as one review.
- **File tree** of *every* changed file (folders collapse and single-child chains merge like GitHub's), with
  status icons, comment counts, a filter, and "viewed" progress. Non-markdown files link to their diff on GitHub.
- **Stacked file cards** with a sticky header: collapse, copy path, `+N −N` and the five-square diffstat, a
  **Viewed** checkbox (collapses the file, remembered in this browser), and a **Rendered / Source diff** toggle.
- **Rendered view** uses GitHub's own markdown CSS (`github-markdown-css`) and highlight.js's GitHub themes, light
  and dark. It also does what GitHub's renderer does: task lists, `> [!NOTE]` alerts, heading permalinks, aligned
  tables, `<details>` and other raw HTML (sanitized with DOMPurify), relative links to the file on GitHub at the
  PR's head commit, relative images served from it.
- **Removed sections, like GitHub's rich diff.** Deleted paragraphs, list items, table rows and code blocks are drawn in
  red, in place, from the PR's *merge-base* version (what GitHub actually diffs against), above their green replacements.
  Comments work across the diff:
  - select inside removed text: a **left-side** comment on the *old* file's lines;
  - select kept or added text: a normal new-side comment;
  - select across both: anchored to the new lines you covered (GitHub allows one side per comment), with the removed
    text quoted as a fenced `diff` block so nothing is lost;
  - existing left-side threads and your drafts sit beside the removed block they are about.
- **Source diff view:** the unified diff with old and new line numbers, Primer's diff colours, hunk headers,
  existing threads inline under their lines (left-side ones under the removed line, outdated ones grouped), a hover
  **+** to comment on a line and shift-click to extend a range within the hunk. Comments on removed lines are posted on
  the `LEFT` side.
- Threads show avatars, the author association (Owner / Member / …), "commented 2 days ago", and GitHub-flavoured
  markdown bodies; replies post straight to GitHub. In the rendered view they sit in a margin beside their text.

## How it works
- markdown-it stamps every rendered block with its source line range (`token.map`).
- A selection is mapped to source lines; inside a hard-wrapped paragraph the line is refined by word position.
- GitHub only accepts comments on lines inside the diff, and a multi-line range must sit in one hunk.
  Rico clamps to the hunk with the most overlap, tells you when it did, and quotes the full selection in the comment.
  Selections wholly outside the diff go into the review summary with a quote.
- **Quotes.** A comment keeps GitHub's native line range; the body can also quote the relevant parts of
  your selection: prose as a blockquote, code (and D2) as a fenced block of the source lines with its
  language. "Include quote" defaults on only when it adds information (a partial line, a clamped range, or
  text outside the diff) and the quote is editable before you add the comment. Long selections keep
  their head and tail with an ellipsis.
- **Diagrams (D2 and Mermaid), rendered client-side.** `d2` and `mermaid` code blocks render in the browser
  (D2 as WASM via `@terrastruct/d2`, Mermaid as plain JS); both are *optional* dependencies loaded on demand,
  and without them the source is shown with an install hint. Click a **node or edge** to comment on the source
  line that defines it (the comment box names the element); click empty space to comment on the whole block;
  open "source" to comment on a specific line. Broken diagrams show their compile errors inline.
  - *Line mapping.* D2: exact, from the compiler's source ranges (a node defined on several lines anchors to its
    first definition and lists the others). Mermaid: from element ids and labels (flowchart nodes and edges,
    sequence actors and messages); anything it cannot place falls back to the whole block.
  - *Safety.* Diagram source is untrusted. Each diagram is drawn in a sandboxed `iframe` with **no scripts** and a
    CSP that blocks **all network requests**, so a `javascript:` link, an `onclick`, or an `icon:` URL pointing at
    another host can do nothing (tested, including that the CSP blocks the icon fetch).
- Relative images are served from the PR's head commit (images only).
- Gutter bars: green = changed, blue = commentable context, grey = outside the diff.
- Existing review threads show in a margin beside the text (like Google Docs), aligned with the blocks they
  are anchored to. Hover a thread to highlight its text; click highlighted text to jump to the thread; reply
  from the margin. Outdated threads are labelled. Your unposted drafts appear there too, dashed.
- Queued comments persist in `localStorage` per PR + head commit.

## Tests
```bash
npm test         # pure logic + server integration (security checks, GitHub proxying) against a fake GitHub API
npx playwright install chromium   # once
npm run e2e      # headless Chromium with real mouse drags against the same fake; writes e2e/*.png
```

### Real browser, real input (Linux)
```bash
bash e2e/desktop/run.sh   # needs Xvfb, xdotool, ImageMagick, google-chrome
```
Launches a headed Chrome on a virtual screen and drives it with OS-level mouse and keyboard events
(xdotool), screenshotting the actual screen into `e2e/desktop/out/`. It exercises hover, drag-select,
typing, replying, opening Review changes and clicking Submit against the fake GitHub. It has caught two bugs the
headless tests missed: Submit hidden below the fold in a normal window, and the review dialog running off the bottom of
the screen when the page was scrolled to the top.

### Against real GitHub
`brianv0/rico` has four `[test]` pull requests (never meant to merge), each a different diff shape:

| PR | Covers |
|----|--------|
| [#1](https://github.com/brianv0/rico/pull/1) | one doc edited in several hunks; real threads incl. multi-line, left-side, 3-message, and an outdated one |
| [#2](https://github.com/brianv0/rico/pull/2) | a new file with a relative PNG, plus a modified file |
| [#3](https://github.com/brianv0/rico/pull/3) | rename + edit, a pure rename (no patch at all), a deletion |
| [#4](https://github.com/brianv0/rico/pull/4) | a 2,000-line document (scale) |

```bash
npm start                         # with GITHUB_TOKEN set
node e2e/real/check-prs.cjs       # read-only: 20 checks across all four PRs, posts nothing
REAL_PR=1 bash e2e/desktop/run.sh # real Chrome + OS input on PR #1; dry run
RICO_POST=1 REAL_PR=1 bash e2e/desktop/run.sh   # same, but posts a real review to PR #1
```

## Known limits
- Removed blocks are whole blocks: a paragraph with one changed line shows the full old paragraph in red above the new
  one (no word-level highlighting). A removed list item or table row is placed back in its list or table; everything
  else becomes a standalone block. If the old file can't be fetched, removals are still visible in the Source diff.
- Resolved/unresolved thread state isn't shown (the REST API doesn't expose it; it would need GraphQL).
- GitHub doesn't document whether a multi-line comment may span hunks, so Rico stays within one (and says so).
- The Conversation, Commits and Checks tabs open on GitHub; Rico only reviews files.
- No expandable hidden context between hunks in the Source diff view yet, no emoji shortcodes or footnotes.
- Mermaid element mapping covers flowcharts and sequence diagrams; other types comment on the whole block.

## Development
`public/icons.js` is generated from `@primer/octicons` (`node scripts/gen-icons.mjs`); the vendored page styles and
highlighting come from `github-markdown-css`, `@highlightjs/cdn-assets` and `dompurify`, served from `node_modules`.
