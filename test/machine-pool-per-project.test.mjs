// MACHINE-POOL-PER-PROJECT test — the contract of migrations 025 + 038 ("Pool size AND spawn
// priority are a project's choice, not a machine's habit"): the warm-pool size AND the dev spawn
// priority are (machine, project) facts, while the hard cap on live dev xells is MACHINE-WIDE
// (shared across every project). Before 025 one pool_size on the machine row applied to every
// project; before 038 one dev_priority did too — raise "local first" for one project and you
// raised it for all, and a machine was a dev host for everyone or no one. This test would FAIL the
// moment pool size OR priority slips back to machine-wide.
//
// It runs the REAL lib/machines.js against a real postgres (this xell's isolated DB): no mocks of
// the logic under test. Machines are INSERTed directly (createMachine validates the docker context
// against `docker context ls`, which a cxell has no CLI for); everything else is the shipped code.
import { randomUUID } from 'node:crypto';

const { q, one, pool } = await import('../server/src/db/pool.js');
const { setMachinePool, machinePoolSize, setMachinePriority, machinePriority,
        devMachines, listMachines, liveXellCount } =
  await import('../server/src/lib/machines.js');

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };

// Unique, self-namespaced fixtures so the test is repeatable and never collides with real rows.
const tag = randomUUID().slice(0, 8);
const ctx = `zt-ctx-${tag}`;            // docker context (UNIQUE on machine)
const mkey = `zt-mpool-${tag}`;         // machine key (UNIQUE, matches ^[a-z0-9][a-z0-9-]{0,40}$)
let machineId, projA, projB;

const mkProject = async (name) => (await one(
  `INSERT INTO project (name, repo_root) VALUES ($1,$2) RETURNING id`,
  [name, `/tmp/${name}`])).id;

// A live (non-retired, non-prod) dev xell with its OWN server container on `ctx` — exactly the
// shape liveXellCount counts. Two of these on ONE ctx, owned by TWO projects, is the machine-wide
// cap scenario.
const mkLiveXell = async (projectId, slug) => {
  const xourceId = (await one(
    `INSERT INTO xource (project_id, ref) VALUES ($1,'main') RETURNING id`, [projectId])).id;
  const xellId = (await one(
    `INSERT INTO xell (project_id, xource_id, slug, branch, status, is_production)
     VALUES ($1,$2,$3,$4,'working',false) RETURNING id`,
    [projectId, xourceId, slug, `spinoff/${slug}`])).id;
  await q(
    `INSERT INTO container (project_id, role, tier, isolation, name, docker_ctx, owner_xell_id)
     VALUES ($1,'server','spinoff','per-xell',$2,$3,$4)`,
    [projectId, `srv_${slug}`, ctx, xellId]);
  return xellId;
};

try {
  machineId = (await one(
    `INSERT INTO machine (key, docker_ctx, dev_priority, max_xells, enabled)
     VALUES ($1,$2,1,3,true) RETURNING id`, [mkey, ctx])).id;
  projA = await mkProject(`zt-proj-A-${tag}`);
  projB = await mkProject(`zt-proj-B-${tag}`);

  console.log('\n── pool size is a (machine, project) fact ──');
  ok(await machinePoolSize(machineId, projA) === 0, 'no machine_pool row ⇒ project pools 0 here');

  await setMachinePool(machineId, projA, 5);
  ok(await machinePoolSize(machineId, projA) === 5, "project A's pool on the machine is 5");
  ok(await machinePoolSize(machineId, projB) === 0,
     'project B is UNAFFECTED — the pool did NOT become a machine-wide number');

  await setMachinePool(machineId, projB, 2);
  ok(await machinePoolSize(machineId, projA) === 5, "A still 5 after B is set");
  ok(await machinePoolSize(machineId, projB) === 2, "B has its own appetite (2)");

  console.log('\n── listMachines(projectId) scopes pool_size to that project ──');
  const rowFor = async (pid) => (await listMachines(pid)).find((m) => m.id === machineId);
  ok((await rowFor(projA)).pool_size === 5, 'fleet payload for A carries pool_size 5');
  ok((await rowFor(projB)).pool_size === 2, 'fleet payload for B carries pool_size 2');

  console.log('\n── dev spawn priority is a (machine, project) fact too (038) ──');
  // The machine row carries dev_priority=1 (deprecated, unread) — the truth lives in machine_pool.
  ok(await machinePriority(machineId, projA) === 0, 'no machine_pool priority ⇒ project prefers this host 0 (not a dev target)');
  ok((await devMachines(projA)).length === 0, "devMachines(A) is empty until A gives this host a priority — the machine row's dev_priority does NOT make it one");

  await setMachinePriority(machineId, projA, 7);
  ok(await machinePriority(machineId, projA) === 7, "project A's priority on the machine is 7");
  ok(await machinePriority(machineId, projB) === 0,
     'project B is UNAFFECTED — priority did NOT become a machine-wide number');
  ok((await devMachines(projA)).some((m) => m.id === machineId), 'devMachines(A) now includes the host');
  ok((await devMachines(projB)).length === 0, 'devMachines(B) is still empty — B never set a priority here');

  ok((await listMachines(projA)).find((m) => m.id === machineId).dev_priority === 7, 'fleet payload for A carries dev_priority 7');
  ok((await listMachines(projB)).find((m) => m.id === machineId).dev_priority === 0, 'fleet payload for B carries dev_priority 0');

  console.log('\n── the machine-wide facts are NOT per project ──');
  const noProj = (await listMachines()).find((m) => m.id === machineId);
  ok(!('pool_size' in noProj),
     'listMachines() with no project exposes NO pool_size — a machine-wide pool no longer exists');
  ok(!('dev_priority' in noProj),
     'listMachines() with no project exposes NO dev_priority — a machine-wide priority no longer exists');
  ok((await rowFor(projA)).max_xells === 3 && (await rowFor(projB)).max_xells === 3,
     'max_xells (the cap) is the SAME number in every project view — it is machine-wide');

  console.log('\n── the cap counts live xells across ALL projects (shared) ──');
  ok(await liveXellCount(ctx) === 0, 'no live xells on the machine yet');
  await mkLiveXell(projA, `zt-xa-${tag}`);
  ok(await liveXellCount(ctx) === 1, "one live xell (project A) ⇒ count 1");
  await mkLiveXell(projB, `zt-xb-${tag}`);
  ok(await liveXellCount(ctx) === 2,
     "a SECOND project's live xell on the same host counts too ⇒ 2: the cap is shared across projects");
} finally {
  // Tear down every seeded row (children first; machine_pool cascades with the machine).
  if (machineId) await q(`DELETE FROM container WHERE docker_ctx=$1`, [ctx]).catch(() => {});
  for (const p of [projA, projB]) if (p) {
    await q(`DELETE FROM xell WHERE project_id=$1`, [p]).catch(() => {});
    await q(`DELETE FROM xource WHERE project_id=$1`, [p]).catch(() => {});
  }
  if (machineId) await q(`DELETE FROM machine WHERE id=$1`, [machineId]).catch(() => {});
  for (const p of [projA, projB]) if (p) await q(`DELETE FROM project WHERE id=$1`, [p]).catch(() => {});
  await pool.end().catch(() => {});
}

console.log(`\n${failures === 0 ? 'ALL PASSED ✓' : `${failures} FAILURE(S) ✗`}`);
process.exit(failures === 0 ? 0 : 1);
