-- XOURCE AS A TREE — a xell can be another xell's xource.
--
-- Until now a xource was always the project's local main: one root, every xell hanging off it. So
-- "where does my work go when I land?" had one answer, and the land gate could bake in one ref.
-- Both stop being true once a xell is a source in its own right: a zee splits its work into child
-- xells, they land into IT, and it lands into main once the whole piece is done.
--
-- A xource is STILL a ref. What changes is that the ref may belong to a xell (its spinoff/ branch)
-- instead of to the project. xell_id NULL = the project's root xource (local main).
--
-- origin is NOT in this picture at all. It is a backup mirror that Mark pushes by hand; nothing
-- here tracks it, builds from it, or lands to it. The tree is entirely local.
ALTER TABLE xource ADD COLUMN IF NOT EXISTS xell_id uuid REFERENCES xell ON DELETE CASCADE;

COMMENT ON COLUMN xource.xell_id IS
  'The xell whose branch this xource IS. NULL = the project root xource (local main).';

-- One xource per xell: a xell is one branch, so it cannot be two different sources.
CREATE UNIQUE INDEX IF NOT EXISTS xource_xell_uq ON xource (xell_id) WHERE xell_id IS NOT NULL;

-- ── the impossibilities, extended ────────────────────────────────────────────
-- 001 gave xell_guard() two jobs: xource_id is immutable, and a xell may not track its own
-- xource's ref. A tree adds two more, and both are the kind that are silent when violated:
--
--   1. A xell-backed xource must name that xell's ACTUAL branch. A xource row claiming a ref its
--      xell is not on would gate the wrong branch and land work into thin air.
--   2. No cycles. A→B→A means "land into the thing that lands into me": the reconciler would
--      chase the loop forever and nothing could ever reach main. Cheap to check on write, and
--      impossible to reason about once the data exists.
CREATE OR REPLACE FUNCTION xource_guard() RETURNS trigger AS $$
DECLARE
  bref    text;
  cursor_ uuid;
  hops    int := 0;
BEGIN
  IF NEW.xell_id IS NOT NULL THEN
    SELECT branch INTO bref FROM xell WHERE id = NEW.xell_id;
    IF bref IS DISTINCT FROM NEW.ref THEN
      RAISE EXCEPTION 'xource.ref (%) must be its xell''s branch (%)', NEW.ref, bref;
    END IF;

    -- The cycle check has to live HERE as well as on xell, because the write that creates a loop
    -- is a XOURCE write, not a xell one: xell.xource_id is immutable, so a xell can never be
    -- re-pointed into a cycle — but re-pointing a xource at one of its own descendants makes
    -- "A lands into B, B lands into A" in a single UPDATE that xell_guard never sees. Verified:
    -- without this, that UPDATE succeeds and leaves a real loop in the table.
    --
    -- Walk UP from the xell this xource would belong to. Reaching this xource again = cycle.
    SELECT xource_id INTO cursor_ FROM xell WHERE id = NEW.xell_id;
    WHILE cursor_ IS NOT NULL LOOP
      IF cursor_ = NEW.id THEN
        RAISE EXCEPTION 'xource % would track its own descendant (cycle via xell %)', NEW.ref, bref;
      END IF;
      hops := hops + 1;
      IF hops > 64 THEN
        RAISE EXCEPTION 'xource chain deeper than 64 — refusing to walk further (cycle?)';
      END IF;
      SELECT x.xource_id INTO cursor_
        FROM xource xo JOIN xell x ON x.id = xo.xell_id
       WHERE xo.id = cursor_;
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS xource_guard_trg ON xource;
CREATE TRIGGER xource_guard_trg
  BEFORE INSERT OR UPDATE ON xource
  FOR EACH ROW EXECUTE FUNCTION xource_guard();

CREATE OR REPLACE FUNCTION xell_guard() RETURNS trigger AS $$
DECLARE
  xref    text;
  cursor_ uuid;
  hops    int := 0;
BEGIN
  -- a xell cannot be re-pointed to a different xource (cannot track another branch)
  IF (TG_OP = 'UPDATE') AND (NEW.xource_id IS DISTINCT FROM OLD.xource_id) THEN
    RAISE EXCEPTION 'xell.xource_id is immutable (a xell cannot track a different xource)';
  END IF;
  -- a xell's working branch can never equal its xource's ref
  SELECT ref INTO xref FROM xource WHERE id = NEW.xource_id;
  IF xref IS NOT NULL AND NEW.branch = xref THEN
    RAISE EXCEPTION 'xell.branch (%) may not equal its xource ref (%)', NEW.branch, xref;
  END IF;

  -- no cycles: walk up the chain of xources-backed-by-xells. The root xource has xell_id NULL,
  -- so a well-formed chain always terminates. hops is a backstop against a pre-existing loop —
  -- without it a bad row already in the table would hang this trigger instead of failing it.
  SELECT xell_id INTO cursor_ FROM xource WHERE id = NEW.xource_id;
  WHILE cursor_ IS NOT NULL LOOP
    IF cursor_ = NEW.id THEN
      RAISE EXCEPTION 'xell % may not track its own descendant (xource cycle)', NEW.slug;
    END IF;
    hops := hops + 1;
    IF hops > 64 THEN
      RAISE EXCEPTION 'xource chain deeper than 64 — refusing to walk further (cycle?)';
    END IF;
    SELECT xo.xell_id INTO cursor_
      FROM xell x JOIN xource xo ON xo.id = x.xource_id
     WHERE x.id = cursor_;
  END LOOP;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── a PR is a land_request the XOURCE accepts, rather than one a push raised ──
-- 009 modelled exactly one way for work to reach a xource: the zee pushes, the hook declines,
-- a human approves, the zee re-pushes. That keeps the initiative with the zee.
--
-- 'pull' inverts it: the xell ASKS, and a human accepts on the XOURCE's card — the side that
-- receives the code decides to take it. Same table, same gate, same approval-bound-to-a-sha rule;
-- only who acts differs. Accepting is still a fast-forward push of the exact approved sha, so a
-- PR cannot smuggle in a commit nobody read.
CREATE TYPE land_kind AS ENUM ('push', 'pull');

ALTER TABLE land_request ADD COLUMN IF NOT EXISTS kind land_kind NOT NULL DEFAULT 'push';

COMMENT ON COLUMN land_request.kind IS
  'push = raised by the xource''s update hook declining a zee push. pull = a PR: the xell asked, '
  'and a human accepts it on the xource''s card.';

-- The console lists open PRs per xource ref to render them on that xource's card, so index the
-- lookup it actually makes. Partial: most rows are spent (landed/rejected) and never queried.
CREATE INDEX IF NOT EXISTS idx_land_request_open_by_ref
    ON land_request (project_id, ref, requested_at DESC)
 WHERE status IN ('pending', 'approved');
