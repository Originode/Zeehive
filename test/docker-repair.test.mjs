// DOCKER REPAIR — the medic's host lever for wedged docker state (lib/docker-repair.js), with a
// STUBBED docker adapter (the build-bootstrap.test.mjs pattern) so every daemon-side branch is
// covered without a docker daemon; the meta-DB facts (retired xell, known dev db, manifest
// requires) run against a real postgres — DATABASE_URL.
//
// Covered:
//   • an unreachable context REFUSES the whole action (never act blind — bootstrap's rule)
//   • an EMPTY '-spin-' network is planned for removal; a non-empty one is a named 'cannot'
//   • a network any manifest `requires` names is NEVER touched, spin-named and empty or not
//   • a spin container of a RETIRED xell is planned for rm -f; a LIVE xell's is skipped
//     silently; an UNKNOWN slug is a named 'cannot' (a shared daemon may host another install)
//   • a meta-DB-known dev db that is exited is planned for `docker start`; a row with no
//     container is a 'cannot' (that is a provision — bootstrap's job); a running one is nothing
//   • a DRY RUN performs no mutating docker call at all
//   • perform removes/starts, and a target gone between plan and perform is 'already-gone'
//   • performDockerRepair resolves the machine BY KEY as well as by id
//   • the medic tool `docker_repair` audits to medic_action BEFORE acting
//
// RUN:  DATABASE_URL=... node test/docker-repair.test.mjs
import { q, one, pool } from '../server/src/db/pool.js';

const { planDockerRepair, performDockerRepair, spinContainerSlug } =
  await import('../server/src/lib/docker-repair.js');

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };
const section = (t) => console.log(`\n── ${t} ──`);
const cleanups = [];

// ── the stubbed docker adapter ──────────────────────────────────────────────
// networks: Map name → attached-container count. containers: Map name → state. `mutations`
// records every rm/start so a dry run can assert none happened.
const makeDocker = ({ reachable = true, networks = new Map(), containers = new Map() } = {}) => {
  const mutations = [];
  const stub = async (_ctx, args) => {
    const [cmd, sub] = args;
    if (cmd === 'version') {
      return reachable ? { status: 0, stdout: '28.0.0\n', stderr: '' }
                       : { unknown: true, reason: 'connection refused (stub)' };
    }
    if (cmd === 'network' && sub === 'ls') {
      return { status: 0, stdout: [...networks.keys()].join('\n') + '\n', stderr: '' };
    }
    if (cmd === 'network' && sub === 'inspect') {
      const name = args[2];
      return networks.has(name)
        ? { status: 0, stdout: `${networks.get(name)}\n`, stderr: '' }
        : { status: 1, stdout: '', stderr: `network ${name} not found` };
    }
    if (cmd === 'network' && sub === 'rm') {
      const name = args[2];
      mutations.push(`network rm ${name}`);
      if (!networks.has(name)) return { status: 1, stdout: '', stderr: `no such network: ${name}` };
      networks.delete(name);
      return { status: 0, stdout: name, stderr: '' };
    }
    if (cmd === 'ps') {
      const rows = [...containers.entries()].map(([n, st]) => `${n}\t${st}`);
      return { status: 0, stdout: rows.join('\n') + '\n', stderr: '' };
    }
    if (cmd === 'inspect') {
      const name = args[1];
      return containers.has(name)
        ? { status: 0, stdout: `${containers.get(name)}\n`, stderr: '' }
        : { status: 1, stdout: '', stderr: `No such object: ${name}` };
    }
    if (cmd === 'rm') {
      const name = args[2];   // rm -f <name>
      mutations.push(`rm -f ${name}`);
      if (!containers.has(name)) return { status: 1, stdout: '', stderr: `No such container: ${name}` };
      containers.delete(name);
      return { status: 0, stdout: name, stderr: '' };
    }
    if (cmd === 'start') {
      const name = args[1];
      mutations.push(`start ${name}`);
      if (!containers.has(name)) return { status: 1, stdout: '', stderr: `No such container: ${name}` };
      containers.set(name, 'running');
      return { status: 0, stdout: name, stderr: '' };
    }
    return { status: 1, stdout: '', stderr: `stub: unhandled ${args.join(' ')}` };
  };
  return { stub, mutations, networks, containers };
};

