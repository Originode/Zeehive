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
// Same dispatch shape as build-readiness.test.mjs, PLUS a `create` verb for `docker network create`
// and a recorder so a test can assert nothing was created during a dry run. `networks` is the live
// set — a created network lands in it, so a SECOND perform sees it already-present (idempotence).
const makeDocker = ({ reachable = true, networks = new Set(), volumes = new Set(), composeOk = true,
                      createNetworks = new Set(), failNetworkCreate = null, failNetworkInspect = null } = {}) => {
  const calls = [];
  const stub = async (ctx, args) => {
    calls.push(args.join(' '));
    const [cmd] = args;
    if (cmd === 'info') {
      if (!reachable) return { unknown: true, reason: `connection refused (stub) to ${ctx}` };
      return { status: 0, stdout: '28.0.0\n', stderr: '' };
    }
    if (cmd === 'compose') {
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
      const name = args[2];
      return volumes.has(name)
        ? { status: 0, stdout: `${name}\n`, stderr: '' }
        : { status: 1, stdout: '', stderr: `volume ${name} not found` };
    }
    if (cmd === 'inspect') return { status: 0, stdout: '', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  stub.calls = calls;
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
const createdMachines = [], createdProjects = [];
// Every fixture project shares one repo root that ACTUALLY has a compose file — so compose-resolves
// passes and the plans stay about the prerequisites under test (a missing compose is a 'cannot'
// that would otherwise pollute every plan).
const fs = await import('node:fs');
const os = await import('node:os');
const path = await import('node:path');
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

  console.log(fail ? `\n${fail} FAILED` : '\nall good');
} catch (e) {
  console.error('TEST ERROR:', e);
  fail++;
} finally {
  // clean up what THIS test created, whatever happened (house rule: tests clean up in a finally)
  try {
    for (const p of createdProjects) {
      await q(`DELETE FROM build_bootstrap_action WHERE project_id=$1`, [p]).catch(() => {});
      await q(`DELETE FROM deploy_site WHERE project_id=$1`, [p]).catch(() => {});
      await q(`DELETE FROM pool_config WHERE project_id=$1`, [p]).catch(() => {});
      await q(`DELETE FROM container WHERE project_id=$1`, [p]).catch(() => {});
      await q(`DELETE FROM project WHERE id=$1`, [p]).catch(() => {});
    }
    if (createdMachines.length) await q(`DELETE FROM machine WHERE id = ANY($1::uuid[])`, [createdMachines]).catch(() => {});
    fs.rmSync(repoDir, { recursive: true, force: true });
  } catch (e) { console.error('CLEANUP ERROR:', e); }
  await pool.end();
}
process.exit(fail ? 1 : 0);
