// PROVISION COMPOSE-SPINOFF — the Zeehive process→compose cutover, at the provisioning seam
// (docs/compose-authorship-decision-record.md). Three things pinned, against the REAL repo
// zeehive.yml (the actual new shape, not a fixture imitation):
//
//   1. A xell of the new shape provisions with docker_ctx STAMPED on its server/webapp rows —
//      on whatever machine was asked for — which is precisely what makes Zeehive xells
//      machine-placeable ("other machines are not provisioning xells" was structural, and this
//      is the structure changing). The per-xell db ROW exists too (compose-era: row only, the
//      container comes up with the stack), with a TCP conn_ref the cage can actually dial.
//   2. THE ROW OUTRANKS THE MANIFEST at build time: an OLD process-era xell (image_tag NULL,
//      docker_ctx NULL) still takes the process path under the new manifest — the cutover is
//      per-xell, not a fleet-wide cliff that strands live xells.
//   3. A new-shape row takes the docker path (no runner:'process' marker in the verdict).
import { randomUUID } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.PROVISION_MODE = 'simulate';
process.env.BUILD_MODE = 'simulate';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { q, one, pool } = await import('../server/src/db/pool.js');
const { provisionXell } = await import('../server/src/lib/provision.js');
const { buildContainer } = await import('../server/src/lib/build.js');
const { loadManifest } = await import('../server/src/lib/manifest.js');

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };

const tag = randomUUID().slice(0, 8);
const ctx = `zt-cs-ctx-${tag}`;
let machineId = null, projId = null;
const manifest = loadManifest(ROOT).manifest;

try {
  machineId = (await one(
    `INSERT INTO machine (key, docker_ctx, host_ip, max_xells, enabled)
     VALUES ($1,$2,'10.9.0.5',9,true) RETURNING id`, [`zt-cs-${tag}`, ctx])).id;
  projId = (await one(
    `INSERT INTO project (name, repo_root, main_branch, manifest, compose_spinoff)
     VALUES ($1,$2,'main',$3::jsonb,'docker-compose.spinoff.yml') RETURNING id`,
    [`zt-cs-proj-${tag}`, `/tmp/zt-cs-${tag}`, JSON.stringify(manifest)])).id;
  await q(`INSERT INTO xource (project_id, ref) VALUES ($1,'main')`, [projId]);
  await q(`INSERT INTO pool_config (project_id, target_ready, default_db_coupling)
           VALUES ($1,0,'db-isolated')`, [projId]);
  await q(`INSERT INTO machine_pool (machine_id, project_id, pool_size, dev_priority) VALUES ($1,$2,0,5)`,
    [machineId, projId]);

  console.log('\n── a new-shape Zeehive xell provisions ON the asked-for machine ──');
  const x = await provisionXell({ projectId: projId, mode: 'simulate', machineCtx: ctx });
  const rows = await q(
    `SELECT role, name, image_tag, docker_ctx, host, host_port, conn_ref, compose_file
       FROM container WHERE owner_xell_id=$1 ORDER BY role`, [x.id]);
  const byRole = Object.fromEntries(rows.map((r) => [r.role, r]));
  ok(byRole.server?.docker_ctx === ctx && byRole.webapp?.docker_ctx === ctx,
     `server+webapp rows carry docker_ctx='${ctx}' — machine-placeable, countable, cappable`);
  // naming derives from the PROJECT NAME (defaultNaming) — this fixture is named zt-cs-proj-…,
  // so the tag is ztcsproj…-spin-server:<slug>; the real Zeehive project yields zeehive-spin-….
  ok(byRole.server?.image_tag === `ztcsproj${tag}-spin-server:${x.slug}`,
     `the server row records its per-xell image (got ${byRole.server?.image_tag})`);
  ok(byRole.server?.compose_file === 'docker-compose.spinoff.yml',
     'the generated compose file is stamped on the row (the build path drives it from here)');
  ok(!!byRole.db, 'the per-xell db ROW exists (compose-era: row now, container with the stack)');
  ok(byRole.db?.docker_ctx === ctx, `…on the same machine ('${byRole.db?.docker_ctx}')`);
  ok(/^postgresql:\/\/zeehive@10\.9\.0\.5:\d+\/zeehive$/.test(byRole.db?.conn_ref || ''),
     `…with a TCP conn_ref the cage can dial (got ${byRole.db?.conn_ref}) — never a compose-network alias`);

  console.log('\n── the row outranks the manifest: an OLD process xell keeps its process path ──');
  const oldXell = await one(
    `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status, is_production)
     SELECT $1, id, $2, $3, $4, 'working', false FROM xource WHERE project_id=$1 RETURNING id`,
    [projId, `zt-cs-old-${tag}`, `spinoff/zt-cs-old-${tag}`, `/tmp/zt-cs-old-${tag}`]);
  const procRow = await one(
    `INSERT INTO container (project_id, role, tier, isolation, name, image_tag, docker_ctx, host_port, owner_xell_id, health)
     VALUES ($1,'server','spinoff','per-xell',$2,NULL,NULL,4899,$3,'down') RETURNING id`,
    [projId, `zt_cs_old_srv_${tag}`, oldXell.id]);
  const procVerdict = await buildContainer(procRow.id, {});
  ok(procVerdict?.runner === 'process',
     `process-era row (image_tag NULL, docker_ctx NULL) still builds as a PROCESS under the compose manifest (got ${JSON.stringify({ runner: procVerdict?.runner, status: procVerdict?.status })})`);

  console.log('\n── a new-shape row takes the docker path ──');
  const newVerdict = await buildContainer(byRole.server ? rows.find((r) => r.role === 'server') && (await one(
    `SELECT id FROM container WHERE owner_xell_id=$1 AND role='server'`, [x.id])).id : null, {});
  ok(newVerdict?.status === 'building' && newVerdict?.runner === undefined,
     `compose-shaped row builds via docker/compose, not as a process (got ${JSON.stringify({ runner: newVerdict?.runner, status: newVerdict?.status })})`);
} finally {
  if (projId) {
    await q(`DELETE FROM xell_uses_container WHERE xell_id IN (SELECT id FROM xell WHERE project_id=$1)`, [projId]).catch(() => {});
    await q(`DELETE FROM container WHERE project_id=$1`, [projId]).catch(() => {});
    await q(`DELETE FROM xell WHERE project_id=$1`, [projId]).catch(() => {});
    await q(`DELETE FROM xource WHERE project_id=$1`, [projId]).catch(() => {});
    await q(`DELETE FROM pool_config WHERE project_id=$1`, [projId]).catch(() => {});
    await q(`DELETE FROM machine_pool WHERE project_id=$1`, [projId]).catch(() => {});
    await q(`DELETE FROM project WHERE id=$1`, [projId]).catch(() => {});
  }
  if (machineId) await q(`DELETE FROM machine WHERE id=$1`, [machineId]).catch(() => {});
  await pool.end().catch(() => {});
}

console.log(failures ? `\n${failures} FAILURE(S) ✗` : '\nALL PASSED ✓');
process.exit(failures ? 1 : 0);
