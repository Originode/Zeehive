// EXECUTION EVENT LOG — the append-only audit trail a WORKFLOW DOOR writes.
//
// The weld stage's two doors — `zee handover` and `zee await` (queenzee/self.js) — mutate
// execution columns (outputs, state). A mutable column alone is not an audit trail: anything
// can overwrite it with no trace. Stage 3 (177) built the `event` table precisely so that a
// door emits an IMMUTABLE record — UPDATE/DELETE are forbidden by the event_append_only trigger
// (I16). This helper is the ONLY writer to that table in the codebase; every workflow door that
// changes an execution appends here, so the question "what did this zee do to this execution,
// and when?" has an answer that cannot be rewritten.
//
// CONTRACT:
//   • seq is monotone per run — take max(seq)+1 and retry ONCE on the (run_id, seq) unique
//     constraint, which is why that constraint exists (two doors racing the same run). A second
//     conflict is a real bug and is allowed to surface.
//   • NEVER THROWS: observability must never sink the door that writes it. A failure is logged
//     and null returned, exactly like the turn ledger.
import { q, one } from '../db/pool.js';
import { logline } from './logbus.js';

export async function appendExecutionEvent({ runId, executionId = null, workNodeId = null, type, payload = null }) {
  if (!runId || !type) return null;
  const insert = async (retried) => {
    const max = await one(`SELECT COALESCE(max(seq), 0) + 1 AS seq FROM event WHERE run_id=$1`, [runId]);
    const seq = max?.seq || 1;
    try {
      return await one(
        `INSERT INTO event (run_id, seq, type, work_node_id, execution_id, payload)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [runId, seq, type, workNodeId || null, executionId || null,
         payload ? JSON.stringify(payload) : null]);
    } catch (e) {
      // A concurrent door computed the same max(seq)+1 and won the race — the unique constraint
      // is the arbiter. Recompute once (the winner's row is now visible) and retry.
      if (!retried && /duplicate key|unique|event_run_seq_unique/i.test(String(e.message))) {
        return insert(true);
      }
      throw e;
    }
  };
  try {
    return await insert(false);
  } catch (e) {
    logline('event', `appendExecutionEvent failed (${String(e.message).slice(0, 120)})`);
    return null;
  }
}

export default { appendExecutionEvent };
