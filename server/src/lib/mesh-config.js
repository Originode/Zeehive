// MESH CONFIG STORE — the mesh, configured in the console (docs/netbird-mesh-plan.md §3.1/§11,
// migration 259). "A human configures the mesh in the console and clicks stand-up — no .env or
// management.json hand-edit anywhere."
//
// This is the seam the card names: the meta-DB row is the source of truth, and it resolves
// STORE → ENV → SHIPPED DEFAULT into the in-process config object (config.js), so every consumer
// downstream (lib/netbird.js's URL/token, the stand-up step's management.json render, the compose
// env) reads plain `config` and never needs to know the console exists. An install that never
// opened the console resolves to exactly its env — the backcompat the card requires. `enabled`
// false means the row is INERT (env rules); a half-filled draft is storable without switching the
// mesh over.
//
// TWO CONTRACTS, both inherited from provider_token (migration 027) because they are the same
// problem — a credential store a UI writes and must never read back:
//   • SECRETS ARE WRITE-ONLY. The four secret columns leave this module through exactly one door
//     (`meshResolvedForPerformer`, used by the stand-up) and every other reader gets a *_hint —
//     the masked head…tail the console renders. No route, no log line and no step detail carries
//     a value.
//   • MINTING IS A HUMAN ACT. `"generate"` as a field value on an authenticated write mints random
//     key material server-side (datastore_encryption_key, relay_auth_secret — the two values
//     NetBird merely needs to be unique). api_token and gateway_setup_key are NOT generatable:
//     they must come from the control plane (the first PAT is bootstrapped by
//     lib/netbird-bootstrap.js; the gateway key is minted in NetBird and pasted in). The
//     "never mint a secret" rule binds the UNATTENDED stand-up, not the click that asks for one.
import { randomBytes } from 'node:crypto';
import { q, one } from '../db/pool.js';
import { config } from '../config.js';
import { logline } from './logbus.js';
import { NETBIRD_MGMT_API_DEFAULT } from './netbird.js';
import { queenzeeHostCtx } from './machines.js';

// The fields a console write may carry. Anything else is refused by name (a typo must never be
// silently dropped): a human who thinks they set the relay secret and didn't is the bug this
// prevents.
export const MESH_FIELDS = [
  'enabled', 'mesh_domain', 'api_url',
  'mgmt_grpc_port', 'mgmt_api_port', 'signal_port', 'relay_port', 'dashboard_port',
  'signal_uri', 'relay_endpoint',
  'datastore_encryption_key', 'relay_auth_secret', 'api_token', 'gateway_setup_key',
];
// The write-only four. Kept in one list so "is this a secret" is answered once.
export const SECRET_FIELDS = ['datastore_encryption_key', 'relay_auth_secret', 'api_token', 'gateway_setup_key'];
// Sending this literal as a secret field's value mints random material server-side. Only these two
// are generatable, for the reason in the header.
export const GENERATABLE_FIELDS = ['datastore_encryption_key', 'relay_auth_secret'];
export const GENERATE = 'generate';
// The console names the management URL `management_url` (web/src/Mesh.jsx's form, TKT-189) and the
// column is `api_url`. One alias, normalized on the way IN and projected on the way OUT — so the
// panel needs no translation layer and this module keeps the column's own name as the canonical one.
const FIELD_ALIASES = { management_url: 'api_url' };
// The management.json placeholders the stand-up refuses. A console paste carrying one is refused at
// write time instead — the same rule, moved to the click that could have created it.
const PLACEHOLDER = /CHANGE-ME/i;

export const PORT_FIELDS = ['mgmt_grpc_port', 'mgmt_api_port', 'signal_port', 'relay_port', 'dashboard_port'];
export const DEFAULT_PORTS = { mgmt_grpc_port: 33073, mgmt_api_port: 33074, signal_port: 10000, relay_port: 33080, dashboard_port: 33081 };
// NetBird's self-hosted default (config.netbirdMeshDomain's fallback, and the schema default).
export const DEFAULT_MESH_DOMAIN = 'netbird.selfhosted';
// The CGNAT /16 a fresh account's peers are numbered out of (what NetBird itself uses for a
// self-hosted install). Only the first PAT bootstrap needs it: it writes the account row by hand.
export const DEFAULT_PEER_NET = '100.64.0.0/16';

