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
//   • the PROD GUARD refuses, in code, when the machine hosts this project's prod stack —
//     recorded as a 'refused' action
//   • an unreachable context refuses the WHOLE action (never half-runs)
//   • every action is RECORDED (build_bootstrap_action: who asked, dry_run, steps, result)
process.env.PROVISION_MODE = 'simulate';   // before any import: no machine may be touched
process.env.SPINOFF_REGISTRY = '';
import { randomUUID } from 'node:crypto';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

const { q, one, pool } = await import('../server/src/db/pool.js');
const { planBuildBootstrap, performBuildBootstrap, guardDevOnly } = await import('../server/src/lib/build-bootstrap.js');
const { probeBuildReadiness } = await import('../server/src/lib/build-readiness.js');

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

  // ── the prod guard refuses ─────────────────────────────────────────────────
  console.log('\n── the PROD GUARD refuses a machine hosting this project\'s prod stack ──');
  const p9 = await insProject(`bs-prod-${tag}`, {});
  const m9 = await insMachine(`bs-prod-${tag}`, `zt-bs-prod-${tag}`, true);
  await insProdSite(p9, `zt-bs-prod-${tag}`);
  let guardThrew = null;
  try { await guardDevOnly(await row('machine', m9), await row('project', p9)); } catch (e) { guardThrew = e; }
  ok(!!guardThrew && /refusing to bootstrap DEV prerequisites/.test(guardThrew?.message || ''),
     `guardDevOnly refuses [${guardThrew?.message?.slice(0, 80)}…]`);
  const perf9 = await performBuildBootstrap(p9, m9, { dryRun: false, docker: makeDocker(), provisionDb: makeProvision() });
  ok(perf9.status === 'refused', `the perform is REFUSED end-to-end [${perf9.status}]`);
  const refusedRow = await one(`SELECT * FROM build_bootstrap_action WHERE id=$1`, [perf9.action_id]);
  ok(refusedRow?.status === 'refused' && /PROD/.test(refusedRow?.reason || ''), `the refusal is RECORDED [${refusedRow?.status}]`);

  // ── unreachable context refuses the whole action ───────────────────────────
  console.log('\n── an unreachable context REFUSES the whole action ──');
  const p10 = await insProject(`bs-unk-${tag}`, { tiers: { spinoff: { requires: { networks: ['bs_unk_net'] } } } });
  const m10 = await insMachine(`bs-unk-${tag}`, `zt-bs-unk-${tag}`, true);
  const docker10 = makeDocker({ reachable: false });
  const perf10 = await performBuildBootstrap(p10, m10, { dryRun: false, docker: docker10, provisionDb: makeProvision() });
  ok(perf10.status === 'refused', `unreachable context → refused [${perf10.status}]`);
  ok(/not reachable|reachable/.test(perf10.reason || ''), `the refusal names the unreachable context [${perf10.reason?.slice(0, 80)}…]`);
  ok(!docker10.calls.some((c) => c.includes('network create')), `nothing was created against an unreachable daemon`);

  // ── db-isolated project: the probe skips shared-dev-db, so the plan has no sdb step ──
  console.log('\n── a db-isolated project has NO shared-dev-db step (the probe already skips it) ──');
  const p11 = await insProject(`bs-iso-${tag}`, { tiers: { spinoff: { requires: { networks: ['bs_iso_net'] } } } });
  await q(`INSERT INTO pool_config (project_id, default_db_coupling) VALUES ($1,'db-isolated')`, [p11]);
  const m11 = await insMachine(`bs-iso-${tag}`, `zt-bs-iso-${tag}`, true);
  const docker11 = makeDocker({ networks: new Set() });
  const plan11 = await planBuildBootstrap(await row('machine', m11), await row('project', p11), { docker: docker11 });
  ok(!plan11.steps.some((s) => s.kind === 'shared-dev-db'),
     `no shared-dev-db step for a db-isolated project [${plan11.steps.map((s) => s.kind).join(', ') || 'none'}]`);

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
