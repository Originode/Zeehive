// Project management for the header menu: add / remove / edit a managed project.
// A project is the project-agnostic config row; creating one also seeds its xource
// (the read-only main branch it branches from), its deploy sites, and a pool_config.
// If the repo carries a zeehive.yml, onboarding reads it (spec §3.1): the manifest's
// declared compose files / env / ports / db identity become the row's values, and the
// parsed manifest is cached on the row (manifest_hash detects drift from the repo file).
import { writeFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, join, basename, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pool, one, q } from '../db/pool.js';
import { config } from '../config.js';
import { broadcast } from './events.js';
import { logline } from './logbus.js';
import { cleanGitEnv, headCommit, isAncestor } from './git.js';
import { normalizeSpawnPrep, STEP_PRESETS } from './spawn-prep.js';
import { resolveBash } from './bash.js';
import { probeRemote, cloneFromRemote, pullRemote, parseGitProgress,
         remoteAccess, pushRemote, openPullRequest, mergePullRequest } from './remote-git.js';
import { setProviderToken, tokenForSpawn } from './provider-tokens.js';
import { generateSpinoffCompose, writeGeneratedCompose } from './compose-gen.js';
import { loadManifest, projectDefaultsFromManifest, draftManifest, draftManifestFromKnobs,
         planComposeOnboarding, manifestHash, parseManifest, listComposeFiles,
         detectComposeSuggestions } from './manifest.js';
import { resolveSite } from './sites.js';
import { dbRunner, inTransaction } from './work-items.js';
import { syncProjectNode } from './work-node-sync.js';

// Same switch every other real-side-effect module reads (landgate, xellgit, nudge, harness, reaper,
// the .zeehive.env reconcile): 'real' touches machines, anything else models. The three OUTBOUND
// verbs below (Pull · Push · PR) run git against a project's repo_root and its `origin` — both taken
// off a project row, and a xell's database is a CLONE of the meta-DB, so a NESTED queenzee's project
// rows are the REAL fleet's. Its console renders the real projects with the real buttons; one click
// there would fast-forward the real xource from the remote, or publish the real main OUTWARD, from
// an instance that is only modelling. See outboundRefusal at the head of each verb.
const PROVISION_MODE = process.env.PROVISION_MODE === 'real' ? 'real' : 'simulate';
const outboundRefusal = (what, p) =>
  `PROVISION_MODE=simulate: this queenzee models the fleet, it does not ${what} — ${p.repo_root} is a `
  + 'real checkout and its origin is a real remote, and this project row came out of a CLONE of the '
  + 'meta-DB. Nothing was run. Use the real queenzee.';

// Live statuses that mean a zee is actively bound — deleting such a project is refused.
const LIVE_ZEE = ['spawning', 'online', 'working', 'idle'];

// How a NESTED project's repo joins its parent's git. A project onboarded inside another project's
// tree must pick one: 'submodule' (a git submodule entry in the parent), 'subtree' (the parent
// grafts the nested repo's history as a subtree), or 'main_repo' ("just use the main repo" — no
// nested git at all). Top-level projects carry NULL. The console surfaces the same vocabulary via
// web/src/hive/plusMenu.js; keep the two in step.
export const GIT_BEHAVIORS = ['submodule', 'subtree', 'main_repo'];
export const isValidGitBehavior = (b) => b === null || b === undefined || GIT_BEHAVIORS.includes(b);

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

// Every project, with what is WAITING ON A HUMAN in each. The counts matter because the console is
// per-project: the production panel, the landing banner and the honeycomb all show the SELECTED
// project only, so a ship awaiting approval in the other one is invisible until you happen to
// switch to it. A zee that asked would keep saying "it is waiting for you" while the operator, on
// the other project, saw an empty panel — the same "i see zero" this whole change is about, one
// level up. Two cheap correlated counts on indexed columns, on a menu that opens rarely.
export async function listProjects() {
  return q(
    `SELECT p.*,
            (SELECT count(*) FROM xell x WHERE x.project_id = p.id AND x.status <> 'retired') AS xell_count,
            (SELECT count(*) FROM ship_request s
               WHERE s.project_id = p.id AND s.status = 'pending'
                 AND s.dismissed_at IS NULL AND s.deferred_at IS NULL)::int AS ships_waiting,
            (SELECT count(*) FROM land_request lr
               WHERE lr.project_id = p.id AND lr.status = 'pending'
                 AND lr.dismissed_at IS NULL)::int AS landings_waiting
       FROM project p ORDER BY p.created_at`);
}

