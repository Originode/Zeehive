// WORK ITEMS — the hierarchy of work (project → activity → task → subtask), and the read models the
// console draws a BOARD and a GANTT from.
//
// WHY THIS EXISTS. Everything else in this meta-schema records which AGENTS are running. Nothing
// recorded what the work IS, so a manager zee had a hive and no plan: it could see four live zees
// and nothing about what any of them was for, what was blocked behind what, or what was left. A
// work item is the missing noun — the thing a ticket is broken down into, the thing a zee is
// assigned to (work_item.xell_id, part 2), and the thing a board column and a gantt row are drawn
// from.
//
// SHAPE OF THIS MODULE. Pure data + read models, no HTTP: routes.js does the status codes, this
// does the truth. Three habits, all deliberate:
//
//   • the DATABASE owns the impossibilities (migration 058): one root per project, same-project
//     parentage, the nesting rank, cycles, path/depth maintenance, closed_at. This module does not
//     re-check them — it lets postgres raise and turns the message into something a human reads.
//   • every mutation ENDS with broadcast('work', row), so the console's SSE stream (/api/stream)
//     pushes it without a poll, and appends a work_item_event row so "who moved this, when" always
//     has an answer.
//   • roll-ups (a parent's dates, a parent's progress) are a READ-MODEL concern and are never
//     written back. A stored roll-up is a cache that goes stale the first time anyone edits a leaf,
//     and this repo has no place to invalidate it.
import { q, one } from '../db/pool.js';
import { broadcast } from './events.js';
import { hiveStatus, hiveLabel } from './hive-status.js';
import {
  WORK_STATUS_KEYS, WORK_STATUS, workLabel, isWorkStatus, canTransition, nextStatuses,
  statusFromHive, isTerminal,
} from './work-status.js';

// ── small shapers ────────────────────────────────────────────────────────────

const pad = (n) => String(n).padStart(2, '0');
// node-pg parses a DATE column into a local-midnight Date. Read the LOCAL components back out and
// the day survives; toISOString() would shift it by the host's UTC offset, which is how trackers
// end up showing a task starting the day before it starts.
const asDate = (v) => (v instanceof Date
  ? `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`
  : (v ?? null));
const asNum = (v) => (v === null || v === undefined ? null : Number(v));

// The ancestor ids a materialized path carries, oldest first ('' → []).
export function ancestorIds(path) {
  return String(path || '').split('/').filter(Boolean);
}
// Everything under an item matches `path LIKE subtreePrefix(item) || '%'` (one index scan).
export function subtreePrefix(item) {
  return `${item.path || ''}${item.id}/`;
}

// One work item as the API returns it: dates as YYYY-MM-DD, numerics as numbers, ancestors resolved.
function shapeItem(row) {
  if (!row) return null;
  return {
    ...row,
    starts_on: asDate(row.starts_on),
    due_on: asDate(row.due_on),
    estimate_hours: asNum(row.estimate_hours),
    sort_order: asNum(row.sort_order),
    ancestor_ids: ancestorIds(row.path),
    status_label: workLabel(row.status),
    next_statuses: nextStatuses(row.status),
  };
}

const COLS = `id, project_id, parent_id, kind, title, body, status, priority, ticket_id, xell_id,
              assignee, starts_on, due_on, estimate_hours, progress, sort_order, path, depth,
              created_by, created_at, updated_at, closed_at`;

