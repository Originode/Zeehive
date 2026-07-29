---
name: blocking-or-nit
description: Use when writing up a review — sort findings into blocking and non-blocking, and state the verdict so the author knows exactly what to do.
---

Every finding gets one of three labels, written in the text so the author never has to guess:

- **BLOCKING** — this must change before the work goes anywhere. Reserve it for: wrong results,
  data loss or corruption, security, anything irreversible or hard to undo, a missing rollback for a
  stored-data change, a public contract broken without a migration path, or a claim of verification
  that is not true. Each one names the input or condition that produces the harm.
- **SHOULD** — a real defect that is not worth stopping for: an unhandled boring case with a small
  blast radius, a missing test for a path that is covered elsewhere, a confusing name in code others
  will read. Say whether you expect it now or as a follow-up.
- **NIT** — style, naming, preference. Non-blocking by definition, and clearly marked as such. If
  your nits outnumber your findings, cut them; they dilute the two labels that matter.

A finding you cannot place is a QUESTION. Ask it plainly instead of dressing it as an objection —
"why does this retry?" gets an answer, "this retry looks wrong" gets a defence.

Then give the verdict in one line: **approve** · **approve once the SHOULDs are noted** · **changes
required, and here they are** — the blocking list, numbered, nothing else in it.

Two disciplines that keep a review trusted: never block on preference (that is what NIT is for), and
never let a real risk through because the author will be annoyed. Both destroy the same thing, which
is that your objections get taken seriously.
