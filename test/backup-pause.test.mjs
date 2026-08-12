// PAUSING PROD BACKUPS — the stop-switch for a retry storm.
//
// WHY IT EXISTS. A failed backup now schedules a RETRY (10 min, doubling, capped at the policy
// interval — #26) instead of consuming its window, and with the execPipe fix each attempt fails
// FAST instead of hanging for 30 minutes. So a destination that is genuinely broken — a dead NAS
// context, an unmountable volume — turns the retry loop into a storm: the same failing dump re-runs
// every ten minutes forever. A human needs a PAUSE that stops NEW backups (scheduled AND manual)
// until the destination is fixed, without touching the backups that already exist.
//
// THE CONTRACT, asserted here:
//   1. When backup_paused is set, backupDue is NOT due — on ANY schedule. A paused project must not
//      schedule a policy backup OR a retry, or the storm just waits for the pause to lift and re-fires.
//   2. backupProd REFUSES while paused, even when a human clicks "Back up now" — a manual override
//      would defeat the whole point of the stop-switch.
//   3. setBackupPaused flips it back, and the schedule is due again.
//   4. The pause does NOT suppress the stale-restore-point alert: the restore point is stale
//      PRECISELY because no backups are running, and the operator who paused deserves the alert.
//      (Asserted via checkBackupFreshness against a genuinely stale restore point.)
//
// Runs the REAL lib against this xell's isolated postgres in simulate mode (no docker daemon): every
// check here is a DECISION backupDue / backupProd / checkBackupFreshness make BEFORE any async work.
process.env.MAINTENANCE_MODE = 'simulate';   // gate decisions are synchronous; no daemon touched
process.env.TKB_NOTIFY = '0';                // and never ping a real device (the stale alert fires here)

const { q, one, pool } = await import('../server/src/db/pool.js');
const m = await import('../server/src/queenzee/maintenance.js');

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };
const threw = async (fn, re, msg) => {
  try { await fn(); ok(false, `${msg} (did NOT throw)`); }
  catch (e) { ok(re.test(e.message), `${msg} — threw: ${e.message.slice(0, 120)}`); }
};

let projId;
try {
  projId = (await one(
    `INSERT INTO project (name, repo_root, main_branch, db_name, db_user)
       VALUES ($1,$2,'main','zt','zt') RETURNING id`,
    [`zt-pause-${Date.now()}`, `/tmp/zt-pause-${Date.now()}`])).id;
  await q(`INSERT INTO pool_config (project_id, backup_interval_sec) VALUES ($1, 3600)`, [projId]);

  console.log('\n── normal state: the schedule is due (first ever backup) ──');
  let d = await m.backupDue(projId);
  ok(d.due === true && d.kind === 'first', `backupDue is due on a fresh project (kind=${d.kind})`);

  console.log('\n── 1. PAUSED ⇒ never due, on ANY schedule ──');
  await m.setBackupPaused({ project: projId, paused: true });
  d = await m.backupDue(projId);
  ok(d.due === false && d.kind === 'paused', `paused ⇒ backupDue NOT due, kind='paused' (got ${d.kind})`);
  ok(/PAUSED/i.test(d.reason), `the reason says why (${JSON.stringify(d.reason)})`);

  console.log('\n── a paused project is not due even after a FAILED attempt (the retry is suppressed) ──');
  await q(`INSERT INTO db_snapshot (project_id, source, dump_path, status, taken_at, error)
           VALUES ($1,'prod','/tmp/zt-pause-x.dump','failed', now(), 'boom')`, [projId]);
  d = await m.backupDue(projId);
  ok(d.due === false && d.kind === 'paused', `paused + last attempt FAILED ⇒ still NOT due (a retry would otherwise fire in 10 min)`);

  console.log('\n── 2. PAUSED ⇒ backupProd REFUSES, even a manual "Back up now" ──');
  await threw(() => m.backupProd(projId), /PAUSED/,
    'backupProd refuses while paused (the stop-switch blocks manual triggers too)');

  console.log('\n── 3. resume ⇒ the retry is scheduled again (not suppressed) ──');
  await m.setBackupPaused({ project: projId, paused: false });
  d = await m.backupDue(projId);
  ok(d.kind === 'retry' && d.due === false,
    `resumed ⇒ kind='retry', retry in ${Math.ceil((d.waitSec || 0) / 60)} min — the pause is what was suppressing it, not a consumed window`);

  console.log('\n── 4. pause does NOT mute the stale-restore-point alert ──');
  // A stale restore point: the last GOOD dump is older than TWO policy intervals (the alert threshold).
  await q(`INSERT INTO db_snapshot (project_id, source, dump_path, status, size_bytes, mode, taken_at)
           VALUES ($1,'prod','/tmp/zt-pause-old.dump','finished', 1000, 'real', now() - interval '3 hours')`, [projId]);
  await m.setBackupPaused({ project: projId, paused: true });
  const alerted = await m.checkBackupFreshness(projId);
  ok(alerted && alerted.fire === true, `paused but stale ⇒ the alert still fires (fire=${alerted?.fire})`);
  await q(`UPDATE pool_config SET backup_alerted_at=NULL, backup_alert_open=false WHERE project_id=$1`, [projId]);

  console.log('\n── setBackupPaused is validated ──');
  await threw(() => m.setBackupPaused({ project: projId, paused: 'yes' }), /boolean/,
    'a non-boolean paused is refused');

  await q(`DELETE FROM db_snapshot WHERE project_id=$1`, [projId]);
  await q(`DELETE FROM pool_config WHERE project_id=$1`, [projId]);
  await q(`DELETE FROM project WHERE id=$1`, [projId]);
} finally {
  if (projId) { await q(`DELETE FROM db_snapshot WHERE project_id=$1`, [projId]).catch(() => {}); }
  await pool.end().catch(() => {});
}
console.log(`\n${failures === 0 ? 'ALL PASSED ✓' : `${failures} FAILURE(S) ✗`}`);
process.exit(failures === 0 ? 0 : 1);
