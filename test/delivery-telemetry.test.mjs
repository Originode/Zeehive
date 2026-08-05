// DELIVERY TELEMETRY — the seven delivery numbers for one project over a window
// (server/src/lib/delivery-telemetry.js, GET /api/delivery-telemetry, web/src/DeliveryTelemetry.jsx).
//
// The point of the read model is that a human stops writing SQL against production to find out
// whether the fleet is getting faster, so the thing that must be right is the ARITHMETIC. This test
// is in three parts, and the first two need no database at all:
//
//   A. THE ARITHMETIC, pure. Percentiles (percentile_cont's definition, so a hand SQL check with
//      `percentile_cont(0.5) WITHIN GROUP (ORDER BY …)` agrees), the transient/terminal split over
//      real provider error text, the per-model and per-harness grouping, the rework buckets, and
//      the human-vs-machine gate decision. Every one of them is a pure function precisely so it can
//      be checked here against numbers worked out by hand.
//   B. THE WIRING + THE READ-ONLY GUARANTEE. The route exists and is project-scoped, the console
//      panel calls it, and the read model contains not one writing SQL verb — the same guarantee
//      test/queenzee-minister.test.mjs makes of lib/ops-review.js, and for the same reason: this
//      reads a live production meta-DB.
//   C. THE SQL, against a throwaway project in DATABASE_URL. Fixtures are built so every one of the
//      seven metrics has a hand-computed expected value (they are written in the comments beside
//      each assertion), and the project is deleted in a `finally` whatever happens — the delete
//      cascades to its xells, zees and gate rows, so nothing of this test survives it.
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };
const eq = (got, want, msg) => ok(got === want, `${msg} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);
const near = (got, want, msg, tol = 0.05) =>
  ok(got !== null && Math.abs(Number(got) - want) <= tol, `${msg} (got ${JSON.stringify(got)}, want ~${want})`);

const T = await import('../server/src/lib/delivery-telemetry.js');

// ── A. the arithmetic ─────────────────────────────────────────────────────────────────────────
console.log('\n── A1. percentiles: percentile_cont, so a hand SQL check agrees ──');
// [1..10]: p50 rank = 0.5*(10-1) = 4.5 → 5 + 0.5*(6-5) = 5.5 · p90 rank = 8.1 → 9 + 0.1*(10-9) = 9.1
const ten = [10, 3, 7, 1, 9, 5, 2, 8, 4, 6];
eq(T.percentile(ten, 0.5), 5.5, 'p50 of 1..10 interpolates to 5.5');
near(T.percentile(ten, 0.9), 9.1, 'p90 of 1..10 interpolates to 9.1');
eq(T.percentile([], 0.5), null, 'no sample has NO percentile — null, never 0 (0 would read as "instant")');
eq(T.percentile([42], 0.9), 42, 'one sample is its own percentile');
eq(T.percentile([1, 2, null, NaN, 3], 0.5), 2, 'non-numbers are dropped, not counted as zero');

console.log('\n── A2. summarise: the sample size rides with every number ──');
const s = T.summarise([100, 900]);
eq(s.n, 2, 'n is the sample size');
eq(s.p50, 500, 'p50 of [100,900] is 500');
eq(s.p90, 820, 'p90 of [100,900] is 820 (100 + 0.9*800)');
eq(s.avg, 500, 'avg');
eq(s.min, 100, 'min'); eq(s.max, 900, 'max');
const empty = T.summarise([]);
eq(empty.n, 0, 'an empty sample is n=0…');
eq(empty.p50, null, '…with null percentiles, so the panel can say "no data" instead of "0 min"');

console.log('\n── A3. the transient / terminal split, over real provider stop reasons ──');
for (const [reason, want] of [
  ['API Error: 429 {"type":"rate_limit_error"}', 'transient'],
  ['API Error: 529 {"type":"overloaded_error"}', 'transient'],
  ['Connection error.', 'transient'],
  ['request timed out after 600s', 'transient'],
  ['fetch failed: ECONNRESET', 'transient'],
  ['API Error: 401 {"type":"authentication_error","message":"invalid x-api-key"}', 'terminal'],
  ['Your organization has been disabled', 'terminal'],
  ['model claude-4-ultra not found', 'terminal'],
  ['API Error: 400 unknown model: gpt-9', 'terminal'],
  ['end_turn', null],
  ['fleet-paused', null],
  ['resumed after fleet pause', null],
  ['', null],
  [null, null],
]) eq(T.classifyStopReason(reason), want, `${JSON.stringify(String(reason ?? '').slice(0, 46))} → ${want}`);
// A message carrying BOTH signals is TERMINAL: retrying a bad key over a flaky socket still never works.
eq(T.classifyStopReason('401 authentication_error (connection closed)'), 'terminal',
   'a message with both signals is filed TERMINAL — the cohort a human must act on is never hidden');

console.log('\n── A4. turn deaths: counts, share of ALL zees, and cost ──');
const zees = [
  { model: 'opus', status: 'errored', cost_usd: 1.5, last_stop_reason: 'API Error: 429 rate_limit_error', landed: false },
  { model: 'opus', status: 'errored', cost_usd: 0.5, last_stop_reason: 'Connection error.', landed: true },
  { model: 'fable', status: 'errored', cost_usd: 0.25, last_stop_reason: 'API Error: 401 authentication_error', landed: false },
  { model: 'fable', status: 'stopped', cost_usd: 2, last_stop_reason: 'end_turn', landed: true },
];
const td = T.turnDeaths(zees);
eq(td.zees_n, 4, 'the denominator is EVERY zee in the window, not just the errored ones');
eq(td.transient.n, 2, 'two transient deaths');
eq(td.transient.cost, 2, 'costing $2.00');
eq(td.transient.share, 0.5, 'share = 2/4');
eq(td.terminal.n, 1, 'one terminal death');
eq(td.terminal.cost, 0.25, 'costing $0.25');
eq(td.terminal.share, 0.25, 'share = 1/4');
eq(td.terminal.landed, 0, 'and the terminal cohort landed nothing — the fact that makes it pure waste');
eq(td.deaths_n, 3, 'three turn deaths in total (end_turn is not one)');
eq(T.turnDeaths([]).transient.share, 0, 'no zees at all is share 0, not a division by zero');

console.log('\n── A5. cost per landed xell, by model and by harness, with the sample size ──');
const landed = [
  { model: 'opus', harness: 'Builder', cost: 4 },
  { model: 'opus', harness: 'Builder', cost: 2 },
  { model: 'deepseek-chat', harness: 'Scout', cost: 10.8 },
  { model: null, harness: null, cost: 1 },
];
const byModel = T.costPerLanded(landed, 'model');
eq(byModel[0].key, 'deepseek-chat', 'sorted by total spend');
eq(byModel[0].n, 1, 'and a $10.80 mean over ONE xell says so — that is what n is for');
eq(byModel[0].mean, 10.8, 'mean = cost / n');
const opus = byModel.find((g) => g.key === 'opus');
eq(opus.n, 2, 'opus: two landed xells');
eq(opus.cost, 6, 'costing $6.00');
eq(opus.mean, 3, 'i.e. $3.00 per landed xell');
ok(byModel.some((g) => g.key === '(unrecorded)'), 'a xell with no model is named, not silently dropped');
eq(T.costPerLanded(landed, 'harness').find((g) => g.key === 'Builder').n, 2, 'the same grouping, by harness');
eq(T.costPerLanded([], 'model').length, 0, 'nothing landed → no groups (not a group of zero)');

console.log('\n── A6. error rate by model — "7 of 14", never a bare percentage ──');
const rate = T.errorRateByModel([
  ...Array.from({ length: 7 }, () => ({ model: 'fable', status: 'errored', cost_usd: 0 })),
  ...Array.from({ length: 7 }, () => ({ model: 'fable', status: 'idle', cost_usd: 0 })),
  { model: 'opus', status: 'idle', cost_usd: 0 },
]);
const fable = rate.find((r) => r.model === 'fable');
eq(fable.n, 14, 'fable: 14 zees');
eq(fable.errored, 7, '7 of them errored');
eq(fable.rate, 0.5, 'a rate of 0.5 — reported WITH the 14 it is over');
eq(rate.find((r) => r.model === 'opus').rate, 0, 'a model that never errored is 0, and still carries its n');

console.log('\n── A7. rework: the landings-per-xell distribution ──');
const rw = T.reworkDistribution([
  { landed: 1 }, { landed: 1 }, { landed: 2 }, { landed: 3 }, { landed: 15 }, { landed: 40 },
  { landed: 0 },   // asked and never landed — that is metric 7, not rework
]);
eq(rw.xells_n, 6, 'six xells landed at least once');
eq(rw.landings_n, 62, '62 landings between them');
eq(rw.relanded_n, 4, 'four of the six needed more than one landing');
eq(rw.buckets.find((b) => b.label === '1').n, 2, 'bucket 1: two');
eq(rw.buckets.find((b) => b.label === '2').n, 1, 'bucket 2: one');
eq(rw.buckets.find((b) => b.label === '3–5').n, 1, 'bucket 3–5: one');
eq(rw.buckets.find((b) => b.label === '6–15').n, 1, 'bucket 6–15: one');
eq(rw.buckets.find((b) => b.label === '16+').n, 1, 'bucket 16+: one');
eq(T.reworkDistribution([]).mean, null, 'no landings → no mean (null, not 0)');

console.log('\n── A8. gate waits count HUMAN decisions only ──');
const gw = T.humanWait([
  { minutes: 5, by_machine: false }, { minutes: 15, by_machine: false },
  { minutes: 4000, by_machine: true },   // 'queenzee@stale' — nobody was ever asked
]);
eq(gw.n, 2, 'two human decisions');
eq(gw.p50, 10, 'p50 of 5 and 15 is 10 — the stale sweep does not drag it to two days');
eq(gw.auto_n, 1, 'and the machine-decided row is COUNTED, not dropped: a self-deciding gate is a finding');

// ── B. wiring + the read-only guarantee ───────────────────────────────────────────────────────
console.log('\n── B1. the route: project-scoped, its own payload, not bolted onto `zee ops` ──');
const routes = read('server/src/api/routes.js');
ok(/router\.get\('\/delivery-telemetry'/.test(routes), 'GET /api/delivery-telemetry exists');
ok(/import \{ deliveryTelemetry \} from '\.\.\/lib\/delivery-telemetry\.js'/.test(routes),
   'and it calls the read model in lib/delivery-telemetry.js');
ok(/\/delivery-telemetry'[\s\S]{0,400}?project is required/.test(routes),
   'it refuses without a project — the question is about ONE project, and there is no fleet-wide answer');
const opsReview = read('server/src/lib/ops-review.js');
ok(!/delivery|telemetry/i.test(opsReview), '`zee ops` is untouched — TKT-42: that digest must not grow');

console.log('\n── B2. read-only BY CONSTRUCTION (it reads a live production meta-DB) ──');
const lib = read('server/src/lib/delivery-telemetry.js');
for (const verb of ['INSERT ', 'UPDATE ', 'DELETE ', 'CREATE ', 'ALTER ', 'DROP ', 'TRUNCATE ']) {
  ok(!new RegExp(`\`[^\`]*\\b${verb}`, 's').test(lib.replace(/\/\/.*$/gm, '')),
     `no ${verb.trim()} anywhere in the read model`);
}
ok(!/session_event[\s\S]{0,300}?\bts\s*>/.test(lib),
   'and no scan of session_event by time — the open-tend lookup is the fleet snapshot\'s own per-xell LATERAL');

