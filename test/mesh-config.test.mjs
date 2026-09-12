// THE MESH CONFIG STORE + THE FIRST-PAT BOOTSTRAP (docs/netbird-mesh-plan.md §3.1/§11, migration
// 259) — the offline half. "A human configures the mesh in the console and clicks stand-up — no
// .env or management.json hand-edit anywhere."
//
// NO DATABASE IS NEEDED HERE, deliberately: this file covers everything that is pure or filesystem-
// bound, so it runs in any cage with no postgres and no docker. The db-backed half (the real
// mesh_config row, applyMeshConfig, the routes) is test/mesh-config-store.test.mjs, and the REAL
// v0.78.1 management binary is test/netbird-live-api.test.mjs — which now drives seedFirstPat
// itself rather than its own copy of the seed.
//
// Covered here:
//   • precedence is store → env → default, field by field, with the source named
//   • an env-only install resolves to exactly its env (the backcompat the card requires)
//   • secrets are write-only: the public read model carries hints, never values
//   • "generate" mints a VALID base64 32-byte datastore key / a 64-hex relay secret, server-side
//   • a CHANGE-ME paste is refused, an invalid datastore key is refused (NetBird dies on one),
//     api_token/gateway_setup_key can NOT be generated (the plane issues them), unknown fields and
//     colliding ports are refused by name
//   • the PAT format is NetBird's own: nbp_ + 30 chars + 6 base62(crc32) chars, and the store keeps
//     base64(sha256(token))
//   • the version guard: any tag other than the pin (or none) refuses, and does so BEFORE anything
//     is stopped or written
//   • seedFirstPat against a real sqlite store: idempotent (an existing account is reported, never
//     overwritten), legible on a store with no schema, and it encrypts the user's name/email with
//     the control plane's own key (AES-256-GCM, decryptable with that key)
//   • bootstrapFirstPat's whole docker sequence against a fake adapter: inspect → stop → cp out →
//     seed → cp back (0666, so the container's uid can WRITE the store) → start → probe; a failure
//     after the stop ALWAYS restarts the plane
import { mkdtempSync, readFileSync, rmSync, statSync, copyFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDecipheriv, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const { config } = await import('../server/src/config.js');
const mc = await import('../server/src/lib/mesh-config.js');
const nb = await import('../server/src/lib/netbird-bootstrap.js');
const { PINNED_NETBIRD_VERSION } = await import('../server/src/lib/netbird.js');

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };
const throws = (fn, re, m) => {
  try { fn(); ok(false, `${m} (nothing was thrown)`); }
  catch (e) { ok(re.test(e.message), `${m} — ${e.message}`); }
};
const tmp = [];
const mkTmp = () => { const d = mkdtempSync(join(tmpdir(), 'zeehive-mesh-cfg-')); tmp.push(d); return d; };
const section = (s) => console.log(`\n── ${s} ──`);

const DATA_KEY = Buffer.alloc(32, 7).toString('base64');

