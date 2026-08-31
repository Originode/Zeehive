// ONE ROW, ONE OWNER — the compare-and-set that stands between a DISPATCH and the POOL SWEEP.
//
// THE INCIDENT (TKT-88-D6B4, 2026-08-05 00:05:52–00:08:53Z): five dispatched tasks destroyed in
// three minutes, each with the same three lines —
//
//   [pool]   decommissioning <pool-slug> — no-worktree (behind 0); will reprovision fresh
//   [reaper] decommissioning <task-slug> (stale:no-worktree) [liveness: no live zee is bound to it]
//   [rename] <pool-slug> -> <task-slug>
//
// …one xell, named twice, because the two loops were reading it at different moments:
//
//   t0  the pool tick SELECTs the ready xells (pool.js step 1) and holds those ROWS for the rest
//       of the sweep — slug and worktree_path as they were at t0.
//   t1  a dispatch picks the same xell (intake.js readyXells → targetId — a plain SELECT that
//       claimed nothing) and renames it: `git worktree move` on disk, then slug/branch/
//       worktree_path committed. The xell is STILL status='ready'.
//   t2  the sweep reconciles its t0 row. landOne() stats the OLD worktree path, which the rename
//       moved out from under it, and returns `no-worktree` → verdict decommission. The log names
//       the OLD slug, because that is what the scan holds.
//   t3  reapXell() re-reads the row by id — now the TASK slug — finds no zee bound yet (the cage
//       is still being built) and tears the worktree and branch down. The log names the NEW slug.
//   t4  the rename's own logline finally prints, which is why it appears LAST in the incident.
//
// Nothing there was unlucky: two writers with no lock between them, and the loser was whichever
// read first. Note also that the rename ALONE manufactures the `no-worktree` verdict — a pool that
// only ever minted healthy worktrees would still lose this race.
//
// THE RULE, and why it cannot interleave badly: both sides now take the xell with a CONDITIONAL
// UPDATE off the SAME value (status='ready'), and Postgres serialises concurrent updates of one
// row. Exactly one of the two statements can find `status='ready'` and return a row; the other
// gets nothing back and steps aside. There is no window to hit, in either order, because there is
// no read-then-write left to interleave — the read IS the write.
//
// The shape is the one this codebase already uses where two things must not both act: the revive
// loop's "never two revives in flight" claim (queenzee/revive.js) and the landing runway's
// occupancy (queenzee/landgate.js).
import { q, one } from '../db/pool.js';
import { broadcast } from './events.js';

// DISPATCH takes a pooled xell: ready → claimed, in one statement. Returns the claimed row, or
// null when somebody else got there first (another dispatch, or the sweep) — OR when the project's
// readiness_proof policy refuses it (below). is_pooled goes false with it, exactly as the later
// spawn UPDATE does — this simply moves that fact EARLIER, to the moment the xell was actually
// spoken for, instead of leaving it 'ready' through the rename.
export async function claimReadyXell(xellId) {
  if (!xellId) return null;
  // A QUARANTINED xell is not claimable, ever (ticket #81): the claim is the CAS every dispatch
  // path funnels through, so refusing here is what makes "a quarantined cage gets no new agent" a
  // fact rather than a list of callers that remembered to check. The callers that name an explicit
  // id still re-read the row to say WHY (xellQuarantineRefusal); this is the hard guarantee.
  //
  // THE PROOF GATE (provision-proof §4.3, stage 2). The claim and the pool's sweep take the xell
  // with the SAME conditional UPDATE off status='ready' (TKT-88-D6B4), and the readiness_proof
  // policy is an additional conjunct computed IN THE SAME STATEMENT — so the gate cannot be beaten
  // by reading the policy first and updating later; there is no read-then-write window to
  // interleave. Per project:
  //   'off'      — today's behaviour, byte for byte (the conjunct degenerates to `TRUE`);
  //   'advisory' — refuses nothing; the proven-first ORDER in readyXells (intake.js) is the
  //                advisory fleet's preference, never a refusal;
  //   'required' — an unproven (proof_at IS NULL), proof-failed (proof_error NOT NULL) or
  //                preflight-failed (preflight_error NOT NULL) xell is NOT STOCK: the claim
  //                returns null, and a dispatch that finds no claimable xell falls through to the
  //                EXISTING fresh-spawn path (§4.7) — it must never fall through to claiming a
  //                known-broken xell, which is exactly what a claim without the conjunct does.
  // The gate is written NOT EXISTS over pool_config (rather than the plan's literal inner join) so
  // a project with NO pool_config row — never onboarded a readiness policy, which every raw test
  // project and any legacy edge is — falls back to the DEFAULT advisory and keeps claiming, exactly
  // as migration 236's NOT NULL DEFAULT 'advisory' intends. Only a row that SAYS 'required' AND a
  // xell that is unproven can trip it. (Driven against a real postgres in the stage-2 verify suite.)
  const row = await one(
    `UPDATE xell x SET status='claimed', is_pooled=false
       WHERE x.id=$1 AND x.status='ready' AND NOT x.is_production AND x.quarantined_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM pool_config pc
            WHERE pc.project_id = x.project_id
              AND pc.readiness_proof = 'required'
              AND (x.proof_at IS NULL OR x.proof_error IS NOT NULL OR x.preflight_error IS NOT NULL))
       RETURNING x.*`, [xellId]);
  if (row) broadcast('xell', row);
  return row;
}

