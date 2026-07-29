// TICKETS — what came IN, before anyone decided what to DO about it.
//
// A ticket is the raw ask: a bug someone hit, a feature someone wants, a question, an incident. It
// is deliberately NOT the same noun as a work item. The work tracker's whole shape is:
//
//   ticket  ──breakdown──▶  work_item tree  ──assigned──▶  a zee in a xell
//   (what came in)          (what we will do)               (who is doing it)
//
// Collapsing those two would cost the thing the split buys: a ticket can be one line typed in a
// hurry and still be tracked, and the SAME ticket can turn into eleven tasks under three activities
// without anyone having to re-file it. `breakdownTicket` is that hinge, and it is the one function
// here that writes to both tables.
//
// Tickets are numbered PER PROJECT (#1, #2, …) by a database trigger, because a number is what a
// human says out loud and a uuid is not.
//
// Same house habits as work-items.js: pure data, no HTTP; every mutation broadcasts on the 'work'
// channel so the console's SSE stream pushes it; the database owns the impossibilities.
import { q, one } from '../db/pool.js';
import { broadcast } from './events.js';
import { workLabel, isWorkStatus, nextStatuses, canTransition, TICKET_KINDS,
         WORK_STATUS_KEYS } from './work-status.js';
import { createWorkItem, projectRoot, logWorkEvent, nestItems, assertId, isUuid,
         inTransaction, dbRunner, bad, refuse } from './work-items.js';

const COLS = `id, project_id, number, title, body, kind, status, priority, reporter, assignee,
              labels, work_item_id, created_at, updated_at, closed_at`;

function shapeTicket(row) {
  if (!row) return null;
  return {
    ...row,
    labels: row.labels || [],
    status_label: workLabel(row.status),
    next_statuses: nextStatuses(row.status),
    ref: `#${row.number}`,
  };
}

// ── reads ────────────────────────────────────────────────────────────────────

// `q` is a free-text search over title/body/reporter — the search a person actually performs when
// they half-remember a ticket. ILIKE, not full-text: this table is small and a GIN index that has
// to be maintained for a hundred rows is a liability, not an optimisation.
export async function listTickets({ projectId, status, kind, q: search } = {}) {
  if (projectId) assertId(projectId, 'project id');
  for (const st of [].concat(status || [])) {
    if (!isWorkStatus(st)) throw bad(`unknown status "${st}" — one of: ${WORK_STATUS_KEYS.join(', ')}`);
  }
  for (const k of [].concat(kind || [])) {
    if (!TICKET_KINDS.includes(k)) throw bad(`unknown ticket kind "${k}" — one of: ${TICKET_KINDS.join(', ')}`);
  }
  const where = [];
  const params = [];
  // `add` takes a builder so a filter can spend its ONE parameter on several placeholders (the
  // free-text search matches three columns off a single bound value).
  const add = (val, build) => { params.push(val); where.push(build(`$${params.length}`)); };
  if (projectId) add(projectId, (p) => `t.project_id = ${p}`);
  if (status) add(status, (p) => (Array.isArray(status) ? `t.status = ANY(${p}::work_status[])` : `t.status = ${p}`));
  if (kind) add(kind, (p) => (Array.isArray(kind) ? `t.kind = ANY(${p}::ticket_kind[])` : `t.kind = ${p}`));
  if (search) add(`%${search}%`, (p) => `(t.title ILIKE ${p} OR t.body ILIKE ${p} OR t.reporter ILIKE ${p})`);

  const rows = await q(
    `SELECT ${COLS.split(',').map((c) => `t.${c.trim()}`).join(', ')},
            (SELECT count(*)::int FROM work_item w WHERE w.ticket_id = t.id) AS work_items_count,
            (SELECT count(*)::int FROM work_item w WHERE w.ticket_id = t.id
                AND w.status NOT IN ('done','cancelled')) AS open_work_items_count,
            (SELECT count(*)::int FROM ticket_comment c WHERE c.ticket_id = t.id) AS comment_count
       FROM ticket t
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY t.created_at DESC`, params);
  return rows.map(shapeTicket);
}

export async function getTicket(id) {
  assertId(id, 'ticket id');
  const row = await one(`SELECT ${COLS} FROM ticket WHERE id=$1`, [id]);
  if (!row) return null;
  const comments = await q(
    `SELECT id, author, body, created_at FROM ticket_comment WHERE ticket_id=$1 ORDER BY created_at`, [id]);
  const items = await q(
    `SELECT id, project_id, parent_id, kind, title, status, priority, progress, depth, xell_id,
            assignee, starts_on, due_on
       FROM work_item WHERE ticket_id=$1 ORDER BY depth, sort_order, created_at`, [id]);
  const project = await one(`SELECT id, name FROM project WHERE id=$1`, [row.project_id]);
  return {
    ...shapeTicket(row),
    project,
    comments,
    work_items: items.map((w) => ({ ...w, status_label: workLabel(w.status) })),
    work_items_count: items.length,
    open_work_items_count: items.filter((w) => !['done', 'cancelled'].includes(w.status)).length,
  };
}

