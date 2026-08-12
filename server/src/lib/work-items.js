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
//   • every mutation ENDS with broadcast('work', …), so the console's SSE stream (/api/stream)
//     pushes it without a poll, and every mutation that leaves a SURVIVING row also appends a
//     work_item_event so "who moved this, when" always has an answer. DELETE is the one exception,
//     and not by omission: work_item_event.work_item_id is ON DELETE CASCADE, so an event written
//     for a deleted item would be deleted along with it. The delete is announced on the bus only.
//     Two vocabularies therefore exist and must not be conflated — see the note above emit().
//   • roll-ups (a parent's dates, a parent's progress) are a READ-MODEL concern and are never
//     written back. A stored roll-up is a cache that goes stale the first time anyone edits a leaf,
//     and this repo has no place to invalidate it.
import { q as rawQ, one as rawOne, pool } from '../db/pool.js';
import { broadcast } from './events.js';
import { hiveStatus, hiveLabel } from './hive-status.js';
import { syncWorkNode, removeWorkNode, syncDependency, removeDependency, syncExecutionState } from './work-node-sync.js';
import {
  WORK_STATUS_KEYS, WORK_STATUS, WORK_ITEM_KINDS, workLabel, isWorkStatus, canTransition,
  nextStatuses, statusFromHive, isTerminal,
} from './work-status.js';
// REHAB 2/4 — the workflow model is the source of truth for the PLAN SHAPE (tree, order, deps,
// actuals). work_item is still WRITTEN by the dual-write and still supplies the API's identity +
// the fields the model does not carry (see work-item-model.js's header for the exact split).
import { modelRootForProject, modelTree, modelDepsForItems, modelActualsForItems, modelExecutionsForItems,
         modelAncestorsForWorkItem } from './work-item-model.js';

// ── how a refusal becomes an HTTP STATUS ─────────────────────────────────────
//
// The status is carried ON THE ERROR, never inferred from its text.
//
// The first cut of this classified by REGEX-MATCHING the message ("cannot", "cycle", "root item"…),
// which quietly made every refusal sentence load-bearing prose: reword one and its HTTP status flips
// with nothing to catch it — no test fails, no log line appears, and every client that branches on
// 409-vs-400 is simply wrong from then on. That is the worst failure shape there is, so the wording
// and the status are now independent. lib/work-assign.js already did it this way; this is part 1
// adopting its own follow-up.
//
// 400 you asked wrong · 404 it does not exist · 409 it exists and the answer is still no.
export const httpError = (status, message) => Object.assign(new Error(message), { status });
export const bad = (m) => httpError(400, m);
export const notFound = (m) => httpError(404, m);
export const refuse = (m) => httpError(409, m);

// What the route layer answers with. Reads the tag; falls back to 400 (you asked wrong) for anything
// untagged. Deliberately NOT a text match — see above.
export function httpStatusOf(err) {
  const s = Number(err?.status);
  return s >= 400 && s <= 599 ? s : 400;
}

// A postgres error becomes a status by its CODE, which is a fact, not by its message, which is prose.
// P0001 is a plpgsql RAISE EXCEPTION — i.e. one of migration 058's own guard triggers (the nesting
// rank, a cross-project parent, a cycle, a self/cross-project dependency). Every one of those is
// "the tree says no", so 409. Anything else keeps whatever it had and falls through to 400, exactly
// as it did before this change.
function pgStatus(err) {
  if (err && !err.status && err.code === 'P0001') err.status = 409;
  return err;
}
// Every database call in this module goes through these, so a trigger refusal is tagged once, here,
// rather than at a dozen call sites that would each have to remember.
const withStatus = (fn) => async (...args) => { try { return await fn(...args); } catch (e) { throw pgStatus(e); } };
const q = withStatus(rawQ);
const one = withStatus(rawOne);

// ── small shapers ────────────────────────────────────────────────────────────

const pad = (n) => String(n).padStart(2, '0');
// node-pg parses a DATE column into a local-midnight Date. Read the LOCAL components back out and
// the day survives; toISOString() would shift it by the host's UTC offset, which is how trackers
// end up showing a task starting the day before it starts.
//
// The YEAR is padded to four digits too. postgres will happily store '0001-01-01', and an unpadded
// year handed a client '1-01-01' — which is not ISO 8601, so Date.parse gives NaN or a silently
// different day depending on the runtime. If an absurd date is stored we return it faithfully; we
// just return it in a format that parses.
const asDate = (v) => (v instanceof Date
  ? `${String(v.getFullYear()).padStart(4, '0')}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`
  : (v ?? null));

// A TIMESTAMPTZ column (actual_start / actual_end) → ISO 8601 on the wire. Unlike asDate, the
// instant is absolute — node-pg hands it to us as a Date and toISOString() is the one format every
// client parses without a timezone guess.
const asTs = (v) => (v instanceof Date ? v.toISOString() : (v ?? null));

// The UTC DAY of a timestamptz, as YYYY-MM-DD. Used where the chart needs a DATE (the extent, the
// span) rather than the instant: spanDays() insists on a whole-string date (its regex is $-anchored
// on purpose), so a raw ISO timestamp fed to it reads as unparseable and the extent silently becomes
// null — exactly the bug a chart with only actual bars would hit.
const tsDay = (v) => (v instanceof Date
  ? `${String(v.getUTCFullYear()).padStart(4, '0')}-${pad(v.getUTCMonth() + 1)}-${pad(v.getUTCDate())}`
  : (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null));

// Whole days from one YYYY-MM-DD to another, INCLUSIVE (a task starting and ending the same day is
// 1 day, not 0). Parsed as UTC so a DST boundary cannot add or drop a day. Null unless both ends
// are present and parse.
export function spanDays(startStr, endStr) {
  if (!startStr || !endStr) return null;
  const ms = (s) => {
    const m = /^(-?\d{1,6})-(\d{2})-(\d{2})$/.exec(String(s));
    return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : NaN;
  };
  const a = ms(startStr);
  const b = ms(endStr);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86400000) + 1;
}