// ── the audit trail ──────────────────────────────────────────────────────────
// kind: created | status | moved | assigned | edited | comment
export async function logWorkEvent(workItemId, kind, { from = null, to = null, actor = null, detail = null } = {}) {
  return one(
    `INSERT INTO work_item_event (work_item_id, kind, from_status, to_status, actor, detail)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [workItemId, kind, from, to, actor || null, detail ? JSON.stringify(detail) : null]);
}

// Every mutation goes out the same door: the row on the SSE bus, an event row in the ledger.
async function emit(row, kind, opts = {}) {
  if (!row) return row;
  await logWorkEvent(row.id, kind, opts);
  broadcast('work', { kind, item: shapeItem(row) });
  return row;
}

// ── the live zee on an item ──────────────────────────────────────────────────
//
// A work item may name the xell whose zee is on it. The card wants the SAME words the hexagon uses,
// so the hive status is derived by lib/hive-status.js — the one source of truth — from the same live
// signals fleet.js folds into its row read (a held landing, a tend, a hint…). Batched: a board of
// eighty cards must not cost eighty queries.
export async function liveZees(xellIds) {
  const ids = [...new Set((xellIds || []).filter(Boolean))];
  if (!ids.length) return new Map();
  const rows = await q(
    `SELECT x.id, x.slug, x.status, x.is_production, x.branch,
            z.status AS zee_status, z.cli_active, z.name AS zee_name, z.title AS zee_title,
            EXISTS(SELECT 1 FROM land_request lr WHERE lr.xell_id=x.id
                     AND lr.status IN ('pending','approved') AND lr.dismissed_at IS NULL) AS land_pending,
            EXISTS(SELECT 1 FROM ship_request sr WHERE sr.xell_id=x.id
                     AND sr.status IN ('pending','approved','shipping') AND sr.dismissed_at IS NULL
                     AND sr.deferred_at IS NULL) AS ship_pending,
            EXISTS(SELECT 1 FROM prod_bind_request pbr WHERE pbr.xell_id=x.id
                     AND pbr.status='pending') AS prod_bind_pending,
            EXISTS(SELECT 1 FROM prod_seed_request psr WHERE psr.xell_id=x.id
                     AND psr.status IN ('pending','approved','running')
                     AND psr.dismissed_at IS NULL) AS seed_pending,
            EXISTS(SELECT 1 FROM done_suggestion ds WHERE ds.target_xell_id=x.id
                     AND ds.status='pending' AND ds.dismissed_at IS NULL) AS done_suggested,
            (SELECT se.hook_event_name FROM session_event se
               WHERE se.xell_id=x.id AND se.hook_event_name IN ('tend-request','tend-clear')
               ORDER BY se.ts DESC LIMIT 1) = 'tend-request' AS tend_pending,
            (SELECT se.hook_event_name FROM session_event se
               WHERE se.xell_id=x.id AND se.hook_event_name IN ('landhint-request','landhint-clear')
               ORDER BY se.ts DESC LIMIT 1) = 'landhint-request' AS land_hint,
            (SELECT se.hook_event_name FROM session_event se
               WHERE se.xell_id=x.id AND se.hook_event_name IN ('shiphint-request','shiphint-clear')
               ORDER BY se.ts DESC LIMIT 1) = 'shiphint-request' AS ship_hint
       FROM xell x
       LEFT JOIN LATERAL (
         SELECT * FROM zee zz WHERE zz.xell_id = x.id
          ORDER BY CASE WHEN zz.status IN ('spawning','online','working','idle') THEN 0 ELSE 1 END,
                   zz.created_at DESC LIMIT 1
       ) z ON true
      WHERE x.id = ANY($1::uuid[])`, [ids]);

  const map = new Map();
  for (const x of rows) {
    const key = hiveStatus(x, {
      landPending: x.land_pending === true,
      shipPending: x.ship_pending === true,
      tendPending: x.tend_pending === true,
      landHint: x.land_hint === true,
      shipHint: x.ship_hint === true,
      prodBindPending: x.prod_bind_pending === true,
      seedPending: x.seed_pending === true,
      doneSuggested: x.done_suggested === true,
    });
    map.set(x.id, {
      xell_id: x.id, slug: x.slug, status: x.status, branch: x.branch,
      zee_name: x.zee_name || null, zee_title: x.zee_title || null,
      hive_status: key, hive_status_label: hiveLabel(key),
    });
  }
  return map;
}

// ── reads ────────────────────────────────────────────────────────────────────

// Nest a flat list by parent_id, siblings ordered by sort_order then created_at. Items whose parent
// is not in the slice become roots of the returned forest, so a filtered read is never empty just
// because an ancestor was filtered out.
export function nestItems(items) {
  const byId = new Map(items.map((i) => [i.id, { ...i, children: [] }]));
  const roots = [];
  for (const i of byId.values()) {
    const parent = i.parent_id ? byId.get(i.parent_id) : null;
    (parent ? parent.children : roots).push(i);
  }
  const sort = (a, b) => (a.sort_order - b.sort_order) || (new Date(a.created_at) - new Date(b.created_at));
  const walk = (list) => { list.sort(sort); for (const i of list) walk(i.children); };
  walk(roots);
  return roots;
}

// Depth-first flatten of a nested forest (the order a gantt draws its rows in).
export function flattenTree(nodes, out = []) {
  for (const n of nodes) { out.push(n); flattenTree(n.children || [], out); }
  return out;
}

export async function listWorkItems({ projectId, status, kind, ticketId, rootId, tree } = {}) {
  const where = [];
  const params = [];
  const add = (sql, val) => { params.push(val); where.push(sql.replace('?', `$${params.length}`)); };
  if (projectId) add('project_id = ?', projectId);
  if (status) add(Array.isArray(status) ? 'status = ANY(?::work_status[])' : 'status = ?', status);
  if (kind) add(Array.isArray(kind) ? 'kind = ANY(?::work_item_kind[])' : 'kind = ?', kind);
  if (ticketId) add('ticket_id = ?', ticketId);
  if (rootId) {
    const root = await one(`SELECT id, path FROM work_item WHERE id=$1`, [rootId]);
    if (!root) return tree ? [] : [];
    params.push(root.id); params.push(`${subtreePrefix(root)}%`);
    where.push(`(id = $${params.length - 1} OR path LIKE $${params.length})`);
  }
  const rows = await q(
    `SELECT ${COLS} FROM work_item
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY depth, sort_order, created_at`, params);
  const items = rows.map(shapeItem);
  return tree ? nestItems(items) : items;
}

export async function getWorkItem(id) {
  const row = await one(`SELECT ${COLS} FROM work_item WHERE id=$1`, [id]);
  if (!row) return null;
  const item = shapeItem(row);

  const ancIds = item.ancestor_ids;
  const ancRows = ancIds.length
    ? await q(`SELECT ${COLS} FROM work_item WHERE id = ANY($1::uuid[])`, [ancIds])
    : [];
  // ordered by the PATH, not by whatever order postgres returned: the path IS the lineage
  const ancById = new Map(ancRows.map((a) => [a.id, shapeItem(a)]));
  const ancestors = ancIds.map((aid) => ancById.get(aid)).filter(Boolean);

  const children = (await q(
    `SELECT ${COLS} FROM work_item WHERE parent_id=$1 ORDER BY sort_order, created_at`, [id]
  )).map(shapeItem);

  const deps = (await q(
    `SELECT w.id, w.title, w.kind, w.status, w.due_on FROM work_item_dep d
       JOIN work_item w ON w.id = d.depends_on_id
      WHERE d.work_item_id=$1 ORDER BY w.sort_order, w.created_at`, [id]
  )).map((d) => ({ ...d, due_on: asDate(d.due_on), status_label: workLabel(d.status) }));
  const dependents = (await q(
    `SELECT w.id, w.title, w.kind, w.status, w.due_on FROM work_item_dep d
       JOIN work_item w ON w.id = d.work_item_id
      WHERE d.depends_on_id=$1 ORDER BY w.sort_order, w.created_at`, [id]
  )).map((d) => ({ ...d, due_on: asDate(d.due_on), status_label: workLabel(d.status) }));

  const ticket = item.ticket_id
    ? await one(`SELECT id, number, title, kind, status, priority FROM ticket WHERE id=$1`, [item.ticket_id])
    : null;

  const events = await q(
    `SELECT id, ts, kind, from_status, to_status, actor, detail FROM work_item_event
      WHERE work_item_id=$1 ORDER BY ts DESC, id DESC LIMIT 50`, [id]);

  const zee = item.xell_id ? (await liveZees([item.xell_id])).get(item.xell_id) || null : null;

  // The counts a UI warns with. open_children exists because closing a parent does NOT close its
  // children (see setStatus) — the read model says so out loud instead of the UI guessing.
  const counts = await one(
    `SELECT count(*)::int AS descendants,
            count(*) FILTER (WHERE status NOT IN ('done','cancelled'))::int AS open_descendants
       FROM work_item WHERE path LIKE $1`, [`${subtreePrefix(item)}%`]);
  const openChildren = children.filter((c) => !isTerminal(c.status)).length;

  return {
    ...item,
    ancestors,
    breadcrumb: ancestors.map((a) => a.title),
    children,
    open_children: openChildren,
    descendant_count: counts?.descendants ?? 0,
    open_descendant_count: counts?.open_descendants ?? 0,
    deps,
    dependents,
    ticket,
    events,
    zee,
    live_status: zee ? statusFromHive(zee.hive_status) : null,
  };
}

// ── writes ───────────────────────────────────────────────────────────────────

const EDITABLE = ['title', 'body', 'priority', 'assignee', 'starts_on', 'due_on',
                  'estimate_hours', 'progress', 'sort_order', 'xell_id', 'ticket_id', 'kind'];

// The next rank among a parent's children — a new item lands at the END of its column/branch.
async function nextSortOrder(parentId) {
  const r = await one(
    `SELECT coalesce(max(sort_order), 0) + 1000 AS n FROM work_item
      WHERE parent_id IS NOT DISTINCT FROM $1`, [parentId]);
  return Number(r?.n ?? 1000);
}

// The project's root item — the parent everything defaults to.
export async function projectRoot(projectId) {
  return one(`SELECT ${COLS} FROM work_item WHERE project_id=$1 AND kind='project'`, [projectId]);
}

export async function createWorkItem(input = {}) {
  const title = String(input.title || '').trim();
  if (!title) throw new Error('title required');
  const kind = input.kind || 'task';

  let parent = null;
  if (input.parent_id) {
    parent = await one(`SELECT ${COLS} FROM work_item WHERE id=$1`, [input.parent_id]);
    if (!parent) throw new Error(`parent_id ${input.parent_id} names no work item`);
  }
  const projectId = input.project_id || input.project || parent?.project_id;
  if (!projectId) throw new Error('project required (or a parent_id to inherit it from)');
  if (parent && parent.project_id !== projectId) {
    throw new Error('a work item must live in the same project as its parent');
  }
  // No explicit parent and not a project root → the project's root item. The database would do this
  // itself (migration 058), but resolving it here means sort_order is computed among the right
  // siblings rather than among the roots.
  if (!parent && kind !== 'project') {
    parent = await projectRoot(projectId);
    if (!parent) throw new Error(`project ${projectId} has no root work item — cannot attach "${title}"`);
  }
  if (input.status && !isWorkStatus(input.status)) throw new Error(`unknown status "${input.status}"`);

  const sortOrder = input.sort_order != null ? Number(input.sort_order) : await nextSortOrder(parent?.id ?? null);
  const row = await one(
    `INSERT INTO work_item (project_id, parent_id, kind, title, body, status, priority, ticket_id,
                            xell_id, assignee, starts_on, due_on, estimate_hours, progress,
                            sort_order, created_by)
     VALUES ($1,$2,$3,$4,$5,coalesce($6::work_status,'queued'),coalesce($7::int,3),$8,$9,$10,
             $11::date,$12::date,$13::numeric,coalesce($14::int,0),$15,$16)
     RETURNING ${COLS}`,
    [projectId, parent?.id ?? null, kind, title, input.body ?? null, input.status ?? null,
     input.priority ?? null, input.ticket_id ?? null, input.xell_id ?? null, input.assignee ?? null,
     input.starts_on ?? null, input.due_on ?? null, input.estimate_hours ?? null,
     input.progress ?? null, sortOrder, input.actor || input.created_by || null]);

  await emit(row, 'created', { to: row.status, actor: input.actor || input.created_by || null,
                               detail: { kind: row.kind, title: row.title, parent_id: row.parent_id } });
  return shapeItem(row);
}

export async function updateWorkItem(id, patch = {}, { actor = null } = {}) {
  const before = await one(`SELECT ${COLS} FROM work_item WHERE id=$1`, [id]);
  if (!before) return null;

  // A parent_id (or an explicit reparent) in a PATCH is a MOVE — it rewrites the path of every
  // descendant, so it goes through the move path and gets its own 'moved' event.
  let current = before;
  if ('parent_id' in patch && patch.parent_id !== before.parent_id) {
    current = await moveWorkItem(id, { parent_id: patch.parent_id, sort_order: patch.sort_order }, { actor });
  }
  // Status is validated against nextStatuses and gets its own 'status' event.
  if ('status' in patch && patch.status !== before.status) {
    current = await setStatus(id, patch.status, { actor });
  }

  const sets = [];
  const params = [id];
  const changed = {};
  for (const f of EDITABLE) {
    if (!(f in patch)) continue;
    if (f === 'sort_order' && 'parent_id' in patch) continue;   // the move already placed it
    params.push(patch[f] === '' ? null : patch[f]);
    sets.push(`${f} = $${params.length}`);
    changed[f] = patch[f];
  }
  if (!sets.length) return shapeItem(current);

  const row = await one(`UPDATE work_item SET ${sets.join(', ')} WHERE id=$1 RETURNING ${COLS}`, params);
  // Naming a zee (or un-naming one) is its own kind of event: part 2 and the console both want to
  // read "when was a zee put on this" without parsing an edit diff.
  const kind = 'xell_id' in changed || 'assignee' in changed ? 'assigned' : 'edited';
  await emit(row, kind, { actor, detail: changed });
  return shapeItem(row);
}

// A MOVE: a new parent and/or a new rank among siblings. The database enforces same-project,
// the nesting rank and cycles, and rewrites path/depth for the whole subtree; here we only turn
// its refusal into a sentence and record the event.
export async function moveWorkItem(id, { parent_id: parentId, sort_order: sortOrder } = {}, { actor = null } = {}) {
  const before = await one(`SELECT ${COLS} FROM work_item WHERE id=$1`, [id]);
  if (!before) return null;
  if (before.kind === 'project') {
    throw new Error(`"${before.title}" is the project's root item — it is the top of the tree and cannot be moved under anything.`);
  }
  const nextParent = parentId === undefined ? before.parent_id : (parentId || null);
  const rank = sortOrder != null ? Number(sortOrder)
    : (nextParent === before.parent_id ? Number(before.sort_order) : await nextSortOrder(nextParent));

  const row = await one(
    `UPDATE work_item SET parent_id=$2, sort_order=$3 WHERE id=$1 RETURNING ${COLS}`,
    [id, nextParent, rank]);
  await emit(row, 'moved', { actor, detail: { from_parent: before.parent_id, to_parent: row.parent_id,
                                              from_sort: Number(before.sort_order), to_sort: Number(row.sort_order) } });
  return shapeItem(row);
}

