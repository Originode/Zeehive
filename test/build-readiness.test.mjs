// MACHINE × PROJECT BUILD-READINESS (ticket #173) — "can a build actually work HERE?", answered
// before a human sets the pool knob blind.
//
// Today omnibiz is pooled on 'local' where it has never built once, nothing records why, and a
// machine explicitly marked can_build=false (ugreen-nas) silently builds on itself when no
// registry exists (provision.js ~850-861, a console.error nobody reads). This test drives the
// READ-ONLY resolver — lib/build-readiness.js probeBuildReadiness — with a STUBBED docker
// adapter (the same injection the module exists to make possible), so the probe logic runs
// without a docker daemon.
//
// Covered here (against a real postgres — DATABASE_URL — for the meta-DB facts, real machine/
// project/container rows; the docker half is the stub):
//   • a machine that CAN build, compose resolves, no requires, shared dev db present
//     → status 'ok', every check passes
//   • a declared requires network missing on the daemon
//     → status 'missing', error NAMES the failing check (requires-present)
//   • an unreachable context
//     → status 'unknown', error NAMES context-reachable, and the probe never throws
//   • can_build=false with a build-capable machine but NO registry
//     → status 'missing', error NAMES registry-for-handoff (the ticket's silent degradation)
//   • can_build=false WITH a registry (project.registry)
//     → the handoff is possible and the pair reads ok
//   • the registry precedence matches resolveBuildTarget (project.registry, else SPINOFF_REGISTRY)
//   • the probe is READ-ONLY: no rows are written beyond the fixtures the test itself inserts
process.env.PROVISION_MODE = 'simulate';
// config.registry is read at module load — leave the global unset so the no-registry cases
// below see "no registry configured" exactly as today's deployment does.
process.env.SPINOFF_REGISTRY = '';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

const { q, one, pool } = await import('../server/src/db/pool.js');
const { probeBuildReadiness, registryForProject } = await import('../server/src/lib/build-readiness.js');

