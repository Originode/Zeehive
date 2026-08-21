// MACHINE × PROJECT BUILD BOOTSTRAP — "make this machine buildable", one console click (ticket #173
// follow-on). The build-readiness probe (lib/build-readiness.js) NAMES what is missing on a
// (machine, project) pair; this module is the QUEENZEE-PERFORMED action that CREATES those missing
// DEV prerequisites and reports per prerequisite what it did.
//
// CONTRACT (the card's hard boundaries):
//   • QUEENZEE-performed, HUMAN-clicked. No agent ever runs docker; this module is the queenzee
//     running the action a human started from the console.
//   • It only CREATES what the project's manifest DECLARES for the spinoff (DEV) tier — external
//     networks and the shared dev db. It NEVER invents infrastructure (no registry, no machine, no
//     volume — a volume is DATA and is never auto-created), never removes/prunes/reconfigures
//     anything that exists, and never touches a running container.
//   • PLAN FIRST: performBuildBootstrap({ dryRun:true }) returns the ordered plan and performs
//     nothing; the console shows that plan before a human commits.
//   • Idempotent: a step re-checks before it creates, and re-running after a partial failure
//     cannot duplicate anything (a network create is refused by docker when it exists; the dev-db
//     provision has its own in-flight lock and an ON CONFLICT upsert).
//   • Every docker call goes through the probe's bounded ASYNC dockerAdapter (never spawnSync —
//     a sync adapter would serialize every call on the single Node event loop and freeze the
//     queenzee). A test injects a stub here the same way build-readiness.test.mjs does.
//   • DEV-ONLY GUARD: refuses, in code, to CREATE a network/volume the PROD tier also declares.
//     A machine whose context ALSO hosts this project's prod stack is DISCLOSED (the plan names it
//     for the human to confirm), not refused — in the single-host topology dev and prod share the
//     host, so refusing there would switch the bootstrap off on the most common installation.
//   • Every action is RECORDED: who asked, what ran, what came back (build_bootstrap_action).
import { one } from '../db/pool.js';
import { probeBuildReadiness, dockerAdapter } from './build-readiness.js';
import { sharedDevDb, provisionDevDb } from './machines.js';
import { broadcast } from './events.js';
import { logline } from './logbus.js';

// ── the DEV-only guard ────────────────────────────────────────────────────────
// The bootstrap creates DEV prerequisites, so it must NEVER create a network/volume the project's
// PROD tier also declares — a name collision would silently satisfy (or half-satisfy) a prod
// dependency. This is the PRECISE prod protection: it reads what the manifest ACTUALLY declares
// (never a name convention), and refuses in code so a test can prove it.
// The OTHER fact — the machine's docker context ALSO hosting this project's PROD stack — is a
// DISCLOSURE, not a refusal. In the single-host topology (this product's default) the same docker
// host carries dev AND prod, so refusing there would switch the bootstrap off on the most common
// installation. hostProdDisclosure() surfaces it for the human to confirm instead: the bootstrap
// still creates only what the spinoff tier declares (none of which the prod tier declares, by the
// guard above) and touches no existing container, volume or network.
export function guardDevOnly(machine, project) {
  const prodReq = project.manifest?.tiers?.prod?.requires;
  const spinReq = project.manifest?.tiers?.spinoff?.requires;
  if (prodReq && spinReq) {
    const names = (l) => (l || []).map((n) => (typeof n === 'string' ? n : n.name));
    const prod = new Set([...names(prodReq.networks), ...(prodReq.volumes || [])]);
    const dev = new Set([...names(spinReq.networks), ...(spinReq.volumes || [])]);
    const overlap = [...dev].filter((n) => prod.has(n));
    if (overlap.length) {
      throw new Error(
        `refusing to bootstrap dev prerequisites on '${machine.key}': network/volume `
        + `${overlap.join(', ')} is also declared by the PROD tier — the bootstrap never creates `
        + `prod infrastructure.`);
    }
  }
}

