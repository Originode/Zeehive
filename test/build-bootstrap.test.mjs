// MACHINE × PROJECT BUILD BOOTSTRAP (ticket #173 follow-on) — "make this machine buildable", one
// console click, QUEENZEE-performed. The build-readiness probe NAMES what is missing on a
// (machine, project) pair; this test drives the ACTION that creates those DEV prerequisites —
// lib/build-bootstrap.js planBuildBootstrap + performBuildBootstrap — with a STUBBED docker adapter
// (the same injection build-readiness.test.mjs uses), so the plan/performer logic runs without a
// docker daemon.
//
// Covered here (against a real postgres — DATABASE_URL — for the meta-DB facts; the docker half
// is the stub):
//   • a failing probe (missing declared network + missing shared dev db) → an ORDERED PLAN with
//     a performable network step and a shared-dev-db step
//   • a missing external VOLUME → reported 'cannot' with the DATA reason, never created
//   • a missing registry for a can_build=false machine → reported 'cannot', naming what to set
//   • a compose file that does not resolve → reported 'cannot', naming the file
//   • a dry run returns the plan and performs NOTHING (no docker create, no provision call)
//   • performing creates the missing network, re-runs the probe, and the fresh verdict flips
//   • IDEMPOTENCE: a second perform says already-present and creates nothing
//   • a docker failure surfaces its REAL stderr (not the last line)
//   • the precise PROD GUARD refuses, in code, a network/volume the PROD tier ALSO declares —
//     recorded as a 'refused' action (reads the manifest, not a name convention)
//   • a machine whose context ALSO hosts this project's prod stack → DISCLOSED (plan carries a
//     disclosure step the human confirms), NOT refused — single-host topology stays usable
//   • a network that appears BETWEEN the inspect and the create → already-present, not failed
//   • an unreachable context refuses the WHOLE action (never half-runs)
//   • a CANNOT-only action is RECORDED with its step (the declined action is as readable as one that acted)
//   • the REAL dockerAdapter times out bounded against a hanging child (no spawnSync on the loop)
//   • every action is RECORDED (build_bootstrap_action: who asked, dry_run, steps, result)
process.env.PROVISION_MODE = 'simulate';   // before any import: no machine may be touched
process.env.SPINOFF_REGISTRY = '';
import { randomUUID } from 'node:crypto';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

const { q, one, pool } = await import('../server/src/db/pool.js');
const { config } = await import('../server/src/config.js');
const { planBuildBootstrap, performBuildBootstrap, guardDevOnly } = await import('../server/src/lib/build-bootstrap.js');
const { probeBuildReadiness, dockerAdapter } = await import('../server/src/lib/build-readiness.js');

// ── the stubbed docker adapter ──────────────────────────────────────────────
// Same dispatch shape as build-readiness.test.mjs, PLUS `create` verbs for `docker network create`
// and `docker volume create` (the create:empty opt-in) and a recorder so a test can assert nothing
// was created during a dry run. `networks`/`volumes` are the live sets — a created object lands in
// them, so a SECOND perform sees it already-present (idempotence).
const makeDocker = ({ reachable = true, networks = new Set(), volumes = new Set(), composeOk = true,
                      createNetworks = new Set(), failNetworkCreate = null, failNetworkInspect = null,
                      runningContainers = new Set(), failCompose = null,
                      createVolumes = new Set(), failVolumeCreate = null } = {}) => {
  const calls = [];
  const envCalls = [];
  const stub = async (ctx, args, opts) => {
    calls.push(args.join(' '));
    if (opts?.env) envCalls.push({ args: args.join(' '), env: opts.env });
    const [cmd] = args;
    if (cmd === 'info') {
      if (!reachable) return { unknown: true, reason: `connection refused (stub) to ${ctx}` };
      return { status: 0, stdout: '28.0.0\n', stderr: '' };
    }
    if (cmd === 'compose') {
      if (failCompose) return { status: 1, stdout: '', stderr: failCompose };
      return composeOk
        ? { status: 0, stdout: '', stderr: '' }
        : { status: 1, stdout: '', stderr: 'error: service "server" refers to undefined network' };
    }
    if (cmd === 'network') {
      const sub = args[1];   // inspect | create
      const name = args[2];
      if (sub === 'inspect') {
        if (failNetworkInspect) return { status: 1, stdout: '', stderr: failNetworkInspect };
        return networks.has(name)
          ? { status: 0, stdout: `${name}\n`, stderr: '' }
          : { status: 1, stdout: '', stderr: `network ${name} not found` };
      }
      if (sub === 'create') {
        if (failNetworkCreate) return { status: 1, stdout: '', stderr: failNetworkCreate };
        if (networks.has(name)) return { status: 1, stdout: '', stderr: `network with name ${name} already exists` };
        networks.add(name); createNetworks.add(name);
        return { status: 0, stdout: name, stderr: '' };
      }
    }
    if (cmd === 'volume') {
      const sub = args[1];   // inspect | create
      const name = args[2];
      if (sub === 'create') {
        if (failVolumeCreate) return { status: 1, stdout: '', stderr: failVolumeCreate };
        if (volumes.has(name)) return { status: 1, stdout: '', stderr: `volume with name ${name} already exists` };
        volumes.add(name); createVolumes.add(name);
        return { status: 0, stdout: name, stderr: '' };
      }
      return volumes.has(name)
        ? { status: 0, stdout: `${name}\n`, stderr: '' }
        : { status: 1, stdout: '', stderr: `volume ${name} not found` };
    }
    // `docker inspect <name> --format {{.State.Status}}` — the mesh-control-plane step's liveness
    // read. A name in runningContainers answers 'running'; anything else answers empty (not running).
    if (cmd === 'inspect') {
      const name = args[1];
      return runningContainers.has(name)
        ? { status: 0, stdout: 'running\n', stderr: '' }
        : { status: 0, stdout: '', stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  stub.calls = calls;
  stub.envCalls = envCalls;
  return stub;
};

// A provisionDevDb stub that records calls and simulates the background row appearing.
const makeProvision = ({ fail = null, throwAlreadyRunning = false } = {}) => {
  const calls = [];
  const stub = async (projectId, machineId) => {
    calls.push(`${projectId}::${machineId}`);
    if (throwAlreadyRunning) throw new Error(`a dev db provision for X on Y is already running`);
    if (fail) throw new Error(fail);
    // Simulate what the real provision does in simulate mode: insert the shared dev db row ON the
    // machine's docker context (the real provision stamps container.docker_ctx = the machine's).
    const mm = await one(`SELECT docker_ctx FROM machine WHERE id=$1`, [machineId]);
    await q(
      `INSERT INTO container (project_id, role, tier, isolation, name, docker_ctx, health)
       VALUES ($1,'db','dev','shared',$2,$3,'down')
       ON CONFLICT (project_id, name) DO NOTHING`,
      [projectId, `bs_${tag}_sdb`, mm?.docker_ctx]);
    return { status: 'provisioning', name: `bs_${tag}_sdb`, image: 'postgres:17', machine: 'x' };
  };
  stub.calls = calls;
  return stub;
};

// ── fixtures ─────────────────────────────────────────────────────────────────
const tag = randomUUID().slice(0, 8).replace(/[^a-z0-9]/g, '');
const createdMachines = [], createdProjects = [], tmpDirs = [];
// Machines this suite writes a mesh_config row for (the queenzee-host machine may pre-exist, so it
// is not in createdMachines — the row must be dropped by hand).
const meshConfigMachines = [];
// The control-plane section mutates process-wide config; remember the originals to restore in finally.
let savedSecrets = null;
// Every fixture project shares one repo root that ACTUALLY has a compose file — so compose-resolves
// passes and the plans stay about the prerequisites under test (a missing compose is a 'cannot'
// that would otherwise pollute every plan).
const fs = await import('node:fs');
const os = await import('node:os');
const path = await import('node:path');
const { fileURLToPath } = await import('node:url');
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), `bs-${tag}-`));
fs.writeFileSync(path.join(repoDir, 'docker-compose.spinoff.yml'),
  'services:\n  server:\n    image: example:latest\n  webapp:\n    image: example:latest\n');

