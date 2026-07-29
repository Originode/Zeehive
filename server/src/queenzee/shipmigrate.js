// SQL MIGRATIONS RIDE THE SHIP — the missing half of "prod builds from main".
//
// OmniBiz had no migration ledger: sql/schema/ builds FRESH databases, so dev always had every
// table and prod (never rebuilt) silently fell behind — the known "afternoon lost to a missing
// kitchen_claim" class, re-confirmed today by 7 paddle.tournament columns that shipped in code
// months ago and never reached prod's actual database. Reconciling by hand worked once; a ship
// that cannot finish its own schema is a ship that does not fully ship.
//
// So: the LEDGER lives in the application database itself (zeehive_migrations — the thing it
// describes travels with the thing described), and the queenzee applies pending files as the
// FIRST step of runShip, before any container builds. One human approval covers code + schema;
// a failed migration fails the ship before new code goes live against a half-changed database.
//
// BASELINE: the repo carries 32 pre-ledger files, hand-applied (or not) over history. Creating
// the ledger records ALL files present at that moment as baseline WITHOUT executing anything —
// only files that appear after the baseline ever run. Files run in filename order; zees whose
// migrations must order should date-prefix them.
//
// TWO DIRECTORIES ride the ship, and the distinction is the zee's affordance, not the pipeline's:
//   server/sql/migrations/  schema (idempotent DDL)
//   server/sql/ops/         one-time DATA fixes (UPDATE/backfill — run once, ledgered)
// ops/ was invisible to the ship until 2026-07-17: a fix whose entire substance was two data
// statements passed every gate (data changes no catalog diff can see), shipped "LIVE", and left
// prod still broken — the zee had to be hand-bound to prod to run the SQL a human had already
// approved. An approved ship is approved WHOLE: code, schema, and data travel together.
// Each watched dir gets a `dir:<path>` marker row in the ledger; a dir seen for the first time
// on an EXISTING ledger baselines its pre-existing files exactly like ledger creation does.
import { spawnSync, spawn } from 'node:child_process';
import { q, one } from '../db/pool.js';
import { config } from '../config.js';
import { logline } from '../lib/logbus.js';
import { cleanGitEnv } from '../lib/git.js';
import { resolveRealDbContainer } from '../lib/xell-db.js';
import { cloneInstanceFor } from '../lib/db-instances.js';
import { catchupDelta } from './catchup-delta.js';
import { diffXellDbAgainstProd } from './proddiff.js';

// Schema dir first in sort order (m < o) — DDL lands before the data that may depend on it.
export const SCHEMA_DIR = 'server/sql/migrations';
export const OPS_DIR = 'server/sql/ops';
const MIG_DIRS = [SCHEMA_DIR, OPS_DIR];
// Dirs every ledger has watched since creation. A marker-less ledger (created before markers
// existed) covered exactly these — inserting their marker must NOT baseline, or a genuinely
// pending schema migration sitting on main would be swallowed unrun.
const LEGACY_WATCHED = new Set([SCHEMA_DIR]);
const LEDGER = 'zeehive_migrations';
const dirMarker = (dir) => `dir:${dir}`;

// Every migration file AT the given sha — read from git, never from a working tree, so the list
// is exactly what the approved commit carries.
export function listMigrationFiles(repoRoot, sha, dirs = MIG_DIRS) {
  const r = spawnSync('git', ['-C', repoRoot, 'ls-tree', '-r', '--name-only', sha, '--', ...dirs],
    { encoding: 'utf8', timeout: 20000, windowsHide: true, env: cleanGitEnv() });
  if (r.status !== 0) return null;
  return r.stdout.split('\n').map((s) => s.trim()).filter((s) => s.endsWith('.sql')).sort();
}

// `db` = the prodDb() handle: {ctx, container, user, name} — identity comes from the PROJECT
// row (db_name/db_user), never from a global.
// EXPORTED for the prod SEED gate (queenzee/seedgate.js), which runs approved seed files against
// the same production database through the same one door: one psql implementation, one set of
// timeout/ON_ERROR_STOP semantics, so a seed can never quietly get looser rules than a migration.
export function psql(db, args, input = null, timeout = 120000) {
  return new Promise((resolve) => {
    const child = spawn('docker', ['--context', db.ctx, 'exec', '-i', db.container,
      'psql', '-U', db.user, '-d', db.name,
      '-v', 'ON_ERROR_STOP=1', ...args], { windowsHide: true });
    let out = '', err = '';
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, timeout);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => { clearTimeout(t); resolve({ ok: false, out, err: String(e.message) }); });
    child.on('close', (code) => { clearTimeout(t); resolve({ ok: code === 0, out, err }); });
    if (input != null) child.stdin.write(input);
    child.stdin.end();
  });
}

