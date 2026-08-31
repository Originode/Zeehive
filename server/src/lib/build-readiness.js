// MACHINE × PROJECT BUILD-READINESS — "can a build actually work HERE?" (ticket #173).
//
// The pool lets a human place xells on machines nobody has verified can build the project.
// provision.verifyRequires() only checks tiers.spinoff.requires at PROVISION time (and a
// manifest that declares none — omnibiz — checks nothing); preflight.js checks the DSN and
// nothing else; and machine.can_build=false silently degrades to "build on the run host" when
// no registry exists (provision.js ~850-861), logging a console.error nobody reads. Net
// effect: 20 omnibiz containers on 'default' have failed to build forever and nothing anywhere
// says why.
//
// This module is the READ-ONLY probe that answers it up front. For one (machine, project) it
// runs the same docker facts verifyRequires runs, plus the meta-DB facts a placement needs, and
// returns a verdict a human reads where the pool knobs are set:
//
//     { status: 'ok'|'unknown'|'missing', error: string|null,
//       checks: [{ check, ok, skipped, unknown, detail }] }
//
//   ok      → every check passed; a build can work here.
//   missing → at least one check FAILED (a definite missing prerequisite is named).
//   unknown → nothing failed, but a check could not be run (unreachable context, docker
//             absent, timeout) — "unknown/unreachable" is a first-class verdict, never green.
//
// WHAT IT DELIBERATELY DOES NOT DO (same contract as preflight.js):
//   • It never WRITES. No row, no docker object, no provision, no build. A probe that
//     auto-created a missing network or volume would be a probe that fixes what it checks.
//   • It never THROWS for a verdict outcome. A probe that can fail its caller would be a new
//     way to break the console. (A missing machine/project row still throws — the row is gone.)
//   • It never reports GREEN for a check it could not run. unreachable / timeout / absent
//     docker all carry the reason on the check and flip the verdict to 'unknown'.
//
// Every docker call is bounded, spawned the way verifyRequires() does it, and ASYNC — one thin
// adapter (dockerAdapter) so the whole probe is testable without a docker daemon. Async matters:
// a spawnSync adapter would serialize every docker call on the single Node event loop and freeze
// the queenzee (no SSE, no health monitor, no gateway) for the entire probe; with spawn+promise
// the per-machine probes in buildReadinessForProject actually overlap.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { q, one } from '../db/pool.js';
import { config } from '../config.js';
import { sharedDevDb, defaultBuildCtxFor } from './machines.js';
import { serverRoleIsProcess } from './manifest.js';

export const BUILD_READINESS_TIMEOUT_MS = 8000;

const pass = (check, detail) => ({ check, ok: true, skipped: false, unknown: false, detail });
const skip = (check, detail) => ({ check, ok: true, skipped: true, unknown: false, detail });
const fail = (check, detail) => ({ check, ok: false, skipped: false, unknown: false, detail });
const unk = (check, detail) => ({ check, ok: false, skipped: false, unknown: true, detail });

// The one thin docker adapter. Default shells out to `docker --context <ctx> <args…>` exactly
// the way verifyRequires() does — but GENUINELY ASYNC: buildReadinessForProject probes many
// machines in parallel, and a spawnSync-based adapter would serialize every docker call on the
// single Node event loop and FREEZE the queenzee (no SSE, no health monitor, no gateway) for the
// whole probe. spawn + a promise keeps the event loop free and lets the probes actually overlap.
// A test injects a stub here so the probe logic runs without docker.
// Resolves { status, stdout, stderr } when the CLI answered, or
// { unknown, reason } when it could not run at all (no docker binary, spawn error, timeout).
export function dockerAdapter(ctx, args, { timeout = BUILD_READINESS_TIMEOUT_MS, bin = 'docker' } = {}) {
  return new Promise((resolve) => {
    let child;
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } };
    const timer = setTimeout(() => {
      // Timeout: kill the child so no docker process leaks past the ceiling, then report unknown.
      try { child?.kill('SIGKILL'); } catch { /* already gone */ }
      finish({ unknown: true, reason: `${bin} --context ${ctx} did not answer within ${timeout}ms` });
    }, timeout);
    timer.unref?.();   // never keep the process alive for a probe that may already be done
    try {
      child = spawn(bin, ['--context', ctx, ...args], { windowsHide: true });
    } catch (e) {
      finish({ unknown: true, reason: e.message });
      return;
    }
    child.stdout?.on('data', (d) => { stdout += d; });
    child.stderr?.on('data', (d) => { stderr += d; });
    child.on('error', (e) => finish({ unknown: true, reason: e.message }));
    child.on('close', (code, signal) => {
      if (signal || code == null) {
        finish({ unknown: true, reason: `${bin} --context ${ctx} did not answer within ${timeout}ms` });
        return;
      }
      finish({ status: code, stdout, stderr });
    });
  });
}

