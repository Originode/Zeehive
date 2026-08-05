// OPS REVIEW — the queenzee's own operations, read back as ONE digest (the minister's verb).
//
// A MINISTER (a manager-type zee wearing the `queenzee-minister` harness) exists to criticise the
// QUEENZEE: where landings sit waiting, which ships failed and why, what the fleet burns in tokens,
// which loops are logging errors. Until this file, that evidence was scattered across the log ring,
// four gate tables, the zee burn columns and the backup ledger — readable one screen at a time in
// the console, and not at all from inside a cage. `opsDigest()` is that evidence in one answer.
//
// READ-ONLY BY CONSTRUCTION: every query below is a SELECT and the log ring is process memory.
// Nothing here opens a gate, writes a row or touches a container — criticism that could ACT would
// be a second queenzee, and the whole point of the minister is that its output is TICKETS a human
// or a manager decides to take up (lib/tickets.js), never actions.
//
// FLEET-WIDE on purpose: the queenzee is one orchestrator over every project, so an efficiency
// review scoped to one project would miss exactly the cross-project queues (one runway per ref,
// one prod lock, one pool) it is asked to judge. Rows carry their project name instead.
import { q, one } from '../db/pool.js';
import { recentLogs } from './logbus.js';

// What counts as a WARNING/ERROR in the queenzee's own log. The ring has no severity column —
// loops write prose — so severity is a match, the same way a human's eye finds it in the terminal
// modal. '!!!' is the house convention for "loud" (see installZeeCliIntoCxell, the ship scripts).
export const ALERT_RE = /!!!|\berror\b|\bfail(?:ed|ure|s)?\b|refus|declin|\bstale\b|timeout|timed out|unreachable|cannot|could not|missing|conflict/i;

const num = (v) => Number(v || 0);