// ── the pure half ───────────────────────────────────────────────────────────────────────────
section('precedence: store → env → default, with the source named');
{
  const env = { ...mc.envSnapshot(), mesh_domain: 'env.example', api_url: null, datastore_encryption_key: null };
  for (const f of mc.PORT_FIELDS) env[f] = null;   // a stock install that never set a port
  const row = { enabled: true, mesh_domain: 'store.example', mgmt_api_port: 4443, api_token: 'nbp_store' };
  const r = mc.resolveMeshConfig(row, env);
  ok(r.values.mesh_domain === 'store.example' && r.source.mesh_domain === 'store', 'a stored domain beats the env');
  ok(r.values.mgmt_api_port === 4443 && r.source.mgmt_api_port === 'store', 'a stored port beats the env default');
  ok(r.values.mgmt_grpc_port === 33073 && r.source.mgmt_grpc_port === 'default', 'an untouched port falls to the compose default');
  ok(r.values.datastore_encryption_key === null && r.source.datastore_encryption_key === 'unset', 'a secret nobody set reads as unset');
  const draft = mc.resolveMeshConfig({ mesh_domain: 'draft.example' }, env);
  ok(draft.values.api_url === null && draft.source.api_url === 'unset',
     'a disabled draft invents no api_url (applyMeshConfig leaves the env alone)');
  ok(draft.values.mesh_domain === 'draft.example', 'though what the draft holds is still readable');

  const envOnly = mc.resolveMeshConfig({}, { ...mc.envSnapshot(), api_url: 'https://plane.example', api_token: 'nbp_env', mesh_domain: 'env.example' });
  ok(envOnly.values.api_url === 'https://plane.example' && envOnly.values.api_token === 'nbp_env',
     'an install with no console row resolves to exactly its env');
  const enabledNoUrl = mc.resolveMeshConfig({ enabled: true }, mc.envSnapshot());
  ok(enabledNoUrl.values.api_url === 'https://netbird-management:443' && enabledNoUrl.source.api_url === 'default',
     'an enabled console row with no URL gets the compose-internal default');
}
section('secrets are write-only in the read model');
{
  const pub = mc.publicResolved({ values: { api_token: 'nbp_abcdefghij', datastore_encryption_key: DATA_KEY, mesh_domain: 'x.y' },
                                   source: { api_token: 'store' } });
  ok(!('api_token' in pub.values) && !('datastore_encryption_key' in pub.values), 'no secret value survives publicResolved');
  ok(pub.secrets.api_token.hint === 'nbp_…ghij' && pub.secrets.datastore_encryption_key.hint === `…${DATA_KEY.slice(-4)}`,
     `hints are masked head/tail: ${pub.secrets.api_token.hint} / ${pub.secrets.datastore_encryption_key.hint}`);
  ok(JSON.stringify(pub).includes('abcdefghij') === false, 'the raw token appears nowhere in the public model');
  ok(mc.meshReadiness({ datastore_encryption_key: DATA_KEY }).ready === false
     && mc.meshReadiness({ datastore_encryption_key: DATA_KEY }).missing.join() === 'Relay.Secret',
     'readiness names the missing management.json secret BEFORE the click');
}
section('"generate" mints valid material server-side; placeholders and bad shapes are refused');
{
  const { cols } = mc.planMeshWrite({ datastore_encryption_key: 'generate', relay_auth_secret: 'generate', api_token: '', mesh_domain: 'mesh.example' });
  ok(mc.isValidDatastoreKey(cols.datastore_encryption_key), `the minted datastore key IS base64 of 32 bytes (${cols.datastore_encryption_key})`);
  ok(cols.datastore_encryption_key_hint === `…${cols.datastore_encryption_key.slice(-4)}`, 'and its hint is the masked tail');
  ok(/^[0-9a-f]{64}$/.test(cols.relay_auth_secret), 'the minted relay secret is 64 hex chars');
  ok(cols.api_token === null && cols.api_token_hint === null, 'an empty api_token clears it (rotation)');
  throws(() => mc.planMeshWrite({ api_token: 'generate' }), /cannot be generated server-side/,
    'api_token cannot be generated — only the control plane issues one');
  throws(() => mc.planMeshWrite({ gateway_setup_key: 'generate' }), /cannot be generated server-side/,
    'gateway_setup_key cannot be generated either');
  throws(() => mc.planMeshWrite({ datastore_encryption_key: 'CHANGE-ME-32-byte-datastore-encryption-key' }),
    /placeholder/, 'a CHANGE-ME datastore key is refused at write time, not at boot');
  throws(() => mc.planMeshWrite({ datastore_encryption_key: Buffer.alloc(16).toString('base64') }),
    /base64 of exactly 32 bytes/, 'a 16-byte key is refused (NetBird dies on boot with one)');
  throws(() => mc.planMeshWrite({ relay_auth_secret: 'short' }), /too short/, 'a 5-char relay secret is refused');
  throws(() => mc.planMeshWrite({ mesh_domain: 'not a domain' }), /not a DNS name/, 'a malformed domain is refused');
  throws(() => mc.planMeshWrite({ mgmt_api_port: 70000 }), /1\.\.65535/, 'an out-of-range port is refused');
  throws(() => mc.planMeshWrite({ mgmt_api_port: 10000, signal_port: 10000 }), /two mesh ports are the same/,
    'two ports on the same number are refused before compose ever says "already allocated"');
  throws(() => mc.planMeshWrite({ mesh_domian: 'typo.example' }), /unknown mesh config field/,
    'a typo is refused BY NAME — never silently dropped');
  ok(!('api_url' in mc.planMeshWrite({}).cols), 'an omitted field is left exactly as it was');
  const cleared = mc.planMeshWrite({ api_url: null }).cols;
  ok(cleared.api_url === null, 'null clears a nullable string');
}
section('the compose env the stand-up passes');
{
  const env = mc.composeEnvFor({ ...mc.DEFAULT_PORTS, mesh_domain: 'm.example', relay_auth_secret: 'x'.repeat(32), api_url: 'https://p:443' });
  ok(env.NETBIRD_MGMT_API_PORT === '33074' && env.MESH_DOMAIN === 'm.example', 'ports and domain ride to compose');
  ok(env.NETBIRD_RELAY_AUTH_SECRET === 'x'.repeat(32) && env.NETBIRD_MGMT_API_URL === 'https://p:443',
     'the secrets compose needs ride as ENV, never as argv');
  ok(env.NETBIRD_GATEWAY_SETUP_KEY === undefined, 'an unset gateway key is not forced empty — compose\'s own default applies');
}