// The registry a split build would hand its image through — the same rule resolveBuildTarget
// and provision.js apply (project's own, else the global default). null ⇒ no handoff possible.
export function registryForProject(project) {
  const own = project?.registry && String(project.registry).trim();
  return own || config.registry || null;
}

// CHECK 1 — the daemon answers on this context. A context that is not configured, or a daemon
// that is down, is 'unknown' (we cannot say what is here), never a clean green and never a
// "missing prerequisite" — it is a reachability fact, not a missing object.
async function checkContextReachable(ctx, docker) {
  const r = await docker(ctx, ['info', '--format', '{{.ServerVersion}}']);
  if (r.unknown) return unk('context-reachable', `cannot reach context '${ctx}': ${r.reason}`);
  if (r.status !== 0) {
    const why = (r.stderr || r.stdout || '').trim().split('\n').pop() || `docker --context ${ctx} exited ${r.status}`;
    return unk('context-reachable', `daemon on '${ctx}' did not answer: ${why.slice(0, 400)}`);
  }
  return pass('context-reachable', `daemon on '${ctx}' reachable (docker ${(r.stdout || '').trim()})`);
}

// CHECK 2 — the project's spinoff compose resolves. For a process-runner project there is no
// compose stack, so the check is SKIPPED with the reason (asserting nothing is an answer here).
// The file is the same resolution provision/projects use: manifest tiers.spinoff.compose, else
// project.compose_spinoff, else the conventional filename.
async function checkComposeResolves(machine, project, docker) {
  const manifest = project.manifest || {};
  if (serverRoleIsProcess(manifest)) {
    return skip('compose-resolves', 'project\'s spinoff tier is runner:process — no compose stack to resolve');
  }
  const file = manifest.tiers?.spinoff?.compose || project.compose_spinoff || 'docker-compose.spinoff.yml';
  const path = resolve(String(project.repo_root || '').replace(/\\/g, '/'), file);
  if (!existsSync(path)) {
    return fail('compose-resolves', `spinoff compose '${file}' not found in the project repo (${path})`);
  }
  const r = await docker(machine.docker_ctx, ['compose', '-f', path, 'config', '-q']);
  if (r.unknown) return unk('compose-resolves', `could not run compose config for '${file}' on '${machine.docker_ctx}': ${r.reason}`);
  if (r.status !== 0) {
    const why = (r.stderr || r.stdout || '').trim().split('\n').filter(Boolean).slice(-3).join(' · ') || `compose config exited ${r.status}`;
    return fail('compose-resolves', `spinoff compose '${file}' does not resolve on '${machine.docker_ctx}': ${why.slice(0, 400)}`);
  }
  return pass('compose-resolves', `spinoff compose '${file}' resolves on '${machine.docker_ctx}'`);
}

