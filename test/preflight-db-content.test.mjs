// A DATABASE THAT OPENS IS NOT A DATABASE THAT HAS ANYTHING IN IT.
//
// db-open (ticket #53) proves the BINDING: the DSN the queenzee wrote opens as the role it names.
// It says nothing about the CONTENTS, and the two failures were indistinguishable on every surface.
// A worker dispatched to exercise role/permission code was handed a throwaway db that opened
// perfectly, held no rows, and left its project's testkit with nothing to materialize — so the zee
// burned its turn finding out by hand, while its verdict read "opened and answered SELECT 1".
//
// The DATA is another project's (not this repo's to invent). What IS this repo's is that the verdict
// must SAY SO, and name the verb that refills it. So the preflight now reports a second named check,
// `db-data`, from one catalog read (relation sizes — no table scanned):
//   empty        → no application tables at all
//   schema-only  → the tables exist and not one of them holds a byte
//   data         → something is in there (row counts are the planner's estimates, or "not known")
// and it is `ok: true` with `warning: true` when empty, NEVER a failure: the binding is proven, the
// remedy (`zee db-catchup --restore`) is the ZEE's own verb, and under readiness_proof='required' a
// failed preflight would refuse dispatch to the one zee who can run it.
//
// Covered here (Part A/B are pure, Part C/D need a real database — DATABASE_URL):
//   • the levels: empty, schema-only, data — and a database with NO statistics (every reltuples -1,
//     which is what a fresh restore and a freshly migrated db look like) is 'data' by its relation
//     SIZE, never "empty"
//   • the remedy is the one that EXISTS for the coupling it is printed under (`--restore` is
//     db-isolated only; a clone and the shared dev db say what is actually true of them)
//   • an empty/schema-only database → db-data PASSES with a warning, the verdict is READY, and the
//     warning is on the xell row, in `zee status`, and in the zee's BRIEFING
//   • a database with data → no warning, and the briefing is unchanged (no per-xell section)
//   • a DSN that does NOT open → no content probe at all (nothing is dialled twice, and a
//     "could not open" is never dressed as "and it is empty")
//   • the probe is READ-ONLY and BOUNDED, and never throws
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }
process.env.PROVISION_MODE = 'simulate';
process.env.BUILD_MODE = 'simulate';
process.env.TKB_NOTIFY = '0';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

const { q, one, pool } = await import('../server/src/db/pool.js');
const { dbContentVerdict, DB_CONTENT_SQL } = await import('../server/src/lib/row-counts.js');
const { runPreflight, preflightXell, checkDbContent, contentRemedy } = await import('../server/src/lib/preflight.js');
const { proofConditionLine } = await import('../server/src/lib/proof-policy.js');
const { hiveStatus } = await import('../server/src/lib/hive-status.js');
const { briefing } = await import('../server/src/queenzee/intake.js');

const tag = randomUUID().slice(0, 8).replace(/[^a-z0-9]/g, '');
const dsnFor = (db) => String(new URL(url.replace(/^postgres(ql)?:/, 'http:')))
  .replace(/^http:/, 'postgresql:').replace(/\/[^/]*$/, `/${db}`);

// ── Part A: the reading (pure) ──────────────────────────────────────────────────────────────────
console.log('the content profile, as a pure reading of one catalog row');
const v0 = dbContentVerdict({ tables: 0, bytes: 0, est_rows: 0, unanalyzed: 0 });
ok(v0.level === 'empty', 'no application tables → empty');
const v1 = dbContentVerdict({ tables: 37, bytes: 0, est_rows: 0, unanalyzed: 0 });
ok(v1.level === 'schema-only', 'tables, none of them holding a byte → schema-only');
// THE ONE THAT MATTERS: a db that was restored/migrated has every reltuples -1 (no statistics), so an
// estimate-based probe reads 0 rows. Size catches it — this must never be reported as empty.
const v2 = dbContentVerdict({ tables: 37, bytes: 2719744, est_rows: 0, unanalyzed: 37 });
ok(v2.level === 'data' && v2.rows === null,
   'a full db with NO statistics is data, not empty — and its row count is UNKNOWN, never 0');
const v3 = dbContentVerdict({ tables: 37, bytes: 8192, est_rows: 2310, unanalyzed: 0 });
ok(v3.level === 'data' && v3.rows === 2310 && v3.estimated === true,
   'analyzed tables → data, with the planner estimate carried, marked as an estimate');

console.log('\nthe remedy names a verb that exists for the coupling it is printed under');
ok(/zee db-catchup --restore/.test(contentRemedy('db-isolated', 'schema-only')),
   'db-isolated → the restore verb, named');
