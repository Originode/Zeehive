// A NESTED QUEENZEE MUST NEVER FAST-FORWARD A REF IN THE XOURCE — the LANDING and SHIP half of the
// class test/nested-queenzee-fleet-guard.test.mjs opened.
//
// THE CLASS. A xell's database is a CLONE of the meta-DB, so the rows a NESTED queenzee walks (every
// zee that boots the server inside its own xell — zeehive.yml gives it PROVISION_MODE=simulate and
// SHIP_MODE=simulate) are the REAL fleet's rows. The landing and ship lanes then act on them with
// real git and real docker:
//
//   1. THE REPORTED HOLE (queenzee/landgate.js). tick() reads land_request rows with status
//      'approved' — the REAL fleet's approvals, inherited whole in the clone — and calls
//      landApproved(), which `git update-ref`s a branch inside project.repo_root: the XOURCE. On a
//      10s timer, with no human anywhere in the path. `zee build` starts exactly such a server.
//   2. THE HOOK'S ANSWER (landgate.checkPush). hooks/land-gate-update.sh reads its API from
//      "${ZEEHIVE_API:-<baked>}", and the queenzee passes its own environment to every git it
//      spawns — so a nested queenzee can be the gate a REAL push consults, and answering allow:true
//      spends a real approval and lets a real ref move.
//   3. THE OTHER REF-MOVERS (queenzee/xellgit.js). push / pull / catch-up / accept-PR all run git in
//      a worktree path taken from a fleet row, or push into repo_root itself.
//   4. THE CONTINUATION NUDGES (queenzee/nudge.js). Every landing/ship outcome resumes the zee's
//      session with `docker exec cxell_<slug>` — from a cloned row, that is another zee's live cage.
//   5. THE OUTBOUND VERBS (lib/projects.js). Pull · Push · PR are console buttons that fetch a real
//      xource from its remote, or publish real main OUTWARD to origin — from a project row that, in
//      a nested queenzee, is the real fleet's.
//   6. THE SHIP'S SCHEMA STEP (queenzee/shipgate.js → shipmigrate.applyMigrations). The ship reaper
//      picks up 'approved' ship_request rows every 5s the same way; the container BUILD honours
//      SHIP_MODE (the scripts exit early on mode=simulate) but the migration step never read it, so
//      a nested queenzee would write DDL into the real production database.
//
// Same contract as the fleet guard: 'real' does exactly what it always did, anything else REPORTS
// what it would have done and touches nothing — never a silent skip.
//
// HOW IT IS PROVEN: real throwaway git repos (so "did the ref move?" is a fact, not a mock) plus a
// fake `docker` first on PATH that records every argv — this cage has no docker, so "it failed to
// exec" would prove nothing about whether it TRIED. Everything it creates is removed in a finally.
process.env.PROVISION_MODE = 'simulate';     // the mode a nested queenzee runs in — before any import
process.env.SHIP_MODE = 'simulate';
process.env.LANDING_PAD_ENABLED = 'false';   // no FIFO gate between us and the lane under test
process.env.LAND_REAPER_ENABLED = 'false';   // we call tick() ourselves; no timers racing us
process.env.SHIP_REAPER_ENABLED = 'false';

import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { q, one, pool } = await import('../server/src/db/pool.js');
const { recentLogs } = await import('../server/src/lib/logbus.js');
const { tick, landApproved, checkPush } = await import('../server/src/queenzee/landgate.js');
const { pushToXource, acceptPullIn } = await import('../server/src/queenzee/xellgit.js');
const { nudgeXellAfterLand } = await import('../server/src/queenzee/nudge.js');
const { runShip } = await import('../server/src/queenzee/shipgate.js');
const { pullProject, pushProject } = await import('../server/src/lib/projects.js');
const { selfLand } = await import('../server/src/queenzee/self.js');

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };

const tag = randomUUID().slice(0, 8);
const tmp = mkdtempSync(join(tmpdir(), 'nestland-'));
const repo = join(tmp, 'repo');
const wt = join(tmp, 'wt');
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }).trim();
const since = () => recentLogs(800).length;
const logsSince = (n) => recentLogs(800).slice(n).map((l) => `${l.scope}: ${l.msg}`);
const master = () => git(repo, 'rev-parse', 'refs/heads/master');

// ── the fake docker: records every invocation, answers nothing ────────────────────────────────────
const bin = join(tmp, 'bin');
const DOCKER_LOG = join(tmp, 'docker.log');
mkdirSync(bin, { recursive: true });
writeFileSync(join(bin, 'docker'), `#!/bin/sh
printf '%s\\n' "$*" >> ${DOCKER_LOG}
cat > /dev/null 2>/dev/null || true
exit 0
`, { mode: 0o755 });
process.env.PATH = `${bin}:${process.env.PATH}`;
const dockerCalls = () => (existsSync(DOCKER_LOG) ? readFileSync(DOCKER_LOG, 'utf8').split('\n').filter(Boolean) : []);
const resetDocker = () => { try { rmSync(DOCKER_LOG); } catch { /* not written yet */ } };

