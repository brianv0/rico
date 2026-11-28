# OpenSpec: a change that adds a fresh sign-in and an audit trail

A fake [OpenSpec](https://github.com/Fission-AI/OpenSpec) project, for trying the **OpenSpec review flow** in [Rico](https://ricorico.dev). Never meant to merge.

The base branch (`openspec/base`) holds the project's current `auth` spec. This PR adds one change, `add-two-factor`: a proposal, a design, tasks, and delta specs for two capabilities.

## What to look at in Rico

- **Review flow detected**: **Review flow · OpenSpec**, with the change's files in the order OpenSpec's own review guidance gives: proposal, spec changes, design, tasks.
- **The current spec shows up anyway**: next to the `auth` delta, Rico opens the *current* `openspec/specs/auth/spec.md` (unchanged) so the `MODIFIED` requirement can be compared with what it replaces. The `audit` delta is a new capability, so there is nothing to compare it with and no reference is added.
- **Delta headings**: `## ADDED Requirements` and `## MODIFIED Requirements`, with `### Requirement:` and `#### Scenario:` below them.
- **Tasks**: `1.1`-style checkboxes in `tasks.md`; the design points at "Task 2.3".

## Try it

1. Open this PR in Rico.
2. Push another commit to `openspec/pr` after you have looked, then reload: **Changes** offers "since your last visit".
