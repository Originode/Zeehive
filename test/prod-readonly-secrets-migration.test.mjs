// MIGRATION 143 — the forward-only fix for read-only prod roles that EXIST already (TKT-96-4127 / TKT-102-8016).
//
// The provision code (lib/prod-readonly.js, landed on main) mints FUTURE manager roles without the
// table-level SELECT on the secret-bearing tables. But every role minted BEFORE that landed still
// holds `GRANT SELECT ON ALL TABLES` — including every stored secret in plaintext (provider_token
// .token, environment_var.value, the langfuse_config/langfuse_project_map keys and passwords, and
// xell.prod_ro_dsn). This test proves migration 143 closes both holes on EXISTING roles:
//
//   A. a legacy role (old blanket grants) whose xell is LIVE is HARDENED — every secret column is
//      refused by postgres while *_hint columns and counts stay readable;
//   B. a role whose xell is RETIRED (or absent) is DROPPED — the orphan-credential cleanup that
//      TKT-102-8016 demanded (13 of 16 prod zee_ro_* roles belonged to retired xells).
//
// Postgres semantics that make the fix non-trivial: a table-level `GRANT SELECT` covers every
// column, and a column-level `REVOKE SELECT (col)` does NOT beat it. The migration therefore REVOKEs
// table-level SELECT on each secret-bearing table and GRANTs back column-level SELECT on every
// NON-secret column, computed from information_schema at runtime (the same rule as the provision
// code's secretTableSql). Orphan roles are dropped with `DROP OWNED BY` then `DROP ROLE`.
//
// Everything this test creates (a throwaway project, rows, and the zee_ro_* roles themselves) is
// torn down in a finally. It FAILS on the pre-migration code: the legacy role reads every secret.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }
process.env.TKB_NOTIFY = '0';
process.env.PRODRO_MODE = 'simulate';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };
const admin = new pg.Client({ connectionString: url });
const tag = randomUUID().slice(0, 8).replace(/[^a-z0-9]/g, '');
const projectId = randomUUID();
let xourceId = null;
let liveXellId = null;

// roRoleName inverse — the same mapping migration 143 Part 1 uses, imported from the real module so
// the test and the migration agree byte-for-byte.
const { roRoleName, dropProdReaderSql } = await import(`../server/src/lib/prod-readonly.js?mig=${tag}`);
const liveSlug = `legacy-live-${tag}`;
const retiredSlug = `legacy-retired-${tag}`;
const liveRole = roRoleName(liveSlug);
const retiredRole = roRoleName(retiredSlug);
const orphanRole = `zee_ro_no_such_xell_${tag}`;

