# Data Model: Review digest

Nothing here is stored on the server (FR-005). These are the shapes the route returns.

## DigestItem

| Field | Type | Notes |
|-------|------|-------|
| `pr` | `{owner, repo, number, title}` | the pull request the thread is on |
| `path` | string | the file |
| `line` | number or null | null when the thread is outdated |
| `lastAuthor` | `{login, bot}` | who wrote last; `bot` marks an agent |
| `lastBody` | string | the last message, cut to 200 characters for the list only |
| `textChanged` | boolean | FR-003 |
| `url` | string | the thread on GitHub |

## Exclusion

A repository, `owner/name`, kept by the page in `localStorage` under `rico:digest:exclude` as a JSON array (FR-004).

## Rules

- A thread is a `DigestItem` only if the viewer wrote in it and someone else wrote last (FR-001).
- Items are grouped by `pr` and, inside a group, ordered by the time of the last message, newest first (FR-002).
