// THE MEDIC CALL (the patient-voice card) — a blocked zee's own words reaching the ⛑ medic.
// server/src/lib/medic-calls.js is the ONE place the routing decision lives; this test proves it
// against a REAL postgres (DATABASE_URL — `zee db-sandbox --migrate`, migration 251 applied):
//
//   1. EVIDENCE is collected server-side at call time from the SAME three fleet.js trusts (failing
//      db preflight xell.preflight_error, failing provision proof xell.proof_error, INFRA build
//      failures via xell_uses_container JOIN container) plus provision fault cards. No evidence is
//      still recorded, never refused — the answer tells the zee plainly.
//   2. RAISE with no live medic → routed 'raised' (an 'open' call: fleet.medic_emergency
//      source:'called', a human dispatches — NOTHING auto-spawns).
//   3. ONE LIVE CALL PER XELL is the rate limit — a second call UPDATES the open row (the partial
//      unique index), it never inserts a second live call.
//   4. WITHDRAW lowers a live call; the next raise inserts a FRESH call (withdrawn rows do not
//      count against the live index).
//   5. DISPATCH+ANSWER: the human-dispatch outcome (call linked to a medic, status 'attended') is
//      what a medic answers with call_answer — resolve/decline is SCOPED to the medic's own attended
//      call, and the note is POSTED BACK to the calling xell as a zee_message.
//   6. ATTACH: a LIVE medic on the project routes the raise to 'attached' — the call is linked to
//      that medic and marked 'attended' (the warm resume itself is the driver's business; this test
//      asserts the row routing, not the model turn).
process.env.MEDICRW_MODE = 'real';
// The dispatch route is gated by requireQueenzeeLoops — only the process holding the single-queenzee
// lock drives a spawn. config.js loads .zeehive.env at import (an API-only cxell projects
// QUEENZEE_INPROC=false there), but dotenv never overrides a key already in the environment — so set
// it TRUE here, before the pool import that loads config, to mount the route the way the real
// queenzee would. (Same convention as test/medic-dispatch-seam.test.mjs.)
process.env.QUEENZEE_INPROC = 'true';
const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }

const { randomUUID } = await import('node:crypto');
const express = (await import('express')).default;
const { q, one } = await import('../server/src/db/pool.js');
const { mintXellToken } = await import('../server/src/lib/xell-token.js');
const {
  raiseMedicCall, collectCallEvidence, readMedicCallForXell,
  listProjectMedicCalls, withdrawMedicCall, answerMedicCall,
  buildCallAttachMessage, buildCallDispatchBrief,
} = await import('../server/src/lib/medic-calls.js');

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

const tag = randomUUID().slice(0, 8).replace(/[^a-z0-9]/g, '');
const clean = [];
const cleanQ = (sql, p) => () => q(sql, p);    // THUNK: deferred to the finally, in reverse order

