// PUTTING A ZEE ON A WORK ITEM — the verbs that turn a PLAN into a FACT.
//
// The work tracker (058, lib/work-items.js) holds the plan: a tree of project → activity → task,
// each with a status. This module owns the other half — the moment a plan item stops being a card
// and becomes a running agent:
//
//   assignWorkItem   link an EXISTING xell to an item          (plan ← fact)
//   unassignWorkItem break that link                            (fact → plan)
//   deployWorkItem   DISPATCH a fresh worker zee for the item and assign it
//   candidatesFor    the xells that could take this item, so a human picks instead of pasting a uuid
//   reportItemStatus a zee (or a manager) reporting where the WORK has got to
//
// It lives beside work-items.js rather than inside it on purpose: work-items.js owns the PLAN's
// domain (create/move/status/history) and knows nothing about the fleet; everything here reaches
// into xells, dispatch and the queenzee. One module per direction keeps the plan usable with no
// fleet at all, and keeps this file's refusals — the interesting part — in one place.
//
// THE REFUSALS ARE THE POINT. A xell is not a free-floating resource: it belongs to a project, it may
// BE production, it may be a manager (which writes no code and lands nothing), and it may already be
// carrying somebody else's item. Every one of those is refused with a sentence a human can read,
// never a bare code — a picker that says "409" teaches nobody why the pick was wrong.
//
// ── what it BORROWS from part 1, rather than restating ───────────────────────────────────────────
//   • the STATUS VOCABULARY: isTerminal / canTransition / nextStatuses / statusFromHive come from
//     work-status.js. Nothing here hardcodes a status list — TERMINAL below is DERIVED from it.
//   • the TRANSACTION: inTransaction + dbRunner, so an assignment writes the item, the zee's task
//     stamp and the audit event as ONE unit. Broadcasts go out only after the COMMIT, or a card is
//     painted that the database does not have.
//   • the AUDIT vocabulary: logWorkEvent with part 1's kinds (`assigned` · `status` · `comment`).
//     No new event kind is invented here — a consumer reading the ledger should not have to learn a
//     second dialect because the row was written by a different file.
//   • the ZEE CHIP: liveZees() already derives a xell's hive status from the same signals fleet.js
//     feeds it. It is used verbatim rather than re-derived a second way.
//   • the ID CONTRACT: assertId — malformed → 400 naming the field, well-formed but unknown → 404.
import { q, one, pool } from '../db/pool.js';
import { broadcast } from './events.js';
import { logline } from './logbus.js';
import { syncExecutionState } from './work-node-sync.js';
import {
  getWorkItem, listWorkItems, flattenTree, liveZees, logWorkEvent, inTransaction, dbRunner, assertId,
} from './work-items.js';
import { WORK_STATUS_KEYS, isTerminal, isWorkStatus, canTransition, nextStatuses,
         statusFromHive } from './work-status.js';

// The finished statuses, DERIVED from the vocabulary (never a second list to keep in step). Used as
// a fence: no verb here drags an item out of a status a human has decided.
export const TERMINAL = WORK_STATUS_KEYS.filter(isTerminal);

// A xell on its way out. `retired` is gone; `tearing-down` is a human's confirmed decision already
// being executed by the reaper — putting work on either is putting work on something that will not
// exist in a minute.
const GOING = ['retired', 'tearing-down'];

// ── errors that become HTTP status codes ─────────────────────────────────────
// The route layer reads `err.status`, and falls back to part 1's shared workErr() for anything
// thrown out of work-items.js. 400 = you asked wrong, 404 = it does not exist, 409 = it exists and
// the answer is still no. Every message is a full sentence, because a human reads it.
const httpError = (status, message) => Object.assign(new Error(message), { status });
const bad = (m) => httpError(400, m);
const missing = (m) => httpError(404, m);
const refuse = (m) => httpError(409, m);

// A per-item advisory-lock key, derived from the work item's UUID. Used by deployWorkItem
// (TKT-110-3DA9) so two DEPLOYS on the SAME item can never overlap — a slow first deploy that
// outlives the caller's timeout, plus a retry of it, would both pass the "already deployed"
// guard below (both read xell_id=NULL), both spawn a worker, and whichever links LAST wins
// while the other worker is an orphaned crew with no card. The lock is taken BEFORE the guard
// and held through the spawn, so the retry is refused while the first is still in flight:
// one worker per item per deploy window, no orphan. Advisory locks are cluster-wide in
// Postgres, so the guard holds across multiple queenzee processes; a crash releases it with
// the connection.
const deployLockKeySql = `hashtextextended($1::text, 0)`;

