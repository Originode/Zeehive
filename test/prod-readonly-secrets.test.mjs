// A MANAGER'S PROD READ-ONLY ROLE — can read the fleet, cannot SELECT a stored credential.
//
// The prod read-only role a manager zee is bound to is minted by readonlyRoleSql() in
// server/src/lib/prod-readonly.js. Since the TKT-96-4127 fix the generated SQL:
//   1. still grants the reader SELECT on every table (a manager's day-to-day reads must keep
//      answering);
//   2. for each table that stores credentials, REVOKEs the blanket table-level SELECT and re-grants
//      SELECT on the NON-secret columns only, the column list computed from information_schema at
//      runtime;
//   3. therefore denies the secret columns themselves — provider_token.token,
//      environment_var.value, and xell.prod_ro_dsn — with `permission denied`.
//
// This is a REAL postgres test, both directions: it mints a throwaway role from the generated SQL
// against the database DATABASE_URL points at (a clone with the full schema), connects as that role,
// and asserts `permission denied` for every secret column AND that a manager's normal reads (xell,
// zee, work_item, ticket, provider_token, environment_var and the *_hint / is_secret columns)
// still answer. Then it runs dropProdReaderSql — the exact SQL the reaper runs — and asserts the
// role is GONE (pg_roles has no row), which is the direction that used to fail: the old drop path
// left every reaped manager's role on the cluster.
//
// It prints no credential VALUE at any point — only whether the permission is present or refused.
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { pool } from '../server/src/db/pool.js';
import { readonlyRoleSql, dropProdReaderSql, roRoleName } from '../server/src/lib/prod-readonly.js';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

const dbUrl = new URL(url);
const dbName = dbUrl.pathname.replace(/^\//, '');
const owner = decodeURIComponent(dbUrl.username);
const tag = randomUUID().slice(0, 8).replace(/[^a-z0-9]/g, '');
const role = roRoleName(`test-${tag}`);          // zee_ro_test_<tag> — manager-shaped
const password = `pw-${randomBytes(8).toString('base64url')}`;
const readerDsn = `postgresql://${role}:${encodeURIComponent(password)}@${dbUrl.hostname}${dbUrl.port ? `:${dbUrl.port}` : ''}/${dbName}`;

// The columns the role must be DENIED — every stored credential the fix removes.
const DENIED = [
  { table: 'provider_token',       col: 'token' },
  { table: 'environment_var',      col: 'value' },
  { table: 'xell',                 col: 'prod_ro_dsn' },
];

// A manager's NORMAL reads — the tables a prod-read-only manager lives in, selecting the columns it
// legitimately reads (never a stored credential). Must still answer after the fix.
const NORMAL_READS = [
  { table: 'xell',                 cols: ['id', 'slug', 'status'] },
  { table: 'zee',                  cols: ['id', 'status'] },
  { table: 'work_item',            cols: ['id', 'title', 'status'] },
  { table: 'ticket',               cols: ['id', 'title', 'status'] },
  { table: 'provider_token',       cols: ['id', 'provider', 'token_hint', 'last_used_at'] },
  { table: 'environment_var',      cols: ['id', 'name', 'is_secret'] },
];

let reader = null;
try {
  // 1. The generated SQL — what would run on production, read without running it.
  console.log('readonlyRoleSql: the minted role is SELECT-only AND denies the stored credentials');
  const sql = readonlyRoleSql(role, password, dbName, owner);
  ok(/GRANT SELECT ON ALL TABLES/.test(sql), 'table-level SELECT is still granted (normal reads)');
  ok(/GRANT SELECT \(/.test(sql) && !/GRANT (INSERT|UPDATE|DELETE|ALL)\b/.test(sql),
     'only column-level SELECT is re-granted (no write, no ALL)');

  // 2. Mint it for real, as the owner, on the live clone/sandbox — TWICE, because the bind re-runs
  // this SQL on every manager bind and it must be idempotent.
  await pool.query(sql);
  await pool.query(sql);
  console.log(`  minted ${role} on ${dbName} (owner ${owner}), re-ran cleanly`);

  // 3. Connect AS the minted role.
  reader = new pg.Client({ connectionString: readerDsn });
  await reader.connect();

  // 4. The DENIED direction: every secret column raises permission denied.
  for (const { table, col } of DENIED) {
    let err = null;
    try { await reader.query(`SELECT ${col} FROM ${table} LIMIT 1`); } catch (e) { err = e; }
    ok(err && /permission denied/.test(err.message),
       `SELECT ${table}.${col} is refused (${err ? err.message.split('\n')[0].trim() : 'NO ERROR'})`);
  }

  // 5. The ALLOWED direction: a manager's normal reads still answer.
  for (const { table, cols } of NORMAL_READS) {
    let err = null;
    try { await reader.query(`SELECT ${cols.join(', ')} FROM ${table} LIMIT 1`); } catch (e) { err = e; }
    ok(!err, `SELECT ${cols.join(', ')} FROM ${table} still answers${err ? ` — ${err.message.split('\n')[0].trim()}` : ''}`);
  }

  // 6. SELECT * on a secret-bearing table is refused (the column grant cannot cover every column).
  for (const table of ['provider_token', 'xell']) {
    let starErr = null;
    try { await reader.query(`SELECT * FROM ${table} LIMIT 1`); } catch (e) { starErr = e; }
    ok(!!starErr && /permission denied/.test(starErr.message || ''),
       `SELECT * FROM ${table} is refused (the blanket grant is gone)`);
  }

  // 7. The DROP direction: dropProdReaderSql — the exact SQL the reaper runs — must actually remove
  // the role. The OLD drop path (tables/schema/db only) left the role behind because readonlyRoleSql
  // also grants sequences and an ALTER DEFAULT PRIVILEGES entry; assert the role is GONE, not just
  // that the statement returned. End the reader's own session first so DROP ROLE is not racing it.
  await reader.end();
  reader = null;
  await pool.query(dropProdReaderSql(role, dbName, owner));
  const gone = await pool.query(`SELECT count(*)::int AS n FROM pg_roles WHERE rolname=$1`, [role]);
  ok(gone.rows[0].n === 0, `dropProdReaderSql removes the role (pg_roles count = ${gone.rows[0].n})`);

  console.log(fail ? `\n${fail} FAILED` : '\nall good');
} catch (e) {
  console.error('TEST ERROR:', e);
  fail++;
} finally {
  try { if (reader) await reader.end(); } catch { /* */ }
  // Owner cleanup via the production drop SQL (idempotent — IF EXISTS + no-op revokes). Best effort;
  // the sandbox dies with the cage either way.
  try { await pool.query(dropProdReaderSql(role, dbName, owner)); } catch { /* */ }
  await pool.end().catch(() => {});
}
process.exit(fail ? 1 : 0);