// setStatus validates the transition against work-status.js (the SAME table the vocabulary endpoint
// serves) and writes a 'status' event carrying both ends of it.
//
// `cascade` is OPT-IN and never implied. Marking a parent done does NOT close its children: a
// tracker that auto-closes has, at some point, closed real open work on somebody's behalf. The read
// models expose open_children instead, so a UI can warn ("3 children still open — close them too?")
// and the human answers.
export async function setStatus(id, status, { actor = null, cascade = false } = {}) {
  const before = await one(`SELECT ${COLS} FROM work_item WHERE id=$1`, [id]);
  if (!before) return null;
  if (!isWorkStatus(status)) {
    throw new Error(`unknown status "${status}" — one of: ${WORK_STATUS_KEYS.join(', ')}`);
  }
  if (!canTransition(before.status, status)) {
    throw new Error(`cannot move "${before.title}" from ${before.status} to ${status}`
      + ` — legal next statuses are: ${nextStatuses(before.status).join(', ')}`);
  }
  const row = await one(`UPDATE work_item SET status=$2 WHERE id=$1 RETURNING ${COLS}`, [id, status]);
  await emit(row, 'status', { from: before.status, to: status, actor });

  let cascaded = 0;
  if (cascade) {
    const kids = await q(
      `SELECT id, status FROM work_item WHERE path LIKE $1 AND status <> $2`,
      [`${subtreePrefix(before)}%`, status]);
    for (const k of kids) {
      if (!canTransition(k.status, status)) continue;
      const r = await one(`UPDATE work_item SET status=$2 WHERE id=$1 RETURNING ${COLS}`, [k.id, status]);
      await emit(r, 'status', { from: k.status, to: status, actor, detail: { cascaded_from: id } });
      cascaded++;
    }
  }
  const shaped = shapeItem(row);
  shaped.cascaded = cascaded;
  return shaped;
}

