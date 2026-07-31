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
import { spawnSync } from 'node:child_process';
import { q, one } from '../db/pool.js';
import { logline } from './logbus.js';
import { psql, prodDb, assertProdDbTarget, prodDbAddress, connRefAlias } from '../queenzee/shipmigrate.js';

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

// ── WHICH ADDRESS a manager's cxell dials ────────────────────────────────────────────────────────
//
// There are TWO shapes of registered production database in this codebase, and shipmigrate has
// modelled both since the ship gate: one that PUBLISHES a host:port, and one that publishes nothing
// and is reachable only by its docker NETWORK ALIAS (Zeehive's own meta db — Ports is
// {"5432/tcp": null} by design). This path used to know only the first, so an alias-only prod db
// made `add a manager zee` impossible. prodDbAddress() is the one resolver; we reuse it rather than
// writing a second one that can disagree with the guard that decides whether a write may happen.

// The docker context a cxell runs on. spawnCxell pins 'default' (the queenzee IS the docker host),
// and a docker network on ANOTHER daemon cannot resolve from it — so the reachability rule below and
// the network join agree on exactly one constant.
export const CXELL_CTX = 'default';

// The port an alias-addressed conn_ref names. `postgresql://z@meta-db:5445/z` → 5445; a URL with no
// port → 5432, which is libpq's own default and therefore the one the DSN would use anyway.
export function connRefPort(connRef) {
  try { const p = new URL(connRef).port; return p ? Number(p) : 5432; } catch { return 5432; }
}

// PURE: which of a container's docker networks answer to `alias`. Reads the same
// .NetworkSettings.Networks shape decideProdDbTarget already parses (Aliases + DNSNames).
export function networksCarryingAlias(networks, alias) {
  const out = [];
  for (const [net, cfg] of Object.entries(networks || {})) {
    const names = [...(cfg?.Aliases || []), ...(cfg?.DNSNames || [])];
    if (alias && names.includes(alias)) out.push(net);
  }
  return out;
}

// PURE DECISION: the host:port a manager's read-only DSN should carry, or a refusal that says where
// the missing address goes. `db` is prodDb()'s handle, `row` the raw container row (it alone carries
// the inet `host` column). No I/O, exported so the whole decision is table-testable.
//
//   → { ok: true, mode: 'port',  host, port }              — published; nothing else to arrange
//   → { ok: true, mode: 'alias', host, port, ctx }         — a docker network name; the cxell must
//                                                            JOIN that network (see below)
//   → { ok: false, error }                                 — FAILS CLOSED, and says what to fill in
export function decideReaderAddress({ db, row, project, cxellCtx = CXELL_CTX }) {
  const addr = prodDbAddress(db);
  // A published host:port is today's behaviour, byte for byte — but only when the row actually
  // carries the HOST too. A host_port with an empty host used to build `postgresql://null:5432/…`.
  if (addr.mode === 'port' && row?.host) {
    return { ok: true, mode: 'port', host: row.host, port: addr.port };
  }

  const alias = connRefAlias(db?.conn_ref ?? row?.conn_ref);
  if (alias) {
    // An alias DSN is only TRUE if the cxell can resolve it, and a docker network lives on one
    // daemon. Refuse rather than hand a manager a DSN that cannot connect.
    const dbCtx = db?.ctx || CXELL_CTX;
    if (dbCtx !== cxellCtx) {
      return { ok: false, error:
        `the production database for project "${project?.name || '?'}" (container row "${row?.name || db?.logical}") `
        + `publishes no host:port and is reachable only by the docker network name '${alias}' on context `
        + `'${dbCtx}' — but a cxell runs on '${cxellCtx}', and a docker network on another daemon cannot `
        + 'resolve from it. Publish an address on that container row (container.host + container.host_port), '
        + `or register the prod db on the '${cxellCtx}' context, then re-add the manager.` };
    }
    return { ok: true, mode: 'alias', host: alias, port: connRefPort(db?.conn_ref ?? row?.conn_ref), ctx: dbCtx };
  }

  return { ok: false, error:
    `the production database for project "${project?.name || '?'}" records no address a cxell can dial. `
    + `Fill it in on the container row "${row?.name || db?.logical}" (role='db', tier='prod'): either `
    + 'container.host + container.host_port (the published address, e.g. 10.2.0.16 and 5432), or '
    + "container.conn_ref as a URL whose HOST is the docker network name the database answers to "
    + '(postgresql://<user>@<network-alias>:5432/<db>). Then re-add the manager — the bind fails '
    + 'closed until then, because a DSN nothing can connect to is worse than a refusal.' };
}

