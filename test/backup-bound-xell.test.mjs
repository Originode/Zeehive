// A BACKUP MAY RUN WHILE A XELL IS BOUND TO PROD — ticket: "allow prod db backups even if bound
// to a xell as long as not shipping or seeding."
//
// prodBusyReason() used to refuse a backup whenever a live work xell held db-shared-prod — the
// human-granted hotfix/data binding — because "it may write at any moment". A backup is a READ:
// pg_dump's ACCESS SHARE does not contend with row-level data work, so a bound xell no longer
// blocks a dump. Prod is still off-limits to backups while a SHIP is deploying (the prod deploy
// lock) or a SEED is being applied (a queenzee-run write that is mid-apply). A RESTORE-OVER-PROD
// still refuses a live bound xell: a restore clobbers what the xell wrote, which is a different
// collision from a read-only dump.
//
// Runs the REAL lib against this xell's isolated postgres in simulate mode (no docker daemon):
// every check here is a DECISION prodBusyReason / backupProd / duplicateProdInto / restoreBackup
// make BEFORE any async docker work.
process.env.MAINTENANCE_MODE = 'simulate';   // gate decisions are synchronous; no daemon touched

const { q, one, pool } = await import('../server/src/db/pool.js');
const m = await import('../server/src/queenzee/maintenance.js');

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };
const threw = async (fn, re, msg) => {
  try { await fn(); ok(false, `${msg} (did NOT throw)`); }
  catch (e) { ok(re.test(e.message), `${msg} — threw: ${e.message.slice(0, 120)}`); }
};
const clearBusy = (id) => q(`UPDATE container SET busy_since=NULL, busy_op=NULL WHERE id=$1`, [id]);

