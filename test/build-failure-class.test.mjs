// Ticket "make zee build return actionable failures": classify a failed build as INFRA (host/
// daemon/network/context — NOT the zee's code, retrying will not help) or CODE (traces to the
// worktree), persist the class on the container row, and make a prod-tier container REFUSE `zee
// build` with a sentence naming the ship gate (PROD-SHIP).
//
// The mardale-prod incident (ticket #178): a worker retried `zee build webapp --wait` 40 times
// while the host failed to create a docker network ('all predefined address pools have been fully
// subnetted'). The zee's image built fine; the infra could not create the network; nothing told the
// zee the failure was not its code. This test pins the classifier and the refusals so the verb
// answers with a class + next step instead of sending a zee into a retry loop.
//
// Covered here (against a real postgres — DATABASE_URL — so the column from migration 233 is
// present; no docker):
//   • classifyBuildFailure returns INFRA for host/daemon/network/context errors
//   • classifyBuildFailure returns CODE for worktree errors (and defaults to CODE when unknown)
//   • buildFailureNextStep: INFRA says "NOT YOUR CODE" and names the #178 ticket for pool exhaustion
//   • buildFailureNextStep: CODE points at the worktree
//   • buildContainer REFUSES a prod-tier container with a sentence naming the ship gate
//   • a failed finalize persists last_build_error_class; getBuildStatus returns it + the next step
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

const { q, one, pool } = await import('../server/src/db/pool.js');
const { classifyBuildFailure, buildFailureNextStep, isAddressPoolExhaustion, buildContainer, getBuildStatus } =
  await import('../server/src/lib/build.js');

const tag = randomUUID().slice(0, 8).replace(/[^a-z0-9]/g, 'a');
const tmp = mkdtempSync(join(tmpdir(), `bfc-${tag}-`));
const created = { projects: [], xells: [], containers: [] };

