// THE EXTERNAL TICKETING API — a DEPLOYED project files, monitors and updates its own tickets.
//
//   omnibiz (running on somebody else's server)  ──Bearer zhk_…──▶  /api/ext/v1/tickets
//                                                                        │
//                                                    the SAME `ticket` row the console shows
//                                                                        │
//                                             breakdown ▸ work items ▸ a zee in a xell
//
// Nothing here is a second tracker. A ticket that arrives through this door is an ordinary row in
// `ticket`, created by the ordinary `createTicket`, and every verb the fleet already has — the
// board, breakdown, assignment, `zee work` — applies to it unchanged. What this module adds is the
// OUTSIDE of that door: authentication by project key, idempotency, a shape an external integrator
// can rely on, and the limits on what a reporter is allowed to say.
//
// THREE RULES, and they are the whole contract:
//
// 1. THE PROJECT COMES FROM THE KEY, NEVER FROM THE BODY. The caller cannot name a project, so it
//    cannot reach another one — the same construction the cxell verbs use (routes.js resolves the
//    calling xell from its token and refuses to read an id out of the body). `resolveTicket` is
//    called WITH the key's project for exactly the same reason.
//
// 2. A REPEAT POST IS THE SAME TICKET. An integration retries: a timeout it never saw the answer
//    to, an at-least-once queue, a helpdesk webhook fired twice. `external_ref` (the caller's own
//    id) is unique per project, so the second POST returns the FIRST ticket with `deduped: true`
//    instead of filing a twin. A caller that sends no ref gets no idempotency and is told so.
//
// 3. THE REPORTER OWNS THE INTAKE, THE FLEET OWNS THE WORK. An external caller may edit what it
//    reported (title, body, kind, priority, labels, its own link) and may CANCEL what it filed or
//    REOPEN it — it may NOT set `working`, `review`, `shipping` or `done`. Those statuses are
//    assertions about what zees are doing, and a helpdesk saying `working` because a human clicked
//    "in progress" in ITS ui would be a lie the board then renders. Everything else it wants to
//    say goes in a comment, which is exactly where a conversation belongs.
import { one } from '../db/pool.js';
import { createTicket, updateTicket, addComment, getTicket, listTickets, resolveTicket,
         ticketCode, ticketManagers, notifyManagerOfTicket } from './tickets.js';
import { addAttachment, addAttachments, listAttachments, attachmentLimits } from './ticket-attachments.js';
import { bad, notFound, refuse } from './work-items.js';
import { TICKET_KINDS, workLabel } from './work-status.js';

// The statuses an external reporter may set on its own ticket (rule 3). `queued` reopens a ticket
// the fleet closed; `cancelled` withdraws one ("the customer sorted it themselves").
export const EXTERNAL_SETTABLE_STATUSES = ['queued', 'cancelled'];

// What an external caller may edit. Deliberately NOT `assignee` (who works on it is the fleet's
// call), not `work_item_id` (the plan is not the reporter's), and not `external_ref` (the
// idempotency key, see rule 2).
const EXTERNAL_EDITABLE = ['title', 'body', 'kind', 'priority', 'labels', 'reporter', 'external_url'];

// ── the shape an integrator codes against ────────────────────────────────────
//
// Deliberately NOT the console's shape. It carries no xell ids, no api_key_id and no internal
// counts — an external system is told what its ticket IS and what is happening to it, in words it
// can render in its own helpdesk, and nothing about the agents doing the work beyond progress.
export function externalView(t, { comments = [], attachments = [], work = [] } = {}) {
  if (!t) return null;
  return {
    id: t.id,
    code: t.code || ticketCode(t),
    ref: t.ref || `#${t.number}`,
    number: t.number,
    title: t.title,
    body: t.body,
    kind: t.kind,
    status: t.status,
    status_label: t.status_label || workLabel(t.status),
    // What THIS caller may move it to — a subset of the tracker's own transitions (rule 3), so a
    // client builds its dropdown from the answer instead of from a doc that will drift.
    settable_statuses: EXTERNAL_SETTABLE_STATUSES.filter((s) => s !== t.status),
    priority: t.priority,
    labels: t.labels || [],
    reporter: t.reporter,
    external_ref: t.external_ref,
    external_url: t.external_url,
    created_at: t.created_at,
    updated_at: t.updated_at,
    closed_at: t.closed_at,
    comments: comments.map((c) => ({ id: c.id, author: c.author, body: c.body, created_at: c.created_at })),
    attachments: attachments.map((a) => ({
      id: a.id, filename: a.filename, content_type: a.content_type, kind: a.kind,
      size_bytes: a.size_bytes, sha256: a.sha256, created_at: a.created_at,
      // the EXTERNAL download path — /api/tickets/... is the console's, and an external key cannot
      // authenticate against it
      download_url: `/api/ext/v1/tickets/${t.id}/attachments/${a.id}`,
    })),
    // MONITORING: what the fleet is doing about it. Titles, statuses and progress only.
    work: {
      items: work.map((w) => ({ title: w.title, kind: w.kind, status: w.status,
                                status_label: w.status_label || workLabel(w.status),
                                progress: w.progress })),
      count: work.length,
      open: work.filter((w) => !['done', 'cancelled'].includes(w.status)).length,
    },
  };
}

