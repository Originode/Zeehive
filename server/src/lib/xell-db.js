// Choose which database a xell works against.
//
// A pooled xell is provisioned on the shared DEV db (pool_config.default_db_coupling). Three real
// needs break that:
//   • "start from the latest prod data"  → db-isolated: its OWN postgres, restored from a dump.
//   • "hotfix against prod"              → db-shared-prod: attach the live prod container.
//   • "this xell changes the SCHEMA"     → db-clone: its own DATABASE inside the shared dev
//     postgres, cloned in seconds from a maintained template. Two xells doing DDL on the ONE
//     shared dev db each tripped the other's /ooney schema gate (the gate diffs the xell's
//     catalog against prod, and a shared catalog is shared blame) — a clone makes
//     "my database = prod + MY migrations" checkable per xell.
//
// The db_coupling enum already had the first three; only db-shared-dev was ever implemented, so
// db-isolated and db-shared-prod silently linked NOTHING and the xell had no database at all.
//
// SAFETY: db-shared-prod points a zee at LIVE PRODUCTION DATA. Nothing here is reversible by the
// orchestrator — a bad UPDATE is a real outage. It is never a default, it must be asked for, and
// the binding shouts about it (see bindingFor).
import { spawn, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { config } from '../config.js';
import { q, one } from '../db/pool.js';
import { broadcast } from '../lib/events.js';
import { logline } from '../lib/logbus.js';
import { computePorts } from './provision.js';
import { resolveSite } from './sites.js';
import { namingFor } from './manifest.js';
import { execPsql, cloneInstanceFor, templateInstanceFor, upsertInstance, deleteInstance }
  from './db-instances.js';

const MODE = process.env.PROVISION_MODE === 'real' ? 'real' : 'simulate';

export const DB_MODES = {
  'db-shared-dev': 'the shared dev database (default) — other xells share it; its SCHEMA is frozen (write migrations instead)',
  'db-clone': 'its OWN database inside the shared dev postgres, cloned in seconds from a maintained template — for xells doing schema/migration work',
  'db-shared-prod': 'the LIVE PRODUCTION database — writes are real and irreversible',
  'db-isolated': 'its own postgres container, restored from a dump (e.g. the latest prod backup)',
};

// The container rows carry LOGICAL names (omnibiz_db_dev / omnibiz_db_prod) but the real daemons
// run versioned ones (omnibiz_db_dev_gis / omnibiz_db_prod_v184). `docker exec omnibiz_db_dev`
// hits the stale postgres:18beta1 container instead — the split-brain hazard. Resolve the actual
// container by preferring a running versioned match over the bare name.
export function resolveRealDbContainer(ctx, logicalName, { timeout = 15000 } = {}) {
  const r = spawnSync('docker', ['--context', ctx, 'ps', '--format', '{{.Names}}'],
    { encoding: 'utf8', timeout, windowsHide: true });
  if (r.status !== 0) return logicalName;
  const running = (r.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
  const versioned = running.find((n) => n !== logicalName && n.startsWith(`${logicalName}_`));
  return versioned || (running.includes(logicalName) ? logicalName : logicalName);
}

// Same resolution, but safe to call on the prod-guard's hot path. The guard gives its whole
// db-access request 5s (`curl --max-time 5`) and FAILS CLOSED on a timeout, so an uncached
// `docker ps` against a remote prod context — which is a network round-trip — could turn a slow
// day into "the zee is denied and told it may not deploy by hand". Cache per (ctx, name) for a
// few seconds: container names change only across a rebuild, and a stale name for 5s is strictly
// better than a false deny. The docker timeout is cut to 3s to stay inside the guard's budget;
// on a miss resolveRealDbContainer already falls back to the logical name.
const nameCache = new Map();
const NAME_TTL_MS = 5000;
export function resolveRealDbContainerCached(ctx, logicalName, now = Date.now()) {
  if (!ctx || !logicalName) return logicalName;
  const key = `${ctx}::${logicalName}`;
  const hit = nameCache.get(key);
  if (hit && now - hit.at < NAME_TTL_MS) return hit.name;
  const name = resolveRealDbContainer(ctx, logicalName, { timeout: 3000 });
  nameCache.set(key, { name, at: now });
  return name;
}

async function sharedDb(projectId, tier) {
  return one(
    `SELECT * FROM container WHERE project_id=$1 AND role='db' AND tier=$2 AND isolation='shared' LIMIT 1`,
    [projectId, tier]);
}

// ── db-clone: a per-xell DATABASE inside the shared dev postgres ──────────────
//
// CREATE DATABASE … TEMPLATE is a file-level copy: schema AND data, in seconds, zero extra
// containers. The catch is postgres refuses to copy a database with active connections — which
// the live shared dev db always has — so the source of clones is a maintained TEMPLATE database
// (<db>_zeehive_tpl), rebuilt from the live db via an in-container pg_dump|psql (slow, but
// tolerant of connections) and kept datallowconn=false so nothing can ever sit on it.
//
// Every database this section creates or drops is a db_instance ROW too (migration 019) — the
// container's card can then say what it contains, and discovery can catch what leaked.

// `docker exec <c> sh -c <cmd>` — for the pg_dump|psql pipe, which must run INSIDE the container
// (no network transfer, and the versions match by construction). Never rejects.
function dockerSh(ctx, container, cmd, timeout = 1800000) {
  return new Promise((res) => {
    let out = '', err = '', child;
    try { child = spawn('docker', ['--context', ctx, 'exec', '-i', container, 'sh', '-c', cmd], { windowsHide: true }); }
    catch (e) { return res({ ok: false, out: '', err: String(e?.message || e) }); }
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, timeout);
    child.stdout?.on('data', (d) => { out += d; });
    child.stderr?.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(t); res({ ok: false, out, err: String(e?.message || e) }); });
    child.on('close', (code) => { clearTimeout(t); res({ ok: code === 0, out, err }); });
  });
}

