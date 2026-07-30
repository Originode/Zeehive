# Which copy of the entry-point doc is the SOURCE? — a recommendation, not a change

**Status: RECOMMENDATION. Nothing here is built.** Ticket #38 fixed one divergence and added the check
that makes the next one loud ([test/project-doc-drift.test.mjs](../test/project-doc-drift.test.mjs)).
It did not decide where the document should live, because that is a human's call and the false sentence
was worth removing tonight regardless of how the architecture lands.

## 1. What actually happened

`CLAUDE.md` is **committed**. `project_doc.body` in the meta-DB generates `AGENTS.md` and the rest of
the provider files, and it targets `claude` too — but house rule 11 says generation never writes over a
git-tracked path, so the generated `CLAUDE.md` is skipped and the committed one wins.

That is one document with two copies and no mechanism keeping them equal.

Measured first-hand at 2026-07-30 00:47, against the live queenzee (`GET /api/projects/:id/docs`):

| | committed `CLAUDE.md` | `project_doc.body` |
|---|---|---|
| the nested-queenzee containment claim | corrected at 23:30 (`ad13d77`) | **still the false version** |
| four doc-map rows added over the evening | present | absent |
| §1 "two servers answer the same paths" | present | absent |

For 77 minutes, Claude Code read "it does **not** follow that it can never touch the real fleet" while
eighteen other tools read that it can never touch the real fleet — a claim this repo had just disproved
by finding `proddiff` probing real production databases ungated and the ship's migration step writing to
prod. Nothing went red. Nobody was careless: the two copies simply have no relationship a machine checks.

**Why house rule 11 produced this, and it was still the right rule.** "Never write over a committed
path" exists because a generated file landing on top of a project's own instructions destroys work that
a human deliberately committed and reviewed — a much worse failure than staleness. The rule is sound.
What is missing is the other half: having declined to write the file, nothing then *reconciles* the row
with it. The rule prevents a clobber and is silent about the divergence it creates.

## 2. The two ways it can run

### Option A — the committed file is the source; the row is derived

`CLAUDE.md` in git is the one text. `project_doc.body` becomes a projection of it, refreshed from the
repo (at onboarding, on a landing that touches it, or by an explicit "sync from repo" action).

* **For:** the source is the copy that already gets reviewed, diffed, blamed and landed. Editing it is a
  normal PR. Every existing habit already points at it — including every zee's, since the file is what
  `CLAUDE.md`/`AGENTS.md` tell them to read.
* **Against:** the queenzee must READ a project's repo to refresh, which is a real dependency (and in a
  cxell an unreadable one — `project.repo_root` is a host path). The console's Docs tab stops being an
  authoring surface and becomes a viewer, which is a feature being taken away from whoever wanted it.
  And a project that has NOT committed a doc still needs the row to be authorable, so both modes have to
  coexist — the rule becomes "committed file wins where one exists", which is what house rule 11 already
  says, now with teeth.

### Option B — the row is the source; the committed file is generated

`project_doc.body` is the one text, and `CLAUDE.md` is generated like every other provider file —
meaning house rule 11's exemption is dropped for this path and the generated file is git-excluded.

* **For:** one authoring surface, no repo reads, and it is what the code already believes: the generated
  banner says "The SOURCE is the project's Docs tab, not this file", `targets` already includes `claude`,
  and the only reason it is not true is the tracked-file exemption.
* **Against:** it makes a project's instructions un-reviewable in a PR — no diff, no blame, no landing
  gate on the text a fleet of agents obeys. That is a significant loss for a document whose whole
  function is to be authoritative. It also means deleting a committed `CLAUDE.md` from a repo that has
  one, which is a change to somebody else's project, and (for THIS repo) removing the file that CLAUDE.md
  itself tells every zee to read first.

## 3. Recommendation

**Option A, and narrowly: keep house rule 11 exactly as it is, and add the reconciliation it is missing.**

The deciding argument is not convenience, it is reviewability. This document is the thing a fleet of
agents is instructed to obey; tonight it was the difference between an agent believing it cannot reach
production and knowing it can. A text with that much authority should be reviewed the way code is —
diffed, landed, attributable — and Option B trades that away for an authoring convenience. Option A also
keeps every current habit pointing at the same place, which matters more than it sounds: the divergence
happened because a zee corrected the copy everyone naturally edits, and nothing carried it across.

Concretely, and each of these is small:

1. **Keep the check.** `test/project-doc-drift.test.mjs` already fails when the row and a committed file
   disagree. That alone converts this class of bug from "found by accident eight documents later" into a
   red run.
2. **Make the sync an action rather than a migration.** Tonight's repair is migration
   `097_project_doc_sync_claude_md.sql` — 18 KB of embedded document, which works exactly once, and the
   next `CLAUDE.md` edit turns the check above red through nobody's fault. Until the decision here is
   made, [`scripts/sync-project-doc.mjs`](../scripts/sync-project-doc.mjs) keeps that remedy to one
   command (`zee migration-number`, then generate). The standing fix is a
   `POST /api/projects/:id/docs/sync-from-repo` (host-side, reading `repo_root`) so the next one is a
   click rather than a migration — the check says when it is needed either way.
3. **Say it in the Docs tab.** When a project has a committed file for a ticked provider, the editor
   should show that the committed copy wins and this text is a projection — the console currently invites
   an edit whose effect is invisible for that provider, which is how the wrong copy gets edited.

**What would change my mind:** if the Docs tab is meant to be the authoring surface for projects that do
*not* live in a repo the queenzee can read, Option A's repo dependency is a real blocker and Option B's
single surface wins. That is a product question about who the Docs tab is for, and I do not know the
answer — which is exactly why this is a recommendation.

## 4. Not in scope here, but adjacent

The same shape exists one layer over: the cxell-zee **manual** is harness memory in the meta-DB, and
ticket #37 adds a note to it that must agree with `CLAUDE.md` §1. Two texts, one fact, no check. Whatever
is decided here should probably decide that too — and #38's check is the pattern to copy: compare the
stored text against the committed one and fail on a difference, rather than trusting a person to
remember both.
