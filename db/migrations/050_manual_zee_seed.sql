-- TEACH THE MANUAL THE NARROW PROD-DATA VERB — `zee seed` (migration 049 / queenzee/seedgate.js).
--
-- The cxell-zee manual lives in the meta DB (047) and reaches a xell only via harness injection, so
-- a new verb that isn't written HERE does not exist as far as a zee is concerned: it would be a door
-- nobody was told about, and the zee would keep reaching for the sledgehammer (`zee prod`, the whole
-- live database) for what is one reviewed file.
--
-- Surgical, and idempotent by guard: three anchored replacements inside the manual text, applied
-- only if the manual does not already mention `zee seed`. Anchors are exact lines from 047, so a
-- manual a human has since edited in the harness manager is left ALONE rather than clobbered —
-- if an anchor has moved, that replacement simply does not fire.
DO $$
DECLARE
  txt text;
  mem jsonb;
BEGIN
  SELECT bundle->'memory'->0->>'text' INTO txt FROM harness WHERE key='zee-base';
  IF txt IS NULL OR txt LIKE '%zee seed%' THEN RETURN; END IF;

  -- (1) the verb table
  txt := replace(txt,
    E'zee prod --reason "…"                            # ask to be bound to the prod database\n',
    E'zee prod --reason "…"                            # ask to be bound to the prod database (the WHOLE live db)\n'
    || E'zee seed --file <seed.sql> --reason "…"          # ask a human to approve a LANDED seed file; the QUEENZEE runs it on PROD\n');

  -- (2) a section of its own, right after `zee prod` (whose text now points at it)
  txt := replace(txt,
    E'### `zee done` — propose you are finished',
    E'### `zee seed` — have the queenzee SEED production for you\n'
    || E'`POST /api/xell/self/seed-request` `{ file | files, reason }`. The **narrow** prod-data verb, and the\n'
    || E'one to reach for when a shipment is not usable until rows exist in production (reference data, a\n'
    || E'lookup the new screen reads, the first row of a new feature). You name **landed** `*.sql` file(s)\n'
    || E'under `server/sql/seeds/`, a human reads the exact SQL in the console, and the **QUEENZEE** runs it\n'
    || E'against the production database. You never hold prod, never run psql, and cannot approve your own ask.\n'
    || E'\n'
    || E'- **Land it first.** The queenzee reads the file FROM main (`git show <main-tip>:<file>`), never from\n'
    || E'  your worktree — the same anti-band-aid rule as a ship. An unlanded seed is refused, with the reason.\n'
    || E'- **Only `server/sql/seeds/*.sql`.** That whitelist is what keeps "approve" from ever meaning "run any\n'
    || E'  file in the repo on production".\n'
    || E'- **Write it IDEMPOTENT** (`ON CONFLICT DO NOTHING` / `WHERE NOT EXISTS`). Seeds are deliberately NOT\n'
    || E'  ledgered — unlike a migration, a seed may legitimately be re-run — so re-running must be harmless.\n'
    || E'  The console shows a human every prior run of the same file before they approve a repeat.\n'
    || E'- `zee seed --status` reports where your request got to; the outcome (per file) lands on it, and\n'
    || E'  `zee status` carries it as `prod_seed`. Your hexagon shows `seed?` until a human decides.\n'
    || E'- A deploy in flight owns production: an approved seed FAILS loudly rather than writing data\n'
    || E'  underneath a half-swapped container. Ask again once the ship finishes.\n'
    || E'\n'
    || E'### `zee done` — propose you are finished');

  -- (3) `zee prod` gains the "prefer the narrow ask" pointer
  txt := replace(txt,
    E'bound, reads are free; before any write or migration, state exactly what it will change and get a\nhuman to agree.',
    E'bound, reads are free; before any write or migration, state exactly what it will change and get a\n'
    || E'human to agree.\n\n'
    || E'**Prefer `zee seed` when all you need is ROWS in production.** Binding hands you the entire live\n'
    || E'database for what is usually one file; a seed request hands that one file to the queenzee instead,\n'
    || E'and a human gets to read the SQL before it runs. Ask for the bind when the job genuinely IS the\n'
    || E'data — an investigation, a one-off repair whose shape you cannot know in advance.');

  SELECT jsonb_set(bundle, '{memory,0,text}', to_jsonb(txt)) INTO mem FROM harness WHERE key='zee-base';
  UPDATE harness SET bundle = mem WHERE key='zee-base';
END $$;
