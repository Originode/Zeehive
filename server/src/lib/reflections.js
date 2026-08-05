// THE REFLECTIONS LEDGER — every post-ship reflection this project's zees have written, in one
// place, and one action that turns any of them into a ticket.
//
// A reflection is a `zee_message` with kind='reflection': after a ship of its work goes live, the
// queenzee re-invokes the zee (queenzee/shipgate.js, gated by the harness's `enable_reflection`) and
// it reports what it now knows about what shipped. It is the fleet's only systematic self-feedback,
// and until this existed the only reader was the RECIPIENT — its manager's own `zee inbox`, or the
// per-xell Directives panel. So a reflection addressed to a manager xell that has since been retired
// reached nobody at all, and its findings ("a spinoff xell's app tier cannot boot", "this endpoint
// has never answered over HTTP") sat unread in a table.
//
// WHY ITS OWN MODULE rather than another function in managers.js, which owns `zee_message`: filing
// one as a ticket has to go through tickets.js `createTicket` (the one path a ticket is ever created
// by), and tickets.js already imports managers.js for `postMessage`. Putting this there would make
// that a cycle. The imports here run one way — reflections → tickets → managers — and this module
// owns exactly one subject: reflections read PROJECT-WIDE, and filed.
//
// READING HERE MARKS NOTHING READ. `read_at` is the receipt for the AGENT's own `zee inbox` (see
// managers.inboxFor), and a human reading the ledger must not clear a zee's unread flags — the same
// rule messagesForXell states for the per-xell audit view, for the same reason. Nothing in this file
// writes `read_at`, and nothing here delivers a message anywhere.
import { q, one } from '../db/pool.js';
import { broadcast } from './events.js';
import { logline } from './logbus.js';
import { createTicket, deleteTicket, ticketCode } from './tickets.js';
import { assertId, bad, refuse } from './work-items.js';

// ── the read ─────────────────────────────────────────────────────────────────
//
// WHO CAN STILL READ IT is the column that makes this list actionable, so it is computed here rather
// than left for the console to infer. Three ways a reflection is ORPHANED — nobody will ever read it
// as a message — and each one gets its own sentence, because they are different facts:
//
//   • it was never addressed to anyone (the zee had no manager: self.js selfReport stores it
//     unaddressed rather than losing it);
//   • its recipient xell row is GONE (zee_message.to_xell_id is ON DELETE SET NULL, and the slug is
//     stamped precisely so the record outlives the xell);
//   • its recipient is RETIRED — the row is there, the cxell is not, and its inbox is unreachable.
//
// Newest first, with `limit` and `since` — a ledger is read from the top, and 300+ rows is already
// more than a human reads in one sitting.
const REFLECTION_COLS = `m.id, m.project_id, m.kind, m.from_slug, m.from_xell_id, m.to_slug, m.to_xell_id,
                         m.body, m.delivered, m.read_at, m.created_at, m.ticket_id`;

export async function listReflections({ projectId, limit = 100, since = null } = {}) {
  if (!projectId) throw bad('project required');
  assertId(projectId, 'project id');
  const n = Math.min(500, Math.max(1, Number(limit) || 100));
  let sinceAt = null;
  if (since !== null && since !== undefined && String(since).trim() !== '') {
    sinceAt = new Date(since);
    if (Number.isNaN(sinceAt.getTime())) throw bad(`"${since}" is not a date — since takes an ISO timestamp`);
  }
  const rows = await q(
    `SELECT ${REFLECTION_COLS},
            fx.slug AS from_xell_slug, fx.status AS from_xell_status,
            tx.status AS to_xell_status,
            t.number AS ticket_number, t.title AS ticket_title, t.status AS ticket_status
       FROM zee_message m
       LEFT JOIN xell fx ON fx.id = m.from_xell_id
       LEFT JOIN xell tx ON tx.id = m.to_xell_id
       LEFT JOIN ticket t ON t.id = m.ticket_id
      WHERE m.project_id = $1 AND m.kind = 'reflection'
        AND ($2::timestamptz IS NULL OR m.created_at >= $2::timestamptz)
      ORDER BY m.created_at DESC
      LIMIT $3`, [projectId, sinceAt, n]);
  return rows.map(shapeReflection);
}

function shapeReflection(r) {
  const retired = r.to_xell_id ? r.to_xell_status === 'retired' : false;
  const gone = !!r.to_slug && !r.to_xell_id;
  const unaddressed = !r.to_slug && !r.to_xell_id;
  const orphaned = retired || gone || unaddressed;
  return {
    id: r.id,
    from: r.from_slug,
    // The SOURCE XELL, and whether it is still there. from_xell_id is SET NULL on reap too, so a
    // null id with a slug means "the xell that wrote this is gone" — never "we do not know who".
    from_xell_id: r.from_xell_id,
    from_xell_slug: r.from_xell_slug || r.from_slug || null,
    from_xell_status: r.from_xell_status || null,
    to: r.to_slug,
    to_xell_id: r.to_xell_id,
    to_xell_status: r.to_xell_status || null,
    recipient_retired: retired,
    orphaned,
    orphan_reason: unaddressed
      ? 'it was addressed to nobody — this zee had no manager, so it was recorded for the console'
      : gone ? `${r.to_slug} is gone — the xell was reaped, so its inbox no longer exists`
      : retired ? `${r.to_slug} is retired — its inbox is unreachable`
      : null,
    delivered: r.delivered,
    read_at: r.read_at,
    at: r.created_at,
    body: r.body,
    ticket: r.ticket_id
      ? { id: r.ticket_id, number: r.ticket_number,
          code: ticketCode({ id: r.ticket_id, number: r.ticket_number }),
          title: r.ticket_title, status: r.ticket_status }
      : null,
  };
}

