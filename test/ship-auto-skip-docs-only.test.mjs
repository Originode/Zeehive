// AUTO-SHIP MUST NOT FIRE ON A DIFF THAT TOUCHES ONLY docs/** — ticket #33/#64.
//
// Auto-approve (project.auto_approve_ship) used to fire unconditionally, so a docs-only landing
// restarted the live orchestrator for a payload that is not even in the prod images (neither
// Dockerfile.server nor Dockerfile.web copies docs/). This proves the docs-only skip against the
// REAL requestShip, with a real git repo and a real deployed sha:
//   1. a docs-only diff → the request stays PENDING (a human can still ship it), and the answer
//      and ship log say the auto-ship was skipped — never silent;
//   2. a diff touching server/ (a mixed docs+server diff) → auto-approve still fires;
//   3. no deployed sha yet (the diff is uncomputable) → auto-approve still fires — failing toward
//      shipping is the safe side: a docs-only restart is cheap, an undeployed fix is not;
//   4. deployed == candidate (an empty diff) → auto-approve still fires — empty is not "docs-only".
//
// The REVIEW GATE (ticket #79) is deliberately satisfied in scenarios 2-4 so this test isolates the
// docs-only skip: every commit the auto-approving ship would carry has a recorded review verdict
// (ticket #56), and a SHIPPED ship_request establishes the payload's "from" so the payload is a
// real commit range. The review gate's own behaviour — an unread commit holds the auto-ship — is
// proven separately in test/ship-auto-review-gate.test.mjs.
// Everything it creates is torn down in a finally.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }
process.env.SHIP_MODE = 'simulate';               // never touch anything real
process.env.SHIP_REAPER_ENABLED = 'false';        // no background ticks racing us
process.env.LANDING_PAD_ENABLED = 'false';

const { q, one, pool } = await import('../server/src/db/pool.js');
const { requestShip } = await import('../server/src/queenzee/shipgate.js');

let fail = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) fail++; };
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmp = mkdtempSync(join(tmpdir(), 'shipdocs-'));
const PID = '00000000-0000-4000-8000-00000000d111';   // fixed ids so cleanup is total even on crash
const IDS = { xource: '00000000-0000-4000-8000-00000000d222',
  site: '00000000-0000-4000-8000-00000000d333' };

async function cleanup() {
  try { await q(`DELETE FROM deploy_lock WHERE project_id=$1`, [PID]); } catch { /* */ }
  try { await q(`DELETE FROM ship_request WHERE project_id=$1`, [PID]); } catch { /* */ }
  try { await q(`DELETE FROM container WHERE project_id=$1`, [PID]); } catch { /* */ }
  try { await q(`DELETE FROM xell WHERE project_id=$1`, [PID]); } catch { /* */ }
  try { await q(`DELETE FROM deploy_site WHERE project_id=$1`, [PID]); } catch { /* */ }
  try { await q(`DELETE FROM xource WHERE project_id=$1`, [PID]); } catch { /* */ }
  try { await q(`DELETE FROM project WHERE id=$1`, [PID]); } catch { /* */ }
}

