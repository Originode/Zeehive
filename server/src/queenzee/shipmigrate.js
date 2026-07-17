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
function psql(db, args, input = null, timeout = 120000) {
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
async function prodDb(project, site = null) {
  const c = await one(
    `SELECT name, docker_ctx FROM container
      WHERE project_id=$1 AND role='db' AND tier='prod'
        AND ($2::uuid IS NULL OR site_id = $2::uuid OR (site_id IS NULL AND $3)) LIMIT 1`,
    [project.id, site?.id || null, !!site?.is_default]);
  if (!c) return null;
  return {
    ctx: c.docker_ctx, container: resolveRealDbContainer(c.docker_ctx, c.name),
    // db identity is a project fact (spec Appendix A); env vars are last-resort fallback
    user: project.db_user || config.prodDbUser || 'postgres',
    name: project.db_name || config.prodDbName || 'omnibiz',
  };
}

// What would this ship apply? Called at REQUEST time so the human approves with the list in view.
export async function pendingMigrations(project, sha, site = null) {
  const db = await prodDb(project, site);
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
  const db = await prodDb(project, site);
  if (!db) return { ok: false, error: 'no prod db container', applied: [] };
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
  const db = { ctx: c.docker_ctx, container: resolveRealDbContainer(c.docker_ctx, c.name),
               user: dbid.user, name: dbid.name };

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
