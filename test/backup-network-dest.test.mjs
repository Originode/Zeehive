// Backups: registry-identity container resolution (regression 2), the meaningful dump guard
// (regression 3), and the network-destination config guard (regression 1 + requirement 7).
//
// Runs the REAL lib (server/src/queenzee/maintenance.js) against this xell's isolated postgres.
// What it CANNOT do in a cxell: reach a real docker DAEMON via the CLI (there is none here). So
// the docker-facing transfer is proven separately (test/nas-write-proof.mjs, which uses the HTTP
// API). Here we prove the DECISIONS — which container, is this dump real, is this destination
// usable — which is where all three regressions actually lived.
process.env.MAINTENANCE_MODE = process.env.MAINTENANCE_MODE || 'simulate';

const { q, one, pool } = await import('../server/src/db/pool.js');
const m = await import('../server/src/queenzee/maintenance.js');
// maintenance now RESOLVES containers through the SHARED registry-identity decision that
// calm-summit-65c3fb centralized in lib/xell-db.js (reconciled, not a parallel copy). Prove the
// regression-2 scenario against that shared decision — the same one maintenance calls internally.
const { pickDbContainer } = await import('../server/src/lib/xell-db.js');

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };
const threw = async (fn, re, msg) => {
  try { await fn(); ok(false, `${msg} (did NOT throw)`); }
  catch (e) { ok(re.test(e.message), `${msg} — threw: ${e.message.slice(0, 110)}`); }
};

// The EXACT old resolver, verbatim from git history, to prove it picks the wrong container.
const oldResolve = (names, modeledName) => {
  if (names.includes(modeledName)) return modeledName;
  return names.find((n) => n.startsWith(modeledName + '_')) || null;
};

