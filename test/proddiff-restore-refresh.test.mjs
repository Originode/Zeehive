// PROD-DIFF ROUTING — the on-demand + post-restore drift refresh this xell adds:
//   • diffOneContainerAgainstProd(id): measure ONE db container's schema against prod on demand
//     (the chip's "Check diff" context-menu item, and the route POST /containers/:id/check-diff).
//   • refreshProdDiffAfterRestore(id): called off a finished restore so the chip stops showing the
//     pre-restore verdict — the RULER (prod) re-checks the whole fleet, any other db re-checks itself.
// Runs the REAL lib against this xell's isolated postgres with NO docker daemon: the catalog probe
// resolves ok:false, so this asserts the DECISION/ROUTING each function makes (which db is measured
// against what, and that prod is never measured against itself) — the part the daemon can't change.
process.env.PRODDIFF_ENABLED = 'false';   // don't let the interval loop start under the test

const { q, one, pool } = await import('../server/src/db/pool.js');
const pd = await import('../server/src/queenzee/proddiff.js');

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };

let projId;
try {
  projId = (await one(
    `INSERT INTO project (name, repo_root, main_branch, db_name, db_user)
       VALUES ($1,$2,'main','zt','zt') RETURNING id`,
    [`zt-pdiff-${Date.now()}`, '/tmp/zt-pdiff'])).id;

  const prodDb = (await one(
    `INSERT INTO container (project_id, role, tier, isolation, name)
       VALUES ($1,'db','prod','shared',$2) RETURNING id`, [projId, `zt_db_prod_${Date.now()}`])).id;
  const devDb = (await one(
    `INSERT INTO container (project_id, role, tier, isolation, name)
       VALUES ($1,'db','dev','shared',$2) RETURNING id`, [projId, `zt_db_dev_${Date.now()}`])).id;

  // ── diffOneContainerAgainstProd ──────────────────────────────────────────────
  console.log('\n── diffOneContainerAgainstProd: routing ──');
  const unknown = await pd.diffOneContainerAgainstProd('00000000-0000-0000-0000-000000000000');
  ok(unknown.ok === false && /no such db/.test(unknown.error), 'unknown id → { ok:false, no such db }');

  const onProd = await pd.diffOneContainerAgainstProd(prodDb);
  ok(onProd.ok === true && onProd.same_db === true && onProd.total === 0,
    'the PROD db is the ruler — measured against nothing (same_db, total 0, no docker touched)');

  // No docker daemon: the dev db resolves prod, then the catalog probe fails ok:false. The point is
  // it routes to a REAL comparison against prod (not same_db) and degrades cleanly, never throwing.
  const onDev = await pd.diffOneContainerAgainstProd(devDb);
  ok(onDev.same_db !== true, 'the dev db is NOT treated as prod (it gets a real comparison)');
  ok(onDev.ok === false, 'with no docker daemon the dev-vs-prod probe degrades to { ok:false } (no throw)');

  // With NO prod container in the project there is no ruler to measure against.
  const orphanProj = (await one(
    `INSERT INTO project (name, repo_root, main_branch, db_name, db_user)
       VALUES ($1,$2,'main','zt','zt') RETURNING id`,
    [`zt-pdiff-noprod-${Date.now()}`, '/tmp/zt-pdiff2'])).id;
  const lonelyDev = (await one(
    `INSERT INTO container (project_id, role, tier, isolation, name)
       VALUES ($1,'db','dev','shared',$2) RETURNING id`, [orphanProj, `zt_db_lonely_${Date.now()}`])).id;
  const noRuler = await pd.diffOneContainerAgainstProd(lonelyDev);
  ok(noRuler.ok === false && /no prod db/.test(noRuler.error),
    'a project with no prod db → { ok:false, no prod db to measure against }');
  await q(`DELETE FROM container WHERE project_id=$1`, [orphanProj]);
  await q(`DELETE FROM project WHERE id=$1`, [orphanProj]);

  // ── refreshProdDiffAfterRestore ──────────────────────────────────────────────
  console.log('\n── refreshProdDiffAfterRestore: restore-completion hook ──');
  const gone = await pd.refreshProdDiffAfterRestore('00000000-0000-0000-0000-000000000000');
  ok(gone.ok === false, 'unknown container id → { ok:false } (no crash)');

  // Restoring the RULER re-bases everything: it runs the whole tick (→ { checked, drifted }),
  // never a same_db shortcut, and never throws even with no daemon.
  const afterProd = await pd.refreshProdDiffAfterRestore(prodDb);
  ok(afterProd && typeof afterProd.checked === 'number',
    'restoring PROD re-runs the whole fleet drift tick (→ { checked, drifted })');

  // Restoring a non-prod db re-checks just that one (routes through diffOneContainerAgainstProd).
  const afterDev = await pd.refreshProdDiffAfterRestore(devDb);
  ok(afterDev.same_db !== true && afterDev.checked === undefined,
    'restoring a DEV db re-checks only that container, not the whole tick');
} finally {
  if (projId) {
    await q(`DELETE FROM container WHERE project_id=$1`, [projId]);
    await q(`DELETE FROM project WHERE id=$1`, [projId]);
  }
  await pool.end().catch(() => {});
}
console.log(`\n${failures === 0 ? 'ALL PASSED ✓' : `${failures} FAILURE(S) ✗`}`);
process.exit(failures === 0 ? 0 : 1);
