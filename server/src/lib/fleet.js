// Read model for the dashboard: project header, N-of-M status line, grouped container
// inventory, and one entry per xell (container stack + its live zee + runtime badge).
import { q, one } from '../db/pool.js';
import { projectHeads } from './git.js';
import { listMachines } from './machines.js';

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

  // Two local ref reads for the whole fleet, not one per xell — this is a dashboard poll.
  const heads = projectHeads(project.repo_root, project.main_branch || 'main');

  // What production is RUNNING: the last ship that actually landed. NULL until one does — see the
  // note in timeline.js getDiffs; nothing recorded the hand-deploys that predate the ship gate.
  const deployed = await one(
    `SELECT commit, finished_at FROM ship_request WHERE project_id=$1 AND status='shipped'
       ORDER BY finished_at DESC NULLS LAST LIMIT 1`, [pid]);

  // What each db container CONTAINS (db_instance, 019): primary + clone template + per-xell
  // clones. Shipped as a JSON aggregate so the chip can say what lives inside without another
  // round-trip; owner_slug names a clone's xell, and a clone with NO owner is an orphan worth
  // seeing. Non-db containers aggregate to [].
  const instancesAgg = `
    (SELECT coalesce(json_agg(json_build_object(
              'id', di.id, 'name', di.name, 'kind', di.kind,
              'owner_xell_id', di.owner_xell_id, 'owner_slug', ox.slug,
              'prod_diff', di.prod_diff, 'prod_diff_at', di.prod_diff_at,
              'refreshed_at', di.refreshed_at)
            ORDER BY CASE di.kind WHEN 'primary' THEN 0 WHEN 'template' THEN 1
                                  WHEN 'clone' THEN 2 ELSE 3 END, di.name), '[]'::json)
       FROM db_instance di LEFT JOIN xell ox ON ox.id = di.owner_xell_id
      WHERE di.container_id = c.id) AS instances`;

  // grouped container inventory
  const containers = await q(
    `SELECT c.id, c.role, c.tier, c.isolation, c.name, c.url, c.host_port, c.health,
            c.owner_xell_id, c.hot_build, c.last_build_commit, c.last_built_at,
            c.docker_ctx, c.build_ctx,
            -- where a PROCESS role (docker_ctx NULL) lives: its site's context, so the machine
            -- matrix can place it in the right column instead of 'elsewhere'
            (SELECT ds.docker_ctx FROM deploy_site ds WHERE ds.id = c.site_id) AS site_docker_ctx,
            c.busy_since, c.busy_op, c.prod_diff, c.prod_diff_at, ${instancesAgg}
       FROM container c WHERE c.project_id = $1
       ORDER BY c.role, c.tier, c.name`, [pid]);
  const groups = { db: [], server: [], webapp: [], other: [] };
  for (const c of containers) (groups[c.role] || groups.other).push(c);

  // The hive's machines with THIS project's pool sizes (machine_pool, 025) — the matrix renders
  // one column per row here, and its pool knob edits this project's number, not a global one.
  const machines = await listMachines(pid);

  // xells with their resolved container stack + live zee + runtime label
  const xells = await q(
    `SELECT x.*, xo.ref AS xource_ref,
            z.id AS zee_id, z.name AS zee_name, z.status AS zee_status, z.title AS zee_title,
            z.claude_session_id, z.session_name, z.viewer_url, z.viewer_kind,
            z.cost_usd, z.attach_mode, z.cli_active, z.monitor_source, z.last_monitor_at,
            z.permission_mode, z.kind AS zee_kind,
            r.label AS runtime_label, r.key AS runtime_key,
            (SELECT t.id FROM task t WHERE t.xell_id = x.id
               AND t.status IN ('assigned','working') ORDER BY t.created_at DESC LIMIT 1) AS task_id,
            dl.container IS NOT NULL AS holds_prod_lock, dl.phase AS prod_lock_phase
       FROM xell x
       LEFT JOIN deploy_lock dl ON dl.xell_id = x.id AND dl.container = 'prod'
       JOIN xource xo ON xo.id = x.xource_id
       -- The xell's zee, PREFERRING a living one but falling back to the most recent dead one.
       -- The old join took only living zees, so a session whose PROCESS died (app closed, laptop
       -- rebooted, one liveness blip) vanished from its card entirely — reading as "no session"
       -- when the session JSONL is on disk and resumable and the zee row still holds the viewer
       -- link. Process death is not session death; the card shows detached instead of nothing.
       LEFT JOIN LATERAL (
         SELECT * FROM zee zz WHERE zz.xell_id = x.id
          ORDER BY CASE WHEN zz.status IN ('spawning','online','working','idle') THEN 0 ELSE 1 END,
                   zz.created_at DESC
          LIMIT 1
       ) z ON true
       LEFT JOIN agent_runtime r ON r.id = z.runtime_id
      WHERE x.project_id = $1 AND x.status <> 'retired'
      ORDER BY x.created_at`, [pid]);

  for (const x of xells) {
    const stack = await q(
      `SELECT c.id, c.role, c.name, c.url, c.tier, c.health, c.owner_xell_id,
              c.hot_build, c.last_build_commit, c.last_built_at, c.busy_since, c.busy_op,
              c.docker_ctx, c.build_ctx,
              c.prod_diff, c.prod_diff_at, uc.relation, ${instancesAgg}
         FROM xell_uses_container uc JOIN container c ON c.id = uc.container_id
        WHERE uc.xell_id = $1
        ORDER BY CASE c.role WHEN 'db' THEN 1 WHEN 'server' THEN 2 WHEN 'webapp' THEN 3 ELSE 4 END`,
      [x.id]);
    x.stack = stack;
    // pretty-print the name column exactly like the mockup expects
    x.zee_display_name = x.zee_status === 'working' ? x.zee_name : null;

    // What this xell TRACKS (its xource), and the head that ref currently resolves to.
    //   a work xell → local main.
    //   production  → origin, the backup mirror. Read from the local origin/main tracking ref, so
    //                 this never touches the network — and nothing builds from it either.
    x.remote_source = x.is_production ? { ...heads.origin } : { ...heads.local };

    // Production's equivalent of a xell's head: the commit it is actually serving. Kept separate
    // from head_commit rather than overloading it — head_commit means "provisioned at", which is
    // a different (and, for prod, meaningless) question.
    if (x.is_production) x.deployed_commit = deployed?.commit || null;
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

  // Pushes to main being HELD for human verification. Open ones only: this drives a blocking
  // banner, and a blocked zee is stuck until someone acts on it.
  const landing = await q(
    `SELECT lr.*, x.slug AS xell_slug
       FROM land_request lr LEFT JOIN xell x ON x.id = lr.xell_id
       WHERE lr.project_id = $1 AND lr.status IN ('pending','approved')
       ORDER BY lr.requested_at DESC`, [pid]);

  // Ships awaiting a human, plus whoever holds prod right now. `auto_release_at` drives the
  // console's countdown + Hold prompt; the card renders a padlock on the holder.
  // Open ships, plus anything that FINISHED in the last 15 minutes: a card that vanished the
  // instant the build ended took its result — and its build log — with it, so the human's only
  // view of a just-shipped (or just-failed) deploy was gone before they could read it.
  const shipping = await q(
    `SELECT s.*, x.slug AS xell_slug FROM ship_request s JOIN xell x ON x.id = s.xell_id
       WHERE s.project_id = $1 AND (s.status IN ('pending','approved','shipping')
          OR (s.status IN ('shipped','failed')
              AND COALESCE(s.finished_at, s.decided_at) > now() - interval '15 minutes'))
       ORDER BY s.requested_at DESC`, [pid]);
  const prodLock = await one(
    `SELECT dl.*, x.slug AS xell_slug FROM deploy_lock dl JOIN xell x ON x.id = dl.xell_id
       WHERE dl.project_id = $1 AND dl.container = 'prod'`, [pid]);

  return {
    project,
    pool,
    heads,
    status: { total, inUse, working, ready: work.filter((x) => x.status === 'ready').length },
    containers: groups,
    machines,
    backup,
    xells,
    landing,
    shipping,
    prod_lock: prodLock || null,
  };
}

export async function listRuntimes() {
  return q(`SELECT id, key, label, vendor, viewer_kind, enabled, sort_order
              FROM agent_runtime ORDER BY sort_order, label`);
}