// A LIST row: the same nouns, without the conversation (a list of 200 tickets must not carry every
// comment and every attachment of each).
export function externalListView(t) {
  return {
    id: t.id, code: t.code, ref: t.ref, number: t.number, title: t.title, kind: t.kind,
    status: t.status, status_label: t.status_label, priority: t.priority, labels: t.labels || [],
    reporter: t.reporter, external_ref: t.external_ref, external_url: t.external_url,
    created_at: t.created_at, updated_at: t.updated_at, closed_at: t.closed_at,
    work_items_count: t.work_items_count ?? 0, open_work_items_count: t.open_work_items_count ?? 0,
    comment_count: t.comment_count ?? 0,
  };
}

// The one place that turns "the caller named a ticket" into a row, scoped to the key's project.
// Anything not in this project is a 404 and not a 403: an external caller must not be able to
// probe another project's ticket numbering by reading the difference.
async function ticketOfCaller(auth, ref) {
  const t = await resolveTicket(ref, { projectId: auth.project.id });
  if (!t) throw notFound(`no ticket "${ref}" in ${auth.project.name}`);
  return t;
}

// ── the verbs ────────────────────────────────────────────────────────────────

export async function externalCreateTicket(auth, body = {}) {
  const input = body || {};
  const externalRef = input.external_ref == null ? null : String(input.external_ref).trim() || null;

  // Idempotency (rule 2), checked BEFORE the insert so the ordinary retry never reaches the unique
  // index. The race that gets past it (two identical POSTs in flight) is caught below, by the
  // index itself — a constraint is the only thing that can win that race.
  if (externalRef) {
    const existing = await one(
      `SELECT id FROM ticket WHERE project_id=$1 AND external_ref=$2`, [auth.project.id, externalRef]);
    if (existing) return { ...(await externalGetTicket(auth, existing.id)), deduped: true };
  }

  if (input.kind && !TICKET_KINDS.includes(input.kind)) {
    throw bad(`unknown kind "${input.kind}" — one of: ${TICKET_KINDS.join(', ')}`);
  }
  if (input.status) {
    throw refuse('a new ticket always starts queued — status is not yours to set at creation. '
      + `Once it exists you may set: ${EXTERNAL_SETTABLE_STATUSES.join(', ')}.`);
  }

  let ticket;
  try {
    ticket = await createTicket({
      project_id: auth.project.id,
      title: input.title,
      body: input.body ?? null,
      kind: input.kind ?? 'bug',        // an external report is a fault far more often than a wish
      priority: input.priority ?? null,
      reporter: input.reporter ?? `api:${auth.key.label}`,
      labels: Array.isArray(input.labels) ? input.labels : undefined,
      source: `api:${auth.key.label}`,
      external_ref: externalRef,
      external_url: input.external_url ?? null,
      api_key_id: auth.key.id,
    });
  } catch (err) {
    // 23505 = the unique index. Two concurrent POSTs of the same external_ref: the loser answers
    // with the winner's ticket, which is what an idempotent create means.
    if (err?.code === '23505' && externalRef) {
      const winner = await one(`SELECT id FROM ticket WHERE project_id=$1 AND external_ref=$2`,
                               [auth.project.id, externalRef]);
      if (winner) return { ...(await externalGetTicket(auth, winner.id)), deduped: true };
    }
    throw err;
  }

  // The evidence, in the same round trip. Rejected attachments are REPORTED, never silent, and
  // never fatal: a ticket that exists with three of its four logs beats no ticket at all.
  const { stored, rejected } = await addAttachments(ticket.id, input.attachments || [], {
    uploadedBy: input.reporter || `api:${auth.key.label}`, source: `api:${auth.key.label}`,
  });

  // A ticket that nobody reads is a ticket nobody acts on. The console and `zee ticket --notify`
  // already hand one to a manager; an external POST used to insert the row and return, so the
  // fleet never learned it existed. Same door, same best-effort rule as selfTicketCreate: a dead
  // inbox must not fail the filing, and a deduped retry (returned above) must not re-notify.
  await notifyProjectManagers(ticket.id, `api:${auth.key.label}`);

  const view = await externalGetTicket(auth, ticket.id);
  return {
    ...view,
    deduped: false,
    attachments_stored: stored.length,
    attachments_rejected: rejected.length ? rejected : undefined,
    note: externalRef ? undefined
      : 'No external_ref was sent, so this POST is NOT idempotent — a retry would file a second '
        + 'ticket. Send your own id as external_ref.',
  };
}