try {
  console.log('\n── 1. classifyBuildFailure: INFRA (host/daemon/network/context) ──');
  ok(classifyBuildFailure('ERROR: failed to create network for service "server": all predefined address pools have been fully subnetted') === 'INFRA',
     'docker address-pool exhaustion → INFRA (the mardale #178 incident)');
  ok(classifyBuildFailure('Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?') === 'INFRA',
     'daemon unreachable → INFRA');
  ok(classifyBuildFailure('docker: context "mardale-prod" not found') === 'INFRA',
     'missing docker context → INFRA');
  ok(classifyBuildFailure('no space left on device') === 'INFRA',
     'host disk exhaustion → INFRA');
  ok(classifyBuildFailure('dial tcp 10.2.0.16:443: connect: connection refused') === 'INFRA',
     'network/transport refused → INFRA');
  ok(classifyBuildFailure('pull access denied for zeehive/foo, repository does not exist') === 'INFRA',
     'registry access denied → INFRA');
  ok(classifyBuildFailure('') === null, 'empty error → null (not classified)');

  console.log('\n── 2. classifyBuildFailure: CODE (worktree) ──');
  ok(classifyBuildFailure('compose file not found: docker-compose.spinoff.yml (is docker-compose.spinoff.yml on this branch?)') === 'CODE',
     'compose file missing → CODE');
  ok(classifyBuildFailure('env file not found: /main/.env (the main checkout must have its .env)') === 'CODE',
     'env file missing → CODE');
  ok(classifyBuildFailure('src/App.tsx:12:5 - error TS2322: Type string is not assignable to type number') === 'CODE',
     'tsc compile error → CODE');
  ok(classifyBuildFailure('ERROR: Failed to compile. Module not found: ./App.jsx') === 'CODE',
     'vite/webpack compile error → CODE');
  ok(classifyBuildFailure('npm ERR! code ERESOLVE\nnpm ERR! Could not resolve dependency') === 'CODE',
     'npm dependency error → CODE');
  ok(classifyBuildFailure('some unknown build failure that matches nothing') === 'CODE',
     'unmatched failure defaults to CODE (never wrongly claim infra)');

  console.log('\n── 3. buildFailureNextStep: INFRA is actionable and names the ticket ──');
  const infra = buildFailureNextStep('INFRA', 'all predefined address pools have been fully subnetted', { docker_ctx: 'mardale-prod' });
  ok(/INFRA — NOT YOUR CODE/.test(infra), 'INFRA next step says "INFRA — NOT YOUR CODE"');
  ok(/not on your change/.test(infra), 'INFRA next step says the failure is not the zee\'s change');
  ok(/mardale-prod/.test(infra), 'INFRA next step names the machine/context');
  ok(/#178/.test(infra), 'INFRA next step references the existing #178 ticket for pool exhaustion');
  ok(/Retrying will not help/.test(infra), 'INFRA next step says retrying will not help');
  ok(isAddressPoolExhaustion('all predefined address pools have been fully subnetted'), 'isAddressPoolExhaustion detects the #178 pattern');

  const infraGeneric = buildFailureNextStep('INFRA', 'Cannot connect to the Docker daemon', { docker_ctx: 'ugreen-nas' });
  ok(/File a ticket for the infra team/.test(infraGeneric), 'generic INFRA next step tells the zee to file a ticket');
  ok(!/#178/.test(infraGeneric), 'generic INFRA does NOT hardcode the #178 ticket');

  console.log('\n── 4. buildFailureNextStep: CODE points at the worktree ──');
  const code = buildFailureNextStep('CODE', 'src/App.tsx:12:5 - error TS2322', { docker_ctx: 'default' });
  ok(/CODE — this looks like a problem in YOUR worktree/.test(code), 'CODE next step says the problem is in the worktree');
  ok(/Fix the error below and rebuild/.test(code), 'CODE next step says to fix and rebuild');

  console.log('\n── 5. PROD-SHIP: a prod-tier container refuses zee build ──');
  // Fixtures: project + xell + a PROD-tier per-xell container. buildContainer's prod check fires
  // BEFORE any docker/worktree work, so this needs no docker.
  const { spawnSync } = await import('node:child_process');
  spawnSync('git', ['init'], { cwd: tmp, encoding: 'utf8' });
  spawnSync('git', ['config', 'user.email', 'test@zeehive'], { cwd: tmp });
  spawnSync('git', ['config', 'user.name', 'test'], { cwd: tmp });
  writeFileSync(join(tmp, 'README'), 'bfc');
  spawnSync('git', ['add', '.'], { cwd: tmp });
  spawnSync('git', ['commit', '-m', 'init'], { cwd: tmp });

  const proj = await one(
    `INSERT INTO project (name, repo_root, main_branch, db_user, db_name)
     VALUES ($1, $2, 'main', 'zeehive', 'zeehive') RETURNING id`,
    [`bfc_${tag}`, tmp]);
  created.projects.push(proj.id);

  const xource = await one(
    `INSERT INTO xource (project_id, ref) VALUES ($1, 'main') RETURNING id`,
    [proj.id]);
  created.xources = [xource.id];

  const xell = await one(
    `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status, is_pooled)
     VALUES ($1, $2, $3, $4, $5, 'claimed', false) RETURNING id`,
    [proj.id, xource.id, `bfc-${tag}`, `spinoff/bfc-${tag}`, tmp]);
  created.xells.push(xell.id);

  const prod = await one(
    `INSERT INTO container (project_id, role, tier, isolation, name, health, owner_xell_id, image_tag, docker_ctx)
     VALUES ($1, 'server', 'prod', 'per-xell', $2, 'down', $3, 'zeehive-spin-server:x', 'default')
     RETURNING id, name`,
    [proj.id, `bfc_prod_srv_${tag}`, xell.id]);
  created.containers.push(prod.id);
  ok(!!prod.id, `fixture prod-tier container ${prod.name}`);

  let refused = null;
  try { await buildContainer(prod.id, {}); } catch (e) { refused = e.message; }
  ok(!!refused, 'buildContainer REFUSES a prod-tier container');
  ok(/PRODUCTION container/.test(refused || ''), 'refusal names the container as production');
  ok(/ship gate/.test(refused || ''), 'refusal names the ship gate');
  ok(/zee ship/.test(refused || ''), 'refusal names `zee ship` as the only path');

  console.log('\n── 6. persistence + status: class rides last_build_error ──');
  // A spinoff-tier container (buildable) so getBuildStatus can list it. Simulate what the build
  // finalize writes (the real finalize needs docker; the UPDATE is the contract we assert here).
  const c = await one(
    `INSERT INTO container (project_id, role, tier, isolation, name, health, owner_xell_id, image_tag, docker_ctx)
     VALUES ($1, 'server', 'spinoff', 'per-xell', $2, 'down', $3, 'zeehive-spin-server:x', 'default')
     RETURNING id, name`,
    [proj.id, `bfc_srv_${tag}`, xell.id]);
  created.containers.push(c.id);

  const col = await one(
    `SELECT 1 AS ok FROM information_schema.columns
      WHERE table_name='container' AND column_name='last_build_error_class'`);
  ok(!!col, 'container.last_build_error_class column exists (migration 233 applied)');

  const errText = 'ERROR: failed to create network for service "server": all predefined address pools have been fully subnetted';
  await one(
    `UPDATE container SET health='down', last_build_error=$2, last_build_error_class=$3 WHERE id=$1 RETURNING *`,
    [c.id, errText, classifyBuildFailure(errText)]);

  const st = await getBuildStatus(xell.id);
  const row = st.containers.find((x) => x.id === c.id);
  ok(!!row, 'getBuildStatus lists the fixture container');
  ok(row?.last_build_error_class === 'INFRA', 'getBuildStatus returns last_build_error_class=INFRA');
  ok(/INFRA — NOT YOUR CODE/.test(row?.last_build_error_next_step || ''),
     'getBuildStatus returns last_build_error_next_step with the INFRA verdict');
  ok(/all predefined address pools have been fully subnetted/.test(row?.last_build_error || ''),
     'the raw docker line is still on the row (evidence is never replaced)');

} finally {
  for (const id of created.containers) await q(`DELETE FROM container WHERE id=$1`, [id]).catch(() => {});
  for (const id of created.xells) await q(`DELETE FROM xell WHERE id=$1`, [id]).catch(() => {});
  for (const id of created.projects) await q(`DELETE FROM project WHERE id=$1`, [id]).catch(() => {});
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
  await pool.end().catch(() => {});
}

console.log(fail ? `\n✗ ${fail} failure(s)` : '\n✓ all passed');
process.exit(fail ? 1 : 0);
