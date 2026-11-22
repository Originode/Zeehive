// DEV-MACHINE BUILD-READINESS SKIP — the dispatch path must not spawn onto a (machine, project)
// pair the fleet has already RECORDED as unable to host this project's build.
//
// The pool has honoured that record from the start (queenzee/pool.js fillStopReasonFor stops
// filling a pair whose build_readiness_record.status is 'missing'). The DISPATCH path did not:
// pickDevMachine walked devMachines by priority and returned the first with room under max_xells,
// consulting no record at all. Measured 2026-09-24: ugreen-nas read 'missing' for this project
// (daemon 10.1.0.18:2375 i/o timeout, shared dev dbs refused TCP) and was still picked — a worker
// was handed its dead db and another's `zee build` died on the daemon the fleet already knew was
// down. One fact, two readers, one of them blind.
//
// This drives the REAL lib/machines.js + the REAL record writer (lib/build-readiness.js
// upsertBuildReadinessRecord) against a real postgres (DATABASE_URL); only the fixtures are the
// test's. It pins, in order:
//   • the bug's shape: with NO record, the highest-priority machine is picked (so the skip below
//     is what changes the answer, not a fixture accident);
//   • a pair recorded 'missing' is SKIPPED while a healthy lower-priority pair exists;
//   • the skip is PER PAIR — the same machine still serves a project with no 'missing' record;
//   • the TAXONOMY: 'unknown' (nothing answered within the bound) and "no record yet" are NOT
//     skips; refusing dispatch on a merely-slow machine would be a new fault of the gate's own;
//   • the all-missing case is an HONEST refusal — it names the recorded fault, and is not the
//     confusing "every dev machine is at its max_xells cap" error;
//   • the cap still refuses in its own words, and a mixed case names BOTH facts.
import { randomUUID } from 'node:crypto';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }

const { q, one, pool } = await import('../server/src/db/pool.js');
const { pickDevMachine, setMachinePriority, pairBuildReadinessStatus } =
  await import('../server/src/lib/machines.js');
const { upsertBuildReadinessRecord } = await import('../server/src/lib/build-readiness.js');

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };

// Unique, self-namespaced fixtures so the test is repeatable and never collides with real rows.
const tag = randomUUID().slice(0, 8);
const ctxA = `zt-drbr-${tag}-a`;        // docker contexts (UNIQUE on machine)
const ctxB = `zt-drbr-${tag}-b`;
const keyA = `zt-drbr-${tag}-a`;        // machine keys (UNIQUE, ^[a-z0-9][a-z0-9-]{0,40}$)
const keyB = `zt-drbr-${tag}-b`;
let mA, mB, projX, projY;

const mkProject = async (name) => (await one(
  `INSERT INTO project (name, repo_root) VALUES ($1,$2) RETURNING id`,
  [name, `/tmp/${name}`])).id;

const mkMachine = async (key, ctx, maxXells) => (await one(
  `INSERT INTO machine (key, docker_ctx, max_xells, enabled) VALUES ($1,$2,$3,true) RETURNING id`,
  [key, ctx, maxXells])).id;

// A live (non-retired, non-prod) dev xell with its own server container on `ctx` — exactly the
// shape liveXellCount counts toward the machine-wide max_xells cap.
const mkLiveXell = async (projectId, slug, ctx) => {
  const xourceId = (await one(
    `INSERT INTO xource (project_id, ref) VALUES ($1,'main')
     ON CONFLICT (project_id, ref) DO UPDATE SET ref=EXCLUDED.ref RETURNING id`, [projectId])).id;
  const xellId = (await one(
    `INSERT INTO xell (project_id, xource_id, slug, branch, status, is_production)
     VALUES ($1,$2,$3,$4,'working',false) RETURNING id`,
    [projectId, xourceId, slug, `spinoff/${slug}`])).id;
  await q(
    `INSERT INTO container (project_id, role, tier, isolation, name, docker_ctx, owner_xell_id)
     VALUES ($1,'server','spinoff','per-xell',$2,$3,$4)`,
    [projectId, `srv_${slug}`, ctx, xellId]);
  return xellId;
};

const setRecord = (machineId, projectId, status) =>
  upsertBuildReadinessRecord(machineId, projectId,
    { status, error: status === 'missing' ? 'context-reachable: dial tcp 10.1.0.18:2375: i/o timeout' : null, checks: [] });
const clearRecord = (machineId, projectId) =>
  q(`DELETE FROM build_readiness_record WHERE machine_id=$1 AND project_id=$2`, [machineId, projectId]);

// The picker, as the caller sees it: the machine key it returns, or the refusal text it throws.
const pick = async (projectId) => {
  try { return { key: (await pickDevMachine(projectId))?.key || null }; }
  catch (e) { return { refused: e.message }; }
};