// ── reads ────────────────────────────────────────────────────────────────────
// The plain row (not getWorkItem's rich read model): assignment logic needs project/status/xell and
// nothing else, and a refusal must not cost six queries. assertId gives the malformed-vs-unknown
// split part 1 established.
export async function getItem(id) {
  try { assertId(id); } catch (e) { throw bad(e.message); }
  const item = await one(
    `SELECT id, project_id, parent_id, kind, title, body, status, progress, ticket_id, xell_id, path
       FROM work_item WHERE id=$1`, [id]);
  if (!item) throw missing(`no work item ${id}`);
  return item;
}

// The live xell carrying an item (null when the link is stale or the xell is gone).
const liveXell = (id) => (id
  ? one(`SELECT id, slug, project_id, status, is_production, zee_type, branch, manager_xell_id
           FROM xell WHERE id=$1`, [id])
  : Promise.resolve(null));

// What the SSE bus is told after a commit. Part 1's own emit() sends { kind, item } and its doc
// PINS that shape for the 'assigned' and 'status' kinds — so every broadcast from part 3 carries the
// item too, and a console consumer never has to know which file wrote the row. The event LEDGER is
// deliberately left out of it (up to 50 rows on a bus message nobody reads them from).
// Exported because queenzee/worksync.js announces the same two kinds when the board moves itself.
export async function announceWorkItem(kind, itemId, extra = {}) {
  const item = await getWorkItem(itemId);
  if (!item) return null;
  const { events, ...lean } = item;
  broadcast('work', { kind, item: lean, ...extra });
  return item;
}