// PURE: the masked read model of one secret. A hint exists to be MATCHED against an error message
// ("…f3a1"), never to be guessed from — so it is the tail, plus the scheme prefix for the one value
// where the prefix identifies what the thing IS (a PAT is `nbp_…`).
export function secretHint(field, value) {
  if (value == null || value === '') return null;
  const s = String(value);
  if (s.length <= 8) return '…';
  return field === 'api_token' ? `${s.slice(0, 4)}…${s.slice(-4)}` : `…${s.slice(-4)}`;
}

// PURE: valid base64 of exactly 32 bytes. NetBird's crypt.FieldEncrypt requires it and DIES ON BOOT
// with anything else — the reason the shipped management.json.example's CHANGE-ME placeholder had
// to be found by a live run (docs/netbird-mesh-plan.md §11). Checking it here turns a fatal boot
// into a legible form error.
export function isValidDatastoreKey(v) {
  const s = String(v || '');
  if (!/^[A-Za-z0-9+/]{43}=$/.test(s)) return false;
  const buf = Buffer.from(s, 'base64');
  return buf.length === 32 && buf.toString('base64') === s;
}

// PURE: the two secrets the stand-up must have real values for (management.json's placeholder
// fields). Empty = the render will refuse, and `meshReadiness` below is what tells the console so
// BEFORE the click.
export function meshMissingSecrets(values = {}) {
  const missing = [];
  if (!values.datastore_encryption_key) missing.push('DataStoreEncryptionKey');
  if (!values.relay_auth_secret) missing.push('Relay.Secret');
  return missing;
}

// PURE: a non-secret summary of what a stand-up would do with these values — the console's
// readiness chip, and (on the server side) the same rule the performer enforces.
export function meshReadiness(values = {}) {
  const missing = meshMissingSecrets(values);
  return {
    ready: missing.length === 0,
    missing,
    // A missing api_token is NOT un-ready: the first one is bootstrapped by the stand-up itself,
    // into the store. A missing gateway setup key does not block the three control-plane services
    // (it is the gateway peer's), so it is reported, not required.
    api_token_set: Boolean(values.api_token),
    gateway_setup_key_set: Boolean(values.gateway_setup_key),
  };
}

// Which config.js key each port field comes from, so the env half of the chain is a lookup and
// never a second place the names are spelled.
const PORT_FIELD_CONFIG = {
  mgmt_grpc_port: 'netbirdMgmtGrpcPort',
  mgmt_api_port: 'netbirdMgmtApiPort',
  signal_port: 'netbirdSignalPort',
  relay_port: 'netbirdRelayPort',
  dashboard_port: 'netbirdDashHttpPort',
};

// PURE: the env half of the precedence chain, read from the config seam plus the compose-only vars
// (ports, the gateway key) that ride process.env because they exist only for compose. Exported so a
// test can drive the chain with a table instead of mutating process.env.
export function envSnapshot() {
  return {
    enabled: null,   // the env has no such switch: the mesh is "on" when url+token are both set
    mesh_domain: config.meshDomain || null,
    api_url: config.netbirdApiUrl || null,
    ...Object.fromEntries(PORT_FIELDS.map((f) => [f, config[PORT_FIELD_CONFIG[f]] ?? null])),
    signal_uri: config.netbirdSignalUri || null,
    relay_endpoint: config.netbirdRelayEndpoint || null,
    datastore_encryption_key: config.netbirdDatastoreEncryptionKey || null,
    relay_auth_secret: config.netbirdRelayAuthSecret || null,
    api_token: config.netbirdApiToken || null,
    gateway_setup_key: config.netbirdGatewaySetupKey || null,
  };
}

