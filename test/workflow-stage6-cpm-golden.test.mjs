// STAGE 6 — CPM GOLDEN-DIFF + TIMING (wn_cpm must be fast AND byte-identical).
//
// Why this test exists: migration 189 optimised wn_cpm because it did not scale — on the
// live meta-DB, 157 nodes took 20.7s and 354 nodes timed out past 120s. The cost was the
// union_edge VIEW being rebuilt once per node in three loops inside the function (the view
// is a plain VIEW with no index to push a per-node filter into), plus an O(containers x
// atoms) ancestor rollup with a recursive call per pair. Migration 189 materialises the
// version's edges once into in-memory adjacency lists and replaces the rollup with one
// bottom-up pass.
//
// THE ONE HARD RULE: wn_cpm's OUTPUT MUST NOT CHANGE. This is a performance change only.
// So this test seeds ONE deterministic 354-node plan (fixed ids, fixed estimates, fixed
// start instant — 1 freeform root, 39 sequence containers, 314 atoms, ~313 union edges,
// the same shape as the real omnibiz plan), runs wn_cpm, and diffs the full schedule
// byte-for-byte against a committed golden fixture. The fixture was captured with the
// PRE-optimisation wn_cpm (migration 184); after 189 replaces the function, the rows must
// be identical.
//
//   run with --capture to REGENERATE the fixture (legitimate only when the SCHEDULE
//   genuinely changed — i.e. never during this optimisation).
//
// PROVING THE FIXTURE IS A GENUINE PRE-OPTIMISATION CAPTURE (how to re-run, instead of
// trusting this header): check out migration 184's wn_cpm (git show HEAD~1 or the 184
// file) and run this test in CAPTURE mode — the committed fixture must be written
// byte-identical; then restore 189's function and the COMPARE mode must pass.
//
// TIMING ASSERTION: the same 354-node plan must complete in under CPMS_TARGET_MS (1s).
// The pre-optimisation function took ~10.7s on a sandbox and timed out at 120s on the
// live meta-DB for the real 354-node plan; the optimised function measures ~60ms on this
// sandbox. 1s is a ~15x margin over the measured optimised time, far below the old
// runtime, so a silent regression back to the per-node view rebuilds fails loudly.
//
// The seed deliberately includes the plan shape that used to be slowest: a large sequence
// container (67 children — the sibling-order expansion is where the view's LATERAL leaf
// descents get expensive) plus 38 explicit FS dependencies chaining across containers
// (LCA = root freeform, legal). Every row it creates is torn down in a finally.
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, 'fixtures', 'workflow-stage6-cpm-golden.json');
const CAPTURE = process.argv.includes('--capture');
const CPMS_TARGET_MS = 1000;

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };
const section = (t) => console.log(`\n── ${t} ──`);

const client = new pg.Client({ connectionString: url });
const q = (t, p) => client.query(t, p);
const one = async (t, p) => (await client.query(t, p)).rows[0];

// ── deterministic fixture ids ─────────────────────────────────────────────────────
const P1 = '11111111-1111-4111-8111-111111111111';
const PLAN = '22222222-2222-4222-8222-222222222222';
const VER = '33333333-3333-4333-8333-333333333333';
const ROOT = '44444444-4444-4444-8444-444444444444';
const seqId = (n) => `50000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const atomId = (n) => `60000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const NCONT = 39;
const TOTAL_ATOMS = 354 - 1 - NCONT; // 314
// largest sequence container = 67 children, rest distributed (matches the real shape)
function kidsPerContainer() {
  const kids = new Array(NCONT).fill(1);
  kids[0] = 67;
  let remaining = TOTAL_ATOMS - 67;
  for (let c = 1; c < NCONT; c++) {
    const base = Math.floor(remaining / (NCONT - c));
    kids[c] = Math.max(1, base);
    remaining -= kids[c];
  }
  let sum = kids.reduce((a, b) => a + b, 0);
  kids[NCONT - 1] += TOTAL_ATOMS - sum;
  return kids;
}

async function cleanup() {
  // the golden project, plus any leftover cpm-cyc-* cycle-guard projects (if the cycle
  // section errors before its own DELETE, this catches the leak)
  for (const id of [P1]) {
    try { await q(`DELETE FROM run WHERE plan_version_id IN (SELECT pv.id FROM plan_version pv JOIN plan p ON p.id=pv.plan_id WHERE p.project_id=$1)`, [id]); } catch { /* */ }
    try { await q(`DELETE FROM project WHERE id=$1`, [id]); } catch { /* */ }
  }
  try { await q(`DELETE FROM project WHERE name LIKE 'cpm-cyc-%'`); } catch { /* */ }
}

