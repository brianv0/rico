# Plan: GitHub App, less OAuth scope, and more client-side work (for GHE behind a VPN)

Status: proposal. Nothing here is implemented yet. Items marked **(verify)** are from memory of GitHub's docs and
could not be checked from the build sandbox (its proxy rejects CORS preflights), so confirm them against your
GHES version before relying on them.

## Why the Worker cannot serve a VPN-only GHE

The Worker runs on Cloudflare's network. A GHE host reachable only over the VPN is invisible to it, so `/api/*`
(which the Worker proxies today via `GITHUB_API_URL`) and `/auth/callback` (which exchanges the code server side)
cannot work for it. Only the user's browser (or the local `npm start`) can reach that host. So for GHE the choice is
not "how much to move client side" but "everything that touches GHE must".

## What already helps

`src/github.js` is web-standard only (no Node built-ins) and ends in `route(method, url, readBody) -> Response`.
That is exactly the shape a `fetch` replacement needs, so the browser can run it unchanged:

```js
// public/app.js, api(): in client mode, call the same router in the page instead of /api/*
const res = clientGithub ? await clientGithub.route(method, new URL(path, location.origin), readBody) : await fetch(path, opts);
```

`getToken` comes from memory (or `sessionStorage`), and `apiUrl` is `https://<ghe-host>/api/v3`. GHES serves CORS
on its API **(verify)**, as does api.github.com. The 564-line GitHub half is then reused, not rewritten.

What cannot move: `/api/icon` (fetches arbitrary third-party hosts, no CORS), and `/api/raw` (images need
`blob:` URLs and `img-src blob:` in the CSP). Both are cosmetic and can degrade (no D2 icons, images via
`raw.githubusercontent`-style absolute links) in client mode.

## 1. Switch to a GitHub App (user-to-server tokens)

Permissions to request (everything else: none):

| Permission | Level | Used for |
|---|---|---|
| Pull requests | Read & write | PR, files, review comments, pending reviews, replies, resolve, reactions, PR-level comments (`/issues/{n}/comments` is covered by this) |
| Contents | Read | file text at head/merge-base, images |
| Metadata | Read | automatic |

That replaces the OAuth `repo` scope (full read/write to code) with no write access to code at all.

Behaviour changes to plan for:

- **Installation is required.** A user token can only touch repos where the app is installed *and* the user has access.
  For private repos the org must install (or approve) the app. For a public repo without the app, reads work but
  writes return 403 "Resource not accessible by integration". The UI needs a "Install Rico on this repo/org" prompt
  (`https://github.com/apps/<slug>/installations/new`) in place of the generic error.
- **Tokens expire** if "Expire user authorization tokens" is on (recommended): 8 h access token plus a 6-month refresh
  token. `session.js`/`createSession` must store `{ t, r, exp }`, and the Worker refreshes (needs the client secret)
  on 401 or before `exp`. Sign-out should also revoke (`DELETE /applications/{client_id}/token`).
- **`scope` is ignored** by GitHub Apps; drop `OAUTH_SCOPE`. `callback` already sends no `scope` on the exchange.
- **`/user`, search and GraphQL**: `apiMe` works. The GraphQL autocomplete candidates only see repos the app is
  installed on; expect a thinner list.
- A second stage app mirrors the existing stage OAuth app (own client id, callback `…/auth/callback`).

## 2. PKCE

Worth adding now on github.com: GitHub accepts `code_challenge` / `code_challenge_method=S256` on the web flow for
both OAuth and GitHub Apps **(verify, and verify per GHES version; older GHES ignores the parameters)**. In
`login()` generate a verifier, seal it into the existing `rico_oauth` cookie next to `state`, send the challenge, and
send `code_verifier` in `callback()`. It is a cheap defence-in-depth win and harmless where unsupported.

What PKCE does **not** give us, as far as I know: GitHub still requires `client_secret` at
`/login/oauth/access_token` even with PKCE **(verify)**, and that endpoint sends no CORS headers, so a pure browser
app cannot do the code exchange. PKCE alone therefore cannot make the browser a standalone public client on
GitHub or GHES.

## 3. Getting a token in the browser for GHE

| Option | Secret needed | Works in browser | Notes |
|---|---|---|---|
| Paste a fine-grained PAT (GHES ≥ 3.10) or classic PAT | none | yes | Hold it in memory or `sessionStorage`, never `localStorage`. Scope it to Pull requests R/W + Contents R. Simplest; recommended first step. |
| Device flow | none (needs "Enable Device Flow") | probably not: `/login/device/code` has no CORS **(verify)** | Would need a relay, which cannot be on the VPN-blind Worker. |
| Code flow + PKCE, browser-only | secret still required | no | see section 2 |
| Local `npm start` with `GITHUB_TOKEN` | none | n/a | Already works on the VPN today; keep as the supported GHE path. |
| Rico self-hosted inside the VPN | yes | yes | The Worker code runs as-is in the intranet; no browser limits. Best for a team. |

## 4. Browser-side risks

- **CSP.** `connect-src 'self' https://cloudflareinsights.com` blocks calls to a GHE host. A static
  `connect-src https:` would remove the exfiltration backstop for a page that renders untrusted PR content. Prefer
  adding only the user's chosen host, e.g. the Worker sets `connect-src` from a validated `ghe` cookie or query
  parameter, or serve a separate `/ghe` entry point with its own CSP. Needs a decision.
- **Chrome Local Network Access.** A public site fetching a private-IP host triggers a permission prompt
  (and fails if denied or if GHE does not answer the preflight) **(verify for your Chrome and GHE versions)**. Hosting
  the static app inside the VPN avoids this entirely.
- **XSS exposure of the token.** A token in page memory is reachable by any script injection, unlike the HttpOnly
  cookie. DOMPurify plus the CSP are the only barrier; keep the PAT short-lived and minimal.

## Proposed order

1. PKCE on the existing web flow (small, independent).
2. GitHub App for github.com: refresh-token session, installation prompt, drop `OAUTH_SCOPE`, stage app, README.
3. Client mode in `app.js` + PAT entry, gated to a configured GHE host, using `route()` in the page; icon/raw degrade.
4. Narrow CSP for the chosen GHE host.

## Decisions needed

1. Is GHE access OK via a pasted PAT held in the browser, or must it be OAuth/App-based (which implies self-hosting inside the VPN)?
2. Should github.com keep the Worker flow (token in HttpOnly cookie) and only GHE go client side? (Recommended.)
3. Who can install the app on your orgs, and is public-repo commenting without installation acceptable to lose?