// Mint (or re-mint) THIS xell's read-only prod reader and return its DSN. Throws on failure —
// callers must let that propagate: a failed mint means NO prod access, not degraded access.
export async function mintProdReader(xell, project) {
  const db = await prodDb(project);
  if (!db) throw new Error('no prod db container registered for this project');

  // ADDRESS FIRST, before anything is written on a real cluster: if the DSN we could hand this
  // manager is not one its cxell can dial, there is no point creating a role for it. Pure decision,
  // no I/O — and the ONE resolver (prodDbAddress) the ship/seed guards already use.
  const row = await one(
    `SELECT c.name, c.docker_ctx, host(c.host) AS host, c.host_port, c.conn_ref FROM container c
      WHERE c.project_id=$1 AND c.role='db' AND c.tier='prod' LIMIT 1`, [project.id]);
  const addr = decideReaderAddress({ db, row, project });
  if (!addr.ok) throw new Error(addr.error);

  // The same identity proof a prod migration/seed makes before it writes. We only ever SELECT with
  // the resulting role, but CREATE ROLE is a real write on a real cluster — prove which one it is.
  const target = await assertProdDbTarget(db);
  if (target?.ok === false) throw new Error(target.error);

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

  const dsn = readonlyDsn({ host: addr.host, port: addr.port, role, password, dbName: db.name });
  // Belt and braces: decideReaderAddress already refused every unaddressed shape, so reaching here
  // with no DSN would be a bug in this file — never a manager quietly bound to nothing.
  if (!dsn) throw new Error(`could not build a read-only DSN from the ${addr.mode} address of ${db.container}`);
  if (xell.id) await q(`UPDATE xell SET prod_ro_dsn=$2 WHERE id=$1`, [xell.id, dsn]);
  return { role, dsn, mode: PRODRO_MODE, container: db.container, database: db.name,
           address: `${addr.host}:${addr.port}`, address_mode: addr.mode };
}

// ── MAKING AN ALIAS ADDRESS ACTUALLY REACHABLE ──────────────────────────────────────────────────
//
// ensureCxell() puts every cxell on `zee-hive-net` and nothing else, so a docker network ALIAS does
// not resolve in there — a DSN built on one would be a lie. This connects THIS ONE cxell (the
// manager's, and only when it holds db-prod-readonly) to the network the prod db answers on, so the
// alias resolves for exactly the container that is supposed to read production.
//
// Deliberately narrow, and it must stay that way:
//   • ONLY a db-prod-readonly xell. An ordinary worker cxell is never joined to a prod network.
//   • ONLY when the address really is an alias — a published host:port needs no join at all.
//   • ONE network (the first that answers to the alias), never "all of them".
//   • FAILS CLOSED: the caller aborts the cage build on `error`, because a manager holding a DSN it
//     cannot connect to is worse than a manager that was never created.
// It grants no write of any kind — the credential is still the SELECT-only role. What it DOES widen
// is network REACH: docker network membership is per-network, not per-container, so the manager's
// cxell can see whatever else sits on that network. That is the cost of an alias-addressed prod db,
// and it is why a published host:port (which needs no join) stays the preferred registration.
export const PROD_RO_COUPLING = 'db-prod-readonly';

export async function connectCxellToProdNetwork({ xellId, dbCoupling, cxellName, cxellCtx = CXELL_CTX }) {
  // ── THE UNIVERSAL-PATH GUARD, before ANY query ────────────────────────────────────────────────
  // This is called for EVERY cxell dispatch in the fleet, and only a prod-read-only xell has any
  // business here. When the caller already holds the coupling (spawnCxell does — it is on the xell
  // row it is spawning into) decide from that and touch nothing: no SELECT, no docker, no throw. A
  // dispatch that has nothing to do with managers must not be able to fail on this code at all.
  if (dbCoupling !== undefined && dbCoupling !== PROD_RO_COUPLING) {
    return { required: false, joined: false, reason: 'not a prod read-only xell' };
  }
  try {
    return await resolveAndJoinProdNetwork({ xellId, cxellName, cxellCtx });
  } catch (e) {
    // We only get here for a xell we could NOT rule out as prod-read-only, so failing closed is the
    // correct answer: the caller aborts the cage build rather than start a manager whose DSN may not
    // resolve. An unexpected throw becomes that same refusal instead of an exception thrown through
    // the middle of a cage build.
    return { required: true, joined: false,
      error: `could not establish prod read-only network reach: ${e.message}` };
  }
}

