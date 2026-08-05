// A DISPATCH AND THE POOL SWEEP CANNOT BOTH TAKE ONE XELL — in either order.
//
// THE INCIDENT (TKT-88-D6B4). 2026-08-05T00:05:52–00:08:53Z: five dispatched tasks destroyed in
// three minutes, lifetimes 28s to 6min, each with the same three lines —
//
//   [pool]   decommissioning <pool-slug> — no-worktree (behind 0); will reprovision fresh
//   [reaper] decommissioning <task-slug> (stale:no-worktree) [liveness: no live zee is bound to it]
//   [rename] <pool-slug> -> <task-slug>
//
// One xell, named twice, because two loops were reading it at different moments and nothing sat
// between them: the pool tick SELECTed the ready xells and held those ROWS; a dispatch then picked
// the same xell (a plain SELECT that claimed nothing — the xell stayed 'ready' through the rename
// and all the way to the spawn) and renamed it, moving the worktree; the sweep then reconciled its
// now-stale row, `landOne` stat'd the path the rename had moved, returned `no-worktree`, and the
// reap ran against the freshly dispatched xell. Two of the five destroyed dispatches were attempts
// at the same fix, retried blind by a human who was never told.
//
// THE FIX, and what this test pins. Both sides take the xell with a CONDITIONAL UPDATE off the SAME
// value (status='ready'): claimReadyXell for a dispatch, takeReadyXellForSweep for a sweep — and the
// sweep's also re-asserts the slug and worktree_path the scan was holding. Postgres serialises
// concurrent updates of one row, so exactly one statement can find 'ready' and return a row. There
// is no read-then-write left to interleave, which is why the ORDERING BELOW IS PINNED EXPLICITLY
// rather than raced: a test that only passes because the timing was kind is not evidence.
//
//   1. dispatch first, sweep second (the incident's own order) — the sweep's verdict is discarded
//      and the dispatched xell survives, worktree, branch and all;
//   2. sweep first, dispatch second — the dispatch's claim comes back empty, so no zee is ever
//      spawned into a xell that is being torn down;
//   3. two dispatches on one ready xell — only one wins it (the same statement, same reason);
//   4. a sweep whose scanned row was RENAMED under it is refused even though the row is still
//      'ready' (the rename alone manufactures the false `no-worktree` verdict);
//   5. the verdict really was `no-worktree`, computed by the real reconcileXell against the real
//      moved worktree — the input that drove the incident, not a stand-in;
//   6. explainSweepSkip says WHICH of those happened (pure, no database).
//
// PROVISION_MODE=simulate, so a reap retires the ROW and no machine is touched — the destruction
// this asserts against is the row and the fleet's view of it, which is what a dispatched zee loses.
process.env.PROVISION_MODE = 'simulate';        // before any import: no machine may be touched

import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, renameSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { q, one, pool } = await import('../server/src/db/pool.js');
const { claimReadyXell, claimFirstReady, takeReadyXellForSweep, untakeSweptXell,
        explainSweepSkip } = await import('../server/src/lib/xell-claim.js');
const { sweepDecommission } = await import('../server/src/queenzee/pool.js');
const { reconcileXell } = await import('../server/src/queenzee/landing.js');

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };

const tag = randomUUID().slice(0, 8);
const tmp = mkdtempSync(join(tmpdir(), 'claimrace-'));
let projId = null;

// The pool tick's own scan (pool.js step 1) — the rows a sweep holds for the rest of its pass.
const scanReady = () => q(
  `SELECT id, slug, head_commit, worktree_path FROM xell
     WHERE project_id=$1 AND status='ready' AND NOT is_production
     ORDER BY ready_at DESC NULLS LAST, created_at DESC`, [projId]);
const xellRow = (id) => one(`SELECT id, slug, status, is_pooled, worktree_path FROM xell WHERE id=$1`, [id]);