// ── PAT format + the version guard ──────────────────────────────────────────────────────────
section('the PAT format is NetBird\'s own');
{
  const { token, hashed } = nb.mintPat();
  ok(/^nbp_[0-9A-Za-z]{30}[0-9A-Za-z]{6}$/.test(token) && token.length === 40, `nbp_ + 30 + 6 = 40 chars (${token.slice(0, 8)}…)`);
  const secret = token.slice(4, 34);
  let n = nb.crc32(Buffer.from(secret, 'utf8'));
  const A = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  let enc = '';
  while (n > 0) { enc = A[n % 62] + enc; n = Math.floor(n / 62); }
  ok(token.slice(34) === enc, 'the trailing 6 chars are base62(crc32(secret))');
  ok(hashed === createHash('sha256').update(token).digest('base64'), 'the stored form is base64(sha256(token))');
  ok(nb.xid().length === 20 && /^[0-9a-v]{20}$/.test(nb.xid()), 'ids are xid-shaped (20 base32-hex chars)');
  ok(nb.ipv4Net('100.64.0.0/16') === JSON.stringify({ IP: '100.64.0.0', Mask: Buffer.from([255, 255, 0, 0]).toString('base64') }),
     'the account net is written in the server\'s own {IP,Mask} shape');
}
section('the version pin guards the store-shape knowledge');
{
  ok(nb.parseImageTag('netbirdio/management:0.78.1') === '0.78.1', 'the tag is read off the image ref');
  ok(nb.parseImageTag('registry.local:5000/netbirdio/management:0.78.1') === '0.78.1', 'a registry host with a port is not mistaken for the tag');
  ok(nb.parseImageTag('netbirdio/management') === null && nb.versionRefusal(nb.parseImageTag('netbirdio/management')) !== null,
     'an untagged image refuses rather than passing as the pin');
  ok(nb.versionRefusal('0.78.1') === null, `v${PINNED_NETBIRD_VERSION} passes`);
  ok(/v0\.79\.0/.test(nb.versionRefusal('0.79.0')) && /v0\.78\.1/.test(nb.versionRefusal('0.79.0')),
     'another version refuses, naming BOTH what is running and the pin');
  ok(nb.versionRefusal(nb.parseImageTag('netbirdio/management@sha256:deadbeef')) !== null,
     'a digest-pinned reference refuses too (the pin is a tag, not a digest)');
}

