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
//   E. the LOOP (database): the global spinTick() sweep ends a spinning turn end to end.
//
// ⚠ NEVER RUN AGAINST A LIVE/SHARED DATABASE. Section E calls the GLOBAL spinTick() sweep, which
// judges every open turn in the database and ENDS any that look like spins. Against a throwaway db
// (db-sandbox, a per-xell clone) the only open turns are this test's and the sweep is safe; against
// a shared/live db it would end REAL turns belonging to other zees. Section E carries a RUNTIME
// GUARD, not just this warning: it refuses the global sweep when any open turn belongs to another
// project, and skips the assertions that depend on it.
//
// Everything it creates is deleted in a finally, whatever happens (house rule 1).
import { randomUUID } from 'node:crypto';
import { q, one, pool } from '../server/src/db/pool.js';
import { detectSpin, DEFAULT_SPIN_CONFIG, spinConfigFor, lastProgressAtForTurn, endSpinningTurn,
         SPIN_STOP_REASON, PROGRESS_EVENT_NAMES } from '../server/src/lib/spin-detector.js';

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };

// A synthetic gateway-request row in the shape detectSpin reads. When `work` is given, the row
// carries the input/output split (work = input+output, the metric the detector judges similarity
// on) plus `cache` as the re-sent cached context that dominates total_tokens — matching the real
// ledger. Without `work`, the row is a legacy shape with only total_tokens (the fallback path).
const req = (total, path = '/v1/messages', at = new Date(), extra = {}, work = null, cache = 0) => {
  const row = { path, total_tokens: total, requested_at: at, ...extra };
  if (work != null) {
    row.input_tokens = Math.floor(work / 2);
    row.output_tokens = Math.ceil(work / 2);
    row.cache_read_tokens = cache;
  }
  return row;
};

// A "spinning" fixture: 30 calls of ~72k tokens each, same path, no progress — the measured shape.
// Total-tokens-only (legacy shape) → the fallback still trips on the total.
const SPIN_ROWS = Array.from({ length: 30 }, (_, i) => req(72000 + (i % 3) * 500));
// An equally long but DIVERSE fixture: 30 calls, same total-ish spend, sizes spanning 5k→500k.
const DIVERSE_ROWS = Array.from({ length: 30 }, (_, i) => req(5000 + (i * 17000)));

// THE FALSE-POSITIVE SHAPE THE FIX TARGETS: a WORKING long-context zee. Every call carries the
// same ~70k cached context (manual+skills+task), so total_tokens barely moves (max/min ≈ 1.05)
// while the actual NEW work (input+output) varies 8×+. Before the fix, the detector measured the
// near-constant total and called this a spin. It must NOT spin.
const WORKING_LONG_CONTEXT = Array.from({ length: 25 }, (_, i) => {
  const work = 500 + ((i * 7919) % 3800);          // genuinely varied new work: 500..4300
  return req(work + 70000, '/v1/messages', new Date(Date.now() - (25 - i) * 45000), {}, work, 70000);
});
// A REAL poll loop: small near-constant new work (~400 tokens of "is it done?") over the same
// cache. This is what the detector exists to catch.
const REAL_POLL_LOOP = Array.from({ length: 25 }, (_, i) => {
  const work = 420 + (i % 3) * 20;                 // ~420 tokens, near-constant
  return req(work + 50000, '/v1/messages', new Date(Date.now() - (25 - i) * 30000), {}, work, 50000);
});

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

// THE FALSE-POSITIVE REGRESSION (the bug this fix exists for): a WORKING long-context zee whose
// total_tokens are dominated by a constant cached context must NOT be read as a spin. Its NEW
// work (input+output) varies 8×+, which is the correct "not-similar" signal.
const workingLong = detectSpin({ requests: WORKING_LONG_CONTEXT, lastProgressAt: null, cfg });
ok(workingLong.spinning === false && workingLong.reason === 'not-similar',
   `WORKING long-context zee (constant cache, varied new work) → NOT a spin (max/min ${workingLong.maxSizeRatio.toFixed(1)}) — the cache is a constant, the work is not`);