async function insertBaseline(db, filenames, sha) {
  if (!filenames.length) return;
  const rows = filenames.map((f) => `('${f.replace(/'/g, "''")}', '${sha}', true)`).join(',');
  const seed = await psql(db, ['-c',
    `INSERT INTO ${LEDGER} (filename, sha, baseline) VALUES ${rows} ON CONFLICT DO NOTHING`]);
  if (!seed.ok) throw new Error(`cannot baseline ledger: ${seed.err.trim().slice(0, 200)}`);
}

// Ensure the ledger exists and every watched dir is marked; baselining (creation, or a dir newly
// watched) records files at `sha` WITHOUT executing anything. Returns the set of recorded
// filenames (markers excluded).
async function ledgerFiles(project, db, sha) {
  const probe = await psql(db, ['-tA', '-c', `SELECT filename FROM ${LEDGER}`]);
  if (probe.ok) {
    const rows = probe.out.split('\n').map((s) => s.trim()).filter(Boolean);
    const seen = new Set(rows);
    const done = new Set(rows.filter((f) => !f.startsWith('dir:')));
    for (const dir of MIG_DIRS) {
      if (seen.has(dirMarker(dir))) continue;
      // A dir this ledger has never watched: its history was hand-applied (or is stale by
      // design), exactly like the pre-ledger era — baseline what exists, run only what comes
      // after. LEGACY_WATCHED dirs were covered at creation and get their marker only.
      const files = LEGACY_WATCHED.has(dir) ? [] : (listMigrationFiles(project.repo_root, sha, [dir]) || []);
      await insertBaseline(db, [...files, dirMarker(dir)], sha);
      files.forEach((f) => done.add(f));
      if (files.length) logline('shipmigrate',
        `now watching ${dir} — BASELINED ${files.length} pre-existing file(s) without running them `
        + '(their effects are already in prod, or they are dead history). Only files added after this ride.');
    }
    return done;
  }
  if (!/does not exist/i.test(probe.err)) throw new Error(`ledger unreadable: ${probe.err.trim().slice(0, 200)}`);

  const create = await psql(db, ['-c',
    `CREATE TABLE IF NOT EXISTS ${LEDGER} (
       filename text PRIMARY KEY, sha text, applied_at timestamptz NOT NULL DEFAULT now(),
       baseline boolean NOT NULL DEFAULT false)`]);
  if (!create.ok) throw new Error(`cannot create ledger: ${create.err.trim().slice(0, 200)}`);

  const files = listMigrationFiles(project.repo_root, sha) || [];
  await insertBaseline(db, [...files, ...MIG_DIRS.map(dirMarker)], sha);
  logline('shipmigrate',
    `ledger created in ${db.container} — BASELINED ${files.length} pre-existing migration file(s) without `
    + 'running them (they predate the ledger; prod state already reflects history). Only new files run.');
  return new Set(files);
}

// `site` scopes to ONE prod site's database (spec §5.2 — the ledger is per-database, so per-site
// parity falls out naturally). NULL = default/legacy behavior; NULL-site container rows belong
// to the default site.
// EXPORTED (as prodDbHandle) for the seed gate: resolving WHICH container is this project's
// production database — versioned name and all — is subtle enough that a second copy of it is how
// you end up seeding a dev clone. One resolver, one answer.
export async function prodDb(project, site = null) {
  const c = await one(
    `SELECT name, docker_ctx, tier, host_port, conn_ref FROM container
      WHERE project_id=$1 AND role='db' AND tier='prod'
        AND ($2::uuid IS NULL OR site_id = $2::uuid OR (site_id IS NULL AND $3)) LIMIT 1`,
    [project.id, site?.id || null, !!site?.is_default]);
  if (!c) return null;
  return {
    ctx: c.docker_ctx, container: await resolveRealDbContainer(c.docker_ctx, c.name, { row: c }),
    tier: c.tier, host_port: c.host_port, conn_ref: c.conn_ref, logical: c.name,
    // db identity is a project fact (spec Appendix A); env vars are last-resort fallback
    user: project.db_user || config.prodDbUser || 'postgres',
    name: project.db_name || config.prodDbName || 'omnibiz',
  };
}

// The network host a conn_ref names — `postgresql://zeehive@meta-db:5432/zeehive` → `meta-db`.
// Only a DNS-style host counts: an IP, `localhost`, or the literal `null` some legacy rows carry
// is not an identity docker can confirm. Exported so the pure decision can be unit-tested.
export function connRefAlias(connRef) {
  try {
    const h = new URL(connRef).hostname;
    return /^[a-z][a-z0-9_.-]*$/i.test(h) && h !== 'null' && h !== 'localhost' ? h : null;
  } catch { return null; }
}

