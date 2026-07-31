// BACKUP DELETE + RESTORE-TO-PROD GATE — the two behaviours this xell adds:
//   1. deleteBackup(id): removes ONE backup (file + row) on demand; refuses a still-RUNNING one.
//   2. restoreBackup over the PRODUCTION db is now ALLOWED but GATED — it needs an explicit
//      confirmProd flag (the console makes the human type the db name) AND prod must be free
//      (no ship deploying / no live zee bound to prod), the same window that blocks a backup.
// Runs the REAL lib against this xell's isolated postgres in simulate mode (no docker daemon):
// every check here is a DECISION restoreBackup/deleteBackup make BEFORE any async docker work.
process.env.MAINTENANCE_MODE = 'simulate';   // gate decisions are synchronous; no daemon touched

const { q, one, pool } = await import('../server/src/db/pool.js');
const m = await import('../server/src/queenzee/maintenance.js');

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };
const threw = async (fn, re, msg) => {
  try { await fn(); ok(false, `${msg} (did NOT throw)`); }
  catch (e) { ok(re.test(e.message), `${msg} — threw: ${e.message.slice(0, 120)}`); }
};

const mkSnap = (projId, status, extra = {}) => one(
  `INSERT INTO db_snapshot (project_id, source, dump_path, status, mode, size_bytes)
     VALUES ($1,'prod',$2,$3,$4,$5) RETURNING id`,
  [projId, extra.dump_path ?? `/tmp/zt-nope/${status}-${Math.random().toString(16).slice(2)}.dump`,
   status, extra.mode ?? 'real', extra.size_bytes ?? 1000]);

let projId;
try {
  projId = (await one(
    `INSERT INTO project (name, repo_root, main_branch, db_name, db_user)
       VALUES ($1,$2,'main','zt','zt') RETURNING id`,
    [`zt-bkdel-${Date.now()}`, '/tmp/zt-bkdel'])).id;
  await q(`INSERT INTO pool_config (project_id) VALUES ($1)`, [projId]);

  const prodDb = (await one(
    `INSERT INTO container (project_id, role, tier, isolation, name)
       VALUES ($1,'db','prod','shared',$2) RETURNING id`, [projId, `zt_db_prod_${Date.now()}`])).id;
  const devDb = (await one(
    `INSERT INTO container (project_id, role, tier, isolation, name)
       VALUES ($1,'db','dev','shared',$2) RETURNING id`, [projId, `zt_db_dev_${Date.now()}`])).id;

  // ── 1. deleteBackup ─────────────────────────────────────────────────────────
  console.log('\n── deleteBackup: on-demand, one row, running refused ──');
  const fin = await mkSnap(projId, 'finished');
  const del = await m.deleteBackup(fin.id);
  ok(del.ok && del.id === fin.id, 'a finished backup deletes → { ok, id }');
  ok((await q(`SELECT 1 FROM db_snapshot WHERE id=$1`, [fin.id])).length === 0, 'its row is gone');

  const failedSnap = await mkSnap(projId, 'failed');
  await m.deleteBackup(failedSnap.id);
  ok((await q(`SELECT 1 FROM db_snapshot WHERE id=$1`, [failedSnap.id])).length === 0,
    'a FAILED backup can also be deleted (cleans up its partial)');

  const running = await mkSnap(projId, 'running');
  await threw(() => m.deleteBackup(running.id), /still running/,
    'a RUNNING backup is REFUSED (delete is not cancel)');
  ok((await q(`SELECT 1 FROM db_snapshot WHERE id=$1`, [running.id])).length === 1,
    'the running row survives the refused delete');
  await threw(() => m.deleteBackup('00000000-0000-0000-0000-000000000000'), /not found/,
    'an unknown id → not found');

  // ── 2. restore-to-prod gate ──────────────────────────────────────────────────
  console.log('\n── restoreBackup over PRODUCTION is gated ──');
  const good = await mkSnap(projId, 'finished', { mode: 'real' });

  await threw(() => m.restoreBackup({ snapshot: good.id, container: prodDb }),
    /requires explicit human confirmation/,
    'prod target with NO confirmProd → REFUSED');

  // prod busy (a ship holds the deploy lock) → refused even WITH confirmProd
  await q(`INSERT INTO deploy_lock (project_id, container, phase) VALUES ($1,'prod','deploying')`, [projId]);
  await threw(() => m.restoreBackup({ snapshot: good.id, container: prodDb, confirmProd: true }),
    /refusing to restore over prod/,
    'prod target + confirmProd but prod is MID-SHIP → REFUSED (would clobber live work)');
  await q(`DELETE FROM deploy_lock WHERE project_id=$1`, [projId]);

  // a SIMULATED backup can never be restored, prod or not
  const sim = await mkSnap(projId, 'finished', { mode: 'simulate' });
  await threw(() => m.restoreBackup({ snapshot: sim.id, container: prodDb, confirmProd: true }),
    /SIMULATED backup/, 'a simulated placeholder → REFUSED even into prod with confirm');

  // confirmProd + prod free → ACCEPTED (kicks off the async job, flags prod busy)
  const started = await m.restoreBackup({ snapshot: good.id, container: prodDb, confirmProd: true });
  ok(started.status === 'started', 'prod target + confirmProd + prod free → restore STARTS');
  ok(!!(await one(`SELECT busy_op FROM container WHERE id=$1`, [prodDb]))?.busy_op,
    'the prod container is flagged busy while the restore runs');
  await q(`UPDATE container SET busy_since=NULL, busy_op=NULL WHERE id=$1`, [prodDb]);   // undo sim job

  // a NON-prod target needs no confirmProd (unchanged behaviour)
  const started2 = await m.restoreBackup({ snapshot: good.id, container: devDb });
  ok(started2.status === 'started', 'a dev target restores WITHOUT confirmProd (unchanged)');
  await q(`UPDATE container SET busy_since=NULL, busy_op=NULL WHERE id=$1`, [devDb]);
} finally {
  if (projId) {
    await q(`DELETE FROM deploy_lock WHERE project_id=$1`, [projId]);
    await q(`DELETE FROM db_snapshot WHERE project_id=$1`, [projId]);
    await q(`DELETE FROM container WHERE project_id=$1`, [projId]);
    await q(`DELETE FROM pool_config WHERE project_id=$1`, [projId]);
    await q(`DELETE FROM project WHERE id=$1`, [projId]);
  }
  await pool.end().catch(() => {});
}
console.log(`\n${failures === 0 ? 'ALL PASSED ✓' : `${failures} FAILURE(S) ✗`}`);
process.exit(failures === 0 ? 0 : 1);