function projectDbId(project) {
  return {
    user: project.db_user || config.prodDbUser || 'postgres',
    name: project.db_name || config.prodDbName || 'omnibiz',
  };
}

// A postgres identifier from the slug: zee_<slug>, [a-z0-9_] only, inside the 63-char limit.
// Recorded as a db_instance row at creation, so a later xell RENAME cannot orphan the database.
export function cloneDbNameFor(slug) {
  const base = String(slug || '').toLowerCase().replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '').slice(0, 55);
  return `zee_${base || 'xell'}`;
}

const tplName = (dbid) => `${dbid.name}_zeehive_tpl`;
const TPL_MAX_AGE_MS = Number(process.env.CLONE_TPL_MAX_AGE_MS) || 6 * 3600 * 1000;
const TPL_BUILD_TIMEOUT_MS = Number(process.env.CLONE_TPL_TIMEOUT_MS) || 1800000;

// One rebuild per container at a time, in-process. Two dispatches racing would otherwise DROP
// the template out from under each other's restore; the queenzee is a single process, so a Map
// of in-flight promises is a sufficient mutex.
const tplBuilds = new Map();

// Ensure <db>_zeehive_tpl exists in the shared dev container and is younger than
// CLONE_TPL_MAX_AGE_MS. Returns { tpl, rebuilt }.
async function ensureCloneTemplate(project, devC) {
  const dbid = projectDbId(project);
  const tpl = tplName(dbid);
  if (MODE !== 'real') return { tpl, rebuilt: false };

  const inflight = tplBuilds.get(devC.id);
  if (inflight) return inflight;

  const run = (async () => {
    const ctx = devC.docker_ctx;
    const real = resolveRealDbContainer(ctx, devC.name);
    const have = await execPsql(ctx, real, dbid.user, `SELECT 1 FROM pg_database WHERE datname='${tpl}'`);
    const inst = await templateInstanceFor(devC.id);
    const fresh = inst?.refreshed_at && (Date.now() - new Date(inst.refreshed_at).getTime()) < TPL_MAX_AGE_MS;
    if (have.ok && have.out.trim() === '1' && fresh) return { tpl, rebuilt: false };

    logline('xell-db', `rebuilding clone template ${tpl} from ${dbid.name} in ${real} — `
      + 'in-container pg_dump|psql (slow is fine; clones from it are seconds)');
    // FORCE kicks any straggler connection; the template is never anyone's working database.
    let r = await execPsql(ctx, real, dbid.user, `DROP DATABASE IF EXISTS "${tpl}" WITH (FORCE)`);
    if (!r.ok) throw new Error(`template drop failed: ${r.err.trim().slice(-200)}`);
    r = await execPsql(ctx, real, dbid.user, `CREATE DATABASE "${tpl}"`);
    if (!r.ok) throw new Error(`template create failed: ${r.err.trim().slice(-200)}`);
    // No ON_ERROR_STOP here: a plain-SQL dump of an extension-bearing db (postgis) emits a few
    // harmless permission/comment errors. The emptiness check below is the real verdict.
    r = await dockerSh(ctx, real,
      `pg_dump -U ${dbid.user} -d ${dbid.name} | psql -q -U ${dbid.user} -d ${tpl}`, TPL_BUILD_TIMEOUT_MS);
    if (!r.ok) throw new Error(`template restore failed: ${r.err.trim().slice(-300)}`);
    const count = await execPsql(ctx, real, dbid.user,
      `SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema')`,
      { db: tpl });
    if (!count.ok || Number(count.out.trim()) === 0) {
      throw new Error(`template ${tpl} came out EMPTY — refusing to clone from it (${count.err.trim().slice(-160)})`);
    }
    // datallowconn=false: nobody can connect to it, so CREATE DATABASE … TEMPLATE always works.
    await execPsql(ctx, real, dbid.user, `UPDATE pg_database SET datallowconn=false WHERE datname='${tpl}'`);

    await upsertInstance({ containerId: devC.id, name: tpl, kind: 'template', refreshed: true });
    logline('xell-db', `clone template ${tpl} rebuilt (${count.out.trim()} tables)`);
    return { tpl, rebuilt: true };
  })();

  tplBuilds.set(devC.id, run);
  try { return await run; } finally { tplBuilds.delete(devC.id); }
}

