// PROVISION-TIME FAULT CARDING (plan §4.6 — the half the proof never sees). A fault that stops a
// xell being CREATED — an exhausted address pool, a daemon that accepts but cannot start
// containers, a compose up that dies, a missing shared dev db — never reaches a proof (there is no
// xell to burn in), so the proof path cannot route it. Before this, pool.js fillTrim's catch logged
// the error, broke, and retried next tick: for a fault that never clears, that was a SILENT HALT —
// no record, no matrix badge, no card, no dispatch seam.
//
// This drives the REAL provision-time seam against `zee db-sandbox --migrate`:
// pool.noteProvisionFailure (the per-pair counter fillTrim's catch calls), the REAL record writer
// (upsertBuildReadinessRecord), pool.fillStopReasonFor (the record is what STOPS the fill next
// tick), and proof-routing.raiseInfraCard — the SAME dedup seam the proof path uses, so a card's
// shape and its "one per machine per fault episode" rule live in one place.
//
//   • failures 1 and 2 record nothing and card nothing — the pair is retried next tick.
//   • the 3rd records the pair 'missing' (the matrix badge flips, the fill stops) AND raises the
//     PROVISION-INFRA card naming machine + the provision error VERBATIM + the provision action.
//   • fillStopReasonFor now stops the fill for the pair — the silent retry is over.
//   • a SECOND episode (record cleared, counter reset) with the card still up flips the record
//     again but raises NO duplicate card — the dedup is proof-routing's own.
//   • a cleared record lets the fill resume; the proof path's raiser sees the provision path's card
//     (ONE dedup map); a machine-less legacy fill records nothing.
//
// It creates its own fixture machine/project rows and removes them in a finally, whatever happens.
process.env.PROVISION_MODE = 'simulate';

import { randomUUID } from 'node:crypto';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }

const { q, one, pool } = await import('../server/src/db/pool.js');
const { noteProvisionFailure, resetProvisionFailCount, fillStopReasonFor } =
  await import('../server/src/queenzee/pool.js');
const { raiseInfraCard, infraMedicAction } = await import('../server/src/lib/proof-routing.js');

let failures = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) failures++; };

const tag = randomUUID().slice(0, 8).replace(/[^a-z0-9]/g, '');
let projId = null, machineId = null;
const clean = [];                              // child rows first: conditions, records, machine, project