// The alias half of verifyRequires (provision.js ~698-720): a declared alias that resolves to
// nothing is the known "db recreated by docker run drops the compose alias → the whole fleet
// crash-loops" failure. Runs only when the network exists AND the manifest declares aliases.
async function checkNetworkAliases(ctx, network, aliases, docker) {
  const r = await docker(ctx, ['network', 'inspect', network, '--format',
    '{{range $id, $c := .Containers}}{{$c.Name}} {{end}}']);
  if (r.unknown) return unk('requires-present', `could not inspect network '${network}' on '${ctx}': ${r.reason}`);
  if (r.status !== 0) {
    return fail('requires-present', `required network '${network}' does not exist on '${ctx}'`);
  }
  const attached = (r.stdout || '').trim().split(/\s+/).filter(Boolean);
  const found = new Set();
  if (attached.length) {
    const ins = await docker(ctx, ['inspect', ...attached, '--format',
      `{{json (index .NetworkSettings.Networks "${network}").Aliases}}`]);
    if (!ins.unknown && ins.status === 0) {
      for (const line of (ins.stdout || '').split('\n')) {
        try { for (const a of JSON.parse(line) || []) found.add(a); } catch { /* null/garbage line */ }
      }
    }
  }
  const missing = aliases.filter((a) => !found.has(a));
  if (missing.length) {
    return fail('requires-present',
      `network '${network}' on '${ctx}' is missing required alias(es): ${missing.join(', ')}`);
  }
  return pass('requires-present', `network '${network}' on '${ctx}' has alias(es) ${aliases.join(', ')}`);
}

// CHECK 3 — the manifest-declared spinoff prerequisites (tiers.spinoff.requires) exist on this
// machine's daemon. Mirrors verifyRequires() but never throws and never auto-creates: a missing
// network/volume is a named 'missing' fact, an unreachable daemon is 'unknown'.
async function checkRequiresPresent(machine, project, docker) {
  const requires = project.manifest?.tiers?.spinoff?.requires || {};
  const nets = (requires.networks || []).map((n) =>
    typeof n === 'string' ? { name: n, aliases: [] } : { name: n.name, aliases: n.aliases || [] });
  const vols = requires.volumes || [];
  if (!nets.length && !vols.length) {
    return skip('requires-present', 'manifest declares no tiers.spinoff.requires — nothing to verify');
  }
  for (const n of nets) {
    const r = await docker(machine.docker_ctx, ['network', 'inspect', n.name, '--format', '{{.Name}}']);
    if (r.unknown) return unk('requires-present', `could not inspect network '${n.name}' on '${machine.docker_ctx}': ${r.reason}`);
    if (r.status !== 0) {
      return fail('requires-present', `required network '${n.name}' does not exist on '${machine.docker_ctx}'`);
    }
    if (n.aliases.length) {
      const a = await checkNetworkAliases(machine.docker_ctx, n.name, n.aliases, docker);
      if (!a.ok) return a;
    }
  }
  for (const v of vols) {
    const r = await docker(machine.docker_ctx, ['volume', 'inspect', v]);
    if (r.unknown) return unk('requires-present', `could not inspect volume '${v}' on '${machine.docker_ctx}': ${r.reason}`);
    if (r.status !== 0) {
      return fail('requires-present', `required external volume '${v}' does not exist on '${machine.docker_ctx}' — it is DATA and is never auto-created`);
    }
  }
  return pass('requires-present',
    `declared spinoff requires present on '${machine.docker_ctx}' (${nets.length} net(s), ${vols.length} volume(s))`);
}

// CHECK 4 — this machine has the project's shared dev db ON it. A dev xell's app tier must
// never cross docker contexts for its database (spec), so no shared dev db here means this
// machine cannot host the project's dev xells. Pure meta-DB read — no docker call.
// A project whose default coupling is db-isolated shapes a per-xell dev db (each xell's db comes
// up with its own compose stack) — for it, "no shared dev db on the machine" is the CORRECT
// state, not a missing prerequisite, so the check is SKIPPED with the reason, never a red X.
async function checkSharedDevDb(project, machine) {
  const coupling = project?.db_coupling || 'db-shared-dev';
  if (coupling !== 'db-shared-dev' && coupling !== 'db-clone') {
    return skip('shared-dev-db',
      `project shapes a per-xell dev db (default_db_coupling=${coupling}) — no shared dev db expected; each xell's db comes up with its own compose stack`);
  }
  const row = await sharedDevDb(project.id, machine.docker_ctx);
  if (!row) {
    return fail('shared-dev-db',
      `no shared dev db for this project on '${machine.docker_ctx}' — dev xells cannot spawn here (their db must never live on another machine)`);
  }
  return pass('shared-dev-db', `shared dev db '${row.name}' present on '${machine.docker_ctx}'`);
}

