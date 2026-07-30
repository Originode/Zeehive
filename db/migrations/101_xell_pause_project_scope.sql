-- PER-PROJECT PAUSE (alongside the fleet-wide fleet_pause) + PER-XELL PAUSE via session_event
--
-- The fleet_pause table (100) pauses every zee in every project — a global emergency stop.
-- This migration adds a per-project pause table, so the console's pause button can be scoped to
-- one project while leaving the fleet-wide button unchanged.
--
-- Per-xell individual pause uses the existing session_event mechanism (latest-event-wins, same
-- as tend/hints), with events 'xell-pause' and 'xell-resume'. No xell table schema change needed.
--
-- PROJECT PAUSE: like fleet_pause but keyed by project_id. One row per project, never merged:
--   • fleet_pause.paused == true  →  every xell holds  (overrides everything)
--   • project_pause.paused == true  →  every xell in that project holds
--   • xell session_event 'xell-pause'  →  that one xell holds
-- The hive_status derivation AND each gate check all three, so a xell is paused if ANY of them
-- says so. The console shows the narrowest cause.
CREATE TABLE IF NOT EXISTS project_pause (
  project_id    uuid PRIMARY KEY REFERENCES project(id) ON DELETE CASCADE,
  paused        boolean     NOT NULL DEFAULT false,
  paused_at     timestamptz,
  paused_by     text,
  reason        text,
  resumed_at    timestamptz,
  resumed_by    text,
  -- receipts of the last fan-out in each direction
  interrupted   int         NOT NULL DEFAULT 0,
  unreachable   int         NOT NULL DEFAULT 0,
  nudged        int         NOT NULL DEFAULT 0
);
-- Seed a default non-paused row for EVERY existing project. The `paused` column drives the
-- actual state; a missing row reads as "not paused" (see lib/fleet-pause.js).
INSERT INTO project_pause (project_id, paused)
  SELECT id, false FROM project
  ON CONFLICT (project_id) DO NOTHING;