// ── writes ───────────────────────────────────────────────────────────────────

export async function createTicket(input = {}) {
  const title = String(input.title || '').trim();
  if (!title) throw bad('title required');
  const projectId = input.project_id || input.project;
  if (!projectId) throw bad('project required');
  assertId(projectId, 'project id');
  if (input.kind && !TICKET_KINDS.includes(input.kind)) {
    throw bad(`unknown ticket kind "${input.kind}" — one of: ${TICKET_KINDS.join(', ')}`);
  }
  if (input.status && !isWorkStatus(input.status)) throw bad(`unknown status "${input.status}"`);

  const row = await one(
    `INSERT INTO ticket (project_id, title, body, kind, status, priority, reporter, assignee, labels)
     VALUES ($1,$2,$3,coalesce($4::ticket_kind,'feature'),coalesce($5::work_status,'queued'),
             coalesce($6::int,3),$7,$8,coalesce($9::text[],'{}'))
     RETURNING ${COLS}`,
    [projectId, title, input.body ?? null, input.kind ?? null, input.status ?? null,
     input.priority ?? null, input.reporter ?? null, input.assignee ?? null,
     Array.isArray(input.labels) ? input.labels : null]);
  broadcast('work', { kind: 'ticket-created', ticket: shapeTicket(row) });
  return shapeTicket(row);
}

// priority is 1..5 and 1 is MOST urgent (docs/work-tracker.md, policy 5). Default 3 is the
// middle of the scale. NB: machine_pool.dev_priority is the OPPOSITE convention — higher wins.
const TICKET_EDITABLE = ['title', 'body', 'kind', 'priority', 'reporter', 'assignee', 'labels', 'work_item_id'];

export async function updateTicket(id, patch = {}, { actor = null } = {}) {
  assertId(id, 'ticket id');
  if (patch.work_item_id) assertId(patch.work_item_id, 'work item id');
  const before = await one(`SELECT ${COLS} FROM ticket WHERE id=$1`, [id]);
  if (!before) return null;
  if (patch.kind && !TICKET_KINDS.includes(patch.kind)) {
    throw bad(`unknown ticket kind "${patch.kind}" — one of: ${TICKET_KINDS.join(', ')}`);
  }
  if ('status' in patch && patch.status !== before.status) {
    if (!isWorkStatus(patch.status)) throw bad(`unknown status "${patch.status}"`);
    if (!canTransition(before.status, patch.status)) {
      throw refuse(`cannot move ticket #${before.number} from ${before.status} to ${patch.status}`
        + ` — legal next statuses are: ${nextStatuses(before.status).join(', ')}`);
    }
  }
  const sets = [];
  const params = [id];
  for (const f of [...TICKET_EDITABLE, 'status']) {
    if (!(f in patch)) continue;
    params.push(patch[f] === '' ? null : patch[f]);
    sets.push(`${f} = $${params.length}`);
  }
  if (!sets.length) return shapeTicket(before);
  const row = await one(`UPDATE ticket SET ${sets.join(', ')} WHERE id=$1 RETURNING ${COLS}`, params);
  // the ticket's own history rides on its linked work item's ledger when there is one — a ticket
  // with no item yet simply has nothing to hang an event on, and we do not invent a row for it
  if (row.work_item_id) {
    await logWorkEvent(row.work_item_id, 'edited', { actor, detail: { ticket: `#${row.number}`, patch } });
  }
  broadcast('work', { kind: 'ticket-updated', ticket: shapeTicket(row) });
  return shapeTicket(row);
}

// Deleting a ticket does NOT delete the work items it was broken into: ON DELETE SET NULL on
// work_item.ticket_id keeps the plan and drops the paperwork. The answer says how many items were
// orphaned so the caller can say it out loud.
export async function deleteTicket(id) {
  assertId(id, 'ticket id');
  const row = await one(`SELECT ${COLS} FROM ticket WHERE id=$1`, [id]);
  if (!row) return null;
  const n = await one(`SELECT count(*)::int AS n FROM work_item WHERE ticket_id=$1`, [id]);
  await q(`DELETE FROM ticket WHERE id=$1`, [id]);
  broadcast('work', { kind: 'ticket-deleted', ticket: shapeTicket(row) });
  return { ok: true, deleted: shapeTicket(row), unlinked_work_items: n?.n ?? 0 };
}

export async function addComment(ticketId, { author, body } = {}) {
  assertId(ticketId, 'ticket id');
  const text = String(body || '').trim();
  if (!text) throw bad('body required');
  const ticket = await one(`SELECT ${COLS} FROM ticket WHERE id=$1`, [ticketId]);
  if (!ticket) return null;
  const row = await one(
    `INSERT INTO ticket_comment (ticket_id, author, body) VALUES ($1,$2,$3)
     RETURNING id, ticket_id, author, body, created_at`, [ticketId, author || null, text]);
  if (ticket.work_item_id) {
    await logWorkEvent(ticket.work_item_id, 'comment', { actor: author || null,
      detail: { ticket: `#${ticket.number}`, body: text.slice(0, 500) } });
  }
  broadcast('work', { kind: 'ticket-comment', ticket: shapeTicket(ticket), comment: row });
  return row;
}

