// FAILURE ROUTING AT STAMP TIME — stage 2 (docs/provision-proof-kit/stage-2-gates.md Build item 4,
// plan §4.6). A failed proof is routed by CLASS, once, at stamp time: INFRA → build_readiness_record
// 'missing' (the pool fill CONSULTS it and stops filling the pair) + a project-level card naming
// machine + check + the ONE bootstrap/medic action; CODE on a pristine pooled xell at the source tip
// → the rolling "main does not build since <sha>" project fact (which does NOT mark the machine and
// does NOT stop the fill); proof-failed xells are decommissioned under 'required' via
// sweepDecommission AFTER routing, capped per (machine, project) per hour — a persistent fault must
// FLIP the record and STOP the fill, never churn provision→fail→reap.
//
// This drives the REAL routing against `zee db-sandbox --migrate` — the exact functions the pool
// runs at stamp time (lib/proof-routing.routeProofFailure, pool.maybeDecommissionProofFailed,
// pool.fillStopReasonFor), the REAL record writer (upsertBuildReadinessRecord) and the REAL verdict
// → record mapping (buildReadinessRecordFromProof). The only stub is the decommission sweep, so the
// CAP logic is asserted without tearing down real worktrees:
//
//   • INFRA verdict → rec 'missing' → a PROVISION-INFRA card names the machine, the failing check
//     VERBATIM and a concrete medic action; re-routing while the record stays 'missing' raises NO
//     second card; an already-up card for the pair is not duplicated.
//   • CODE-only verdict on a PRISTINE POOLED xell → the one "main does not build since <sha>"
//     project fact; re-routing the same sha adds nothing; a NEW sha UPDATES the same card (still
//     exactly one); a non-pooled xell and a non-ready xell raise NO main fact.
//   • a green verdict routes nothing; a "could not tell" (unknown) verdict routes nothing.
//   • the decommission budget: N reaps then COOLDOWN (fill stops); a sweep the CAS skipped consumes
//     NO slot; the cooldown lifts the pair's fill-stop only after reset.
//   • the fill consultation: no record → null; recorded 'missing' → the stop reason; cooldown → the
//     stop reason; recorded 'ok' → null.
process.env.PROVISION_MODE = 'simulate';
process.env.BUILD_MODE = 'simulate';

import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }

const { q, one, pool } = await import('../server/src/db/pool.js');
const { routeProofFailure, infraMedicAction } = await import('../server/src/lib/proof-routing.js');
const { buildReadinessRecordFromProof } = await import('../server/src/lib/xell-proof.js');
const { upsertBuildReadinessRecord } = await import('../server/src/lib/build-readiness.js');
const { maybeDecommissionProofFailed, proofFailCooldownFor, proofFailPairKey, fillStopReasonFor,
        resetProofFailBudget } = await import('../server/src/queenzee/pool.js');

let failures = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) failures++; };

const tag = randomUUID().slice(0, 8).replace(/[^a-z0-9]/g, '');
const tmp = mkdtempSync(join(tmpdir(), `proofroute-${tag}-`));
let projId = null, xoid = null, machineId = null, machineKey = null, machineCtx = null;
const condCount = async (p) => one(`SELECT count(*)::int AS n FROM project_condition WHERE project_id=$1`, [p]);
const condBodies = async (p) => (await q(`SELECT body FROM project_condition WHERE project_id=$1 ORDER BY created_at, id`, [p])).map((r) => r.body);

const mkXell = async (slug, { pooled = true, status = 'ready' } = {}) => {
  const wt = join(tmp, slug);
  mkdirSync(wt, { recursive: true });
  return one(
    `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status, is_pooled,
                       zee_type, db_coupling)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'worker','db-shared-dev') RETURNING id`,
    [projId, xoid, slug, `spinoff/${slug}`, wt, status, pooled]);
};