export async function opsDigest({ hours = 24, logN = 300 } = {}) {
  const h = Math.min(Math.max(Number(hours) || 24, 1), 24 * 14);   // 1h .. 14d
  const n = Math.min(Math.max(Number(logN) || 300, 20), 2000);     // the ring holds 2000
  const since = `now() - interval '1 hour' * ${h}`;

  // ── the queenzee's own log ring: the tail, and the lines that look like trouble ─────────────
  const logs = recentLogs(n);
  const alerts = logs.filter((l) => ALERT_RE.test(l.msg));

  // ── LANDINGS: counts by status over the window, and every row still open (whatever its age) ──
  const landCounts = await q(
    `SELECT status::text, count(*)::int AS n FROM land_request
      WHERE requested_at > ${since} GROUP BY status ORDER BY status`);
  const landOpen = await q(
    `SELECT l.id, l.ref, left(l.new_sha, 10) AS sha, l.status::text, l.attempts,
            l.requested_at, x.slug AS xell, p.name AS project,
            round(extract(epoch FROM now() - l.requested_at))::int AS waiting_sec
       FROM land_request l LEFT JOIN xell x ON x.id = l.xell_id
       JOIN project p ON p.id = l.project_id
      WHERE l.status IN ('pending','approved')
      ORDER BY l.requested_at`);
  const landRecent = await q(
    `SELECT l.id, l.ref, left(l.new_sha, 10) AS sha, l.status::text, l.attempts, l.note,
            l.requested_at, l.decided_at, l.landed_at, x.slug AS xell, p.name AS project,
            round(extract(epoch FROM COALESCE(l.decided_at, l.landed_at, now()) - l.requested_at))::int AS decision_sec
       FROM land_request l LEFT JOIN xell x ON x.id = l.xell_id
       JOIN project p ON p.id = l.project_id
      WHERE l.requested_at > ${since}
      ORDER BY l.requested_at DESC LIMIT 40`);

  // ── SHIPS: the failures carry their error text — that is what a critic reads first ──────────
  const shipCounts = await q(
    `SELECT status::text, count(*)::int AS n FROM ship_request
      WHERE requested_at > ${since} GROUP BY status ORDER BY status`);
  const shipRecent = await q(
    `SELECT s.id, s.status::text, left(COALESCE(s.commit,''), 10) AS commit, s.reason, s.error,
            s.requested_at, s.decided_at, s.finished_at, x.slug AS xell, p.name AS project,
            round(extract(epoch FROM s.finished_at - s.started_at))::int AS ship_sec,
            round(extract(epoch FROM COALESCE(s.decided_at, now()) - s.requested_at))::int AS decision_sec
       FROM ship_request s LEFT JOIN xell x ON x.id = s.xell_id
       JOIN project p ON p.id = s.project_id
      WHERE s.requested_at > ${since} OR s.status IN ('pending','approved','shipping')
      ORDER BY s.requested_at DESC LIMIT 40`);

  // ── the other two human gates: prod binds and seeds still waiting ────────────────────────────
  const prodBinds = await q(
    `SELECT b.status, b.reason, b.requested_at, x.slug AS xell, p.name AS project,
            round(extract(epoch FROM now() - b.requested_at))::int AS waiting_sec
       FROM prod_bind_request b JOIN xell x ON x.id = b.xell_id
       JOIN project p ON p.id = b.project_id
      WHERE b.status = 'pending' OR b.requested_at > ${since}
      ORDER BY b.requested_at DESC LIMIT 20`);
  const seeds = await q(
    `SELECT s.status, s.reason, s.files, s.requested_at, s.xell_slug AS xell, p.name AS project,
            round(extract(epoch FROM now() - s.requested_at))::int AS waiting_sec
       FROM prod_seed_request s JOIN project p ON p.id = s.project_id
      WHERE s.status = 'pending' OR s.requested_at > ${since}
      ORDER BY s.requested_at DESC LIMIT 20`);

  // ── FLEET: what the hive is doing right now, and who is waiting on a human ──────────────────
  const xells = await q(
    `SELECT COALESCE(x.zee_type,'worker') AS zee_type, x.status, count(*)::int AS n
       FROM xell x WHERE x.status <> 'retired'
      GROUP BY 1, 2 ORDER BY 1, 2`);
  const tends = await q(
    `SELECT x.slug AS xell, p.name AS project, se.raw->>'reason' AS reason, se.ts,
            round(extract(epoch FROM now() - se.ts))::int AS waiting_sec
       FROM xell x JOIN project p ON p.id = x.project_id
       JOIN LATERAL (
         SELECT e.hook_event_name, e.raw, e.ts FROM session_event e
          WHERE e.xell_id = x.id AND e.hook_event_name IN ('tend-request','tend-clear')
          ORDER BY e.ts DESC LIMIT 1) se ON true
      WHERE x.status <> 'retired' AND se.hook_event_name = 'tend-request'
      ORDER BY se.ts`);

  // ── BURN: where the tokens actually go (migration 030's per-run counters) ───────────────────
  const burnTotal = await one(
    `SELECT COALESCE(SUM(z.input_tokens),0)::bigint AS input,
            COALESCE(SUM(z.output_tokens),0)::bigint AS output,
            COALESCE(SUM(z.cache_read_tokens),0)::bigint AS cache_read,
            COALESCE(SUM(z.cache_write_tokens),0)::bigint AS cache_write,
            COALESCE(SUM(z.cost_usd),0) AS cost, COUNT(z.id)::int AS zees
       FROM zee z WHERE COALESCE(z.last_event_at, z.created_at) > ${since}`);
  const burnTop = await q(
    `SELECT x.slug AS xell, p.name AS project, z.model, z.status::text,
            (z.input_tokens + z.output_tokens + z.cache_read_tokens + z.cache_write_tokens)::bigint AS tokens,
            z.input_tokens::bigint AS input, z.output_tokens::bigint AS output,
            z.cache_read_tokens::bigint AS cache_read, z.cache_write_tokens::bigint AS cache_write,
            z.cost_usd AS cost, z.created_at, z.last_event_at
       FROM zee z JOIN xell x ON x.id = z.xell_id JOIN project p ON p.id = x.project_id
      WHERE COALESCE(z.last_event_at, z.created_at) > ${since}
      ORDER BY tokens DESC LIMIT 15`);

  // ── BACKUPS: the last snapshot per project, and anything that failed in the window ──────────
  const backups = await q(
    `SELECT DISTINCT ON (s.project_id)
            p.name AS project, s.status, s.error, s.taken_at, s.size_bytes,
            round(extract(epoch FROM now() - s.taken_at))::int AS age_sec
       FROM db_snapshot s JOIN project p ON p.id = s.project_id
      WHERE s.source = 'prod'
      ORDER BY s.project_id, s.taken_at DESC`);
  const backupFailures = await q(
    `SELECT p.name AS project, s.status, s.error, s.taken_at
       FROM db_snapshot s JOIN project p ON p.id = s.project_id
      WHERE s.status = 'failed' AND s.taken_at > ${since}
      ORDER BY s.taken_at DESC LIMIT 20`);

  const counts = (rows) => Object.fromEntries(rows.map((r) => [r.status, r.n]));
  return {
    ok: true,
    generated_at: new Date().toISOString(),
    window_hours: h,
    logs: { n: logs.length, lines: logs },
    alerts: { n: alerts.length, lines: alerts },
    landings: { counts: counts(landCounts), open: landOpen, recent: landRecent },
    ships: { counts: counts(shipCounts), recent: shipRecent },
    prod_binds: prodBinds,
    seeds,
    fleet: { xells, tends },
    burn: {
      window: { input: num(burnTotal?.input), output: num(burnTotal?.output),
                cache_read: num(burnTotal?.cache_read), cache_write: num(burnTotal?.cache_write),
                cost: num(burnTotal?.cost), zees: num(burnTotal?.zees) },
      top: burnTop.map((r) => ({ ...r, tokens: num(r.tokens), input: num(r.input), output: num(r.output),
                                 cache_read: num(r.cache_read), cache_write: num(r.cache_write), cost: num(r.cost) })),
    },
    backups: { latest: backups, failures: backupFailures },
  };
}

export default { opsDigest, ALERT_RE };
