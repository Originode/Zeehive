// XELL SCRATCHPAD — a per-xell working note that OUTLIVES the cage (ticket #66).
//
// Commits are collected; knowledge is not. A swap keeps the branch and loses what the last zee
// learned; a reaped worker takes 'I am stuck on X' with it; a manager's rolling analysis lives in a
// container about to be deleted. This is the ONE durable channel a zee has that is not a commit and
// not a message: a single text on the xell's OWN row in the meta-DB, written and read through
// `zee scratchpad`, never a file in the worktree (a worktree dies with the branch — a swap is
// exactly when it dies).
//
// The shape deliberately copies STANDING ORDERS (lib/standing-orders.js, ticket #74 — the
// structurally identical problem: text on a xell row, appended to a brief):
//
//   • ONE place that renders the block, so the shape cannot drift between paths (scratchpadBlock);
//   • EMPTY renders NOTHING — a xell that never writes a scratchpad is byte-identical to today;
//   • a hard length ceiling enforced SERVER-SIDE on every write path (SCRATCHPAD_MAX), not in the CLI;
//   • refusals decided from the token-resolved xell — a zee can only ever touch its OWN scratchpad,
//     and a manager reading a crew xell's is scoped to the manager's own crew (workerOf), never from
//     anything the caller can set.
//
// WHOSE IT IS (the deliberate decision the card asks for): a xell's scratchpad belongs to that xell.
// A zee writes and reads its OWN and nothing else. A MANAGER may read a crew xell's (the manager
// already reads its crew's conversations and reports), and a HUMAN may read any xell's in the
// console. Neither a manager nor a human WRITES a zee's scratchpad — it is the zee's own thinking,
// and the writer is always the token-resolved xell itself.
import { one } from '../db/pool.js';

// A working note, not a second manual: a hard ceiling so it can never silently grow into the
// repository-of-record for a whole job. ~12k chars ≈ 1800 words — room for "what I have tried,
// what I ruled out, which assertions already proved", the half-page the ticket's zees lost.
export const SCRATCHPAD_MAX = 12000;

// The markdown block a swap embeds in the inheritance brief, or null when there is nothing to say.
// Null — not an empty section — is the unset contract: a xell that never wrote a scratchpad gets a
// swap brief that is byte-identical to one before this feature existed.
export function scratchpadBlock(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  return [
    '### The previous zee\'s scratchpad (its working notes — what it had tried and ruled out)',
    '',
    t,
    '',
  ].join('\n');
}

// Read a xell's scratchpad (the xell's OWN row — the caller decides WHICH xell is entitled to read
// it; the self verb passes the token-resolved xell, swapBrief passes the target being re-crewed).
export async function scratchpadForXell(xellId) {
  if (!xellId) return null;
  const row = await one(`SELECT scratchpad FROM xell WHERE id=$1`, [xellId]);
  const t = String(row?.scratchpad || '').trim();
  return t || null;
}
