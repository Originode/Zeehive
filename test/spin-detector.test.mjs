// THE SPIN DETECTOR — end a turn that is burning tokens on a poll loop, and tell its manager.
//
// Live prod evidence (the card this test enforces): one spawn turn made 69 gateway calls and
// burned 5,003,163 tokens; another made 29. Zees loop polling for other zees or for a human gate,
// and nothing enforced the manual's own "never hand-roll a wait" rule. This feature is the cheap
// half: a per-turn budget the queenzee enforces from the gateway ledger it already writes
// (llm_gateway_request, 154) — calls and tokens per turn_id are one query — which ends a runaway
// turn, records why, and reports to the xell's manager (or raises a tend when there is none).
// The lease/await model is the cure; this is the interim alarm, kept self-contained (lib +
// loop + migration 158) and cheap to remove.
//
// THE SIGNAL IS REPETITION WITHOUT PROGRESS, NOT DURATION. A long honest build/verify turn makes
// many calls too; it does NOT make them all the same size with nothing landing/reporting/pinging
// in between. So the test asserts BOTH sides of that line:
//
//   A. the DETECTOR, pure (no database): synthetic ledger rows — 30 calls of ~72k tokens each,
//      same path, no progress — TRIP it; an equally long (30 calls, >1M tokens) but DIVERSE turn
//      (sizes spanning 5k→500k) does NOT. Plus the edge cases: under the call floor, under the
//      token floor, a zero-token call (a change ⇒ not repetition), a progress event that resets
//      the window, and multiple paths.
//   B. the CONFIG LOOKUP (database): harness > project > default, and a missing table falls back
//      to the code defaults.
//   C. the END (database): a spun turn is booked ended with stop_reason='spin-detector', its zee
//      is idle (NOT errored, NOT reaped), the evidence rides a session_event, and the manager is
//      sent a report — or a TEND is raised when there is no manager.
//
// Everything it creates is deleted in a finally, whatever happens (house rule 1).
import { randomUUID } from 'node:crypto';
import { q, one, pool } from '../server/src/db/pool.js';
import { detectSpin, DEFAULT_SPIN_CONFIG, spinConfigFor, lastProgressAtForTurn, endSpinningTurn,
         SPIN_STOP_REASON, PROGRESS_EVENT_NAMES } from '../server/src/lib/spin-detector.js';

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };

// A synthetic gateway-request row in the shape detectSpin reads.
const req = (total, path = '/v1/messages', at = new Date(), extra = {}) =>
  ({ path, total_tokens: total, requested_at: at, ...extra });

// A "spinning" fixture: 30 calls of ~72k tokens each, same path, no progress — the measured shape.
const SPIN_ROWS = Array.from({ length: 30 }, (_, i) => req(72000 + (i % 3) * 500));
// An equally long but DIVERSE fixture: 30 calls, same total-ish spend, sizes spanning 5k→500k.
const DIVERSE_ROWS = Array.from({ length: 30 }, (_, i) => req(5000 + (i * 17000)));

console.log('\n── A. the detector: repetition WITHOUT progress trips; diverse work does not ──');
const cfg = DEFAULT_SPIN_CONFIG;
const now = new Date();

// The two headline cases.
const spin = detectSpin({ requests: SPIN_ROWS, lastProgressAt: null, cfg });
ok(spin.spinning === true && spin.reason === 'repetition-without-progress',
   `30 similar-sized calls, no progress → SPIN (${spin.windowCalls} calls / ${spin.windowTokens} tokens, max/min ${spin.maxSizeRatio.toFixed(2)})`);
const diverse = detectSpin({ requests: DIVERSE_ROWS, lastProgressAt: null, cfg });
ok(diverse.spinning === false && diverse.reason === 'not-similar',
   `30 calls of genuinely diverse size → NOT a spin (max/min ${diverse.maxSizeRatio.toFixed(1)}) — a real turn's context grows`);

// Edge cases.
ok(detectSpin({ requests: SPIN_ROWS.slice(0, 19), cfg }).spinning === false,
   'UNDER the call floor (19 calls) → not a spin — no verdict before there is a budget to spend');
const small = Array.from({ length: 30 }, (_, i) => req(20000));
ok(detectSpin({ requests: small, cfg }).spinning === false,
   'UNDER the token floor (30×20k = 600k < 1M) → not a spin');
ok(detectSpin({ requests: [...SPIN_ROWS.slice(0, 29), req(0)] , cfg }).spinning === false,
   'a ZERO-TOKEN call in the window → not similar → not a spin (an error is a CHANGE, and change is the opposite of repetition)');
