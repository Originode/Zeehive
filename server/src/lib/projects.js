// Project management for the header menu: add / remove / edit a managed project.
// A project is the project-agnostic config row; creating one also seeds its xource
// (the read-only main branch it branches from), its deploy sites, and a pool_config.
// If the repo carries a zeehive.yml, onboarding reads it (spec §3.1): the manifest's
// declared compose files / env / ports / db identity become the row's values, and the
// parsed manifest is cached on the row (manifest_hash detects drift from the repo file).
import { writeFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pool, one, q } from '../db/pool.js';
import { config } from '../config.js';
import { broadcast } from './events.js';
import { logline } from './logbus.js';
import { cleanGitEnv } from './git.js';
import { resolveBash } from './bash.js';
import { probeRemote, cloneFromRemote, pullRemote } from './remote-git.js';
import { setProviderToken, tokenForSpawn } from './provider-tokens.js';
import { loadManifest, projectDefaultsFromManifest, draftManifest } from './manifest.js';
import { resolveSite } from './sites.js';

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
          db_name, db_user, manifest, manifest_hash, manifest_at, remote_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
          COALESCE($12,3100), COALESCE($13,5200), COALESCE($14,90),
          $15,$16,$17,$18, CASE WHEN $17::jsonb IS NULL THEN NULL ELSE now() END, $19)
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
       mf.found ? mf.hash : null,
       (body.remote_url || '').trim() || null]);

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

    // NEW projects start with pool target 0: a half-configured project must not have a
    // REAL-mode queenzee cutting worktrees for it as an onboarding side effect. The readiness
    // checklist prompts raising it once the gates pass.
    await client.query(
      `INSERT INTO pool_config (project_id, target_ready, default_source_coupling,
          default_db_coupling, default_runtime_id, refresh_interval_sec)
       VALUES ($1,$2,'sparse-overlay','db-shared-dev',$3,3600)
       ON CONFLICT (project_id) DO NOTHING`,
      [project.id, Number(body.pool_target) || 0, rt?.id || null]);

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

// ── GitHub inbound: New Project by clone, human-triggered pull ───────────────
// GitHub is TRANSPORT, not a dependency (Mark, 2026-07-20): these two verbs only ever fetch.
// Nothing in Zeehive pushes to the remote — Mark pushes by hand — and every other flow
// (landing, provisioning, prod builds) keeps working with the remote unreachable.

