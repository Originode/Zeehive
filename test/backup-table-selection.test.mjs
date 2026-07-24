// TABLE-SCOPED BACKUP & RESTORE — unit coverage for the selection feature: choose which tables a
// prod backup dumps (default: all) and which tables a restore loads (default: all).
//   • dumpTableArgs / restoreTableArgs / validTableSelection — pure argv + validation, no database.
//   • parseDumpToc — the compound-descriptor + SCHEMA fixes that make a clean table/schema list.
//   • setBackupConfig round-trip — the selection persists on pool_config and comes back.
process.env.MODE = process.env.MODE || 'simulate';

const m = await import('../server/src/queenzee/maintenance.js');
const { q, one, pool } = await import('../server/src/db/pool.js');

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg} → ${JSON.stringify(a)}`);

console.log('\n── dumpTableArgs (pg_dump -t, schema-qualified) ──');
eq(m.dumpTableArgs([]), [], 'empty selection ⇒ no args (full-database dump)');
eq(m.dumpTableArgs(null), [], 'null ⇒ no args');
eq(m.dumpTableArgs(['core.location']), ['-t', 'core.location'], 'one table');
eq(m.dumpTableArgs(['core.location', 'public.spatial_ref_sys']),
  ['-t', 'core.location', '-t', 'public.spatial_ref_sys'], 'two tables → one -t each');

console.log('\n── restoreTableArgs (pg_restore -n schema + -t name) ──');
eq(m.restoreTableArgs([]), [], 'empty ⇒ no args (restore whole archive)');
eq(m.restoreTableArgs(['core.location']), ['-n', 'core', '-t', 'location'], 'schema→-n, table→-t');
eq(m.restoreTableArgs(['core.a', 'core.b']), ['-n', 'core', '-t', 'a', '-t', 'b'], 'one -n for a shared schema');
eq(m.restoreTableArgs(['bare']), ['-t', 'bare'], 'bare table name (no schema) → just -t');

console.log('\n── validTableSelection (identifiers only, dedupe) ──');
eq(m.validTableSelection(null), [], 'null ⇒ [] (all)');
eq(m.validTableSelection(['core.location', 'core.location']), ['core.location'], 'dedupes');
eq(m.validTableSelection([' core.location ', '']), ['core.location'], 'trims, drops blanks');
for (const bad of ['core.*', 'a;b', 'core.loc ation', 'a.b.c', 'DROP TABLE', "core.'x'"]) {
  let threw = false; try { m.validTableSelection([bad]); } catch { threw = true; }
  ok(threw, `rejects ${JSON.stringify(bad)}`);
}

console.log('\n── parseDumpToc (compound descriptors + SCHEMA name) ──');
const toc = m.parseDumpToc([
  '; comment header',
  '5; 2615 16800 SCHEMA - core postgres',
  '215; 1259 16805 TABLE core location postgres',
  '216; 1259 16810 SEQUENCE core location_id_seq postgres',
  '217; 0 0 SEQUENCE OWNED BY core location_id_seq postgres',
  '3012; 0 16805 TABLE DATA core location postgres',
  '400; 1259 16999 MATERIALIZED VIEW core mv_x postgres',
  '401; 0 16999 MATERIALIZED VIEW DATA core mv_x postgres',
].join('\n'));
eq(toc.tables.map((t) => `${t.schema}.${t.name}`), ['core.location'], 'TABLE rows only');
ok(toc.schemas.includes('core'), 'schema "core" captured');
ok(!toc.schemas.some((s) => ['OWNED', 'SET', 'DATA', '-'].includes(s)),
  `no bogus schema tokens (got [${toc.schemas.join(', ')}])`);

console.log('\n── setBackupConfig round-trip (persists on pool_config) ──');
let projId;
try {
  projId = (await one(
    `INSERT INTO project (name, repo_root, main_branch, db_name, db_user)
       VALUES ($1,$2,'main','zt','zt') RETURNING id`, [`zt-bktbl-${Date.now()}`, '/tmp/zt-bktbl'])).id;
  await q(`INSERT INTO pool_config (project_id) VALUES ($1)`, [projId]);

  const saved = await m.setBackupConfig({
    project: projId, backup_dir: null, backup_ctx: null,
    backup_interval_sec: 86400, max_backups: 14, backup_tables: ['core.location', 'core.location'],
  });
  eq(saved.backup_tables, ['core.location'], 'saved selection returned (deduped)');
  const row = await one(`SELECT backup_tables FROM pool_config WHERE project_id=$1`, [projId]);
  eq(row.backup_tables, ['core.location'], 'persisted to pool_config');

  const cleared = await m.setBackupConfig({
    project: projId, backup_dir: null, backup_ctx: null,
    backup_interval_sec: 86400, max_backups: 14, backup_tables: [],
  });
  ok(cleared.backup_tables == null, 'empty selection stored as NULL (full-database default)');

  let threw = false;
  try {
    await m.setBackupConfig({ project: projId, backup_interval_sec: 86400, max_backups: 14, backup_tables: ['bad;name'] });
  } catch { threw = true; }
  ok(threw, 'invalid table name is refused at config time');
} finally {
  if (projId) {
    await q(`DELETE FROM pool_config WHERE project_id=$1`, [projId]);
    await q(`DELETE FROM project WHERE id=$1`, [projId]);
  }
  await pool.end().catch(() => {});
}

console.log(`\n${failures === 0 ? 'ALL PASSED ✓' : `${failures} FAILURE(S) ✗`}`);
process.exit(failures === 0 ? 0 : 1);
