// DELIVERY TELEMETRY — "is this fleet getting faster or slower, and where is the waste?", per
// project, over a window, as ONE read model.
//
// Every number below was answerable before this file — by hand, in psql, against the live meta-DB,
// which is exactly the problem: the questions a human actually asks about delivery (how long from
// a xell being cut to its first landing, what a landed xell costs, how many zees die on a provider
// error, how often work is landed twice) were seven ad-hoc queries nobody but their author could
// reproduce. `deliveryTelemetry()` is those seven, written down once.
//
// IT IS NOT `zee ops`. lib/ops-review.js answers "what is the queenzee doing right now" for a
// MINISTER — fleet-wide, log ring included, and already too big to return as valid JSON (TKT-42).
// This answers "how is delivery trending here" for a human looking at ONE project, and it is
// deliberately a separate route and a separate payload so neither grows the other.
//
// READ-ONLY BY CONSTRUCTION, like ops-review: every query is a SELECT. It creates no table, writes
// no row and schedules nothing — every metric is derived from rows the gates already write.
//
// THE ARITHMETIC LIVES IN PURE FUNCTIONS, on purpose. Percentiles, the transient/terminal split,
// the per-model grouping and the rework buckets are exported below and tested in plain node
// (test/delivery-telemetry.test.mjs) with no database at all. The SQL's whole job is to hand them
// a small, window-bounded row set.
//
// QUERY COST — this reads a live production meta-DB. Every query is scoped to one project AND to
// the window; the only per-xell LATERAL is the open-tend lookup, which is the SAME lateral the
// console's fleet snapshot already runs on every poll (lib/fleet.js) and is bounded by the live
// xell count. There is no scan of session_event by time.
//
// EVERY NUMBER CARRIES ITS SAMPLE SIZE. A cost-per-landing over two xells must not render like one
// over two hundred, so no aggregate is returned without the `n` it was computed from.
import { q, one } from '../db/pool.js';

// ── the arithmetic (pure — no db, no clock) ───────────────────────────────────────────────────

const round2 = (v) => Math.round(Number(v || 0) * 100) / 100;

// A gate's wait, over the rows a HUMAN actually decided. `auto_n` is the rest — decisions the
// queenzee signed itself (a stale sweep, an auto-approval, a bundled ship) — kept beside the
// summary so a gate that mostly decides itself is visible rather than averaged in.
export function humanWait(rows) {
  const all = rows || [];
  const human = all.filter((r) => !r.by_machine);
  return { ...summarise(human.map((r) => Number(r.minutes))), auto_n: all.length - human.length };
}

// percentile_cont, so a hand SQL check with `percentile_cont(0.5) WITHIN GROUP (ORDER BY …)` gets
// the same answer. Empty input has no percentile — null, never 0, because 0 reads as "fast".
export function percentile(values, p) {
  const xs = (values || []).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const rank = (xs.length - 1) * p;
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return xs[lo];
  return xs[lo] + (rank - lo) * (xs[hi] - xs[lo]);
}

// The shape every duration in this model is reported in: the sample size FIRST, then the numbers.
export function summarise(values) {
  const xs = (values || []).filter((v) => Number.isFinite(v));
  const round = (v) => (v === null ? null : Math.round(v * 10) / 10);
  return {
    n: xs.length,
    p50: round(percentile(xs, 0.5)),
    p90: round(percentile(xs, 0.9)),
    avg: xs.length ? round(xs.reduce((a, b) => a + b, 0) / xs.length) : null,
    min: xs.length ? round(Math.min(...xs)) : null,
    max: xs.length ? round(Math.max(...xs)) : null,
  };
}

// A zee's `last_stop_reason` is free text: the provider's error message, truncated to 200 chars by
// intake.js, or one of the queenzee's own words ('end_turn', 'fleet-paused', 'resumed after fleet
// pause'). Only the provider/infrastructure failures are TURN DEATHS, and the split that matters is
// whether retrying could ever have worked:
//
//   TRANSIENT — the fleet hit a wall it could have walked through later (429, 529/overloaded, a
//               closed connection, a timeout). The work is recoverable; the waste is the turn.
//   TERMINAL  — the run could never have succeeded (401/auth, an invalid key, a disabled org, a
//               model the provider does not have). Nothing that cohort was dispatched to do was
//               ever going to happen, and every one of those xells is pure waste.
//
// TERMINAL is matched FIRST: a terminal message often carries an HTTP status that also appears in
// transient text ("401 ... connection"), and mis-filing a terminal death as transient hides the
// only cohort a human must act on. Anything unmatched is not an error — null, not a guess.
const TERMINAL_RE = /\b40[13]\b|authentication|unauthor|invalid[ _-]?(api[ _-]?)?key|api[ _-]?key|credit balance|organization.{0,20}(disabled|deactivat|suspend)|org.{0,10}disabled|permission[ _-]?error|(unknown|unsupported|invalid|not found).{0,20}model|model.{0,20}(not found|does not exist|unknown|unsupported)/i;
const TRANSIENT_RE = /\b(429|500|502|503|504|529)\b|rate[ _-]?limit|overload|too many requests|connection (closed|error|reset|refused|aborted)|econnreset|econnrefused|etimedout|socket hang up|timed? ?out|timeout|temporarily unavailable|service unavailable|stream (error|closed)|network error/i;

