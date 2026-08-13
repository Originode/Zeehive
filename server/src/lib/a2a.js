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
import { randomUUID, createHash } from 'node:crypto';

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

// ── WRITE SIDE — the pure half (plan §3.2, P3) ──────────────────────────────
// The write methods (SendMessage / SendStreamingMessage / CancelTask) map onto the SAME
// store-then-deliver machinery the zee verbs use: postMessage is unchanged (DR-3 — the row stays
// authoritative; the envelope is the only A2A mark on it). What the write side adds on top is
// PURE and lives here so it is table-tested standalone like the rest of this module:
//
//   partsToBody    — SendMessage's parts → the zee_message body. v1 supports TEXT parts only (the
//                    cards' defaultInputModes is ["text/plain"]): DataPart ({ data }) and FilePart
//                    ({ file }) answer ContentTypeNotSupportedError (-32005), the exact spec code.
//   cancelVerdict  — CancelTask's "can this task still be canceled?" check. The plan's §3.2 rule is
//                    verbatim: the envelope is marked canceled iff the task is still undelivered/
//                    queued. The moment delivery says 'resumed'/'typed' the turn is running, and a
//                    peer's RPC must never interrupt a turn (that is a human's fleet-pause, not a
//                    peer's CancelTask). A task with a reply already happened — not cancelable either.
export function partsToBody(parts = []) {
  if (!Array.isArray(parts) || parts.length === 0) {
    return { body: null, error: 'message.parts must be a non-empty array' };
  }
  const chunks = [];
  for (const part of parts) {
    if (!part || typeof part !== 'object') return { body: null, error: 'each message part must be an object' };
    if (typeof part.text === 'string') { chunks.push(part.text); continue; }
    // DataPart ({ data }) and FilePart ({ file }) — and anything else that is not a text part —
    // are not supported in v1. The error is the exact spec code; the caller throws it.
    return { body: null, error: A2A_ERROR.ContentTypeNotSupported.name };
  }
  const body = chunks.join('\n').trim();
  if (!body) return { body: null, error: 'message body is empty after trimming text parts' };
  return { body };
}

export function cancelVerdict({ delivery = null, hasReply = false } = {}) {
  const d = delivery?.delivery || null;
  if (d === 'resumed' || d === 'typed') return { allowed: false, reason: 'the turn is running' };
  if (hasReply) return { allowed: false, reason: 'the task already has a reply' };
  return { allowed: true };
}

// ── C7 SEAM (plan §4, NOT built) — execution outputs ⇄ A2A Artifacts ────────
// When the stage-2 data plane lands, `execution.outputs` from `zee handover` maps 1:1 onto A2A
// Artifacts (artifactId = execution id, parts = [{ data: outputs }]). Named so the mapping has a
// home; nothing behind it ships in P1.
export function executionOutputsToArtifacts(_execution = null) {
  return [];
}

// ── EXTENSION (DR-8): ALL zee conversations as A2A — the four other stores ──
// The original scope (DR-1) is the zee_message plane. The human wants ALL zee conversations in
// A2A. "All" is decided in DR-8 as: every store that is a CONVERSATION (two-or-more turns of an
// agent with someone — itself, a human, a model) gets a DETERMINISTIC Task id so A2A peers can
// address it. Deterministic (uuid v5 of a store-namespaced natural key, minted at READ time) is the
// one additive, no-backfill-compatible reading of DR-3/DR-4: nothing is written, nothing is
// re-keyed, the same store row always projects to the same A2A id, and pre-A2A history is served
// as Tasks without inventing a new id vocabulary on the wire.
//
// The four non-zee_message stores and how each becomes an A2A Task (decided in DR-8):
//
//   xell_conversation (migration 112)  — a finished xell's ARCHIVED session transcript. A Task
//     per archive row; the transcript events become the history (role user/assistant from the
//     JSONL event type, tool events flattened to text parts); deterministic id from the archive's
//     own row id. status = 'completed' (the archive is a receipt about a finished conversation).
//   zee_conversation (migration 192)   — a LIVE xell's STATEFUL WORKING MEMORY (the langchain
//     driver). A Task per xell; its rows are the history in seq order; deterministic id from the
//     xell id. status = 'working' (the memory is the state its next turn reads — it is not a
//     finished task).
//   zee_turn (migration 153)           — the per-turn OBSERVABILITY LEDGER. A Task per turn; the
//     summary is the single message; deterministic id from the turn row id. status = 'completed'
//     when the turn ended, 'working' while it is open.
//   session_event                      — the append-only hook/play-by-play log. NOT a conversation:
//     it is the CONTROL-PLANE event log (tend/hints/refusals/feed events). It stays out per DR-8 —
//     a "conversation" it does not make; the zee_turn Task already surfaces its play-by-play via
//     metadata (the turn's events are its evidence, not its speech).
//
// Role mapping for a history message: A2A roles are user/agent. The conversation stores use
// system/user/assistant/tool. The mapping is deliberately lossy-and-honest: assistant → agent;
// user → user; tool → user (a tool result is the agent's instrument, not a separate speaker); a
// system line (a brief, a policy snapshot) → user (it was INPUT, not the agent speaking). Nothing
// of the original taxonomy is lost — the store's own role rides in metadata.kind.

