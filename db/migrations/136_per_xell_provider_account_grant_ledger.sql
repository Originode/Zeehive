-- PER-XELL PROVIDER ACCOUNT GRANT — WHICH account a cage was actually granted, per provider.
--
-- The runnable-provider-env door (`zee creds --provider <k> --export`) is gated on a cage being
-- able to prove it already holds a key — a cage spawned before a rotation must not pull the
-- project's CURRENT key on demand (that would defeat the human gate). A masked hint cannot prove
-- possession: it is public in the read model. What CAN prove it is a SERVER-SIDE RECORD of which
-- provider_token account this xell was granted, written at BOTH doors that put a key in a cage:
--
--   * the SPAWN (queenzee/intake.js spawnCxell, where everyProviderEnv + the active env are built);
--   * the INJECTION performer (lib/credential-inject.js runCredentialInject).
--
-- providerRunEnv then answers FROM THIS RECORD, failing closed:
--   * recorded account still connected and active → return ITS env (the cage already holds that
--     key; nothing new is disclosed);
--   * recorded account rotated away / deleted / paused / its key replaced in place → REFUSE,
--     naming the credential-inject card;
--   * NO record at all (every cage spawned before this landed) → REFUSE, same sentence.
--
-- `account_created_at` is the account's created_at AT GRANT TIME. setProviderToken bumps created_at
-- on an in-place replace, so a grant whose stored created_at differs from the row's current one has
-- been replaced under the cage — the cage holds the OLD key, and the door must not hand out the new
-- one. A grant row for a DELETED account cascades away (provider_token ON DELETE CASCADE), which is
-- exactly the "rotated away/deleted" refusal.
--
-- One row per (xell, provider) — a xell is granted at most one account of a provider at a time.
CREATE TABLE IF NOT EXISTS xell_provider_grant (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  xell_id           uuid NOT NULL REFERENCES xell(id) ON DELETE CASCADE,
  provider          text NOT NULL CHECK (provider ~ '^[a-z0-9][a-z0-9-]{0,30}$'),
  provider_token_id uuid NOT NULL REFERENCES provider_token(id) ON DELETE CASCADE,
  account_created_at timestamptz NOT NULL,      -- the account's created_at at grant time
  granted_at        timestamptz NOT NULL DEFAULT now(),
  granted_by        text NOT NULL DEFAULT 'spawn'  -- 'spawn' | 'inject'
);

CREATE UNIQUE INDEX IF NOT EXISTS xell_provider_grant_xell_provider_uq
  ON xell_provider_grant (xell_id, provider);

CREATE INDEX IF NOT EXISTS xell_provider_grant_token_idx
  ON xell_provider_grant (provider_token_id);