export function classifyStopReason(reason) {
  const s = String(reason || '').trim();
  if (!s) return null;
  if (TERMINAL_RE.test(s)) return 'terminal';
  if (TRANSIENT_RE.test(s)) return 'transient';
  return null;
}

// Turn deaths over a zee row set: counts, share of ALL zees in the window, and what they cost.
// The share denominator is every zee in the window (not every errored one) — "43 of 279" is the
// reading a human wants, and a share of the errored subset would always be near 100%.
export function turnDeaths(zees) {
  const all = zees || [];
  const bucket = () => ({ n: 0, cost: 0, share: 0, reasons: [] });
  const out = { zees_n: all.length, transient: bucket(), terminal: bucket() };
  const byReason = { transient: new Map(), terminal: new Map() };
  for (const z of all) {
    const cls = classifyStopReason(z.last_stop_reason);
    if (!cls) continue;
    out[cls].n += 1;
    out[cls].cost += Number(z.cost_usd || 0);
    const key = String(z.last_stop_reason || '').slice(0, 120);
    const seen = byReason[cls].get(key) || { reason: key, n: 0, cost: 0, landed: 0 };
    seen.n += 1;
    seen.cost += Number(z.cost_usd || 0);
    seen.landed += z.landed ? 1 : 0;
    byReason[cls].set(key, seen);
  }
  for (const cls of ['transient', 'terminal']) {
    out[cls].share = all.length ? out[cls].n / all.length : 0;
    out[cls].cost = round2(out[cls].cost);
    out[cls].landed = [...byReason[cls].values()].reduce((a, r) => a + r.landed, 0);
    out[cls].reasons = [...byReason[cls].values()]
      .map((r) => ({ ...r, cost: round2(r.cost) }))
      .sort((a, b) => b.n - a.n).slice(0, 8);
  }
  out.deaths_n = out.transient.n + out.terminal.n;
  return out;
}

// Cost per landed xell, grouped by whatever key is asked for (model, harness). `n` is the number of
// LANDED XELLS in the group — the sample size the mean is over — and it is returned beside the mean
// precisely so a $10.80 average over two xells cannot be read as a rate.
export function costPerLanded(rows, key) {
  const groups = new Map();
  for (const r of rows || []) {
    const k = r[key] || '(unrecorded)';
    const g = groups.get(k) || { key: k, n: 0, cost: 0 };
    g.n += 1;
    g.cost += Number(r.cost || 0);
    groups.set(k, g);
  }
  return [...groups.values()]
    .map((g) => ({ ...g, cost: round2(g.cost), mean: round2(g.cost / g.n) }))
    .sort((a, b) => b.cost - a.cost);
}

// Error rate by model: errored zees over ALL zees of that model. Same rule — `n` rides along, so
// "7 of 14" is what renders, never a bare 50%.
export function errorRateByModel(zees) {
  const groups = new Map();
  for (const z of zees || []) {
    const k = z.model || '(unrecorded)';
    const g = groups.get(k) || { model: k, n: 0, errored: 0, cost: 0 };
    g.n += 1;
    g.errored += z.status === 'errored' ? 1 : 0;
    g.cost += Number(z.cost_usd || 0);
    groups.set(k, g);
  }
  return [...groups.values()]
    .map((g) => ({ ...g, cost: round2(g.cost), rate: g.n ? g.errored / g.n : 0 }))
    .sort((a, b) => b.errored - a.errored || b.n - a.n);
}

