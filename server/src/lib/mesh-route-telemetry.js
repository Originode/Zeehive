// MESH ROUTE SOURCE TELEMETRY — counting WHICH world answers `zee routes`, the number that gates
// phase 5 (docs/netbird-mesh-plan.md §3.4, §6 phase 5, §10 follow-up 3).
//
// §3.4's contract makes every route answer carry a `source` ('mesh' | 'legacy-port') so the
// migration is observable per caller, and §6 says phase 5 (drop the generated per-xell `ports:`,
// remove the allocator) ships only once that telemetry shows no `legacy-port` consumers for
// per-xell targets. This module IS that telemetry: one counter bump per answered target kind per
// UTC day (migration 254's mesh_route_stat), and the per-day tally read back.
//
// THE DERIVATION STAYS PURE (lib/mesh-routes.js). `routeSources()` classifies a finished payload
// with no db and no clock, and `tallyFromRows()` sums rows with no db, so both are table-testable
// exactly like the derivation they describe and the SQL's whole job is to hand over a small,
// window-bounded row set — the same split lib/delivery-telemetry.js keeps.
//
// THE WRITE IS BEST-EFFORT AND BOUNDED. A telemetry row must never fail the answer it describes:
// recordRouteSources() swallows every error and logs one line, and a database that has not applied
// migration 254 degrades to "no telemetry", never to a broken `zee routes`. The same contract the
// LLM gateway ledger keeps (lib/gateway.js recordRequest).
import { q } from '../db/pool.js';
import { logline } from './logbus.js';

const KINDS = ['db', 'server', 'webapp'];
// The two worlds §3.4 names. Kept verbatim (hyphen and all) everywhere they are reported, so the
// tally speaks the contract's own vocabulary instead of a second name for it.
export const SOURCES = ['mesh', 'legacy-port'];
export const WINDOW_DAYS_DEFAULT = 14;
const WINDOW_DAYS_MAX = 90;

// Which world answered each role of a FINISHED payload — PURE (payload in, rows out). Only the
// three known target kinds and the two known sources: an unrecognized value is skipped rather than
// counted into a bucket nobody reads. A role with no container has no answer and no row.
export function routeSources(payload) {
  const out = [];
  for (const target_kind of KINDS) {
    const source = payload?.routes?.[target_kind]?.source;
    if (SOURCES.includes(source)) out.push({ target_kind, source });
  }
  return out;
}

// The tally, summed from rows — PURE. Every bucket starts at zero so an empty window reads as
// "nothing recorded" rather than as a missing section, and `days` stays the raw per-day rows.
export function tallyFromRows(rows) {
  const days = (rows || []).map((r) => ({
    day: String(r.day), target_kind: String(r.target_kind), source: String(r.source),
    n: Number(r.n) || 0,
  }));
  const by_source = Object.fromEntries(SOURCES.map((s) => [s, 0]));
  const by_kind = Object.fromEntries(
    KINDS.map((k) => [k, Object.fromEntries(SOURCES.map((s) => [s, 0]))]));
  for (const r of days) {
    if (!(r.source in by_source) || !(r.target_kind in by_kind)) continue;
    by_source[r.source] += r.n;
    by_kind[r.target_kind][r.source] += r.n;
  }
  return { by_source, by_kind, days };
}

// Bump the counter: ONE statement, at most three rows (the three target kinds), the day computed
// in SQL against UTC so every writer agrees regardless of any local timezone setting. Returns how
// many answer-roles were recorded — 0 when there was nothing to record or the write failed, which
// is the whole contract the caller needs. See the header: never throws.
export async function recordRouteSources(payload) {
  const rows = routeSources(payload);
  if (!rows.length) return 0;
  try {
    await q(
      `INSERT INTO mesh_route_stat (day, target_kind, source, n, first_at, last_at)
       SELECT (now() AT TIME ZONE 'UTC')::date, t.kind, t.source, 1, now(), now()
         FROM unnest($1::text[], $2::text[]) AS t(kind, source)
       ON CONFLICT (day, target_kind, source)
       DO UPDATE SET n = mesh_route_stat.n + 1, last_at = now()`,
      [rows.map((r) => r.target_kind), rows.map((r) => r.source)]);
    return rows.length;
  } catch (e) {
    logline('mesh', `route telemetry: could not record ${rows.length} route source(s) `
      + `(${String(e.message).slice(0, 120)})`);
    return 0;
  }
}

// The per-day tally over a window (default a fortnight — long enough that phase 5's "no legacy-port
// consumers" question is answered by more than one day). Soft-fails like the fleet's spend read
// (lib/fleet.js readSpendByProvider): a database that has not applied migration 254 answers an
// `error` beside empty buckets rather than failing the `zee routes --tally` read that shows it.
export async function meshRouteTally({ days = WINDOW_DAYS_DEFAULT } = {}) {
  const d = Math.min(Math.max(Math.round(Number(days) || WINDOW_DAYS_DEFAULT), 1), WINDOW_DAYS_MAX);
  try {
    const rows = await q(
      `SELECT day::text AS day, target_kind, source, n::int AS n
         FROM mesh_route_stat
        WHERE day >= (now() AT TIME ZONE 'UTC')::date - ($1::int - 1)
        ORDER BY day DESC, target_kind, source`, [d]);
    return { window_days: d, ...tallyFromRows(rows), error: null };
  } catch (e) {
    return { window_days: d, ...tallyFromRows([]), error: e.message };
  }
}