// ── the hinge: a ticket becomes a PLAN ───────────────────────────────────────
//
// Creates the work items described by `items`, links every one of them to the ticket, and moves the
// ticket out of 'queued' — because a ticket that has been broken down is, by definition, no longer
// merely queued.
//
// Each entry: { title, kind?, parent_id?, body?, priority?, assignee?, starts_on?, due_on?,
//               estimate_hours?, status?, ref? }
// Defaults: parent = the project ROOT item, kind = 'task'.
// `ref` is a caller-supplied local handle so ONE call can build a whole TREE in one go: a later
// entry may name an earlier entry's `ref` as its `parent_id` ("parent_id": "act1"). Without it a
// caller would have to POST the parent, read the uuid back, and POST the children — three round
// trips to express one thought.
//
// THIS IS ADDITIVE, NOT IDEMPOTENT. Calling it twice on the same ticket creates a SECOND set of
// items — it does not reconcile or replace the first. A "re-break-down" button therefore duplicates
// the plan unless the caller deletes the previous items first. Left additive on purpose: a ticket
// legitimately grows more work as it is understood, and a reconcile would have to guess which of
// the existing items the author meant to keep.
export async function breakdownTicket(id, { items = [], actor = null } = {}) {
  assertId(id, 'ticket id');
  if (!Array.isArray(items) || !items.length) throw bad('items required (a non-empty array)');
  // Cheap existence check before opening a transaction, so an unknown ticket is a plain 404 rather
  // than a rolled-back BEGIN. The authoritative read happens again inside, through the client.
  if (!(await one(`SELECT id FROM ticket WHERE id=$1`, [id]))) return null;

  // ONE TRANSACTION. Either the whole plan exists or the ticket is untouched — no caller ever has
  // to work out which four of six items got in. Broadcasts are collected by inTransaction and sent
  // only after the COMMIT, so nothing is announced that was then rolled back.
  const out = await inTransaction(async ({ client, pending }) => {
    const db = dbRunner(client);
    const ticket = await db.one(`SELECT ${COLS} FROM ticket WHERE id=$1`, [id]);
    const root = await projectRoot(ticket.project_id, client);
    if (!root) throw bad(`project ${ticket.project_id} has no root work item to break this ticket down under`);

    const byRef = new Map();
    const created = [];
    for (const spec of items) {
      if (!spec || !String(spec.title || '').trim()) throw bad('every item needs a title');
      // A parent named by local ref, by uuid, or (default) the project root. A ref only resolves
      // BACKWARDS — it must have been declared by an earlier entry in this same call — so anything
      // else that is not a uuid is a typo or a forward reference, and it is named as such here.
      // Left to fall through it reached postgres as a uuid cast and came back as
      // 'invalid input syntax for type uuid: "act"', which tells the author nothing about which of
      // their items was wrong or why. Raised from in here it now also means NOTHING was created.
      let parentId = spec.parent_id || null;
      if (parentId && byRef.has(parentId)) parentId = byRef.get(parentId).id;
      else if (parentId && !isUuid(parentId)) {
        const known = [...byRef.keys()];
        throw bad(`item "${spec.title}": parent_id "${parentId}" is neither a work item id nor `
          + `a ref declared by an EARLIER item in this breakdown`
          + (known.length ? ` (refs so far: ${known.join(', ')})` : ' (no refs declared yet)')
          + '. A ref must be defined before it is used. Nothing was created.');
      }
      const item = await createWorkItem({
        ...spec,
        ref: undefined,
        project_id: ticket.project_id,
        parent_id: parentId || root.id,
        kind: spec.kind || 'task',
        ticket_id: ticket.id,
        actor,
      }, { client, pending });
      if (spec.ref) byRef.set(spec.ref, item);
      created.push(item);
    }

    // the ticket points at the TOP of what it became (the shallowest, first-created item), and only
    // when nothing has claimed that slot already — a re-breakdown must not silently re-point it
    const top = [...created].sort((a, b) => a.depth - b.depth)[0];
    const patch = [];
    const params = [ticket.id];
    if (!ticket.work_item_id && top) { params.push(top.id); patch.push(`work_item_id = $${params.length}`); }
    if (ticket.status === 'queued') patch.push(`status = 'assigned'`);
    const row = patch.length
      ? await db.one(`UPDATE ticket SET ${patch.join(', ')} WHERE id=$1 RETURNING ${COLS}`, params)
      : ticket;

    pending.push(['work', { kind: 'ticket-breakdown', ticket: shapeTicket(row), created: created.length }]);
    // the created TREE, nested, so the caller can render what it just made
    return { ok: true, ticket: shapeTicket(row), created, tree: nestItems(created), count: created.length };
  });
  return out;
}