// REWORK — how many times one xell's work had to be landed. One landing is the healthy case;
// everything above it is a re-land, and the buckets are where that stops being a rounding error.
export const REWORK_BUCKETS = [
  { label: '1', min: 1, max: 1 },
  { label: '2', min: 2, max: 2 },
  { label: '3–5', min: 3, max: 5 },
  { label: '6–15', min: 6, max: 15 },
  { label: '16+', min: 16, max: Infinity },
];

export function reworkDistribution(rows) {
  const buckets = REWORK_BUCKETS.map((b) => ({ label: b.label, n: 0 }));
  let xells = 0;
  let landings = 0;
  for (const r of rows || []) {
    const landed = Number(r.landed || 0);
    if (landed < 1) continue;                   // a xell with only stale/rejected rows is metric 7
    xells += 1;
    landings += landed;
    const i = REWORK_BUCKETS.findIndex((b) => landed >= b.min && landed <= b.max);
    if (i >= 0) buckets[i].n += 1;
  }
  return {
    xells_n: xells,
    landings_n: landings,
    mean: xells ? round2(landings / xells) : null,
    relanded_n: buckets.slice(1).reduce((a, b) => a + b.n, 0),
    buckets,
  };
}

// ── the read model ────────────────────────────────────────────────────────────────────────────

export const DEFAULT_WINDOW_DAYS = 14;
export const WINDOW_DAYS_MAX = 180;