// Deleting cascades in the database (parent_id ON DELETE CASCADE), so the ANSWER says how many rows
// went with it — a delete that silently takes eleven descendants is the one destructive act in this
// module, and the caller is told the number before and after.
export async function deleteWorkItem(id) {
  const item = await one(`SELECT ${COLS} FROM work_item WHERE id=$1`, [id]);
  if (!item) return null;
  if (item.kind === 'project') {
    throw new Error(`"${item.title}" is the root item of its project and cannot be deleted — every `
      + 'other work item hangs off it, and the project row itself owns it (delete the project to '
      + 'delete the tree).');
  }
  const counts = await one(
    `SELECT count(*)::int AS n FROM work_item WHERE path LIKE $1`, [`${subtreePrefix(item)}%`]);
  await q(`DELETE FROM work_item WHERE id=$1`, [id]);
  broadcast('work', { kind: 'deleted', item: shapeItem(item), descendants: counts?.n ?? 0 });
  return { ok: true, deleted: shapeItem(item), descendants: counts?.n ?? 0 };
}

// ── dependencies ─────────────────────────────────────────────────────────────
export async function addDep(workItemId, dependsOnId, { actor = null } = {}) {
  if (!dependsOnId) throw new Error('depends_on_id required');
  const row = await one(
    `INSERT INTO work_item_dep (work_item_id, depends_on_id) VALUES ($1,$2)
     ON CONFLICT DO NOTHING RETURNING *`, [workItemId, dependsOnId]);
  await logWorkEvent(workItemId, 'edited', { actor, detail: { added_dep: dependsOnId } });
  const item = await one(`SELECT ${COLS} FROM work_item WHERE id=$1`, [workItemId]);
  broadcast('work', { kind: 'dep', item: shapeItem(item) });
  return { ok: true, dep: row || { work_item_id: workItemId, depends_on_id: dependsOnId, existing: true } };
}

