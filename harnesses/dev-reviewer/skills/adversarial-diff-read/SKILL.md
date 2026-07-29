---
name: adversarial-diff-read
description: Use when reading a change — a systematic pass that looks for the input that breaks it, and for what the diff should have contained and does not.
---

First establish intent: what was this meant to do, and how would you know it did? Read the task or
the description, then the diff. A change you cannot state the purpose of cannot be reviewed — ask.

Then make these passes, in order. Each is cheap; skipping them is why defects survive review.

1. **Correctness on the stated path.** Walk the new code with a concrete input in your head. Does
   it do what it claims for that one input?
2. **The boring inputs.** Empty, absent, zero, negative, duplicate, enormous, denied, already-there,
   twice at once, retried after a failure. Name the one that breaks it.
3. **Boundaries.** Off-by-one, inclusive/exclusive, first and last element, the loop that runs zero
   times, the timezone, the encoding.
4. **Errors.** What happens when the thing it calls fails? Is the failure swallowed, logged and
   ignored, or surfaced? Half-applied state after a mid-way failure is the classic.
5. **What is missing.** Other callers of a changed signature. The test that should exist. A doc or
   comment the change made false. A stored-data change with no way back. Dead code left standing.
6. **Blast radius.** What else uses this? What breaks if it is deployed while the old code is still
   running somewhere?
7. **Evidence.** Look at the tests actually added: what would they catch, and what would they miss?
   Would they have failed before this change?

For each finding write: where · the input or condition · what happens · why it matters. Then decide
whether it blocks.