const pick = (storeVal, envVal, def) => {
  if (storeVal != null && storeVal !== '') return { value: storeVal, source: 'store' };
  if (envVal != null && envVal !== '') return { value: envVal, source: 'env' };
  return { value: def ?? null, source: def != null ? 'default' : 'unset' };
};

// PURE: STORE → ENV → DEFAULT, field by field, each answer carrying where it came from. The whole
// precedence contract lives here; applyMeshConfig below is the side effect and the read model is
// the projection. `enabled` is NOT resolved — it is the console's switch, and the caller decides
// whether to apply at all (a disabled row must not shadow the env).
export function resolveMeshConfig(row, env = envSnapshot()) {
  const r = row || {};
  const out = (f, def = null) => pick(r[f], env[f], def);
  // api_url keeps a THIRD rung the other fields do not need: with the console row enabled and no
  // URL given, the queenzee reaches the plane it just stood up at the compose-internal default.
  const apiUrl = r.api_url ? { value: r.api_url, source: 'store' }
    : env.api_url ? { value: env.api_url, source: 'env' }
      : r.enabled ? { value: NETBIRD_MGMT_API_DEFAULT, source: 'default' }
        : { value: null, source: 'unset' };
  const values = {
    mesh_domain: out('mesh_domain', DEFAULT_MESH_DOMAIN).value,
    api_url: apiUrl.value,
    ...Object.fromEntries(PORT_FIELDS.map((f) => [f, out(f, DEFAULT_PORTS[f]).value])),
    signal_uri: out('signal_uri').value,
    relay_endpoint: out('relay_endpoint').value,
    datastore_encryption_key: out('datastore_encryption_key').value,
    relay_auth_secret: out('relay_auth_secret').value,
    api_token: out('api_token').value,
    gateway_setup_key: out('gateway_setup_key').value,
  };
  const source = {
    mesh_domain: out('mesh_domain', DEFAULT_MESH_DOMAIN).source,
    api_url: apiUrl.source,
    ...Object.fromEntries(PORT_FIELDS.map((f) => [f, out(f, DEFAULT_PORTS[f]).source])),
    signal_uri: out('signal_uri').source,
    relay_endpoint: out('relay_endpoint').source,
    datastore_encryption_key: out('datastore_encryption_key').source,
    relay_auth_secret: out('relay_auth_secret').source,
    api_token: out('api_token').source,
    gateway_setup_key: out('gateway_setup_key').source,
  };
  return { values, source };
}

// The resolved values WITHOUT the secret strings — for anything that leaves the server (routes,
// log lines, step details). Secrets degrade to `{ set, hint }`.
export function publicResolved(resolved) {
  const { values, source } = resolved;
  const safe = { ...values };
  const secrets = {};
  for (const f of SECRET_FIELDS) {
    secrets[f] = { set: Boolean(values[f]), hint: secretHint(f, values[f]) };
    delete safe[f];
  }
  return { values: safe, source, secrets, readiness: meshReadiness(values) };
}

// PURE: the compose environment the stand-up passes to `docker compose` so the ports/domain/secrets
// the human set in the console are the ones the containers are created with — the alternative is
// the install's .env, which is exactly the hand-edit this card removes. Only non-null values ride:
// an unset one must let compose's own `${VAR:-default}` apply rather than be forced empty.
export function composeEnvFor(values = {}) {
  const env = {
    NETBIRD_MGMT_GRPC_PORT: String(values.mgmt_grpc_port),
    NETBIRD_MGMT_API_PORT: String(values.mgmt_api_port),
    NETBIRD_SIGNAL_PORT: String(values.signal_port),
    NETBIRD_RELAY_PORT: String(values.relay_port),
    NETBIRD_DASH_HTTP_PORT: String(values.dashboard_port),
    MESH_DOMAIN: values.mesh_domain,
  };
  if (values.relay_endpoint) env.NETBIRD_RELAY_ENDPOINT = values.relay_endpoint;
  if (values.relay_auth_secret) env.NETBIRD_RELAY_AUTH_SECRET = values.relay_auth_secret;
  if (values.gateway_setup_key) env.NETBIRD_GATEWAY_SETUP_KEY = values.gateway_setup_key;
  if (values.api_url) env.NETBIRD_MGMT_API_URL = values.api_url;
  return env;
}