// The first xell of `candidates` this caller can actually claim. Two dispatches landing together
// no longer both walk off with the freshest ready xell: the loser simply moves to the next one.
export async function claimFirstReady(candidates = []) {
  for (const c of candidates) {
    const claimed = await claimReadyXell(c.id);
    if (claimed) return claimed;
  }
  return null;
}

// THE SWEEP takes a xell it decided to decommission: ready → tearing-down, in one statement, and
// only if the row is STILL the row the scan saw. Three guards, one statement:
//   status='ready'  — a dispatch has not claimed it since the scan began;
//   slug            — it has not been RENAMED for a task since the scan began;
//   worktree_path   — nor moved (the rename moves both together; assert both anyway, since the
//                     stale path is the very thing that produced the false `no-worktree`).
// 'tearing-down' is not a new vocabulary word: it is the status reapXell sets two lines later, and
// what recoverOrphanTeardowns already knows how to finish. Setting it HERE is what makes the take
// exclusive — from this moment no dispatch can claim the xell either.
//
// DELIBERATELY NO proof-gate conjunct (provision-proof §4.3): the sweep DEcommissions, and a
// proof-failed xell under `required` is decommissioned through THIS path — pool.js calls
// sweepDecommission with the proof error as the reason AFTER routing has recorded the evidence
// (§4.6). If the take refused proof-failed xells the way the claim does, the very xells the
// policy says must be removed and replaced would be undecommissionable — they would sit 'ready'
// and untrimmable forever, and the fill could never make room for a replacement. The gate lives
// on the CLAIM (claimReadyXell / claimReadyXellForSkill): the sweep's job is to take what is not
// stock, and a proof-failed xell is exactly that.
export async function takeReadyXellForSweep(scanned) {
  if (!scanned?.id) return null;
  // A QUARANTINED xell is not swept (ticket #81), ever: reaping the cage is the human's EXPLICIT
  // choice (the /xells/:id/reap arm of the rescue-or-reap decision), not a pool-sweep accident. The
  // pool's own SELECTs already exclude quarantined xells (pool.js), but the sweep CAS is the hard
  // guarantee — a future caller that forgets cannot tear a quarantined cage down.
  if (scanned?.quarantined_at) return null;
  // Fail fast on a scan that did not select the columns the guard is made of. Defaulting a missing
  // worktree_path to NULL would make the take silently never match (a sweep that quietly stops
  // sweeping) — and forgetting the column in a new sweep's SELECT is the exact mistake this guard
  // is here to survive, so it is named rather than absorbed.
  if (!('slug' in scanned) || !('worktree_path' in scanned)) {
    throw new Error('takeReadyXellForSweep needs the scanned row\'s slug AND worktree_path — '
      + 'they are what proves the row has not been renamed since the scan');
  }
  return one(
    `UPDATE xell SET status='tearing-down'
       WHERE id=$1 AND status='ready' AND NOT is_production
         AND quarantined_at IS NULL
         AND slug=$2 AND worktree_path IS NOT DISTINCT FROM $3 RETURNING *`,
    [scanned.id, scanned.slug, scanned.worktree_path ?? null]);
}

// Hand a taken-but-not-reaped xell back to the pool. The reap refusals that can follow a take
// (xell gone, production, a live zee, a ship mid-deploy) all happen BEFORE reapXell touches
// anything, so the xell is exactly as we took it and 'ready' is the truth again — the same
// "it stays ready and will be retried next tick" the pool has always promised.
export async function untakeSweptXell(xellId) {
  const row = await one(
    `UPDATE xell SET status='ready', is_pooled=true WHERE id=$1 AND status='tearing-down' RETURNING *`,
    [xellId]);
  if (row) broadcast('xell', row);
  return row;
}

// WHY A SWEEP SKIPPED ONE — pure, so the sentence a human reads is testable without a database.
// `current` is the row as it is NOW (null = gone); `scanned` is what the sweep was holding.
export function explainSweepSkip(scanned, current) {
  if (!current) return 'it no longer exists — something else retired it first';
  if (current.status === 'tearing-down') return 'another teardown already has it';
  if (current.status !== 'ready') {
    return `a dispatch CLAIMED it while this sweep was running (it is '${current.status}' now)`
      + (current.slug !== scanned.slug ? ` and renamed it to ${current.slug}` : '');
  }
  if (current.slug !== scanned.slug) {
    return `it was RENAMED to ${current.slug} while this sweep was running — the verdict was reached `
      + `against the old worktree (${scanned.worktree_path || 'none'}), which the rename had already moved`;
  }
  if ((current.worktree_path ?? null) !== (scanned.worktree_path ?? null)) {
    return `its worktree moved to ${current.worktree_path || 'nowhere'} while this sweep was running`;
  }
  return 'it changed under the sweep';
}

// The rows this sweep is holding, re-read: used only to EXPLAIN a skip.
export async function currentXells(ids) {
  if (!ids?.length) return new Map();
  const rows = await q(`SELECT id, slug, status, worktree_path FROM xell WHERE id = ANY($1::uuid[])`, [ids]);
  return new Map(rows.map((r) => [r.id, r]));
}
