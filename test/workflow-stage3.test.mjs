// WORKFLOW STAGE 3 — run/execution/event/checkpoint — the DURABILITY plane
// (docs/hierarchical-workflow-adoption.md §5, stage 3; design §8.1–8.5).
//
// This test proves migrations 177 (workflow_stage3_run_execution_event_checkpoint) and 178
// (workflow_stage3_reconcile_append_only_purge_hatch) against a REAL postgres with the full
// migration set applied. It is the stage-3 counterpart of test/workflow-stage1.test.mjs and
// extends that suite's pattern — a standalone node script with a header documenting coverage,
// a loud SKIP on a non-workflow db, and teardown in a finally. Coverage:
//
//   A. run round-trip — insert/select, state/version_policy/globals/correlation_id columns,
//      defaults (state='pending', version_policy='pinned').
//   B. RETRY = a SECOND execution row, not an update (design §8.1). attempt=2 INSERTs a new
//      row; the attempt-1 row is untouched; a duplicate attempt INSERT is refused by the
//      unique exec_attempt_idx (a unique INDEX, not a constraint — Postgres rejects
//      expressions in constraints, adoption §4.1). COALESCE(map_index/loop_iteration, -1)
//      means a plain retry and a map instance do not collide, but two plain rows at the same
//      attempt do.
//   C. event is append-only (I16) — UPDATE and DELETE both RAISE via event_append_only; the
//      row is unchanged afterwards. event (run_id, seq) uniqueness is enforced. The 178 purge
//      hatch: UPDATE raises even with zeehive.purge_events='on'; DELETE without the GUC raises;
//      DELETE with the GUC succeeds (the admin/GDPR retention path that makes the run ON DELETE
//      CASCADE honest).
//   C2. TEARDOWN (the reason 178 exists): DELETE FROM run for a run that has an event must
//      succeed once the session opts in to purge — the cascade must actually fire. A failed
//      teardown is a FAIL (errors are never swallowed), and the suite ends with a residue
//      assertion that 0 run/execution/event/checkpoint rows and the project are gone.
//   D. effect_key idempotency (design §8.2) — the partial unique index exec_effect_key_idx on
//      (run_id, effect_key) WHERE state='done' makes a second DONE execution with the same key
//      in one run impossible, so the engine replays the recorded output; a FAILED attempt with
//      the same key coexists (retry proceeds); the same key in ANOTHER run is a different key.
//   E. state machine (design §8.4) — lifecycle_state carries pending→ready→running→done and
//      done→failed→retry→done; 'compensated' is a DISTINCT terminal state (≠ done, ≠ failed);
//      'blocked' is terminal for unsatisfiable requirements. run_state carries 'compensated'.
//   F. checkpoint — insert/select, (run_id, seq) uniqueness, snapshot round-trip.
//   G. enums — lifecycle_state has the full §8.4 set incl. compensated+blocked; version_policy
//      is PINNED-ONLY for this stage ('migrate'/'restart' are a later stage).
//
// Everything it creates is torn down in a finally. It SKIPs loudly on a database that has not
// run the workflow migrations.
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };
const admin = new pg.Client({ connectionString: url });
const tag = randomUUID().slice(0, 8).replace(/[^a-z0-9]/g, '');
const projectId = randomUUID();

