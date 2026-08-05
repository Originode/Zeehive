-- PER-XELL LANGFUSE TRACKING SWITCH (default ON) — a human (or a manager) can turn Langfuse
-- tracking OFF for one xell. When OFF the queenzee records no trace for that xell's turns and
-- injects no LANGFUSE_* env into its cage. The Langfuse plugin itself is untouched: provisioning,
-- keys and the project mapping stay exactly as they are.
--
-- Three shapes, copied from existing patterns (house rule: build on the precedent):
--   * the column rides like visual_verify (106) — a boolean on `xell`, default true, so existing
--     xells are ON (no backfill that turns an existing xell off);
--   * the setter is shaped like setVisualVerify (self.js);
--   * the manager manual gains `--langfuse` / `--no-langfuse` on dispatch/assign, edited BY PATH
--     through harness_memory_put (house rule 9 / 076), anchored + idempotent, and deliberately
--     NOT touching migration 059's verbatim lines (test/work-assign.test.mjs asserts them verbatim).
ALTER TABLE xell ADD COLUMN IF NOT EXISTS langfuse_tracking boolean NOT NULL DEFAULT true;

-- ── MANAGER MANUAL (manager → manager-zee-manual.md): document `--langfuse`/`--no-langfuse` ────
--
-- The `zee dispatch` verb line (edited in place, like 106) and a NEW paragraph before the swap
-- section. Deliberately does NOT touch 059's verbatim `zee assign` verb-table line — the new
-- paragraph names both verbs so a manager reading either surface learns the flag.
DO $$
DECLARE
  txt        text;
  dline_old  text := 'zee dispatch --task "…" [--model …] [--mode 1..5] [--harness key] [--visual-verify] [--title "…"]';
  dline_new  text := 'zee dispatch --task "…" [--model …] [--mode 1..5] [--harness key] [--visual-verify] [--langfuse|--no-langfuse] [--title "…"]';
  danchor    text := '### `zee swap` — change WHO is in a xell, not which xell';
  dpara      text;
BEGIN
  txt := harness_memory_get('manager', 'memory/manager-zee-manual.md');
  IF txt IS NULL THEN
    RAISE NOTICE 'manager manual: no memory entry on this database — nothing to patch';
    RETURN;
  END IF;
  IF txt LIKE '%--no-langfuse%' THEN
    RAISE NOTICE 'manager manual: --langfuse/--no-langfuse are already documented';
    RETURN;
  END IF;
  IF position(dline_old IN txt) = 0 OR position(danchor IN txt) = 0 THEN
    RAISE NOTICE 'manager manual: an anchor has moved — add --langfuse/--no-langfuse by hand';
    RETURN;
  END IF;

  txt := replace(txt, dline_old, dline_new);

  -- A NEW paragraph, before the swap section, so it touches none of 059's verbatim text. It names
  -- BOTH verbs so a manager reading either surface learns the flag.
  dpara := E'### Langfuse tracking — `--langfuse` / `--no-langfuse` on dispatch / assign\n'
        || E'`zee dispatch --langfuse` (and `zee assign --langfuse`) turns Langfuse tracking ON for\n'
        || E'the worker; `--no-langfuse` turns it OFF. The default is ON. When a worker xell has\n'
        || E'tracking OFF, the queenzee records no trace of its turns and injects no `LANGFUSE_*`\n'
        || E'env into its cage — the observability record simply skips it. Per-xell config and\n'
        || E'nothing irreversible; a human can also flip it from the xell terminal window.\n'
        || E'\n';
  txt := replace(txt, danchor, dpara || danchor);

  PERFORM harness_memory_put('manager', 'memory/manager-zee-manual.md', txt);
  RAISE NOTICE 'manager manual: documented --langfuse/--no-langfuse on dispatch/assign';
END $$;
