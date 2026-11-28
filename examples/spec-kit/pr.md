# Spec Kit: plan, research, data model and tasks (spec already merged)

A fake [Spec Kit](https://github.com/github/spec-kit) project, for trying the **Spec Kit review flow** in [Rico](https://ricorico.dev). Never meant to merge.

It is the second step of a Spec Kit feature, stacked the way a real one is: the base branch (`spec-kit/base`) already holds the constitution and the spec for a made-up "review digest" feature, and this PR adds what `/speckit.plan` and `/speckit.tasks` would write.

## What to look at in Rico

- **Changed**: `plan.md`, `research.md`, `data-model.md`, `quickstart.md`, `tasks.md` (markdown, read as steps), and `contracts/digest-api.yaml` (not markdown: it stays in the file tree and opens on GitHub).
- **Unchanged, shown beside them for reference**: `spec.md`, `checklists/requirements.md` and the constitution.
- **Open questions**: one in `plan.md` (where exclusions are stored) and one in `spec.md` (FR-006, the delivery channel). The second is in an unchanged file, so it only shows because the reference is loaded. The checklist line "No [NEEDS CLARIFICATION] markers remain" only names the marker and must *not* count.
- **Ids**: `FR-001`..`FR-006` and `SC-001`..`SC-003` in the spec; `T001`..`T017` in `tasks.md`, which cite the `FR-` ids and each other ("after T007").
- **Other things in there**: a mermaid diagram and code fences in `plan.md` (the open-question marker must not be drawn inside code), and a checklist file.

## Try it

1. Open this PR in Rico. The toolbar should say **Review flow · Spec Kit**, with the steps in order: constitution, spec, checklist, plan, research, data model, quickstart, tasks.
2. Push another commit to `spec-kit/pr` after you have looked, then reload: **Changes** offers "since your last visit".
