# Tasks: Review digest

**Input**: Design documents from `/specs/001-review-digest/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependencies)
- **[Story]**: which user story the task belongs to

## Phase 1: Setup

- [ ] T001 Create the module skeleton in `src/digest.js`
- [ ] T002 [P] Add digest fixtures in `test/fixtures/digest.json`

## Phase 2: Foundational (blocks all user stories)

- [ ] T003 Add the `/api/digest` route in `src/github.js` that returns an empty list (FR-005: nothing is stored)
- [ ] T004 [P] Teach the fake GitHub in `test/fake-github.js` to answer the pull request search the route makes

## Phase 3: User Story 1 - See what is waiting on me (Priority: P1)

- [ ] T005 [P] [US1] Contract test for `GET /api/digest` in `test/server.test.js` (FR-001, FR-002)
- [ ] T006 [P] [US1] Unit tests for "someone else wrote last" in `test/digest.test.js` (FR-001)
- [ ] T007 [US1] Implement the grouping and ordering in `src/digest.js`, after T006 (FR-002)
- [ ] T008 [US1] Implement the route in `src/github.js`, after T005 and T007 (FR-001, FR-005)
- [ ] T009 [US1] Mark threads whose text changed, reusing the re-anchoring in `public/anchor.js` (FR-003)
- [ ] T010 [US1] Show the list in the toolbar in `public/app.js`
- [ ] T011 [US1] Browser test for the whole story in `e2e/digest.mjs`

## Phase 4: User Story 2 - Say what counts (Priority: P2)

- [ ] T012 [P] [US2] Test that an excluded repository is left out in `test/server.test.js` (FR-004)
- [ ] T013 [US2] Add the `exclude` parameter to the route in `src/github.js` (FR-004)
- [ ] T014 [US2] Remember exclusions in `public/app.js` under `rico:digest:exclude` (FR-004)

## Phase 5: User Story 3 - Get it without opening Rico (Priority: P3)

- [ ] T015 [US3] Blocked on the open question in FR-006: choose the channel, then write the tasks

## Phase 6: Polish

- [ ] T016 [P] Document the digest in `README.md`
- [ ] T017 Run through `quickstart.md` by hand

## Dependencies

- Phase 2 blocks everything after it. T007 needs T006; T008 needs T005 and T007; T010 needs T008.
- US2 can start once T008 is done and does not need US3.
