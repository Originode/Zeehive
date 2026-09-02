// THE MEDIC'S POSTGRES ROLE — the write wall, in GRANTs (docs/medic-meta-plane-plan.md §3.3, DR-8;
// provision-proof kit stage 4).
//
// The medic's SQL tools (medic-tools.js: meta_select / meta_write) run on a dedicated long-lived
// role, `zeehive_medic`, NEVER on the owner pool. The role IS the confinement for the SQL half of
// the medic: an allowlist in tool code would be a prompt-shaped defence on a loop that reads
// attacker-influencible text (condition bodies, error strings) — postgres refuses, an if-statement
// asks.
//
// The GRANT surface, and why each line is where it is:
//   READ  — SELECT on everything EXCEPT provider_token's secret column: "fully access meta-db"
//           (the directive) includes container.conn_pw and environment_var.value, because a
//           credential-shaped CONFIG fault (TKT-181) is exactly the patient. A vendor API key is
//           not config — a broken provider auth is a human's re-auth — so provider_token.token
//           stays revoked, column-scoped like prod-readonly's SECRET_COLUMNS.
//   WRITE — INSERT/UPDATE on the CONFIG surface only; DELETE only where a row is legitimately
//           removable (project_condition — deleting a fixed fault's line is the medic's job;
//           machine_pool / environment_var — rows a human's console delete already treats as
//           config). container gets NO DELETE: deleting a container row is the reaper's act, and
//           "any role that can UPDATE xell / DELETE container is a nested reaper"
//           (docs/self-project-prod-data.md) is the incident this surface is drawn around.
//   NONE  — xell, zee, medic, harness (no self-grant), provider_token, the gate tables
//           (land/ship/seed/infra_request) and the ledgers (zee_turn, llm_gateway_request,
//           medic_action — the DRIVER writes the audit on the owner pool, so the medic cannot
//           forge or trim its own receipts). Enforced by ABSENCE of grant plus the belt-and-braces
//           REVOKEs below for the tables that exist today.
//
// MEDICRW_MODE=simulate (inherited from SHIP_MODE when unset, the same contract as PRODRO_MODE)
// mints nothing real and hands back a DSN that cannot authenticate — a nested queenzee exercising
// this path against a clone of the fleet's rows creates no role anywhere.
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { q } from '../db/pool.js';
import { logline } from './logbus.js';
import { metaDbHandle } from './prod-readonly.js';

export const MEDIC_ROLE = 'zeehive_medic';
export const MEDICRW_MODE = (process.env.MEDICRW_MODE || process.env.SHIP_MODE || 'real') === 'simulate'
  ? 'simulate' : 'real';

// The write surface: table → allowed statements. project is COLUMN-SCOPED (its config columns
// only — never name/repo_root/main_branch identity columns, and medic_plane stays a human knob).
// This list is asserted against the LIVE schema by test/medic-role.test.mjs, not trusted here.
export const MEDIC_WRITE_TABLES = {
  machine: ['INSERT', 'UPDATE'],
  machine_pool: ['INSERT', 'UPDATE', 'DELETE'],
  pool_config: ['INSERT', 'UPDATE'],
  container: ['INSERT', 'UPDATE'],               // no DELETE — that is the reaper's act
  environment: ['INSERT', 'UPDATE'],
  environment_var: ['INSERT', 'UPDATE', 'DELETE'],
  deploy_site: ['INSERT', 'UPDATE'],
  project_condition: ['INSERT', 'UPDATE', 'DELETE'],
  build_readiness_record: ['INSERT', 'UPDATE'],
};

// project's writable CONFIG columns (column-scoped UPDATE — postgres supports it natively).
export const MEDIC_PROJECT_COLUMNS = ['registry', 'manifest', 'manifest_hash', 'manifest_at'];

// Tables that must hold NO medic grant even though the blanket SELECT covers reading them —
// restated here so the REVOKE half is explicit and testable (write grants never existed; this is
// belt and braces against a future blanket grant).
export const MEDIC_NO_WRITE_TABLES = [
  'xell', 'zee', 'medic', 'medic_action', 'harness', 'provider_token',
  'land_request', 'ship_request', 'seed_request', 'infra_request',
  'zee_turn', 'llm_gateway_request',
];

