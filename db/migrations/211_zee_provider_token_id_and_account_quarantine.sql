-- ATTRIBUTE EVERY ZEE TO THE PROVIDER ACCOUNT IT RAN ON — and make auth-death quarantine possible.
--
-- MEASURED (ticket #50 / live meta-DB): tokenForSpawn picks the newest ACTIVE account of a
-- provider deterministically. An expired OAuth token on that account therefore kills EVERY
-- dispatch on that provider until a human notices — six zees died on a 401 and none of them
-- ever landed anything. The pause machinery (104) and the paused-account skip in tokenForSpawn
-- already exist; what was missing is (a) knowing WHICH account a zee used, so a 401 can be
-- wired back to that row, and (b) recording that fact so per-account burn and per-account
-- failure are answerable in SQL.
--
-- This column is the attribution half. The quarantine + one-sibling failover live in
-- lib/account-quarantine.js and are driven from noteTurnDeath / the spawn failure path; they
-- pause via setProviderAccountPaused (already reversible by a human, never auto-resumed).
--
-- ON DELETE SET NULL: deleting an account must not cascade-delete the zee that ran on it —
-- the burn and the failure history stay attributable as "this zee, account gone". Same shape
-- as zee.runtime_id and the other soft attributions on the row.
--
-- Additive + idempotent. Existing zees read as provider_token_id IS NULL, which is true of
-- every zee that ran before this shipped and is what keeps historical burn queries honest
-- (unknown account, not a wrong one).
ALTER TABLE zee
  ADD COLUMN IF NOT EXISTS provider_token_id uuid REFERENCES provider_token(id) ON DELETE SET NULL;

-- Per-account burn / failure: "how much did account X cost, and how often did it 401?"
CREATE INDEX IF NOT EXISTS zee_provider_token_id_idx
  ON zee (provider_token_id)
  WHERE provider_token_id IS NOT NULL;
