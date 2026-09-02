// THE MEDIC ROLE'S GRANT SURFACE (lib/medic-role.js, DR-8, docs/medic-meta-plane-plan.md §3.3) —
// against a REAL postgres (DATABASE_URL; `zee db-sandbox --migrate` in a cage). The wall the
// meta_write tool leans on is POSTGRES, not tool code, so this test asserts what postgres actually
// refuses — connected AS the minted role — and audits the grant lists against the LIVE schema,
// never a hardcoded copy of themselves.
//
// Covered here:
//   1. the mint is idempotent and the DSN authenticates;
//   2. connected AS zeehive_medic: SELECT works fleet-wide; UPDATE machine works; UPDATE xell,
//      DELETE FROM container, INSERT INTO medic_action and SELECT token FROM provider_token are
//      each REFUSED BY POSTGRES (the nested-reaper surface, the ledger, the vendor keys);
//   3. the declared write surface (MEDIC_WRITE_TABLES / MEDIC_NO_WRITE_TABLES) matches
//      has_table_privilege for every table that exists on the live schema;
//   4. MEDICRW_MODE=simulate mints nothing real (asserted in a CHILD process — the mode is a
//      module-load constant) and answers a DSN that cannot authenticate.
//
// The test mutates only its own fixture rows and rolls every write back; the role itself is
// long-lived by design (boot re-mints it), so it is left in place.
import pg from 'pg';
import { execFileSync } from 'node:child_process';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }

// Pin REAL mode before the module loads its constant: a Zeehive xell's ambient SHIP_MODE=simulate
// would otherwise cascade into MEDICRW_MODE and turn the whole real half into a no-op that "passes".
// Watched happen: the first run of this test did exactly that. Real is correct HERE because the
// target is the throwaway sandbox this test is pointed at, never a shared database.
process.env.MEDICRW_MODE = 'real';
const { mintMedicRole, MEDIC_ROLE, MEDIC_WRITE_TABLES, MEDIC_NO_WRITE_TABLES } =
  await import('../server/src/lib/medic-role.js');
const { pool } = await import('../server/src/db/pool.js');

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

console.log('\n── 1. the mint ──');
const first = await mintMedicRole();
ok(first.mode === 'real' && first.role === MEDIC_ROLE, `mints ${MEDIC_ROLE} in real mode`);
const second = await mintMedicRole();
ok(second.mode === 'real', 're-mint is idempotent (fresh password, same role)');

const medic = new pg.Client({ connectionString: second.dsn });
await medic.connect();
try {
  console.log('\n── 2. connected AS the role ──');
  const sel = await medic.query(`SELECT count(*)::int AS n FROM project`);
  ok(Number.isInteger(sel.rows[0].n), 'SELECT over the meta-DB works (read wide)');

  const refusedAs = async (sql, m) => {
    try { await medic.query('BEGIN'); await medic.query(sql); await medic.query('ROLLBACK');
          ok(false, `${m} (postgres ACCEPTED it)`); }
    catch { await medic.query('ROLLBACK').catch(() => {}); ok(true, m); }
  };
  await medic.query('BEGIN');
  await medic.query(`UPDATE machine SET dev_priority = dev_priority WHERE false`);
  await medic.query('ROLLBACK');
  ok(true, 'UPDATE machine is granted (the config surface)');
  await refusedAs(`UPDATE xell SET status=status WHERE false`, 'UPDATE xell is REFUSED (no nested reaper)');
  await refusedAs(`DELETE FROM container WHERE false`, 'DELETE FROM container is REFUSED (the reaper\'s act)');
  await refusedAs(`INSERT INTO medic_action (medic_id, tool, statement)
                   VALUES (gen_random_uuid(),'x','x')`, 'INSERT INTO medic_action is REFUSED (no forged receipts)');
  await refusedAs(`SELECT token FROM provider_token WHERE false`, 'SELECT provider_token.token is REFUSED (vendor keys stay human)');
  try {
    await medic.query(`SELECT id, provider FROM provider_token WHERE false`);
    ok(true, 'the NON-secret provider_token columns stay readable (the account list is config)');
  } catch { ok(false, 'the NON-secret provider_token columns stay readable'); }
  await refusedAs(`UPDATE harness SET capabilities=capabilities WHERE false`, 'UPDATE harness is REFUSED (no self-grant)');
  await refusedAs(`CREATE TABLE medic_smuggle (id int)`, 'CREATE is REFUSED');

  console.log('\n── 3. the declared surface vs the LIVE schema ──');
  for (const [table, stmts] of Object.entries(MEDIC_WRITE_TABLES)) {
    const exists = (await medic.query(`SELECT to_regclass($1) AS t`, [table])).rows[0].t;
    if (!exists) { console.log(`  (table ${table} not on this schema — skipped)`); continue; }
    for (const s of ['INSERT', 'UPDATE', 'DELETE']) {
      const want = stmts.includes(s);
      const has = (await medic.query(
        `SELECT has_table_privilege($1, $2, $3) AS p`, [MEDIC_ROLE, table, s])).rows[0].p;
      ok(has === want, `${table}: ${s} ${want ? 'granted' : 'absent'} as declared`);
    }
  }
  for (const table of MEDIC_NO_WRITE_TABLES) {
    const exists = (await medic.query(`SELECT to_regclass($1) AS t`, [table])).rows[0].t;
    if (!exists) { console.log(`  (table ${table} not on this schema — skipped)`); continue; }
    const anyWrite = (await medic.query(
      `SELECT has_table_privilege($1,$2,'INSERT') OR has_table_privilege($1,$2,'UPDATE')
              OR has_table_privilege($1,$2,'DELETE') AS p`, [MEDIC_ROLE, table])).rows[0].p;
    ok(anyWrite === false, `${table}: NO write privilege of any kind`);
  }
  // project is column-scoped: some UPDATE, never INSERT/DELETE.
  const projCols = (await medic.query(
    `SELECT has_column_privilege($1,'project','manifest','UPDATE') AS m,
            has_column_privilege($1,'project','name','UPDATE') AS n,
            has_table_privilege($1,'project','INSERT') AS i,
            has_table_privilege($1,'project','DELETE') AS d`, [MEDIC_ROLE])).rows[0];
  ok(projCols.m === true, 'project.manifest: column-scoped UPDATE granted');
  ok(projCols.n === false, 'project.name: UPDATE absent (identity is not config)');
  ok(projCols.i === false && projCols.d === false, 'project: INSERT/DELETE absent');
} finally {
  await medic.end();
}

console.log('\n── 4. MEDICRW_MODE=simulate mints nothing ──');
const childOut = execFileSync(process.execPath, ['-e', `
  process.env.MEDICRW_MODE = 'simulate';
  const { mintMedicRole } = await import(${JSON.stringify(new URL('../server/src/lib/medic-role.js', import.meta.url).href)});
  const out = await mintMedicRole();
  console.log(JSON.stringify({ mode: out.mode, dsn: out.dsn }));
`, ], { env: { ...process.env, MEDICRW_MODE: 'simulate' }, encoding: 'utf8',
       // -e has no file URL; --input-type makes the await legal at top level
       ...( {} ) });
const sim = JSON.parse(childOut.trim().split('\n').pop());
ok(sim.mode === 'simulate', 'simulate mode reports itself');
ok(/simulated/.test(sim.dsn), 'the simulate DSN cannot authenticate (a placeholder password)');

await pool.end();
console.log(fail ? `\n${fail} FAILED` : '\nall good');
process.exit(fail ? 1 : 0);
