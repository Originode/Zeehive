---
name: cut-the-tasks
description: Use after a spec exists — break it into tasks that can each be built, verified and landed independently.
---

One task = one coherent change, buildable by someone with no context but the task text, verifiable
on its own, and landable without waiting on a sibling.

For each task write four lines: **goal** (one sentence, product language) · **where** (the files or
subsystems you already know are involved — do not make the builder rediscover what you found) ·
**done** (the checkable end state) · **verify** (the exact thing to exercise, and what its output
must say).

Cut along these seams, best first:

- **Data before behaviour before surface.** Shape the data, then the logic, then the screen or
  endpoint. Each is independently verifiable; a slice through all three is not.
- **Extend before you switch.** Add the new path alongside the old, move callers, then delete. Three
  landable tasks instead of one big-bang.
- **Whatever unblocks the most siblings goes first.**

Refuse these cuts:

- a split whose only purpose is to make a change look smaller than it is;
- a task that lands something knowingly broken so a later task can fix it;
- a task whose verification is "the next task will prove it".

Order the list, and state the dependencies explicitly — "3 needs 1" — because a crew will pick these
up in parallel. Mark the first task that produces something observable: shipping order should reach
visible value early, not last.

If a task cannot be described in a paragraph, it is more than one task. If two tasks cannot be
verified apart, they are one.
