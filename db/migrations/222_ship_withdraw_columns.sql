-- The receipt for a withdrawal (see 221 for the why) — WHO withdrew it, WHEN, and their reason.
--
-- Kept separate from decided_at/decided_by, which mean "a HUMAN judged this": a withdrawal is the
-- zee lowering its own ask, and writing the zee into decided_by would make the audit trail claim a
-- human decision that never happened. So the existing CHECK is widened to let a withdrawn row carry
-- no decider, and a second CHECK makes the opposite impossible — a withdrawn row with no record of
-- who withdrew it.
--
-- Note that a ship withdrawn from 'approved' keeps its decided_at/decided_by (the human DID approve
-- it before the zee pulled the ask back) — the widened CHECK allows a withdrawn row to carry either
-- with or without a decider, which is exactly the honest audit of "approved, then un-asked".
ALTER TABLE ship_request
  ADD COLUMN IF NOT EXISTS withdrawn_at     timestamptz,
  ADD COLUMN IF NOT EXISTS withdrawn_by     text,
  ADD COLUMN IF NOT EXISTS withdraw_reason  text;

ALTER TABLE ship_request DROP CONSTRAINT IF EXISTS ship_decided_has_decider;
ALTER TABLE ship_request ADD CONSTRAINT ship_decided_has_decider CHECK (
  status IN ('pending','withdrawn') OR status = 'shipping'
  OR (decided_at IS NOT NULL AND decided_by IS NOT NULL)
);

ALTER TABLE ship_request DROP CONSTRAINT IF EXISTS ship_withdrawn_has_withdrawer;
ALTER TABLE ship_request ADD CONSTRAINT ship_withdrawn_has_withdrawer CHECK (
  status <> 'withdrawn' OR (withdrawn_at IS NOT NULL AND withdrawn_by IS NOT NULL)
);
