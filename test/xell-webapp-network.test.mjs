// XELL-WEBAPP-NETWORK test — the queenzee-proxied webapp review URL and the ZEEHIVE-operated
// WireGuard mesh (docs/common-xell-network-plan.md, Decisions 5.1–5.4).
//
// Two halves, both pure/logic where they can be and DB-backed where they must be:
//
//   a) the webapp URL derivation (xellWebappPath) — the reachable URL a human (or another cxell)
//      opens for a xell webapp. It replaced the stored container url (10.2.0.16:5383), which
//      nothing publishes; it must be the stable /xell-web/<slug>/ path on the console origin.
//
//   b) the WireGuard config layer — Node's native x25519 mints a real WG keypair, the rendered
//      .conf has the exact [Interface]/[Peer] shape a WG client imports, and mintPeerConfig (DB-
//      backed) allocates a tunnel IP, records the peer, and returns a config whose private key
//      appears ONLY in the returned text (never stored — the peer row holds the public key).
//
// Exercised for real: the migration creates wireguard_server/wireguard_peer on DATABASE_URL, and
// mintPeerConfig writes a real peer row; everything it creates is cleaned up in a finally (house
// rule 1). The pure parts need no database and run anywhere.

import { wgKeyPair, renderPeerConfig, mintPeerConfig, wireguardStatus } from '../server/src/lib/wireguard.js';
import { xellWebappPath } from '../server/src/lib/webapp-proxy.js';
import { q, pool } from '../server/src/db/pool.js';

let failed = 0;
const ok = (cond, name) => { if (cond) console.log(`  ✓ ${name}`); else { console.log(`  ✗ FAIL ${name}`); failed++; } };

// ── (a) the webapp URL derivation ───────────────────────────────────────────────────────────────
console.log('\n── the reachable xell webapp URL is /xell-web/<slug>/ ──');
ok(xellWebappPath('calm-harbor-abc123') === '/xell-web/calm-harbor-abc123/', 'a slug maps to its proxied path');
ok(xellWebappPath('i-want-all-xells-to-have-a-common-network-wi-fa2518') === '/xell-web/i-want-all-xells-to-have-a-common-network-wi-fa2518/', 'the real long slug maps too');
ok(!xellWebappPath('x').includes('10.2.0.16'), 'the derived URL never names the stored LAN port');

// ── (b) WireGuard key + config layer ─────────────────────────────────────────────────────────────
console.log('\n── WireGuard keys are real Curve25519 ──');
const kp = wgKeyPair();
ok(/^[A-Za-z0-9+/]{43}=$/.test(kp.publicKey), 'public key is 32-byte base64 (44 chars)');
ok(/^[A-Za-z0-9+/]{43}=$/.test(kp.privateKey), 'private key is 32-byte base64 (44 chars)');
ok(kp.publicKey !== kp.privateKey, 'the two keys differ');
const kp2 = wgKeyPair();
ok(kp.publicKey !== kp2.publicKey, 'two keypairs are distinct (fresh random each mint)');

console.log('\n── the rendered .conf has the exact WG shape ──');
const server = { public_key: 'AAAA' + 'A'.repeat(40), endpoint: '10.2.0.16:51820', address: '10.8.0.1/24' };
const peer = { name: 'test', privateKey: 'BBBB' + 'B'.repeat(40), address: '10.8.0.2/32', endpoint_snapshot: '10.2.0.16:51820' };
const conf = renderPeerConfig({ server, peer });
ok(/\[Interface\]/.test(conf), 'has [Interface]');
ok(/\[Peer\]/.test(conf), 'has [Peer]');
ok(conf.includes(`PrivateKey = ${peer.privateKey}`), 'Interface carries the peer private key');
ok(conf.includes(`Address = ${peer.address}`), 'Interface carries the allocated tunnel IP');
ok(conf.includes(`PublicKey = ${server.public_key}`), 'Peer carries the server public key');
ok(conf.includes(`Endpoint = ${peer.endpoint_snapshot}`), 'Peer carries the endpoint (from the peer snapshot)');
ok(conf.includes('AllowedIPs = 10.8.0.1/24'), 'AllowedIPs is the whole mesh (peer reaches every ZEEHIVE host)');

// ── (b2) DB-backed: mintPeerConfig allocates, records, and returns a config whose private key is never stored ──
console.log('\n── mintPeerConfig (DB-backed, real postgres) ──');
const projectId = 'c4f8f19c-5c00-4e40-85ae-28bff3c582a1'; // Zeehive project in the shared dev db
const createdServerIds = [];
const createdPeerIds = [];
try {
  const first = await mintPeerConfig(projectId, { name: 'xell-test-1' });
  createdServerIds.push((await oneServer(projectId)).id);
  createdPeerIds.push(first.peer.id);
  ok(first.peer.address === '10.8.0.2/32', 'first peer gets .2');
  ok(first.config.includes(`PrivateKey = ${extractPrivKey(first.config)}`), 'config carries a private key');

  // The peer row must NOT contain the private key — it is only in the returned config. The schema
  // has no private_key column at all (the strongest possible guarantee that it is never stored).
  const rows = await q(`SELECT public_key FROM wireguard_peer WHERE id=$1`, [first.peer.id]);
  ok(rows.length === 1, 'a peer row was written');
  ok(rows[0].public_key === first.peer.public_key, 'the peer row stores the public key');
  const hasPrivCol = await q(
    `SELECT 1 FROM information_schema.columns
      WHERE table_name='wireguard_peer' AND column_name='private_key'`);
  ok(hasPrivCol.length === 0, 'the peer table has NO private_key column (private key is never stored)');

  const second = await mintPeerConfig(projectId, { name: 'xell-test-2' });
  createdPeerIds.push(second.peer.id);
  ok(second.peer.address === '10.8.0.3/32', 'second peer gets .3 (sequential allocation)');

  const status = await wireguardStatus(projectId);
  ok(status.enabled, 'status reports the mesh enabled after a mint');
  ok(status.peers.length >= 2, 'status lists the minted peers');
  ok(status.server.public_key, 'status exposes the server public key for the console');
} finally {
  // Clean up ONLY what this test created (house rule 1 — never touch a pre-existing row). The
  // server row is cascade-deleted with its last peer; createdServerIds captures it before cleanup.
  for (const id of createdPeerIds) await q(`DELETE FROM wireguard_peer WHERE id=$1`, [id]).catch(() => {});
  for (const id of createdServerIds) await q(`DELETE FROM wireguard_server WHERE id=$1`, [id]).catch(() => {});
  await pool.end().catch(() => {});
}

function extractPrivKey(config) {
  const m = /PrivateKey = ([A-Za-z0-9+/=]+)/.exec(config);
  return m ? m[1] : '';
}
async function oneServer(projectId) {
  const rows = await q(`SELECT * FROM wireguard_server WHERE project_id=$1`, [projectId]);
  return rows[0] || {};
}

console.log(failed ? `\n${failed} FAILED\n` : '\nALL PASSED ✓\n');
process.exit(failed ? 1 : 0);
