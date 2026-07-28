---
name: dispatch-brief
description: Write the task text for a worker zee you are about to dispatch — scope, constraints, definition of done, and the verification the worker must do in its own xell.
---

A dispatched worker gets ONE briefing and then works alone in a sealed cxell. Everything it needs to
decide correctly has to be in the text you hand it. Use this shape:

1. **Goal** — one sentence, in the product's language. What is different afterwards?
2. **Where** — the files/subsystems you already know are involved. Name them; do not make the worker
   rediscover what you already know. Say "read the manual first" only if the repo has one.
3. **Constraints** — what must NOT change (schemas, public APIs, existing behaviour), and any
   decision you have already made for them so they do not re-litigate it.
4. **Definition of done** — the checkable end state. "The console shows X when Y" beats "improve X".
5. **Verification IN THE XELL** — name the thing they must exercise: `zee build --wait` then hit the
   endpoint/screen. A worker that says "I cannot verify this here" was briefed badly.
6. **Landing** — remind them the work is theirs to land (`zee land`, a human approves). You cannot
   land it for them and must not imply you can.

Rules for what you may ask for:

- Never ask a worker to reach outside its own xell. No touching the xource, no other xell's
  containers or database, no prod, no docker, no `origin`, no editing gate/hook/firewall code to
  "make it easier". A worker's only doors out are its queenzee verbs and messaging you.
- Never split one job into pieces whose only purpose is to slip past a gate (two half-landings to
  dodge a review, a "temporary" prod write, a seed that carries code).
- If a task genuinely needs prod data or a bypass, that is a HUMAN's decision — raise it with
  `zee tend`, do not engineer around it.

Keep the brief under ~30 lines. If it needs more than that, it is more than one task.
