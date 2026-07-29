-- The HOLDING PATTERN's own columns, and the impossibilities that keep it from ever becoming a
-- second way onto main (see 066 for the why).
--
-- A holding row is an ASK THAT IS NOT YET A QUESTION: recorded, positioned, and waiting for the
-- tower. It is deliberately absent from every open read model — the console's landing list, the
-- landing pad, fleet's land_pending and 009's `land_request_open_uq` all filter on
-- status IN ('pending','approved'), and 'holding' is not one of them. That is not an oversight to
-- fix later: it is the mechanism. One runway, one card.
ALTER TABLE land_request
  ADD COLUMN IF NOT EXISTS holding_since     timestamptz,             -- entered the pattern
  -- Which landing it entered the pattern BEHIND. Kept as a fact rather than derived, so the receipt
  -- still says who was on the runway long after that row has landed and the queue has drained.
  ADD COLUMN IF NOT EXISTS behind_request_id uuid REFERENCES land_request ON DELETE SET NULL,
  -- The CLEARANCE receipt. A cleared holder has left the pattern: the runway freed, and the tower
  -- told its zee to sync and ask again. Terminal, and NOT a decision — nobody read this sha.
  ADD COLUMN IF NOT EXISTS cleared_at        timestamptz,
  ADD COLUMN IF NOT EXISTS cleared_by        text,
  ADD COLUMN IF NOT EXISTS clear_reason      text;

COMMENT ON COLUMN land_request.holding_since IS
  'When this push entered the holding pattern (another xell''s landing was open on the ref). Its '
  'QUEUE POSITION is never stored — it is counted from requested_at at read time, so a holder '
  'leaving can never leave stale numbers behind on the ones still waiting.';
COMMENT ON COLUMN land_request.cleared_at IS
  'The runway freed and this holder was released: the queenzee nudged its zee to `zee sync` then '
  '`zee land`. Clearance grants NOTHING — the fresh push is gated exactly like any other.';

-- 062 widened this for 'withdrawn' (the zee un-asked it, so nobody decided). 'holding' is the same
-- shape of fact and for a stronger reason: a holding row must never carry a decision at all.
ALTER TABLE land_request DROP CONSTRAINT IF EXISTS land_decided_has_decider;
ALTER TABLE land_request ADD CONSTRAINT land_decided_has_decider CHECK (
  status IN ('pending','withdrawn','holding') OR (decided_at IS NOT NULL AND decided_by IS NOT NULL)
);

-- IMPOSSIBILITY: a holding row that looks decided, or landed. The whole safety of the queue is that
-- a request in the pattern was never put in front of a human — so it cannot carry a decider, a
-- decision time or a landed time. Without this, a holding row could be dressed up as approved work.
ALTER TABLE land_request DROP CONSTRAINT IF EXISTS land_holding_never_decided;
ALTER TABLE land_request ADD CONSTRAINT land_holding_never_decided CHECK (
  status <> 'holding' OR (decided_at IS NULL AND decided_by IS NULL AND landed_at IS NULL)
);

-- IMPOSSIBILITY: a holding row with no record of when it entered the pattern. Position is counted,
-- not stored, so `holding_since` is the only thing that says how long a zee has been waiting.
ALTER TABLE land_request DROP CONSTRAINT IF EXISTS land_holding_has_since;
ALTER TABLE land_request ADD CONSTRAINT land_holding_has_since CHECK (
  status <> 'holding' OR holding_since IS NOT NULL
);

-- IMPOSSIBILITY: a PR in the runway queue. kind='pull' is a different ask, raised by a different
-- verb and judged against a CHILD xource's ref — sequencing it behind a landing on main would make
-- a zee wait for a runway it was never taxiing towards. The queue is kind='push' only.
ALTER TABLE land_request DROP CONSTRAINT IF EXISTS land_holding_is_push;
ALTER TABLE land_request ADD CONSTRAINT land_holding_is_push CHECK (
  status <> 'holding' OR kind = 'push'
);

-- IMPOSSIBILITY: a clearance receipt on something that was never holding, or one with no clearer.
-- "Who cleared this, and why" is what a human reads when a zee says it was told to go around.
ALTER TABLE land_request DROP CONSTRAINT IF EXISTS land_cleared_is_holding;
ALTER TABLE land_request ADD CONSTRAINT land_cleared_is_holding CHECK (
  cleared_at IS NULL OR (status = 'holding' AND cleared_by IS NOT NULL)
);

-- THE ONE THAT MATTERS: a holding request may NEVER be promoted into the approvable states.
-- A CHECK cannot see the row it is replacing, so this is a trigger. Clearance is a nudge, not an
-- approval: the zee syncs and pushes again, and THAT push raises a fresh pending row for a human to
-- read. Anything that tried to flip a holding row straight to pending/approved/landed would be
-- inventing a landing nobody was ever asked about — so it stops here, in the database, no matter
-- which code path (or hand-run UPDATE) attempts it.
--
-- The two exits a holder does have: it stays 'holding' (the clearance receipt is written in place),
-- or the zee un-asks it with `zee land --withdraw`.
CREATE OR REPLACE FUNCTION land_holding_no_promotion() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'holding' AND NEW.status NOT IN ('holding','withdrawn') THEN
    RAISE EXCEPTION USING
      MESSAGE = format('land_request %s is HOLDING (waiting for the runway) and cannot become ''%s''',
                       OLD.id, NEW.status),
      DETAIL  = 'A holding request was never put in front of a human, so nothing about it has been '
              || 'approved. Clearing the runway only NUDGES its zee: the zee syncs, pushes again, and '
              || 'that push raises a fresh request for a human to decide.',
      HINT    = 'Clear it (cleared_at/cleared_by) and let the zee re-push, or let the zee withdraw it. '
              || 'Never promote it.',
      ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS land_holding_no_promotion ON land_request;
CREATE TRIGGER land_holding_no_promotion BEFORE UPDATE ON land_request
  FOR EACH ROW EXECUTE FUNCTION land_holding_no_promotion();

-- One live holding row per (project, ref, sha) — the same discipline 009's `land_request_open_uq`
-- gives open requests: a zee that re-pushes while holding bumps `attempts` on its place in line
-- instead of taking a second one. Cleared rows are history and drop out of the index.
CREATE UNIQUE INDEX IF NOT EXISTS land_request_holding_uq
  ON land_request (project_id, ref, new_sha)
  WHERE status = 'holding' AND cleared_at IS NULL;

-- The queue read, in the order the tower calls it: oldest ask first, per runway.
CREATE INDEX IF NOT EXISTS land_request_holding_idx
  ON land_request (project_id, ref, requested_at)
  WHERE status = 'holding' AND cleared_at IS NULL;
