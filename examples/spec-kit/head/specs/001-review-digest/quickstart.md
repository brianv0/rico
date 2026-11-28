# Quickstart: Review digest

1. Start Rico with a token that can read your pull requests: `GITHUB_TOKEN=… npm start`.
2. Open any pull request you have commented on.
3. In the toolbar, open **Needs you**: it lists the threads waiting on you across your open pull requests (FR-001), grouped by pull request (FR-002).
4. Click a thread: Rico opens that pull request at the thread.
5. Exclude a repository from the list's menu, reload, and check it is still excluded (FR-004).

To check the contract by hand: `curl -H "X-Rico: 1" http://localhost:4317/api/digest` returns `{"items": [...]}` (see `contracts/digest-api.yaml`).
