// WHAT EARLIER RUNS OF THIS ZEE DID — a digest synthesized from the meta-DB ledgers (TKT-114-A).
//
// A revived zee wakes with the SAME session and the SAME transcript, so it can read what its own
// previous run typed — but not what that run DID in the fleet. Every side effect a zee takes is
// ledgered somewhere the transcript never shows: a message it sent (zee_message), a worker it
// dispatched (xell.manager_xell_id), a done suggestion (done_suggestion), a work-item op
// (work_item_event.actor). A manager killed three times by 429s re-decides the same question on
// every revive, with no visibility of what the run before it already said or did — the TKT-114
// whipsaw (ten contradictory messages to one worker in eleven minutes). This digest is the
// disclosure: "here, in the fleet's own ledgers, is what you (or a run sharing your identity)
// have done recently."
//
// Scope: since the zee's `created_at` (the task began), capped to the most recent few per ledger so
// a long-lived manager does not get a wall of its own history. Each line carries a timestamp so the
// revived run can tell "just now" from "hours ago".
import { q } from '../db/pool.js';

const PER_LEDGER = 12;

// One ledger may be entirely absent for a given zee (a worker has no dispatches, no done
// suggestions); an absent ledger contributes nothing and is not an error.
export async function predecessorActionDigest({ xellId, xellSlug, since = null } = {}) {
  if (!xellId) return null;
  const lines = [];

  // 1. MESSAGES SENT — zee_message where THIS xell is the sender (a manager's `zee say`, a worker's
  //    `zee report`). The durable inbox, not the transcript.
  const messages = await q(
    `SELECT kind, to_slug, body, created_at FROM zee_message
      WHERE from_xell_id = $1 AND ($2::timestamptz IS NULL OR created_at >= $2)
      ORDER BY created_at DESC LIMIT ${PER_LEDGER}`, [xellId, since]);
  for (const m of messages) {
    const who = m.to_slug || 'a xell';
    const body = String(m.body || '').replace(/\s+/g, ' ').slice(0, 140);
    lines.push(`• sent a ${m.kind} to ${who}${body ? `: "${body}"` : ''}  (${ts(m.created_at)})`);
  }

  // 2. DISPATCH / ASSIGN — xells stamped with this manager. A dispatch creates the worker xell; an
  //    assign goes through the same dispatch path, so the xell row is the record either way.
  const workers = await q(
    `SELECT slug, created_at FROM xell
      WHERE manager_xell_id = $1 AND ($2::timestamptz IS NULL OR created_at >= $2)
      ORDER BY created_at DESC LIMIT ${PER_LEDGER}`, [xellId, since]);
  for (const w of workers) {
    lines.push(`• dispatched a worker into ${w.slug}  (${ts(w.created_at)})`);
  }

  // 3. SUGGEST-DONE — done_suggestion rows raised by this manager.
  const suggestions = await q(
    `SELECT target_slug, reason, requested_at FROM done_suggestion
      WHERE manager_xell_id = $1 AND ($2::timestamptz IS NULL OR requested_at >= $2)
      ORDER BY requested_at DESC LIMIT ${PER_LEDGER}`, [xellId, since]);
  for (const s of suggestions) {
    lines.push(`• suggested ${s.target_slug || 'a xell'} is done`
      + (s.reason ? `: "${String(s.reason).replace(/\s+/g, ' ').slice(0, 120)}"` : '')
      + `  (${ts(s.requested_at)})`);
  }

  // 4. WORK-ITEM OPS — work_item_event rows whose actor is this xell's slug (`zee item`, `zee work`,
  //    `zee assign`). Join the item for its title so the line is readable without a second query.
  const work = await q(
    `SELECT w.title, e.kind, e.ts
       FROM work_item_event e
       JOIN work_item w ON w.id = e.work_item_id
      WHERE e.actor = $1 AND ($2::timestamptz IS NULL OR e.ts >= $2)
      ORDER BY e.ts DESC LIMIT ${PER_LEDGER}`, [xellSlug, since]);
  for (const w of work) {
    const title = String(w.title || '(untitled item)').replace(/\s+/g, ' ').slice(0, 70);
    lines.push(`• work item ${w.kind} on "${title}"  (${ts(w.ts)})`);
  }

  if (!lines.length) return null;
  return [
    '',
    'WHAT EARLIER RUNS OF YOURS DID (from the fleet\'s ledgers — these actions are NOT visible in your '
      + 'transcript, and a previous run may have taken them):',
    ...lines,
    '',
    'Treat the above as YOUR OWN past actions: do not re-send, re-dispatch or re-suggest what is '
      + 'already there — `zee status` and `zee inbox` are the current state.',
  ].join('\n');
}

// A compact, sortable timestamp for a ledger row. Local-time-unaware, so the same instant reads the
// same wherever the queenzee runs.
function ts(d) {
  if (!d) return '?';
  const t = new Date(d);
  return t.toISOString().slice(5, 16).replace('T', ' ');
}
