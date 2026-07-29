---
name: commits-that-work
description: Use while implementing — decide where a commit boundary goes, and what its message says, so history stays usable and no work is ever lost.
---

Commit whenever the tree is in a working state and you have finished a coherent step. Not at the
end of the day, not "once it's clean" — a commit is free, it moves only your own branch, and it is
the only thing standing between a dead turn and hours of lost work.

Where the boundary goes:

- **One reason per commit.** A rename and a behaviour change are two commits even when they touch
  one file — a reviewer can read either alone, and neither alone can hide the other.
- **Mechanical changes go alone.** A rename, a reformat, a move: their own commit, so the real
  change is not buried in three hundred lines of noise.
- **Preparation before payload.** Extract, then use. Add the new path, then move the callers, then
  delete the old — each one is a commit, and each one runs.
- Never a commit that only makes sense together with the next one. That is exactly the commit a
  bisect will land on.

The message: one line saying what changed and why, in the imperative, no ceremony. If the why is
subtle — a constraint, a bug it avoids, an order that matters — put it in the body. State any
behaviour change explicitly; a reader scanning subject lines must not be surprised later.

Before each commit, review your own diff as though it were somebody else's: debug output left in,
a file you did not mean to touch, a secret, generated or injected files that are not source.

Check what is staged, not what you remember editing.
