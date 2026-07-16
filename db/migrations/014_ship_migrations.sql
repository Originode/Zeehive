-- SQL migrations ride the ship. Which ones a ship will apply is decided at REQUEST time and shown
-- to the human beside the commit — one approval covers code + schema, because shipping them
-- separately is how prod spent months schema-behind main (the ledger lives in the APPLICATION
-- database itself; see server/src/queenzee/shipmigrate.js).
ALTER TABLE ship_request
  ADD COLUMN IF NOT EXISTS migrations jsonb NOT NULL DEFAULT '[]';

COMMENT ON COLUMN ship_request.migrations IS
  'server/sql/migrations/*.sql files pending at request time — applied by the queenzee before the containers build.';
