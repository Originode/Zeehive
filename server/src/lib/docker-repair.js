// DOCKER REPAIR — the medic's host lever for WEDGED docker state (the fault family bootstrap
// deliberately refuses: docs/provision-proof-kit/stage-3, and build-bootstrap.js's own header —
// "never removes/prunes/reconfigures").
//
// WHY THIS EXISTS. The live PROVISION-INFRA fault class is not "a prerequisite is missing" (that
// is bootstrap's job) but "the daemon is wedged by LEFTOVERS": retired xells' spin networks
// exhausting the address pools ('all predefined address pools have been fully subnetted',
// TKT-178), a retired xell's husk container squatting a host port, a known shared dev db sitting
// exited. The first meta-plane medics diagnosed all of it correctly and then dead-ended with
// "I hold no docker lever — no medic tool execs on a host": every card ended in a human running
// docker by hand, which defeats the medic. This module is that lever — run by the QUEENZEE
// process (which owns every docker context; the meta-plane medic runs inside it), never by an
// agent shell.
//
// THE SAFETY LINE, drawn in code, not prompt:
//   • REMOVE only what is provably throwaway:
//       - a network whose name carries the spin infix ('-spin-') with ZERO attached containers
//         and not named by ANY project's manifest `requires` (a required external is never
//         pruned, empty or not);
//       - a container whose spin-naming slug resolves to a RETIRED xell in THIS meta-DB (the
//         husk the reaper failed to remove — `rm -f` is exactly what reap would have done).
//         An unknown slug is reported, never removed: on a shared daemon it may be somebody
//         else's.
//   • START only what the meta-DB already models: a `container` row (role db, tier dev) on this
//     machine whose docker state is exited/created. Starting is additive; nothing is ever
//     stopped or reconfigured.
//   • REFUSE the whole action when the daemon is unreachable (bootstrap's rule: never act blind).
//   • Everything else — a live squatter, an unknown container, a missing prerequisite — is a
//     named 'cannot' step for a human (or for bootstrap, whose job it is).
//
// Same testable shape as build-bootstrap.js: every docker call goes through the injected bounded
// async adapter, planDockerRepair is the dry run, performDockerRepair performs and re-checks.
import { q, one } from '../db/pool.js';
import { dockerAdapter } from './build-readiness.js';
import { logline } from './logbus.js';

// Container-name shapes a spin leftover can have (lib/manifest.js namingFor defaults:
// `${p}_spin_{role}_{slug}` for app tiers, and the provisioner's `${p}_db_spin_{slug}` for the
// per-xell clone db). A project with custom naming simply won't match — its leftovers are
// reported by the network pass (empty spin networks) and otherwise left for a human.
const SPIN_CONTAINER_SLUG = [/^.+_spin_[^_]+_(.+)$/, /^.+_db_spin_(.+)$/];

export function spinContainerSlug(name) {
  for (const re of SPIN_CONTAINER_SLUG) {
    const m = re.exec(String(name || ''));
    if (m) return m[1];
  }
  return null;
}

// Networks named in ANY project's manifest requires (any tier): required externals, never pruned.
async function requiredNetworkNames() {
  const rows = await q(`SELECT manifest FROM project WHERE manifest IS NOT NULL`);
  const names = new Set();
  for (const r of rows) {
    for (const tier of Object.values(r.manifest?.tiers || {})) {
      for (const n of tier?.requires?.networks || []) {
        names.add(typeof n === 'string' ? n : n?.name);
      }
    }
  }
  names.delete(undefined);
  return names;
}