ok(/not offered for a clone/.test(contentRemedy('db-clone', 'schema-only')),
   'db-clone → says the restore verb does not apply to it (it has no snapshot)');
ok(/SHARED dev database/.test(contentRemedy('db-shared-dev', 'empty')),
   'db-shared-dev → says it is the shared db, not this xell\'s copy');

// ── Part B: the probe against REAL databases ─────────────────────────────────────────────────────
// Throwaway databases INSIDE the database this test was pointed at (a xell's own db is throwaway by
// contract). Every one is dropped in the finally below.
const admin = new pg.Client({ connectionString: url });
await admin.connect();
const made = [];
async function makeDb(kind) {
  const name = `pf53_${tag}_${kind}`;
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
  } catch (e) {
    console.log(`  · cannot CREATE DATABASE here (${e.code || e.message}) — the real-database half is SKIPPED, `
      + 'the pure half above still ran');
    return null;
  }
  made.push(name);
  const dsn = dsnFor(name);
  const c = new pg.Client({ connectionString: dsn });
  await c.connect();
  if (kind === 'schema' || kind === 'rows') await c.query('CREATE TABLE t (i int)');
  if (kind === 'rows') await c.query('INSERT INTO t VALUES (1),(2),(3)');
  await c.end();
  return dsn;
}

const dsnEmpty = await makeDb('empty');
const dsnSchema = await makeDb('schema');
const dsnRows = await makeDb('rows');

if (dsnEmpty && dsnSchema && dsnRows) {
  console.log('\nthe probe reads three real databases: empty, schema-only, and one with rows');
  const e = await checkDbContent(dsnEmpty, { coupling: 'db-isolated' });
  ok(e?.warning === true && e.ok === true && e.skipped === false,
     'an EMPTY database (no tables) → db-data PASSES with a warning (never a failure)');
  ok(/NO application tables/.test(e.detail) && /zee db-catchup --restore/.test(e.detail),
     `…and it says so, and names the remedy (${e.detail.slice(0, 90)}…)`);

  const s = await checkDbContent(dsnSchema, { coupling: 'db-isolated' });
  ok(s?.warning === true && /SCHEMA-ONLY/.test(s.detail) && /1 application table\(s\)/.test(s.detail),
     'a SCHEMA-ONLY database (a table, no rows) → warned, with the count');

  const r = await checkDbContent(dsnRows, { coupling: 'db-isolated' });
  ok(r?.warning === undefined && r.ok === true && /holds data/.test(r.detail),
     `a database WITH rows → no warning (${r.detail})`);

  console.log('\nthe probe is READ-ONLY and BOUNDED');
  const relsBefore = (await admin.query(
    `SELECT count(*)::int AS n FROM pg_class WHERE relnamespace='public'::regnamespace`)).rows[0].n;
  await checkDbContent(dsnRows, { coupling: 'db-isolated' });
  const relsAfter = (await admin.query(
    `SELECT count(*)::int AS n FROM pg_class WHERE relnamespace='public'::regnamespace`)).rows[0].n;
  ok(relsAfter === relsBefore, `it created nothing (${relsBefore} relations before and after)`);
  const t0 = Date.now();
  const nothing = await checkDbContent('postgresql://zeehive@192.0.2.1:5432/zeehive', { timeout: 1000 });
  ok(nothing === null, 'an unreachable database → null (a probe that cannot run asserts NOTHING, never "empty")');
  ok(Date.now() - t0 < 20000, `…and it comes back (${Date.now() - t0}ms, bound 1000ms)`);
}

