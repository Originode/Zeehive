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
import { spawnSync, spawn } from 'node:child_process';
import { q, one } from '../db/pool.js';
import { config } from '../config.js';
import { logline } from '../lib/logbus.js';
import { cleanGitEnv } from '../lib/git.js';
import { resolveRealDbContainer } from '../lib/xell-db.js';

const MIG_DIR = 'server/sql/migrations';
const LEDGER = 'zeehive_migrations';

// Every migration file AT the given sha — read from git, never from a working tree, so the list
// is exactly what the approved commit carries.
export function listMigrationFiles(repoRoot, sha) {
  const r = spawnSync('git', ['-C', repoRoot, 'ls-tree', '-r', '--name-only', sha, '--', MIG_DIR],
    { encoding: 'utf8', timeout: 20000, windowsHide: true, env: cleanGitEnv() });
  if (r.status !== 0) return null;
  return r.stdout.split('\n').map((s) => s.trim()).filter((s) => s.endsWith('.sql')).sort();
}

function psql(ctx, container, args, input = null, timeout = 120000) {
  return new Promise((resolve) => {
    const child = spawn('docker', ['--context', ctx, 'exec', '-i', container,
      'psql', '-U', config.prodDbUser || 'postgres', '-d', config.prodDbName || 'omnibiz',
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

// Ensure the ledger exists; if this call CREATES it, baseline every file at `sha` as applied
// without running anything. Returns the set of recorded filenames.
async function ledgerFiles(project, ctx, container, sha) {
  const probe = await psql(ctx, container, ['-tA', '-c', `SELECT filename FROM ${LEDGER}`]);
  if (probe.ok) return new Set(probe.out.split('\n').map((s) => s.trim()).filter(Boolean));
  if (!/does not exist/i.test(probe.err)) throw new Error(`ledger unreadable: ${probe.err.trim().slice(0, 200)}`);

  const create = await psql(ctx, container, ['-c',
    `CREATE TABLE IF NOT EXISTS ${LEDGER} (
       filename text PRIMARY KEY, sha text, applied_at timestamptz NOT NULL DEFAULT now(),
       baseline boolean NOT NULL DEFAULT false)`]);
  if (!create.ok) throw new Error(`cannot create ledger: ${create.err.trim().slice(0, 200)}`);

  const files = listMigrationFiles(project.repo_root, sha) || [];
  if (files.length) {
    const rows = files.map((f) => `('${f.replace(/'/g, "''")}', '${sha}', true)`).join(',');
    const seed = await psql(ctx, container, ['-c',
      `INSERT INTO ${LEDGER} (filename, sha, baseline) VALUES ${rows} ON CONFLICT DO NOTHING`]);
    if (!seed.ok) throw new Error(`cannot baseline ledger: ${seed.err.trim().slice(0, 200)}`);
  }
  logline('shipmigrate',
    `ledger created in ${container} — BASELINED ${files.length} pre-existing migration file(s) without `
    + 'running them (they predate the ledger; prod state already reflects history). Only new files run.');
  return new Set(files);
}

async function prodDb(project) {
  const c = await one(
    `SELECT name, docker_ctx FROM container WHERE project_id=$1 AND role='db' AND tier='prod' LIMIT 1`,
    [project.id]);
  if (!c) return null;
  return { ctx: c.docker_ctx, container: resolveRealDbContainer(c.docker_ctx, c.name) };
}

// What would this ship apply? Called at REQUEST time so the human approves with the list in view.
export async function pendingMigrations(project, sha) {
  const db = await prodDb(project);
  if (!db) return { ok: false, error: 'no prod db container', pending: [] };
  try {
    const done = await ledgerFiles(project, db.ctx, db.container, sha);
    const all = listMigrationFiles(project.repo_root, sha) || [];
    return { ok: true, pending: all.filter((f) => !done.has(f)) };
  } catch (e) {
    return { ok: false, error: e.message, pending: [] };
  }
}

// Apply everything pending at `sha`, in filename order, each file in its own transaction,
// recording each success. First failure stops the run — and the ship.
export async function applyMigrations(project, sha) {
  const db = await prodDb(project);
  if (!db) return { ok: false, error: 'no prod db container', applied: [] };
  const { ok, error, pending } = await pendingMigrations(project, sha);
  if (!ok) return { ok: false, error, applied: [] };

  const applied = [];
  for (const f of pending) {
    const show = spawnSync('git', ['-C', project.repo_root, 'show', `${sha}:${f}`],
      { encoding: 'utf8', timeout: 20000, windowsHide: true, env: cleanGitEnv() });
    if (show.status !== 0) return { ok: false, error: `cannot read ${f} at ${sha.slice(0, 8)}`, applied };

    const r = await psql(db.ctx, db.container, ['--single-transaction'], show.stdout);
    if (!r.ok) {
      logline('shipmigrate', `migration FAILED: ${f} — ${r.err.trim().split('\n').pop()}`);
      return { ok: false, error: `${f}: ${r.err.trim().split('\n').pop()?.slice(0, 300)}`, applied };
    }
    await psql(db.ctx, db.container, ['-c',
      `INSERT INTO ${LEDGER} (filename, sha) VALUES ('${f.replace(/'/g, "''")}', '${sha}') ON CONFLICT DO NOTHING`]);
    applied.push(f);
    logline('shipmigrate', `applied ${f} @ ${sha.slice(0, 8)}`);
  }
  return { ok: true, applied };
}
