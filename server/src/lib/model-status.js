// MODEL → WORK STATUS — the ONE mapping from the hierarchical workflow model's run plane to the
// work vocabulary (REHAB 2/4). Every reader that must project a model state onto the work tracker's
// statuses goes through THIS module — a second copy in a reader file is a copy that drifts.
//
// WHY THIS EXISTS. work_item.status is a single column that conflates PLAN state and RUN state.
// The model splits them: plan shape lives on work_node (kind, child_semantics, sibling order), run
// state on execution.state (lifecycle_state), and "who has it" is a lease, not an assignee string.
// A reader that wants to show where a model node is in its lifecycle needs ONE bridge back to the
// tracker's vocabulary, stated here.
//
// THE MAPPING (execution.state → work_status):
//   pending   → queued
//   ready     → assigned
//   running   → working
//   blocked   → blocked
//   waiting   → review      (waiting on a human gate — the tracker calls that review)
//   done      → done
//   cancelled → cancelled
//   failed / skipped / compensated → blocked  (a run-plane exception with no tracker word; blocking
//                                             is the closest honest column)
//
// THE INVERSE lives in work-node-sync.js (STATUS_TO_LIFECYCLE) — the dual-write maps a work_status
// to the lifecycle state it writes. The two tables are deliberately parallel and must be edited
// together: STATUS_TO_LIFECYCLE[review] = 'waiting' and this table's waiting → review are two
// halves of the same decision.
//
// KNOWN LIMIT (documented, not hidden): the run plane cannot distinguish the tracker's `review`
// from `shipping` (both are 'waiting' — a human gate is a human gate to the run plane), and it has
// no `shipping` equivalent. So a reader that renders a BOARD COLUMN needs the exact stored status
// and still reads work_item.status (dual-written, not dropped until REHAB 3/4); this mapping is
// for readers deriving a status FROM the run plane (actuals, a node's lifecycle, the gantt's bars,
// the workflow waterfall, a zee's self-work). The two agree by construction because the dual-write
// keeps execution.state in step with work_item.status.
import { WORK_STATUS_KEYS, isWorkStatus } from './work-status.js';

// execution.lifecycle_state → work_status. Unknown states fall back to 'blocked' (a run-plane
// state the tracker has no word for is never silently 'queued' — the safest honest column is
// blocked, which already means "something is not progressing").
export function modelStatusForLifecycle(state) {
  switch (state) {
    case 'pending':   return 'queued';
    case 'ready':     return 'assigned';
    case 'running':   return 'working';
    case 'blocked':   return 'blocked';
    case 'waiting':   return 'review';
    case 'done':      return 'done';
    case 'cancelled': return 'cancelled';
    case 'failed':
    case 'skipped':
    case 'compensated': return 'blocked';
    default:          return isWorkStatus(state) ? state : 'blocked';
  }
}

// The run-plane states that map to each work_status — the reverse index, so a reader can ask
// "which lifecycle states render as 'working'?" without duplicating the switch.
export function lifecycleStatesForStatus(status) {
  if (status === 'blocked') return ['blocked', 'failed', 'skipped', 'compensated'];
  const byLifecycle = {
    queued: ['pending'], assigned: ['ready'], working: ['running'],
    review: ['waiting'], done: ['done'], cancelled: ['cancelled'],
  };
  return byLifecycle[status] || [];
}

// The run-plane statuses a reader may legitimately show as a given tracker status — a convenience
// for tests and for the read models that need the full set. Exported for the test suite.
export const LIFECYCLE_TO_STATUS = Object.fromEntries(
  ['pending', 'ready', 'running', 'blocked', 'waiting', 'done', 'cancelled', 'failed', 'skipped', 'compensated']
    .map((s) => [s, modelStatusForLifecycle(s)]),
);

// The work vocabulary, with the run-plane states that can produce each status attached — shaped
// for GET /api/work-statuses so the console can learn the mapping without importing this module.
export function workStatusModelVocabulary() {
  return WORK_STATUS_KEYS.map((key) => ({ key, lifecycle_states: lifecycleStatesForStatus(key) }));
}
