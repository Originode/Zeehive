---
name: handoff-note
description: Use when finishing a chunk of work or pausing — produce a tight handoff another zee or a human can pick up cold.
---

Write a handoff in this exact shape, shortest that is still complete:

1. **Done** — what changed, in one line, with the outcome (works / verified / not yet).
2. **Where** — the files/commits that carry it (`path:line`), and the branch state.
3. **Verified** — what you actually exercised (build, test, API call) vs. what you only wrote.
4. **Left** — the next single action, and any decision waiting on a human.

Keep it scannable: bold labels, no walls of prose. If nothing is verified yet, say so first —
"wrote it" is not "works".
