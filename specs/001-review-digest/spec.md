# Feature Specification: Review digest

**Feature Branch**: `001-review-digest`
**Created**: 2026-11-27
**Status**: Draft
**Input**: User description: "Reviewers lose track of threads that an agent answered while they were away. Give them one list of what is waiting on them, across their open pull requests."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - See what is waiting on me (Priority: P1)

A reviewer comes back after a day away. They open Rico and see, in one list, every thread on their open pull requests where someone answered last, grouped by pull request.

**Why this priority**: This is the whole point of the feature. Without it, the reviewer opens each pull request in turn to find out whether anything happened.

**Independent Test**: With three open pull requests where the reviewer commented, and an agent reply on two of them, the digest lists exactly those two threads.

**Acceptance Scenarios**:

1. **Given** I commented on three pull requests and an agent replied on two, **When** I open the digest, **Then** I see those two threads and not the third.
2. **Given** a thread whose last message is mine, **When** I open the digest, **Then** that thread is not listed.
3. **Given** I resolve a thread on GitHub while the digest is open, **When** the digest refreshes, **Then** the thread disappears.

---

### User Story 2 - Say what counts (Priority: P2)

A reviewer who is part of many repositories excludes the noisy ones, so the digest stays short.

**Why this priority**: A digest that lists everything is ignored within a week.

**Independent Test**: Exclude one repository; none of its threads appear, and the choice is still there after a reload.

**Acceptance Scenarios**:

1. **Given** the digest lists threads from two repositories, **When** I exclude one, **Then** only the other remains.
2. **Given** I excluded a repository, **When** I reload the page, **Then** it is still excluded.

---

### User Story 3 - Get it without opening Rico (Priority: P3)

A reviewer who is not at a screen gets the digest where they already look.

**Why this priority**: Nice to have once the list itself is trusted.

**Independent Test**: Not yet testable: the delivery channel is undecided (see FR-006).

**Acceptance Scenarios**:

1. **Given** I asked for a digest, **When** the time comes, **Then** I receive it.

---

### Edge Cases

- What happens when a thread's text changed since the reviewer last looked, but nobody replied?
- What happens when GitHub's rate limit is reached while the digest loads?
- What happens when a pull request is closed between two refreshes?

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST list the threads on open pull requests where the viewer took part and someone else wrote last.
- **FR-002**: System MUST group the list by pull request and show who wrote the last message.
- **FR-003**: System MUST mark threads whose commented text changed since the viewer's last review.
- **FR-004**: System MUST let the viewer exclude repositories from the digest, and remember the choice.
- **FR-005**: System MUST NOT store comment text; threads are read from GitHub when the digest is requested.
- **FR-006**: System MUST deliver the digest by [NEEDS CLARIFICATION: delivery channel not specified - email, Slack, or in the app only?]

### Key Entities

- **Digest item**: one thread that is waiting on the viewer: its pull request, the file and line, the last author, and whether its text changed.
- **Exclusion**: a repository the viewer has asked not to hear about.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A reviewer finds the thread they need to answer in under ten seconds.
- **SC-002**: The digest loads in under three seconds for a reviewer with twenty open pull requests.
- **SC-003**: No digest item points at a thread that was resolved more than a minute earlier.

## Assumptions

- Reviewers are signed in with GitHub; there is no digest for signed-out visitors.
- "Open pull requests" means those the viewer authored, commented on, or was asked to review.
