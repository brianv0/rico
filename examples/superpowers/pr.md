# Superpowers: a plan for a merged design, and a new design with its plan

A fake [Superpowers](https://github.com/obra/superpowers) project, for trying the **Superpowers review flow** in [Rico](https://ricorico.dev). Never meant to merge.

It holds two features, laid out the way the Superpowers `brainstorming` and `writing-plans` skills leave them (`docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md` and `docs/superpowers/plans/YYYY-MM-DD-<feature>.md`). The base branch (`superpowers/base`) already holds the approved design for the first one.

## What is in the PR

| Feature | Design | Plan |
|---------|--------|------|
| Export a review as markdown | already merged (base branch, unchanged) | **added here** |
| Keyboard navigation | **added here** | **added here** |

## What to look at in Rico

- **Review flow detected**: the toolbar should say **Review flow · Superpowers**, with the features grouped oldest first.
- **The merged design shows up anyway**: the first plan names it on its `**Spec:**` line, so Rico opens it beside the plan as an unchanged reference.
- **Design, then plan** for the second feature, both changed.
- **Task ids link, per plan**: both plans have a "Task 1" and a "Task 2". A mention inside one plan jumps to *that plan's* heading, not the other's.
- **Open points**: the first design has a `TBD` (whether resolved threads are exported), and the first plan has a `TODO` inside a code block, which must *not* be marked.

## Try it

1. Open this PR in Rico.
2. Push another commit to `superpowers/pr` after you have looked, then reload: **Changes** offers "since your last visit".
