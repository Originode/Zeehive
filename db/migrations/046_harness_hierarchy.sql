-- HARNESS HIERARCHY — a harness may INHERIT a parent harness.
--
-- A child harness's effective persona = its parent chain merged (root → … → leaf): personality
-- concatenated with attribution, skills and memory unioned, glyph/summary from the nearest that sets
-- them. The `core` law layer is always applied ON TOP regardless (it is not a parent in this tree) —
-- a harness may add beneath the law, never override it. Cycles are impossible (guard below), the same
-- discipline the xource tree uses.
ALTER TABLE harness ADD COLUMN IF NOT EXISTS parent_id uuid REFERENCES harness ON DELETE SET NULL;

CREATE OR REPLACE FUNCTION harness_parent_guard() RETURNS trigger AS $$
DECLARE cursor_ uuid; hops int := 0;
BEGIN
  IF NEW.parent_id IS NOT NULL THEN
    IF NEW.parent_id = NEW.id THEN RAISE EXCEPTION 'a harness cannot be its own parent'; END IF;
    -- walk UP from the proposed parent; reaching this row again = cycle
    cursor_ := NEW.parent_id;
    WHILE cursor_ IS NOT NULL LOOP
      IF cursor_ = NEW.id THEN RAISE EXCEPTION 'harness % would inherit its own descendant (cycle)', NEW.key; END IF;
      hops := hops + 1;
      IF hops > 32 THEN RAISE EXCEPTION 'harness parent chain deeper than 32 — refusing (cycle?)'; END IF;
      SELECT parent_id INTO cursor_ FROM harness WHERE id = cursor_;
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS harness_parent_guard_trg ON harness;
CREATE TRIGGER harness_parent_guard_trg
  BEFORE INSERT OR UPDATE ON harness
  FOR EACH ROW EXECUTE FUNCTION harness_parent_guard();

COMMENT ON COLUMN harness.parent_id IS
  'The harness this one inherits from (NULL = a root). Effective persona = parent chain merged; the core law layer still always applies on top. Cycles blocked by harness_parent_guard().';

-- ── seed the Zee Base + zeetest example hierarchy ────────────────────────────
-- Zee Base incorporates the full cxell-zee manual (its memory references docs/cxell-zee-manual.md,
-- read live by loadHarnessDir — no duplication). zeetest inherits it. Both are file-backed; boot
-- refreshHarnesses() fills their bundle + resolves zeetest.parent_id from HARNESS.yml `parent:`.
-- SUPERSEDED BY 047 (kept as the record of what this migration did): the manual was moved INTO the
-- meta DB and Zee Base made DB-owned (dir=NULL), and docs/cxell-zee-manual.md was deleted. Nothing
-- in the repo carries the manual today — do not go looking for that path.
INSERT INTO harness (key, label, dir, is_law_core, enabled)
VALUES ('zee-base', 'Zee Base', 'harnesses/zee-base', false, true)
ON CONFLICT (key) DO NOTHING;
INSERT INTO harness (key, label, dir, is_law_core, enabled)
VALUES ('zeetest', 'Zee Test', 'harnesses/zeetest', false, true)
ON CONFLICT (key) DO NOTHING;
