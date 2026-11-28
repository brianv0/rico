# Rico Constitution

## Core Principles

### I. The browser never holds a secret
The GitHub token lives on the server (or in an encrypted, `HttpOnly` cookie). Nothing a page can read may be a credential.

### II. GitHub is the system of record
Comments, reviews and resolved state live on GitHub. Rico may cache what it needs to be fast, but never stores comment text of its own.

### III. Test first
A behaviour is specified by a failing test (unit, server, or browser) before it is built. Browser tests run against the fake GitHub.

### IV. Few dependencies
A new runtime dependency needs a written reason. Prefer a few lines of plain JavaScript to a package.

### V. Every feature has a fallback
If GitHub refuses a request (GraphQL blocked, rate limit, a missing field), the page still loads and says what is missing.

## Governance
This constitution outranks other practices. An amendment needs a pull request that states what changes and why.

**Version**: 1.0.0 | **Ratified**: 2026-11-20 | **Last Amended**: 2026-11-20
