-- A CLEARANCE NOBODY ANSWERED — the second half of the runway's fire-and-forget problem (#11).
--
-- 068/069 built the holding pattern: one runway per ref, and when it frees the tower CLEARS the front
-- of the queue by resuming that zee's session with "`zee sync`, then `zee land`". Two outcomes were
-- handled from the start. Delivered → the zee comes back with a fresh push. UNDELIVERABLE → a tend is
-- raised, because a clearance nobody hears is a zee stranded with no card (nudge.js
-- clearanceUndelivered).
--
-- The third outcome was not: DELIVERED, THEN DIED. The resume starts, the receipt truthfully says the
-- zee was nudged, and the session ends before it acts — a crash, a torn-down container, a turn that
-- simply stopped. Nothing ever returns to that row: clearRunway only walks holders with
-- `cleared_at IS NULL`, so a cleared row is out of the queue forever. The zee waits for a clearance it
-- already received and lost, its commits sit unlanded, and NO surface says so. (Confirmed by
-- investigation in #19, which proved the nudge slow rather than dead and said plainly that the dead
-- case was still unmitigated.)
--
-- The ruling this implements: re-clear a silent holder ONCE, then raise a tend. Once, because the
-- cheap failure is a lost nudge; a tend rather than a retry loop, because a zee that ignores two
-- clearances is a human's problem and not a schedule's. These two columns are what make "once" a FACT
-- rather than a guess — a counter in memory would forget across the restart that probably caused the
-- silence in the first place.
ALTER TABLE land_request
  -- The ONE re-clearance. Set when the re-call is ATTEMPTED (not when it is heard): what it protects
  -- against is calling forever, and an attempt is what a retry loop would repeat.
  ADD COLUMN IF NOT EXISTS recleared_at      timestamptz,
  -- …and the hand-off to a human, once the re-call also went unanswered. Also the "stop looking at
  -- this row" marker for the sweep: a tend already raised must not be raised again every 10s.
  ADD COLUMN IF NOT EXISTS silence_tended_at timestamptz;

COMMENT ON COLUMN land_request.recleared_at IS
  'This cleared holder went silent (it never pushed again) and the tower re-called it ONCE. Not a '
  'second clearance of the runway and not a decision — the same go-around, sent again because the '
  'first one was probably lost with the zee''s session.';
COMMENT ON COLUMN land_request.silence_tended_at IS
  'The re-call went unanswered too, so a HUMAN was raised (tend). This is the end of the automatic '
  'path: nothing retries after it, because a zee that ignored two clearances is not a timing problem.';

-- IMPOSSIBILITY: a re-clearance on something that was never cleared. The re-call is a repeat of a
-- clearance; without one there is nothing to repeat, and the row would be claiming an event that
-- never had a first occurrence.
ALTER TABLE land_request DROP CONSTRAINT IF EXISTS land_recleared_was_cleared;
ALTER TABLE land_request ADD CONSTRAINT land_recleared_was_cleared CHECK (
  recleared_at IS NULL OR cleared_at IS NOT NULL
);

-- IMPOSSIBILITY: tending the silence before re-calling it. The ruling is re-clear ONCE and THEN tend;
-- a tend with no re-clearance behind it means a human was summoned to a zee that was told once and
-- given no second chance — which is exactly the "cheap failure is a lost nudge" case being skipped.
ALTER TABLE land_request DROP CONSTRAINT IF EXISTS land_silence_tend_after_reclear;
ALTER TABLE land_request ADD CONSTRAINT land_silence_tend_after_reclear CHECK (
  silence_tended_at IS NULL OR recleared_at IS NOT NULL
);

-- The sweep's read: cleared holders that have not yet been handed to a human, oldest clearance first.
-- Partial like 068's queue indexes, so the rows this will never look at again (tended, or still in the
-- pattern) are not in it at all.
CREATE INDEX IF NOT EXISTS land_request_cleared_silence_idx
  ON land_request (cleared_at)
  WHERE status = 'holding' AND cleared_at IS NOT NULL AND silence_tended_at IS NULL;