// The verdict shapes a real proveXell returns. INFRA = a failed app-build check classed INFRA
// (address pool / port bind); CODE = a failed build classed CODE on a pristine pooled xell.
const infraVerdict = (commit) => ({
  ok: false, error: 'app-build:server: docker: Error response from daemon: port is already allocated',
  checks: [{ check: 'db-open', ok: true, skipped: false, detail: 'ok', class: null },
           { check: 'app-build:server', ok: false, skipped: false,
             detail: 'docker: Error response from daemon: port is already allocated', class: 'INFRA' }],
  commit, at: new Date().toISOString(),
});
const codeVerdict = (commit) => ({
  ok: false, error: 'app-build:server: build failed: tsc error TS2304',
  checks: [{ check: 'db-open', ok: true, skipped: false, detail: 'ok', class: null },
           { check: 'app-build:server', ok: false, skipped: false,
             detail: 'build failed: tsc error TS2304', class: 'CODE' }],
  commit, at: new Date().toISOString(),
});
const greenVerdict = { ok: true, error: null, checks: [{ check: 'db-open', ok: true, skipped: false, detail: 'ok', class: null }], commit: 'a'.repeat(40), at: new Date().toISOString() };
const unknownVerdict = (commit) => ({ ok: false, error: 'db-open: could not open',
  checks: [{ check: 'db-open', ok: false, skipped: false, detail: 'could not open', class: null }],
  commit, at: new Date().toISOString() });

