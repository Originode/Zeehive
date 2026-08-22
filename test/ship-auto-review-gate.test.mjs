// SHIP AUTO-APPROVE REVIEW GATE — ticket #79.
//
// Auto-approve used to fire on policy alone, so 16 landings and 2 prod deploys went out in one
// night with ZERO diffs read by anyone, and one of those carried a cross-project write hole found
// only because a reviewer was cast by choice. The gate this proves: a SHIP may auto-approve only
// if every commit it carries has a recorded review verdict (ticket #56) or a human approves it
// explicitly. LANDING auto-approve is untouched — this is the ship gate only.
//
// Against the REAL requestShip with a real git repo (the same harness as
// ship-auto-skip-docs-only.test.mjs):
//   1. every carried commit reviewed → auto-approve FIRES;
//   2. one carried commit unread → the request stays PENDING and the note NAMES the unread commit
//      (its short sha and who landed it) — a human can still ship it manually;
//   3. the review record cannot be read (the lookup THROWS) → auto-approve is WITHHELD — the
//      inverse failure the brief pins: unmeasurable must never mean "all reviewed";
//   4. a FIRST ship (no previous shipped sha — the whole history rides along unenumerated) → held;
//   5. nothing new since the last ship → auto-approve FIRES (there is nothing unread to ship);
//   6. a payload that cannot be read (ok:false) → auto-approve is WITHHELD.
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
const { computeShipPayload, shipAutoApproveVerdict } = await import('../server/src/queenzee/ship-payload.js');

let fail = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) fail++; };
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmp = mkdtempSync(join(tmpdir(), 'shipreview-'));
const PID = '00000000-0000-4000-8000-00000000e111';   // fixed ids so cleanup is total even on crash
const IDS = { xource: '00000000-0000-4000-8000-00000000e222',
  site: '00000000-0000-4000-8000-00000000e333' };