try {
  await cleanup();   // drop rows a prior crashed run left

  // ── a real git repo + one worktree ──
  const repo = join(tmp, 'repo');
  mkdirSync(join(repo, 'server'), { recursive: true });
  mkdirSync(join(repo, 'docs'), { recursive: true });
  mkdirSync(join(repo, 'web'), { recursive: true });
  writeFileSync(join(repo, 'server', 'foo.js'), 'export const x = 1;\n');
  writeFileSync(join(repo, 'docs', 'guide.md'), '# guide\n');
  writeFileSync(join(repo, 'web', 'index.html'), '<html></html>\n');
  git(repo, 'init', '-q', '-b', 'master');
  git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'base');
  const base = git(repo, 'rev-parse', 'HEAD');
  const wt = join(tmp, 'wt');
  git(repo, 'worktree', 'add', '-q', '-b', 'spinoff/shipdocs', wt, 'master');

  // ── stub build script: reports the shipped sha (arg $6 = buildRef = ship.commit) as the new head ──
  const build = join(tmp, 'build.sh');
  writeFileSync(build,
    '#!/usr/bin/env bash\n'
    + 'echo \'{"ok":true,"head":"\'"$6"\'","method":"stub"}\'\n');
  chmodSync(build, 0o755);

  // ── seed the isolated project with AUTO-APPROVE ON ──
  await q(
    `INSERT INTO project (id, name, repo_root, main_branch, auto_approve_ship)
       VALUES ($1,'shipdocs-test',$2,'master',true)`, [PID, repo]);
  await q(`INSERT INTO xource (id, project_id, ref) VALUES ($1,$2,'master')`, [IDS.xource, PID]);
  await q(`INSERT INTO deploy_site (id, project_id, key, tier, is_default) VALUES ($1,$2,'local','prod',true)`,
    [IDS.site, PID]);
  const containerId = (await one(
    `INSERT INTO container (project_id, role, tier, isolation, name, build_script, site_id, health)
       VALUES ($1,'server','prod','shared','docs-prod-server',$2,$3,'up') RETURNING id`,
    [PID, build, IDS.site])).id;
  const xell = await one(
    `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status, is_pooled)
       VALUES ($1,$2,'docs-a','spinoff/shipdocs',$3,'idle',false) RETURNING *`,
    [PID, IDS.xource, wt]);

  const setDeployed = (sha) =>
    q(`UPDATE container SET last_build_commit=$2, last_built_at=now() WHERE id=$1`, [containerId, sha]);
  const commitAll = (msg) => { git(repo, 'add', '-A'); git(repo, 'commit', '-qm', msg); return git(repo, 'rev-parse', 'HEAD'); };
  const shipRow = (id) => one(`SELECT * FROM ship_request WHERE id=$1`, [id]);
  const freeLock = () => q(`DELETE FROM deploy_lock WHERE project_id=$1`, [PID]);
  // A SHIPPED ship at `sha` establishes the payload's "from" (lastShippedForTarget) — without one
  // the payload reads as a FIRST ship, whose whole history is unenumerated and thus never
  // auto-approves (ticket #79). Status='shipped' does not trip the one-open-ship-per-xell index.
  // site_id is the DEFAULT site (IDS.site) so it matches the site a site-less requestShip resolves.
  const shipShipped = (sha) =>
    q(`INSERT INTO ship_request (project_id, xell_id, site_id, commit, reason, status, requested_at, decided_at, decided_by, finished_at)
         VALUES ($1,$2,$3,$4,'previous shipped ship','shipped',now()-interval '2 hours',now()-interval '2 hours','human@console',now()-interval '2 hours')`,
      [PID, xell.id, IDS.site, sha]);
  // A recorded review verdict (ticket #56) — the fact someone READ the diff. Satisfies the review
  // gate so this test can isolate the docs-only skip.
  const reviewCommit = (sha, verdict = 'clean') =>
    q(`INSERT INTO review (project_id, xell_id, reviewer, commit_sha, verdict, findings_count, report)
         VALUES ($1,$2,$3,$4,$5,0,NULL)`, [PID, xell.id, xell.slug, sha, verdict]);
  // Close any open ship from a prior scenario so the one-open-ship-per-xell invariant is clear.
  const closeOpenShips = () =>
    q(`UPDATE ship_request SET status='rejected', decided_at=now(), decided_by='test@cleanup'
         WHERE xell_id=$1 AND status IN ('pending','approved','shipping')`, [xell.id]);
  const settle = async (id, tries = 60) => {
    for (let i = 0; i < tries; i++) {
      const r = await shipRow(id);
      if (['shipped', 'failed', 'rejected'].includes(r.status)) return r;
      await sleep(100);
    }
    return shipRow(id);
  };
  const approved = (r) => ['approved', 'shipping', 'shipped'].includes(r.status);

  console.log('\n── 1. a docs-only diff does NOT auto-approve (request stays pending) ──');
  writeFileSync(join(repo, 'docs', 'guide.md'), '# guide v2\n');
  const docsSha = await commitAll('docs only');
  await setDeployed(base);
  await freeLock();
  const rA = await requestShip({ xellId: xell.id, reason: 'docs-only auto-skip test' });
  ok(rA.ok === true && rA.request, 'requestShip raised a request');
  const rArow = await shipRow(rA.request.id);
  ok(rArow.status === 'pending', `the request stays PENDING (status: ${rArow.status})`);
  ok(/docs/.test(rA.note || ''),
     `the returned note says the auto-ship was skipped for a docs-only diff (${(rA.note || '').slice(0, 80)})`);
  ok(!approved(rArow), 'decideShip was NOT called — the request is not approved');

  console.log('\n── 2. a diff touching server/ (a mixed docs+server diff) still auto-approves ──');
  writeFileSync(join(repo, 'docs', 'guide.md'), '# guide v3\n');
  writeFileSync(join(repo, 'server', 'foo.js'), 'export const x = 2;\n');
  const mixedSha = await commitAll('server + docs');
  await setDeployed(base);
  await closeOpenShips();
  await freeLock();
  // The payload's "from": a shipped ship at the docs-only tip, so the payload is the ONE mixed
  // commit — and that commit was READ (review recorded), so the review gate passes and the docs-only
  // skip is what is actually being exercised.
  await shipShipped(docsSha);
  await reviewCommit(mixedSha);
  const rB = await requestShip({ xellId: xell.id, reason: 'mixed auto-approve test' });
  ok(rB.ok === true && rB.request, 'requestShip raised a second request');
  const rBrow = await shipRow(rB.request.id);
  ok(approved(rBrow), `auto-approve FIRED (status: ${rBrow.status})`);
  ok(/auto-approved by policy/.test(rB.note || ''),
     `the note says it was auto-approved (${(rB.note || '').slice(0, 60)})`);
  const rBdone = await settle(rB.request.id);
  ok(rBdone.status === 'shipped', `and the stub deploy completes (status: ${rBdone.status})`);
  await freeLock();

  console.log('\n── 3. no deployed sha yet (the diff is uncomputable) still auto-approves ──');
  writeFileSync(join(repo, 'server', 'foo.js'), 'export const x = 3;\n');
  const nSha = await commitAll('server only');
  await setDeployed(null);
  await closeOpenShips();
  await freeLock();
  // The new commit was READ too, so again only the docs-only skip is in play — and it CANNOT skip
  // (no deployed sha), so the auto-approve runs: failing toward shipping is the safe side for the
  // docs-only optimisation (a docs-only restart is cheap, an undeployed fix is not).
  await reviewCommit(nSha);
  const rC = await requestShip({ xellId: xell.id, reason: 'no-deployed-sha test' });
  ok(rC.ok === true && rC.request, 'requestShip raised a third request');
  const rCrow = await shipRow(rC.request.id);
  ok(approved(rCrow), `auto-approve FIRED (status: ${rCrow.status})`);
  ok(/auto-approved by policy/.test(rC.note || ''),
     'and the note still says auto-approved — failing toward shipping is the safe side');
  await settle(rC.request.id);
  await freeLock();

  console.log('\n── 4. deployed == candidate (an empty diff) still auto-approves ──');
  await setDeployed(nSha);   // master has not moved since scenario 3, so the diff is empty
  await closeOpenShips();
  await freeLock();
  const rD = await requestShip({ xellId: xell.id, reason: 'empty-diff test' });
  ok(rD.ok === true && rD.request, 'requestShip raised a fourth request');
  const rDrow = await shipRow(rD.request.id);
  ok(approved(rDrow), `auto-approve FIRED (status: ${rDrow.status})`);
  ok(/auto-approved by policy/.test(rD.note || ''),
     'an empty diff is NOT a docs-only skip — auto-approve runs unchanged');
  await settle(rD.request.id);
  await freeLock();

  // ── the ship log is not silent about a skipped auto-ship ──
  console.log('\n── 5. a skipped auto-ship is legible in the ship log, never silent ──');
  const { recentLogs } = await import('../server/src/lib/logbus.js');
  const logs = recentLogs(2000).map((l) => `${l.scope}: ${l.msg}`);
  ok(logs.some((m) => /auto-ship SKIPPED/i.test(m) && /docs\//.test(m)),
     'the ship log says the auto-ship was SKIPPED and names the docs-only reason');

  console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
} catch (e) {
  console.error('\n✗ threw:', e.stack || e.message);
  fail++;
} finally {
  await cleanup();
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
  await pool.end().catch(() => {});
}
process.exit(fail ? 1 : 0);
