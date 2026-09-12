// MESH STATUS — one machine's mesh, as the console can see it (docs/netbird-mesh-plan.md §3.1/§3.2,
// migration 259). The read that answers "is the mesh actually up on this machine, and is anything
// still using the legacy route?" without a human shelling into the host.
//
// THREE FACTS, from three places that are authoritative for different things — the split the whole
// mesh design keeps (lib/netbird.js's header):
//   • MANAGEMENT HEALTH is a bounded TCP dial to the management API (probeManagementApi's pattern,
//     the same one the stand-up's step uses): the port answering IS the fact "the plane serves".
//     TLS is never spoken — the self-signed cert would fail the probe for the wrong reason.
//   • PEER COUNTS come from the meta-DB, which is authoritative for INTENT (migration 249): what
//     this machine has been asked to place on the mesh, by lifecycle status.
//   • THE ROUTE-SOURCE TALLY is lib/mesh-route-telemetry.js's, unchanged: the number phase 5 is
//     gated on. A "summary" here = the by-source/by-kind totals, not the per-day rows.
// Everything is injected (probe, tally) so the offline suite drives it with no docker, no plane and
// no clock, and a database that has not applied 249/254 degrades to empty counts rather than a 500.
import { q } from '../db/pool.js';
import { managementApiTarget, probeManagementApi } from './netbird.js';
import { meshRouteTally } from './mesh-route-telemetry.js';
import { meshConfigFor } from './mesh-config.js';

// The lifecycle states mesh_peer's CHECK allows. Every status starts at zero in the answer, so a
// machine with no peers reads as "nothing minted yet" rather than as a missing section.
export const PEER_STATUSES = ['minted', 'joined', 'removed', 'degraded'];

// PURE: rows of { status, n } → the counts the console renders. Rows may arrive in any order (and a
// pre-249 database arrives as none at all).
export function peerCounts(rows) {
  const by_status = Object.fromEntries(PEER_STATUSES.map((s) => [s, 0]));
  let total = 0;
  for (const r of rows || []) {
    const n = Number(r.n) || 0;
    total += n;
    if (r.status in by_status) by_status[r.status] += n;
  }
  return { total, by_status, active: by_status.minted + by_status.joined + by_status.degraded };
}

// The whole answer for one machine. Never throws for a mesh/db outcome: an unreachable plane is
// `management.ok:false` with its verdict, and an unreadable tally is its `error` — a status page
// that lies green or 500s is worse than one that says "not answering".
export async function meshStatusFor(machine, { probe = probeManagementApi, tally = meshRouteTally,
                                             attempts = 2, url = null } = {}) {
  const cfg = await meshConfigFor(machine.id);
  const target = managementApiTarget({ url });
  let management;
  try {
    // Short and bounded (2 dials, 3s each): a status GET is a read, not the stand-up's retry loop.
    management = await probe({ url, attempts });
  } catch (e) {
    management = { ok: false, ...target, verdict: 'unknown', reason: e.message };
  }
  let peers;
  try {
    const rows = await q(
      `SELECT status, count(*)::int AS n FROM mesh_peer WHERE machine_id=$1 GROUP BY status`,
      [machine.id]);
    const counts = peerCounts(rows);
    // The rows themselves, newest first, for the panel's peer list. Optional on purpose: the
    // COUNTS are the fact, the list is a convenience, and a pre-249 schema must not fail the read.
    let list = [];
    try {
      list = await q(
        `SELECT hostname, kind, status, nb_peer_id, ip FROM mesh_peer
          WHERE machine_id=$1 ORDER BY created_at DESC LIMIT 50`, [machine.id]);
    } catch { /* counts stand alone */ }
    // `counts` is the console's name for `by_status` + total (web/src/Mesh.jsx); both are emitted so
    // neither reader needs a translation layer.
    peers = { ...counts, counts: { ...counts.by_status, total: counts.total }, list };
  } catch (e) {
    peers = { ...peerCounts([]), error: e.message };
  }
  const t = await tally({});
  const routes = { window_days: t.window_days, by_source: t.by_source, by_kind: t.by_kind,
                   days: t.days || [], error: t.error };
  return {
    machine_id: machine.id,
    machine_key: machine.key,
    docker_ctx: machine.docker_ctx,
    mesh: {
      enabled: cfg.enabled,
      applied: cfg.applied,
      api_url: cfg.resolved.values.api_url,
      domain: cfg.resolved.values.mesh_domain,
      api_token: cfg.secrets.api_token,
      readiness: cfg.resolved.readiness,
      updated_at: cfg.updated_at,
      updated_by: cfg.updated_by,
    },
    // `reachable`/`error` are the console's names for `ok`/`reason` (web/src/Mesh.jsx).
    management: { ok: management.ok, reachable: management.ok, host: management.host,
                  port: management.port, verdict: management.verdict, url: management.url,
                  ...(management.reason ? { reason: management.reason, error: management.reason } : {}) },
    peers,
    routes,
    tally: routes,
  };
}
