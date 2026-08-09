// WORKFLOW STAGE 1 — plan/plan_version/work_node/dependency, the union graph, and
// leaf-expanded cycle detection (docs/hierarchical-workflow-adoption.md §5, stage 1).
//
// This test proves the first real migrations (165 workflow_plane0_plan_plan_version,
// 166 workflow_plane1_work_node_dependency) against a REAL postgres with the full
// migration set applied in order. It exercises the correctness bar that killed naive
// implementations, then the design's own tree/rollup helpers:
//
//   1. the A1→B1, B2→A2 FALSE CYCLE — containment says A and B are siblings; the
//      dependency edges cross between their leaves in opposite directions. Under LEAF
//      EXPANSION this is NOT a cycle and must be accepted (detect_cycles returns 0).
//      A container-level collapse would wrongly reject it.
//   2. I5 rejection — a dependency whose LCA has child_semantics <> 'freeform' (an
//      explicit edge under a 'sequence' parent) is REFUSED by the trigger.
//   3. I6 rejection — an endpoint that is an ancestor of the other is REFUSED.
//   4. self-edge refused, cross-plan edge refused.
//   5. FS/SS/FF/SF + lag round-trip through dependency.
//   6. the union_edge view expands per link type (sequence order + expanded deps).
//   7. wn_lca on deep trees; wn_first_leaves/wn_last_leaves on a nested container.
//   8. wn_duration: sequence = Σ, parallel = max, freeform = documented max fallback.
//   9. child_semantics restricted to sequence/parallel/freeform today ('choice' refused).
//  10. wn_effective_policy resolves nearest-non-null up the ancestor chain.
//  11. a REAL cycle (X→Y, Y→X) is detected once present.
//
// Everything it creates is torn down in a finally. It SKIPs loudly on a database that
// has not run the workflow migrations.
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

  // This test needs the workflow schema; a non-Zeehive db skips loudly.
  const hasPlan = (await admin.query(`SELECT to_regclass('public.plan') AS r`)).rows[0].r;
  const hasWorkNode = (await admin.query(`SELECT to_regclass('public.work_node') AS r`)).rows[0].r;
  const hasUnionEdge = (await admin.query(`SELECT to_regclass('public.union_edge') AS r`)).rows[0].r;
  if (!hasPlan || !hasWorkNode || !hasUnionEdge) {
    console.log(`  SKIP: not a workflow-migrated db (plan=${!!hasPlan}, work_node=${!!hasWorkNode}, union_edge=${!!hasUnionEdge})`);
    return;
  }

  const q = (text, params) => admin.query(text, params);
  const one = async (text, params) => (await admin.query(text, params)).rows[0];

  // throwaway project → plan → plan_version (v1)
  await q(`INSERT INTO project (id, name, repo_root, db_user, db_name) VALUES ($1,$2,'/tmp','u','d')`,
    [projectId, `wf-stage1-${tag}`]);
  const planId = (await one(`INSERT INTO plan (project_id, name) VALUES ($1,'stage1') RETURNING id`, [projectId])).id;
  const ver = (await one(`INSERT INTO plan_version (plan_id, version) VALUES ($1,1) RETURNING id`, [planId])).id;

  // node helper: (name, kind, semantics, parent, rank, estimate?)
  const node = async (name, kind, sem, parent, rank, estimate) =>
    (await one(
      `INSERT INTO work_node (plan_version_id, parent_id, sibling_rank, name, kind, child_semantics, estimate)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [ver, parent, rank, name, kind, sem, estimate ?? null])).id;

  const dep = (from, to, type, lag) =>
    q(`INSERT INTO dependency (from_id, to_id, type, lag) VALUES ($1,$2,$3,COALESCE($4,'0'::interval))`,
      [from, to, type, lag ?? null]);

  // ── the tree ────────────────────────────────────────────────────────────────
  const R   = await node('R',   'container', 'freeform', null, '1');
  const A   = await node('A',   'container', 'sequence', R,    '1');
  const A1  = await node('A1',  'action',    null,       A,    '1');
  const A2  = await node('A2',  'action',    null,       A,    '2');
  const B   = await node('B',   'container', 'sequence', R,    '2');
  const B1  = await node('B1',  'action',    null,       B,    '1');
  const B2  = await node('B2',  'action',    null,       B,    '2');
  const F   = await node('F',   'container', 'freeform', R,    '3');
  const X1  = await node('X1',  'action',    null,       F,    '1', '2 hours');
  const X2  = await node('X2',  'action',    null,       F,    '2', '3 hours');
  const G   = await node('G',   'container', 'freeform', R,    '4');
  const G1  = await node('G1',  'container', 'freeform', G,    '1');
  const GA  = await node('GA',  'action',    null,       G1,   '1');
  const G2  = await node('G2',  'container', 'freeform', G,    '2');
  const GC  = await node('GC',  'action',    null,       G2,   '1');
  const Seq = await node('Seq', 'container', 'sequence', R,    '5');
  const SeqA = await node('SeqA','action',   null,       Seq,  '1', '2 hours');
  const SeqB = await node('SeqB','action',   null,       Seq,  '2', '3 hours');
  const Par = await node('Par', 'container', 'parallel', R,    '6');
  const ParA = await node('ParA','action',   null,       Par,  '1', '2 hours');
  const ParB = await node('ParB','action',   null,       Par,  '2', '3 hours');
  const Pol = await node('Pol', 'container', 'freeform', R,    '7');
  await q(`UPDATE work_node SET retry_policy='{"max":3}'::jsonb, priority=5 WHERE id=$1`, [Pol]);
  const Mid = await node('Mid', 'container', 'freeform', Pol,  '1');
  await q(`UPDATE work_node SET priority=7 WHERE id=$1`, [Mid]);
  const Leaf = await node('Leaf','action',   null,       Mid,  '1');

  try {
    // ── 1. THE FALSE CYCLE (correctness bar) ─────────────────────────────────
    console.log(`\nA. A1→B1, B2→A2 false cycle is ACCEPTED (leaf-expanded detect_cycles)`);
    await dep(A1, B1, 'FS');
    await dep(B2, A2, 'FS');
    const noCycle = await q(`SELECT * FROM detect_cycles($1)`, [ver]);
    ok(noCycle.rowCount === 0, `detect_cycles returns 0 rows (got ${noCycle.rowCount}) — leaf expansion sees A1→B1→B2→A2, acyclic`);

    // the union_edge view carries both the sequence order and the expanded deps
    const edges = (await q(
      `SELECT from_id, to_id, origin FROM union_edge WHERE plan_version_id=$1`, [ver])).rows;
    const hasEdge = (f, t, origin) => edges.some(e => e.from_id === f && e.to_id === t && e.origin === origin);
    ok(hasEdge(A1, A2, 'sequence'), `union_edge has sequence order A1→A2`);
    ok(hasEdge(B1, B2, 'sequence'), `union_edge has sequence order B1→B2`);
    ok(hasEdge(A1, B1, 'dependency'), `union_edge has expanded dependency A1→B1`);
    ok(hasEdge(B2, A2, 'dependency'), `union_edge has expanded dependency B2→A2`);

    // ── 2. I5 rejection — dep under a 'sequence' parent ──────────────────────
    console.log(`\nB. I5 — explicit dependency whose LCA is not freeform is REFUSED`);
    await assertRefused(dep(A1, A2, 'FS'), 'I5', 'A1→A2 under sequence parent A');

    // ── 3. I6 rejection — ancestor endpoint ──────────────────────────────────
    console.log(`\nC. I6 — an endpoint that is an ancestor of the other is REFUSED`);
    await assertRefused(dep(A1, A, 'FS'), 'I6', 'A1→A (A is A1\'s ancestor)');
    await assertRefused(dep(A, A1, 'FS'), 'I6', 'A→A1 (A is A1\'s ancestor, reversed)');

    // ── 4. self-edge and cross-plan edges refused ────────────────────────────
    console.log(`\nD. self-edge and cross-plan edges refused`);
    await assertRefused(dep(A1, A1, 'FS'), 'refused', 'self-edge A1→A1');

    // a second version of the same plan, with its own tree
    const ver2 = (await one(`INSERT INTO plan_version (plan_id, version) VALUES ($1,2) RETURNING id`, [planId])).id;
    const R2 = (await one(
      `INSERT INTO work_node (plan_version_id, parent_id, sibling_rank, name, kind, child_semantics)
       VALUES ($1,NULL,'1','R2','container','freeform') RETURNING id`, [ver2])).id;
    const X = (await one(
      `INSERT INTO work_node (plan_version_id, parent_id, sibling_rank, name, kind)
       VALUES ($1,$2,'1','X','action') RETURNING id`, [ver2, R2])).id;
    await assertRefused(dep(A1, X, 'FS'), 'I5', `A1→X (A1 in v1, X in v2 — no common ancestor)`);

    // ── 5. FS/SS/FF/SF + lag round-trip ──────────────────────────────────────
    console.log(`\nE. FS/SS/FF/SF + lag round-trip`);
    await dep(X1, X2, 'FS', '1 day');
    await dep(X1, X2, 'SS', '2 hours');
    await dep(X1, X2, 'FF', '3 days');
    await dep(X1, X2, 'SF', '-1 hour');
    const round = (await q(
      `SELECT type, lag FROM dependency WHERE from_id=$1 AND to_id=$2 ORDER BY type`, [X1, X2])).rows;
    const lagOf = (type) => round.find(r => r.type === type)?.lag;
    ok(round.length === 4, `all four dependency types round-trip (got ${round.length})`);
    ok(lagOf('FS')?.days === 1,   `FS lag = 1 day (got ${lagOf('FS')})`);
    ok(lagOf('SS')?.hours === 2,  `SS lag = 2 hours (got ${lagOf('SS')})`);
    ok(lagOf('FF')?.days === 3,   `FF lag = 3 days (got ${lagOf('FF')})`);
    ok(lagOf('SF')?.hours === -1, `SF lag = -1 hour lead (got ${lagOf('SF')})`);

    // ── 6. wn_lca on deep trees ──────────────────────────────────────────────
    console.log(`\nF. wn_lca on deep trees`);
    ok((await one(`SELECT wn_lca($1,$2) AS l`, [GA, GC])).l === G, `wn_lca(GA, GC) = G (deep tree)`);
    ok((await one(`SELECT wn_lca($1,$2) AS l`, [GA, GA])).l === GA, `wn_lca(GA, GA) = GA (self is LCA at depth 0)`);
    ok((await one(`SELECT wn_lca($1,$2) AS l`, [A1, B2])).l === R, `wn_lca(A1, B2) = R (sibling subtrees)`);

    // ── 7. wn_first_leaves / wn_last_leaves on a nested container ───────────
    console.log(`\nG. wn_first_leaves / wn_last_leaves`);
    const first = (await q(`SELECT id FROM wn_first_leaves($1)`, [R])).rows.map(r => r.id);
    const last  = (await q(`SELECT id FROM wn_last_leaves($1)`,  [R])).rows.map(r => r.id);
    const hasAll = (list, want) => want.every(id => list.includes(id));
    ok(hasAll(first, [A1, B1, X1, X2, GA, GC, SeqA, ParA, ParB, Leaf]),
      `first_leaves(R) = {A1,B1,X1,X2,GA,GC,SeqA,ParA,ParB,Leaf} (got ${first.length})`);
    ok(hasAll(last,  [A2, B2, X1, X2, GA, GC, SeqB, ParA, ParB, Leaf]),
      `last_leaves(R) = {A2,B2,X1,X2,GA,GC,SeqB,ParA,ParB,Leaf} (got ${last.length})`);
    const seqFirst = (await q(`SELECT id FROM wn_first_leaves($1)`, [Seq])).rows.map(r => r.id);
    const seqLast  = (await q(`SELECT id FROM wn_last_leaves($1)`,  [Seq])).rows.map(r => r.id);
    ok(seqFirst.length === 1 && seqFirst[0] === SeqA, `first_leaves(sequence) = only the first child's first leaf`);
    ok(seqLast.length === 1 && seqLast[0] === SeqB,   `last_leaves(sequence) = only the last child's last leaf`);

    // ── 8. wn_duration per operator ──────────────────────────────────────────
    console.log(`\nH. wn_duration — sequence Σ / parallel max / freeform fallback`);
    ok((await one(`SELECT wn_duration($1) AS d`, [Seq])).d?.hours === 5, `sequence duration = 2h+3h = 5h (got ${(await one(`SELECT wn_duration($1) AS d`, [Seq])).d})`);
    ok((await one(`SELECT wn_duration($1) AS d`, [Par])).d?.hours === 3, `parallel duration = max(2h,3h) = 3h (got ${(await one(`SELECT wn_duration($1) AS d`, [Par])).d})`);
    ok((await one(`SELECT wn_duration($1) AS d`, [F])).d?.hours === 3, `freeform duration = max fallback = 3h (got ${(await one(`SELECT wn_duration($1) AS d`, [F])).d})`);
    const leafZero = await one(`SELECT EXTRACT(EPOCH FROM wn_duration($1)) AS s`, [A1]);
    ok(Number(leafZero.s) === 0, `leaf without estimate = 0 (got ${leafZero.s}s)`);

    // ── 9. child_semantics restricted to stage-1 operators ──────────────────
    console.log(`\nI. child_semantics restricted to sequence/parallel/freeform today`);
    await assertRefused(
      q(`INSERT INTO work_node (plan_version_id, parent_id, sibling_rank, name, kind, child_semantics)
         VALUES ($1,$2,'9','C','container','choice')`, [ver, R]),
      'choice refused', "'choice' container rejected (stage 4+)");

    // ── 10. wn_effective_policy — nearest non-null wins ─────────────────────
    console.log(`\nJ. wn_effective_policy resolves nearest-non-null up the chain`);
    const polLeaf = await one(`SELECT retry_policy, priority FROM wn_effective_policy($1)`, [Leaf]);
    ok(polLeaf.retry_policy?.max === 3, `Leaf inherits retry_policy {"max":3} from Pol (got ${JSON.stringify(polLeaf.retry_policy)})`);
    ok(polLeaf.priority === 7,          `Leaf inherits priority 7 from Mid, NOT 5 from Pol (nearest non-null wins; got ${polLeaf.priority})`);
    const polPol = await one(`SELECT retry_policy, priority FROM wn_effective_policy($1)`, [Pol]);
    ok(polPol.retry_policy?.max === 3 && polPol.priority === 5, `Pol itself resolves its own values`);

    // ── 11. a REAL cycle is detected once present ───────────────────────────
    console.log(`\nK. a real cycle (X2→X1 added) IS detected`);
    await dep(X2, X1, 'FS');   // closes X1→X2 → X1 inside freeform F
    const cyc = await q(`SELECT from_id, to_id FROM detect_cycles($1)`, [ver]);
    ok(cyc.rowCount > 0, `detect_cycles returns ${cyc.rowCount} row(s) after X2→X1 — the real cycle is seen`);

    // wn_is_atom sanity
    console.log(`\nL. wn_is_atom`);
    ok((await one(`SELECT wn_is_atom($1) AS a`, [A1])).a === true,  `a leaf action is an atom`);
    ok((await one(`SELECT wn_is_atom($1) AS a`, [Seq])).a === false, `a sequence container is NOT an atom`);

  } finally {
    // tear down: project ON DELETE CASCADE removes both versions, every node, every dep
    await q(`DELETE FROM project WHERE id=$1`, [projectId]).catch(() => {});
    await admin.end().catch(() => {});
  }

  // an assertion helper that expects the statement to FAIL
  async function assertRefused(promise, label, what) {
    try {
      await promise;
      ok(false, `${what} was NOT refused (${label})`);
    } catch (e) {
      ok(/I[56] violated|check constraint|duplicate key/.test(e.message), `${what} refused (${label}: ${e.message.split('\n')[0].slice(0, 60)})`);
    }
  }
}

await main().catch((e) => { console.error('TEST ERROR:', e); fail++; });
console.log(fail ? `\n${fail} FAILED` : '\nall good');
process.exit(fail ? 1 : 0);
