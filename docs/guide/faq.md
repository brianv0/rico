# FAQ

Answers to the questions people ask first.

## Does Rico store my comments?

Only in your browser. Queued comments live in `localStorage` until you submit them, and then
they exist only as a GitHub review. Clear site data and the queue is gone.

## Why can't I comment on some paragraphs?

GitHub only accepts review comments on lines that appear in the pull request's diff. Paragraphs
outside the diff are shown with a grey bar. A comment on one of them is not lost: it is added to
the review summary together with a quote of what you selected.

![The review flow](../img/flow.png)

## What happens when my selection crosses two hunks?

A multi-line comment has to stay inside one hunk. Rico clamps your selection to the hunk it
overlaps most, tells you which lines it anchored to, and includes the full quote in the comment
so nothing is lost.

## Which markdown is supported?

| Feature | Supported |
|---------|-----------|
| Headings, paragraphs, emphasis | Yes |
| Lists, nested lists, task lists | Yes |
| Tables | Yes |
| Fenced and indented code | Yes |
| Images (relative paths) | Yes, served from the head commit |
| Raw HTML | No, it is not rendered |
| Front matter | Shown as text |

## Can I use it with GitHub Enterprise?

Set `GITHUB_API_URL` to your server's API root. For example:

```bash
export GITHUB_API_URL=https://ghe.example.com/api/v3
npm start
```

## Which keys do what?

- `Ctrl`/`Cmd` + `Enter` adds the comment
- `Esc` dismisses the comment box
- `Shift` + arrow keys extends a selection from the keyboard
