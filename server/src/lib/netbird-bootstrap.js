// THE FIRST PAT — bootstrapping the one credential a ManagerType-none control plane cannot issue
// (docs/netbird-mesh-plan.md §3.1, §11 "human deploy finding"; migration 259).
//
// THE HOLE THIS FILLS. NetBird's supported way to create the first account/user/PAT is the setup
// flow, and that flow needs an IdP: with `IdpManagerConfig.ManagerType: "none"` (the only sane
// self-hosted shape for a fleet that has no OIDC provider) the dashboard has nothing to
// authenticate against, so there is NO supported way to create the first account. calm-ridge's live
// harness (test/netbird-live-api.test.mjs) proved the way through: write the account/user/policy
// rows straight into the server's sqlite store — the shapes read off the server's OWN writes — and
// the API then accepts a PAT minted in that same format. This module is that harness's seed,
// productionized: it is the "first API token is bootstrapped automatically" half of the card.
//
// WHY IT IS PINNED. Those row shapes are not an API; they are one release's storage. Seeding them
// into a different management build is how you corrupt a live store, so `versionRefusal` refuses
// ANY version other than PINNED_NETBIRD_VERSION, with the version it found and the number it
// expects named in the message. The version is read from the RUNNING container's image tag — not
// from an endpoint: v0.78.1 has no unauthenticated version endpoint (GET /api/instance/version is
// 401 without the very PAT we are trying to create), which the same live work established.
//
// THE SEQUENCE, and why each step is one:
//   1. inspect  — the running image tag, so the pin is checked before anything is touched.
//   2. stop     — sqlite lets exactly one writer in; the harness hit `database is locked` opening
//                 the store under a running server. Never seed a live store.
//   3. cp out   — the store OUT of the container (the pinned binary and node:sqlite are on
//                 different machines: the container can't run our seed, we can't read its volume).
//   4. seed     — this module's row writes, in a scratch dir, guarded and idempotent.
//   5. cp back  — chmod 0666 first: `docker cp` lands files root:root whatever the local owner was,
//                 and the management process must be able to WRITE the store it opens (WAL
//                 checkpoints), not merely read it. Permissions are preserved from the source, so
//                 0666 makes the very same file usable by whatever uid the image runs as, with no
//                 guess about that uid and no chown binary inside a slim image.
//   6. start    — restart the plane, and prove it healthy with the same bounded probe the stand-up
//                 uses. A failure at any step AFTER the stop restarts the plane before returning,
//                 so the caller is never left with a stopped control plane.
// Everything is injected (docker adapter, store opener, clock, probe), so the offline tests drive
// the whole flow against a fake docker and a real sqlite file, and test/netbird-live-api.test.mjs
// drives it against the REAL v0.78.1 binary.
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PINNED_NETBIRD_VERSION, probeManagementApi } from './netbird.js';
import { DEFAULT_MESH_DOMAIN, DEFAULT_PEER_NET } from './mesh-config.js';
import { logline } from './logbus.js';

// Where the pinned release keeps its sqlite store inside the container (docker-compose.bootstrap.yml
// mounts the netbird_management_data volume at /var/lib/netbird; the harness's --datadir is the same
// directory shape).
export const MESH_STORE_IN_CONTAINER = '/var/lib/netbird/store.db';
export const MESH_CONTROL_PLANE_CONTAINER = 'zeehive_netbird_management';
// The harness's literal, which the real server accepted and numbered peers out of. Kept verbatim.
export const DEFAULT_PEER_NET_V6 = 'fd00:4e42:1234:5678::';
const XID_ALPHABET = '0123456789abcdefghijklmnopqrstuv';

// PURE: the tag half of an image reference, or null when there is none. Only ever used on what
// `docker inspect --format {{.Config.Image}}` answered. A digest-pinned reference
// (image@sha256:…) has no tag and so refuses — deliberate: the pin is a TAG, and a digest this
// module cannot map to a version must not silently pass the guard.
export function parseImageTag(ref) {
  const s = String(ref || '').trim();
  if (!s) return null;
  const repo = s.split('@')[0];
  const slash = repo.lastIndexOf('/');
  const colon = repo.lastIndexOf(':');
  return colon > slash ? repo.slice(colon + 1) : null;
}

