// NETBIRD AGAINST A REAL MANAGEMENT SERVER (docs/netbird-mesh-plan.md §9.3 → §11).
//
// The offline suites (netbird-mesh / netbird-policies) drive lib/netbird.js through a faithful
// FAKE adapter — they prove our code's own logic, never the API's shape. This suite is the other
// half: it boots the PINNED NetBird management server on loopback and drives the REAL exported
// functions at it over HTTP. The §9.3 uncertainty was exactly this ("the exact NetBird management
// API surface is unknown"), and the drift it hid was real: our policy rule posted
// `source`/`destination` with no `protocol`, which a real server refuses 422.
//
// WHAT IS PROVEN HERE (a real server, real tokens, real rows):
//   • createSetupKey       → the key lands in the control plane, one-off/ephemeral/usage-limit 1
//   • ensureGroup          → create-then-find is idempotent against the real groups API
//   • listPeers            → the real peer list is an array, and a real peer's `dns_label` is
//                            EXACTLY meshFqdn(hostname, ip) (the <name>-<octet3>-<octet4> rule)
//   • getPeerByHostname    → finds a real peer by `hostname`, and returns null for a stranger
//   • deletePeer           → deletes for real, and a repeat DELETE's 404 counts as alreadyGone
//   • ensurePolicy         → the corrected rule body (sources/destinations/protocol/enabled) is
//                            accepted 200/201, and find-by-name is idempotent
//   • ensurePolicy (no ports) → protocol 'all' with no ports (the API forbids ports on ALL/ICMP)
//   • ensureProdBindMeshPolicy → the narrow xells→prod:<dbPort> grant, verified in the real store
//   • listPolicies         → the real policy shape (rules[].sources/destinations/protocol/ports)
//   • with a meta-DB (DATABASE_URL): mintPeer → markPeerJoined → deregisterXellPeers →
//     sweepOrphanMeshPeers, i.e. every mesh_peer path that ends in a real control-plane DELETE
//   • with a client binary (optional): a REAL netbird agent registers with a setup key OUR client
//     minted — the end-to-end story the whole plan rests on
//
// The server is the pinned build (see PINNED_NETBIRD_VERSION). If it is not on this host the
// suite SKIPS LOUDLY and says how to fetch it — it never fakes a pass:
//     node scripts/fetch-netbird-binaries.mjs          # pin the binaries into the cache
//     node test/netbird-live-api.test.mjs              # and run this
// Or point it at binaries you already have:
//     NETBIRD_BIN_DIR=/path/with/netbird-mgmt NETBIRD_CLIENT_BIN=/path/to/netbird \
//       DATABASE_URL=… node test/netbird-live-api.test.mjs
//
// The FIRST-PRINCIPLES bit: with no IdP (IdpManagerConfig.ManagerType = "none") a real server has
// no way to make its first user or PAT — there is no self-serve endpoint and no CLI for it. So the
// harness seeds the sqlite store exactly as the server's own code writes it: the account + its
// network, a user whose name/email are AES-256-GCM field-encrypted with the datastore key, the
// "All" group + "Default" policy, seeded peers, and a PAT (`nbp_`+secret+base62(crc32(secret)) at
// exactly 6 chars, hashed base64(sha256(plain))). Those shapes were read off the server's source;
// they are as much a part of "prove it against the real thing" as the assertions below.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createHash, createCipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync, createWriteStream } from 'node:fs';
import { once } from 'node:events';
import { tmpdir, homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../server/src/config.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ── the pin (docs/netbird-mesh-plan.md §11) ────────────────────────────────────────────────────
const PINNED_NETBIRD_VERSION = '0.78.1';
const DEFAULT_BIN_DIR = join(homedir(), '.cache', 'zeehive', 'netbird', PINNED_NETBIRD_VERSION);

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };
const section = (t) => console.log(`\n── ${t} ──`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A failed verdict must FAIL an assertion, never crash the harness on `.peers`/`.policies`: the
// reason belongs in the output, and the ok() message template is evaluated even when it is false.
const listOf = (r, key) => (r?.ok && Array.isArray(r[key]) ? r[key] : []);
const why = (r) => (r?.ok ? '' : ` — ${r?.reason || 'no verdict reason'}`);

const firstExisting = (...paths) => paths.find((p) => p && existsSync(p)) || null;
// NETBIRD_BIN_DIR is what scripts/fetch-netbird-binaries.mjs populates (--dir).
const binDir = process.env.NETBIRD_BIN_DIR || DEFAULT_BIN_DIR;
const mgmtBin = firstExisting(process.env.NETBIRD_MGMT_BIN, join(binDir, 'netbird-mgmt'),
  join(binDir, 'go', 'bin', 'netbird-mgmt'));
const clientBin = firstExisting(process.env.NETBIRD_CLIENT_BIN, join(binDir, 'netbird'));

if (!mgmtBin) {
  console.error(`\n  ⚠ SKIPPED — no NetBird management binary (pinned v${PINNED_NETBIRD_VERSION}) on this host.`);
  console.error('    Nothing was asserted. Fetch it, then re-run:');
  console.error('      node scripts/fetch-netbird-binaries.mjs');
  console.error('      node test/netbird-live-api.test.mjs');
  console.error(`    (or set NETBIRD_BIN_DIR=/a/cache/with/${PINNED_NETBIRD_VERSION}, or NETBIRD_MGMT_BIN=/path/to/netbird-mgmt;`);
  console.error(`     looked in ${binDir})\n`);
  process.exit(0);
}
console.log(`\nnetbird-live-api: mgmt=${mgmtBin}`);
console.log(`                  client=${clientBin || '(absent — the real-agent section will skip)'}`);
console.log(`                  version pin: v${PINNED_NETBIRD_VERSION} (docs/netbird-mesh-plan.md §11)`);

// ── port + process plumbing ───────────────────────────────────────────────────────────────────
async function freePort() {
  const srv = createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  return port;
}

async function waitFor(fn, { timeoutMs = 30000, everyMs = 200 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await Promise.resolve().then(fn).catch(() => null);
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) return null;
    await sleep(everyMs);
  }
}

