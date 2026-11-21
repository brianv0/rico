# Rico — rich comments

Review a GitHub PR's markdown the way it will be read, in a page built to look like GitHub's **Files changed**.
Select any text, even across several paragraphs, and a comment box appears beside it, like Google Docs. **Comment** posts
at once (`POST /pulls/{n}/comments`: `line` / `start_line` / `side`) and the thread lives in the right margin: reply, edit
and delete your own comments, resolve and reopen, react. **Start a review** keeps a comment *pending on GitHub* (a real pending
review, so it also shows up on github.com and on your other devices) until you **Finish review**.

```bash
export GITHUB_TOKEN=...      # or just be logged in with `gh auth login`
npm install
npm start                    # http://localhost:4317
```

Paste a PR URL (or `owner/repo#123`). Your token stays on the local server and never reaches the browser.

The address bar always names what you are looking at, so it can be shared: `localhost:4317/github.com/owner/repo/123@abc1234?file=docs/plan.md` (instance, repo, PR, the head commit it was loaded at, and the open file). If the PR has moved on since the link was made, Rico says so. Older `#pr=…` links still work.
Behind an HTTP(S) proxy? Node's `fetch` ignores `HTTPS_PROXY` unless you start with `NODE_USE_ENV_PROXY=1` (Node ≥ 22.21).

## Looks like GitHub
- **Page chrome:** PR title and number, Open / Draft / Merged / Closed badge, "X wants to merge N commits into
  *base* from *head*", the Conversation / Commits / Checks / Files changed tabs with counts (the others link to
  GitHub), a sticky toolbar with the totals, and the green **Review changes** button with its pending-comment count.
- **Finish review dialog:** the toolbar button reads *Finish review (N)* while you have N pending comments. The dialog has a
  summary and the verdict (Comment / Approve / Request changes; the last two are hidden on your own PR). The verdict lives only
  here: single comments never carry one. Submit sends GitHub's own pending review; *Discard review* deletes it.
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
- **Commenting** (the Google-Docs part):
  - *Comment* posts immediately and shows in the margin as "posting…", then as GitHub's comment (with its permalink). If GitHub
    refuses (locked conversation, archived repo, the line left the diff, rate limit) the text stays in a "Not posted" card with
    GitHub's reason and **Try again** / **Discard**.
  - *Start a review* / *Add to review* uses GraphQL (`addPullRequestReview`, `addPullRequestReviewThread`,
    `submitPullRequestReview`). GitHub allows one pending review per user per PR: Rico reuses the one that exists, wherever it was started.
  - Text **outside the diff** cannot be an inline comment: it is posted as a normal PR comment (`POST /issues/{n}/comments`)
    that names the file and lines and quotes the text. Rico finds that quote in the rendered page and shows the comment beside it;
    PR comments it cannot place (and ones with no quote) are listed under **General** above the files.
  - Each thread offers only what you may do (GraphQL `viewerCanResolve` / `viewerCanUpdate` / `viewerCanDelete`; without GraphQL,
    your own comments by login): **Reply**, **Edit** / **Delete** your own, **Resolve** / **Reopen** (resolved threads fold to one
    line; *Show* expands them), and a permalink on every comment. Locally `/api/me` returns the token's login, so "yours" works there too.
  - **Reactions** show under each comment; the ☺ picker adds one (`POST /pulls/comments/{id}/reactions`), clicking your own removes it.
  - Unsent text (the comment box, reply boxes) is saved in this browser and comes back after a reload or a sign-in. Signed out
    (preview), *Comment* keeps the box open with a sign-in link that returns to the same page.
  - **Ctrl/Cmd+Alt+M** comments on the current selection. The pill has one *Comment* icon; the quote is added by itself when the
    selection is part of a line, a diagram, or outside the diff.
- **Live refresh.** While the tab is visible Rico re-reads the PR's comments every ~25 s with conditional requests
  (`If-None-Match` on the PR, its review comments and its PR comments), so an unchanged PR answers `304` and costs nothing against the
  rate limit; others' comments and replies appear without a reload, and an open reply box keeps its text and focus. A hidden tab
  polls nothing; signed-out preview polls every 2 minutes. If the PR's head commit changes, a banner says so (*Reload*), and the
  comment box warns that lines may have moved.
