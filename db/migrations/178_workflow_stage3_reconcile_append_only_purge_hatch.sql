-- STAGE 3 RECONCILE — give the append-only event log a deliberate purge escape hatch.
--
-- CONTEXT: 177 created event with `ON DELETE CASCADE` from run, and forbid_mutation()
-- raising on EVERY delete. The cascade can therefore NEVER fire: the FIRST event row makes
-- its run permanently undeletable — DELETE FROM run raises "append-only table event: DELETE
-- is not permitted" from inside the cascade — and there is no retention/purge path of any
-- kind for run history. The stage-3 teardown discovered this: its `DELETE FROM run` for a
-- run that had an event was refused, and because the teardown swallowed errors it exited 0
-- with rows left behind.
--
-- FIX (the manager-reviewed call): forbid_mutation() now permits DELETE only when the SESSION
-- has explicitly opted in via the `zeehive.purge_events` custom GUC. UPDATE stays forbidden
-- ALWAYS, with no hatch. I16 protects against history being silently REWRITTEN by application
-- code; it was never meant to mean "no administrator may ever purge". An opt-in that a writer
-- must name in its own session cannot be tripped by accident, and it makes the cascade honest:
-- an admin (or a test teardown) sets the GUC, DELETE FROM run, and the cascade removes the
-- events with it.
--
-- The ONLY legitimate uses are retention/GDPR purge and test teardown; the engine never sets
-- it. See the COMMENT ON TABLE event below.
--
-- FORWARD-ONLY, idempotent: CREATE OR REPLACE FUNCTION replaces the body in place, so the
-- existing event_append_only trigger picks up the new behaviour; COMMENT ON is an upsert.
-- A re-run of this file (or a second migrate pass) is a clean no-op.

CREATE OR REPLACE FUNCTION forbid_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' AND current_setting('zeehive.purge_events', true) = 'on' THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'append-only table %: % is not permitted', TG_TABLE_NAME, TG_OP;
END;
$$;

COMMENT ON TABLE event IS
  'PLANE 3: append-only event log (I16). UPDATE is forbidden always; DELETE raises via the event_append_only trigger UNLESS the session opts in with SET zeehive.purge_events = ''on'' — the ONLY legitimate uses are retention/GDPR purge and test teardown. The engine never sets it.';