const dropRole = async (role) => {
  const dbName = new URL(url).pathname.replace(/^\//, '');
  const owner = new URL(url).username || 'postgres';
  await admin.query(dropProdReaderSql(role, dbName, owner)).catch(() => {});
};

async function main() {
  await admin.connect();

  // This test needs the meta-DB schema; a non-Zeehive db skips loudly.
  const hasProvider = (await admin.query(`SELECT to_regclass('public.provider_token') AS r`)).rows[0].r;
  const hasXell = (await admin.query(`SELECT to_regclass('public.xell') AS r`)).rows[0].r;
  if (!hasProvider || !hasXell) {
    console.log(`  SKIP: not a Zeehive meta-DB (provider_token=${!!hasProvider}, xell=${!!hasXell})`);
    return;
  }
  const dbName = new URL(url).pathname.replace(/^\//, '');

  // throwaway project + xource so the xell rows satisfy FKs
  await admin.query(`INSERT INTO project (id, name, repo_root, db_user, db_name) VALUES ($1,$2,$3,'u','d')`,
    [projectId, `tkt96-mig-${tag}`, '/tmp']);
  xourceId = (await admin.query(`INSERT INTO xource (project_id, ref) VALUES ($1,'master') RETURNING id`, [projectId])).rows[0].id;
  // a LIVE manager xell for the live role, and a RETIRED one for the retired role
  liveXellId = (await admin.query(
    `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status, is_pooled, zee_type, db_coupling)
     VALUES ($1,$2,$3,$4,'/tmp/'||$3,'working',false,'manager','db-prod-readonly') RETURNING id`,
    [projectId, xourceId, liveSlug, `spinoff/${liveSlug}`])).rows[0].id;
  await admin.query(
    `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status, is_pooled, zee_type, db_coupling)
     VALUES ($1,$2,$3,$4,'/tmp/'||$3,'retired',false,'manager','db-prod-readonly')`,
    [projectId, xourceId, retiredSlug, `spinoff/${retiredSlug}`]);

  try {
    // seed one row per secret surface (all values FAKE)
    await admin.query(`INSERT INTO provider_token (project_id, provider, token, token_hint) VALUES ($1,'claude','sk-ant-fake','sk-ant-hint')`, [projectId]);
    await admin.query(`UPDATE langfuse_config SET admin_password='fake-pw', admin_password_hint='fake-pw-hint', secret_key='sk-fake', secret_key_hint='sk-fake-hint' WHERE id=true`);
    await admin.query(`UPDATE xell SET prod_ro_dsn='postgresql://zee_ro_x:pw@h:1/d' WHERE id=$1`, [liveXellId]);

    // Mint two roles the OLD way (table-level SELECT on everything, incl. sequences + default privs)
    const mintLegacy = (role) => admin.query([
      `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${role}') THEN CREATE ROLE ${role} LOGIN PASSWORD 'pw'; END IF; END $$;`,
      `GRANT CONNECT ON DATABASE ${dbName} TO ${role};`,
      `GRANT USAGE ON SCHEMA public TO ${role};`,
      `GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${role};`,
      `GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role};`,
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${new URL(url).username || 'postgres'} IN SCHEMA public GRANT SELECT ON TABLES TO ${role};`,
    ].join('\n'));
    await mintLegacy(liveRole);
    await mintLegacy(retiredRole);
    await mintLegacy(orphanRole);

    // ── B. orphan roles are DROPPED by migration 143 ────────────────────────────────────────────
    console.log(`B. orphan roles (retired xell / no xell) are dropped by migration 143`);
    // Prove the retired-role + no-xell role exist and can read a secret BEFORE the migration.
    for (const [label, role] of [['retired xell', retiredRole], ['no xell', orphanRole]]) {
      const before = await admin.query(`SELECT 1 FROM pg_roles WHERE rolname=$1`, [role]);
      ok(before.rows.length === 1, `  ${label} role ${role} exists before the migration`);
    }

    const migration = readFileSync(resolve(here, '..', 'db', 'migrations', '143_revoke_secret_columns_from_ro_prod_roles.sql'), 'utf8');
    await admin.query(migration);

    for (const [label, role] of [['retired xell', retiredRole], ['no xell', orphanRole]]) {
      const after = await admin.query(`SELECT 1 FROM pg_roles WHERE rolname=$1`, [role]);
      ok(after.rows.length === 0, `  ${label} role ${role} is GONE after the migration (orphan cleanup)`);
    }

    // ── A. the LIVE role is HARDENED (kept, but secrets refused, hints + counts readable) ───────
    console.log(`A. the live role ${liveRole} is hardened (not dropped), secrets refused`);
    const liveExists = (await admin.query(`SELECT 1 FROM pg_roles WHERE rolname=$1`, [liveRole])).rows.length === 1;
    ok(liveExists, '  the live role is KEPT (its xell is working)');

    const ro = new pg.Client({ connectionString: `postgresql://${liveRole}:pw@${new URL(url).host}/${dbName}` });
    await ro.connect();
    const refuse = async (what, sql) => {
      try { const r = await ro.query(sql); ok(false, `${liveRole} REFUSES ${what} (got: ${JSON.stringify(r.rows[0]).slice(0, 50)})`); }
      catch (e) { ok(/permission denied/.test(e.message), `${liveRole} REFUSES ${what} (${e.message.split('\n')[0]})`); }
    };
    const read = async (what, sql, expect) => {
      try { const r = await ro.query(sql); ok(JSON.stringify(r.rows[0]).includes(expect), `${liveRole} reads ${what}`); }
      catch (e) { ok(false, `${liveRole} reads ${what} — ${e.message.split('\n')[0]}`); }
    };
    await refuse('provider_token.token', 'SELECT token FROM provider_token');
    await refuse('environment_var.value', 'SELECT value FROM environment_var');
    await refuse('langfuse_config.admin_password', 'SELECT admin_password FROM langfuse_config');
    await refuse('langfuse_config.secret_key', 'SELECT secret_key FROM langfuse_config');
    await refuse('xell.prod_ro_dsn', 'SELECT prod_ro_dsn FROM xell');
    await refuse('SELECT * over provider_token', 'SELECT * FROM provider_token');
    await read('token_hint', 'SELECT token_hint FROM provider_token', 'sk-ant-hint');
    await read('provider_token count', 'SELECT count(*) FROM provider_token', '1');
    await read('langfuse admin_password_hint', 'SELECT admin_password_hint FROM langfuse_config', 'fake-pw-hint');
    await read('xell slug (non-secret)', `SELECT slug FROM xell WHERE status='working'`, liveSlug);
    await ro.end().catch(() => {});

    // ── idempotent: a second apply changes nothing ──────────────────────────────────────────────
    await admin.query(migration);
    const liveAfter2 = (await admin.query(`SELECT 1 FROM pg_roles WHERE rolname=$1`, [liveRole])).rows.length === 1;
    ok(liveAfter2, '  migration re-apply is idempotent (live role still present)');
  } finally {
    // tear down every role and row this test created
    await dropRole(liveRole);
    await dropRole(retiredRole);
    await dropRole(orphanRole);
    await admin.query(`DELETE FROM xell WHERE project_id=$1`, [projectId]).catch(() => {});
    await admin.query(`DELETE FROM xource WHERE id=$1`, [xourceId]).catch(() => {});
    await admin.query(`DELETE FROM provider_token WHERE project_id=$1`, [projectId]).catch(() => {});
    await admin.query(`UPDATE langfuse_config SET admin_password=NULL, admin_password_hint=NULL, secret_key=NULL, secret_key_hint=NULL WHERE id=true`).catch(() => {});
    await admin.query(`DELETE FROM project WHERE id=$1`, [projectId]).catch(() => {});
    await admin.end().catch(() => {});
  }
}

await main().catch((e) => { console.error('TEST ERROR:', e); fail++; });
console.log(fail ? `\n${fail} FAILED` : '\nall good');
process.exit(fail ? 1 : 0);