// ── assign: link an EXISTING xell to an item ─────────────────────────────────
// Idempotent, and self-healing with it: assigning the xell that is already on the item still
// finishes the queued → assigned move if a previous attempt died between the two writes.
export async function assignWorkItem(id, { xell_id, actor = 'human@console' } = {}) {
  const item = await getItem(id);
  if (!xell_id) throw bad('assign needs a xell_id — the xell to put on this work item.');
  try { assertId(xell_id, 'xell id'); } catch (e) { throw bad(e.message); }
  const xell = await liveXell(xell_id);
  if (!xell) throw missing(`no xell ${xell_id} — it may already have been reaped.`);

  const already = item.xell_id === xell.id;
  if (!already) {
    // ── the refusals ──
    if (GOING.includes(xell.status)) {
      throw refuse(`${xell.slug} is ${xell.status} — it is gone or being torn down, so it cannot carry a `
        + 'work item (its worktree is going away, and with it anything it has not landed). Deploy a '
        + 'fresh worker instead (POST /api/work-items/:id/deploy).');
    }
    if (xell.project_id !== item.project_id) {
      throw refuse(`${xell.slug} belongs to a different project than this work item. A xell only ever `
        + 'works in its own project — pick one from GET /api/work-items/:id/candidates.');
    }
    if (xell.is_production) {
      throw refuse(`${xell.slug} IS production. Production is not a worker: it is the thing the work `
        + 'ships to. Deploy a worker for this item instead.');
    }
    if (xell.zee_type === 'manager') {
      throw refuse(`${xell.slug} is a MANAGER zee. A manager runs a crew and writes no code (it has zero `
        + 'push access to the xource), so it cannot execute a work item — it DISPATCHES a worker for one '
        + '(`zee assign --item <id> --task "…"`).');
    }
    const busy = await one(
      `SELECT id, title, status FROM work_item
        WHERE xell_id=$1 AND id <> $2 AND status <> ALL($3::work_status[]) LIMIT 1`,
      [xell.id, item.id, TERMINAL]);
    if (busy) {
      throw refuse(`${xell.slug} is already on an open work item ("${busy.title}", ${busy.status}). One `
        + 'zee, one item — unassign that one first (DELETE /api/work-items/:id/assign) or pick another xell.');
    }
  }

  // queued → assigned, and ONLY that: an item already working/blocked/in review is further along
  // than this verb knows, and a terminal item has been decided by somebody.
  const moved = item.status === 'queued' && canTransition(item.status, 'assigned');
  if (already && !moved) {
    return { ok: true, already: true, item: await getWorkItem(id), xell: { id: xell.id, slug: xell.slug },
      message: `${xell.slug} is already on this work item — nothing to do.` };
  }

  // ── ONE transaction: the item, the zee's task stamp, the audit event ──
  // Part 1's setStatus/updateWorkItem cannot join someone else's transaction, so the writes are made
  // through its dbRunner and recorded with its logWorkEvent, using its own event kinds. The
  // transition is validated against work-status.js first (above) — the same table setStatus checks.
  await inTransaction(async ({ client }) => {
    const db = dbRunner(client);
    if (!already) await db.q(`UPDATE work_item SET xell_id=$2 WHERE id=$1`, [item.id, xell.id]);
    // Stamp the xell's NEWEST task so the zee's own side of the link exists too: `zee work` resolves
    // a worker's item from its task, and the console can name the item on the xell card.
    await db.q(
      `UPDATE task SET work_item_id=$2
        WHERE id = (SELECT id FROM task WHERE xell_id=$1 ORDER BY created_at DESC LIMIT 1)`,
      [xell.id, item.id]);
    if (!already) {
      await logWorkEvent(item.id, 'assigned', { actor,
        detail: { xell_id: xell.id, xell_slug: xell.slug, from_status: item.status } }, { client });
    }
    if (moved) {
      await db.q(`UPDATE work_item SET status='assigned' WHERE id=$1`, [item.id]);
      // REHAB 1/4 DUAL-WRITE: queued → assigned is the item leaving the not-started state —
      // write the execution (creating it if this is the first sign of work).
      await syncExecutionState(db, item.id, 'assigned');
      await logWorkEvent(item.id, 'status', { from: item.status, to: 'assigned', actor,
        detail: { because: `assigned to ${xell.slug}` } }, { client });
    }
  });

  const shaped = await announceWorkItem('assigned', item.id, { xell_id: xell.id });
  broadcast('xell', { id: xell.id });
  logline('work', `${xell.slug} assigned to work item "${item.title}"${moved ? ' (queued → assigned)' : ''} by ${actor}`);
  return {
    ok: true, already, item: shaped, xell: { id: xell.id, slug: xell.slug }, status_moved: moved,
    message: `${xell.slug} is on "${item.title}"${moved ? ' and the item moved queued → assigned' : ''}. `
      + 'The board follows the zee from here (queenzee/worksync.js) — you do not have to move this card by hand.',
  };
}

// ── unassign: back to being plan ─────────────────────────────────────────────
// Deliberately does NOT change the status. An item that reached `working` did so because work
// happened; taking the zee off it does not un-happen that, and guessing a status backwards would
// overwrite the one thing the history is for.
//
// `reason` is optional and rides in the ledger entry: the interesting unassign is "its zee died at
// spawn", and a card that lost its zee with no explanation is a card nobody can date afterwards.
export async function unassignWorkItem(id, { actor = 'human@console', reason = null } = {}) {
  const item = await getItem(id);
  if (!item.xell_id) {
    return { ok: true, already: true, item: await getWorkItem(id),
      message: 'No zee is on this work item — nothing to unassign.' };
  }
  const xell = await liveXell(item.xell_id);
  await inTransaction(async ({ client }) => {
    const db = dbRunner(client);
    await db.q(`UPDATE work_item SET xell_id=NULL WHERE id=$1`, [item.id]);
    await db.q(`UPDATE task SET work_item_id=NULL WHERE xell_id=$1 AND work_item_id=$2`, [item.xell_id, item.id]);
    // part 1's ledger has no 'unassigned' kind, and inventing one would give consumers a second
    // dialect to learn: naming (or un-naming) a zee is an 'assigned' event, and the detail says which.
    await logWorkEvent(item.id, 'assigned', { actor,
      detail: { unassigned: true, xell_id: item.xell_id, xell_slug: xell?.slug || null,
                status_kept: item.status, ...(reason ? { reason } : {}) } }, { client });
  });
  const shaped = await announceWorkItem('assigned', item.id);
  if (xell) broadcast('xell', { id: xell.id });
  logline('work', `${xell?.slug || item.xell_id} taken off work item "${item.title}" by ${actor}`
    + (reason ? ` — ${reason}` : ''));
  return {
    ok: true, item: shaped, was: xell ? { id: xell.id, slug: xell.slug } : null,
    message: `${xell?.slug || 'that zee'} is no longer on "${item.title}". Its status (${item.status}) is `
      + 'unchanged — work that happened, happened; only the link is gone.',
  };
}

