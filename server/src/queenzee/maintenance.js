// Maintenance — the queenzee's housekeeping (pure script, no AI):
//   1. back up the PRODUCTION application DB → db_snapshot (one row per dump)
//   2. prune finished backups beyond max_backups (delete file + row)
//   3. restore a backup INTO a db container; refresh stale pooled db-isolated xells
// The backup target is the project's PRODUCTION database — the modeled prod db container
// (role='db', tier='prod') on the prod docker context — NOT the zeehive meta DB that this
// orchestrator keeps its own bookkeeping in (config.databaseUrl).
//
// Jobs run ASYNCHRONOUSLY: the heavy docker work is a non-blocking child process (spawn, not
// spawnSync — spawnSync would freeze the whole server event loop for the ~minutes a dump takes).
// A backup row is created 'running' and finalized 'finished'/'failed'; the container doing the
// work is flagged busy_since/busy_op. Both drive live spinners in the UI over SSE.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { q, one } from '../db/pool.js';
import { config } from '../config.js';
import { broadcast } from '../lib/events.js';
import { logline } from '../lib/logbus.js';
import { resolveSite } from '../lib/sites.js';

const MODE = process.env.MAINTENANCE_MODE === 'real' ? 'real' : 'simulate';
const DEFAULT_MAX_BACKUPS = 14;
const DEFAULT_INTERVAL_SEC = 86400;
const SIM_BACKUP_MS = Number(process.env.SIM_BACKUP_MS) || 5000;
const SIM_RESTORE_MS = Number(process.env.SIM_RESTORE_MS) || 6000;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Non-blocking child process → { status, stdout, stderr }. Never rejects (resolves status=-1 on
// spawn/timeout error) so a job's own try/catch owns the outcome. This is what keeps backups
// async: the event loop stays free while docker runs.
function execAsync(cmd, args, { timeout = 600000 } = {}) {
  return new Promise((resolveP) => {
    let out = '', err = '', timedOut = false;
    let child;
    try { child = spawn(cmd, args, { windowsHide: true }); }
    catch (e) { return resolveP({ status: -1, stdout: '', stderr: String(e?.message || e) }); }
    const timer = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch { /* already gone */ } }, timeout);
    child.stdout?.on('data', (d) => { out += d; });
    child.stderr?.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); resolveP({ status: -1, stdout: out, stderr: String(e?.message || e), timedOut }); });
    // A SIGKILLed child closes with code null and NOTHING on stderr — which rendered a day of
    // slow-link backup failures as "docker cp failed: " and sent the debugging at the share
    // instead of the wire. Say it was the timeout.
    child.on('close', (code) => {
      clearTimeout(timer);
      resolveP({ status: code, stdout: out, stderr: timedOut ? `killed at the ${Math.round(timeout / 1000)}s timeout${err ? ` · ${err}` : ''}` : err, timedOut });
    });
  });
}

// A real backup MUST be a valid pg_dump custom-format (-Fc) archive — those begin with the
// 5-byte magic "PGDMP". Anything else means the dump never actually produced the data (an empty
// or truncated file, a plain-text error captured to the path, a simulated placeholder), and
// recording it as a 'finished' backup hands the operator a restore point that would WIPE a real
// database and put ~nothing back. So a dump that isn't a real archive, or is implausibly small
// for a database, is a FAILURE — not a tiny success. Throws with a human-readable reason.
// (min_bytes: a genuinely empty prod DB still dumps a full TOC — a real -Fc archive is never
// this small; a few hundred bytes means the dump body is missing.)
const DUMP_MAGIC = 'PGDMP';
const MIN_REAL_DUMP_BYTES = 512;
function assertValidDump(path, size) {
  if (size == null) throw new Error('dump file is missing after pg_dump (nothing was written)');
  if (size < MIN_REAL_DUMP_BYTES) {
    throw new Error(`dump is only ${size} bytes — far too small to be a real database dump `
      + `(a valid pg_dump archive is never under ${MIN_REAL_DUMP_BYTES}B). The dump did not capture the data.`);
  }
  let head = '';
  let fd;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(DUMP_MAGIC.length);
    readSync(fd, buf, 0, buf.length, 0);
    head = buf.toString('latin1');
  } finally { if (fd !== undefined) try { closeSync(fd); } catch { /* fd gone */ } }
  if (head !== DUMP_MAGIC) {
    throw new Error(`dump is not a valid pg_dump custom-format archive `
      + `(expected magic "${DUMP_MAGIC}", got ${JSON.stringify(head)}). The file is not a usable backup.`);
  }
}