// Give a xell its own database inside the shared dev container. Idempotent: an existing clone is
// KEPT (it holds the zee's work — re-attach must not silently reset it). Returns
// { target: <shared dev container row>, dbname }.
async function provisionCloneDb({ project, xell }) {
  const devC = await sharedDb(project.id, 'dev');
  if (!devC) throw new Error('no shared dev db container registered for this project');
  const dbid = projectDbId(project);
  const existing = await cloneInstanceFor(xell.id);
  const dbname = existing?.name || cloneDbNameFor(xell.slug);

  if (MODE === 'real') {
    const ctx = devC.docker_ctx;
    const real = resolveRealDbContainer(ctx, devC.name);
    const have = await execPsql(ctx, real, dbid.user, `SELECT 1 FROM pg_database WHERE datname='${dbname}'`);
    if (!(have.ok && have.out.trim() === '1')) {
      const { tpl } = await ensureCloneTemplate(project, devC);
      const r = await execPsql(ctx, real, dbid.user,
        `CREATE DATABASE "${dbname}" TEMPLATE "${tpl}"`, { timeout: 300000 });
      if (!r.ok) throw new Error(`clone create failed: ${r.err.trim().slice(-200)}`);
      logline('xell-db', `${xell.slug} → cloned its own database ${dbname} from ${tpl} (file-level copy)`);
    }
  }

  await upsertInstance({ containerId: devC.id, name: dbname, kind: 'clone',
                         ownerXellId: xell.id, refreshed: !existing });
  return { target: devC, dbname };
}

// Teardown's half: drop the xell's clone database, if it ever had one. Best-effort — the reaper
// logs a failure and moves on; a leaked database stays ON THE BOOKS as an instance row (orphan),
// so it costs disk visibly instead of silently.
export async function dropCloneDb(xell) {
  const inst = await cloneInstanceFor(xell.id);
  if (!inst) return { ok: true, skipped: true };
  const project = await one(`SELECT * FROM project WHERE id=$1`, [xell.project_id]);
  const devC = await one(`SELECT * FROM container WHERE id=$1`, [inst.container_id]);
  if (!project || !devC) return { ok: false, error: 'no project/db container to drop from' };
  if (MODE === 'real') {
    const dbid = projectDbId(project);
    const real = resolveRealDbContainer(devC.docker_ctx, devC.name);
    const r = await execPsql(devC.docker_ctx, real, dbid.user,
      `DROP DATABASE IF EXISTS "${inst.name}" WITH (FORCE)`);
    if (!r.ok) return { ok: false, error: r.err.trim().slice(-200) };
  }
  await deleteInstance(inst.container_id, inst.name);
  logline('xell-db', `dropped clone database ${inst.name} (${xell.slug} torn down)`);
  return { ok: true };
}

