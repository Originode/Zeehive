// TURN BUDGET WARNING — the "cheap half of TKT-78": a per-turn METER that emits ONE warning when a
// turn's running token total crosses ~12M, so a zee approaching the vendor's ceiling is told to
// land what it has (bare-'error' deaths average 18.8M tokens / $12.15 against 9.8M / $7.02 healthy —
// a ceiling, not a random fault, and a dead turn takes its unlanded work with it).
//
// WHAT THIS TEST CERTIFIES — read this before trusting the word "warned" anywhere in here. The
// warning is EMITTED and RECORDED; it is NOT guaranteed to reach the zee before the turn dies.
// Mid-turn delivery is QUEUED by zee-turn.js:77 (MID_TURN_STATUSES includes 'working'), and the
// queue drains only when the turn ends. So in production a mid-turn warning waits in the talk queue
// and reaches the RESUMED zee after the death — recovery, not prevention, until a mid-turn channel
// exists (an open question for a human). The queenzee RECORDS the delivery verdict on the turn row
// (meta.turn_budget_warning.delivery), and this test asserts that verdict rather than claiming the
// zee "was warned". In THIS harness the zee has viewer_kind='none' (no live cxell), so the honest
// verdict is delivery:'none' — emitted and recorded, not deliverable here; section F proves the
// production mid-turn routing is 'queued'.
//
// What this file covers:
//   A. usageFromFeedEvent — the pure per-event token extractor handles the stream_event wrapper,
//      message_start (input + cache-write) and message_delta (output + cache-read), and IGNORES the
//      result event (its usage is the cumulative END checkpoint, not a delta).
//   B. The warning TEXT — names the token count and tells the zee to commit + land NOW.
//   C. A synthetic stream driven past the threshold through recordFeedEvent → EXACTLY ONE warning,
//      the turn row records meta.turn_budget_warning = {fired, tokens, delivery, delivery_sent,
//      delivery_reason}, and the turn is NOT ended by our code.
//   D. Exactly-once: feeding more tokens after the warning does not re-fire it.
//   E. A turn under the threshold is untouched (no meta, no warning, still started).
//   F. The mid-turn routing verdict — decideMessageDelivery routes a WORKING zee in a live cxell to
//      'queued' (zee-turn.js:77), which is exactly why a ceiling-death turn cannot be warned in time
//      and why the recorded verdict matters.
//
// Against DATABASE_URL with a throwaway project/xell/zee/turn, torn down in `finally`.
import { randomUUID } from 'node:crypto';
import { q, one, pool } from '../server/src/db/pool.js';
import { decideMessageDelivery } from '../server/src/lib/zee-turn.js';
import {
  startTurn, recordFeedEvent, endTurn,
  TURN_BUDGET_WARNING_TOKENS, turnBudgetWarningMessage, usageFromFeedEvent,
  turnBudgetRunningTotal, turnBudgetWarningStats, resetTurnBudgetWarningStats,
} from '../server/src/lib/turn-ledger.js';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };
const eq = (a, b, m) => ok(a === b, `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

console.log('\n── A. usageFromFeedEvent — the per-event token extractor (pure) ──');
{
  const s = usageFromFeedEvent({ type: 'stream_event', event: {
    type: 'message_start', message: { usage: { input_tokens: 100, cache_creation_input_tokens: 7 } } } });
  eq(s.input, 100, 'message_start input_tokens → input');
  eq(s.cacheWrite, 7, 'message_start cache_creation_input_tokens → cacheWrite');
  eq(s.output, 0, 'message_start has no output');
  const d = usageFromFeedEvent({ type: 'stream_event', event: {
    type: 'message_delta', usage: { output_tokens: 42, cache_read_input_tokens: 9 } } });
  eq(d.output, 42, 'message_delta output_tokens → output');
  eq(d.cacheRead, 9, 'message_delta cache_read_input_tokens → cacheRead');
  eq(d.input, 0, 'message_delta has no input');
  // The SDK path's SDKPartialAssistantMessage is the same shape (stream_event wrapper).
  const sdk = usageFromFeedEvent({ type: 'stream_event', event: {
    type: 'message_start', message: { usage: { input_tokens: 5, cache_creation_input_tokens: 0 } } } });
  eq(sdk.input, 5, 'SDK-shaped stream_event wrapper is read the same way');
  // A bare (unwrapped) message_delta — some parsers emit the raw event without the wrapper.
  const bare = usageFromFeedEvent({ type: 'message_delta', usage: { output_tokens: 11 } });
  eq(bare.output, 11, 'a bare message_delta is read without a wrapper');
  // The result event is NOT a delta — its usage is the cumulative end checkpoint and must NOT be
  // accumulated (it arrives when the turn is over, too late to warn).
  const r = usageFromFeedEvent({ type: 'result', usage: { input_tokens: 99_999, output_tokens: 88_888 } });
  eq(r.input + r.output + r.cacheRead + r.cacheWrite, 0, 'the result event contributes ZERO (cumulative, not a delta)');
  const none = usageFromFeedEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } });
  eq(none.input + none.output, 0, 'an assistant text event carries no per-request usage delta');
  eq(usageFromFeedEvent(null).input, 0, 'null → all-zero (never throws)');
  eq(usageFromFeedEvent({ type: 'system', subtype: 'init' }).input, 0, 'system init → all-zero');
}

console.log('\n── B. the warning text — names the count, says to land, blames the ceiling ──');
{
  const msg = turnBudgetWarningMessage(12_400_000);
  ok(msg.includes('12M') || msg.includes('12.4M'), `text names the token count (~12M) — got: ${msg.slice(0, 80)}`);
  ok(msg.toLowerCase().includes('land'), 'text tells the zee to land');
  ok(/ceilings?/i.test(msg), 'text blames the ceiling, not a person');
  ok(/not a person/i.test(msg), 'text says it is not a person');
  ok(/do not begin anything new/i.test(msg), 'text says not to start anything new');
}

console.log('\n── C–F. the round-trip (synthetic stream → warning → row + delivery verdict, and the under-threshold turn) ──');
let projectId = null, xourceId = null, xellId = null, zeeId = null;
let projectId2 = null, xourceId2 = null, xellId2 = null, zeeId2 = null;
try {
  resetTurnBudgetWarningStats();

  const mkBase = async (tag) => {
    const name = `${tag}-` + randomUUID().slice(0, 8);
    const proj = await one(
      `INSERT INTO project (name, repo_root) VALUES ($1, $2) RETURNING id`,
      [name, `/tmp/${name}`]);
    const xo = await one(
      `INSERT INTO xource (project_id, ref) VALUES ($1, 'refs/heads/main') RETURNING id`,
      [proj.id]);
    const xl = await one(
      `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status)
       VALUES ($1, $2, $3, $4, $5, 'claimed') RETURNING id`,
      [proj.id, xo.id, name, `spinoff/${name}`, `/tmp/${name}-wt`]);
    const z = await one(
      `INSERT INTO zee (xell_id, attach_mode, viewer_kind, status, kind, entrypoint, model)
       VALUES ($1, 'headless-spawn', 'none', 'working', 'headless', 'cxell-cli', 'opus') RETURNING id`,
      [xl.id]);
    const turn = await startTurn({
      zee: { id: z.id, xell_id: xl.id },
      xell: { id: xl.id, project_id: proj.id },
      kind: 'spawn', model: 'opus',
    });
    return { proj, xo, xl, z, turn };
  };

  // ── C. THE WARNING TURN: drive a synthetic stream past the threshold ─────────────────────────
  console.log('\n  C. past the threshold → exactly one warning EMITTED, row records it with the delivery verdict, turn NOT ended');
  const a = await mkBase('budget');
  projectId = a.proj.id; xourceId = a.xo.id; xellId = a.xl.id; zeeId = a.z.id;
  const turn = a.turn;
  ok(!!turn?.id, 'startTurn returns a turn to drive');
  eq(turn?.status, 'started', 'the turn starts as started');

  // Build a stream that sums past TURN_BUDGET_WARNING_TOKENS. Each "request" is a message_start
  // (input) + message_delta (output); per-request totals are ADDED (a turn's token bill is the sum
  // of every request it sends, not the last context size).
  const startReq = (input, cacheWrite = 0) => ({ type: 'stream_event', event: {
    type: 'message_start', message: { usage: { input_tokens: input, cache_creation_input_tokens: cacheWrite } } } });
  const deltaReq = (output, cacheRead = 0) => ({ type: 'stream_event', event: {
    type: 'message_delta', usage: { output_tokens: output, cache_read_input_tokens: cacheRead } } });

  const reqs = [
    [8_000_000, 1_000_000],   //  9M after req 1
    [5_000_000, 1_500_000],   // 15.5M after req 2 — CROSSES the 12M threshold
    [4_000_000, 2_000_000],   // 21.5M after req 3 — well past; must NOT re-fire
  ];
  for (const [inp, out] of reqs) {
    const r1 = await recordFeedEvent({ turnId: turn.id, zeeId, xellId, event: startReq(inp) });
    const r2 = await recordFeedEvent({ turnId: turn.id, zeeId, xellId, event: deltaReq(out) });
    ok(!!r1?.id && !!r2?.id, 'each stream_event is persisted to the play-by-play log');
  }

  const fired = turnBudgetWarningStats().fired;
  eq(fired, 1, 'exactly ONE turn-budget warning fired for the turn');

  // The turn row recorded it — durably, in meta, with the token count at warning time AND the
  // delivery verdict. The verdict is asserted because this test certifies that the warning was
  // EMITTED and RECORDED, never that a live zee was reached.
  const row = await one(`SELECT status, ended_at, meta FROM zee_turn WHERE id=$1`, [turn.id]);
  ok(!!row?.meta?.turn_budget_warning, 'the turn row records meta.turn_budget_warning');
  eq(row.meta.turn_budget_warning.fired, true, 'meta.turn_budget_warning.fired === true');
  ok(Number(row.meta.turn_budget_warning.tokens) >= TURN_BUDGET_WARNING_TOKENS,
     `meta records the token count at warning time (${row.meta.turn_budget_warning.tokens} >= ${TURN_BUDGET_WARNING_TOKENS})`);
  // In THIS harness the zee has viewer_kind='none' (no live cxell), so the honest verdict is 'none':
  // the warning was emitted and recorded but could not be typed anywhere. The point is that the
  // record CARRIES the verdict — production mid-turn routing is proven in section F.
  eq(row.meta.turn_budget_warning.delivery, 'none',
     'delivery verdict recorded (honestly \'none\' in this harness — no live cxell)');
  eq(row.meta.turn_budget_warning.delivery_sent, false, 'delivery_sent === false in this harness');
  ok(!!row.meta.turn_budget_warning.delivery_reason,
     `the refusal reason is recorded with the verdict (${row.meta.turn_budget_warning.delivery_reason})`);
  eq(row.status, 'started', 'the turn is STILL STARTED — our code did NOT end it');
  eq(row.ended_at, null, 'ended_at is untouched — the turn is not over');
  ok(turnBudgetRunningTotal(turn.id) >= 21_000_000, 'the running total kept counting past the threshold');

  // ── D. EXACTLY-ONCE: even more tokens after the warning must not re-fire ──────────────────────
  console.log('\n  D. more tokens after the warning → still exactly one');
  const before = turnBudgetWarningStats().fired;
  await recordFeedEvent({ turnId: turn.id, zeeId, xellId, event: startReq(3_000_000) });
  await recordFeedEvent({ turnId: turn.id, zeeId, xellId, event: deltaReq(3_000_000) });
  eq(turnBudgetWarningStats().fired, before, 'a second crossing does NOT re-fire the warning');
  const row2 = await one(`SELECT meta FROM zee_turn WHERE id=$1`, [turn.id]);
  ok(!!row2?.meta?.turn_budget_warning, 'the meta record is still the ONE record');

  // ── E. THE UNDER-THRESHOLD TURN: untouched ───────────────────────────────────────────────────
  console.log('\n  E. under the threshold → untouched (no warning, no meta, still started)');
  const b = await mkBase('budget-lite');
  projectId2 = b.proj.id; xourceId2 = b.xo.id; xellId2 = b.xl.id; zeeId2 = b.z.id;
  const lite = b.turn;
  for (const [inp, out] of [[2_000_000, 500_000], [1_000_000, 250_000]]) {
    await recordFeedEvent({ turnId: lite.id, zeeId: zeeId2, xellId: xellId2, event: startReq(inp) });
    await recordFeedEvent({ turnId: lite.id, zeeId: zeeId2, xellId: xellId2, event: deltaReq(out) });
  }
  ok(turnBudgetRunningTotal(lite.id) < TURN_BUDGET_WARNING_TOKENS, 'the light turn stays under the threshold');
  const liteRow = await one(`SELECT status, ended_at, meta FROM zee_turn WHERE id=$1`, [lite.id]);
  eq(liteRow.status, 'started', 'the light turn is still started');
  eq(liteRow.ended_at, null, 'the light turn has no end stamp');
  eq(liteRow.meta?.turn_budget_warning || null, null, 'the light turn has NO turn_budget_warning in meta');
  eq(turnBudgetWarningStats().fired, 1, 'the light turn did NOT fire another warning');

  // ── F. THE MID-TURN ROUTING VERDICT — why the recorded delivery matters ───────────────────────
  console.log('\n  F. mid-turn routing → QUEUED (zee-turn.js:77) — why the recorded verdict matters');
  // The manager's finding: a WORKING zee in a live cxell is routed to 'queued', and the queue drains
  // only when the turn ends — so a turn that DIES at the ceiling cannot be warned in time. Proven
  // directly here so the delivery shape is never silently assumed to be synchronous (which would
  // make this whole test certify something the system does not do).
  const midTurn = decideMessageDelivery({
    present: true, status: 'working', viewerKind: 'ssh-terminal',
    decommissioned: false, xellStatus: 'claimed', runtimeResumable: true, sessionResumable: true,
  });
  eq(midTurn.delivery, 'queued', 'a MID-TURN (working) zee in a live cxell → QUEUED (zee-turn.js:77)');
  ok(/turn ends/.test(midTurn.reason),
     `the queued reason says the message waits until the turn ENDS (got: ${midTurn.reason})`);
  // A resumed-turn (idle) zee — what the warning ACTUALLY reaches after a turn death — is RESUMED.
  const idle = decideMessageDelivery({
    present: true, status: 'idle', viewerKind: 'ssh-terminal',
    decommissioned: false, xellStatus: 'claimed', runtimeResumable: true, sessionResumable: true,
  });
  eq(idle.delivery, 'resumed', 'after the turn ends (idle) the message RESUMES the zee — recovery, not prevention');

  // A warning-firing turn can still end normally via endTurn (our code never blocks the end).
  const ended = await endTurn(turn.id, { status: 'ended', stopReason: 'end_turn' });
  eq(ended?.status, 'ended', 'a warned turn still ends normally through endTurn');

  console.log(`\n${fail ? fail + ' FAILED' : 'all good'}`);
} finally {
  for (const [pid, xid, xlid, zid] of [
    [projectId, xourceId, xellId, zeeId],
    [projectId2, xourceId2, xellId2, zeeId2],
  ]) {
    if (zid) await q(`DELETE FROM zee WHERE id=$1`, [zid]).catch(() => {});
    if (xlid) await q(`DELETE FROM xell WHERE id=$1`, [xlid]).catch(() => {});
    if (xid) await q(`DELETE FROM xource WHERE id=$1`, [xid]).catch(() => {});
    if (pid) await q(`DELETE FROM project WHERE id=$1`, [pid]).catch(() => {});
  }
  await pool.end();
}
process.exit(fail ? 1 : 0);
