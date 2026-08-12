// REHAB 2/4 — the GOLDEN-DIFF for every re-pointed work-tracker READER.
//
// THE ONE HARD RULE of the rehab: API response shapes do not change. The workflow model
// (work_node / dependency / execution / lease) becomes the source of truth for READS, but a reader
// that renders a DIFFERENT board than users see today is a defect even if it never throws.
//
// HOW THIS PROVES IT: it seeds ONE deterministic project (fixed work_item ids, fixed dates), runs
// the backfill migrations (185 + 186) so BOTH shapes are true at once, then calls every re-pointed
// reader and compares the JSON byte-for-byte against a committed golden fixture. The fixture was
// captured from the OLD (work_item-only) readers; after REHAB 2/4 re-points them at the model, this
// test is what catches a reader that changed the items, their order, a card's status, a deps list or
// a span while claiming the API did not change.
//
//   run with --capture to REGENERATE the fixture (only legitimately when the OLD reader's shape
//   genuinely changed, i.e. never during this rehab).
//
// PROVING THE FIXTURE IS A GENUINE PRE-REHAB CAPTURE (how to re-run, instead of trusting this
// header): check out the pre-rehab READER and run this test in COMPARE mode — if it passes, the
// committed fixture byte-matches what the old readers emit, and since it ALSO passes against the
// re-pointed readers, the shapes did not move.
//
//     git show 8af1c04^:server/src/lib/work-items.js > /tmp/wi.old   # the reader BEFORE 2/4
//     cp /tmp/wi.old server/src/lib/work-items.js
//     node test/rehab-reader-golden.test.mjs                          # COMPARE mode — must PASS
//     git checkout server/src/lib/work-items.js                       # restore the re-pointed one
//
// The seed deliberately includes a FRACTIONAL sort_order (1500.5 — the kanban drag midpoint,
// web/src/work/order.js:36) and a NEGATIVE one (-1 — the drop-before-the-first-slot case,
// order.js:38), the two orderings migration 186's sign-safe sibling_rank encoding exists for. Do
// not remove them: a seed without them would let the ordering collapse silently.
//
// Every row it creates is torn down in a finally, whatever happens.
import pg from 'pg';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, 'fixtures', 'rehab-reader-golden.json');
const CAPTURE = process.argv.includes('--capture');

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };
const section = (t) => console.log(`\n── ${t} ──`);

const client = new pg.Client({ connectionString: url });
const q = (t, p) => client.query(t, p);
const one = async (t, p) => (await client.query(t, p)).rows[0];

const P1 = '11111111-1111-4111-8111-111111111111';
const ROOT = '99999999-0000-4000-8000-000000000000';
const TICKET = 'aaaaaaaa-0000-4000-8000-000000000001';
const A1 = 'b0000000-0000-4000-8000-000000000001';
const A2 = 'b0000000-0000-4000-8000-000000000002';
const T1 = 'c0000000-0000-4000-8000-000000000001';
const T2 = 'c0000000-0000-4000-8000-000000000002';
const T3 = 'c0000000-0000-4000-8000-000000000003';
const T4 = 'c0000000-0000-4000-8000-000000000004';
const T5 = 'c0000000-0000-4000-8000-000000000005';
const T6 = 'c0000000-0000-4000-8000-000000000006';

const sql185 = readFileSync(resolve(here, '..', 'db/migrations/185_rehab_backfill_work_items_into_workflow_model.sql'), 'utf8');
const sql186 = readFileSync(resolve(here, '..', 'db/migrations/186_repair_rehab_dependency_direction_rank_encoding.sql'), 'utf8');

// REHAB 3/4: migration 188 retired work_item_dep, but 185 (applied below) READS it — the backfill
// runs before the drop on a fresh database. Against a fully-migrated db, recreate the legacy table
// shape temporarily so the golden capture still exercises the historical backfill.
let createdDepTable = false;
async function ensureDepTable() {
  const e = (await one(`SELECT to_regclass('public.work_item_dep') IS NOT NULL AS e`)).e;
  if (e) return;
  await q(`CREATE TABLE work_item_dep (
    work_item_id  uuid NOT NULL REFERENCES work_item ON DELETE CASCADE,
    depends_on_id uuid NOT NULL REFERENCES work_item ON DELETE CASCADE,
    created_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (work_item_id, depends_on_id))`);
  createdDepTable = true;
}

async function cleanup() {
  try { await q(`DELETE FROM run WHERE plan_version_id IN (SELECT pv.id FROM plan_version pv JOIN plan p ON p.id=pv.plan_id WHERE p.project_id=$1)`, [P1]); } catch { /* */ }
  try { await q(`DELETE FROM ticket WHERE id=$1`, [TICKET]); } catch { /* */ }
  try { await q(`DELETE FROM project WHERE id=$1`, [P1]); } catch { /* */ }
  if (createdDepTable) { try { await q(`DROP TABLE IF EXISTS work_item_dep`); } catch { /* */ } }
}

