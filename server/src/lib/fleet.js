// Read model for the dashboard: project header, N-of-M status line, grouped container
// inventory, and one entry per xell (container stack + its live zee + runtime badge).
import { q, one } from '../db/pool.js';

export async function defaultProject() {
  return one(`SELECT * FROM project ORDER BY created_at LIMIT 1`);
}

export async function getFleet(projectId) {
  const project = projectId
    ? await one(`SELECT * FROM project WHERE id = $1`, [projectId])
    : await defaultProject();
  if (!project) return null;
  const pid = project.id;

  const pool = await one(`SELECT * FROM pool_config WHERE project_id = $1`, [pid]);

  // grouped container inventory
  const containers = await q(
    `SELECT id, role, tier, isolation, name, url, host_port, health, owner_xell_id,
            hot_build, last_build_commit, last_built_at, busy_since, busy_op
       FROM container WHERE project_id = $1
       ORDER BY role, tier, name`, [pid]);
  const groups = { db: [], server: [], webapp: [], other: [] };
  for (const c of containers) (groups[c.role] || groups.other).push(c);

  // xells with their resolved container stack + live zee + runtime label
  const xells = await q(
    `SELECT x.*, xo.ref AS xource_ref,
            z.id AS zee_id, z.name AS zee_name, z.status AS zee_status, z.title AS zee_title,
            z.claude_session_id, z.session_name, z.viewer_url, z.viewer_kind,
            z.cost_usd, z.attach_mode, z.cli_active, z.monitor_source, z.last_monitor_at,
            r.label AS runtime_label, r.key AS runtime_key,
            (SELECT t.id FROM task t WHERE t.xell_id = x.id
               AND t.status IN ('assigned','working') ORDER BY t.created_at DESC LIMIT 1) AS task_id,
            dl.container IS NOT NULL AS holds_prod_lock, dl.phase AS prod_lock_phase
       FROM xell x
       LEFT JOIN deploy_lock dl ON dl.xell_id = x.id AND dl.container = 'prod'
       JOIN xource xo ON xo.id = x.xource_id
       LEFT JOIN zee z ON z.xell_id = x.id
            AND z.status IN ('spawning','online','working','idle')
       LEFT JOIN agent_runtime r ON r.id = z.runtime_id
      WHERE x.project_id = $1 AND x.status <> 'retired'
      ORDER BY x.created_at`, [pid]);

  for (const x of xells) {
    const stack = await q(
      `SELECT c.id, c.role, c.name, c.url, c.tier, c.health, c.owner_xell_id,
              c.hot_build, c.last_build_commit, c.last_built_at, c.busy_since, c.busy_op, uc.relation
         FROM xell_uses_container uc JOIN container c ON c.id = uc.container_id
        WHERE uc.xell_id = $1
        ORDER BY CASE c.role WHEN 'db' THEN 1 WHEN 'server' THEN 2 WHEN 'webapp' THEN 3 ELSE 4 END`,
      [x.id]);
    x.stack = stack;
    // pretty-print the name column exactly like the mockup expects
    x.zee_display_name = x.zee_status === 'working' ? x.zee_name : null;
  }

  // production is a xell too, but it's not a pooled work-xell — exclude it from the counts
  const work = xells.filter((x) => !x.is_production);
  const total = work.length;
  const inUse = work.filter((x) => ['working', 'claimed', 'idle', 'awaiting-done'].includes(x.status)).length;
  const working = work.filter((x) => x.status === 'working').length;

  // prod backups: settings + most recent FINISHED dump + count, plus any in-flight job (so the
  // panel can show a spinner while a backup runs).
  const lastBackup = await one(
    `SELECT id, dump_path, size_bytes, taken_at, source, status FROM db_snapshot
       WHERE project_id=$1 AND source='prod' AND status='finished' ORDER BY taken_at DESC LIMIT 1`, [pid]);
  const runningBackup = await one(
    `SELECT id, dump_path, taken_at FROM db_snapshot
       WHERE project_id=$1 AND source='prod' AND status='running' ORDER BY taken_at DESC LIMIT 1`, [pid]);
  const backupCount = await one(
    `SELECT count(*)::int AS n FROM db_snapshot WHERE project_id=$1 AND source='prod' AND status='finished'`, [pid]);
  const backup = {
    config: {
      backup_dir: pool?.backup_dir ?? null,
      backup_interval_sec: pool?.backup_interval_sec ?? 86400,
      max_backups: pool?.max_backups ?? 14,
    },
    last: lastBackup,
    count: backupCount?.n ?? 0,
    running: runningBackup || null,
  };

  return {
    project,
    pool,
    status: { total, inUse, working, ready: work.filter((x) => x.status === 'ready').length },
    containers: groups,
    backup,
    xells,
  };
}

export async function listRuntimes() {
  return q(`SELECT id, key, label, vendor, viewer_kind, enabled, sort_order
              FROM agent_runtime ORDER BY sort_order, label`);
}
