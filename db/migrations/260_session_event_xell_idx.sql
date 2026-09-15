-- INDEX session_event BY XELL — the /api/fleet bottleneck fix (prod meta-DB at 700% CPU,
-- measured 2026-09-15). fetchXellRows (lib/fleet.js) runs four correlated lookups per xell
-- against session_event, all shaped `WHERE xell_id = ? AND hook_event_name IN (…) ORDER BY
-- ts DESC LIMIT 1`: the tend lateral, the env-alert lateral, and the land/ship hint scalar
-- subqueries. The table (~135k rows, 144 MB) had indexes on (claude_session_id, ts),
-- (zee_id, ts) and (turn_id, ts) — but NONE on xell_id, so every fleet snapshot paid
-- 4 × N-xells sequential scans to find rows that mostly do not exist.
--
-- A FULL index (not partial on the fleet's 8 hook_event_name values) on purpose: the same
-- xell-scoped shape is read by xell-quarantine (turn-death / tend-clear), the spin detector
-- (working-ping / tend-request / ship-refused / interactive-turn-start), fleet-pause
-- (nudge-held kinds), ops-review and the manager crew read — a partial index would serve
-- only fleet.js and leave every sibling reader on a seq scan. hook_event_name is the second
-- key so each `IN (…)` lookup descends straight to its kinds; ts DESC matches the
-- latest-event-wins ORDER BY.
--
-- ANALYZE because the planner's stats were stale enough to think ~10k rows (reltuples) on a
-- 135k-row table — part of why every execution was also JIT-compiled (see lib/fleet.js).
CREATE INDEX IF NOT EXISTS session_event_xell_kind_ts_idx
  ON session_event (xell_id, hook_event_name, ts DESC);
ANALYZE session_event;