// Draft a project from a remote URL: probe → clone → the normal createProject. The clone is a
// full ordinary clone (its origin = remote_url); the xource/sites/pool seeding is exactly the
// folder-onboarding path, so a cloned project behaves identically from row one.
export async function cloneProject(body = {}) {
  const url = String(body.remote_url || '').trim();
  if (!url) throw new Error('remote_url is required');
  const token = String(body.token || '').trim() || null;

  const name = String(body.name || '').trim()
    || basename(url).replace(/\.git$/i, '');
  if (!name) throw new Error('project name is required (could not derive one from the URL)');
  const clash = await one(`SELECT id FROM project WHERE name = $1`, [name]);
  if (clash) throw new Error(`a project named "${name}" already exists`);

  const dest = String(body.dest || '').trim().replace(/\\/g, '/')
    || (config.reposDir ? join(config.reposDir, name).replace(/\\/g, '/') : null);
  if (!dest) throw new Error('dest (destination folder) is required — no REPOS_DIR default is configured');

  // fail fast and resolve the default branch before any disk write
  const probe = await probeRemote(url, { token });
  if (!probe.reachable) {
    throw new Error(probe.auth_required
      ? 'remote requires authentication — provide a read-only GitHub token'
      : `remote unreachable: ${probe.error}`);
  }
  const mainBranch = String(body.main_branch || '').trim() || probe.default_branch || 'main';

  logline('projects', `cloning ${url} → ${dest} (branch ${mainBranch})`);
  const cl = await cloneFromRemote({
    url, dest, branch: mainBranch, token,
    onProgress: (line) => logline('projects', `clone ${name}: ${line}`),
  });
  if (!cl.cloned) throw new Error(`clone failed: ${cl.reason}`);

  let project;
  try {
    project = await createProject({ ...body, name, main_branch: mainBranch, repo_root: dest, remote_url: url });
  } catch (err) {
    // the clone was ours alone — remove it so a corrected retry starts clean
    try { const { rm } = await import('node:fs/promises'); await rm(dest, { recursive: true, force: true }); } catch { /* best effort */ }
    throw err;
  }

  // Best-effort: an unrecognized-but-working token shape must not fail the clone AFTER the
  // project exists — the clone already proved the token works; storage is for future Pulls.
  let tokenWarning = null;
  if (token) {
    try { await setProviderToken(project.id, 'github', token); }
    catch (err) { tokenWarning = `github token not stored for future pulls: ${err.message}`; logline('projects', `${name}: ${tokenWarning}`); }
  }

  // Landing pushes into this checkout's CURRENT branch (`git push . HEAD:main`), which a
  // non-bare repo refuses by default (receive.denyCurrentBranch=refuse — seen live: the first
  // in-container land bounced with "work tree inconsistent"). updateInstead is what the
  // host-era xources run, set by hand back then: an accepted push also updates the working
  // tree, so the checkout tracks landed main. Encode it here so every clone is landing-ready.
  spawnSync('git', ['-C', dest, 'config', 'receive.denyCurrentBranch', 'updateInstead'],
    { encoding: 'utf8', timeout: 15000, windowsHide: true, env: cleanGitEnv() });

  // Best-effort landing-gate install (machine-local hook; folder onboarding leaves this manual).
  // A failure is a warning on the response, never a rollback — the gate can be installed later.
  let gateWarning = null;
  try {
    const r = spawnSync(resolveBash(),
      [resolve(config.repoRoot, 'scripts', 'install-land-gate.sh'), dest, project.id, mainBranch, config.apiBase],
      { encoding: 'utf8', timeout: 30000, windowsHide: true, env: cleanGitEnv() });
    if (r.status !== 0) gateWarning = `landing gate not installed: ${(r.stderr || r.stdout || 'unknown').trim().slice(-200)}`;
  } catch (err) {
    gateWarning = `landing gate not installed: ${err.message}`;
  }
  if (gateWarning) logline('projects', `${name}: ${gateWarning}`);

  logline('projects', `cloned ${name} from ${url} (${mainBranch})`);
  return { ...project, gate_warning: gateWarning, token_warning: tokenWarning };
}

