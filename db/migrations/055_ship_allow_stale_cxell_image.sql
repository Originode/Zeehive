-- The cxell-image override, as a PER-SHIP decision a human makes and the request RECORDS.
--
-- A failed cxell-image rebuild now FAILS the ship (scripts/lib/cxell-image.sh): a queenzee running
-- new code with a silently stale fleet image is the one outcome nobody can detect, and it cost two
-- zees an evening of mtime forensics to find once. But a fatal guard needs a release valve a human
-- can actually reach IN THE MOMENT — and the first one shipped was `CXELL_IMAGE_REQUIRED=0` in the
-- queenzee's OWN process env, which means editing .env and restarting the queenzee. Mid-incident,
-- with an urgent prod fix waiting, that is a trap: the override is itself a deploy action.
--
-- So the override rides the ship request, exactly like skip_migrations (026): the human ticks
-- "ship anyway with a stale cxell image" on the card, shipgate passes CXELL_IMAGE_REQUIRED=0 to the
-- build script EXPLICITLY for that one ship, and the choice is on the row afterwards — so the audit
-- trail says a human chose it, on purpose, at that time, rather than a build quietly not mattering.
--
-- Default false = the guard is fatal. Unticked ships behave exactly as before this column existed,
-- and the process-env escape still works for a queenzee that cannot reach a docker daemon at all.
ALTER TABLE ship_request
  ADD COLUMN IF NOT EXISTS allow_stale_cxell_image boolean NOT NULL DEFAULT false;
