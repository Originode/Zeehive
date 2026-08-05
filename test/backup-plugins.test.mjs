// PLUGINS (EXTENSIONS) IN BACKUP/RESTORE SETTINGS — unit coverage for the feature that lets a
// project configure the PostgreSQL extensions ("plugins") a restore target must have before a
// backup is loaded into it (postgis, h3, …). A dump taken from an extension-bearing database
// can't restore into a database that doesn't have the extension — either the archive's own
// CREATE EXTENSION fails (extension not available on the target server) or, for a table-scoped
// dump that doesn't record the extension, the extension's TYPES are missing (type "geometry"
// does not exist).
//   • validPluginSelection — pure validation: plain identifiers, lowercased, deduped.
//   • setBackupConfig round-trip — backup_plugins persists on pool_config and comes back.
process.env.MODE = process.env.MODE || 'simulate';

const m = await import('../server/src/queenzee/maintenance.js');
const { q, one, pool } = await import('../server/src/db/pool.js');

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg} → ${JSON.stringify(a)}`);

console.log('\n── validPluginSelection (identifiers only, lowercased, deduped) ──');
eq(m.validPluginSelection(null), [], 'null ⇒ [] (none)');
eq(m.validPluginSelection([]), [], 'empty ⇒ []');
eq(m.validPluginSelection(['postgis', 'postgis']), ['postgis'], 'dedupes');
eq(m.validPluginSelection([' postgis ', 'H3']), ['postgis', 'h3'], 'trims + lowercases');
eq(m.validPluginSelection(['postgis_topology', 'h3', 'pgvector']), ['postgis_topology', 'h3', 'pgvector'],
  'underscored extension names pass');
for (const bad of ['post-gis', 'postgis v3', 'a.b', 'postgis;DROP', 'post gis', '*']) {
  let threw = false; try { m.validPluginSelection([bad]); } catch { threw = true; }
  ok(threw, `rejects ${JSON.stringify(bad)}`);
}
{
  let threw = false; try { m.validPluginSelection('postgis'); } catch { threw = true; }
  ok(threw, 'rejects a non-array input');
}

console.log('\n── setBackupConfig round-trip (persists on pool_config) ──');
let projId;
try {
  projId = (await one(
    `INSERT INTO project (name, repo_root, main_branch, db_name, db_user)
       VALUES ($1,$2,'main','zt','zt') RETURNING id`, [`zt-bkplg-${Date.now()}`, '/tmp/zt-bkplg'])).id;
  await q(`INSERT INTO pool_config (project_id) VALUES ($1)`, [projId]);

  const saved = await m.setBackupConfig({
    project: projId, backup_dir: null, backup_ctx: null,
    backup_interval_sec: 86400, max_backups: 14, backup_plugins: ['postgis', 'PostGIS', ' h3 '],
  });
  eq(saved.backup_plugins, ['postgis', 'h3'], 'saved plugins returned (lowercased + deduped)');
  const row = await one(`SELECT backup_plugins FROM pool_config WHERE project_id=$1`, [projId]);
  eq(row.backup_plugins, ['postgis', 'h3'], 'persisted to pool_config');

  const cleared = await m.setBackupConfig({
    project: projId, backup_dir: null, backup_ctx: null,
    backup_interval_sec: 86400, max_backups: 14, backup_plugins: [],
  });
  ok(cleared.backup_plugins == null, 'empty plugins stored as NULL (none)');

  let threw = false;
  try {
    await m.setBackupConfig({ project: projId, backup_interval_sec: 86400, max_backups: 14, backup_plugins: ['bad name'] });
  } catch { threw = true; }
  ok(threw, 'invalid plugin name is refused at config time');
} finally {
  if (projId) {
    await q(`DELETE FROM pool_config WHERE project_id=$1`, [projId]);
    await q(`DELETE FROM project WHERE id=$1`, [projId]);
  }
  await pool.end().catch(() => {});
}

console.log(`\n${failures === 0 ? 'ALL PASSED ✓' : `${failures} FAILURE(S) ✗`}`);
process.exit(failures === 0 ? 0 : 1);
