// PUTTING A ZEE ON A WORK ITEM — the verbs that turn a PLAN into a FACT.
//
// The work tracker (058: work_item + work_item_event, lib/work-items.js) holds the plan: a tree of
// project → activity → task, each with a status. This module owns the other half — the moment a plan
// item stops being a card and becomes a running agent:
//
//   assignWorkItem   link an EXISTING xell to an item          (plan ← fact)
//   unassignWorkItem break that link                            (fact → plan)
//   deployWorkItem   DISPATCH a fresh worker zee for the item and assign it
//   candidatesFor    the xells that could take this item, so a human picks instead of pasting a uuid
//
// It lives beside work-items.js rather than inside it on purpose: work-items.js owns the PLAN's
// domain (create/move/status/history) and knows nothing about the fleet; everything here reaches into
// xells, dispatch and the queenzee. One module per direction keeps the plan usable with no fleet at
// all, and keeps this file's refusals — the interesting part — in one place.
//
// THE REFUSALS ARE THE POINT. A xell is not a free-floating resource: it belongs to a project, it may
// BE production, it may be a manager (which writes no code and lands nothing), and it may already be
// carrying somebody else's item. Every one of those is refused with a sentence a human can read,
// never a bare code — a picker that says "409" teaches nobody why the pick was wrong.
//
// ── CONTRACT with part 1 (db/migrations/058 + lib/work-items.js) ────────────────────────────────
// Written against the documented contract while 058 was still held at the landing gate. Everything
// this module assumes about part 1 is listed here so reconciling it is mechanical:
//   • work_item(id, project_id, parent_id, title, body, status, acceptance, ticket_id, xell_id,
//     sort_order, progress, created_at) — a tree by parent_id, scoped by project_id;
//   • work_item_event(work_item_id, kind, actor, data) — the history;
//   • task.work_item_id — which item a dispatched zee's task is executing;
//   • ticket(id, number, title, body) — the ticket an item was broken down from;
//   • work-items.js exports setStatus / emit / inTransaction (+ dbRunner). Each is called through ONE
//     adapter below (`event`, `moveStatus`, `tx`) so a signature that turns out different is a
//     one-line fix rather than a sweep.
// The STATUS VOCABULARY is read from work-status.js, never hardcoded here — except TERMINAL, which is
// a POLICY fence (see below), and which the test pins against the real vocabulary.
import { q, one } from '../db/pool.js';
import { broadcast } from './events.js';
import { logline } from './logbus.js';
import { setStatus, emit, inTransaction } from './work-items.js';

// ── the ONE place part 1's helpers are called ────────────────────────────────
// Adapters, not abstraction: each wraps exactly one imported verb so that if 058's signature differs
// from the contract above, this file changes in one line instead of twenty call sites.
const event = (itemId, kind, { actor, data = null, run = null } = {}) =>
  emit(itemId, kind, { actor, data, run });
const moveStatus = (itemId, status, { actor, note = null, progress = null, run = null } = {}) =>
  setStatus(itemId, status, { actor, note, progress, run });
const tx = (fn) => inTransaction(fn);

// TERMINAL is a FENCE, not vocabulary. Every verb here refuses to drag an item out of a finished
// state, and that refusal must hold even if the vocabulary grows a status this file has never heard
// of. Kept as an explicit list so the fence is readable at the point it is enforced; the test asserts
// it still matches the terminal statuses the real vocabulary declares (GET /api/work-statuses).
export const TERMINAL = ['done', 'cancelled'];
const isTerminal = (s) => TERMINAL.includes(s);

// ── errors that become HTTP status codes ─────────────────────────────────────
// The route layer reads `err.status`. 400 = you asked wrong, 404 = it does not exist, 409 = it exists
// and the answer is still no. Every message is a full sentence, because it is shown to a human.
const httpError = (status, message) => Object.assign(new Error(message), { status });
const bad = (m) => httpError(400, m);
const missing = (m) => httpError(404, m);
const refuse = (m) => httpError(409, m);

