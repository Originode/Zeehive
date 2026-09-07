// DOCKER JANITOR — reap-time network pruning + the scheduled leftovers sweep
// (docs/netbird-mesh-plan.md §3.6, DR-2; the TKT-178 address-pool-exhaustion fix).
//
// Covered:
//   • xellNetworkCandidates (PURE): a xell's own rows name its networks (`network` column +
//     `<compose_project>_default`), deduped — and ONLY slug-bearing names survive, so a shared
//     network a row happens to name (zee-hive-net, a required external) can never be a candidate
//   • the reaper WIRES the pruning: removeNetwork imported, candidates walked AFTER the owned-
//     container removal and BEFORE the container rows are deleted (the rows are the only record)
//   • sweepDockerLeftovers auto-performs ONLY the two provably-throwaway kinds (stale-network,
//     stale-container) — a stopped dev db is planned by the shared planner but HELD for the
//     medic plane, never auto-started
//   • a dry run performs no mutating docker call at all
//   • an unreachable machine is reported refused, never thrown, and nothing is attempted
//   • startDockerJanitor exists and index.js registers it beside the image janitor
//
// RUN:  DATABASE_URL=... node test/docker-janitor.test.mjs
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { q, one, pool } from '../server/src/db/pool.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { xellNetworkCandidates } = await import('../server/src/queenzee/reaper.js');
const { sweepDockerLeftovers, startDockerJanitor, AUTO_REPAIR_KINDS } =
  await import('../server/src/lib/docker-repair.js');

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };
const section = (t) => console.log(`\n── ${t} ──`);
const cleanups = [];

// The docker-repair.test.mjs stub, trimmed to what the sweep exercises.
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
      const name = args[2];
      mutations.push(`rm -f ${name}`);
      if (!containers.has(name)) return { status: 1, stdout: '', stderr: `No such container: ${name}` };
      containers.delete(name);
      return { status: 0, stdout: name, stderr: '' };
    }
    if (cmd === 'start') {
      const name = args[1];
      mutations.push(`start ${name}`);
      containers.set(name, 'running');
      return { status: 0, stdout: name, stderr: '' };
    }
    return { status: 1, stdout: '', stderr: `stub: unhandled ${args.join(' ')}` };
  };
  return { stub, mutations, networks, containers };
};

