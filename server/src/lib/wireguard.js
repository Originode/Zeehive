// WireGuard mesh — ZEEHIVE operated (docs/common-xell-network-plan.md, Decision 5.4). This is the
// CONFIG-AND-KEY layer, not the interface layer: it mints the mesh identity (server keys), allocates
// tunnel IPs, mints peer keypairs, and renders the exact `.conf` a human (or another machine) needs
// to join. Running the WG interface itself is the fleet's docker/wg responsibility, not this repo's
// (see the migration 152 comment).
//
// Keys are Curve25519, which Node's crypto generates natively (verified: x25519 JWK export gives
// the 32-byte base64 keys WireGuard uses). No wireguard-tools dependency to MINT configs.
//
// The "download the config" ask: a human opens a button in the console, we mint a fresh keypair,
// allocate a tunnel IP, INSERT the peer row (public key only — the private key is handed back once
// in the config text and never stored), and serve the text as a download. The human imports it into
// their WG client and can reach the ZEEHIVE-controlled machines on the tunnel.
import { generateKeyPairSync } from 'node:crypto';
import { q, one } from '../db/pool.js';
import { logline } from './logbus.js';

// WireGuard keys are 32 raw bytes, base64-encoded (44 chars with '=' padding). Curve25519.
function base64ToWg(buf) {
  return Buffer.from(buf).toString('base64');
}
function wgToBase64(b64) {
  return Buffer.from(b64, 'base64');
}

// Generate a fresh WG keypair from Node's native x25519.
export function wgKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  const pub = publicKey.export({ format: 'jwk' });
  const priv = privateKey.export({ format: 'jwk' });
  return {
    publicKey: base64ToWg(Buffer.from(pub.x, 'base64url')),
    privateKey: base64ToWg(Buffer.from(priv.d, 'base64url')),
  };
}

// The default WG address space. The server is .1, peers are .2 onwards.
const DEFAULT_ADDR = '10.8.0.1/24';
const DEFAULT_ENDPOINT = '10.2.0.16:51820';   // the fleet's primary reachable host; overridable at bootstrap
const PEER_BASE = 2;                          // .2 is the first allocatable peer address

// Allocate the next tunnel IP for a server's address space. The server's /24 prefix is the
// authoritative pool; peers fill .2, .3, … . Returns the /32 address string for one peer, or null
// when the /24 is exhausted (256 peers — a hard stop, not a wrap).
async function nextPeerAddress(serverId, prefix) {
  const rows = await q(`SELECT address FROM wireguard_peer WHERE server_id=$1 ORDER BY address`, [serverId]);
  const used = new Set(rows.map((r) => r.address.split('/')[0]));
  // prefix is like '10.8.0' (the first three octets of the /24).
  for (let i = PEER_BASE; i < 255; i++) {
    const ip = `${prefix}.${i}`;
    if (!used.has(ip)) return `${ip}/32`;
  }
  return null;
}

// Get (or lazily create) THIS project's WG server row. If none exists, mint the mesh identity now
// with the default address space and endpoint; the human can re-point the endpoint via the console.
// Returns the row. Never throws for a missing row — the first download call bootstraps the mesh.
export async function ensureWireguardServer(projectId, { endpoint = null, address = null } = {}) {
  const existing = await one(`SELECT * FROM wireguard_server WHERE project_id=$1`, [projectId]);
  if (existing) return existing;
  const keys = wgKeyPair();
  const addr = address || DEFAULT_ADDR;
  const ep = endpoint || DEFAULT_ENDPOINT;
  const row = await one(
    `INSERT INTO wireguard_server (project_id, private_key, public_key, endpoint, address)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [projectId, keys.privateKey, keys.publicKey, ep, addr]);
  logline('wireguard', `bootstrapped the WG mesh for project ${String(projectId).slice(0, 8)}: `
    + `endpoint ${ep}, address ${addr}, pubkey ${keys.publicKey.slice(0, 8)}…`);
  return row;
}

// The 3-octet prefix of a /24 address (used for peer allocation). The default is 10.8.0.
function prefixOf(address) {
  const m = /^(\d+\.\d+\.\d+)\.\d+\/\d+$/.exec(address);
  return m ? m[1] : '10.8.0';
}

// Mint ONE peer: a fresh keypair, an allocated tunnel IP, and the config text that human/machine
// imports. Returns { config, peer } where config is the ready-to-save .conf text. The private key
// appears ONLY in the returned config — never stored (the peer row keeps only the public key).
export async function mintPeerConfig(projectId, { name = null, dns = null } = {}) {
  const server = await ensureWireguardServer(projectId);
  const prefix = prefixOf(server.address);
  const address = await nextPeerAddress(server.id, prefix);
  if (!address) throw new Error(`WG mesh ${server.address} is full — no peer IP left (256 peers)`);

  const keys = wgKeyPair();
  const label = name || `peer-${address.split('/')[0]}`;
  const row = await one(
    `INSERT INTO wireguard_peer (server_id, name, public_key, address, endpoint_snapshot, dns)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [server.id, label, keys.publicKey, address, server.endpoint, dns || null]);

  const config = renderPeerConfig({ server, peer: { ...row, privateKey: keys.privateKey } });
  logline('wireguard', `minted a WG peer config for '${label}' on ${server.address} → ${address}`);
  return { config, peer: row, server };
}

// Render the exact .conf a WG client imports. [Interface] is the peer's own keypair + tunnel IP;
// [Peer] is the server (endpoint, public key, and AllowedIPs = the whole mesh so the peer can reach
// every ZEEHIVE machine on the tunnel).
export function renderPeerConfig({ server, peer }) {
  const allowedIPs = server.address.replace(/\/\d+$/, '/24');   // the whole mesh, not just .1
  return `# ZEEHIVE WireGuard — ${peer.name || 'peer'} (generated ${new Date().toISOString()})
# Join the mesh: import this file into your WireGuard client, then 'up'.
# The private key lives ONLY in this file — it is never stored server-side.
[Interface]
PrivateKey = ${peer.privateKey}
Address = ${peer.address}
${peer.dns ? `DNS = ${peer.dns}\n` : ''}
[Peer]
# ZEEHIVE WG server
PublicKey = ${server.public_key}
Endpoint = ${peer.endpoint_snapshot}
AllowedIPs = ${allowedIPs}
PersistentKeepalive = 25
`;
}

// Mark a peer's config as downloaded (audit + "this peer is live").
export async function markPeerDownloaded(peerId) {
  const row = await one(`UPDATE wireguard_peer SET downloaded_at=now() WHERE id=$1 RETURNING *`, [peerId]);
  return row;
}

// Read the mesh state for the console: the server (public key, endpoint, address) and its peers.
export async function wireguardStatus(projectId) {
  const server = await one(`SELECT * FROM wireguard_server WHERE project_id=$1`, [projectId]);
  if (!server) return { enabled: false, server: null, peers: [] };
  const peers = await q(
    `SELECT id, name, public_key, address, endpoint_snapshot, dns, created_at, downloaded_at
       FROM wireguard_peer WHERE server_id=$1 ORDER BY created_at`, [server.id]);
  return {
    enabled: true,
    server: {
      id: server.id, public_key: server.public_key, endpoint: server.endpoint,
      address: server.address, listen_port: server.listen_port, created_at: server.created_at,
    },
    peers,
  };
}
