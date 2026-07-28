// READ-ONLY PRODUCTION for a MANAGER zee — enforced by postgres, not by a prompt.
//
// A manager zee is bound to the LIVE production database so it can answer "what does production
// actually look like right now?" without dispatching a worker to find out. It must never be able to
// change it. "Be careful" is not a mechanism, and the prod-guard hook only sees host-side Bash — a
// cxell zee talks to postgres over TCP, where no hook exists. So the guarantee is made where it
// cannot be argued with: the manager gets its OWN postgres ROLE (`zee_ro_<slug>`) with LOGIN,
// CONNECT and SELECT — and nothing else. An UPDATE, an INSERT, a DROP, a CREATE: all refused by the
// server with `permission denied`, whatever the agent believes it is allowed to do.
//
// Per-xell rather than one shared reader, deliberately:
//   • pg_stat_activity then names WHICH manager is running a query;
//   • revocation is per manager (the reaper drops the role with the xell), so one manager losing
//     access never touches another;
//   • a leaked DSN is scoped to one throwaway agent and dies with it.
//
// PRODRO_MODE=simulate (inherited from SHIP_MODE when unset, like every other prod-touching path)
// creates nothing and mints a DSN that cannot authenticate — the whole flow stays exercisable off
// production. Failure is CLOSED: if the role cannot be provisioned, the bind FAILS. There is no
// fallback to the owner credential, because "read-only access, except when provisioning hiccups"
// is not read-only access.
import { randomBytes } from 'node:crypto';
import { q, one } from '../db/pool.js';
import { logline } from './logbus.js';
import { psql, prodDb, assertProdDbTarget } from '../queenzee/shipmigrate.js';

export const PRODRO_MODE = (process.env.PRODRO_MODE || process.env.SHIP_MODE || 'real') === 'simulate'
  ? 'simulate' : 'real';

// A postgres identifier for this xell's reader. Slugs carry dashes; roles must not.
export function roRoleName(slug) {
  return `zee_ro_${String(slug || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 40)}`;
}