// A work item may not finish before it starts. Enforced in the DATABASE by migration 060
// (work_item_dates_ordered) — this is the same rule stated FIRST so the caller gets a sentence
// instead of `new row for relation "work_item" violates check constraint "work_item_dates_ordered"`.
//
// NOTE the wording is load-bearing: routes.js sorts refusals into 400 vs 409 by matching the
// message, and an inverted pair is bad INPUT (400), not a conflict with the state of the tree
// (409). Keep it free of the 409 words — "cannot", "refused", "cycle", "root item" and friends.
// Nothing here bounds how FAR apart the dates may be: '0001-01-01' → '9999-12-31' is legal, ordered
// and absurd, and clamping the window is the renderer's call, not the server's (see ganttModel).
function assertSchedule(startsOn, dueOn, what = 'this work item') {
  const s = asDate(startsOn);
  const d = asDate(dueOn);
  if (!s || !d) return;
  if (spanDays(s, d) === null) return;        // unparseable — let postgres have the last word
  if (d < s) {
    throw bad(`"${what}": due_on ${d} is before starts_on ${s} — a work item may not finish `
      + 'before it starts. Give due_on on or after starts_on, or leave it empty for "no end yet".');
  }
}
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
    actual_start: asTs(row.actual_start),
    actual_end: asTs(row.actual_end),
    estimate_hours: asNum(row.estimate_hours),
    sort_order: asNum(row.sort_order),
    ancestor_ids: ancestorIds(row.path),
    status_label: workLabel(row.status),
    next_statuses: nextStatuses(row.status),
  };
}

// REHAB 2/4 — shape a MODEL TREE row (work-node.js modelTree) as the API's work item. The tree's
// parentage and depth come from the MODEL (the parent node's stable_key → parent work_item id, and
// the recursive walk); the work_item columns ride along as the attribute store.
function shapeModelItem(row) {
  if (!row || !row.id) return null;                       // a foreign node (no work_item) is not a tracker item
  return shapeItem({ ...row, parent_id: row.model_parent_item_id ?? row.parent_id, depth: row.model_depth - 1 });
}

// ── ids ──────────────────────────────────────────────────────────────────────
//
// Postgres answers a malformed uuid with `invalid input syntax for type uuid: "not-a-uuid"`. That
// is a database's sentence, not a person's, and it reaches the caller as a 400 that names neither
// WHICH id was wrong nor what it was for — while a valid-but-unknown id correctly 404s. Two
// different mistakes deserve two different answers, so every id is checked before it reaches a
// query: malformed → 400 with this sentence, unknown → 404 from the row read.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(v) { return typeof v === 'string' && UUID_RE.test(v); }
export function assertId(v, what = 'work item id') {
  if (!isUuid(v)) throw bad(`"${v ?? ''}" is not a valid ${what}`);
  return v;
}

const COLS = `id, project_id, parent_id, kind, title, body, status, priority, ticket_id, xell_id,
              assignee, starts_on, due_on, estimate_hours, progress, sort_order, path, depth,
              created_by, created_at, updated_at, closed_at, actual_start, actual_end`;

// ── running inside somebody else's transaction ───────────────────────────────
//
// Most writes here are one statement and need nothing. A BREAKDOWN is not: it creates a whole tree
// and then re-points the ticket at it, and half a plan is worse than none — a manager who asked for
// six items and got four, with no error path back to a clean state, has to work out by hand which
// two are missing. Everything else irreversible in this repo is all-or-nothing (a landing is one
// sha, a seed runs in its own transaction, a ship succeeds or does not), so this is too.
//
// The mechanism is deliberately small: every function that may take part accepts an optional
// `client` (a checked-out pg client already inside BEGIN) and routes its reads and writes through
// this runner instead of the pool. No client → the pool, exactly as before.
export const dbRunner = (client) => (client
  ? {
    q: withStatus(async (text, params) => (await client.query(text, params)).rows),
    one: withStatus(async (text, params) => (await client.query(text, params)).rows[0] || null),
  }
  : { q, one });

// Run fn inside ONE transaction, handing it the client. Broadcasts are collected rather than sent:
// announcing a row on the SSE bus and then rolling it back would paint a card the database does not
// have. They go out only after the COMMIT lands.
export async function inTransaction(fn) {
  const client = await pool.connect();
  const pending = [];
  try {
    await client.query('BEGIN');
    const out = await fn({ client, pending });
    await client.query('COMMIT');
    for (const [type, payload] of pending) broadcast(type, payload);
    return out;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* the connection is what failed */ }
    throw err;                       // nothing was created, and nothing was announced
  } finally {
    client.release();
  }
}