// ── seedFirstPat against a real sqlite file ─────────────────────────────────────────────────
// A FIXTURE schema: only the tables/columns the seeder writes. It is deliberately not a copy of the
// real one — the live suite proves the pinned server's schema accepts these exact statements.
const SCHEMA = [
  `CREATE TABLE accounts (id text PRIMARY KEY, created_by text, created_at text, domain text,
     domain_category text, is_domain_primary_account int, network_identifier text, network_net text,
     network_net_v6 text, network_serial int, settings_groups_propagation_enabled int,
     settings_jwt_groups_enabled int, settings_peer_login_expiration_enabled int,
     settings_peer_inactivity_expiration_enabled int, settings_ipv6_enabled_groups text)`,
  `CREATE TABLE users (id text PRIMARY KEY, account_id text, role text, is_service_user int,
     non_deletable int, blocked int, pending_approval int, created_at text, issued text, name text, email text)`,
  `CREATE TABLE groups (id text PRIMARY KEY, account_id text, name text, issued text)`,
  `CREATE TABLE policies (id text PRIMARY KEY, account_id text, name text, description text, enabled int)`,
  `CREATE TABLE policy_rules (id text PRIMARY KEY, policy_id text, name text, description text,
     enabled int, action text, destinations text, sources text, bidirectional int, protocol text, ports text)`,
  `CREATE TABLE personal_access_tokens (id text PRIMARY KEY, user_id text, name text, hashed_token text,
     expiration_date text, created_by text, created_at text)`,
];
function fixtureStore(path, { withSchema = true, accounts = 0 } = {}) {
  const db = new DatabaseSync(path);
  if (withSchema) {
    for (const s of SCHEMA) db.exec(s);
    for (let i = 0; i < accounts; i++) db.prepare(`INSERT INTO accounts (id) VALUES (?)`).run(`acct${i}`);
  }
  db.close();
  return path;
}
const open = (p) => { const db = new DatabaseSync(p); return db; };
const decrypt = (blob, keyB64) => {
  const b = Buffer.from(blob, 'base64');
  const d = createDecipheriv('aes-256-gcm', Buffer.from(keyB64, 'base64'), b.subarray(0, 12));
  d.setAuthTag(b.subarray(b.length - 16));
  return Buffer.concat([d.update(b.subarray(12, b.length - 16)), d.final()]).toString('utf8');
};

section('seedFirstPat — the version guard fires before anything is opened');
{
  const p = fixtureStore(join(mkTmp(), 'store.db'));
  const r = await nb.seedFirstPat(p, { version: '0.79.0', dataKey: DATA_KEY });
  ok(r.ok === false && r.refused === true && /v0\.78\.1/.test(r.reason), 'a wrong version refuses, naming the pin');
  const db = open(p);
  ok(Number(db.prepare(`SELECT count(*) c FROM accounts`).get().c) === 0, 'and wrote NOTHING to the store');
  db.close();
}
section('seedFirstPat — idempotent, legible, and encrypts with the control plane\'s key');
{
  const p = fixtureStore(join(mkTmp(), 'store.db'));
  const r = await nb.seedFirstPat(p, { dataKey: DATA_KEY, clock: new Date('2026-09-12T00:00:00Z') });
  ok(r.ok === true && r.alreadyPresent === false, 'a fresh store is seeded');
  ok(/^nbp_[0-9A-Za-z]{36}$/.test(r.token), 'the returned token is a real PAT');
  const db = open(p);
  const acct = db.prepare(`SELECT * FROM accounts`).get();
  const user = db.prepare(`SELECT * FROM users`).get();
  const pat = db.prepare(`SELECT * FROM personal_access_tokens`).get();
  ok(acct.id === r.accountId && acct.network_identifier === 'zeehive-net' && JSON.parse(acct.network_net).IP === '100.64.0.0',
     'the account row is the server\'s shape, on the CGNAT default');
  ok(user.role === 'owner' && Number(user.non_deletable) === 1, 'the first user is the non-deletable owner');
  ok(user.name !== 'zeehive' && decrypt(user.name, DATA_KEY) === 'zeehive' && decrypt(user.email, DATA_KEY) === 'zeehive@mesh.local',
     'name/email are AES-GCM encrypted with the datastore key, and decrypt back');
  ok(pat.user_id === r.userId && pat.hashed_token === r.hashed, 'the store keeps the HASH, never the token');
  ok(!JSON.stringify([...db.prepare(`SELECT * FROM personal_access_tokens`).all()]).includes(r.token),
     'the plaintext token appears nowhere in the store');
  ok(Number(db.prepare(`SELECT count(*) c FROM groups`).get().c) === 1
     && Number(db.prepare(`SELECT count(*) c FROM policy_rules`).get().c) === 1,
     'the All group + default policy exist (a new account is not a locked-out one)');
  db.close();

  const again = await nb.seedFirstPat(p, { dataKey: DATA_KEY });
  ok(again.ok === true && again.alreadyPresent === true && again.token === null,
     'a second run reports already-present and mints nothing (the first token is unrecoverable by design)');
  ok(/mint a PAT/.test(again.reason), 'and says what a human should do instead');
}
section('seedFirstPat — legible on a store with no schema, or no key');
{
  const p = fixtureStore(join(mkTmp(), 'store.db'), { withSchema: false });
  const r = await nb.seedFirstPat(p, { dataKey: DATA_KEY });
  ok(r.ok === false && /no schema yet/.test(r.reason), 'an unmigrated store is a legible "boot it once first"');
  const p2 = fixtureStore(join(mkTmp(), 'store.db'));
  const r2 = await nb.seedFirstPat(p2, { dataKey: null });
  ok(r2.ok === false && /datastore encryption key/.test(r2.reason), 'no key = a legible refusal (nothing to encrypt the user with)');
  const r3 = await nb.seedFirstPat(join(mkTmp(), 'nope.db'), { dataKey: DATA_KEY });
  ok(r3.ok === false && /no management store/.test(r3.reason),
     'a missing store file is a verdict, never a throw — and never a store sqlite would have CREATED');
}