try {
  projId = (await one(`INSERT INTO project (name, repo_root) VALUES ($1,$2) RETURNING id`,
    [`zt-provfault-${tag}`, `/tmp/zt-provfault-${tag}`])).id;
  clean.push(() => q(`DELETE FROM project_condition WHERE project_id=$1`, [projId]));
  clean.push(() => q(`DELETE FROM build_readiness_record WHERE project_id=$1`, [projId]));
  clean.push(() => q(`DELETE FROM project WHERE id=$1`, [projId]));
  const m = await one(
    `INSERT INTO machine (key, label, docker_ctx, can_build, enabled) VALUES ($1,$2,$3,true,true) RETURNING *`,
    [`provision-${tag}-machine`, `zt ${tag}`, `provision-${tag}-ctx`]);
  machineId = m.id;
  clean.push(() => q(`DELETE FROM machine WHERE id=$1`, [machineId]));

  const machine = { id: m.id, key: m.key, docker_ctx: m.docker_ctx };
  const machineKey = m.key;
  // The shape a real provision failure carries — an exhausted address pool (ugreen-nas, TKT-52).
  const err = new Error('provision-xell.sh failed: docker: Error response from daemon: could not '
    + 'find an available, non-overlapping IPv4 address pool among the defaults to assign to the network');
  const condBodies = async () =>
    (await q(`SELECT body FROM project_condition WHERE project_id=$1 ORDER BY created_at, id`, [projId]))
      .map((r) => r.body);
  const record = async () =>
    one(`SELECT status, error FROM build_readiness_record WHERE machine_id=$1 AND project_id=$2`,
      [machineId, projId]);

  console.log('\n── a persistent provision fault is CARDED by consecutive failed tick, then the fill stops ──');
  resetProvisionFailCount();
  ok(!(await record())?.status, 'clean start: no record for the pair');
  ok((await fillStopReasonFor(projId, machine)) === null, 'clean start: the fill is not stopped');

  const r1 = await noteProvisionFailure(projId, machine, err);
  ok(r1.recorded === false && r1.carded === false,
     `failure 1 records nothing (${r1.reason}) — a single blip is retried, not carded`);
  ok(!(await record())?.status, '…no record after 1 failure');

  const r2 = await noteProvisionFailure(projId, machine, err);
  ok(r2.recorded === false && r2.carded === false,
     `failure 2 still records nothing (${r2.reason})`);
  ok((await condBodies()).length === 0, '…and no card yet');

  const r3 = await noteProvisionFailure(projId, machine, err);
  ok(r3.recorded === true && r3.carded === true,
     `failure 3 flips the pair — recorded + carded (${r3.reason})`);
  const rec = await record();
  ok(rec?.status === 'missing' && rec.error.includes('address pool'),
     `the pair is recorded 'missing' with the provision error verbatim (got '${rec?.status}')`);
  const card = (await condBodies()).find((b) => b.startsWith('PROVISION-INFRA:'));
  ok(!!card, 'a PROVISION-INFRA card is raised — the dispatch-medic seam');
  ok(card.includes(`machine '${machineKey}'`), '…naming the machine');
  ok(card.includes('address pool') && card.includes('non-overlapping IPv4'),
     '…quoting the provision error VERBATIM as the check detail');
  ok(card.includes(infraMedicAction('provision')), '…and the ONE provision medic action');
  ok(card.includes('provision:'), '…check family is \'provision\' (provision-time, not a proof check)');
  const stop = await fillStopReasonFor(projId, machine);
  ok(!!stop && stop.includes('missing'),
     'fillStopReasonFor now STOPS the fill — the silent every-15s retry is over');

  console.log('\n── the dedup is proof-routing\'s own: one card per machine per fault episode ──');
  resetProvisionFailCount();
  await q(`UPDATE build_readiness_record SET status='ok', error=NULL
             WHERE machine_id=$1 AND project_id=$2`, [machineId, projId]);
  ok((await fillStopReasonFor(projId, machine)) === null, 'a cleared record lets the fill resume');
  const r4 = await noteProvisionFailure(projId, machine, err);
  const r5 = await noteProvisionFailure(projId, machine, err);
  const r6 = await noteProvisionFailure(projId, machine, err);
  ok(r4.recorded === false, 'episode 2 counts fresh after the reset (failure 1 records nothing)');
  ok(r6.recorded === true && r6.carded === false,
     `episode 2 flips the record again but the card is STILL UP — no duplicate (${r6.reason})`);
  ok((await condBodies()).filter((b) => b.startsWith('PROVISION-INFRA:')).length === 1,
     '…still exactly one PROVISION-INFRA card for the pair');

  console.log('\n── one shared seam: the proof path sees the provision path\'s card; a machine-less fault cards nothing ──');
  resetProvisionFailCount();
  const proofDup = await raiseInfraCard({ projectId: projId, machineKey, check: 'provision', detail: 'x' });
  ok(proofDup.raised === false && proofDup.reason.includes('already up'),
     `raiseInfraCard (the proof path's raiser) sees the provision path's card — ONE dedup map (${proofDup.reason})`);
  const noMach = await noteProvisionFailure(projId, null, err);
  ok(noMach.recorded === false && noMach.carded === false,
     'a machine-less legacy fill is counted but never recorded/carded — nothing to key on');

  console.log('\nall good');
} finally {
  for (const fn of clean) { try { await fn(); } catch { /* best effort */ } }
  await pool.end();
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall good');
process.exit(failures ? 1 : 0);