// Hand the freshly filed ticket to every deployed manager of its project. Reuses
// ticketManagers + notifyManagerOfTicket (inbox always; typed into a live cxell when one exists).
// Per-manager failures are swallowed — the ticket itself is the durable fact.
async function notifyProjectManagers(ticketId, by) {
  try {
    const { managers = [] } = (await ticketManagers(ticketId)) || {};
    for (const m of managers) {
      try {
        await notifyManagerOfTicket(ticketId, { xellId: m.xell_id, by });
      } catch { /* that one manager is gone/asleep — the ticket itself stands */ }
    }
  } catch { /* the picker failing must not fail the filing either */ }
}

export async function externalListTickets(auth, { status, kind, q: search, external_ref } = {}) {
  if (external_ref) {
    const row = await one(`SELECT id FROM ticket WHERE project_id=$1 AND external_ref=$2`,
                          [auth.project.id, String(external_ref)]);
    if (!row) return { project: auth.project.name, count: 0, tickets: [] };
    const t = await externalGetTicket(auth, row.id);
    return { project: auth.project.name, count: 1, tickets: [externalListView(t)] };
  }
  const rows = await listTickets({ projectId: auth.project.id, status: status || null,
                                   kind: kind || null, q: search || null });
  return { project: auth.project.name, count: rows.length, tickets: rows.map(externalListView) };
}

export async function externalGetTicket(auth, ref) {
  const found = await ticketOfCaller(auth, ref);
  const full = await getTicket(found.id);
  return externalView(full, { comments: full.comments, attachments: full.attachments,
                              work: full.work_items });
}

export async function externalUpdateTicket(auth, ref, patch = {}) {
  const t = await ticketOfCaller(auth, ref);
  const clean = {};
  for (const [k, v] of Object.entries(patch || {})) {
    if (k === 'status') continue;
    if (!EXTERNAL_EDITABLE.includes(k)) {
      throw refuse(`"${k}" is not yours to set from outside — you may edit: `
        + `${EXTERNAL_EDITABLE.join(', ')}, and set status to ${EXTERNAL_SETTABLE_STATUSES.join(' or ')}. `
        + 'Anything else you want to say goes in a comment.');
    }
    clean[k] = v;
  }
  if ('status' in patch && patch.status !== t.status) {
    if (!EXTERNAL_SETTABLE_STATUSES.includes(patch.status)) {
      throw refuse(`an external reporter may only set ${EXTERNAL_SETTABLE_STATUSES.join(' or ')} — `
        + `"${patch.status}" is a statement about what the fleet is doing, and only the fleet makes it. `
        + 'Comment instead.');
    }
    clean.status = patch.status;
  }
  if (!Object.keys(clean).length) throw bad('nothing to update');
  await updateTicket(t.id, clean, { actor: `api:${auth.key.label}` });
  return externalGetTicket(auth, t.id);
}

export async function externalComment(auth, ref, { author, body, attachments } = {}) {
  const t = await ticketOfCaller(auth, ref);
  const who = author || `api:${auth.key.label}`;
  const comment = await addComment(t.id, { author: who, body });
  const { stored, rejected } = await addAttachments(t.id, attachments || [], {
    uploadedBy: who, source: `api:${auth.key.label}`,
  });
  // The attachments of THIS comment are stamped with it, so a helpdesk can render the reply and
  // its evidence together. Done after the fact rather than inside addAttachments so one refused
  // attachment cannot cost the caller its comment.
  for (const a of stored) {
    await one(`UPDATE ticket_attachment SET comment_id=$2 WHERE id=$1 RETURNING id`, [a.id, comment.id]);
  }
  return {
    ok: true,
    ticket: { id: t.id, code: t.code, ref: t.ref },
    comment: { id: comment.id, author: comment.author, body: comment.body, created_at: comment.created_at },
    attachments: stored.map((a) => ({ id: a.id, filename: a.filename, size_bytes: a.size_bytes })),
    attachments_rejected: rejected.length ? rejected : undefined,
  };
}

