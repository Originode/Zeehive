-- The CAGED-ZEE ↔ QUEENZEE WORKFLOW PROTOCOL (spec: caged zees).
--
-- A caged zee runs `claude --bare` inside a per-xell zee-agent container: no docker CLI, no host
-- filesystem, no skills. The queenzee API is its ONLY door out of the cage. Every "skill" a
-- host-side zee has (land / ship / prod / done / orient) becomes ONE authenticated call to
-- /api/xell/self/*, scoped to the CALLING xell by a per-xell identity token.

-- (1) Per-xell identity token. At cage spawn the queenzee mints a random token, injects the
-- PLAINTEXT into the cage env as ZEEHIVE_XELL_TOKEN, and stores only its SHA-256 HASH here. This is
-- IDENTITY, not a secret the cage must protect (the cage already cannot escape) — it lets the
-- queenzee know WHICH xell is calling and scope every verb to that xell. The plaintext is never
-- stored; a re-caged xell simply mints a fresh one.
ALTER TABLE xell ADD COLUMN IF NOT EXISTS self_token_hash text;

-- One token identifies at most one xell. Partial: the column is NULL for every non-caged xell.
CREATE UNIQUE INDEX IF NOT EXISTS xell_self_token_hash_uq
  ON xell (self_token_hash) WHERE self_token_hash IS NOT NULL;

-- (2) A caged zee can only ASK to be bound to the PRODUCTION stack — it cannot bind itself. Binding
-- grants prod DATA, which HANDOFF treats as a human's call ("hotfix / data xells"). The
-- POST /api/xell/self/prod-request verb records a REQUEST here; a human confirms in the console;
-- only on confirm does the queenzee attachProdStack AND re-seal the cage firewall to allow the prod
-- db host:port. Until confirmed the cage physically cannot reach prod.
CREATE TABLE IF NOT EXISTS prod_bind_request (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  xell_id      uuid NOT NULL REFERENCES xell(id)    ON DELETE CASCADE,
  zee_id       uuid REFERENCES zee(id) ON DELETE SET NULL,
  reason       text,
  status       text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','confirmed','rejected')),
  result       jsonb,
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_at   timestamptz,
  decided_by   text
);
-- At most one OPEN request per xell (the verb upserts against this).
CREATE UNIQUE INDEX IF NOT EXISTS prod_bind_request_open_uq
  ON prod_bind_request (xell_id) WHERE status = 'pending';
