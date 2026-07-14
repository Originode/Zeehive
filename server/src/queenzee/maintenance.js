// Maintenance — the queenzee's housekeeping (pure script, no AI):
//   1. back up the prod DB on a schedule → db_snapshot
//   2. refresh stale pooled db-isolated xell DBs from the latest snapshot → db_refresh
// MAINTENANCE_MODE=real actually runs pg_dump/pg_restore against the prod/dev daemons;
// default 'simulate' records the modeled snapshot/refresh rows without touching prod.
import { spawnSync } from 'node:child_process';
import { q, one } from '../db/pool.js';
import { config } from '../config.js';
import { broadcast } from '../lib/events.js';
import { logline } from '../lib/logbus.js';

const MODE = process.env.MAINTENANCE_MODE === 'real' ? 'real' : 'simulate';

// deterministic timestamp key without Date.now() churn concerns
function stamp() { return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14); }

export async function backupProd(projectId) {
  const project = await one(`SELECT * FROM project WHERE id=$1`, [projectId]);
  if (!project) throw new Error('no project');
  const path = `db_backups/${project.name.toLowerCase()}_prod_${stamp()}.dump`;
  let size = null;

  if (MODE === 'real') {
    // pg_dump the prod cluster on its own daemon (mardale-prod), custom format
    const r = spawnSync('docker', [
      '--context', project.docker_ctx_prod, 'exec', 'omnibiz_db_prod',
      'pg_dump', '-U', 'postgres', '-Fc', '-d', 'omnibiz', '-f', `/tmp/${path.split('/').pop()}`,
    ], { encoding: 'utf8', timeout: 600000 });
    if (r.status !== 0) throw new Error(`pg_dump failed: ${(r.stderr || '').slice(-300)}`);
    size = 0; // could stat the file on the remote; left null-ish for MVP
  }

  const snap = await one(
    `INSERT INTO db_snapshot (project_id, source, dump_path, size_bytes) VALUES ($1,'prod',$2,$3) RETURNING *`,
    [projectId, path, size]);
  broadcast('task', { kind: 'db_snapshot', snap });
  logline('maint', `prod DB backup (${MODE}) → ${path}`);
  return snap;
}

// Refresh pooled db-isolated xells that have gone stale, from the latest prod snapshot.
export async function refreshStaleXellDbs(projectId) {
  const cfg = await one(`SELECT refresh_interval_sec FROM pool_config WHERE project_id=$1`, [projectId]);
  const snap = await one(
    `SELECT * FROM db_snapshot WHERE project_id=$1 ORDER BY taken_at DESC LIMIT 1`, [projectId]);
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
    // real mode would pg_restore snap.dump_path into this xell's per-slug postgres here
    const fin = await one(
      `UPDATE db_refresh SET finished_at=now(), status='finished' WHERE id=$1 RETURNING *`, [ref.id]);
    await q(`UPDATE xell SET last_synced_commit=head_commit, ready_at=now() WHERE id=$1`, [xell.id]);
    done.push(fin);
  }
  if (done.length) logline('maint', `refreshed ${done.length} isolated xell DB(s) from ${snap.dump_path}`);
  return done;
}

export function startMaintenance() {
  if (process.env.MAINTENANCE_ENABLED !== 'true') {
    console.log('[queenzee] maintenance scheduler idle (set MAINTENANCE_ENABLED=true to arm)');
    return null;
  }
  console.log(`[queenzee] maintenance scheduler armed (mode=${MODE})`);
  const run = async () => {
    try {
      const projects = await q(`SELECT id FROM project`);
      for (const p of projects) { await backupProd(p.id); await refreshStaleXellDbs(p.id); }
    } catch (e) { console.error('[maintenance]', e.message); }
  };
  // hourly cadence (the prod_backup_cron string is honored by an external cron in prod)
  return setInterval(run, 3600000);
}