// ── the plan (the dry run — reads the daemon, mutates nothing) ───────────────
export async function planDockerRepair(machine, { docker = dockerAdapter } = {}) {
  const ctx = machine.docker_ctx;
  const steps = [];
  const cannot = (target, why) => steps.push({ kind: 'cannot', target, why, action: null,
    status: 'cannot', detail: why, stderr: null });

  // Never act blind (bootstrap's rule).
  const ping = await docker(ctx, ['version', '--format', '{{.Server.Version}}']);
  if (ping.unknown || ping.status !== 0) {
    return { steps: [], refused: `cannot repair '${machine.key}' (${ctx}): the docker context is `
      + `not reachable — ${ping.reason || (ping.stderr || '').trim() || 'daemon did not answer'}. `
      + `The repair never runs against a daemon it cannot reach.` };
  }

  // 1. STALE SPIN NETWORKS — the address-pool exhaustion fix. '-spin-' in the name, zero attached
  //    containers, not a required external → removable. Non-empty ones are named so the medic can
  //    see what still pins them.
  const protectedNets = await requiredNetworkNames();
  const ls = await docker(ctx, ['network', 'ls', '--format', '{{.Name}}']);
  if (ls.unknown || ls.status !== 0) {
    cannot('networks', `could not list networks on '${ctx}': ${ls.reason || (ls.stderr || '').trim()}`);
  } else {
    const spinNets = (ls.stdout || '').split('\n').map((s) => s.trim())
      .filter((n) => n && n.includes('-spin-') && !protectedNets.has(n));
    for (const n of spinNets) {
      const ins = await docker(ctx, ['network', 'inspect', n, '--format', '{{len .Containers}}']);
      if (ins.unknown || ins.status !== 0) {
        cannot(`network '${n}'`, `could not inspect network '${n}' on '${ctx}': ${ins.reason || (ins.stderr || '').trim()}`);
      } else if ((ins.stdout || '').trim() === '0') {
        steps.push({ kind: 'stale-network', target: n,
          why: `spin network '${n}' has no attached containers — a retired xell's leftover holding an address pool`,
          action: `docker network rm ${n}`, status: 'planned', detail: null, stderr: null });
      } else {
        cannot(`network '${n}'`, `spin network '${n}' still has ${(ins.stdout || '').trim()} attached `
          + `container(s) — not stale; remove/retire those containers first`);
      }
    }
  }

  // 2. RETIRED-XELL HUSK CONTAINERS — the port squatters. A spin-named container whose slug is a
  //    RETIRED xell of this meta-DB is a husk reap failed to remove; anything else is reported,
  //    never touched.
  const ps = await docker(ctx, ['ps', '-a', '--format', '{{.Names}}\t{{.State}}']);
  if (ps.unknown || ps.status !== 0) {
    cannot('containers', `could not list containers on '${ctx}': ${ps.reason || (ps.stderr || '').trim()}`);
  } else {
    for (const line of (ps.stdout || '').split('\n')) {
      const [name, state] = line.trim().split('\t');
      const slug = spinContainerSlug(name);
      if (!slug) continue;
      const x = await one(`SELECT id, status FROM xell WHERE slug=$1`, [slug]);
      if (x && x.status !== 'retired') continue;                    // a live xell's container — normal
      if (!x) {
        cannot(`container '${name}'`, `spin container '${name}' (${state}) has slug '${slug}' this `
          + `meta-DB does not know — possibly another install's; not touching it`);
        continue;
      }
      steps.push({ kind: 'stale-container', target: name,
        why: `container '${name}' (${state}) belongs to RETIRED xell '${slug}' — a husk the reaper `
          + `left behind (it may squat a host port)`,
        action: `docker rm -f ${name}`, status: 'planned', detail: null, stderr: null });
    }
  }

  // 3. STOPPED KNOWN DEV DBS — start what the meta-DB already models, never provision (bootstrap's
  //    job) and never stop anything.
  const dbs = await q(
    `SELECT name FROM container WHERE role='db' AND tier='dev' AND docker_ctx=$1`, [ctx]);
  for (const row of dbs) {
    const ins = await docker(ctx, ['inspect', row.name, '--format', '{{.State.Status}}']);
    if (ins.unknown) {
      cannot(`db '${row.name}'`, `could not inspect '${row.name}' on '${ctx}': ${ins.reason}`);
    } else if (ins.status !== 0) {
      cannot(`db '${row.name}'`, `the meta-DB models dev db '${row.name}' on '${ctx}' but no such `
        + `container exists — that is a (re)provision, not a repair; use the bootstrap card`);
    } else if (['exited', 'created', 'dead'].includes((ins.stdout || '').trim())) {
      steps.push({ kind: 'db-start', target: row.name,
        why: `known dev db '${row.name}' is ${(ins.stdout || '').trim()} on '${ctx}'`,
        action: `docker start ${row.name}`, status: 'planned', detail: null, stderr: null });
    }
  }

  return { steps, refused: null };
}