// The SQL that mints (or re-mints) the medic role. PURE — exported so the test reads exactly what
// would run without running it, the readonlyRoleSql discipline. GRANTs are re-applied every mint
// (a table created since the last mint is not covered by an old grant).
export function medicRoleSql(password, dbName, owner) {
  const pw = String(password).replace(/'/g, "''");
  const writes = Object.entries(MEDIC_WRITE_TABLES).map(([table, stmts]) =>
    `DO $mw$ BEGIN
       IF to_regclass('${table}') IS NOT NULL THEN
         GRANT ${stmts.join(', ')} ON ${table} TO ${MEDIC_ROLE};
       END IF;
     END $mw$;`);
  const noWrites = MEDIC_NO_WRITE_TABLES.map((table) =>
    `DO $mn$ BEGIN
       IF to_regclass('${table}') IS NOT NULL THEN
         REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ${table} FROM ${MEDIC_ROLE};
       END IF;
     END $mn$;`);
  return [
    `DO $$ BEGIN`,
    `  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${MEDIC_ROLE}') THEN`,
    `    CREATE ROLE ${MEDIC_ROLE} LOGIN PASSWORD '${pw}';`,
    `  ELSE`,
    `    ALTER ROLE ${MEDIC_ROLE} LOGIN PASSWORD '${pw}';`,
    `  END IF;`,
    `END $$;`,
    `ALTER ROLE ${MEDIC_ROLE} NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;`,
    `ALTER ROLE ${MEDIC_ROLE} SET statement_timeout = '30s';`,
    `GRANT CONNECT ON DATABASE ${dbName} TO ${MEDIC_ROLE};`,
    `GRANT USAGE ON SCHEMA public TO ${MEDIC_ROLE};`,
    `GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${MEDIC_ROLE};`,
    `GRANT SELECT, USAGE ON ALL SEQUENCES IN SCHEMA public TO ${MEDIC_ROLE};`,
    // The one secret the read does NOT include: vendor API keys (see the header).
    `DO $ms$ BEGIN
       IF to_regclass('provider_token') IS NOT NULL THEN
         REVOKE SELECT (token) ON provider_token FROM ${MEDIC_ROLE};
       END IF;
     END $ms$;`,
    ...writes,
    // Column-scoped UPDATE on project's config columns (the blanket SELECT already reads it).
    `DO $mp$ BEGIN
       IF to_regclass('project') IS NOT NULL THEN
         REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON project FROM ${MEDIC_ROLE};
         GRANT UPDATE (${MEDIC_PROJECT_COLUMNS.join(', ')}) ON project TO ${MEDIC_ROLE};
       END IF;
     END $mp$;`,
    ...noWrites,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA public GRANT SELECT ON TABLES TO ${MEDIC_ROLE};`,
    `REVOKE CREATE ON SCHEMA public FROM ${MEDIC_ROLE};`,
  ].join('\n');
}

// ── the pool the medic's SQL tools run on ────────────────────────────────────────────────────────
// Minted lazily on first use and cached; re-minted at boot best-effort (index.js) so a schema that
// moved gets fresh grants without waiting for a medic. The password lives only in this process —
// the role is re-minted with a fresh one on every boot, so nothing durable holds it.
let medicPool = null;
let mintPromise = null;

export async function mintMedicRole() {
  const db = metaDbHandle();
  const password = randomBytes(24).toString('base64url');
  const sql = medicRoleSql(password, db.name, db.user);
  if (MEDICRW_MODE === 'simulate') {
    logline('medic', `SIMULATE: would create/refresh role ${MEDIC_ROLE} on the meta-DB (${db.name})`);
    return { role: MEDIC_ROLE, dsn: `postgresql://${MEDIC_ROLE}:simulated@${db.host}:${db.port}/${db.name}`,
             mode: 'simulate' };
  }
  await q(sql);
  logline('medic', `created/refreshed role ${MEDIC_ROLE} on the meta-DB (${db.name}) — config-surface writes only`);
  const dsn = `postgresql://${MEDIC_ROLE}:${encodeURIComponent(password)}@${db.host}:${db.port}/${db.name}`;
  return { role: MEDIC_ROLE, dsn, mode: 'real' };
}

// The medic pool — small (the loop is serial per medic), connecting AS the medic role. In simulate
// mode there is deliberately no pool: the DSN cannot authenticate, and a caller reaching for SQL in
// simulate gets a legible refusal instead of a hang.
export async function medicDbPool() {
  if (medicPool) return medicPool;
  if (!mintPromise) mintPromise = mintMedicRole();
  const minted = await mintPromise;
  if (minted.mode === 'simulate') {
    throw new Error('MEDICRW_MODE=simulate — the medic role is not minted and its SQL surface is inert');
  }
  medicPool = new pg.Pool({ connectionString: minted.dsn, max: 2 });
  medicPool.on('error', (err) => logline('medic', `medic pool idle error: ${err.message}`));
  return medicPool;
}

// Boot hook (index.js, best-effort): refresh the grants as the schema moves. Never throws.
export async function refreshMedicRoleAtBoot() {
  try { mintPromise = mintMedicRole(); await mintPromise; } catch (e) {
    logline('medic', `boot mint of ${MEDIC_ROLE} failed (${e.message}) — will retry on first medic use`);
    mintPromise = null;
  }
}
