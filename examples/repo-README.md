# rico-examples

Example pull requests for [Rico](https://github.com/brianv0/rico), which reviews markdown in GitHub pull requests the way it will be read. Each one is a fake project in the shape of an AI spec-driven **review flow**, so you can try Rico on it without touching real work.

| Review flow | Pull request | What it shows |
|-------------|--------------|---------------|
| [Spec Kit](https://github.com/github/spec-kit) | see the `spec-kit/pr` pull request | plan, research, data model and tasks beside an already merged spec, constitution and checklist |
| [Superpowers](https://github.com/obra/superpowers) | see the `superpowers/pr` pull request | a plan for a merged design, and a new design with its plan |
| [OpenSpec](https://github.com/Fission-AI/OpenSpec) | see the `openspec/pr` pull request | a change (proposal, design, tasks, delta specs) beside the current spec |

**Open one in Rico:** paste its link into [ricorico.dev](https://ricorico.dev), or use `https://ricorico.dev/github.com/brianv0/rico-examples/<number>`.

**None of these are meant to merge.** Each PR is based on its own `<flow>/base` branch, not on `main`.

They are generated from the fixtures in [`examples/`](https://github.com/brianv0/rico/tree/main/examples) in the Rico repository with `node scripts/seed-examples.mjs brianv0/rico-examples`, so they can be rebuilt (or given a second round of commits) at any time.
