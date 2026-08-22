// STANDING ORDERS — a manager's crew discipline, appended VERBATIM to every brief it dispatches
// (ticket #74).
//
// A manager (or a human in the console) sets a short text once; every worker the manager dispatches
// is briefed with it as a clearly-marked SEPARATE block at the end of the brief. It is the thing the
// manager used to retype by hand into every `--task` — read CLAUDE.md first, get a real database,
// land early, report what you could NOT verify — and the whole point of storing it is that a brief
// that LOST a line produced a worker that did nothing. So:
//
//   • VERBATIM: the text is appended unchanged. No templating, no trimming of lines.
//   • IDENTIFIABLY SEPARATE: the block has its own heading, so a worker can tell the per-card task
//     from the standing orders.
//   • SHORT BY DESIGN: a hard length ceiling — a limit, not a second manual — and clearing is one
//     verb, so a stale block is trivially pruned rather than accumulating.
//   • EMPTY IS TODAY: NULL/'' renders NO block, so a manager that never sets one is byte-identical
//     to before this feature existed.
//   • THE SAME REFUSALS AS ANY BRIEF: the text is instructions TO workers, appended to the brief; it
//     never changes what the dispatched worker IS (worker harness, worker db, no prod), and a worker
//     told to reach beyond its own xell refuses it exactly as it would refuse it in a task.
import { one } from '../db/pool.js';

// A handful of paragraphs, not a second manual. Hard ceiling so the block can never silently grow
// into the thing this feature exists to prevent. (~4k chars ≈ 600 words — a manager's discipline,
// not a spec.)
export const STANDING_ORDERS_MAX = 4000;

// The markdown block appended to a brief, or null when there is nothing to say. Null — not an empty
// section — is the unset contract: a manager with no standing orders gets a brief that is
// byte-identical to one before this feature existed.
export function standingOrdersBlock(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  return [
    '## STANDING ORDERS (from your manager — appended to every brief)',
    '',
    t,
  ].join('\n');
}

// Read a xell's standing orders (the manager's own row), or null when unset.
export async function standingOrdersForXell(xellId) {
  if (!xellId) return null;
  const row = await one(`SELECT standing_orders FROM xell WHERE id=$1`, [xellId]);
  const t = String(row?.standing_orders || '').trim();
  return t || null;
}

// The ONE place a brief becomes a brief-with-standing-orders. Every dispatch path that has a manager
// caller appends through here, so the block is always the same shape, always at the END, and always
// verbatim. A manager with nothing set gets its brief back BYTE-IDENTICAL — empty is exactly today.
export async function appendStandingOrders(brief, managerXellId) {
  const standing = await standingOrdersForXell(managerXellId);
  if (!standing) return brief;
  return [brief, '', standingOrdersBlock(standing)].join('\n');
}
