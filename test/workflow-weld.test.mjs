// WORKFLOW WELD — the observability spine: execution → zee_turn → llm_gateway_request
// (docs/hierarchical-workflow-adoption.md §3.2 — the observability join; the WELD stage).
//
// This test proves migration 180 (weld_observability_spine_execution_to_zee_turn) and the two
// weld verbs (selfHandover / selfAwait) and the nested read model (workflowTreeForXell) against a
// REAL postgres with the full migration set applied. It is the weld-stage counterpart of
// test/workflow-stage3.test.mjs / test/workflow-stage5.test.mjs and extends that suite's pattern —
// a standalone node script with a header documenting coverage, a loud SKIP on a non-weld db, and
// teardown in a finally. Coverage:
//
//   A. THE FULL JOINED CHAIN (a) — a simulated dispatch produces the complete drill-down waterfall:
//      an execution (bound to a work_node, entity assigned) is stamped onto a zee_turn by the
//      queenzee (startTurn with executionId, exactly what intake/nudge/self do from the xell
//      binding), and the gateway proxy records llm_gateway_request rows against that turn. The
//      three-way JOIN execution → zee_turn → llm_gateway_request returns the whole chain, and
//      workflowTreeForXell renders it as the nested tree (work_node → execution → turns → gateway
//      calls).
//   B. A TURN WITH NO EXECUTION STILL RECORDS (b) — startTurn without an executionId keeps
//      execution_id NULL, and the turn is still read back by the flat turns list (and does NOT
//      appear in the workflow tree, which is execution-keyed).
//   C. HANDOVER STORES THE TYPED RESULT (c) — zee handover --result '<json>' resolves the execution
//      from the CALLER's xell binding (never an agent-named id) and INTERIM-stores the parsed JSON
//      on execution.outputs (the stage-2 data plane replaces this). A malformed --result is refused.
//      C2 (manager finding 2): a second handover on an execution whose outputs are already set is
//      REFUSED unless --override — a silent overwrite would destroy the earlier result with no trace;
//      with --override it succeeds and the event log (finding 1) keeps the history of both.
//   D. AWAIT ENDS THE TURN AND HOLDS A LEASE (d) — zee await ends the open turn (tokens stop — the
//      anti-spin primitive), marks the zee idle, holds a lease on the execution (the entity bound at
//      dispatch; exactly one HELD lease — a second await extends rather than collides), and moves
//      the execution to 'waiting'.
//   E. (manager findings on the two doors)
//      E1 (finding 1): both doors append IMMUTABLE events to the append-only log (177) — an
//         'execution.handover' for every handover and an 'execution.await' for every await, with
//         seq monotone per run, run_id/execution_id/work_node_id set.
//      E2 (finding 3): await is REFUSED from a terminal state (done/failed/…/compensated) — a
//         finished execution must not be dragged back into 'waiting' under a held lease.
//      E3 (finding 4): when an execution has no entity, await RESOLVES-OR-CREATES by the stable key
//         'agent:<zee.id>' — a second execution for the same zee reuses the SAME entity row (one zee
//         maps to one durable actor), never a fresh identically-named insert.
//      E4 (finding 5): await refuses to extend a HELD lease that belongs to a DIFFERENT entity — the
//         holder is meaningful and extending someone else's lease is a silent takeover.
//   F. (TKT-161-9AD1) REFUSED DOORS ARE SIDE-EFFECT FREE — validate-then-mutate: every refusal
//      (the handover no-override refusal, the terminal-state await refusal and the foreign-lease
//      await refusal) leaves the open turn 'started' with stop_reason NULL, the zee NOT idle, the
//      execution state/outputs unchanged, and ZERO new event rows. A refused await used to close the
//      turn and park the zee (which the spin detector's filters could not see) — this proves the fix.
//
// Everything it creates is torn down in a finally. It SKIPs loudly on a database that has not run
// the weld migration (180).
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };
const admin = new pg.Client({ connectionString: url });
const tag = randomUUID().slice(0, 8).replace(/[^a-z0-9]/g, '');