// ── the writers ──────────────────────────────────────────────────────────────────────────────
function mintDatastoreKey() { return randomBytes(32).toString('base64'); }
function mintRelaySecret() { return randomBytes(32).toString('hex'); }

// PURE-ish validation of ONE incoming secret value (minting happens before it): returns the value
// to store or throws with the reason. Never echoes the value.
function validateSecret(field, value) {
  const s = String(value).trim();
  if (!s) throw new Error(`${field} is empty`);
  if (PLACEHOLDER.test(s)) {
    throw new Error(`${field} is still the shipped placeholder — ZEEHIVE refuses to store a known `
      + `example secret. Paste a real value, or send "generate" for the two random ones.`);
  }
  if (field === 'datastore_encryption_key' && !isValidDatastoreKey(s)) {
    throw new Error('datastore_encryption_key must be base64 of exactly 32 bytes (44 chars, ending '
      + 'in "=") — NetBird\'s store encryptor refuses anything else and the management container '
      + 'dies on boot with it. Send "generate" to mint a valid one.');
  }
  if (field === 'relay_auth_secret' && s.length < 16) {
    throw new Error('relay_auth_secret is too short — use at least 16 characters (send "generate" for a 64-hex one)');
  }
  if (field === 'api_token' && s.length < 20) {
    throw new Error('api_token does not look like a NetBird PAT (nbp_…) — mint one in the control plane, or let the stand-up bootstrap the first one');
  }
  if (field === 'gateway_setup_key' && s.length < 8) {
    throw new Error('gateway_setup_key does not look like a NetBird setup key — mint one in the control plane');
  }
  return s;
}

function validateNonSecret(field, value) {
  switch (field) {
    case 'enabled':
      return value === true || value === false ? value
        : (value === 'true' ? true : value === 'false' ? false : (() => { throw new Error('enabled must be a boolean'); })());
    case 'mesh_domain': {
      const s = String(value).trim();
      if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(s)) {
        throw new Error(`mesh_domain '${s}' is not a DNS name (e.g. netbird.selfhosted)`);
      }
      return s;
    }
    case 'api_url': {
      const s = String(value).trim();
      if (!/^https?:\/\/[^\s]+$/i.test(s)) throw new Error(`api_url '${s}' is not an http(s) URL`);
      return s;
    }
    case 'signal_uri': {
      const s = String(value).trim();
      if (!/^[a-z0-9.[\]:_-]+:\d{1,5}$/i.test(s)) throw new Error(`signal_uri '${s}' is not host:port (e.g. netbird-signal:10000)`);
      return s;
    }
    case 'relay_endpoint': {
      const s = String(value).trim();
      if (!/^(relay:\/\/)?[a-z0-9.[\]:_-]+:\d{1,5}$/i.test(s)) throw new Error(`relay_endpoint '${s}' is not host:port or relay://host:port`);
      return s;
    }
    default: break;
  }
  if (PORT_FIELDS.includes(field)) {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`${field} must be an integer in 1..65535 (got '${value}')`);
    return n;
  }
  throw new Error(`unknown mesh config field '${field}'`);
}