// ── the brief a deployed worker actually receives ────────────────────────────
// Pure and exported so it can be read (and tested) without dispatching anything. The whole reason
// deploy exists rather than "dispatch, then assign by hand": everything the item already knows —
// where it sits, what ticket it came from, when it is due — reaches the worker automatically.
export function briefForWorkItem({ item, ancestors = [], ticket = null, extra = null }) {
  const lines = [];
  lines.push(`# ${item.title}`);
  if (item.body) lines.push('', String(item.body).trim());
  if (ancestors.length) {
    lines.push('', '## Where this sits',
      'This work item is part of a plan. Its ancestors, outermost first:', '');
    ancestors.forEach((a, i) => lines.push(`${'  '.repeat(i)}- ${a.title}${a.status ? ` (${a.status})` : ''}`));
    lines.push(`${'  '.repeat(ancestors.length)}- **${item.title}** ← YOUR item`);
  }
  if (ticket) {
    lines.push('', `## The ticket this came from${ticket.number ? ` (#${ticket.number})` : ''}`);
    if (ticket.title) lines.push(`**${ticket.title}**${ticket.kind ? ` _(${ticket.kind})_` : ''}`);
    if (ticket.body) lines.push('', String(ticket.body).trim());
  }
  // The acceptance notes: whatever the item states as its own definition of done. 058 has no
  // dedicated column, so this reads one if a later migration adds it and is silent otherwise —
  // the item's body and its ticket already carry the substance.
  if (item.acceptance) {
    lines.push('', '## Acceptance — this is what "done" means here', '', String(item.acceptance).trim());
  }
  const facts = [
    item.due_on && `due ${item.due_on}`,
    item.starts_on && `starts ${item.starts_on}`,
    item.estimate_hours != null && `estimated ${item.estimate_hours}h`,
    item.priority != null && `priority ${item.priority}`,
  ].filter(Boolean);
  if (facts.length) lines.push('', `_${facts.join(' · ')}_`);
  if (extra && String(extra).trim()) {
    lines.push('', '## From whoever deployed you', '', String(extra).trim());
  }
  lines.push('', '## Reporting your progress',
    'You are executing a tracked work item, so the board can follow you:', '',
    '  - `zee work`                       → your item, its ancestors, its ticket and its history.',
    '  - `zee item --status working --progress 40 --note "…"` → report where you have got to.',
    '',
    'That is a REPORT OF FACT, not a gate: it moves the card, and it never marks your xell done,',
    'lands anything or ships anything — those stay your own verbs and a human\'s gates. You may only',
    'ever touch the item you are assigned to.');
  return lines.join('\n');
}

// ── deploy: dispatch a FRESH worker for this item, then assign it ────────────
// Reuses the existing dispatch paths — `selfDispatch` when a MANAGER is deploying (so the worker is
// stamped as its crew, seated beside it, and every manager refusal still applies) and `dispatchXell`
// when the console is. There is deliberately no second spawn path in this file: a dispatch that
// skipped those guards would be a hole punched straight through the manager layer.
//
// `dispatchFn` is a TEST SEAM (and only that): the test suite must be able to prove the brief, the
// stamping and the assignment without spawning a real agent. Production callers never pass it.
export async function deployWorkItem(id, { task = null, model = null, mode = null, harness = null,
                                           title = null, visual_verify = false, langfuse_tracking = null,
                                           provider = null,
                                           actor = 'human@console', managerXellId = null,
                                           dispatchFn = null } = {}) {
  const plain = await getItem(id);
  if (isTerminal(plain.status)) {
    throw refuse(`"${plain.title}" is ${plain.status} — deploying a zee onto a finished item would spend a `
      + 'whole worker on work somebody has already decided is over. Reopen it first if that is wrong.');
  }

  // ── ONE DEPLOY IN FLIGHT PER ITEM (TKT-110-3DA9) ────────────────────────────
  // The "already deployed" guard below reads xell_id, and the link that sets it happens AFTER
  // the (slow) spawn — so two deploys that overlap that window both read xell_id=NULL, both
  // spawn, and whichever links last wins while the other worker is an orphaned crew with no
  // card. Take a per-item advisory lock BEFORE the guard and hold it through the spawn: the
  // retry is refused here, before anything is spawned. A dedicated client is used (the lock is
  // per-session); the finally releases it on every exit, and a crash drops the connection and
  // frees the lock with it.
  const lockClient = await pool.connect();
  try {
    const got = await lockClient.query(
      `SELECT pg_try_advisory_lock(${deployLockKeySql}) AS got`, [id]);
    if (!got.rows[0].got) {
      throw refuse(`another deploy for "${plain.title}" is already in flight — a worker is being spawned `
        + 'for this item right now. Wait for it to settle, or unassign the item first.');
    }
    return await deployWorkItemHeld(id, plain, { task, model, mode, harness, title, visual_verify,
                                                 langfuse_tracking, provider, actor, managerXellId, dispatchFn });
  } finally {
    await lockClient.query(`SELECT pg_advisory_unlock(${deployLockKeySql})`, [id]).catch(() => {});
    lockClient.release();
  }
}

// The guarded half of deployWorkItem — the lock in the outer function is held for the whole of
// this: the "already deployed" check, the brief, the (slow) spawn, and the link. Kept as its own
// function so the outer lock has one caller and one finally, and the body below is unchanged.
async function deployWorkItemHeld(id, plain, { task = null, model = null, mode = null, harness = null,
                                               title = null, visual_verify = false, langfuse_tracking = null,
                                               provider = null,
                                               actor = 'human@console', managerXellId = null,
                                               dispatchFn = null } = {}) {
  const current = await liveXell(plain.xell_id);
  if (current && !GOING.includes(current.status)) {
    throw refuse(`${current.slug} is already deployed on "${plain.title}". Talk to it, or unassign it `
      + 'first — deploying again would spawn a second zee onto the same job.');
  }

  // getWorkItem gives the ancestors (from the materialized path) and the linked ticket in one read.
  // Its ticket read is the CARD's shape (number/title/kind/status) and carries no body — a brief
  // without the ticket's actual words is exactly the context a worker then has to go and ask for,
  // so it is fetched here, once, and only when there is a ticket at all.
  const full = await getWorkItem(id);
  const ticket = full.ticket
    ? { ...full.ticket, body: (await one(`SELECT body FROM ticket WHERE id=$1`, [full.ticket.id]))?.body || null }
    : null;
  const brief = briefForWorkItem({ item: full, ancestors: full.ancestors || [], ticket, extra: task });

  // WHO dispatches decides which guards apply — and both are existing paths, imported lazily because
  // intake/self reach back into provisioning (a top-level import here would make lib ↔ queenzee circular).
  let out;
  if (dispatchFn) {
    out = await dispatchFn({ task: brief, title: title || full.title, model, mode, harness,
                             visual_verify, langfuse_tracking, provider, item: full });
  } else if (managerXellId) {
    const manager = await one(`SELECT * FROM xell WHERE id=$1`, [managerXellId]);
    if (!manager) throw missing(`no manager xell ${managerXellId}`);
    const { selfDispatch } = await import('../queenzee/self.js');
    // The ITEM travels with the dispatch (#64): selfDispatch's overlap check keys on it to say what has
    // already LANDED on this card, and the brief alone cannot carry that — briefForWorkItem writes the
    // ticket as a bare "(#64)", which the brief reader deliberately ignores.
    out = await selfDispatch(manager, { task: brief, title: title || full.title, model, mode, harness,
                                        visual_verify, langfuse_tracking, provider, work_item_id: full.id });
    if (out?.ok === false) throw refuse(out.error || 'the dispatch was refused');
  } else {
    const { dispatchXell } = await import('../queenzee/intake.js');
    out = await dispatchXell({
      task: brief, project: full.project_id, title: title || full.title,
      ...(model ? { model } : {}), ...(mode ? { mode } : {}),
      ...(harness !== null && harness !== undefined ? { harness } : {}),
      ...(visual_verify ? { visual_verify: true } : {}),
      // --langfuse / --no-langfuse: explicit true/false lands; omission (null) preserves the target.
      ...(langfuse_tracking === true || langfuse_tracking === false ? { langfuse_tracking } : {}),
      ...(provider ? { provider } : {}),
    });
  }
  const newXellId = out?.xell_id || out?.xell?.id || out?.id || null;
  if (!newXellId) {
    throw httpError(500, 'the dispatch returned no xell to assign — nothing was linked to this work item. '
      + `Check the queenzee log; the raw answer was: ${JSON.stringify(out).slice(0, 300)}`);
  }
  const assigned = await assignWorkItem(id, { xell_id: newXellId, actor });
  await logWorkEvent(id, 'assigned', { actor,
    detail: { deployed: true, xell_id: newXellId, xell_slug: out.slug || assigned.xell.slug,
              brief_chars: brief.length } });
  logline('work', `deployed ${out.slug || newXellId} onto work item "${full.title}" (by ${actor})`);
  return {
    ok: true, item: assigned.item, xell: { id: newXellId, slug: out.slug || assigned.xell.slug },
    dispatch: out, brief,
    message: `Deployed ${out.slug || newXellId} onto "${full.title}". It was briefed from the item itself `
      + `(${(full.ancestors || []).length} ancestor(s)${ticket ? ', its ticket' : ''})`
      + `${task ? ' plus your extra instructions' : ''}. The board follows it from here.`,
  };
}

// ── candidates: who could take this item ─────────────────────────────────────
// So a picker can offer xells instead of asking a human to paste a uuid. Two populations, both in
// THIS item's project and neither of them production or a manager:
//   • the READY POOL — vacant xells waiting for a zee;
//   • LIVE WORKERS with no open item — a zee that is between jobs.
// A xell already carrying an open item is excluded — including the one already on THIS item, which
// cannot "take" what it is already doing. A picker that offers a choice the server then rejects (or
// that does nothing) is worse than one that offers fewer.
export async function candidatesFor(id) {
  const item = await getItem(id);
  const rows = await q(
    `SELECT x.id, x.slug, x.status, x.branch, x.db_coupling, x.head_commit,
            COALESCE(x.zee_type, 'worker') AS zee_type,
            z.status AS zee_status, z.model,
            (SELECT mx.slug FROM xell mx WHERE mx.id = x.manager_xell_id) AS manager_slug,
            (x.status = 'ready') AS from_pool
       FROM xell x
       LEFT JOIN LATERAL (
         SELECT * FROM zee zz WHERE zz.xell_id = x.id
            AND zz.status IN ('spawning','online','working','idle')
          ORDER BY zz.created_at DESC LIMIT 1) z ON true
      WHERE x.project_id = $1
        AND x.status NOT IN ('retired','tearing-down','error','husk')
        AND NOT x.is_production
        AND COALESCE(x.zee_type,'worker') <> 'manager'
        AND NOT EXISTS (SELECT 1 FROM work_item wi
                         WHERE wi.xell_id = x.id AND wi.status <> ALL($2::work_status[]))
      ORDER BY (x.status = 'ready') DESC, x.created_at`,
    [item.project_id, TERMINAL]);
  return {
    ok: true, item: { id: item.id, title: item.title, status: item.status, xell_id: item.xell_id },
    count: rows.length,
    candidates: rows.map((r) => ({
      ...r,
      why: r.from_pool ? 'a ready pool xell — deploying is usually better than assigning a vacant xell'
        : 'a live worker with no open work item',
    })),
    note: rows.length ? null
      : 'No xell in this project can take this item right now — POST /api/work-items/:id/deploy dispatches a fresh worker.',
  };
}

// ── read models the cxell verbs answer from ──────────────────────────────────
// `zee work` for a MANAGER: its project's plan in TREE order (depth-first, the order a person reads
// a plan in — listWorkItems returns breadth-first by depth), with each item's status, who is on it
// and what that zee is doing right now. A manager reading a flat list of uuids cannot see a plan.
//
// `board: true` drops the project ROOT — a root is not a card (the same rule /api/board follows).
// Nesting is `child_rank >= parent_rank`, so depth is arbitrary: never assume three levels.
export async function workItemTree(projectId, { board = false } = {}) {
  const forest = await listWorkItems({ projectId, tree: true });
  const flat = flattenTree(forest).map(({ children, ...i }) => i);
  const zees = await liveZees(flat.map((i) => i.xell_id));
  return flat
    .filter((i) => !(board && i.kind === 'project'))
    .map((i) => {
      const zee = i.xell_id ? zees.get(i.xell_id) || null : null;
      // live_status is ADVISORY — what the zee is doing right now, next to the stored status a
      // human last set. The card's column is always the stored one (part 1's rule).
      return { ...i, zee: zee || null, live_status: zee ? statusFromHive(zee.hive_status) : null };
    });
}

// The work item a WORKER is executing. Its own link first (work_item.xell_id — what assign writes),
// falling back to the stamp on its newest task, so a zee still finds its item if one side was
// written and the other was not. An OPEN item always wins over a finished one.
export async function itemForXell(xellId) {
  const mine = await one(
    `SELECT id FROM work_item WHERE xell_id=$1
      ORDER BY (status <> ALL($2::work_status[])) DESC, created_at DESC LIMIT 1`, [xellId, TERMINAL]);
  if (mine) return getWorkItem(mine.id);
  const viaTask = await one(
    `SELECT wi.id FROM work_item wi JOIN task t ON t.work_item_id = wi.id
      WHERE t.xell_id = $1 ORDER BY t.created_at DESC LIMIT 1`, [xellId]);
  return viaTask ? getWorkItem(viaTask.id) : null;
}

// A zee (or a manager) REPORTING where the work has got to. This is a report of FACT, not a gate: it
// moves the card and nothing else. Setting `done` is allowed — the zee is the one who knows the work
// is finished — and it deliberately does NOT touch the xell's own done/land/ship state: those stay
// human gates, and a verb that quietly proposed done for the xell would be exactly the bypass this
// repo refuses. Which transitions are legal is work-status.js's answer, not this file's.
export async function reportItemStatus(id, { status = null, progress = null, note = null,
                                             actor = 'zee' } = {}) {
  const item = await getItem(id);
  if (status == null && progress == null && !note) {
    throw bad('nothing to report — give --status, --progress or --note.');
  }
  if (status != null && !isWorkStatus(status)) {
    throw bad(`unknown status "${status}" — one of: ${WORK_STATUS_KEYS.join(', ')}`);
  }
  if (status && status !== item.status && !canTransition(item.status, status)) {
    throw refuse(`cannot move "${item.title}" from ${item.status} to ${status} — legal next statuses `
      + `are: ${nextStatuses(item.status).join(', ')}.`);
  }
  const moved = !!(status && status !== item.status);
  await inTransaction(async ({ client }) => {
    const db = dbRunner(client);
    if (moved) {
      await db.q(`UPDATE work_item SET status=$2 WHERE id=$1`, [item.id, status]);
      // REHAB 1/4 DUAL-WRITE: the reported status is the LIFECYCLE side — write the execution.
      await syncExecutionState(db, item.id, status);
      await logWorkEvent(item.id, 'status', { from: item.status, to: status, actor,
        detail: note ? { note } : null }, { client });
    }
    if (progress != null) {
      await db.q(`UPDATE work_item SET progress=$2 WHERE id=$1`, [item.id, progress]);
    }
    if (note && !moved) await logWorkEvent(item.id, 'comment', { actor, detail: { note, progress } }, { client });
  });
  const shaped = await announceWorkItem('status', item.id);
  logline('work', `work item "${item.title}" reported ${status || item.status}`
    + `${progress != null ? ` (${progress}%)` : ''} by ${actor}${note ? `: ${String(note).slice(0, 120)}` : ''}`);
  return {
    ok: true, item: shaped, moved,
    message: moved
      ? `"${shaped.title}" is now ${shaped.status}${progress != null ? ` (${progress}%)` : ''}.`
        + (isTerminal(shaped.status)
          ? ' That reports the WORK finished — it does not mark your xell done, land anything or ship '
            + 'anything. Those are still your own verbs and a human\'s gates.'
          : '')
      : `Recorded on "${shaped.title}" (still ${shaped.status}).`,
  };
}