- **Exact words.** GitHub keeps whole lines; Rico's selections are word-precise. A partial-line comment carries a short blockquote of
  the selected words, and when comments load Rico finds that quote in its line and highlights exactly those words (CSS Custom Highlight
  API; a comment without a findable quote highlights the block). Nothing is hidden in comment bodies. Outdated comments render faded, their quote struck through.
- **Suggest edit.** The pill's second icon opens an editor with the *raw markdown source lines* the selection covers and a live
  red/green preview; it posts a GitHub ` ```suggestion ` comment (the author sees *Apply suggestion*). Suggestions replace whole
  lines, and are offered only on new-file (right-side) lines inside one hunk: the icon is disabled, with the reason as its tooltip,
  for removed text, text outside the diff, or a selection that spans hunks. An empty replacement suggests deleting the lines. Existing
  suggestions render in threads as a diff against the lines they replace. A suggestion is a normal comment: *Comment* posts it now,
  *Start a review* batches it.
- **Long threads and long margins.** A thread with 3+ messages folds to its first and last message (a "N more replies" row with avatars);
  very long messages clamp. Hovering a moment (or keyboard focus) *peeks*: the full card floats over its neighbours without moving them;
  clicking "more replies" / "Show more" (or starting a reply) *pins* it open. Every card is tied to its words by a faint **ribbon** in
  the gutter (solid for the hovered or active thread, dashed for resolved), and a strip of **ticks** by the scrollbar marks every thread
  in the page (accent = open, amber = pending, grey = resolved, wide = yours); click one to jump there.
  When the comments would make the margin much longer than the document (`auto` mode: > 1.25 × the document and > 1.5 × the window),
  the margin becomes **synced**: a sticky, window-high column with the cards stacked, and *non-linear scrolling*. A focus line sits
  about a third down the window; the margin slides so the thread at the focus line is level with its text, moving fast through a long
  discussion and barely at all through plain text (piecewise linear through the text-position / card-position pairs, `mapPosition` in
  `lib.js`). The wheel over the margin scrolls at the margin's own speed (the page follows through the inverse mapping), "▲ 3 above /
  ▼ 8 below" jump to what is out of view. The header button *Comments: auto / aligned / synced* chooses (remembered in this browser);
  narrow windows stack the comments under the text as before.
- Threads show avatars, the author association (Owner / Member / …), "commented 2 days ago", and GitHub-flavoured
  markdown bodies; replies post straight to GitHub. In the rendered view they sit in a margin beside their text.

## How it works
- markdown-it stamps every rendered block with its source line range (`token.map`).
- A selection is mapped to source lines; inside a hard-wrapped paragraph the line is refined by word position.
- GitHub only accepts comments on lines inside the diff, and a multi-line range must sit in one hunk.
  Rico clamps to the hunk with the most overlap, tells you when it did, and quotes the full selection in the comment.
  Selections wholly outside the diff become a PR comment with a quote.
- **Quotes.** A comment keeps GitHub's native line range; the body can also quote the relevant parts of
  your selection: prose as a blockquote, code (and D2) as a fenced block of the source lines with its
  language. When GitHub can anchor fewer lines than you selected (a range crossing hunks), the comment still says so in words:
  *Selected lines 24–27 of `path`. GitHub can only anchor line 24 here, but this comment is about all of lines 24–27.* — so a
  person or an AI agent reading it on GitHub gets the full range. A collapsed `<details>` block under the comment holds the actual selected source lines and
  the commit they are from (each line cut to 240 characters, ranges over 40 lines to their head and tail). The quote is included only when it adds information (a partial line, a diagram, a clamped range, or
  text outside the diff). Long selections keep their head and tail with an ellipsis.
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
- Comments live on GitHub (single or pending); only the review summary, "viewed" marks and unsent text are kept in `localStorage`.
- **Backstop headers on every response:** a `Content-Security-Policy` (script stays same-origin; D2's WASM
  renderer and its ELK layout worker are the only eval-shaped exceptions), `X-Frame-Options: DENY` and
  `X-Content-Type-Options: nosniff`. A sanitizer regression cannot run script in the page, and a remote
  site cannot frame the app to clickjack a review. `.` and `..` are never accepted as owner/repo, since
  fetch would collapse them out of the `/repos/{owner}/{repo}/` API path.

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
- Resolve, thread permissions and pending reviews need GraphQL. If it is unavailable (some proxies block it) Rico still loads and
  comments, but resolve/reopen and *Start a review* are not offered or fail with GitHub's message.
- Replying inside a thread while you have a pending review goes through the REST reply endpoint, which GitHub may refuse; finish the review first.
- GitHub doesn't document whether a multi-line comment may span hunks, so Rico stays within one (and says so).
- The Conversation, Commits and Checks tabs open on GitHub; Rico only reviews files.
- No expandable hidden context between hunks in the Source diff view yet, no emoji shortcodes or footnotes.
- Mermaid element mapping covers flowcharts and sequence diagrams; other types comment on the whole block.

## Development
`public/icons.js` is generated from `@primer/octicons` (`node scripts/gen-icons.mjs`); the vendored page styles and
highlighting come from `github-markdown-css`, `@highlightjs/cdn-assets` and `dompurify`, served from `node_modules`.


## Deploy to Cloudflare

Rico also runs as a hosted app on Cloudflare Workers. People sign in with **GitHub OAuth** and review as themselves;
there is no shared token. The access token lives only in an encrypted, `HttpOnly` cookie (AES-GCM, key derived from
`SESSION_SECRET`), and nothing is stored on the server. The same code serves the app: `src/github.js` is shared by the
local server and the Worker (`src/worker.js`).

1. **Create a GitHub OAuth app** (GitHub → Settings → Developer settings → OAuth Apps → New). Set the
   *Authorization callback URL* to `https://ricorico.dev/auth/callback` (for `wrangler dev`, make a second app with
   `http://localhost:8787/auth/callback`). The Worker is routed to `ricorico.dev` in `wrangler.toml`; the domain must be
   a zone in your Cloudflare account.