// Turn one incoming patch into the COLUMN updates (and hint updates) to write. Omitted = leave as
// is; null/'' = clear (secrets and the three nullable strings); "generate" = mint (two fields
// only). Validates names and shapes; refuses by name so a console typo is a 400, never a silence.
export function planMeshWrite(patch, current = {}) {
  const cols = {};
  const next = { ...current };
  // Normalize the console's alias first: a canonical key already present wins over its alias.
  const given = patch || {};
  const normalized = { ...given };
  for (const [alias, canonical] of Object.entries(FIELD_ALIASES)) {
    if (alias in given && !(canonical in given)) normalized[canonical] = given[alias];
    delete normalized[alias];
  }
  for (const [field, raw] of Object.entries(normalized)) {
    if (!MESH_FIELDS.includes(field)) throw new Error(`unknown mesh config field '${field}'`);
    if (SECRET_FIELDS.includes(field)) {
      if (raw === GENERATE) {
        if (!GENERATABLE_FIELDS.includes(field)) {
          throw new Error(`${field} cannot be generated server-side — it must be issued by the NetBird `
            + `control plane${field === 'api_token' ? ' (the stand-up step bootstraps the first one)' : ' (mint a setup key and paste it)'}`);
        }
        const minted = field === 'datastore_encryption_key' ? mintDatastoreKey() : mintRelaySecret();
        cols[field] = minted;
        cols[`${field}_hint`] = secretHint(field, minted);
        next[field] = minted;
        continue;
      }
      if (raw == null || raw === '') {
        cols[field] = null;
        cols[`${field}_hint`] = null;
        next[field] = null;
        continue;
      }
      const value = validateSecret(field, raw);
      cols[field] = value;
      cols[`${field}_hint`] = secretHint(field, value);
      next[field] = value;
      continue;
    }
    const nullable = ['api_url', 'signal_uri', 'relay_endpoint'].includes(field);
    if (raw == null || raw === '') {
      if (nullable) { cols[field] = null; next[field] = null; continue; }
      throw new Error(`${field} cannot be cleared — it always has a value (send the one you want)`);
    }
    const value = validateNonSecret(field, raw);
    cols[field] = value;
    next[field] = value;
  }
  // Cross-field: the five published ports must not collide with each other (a self-inflicted
  // "port is already allocated" at stand-up time is worth catching at the click).
  const ports = PORT_FIELDS.map((f) => next[f] ?? DEFAULT_PORTS[f]);
  if (new Set(ports).size !== ports.length) {
    throw new Error(`two mesh ports are the same (${ports.join(', ')}) — each of ` + `${PORT_FIELDS.join(', ')} must be distinct`);
  }
  return { cols, next };
}

// THE WRITE. Upserts the machine's row from a console patch and makes the result live in this
// process immediately (applyMeshConfig), so the next stand-up click already sees it.
export async function setMeshConfig(machineId, patch = {}, { actor = 'human@console' } = {}) {
  if (!machineId) throw new Error('machine id required');
  const machine = await one(`SELECT id, key FROM machine WHERE id=$1`, [machineId]);
  if (!machine) throw new Error('machine not found');
  const row = (await one(`SELECT * FROM mesh_config WHERE machine_id=$1`, [machineId])) || {};
  const { cols } = planMeshWrite(patch, row);
  // A console write that CARRIES a configuration ENABLES this machine's mesh. The row a human fills
  // in is a decision, not a draft (the panel has no separate "on" switch), and a row left disabled
  // would make the stand-up's bootstrapped PAT inert — the one outcome §1 forbids. An explicit
  // `enabled` in the patch always wins, and an UPDATE never flips it.
  if (!row.machine_id && !('enabled' in (patch || {}))) cols.enabled = true;
  const fields = Object.keys(cols);
  if (!fields.length) return meshConfigFor(machineId);
  const sets = fields.map((f, i) => `"${f}" = $${i + 3}`).join(', ');
  await q(
    `INSERT INTO mesh_config (machine_id, ${fields.map((f) => `"${f}"`).join(', ')}, updated_at, updated_by)
     VALUES ($1, ${fields.map((_, i) => `$${i + 3}`).join(', ')}, now(), $2)
     ON CONFLICT (machine_id) DO UPDATE SET ${sets}, updated_at = now(), updated_by = $2`,
    [machineId, actor, ...fields.map((f) => cols[f])]);
  const applied = await applyMeshConfig({ machineId });
  logline('mesh', `mesh config updated for machine ${machine.key} by ${actor}: `
    + `${fields.map((f) => (SECRET_FIELDS.includes(f) ? `${f}=<set>` : `${f}=${cols[f]}`)).join(', ')}`
    + (applied.applied ? '' : ` (not applied: ${applied.reason})`));
  return meshConfigFor(machineId);
}

