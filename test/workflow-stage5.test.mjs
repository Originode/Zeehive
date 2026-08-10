// WORKFLOW STAGE 5 — entities + leases — the entity/lease plane
// (docs/hierarchical-workflow-adoption.md §5, stage 5; design §6.1–6.6, §8.5).
//
// This test proves migration 179 (workflow_stage5_entities_leases) against a REAL postgres
// with the full migration set applied. It is the stage-5 counterpart of
// test/workflow-stage3.test.mjs and extends that suite's pattern — a standalone node script
// with a header documenting coverage, a loud SKIP on a non-workflow db, and teardown in a
// finally. Coverage:
//
//   A. entity round-trip — insert/select, defaults (dispatch='push', cancellable='cooperative',
//      concurrency=1, deterministic=false, consumable=false, capacity_used=0, enabled=true),
//      capabilities is a text[] with a GIN index, kind_hint is a PLAIN text column (display
//      only — the engine-branch guard is test/entity-kind-hint-lint.test.mjs, section J).
//   B. entity_member round-trip — parent/member pool membership, weight default, the
//      no-self constraint, and ON DELETE CASCADE both ways.
//   C. lease round-trip — hold a lease on an execution, the lease_expiry_after_claim CHECK
//      rejects expires_at <= claimed_at, release it.
//   D. (b) ONE ACTIVE LEASE PER EXECUTION (E4) — a second 'held' lease on the same execution
//      is refused by the partial unique index lease_one_active_per_execution; a RELEASED
//      lease on the same execution coexists (the index is WHERE state='held'), so an
//      execution keeps lease HISTORY while holding exactly one active lease.
//   E. (a) LEASE LAPSE REQUEUES THE WORK — a held lease with expires_at in the past appears
//      in the lease_expiring view (the sweeper's read set — expiry is the universal timeout,
//      covering a crashed worker and an absent human identically). Requeue: mark the lease
//      expired, move the execution back to 'ready', and hold a NEW lease on the same
//      execution — the one-active index makes the requeue impossible until the old lease
//      leaves 'held', and open once it does.
//   F. (c) A CONSUMABLE ENTITY REFUSES OVERDRAW — consumable=true with capacity_total=10 and
//      capacity_used=9 accepts the final debit to 10 (at capacity) and REFUSES a debit to 11
//      (entity_capacity_not_overdrawn). A non-consumable entity has no capacity_total and its
//      capacity_used is not constrained that way (capacity returns on release).
//   G. capability matching — the SUPPLY side (entity.capabilities GIN index) answers a node's
//      req_capabilities: an entity tagged ['translate','legal-domain'] matches a node asking
//      for ['translate'] via @> containment, and the GIN index is chosen (EXPLAIN shows an
//      index scan, not a seq scan). The REQUIREMENTS side (work_node.req_capabilities/
//      req_constraints/req_selection) landed with stage 1 and is present.
//   H. entity_load view — active held leases vs concurrency headroom.
//   I. orphaned_work view (E6) — a cancelled execution bound to a cancellable='never' entity
//      is listed (it still consumes capacity / may still produce side effects); one bound to
//      cancellable='cooperative' is not.
//   J. (d) kind_hint lint GREEN — test/entity-kind-hint-lint.test.mjs exits 0 (no engine
//      file branches on entity.kind_hint).
//
// Everything it creates is torn down in a finally. It SKIPs loudly on a database that has not
// run the workflow migrations.
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
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

  // This test needs the stage-5 entity/lease schema; a non-Zeehive db skips loudly.
  const hasEntity = (await admin.query(`SELECT to_regclass('public.entity') AS r`)).rows[0].r;
  const hasLease  = (await admin.query(`SELECT to_regclass('public.lease') AS r`)).rows[0].r;
  const hasExpiring = (await admin.query(`SELECT to_regclass('public.lease_expiring') AS r`)).rows[0].r;
  if (!hasEntity || !hasLease || !hasExpiring) {
    console.log(`  SKIP: not a stage-5-workflow-migrated db (entity=${!!hasEntity}, lease=${!!hasLease}, lease_expiring=${!!hasExpiring})`);
    return;
  }

  const q = (text, params) => admin.query(text, params);
  const one = async (text, params) => (await admin.query(text, params)).rows[0];

  // throwaway project → plan → plan_version (v1) → one freeform root with an action leaf
  await q(`INSERT INTO project (id, name, repo_root, db_user, db_name) VALUES ($1,$2,'/tmp','u','d')`,
    [projectId, `wf-stage5-${tag}`]);
  const planId = (await one(`INSERT INTO plan (project_id, name) VALUES ($1,'stage5') RETURNING id`, [projectId])).id;
  const ver = (await one(`INSERT INTO plan_version (plan_id, version) VALUES ($1,1) RETURNING id`, [planId])).id;
  const R = (await one(
    `INSERT INTO work_node (plan_version_id, parent_id, sibling_rank, name, kind, child_semantics)
     VALUES ($1,NULL,'1','R','container','freeform') RETURNING id`, [ver])).id;
  const A1 = (await one(
    `INSERT INTO work_node (plan_version_id, parent_id, sibling_rank, name, kind)
     VALUES ($1,$2,'1','A1','action') RETURNING id`, [ver, R])).id;

  // track rows so teardown can remove them (runs cascade executions→leases→allocations;
  // entities are deleted separately — their leases must be gone first, so runs first)
  const runIds = [];
  const entityIds = [];
  const newRun = async () => {
    const r = await one(`INSERT INTO run (plan_version_id) VALUES ($1) RETURNING id`, [ver]);
    runIds.push(r.id);
    return r.id;
  };
  const entity = async (name, extra = {}) => {
    const cols = ['name'];
    const vals = [name];
    for (const k of ['kind_hint','capabilities','dispatch','cancellable','deterministic','concurrency',
                     'consumable','capacity_total','capacity_used','reliability']) {
      if (extra[k] !== undefined) { cols.push(k); vals.push(extra[k]); }
    }
    const e = await one(
      `INSERT INTO entity (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
      vals);
    entityIds.push(e.id);
    return e;
  };
  const exec = async (runId, nodeId, state, entityId, attempt = 1) =>
    one(
      `INSERT INTO execution (run_id, work_node_id, attempt, state, entity_id)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [runId, nodeId, attempt, state, entityId]);
  const holdLease = async (executionId, entityId, expiresAt, extra = {}) => {
    const cols = ['execution_id', 'entity_id', 'expires_at'];
    const vals = [executionId, entityId, expiresAt];
    for (const k of ['state', 'claimed_at']) {
      if (extra[k] !== undefined) { cols.push(k); vals.push(extra[k]); }
    }
    return one(
      `INSERT INTO lease (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
      vals);
  };

  try {
    // ── A. entity round-trip and defaults ─────────────────────────────────────
    console.log(`\nA. entity round-trip — defaults, capabilities, kind_hint`);
    const entA = await entity(`worker-${tag}`, { capabilities: ['translate', 'legal-domain'], kind_hint: 'human' });
    ok(entA.dispatch === 'push', `entity.dispatch defaults to 'push' (got ${entA.dispatch})`);
    ok(entA.cancellable === 'cooperative', `entity.cancellable defaults to 'cooperative' (got ${entA.cancellable})`);
    ok(entA.concurrency === 1, `entity.concurrency defaults to 1 (got ${entA.concurrency})`);
    ok(entA.deterministic === false, `entity.deterministic defaults to false`);
    ok(entA.consumable === false, `entity.consumable defaults to false`);
    ok(Number(entA.capacity_used) === 0, `entity.capacity_used defaults to 0`);
    ok(entA.enabled === true, `entity.enabled defaults to true`);
    ok(Number(entA.reliability) === 1, `entity.reliability defaults to 1 (got ${entA.reliability})`);
    ok(Array.isArray(entA.capabilities) && entA.capabilities.includes('translate'),
      `entity.capabilities is a text[] carrying the tagged capabilities`);
    ok(entA.kind_hint === 'human', `entity.kind_hint round-trips (display-only text column)`);
    // reliability CHECK
    await assertRefused(
      q(`INSERT INTO entity (name, reliability) VALUES ('bad', 1.5)`),
      'check', 'entity.reliability > 1 is refused (CHECK)');
    // consumable needs a capacity_total
    await assertRefused(
      q(`INSERT INTO entity (name, consumable) VALUES ('budget-no-total', true)`),
      'check', 'a consumable entity without capacity_total is refused (entity_consumable_needs_capacity)');
    // the capabilities GIN index exists
    ok((await one(`SELECT to_regclass('entity_capabilities_idx') AS r`)).r !== null,
      `entity_capabilities_idx (GIN on capabilities) exists`);

    // ── B. entity_member round-trip ──────────────────────────────────────────
    console.log(`\nB. entity_member — pool membership`);
    const pool = await entity(`pool-${tag}`);
    const member1 = await entity(`member1-${tag}`);
    await q(`INSERT INTO entity_member (parent_id, member_id) VALUES ($1,$2)`, [pool.id, member1.id]);
    const mRow = await one(`SELECT weight FROM entity_member WHERE parent_id=$1 AND member_id=$2`, [pool.id, member1.id]);
    ok(mRow.weight === '1', `entity_member.weight defaults to 1`);
    await assertRefused(
      q(`INSERT INTO entity_member (parent_id, member_id) VALUES ($1,$1)`, [pool.id]),
      'check', 'an entity cannot be its own member (entity_member_no_self)');
    await assertRefused(
      q(`INSERT INTO entity_member (parent_id, member_id) VALUES ($1,$2)`, [pool.id, member1.id]),
      'duplicate key', 'a duplicate (parent_id, member_id) membership is refused (PK)');
    // ON DELETE CASCADE both ways — deleting the member removes the membership row
    const member2 = await entity(`member2-${tag}`);
    await q(`INSERT INTO entity_member (parent_id, member_id) VALUES ($1,$2)`, [pool.id, member2.id]);
    await q(`DELETE FROM entity WHERE id=$1`, [member2.id]);
    ok((await one(`SELECT count(*)::int AS n FROM entity_member WHERE parent_id=$1`, [pool.id])).n === 1,
      `deleting a member cascades the membership row away (ON DELETE CASCADE)`);

    // ── C. lease round-trip and the expiry-after-claim CHECK ─────────────────
    console.log(`\nC. lease round-trip — hold and release`);
    const runC = await newRun();
    const exC = await exec(runC, A1, 'running', entA.id);
    const leaseC = await holdLease(exC.id, entA.id, new Date(Date.now() + 60_000));
    ok(leaseC.state === 'held', `a fresh lease is 'held'`);
    ok(leaseC.claimed_at && leaseC.heartbeat_at, `claimed_at and heartbeat_at are set`);
    // expires_at <= claimed_at is refused
    await assertRefused(
      q(`INSERT INTO lease (execution_id, entity_id, expires_at, claimed_at) VALUES ($1,$2,now()-'1h'::interval,now())`,
        [exC.id, entA.id]),
      'check', 'a lease that expires before it is claimed is refused (lease_expiry_after_claim)');
    await q(`UPDATE lease SET state='released', released_at=now() WHERE id=$1`, [leaseC.id]);
    ok((await one(`SELECT state FROM lease WHERE id=$1`, [leaseC.id])).state === 'released',
      `a held lease releases cleanly`);

    // ── D. (b) ONE ACTIVE LEASE PER EXECUTION (E4) ───────────────────────────
    console.log(`\nD. (b) one active lease per execution — the second 'held' is refused`);
    const runD = await newRun();
    const exD = await exec(runD, A1, 'running', entA.id);
    const l1 = await holdLease(exD.id, entA.id, new Date(Date.now() + 60_000));
    // second HELD lease on the same execution → refused by the partial unique index
    await assertRefused(
      holdLease(exD.id, entA.id, new Date(Date.now() + 120_000)),
      'duplicate key', 'a second HELD lease on the same execution is refused (lease_one_active_per_execution)');
    // a RELEASED lease on the same execution coexists — history, not a second holder
    await q(`UPDATE lease SET state='released', released_at=now() WHERE id=$1`, [l1.id]);
    const l1rel = await holdLease(exD.id, entA.id, new Date(Date.now() + 120_000), { state: 'released' });
    ok(l1rel.state === 'released', `a released lease coexists with prior released history on the same execution`);
    const leaseRows = (await q(`SELECT state FROM lease WHERE execution_id=$1 ORDER BY claimed_at`, [exD.id])).rows;
    ok(leaseRows.length === 2 && leaseRows.every(r => r.state === 'released'),
      `lease HISTORY accumulates (${leaseRows.length} released rows) while never holding two at once`);

    // ── E. (a) LEASE LAPSE REQUEUES THE WORK ─────────────────────────────────
    console.log(`\nE. (a) lease lapse requeues the work — expiry is the universal timeout`);
    const runE = await newRun();
    // a 'waiting' execution under a held lease that is ALREADY past expiry
    const exE = await exec(runE, A1, 'waiting', entA.id);
    // claimed an hour ago, expired 5s ago — satisfies lease_expiry_after_claim while being lapsed
    const past = await holdLease(exE.id, entA.id, new Date(Date.now() - 5_000),
      { claimed_at: new Date(Date.now() - 3_600_000) });
    // the sweeper's read set: held + expired
    const expiring = (await q(`SELECT * FROM lease_expiring WHERE id=$1`, [past.id])).rows;
    ok(expiring.length === 1, `a lapsed held lease appears in lease_expiring (the sweeper's read set)`);
    ok(expiring[0].run_id === runE && expiring[0].work_node_id === A1, `lease_expiring joins execution/run`);
    ok(expiring[0].entity_name === entA.name && expiring[0].cancellable === entA.cancellable,
      `lease_expiring joins entity name/cancellable`);
    // requeue: the sweeper marks the lapsed lease 'expired', the execution goes back to 'ready'
    await q(`UPDATE lease SET state='expired' WHERE id=$1`, [past.id]);
    await q(`UPDATE execution SET state='ready' WHERE id=$1`, [exE.id]);
    ok((await one(`SELECT state FROM execution WHERE id=$1`, [exE.id])).state === 'ready',
      `the lapsed execution requeues to 'ready'`);
    // a held lease NOT yet expired is NOT in the view — and holding it on the SAME execution
    // proves the requeue path is open: the ONE-ACTIVE index let a fresh holder in the moment
    // the lapsed lease left 'held'.
    const future = await holdLease(exE.id, entA.id, new Date(Date.now() + 60_000));
    ok(future.state === 'held', `a NEW held lease is possible after the lapsed lease leaves 'held' (the requeue path)`);
    const notExpiring = (await q(`SELECT count(*)::int AS n FROM lease_expiring WHERE id=$1`, [future.id])).rows[0].n;
    ok(notExpiring === 0, `a held lease still inside its window is NOT in lease_expiring`);

    // ── F. (c) A CONSUMABLE ENTITY REFUSES OVERDRAW ──────────────────────────
    console.log(`\nF. (c) consumable entity refuses overdraw`);
    const budget = await entity(`budget-${tag}`, { consumable: true, capacity_total: 10, capacity_used: 9 });
    await q(`UPDATE entity SET capacity_used = 10 WHERE id=$1`, [budget.id]);
    ok(Number((await one(`SELECT capacity_used FROM entity WHERE id=$1`, [budget.id])).capacity_used) === 10,
      `a consumable entity accepts the final debit to capacity (9 → 10 = at capacity)`);
    await assertRefused(
      q(`UPDATE entity SET capacity_used = 11 WHERE id=$1`, [budget.id]),
      'check', 'a consumable entity REFUSES overdraw 10 → 11 (entity_capacity_not_overdrawn)');
    // a NON-consumable entity has no capacity_total → capacity_used is unconstrained by the
    // overdraw CHECK (capacity returns on release, so it is not "spent")
    const workerF = await entity(`workerf-${tag}`);
    await q(`UPDATE entity SET capacity_used = 5 WHERE id=$1`, [workerF.id]);
    ok(Number((await one(`SELECT capacity_used FROM entity WHERE id=$1`, [workerF.id])).capacity_used) === 5,
      `a non-consumable entity (no capacity_total) carries capacity_used freely — capacity returns on release`);

    // ── G. capability matching — supply answers requirements ─────────────────
    console.log(`\nG. capability matching — entity.capabilities answers a node's req_capabilities`);
    // a node requiring ['translate'] must match an entity tagged ['translate','legal-domain']
    // and not one tagged ['legal-domain'] only
    const translator = await entity(`translator-${tag}`, { capabilities: ['translate', 'legal-domain'] });
    const lawyer = await entity(`lawyer-${tag}`, { capabilities: ['legal-domain'] });
    const matches = (await q(
      `SELECT id FROM entity WHERE capabilities @> $1::text[] ORDER BY name`, [['translate']])).rows;
    ok(matches.some(r => r.id === translator.id) && !matches.some(r => r.id === lawyer.id),
      `@> containment matches the tagged entity and excludes the untagged one`);
    // the GIN index is actually used. With 2 rows postgres would (correctly) choose a seq scan,
    // so force enable_seqscan=off for this one statement — the plan must then use the index if
    // it exists. Scoped with SET LOCAL inside a transaction so the session is not mutated;
    // EXPLAIN (FORMAT JSON) returns the whole plan as one row, unlike text format (one row per
    // plan line, which the `one()` helper would truncate to the first line).
    await q('BEGIN');
    await q(`SET LOCAL enable_seqscan = off`);
    const planJson = (await one(
      `EXPLAIN (FORMAT JSON) SELECT id FROM entity WHERE capabilities @> $1::text[]`, [['translate']]))['QUERY PLAN'];
    await q('COMMIT');
    const planText = JSON.stringify(planJson);
    ok(/entity_capabilities_idx/i.test(planText), `GIN index serves the containment query`);
    // the REQUIREMENTS side landed with stage 1 and is present on work_node
    const wnCols = (await q(
      `SELECT column_name FROM information_schema.columns WHERE table_name='work_node'
       AND column_name IN ('req_capabilities','req_constraints','req_selection')`)).rows.map(r => r.column_name).sort();
    ok(['req_capabilities','req_constraints','req_selection'].every(c => wnCols.includes(c)),
      `work_node carries req_capabilities/req_constraints/req_selection (stage 1 supply for matching)`);

    // ── H. entity_load view ──────────────────────────────────────────────────
    console.log(`\nH. entity_load — active leases vs concurrency headroom`);
    const runner = await entity(`runner-${tag}`, { concurrency: 2 });
    const runH = await newRun();
    const exH1 = await exec(runH, A1, 'running', runner.id);
    await holdLease(exH1.id, runner.id, new Date(Date.now() + 60_000));
    let load = (await one(`SELECT active, headroom FROM entity_load WHERE id=$1`, [runner.id]));
    ok(Number(load.active) === 1 && Number(load.headroom) === 1,
      `one held lease → active=1, headroom=1 (concurrency 2)`);
    // attempt 2: the exec_attempt_idx is (run, node, attempt, map, loop) — a second execution
    // for the same node in one run must carry a distinct attempt
    const exH2 = await exec(runH, A1, 'running', runner.id, 2);
    await holdLease(exH2.id, runner.id, new Date(Date.now() + 60_000));
    load = (await one(`SELECT active, headroom FROM entity_load WHERE id=$1`, [runner.id]));
    ok(Number(load.active) === 2 && Number(load.headroom) === 0,
      `two held leases → active=2, headroom=0 (at capacity)`);

    // ── I. orphaned_work view (E6) ───────────────────────────────────────────
    console.log(`\nI. orphaned_work — cancelled work on a cancellable=never entity is tracked`);
    const unkillable = await entity(`unkillable-${tag}`, { cancellable: 'never' });
    const stoppable = await entity(`stoppable-${tag}`, { cancellable: 'cooperative' });
    const runI = await newRun();
    await exec(runI, A1, 'cancelled', unkillable.id, 1);
    await exec(runI, A1, 'cancelled', stoppable.id, 2);
    const orphans = (await q(`SELECT execution_id, entity_name FROM orphaned_work WHERE run_id=$1`, [runI])).rows;
    ok(orphans.some(o => o.entity_name === unkillable.name),
      `a cancelled execution on a cancellable=never entity is listed (still consuming capacity)`);
    ok(!orphans.some(o => o.entity_name === stoppable.name),
      `a cancelled execution on a cancellable=cooperative entity is NOT listed (it stopped)`);

    // ── J. (d) kind_hint lint GREEN ──────────────────────────────────────────
    console.log(`\nJ. (d) kind_hint lint green — no engine file branches on entity.kind_hint`);
    const lint = spawnSync(process.execPath,
      [resolve(dirname(fileURLToPath(import.meta.url)), 'entity-kind-hint-lint.test.mjs')],
      { encoding: 'utf8' });
    ok(lint.status === 0, `test/entity-kind-hint-lint.test.mjs exits 0 (got ${lint.status})`
      + (lint.status === 0 ? '' : `\n${String(lint.stdout).split('\n').slice(-3).join('\n')}`));

  } finally {
    // tear down: runs cascade executions → leases → allocations; then entities; then the
    // project. A FAILED teardown prints and counts as a FAIL — never swallow.
    try {
      await q(`SET zeehive.purge_events = 'on'`);
      for (const id of runIds) {
        await q(`DELETE FROM run WHERE id=$1`, [id]);
      }
      // lease.entity_id / allocation.entity_id have NO cascade (an entity is referenced
      // history) — but the runs above cascaded the executions and their leases away, so the
      // entities are free to delete now.
      for (const id of entityIds) {
        await q(`DELETE FROM entity WHERE id=$1`, [id]);
      }
      await q(`DELETE FROM project WHERE id=$1`, [projectId]);
      await q(`RESET zeehive.purge_events`);

      const residue = await one(
        `SELECT
           (SELECT count(*)::int FROM run          WHERE id = ANY($1::uuid[]))  AS runs,
           (SELECT count(*)::int FROM execution    WHERE run_id = ANY($1::uuid[])) AS execs,
           (SELECT count(*)::int FROM event        WHERE run_id = ANY($1::uuid[])) AS evts,
           (SELECT count(*)::int FROM lease        WHERE execution_id IN (SELECT id FROM execution WHERE run_id = ANY($1::uuid[])) OR entity_id = ANY($2::uuid[])) AS leases,
           (SELECT count(*)::int FROM allocation   WHERE execution_id IN (SELECT id FROM execution WHERE run_id = ANY($1::uuid[])) OR entity_id = ANY($2::uuid[])) AS allocs,
           (SELECT count(*)::int FROM entity       WHERE id = ANY($2::uuid[])) AS entities,
           (SELECT count(*)::int FROM project WHERE id = $3) AS projects`,
        [runIds, entityIds, projectId]);
      ok(residue.runs === 0 && residue.execs === 0 && residue.evts === 0
        && residue.leases === 0 && residue.allocs === 0
        && residue.entities === 0 && residue.projects === 0,
        `teardown leaves no residue (runs=${residue.runs} execs=${residue.execs} evts=${residue.evts} leases=${residue.leases} allocs=${residue.allocs} entities=${residue.entities} projects=${residue.projects})`);
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
      ok(/append-only|duplicate key|invalid input value|violates|check constraint/.test(e.message), `${what} refused (${label}: ${e.message.split('\n')[0].slice(0, 70)})`);
    }
  }
}

await main().catch((e) => { console.error('TEST ERROR:', e); fail++; });
console.log(fail ? `\n${fail} FAILED` : '\nall good');
process.exit(fail ? 1 : 0);