2. Put the app's **client id** in `wrangler.toml` (`GITHUB_CLIENT_ID`). Set `OAUTH_SCOPE` to `public_repo` if Rico should
   only touch public repositories (the default `repo` is needed for private ones).
3. Store the secrets:
   ```bash
   npx wrangler secret put GITHUB_CLIENT_SECRET
   npx wrangler secret put SESSION_SECRET   # any long random string: openssl rand -base64 32
   ```
4. Deploy:
   ```bash
   npm install && npm run deploy
   ```

**Fallback deploy (no Workers Assets).** `npm run deploy:embed` deploys the same Worker with the static app embedded in
the script (`scripts/build-embed.mjs`, `src/worker-embed.js`, `wrangler.embed.toml`; about 7 MB gzipped, so it needs a paid
Workers plan). Use it where the Workers Assets upload cannot be made, for example behind an API proxy that replaces the
short-lived upload key wrangler sends. A later `npm run deploy` switches back to Workers Assets.

**Session storage.** By default the whole session is the encrypted cookie (like oauth2-proxy's cookie store). For
stronger handling, bind a KV namespace named `SESSIONS` (see the commented block in `wrangler.toml`): the token is then
encrypted with a key made of `SESSION_SECRET` *and* a random half carried only by the cookie, and the ciphertext lives in
KV (like oauth2-proxy's Redis store). The cookie alone holds nothing, KV alone can't be decrypted, and **Sign out deletes
the KV entry**, so a copied cookie stops working immediately. In the default mode a stolen cookie works until it expires
(30 days).

**Preview mode.** Signed-out visitors can open public pull requests read-only (a "Preview · read-only" badge and a
Sign in button show in the header); commenting, replying and posting a review need sign-in. Private repositories are
never shown without it. GitHub allows only 60 anonymous requests an hour per IP, and a Worker shares IPs, so set a
`PREVIEW_TOKEN` secret: a token with **no private access** (a classic token with no scopes, or a fine-grained one
limited to public repositories) that only lifts the rate limit. Good responses are cached at the edge for a minute.
Never give `PREVIEW_TOKEN` access to private repositories: its responses are shared between visitors.

`npm run dev:cf` runs the Worker locally (`wrangler dev`, with the same variables in a `.dev.vars` file). Changing
`SESSION_SECRET` signs everyone out. Locally, `npm start` is unchanged and uses your own token.