export async function externalAttach(auth, ref, body = {}) {
  const t = await ticketOfCaller(auth, ref);
  const specs = Array.isArray(body.attachments) ? body.attachments : [body];
  if (!specs.length) throw bad('nothing to attach');
  const opts = { uploadedBy: body.uploaded_by || `api:${auth.key.label}`, source: `api:${auth.key.label}` };
  // ONE attachment is not a batch: its error is raised as ITSELF, so a caller sending a single file
  // gets the real status (400 for "you sent nonsense", 409 for "coherent but over a limit") instead
  // of every failure flattened into one 409. A batch keeps the partial-success shape — the whole
  // point of it is that one refused file must not throw away the ones that were fine.
  if (specs.length === 1) {
    const a = await addAttachment(t.id, specs[0], opts);
    return {
      ok: true,
      ticket: { id: t.id, code: t.code, ref: t.ref },
      stored: [{ id: a.id, filename: a.filename, content_type: a.content_type, kind: a.kind,
                 size_bytes: a.size_bytes, sha256: a.sha256,
                 download_url: `/api/ext/v1/tickets/${t.id}/attachments/${a.id}` }],
    };
  }
  const { stored, rejected } = await addAttachments(t.id, specs, opts);
  if (!stored.length && rejected.length) {
    throw refuse(`nothing was stored — ${rejected.map((r) => `${r.filename || 'attachment'}: ${r.error}`).join('; ')}`);
  }
  return {
    ok: true,
    ticket: { id: t.id, code: t.code, ref: t.ref },
    stored: stored.map((a) => ({ id: a.id, filename: a.filename, content_type: a.content_type,
                                 kind: a.kind, size_bytes: a.size_bytes, sha256: a.sha256,
                                 download_url: `/api/ext/v1/tickets/${t.id}/attachments/${a.id}` })),
    rejected: rejected.length ? rejected : undefined,
  };
}

export async function externalAttachments(auth, ref) {
  const t = await ticketOfCaller(auth, ref);
  const rows = await listAttachments(t.id);
  return {
    ticket: { id: t.id, code: t.code, ref: t.ref },
    count: rows.length,
    attachments: rows.map((a) => ({ id: a.id, filename: a.filename, content_type: a.content_type,
                                    kind: a.kind, size_bytes: a.size_bytes, sha256: a.sha256,
                                    created_at: a.created_at,
                                    download_url: `/api/ext/v1/tickets/${t.id}/attachments/${a.id}` })),
  };
}

// ── the self-describing bit ──────────────────────────────────────────────────
//
// An integrator's first call. It answers WHO the key is (which project it files into — the single
// most common integration mistake is a key pointed at the wrong project) and WHAT the API accepts,
// generated from the same constants the server validates against. A client that reads its
// vocabulary from here cannot drift from the server; one that reads it from a doc will.
export function externalMeta(auth) {
  return {
    ok: true,
    project: { id: auth.project.id, name: auth.project.name },
    key: { label: auth.key.label, hint: auth.key.hint, scopes: auth.key.scopes },
    ticket_kinds: TICKET_KINDS,
    settable_statuses: EXTERNAL_SETTABLE_STATUSES,
    editable_fields: EXTERNAL_EDITABLE,
    priority: { range: [1, 5], default: 3, note: '1 is MOST urgent' },
    attachments: attachmentLimits(),
    endpoints: {
      'GET  /api/ext/v1/whoami': 'this answer',
      'POST /api/ext/v1/tickets': 'file a ticket (external_ref makes it idempotent; attachments[] rides along)',
      'GET  /api/ext/v1/tickets': 'list your project\'s tickets (?status= ?kind= ?q= ?external_ref=)',
      'GET  /api/ext/v1/tickets/:ref': 'monitor one — status, comments, attachments, what the fleet is doing',
      'PATCH /api/ext/v1/tickets/:ref': 'update what you reported (see editable_fields/settable_statuses)',
      'POST /api/ext/v1/tickets/:ref/comments': 'add a comment (attachments[] rides along)',
      'POST /api/ext/v1/tickets/:ref/attachments': 'attach more evidence',
      'GET  /api/ext/v1/tickets/:ref/attachments': 'list the evidence',
      'GET  /api/ext/v1/tickets/:id/attachments/:attachmentId': 'download one (raw bytes)',
    },
    note: ':ref is a ticket id, its code (TKT-52-2518), its ref (#52) or its bare number.',
  };
}
