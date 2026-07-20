// SELF-ONBOARD (Mark, 2026-07-20): on a fresh run — empty meta-DB, no projects — ZEEHIVE
// onboards ITSELF as the first project. The orchestrator managing its own development is the
// point of the system (spec §6), so a fresh instance must not boot into an empty console and
// wait for a human to type its own repo in.
//
// Where the repo comes from, in order:
//   1. An existing clone at REPOS_DIR/Zeehive (a previous run's — repos volumes outlive
//      meta-DBs on purpose): onboard the folder as-is.
//   2. ZEEHIVE_SELF_REMOTE (+ ZEEHIVE_GITHUB_TOKEN for the private repo): clone from GitHub —
//      the container era's canonical path. Inbound-only, like every remote touch.
//   3. The queenzee's own runtime dir, when it is a git checkout (the host era, or a nested
//      queenzee inside a xell worktree): onboard it directly. A nested instance stays inert
//      anyway (pool target 0 + the manifest's simulate safety env).
// None of it may block boot: failure logs loudly and the console's onboarding UI remains.
import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { spawnSync } from 'node:child_process';
import { one, q } from '../db/pool.js';
import { config } from '../config.js';
import { logline } from './logbus.js';
import { cleanGitEnv } from './git.js';
import { createProject, cloneProject } from './projects.js';
import { createSite } from './sites.js';

const SELF = 'Zeehive';

const git = (dir, args) => spawnSync('git', ['-C', dir, ...args],
  { encoding: 'utf8', timeout: 15000, windowsHide: true, env: cleanGitEnv() });
const isRepo = (dir) => !!dir && existsSync(dir) && git(dir, ['rev-parse', '--git-dir']).status === 0;
const branchOf = (dir) => git(dir, ['branch', '--show-current']).stdout?.trim() || 'main';
const originOf = (dir) => {
  const r = git(dir, ['remote', 'get-url', 'origin']);
  return r.status === 0 ? r.stdout.trim() : null;
};

export async function ensureSelfProject() {
  try {
    const any = await one(`SELECT count(*) AS n FROM project`);
    if (Number(any?.n) > 0) return;   // not a fresh run — never second-guess an existing setup

    const remote = (process.env.ZEEHIVE_SELF_REMOTE || '').trim() || null;
    const token = (process.env.ZEEHIVE_GITHUB_TOKEN || '').trim() || null;
    const dest = config.reposDir
      ? `${config.reposDir.replace(/[\\/]+$/, '')}/${SELF}` : null;

    let project;
    if (isRepo(dest)) {
      logline('boot', `self-onboard: found an existing clone at ${dest} — onboarding the folder`);
      project = await createProject({
        name: SELF, repo_root: dest, main_branch: branchOf(dest),
        remote_url: remote || originOf(dest),
      });
    } else if (remote && dest) {
      logline('boot', `self-onboard: fresh run — cloning ${remote} → ${dest}`);
      project = await cloneProject({ name: SELF, remote_url: remote, dest, token });
    } else if (isRepo(config.repoRoot)) {
      logline('boot', `self-onboard: onboarding the runtime checkout at ${config.repoRoot}`);
      project = await createProject({
        name: SELF, repo_root: config.repoRoot, main_branch: branchOf(config.repoRoot),
        remote_url: originOf(config.repoRoot),
      });
    } else {
      logline('boot', 'self-onboard: nothing to onboard from — set ZEEHIVE_SELF_REMOTE (+'
        + ' ZEEHIVE_GITHUB_TOKEN for a private repo) or onboard via the console');
      return;
    }

    // Spec §6.1 spawn defaults: Zeehive xells run process roles, get their OWN per-xell meta-DB
    // container, and the pool pre-warms ONE xell out of the box so the console is never empty.
    await q(`UPDATE pool_config SET default_db_coupling='db-isolated', target_ready=1 WHERE project_id=$1`, [project.id]);

    // Model the RUNNING STACK as this project's production: the kickstarted containers — the
    // meta-DB, this very server, the console — ARE Zeehive's prod instance, so the matrix and
    // the PRODUCTION hex should show them from birth. Best-effort: needs the local daemon and
    // compose labels (the containerized eras); the host-process era skips silently.
    try { await modelOwnStack(project.id); }
    catch (e) { logline('boot', `self-onboard: could not model the running stack (${e.message}) — add it via the console`); }

    logline('boot', `self-onboard: ${SELF} ready @ ${project.repo_root}`
      + `${project.remote_url ? ` (pull-only remote ${project.remote_url})` : ''}`);
  } catch (e) {
    logline('boot', `self-onboard FAILED (boot continues; onboard via the console): ${e.message}`);
  }
}

// The compose services of the stack WE are running in, discovered from our own container's
// labels: works whatever the containers are named (bootstrap, dev-era, an override file).
const SERVICE_ROLE = { 'meta-db': 'db', server: 'server', web: 'webapp' };

async function modelOwnStack(projectId) {
  const dk = (args) => spawnSync('docker', args, { encoding: 'utf8', timeout: 15000, windowsHide: true });
  const self = dk(['inspect', hostname(), '--format', '{{ index .Config.Labels "com.docker.compose.project" }}']);
  const composeProject = self.status === 0 ? self.stdout.trim() : '';
  if (!composeProject) return;   // not a compose container (host era) — nothing to model

  const ls = dk(['ps', '--filter', `label=com.docker.compose.project=${composeProject}`,
    '--format', '{{.Names}}\t{{.Label "com.docker.compose.service"}}']);
  if (ls.status !== 0) throw new Error((ls.stderr || 'docker ps failed').trim().slice(-120));

  const site = await createSite(projectId, { key: 'local', tier: 'prod', docker_ctx: 'default', is_default: true });
  for (const line of ls.stdout.split('\n').filter(Boolean)) {
    const [name, service] = line.split('\t');
    const role = SERVICE_ROLE[service];
    if (!role) continue;
    await q(
      `INSERT INTO container (project_id, role, tier, isolation, name, docker_ctx, internal_port, conn_ref, site_id, health)
       VALUES ($1,$2,'prod','shared',$3,'default',$4,$5,$6,'up')
       ON CONFLICT DO NOTHING`,
      [projectId, role, name,
       role === 'db' ? 5432 : role === 'server' ? 4700 : 5180,
       // parameters, not secrets: the meta-db by its in-network service name
       role === 'db' ? 'postgresql://zeehive@meta-db:5432/zeehive' : null,
       site.id]);
  }
  logline('boot', `self-onboard: modeled the running stack (compose project '${composeProject}') as prod site 'local'`);
}