const multiPath = SPIN_ROWS.map((r, i) => (i === 15 ? req(r.total_tokens, '/v1/chat/completions') : r));
ok(detectSpin({ requests: multiPath, cfg }).spinning === false,
   'MULTIPLE paths in the window → not a spin (the zee switched dialects mid-window — it was doing something different)');

// Progress RESETS the window: the 10 calls AFTER a progress event do not clear the call floor.
const withProgress = detectSpin({
  requests: [...Array.from({ length: 20 }, (_, i) => req(72000, '/v1/messages', new Date(now.getTime() - 30 * 60000 + i * 60000))),
              ...Array.from({ length: 10 }, (_, i) => req(72000, '/v1/messages', new Date(now.getTime() - 5 * 60000 + i * 30000)))],
  lastProgressAt: new Date(now.getTime() - 6 * 60000),
  cfg,
});
ok(withProgress.spinning === false && withProgress.windowCalls === 10,
   `progress 6 minutes ago RESETS the window — only the 10 calls after it count (${withProgress.windowCalls}), under the call floor`);
// ...but 25 similar calls AFTER the last progress still trip.
const afterProgress = detectSpin({
  requests: Array.from({ length: 25 }, (_, i) => req(72000, '/v1/messages', new Date(now.getTime() - 5 * 60000 + i * 30000))),
  lastProgressAt: new Date(now.getTime() - 6 * 60000),
  cfg,
});
ok(afterProgress.spinning === true && afterProgress.windowCalls === 25,
   '25 similar calls AFTER the last progress event still trip — progress does not pardon what follows it');

// The measured case: 69 calls / 5,003,163 tokens (~72.5k each) must trip.
const measured = Array.from({ length: 69 }, (_, i) => req(72500 + (i % 5) * 100));
const m = detectSpin({ requests: measured, cfg });
ok(m.spinning === true, `the measured 69-call / ~5M-token case trips (${m.windowCalls} calls / ${m.windowTokens} tokens, max/min ${m.maxSizeRatio.toFixed(2)})`);

// ── B/C/D need a database ─────────────────────────────────────────────────────────────────────────
const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required for sections B–D'); process.exit(2); }

const PID = randomUUID();
const cleanup = async () => {
  try { await q(`DELETE FROM project WHERE id=$1`, [PID]); } catch { /* already gone */ }
};

