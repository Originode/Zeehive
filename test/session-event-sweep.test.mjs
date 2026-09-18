// SESSION_EVENT RETENTION (the /api/fleet bottleneck fix, part 5). Nothing ever pruned
// session_event, so the cxell-feed mirror kinds grew without bound (135k rows / 144 MB on prod,
// ~94% of them assistant/user/tool_progress/result). sweepSessionEvents must:
//
//   • delete ONLY the four mirror kinds, and only rows older than the retention window;
//   • NEVER touch a gate/state kind (tend-*, hints, env-alert*, …) — those are replayed
//     latest-event-wins with no time bound, whatever their age;
//   • in simulate mode report and delete NOTHING (mode-gated like every maintenance write);
//   • treat a 0/negative retention as OFF.
//
// Runs against `zee db-sandbox --migrate`; fixture rows removed in finally.
const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }

import { q, one, pool } from '../server/src/db/pool.js';
import { sweepSessionEvents, SESSION_EVENT_SWEEP_KINDS } from '../server/src/queenzee/maintenance.js';

let failures = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) failures++; };
const TAG = 'zt-sweep-fixture';
const count = async (kind) => (await one(
  `SELECT count(*)::int AS n FROM session_event WHERE source=$1 AND hook_event_name=$2`, [TAG, kind])).n;

try {
  // old (40d) + fresh mirror rows, and an old gate row that must survive any sweep
  for (const kind of SESSION_EVENT_SWEEP_KINDS) {
    await q(`INSERT INTO session_event (source, hook_event_name, ts, raw)
             VALUES ($1,$2, now() - interval '40 days', '{}'), ($1,$2, now(), '{}')`, [TAG, kind]);
  }
  await q(`INSERT INTO session_event (source, hook_event_name, ts, raw)
           VALUES ($1,'tend-request', now() - interval '400 days', '{"reason":"keep me"}')`, [TAG]);

  console.log('\n── simulate mode deletes nothing ──');
  const sim = await sweepSessionEvents({ olderThanDays: 30, mode: 'simulate' });
  ok(sim === 0, 'returns 0');
  ok(await count('assistant') === 2, 'old mirror rows still present after a simulate sweep');

  console.log('\n── real mode prunes old mirror rows only ──');
  const n = await sweepSessionEvents({ olderThanDays: 30, mode: 'real' });
  ok(n === SESSION_EVENT_SWEEP_KINDS.length, `deleted exactly the ${SESSION_EVENT_SWEEP_KINDS.length} old mirror rows (got ${n})`);
  for (const kind of SESSION_EVENT_SWEEP_KINDS) {
    ok(await count(kind) === 1, `${kind}: fresh row kept, 40d row gone`);
  }
  ok(await count('tend-request') === 1, 'a 400-day-old GATE row (tend-request) is never swept');

  console.log('\n── retention 0/negative = off ──');
  ok(await sweepSessionEvents({ olderThanDays: 0, mode: 'real' }) === 0, '0 days sweeps nothing');
  ok(await sweepSessionEvents({ olderThanDays: -5, mode: 'real' }) === 0, 'negative sweeps nothing');
  ok(await count('assistant') === 1, 'rows untouched by the off sweeps');
} finally {
  await q(`DELETE FROM session_event WHERE source=$1`, [TAG]).catch(() => {});
  await pool.end();
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL OK');
process.exit(failures ? 1 : 0);
