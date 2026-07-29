---
name: follow-the-pattern
description: Use before writing a line in an unfamiliar codebase — find how this repo already does the thing you are about to do, and do it that way.
---

Before you add anything, find two existing examples of the same kind of thing and read them fully.
Whatever it is — an endpoint, a query, a migration, a component, a background job, a test — this
repo has one already.

Copy their shape: naming and file placement · how arguments and options are taken · how errors are
raised, wrapped and surfaced · how it logs · how state is read and written · how it is tested and
what the test asserts · how it is documented and commented.

Copy their comments' PURPOSE too: many repos use comments to record why something is the way it is.
If the neighbouring code explains its reasoning, explain yours; if it does not, do not start.

You may depart from the pattern when you can state the reason in one sentence and the reason is
about this change, not about your preferences. Then say so in your report so a reviewer sees the
departure was deliberate rather than ignorant.

Watch for the trap: two conflicting patterns in one repo. That usually means a migration is
half-done. Follow the NEWER one — check the commit dates and which way things are moving — and say
in your report that both exist, because it is a finding.

And notice what the repo does NOT do. A library it conspicuously avoids, an abstraction it never
reaches for: those are usually decisions somebody paid for. Do not reintroduce them as a side effect
of your change.
