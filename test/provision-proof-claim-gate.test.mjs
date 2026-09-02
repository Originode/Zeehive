// THE PROOF GATE IN THE CLAIM CAS — stage 2 of the provision-proof kit
// (docs/provision-proof-kit/stage-2-gates.md, plan §4.3). The readiness_proof knob is an
// additional conjunct computed IN THE SAME conditional UPDATE that takes the xell — a project set
// to 'required' must refuse an unproven / proof-failed / preflight-failed xell with NO
// read-then-write window (TKT-88-D6B4: the claim is the CAS every dispatch funnels through, and
// the gate lives in it so it cannot be beaten by reading the policy first and updating later).
//
// THE MATRIX, driven against REAL SQL on a real postgres (the stage-2 brief: "drive the REAL SQL
// against zee db-sandbox --migrate, not a mock"):
//
//   policy × xell state        off    advisory    required
//   no proof (proof_at NULL)   claim  claim       REFUSE
//   proven                     claim  claim       claim
//   proof-failed               claim  claim       REFUSE
//   preflight-failed           claim  claim       REFUSE
//
// Plus the two hard rules the gate exists to keep:
//   • a dispatch that finds NO claimable xell falls through to the fresh-spawn path (an UNNAMED
//     pick returns null → targetId null → spawnHeadless's existing provision-on-demand), and a
//     NAMED xell that the gate refuses is refused LOUDLY — it must never proceed to spawn into a
//     known-broken xell;
//   • the SWEEP's take is deliberately NOT gated (§4.3): a proof-failed xell under 'required' is
//     decommissioned through sweepDecommission AFTER routing, so the take that decommissions it
//     must still work — otherwise the very xells the policy says must be replaced are stranded.
//   • a PRODUCTION xell stays skill-claimable even unproven (the /xell-prod door is a human's
//     explicit production work; the policy governs POOLED stock).
//
// PROVISION_MODE=simulate: the claim CAS and the reaper's row-retirement are exactly what a real
// dispatch runs (no machine is ever touched).
process.env.PROVISION_MODE = 'simulate';        // before any import: no machine may be touched

import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { q, one, pool } = await import('../server/src/db/pool.js');
const { claimReadyXell, claimFirstReady, takeReadyXellForSweep, untakeSweptXell } =
  await import('../server/src/lib/xell-claim.js');
const { claimReadyXellForSkill, proofGateRefusal, skillClaimUnavailable, dispatchXell } =
  await import('../server/src/queenzee/intake.js');

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };

const tag = randomUUID().slice(0, 8);
const tmp = mkdtempSync(join(tmpdir(), 'claimgate-'));
let projId = null, pcId = null, xourceId = null;

// One ready pooled xell in a given proof state. `policy` sets the project's readiness_proof;
// `state` shapes the proof/preflight columns.
const mkReady = async (slug, { proofAt = null, proofError = null, preflightError = null } = {}) => {
  const wt = join(tmp, slug);
  mkdirSync(wt, { recursive: true });
  return one(
    `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status, is_pooled, ready_at,
                       proof_at, proof_error, preflight_error)
       VALUES ($1,$2,$3,$4,$5,'ready',true, now(), $6,$7,$8) RETURNING *`,
    [projId, xourceId, slug, `spinoff/${slug}`, wt, proofAt, proofError, preflightError]);
};
const setPolicy = (p) => q(`UPDATE pool_config SET readiness_proof=$2 WHERE project_id=$1`, [projId, p]);
const reset = (id) => q(`UPDATE xell SET status='ready', is_pooled=true WHERE id=$1`, [id]);
const row = (id) => one(`SELECT status, is_pooled, proof_at, proof_error, preflight_error FROM xell WHERE id=$1`, [id]);

