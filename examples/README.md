# Rico examples

Fixtures for the example pull requests that live in a separate repository (so the app's own pull request list stays clean). Each folder is one example:

```
examples/<name>/
  pr.md        first line "# title", the rest is the pull request description
  base/        files on the base branch  (<name>/base, made from main)
  head/        files the pull request adds or changes (<name>/pr, made from <name>/base)
```

| Example | Review flow |
|---------|-------------|
| `spec-kit/` | Spec Kit: plan, research, data model and tasks beside a merged spec |
| `superpowers/` | Superpowers: a plan for a merged design, and a new design with its plan |
| `openspec/` | OpenSpec: a change beside the current spec |

`repo-README.md` is the README of the examples repository itself.

## Seeding a repository

Create an empty (or any) GitHub repository, then:

```bash
export GITHUB_TOKEN=...                           # to open the pull requests
node scripts/seed-examples.mjs owner/rico-examples          # all examples
node scripts/seed-examples.mjs owner/rico-examples --only openspec
node scripts/seed-examples.mjs owner/rico-examples --dry-run  # say what would happen
node scripts/seed-examples.mjs owner/rico-examples --dir ../rico-examples   # use an existing clone
```

It is safe to run again: an example whose pull request is already open is left alone. These paths are not matched by Rico's own review-flow detection (`specs/`, `openspec/` and `docs/superpowers/` are only recognised at a repository's root), so they do not change how pull requests to *this* repository are reviewed.

To give an example a second round (to try "changes since your review"), add a commit to its `<name>/pr` branch in the examples repository.