const insProject = async (name, manifest, registry = null) => {
  const p = (await one(
    `INSERT INTO project (name, repo_root, main_branch, db_user, db_name, manifest, registry)
       VALUES ($1,$2,'main','postgres','postgres',$3,$4) RETURNING id`,
    [name, repoDir, JSON.stringify(manifest), registry])).id;
  createdProjects.push(p);
  return p;
};
const insMachine = async (key, ctx, canBuild = true) => {
  const m = (await one(
    `INSERT INTO machine (key, docker_ctx, can_build, enabled) VALUES ($1,$2,$3,true) RETURNING id`,
    [key, ctx, canBuild])).id;
  createdMachines.push(m);
  return m;
};
const insDevDb = async (projectId, ctx, name) => {
  await q(
    `INSERT INTO container (project_id, role, tier, isolation, name, docker_ctx, health)
       VALUES ($1,'db','dev','shared',$2,$3,'up')`,
    [projectId, name, ctx]);
};
const insProdSite = async (projectId, ctx) => {
  await q(
    `INSERT INTO deploy_site (project_id, key, tier, docker_ctx) VALUES ($1,$2,'prod',$3)`,
    [projectId, `bs-prod-${tag}`, ctx]);
};
const row = async (table, id) => one(`SELECT * FROM ${table} WHERE id=$1`, [id]);