try {
  projId = (await one(
    `INSERT INTO project (name, repo_root, main_branch) VALUES ($1,$2,'master') RETURNING id`,
    [`zt-claimgate-${tag}`, join(tmp, 'repo')])).id;
  xourceId = (await one(`INSERT INTO xource (project_id, ref) VALUES ($1,'master') RETURNING id`, [projId])).id;
  // pool_config's primary key IS project_id (001_init) — no id column.
  await one(
    `INSERT INTO pool_config (project_id, target_ready, default_source_coupling, default_db_coupling)
     VALUES ($1,0,'sparse-overlay','db-shared-dev') RETURNING project_id`, [projId]);

  // ── THE MATRIX ───────────────────────────────────────────────────────────────
  console.log('\n── claim CAS matrix: {off, advisory, required} × {no proof, proven, proof-failed, preflight-failed} ──');
  const STATES = {
    'no proof':        {},
    'proven':          { proofAt: new Date().toISOString() },
    'proof-failed':    { proofAt: new Date().toISOString(), proofError: 'app-build:server: build failed: nope' },
    'preflight-failed':{ proofAt: new Date().toISOString(), preflightError: 'db-open: role zeehive was rejected by host 10.2.0.16:32768' },
  };
  const EXPECT = { off: 'claim', advisory: 'claim', required: 'no-proof-refuse' };
  const FAILING = (state) => state !== 'proven';   // the only 'required' state that claims

  for (const [policy] of [['off'], ['advisory'], ['required']]) {
    await setPolicy(policy);
    for (const [stateName, st] of Object.entries(STATES)) {
      const x = await mkReady(`pf-${policy}-${stateName.replace(/[^a-z0-9]/g, '-')}-${tag}`, st);
      const claimed = await claimReadyXell(x.id);
      const wantClaim = policy === 'off' || policy === 'advisory' || !FAILING(stateName);
      ok(!!claimed === wantClaim,
        `${policy.padEnd(9)} × ${stateName.padEnd(16)} → ${claimed ? 'CLAIMED' : 'refused'} ${wantClaim ? '✓' : ''}`);
      if (claimed) await reset(x.id);
    }
  }

  // ── UNNAMED DISPATCH FALLS THROUGH TO FRESH-SPAWN, NEVER TO A BROKEN XELL ────
  console.log('\n── an unnamed dispatch cannot fall through to a known-broken xell ──');
  await setPolicy('required');
  const lone = await mkReady(`lone-broken-${tag}`, { proofAt: new Date().toISOString(), proofError: 'app-build:server: boom' });
  const pick = await claimFirstReady([lone]);   // the ONLY ready xell, and it is proof-failed
  ok(pick === null, 'the unnamed pick returns null — the sole candidate is refused by the gate');
  ok((await row(lone.id)).status === 'ready', 'and the refused xell is untouched — still ready, not claimed');

  // ── NAMED DISPATCH REFUSED LOUDLY (never proceeds into a known-broken xell) ──
  console.log('\n── a named dispatch into a gate-refused xell refuses loudly ──');
  const named = await mkReady(`named-broken-${tag}`, { proofAt: new Date().toISOString(), proofError: 'app-build:server: boom' });
  let threw = null;
  await dispatchXell({ xell_id: named.id, task: 'anything', project: projId, rename: false })
    .catch((e) => { threw = e; });
  ok(!!threw, 'the dispatch THROWS — it does not proceed unclaimed into the broken xell');
  ok(/readiness_proof='required'/.test(threw?.message || '') && /never been proven|proof failed|preflight/.test(threw?.message || ''),
     `and the refusal names the policy + the failing condition: ${String(threw?.message).slice(0, 120)}…`);
  ok((await row(named.id)).status === 'ready', 'and the xell stays ready — no claim leaked');

  // ── SKILL-CLAIM UNDER 'required': non-production refused, PRODUCTION exempt ──
  console.log('\n── the /xell skill-claim: same gate, production exempt ──');
  const sk = await mkReady(`skill-unproven-${tag}`, {});                    // non-production, unproven
  ok((await claimReadyXellForSkill(sk.id)) === null, 'a non-production unproven xell is refused by /xell under required');
  ok(/readiness_proof='required'/.test(skillClaimUnavailable(sk.id, { ...sk, status: 'ready' }).message),
     'and the legible refusal names the policy');
  ok(/never been proven/.test(proofGateRefusal({ status: 'ready', proof_at: null, proof_error: null, preflight_error: null })),
     'proofGateRefusal names an unproven xell as never proven');
  ok(/proof failed: app-build/.test(proofGateRefusal({ status: 'ready', proof_error: 'app-build:server: boom' })),
     'and a proof-failed one names the failing check');

  const prod = await mkReady(`skill-prod-${tag}`, {});
  await q(`UPDATE xell SET is_production=true WHERE id=$1`, [prod.id]);
  ok(!!(await claimReadyXellForSkill(prod.id)),
     'a PRODUCTION xell is still claimable by /xell even unproven under required (the /xell-prod door)');

  // ── SWEEP'S TAKE IS NOT GATED — proof-failed xells stay decommissionable ─────
  console.log('\n── the sweep can still decommission a gate-refused xell (the take is not gated) ──');
  const doomed = await mkReady(`doomed-${tag}`, { proofAt: new Date().toISOString(), proofError: 'app-build:server: boom' });
  const scan = (await q(
    `SELECT id, slug, head_commit, worktree_path FROM xell WHERE id=$1`, [doomed.id]))[0];
  ok(scan.slug === doomed.slug && scan.worktree_path === doomed.worktree_path, 'sweep scanned the proof-failed xell');
  const taken = await takeReadyXellForSweep(scan);
  ok(!!taken && taken.status === 'tearing-down',
     'the sweep TAKE still works on a proof-failed xell under required — decommission is not gate-blocked');
  await untakeSweptXell(doomed.id);

  // ── CONCURRENCY: claim vs sweep still exactly-one-winner with the gate ──────
  console.log('\n── claim vs sweep race on a PROVEN xell under required — exactly one winner ──');
  await setPolicy('required');
  const race = await mkReady(`race-proven-${tag}`, { proofAt: new Date().toISOString() });
  const scanRace = (await q(`SELECT id, slug, head_commit, worktree_path FROM xell WHERE id=$1`, [race.id]))[0];
  // Claim first, sweep second (the incident's own order): the sweep must refuse.
  const c1 = await claimReadyXell(race.id);
  ok(!!c1, 'the claim wins the proven xell');
  const swept = await takeReadyXellForSweep(scanRace);
  ok(swept === null, 'the sweep is refused — the claim took it, exactly one winner');
  ok((await row(race.id)).status === 'claimed', 'the xell stays with the dispatch');
  await reset(race.id);
  // Sweep first, claim second.
  const race2 = await mkReady(`race2-proven-${tag}`, { proofAt: new Date().toISOString() });
  const scan2 = (await q(`SELECT id, slug, head_commit, worktree_path FROM xell WHERE id=$1`, [race2.id]))[0];
  const t2 = await takeReadyXellForSweep(scan2);
  ok(!!t2 && t2.status === 'tearing-down', 'the sweep wins the proven xell');
  ok((await claimReadyXell(race2.id)) === null, 'the claim comes back empty — still exactly one winner');

  // ── A PROJECT WITH NO pool_config ROW KEEPS CLAIMING (default advisory) ─────
  console.log('\n── a project with no pool_config row falls back to the default advisory ──');
  const p2 = (await one(
    `INSERT INTO project (name, repo_root, main_branch) VALUES ($1,$2,'master') RETURNING id`,
    [`zt-claimgate-${tag}-nopc`, join(tmp, 'repo2')])).id;
  const xo2 = (await one(`INSERT INTO xource (project_id, ref) VALUES ($1,'master') RETURNING id`, [p2])).id;
  const x2 = (await one(
    `INSERT INTO xell (project_id, xource_id, slug, branch, status, is_pooled)
       VALUES ($1,$2,'pf-nopc-${tag}','spinoff/nopc','ready',true) RETURNING *`, [p2, xo2])).id;
  ok(!!(await claimReadyXell(x2)),
     'an unproven xell on a project with NO pool_config row is claimable — treated as the default advisory');
  await q(`DELETE FROM xell WHERE id=$1`, [x2]);
  await q(`DELETE FROM xource WHERE project_id=$1`, [p2]);
  await q(`DELETE FROM project WHERE id=$1`, [p2]);
} finally {
  if (projId) {
    await q(`DELETE FROM zee WHERE xell_id IN (SELECT id FROM xell WHERE project_id=$1)`, [projId]);
    await q(`DELETE FROM task WHERE project_id=$1`, [projId]);
    await q(`DELETE FROM container WHERE owner_xell_id IN (SELECT id FROM xell WHERE project_id=$1)`, [projId]);
    await q(`DELETE FROM xell WHERE project_id=$1`, [projId]);
    await q(`DELETE FROM xource WHERE project_id=$1`, [projId]);
    await q(`DELETE FROM pool_config WHERE project_id=$1`, [projId]);
    await q(`DELETE FROM project WHERE id=$1`, [projId]);
  }
  rmSync(tmp, { recursive: true, force: true });
  await pool.end();
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall good');
process.exit(failures ? 1 : 0);
