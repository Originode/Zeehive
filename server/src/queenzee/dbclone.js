// Schema-work watch — a xell that starts SCHEMA work gets its own database, automatically.
//
// The shared dev database is one catalog for every xell, so two xells doing DDL each tripped
// the other's /ooney schema gate (shared catalog = shared blame, and no gate can attribute
// drift). The contract is now: the shared dev db's schema is FROZEN, and schema work happens
// on a per-xell CLONE (db-clone — a template copy inside the same container, seconds).
//
// A zee should never have to know to ask. Its schema work is already visible in git: migration
// files under server/sql/migrations|ops on its branch (committed or not). This watch scans the
// live claims and attaches a clone to any db-shared-dev xell whose branch carries them — loudly,
// because a re-pointed DATABASE_URL only reaches the app tier on the next build.
//
// READ-ONLY toward the worktree (two git queries); the only writes are attachXellDb + the
// regenerated .zeehive.env projection.
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { q, one } from '../db/pool.js';
import { cleanGitEnv } from '../lib/git.js';
import { attachXellDb } from '../lib/xell-db.js';
import { emitXellEnv } from '../lib/provision.js';
import { logline } from '../lib/logbus.js';
import { SCHEMA_DIR, OPS_DIR } from './shipmigrate.js';

const MIG_PATHS = [SCHEMA_DIR, OPS_DIR];

const git = (cwd, args) => {
  const r = spawnSync('git', ['-C', cwd, ...args],
    { encoding: 'utf8', timeout: 20000, windowsHide: true, env: cleanGitEnv() });
  return r.status === 0 ? (r.stdout || '') : null;
};

// Does this worktree's branch carry migration work? Committed (diff against the fork point,
// three-dot) OR still sitting in the working tree (status --porcelain). Null = unreadable.
export function migrationWorkIn(worktree, main) {
  const committed = git(worktree, ['diff', '--name-only', `${main}...HEAD`, '--', ...MIG_PATHS]);
  const dirty = git(worktree, ['status', '--porcelain', '--', ...MIG_PATHS]);
  if (committed === null && dirty === null) return null;
  const files = new Set([
    ...(committed || '').split('\n').map((s) => s.trim()).filter(Boolean),
    ...(dirty || '').split('\n').map((s) => s.trim().replace(/^[A-Z?!]{1,2}\s+/, '')).filter(Boolean),
  ]);
  return [...files];
}

export async function dbCloneTick() {
  // Two populations: db-shared-dev claims that STARTED schema work (attach on evidence), and
  // db-clone claims whose clone was never actually cut (a pool default of db-clone provisions
  // the row lazily — the database itself is cut here, at first need).
  const xells = await q(
    `SELECT x.*, p.main_branch, p.name AS project_name FROM xell x JOIN project p ON p.id = x.project_id
      WHERE x.status = 'claimed' AND NOT x.is_production
        AND (x.db_coupling = 'db-shared-dev'
             OR (x.db_coupling = 'db-clone' AND NOT EXISTS (
                   SELECT 1 FROM db_instance di
                    WHERE di.owner_xell_id = x.id AND di.kind = 'clone')))`);
  let attached = 0;
  for (const x of xells) {
    try {
      if (!x.worktree_path || !existsSync(x.worktree_path)) continue;
      if (x.db_coupling === 'db-shared-dev') {
        const files = migrationWorkIn(x.worktree_path, x.main_branch || 'main');
        if (!files || !files.length) continue;
        logline('dbclone',
          `${x.slug} has SCHEMA work on its branch (${files.slice(0, 3).join(', ')}${files.length > 3 ? ', …' : ''}) `
          + '— attaching its own clone database so its DDL never lands on the shared dev db');
      }
      const r = await attachXellDb(x.id, { coupling: 'db-clone' });
      attached++;
      logline('dbclone',
        `${x.slug} → db-clone (${r.database} in ${r.container}). Its app tier still runs on the OLD `
        + 'DATABASE_URL until its next build — the zee is told to rebuild; nothing is restarted under it.');
      // regenerate the harness-free projection so the next build/compose picks the clone up
      await emitXellEnv(x.id).catch((e) => logline('dbclone', `${x.slug}: .zeehive.env not regenerated — ${e.message}`));
    } catch (e) {
      logline('dbclone', `could not attach a clone to ${x.slug}: ${e.message} — will retry next tick`);
    }
  }
  return { scanned: xells.length, attached };
}

export function startDbCloneWatch() {
  if (process.env.DBCLONE_ENABLED === 'false') {
    console.log('[queenzee] schema-work clone watch DISABLED (DBCLONE_ENABLED=false)');
    return null;
  }
  const interval = Number(process.env.DBCLONE_INTERVAL_MS) || 60000;
  console.log(`[queenzee] schema-work clone watch started (${interval}ms)`);
  const tick = () => dbCloneTick().catch((e) => console.error('[dbclone]', e.message));
  setTimeout(tick, 20000);   // let the API + docker contexts settle first
  return setInterval(tick, interval);
}
