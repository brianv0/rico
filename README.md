# Rico — rich comments

Review the *rendered* markdown of a GitHub PR in your browser. Select any text, even across
several paragraphs, and a comment box appears over the selection. Comments are posted as a real
PR review (`line` / `start_line` / `side` on the official REST API).

```bash
export GITHUB_TOKEN=...      # or just be logged in with `gh auth login`
npm install
npm start                    # http://localhost:4317
```

Paste a PR URL (or `owner/repo#123`). Your token stays on the local server and never reaches the browser.
Behind an HTTP(S) proxy? Node's `fetch` ignores `HTTPS_PROXY` unless you start with `NODE_USE_ENV_PROXY=1` (Node ≥ 22.21).

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
- **D2 diagrams.** ` + "```d2" + ` blocks render as diagrams (WASM, `@terrastruct/d2`, an *optional* dependency loaded on
  demand; without it the source is shown). They render as images, so scripts, `javascript:` links and
  external icons in untrusted diagram source are inert. Click a diagram to comment on its block; open
  "D2 source" to comment on a specific line; broken diagrams show their compile errors inline.
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
typing, replying and clicking Submit against the fake GitHub. This caught a bug the headless tests
missed: the Submit button was below the fold in a normal browser window.

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
node e2e/real/check-prs.cjs       # read-only: 21 checks across all four PRs, posts nothing
REAL_PR=1 bash e2e/desktop/run.sh # real Chrome + OS input on PR #1; dry run
RICO_POST=1 REAL_PR=1 bash e2e/desktop/run.sh   # same, but posts a real review to PR #1
```

## Known limits
Resolved/unresolved thread state isn't shown (needs GraphQL); threads on removed lines are only counted; whether GitHub accepts a range
spanning hunks is undocumented, so Rico stays within one.