const insProject = async (name) => {
  const id = (await one(
    `INSERT INTO project (name, repo_root, main_branch, db_user, db_name, manifest)
       VALUES ($1,$2,'main','postgres','postgres','{}') RETURNING id`,
    [name, `/tmp/mc-${tag}-${name}`])).id;
  clean.push(cleanQ(`DELETE FROM project WHERE id=$1`, [id]));
  return id;
};
const insXell = async (projectId, slug) => {
  const xo = (await one(
    `INSERT INTO xource (project_id, ref, head_commit) VALUES ($1,'main','deadbeef') RETURNING id`,
    [projectId])).id;
  clean.push(cleanQ(`DELETE FROM xource WHERE id=$1`, [xo]));
  const x = await one(
    `INSERT INTO xell (project_id, xource_id, slug, branch, status, zee_type)
       VALUES ($1,$2,$3,'spinoff/'||$3,'working','worker') RETURNING *`,
    [projectId, xo, slug]);
  clean.push(cleanQ(`DELETE FROM xell WHERE id=$1`, [x.id]));
  return x;
};
const insMedic = async (projectId, { status = 'diagnosing' } = {}) => {
  const m = await one(
    `INSERT INTO medic (target_project_id, brief, status) VALUES ($1, 'test', $2) RETURNING *`,
    [projectId, status]);
  clean.push(cleanQ(`DELETE FROM zee WHERE medic_id=$1`, [m.id]));
  clean.push(cleanQ(`DELETE FROM medic_action WHERE medic_id=$1`, [m.id]));
  clean.push(cleanQ(`DELETE FROM medic_call WHERE medic_id=$1`, [m.id]));
  clean.push(cleanQ(`DELETE FROM medic WHERE id=$1`, [m.id]));
  return m;
};
const insCondition = async (projectId, body) => {
  const c = await one(
    `INSERT INTO project_condition (project_id, body, created_by, updated_by)
       VALUES ($1,$2,'test','test') RETURNING *`,
    [projectId, body]);
  clean.push(cleanQ(`DELETE FROM project_condition WHERE id=$1`, [c.id]));
  return c;
};
const countLive = (xellId) => one(
  `SELECT count(*)::int AS n FROM medic_call WHERE xell_id=$1 AND status IN ('open','attended')`,
  [xellId]);

