// HIERARCHICAL WORKFLOW MODEL — STAGE 1 (integration, against a REAL database).
//
// The first real migrations of the hierarchical workflow model
// (db/migrations/167…175): plan/plan_version/work_node/dependency, the tree
// functions (wn_ancestors/wn_lca/wn_first_leaves/wn_last_leaves/wn_is_atom),
// the union graph + leaf-expanded cycle detection, the I5/I6 dependency-legality
// trigger, wn_effective_policy and wn_duration. This file proves the shipped
// behaviour against the real objects:
//
//   1. THE FALSE-CYCLE CASE (day-one requirement): A = sequence[A1, A2], B =
//      sequence[B1, B2], explicit deps A1→B1 and B2→A2, all under a freeform
//      root. Contracting each subtree to one vertex would report A→B and B→A
//      (a cycle); leaf-expansion sees the acyclic path A1→B1→B2→A2 and must
//      report NO cycle. detect_cycles returns nothing.
//   2. I5: an explicit dependency whose LCA is a SEQUENCE parent is REFUSED
//      (only freeform permits explicit dependencies).
//   3. I6: an explicit dependency between an ancestor and a descendant is
//      REFUSED.
//   4. A genuine cycle inside a freeform region IS detected.
//   5. wn_duration rolls up exactly: sequence sums its children, parallel takes
//      the max.
//   6. wn_effective_policy inherits from the nearest ancestor that sets the
//      field, and a child override wins over the root default.
//   7. wn_first_leaves / wn_last_leaves under sequence (first/last child only)
//      and freeform (every child).
//   8. Tenancy weld: a plan binds to a ZEEHIVE project at the root.
//
// Everything created is torn down in a finally. NO test data left behind.
import pg from 'pg';
import { randomUUID } from 'node:crypto';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };
const section = (t) => console.log(`\n── ${t} ──`);

const client = new pg.Client({ connectionString: url });

const PID = randomUUID();
const HOUR = (n) => `${n} hour${n === 1 ? '' : 's'}`;
const MINUTE = (n) => `${n} minutes`;

// ── helpers ──────────────────────────────────────────────────────────────────
async function addNode(pv, parent, { name, kind = 'action', sem = null, rank = '0',
  estimate = null, retryPolicy = null, timeout = null, priority = null }) {
  const { rows } = await client.query(
    `INSERT INTO work_node
       (plan_version_id, parent_id, sibling_rank, name, kind, child_semantics,
        estimate, retry_policy, timeout, priority)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING id`,
    [pv, parent, rank, name, kind, sem, estimate, retryPolicy, timeout, priority]);
  return rows[0].id;
}

async function addDep(fromId, toId, type = 'FS') {
  const { rows } = await client.query(
    `INSERT INTO dependency (from_id, to_id, type) VALUES ($1,$2,$3) RETURNING id`,
    [fromId, toId, type]);
  return rows[0].id;
}

// a plan + version pair under the shared test project
async function newPlanVersion(name) {
  const { rows: p } = await client.query(
    `INSERT INTO plan (project_id, name) VALUES ($1,$2) RETURNING id`, [PID, name]);
  const { rows: v } = await client.query(
    `INSERT INTO plan_version (plan_id, version) VALUES ($1,1) RETURNING id`, [p[0].id]);
  return { planId: p[0].id, versionId: v[0].id };
}

async function setRoot(v, rootId) {
  await client.query(`UPDATE plan_version SET root_node_id = $1 WHERE id = $2`, [rootId, v]);
}

