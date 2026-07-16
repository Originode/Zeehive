// Project management for the header menu: add / remove / edit a managed project.
// A project is the project-agnostic config row; creating one also seeds its xource
// (the read-only main branch it branches from), its deploy sites, and a pool_config.
// If the repo carries a zeehive.yml, onboarding reads it (spec §3.1): the manifest's
// declared compose files / env / ports / db identity become the row's values, and the
// parsed manifest is cached on the row (manifest_hash detects drift from the repo file).
import { writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pool, one, q } from '../db/pool.js';
import { config } from '../config.js';
import { broadcast } from './events.js';
import { loadManifest, projectDefaultsFromManifest, draftManifest } from './manifest.js';

// Live statuses that mean a zee is actively bound — deleting such a project is refused.
const LIVE_ZEE = ['spawning', 'online', 'working', 'idle'];

// The application database's identity — a PROJECT fact (spec Appendix A). The global
// PROD_DB_NAME/PROD_DB_USER env vars are last-resort fallback only: they cannot be right
// for two projects at once.
export async function dbIdentity(projectId) {
  const p = await one(`SELECT name, db_name, db_user FROM project WHERE id=$1`, [projectId]);
  return {
    name: p?.db_name || config.prodDbName || (p?.name || 'postgres').toLowerCase(),
    user: p?.db_user || config.prodDbUser || 'postgres',
  };
}

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

  // The repo's own manifest, if present, fills what the form didn't: explicit form values win,
  // then the manifest, then the OmniBiz-era defaults. An invalid manifest refuses onboarding
  // outright — a half-read manifest is worse than none.
  const mf = loadManifest(repoRoot);
  if (mf.found && mf.errors.length) {
    throw new Error(`${mf.file} is invalid: ${mf.errors.join('; ')}`);
  }
  const md = mf.found ? projectDefaultsFromManifest(mf.manifest) : {};

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
          port_server_base, port_web_base, port_slot_mod,
          db_name, db_user, manifest, manifest_hash, manifest_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
          COALESCE($12,3100), COALESCE($13,5200), COALESCE($14,90),
          $15,$16,$17,$18, CASE WHEN $17::jsonb IS NULL THEN NULL ELSE now() END)
       RETURNING *`,
      [name, repoRoot, mainBranch,
       body.docker_ctx_dev || null, body.docker_ctx_prod || null,
       body.dev_host_ip || null, body.prod_host_ip || null,
       body.compose_dev || md.compose_dev || null,
       body.compose_spinoff || md.compose_spinoff || null,
       body.compose_prod || md.compose_prod || null,
       body.env_file || md.env_file || '.env',
       body.port_server_base || md.port_server_base || null,
       body.port_web_base || md.port_web_base || null,
       body.port_slot_mod || md.port_slot_mod || null,
       body.db_name || md.db_name || name.toLowerCase(),
       body.db_user || md.db_user || 'postgres',
       mf.found ? JSON.stringify(mf.manifest) : null,
       mf.found ? mf.hash : null]);

    await client.query(
      `INSERT INTO xource (project_id, ref, read_only) VALUES ($1,$2,true)
       ON CONFLICT (project_id, ref) DO NOTHING`,
      [project.id, mainBranch]);

    // Deploy sites are the real "where" (spec §5); the columns above stay as deprecated
    // fallback. Every project gets a dev site ('default' = this machine's daemon when unset);
    // a prod site only if prod was actually configured — never invent one.
    await client.query(
      `INSERT INTO deploy_site (project_id, key, tier, docker_ctx, host, is_default)
       VALUES ($1,'dev','dev',COALESCE(NULLIF($2,''),'default'),$3,true)
       ON CONFLICT (project_id, key) DO NOTHING`,
      [project.id, body.docker_ctx_dev || null, body.dev_host_ip || null]);
    if (body.docker_ctx_prod) {
      await client.query(
        `INSERT INTO deploy_site (project_id, key, tier, docker_ctx, host, compose_file, is_default)
         VALUES ($1,$2,'prod',$2,$3,$4,true)
         ON CONFLICT (project_id, key) DO NOTHING`,
        [project.id, body.docker_ctx_prod, body.prod_host_ip || null, body.compose_prod || null]);
    }

    await client.query(
      `INSERT INTO pool_config (project_id, target_ready, default_source_coupling,
          default_db_coupling, default_runtime_id, refresh_interval_sec)
       VALUES ($1,$2,'sparse-overlay','db-shared-dev',$3,3600)
       ON CONFLICT (project_id) DO NOTHING`,
      [project.id, config.poolTargetReady, rt?.id || null]);

    await client.query('COMMIT');
    broadcast('project', project);
    // manifest warnings ride the response (missing compose files etc.) — advisory, not blocking
    return { ...project, manifest_found: mf.found || false, manifest_warnings: mf.warnings || [] };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── manifest lifecycle (spec §7 Phase 2.2–2.4) ───────────────────────────────

// Stored cache vs the repo file RIGHT NOW — drift means the repo changed since onboarding/refresh.
export async function getProjectManifest(id) {
  const p = await one(`SELECT id, name, repo_root, manifest, manifest_hash, manifest_at FROM project WHERE id=$1`, [id]);
  if (!p) throw new Error('project not found');
  const repo = loadManifest(p.repo_root);
  return {
    stored: { manifest: p.manifest, hash: p.manifest_hash, at: p.manifest_at },
    repo: repo.found
      ? { found: true, file: repo.file, hash: repo.hash, errors: repo.errors, warnings: repo.warnings }
      : { found: false },
    drift: repo.found ? repo.hash !== p.manifest_hash : false,
  };
}

// Re-read the repo's zeehive.yml and re-apply its declared fields to the row. Only the fields the
// manifest actually declares change; sites/contexts are untouched (machine facts, spec §3.2).
export async function refreshProjectManifest(id) {
  const p = await one(`SELECT id, repo_root FROM project WHERE id=$1`, [id]);
  if (!p) throw new Error('project not found');
  const repo = loadManifest(p.repo_root);
  if (!repo.found) throw new Error('no zeehive.yml in the repo — nothing to refresh from');
  if (repo.errors.length) throw new Error(`${repo.file} is invalid: ${repo.errors.join('; ')}`);

  const md = projectDefaultsFromManifest(repo.manifest);
  const sets = ['manifest = $2', 'manifest_hash = $3', 'manifest_at = now()'];
  const vals = [id, JSON.stringify(repo.manifest), repo.hash];
  for (const [k, v] of Object.entries(md)) { vals.push(v); sets.push(`${k} = $${vals.length}`); }
  const updated = await one(`UPDATE project SET ${sets.join(', ')} WHERE id=$1 RETURNING *`, vals);
  broadcast('project', updated);
  return { ...updated, manifest_warnings: repo.warnings };
}

// A best-effort zeehive.yml draft from a compose-file scan (spec §7 Phase 2.3). write:true puts
// it in the repo root — refused if one already exists; the human reviews and commits it.
export async function draftProjectManifest(id, { write = false } = {}) {
  const p = await one(`SELECT id, name, repo_root FROM project WHERE id=$1`, [id]);
  if (!p) throw new Error('project not found');
  const existing = loadManifest(p.repo_root);
  if (existing.found && write) throw new Error(`${existing.file} already exists — edit it instead`);
  const draft = draftManifest(p.repo_root, p.name);
  if (write) {
    writeFileSync(resolve(String(p.repo_root).replace(/\\/g, '/'), 'zeehive.yml'), draft);
  }
  return { draft, written: !!write, already_has: existing.found || false };
}

// Editable after creation — deployment/config facts a human discovers were wrong only once the
// project exists. Deliberately NOT here: repo_root (moving a repo under live worktrees is a
// migration, not a field edit) and anything xell-derived.
const PATCHABLE = [
  'name', 'main_branch', 'docker_ctx_dev', 'docker_ctx_prod', 'dev_host_ip', 'prod_host_ip',
  'compose_dev', 'compose_spinoff', 'compose_prod', 'env_file',
  'port_server_base', 'port_web_base', 'port_slot_mod',
];

export async function updateProject(id, body = {}) {
  const project = await one(`SELECT * FROM project WHERE id = $1`, [id]);
  if (!project) throw new Error('project not found');

  const sets = [], vals = [id];
  for (const f of PATCHABLE) {
    if (body[f] === undefined) continue;
    const v = typeof body[f] === 'string' ? (body[f].trim() || null) : body[f];
    if (f === 'name' && !v) throw new Error('project name cannot be empty');
    if (f === 'main_branch' && !v) throw new Error('main_branch cannot be empty');
    vals.push(v);
    sets.push(`${f} = $${vals.length}`);
  }
  if (!sets.length) return project;

  const updated = await one(`UPDATE project SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, vals);
  // A changed main branch needs its xource row, or the pool can't provision from it.
  if (body.main_branch && body.main_branch !== project.main_branch) {
    await q(`INSERT INTO xource (project_id, ref, read_only) VALUES ($1,$2,true)
             ON CONFLICT (project_id, ref) DO NOTHING`, [id, updated.main_branch]);
  }
  broadcast('project', updated);
  return updated;
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