try {
  await cleanup();
  await q(`INSERT INTO project (id, name, repo_root, main_branch) VALUES ($1,'spin-detector',$2,'main')`, [PID, '/tmp/spin-detector']);
  const xource = await one(`INSERT INTO xource (project_id, ref) VALUES ($1,'main') RETURNING *`, [PID]);
  const mkXell = async (slug, over = {}) => one(
    `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status, self_token_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [PID, xource.id, slug, `spinoff/${slug}`, `/tmp/spin/${slug}`, over.status ?? 'working', `hash-${slug}`]);
  const mkZee = async (xellId, over = {}) => one(
    `INSERT INTO zee (xell_id, attach_mode, entrypoint, kind, runtime_id, viewer_kind, viewer_url,
                      claude_session_id, model, status, last_stop_reason)
     VALUES ($1,'headless-spawn','cxell-cli','headless',$2,$3,$4,$5,'opus',$6,$7) RETURNING *`,
    [xellId, null, 'ssh-terminal', 'ssh://zee@127.0.0.1:2222',
     `00000000-0000-4000-8000-00000000${(over.n || 0).toString().padStart(4, '0')}`,
     over.status ?? 'working', over.stopReason ?? null]);
  const mkTurn = async (zeeId, xellId, kind = 'spawn') => one(
    `INSERT INTO zee_turn (zee_id, xell_id, project_id, kind, status) VALUES ($1,$2,$3,$4,'started') RETURNING *`,
    [zeeId, xellId, PID, kind]);
  const mkGatewayRow = async (turnId, total) => one(
    `INSERT INTO llm_gateway_request (xell_id, zee_id, turn_id, project_id, kind, method, path, total_tokens)
     VALUES ($1,$2,$3,$4,'messages','POST','/v1/messages',$5) RETURNING *`,
    [undefined, undefined, turnId, PID, total]);
  const turnRow = (id) => one(`SELECT * FROM zee_turn WHERE id=$1`, [id]);
  const zeeRow = (id) => one(`SELECT * FROM zee WHERE id=$1`, [id]);

  console.log('\n── B. the config lookup: harness > project > default ──');
  // No rows at all → code defaults.
  const dflt = await spinConfigFor({ projectId: PID, harnessId: null });
  ok(dflt.minCalls === DEFAULT_SPIN_CONFIG.minCalls && dflt.minTokens === DEFAULT_SPIN_CONFIG.minTokens
     && dflt.maxSizeSpread === DEFAULT_SPIN_CONFIG.maxSizeSpread,
     'no config rows → code defaults (a database without the table behaves identically)');
  // Project override.
  await q(`INSERT INTO spin_detector_config (scope, project_id, min_calls, min_tokens)
           VALUES ('project',$1,9,777)`, [PID]);
  const proj = await spinConfigFor({ projectId: PID, harnessId: null });
  ok(proj.minCalls === 9 && proj.minTokens === 777 && proj.maxSizeSpread === DEFAULT_SPIN_CONFIG.maxSizeSpread,
     'a PROJECT row overrides min_calls/min_tokens and inherits the rest');
  // Harness override beats project.
  const harness = await one(`INSERT INTO harness (key, label) VALUES ($1,$2) RETURNING *`, [`spin-h-${PID.slice(0, 8)}`, 'spin test harness']);
  await q(`INSERT INTO spin_detector_config (scope, harness_id, min_calls) VALUES ('harness',$1,3)`, [harness.id]);
  const har = await spinConfigFor({ projectId: PID, harnessId: harness.id });
  ok(har.minCalls === 3 && har.minTokens === 777,
     'a HARNESS row beats the project row (harness > project > default)');
  ok((await spinConfigFor({ projectId: PID, harnessId: null })).minCalls === 9,
     'the harness override is scoped — a xell WITHOUT that harness still reads the project row');

  console.log('\n── C. endSpinningTurn: booked ended, zee idle, manager told ──');
  const man = await mkXell('spin-manager', { status: 'idle' });
  await q(`UPDATE xell SET zee_type='manager' WHERE id=$1`, [man.id]);
  const worker = await mkXell('spin-worker');
  const zee = await mkZee(worker.id, { n: 1 });
  const turn = await mkTurn(zee.id, worker.id);
  for (let i = 0; i < 30; i++) await mkGatewayRow(turn.id, 72000 + (i % 3) * 500);
  const burn = await one(
    `SELECT COALESCE(SUM(total_tokens),0)::bigint AS total, COALESCE(SUM(cost_usd),0)::numeric AS cost
       FROM llm_gateway_request WHERE turn_id=$1`, [turn.id]);

  const outcome = await endSpinningTurn({
    turn: { id: turn.id }, zee: { id: zee.id }, xell: { id: worker.id, slug: worker.slug, project_id: PID },
    burn: { cost: Number(burn.cost || 0), input: Number(burn.total || 0), output: 0, cacheRead: 0, cacheWrite: 0 },
    evidence: { windowCalls: 30, windowTokens: Number(burn.total || 0), maxSizeRatio: 1.01 },
    manager: man, by: 'spin-detector',
  });
  ok(outcome.ended === true && outcome.notified?.kind === 'manager' && outcome.notified?.ok === true,
     `endSpinningTurn reports ended + manager notified (${JSON.stringify(outcome.notified)})`);

  const t = await turnRow(turn.id);
  ok(t.status === 'ended' && t.stop_reason === SPIN_STOP_REASON,
     'the turn row is ENDED with stop_reason=spin-detector');
  const turnTotal = Number(t.input_tokens) + Number(t.output_tokens)
    + Number(t.cache_read_tokens) + Number(t.cache_write_tokens);
  ok(turnTotal === Number(burn.total),
     `the turn row carries its CUMULATIVE ledger burn (${turnTotal} tokens) — the "5M tokens" number is recorded`);
  ok(t.meta?.spin_detected === true && t.meta?.windowCalls === 30,
     'the turn meta records spin_detected + the evidence (windowCalls)');

  const z = await zeeRow(zee.id);
  ok(z.status === 'idle' && z.last_stop_reason === SPIN_STOP_REASON && z.decommissioned_at === null,
     'the zee is IDLE with stop_reason=spin-detector and NOT decommissioned (never reaped)');

  const ev = await one(`SELECT raw FROM session_event WHERE turn_id=$1 AND hook_event_name='spin-detector'`, [turn.id]);
  ok(ev?.raw?.stop_reason === SPIN_STOP_REASON && ev?.raw?.windowCalls === 30,
     'a session_event carries the evidence (raw.stop_reason + windowCalls) for the console to replay');

  const msg = await one(`SELECT body FROM zee_message WHERE to_xell_id=$1 AND kind='report' ORDER BY created_at DESC LIMIT 1`, [man.id]);
  ok(msg?.body && /spin/i.test(msg.body) && /NOT reaped/i.test(msg.body),
     'the manager received a report naming the spin and saying the zee was NOT reaped');

  // No-manager path → tend.
  const orphan = await mkXell('spin-orphan');
  const orphanZee = await mkZee(orphan.id, { n: 2 });
  const orphanTurn = await mkTurn(orphanZee.id, orphan.id);
  for (let i = 0; i < 25; i++) await mkGatewayRow(orphanTurn.id, 70000);
  const out2 = await endSpinningTurn({
    turn: { id: orphanTurn.id }, zee: { id: orphanZee.id },
    xell: { id: orphan.id, slug: orphan.slug, project_id: PID },
    burn: { cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    evidence: { windowCalls: 25, windowTokens: 1750000, maxSizeRatio: 1 },
    manager: null, by: 'spin-detector',
  });
  ok(out2.notified?.kind === 'tend' && out2.notified?.ok === true,
     'a spin with NO manager raises a TEND instead');
  const tend = await one(
    `SELECT hook_event_name FROM session_event
      WHERE xell_id=$1 AND hook_event_name IN ('tend-request','tend-clear')
      ORDER BY ts DESC LIMIT 1`, [orphan.id]);
  ok(tend?.hook_event_name === 'tend-request', 'the orphan xell shows an OPEN tend (tend-request is its latest)');

  console.log('\n── E. the loop (spinTick): a spinning turn is ENDED end to end ──');
  // A fresh, still-'started' turn with 25 similar calls and NO progress. spinTick must find it,
  // judge it a spin, end it and tell the manager — the whole DB half of the loop, with no docker
  // (PROVISION_MODE in this cage is simulate, so the CLI interrupt is skipped by design).
  const spinXell = await mkXell('spin-loop-worker');
  await q(`UPDATE xell SET manager_xell_id=$2 WHERE id=$1`, [spinXell.id, man.id]);
  const spinZee = await mkZee(spinXell.id, { n: 3, status: 'working' });
  const spinTurn = await mkTurn(spinZee.id, spinXell.id);
  for (let i = 0; i < 25; i++) await mkGatewayRow(spinTurn.id, 70000 + (i % 3) * 200);
  const { spinTick } = await import('../server/src/queenzee/spin.js');
  const tick = await spinTick();
  ok(tick.checked >= 1 && tick.ended === 1,
     `spinTick judged the open turns and ended the one that was spinning (checked=${tick.checked}, ended=${tick.ended})`);
  const closed = await turnRow(spinTurn.id);
  ok(closed.status === 'ended' && closed.stop_reason === SPIN_STOP_REASON,
     'spinTick closed the spinning turn with stop_reason=spin-detector');
  const loopZee = await zeeRow(spinZee.id);
  ok(loopZee.status === 'idle' && loopZee.last_stop_reason === SPIN_STOP_REASON,
     'spinTick idled the spinning zee (stop_reason=spin-detector, not errored)');
  const loopMsg = await one(`SELECT body FROM zee_message WHERE to_xell_id=$1 AND kind='report' ORDER BY created_at DESC LIMIT 1`, [man.id]);
  ok(loopMsg?.body && /spin/i.test(loopMsg.body), 'spinTick told the manager');

  console.log('\n── D. lastProgressAtForTurn: a report resets the detector window ──');
  const noProgress = await lastProgressAtForTurn({ xellId: worker.id, startedAt: t.started_at });
  ok(noProgress === null, 'no progress event yet → null (the full window is suspect)');
  await q(`INSERT INTO zee_message (project_id, from_xell_id, from_slug, to_xell_id, to_slug, kind, body)
           VALUES ($1,$2,$3,$4,$5,'report','progress report')`, [PID, worker.id, worker.slug, man.id, man.slug]);
  const afterReport = await lastProgressAtForTurn({ xellId: worker.id, startedAt: t.started_at });
  ok(afterReport instanceof Date, 'a report from the xell to its manager becomes the last progress event');
  await q(`INSERT INTO session_event (source, hook_event_name, zee_id, xell_id, raw)
           VALUES ('self','working-ping',$1,$2,'{"note":"still here"}'::jsonb)`, [zee.id, worker.id]);
  const afterPing = await lastProgressAtForTurn({ xellId: worker.id, startedAt: t.started_at });
  ok(afterPing instanceof Date && afterPing > afterReport,
     'a working-ping (a self verb, xell-scoped) also counts as progress, and latest wins');
  const narrowed = detectSpin({
    requests: Array.from({ length: 5 }, () => req(72000, '/v1/messages', new Date(afterReport.getTime() + 60000))),
    lastProgressAt: afterReport, cfg,
  });
  ok(narrowed.spinning === false && narrowed.windowCalls === 5,
     'the 5 calls AFTER the report are the new window — under the call floor, not a spin');

} finally {
  await cleanup();
  await pool.end().catch(() => {});
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