// ── bootstrapFirstPat: the whole docker sequence, faked ─────────────────────────────────────
function fakeDocker({ imageTag = `netbirdio/management:${PINNED_NETBIRD_VERSION}`, containerStore = null,
                      calls = [], failStop = false, failCpIn = false, onStart = null } = {}) {
  const stub = async (ctx, args) => {
    calls.push(args.join(' '));
    const [cmd] = args;
    if (cmd === 'inspect') return { status: 0, stdout: `${imageTag}\n`, stderr: '' };
    if (cmd === 'stop') return failStop ? { status: 1, stdout: '', stderr: 'No such container' } : { status: 0, stdout: 'zeehive_netbird_management\n', stderr: '' };
    if (cmd === 'cp') {
      const [src, dst] = args.slice(1);
      if (src.startsWith('zeehive_netbird_management:')) { copyFileSync(containerStore, dst); return { status: 0, stdout: '', stderr: '' }; }
      if (failCpIn) return { status: 1, stdout: '', stderr: 'permission denied' };
      copyFileSync(src, containerStore);
      return { status: 0, stdout: '', stderr: '' };
    }
    if (cmd === 'start') { onStart?.(containerStore); return { status: 0, stdout: 'zeehive_netbird_management\n', stderr: '' }; }
    return { status: 0, stdout: '', stderr: '' };
  };
  stub.calls = calls;
  return stub;
}
const probeOk = async () => ({ ok: true, host: 'netbird-management', port: 443, verdict: 'ok' });
const probeDead = async () => ({ ok: false, host: 'netbird-management', port: 443, verdict: 'refused' });

