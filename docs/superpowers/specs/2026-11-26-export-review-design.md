# Export a review as markdown: Design

**Date:** 2026-11-26
**Status:** Approved

## Intent

Reviewers keep asking for a way to paste "what I said on this PR" into a chat message or a ticket. Rico has the comments, grouped by file and line, but the only way out today is to copy them one at a time from GitHub. The point of this feature is that a reviewer can hand a colleague, or an agent, the whole review in one paste.

## Goals

- One action produces a markdown summary of the viewer's review: the verdict first, then each thread in reading order, with the text it was about and the replies.
- The summary reads well when pasted into GitHub, Slack, and a plain text editor.
- It is built from what the page already has loaded, so it is instant.

## Non-goals

- Exporting other people's reviews.
- Downloading a file. The clipboard is enough for now.

## Anti-goals

- Do not store the summary anywhere. It exists in the browser until it is pasted.
- Do not invent a new format. Plain markdown, nothing a reader has to learn.

## Constraints

- It needs a signed-in viewer: a review is somebody's.
- No new runtime dependencies.
- Whether resolved threads are included is TBD. Reviewers will want both; the default needs a decision once we have seen it used.

## Approaches

### A. Build the markdown in the browser (chosen)

A pure function takes the loaded threads and the verdict and returns a string. The page copies it.

Why: the threads are already in memory, the function is easy to test without a browser, and nothing new crosses the network.

### B. A server route that returns the markdown

The server would fetch the threads again and format them.

Why not: a second fetch of data the page already has, a new route to secure, and the formatting could not be tested without the server.

### C. Ask GitHub for the review as a document

GitHub has no such endpoint. Listed so nobody looks for it again.

## The decision

Approach A. The formatter lives in its own module so the page and the tests share it. The first line of the summary is the verdict and the pull request's title; each thread is a heading with the file and line, then the quoted text, then the messages with their authors.

## Left to the builder

- The exact wording of the headings.
- Whether the action sits in the toolbar or in the review dialog (the dialog is the likelier home: it is where the reviewer is already summing up).
- How long a quoted passage may be before it is shortened.