// The first-PAT bootstrap's write (lib/netbird-bootstrap.js): record the token the stand-up just
// minted IN the control plane, snapshotting the values the plane was actually stood up with so the
// new row does not silently re-default a port or domain the install's env had set. A row created
// here is ENABLED — the human click that stood the plane up is the act that makes it this machine's
// mesh, and leaving the token inert would be the one outcome the card forbids.
export async function recordBootstrappedPat(machineId, token, { actor = 'stand-up@queenzee', values = null } = {}) {
  const existing = await one(`SELECT machine_id, enabled FROM mesh_config WHERE machine_id=$1`, [machineId]);
  const resolved = values || resolveMeshConfig({ enabled: true }, envSnapshot()).values;
  const patch = { api_token: token };
  if (!existing) {
    patch.enabled = true;
    patch.mesh_domain = resolved.mesh_domain;
    if (resolved.api_url) patch.api_url = resolved.api_url;
    for (const f of PORT_FIELDS) patch[f] = resolved[f];
    if (resolved.signal_uri) patch.signal_uri = resolved.signal_uri;
    if (resolved.relay_endpoint) patch.relay_endpoint = resolved.relay_endpoint;
    if (resolved.datastore_encryption_key) patch.datastore_encryption_key = resolved.datastore_encryption_key;
    if (resolved.relay_auth_secret) patch.relay_auth_secret = resolved.relay_auth_secret;
  }
  await setMeshConfig(machineId, patch, { actor });
  return meshConfigFor(machineId);
}

// ── the applier (the config.js seam) ─────────────────────────────────────────────────────────
// Store-over-env into the live config object. Called at boot (server/src/index.js) and after every
// write. NEVER throws: a database that has not applied migration 259 (or is briefly unreachable)
// must leave the env the install already had, not take the server down.
export async function applyMeshConfig({ machineId = null } = {}) {
  try {
    const row = machineId
      ? await one(`SELECT * FROM mesh_config WHERE machine_id=$1`, [machineId])
      : await activeMeshRow();
    const resolved = resolveMeshConfig(row, envSnapshot());
    if (!row || !row.enabled) {
      const reason = row ? 'the console config for this machine is disabled (env rules)'
        : 'no console mesh config — using the operator env';
      return { applied: false, reason, resolved: publicResolved(resolved) };
    }
    const v = resolved.values;
    const seam = {
      netbirdApiUrl: v.api_url,
      netbirdApiToken: v.api_token,
      meshDomain: v.mesh_domain,
      netbirdSignalUri: v.signal_uri,
      netbirdRelayEndpoint: v.relay_endpoint,
      netbirdDatastoreEncryptionKey: v.datastore_encryption_key,
      netbirdRelayAuthSecret: v.relay_auth_secret,
      netbirdGatewaySetupKey: v.gateway_setup_key,
      netbirdMgmtGrpcPort: v.mgmt_grpc_port,
      netbirdMgmtApiPort: v.mgmt_api_port,
      netbirdSignalPort: v.signal_port,
      netbirdRelayPort: v.relay_port,
      netbirdDashHttpPort: v.dashboard_port,
    };
    for (const [k, val] of Object.entries(seam)) if (val != null) config[k] = val;
    logline('mesh', `mesh config applied from the console for machine ${row.machine_id}: `
      + `domain ${v.mesh_domain}, api ${v.api_url}, token ${v.api_token ? 'from store' : 'unset'}`);
    return { applied: true, resolved: publicResolved(resolved) };
  } catch (e) {
    logline('mesh', `could not apply the console mesh config (${String(e.message).slice(0, 160)})`);
    return { applied: false, reason: e.message };
  }
}