try {
  section('setup: machine + project + xells + a known dev db row');
  const CTX = 'repair-stub-ctx';
  const machine = await one(
    `INSERT INTO machine (key, docker_ctx, enabled) VALUES ('repair-stub', $1, false) RETURNING *`, [CTX]);
  cleanups.push(() => q(`DELETE FROM machine WHERE id=$1`, [machine.id]));
  const proj = await one(
    `INSERT INTO project (name, repo_root, manifest)
     VALUES ('docker-repair-test', '/tmp/x', '{"tiers":{"spinoff":{"requires":{"networks":["keep-spin-shared"]}}}}'::jsonb)
     RETURNING id`);
  cleanups.push(() => q(`DELETE FROM project WHERE id=$1`, [proj.id]));
  const xource = await one(
    `INSERT INTO xource (project_id, ref) VALUES ($1, 'main') RETURNING id`, [proj.id]);
  cleanups.push(() => q(`DELETE FROM xource WHERE id=$1`, [xource.id]));
  const mkXell = (slug, status) => one(
    `INSERT INTO xell (project_id, xource_id, slug, branch, status)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`, [proj.id, xource.id, slug, `spinoff/${slug}`, status]);
  const retired = await mkXell('repair-retired-1', 'retired');
  const live = await mkXell('repair-live-1', 'claimed');
  cleanups.push(() => q(`DELETE FROM xell WHERE id IN ($1,$2)`, [retired.id, live.id]));
  const dbRow = await one(
    `INSERT INTO container (project_id, role, tier, isolation, name, docker_ctx)
     VALUES ($1,'db','dev','shared','repairtest_db_dev_stub',$2) RETURNING id`, [proj.id, CTX]);
  const dbGone = await one(
    `INSERT INTO container (project_id, role, tier, isolation, name, docker_ctx)
     VALUES ($1,'db','dev','shared','repairtest_db_dev_missing',$2) RETURNING id`, [proj.id, CTX]);
  cleanups.push(() => q(`DELETE FROM container WHERE id IN ($1,$2)`, [dbRow.id, dbGone.id]));

  section('slug extraction (pure)');
  ok(spinContainerSlug('zeehive_spin_server_bold-atlas-60b8fa') === 'bold-atlas-60b8fa', 'app-tier naming');
  ok(spinContainerSlug('zeehive_db_spin_quiet-ember-1dbd24') === 'quiet-ember-1dbd24', 'clone-db naming');
  ok(spinContainerSlug('zeehive_db_dev_mardale_prod') === null, 'a shared dev db is NOT spin-named');

  section('the plan');
  const d1 = makeDocker({
    networks: new Map([
      ['proj-spin-dead-xell_default', 0],      // stale → rm
      ['proj-spin-busy-xell_default', 2],      // pinned → cannot
      ['keep-spin-shared', 0],                 // required external → never named
      ['bridge', 0],                           // not spin-named → ignored
    ]),
    containers: new Map([
      ['repairtest_spin_server_repair-retired-1', 'exited'],   // retired husk → rm -f
      ['repairtest_spin_server_repair-live-1', 'running'],     // live xell → skipped
      ['repairtest_spin_server_who-knows', 'exited'],          // unknown slug → cannot
      ['repairtest_db_dev_stub', 'exited'],                    // known dev db, stopped → start
    ]),
  });
  const plan = await planDockerRepair(machine, { docker: d1.stub });
  ok(plan.refused === null, 'a reachable daemon is not refused');
  const kinds = plan.steps.map((s) => `${s.kind}:${s.target}:${s.status}`);
  ok(kinds.includes('stale-network:proj-spin-dead-xell_default:planned'), 'empty spin network → planned rm');
  ok(kinds.some((k) => k.startsWith('cannot:network \'proj-spin-busy-xell_default\'')), 'pinned spin network → named cannot');
  ok(!kinds.some((k) => k.includes('keep-spin-shared')), 'a manifest-required network is never named');
  ok(!kinds.some((k) => k.includes('bridge')), 'a non-spin network is never named');
  ok(kinds.includes('stale-container:repairtest_spin_server_repair-retired-1:planned'), 'retired husk → planned rm -f');
  ok(!kinds.some((k) => k.includes('repair-live-1')), 'a live xell\'s container is skipped silently');
  ok(kinds.some((k) => k.startsWith('cannot:container \'repairtest_spin_server_who-knows\'')), 'unknown slug → named cannot, never removed');
  ok(kinds.includes('db-start:repairtest_db_dev_stub:planned'), 'stopped known dev db → planned start');
  ok(kinds.some((k) => k.startsWith('cannot:db \'repairtest_db_dev_missing\'')), 'a modeled db with no container → cannot (a provision, not a repair)');
  ok(d1.mutations.length === 0, 'planning performed NO mutating docker call');

  section('refusal: unreachable daemon');
  const dDown = makeDocker({ reachable: false });
  const r = await performDockerRepair(machine.id, { docker: dDown.stub });
  ok(r.status === 'refused' && /not reachable/.test(r.reason), 'the whole action refuses when the daemon is down');
  ok(dDown.mutations.length === 0, '…and nothing was attempted');

  section('dry run performs nothing');
  const dDry = makeDocker({ networks: new Map([['proj-spin-dead_default', 0]]) });
  const dry = await performDockerRepair('repair-stub', { dryRun: true, docker: dDry.stub });
  const dryPlanned = (dry.plan || []).filter((s) => s.status === 'planned');
  ok(dry.status === 'planned' && dryPlanned.length === 1
     && dryPlanned[0].target === 'proj-spin-dead_default',
     'dry run returns the plan (machine resolved BY KEY)');
  ok(dDry.mutations.length === 0, 'dry run performed no mutating docker call');

  section('perform');
  const d2 = makeDocker({
    networks: new Map([['proj-spin-dead_default', 0]]),
    containers: new Map([
      ['repairtest_spin_server_repair-retired-1', 'exited'],
      ['repairtest_db_dev_stub', 'exited'],
    ]),
  });
  const done = await performDockerRepair('repair-stub', { docker: d2.stub });
  ok(done.status === 'repaired', `perform reports repaired (${done.status})`);
  ok(!d2.networks.has('proj-spin-dead_default'), 'the stale network is gone');
  ok(!d2.containers.has('repairtest_spin_server_repair-retired-1'), 'the husk container is gone');
  ok(d2.containers.get('repairtest_db_dev_stub') === 'running', 'the dev db is running');

  section('idempotence: gone between plan and perform');
  // The stub's plan sees the network, but a rival removes it before perform: rm answers
  // "no such network" → already-gone, not failed.
  const d3 = makeDocker({ networks: new Map([['proj-spin-race_default', 0]]) });
  const realStub = d3.stub;
  let planned = false;
  const racing = async (ctx, args) => {
    if (args[0] === 'network' && args[1] === 'ls') planned = true;
    if (planned && args[0] === 'network' && args[1] === 'rm') d3.networks.delete(args[2]);
    return realStub(ctx, args);
  };
  const raced = await performDockerRepair('repair-stub', { docker: racing });
  const raceStep = (raced.results || []).find((s) => s.target === 'proj-spin-race_default');
  ok(raceStep?.status === 'already-gone', `a target gone between plan and perform is already-gone (${raceStep?.status})`);

  section('the medic tool audits before acting');
  const { MEDIC_TOOLS } = await import('../server/src/lib/medic-tools.js');
  const { createMedic } = await import('../server/src/lib/medics.js');
  const medic = await createMedic({ targetProjectId: proj.id, brief: 'repair test' });
  cleanups.push(() => q(`DELETE FROM medic WHERE id=$1`, [medic.id]));
  ok(!!MEDIC_TOOLS.docker_repair, 'docker_repair is on the medic registry');
  const unknownMachine = await MEDIC_TOOLS.docker_repair.run(medic, { machine: 'no-such-machine' });
  ok(unknownMachine.refused === true && /no machine/.test(unknownMachine.reason),
    'an unknown machine is a legible refusal result, not a uuid parse error');
  const acts = await q(`SELECT tool, statement, result FROM medic_action WHERE medic_id=$1`, [medic.id]);
  ok(acts.length === 1 && acts[0].tool === 'docker_repair', 'the act was audited BEFORE it ran (refusal included)');
} finally {
  for (const c of cleanups.reverse()) { try { await c(); } catch { /* best-effort teardown */ } }
  await pool.end();
}

console.log(fail ? `\n${fail} FAILED` : '\nall good');
process.exit(fail ? 1 : 0);
