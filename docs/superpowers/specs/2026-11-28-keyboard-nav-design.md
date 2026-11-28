# Keyboard navigation between threads: Design

**Date:** 2026-11-28
**Status:** Draft, for review

## Intent

Reviewers who live on the keyboard have to reach for the mouse to get from one thread to the next. On a long document with twenty threads that is most of the review. The point of this feature is that a whole review can be done without touching the mouse.

## Goals

- `j` and `k` move to the next and previous thread, scrolling it into view and focusing its Reply button.
- `?` shows the shortcuts.
- Shortcuts never fire while the reviewer is typing.

## Non-goals

- Remappable keys.
- Moving between files (the file tree already does that).

## Anti-goals

- Do not take over keys the browser uses. Plain letters only, never with Ctrl, Alt or Meta.

## Constraints

- No new runtime dependencies.
- It must keep working with the "Needs you" list, which already uses `]` and `[`.

## Approaches

### A. Single keys when nothing is being edited (chosen)

One `keydown` listener on the document, ignoring events from inputs, textareas and menus.

Why: it is the smallest thing that works, and it matches what reviewers already know from GitHub.

### B. A modal, vim-style mode

Press a key to enter navigation mode, another to leave it.

Why not: a mode is one more thing to see and to get wrong, for twenty threads.

### C. Chords only (`g` then `n`)

Why not: two keystrokes for the most common action.

## The decision

Approach A. The listener lives with the other keyboard handlers and reuses the focus helper the "Needs you" list uses, so both behave the same.

## Left to the builder

- Whether `j` and `k` wrap around at the ends.
- Where the focus ring goes when a thread has no Reply button (a locked conversation).