// WHICH row answers for "the mesh this queenzee uses" when no machine was named: the queenzee-host
// machine's row (the control plane lives on the queenzee's own docker context — queenzeeHostCtx),
// else the most recently updated enabled row. The fallback keeps boot working when a machine key
// (and so its row's machine_id) is re-created; the console always names a machine explicitly, so a
// multi-plane install never resolves through this.
async function activeMeshRow() {
  const host = await one(
    `SELECT c.* FROM mesh_config c JOIN machine m ON m.id = c.machine_id
      WHERE m.docker_ctx = $1 AND c.enabled = true
      ORDER BY c.updated_at DESC LIMIT 1`, [queenzeeHostCtx()]);
  if (host) return host;
  return one(`SELECT * FROM mesh_config WHERE enabled = true ORDER BY updated_at DESC LIMIT 1`);
}

// ── the read model (hints out, never a secret) ────────────────────────────────────────────────
// `resolved` is what the queenzee would use RIGHT NOW (store→env→default against the live config);
// `values` is what the ROW holds. They differ exactly when the env is doing the work — which is
// the question a human looking at an empty form is asking.
export async function meshConfigFor(machineId) {
  const machine = await one(`SELECT id, key, docker_ctx FROM machine WHERE id=$1`, [machineId]);
  if (!machine) throw new Error('machine not found');
  const row = (await one(`SELECT * FROM mesh_config WHERE machine_id=$1`, [machineId])) || {};
  const resolved = resolveMeshConfig(row, envSnapshot());
  const hintOf = (f) => secretHint(f, row[f]);
  return {
    machine_id: machineId,
    machine_key: machine.key,
    docker_ctx: machine.docker_ctx,
    is_queenzee_host: machine.docker_ctx === queenzeeHostCtx(),
    configured: Boolean(row.machine_id),
    // The console's switch and the honest "is it live" answer. A row can exist, be enabled, and
    // still not be applied when no writer has run yet in this process (there is no such state:
    // every write applies; boot applies) — so applied tracks enabled.
    enabled: Boolean(row.enabled),
    applied: Boolean(row.enabled),
    values: {
      mesh_domain: row.mesh_domain ?? DEFAULT_MESH_DOMAIN,
      api_url: row.api_url ?? null,
      ...Object.fromEntries(PORT_FIELDS.map((f) => [f, row[f] ?? DEFAULT_PORTS[f]])),
      signal_uri: row.signal_uri ?? null,
      relay_endpoint: row.relay_endpoint ?? null,
    },
    // The CONSOLE's projection of the row: its four form fields under its own names, so the panel
    // binds `fields[k]` directly (web/src/Mesh.jsx). `values` above stays canonical.
    fields: {
      management_url: row.api_url ?? null,
      mesh_domain: row.mesh_domain ?? DEFAULT_MESH_DOMAIN,
      signal_uri: row.signal_uri ?? null,
      relay_endpoint: row.relay_endpoint ?? null,
    },
    // Write-only: nothing here is the secret. `set` is what a form needs to say "leave as is".
    secrets: Object.fromEntries(SECRET_FIELDS.map((f) => [f, { set: Boolean(row[f]), hint: hintOf(f) }])),
    resolved: publicResolved(resolved),
    updated_at: row.updated_at ?? null,
    updated_by: row.updated_by ?? null,
  };
}

// The PERFORMER's read: the resolved values INCLUDING the secrets, for the one consumer that must
// have them (the stand-up renders management.json and compose env from here). Not a route — the
// API layer must never call this. Returns { enabled, values, source, resolved } where `enabled` is
// the console's switch (an env-only install is `enabled: false` and still has usable values).
export async function meshResolvedForPerformer(machineId) {
  const row = machineId
    ? await one(`SELECT * FROM mesh_config WHERE machine_id=$1`, [machineId])
    : await activeMeshRow();
  const resolved = resolveMeshConfig(row, envSnapshot());
  return { enabled: Boolean(row?.enabled), values: resolved.values, source: resolved.source, resolved };
}
