-- A ship's DB scope, and the zee's drift assessment — both facts the human approves WITH.
--
-- skip_migrations : the zee scoped this ship to CODE ONLY — pending sql/migrations + sql/ops
--                   files are deliberately NOT applied by runShip. Recorded on the request so the
--                   approve click covers exactly what will happen, and the results show the skip.
-- db_note         : the zee's own diagnosis of its db drift ("these are paddle tables; my change
--                   touches accounting only"). The /ooney schema gate accepts a measured drift
--                   when the zee assesses it as non-breaking — the assessment rides the request
--                   so the HUMAN judges the zee's reasoning, not a bare green tick.
ALTER TABLE ship_request
  ADD COLUMN IF NOT EXISTS skip_migrations boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS db_note text;