section('bootstrapFirstPat — the happy path, in order');
{
  const dir = mkTmp();
  const containerStore = fixtureStore(join(dir, 'container-store.db'));
  const calls = [];
  const r = await nb.bootstrapFirstPat({
    docker: fakeDocker({ containerStore, calls }), ctx: 'default', dataKey: DATA_KEY,
    storeDir: join(dir, 'scratch'), probe: probeOk, keepScratch: true,
  });
  ok(r.ok === true && /^nbp_/.test(r.token) && r.version === PINNED_NETBIRD_VERSION, `the first PAT was minted (${r.token?.slice(0, 8)}…)`);
  const ops = calls.map((c) => c.split(' ')[0]);
  ok(JSON.stringify(ops) === JSON.stringify(['inspect', 'stop', 'cp', 'cp', 'start']),
     `the sequence is inspect → stop → cp out → cp back → start (${ops.join(' → ')})`);
  // The file handed back inside the container must be WRITABLE by whatever uid the image runs as —
  // docker cp lands it root:root, so the mode is the only lever.
  ok((statSync(containerStore).mode & 0o777) === 0o666, 'the store written back is 0666 — the container\'s uid can WRITE it');
  const db = open(containerStore);
  ok(Number(db.prepare(`SELECT count(*) c FROM personal_access_tokens`).get().c) === 1, 'the control plane\'s store now holds the PAT row');
  ok(Number(db.prepare(`SELECT count(*) c FROM accounts`).get().c) === 1, 'and the first account');
  db.close();
}
section('bootstrapFirstPat — the pin refuses before touching a running plane');
{
  const dir = mkTmp();
  const containerStore = fixtureStore(join(dir, 'container-store.db'));
  const calls = [];
  const r = await nb.bootstrapFirstPat({
    docker: fakeDocker({ containerStore, calls, imageTag: 'netbirdio/management:0.79.0' }),
    ctx: 'default', dataKey: DATA_KEY, storeDir: join(dir, 'scratch'), probe: probeOk,
  });
  ok(r.ok === false && r.refused === true && r.refused_version === '0.79.0', 'v0.79.0 refuses');
  ok(!calls.some((c) => c.startsWith('stop')), 'and NOTHING was stopped — the guard runs first');
  const db = open(containerStore);
  ok(Number(db.prepare(`SELECT count(*) c FROM accounts`).get().c) === 0, 'nothing was written to the live store');
  db.close();
}
section('bootstrapFirstPat — a failure after the stop always restarts the plane');
{
  const dir = mkTmp();
  const containerStore = fixtureStore(join(dir, 'container-store.db'));
  const calls = [];
  const r = await nb.bootstrapFirstPat({
    docker: fakeDocker({ containerStore, calls, failCpIn: true }), ctx: 'default', dataKey: DATA_KEY,
    storeDir: join(dir, 'scratch'), probe: probeOk,
  });
  ok(r.ok === false && /could not copy the seeded store back/.test(r.reason), 'the write-back failure is named');
  ok(r.restarted === true && calls.includes('start zeehive_netbird_management'), 'the control plane was restarted, not left stopped');
  const noStop = [];
  const r2 = await nb.bootstrapFirstPat({
    docker: fakeDocker({ containerStore, calls: noStop, failStop: true }), ctx: 'default', dataKey: DATA_KEY,
    storeDir: join(dir, 'scratch2'), probe: probeOk,
  });
  ok(r2.ok === false && /could not stop/.test(r2.reason) && r2.restarted === true && !noStop.includes('start zeehive_netbird_management'),
     'a stop that failed is not followed by a start (the plane was never stopped)');
  const r3 = await nb.bootstrapFirstPat({
    docker: fakeDocker({ containerStore, calls: [] }), ctx: 'default', dataKey: DATA_KEY,
    storeDir: join(dir, 'scratch3'), probe: probeDead,
  });
  ok(r3.ok === false && /not answering/.test(r3.reason) && /^nbp_/.test(r3.token),
     'a plane that restarts dead still reports the minted token (it IS in the store)');
}
section('bootstrapFirstPat — an already-configured plane is reported, not overwritten');
{
  const dir = mkTmp();
  const containerStore = fixtureStore(join(dir, 'container-store.db'), { accounts: 1 });
  const before = readFileSync(containerStore);
  const calls = [];
  const r = await nb.bootstrapFirstPat({
    docker: fakeDocker({ containerStore, calls }), ctx: 'default', dataKey: DATA_KEY,
    storeDir: join(dir, 'scratch'), probe: probeOk,
  });
  ok(r.ok === false && r.alreadyPresent === true && /mint a PAT/.test(r.reason), 'an existing account is reported legibly');
  ok(calls.includes('start zeehive_netbird_management'), 'and the plane is restarted');
  ok(Buffer.compare(before, readFileSync(containerStore)) === 0, 'the store came back byte-identical — nothing was clobbered');
}

for (const d of tmp) { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
console.log(`\n${fail ? `${fail} FAILURE(S)` : 'all good'}`);
process.exit(fail ? 1 : 0);
