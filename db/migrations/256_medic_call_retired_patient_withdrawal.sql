-- A CALL NEVER SILENTLY VANISHES when its patient is gone (the badged-call card, piece 2).
--
-- fleet.js's CALLED fold-in and listProjectMedicCalls both filter `x.status NOT IN
-- ('ready','retired','tearing-down')`, and that filter is CORRECT: a dead xell cannot be blocked, so
-- its row must stop nagging the ⛑ bar. But it was also where a call DISAPPEARED — 3 of the 4 open
-- prod calls at the time of this card were exactly that shape: an open medic_call row on a xell that
-- had since been reaped, out of every feed, with no resolution and nobody able to see it. The
-- exclusion was doing its job; what was missing was a RECEIPT.
--
-- The new rule (server/src/queenzee/reaper.js): the moment the reaper retires a xell, every live
-- call it raised is WITHDRAWN with the reason below, so the history says WHY the emergency stopped.
-- lib/medic-calls.RETIRED_PATIENT_WITHDRAWAL_REASON carries the same string in code — a receipt only
-- means something if the two say the same thing.
--
-- THIS MIGRATION BACKFILLS the rows that predate the rule: every currently-live call on an already-
-- retired xell. That is the operator's clean slate, and it is the deploy that delivers it — not a
-- hand-run prod write. It backfills ONLY rows the new rule would already catch (status open/attended
-- on a retired xell); no other prod data is touched. Resolved/declined/withdrawn rows are already
-- history and stay untouched.
--
-- Idempotent, forward-only: a second run matches no rows (they are withdrawn by the first), and it
-- grants the medic role nothing — medic_call remains on MEDIC_NO_WRITE_TABLES (a medic never writes
-- this table; this is the queenzee's own bookkeeping).

UPDATE medic_call mc
   SET status = 'withdrawn',
       resolution = 'withdrawn automatically: the patient is gone — its xell retired, so no medic '
                    'can attend this call. The fault, if it still exists, belongs to a fresh xell '
                    'with a fresh call.',
       updated_at = now()
  FROM xell x
 WHERE x.id = mc.xell_id
   AND x.status = 'retired'
   AND mc.status IN ('open', 'attended');