try {
  mA = await mkMachine(keyA, ctxA, 3);      // the high-priority machine — the one that gets picked
  mB = await mkMachine(keyB, ctxB, 3);
  projX = await mkProject(`zt-drbr-X-${tag}`);
  projY = await mkProject(`zt-drbr-Y-${tag}`);
  await setMachinePriority(mA, projX, 9);
  await setMachinePriority(mB, projX, 1);
  await setMachinePriority(mA, projY, 5);   // project Y's OTHER machine — only A, for the pair test

  console.log('\n── the bug\'s shape: with no record, priority decides (this is what shipped before) ──');
  ok((await pick(projX)).key === keyA,
     'no build_readiness_record at all ⇒ the highest-priority machine is picked (unchanged legacy path)');

  console.log('\n── a pair recorded \'missing\' is SKIPPED while a healthy pair exists ──');
  await setRecord(mA, projX, 'missing');
  ok(await pairBuildReadinessStatus(mA, projX) === 'missing', 'the record reads back as the picker reads it');
  ok((await pick(projX)).key === keyB,
     "'missing' high-priority pair is skipped — the healthy lower-priority machine gets the spawn");

  console.log('\n── the taxonomy: only a definite \'missing\' skips ──');
  await setRecord(mA, projX, 'unknown');
  ok((await pick(projX)).key === keyA,
     "'unknown' (nothing answered within the bound) is NOT a skip — a merely-slow machine still takes work");
  await setRecord(mA, projX, 'ok');
  ok((await pick(projX)).key === keyA, "'ok' is not a skip — the record is read, and a green pair is preferred");
  await clearRecord(mA, projX);
  ok((await pick(projX)).key === keyA, 'no record yet (never probed) is NOT a skip — a fresh install still provisions');
  ok(await pairBuildReadinessStatus(mA, projX) === null, 'pairBuildReadinessStatus answers null for an unprobed pair');

  console.log('\n── the skip is PER PAIR (machine × project), not per machine ──');
  await setRecord(mA, projX, 'missing');
  ok((await pick(projY)).key === keyA,
     "the SAME machine still serves project Y, which has no 'missing' record — the gate is the pair");
  await setRecord(mA, projY, 'missing');
  ok(!!(await pick(projY)).refused, "…and project Y is refused once ITS OWN pair is recorded 'missing'");
  await clearRecord(mA, projY);

  console.log('\n── all candidates missing: an HONEST refusal, not a cap error ──');
  await setRecord(mB, projX, 'missing');
  const allMissing = (await pick(projX)).refused || '';
  ok(!!allMissing, 'no machine can host the project right now ⇒ the picker refuses');
  ok(allMissing.includes('no dev machine can host this project right now'),
     '…and says so in its opening words');
  ok(allMissing.includes("build_readiness_record is 'missing'"),
     '…naming the recorded fault as the reason');
  ok(allMissing.includes(keyA) && allMissing.includes(keyB),
     '…naming EVERY pair it refused (both machines)');
  ok(!allMissing.includes('max_xells cap'),
     '…and does NOT dress it up as the max_xells cap error — the human fix is different');

  console.log('\n── a mixed refusal names BOTH facts, and the cap still refuses in its own words ──');
  // A is recorded 'missing', B is healthy but FULL — no candidate can take the spawn, for two
  // DIFFERENT reasons, and the refusal must not collapse them into one.
  await clearRecord(mB, projX);
  await setRecord(mA, projX, 'missing');
  await q(`UPDATE machine SET max_xells=1 WHERE id=$1`, [mB]);
  await mkLiveXell(projX, `zt-drbr-x-${tag}`, ctxB);
  const mixed = (await pick(projX)).refused || '';
  ok(mixed.includes("build_readiness_record is 'missing'") && mixed.includes(`max_xells cap (${keyB})`),
     'one machine recorded \'missing\', the other at its cap ⇒ both reasons appear in the refusal');
  // Both full and healthy: the cap clause keeps the sentence it has always had, alone.
  await clearRecord(mA, projX);
  await q(`UPDATE machine SET max_xells=1 WHERE id=$1`, [mA]);
  await mkLiveXell(projX, `zt-drbr-y-${tag}`, ctxA);
  const capOnly = (await pick(projX)).refused || '';
  ok(capOnly.includes(`every dev machine is at its max_xells cap (${keyA}, ${keyB})`)
     && capOnly.includes('raise a cap or mark xells done'),
     'cap-only keeps its long-standing sentence — the recorded-missing clause is not invented when empty');
  ok(!capOnly.includes('build_readiness_record'), '…and the record clause does not appear');
} finally {
  // Tear down every seeded row (children first; machine_pool cascades with the machine).
  for (const p of [projX, projY]) if (p) {
    await q(`DELETE FROM build_readiness_record WHERE project_id=$1`, [p]).catch(() => {});
    await q(`DELETE FROM container WHERE project_id=$1`, [p]).catch(() => {});
    await q(`DELETE FROM xell WHERE project_id=$1`, [p]).catch(() => {});
    await q(`DELETE FROM xource WHERE project_id=$1`, [p]).catch(() => {});
  }
  for (const m of [mA, mB]) if (m) await q(`DELETE FROM machine WHERE id=$1`, [m]).catch(() => {});
  for (const p of [projX, projY]) if (p) await q(`DELETE FROM project WHERE id=$1`, [p]).catch(() => {});
  await pool.end().catch(() => {});
}

console.log(`\n${failures === 0 ? 'ALL PASSED ✓' : `${failures} FAILURE(S) ✗`}`);
process.exit(failures === 0 ? 0 : 1);
