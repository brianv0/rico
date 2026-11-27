# Getting started

This guide walks through reviewing a pull request with Rico.

## 1. Start the server

Run `npm start` and open http://localhost:4317. Rico reads your token from `GITHUB_TOKEN`, or from
`gh auth token` if you are logged in with the GitHub CLI.

## 2. Load a pull request

Paste a link such as `https://github.com/owner/repo/pull/123`, or the short form `owner/repo#123`.
Rico lists the markdown files the pull request changes.

## 3. Comment

Select any text. A comment box appears over it. Press Ctrl+Enter to add the comment to your review.

![Overview](../img/diagram.svg)

## 4. Submit

Choose Comment, Approve or Request changes, and submit. All queued comments are posted as one review.
