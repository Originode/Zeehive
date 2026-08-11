// THE A2A ENVELOPE AND PROJECTION — the pure mapping between a zee_message row and the A2A
// Message/Task objects the fleet will serve on the wire (docs/a2a-protocol-plan.md §4, DR-3).
//
// Everything here is a pure function of plain facts: no database, no network, no randomness that
// is not injected. The non-pure half — looking up an existing contextId, minting ids, writing the
// row — lives in the callers: lib/managers.js postMessage for the stamp, the phase-2 read side for
// the projection. The shape these functions were written against (plan §4):
//
//   meta.a2a = {
//     messageId,          // the zee_message row id, reused (DR-3)
//     taskId,             // minted when the message OPENS a task (a directive / routing request)
//     contextId,          // the conversation thread: minted on the first exchange of an ordered
//                         // (from_xell, to_xell) pair, then reused
//     referencedTaskId,   // set on replies — a report answering a directive
//     state: null | 'canceled',   // ONLY cancel is stored; every other state is DERIVED (§3.3)
//   }
//
// The task-state mapping is the contract's hard part and it is written down as a table in the plan
// §3.3; deriveTaskState below is that table, row for row, with the ordering that keeps overlapping
// facts honest. The shape copies lib/zee-turn.js's decideMessageDelivery — a pure exported
// function taking plain facts, returning a plain verdict, table-tested standalone. A2A objects are
// a VIEW over the row, never a second store (DR-3): the zee_message columns (delivered, delivery,
// read_at, kind) win whenever they disagree with anything derived here.
import { randomUUID } from 'node:crypto';

// ── ENVELOPE CONSTRUCTION — the stamp postMessage writes ────────────────────
// Takes the facts a caller has already gathered (the reused contextId, the referenced taskId) and
// returns the envelope. Ids are minted through the injected `mint` so the function stays
// deterministic under test; the default is the same generator the row id uses.
export function buildEnvelope({
  messageId,
  kind = 'message',
  contextId = null,
  referencedTaskId = null,
  canceled = false,
  mint = randomUUID,
} = {}) {
  const envelope = {
    messageId,
    contextId: contextId || mint(),
    state: canceled ? 'canceled' : null,
  };
  // A directive / routing request OPENS a task, so it mints the taskId that every later reply
  // references (plan §4). Nothing else does.
  if (kind === 'directive') envelope.taskId = mint();
  if (referencedTaskId) envelope.referencedTaskId = referencedTaskId;
  return envelope;
}

// ── TASK STATE — the plan §3.3 table, as a pure function ────────────────────
// Every row of the table has a branch here. The order is deliberate — when two facts overlap, the
// one that is a stronger statement about what actually happened wins:
//
//   canceled      the one STORED state, written by a peer's explicit RPC (plan §3.2 CancelTask);
//   completed     a reply proves the work happened — outranks a delivery verdict one turn stale;
//   failed        a delivery that reported success and then died is not "in the inbox", it lied;
//   rejected      the recipient is gone — the message can never be read;
//   input-required  a live task the recipient has flagged as needing a human;
//   submitted / working — the delivery verdict, for tasks that are simply live.
export function deriveTaskState({
  delivered = false,
  delivery = null,        // the delivery verdict: 'none' | 'queued' | 'typed' | 'resumed'
  deliveryReason = null,  // the reason carried by a 'none' verdict (rejection detection)
  undelivered = false,    // delivery was corrected to undelivered (messageUndelivered's marker)
  canceled = false,       // the envelope's stored state
  hasReply = false,       // a reply row references this taskId
  tendOpen = false,       // the recipient raised a zee tend while the task is live
} = {}) {
  if (canceled) return { state: 'canceled', metadata: null };
  if (hasReply) return { state: 'completed', metadata: null };
  if (undelivered) return { state: 'failed', metadata: null };
  if (delivery === 'none' && /decommissioned|retired/i.test(deliveryReason || '')) {
    return { state: 'rejected', metadata: null };
  }
  // A live task the recipient flagged as needing a human → input-required (the tend reason becomes
  // the status message on the read side). Applies to any live state, not just working.
  if (tendOpen) return { state: 'input-required', metadata: null };
  if (delivery === 'queued') return { state: 'submitted', metadata: null };
  if (delivery === 'resumed') return { state: 'working', metadata: null };
  if (delivery === 'typed') {
    // typed into a session whose completion the fleet cannot observe (reaper.js's KNOWN GAP:
    // codex/kimi cages have no turn hooks) — stays working, and says so in metadata. Never faked
    // to completed, whatever the sender hopes (plan §3.3, DR-4).
    return { state: 'working',
             metadata: { note: 'delivered, completion unobservable — typed into a session with no turn hooks' } };
  }
  // delivery 'none' (or null): the durable inbox IS submission — it will be read on the next turn.
  return { state: 'submitted', metadata: null };
}

// ── ROW → A2A MESSAGE (plan §4) ─────────────────────────────────────────────
// A message is the row's text as a single text part, with the ZEEHIVE kind preserved in metadata
// so the existing taxonomy survives translation. role is 'user' when the message opened the task
// (it carries a taskId — a directive / routing request), 'agent' on replies. An un-enveloped row
// maps to null — old rows are invisible to A2A, never backfilled (DR-4).
export function rowToMessage(row) {
  const a2a = row?.meta?.a2a || row?.a2a || null;
  if (!a2a) return null;
  const message = {
    messageId: a2a.messageId,
    taskId: a2a.taskId || a2a.referencedTaskId || null,
    role: a2a.taskId ? 'user' : 'agent',
    parts: [{ text: String(row.body || '') }],
  };
  if (row.kind) message.metadata = { kind: row.kind };
  return message;
}

// ── ROW → A2A TASK (plan §4) ────────────────────────────────────────────────
// A Task is the task-opening row plus everything referencing its taskId. history = the opening
// message + replies in order; artifacts = reply bodies. status is derived (§3.3), never read off
// the row. The caller gathers the reply rows and the recipient's tend state and passes them in —
// this stays pure.
export function rowToTask({ opening, replies = [], tendOpen = false } = {}) {
  const a2a = opening?.meta?.a2a;
  if (!a2a?.taskId) return null;   // only a task-opening row makes a Task
  const messages = [rowToMessage(opening), ...replies.map(rowToMessage)].filter(Boolean);
  const state = deriveTaskState({
    delivered: opening.delivered,
    delivery: opening.delivery?.delivery || null,
    deliveryReason: opening.delivery?.reason || null,
    undelivered: !!opening.delivery?.undelivered,
    canceled: a2a.state === 'canceled',
    hasReply: replies.length > 0,
    tendOpen,
  });
  const task = {
    id: a2a.taskId,
    status: state.state,
    ...(messages.length ? { history: messages } : {}),
  };
  if (replies.length) {
    task.artifacts = replies.map((r) => ({
      artifactId: r.id,
      parts: [{ text: String(r.body || '') }],
    }));
  }
  if (state.metadata) task.metadata = state.metadata;
  return task;
}

// ── C7 SEAM (plan §4, NOT built) — execution outputs ⇄ A2A Artifacts ────────
// When the stage-2 data plane lands, `execution.outputs` from `zee handover` maps 1:1 onto A2A
// Artifacts (artifactId = execution id, parts = [{ data: outputs }]). Named so the mapping has a
// home; nothing behind it ships in P1.
export function executionOutputsToArtifacts(_execution = null) {
  return [];
}