// Provision a per-xell postgres and restore `dump` into it. Uses the SAME image as the source db
// so a dump actually restores (a prod dump will not load into a stock postgres — prod runs a
// custom postgis build).
async function provisionIsolatedDb({ project, xell, snapshot }) {
  const src = await sharedDb(project.id, 'prod') || await sharedDb(project.id, 'dev');
  const devSite = await resolveSite(project.id, 'dev');
  const ctx = devSite?.docker_ctx || project.docker_ctx_dev;
  const devHost = devSite?.host || project.dev_host_ip;
  const realSrc = MODE === 'real' ? resolveRealDbContainer(src?.docker_ctx || ctx, src?.name) : src?.name;
  const image = MODE === 'real'
    ? (spawnSync('docker', ['--context', src?.docker_ctx || ctx, 'inspect', '-f', '{{.Config.Image}}', realSrc],
        { encoding: 'utf8', timeout: 15000, windowsHide: true }).stdout || '').trim()
    : 'omnibiz-postgis:18-3.6-h3';
  const name = namingFor(project, 'db', xell.slug).container;
  // Do NOT derive the port from the slug: it collides with host services docker can't see.
  // The script publishes with -p 0 and reports the port docker actually chose.
  let port = 5400 + computePorts(xell.slug).slot;   // simulate-mode placeholder only

  if (MODE === 'real') {
    const script = resolve(config.repoRoot, 'scripts', 'provision-xell-db.sh');
    // Dump paths are Windows UNC with backslashes AND spaces
    // (\\10.1.0.18\maki\Omnibiz Backups\x.dump). Bash needs forward slashes; the spaces are
    // handled by passing it as a single argv entry (never interpolated into a command string).
    const dumpPath = snapshot?.dump_path ? String(snapshot.dump_path).replace(/\\/g, '/') : '';
    const r = spawnSync('bash', [script, name, ctx, image || 'omnibiz-postgis:18-3.6-h3',
      dumpPath, project.db_user || config.prodDbUser || 'postgres', project.db_name || config.prodDbName || 'omnibiz'],
      { encoding: 'utf8', timeout: 1800000, windowsHide: true });
    const line = (r.stdout || '').trim().split('\n').filter(Boolean).pop();
    let res = null; try { res = JSON.parse(line); } catch { /* no JSON */ }
    if (!res?.ok) throw new Error(`isolated db provision failed: ${res?.reason || (r.stderr || '').slice(-200)}`);
    port = Number(res.port) || port;
    logline('xell-db', `isolated db ${name} up on :${port} (${image})${res.restored ? ' — dump restored' : ''}`);
  }

  // Upsert: the container name is unique per project, and re-attaching (e.g. attach empty, then
  // attach again WITH a dump) must update the existing row — not explode on the unique key after
  // a 4-minute restore has already succeeded. Docker picks a new port each rebuild, so refresh it.
  const conn = `postgresql://${project.db_user || config.prodDbUser || 'postgres'}@${devHost}:${port}/${project.db_name || config.prodDbName || 'omnibiz'}`;
  const row = await one(
    `INSERT INTO container (project_id, role, tier, isolation, name, image_tag, docker_ctx, host,
                            host_port, internal_port, conn_ref, owner_xell_id, site_id, health)
     VALUES ($1,'db','spinoff','per-xell',$2,$3,$4,$5,$6,5432,$7,$8,$9,$10)
     ON CONFLICT (project_id, name) DO UPDATE
       SET image_tag=EXCLUDED.image_tag, docker_ctx=EXCLUDED.docker_ctx, host=EXCLUDED.host,
           host_port=EXCLUDED.host_port, conn_ref=EXCLUDED.conn_ref,
           owner_xell_id=EXCLUDED.owner_xell_id, site_id=EXCLUDED.site_id, health=EXCLUDED.health
     RETURNING *`,
    [project.id, name, image || null, ctx, devHost, port, conn,
     xell.id, devSite?.id || null, MODE === 'real' ? 'up' : 'down']);
  broadcast('container', row);
  return row;
}

