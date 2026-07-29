# The Crew Lead harness (`dev-lead`)

A manager-type harness for a zee that runs a **dev crew**: it reads a piece of work, decides which
specialist role that work needs, and dispatches a worker wearing that role's harness. It writes no
code, exactly like its parent.

## What it actually adds

`dev-lead` inherits `manager` (its row's `parent_id`, set by migration), so the manager
manual, the `dispatch-brief` skill and every manager refusal arrive by inheritance — the chain is
merged root→leaf by `effectiveHarness()`, and none of it is duplicated in this folder. On top of that
it adds exactly two things:

- **`pick-the-role`** (skill) — an ordered set of questions that ends in ONE role, plus the rule for
  when *not* to split a job into a chain of them.
- **`dev-role-roster.md`** (memory) — the eight roles, what each returns, and how to hold the roster
  (default to `dev-builder`; never let the author review their own work; if nothing fits, it is a
  `dev-scout` job).

## The roster it casts from

`dev-scout` (spec + breakdown) · `dev-architect` (structure, decision record) · `dev-builder`
(implement) · `dev-tester` (make it checkable) · `dev-reviewer` (adversarial diff review) ·
`dev-fixer` (repro-first debugging) · `dev-scribe` (docs stay true) · `dev-shipwright` (landed work
to production). All eight are WORKER harnesses inheriting `dev-base`.

## Type

`zee_type: manager`, and it must be: a harness may only inherit within its own type (migration 054),
so a worker-typed harness could not name `manager` as its parent, and the DB refuses to put this
harness on a worker xell at all. `test/dev-lead-harness.test.mjs` asserts that refusal along with the
bundle, the inherited chain and the size budget.

## Not Zeehive-specific

Nothing in the persona, the skill or the roster names a language, a framework, a path or a container.
A Crew Lead runs the same eight roles on any project; the first thing it and every worker it casts do
is read that project's own manual.

Row: migration `074_dev_lead.sql` (key, label, `zee_type='manager'`, enabled); **080** imported its
persona, its `pick-the-role` skill and its roster into the row and set `parent_id` to `manager`. The
row is the truth — see [docs/harness-proposal.md](harness-proposal.md) §3.1 for why it stopped being a
folder.