// Which ADDRESS the registry recorded for this row, and how docker must confirm it — PURE.
// A published host_port where the row has one; otherwise the network alias its conn_ref names,
// where the database publishes NOTHING and is reachable only on a docker network. A row carrying
// NEITHER is unaddressed and proves nothing.
//   → { mode: 'port', port }  |  { mode: 'alias', alias }  |  { mode: 'none' }
export function prodDbAddress(db) {
  if (db.host_port != null) return { mode: 'port', port: Number(db.host_port) };
  const alias = connRefAlias(db.conn_ref);
  return alias ? { mode: 'alias', alias } : { mode: 'none' };
}

// The docker inspect --format template for an address mode. Alias needs the network membership;
// a published port needs the port bindings.
function inspectFormatFor(mode) {
  return mode === 'alias' ? '{{json .NetworkSettings.Networks}}' : '{{json .NetworkSettings.Ports}}';
}

// PURE DECISION over (row-handle, docker-inspect-result) — the same shape pickDbContainer uses:
// no I/O, exported for tests. `inspect` mirrors a spawnSync result: { status, stdout, stderr }
// (pass null when we deliberately skipped the daemon because the pre-conditions already fail).
//
// resolveRealDbContainer maps the registry's logical prod name to a running container by durable
// identity, but a migration is irreversible — so before we apply anything we INDEPENDENTLY
// re-confirm the container we hold really is the registry's PRODUCTION database:
//   • the row we selected is tier='prod' (never a dev / clone row), and
//   • docker's OWN report says that container carries the ADDRESS the registry recorded for the
//     row — the published host_port where the row has one (omnibiz prod: 10.2.0.16:5432), or the
//     network alias its conn_ref names where the database publishes NOTHING and is reachable only
//     on a docker network (Zeehive's own meta db answers to `meta-db` on zeehive_default, and its
//     Ports map is {"5432/tcp": null} by design).
// A row carrying NEITHER address is refused: an unaddressed row proves nothing. And recording a
// port the container does not publish, to get past this guard, re-creates precisely the hazard it
// exists to stop — a stranger binding that port later would read as "this is prod".
// On 2026-07-23 a prod ship applied its migrations to a 7.7MB dev clone and reported success.
export function decideProdDbTarget(db, inspect) {
  if (db.tier !== 'prod') {
    return { ok: false, error: `refusing to migrate ${db.container}: the selected registry row is `
      + `tier='${db.tier}', not 'prod'` };
  }

  const addr = prodDbAddress(db);
  if (addr.mode === 'none') {
    return { ok: false, error: `refusing to migrate ${db.container}: the prod db row records neither `
      + 'a host_port nor a network host in conn_ref, so its identity cannot be confirmed — record '
      + 'one before shipping migrations' };
  }

  if (!inspect || inspect.status !== 0) {
    const tail = (inspect?.stderr || inspect?.error?.message || '').trim().split('\n').pop();
    return { ok: false, error: `refusing to migrate: cannot inspect ${db.container} on ${db.ctx} to `
      + `confirm it is prod — ${(tail || '').slice(0, 160)}` };
  }

  let seen;
  try { seen = JSON.parse(inspect.stdout || '{}') || {}; } catch { seen = {}; }

  if (addr.mode === 'alias') {
    const names = new Set();
    for (const net of Object.values(seen)) {
      for (const n of [...(net?.Aliases || []), ...(net?.DNSNames || [])]) names.add(n);
    }
    if (!names.has(addr.alias)) {
      return { ok: false, error: `refusing to migrate ${db.container}: it does not answer to the prod `
        + `db row's network name '${addr.alias}' (aliases: ${[...names].join(', ') || 'none'}). This is `
        + 'NOT the registry\'s production database — aborting before any write.' };
    }
    return { ok: true };
  }

  const published = new Set();
  for (const binds of Object.values(seen)) {
    for (const b of (binds || [])) if (b?.HostPort) published.add(Number(b.HostPort));
  }
  if (!published.has(addr.port)) {
    return { ok: false, error: `refusing to migrate ${db.container}: it does not publish the prod db `
      + `row's host_port ${db.host_port} (published: ${[...published].join(', ') || 'none'}). This is `
      + 'NOT the registry\'s production database — aborting before any write.' };
  }
  return { ok: true };
}

// ASSERT THE TARGET before any write. Thin I/O wrapper over decideProdDbTarget: pick the inspect
// format the address mode needs, run docker (skipping the daemon call entirely when the row already
// fails on tier or carries no address — those refusals need no daemon), and let the pure decider
// judge. See decideProdDbTarget for the full rationale.
export async function assertProdDbTarget(db) {
  const addr = prodDbAddress(db);
  const inspect = (db.tier === 'prod' && addr.mode !== 'none')
    ? spawnSync('docker', ['--context', db.ctx, 'inspect', '--format',
      inspectFormatFor(addr.mode), db.container],
      { encoding: 'utf8', timeout: 15000, windowsHide: true })
    : null;
  return decideProdDbTarget(db, inspect);
}