// ── reads ────────────────────────────────────────────────────────────────────
export async function getItem(id) {
  if (!id || !/^[0-9a-f-]{36}$/i.test(String(id))) throw bad(`"${id}" is not a work item id`);
  const item = await one(`SELECT * FROM work_item WHERE id=$1`, [id]);
  if (!item) throw missing(`no work item ${id}`);
  return item;
}

// The item's ANCESTOR chain, root first. A worker briefed with only its own leaf has no idea which
// project or activity it is inside — which is exactly the context that decides how it does the job.
export async function ancestorsOf(id) {
  return q(
    `WITH RECURSIVE up AS (
       SELECT wi.*, 0 AS depth FROM work_item wi WHERE wi.id = $1
       UNION ALL
       SELECT p.*, up.depth + 1 FROM work_item p JOIN up ON p.id = up.parent_id
     )
     SELECT id, title, body, status FROM up WHERE depth > 0 ORDER BY depth DESC`, [id]);
}

// The linked ticket, if the item was broken down from one. Best-effort: an item with no ticket is
// normal (a plan can be cut by hand), and a project with no ticket table at all must not break a
// dispatch — the brief is simply that much thinner.
async function ticketFor(item) {
  if (!item.ticket_id) return null;
  return one(`SELECT id, number, title, body FROM ticket WHERE id=$1`, [item.ticket_id])
    .catch(() => null);
}

// The live xell carrying an item (null when the link is stale or the xell is gone).
const liveXell = (id) => (id
  ? one(`SELECT id, slug, project_id, status, is_production, zee_type, branch, manager_xell_id
           FROM xell WHERE id=$1`, [id])
  : Promise.resolve(null));