// A 32-byte base64 key: the real field encryptor REQUIRES valid base64 (the shipped
// management.json.example's "CHANGE-ME-…" placeholder is NOT, and the server dies on boot with
// it — a drift this harness made us find; see §11).
const dataKey = randomBytes(32).toString('base64');

const dir = mkdtempSync(join(tmpdir(), 'zeehive-netbird-live-'));
const dataDir = join(dir, 'data');
const cfgPath = join(dir, 'management.json');
const logPath = join(dir, 'management.log');
let apiPort = null;
let metricsPort = null;
const children = [];

function writeConfig() {
  writeFileSync(cfgPath, JSON.stringify({
    Stuns: [],
    TURNConfig: { Turns: [], CredentialsTTL: '12h', TimeBasedCredentials: false },
    Relay: { Addresses: [], CredentialsTTL: '24h', Secret: randomBytes(16).toString('hex') },
    // A signal server we never start: the harness only ever exercises the management REST API.
    Signal: { Proto: 'http', URI: '127.0.0.1:1', Username: '', Password: null },
    ReverseProxy: { TrustedHTTPProxies: [], TrustedHTTPProxiesCount: 0, TrustedPeers: ['0.0.0.0/0'] },
    DisableDefaultPolicy: false,
    Datadir: dataDir,
    DataStoreEncryptionKey: dataKey,
    StoreConfig: { Engine: 'sqlite' },
    HttpConfig: { AuthIssuer: `http://127.0.0.1:${apiPort}` },
    // No IdP manager: the store is the only source of accounts/users (see the header note).
    IdpManagerConfig: { ManagerType: 'none', ClientConfig: null },
    DeviceAuthorizationFlow: { Provider: 'none', ProviderConfig: null },
    PKCEAuthorizationFlow: { ProviderConfig: null },
  }, null, 2));
}