try {
  projId = (await one(`INSERT INTO project (name, repo_root) VALUES ($1,$2) RETURNING id`,
    [`zt-proofroute-${tag}`, join(tmp, 'repo')])).id;
  xoid = (await one(`INSERT INTO xource (project_id, ref) VALUES ($1,'master') RETURNING id`, [projId])).id;
  machineKey = `route-${tag}-machine`;
  machineCtx = `route-${tag}-ctx`;
  const m = await one(
    `INSERT INTO machine (key, label, docker_ctx, can_build, enabled) VALUES ($1,$2,$3,true,true) RETURNING *`,
    [machineKey, `zt ${tag}`, machineCtx]);
  machineId = m.id;
  const machine = { id: m.id, key: m.key, docker_ctx: m.docker_ctx };

  // ── INFRA routing: card on the transition, naming machine + check + medic action ─────────
  console.log('\n── INFRA: the pair flips to \'missing\' and a project-level card names the fault ──');
  const ix = await mkXell(`infra-${tag}`);
  const recI = buildReadinessRecordFromProof(infraVerdict('b'.repeat(40)));
  ok(recI.status === 'missing', `INFRA verdict → record 'missing' (got '${recI.status}')`);
  const r1 = await routeProofFailure({ xell: { id: ix.id, slug: `infra-${tag}`, is_pooled: true, status: 'ready' },
                                       verdict: infraVerdict('b'.repeat(40)), rec: recI, prevRec: null, machine, projectId: projId });
  ok(r1.class === 'infra' && !!r1.card, `routed as infra with a card (got class '${r1.class}', reason: ${r1.reason})`);
  const bodies1 = await condBodies(projId);
  const card = bodies1.find((b) => b.startsWith('PROVISION-INFRA:'));
  ok(!!card, 'the card is a project-level condition (PROVISION-INFRA marker)');
  ok(card.includes(`machine '${machineKey}'`), `…naming the machine (${machineKey})`);
  ok(card.includes('app-build:server') && card.includes('port is already allocated'),
     '…naming the failing check VERBATIM (check + detail)');
  ok(card.includes(infraMedicAction('app-build:server')), '…and the ONE medic action that fixes it');
  ok((await condCount(projId)).n === 1, '…exactly one card (one failure, one card)');
  // While the record STAYS missing, re-routing raises nothing (state-change discipline).
  const r2 = await routeProofFailure({ xell: { id: ix.id, slug: `infra-${tag}`, is_pooled: true, status: 'ready' },
                                       verdict: infraVerdict('b'.repeat(40)), rec: recI, prevRec: { status: 'missing' }, machine, projectId: projId });
  ok(r2.class === 'infra' && r2.card === null, 're-routing while the record stays \'missing\' raises NO second card');
  ok((await condCount(projId)).n === 1, '…still exactly one card');

  // ── INFRA dedup: an already-up card for the pair is not duplicated ───────────────────────
  console.log('\n── INFRA: a card already up for the machine is not duplicated ──');
  const iy = await mkXell(`infra2-${tag}`);
  const recIy = buildReadinessRecordFromProof(infraVerdict('c'.repeat(40)));
  const r3 = await routeProofFailure({ xell: { id: iy.id, slug: `infra2-${tag}`, is_pooled: true, status: 'ready' },
                                       verdict: infraVerdict('c'.repeat(40)), rec: recIy, prevRec: null, machine, projectId: projId });
  ok(r3.class === 'infra' && r3.card === null, 'a pair whose card is already up raises no duplicate');
  ok((await condCount(projId)).n === 1, '…one card for the machine, however many xells re-prove the fault');

  // ── CODE routing: the one rolling "main does not build since <sha>" project fact ─────────
  console.log('\n── CODE on a pristine pooled xell: the rolling main-broken fact ──');
  const SHA1 = 'aaaa1111'.padEnd(40, '0');
  const SHA2 = 'bbbb2222'.padEnd(40, '0');
  const cx = await mkXell(`code-${tag}`);
  const recC = buildReadinessRecordFromProof(codeVerdict(SHA1));
  ok(recC.status === 'ok', `CODE-only verdict → record stays 'ok' (the machine CAN build — got '${recC.status}')`);
  const c1 = await routeProofFailure({ xell: { id: cx.id, slug: `code-${tag}`, is_pooled: true, status: 'ready' },
                                       verdict: codeVerdict(SHA1), rec: recC, prevRec: null, machine, projectId: projId });
  ok(c1.class === 'code' && !!c1.card, `routed as code with a card (got class '${c1.class}')`);
  const cb = (await condBodies(projId)).find((b) => b.startsWith('main does not build since'));
  ok(!!cb && cb.includes(SHA1.slice(0, 12)), 'the fact names the sha ("main does not build since <sha>")');
  ok(cb.includes('app-build:server') && cb.includes('tsc error'), '…and the failing check verbatim');
  ok((await condCount(projId)).n === 2, '…INFRA card + main-broken fact, still exactly one of each');
  // Same sha → nothing new; the fact is current.
  const c2 = await routeProofFailure({ xell: { id: cx.id, slug: `code-${tag}`, is_pooled: true, status: 'ready' },
                                       verdict: codeVerdict(SHA1), rec: recC, prevRec: null, machine, projectId: projId });
  ok(c2.class === 'code' && c2.card === null, 're-routing the SAME sha adds nothing (the fact is current)');
  ok((await condCount(projId)).n === 2, '…still 2 conditions — 25 pooled xells failing the same main raise ONE fact');
  // A NEW sha (a land on main that still does not build) UPDATES the same card, still one.
  const c3 = await routeProofFailure({ xell: { id: cx.id, slug: `code-${tag}`, is_pooled: true, status: 'ready' },
                                       verdict: codeVerdict(SHA2), rec: buildReadinessRecordFromProof(codeVerdict(SHA2)),
                                       prevRec: null, machine, projectId: projId });
  ok(c3.class === 'code' && !!c3.card, 'a NEW sha re-routes the fact');
  const cb2 = (await condBodies(projId)).filter((b) => b.startsWith('main does not build since'));
  ok(cb2.length === 1 && cb2[0].includes(SHA2.slice(0, 12)), '…updated in place: exactly one card, now naming the new sha');
  ok((await condCount(projId)).n === 2, '…still 2 conditions total');

  // ── CODE guards: not a pristine pooled xell → no main fact ───────────────────────────────
  console.log('\n── CODE: only a PRISTINE POOLED xell at the source tip proves "main is broken" ──');
  const nx = await mkXell(`nonpooled-${tag}`, { pooled: false });
  const rn = await routeProofFailure({ xell: { id: nx.id, slug: `nonpooled-${tag}`, is_pooled: false, status: 'ready' },
                                       verdict: codeVerdict(SHA2), rec: recC, prevRec: null, machine, projectId: projId });
  ok(rn.class === 'none', 'a CODE failure on a NON-pooled xell is not a "main" fact — no card');
  ok((await condCount(projId)).n === 2, '…and nothing was added');
  const dk = await mkXell(`claimed-${tag}`, { status: 'claimed' });
  const rd = await routeProofFailure({ xell: { id: dk.id, slug: `claimed-${tag}`, is_pooled: true, status: 'claimed' },
                                       verdict: codeVerdict(SHA2), rec: recC, prevRec: null, machine, projectId: projId });
  ok(rd.class === 'none', 'a CODE failure on a non-ready (claimed) xell is not a "main" fact either');
  ok((await condCount(projId)).n === 2, '…still nothing added');

  // ── green and unknown verdicts route nothing ─────────────────────────────────────────────
  console.log('\n── green and unknown verdicts route nothing ──');
  const gx = await mkXell(`green-${tag}`);
  const rg = await routeProofFailure({ xell: { id: gx.id, slug: `green-${tag}`, is_pooled: true, status: 'ready' },
                                       verdict: greenVerdict, rec: buildReadinessRecordFromProof(greenVerdict),
                                       prevRec: null, machine, projectId: projId });
  ok(rg.class === 'none', 'a green proof routes nothing');
  const ux = await mkXell(`unknown-${tag}`);
  const ru = await routeProofFailure({ xell: { id: ux.id, slug: `unknown-${tag}`, is_pooled: true, status: 'ready' },
                                       verdict: unknownVerdict('d'.repeat(40)),
                                       rec: buildReadinessRecordFromProof(unknownVerdict('d'.repeat(40))),
                                       prevRec: null, machine, projectId: projId });
  ok(ru.class === 'none', '"could not tell" (unknown) routes nothing — a class it does not have');
  ok((await condCount(projId)).n === 2, '…still 2 conditions');
  const rg2 = await routeProofFailure({ xell: null, verdict: infraVerdict('e'.repeat(40)), rec: recI, prevRec: null, machine, projectId: projId });
  ok(rg2.class === 'none', '…and a missing xell is a safe no-op, never a throw');

  // ── the pool accounting under 'required': a proof-failed xell is NOT stock (§4.3) ─────────
  // Mirrors pool.js fillTrim's ready-count conjunct exactly (a proof-failed xell must not count
  // toward pool_size under 'required', so the fill provisions a replacement; under advisory it
  // still counts — it remains claimable stock). A never-proven xell still counts: it is in-flight
  // stock on the way to a proof, not a permanent non-starter.
  console.log('\n── under \'required\', a proof-failed xell does not count toward pool_size ──');
  resetProofFailBudget();
  const proven = await mkXell(`proven-${tag}`);
  const failedStock = await mkXell(`failedstock-${tag}`);
  await q(`UPDATE xell SET proof_at=now(), proof_error=NULL WHERE id=$1`, [proven.id]);
  await q(`UPDATE xell SET proof_at=now(), proof_error='app-build:server: x' WHERE id=$1`, [failedStock.id]);
  const readyRequired = await q(
    `SELECT id FROM xell WHERE project_id=$1 AND status='ready' AND NOT is_production
       AND quarantined_at IS NULL AND (proof_at IS NULL OR proof_error IS NULL)
     ORDER BY ready_at DESC NULLS LAST, created_at DESC`, [projId]);
  ok(readyRequired.some((r) => r.id === proven.id), 'under required: a PROVEN xell counts toward pool_size');
  ok(!readyRequired.some((r) => r.id === failedStock.id),
     'under required: a PROOF-FAILED xell does NOT count — the fill provisions a replacement');
  const readyAdvisory = await q(
    `SELECT id FROM xell WHERE project_id=$1 AND status='ready' AND NOT is_production
       AND quarantined_at IS NULL ORDER BY ready_at DESC NULLS LAST, created_at DESC`, [projId]);
  ok(readyAdvisory.some((r) => r.id === failedStock.id),
     'under advisory: the proof-failed xell still counts (it remains claimable stock)');

  // ── the decommission budget: N reaps then cooldown; a CAS-skipped sweep consumes no slot ──
  console.log('\n── the proof-failed teardown cap: N reaps, then the pair cools down ──');
  resetProofFailBudget();
  let swept = 0;
  const stubDecom = async () => { swept++; return { reaped: true }; };
  const px = await mkXell(`cap-${tag}`);
  const pairKey = proofFailPairKey(machineCtx, projId);
  const cap = Number(process.env.PROOF_FAIL_DECOMM_CAP_PER_HOUR) || 3;
  let outcomes = [];
  for (let i = 0; i < cap; i++) {
    outcomes.push(await maybeDecommissionProofFailed(
      { id: px.id, slug: `cap-${tag}`, worktree_path: join(tmp, `cap-${tag}`) },
      machineCtx, projId, 'app-build:server: port already allocated', { decom: stubDecom }));
  }
  ok(outcomes.every((o) => o.decommissioned === true), `${cap} proof-failed pooled xells reaped (${swept} sweeps)`);
  ok(proofFailCooldownFor(pairKey) === 0, '…still under the cap, so NO cooldown yet');
  const c4 = await maybeDecommissionProofFailed(
    { id: px.id, slug: `cap-${tag}`, worktree_path: join(tmp, `cap-${tag}`) },
    machineCtx, projId, 'app-build:server: port already allocated', { decom: stubDecom });
  ok(c4.decommissioned === false && c4.cooledDown === true,
     `the ${cap + 1}th teardown is REFUSED — the pair goes on cooldown, not a ${cap + 1}th reap`);
  ok(swept === cap, `…and no ${cap + 1}th sweep ran (${swept} sweeps)`);
  ok(proofFailCooldownFor(pairKey) > Date.now(), '…and fillStopReasonFor now sees the cooldown');
  // A sweep the CAS skipped (claimed between proof and teardown) consumes NO slot.
  resetProofFailBudget();
  let skipped = 0;
  const stubSkip = async () => { skipped++; return { reaped: false, skipped: 'claimed in between — stale verdict discarded' }; };
  const s1 = await maybeDecommissionProofFailed(
    { id: px.id, slug: `cap-${tag}`, worktree_path: join(tmp, `cap-${tag}`) },
    machineCtx, projId, 'x', { decom: stubSkip });
  ok(s1.decommissioned === false && s1.cooledDown === false, 'a sweep the CAS skipped is not a teardown…');
  ok(proofFailCooldownFor(pairKey) === 0, '…and consumes NO budget slot (the pair is not on cooldown)');

  // ── the fill consultation: no record → fill; recorded 'missing' → fill stops ─────────────
  console.log('\n── the pool fill consults the record: a recorded \'missing\' stops the fill ──');
  resetProofFailBudget();
  ok((await fillStopReasonFor(projId, machine)) === null, 'no record, no cooldown → the pool fills');
  await upsertBuildReadinessRecord(machineId, projId, { status: 'ok', error: null, checks: [] });
  ok((await fillStopReasonFor(projId, machine)) === null, 'recorded \'ok\' → the pool fills');
  await upsertBuildReadinessRecord(machineId, projId,
    { status: 'missing', error: 'app-build:server: port is already allocated', checks: [] });
  const stop = await fillStopReasonFor(projId, machine);
  ok(!!stop && stop.includes('missing') && stop.includes(machineKey),
     'recorded \'missing\' → the stop reason (names the pair) — the pool STOPS filling it');
  await upsertBuildReadinessRecord(machineId, projId, { status: 'ok', error: null, checks: [] });
  ok((await fillStopReasonFor(projId, machine)) === null, '…and a cleared record lets the fill resume');
  // And the cooldown stop is the same consultation:
  await maybeDecommissionProofFailed(
    { id: px.id, slug: `cap-${tag}`, worktree_path: join(tmp, `cap-${tag}`) },
    machineCtx, projId, 'x', { decom: stubDecom });
  for (let i = 0; i < cap; i++) {   // the (cap+1)th call is the one that trips the cooldown
    await maybeDecommissionProofFailed(
      { id: px.id, slug: `cap-${tag}`, worktree_path: join(tmp, `cap-${tag}`) },
      machineCtx, projId, 'x', { decom: stubDecom });
  }
  const cdStop = await fillStopReasonFor(projId, machine);
  ok(!!cdStop && cdStop.includes('cooldown'), 'a pair on teardown cooldown stops the fill the same way');
} finally {
  if (projId) {
    await q(`DELETE FROM project_condition WHERE project_id=$1`, [projId]).catch(() => {});
    await q(`DELETE FROM build_readiness_record WHERE project_id=$1`, [projId]).catch(() => {});
    await q(`DELETE FROM zee WHERE xell_id IN (SELECT id FROM xell WHERE project_id=$1)`, [projId]).catch(() => {});
    await q(`DELETE FROM task WHERE project_id=$1`, [projId]).catch(() => {});
    await q(`DELETE FROM xell_uses_container WHERE xell_id IN (SELECT id FROM xell WHERE project_id=$1)`, [projId]).catch(() => {});
    await q(`DELETE FROM container WHERE project_id=$1`, [projId]).catch(() => {});
    await q(`DELETE FROM xell WHERE project_id=$1`, [projId]).catch(() => {});
    await q(`DELETE FROM xource WHERE project_id=$1`, [projId]).catch(() => {});
    await q(`DELETE FROM pool_config WHERE project_id=$1`, [projId]).catch(() => {});
    await q(`DELETE FROM project WHERE id=$1`, [projId]).catch(() => {});
    if (machineId) await q(`DELETE FROM machine WHERE id=$1`, [machineId]).catch(() => {});
  }
  rmSync(tmp, { recursive: true, force: true });
  await pool.end();
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall good');
process.exit(failures ? 1 : 0);
