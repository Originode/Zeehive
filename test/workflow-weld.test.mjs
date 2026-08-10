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
//   D. AWAIT ENDS THE TURN AND HOLDS A LEASE (d) — zee await ends the open turn (tokens stop — the
//      anti-spin primitive), marks the zee idle, holds a lease on the execution (the entity bound at
//      dispatch; exactly one HELD lease — a second await extends rather than collides), and moves
//      the execution to 'waiting'.
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
           (SELECT count(*)::int FROM entity       WHERE id = ANY($2::uuid[])) AS entities,
           (SELECT count(*)::int FROM llm_gateway_request WHERE project_id = $3) AS reqs,
           (SELECT count(*)::int FROM project WHERE id = $3) AS projects`,
        [runIds, entityIds, projectId]);
      ok(residue.runs === 0 && residue.execs === 0 && residue.entities === 0
        && residue.reqs === 0 && residue.projects === 0,
        `teardown leaves no residue (runs=${residue.runs} execs=${residue.execs} entities=${residue.entities} reqs=${residue.reqs} projects=${residue.projects})`);
    } catch (e) {
      console.error(`  ✗ FAIL teardown: ${e.message.split('\n')[0].slice(0, 100)}`);
      fail++;
    }
    await admin.end().catch(() => {});
  }
}

await main().catch((e) => { console.error('TEST ERROR:', e); fail++; });
console.log(fail ? `\n${fail} FAILED` : '\nall good');
process.exit(fail ? 1 : 0);
