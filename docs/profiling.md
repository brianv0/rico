# Profiling notes (pre-Cloudflare)

Harness: `scripts/profile/` (synthetic GitHub with latency, ETag/304 and rate-limit accounting; real Rico server; real Chromium over CDP).

```bash
node scripts/profile/profile-server.mjs 120      # upstream-call waterfall at 120 ms RTT
node scripts/profile/profile-ui.mjs --cpu        # browser load/layout/interaction, hottest functions
CPU_THROTTLE=4 node scripts/profile/profile-ui.mjs   # ~mid-range laptop
ONLY=diagrams node scripts/profile/profile-ui.mjs --cpu
```

Numbers are from a fast headless machine against a *fake* GitHub, so treat them as relative. Wall times at 4x CPU throttle are given in parentheses.

## GitHub traffic

| Finding | Evidence | Fix |
|---|---|---|
| `/api/pr` is fully serial: pull → files p1..pN → compare → comments p1..pN | max-parallel=1 in every scenario; 4 calls (small PR, 523 ms), 14 calls (large PR, 1.7 s) at 120 ms RTT | fetch pull + files p1 + comments p1 together; use `changed_files` / `review_comments` to fan out remaining pages (bounded concurrency); drop `compare` from the critical path (only needed to fetch the old version of a file that has deletions) |
| No conditional requests; a reload costs the same rate-limit points as a cold load | warm `/api/pr` = same 4/6/14 calls, `cost` == calls | store ETag + body per URL, send `If-None-Match`; a 304 is free against the primary limit |
| `/api/file` is `Cache-Control: no-store` although content is addressed by commit SHA | header observed; same file refetched upstream every time | `private, max-age=31536000, immutable` for sha-pinned paths; cache keyed by (user, repo, sha, path) |
| 8 eager file fetches on every load, plus a second per file with deletions | `EAGER = 8` (`app.js:223`) | fetch on viewport entry (IntersectionObserver), or batch into one GraphQL query with aliased `object(expression: "sha:path")` |
| Rate-limit headers ignored | `server.js:38-64` maps 403/429 to a generic error | read `x-ratelimit-remaining/reset`, `retry-after`; queue + back off; show "resets at HH:MM" in the UI |
| `/api/pr` payload grows with the PR: 16 KB / 180 KB / 529 KB | includes every file's patch and an `allFiles` list | lazy per-file patch; compress at the edge |

Rate-limit guidance to design around: GitHub asks clients to avoid concurrent requests per token and enforces secondary limits (concurrency, points per minute, spacing of content-creating requests). Fan out, but cap concurrency (about 4), and serialize per user, which a Durable Object per user gives you naturally.

## UI

| Finding | Evidence | Fix |
|---|---|---|
| `layoutMargin` forces one layout per margin card | 400 threads → 407 layouts, 131 ms layout, 115 ms self time (751 ms at 4x); 100 threads → 107 layouts | at `app.js:916-920` the loop writes `style.top` then reads `offsetHeight`. Read all heights first, then write |
| `layoutMargin` is triggered from many places with no coalescing | 20 diagrams → 225 layouts; also `ResizeObserver`, `fonts.ready`, window resize (`layoutAll`) | one rAF-scheduled layout per view with a dirty flag |
| Diagram rendering is slow and stalls when several files load together | 10 mermaid + 10 d2 in one file: 3.7 s. 4 files × 10 diagrams: after 25 s three files had 1/10 rendered (earlier run timed out at 120 s) | not root-caused; likely concurrent use of the single D2 instance / mermaid. Run all renders through one queue and render visible figures first |
| Large selections are superlinear | 4000-line file: 400 blocks → 831 ms (4.2 s at 4x); 40 blocks → 60 ms | not profiled in isolation; suspect the all-leaves scan with `intersectsNode` at `app.js:1143`. Restrict to blocks between the range ends |
| DOMPurify + `getBoundingClientRect` dominate load | 4000 lines: 79 ms + 83 ms of a 427 ms load; 47k DOM nodes | sanitize once per file in a worker, or render per section; `content-visibility: auto` on top-level blocks (check margin positioning still holds) |
| Fine as is | scroll does no script/layout work; 1000-line file loads in 226 ms (653 ms at 4x); resize 25–50 ms | |

## Not measured

Comment add/delete (`refreshAll` repaints every loaded file), `paintBlocks` complexity (O(blocks × threads), not in the hot lists at these sizes), real GitHub latency, a real PR with many removed blocks (`renderRemoved`).
