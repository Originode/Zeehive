-- QUARANTINE A XELL AFTER CONSECUTIVE TURN DEATHS (ticket #81).
--
-- The incident this card exists for: three zees died in a row on one xell (~$14 burned, 468 lines
-- never landed), and every recovery path (swap, re-dispatch) happily started another agent in the
-- same unhealthy cage. The counter that catches that lives HERE, on the xell row, because the streak
-- belongs to the CAGE — a zee row is replaced on every swap, so a counter on the zee would be
-- laundered by exactly the recovery path the card must stop.
--
--   consecutive_deaths  — the current streak of consecutive turn DEATHS on this xell. A death is a
--                         turn the death classifier (lib/turn-death.js) filed as anything but 'none'
--                         (transient/terminal/unknown) — i.e. a turn that did NOT end on a decision of
--                         the zee's. A healthy end ('end_turn') RESETS it to 0 (server/src/lib/
--                         xell-quarantine.js resetXellConsecutiveDeaths, called from intake.js at the
--                         moment the turn closes 'ended'). A fleet-pause leaves it UNCHANGED: a pause
--                         neither proves the cage healthy nor is it a death, and allowing it to reset
--                         the streak would let a pause launder a death run.
--   quarantined_at      — set the moment consecutive_deaths crosses the threshold; NULL = not
--                         quarantined. A quarantined xell is refused by EVERY spawn/recovery path
--                         (dispatch, claim, swap, revive, pool pick) until a human decides between
--                         rescuing the branch and reaping the cage. Clearing it is an explicit human
--                         act (lib/xell-quarantine.js clearXellQuarantine).
--   quarantine_deaths   — the streak value that actually triggered the quarantine, so the card can
--                         say "3 consecutive deaths" even if the counter has not moved since.
--   quarantine_reason   -- the human sentence: the death signal, and the unlanded-work brief (the
--                         crew read model's landings + diff) so nobody reaps the cage blind.
ALTER TABLE xell ADD COLUMN IF NOT EXISTS consecutive_deaths int NOT NULL DEFAULT 0;
ALTER TABLE xell ADD COLUMN IF NOT EXISTS quarantined_at timestamptz;
ALTER TABLE xell ADD COLUMN IF NOT EXISTS quarantine_deaths int;
ALTER TABLE xell ADD COLUMN IF NOT EXISTS quarantine_reason text;

-- The console lists quarantined xells; the guards also read the column by id, but the "all
-- quarantined" sweep and the "is anything stuck" dashboard are index-friendly this way.
CREATE INDEX IF NOT EXISTS xell_quarantined_at_idx ON xell (quarantined_at) WHERE quarantined_at IS NOT NULL;