export async function removeDep(workItemId, dependsOnId, { actor = null } = {}) {
  const rows = await q(
    `DELETE FROM work_item_dep WHERE work_item_id=$1 AND depends_on_id=$2 RETURNING *`,
    [workItemId, dependsOnId]);
  if (!rows.length) return null;
  await logWorkEvent(workItemId, 'edited', { actor, detail: { removed_dep: dependsOnId } });
  const item = await one(`SELECT ${COLS} FROM work_item WHERE id=$1`, [workItemId]);
  broadcast('work', { kind: 'dep', item: shapeItem(item) });
  return { ok: true, removed: rows[0] };
}

// ── the BOARD read model ─────────────────────────────────────────────────────
//
// One column per work_status, in the vocabulary's own order, so the console never invents a column
// list. A card's COLUMN is its STORED status; `live_status` is what the zee on it appears to be
// doing right now (statusFromHive) and is advisory only — the UI renders it as a hint, and nothing
// here ever writes it back. That separation is the whole point: a zee going idle for a minute must
// not silently drag somebody's card into another column.
export async function boardModel({ projectId, rootId } = {}) {
  let root = null;
  if (rootId) root = await one(`SELECT ${COLS} FROM work_item WHERE id=$1`, [rootId]);
  else if (projectId) root = await projectRoot(projectId);
  if (!root && !projectId) throw new Error('project or root required');

  const params = [];
  let where = '';
  if (root) {
    params.push(`${subtreePrefix(root)}%`);
    where = `WHERE path LIKE $1`;                    // the subtree, excluding the root itself
  } else {
    params.push(projectId);
    where = `WHERE project_id = $1 AND kind <> 'project'`;
  }
  const rows = (await q(`SELECT ${COLS} FROM work_item ${where} ORDER BY sort_order, created_at`, params))
    .map(shapeItem);

  // one batched read for every zee on the board, and one for every ticket referenced
  const zees = await liveZees(rows.map((r) => r.xell_id));
  const ticketIds = [...new Set(rows.map((r) => r.ticket_id).filter(Boolean))];
  const tickets = ticketIds.length
    ? new Map((await q(`SELECT id, number, title, kind, status FROM ticket WHERE id = ANY($1::uuid[])`, [ticketIds]))
        .map((t) => [t.id, t]))
    : new Map();

  // breadcrumbs come from the PATH, so they cost one read of the ancestors, not one per card
  const ancIds = [...new Set(rows.flatMap((r) => r.ancestor_ids))];
  const titles = ancIds.length
    ? new Map((await q(`SELECT id, title FROM work_item WHERE id = ANY($1::uuid[])`, [ancIds]))
        .map((a) => [a.id, a.title]))
    : new Map();

  const openBySubtree = new Map();   // how many open descendants each card still has
  const counts = await q(
    `SELECT parent_id, count(*) FILTER (WHERE status NOT IN ('done','cancelled'))::int AS open
       FROM work_item WHERE parent_id = ANY($1::uuid[]) GROUP BY parent_id`,
    [rows.map((r) => r.id)]);
  for (const c of counts) openBySubtree.set(c.parent_id, c.open);

  const card = (r) => {
    const zee = r.xell_id ? zees.get(r.xell_id) || null : null;
    return {
      id: r.id, project_id: r.project_id, parent_id: r.parent_id, kind: r.kind, title: r.title,
      status: r.status, status_label: r.status_label, priority: r.priority, progress: r.progress,
      sort_order: r.sort_order, depth: r.depth, assignee: r.assignee,
      starts_on: r.starts_on, due_on: r.due_on,
      breadcrumb: r.ancestor_ids.map((a) => titles.get(a)).filter(Boolean),
      ticket: r.ticket_id
        ? (tickets.get(r.ticket_id) ? { id: r.ticket_id, number: tickets.get(r.ticket_id).number,
                                        title: tickets.get(r.ticket_id).title } : { id: r.ticket_id })
        : null,
      zee: zee ? { slug: zee.slug, hive_status: zee.hive_status, hive_status_label: zee.hive_status_label } : null,
      live_status: zee ? statusFromHive(zee.hive_status) : null,
      open_children: openBySubtree.get(r.id) || 0,
    };
  };

  const columns = WORK_STATUS_KEYS.map((key) => ({
    key, label: WORK_STATUS[key].label, order: WORK_STATUS[key].order, terminal: WORK_STATUS[key].terminal,
    items: rows.filter((r) => r.status === key).map(card),
  })).sort((a, b) => a.order - b.order);

  return { root: root ? shapeItem(root) : null, project_id: projectId || root?.project_id || null,
           columns, total: rows.length };
}