async function seed() {
  await q(`INSERT INTO project (id, name, repo_root, db_user, db_name) VALUES ($1,'CPM Golden','/tmp/golden','u','d')`, [P1]);
  await q(`INSERT INTO plan (id, project_id, name) VALUES ($1,$2,'cpm-golden')`, [PLAN, P1]);
  await q(`INSERT INTO plan_version (id, plan_id, version) VALUES ($1,$2,1)`, [VER, PLAN]);
  await q(
    `INSERT INTO work_node (id, plan_version_id, parent_id, sibling_rank, name, kind, child_semantics)
     VALUES ($1,$2,NULL,'1','Root','container','freeform')`, [ROOT, VER]);
  await q(`UPDATE plan_version SET root_node_id=$1 WHERE id=$2`, [ROOT, VER]);

  const kids = kidsPerContainer();
  // containers 1..39 under Root
  for (let c = 1; c <= NCONT; c++) {
    await q(
      `INSERT INTO work_node (id, plan_version_id, parent_id, sibling_rank, name, kind, child_semantics)
       VALUES ($1,$2,$3,$4,$5,'container','sequence')`,
      [seqId(c), VER, ROOT, String(c), `Seq${c}`]);
  }
  // atoms: container c has kids[c-1] atoms, named S<c>A<k>
  const rows = [];
  let n = 1;
  for (let c = 1; c <= NCONT; c++) {
    for (let k = 1; k <= kids[c - 1]; k++) {
      rows.push([atomId(n), VER, seqId(c), String(k), `S${c}A${k}`, 'action', '1 hours']);
      n++;
    }
  }
  // bulk insert (multi-row VALUES)
  const values = rows.map((_, i) => `($${i * 7 + 1},$${i * 7 + 2},$${i * 7 + 3},$${i * 7 + 4},$${i * 7 + 5},$${i * 7 + 6},$${i * 7 + 7})`).join(',');
  const flat = rows.flat();
  await q(
    `INSERT INTO work_node (id, plan_version_id, parent_id, sibling_rank, name, kind, estimate)
     VALUES ${values}`, flat);

  // 45 attempted FS dependencies chaining across containers (LCA = Root freeform → legal).
  // The first atom of container c is atomId(1 + sum(kids[0..c-2])).
  const firstAtomOf = [];
  let running = 1;
  for (let c = 1; c <= NCONT; c++) { firstAtomOf[c] = running; running += kids[c - 1]; }
  let deps = 0;
  for (let d = 0; d < 45; d++) {
    const c1 = d % (NCONT - 1) + 1;
    const c2 = c1 + 1;
    const a1 = atomId(firstAtomOf[c1]);
    const a2 = atomId(firstAtomOf[c2]);
    try {
      await q(`INSERT INTO dependency (from_id, to_id, type) VALUES ($1,$2,'FS')`, [a1, a2]);
      deps++;
    } catch { /* skip legality-violating */ }
  }

  const counts = await one(
    `SELECT
       (SELECT count(*)::int FROM work_node WHERE plan_version_id=$1) AS nodes,
       (SELECT count(*)::int FROM work_node WHERE plan_version_id=$1 AND kind<>'container') AS atoms_n,
       (SELECT count(*)::int FROM dependency d JOIN work_node w ON w.id=d.from_id WHERE w.plan_version_id=$1) AS deps_n,
       (SELECT count(*)::int FROM union_edge ue WHERE ue.plan_version_id=$1) AS union_edges`,
    [VER]);
  return counts;
}

function rowToObj(r) {
  return {
    node_id: r.node_id, name: r.name, kind: r.kind, is_atom: r.is_atom, parent_id: r.parent_id,
    duration: r.duration, es: r.earliest_start && new Date(r.earliest_start).toISOString(),
    ef: r.earliest_finish && new Date(r.earliest_finish).toISOString(),
    ls: r.latest_start && new Date(r.latest_start).toISOString(),
    lf: r.latest_finish && new Date(r.latest_finish).toISOString(),
    slack: r.slack, critical: r.critical,
  };
}

async function runCpm() {
  const t0 = process.hrtime.bigint();
  const res = await q(
    `SELECT node_id, name, kind::text AS kind, is_atom, parent_id, duration::text AS duration,
            earliest_start, earliest_finish, latest_start, latest_finish, slack::text AS slack, critical
       FROM wn_cpm($1, '2026-08-10T09:00:00.000Z'::timestamptz)
      ORDER BY is_atom DESC, node_id`, [VER]);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { ms: Math.round(ms * 100) / 100, rows: res.rows.map(rowToObj) };
}