// When the machine's docker context ALSO hosts this project's PROD stack (single-host topology),
// the bootstrap can still run — it creates only what the spinoff tier declares, none of which the
// prod tier declares (guardDevOnly enforces that), and touches no existing container/volume/network —
// but the human must confirm they understand the host carries prod. Returns that disclosure (a
// sentence the plan shows before a human commits), or null when the host does not run prod here.
export async function hostProdDisclosure(machine, project, createNames = []) {
  const ctx = machine.docker_ctx;
  const prodSite = await one(
    `SELECT 1 FROM deploy_site WHERE project_id=$1 AND docker_ctx=$2 AND tier='prod' LIMIT 1`,
    [project.id, ctx]);
  const prodContainer = await one(
    `SELECT 1 FROM container WHERE project_id=$1 AND docker_ctx=$2 AND tier='prod' LIMIT 1`,
    [project.id, ctx]);
  if (!prodSite && !prodContainer) return null;
  const names = createNames.length ? createNames.join(', ') : 'nothing';
  return `this host ('${ctx}') also runs this project's PROD ${prodSite ? 'deploy site' : 'container'}; `
    + `the bootstrap will create only ${names}, none of which the prod tier declares, and it touches `
    + `no existing container, volume or network.`;
}

// ── the planner ───────────────────────────────────────────────────────────────
// Run the probe and turn its failing checks into an ORDERED list of steps the performer can run.
// Each step: { kind, target, why, action, status, detail, stderr }.
//   kind   'network' | 'shared-dev-db' (performable) | 'cannot' (a human action, not a queenzee one)
//   status 'planned' (not yet performed) | 'cannot' (never performable)
// A step is 'cannot' when the bootstrap is NOT the right tool: a missing volume (DATA), a missing
// registry / build machine (configuration + credentials, a human's decision), a compose file that
// does not resolve (a repo/manifest defect), or an alias a running container lost (never touched).
export async function planBuildBootstrap(machine, project, { docker = dockerAdapter } = {}) {
  // The probe reads project.db_coupling to decide whether a shared dev db is expected at all
  // (buildReadinessForProject attaches it from pool_config before probing). Attach it here too so
  // a direct planBuildBootstrap caller gets the same answer — never assume the caller did.
  if (project?.id && !project.db_coupling) {
    const pc = await one(`SELECT default_db_coupling FROM pool_config WHERE project_id=$1`, [project.id]);
    if (pc?.default_db_coupling) project.db_coupling = pc.default_db_coupling;
  }
  // The precise DEV-only guard — throws when the spinoff tier declares a network/volume the PROD
  // tier also declares. Host-level prod is a DISCLOSURE (below), not a refusal.
  guardDevOnly(machine, project);
  const probe = await probeBuildReadiness(machine, project, { docker });
  if (probe.status === 'ok') return { probe, steps: [], refused: null, disclosure: null };

  const check = (name) => probe.checks.find((c) => c.check === name);
  const ctxCheck = check('context-reachable');
  // REFUSE THE WHOLE ACTION when the daemon is unreachable: never half-run a bootstrap against a
  // machine we could not reach (manager's rule; a network create would fail blind and the probe
  // cannot even tell us what is missing).
  if (ctxCheck && !ctxCheck.ok && ctxCheck.unknown) {
    return {
      probe, steps: [], disclosure: null,
      refused: `cannot act on '${machine.key}' (${machine.docker_ctx}): the docker context is not `
        + `reachable — ${ctxCheck.detail}. Fix the machine's context/daemon and re-check; the `
        + `bootstrap never runs against a daemon it cannot reach.`,
    };
  }

  const steps = [];
  const cannot = (checkName, target, action, reason) => steps.push({
    kind: 'cannot', target, why: checkName.detail, action: action || null,
    status: 'cannot', detail: reason, stderr: null,
  });

  const req = check('requires-present');
  if (req && !req.ok) {
    const requires = project.manifest?.tiers?.spinoff?.requires || {};
    const nets = (requires.networks || []).map((n) =>
      typeof n === 'string' ? { name: n, aliases: [] } : { name: n.name, aliases: n.aliases || [] });
    const vols = requires.volumes || [];
    const aliasComplaint = /missing required alias/.test(req.detail);
    for (const n of nets) {
      const r = await docker(machine.docker_ctx, ['network', 'inspect', n.name, '--format', '{{.Name}}']);
      if (r.unknown) {
        cannot(req, `network '${n.name}'`, null,
          `could not verify network '${n.name}' on '${machine.docker_ctx}': ${r.reason}`);
      } else if (r.status !== 0) {
        steps.push({
          kind: 'network', target: n.name,
          why: `required external network '${n.name}' does not exist on '${machine.docker_ctx}'`,
          action: `docker network create ${n.name}`,
          status: 'planned', detail: null, stderr: null,
        });
      } else if (aliasComplaint && req.detail.includes(n.name)) {
        cannot(req, `network '${n.name}' aliases`, null,
          `network '${n.name}' exists on '${machine.docker_ctx}' but the probe reports missing `
          + `required alias(es) — a container was recreated without them. The bootstrap never `
          + `reconfigures a running container; re-create it via compose.`);
      }
    }
    for (const v of vols) {
      const r = await docker(machine.docker_ctx, ['volume', 'inspect', v]);
      if (r.unknown) {
        cannot(req, `volume '${v}'`, null,
          `could not verify volume '${v}' on '${machine.docker_ctx}': ${r.reason}`);
      } else if (r.status !== 0) {
        cannot(req, `volume '${v}'`, null,
          `required external volume '${v}' does not exist on '${machine.docker_ctx}' — external `
          + `volumes are DATA and are NEVER auto-created. Create it from the project's bootstrap `
          + `doc, then re-check.`);
      }
    }
  }

  const sdb = check('shared-dev-db');
  if (sdb && !sdb.ok) {
    steps.push({
      kind: 'shared-dev-db', target: 'shared dev db',
      why: sdb.detail,
      action: `provision the shared dev db for ${project.name} on ${machine.key} (provisionDevDb)`,
      status: 'planned', detail: null, stderr: null,
    });
  }

  const reg = check('registry-for-handoff');
  if (reg && !reg.ok) {
    cannot(reg, 'registry / build machine', null,
      reg.detail + ' Set project.registry (or SPINOFF_REGISTRY) to a registry the build host and '
      + 'this machine can both reach, or tick can_build on this machine / add a build-capable '
      + 'machine — a bootstrap never invents a registry.');
  }

  const comp = check('compose-resolves');
  if (comp && !comp.ok) {
    cannot(comp, 'spinoff compose', null, comp.detail);
  }

  // Host-level prod is a DISCLOSURE the human confirms, not a refusal: in the single-host topology
  // dev and prod share the docker host, so refusing there would switch the bootstrap off by default.
  // Only attach it when there is something the bootstrap will actually create.
  const createNames = steps.filter((s) => s.status === 'planned').map((s) => s.target);
  let disclosure = null;
  if (createNames.length) {
    disclosure = await hostProdDisclosure(machine, project, createNames);
    if (disclosure) {
      steps.unshift({
        kind: 'disclosure', target: 'prod stack on this host',
        why: 'this machine\'s docker context also runs this project\'s PROD stack',
        action: null, status: 'disclosure', detail: disclosure, stderr: null,
      });
    }
  }

  return { probe, steps, refused: null, disclosure };
}