// What would this ship apply? Called at REQUEST time so the human approves with the list in view.
export async function pendingMigrations(project, sha, site = null) {
  let db;
  try { db = await prodDb(project, site); }
  catch (e) { return { ok: false, error: e.message, pending: [] }; }
  if (!db) return { ok: false, error: 'no prod db container', pending: [] };
  try {
    const done = await ledgerFiles(project, db, sha);
    const all = listMigrationFiles(project.repo_root, sha) || [];
    return { ok: true, pending: all.filter((f) => !done.has(f)) };
  } catch (e) {
    return { ok: false, error: e.message, pending: [] };
  }
}

// Apply `pending` files as they exist at `sha`, in filename order, each in its own transaction,
// ledgering each success in `db`. First failure stops the run. Shared by the prod ship and the
// per-xell dev apply — same files, same loop, so testing on a clone IS testing the deploy.
async function runPending(project, db, sha, pending) {
  const applied = [];
  for (const f of pending) {
    const show = spawnSync('git', ['-C', project.repo_root, 'show', `${sha}:${f}`],
      { encoding: 'utf8', timeout: 20000, windowsHide: true, env: cleanGitEnv() });
    if (show.status !== 0) return { ok: false, error: `cannot read ${f} at ${sha.slice(0, 8)}`, applied };

    const r = await psql(db, ['--single-transaction'], show.stdout);
    if (!r.ok) {
      logline('shipmigrate', `migration FAILED: ${f} — ${r.err.trim().split('\n').pop()}`);
      return { ok: false, error: `${f}: ${r.err.trim().split('\n').pop()?.slice(0, 300)}`, applied };
    }
    await psql(db, ['-c',
      `INSERT INTO ${LEDGER} (filename, sha) VALUES ('${f.replace(/'/g, "''")}', '${sha}') ON CONFLICT DO NOTHING`]);
    applied.push(f);
    logline('shipmigrate', `applied ${f} @ ${sha.slice(0, 8)} → ${db.container}/${db.name}`);
  }
  return { ok: true, applied };
}

// Apply everything pending at `sha` to PROD, recording each success. First failure stops the
// run — and the ship.
export async function applyMigrations(project, sha, site = null) {
  let db;
  try { db = await prodDb(project, site); }
  catch (e) { logline('shipmigrate', `migration ABORTED: ${e.message}`); return { ok: false, error: e.message, applied: [] }; }
  if (!db) return { ok: false, error: 'no prod db container', applied: [] };
  // Prove the target IS the registry's prod database before touching it. Refuse otherwise.
  const guard = await assertProdDbTarget(db);
  if (!guard.ok) { logline('shipmigrate', `migration ABORTED: ${guard.error}`); return { ok: false, error: guard.error, applied: [] }; }
  const { ok, error, pending } = await pendingMigrations(project, sha, site);
  if (!ok) return { ok: false, error, applied: [] };
  return runPending(project, db, sha, pending);
}

const gitOut = (cwd, args) => {
  const r = spawnSync('git', ['-C', cwd, ...args],
    { encoding: 'utf8', timeout: 20000, windowsHide: true, env: cleanGitEnv() });
  return r.status === 0 ? (r.stdout || '').trim() : null;
};