// PURE: null when `version` IS the pin, else a sentence a human can act on. `version` comes from
// parseImageTag above; null = the image carried no tag at all (a refusal too, never a pass).
export function versionRefusal(version, { pinned = PINNED_NETBIRD_VERSION } = {}) {
  if (version && version === pinned) return null;
  const found = version || 'no tag (digest-pinned or untagged image)';
  return `refusing to bootstrap the first API token: the running management image is `
    + `${version ? `v${found}` : found}, and the account/user/PAT store rows this bootstrap writes `
    + `are pinned to v${pinned} — they are one release's storage, not an API. Run the control plane `
    + `at v${pinned} (docker-compose.bootstrap.yml defaults to it; NETBIRD_MANAGEMENT_TAG overrides), `
    + `or create the first PAT in NetBird yourself and paste it into the console's mesh config.`;
}

// PURE: base32-hex of a byte string (RFC 4648 alphabet), the encoding xid uses.
function base32hex(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += XID_ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += XID_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

// An id in the SHAPE the server's own rows use (xid: 4-byte second counter + 8 random bytes, 20
// base32-hex chars). Shape matters even though the columns are text: 26-char test fixtures proved
// readable, but production rows should look like every other row so nothing downstream can be the
// first thing to notice.
export function xid(nowMs = Date.now()) {
  const b = Buffer.alloc(12);
  b.writeUInt32BE(Math.floor(nowMs / 1000) >>> 0, 0);
  randomBytes(8).copy(b, 4);
  return base32hex(b);
}

// PURE: `100.64.0.0/16` → the { IP, Mask } JSON the accounts row stores (the mask base64).
export function ipv4Net(cidr) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(String(cidr || '').trim());
  if (!m) throw new Error(`'${cidr}' is not an IPv4 CIDR`);
  const octets = m.slice(1, 5).map(Number);
  const prefix = Number(m[5]);
  if (octets.some((o) => o > 255) || prefix > 32) throw new Error(`'${cidr}' is not an IPv4 CIDR`);
  const mask = prefix === 0 ? 0 : (0xFFFFFFFF << (32 - prefix)) >>> 0;
  return JSON.stringify({
    IP: octets.join('.'),
    Mask: Buffer.from([mask >>> 24, (mask >>> 16) & 255, (mask >>> 8) & 255, mask & 255]).toString('base64'),
  });
}