// Fetch + ff-only merge of the recorded remote into the xource checkout. Human-triggered from
// the console; refusals (dirty tree, divergence, wrong branch) come back as {pulled:false,
// reason} for the refuse-with-reason UI convention.
export async function pullProject(id, by = 'human@console') {
  const p = await one(`SELECT * FROM project WHERE id=$1`, [id]);
  if (!p) throw new Error('project not found');
  if (!p.remote_url) return { pulled: false, state: 'refused', reason: 'project has no remote_url — set one in Project setup first' };

  let token = null;
  try { token = (await tokenForSpawn(p.id, 'github'))?.token || null; } catch { /* no token = anonymous fetch (public repo) */ }

  const r = await pullRemote({
    repoRoot: String(p.repo_root).replace(/\\/g, '/'),
    branch: p.main_branch, remoteUrl: p.remote_url, token,
  });
  if (r.state === 'fast-forwarded') {
    logline('projects', `${by} pulled ${p.name}: origin/${p.main_branch} → ${(r.to || '').slice(0, 8)} (${r.commits} commit${r.commits === 1 ? '' : 's'})`);
    broadcast('project', p);
  }
  return r;
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

// ── onboarding: inspect a folder BEFORE (or after) it becomes a project ─────
// Everything the setup UI needs to guide a human: is it a git repo, what branches/remotes exist,
// is there a manifest (and is it valid), which compose files are lying around, does the env
// contract hold. Read-only — probing never changes the repo.
export function probeRepo(repoRoot) {
  const dir = String(repoRoot || '').trim().replace(/\\/g, '/');
  if (!dir) return { ok: false, error: 'repo_root is required' };
  if (!existsSync(dir)) return { ok: false, error: `folder does not exist: ${dir}` };

  const git = (args) => spawnSync('git', ['-C', dir, ...args],
    { encoding: 'utf8', timeout: 15000, windowsHide: true, env: cleanGitEnv() });
  const isRepo = git(['rev-parse', '--git-dir']).status === 0;
  const branches = isRepo
    ? git(['branch', '--format=%(refname:short)']).stdout.split('\n').map((s) => s.trim()).filter(Boolean)
    : [];
  const currentBranch = isRepo ? git(['branch', '--show-current']).stdout.trim() : null;
  const remotes = isRepo
    ? [...new Set(git(['remote']).stdout.split('\n').map((s) => s.trim()).filter(Boolean))]
        .map((name) => ({ name, url: git(['remote', 'get-url', name]).stdout.trim() }))
    : [];

  const mf = loadManifest(dir);
  const composeFiles = readdirSync(dir).filter((f) => /^docker-compose.*\.ya?ml$/.test(f)).sort();
  return {
    ok: true,
    git: { is_repo: isRepo, branches, current_branch: currentBranch, remotes },
    manifest: mf.found
      ? { found: true, file: mf.file, valid: !mf.errors.length, errors: mf.errors, warnings: mf.warnings }
      : { found: false },
    compose_files: composeFiles,
    env: { has_env: existsSync(resolve(dir, '.env')), has_example: existsSync(resolve(dir, '.env.example')) },
  };
}

// ── readiness: the gates between "row exists" and "this project can actually work" ─────
// The setup UI's checklist. can_ship is the one Mark asked by name: without a prod site AND at
// least one shippable prod container, /ooney has nothing to build.
export async function projectReadiness(id) {
  const p = await one(`SELECT * FROM project WHERE id=$1`, [id]);
  if (!p) throw new Error('project not found');
  const gates = [];
  const gate = (key, ok, detail, level = null) =>
    gates.push({ key, ok, level: level || (ok ? 'pass' : 'fail'), detail });

  const probe = probeRepo(p.repo_root);
  gate('repo', probe.ok && probe.git?.is_repo,
    probe.ok ? (probe.git.is_repo ? `git repo at ${p.repo_root}` : 'folder exists but is not a git repo')
             : probe.error);
  if (probe.ok && probe.git?.is_repo) {
    const hasMain = probe.git.branches.includes(p.main_branch);
    gate('main_branch', hasMain,
      hasMain ? `branch "${p.main_branch}" exists`
              : `main_branch "${p.main_branch}" not found (have: ${probe.git.branches.slice(0, 6).join(', ')}) — the pool cannot provision from it`);
  }
  gate('env', !probe.ok ? false : existsSync(resolve(String(p.repo_root).replace(/\\/g, '/'), p.env_file || '.env')),
    `${p.env_file || '.env'} ${probe.ok ? 'in the main checkout' : ''}`,
    probe.ok && !existsSync(resolve(String(p.repo_root).replace(/\\/g, '/'), p.env_file || '.env')) ? 'warn' : null);
  if (probe.ok) {
    gate('manifest', probe.manifest.found ? probe.manifest.valid : true,
      probe.manifest.found
        ? (probe.manifest.valid ? `${probe.manifest.file} valid` : `${probe.manifest.file} INVALID: ${probe.manifest.errors.join('; ')}`)
        : 'no zeehive.yml — running on form/DB config (a draft can be generated)',
      probe.manifest.found ? null : 'warn');
  }

  const sites = await q(`SELECT * FROM deploy_site WHERE project_id=$1`, [id]);
  const devSite = sites.find((s) => s.tier === 'dev' && s.is_default);
  const prodSite = sites.find((s) => s.tier === 'prod' && s.is_default);
  gate('dev_site', !!devSite, devSite ? `dev → ${devSite.docker_ctx}` : 'no default dev site');
  gate('prod_site', !!prodSite,
    prodSite ? `prod → ${prodSite.docker_ctx}${prodSite.ingress?.kind ? ` (${prodSite.ingress.kind})` : ''}`
             : 'no prod site — the project cannot ship anywhere', prodSite ? null : 'warn');

  const shippable = await q(
    `SELECT name FROM container WHERE project_id=$1 AND tier='prod' AND build_script IS NOT NULL`, [id]);
  gate('shippable', shippable.length > 0,
    shippable.length ? `${shippable.length} shippable prod container(s): ${shippable.map((c) => c.name).join(', ')}`
                     : 'no prod container has a build_script — /ooney has nothing to build',
    shippable.length ? null : (prodSite ? 'fail' : 'warn'));

  const pc = await one(`SELECT * FROM pool_config WHERE project_id=$1`, [id]);
  gate('pool', true,
    `pool target ${pc?.target_ready ?? 0}${Number(pc?.target_ready) === 0 ? ' — no pre-warmed xells until raised' : ''}`,
    Number(pc?.target_ready) > 0 ? 'pass' : 'warn');

  return {
    gates,
    can_ship: !!prodSite && shippable.length > 0,
    can_provision: gates.find((g) => g.key === 'repo')?.ok && gates.find((g) => g.key === 'main_branch')?.ok !== false && !!devSite,
  };
}

// ── the dev spawn template: what a NEW xell gets by default ─────────────────
export async function getPoolConfig(projectId) {
  return one(
    `SELECT pc.*, r.key AS runtime_key, r.label AS runtime_label
       FROM pool_config pc LEFT JOIN agent_runtime r ON r.id = pc.default_runtime_id
      WHERE pc.project_id=$1`, [projectId]);
}

const POOL_PATCHABLE = ['target_ready', 'default_source_coupling', 'default_db_coupling',
                        'refresh_interval_sec', 'default_build_ctx'];
const DB_COUPLINGS = ['db-shared-dev', 'db-clone', 'db-isolated', 'db-shared-prod'];

export async function updatePoolConfig(projectId, body = {}) {
  const pc = await one(`SELECT * FROM pool_config WHERE project_id=$1`, [projectId]);
  if (!pc) throw new Error('project has no pool_config');
  if (body.default_db_coupling !== undefined && !DB_COUPLINGS.includes(body.default_db_coupling)) {
    throw new Error(`default_db_coupling must be one of: ${DB_COUPLINGS.join(', ')}`);
  }
  if (body.default_db_coupling === 'db-shared-prod') {
    throw new Error('db-shared-prod cannot be a DEFAULT — prod data access is per-xell and human-granted (/xell-prod)');
  }
  // Default compile host: normalize empty → NULL (compile on the run host), and refuse a foreign
  // context unless the project can hand the image over (a registry). Same rule as a per-xell knob,
  // enforced here so a broken default can't be baked into every future xell.
  if (body.default_build_ctx !== undefined) {
    const v = String(body.default_build_ctx || '').trim();
    const devSite = await resolveSite(projectId, 'dev');
    const runCtx = devSite?.docker_ctx || config.dockerCtx;
    body.default_build_ctx = (!v || v === runCtx) ? null : v;
    if (body.default_build_ctx) {
      const project = await one(`SELECT registry FROM project WHERE id=$1`, [projectId]);
      const registry = (project?.registry && project.registry.trim()) || config.registry || null;
      if (!registry) {
        throw new Error(
          `default build context '${body.default_build_ctx}' differs from the run context '${runCtx}', `
          + `which needs a registry to hand the image over — but none is configured. Set the project's `
          + `Build registry first.`);
      }
    }
  }
  const sets = [], vals = [projectId];
  for (const f of POOL_PATCHABLE) {
    if (body[f] === undefined) continue;
    vals.push(body[f]);
    sets.push(`${f} = $${vals.length}`);
  }
  if (body.default_runtime_key !== undefined) {
    const r = await one(`SELECT id FROM agent_runtime WHERE key=$1 AND enabled`, [body.default_runtime_key]);
    if (!r) throw new Error(`no enabled runtime keyed "${body.default_runtime_key}"`);
    vals.push(r.id);
    sets.push(`default_runtime_id = $${vals.length}`);
  }
  if (!sets.length) return pc;
  const row = await one(`UPDATE pool_config SET ${sets.join(', ')} WHERE project_id=$1 RETURNING *`, vals);
  broadcast('project', { id: projectId, pool_config: row });
  return row;
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
  'db_name', 'db_user', 'ship_ref',
  'registry',   // OCI registry for split builds (compile on one docker context, run on another)
  'auto_approve_land', 'auto_approve_ship',   // operator policy: skip the human gate (default off)
  'remote_url', // inbound-only fetch source (migration 032) — re-pointing it is safe, unlike repo_root
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