// Apply a XELL's pending migration files to its OWN database — the missing forward-apply for
// dev work. A zee writes server/sql/migrations/*.sql on its branch; this runs those files
// against its clone/isolated db so the migration is TESTED before it ever lands, and the
// /ooney schema gate then sees "prod + my pending migrations" — the green condition.
//
// The ledger is per-database (same table the prod ship uses). On first contact it is BASELINED
// at the branch's fork point from main: everything main carried when this xell branched is
// already reflected in the database it was cloned/restored from, so only files added SINCE —
// the zee's own, plus anything landed on main afterwards (idempotent DDL by contract) — run.
export async function applyMigrationsToXell(xellId) {
  const xell = await one(`SELECT * FROM xell WHERE id=$1`, [xellId]);
  if (!xell) return { ok: false, error: 'unknown xell', applied: [] };
  const project = await one(`SELECT * FROM project WHERE id=$1`, [xell.project_id]);

  if (xell.db_coupling === 'db-shared-prod') {
    return { ok: false, applied: [], error: 'your database IS live production — migrations reach prod '
      + 'only through an approved ship (/ooney), never by hand.' };
  }
  const clone = xell.db_coupling === 'db-clone' ? await cloneInstanceFor(xellId) : null;
  if (xell.db_coupling === 'db-shared-dev' || (xell.db_coupling === 'db-clone' && !clone)) {
    return { ok: false, applied: [], error: 'your database is the SHARED dev db — its schema is frozen, '
      + 'so migrations are not applied there. Attach your own clone first '
      + `(POST /api/xells/${xellId}/db {"coupling":"db-clone"}, or dispatch with --db clone); `
      + 'the queenzee also auto-attaches one when it sees migration files on your branch.' };
  }

  const c = await one(
    `SELECT c.* FROM container c JOIN xell_uses_container uc ON uc.container_id=c.id
      WHERE uc.xell_id=$1 AND c.role='db' LIMIT 1`, [xellId]);
  if (!c) return { ok: false, error: 'this xell has no database container linked', applied: [] };

  const dbid = {
    user: project.db_user || config.prodDbUser || 'postgres',
    name: clone ? clone.name : (project.db_name || config.prodDbName || 'omnibiz'),
  };
  let realContainer;
  try { realContainer = await resolveRealDbContainer(c.docker_ctx, c.name, { row: c }); }
  catch (e) { return { ok: false, error: e.message, applied: [] }; }
  const db = { ctx: c.docker_ctx, container: realContainer, user: dbid.user, name: dbid.name };

  const head = xell.worktree_path ? gitOut(xell.worktree_path, ['rev-parse', 'HEAD']) : null;
  if (!head) return { ok: false, error: 'cannot read the worktree HEAD — is the worktree still bound?', applied: [] };
  const main = project.main_branch || 'main';
  const base = gitOut(project.repo_root, ['merge-base', main, head]) || head;

  try {
    const done = await ledgerFiles(project, db, base);   // first contact baselines at the fork point
    const all = listMigrationFiles(project.repo_root, head) || [];
    const pending = all.filter((f) => !done.has(f));
    if (!pending.length) return { ok: true, applied: [], pending: [], database: db.name,
      note: 'nothing pending — your database already reflects every migration file on your branch.' };
    const r = await runPending(project, db, head, pending);
    return { ...r, pending, database: db.name };
  } catch (e) {
    return { ok: false, error: e.message, applied: [] };
  }
}

// ── CATCH UP TO PROD — roll a xell's OWN db FORWARD to prod's current schema ──────────────────────
//
// The gap applyMigrationsToXell (above) cannot close: it baselines at the branch FORK POINT, i.e. it
// assumes everything main carried at fork is already in the db. That is false for a STALE seed — a
// db-isolated restored from a three-week-old prod dump is missing every migration prod shipped since,
// and forward-apply baselines those away instead of running them. proddiff MEASURES that gap
// (`missing` = "prod has it, this db does not"); this closes it, forward, without discarding the
// zee's work — the same runPending loop the prod ship uses. See docs/schema-catchup-plan.md.
//
// The ledger IS prod's forward history: prod's zeehive_migrations lists exactly what prod ran, and
// every one of those files is on main (prod builds from main). So "catch up" = apply, to my db, the
// prod-ledger files my db does not yet reflect, in filename order, each in its own transaction,
// ledgered. NEVER touches prod (reads it read-only, after assertProdDbTarget) — writes only my db.

// My db's OWN ledger → Set<filename> (dir: markers excluded), or null if it has no ledger table.
async function ownLedgerFiles(db) {
  const r = await psql(db, ['-tA', '-c', `SELECT filename FROM ${LEDGER}`]);
  if (r.ok) {
    return new Set(r.out.split('\n').map((s) => s.trim())
      .filter((f) => f && !f.startsWith('dir:')));
  }
  if (/does not exist/i.test(r.err)) return null;
  throw new Error(`own ledger unreadable: ${r.err.trim().slice(0, 200)}`);
}

// PROD's ledger, READ-ONLY → the migrations prod actually RAN (baseline=false, no dir markers), as
// [{ filename, sha, applied_at }]. An absent ledger means prod has shipped no migration → nothing to
// catch up to.
async function prodRunMigrations(prodHandle) {
  const r = await psql(prodHandle, ['-tAF', '\x1f', '-c',
    `SELECT filename, sha, applied_at FROM ${LEDGER} WHERE baseline = false ORDER BY filename`]);
  if (!r.ok) {
    if (/does not exist/i.test(r.err)) return [];
    throw new Error(`prod ledger unreadable: ${r.err.trim().slice(0, 200)}`);
  }
  return r.out.split('\n').map((s) => s.trim()).filter(Boolean).map((line) => {
    const [filename, sha, applied_at] = line.split('\x1f');
    return { filename, sha: sha || null, applied_at };
  }).filter((x) => x.filename && !x.filename.startsWith('dir:'));
}

// The taken_at of the snapshot a db-isolated xell was restored from — recorded as a db_refresh row by
// provisionIsolatedDb. Only needed for the fallback (an isolated db whose dump did NOT carry the
// ledger table); when the dump carried it, ownLedgerFiles is exact and this is never consulted.
async function snapshotTakenAtFor(xellId) {
  const r = await one(
    `SELECT s.taken_at FROM db_refresh r JOIN db_snapshot s ON s.id = r.snapshot_id
      WHERE r.xell_id=$1 AND r.snapshot_id IS NOT NULL
      ORDER BY r.started_at DESC NULLS LAST LIMIT 1`, [xellId]);
  return r?.taken_at || null;
}

