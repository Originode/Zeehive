-- ONE HELPER THAT EDITS HARNESS MEMORY **BY PATH** — so no migration hand-rolls the array again.
--
-- `harness.bundle->'memory'` is an ARRAY of {path, text} entries, and it is edited by migration
-- (047 seeds the cxell manual; every manual change since is a patch). Six migrations — 050, 051,
-- 053, 056, 057, 066 — patched it by reading `memory->0` and writing the array back as a
-- single-element `jsonb_build_array`, which DELETES every other memory file in that harness. It was
-- harmless while `memory` held one entry, and became a delete the day a human typed a second one in:
-- the live meta-DB lost the hand-written `tend-or-land.md` note (repaired forward by 071).
--
-- It survived six migrations and two zees because it is INVISIBLE on a fresh database — there is
-- only ever one entry to destroy — and every cxell has a fresh database.
--
-- The six are GRANDFATHERED, not rewritten: forward-only means they are applied everywhere, so
-- editing them changes nothing and desynchronises the ledger. test/harness-memory-migrations.test.mjs
-- lints the pattern. A lint catches the next occurrence; this HELPER removes the opportunity.
--
-- `harness_memory_put(harness_key, path, text)` is the ONLY function that WRITES a memory entry:
-- it locates the entry BY PATH (never by index), REPLACES its text when present and APPENDS a new
-- entry when absent, and touches nothing else — every sibling memory file, and every other key on
-- the entry itself, survives by construction. `harness_memory_get(harness_key, path)` is its read
-- half, so a surgical anchored edit (the 063/065 style) never has to walk the array either:
--
--   DO $$
--   DECLARE txt text;
--   BEGIN
--     txt := harness_memory_get('zee-base', 'cxell-zee-manual.md');
--     IF txt IS NULL OR txt LIKE '%the thing this migration writes%' THEN RETURN; END IF;   -- guard
--     PERFORM harness_memory_put('zee-base', 'cxell-zee-manual.md', replace(txt, <anchor>, <new>));
--   END $$;
--
-- IDEMPOTENT in the 065/071 sense, at two levels: CREATE OR REPLACE means re-running this file past
-- the ledger just redefines the same function, and `put` is a SET (write this text at this path),
-- not an append-to-the-array — so calling it twice with the same text is one entry, not two. It
-- reports what it did ('appended' | 'replaced' | 'unchanged' | 'no-harness') so a migration can
-- RAISE NOTICE the truth instead of assuming it.
--
-- Structural, not advisory: it changes no data, so on every database — fresh or years old — this
-- migration is schema only.

CREATE OR REPLACE FUNCTION harness_memory_get(p_harness_key text, p_path text)
RETURNS text
LANGUAGE sql
STABLE
AS $fn$
  -- BY PATH, first match wins, and a bundle whose `memory` is absent (or somehow not an array)
  -- yields NULL rather than an error — the caller's guard is `IF txt IS NULL THEN RETURN`.
  SELECT a.e->>'text'
    FROM harness h,
         LATERAL jsonb_array_elements(
           CASE WHEN jsonb_typeof(h.bundle->'memory') = 'array' THEN h.bundle->'memory'
                ELSE '[]'::jsonb END) WITH ORDINALITY AS a(e, i)
   WHERE h.key = p_harness_key AND a.e->>'path' = p_path
   ORDER BY a.i
   LIMIT 1;
$fn$;

CREATE OR REPLACE FUNCTION harness_memory_put(p_harness_key text, p_path text, p_text text)
RETURNS text
LANGUAGE plpgsql
AS $fn$
DECLARE
  idx     int;
  cur     text;
  memtype text;
BEGIN
  IF p_harness_key IS NULL OR p_path IS NULL OR btrim(p_path) = '' THEN
    RAISE EXCEPTION 'harness_memory_put: harness key and memory path are both required';
  END IF;
  IF p_text IS NULL THEN
    -- A NULL text is always a bug in the caller (usually an unguarded read of a missing entry), and
    -- writing it would brief a zee with an empty memory file. Refuse loudly inside the transaction.
    RAISE EXCEPTION 'harness_memory_put: refusing to write a NULL text to %/% (guard the read first)',
      p_harness_key, p_path;
  END IF;

  PERFORM 1 FROM harness WHERE key = p_harness_key;
  IF NOT FOUND THEN
    -- Not an error: a harness a migration expects may simply not exist on this database (a
    -- hand-created one, or one a later migration adds). Say so; the caller decides if it matters.
    RETURN 'no-harness';
  END IF;

  SELECT jsonb_typeof(bundle->'memory') INTO memtype FROM harness WHERE key = p_harness_key;
  IF memtype IS NOT NULL AND memtype <> 'array' THEN
    RAISE EXCEPTION 'harness_memory_put: %.bundle->''memory'' is % , not an array — refusing to overwrite it',
      p_harness_key, memtype;
  END IF;

  SELECT (a.i - 1), a.e->>'text' INTO idx, cur
    FROM harness h,
         LATERAL jsonb_array_elements(COALESCE(h.bundle->'memory', '[]'::jsonb)) WITH ORDINALITY AS a(e, i)
   WHERE h.key = p_harness_key AND a.e->>'path' = p_path
   ORDER BY a.i
   LIMIT 1;

  IF idx IS NULL THEN
    -- APPEND: `existing || jsonb_build_array(...)`, never a rebuilt array.
    UPDATE harness
       SET bundle = jsonb_set(bundle, '{memory}',
             COALESCE(bundle->'memory', '[]'::jsonb)
             || jsonb_build_array(jsonb_build_object('path', p_path, 'text', p_text)), true)
     WHERE key = p_harness_key;
    RETURN 'appended';
  END IF;

  IF cur IS NOT DISTINCT FROM p_text THEN
    RETURN 'unchanged';
  END IF;

  -- REPLACE: write into the ENTRY the path resolved to, and only into its `text` — any other key on
  -- that entry (and every other entry) is left exactly as it was.
  UPDATE harness
     SET bundle = jsonb_set(bundle, ARRAY['memory', idx::text, 'text'], to_jsonb(p_text))
   WHERE key = p_harness_key;
  RETURN 'replaced';
END
$fn$;

COMMENT ON FUNCTION harness_memory_put(text, text, text) IS
  'The ONLY supported way a migration edits harness.bundle memory: locates the entry BY PATH (never by index), replaces its text when present, appends the entry when absent, preserves every sibling. Returns appended|replaced|unchanged|no-harness. Six migrations (050/051/053/056/057/066) hand-rolled this and deleted siblings in production.';
COMMENT ON FUNCTION harness_memory_get(text, text) IS
  'Read a harness memory entry BY PATH (NULL when the harness or the entry is absent) — the read half of harness_memory_put, so an anchored edit never walks the memory array by hand.';
