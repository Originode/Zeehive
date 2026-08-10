-- DOOR-SIDE WRITE LEDGER — ANY write into a LIVE cage leaves a row.
--
-- TKT-159-3139 (provenance spine): during the weld defect-fix round, code arrived in a worker's
-- tree pre-applied and landed under the shared 'zee <zee@zeehive.local>' git identity. Every zee
-- commits as the same identity, git carries no authorship, and the console terminal — a WRITE
-- DOOR into a live cage — left no record anywhere. This table is the audit trail for that door
-- and every door like it: each row is a byproduct of a WRITE (keystrokes into a terminal), never
-- an agent claim.
--
-- FOLLOWS THE REPO'S APPEND-ONLY PATTERN (the workflow `event` log, migration 177): INSERT only,
-- UPDATE/DELETE forbidden by trigger (reusing 177's generic forbid_mutation()). The console
-- terminal bridge (server/src/lib/terminal-bridge.js) inserts one row per {t:'i'} input frame on
-- /api/zees/:id/terminal and /api/containers/:id/terminal. `actor` is null when the websocket
-- carries no resolvable identity (today it does not — the ws rides the authenticated /api proxy
-- without a per-socket principal); `target` names the zee slug or container the door opened.
--
-- FORWARD-ONLY: CREATE TABLE IF NOT EXISTS, so a second migrate pass is a clean no-op. The DOWN
-- thinking (never run in prod): DROP TRIGGER door_write_event_append_only, then DROP TABLE
-- door_write_event. Nothing existing reads the table, so it is inert on databases where no
-- terminal bridge has run.
CREATE TABLE IF NOT EXISTS door_write_event (
  id           bigserial PRIMARY KEY,
  ts           timestamptz NOT NULL DEFAULT now(),
  door         text NOT NULL,             -- 'console-terminal' (zee SSH) | 'console-container' (docker exec shell)
  -- PLAIN uuid, deliberately NO FOREIGN KEY: this table is append-only, so an FK's ON DELETE
  -- action would have to UPDATE or DELETE a row to satisfy the constraint — which the trigger
  -- below forbids — and that would BLOCK reaping the xell/zee/container the row names (the
  -- reaper hard-deletes containers, and a xell/zee can be decommissioned at any time). The
  -- ids stay as untyped references; the `target` text names the row for a human reader.
  xell_id      uuid,
  zee_id       uuid,
  container_id uuid,
  target       text,                      -- zee slug or container name the door opened
  actor        text,                      -- resolvable actor identity, else null (see header)
  input        text,                      -- safe representation of the write (control chars escaped, capped)
  meta         jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS door_write_event_xell_idx ON door_write_event (xell_id, ts DESC);
CREATE INDEX IF NOT EXISTS door_write_event_ts_idx   ON door_write_event (ts DESC);
CREATE INDEX IF NOT EXISTS door_write_event_door_idx ON door_write_event (door, ts DESC);

-- Append-only: a write-door ledger row is a fact about what happened; it must never be edited
-- or deleted. Same generic function migration 177 created for the workflow `event` log.
CREATE OR REPLACE TRIGGER door_write_event_append_only
    BEFORE UPDATE OR DELETE ON door_write_event
    FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

COMMENT ON TABLE door_write_event IS
  'Door-side write ledger (TKT-159-3139): one row per WRITE into a live cage (console terminal input). Append-only.';
