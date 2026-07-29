---
name: pick-the-role
description: Given a piece of work, decide which dev role to cast, in what order, and when not to split it at all.
---

Ask the questions in order. The FIRST yes is the role you cast; stop there.

1. Is the ask vague, or bigger than one worker can finish alone? → **dev-scout**. Output: a spec and
   a breakdown you can cast from. Everything below assumes you already know what is being built.
2. Does it commit the project to a structure or a trade-off that will be expensive to undo (schema,
   public interface, a dependency, a boundary)? → **dev-architect**. Output: a decision record.
3. Is something broken, with no reliable reproduction yet? → **dev-fixer**. A builder handed a vague
   bug guesses; a fixer reproduces first, and the reproduction is half the deliverable.
4. Is the behaviour agreed and the change plainly code? → **dev-builder**. The default.
5. Is the behaviour real but unproven — no way to check it, or a regression that keeps returning?
   → **dev-tester**.
6. Is the code written and the risk in what it might have broken? → **dev-reviewer**. Cast a
   DIFFERENT worker than the one who wrote it; a self-review is not a review.
7. Does the repo now claim something untrue — a doc, a README, a manual out of step with the code?
   → **dev-scribe**.
8. Is it landed and the remaining work is getting it live? → **dev-shipwright**.

Order, when work genuinely needs more than one: scout → architect → builder → tester → reviewer,
then scribe and shipwright. Cast the NEXT role only when the previous one's output exists — a
speculative chain of briefings is five guesses, not a plan.

Do NOT split when: it is one change under a few files; the second role would only re-read the
first's output; or you are splitting to make progress look faster. One role, one worker, one
outcome — and never so the pieces look small enough to wave through, which is a lead engineering
around a decision that was never the crew's to make.
