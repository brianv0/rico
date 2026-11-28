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

```mermaid
flowchart LR
  A[Select text] --> B{Which icon?}
  B -->|quote| C[Comment with quote]
  B -->|lines| D[Comment on lines]
  C --> E[Pending review]
  D --> E
  E --> F[Submit review]
  F --> G[(GitHub)]
```

And the conversation between the pieces:

```mermaid
sequenceDiagram
  participant U as Reviewer
  participant R as Rico
  participant G as GitHub
  U->>R: Load PR
  R->>G: Fetch files and comments
  G-->>R: Diff, threads
  U->>R: Select text and comment
  U->>R: Submit review
  R->>G: One review with all comments
```

## 4. Submit

Choose Comment, Approve or Request changes, and submit. All queued comments are posted as one review.
