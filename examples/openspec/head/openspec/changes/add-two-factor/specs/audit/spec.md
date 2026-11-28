# Delta for Audit

## ADDED Requirements

### Requirement: Trail of irreversible actions

The system SHALL record every approval and every request for changes made through it, with the pull request, the time and the verdict, and SHALL NOT record the text of any comment.

#### Scenario: An approval is recorded

- **WHEN** a person approves a pull request through Rico
- **THEN** an entry with the pull request, the time and "approved" is added to their trail

#### Scenario: Text is not recorded

- **WHEN** a person submits a review with a summary
- **THEN** the entry does not contain the summary

### Requirement: The person can read their trail

The system SHALL show a person their own trail, newest first, and SHALL NOT show it to anyone else.

#### Scenario: Another person's trail

- **WHEN** a person asks for the trail of someone else
- **THEN** they are refused
