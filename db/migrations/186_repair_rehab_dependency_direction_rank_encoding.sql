-- REHAB 1/4 FOLLOW-UP — repair two defects in 185 (dependency direction + sibling_rank encoding).
--
-- 185 HAS ALREADY APPLIED to databases that ran it (including the live meta-DB via the spinoff
-- build), so this file REPAIRS the rows it wrote rather than only fixing the file for fresh runs.
-- 185 is also fixed in-tree (so a fresh database never sees the bugs); this file makes an
-- already-185'd database match what a fresh one produces.
--
-- DEFECT 1 — dependency direction was REVERSED (serious). dependency.from_id is the PREDECESSOR;
-- the legacy work_item_dep table means the OPPOSITE of its write order: for item X,
-- work-items.js reads "what X depends on" as `JOIN work_item w ON w.id = d.depends_on_id
-- WHERE d.work_item_id = X`, so work_item_id is the DEPENDENT (successor) and depends_on_id is
-- the PREREQUISITE (predecessor). 185 wrote from_id=node(work_item_id) → to_id=node(depends_on_id),
-- putting the dependent first — a visibly wrong gantt and wrong critical path. For each
-- work_item_dep edge this file deletes the reversed row and inserts the correct one
-- (from_id=node(depends_on_id) → to_id=node(work_item_id)).
--
-- DEFECT 2 — sibling_rank encoding broke on fractional/negative sort_order (a kanban drag writes
-- the MIDPOINT of two neighbours — web/src/work/order.js:36 — and `after - 1` for a drop into the
-- first slot once a column head reaches 0). 185 used lpad(n::text,20,'0'), which right-pads a
-- decimal point (1500.5 sorts after 3000) and misaligns a negative sign. This file re-encodes
-- every backfilled node's rank with the fixed sign-safe formula
-- (to_char(n::numeric+1e9, 'FM00000000000000000000.000000') || ':' || id) — the SAME formula
-- work-node-sync.js now uses for new writes, so old and new rows stay in ONE consistent format.
--
-- FORWARD-ONLY + IDEMPOTENT: the re-encode is guarded by IS DISTINCT FROM (a second run sees no
-- change), and the dependency repair deletes the reversed row then INSERT ... ON CONFLICT DO
-- NOTHING (a second run finds the correct row already present and the reversed row absent).
-- Running this file twice changes zero rows.

-- ── DEFECT 2: re-encode every backfilled node's sibling_rank (sign-safe fixed-width) ──────────
-- Only rows keyed to a work_item (stable_key = 'work_item:<uuid>'); a foreign row a workflow test
-- authored (stable_key NULL, e.g. the stage-3 suite's root) keeps its own rank. The `:id`
-- tiebreaker keeps ranks distinct even when two siblings share a sort_order, so the per-parent
-- unique index wn_i4_rank_unique is never at risk (new ranks never equal old ranks — different
-- widths — and distinct sort_orders map to distinct new ranks).
UPDATE work_node wn
SET sibling_rank = to_char(wi.sort_order::numeric + 1000000000, 'FM00000000000000000000.000000')
                  || ':' || wi.id::text
FROM work_item wi
WHERE wn.stable_key = 'work_item:' || wi.id::text
  AND wn.sibling_rank IS DISTINCT FROM
      (to_char(wi.sort_order::numeric + 1000000000, 'FM00000000000000000000.000000') || ':' || wi.id::text);

-- ── DEFECT 1: repair the dependency direction ─────────────────────────────────
-- For each legacy edge, the correct model row is from_id=node(depends_on_id) → to_id=node(work_item_id).
-- The reversed row (if 185's bug wrote one) is deleted; the correct row is inserted idempotently.
-- The LCA container was already flipped to 'freeform' by 185, so the model's I5 trigger passes.
DO $repair$
DECLARE
  dep      record;
  v_prereq uuid;
  v_dep    uuid;
BEGIN
  FOR dep IN SELECT * FROM work_item_dep LOOP
    SELECT id INTO v_prereq FROM work_node WHERE stable_key = 'work_item:' || dep.depends_on_id::text;
    SELECT id INTO v_dep    FROM work_node WHERE stable_key = 'work_item:' || dep.work_item_id::text;
    IF v_prereq IS NULL OR v_dep IS NULL THEN
      RAISE NOTICE 'work_item_dep % → %: cannot resolve a work_node for both ends — skipping',
        dep.work_item_id, dep.depends_on_id;
      CONTINUE;
    END IF;
    -- the reversed row 185 wrote: from_id = node(dependent) → to_id = node(prerequisite)
    DELETE FROM dependency WHERE from_id = v_dep AND to_id = v_prereq AND type = 'FS';
    -- the correct row: from_id = node(prerequisite) → to_id = node(dependent)
    INSERT INTO dependency (from_id, to_id, type) VALUES (v_prereq, v_dep, 'FS')
    ON CONFLICT (from_id, to_id, type) DO NOTHING;
  END LOOP;
END $repair$;