const insItem = async (id, projectId, parentId, kind, title, sortOrder, status, estimate, extra = {}) => {
  const cols = ['id','project_id','parent_id','kind','title','sort_order','status','estimate_hours','starts_on','due_on'];
  const vals = [id, projectId, parentId, kind, title, sortOrder, status, estimate,
    extra.starts_on || null, extra.due_on || null];
  await q(`INSERT INTO work_item (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')})`, vals);
};

const ev = async (itemId, kind, ts, from = null, to = null, actor = 'queenzee', detail = null) => {
  await q(`INSERT INTO work_item_event (work_item_id, kind, from_status, to_status, actor, ts, detail)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [itemId, kind, from, to, actor, ts, detail ? JSON.stringify(detail) : null]);
};

// Seed the fixture project. Every item gets an actual_start/actual_end AND matching audit events,
// so the backfill's executions carry the SAME timestamps the legacy actuals derive — the re-pointed
// readers (execution-sourced actuals) and the old readers (work_item actuals) agree by construction.
async function seed() {
  await q(`INSERT INTO project (id, name, repo_root, main_branch) VALUES ($1,'Golden Project','/tmp/golden','main')`, [P1]);
  await q(`INSERT INTO ticket (id, number, title, kind, status, priority, project_id)
           VALUES ($1, 42, 'The Golden Ticket', 'feature', 'queued', 2, $2)`, [TICKET, P1]);
  // The project trigger created a root with a RANDOM id; replace it with a FIXED one so the golden
  // fixture is byte-stable across runs (the children's parent_id and the backfill's stable_key all
  // hang off it). No children exist yet, so the delete cascades nothing.
  await q(`DELETE FROM work_item WHERE project_id=$1 AND kind='project'`, [P1]);
  await q(`INSERT INTO work_item (id, project_id, kind, title, created_by) VALUES ($1,$2,'project','Golden Project','test')`, [ROOT, P1]);
  const root = ROOT;

  await insItem(A1, P1, root, 'activity', 'Activity One', 1000, 'working', 8, { starts_on: '2026-01-01', due_on: '2026-01-05' });
  await insItem(A2, P1, root, 'activity', 'Activity Two', 2000, 'queued', 12);
  await insItem(T1, P1, A1, 'task', 'Task One', 1000, 'working', 3, { starts_on: '2026-01-02', due_on: '2026-01-03' });
  await insItem(T2, P1, A1, 'task', 'Task Two', 2000, 'done', 5);
  await insItem(T3, P1, A2, 'task', 'Task Three', 1000, 'blocked', 6);
  await insItem(T4, P1, A2, 'task', 'Task Four', 2000, 'queued', 6);
  // THE ORDERING EDGE CASES a kanban drag actually writes (web/src/work/order.js):
  //   • the MIDPOINT — dropping between two cards writes the average of their sort_orders, which is
  //     FRACTIONAL (line 36). Task Five is such a midpoint between Task One (1000) and Task Two (2000).
  //   • the NEGATIVE HEAD-SLOT — dropping before the first card writes `after - 1`, which goes NEGATIVE
  //     once the head has been pushed to 0 (line 38). Task Six is such a negative.
  //   Both are exactly what the sibling_rank encoding broke before migration 186 (the old lpad scheme
  //   mis-ordered them); a seed without them would let the order collapse silently and never notice.
  await insItem(T5, P1, A1, 'task', 'Task Five', 1500.5, 'queued', 2);
  await insItem(T6, P1, A1, 'task', 'Task Six', -1, 'queued', 1);

  // link a ticket to Task One
  await q(`UPDATE work_item SET ticket_id=$1 WHERE id=$2`, [TICKET, T1]);

  // the dependency: Task Two depends on Task One (T1 is the prerequisite)
  await q(`INSERT INTO work_item_dep (work_item_id, depends_on_id) VALUES ($1,$2)`, [T2, T1]);

  // audit events → actuals (legacy trigger) + executions (backfill). The assigned events carry a
  // REAL xell_id in the detail (not just a slug) so migration 159's trigger AND the backfill both
  // count them as start evidence — the legacy actual_start and the execution started_at then agree.
  await ev(T1, 'assigned', '2026-01-02T08:00:00Z', null, null, 'human@console', { xell_id: 'eeeeeeee-0000-4000-8000-000000000001', xell_slug: 'x-t1' });
  await ev(T1, 'status', '2026-01-02T09:00:00Z', 'assigned', 'working', 'queenzee');
  await ev(T2, 'assigned', '2026-01-04T08:00:00Z', null, null, 'human@console', { xell_id: 'eeeeeeee-0000-4000-8000-000000000002', xell_slug: 'x-t2' });
  await ev(T2, 'status', '2026-01-05T09:00:00Z', 'working', 'done', 'queenzee');
  await ev(T3, 'assigned', '2026-01-06T08:00:00Z', null, null, 'human@console', { xell_id: 'eeeeeeee-0000-4000-8000-000000000003', xell_slug: 'x-t3' });
  await ev(T3, 'status', '2026-01-07T09:00:00Z', 'assigned', 'blocked', 'queenzee');
  await ev(A1, 'status', '2026-01-05T10:00:00Z', 'working', 'working', 'queenzee');

  // both shapes true at once: the backfill + repair
  await q(sql185);
  await q(sql186);

  return root;
}

// The reader outputs, shaped the way the HTTP routes serve them. Byte-stable: every date in the
// seed is fixed, ids are fixed, and the backfill derives execution timestamps FROM those fixed dates.
async function capture() {
  const W = await import('../server/src/lib/work-items.js');
  const root = await W.projectRoot(P1);
  const board = await W.boardModel({ projectId: P1 });
  const gantt = await W.ganttModel({ projectId: P1 });
  const list = await W.listWorkItems({ projectId: P1 });
  const oneItem = await W.getWorkItem(T1);
  return {
    project_id: P1,
    root: root ? { id: root.id, title: root.title, status: root.status, depth: root.depth } : null,
    list: list.map((i) => ({ id: i.id, parent_id: i.parent_id, kind: i.kind, title: i.title, status: i.status, depth: i.depth, sort_order: i.sort_order })),
    board: board.columns.map((c) => ({ key: c.key, order: c.order, items: c.items.map((x) => ({ id: x.id, title: x.title, status: x.status, depth: x.depth, parent_id: x.parent_id, sort_order: x.sort_order, breadcrumb: x.breadcrumb, ticket: x.ticket, live_status: x.live_status, open_children: x.open_children })) })),
    gantt: gantt.rows.map((r) => ({ id: r.id, parent_id: r.parent_id, depth: r.depth, kind: r.kind, title: r.title, status: r.status, starts_on: r.starts_on, due_on: r.due_on, computed_start: r.computed_start, computed_end: r.computed_end, span_days: r.span_days, deps: r.deps, unscheduled: r.unscheduled })),
    oneItem: {
      id: oneItem.id, title: oneItem.title, status: oneItem.status, status_label: oneItem.status_label,
      parent_id: oneItem.parent_id, depth: oneItem.depth, kind: oneItem.kind, sort_order: oneItem.sort_order,
      breadcrumb: oneItem.breadcrumb, deps: oneItem.deps, dependents: oneItem.dependents,
      ticket: oneItem.ticket, open_children: oneItem.open_children,
      descendant_count: oneItem.descendant_count, open_descendant_count: oneItem.open_descendant_count,
    },
  };
}

function sorted(obj) {
  // JSON.stringify key order is insertion order; the readers' output is deterministic, but the
  // deep equality below should not depend on key order within objects we did not author.
  if (Array.isArray(obj)) return obj.map(sorted);
  if (obj && typeof obj === 'object') {
    return Object.fromEntries(Object.keys(obj).sort().map((k) => [k, sorted(obj[k])]));
  }
  return obj;
}

try {
  await client.connect();
  await cleanup();
  await ensureDepTable();

  section('seed the fixture project');
  await seed();
  ok(true, `project + 6 work_items + dep + events + backfill seeded`);

  section('capture / compare the golden reader output');
  const got = await capture();

  if (CAPTURE || !existsSync(FIXTURE)) {
    writeFileSync(FIXTURE, JSON.stringify(sorted(got), null, 2));
    console.log(`  wrote ${FIXTURE}`);
  }

  const expected = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  const a = JSON.stringify(sorted(got));
  const b = JSON.stringify(expected);

  if (a !== b) {
    ok(false, 'golden-diff: the reader output differs from the captured fixture');
    // Diff the sections so the failure says WHAT changed, not just that something did.
    for (const sectionName of ['list', 'board', 'gantt', 'oneItem']) {
      const ga = JSON.stringify(sorted(got[sectionName]));
      const ge = JSON.stringify(sorted(expected[sectionName]));
      if (ga !== ge) console.log(`  ── ${sectionName} DIFFERS (${ga.length} vs ${ge.length} chars)`);
    }
  } else {
    ok(true, 'golden-diff: every reader returns byte-identical JSON to the pre-rehab capture');
  }

  section('per-reader: same items, same order as the old shape');
  const ids = (arr) => arr.map((x) => x.id).join(',');
  ok(ids(got.list) === ids(expected.list), `listWorkItems same items in same order (${got.list.length})`);
  const boardIds = got.board.map((c) => c.items.map((i) => i.id).join(',')).join('|');
  const boardIdsExp = expected.board.map((c) => c.items.map((i) => i.id).join(',')).join('|');
  ok(boardIds === boardIdsExp, 'boardModel same items in same columns in same order');
  ok(ids(got.gantt) === ids(expected.gantt), `ganttModel same rows in same order (${got.gantt.length})`);
} finally {
  await cleanup();
  await client.end();
}

if (fail) { console.log(`\n${fail} FAILURE(S)`); process.exit(1); }
console.log('\nALL PASS');