try {
  projId = (await one(
    `INSERT INTO project (name, repo_root, main_branch) VALUES ($1,$2,'master') RETURNING id`,
    [`zt-claimrace-${tag}`, join(tmp, 'repo')])).id;
  const xource = await one(`INSERT INTO xource (project_id, ref) VALUES ($1,'master') RETURNING id`, [projId]);

  // A pooled xell exactly as the pool mints one: 'ready', is_pooled, a random slug, and a real
  // directory on disk for its worktree (so `landOne` has something true to stat).
  const mkReady = async (slug) => {
    const wt = join(tmp, slug);
    mkdirSync(wt, { recursive: true });
    return one(
      `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status, is_pooled, ready_at)
         VALUES ($1,$2,$3,$4,$5,'ready',true, now()) RETURNING *`,
      [projId, xource.id, slug, `spinoff/${slug}`, wt]);
  };
  // What a dispatch does to a claimed xell: rename-xell.sh moves the folder, rename-xell.js commits
  // the new slug/branch/worktree_path.
  const renameForTask = async (x, taskSlug) => {
    const wt = join(tmp, taskSlug);
    renameSync(x.worktree_path, wt);
    return one(`UPDATE xell SET slug=$2, branch=$3, worktree_path=$4 WHERE id=$1 RETURNING *`,
      [x.id, taskSlug, `spinoff/${taskSlug}`, wt]);
  };

  // ── 1. DISPATCH FIRST, SWEEP SECOND — the incident's own order ───────────────
  console.log('\n── the sweep cannot take a xell a dispatch has already claimed ──');
  const a = await mkReady(`calm-summit-${tag}`);
  const scanA = await scanReady();                       // the pool tick reads its rows…
  ok(scanA.some((s) => s.id === a.id), 'the sweep scanned the ready xell (its row is now stale-able)');

  const claimedA = await claimReadyXell(a.id);           // …a dispatch claims it…
  ok(!!claimedA, 'the dispatch claims it: ready → claimed, in one statement');
  ok(claimedA.status === 'claimed' && claimedA.is_pooled === false,
     'and it leaves the pool in the same statement, not later at the spawn');
  const renamedA = await renameForTask(a, `fix-the-collect-step-${tag}`);   // …and renames it.

  // The sweep's verdict, computed by the REAL reconciler against the row it scanned — the stale
  // path the rename moved. This is the `no-worktree` from the incident, reproduced.
  const verdictA = await reconcileXell(scanA.find((s) => s.id === a.id), 'master');
  ok(verdictA.verdict === 'decommission' && verdictA.res?.reason === 'no-worktree',
     'the sweep still reaches the incident verdict — no-worktree, from the path the rename moved');

  const swept = await sweepDecommission(scanA.find((s) => s.id === a.id), 'stale:no-worktree',
    { what: null, verdict: 'no-worktree' });
  ok(swept.reaped === false, 'the sweep REFUSES to act on it — the verdict is discarded, not applied');
  ok(/CLAIMED/.test(swept.skipped || ''), `and says why: ${swept.skipped}`);

  const afterA = await xellRow(a.id);
  ok(afterA.status === 'claimed', "the dispatched xell is still 'claimed' — not tearing-down, not retired");
  ok(afterA.slug === renamedA.slug, 'it still carries its task name');
  ok(existsSync(afterA.worktree_path), 'and its worktree is still on disk');

  // ── 2. SWEEP FIRST, DISPATCH SECOND — the other order ────────────────────────
  console.log('\n── a dispatch cannot claim a xell the sweep has already taken ──');
  const b = await mkReady(`quiet-harbour-${tag}`);
  const scanB = await scanReady();
  const takenB = await takeReadyXellForSweep(scanB.find((s) => s.id === b.id));
  ok(!!takenB && takenB.status === 'tearing-down', 'the sweep takes it: ready → tearing-down, in one statement');

  const claimedB = await claimReadyXell(b.id);
  ok(claimedB === null, 'the dispatch\'s claim comes back EMPTY — no zee is spawned into a doomed xell');
  const pickB = await claimFirstReady(await scanReady());
  ok(!pickB || pickB.id !== b.id, 'and the unnamed pick cannot land on it either');
  ok((await xellRow(b.id)).status === 'tearing-down', 'the xell stays with the sweep that took it');

  // …and a reap the sweep cannot complete hands it back, exactly as before this fix.
  await untakeSweptXell(b.id);
  const backB = await xellRow(b.id);
  ok(backB.status === 'ready' && backB.is_pooled === true,
     'a take whose reap is refused returns it to the pool (it stays ready and is retried next tick)');

  // ── 3. TWO DISPATCHES, ONE READY XELL ───────────────────────────────────────
  console.log('\n── two dispatches racing for one ready xell ──');
  const c = await mkReady(`bright-anchor-${tag}`);
  const both = await Promise.all([claimReadyXell(c.id), claimReadyXell(c.id)]);
  ok(both.filter(Boolean).length === 1, 'exactly one claim wins — the other gets nothing back');

  // ── 4. A RENAMED-BUT-STILL-READY ROW IS REFUSED TOO ─────────────────────────
  console.log('\n── a scan the rename moved is refused even while the row is ready ──');
  const d = await mkReady(`still-water-${tag}`);
  const scanD = (await scanReady()).find((s) => s.id === d.id);
  await renameForTask(d, `some-other-task-${tag}`);
  await q(`UPDATE xell SET status='ready' WHERE id=$1`, [d.id]);   // pretend nothing claimed it
  const takenD = await takeReadyXellForSweep(scanD);
  ok(takenD === null, 'the take is refused: the slug and worktree it was holding are not the row any more');
  ok((await xellRow(d.id)).status === 'ready', 'and the xell is left exactly as it was');

  // ── 5. THE EXPLANATION IS PURE ──────────────────────────────────────────────
  console.log('\n── explainSweepSkip, with no database in it ──');
  const scanned = { id: 'x', slug: 'calm-summit-1234', worktree_path: '/w/calm-summit-1234' };
  ok(/CLAIMED/.test(explainSweepSkip(scanned, { ...scanned, status: 'claimed' })),
     'a claimed xell reads as claimed');
  ok(/RENAMED to fix-it-1234/.test(
       explainSweepSkip(scanned, { ...scanned, status: 'ready', slug: 'fix-it-1234' })),
     'a renamed one names the new slug');
  ok(/no longer exists/.test(explainSweepSkip(scanned, null)), 'a vanished one says so');
  ok(/another teardown/.test(explainSweepSkip(scanned, { ...scanned, status: 'tearing-down' })),
     'one already being torn down says so');

  // ── 5b. A FAILED DISPATCH GIVES THE CLAIM BACK ──────────────────────────────
  // The claim is taken at the PICK now, so every way a dispatch can die between there and the
  // agent starting has to hand the xell back — or a refused dispatch leaks a pooled xell that
  // nothing ever frees (the reconciler only looks at 'ready'; the monitor's stale-claim reporter
  // only looks at claims that HAD a zee). Both catches, driven through the real dispatchXell:
  console.log('\n── a dispatch that fails leaves the xell exactly as it found it ──');
  const { dispatchXell } = await import('../server/src/queenzee/intake.js');

  const f1 = await mkReady(`refused-early-${tag}`);
  await q(`UPDATE xell SET zee_type='manager' WHERE id=$1`, [f1.id]);   // a worker into a manager
  let threw1 = null;
  await dispatchXell({ xell_id: f1.id, task: 'anything', project: projId, zee_type: 'worker', rename: false })
    .catch((e) => { threw1 = e; });
  ok(!!threw1, 'the type refusal still refuses (it is raised after the claim now)');
  const afterF1 = await xellRow(f1.id);
  ok(afterF1.status === 'ready' && afterF1.is_pooled === true,
     'and the xell is back in the pool — the claim was released, not leaked');

  const f2 = await mkReady(`refused-at-spawn-${tag}`);
  let threw2 = null;
  // No provider account is connected to this throwaway project, so the SPAWN throws — past the
  // pre-spawn catch, before any zee row exists.
  await dispatchXell({ xell_id: f2.id, task: 'anything', project: projId, rename: false })
    .catch((e) => { threw2 = e; });
  ok(!!threw2, `the spawn fails as expected (${String(threw2?.message).slice(0, 60)}…)`);
  const afterF2 = await xellRow(f2.id);
  ok(afterF2.status === 'ready' && afterF2.is_pooled === true,
     'and that claim is given back too — a spawn that never made a zee holds nothing');

  // ── 6. AND A GENUINELY STALE POOL XELL IS STILL REAPED ──────────────────────
  console.log('\n── the sweep still does its job when nothing raced it ──');
  const e = await mkReady(`old-lantern-${tag}`);
  const scanE = (await scanReady()).find((s) => s.id === e.id);
  rmSync(e.worktree_path, { recursive: true, force: true });      // a genuinely broken pool xell
  const verdictE = await reconcileXell(scanE, 'master');
  ok(verdictE.verdict === 'decommission', 'its verdict is decommission');
  const sweptE = await sweepDecommission(scanE, 'stale:no-worktree', { what: null, verdict: 'no-worktree' });
  ok(sweptE.reaped === true, 'and the sweep reaps it — the guard costs the pool nothing');
  ok((await xellRow(e.id)).status === 'retired', 'the stale xell is retired');
} finally {
  if (projId) {
    await q(`DELETE FROM zee WHERE xell_id IN (SELECT id FROM xell WHERE project_id=$1)`, [projId]);
    await q(`DELETE FROM task WHERE project_id=$1`, [projId]);
    await q(`DELETE FROM container WHERE owner_xell_id IN (SELECT id FROM xell WHERE project_id=$1)`, [projId]);
    await q(`DELETE FROM xell WHERE project_id=$1`, [projId]);
    await q(`DELETE FROM xource WHERE project_id=$1`, [projId]);
    await q(`DELETE FROM project WHERE id=$1`, [projId]);
  }
  rmSync(tmp, { recursive: true, force: true });
  await pool.end();
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall good');
process.exit(failures ? 1 : 0);