// ── the audit trail ──────────────────────────────────────────────────────────
// kind: created | status | moved | assigned | edited | comment
export async function logWorkEvent(workItemId, kind, { from = null, to = null, actor = null, detail = null } = {}, { client = null } = {}) {
  return dbRunner(client).one(
    `INSERT INTO work_item_event (work_item_id, kind, from_status, to_status, actor, detail)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [workItemId, kind, from, to, actor || null, detail ? JSON.stringify(detail) : null]);
}

// Every surviving-row mutation goes out the same door: the row on the SSE bus, an event row in the
// ledger. TWO VOCABULARIES, deliberately not merged:
//
//   work_item_event.kind  created | status | moved | assigned | edited | comment   (the ledger)
//   broadcast kind        the six above, PLUS deleted and dep, PLUS the ticket-* kinds
//
// 'deleted' and 'dep' are bus-only (there is no surviving row to hang a 'deleted' event on, and a
// dependency edit is recorded against the item as an 'edited' event); 'comment' is ledger-only.
// A consumer that assumes one list covers both will wait forever for a 'deleted' event.
async function emit(row, kind, opts = {}, { client = null, pending = null } = {}) {
  if (!row) return row;
  await logWorkEvent(row.id, kind, opts, { client });
  const event = ['work', { kind, item: shapeItem(row) }];
  if (pending) pending.push(event); else broadcast(...event);
  return row;
}

// ── the live zee on an item ──────────────────────────────────────────────────
//
// A work item may name the xell whose zee is on it. The card wants the SAME words the hexagon uses,
// so the hive status is derived by lib/hive-status.js — the one source of truth — from the same live
// signals fleet.js folds into its row read (a held landing, a tend, a hint…). Batched: a board of
// eighty cards must not cost eighty queries.
//
// ONLY A LIVE XELL COUNTS. work_item.xell_id is a DURABLE record of the last assignment, but a xell
// dies long before the work does: reapXell never deletes the row, it sets status='retired' (so the
// ON DELETE SET NULL on the column essentially never fires) — and the item was left pointing at a
// corpse that still answered. A reaped xell reported hive_status 'occ-claimed' (the unclassified
// fallback) and therefore live_status 'assigned'; if it had been reaped with a landing still
// undecided it read 'occ-landRequest' → 'review', because the reaper releases open SHIPS
// (releaseXellShips) but never land requests. Either way a board card claimed an agent was on work
// whose agent had been gone for a week.
//
// The fix is here, at READ time, and deliberately not a release hook in the reap path: a hook is a
// cache invalidation and it WILL be missed — purgeDevXells reaps in bulk, recoverOrphanTeardowns
// finishes reaps a dead queenzee left half-done, and a human can update a row by hand. A WHERE
// clause cannot be bypassed by a path nobody has written yet. The three excluded statuses are the
// ones hive-status.js itself classifies as gone ('retired') or VACANT ('husk'/'error' → vac-dirty):
// no zee occupies any of them, so none of them may lend a work item a zee OR a signal.
//
// A dead xell therefore resolves to NO ENTRY: callers see `zee: null`, `live_status: null`. The
// xell_id stays on the row as history — building a `last_zee` / "was:" affordance from it plus the
// work_item_event ledger is part 2/3's read model, not this one's.
const LIVE_XELL_STATUSES = `x.status NOT IN ('retired','husk','error')`;

export async function liveZees(xellIds) {
  const ids = [...new Set((xellIds || []).filter(Boolean))];
  if (!ids.length) return new Map();
  const rows = await q(
    `SELECT x.id, x.slug, x.status, x.is_production, x.branch,
            z.status AS zee_status, z.cli_active, z.name AS zee_name, z.title AS zee_title,
            EXISTS(SELECT 1 FROM land_request lr WHERE lr.xell_id=x.id
                     AND lr.status IN ('pending','approved') AND lr.dismissed_at IS NULL) AS land_pending,
            -- queued for the runway (067) — see fleet.js for why this is not land_pending
            EXISTS(SELECT 1 FROM land_request lh WHERE lh.xell_id=x.id
                     AND lh.status='holding' AND lh.cleared_at IS NULL) AS land_holding,
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
      WHERE x.id = ANY($1::uuid[]) AND ${LIVE_XELL_STATUSES}`, [ids]);

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
      landHolding: x.land_holding === true,
    });
    // Belt AND braces. The WHERE clause above is what actually keeps dead xells out; this second
    // check catches the case it cannot see — a status hive-status.js declines to speak for (it
    // answers null rather than let its 'occ-claimed' fallback invent one). If there is no honest
    // hive word for this row, there is no honest zee to hand a card either.
    if (!key) continue;
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

// Filter values are checked before they reach a query for the same reason ids are: an unknown
// ?status= must read as "unknown status" and not as a postgres enum cast failure.
function assertFilters({ status, kind }) {
  for (const s of [].concat(status || [])) {
    if (!isWorkStatus(s)) throw bad(`unknown status "${s}" — one of: ${WORK_STATUS_KEYS.join(', ')}`);
  }
  for (const k of [].concat(kind || [])) {
    if (!WORK_ITEM_KINDS.includes(k)) throw bad(`unknown work item kind "${k}" — one of: ${WORK_ITEM_KINDS.join(', ')}`);
  }
}

// REHAB 2/4 — re-pointed at the MODEL. The rows come from the work_node tree (modelTree), the order
// from the model's sibling_rank, and the filters still apply to the work_item attribute columns
// (status/kind/ticket are tracker nouns the model does not carry). Ordering is (model depth,
// work_item sort_order, created_at) — the same flat order the pre-rehab reader produced, with the
// model's depth standing in for the legacy stored depth.
export async function listWorkItems({ projectId, status, kind, ticketId, rootId, tree } = {}) {
  if (projectId) assertId(projectId, 'project id');
  if (ticketId) assertId(ticketId, 'ticket id');
  if (rootId) assertId(rootId, 'work item id');
  assertFilters({ status, kind });
  if (!projectId && !rootId) {
    // Unscoped (lists every work item in the fleet): the model's nodes span many plans, so fall
    // back to the legacy flat read for this rare call — the board/drawer routes always scope.
    return listWorkItemsLegacyUnscoped({ status, kind, ticketId, tree });
  }

  // The MODEL tree is the source: rootId → that item's subtree (including it); projectId → the
  // project's whole tree (the flat list INCLUDES the root — the pre-rehab read did).
  const rows = rootId
    ? await modelTree({ rootItemId: rootId })
    : await modelTree({ projectId });
  if (!rows.length) return tree ? [] : [];

  const seen = new Set();
  const items = [];
  for (const r of rows) {
    if (!r.id) continue;                                  // a foreign node is not a tracker item
    if (status && !(Array.isArray(status) ? status.includes(r.status) : r.status === status)) continue;
    if (kind && !(Array.isArray(kind) ? kind.includes(r.kind) : r.kind === kind)) continue;
    if (ticketId && r.ticket_id !== ticketId) continue;
    if (seen.has(r.id)) continue;                          // a node appears once even across plan versions
    seen.add(r.id);
    items.push(shapeModelItem(r));
  }
  // Flat order: model depth, then the tracker's sort_order (the rank the model encodes, surfaced
  // as the number the console drags), then created_at — byte-identical to the pre-rehab reader.
  items.sort((a, b) => (a.depth - b.depth)
    || ((a.sort_order ?? 0) - (b.sort_order ?? 0))
    || (new Date(a.created_at) - new Date(b.created_at)));
  return tree ? nestItems(items) : items;
}

// The unscoped flat read (no project, no root): every work_item in the fleet, legacy-shaped. This
// is the one listWorkItems call the model cannot drive (a work_node belongs to a plan; "every plan"
// is not a tree), and it was already a rare administrative read — the routes always scope.
async function listWorkItemsLegacyUnscoped({ status, kind, ticketId, tree } = {}) {
  const where = [];
  const params = [];
  const add = (sql, val) => { params.push(val); where.push(sql.replace('?', `$${params.length}`)); };
  if (status) add(Array.isArray(status) ? 'status = ANY(?::work_status[])' : 'status = ?', status);
  if (kind) add(Array.isArray(kind) ? 'kind = ANY(?::work_item_kind[])' : 'kind = ?', kind);
  if (ticketId) add('ticket_id = ?', ticketId);
  const rows = await q(
    `SELECT ${COLS} FROM work_item
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY depth, sort_order, created_at`, params);
  const items = rows.map(shapeItem);
  return tree ? nestItems(items) : items;
}

export async function getWorkItem(id) {
  assertId(id);
  // REHAB 2/4 — the item and its subtree come from the MODEL tree; the ancestors from the model's
  // parent chain; the deps from the dependency table; the counts from the model subtree. The ticket
  // and events are still the tracker's own ledgers (the model has no ticket link and the rehab does
  // not write the model's append-only event table), and the exact stored status still comes from
  // work_item.status (see model-status.js — the run plane cannot tell review from shipping).
  const tree = await modelTree({ rootItemId: id });
  const row = tree.find((r) => r.model_depth === 1) || null;
  if (!row || !row.id) return null;
  const item = shapeModelItem(row);

  // actuals from the RUN PLANE (execution), the same preference the gantt uses: the run plane is
  // where "when did this RAN" lives after rehab 2/4. Fall back to the legacy work_item actuals when
  // the execution has none (a reopened item whose finished_at was cleared — see ganttModel).
  const [actual] = [...(await modelActualsForItems([id]).then((m) => [m.get(id)]))];
  if (actual) {
    item.actual_start = actual.start || item.actual_start || null;
    item.actual_end = actual.end || item.actual_end || null;
  }

  // modelAncestorsForWorkItem returns NEAREST-first; the API's ancestors/breadcrumb are oldest-first.
  const ancestors = (await modelAncestorsForWorkItem(id)).reverse().map(shapeItem);
  // The item's global depth = how many ancestors it has (the model walk starts at the item itself,
  // so the subtree-local depth 0 is not its place in the project tree).
  item.depth = ancestors.length;

  const children = tree
    .filter((r) => r.model_depth === 2 && r.id)
    .map(shapeModelItem)
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)
      || (new Date(a.created_at) - new Date(b.created_at)));

  const { depsBy, dependentsBy } = await modelDepsForItems([id]);
  const depIds = depsBy.get(id) || [];
  const depRows = depIds.length
    ? await q(`SELECT id, title, kind, status, due_on, sort_order, created_at FROM work_item WHERE id = ANY($1::uuid[])`, [depIds])
    : [];
  const deps = depRows
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)
      || (new Date(a.created_at) - new Date(b.created_at)))
    .map((d) => ({ id: d.id, title: d.title, kind: d.kind, status: d.status,
                   due_on: asDate(d.due_on), status_label: workLabel(d.status) }));
  const dependentIds = dependentsBy.get(id) || [];
  const dependentRows = dependentIds.length
    ? await q(`SELECT id, title, kind, status, due_on, sort_order, created_at FROM work_item WHERE id = ANY($1::uuid[])`, [dependentIds])
    : [];
  const dependents = dependentRows
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)
      || (new Date(a.created_at) - new Date(b.created_at)))
    .map((d) => ({ id: d.id, title: d.title, kind: d.kind, status: d.status,
                   due_on: asDate(d.due_on), status_label: workLabel(d.status) }));

  const ticket = item.ticket_id
    ? await one(`SELECT id, number, title, kind, status, priority FROM ticket WHERE id=$1`, [item.ticket_id])
    : null;

  const events = await q(
    `SELECT id, ts, kind, from_status, to_status, actor, detail FROM work_item_event
      WHERE work_item_id=$1 ORDER BY ts DESC, id DESC LIMIT 50`, [id]);

  const zee = item.xell_id ? (await liveZees([item.xell_id])).get(item.xell_id) || null : null;

  // The counts a UI warns with, counted from the MODEL subtree (the tree under this item). open_children
  // exists because closing a parent does NOT close its children (see setStatus) — the read model says
  // so out loud instead of the UI guessing.
  const descendants = tree.filter((r) => r.model_depth > 1 && r.id);
  const openDescendants = descendants.filter((r) => !isTerminal(r.status)).length;
  const openChildren = children.filter((c) => !isTerminal(c.status)).length;

  return {
    ...item,
    ancestors,
    breadcrumb: ancestors.map((a) => a.title),
    children,
    open_children: openChildren,
    descendant_count: descendants.length,
    open_descendant_count: openDescendants,
    deps,
    dependents,
    ticket,
    events,
    zee,
    live_status: zee ? statusFromHive(zee.hive_status) : null,
  };
}

// ── writes ───────────────────────────────────────────────────────────────────

// priority is 1..5 and 1 is MOST urgent (docs/work-tracker.md, policy 5). Default 3 is the
// middle of the scale. NB: machine_pool.dev_priority is the OPPOSITE convention — higher wins.
const EDITABLE = ['title', 'body', 'priority', 'assignee', 'starts_on', 'due_on',
                  'estimate_hours', 'progress', 'sort_order', 'xell_id', 'ticket_id', 'kind'];

// The next rank among a parent's children — a new item lands at the END of its column/branch.
async function nextSortOrder(parentId, client = null) {
  const r = await dbRunner(client).one(
    `SELECT coalesce(max(sort_order), 0) + 1000 AS n FROM work_item
      WHERE parent_id IS NOT DISTINCT FROM $1`, [parentId]);
  return Number(r?.n ?? 1000);
}

// The project's root item — the parent everything defaults to.
export async function projectRoot(projectId, client = null) {
  assertId(projectId, 'project id');
  return dbRunner(client).one(`SELECT ${COLS} FROM work_item WHERE project_id=$1 AND kind='project'`, [projectId]);
}

// `client`/`pending` are only supplied by a caller that has already opened a transaction (see
// inTransaction). Reads go through the same client so this sees the siblings created moments ago in
// the same breakdown — which is what makes each new item's sort_order land after them.
//
// REHAB 1/4 DUAL-WRITE: creating a work_item also writes the workflow model's work_node for it
// (same transaction — if the node write fails the item write rolls back with it). A caller that
// passes no client gets a fresh transaction so the pair is atomic even when called standalone.
export async function createWorkItem(input = {}, opts = {}) {
  if (opts.client) return createWorkItemInTx(input, opts);
  return inTransaction((tx) => createWorkItemInTx(input, { ...opts, ...tx }));
}

async function createWorkItemInTx(input = {}, { client = null, pending = null } = {}) {
  const db = dbRunner(client);
  const title = String(input.title || '').trim();
  if (!title) throw bad('title required');
  const kind = input.kind || 'task';

  let parent = null;
  if (input.parent_id) {
    assertId(input.parent_id, 'parent work item id');
    parent = await db.one(`SELECT ${COLS} FROM work_item WHERE id=$1`, [input.parent_id]);
    if (!parent) throw bad(`parent_id ${input.parent_id} names no work item`);
  }
  const projectId = input.project_id || input.project || parent?.project_id;
  if (!projectId) throw bad('project required (or a parent_id to inherit it from)');
  assertId(projectId, 'project id');
  if (input.ticket_id) assertId(input.ticket_id, 'ticket id');
  if (input.xell_id) assertId(input.xell_id, 'xell id');
  if (!WORK_ITEM_KINDS.includes(kind)) {
    throw bad(`unknown work item kind "${kind}" — one of: ${WORK_ITEM_KINDS.join(', ')}`);
  }
  if (parent && parent.project_id !== projectId) {
    throw refuse('a work item must live in the same project as its parent');
  }
  // No explicit parent and not a project root → the project's root item. The database would do this
  // itself (migration 058), but resolving it here means sort_order is computed among the right
  // siblings rather than among the roots.
  if (!parent && kind !== 'project') {
    parent = await projectRoot(projectId, client);
    if (!parent) throw bad(`project ${projectId} has no root work item — cannot attach "${title}"`);
  }
  if (input.status && !isWorkStatus(input.status)) throw bad(`unknown status "${input.status}"`);
  // The two constraints that used to answer in postgres's words. 058 declares them (the partial
  // unique index work_item_one_project_root, and priority CHECK BETWEEN 1 AND 5) and they still do
  // the enforcing — this only means a caller is told what to DO. `duplicate key value violates
  // unique constraint "work_item_one_project_root"' reached a manager running `zee work --new --kind
  // project`, which is a sentence about an index, not about a plan.
  if (kind === 'project' && await projectRoot(projectId, client)) {
    throw refuse(`project ${projectId} already has its root work item — a project has exactly ONE, and `
      + `every card hangs under it. Cut "${title}" as an activity or a task instead (--kind activity, `
      + 'or omit --kind), optionally under an existing item with --parent.');
  }
  if (input.priority != null) {
    const p = Number(input.priority);
    if (!Number.isInteger(p) || p < 1 || p > 5) {
      throw bad(`priority "${input.priority}" is out of range — it is 1–5 (1 is the most urgent, 3 the `
        + 'default).');
    }
  }
  assertSchedule(input.starts_on, input.due_on, title);

  const sortOrder = input.sort_order != null ? Number(input.sort_order) : await nextSortOrder(parent?.id ?? null, client);
  const row = await db.one(
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

  // REHAB 1/4 DUAL-WRITE: the workflow model's work_node for this item. Recursively
  // materialises the plan/plan_version/root node for a project whose plan does not exist yet.
  await syncWorkNode(db, row);

  await emit(row, 'created', { to: row.status, actor: input.actor || input.created_by || null,
                               detail: { kind: row.kind, title: row.title, parent_id: row.parent_id } },
             { client, pending });
  return shapeItem(row);
}

// REHAB 1/4 DUAL-WRITE: updating a work_item also updates its work_node (same transaction).
// Self-transactional when called without a client, so the pair is atomic.
export async function updateWorkItem(id, patch = {}, opts = {}) {
  if (opts.client) return updateWorkItemInTx(id, patch, opts);
  return inTransaction((tx) => updateWorkItemInTx(id, patch, { ...opts, ...tx }));
}

async function updateWorkItemInTx(id, patch = {}, { client = null, pending = null, actor = null } = {}) {
  const db = dbRunner(client);
  assertId(id);
  if (patch.parent_id) assertId(patch.parent_id, 'parent work item id');
  if (patch.ticket_id) assertId(patch.ticket_id, 'ticket id');
  if (patch.xell_id) assertId(patch.xell_id, 'xell id');
  const before = await db.one(`SELECT ${COLS} FROM work_item WHERE id=$1`, [id]);
  if (!before) return null;

  // A parent_id (or an explicit reparent) in a PATCH is a MOVE — it rewrites the path of every
  // descendant, so it goes through the move path and gets its own 'moved' event.
  //
  // `moved` must record whether the move ACTUALLY RAN, not merely whether parent_id was in the
  // body. The first cut skipped the sort_order write whenever the key was present, so a kanban
  // drag WITHIN one column — which naturally sends {parent_id: <unchanged>, sort_order: N} — got a
  // 200 and no reorder: nobody applied it, because the move branch had been skipped too. Silent,
  // and the card snapped back on the next reload.
  let current = before;
  let moved = false;
  if ('parent_id' in patch && patch.parent_id !== before.parent_id) {
    current = await moveWorkItem(id, { parent_id: patch.parent_id, sort_order: patch.sort_order },
      { actor, client, pending });
    moved = true;
  }
  // Status is validated against nextStatuses and gets its own 'status' event.
  if ('status' in patch && patch.status !== before.status) {
    current = await setStatus(id, patch.status, { actor, client, pending });
  }

  // The dates are validated as a PAIR against what the row will actually hold: a PATCH carrying
  // only due_on must be checked against the STORED starts_on, or half of every inversion gets in.
  const merged = (f) => (f in patch ? (patch[f] === '' ? null : patch[f]) : before[f]);
  if ('starts_on' in patch || 'due_on' in patch) {
    assertSchedule(merged('starts_on'), merged('due_on'), before.title);
  }

  const sets = [];
  const params = [id];
  const changed = {};
  for (const f of EDITABLE) {
    if (!(f in patch)) continue;
    if (f === 'sort_order' && moved) continue;   // the move above already placed it
    params.push(patch[f] === '' ? null : patch[f]);
    sets.push(`${f} = $${params.length}`);
    changed[f] = patch[f];
  }
  if (!sets.length) return shapeItem(current);

  const row = await db.one(`UPDATE work_item SET ${sets.join(', ')} WHERE id=$1 RETURNING ${COLS}`, params);
  // REHAB 1/4 DUAL-WRITE: keep the work_node in step (name/estimate/kind/sort_order/parent).
  await syncWorkNode(db, row);
  // Naming a zee (or un-naming one) is its own kind of event: part 2 and the console both want to
  // read "when was a zee put on this" without parsing an edit diff.
  const kind = 'xell_id' in changed || 'assignee' in changed ? 'assigned' : 'edited';
  await emit(row, kind, { actor, detail: changed }, { client, pending });
  return shapeItem(row);
}

// A MOVE: a new parent and/or a new rank among siblings. The database enforces same-project,
// the nesting rank and cycles, and rewrites path/depth for the whole subtree; here we only turn
// its refusal into a sentence and record the event.
//
// REHAB 1/4 DUAL-WRITE: a move re-parents the work_item's work_node (parent_id + sibling_rank) in
// the same transaction. Descendants follow automatically (work_node is a parent-pointer tree).
export async function moveWorkItem(id, move = {}, opts = {}) {
  if (opts.client) return moveWorkItemInTx(id, move, opts);
  return inTransaction((tx) => moveWorkItemInTx(id, move, { ...opts, ...tx }));
}

async function moveWorkItemInTx(id, { parent_id: parentId, sort_order: sortOrder } = {},
                                { client = null, pending = null, actor = null } = {}) {
  const db = dbRunner(client);
  assertId(id);
  if (parentId) assertId(parentId, 'parent work item id');
  const before = await db.one(`SELECT ${COLS} FROM work_item WHERE id=$1`, [id]);
  if (!before) return null;
  if (before.kind === 'project') {
    throw refuse(`"${before.title}" is the project's root item — it is the top of the tree and cannot be moved under anything.`);
  }
  // parent_id: null means "move to the TOP LEVEL", and the top level is the project root — not
  // "become a second root", which the schema forbids anyway. The guard trigger would re-attach it
  // for us, but resolving it here means the new sort_order is computed among the siblings the item
  // will ACTUALLY land beside instead of among the roots.
  let nextParent = parentId === undefined ? before.parent_id : (parentId || null);
  if (nextParent === null && before.kind !== 'project') {
    nextParent = (await projectRoot(before.project_id, client))?.id ?? null;
  }
  const rank = sortOrder != null ? Number(sortOrder)
    : (nextParent === before.parent_id ? Number(before.sort_order) : await nextSortOrder(nextParent, client));

  const row = await db.one(
    `UPDATE work_item SET parent_id=$2, sort_order=$3 WHERE id=$1 RETURNING ${COLS}`,
    [id, nextParent, rank]);
  // REHAB 1/4 DUAL-WRITE: the work_node follows the item to its new parent/rank.
  await syncWorkNode(db, row);
  await emit(row, 'moved', { actor, detail: { from_parent: before.parent_id, to_parent: row.parent_id,
                                              from_sort: Number(before.sort_order), to_sort: Number(row.sort_order) } },
             { client, pending });
  return shapeItem(row);
}

// setStatus validates the transition against work-status.js (the SAME table the vocabulary endpoint
// serves) and writes a 'status' event carrying both ends of it.
//
// `cascade` is OPT-IN and never implied. Marking a parent done does NOT close its children: a
// tracker that auto-closes has, at some point, closed real open work on somebody's behalf. The read
// models expose open_children instead, so a UI can warn ("3 children still open — close them too?")
// and the human answers.
export async function setStatus(id, status, opts = {}) {
  if (opts.client) return setStatusInTx(id, status, opts);
  return inTransaction((tx) => setStatusInTx(id, status, { ...opts, ...tx }));
}

async function setStatusInTx(id, status, { client = null, pending = null, actor = null, cascade = false } = {}) {
  const db = dbRunner(client);
  assertId(id);
  const before = await db.one(`SELECT ${COLS} FROM work_item WHERE id=$1`, [id]);
  if (!before) return null;
  if (!isWorkStatus(status)) {
    throw bad(`unknown status "${status}" — one of: ${WORK_STATUS_KEYS.join(', ')}`);
  }
  if (!canTransition(before.status, status)) {
    throw refuse(`cannot move "${before.title}" from ${before.status} to ${status}`
      + ` — legal next statuses are: ${nextStatuses(before.status).join(', ')}`);
  }
  const row = await db.one(`UPDATE work_item SET status=$2 WHERE id=$1 RETURNING ${COLS}`, [id, status]);
  // REHAB 1/4 DUAL-WRITE: a status change is the LIFECYCLE side of the model — write the
  // execution (creating it only when the item actually leaves 'queued', never before).
  await syncExecutionState(db, id, status);
  await emit(row, 'status', { from: before.status, to: status, actor }, { client, pending });

  let cascaded = 0;
  if (cascade) {
    const kids = await db.q(
      `SELECT id, status FROM work_item WHERE path LIKE $1 AND status <> $2`,
      [`${subtreePrefix(before)}%`, status]);
    for (const k of kids) {
      if (!canTransition(k.status, status)) continue;
      const r = await db.one(`UPDATE work_item SET status=$2 WHERE id=$1 RETURNING ${COLS}`, [k.id, status]);
      await syncExecutionState(db, k.id, status);
      await emit(r, 'status', { from: k.status, to: status, actor, detail: { cascaded_from: id } },
                 { client, pending });
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
export async function deleteWorkItem(id, opts = {}) {
  if (opts.client) return deleteWorkItemInTx(id, opts);
  return inTransaction((tx) => deleteWorkItemInTx(id, tx));
}

async function deleteWorkItemInTx(id, { client = null, pending = null } = {}) {
  const db = dbRunner(client);
  assertId(id);
  const item = await db.one(`SELECT ${COLS} FROM work_item WHERE id=$1`, [id]);
  if (!item) return null;
  if (item.kind === 'project') {
    throw refuse(`"${item.title}" is the root item of its project and cannot be deleted — every `
      + 'other work item hangs off it, and the project row itself owns it (delete the project to '
      + 'delete the tree).');
  }
  const counts = await db.one(
    `SELECT count(*)::int AS n FROM work_item WHERE path LIKE $1`, [`${subtreePrefix(item)}%`]);
  // REHAB 1/4 DUAL-WRITE: delete the work_node subtree (and its executions — execution.
  // work_node_id is RESTRICT, so a node with executions cannot be deleted) BEFORE the work_item
  // row; the work_item delete cascades to child items, the work_node delete cascades to child nodes.
  await removeWorkNode(db, id);
  await db.q(`DELETE FROM work_item WHERE id=$1`, [id]);
  const event = ['work', { kind: 'deleted', item: shapeItem(item), descendants: counts?.n ?? 0 }];
  if (pending) pending.push(event); else broadcast(...event);
  return { ok: true, deleted: shapeItem(item), descendants: counts?.n ?? 0 };
}

// ── dependencies ─────────────────────────────────────────────────────────────
// REHAB 3/4 — the workflow model's `dependency` table is the ONE source of truth for edges.
// The legacy work_item_dep table is retired (it was fully mirrored by the dual-write, and every
// reader was re-pointed at the model in REHAB 2/4): addDep/removeDep write the model edge and
// the audit event only, never work_item_dep.
export async function addDep(workItemId, dependsOnId, opts = {}) {
  if (opts.client) return addDepInTx(workItemId, dependsOnId, opts);
  return inTransaction((tx) => addDepInTx(workItemId, dependsOnId, { ...opts, ...tx }));
}

async function addDepInTx(workItemId, dependsOnId, { client = null, pending = null, actor = null } = {}) {
  const db = dbRunner(client);
  assertId(workItemId);
  if (!dependsOnId) throw bad('depends_on_id required');
  assertId(dependsOnId, 'depends_on_id');
  // The retired work_item_dep guard (058) used to refuse a self-dependency and a cross-project
  // dependency with a sentence a human can read. The model's I5 trigger enforces the same
  // impossibilities, but its message ("I5 violated: …") is a constraint name, not a sentence — so
  // the same refusals are stated here first, in the tracker's own words, and the model trigger
  // stays as the backstop. The statuses match the old guard's (every one of its RAISE EXCEPTIONs
  // surfaced as a 409 via pgStatus).
  if (workItemId === dependsOnId) {
    throw refuse('a work item cannot depend on itself');
  }
  const [wi, dep] = await Promise.all([
    db.one(`SELECT project_id FROM work_item WHERE id=$1`, [workItemId]),
    db.one(`SELECT project_id FROM work_item WHERE id=$1`, [dependsOnId]),
  ]);
  if (!wi || !dep) throw refuse('both ends of a dependency must exist');
  if (wi.project_id !== dep.project_id) {
    throw refuse('a dependency may not cross projects');
  }
  // The model's dependency row (from_id = the PREREQUISITE's node, to_id = the DEPENDENT's node)
  // and the LCA-container 'freeform' flip are the whole write — syncDependency does both, and the
  // model's I5/I6 triggers refuse an edge the model cannot hold (rolled back with this transaction).
  await syncDependency(db, workItemId, dependsOnId);
  await logWorkEvent(workItemId, 'edited', { actor, detail: { added_dep: dependsOnId } }, { client });
  const item = await db.one(`SELECT ${COLS} FROM work_item WHERE id=$1`, [workItemId]);
  const event = ['work', { kind: 'dep', item: shapeItem(item) }];
  if (pending) pending.push(event); else broadcast(...event);
  return { ok: true, dep: { work_item_id: workItemId, depends_on_id: dependsOnId } };
}

export async function removeDep(workItemId, dependsOnId, opts = {}) {
  if (opts.client) return removeDepInTx(workItemId, dependsOnId, opts);
  return inTransaction((tx) => removeDepInTx(workItemId, dependsOnId, { ...opts, ...tx }));
}

async function removeDepInTx(workItemId, dependsOnId, { client = null, pending = null, actor = null } = {}) {
  const db = dbRunner(client);
  assertId(workItemId);
  assertId(dependsOnId, 'depends_on_id');
  // The model row is the source of truth, so "does this edge exist" is a model question. The
  // dependency rows cascade off work_node, so if either end has no node the edge cannot exist.
  const exists = await db.one(
    `SELECT d.id FROM dependency d
       JOIN work_node a ON a.id = d.from_id
       JOIN work_node b ON b.id = d.to_id
      WHERE a.stable_key = 'work_item:' || $1::text
        AND b.stable_key = 'work_item:' || $2::text
        AND d.type = 'FS'`,
    [dependsOnId, workItemId]);
  if (!exists) return null;
  await removeDependency(db, workItemId, dependsOnId);
  await logWorkEvent(workItemId, 'edited', { actor, detail: { removed_dep: dependsOnId } }, { client });
  const item = await db.one(`SELECT ${COLS} FROM work_item WHERE id=$1`, [workItemId]);
  const event = ['work', { kind: 'dep', item: shapeItem(item) }];
  if (pending) pending.push(event); else broadcast(...event);
  return { ok: true, removed: { work_item_id: workItemId, depends_on_id: dependsOnId } };
}

// ── the BOARD read model ─────────────────────────────────────────────────────
//
// One column per work_status, in the vocabulary's own order, so the console never invents a column
// list. A card's COLUMN is its STORED status; `live_status` is what the zee on it appears to be
// doing right now (statusFromHive) and is advisory only — the UI renders it as a hint, and nothing
// here ever writes it back. That separation is the whole point: a zee going idle for a minute must
// not silently drag somebody's card into another column.
export async function boardModel({ projectId, rootId } = {}) {
  if (projectId) assertId(projectId, 'project id');
  if (rootId) assertId(rootId);
  if (!projectId && !rootId) throw bad('project or root required');

  // REHAB 2/4 — the ROWS come from the MODEL tree (work_node). The board EXCLUDES the root (a
  // project's root item is not a card), exactly as the pre-rehab `path LIKE subtree%` read did.
  const treeRows = rootId
    ? await modelTree({ rootItemId: rootId })
    : await modelTree({ projectId });
  const rows = treeRows
    .filter((r) => r.id && r.model_depth > 1)          // foreign nodes + the root are not cards
    .map(shapeModelItem)
    .filter(Boolean)
    // the board's within-column order is the tracker's sort_order (the number the console drags)
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)
      || (new Date(a.created_at) - new Date(b.created_at)));
  const rootRow = treeRows.find((r) => r.model_depth === 1) || null;
  const root = rootRow ? shapeModelItem(rootRow) : null;

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

  // open_children — how many OPEN (non-terminal) children each card has. Counted from the MODEL
  // tree (a card's children are its node's children), not from work_item.parent_id.
  const openBySubtree = new Map();
  for (const r of treeRows) {
    if (!r.id || r.model_depth <= 1) continue;
    const pid = r.model_parent_item_id;
    if (!pid) continue;
    if (!openBySubtree.has(pid)) openBySubtree.set(pid, 0);
    if (!isTerminal(r.status)) openBySubtree.set(pid, openBySubtree.get(pid) + 1);
  }

  const card = (r) => {
    const zee = r.xell_id ? zees.get(r.xell_id) || null : null;
    return {
      id: r.id, project_id: r.project_id, parent_id: r.parent_id, kind: r.kind, title: r.title,
      status: r.status, status_label: r.status_label, priority: r.priority, progress: r.progress,
      sort_order: r.sort_order, depth: r.depth, assignee: r.assignee,
      starts_on: r.starts_on, due_on: r.due_on, actual_start: r.actual_start, actual_end: r.actual_end,
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

  return { root: root || null, project_id: projectId || root?.project_id || null,
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
  if (projectId) assertId(projectId, 'project id');
  if (rootId) assertId(rootId);
  if (!projectId && !rootId) throw bad('project or root required');

  // REHAB 2/4 — the ROWS come from the MODEL tree (work_node), the DEPS from the dependency table,
  // and the ACTUALS from execution. The gantt includes the root (it draws a top-level bar), exactly
  // as the pre-rehab read did.
  const treeRows = rootId
    ? await modelTree({ rootItemId: rootId })
    : await modelTree({ projectId });
  const rows = treeRows.map(shapeModelItem).filter(Boolean);
  const root = treeRows.find((r) => r.model_depth === 1) ? shapeModelItem(treeRows.find((r) => r.model_depth === 1)) : null;

  // actuals from the RUN PLANE: execution.started_at/finished_at are the record's proof of when an
  // item RAN (the pre-rehab reader took work_item.actual_*, which migration 159 derives from the
  // event ledger; the backfill's executions carry the same timestamps, so the two agree).
  //
  // ONE documented fallback: the run plane CLEARS finished_at when a terminal item is reopened (the
  // dual-write's syncExecutionState sets it NULL on the way back to queued), while the legacy
  // work_item.actual_end PERSISTS "this ended once". The model's single execution row has no room
  // for that history (a reopened item would need a fresh ATTEMPT row), so the gantt prefers the
  // execution and falls back to the legacy column when the run plane has no end — a reopened item
  // still draws its "it ended once" bar, exactly as it did before the rehab.
  const itemIds = rows.map((r) => r.id);
  const actuals = await modelActualsForItems(itemIds);
  for (const r of rows) {
    const a = actuals.get(r.id);
    if (a) {
      r.actual_start = a.start || r.actual_start || null;
      r.actual_end = a.end || r.actual_end || null;
    }
  }

  const { depsBy } = await modelDepsForItems(itemIds);

  const forest = nestItems(rows);
  const ordered = flattenTree(forest);

  // post-order roll-up: children first, so a parent can read its children's computed values
  const min = (a, b) => (!a ? b : (!b ? a : (a < b ? a : b)));
  const max = (a, b) => (!a ? b : (!b ? a : (a > b ? a : b)));
  const roll = (node) => {
    let start = node.starts_on || null;
    let end = node.due_on || null;
    // The ACTUAL span rolls up the same way, so a parent whose children were worked (but whose own
    // ledger is silent — a project/activity is rarely assigned to a zee) still gets the real bar
    // its subtree earned. A parent WITH its own actuals keeps them, exactly like the plan dates.
    let actualStart = node.actual_start || null;
    let actualEnd = node.actual_end || null;
    let weight = 0;
    let acc = 0;
    let leaves = 0;
    for (const c of node.children || []) {
      const r = roll(c);
      if (!node.starts_on) start = min(start, r.computed_start);
      if (!node.due_on) end = max(end, r.computed_end);
      if (!node.actual_start) actualStart = min(actualStart, r.computed_actual_start);
      if (!node.actual_end) actualEnd = max(actualEnd, r.computed_actual_end);
      acc += r.rolled_progress * r.weight;
      weight += r.weight;
      leaves += r.leaves;
    }
    node.computed_start = start;
    node.computed_end = end;
    node.computed_actual_start = actualStart;
    node.computed_actual_end = actualEnd;
    node.rolled_progress = (node.progress > 0 || !(node.children || []).length || !weight)
      ? node.progress
      : Math.round(acc / weight);
    // unscheduled means "nothing to draw, planned OR actual" — an item whose work HAPPENED is not
    // undated, however empty its plan is. The gantt lists the truly dateless rows and offers the
    // "schedule" action for them; a real bar needs no such offer.
    node.unscheduled = !start && !end && !actualStart && !actualEnd;
    node.weight = (node.children || []).length ? weight : 1;
    node.leaves = (node.children || []).length ? leaves : 1;
    return node;
  };
  for (const r of forest) roll(r);

  const ganttRows = ordered.map((n) => ({
    id: n.id, parent_id: n.parent_id, depth: n.depth, kind: n.kind, title: n.title,
    status: n.status, status_label: n.status_label,
    starts_on: n.starts_on, due_on: n.due_on,
    actual_start: n.actual_start || null, actual_end: n.actual_end || null,
    computed_start: n.computed_start || null, computed_end: n.computed_end || null,
    computed_actual_start: n.computed_actual_start || null, computed_actual_end: n.computed_actual_end || null,
    progress: n.progress, rolled_progress: n.rolled_progress,
    estimate_hours: n.estimate_hours, assignee: n.assignee, xell_id: n.xell_id,
    unscheduled: n.unscheduled === true,
    // How wide this bar is, in whole inclusive days (null when unscheduled). A FACT, not a verdict:
    // migration 060 guarantees it is never negative, but nothing bounds how large it may be —
    // '0001-01-01' → '9999-12-31' is a legal, ordered, absurd 2,958,099-day schedule, and truncating
    // it here would invent dates exactly as inventing a start for an unscheduled row would.
    // Stating the number lets a chart clamp its WINDOW honestly (and say that it did) instead of
    // deriving it from dates that may be null, or discovering the scale by trying to draw it.
    // A row with no PLAN but a real ACTUAL span reports the actual bar's width — the bar it draws.
    span_days: spanDays(n.computed_start, n.computed_end)
      || spanDays(tsDay(n.computed_actual_start), tsDay(n.computed_actual_end)),
    deps: depsBy.get(n.id) || [],
  }));
  // The whole chart's extent, stated once so a client does not have to min/max the rows itself —
  // and so it can decide whether to clamp BEFORE it lays anything out, rather than discovering the
  // scale by trying to draw it. Null when nothing in the model is scheduled at all. Includes the
  // ACTUAL span too — a chart whose bars are all actuals (the 470-item/0-plan case this exists for)
  // must still get a window.
  const scheduled = ganttRows.filter((r) =>
    (r.computed_start && r.computed_end) || (r.computed_actual_start && r.computed_actual_end));
  const chartStart = scheduled.reduce((a, r) => {
    const s = min(r.computed_start, tsDay(r.computed_actual_start));
    return (a && a <= s ? a : s);
  }, null);
  const chartEnd = scheduled.reduce((a, r) => {
    const e = max(r.computed_end, tsDay(r.computed_actual_end));
    return (a && a >= e ? a : e);
  }, null);

  return {
    root: root || null,
    project_id: projectId || root?.project_id || null,
    rows: ganttRows,
    unscheduled_count: ganttRows.filter((r) => r.unscheduled).length,
    span: scheduled.length
      ? { start: chartStart, end: chartEnd, days: spanDays(chartStart, chartEnd) }
      : null,
  };
}
