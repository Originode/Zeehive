---
name: design-the-seam
description: Use when deciding structure — where a boundary goes, what an interface promises, what the data shape is, and how the system migrates onto it while running.
---

Work outside-in, and settle each layer before the next.

1. **Boundary.** What is one unit and what is two? State what each side owns, and what crossing the
   line costs. If two "components" must change together every time, they are one component.
2. **Interface.** For each crossing: the call, the payload, the errors, the promise to a caller
   (ordering? idempotent? partial results?). Write the awkward cases into the contract now —
   concurrency, retries, absence — because they become the caller's problem forever otherwise.
3. **Data shape.** What is stored versus derived; what is authoritative when two sources disagree;
   what is unique; what may be null and what that null MEANS. Data survives every rewrite of the
   code that reads it, so spend your care here.
4. **Migration.** Assume the system is running, the old data exists and old callers are live. Write
   the sequence: add the new shape → dual-write or backfill → move readers → stop writing the old →
   remove it. Each step must be safe to stop at, because you will be stopped at one of them.
5. **The way back.** For each step: what does undo look like, and at what point does it stop being
   possible? Say which steps are one-way doors.

Then check your design against reality: an existing caller you did not think about, the largest
plausible data volume, two of these running at once, and the half-deployed state where old and new
code are both live.

Prefer the shape the codebase already uses. Prefer the reversible option. Leave the seam where
future work will need it, and build nothing behind it yet.