// ── assign: link an EXISTING xell to an item ─────────────────────────────────
// Idempotent: assigning the xell that is already on the item is a no-op success, so a retry after a
// half-failed call is safe. The status move is queued → assigned ONLY: an item already working (or
// blocked, or in review) is further along than this verb knows, and a terminal item is finished.
export async function assignWorkItem(id, { xell_id, actor = 'human@console' } = {}) {
  const item = await getItem(id);
  if (!xell_id) throw bad('assign needs a xell_id — the xell to put on this work item.');
  const xell = await liveXell(xell_id);
  if (!xell) throw missing(`no xell ${xell_id} — it may already have been reaped.`);

  if (item.xell_id === xell.id) {
    return { ok: true, already: true, item: await getItem(id), xell: { id: xell.id, slug: xell.slug },
      message: `${xell.slug} is already on this work item — nothing to do.` };
  }

  // ── the refusals ──
  if (xell.status === 'retired') {
    throw refuse(`${xell.slug} is retired — its worktree is gone, so it cannot carry a work item. `
      + 'Deploy a fresh worker instead (POST /api/work-items/:id/deploy).');
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
      WHERE xell_id=$1 AND id <> $2 AND status <> ALL($3::text[]) LIMIT 1`,
    [xell.id, item.id, TERMINAL]);
  if (busy) {
    throw refuse(`${xell.slug} is already on an open work item ("${busy.title}", ${busy.status}). One `
      + 'zee, one item — unassign that one first (DELETE /api/work-items/:id/assign) or pick another xell.');
  }

  // ── the write ── (three rows: the item, the zee's task stamp, the event)
  const moved = item.status === 'queued' && !isTerminal(item.status);
  await tx(async (run) => {
    await run.q(`UPDATE work_item SET xell_id=$2 WHERE id=$1`, [item.id, xell.id]);
    // Stamp the xell's NEWEST task so the zee's own side of the link exists too: `zee work` resolves
    // a worker's item from its task, and the console can name the item on the xell card.
    await run.q(
      `UPDATE task SET work_item_id=$2
        WHERE id = (SELECT id FROM task WHERE xell_id=$1 ORDER BY created_at DESC LIMIT 1)`,
      [xell.id, item.id]);
    await event(item.id, 'assigned', { actor, run,
      data: { xell_id: xell.id, xell_slug: xell.slug, from_status: item.status } });
    if (moved) await moveStatus(item.id, 'assigned', { actor, run, note: `assigned to ${xell.slug}` });
  });
  broadcast('work', { item_id: item.id, project_id: item.project_id, kind: 'assigned', xell_id: xell.id });
  broadcast('xell', { id: xell.id });
  logline('work', `${xell.slug} assigned to work item "${item.title}"${moved ? ' (queued → assigned)' : ''} by ${actor}`);
  return {
    ok: true, item: await getItem(id), xell: { id: xell.id, slug: xell.slug }, status_moved: moved,
    message: `${xell.slug} is on "${item.title}"${moved ? ' and the item moved queued → assigned' : ''}. `
      + 'The board follows the zee from here (queenzee/worksync.js) — you do not have to move this card by hand.',
  };
}

// ── unassign: back to being plan ─────────────────────────────────────────────
// Deliberately does NOT change the status. An item that reached `working` did so because work
// happened; taking the zee off it does not un-happen that, and guessing a status backwards would
// overwrite the one thing the history is for.
export async function unassignWorkItem(id, { actor = 'human@console' } = {}) {
  const item = await getItem(id);
  if (!item.xell_id) {
    return { ok: true, already: true, item, message: 'No zee is on this work item — nothing to unassign.' };
  }
  const xell = await liveXell(item.xell_id);
  await tx(async (run) => {
    await run.q(`UPDATE work_item SET xell_id=NULL WHERE id=$1`, [item.id]);
    await run.q(`UPDATE task SET work_item_id=NULL WHERE xell_id=$1 AND work_item_id=$2`, [item.xell_id, item.id]);
    await event(item.id, 'unassigned', { actor, run,
      data: { xell_id: item.xell_id, xell_slug: xell?.slug || null, status: item.status } });
  });
  broadcast('work', { item_id: item.id, project_id: item.project_id, kind: 'unassigned' });
  if (xell) broadcast('xell', { id: xell.id });
  logline('work', `${xell?.slug || item.xell_id} taken off work item "${item.title}" by ${actor}`);
  return {
    ok: true, item: await getItem(id), was: xell ? { id: xell.id, slug: xell.slug } : null,
    message: `${xell?.slug || 'that zee'} is no longer on "${item.title}". Its status (${item.status}) is `
      + 'unchanged — work that happened, happened; only the link is gone.',
  };
}

// ── the brief a deployed worker actually receives ────────────────────────────
// Pure and exported so it can be read (and tested) without dispatching anything. The whole reason
// deploy exists rather than "dispatch, then assign by hand": everything the item already knows —
// where it sits, what ticket it came from, what "done" means — reaches the worker automatically.
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
    if (ticket.title) lines.push(`**${ticket.title}**`);
    if (ticket.body) lines.push('', String(ticket.body).trim());
  }
  if (item.acceptance) {
    lines.push('', '## Acceptance — this is what "done" means here', '', String(item.acceptance).trim());
  }
  if (extra && String(extra).trim()) {
    lines.push('', '## From whoever deployed you', '', String(extra).trim());
  }
  lines.push('', '## Reporting your progress',
    'You are executing a tracked work item, so the board can follow you:', '',
    '  - `zee work`                       → your item, its ancestors, its ticket and its acceptance notes.',
    '  - `zee item <id> --status working --progress 40 --note "…"` → report where you have got to.',
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
// stamping and the assignment without spawning a real agent — "do not dispatch real zees to test the
// deploy path". Production callers never pass it.
export async function deployWorkItem(id, { task = null, model = null, mode = null, harness = null,
                                           title = null, actor = 'human@console', managerXellId = null,
                                           dispatchFn = null } = {}) {
  const item = await getItem(id);
  if (isTerminal(item.status)) {
    throw refuse(`"${item.title}" is ${item.status} — deploying a zee onto a finished item would spend a `
      + 'whole worker on work somebody has already decided is over. Reopen it first if that is wrong.');
  }
  const current = await liveXell(item.xell_id);
  if (current && current.status !== 'retired') {
    throw refuse(`${current.slug} is already deployed on "${item.title}". Talk to it, or unassign it `
      + 'first — deploying again would spawn a second zee onto the same job.');
  }

  const ancestors = await ancestorsOf(item.id);
  const ticket = await ticketFor(item);
  const brief = briefForWorkItem({ item, ancestors, ticket, extra: task });

  // WHO dispatches decides which guards apply — and both are existing paths, imported lazily because
  // intake/self reach back into provisioning (a top-level import here would make lib ↔ queenzee circular).
  let out;
  if (dispatchFn) {
    out = await dispatchFn({ task: brief, title: title || item.title, model, mode, harness, item });
  } else if (managerXellId) {
    const manager = await one(`SELECT * FROM xell WHERE id=$1`, [managerXellId]);
    if (!manager) throw missing(`no manager xell ${managerXellId}`);
    const { selfDispatch } = await import('../queenzee/self.js');
    out = await selfDispatch(manager, { task: brief, title: title || item.title, model, mode, harness });
    if (out?.ok === false) throw refuse(out.error || 'the dispatch was refused');
  } else {
    const { dispatchXell } = await import('../queenzee/intake.js');
    out = await dispatchXell({
      task: brief, project: item.project_id, title: title || item.title,
      ...(model ? { model } : {}), ...(mode ? { mode } : {}),
      ...(harness !== null && harness !== undefined ? { harness } : {}),
    });
  }
  const newXellId = out?.xell_id || out?.xell?.id || out?.id || null;
  if (!newXellId) {
    throw httpError(500, 'the dispatch returned no xell to assign — nothing was linked to this work item. '
      + `Check the queenzee log; the raw answer was: ${JSON.stringify(out).slice(0, 300)}`);
  }
  const assigned = await assignWorkItem(item.id, { xell_id: newXellId, actor });
  await event(item.id, 'deployed', { actor,
    data: { xell_id: newXellId, xell_slug: out.slug || assigned.xell.slug, brief_chars: brief.length } });
  broadcast('work', { item_id: item.id, project_id: item.project_id, kind: 'deployed', xell_id: newXellId });
  logline('work', `deployed ${out.slug || newXellId} onto work item "${item.title}" (by ${actor})`);
  return {
    ok: true, item: assigned.item, xell: { id: newXellId, slug: out.slug || assigned.xell.slug },
    dispatch: out, brief,
    message: `Deployed ${out.slug || newXellId} onto "${item.title}". It was briefed from the item itself `
      + `(${ancestors.length} ancestor(s)${ticket ? ', its ticket' : ''}${item.acceptance ? ', its acceptance notes' : ''})`
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
                         WHERE wi.xell_id = x.id AND wi.status <> ALL($2::text[]))
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
// `zee work` for a MANAGER: its project's plan, in TREE ORDER, with each item's status, who is on it
// and what that zee is doing right now. A manager reading a flat list of uuids cannot see a plan;
// depth is the whole point of a tree.
//
// `board: true` drops the project ROOT — a root is not a card (the same rule /api/board follows).
// Nesting is `child_rank >= parent_rank`, so depth is arbitrary: never assume three levels.
export async function workItemTree(projectId, { board = false } = {}) {
  const rows = await q(
    `WITH RECURSIVE tree AS (
       SELECT wi.*, 0 AS depth,
              ARRAY[LPAD(COALESCE(wi.sort_order, 0)::text, 9, '0') || wi.id::text] AS path
         FROM work_item wi WHERE wi.project_id = $1 AND wi.parent_id IS NULL
       UNION ALL
       SELECT c.*, t.depth + 1,
              t.path || (LPAD(COALESCE(c.sort_order, 0)::text, 9, '0') || c.id::text)
         FROM work_item c JOIN tree t ON c.parent_id = t.id
     )
     SELECT t.*, x.slug AS xell_slug, x.status AS xell_status,
            z.status AS zee_status, z.cli_active
       FROM tree t
       LEFT JOIN xell x ON x.id = t.xell_id
       LEFT JOIN LATERAL (
         SELECT * FROM zee zz WHERE zz.xell_id = x.id
            AND zz.status IN ('spawning','online','working','idle')
          ORDER BY zz.created_at DESC LIMIT 1) z ON true
      ORDER BY t.path`, [projectId]);
  return (board ? rows.filter((r) => r.depth > 0) : rows).map((r) => {
    const { path, ...rest } = r;
    return { ...rest, zee: r.xell_slug
      ? { slug: r.xell_slug, xell_status: r.xell_status, zee_status: r.zee_status || null,
          working: r.cli_active === true || r.zee_status === 'working' }
      : null };
  });
}

// One item, with everything a zee executing it needs to know: where it sits, what it came from, what
// "done" means, who is on it, and what has happened to it. The same material briefForWorkItem folds
// into a dispatch — a worker that was briefed once should be able to re-read it at any time.
export async function workItemDetail(id, { events = 20 } = {}) {
  const item = await getItem(id);
  const [ancestors, ticket, xell, history, children] = await Promise.all([
    ancestorsOf(item.id),
    ticketFor(item),
    liveXell(item.xell_id),
    events
      ? q(`SELECT kind, actor, data, created_at FROM work_item_event
            WHERE work_item_id=$1 ORDER BY created_at DESC LIMIT $2`, [item.id, events]).catch(() => [])
      : [],
    q(`SELECT id, title, status, xell_id FROM work_item WHERE parent_id=$1
        ORDER BY COALESCE(sort_order, 0), created_at`, [item.id]),
  ]);
  return {
    item, ancestors, ticket, children, events: history,
    zee: xell ? { xell_id: xell.id, slug: xell.slug, status: xell.status } : null,
  };
}

// The work item a WORKER is executing. Its own link first (work_item.xell_id — what assign writes),
// falling back to the stamp on its newest task, so a zee still finds its item if one side was
// written and the other was not. An OPEN item always wins over a finished one.
export async function itemForXell(xellId) {
  const mine = await one(
    `SELECT * FROM work_item WHERE xell_id=$1
      ORDER BY (status <> ALL($2::text[])) DESC, created_at DESC LIMIT 1`, [xellId, TERMINAL]);
  if (mine) return mine;
  return one(
    `SELECT wi.* FROM work_item wi
       JOIN task t ON t.work_item_id = wi.id
      WHERE t.xell_id = $1 ORDER BY t.created_at DESC LIMIT 1`, [xellId]);
}

// A zee REPORTING where its work has got to. This is a report of FACT, not a gate: it moves the card
// and nothing else. Setting `done` is allowed — the zee is the one who knows the work is finished —
// and it deliberately does NOT touch the xell's own done/land/ship state: those stay human gates, and
// a verb that quietly proposed done for the xell would be exactly the bypass this repo refuses.
// Terminal → anything is refused: reopening a decided item is a human's act.
export async function reportItemStatus(id, { status = null, progress = null, note = null,
                                             actor = 'zee' } = {}) {
  const item = await getItem(id);
  if (status == null && progress == null && !note) {
    throw bad('nothing to report — give --status, --progress or --note.');
  }
  if (isTerminal(item.status) && status && status !== item.status) {
    throw refuse(`"${item.title}" is already ${item.status}. Reopening a finished item is a human's `
      + 'decision, not an agent\'s — say so in a note and let a human move it.');
  }
  if (status && status !== item.status) {
    await moveStatus(item.id, status, { actor, note, progress });
  } else {
    await event(item.id, 'note', { actor, data: { note, progress, status: item.status } });
    if (progress != null) await q(`UPDATE work_item SET progress=$2 WHERE id=$1`, [item.id, progress]);
  }
  broadcast('work', { item_id: item.id, project_id: item.project_id, kind: 'status', status: status || item.status });
  logline('work', `work item "${item.title}" reported ${status || item.status}`
    + `${progress != null ? ` (${progress}%)` : ''} by ${actor}${note ? `: ${String(note).slice(0, 120)}` : ''}`);
  const after = await getItem(id);
  return {
    ok: true, item: after, moved: !!(status && status !== item.status),
    message: status && status !== item.status
      ? `"${after.title}" is now ${after.status}${progress != null ? ` (${progress}%)` : ''}.`
        + (isTerminal(after.status)
          ? ' That reports the WORK finished — it does not mark your xell done, land anything or ship '
            + 'anything. Those are still your own verbs and a human\'s gates.'
          : '')
      : `Recorded on "${after.title}" (still ${after.status}).`,
  };
}
