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

## Known limits
Resolved/unresolved thread state isn't shown (needs GraphQL); threads on removed lines are only counted; whether GitHub accepts a range
spanning hunks is undocumented, so Rico stays within one.