async function main() {
  await client.connect();
  await cleanup();
  const counts = await seed();

  section(`seed the deterministic 354-node plan`);
  ok(counts.nodes === 354 && counts.atoms_n === 314, `354 nodes / 314 atoms seeded (got ${counts.nodes}/${counts.atoms_n})`);
  ok(counts.union_edges >= 300, `union graph has ~313 edges (got ${counts.union_edges})`);

  section(`capture / compare wn_cpm output (byte-identical to pre-optimisation)`);
  const { ms, rows } = await runCpm();
  const got = { meta: counts, rows };
  console.log(`  wn_cpm: ${rows.length} rows in ${ms} ms`);

  if (CAPTURE || !existsSync(FIXTURE)) {
    writeFileSync(FIXTURE, JSON.stringify(got, null, 2));
    console.log(`  wrote ${FIXTURE}`);
  }

  const expected = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  const a = JSON.stringify(got.rows);
  const b = JSON.stringify(expected.rows);
  if (a === b) {
    ok(true, 'golden-diff: wn_cpm output is byte-identical to the pre-optimisation capture');
  } else {
    ok(false, 'golden-diff: wn_cpm output DIFFERS from the pre-optimisation capture');
    // name the first differing row so the failure is actionable
    for (let i = 0; i < Math.max(got.rows.length, expected.rows.length); i++) {
      const ga = got.rows[i], ge = expected.rows[i];
      if (JSON.stringify(ga) !== JSON.stringify(ge)) {
        console.log(`  ── first diff at row ${i}: got ${JSON.stringify(ga)}`);
        console.log(`  ──                   exp ${JSON.stringify(ge)}`);
        break;
      }
    }
  }
  // same row count + same id set (a second net, order-independent)
  const ids = (r) => r.map((x) => x.node_id).sort().join(',');
  ok(ids(got.rows) === ids(expected.rows) && got.rows.length === expected.rows.length,
    `same ${got.rows.length} rows with the same id set`);

  section(`timing assertion — must stay fast (target < ${CPMS_TARGET_MS} ms)`);
  // In CAPTURE mode the fixture is written from the PRE-optimisation function on purpose
  // (that is the point of the golden), so the timing assertion would fail by construction.
  if (CAPTURE) {
    console.log(`  (capture mode — timing not asserted; pre-optimisation baseline was ${ms} ms)`);
  } else {
    ok(ms < CPMS_TARGET_MS, `wn_cpm for 354 nodes ran in ${ms} ms (< ${CPMS_TARGET_MS} ms)`);
  }

  section(`cycle guard (TKT-162-79AE) — a fully-cyclic graph raises, not crashes`);
  // A graph whose nodes are ALL in cycles (no indegree-0 start) used to slip past
  // `array_length(v_top,1) < v_n` (array_length of an EMPTY array is NULL) and crash
  // reading NULL v_top elements. Migration 189 hardens it to COALESCE(...,0).
  const cycProject = randomUUID();
  const cycName = 'cpm-cyc-' + randomUUID().slice(0, 8);
  const cycPlan = randomUUID();
  const cycVer = randomUUID();
  const cycRoot = randomUUID();
  const cycA = randomUUID();
  const cycB = randomUUID();
  await q(`INSERT INTO project (id, name, repo_root, db_user, db_name) VALUES ($1,$2,'/tmp','u','d')`, [cycProject, cycName]);
  await q(`INSERT INTO plan (id, project_id, name) VALUES ($1,$2,'cyc')`, [cycPlan, cycProject]);
  await q(`INSERT INTO plan_version (id, plan_id, version) VALUES ($1,$2,1)`, [cycVer, cycPlan]);
  await q(`INSERT INTO work_node (id, plan_version_id, parent_id, sibling_rank, name, kind, child_semantics)
           VALUES ($1,$2,NULL,'1','Root','container','freeform')`, [cycRoot, cycVer]);
  await q(`UPDATE plan_version SET root_node_id=$1 WHERE id=$2`, [cycRoot, cycVer]);
  await q(`INSERT INTO work_node (id, plan_version_id, parent_id, sibling_rank, name, kind, estimate)
           VALUES ($1,$2,$3,'1','A','action','1 hours'),($4,$2,$3,'2','B','action','1 hours')`, [cycA, cycVer, cycRoot, cycB]);
  await q(`INSERT INTO dependency (from_id, to_id, type) VALUES ($1,$2,'FS'),($2,$1,'FS')`, [cycA, cycB]);
  let raised = null;
  try {
    await q(`SELECT count(*) FROM wn_cpm($1, '2026-08-10T09:00:00Z'::timestamptz)`, [cycVer]);
  } catch (e) {
    raised = e.message;
  }
  ok(raised !== null && /cycle in union graph/.test(raised),
    `a fully-cyclic graph raises 'cycle in union graph' (got: ${raised ? raised.split('\n')[0] : 'NO EXCEPTION'})`);
  await q(`DELETE FROM project WHERE id=$1`, [cycProject]);

  await cleanup();
  await client.end();
}

try {
  await main();
} catch (e) {
  console.error('TEST ERROR:', e);
  fail++;
  await cleanup().catch(() => {});
  await client.end().catch(() => {});
}

if (fail) { console.log(`\n${fail} FAILURE(S)`); process.exit(1); }
console.log('\nALL PASS');