try {
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n── REGRESSION 2: the wrong (empty) database was dumped ──');
  // The live situation: on the mardale-prod context two containers share the omnibiz_db_prod_
  // prefix. docker ps lists NEWEST first, so the dev clone leads.
  const psNewestFirst = ['omnibiz_db_prod_dev_local_mardale_prod', 'omnibiz_db_prod_v184'];
  ok(oldResolve(psNewestFirst, 'omnibiz_db_prod') === 'omnibiz_db_prod_dev_local_mardale_prod',
    'OLD resolver picks the dev clone (7.7 MB, no core schema) — the bug, reproduced from ps order');

  // The registry row carries identity the name shape cannot: the prod db publishes 5432. The
  // shared decision takes running = [{name, hostPorts:Set}] + {name, host_port} + the exclusion
  // set of names that belong to OTHER registry rows (the clone is one).
  const running = [
    { name: 'omnibiz_db_prod_dev_local_mardale_prod', hostPorts: new Set([32768]) },
    { name: 'omnibiz_db_prod_v184', hostPorts: new Set([5432]) },
  ];
  const otherDbNames = new Set(['omnibiz_db_prod_dev_local_mardale_prod']);   // the clone owns its own row
  const picked = pickDbContainer(running, { name: 'omnibiz_db_prod', host_port: 5432 }, otherDbNames);
  ok(picked.name === 'omnibiz_db_prod_v184' && !picked.ambiguous && !picked.unresolved,
    `shared pickDbContainer picks omnibiz_db_prod_v184 by host_port 5432 — the REAL prod db (via=${picked.via})`);

  ok(pickDbContainer(running, { name: 'omnibiz_db_prod_dev_local_mardale_prod', host_port: 32768 }).name
    === 'omnibiz_db_prod_dev_local_mardale_prod',
    'the clone row (port 32768) still resolves to the clone — identity, not name shape');

  console.log('\n── the versioned case the heuristic existed for still works ──');
  // Only the real prod running, no clone: omnibiz_db_prod → omnibiz_db_prod_v184 by port.
  ok(pickDbContainer([{ name: 'omnibiz_db_prod_v184', hostPorts: new Set([5432]) }],
    { name: 'omnibiz_db_prod', host_port: 5432 }).name === 'omnibiz_db_prod_v184',
    'omnibiz_db_prod → omnibiz_db_prod_v184 by port');
  // Same, with NO host_port recorded: fall back to a UNIQUE name-shape match (not the first guess).
  ok(pickDbContainer([{ name: 'omnibiz_db_prod_v184', hostPorts: new Set() }],
    { name: 'omnibiz_db_prod', host_port: null }).name === 'omnibiz_db_prod_v184',
    'null host_port → single versioned match still resolves');

  console.log('\n── it now REFUSES/flags rather than guessing (maintenance turns these into a FAIL) ──');
  // When the ONLY running container is a sibling row (the clone), it is excluded and nothing is
  // left to pick → unresolved:true (the shared decision returns the logical name, flagged). This
  // is the case where the old code would have prefix-matched the clone and dumped it; maintenance
  // now treats unresolved as a hard FAILURE — it refuses to back up a database it can't identify.
  const onlyClone = pickDbContainer(
    [{ name: 'omnibiz_db_prod_dev_local_mardale_prod', hostPorts: new Set([32768]) }],
    { name: 'omnibiz_db_prod', host_port: 5432 }, otherDbNames);
  ok(onlyClone.unresolved === true,
    'only the sibling clone is running → unresolved (excluded, not dumped); maintenance FAILS the backup');
  const ambiguous = pickDbContainer([
    { name: 'omnibiz_db_prod_v184', hostPorts: new Set() },
    { name: 'omnibiz_db_prod_dev_local_mardale_prod', hostPorts: new Set() },
  ], { name: 'omnibiz_db_prod', host_port: null });
  ok(ambiguous.ambiguous === true,
    'two name matches + no port to disambiguate → ambiguous (maintenance FAILS rather than coin-toss)');

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n── REGRESSION 3: a valid archive of the WRONG database must FAIL ──');
  const GB = 1_227_790_090;   // the last real omnibiz dump
  const KB = 7_643;           // the empty ledger-only dump that slipped through
  threw(() => m.assertDumpSize(KB, GB), /collapse/,
    '7,643 B against a 1.2 GB predecessor → FAILS on the size collapse');
  ok(m.assertDumpSize(GB + 5_000_000, GB).compared === true, 'normal growth passes the size guard');
  ok(m.assertDumpSize(Math.floor(GB * 0.8), GB).compared === true, 'an ordinary 20% shrink still passes');
  ok(m.assertDumpSize(GB, null).compared === false, 'first-ever backup: no baseline, handled explicitly (not skipped silently)');

  // The 7 KB dump's actual TOC: only the migration ledger, nothing else.
  const emptyToc = `;\n; Archive created at 2026-07-23\n;\n215; 1259 16390 TABLE public zeehive_migrations postgres\n3001; 0 16390 TABLE DATA public zeehive_migrations postgres\n`;
  const realToc = `;\n;\n210; 1259 16805 TABLE core invoices postgres\n2999; 0 16805 TABLE DATA core invoices postgres\n211; 1259 16820 TABLE core customers postgres\n9; 2615 16 SCHEMA - core postgres\n`;
  const emptyParsed = m.parseDumpToc(emptyToc);
  const realParsed = m.parseDumpToc(realToc);
  ok(emptyParsed.tables.length === 1 && emptyParsed.tables[0].name === 'zeehive_migrations',
    'parseDumpToc: empty dump = only zeehive_migrations');
  ok(realParsed.schemas.includes('core') && realParsed.tables.length === 2,
    'parseDumpToc: real dump = schema core + application tables');
  threw(() => m.assertDumpContent(emptyParsed, null), /no application tables|EMPTY/,
    'content guard: ledger-only dump → FAILS ("this is an EMPTY database")');
  ok(m.assertDumpContent(realParsed, null).appTableCount === 2, 'content guard: real dump passes');
  threw(() => m.assertDumpContent({ schemas: ['public'], tables: [{ schema: 'public', name: 'invoices' }], entryCount: 2 },
    { schemas: ['core', 'public'] }), /missing schema/,
    'content guard: a dump that LOST schema core vs the last good backup → FAILS');

  // REGRESSION: a legacy ruler recorded by the PRE-FIX parseDumpToc has bogus "schema" tokens
  // ('-', 'OWNED', 'SET', 'DATA' from SCHEMA/SEQUENCE OWNED BY/SEQUENCE SET/MATERIALIZED VIEW DATA
  // rows). The fixed parser emits none of them, so without artifact-stripping the continuity check
  // rejected EVERY full backup as "missing schema(s) [-, OWNED, SET, DATA]" — db backups failing again.
  ok(m.assertDumpContent(realParsed,
    { schemas: ['core', '-', 'OWNED', 'SET', 'DATA'], table_count: 2 }).comparedSchemas === true,
    'content guard: a CLEAN dump vs a legacy polluted ruler → PASSES (artifacts stripped)');
  // …but a genuine loss hiding among the artifacts is still caught (only the real schema is missed).
  threw(() => m.assertDumpContent(realParsed,
    { schemas: ['core', 'audit', '-', 'OWNED'], table_count: 3 }), /missing schema\(s\) \[audit\]/,
    'content guard: real schema loss beside legacy artifacts → still FAILS on the real one only');
  // A post-fix ruler carries tables[]; schemas are derived from it (exact), loss still caught.
  threw(() => m.assertDumpContent(realParsed,
    { schemas: ['core', 'audit'], tables: ['core.invoices', 'audit.log'] }),
    /missing schema\(s\) \[audit\]/,
    'content guard: tables[]-based ruler that lost schema audit → FAILS');

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n── REGRESSION 1 / requirement 7: destination config is honest ──');
  const projId = (await one(
    `INSERT INTO project (name, repo_root, main_branch) VALUES ($1,$2,'main') RETURNING id`,
    [`zt-bkcfg-${Date.now()}`, '/tmp/zt-bkcfg'])).id;
  await q(`INSERT INTO pool_config (project_id) VALUES ($1)`, [projId]);

  await threw(() => m.setBackupConfig({ project: projId, backup_ctx: 'ugreen-nas', backup_dir: null,
    backup_interval_sec: 86400, max_backups: 14 }), /needs a backup location/,
    'a context with no directory is refused up front');
  await threw(() => m.setBackupConfig({ project: projId, backup_ctx: 'no-such-context-xyz',
    backup_dir: '/volume3/maki/Backups/Omnibiz/db', backup_interval_sec: 86400, max_backups: 14 }),
    /not reachable/, 'an UNREACHABLE context is refused (no silent local fallback — regression 1)');

  // local (no ctx) still saves, and stores backup_ctx NULL
  const local = await m.setBackupConfig({ project: projId, backup_dir: '/tmp/zt-local', backup_ctx: null,
    backup_interval_sec: 86400, max_backups: 7 });
  ok(local.backup_ctx == null && local.backup_dir === '/tmp/zt-local', 'local destination saves (backup_ctx NULL)');

  console.log('\n── requirement 5: retention deletes the right ROWS regardless of destination ──');
  // 3 finished remote snapshots; keep 1 → 2 pruned. (remote file removal is best-effort docker;
  // here we assert the bookkeeping — rows removed, count returned — which is what drives the UI.)
  for (let i = 0; i < 3; i++) {
    await q(`INSERT INTO db_snapshot (project_id, source, dump_path, dest_ctx, size_bytes, status, mode, taken_at)
             VALUES ($1,'prod',$2,'ugreen-nas',$3,'finished','real', now() - ($4||' min')::interval)`,
      [projId, `/volume3/maki/Backups/Omnibiz/db/x${i}.dump`, 1000 + i, i]);
  }
  const pruned = await m.housekeepBackups(projId, 1);
  ok(pruned === 2, 'housekeep prunes 2 of 3 remote snapshots (keep 1)');
  const left = await q(`SELECT id FROM db_snapshot WHERE project_id=$1 AND status='finished'`, [projId]);
  ok(left.length === 1, 'exactly one remote snapshot row remains');

  await q(`DELETE FROM db_snapshot WHERE project_id=$1`, [projId]);
  await q(`DELETE FROM pool_config WHERE project_id=$1`, [projId]);
  await q(`DELETE FROM project WHERE id=$1`, [projId]);

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n── the dump window scales with the SOURCE size, never below the old 30-min floor ──');
  // The live failure that motivated it: omnibiz grew to ~5 GB, and a full dump at ~1.5-3 MB/s needs
  // 30-60 min, but the fixed 30-minute stream window killed EVERY attempt mid-stream (live partials
  // of 4.9-5.07 GB left on the destination). The window is now sized from the measured source size.
  const FLOOR = 30 * 60 * 1000, CEILING = 3 * 60 * 60 * 1000;
  const GiB = 1024 * 1024 * 1024;
  ok(m.streamTimeoutFor(null) === FLOOR, 'unknown source size (probe failed) → the old 30-min floor, dump still runs');
  ok(m.streamTimeoutFor(0) === FLOOR, 'a zero/empty probe result → the floor, not a zero-second window');
  ok(m.streamTimeoutFor(1 * GiB) === 2 * 1024 * 1000, 'a 1 GiB DB → ~34 min (size/1MB/s × 2 margin, above the floor)');
  ok(m.streamTimeoutFor(2 * GiB) === 4 * 1024 * 1000, 'a 2 GiB DB (the old omnibiz size) → ~68 min');
  // THE regression: a 5 GiB DB must get a ~2.8 h window, NOT the 30 min that killed every live retry.
  ok(m.streamTimeoutFor(5 * GiB) === 10 * 1024 * 1000,
    `a 5 GiB DB (today's omnibiz) → ${10 * 1024 / 60} min, past what the fixed 30-min window allowed`);
  ok(m.streamTimeoutFor(30 * GiB) === CEILING, 'a huge DB is capped at the 3 h ceiling (a flowing-but-stuck transfer still dies)');
  ok(m.streamTimeoutFor(30 * GiB) > m.streamTimeoutFor(5 * GiB), 'the window is monotonic in size up to the cap');
} finally {
  await pool.end().catch(() => {});
}
console.log(`\n${failures === 0 ? 'ALL PASSED ✓' : `${failures} FAILURE(S) ✗`}`);
process.exit(failures === 0 ? 0 : 1);
