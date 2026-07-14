// Project management for the header menu: add / remove a managed project.
// A project is the project-agnostic config row; creating one also seeds its xource
// (the read-only main branch it branches from) and a pool_config with sane defaults.
import { pool, one, q } from '../db/pool.js';
import { config } from '../config.js';
import { broadcast } from './events.js';

// Live statuses that mean a zee is actively bound — deleting such a project is refused.
const LIVE_ZEE = ['spawning', 'online', 'working', 'idle'];

export async function listProjects() {
  return q(
    `SELECT p.*,
            (SELECT count(*) FROM xell x WHERE x.project_id = p.id AND x.status <> 'retired') AS xell_count
       FROM project p ORDER BY p.created_at`);
}

// Create a project + its xource + pool_config. Only name & repo_root are required;
// everything else falls back to the OmniBiz-shaped defaults so a project is usable at once.
export async function createProject(body) {
  const name = (body.name || '').trim();
  const repoRoot = (body.repo_root || '').trim();
  if (!name) throw new Error('project name is required');
  if (!repoRoot) throw new Error('repo_root (project folder) is required');

  const mainBranch = (body.main_branch || 'main').trim();
  const clash = await one(`SELECT id FROM project WHERE name = $1`, [name]);
  if (clash) throw new Error(`a project named "${name}" already exists`);

  // default the pool's runtime to Claude Code (local) if present
  const rt = await one(
    `SELECT id FROM agent_runtime WHERE key = $1`,
    [body.default_runtime || 'claude-code-local']);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [project] } = await client.query(
      `INSERT INTO project (name, repo_root, main_branch, docker_ctx_dev, docker_ctx_prod,
          dev_host_ip, prod_host_ip, compose_dev, compose_spinoff, compose_prod, env_file,
          port_server_base, port_web_base, port_slot_mod)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
          COALESCE($12,3100), COALESCE($13,5200), COALESCE($14,90))
       RETURNING *`,
      [name, repoRoot, mainBranch,
       body.docker_ctx_dev || null, body.docker_ctx_prod || null,
       body.dev_host_ip || null, body.prod_host_ip || null,
       body.compose_dev || null, body.compose_spinoff || null, body.compose_prod || null,
       body.env_file || '.env',
       body.port_server_base || null, body.port_web_base || null, body.port_slot_mod || null]);

    await client.query(
      `INSERT INTO xource (project_id, ref, read_only) VALUES ($1,$2,true)
       ON CONFLICT (project_id, ref) DO NOTHING`,
      [project.id, mainBranch]);

    await client.query(
      `INSERT INTO pool_config (project_id, target_ready, default_source_coupling,
          default_db_coupling, default_runtime_id, refresh_interval_sec)
       VALUES ($1,$2,'sparse-overlay','db-shared-dev',$3,3600)
       ON CONFLICT (project_id) DO NOTHING`,
      [project.id, config.poolTargetReady, rt?.id || null]);

    await client.query('COMMIT');
    broadcast('project', project);
    return project;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Remove a project. Refused while any of its zees is live (unless force) — you don't want
// to yank the environment out from under a working session. The DELETE cascades to the
// project's xource / xells / containers / pool_config / tasks (all FK ON DELETE CASCADE).
export async function deleteProject(id, force = false) {
  const project = await one(`SELECT id, name FROM project WHERE id = $1`, [id]);
  if (!project) throw new Error('project not found');

  const count = await one(`SELECT count(*) FROM project`);
  if (Number(count.count) <= 1) throw new Error('cannot remove the only project');

  if (!force) {
    const live = await one(
      `SELECT count(*) FROM zee z JOIN xell x ON x.id = z.xell_id
         WHERE x.project_id = $1 AND z.status = ANY($2)`,
      [id, LIVE_ZEE]);
    if (Number(live.count) > 0) {
      throw new Error(`"${project.name}" has ${live.count} live zee(s) — stop them first, or force-remove`);
    }
  }

  await q(`DELETE FROM project WHERE id = $1`, [id]);
  broadcast('project', { id, deleted: true });
  return { ok: true, deleted: id, name: project.name };
}