console.log('\n── B3. the console panel calls the route and offers the window ──');
const panel = read('web/src/DeliveryTelemetry.jsx');
ok(/\/api\/delivery-telemetry/.test(panel), 'the panel fetches /api/delivery-telemetry');
ok(/days=/.test(panel), 'with a selectable window');
ok(read('web/src/App.jsx').includes('DeliveryTelemetry'), 'and App.jsx mounts it');

console.log('\n── B4. the SCREEN, rendered: every figure carries its sample size ──');
// The REAL component, bundled with its real react and rendered to static markup — the same seam
// test/app-dialog-jsx.test.mjs uses. What is asserted is what a human would actually read off the
// page, because "the API returned n" and "the screen shows n" are two different claims.
{
  const esbuild = await import('esbuild');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { createRequire } = await import('node:module');
  const tmp = mkdtempSync(join(tmpdir(), 'dt-jsx-'));
  try {
    const out = join(tmp, 'dt.cjs');
    await esbuild.build({
      stdin: {
        contents: `
          const React = require('react');
          const { renderToStaticMarkup } = require('react-dom/server');
          const { DeliveryTelemetryScreen } = require('./DeliveryTelemetry.jsx');
          module.exports = { React, renderToStaticMarkup, DeliveryTelemetryScreen };`,
        resolveDir: join(ROOT, 'web/src'), loader: 'js',
      },
      bundle: true, format: 'cjs', platform: 'node', outfile: out, jsx: 'automatic',
      logLevel: 'silent', define: { 'process.env.NODE_ENV': '"development"' },
    });
    const { React, renderToStaticMarkup, DeliveryTelemetryScreen } = createRequire(out)(out);
    const payload = {
      window_days: 14,
      cycle_time: { n: 12, p50: 105, p90: 939, avg: 300, min: 4, max: 2000, unit: 'minutes',
                    slowest: [{ xell: 'slow-xell-1', minutes: 2000 }] },
      turn_deaths: { zees_n: 279, deaths_n: 43,
                     transient: { n: 31, share: 31 / 279, cost: 12.5, landed: 4, reasons: [{ reason: '429 rate_limit_error', n: 31, cost: 12.5, landed: 4 }] },
                     terminal: { n: 12, share: 12 / 279, cost: 3.25, landed: 0, reasons: [{ reason: '401 authentication_error', n: 12, cost: 3.25, landed: 0 }] } },
      cost_per_landed: { n: 41, cost: 210.5, mean: 5.13,
                         by_model: [{ key: 'deepseek-chat', n: 2, cost: 21.6, mean: 10.8 },
                                    { key: 'opus', n: 39, cost: 160.68, mean: 4.12 }],
                         by_harness: [{ key: 'Builder', n: 41, cost: 210.5, mean: 5.13 }] },
      error_rate: { zees_n: 279, by_model: [{ model: 'fable', n: 14, errored: 7, rate: 0.5, cost: 4 }] },
      rework: { xells_n: 89, landings_n: 160, mean: 1.8, relanded_n: 57,
                buckets: [{ label: '1', n: 32 }, { label: '2', n: 32 }, { label: '3–5', n: 20 },
                          { label: '6–15', n: 5 }, { label: '16+', n: 0 }],
                stale: { n: 25, xells: 18 }, worst: [{ xell: 'churny-xell', landed: 15 }] },
      gate_waits: { unit: 'minutes',
                    land: { n: 160, p50: 3.2, p90: 44, avg: 14.9, min: 0, max: 900, auto_n: 25 },
                    ship: { n: 12, p50: 2.3, p90: 9, avg: 3, min: 0, max: 20, auto_n: 0 },
                    seed: { n: 0, p50: null, p90: null, avg: null, min: null, max: null, auto_n: 0 },
                    tends_open: { n: 2, p50: 60, p90: 120, avg: 80, min: 40, max: 130, waiting: true, oldest: null } },
      never_landed: { xells_cut: 300, workers_cut: 280, n: 93, cost: 55.5, managers_excluded: 20,
                      never_claimed: { n: 60, cost: 0 },
                      abandoned: { n: 33, cost: 55.5,
                                   rows: [{ xell: 'abandoned-xell-1', status: 'retired', zees: 1, cost: 3.2 }] } },
    };
    const html = renderToStaticMarkup(React.createElement(DeliveryTelemetryScreen, { data: payload }));
    for (const [needle, what] of [
      ['1 · Cycle time', 'card 1 is on the page'],
      ['105 min', 'the cycle-time p50'],
      ['15.7 h', 'and the p90, rendered in hours because 939 minutes is not a readable number'],
      ['n=12', 'with the sample size beside it'],
      ['2 · Turn deaths', 'card 2'],
      ['n=279', 'turn deaths are shown over EVERY zee in the window'],
      ['11.1%', 'the transient share'],
      ['$3.25', 'and what the terminal cohort cost'],
      ['3 · Cost per landed xell', 'card 3'],
      ['$10.80', 'the deepseek-chat mean…'],
      ['n=2', '…beside the TWO xells it is over — the whole point of the sample size'],
      ['4 · Error rate by model', 'card 4'],
      ['7 of 14', 'the error rate as a count, not a bare percentage'],
      ['5 · Rework', 'card 5'],
      ['6 · Human-gate waits', 'card 6'],
      ['25 decided by the queenzee', 'the machine-decided landings are named, not hidden'],
      ['7 · Never raised a landing', 'card 7'],
      ['20 manager(s) excluded', 'and the managers excluded from the split are stated on the page'],
    ]) ok(html.includes(needle), `${what} — "${needle}"`);
    ok((html.match(/class="dt-n"/g) || []).length >= 10,
       'the n=… chip appears throughout the screen, not once at the top');
    ok(html.includes('no data in this window') || html.includes('no human decisions in this window'),
       'an empty sample says "no data", never a confident zero');
    ok(!/>0 min</.test(html), 'and never renders a null percentile as "0 min"');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

// ── C. the SQL, against a throwaway project ───────────────────────────────────────────────────
console.log('\n── C. the read model against DATABASE_URL (throwaway project, deleted in a finally) ──');
const { q, one, pool } = await import('../server/src/db/pool.js');
const tag = `dt-${Date.now()}`;
let projectId = null;
try {
  try {
    await one('SELECT 1');
  } catch (err) {
    console.log(`  ✗ FAIL could not reach DATABASE_URL: ${err.message}`);
    console.log('        → the arithmetic above is proved; the SQL in this section is NOT.');
    failures++;
    throw err;
  }

  const proj = await one(
    `INSERT INTO project (name, repo_root, main_branch) VALUES ($1,$2,'main') RETURNING id`,
    [`zt-${tag}`, `/tmp/${tag}`]);
  projectId = proj.id;
  const xource = await one(
    `INSERT INTO xource (project_id, ref, head_commit) VALUES ($1,'main','deadbeef') RETURNING id`,
    [projectId]);

  // minutes-ago helper, so every fixture timestamp is stated as an offset from now
  const ago = (min) => `now() - interval '1 minute' * ${min}`;
  const mkXell = async (slug, createdAgoMin, zeeType = 'worker') => (await one(
    `INSERT INTO xell (project_id, xource_id, slug, branch, status, zee_type, created_at)
       VALUES ($1,$2,$3,$4,'claimed',$5, ${ago(createdAgoMin)}) RETURNING id`,
    [projectId, xource.id, `${tag}-${slug}`, `spinoff/${tag}-${slug}`, zeeType])).id;
  const mkZee = (xellId, model, status, cost, reason) => q(
    `INSERT INTO zee (xell_id, attach_mode, entrypoint, kind, model, status, cost_usd,
                      last_stop_reason, last_event_at)
       VALUES ($1,'headless-spawn','cxell-cli','headless',$2,$3,$4,$5, now())`,
    [xellId, model, status, cost, reason]);
  const mkLand = (xellId, status, reqAgoMin, decidedAfterMin, by) => q(
    `INSERT INTO land_request (project_id, xell_id, ref, new_sha, status, requested_at,
                               decided_at, decided_by, landed_at)
       VALUES ($1,$2,'refs/heads/main',$3,$4, ${ago(reqAgoMin)},
               ${decidedAfterMin === null ? 'NULL' : ago(reqAgoMin - decidedAfterMin)}, $5,
               ${status === 'landed' ? ago(reqAgoMin - decidedAfterMin) : 'NULL'})`,
    [projectId, xellId, `${tag}-${Math.random().toString(16).slice(2, 12)}`, status, by]);

  // A: cut 300 min ago, first landing asked 200 min ago → cycle 100 min. Landed TWICE (rework).
  const A = await mkXell('a', 300);
  await mkZee(A, 'opus', 'stopped', 2.0, 'end_turn');
  await mkLand(A, 'landed', 200, 5, 'human@console');    // human waited 5 min
  await mkLand(A, 'landed', 120, 15, 'human@console');   // …and 15 min
  // B: cut 1000 min ago, first landing asked 100 min ago → cycle 900 min. One landed, one STALE.
  const B = await mkXell('b', 1000);
  await mkZee(B, 'opus', 'errored', 1.0, 'API Error: 429 {"type":"rate_limit_error"}');
  await mkLand(B, 'landed', 100, 10, 'human@console');   // human waited 10 min
  await mkLand(B, 'stale', 90, 4000, 'queenzee@stale');  // nobody was asked — must not count
  // C: claimed (has a zee), never asked to land → ABANDONED. Its zee died on a 401 → terminal.
  const C = await mkXell('c', 50);
  await mkZee(C, 'fable', 'errored', 0.5, 'API Error: 401 {"type":"authentication_error"}');
  // …and C is the one sitting on an OPEN tend: latest tend event is a request, 45 minutes old.
  await q(`INSERT INTO session_event (xell_id, source, hook_event_name, raw, ts)
             VALUES ($1,'hook','tend-request','{"reason":"needs a human"}'::jsonb, ${ago(45)})`, [C]);
  // D: never had a zee at all → POOL, NEVER CLAIMED. Its tend was RAISED and then CLEARED, so it is
  // not waiting on anyone — the latest event wins, exactly as the console's own fleet snapshot reads it.
  const D = await mkXell('d', 40);
  await q(`INSERT INTO session_event (xell_id, source, hook_event_name, ts)
             VALUES ($1,'hook','tend-request', ${ago(38)}), ($1,'hook','tend-clear', ${ago(20)})`, [D]);
  // E: a MANAGER that never landed — by design, so it must be excluded from the split.
  const E = await mkXell('e', 30, 'manager');
  await mkZee(E, 'fable', 'idle', 0.25, null);

  const t = await T.deliveryTelemetry({ projectId, days: 14 });

  console.log('  · 1 CYCLE TIME');
  eq(t.cycle_time.n, 2, 'two xells asked to land in the window');
  eq(t.cycle_time.p50, 500, 'p50 of [100, 900] = 500 min');
  eq(t.cycle_time.p90, 820, 'p90 = 820 min');
  eq(t.cycle_time.slowest[0].minutes, 900, 'the slowest is named (900 min)');

  console.log('  · 2 TURN DEATHS');
  eq(t.turn_deaths.zees_n, 4, 'four zees in the window');
  eq(t.turn_deaths.transient.n, 1, 'one transient death (the 429)');
  eq(t.turn_deaths.transient.cost, 1, 'costing $1.00');
  eq(t.turn_deaths.terminal.n, 1, 'one terminal death (the 401)');
  eq(t.turn_deaths.terminal.cost, 0.5, 'costing $0.50');
  eq(t.turn_deaths.terminal.landed, 0, 'and it landed nothing');
  eq(t.turn_deaths.transient.share, 0.25, 'share is over all four zees');

  console.log('  · 3 COST PER LANDED XELL');
  eq(t.cost_per_landed.n, 2, 'two xells landed in the window');
  eq(t.cost_per_landed.cost, 3, 'and cost $3.00 between them');
  eq(t.cost_per_landed.by_model[0].key, 'opus', 'both are filed under opus');
  eq(t.cost_per_landed.by_model[0].n, 2, 'n=2 — the sample the mean is over');
  eq(t.cost_per_landed.by_model[0].mean, 1.5, '$1.50 per landed xell');
  eq(t.cost_per_landed.by_harness[0].key, '(no harness)', 'harnessless xells are named, not dropped');

  console.log('  · 4 ERROR RATE BY MODEL');
  const opusRow = t.error_rate.by_model.find((r) => r.model === 'opus');
  const fableRow = t.error_rate.by_model.find((r) => r.model === 'fable');
  eq(opusRow.n, 2, 'opus: 2 zees'); eq(opusRow.errored, 1, '1 errored');
  eq(fableRow.n, 2, 'fable: 2 zees'); eq(fableRow.errored, 1, '1 errored');

  console.log('  · 5 REWORK');
  eq(t.rework.xells_n, 2, 'two xells landed something');
  eq(t.rework.landings_n, 3, 'three landings between them');
  eq(t.rework.relanded_n, 1, 'one of them had to land twice');
  eq(t.rework.buckets.find((b) => b.label === '2').n, 1, 'and sits in bucket 2');
  eq(t.rework.stale.n, 1, 'one stale landing');
  eq(t.rework.stale.xells, 1, 'on one xell');

  console.log('  · 6 HUMAN-GATE WAITS');
  eq(t.gate_waits.land.n, 3, 'three landings a human decided');
  eq(t.gate_waits.land.p50, 10, 'p50 of [5, 10, 15] = 10 min');
  eq(t.gate_waits.land.auto_n, 1, 'and the queenzee@stale row is filed as auto, not as a 4000-min wait');
  eq(t.gate_waits.ship.n, 0, 'no ships in this fixture — n=0, and no percentiles');
  eq(t.gate_waits.ship.p50, null, '…which renders as "no data", not as "instant"');
  eq(t.gate_waits.tends_open.n, 1, 'one OPEN tend — the cleared one is not waiting on anybody');
  near(t.gate_waits.tends_open.p50, 45, 'and it has been waiting ~45 min (age, not a decision time)', 1);
  eq(t.gate_waits.tends_open.oldest.xell, `${tag}-c`, 'the oldest open tend names its xell');

  console.log('  · 7 XELLS THAT NEVER RAISED A LANDING');
  eq(t.never_landed.xells_cut, 5, 'five xells cut in the window');
  eq(t.never_landed.workers_cut, 4, 'four of them workers');
  eq(t.never_landed.n, 2, 'two workers never asked to land');
  eq(t.never_landed.never_claimed.n, 1, 'one was never claimed out of the pool (no zee ever)');
  eq(t.never_landed.abandoned.n, 1, 'one was claimed and abandoned');
  eq(t.never_landed.abandoned.cost, 0.5, 'and it burned $0.50 doing it');
  eq(t.never_landed.managers_excluded, 1, 'the manager is excluded — a manager cannot land at all');

  console.log('  · the window, and the refusals');
  const narrow = await T.deliveryTelemetry({ projectId, days: 1 });
  eq(narrow.window_days, 1, 'a 1-day window is honoured');
  eq(narrow.cycle_time.n, 2, 'and both landings are still inside it');
  eq((await T.deliveryTelemetry({ projectId, days: 99999 })).window_days, T.WINDOW_DAYS_MAX,
     `an absurd window clamps at ${T.WINDOW_DAYS_MAX} days rather than erroring`);
  eq((await T.deliveryTelemetry({ projectId })).window_days, T.DEFAULT_WINDOW_DAYS, 'the default window is 14 days');
  for (const [args, want] of [[{ projectId: null }, 400], [{ projectId: '00000000-0000-4000-8000-000000000000' }, 404]]) {
    const status = await T.deliveryTelemetry(args).then(() => 0, (e) => e.status);
    eq(status, want, `${args.projectId ? 'an unknown project' : 'no project'} is refused with ${want}`);
  }
} catch (err) {
  if (!/could not reach|password authentication/.test(err.message)) {
    console.log(`  ✗ FAIL ${err.message}`);
    failures++;
  }
} finally {
  // session_event FIRST, and by hand: its xell_id is ON DELETE SET NULL (a session's history
  // outlives the xell it happened in), so dropping the project would leave the tend rows behind
  // with a null xell — orphans, in the live meta-DB, forever. Deleting them while the xells still
  // exist is what makes the cleanup complete. THEN the project, whose cascade takes the rest.
  if (projectId) await q(
    `DELETE FROM session_event WHERE xell_id IN (SELECT id FROM xell WHERE project_id = $1)`,
    [projectId]).catch((e) => {
    console.log(`  ✗ FAIL cleanup left session_event rows behind: ${e.message}`); failures++;
  });
  if (projectId) await q(`DELETE FROM project WHERE id = $1`, [projectId]).catch((e) => {
    console.log(`  ✗ FAIL cleanup left rows behind: ${e.message}`); failures++;
  });
  await pool.end().catch(() => {});
}

console.log(failures ? `\n${failures} FAILED` : '\nall good');
process.exit(failures ? 1 : 0);