export async function catchUpXellToProd(xellId) {
  const xell = await one(`SELECT * FROM xell WHERE id=$1`, [xellId]);
  if (!xell) return { ok: false, error: 'unknown xell', applied: [] };
  const project = await one(`SELECT * FROM project WHERE id=$1`, [xell.project_id]);

  // Guards — mirror applyMigrationsToXell. Prod is already prod; the shared dev db is frozen.
  if (xell.db_coupling === 'db-shared-prod') {
    return { ok: false, applied: [], error: 'your database IS live production — it already carries the '
      + 'prod schema; migrations reach prod only through an approved ship (`zee ship`), never a catch-up.' };
  }
  const clone = xell.db_coupling === 'db-clone' ? await cloneInstanceFor(xellId) : null;
  if (xell.db_coupling === 'db-shared-dev' || (xell.db_coupling === 'db-clone' && !clone)) {
    return { ok: false, applied: [], error: 'your database is the SHARED dev db — its schema is frozen, '
      + 'so it is not caught up in place. Attach your own clone first '
      + `(POST /api/xells/${xellId}/db {"coupling":"db-clone"}, or dispatch with --db clone), then catch up.` };
  }

  // Resolve MY OWN db handle (clone instance name, or the isolated container).
  const c = await one(
    `SELECT c.* FROM container c JOIN xell_uses_container uc ON uc.container_id=c.id
      WHERE uc.xell_id=$1 AND c.role='db' LIMIT 1`, [xellId]);
  if (!c) return { ok: false, error: 'this xell has no database container linked', applied: [] };
  const dbid = {
    user: project.db_user || config.prodDbUser || 'postgres',
    name: clone ? clone.name : (project.db_name || config.prodDbName || 'omnibiz'),
  };
  let realMine;
  try { realMine = await resolveRealDbContainer(c.docker_ctx, c.name, { row: c }); }
  catch (e) { return { ok: false, error: e.message, applied: [] }; }
  const myDb = { ctx: c.docker_ctx, container: realMine, user: dbid.user, name: dbid.name };

  // Read PROD's ledger — but PROVE the handle really is prod first (we import files FROM it; the same
  // guard that stopped a ship migrating a 7.7MB clone stops us reading the wrong "prod").
  let prodHandle;
  try { prodHandle = await prodDb(project); }
  catch (e) { return { ok: false, error: e.message, applied: [] }; }
  if (!prodHandle) return { ok: false, error: 'no prod db container to catch up to', applied: [] };
  const guard = await assertProdDbTarget(prodHandle);
  if (!guard.ok) return { ok: false, error: `refusing to read the prod ledger: ${guard.error}`, applied: [] };

  let prodRun;
  try { prodRun = await prodRunMigrations(prodHandle); }
  catch (e) { return { ok: false, error: e.message, applied: [] }; }
  if (!prodRun.length) {
    return { ok: true, applied: [], pending: [], database: myDb.name,
      note: 'prod has run no ledgered migrations — there is nothing to catch up to.' };
  }

  // Baseline: what does MY db already reflect? Pick the delta accordingly (pure — catchup-delta.js).
  let own;
  try { own = await ownLedgerFiles(myDb); }
  catch (e) { return { ok: false, error: e.message, applied: [] }; }

  const main = project.main_branch || 'main';
  const mainSha = gitOut(project.repo_root, ['rev-parse', main]) || main;
  let d, baselineNote;

  if (own) {
    // The exact primary path: my db carries a ledger (isolated-from-full-dump has prod's, frozen at
    // dump time; a re-catch-up has last run's). Set-diff against prod's current ledger.
    d = catchupDelta(prodRun, { mode: 'ledger', done: own });
    baselineNote = "my db's own migration ledger";
  } else if (clone) {
    // A clone with no ledger yet: baseline at the branch fork point (dev ≈ main at fork), then apply
    // prod-ledger files after it. Create+baseline the ledger so runPending can ledger and future
    // catch-ups are cheap. Best-effort: the clone came from dev, so residual drift is reported below.
    const head = xell.worktree_path ? gitOut(xell.worktree_path, ['rev-parse', 'HEAD']) : null;
    const base = (head && gitOut(project.repo_root, ['merge-base', main, head])) || head || mainSha;
    const forkFiles = new Set(listMigrationFiles(project.repo_root, base) || []);
    d = catchupDelta(prodRun, { mode: 'clone', baselineDone: forkFiles });
    baselineNote = 'the branch fork point (clone had no ledger yet)';
    try { await ledgerFiles(project, myDb, base); }
    catch (e) { return { ok: false, error: `could not baseline the clone ledger: ${e.message}`, applied: [] }; }
  } else {
    // db-isolated whose dump did NOT carry the ledger (table-scoped, migration 042). Anchor on the
    // source snapshot's taken_at; without it a safe forward delta cannot be computed — recommend a
    // full re-restore rather than guess.
    const takenAt = await snapshotTakenAtFor(xellId);
    if (!takenAt) {
      return { ok: false, applied: [], recommend_restore: true,
        error: 'your isolated db carries no migration ledger (its dump was table-scoped or predates the '
          + 'ledger) and no source snapshot is on record, so a safe forward delta cannot be computed. '
          + 'Rebuild from the latest full prod snapshot: `zee db-catchup --restore`.' };
    }
    d = catchupDelta(prodRun, { mode: 'isolated', takenAt });
    baselineNote = `the source snapshot's taken_at (${takenAt})`;
    const create = await psql(myDb, ['-c',
      `CREATE TABLE IF NOT EXISTS ${LEDGER} (filename text PRIMARY KEY, sha text,
         applied_at timestamptz NOT NULL DEFAULT now(), baseline boolean NOT NULL DEFAULT false)`]);
    if (!create.ok) return { ok: false, error: `could not create the isolated ledger: ${create.err.trim().slice(-200)}`, applied: [] };
    const before = prodRun.filter((r) => new Date(r.applied_at).getTime() <= new Date(takenAt).getTime())
      .map((r) => r.filename);
    await insertBaseline(myDb, [...before, ...MIG_DIRS.map(dirMarker)], mainSha);
  }

  if (!d.delta.length) {
    return { ok: true, applied: [], pending: [], database: myDb.name, baseline: baselineNote,
      note: `nothing to catch up — your schema already reflects every migration prod has run (measured by ${baselineNote}).` };
  }

  // Apply the delta from the xource's main tip: every migration prod ran is a file on main, so main
  // tip carries them all (runPending reads `${sha}:${file}`, one transaction each, stopping at the
  // first failure and ledgering each success in MY db).
  const pending = d.delta.map((x) => x.filename);
  logline('shipmigrate', `${xell.slug}: catching ${myDb.name} up to prod — ${pending.length} migration(s) `
    + `prod has run that it lacks (baseline: ${baselineNote})`);
  const r = await runPending(project, myDb, mainSha, pending);

  // Verify: re-measure drift against prod so the chip is truthful and residual `missing` surfaces.
  let residual = null;
  try { const diff = await diffXellDbAgainstProd(project.id, xellId); if (diff && diff.ok) residual = diff.total; }
  catch { /* verification is best-effort — a caught-up db is still caught up if the diff can't run */ }

  return {
    ...r, pending, database: myDb.name, baseline: baselineNote, residual_missing: residual,
    recommend_restore: !!(r.ok && residual != null && residual > 0 && xell.db_coupling === 'db-isolated'),
  };
}