try {
  // ── fixture project + xell ──────────────────────────────────────────────────
  const project = { id: await insProject(`mc-p-${tag}`) };
  const xell = await insXell(project.id, `mc-x-${tag}`);
  await q(`UPDATE xell SET preflight_error=$2 WHERE id=$1`,
          [xell.id, 'db preflight failed: could not connect to shared dev db']);
  await insCondition(project.id, 'PROVISION-INFRA: no shared dev db for this project on this machine');
  // A GENERAL impediment — NOT a proof-routing fault card. The conditions list on a live project is
  // mostly these; they must not ride a medic call as "provision fault card" evidence.
  await insCondition(project.id, 'grok auth is down — the console login flow is degraded');

  // ── 1. evidence — the SAME fleet trusts, collected server-side ─────────────
  console.log('\n── evidence: the recorded facts, stamped at call time ──');
  const evidence = await collectCallEvidence(xell);
  ok(Array.isArray(evidence) && evidence.length >= 2,
     `collectCallEvidence returned ${evidence.length} item(s)`);
  ok(evidence.some((e) => e.trust === 'db-preflight' && /preflight/.test(e.label)),
     'the failing db preflight (xell.preflight_error) is the db-preflight trust');
  ok(evidence.some((e) => e.trust === 'condition' && /PROVISION-INFRA/.test(e.detail)),
     'a live provision fault card is folded in (the brief a medic would be handed)');
  ok(!evidence.some((e) => e.trust === 'condition' && /grok auth/.test(e.detail)),
     'a NON-PROVISION-INFRA condition (a general impediment) is NOT folded in as evidence');

  // ── 1b. empty evidence: no infra facts → the honest advice fires ───────────
  console.log('\n── empty evidence: no infra facts on the xell → the plain "no evidence" advice ──');
  // A FRESH project with NO fault cards and NO preflight/proof errors (its own project, so the
  // PROVISION-INFRA card on `project` above is not in scope) — but WITH a general impediment, to
  // prove even that does not manufacture evidence for a xell that has none.
  const plainProject = { id: await insProject(`mc-plain-p-${tag}`) };
  const plain = await insXell(plainProject.id, `mc-plain-x-${tag}`);
  await insCondition(plainProject.id, 'grok auth is down — the console login flow is degraded');
  const plainEv = await collectCallEvidence(plain);
  ok(Array.isArray(plainEv) && plainEv.length === 0,
     `a xell with no infra facts has ${plainEv.length} evidence items (its project\'s general impediment is not evidence)`);
  const rPlain = await raiseMedicCall({ xell: plain, reason: 'pool stopped filling — is the dev db down?',
                                        kind: 'db', zeeId: null });
  ok(rPlain.ok === true && rPlain.routed === 'raised', 'a raise with no evidence still routes raised');
  ok(rPlain.evidence === 0, 'the raise answer reports evidence.length 0');
  ok(/No infra evidence was found on this xell/.test(rPlain.message)
     && /`zee tend`/.test(rPlain.message),
     'the raise answer carries the empty-evidence advice (own code/test fault is `zee tend`, not a medic)');

  // ── 2. raise with NO live medic → 'raised' ─────────────────────────────────
  console.log('\n── raise: no live medic → an OPEN call (a human dispatches; nothing auto-spawns) ──');
  const r1 = await raiseMedicCall({ xell, reason: 'the shared dev db is down — pool will not fill',
                                    kind: 'db', zeeId: null });
  ok(r1.ok === true && r1.routed === 'raised', `first raise routes 'raised' (got ${r1.routed})`);
  ok(/human dispatches/.test(r1.message) && /NOTHING auto-spawns/.test(r1.message),
     'the raise answer says plainly that a human dispatches and nothing auto-spawns');
  const c1 = await one(`SELECT * FROM medic_call WHERE id=$1`, [r1.call_id]);
  ok(c1 && c1.status === 'open' && c1.kind === 'db' && c1.reason.includes('shared dev db'),
     'the call row is open, kind db, carrying the zee\'s own words');
  ok(c1.medic_id === null, 'no medic is linked (it is a called emergency, awaiting dispatch)');
  ok((await countLive(xell.id)).n === 1, 'exactly ONE live call per xell');

  // ── 3. one live call per xell: a second raise UPDATES, never inserts ───────
  console.log('\n── the rate limit: a second call UPDATES the open call (the partial unique index) ──');
  const r2 = await raiseMedicCall({ xell, reason: 'still down — retrying will not help',
                                    kind: 'build', zeeId: null });
  ok(r2.ok === true && r2.call_id === r1.call_id,
     'the second call returns the SAME call id (it updated the live call)');
  const c2 = await one(`SELECT * FROM medic_call WHERE id=$1`, [r1.call_id]);
  ok(c2.kind === 'build' && /retrying will not help/.test(c2.reason),
     'the live call now carries the SECOND words (updated in place)');
  ok((await countLive(xell.id)).n === 1, 'still exactly ONE live call (the index held)');

  // ── 4. status + list ───────────────────────────────────────────────────────
  console.log('\n── read + list ──');
  const read1 = await readMedicCallForXell(xell.id);
  ok(read1 && read1.id === c2.id && read1.status === 'open' && read1.xell_slug === xell.slug,
     'readMedicCallForXell returns the live call with the xell slug');
  const openList = await listProjectMedicCalls(project.id, { liveOnly: true });
  ok(openList.some((c) => c.id === c2.id), 'listProjectMedicCalls(liveOnly) includes the open call');

  // ── 5. withdraw: lowers a live call; the next raise is a FRESH row ─────────
  console.log('\n── withdraw ──');
  const w = await withdrawMedicCall(xell.id, { by: xell.slug });
  ok(w && w.status === 'withdrawn' && /withdrawn by/.test(w.resolution),
     'withdraw lowers the live call to withdrawn with a resolution line');
  ok((await countLive(xell.id)).n === 0, 'no live call after withdraw');
  const r3 = await raiseMedicCall({ xell, reason: 'withdrew too soon — actually still blocked',
                                    kind: 'other', zeeId: null });
  ok(r3.ok === true && r3.call_id !== c2.id,
     'a raise after withdraw is a FRESH call (withdrawn rows do not count against the live index)');

  // ── 6. dispatch + answer: scoped to the medic's OWN attended call ──────────
  console.log('\n── the medic answers the call it is ATTENDING (call_answer) ──');
  const medic = await insMedic(project.id);
  // The human-dispatch outcome (the console button): link the call to the medic, mark attended.
  await q(`UPDATE medic_call SET medic_id=$2, status='attended', updated_at=now() WHERE id=$1`,
          [r3.call_id, medic.id]);
  const otherMedic = await insMedic(project.id);
  const notYours = await answerMedicCall({ medic: otherMedic, callId: r3.call_id,
                                           decision: 'resolved', note: 'sneak' });
  ok(notYours.refused === true && /is yours to answer/.test(notYours.reason),
     'a medic that is NOT attending the call cannot answer it (scoped WHERE medic_id)');

  const badDecision = await answerMedicCall({ medic, callId: r3.call_id,
                                              decision: 'maybe', note: 'x' });
  ok(badDecision.refused === true && /"resolved" or "declined"/.test(badDecision.reason),
     'call_answer accepts only resolved/declined');
  const noNote = await answerMedicCall({ medic, callId: r3.call_id, decision: 'declined', note: '' });
  ok(noNote.refused === true && /note is required/.test(noNote.reason),
     'a note is required (it is what the calling zee receives)');

  const declined = await answerMedicCall({ medic, callId: r3.call_id, decision: 'declined',
                                           note: 'this is a fault in your own test setup — run zee tend, not a medic' });
  ok(declined.ok === true && declined.status === 'declined',
     'answerMedicCall declined returns ok');
  const c3 = await one(`SELECT * FROM medic_call WHERE id=$1`, [r3.call_id]);
  ok(c3.status === 'declined' && /zee tend/.test(c3.resolution),
     'the call row is declined with the resolution note');
  const msg = await one(
    `SELECT * FROM zee_message WHERE to_xell_id=$1 AND kind='message'
      ORDER BY created_at DESC LIMIT 1`, [xell.id]);
  clean.push(cleanQ(`DELETE FROM zee_message WHERE id=$1`, [msg.id]));
  ok(msg && /DECLINED/.test(msg.body) && /⛑medic:/.test(msg.from_slug),
     'the note was POSTED BACK to the calling xell as a zee_message from ⛑medic:…');
  ok(/zee tend/.test(msg.body),
     'a declined call points the zee at `zee tend` (a medic fixes ZEEHIVE config/infra, not own-code faults)');
  ok(!(await listProjectMedicCalls(project.id, { liveOnly: true })).some((c) => c.id === c3.id),
     'a declined call no longer nags the live-only list');

  // ── 7. attach: a LIVE medic routes the raise to 'attached' ─────────────────
  console.log('\n── attach: a LIVE medic on the project receives the call ──');
  const medicLive = await insMedic(project.id); // status defaults 'diagnosing' — a live medic
  const r4 = await raiseMedicCall({ xell, reason: 'the db preflight still fails — please look now',
                                    kind: 'db', zeeId: null });
  ok(r4.ok === true && r4.routed === 'attached' && r4.medic_id === medicLive.id,
     `a raise with a live medic routes 'attached' to medic ${String(medicLive.id).slice(0, 8)}`);
  const c4 = await one(`SELECT * FROM medic_call WHERE id=$1`, [r4.call_id]);
  ok(c4 && c4.status === 'attended' && c4.medic_id === medicLive.id,
     'the live call is attended, linked to the live medic (the emergency is being handled)');
  ok((await countLive(xell.id)).n === 1, 'still one live call — attach updated the same row');
  // BLOCKING-1: a medic can never discover the call it is attending if neither brief carries the
  // call id — the attach resume and the dispatch brief must both name it.
  const attachMsg = buildCallAttachMessage(c4, xell.slug);
  ok(attachMsg.includes(String(c4.id)),
     'the attach resume message names the CALL ID (the medic knows which call to answer)');
  const dispatchBrief = buildCallDispatchBrief(c4, xell.slug);
  ok(dispatchBrief.includes(String(c4.id)),
     'the human-dispatch brief names the CALL ID (the dispatched medic knows which call it is on)');
  // The exclusion assertion needs a medic that STAYS live: the background resume above has no
  // provider creds on this sandbox, so it may error medicLive moments after the attach. Re-point
  // the call at the never-resumed live `medic` row from section 6 and re-assert the list logic.
  await q(`UPDATE medic SET status='diagnosing' WHERE id=$1`, [medicLive.id]);
  await q(`UPDATE medic_call SET medic_id=$2, status='attended', updated_at=now() WHERE id=$1`,
          [c4.id, medic.id]);
  const attendedList = await listProjectMedicCalls(project.id, { liveOnly: true });
  ok(!attendedList.some((c) => c.id === c4.id),
     'an ATTENDED call whose medic is live does not nag the live-only emergency list');
  // BLOCKING-1 (the tool side): the live-only feed EXCLUDES an attended call whose medic is live BY
  // DESIGN — so a medic that only read that feed could never discover the very call it is attending.
  // The calls tool must ALSO return the medic's OWN attended calls (a separate read, never by
  // widening the emergency filter). `medic` is the live medic now holding c4.
  const { runMedicTool } = await import('../server/src/lib/medic-tools.js');
  const ownCalls = JSON.parse(await runMedicTool(medic, { name: 'calls', args: {} }));
  ok(ownCalls.ok === true && (ownCalls.calls || []).some((c) => c.id === c4.id),
     'the attending medic\'s calls tool returns the call it is ATTENDING (the loop closes)');

  // ── 7b. SHOULD-3: concurrent raises race the partial unique index ──────────
  console.log('\n── concurrent raises: idempotent against the one-live-call-per-xell index ──');
  const concProject = { id: await insProject(`mc-conc-p-${tag}`) };
  const concXell = await insXell(concProject.id, `mc-conc-${tag}`);
  const concurrency = await Promise.allSettled([
    raiseMedicCall({ xell: concXell, reason: 'concurrent raise one', kind: 'db', zeeId: null }),
    raiseMedicCall({ xell: concXell, reason: 'concurrent raise two', kind: 'build', zeeId: null }),
  ]);
  ok(concurrency.every((r) => r.status === 'fulfilled'),
     'both concurrent raises SETTLE (neither rejects with a unique-violation)');
  const concValues = concurrency.map((r) => (r.status === 'fulfilled' ? r.value : null));
  ok(concValues.every((v) => v && v.ok) && new Set(concValues.map((v) => v?.call_id)).size === 1,
     'both concurrent raises land on the SAME live call id (one live call per xell held)');
  ok((await countLive(concXell.id)).n === 1, 'exactly one live call row survives the concurrency');

  // ── 7c. SHOULD-4: a retired xell's stale CALLED row does not nag the ⛑ bar ──
  console.log('\n── dead xells: a retired xell\'s open call does not nag the emergency list ──');
  const deadProject = { id: await insProject(`mc-dead-p-${tag}`) };
  const deadXell = await insXell(deadProject.id, `mc-dead-${tag}`);
  await q(`UPDATE xell SET status='retired' WHERE id=$1`, [deadXell.id]);
  const deadCall = await raiseMedicCall({ xell: deadXell, reason: 'stale call after retirement',
                                          kind: 'other', zeeId: null });
  ok(deadCall.ok === true && deadCall.routed === 'raised',
     'a retired xell raising still records (the row is history)');
  const deadList = await listProjectMedicCalls(deadProject.id, { liveOnly: true });
  ok(!deadList.some((c) => c.id === deadCall.call_id),
     'the retired xell\'s OPEN call is NOT in the live-only emergency feed');

  // ── 8. the ROUTES over real HTTP (a fresh project with NO live medic) ──────
  console.log('\n── the routes: zee medic (token-scoped), console list + dispatch (real HTTP) ──');
  const { router } = await import('../server/src/api/routes.js');
  const httpProject = { id: await insProject(`mc-http-${tag}`) };
  const httpXell = await insXell(httpProject.id, `mc-http-${tag}`);
  await q(`UPDATE xell SET preflight_error=$2 WHERE id=$1`,
          [httpXell.id, 'http e2e db preflight failing']);
  const httpToken = await mintXellToken(httpXell.id);
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  clean.push(async () => { await new Promise((r) => server.close(r)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const auth = { 'content-type': 'application/json', authorization: `Bearer ${httpToken}` };
  const post = (path, body, headers = auth) => fetch(`${base}${path}`, {
    method: 'POST', headers, body: JSON.stringify(body || {}) });

  const raised = await (await post('/xell/self/medic', { reason: 'db preflight keeps failing', kind: 'db' })).json();
  ok(raised.ok === true && raised.routed === 'raised',
     'POST /xell/self/medic with a REAL xell token routes raised (evidence ' + raised.evidence + ')');
  const statusBody = await (await post('/xell/self/medic', { status: true })).json();
  ok(statusBody.ok === true && statusBody.call?.status === 'open' && statusBody.call?.kind === 'db',
     'POST /xell/self/medic {status} reads the open call back');
  const listRes = await fetch(`${base}/medic-calls?project=${httpProject.id}`);
  const listBody = await listRes.json();
  ok(listRes.status === 200 && (listBody.calls || []).some((c) => c.id === raised.call_id),
     'GET /medic-calls?project= returns the CALLED emergency for a human to dispatch');
  const dispatchRes = await post(`/medic-calls/${raised.call_id}/dispatch`, {},
                                  { 'content-type': 'application/json' });
  const dispatchBody = await dispatchRes.json();
  ok(dispatchRes.status === 200 && !!dispatchBody.medic_id,
     'POST /medic-calls/:id/dispatch answers with a medic id (nothing auto-spawned — the human clicked)');
  const dispatched = await one(`SELECT status, medic_id FROM medic_call WHERE id=$1`, [raised.call_id]);
  ok(dispatched.status === 'attended' && dispatched.medic_id !== null,
     'the dispatched call is ATTENDED and linked to the medic (the Bay will show it)');
  // SHOULD-5: a failed attach-resume leaves the call 'attended' against an ERRORED medic — the
  // dispatch route must not strand the emergency behind that status; an attended call whose medic is
  // no longer LIVE is dispatchable again (a fresh medic is dispatched).
  await q(`UPDATE medic SET status='errored' WHERE id=$1`, [dispatchBody.medic_id]);
  const reDispatchRes = await post(`/medic-calls/${raised.call_id}/dispatch`, {},
                                   { 'content-type': 'application/json' });
  const reDispatchBody = await reDispatchRes.json();
  ok(reDispatchRes.status === 200 && !!reDispatchBody.medic_id
     && reDispatchBody.medic_id !== dispatchBody.medic_id,
     'an ATTENDED call whose medic ERRORED is dispatchable again (a fresh medic is dispatched)');

  // ── 9. BLOCKING-2 (doc half): the infra-medic manual documents calls/call_answer ──
  console.log('\n── the infra-medic manual documents calls/call_answer (house rule 9, by migration) ──');
  const man = await one(`SELECT harness_memory_get('infra-medic','memory/infra-medic-manual.md') AS manual`);
  ok(!!man && !!man.manual && /call_answer/.test(man.manual) && /calls/.test(man.manual)
     && /medic_call.*REFUSE|REFUSE.*medic_call/s.test(man.manual),
     'the infra-medic manual (harness memory) names calls + call_answer and puts medic_call on the REFUSE list');
} catch (e) {
  console.error('UNCAUGHT', e);
  fail++;
} finally {
  for (const fn of clean.reverse()) { try { await fn(); } catch { /* best-effort teardown */ } }
}

console.log(fail ? `\n${fail} FAILURE(S)\n` : '\nall good\n');
process.exit(fail ? 1 : 0);