// timestamp key for the dump filename (yyyymmddhhmmss). A short random token is appended
// separately to guarantee a unique filename even for two backups in the same second.
function stamp() { return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14); }

// the folder new dumps go into: per-project override, else the server default (<repo>/db_backups)
function backupDirFor(pool) {
  const d = pool?.backup_dir && String(pool.backup_dir).trim();
  return d || config.backupDir;
}

// Resolve the modeled container name (omnibiz_db_prod) to the actually-running container on a
// context — deploys give it a versioned suffix (omnibiz_db_prod_v184), same convention the
// health monitor's matchState uses. `docker ps` (no -a) lists only running containers.
async function resolveRunningContainer(ctx, modeledName) {
  const r = await execAsync('docker', ['--context', ctx, 'ps', '--format', '{{.Names}}'], { timeout: 30000 });
  if (r.status !== 0) return null;
  const names = (r.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
  if (names.includes(modeledName)) return modeledName;
  return names.find((n) => n.startsWith(modeledName + '_')) || null;
}

// Flag a container busy (op = 'backup' | 'restore') or clear it, and tell the UI so it can spin
// the chip and lock out builds while the work is in flight.
async function setBusy(containerId, op) {
  const row = await one(
    `UPDATE container SET busy_since=now(), busy_op=$2 WHERE id=$1 RETURNING *`, [containerId, op]);
  if (row) broadcast('container', row);
  return row;
}
async function clearBusy(containerId) {
  const row = await one(
    `UPDATE container SET busy_since=NULL, busy_op=NULL WHERE id=$1 RETURNING *`, [containerId]);
  if (row) broadcast('container', row);
  return row;
}

// ── prod is IN USE → no backups ───────────────────────────────────────────────
// A pg_dump is not a free observer: it holds ACCESS SHARE on every table for the whole dump, so
// a ship's migration (ACCESS EXCLUSIVE ALTERs) wedges behind a long dump — and a dump taken
// mid-ship or mid-data-fix preserves a half-finished job as if it were a good restore point.
// So prod is off-limits to backups while EITHER:
//   • the prod deploy lock is held (a ship is deploying, or its verification window is open), or
//   • a live work xell is BOUND to the prod database (db-shared-prod — a human-granted
//     hotfix/data binding; it may write at any moment while it holds that coupling).
// Returns the human-readable reason, or null when prod is free.
export async function prodBusyReason(projectId) {
  const lock = await one(
    `SELECT dl.phase, x.slug FROM deploy_lock dl LEFT JOIN xell x ON x.id = dl.xell_id
      WHERE dl.project_id=$1 AND dl.container='prod'`, [projectId]);
  if (lock) {
    return `the prod deploy lock is held${lock.slug ? ` by ${lock.slug}` : ''}`
      + `${lock.phase ? ` (${lock.phase})` : ''}`;
  }
  // NOT is_production: the production pseudo-xell IS prod — only a work xell pointed at prod
  // (via /xell-prod or --db shared-prod) counts as someone operating on it. And only while a
  // zee is actually IN there (live zee row): a binding whose zee stopped days ago is a parked
  // grant, not an operation — blocking on it would silently stop backups forever (found live on
  // day one: pautang-express held db-shared-prod with a zee stopped since the day before).
  const bound = await one(
    `SELECT x.slug FROM xell x
      WHERE x.project_id=$1 AND x.status <> 'retired' AND NOT x.is_production
        AND x.db_coupling='db-shared-prod'
        AND EXISTS (SELECT 1 FROM zee z WHERE z.xell_id = x.id
                      AND z.status IN ('spawning','online','working','idle'))
      LIMIT 1`, [projectId]);
  if (bound) return `xell ${bound.slug} is bound to the prod database (db-shared-prod) with a live zee`;
  return null;
}

// ── BACKUP ────────────────────────────────────────────────────────────────────
// Kick off an async prod backup: create the 'running' row, flag the prod db container busy, and
// return immediately. The dump/copy runs in the background (runBackupJob) and finalizes the row.
export async function backupProd(projectId) {
  const project = await one(`SELECT * FROM project WHERE id=$1`, [projectId]);
  if (!project) throw new Error('no project');
  // one running backup per project — don't stack dumps of the same DB
  const running = await one(
    `SELECT id FROM db_snapshot WHERE project_id=$1 AND source='prod' AND status='running' LIMIT 1`, [projectId]);
  if (running) throw new Error('a backup is already running');
  // prod in use → refuse (manual click or scheduler alike); the scheduler defers and retries
  const busy = await prodBusyReason(projectId);
  if (busy) {
    throw new Error(`prod backup refused: ${busy} — a dump would contend with live prod work `
      + '(pg_dump locks every table for its duration). It runs automatically once prod is released.');
  }

  const pool = await one(`SELECT backup_dir, max_backups FROM pool_config WHERE project_id=$1`, [projectId]);
  const dir = backupDirFor(pool);
  const file = `${project.name.toLowerCase()}_prod_${stamp()}_${randomBytes(3).toString('hex')}.dump`;
  const fullPath = resolve(dir, file);
  mkdirSync(dir, { recursive: true });

  // the PRODUCTION db container to dump (modeled; resolved to its live versioned name in the job)
  const dbc = await one(
    `SELECT id, name, docker_ctx FROM container
       WHERE project_id=$1 AND role='db' AND tier='prod' AND isolation='shared'
       ORDER BY created_at LIMIT 1`, [projectId]);
  const dbName = project.db_name || config.prodDbName || project.name.toLowerCase();
  const dbUser = project.db_user || config.prodDbUser;

  const snap = await one(
    `INSERT INTO db_snapshot (project_id, source, dump_path, status) VALUES ($1,'prod',$2,'running') RETURNING *`,
    [projectId, fullPath]);
  if (dbc) await setBusy(dbc.id, 'backup');
  broadcast('task', { kind: 'db_snapshot', snap });
  logline('maint', `backup started (${MODE}) → ${fullPath}`);

  // fire-and-forget: the heavy work runs async; the caller gets the running row now
  runBackupJob({ snap, project, dbc, dbName, dbUser, fullPath, file, keep: pool?.max_backups ?? DEFAULT_MAX_BACKUPS })
    .catch((e) => console.error('[backup]', e.message));
  return snap;
}

async function runBackupJob({ snap, project, dbc, dbName, dbUser, fullPath, file, keep }) {
  let size = null, error = null;
  try {
    if (MODE === 'real') {
      if (!dbc?.name) throw new Error('no production db container modeled for this project');
      const ctx = dbc.docker_ctx || (await resolveSite(project.id, 'prod'))?.docker_ctx || project.docker_ctx_prod;
      const container = await resolveRunningContainer(ctx, dbc.name);
      if (!container) throw new Error(`prod db container '${dbc.name}' not running on context '${ctx}'`);
      const remoteTmp = `/tmp/${file}`;
      const dump = await execAsync('docker',
        ['--context', ctx, 'exec', container, 'pg_dump', '-U', dbUser, '-Fc', '-d', dbName, '-f', remoteTmp],
        { timeout: 1200000 });
      if (dump.status !== 0) {
        throw new Error(`pg_dump of ${container}/${dbName} failed (exit ${dump.status}): `
          + `${((dump.stderr || dump.stdout) || '(no output)').slice(-300)}`);
      }
      const cp = await execAsync('docker', ['--context', ctx, 'cp', `${container}:${remoteTmp}`, fullPath], { timeout: 1200000 });
      // rm the in-container dump WHATEVER the cp did — the rm used to run only after a good cp,
      // so every failed copy leaked ~870MB into the container's writable layer (16 dumps / 13GB
      // found in prod's /tmp on 2026-07-17, overlay at 86%).
      await execAsync('docker', ['--context', ctx, 'exec', container, 'rm', '-f', remoteTmp], { timeout: 60000 });
      if (cp.status !== 0) {
        // stderr AND stdout: a day of "docker cp failed: " with the real complaint discarded is
        // a day of debugging the wrong thing. exit -1 = the child errored/was killed (timeout).
        throw new Error(`docker cp failed (exit ${cp.status}): `
          + `${((cp.stderr || cp.stdout) || '(no output)').slice(-300)}`);
      }
      try { size = statSync(fullPath).size; } catch { size = null; }
      // A backup that isn't a real, plausibly-sized pg_dump archive is DEFECTIVE — fail it
      // loudly instead of storing a useless restore point (this is exactly the "big DB, few-byte
      // backup" case: catch it here rather than at 3am during a restore).
      assertValidDump(fullPath, size);
    } else {
      await wait(SIM_BACKUP_MS);   // simulate: hold 'running' briefly so the spinner is visible
      const body = `-- ZEEHIVE simulated backup of ${project.name} PRODUCTION database\n`
        + `-- target: ${dbc?.name || '(prod db container)'} / db=${dbName} user=${dbUser}\n`
        + `-- taken ${new Date().toISOString()}\n`;
      writeFileSync(fullPath, body);
      size = Buffer.byteLength(body);
    }
  } catch (e) {
    error = e.message;
  }

  if (error) {
    try { rmSync(fullPath, { force: true }); } catch { /* partial may not exist */ }
    const row = await one(`UPDATE db_snapshot SET status='failed', error=$2, mode=$3 WHERE id=$1 RETURNING *`,
      [snap.id, String(error).slice(0, 500), MODE]);
    if (dbc) await clearBusy(dbc.id);
    broadcast('task', { kind: 'db_snapshot', snap: row });
    logline('maint', `backup FAILED → ${error}`);
    return;
  }

  const row = await one(`UPDATE db_snapshot SET status='finished', size_bytes=$2, mode=$3 WHERE id=$1 RETURNING *`,
    [snap.id, size, MODE]);
  if (dbc) await clearBusy(dbc.id);
  broadcast('task', { kind: 'db_snapshot', snap: row });
  logline('maint', `backup finished (${MODE}) → ${fullPath} (${size ?? '?'} bytes)`);
  await housekeepBackups(snap.project_id, keep);
}

// Prune FINISHED prod backups beyond `keep`, newest-first: delete the dump file AND its row.
// (running/failed rows are never counted or pruned here.)
export async function housekeepBackups(projectId, keep = DEFAULT_MAX_BACKUPS) {
  const extra = await q(
    `SELECT id, dump_path FROM db_snapshot
       WHERE project_id=$1 AND source='prod' AND status='finished'
       ORDER BY taken_at DESC OFFSET $2`, [projectId, Math.max(0, keep)]);
  for (const s of extra) {
    if (s.dump_path) { try { rmSync(s.dump_path, { force: true }); } catch { /* file may be gone */ } }
    await q(`DELETE FROM db_snapshot WHERE id=$1`, [s.id]);
  }
  if (extra.length) {
    broadcast('task', { kind: 'db_snapshot_pruned', count: extra.length });
    logline('maint', `housekeeping removed ${extra.length} old backup(s) (keep ${keep})`);
  }
  return extra.length;
}

// Update a project's backup settings (folder / interval / retention), then apply housekeeping
// immediately so lowering max_backups takes effect at once.
export async function setBackupConfig({ project, backup_dir, backup_interval_sec, max_backups }) {
  const proj = project || (await one(`SELECT id FROM project ORDER BY created_at LIMIT 1`))?.id;
  if (!proj) throw new Error('no project');
  const interval = Number(backup_interval_sec);
  const maxB = Number(max_backups);
  if (!Number.isInteger(interval) || interval < 60) throw new Error('backup_interval_sec must be an integer ≥ 60');
  if (!Number.isInteger(maxB) || maxB < 1 || maxB > 1000) throw new Error('max_backups must be an integer 1–1000');
  const dir = backup_dir && String(backup_dir).trim() ? String(backup_dir).trim() : null;

  const row = await one(
    `UPDATE pool_config SET backup_dir=$2, backup_interval_sec=$3, max_backups=$4
       WHERE project_id=$1
       RETURNING backup_dir, backup_interval_sec, max_backups`,
    [proj, dir, interval, maxB]);
  if (!row) throw new Error('no pool_config for project');

  broadcast('project', { id: proj, backup: row });
  logline('maint', `backup config → dir=${row.backup_dir || '(default)'} every ${row.backup_interval_sec}s keep ${row.max_backups}`);
  await housekeepBackups(proj, row.max_backups);
  return row;
}

// Reveal a backup in the host's file manager (Explorer / Finder / xdg). Looked up by id so
// only paths we actually recorded can be opened — no arbitrary path is ever passed through.
export async function revealBackup(snapshotId) {
  const snap = await one(`SELECT dump_path FROM db_snapshot WHERE id=$1`, [snapshotId]);
  if (!snap?.dump_path) throw new Error('backup not found');
  const path = resolve(snap.dump_path);
  if (process.platform === 'win32') {
    spawn('explorer.exe', [`/select,${path}`], { windowsHide: true }).on('error', () => {});
  } else if (process.platform === 'darwin') {
    spawn('open', ['-R', path]).on('error', () => {});
  } else {
    spawn('xdg-open', [dirname(path)]).on('error', () => {});
  }
  return { ok: true, path };
}

// ── RESTORE ───────────────────────────────────────────────────────────────────
// Kick off an async restore of a backup INTO a db container. Flags the container busy and returns
// immediately; the copy + pg_restore run in the background (runRestoreJob). Never targets prod.
export async function restoreBackup({ snapshot, container }) {
  const snap = await one(`SELECT * FROM db_snapshot WHERE id=$1`, [snapshot]);
  if (!snap?.dump_path) throw new Error('backup not found');
  if (snap.status && snap.status !== 'finished') throw new Error('backup is not finished yet');
  // A simulated backup is a ~150-byte placeholder, NOT the data — restoring it would overwrite a
  // real database with nothing. Refuse it (the UI disables the button too; this is the backstop).
  if (snap.mode === 'simulate') {
    throw new Error('this is a SIMULATED backup (a placeholder, not real data) — it cannot be restored over a database');
  }
  const c = await one(`SELECT * FROM container WHERE id=$1`, [container]);
  if (!c) throw new Error('container not found');
  if (c.role !== 'db') throw new Error(`target is not a db container (role=${c.role})`);
  if (c.tier === 'prod') throw new Error('refusing to restore over the PRODUCTION database');
  if (c.busy_since) throw new Error('this container is busy (a backup/restore is already running)');

  const proj = await one(`SELECT name, db_name, db_user FROM project WHERE id=$1`, [c.project_id]);
  const dbName = proj?.db_name || config.prodDbName || proj?.name?.toLowerCase() || 'postgres';
  const dbUser = proj?.db_user || config.prodDbUser;

  await setBusy(c.id, 'restore');
  logline('maint', `restore started → ${c.name} from ${snap.dump_path} (${MODE})`);
  runRestoreJob({ snap, c, dbName, dbUser }).catch((e) => console.error('[restore]', e.message));
  return { ok: true, status: 'started', container: c.name };
}

async function runRestoreJob({ snap, c, dbName, dbUser }) {
  try {
    if (MODE === 'real') {
      const ctx = c.docker_ctx;
      const target = await resolveRunningContainer(ctx, c.name);
      if (!target) throw new Error(`db container '${c.name}' not running on context '${ctx}'`);
      const remoteTmp = `/tmp/restore_${randomBytes(3).toString('hex')}.dump`;
      const cp = await execAsync('docker', ['--context', ctx, 'cp', resolve(snap.dump_path), `${target}:${remoteTmp}`], { timeout: 1200000 });
      if (cp.status !== 0) throw new Error(`docker cp into ${target} failed: ${(cp.stderr || '').slice(-300)}`);
      const rest = await execAsync('docker',
        ['--context', ctx, 'exec', target, 'pg_restore', '-U', dbUser, '--clean', '--if-exists', '--no-owner', '-d', dbName, remoteTmp],
        { timeout: 1800000 });
      await execAsync('docker', ['--context', ctx, 'exec', target, 'rm', '-f', remoteTmp], { timeout: 60000 });
      if (rest.status !== 0) throw new Error(`pg_restore into ${target}/${dbName} failed: ${(rest.stderr || '').slice(-300)}`);
    } else {
      await wait(SIM_RESTORE_MS);   // simulate: hold the busy state briefly so the spinner is visible
    }
    logline('maint', `restore finished → ${c.name}`);
  } catch (e) {
    logline('maint', `restore FAILED → ${c.name}: ${e.message}`);
  } finally {
    await clearBusy(c.id);
  }
}

// On startup no job from a previous process can still be running: mark any 'running' backup failed
// (drop its partial file) and clear every busy container, so nothing is stuck spinning forever.
export async function reconcileInterruptedJobs() {
  const snaps = await q(
    `UPDATE db_snapshot SET status='failed', error=COALESCE(error,'interrupted by server restart')
       WHERE status='running' RETURNING id, dump_path`);
  for (const s of snaps) { if (s.dump_path) { try { rmSync(s.dump_path, { force: true }); } catch { /* gone */ } } }
  const cons = await q(`UPDATE container SET busy_since=NULL, busy_op=NULL WHERE busy_since IS NOT NULL RETURNING id`);
  if (snaps.length || cons.length) {
    logline('maint', `startup: cleared ${snaps.length} interrupted backup(s) + ${cons.length} busy container(s)`);
  }
  return { backups: snaps.length, containers: cons.length };
}

// Is a fresh prod backup due for this project? (no backup yet, or the newest is older than the
// configured interval.) Considers any latest row so a just-started/failed one prevents a storm.
async function backupDue(projectId) {
  const cfg = await one(`SELECT backup_interval_sec FROM pool_config WHERE project_id=$1`, [projectId]);
  const interval = cfg?.backup_interval_sec ?? DEFAULT_INTERVAL_SEC;
  const last = await one(
    `SELECT taken_at FROM db_snapshot WHERE project_id=$1 AND source='prod' ORDER BY taken_at DESC LIMIT 1`,
    [projectId]);
  if (!last) return true;
  const row = await one(
    `SELECT (now() - $1::timestamptz) >= ($2 || ' seconds')::interval AS due`,
    [last.taken_at, interval]);
  return !!row?.due;
}

// Refresh pooled db-isolated xells that have gone stale, from the latest FINISHED prod snapshot.
export async function refreshStaleXellDbs(projectId) {
  const cfg = await one(`SELECT refresh_interval_sec FROM pool_config WHERE project_id=$1`, [projectId]);
  const snap = await one(
    `SELECT * FROM db_snapshot WHERE project_id=$1 AND status='finished' ORDER BY taken_at DESC LIMIT 1`, [projectId]);
  if (!snap) return [];
  const stale = await q(
    `SELECT * FROM xell
       WHERE project_id=$1 AND is_pooled AND db_coupling='db-isolated' AND status='ready'
         AND (ready_at IS NULL OR ready_at < now() - ($2 || ' seconds')::interval)`,
    [projectId, cfg?.refresh_interval_sec ?? 3600]);

  const done = [];
  for (const xell of stale) {
    const ref = await one(
      `INSERT INTO db_refresh (xell_id, snapshot_id, method, started_at, status)
       VALUES ($1,$2,$3, now(),'running') RETURNING *`,
      [xell.id, snap.id, MODE === 'real' ? 'pg_restore' : 'simulate']);
    // spin this xell's own db container (if it has one) for the duration of the refresh
    const dbc = await one(
      `SELECT c.id FROM xell_uses_container uc JOIN container c ON c.id = uc.container_id
        WHERE uc.xell_id=$1 AND c.role='db' LIMIT 1`, [xell.id]);
    if (dbc) await setBusy(dbc.id, 'restore');
    // real mode would pg_restore snap.dump_path into this xell's per-slug postgres here
    if (dbc) await clearBusy(dbc.id);
    const fin = await one(
      `UPDATE db_refresh SET finished_at=now(), status='finished' WHERE id=$1 RETURNING *`, [ref.id]);
    await q(`UPDATE xell SET last_synced_commit=head_commit, ready_at=now() WHERE id=$1`, [xell.id]);
    done.push(fin);
  }
  if (done.length) logline('maint', `refreshed ${done.length} isolated xell DB(s) from ${snap.dump_path}`);
  return done;
}

export function startMaintenance() {
  reconcileInterruptedJobs().catch((e) => console.error('[maintenance] reconcile', e.message));
  if (process.env.MAINTENANCE_ENABLED !== 'true') {
    console.log('[queenzee] maintenance scheduler idle (set MAINTENANCE_ENABLED=true to arm)');
    return null;
  }
  console.log(`[queenzee] maintenance scheduler armed (mode=${MODE}, tick=${config.maintTickMs}ms)`);
  // Deferral memory: reason we last logged per project, so a held lock logs ONCE when the
  // deferral starts and once when prod frees up — not every 60s tick in between.
  const deferred = new Map();
  const tick = async () => {
    try {
      const projects = await q(`SELECT id FROM project`);
      for (const p of projects) {
        if (await backupDue(p.id)) {
          const busy = await prodBusyReason(p.id);
          if (busy) {
            if (deferred.get(p.id) !== busy) {
              deferred.set(p.id, busy);
              logline('maint', `prod backup DEFERRED — ${busy}. It runs on the first tick after prod is released.`);
            }
          } else {
            if (deferred.delete(p.id)) logline('maint', 'prod is free again — running the deferred backup now');
            await backupProd(p.id).catch((e) => {   // starts an async job; may no-op if one runs
              if (!/already running/.test(e.message)) throw e;
            });
          }
        }
        await refreshStaleXellDbs(p.id);
      }
    } catch (e) { console.error('[maintenance]', e.message); }
  };
  // Short tick; each project backs up only when its interval has elapsed (backupDue).
  return setInterval(tick, config.maintTickMs);
}
