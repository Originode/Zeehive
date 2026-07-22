-- Every prod backup now records HOW it was produced: a 'real' pg_dump of the production
-- database, or a 'simulate' placeholder (MAINTENANCE_MODE≠real writes a ~150-byte comment
-- file, NOT the data). They were indistinguishable in db_snapshot, so a simulated dump of a
-- big prod DB rendered as a normal, restorable backup — "why is the backup only a few bytes?"
-- was a simulated backup wearing a real one's clothes. Recording the mode lets the UI badge it
-- and lets restore refuse it, so a placeholder can never overwrite a real database.
-- NULL = legacy row whose mode was never captured (pre-038).
ALTER TABLE db_snapshot
  ADD COLUMN IF NOT EXISTS mode text;    -- 'real' | 'simulate' | NULL (legacy/unknown)
