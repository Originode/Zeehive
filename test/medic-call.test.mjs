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
//   7. THE BADGE FACT (256): the fleet snapshot carries `medic_call:{live,kind}` on the xell row for
//      an OPEN call or an ATTENDED call whose medic is no longer live — the honeycomb paints the ⛑
//      from that fact and must not re-query (fleet.js fetchXellRows).
//   8. THE PATIENT IS GONE (256): retiring a xell WITHDRAWS its live call with a reason
//      (withdrawMedicCallsForRetiredXell, driven by reaper.js) instead of letting the fleet fold-in's
//      retired-exclusion swallow it — the receipt survives in the history.
//   9. THE BACKFILL (migration 256): the migration's own SQL marks a pre-existing retired-xell call
//      withdrawn with the same reason, and touches nothing the rule would not catch.
//  10. BOTH PATHS CARRY IT (256): the badge fact is asserted on getFleet AND on streamXells — the
//      progressive path the honeycomb actually paints from. One shared helper, two callers: covering
//      only one would let a param slip in the other paint a hive of hexes with no ⛑ and stay green.
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
  listProjectMedicCalls, withdrawMedicCall, answerMedicCall, dismissMedicCall,
  buildCallAttachMessage, buildCallDispatchBrief,
  withdrawMedicCallsForRetiredXell, RETIRED_PATIENT_WITHDRAWAL_REASON,
} = await import('../server/src/lib/medic-calls.js');
const { readFileSync } = await import('node:fs');
const { fingerprintMedicText, createMedicDismissal, undoMedicDismissal, listMedicDismissals } =
  await import('../server/src/lib/medic-dismissals.js');

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
// An UNPOOLED, WORKING xell WITH a live zee and a failing db preflight — the exact shape fleet.js
// turns into medic_emergency source:'infra' (a live zee blocked by an infra fault). getFleet needs
// no real git checkout (the fleet-conditions test drives the same function from a /tmp repo_root),
// but the emergency gate is "a zee is live AND the xell is not pooled stock", so the fixture must
// carry both.
const insLiveBlockedXell = async (projectId, slug, preflight) => {
  const xo = (await one(
    `INSERT INTO xource (project_id, ref, head_commit) VALUES ($1,'main','deadbeef') RETURNING id`,
    [projectId])).id;
  clean.push(cleanQ(`DELETE FROM xource WHERE id=$1`, [xo]));
  const x = await one(
    `INSERT INTO xell (project_id, xource_id, slug, branch, status, zee_type, is_pooled, worktree_path)
       VALUES ($1,$2,$3,'spinoff/'||$3,'working','worker',false,'/tmp/'||$3) RETURNING *`,
    [projectId, xo, slug]);
  clean.push(cleanQ(`DELETE FROM xell WHERE id=$1`, [x.id]));
  const z = await one(
    `INSERT INTO zee (xell_id, attach_mode, entrypoint, status, viewer_kind)
       VALUES ($1,'headless-spawn','cxell-cli','working','ssh-terminal') RETURNING id`,
    [x.id]);
  clean.push(cleanQ(`DELETE FROM zee WHERE id=$1`, [z.id]));
  await q(`UPDATE xell SET preflight_error=$2 WHERE id=$1`, [x.id, preflight]);
  return x;
};

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

  // ── 10. the HUMAN dismisses a CALLED emergency (dismiss = DECLINE, a THIRD actor) ──
  console.log('\n── human dismiss of a CALLED emergency: decline + note, never a dispatch ──');
  const humanProject = { id: await insProject(`mc-hum-p-${tag}`) };
  const humanXell = await insXell(humanProject.id, `mc-hum-${tag}`);
  await q(`UPDATE xell SET preflight_error=$2 WHERE id=$1`,
          [humanXell.id, 'human-dismiss preflight failing']);
  const hCall = await raiseMedicCall({ xell: humanXell, reason: 'shared dev db is down',
                                       kind: 'db', zeeId: null });
  const emptyNote = await dismissMedicCall({ callId: hCall.call_id, note: '   ' });
  ok(emptyNote.refused === true && /note is required/.test(emptyNote.reason),
     'an EMPTY note is refused — a declined call must say why (the note is what the zee receives)');
  const medicsBefore = (await one(`SELECT count(*)::int AS n FROM medic`)).n;
  const hd = await dismissMedicCall({ callId: hCall.call_id,
    note: 'fixing the db myself — re-open with a fresh call if still stuck', by: 'human@console' });
  ok(hd.ok === true && hd.status === 'declined',
     'dismissMedicCall declines the call (a HUMAN — distinct from the zee\'s withdraw and the medic\'s answer)');
  const hrow = await one(`SELECT * FROM medic_call WHERE id=$1`, [hCall.call_id]);
  ok(hrow.status === 'declined' && !!hrow.dismissed_at && hrow.dismissed_by === 'human@console',
     'the call row is declined with dismissed_at + dismissed_by stamped');
  const medicsAfter = (await one(`SELECT count(*)::int AS n FROM medic`)).n;
  ok(medicsAfter === medicsBefore, 'a dismissal does NOT dispatch a medic (the medic count is unchanged)');
  const hmsg = await one(
    `SELECT * FROM zee_message WHERE to_xell_id=$1 AND kind='message'
      ORDER BY created_at DESC LIMIT 1`, [humanXell.id]);
  clean.push(cleanQ(`DELETE FROM zee_message WHERE id=$1`, [hmsg.id]));
  ok(hmsg && /DECLINED/.test(hmsg.body) && /⛑human/.test(hmsg.from_slug),
     'the decline is POSTED BACK to the calling zee as a zee_message from ⛑human');
  ok(/fixing the db myself/.test(hmsg.body),
     'the note itself is the message body — the calling zee reads WHY it was declined');
  ok(/zee tend/.test(hmsg.body),
     'a human DECLINE carries the same `zee tend` pointer as the medic\'s decline (own-code faults are not a medic)');
  const again = await dismissMedicCall({ callId: hCall.call_id, note: 'trying twice' });
  ok(again.refused === true && /already declined/.test(again.reason),
     'a second dismiss of the same call is refused (declined is final history)');
  ok(!(await listProjectMedicCalls(humanProject.id, { liveOnly: true })).some((c) => c.id === hCall.call_id),
     'a declined call no longer nags the live-only emergency feed');
  const { selfMedicCall } = await import('../server/src/queenzee/self.js');
  const st = await selfMedicCall(humanXell, { status: true });
  ok(st.ok === true && /declined/.test(st.message)
     && /Why it was declined: fixing the db myself/.test(st.message),
     '`zee medic --status` on a human-declined call shows the declined note (the durable copy, not just the one-shot message)');

  // ── 10b. the dismiss ROUTES over real HTTP (console = no worker token; worker = refused) ──
  console.log('\n── the dismiss routes (real HTTP, console vs an identified worker) ──');
  const http2Project = { id: await insProject(`mc-http2-p-${tag}`) };
  const http2Xell = await insXell(http2Project.id, `mc-http2-${tag}`);
  await q(`UPDATE xell SET preflight_error=$2 WHERE id=$1`,
          [http2Xell.id, 'http2 dismiss preflight failing']);
  const http2Token = await mintXellToken(http2Xell.id);
  const auth2 = { 'content-type': 'application/json', authorization: `Bearer ${http2Token}` };
  const raised2 = await (await post('/xell/self/medic', { reason: 'db is down', kind: 'db' }, auth2)).json();
  ok(raised2.ok === true && raised2.routed === 'raised', 'fresh CALLED emergency raised for the route test');
  const workerDismiss = await (await post(`/medic-calls/${raised2.call_id}/dismiss`,
                                          { reason: 'worker sneaking a dismiss' }, auth2)).json();
  ok(workerDismiss.ok === false && workerDismiss.status === 'refused',
     'an identified WORKER token is REFUSED on the dismiss route (workers do not dismiss)');
  const noNoteRes = await (await post(`/medic-calls/${raised2.call_id}/dismiss`, { reason: '' },
                                      { 'content-type': 'application/json' })).json();
  ok(noNoteRes.ok === false && /note is required/.test(noNoteRes.error || ''),
     'POST dismiss with an empty note → refused with a legible error (siteCall throws it)');
  const noAuthDismiss = await (await post(`/medic-calls/${raised2.call_id}/dismiss`,
                                          { reason: 'will re-provision by hand' },
                                          { 'content-type': 'application/json' })).json();
  ok(noAuthDismiss.ok === true && noAuthDismiss.status === 'declined',
     'POST dismiss from the console (no token) declines the call');
  const dismRow = await one(`SELECT status, dismissed_by FROM medic_call WHERE id=$1`, [raised2.call_id]);
  ok(dismRow.status === 'declined' && dismRow.dismissed_by === 'human@console',
     'the route decline is recorded as human@console on the row');
  const sugRes = await (await post('/medic-dismissals',
      { target_kind: 'xell', target_id: http2Xell.id, text: 'db preflight failing: http2 dismiss preflight failing',
        reason: 'hand-fixing' }, { 'content-type': 'application/json' })).json();
  ok(sugRes.ok === true && !!sugRes.dismissed?.id && !!sugRes.dismissed?.fingerprint,
     'POST /medic-dismissals stores a fingerprinted xell dismissal');
  const sugId = sugRes.dismissed.id;
  const delRes = await (await fetch(`${base}/medic-dismissals/${sugId}`,
                                   { method: 'DELETE' })).json();
  ok(delRes.ok === true && delRes.undone?.id === sugId,
     'DELETE /medic-dismissals/:id undoes it (the emergency raises again)');

  // ── 11. fingerprint: same fault hides, a changed fault re-raises (the FLEET layer) ──
  console.log('\n── fingerprinted dismissal at the FLEET layer (same fault hides; a changed fault re-raises) ──');
  const { getFleet } = await import('../server/src/lib/fleet.js');
  const WHY = 'db preflight failing: cannot reach the shared dev db';
  const fleetProject = { id: await insProject(`mc-fleet-p-${tag}`) };
  const fleetXell = await insLiveBlockedXell(fleetProject.id, `mc-fleet-${tag}`, WHY);
  const f1 = await getFleet(fleetProject.id);
  const infraRow = (f1.medic_emergency || []).find((e) => e.xell_id === fleetXell.id && e.source === 'infra');
  ok(!!infraRow && /shared dev db/.test(infraRow.why),
     'fleet medic_emergency carries the infra row BEFORE any dismissal');
  const fp = fingerprintMedicText(infraRow.why);
  ok(fp.length === 64 && fp !== fingerprintMedicText('a completely different fault'),
     'fingerprintMedicText is a sha256 hex that differs across fault texts');
  const created = await createMedicDismissal({ targetKind: 'xell', targetId: fleetXell.id,
                                               text: infraRow.why, reason: 'hand-fixing the db' });
  ok(created.ok === true && created.dismissed.fingerprint === fp,
     'createMedicDismissal fingerprints the EXACT shown text');
  const f2 = await getFleet(fleetProject.id);
  ok(!(f2.medic_emergency || []).some((e) => e.xell_id === fleetXell.id),
     'the SAME infra fault stops nagging the ⛑ panel after dismissal');
  const activeRow = (f2.medic_dismissals || []).find((d) => d.target_kind === 'xell'
                     && d.target_id === fleetXell.id);
  ok(!!activeRow && activeRow._active === true && /hand-fixing/.test(activeRow.reason || ''),
     'fleet reports the dismissal as ACTIVE (the muted "N dismissed · UNDO" line)');
  const undone = await undoMedicDismissal(activeRow.id);
  ok(!!undone && undone.id === activeRow.id,
     'undoMedicDismissal deletes the row (the visible way back)');
  const f2b = await getFleet(fleetProject.id);
  ok((f2b.medic_emergency || []).some((e) => e.xell_id === fleetXell.id),
     'UNDO restores the ask at the next snapshot — hiding a real emergency always has a way back');
  // Re-dismiss, then let the fault CHANGE: the dismissal row stays but stops matching, so the
  // DIFFERENT fault re-raises by itself. No timers — the fingerprint IS the expiry.
  await createMedicDismissal({ targetKind: 'xell', targetId: fleetXell.id,
                               text: infraRow.why, reason: 'hand-fixing again' });
  await q(`UPDATE xell SET preflight_error=$2 WHERE id=$1`,
          [fleetXell.id, 'cannot reach the shared dev db ANYMORE']);
  const f3 = await getFleet(fleetProject.id);
  ok((f3.medic_emergency || []).some((e) => e.xell_id === fleetXell.id),
     'a CHANGED fault raises again by itself (a different fingerprint no longer matches)');
  ok(!(f3.medic_dismissals || []).some((d) => d._active === true && d.target_id === fleetXell.id),
     'the stale dismissal is no longer ACTIVE — it still exists but hides nothing');
  const stale = await listMedicDismissals(fleetProject.id);
  ok(stale.some((d) => d.target_id === fleetXell.id),
     'the stale row is still in the table (dismissal never resolves the fault — only the fingerprint expires)');

  // ── 12. condition-card dismissal is fingerprinted on the body, never deletes the line ──
  console.log('\n── condition-card dismissal: fingerprint on the body; the line survives ──');
  const condProject = { id: await insProject(`mc-cond-p-${tag}`) };
  const condXell = await insLiveBlockedXell(condProject.id, `mc-cond-${tag}`,
                                            'provision proof failing: no addresses');
  const condLine = await insCondition(condProject.id, 'PROVISION-INFRA: address pool exhausted on this machine');
  const cf1 = await getFleet(condProject.id);
  ok((cf1.medic_emergency || []).some((e) => e.xell_id === condXell.id)
     && (cf1.conditions || []).some((c) => c.id === condLine.id),
     'fleet carries both the infra zee and the condition card before dismissal');
  const condD = await createMedicDismissal({ targetKind: 'condition', targetId: condLine.id,
                                             text: String(condLine.body || ''), reason: 'fixing by hand' });
  ok(condD.ok === true && condD.dismissed.target_kind === 'condition',
     'a condition-card dismissal is stored with target_kind condition');
  const cf2 = await getFleet(condProject.id);
  ok(!(cf2.conditions || []).some((c) => c.id === condLine.id),
     'the dismissed condition leaves the needs-you CONDITIONS feed (the ⛑ card hides)');
  ok((cf2.medic_dismissals || []).some((d) => d.target_kind === 'condition' && d.target_id === condLine.id
     && d._active === true),
     '…and is reported ACTIVE for the muted UNDO line');
  const lineStill = await one(`SELECT body FROM project_condition WHERE id=$1`, [condLine.id]);
  ok(!!lineStill && lineStill.body.includes('PROVISION-INFRA'),
     'dismissal NEVER deletes the condition line — it only hides the dispatch ask');

  // ── 13. THE BADGE FACT (256): the fleet row SAYS a live call is out there ──
  // The honeycomb paints a ⛑ on the hex and must not re-query per hexagon, so the fact rides the
  // fleet snapshot's xell row. It must track the SAME live predicate as the ⛑ feed: OPEN, or
  // ATTENDED with a medic that is no longer live. The row is what the canvas reads; this drives
  // getFleet — the real read model — not the predicate in isolation.
  console.log('\n── the ⛑ badge fact rides the xell row (the honeycomb must not re-query) ──');
  const badgeProject = { id: await insProject(`mc-badge-p-${tag}`) };
  const badgeXell = await insLiveBlockedXell(badgeProject.id, `mc-badge-${tag}`,
                                             'badge test preflight failing');
  const rowOf = (f) => (f.xells || []).find((x) => x.id === badgeXell.id);
  const b0 = await getFleet(badgeProject.id);
  ok(rowOf(b0)?.medic_call === null,
     'no call → the row carries NO badge fact (medic_call is null)');
  const bRaise = await raiseMedicCall({ xell: badgeXell, reason: 'the badge should show for this',
                                        kind: 'build', zeeId: null });
  const b1 = await getFleet(badgeProject.id);
  ok(rowOf(b1)?.medic_call?.live === true && rowOf(b1)?.medic_call?.kind === 'build',
     'an OPEN call → the row carries medic_call {live:true, kind:"build"}');
  await withdrawMedicCall(badgeXell.id, { by: 'test' });
  const b2 = await getFleet(badgeProject.id);
  ok(rowOf(b2)?.medic_call === null,
     'a withdrawn call → the badge fact is cleared (the hex loses the ⛑)');
  // ATTENDED while its medic is LIVE is being handled — no badge (the same rule the ⛑ feed uses).
  // Point the call at a medic the attach path NEVER resumes: the sandbox has no provider creds, so
  // the auto-resume of an attached medic errors it moments later (the caveat section 7 documents),
  // and a racing status would make this assertion about the driver, not about the predicate. The
  // row-level routing is what is under test, exactly as section 7 re-points its call for the same
  // reason.
  const badgeMedic = await insMedic(badgeProject.id);           // status 'diagnosing' — live
  await q(`UPDATE medic_call SET medic_id=$2, status='attended', updated_at=now() WHERE id=$1`,
          [bRaise.call_id, badgeMedic.id]);
  const b3 = await getFleet(badgeProject.id);
  ok(rowOf(b3)?.medic_call === null,
     'an ATTENDED call whose medic is LIVE → no badge (it is being handled)');
  await q(`UPDATE medic SET status='errored' WHERE id=$1`, [badgeMedic.id]);
  const b4 = await getFleet(badgeProject.id);
  ok(rowOf(b4)?.medic_call?.live === true && rowOf(b4)?.medic_call?.kind === 'build',
     'the same call with its medic no longer live → the badge is BACK (the emergency is real again)');

  // ── 14. THE PATIENT IS GONE: retirement WITHDRAWS, never swallows (256) ────
  console.log('\n── a retired patient\'s call is WITHDRAWN with a reason (receipt survives) ──');
  const goneProject = { id: await insProject(`mc-gone-p-${tag}`) };
  const goneXell = await insXell(goneProject.id, `mc-gone-${tag}`);
  const gRaise = await raiseMedicCall({ xell: goneXell, reason: 'still blocked when the xell is reaped',
                                        kind: 'db', zeeId: null });
  const withdrawnRows = await withdrawMedicCallsForRetiredXell(goneXell.id);
  ok(withdrawnRows.length === 1 && withdrawnRows[0].id === gRaise.call_id
     && withdrawnRows[0].status === 'withdrawn',
     'retiring the patient withdraws exactly its one live call');
  const gRow = await one(`SELECT * FROM medic_call WHERE id=$1`, [gRaise.call_id]);
  ok(gRow.status === 'withdrawn' && /patient is gone/.test(gRow.resolution || ''),
     'the withdrawal CARRIES THE REASON (the receipt, not a silent delete)');
  ok(gRow.resolution === RETIRED_PATIENT_WITHDRAWAL_REASON,
     'the reason is the ONE exported string (code and migration must say the same thing)');
  ok((await countLive(goneXell.id)).n === 0, 'no live call survives the retirement');
  ok(!(await listProjectMedicCalls(goneProject.id, { liveOnly: true })).some((c) => c.id === gRaise.call_id),
     'the call leaves the live-only ⛑ feed (a dead xell cannot be blocked)');
  ok((await listProjectMedicCalls(goneProject.id, { liveOnly: false })).some((c) => c.id === gRaise.call_id),
     '…but the RECEIPT survives in the full history — that is the whole point');
  ok((await withdrawMedicCallsForRetiredXell(goneXell.id)).length === 0,
     'running the withdrawal again is a no-op (idempotent — nothing left to withdraw)');

  // ── 15. THE BACKFILL (migration 256): pre-existing retired-xell calls ─────
  console.log('\n── migration 256 backfills the retired-xell calls that predate the rule ──');
  const backProject = { id: await insProject(`mc-back-p-${tag}`) };
  const backXell = await insXell(backProject.id, `mc-back-${tag}`);
  await q(`UPDATE xell SET status='retired' WHERE id=$1`, [backXell.id]);
  // The exact shape the old code silently filtered: an OPEN call on an already-retired xell.
  const backCall = await raiseMedicCall({ xell: backXell, reason: 'predates the retirement rule',
                                          kind: 'other', zeeId: null });
  // …and a LIVE xell's open call, which the rule must NOT catch. Its own project: one xource ref
  // ('main') per project is unique, and insXell opens one per xell.
  const backLiveProject = { id: await insProject(`mc-back-live-p-${tag}`) };
  const backLive = await insXell(backLiveProject.id, `mc-back-live-${tag}`);
  const liveCall = await raiseMedicCall({ xell: backLive, reason: 'a live patient — leave me alone',
                                          kind: 'db', zeeId: null });
  // Run the migration's OWN sql (it is a guarded UPDATE, so re-running on the sandbox is safe) —
  // that is what will run on deploy, so that is what the backfill is asserted against.
  const mig256 = readFileSync(new URL('../db/migrations/256_medic_call_retired_patient_withdrawal.sql',
                                      import.meta.url), 'utf8');
  await q(mig256);
  const backRow = await one(`SELECT * FROM medic_call WHERE id=$1`, [backCall.call_id]);
  ok(backRow.status === 'withdrawn' && /patient is gone/.test(backRow.resolution || ''),
     'the migration marks the pre-existing retired-xell call withdrawn with the SAME reason');
  const liveRow = await one(`SELECT status FROM medic_call WHERE id=$1`, [liveCall.call_id]);
  ok(liveRow.status === 'open',
     'a LIVE xell\'s open call is untouched — the backfill only catches rows the new rule would');
  ok((await listProjectMedicCalls(backProject.id, { liveOnly: false })).some((c) => c.id === backCall.call_id),
     'the backfilled receipt is readable in the history (the operator\'s clean slate, not a delete)');
  await q(mig256);   // second run
  const backRow2 = await one(`SELECT status, resolution FROM medic_call WHERE id=$1`, [backCall.call_id]);
  ok(backRow2.status === 'withdrawn' && backRow2.resolution === backRow.resolution,
     're-running the migration changes nothing (idempotent forward-only ledger)');

  // ── 16. THE SAME FACT ON THE PROGRESSIVE PATH (256) ───────────────────────
  // fetchXellRows has TWO callers and the badge change bound a second parameter to BOTH: getFleet
  // (section 13) and streamXells — the path that paints hexagons one at a time as the fleet loads.
  // §13 alone would leave the streamed path covered by nothing, so a param-order slip there would
  // paint a hive of hexes with no badges and no test would say so. Drive the real stream, not the
  // shared helper, because the helper is exactly what is NOT in doubt.
  console.log('\n── the ⛑ rides the STREAMED row too (the canvas paints from this path) ──');
  const { streamXells } = await import('../server/src/lib/fleet.js');
  const streamProject = { id: await insProject(`mc-stream-p-${tag}`) };
  const streamXell = await insXell(streamProject.id, `mc-stream-${tag}`);
  const seen = [];
  const streamedProj = await streamXells(streamProject.id, async (x) => { seen.push(x); });
  ok(!!streamedProj, 'streamXells returns the project (the query ran — both params bound)');
  ok(seen.length === 1 && 'medic_call' in seen[0],
     'every streamed row carries the medic_call key (the canvas reads a fact, never a query)');
  ok(seen[0]?.medic_call === null, 'no call → null, so no hex is painted with a ⛑');
  await raiseMedicCall({ xell: streamXell, reason: 'the streamed hex must wear the ⛑',
                         kind: 'build', zeeId: null });
  const seen2 = [];
  await streamXells(streamProject.id, async (x) => { seen2.push(x); });
  ok(seen2[0]?.medic_call?.live === true && seen2[0]?.medic_call?.kind === 'build',
     'an OPEN call → the STREAMED row reports {live:true, kind:"build"}');
  ok(!('medic_call_status' in (seen2[0] || {})) && !('medic_call_kind' in (seen2[0] || {})),
     'the raw columns are stripped by decorateXell (the row carries the verdict, not the columns)');
  ok(seen2[0]?.hive_status !== undefined,
     'hive_status is untouched beside it — the badge is not a colour, it rides alongside the status');
} catch (e) {
  console.error('UNCAUGHT', e);
  fail++;
} finally {
  for (const fn of clean.reverse()) { try { await fn(); } catch { /* best-effort teardown */ } }
}

console.log(fail ? `\n${fail} FAILURE(S)\n` : '\nall good\n');
process.exit(fail ? 1 : 0);