try {
  await client.connect();

  // ── seed the tenancy root ───────────────────────────────────────────────
  section('tenancy weld');
  await client.query(
    `INSERT INTO project (id, name, repo_root) VALUES ($1,'stage1-workflow-test','/tmp/s1')`, [PID]);

  // ── 1. THE FALSE-CYCLE CASE ─────────────────────────────────────────────
  section('false cycle: A=seq[A1,A2], B=seq[B1,B2], A1→B1 & B2→A2, leaf-expanded acyclic');
  const { versionId: vA } = await newPlanVersion('false-cycle');
  const R  = await addNode(vA, null, { name: 'root', kind: 'container', sem: 'freeform', rank: 'r' });
  const A  = await addNode(vA, R,   { name: 'A', kind: 'container', sem: 'sequence', rank: 'a' });
  const A1 = await addNode(vA, A,   { name: 'A1', rank: 'a1' });
  const A2 = await addNode(vA, A,   { name: 'A2', rank: 'a2' });
  const B  = await addNode(vA, R,   { name: 'B', kind: 'container', sem: 'sequence', rank: 'b' });
  const B1 = await addNode(vA, B,   { name: 'B1', rank: 'b1' });
  const B2 = await addNode(vA, B,   { name: 'B2', rank: 'b2' });
  await setRoot(vA, R);
  await addDep(A1, B1);   // legal: LCA(A1,B1) = R (freeform)
  await addDep(B2, A2);   // legal: LCA(B2,A2) = R (freeform)

  const fc = await client.query(`SELECT * FROM detect_cycles($1)`, [vA]);
  ok(fc.rows.length === 0,
     `detect_cycles returns NO cycle for the A1→B1,B2→A2 false-cycle shape (got ${fc.rows.length} row(s))`);

  // the union graph really does contain the cross edges (sanity: the test is not
  // vacuous — the deps ARE in the graph, leaf-expanded)
  const ue = await client.query(
    `SELECT from_id, to_id FROM union_edge WHERE plan_version_id = $1 ORDER BY to_id, from_id`, [vA]);
  const edges = ue.rows.map((r) => `${r.from_id}->${r.to_id}`);
  ok(edges.some((e) => e.startsWith(`${A1}->${B1}`)), 'union_edge contains A1→B1 (dep, leaf-expanded)');
  ok(edges.some((e) => e.startsWith(`${B2}->${A2}`)), 'union_edge contains B2→A2 (dep, leaf-expanded)');
  ok(edges.some((e) => e.startsWith(`${A1}->${A2}`)), 'union_edge contains A1→A2 (sequence order inside A)');
  ok(edges.some((e) => e.startsWith(`${B1}->${B2}`)), 'union_edge contains B1→B2 (sequence order inside B)');
  ok(!edges.some((e) => e.includes(`${A}->${B}`) || e.includes(`${B}->${A}`)),
     'union_edge contains NO contracted A→B / B→A edge (leaf expansion)');

  // ── 2. I5: sequence parent refuses an explicit dependency ───────────────
  section('I5: explicit dependency under a SEQUENCE parent is refused');
  const { versionId: vI5 } = await newPlanVersion('i5');
  const R5 = await addNode(vI5, null, { name: 'root', kind: 'container', sem: 'sequence', rank: 'r' });
  const X = await addNode(vI5, R5, { name: 'X', rank: 'x' });
  const Y = await addNode(vI5, R5, { name: 'Y', rank: 'y' });
  await setRoot(vI5, R5);
  let i5msg = null;
  try { await addDep(X, Y); } catch (e) { i5msg = e.message; }
  ok(i5msg !== null && /I5/.test(i5msg),
     `dep X→Y under a sequence parent is refused (got: ${i5msg ? i5msg.split('\n')[0] : 'NO ERROR'})`);

  // ── 3. I6: ancestor dependency refused ──────────────────────────────────
  section('I6: ancestor/descendant dependency is refused');
  const { versionId: vI6 } = await newPlanVersion('i6');
  const R6 = await addNode(vI6, null, { name: 'root', kind: 'container', sem: 'freeform', rank: 'r' });
  const N6 = await addNode(vI6, R6, { name: 'N6', rank: 'n' });
  await setRoot(vI6, R6);
  let i6msg = null;
  try { await addDep(R6, N6); } catch (e) { i6msg = e.message; }
  try { await addDep(N6, R6); } catch (e) { i6msg = e.message; }
  ok(i6msg !== null && /I6/.test(i6msg),
     `an ancestor dependency is refused (got: ${i6msg ? i6msg.split('\n')[0] : 'NO ERROR'})`);

  // ── 4. a REAL cycle inside freeform IS detected ─────────────────────────
  section('detect_cycles: a genuine freeform cycle is reported');
  const { versionId: vC } = await newPlanVersion('cycle');
  const RC = await addNode(vC, null, { name: 'root', kind: 'container', sem: 'freeform', rank: 'r' });
  const C = await addNode(vC, RC, { name: 'C', rank: 'c' });
  const D = await addNode(vC, RC, { name: 'D', rank: 'd' });
  await setRoot(vC, RC);
  await addDep(C, D);
  await addDep(D, C);
  const cyc = await client.query(`SELECT * FROM detect_cycles($1)`, [vC]);
  ok(cyc.rows.length > 0,
     `detect_cycles returns ≥1 cycle for C→D→C (got ${cyc.rows.length} row(s))`);

  // ── 5. wn_duration: sequence sums, parallel maxes ───────────────────────
  section('wn_duration: sequence sums, parallel maxes');
  const { versionId: vD } = await newPlanVersion('duration');
  const RD = await addNode(vD, null, { name: 'root', kind: 'container', sem: 'sequence', rank: 'r' });
  const P  = await addNode(vD, RD,  { name: 'P', kind: 'container', sem: 'parallel', rank: 'p' });
  await addNode(vD, P,  { name: 'P1', rank: 'p1', estimate: HOUR(1) });
  await addNode(vD, P,  { name: 'P2', rank: 'p2', estimate: HOUR(2) });
  await addNode(vD, RD, { name: 'S', rank: 's', estimate: MINUTE(30) });
  await setRoot(vD, RD);
  const dPar = await client.query(`SELECT wn_duration($1)::text AS d`, [P]);
  const dSeq = await client.query(`SELECT wn_duration($1)::text AS d`, [RD]);
  ok(dPar.rows[0].d === '02:00:00',
     `parallel rollup = max(1h, 2h) = 02:00:00 (got ${dPar.rows[0].d})`);
  ok(dSeq.rows[0].d === '02:30:00',
     `sequence rollup = parallel(2h) + 30m = 02:30:00 (got ${dSeq.rows[0].d})`);
  const dLeaf = await client.query(`SELECT wn_duration((SELECT id FROM work_node WHERE name='P1' AND plan_version_id=$1))::text AS d`, [vD]);
  ok(dLeaf.rows[0].d === '01:00:00',
     `leaf duration = its own estimate = 01:00:00 (got ${dLeaf.rows[0].d})`);

  // ── 6. wn_effective_policy: nearest non-null ancestor wins ──────────────
  section('wn_effective_policy: inheritance + override');
  const { versionId: vP } = await newPlanVersion('policy');
  const RP = await addNode(vP, null, { name: 'root', kind: 'container', sem: 'freeform', rank: 'r',
    retryPolicy: { max: 3 }, timeout: HOUR(1), priority: 5 });
  const N1 = await addNode(vP, RP, { name: 'N1', rank: 'n1' });
  const N2 = await addNode(vP, RP, { name: 'N2', rank: 'n2', timeout: HOUR(2) });
  await setRoot(vP, RP);
  const pol1 = await client.query(`SELECT retry_policy, timeout::text AS timeout, priority FROM wn_effective_policy($1)`, [N1]);
  const pol2 = await client.query(`SELECT retry_policy, timeout::text AS timeout, priority FROM wn_effective_policy($1)`, [N2]);
  ok(pol1.rows[0].retry_policy.max === 3 && pol1.rows[0].timeout === '01:00:00' && pol1.rows[0].priority === 5,
     `N1 inherits root retry/timeout/priority (retry=${JSON.stringify(pol1.rows[0].retry_policy)}, timeout=${pol1.rows[0].timeout}, prio=${pol1.rows[0].priority})`);
  ok(pol2.rows[0].retry_policy.max === 3 && pol2.rows[0].timeout === '02:00:00' && pol2.rows[0].priority === 5,
     `N2 overrides timeout, inherits retry/priority (retry=${JSON.stringify(pol2.rows[0].retry_policy)}, timeout=${pol2.rows[0].timeout}, prio=${pol2.rows[0].priority})`);

  // ── 7. first/last leaves ────────────────────────────────────────────────
  section('wn_first_leaves / wn_last_leaves');
  const fl = await client.query(`SELECT id FROM wn_first_leaves($1) ORDER BY id`, [R]);
  const ll = await client.query(`SELECT id FROM wn_last_leaves($1) ORDER BY id`, [R]);
  const flIds = fl.rows.map((r) => r.id).sort();
  const llIds = ll.rows.map((r) => r.id).sort();
  const expectFirst = [A1, B1].sort();
  const expectLast = [A2, B2].sort();
  ok(JSON.stringify(flIds) === JSON.stringify(expectFirst),
     `wn_first_leaves(freeform root) = {A1,B1} (got ${flIds.length} leaf(ren))`);
  ok(JSON.stringify(llIds) === JSON.stringify(expectLast),
     `wn_last_leaves(freeform root) = {A2,B2} (got ${llIds.length} leaf(ren))`);
  const flA = await client.query(`SELECT id FROM wn_first_leaves($1)`, [A]);
  const llA = await client.query(`SELECT id FROM wn_last_leaves($1)`, [A]);
  ok(flA.rows.length === 1 && flA.rows[0].id === A1, 'wn_first_leaves(seq A) = {A1}');
  ok(llA.rows.length === 1 && llA.rows[0].id === A2, 'wn_last_leaves(seq A) = {A2}');

  // ── 8. tenancy: plan binds to the project at the root ───────────────────
  section('tenancy: the plan row binds to the ZEEHIVE project');
  const ten = await client.query(
    `SELECT p.project_id = $1 AS bound FROM plan p JOIN plan_version pv ON pv.plan_id = p.id WHERE pv.id = $2`,
    [PID, vA]);
  ok(ten.rows[0].bound === true, 'plan.project_id points at the test project (root binding)');
  const wnCols = await client.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name='work_node' AND column_name='project_id'`);
  ok(wnCols.rows.length === 0, 'work_node carries NO project_id (tenancy is lexical, not stamped)');

  console.log(`\n${fail === 0 ? 'PASS' : fail + ' FAILURE(S)'}`);
} catch (e) {
  console.error('\n✗ TEST CRASHED', e.message);
  console.error(e.stack);
  fail++;
  console.log(`\n${fail} FAILURE(S)`);
} finally {
  try { await client.query(`DELETE FROM project WHERE id = $1::uuid`, [PID]); } catch (e) { /* already gone */ }
  await client.end();
}

process.exit(fail === 0 ? 0 : 1);
