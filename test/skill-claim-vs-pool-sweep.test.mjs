// A SKILL-CLAIM AND THE POOL SWEEP CANNOT BOTH TAKE ONE XELL — in either order.
//
// THE INCIDENT (TKT-88-D6B4 follow-up). The dispatch half was fixed first: a DISPATCH now claims its
// xell with a CONDITIONAL ready → claimed UPDATE (claimReadyXell, lib/xell-claim.js) the moment it
// picks it, so the pool sweep's own conditional ready → tearing-down take (takeReadyXellForSweep)
// can no longer beat it — Postgres serialises concurrent updates of one row, so exactly ONE of the
// two statements can find `status='ready'` and return a row. The SKILL-CLAIM half was left behind:
// claimXell (server/src/queenzee/intake.js, the /xell path a host session uses) still ended with an
// UNCONDITIONAL `UPDATE xell SET status='claimed', is_pooled=false WHERE id=$1` — so a pool reap
// tearing that xell down (ready → tearing-down) could be racing it, and the claim would flip the
// row straight back to 'claimed': a zee starts working in a worktree the reaper is removing.
//
// THIS TEST pins the same interleaving for the skill-claim's now-conditional claim
// (claimReadyXellForSkill, exported from intake.js as a test seam) against the sweep's take, in
// both orders, exactly as dispatch-claim-vs-pool-sweep.test.mjs pins it for the dispatch claim:
//
//   1. sweep first, claim second — the claim comes back EMPTY, so no zee is ever bound to a xell
//      whose teardown has begun (a pre-fix unconditional claim would resurrect it to 'claimed');
//   2. claim first, sweep second — the sweep's take comes back empty, the claimed xell survives;
//   3. two skill-claims on one ready xell — only one wins it;
//   4. claimXell end-to-end, happy path — a ready xell whose worktree the session stands in is
//      claimed, a zee row is created, and the binding returns;
//   5. claimXell end-to-end, xell already gone — the pre-existing NEEDS_WORKTREE refusal, and no
//      zee row is created;
//   6. claimXell end-to-end, xell taken MID-claim — the interleaving is forced with a row lock
//      (the claim's zee INSERT blocks on the xell FK while a sweep flips the row to
//      'tearing-down'), claimXell refuses with XELL_UNAVAILABLE, the xell is NOT resurrected, and
//      the zee row this call created is compensated (deleted).
//
// PROVISION_MODE=simulate, so a reap retires the ROW and no machine is touched — the destruction
// this asserts against is the row and the fleet's view of it, which is what a claimed zee loses.
process.env.PROVISION_MODE = 'simulate';        // before any import: no machine may be touched

import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { q, one, pool } = await import('../server/src/db/pool.js');
const { claimReadyXellForSkill, skillClaimUnavailable, claimXell } = await import('../server/src/queenzee/intake.js');
const { takeReadyXellForSweep } = await import('../server/src/lib/xell-claim.js');

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };

const tag = randomUUID().slice(0, 8);
const tmp = mkdtempSync(join(tmpdir(), 'skillclaim-'));
let projId = null;

const xellRow = (id) => one(`SELECT id, slug, status, is_pooled, worktree_path FROM xell WHERE id=$1`, [id]);
const zeesFor = (xellId) => q(`SELECT id FROM zee WHERE xell_id=$1`, [xellId]);

