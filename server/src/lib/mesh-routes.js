// MESH ROUTES — the router's DIRECTORY half (docs/netbird-mesh-plan.md §3.4): the one answer to
// "how do I reach my stuff?", derived AT CALL TIME from the meta-DB + mesh_peer, never baked.
// This is the fix for the whole baked-env rot class (a cage's env is stamped at container
// creation and never re-minted — TKT-179's cage-age condition, TKT-184's silent wrong default,
// a dead shared-dev DSN): a zee that gets ECONNREFUSED asks `zee routes` and gets what is true NOW.
//
// The derivation is PURE (rows in, payload out) so every branch is table-testable; the gathering
// and the liveness probe live with the caller (queenzee/self.js selfRoutes).
//
// Contract points (§3.4, decided in the plan because callers are stuck with them):
//   * `source` says which world answered: 'mesh' | 'legacy-port' — migration is observable per
//     caller, and phase 5 (stop publishing ports) is gated on this telemetry.
//   * mesh answers only for roles the xell OWNS — its own stack sits behind its own peer. A USED
//     shared container (the shared dev db) is a MACHINE peer's to answer for (phase 2); until
//     that peer exists its row stays the legacy answer.
//   * when mesh answers, `fallback` still carries the legacy pair — dual-stack during migration.
//   * the DSN keeps the legacy credentials/database and swaps only the address: the mesh moves
//     packets, not identities.
import net from 'node:net';

// Canonical per-role ports: the manifest's spinoff `internal` declarations, with compose-gen's
// INTERNAL_DEFAULTS as the fallback (the same values the generated compose serves on).
const INTERNAL_DEFAULTS = { server: 3000, webapp: 5173, db: 5432 };
export function canonicalPort(role, manifest) {
  const decl = manifest?.tiers?.spinoff?.ports?.[role] || {};
  return Number(decl.internal) || INTERNAL_DEFAULTS[role] || null;
}

// Re-address a DSN: same credentials, same database, a different door. Null on an unparseable
// DSN — the caller then keeps the legacy answer rather than emitting a half-true one.
export function dsnAt(dsn, host, port) {
  if (!dsn || !host || !port) return null;
  try {
    const u = new URL(String(dsn).replace(/^postgres(ql)?:/, 'http:'));
    u.hostname = host;
    u.port = String(port);
    return String(u).replace(/^http:/, 'postgresql:');
  } catch {
    return null;
  }
}

// The payload. rows: owned/used container rows; peer: the xell's ACTIVE mesh_peer row or null;
// machinePeers: the ACTIVE kind='machine' mesh_peer rows (each with its machine's docker_ctx) that
// answer for USED shared containers (a shared dev db is the MACHINE's peer to answer for, never the
// xell's — phase 2, docs/netbird-mesh-plan.md §3.2); legacyDsn/dsnSource: resolveXellDsn's current
// answer (the projection .zeehive.env carries).
export function deriveXellRoutes({ xell, manifest, owned = [], used = [], peer = null,
                                   machinePeers = [], legacyDsn = null, dsnSource = null,
                                   meshDomain = null, meshEnabled = false }) {
  const fqdn = peer && meshDomain ? `${peer.hostname}.${meshDomain}` : peer?.hostname || null;
  const meshReady = Boolean(peer && (peer.ip || peer.status === 'joined'));
  const machineReady = (mp) => Boolean(mp && (mp.ip || mp.status === 'joined'));
  const roleRow = (role) =>
    owned.find((c) => c.role === role) || used.find((c) => c.role === role) || null;
  // A USED shared container answers mesh through the MACHINE peer that shares its docker context
  // (the host's own agent — reach the shared singleton at the host peer's mesh IP + published port).
  const machinePeerFor = (row) => {
    if (!row || row.docker_ctx == null) return null;
    return machinePeers.find((mp) => mp.docker_ctx === row.docker_ctx) || null;
  };
  const fqdnOf = (hostname) => (hostname && meshDomain ? `${hostname}.${meshDomain}` : hostname || null);

  const legacyOf = (row) => (row ? {
    host: row.host != null ? String(row.host) : null,
    port: row.host_port != null ? Number(row.host_port) : null,
    ...(row.url ? { url: row.url } : {}),
    source: 'legacy-port',
  } : null);

  const routes = {};
  const fallback = {};
  for (const role of ['db', 'server', 'webapp']) {
    const row = roleRow(role);
    const legacy = legacyOf(row);
    const ownsRole = owned.some((c) => c.role === role);
    const hostPeer = !ownsRole ? machinePeerFor(row) : null;   // used shared → machine's to answer
    if (meshReady && ownsRole) {
      const port = canonicalPort(role, manifest);
      const addr = peer.ip != null ? String(peer.ip) : fqdn;
      routes[role] = {
        hostname: fqdn,
        ip: peer.ip != null ? String(peer.ip) : null,
        port,
        source: 'mesh',
        ...(role === 'db' ? {} : { url: `http://${addr}:${port}` }),
      };
      if (legacy) fallback[role] = legacy;
    } else if (hostPeer && machineReady(hostPeer)) {
      // A shared singleton keeps its published port (it is few and static — not the exhaustion
      // source, §3.2); the MESH moves the packets to the host, the port stays the same.
      const hpFqdn = fqdnOf(hostPeer.hostname);
      const addr = hostPeer.ip != null ? String(hostPeer.ip) : hpFqdn;
      const port = row.host_port != null ? Number(row.host_port) : null;
      routes[role] = {
        hostname: hpFqdn,
        ip: hostPeer.ip != null ? String(hostPeer.ip) : null,
        port,
        source: 'mesh',
        ...(role === 'db' ? {} : (port ? { url: `http://${addr}:${port}` } : {})),
      };
      if (legacy) fallback[role] = legacy;
    } else {
      routes[role] = legacy;
    }
  }

  // The db route carries the DSN a client can use verbatim. Mesh re-addresses the legacy DSN
  // (same credentials/database, the peer's door); an unparseable legacy DSN keeps the legacy
  // answer whole rather than shipping a half-true mesh one.
  if (routes.db) {
    if (routes.db.source === 'mesh') {
      const meshDsn = dsnAt(legacyDsn, routes.db.ip || routes.db.hostname, routes.db.port);
      if (meshDsn) routes.db.dsn = meshDsn;
      else {
        routes.db = { ...(fallback.db || routes.db), source: 'legacy-port' };
        delete fallback.db;
        if (legacyDsn) routes.db.dsn = legacyDsn;
      }
    } else if (legacyDsn) {
      routes.db.dsn = legacyDsn;
    }
    if (routes.db) routes.db.dsn_source = dsnSource;
  }

  return {
    ok: true,
    mesh: {
      enabled: meshEnabled,
      domain: meshDomain,
      peer: peer ? { hostname: peer.hostname, status: peer.status,
                     ip: peer.ip != null ? String(peer.ip) : null } : null,
    },
    routes,
    ...(Object.keys(fallback).length ? { fallback } : {}),
  };
}

// Bounded TCP dial — LIVENESS ADVICE on an answer, never a gate (the same dial preview-ports
// uses to notice a dead upstream). 'unknown' when there is nothing to dial.
export function probeTcp(host, port, ms = 400) {
  if (!host || !port) return Promise.resolve('unknown');
  return new Promise((res) => {
    const s = net.connect({ host, port: Number(port) });
    const done = (v) => { try { s.destroy(); } catch { /* already gone */ } res(v); };
    s.once('connect', () => done('ok'));
    s.once('error', () => done('refused'));
    s.setTimeout(ms, () => done('unknown'));
  });
}