async function main() {
  await admin.connect();

  // This test needs the weld schema (180): the nullable execution_id on zee_turn + xell, and the
  // stage-3 execution table. A non-weld db skips loudly.
  const ztCol = (await admin.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name='zee_turn' AND column_name='execution_id'`)).rows.length;
  const xlCol = (await admin.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name='xell' AND column_name='execution_id'`)).rows.length;
  const hasExec = (await admin.query(`SELECT to_regclass('public.execution') AS r`)).rows[0].r;
  const hasLease = (await admin.query(`SELECT to_regclass('public.lease') AS r`)).rows[0].r;
  const hasReq = (await admin.query(`SELECT to_regclass('public.llm_gateway_request') AS r`)).rows[0].r;
  if (!ztCol || !xlCol || !hasExec || !hasLease || !hasReq) {
    console.log(`  SKIP: not a weld-migrated db (zee_turn.execution_id=${!!ztCol}, xell.execution_id=${!!xlCol}, execution=${!!hasExec}, lease=${!!hasLease}, llm_gateway_request=${!!hasReq})`);
    return;
  }

  const q = (text, params) => admin.query(text, params);
  const one = async (text, params) => (await admin.query(text, params)).rows[0];

  const { startTurn, endTurn, workflowTreeForXell } = await import('../server/src/lib/turn-ledger.js');
  const { markZeeTurn } = await import('../server/src/lib/turn-record.js');
  const { selfHandover, selfAwait } = await import('../server/src/queenzee/self.js');

  // throwaway project → xource → xell → zee, and project → plan → plan_version → work_node → run →
  // execution, plus an entity for the zee (the dispatch binds the execution to it — a zee is a pull
  // entity holding a long lease, design §6.2).
  const projectId = randomUUID();
  const runIds = [];
  const entityIds = [];

  const mkXell = async (slug, status = 'working') => one(
    `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status, self_token_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [projectId, xourceId, slug, `spinoff/${slug}`, `/tmp/weld/${slug}`, status, `hash-${slug}-${tag}`]);
  const mkZee = async (xellId, status = 'working') => one(
    `INSERT INTO zee (xell_id, attach_mode, entrypoint, kind, viewer_kind, claude_session_id, model, status)
     VALUES ($1,'headless-spawn','cxell-cli','headless','ssh-terminal',$2,'opus',$3) RETURNING *`,
    [xellId, randomUUID(), status]);

  let xourceId = null;
  let xellId = null, zeeId = null;
  try {
    await q(`INSERT INTO project (id, name, repo_root) VALUES ($1,$2,'/tmp')`,
      [projectId, `wf-weld-${tag}`]);
    const xo = await one(`INSERT INTO xource (project_id, ref) VALUES ($1,'refs/heads/main') RETURNING id`, [projectId]);
    xourceId = xo.id;
    const planId = (await one(`INSERT INTO plan (project_id, name) VALUES ($1,'weld') RETURNING id`, [projectId])).id;
    const ver = (await one(`INSERT INTO plan_version (plan_id, version) VALUES ($1,1) RETURNING id`, [planId])).id;
    const R = (await one(
      `INSERT INTO work_node (plan_version_id, parent_id, sibling_rank, name, kind, child_semantics)
       VALUES ($1,NULL,'1','R','container','freeform') RETURNING id`, [ver])).id;
    const A1 = (await one(
      `INSERT INTO work_node (plan_version_id, parent_id, sibling_rank, name, kind)
       VALUES ($1,$2,'1','A1','action') RETURNING id`, [ver, R])).id;

    // ── A. THE FULL JOINED CHAIN (a) — a simulated dispatch ──────────────────
    console.log(`\nA. the full joined chain — execution → zee_turn → llm_gateway_request`);
    // The workflow engine creates an execution for the work_node and assigns the zee-as-entity.
    const ent = await one(`INSERT INTO entity (name, kind_hint) VALUES ($1,'agent') RETURNING *`,
      [`agent:dispatch-${tag}`]);
    entityIds.push(ent.id);
    const run = await one(`INSERT INTO run (plan_version_id) VALUES ($1) RETURNING id`, [ver]);
    runIds.push(run.id);
    const ex = await one(
      `INSERT INTO execution (run_id, work_node_id, attempt, state, entity_id, inputs)
       VALUES ($1,$2,1,'running',$3,'{"v":1}'::jsonb) RETURNING *`,
      [run.id, A1, ent.id]);

    // The dispatch binds the XELL to the execution (xell.execution_id) — the queenzee's source of
    // truth for "which execution is this zee on".
    const xell = await mkXell(`weld-a-${tag}`);
    xellId = xell.id;
    await q(`UPDATE xell SET execution_id=$2 WHERE id=$1`, [xell.id, ex.id]);
    const x = await one(`SELECT * FROM xell WHERE id=$1`, [xell.id]);
    const zee = await mkZee(x.id, 'working');
    zeeId = zee.id;

    // The QUEENZEE starts a turn for the dispatched execution → stamps execution_id on zee_turn.
    const turn = await startTurn({ zee, xell: x, kind: 'spawn', model: 'opus',
                                   executionId: x.execution_id });
    ok(turn?.execution_id === ex.id, `the turn is stamped with the execution (execution_id=${String(turn?.execution_id).slice(0, 8)})`);

    // The GATEWAY PROXY records the LLM calls for that turn (llm_gateway_request already carries
    // turn_id — migration 154). Two calls make up this turn.
    const g1 = await one(
      `INSERT INTO llm_gateway_request (xell_id, zee_id, turn_id, project_id, provider, model, method, path, status, input_tokens, output_tokens, cost_usd)
       VALUES ($1,$2,$3,$4,'claude','opus','POST','/v1/messages',200,100,50,0.0123) RETURNING id`,
      [x.id, zee.id, turn.id, projectId]);
    const g2 = await one(
      `INSERT INTO llm_gateway_request (xell_id, zee_id, turn_id, project_id, provider, model, method, path, status, input_tokens, output_tokens, cost_usd)
       VALUES ($1,$2,$3,$4,'claude','opus','POST','/v1/messages',200,50,25,0.0060) RETURNING id`,
      [x.id, zee.id, turn.id, projectId]);

    // The three-way JOIN is the drill-down waterfall.
    const chain = (await q(
      `SELECT e.id AS execution_id, t.id AS turn_id, g.id AS gateway_id
         FROM execution e
         JOIN zee_turn t ON t.execution_id = e.id
         JOIN llm_gateway_request g ON g.turn_id = t.id
        WHERE e.id = $1 ORDER BY g.requested_at`, [ex.id])).rows;
    ok(chain.length === 2, `the joined chain returns both gateway calls for the execution's turn (${chain.length})`);
    ok(chain.every(r => r.execution_id === ex.id && r.turn_id === turn.id),
      `every gateway call in the chain joins through the SAME execution and turn`);

    // The nested read model renders the same chain as the tree (work_node → execution → turns →
    // gateway calls).
    const tree = await workflowTreeForXell(x.id);
    ok(tree.length === 1, `workflowTreeForXell returns one work node`);
    ok(tree[0]?.work_node_id === A1 && tree[0]?.work_node_name === 'A1',
      `the tree is keyed by work node (${tree[0]?.work_node_name})`);
    ok(tree[0]?.executions.length === 1 && tree[0].executions[0].id === ex.id,
      `the tree carries the execution under its work node`);
    ok(tree[0].executions[0].turns.length === 1 && tree[0].executions[0].turns[0].id === turn.id,
      `the tree carries the turn under the execution`);
    ok(tree[0].executions[0].turns[0].gateway_requests.length === 2,
      `the tree carries both gateway calls under the turn`);
    ok(tree[0].executions[0].outputs === null, `the tree exposes execution.outputs (null before handover)`);

    // ── B. A TURN WITH NO EXECUTION STILL RECORDS (b) ────────────────────────
    console.log(`\nB. a turn with no execution — execution_id NULL, still recorded`);
    const turnNoExec = await startTurn({ zee, xell: { id: x.id, project_id: x.project_id },
                                         kind: 'resume', model: 'opus' });
    ok(turnNoExec?.execution_id === null, `the no-execution turn records with execution_id NULL`);
    ok(turnNoExec?.id && turnNoExec.kind === 'resume', `and it is a real recorded turn (kind=${turnNoExec?.kind})`);
    const noExecInTree = await workflowTreeForXell(x.id);
    ok(noExecInTree.every(n => n.executions.every(e => e.turns.every(t => t.id !== turnNoExec.id))),
      `the no-execution turn does NOT appear in the execution-keyed workflow tree`);

    // close the spawn turn so the await test has exactly one open turn to end
    await endTurn(turn.id, { status: 'ended', stopReason: 'end_turn' });

    // ── C. HANDOVER STORES THE TYPED RESULT (c) ──────────────────────────────
    console.log(`\nC. zee handover — typed result INTERIM-stored on execution.outputs`);
    const hand = await selfHandover(x, { result: '{"translated":true,"count":3}' });
    ok(hand.ok === true, `handover succeeds`);
    const exAfter = await one(`SELECT outputs, state FROM execution WHERE id=$1`, [ex.id]);
    ok(exAfter.outputs?.translated === true && exAfter.outputs?.count === 3,
      `execution.outputs carries the parsed typed result (${JSON.stringify(exAfter.outputs)})`);
    ok(exAfter.state === 'running', `handover is a STORE, not a state transition (state stays ${exAfter.state})`);
    const malformed = await selfHandover(x, { result: '{not json' });
    ok(malformed.ok === false && /JSON/.test(malformed.error), `a malformed --result is refused with a sentence`);
    const noBind = await selfHandover({ id: randomUUID(), execution_id: null }, { result: '{}' });
    ok(noBind.ok === false && /not bound/.test(noBind.error), `a xell with no execution binding is refused`);

    // ── C2. (finding 2) A SECOND HANDOVER IS REFUSED UNLESS --override ────────
    console.log(`\nC2. a second handover — refused without --override, allowed with it`);
    const second = await selfHandover(x, { result: '{"translated":false}' });
    ok(second.ok === false && /override/.test(second.error),
      `a second handover on a non-null outputs is REFUSED with an --override sentence`);
    // TKT-161: the REFUSAL is side-effect free — the turn stays OPEN, the zee stays as it was,
    // execution.outputs are untouched, and no event row is appended.
    const turnAfterHandRefusal = await one(`SELECT status, stop_reason FROM zee_turn WHERE id=$1`, [turnNoExec.id]);
    ok(turnAfterHandRefusal.status === 'started' && turnAfterHandRefusal.stop_reason === null,
      `a REFUSED handover leaves the open turn 'started' with no stop_reason (${turnAfterHandRefusal.status}/${turnAfterHandRefusal.stop_reason})`);
    const zeeAfterHandRefusal = await one(`SELECT status FROM zee WHERE id=$1`, [zee.id]);
    ok(zeeAfterHandRefusal.status !== 'idle', `a REFUSED handover leaves the zee NOT idle (${zeeAfterHandRefusal.status})`);
    const exAfterHandRefusal = await one(`SELECT outputs FROM execution WHERE id=$1`, [ex.id]);
    ok(exAfterHandRefusal.outputs?.count === 3 && exAfterHandRefusal.outputs?.translated === true,
      `a REFUSED handover leaves execution.outputs untouched (${JSON.stringify(exAfterHandRefusal.outputs)})`);
    const handEvtAfterRefusal = (await one(
      `SELECT count(*)::int AS n FROM event WHERE run_id=$1 AND type='execution.handover'`, [run.id])).n;
    ok(handEvtAfterRefusal === 1, `a REFUSED handover appends NO event row (${handEvtAfterRefusal} handover event)`);
    const overridden = await selfHandover(x, { result: '{"translated":false,"count":9}', override: true });
    ok(overridden.ok === true && overridden.outputs?.count === 9,
      `with --override the result is REPLACED (the event log keeps the history)`);
    const exAfter2 = await one(`SELECT outputs FROM execution WHERE id=$1`, [ex.id]);
    ok(exAfter2.outputs?.count === 9 && exAfter2.outputs?.translated === false,
      `execution.outputs now carries the overridden result`);

    // ── D. AWAIT ENDS THE TURN AND HOLDS A LEASE (d) ─────────────────────────
    console.log(`\nD. zee await — turn ends, lease held, execution waiting`);
    const awaitRes = await selfAwait(x, { hours: 48 });
    ok(awaitRes.ok === true, `await succeeds`);
    ok(awaitRes.turn_ended === true, `await ended an open turn`);
    const turnNoExecAfter = await one(`SELECT status, stop_reason FROM zee_turn WHERE id=$1`, [turnNoExec.id]);
    ok(turnNoExecAfter.status === 'ended' && turnNoExecAfter.stop_reason === 'await',
      `the open turn ended with stop_reason 'await' (${turnNoExecAfter.status}/${turnNoExecAfter.stop_reason})`);
    const lease = await one(`SELECT state, entity_id, expires_at, claimed_at FROM lease WHERE execution_id=$1`, [ex.id]);
    ok(lease.state === 'held', `a lease is HELD on the execution`);
    ok(lease.entity_id === ent.id, `the lease is held by the entity bound to the execution (the zee-as-entity)`);
    ok(lease.expires_at > lease.claimed_at, `the lease is a forward window (expires after claim)`);
    const exState = await one(`SELECT state FROM execution WHERE id=$1`, [ex.id]);
    ok(exState.state === 'waiting', `the execution is 'waiting' (lease held, blocked on external signal)`);
    const zeeAfter = await one(`SELECT status FROM zee WHERE id=$1`, [zee.id]);
    ok(zeeAfter.status === 'idle', `the zee row is idle (the turn ended — tokens stop)`);
    // a second await while a lease is held EXTENDS rather than colliding (lease_one_active_per_execution)
    const awaitAgain = await selfAwait(x, { hours: 24 });
    ok(awaitAgain.ok === true, `a second await succeeds (extends the held lease, never collides)`);
    const leaseCount = (await one(
      `SELECT count(*)::int AS n FROM lease WHERE execution_id=$1 AND state='held'`, [ex.id])).n;
    ok(leaseCount === 1, `exactly one HELD lease remains (the unique index, not a stack)`);

    // ── E1. (finding 1) THE DOORS APPEND IMMUTABLE EVENTS ────────────────────
    console.log(`\nE1. the append-only event log — the doors write immutable records`);
    const events = (await q(
      `SELECT type, seq, execution_id, work_node_id, payload FROM event WHERE run_id=$1 ORDER BY seq ASC`, [run.id])).rows;
    const handTypes = events.filter(e => e.type === 'execution.handover');
    ok(handTypes.length === 2, `two 'execution.handover' events were appended (${handTypes.length})`);
    ok(handTypes[0].payload?.result?.count === 3 && handTypes[1].payload?.result?.count === 9,
      `each handover event carries its result in the payload (the earlier one survives the overwrite)`);
    ok(handTypes[0].payload?.overrode === false && handTypes[1].payload?.overrode === true,
      `the first handover recorded overrode:false, the override recorded overrode:true`);
    const awaitEvts = events.filter(e => e.type === 'execution.await');
    ok(awaitEvts.length === 2, `two 'execution.await' events were appended (one per await — ${awaitEvts.length})`);
    ok(awaitEvts[0]?.payload?.lease_hours === 48 && awaitEvts[1]?.payload?.lease_hours === 24,
      `each await event carries the lease window that created it (${awaitEvts.map(e => e.payload?.lease_hours).join(',')})`);
    ok(events.every(e => e.execution_id === ex.id && e.work_node_id === A1),
      `every event is attributed to the execution and work node`);
    ok(events.map(e => e.seq).join(',') === events.map((_, i) => i + 1).join(','),
      `event seq is monotone per run (${events.map(e => e.seq).join(',')})`);
    // the log is append-only — a door's record cannot be rewritten
    await assertRefused(
      q(`UPDATE event SET type='tampered' WHERE execution_id=$1`, [ex.id]),
      'append-only', 'the event log REFUSES an UPDATE (append-only trigger)');

    // ── E2. (finding 3) AWAIT IS REFUSED FROM A TERMINAL STATE ───────────────
    console.log(`\nE2. await from a terminal state — refused`);
    const termRun = await one(`INSERT INTO run (plan_version_id) VALUES ($1) RETURNING id`, [ver]);
    runIds.push(termRun.id);
    const termExec = await one(
      `INSERT INTO execution (run_id, work_node_id, attempt, state, entity_id)
       VALUES ($1,$2,1,'done',$3) RETURNING id`, [termRun.id, A1, ent.id]);
    // bring the zee back to WORKING with an open turn so the refusal's side-effect-freedom is provable
    const termTurn = await startTurn({ zee, xell: x, kind: 'resume', model: 'opus', executionId: termExec.id });
    await markZeeTurn(zee.id, 'working', 'resumed turn');
    const termRefusal = await selfAwait({ id: x.id, execution_id: termExec.id }, { hours: 24 });
    ok(termRefusal.ok === false && /'done'/.test(termRefusal.error),
      `awaiting a 'done' execution is REFUSED with the state named`);
    // TKT-161: the terminal-state refusal must be side-effect free — turn OPEN, zee NOT idle,
    // execution unchanged, zero event rows.
    const termTurnAfter = await one(`SELECT status, stop_reason FROM zee_turn WHERE id=$1`, [termTurn.id]);
    ok(termTurnAfter.status === 'started' && termTurnAfter.stop_reason === null,
      `a REFUSED await leaves the open turn 'started' with no stop_reason (${termTurnAfter.status}/${termTurnAfter.stop_reason})`);
    const zeeAfterTermRefusal = await one(`SELECT status FROM zee WHERE id=$1`, [zee.id]);
    ok(zeeAfterTermRefusal.status !== 'idle', `a REFUSED await leaves the zee NOT idle (${zeeAfterTermRefusal.status})`);
    const termExecAfter = await one(`SELECT state FROM execution WHERE id=$1`, [termExec.id]);
    ok(termExecAfter.state === 'done', `a REFUSED await leaves the 'done' execution unchanged (${termExecAfter.state})`);
    const termEvts = (await one(`SELECT count(*)::int AS n FROM event WHERE run_id=$1`, [termRun.id])).n;
    ok(termEvts === 0, `a REFUSED await appends NO event row (${termEvts})`);

    // ── E3. (finding 4) RESOLVE-OR-CREATE BY THE STABLE ENTITY KEY ───────────
    console.log(`\nE3. entity resolve-or-create — one zee maps to one entity`);
    const noEntRun = await one(`INSERT INTO run (plan_version_id) VALUES ($1) RETURNING id`, [ver]);
    runIds.push(noEntRun.id);
    const exNoEnt = await one(
      `INSERT INTO execution (run_id, work_node_id, attempt, state) VALUES ($1,$2,1,'running') RETURNING id`,
      [noEntRun.id, A1]);
    await q(`UPDATE xell SET execution_id=$2 WHERE id=$1`, [x.id, exNoEnt.id]);
    const entResolve = await selfAwait({ id: x.id, execution_id: exNoEnt.id }, { hours: 12 });
    ok(entResolve.ok === true, `await on an entity-less execution succeeds (resolve-or-create)`);
    const zeeEntity = await one(`SELECT id, name FROM entity WHERE name=$1`, [`agent:${zee.id}`]);
    ok(!!zeeEntity, `the stable-key entity exists (agent:<zee.id>)`);
    entityIds.push(zeeEntity.id); // track for teardown (deleted after its leases cascade away with the runs)
    const leaseNoEnt = await one(`SELECT entity_id FROM lease WHERE execution_id=$1 AND state='held'`, [exNoEnt.id]);
    ok(leaseNoEnt.entity_id === zeeEntity.id, `the lease is held by the resolve-or-created entity`);
    // a SECOND entity-less execution for the SAME zee reuses the SAME entity row — never a fresh insert
    const exNoEnt2 = await one(
      `INSERT INTO execution (run_id, work_node_id, attempt, state) VALUES ($1,$2,2,'running') RETURNING id`,
      [noEntRun.id, A1]);
    await q(`UPDATE xell SET execution_id=$2 WHERE id=$1`, [x.id, exNoEnt2.id]);
    const entResolve2 = await selfAwait({ id: x.id, execution_id: exNoEnt2.id }, { hours: 12 });
    ok(entResolve2.ok === true, `await on a second entity-less execution succeeds`);
    const zeeEntityCount = (await one(
      `SELECT count(*)::int AS n FROM entity WHERE name=$1`, [`agent:${zee.id}`])).n;
    ok(zeeEntityCount === 1, `exactly ONE entity row for the zee's stable key (${zeeEntityCount}) — reused, not re-created`);
    const leaseNoEnt2 = await one(`SELECT entity_id FROM lease WHERE execution_id=$1 AND state='held'`, [exNoEnt2.id]);
    ok(leaseNoEnt2.entity_id === zeeEntity.id, `the second lease is held by the SAME entity`);
    // bind back to the main execution for any later assertions
    await q(`UPDATE xell SET execution_id=$2 WHERE id=$1`, [x.id, ex.id]);

    // ── E4. (finding 5) AWAIT REFUSES TO EXTEND A FOREIGN LEASE ──────────────
    console.log(`\nE4. extending a lease held by a DIFFERENT entity — refused`);
    const foreignEnt = await one(`INSERT INTO entity (name, kind_hint) VALUES ($1,'agent') RETURNING *`,
      [`agent:foreign-${tag}`]);
    entityIds.push(foreignEnt.id);
    const foreignRun = await one(`INSERT INTO run (plan_version_id) VALUES ($1) RETURNING id`, [ver]);
    runIds.push(foreignRun.id);
    const foreignExec = await one(
      `INSERT INTO execution (run_id, work_node_id, attempt, state, entity_id)
       VALUES ($1,$2,1,'running',$3) RETURNING id`, [foreignRun.id, A1, ent.id]);
    // someone else already holds the one HELD lease on this execution
    await one(
      `INSERT INTO lease (execution_id, entity_id, expires_at) VALUES ($1, $2, now() + '1 day'::interval) RETURNING id`,
      [foreignExec.id, foreignEnt.id]);
    // bring the zee back to WORKING with an open turn so the refusal's side-effect-freedom is provable
    const foreignTurn = await startTurn({ zee, xell: x, kind: 'resume', model: 'opus', executionId: foreignExec.id });
    await markZeeTurn(zee.id, 'working', 'resumed turn');
    const foreignRefusal = await selfAwait({ id: x.id, execution_id: foreignExec.id }, { hours: 24 });
    ok(foreignRefusal.ok === false && /different entity/.test(foreignRefusal.error),
      `awaiting an execution whose HELD lease belongs to another entity is REFUSED`);
    // TKT-161: the foreign-lease refusal must be side-effect free — turn OPEN, zee NOT idle,
    // execution unchanged, zero event rows.
    const foreignTurnAfter = await one(`SELECT status, stop_reason FROM zee_turn WHERE id=$1`, [foreignTurn.id]);
    ok(foreignTurnAfter.status === 'started' && foreignTurnAfter.stop_reason === null,
      `a REFUSED foreign-lease await leaves the open turn 'started' with no stop_reason (${foreignTurnAfter.status}/${foreignTurnAfter.stop_reason})`);
    const zeeAfterForeignRefusal = await one(`SELECT status FROM zee WHERE id=$1`, [zee.id]);
    ok(zeeAfterForeignRefusal.status !== 'idle', `a REFUSED foreign-lease await leaves the zee NOT idle (${zeeAfterForeignRefusal.status})`);
    const foreignExecAfter = await one(`SELECT state FROM execution WHERE id=$1`, [foreignExec.id]);
    ok(foreignExecAfter.state === 'running', `a REFUSED foreign-lease await leaves the execution unchanged (${foreignExecAfter.state})`);
    const foreignEvts = (await one(`SELECT count(*)::int AS n FROM event WHERE run_id=$1`, [foreignRun.id])).n;
    ok(foreignEvts === 0, `a REFUSED foreign-lease await appends NO event row (${foreignEvts})`);

  } finally {
    // tear down: runs cascade executions → leases/allocations; entities are deleted separately
    // (lease.entity_id has NO cascade); the project cascade removes xource/xell/zee/zee_turn,
    // plan/version/nodes. A FAILED teardown prints and counts as a FAIL — never swallow.
    try {
      await q(`SET zeehive.purge_events = 'on'`);
      for (const id of runIds) await q(`DELETE FROM run WHERE id=$1`, [id]);
      for (const id of entityIds) await q(`DELETE FROM entity WHERE id=$1`, [id]);
      await q(`DELETE FROM project WHERE id=$1`, [projectId]);
      await q(`RESET zeehive.purge_events`);

      const residue = await one(
        `SELECT
           (SELECT count(*)::int FROM run          WHERE id = ANY($1::uuid[]))  AS runs,
           (SELECT count(*)::int FROM execution    WHERE run_id = ANY($1::uuid[])) AS execs,
           (SELECT count(*)::int FROM event        WHERE run_id = ANY($1::uuid[])) AS evts,
           (SELECT count(*)::int FROM entity       WHERE id = ANY($2::uuid[])) AS entities,
           (SELECT count(*)::int FROM llm_gateway_request WHERE project_id = $3) AS reqs,
           (SELECT count(*)::int FROM project WHERE id = $3) AS projects`,
        [runIds, entityIds, projectId]);
      ok(residue.runs === 0 && residue.execs === 0 && residue.evts === 0 && residue.entities === 0
        && residue.reqs === 0 && residue.projects === 0,
        `teardown leaves no residue (runs=${residue.runs} execs=${residue.execs} evts=${residue.evts} entities=${residue.entities} reqs=${residue.reqs} projects=${residue.projects})`);
    } catch (e) {
      console.error(`  ✗ FAIL teardown: ${e.message.split('\n')[0].slice(0, 100)}`);
      fail++;
    }
    await admin.end().catch(() => {});
  }

  // an assertion helper that expects the statement to FAIL
  async function assertRefused(promise, label, what) {
    try {
      await promise;
      ok(false, `${what} was NOT refused (${label})`);
    } catch (e) {
      ok(/append-only|duplicate key|invalid input value|violates|check constraint/.test(e.message),
        `${what} refused (${label}: ${e.message.split('\n')[0].slice(0, 70)})`);
    }
  }
}

await main().catch((e) => { console.error('TEST ERROR:', e); fail++; });
console.log(fail ? `\n${fail} FAILED` : '\nall good');
process.exit(fail ? 1 : 0);
