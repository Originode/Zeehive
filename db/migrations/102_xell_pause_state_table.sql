-- PER-XELL PAUSE STATE TABLE — replaces the session_event approach (101) with a proper
-- meta-DB row per xell, carrying full metadata (who paused, when, why).
--
-- The session_event approach (events 'xell-pause'/'xell-resume') was append-only log,
-- not state. It worked for fleeting signals (tend, hints) but a pause command is a
-- STATE: it persists across restarts, carries audit metadata, and must be readable
-- in a single column check — not a scan of an event log.
--
-- One row per xell, seeded as non-paused at creation (the INSERT in the migration
-- backfills every existing xell). The console writes paused/paused_by/paused_at/reason
-- on pause, and clears them on resume.
CREATE TABLE IF NOT EXISTS xell_pause_state (
  xell_id       uuid PRIMARY KEY REFERENCES xell(id) ON DELETE CASCADE,
  paused        boolean     NOT NULL DEFAULT false,
  paused_at     timestamptz,
  paused_by     text,
  reason        text,
  resumed_at    timestamptz,
  resumed_by    text
);

-- Seed a default non-paused row for EVERY existing xell.
INSERT INTO xell_pause_state (xell_id, paused)
  SELECT id, false FROM xell
  ON CONFLICT (xell_id) DO NOTHING;
