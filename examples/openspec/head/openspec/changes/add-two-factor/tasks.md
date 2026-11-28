## 1. Fresh sign-in

- [ ] 1.1 Record when the person last authorised with GitHub, in the session
- [ ] 1.2 Add a "fresh" check (under one hour) to the approve and request-changes routes
- [ ] 1.3 Return a clear refusal that tells the page to send the person back through GitHub
- [ ] 1.4 Test: an old session is refused, a fresh one is accepted, a comment is never refused

## 2. The page

- [ ] 2.1 In the review dialog, turn "Submit" into "Sign in again to submit" when the refusal comes back
- [ ] 2.2 Return to the dialog after the sign-in, with the verdict still chosen
- [ ] 2.3 Check that the summary and the pending comments survive the round trip
- [ ] 2.4 Browser test: approve from an old session, sign in again, and see the review posted

## 3. Sessions and the audit trail

- [ ] 3.1 Shorten the session lifetime from 30 days to 7
- [ ] 3.2 Write an audit entry for every approval and request for changes
- [ ] 3.3 Show the trail in the account menu, newest first
- [ ] 3.4 Note the sign-out of existing sessions in the release note