// Point a xell at a database. Returns { coupling, container, restored_from }.
//   coupling  : 'db-shared-dev' | 'db-shared-prod' | 'db-isolated'
//   container : explicit container name/id — overrides coupling (attach ANY db, e.g. prod)
//   dump      : snapshot id, or 'latest' — only meaningful for db-isolated
// Which database is THIS worktree's, and may its zee touch it? Answers the prod-guard hook.
//
// The point: db_coupling='db-shared-prod' means the prod DB *is* this xell's assigned container —
// the human chose that at dispatch (`--db shared-prod`), so using it obeys "use only your assigned
// containers" rather than violating it. But the hook only sees a cwd and a command string, so it
// cannot tell "read the prod DB" (legitimate for a hotfix/data xell) from "deploy prod code"
// (never a zee's job). It asks here instead of guessing.
//
// Returns the xell's db container by NAME so the hook can allow exec against THAT one only — not
// into omnibiz_webapp_prod, and never a compose build.
export async function dbAccessForCwd(cwd) {
  const norm = (p) => String(p || '').replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();
  const target = norm(cwd);

  // Every db container's name, regardless of who owns it or whether the cwd resolves to a xell.
  // The guard needs this to tell "exec into a DATABASE" (where a read is nobody's business to
  // block) from "exec into omnibiz_webapp_prod" (a deploy by hand, always denied). Names only —
  // no credentials, nothing sensitive — and the guard still decides; this only informs it.
  //
  // RESOLVED names, not the inventory's logical ones. This endpoint is the machine-readable
  // answer to "which database is mine", so handing back `omnibiz_db_prod` names the EXITED
  // postgres:18beta1 husk rather than the live `omnibiz_db_prod_v184`. The guard tolerated that
  // by accident (it substring-matches, and the husk's name is a prefix of the real one), which is
  // exactly why it went unnoticed while every zee that copied the name got
  // "container … is not running" and concluded it was walled out of prod.
  const dbRows = await q(`SELECT name, docker_ctx FROM container WHERE role='db'`);
  const dbNames = dbRows.map((r) => resolveRealDbContainerCached(r.docker_ctx, r.name));

  if (!target) return { xell: null, allowed: false, reason: 'no cwd', db_containers: dbNames };

  const xells = await q(
    `SELECT id, slug, status, worktree_path, db_coupling, project_id FROM xell
       WHERE status <> 'retired' AND NOT is_production`);
  const xell = xells.find((x) => norm(x.worktree_path) === target);
  if (!xell) return { xell: null, allowed: false, reason: 'cwd is not a live xell worktree', db_containers: dbNames };

  const db = await one(
    `SELECT c.name, c.tier, c.docker_ctx FROM container c
       JOIN xell_uses_container uc ON uc.container_id = c.id
      WHERE uc.xell_id = $1 AND c.role = 'db' LIMIT 1`, [xell.id]);

  // HOLDING THE PROD LOCK is the second legitimate path to prod's database (the first is being
  // dispatched --db shared-prod). The lock is held during exactly one window: a ship's
  // verification — the queenzee assigned it to THIS xell when a human approved the ship, and the
  // whole point of the hold is to check the deploy landed sanely. A zee that just shipped and
  // cannot read prod to verify it is a gate defeating its own purpose (seen live: the tournament
  // zee, lock in hand, denied a SELECT against prod mid-verification). The window closes itself:
  // auto-release takes the lock — and this grant — away.
  const lock = await one(
    `SELECT phase FROM deploy_lock WHERE xell_id=$1 AND container='prod'`, [xell.id]);
  if (lock) {
    const prod = await one(
      `SELECT name, docker_ctx FROM container
        WHERE project_id=$1 AND role='db' AND tier='prod' LIMIT 1`, [xell.project_id]);
    if (prod) {
      return {
        xell: { slug: xell.slug, db_coupling: xell.db_coupling },
        db_container: resolveRealDbContainerCached(prod.docker_ctx, prod.name),
        db_containers: dbNames,
        docker_ctx: prod.docker_ctx,
        allowed: true,
        holds_prod_lock: true,
        reason: null,
      };
    }
  }

  return {
    xell: { slug: xell.slug, db_coupling: xell.db_coupling },
    db_container: db ? resolveRealDbContainerCached(db.docker_ctx, db.name) : null,
    // db-clone: the container is shared, but THIS database inside it is the xell's own.
    database: xell.db_coupling === 'db-clone'
      ? (await cloneInstanceFor(xell.id))?.name || null
      : null,
    db_containers: dbNames,
    docker_ctx: db?.docker_ctx || null,
    // Only a xell a human deliberately pointed at prod may touch prod data.
    allowed: xell.db_coupling === 'db-shared-prod' && !!db && db.tier === 'prod',
    reason: xell.db_coupling === 'db-shared-prod'
      ? (db ? null : 'db-shared-prod but no db container attached')
      : `this xell's database is '${xell.db_coupling}', not prod — and it does not hold the prod `
        + 'deploy lock (the lock holder may exec against the prod db during its verification window)',
  };
}