let projId;
try {
  projId = (await one(
    `INSERT INTO project (name, repo_root, main_branch, db_name, db_user)
       VALUES ($1,$2,'main','zt','zt') RETURNING id`,
    [`zt-bx-${Date.now()}`, `/tmp/zt-bx-${Date.now()}`])).id;
  await q(`INSERT INTO pool_config (project_id) VALUES ($1)`, [projId]);

  const prodDb = (await one(
    `INSERT INTO container (project_id, role, tier, isolation, name)
       VALUES ($1,'db','prod','shared',$2) RETURNING id`, [projId, `zt_db_prod_${Date.now()}`])).id;
  const devDb = (await one(
    `INSERT INTO container (project_id, role, tier, isolation, name)
       VALUES ($1,'db','dev','shared',$2) RETURNING id`, [projId, `zt_db_dev_${Date.now()}`])).id;

  // a live work xell BOUND to the prod database (db-shared-prod) — the case the ticket relaxes
  const xource = await one(`SELECT id FROM xource LIMIT 1`);
  const xellId = (await one(
    `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status, is_pooled,
                       db_coupling)
       VALUES ($1,$2,$3,$4,$5,'working',false,'db-shared-prod') RETURNING id`,
    [projId, xource.id, `zt-bx-xell-${Date.now()}`, `spinoff/zt-bx-${Date.now()}`,
     `/tmp/zt-bx-wt-${Date.now()}`])).id;
  await q(`INSERT INTO zee (xell_id, attach_mode, status, kind, entrypoint)
             VALUES ($1,'headless-spawn','working','headless','headless-cli')`, [xellId]);

  // ── 1. THE TICKET: a bound xell no longer blocks a backup ─────────────────────
  console.log('\n── a live xell BOUND to prod no longer blocks a backup ──');
  const free = await m.prodBusyReason(projId);
  ok(free === null, `prodBusyReason → null with a bound xell + live zee (was: ${free})`);

  const started = await m.backupProd(projId);
  ok(started.status === 'running' && started.source === 'prod',
     'backupProd STARTS while a bound xell is live');
  ok((await one(`SELECT busy_op FROM container WHERE id=$1`, [prodDb]))?.busy_op === 'backup',
     'the PROD container is flagged busy_op=backup while the dump runs');
  await clearBusy(prodDb);
  await q(`DELETE FROM db_snapshot WHERE project_id=$1`, [projId]);

  // ── 2. SHIPPING still blocks (the prod deploy lock) ──────────────────────────
  console.log('\n── a SHIP (prod deploy lock) still blocks ──');
  await q(`INSERT INTO deploy_lock (project_id, container, phase) VALUES ($1,'prod','shipping')`, [projId]);
  const shipBusy = await m.prodBusyReason(projId);
  ok(shipBusy !== null && /deploy lock/.test(shipBusy), 'prodBusyReason blocks while a ship holds the lock');
  await threw(() => m.backupProd(projId), /deploy lock/,
    'backupProd REFUSED while a ship holds the lock');
  await q(`DELETE FROM deploy_lock WHERE project_id=$1`, [projId]);

  // ── 3. SEEDING still blocks (a queenzee-run write is mid-apply) ──────────────
  console.log('\n── a SEED being applied still blocks ──');
  await q(`INSERT INTO prod_seed_request (project_id, xell_id, xell_slug, files, status)
             VALUES ($1,$2,'zt-bx','[]'::jsonb,'running')`, [projId, xellId]);
  const runBusy = await m.prodBusyReason(projId);
  ok(runBusy !== null && /seed/.test(runBusy), 'a RUNNING seed blocks a backup');
  await threw(() => m.backupProd(projId), /seed/,
    'backupProd REFUSED while a seed is running');

  await q(`UPDATE prod_seed_request SET status='approved' WHERE project_id=$1`, [projId]);
  ok((await m.prodBusyReason(projId)) === null,
     'an APPROVED seed does NOT block — it is a transient blink before runSeed flips it to running, '
     + 'and a crash in that blink would otherwise block backups forever');

  await q(`UPDATE prod_seed_request SET status='pending' WHERE project_id=$1`, [projId]);
  ok((await m.prodBusyReason(projId)) === null,
     'a PENDING seed does NOT block — a request awaiting a human is not an operation');

  await q(`UPDATE prod_seed_request SET status='running', dismissed_at=now() WHERE project_id=$1`, [projId]);
  ok((await m.prodBusyReason(projId)) !== null && /seed/.test(await m.prodBusyReason(projId)),
     'a DISMISSED but RUNNING seed still blocks — dismissal hides the card, it does not stop the apply');
  await q(`DELETE FROM prod_seed_request WHERE project_id=$1`, [projId]);

  // ── 4. DUPLICATE (a prod read) is relaxed the same way ───────────────────────
  console.log('\n── duplicate prod → dev is a READ of prod, so it too runs while bound ──');
  const dup = await m.duplicateProdInto({ container: devDb });
  ok(dup.status === 'started', 'duplicateProdInto STARTS while a bound xell is live');
  await clearBusy(devDb); await clearBusy(prodDb);

  // ── 5. RESTORE-OVER-PROD still refuses a live bound xell (it clobbers prod) ──
  console.log('\n── restore-OVER-PROD still refuses a live bound xell ──');
  const snap = await one(
    `INSERT INTO db_snapshot (project_id, source, dump_path, status, mode, size_bytes)
       VALUES ($1,'prod','/tmp/zt-bx.good.dump','finished','real',1000) RETURNING id`, [projId]);
  const boundReason = await m.boundLiveXellReason(projId);
  ok(boundReason !== null && /bound to the prod/.test(boundReason),
     'boundLiveXellReason still reports the bound xell (restore uses it)');
  await threw(() => m.restoreBackup({ snapshot: snap.id, container: prodDb, confirmProd: true }),
    /refusing to restore over prod/,
    'restore over prod + confirmProd but a live bound xell → REFUSED (would clobber its work)');
  ok((await one(`SELECT busy_op FROM container WHERE id=$1`, [prodDb]))?.busy_op == null,
     'and the refused restore left prod untouched');

  // sanity: with the bound xell gone, the SAME restore is accepted
  await q(`DELETE FROM zee WHERE xell_id=$1`, [xellId]);
  await q(`DELETE FROM xell WHERE id=$1`, [xellId]);
  const restored = await m.restoreBackup({ snapshot: snap.id, container: prodDb, confirmProd: true });
  ok(restored.status === 'started', 'with no live bound xell, the same restore STARTS');
  await clearBusy(prodDb);
} finally {
  if (projId) {
    await q(`DELETE FROM deploy_lock WHERE project_id=$1`, [projId]);
    await q(`DELETE FROM prod_seed_request WHERE project_id=$1`, [projId]);
    await q(`DELETE FROM db_snapshot WHERE project_id=$1`, [projId]);
    await q(`DELETE FROM container WHERE project_id=$1`, [projId]);
    await q(`DELETE FROM xell WHERE project_id=$1`, [projId]);
    await q(`DELETE FROM pool_config WHERE project_id=$1`, [projId]);
    await q(`DELETE FROM project WHERE id=$1`, [projId]);
  }
  await pool.end().catch(() => {});
}
console.log(`\n${failures === 0 ? 'ALL PASSED ✓' : `${failures} FAILURE(S) ✗`}`);
process.exit(failures === 0 ? 0 : 1);
