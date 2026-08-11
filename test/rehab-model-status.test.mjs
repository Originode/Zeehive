// REHAB 2/4 — the ONE run-plane → work_status mapping (lib/model-status.js) is pinned.
//
// The brief's trap: work_item.status conflates PLAN state and RUN state. The model splits them and
// every reader must project a model state onto the tracker vocabulary through ONE mapping — this
// test pins that mapping so a reader cannot silently re-derive it (a second copy is a copy that
// drifts) and so the documented limit (review/shipping collapse) stays visible.
import { modelStatusForLifecycle, lifecycleStatesForStatus, LIFECYCLE_TO_STATUS } from '../server/src/lib/model-status.js';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };
const section = (t) => console.log(`\n── ${t} ──`);

section('lifecycle → work_status (the mapping every reader uses)');
const expected = {
  pending: 'queued', ready: 'assigned', running: 'working', blocked: 'blocked',
  waiting: 'review', done: 'done', cancelled: 'cancelled',
  failed: 'blocked', skipped: 'blocked', compensated: 'blocked',
};
for (const [lifecycle, status] of Object.entries(expected)) {
  ok(modelStatusForLifecycle(lifecycle) === status, `${lifecycle} → ${status}`);
}
ok(modelStatusForLifecycle('made-up') === 'blocked', 'an unknown lifecycle state never silently maps to queued');

section('the reverse index (which run states render as each status)');
ok(JSON.stringify(lifecycleStatesForStatus('working')) === JSON.stringify(['running']), 'working ← running only');
ok(JSON.stringify(lifecycleStatesForStatus('blocked').sort()) === JSON.stringify(['blocked', 'compensated', 'failed', 'skipped'].sort()),
  'blocked ← blocked/failed/skipped/compensated (a run-plane exception has no better tracker word)');
ok(JSON.stringify(lifecycleStatesForStatus('review')) === JSON.stringify(['waiting']), 'review ← waiting');

section('the documented limit — review/shipping are not distinguishable in the run plane');
// The dual-write maps BOTH review and shipping → 'waiting' (STATUS_TO_LIFECYCLE in work-node-sync.js),
// so the reverse mapping can only recover 'review'. shipping has NO lifecycle state that produces it:
// the model has no shipping word. A reader that renders a BOARD COLUMN must read the exact stored
// status from work_item.status (dual-written, not dropped until rehab 3/4); this mapping is for
// readers deriving a status FROM the run plane.
ok(LIFECYCLE_TO_STATUS.waiting === 'review', 'waiting → review (the tracker calls a human gate review)');
ok(lifecycleStatesForStatus('shipping').length === 0,
  'shipping has no run-plane source — the exact status must come from work_item.status until 3/4');

if (fail) { console.log(`\n${fail} FAILURE(S)`); process.exit(1); }
console.log('\nALL PASS');