// ── the performer ────────────────────────────────────────────────────────────
async function performStep(step, ctx, { docker }) {
  const run = async (args, okStatus, okDetail) => {
    const r = await docker(ctx, args);
    if (r.unknown) return { status: 'failed', detail: r.reason, stderr: null };
    if (r.status !== 0) {
      // Idempotence under a race: gone between plan and perform is the outcome we wanted.
      if (/no such|not found/i.test((r.stderr || '') + (r.stdout || ''))) {
        return { status: 'already-gone', detail: `'${step.target}' was already gone on '${ctx}'`, stderr: null };
      }
      return { status: 'failed', detail: `${step.action} failed on '${ctx}'`,
               stderr: (r.stderr || r.stdout || '').trim().slice(0, 500) };
    }
    return { status: okStatus, detail: okDetail, stderr: null };
  };
  if (step.kind === 'stale-network') {
    return run(['network', 'rm', step.target], 'removed', `network '${step.target}' removed on '${ctx}'`);
  }
  if (step.kind === 'stale-container') {
    return run(['rm', '-f', step.target], 'removed', `container '${step.target}' removed on '${ctx}'`);
  }
  if (step.kind === 'db-start') {
    return run(['start', step.target], 'started', `dev db '${step.target}' started on '${ctx}'`);
  }
  return { status: 'cannot', detail: `no performer for step kind '${step.kind}'`, stderr: null };
}

function overallStatus(results) {
  if (!results.length) return 'nothing-to-repair';
  if (results.some((s) => s.status === 'failed')) return 'failed';
  if (results.some((s) => s.status === 'removed' || s.status === 'started')) return 'repaired';
  if (results.every((s) => s.status === 'cannot')) return 'cannot';
  return 'nothing-to-repair';
}

// THE ENTRY. dryRun returns the plan and performs nothing; otherwise performs each planned step
// and reports what is now true. Never throws for a verdict outcome; a missing machine row throws.
export async function performDockerRepair(machineId, { dryRun = false, docker = dockerAdapter,
                                                       actor = 'medic' } = {}) {
  const machine = await one(
    `SELECT * FROM machine WHERE id::text=$1 OR key=$1`, [String(machineId)]);
  if (!machine) throw new Error(`no machine '${machineId}' — name it by key or id (see settings/readiness)`);

  const { steps, refused } = await planDockerRepair(machine, { docker });
  if (refused) {
    logline('machine', `docker repair REFUSED on ${machine.key} by ${actor}: ${refused}`);
    return { status: 'refused', reason: refused, machine: machine.key, steps: [] };
  }
  if (dryRun) return { status: 'planned', machine: machine.key, plan: steps };

  const results = [];
  for (const step of steps) {
    if (step.status === 'cannot') { results.push(step); continue; }
    results.push({ ...step, ...(await performStep(step, machine.docker_ctx, { docker })) });
  }
  const status = overallStatus(results);
  logline('machine', `docker repair ${status} on ${machine.key} by ${actor}: `
    + (results.map((s) => `${s.kind}:${s.target}=${s.status}`).join(', ') || 'nothing to do'));
  return { status, machine: machine.key, results };
}

// ── the JANITOR — the reaper's reconciler (docs/netbird-mesh-plan.md §3.6, DR-2) ─────────────────
//
// Reap-time cleanup is best-effort by contract: a context down at reap time, a queenzee killed
// mid-teardown, a despawn script that half-ran — each leaves a leftover the reaper will never
// revisit, and leftovers are what wedged both build hosts (TKT-178: address pools exhausted by
// retired xells' spin networks; TKT-85: husks squatting host ports). This sweep runs the SAME plan
// the medic's button runs, on a schedule, and auto-performs ONLY the two step kinds that are
// provably throwaway by the safety line at the top of this file:
//
//   stale-network    an empty '-spin-' network no manifest requires
//   stale-container  a spin-named husk whose slug is a RETIRED xell of this meta-DB
//
// Everything else the plan finds — a db to start, a 'cannot' — is REPORTED (logged) and left for
// the medic plane and its human gates: starting things and judging the unknown are not a tick's
// call. A single verified case of this sweep removing something live demotes it to plan-and-report
// (DR-2's "what would change our mind").
export const AUTO_REPAIR_KINDS = ['stale-network', 'stale-container'];