async function cleanup() {
  try { await q(`DELETE FROM review WHERE project_id=$1`, [PID]); } catch { /* */ }
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
  git(repo, 'worktree', 'add', '-q', '-b', 'spinoff/shipreview', wt, 'master');

  // ── stub build script: reports the shipped sha (arg $6 = buildRef = ship.commit) as the new head ──
  const build = join(tmp, 'build.sh');
  writeFileSync(build,
    '#!/usr/bin/env bash\n'
    + 'echo \'{"ok":true,"head":"\'"$6"\'","method":"stub"}\'\n');
  chmodSync(build, 0o755);

  // ── seed the isolated project with AUTO-APPROVE ON ──
  await q(
    `INSERT INTO project (id, name, repo_root, main_branch, auto_approve_ship)
       VALUES ($1,'shipreview-test',$2,'master',true)`, [PID, repo]);
  await q(`INSERT INTO xource (id, project_id, ref) VALUES ($1,$2,'master')`, [IDS.xource, PID]);
  await q(`INSERT INTO deploy_site (id, project_id, key, tier, is_default) VALUES ($1,$2,'local','prod',true)`,
    [IDS.site, PID]);
  const containerId = (await one(
    `INSERT INTO container (project_id, role, tier, isolation, name, build_script, site_id, health)
       VALUES ($1,'server','prod','shared','review-prod-server',$2,$3,'up') RETURNING id`,
    [PID, build, IDS.site])).id;
  const xell = await one(
    `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status, is_pooled)
       VALUES ($1,$2,'review-a','spinoff/shipreview',$3,'idle',false) RETURNING *`,
    [PID, IDS.xource, wt]);

  const setDeployed = (sha) =>
    q(`UPDATE container SET last_build_commit=$2, last_built_at=now() WHERE id=$1`, [containerId, sha]);
  const commitAll = (msg) => { git(repo, 'add', '-A'); git(repo, 'commit', '-qm', msg); return git(repo, 'rev-parse', 'HEAD'); };
  const shipRow = (id) => one(`SELECT * FROM ship_request WHERE id=$1`, [id]);
  const freeLock = () => q(`DELETE FROM deploy_lock WHERE project_id=$1`, [PID]);
  const closeOpenShips = () =>
    q(`UPDATE ship_request SET status='rejected', decided_at=now(), decided_by='test@cleanup'
         WHERE xell_id=$1 AND status IN ('pending','approved','shipping')`, [xell.id]);
  const shipShipped = (sha) =>
    q(`INSERT INTO ship_request (project_id, xell_id, site_id, commit, reason, status, requested_at, decided_at, decided_by, finished_at)
         VALUES ($1,$2,$3,$4,'previous shipped ship','shipped',now()-interval '2 hours',now()-interval '2 hours','human@console',now()-interval '2 hours')`,
      [PID, xell.id, IDS.site, sha]);
  const reviewCommit = (sha, verdict = 'clean') =>
    q(`INSERT INTO review (project_id, xell_id, reviewer, commit_sha, verdict, findings_count, report)
         VALUES ($1,$2,$3,$4,$5,0,NULL)`, [PID, xell.id, xell.slug, sha, verdict]);
  const settle = async (id, tries = 60) => {
    for (let i = 0; i < tries; i++) {
      const r = await shipRow(id);
      if (['shipped', 'failed', 'rejected'].includes(r.status)) return r;
      await sleep(100);
    }
    return shipRow(id);
  };
  const approved = (r) => ['approved', 'shipping', 'shipped'].includes(r.status);

  console.log('\n── 1. every carried commit reviewed → auto-approve FIRES ──');
  writeFileSync(join(repo, 'server', 'foo.js'), 'export const x = 2;\n');
  const c1 = await commitAll('server change one');
  await setDeployed(base);
  await freeLock();
  await shipShipped(base);        // payload "from" = base
  await reviewCommit(c1);         // the one carried commit was READ
  const r1 = await requestShip({ xellId: xell.id, reason: 'reviewed auto-approve test' });
  ok(r1.ok === true && r1.request, 'requestShip raised a request');
  const r1row = await shipRow(r1.request.id);
  ok(approved(r1row), `auto-approve FIRED (status: ${r1row.status})`);
  ok(/auto-approved by policy/.test(r1.note || ''),
     `the note says auto-approved (${(r1.note || '').slice(0, 50)})`);
  const r1done = await settle(r1.request.id);
  ok(r1done.status === 'shipped', `and the stub deploy completes (status: ${r1done.status})`);
  await freeLock();

  console.log('\n── 2. one unread commit → HELD, and the note NAMES it ──');
  writeFileSync(join(repo, 'server', 'foo.js'), 'export const x = 3;\n');
  const c2 = await commitAll('server change two');
  writeFileSync(join(repo, 'web', 'index.html'), '<html>v2</html>\n');
  const c3 = await commitAll('server change three');   // c3 is NEVER reviewed
  await closeOpenShips();
  await freeLock();
  await shipShipped(c1);          // payload "from" = c1 → carries c2 AND c3
  await reviewCommit(c2);         // c2 read, c3 NOT
  const r2 = await requestShip({ xellId: xell.id, reason: 'unread auto-approve test' });
  ok(r2.ok === true && r2.request, 'requestShip raised a request');
  const r2row = await shipRow(r2.request.id);
  ok(!approved(r2row), `the request stays PENDING (status: ${r2row.status})`);
  ok(/auto-ship held/.test(r2.note || ''), `the note says auto-ship HELD (${(r2.note || '').slice(0, 40)}…)`);
  ok(/no recorded review/.test(r2.note || ''), 'the note names the missing review');
  ok(String(r2.note).includes(c3.slice(0, 7)), `the note NAMES the unread commit's short sha (${String(r2.note).slice(0, 120)}…)`);
  ok(/landed by review-a/.test(r2.note || '') || /landed by unknown/.test(r2.note || ''),
     'the note says who landed the unread commit (so a human knows whose work needs reading)');
  ok(!/c2/.test(String(r2.note || '').split('held —')[1] || ''),
     'the READ commit (c2) is NOT named as unread');

  // ── 3. the review record cannot be read → WITHHELD (unmeasurable never means yes) ──
  // The full requestShip path cannot make the real DB lookup throw without dropping the review
  // table, so this pins the gate at the payload + verdict seam: computeShipPayload with a THROWING
  // reviewQuery must mark every commit's review state UNKNOWN (reviewed=null), and the verdict must
  // refuse to auto-approve — the exact inverse failure the brief says must never read as "reviewed".
  console.log('\n── 3. the review lookup THROWS → auto-approve is WITHHELD ──');
  const project = await one(`SELECT * FROM project WHERE id=$1`, [PID]);
  const pendingRow = await one(`SELECT * FROM ship_request WHERE id=$1`, [r2.request.id]);
  const threw = await computeShipPayload(project, pendingRow, {
    reviewQuery: async () => { throw new Error('review table is unreadable (test)'); },
  });
  ok(threw.ok === true, 'computeShipPayload still resolves the RANGE (the failure is the review read, not the payload)');
  ok(threw.commits?.length === 2, `…with the 2 carried commits (got ${threw.commits?.length})`);
  ok(threw.commits.every((c) => c.reviewed === null),
     '…and EVERY commit is marked review-state UNKNOWN (reviewed=null), never a silent "reviewed"');
  ok(threw.summary?.review_error && /unreadable/.test(threw.summary.review_error),
     `…and the payload says WHY (${threw.summary?.review_error})`);
  const vThrew = shipAutoApproveVerdict(threw);
  ok(vThrew.allowed === false, `the verdict WITHHOLDS auto-approve (allowed=${vThrew.allowed})`);
  ok(/UNREADABLE review record/.test(vThrew.reason || ''), '…and the reason says the review record was unreadable');

  // a payload that could not be read at all also withholds
  const vBad = shipAutoApproveVerdict({ ok: false, error: 'could not read the commit range' });
  ok(vBad.allowed === false && /payload could not be read/.test(vBad.reason || ''),
     'a payload that cannot be read also WITHHOLDS, naming the reason');

  console.log('\n── 4. a FIRST ship (whole history unenumerated) → HELD ──');
  await closeOpenShips();
  await freeLock();
  // No shipped ship at all for this target → lastShippedForTarget returns null → first-ship note.
  await q(`DELETE FROM ship_request WHERE project_id=$1 AND status='shipped'`, [PID]);
  const r4 = await requestShip({ xellId: xell.id, reason: 'first ship test' });
  ok(r4.ok === true && r4.request, 'requestShip raised a request');
  const r4row = await shipRow(r4.request.id);
  ok(!approved(r4row), `the request stays PENDING (status: ${r4row.status})`);
  ok(/first ship to this target/.test(r4.note || ''),
     `the note says it is a first ship and a human must approve (${(r4.note || '').slice(0, 60)}…)`);

  console.log('\n── 5. nothing new since the last ship → auto-approve FIRES ──');
  await closeOpenShips();
  await freeLock();
  // Re-establish a shipped ship at the CURRENT tip (master has not moved since scenario 2), so the
  // payload is an empty range — "nothing new" — and there is nothing unread to gate on.
  const tip = git(repo, 'rev-parse', 'master');
  await shipShipped(tip);
  const r5 = await requestShip({ xellId: xell.id, reason: 'nothing-new test' });
  ok(r5.ok === true && r5.request, 'requestShip raised a request');
  const r5row = await shipRow(r5.request.id);
  ok(approved(r5row), `auto-approve FIRED (status: ${r5row.status})`);
  ok(/auto-approved by policy/.test(r5.note || ''),
     'nothing new carries nothing unread — auto-approve runs');
  await settle(r5.request.id);
  await freeLock();

  console.log(`\n${fail ? `${fail} FAILED` : 'ALL PASSED'}`);
} catch (e) {
  console.error('\n✗ threw:', e.stack || e.message);
  fail++;
} finally {
  await cleanup();
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
  await pool.end().catch(() => {});
}
process.exit(fail ? 1 : 0);
