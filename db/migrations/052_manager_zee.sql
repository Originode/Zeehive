-- MANAGER ZEES — a xell whose zee runs OTHER zees.
--
-- Everything so far is flat: every xell is a worker, every gate is answered by a human, and the only
-- thing that can look at the whole fleet is the console. A MANAGER zee is a xell (a real hexagon in
-- the honeycomb, with its own cxell) whose job is coordination rather than code:
--
--   • it may DISPATCH worker zees, and every worker it dispatches is stamped with manager_xell_id
--     (so the honeycomb can seat the workers around it and the fleet can attribute them);
--   • it may CONVERSE with its workers in real time (zee_message, delivered into the live cxell
--     session over the same SSH send-keys path the console's 📨 button uses);
--   • it may SUGGEST that a xell is done — a suggestion only: a human confirms it in the console
--     (with a typed confirmation), and THAT is what tears a cxell down. Nothing here despawns.
--
-- And what it may NOT do, structurally rather than by prompt:
--
--   • ZERO push/PR access to the xource. A manager writes no code and lands none: `zee land`, the
--     xellgit push/pull-request paths and the landgate's `update` hook all REFUSE a manager xell
--     outright (landgate raises NO land_request, so there is nothing for a human to approve either).
--     A manager that wants a change made dispatches a worker to make it.
--   • its production database is READ-ONLY (db_coupling 'db-prod-readonly'): the queenzee binds it
--     to the prod db container through a dedicated read-only postgres ROLE, so "read-only" is
--     enforced by postgres, not by a rule in a prompt. Writing prod data stays `zee seed` (human
--     approved, queenzee run) exactly as it is for a worker.
--   • SHIPPING is deliberately NOT blocked. Holding the prod database is not a reason to withhold
--     the ship gate: a ship is still a request a human approves and the queenzee performs from main.
ALTER TABLE xell ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'worker';
DO $$ BEGIN
  ALTER TABLE xell ADD CONSTRAINT xell_role_chk CHECK (role IN ('worker','manager'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The manager this xell reports to (NULL = unmanaged, the historical default). ON DELETE SET NULL:
-- a worker outlives its manager's teardown as an ordinary unmanaged xell rather than vanishing.
ALTER TABLE xell ADD COLUMN IF NOT EXISTS manager_xell_id uuid REFERENCES xell ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS xell_manager_idx ON xell (manager_xell_id) WHERE manager_xell_id IS NOT NULL;

-- ── the impossibilities (structure, not rules) ───────────────────────────────
-- A manager reports to nobody and a worker may only report to a MANAGER: that keeps the hierarchy
-- exactly one level deep, which is what makes "seat the workers around their manager" a well-defined
-- layout and makes "who may dispatch" a single yes/no rather than a tree walk. Production is never
-- a manager and never managed.
CREATE OR REPLACE FUNCTION xell_manager_guard() RETURNS trigger AS $$
DECLARE mgr_role text; mgr_prod boolean;
BEGIN
  IF NEW.is_production AND NEW.role <> 'worker' THEN
    RAISE EXCEPTION 'production is not a manager xell';
  END IF;
  IF NEW.manager_xell_id IS NOT NULL THEN
    IF NEW.manager_xell_id = NEW.id THEN RAISE EXCEPTION 'a xell cannot manage itself'; END IF;
    IF NEW.role = 'manager' THEN
      RAISE EXCEPTION 'a manager xell cannot report to another manager (the hierarchy is one level deep)';
    END IF;
    IF NEW.is_production THEN RAISE EXCEPTION 'production cannot be managed by a zee'; END IF;
    SELECT role, is_production INTO mgr_role, mgr_prod FROM xell WHERE id = NEW.manager_xell_id;
    IF mgr_role IS NULL THEN RAISE EXCEPTION 'manager_xell_id names no xell'; END IF;
    IF mgr_role <> 'manager' OR mgr_prod THEN
      RAISE EXCEPTION 'manager_xell_id must name a xell whose role is manager';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS xell_manager_guard_trg ON xell;
CREATE TRIGGER xell_manager_guard_trg
  BEFORE INSERT OR UPDATE ON xell
  FOR EACH ROW EXECUTE FUNCTION xell_manager_guard();

COMMENT ON COLUMN xell.role IS
  'worker (default) or manager. A manager zee dispatches/monitors workers and holds the prod db READ-ONLY; it has zero push/PR access to the xource (landgate, xellgit and zee land all refuse it).';
COMMENT ON COLUMN xell.manager_xell_id IS
  'The manager xell this worker reports to (NULL = unmanaged). One level deep — a manager may not report to a manager.';

-- ── the READ-ONLY production coupling ────────────────────────────────────────
-- A fourth db_coupling: the prod db container IS the xell's assigned database, but its DATABASE_URL
-- carries a read-only ROLE the queenzee provisions on prod (lib/prod-readonly.js). Added here only;
-- per PG12+ semantics nothing in this file may USE the value.
ALTER TYPE db_coupling ADD VALUE IF NOT EXISTS 'db-prod-readonly';

-- The read-only connection string minted for THIS xell (its own `zee_ro_<slug>` role on the prod
-- database, granted SELECT and nothing else). Per-xell rather than one shared reader so a manager's
-- queries are attributable in pg_stat_activity and its access is revocable on its own — the reaper
-- drops the role with the xell. NULL for every other xell, which is all of them by default.
ALTER TABLE xell ADD COLUMN IF NOT EXISTS prod_ro_dsn text;
COMMENT ON COLUMN xell.prod_ro_dsn IS
  'Read-only production DSN minted for this (manager) xell — its own SELECT-only role. Written to .zeehive.env as DATABASE_URL for a db-prod-readonly xell.';

-- ── zee ↔ zee messages (manager ⇄ worker), and the worker's post-ship REFLECTION ──
-- A message is DELIVERED into the recipient's live cxell session (nudge.js sendMessageToXell) AND
-- stored here, so it survives a cxell that was asleep, a zee that has been re-spawned, and a human
-- who wants to read what the fleet said to itself. Both xell references are ON DELETE SET NULL with
-- a stamped slug: a record of what one agent told another outlives a reaped worktree.
CREATE TABLE zee_message (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES project ON DELETE CASCADE,
  from_xell_id  uuid REFERENCES xell ON DELETE SET NULL,
  from_slug     text,
  to_xell_id    uuid REFERENCES xell ON DELETE SET NULL,
  to_slug       text,
  kind          text NOT NULL DEFAULT 'message'
                  CHECK (kind IN ('message','directive','report','reflection')),
  body          text NOT NULL,
  meta          jsonb,
  delivered     boolean NOT NULL DEFAULT false,
  delivery      jsonb,
  read_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX zee_message_to_idx   ON zee_message (to_xell_id, created_at DESC);
CREATE INDEX zee_message_from_idx ON zee_message (from_xell_id, created_at DESC);

COMMENT ON TABLE zee_message IS
  'Agent-to-agent messages (manager ⇄ worker) — delivered into the recipient''s live cxell session and kept here as the durable inbox/audit. kind=reflection is a worker''s post-ship review addressed to its manager.';

-- ── a manager SUGGESTS a xell is done; a human confirms ──────────────────────
-- Deliberately NOT the same thing as `zee done`: that is a zee proposing its OWN completion. This is
-- a manager proposing SOMEONE ELSE'S — so it must never be self-serviceable, and the console asks for
-- a typed confirmation before it marks a xell done and reaps the cxell.
CREATE TABLE done_suggestion (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        uuid NOT NULL REFERENCES project ON DELETE CASCADE,
  manager_xell_id   uuid REFERENCES xell ON DELETE SET NULL,
  manager_slug      text,
  target_xell_id    uuid REFERENCES xell ON DELETE SET NULL,
  target_slug       text,
  reason            text,
  status            text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','approved','rejected','failed')),
  result            jsonb,
  requested_at      timestamptz NOT NULL DEFAULT now(),
  decided_at        timestamptz,
  decided_by        text,
  dismissed_at      timestamptz
);
CREATE INDEX done_suggestion_open_idx ON done_suggestion (project_id, status)
  WHERE status = 'pending' AND dismissed_at IS NULL;

COMMENT ON TABLE done_suggestion IS
  'A manager zee''s suggestion that another xell is finished. A human confirms it in the console (typed confirmation); THAT marks the task done and reaps the cxell. A manager can never mark anything done itself.';

-- ── the manager harness (file-backed, harnesses/manager/) ────────────────────
-- Its manual is a manual OF ITS OWN — not the worker manual with extras: a manager has verbs a
-- worker does not (dispatch/say/inbox/suggest-done) and refusals a worker does not (land/PR), so
-- inheriting the worker law layer would teach it doors it does not have. refreshHarnesses() fills
-- bundle/head_commit/avatar_path from the folder at boot; this row is just the anchor.
INSERT INTO harness (key, label, dir, is_law_core, enabled, avatar_path)
VALUES ('manager', 'Manager Zee', 'harnesses/manager', false, true, 'harnesses/manager/avatar.svg')
ON CONFLICT (key) DO NOTHING;