export async function sweepDockerLeftovers({ dryRun = true, docker = dockerAdapter } = {}) {
  const machines = await q(
    `SELECT * FROM machine WHERE enabled AND docker_ctx IS NOT NULL ORDER BY key`);
  const summary = [];
  for (const machine of machines) {
    const { steps, refused } = await planDockerRepair(machine, { docker });
    if (refused) {
      // An unreachable daemon is bootstrap's rule ("never act blind") doing its job — quiet at
      // janitor cadence; the readiness probe and the medic plane already surface a down host.
      summary.push({ machine: machine.key, refused });
      continue;
    }
    const auto = steps.filter((s) => s.status === 'planned' && AUTO_REPAIR_KINDS.includes(s.kind));
    const held = steps.filter((s) => !auto.includes(s));
    if (!auto.length) { summary.push({ machine: machine.key, results: [], held: held.length }); continue; }
    if (dryRun) {
      logline('maint', `docker janitor (dry run) on ${machine.key}: would remove `
        + auto.map((s) => `${s.kind}:${s.target}`).join(', ')
        + (held.length ? ` (+${held.length} step(s) left for the medic plane)` : ''));
      summary.push({ machine: machine.key, planned: auto, held: held.length });
      continue;
    }
    const results = [];
    for (const step of auto) {
      results.push({ ...step, ...(await performStep(step, machine.docker_ctx, { docker })) });
    }
    const removed = results.filter((s) => s.status === 'removed' || s.status === 'already-gone');
    const failed = results.filter((s) => s.status === 'failed');
    if (removed.length || failed.length) {
      logline('maint', `docker janitor on ${machine.key}: `
        + results.map((s) => `${s.kind}:${s.target}=${s.status}`).join(', ')
        + (held.length ? ` (+${held.length} step(s) left for the medic plane)` : ''));
    }
    summary.push({ machine: machine.key, results, held: held.length });
  }
  return summary;
}

// Periodic janitor, the same knobs and stance as lib/images.js startImageJanitor: on by default
// (the leak is silent and unbounded), disableable, and DRY RUN unless this queenzee is allowed to
// touch machines at all (PROVISION_MODE=real — a simulate queenzee's meta-DB is a clone, so its
// 'retired' verdicts describe somebody else's fleet).
export function startDockerJanitor() {
  if (process.env.DOCKER_JANITOR_ENABLED === 'false') {
    console.log('[queenzee] docker janitor DISABLED (DOCKER_JANITOR_ENABLED=false)');
    return;
  }
  const interval = Number(process.env.DOCKER_JANITOR_MS) || 3600000; // hourly
  const dryRun = process.env.DOCKER_JANITOR_DRY_RUN === 'true'
    || (process.env.PROVISION_MODE === 'real' ? 'real' : 'simulate') !== 'real';
  const tick = async () => {
    await sweepDockerLeftovers({ dryRun })
      .catch((e) => console.error('[docker-repair] janitor sweep:', e.message));
    // The mesh pass (netbird-mesh-plan §3.6): control-plane peers the meta-DB no longer intends.
    // A control-plane write, so it obeys the same dry-run verdict as the docker side; disabled
    // mesh is a silent no-op inside the sweep.
    if (!dryRun) {
      const { sweepOrphanMeshPeers } = await import('./netbird.js');
      await sweepOrphanMeshPeers()
        .catch((e) => console.error('[docker-repair] mesh sweep:', e.message));
    }
  };
  setTimeout(tick, 90000);          // not at boot — let the fleet settle first (after images' 60s)
  setInterval(tick, interval);
  console.log(`[queenzee] docker janitor started (${interval}ms${dryRun ? ', DRY RUN' : ''})`);
}