// ── filing one as a ticket ───────────────────────────────────────────────────
//
// THE TITLE IS THE FIRST LINE, because that is how a zee writes a reflection — a headline, then the
// detail. Markdown ornament and the reflection glyph are stripped so the ticket list reads like the
// rest of the tickets; the whole body still travels verbatim underneath, so nothing is lost to the
// trimming.
const TITLE_MAX = 160;

export function reflectionTitle(body) {
  const first = String(body || '').split('\n').map((l) => l.trim()).find((l) => l.length > 0) || '';
  const clean = first.replace(/^[#>*\-\s🪞]+/, '').replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  return clean.length > TITLE_MAX ? `${clean.slice(0, TITLE_MAX - 1)}…` : clean;
}

// What the ticket says. The reflection VERBATIM, then the provenance a reader needs to go back to
// the source: which zee wrote it, and when. Nothing is summarised — a reflection is already the
// short form of what that zee knew.
export function reflectionTicketBody(r) {
  const slug = r.from_slug || r.from_xell_slug || 'an unknown xell';
  const at = r.created_at || r.at;
  return [
    String(r.body || '').trim(),
    '',
    '—',
    `Filed from the post-ship reflection written by ${slug}`
      + `${at ? ` on ${new Date(at).toISOString()}` : ''}.`,
  ].join('\n');
}

// FILE IT. One reflection becomes one ticket, through createTicket — there is no second creation
// path, so a filed reflection is an ordinary ticket in every window that already exists.
//
// FILED ONCE. The link is what stops two people filing the same finding, so the write claims it
// conditionally (`WHERE ticket_id IS NULL`) rather than trusting the read that preceded it: two
// clicks at the same instant would otherwise create two tickets and remember only the second. When
// the claim loses that race the ticket just created is deleted again and the WINNER's code is
// returned — the caller is told what the row now says, which is the same answer they would have got
// a second later.
export async function fileReflectionAsTicket(id, { kind = 'chore', by = 'human@console', priority = null } = {}) {
  assertId(id, 'reflection id');
  const row = await one(
    `SELECT ${REFLECTION_COLS}, fx.slug AS from_xell_slug FROM zee_message m
       LEFT JOIN xell fx ON fx.id = m.from_xell_id
      WHERE m.id = $1`, [id]);
  if (!row) return null;
  // The ledger lists reflections, so this verb files reflections. A directive or a plain report
  // reaching it means the caller sent the wrong id, and creating a ticket out of it would be a
  // silent success on a mistake.
  if (row.kind !== 'reflection') {
    throw refuse(`that message is a ${row.kind}, not a reflection — only a post-ship reflection is `
      + 'filed from the ledger.');
  }
  const already = await filedTicket(row.ticket_id);
  if (already) {
    throw refuse(`this reflection is already filed as ${ticketCode(already)} — "${already.title}". `
      + 'Comment on that ticket rather than filing the same finding twice.');
  }
  const title = reflectionTitle(row.body);
  if (!title) throw bad('this reflection has no text to make a title from');

  const ticket = await createTicket({
    project_id: row.project_id,
    title,
    body: reflectionTicketBody(row),
    kind: kind || 'chore',
    priority: priority ?? undefined,
    reporter: row.from_slug || null,
  });

  const claimed = await one(
    `UPDATE zee_message SET ticket_id=$2 WHERE id=$1 AND ticket_id IS NULL RETURNING ticket_id`,
    [id, ticket.id]);
  if (!claimed) {
    await deleteTicket(ticket.id);
    const winner = await one(
      `SELECT t.id, t.number, t.title FROM zee_message m JOIN ticket t ON t.id=m.ticket_id WHERE m.id=$1`,
      [id]);
    throw refuse(`this reflection was filed as ${ticketCode(winner)} a moment ago — `
      + 'the ticket this call would have made was removed again, so the finding has exactly one.');
  }

  broadcast('work', { kind: 'reflection-filed', reflection_id: id, ticket });
  logline('crew', `reflection from ${row.from_slug || '?'} filed as ${ticket.code} by ${by}`);
  return { ok: true, ticket, reflection_id: id, code: ticket.code,
    note: `Filed as ${ticket.code} — "${ticket.title}". The reflection now carries that code, so `
      + 'nobody files it twice.' };
}

const filedTicket = async (ticketId) => (ticketId
  ? one(`SELECT id, number, title FROM ticket WHERE id=$1`, [ticketId])
  : null);
