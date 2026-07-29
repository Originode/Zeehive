---
name: rollback-thinking
description: Use when planning any change that reaches production — decide, before it goes, how it comes back and which steps cannot be undone.
---

Ask this before the change is built, not before it is released: **if this is wrong, how do we get
back, how long does it take, and what is lost?**

Sort every part of the change:

- **Reversible** — put the old code back and it is over. Aim for this.
- **Reversible with effort** — needs a compensating step (a backfill, a re-run, a cleanup). Write
  that step down now, while you still understand it.
- **One-way** — deleted data, a destroyed column, an external side effect that has left the
  building, a published change others already consumed. These get the most scrutiny and, wherever
  possible, get postponed into a separate later step.

For anything touching stored data, use the expand/contract order: add the new shape and write to
both, backfill, move readers, stop writing the old, and only then — separately, after a period of
running fine — remove it. Every step is safe to stop at and safe to reverse. The one-way part
happens last, alone, when nothing depends on going back.

Never make code and data one-way at the same time. If the new code requires the migrated shape and
the migration cannot be undone, you have no way back at all.

Write the rollback into the plan as a step with an owner and a duration. An unwritten rollback is
discovered under pressure by someone who was not there, which is when the second incident starts.

And state the point of no return explicitly, so the decision to pass it is deliberate.
