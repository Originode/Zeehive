-- PER-XELL VISUAL VERIFICATION — a human opt-in at dispatch time. When ON, the deployed zee
-- builds the webapp and OFFERS the live link to a human in the console (a small card with an
-- Open-link button and a dismiss). Per-xell boolean config, nothing irreversible: the zee only
-- inserts an offer row and broadcasts; a human opens the link or dismisses it. No approve/reject
-- gate, no prod, no write beyond this meta-DB.
--
-- Two shapes, both copied from existing patterns (house rule: build on the precedent):
--   * the per-xell column rides like xell_pause_state / environment_id — a boolean on `xell`,
--     default false, so existing xells are unchanged (false xells get no briefing diff);
--   * the offer table is shaped like prod_seed_request (049) — project_id, xell_id, xell_slug,
--     status, timestamps, dismissed_at/by — but deliberately NARROWER: status is open|dismissed
--     (no approve/reject/running ladder — there is no gate to climb), and the row carries the
--     webapp url + head commit it is offering so the console card never has to re-derive them.
--
-- The manuals are edited BY PATH through harness_memory_put (house rule 9 / 076), never by
-- rebuilding the memory array: the worker manual (zee-base → cxell-zee-manual.md) gains the
-- `zee verify-webapp` verb, and the manager manual (manager → manager-zee-manual.md) gains
-- `--visual-verify` on dispatch/assign. Both edits are anchored + idempotent: each returns early
-- when its text is already present and refuses to guess when an anchor has moved.
ALTER TABLE xell ADD COLUMN IF NOT EXISTS visual_verify boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS visual_verify_offer (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  -- SET NULL, not CASCADE, like prod_seed_request: an offer is a receipt about a moment of a
  -- throwaway xell, and the record of what was offered need not vanish with the xell.
  xell_id      uuid REFERENCES xell(id) ON DELETE SET NULL,
  xell_slug    text,
  url          text,      -- the webapp container url this offer points a human at
  commit       text,      -- the xell's head commit when the offer was made
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open','dismissed')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  dismissed_at timestamptz,
  dismissed_by text
);

CREATE INDEX IF NOT EXISTS visual_verify_offer_xell_idx
  ON visual_verify_offer (xell_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS visual_verify_offer_project_idx
  ON visual_verify_offer (project_id, created_at DESC);

-- ── WORKER MANUAL (zee-base → cxell-zee-manual.md): document `zee verify-webapp` ─────────────
DO $$
DECLARE
  txt     text;
  anchor  text := 'zee seed --file <seed.sql> --reason "…"          # ask a human to approve a LANDED seed file; the QUEENZEE runs it on PROD';
  status  text := E'### `zee status` — orient';
  line    text;
  section text;
BEGIN
  txt := harness_memory_get('zee-base', 'cxell-zee-manual.md');
  IF txt IS NULL THEN
    RAISE NOTICE 'worker manual: no memory entry on this database — nothing to patch';
    RETURN;
  END IF;
  IF txt LIKE '%zee verify-webapp%' THEN
    RAISE NOTICE 'worker manual: zee verify-webapp is already documented';
    RETURN;
  END IF;
  IF position(anchor IN txt) = 0 OR position(status IN txt) = 0 THEN
    RAISE NOTICE 'worker manual: an anchor has moved — add zee verify-webapp by hand';
    RETURN;
  END IF;

  line := E'zee verify-webapp                             # offer your built webapp URL to a HUMAN in the console (open or dismiss; NOT gated)';
  txt := replace(txt, anchor, anchor || E'\n' || line);

  section := E'### `zee verify-webapp` — offer your built webapp to a human\n'
          || E'`POST /api/xell/self/verify-webapp`. When a human turned on VISUAL VERIFICATION for this xell\n'
          || E'(at dispatch time), your briefing says so. Build the webapp first (`zee build webapp --wait`),\n'
          || E'then call this to OFFER the live link to a human in the console — a small card with an\n'
          || E'**Open link** button (the webapp container url, new tab) and a **dismiss**. It is an offer,\n'
          || E'not a gate: no approve/reject, no prod, nothing irreversible, and it writes only this meta-DB.\n'
          || E'Do NOT land or ship anything to make this happen.\n'
          || E'\n'
          || E'It is NOT gated and acts immediately (like `zee build`) — the whole point is a human gets to\n'
          || E'SEE the running webapp this xell built, and decide for themselves.\n'
          || E'\n';
  txt := replace(txt, status, section || status);

  PERFORM harness_memory_put('zee-base', 'cxell-zee-manual.md', txt);
  RAISE NOTICE 'worker manual: documented zee verify-webapp';
END $$;

-- ── MANAGER MANUAL (manager → manager-zee-manual.md): document `--visual-verify` ─────────────
--
-- ⚠ These edits must NOT modify migration 059's verbatim text (the `zee assign` verb-table line and
-- the whole WORK TRACKER section): test/work-assign.test.mjs asserts 059's replacements are verbatim
-- in the manual the meta-DB holds. So only the `zee dispatch` verb line (080's seed text, not 059's)
-- is edited IN PLACE, and the prose is added as a NEW paragraph outside 059's section.
DO $$
DECLARE
  txt        text;
  dline_old  text := 'zee dispatch --task "…" [--model …] [--mode 1..5] [--harness key] [--title "…"]';
  dline_new  text := 'zee dispatch --task "…" [--model …] [--mode 1..5] [--harness key] [--visual-verify] [--title "…"]';
  danchor    text := '### `zee swap` — change WHO is in a xell, not which xell';
  dpara      text;
BEGIN
  txt := harness_memory_get('manager', 'memory/manager-zee-manual.md');
  IF txt IS NULL THEN
    RAISE NOTICE 'manager manual: no memory entry on this database — nothing to patch';
    RETURN;
  END IF;
  IF txt LIKE '%--visual-verify%' THEN
    RAISE NOTICE 'manager manual: --visual-verify is already documented';
    RETURN;
  END IF;
  IF position(dline_old IN txt) = 0 OR position(danchor IN txt) = 0 THEN
    RAISE NOTICE 'manager manual: an anchor has moved — add --visual-verify by hand';
    RETURN;
  END IF;

  txt := replace(txt, dline_old, dline_new);

  -- A NEW paragraph, before the swap section, so it touches none of 059's verbatim text. It names
  -- BOTH verbs so a manager reading either surface learns the flag.
  dpara := E'### Visual verification — `--visual-verify` on dispatch / assign\n'
        || E'`zee dispatch --visual-verify` (and `zee assign --visual-verify`) turns on per-xell\n'
        || E'VISUAL VERIFICATION for the worker: it builds the webapp and OFFERS the live link to a\n'
        || E'human in the console (`zee verify-webapp` — Open link / dismiss). It is per-xell config and\n'
        || E'nothing irreversible — the worker never lands/ships for this.\n'
        || E'\n';
  txt := replace(txt, danchor, dpara || danchor);

  PERFORM harness_memory_put('manager', 'memory/manager-zee-manual.md', txt);
  RAISE NOTICE 'manager manual: documented --visual-verify on dispatch/assign';
END $$;
