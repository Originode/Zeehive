-- MESH CONFIG STORE — the mesh, configured in the console instead of hand-edited on the host
-- (docs/netbird-mesh-plan.md §3.1/§11; the "nothing but a click" half of NOT-done #1).
--
-- Standing the control plane up used to end with a human hand-editing three things: netbird/
-- management.json (its datastore encryption key + relay secret), the install's .env (ports,
-- domain, NETBIRD_API_URL/TOKEN/NETBIRD_GATEWAY_SETUP_KEY), and the NetBird datastore itself
-- (which, under IdpManagerConfig.ManagerType "none", has NO supported way to create its first
-- account/user/PAT — the human deploy finding §11 records). The card that created this table is
-- "a human configures the mesh in the console and clicks stand-up — no .env or management.json
-- hand-edit anywhere". This is where the console's half of that lives.
--
-- ONE ROW PER MACHINE (machine_id is the primary key): the control plane lives on the queenzee's
-- OWN docker context (queenzeeHostCtx, lib/machines.js), so in practice one row — but the console
-- configures it from a machine card, and a second machine connected to the same plane (or a
-- future second plane) must be able to carry its own row. machine_id ON DELETE CASCADE: a machine
-- row's removal takes its mesh config with it (the credentials are that machine's).
--
-- STORE OVER ENV, ENV STILL HONORED (the backcompat the card requires): lib/mesh-config.js reads
-- this row, then the operator's env, then the shipped default, and writes the winner into the
-- in-process config seam (config.js). So an install that never opened the console behaves exactly
-- as it did before this table existed, and opening the console is what takes over — field by
-- field, not all-or-nothing. `enabled = false` means "ignore this row entirely, use env" (a
-- half-filled draft is storable without switching the mesh over).
--
-- SECRETS ARE WRITE-ONLY. The four secret columns are paired with a *_hint column that carries the
-- masked read model the console shows (the provider_token.token_hint precedent, migration 027);
-- no GET ever returns the value. Three of them may be minted SERVER-SIDE on an authenticated human
-- write by sending the literal "generate" (migration-time docs, lib/mesh-config.js): the datastore
-- encryption key and the relay auth secret are random material NetBird merely needs to be unique,
-- and minting them on a human's click IS a human act — the "never mint a secret" rule binds the
-- UNATTENDED stand-up/performer, not the click that asks for one. api_token and gateway_setup_key
-- are NOT generatable: they must be real credentials the control plane issued (the api_token is
-- bootstrapped for the first time by the stand-up step itself, netbird-bootstrap.js, and is stored
-- here; the gateway setup key is minted by NetBird and pasted in).
CREATE TABLE IF NOT EXISTS mesh_config (
  machine_id                uuid PRIMARY KEY REFERENCES machine(id) ON DELETE CASCADE,
  -- The console's intent flag. false = this row is inert (env rules); see the header.
  enabled                   boolean NOT NULL DEFAULT false,
  -- What the control plane and its peers live under (management.json + meshFqdn's suffix).
  mesh_domain               text NOT NULL DEFAULT 'netbird.selfhosted',
  -- How the queenzee itself reaches the management REST API. NULL = the compose-internal default
  -- (lib/netbird.js NETBIRD_MGMT_API_DEFAULT, https://netbird-management:443) once enabled.
  api_url                   text,
  -- The control plane's published ports (docker-compose.bootstrap.yml's mesh profile defaults).
  -- Stored so the stand-up can pass them to compose and render management.json from ONE source
  -- instead of hoping the install's .env carries them.
  mgmt_grpc_port            int NOT NULL DEFAULT 33073,
  mgmt_api_port             int NOT NULL DEFAULT 33074,
  signal_port               int NOT NULL DEFAULT 10000,
  relay_port                int NOT NULL DEFAULT 33080,
  dashboard_port            int NOT NULL DEFAULT 33081,
  -- management.json's Signal.URI / Relay.Addresses. NULL = the shipped example's value.
  signal_uri               text,
  relay_endpoint           text,
  -- SECRETS (write-only; *_hint is the masked read model).
  datastore_encryption_key     text,
  datastore_encryption_key_hint text,
  relay_auth_secret            text,
  relay_auth_secret_hint       text,
  api_token                    text,
  api_token_hint               text,
  gateway_setup_key            text,
  gateway_setup_key_hint       text,
  updated_at                timestamptz NOT NULL DEFAULT now(),
  updated_by                text,
  CONSTRAINT mesh_config_ports CHECK (
    mgmt_grpc_port BETWEEN 1 AND 65535 AND mgmt_api_port BETWEEN 1 AND 65535 AND
    signal_port BETWEEN 1 AND 65535 AND relay_port BETWEEN 1 AND 65535 AND
    dashboard_port BETWEEN 1 AND 65535
  )
);

COMMENT ON TABLE mesh_config IS
  'Per-machine mesh/control-plane configuration written from the console (docs/netbird-mesh-plan.md '
  '§3.1): store-over-env precedence into the config seam, write-only secrets with hints. The '
  'stand-up step (lib/build-bootstrap.js) and the first-PAT bootstrap (lib/netbird-bootstrap.js) '
  'consume it; lib/mesh-config.js is the only reader/writer.';
COMMENT ON COLUMN mesh_config.api_token IS
  'The management API PAT the queenzee uses. Write-only: read models expose api_token_hint only. '
  'First written by the stand-up step''s one-time PAT bootstrap (netbird-bootstrap.js).';
COMMENT ON COLUMN mesh_config.datastore_encryption_key IS
  'management.json DataStoreEncryptionKey + the AES-256-GCM key netbird-bootstrap.js encrypts the '
  'seeded first user''s name/email with. Write-only; may be minted server-side on a human write.';