// CHECK 5 — when this machine cannot build, can a split build actually hand the image over?
// This is the defect the ticket names: can_build=false + no registry currently degrades
// silently to "build on the run host" (provision.js ~850-861). Reported here as a named
// 'missing' so the pool knob stops being set blind.
async function checkRegistryForHandoff(machine, project) {
  if (machine.can_build) {
    return skip('registry-for-handoff', 'machine can build its own images — no registry handoff needed');
  }
  // Where would this machine's images compile? defaultBuildCtxFor returns the best can_build
  // machine, or null when none exists (→ the current silent "build on the run host" fallback).
  const buildCtx = await defaultBuildCtxFor(machine);
  const registry = registryForProject(project);
  if (!buildCtx) {
    return fail('registry-for-handoff',
      `machine '${machine.key}' cannot build and there is no build-capable machine to compile for it — `
      + 'provision falls back to building ON THIS HOST, which is exactly the compile this machine '
      + 'cannot do. Add a can_build machine, or tick can_build here.');
  }
  if (!registry) {
    return fail('registry-for-handoff',
      `machine '${machine.key}' cannot build: its images would compile on '${buildCtx}' and be handed `
      + 'over via a registry, but no registry is configured (project.registry / SPINOFF_REGISTRY empty). '
      + 'The split build cannot happen, so the provision fallback builds on this host anyway.');
  }
  return pass('registry-for-handoff',
    `images compile on '${buildCtx}' and are handed over via registry '${registry}'`);
}

// The resolver — one (machine, project) → a verdict. Never throws for a verdict outcome.
export async function probeBuildReadiness(machine, project, { docker = dockerAdapter } = {}) {
  const checks = [];
  checks.push(await checkContextReachable(machine.docker_ctx, docker));

  // The remaining checks still run even when the context is down: compose-resolves and
  // requires-present will answer 'unknown' (they need the daemon), while shared-dev-db and
  // registry-for-handoff are pure meta-DB reads that do not. A definite missing fact beats
  // "could not tell" in the overall verdict — we know it cannot build here.
  checks.push(await checkComposeResolves(machine, project, docker));
  checks.push(await checkRequiresPresent(machine, project, docker));
  checks.push(await checkSharedDevDb(project, machine));
  checks.push(await checkRegistryForHandoff(machine, project));

  const definite = checks.filter((c) => !c.ok && !c.unknown);
  const unknown = checks.filter((c) => c.unknown);
  let status = 'ok';
  if (definite.length) status = 'missing';
  else if (unknown.length) status = 'unknown';
  const error = status === 'ok' ? null
    : (definite.length ? definite : unknown)
        .map((c) => `${c.check}: ${c.detail}`).join(' · ');
  return { status, error, checks };
}

// Every machine (enabled or not — a disabled one still holding pool knobs deserves an answer)
// for a project, probed in parallel. Read-only; each probe is bounded; a single unreachable
// machine cannot stall the rest. Returns one entry per machine with the machine facts the UI
// renders, plus the probe verdict.
export async function buildReadinessForProject(projectId, { docker = dockerAdapter } = {}) {
  const project = await one(`SELECT * FROM project WHERE id=$1`, [projectId]);
  if (!project) throw new Error('project not found');
  // The project's DEFAULT db coupling decides whether a shared dev db is expected at all:
  // db-shared-dev / db-clone share one; db-isolated shapes a per-xell db (no shared dev db).
  // (pool_config is a per-project row, so this is one indexed read.)
  const pc = await one(`SELECT default_db_coupling FROM pool_config WHERE project_id=$1`, [projectId]);
  if (pc?.default_db_coupling) project.db_coupling = pc.default_db_coupling;
  const machines = await q(
    `SELECT m.*, COALESCE(mp.pool_size, 0) AS pool_size, COALESCE(mp.dev_priority, 0) AS dev_priority
       FROM machine m LEFT JOIN machine_pool mp ON mp.machine_id = m.id AND mp.project_id = $1
      ORDER BY COALESCE(mp.dev_priority, 0) DESC, m.created_at`, [projectId]);
  const rows = await Promise.all(machines.map(async (m) => {
    const probe = await probeBuildReadiness(m, project, { docker });
    return {
      machine_id: m.id,
      machine_key: m.key,
      docker_ctx: m.docker_ctx,
      can_build: !!m.can_build,
      pool_size: Number(m.pool_size) || 0,
      dev_priority: Number(m.dev_priority) || 0,
      enabled: !!m.enabled,
      ...probe,
    };
  }));
  return rows;
}

