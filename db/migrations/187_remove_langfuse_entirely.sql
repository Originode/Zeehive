-- REMOVE LANGFUSE ENTIRELY — tables, column, and every manual/briefing mention.
--
-- The gateway spine (execution → zee_turn → llm_gateway_request) replaced Langfuse as the
-- observability record: every AI call crosses the queenzee gateway and is recorded at the
-- transport layer. Langfuse was a SECOND, opt-in, self-hosted tracing path — redundant, so
-- it is removed, not demoted (operator decision).
--
-- WHAT THIS DROPS (forward-only, idempotent):
--   langfuse_config        — single-row plugin state (migration 114)
--   langfuse_project_map   — per-project 1:1 mapping (migration 117)
--   langfuse_signin_token  — one-time signin/reveal tokens (migration 144)
--   xell.langfuse_tracking — the per-xell tracking toggle (migration 140)
--
-- Historical migrations 114/117/140/143/144/145 that BUILT these are immutable and stay; their
-- DDL is harmless on a fresh database (they run before this one), and migration 143's REVOKE
-- blocks for langfuse tables are guarded by to_regclass() so they no-op once the tables are gone.
--
-- THE MANUAL, THE BRIEFING AND THE CLI USAGE MOVE TOGETHER (house rule 8): the CLI no longer
-- advertises --langfuse/--no-langfuse (scripts/zee), so the manager manual (a harness memory
-- entry, house rule 9) drops its `### Langfuse` section (114) and its `### Langfuse tracking`
-- paragraph (140), and the `zee dispatch` verb line loses the `[--langfuse|--no-langfuse]` flag.
-- Each edit is anchored + idempotent: a moved anchor raises a NOTICE and is left for a human,
-- never guessed at. test/cxell-cli-drift.test.mjs owns the "verb documented in the manual" half.

-- ── 1. DROP THE LANGFUSE SCHEMA (tables + the per-xell toggle column) ─────────────
DROP TABLE IF EXISTS langfuse_signin_token;
DROP TABLE IF EXISTS langfuse_project_map;
DROP TABLE IF EXISTS langfuse_config;
ALTER TABLE xell DROP COLUMN IF EXISTS langfuse_tracking;

-- ── 2. THE MANAGER MANUAL — remove the Langfuse sections and the CLI flag ────────
DO $mig$
DECLARE
  txt     text;
  changed boolean := false;

  -- the dispatch verb line, as migration 140 rewrote it (back to the pre-langfuse shape)
  dline_old text := 'zee dispatch --task "…" [--model …] [--mode 1..5] [--harness key] [--visual-verify] [--langfuse|--no-langfuse] [--title "…"]';
  dline_new text := 'zee dispatch --task "…" [--model …] [--mode 1..5] [--harness key] [--visual-verify] [--title "…"]';

  -- the Langfuse-tracking paragraph migration 140 inserted before the swap section
  lft_start text := '### Langfuse tracking — `--langfuse` / `--no-langfuse` on dispatch / assign' || E'\n';
  lft_end   text := '### `zee swap` — change WHO is in a xell, not which xell';

  -- the Langfuse section migration 114 inserted before the conversations section
  lf_start  text := '### `Langfuse` — the observability record of what your crew did' || E'\n';
  lf_end    text := '### `zee conversations` — review your crew''s conversation archives';
BEGIN
  txt := harness_memory_get('manager', 'memory/manager-zee-manual.md');
  IF txt IS NULL THEN
    RAISE NOTICE 'manager manual: no memory entry on this database — nothing to patch';
  ELSE
    -- 2a. the dispatch verb line loses the --langfuse/--no-langfuse flag.
    IF position(dline_old IN txt) > 0 THEN
      txt := replace(txt, dline_old, dline_new); changed := true;
    ELSIF position(dline_new IN txt) > 0 THEN
      RAISE NOTICE 'manager manual: the dispatch verb line already lacks --langfuse — nothing to do';
    ELSE
      RAISE NOTICE 'manager manual: the dispatch verb line has moved — remove --langfuse/--no-langfuse by hand';
    END IF;

    -- 2b. drop the `### Langfuse tracking` paragraph (from the start of its heading to the swap
    --     section that followed it). The paragraph was inserted directly before the swap section,
    --     so removing everything between the two headings restores the pre-140 text exactly.
    IF position(lft_start IN txt) > 0 AND position(lft_end IN txt) > position(lft_start IN txt) THEN
      txt := substr(txt, 1, position(lft_start IN txt) - 1)
          || substr(txt, position(lft_end IN txt));
      changed := true;
    ELSE
      RAISE NOTICE 'manager manual: the Langfuse-tracking paragraph (or its swap anchor) has moved — left for a human';
    END IF;

    -- 2c. drop the `### Langfuse` section (from its heading to the conversations section that
    --     followed it).
    IF position(lf_start IN txt) > 0 AND position(lf_end IN txt) > position(lf_start IN txt) THEN
      txt := substr(txt, 1, position(lf_start IN txt) - 1)
          || substr(txt, position(lf_end IN txt));
      changed := true;
    ELSE
      RAISE NOTICE 'manager manual: the Langfuse section (or its conversations anchor) has moved — left for a human';
    END IF;

    IF changed THEN
      PERFORM harness_memory_put('manager', 'memory/manager-zee-manual.md', txt);
      RAISE NOTICE 'manager manual: removed the Langfuse sections and the --langfuse flag';
    ELSE
      RAISE NOTICE 'manager manual: no Langfuse text found — nothing to remove';
    END IF;
  END IF;
END
$mig$;
