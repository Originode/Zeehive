// MIGRATION 260 — session_event is indexed by xell. The /api/fleet read model (lib/fleet.js
// fetchXellRows) runs four correlated lookups per xell shaped
//   WHERE xell_id = ? AND hook_event_name IN (…) ORDER BY ts DESC LIMIT 1
// and until 260 the table had NO xell_id index at all: every fleet snapshot paid 4 × N-xells
// sequential scans of a ~135k-row table (the production 700%-CPU bottleneck, 2026-09-15).
// This pins, against `zee db-sandbox --migrate`:
//
//   • the index exists, on the exact columns/order the lookups need
//     (xell_id, hook_event_name, ts DESC), and it is a FULL index (no WHERE clause —
//     quarantine/spin-detector/fleet-pause read kinds outside the fleet's 8);
//   • the planner actually USES it for the fleet's lookup shape (no Seq Scan).
const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }

import { randomUUID } from 'node:crypto';
import { one, pool } from '../server/src/db/pool.js';

let failures = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) failures++; };

try {
  console.log('\n── the index exists, with the shape the fleet lookups need ──');
  const idx = await one(
    `SELECT indexdef FROM pg_indexes
      WHERE tablename = 'session_event' AND indexname = 'session_event_xell_kind_ts_idx'`);
  ok(!!idx, 'session_event_xell_kind_ts_idx exists');
  const def = idx?.indexdef || '';
  ok(/\(xell_id, hook_event_name, ts DESC\)/.test(def),
     `columns are (xell_id, hook_event_name, ts DESC) — got: ${def}`);
  ok(!/WHERE/i.test(def), 'FULL index (no partial WHERE — sibling readers use other kinds)');

  console.log('\n── the index SERVES the latest-event-wins lookup shape ──');
  // PRECONDITION, stated: the sandbox table is EMPTY, and on an empty table the planner rightly
  // prefers a seq scan — table size is not what this test asserts. enable_seqscan=off (on ONE
  // dedicated client, per-session) forces the planner to prove the index is USABLE for the fleet's
  // exact lookup shape: if the index could not serve it, the plan would still say Seq Scan (at a
  // disable-cost) rather than an index scan.
  const xellId = randomUUID();
  const client = await pool.connect();
  let planText = '';
  try {
    await client.query(`SET enable_seqscan = off`);
    const plan = await client.query(
      `EXPLAIN (FORMAT JSON)
       SELECT hook_event_name FROM session_event
        WHERE xell_id = $1 AND hook_event_name IN ('tend-request','tend-clear')
        ORDER BY ts DESC LIMIT 1`, [xellId]);
    planText = JSON.stringify(plan.rows);
  } finally {
    await client.query(`RESET enable_seqscan`).catch(() => {});
    client.release();
  }
  ok(/session_event_xell_kind_ts_idx/.test(planText), 'plan reads through the new index');
  ok(!/"Seq Scan"/.test(planText), 'no sequential scan of session_event');
} finally {
  await pool.end();
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL OK');
process.exit(failures ? 1 : 0);