// ── the stubbed docker adapter ──────────────────────────────────────────────
// Dispatch on the first docker arg, like the real adapter's call sites. `reachable:false`
// makes the context probe answer 'unknown' (docker could not run); missing networks/volumes
// make the requires probe fail; composeOk:false makes the compose probe fail.
const makeDocker = ({ reachable = true, networks = new Set(), volumes = new Set(), composeOk = true } = {}) =>
  async (ctx, args) => {
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
      const name = args[2];   // network inspect <name> --format …
      return networks.has(name)
        ? { status: 0, stdout: `${name}\n`, stderr: '' }
        : { status: 1, stdout: '', stderr: `network ${name} not found` };
    }
    if (cmd === 'volume') {
      const name = args[2];   // volume inspect <name>
      return volumes.has(name)
        ? { status: 0, stdout: `${name}\n`, stderr: '' }
        : { status: 1, stdout: '', stderr: `volume ${name} not found` };
    }
    if (cmd === 'inspect') {  // alias detail — no attached containers in the stubs
      return { status: 0, stdout: '', stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };

// ── fixtures ─────────────────────────────────────────────────────────────────
const tag = randomUUID().slice(0, 8).replace(/[^a-z0-9]/g, '');
const repo = mkdtempSync(join(tmpdir(), `br-${tag}-`));
writeFileSync(join(repo, 'docker-compose.spinoff.yml'),
  'services:\n  server:\n    image: example:latest\n  webapp:\n    image: example:latest\n');

const GREEN_CTX = `zt-green-${tag}`;
const MISS_CTX = `zt-miss-${tag}`;
const UNK_CTX = `zt-unk-${tag}`;
const NOBUILD_CTX = `zt-nobuild-${tag}`;
const BUILDER_CTX = `zt-builder-${tag}`;

const createdMachines = [];
const createdProjects = [];

const insProject = async (name, manifest, registry = null) => {
  const p = (await one(
    `INSERT INTO project (name, repo_root, db_user, db_name, manifest, registry)
       VALUES ($1,$2,'zeehive','zeehive',$3,$4) RETURNING id`,
    [name, repo, JSON.stringify(manifest), registry])).id;
  createdProjects.push(p);
  return p;
};
const insMachine = async (key, ctx, canBuild) => {
  const m = (await one(
    `INSERT INTO machine (key, docker_ctx, can_build, enabled) VALUES ($1,$2,$3,true) RETURNING id`,
    [key, ctx, canBuild])).id;
  createdMachines.push(m);
  return m;
};
const insSharedDevDb = async (projectId, ctx, suffix) => {
  await q(
    `INSERT INTO container (project_id, role, tier, isolation, name, docker_ctx, health)
       VALUES ($1,'db','dev','shared',$2,$3,'up')`,
    [projectId, `br_${tag}_${suffix}_db`, ctx]);
};

let pGreen, pMissing, pUnknown, pNoReg, pNoReg2;
let mGreen, mMissing, mUnknown, mNoBuild;
try {
  pGreen = await insProject(`br-green-${tag}`, {}, null);
  pMissing = await insProject(`br-missing-${tag}`, { tiers: { spinoff: { requires: { networks: ['zt-net'] } } } }, null);
  pUnknown = await insProject(`br-unknown-${tag}`, {}, null);
  pNoReg = await insProject(`br-noreg-${tag}`, {}, null);
  pNoReg2 = await insProject(`br-noreg2-${tag}`, {}, `localhost:5000/${tag}`);
  await insMachine(`br-green-${tag}`, GREEN_CTX, true);
  await insMachine(`br-missing-${tag}`, MISS_CTX, true);
  await insMachine(`br-unknown-${tag}`, UNK_CTX, true);
  await insMachine(`br-nobuild-${tag}`, NOBUILD_CTX, false);
  await insMachine(`br-builder-${tag}`, BUILDER_CTX, true);
  await insSharedDevDb(pGreen, GREEN_CTX, 'green');
  await insSharedDevDb(pMissing, MISS_CTX, 'miss');
  await insSharedDevDb(pUnknown, UNK_CTX, 'unk');
  await insSharedDevDb(pNoReg, NOBUILD_CTX, 'nobuild');
  await insSharedDevDb(pNoReg2, NOBUILD_CTX, 'noreg2');

  const rowFor = async (table, id) => (await one(`SELECT * FROM ${table} WHERE id=$1`, [id]));
  const mach = (id) => rowFor('machine', id);
  const proj = (id) => rowFor('project', id);

  // ── green ─────────────────────────────────────────────────────────────────
  console.log('\n── a machine that CAN build this project → ok, every check passes ──');
  const greenDocker = makeDocker({ reachable: true, networks: new Set(), composeOk: true });
  const green = await probeBuildReadiness(await mach(mGreen = (await one(`SELECT id FROM machine WHERE key=$1`, [`br-green-${tag}`])).id), await proj(pGreen), { docker: greenDocker });
  ok(green.status === 'ok', `status ok [${green.status}]`);
  ok(green.error === null, `no error [${green.error}]`);
  ok(green.checks.every((c) => c.ok), 'every check passes');
  ok(green.checks.some((c) => c.check === 'context-reachable' && c.ok), 'context-reachable ran and passed');
  ok(green.checks.some((c) => c.check === 'compose-resolves' && c.ok), 'compose-resolves ran and passed');
  ok(green.checks.some((c) => c.check === 'requires-present' && c.skipped), 'requires-present SKIPPED (manifest declares none), saying why');
  ok(green.checks.some((c) => c.check === 'shared-dev-db' && c.ok), 'shared-dev-db ran and passed');
  ok(green.checks.some((c) => c.check === 'registry-for-handoff' && c.skipped), 'registry-for-handoff SKIPPED (can_build=true)');

  // ── missing prerequisite ──────────────────────────────────────────────────
  console.log('\n── a declared requires network is missing → missing, check NAMED ──');
  const missDocker = makeDocker({ reachable: true, networks: new Set(), composeOk: true });   // zt-net absent
  const miss = await probeBuildReadiness(await mach(mMissing = (await one(`SELECT id FROM machine WHERE key=$1`, [`br-missing-${tag}`])).id), await proj(pMissing), { docker: missDocker });
  ok(miss.status === 'missing', `status missing [${miss.status}]`);
  ok(/requires-present/.test(miss.error || ''), `error NAMES requires-present [${miss.error}]`);
  ok(/zt-net/.test(miss.error || ''), `error names the missing network [${miss.error}]`);
  const reqCheck = miss.checks.find((c) => c.check === 'requires-present');
  ok(reqCheck?.ok === false && reqCheck?.unknown === false, 'the requires check is a definite FAIL, not unknown');

  // ── unreachable context ───────────────────────────────────────────────────
  console.log('\n── an unreachable context → unknown, never green, never throws ──');
  const unkDocker = makeDocker({ reachable: false });
  let unk = null, unkThrew = null;
  try { unk = await probeBuildReadiness(await mach(mUnknown = (await one(`SELECT id FROM machine WHERE key=$1`, [`br-unknown-${tag}`])).id), await proj(pUnknown), { docker: unkDocker }); }
  catch (e) { unkThrew = e; }
  ok(!unkThrew, 'the probe never throws for an unreachable context');
  ok(unk?.status === 'unknown', `status unknown [${unk?.status}]`);
  ok(/context-reachable/.test(unk?.error || ''), `error NAMES context-reachable [${unk?.error}]`);
  ok(/connection refused/.test(unk?.error || ''), `error carries the docker reason [${unk?.error}]`);
  const ctxCheck = unk?.checks.find((c) => c.check === 'context-reachable');
  ok(ctxCheck?.ok === false && ctxCheck?.unknown === true, 'the context check is UNKNOWN (could not run), not a cheerful green');

  // ── no-registry with a can_build machine to hand off to ───────────────────
  console.log('\n── can_build=false + no registry → missing, the silent degradation NAMED ──');
  const noRegDocker = makeDocker({ reachable: true, networks: new Set(), composeOk: true });
  const noReg = await probeBuildReadiness(await mach(mNoBuild = (await one(`SELECT id FROM machine WHERE key=$1`, [`br-nobuild-${tag}`])).id), await proj(pNoReg), { docker: noRegDocker });
  ok(noReg.status === 'missing', `status missing [${noReg.status}]`);
  ok(/registry-for-handoff/.test(noReg.error || ''), `error NAMES registry-for-handoff [${noReg.error}]`);
  ok(/no registry is configured/.test(noReg.error || ''), `error says why — no registry configured [${noReg.error}]`);

  // ── the same machine WITH a project registry → the handoff can work ───────
  console.log('\n── can_build=false WITH a project registry → handoff possible, pair reads ok ──');
  const regOk = await probeBuildReadiness(await mach(mNoBuild), await proj(pNoReg2), { docker: noRegDocker });
  const regCheck = regOk.checks.find((c) => c.check === 'registry-for-handoff');
  ok(regCheck?.ok === true, `registry-for-handoff passes [${regCheck?.detail}]`);
  ok(regOk.status === 'ok', `and the pair reads ok [${regOk.status}]`);

  // ── registry precedence (project.registry, else SPINOFF_REGISTRY) ─────────
  console.log('\n── the registry rule matches resolveBuildTarget (project.registry, else SPINOFF_REGISTRY) ──');
  ok(registryForProject({ registry: null }) === null, 'no project registry and no global → null (split unavailable)');
  ok(registryForProject({ registry: '' }) === null, 'empty project registry → null (falls through, still null)');
  ok(registryForProject({ registry: '  localhost:5000/x  ' }) === 'localhost:5000/x', 'project registry trimmed');
  // config.registry is read at module load, so the GLOBAL fallback is asserted in a subprocess
  // that starts fresh with SPINOFF_REGISTRY set — the same load order the real server has.
  const sub = spawnSync(process.execPath, ['--input-type=module', '-e', `
    process.env.SPINOFF_REGISTRY = 'localhost:5000/global';
    const { registryForProject } = await import('./server/src/lib/build-readiness.js');
    console.log(JSON.stringify({ g: registryForProject({ registry: null }), own: registryForProject({ registry: 'proj:5000/x' }) }));
  `], { encoding: 'utf8', cwd: process.cwd(), env: process.env });
  let subRes = null; try { subRes = JSON.parse((sub.stdout || '').trim().split('\n').pop()); } catch { /* not JSON */ }
  ok(sub.status === 0 && subRes?.g === 'localhost:5000/global',
     `global SPINOFF_REGISTRY is the fallback [${subRes?.g}]`);
  ok(subRes?.own === 'proj:5000/x', 'project own still wins over the global');

  console.log(fail ? `\n${fail} FAILED` : '\nall good');
} catch (e) {
  console.error('TEST ERROR:', e);
  fail++;
} finally {
  // clean up what THIS test created, whatever happened (house rule: tests clean up in a finally)
  try {
    if (createdProjects.length) {
      await q(`DELETE FROM container WHERE project_id = ANY($1::uuid[])`, [createdProjects]);
      await q(`DELETE FROM project WHERE id = ANY($1::uuid[])`, [createdProjects]);
    }
    if (createdMachines.length) await q(`DELETE FROM machine WHERE id = ANY($1::uuid[])`, [createdMachines]);
  } catch (e) { console.error('CLEANUP ERROR:', e); }
  await pool.end();
  rmSync(repo, { recursive: true, force: true });
}
process.exit(fail ? 1 : 0);