// PURE: the crc32 of a buffer (the PAT's check field).
export function crc32(buf) {
  let c, crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xFF;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xEDB88320 : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// PURE: mint a PAT in NetBird's own format — `nbp_` + a 30-char secret + base62(crc32(secret))
// LEFT-PADDED WITH SPACES to exactly 6. The server decodes that padding as base62 digits, so a
// crc encoding that is already 6 chars is required (the harness's finding); the loop retries until
// it gets one. Returns { token, hashed } — `hashed` is the base64 sha256 the store keeps, and the
// plaintext token is what the caller stores, once.
export function mintPat() {
  const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
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

// PURE: encrypt one field the way NetBird's crypt.FieldEncrypt does — AES-256-GCM over the
// base64-decoded key, base64(nonce || ciphertext || tag), 12-byte nonce. The key MUST be the
// control plane's own DataStoreEncryptionKey (lib/mesh-config.js supplies the resolved one), or the
// seeded user's name/email come back as garbage to the server that owns them.
export function encryptField(plaintext, dataKey) {
  const nonce = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', Buffer.from(dataKey, 'base64'), nonce);
  const ct = Buffer.concat([c.update(String(plaintext), 'utf8'), c.final()]);
  return Buffer.concat([nonce, ct, c.getAuthTag()]).toString('base64');
}

// The store's ISO-ish timestamp format, which is what the pinned release writes.
const storeNow = (d = new Date()) => d.toISOString().replace('T', ' ').replace('Z', '+00:00');

async function defaultOpenStore(path) {
  const { DatabaseSync } = await import('node:sqlite');
  return new DatabaseSync(path);
}

function tableExists(db, name) {
  const r = db.prepare(`SELECT count(*) c FROM sqlite_master WHERE type='table' AND name=?`).get(name);
  return Number(r?.c) > 0;
}
function rowCount(db, table) {
  return Number(db.prepare(`SELECT count(*) c FROM "${table}"`).get()?.c || 0);
}

// THE SEED — the fs/sqlite half, no docker in sight. Opens a store file that is NOT in use (the
// caller stopped the server), and:
//   • refuses a version that is not the pin (before opening anything),
//   • refuses a store with no schema yet (the server migrates its own store on first boot),
//   • is IDEMPOTENT: an account already present means a first PAT exists, and this returns
//     `alreadyPresent` with the reason a human needs (the token itself is unrecoverable — only its
//     hash was ever stored, which is the point).
// Returns { ok:true, token, hashed, accountId, userId, groupId, policyId } or { ok:false, reason }.
export async function seedFirstPat(storePath, {
  version = PINNED_NETBIRD_VERSION, dataKey, openStore = defaultOpenStore, clock = new Date(),
  peerNet = DEFAULT_PEER_NET, ids = {},
} = {}) {
  const refusal = versionRefusal(version);
  if (refusal) return { ok: false, refused: true, reason: refusal };
  if (!dataKey) {
    return { ok: false, reason: 'no datastore encryption key is configured — the seeded user\'s '
      + 'name/email are encrypted with the control plane\'s own key and there is nothing to encrypt with' };
  }
  // The file MUST already exist. sqlite's open CREATES a missing one, and a store we invented here
  // would be copied back into the container as an EMPTY account database — silently destroying the
  // control plane's datastore. A missing file means the copy-out failed, and that is a refusal.
  if (!existsSync(storePath)) {
    return { ok: false, reason: `no management store at '${storePath}' to seed — the store was never `
      + 'copied out of the control plane, so there is nothing safe to write back' };
  }
  let db;
  try {
    db = await openStore(storePath);
  } catch (e) {
    return { ok: false, reason: `could not open the management store at '${storePath}': ${e.message}` };
  }
  try {
    if (!tableExists(db, 'accounts')) {
      return { ok: false, reason: 'the management store has no schema yet — boot the control plane '
        + 'once so it migrates its own store, then re-run this bootstrap' };
    }
    if (rowCount(db, 'accounts') > 0) {
      return { ok: true, alreadyPresent: true, token: null, reason:
        'the control plane already has an account, so its first API token was created some other '
        + 'way and only its hash is in the store — mint a PAT in NetBird and paste it into the '
        + 'console\'s mesh config (the token itself cannot be recovered from the store)' };
    }
    const accountId = ids.accountId || xid(clock.getTime());
    const userId = ids.userId || xid(clock.getTime());
    const groupId = ids.groupId || xid(clock.getTime());
    const policyId = ids.policyId || xid(clock.getTime());
    const now = storeNow(clock);
    const netV4 = ipv4Net(peerNet);
    const netV6 = JSON.stringify({
      IP: DEFAULT_PEER_NET_V6,
      Mask: Buffer.concat([Buffer.alloc(8, 0xff), Buffer.alloc(8, 0)]).toString('base64'),
    });
    const pat = mintPat();

    // The row shapes below are read off the pinned server's OWN writes (test/netbird-live-api.test.mjs
    // is where they were captured and where they are re-proven). Column-for-column identical to the
    // harness's seed except for the generated ids and the encryption key's provenance.
    db.prepare(`INSERT INTO accounts (id, created_by, created_at, domain, domain_category,
        is_domain_primary_account, network_identifier, network_net, network_net_v6, network_serial,
        settings_groups_propagation_enabled, settings_jwt_groups_enabled,
        settings_peer_login_expiration_enabled, settings_peer_inactivity_expiration_enabled)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(accountId, userId, now, 'netbird.selfhosted', 'private', 1, 'zeehive-net', netV4, netV6, 0, 1, 0, 0, 0);
    // role 'owner' + non_deletable: the account must always have an owner, and the token belongs to it.
    db.prepare(`INSERT INTO users (id, account_id, role, is_service_user, non_deletable, blocked,
        pending_approval, created_at, issued, name, email)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(userId, accountId, 'owner', 0, 1, 0, 0, now, 'api',
        encryptField('zeehive', dataKey), encryptField('zeehive@mesh.local', dataKey));
    db.prepare(`INSERT INTO groups (id, account_id, name, issued) VALUES (?,?,?,?)`)
      .run(groupId, accountId, 'All', 'api');
    db.prepare(`INSERT INTO policies (id, account_id, name, description, enabled) VALUES (?,?,?,?,?)`)
      .run(policyId, accountId, 'Default', 'This policy allows all traffic between peers (default rule)', 1);
    db.prepare(`INSERT INTO policy_rules (id, policy_id, name, description, enabled, action,
        destinations, sources, bidirectional, protocol, ports)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(policyId, policyId, 'Default', 'This rule allows all traffic between peers (default rule)',
        1, 'accept', JSON.stringify([groupId]), JSON.stringify([groupId]), 1, 'all', '[]');
    db.prepare(`UPDATE accounts SET settings_ipv6_enabled_groups=? WHERE id=?`)
      .run(JSON.stringify([groupId]), accountId);
    db.prepare(`INSERT INTO personal_access_tokens (id, user_id, name, hashed_token, expiration_date,
        created_by, created_at) VALUES (?,?,?,?,?,?,?)`)
      .run(xid(clock.getTime()), userId, 'zeehive', pat.hashed, '2030-01-01 00:00:00+00:00', userId, now);

    return { ok: true, alreadyPresent: false, token: pat.token, hashed: pat.hashed,
             accountId, userId, groupId, policyId, domain: DEFAULT_MESH_DOMAIN };
  } catch (e) {
    return { ok: false, reason: `seeding the first account failed: ${e.message}` };
  } finally {
    try { db.close?.(); } catch { /* already closed */ }
  }
}

// PURE: the argv sequence, in order, so the ordering contract is testable and the performer can't
// drift from it. `seed` has no argv (it is this module's own step).
export function patBootstrapPlan({ ctx, container = MESH_CONTROL_PLANE_CONTAINER, storeOut } = {}) {
  return [
    { op: 'inspect-image', ctx, argv: ['inspect', container, '--format', '{{.Config.Image}}'] },
    { op: 'stop', ctx, argv: ['stop', container] },
    { op: 'read-store', ctx, argv: ['cp', `${container}:${MESH_STORE_IN_CONTAINER}`, storeOut] },
    { op: 'seed', ctx, argv: null },
    { op: 'write-store', ctx, argv: ['cp', storeOut, `${container}:${MESH_STORE_IN_CONTAINER}`] },
    { op: 'start', ctx, argv: ['start', container] },
  ];
}

// THE PERFORMER. Never throws: every failure is a verdict with a reason, and a failure after the
// stop always restarts the plane first. Returns
//   { ok:true, token, version, restart:{…} } on success, or
//   { ok:false, refused?, alreadyPresent?, reason, restarted } otherwise.
export async function bootstrapFirstPat({
  docker, ctx, container = MESH_CONTROL_PLANE_CONTAINER, version = PINNED_NETBIRD_VERSION,
  dataKey, storeDir = null, openStore = defaultOpenStore, clock = new Date(),
  probe = probeManagementApi, probeAttempts = 6, keepScratch = false, log = logline,
} = {}) {
  if (!docker) return { ok: false, reason: 'no docker adapter — the store lives inside the control-plane container' };
  const dir = storeDir || mkdtempSync(join(tmpdir(), 'zeehive-mesh-pat-'));
  // An injected scratch dir may not exist yet, and docker cp will not create it.
  mkdirSync(dir, { recursive: true });
  const storeOut = join(dir, 'store.db');
  const plan = patBootstrapPlan({ ctx, container, storeOut });
  const argvOf = (op) => plan.find((s) => s.op === op).argv;
  let stopped = false;
  const startPlane = async () => {
    if (!stopped) return { ok: true, skipped: true };
    const r = await docker(ctx, argvOf('start'));
    stopped = false;
    return { ok: !r.unknown && r.status === 0, detail: r.unknown ? r.reason : (r.stderr || r.stdout || '').trim() };
  };
  try {
    // 1. the pin, read off what is RUNNING (never off an endpoint: there is no unauthenticated one).
    const img = await docker(ctx, argvOf('inspect-image'));
    if (img.unknown) return { ok: false, reason: `could not inspect '${container}' on '${ctx}': ${img.reason}` };
    if (img.status !== 0) {
      return { ok: false, reason: `cannot read the control-plane image (docker inspect '${container}' → ${img.status}): `
        + `${(img.stderr || img.stdout || '').trim() || 'no output'}` };
    }
    const runningVersion = parseImageTag(img.stdout);
    const refusal = versionRefusal(runningVersion, { pinned: version });
    if (refusal) return { ok: false, refused: true, reason: refusal, refused_version: runningVersion };

    // 2. stop — one writer only.
    const stop = await docker(ctx, argvOf('stop'));
    if (stop.unknown || stop.status !== 0) {
      return { ok: false, restarted: true,
               reason: `could not stop '${container}' on '${ctx}' (${stop.unknown ? stop.reason : (stop.stderr || stop.stdout || '').trim() || stop.status}) `
                 + `— the store is never seeded under a running server` };
    }
    stopped = true;

    // 3. the store OUT.
    const cpOut = await docker(ctx, argvOf('read-store'));
    if (cpOut.unknown || cpOut.status !== 0) {
      const r = await startPlane();
      return { ok: false, restarted: r.ok,
               reason: `could not copy the store out of '${container}' (${cpOut.unknown ? cpOut.reason : (cpOut.stderr || '').trim()})`
                 + (r.ok ? ' — the control plane was restarted untouched' : ` — AND THE CONTROL PLANE IS STILL STOPPED: ${r.detail}`) };
    }

    // 4. the seed.
    const seed = await seedFirstPat(storeOut, { version: runningVersion, dataKey, openStore, clock });
    if (!seed.ok || seed.alreadyPresent) {
      const r = await startPlane();
      const tail = r.ok ? ' — the control plane was restarted untouched' : ` — AND THE CONTROL PLANE IS STILL STOPPED: ${r.detail}`;
      return { ok: false, refused: !!seed.refused, alreadyPresent: !!seed.alreadyPresent,
               restarted: r.ok, reason: `${seed.reason}${tail}` };
    }

    // 5. the store BACK. 0666 first — see the header's step 5.
    chmodSync(storeOut, 0o666);
    const cpIn = await docker(ctx, argvOf('write-store'));
    if (cpIn.unknown || cpIn.status !== 0) {
      const r = await startPlane();
      return { ok: false, restarted: r.ok,
               reason: `could not copy the seeded store back into '${container}' (${cpIn.unknown ? cpIn.reason : (cpIn.stderr || '').trim()})`
                 + (r.ok ? ' — the control plane was restarted untouched' : ` — AND THE CONTROL PLANE IS STILL STOPPED: ${r.detail}`) };
    }

    // 6. restart + prove healthy.
    const started = await startPlane();
    if (!started.ok) {
      return { ok: false, reason: `the seeded store was written but '${container}' would not start: ${started.detail}` };
    }
    const health = await probe({ attempts: probeAttempts });
    if (!health.ok) {
      return { ok: false, token: seed.token, reason: `the control plane restarted but the management API at `
        + `${health.host}:${health.port} is not answering (${health.verdict || health.reason}) — the seeded `
        + `account was written and the token was minted: check the service logs` };
    }
    log(`mesh: bootstrapped the first control-plane account + API token (${seed.token.slice(0, 4)}…) `
      + `on '${container}' v${runningVersion}`);
    return { ok: true, token: seed.token, version: runningVersion, account_id: seed.accountId,
             user_id: seed.userId, health };
  } finally {
    if (!keepScratch) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
}