function startMgmt() {
  const child = spawn(mgmtBin, [
    'management', '--config', cfgPath, '--datadir', dataDir,
    '--port', String(apiPort), '--metrics-port', String(metricsPort),
    // The legacy gRPC port (33073) is fixed and would collide with any other NetBird manager on
    // this host. We speak HTTP only — off.
    '--disable-legacy-port',
    // The peer FQDN the server publishes must be the domain our client derives from.
    '--dns-domain', config.meshDomain,
    '--log-file', 'console', '--log-level', 'info',
    '--disable-anonymous-metrics', '--disable-geolite-update',
  ], {
    // Without this the server blocks on a ~32MB GeoLite2 download before listening.
    env: { ...process.env, NB_DISABLE_GEOLOCATION: 'true' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out = createWriteStream(logPath, { flags: 'a' });
  child.stdout.pipe(out);
  child.stderr.pipe(out);
  children.push(child);
  return child;
}

async function stop(child, { graceMs = 5000 } = {}) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const exited = await Promise.race([once(child, 'exit').then(() => true), sleep(graceMs).then(() => false)]);
  if (!exited) child.kill('SIGKILL');
}

// ── the store seed (the shapes the server's own code writes) ───────────────────────────────────
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
function crc32(buf) {
  let c, crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xFF;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xEDB88320 : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
// util/pat: `nbp_` + a 30-char secret + base62(crc32(secret)) LEFT-PADDED WITH SPACES to 6. The
// server decodes that padding, so only a crc encoding that is already 6 base62 chars survives.
function mintPat() {
  for (;;) {
    const secret = randomBytes(64).toString('base64url').replace(/[^0-9A-Za-z]/g, '').slice(0, 30);
    if (secret.length !== 30) continue;
    let n = crc32(Buffer.from(secret, 'utf8'));
    let enc = '';
    while (n > 0) { enc = ALPHABET[n % 62] + enc; n = Math.floor(n / 62); }
    if (enc.length !== 6) continue;
    const token = `nbp_${secret}${enc}`;
    return { token, hashed: createHash('sha256').update(token).digest('base64') };
  }
}
// util/crypt.FieldEncrypt: AES-256-GCM, base64(nonce || ciphertext || tag), 12-byte nonce.
function encryptField(plaintext) {
  const nonce = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', Buffer.from(dataKey, 'base64'), nonce);
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return Buffer.concat([nonce, ct, c.getAuthTag()]).toString('base64');
}

const ACCT = 'e2eliveacct000000000000000000';
const USER = 'e2eliveuser000000000000000000';
const ALL_GROUP = 'e2eliveallgroup0000000000000';
const DEF_POLICY = 'e2elivedefpolicy000000000000';
const SEED_PEERS = [
  // 0: the peer getPeerByHostname/listPeers inspect, then deletePeer deletes for real
  { id: 'seedpeerlive000000000000000000', hostname: 'mesh-e2e-seed', ip: '100.64.171.11' },
  // 1: the peer markPeerJoined caches, then deregisterXellPeers deletes via the real API
  { id: 'seedpeerlive000000000000000001', hostname: 'mesh-e2e-join', ip: '100.64.171.12' },
  // 2: a peer whose mesh_peer row already says removed → sweep deletes it
  { id: 'seedpeerlive000000000000000002', hostname: 'mesh-e2e-removed', ip: '100.64.171.13' },
  // 3: a peer this meta-DB has never heard of → sweep reports it, never deletes it
  { id: 'seedpeerlive000000000000000003', hostname: 'mesh-e2e-orphan', ip: '100.64.171.14' },
];

function seedStore() {
  const db = new DatabaseSync(join(dataDir, 'store.db'));
  const now = new Date().toISOString().replace('T', ' ').replace('Z', '+00:00');
  const netV4 = JSON.stringify({ IP: '100.64.0.0', Mask: Buffer.from([255, 255, 0, 0]).toString('base64') });
  const netV6 = JSON.stringify({
    IP: 'fd00:4e42:1234:5678::',
    Mask: Buffer.concat([Buffer.alloc(8, 0xff), Buffer.alloc(8, 0)]).toString('base64'),
  });
  db.prepare(`INSERT INTO accounts (id, created_by, created_at, domain, domain_category,
      is_domain_primary_account, network_identifier, network_net, network_net_v6, network_serial,
      settings_groups_propagation_enabled, settings_jwt_groups_enabled,
      settings_peer_login_expiration_enabled, settings_peer_inactivity_expiration_enabled)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(ACCT, USER, now, 'e2e.local', 'private', 1, 'e2e-net', netV4, netV6, 0, 1, 0, 0, 0);
  db.prepare(`INSERT INTO users (id, account_id, role, is_service_user, non_deletable, blocked,
      pending_approval, created_at, issued, name, email)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(USER, ACCT, 'owner', 0, 1, 0, 0, now, 'api', encryptField('e2e'), encryptField('e2e@e2e.local'));
  db.prepare(`INSERT INTO groups (id, account_id, name, issued) VALUES (?,?,?,?)`)
    .run(ALL_GROUP, ACCT, 'All', 'api');
  db.prepare(`INSERT INTO policies (id, account_id, name, description, enabled) VALUES (?,?,?,?,?)`)
    .run(DEF_POLICY, ACCT, 'Default', 'This policy allows all traffic between peers (default rule)', 1);
  db.prepare(`INSERT INTO policy_rules (id, policy_id, name, description, enabled, action,
      destinations, sources, bidirectional, protocol, ports)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(DEF_POLICY, DEF_POLICY, 'Default', 'This rule allows all traffic between peers (default rule)',
      1, 'accept', JSON.stringify([ALL_GROUP]), JSON.stringify([ALL_GROUP]), 1, 'all', '[]');
  db.prepare(`UPDATE accounts SET settings_ipv6_enabled_groups=? WHERE id=?`).run(JSON.stringify([ALL_GROUP]), ACCT);

  for (const p of SEED_PEERS) {
    // Every column the real store writes for a peer, with the values a real agent produced (the
    // shape was read off the server's own write, not invented). The dns_label is the real rule:
    // <hostname>-<ipv4 octet3>-<ipv4 octet4> (peer.go getPeerIPDNSLabel); the column stores the
    // bare label, and the API appends ".<dns-domain>" when it answers.
    const o = p.ip.split('.').map(Number);
    const cols = {
      id: p.id, account_id: ACCT, key: randomBytes(32).toString('base64'),
      ip: JSON.stringify(p.ip), ipv6: JSON.stringify('fd00:4e42:1234:5678::1'),
      meta_hostname: p.hostname, meta_go_os: 'linux', meta_kernel: 'Linux', meta_core: '',
      meta_platform: 'x86_64', meta_os: 'Debian GNU/Linux', meta_os_version: '12',
      meta_wt_version: PINNED_NETBIRD_VERSION, meta_ui_version: '', meta_kernel_version: '6.6.0',
      meta_network_addresses: '[]', meta_system_serial_number: '', meta_system_product_name: '',
      meta_system_manufacturer: '', meta_environment: '{}', meta_flags: '{}', meta_files: '[]',
      meta_capabilities: '[]', meta_sync_message_version: 1, proxy_meta_embedded: 0, proxy_meta_cluster: '',
      name: p.hostname, dns_label: `${p.hostname}-${o[2]}-${o[3]}`,
      peer_status_last_seen: now, peer_status_session_started_at: 0, peer_status_connected: 0,
      peer_status_login_expired: 0, peer_status_requires_approval: 0, user_id: '', ssh_key: '',
      ssh_enabled: 0, login_expiration_enabled: 0, inactivity_expiration_enabled: 0,
      last_login: now, created_at: now, ephemeral: 1, location_connection_ip: JSON.stringify('127.0.0.1'),
      location_country_code: '', location_city_name: '', location_geo_name_id: 0,
      extra_dns_labels: null, allow_extra_dns_labels: 0,
    };
    const names = Object.keys(cols);
    db.prepare(`INSERT INTO peers (${names.map((c) => `"${c}"`).join(',')})
      VALUES (${names.map(() => '?').join(',')})`).run(...names.map((c) => cols[c]));
    db.prepare(`INSERT INTO group_peers (group_id, peer_id) VALUES (?,?)`).run(ALL_GROUP, p.id);
  }
  const pat = mintPat();
  db.prepare(`INSERT INTO personal_access_tokens (id, user_id, name, hashed_token, expiration_date,
      created_by, created_at) VALUES (?,?,?,?,?,?,?)`)
    .run('e2elivepat00000000000000000000', USER, 'e2e', pat.hashed, '2030-01-01 00:00:00+00:00', USER, now);
  db.close();
  return pat.token;
}

const cleanups = [];
let child1 = null;
let server = null;

try {
  apiPort = await freePort();
  metricsPort = await freePort();
  writeConfig();

  // ── phase 1: boot once to let the server create + migrate its sqlite store, then stop ───────
  section('harness: boot the real server, seed the store, boot for real');
  child1 = startMgmt();
  const schemaUp = await waitFor(() => {
    if (child1.exitCode !== null) return null;
    if (!existsSync(join(dataDir, 'store.db'))) return null;
    try {
      const db = new DatabaseSync(join(dataDir, 'store.db'));
      const t = db.prepare(`SELECT count(*) c FROM sqlite_master WHERE type='table' AND name='personal_access_tokens'`).get();
      db.close();
      return t.c === 1;
    } catch { return null; }
  }, { timeoutMs: 40000, everyMs: 150 });
  ok(!!schemaUp, 'the real server created + migrated its sqlite store (phase 1)');
  await stop(child1);
  if (!schemaUp) throw new Error(`server never migrated its store — see ${logPath}`);

  const token = seedStore();
  ok(token.startsWith('nbp_') && token.length === 40, 'seeded a PAT in the real format (nbp_ + 30 + 6)');

  server = startMgmt();
  const ready = await waitFor(async () => {
    if (server.exitCode !== null) return null;
    try {
      // Consume the body: an unconsumed response leaves undici's pooled socket dirty, and the
      // next request on it can hang to its abort bound (seen once against a real server).
      await (await fetch(`http://127.0.0.1:${apiPort}/api/peers`)).text();
      return true;
    } catch { return null; }
  }, { timeoutMs: 40000, everyMs: 200 });
  ok(!!ready, 'the real management server answers HTTP on 127.0.0.1 (phase 2)');
  if (!ready) throw new Error(`server never listened — see ${logPath}`);

  // ── now drive the REAL client module at it ─────────────────────────────────────────────────
  const nb = await import('../server/src/lib/netbird.js');
  config.netbirdApiUrl = `http://127.0.0.1:${apiPort}`;
  config.netbirdApiToken = token;
  ok(nb.meshEnabled(), 'meshEnabled() is true once the harness points config at the live server');

  section('the PAT is accepted (auth against the real middleware)');
  const ping = await nb.netbirdRequest('GET', '/api/peers');
  ok(ping.status === 200 && Array.isArray(ping.json), `GET /api/peers → 200 + array (${ping.status})`);
  const noAuth = await fetch(`http://127.0.0.1:${apiPort}/api/peers`);
  // Consume the body — see the readiness note above.
  const noAuthBody = await noAuth.text();
  ok((noAuth.status === 401 || noAuth.status === 403) && noAuthBody.trim().length > 0,
     `and the same call with NO token is refused (${noAuth.status})`);

  section('ensureGroup — real create-then-find is idempotent');
  const g1 = await nb.ensureGroup('xells');
  ok(g1.ok === true && !!g1.id && g1.created === true, `group 'xells' created (${g1.id})`);
  const g2 = await nb.ensureGroup('xells');
  ok(g2.ok === true && g2.id === g1.id && g2.created === false, 'a second ensure finds the same group id (no duplicate)');
  const gProd = await nb.ensureGroup('prod');
  ok(gProd.ok === true && !!gProd.id, `group 'prod' created (${gProd.id})`);

  section('createSetupKey — one-off, ephemeral, auto-grouped (real API)');
  const keyName = `zeehive:e2e:${Date.now()}`;
  const sk = await nb.createSetupKey({ name: keyName, autoGroups: [g1.id] });
  ok(sk.ok === true && !!sk.id && typeof sk.key === 'string' && sk.key.length > 10,
     `the real API minted a setup key (id ${sk.id})`);
  const keys = await nb.netbirdRequest('GET', '/api/setup-keys');
  const stored = Array.isArray(keys.json) ? keys.json.find((k) => k.id === sk.id) : null;
  ok(!!stored, 'the key is in the control plane\'s own list');
  ok(stored?.usage_limit === 1 && stored?.ephemeral === true && !stored?.revoked,
     `the key is one-off (usage_limit ${stored?.usage_limit}), ephemeral ${stored?.ephemeral}, unrevoked`);
  ok(Array.isArray(stored?.auto_groups) && stored.auto_groups.includes(g1.id),
     "the key carries the auto-group id, so a joining peer lands in 'xells'");

  section('listPeers / getPeerByHostname — against real peer rows');
  const lp = await nb.listPeers();
  const lpPeers = listOf(lp, 'peers');
  ok(lp.ok === true && lpPeers.length >= SEED_PEERS.length,
     `listPeers answers the real array (${lpPeers.length} peers)${why(lp)}`);
  const found = await nb.getPeerByHostname('mesh-e2e-seed');
  ok(found.ok === true && found.peer?.id === SEED_PEERS[0].id, 'getPeerByHostname finds a real peer by hostname');
  ok(found.peer?.ip === SEED_PEERS[0].ip, `and carries the LIVE half — the assigned mesh ip (${found.peer?.ip})`);
  ok(found.peer?.dns_label === nb.meshFqdn('mesh-e2e-seed', SEED_PEERS[0].ip),
     `the real dns_label IS meshFqdn(hostname, ip): ${found.peer?.dns_label}`);
  const stranger = await nb.getPeerByHostname('nobody-here');
  ok(stranger.ok === true && stranger.peer === null, 'an unknown hostname is data (peer: null), not a failure');

  section('deletePeer — a real delete, and a real 404 counts as alreadyGone');
  const del = await nb.deletePeer(SEED_PEERS[0].id);
  ok(del.ok === true && del.deleted === true, 'DELETE /api/peers/{id} → gone');
  const delAgain = await nb.deletePeer(SEED_PEERS[0].id);
  ok(delAgain.ok === true && delAgain.alreadyGone === true, 'a repeat DELETE answers 404 → alreadyGone (idempotent)');
  const afterDel = await nb.listPeers();
  ok(!listOf(afterDel, 'peers').some((p) => p.id === SEED_PEERS[0].id),
     `the peer is really gone from the control plane${why(afterDel)}`);

  section('ensurePolicy — the drift fix, verified against the real API');
  const polName = `e2e-narrow-${Date.now()}`;
  const pol = await nb.ensurePolicy({
    name: polName, sourceGroups: ['xells'], destGroups: ['prod'], ports: ['5432'],
  });
  ok(pol.ok === true && pol.created === true,
     `the corrected rule body is ACCEPTED (id ${pol.id})${pol.ok ? '' : ` — ${pol.reason}`}`);
  const pl = await nb.listPolicies();
  ok(pl.ok === true, 'listPolicies answers the real array');
  const realPol = listOf(pl, 'policies').find((p) => p.id === pol.id) || null;
  ok(!!realPol, 'the policy round-trips through GET /api/policies');
  const rule = realPol?.rules?.[0];
  ok(rule?.protocol === 'tcp' && Array.isArray(rule?.ports) && rule.ports[0] === '5432',
     `the real rule is a tcp :5432 grant (protocol ${rule?.protocol}, ports ${JSON.stringify(rule?.ports)})`);
  // NOTE the asymmetry, a real API fact §11 records: the CREATE body takes group ID strings, but
  // the READ body answers GroupMinimum OBJECTS ({id,name,peers_count}) for sources/destinations.
  const idsOf = (v) => (Array.isArray(v) ? v.map((g) => (typeof g === 'string' ? g : g?.id)) : v);
  ok(JSON.stringify(idsOf(rule?.sources)) === JSON.stringify([g1.id])
     && JSON.stringify(idsOf(rule?.destinations)) === JSON.stringify([gProd.id]),
     'sources/destinations carry the resolved group ids (the 422 drift, fixed)');
  ok(rule?.enabled === true && rule?.action === 'accept' && realPol?.enabled === true,
     'rule + policy are enabled accept rules');
  const polAgain = await nb.ensurePolicy({
    name: polName, sourceGroups: ['xells'], destGroups: ['prod'], ports: ['5432'],
  });
  ok(polAgain.ok === true && polAgain.existing === true && polAgain.id === pol.id,
     'find-by-name is idempotent — no duplicate policy');

  section('ensurePolicy without ports — protocol all, no ports (the ALL/ICMP constraint)');
  const allPol = await nb.ensurePolicy({ name: `${polName}-all`, sourceGroups: ['xells'], destGroups: ['xells'] });
  ok(allPol.ok === true, `a portless policy is accepted (id ${allPol.id})${allPol.ok ? '' : ` — ${allPol.reason}`}`);
  const allPl = await nb.listPolicies();
  const allReal = listOf(allPl, 'policies').find((p) => p.id === allPol.id) || null;
  ok(allReal?.rules?.[0]?.protocol === 'all' && !allReal?.rules?.[0]?.ports,
     'and the real rule is protocol all with NO ports (the API forbids ports on ALL/ICMP)');

  section('ensureProdBindMeshPolicy — the one prod grant a human-approved bind flips');
  const xellSlug = `e2e-x-${Date.now()}`;
  const bind = await nb.ensureProdBindMeshPolicy(xellSlug);
  ok(bind.ok === true && bind.created === true, 'the prod-bind policy is ensured');
  const bindPl = await nb.listPolicies();
  const bindReal = listOf(bindPl, 'policies').find((p) => p.name === nb.prodBindPolicyName(xellSlug)) || null;
  ok(bindReal?.rules?.[0]?.protocol === 'tcp' && bindReal?.rules?.[0]?.ports?.[0] === '5432',
     'and in the real store it is exactly xells→prod tcp:5432 — narrow by construction');
  const rebind = await nb.ensureProdBindMeshPolicy(xellSlug);
  ok(rebind.ok === true && rebind.existing === true, 'a re-bind stacks no duplicate');

  // ── the meta-DB half: intent rows over REAL control-plane deletes ───────────────────────────
  const { q, one, pool } = await import('../server/src/db/pool.js');
  const haveMeshPeer = await one(`SELECT to_regclass('public.mesh_peer') AS t`).catch(() => null);
  if (!haveMeshPeer?.t) {
    section('meta-DB half (mintPeer / markPeerJoined / deregister / sweep) — SKIPPED');
    console.log(`  – SKIP the meta-DB (${config.databaseUrl?.replace(/:[^:@/]*@/, ':***@')}) has no mesh_peer`);
    console.log('    table (migration 249 is not applied there). The intent-row paths need a migrated');
    console.log('    meta-DB; a shared dev db is not one. Run against a throwaway postgres:');
    console.log('      zee db-sandbox --migrate        # then use the DATABASE_URL it prints');
    await pool.end().catch(() => {});
  } else {
    cleanups.unshift(async () => { try { await pool.end(); } catch { /* already closed */ } });
    const proj = await one(`INSERT INTO project (name, repo_root) VALUES ('netbird-live-api', '/tmp/x') RETURNING id`);
    cleanups.push(() => q(`DELETE FROM mesh_peer WHERE project_id=$1`, [proj.id]));
    cleanups.push(() => q(`DELETE FROM project WHERE id=$1`, [proj.id]));
    const xource = await one(`INSERT INTO xource (project_id, ref) VALUES ($1,'main') RETURNING id`, [proj.id]);
    cleanups.push(() => q(`DELETE FROM xource WHERE id=$1`, [xource.id]));
    const xell = await one(
      `INSERT INTO xell (project_id, xource_id, slug, branch, status)
       VALUES ($1,$2,'mesh-e2e-join','spinoff/mesh-e2e-join','claimed') RETURNING id`, [proj.id, xource.id]);
    cleanups.push(() => q(`DELETE FROM xell WHERE id=$1`, [xell.id]));

    section('mintPeer / markPeerJoined — intent row + the control plane\'s live half');
    const minted = await nb.mintPeer(
      { projectId: proj.id, kind: 'xell', hostname: 'mesh-e2e-join', xellId: xell.id });
    ok(minted.ok === true && typeof minted.setupKey === 'string' && minted.setupKey.length > 10,
       `mintPeer created a real setup key and returned it (id ${minted.row?.nb_setup_key_id})`
       + (minted.ok ? '' : ` — ${minted.reason}`));
    const row = await one(`SELECT * FROM mesh_peer WHERE hostname='mesh-e2e-join'`);
    ok(row?.status === 'minted' && row.nb_setup_key_id === minted.row?.nb_setup_key_id,
       'the intent row is minted, keyed by the setup-key id for audit');
    ok(!JSON.stringify(row).includes(minted.setupKey), 'the key itself is NEVER on the row');
    const joined = await nb.markPeerJoined('mesh-e2e-join');
    ok(joined.ok === true, `markPeerJoined finds the real peer and stamps the row${joined.ok ? '' : `: ${joined.reason}`}`);
    const jrow = await one(`SELECT * FROM mesh_peer WHERE hostname='mesh-e2e-join'`);
    ok(jrow.status === 'joined' && jrow.nb_peer_id === SEED_PEERS[1].id && String(jrow.ip) === SEED_PEERS[1].ip,
       `the LIVE half is cached (nb_peer_id ${jrow.nb_peer_id}, ip ${jrow.ip})`);

    section('deregisterXellPeers — a real control-plane delete + row stamp');
    const dereg = await nb.deregisterXellPeers(xell.id);
    ok(dereg.ok === true && dereg.removed === 1, `the xell's peer is deregistered${dereg.ok ? '' : `: ${dereg.problems}`}`);
    const gone = await nb.listPeers();
    ok(!listOf(gone, 'peers').some((p) => p.id === SEED_PEERS[1].id),
       `and it is really gone from the real control plane${why(gone)}`);
    const goneRow = await one(`SELECT * FROM mesh_peer WHERE hostname='mesh-e2e-join'`);
    ok(goneRow.status === 'removed' && goneRow.removed_at !== null, 'the intent row says removed, with a timestamp');
    ok((await nb.deregisterXellPeers(xell.id)).removed === 0, 'a second deregister is a no-op (idempotent)');

    section('sweepOrphanMeshPeers — dead-by-intent vs unknown, against real peers');
    await q(`INSERT INTO mesh_peer (project_id, kind, hostname, xell_id, status, removed_at)
             VALUES ($1,'xell','mesh-e2e-removed',$2,'removed',now())`, [proj.id, xell.id]);
    const sweep = await nb.sweepOrphanMeshPeers();
    ok(sweep.ok === true && sweep.deleted.includes('mesh-e2e-removed'),
       `dead-by-intent peer deleted by the janitor (${sweep.deleted.join(', ') || 'none'})`);
    ok(sweep.unknown.includes('mesh-e2e-orphan'), 'an unknown hostname is REPORTED, never deleted');
    const survivorList = await nb.listPeers();
    const survivor = listOf(survivorList, 'peers').find((p) => p.id === SEED_PEERS[3].id);
    ok(!!survivor, 'the stranger peer is still there — the shared control plane was not over-reaped');

    // ── the real agent (optional): a client registers with a key OUR client minted ────────────
    section('a REAL netbird agent registers with a setup key our client minted');
    if (!clientBin) {
      console.log(`  – SKIP no client binary (set NETBIRD_CLIENT_BIN or add one to ${DEFAULT_BIN_DIR})`);
    } else {
      const agentHost = 'mesh-e2e-agent';
      const agentMint = await nb.mintPeer({ projectId: proj.id, kind: 'xell', hostname: agentHost, xellId: xell.id });
      ok(agentMint.ok === true, 'a one-off key for the agent is minted through the real API');
      const agentDir = join(dir, 'agent');
      const agentLogPath = join(dir, 'agent.log');
      const agent = spawn(clientBin, [
        'up', '--setup-key', agentMint.setupKey,
        '--management-url', `http://127.0.0.1:${apiPort}`,
        '--config', join(agentDir, 'config.json'),
        '--daemon-addr', `unix://${join(agentDir, 'nb.sock')}`,
        '-F', '-n', agentHost,
        // The host's resolver/firewall/interfaces are never touched: registration is the point, a
        // tunnel is not (there is no signal server here to bring one up anyway).
        '--disable-dns', '--disable-firewall',
        '--log-level', 'info', '--log-file', 'console',
      ], { env: { ...process.env, NB_DISABLE_GEOLOCATION: 'true' }, stdio: ['ignore', 'pipe', 'pipe'] });
      const agentLog = createWriteStream(agentLogPath);
      agent.stdout.pipe(agentLog);
      agent.stderr.pipe(agentLog);
      children.push(agent);
      const seen = await waitFor(async () => {
        if (agent.exitCode !== null) return null;
        const p = await nb.getPeerByHostname(agentHost);
        return p.ok && p.peer ? p.peer : null;
      }, { timeoutMs: 45000, everyMs: 500 });
      if (seen) {
        ok(true, `the real agent registered (peer ${seen.id}, ip ${seen.ip}, dns_label ${seen.dns_label})`);
        const listed = listOf(await nb.listPeers(), 'peers').some((p) => p.id === seen.id);
        ok(listed, 'and a real agent\'s peer rides out of listPeers');
        const agentDel = await nb.deletePeer(seen.id);
        ok(agentDel.ok === true && agentDel.deleted === true, 'and our client can deregister it');
      } else {
        console.log('  – SKIP the agent did not finish registering in 45s on this host.');
        console.log('    The peer-row assertions above already proved the read/delete paths; this section only');
        console.log('    adds "a real agent consumes a key our client minted". Agent log tail:');
        const tail = existsSync(agentLogPath) ? readFileSync(agentLogPath, 'utf8').trim().split('\n').slice(-6) : [];
        for (const l of tail) console.log(`      | ${l}`);
      }
      await stop(agent, { graceMs: 4000 });
    }
  }
} catch (e) {
  console.log(`\n  ✗ FAIL harness error: ${e.stack || e.message}`);
  fail++;
} finally {
  for (const c of children) await stop(c).catch(() => {});
  for (const c of cleanups.reverse()) { try { await c(); } catch { /* best-effort teardown */ } }
  // Keep the log dir for a post-mortem on failure; drop it on success.
  if (!fail) rmSync(dir, { recursive: true, force: true });
  else console.log(`\n  (logs kept for post-mortem: ${logPath})`);
}

console.log(fail ? `\n${fail} FAILURE(S) ✗` : '\nALL PASSED ✓ (against a REAL NetBird management server)');
process.exit(fail ? 1 : 0);