// ── BOOT-TIME migrations: the schema a ship applies when the new process STARTS ───────────────
//
// Ticket #12. Everything above is DEPLOY-TIME schema: files under server/sql/migrations|ops that
// the queenzee applies to the production database before the containers build, decided at request
// time so a human approves code and schema as one thing.
//
// But a project can also migrate ITSELF at boot — Zeehive does: `runMigrations()` in
// server/src/index.js applies db/migrations/*.sql to its own meta-DB as the new server comes up,
// because a self-ship IS the restart. Nothing here knew about that set, so `ship_request.migrations`
// was `[]` for every Zeehive ship and the card told the approving human "no migrations" while the
// deploy applied five to the live meta-DB — including one that repaired data loss and two that
// rewrote the manual every zee reads. The gate was less informative than the human believed.
//
// The two sets are NOT interchangeable and are deliberately kept apart: deploy-time runs under the
// queenzee's control, before anything swaps, and a failure stops the ship; boot-time runs inside the
// new process after the swap, where a failure leaves a started server on a partly-migrated schema.
// A card that merged them would misstate the risk of both.
export const BOOT_LEDGER = 'schema_migrations';   // written by runMigrations(); filename is the PK
export const BOOT_DIR_DEFAULT = 'db/migrations';

// Read a file out of the repo at a sha (null when absent) — the manifest AS THE DEPLOY WILL SEE IT.
function fileAt(repoRoot, sha, path) {
  const r = spawnSync('git', ['-C', repoRoot, 'show', `${sha}:${path}`],
    { encoding: 'utf8', timeout: 20000, windowsHide: true, env: cleanGitEnv() });
  return r.status === 0 ? r.stdout : null;
}