// ── the performer ─────────────────────────────────────────────────────────────
// Run ONE planned step idempotently and return its result:
//   { status: 'created'|'already-present'|'cannot'|'failed'|'started', detail, stderr }
async function performStep(step, machine, project, { docker, provisionDb }) {
  if (step.kind === 'network') {
    // Idempotent: re-check before creating (a previous run, or a human, may have got there first).
    const exists = await docker(machine.docker_ctx, ['network', 'inspect', step.target, '--format', '{{.Name}}']);
    if (!exists.unknown && exists.status === 0) {
      return { status: 'already-present',
               detail: `network '${step.target}' already exists on '${machine.docker_ctx}'`, stderr: null };
    }
    const r = await docker(machine.docker_ctx, ['network', 'create', step.target]);
    if (r.unknown) {
      return { status: 'failed',
               detail: `could not create network '${step.target}' on '${machine.docker_ctx}': ${r.reason}`,
               stderr: null };
    }
    if (r.status !== 0) {
      // Idempotence under a race: the network appeared between our inspect and create, so docker
      // refuses with "already exists" — that is already-present, not a failure.
      if (/already exists/i.test((r.stderr || '') + (r.stdout || ''))) {
        return { status: 'already-present',
                 detail: `network '${step.target}' already exists on '${machine.docker_ctx}' (appeared between check and create)`,
                 stderr: null };
      }
      return { status: 'failed',
               detail: `docker network create '${step.target}' failed on '${machine.docker_ctx}'`,
               stderr: (r.stderr || r.stdout || '').trim() };
    }
    return { status: 'created',
             detail: `network '${step.target}' created on '${machine.docker_ctx}'`, stderr: null };
  }

  if (step.kind === 'shared-dev-db') {
    // Idempotent: the row already there means the prerequisite is present.
    const existing = await sharedDevDb(project.id, machine.docker_ctx);
    if (existing) {
      return { status: 'already-present',
               detail: `shared dev db '${existing.name}' already present on '${machine.docker_ctx}'`,
               stderr: null };
    }
    try {
      const r = await provisionDb(project.id, machine.id);
      return { status: 'started',
               detail: `dev db provisioning started on ${machine.key}: ${r?.name || 'db'} (${r?.image || 'image'}) — the db chip appears when it finishes`,
               stderr: null };
    } catch (e) {
      // The provision lock ("already running") means a provision IS in flight — idempotent, not a failure.
      if (/already running/i.test(e.message || '')) {
        return { status: 'started',
                 detail: `a dev db provision for ${project.name} on ${machine.key} is already running — no duplicate started`,
                 stderr: null };
      }
      return { status: 'failed', detail: e.message, stderr: null };
    }
  }

  return { status: 'cannot', detail: `no performer for step kind '${step.kind}'`, stderr: null };
}