let projId = null;
const SLUG = `zt-land-${tag}`;

try {
  // ── fixtures: a xource repo, a xell worktree one commit ahead, and an APPROVED landing ──────────
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'master');
  git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
  writeFileSync(join(repo, 'README'), 'xource\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'init');
  const base = master();
  git(repo, 'worktree', 'add', '-q', '-b', `spinoff/${SLUG}`, wt, 'master');
  mkdirSync(join(wt, 'server', 'sql', 'migrations'), { recursive: true });
  writeFileSync(join(wt, 'server', 'sql', 'migrations', `zt_${tag}.sql`), 'SELECT 1;\n');
  git(wt, 'config', 'user.email', 't@t'); git(wt, 'config', 'user.name', 't');
  git(wt, 'add', '-A'); git(wt, 'commit', '-qm', 'the work a human approved');
  const landSha = git(wt, 'rev-parse', 'HEAD');
  git(wt, 'commit', '-q', '--allow-empty', '-m', 'a second landable commit');
  const landSha2 = git(wt, 'rev-parse', 'HEAD');
  git(wt, 'commit', '-q', '--allow-empty', '-m', 'a third landable commit');
  const landSha3 = git(wt, 'rev-parse', 'HEAD');

  projId = (await one(
    `INSERT INTO project (name, repo_root, main_branch) VALUES ($1,$2,'master') RETURNING id`,
    [`zt-nestland-${tag}`, repo])).id;
  const xource = await one(`INSERT INTO xource (project_id, ref) VALUES ($1,'master') RETURNING id`, [projId]);
  const xell = await one(
    `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status, is_pooled)
       VALUES ($1,$2,$3,$4,$5,'working',false) RETURNING id, slug`,
    [projId, xource.id, SLUG, `spinoff/${SLUG}`, wt]);
  // a LIVE cxell zee on it — what the continuation nudges reach into
  await q(`INSERT INTO zee (xell_id, runtime_id, attach_mode, status, entrypoint, viewer_kind, viewer_url,
                            claude_session_id)
           VALUES ($1,(SELECT id FROM agent_runtime WHERE key='claude-code-cxell'),'headless-spawn','working',
                   'cxell-cli','ssh-terminal','http://localhost:2201',$2)`,
    [xell.id, randomUUID()]);

  const approve = async (sha) => one(
    `INSERT INTO land_request (project_id, xell_id, ref, old_sha, new_sha, commits, stat, kind,
        status, decided_at, decided_by)
       VALUES ($1,$2,'refs/heads/master',$3,$4,'[]'::jsonb,'{}'::jsonb,'push','approved',now(),'human@test')
       RETURNING *`, [projId, xell.id, base, sha]);
  const statusOf = async (id) => (await one(`SELECT status FROM land_request WHERE id=$1`, [id])).status;

  // ── 1. THE REPORTED HOLE: the land reaper's tick ────────────────────────────────────────────────
  console.log('\n── 1. an inherited APPROVED landing does not move the xource ref (PROVISION_MODE=simulate) ──');
  const req = await approve(landSha);
  let n = since();
  resetDocker();
  const t = await tick();
  ok(master() === base, `master is untouched — still ${base.slice(0, 8)} (the ref a nested queenzee must never move)`);
  ok(await statusOf(req.id) === 'approved', 'the approval is NOT spent — nothing was landed, so nothing is recorded as landed');
  ok(t.landed === 0 && t.dry_run === 1, `tick() reports the landing it refused to make (landed=${t.landed}, dry_run=${t.dry_run})`);
  ok(logsSince(n).some((m) => m.includes(landSha.slice(0, 8)) && /PROVISION_MODE=simulate/.test(m) && /NOT landed/i.test(m)),
     'and says so in the log, naming the sha and the ref it would have moved — a report, never a silent skip');
  ok(dockerCalls().length === 0, `and it reaches into no cxell (${dockerCalls().length} docker calls recorded)`);

  // a SECOND tick must not re-report the same approval every 10 seconds forever
  n = since();
  await tick();
  ok(!logsSince(n).some((m) => /NOT landed/i.test(m)),
     'the report is made ONCE per approval — a 10s timer must not flood the log a human reads');

  // ── 2. THE HOOK'S ANSWER ────────────────────────────────────────────────────────────────────────
  console.log('\n── 2. it does not authorise a real push either ──');
  n = since();
  const answer = await checkPush({ projectId: projId, ref: 'refs/heads/master', oldSha: base, newSha: landSha });
  ok(answer.allow === false, `allow:false — the hook is told to decline (reason: ${answer.reason})`);
  ok(await statusOf(req.id) === 'approved', 'and the human\'s approval is still unspent');
  ok(logsSince(n).some((m) => /PROVISION_MODE=simulate/.test(m) && m.includes(landSha.slice(0, 8))),
     'the refusal is logged with the sha it refused to let through');

  // ── 3. THE OTHER REF-MOVERS ─────────────────────────────────────────────────────────────────────
  console.log('\n── 3. push / accept-PR run no git in a real worktree ──');
  const pushed = await pushToXource(xell.id, 'human@test').catch((e) => ({ refused: e.message }));
  ok(!pushed.landed && /PROVISION_MODE=simulate/.test(pushed.refused || pushed.reason || ''),
     `pushToXource refuses and says why (${String(pushed.refused || pushed.reason || pushed.landed).slice(0, 60)}…)`);
  ok(master() === base, 'master still has not moved');
  // `zee land` itself: it must refuse BEFORE step 1, which collects out of `cxell_<slug>` and moves
  // the worktree's branch — a refusal at the push would come after that damage was done.
  const selfLanded = await selfLand(await one(`SELECT * FROM xell WHERE id=$1`, [xell.id]));
  ok(selfLanded.ok === false && selfLanded.dry_run === true && /models the fleet/i.test(selfLanded.message || ''),
     'selfLand refuses at the top of the verb, before the collect');
  const pr = await one(
    `INSERT INTO land_request (project_id, xell_id, ref, old_sha, new_sha, commits, stat, kind, status)
       VALUES ($1,$2,'refs/heads/master',$3,$4,'[]'::jsonb,'{}'::jsonb,'pull','pending') RETURNING *`,
    [projId, xell.id, base, landSha2]);
  const accepted = await acceptPullIn(pr.id, 'human@test').catch((e) => ({ ok: false, reason: e.message }));
  ok(accepted.ok === false && /PROVISION_MODE=simulate/.test(accepted.reason || ''),
     'acceptPullIn refuses the same way');
  ok(master() === base && await statusOf(pr.id) === 'pending', 'the ref is untouched and the PR is still open');

  // ── 4. THE CONTINUATION NUDGES ──────────────────────────────────────────────────────────────────
  console.log('\n── 4. no landing/ship outcome resumes a session in a real cage ──');
  resetDocker();
  n = since();
  const nudged = await nudgeXellAfterLand(xell.id, { by: 'human@test' });
  ok(nudged.nudged === false && nudged.dry_run === true, 'the nudge reports instead of exec\'ing');
  ok(dockerCalls().length === 0, `no docker exec into cxell_${SLUG} (${dockerCalls().length} calls)`);
  ok(logsSince(n).some((m) => m.includes(SLUG) && /PROVISION_MODE=simulate/.test(m)),
     'naming the cage it would have resumed');

  // ── 5. LIVE MODE IS UNCHANGED ───────────────────────────────────────────────────────────────────
  console.log('\n── 5. in real mode the landing lands exactly as it does today ──');
  const live = await one(`SELECT * FROM land_request WHERE id=$1`, [req.id]);
  const landed = await landApproved(live, 'human@test', { mode: 'real' });
  ok(master() === landSha, `master fast-forwarded to ${landSha.slice(0, 8)} — the real queenzee still lands`);
  ok(landed.status === 'landed' && await statusOf(req.id) === 'landed', 'and the approval is spent exactly as before');
  const req2 = await approve(landSha3);
  const allowed = await checkPush({ projectId: projId, ref: 'refs/heads/master', oldSha: landSha, newSha: landSha3 },
    { mode: 'real' });
  ok(allowed.allow === true && allowed.reason === 'approved', 'and the hook is still told to let an approved push through');
  ok(await statusOf(req2.id) === 'landed', 'spending the approval as it always did');
  resetDocker();
  const nudgedReal = await nudgeXellAfterLand(xell.id, { by: 'human@test', mode: 'real' });
  ok(nudgedReal.nudged === true, 'and a real queenzee still resumes the zee that landed');
  await new Promise((r) => setTimeout(r, 300));
  ok(dockerCalls().some((c) => c.includes(`cxell_${SLUG}`)), 'by exec\'ing into its cage, by the fleet row\'s own name');

  // ── 6. THE SHIP'S SCHEMA STEP ───────────────────────────────────────────────────────────────────
  console.log('\n── 6. an inherited APPROVED ship migrates no production database (SHIP_MODE=simulate) ──');
  const site = await one(
    `INSERT INTO deploy_site (project_id, key, tier, is_default) VALUES ($1,'local','prod',true) RETURNING id`, [projId]);
  const build = join(tmp, 'build.sh');
  writeFileSync(build, `#!/usr/bin/env bash\necho '{"ok":true,"head":"${landSha}","method":"stub"}'\n`);
  chmodSync(build, 0o755);
  await q(`INSERT INTO container (project_id, role, tier, isolation, name, build_script, site_id, health)
           VALUES ($1,'server','prod','shared',$2,$3,$4,'up')`, [projId, `zt-prod-server-${tag}`, build, site.id]);
  await q(`INSERT INTO container (project_id, role, tier, isolation, name, docker_ctx, host_port, site_id, health)
           VALUES ($1,'db','prod','shared',$2,'zt-ctx',5432,$3,'up')`, [projId, `zt-prod-db-${tag}`, site.id]);
  const MIG = `server/sql/migrations/zt_${tag}.sql`;
  const newShip = async () => (await one(
    `INSERT INTO ship_request (project_id, xell_id, commit, reason, targets, status, skip_migrations,
        migrations, decided_at, decided_by, site_id)
       VALUES ($1,$2,$3,'nested guard test','{server}','approved',false,$4::jsonb,now(),'human@test',$5)
       RETURNING *`, [projId, xell.id, landSha, JSON.stringify([MIG]), site.id])).id;
  const shipRow = async (id) => one(`SELECT * FROM ship_request WHERE id=$1`, [id]);
  const freeLock = () => q(`DELETE FROM deploy_lock WHERE project_id=$1`, [projId]);

  resetDocker();
  n = since();
  const s1 = await newShip();
  await runShip(s1);
  const r1 = await shipRow(s1);
  const res1 = Array.isArray(r1.containers) ? r1.containers : JSON.parse(r1.containers || '[]');
  ok(!dockerCalls().some((c) => /psql|inspect|exec/.test(c)),
     `the production database is never opened (${dockerCalls().length} docker calls recorded)`);
  ok(res1.some((r) => r.role === 'migrations' && /simulate/.test(r.method || '')),
     'the ship record says the migrations were NOT applied, and why');
  ok(logsSince(n).some((m) => /SHIP_MODE=simulate/.test(m) && m.includes(MIG)),
     'and the log names the file it would have run on production');
  await freeLock();

  // ── 7. THE OUTBOUND VERBS ───────────────────────────────────────────────────────────────────────
  // Pull · Push · PR are console buttons that run git against a project's repo_root and its origin,
  // both read off a project row. A nested console renders the REAL projects with the real buttons.
  console.log('\n── 7. Pull / Push / PR touch no real checkout and no remote ──');
  await q(`UPDATE project SET remote_url=$2 WHERE id=$1`, [projId, 'https://example.invalid/zt.git']);
  const before = master();
  const pulledP = await pullProject(projId, 'human@test');
  ok(pulledP.pulled === false && pulledP.dry_run === true && /PROVISION_MODE=simulate/.test(pulledP.reason || ''),
     'Pull refuses with the reason, before any fetch');
  const pushedP = await pushProject(projId, 'human@test');
  ok(pushedP.pushed === false && pushedP.dry_run === true && /PROVISION_MODE=simulate/.test(pushedP.reason || ''),
     'Push refuses the same way — origin is never contacted');
  ok(master() === before, 'and the checkout is exactly where it was');

  resetDocker();
  const s2 = await newShip();
  await runShip(s2, { mode: 'real' });
  ok(dockerCalls().length > 0,
     `real mode still reaches for the production database (${(dockerCalls()[0] || '(nothing)').slice(0, 50)}…)`);
  await freeLock();
} finally {
  if (projId) {
    await q(`DELETE FROM deploy_lock WHERE project_id=$1`, [projId]).catch(() => {});
    await q(`DELETE FROM ship_request WHERE project_id=$1`, [projId]).catch(() => {});
    await q(`DELETE FROM land_request WHERE project_id=$1`, [projId]).catch(() => {});
    await q(`DELETE FROM zee WHERE xell_id IN (SELECT id FROM xell WHERE project_id=$1)`, [projId]).catch(() => {});
    await q(`DELETE FROM container WHERE project_id=$1`, [projId]).catch(() => {});
    await q(`DELETE FROM xell WHERE project_id=$1`, [projId]).catch(() => {});
    await q(`DELETE FROM deploy_site WHERE project_id=$1`, [projId]).catch(() => {});
    await q(`DELETE FROM xource WHERE project_id=$1`, [projId]).catch(() => {});
    await q(`DELETE FROM project WHERE id=$1`, [projId]).catch(() => {});
  }
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
  await pool.end().catch(() => {});
}

console.log(failures ? `\n${failures} FAILED` : '\nall good');
process.exit(failures ? 1 : 0);
