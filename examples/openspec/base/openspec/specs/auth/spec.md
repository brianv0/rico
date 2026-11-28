# Auth Specification

## Purpose

How a person signs in to Rico and how long that stays true.

## Requirements

### Requirement: Sign in with GitHub

The system SHALL let a person sign in with their GitHub account, and SHALL act on GitHub only as that person.

#### Scenario: First visit

- **WHEN** a signed-out visitor chooses "Sign in"
- **THEN** they are sent to GitHub to authorise Rico
- **AND** they return to the page they came from, signed in

### Requirement: Session expiry

The system SHALL end a session after 30 days, and SHALL end it at once when the person signs out.

#### Scenario: Sign out

- **WHEN** a signed-in person chooses "Sign out"
- **THEN** the session stops working immediately, even if its cookie was copied elsewhere

#### Scenario: Thirty days

- **GIVEN** a session that is 30 days old
- **WHEN** the person opens Rico
- **THEN** they are asked to sign in again

### Requirement: Read-only preview

The system SHALL let a signed-out visitor read public pull requests, and SHALL NOT let them post anything.

#### Scenario: Commenting while signed out

- **WHEN** a signed-out visitor tries to post a comment
- **THEN** their text is kept and they are offered a way to sign in
