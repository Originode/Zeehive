// DUPLICATE PROD → DEV — the "Duplicate prod" context-menu action: a fresh prod backup + restore
// FUSED into one, so a dev db becomes an exact copy of live production. duplicateProdInto makes all
// its DECISIONS before any async docker work, so we can prove them against this xell's isolated
// postgres in simulate mode (no docker daemon touched):
//   • a NON-prod db target STARTS the copy and flags BOTH endpoints busy (prod=backup, dev=restore)
//   • the PRODUCTION db is REFUSED as a target (that's the gated restore-over-prod flow, not this)
//   • prod IN USE (a ship holds the deploy lock) → REFUSED even for a dev target
//   • a busy target / busy prod / no-prod-modeled / non-db target are each refused with a clear reason
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
const busyOp = async (id) => (await one(`SELECT busy_op FROM container WHERE id=$1`, [id]))?.busy_op;

let projId;
try {
  projId = (await one(
    `INSERT INTO project (name, repo_root, main_branch, db_name, db_user)
       VALUES ($1,$2,'main','zt','zt') RETURNING id`,
    [`zt-dup-${Date.now()}`, '/tmp/zt-dup'])).id;
  await q(`INSERT INTO pool_config (project_id) VALUES ($1)`, [projId]);

  const prodDb = (await one(
    `INSERT INTO container (project_id, role, tier, isolation, name)
       VALUES ($1,'db','prod','shared',$2) RETURNING id`, [projId, `zt_db_prod_${Date.now()}`])).id;
  const devDb = (await one(
    `INSERT INTO container (project_id, role, tier, isolation, name)
       VALUES ($1,'db','dev','shared',$2) RETURNING id`, [projId, `zt_db_dev_${Date.now()}`])).id;
  const devApp = (await one(
    `INSERT INTO container (project_id, role, tier, isolation, name)
       VALUES ($1,'server','dev','shared',$2) RETURNING id`, [projId, `zt_srv_dev_${Date.now()}`])).id;

  // ── happy path: dev target STARTS + both endpoints busy ──────────────────────
  console.log('\n── duplicate prod → a dev db STARTS, spins prod (backup) + dev (restore) ──');
  const started = await m.duplicateProdInto({ container: devDb });
  ok(started.status === 'started', 'a dev target → duplicate STARTS');
  ok((await busyOp(devDb)) === 'restore', 'the DEV target is flagged busy_op=restore (being overwritten)');
  ok((await busyOp(prodDb)) === 'backup', 'the PROD source is flagged busy_op=backup (being dumped)');
  await clearBusy(devDb); await clearBusy(prodDb);   // undo the sim job's busy flags

  // ── prod is never a TARGET ───────────────────────────────────────────────────
  console.log('\n── production is the SOURCE, never a target ──');
  await threw(() => m.duplicateProdInto({ container: prodDb }),
    /target IS production/, 'the PROD db as a target → REFUSED');

  // ── prod IN USE → refused (same window a backup is) ──────────────────────────
  console.log('\n── prod in use → refused ──');
  await q(`INSERT INTO deploy_lock (project_id, container, phase) VALUES ($1,'prod','deploying')`, [projId]);
  await threw(() => m.duplicateProdInto({ container: devDb }),
    /duplicate refused/, 'prod MID-SHIP → REFUSED (a dump would contend with live prod work)');
  await q(`DELETE FROM deploy_lock WHERE project_id=$1`, [projId]);

  // ── a busy target is refused ─────────────────────────────────────────────────
  console.log('\n── a busy target / busy prod is refused ──');
  await q(`UPDATE container SET busy_since=now(), busy_op='restore' WHERE id=$1`, [devDb]);
  await threw(() => m.duplicateProdInto({ container: devDb }),
    /this container is busy/, 'a target already mid-restore → REFUSED');
  await clearBusy(devDb);

  await q(`UPDATE container SET busy_since=now(), busy_op='backup' WHERE id=$1`, [prodDb]);
  await threw(() => m.duplicateProdInto({ container: devDb }),
    /production database is busy/, 'prod already mid-dump → REFUSED');
  await clearBusy(prodDb);

  // ── non-db target / unknown id ───────────────────────────────────────────────
  console.log('\n── non-db target / unknown id ──');
  await threw(() => m.duplicateProdInto({ container: devApp }),
    /not a db container/, 'a server (non-db) target → REFUSED');
  await threw(() => m.duplicateProdInto({ container: '00000000-0000-0000-0000-000000000000' }),
    /not found/, 'an unknown id → not found');

  // ── no prod modeled → refused (real mode) ────────────────────────────────────
  console.log('\n── no prod db modeled ──');
  await q(`DELETE FROM container WHERE id=$1`, [prodDb]);
  // simulate mode tolerates a missing prod (nothing to dump); real mode must refuse.
  const noProd = await m.duplicateProdInto({ container: devDb });
  ok(noProd.status === 'started', 'simulate mode without a prod db still STARTS (nothing dumped)');
  await clearBusy(devDb);
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
