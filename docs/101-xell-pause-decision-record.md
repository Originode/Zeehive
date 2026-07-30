# Decision Record: Per-Project and Per-Xell Pause

**Date:** 2026-07-30
**Author:** Architect (quiet-grove-05835b)
**Status:** Implemented (migration 101, server + web changes committed)

## Decision

The pause system is split into THREE levels — fleet-wide (existing `fleet_pause`),
project-scoped (new `project_pause` table), and per-xell (new session_event events
`'xell-pause'` / `'xell-resume'`). A xell is "paused" if ANY of the three levels
says so. The console pause button is now project-scoped by default (accepts a
`project` parameter); omitting it preserves the original fleet-wide behaviour.

Per-xell pause/play buttons appear on the expanded flower's SESSION petal (above
nudge). When a xell is paused its hexagon shows a red pause icon (two bars) instead
of the yellow blinking "working" dot. Worker hexagons now also carry a small harness
avatar disc in the upper-left corner.

## Context

The pause button was fleet-wide — one press stopped every zee in every project. This
is too blunt: an operator may want to pause one project without disrupting another,
or pause a single malfunctioning xell without stopping the whole fleet. The task
asked for three changes:

1. Project-scoped pause (the button should only affect the current project)
2. Individual per-xell play/pause buttons
3. Visual: red pause sign vs yellow dot, plus harness avatar badge on workers

## Options Considered

### Option A: Single fleet_pause table with project_id column
- **For:** Minimal schema change; one table for all pause state.
- **Rejected because:** The fleet_pause table is a singleton (`id boolean PRIMARY
  KEY DEFAULT true CHECK (id)`). Adding project_id would break the singleton
  constraint and require a migration that's more invasive than a new table. The
  fleet-level pause is semantically different from a project pause — it's the
  emergency stop that overrides everything — and mixing them in one table would
  lose that distinction.

### Option B: Per-xell pause column on the xell table
- **For:** Simplest possible read path; no joins needed.
- **Rejected because:** Every xell would carry a column it rarely uses. The
  `session_event` pattern (used for tend, hints, ship refusals) is already the
  established mechanism for per-xell boolean signals. Adding a column would also
  require a migration of the xell table (which has constraints and triggers), and
  the fleet read model's long SELECT already joins `session_event` for tend and
  hints — adding one more subquery follows the existing pattern exactly.

### Option C: Track all three levels in session_event
- **For:** No new tables; uniform mechanism.
- **Rejected because:** Project-scoped pause needs to store metadata (who paused,
  why, how many zees interrupted, timestamps). The `session_event` table's `raw`
  JSONB could hold this, but the fleet-level pause already uses a proper table
  (`fleet_pause`), and project pause should mirror it for consistency. Per-xell
  pause is lightweight enough for session_event (no metadata needed beyond the
  event name).

### Option D: Per-xell pause does NOT interrupt the zee
- **For:** Gentler pause — marks the xell as paused but lets the current turn
  finish.
- **Rejected because:** The task says "pause individual xells" and "play a single
  xell to work," which implies the same interrupt+resume cycle as the fleet pause.
  A mark-only approach would leave the zee running in an inconsistent state where
  it thinks it's working but the UI shows it paused. The fleet pause mechanism
  (SIGINT + `last_stop_reason`) is the established pattern and works identically
  per-xell.

## Consequences

### What this makes easy
- **Fine-grained control:** Any xell can be paused independently. The flower's
  SESSION petal provides pause/resume buttons right next to terminal and nudge.
- **No schema change for per-xell pause:** session_event is append-only and
  already used for this pattern.
- **Backward compatibility:** Fleet-wide pause still works when no project is
  specified. Old API callers that don't send `project` get the original behaviour.
- **Harness identity visible:** The avatar disc on worker hexes mirrors what
  manager hexes already show, making harness relation readable at a glance.

### What this makes hard
- **Three sources of truth for "is this xell paused":** The hive status derivation
  checks three flags (fleet pause + project pause + per-xell event) and any one
  can set `occ-paused`. The console cannot always tell the operator WHICH level
  caused the pause — it just shows "paused." A future refinement could tag the
  `occ-paused` state with the source.
- **Nudge/dispatch do not yet check per-xell pause:** Currently only the fleet
  pause flag blocks nudges and dispatches (nudge.js `fleetPaused()` check). A
  per-xell-paused xell that is not fleet-paused could still receive a nudge from
  its manager or a dispatch into it. This was deliberately left out of scope —
  the immediate need was visual state + interrupt. Adding the check is a small
  follow-up in `nudge.js` and `intake.js`.
- **No per-xell pause SSE event:** Session events don't trigger SSE, so the UI
  only refreshes via the next poll. The fleet-pause / fleet-resume buttons call
  `refresh()` explicitly, and the flower buttons do the same. This is acceptable
  — the pause action is a human click that triggers a refresh; no background
  state change needs live pushing.

### What this makes impossible
- Nothing. Every previous behaviour is preserved.

## Reversibility

| Step | Reversible? | How |
|------|-------------|-----|
| Create `project_pause` table | Yes — `DROP TABLE` (if unused) or simply stop writing to it | |
| Introduce session_event 'xell-pause'/'xell-resume' | Yes — events can be ignored; the subquery in fleet.js just needs `hook_event_name NOT IN ('xell-pause','xell-resume')` to ignore them | |
| Frontend pause/resume buttons on flower | Yes — remove them from `petalVerbs` | |
| Harness avatar on compact hex | Yes — remove the `drawAvatarDisc` call | |
| Project-scoped pause API | Yes — roll back routes.js and FleetPause.jsx; existing `pauseFleet()` without project is unchanged | |

**One-way doors:**
- Adding `project_pause` references in fleet.js → removing them later is safe
  (the query just won't read the table). No one-way door here.

## What Would Change Our Mind

- If per-xell pause is used heavily (dozens of individually-paused xells), the
  `session_event` scan in fleet.js's subquery may become expensive. At that
  point, a dedicated `xell_pause` column or a small `xell_state` table would be
  justified.
- If operators need to see WHICH pause level is active on each xell, the
  `occ-paused` state should be split into `occ-paused-fleet`, `occ-paused-project`,
  and `occ-paused-individual` variants.
- If the pause button is too easy to click accidentally (it has no confirmation),
  adding a confirmation for project-level pause could be warranted. Per-xell
  pause already goes through the flower's petal menu and is hard to trigger by
  accident.

## Files Changed

```
M  db/migrations/101_xell_pause_project_scope.sql    (NEW)
M  server/src/lib/fleet-pause.js                      (project + xell pause functions)
M  server/src/queenzee/pause.js                       (pauseProject, resumeProject, pauseXell, resumeXell)
M  server/src/lib/hive-status.js                      (+xellPaused signal)
M  server/src/lib/fleet.js                            (read per-xell pause, pass projectPaused)
M  server/src/api/routes.js                           (project-scoped pause, per-xell pause/resume)
M  web/src/api.js                                     (+pauseXell, +resumeXell)
M  web/src/FleetPause.jsx                             (+projectId prop)
M  web/src/App.jsx                                    (pass projectId, per-xell pause/resume handlers)
M  web/src/hive/HiveCanvas.jsx                        (pause icon, harness avatar, per-xell flower buttons)
```