// Deterministic A2A task id for a store row. `mint` stays injectable so the function is
// test-deterministic (the same contract as buildEnvelope); the default is uuid v5 under the
// fixed namespace. The namespace is a stable constant — a different value would re-id every row
// on a future code change and orphan every external Task that cited one.
export function conversationTaskId(store, naturalKey, mint = null) {
  if (mint) return mint();
  return uuidv5Name(`${store}:${naturalKey}`, CONVERSATION_NS);
}

const CONVERSATION_NS = 'b8a2b2a4-0a2a-4a2a-a2a2-a2a2a2a2a2a2';

// A deterministic uuid v5 (name-based, RFC 4122 §4.3) over sha1. `createHash` is imported from
// node:crypto at the top of this module; this is pure and synchronous.
function uuidv5Name(name, ns) {
  const nsHex = String(ns || '').replace(/-/g, '');
  const nsBytes = Uint8Array.from(nsHex.match(/.{2}/g).map((h) => parseInt(h, 16)));
  const h = createHash('sha1').update(new Uint8Array([...nsBytes, ...Buffer.from(String(name))])).digest();
  h[6] = (h[6] & 0x0f) | 0x50;   // version 5
  h[8] = (h[8] & 0x3f) | 0x80;   // variant 10xx
  const hex = [...h.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// A transcript line (xell_conversation.events is an array of parsed JSONL events; zee_conversation
// rows are role/content pairs; session_event.raw is a JSON blob) → an A2A Message. Returns null
// for a line that is not speech (system noise). The store's own role/taxonomy rides in metadata.
export function conversationEventToMessage({ store, role = null, content = null, event = null, at = null } = {}) {
  let text = content;
  let kind = role;
  if (event && typeof event === 'object') {
    // xell_conversation.events are Claude-code JSONL events: { type, message?, ... }.
    if (event.type === 'user') {
      role = 'user'; kind = 'user';
      text = event.message?.content || (typeof event.message === 'string' ? event.message : null);
      if (Array.isArray(text)) text = text.map((b) => (b?.type === 'text' ? b.text : `[${b?.type}]`)).join('\n');
    } else if (event.type === 'assistant') {
      role = 'agent'; kind = 'assistant';
      text = event.message?.content?.[0]?.text
        || (typeof event.message?.content === 'string' ? event.message.content : null)
        || (event.message?.content && event.message.content.length ? JSON.stringify(event.message.content) : null);
    } else if (event.type === 'custom-title' || event.type === 'system' || event.type === 'summary') {
      return null; // not speech — the archive's title/headers stay out of the Task history
    } else {
      role = 'agent'; kind = event.type;   // tool_result, result, stream_event, … — the agent's
      text = event.result || event.content || (event.message?.content && JSON.stringify(event.message.content)) || JSON.stringify(event);
    }
  }
  if (!text) return null;
  const m = {
    messageId: `${store}-${kind || role}-${Math.random().toString(36).slice(2, 10)}`,
    role: role === 'assistant' || role === 'agent' ? 'agent' : 'user',
    parts: [{ text: String(text).slice(0, 4000) }],
  };
  if (kind) m.metadata = { kind };
  if (at) m.metadata = { ...(m.metadata || {}), at: String(at) };
  return m;
}

// xell_conversation (112) → A2A Task. `archive` is a row with id/xell_slug/title/events/content/
// line_count/byte_count/created_at. The events (already-parsed JSONL) become the history; the raw
// `content` is NOT itself copied into a message (it is the source of truth; the events are its
// parse). Deterministic id from the archive row id (the row is already a uuid).
export function archiveRowToTask(archive = {}) {
  const id = archive.id ? conversationTaskId('xell_conversation', archive.id) : null;
  if (!id) return null;
  const events = Array.isArray(archive.events) ? archive.events : [];
  const history = events.map((ev) => conversationEventToMessage({ store: 'xell_conversation', event: ev }))
    .filter(Boolean).slice(0, 200);
  const task = {
    id,
    status: 'completed',
    metadata: {
      store: 'xell_conversation', kind: 'archive',
      title: archive.title || null, xell: archive.xell_slug || null,
      line_count: archive.line_count || events.length, byte_count: archive.byte_count || 0,
      uploaded_at: archive.created_at ? String(archive.created_at) : null,
    },
  };
  if (history.length) task.history = history;
  return task;
}

// zee_conversation (192) → A2A Task. `rows` are the xell's memory rows in seq order (role,
// content, name). One Task per xell — deterministic id from the xell id (the durable work unit,
// DR-4/DR-8). status = 'working' — the memory is the state its next turn reads, not a finished
// task. role system/tool map to user; assistant → agent.
export function memoryRowsToTask({ xellId = null, rows = [] } = {}) {
  if (!xellId) return null;
  const id = conversationTaskId('zee_conversation', xellId);
  const history = rows.map((r) => conversationEventToMessage({
    store: 'zee_conversation', role: r.role, content: r.content,
    at: r.created_at ? String(r.created_at) : null,
  })).filter(Boolean).slice(0, 200);
  const task = {
    id,
    status: 'working',
    metadata: {
      store: 'zee_conversation', kind: 'working-memory', xell: xellId,
      note: 'the live xell\'s stateful working memory — one Task per xell, rows in seq order; '
        + 'status stays working (it is the state the next turn reads, not a finished task)',
    },
  };
  if (history.length) task.history = history;
  return task;
}

// zee_turn (153) → A2A Task. `turn` is a zee_turn row. deterministic id from the turn row id.
// status = 'completed' when the turn ended (ended_at set), 'working' while it is open. The
// summary (the last assistant text) is the single message; the turn's play-by-play events are
// NOT copied into the Task (they are control-plane evidence, not conversation — DR-8).
export function turnRowToTask(turn = {}) {
  if (!turn?.id) return null;
  const id = conversationTaskId('zee_turn', turn.id);
  const ended = !!turn.ended_at;
  const task = {
    id,
    status: ended ? 'completed' : 'working',
    metadata: {
      store: 'zee_turn', kind: 'turn', xell: turn.xell_id || null,
      kind_name: turn.kind || null, model: turn.model || null,
      started_at: turn.started_at ? String(turn.started_at) : null,
      ended_at: turn.ended_at ? String(turn.ended_at) : null,
      stop_reason: turn.stop_reason || null,
      input_tokens: turn.input_tokens || 0, output_tokens: turn.output_tokens || 0,
      cost_usd: Number(turn.cost_usd || 0),
    },
  };
  const summary = turn.summary || lastAssistantTextFromTurn(turn);
  if (summary) {
    task.history = [{ messageId: `zee_turn-${String(turn.id).slice(0, 8)}`, role: 'agent',
                      parts: [{ text: String(summary).slice(0, 4000) }], metadata: { kind: 'summary' } }];
  }
  return task;
}

// The last assistant TEXT a turn produced — mirrors turn-ledger.js's lastAssistantText so this
// module stays pure (no import of the ledger). The zee_turn.summary column is authoritative; this
// is the fallback when it is null (an old turn before the summary column was backfilled).
function lastAssistantTextFromTurn(turn) {
  const s = turn?.summary;
  if (s) return String(s);
  const meta = turn?.meta || {};
  if (meta.last_assistant_text) return String(meta.last_assistant_text);
  return null;
}

// session_event stays OUT of the conversation projection (DR-8). This stub is the named seam:
// it returns null so a future record that changes the decision has a home, and tests can assert
// the exclusion.
export function sessionEventToTask(_event = null) {
  return null;
}

// ── A2A v1.0 ERROR CODES — the exact spec numbers (plan §3.2, DR-5) ─────────
// The refusal methods and the version gate answer with these EXACT codes. A conforming client
// matches on code, so the numbers are part of the wire contract, not prose. Read from the v1.0.1
// spec, not recalled: -32001 TaskNotFound, -32003 PushNotificationNotSupported, -32007
// ExtendedAgentCardNotConfigured, -32009 VersionNotSupported (the full table is plan §3.2).
export const A2A_ERROR = {
  TaskNotFound:                    { code: -32001, name: 'TaskNotFoundError' },
  TaskNotCancelable:               { code: -32002, name: 'TaskNotCancelableError' },
  PushNotificationNotSupported:    { code: -32003, name: 'PushNotificationNotSupportedError' },
  ContentTypeNotSupported:         { code: -32005, name: 'ContentTypeNotSupportedError' },
  ExtendedAgentCardNotConfigured:  { code: -32007, name: 'ExtendedAgentCardNotConfiguredError' },
  VersionNotSupported:             { code: -32009, name: 'VersionNotSupportedError' },
};

// The A2A-Version gate — the JSON-RPC error for a wrong/missing version, or null for "1.0".
// Pure so the wire contract is testable without HTTP (DR-5: VersionNotSupportedError from day one).
export function a2aVersionError(version) {
  const v = String(version || '').trim();
  if (v === '1.0') return null;
  return { code: A2A_ERROR.VersionNotSupported.code,
           message: A2A_ERROR.VersionNotSupported.name,
           data: { message: `A2A-Version header must be "1.0" (got "${v || 'missing'}")` } };
}

// ── AGENT CARDS — plan §3.1 discovery ──────────────────────────────────────
// Both cards are PURE functions of plain facts: the caller (lib/a2a-read.js) gathers the xell row,
// the zee name, the harness skills, the task brief, and the base URL the request reached us at, and
// passes them in — house rule 7: names/containers/status are DATA, never baked into a static file.
// The per-agent card is GENERATED per request from live rows; there is no static card anywhere.
export function buildFleetCard({ base, consoleUrl = null, version = '0.1.0' } = {}) {
  return {
    name: 'ZEEHIVE',
    description: 'The ZEEHIVE queenzee as a mediated multi-agent A2A service — each live zee is an '
      + 'A2A agent behind this single endpoint (docs/a2a-protocol-plan.md §2, DR-2).',
    // The root card describes the service and points at the directory (plan §3.1); the top-level
    // url is the A2A v1.0 required field.
    url: `${base}/a2a/v1/agents`,
    supportedInterfaces: [{
      url: `${base}/a2a/v1/agents`,
      protocolBinding: 'JSONRPC',
      protocolVersion: '1.0',
    }],
    provider: { organization: 'ZEEHIVE', url: consoleUrl || base },
    version,
    capabilities: { streaming: true, pushNotifications: false, extendedAgentCard: false },
    securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
    securityRequirements: [{ bearer: [] }],
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
  };
}

export function buildAgentCard({ xell, base, consoleUrl = null, zeeName = null, skills = [], taskBrief = null } = {}) {
  const slug = xell?.slug || 'unknown';
  const shortSha = xell?.head_commit ? String(xell.head_commit).slice(0, 8) : 'unknown';
  // description = the task brief's first line + the harness label (plan §3.1); the brief is clipped
  // to one line so a card stays a card, not a briefing.
  const briefLine = taskBrief ? String(taskBrief).trim().split('\n')[0].slice(0, 160) : null;
  const description = [
    briefLine,
    xell?.harness_label ? `Harness: ${xell.harness_label}` : null,
  ].filter(Boolean).join(' — ') || `ZEEHIVE agent ${slug}`;
  // The skills array: one AgentSkill per harness skill (id = the skill key, description = its
  // When: line), plus one for the zee's task (plan §3.1) — the task is the agent's current job.
  const skillList = skills.map((s) => ({ id: s.name, description: s.when || null }));
  if (briefLine) skillList.push({ id: 'task', description: briefLine });
  return {
    // name = the zee's codename + the xell slug (DR-4: the slug is the durable agent identity).
    name: zeeName ? `${zeeName} · ${slug}` : slug,
    description,
    url: `${base}/a2a/v1/agents/${slug}`,
    supportedInterfaces: [{
      url: `${base}/a2a/v1/agents/${slug}`,
      protocolBinding: 'JSONRPC',
      // tenant is the spec's own field for "multiple agents served behind a single A2A endpoint"
      // (a2a.proto AgentInterface.tenant, plan §3.1) — here the xell slug.
      tenant: slug,
      protocolVersion: '1.0',
    }],
    provider: { organization: 'ZEEHIVE', url: consoleUrl || base },
    // version = the xell's head commit short sha — the honest version of an agent that is a worktree.
    version: shortSha,
    capabilities: { streaming: true, pushNotifications: false, extendedAgentCard: false },
    securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
    securityRequirements: [{ bearer: [] }],
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: skillList,
  };
}
