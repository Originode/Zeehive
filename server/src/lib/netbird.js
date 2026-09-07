// NETBIRD — the mesh control-plane client and peer lifecycle (docs/netbird-mesh-plan.md §3/§5).
//
// NetBird is the ZEEHIVE-operated WireGuard mesh's management plane (the part Decision 5.4 of
// docs/common-xell-network-plan.md named as the hard, unbuilt work: peer lifecycle, IP
// allocation, DNS, ACLs — bought, not built). This module is the ONE place its REST API is
// spoken, in the same testable shape as build-readiness/docker-repair: every call goes through
// an injected bounded adapter, answers a verdict object, and never throws for an outcome —
// an unreachable control plane must degrade a provision/reap to legacy behaviour, never hang it.
//
// AUTHORITY SPLIT (the mesh_peer table's contract, migration 249):
//   meta-DB       = INTENT — which peers should exist. A control-plane peer with no active row
//                   is a leak; sweepOrphanMeshPeers removes it ONLY when the row says removed
//                   or the slug resolves to a retired xell (an unknown hostname is reported,
//                   never deleted — the docker-repair stance on a shared resource).
//   control plane = LIVE state — the assigned IP, connectedness. Cached onto the row at join.
//
// The management API token is queenzee config (env), never a row; a minted setup key is
// returned ONCE to the caller (for injection into the joining agent's env) and never stored —
// only its id rides on the row, for audit.
import { q, one } from '../db/pool.js';
import { config } from '../config.js';
import { logline } from './logbus.js';

// Both knobs present = the mesh exists for this queenzee. Absent = every entry point below is a
// legible no-op, so callers never need their own guard.
export function meshEnabled() {
  return Boolean(config.netbirdApiUrl && config.netbirdApiToken);
}

// The mesh hostname's fully-qualified form (<hostname>.<mesh-domain>) — what a resolver on the
// mesh answers. PURE, so URL/DSN derivation is table-testable.
export function meshFqdn(hostname) {
  return hostname ? `${hostname}.${config.meshDomain}` : null;
}

// ── the bounded adapter (injectable; the default speaks HTTP to the management API) ──────────────
// Answers { status, json, reason? } and NEVER throws: status 0 = transport failure, reason says why.
export async function netbirdRequest(method, path, body, { timeoutMs = 8000 } = {}) {
  if (!meshEnabled()) return { status: 0, json: null, reason: 'mesh disabled (no NETBIRD_API_URL/TOKEN)' };
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(new URL(path, config.netbirdApiUrl), {
      method,
      headers: { Authorization: `Token ${config.netbirdApiToken}`, 'Content-Type': 'application/json' },
      body: body == null ? undefined : JSON.stringify(body),
      signal: ctl.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* a non-JSON body rides as null */ }
    return { status: res.status, json };
  } catch (e) {
    return { status: 0, json: null, reason: e.message };
  } finally {
    clearTimeout(t);
  }
}

const failed = (r, what) => ({
  ok: false,
  reason: `${what}: ${r.reason || `HTTP ${r.status}${r.json?.message ? ` — ${r.json.message}` : ''}`}`,
});

// ── the management API, one function per verb the plan names (§5) ───────────────────────────────

// A setup key for ONE peer: ephemeral and usage-limit 1 by default, so a leaked key mints nothing
// extra; auto_groups stamp the joining peer's group membership at the control plane.
export async function createSetupKey({ name, autoGroups = [], expiresInSec = 3600,
                                       ephemeral = true, usageLimit = 1 } = {},
                                     { request = netbirdRequest } = {}) {
  const r = await request('POST', '/api/setup-keys', {
    name, type: 'one-off', expires_in: expiresInSec, auto_groups: autoGroups,
    usage_limit: usageLimit, ephemeral,
  });
  if (r.status !== 200 && r.status !== 201) return failed(r, `setup-key '${name}'`);
  return { ok: true, id: r.json?.id, key: r.json?.key };
}

export async function listPeers({ request = netbirdRequest } = {}) {
  const r = await request('GET', '/api/peers');
  if (r.status !== 200 || !Array.isArray(r.json)) return failed(r, 'list peers');
  // A copy, deliberately: the sweep iterates this list WHILE deleting peers, and an adapter that
  // hands back a live array (a test stub, a caching layer) would skip elements mid-iteration.
  return { ok: true, peers: [...r.json] };
}

// The peer a hostname resolved to, or null when none — an absent peer is data, not a failure.
export async function getPeerByHostname(hostname, { request = netbirdRequest } = {}) {
  const r = await listPeers({ request });
  if (!r.ok) return r;
  const peer = r.peers.find((p) => p.hostname === hostname || p.dns_label === hostname) || null;
  return { ok: true, peer };
}

