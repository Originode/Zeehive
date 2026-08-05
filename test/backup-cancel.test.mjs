// CANCELLING AN IN-FLIGHT BACKUP — this xell adds "cancel" as a real verb next to "delete".
//
// deleteBackup already refused a running backup on purpose ("delete is not cancel"): a mid-write
// dump must not be deleted out from under the job that owns it. This xell makes the OTHER half of
// that sentence real — a human can stop a running backup cleanly:
//   • cancelBackup(id) aborts the in-flight job (kills pg_dump / docker cp, removes any partial,
//     un-busies prod) and finalises the row 'cancelled', NOT 'failed';
//   • a cancelled row is a final state a human can then delete, and one that can never be restored;
//   • the retry scheduler treats 'cancelled' like 'failed' — a stopped dump produced no restore
//     point, so the next attempt must NOT wait out a whole policy interval just because someone
//     stopped one (the exact harm #26 fixed for failures).
//
// Runs the REAL lib against this xell's isolated postgres in simulate mode (no docker daemon). The
// in-flight abort is exercised for real: a simulate backup is started, cancelled mid-wait, and the
// job is watched settle the row to 'cancelled' and clear the busy flag.
process.env.MAINTENANCE_MODE = 'simulate';   // gate decisions + simulate job paths; no daemon touched
process.env.MAINTENANCE_ENABLED = 'false';   // never arm the real scheduler under a test
process.env.SIM_BACKUP_MS = '3000';          // long enough to catch the simulate backup mid-flight