// Upsert one (machine, project) verdict into build_readiness_record — latest verdict per pair;
// history stays in the event log (migration 236). The pool queue persists the outcome of each
// proof here, and the hourly re-record cycle persists fresh probe results, so every reader (the
// console machine matrix, the pool fill, the proof backfill) consults the RECORD, not a live
// docker round-trip (DR-2).
export async function upsertBuildReadinessRecord(machineId, projectId, { status, error = null, checks = [] } = {}) {
  if (!machineId || !projectId || !status) return null;
  return one(
    `INSERT INTO build_readiness_record (machine_id, project_id, status, error, checks)
     VALUES ($1,$2,$3,$4,$5::jsonb)
     ON CONFLICT (machine_id, project_id)
     DO UPDATE SET status=$3, error=$4, checks=$5::jsonb, probed_at=now()
     RETURNING *`,
    [machineId, projectId, status, error, JSON.stringify(checks || [])]);
}

// The RECORDED build-readiness read model — the console machine matrix's default source. Reads
// build_readiness_record (one fact serves all N xells on a pair) instead of requiring a fresh
// probe click. Returns the same per-machine shape buildReadinessForProject does; a machine with
// no record has status null (the badge shows "not checked yet"). `recorded:false` distinguishes
// "never probed" from a real verdict.
export async function recordedBuildReadinessForProject(projectId) {
  const project = await one(`SELECT id FROM project WHERE id=$1`, [projectId]);
  if (!project) throw new Error('project not found');
  const rows = await q(
    `SELECT m.id AS machine_id, m.key AS machine_key, m.docker_ctx, m.can_build,
            COALESCE(mp.pool_size, 0) AS pool_size, COALESCE(mp.dev_priority, 0) AS dev_priority,
            m.enabled,
            br.status, br.error, br.checks, br.probed_at
       FROM machine m
       LEFT JOIN machine_pool mp ON mp.machine_id = m.id AND mp.project_id = $1
       LEFT JOIN build_readiness_record br ON br.machine_id = m.id AND br.project_id = $1
      ORDER BY COALESCE(mp.dev_priority, 0) DESC, m.created_at`, [projectId]);
  return rows.map((r) => ({
    machine_id: r.machine_id,
    machine_key: r.machine_key,
    docker_ctx: r.docker_ctx,
    can_build: !!r.can_build,
    pool_size: Number(r.pool_size) || 0,
    dev_priority: Number(r.dev_priority) || 0,
    enabled: !!r.enabled,
    status: r.status || null,
    error: r.error || null,
    checks: r.checks || [],
    probed_at: r.probed_at || null,
    recorded: !!r.status,
  }));
}

// Persist a batch of probe rows (from buildReadinessForProject) into the record — the refresh
// path: a human's recheck click updates the persistent fact, so the badge never needs a recent
// click again. Returns the count written.
export async function recordBuildReadinessProbe(projectId, rows) {
  let n = 0;
  for (const r of rows) {
    if (!r.machine_id || !r.status) continue;
    const rec = await upsertBuildReadinessRecord(r.machine_id, projectId, r).catch(() => null);
    if (rec) n++;
  }
  return n;
}