try {
  section('xellNetworkCandidates (pure)');
  const rows = [
    { network: 'zeehive-spin-bold-atlas-60b8fa_default', compose_project: 'zeehive-spin-bold-atlas-60b8fa' },
    { network: 'zee-hive-net', compose_project: null },                 // shared — no slug, never a candidate
    { network: null, compose_project: 'zeehive-spin-bold-atlas-60b8fa' }, // dupe via _default
  ];
  const cands = xellNetworkCandidates('bold-atlas-60b8fa', rows);
  ok(cands.length === 1 && cands[0] === 'zeehive-spin-bold-atlas-60b8fa_default',
     `only the slug-bearing name survives, deduped (${JSON.stringify(cands)})`);
  ok(xellNetworkCandidates('bold-atlas-60b8fa', [{ network: 'keep-spin-shared' }]).length === 0,
     'a shared/required network name without the slug is never a candidate');
  ok(xellNetworkCandidates('', rows).length === 0, 'no slug → no candidates (never a wildcard)');
  ok(xellNetworkCandidates('bold-atlas-60b8fa', []).length === 0
     && xellNetworkCandidates('bold-atlas-60b8fa', null).length === 0,
     'empty/absent rows are a no-op');

  section('the reaper wires the pruning (static)');
  const reaper = readFileSync(resolve(ROOT, 'server/src/queenzee/reaper.js'), 'utf8');
  ok(/import\s*{[^}]*removeNetwork[^}]*}\s*from\s*'\.\.\/lib\/docker\.js'/.test(reaper),
     'reaper imports removeNetwork from lib/docker.js');
  const stopIdx = reaper.indexOf('stopAndRemoveContainer(c.docker_ctx');
  const netIdx = reaper.indexOf('xellNetworkCandidates(xell.slug');
  // NB: the spaced form matches the actual statement — an earlier COMMENT quotes the unspaced one.
  const delIdx = reaper.indexOf('DELETE FROM container WHERE owner_xell_id = $1');
  ok(stopIdx > -1 && netIdx > stopIdx && delIdx > netIdx,
     'networks are removed AFTER the owned containers and BEFORE the rows are deleted (the rows are the only record of the names)');

  section('setup: an enabled machine + retired/live xells + a known dev db row');
  const CTX = 'janitor-stub-ctx';
  const machine = await one(
    `INSERT INTO machine (key, docker_ctx, enabled) VALUES ('janitor-stub', $1, true) RETURNING *`, [CTX]);
  cleanups.push(() => q(`DELETE FROM machine WHERE id=$1`, [machine.id]));
  const proj = await one(
    `INSERT INTO project (name, repo_root, manifest)
     VALUES ('docker-janitor-test', '/tmp/x', '{"tiers":{"spinoff":{"requires":{"networks":["keep-spin-shared"]}}}}'::jsonb)
     RETURNING id`);
  cleanups.push(() => q(`DELETE FROM project WHERE id=$1`, [proj.id]));
  const xource = await one(
    `INSERT INTO xource (project_id, ref) VALUES ($1, 'main') RETURNING id`, [proj.id]);
  cleanups.push(() => q(`DELETE FROM xource WHERE id=$1`, [xource.id]));
  const mkXell = (slug, status) => one(
    `INSERT INTO xell (project_id, xource_id, slug, branch, status)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`, [proj.id, xource.id, slug, `spinoff/${slug}`, status]);
  const retired = await mkXell('janitor-retired-1', 'retired');
  const live = await mkXell('janitor-live-1', 'claimed');
  cleanups.push(() => q(`DELETE FROM xell WHERE id IN ($1,$2)`, [retired.id, live.id]));
  const dbRow = await one(
    `INSERT INTO container (project_id, role, tier, isolation, name, docker_ctx)
     VALUES ($1,'db','dev','shared','janitortest_db_dev_stub',$2) RETURNING id`, [proj.id, CTX]);
  cleanups.push(() => q(`DELETE FROM container WHERE id=$1`, [dbRow.id]));

  const fixtures = () => makeDocker({
    networks: new Map([
      ['proj-spin-dead-xell_default', 0],   // stale → auto rm
      ['proj-spin-busy-xell_default', 2],   // pinned → held (cannot)
      ['keep-spin-shared', 0],              // required external → never named
    ]),
    containers: new Map([
      ['janitortest_spin_server_janitor-retired-1', 'exited'],  // retired husk → auto rm -f
      ['janitortest_spin_server_janitor-live-1', 'running'],    // live → untouched
      ['janitortest_spin_server_stranger', 'exited'],           // unknown slug → held (cannot)
      ['janitortest_db_dev_stub', 'exited'],                    // db-start is NOT an auto kind
    ]),
  });

  section('dry run performs nothing');
  const dDry = fixtures();
  const dry = await sweepDockerLeftovers({ dryRun: true, docker: dDry.stub });
  const mineDry = dry.find((s) => s.machine === 'janitor-stub');
  ok(!!mineDry && (mineDry.planned || []).length === 2,
     `dry run plans exactly the two auto kinds (${(mineDry?.planned || []).map((s) => s.kind).join(', ')})`);
  ok(dDry.mutations.length === 0, 'and performed no mutating docker call');

  section('perform: auto kinds only — a stopped db is HELD, never auto-started');
  ok(AUTO_REPAIR_KINDS.join(',') === 'stale-network,stale-container',
     'the auto set is exactly the two provably-throwaway kinds');
  const d2 = fixtures();
  const swept = await sweepDockerLeftovers({ dryRun: false, docker: d2.stub });
  const mine = swept.find((s) => s.machine === 'janitor-stub');
  ok(!d2.networks.has('proj-spin-dead-xell_default'), 'the stale spin network is gone');
  ok(d2.networks.has('proj-spin-busy-xell_default'), 'the pinned network is untouched');
  ok(d2.networks.has('keep-spin-shared'), 'the manifest-required network is untouched');
  ok(!d2.containers.has('janitortest_spin_server_janitor-retired-1'), 'the retired husk is gone');
  ok(d2.containers.has('janitortest_spin_server_janitor-live-1'), 'the live xell\'s container is untouched');
  ok(d2.containers.has('janitortest_spin_server_stranger'), 'an unknown slug is untouched');
  ok(d2.containers.get('janitortest_db_dev_stub') === 'exited',
     'the stopped dev db was NOT auto-started (starting is the medic plane\'s call)');
  ok(!d2.mutations.some((m) => m.startsWith('start ')), 'no docker start was issued at all');
  ok((mine?.held ?? -1) >= 1, `the held steps are counted for the summary (${mine?.held})`);

  section('an unreachable machine is reported, not thrown');
  const dDown = makeDocker({ reachable: false });
  const down = await sweepDockerLeftovers({ dryRun: false, docker: dDown.stub });
  const mineDown = down.find((s) => s.machine === 'janitor-stub');
  ok(!!mineDown?.refused && /not reachable/.test(mineDown.refused), 'the refusal is carried in the summary');
  ok(dDown.mutations.length === 0, 'and nothing was attempted');

  section('registration');
  ok(typeof startDockerJanitor === 'function', 'startDockerJanitor is exported');
  const index = readFileSync(resolve(ROOT, 'server/src/index.js'), 'utf8');
  ok(/import\s*{\s*startDockerJanitor\s*}\s*from\s*'\.\/lib\/docker-repair\.js'/.test(index)
     && index.includes('startDockerJanitor();'),
     'index.js registers the janitor beside the image janitor');
} finally {
  for (const c of cleanups.reverse()) { try { await c(); } catch { /* best-effort teardown */ } }
  await pool.end();
}

console.log(fail ? `\n${fail} FAILED` : '\nall good');
process.exit(fail ? 1 : 0);
