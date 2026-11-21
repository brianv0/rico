# Getting started

This guide walks through reviewing a pull request with Rico.

## 1. Start the server

Run `npm start` and open http://localhost:4317. Rico reads your token from `GITHUB_TOKEN`, or from
`gh auth token` if you are logged in with the GitHub CLI.

## 2. Load a pull request

Paste a link such as `https://github.com/owner/repo/pull/123`, or the short form `owner/repo#123`.
Rico lists the markdown files the pull request changes.

## 3. Comment

Select any text, then pick an icon under it: one comments with a quote, the other comments on the lines. The box opens in the margin beside the text. Press Ctrl+Enter to add the comment to your review.

![Overview](../img/diagram.svg)

## How a comment travels

```d2
direction: right
reviewer: Reviewer {shape: person}
rico: Rico {
  select: Select text
  icons: Quote or lines icon
  pending: Pending review
  select -> icons -> pending
}
github: GitHub {shape: cylinder}
reviewer -> rico.select: highlights
rico.pending -> github: one review
github -> rico: threads and diff
```

The server keeps the token, so the browser never sees it:

```d2
browser -> server: /api/pr
server -> github: REST with token
github -> server: diff + comments
server -> browser: JSON (no token)
```

## 4. Submit

Choose Comment, Approve or Request changes, and submit. All queued comments are posted as one review.