async function main() {
  await admin.connect();

  // This test needs the stage-3 workflow schema; a non-Zeehive db skips loudly.
  const hasRun  = (await admin.query(`SELECT to_regclass('public.run') AS r`)).rows[0].r;
  const hasExec = (await admin.query(`SELECT to_regclass('public.execution') AS r`)).rows[0].r;
  const hasEvt  = (await admin.query(`SELECT to_regclass('public.event') AS r`)).rows[0].r;
  if (!hasRun || !hasExec || !hasEvt) {
    console.log(`  SKIP: not a stage-3-workflow-migrated db (run=${!!hasRun}, execution=${!!hasExec}, event=${!!hasEvt})`);
    return;
  }

  const q = (text, params) => admin.query(text, params);
  const one = async (text, params) => (await admin.query(text, params)).rows[0];

  // throwaway project → plan → plan_version (v1) → one freeform root with two action leaves
  await q(`INSERT INTO project (id, name, repo_root, db_user, db_name) VALUES ($1,$2,'/tmp','u','d')`,
    [projectId, `wf-stage3-${tag}`]);
  const planId = (await one(`INSERT INTO plan (project_id, name) VALUES ($1,'stage3') RETURNING id`, [projectId])).id;
  const ver = (await one(`INSERT INTO plan_version (plan_id, version) VALUES ($1,1) RETURNING id`, [planId])).id;
  const R = (await one(
    `INSERT INTO work_node (plan_version_id, parent_id, sibling_rank, name, kind, child_semantics)
     VALUES ($1,NULL,'1','R','container','freeform') RETURNING id`, [ver])).id;
  const A1 = (await one(
    `INSERT INTO work_node (plan_version_id, parent_id, sibling_rank, name, kind)
     VALUES ($1,$2,'1','A1','action') RETURNING id`, [ver, R])).id;
  const A2 = (await one(
    `INSERT INTO work_node (plan_version_id, parent_id, sibling_rank, name, kind)
     VALUES ($1,$2,'2','A2','action') RETURNING id`, [ver, R])).id;

  // Run a query inside a transaction that has opted in to the 178 purge hatch
  // (SET LOCAL — scoped to this transaction, never leaks into the session).
  const withPurge = async (fn) => {
    await q('BEGIN');
    await q(`SET LOCAL zeehive.purge_events = 'on'`);
    try {
      const r = await fn();
      await q('COMMIT');
      return r;
    } catch (e) {
      await q('ROLLBACK').catch(() => {});
      throw e;
    }
  };

  // track runs so teardown can delete them (run.plan_version_id has NO cascade — history)
  const runIds = [];
  const newRun = async () => {
    const r = await one(`INSERT INTO run (plan_version_id) VALUES ($1) RETURNING id`, [ver]);
    runIds.push(r.id);
    return r.id;
  };
  const exec = (runId, nodeId, attempt, state, extra = {}) => {
    const cols = ['run_id', 'work_node_id', 'attempt', 'state'];
    const vals = [runId, nodeId, attempt, state];
    for (const k of ['map_index', 'loop_iteration', 'effect_key', 'inputs', 'outputs', 'error']) {
      if (extra[k] !== undefined) { cols.push(k); vals.push(extra[k]); }
    }
    return one(
      `INSERT INTO execution (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
      vals);
  };

  try {
    // ── A. run round-trip and defaults ────────────────────────────────────────
    console.log(`\nA. run round-trip — defaults and correlation`);
    const runA = await newRun();
    const runRow = await one(`SELECT * FROM run WHERE id=$1`, [runA]);
    ok(runRow.state === 'pending', `run.state defaults to 'pending' (got ${runRow.state})`);
    ok(runRow.version_policy === 'pinned', `run.version_policy defaults to 'pinned' (got ${runRow.version_policy})`);
    ok(runRow.plan_version_id === ver, `run binds to the plan_version`);
    ok(runRow.started_at === null && runRow.finished_at === null, `run.started_at/finished_at start NULL`);
    await q(`UPDATE run SET state='running', correlation_id='ticket-${tag}', globals='{"env":"test"}'::jsonb WHERE id=$1`, [runA]);
    const runUpd = await one(`SELECT state, correlation_id, globals FROM run WHERE id=$1`, [runA]);
    ok(runUpd.state === 'running' && runUpd.correlation_id === `ticket-${tag}`
      && runUpd.globals?.env === 'test', `run state/correlation_id/globals update`);
    await q(`UPDATE run SET state='succeeded', finished_at=now() WHERE id=$1`, [runA]);

    // ── B. retry produces a SECOND execution row, not an update ──────────────
    console.log(`\nB. retry = a second execution row, not an update (design §8.1)`);
    const runB = await newRun();
    await exec(runB, A1, 1, 'failed', { inputs: '{"v":1}' });
    // the engine retries: INSERT attempt 2, never UPDATE attempt 1
    const retryRow = await exec(runB, A1, 2, 'running', { inputs: '{"v":1}', outputs: '{"ok":true}' });
    const bRows = (await q(`SELECT attempt, state FROM execution WHERE run_id=$1 AND work_node_id=$2 ORDER BY attempt`, [runB, A1])).rows;
    ok(bRows.length === 2, `retry produced a SECOND row (attempts: ${bRows.map(r => r.attempt).join(',')})`);
    ok(bRows[0].attempt === 1 && bRows[0].state === 'failed', `attempt-1 row is UNTOUCHED (still failed, not overwritten)`);
    ok(retryRow.attempt === 2 && retryRow.state === 'running', `attempt-2 row is a fresh INSERT (running)`);
    // the unique INDEX refuses a duplicate attempt — you cannot collide into a retry
    await assertRefused(exec(runB, A1, 1, 'pending'), 'duplicate key', 'duplicate attempt 1 INSERT is refused (exec_attempt_idx)');
    // COALESCE(map_index/loop_iteration, -1): two plain (NULL) rows at the same attempt collide...
    await exec(runB, A2, 1, 'running', {});
    await assertRefused(exec(runB, A2, 1, 'running'), 'duplicate key', 'second plain attempt-1 row is refused (NULL map_index coalesces to -1)');
    // ...but a map instance at the same attempt is a DIFFERENT index key and coexists
    await exec(runB, A2, 1, 'running', { map_index: 1 });
    await exec(runB, A2, 1, 'running', { map_index: 2 });
    ok((await one(`SELECT count(*)::int AS n FROM execution WHERE run_id=$1 AND work_node_id=$2 AND attempt=1`, [runB, A2])).n === 3,
      `map instances coexist with the plain row at the same attempt (COALESCE differentiates map_index 1/2 from NULL→-1)`);

    // ── C. event is append-only (I16) ────────────────────────────────────────
    console.log(`\nC. event is append-only — UPDATE/DELETE raise`);
    const runC = await newRun();
    const evt = await one(
      `INSERT INTO event (run_id, seq, type, work_node_id, execution_id, payload)
       VALUES ($1,1,'node.started',$2,NULL,'{"at":"now"}'::jsonb) RETURNING id`, [runC, A1]);
    await assertRefused(
      q(`UPDATE event SET type='tampered' WHERE id=$1`, [evt.id]),
      'append-only', 'event UPDATE raises (event_append_only)');
    await assertRefused(
      q(`DELETE FROM event WHERE id=$1`, [evt.id]),
      'append-only', 'event DELETE raises (event_append_only)');
    const evtAfter = await one(`SELECT type FROM event WHERE id=$1`, [evt.id]);
    ok(evtAfter.type === 'node.started', `event row is UNCHANGED after refused UPDATE/DELETE`);
    // (run_id, seq) uniqueness
    await assertRefused(
      q(`INSERT INTO event (run_id, seq, type) VALUES ($1,1,'node.started')`, [runC]),
      'duplicate key', 'event (run_id, seq=1) duplicate is refused');

    // the 178 purge hatch: UPDATE stays forbidden ALWAYS, even with the GUC on
    await assertRefused(
      withPurge(() => q(`UPDATE event SET type='tampered' WHERE id=$1`, [evt.id])),
      'append-only', 'event UPDATE raises even with zeehive.purge_events on (no hatch for UPDATE)');
    // ...and DELETE without the GUC still raises (already proven above), but DELETE with the
    // GUC succeeds — the deliberate admin retention/GDPR purge path (and the thing that makes
    // the run ON DELETE CASCADE honest, exercised again by the teardown)
    await withPurge(() => q(`DELETE FROM event WHERE id=$1`, [evt.id]));
    ok((await one(`SELECT count(*)::int AS n FROM event WHERE id=$1`, [evt.id])).n === 0,
      `event DELETE succeeds when the session opts in to purge (zeehive.purge_events='on')`);
    // leave an event on runC so the teardown must exercise the ON DELETE CASCADE through the
    // event trigger with the GUC on — the exact path 178 exists to make honest
    await q(`INSERT INTO event (run_id, seq, type) VALUES ($1,2,'node.left-for-teardown')`, [runC]);

    // ── D. effect_key idempotency (design §8.2) ──────────────────────────────
    console.log(`\nD. effect_key idempotency — done rows dedupe, failures may retry`);
    const runD = await newRun();
    const doneKey = `hash-${tag}`;
    const firstDone = await exec(runD, A1, 1, 'done', { effect_key: doneKey, outputs: '{"result":42}' });
    // pre-flight: has this effect_key already succeeded in this run? → replay recorded output
    const replay = await one(
      `SELECT outputs FROM execution WHERE run_id=$1 AND effect_key=$2 AND state='done'`, [runD, doneKey]);
    ok(replay.outputs?.result === 42, `engine replays the RECORDED output (result 42) instead of re-running`);
    // a second DONE with the same key in the same run is refused by the partial unique index
    await assertRefused(
      exec(runD, A1, 2, 'done', { effect_key: doneKey, outputs: '{"result":42}' }),
      'duplicate key', 'second DONE execution with the same effect_key is refused (exec_effect_key_idx)');
    // a FAILED attempt with the same key coexists — retry proceeds to a fresh attempt
    await exec(runD, A1, 2, 'failed', { effect_key: doneKey, error: '{"msg":"boom"}' });
    ok((await one(
      `SELECT count(*)::int AS n FROM execution WHERE run_id=$1 AND effect_key=$2 AND state='failed'`, [runD, doneKey])).n === 1,
      `a FAILED attempt with the same effect_key coexists (partial index is WHERE state='done')`);
    // the same key in ANOTHER run is a different key
    const runD2 = await newRun();
    await exec(runD2, A1, 1, 'done', { effect_key: doneKey, outputs: '{"result":7}' });
    const replay2 = await one(
      `SELECT outputs FROM execution WHERE run_id=$1 AND effect_key=$2 AND state='done'`, [runD2, doneKey]);
    ok(replay2.outputs?.result === 7, `same effect_key in another run replays THAT run's output (7)`);
    // NULL effect_key is untouched by the partial index (many no-key rows allowed)
    await exec(runD, A2, 1, 'done', {});
    await exec(runD, A2, 2, 'done', {});
    ok((await one(
      `SELECT count(*)::int AS n FROM execution WHERE run_id=$1 AND work_node_id=$2 AND effect_key IS NULL`, [runD, A2])).n === 2,
      `rows without an effect_key are not deduped (partial index is effect_key IS NOT NULL)`);

    // ── E. state machine (design §8.4) ───────────────────────────────────────
    console.log(`\nE. state machine — incl. compensated and blocked as distinct terminals`);
    // happy path: pending → ready → running → done
    const e1 = await exec(runA, A1, 1, 'pending', {});
    await q(`UPDATE execution SET state='ready' WHERE id=$1`, [e1.id]);
    await q(`UPDATE execution SET state='running', started_at=now() WHERE id=$1`, [e1.id]);
    await q(`UPDATE execution SET state='done', outputs='{"ok":true}', finished_at=now() WHERE id=$1`, [e1.id]);
    ok((await one(`SELECT state FROM execution WHERE id=$1`, [e1.id])).state === 'done',
      `pending→ready→running→done transition sticks`);
    // failure then retry: attempt 1 failed, attempt 2 succeeds
    const e2a = await exec(runA, A2, 1, 'failed', { error: '{"msg":"boom"}' });
    const e2b = await exec(runA, A2, 2, 'done', { outputs: '{"ok":true}' });
    ok(e2a.state === 'failed' && e2b.state === 'done', `failed attempt-1 + done attempt-2 (retry) both present`);
    // compensated: done --rollback--> compensated — a DISTINCT terminal state
    const e3 = await exec(runA, A2, 3, 'done', { outputs: '{"ok":true}' });
    await q(`UPDATE execution SET state='compensated' WHERE id=$1`, [e3.id]);
    const e3s = await one(`SELECT state FROM execution WHERE id=$1`, [e3.id]);
    ok(e3s.state === 'compensated', `done --rollback--> compensated`);
    ok((await one(`SELECT 'compensated'::lifecycle_state = 'done'::lifecycle_state AS eq`)).eq === false
      && (await one(`SELECT 'compensated'::lifecycle_state = 'failed'::lifecycle_state AS eq`)).eq === false,
      `'compensated' is DISTINCT from 'done' and 'failed' (enum comparison)`);
    // a WHERE that distinguishes compensated from done/failed finds exactly the rolled-back row
    const compRows = (await q(
      `SELECT id FROM execution WHERE run_id=$1 AND state IN ('done','failed','compensated') AND state='compensated'`, [runA])).rows;
    ok(compRows.some(r => r.id === e3.id), `a compensated filter selects the rolled-back row and not done/failed rows`);
    // blocked: requirements unsatisfiable — terminal, distinct from failed
    const e4 = await exec(runA, A1, 2, 'blocked', {});
    ok(e4.state === 'blocked', `an unsatisfiable execution is 'blocked'`);
    ok((await one(`SELECT 'blocked'::lifecycle_state = 'failed'::lifecycle_state AS eq`)).eq === false,
      `'blocked' is DISTINCT from 'failed'`);
    // run_state carries the run-level terminals including compensated
    await q(`UPDATE run SET state='compensated', finished_at=now() WHERE id=$1`, [runA]);
    ok((await one(`SELECT state FROM run WHERE id=$1`, [runA])).state === 'compensated',
      `run_state carries 'compensated'`);

    // ── F. checkpoint ────────────────────────────────────────────────────────
    console.log(`\nF. checkpoint — snapshot round-trip and (run_id, seq) uniqueness`);
    const runF = await newRun();
    const ck = await one(
      `INSERT INTO checkpoint (run_id, seq, snapshot) VALUES ($1,1,'{"phase":"done"}'::jsonb) RETURNING id`, [runF]);
    const ckRow = await one(`SELECT snapshot FROM checkpoint WHERE id=$1`, [ck.id]);
    ok(ckRow.snapshot?.phase === 'done', `checkpoint snapshot round-trips`);
    await assertRefused(
      q(`INSERT INTO checkpoint (run_id, seq, snapshot) VALUES ($1,1,'{}'::jsonb)`, [runF]),
      'duplicate key', 'checkpoint (run_id, seq=1) duplicate is refused');
    await q(`INSERT INTO checkpoint (run_id, seq, snapshot) VALUES ($1,2,'{"phase":"later"}'::jsonb)`, [runF]);
    ok((await one(`SELECT count(*)::int AS n FROM checkpoint WHERE run_id=$1`, [runF])).n === 2,
      `checkpoint seq 1 and 2 coexist`);

    // ── G. enums — full lifecycle_state, pinned-only version_policy ──────────
    console.log(`\nG. enums — lifecycle_state full set, version_policy pinned-only`);
    const lifeStates = (await one(`SELECT enum_range(NULL::lifecycle_state) AS r`)).r;
    for (const s of ['pending','ready','running','waiting','done','failed','skipped','cancelled','blocked','compensated']) {
      ok(lifeStates.includes(s), `lifecycle_state has '${s}'`);
    }
    const vp = (await one(`SELECT enum_range(NULL::version_policy) AS r`)).r;
    ok(vp === '{pinned}', `version_policy is PINNED-ONLY for this stage (got ${vp})`);
    await assertRefused(
      q(`INSERT INTO run (plan_version_id, version_policy) VALUES ($1,'migrate')`, [ver]),
      'invalid input', `'migrate' is refused at this stage (pinned-only)`);
    const rs = (await one(`SELECT enum_range(NULL::run_state) AS r`)).r;
    for (const s of ['pending','running','paused','succeeded','failed','cancelled','compensated']) {
      ok(rs.includes(s), `run_state has '${s}'`);
    }

  } finally {
    // tear down: opt in to the 178 purge hatch, then DELETE FROM run and let the ON DELETE
    // CASCADE remove event/checkpoint/execution with it (this is what the hatch is FOR — the
    // cascade is honest now). A FAILED teardown prints and counts as a FAIL — never swallow.
    try {
      await q(`SET zeehive.purge_events = 'on'`);
      for (const id of runIds) {
        await q(`DELETE FROM run WHERE id=$1`, [id]);
      }
      // run.plan_version_id has NO cascade — history is preserved on purpose — so runs are
      // deleted above, then the project cascade removes the plan/version/nodes.
      await q(`DELETE FROM project WHERE id=$1`, [projectId]);
      await q(`RESET zeehive.purge_events`);

      // residue assertion: nothing of ours may survive, in any of the four stage-3 tables
      const residue = await one(
        `SELECT
           (SELECT count(*)::int FROM run          WHERE id = ANY($1::uuid[]))  AS runs,
           (SELECT count(*)::int FROM execution    WHERE run_id = ANY($1::uuid[])) AS execs,
           (SELECT count(*)::int FROM event        WHERE run_id = ANY($1::uuid[])) AS evts,
           (SELECT count(*)::int FROM checkpoint   WHERE run_id = ANY($1::uuid[])) AS cks,
           (SELECT count(*)::int FROM project WHERE id = $2) AS projects`,
        [runIds, projectId]);
      ok(residue.runs === 0 && residue.execs === 0 && residue.evts === 0
        && residue.cks === 0 && residue.projects === 0,
        `teardown leaves no residue (runs=${residue.runs} execs=${residue.execs} evts=${residue.evts} cks=${residue.cks} projects=${residue.projects})`);
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
      ok(/append-only|duplicate key|invalid input value|violates/.test(e.message), `${what} refused (${label}: ${e.message.split('\n')[0].slice(0, 70)})`);
    }
  }
}

await main().catch((e) => { console.error('TEST ERROR:', e); fail++; });
console.log(fail ? `\n${fail} FAILED` : '\nall good');
process.exit(fail ? 1 : 0);