// Create a project + its xource + pool_config. Only name & repo_root are required;
// everything else falls back to the OmniBiz-shaped defaults so a project is usable at once.
export async function createProject(body) {
  const name = (body.name || '').trim();
  const repoRoot = (body.repo_root || '').trim();
  if (!name) throw new Error('project name is required');
  if (!repoRoot) throw new Error('repo_root (project folder) is required');
  // The git-behavior choice is only meaningful for a NESTED project (its repo joins a parent's);
  // the console forces it there. A top-level project carries NULL. Validate the enum here rather
  // than trusting the DB constraint to be the first line of defence — a clear sentence beats a
  // postgres check violation.
  const gitBehavior = (body.git_behavior || '').trim() || null;
  if (gitBehavior && !GIT_BEHAVIORS.includes(gitBehavior)) {
    throw new Error('git_behavior must be submodule, subtree or main_repo');
  }

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
          db_name, db_user, manifest, manifest_hash, manifest_at, remote_url, git_behavior)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
          COALESCE($12,3100), COALESCE($13,5200), COALESCE($14,90),
          $15,$16,$17,$18, CASE WHEN $17::jsonb IS NULL THEN NULL ELSE now() END, $19,$20)
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
       (body.remote_url || '').trim() || null,
       gitBehavior]);

    // Record the xource's head AT ONBOARDING. This is the baseline the rollback tripwire
    // reads: a remote that later moves BACKWARD (force-push, restored-from-stale-backup)
    // leaves the checkout on a commit that no longer contains this one, and that is only
    // detectable if we wrote down where we started. Null when repo_root is not a readable
    // git repo yet — the column is advisory, never a gate on onboarding.
    await client.query(
      `INSERT INTO xource (project_id, ref, head_commit, read_only) VALUES ($1,$2,$3,true)
       ON CONFLICT (project_id, ref) DO UPDATE SET head_commit = COALESCE(EXCLUDED.head_commit, xource.head_commit)`,
      [project.id, mainBranch, headCommit(repoRoot, mainBranch)]);

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

    // DUAL-WRITE — "a project is just a work_node": the project row's ROOT node
    // (stable_key='project:<project_id>') is created in the same transaction. The 058 trigger
    // has already made the root work_item by now; syncProjectNode materialises the plan,
    // plan_version, the project node and the root work_item node under it.
    await syncProjectNode(dbRunner(client), project.id);

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
  // Progress rides the SSE bus so the onboard form can draw a real bar instead of a spinner that
  // says nothing for four minutes. git emits many updates a second; only forward a frame when the
  // whole-clone percentage actually moves, or the stream becomes the bottleneck it is reporting on.
  let lastOverall = -1;
  broadcast('clone-progress', { name, url, phase: 'starting', label: 'contacting remote', overall: 0, pct: 0 });
  const cl = await cloneFromRemote({
    url, dest, branch: mainBranch, token,
    onProgress: (line) => {
      logline('projects', `clone ${name}: ${line}`);
      const p = parseGitProgress(line);
      if (!p || p.overall === lastOverall) return;
      lastOverall = p.overall;
      broadcast('clone-progress', { name, url, ...p });
    },
  });
  // Terminal frame either way — a bar left at 87% with no closing event is worse than no bar.
  broadcast('clone-progress', {
    name, url, phase: cl.cloned ? 'done' : 'failed', label: cl.cloned ? 'clone complete' : 'clone failed',
    overall: cl.cloned ? 100 : lastOverall, pct: 100, done: true, error: cl.cloned ? null : cl.reason,
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

// Write down where the xource ref now points, and check it did not move BACKWARD. A remote
// that regresses (force-push, restore-from-stale-backup, a re-clone of a rolled-back remote)
// leaves the checkout on a commit that no longer CONTAINS the head we last recorded — and
// nothing else in the system notices, because every xell dutifully branches from the new tip.
// That is exactly how OmniBiz lost six days of work in July 2026: the remote went back from
// 90a7548b to 0265998f and the containerized xource was cloned from the regressed remote.
// Returns a regression descriptor when the ref moved backward, else null.
export async function recordXourceHead(project, ref, head) {
  if (!head) return null;
  const prev = await one(`SELECT head_commit FROM xource WHERE project_id=$1 AND ref=$2`, [project.id, ref]);
  const was = prev?.head_commit || null;
  const regressed = !!was && was !== head && !isAncestor(project.repo_root, was, head);

  await q(`INSERT INTO xource (project_id, ref, head_commit, read_only) VALUES ($1,$2,$3,true)
           ON CONFLICT (project_id, ref) DO UPDATE SET head_commit = EXCLUDED.head_commit`,
          [project.id, ref, head]);

  if (regressed) {
    logline('projects', `WARNING ${project.name}: xource ${ref} moved BACKWARD — recorded ${was.slice(0, 8)} is not contained in ${head.slice(0, 8)}; work may have been dropped`);
    return { regressed: true, was, now: head };
  }
  return null;
}

// Fetch + ff-only merge of the recorded remote into the xource checkout. Human-triggered from
// the console; refusals (dirty tree, divergence, wrong branch) come back as {pulled:false,
// reason} for the refuse-with-reason UI convention.
export async function pullProject(id, by = 'human@console') {
  const p = await one(`SELECT * FROM project WHERE id=$1`, [id]);
  if (!p) throw new Error('project not found');
  if (!p.remote_url) return { pulled: false, state: 'refused', reason: 'project has no remote_url — set one in Project setup first' };
  if (PROVISION_MODE !== 'real') {
    logline('projects', `${p.name}: PULL from origin NOT run — PROVISION_MODE=simulate (this queenzee models the fleet)`);
    return { pulled: false, state: 'refused', dry_run: true, reason: outboundRefusal('pull a real xource from its remote', p) };
  }

  let token = null;
  try { token = (await tokenForSpawn(p.id, 'github'))?.token || null; } catch { /* no token = anonymous fetch (public repo) */ }

  const r = await pullRemote({
    repoRoot: String(p.repo_root).replace(/\\/g, '/'),
    branch: p.main_branch, remoteUrl: p.remote_url, token,
  });
  // Record the head on any successful read of the ref — including 'up-to-date', which is where
  // a first-ever population lands for a project onboarded before head_commit was tracked.
  let regression = null;
  if (r.pulled) regression = await recordXourceHead(p, p.main_branch, r.to || headCommit(p.repo_root, p.main_branch));

  if (r.state === 'fast-forwarded') {
    logline('projects', `${by} pulled ${p.name}: origin/${p.main_branch} → ${(r.to || '').slice(0, 8)} (${r.commits} commit${r.commits === 1 ? '' : 's'})`);
    broadcast('project', p);
  }
  return regression ? { ...r, ...regression } : r;
}

// ── OUTBOUND (opt-in, human-gated): does this project's PAT carry write access? ──
// The console asks this to decide whether to SHOW the Push / PR buttons at all. Read-only or no
// token → both false with a reason, and the buttons stay hidden. Never throws (a probe failure is
// an answer, not a 500): a project with no remote reports can_push/can_pr false.
export async function githubAccess(id) {
  const p = await one(`SELECT id, remote_url, main_branch FROM project WHERE id=$1`, [id]);
  if (!p) throw new Error('project not found');
  if (!p.remote_url) return { can_push: false, can_pr: false, reason: 'project has no remote_url' };
  let token = null;
  try { token = (await tokenForSpawn(p.id, 'github'))?.token || null; } catch { /* no token */ }
  return remoteAccess({ url: p.remote_url, token });
}

// Push local main → the remote's same branch (fast-forward only). Human-triggered from the
// console behind a confirm dialog. Refuses ({pushed:false, reason}) on divergence/auth exactly
// like Pull refuses — the console shows the reason.
export async function pushProject(id, by = 'human@console') {
  const p = await one(`SELECT * FROM project WHERE id=$1`, [id]);
  if (!p) throw new Error('project not found');
  if (!p.remote_url) return { pushed: false, state: 'refused', reason: 'project has no remote_url — set one in Project setup first' };
  if (PROVISION_MODE !== 'real') {
    logline('projects', `${p.name}: PUSH to origin NOT run — PROVISION_MODE=simulate (this queenzee models the fleet)`);
    return { pushed: false, state: 'refused', dry_run: true, reason: outboundRefusal('publish a real xource to its remote', p) };
  }

  const access = await githubAccess(id);
  if (!access.can_push) return { pushed: false, state: 'refused', reason: access.reason || 'the connected GitHub token cannot push to this repo' };

  let token = null;
  try { token = (await tokenForSpawn(p.id, 'github'))?.token || null; } catch { /* handled below */ }

  const r = await pushRemote({
    repoRoot: String(p.repo_root).replace(/\\/g, '/'),
    branch: p.main_branch, remoteUrl: p.remote_url, token,
  });
  if (r.pushed) logline('projects', `${by} pushed ${p.name}: local ${p.main_branch} → origin/${p.main_branch} (${(r.sha || '').slice(0, 8)}) [${r.state}]`);
  // A refusal was previously invisible outside the one console pill that asked for it: the human
  // saw "repository rule violations" once and had nothing to point anyone at. Log the state AND
  // the reason so the rail carries why an outbound push did not happen.
  else logline('projects', `${by} push REFUSED on ${p.name} [${r.state || 'error'}]: ${r.reason || 'no reason given'}`);
  return r;
}

// Open a PR from local main — and, when `merge` is set, MERGE it too (pull-request AND merge).
// Human-triggered; the console may pass a head branch name / title, a merge flag and a merge method
// ('merge' | 'squash' | 'rebase'). The merge is a separate GitHub call after the PR is opened, so a
// refused merge (branch protection, not-yet-mergeable) still leaves an OPEN PR the human can finish
// by hand — the outcome is reported as r.merge = {merged, state, reason}.
export async function pullRequestProject(id, { headBranch = null, title = null, base = null, merge = false, mergeMethod = 'merge', squash = false } = {}, by = 'human@console') {
  const p = await one(`SELECT * FROM project WHERE id=$1`, [id]);
  if (!p) throw new Error('project not found');
  if (!p.remote_url) return { opened: false, reason: 'project has no remote_url — set one in Project setup first' };
  if (PROVISION_MODE !== 'real') {
    logline('projects', `${p.name}: PR on origin NOT opened — PROVISION_MODE=simulate (this queenzee models the fleet)`);
    return { opened: false, dry_run: true, reason: outboundRefusal('open or merge a PR on a real remote', p) };
  }

  const access = await githubAccess(id);
  if (!access.can_pr) return { opened: false, reason: access.reason || 'the connected GitHub token cannot open PRs on this repo' };

  let token = null;
  try { token = (await tokenForSpawn(p.id, 'github'))?.token || null; } catch { /* handled below */ }

  const r = await openPullRequest({
    repoRoot: String(p.repo_root).replace(/\\/g, '/'),
    remoteUrl: p.remote_url, token, branch: p.main_branch,
    headBranch, title, base, squash,
  });
  if (r.opened) logline('projects', `${by} opened PR on ${p.name}: ${r.head} → ${r.base}${r.number ? ` (#${r.number})` : ''} [${r.state}]`
    // the head that was actually pushed can differ from the one asked for when a ruleset blocked
    // the force refresh (remote-git falls back to a fresh sha-suffixed branch) — say which
    + ((r.tried || []).length > 1 ? ` — head fell back from ${r.tried[0]} (ruleset blocked the update)` : ''));
  else logline('projects', `${by} PR REFUSED on ${p.name}${r.rule ? ` [rule: ${r.rule}]` : ''}: ${r.reason || 'no reason given'}`);

  if (merge && r.opened && r.number) {
    const m = await mergePullRequest({ remoteUrl: p.remote_url, token, number: r.number, method: mergeMethod, title });
    r.merge = m;
    if (m.merged) logline('projects', `${by} merged PR #${r.number} on ${p.name} → ${r.base} (${m.method}, ${(m.sha || '').slice(0, 8)})`);
    else logline('projects', `${by} opened PR #${r.number} on ${p.name} but merge was refused: ${m.reason}`);
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

// Generate (and optionally write) the project's SPINOFF COMPOSE from its manifest — the
// compose-authorship model (docs/compose-authorship-decision-record.md): the compose file is a
// PROJECTION ZEEHIVE authors, marked GENERATED, standalone-runnable, and only ever written over
// a file carrying the marker — a project's own (onboarded) compose is never touched. Machine
// facts never appear in the output; placement stays meta-DB data.
export async function generateProjectCompose(id, { write = false } = {}) {
  const p = await one(`SELECT id, name, repo_root, manifest, compose_spinoff FROM project WHERE id=$1`, [id]);
  if (!p) throw new Error('project not found');
  const repo = loadManifest(p.repo_root);
  const manifest = (repo.found && repo.manifest) ? repo.manifest : p.manifest;
  if (!manifest) throw new Error('no manifest (repo zeehive.yml or cached) to generate from');
  const file = manifest.tiers?.spinoff?.compose || p.compose_spinoff || 'docker-compose.spinoff.yml';
  const { yaml } = generateSpinoffCompose({ name: p.name, manifest });
  if (!write) return { file, yaml, wrote: false };
  const r = writeGeneratedCompose(p.repo_root, file, yaml);
  if (r.wrote) logline('projects', `generated ${file} for ${p.name} (compose-authorship projection)`);
  return { file, yaml, ...r };
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

// ── onboarding: browse DIRECTORIES on the queenzee's own filesystem ─────────
// The onboard form's folder picker: the Folder path resolves on THIS process's filesystem
// (a containerized queenzee sees /repos, never the operator's desktop), so the picker walks
// this world. Listing only — directory names plus a git-repo marker, never file contents; the
// console already hands out shells into containers, so a read-only dir listing adds no new
// authority. Hidden (dot) directories are skipped: nothing onboardable lives there.
export function listDirs(startPath) {
  const root = resolve(String(startPath || '').trim() || config.reposDir || config.repoRoot);
  if (!existsSync(root)) return { ok: false, error: `no such folder: ${root}`, path: root, parent: null, dirs: [] };
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); }
  catch (e) { return { ok: false, error: `cannot read ${root}: ${e.message}`, path: root, parent: null, dirs: [] }; }
  const dirs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => ({ name: e.name, is_repo: existsSync(join(root, e.name, '.git')) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const parent = dirname(root);
  return { ok: true, path: root.replace(/\\/g, '/'), parent: parent === root ? null : parent.replace(/\\/g, '/'), dirs };
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
    // Compose files on disk that the meta-DB has not absorbed yet — the Project → Manifest
    // "Compose onboarding" plan is the door. Warn only when the plan is applicable (something
    // would actually change); silent when already configured.
    if (probe.compose_files?.length) {
      const cplan = planComposeOnboarding(p.repo_root, p.name, p);
      if (cplan.applicable) {
        const files = probe.compose_files.join(', ');
        const cols = cplan.meta_changes.filter((c) => c.column !== 'manifest').map((c) => c.column);
        gate('compose_onboarding', false,
          `${probe.compose_files.length} compose file(s) detected (${files}) not fully in the meta-DB`
            + (cols.length ? ` — would set ${cols.join(', ')}` : '')
            + '. Project setup → Manifest → Plan compose onboarding (human approves before any write).',
          'warn');
      } else {
        gate('compose_onboarding', true,
          `compose file(s) reflected in meta-DB (${probe.compose_files.join(', ')})`);
      }
    }
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
  const row = await one(
    `SELECT pc.*, r.key AS runtime_key, r.label AS runtime_label,
            h.key AS harness_key, h.label AS harness_label
       FROM pool_config pc
       LEFT JOIN agent_runtime r ON r.id = pc.default_runtime_id
       LEFT JOIN harness h ON h.id = pc.default_harness_id
      WHERE pc.project_id=$1`, [projectId]);
  if (!row) return row;
  // spawn_prep is served EFFECTIVE, never raw: a NULL column is the built-in default (npm ci + the
  // web prebuild, shared npm cache), and an editor that had to know that would be a second copy of
  // the rule. `spawn_prep_custom` is how the console says "this project has been edited" without
  // comparing structures, and the presets ride along so the "add a step" menu is server-defined —
  // a new step kind appears in the UI by shipping the server, not by shipping both.
  return {
    ...row,
    spawn_prep: normalizeSpawnPrep(row.spawn_prep ?? null),
    spawn_prep_custom: !!row.spawn_prep,
    spawn_prep_presets: STEP_PRESETS,
    spawn_prep_defaults: normalizeSpawnPrep(null),
  };
}

const POOL_PATCHABLE = ['target_ready', 'default_source_coupling', 'default_db_coupling',
                        'refresh_interval_sec', 'default_build_ctx', 'gateway_body_capture'];
// Every coupling a xell can hold. The two prod ones are listed so a bad value still gets the honest
// "must be one of" error, then refused individually below as DEFAULTS (prod access is per-xell).
const DB_COUPLINGS = ['db-shared-dev', 'db-clone', 'db-isolated', 'db-shared-prod', 'db-prod-readonly'];

export async function updatePoolConfig(projectId, body = {}) {
  const pc = await one(`SELECT * FROM pool_config WHERE project_id=$1`, [projectId]);
  if (!pc) throw new Error('project has no pool_config');
  if (body.default_db_coupling !== undefined && !DB_COUPLINGS.includes(body.default_db_coupling)) {
    throw new Error(`default_db_coupling must be one of: ${DB_COUPLINGS.join(', ')}`);
  }
  if (body.default_db_coupling === 'db-shared-prod') {
    throw new Error('db-shared-prod cannot be a DEFAULT — prod data access is per-xell and human-granted (/xell-prod)');
  }
  // Read-only prod is still PROD, and it belongs to exactly one kind of xell (a manager, bound when
  // a human adds one). As a project default it would silently point every pooled worker at the live
  // database — the same reason db-shared-prod is refused above, one notch quieter.
  if (body.default_db_coupling === 'db-prod-readonly') {
    throw new Error('db-prod-readonly cannot be a DEFAULT — it is the MANAGER binding, minted per xell '
      + 'when a human adds a manager zee (its own SELECT-only postgres role)');
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
  // SPAWN PREP (migration 121): the dependency steps a fresh xell is prepped with, and the cache
  // knobs that decide how fast that is. Normalized (and REFUSED, loudly) here rather than at
  // dispatch: a template that cannot be turned into a script must fail at the edit, in front of the
  // human who made it, not at 3am inside a cage nobody is watching. `null` restores the default.
  if (body.spawn_prep !== undefined) {
    const value = body.spawn_prep === null || body.spawn_prep === 'default' ? null
      : normalizeSpawnPrep(body.spawn_prep);
    vals.push(value === null ? null : JSON.stringify(value));
    sets.push(`spawn_prep = $${vals.length}::jsonb`);
  }
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
  // Default harness: the persona a BARE dispatch attaches (intake reads pool_config.default_harness_id
  // when --harness is omitted and the pooled xell has none). A key names a harness; '' / 'none' /
  // 'core-only' clears it back to core-only (the law layer, always on). The core (law) harness is not
  // a selectable default — every xell already gets it.
  if (body.default_harness_key !== undefined) {
    const key = String(body.default_harness_key || '').trim().toLowerCase();
    if (!key || key === 'none' || key === 'core-only') {
      vals.push(null);
      sets.push(`default_harness_id = $${vals.length}`);
    } else {
      const h = await one(`SELECT id, project_id FROM harness WHERE key=$1 AND enabled AND NOT is_law_core`, [key]);
      if (!h) throw new Error(`no enabled harness keyed "${key}"`);
      // SCOPE (084): a project-scoped harness is only a default for ITS project. The DB trigger
      // (pool_default_harness_scope_guard) is the wall; this is the sentence, because the default is
      // the one path that attaches a persona without anybody naming it.
      if (h.project_id && String(h.project_id) !== String(projectId)) {
        throw new Error(`harness "${key}" belongs to another project — it cannot be this project's `
          + "default harness. A default must be system-wide, or this project's own.");
      }
      vals.push(h.id);
      sets.push(`default_harness_id = $${vals.length}`);
    }
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

// The knob-driven draft (the "no manifest yet" wizard): the console's form values become a
// zeehive.yml PREVIEW without writing anything. The human reviews/edits the YAML, then calls
// writeProjectManifest with the final text.
export async function buildManifestDraft(id, knobs = {}) {
  const p = await one(`SELECT id, name, repo_root FROM project WHERE id=$1`, [id]);
  if (!p) throw new Error('project not found');
  const existing = loadManifest(p.repo_root);
  if (existing.found && !existing.errors.length) {
    throw new Error(`${existing.file} already exists — this project already has a manifest; `
      + 'edit the file in the repo and ↻ Refresh from repo instead');
  }
  const { manifest, yaml } = draftManifestFromKnobs(p.name, knobs);
  return {
    yaml,
    manifest,
    already_has: existing.found || false,
    compose_files: listComposeFiles(p.repo_root),
    suggestions: detectComposeSuggestions(p.repo_root),
  };
}

// Write a zeehive.yml the human built in the wizard (or hand-edited) into the repo root, and
// apply its declared fields to the meta-DB row — the same projection refreshProjectManifest
// performs, in the same function that already owns the ONE file ZEEHIVE may write into a
// project repo. Refused when a valid manifest already exists (the repo file is the truth);
// `overwrite` is only honoured when the existing file is INVALID (parse errors) — a human
// replacing a broken file, never a clobber of a working one.
export async function writeProjectManifest(id, { yaml, apply_meta = true, overwrite = false } = {}) {
  const p = await one(`SELECT * FROM project WHERE id=$1`, [id]);
  if (!p) throw new Error('project not found');
  const text = String(yaml || '').trim();
  if (!text) throw new Error('manifest YAML is required');
  const dir = String(p.repo_root).replace(/\\/g, '/');
  const existing = loadManifest(dir);
  if (existing.found && !existing.errors.length) {
    throw new Error(`${existing.file} already exists — edit it in the repo and ↻ Refresh from repo instead`);
  }
  if (existing.found && !overwrite) {
    throw new Error(`${existing.file} exists but is invalid — pass overwrite:true to replace it with a valid manifest`);
  }
  const parsed = parseManifest(text, { dir });
  if (parsed.errors?.length) {
    throw new Error(`invalid zeehive.yml: ${parsed.errors.join('; ')}`);
  }
  const target = resolve(dir, existing.file || 'zeehive.yml');
  writeFileSync(target, text);

  let updated = p;
  if (apply_meta) {
    const md = projectDefaultsFromManifest(parsed.manifest);
    const sets = ['manifest = $2', 'manifest_hash = $3', 'manifest_at = now()'];
    const vals = [id, JSON.stringify(parsed.manifest), manifestHash(text)];
    for (const [k, v] of Object.entries(md)) {
      if (v === undefined || v === null) continue;
      vals.push(v);
      sets.push(`${k} = $${vals.length}`);
    }
    updated = await one(`UPDATE project SET ${sets.join(', ')} WHERE id=$1 RETURNING *`, vals);
    broadcast('project', updated);
  }
  logline('projects', `wrote ${existing.file || 'zeehive.yml'} + applied manifest for ${p.name}`
    + (apply_meta ? '' : ' (meta-DB skipped)'));
  return { ...updated, written: true, file: existing.file || 'zeehive.yml', applied_meta: apply_meta };
}

// ── compose onboarding: detect compose files → plan → human approves → apply ─
// The plan is a pure read of the repo + the project row. Apply refuses without
// `approved: true`, re-computes the plan server-side (never trusts a client plan),
// and only touches: (optional) zeehive.yml + the project row's manifest/compose_*
// columns. Container rows and deploy_site.compose_file are NEVER written — a live
// prod stack keeps the compose_file stamped on it at provision/ship.
export async function getComposeOnboardingPlan(id) {
  const p = await one(`SELECT * FROM project WHERE id=$1`, [id]);
  if (!p) throw new Error('project not found');
  return planComposeOnboarding(p.repo_root, p.name, p);
}

export async function applyComposeOnboarding(id, {
  approved = false,
  write_yml = true,
  apply_meta = true,
} = {}) {
  if (approved !== true) {
    throw new Error('human approval required — re-call with { approved: true } after reviewing the plan '
      + '(files_to_modify + meta_changes). Nothing was written.');
  }
  if (!write_yml && !apply_meta) {
    throw new Error('nothing to do — set write_yml and/or apply_meta');
  }

  const p = await one(`SELECT * FROM project WHERE id=$1`, [id]);
  if (!p) throw new Error('project not found');
  // Re-plan at apply time so a stale UI preview cannot write a different shape than the human saw
  // the *intent* of. The human approved "run compose onboarding for this project now", not a
  // client-supplied blob.
  const plan = planComposeOnboarding(p.repo_root, p.name, p);
  if (!plan.applicable) {
    throw new Error(plan.reason || 'compose onboarding has nothing to apply');
  }

  const dir = String(p.repo_root).replace(/\\/g, '/');
  const written = [];

  if (write_yml && plan.yml.action !== 'unchanged' && plan.yml.action !== 'none') {
    // Validate the proposed YAML before touching disk.
    const parsed = parseManifest(plan.proposed_yml, { dir });
    if (parsed.errors?.length) {
      throw new Error(`proposed zeehive.yml is invalid: ${parsed.errors.join('; ')}`);
    }
    const target = resolve(dir, plan.yml.path || 'zeehive.yml');
    // Create is always fine. Update only rewrites when the plan said we would — and only the
    // merge result (gaps filled), never a from-scratch draft over a process-runner yml.
    if (plan.yml.action === 'create' && existsSync(target)) {
      throw new Error(`${plan.yml.path} appeared on disk since the plan was built — refusing to overwrite; refresh the plan`);
    }
    writeFileSync(target, plan.proposed_yml);
    written.push({ path: plan.yml.path, action: plan.yml.action });
    logline('projects', `compose onboarding wrote ${plan.yml.path} (${plan.yml.action}) for ${p.name}`);
  }

  let updated = p;
  if (apply_meta) {
    // Prefer the ON-DISK file after a write (yml is the truth); otherwise apply the proposed
    // manifest object directly so meta-only onboarding still works when the human declined a
    // repo write (e.g. read-only checkout). A later ↻ Refresh from repo will reconcile.
    let manifest = plan.proposed_manifest;
    let hash = plan.proposed_hash;
    if (write_yml || plan.yml.exists) {
      const repo = loadManifest(dir);
      if (repo.found && !repo.errors.length) {
        manifest = repo.manifest;
        hash = repo.hash;
      } else if (repo.found && repo.errors.length) {
        throw new Error(`${repo.file} is invalid after write: ${repo.errors.join('; ')}`);
      }
    } else {
      hash = manifestHash(plan.proposed_yml).slice(0, 16);
    }
    const md = projectDefaultsFromManifest(manifest);
    const sets = ['manifest = $2', 'manifest_hash = $3', 'manifest_at = now()'];
    const vals = [id, JSON.stringify(manifest), hash];
    // Only SET columns the plan listed — never blank an unrelated field, never invent a change
    // the human did not see in meta_changes.
    for (const change of plan.meta_changes) {
      if (change.column === 'manifest') continue;
      const v = md[change.column];
      if (v === undefined || v === null) continue;
      vals.push(v);
      sets.push(`${change.column} = $${vals.length}`);
    }
    updated = await one(`UPDATE project SET ${sets.join(', ')} WHERE id=$1 RETURNING *`, vals);
    broadcast('project', updated);
    logline('projects', `compose onboarding applied meta-DB manifest for ${p.name} `
      + `(compose_spinoff=${updated.compose_spinoff || '—'}, compose_prod=${updated.compose_prod || '—'})`);
  }

  return {
    ok: true,
    project: updated,
    written,
    // Echo the guarantee so the console can show it next to the success toast.
    containers_untouched: true,
    deploy_sites_untouched: true,
    plan: {
      compose_files: plan.compose_files,
      meta_changes: plan.meta_changes,
      files_to_modify: plan.files_to_modify,
      warnings: plan.warnings,
    },
  };
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
  'auto_approve_seed', 'auto_done',           // …and the seed/done policies (122): auto-run seeds, auto-confirm manager-suggested done
  'remote_url', // inbound-only fetch source (migration 032) — re-pointing it is safe, unlike repo_root
  'git_behavior', // how a NESTED project's repo joins its parent's git (submodule/subtree/main_repo)
];

export async function updateProject(id, body = {}) {
  return inTransaction(async ({ client, pending }) => {
    const db = dbRunner(client);
    const project = await db.one(`SELECT * FROM project WHERE id = $1`, [id]);
    if (!project) throw new Error('project not found');

    const sets = [], vals = [id];
    for (const f of PATCHABLE) {
      if (body[f] === undefined) continue;
      const v = typeof body[f] === 'string' ? (body[f].trim() || null) : body[f];
      if (f === 'name' && !v) throw new Error('project name cannot be empty');
      if (f === 'main_branch' && !v) throw new Error('main_branch cannot be empty');
      if (f === 'git_behavior' && v && !GIT_BEHAVIORS.includes(v)) {
        throw new Error('git_behavior must be submodule, subtree or main_repo');
      }
      vals.push(v);
      sets.push(`${f} = $${vals.length}`);
    }
    if (!sets.length) return project;

    const updated = await db.one(`UPDATE project SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, vals);
    // A changed main branch needs its xource row, or the pool can't provision from it.
    if (body.main_branch && body.main_branch !== project.main_branch) {
      await db.q(`INSERT INTO xource (project_id, ref, head_commit, read_only) VALUES ($1,$2,$3,true)
                  ON CONFLICT (project_id, ref) DO UPDATE SET head_commit = COALESCE(EXCLUDED.head_commit, xource.head_commit)`,
                 [id, updated.main_branch, headCommit(updated.repo_root, updated.main_branch)]);
    }
    // DUAL-WRITE — renaming the project keeps its ROOT node's name in step (same transaction).
    if (body.name && body.name !== project.name) {
      await syncProjectNode(db, id);
    }
    pending.push(['project', updated]);
    return updated;
  });
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
