// CONCURRENT /api/fleet READS COALESCE (the meta-DB 700%-CPU fix, 2026-09-15). Production ran
// 6-7 concurrent copies of the SAME fetchXellRows statement because the console re-fetches the
// snapshot after every stream event (~108 /api/fleet per 10 min) while each read took ~30 s —
// the queue never drained. getFleet must share ONE in-flight promise per project id:
//
//   • two calls for the same project while one is running return the SAME promise (⇒ one query
//     run — also pinned by counting pool.query invocations);
//   • the entry clears when it settles: a call AFTER resolution computes fresh;
//   • different project ids never share a promise;
//   • a FAILED read is not cached: the next call after a rejection starts a new one.
//
// Drives the REAL getFleet against `zee db-sandbox --migrate`, fixture rows removed in finally.
const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }

import { randomUUID } from 'node:crypto';
import { q, one, pool } from '../server/src/db/pool.js';
import { getFleet } from '../server/src/lib/fleet.js';

let failures = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) failures++; };

const tag = randomUUID().slice(0, 8);
let projId = null, otherId = null;
const clean = [];

try {
  projId = (await one(`INSERT INTO project (name, repo_root) VALUES ($1,$2) RETURNING id`,
    [`zt-fleetcoal-${tag}`, `/tmp/zt-fleetcoal-${tag}`])).id;
  clean.push(() => q(`DELETE FROM project WHERE id=$1`, [projId]));
  otherId = (await one(`INSERT INTO project (name, repo_root) VALUES ($1,$2) RETURNING id`,
    [`zt-fleetcoal-other-${tag}`, `/tmp/zt-fleetcoal-other-${tag}`])).id;
  clean.push(() => q(`DELETE FROM project WHERE id=$1`, [otherId]));

  console.log('\n── one in-flight promise per project id ──');
  // Count every query the pool runs (q/one both route through pool.query; fetchXellRows uses its
  // own client, which only makes the count UNDER-approximate — fine for an equality assertion).
  const origQuery = pool.query;
  let queries = 0;
  pool.query = function counted(...args) { queries += 1; return origQuery.apply(this, args); };
  try {
    queries = 0;
    const alone = await getFleet(projId);
    const oneCallQueries = queries;
    ok(alone?.project?.id === projId, 'getFleet resolves the fixture project');
    ok(oneCallQueries > 0, `a single call runs queries (${oneCallQueries})`);

    queries = 0;
    const p1 = getFleet(projId);
    const p2 = getFleet(projId);
    ok(p1 === p2, 'a second call while one is in flight returns the SAME promise');
    const [f1, f2] = await Promise.all([p1, p2]);
    ok(queries === oneCallQueries,
       `two concurrent calls ran exactly one query set (${queries} = ${oneCallQueries})`);
    ok(f1 === f2 && f1?.project?.id === projId, 'both callers get the same snapshot');

    const p3 = getFleet(projId);
    ok(p3 !== p1, 'a call AFTER the in-flight one settled computes fresh (entry cleared)');
    await p3;

    console.log('\n── scoping and failure ──');
    const pa = getFleet(projId);
    const pb = getFleet(otherId);
    ok(pa !== pb, 'different project ids never share a promise');
    await Promise.all([pa, pb]);

    // A non-uuid id makes the project read throw — the rejection must not be cached.
    const bad1 = getFleet('not-a-uuid');
    const bad2 = getFleet('not-a-uuid');
    ok(bad1 === bad2, 'concurrent failing calls still coalesce');
    let rejected = false;
    await bad1.catch(() => { rejected = true; });
    await bad2.catch(() => {});
    ok(rejected, 'the failing read rejects (not cached as a value)');
    const bad3 = getFleet('not-a-uuid');
    ok(bad3 !== bad1, 'a rejection clears the entry — the next call starts a NEW read');
    await bad3.catch(() => {});
  } finally {
    pool.query = origQuery;
  }
} finally {
  for (const fn of clean.reverse()) await fn().catch(() => {});
  await pool.end();
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL OK');
process.exit(failures ? 1 : 0);