// Idempotent: a 404 is the outcome we wanted (gone), same stance as stopAndRemoveContainer.
export async function deletePeer(nbPeerId, { request = netbirdRequest } = {}) {
  if (!nbPeerId) return { ok: true, alreadyGone: true };
  const r = await request('DELETE', `/api/peers/${encodeURIComponent(nbPeerId)}`);
  if (r.status === 200 || r.status === 204) return { ok: true, deleted: true };
  if (r.status === 404) return { ok: true, alreadyGone: true };
  return failed(r, `delete peer ${nbPeerId}`);
}

// Find-or-create a group by name; the id is what setup keys' auto_groups want.
export async function ensureGroup(name, { request = netbirdRequest } = {}) {
  const ls = await request('GET', '/api/groups');
  if (ls.status !== 200 || !Array.isArray(ls.json)) return failed(ls, `list groups (for '${name}')`);
  const hit = ls.json.find((g) => g.name === name);
  if (hit) return { ok: true, id: hit.id, created: false };
  const mk = await request('POST', '/api/groups', { name });
  if (mk.status !== 200 && mk.status !== 201) return failed(mk, `create group '${name}'`);
  return { ok: true, id: mk.json?.id, created: true };
}

// ── the peer lifecycle against the meta-DB (mesh_peer, migration 249) ───────────────────────────