export async function attachXellDb(xellId, { coupling, container, dump } = {}) {
  // Validate the coupling BEFORE touching anything. An unrecognized value must NOT reach the dev
  // default at the bottom of the if/else: `--db prod` prefixes to `db-prod` (not a mode), landed in
  // that else, and SILENTLY attached DEV. The zee was then denied by the prod guard — which told it
  // to re-dispatch with `--db prod`, which did the same thing. A closed loop, and nothing anywhere
  // said why. Checked first so a bad flag costs a clear error instead of a re-pointed database.
  if (coupling && !(coupling in DB_MODES)) {
    throw new Error(`unknown db coupling "${coupling}" — valid: ${Object.keys(DB_MODES).join(', ')}. `
      + 'Note the flag value is prefixed with "db-": use `--db shared-prod`, not `--db prod`.');
  }

  const xell = await one(`SELECT * FROM xell WHERE id=$1`, [xellId]);
  if (!xell) throw new Error('xell not found');
  if (xell.is_production) throw new Error('production xell — refusing to re-point its database');
  const project = await one(`SELECT * FROM project WHERE id=$1`, [xell.project_id]);

  let target = null, mode = coupling || null, snapshot = null, cloneName = null;

  if (container) {
    target = await one(`SELECT * FROM container WHERE role='db' AND (name=$1 OR id::text=$1)`, [String(container)]);
    if (!target) throw new Error(`no db container matching "${container}"`);
    mode = target.tier === 'prod' ? 'db-shared-prod' : (target.tier === 'dev' ? 'db-shared-dev' : mode || 'db-shared-dev');
  } else if (mode === 'db-shared-prod') {
    target = await sharedDb(project.id, 'prod');
    if (!target) throw new Error('no prod db container registered for this project');
  } else if (mode === 'db-clone') {
    const r = await provisionCloneDb({ project, xell });
    target = r.target;
    cloneName = r.dbname;
  } else if (mode === 'db-isolated') {
    if (dump) {
      if (String(dump) === 'latest') {
        snapshot = await one(`SELECT * FROM db_snapshot WHERE project_id=$1 AND source='prod'
                                AND (status IS NULL OR status='finished') ORDER BY taken_at DESC LIMIT 1`, [project.id]);
      } else if (/^[0-9a-f-]{36}$/i.test(String(dump))) {
        snapshot = await one(`SELECT * FROM db_snapshot WHERE id=$1`, [dump]);
      } else {
        // Don't let a bad id reach postgres and surface as "invalid input syntax for type uuid".
        throw new Error(`dump must be a snapshot id (uuid) or "latest" — got "${dump}"`);
      }
      if (!snapshot) throw new Error(`no finished dump found for "${dump}"`);
    }
    target = await provisionIsolatedDb({ project, xell, snapshot });
  } else {
    mode = 'db-shared-dev';
    target = await sharedDb(project.id, 'dev');
    if (!target) throw new Error('no dev db container registered for this project');
  }

  // Re-point: drop the xell's existing db links, then attach the chosen one.
  await q(
    `DELETE FROM xell_uses_container uc USING container c
      WHERE uc.container_id=c.id AND uc.xell_id=$1 AND c.role='db'`, [xellId]);
  await q(
    `INSERT INTO xell_uses_container (xell_id, container_id, relation) VALUES ($1,$2,$3)
       ON CONFLICT DO NOTHING`,
    [xellId, target.id, target.owner_xell_id === xellId ? 'owns' : 'uses']);
  const row = await one(`UPDATE xell SET db_coupling=$2::db_coupling WHERE id=$1 RETURNING *`, [xellId, mode]);
  broadcast('xell', row);

  logline('xell-db', `${xell.slug} → ${mode} (${target.name}${cloneName ? ` / ${cloneName}` : ''})`
    + (snapshot ? ` restored from ${snapshot.dump_path}` : '')
    + (mode === 'db-shared-prod' ? '  ⚠ LIVE PRODUCTION DATA' : ''));

  return { coupling: mode, container: target.name, container_id: target.id, database: cloneName,
           restored_from: snapshot?.dump_path || null, prod: mode === 'db-shared-prod' };
}