// ── Part C: through the REAL preflight, on a xell row ────────────────────────────────────────────
let pid = null;
try {
  pid = (await one(
    `INSERT INTO project (name, repo_root, db_user, db_name) VALUES ($1,$2,'zeehive','zeehive') RETURNING id`,
    [`pf53-dc-${tag}`, process.cwd()])).id;
  const xoid = (await one(`INSERT INTO xource (project_id, ref) VALUES ($1,'master') RETURNING id`, [pid])).id;
  const mkXell = async (name, { coupling = 'db-isolated', connRef = null } = {}) => {
    const slug = `pf53-dc-${tag}-${name}`;
    const x = await one(
      `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status, is_pooled,
                         zee_type, db_coupling)
         VALUES ($1,$2,$3,$4,$5,'ready',true,'worker',$6) RETURNING *`,
      [pid, xoid, slug, `spinoff/${slug}`, `/tmp/pf53/${slug}`, coupling]);
    if (connRef !== null) {
      const c = await one(
        `INSERT INTO container (project_id, role, tier, isolation, name, docker_ctx, internal_port,
                                host_port, conn_ref, owner_xell_id)
           VALUES ($1,'db','spinoff','per-xell',$2,'default',5432,15432,$3,$4) RETURNING id`,
        [pid, `pf53_dc_${tag}_${name}_db`, connRef, x.id]);
      await q(`INSERT INTO xell_uses_container (xell_id, container_id, relation) VALUES ($1,$2,'owns')`,
              [x.id, c.id]);
    }
    return x;
  };

  if (dsnEmpty) {
    console.log('\nthe preflight on a xell whose throwaway db is EMPTY');
    const x = await mkXell('empty', { connRef: dsnEmpty });
    const v = await runPreflight(x.id);
    const open = v.checks.find((c) => c.check === 'db-open');
    const data = v.checks.find((c) => c.check === 'db-data');
    ok(v.ok === true && v.error === null,
       'the verdict is READY — an empty database is not a broken binding (the zee can still run the remedy)');
    ok(open?.ok === true && !open.skipped, 'db-open still passed — the two facts are separate, and both are said');
    ok(data?.ok === true && data.warning === true, 'db-data passed WITH a warning — a finding, not a refusal');
    const row = await one(`SELECT * FROM xell WHERE id=$1`, [x.id]);
    ok(row.preflight_error === null && (row.preflight_checks || []).some((c) => c.check === 'db-data' && c.warning),
       'the xell row carries the warning in preflight_checks (what `zee status` reads)');
    ok(hiveStatus(row, { preflightFailed: !!row.preflight_error }) === 'vac-ready',
       'and the hexagon still reads ready — a warning must not condemn a xell');
    const line = proofConditionLine(row);
    ok(/db-data:/.test(line || '') && /zee db-catchup --restore/.test(line || ''),
       'and the ZEE\'s briefing carries it, with the remedy');
    ok(!/FAILING/.test(line || ''), '…worded as a warning, never as a preflight FAILURE');
    // …through the REAL briefing composer, not just the pure renderer: the row → the SELECT → the
    // block → the text a dispatched zee actually wakes up to.
    const b = await briefing(x.id, { id: null, name: 'test-zee', viewer_url: null }, 'do the thing');
    ok(b.includes('Your own proof state') && b.includes('zee db-catchup --restore'),
       'the dispatched zee\'s BRIEFING carries the empty-db warning and the remedy');
    ok(b.indexOf('Your own proof state') < b.indexOf('## Your task'),
       '…positioned above the task, like the conditions block');
  }

  if (dsnRows) {
    console.log('\nthe preflight on a xell whose db HAS data — nothing is said');
    const x = await mkXell('rows', { connRef: dsnRows });
    const v = await runPreflight(x.id);
    const data = v.checks.find((c) => c.check === 'db-data');
    ok(v.ok === true && data?.ok === true && !data.warning, 'db-data passes clean, with the counts on it');
    const row = await one(`SELECT * FROM xell WHERE id=$1`, [x.id]);
    ok(proofConditionLine(row) === null, 'a healthy xell\'s briefing is unchanged (no per-xell section at all)');
  }

  console.log('\na DSN that does NOT open is never probed for content');
  const bad = await mkXell('bad', { connRef: url.replace(/^(postgres(?:ql)?:\/\/)[^@/]*@/, `$1nosuchrole_${tag}@`) });
  const bv = await preflightXell(bad.id);
  ok(bv.ok === false && !bv.checks.some((c) => c.check === 'db-data'),
     'db-open failed and NO db-data check was produced — "could not open" is never dressed as "and it is empty"');
} finally {
  if (pid) {
    await q(`DELETE FROM xell_uses_container WHERE xell_id IN (SELECT id FROM xell WHERE project_id=$1)`, [pid]);
    await q(`DELETE FROM container WHERE project_id=$1`, [pid]);
    await q(`DELETE FROM xell WHERE project_id=$1`, [pid]);
    await q(`DELETE FROM xource WHERE project_id=$1`, [pid]);
    await q(`DELETE FROM project WHERE id=$1`, [pid]);
  }
  // The throwaway databases this test created — dropped, none left behind.
  for (const name of made) {
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch((e) =>
      console.log(`  · could not drop ${name}: ${e.message}`));
  }
  await admin.end().catch(() => {});
  await pool.end();
}

console.log(`\nDB_CONTENT_SQL excluded nothing by accident: ${/pg_depend/.test(DB_CONTENT_SQL) ? 'extension-owned relations are excluded' : '✗ EXTENSION RULE MISSING'}`);
console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