function overallStatus(results) {
  if (!results.length) return 'already-present';
  if (results.some((s) => s.status === 'failed')) return 'failed';
  if (results.some((s) => s.status === 'created' || s.status === 'started')) return 'performed';
  if (results.some((s) => s.status === 'cannot')) return 'cannot';
  return 'already-present';
}

async function record(projectId, machineId, actor, dryRun, status, reason, steps) {
  return one(
    `INSERT INTO build_bootstrap_action (project_id, machine_id, actor, dry_run, status, reason, steps)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) RETURNING id`,
    [projectId, machineId, actor, dryRun, status, reason, JSON.stringify(steps)]);
}

async function loadProjectWithCoupling(projectId) {
  const project = await one(`SELECT * FROM project WHERE id=$1`, [projectId]);
  if (!project) throw new Error('project not found');
  // Same coupling attach buildReadinessForProject does — the probe reads project.db_coupling to
  // decide whether a shared dev db is expected at all.
  const pc = await one(`SELECT default_db_coupling FROM pool_config WHERE project_id=$1`, [projectId]);
  if (pc?.default_db_coupling) project.db_coupling = pc.default_db_coupling;
  return project;
}

// THE ENTRY: dryRun returns the plan and performs nothing; otherwise performs each step, re-runs
// the probe, and records the whole action. Never throws for a verdict outcome (a missing
// machine/project row still throws — the row is gone).
export async function performBuildBootstrap(projectId, machineId,
  { dryRun = false, docker = dockerAdapter, provisionDb = provisionDevDb, actor = 'human@console' } = {}) {
  const project = await loadProjectWithCoupling(projectId);
  const machine = await one(`SELECT * FROM machine WHERE id=$1`, [machineId]);
  if (!machine) throw new Error('machine not found');

  // THE DEV-ONLY GUARD — the name-overlap refusal fires before any plan is built or performed.
  // (Host-level prod is a disclosure in the plan, not a refusal: see hostProdDisclosure.)
  try {
    guardDevOnly(machine, project);
  } catch (e) {
    const row = await record(projectId, machineId, actor, dryRun, 'refused', e.message, []);
    logline('machine', `bootstrap REFUSED on ${machine.key} for ${project.name} by ${actor}: ${e.message}`);
    return { status: 'refused', reason: e.message, steps: [], probe: null, action_id: row.id };
  }

  const { probe, steps, refused, disclosure } = await planBuildBootstrap(machine, project, { docker });
  if (refused) {
    const row = await record(projectId, machineId, actor, dryRun, 'refused', refused, []);
    logline('machine', `bootstrap REFUSED on ${machine.key} for ${project.name} by ${actor}: ${refused}`);
    return { status: 'refused', reason: refused, steps: [], probe, action_id: row.id };
  }

  if (dryRun) {
    const row = await record(projectId, machineId, actor, true, 'planned', null, steps);
    return { status: 'planned', plan: steps, probe, action_id: row.id, disclosure };
  }

  const results = [];
  for (const step of steps) {
    // A disclosure is information for the human, not a step to perform — keep it in the results
    // so the audit records it, but never hand it to the performer.
    if (step.kind === 'disclosure' || step.status === 'cannot') { results.push(step); continue; }
    results.push({ ...step, ...(await performStep(step, machine, project, { docker, provisionDb })) });
  }

  // Re-run the probe so the returned verdict is what is now TRUE, not what the action hoped.
  const freshProbe = await probeBuildReadiness(machine, project, { docker });
  const status = overallStatus(results);
  const row = await record(projectId, machineId, actor, false, status, null, results);
  logline('machine', `bootstrap ${status} on ${machine.key} for ${project.name} by ${actor}: `
    + results.map((s) => `${s.kind}:${s.target}=${s.status}`).join(', '));
  broadcast('machine', { id: machineId });
  return { status, results, probe: freshProbe, action_id: row.id, disclosure };
}
