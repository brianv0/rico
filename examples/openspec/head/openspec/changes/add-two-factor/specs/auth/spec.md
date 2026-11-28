# Delta for Auth

## ADDED Requirements

### Requirement: Fresh sign-in for irreversible actions

The system SHALL require that the person has authorised with GitHub within the last hour before it approves a pull request or requests changes on their behalf.

#### Scenario: Old session

- **GIVEN** a session whose last GitHub authorisation was two hours ago
- **WHEN** the person submits a review that approves the pull request
- **THEN** the review is not posted
- **AND** they are sent through GitHub's authorisation again

#### Scenario: Fresh session

- **GIVEN** a session whose last GitHub authorisation was ten minutes ago
- **WHEN** the person submits a review that approves the pull request
- **THEN** the review is posted

#### Scenario: Comments are not covered

- **GIVEN** a session whose last GitHub authorisation was two hours ago
- **WHEN** the person posts a comment
- **THEN** the comment is posted

## MODIFIED Requirements

### Requirement: Session expiry

The system SHALL end a session after 7 days, and SHALL end it at once when the person signs out.

#### Scenario: Sign out

- **WHEN** a signed-in person chooses "Sign out"
- **THEN** the session stops working immediately, even if its cookie was copied elsewhere

#### Scenario: Seven days

- **GIVEN** a session that is 7 days old
- **WHEN** the person opens Rico
- **THEN** they are asked to sign in again
