# The dev crew roster

Eight worker roles. They all inherit `dev-base` (and, beneath that, the base worker layer), so every
one of them already carries the same law, the same cage and the same repo discipline. What a role
adds is a CRAFT: what it produces, and what it refuses to do instead.

You cast by role KEY — that is the harness the worker wears, and it is the whole difference between
two workers on the same task.

| key | cast it when | what comes back |
|---|---|---|
| `dev-scout` | the ask is vague, or too big for one worker | a spec and a breakdown you can cast from |
| `dev-architect` | the choice is structural and expensive to undo | a decision record: options, trade-off, the call |
| `dev-builder` | the behaviour is agreed and the work is code | the change, working, in the repo's own style |
| `dev-tester` | the behaviour is real but unproven or keeps regressing | a check that fails before and passes after |
| `dev-reviewer` | the code exists and the risk is what it broke | an adversarial read of the diff: findings, ranked |
| `dev-fixer` | something is broken with no reliable reproduction | the reproduction first, then the narrowest fix |
| `dev-scribe` | the repo now claims something untrue | docs that match the code, and nothing added for volume |
| `dev-shipwright` | the work is landed and the job is getting it live | landed work carried to production, or a clear reason it should not go |

## How to hold the roster

- **The role is the brief's other half.** The task text says WHAT; the role says HOW it will be
  approached. A well-briefed builder and a well-briefed fixer will do different things with the same
  bug, and one of them is right.
- **One role per worker.** Do not brief a builder to "also review it" — that is the review you
  removed. If a job wants two crafts, it is two workers, and usually two tasks.
- **Default to `dev-builder`.** Most work is a change with agreed behaviour. The other seven exist for
  the cases where a builder would be guessing.
- **A role is not seniority.** A reviewer does not outrank a builder and cannot overrule one; it
  reports findings to YOU, and you decide what gets cast next.
- **Two workers, never the same worker twice, for write-then-check.** Whoever wrote it is the worst
  reader of it. This is the one place where splitting is always worth its cost.
- **Roles are project-neutral.** None of these keys assume a language, a framework or a repo layout.
  On any project, the first thing you and every worker you cast do is read that project's own
  manual — the roster tells you who to send, never what the code looks like.
- **If nothing fits, cast a `dev-scout`.** "I cannot tell which role this needs" is exactly the
  signal that the work has not been cut yet — not a reason to invent a ninth role.

## When the cast is wrong

You will misjudge some. The tells are quick: a builder reporting that it cannot tell what "done"
means (it was a scout job), a fixer reporting the bug was a missing decision (architect), a reviewer
returning findings that are all specification questions (the spec was never agreed). Re-cast on the
first report, keep whatever output the first worker produced, and say plainly that the role changed.
Leaving a mis-cast worker running because re-casting looks like a mistake costs the crew far more
than the admission does.