// ── the GANTT read model ─────────────────────────────────────────────────────
//
// Rows in TREE order (depth-first by sort_order), each with the dates it will actually be DRAWN at.
// The roll-up rules, and why they are read-only:
//
//   computed_start/computed_end — a parent with no explicit dates spans min(children start) …
//     max(children end). A parent WITH its own dates keeps them: someone stated them on purpose.
//   rolled_progress — a parent with no explicit progress (0) is the child-count-weighted average of
//     its children's rolled progress, so a branch with nine subtasks outweighs a branch with one.
//   unscheduled — a row with no dates anywhere in its subtree comes back with nulls and this flag.
//     The UI LISTS those; it does not invent dates for them. An invented date is indistinguishable
//     from a real one the moment it is on screen.
export async function ganttModel({ projectId, rootId } = {}) {
  let root = null;
  if (rootId) root = await one(`SELECT ${COLS} FROM work_item WHERE id=$1`, [rootId]);
  else if (projectId) root = await projectRoot(projectId);
  if (!root && !projectId) throw new Error('project or root required');

  const params = [];
  let where;
  if (root) { params.push(root.id, `${subtreePrefix(root)}%`); where = `WHERE id=$1 OR path LIKE $2`; }
  else { params.push(projectId); where = `WHERE project_id=$1`; }
  const rows = (await q(`SELECT ${COLS} FROM work_item ${where} ORDER BY depth, sort_order, created_at`, params))
    .map(shapeItem);

  const deps = rows.length
    ? await q(`SELECT work_item_id, depends_on_id FROM work_item_dep
                WHERE work_item_id = ANY($1::uuid[])`, [rows.map((r) => r.id)])
    : [];
  const depsBy = new Map();
  for (const d of deps) {
    if (!depsBy.has(d.work_item_id)) depsBy.set(d.work_item_id, []);
    depsBy.get(d.work_item_id).push(d.depends_on_id);
  }

  const forest = nestItems(rows);
  const ordered = flattenTree(forest);

  // post-order roll-up: children first, so a parent can read its children's computed values
  const min = (a, b) => (!a ? b : (!b ? a : (a < b ? a : b)));
  const max = (a, b) => (!a ? b : (!b ? a : (a > b ? a : b)));
  const roll = (node) => {
    let start = node.starts_on || null;
    let end = node.due_on || null;
    let weight = 0;
    let acc = 0;
    let leaves = 0;
    for (const c of node.children || []) {
      const r = roll(c);
      if (!node.starts_on) start = min(start, r.computed_start);
      if (!node.due_on) end = max(end, r.computed_end);
      acc += r.rolled_progress * r.weight;
      weight += r.weight;
      leaves += r.leaves;
    }
    node.computed_start = start;
    node.computed_end = end;
    node.rolled_progress = (node.progress > 0 || !(node.children || []).length || !weight)
      ? node.progress
      : Math.round(acc / weight);
    node.unscheduled = !start && !end;
    node.weight = (node.children || []).length ? weight : 1;
    node.leaves = (node.children || []).length ? leaves : 1;
    return node;
  };
  for (const r of forest) roll(r);

  return {
    root: root ? shapeItem(root) : null,
    project_id: projectId || root?.project_id || null,
    rows: ordered.map((n) => ({
      id: n.id, parent_id: n.parent_id, depth: n.depth, kind: n.kind, title: n.title,
      status: n.status, status_label: n.status_label,
      starts_on: n.starts_on, due_on: n.due_on,
      computed_start: n.computed_start || null, computed_end: n.computed_end || null,
      progress: n.progress, rolled_progress: n.rolled_progress,
      estimate_hours: n.estimate_hours, assignee: n.assignee, xell_id: n.xell_id,
      unscheduled: n.unscheduled === true,
      deps: depsBy.get(n.id) || [],
    })),
    unscheduled_count: ordered.filter((n) => n.unscheduled).length,
  };
}