const { q, one, pool } = await import('../server/src/db/pool.js');
const m = await import('../server/src/queenzee/maintenance.js');
const S = await import('../server/src/lib/backup-schedule.js');

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };
const threw = async (fn, re, msg) => {
  try { await fn(); ok(false, `${msg} (did NOT throw)`); }
  catch (e) { ok(re.test(e.message), `${msg} — threw: ${e.message.slice(0, 120)}`); }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// Watch a row until its status leaves `from` (or give up after `timeoutMs`), so the async job's
// own settle is observed rather than guessed at.
async function waitUntilStatus(id, from, timeoutMs = 8000) {
  const t0 = Date.now();
  for (;;) {
    const row = await one(`SELECT status FROM db_snapshot WHERE id=$1`, [id]);
    if (row?.status && row.status !== from) return row.status;
    if (Date.now() - t0 > timeoutMs) return row?.status ?? null;
    await wait(50);
  }
}

const MIN = 60_000, HOUR = 3600_000;
const T0 = Date.parse('2026-07-28T18:30:00Z');
const at = (ms) => new Date(ms).toISOString();
const POLICY_12H = 12 * 3600;

let projId;
try {
  projId = (await one(
    `INSERT INTO project (name, repo_root, main_branch, db_name, db_user)
       VALUES ($1,$2,'main','zt','zt') RETURNING id`,
    [`zt-bkcancel-${Date.now()}`, '/tmp/zt-bkcancel'])).id;
  // A per-test backup dir in /tmp so the simulate placeholder never lands in the repo.
  await q(`INSERT INTO pool_config (project_id, backup_dir) VALUES ($1,$2)`, [projId, '/tmp/zt-bkcancel-dumps']);
  const prodDb = (await one(
    `INSERT INTO container (project_id, role, tier, isolation, name)
       VALUES ($1,'db','prod','shared',$2) RETURNING id`, [projId, `zt_bkprod_${Date.now()}`])).id;

  // ── 1. the pure decision: a CANCELLED attempt is a RETRY, never a whole policy window ──────────
  console.log('\n── backupDecision: cancelled behaves like failed for timing ──');
  const cancelledAt = T0 + 1 * HOUR;
  const dec = (now, streak = 1) => S.backupDecision({
    lastAttempt: { status: 'cancelled', taken_at: at(cancelledAt) },
    lastGood: { taken_at: at(T0) }, failStreak: streak, intervalSec: POLICY_12H, now });

  ok(dec(cancelledAt + 9 * MIN).due === false, 'nine minutes after a cancel: not due (a retry is not a hammer)');
  ok(dec(cancelledAt + 10 * MIN).due === true, 'TEN minutes after a cancel: DUE — the retry interval, not the policy interval');
  ok(dec(cancelledAt + 10 * MIN).kind === 'retry', 'and it is labelled a retry, so the log says why');
  ok(dec(cancelledAt + 11 * MIN).reason.includes('CANCELLED'),
     'the reason says it was CANCELLED, not failed — a human stopped it');
  ok(dec(cancelledAt + 12 * HOUR).due === true,
     'and it does not wait a full policy interval after a cancel — the restore point is just as stale');

  // ── 2. cancelBackup refuses what is not running ──────────────────────────────────────────────
  console.log('\n── cancelBackup: only a RUNNING backup can be cancelled ──');
  const fin = (await one(
    `INSERT INTO db_snapshot (project_id, source, dump_path, status, mode)
       VALUES ($1,'prod','/tmp/zt-bkcancel/fin.dump','finished','real') RETURNING id`, [projId])).id;
  await threw(() => m.cancelBackup(fin), /not running/,
    'a FINISHED backup is REFUSED — nothing to cancel');
  const failed = (await one(
    `INSERT INTO db_snapshot (project_id, source, dump_path, status, mode)
       VALUES ($1,'prod','/tmp/zt-bkcancel/fail.dump','failed','real') RETURNING id`, [projId])).id;
  await threw(() => m.cancelBackup(failed), /not running/,
    'a FAILED backup is REFUSED — nothing to cancel');
  await threw(() => m.cancelBackup('00000000-0000-0000-0000-000000000000'), /not found/,
    'an unknown id → not found');

  // ── 3. a running row with NO live job in this process is still settled (defensive path) ───────
  console.log('\n── cancelBackup with no in-flight job: the row is still settled, never left spinning ──');
  await q(`UPDATE container SET busy_since=now(), busy_op='backup' WHERE id=$1`, [prodDb]);
  const orphanPath = '/tmp/zt-bkcancel/orphan.dump';
  const orphan = (await one(
    `INSERT INTO db_snapshot (project_id, source, dump_path, status, mode)
       VALUES ($1,'prod',$2,'running','real') RETURNING id`, [projId, orphanPath])).id;
  const settled = await m.cancelBackup(orphan);
  ok(settled.ok === true && settled.status === 'cancelled',
     'cancel of an orphaned running row returns { ok, status: cancelled }');
  ok((await one(`SELECT status FROM db_snapshot WHERE id=$1`, [orphan])).status === 'cancelled',
     'the orphaned row is finalised cancelled');
  ok((await one(`SELECT busy_op FROM container WHERE id=$1`, [prodDb]))?.busy_op === null,
     'the prod container is un-busied');
  const fs = await import('node:fs');
  ok(!fs.existsSync(orphanPath), 'the partial file is removed');

  // ── 4. a REAL in-flight simulate backup is aborted by cancelBackup ────────────────────────────
  console.log('\n── a live backup job stops when cancelled ──');
  await q(`UPDATE container SET busy_since=NULL, busy_op=NULL WHERE id=$1`, [prodDb]);
  const runningSnap = await m.backupProd(projId);   // creates the row, fires the async simulate job
  ok(runningSnap?.status === 'running', 'backupProd starts a running row');
  ok(!!(await one(`SELECT busy_op FROM container WHERE id=$1`, [prodDb]))?.busy_op,
     'the prod container is busy while it runs');
  await wait(150);                                  // let the job reach its first (long) wait
  const req = await m.cancelBackup(runningSnap.id);
  ok(req.ok === true && req.status === 'cancelling',
     'cancel of a live job returns { ok, status: cancelling } — the abort was handed to the job');
  const finalStatus = await waitUntilStatus(runningSnap.id, 'running');
  ok(finalStatus === 'cancelled', `the live job settles the row to cancelled (got ${finalStatus})`);
  ok((await one(`SELECT busy_op FROM container WHERE id=$1`, [prodDb]))?.busy_op === null,
     'the prod container is un-busied once the cancelled job finishes');
  const row = await one(`SELECT error, dump_path FROM db_snapshot WHERE id=$1`, [runningSnap.id]);
  ok(/cancelled/.test(row.error), 'the row records why it was cancelled');

  // ── 5. a cancelled row is a normal final state: deletable, never restorable ───────────────────
  console.log('\n── a cancelled backup is deletable, and cannot be restored ──');
  const del = await m.deleteBackup(runningSnap.id);
  ok(del.ok === true, 'a cancelled backup deletes (the Delete button in the modal)');
  ok((await q(`SELECT 1 FROM db_snapshot WHERE id=$1`, [runningSnap.id])).length === 0,
     'its row is gone');

  const cancellable = (await one(
    `INSERT INTO db_snapshot (project_id, source, dump_path, status, mode)
       VALUES ($1,'prod','/tmp/zt-bkcancel/c.dump','cancelled','real') RETURNING id`, [projId])).id;
  await threw(() => m.restoreBackup({ snapshot: cancellable, container: prodDb }),
    /not finished yet/, 'a cancelled backup cannot be restored (it produced no usable dump)');

  // ── 6. backupDue reads a cancelled row from the ledger as a retry, with a streak ─────────────
  console.log('\n── backupDue: the ledger treats cancelled like failed ──');
  await q(`DELETE FROM db_snapshot WHERE project_id=$1`, [projId]);
  await one(
    `INSERT INTO db_snapshot (project_id, source, dump_path, status, mode, taken_at)
       VALUES ($1,'prod','/tmp/zt-bkcancel/good.dump','finished','real',$2::timestamptz)`,
    [projId, at(T0)]);
  await one(
    `INSERT INTO db_snapshot (project_id, source, dump_path, status, mode, taken_at)
       VALUES ($1,'prod','/tmp/zt-bkcancel/c1.dump','cancelled','real',$2::timestamptz)`,
    [projId, at(T0 + 1 * HOUR)]);
  const due1 = await m.backupDue(projId, T0 + 1 * HOUR + 11 * MIN);
  ok(due1.due === true && due1.kind === 'retry', 'one cancelled row → a RETRY is due 11 minutes later (not 12 hours)');
  ok(/attempt 1 since the last success/.test(due1.reason), 'and the reason names which attempt this is');
  await one(
    `INSERT INTO db_snapshot (project_id, source, dump_path, status, mode, taken_at)
       VALUES ($1,'prod','/tmp/zt-bkcancel/c2.dump','cancelled','real',$2::timestamptz)`,
    [projId, at(T0 + 2 * HOUR)]);
  const due2 = await m.backupDue(projId, T0 + 2 * HOUR + 11 * MIN);
  ok(due2.due === false, 'TWO cancelled rows → the second retry waits 20 minutes, not 10 (backoff counts them)');
  ok(/attempt 2 since the last success/.test(due2.reason), 'the streak counts cancelled rows too');

  // ── 7. the console tells the truth about a cancelled attempt ─────────────────────────────────
  console.log('\n── the panel: a cancelled attempt is NOT "last attempt failed", and still says when it will retry ──');
  const { transformSync } = await import('esbuild');
  const { writeFileSync: w, rmSync, readFileSync } = await import('node:fs');
  const { resolve } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const here = fileURLToPath(new URL('.', import.meta.url));
  const read = (p) => readFileSync(resolve(here, '..', p), 'utf8');
  const tmp = resolve(here, '..', 'web/src/.cancel-line.test-build.mjs');
  w(tmp, transformSync(read('web/src/Backups.jsx'), { loader: 'jsx', format: 'esm' }).code
    .replace(/import[^\n]*\.\/(api|Dialog)\.jsx?['"];?/g, (_m, mod) => ({
      api: 'const getBackups=async()=>({}),setBackupConfig=async()=>{},runBackup=async()=>{},'
         + 'revealBackup=async()=>{},restoreBackup=async()=>{},deleteBackup=async()=>{},cancelBackup=async()=>{},subscribe=()=>()=>{};',
      Dialog: 'const showConfirm=async()=>true,showPrompt=async()=>null,showAlert=async()=>{};',
    }[mod] || '')));
  const { renderToStaticMarkup } = await import('react-dom/server');
  const React = (await import('react')).default;
  let nextAttemptLine, backupFreshness, BackupsPanel;
  try {
    const mod = await import(`${tmp}?t=${process.pid}`);
    nextAttemptLine = mod.nextAttemptLine; backupFreshness = mod.backupFreshness; BackupsPanel = mod.default;
  } finally { rmSync(tmp, { force: true }); }

  const cancelledAttempt = { last: { taken_at: at(T0) },
    last_attempt: { taken_at: at(T0 + 1 * HOUR), status: 'cancelled', error: 'cancelled by operator' },
    config: { backup_interval_sec: POLICY_12H } };
  const fr = backupFreshness(cancelledAttempt, T0 + 1 * HOUR + 5 * MIN);
  ok(fr.failedSince === false, 'a CANCELLED last attempt does NOT light the "last attempt failed" mark — a human stopped it');
  ok(nextAttemptLine({ ...cancelledAttempt, next: { kind: 'retry', due: false, waitSec: 600 } }) === 'retry in 10 min',
     'and the panel still says WHEN the scheduler will retry — the red mark is never the whole sentence');

  // A RUNNING backup's Cancel button is on the panel itself — the "i can't cancel a backup while it
  // backs up" report was because the only Cancel lived inside the all-backups modal, and the panel
  // (where the running state is read) offered no way to stop it.
  const runningPanel = renderToStaticMarkup(React.createElement(BackupsPanel, {
    projectId: projId,
    backup: { ...cancelledAttempt, running: { id: 'run-1', taken_at: at(T0 + 1 * HOUR) } },
  }));
  ok(/data-testid="backup-running"/.test(runningPanel), 'the panel shows the running backup');
  ok(/data-testid="backup-cancel"/.test(runningPanel), 'and a Cancel button to stop it right there');
  ok(!/data-testid="backup-cancel"/.test(renderToStaticMarkup(React.createElement(BackupsPanel, {
    projectId: projId, backup: cancelledAttempt }))),
    'no Cancel button when nothing is running — the action appears only with the job it stops');

  // ── 8. the backups MODAL shows the LIVE LOG of a running backup — "logs dont show when backing up
  // ────── from backups window" was because the only log lived in the bottom-right toast; a backup
  // ────── started HERE had its log where nobody watching the window was looking. ────────────────
  console.log('\n── the modal streams the running backup\'s log into its row ──');
  const bksrc = read('web/src/Backups.jsx');
  ok(/onDbOpLog/.test(bksrc) && /p\?\.op !== 'backup'/.test(bksrc),
     'the modal subscribes to db-op-log and keeps only BACKUP lines');
  ok(/runLogs\[b\.id\]/.test(bksrc) && /data-testid="backup-row-log"/.test(bksrc),
     'and renders them in the RUNNING row (data-testid backup-row-log) — the log rides the backup it describes');
  ok(/slice\(-200\)/.test(bksrc), 'capped like the toast, so a chatty pg_dump cannot eat the tab');
  ok(/\.bkrow-log/.test(read('web/src/styles.css')),
     'the stylesheet backs the inline log block (.bkrow-log spans the row)');
} finally {
  if (projId) {
    await q(`DELETE FROM db_snapshot WHERE project_id=$1`, [projId]).catch(() => {});
    await q(`DELETE FROM container WHERE project_id=$1`, [projId]).catch(() => {});
    await q(`DELETE FROM pool_config WHERE project_id=$1`, [projId]).catch(() => {});
    await q(`DELETE FROM project WHERE id=$1`, [projId]).catch(() => {});
  }
  await pool.end().catch(() => {});
}
console.log(`\n${failures === 0 ? 'ALL PASSED ✓' : `${failures} FAILURE(S) ✗`}`);
process.exit(failures === 0 ? 0 : 1);