try {
  projId = (await one(
    `INSERT INTO project (name, repo_root, main_branch) VALUES ($1,$2,'master') RETURNING id`,
    [`zt-skillclaim-${tag}`, join(tmp, 'repo')])).id;
  const xource = await one(`INSERT INTO xource (project_id, ref) VALUES ($1,'master') RETURNING id`, [projId]);

  // A pooled xell exactly as the pool mints one: 'ready', is_pooled, a random slug, and a real
  // directory on disk for its worktree.
  const mkReady = async (slug) => {
    const wt = join(tmp, slug);
    mkdirSync(wt, { recursive: true });
    return one(
      `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status, is_pooled, ready_at)
         VALUES ($1,$2,$3,$4,$5,'ready',true, now()) RETURNING *`,
      [projId, xource.id, slug, `spinoff/${slug}`, wt]);
  };

  // ── 1. SWEEP FIRST, SKILL-CLAIM SECOND — the resurrection this fix closes ─────
  console.log('\n── a skill-claim cannot resurrect a xell the sweep has already taken ──');
  const a = await mkReady(`calm-summit-${tag}`);
  const takenA = await takeReadyXellForSweep(await xellRow(a.id));
  ok(!!takenA && takenA.status === 'tearing-down', 'the sweep takes it: ready → tearing-down, in one statement');

  const claimedA = await claimReadyXellForSkill(a.id);
  ok(claimedA === null, 'the skill-claim comes back EMPTY — no zee is bound to a xell whose teardown has begun');
  ok((await xellRow(a.id)).status === 'tearing-down',
     'and the xell is NOT resurrected — it stays with the sweep that took it');

  // ── 2. SKILL-CLAIM FIRST, SWEEP SECOND — the other order ─────────────────────
  console.log('\n── the sweep cannot take a xell a skill-claim has already claimed ──');
  const b = await mkReady(`quiet-harbour-${tag}`);
  const claimedB = await claimReadyXellForSkill(b.id);
  ok(!!claimedB && claimedB.status === 'claimed' && claimedB.is_pooled === false,
     'the skill-claim claims it: ready → claimed, in one statement');

  const takenB = await takeReadyXellForSweep(await xellRow(b.id));
  ok(takenB === null, 'the sweep\'s take comes back EMPTY — the claim is exclusive');
  ok((await xellRow(b.id)).status === 'claimed', 'the claimed xell stays claimed');

  // ── 3. TWO SKILL-CLAIMS, ONE READY XELL ──────────────────────────────────────
  console.log('\n── two skill-claims racing for one ready xell ──');
  const c = await mkReady(`bright-anchor-${tag}`);
  const both = await Promise.all([claimReadyXellForSkill(c.id), claimReadyXellForSkill(c.id)]);
  ok(both.filter(Boolean).length === 1, 'exactly one claim wins — the other gets nothing back');

  // ── 4. claimXell END-TO-END, HAPPY PATH ──────────────────────────────────────
  console.log('\n── a session standing in a ready worktree is claimed, end to end ──');
  const d = await mkReady(`old-lantern-${tag}`);
  const dSession = `sess-happy-${tag}`;
  const bindingD = await claimXell({ session_id: dSession, cwd: d.worktree_path, task: 'do the thing', project: projId });
  ok(bindingD?.status === 'claimed', 'the binding says claimed');
  ok(bindingD?.xell?.id === d.id && bindingD?.xell?.worktree_path === d.worktree_path,
     'and it names the xell the session is standing in');
  const afterD = await xellRow(d.id);
  ok(afterD.status === 'claimed' && afterD.is_pooled === false, 'the xell row is claimed and out of the pool');
  ok((await zeesFor(d.id)).length === 1, 'one zee row was created for the session');
  const taskD = await one(`SELECT status, source FROM task WHERE xell_id=$1`, [d.id]);
  ok(!!taskD && taskD.source === 'skill' && taskD.status === 'assigned', 'the task row was linked (skill)');

  // ── 5. claimXell END-TO-END, XELL ALREADY GONE ───────────────────────────────
  console.log('\n── a session standing in a xell the sweep already took gets the pre-existing refusal ──');
  await mkReady(`spare-ready-${tag}`);                       // so the pool is NOT dry — no provisioning
  const e = await mkReady(`still-water-${tag}`);
  await takeReadyXellForSweep(await xellRow(e.id));          // gone before the claim even looks
  let errE = null;
  await claimXell({ session_id: `sess-gone-${tag}`, cwd: e.worktree_path, task: 'nope', project: projId })
    .catch((err) => { errE = err; });
  ok(!!errE && errE.code === 'NEEDS_WORKTREE', 'claimXell refuses with NEEDS_WORKTREE (not in a ready worktree)');
  ok((await zeesFor(e.id)).length === 0, 'and no zee row was created for the doomed xell');
  ok((await xellRow(e.id)).status === 'tearing-down', 'and the doomed xell stays tearing-down');

  // ── 6. claimXell END-TO-END, XELL TAKEN MID-CLAIM (forced interleaving) ──────
  // The claim's readyXells SELECT sees the xell 'ready'; between that SELECT and the claim UPDATE the
  // sweep flips it to 'tearing-down'. Forced deterministically: hold FOR UPDATE on the xell row so the
  // claim's zee INSERT blocks on the FK check, flip the row to 'tearing-down' in that same transaction,
  // commit — the INSERT then completes and the conditional claim finds status='tearing-down' (0 rows).
  console.log('\n── a skill-claim that loses the race mid-call refuses and compensates ──');
  const f = await mkReady(`bright-dawn-${tag}`);
  const fSession = `sess-race-${tag}`;
  const lock = await pool.connect();
  let raceResult = null;
  try {
    await lock.query('BEGIN');
    await lock.query(`SELECT id FROM xell WHERE id=$1 FOR UPDATE`, [f.id]);   // claim will block on the FK

    const claimPromise = claimXell({ session_id: fSession, cwd: f.worktree_path, task: 'race task', project: projId })
      .then((binding) => ({ ok: true, binding }))
      .catch((err) => ({ ok: false, err }));

    // Wait until claimXell's zee INSERT is actually blocked on our row lock (the FK check).
    // Sleep BEFORE each poll — the very first check must not run before claimXell has had a
    // chance to reach the INSERT (it reads a handful of rows first: project, zee, readyXells,
    // pool_config, runtimes — a few ms, far under the poll budget).
    let blocked = false;
    for (let i = 0; i < 150 && !blocked; i++) {
      await new Promise((r) => setTimeout(r, 20));
      const rows = await lock.query(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND state = 'active'
            AND wait_event_type = 'Lock' AND query ILIKE '%INSERT INTO zee%'`);
      blocked = rows.rows[0].n > 0;
    }
    ok(blocked, 'the claim is blocked on the zee INSERT (FK check) — the interleaving is set up');
    if (!blocked) {
      // Release the lock BEFORE awaiting, or a claim that IS blocked would hang this test forever.
      await lock.query('ROLLBACK').catch(() => {});
      await claimPromise.catch(() => {});
      throw new Error('could not force the mid-claim interleaving');
    }

    // The sweep wins while the claim is in flight: ready → tearing-down, and release the lock.
    await lock.query(`UPDATE xell SET status='tearing-down' WHERE id=$1`, [f.id]);
    await lock.query('COMMIT');
    raceResult = await claimPromise;
  } finally {
    await lock.query('ROLLBACK').catch(() => {});
    lock.release();
  }

  ok(raceResult && raceResult.ok === false, 'claimXell REFUSES when the xell was taken mid-claim');
  ok(raceResult?.err?.code === 'XELL_UNAVAILABLE', `and the refusal is legible: ${raceResult?.err?.message?.slice(0, 70)}…`);
  ok(raceResult?.err?.message?.includes('decommissioned'), 'and it names the decommission');
  ok((await xellRow(f.id)).status === 'tearing-down', 'the xell is NOT resurrected — it stays tearing-down');
  ok((await zeesFor(f.id)).length === 0, 'and the zee row this call created was compensated (deleted)');

  // ── AND THE PURE REFUSAL IS TESTABLE WITHOUT A RACE ─────────────────────────
  console.log('\n── skillClaimUnavailable (pure) ──');
  const unavailable = skillClaimUnavailable('some-id', { slug: 'dying-xell', status: 'tearing-down' });
  ok(unavailable.code === 'XELL_UNAVAILABLE' && /dying-xell.*tearing-down/.test(unavailable.message),
     'the message names the xell and its state');
} finally {
  if (projId) {
    await q(`DELETE FROM task WHERE project_id=$1`, [projId]);   // task → zee FK: task first
    await q(`DELETE FROM zee WHERE xell_id IN (SELECT id FROM xell WHERE project_id=$1)`, [projId]);
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
