## Why

Rico acts on GitHub as the person who signed in, with write access to their pull requests. A stolen session cookie is therefore as good as the person's account for as long as it lives. GitHub already supports a second factor; Rico can ask for proof that the person who signed in is still the one at the keyboard before it does anything that cannot be undone.

## What Changes

- Posting a review that approves or requests changes asks for a fresh GitHub sign-in if the session is older than one hour.
- Sessions are shortened from 30 days to 7.
- Every approval and request for changes is written to an audit trail the person can read.

## Capabilities

### New Capabilities

- `audit`: a readable trail of the irreversible things done in a person's name.

### Modified Capabilities

- `auth`: a fresh sign-in for irreversible actions, and a shorter session.

## Impact

- The review dialog gains one extra step for approvals and change requests that are made from an older session.
- Existing sessions older than 7 days end on the day this ships.
- No new dependency. The audit trail is stored per person, in the same place as the session.