// WHICH directory (if any) this project migrates itself from at boot, decided from the project's
// SHAPE at the shipped sha — not from its name, so a fork or a rename keeps working.
//   1. `db: { boot_migrations: <dir|false> }` in zeehive.yml — explicit, and any project can opt in
//      or out. Read at the SHA, so the answer is the one the deploy will act on.
//   2. otherwise: a repo that carries BOTH db/migrations/*.sql AND the boot runner that applies
//      them (server/src/db/migrate.js, called from server/src/index.js) is self-migrating.
// Returns null when the project has no boot-applied schema at all (every normal project).
export function bootMigrationDir(project, sha) {
  const yml = fileAt(project.repo_root, sha, 'zeehive.yml');
  if (yml) {
    const m = yml.match(/^\s*boot_migrations:\s*(.+?)\s*$/m);
    if (m) {
      const v = m[1].replace(/^["']|["']$/g, '');
      if (/^(false|none|off|no)$/i.test(v)) return null;
      if (v) return v;
    }
  }
  const declared = project?.manifest?.db?.boot_migrations;
  if (declared === false) return null;
  if (typeof declared === 'string' && declared.trim()) return declared.trim();
  const files = listMigrationFiles(project.repo_root, sha, [BOOT_DIR_DEFAULT]);
  if (!files?.length) return null;
  const runner = fileAt(project.repo_root, sha, 'server/src/db/migrate.js');
  const boot = fileAt(project.repo_root, sha, 'server/src/index.js');
  return runner && boot && /runMigrations\s*\(/.test(boot) ? BOOT_DIR_DEFAULT : null;
}

// Is the production database of this project OUR OWN database? For a self-hosting Zeehive it is:
// the meta-DB the queenzee is connected to IS the prod db it ships. That matters because it can
// then be read over the existing pool instead of `docker exec psql` — more direct, and it works
// wherever the queenzee runs. Compared on host+port+database, never on string equality.
export function isOwnDatabase(connRef, databaseUrl = config.databaseUrl) {
  const parse = (s) => { try { return new URL(String(s).replace(/^postgres(ql)?:/, 'http:')); } catch { return null; } };
  const a = parse(connRef), b = parse(databaseUrl);
  if (!a || !b) return false;
  const host = (u) => (['localhost', '127.0.0.1', '::1'].includes(u.hostname) ? 'localhost' : u.hostname);
  return host(a) === host(b) && (a.port || '5432') === (b.port || '5432') && a.pathname === b.pathname;
}

// Which BOOT migrations a ship at `sha` will actually run, and against which ledger.
// Shape: { applicable, dir, ok, pending: [...], applied: n, via, error }
//   applicable:false → this project has no boot-applied schema (nothing to say on the card)
//   ok:false         → we could not READ the ledger. The card must say "unknown", never "none":
//                      an unreadable ledger silently rendering as zero is the whole bug.
// Never throws: a ship request must not fail because a ledger was unreachable.
export async function pendingBootMigrations(project, sha, site = null) {
  const dir = bootMigrationDir(project, sha);
  if (!dir) return { applicable: false, dir: null, ok: true, pending: [], applied: 0 };
  const all = listMigrationFiles(project.repo_root, sha, [dir]) || [];
  const base = { applicable: true, dir, pending: [], applied: 0 };
  try {
    const db = await prodDb(project, site);
    if (!db) return { ...base, ok: false, error: 'no prod db container registered — cannot read the boot ledger', pending: all };
    let applied = null;
    if (isOwnDatabase(db.conn_ref)) {
      // the self-hosting case: the prod database IS the meta-DB this queenzee is connected to
      const rows = await q(`SELECT filename FROM ${BOOT_LEDGER}`).catch((e) => {
        if (/does not exist/i.test(e.message)) return [];      // fresh database: everything is pending
        throw e;
      });
      applied = new Set(rows.map((r) => r.filename));
      return { ...base, ok: true, via: 'own-pool', applied: applied.size,
        pending: all.filter((f) => !applied.has(f.split('/').pop())) };
    }
    const r = await psql(db, ['-Atc', `SELECT filename FROM ${BOOT_LEDGER}`]);
    if (!r.ok) {
      if (/does not exist/i.test(r.err || '')) {
        return { ...base, ok: true, via: 'psql', applied: 0, pending: all };
      }
      return { ...base, ok: false, via: 'psql', pending: all,
        error: `could not read ${BOOT_LEDGER} on ${db.container}: ${(r.err || '').trim().split('\n').pop()?.slice(0, 200)}` };
    }
    applied = new Set(r.out.split('\n').map((s) => s.trim()).filter(Boolean));
    return { ...base, ok: true, via: 'psql', applied: applied.size,
      pending: all.filter((f) => !applied.has(f.split('/').pop())) };
  } catch (e) {
    return { ...base, ok: false, pending: all, error: String(e.message).slice(0, 200) };
  }
}
