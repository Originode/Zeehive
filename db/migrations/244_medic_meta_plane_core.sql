-- THE MEDIC LEAVES THE XELL — the meta-plane core (docs/medic-meta-plane-plan.md §3.1, DR-7,
-- provision-proof kit stage 4).
--
-- A medic is an AGENT WITH NO ENVIRONMENT: an in-process loop the queenzee runs (the langchain
-- driver precedent, lib/langchain-zee.js), anchored by THIS row — no xell, no worktree, no cage, no
-- containers, no land gate. The directive, verbatim: "a medic is not to be deployed in a xell. a
-- medic sees and updates meta-db, and deploy zees if needed. make a separate ui for medic hexagons."
--
--   * medic            — placement + status. The zee row under it (245 adds zee.medic_id) stays
--                        authoritative for the running turn, the same xell/zee split the fleet has.
--                        The Medic Bay (web/src/MedicBay.jsx) renders from THESE rows — never from
--                        xells, which is what keeps medics out of the honeycomb structurally.
--   * medic_action     — the audit ledger: every write the medic performs, verbatim, with the rows
--                        affected. The config rows the medic edits carry no history of their own,
--                        so this ledger is the ONLY receipt. It is written by the DRIVER on the
--                        OWNER pool (never by the medic's own role, which holds no grant on it —
--                        the medic cannot forge or trim its own receipts), and a retire keeps it
--                        (no CASCADE from a status change; the row itself outlives the loop).
--
-- token_hash is the medic's GATEWAY identity — the same hash-only discipline as
-- xell.self_token_hash (029, lib/xell-token.js): the plaintext exists only in the driver's memory
-- for the duration of the loop, the gateway resolves the hash, every model call lands in
-- llm_gateway_request like any other.
--
-- Idempotent, additive, forward-only.
CREATE TABLE IF NOT EXISTS medic (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_project_id  uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  condition_id       uuid REFERENCES project_condition(id) ON DELETE SET NULL,
  brief              text NOT NULL,          -- the condition/card verbatim + the dispatch preamble
  status             text NOT NULL DEFAULT 'diagnosing'
                       CHECK (status IN ('diagnosing','acting','awaiting-human',
                                         'worker-dispatched','converged','retired','errored')),
  needs_human_reason text,                   -- the one-line ask when status='awaiting-human'
  token_hash         text,                   -- gateway identity (hash only, xell.self_token_hash discipline)
  created_at         timestamptz NOT NULL DEFAULT now(),
  retired_at         timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS medic_token_hash_uq
  ON medic (token_hash) WHERE token_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS medic_target_idx ON medic (target_project_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS medic_action (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  medic_id      uuid NOT NULL REFERENCES medic(id) ON DELETE CASCADE,
  tool          text NOT NULL,               -- which registry tool ran (meta_write, condition_remove, …)
  statement     text NOT NULL,               -- the exact SQL / verb args, verbatim
  tables        text[] NOT NULL DEFAULT '{}',
  rows_affected int,
  result        jsonb,                       -- the receipt (rowCount, dispatch slug, refusal, …)
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS medic_action_medic_idx ON medic_action (medic_id, created_at);