try {
  // ── plan from a genuinely failing probe ────────────────────────────────────
  console.log('\n── a failing probe (missing network + missing shared dev db) → an ordered plan ──');
  const p1 = await insProject(`bs-net-${tag}`, { tiers: { spinoff: { requires: { networks: ['bs_net'] } } } });
  const m1 = await insMachine(`bs-net-${tag}`, `zt-bs-net-${tag}`, true);
  // NOTE: deliberately NO shared dev db for p1 — the missing shared dev db is what the plan must name.
  const docker1 = makeDocker({ networks: new Set() });
  const plan1 = await planBuildBootstrap(await row('machine', m1), await row('project', p1), { docker: docker1 });
  ok(plan1.steps.some((s) => s.kind === 'network' && s.target === 'bs_net' && s.status === 'planned'),
     `missing declared network → performable network step [${plan1.steps.map((s) => s.kind + ':' + s.target).join(', ')}]`);
  ok(plan1.steps.some((s) => s.kind === 'shared-dev-db' && s.status === 'planned'),
     `missing shared dev db → shared-dev-db step [${plan1.steps.map((s) => s.kind).join(', ')}]`);
  const netStep = plan1.steps.find((s) => s.kind === 'network');
  ok(/docker network create/.test(netStep?.action || ''), `the network step names its action [${netStep?.action}]`);

  // ── volume → cannot, never created ─────────────────────────────────────────
  console.log('\n── a missing external VOLUME → cannot, with the DATA reason ──');
  const p2 = await insProject(`bs-vol-${tag}`, { tiers: { spinoff: { requires: { networks: ['bs_net2'], volumes: ['bs_data'] } } } });
  const m2 = await insMachine(`bs-vol-${tag}`, `zt-bs-vol-${tag}`, true);
  await insDevDb(p2, `zt-bs-vol-${tag}`, `bs_${tag}_vol_db`);
  const docker2 = makeDocker({ networks: new Set() });
  const plan2 = await planBuildBootstrap(await row('machine', m2), await row('project', p2), { docker: docker2 });
  const volStep = plan2.steps.find((s) => s.target.includes('bs_data'));
  ok(volStep?.status === 'cannot', `missing volume reported 'cannot' [${volStep?.status}]`);
  ok(/DATA/.test(volStep?.detail || ''), `the cannot reason says volumes are DATA [${volStep?.detail}]`);

  // ── a volume the manifest marks create:'empty' IS performable (decision record, item 3) ──────
  console.log('\n── a create:empty volume is planned and created; a plain one still never is ──');
  const pEmpty = await insProject(`bs-empty-${tag}`,
    { tiers: { spinoff: { requires: { volumes: [{ name: 'bs_empty_data', create: 'empty' }] } } } });
  const mEmpty = await insMachine(`bs-empty-${tag}`, `zt-bs-empty-${tag}`, true);
  await insDevDb(pEmpty, `zt-bs-empty-${tag}`, `bs_${tag}_empty_db`);
  const emptyVols = new Set();
  const dockerEmpty = makeDocker({ networks: new Set(), volumes: emptyVols });
  const planEmpty = await planBuildBootstrap(await row('machine', mEmpty), await row('project', pEmpty), { docker: dockerEmpty });
  const eStep = planEmpty.steps.find((s) => s.target === 'bs_empty_data');
  ok(eStep?.status === 'planned' && eStep?.kind === 'volume',
     `the create:empty opt-in → a performable volume step [${eStep?.kind}:${eStep?.status}]`);
  ok(/docker volume create/.test(eStep?.action || ''), `the volume step names its action [${eStep?.action}]`);
  const perfEmpty = await performBuildBootstrap(pEmpty, mEmpty,
    { dryRun: false, docker: dockerEmpty, provisionDb: makeProvision(), actor: 'tester@xell' });
  ok(perfEmpty.status === 'performed', `performing the create:empty plan succeeds [${perfEmpty.status}]`);
  ok(emptyVols.has('bs_empty_data'), 'the volume was actually created');
  const perfEmpty2 = await performBuildBootstrap(pEmpty, mEmpty,
    { dryRun: false, docker: dockerEmpty, provisionDb: makeProvision(), actor: 'tester@xell' });
  ok(perfEmpty2.status === 'already-present', `a second perform is idempotent [${perfEmpty2.status}]`);
  ok(!perfEmpty2.results.some((s) => s.status === 'created'), 'the second perform created nothing');

  // A plain volume alongside the opt-in one stays DATA: the classification is per-category, not per-plan.
  const pMixed = await insProject(`bs-mixed-${tag}`,
    { tiers: { spinoff: { requires: { volumes: [{ name: 'bs_mixed_empty', create: 'empty' }, 'bs_mixed_plain'] } } } });
  const mMixed = await insMachine(`bs-mixed-${tag}`, `zt-bs-mixed-${tag}`, true);
  await insDevDb(pMixed, `zt-bs-mixed-${tag}`, `bs_${tag}_mixed_db`);
  const planMixed = await planBuildBootstrap(await row('machine', mMixed), await row('project', pMixed), { docker: makeDocker({ networks: new Set() }) });
  ok(planMixed.steps.find((s) => s.target === 'bs_mixed_empty')?.status === 'planned', 'the opt-in volume is planned');
  ok(planMixed.steps.find((s) => s.target.includes('bs_mixed_plain'))?.status === 'cannot', 'the plain volume is still cannot');

  // A volume that appears BETWEEN the inspect and the create (a concurrent create) is NOT a failure.
  const pVolRace = await insProject(`bs-vrace-${tag}`,
    { tiers: { spinoff: { requires: { volumes: [{ name: 'bs_vrace_data', create: 'empty' }] } } } });
  const mVolRace = await insMachine(`bs-vrace-${tag}`, `zt-bs-vrace-${tag}`, true);
  await insDevDb(pVolRace, `zt-bs-vrace-${tag}`, `bs_${tag}_vrace_db`);
  const raceDocker = makeDocker({ networks: new Set(), failVolumeCreate: 'volume with name bs_vrace_data already exists' });
  const perfVolRace = await performBuildBootstrap(pVolRace, mVolRace,
    { dryRun: false, docker: raceDocker, provisionDb: makeProvision(), actor: 'tester@xell' });
  ok(perfVolRace.status === 'already-present', `a volume created between inspect and create reads already-present [${perfVolRace.status}]`);

  // ── performing an all-cannot plan is RECORDED too (the declined action must be as
  //    readable afterwards as one that acted — the manager's review rule) ──────
  console.log('\n── a CANNOT action is RECORDED with its step (not just the happy path) ──');
  const pCannot = await insProject(`bs-cannot-${tag}`, { tiers: { spinoff: { requires: { volumes: ['bs_cannot_data'] } } } });
  const mCannot = await insMachine(`bs-cannot-${tag}`, `zt-bs-cannot-${tag}`, true);
  await insDevDb(pCannot, `zt-bs-cannot-${tag}`, `bs_${tag}_cannot_db`);
  const perfCannot = await performBuildBootstrap(pCannot, mCannot, { dryRun: false, docker: makeDocker({ networks: new Set() }), provisionDb: makeProvision(), actor: 'tester@xell' });
  ok(perfCannot.status === 'cannot', `a plan of only cannot steps → overall 'cannot' [${perfCannot.status}]`);
  const cannotRow = await one(`SELECT * FROM build_bootstrap_action WHERE id=$1`, [perfCannot.action_id]);
  ok(cannotRow?.status === 'cannot' && cannotRow?.steps?.length === 1 && cannotRow.steps[0].status === 'cannot',
     `the CANNOT action is RECORDED with its step [status=${cannotRow?.status}, steps=${cannotRow?.steps?.length}]`);

  // ── registry-for-handoff → cannot, naming what to set ──────────────────────
  console.log('\n── can_build=false + no registry → cannot, naming what to set ──');
  const p3 = await insProject(`bs-reg-${tag}`, {});
  const m3 = await insMachine(`bs-reg-${tag}`, `zt-bs-nobuild-${tag}`, false);
  await insDevDb(p3, `zt-bs-nobuild-${tag}`, `bs_${tag}_reg_db`);
  const docker3 = makeDocker({ networks: new Set() });
  const plan3 = await planBuildBootstrap(await row('machine', m3), await row('project', p3), { docker: docker3 });
  const regStep = plan3.steps.find((s) => s.kind === 'cannot' && /registry|build machine/.test(s.target));
  ok(!!regStep, `registry-for-handoff emitted a cannot step [${plan3.steps.map((s) => s.target).join(', ')}]`);
  ok(/SPINOFF_REGISTRY/.test(regStep?.detail || ''), `the cannot reason names what to set [${regStep?.detail}]`);

  // ── compose failure → cannot, naming the file ──────────────────────────────
  console.log('\n── a compose file that does not resolve → cannot, naming the file ──');
  const p4 = await insProject(`bs-comp-${tag}`, { tiers: { spinoff: { compose: 'docker-compose.missing.yml' } } });
  const m4 = await insMachine(`bs-comp-${tag}`, `zt-bs-comp-${tag}`, true);
  await insDevDb(p4, `zt-bs-comp-${tag}`, `bs_${tag}_comp_db`);
  const docker4 = makeDocker({ networks: new Set(), composeOk: false });
  const plan4 = await planBuildBootstrap(await row('machine', m4), await row('project', p4), { docker: docker4 });
  const compStep = plan4.steps.find((s) => /compose/.test(s.target));
  ok(compStep?.status === 'cannot', `compose failure reported 'cannot' [${compStep?.status}]`);
  ok(/docker-compose.missing.yml/.test(compStep?.detail || ''), `the cannot reason names the file [${compStep?.detail}]`);

  // ── dry run performs nothing ───────────────────────────────────────────────
  console.log('\n── a dry run returns the plan and performs NOTHING ──');
  const p5 = await insProject(`bs-dry-${tag}`, { tiers: { spinoff: { requires: { networks: ['bs_dry_net'] } } } });
  const m5 = await insMachine(`bs-dry-${tag}`, `zt-bs-dry-${tag}`, true);
  const docker5 = makeDocker({ networks: new Set() });
  const dry = await performBuildBootstrap(p5, m5, { dryRun: true, docker: docker5, provisionDb: makeProvision() });
  ok(dry.status === 'planned', `dry run returns status 'planned' [${dry.status}]`);
  ok(dry.plan.some((s) => s.kind === 'network'), 'the plan carries the network step');
  ok(!docker5.calls.some((c) => c.includes('network create')), `no network create ran [${docker5.calls.join(' | ')}]`);
  const dryRow = await one(`SELECT * FROM build_bootstrap_action WHERE id=$1`, [dry.action_id]);
  ok(dryRow?.dry_run === true && dryRow?.status === 'planned', `the dry run is RECORDED (dry_run=true, planned)`);

  // ── perform creates + fresh verdict ────────────────────────────────────────
  console.log('\n── performing creates the missing network and the fresh probe flips ──');
  const docker6 = makeDocker({ networks: new Set() });
  const provision6 = makeProvision();
  const perf = await performBuildBootstrap(p5, m5, { dryRun: false, docker: docker6, provisionDb: provision6, actor: 'tester@xell' });
  const netResult = perf.results.find((s) => s.kind === 'network');
  ok(netResult?.status === 'created', `network step reports created [${netResult?.status}]`);
  ok(docker6.calls.some((c) => c.includes('network create bs_dry_net')), 'docker network create actually ran');
  ok(perf.probe?.status === 'ok' || perf.results.some((s) => s.kind === 'shared-dev-db'),
     `probe re-ran after performing [status=${perf.probe?.status}, results=${perf.results.map((s) => s.kind + '=' + s.status).join(',')}]`);
  const actionRow = await one(`SELECT * FROM build_bootstrap_action WHERE id=$1`, [perf.action_id]);
  ok(actionRow?.actor === 'tester@xell' && actionRow?.dry_run === false, `the perform is RECORDED with the actor [${actionRow?.actor}]`);
  ok(actionRow?.steps?.length >= 1, `the recorded row carries the per-step results [${JSON.stringify(actionRow?.steps)?.slice(0, 80)}…]`);

  // ── idempotence ────────────────────────────────────────────────────────────
  console.log('\n── a second perform says already-present and creates nothing ──');
  // The network now exists (run 1 created it) and the provision inserted the dev-db row — the
  // plan rebuilds, so the SECOND run has nothing left to create. The shared-dev-db step re-checks
  // and reports already-present; no network create is issued.
  const docker7 = makeDocker({ networks: new Set(['bs_dry_net']) });   // the network now exists
  const before = docker7.calls.length;
  const perf2 = await performBuildBootstrap(p5, m5, { dryRun: false, docker: docker7, provisionDb: makeProvision() });
  ok(!docker7.calls.slice(before).some((c) => c.includes('network create')), 'second run creates NO network');
  ok(perf2.status === 'already-present', `second run overall status already-present [${perf2.status}, results=${perf2.results.map((s) => s.kind + '=' + s.status).join(',')}]`);

  // ── a docker failure surfaces its real stderr ──────────────────────────────
  console.log('\n── a docker failure surfaces its REAL stderr ──');
  const p8 = await insProject(`bs-fail-${tag}`, { tiers: { spinoff: { requires: { networks: ['bs_fail_net'] } } } });
  const m8 = await insMachine(`bs-fail-${tag}`, `zt-bs-fail-${tag}`, true);
  await insDevDb(p8, `zt-bs-fail-${tag}`, `bs_${tag}_fail_db`);
  const docker8 = makeDocker({ networks: new Set(), failNetworkCreate: 'Error response from daemon: pool overlaps with other one on this address space' });
  const perf8 = await performBuildBootstrap(p8, m8, { dryRun: false, docker: docker8, provisionDb: makeProvision() });
  const failRes = perf8.results.find((s) => s.kind === 'network');
  ok(failRes?.status === 'failed', `network step reports failed [${failRes?.status}]`);
  ok(/pool overlaps/.test(failRes?.stderr || ''), `the REAL stderr is on the step, not the last line [${failRes?.stderr}]`);
  ok(perf8.status === 'failed', `overall status is failed [${perf8.status}]`);

  // ── the precise prod guard: a network/volume the PROD tier also declares → refuse ──
  console.log('\n── a network the PROD tier also declares → the guard REFUSES (reads the manifest) ──');
  const pOver = await insProject(`bs-over-${tag}`, {
    tiers: {
      prod: { requires: { networks: ['bs_overlap_net'] } },
      spinoff: { requires: { networks: ['bs_overlap_net'] } },
    },
  });
  const mOver = await insMachine(`bs-over-${tag}`, `zt-bs-over-${tag}`, true);
  let overlapThrew = null;
  try { guardDevOnly(await row('machine', mOver), await row('project', pOver)); } catch (e) { overlapThrew = e; }
  ok(!!overlapThrew && /also declared by the PROD tier/.test(overlapThrew?.message || ''),
     `guardDevOnly refuses a name the prod tier also declares [${overlapThrew?.message?.slice(0, 90)}…]`);
  const perfOver = await performBuildBootstrap(pOver, mOver, { dryRun: false, docker: makeDocker(), provisionDb: makeProvision() });
  ok(perfOver.status === 'refused', `the overlap perform is REFUSED end-to-end [${perfOver.status}]`);
  const overRow = await one(`SELECT * FROM build_bootstrap_action WHERE id=$1`, [perfOver.action_id]);
  ok(overRow?.status === 'refused' && /PROD tier/.test(overRow?.reason || ''), `the overlap refusal is RECORDED [${overRow?.status}]`);

  // ── host-level prod is a DISCLOSURE, not a refusal (single-host topology) ───
  console.log('\n── a machine that also hosts this project\'s PROD stack → DISCLOSED, not refused ──');
  const pDisc = await insProject(`bs-disc-${tag}`, { tiers: { spinoff: { requires: { networks: ['bs_disc_net'] } } } });
  const mDisc = await insMachine(`bs-disc-${tag}`, `zt-bs-disc-${tag}`, true);
  await insProdSite(pDisc, `zt-bs-disc-${tag}`);
  const dockerDisc = makeDocker({ networks: new Set() });
  const planDisc = await planBuildBootstrap(await row('machine', mDisc), await row('project', pDisc), { docker: dockerDisc });
  ok(planDisc.steps.some((s) => s.kind === 'disclosure'),
     `the plan carries a DISCLOSURE step [${planDisc.steps.map((s) => s.kind).join(', ')}]`);
  ok(/also runs this project's PROD/.test(planDisc.disclosure || ''),
     `the disclosure names the prod host [${planDisc.disclosure?.slice(0, 100)}…]`);
  const perfDisc = await performBuildBootstrap(pDisc, mDisc, { dryRun: false, docker: dockerDisc, provisionDb: makeProvision() });
  ok(perfDisc.status !== 'refused', `the perform PROCEEDS with the disclosure [${perfDisc.status}]`);
  ok(perfDisc.results.some((s) => s.kind === 'disclosure'), 'the disclosure is in the performed results');
  ok(perfDisc.results.some((s) => s.kind === 'network' && s.status === 'created'),
     `a DEV network IS creatable on a host carrying prod rows [${perfDisc.results.map((s) => s.kind + '=' + s.status).join(',')}]`);
  const discRow = await one(`SELECT * FROM build_bootstrap_action WHERE id=$1`, [perfDisc.action_id]);
  ok(discRow?.steps?.some((s) => s.kind === 'disclosure'), 'the disclosure is RECORDED in the audit steps');

  // ── a network that appears BETWEEN the inspect and the create → already-present ──
  console.log('\n── a network that appears between inspect and create → already-present, not failed ──');
  const pRace = await insProject(`bs-race-${tag}`, { tiers: { spinoff: { requires: { networks: ['bs_race_net'] } } } });
  const mRace = await insMachine(`bs-race-${tag}`, `zt-bs-race-${tag}`, true);
  await insDevDb(pRace, `zt-bs-race-${tag}`, `bs_${tag}_race_db`);
  const dockerRace = makeDocker({ networks: new Set(), failNetworkCreate: 'Error response from daemon: network with name bs_race_net already exists' });
  const perfRace = await performBuildBootstrap(pRace, mRace, { dryRun: false, docker: dockerRace, provisionDb: makeProvision() });
  const raceRes = perfRace.results.find((s) => s.kind === 'network');
  ok(raceRes?.status === 'already-present',
     `docker's 'already exists' on create is already-present, not failed [${raceRes?.status}]`);
  ok(perfRace.status === 'already-present', `overall status is already-present [${perfRace.status}]`);

  // ── unreachable context refuses the whole action ───────────────────────────
  console.log('\n── an unreachable context REFUSES the whole action ──');
  const p10 = await insProject(`bs-unk-${tag}`, { tiers: { spinoff: { requires: { networks: ['bs_unk_net'] } } } });
  const m10 = await insMachine(`bs-unk-${tag}`, `zt-bs-unk-${tag}`, true);
  const docker10 = makeDocker({ reachable: false });
  const perf10 = await performBuildBootstrap(p10, m10, { dryRun: false, docker: docker10, provisionDb: makeProvision() });
  ok(perf10.status === 'refused', `unreachable context → refused [${perf10.status}]`);
  ok(/not reachable|reachable/.test(perf10.reason || ''), `the refusal names the unreachable context [${perf10.reason?.slice(0, 80)}…]`);
  ok(!docker10.calls.some((c) => c.includes('network create')), `nothing was created against an unreachable daemon`);

  // ── the REAL dockerAdapter's timeout path, through the action ───────────────
  // Manager's rule: every docker call goes through the probe's bounded ASYNC adapter — no
  // spawnSync on the queenzee's event loop. Prove it with a REAL subprocess: a wrapper that hangs
  // for 5s is SIGKILLed by the adapter at 250ms, the action refuses the whole thing (a daemon it
  // cannot reach), and the whole perform returns bounded — while a heartbeat keeps ticking, which a
  // spawnSync-style blocking call would freeze for the full 5s.
  console.log('\n── the REAL dockerAdapter times out bounded against a hanging child (no spawnSync) ──');
  // A static hang, whatever the real docker subcommand the probe sends: the adapter must SIGKILL
  // it at the bound, never let a docker call run past its ceiling on the queenzee's loop.
  const hangWrap = path.join(repoDir, 'hangwrap.cjs');
  fs.writeFileSync(hangWrap, "#!/usr/bin/env node\nsetTimeout(() => {}, 5000);\n");
  fs.chmodSync(hangWrap, 0o755);
  const realDocker = (ctx, args) => dockerAdapter(ctx, args, { timeout: 250, bin: hangWrap });
  const pReal = await insProject(`bs-real-${tag}`, { tiers: { spinoff: { requires: { networks: ['bs_real_net'] } } } });
  const mReal = await insMachine(`bs-real-${tag}`, `zt-bs-real-${tag}`, true);
  let heartbeats = 0;
  const hb = setInterval(() => heartbeats++, 30);
  const t0 = Date.now();
  const perfReal = await performBuildBootstrap(pReal, mReal, { dryRun: false, docker: realDocker, provisionDb: makeProvision() });
  clearInterval(hb);
  const elapsed = Date.now() - t0;
  ok(perfReal.status === 'refused', `a hanging daemon → whole action refused [${perfReal.status}]`);
  ok(/did not answer within 250ms/.test(perfReal.reason || ''), `the refusal names the bounded timeout [${perfReal.reason?.slice(0, 100)}…]`);
  ok(elapsed < 1500 && heartbeats >= 3,
     `bounded: ${elapsed}ms with ${heartbeats} heartbeats while in flight — a spawnSync adapter would freeze the loop for the whole 5s hang`);

  // ── db-isolated project: the probe skips shared-dev-db, so the plan has no sdb step ──
  console.log('\n── a db-isolated project has NO shared-dev-db step (the probe already skips it) ──');
  const p11 = await insProject(`bs-iso-${tag}`, { tiers: { spinoff: { requires: { networks: ['bs_iso_net'] } } } });
  await q(`INSERT INTO pool_config (project_id, default_db_coupling) VALUES ($1,'db-isolated')`, [p11]);
  const m11 = await insMachine(`bs-iso-${tag}`, `zt-bs-iso-${tag}`, true);
  const docker11 = makeDocker({ networks: new Set() });
  const plan11 = await planBuildBootstrap(await row('machine', m11), await row('project', p11), { docker: docker11 });
  ok(!plan11.steps.some((s) => s.kind === 'shared-dev-db'),
     `no shared-dev-db step for a db-isolated project [${plan11.steps.map((s) => s.kind).join(', ') || 'none'}]`);

  // ── MESH MACHINE PEER via the bootstrap CARD (§3.2 phase 2) ─────────────────
  // A fully-build-ready machine's plan stays EMPTY while the mesh is unset (the standing
  // invariant); with the mesh configured and no active kind='machine' peer, the plan names the
  // peer step and the perform mints the intent row + one-time setup key (which rides the result,
  // never the row).
  console.log('\n── the bootstrap CARD mints a machine mesh peer when the mesh is on (§3.2) ──');
  const meshMeshApi = ({ failKeys = false } = {}) => {
    const state = { groups: [], keys: [], calls: [] };
    const request = async (method, path, body) => {
      state.calls.push(`${method} ${path}`);
      if (method === 'GET' && path === '/api/groups') return { status: 200, json: state.groups };
      if (method === 'POST' && path === '/api/groups') {
        const g = { id: `g-${state.groups.length + 1}`, name: body.name };
        state.groups.push(g);
        return { status: 200, json: g };
      }
      if (method === 'POST' && path === '/api/setup-keys') {
        if (failKeys) return { status: 500, json: { message: 'control plane refuses (stub)' } };
        const k = { id: `sk-${state.keys.length + 1}`, key: `KEY-${state.keys.length + 1}`, ...body };
        state.keys.push(k);
        return { status: 200, json: k };
      }
      return { status: 500, json: { message: `stub: unhandled ${method} ${path}` } };
    };
    return { request, state };
  };
  const meshOn = () => { config.netbirdApiUrl = 'http://mesh.invalid'; config.netbirdApiToken = 't'; };
  const meshOff = () => { config.netbirdApiUrl = null; config.netbirdApiToken = null; };
  meshOff();

  const pMesh = await insProject(`bs-mesh-${tag}`, {}, null);
  const mMesh = await insMachine(`bs-mesh-${tag}`, `zt-bs-mesh-${tag}`, true);
  await insDevDb(pMesh, `zt-bs-mesh-${tag}`, `bs_${tag}_mesh_db`);
  const greenDocker = makeDocker({ reachable: true, networks: new Set(), composeOk: true });

  const planOff = await planBuildBootstrap(await row('machine', mMesh), await row('project', pMesh), { docker: greenDocker });
  ok(planOff.probe.status === 'ok' && planOff.steps.length === 0,
     'a build-ready machine with the mesh UNSET plans nothing (the standing invariant)');

  meshOn();
  const planMesh = await planBuildBootstrap(await row('machine', mMesh), await row('project', pMesh), { docker: greenDocker });
  const meshStep = planMesh.steps.find((s) => s.kind === 'mesh-machine-peer');
  ok(planMesh.probe.status === 'ok' && !!meshStep && meshStep.target === `bs-mesh-${tag}`,
     'with the mesh ON the plan names the machine-peer step even when the build probe is green');

  const apiDry = meshMeshApi();
  const meshDry = await performBuildBootstrap(pMesh, mMesh, { dryRun: true, docker: greenDocker,
    provisionDb: makeProvision(), mesh: { request: apiDry.request } });
  ok(meshDry.status === 'planned' && !(await one(
    `SELECT id FROM mesh_peer WHERE machine_id=$1 AND kind='machine' AND removed_at IS NULL`, [mMesh])),
     'a DRY run shows the step and mints NOTHING');

  const apiGo = meshMeshApi();
  const meshPerf = await performBuildBootstrap(pMesh, mMesh, { dryRun: false, docker: greenDocker,
    provisionDb: makeProvision(), actor: 'tester@xell', mesh: { request: apiGo.request } });
  const perfMesh = meshPerf.results.find((s) => s.kind === 'mesh-machine-peer');
  ok(meshPerf.status === 'performed' && perfMesh?.status === 'created'
     && /KEY-1/.test(perfMesh?.detail || ''),
     `the perform mints the machine peer and returns the ONE-TIME key in the step result [${perfMesh?.status}]`);
  const mpRow = await one(`SELECT * FROM mesh_peer WHERE machine_id=$1 AND kind='machine'`, [mMesh]);
  ok(mpRow?.hostname === `bs-mesh-${tag}` && mpRow.status === 'minted' && mpRow.nb_setup_key_id === 'sk-1'
     && mpRow.machine_id === mMesh,
     'the kind=machine intent row exists (hostname = machine key, setup-key id for audit)');
  ok(!JSON.stringify(mpRow).includes('KEY-1'), 'the key itself is NEVER stored on the row');

  const meshPerf2 = await performBuildBootstrap(pMesh, mMesh, { dryRun: false, docker: greenDocker,
    provisionDb: makeProvision(), actor: 'tester@xell', mesh: { request: meshMeshApi().request } });
  const dupCount = await q(`SELECT id FROM mesh_peer WHERE machine_id=$1 AND kind='machine' AND removed_at IS NULL`, [mMesh]);
  ok(meshPerf2.status === 'already-present' && dupCount.length === 1,
     'a second perform is idempotent — no duplicate peer row');

  meshOn();
  const apiFail = meshMeshApi({ failKeys: true });
  const pMesh2 = await insProject(`bs-mesh2-${tag}`, {}, null);
  const mMesh2 = await insMachine(`bs-mesh2-${tag}`, `zt-bs-mesh2-${tag}`, true);
  await insDevDb(pMesh2, `zt-bs-mesh2-${tag}`, `bs_${tag}_mesh2_db`);
  const perfFail = await performBuildBootstrap(pMesh2, mMesh2, { dryRun: false, docker: greenDocker,
    provisionDb: makeProvision(), actor: 'tester@xell', mesh: { request: apiFail.request } });
  ok(perfFail.results.some((s) => s.kind === 'mesh-machine-peer' && s.status === 'failed')
     && !(await one(`SELECT id FROM mesh_peer WHERE machine_id=$1 AND kind='machine'`, [mMesh2])),
     'a mint failure degrades the mesh STEP to failed, never blocks the bootstrap, and leaves no row');
  meshOff();

  // ── MESH CONTROL PLANE via the bootstrap CARD (§3.1 / §11 NOT-done #1) ──────
  // Standing NetBird up stops being a raw human op: on the QUEENZEE's OWN context the card plans a
  // mesh-control-plane step; the perform writes netbird/management.json from the shipped example,
  // runs `compose --profile mesh up -d` for the three control-plane services ONLY, and health-checks
  // the management API. A secret is never invented, and the API token is named as a human's.
  console.log('\n── the bootstrap CARD stands up the NetBird control plane on the queenzee host (§3.1) ──');
  const { renderManagementJson, managementJsonMissingSecrets, ensureManagementJson, placeholderFill } =
    await import('../server/src/lib/build-bootstrap.js');
  // The control plane's container/service names live in lib/netbird.js — ONE authority the probe
  // (build-readiness.js) and this performer both read, so a button cannot check one container while
  // the step starts another.
  const { MESH_CONTROL_PLANE_CONTAINER, MESH_CONTROL_PLANE_SERVICES } =
    await import('../server/src/lib/netbird.js');
  const EXAMPLE = path.join(REPO, 'docker/zeehive/netbird/management.json.example');
  const exampleText = fs.readFileSync(EXAMPLE, 'utf8');
  ok(managementJsonMissingSecrets(JSON.parse(exampleText)).length === 2,
     'the shipped example names BOTH placeholder secrets (the stand-up refuses on them)');
  const substituted = JSON.parse(renderManagementJson(exampleText,
    { datastoreEncryptionKey: 'k'.repeat(32), signalUri: 'netbird-signal:80', relayAddress: 'relay://netbird-relay:33080' }));
  ok(substituted.DataStoreEncryptionKey === 'k'.repeat(32) && substituted.Signal.URI === 'netbird-signal:80'
     && substituted.Relay.Addresses[0] === 'relay://netbird-relay:33080',
     'renderManagementJson substitutes ONLY the configured values — it generates no key material');

  // The install dir: a compose file with no netbird/ beside it (the generator falls back to the
  // repo's shipped example, exactly as a bootstrap install does from a checkout).
  const cpDir = fs.mkdtempSync(path.join(os.tmpdir(), `bs-cp-${tag}-`));
  tmpDirs.push(cpDir);
  const composeFile = path.join(cpDir, 'docker-compose.bootstrap.yml');
  fs.writeFileSync(composeFile, 'name: zeehive\nservices:\n  netbird-management:\n    image: example\n');
  const genRefused = ensureManagementJson(composeFile);
  ok(genRefused.error && /NETBIRD_DATASTORE_ENCRYPTION_KEY/.test(genRefused.error)
     && /NETBIRD_RELAY_AUTH_SECRET/.test(genRefused.error),
     `placeholder secrets REFUSE the stand-up, naming both env vars [${genRefused.error?.slice(0, 80)}…]`);
  ok(!fs.existsSync(path.join(cpDir, 'netbird', 'management.json')),
     'a placeholder-secret management.json is never written (invent/store no secret)');

  savedSecrets = { k: config.netbirdDatastoreEncryptionKey, s: config.netbirdRelayAuthSecret, url: config.meshComposeFile };
  config.netbirdDatastoreEncryptionKey = 'a'.repeat(32);
  config.netbirdRelayAuthSecret = 'relay-secret-from-operator';
  const genOk = ensureManagementJson(composeFile);
  const mjPath = path.join(cpDir, 'netbird', 'management.json');
  const written = JSON.parse(fs.readFileSync(mjPath, 'utf8'));
  ok(!genOk.error && genOk.written === true, `with the operator's secrets set, management.json is written [${genOk.error || 'ok'}]`);
  ok(written.DataStoreEncryptionKey === 'a'.repeat(32) && written.Relay.Secret === 'relay-secret-from-operator',
     'the written config carries the OPERATOR secrets, never generated ones');
  fs.writeFileSync(mjPath, JSON.stringify({ ...written, Signal: { URI: 'operator-sig:80' } }));
  const regen = ensureManagementJson(composeFile);
  ok(!regen.written && !regen.error
     && JSON.parse(fs.readFileSync(mjPath, 'utf8')).Signal.URI === 'operator-sig:80',
     "an operator's own management.json is checked, never overwritten");
  const noExample = ensureManagementJson(path.join(cpDir, 'elsewhere', 'docker-compose.bootstrap.yml'), { repoRoot: cpDir });
  ok(noExample.error && /management\.json\.example/.test(noExample.error),
     `no template anywhere → a named cannot, never a crash [${noExample.error?.slice(0, 70)}…]`);

  config.meshComposeFile = composeFile;
  const pCp = await insProject(`bs-cp-${tag}`, {});
  let mCp = (await one(`SELECT id FROM machine WHERE docker_ctx='default'`))?.id;
  if (!mCp) mCp = await insMachine(`bs-cp-${tag}`, 'default', true);
  const mCpOther = await insMachine(`bs-cp-other-${tag}`, `zt-bs-cp-${tag}`, true);
  await insDevDb(pCp, 'default', `bs_${tag}_cp_db`);
  await insDevDb(pCp, `zt-bs-cp-${tag}`, `bs_${tag}_cp_other_db`);
  const dockerCp = makeDocker({ reachable: true, networks: new Set() });

  const planOther = await planBuildBootstrap(await row('machine', mCpOther), await row('project', pCp), { docker: dockerCp });
  ok(!planOther.steps.some((s) => s.kind === 'mesh-control-plane'),
     'a machine that is NOT the queenzee host gets no control-plane step');
  const planCp = await planBuildBootstrap(await row('machine', mCp), await row('project', pCp), { docker: dockerCp });
  const cpStep = planCp.steps.find((s) => s.kind === 'mesh-control-plane');
  ok(cpStep?.status === 'planned' && cpStep?.target === 'default',
     `the queenzee host's plan names the performable stand-up [${cpStep?.status}]`);
  ok(MESH_CONTROL_PLANE_SERVICES.every((svc) => (cpStep?.action || '').includes(svc)),
     `the action names the three control-plane services [${cpStep?.action}]`);

  const dockerRunning = makeDocker({ reachable: true, networks: new Set(),
    runningContainers: new Set([MESH_CONTROL_PLANE_CONTAINER]) });
  const planUp = await planBuildBootstrap(await row('machine', mCp), await row('project', pCp), { docker: dockerRunning });
  const upStep = planUp.steps.find((s) => s.kind === 'mesh-control-plane');
  ok(upStep?.status === 'already-present' && /running/.test(upStep?.detail || ''),
     'a running control plane is REPORTED (already-present), not silently omitted');

  const dryCp = await performBuildBootstrap(pCp, mCp, { dryRun: true, docker: dockerCp, provisionDb: makeProvision() });
  ok(dryCp.status === 'planned'
     && !dockerCp.calls.some((c) => c.includes('--profile mesh')),
     'a DRY run issues no compose call for the control plane');

  const dockerGo = makeDocker({ reachable: true, networks: new Set() });
  const probeOk = async () => ({ ok: true, url: 'https://netbird-management:443', host: 'netbird-management', port: 443, verdict: 'ok' });
  const perfCp = await performBuildBootstrap(pCp, mCp, { dryRun: false, docker: dockerGo,
    provisionDb: makeProvision(), actor: 'tester@xell', mesh: { probeApi: probeOk } });
  const cpRes = perfCp.results.find((s) => s.kind === 'mesh-control-plane');
  ok(cpRes?.status === 'created', `the perform brings the control plane up [${cpRes?.status}]`);
  const upCall = dockerGo.calls.find((c) => c.includes('--profile mesh'));
  ok(upCall === `compose -f ${composeFile} --profile mesh up -d ${MESH_CONTROL_PLANE_SERVICES.join(' ')}`,
     `compose is invoked with the three mesh services ONLY (never the queenzee's own) [${upCall}]`);
  ok(/NETBIRD_API_TOKEN/.test(cpRes?.detail || '') && /NETBIRD_GATEWAY_SETUP_KEY/.test(cpRes?.detail || '')
     && /No secret was minted or stored/.test(cpRes?.detail || ''),
     'the receipt names the env a human must still set, and that no secret was minted');
  ok(/^https?:\/\//.test(cpRes?.management_url || ''),
     `the receipt carries a TYPED management_url (resolved, else the probed URL) for the console to fill from [${cpRes?.management_url}]`);
  const cpRow = await one(`SELECT * FROM build_bootstrap_action WHERE id=$1`, [perfCp.action_id]);
  ok(cpRow?.steps?.some((s) => s.kind === 'mesh-control-plane' && s.status === 'created'),
     'the stand-up is RECORDED in the audit steps');

  // A SCOPED perform (the Mesh panel's stand-up) creates ONLY the named kinds: standing the control
  // plane up must not create a project's networks/dev-db as a side effect of a mesh-only action.
  const pScoped = await insProject(`bs-scoped-${tag}`,
    { tiers: { spinoff: { requires: { networks: ['bs_scoped_net'] } } } });
  await insDevDb(pScoped, 'default', `bs_${tag}_scoped_db`);
  const dockerScoped = makeDocker({ reachable: true, networks: new Set() });
  const scoped = await performBuildBootstrap(pScoped, mCp, { dryRun: false, docker: dockerScoped,
    provisionDb: makeProvision(), actor: 'tester@xell', kinds: ['mesh-control-plane'], mesh: { probeApi: probeOk } });
  ok(scoped.results.some((s) => s.kind === 'mesh-control-plane' && s.status === 'created'),
     'a scoped perform runs the requested mesh stand-up');
  ok(!scoped.results.some((s) => s.kind === 'network'),
     'and does NOT perform the unrelated network step it was not asked for');
  ok(!dockerScoped.calls.some((c) => c.includes('network') && c.includes('create')),
     'no unrelated network was created as a side effect');

  // Idempotence: the container now answers 'running' → already-present, no second compose up.
  const dockerUp2 = makeDocker({ reachable: true, networks: new Set(),
    runningContainers: new Set([MESH_CONTROL_PLANE_CONTAINER]) });
  const perfCp2 = await performBuildBootstrap(pCp, mCp, { dryRun: false, docker: dockerUp2,
    provisionDb: makeProvision(), actor: 'tester@xell', mesh: { probeApi: probeOk } });
  const cpRes2 = perfCp2.results.find((s) => s.kind === 'mesh-control-plane');
  ok(cpRes2?.status === 'already-present' && !dockerUp2.calls.some((c) => c.includes('--profile mesh')),
     `a second perform reports already-present and issues no compose [${cpRes2?.status}]`);

  // A control plane that came up but does not answer its API is a FAILED step, not a green lie.
  const dockerBad = makeDocker({ reachable: true, networks: new Set() });
  const perfBad = await performBuildBootstrap(pCp, mCp, { dryRun: false, docker: dockerBad,
    provisionDb: makeProvision(), actor: 'tester@xell',
    mesh: { probeApi: async () => ({ ok: false, host: 'netbird-management', port: 443, verdict: 'refused' }) } });
  const badRes = perfBad.results.find((s) => s.kind === 'mesh-control-plane');
  ok(badRes?.status === 'failed' && /management API/.test(badRes?.detail || ''),
     `an unanswering management API is reported failed [${badRes?.status}]`);

  // compose failure surfaces its real stderr
  const dockerFail = makeDocker({ reachable: true, networks: new Set(),
    failCompose: 'Error response from daemon: all predefined address pools have been fully subnetted' });
  const perfFailCp = await performBuildBootstrap(pCp, mCp, { dryRun: false, docker: dockerFail,
    provisionDb: makeProvision(), actor: 'tester@xell', mesh: { probeApi: probeOk } });
  const failCpRes = perfFailCp.results.find((s) => s.kind === 'mesh-control-plane');
  ok(failCpRes?.status === 'failed' && /fully subnetted/.test(failCpRes?.stderr || ''),
     `a compose failure surfaces its REAL stderr [${failCpRes?.stderr?.slice(0, 50)}…]`);

  // a missing compose file is a named cannot (the install's path is unknowable from a cage/image)
  config.meshComposeFile = path.join(cpDir, 'not-here.yml');
  const perfNoFile = await performBuildBootstrap(pCp, mCp, { dryRun: false, docker: makeDocker({ networks: new Set() }),
    provisionDb: makeProvision(), actor: 'tester@xell', mesh: { probeApi: probeOk } });
  const noFileRes = perfNoFile.results.find((s) => s.kind === 'mesh-control-plane');
  ok(noFileRes?.status === 'cannot' && /MESH_COMPOSE_FILE/.test(noFileRes?.detail || ''),
     `a missing queenzee compose file names MESH_COMPOSE_FILE [${noFileRes?.detail?.slice(0, 60)}…]`);

  // a CAGE has no docker: the whole action refuses legibly, and nothing is composed. That refusal
  // is correct — the stand-up runs on a machine with docker, never inside a cxell.
  const noDocker = async () => ({ unknown: true, reason: 'spawn docker ENOENT' });
  const perfCage = await performBuildBootstrap(pCp, mCp, { dryRun: false, docker: noDocker,
    provisionDb: makeProvision(), actor: 'caged@xell', mesh: { probeApi: probeOk } });
  ok(perfCage.status === 'refused' && /ENOENT/.test(perfCage.reason || ''),
     `a cage (no docker CLI) refuses the whole action legibly [${perfCage.reason?.slice(0, 60)}…]`);

  // ── THE STORE IS THE SOURCE: the console's row drives the stand-up (§1 + §2 + §3) ─────────────
  // The card's own claim, asserted end to end: a human configures the mesh in the console (one
  // mesh_config row here), clicks stand-up, and the step (a) renders management.json from the row,
  // (b) creates the containers with the row's domain/ports/secrets as compose env, (c) bootstraps
  // the first PAT and records it write-only, and (d) leaves nothing for a human to hand-edit.
  console.log('\n── the stand-up consumes the mesh config STORE and bootstraps the first PAT ──');
  const NEW_KEY = Buffer.alloc(32, 7).toString('base64');
  const SEAM_KEYS = ['netbirdApiUrl', 'netbirdApiToken', 'meshDomain', 'netbirdSignalUri', 'netbirdRelayEndpoint',
    'netbirdDatastoreEncryptionKey', 'netbirdRelayAuthSecret', 'netbirdGatewaySetupKey',
    'netbirdMgmtGrpcPort', 'netbirdMgmtApiPort', 'netbirdSignalPort', 'netbirdRelayPort', 'netbirdDashHttpPort'];
  savedSecrets = { ...savedSecrets, seam: Object.fromEntries(SEAM_KEYS.map((k) => [k, config[k]])) };

  // A FRESH install dir: no netbird/ beside the compose file, so the step generates management.json
  // from the shipped example using the console's values (the no-hand-edit path a human clicks).
  const cpDir3 = fs.mkdtempSync(path.join(os.tmpdir(), `bs-cp3-${tag}-`));
  tmpDirs.push(cpDir3);
  const composeFile3 = path.join(cpDir3, 'docker-compose.bootstrap.yml');
  fs.writeFileSync(composeFile3, 'name: zeehive\nservices:\n  netbird-management:\n    image: example\n');

  // The console write, as it lands in the meta-DB: the secrets are the row's (the datastore key came
  // from the console's generate; the relay secret was pasted), and NO api_token exists yet.
  await q(`INSERT INTO mesh_config (machine_id, enabled, mesh_domain, mgmt_api_port, signal_uri, relay_endpoint,
      datastore_encryption_key, relay_auth_secret, updated_by)
    VALUES ($1, true, 'console.mesh', 3443, 'netbird-signal:10000', 'relay://netbird-relay:33080', $2, 'relay-auth-from-console', 'tester@console')`,
    [mCp, NEW_KEY]);
  meshConfigMachines.push(mCp);

  // Only the TWO placeholder secrets of an EXISTING file are ever filled — a URI an operator set is
  // never second-guessed. (Pure, so this cannot be confounded by the perform below.)
  const fillOnly = placeholderFill(JSON.parse(exampleText),
    { datastoreEncryptionKey: NEW_KEY, relaySecret: 'x', signalUri: 'y' });
  ok(fillOnly.datastoreEncryptionKey === NEW_KEY && fillOnly.relaySecret === 'x' && fillOnly.signalUri === undefined,
     'an existing management.json has ONLY its placeholder secrets filled — a URI is never invented into it');

  config.meshComposeFile = composeFile3;
  const dockerPat = makeDocker({ reachable: true, networks: new Set() });
  let bootArgs = null;
  const perfPat = await performBuildBootstrap(pCp, mCp, { dryRun: false, docker: dockerPat,
    provisionDb: makeProvision(), actor: 'tester@console', mesh: {
      probeApi: probeOk,
      bootstrapPat: async (args) => { bootArgs = args; return { ok: true, token: `nbp_${'B'.repeat(36)}`, version: '0.78.1' }; },
      request: async () => ({ status: 500, json: { message: 'stub' } }),
    } });
  const patRes = perfPat.results.find((s) => s.kind === 'mesh-control-plane');
  ok(patRes?.status === 'created' && /bootstrapped into the control plane/.test(patRes?.detail || ''),
     `the stand-up bootstraps the first PAT when no token exists anywhere [${patRes?.status}]`);
  ok((patRes?.detail || '').includes('nbp_…BBBB') && !(patRes?.detail || '').includes(`nbp_${'B'.repeat(36)}`),
     'the receipt names the token HINT only — the token itself never rides the receipt');
  ok(bootArgs?.dataKey === NEW_KEY && bootArgs?.probe === probeOk,
     "the bootstrap got the ROW's datastore key (its account rows are encrypted with the plane's own key)");
  const genDoc = JSON.parse(fs.readFileSync(path.join(cpDir3, 'netbird', 'management.json'), 'utf8'));
  ok(genDoc.DataStoreEncryptionKey === NEW_KEY && genDoc.Relay.Secret === 'relay-auth-from-console'
     && genDoc.Signal.URI === 'netbird-signal:10000' && genDoc.Relay.Addresses[0] === 'relay://netbird-relay:33080',
     'management.json was GENERATED from the console row — the shipped placeholder is gone, no hand-edit');
  ok(managementJsonMissingSecrets(genDoc).length === 0, 'and no placeholder survives it');
  const patEnv = dockerPat.envCalls.find((c) => c.args.includes('--profile mesh'))?.env || {};
  ok(patEnv.MESH_DOMAIN === 'console.mesh' && patEnv.NETBIRD_MGMT_API_PORT === '3443'
     && patEnv.NETBIRD_RELAY_AUTH_SECRET === 'relay-auth-from-console'
     && patEnv.NETBIRD_RELAY_ENDPOINT === 'relay://netbird-relay:33080'
     && patEnv.NETBIRD_MGMT_API_URL === 'https://netbird-management:443',
     `the compose child carries the console's domain/ports/secrets as env [${Object.keys(patEnv).length} vars]`);
  const storedRow = await one(`SELECT * FROM mesh_config WHERE machine_id=$1`, [mCp]);
  ok(storedRow.api_token === `nbp_${'B'.repeat(36)}` && storedRow.enabled === true
     && storedRow.updated_by === 'stand-up@queenzee',
     'the bootstrapped PAT is persisted into the store, attributed to the stand-up');
  ok(config.netbirdApiToken === `nbp_${'B'.repeat(36)}` && config.netbirdApiUrl === 'https://netbird-management:443'
     && config.meshDomain === 'console.mesh' && config.netbirdMgmtApiPort === 3443
     && config.netbirdDatastoreEncryptionKey === NEW_KEY,
     'and lib/netbird.js + the stand-up now resolve URL/domain/ports/key from the store (the seam)');

  // A second stand-up must NOT re-mint: the token resolves from the store now.
  let bootCalls = 0;
  const dockerPat2 = makeDocker({ reachable: true, networks: new Set(),
    runningContainers: new Set([MESH_CONTROL_PLANE_CONTAINER]) });
  const perfPat2 = await performBuildBootstrap(pCp, mCp, { dryRun: false, docker: dockerPat2,
    provisionDb: makeProvision(), actor: 'tester@console', mesh: {
      probeApi: probeOk,
      bootstrapPat: async () => { bootCalls++; return { ok: true, token: 'nope' }; },
      request: async () => ({ status: 500, json: { message: 'stub' } }),
    } });
  const patRes2 = perfPat2.results.find((s) => s.kind === 'mesh-control-plane');
  ok(bootCalls === 0 && /No secret was minted or stored/.test(patRes2?.detail || '')
     && !dockerPat2.calls.some((c) => c.includes('--profile mesh')),
     'a second stand-up neither re-mints nor composes — the store is the source of truth');

  // A bootstrap that seeds the store and writes it back but then fails to prove the plane is healthy
  // still hands back the MINTED token. Its plaintext is unrecoverable — if the stand-up drops it, the
  // next attempt finds an account (alreadyPresent) and tells a human to mint a PAT by hand, which is
  // the very hand-edit §1 removes. It must be recorded write-only, with the failure still a warning.
  await q(`UPDATE mesh_config SET api_token=NULL, api_token_hint=NULL WHERE machine_id=$1`, [mCp]);
  config.netbirdApiToken = null;
  const dockerPat3 = makeDocker({ reachable: true, networks: new Set() });
  const bootFail = await performBuildBootstrap(pCp, mCp, { dryRun: false, docker: dockerPat3,
    provisionDb: makeProvision(), actor: 'tester@console', mesh: {
      probeApi: probeOk,
      bootstrapPat: async () => ({ ok: false, token: `nbp_${'D'.repeat(36)}`,
        reason: 'the control plane restarted but the management API is not answering' }),
      request: async () => ({ status: 500, json: { message: 'stub' } }),
    } });
  const patFailRes = bootFail.results.find((s) => s.kind === 'mesh-control-plane');
  const rescued = await one(`SELECT api_token, api_token_hint FROM mesh_config WHERE machine_id=$1`, [mCp]);
  ok(rescued.api_token === `nbp_${'D'.repeat(36)}` && rescued.api_token_hint === 'nbp_…DDDD',
     'a token minted before the plane failed to answer is still recorded write-only, not dropped');
  ok(/WAS minted and stored write-only/.test(patFailRes?.warning || '')
     && !JSON.stringify(patFailRes || {}).includes(`nbp_${'D'.repeat(36)}`),
     'and the warning names only the hint — the failure is not silent, and the token never rides the receipt');

  console.log(fail ? `\n${fail} FAILED` : '\nall good');
} catch (e) {
  console.error('TEST ERROR:', e);
  fail++;
} finally {
  // clean up what THIS test created, whatever happened (house rule: tests clean up in a finally)
  try {
    for (const id of meshConfigMachines) await q(`DELETE FROM mesh_config WHERE machine_id=$1`, [id]).catch(() => {});
    for (const p of createdProjects) {
      await q(`DELETE FROM build_bootstrap_action WHERE project_id=$1`, [p]).catch(() => {});
      await q(`DELETE FROM deploy_site WHERE project_id=$1`, [p]).catch(() => {});
      await q(`DELETE FROM pool_config WHERE project_id=$1`, [p]).catch(() => {});
      await q(`DELETE FROM container WHERE project_id=$1`, [p]).catch(() => {});
      await q(`DELETE FROM project WHERE id=$1`, [p]).catch(() => {});
    }
    if (createdMachines.length) await q(`DELETE FROM machine WHERE id = ANY($1::uuid[])`, [createdMachines]).catch(() => {});
    fs.rmSync(repoDir, { recursive: true, force: true });
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
    // The control-plane section mutates process-wide config (compose path + operator secrets) to
    // drive the generator; restore whatever the environment had so a later suite is unaffected.
    if (savedSecrets) {
      config.netbirdDatastoreEncryptionKey = savedSecrets.k;
      config.netbirdRelayAuthSecret = savedSecrets.s;
      config.meshComposeFile = savedSecrets.url;
      // The store-applied seam (applyMeshConfig) — restore every key so a later suite sees the env.
      for (const [k, v] of Object.entries(savedSecrets.seam || {})) config[k] = v;
    }
  } catch (e) { console.error('CLEANUP ERROR:', e); }
  await pool.end();
}
process.exit(fail ? 1 : 0);
