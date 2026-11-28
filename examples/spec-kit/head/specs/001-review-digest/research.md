# Research: Review digest

## Where do the threads come from?

**Decision**: GraphQL `reviewThreads` for each open pull request the viewer is involved in, with a REST fallback.

**Rationale**: GraphQL says which threads are resolved and which the viewer may reply to. It is one request per pull request instead of one per thread.

**Alternatives considered**:
- REST `pulls/{n}/comments` only: always available, but cannot say whether a thread is resolved (FR-001 needs that), so resolved threads would appear in the digest.
- GitHub notifications API: reports activity, not whose turn it is, and is rate limited harder.

## Which pull requests count?

**Decision**: those the viewer authored, commented on, or was asked to review, found with one search per kind.

**Rationale**: matches the assumption in the spec and needs no state on our side.

**Alternatives considered**:
- Every open pull request in the viewer's repositories: far too many for a reviewer in a large organisation.

## How is "text changed" decided? (FR-003)

**Decision**: compare the lines a comment was made on, at the commit it was made on, with the same text in the current file.

**Rationale**: the same comparison Rico already makes to find an outdated comment again; no new mechanism.

**Alternatives considered**:
- GitHub's own `isOutdated` flag: true as soon as any line near the comment changes, which would mark most threads.

## Where are exclusions kept? (FR-004)

**Decision**: open. See the question in plan.md (Technical Context, Storage).