export async function deliveryTelemetry({ projectId, days = DEFAULT_WINDOW_DAYS } = {}) {
  if (!projectId) throw Object.assign(new Error('project is required'), { status: 400 });
  const d = Math.min(Math.max(Math.round(Number(days) || DEFAULT_WINDOW_DAYS), 1), WINDOW_DAYS_MAX);
  const project = await one(`SELECT id, name FROM project WHERE id = $1`, [projectId]);
  if (!project) throw Object.assign(new Error('no such project'), { status: 404 });
  // The window is a bound parameter everywhere below; `d` is already an integer, and it is
  // interpolated only into `interval '1 day' * $n` via the parameter list.
  const args = [project.id, d];

  // ── 1. CYCLE TIME — a xell being cut → the first time it ASKED to land ──────────────────────
  // Windowed on the LANDING, not on the xell: "of the work delivered in the last N days, how long
  // did it take" is the question, and windowing on xell.created_at instead would silently drop
  // every xell still in flight and make the fleet look faster the busier it got.
  const cycle = await q(
    `SELECT x.slug, x.zee_type,
            extract(epoch FROM (f.first_req - x.created_at)) / 60.0 AS minutes
       FROM xell x
       JOIN LATERAL (
         SELECT min(l.requested_at) AS first_req
           FROM land_request l
          WHERE l.xell_id = x.id AND l.project_id = x.project_id
       ) f ON f.first_req IS NOT NULL
      WHERE x.project_id = $1 AND f.first_req > now() - interval '1 day' * $2`, args);

  // ── 2 + 4. ZEES in the window: turn deaths and error rate come off ONE row set ───────────────
  // One bounded read instead of two aggregates over the same rows. `landed` rides along because
  // the interesting fact about the terminal cohort is that it never landed anything.
  const zees = await q(
    `SELECT z.id, z.model, z.status::text AS status, z.cost_usd::float8 AS cost_usd,
            z.last_stop_reason,
            EXISTS (SELECT 1 FROM land_request l
                     WHERE l.xell_id = z.xell_id AND l.status = 'landed') AS landed
       FROM zee z JOIN xell x ON x.id = z.xell_id
      WHERE x.project_id = $1
        AND COALESCE(z.last_event_at, z.created_at) > now() - interval '1 day' * $2`, args);

  // ── 3. COST PER LANDED XELL — one row per xell that landed at least once in the window ───────
  // A xell can host several zees (a swap, a resume), so its cost is the SUM of all of them, and the
  // model it is filed under is the model that spent the most on it. Attributing per-zee instead
  // would count one landing several times and make every mean meaningless.
  const landedXells = await q(
    `SELECT x.id, x.slug,
            COALESCE(h.label, h.key, '(no harness)') AS harness,
            (SELECT z2.model FROM zee z2
              WHERE z2.xell_id = x.id AND z2.model IS NOT NULL
              ORDER BY z2.cost_usd DESC, z2.created_at DESC LIMIT 1) AS model,
            (SELECT COALESCE(SUM(z3.cost_usd), 0)::float8 FROM zee z3 WHERE z3.xell_id = x.id) AS cost
       FROM xell x
       LEFT JOIN harness h ON h.id = x.harness_id
      WHERE x.project_id = $1
        AND EXISTS (SELECT 1 FROM land_request l
                     WHERE l.xell_id = x.id AND l.status = 'landed'
                       AND COALESCE(l.landed_at, l.decided_at, l.requested_at)
                             > now() - interval '1 day' * $2)`, args);

  // ── 5. REWORK — landings per xell, and the stale ones nobody got to keep ─────────────────────
  const reworkRows = await q(
    `SELECT x.slug,
            count(*) FILTER (WHERE l.status = 'landed')::int AS landed,
            count(*) FILTER (WHERE l.status = 'stale')::int   AS stale
       FROM land_request l JOIN xell x ON x.id = l.xell_id
      WHERE l.project_id = $1 AND l.requested_at > now() - interval '1 day' * $2
      GROUP BY x.id, x.slug`, args);
  const staleTotal = await one(
    `SELECT count(*)::int AS n, count(DISTINCT l.xell_id)::int AS xells
       FROM land_request l
      WHERE l.project_id = $1 AND l.status = 'stale'
        AND l.requested_at > now() - interval '1 day' * $2`, args);

  // ── 6. HUMAN-GATE WAITS — asked → decided, for the three gates that hold a zee ───────────────
  // Not every decision is a HUMAN's. A landing swept stale carries 'queenzee@stale', an
  // auto-approved one 'auto-approve@policy', a bundled or recovered ship '…@queenzee' — the check
  // constraints require a decider, so the queenzee signs the rows nobody looked at. Counting those
  // as human waits is what makes a p90 say "three days" when no human was ever asked, so they are
  // filed apart as `auto_n` rather than dropped: a gate that mostly decides itself is a finding.
  const MACHINE_DECIDER = `(decided_by IS NULL OR decided_by LIKE 'queenzee@%'
                            OR decided_by LIKE '%@queenzee' OR decided_by LIKE 'auto-approve@%')`;
  const gateWait = async (table) => q(
    `SELECT extract(epoch FROM (decided_at - requested_at)) / 60.0 AS minutes,
            ${MACHINE_DECIDER} AS by_machine
       FROM ${table}
      WHERE project_id = $1 AND decided_at IS NOT NULL
        AND requested_at > now() - interval '1 day' * $2`, args);
  const [landWait, shipWait, seedWait] = await Promise.all([
    gateWait('land_request'), gateWait('ship_request'), gateWait('prod_seed_request'),
  ]);
  // …and the fourth wait, which has no decided_at because a tend is not a gate: it is a zee saying
  // "a human is needed here" and then waiting. Same LATERAL the console's own fleet snapshot runs
  // (lib/fleet.js) — latest tend-request/tend-clear per LIVE xell, so it is bounded by the xells on
  // screen and never scans session_event by time.
  const tends = await q(
    `SELECT x.slug, se.ts,
            extract(epoch FROM (now() - se.ts)) / 60.0 AS minutes
       FROM xell x
       JOIN LATERAL (
         SELECT e.hook_event_name, e.ts FROM session_event e
          WHERE e.xell_id = x.id AND e.hook_event_name IN ('tend-request', 'tend-clear')
          ORDER BY e.ts DESC LIMIT 1
       ) se ON true
      WHERE x.project_id = $1 AND x.status <> 'retired' AND se.hook_event_name = 'tend-request'
      ORDER BY se.ts`, [project.id]);

  // ── 7. XELLS THAT NEVER RAISED A LANDING ────────────────────────────────────────────────────
  // MANAGER xells are excluded from the split and counted separately: a manager cannot land at all
  // (its manual refuses it), so filing one as "abandoned" would report the design as waste. The
  // split itself is a fact about zees, not about status: a xell that never had a zee row was never
  // claimed out of the pool; one that had a zee and no landing was claimed and abandoned.
  const neverLanded = await q(
    `SELECT x.slug, x.status::text AS status, COALESCE(x.zee_type, 'worker') AS zee_type,
            x.created_at, x.retired_at,
            (SELECT count(*) FROM zee z WHERE z.xell_id = x.id)::int AS zees,
            (SELECT COALESCE(SUM(z.cost_usd), 0)::float8 FROM zee z WHERE z.xell_id = x.id) AS cost
       FROM xell x
      WHERE x.project_id = $1 AND x.created_at > now() - interval '1 day' * $2
        AND NOT EXISTS (SELECT 1 FROM land_request l WHERE l.xell_id = x.id)
      ORDER BY x.created_at DESC`, args);
  const cutTotal = await one(
    `SELECT count(*)::int AS n,
            count(*) FILTER (WHERE COALESCE(zee_type, 'worker') <> 'manager')::int AS workers
       FROM xell WHERE project_id = $1 AND created_at > now() - interval '1 day' * $2`, args);

  const workersNever = neverLanded.filter((r) => r.zee_type !== 'manager');
  const neverClaimed = workersNever.filter((r) => r.zees === 0);
  const abandoned = workersNever.filter((r) => r.zees > 0);
  const sumCost = (rows) => round2(rows.reduce((a, r) => a + Number(r.cost || 0), 0));

  // ── USAGE PER PROVIDER — gateway ledger (llm_gateway_request), the only grain that attributes
  // a call to a provider key. Window-bounded like everything else here. Empty when the gateway
  // has not recorded any call in the window (a fleet that never went through the door, or a
  // project whose provider traffic predates migration 154).
  const byProvider = await q(
    `SELECT COALESCE(provider, '(unrecorded)') AS provider,
            COALESCE(SUM(total_tokens), 0)::bigint AS tokens,
            COALESCE(SUM(cost_usd), 0)::float8     AS cost,
            COUNT(*)::int                          AS requests
       FROM llm_gateway_request
      WHERE project_id = $1
        AND requested_at > now() - interval '1 day' * $2
      GROUP BY 1
      ORDER BY cost DESC, tokens DESC`, args).catch(() => []);

  return {
    ok: true,
    generated_at: new Date().toISOString(),
    window_days: d,
    project: { id: project.id, name: project.name },

    cycle_time: {
      ...summarise(cycle.map((r) => Number(r.minutes))),
      unit: 'minutes',
      slowest: [...cycle].sort((a, b) => Number(b.minutes) - Number(a.minutes)).slice(0, 5)
        .map((r) => ({ xell: r.slug, minutes: Math.round(Number(r.minutes)) })),
    },

    turn_deaths: turnDeaths(zees),

    cost_per_landed: {
      n: landedXells.length,
      cost: sumCost(landedXells),
      mean: landedXells.length ? round2(sumCost(landedXells) / landedXells.length) : null,
      by_model: costPerLanded(landedXells, 'model'),
      by_harness: costPerLanded(landedXells, 'harness'),
    },

    // Gateway-traced usage per provider over the window (tokens + $ + call count). Sample size is
    // the request count, not the xell count — a provider with one expensive call must not read like
    // one with a hundred cheap ones.
    usage_by_provider: (byProvider || []).map((r) => ({
      provider: r.provider,
      tokens: Number(r.tokens || 0),
      cost: round2(r.cost),
      requests: Number(r.requests || 0),
    })),

    error_rate: { zees_n: zees.length, by_model: errorRateByModel(zees) },

    rework: {
      ...reworkDistribution(reworkRows),
      stale: { n: Number(staleTotal?.n || 0), xells: Number(staleTotal?.xells || 0) },
      worst: reworkRows.filter((r) => r.landed > 1).sort((a, b) => b.landed - a.landed).slice(0, 5)
        .map((r) => ({ xell: r.slug, landed: r.landed })),
    },

    gate_waits: {
      unit: 'minutes',
      land: humanWait(landWait),
      ship: humanWait(shipWait),
      seed: humanWait(seedWait),
      // Open tends are still waiting, so this is age, not a decision time — labelled apart from the
      // three gates for exactly that reason.
      tends_open: { ...summarise(tends.map((r) => Number(r.minutes))), waiting: true,
                    oldest: tends[0] ? { xell: tends[0].slug, since: tends[0].ts } : null },
    },

    never_landed: {
      xells_cut: Number(cutTotal?.n || 0),
      workers_cut: Number(cutTotal?.workers || 0),
      n: workersNever.length,
      cost: sumCost(workersNever),
      managers_excluded: neverLanded.length - workersNever.length,
      never_claimed: { n: neverClaimed.length, cost: sumCost(neverClaimed) },
      abandoned: { n: abandoned.length, cost: sumCost(abandoned),
                   rows: abandoned.slice(0, 10).map((r) => ({ xell: r.slug, status: r.status,
                                                              zees: r.zees, cost: round2(r.cost) })) },
    },
  };
}

export default { deliveryTelemetry, percentile, summarise, humanWait, classifyStopReason, turnDeaths,
                 costPerLanded, errorRateByModel, reworkDistribution, REWORK_BUCKETS,
                 DEFAULT_WINDOW_DAYS, WINDOW_DAYS_MAX };