async function resolveAndJoinProdNetwork({ xellId, cxellName, cxellCtx }) {
  const xell = xellId ? await one(`SELECT * FROM xell WHERE id=$1`, [xellId]) : null;
  if (!xell) return { required: false, joined: false, reason: 'no xell' };
  if (xell.db_coupling !== PROD_RO_COUPLING) {
    return { required: false, joined: false, reason: 'not a prod read-only xell' };
  }
  const project = await one(`SELECT * FROM project WHERE id=$1`, [xell.project_id]);
  const db = project ? await prodDb(project).catch(() => null) : null;
  // No production registered at all is the ONE tolerated absence (manager-spawn.js says so): the
  // manager exists, it just has nothing to read.
  if (!db) return { required: false, joined: false, reason: 'no prod db registered' };
  const row = await one(
    `SELECT c.name, c.docker_ctx, host(c.host) AS host, c.host_port, c.conn_ref FROM container c
      WHERE c.project_id=$1 AND c.role='db' AND c.tier='prod' LIMIT 1`, [project.id]);

  const addr = decideReaderAddress({ db, row, project, cxellCtx });
  if (!addr.ok) return { required: true, joined: false, error: addr.error };
  if (addr.mode !== 'alias') {
    return { required: false, joined: false, reason: `prod db publishes ${addr.host}:${addr.port} — no network join needed` };
  }
  if (PRODRO_MODE === 'simulate') {
    logline('prod-ro', `SIMULATE: would connect ${cxellName} to the docker network carrying '${addr.host}'`);
    return { required: true, joined: false, simulated: true, alias: addr.host };
  }

  const insp = spawnSync('docker', [...(db.ctx && db.ctx !== 'default' ? ['--context', db.ctx] : []),
    'inspect', '--format', '{{json .NetworkSettings.Networks}}', db.container],
    { encoding: 'utf8', timeout: 15000, windowsHide: true });
  if (insp.status !== 0) {
    return { required: true, joined: false, error:
      `cannot inspect ${db.container} on ${db.ctx} to find the docker network its name '${addr.host}' `
      + `lives on — ${(insp.stderr || insp.error?.message || '').trim().split('\n').pop()?.slice(0, 160)}` };
  }
  let nets = {};
  try { nets = JSON.parse(insp.stdout || '{}') || {}; } catch { nets = {}; }
  const carrying = networksCarryingAlias(nets, addr.host);
  if (!carrying.length) {
    return { required: true, joined: false, error:
      `${db.container} is on no docker network that answers to '${addr.host}' (networks: `
      + `${Object.keys(nets).join(', ') || 'none'}) — the prod db row's conn_ref names a host this `
      + 'container does not have, so a manager cxell could never reach it.' };
  }
  const net = carrying[0];
  const con = spawnSync('docker', [...(db.ctx && db.ctx !== 'default' ? ['--context', db.ctx] : []),
    'network', 'connect', net, cxellName], { encoding: 'utf8', timeout: 30000, windowsHide: true });
  const already = /already exists in network|endpoint with name .* already exists/i.test(con.stderr || '');
  if (con.status !== 0 && !already) {
    return { required: true, joined: false, error:
      `could not connect ${cxellName} to docker network ${net} (where the prod db answers to `
      + `'${addr.host}') — ${(con.stderr || con.error?.message || '').trim().split('\n').pop()?.slice(0, 160)}` };
  }
  logline('prod-ro', `${cxellName}: joined docker network ${net} so the read-only prod DSN's host `
    + `'${addr.host}' resolves — this cxell only`);
  return { required: true, joined: true, network: net, alias: addr.host, networks: carrying };
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
      // Clear the stored DSN even in simulate. The ROLE is cluster state and simulate skips it, but
      // xell.prod_ro_dsn is OUR row — leaving it set means the xell still reports a production
      // credential it is no longer meant to hold, in the one mode the whole path is exercised in.
      if (xell.id) await q(`UPDATE xell SET prod_ro_dsn=NULL WHERE id=$1`, [xell.id]);
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