// ...while a REAL poll loop with the same cached context but small near-constant new work MUST trip.
const realPoll = detectSpin({ requests: REAL_POLL_LOOP, lastProgressAt: null, cfg });
ok(realPoll.spinning === true,
   `REAL poll loop over the same cache → SPIN (${realPoll.windowCalls} calls, max/min ${realPoll.maxSizeRatio.toFixed(2)}) — small repeated new work`);

// Edge cases.
const underFloor = detectSpin({ requests: SPIN_ROWS.slice(0, 19), cfg });
ok(underFloor.spinning === false && underFloor.reason === 'not-enough-calls',
   'UNDER the call floor (19 calls) → not a spin — no verdict before there is a budget to spend');
ok(underFloor.windowTokens === SPIN_ROWS.slice(0, 19).reduce((s, r) => s + r.total_tokens, 0),
   'the not-enough-calls verdict reports the REAL token sum, not a placeholder zero');
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
let createdHarnessId = null;
const cleanup = async () => {
  // House rule 1, in a finally, whatever happened. Three kinds of row need explicit cleanup:
  //
  // 1. The HARNESS is GLOBAL (not project-scoped), so deleting the project does not cascade to it —
  //    delete the test's harness row explicitly.
  // 2. session_event.xell_id/zee_id are `REFERENCES xell ON DELETE SET NULL`, so dropping the project
  //    NULLS the link instead of removing the row — the spin-detector events this test raises would
  //    survive as orphans in the SHARED dev database, forever. Collect them by JOIN on the project
  //    BEFORE the project goes (scoped to rows this run made, never "orphans of this kind", which
  //    would also sweep a sibling xell's run) and delete them explicitly.
  // 3. The project itself, which cascades to its xell/zee/zee_turn/llm_gateway_request/zee_message.
  try { if (createdHarnessId) await q(`DELETE FROM harness WHERE id=$1`, [createdHarnessId]); } catch { /* already gone */ }
  const mine = PID
    ? await q(`SELECT se.id FROM session_event se JOIN xell x ON x.id = se.xell_id
                WHERE x.project_id = $1`, [PID]).catch(() => [])
    : [];
  if (mine.length) await q(`DELETE FROM session_event WHERE id = ANY($1::bigint[])`, [mine.map((r) => r.id)]).catch(() => {});
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
  // A realistic gateway row: `work` is the call's NEW work (input+output — the metric the detector
  // judges similarity on), `cache` the re-sent cached context that DOMINATES total_tokens. A poll
  // loop keeps work small and near-constant; a working long-context zee varies work widely while its
  // total_tokens barely moves (the cache is the constant). Splitting the columns is what lets the
  // detector tell them apart — the old total_tokens-only similarity is the false-positive bug.
  const mkGatewayRow = async (turnId, work, cache = 70000) => one(
    `INSERT INTO llm_gateway_request
       (xell_id, zee_id, turn_id, project_id, kind, method, path, input_tokens, output_tokens, cache_read_tokens, total_tokens)
     VALUES ($1,$2,$3,$4,'messages','POST','/v1/messages',$5,$6,$7,$8) RETURNING *`,
    [undefined, undefined, turnId, PID, Math.floor(work / 2), Math.ceil(work / 2), cache, work + cache]);
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
  createdHarnessId = harness.id;
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

  // endTurn is a ONE-SHOT act now: a turn that already ended is never re-stamped. Call it again
  // with a different stop reason and prove the ending state is untouched (review fix #2 — a wrong
  // label in a ledger we are building trust in is not cosmetic).
  const { endTurn } = await import('../server/src/lib/turn-ledger.js');
  const restamped = await endTurn(turn.id, { status: 'errored', burn: { cost: 9, input: 999, output: 0, cacheRead: 0, cacheWrite: 0 }, stopReason: 'late-writer' });
  ok(restamped === null, 'a SECOND endTurn on an ended turn returns null (no re-stamp)');
  const afterRestamp = await turnRow(turn.id);
  ok(afterRestamp.status === 'ended' && afterRestamp.stop_reason === SPIN_STOP_REASON
     && Number(afterRestamp.cost_usd) !== 9,
     'the ended turn keeps status/stop_reason/burn from the FIRST end — the late writer changed nothing');

  // The #2 back-off: endSpinningTurn on a turn that ALREADY ended cleanly must NOT label it a spin.
  // This is the "clean exit mislabelled as spin-detector" race — a natural end racing the sweep. The
  // detector closes the turn FIRST (endTurn one-shot); when the close finds the turn already ended it
  // backs off entirely: no zee marker, no evidence event, no notification.
  const reportsBefore = (await one(
    `SELECT count(*)::int AS n FROM zee_message WHERE to_xell_id=$1 AND kind='report'`, [man.id])).n;
  const cleanXell = await mkXell('spin-clean-exit');
  const cleanZee = await mkZee(cleanXell.id, { n: 4 });
  const cleanTurn = await mkTurn(cleanZee.id, cleanXell.id);
  await endTurn(cleanTurn.id, { status: 'ended', stopReason: 'end_turn',
                                burn: { cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
  const outClean = await endSpinningTurn({
    turn: { id: cleanTurn.id }, zee: { id: cleanZee.id },
    xell: { id: cleanXell.id, slug: cleanXell.slug, project_id: PID },
    burn: { cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    evidence: { windowCalls: 25, windowTokens: 1750000, maxSizeRatio: 1 },
    manager: man, by: 'spin-detector',
  });
  ok(outClean.alreadyEnded === true && outClean.ended === false && outClean.notified === null,
     `a turn that already ended cleanly is NOT relabelled — endSpinningTurn backs off (${JSON.stringify(outClean)})`);
  const cleanTRow = await turnRow(cleanTurn.id);
  ok(cleanTRow.status === 'ended' && cleanTRow.stop_reason === 'end_turn',
     'the clean turn keeps its OWN stop_reason (end_turn), not spin-detector');
  const cleanZRow = await zeeRow(cleanZee.id);
  ok(cleanZRow.last_stop_reason !== SPIN_STOP_REASON,
     'the zee is NOT marked spin-detector for a turn that ended naturally');
  const cleanEv = await one(
    `SELECT count(*)::int AS n FROM session_event WHERE turn_id=$1 AND hook_event_name='spin-detector'`, [cleanTurn.id]);
  ok(cleanEv.n === 0, 'no spin-detector evidence event for a turn that was never closed as a spin');
  const reportsAfter = (await one(
    `SELECT count(*)::int AS n FROM zee_message WHERE to_xell_id=$1 AND kind='report'`, [man.id])).n;
  ok(reportsAfter === reportsBefore, 'and the manager was NOT told about a non-spin (no new report)');

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
  //
  // RUNTIME GUARD (not just the header warning): spinTick() is the GLOBAL sweep — it judges EVERY
  // open turn in the database. Against a throwaway db the only open turns are this test's; against a
  // live/shared db it would END real turns belonging to other zees. So before calling it, refuse
  // when any open turn belongs to a foreign project, and skip the assertions that depend on the
  // sweep. (This test's own fixture turn is still created and verified as 'started' below; on a
  // clean throwaway db the guard passes and the sweep runs.)
  const spinXell = await mkXell('spin-loop-worker');
  await q(`UPDATE xell SET manager_xell_id=$2 WHERE id=$1`, [spinXell.id, man.id]);
  const spinZee = await mkZee(spinXell.id, { n: 3, status: 'working' });
  const spinTurn = await mkTurn(spinZee.id, spinXell.id);
  for (let i = 0; i < 25; i++) await mkGatewayRow(spinTurn.id, 70000 + (i % 3) * 200);
  const foreignOpen = await one(
    `SELECT count(*)::int AS n FROM zee_turn t
       JOIN zee z ON z.id=t.zee_id
       JOIN xell x ON x.id=t.xell_id
      WHERE t.status='started' AND x.project_id <> $1`, [PID]);
  if ((foreignOpen?.n || 0) > 0) {
    console.log(`  ⚠ ${foreignOpen.n} foreign open turn(s) present — REFUSING the global spinTick sweep `
      + '(it would end real turns). Section E skipped; the fixture turn stays open for the finally to clean.');
  } else {
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
  }

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
