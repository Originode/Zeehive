# Which copy of the entry-point doc is the SOURCE? — DECIDED: the row

**Status: DECIDED — Option B.** The meta-DB row is the single source of truth; a committed
`CLAUDE.md`/`AGENTS.md` in a repo is a *generated artefact* that the queenzee supersedes in every xell.
This reverses the original recommendation (Option A) below. The change shipped with migration 209 and
the `overwriteTracked` exemption on `lib/cxell.js`'s doc injector.

## 1. What actually happened

`CLAUDE.md` is **committed**. `project_doc.body` in the meta-DB generates `AGENTS.md` and the rest of
the provider files, and it targets `claude` too — but house rule 11 says generation never writes over a
git-tracked path, so the generated `CLAUDE.md` was skipped and the committed one won. **That is the bug
this decision fixes:** "the docs that supposedly generates claude.md doesn't do it at all."

The old design was one document with two copies and no mechanism keeping them equal. Measured first-hand
at 2026-07-30 00:47, against the live queenzee (`GET /api/projects/:id/docs`):

| | committed `CLAUDE.md` | `project_doc.body` |
|---|---|---|
| the nested-queenzee containment claim | corrected at 23:30 (`ad13d77`) | **still the false version** |
| four doc-map rows added over the evening | present | absent |
| §1 "two servers answer the same paths" | present | absent |

For 77 minutes, Claude Code read "it does **not** follow that it can never touch the real fleet" while
eighteen other tools read that it can never touch the real fleet — a claim this repo had just disproved
by finding `proddiff` probing real production databases ungated and the ship's migration step writing to
prod. Nothing went red. Nobody was careless: the two copies simply have no relationship a machine checks.

**Why house rule 11 produced this, and why the old rule was still right for the WRONG files.** "Never
write over a committed path" exists because a generated file landing on top of a project's own
instructions destroys work that a human deliberately committed and reviewed. That fear is real for an
UNRELATED tracked file (a project's README, its own source — a file no project_doc row claims). It is
not real for the entry-point paths the row owns: those are exactly the files that are *supposed* to be
generated, and skipping them is what left every xell reading a copy the operator could not edit.

## 2. The two ways it can run

### Option A — the committed file is the source; the row is derived (rejected)

`CLAUDE.md` in git is the one text. `project_doc.body` becomes a projection of it, refreshed from the
repo (at onboarding, on a landing that touches it, or by an explicit "sync from repo" action).

* **For:** the source is the copy that already gets reviewed, diffed, blamed and landed.
* **Against:** the queenzee must READ a project's repo to refresh, which is a real dependency (and in a
  cxell an unreadable one — `project.repo_root` is a host path). The console's Docs tab stops being an
  authoring surface. And a project that has NOT committed a doc still needs the row to be authorable, so
  both modes would have to coexist.

### Option B — the row is the source; the committed file is generated (DECIDED)

`project_doc.body` is the one text, and `CLAUDE.md` is generated like every other provider file —
house rule 11's exemption is dropped for the paths the row owns, and the generated file is git-excluded.

* **For:** one authoring surface, no repo reads, and it is what the code already believed: the generated
  banner says "The SOURCE is the project's Docs tab, not this file", `targets` already includes `claude`.
  This is the only option under which "every xell gets a generated CLAUDE.md at deployment" is true.
* **Against:** it makes a project's instructions un-reviewable in a PR — no diff, no blame, no landing
  gate on the text a fleet of agents obeys. A human decided that loss is worth it: content changes go
  through the Docs tab (or a migration), and reviewability of the row's *text* is preserved by the
  migration that changes it.

## 3. What Option B does, concretely

1. **Every xell gets the generated file.** `injectProjectDocsIntoXell` calls the doc injector with
   `overwriteTracked:true` for the entry-point paths `project_doc` rows own (`lib/queenzee/intake.js`).
2. **A tracked path the row owns is superseded, not skipped.** `writeGeneratedDocIntoCxell`
   (`lib/cxell.js`) writes the generated copy over the committed one, adds it to `.git/info/exclude`,
   and `git update-index --skip-worktree`s it — so the superseded committed copy can never surface in a
   landing diff or a `git add -A`.
3. **An unrelated tracked path stays protected.** The injector's default is still the old refusal; only
   the caller's explicit `overwriteTracked:true` widens it. A README or source file no row claims is
   left alone, fleet-wide.
4. **The banner says the row is the source and changes go through the Docs tab / a ticket.** The
   generated file names the console path; editing the copy changes nothing.

## 4. What changed (and what was deleted) to get here

- `lib/cxell.js` — the injector gained `overwriteTracked`, a `WROTE_TRACKED` verdict, and the
  exclude+skip-worktree supersede path; the old unconditional TRACKED refusal is now the default when
  the caller does not own the path.
- `lib/queenzee/intake.js` — passes `overwriteTracked:true` for project entry-point docs.
- `lib/project-docs.js` — banner now points at the Docs tab / ticket flow for content changes; header
  comment says the row is the single source.
- `test/project-docs.test.mjs` §3 — asserts the NEW contract: a tracked path the row owns is
  written+excluded+skip-worktree'd (`WROTE_TRACKED`); an unrelated tracked path is still TRACKED.
- `test/project-doc-drift.test.mjs` — re-scoped: it no longer asserts the row must equal the *committed*
  file (the committed file is now the artefact). It still guards the false containment claim and proves
  the extractor.
- `docs/entry-point-doc-source.md` — this document, reversed from Option A to Option B.
- `scripts/sync-project-doc.mjs` — its direction is now dead (it pushed the committed file INTO the row,
  the wrong way). Kept for history; the standing change flow is the Docs tab or a migration.

## 5. Not in scope here, but adjacent

The same shape exists one layer over: the cxell-zee **manual** is harness memory in the meta-DB, and
ticket #37 adds a note to it that must agree with `CLAUDE.md` §1. Two texts, one fact, no check. Whatever
is decided here should probably decide that too — and #38's check is the pattern to copy: compare the
stored text against the committed one and fail on a difference, rather than trusting a person to
remember both.

## 4. Not in scope here, but adjacent

The same shape exists one layer over: the cxell-zee **manual** is harness memory in the meta-DB, and
ticket #37 adds a note to it that must agree with `CLAUDE.md` §1. Two texts, one fact, no check. Whatever
is decided here should probably decide that too — and #38's check is the pattern to copy: compare the
stored text against the committed one and fail on a difference, rather than trusting a person to
remember both.
