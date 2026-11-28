## Context

Rico holds a GitHub token for each signed-in person for the life of their session. It uses it for everything from reading a diff to approving a pull request. Approving and requesting changes are the two actions that other people rely on and that cannot be taken back quietly.

## Goals / Non-Goals

**Goals:**

- Make a copied session cookie much less useful for the actions that matter.
- Cost the person nothing on a normal day: a fresh sign-in only when the session is old.

**Non-Goals:**

- Adding a second factor of our own. GitHub's sign-in is the factor.
- Protecting ordinary comments. They can be edited or deleted.

## Decisions

### Ask GitHub again, do not build a code prompt

Sending the person through GitHub's authorisation again re-checks whatever second factor their account has. A code prompt of our own would be a second thing to secure and to keep in step.

Alternatives considered: a one-time code by email (needs an email address we do not hold), and a TOTP secret per person (we would have to store it).

### One hour is "fresh"

An hour is long enough that someone reviewing a pull request is not interrupted, and short enough that a cookie taken yesterday does not qualify.

Alternatives considered: fifteen minutes (interrupts a long review), a full day (a stolen cookie would often still qualify).

### Keep the audit trail small

Only approvals and change requests are written, with the pull request, the time and the verdict. Comment text is never copied into it.

## Risks / Trade-offs

- A person with an old session loses their review draft if the sign-in redirect is not handled. Mitigation: drafts are already kept in the browser and restored after a sign-in (see Task 2.3).
- Shortening sessions signs everyone out on the day it ships. Mitigation: say so in the release note.