// The SQL that mints (or re-mints) the reader. Idempotent by construction and PURE — exported so a
// test can read exactly what would run on production without running anything.
//
// GRANTs are re-applied every bind: a table created since the last bind is not covered by an old
// `GRANT SELECT ON ALL TABLES`, and ALTER DEFAULT PRIVILEGES only covers objects created by the role
// that ran it. Re-granting is cheap and keeps the reader honest as the schema moves.
export function readonlyRoleSql(role, password, dbName, owner) {
  const pw = String(password).replace(/'/g, "''");
  return [
    `DO $$ BEGIN`,
    `  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN`,
    `    CREATE ROLE ${role} LOGIN PASSWORD '${pw}';`,
    `  ELSE`,
    `    ALTER ROLE ${role} LOGIN PASSWORD '${pw}';`,
    `  END IF;`,
    `END $$;`,
    // Belt and braces: even if something later grants this role a table privilege, it cannot write.
    `ALTER ROLE ${role} NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;`,
    `ALTER ROLE ${role} SET default_transaction_read_only = on;`,
    `ALTER ROLE ${role} SET statement_timeout = '60s';`,
    `GRANT CONNECT ON DATABASE ${dbName} TO ${role};`,
    `GRANT USAGE ON SCHEMA public TO ${role};`,
    `GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${role};`,
    `GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role};`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA public GRANT SELECT ON TABLES TO ${role};`,
    // Explicitly take away everything else that a default PUBLIC grant could have handed over.
    `REVOKE CREATE ON SCHEMA public FROM ${role};`,
  ].join('\n');
}

// Build the DSN a cxell zee will use: the prod db's network address with the reader's credentials.
// Host/port come from the CONTAINER ROW (what the cxell firewall is re-sealed to allow), never from
// a guess; a row with no reachable address cannot be handed to a cxell at all.
export function readonlyDsn({ host, port, role, password, dbName }) {
  if (!host || !port) return null;
  return `postgresql://${role}:${encodeURIComponent(password)}@${host}:${port}/${dbName}`;
}

// Mint (or re-mint) THIS xell's read-only prod reader and return its DSN. Throws on failure —
// callers must let that propagate: a failed mint means NO prod access, not degraded access.
export async function mintProdReader(xell, project) {
  const db = await prodDb(project);
  if (!db) throw new Error('no prod db container registered for this project');
  // The same identity proof a prod migration/seed makes before it writes. We only ever SELECT with
  // the resulting role, but CREATE ROLE is a real write on a real cluster — prove which one it is.
  const target = await assertProdDbTarget(db);
  if (target?.ok === false) throw new Error(target.error);

  const row = await one(
    `SELECT c.name, c.docker_ctx, host(c.host) AS host, c.host_port, c.conn_ref FROM container c
      WHERE c.project_id=$1 AND c.role='db' AND c.tier='prod' LIMIT 1`, [project.id]);
  const role = roRoleName(xell.slug);
  const password = randomBytes(24).toString('base64url');
  const sql = readonlyRoleSql(role, password, db.name, db.user);

  if (PRODRO_MODE === 'simulate') {
    logline('prod-ro', `SIMULATE: would create read-only role ${role} on ${db.container} (${db.name})`);
  } else {
    const r = await psql(db, ['-v', 'ON_ERROR_STOP=1'], sql);
    if (!r.ok) throw new Error(`could not provision the read-only role on production: ${String(r.err).trim().slice(0, 300)}`);
    logline('prod-ro', `created/refreshed read-only role ${role} on ${db.container} (${db.name}) — SELECT only`);
  }

  const dsn = readonlyDsn({ host: row?.host, port: row?.host_port, role, password, dbName: db.name });
  if (!dsn) {
    throw new Error('the prod db row publishes no host:port, so a cxell cannot reach it over TCP — '
      + 'record the address on the container before binding a manager to prod');
  }
  await q(`UPDATE xell SET prod_ro_dsn=$2 WHERE id=$1`, [xell.id, dsn]);
  return { role, dsn, mode: PRODRO_MODE, container: db.container, database: db.name,
           address: `${row.host}:${row.host_port}` };
}

// Give the access back. Called by the reaper when a manager xell is torn down: a role that outlives
// its agent is a credential nobody owns. Best-effort and never throws — a teardown must not wedge on
// a database that is unreachable right now (the role is inert without its DSN either way).
export async function dropProdReader(xell) {
  try {
    const project = await one(`SELECT * FROM project WHERE id=$1`, [xell.project_id]);
    if (!project) return { dropped: false, reason: 'no project' };
    const role = roRoleName(xell.slug);
    if (PRODRO_MODE === 'simulate') {
      logline('prod-ro', `SIMULATE: would drop read-only role ${role}`);
      return { dropped: true, role, mode: 'simulate' };
    }
    const db = await prodDb(project);
    if (!db) return { dropped: false, reason: 'no prod db' };
    const sql = [
      `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${role}') THEN`,
      `  EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${role}';`,
      `  EXECUTE 'REVOKE ALL ON SCHEMA public FROM ${role}';`,
      `  EXECUTE 'REVOKE ALL ON DATABASE ${db.name} FROM ${role}';`,
      `  EXECUTE 'DROP ROLE ${role}';`,
      `END IF; END $$;`,
    ].join('\n');
    const r = await psql(db, ['-v', 'ON_ERROR_STOP=1'], sql);
    logline('prod-ro', r.ok ? `dropped read-only role ${role}` : `could not drop ${role}: ${String(r.err).trim().slice(0, 160)}`);
    await q(`UPDATE xell SET prod_ro_dsn=NULL WHERE id=$1`, [xell.id]);
    return { dropped: r.ok, role };
  } catch (e) { return { dropped: false, error: e.message }; }
}
