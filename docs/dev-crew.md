# The dev crew

> Added 2026-07-29 (migration 073). Eight role-specialised worker personas plus one shared craft
> layer, dispatchable on **any** project.

Before this, a worker zee wore either `zee-base` — the cxell manual and nothing else — or a persona
written for one particular repository. Both leave the same hole: the zee knows how to talk to the
queenzee and nothing about how to do the KIND of work it was handed. A spec, a fix and a release are
different jobs with different failure modes, and briefing all three identically is why a "just fix
it" turn ends in a refactor nobody asked for.

The dev crew fills that hole with **craft, not lore**. Nothing in it names a path, a container, a
script or a schema, so the same eight personas are dispatchable on any repository the fleet manages.

## The hierarchy

```
zee-base            DB-owned. Carries the cxell-zee manual — the law: verbs, gates, refusals.
  └── dev-base      The shared craft layer: the loop, what counts as evidence, when to raise a
      │             human, how to report. Written ONCE, inherited by all eight.
      ├── dev-scout        Scout       vague ask → written spec + task breakdown, before code
      ├── dev-architect    Architect   structure, interfaces, data shape, migration + decision record
      ├── dev-builder      Builder     smallest correct change, in the repo's existing patterns
      ├── dev-tester       Test Wright failing test first, then the real thing exercised
      ├── dev-reviewer     Reviewer    reads a diff adversarially; blocking vs nit; adds no features
      ├── dev-fixer        Fixer       reproduces before it fixes; minimal fix + regression test
      ├── dev-scribe       Scribe      keeps agent-facing docs TRUE; deletes stale text
      └── dev-shipwright   Shipwright  landed work → production; rollback thinking; honest reasons
```

All nine are `zee_type: worker` — they land code, which a manager never does — and all nine live
**in the meta-DB**: the `harness` row carries the personality, the skills and (for `dev-base`) the
memory, and `parent_id` carries the chain. Migration 073 inserted the rows and **080** imported the
text and resolved the parents in SQL.

That reverses what this doc originally said ("the folder is the truth"), and the reason is in §080:
while a folder projected into the row there were two sources, the deployed image carried no
`harnesses/` at all, and every file-backed harness in production was EMPTY — a whole fleet of zees
briefed with nothing, and every other project's console showing the crew as "⚠ no files". One source,
and the queenzee generates the files it injects. (082 did the same for the badge SVG; there is no
`harnesses/` folder any more.)

The manual reaches every role **once, by inheritance** from `zee-base`. No role carries a copy of it
or paraphrases a CLI verb — a restated verb is drift the moment the CLI moves
(house rule 8), and a pasted manual is a second, staler copy of the wearer's own law.

## Why the roles map onto the AI-native SDLC

The split is not eight flavours of "developer". It is the spec-driven loop the industry converged on
once agents started doing the typing, with one persona per stage — because each stage's discipline is
what an unspecialised agent skips:

| stage | role | the discipline it enforces |
|---|---|---|
| **specify** | Scout | write the spec before the code; say what is OUT |
| **plan** | Architect | interfaces and data shape decided up front, with rejected alternatives recorded |
| **tasks** | Scout | slices that are each buildable, verifiable and landable alone |
| **implement** | Builder | smallest correct change, existing patterns, commits that each work |
| **test-as-spec** | Test Wright | the failing test first — then the real thing, not just a green suite |
| **critic pass** | Reviewer | read the diff assuming it is wrong; separate blocking from nit |
| **debug** | Fixer | reproduce before you fix; leave the regression test |
| **docs-as-context** | Scribe | docs are read and believed by agents, so stale text is a defect |
| **release** | Shipwright | migration/rollback thinking, verified builds, honest ship reasons |

## The budgets, and why they are enforced

`effectiveHarness()` merges the chain root → leaf and `harnessLayerText()` **inlines** the
personality, every skill body and every memory file into the briefing. A harness is therefore not a
reference the zee may consult — it is tokens spent on every dispatch, before the zee has read a line
of the actual repo. A fat harness makes its wearer worse: it crowds out the code.

So the shape is structural, and `test/dev-crew.test.mjs` fails the build if it slips:

| | dev-base | each role |
|---|---|---|
| `personality` | ≤ 30 lines | ≤ 40 lines |
| `memory` entries | exactly 1 (`memory/dev-loop.md`, ≤ 180 lines) | **none** |
| `skills` | 1 (`orient-in-a-new-repo`) | 1–2, each body ≤ 30 lines |
| own briefing text | ≤ 16 000 chars | ≤ 8 000 chars |

"Own" means what that row contributes on top of its parents. These are CEILINGS — the constants at
the top of `test/dev-crew.test.mjs` are the enforced ones, and it prints what each harness actually
measures on every run. Read them there rather than from a number written here: a count in this doc is
true on the day it is pasted and silently wrong after the next edit, while the ceiling is checked.

The one-memory-file rule for `dev-base` and the **zero** for the roles are the load-bearing ones. A
paragraph written into all eight roles is paid for by every wearer and duplicated eight times in the
repo, and the eight copies then diverge. If two roles need the same sentence, it belongs in
`dev-base` — that is what `dev-base` is for.

## Adding a role

A role is a row now, so it is added by **migration** (and may then be edited in the console's harness
manager). There is no folder to create.

1. A migration that INSERTs the row (`key, label, zee_type, enabled`) with
   `ON CONFLICT (key) DO NOTHING`, sets `parent_id` from `dev-base`, and writes the bundle:
   `glyph`, a one-or-two-line `summary`, the `personality`, and one or two `skills`
   (`{name, when, body}`). **Do** set `parent_id` — nothing resolves a chain from a file any more, so
   a role inserted without one inherits nothing and its wearer gets no manual.
2. The **personality** is who this role is and what it refuses to do. Judgement only: anything true
   of every developer is already in `dev-base` and must not be repeated.
3. **Memory** goes through `harness_memory_put(harness_key, path, text)` — never hand-rolled jsonb
   (house rule 9, `test/harness-memory-migrations.test.mjs`). A role should carry none.
4. Run the migration on your own database, then run `test/dev-crew.test.mjs`. **There is no list to
   add it to**: the test derives the crew from the rows — anything whose parent chain reaches
   `dev-base` is checked the moment the row exists, and it prints the roster it derived. Set the
   `parent_id` (step 1) and the new role is linted; forget it and it is not crew at all, which is
   the loud failure that tells you.
5. Add the role to `dev-lead`'s `memory/dev-role-roster.md` in the same migration. The test asserts
   the two agree in both directions — a role the lead has never heard of cannot be cast, and one the
   lead names that does not exist fails at spawn.

Two rules for the writing itself, both checked by the test: **no CLI verbs or flags** (refer to the
manual, never quote it) and **no project lore** (no repo paths, container names or scripts — these
personas work on other people's codebases). Both are checked on every field of the bundle that
reaches a wearer, `label` and `summary` included — those two show up in every picker, and while the
lint read files instead they were the one place lore could be written and never flagged.

## Using them

Assign a harness to a xell the same way as any other (the console's harness picker, `--harness` on
dispatch, or a project's default in the pool config). A manager zee briefing a crew should name the
role in the dispatch as well as the task: the persona decides *how* the worker works, the task text
decides *what* it works on.