// Mint a peer for a fleet noun: group ensured, one-shot setup key created, INTENT row inserted.
// The key is in the ANSWER ONLY (inject it into the joining agent's env; it is never stored).
// Mesh disabled → a legible no-op the provisioner can ride straight past.
export async function mintPeer({ projectId, kind, hostname, xellId = null, machineId = null },
                               { request = netbirdRequest } = {}) {
  if (!meshEnabled()) return { ok: false, disabled: true, reason: 'mesh disabled' };
  if (!projectId || !kind || !hostname) return { ok: false, reason: 'mintPeer needs projectId, kind, hostname' };
  const group = await ensureGroup(`${kind}s`, { request });
  if (!group.ok) return group;
  const key = await createSetupKey({ name: `zeehive:${kind}:${hostname}`, autoGroups: [group.id] }, { request });
  if (!key.ok) return key;
  const row = await one(
    `INSERT INTO mesh_peer (project_id, kind, hostname, xell_id, machine_id, nb_setup_key_id)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [projectId, kind, hostname, xellId, machineId, key.id]);
  logline('mesh', `minted ${kind} peer '${hostname}' (setup key ${key.id})`);
  return { ok: true, row, setupKey: key.key };
}

// Stamp the LIVE half onto the row once the agent has joined: the control plane's id and IP.
export async function markPeerJoined(hostname, { request = netbirdRequest } = {}) {
  const r = await getPeerByHostname(hostname, { request });
  if (!r.ok) return r;
  if (!r.peer) return { ok: false, reason: `no control-plane peer answers to '${hostname}' yet` };
  const row = await one(
    `UPDATE mesh_peer SET nb_peer_id=$2, ip=$3, status='joined'
      WHERE hostname=$1 AND removed_at IS NULL RETURNING *`,
    [hostname, r.peer.id, r.peer.ip || null]);
  if (!row) return { ok: false, reason: `no active mesh_peer row for '${hostname}'` };
  return { ok: true, row };
}

// The health-monitor companion to markPeerJoined (docs/netbird-mesh-plan.md §3.3 / §6 phase 3):
// a MINTED xell sidecar row says "this xell intends a mesh peer, and the sidecar agent should
// register with the control plane shortly after its stack comes up". The monitor asks the control
// plane whether it has — stamps JOINED the ones that answer, leaves the rest minted for the next
// tick. A sidecar has no container row (its health is the control plane's business, not docker
// ps), so this control-plane probe IS the monitor path for the mesh half of the lifecycle.
//
// Best-effort by contract, same as every mesh entry point: an unreachable control plane is a
// legible no-op here, never a reason the health tick fails. Only transitions are logged — a peer
// that has not registered yet (sidecar still starting) is the normal state of a fresh provision,
// and shouting about it every 30s would be the health line's "changed only" discipline broken in
// a new place.
export async function markJoinedMeshPeers({ request = netbirdRequest } = {}) {
  if (!meshEnabled()) return { ok: true, skipped: 'mesh disabled', joined: [], pending: 0 };
  const rows = await q(
    `SELECT mp.hostname
       FROM mesh_peer mp
       JOIN xell x ON x.id = mp.xell_id
      WHERE mp.kind = 'xell' AND mp.status = 'minted' AND mp.removed_at IS NULL
        AND x.status <> 'retired'
      ORDER BY mp.created_at`);
  if (!rows.length) return { ok: true, joined: [], pending: 0 };
  const joined = [];
  const waiting = [];
  const problems = [];
  for (const row of rows) {
    const r = await markPeerJoined(row.hostname, { request });
    if (r.ok) { joined.push(row.hostname); continue; }
    // The only "no peer yet" answer markPeerJoined gives is the control plane not listing the
    // hostname; every other failure (an unreachable plane, a 401, a row that vanished) is a
    // problem. A failure to READ the peer list is systemic — every remaining row would hit the
    // same wall, so report it once and stop rather than hammer a down plane once per pending row
    // (each bounded by the adapter's timeout) inside a 30s health tick.
    if (r.reason && r.reason.includes('answers to')) { waiting.push(row.hostname); continue; }
    problems.push(`${row.hostname}: ${r.reason}`);
    if (r.reason && /^list peers/.test(r.reason)) break;
  }
  for (const h of joined) {
    logline('mesh', `peer '${h}' is on the mesh — status stamped joined (sidecar answered)`);
  }
  if (problems.length) {
    logline('mesh', `mesh join sweep problems: ${problems.join('; ')}`);
  }
  return { ok: problems.length === 0, joined, pending: waiting.length + problems.length, problems };
}

// The reap-time step (docs/netbird-mesh-plan.md §3.6): a control-plane peer must never outlive
// its xell. Row stamping is bookkeeping and always happens (like the container-row delete);
// the control-plane DELETE only when the caller may touch the world (`controlPlane` — the
// reaper passes its own destructive verdict) AND the mesh is configured. Best-effort by
// contract: a failure is logged and reported, never thrown into the teardown.
export async function deregisterXellPeers(xellId, { controlPlane = true, request = netbirdRequest } = {}) {
  const rows = await q(
    `SELECT * FROM mesh_peer WHERE xell_id=$1 AND removed_at IS NULL`, [xellId]);
  if (!rows.length) return { ok: true, removed: 0 };
  let removed = 0;
  const problems = [];
  for (const row of rows) {
    if (controlPlane && meshEnabled()) {
      let nbId = row.nb_peer_id;
      if (!nbId) {
        const found = await getPeerByHostname(row.hostname, { request });
        nbId = found.ok ? found.peer?.id : null;
      }
      const del = await deletePeer(nbId, { request });
      if (!del.ok) {
        problems.push(`${row.hostname}: ${del.reason}`);
        logline('mesh', `deregister left control-plane peer '${row.hostname}': ${del.reason}`);
        continue;   // keep the row active so the janitor retries — intent says it must go
      }
    }
    await q(`UPDATE mesh_peer SET status='removed', removed_at=now() WHERE id=$1`, [row.id]);
    removed++;
  }
  if (removed) logline('mesh', `deregistered ${removed} mesh peer(s) for xell ${xellId}`);
  return { ok: problems.length === 0, removed, ...(problems.length ? { problems } : {}) };
}

// The janitor's mesh pass: control-plane peers the meta-DB no longer intends. Deleted ONLY when
// this meta-DB can prove the peer is dead — its row says removed, or its hostname is a RETIRED
// xell's slug. An unknown hostname is reported, never deleted (a shared control plane may carry
// peers this install does not model — the docker-repair unknown-slug stance).
export async function sweepOrphanMeshPeers({ request = netbirdRequest } = {}) {
  if (!meshEnabled()) return { ok: true, skipped: 'mesh disabled', deleted: [], unknown: [] };
  const ls = await listPeers({ request });
  if (!ls.ok) return { ...ls, deleted: [], unknown: [] };
  const deleted = [];
  const unknown = [];
  for (const p of ls.peers) {
    const hostname = p.hostname || p.dns_label;
    if (!hostname) continue;
    const row = await one(
      `SELECT status, removed_at FROM mesh_peer WHERE hostname=$1 ORDER BY created_at DESC LIMIT 1`,
      [hostname]);
    if (row && !row.removed_at) continue;                       // intended — alive by intent
    if (!row) {
      const x = await one(`SELECT status FROM xell WHERE slug=$1`, [hostname]);
      if (!x || x.status !== 'retired') { unknown.push(hostname); continue; }
    }
    const del = await deletePeer(p.id, { request });
    if (del.ok) {
      deleted.push(hostname);
      logline('mesh', `janitor removed orphan control-plane peer '${hostname}'`);
    }
  }
  return { ok: true, deleted, unknown };
}
