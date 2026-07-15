-- SHIPPING TO PRODUCTION — a zee ASKS; the queenzee ships.
--
-- Until now prod was zee-driven: the zee grabbed the deploy lock (MCP zeehive_prod_lock_acquire)
-- and then deployed BY HAND, however it saw fit. Two failures in that:
--   1. Nothing gated it on a human.
--   2. A zee deploying from its own worktree ships a BAND-AID: the change is live but not on main,
--      so the next deploy from main silently reverts it. The fix "doesn't stick".
--
-- So: the zee may only REQUEST. A human approves in the console. Then the QUEENZEE takes the lock
-- and runs the build itself, from the XOURCE AT MAIN — which is why a ship requires the work to be
-- landed first (see 009_land_gate). What ships is exactly what the next rebuild will produce.
-- Band-aids become impossible by construction rather than by rule.

-- ── how a container builds itself (queenzee-executed, never zee-executed) ─────
-- Path + interpreter live on the CONTAINER row, so the queenzee looks up how to build a thing
-- rather than hardcoding one project's deploy. Contract — the script is invoked as:
--     <build_exec> <build_script> <source_path> <role> <docker_ctx> <mode>
-- and must print ONE json line: {"ok":bool,"head":"<sha>","method":"...","service":"..."}
-- (identical to scripts/build-container.sh, so the same projector reads both).
ALTER TABLE container
  ADD COLUMN IF NOT EXISTS build_script text,                     -- NULL = not buildable by queenzee
  ADD COLUMN IF NOT EXISTS build_exec   text NOT NULL DEFAULT 'bash';

CREATE TYPE ship_status AS ENUM ('pending','approved','rejected','shipping','shipped','failed');

CREATE TABLE ship_request (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES project ON DELETE CASCADE,
  xell_id      uuid NOT NULL REFERENCES xell ON DELETE CASCADE,
  zee_id       uuid REFERENCES zee ON DELETE SET NULL,
  commit       text,                                   -- main tip at request time (what ships)
  reason       text,                                   -- what the zee says it is shipping
  status       ship_status NOT NULL DEFAULT 'pending',
  containers   jsonb NOT NULL DEFAULT '[]'::jsonb,     -- per-container ship result
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_at   timestamptz,
  decided_by   text,
  started_at   timestamptz,
  finished_at  timestamptz,
  error        text,
  CONSTRAINT ship_decided_has_decider CHECK (
    status = 'pending' OR status = 'shipping'
    OR (decided_at IS NOT NULL AND decided_by IS NOT NULL)
  )
);

-- One open ship per xell — a zee re-asking bumps nothing, it just sees its existing request.
CREATE UNIQUE INDEX ship_request_open_uq
  ON ship_request (project_id, xell_id)
  WHERE status IN ('pending','approved','shipping');

CREATE INDEX ship_request_pending_idx ON ship_request (project_id, requested_at DESC)
  WHERE status = 'pending';

-- ── lock lifecycle: the queenzee assigns it, and takes it back on a timer ─────
-- After a successful ship the lock auto-releases (default 3 min) WITHOUT asking anyone: an
-- unattended hold blocks every other xell for as long as the human is away. The console offers a
-- HOLD, which cancels the countdown (held=true, auto_release_at=NULL) for a human who is actively
-- verifying. `ship_id` ties a held lock back to the ship that earned it.
ALTER TABLE deploy_lock
  ADD COLUMN IF NOT EXISTS auto_release_at timestamptz,   -- NULL = no countdown running
  ADD COLUMN IF NOT EXISTS held            boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS ship_id         uuid REFERENCES ship_request ON DELETE SET NULL;
