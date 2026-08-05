# The harness training crew — trainer, teacher, master

> Added 2026-08-04 (migration 138). Two worker personas and one manager persona whose subject is
> the fleet's HARNESS ESTATE itself: the tree of personas in the `harness` table that every
> briefing is generated from.

```
zee-base                 the base worker layer (the cxell manual)
  └── trainer            worker   improves EXISTING harnesses — evidence-driven, surgical,
      │                           guarded migrations to harness text. Never mints.
      └── teacher        worker   everything trainer is, PLUS minting NEW harnesses:
                                  key/type/parent decided at birth, delta-only text,
                                  companion test, roster update.

manager                  the manager layer (the manager manual, dispatch, ops, tickets)
  └── master             manager  evaluates work items, reflections and the estate itself;
                                  casts trainers/teachers; edits no harness text.
```

All three are DB-owned rows (house rule 10): migration 138 is their source, the console is the
other legitimate editor, and there is no folder to project over them. `test/harness-training-crew.test.mjs`
is the companion test: rows, chains, single inherited manuals, budgets, and the type guards.

## Why this exists

Harness text is inlined into every briefing every wearer receives, and nothing crashes when it
rots. Until now it was improved by whoever happened to be handed a manual-patch task, and new
personas were minted ad hoc by migration with no persona owning the judgement. The crew gives the
estate an owner: the **master** finds and prioritises the defects, the **trainer** fixes text, the
**teacher** (rarely) adds a persona — and each hand-off crosses the same human gates as any other
work, because a harness change is a landed migration like any other change to what a zee is told.

## Decision record (2026-08-04)

**Decision.** `trainer` and `teacher` are worker harnesses chained `zee-base → trainer → teacher`;
`master` is a manager harness parented on `manager` that carries a roster memory naming the two
worker keys. All three are system-wide (project_id NULL), seeded by one guarded migration.

**Context.** The task's sketch was "master inherits teacher and is also a manager". Migration
054's `harness_type_guard` refuses cross-type inheritance — a harness may only inherit within its
own type (or from the law layer) — and it refuses it for the exact failure this crew exists to
prevent: a manager parented on a worker chain would have the worker manual merged into its
briefing, teaching it landing, the one verb the landgate structurally refuses a manager sha.

**Options considered, and why the rejected ones were rejected.**

1. **Master literally inherits teacher** (the sketch). Requires either weakening
   `harness_type_guard` — which re-opens the misbriefing bug class 054 was built to close, for
   every future harness, to satisfy one — or retyping the chain. Rejected: the guard is load-bearing
   and the cost is fleet-wide; the sketch's intent (master knows the crew and can deploy it) is met
   by the roster memory instead, which is exactly the trade `dev-lead` (074) already made and has a
   test defending.
2. **Type the whole chain `any` so inheritance crosses the wall.** `any` is the law layer's type.
   Structurally impossible anyway: an `any` harness cannot inherit the worker-typed `zee-base`, so
   trainer would lose the cxell manual — a worker briefed with no law. And an `any` trainer could be
   worn by a manager, whose sha cannot land the migrations the trainer manual instructs it to write.
3. **A new `zee_type` for trainers/masters.** Types exist for REFUSALS (052/054), and this crew
   needs no new refusal: trainers land through the worker gates, master dispatches through the
   manager ones. A new type re-derives both walls for nothing — 120 (`queenzee-minister`) recorded
   the same rejection for the same reason.
4. **Parent trainer on `dev-base`** (make it a ninth dev role). `test/dev-crew.test.mjs` derives
   crew membership structurally (any chain reaching `dev-base`) and holds that subtree to
   "craft, not lore": project-agnostic, no memory files of its own. The trainer is the opposite by
   nature — its whole subject is this system's meta-DB estate and it carries a manual about it. It
   would fail the crew lints, and loosening them for it would let project lore leak into the eight
   roles that must stay portable.
5. **Project-scope the three to the Zeehive project** (084). A migration is the distribution
   channel to every database, and each database's Zeehive `project_id` differs (every cage's DB is
   fresh), so a migration cannot name it. System-wide matches every migration-seeded harness,
   including `queenzee-minister`; a human can scope them later in the console if the pickers get
   noisy — that door stays open.

**Consequences.** Easy: casting a trainer/teacher from any manager (they are worker harnesses in
every worker picker); improving the crew's own text later (they are ordinary rows, trainable by
their own discipline). Hard: master's knowledge of the crew is a roster, so adding a third estate
role means updating master's memory in the same migration (the teacher's skill says so in step 6).
Impossible, deliberately: master landing a harness edit itself; a worker wearing master; master
being re-parented onto teacher (the type guard holds, and the companion test proves it).

**Reversibility.** Text is trainable forward at any time (fill-only-empty and by-path-put keep
console edits safe). Keys and the parent/type choices are the one-way doors: a wrong one is a
re-mint under a new key and a `DELETE` of the old row by a human (wearers drop to core via
`ON DELETE SET NULL`). Nothing in 138 alters existing rows, guards or schema, so landing it is
additive and its blast radius on any database is three new rows.

**What would change our mind.** A real wearer that needs to be BOTH — to land harness migrations
and to dispatch — would force the master/teacher split to be revisited; today that agent cannot
exist under 052's walls, and the crew is shaped so it does not need to.
