// PLAY-BY-PLAY FEED PERSISTENCE — the writer that makes the Turns tab's expandable event log real.
//
// Background (prod 2026-08-08): session_event held 1,815 rows, actively written, and turn_id was
// NULL on every one of them. The 'cxell-feed' source migration 153 + intake.js describe never
// appeared. Root cause: the hot-path INSERT used
//   VALUES ('cxell-feed', $2, $3, $4, $5, $6, $7, $8)
// with an 8-element params array — $1 was never referenced, Postgres rejected every insert with
// "could not determine data type of parameter $1", and `.catch(() => {})` swallowed it forever.
//
// What this file covers:
//   A. The broken SQL shape still fails (the bug is pinned so a "clever" rewrite cannot revive it).
//   B. recordFeedEvent drives a fake feed through the real path and rows land WITH turn_id.
//   C. Failures are LOUD — a counter increments and the function never throws (feed stays live).
//   D. system/init events are skipped; no turn_id → no write.
//
// Against DATABASE_URL with a throwaway project/xell/zee/turn, torn down in `finally`.
import { randomUUID } from 'node:crypto';
import { q, one, pool } from '../server/src/db/pool.js';
import {
  startTurn, eventsForTurn, recordFeedEvent, feedWriteStats, resetFeedWriteStats,
} from '../server/src/lib/turn-ledger.js';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };
const eq = (a, b, m) => ok(a === b, `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

console.log('\n── A. the broken $2..$8 shape still fails (the bug that emptied the fleet) ──');
{
  // No row setup needed — Postgres rejects this at parse/bind time regardless of FK targets.
  let threw = null;
  try {
    await q(
      `INSERT INTO session_event (source, hook_event_name, zee_id, xell_id, turn_id, agent_id, tool_name, raw)
       VALUES ('cxell-feed', $2, $3, $4, $5, $6, $7, $8)`,
      ['cxell-feed', 'assistant', randomUUID(), randomUUID(), randomUUID(),
       'sess', null, JSON.stringify({ type: 'assistant' })]);
  } catch (e) {
    threw = e;
  }
  ok(!!threw, 'the $2..$8 shape throws (does not silently succeed)');
  ok(/could not determine data type of parameter \$1/i.test(String(threw?.message || '')),
     `error names the untyped $1 (got: ${String(threw?.message || '').slice(0, 120)})`);
}

console.log('\n── B–D. recordFeedEvent round-trip (fake feed → rows WITH turn_id) ──');
let projectId = null, xourceId = null, xellId = null, zeeId = null;
try {
  resetFeedWriteStats();
  const name = 'play-by-play-' + randomUUID().slice(0, 8);
  const proj = await one(
    `INSERT INTO project (name, repo_root) VALUES ($1, $2) RETURNING id`,
    [name, `/tmp/${name}`]);
  projectId = proj.id;
  const xo = await one(
    `INSERT INTO xource (project_id, ref) VALUES ($1, 'refs/heads/main') RETURNING id`,
    [projectId]);
  xourceId = xo.id;
  const xl = await one(
    `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status)
     VALUES ($1, $2, $3, $4, $5, 'claimed') RETURNING id`,
    [projectId, xourceId, name, `spinoff/${name}`, `/tmp/${name}-wt`]);
  xellId = xl.id;
  const z = await one(
    `INSERT INTO zee (xell_id, attach_mode, viewer_kind, status, kind, entrypoint, model)
     VALUES ($1, 'headless-spawn', 'none', 'working', 'headless', 'cxell-cli', 'opus') RETURNING id`,
    [xellId]);
  zeeId = z.id;

  const turn = await startTurn({
    zee: { id: zeeId, xell_id: xellId },
    xell: { id: xellId, project_id: projectId },
    kind: 'spawn', model: 'opus',
  });
  ok(!!turn?.id, 'startTurn returns a turn to attribute events to');

  // Drive a fake feed through the same path intake.js's feed() now calls.
  const assistant = {
    type: 'assistant',
    session_id: 'sess-fake-1',
    message: { content: [{ type: 'text', text: 'I will inspect the feed writer.' }] },
  };
  const toolUse = {
    type: 'assistant',
    session_id: 'sess-fake-1',
    message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] },
  };
  const toolResult = {
    type: 'user',
    session_id: 'sess-fake-1',
    message: { content: [{ type: 'tool_result', content: 'ok' }] },
  };
  const result = {
    type: 'result',
    session_id: 'sess-fake-1',
    result: 'done',
    total_cost_usd: 0.01,
  };
  const systemInit = {
    type: 'system', subtype: 'init', session_id: 'sess-fake-1',
  };

  const r1 = await recordFeedEvent({
    turnId: turn.id, zeeId, xellId, event: assistant, sessionId: 'sess-fallback',
  });
  const r2 = await recordFeedEvent({
    turnId: turn.id, zeeId, xellId, event: toolUse,
  });
  const r3 = await recordFeedEvent({
    turnId: turn.id, zeeId, xellId, event: toolResult,
  });
  const r4 = await recordFeedEvent({
    turnId: turn.id, zeeId, xellId, event: result,
  });
  const rSys = await recordFeedEvent({
    turnId: turn.id, zeeId, xellId, event: systemInit,
  });
  const rNoTurn = await recordFeedEvent({
    turnId: null, zeeId, xellId, event: assistant,
  });

  ok(!!r1?.id, 'assistant text event is persisted');
  eq(r1?.turn_id, turn.id, 'assistant event carries turn_id');
  eq(r1?.source, 'cxell-feed', 'source is cxell-feed');
  eq(r1?.hook_event_name, 'assistant', 'hook_event_name is the feed type');
  ok(!!r2?.id && r2.turn_id === turn.id, 'tool_use event lands with turn_id');
  eq(r2?.tool_name, 'Bash', 'tool_use name is extracted onto tool_name');
  ok(!!r3?.id && r3.turn_id === turn.id, 'tool_result (user) event lands with turn_id');
  ok(!!r4?.id && r4.turn_id === turn.id, 'result event lands with turn_id');
  eq(rSys, null, 'system/init events are skipped (no row)');
  eq(rNoTurn, null, 'no turn_id → no write');

  // The read model the console uses
  const evs = await eventsForTurn(turn.id);
  eq(evs.length, 4, 'eventsForTurn returns the four non-system feed events');
  ok(evs.every((e) => e.turn_id === turn.id), 'every returned event carries the turn_id');
  ok(evs.every((e) => e.source === 'cxell-feed'), 'every returned event is source=cxell-feed');
  eq(evs.map((e) => e.hook_event_name).join(','), 'assistant,assistant,user,result',
     'events arrive oldest-first in feed order');

  const stats = feedWriteStats();
  eq(stats.ok, 4, 'feedWriteStats.ok counts the four successful writes');
  eq(stats.failed, 0, 'feedWriteStats.failed is 0 on the happy path');

  // C. A failure is LOUD — force one by pointing at a non-existent turn (FK violation),
  // and assert the counter moves without a throw.
  const beforeFail = feedWriteStats().failed;
  const forced = await recordFeedEvent({
    turnId: randomUUID(), // no zee_turn row → FK violation on turn_id
    zeeId, xellId,
    event: { type: 'assistant', message: { content: [{ type: 'text', text: 'orphan' }] } },
  });
  eq(forced, null, 'FK failure returns null (never throws)');
  eq(feedWriteStats().failed, beforeFail + 1, 'feedWriteStats.failed increments on a write miss');
  eq(feedWriteStats().ok, 4, 'a failure does not inflate the ok counter');

  console.log(`\n${fail ? fail + ' FAILED' : 'all good'}`);
} finally {
  if (zeeId) await q(`DELETE FROM zee WHERE id=$1`, [zeeId]).catch(() => {});
  if (xellId) await q(`DELETE FROM xell WHERE id=$1`, [xellId]).catch(() => {});
  if (xourceId) await q(`DELETE FROM xource WHERE id=$1`, [xourceId]).catch(() => {});
  if (projectId) await q(`DELETE FROM project WHERE id=$1`, [projectId]).catch(() => {});
  await pool.end();
}
process.exit(fail ? 1 : 0);
