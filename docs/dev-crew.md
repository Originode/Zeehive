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

All nine are `zee_type: worker` — they land code, which a manager never does — and all nine are
**file-backed** (`harnesses/<key>/`). The parent links are declared in each `HARNESS.yml`
(`parent:`) and resolved by `refreshHarnesses()` at boot; migration 073 only inserts the rows. That
is deliberate: the folder is the truth, and a hierarchy half in SQL and half in files drifts.

The manual reaches every role **once, by inheritance** from `zee-base`. No file in this subtree
carries a copy of it or paraphrases a CLI verb — a restated verb is drift the moment the CLI moves
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
| PERSONALITY.md | ≤ 30 lines | ≤ 40 lines |
| memory files | exactly 1 (`memory/dev-loop.md`, ≤ 180 lines) | **none** |
| skills | 1 (`orient-in-a-new-repo`) | 1–2, each body ≤ 30 lines |
| own briefing text | ≤ 16 000 chars | ≤ 8 000 chars |

"Own" means what that row contributes on top of its parents. Today the roles sit at ~3.7k–5.4k chars
each, on a ~10.5k `dev-base` and a ~33k `zee-base`.

The one-memory-file rule for `dev-base` and the **zero** for the roles are the load-bearing ones. A
paragraph written into all eight roles is paid for by every wearer and duplicated eight times in the
repo, and the eight copies then diverge. If two roles need the same sentence, it belongs in
`dev-base` — that is what `dev-base` is for.

## Adding a role

1. `harnesses/dev-<role>/HARNESS.yml` — `label`, a one-or-two-line `summary`, a distinct `glyph`,
   `zee_type: worker`, `parent: dev-base`, and the skill names.
2. `PERSONALITY.md` — who this role is and what it refuses to do. Judgement only: anything true of
   every developer is already in `dev-base` and must not be repeated.
3. `skills/<name>/SKILL.md` — at most two, with YAML frontmatter (`name`, `description` = *when to
   use it*). A skill is a procedure the wearer follows, not an essay.
4. A migration that INSERTs the row (`key, label, dir, zee_type, enabled`) with
   `ON CONFLICT (key) DO NOTHING`. Never write `parent_id` in SQL and never touch `harness.bundle` —
   see `test/harness-memory-migrations.test.mjs`.
5. Add it to `ROLES` in `test/dev-crew.test.mjs`, run that test, and run the migration on your own
   database so `refreshHarnesses()` actually proves the folder parses.

Two rules for the writing itself, both checked by the test: **no CLI verbs or flags** (refer to the
manual, never quote it) and **no project lore** (no repo paths, container names or scripts — these
personas work on other people's codebases).

## Using them

Assign a harness to a xell the same way as any other (the console's harness picker, `--harness` on
dispatch, or a project's default in the pool config). A manager zee briefing a crew should name the
role in the dispatch as well as the task: the persona decides *how* the worker works, the task text
decides *what* it works on.
