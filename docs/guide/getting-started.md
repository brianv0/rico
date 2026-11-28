# Getting started

Rico shows a GitHub pull request's markdown the way it will be read, and lets you comment on any selection of it, even
across several paragraphs. Comments are posted to GitHub as you, so they also appear on github.com.

## Use the hosted app

1. **Open [ricorico.dev](https://ricorico.dev).** You can read any public pull request straight away ("Preview ·
   read-only"). Paste a link such as `https://github.com/owner/repo/pull/123` or `owner/repo#123`; a commit link or a
   branch link works too (a branch opens as its latest commit). The address bar always names what you are looking at,
   so you can share it.
2. **Sign in with GitHub** to comment. Rico asks only for GitHub's `public_repo` permission: it can comment on public
   repositories and cannot see your private ones.
3. **Select text.** A small pill appears; **Comment** posts at once, **Start a review** keeps the comment pending on
   GitHub until you finish the review. The pill's second icon **suggests an edit** as a GitHub suggestion.
4. **Finish.** *Review changes* (top right of the toolbar) lets you submit the pending comments as Comment, Approve or
   Request changes.

Replies, edits, deleting, resolving and emoji reactions work from the margin beside the text.

### Private repositories

GitHub has no narrower permission for commenting on private repositories than its classic `repo` scope, which also
allows writing code there. So Rico asks for it only when you choose: open your avatar menu and pick **Allow private
repositories**, or follow the link Rico shows when a pull request cannot be found. Rico uses the permission only to load
the pull request and post your comments. If your organisation restricts third-party OAuth apps, an organisation owner
may need to approve Rico first (GitHub shows a *Request* button during sign-in).

To go back to public-only access, remove Rico under **GitHub › Settings › Applications › Authorized OAuth Apps**, then
sign in again. **Sign out** in the avatar menu deletes your session and revokes the token at GitHub.

### What Rico stores

Your token (encrypted, in a cookie and as ciphertext in Cloudflare KV), a count of which GitHub accounts use Rico, and
error reports from the browser. Comments and pull request contents are not stored: they live on GitHub. See
[Privacy](https://ricorico.dev/privacy) and [Terms](https://ricorico.dev/terms).

## Run it yourself

Rico also runs on your own machine, with your own token and no sign-in:

```bash
git clone https://github.com/brianv0/rico && cd rico
export GITHUB_TOKEN=...      # or just be logged in with `gh auth login`
npm install
npm start                    # http://localhost:4317
```

Use a token that can read the repositories you want to review, and `repo` (or `public_repo`) scope to comment. The token
stays on your machine and never reaches the browser. Run it as a hosted app on your own Cloudflare account with the
steps in the README's *Deploy to Cloudflare* section.

## If something is wrong

- **"Not found" on a pull request that exists:** it is probably private. Allow private repositories (above).
- **Comments say "Not posted":** GitHub refused them (a locked conversation, an archived repository, or a line that is no
  longer in the diff). The card shows GitHub's reason, with **Try again** and **Discard**.
- **ricorico.dev will not open at work:** some company web filters block very new domains for the first weeks. Ask
  your IT team to allow `ricorico.dev`, or to recategorise it.
- **Anything else:** [open an issue](https://github.com/brianv0/rico/issues).
