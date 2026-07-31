// Status projection — the ONLY place zee/xell status is mutated from observability.
// Fed by harness hooks (Channel A, primary) and the passive poller (Channel B, fallback).
import { q, one } from '../db/pool.js';
import { broadcast } from './events.js';
import { codenameFor } from './names.js';

const ACTIVE = ['spawning', 'online', 'working', 'idle'];

export async function zeeBySession(sessionId) {
  if (!sessionId) return null;
  return one(`SELECT * FROM zee WHERE claude_session_id = $1`, [sessionId]);
}

export async function recordEvent(ev) {
  await q(
    `INSERT INTO session_event
       (source,hook_event_name,claude_session_id,zee_id,xell_id,pid,cwd,agent_id,tool_name,permission_mode,stop_reason,raw)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [ev.source, ev.hook_event_name || null, ev.claude_session_id || null, ev.zee_id || null,
     ev.xell_id || null, ev.pid || null, ev.cwd || null, ev.agent_id || null,
     ev.tool_name || null, ev.permission_mode || null, ev.stop_reason || null,
     ev.raw ? JSON.stringify(ev.raw) : null]
  );
}

// Set a zee's status + apply the "named only while working" rule + mirror to its xell.
export async function setZeeStatus(zee, status, { stopReason } = {}) {
  if (!zee) return;
  // working zees are named (stable codename); everything else is nameless
  const name = status === 'working' ? (zee.name || codenameFor(zee.id)) : null;
  const decommission = status === 'stopped' ? ', decommissioned_at = now()' : '';
  const updated = await one(
    `UPDATE zee
       SET status = $2, name = $3, last_event_at = now(),
           last_stop_reason = COALESCE($4, last_stop_reason) ${decommission}
     WHERE id = $1 RETURNING *`,
    [zee.id, status, name, stopReason || null]
  );
  broadcast('zee', updated);

  // Mirror onto the xell (working→working, idle→idle). Retirement is the reaper's job.
  const xellStatus = status === 'working' ? 'working'
    : status === 'idle' ? 'idle'
    : status === 'online' ? 'claimed'
    : null;
  if (xellStatus) {
    const xl = await one(
      `UPDATE xell SET status = $2 WHERE id = $1
         AND status NOT IN ('tearing-down','retired') RETURNING *`,
      [zee.xell_id, xellStatus]
    );
    if (xl) broadcast('xell', xl);
  }
  return updated;
}

// Channel A: apply one harness hook event.
export async function projectHook(payload) {
  const sessionId = payload.session_id || payload.claude_session_id;
  const name = payload.hook_event_name;
  const zee = await zeeBySession(sessionId);

  await recordEvent({
    source: 'hook',
    hook_event_name: name,
    claude_session_id: sessionId,
    zee_id: zee?.id,
    xell_id: zee?.xell_id,
    pid: payload.pid,
    cwd: payload.cwd,
    agent_id: payload.agent_id,
    tool_name: payload.tool_name || payload.tool_input?.tool_name,
    permission_mode: payload.permission_mode,
    stop_reason: payload.stop_reason,
    raw: payload,
  });

  if (!zee) return { matched: false }; // event for a session we don't manage — logged only

  // Mirror the session's REAL permission mode onto the zee. Hooks are the only channel that
  // reports what mode a session is actually in — a skill-claimed zee never records one at claim,
  // and a human flipping modes in-session (shift+tab) changes it without telling anyone. Without
  // this the dashboard's mode chip shows the spawn-time value forever (or nothing at all).
  if (payload.permission_mode && payload.permission_mode !== zee.permission_mode) {
    const withMode = await one(
      `UPDATE zee SET permission_mode = $2 WHERE id = $1 RETURNING *`,
      [zee.id, payload.permission_mode]);
    if (withMode) { zee.permission_mode = withMode.permission_mode; broadcast('zee', withMode); }
  }

  switch (name) {
    case 'SessionStart':               await setZeeStatus(zee, 'online'); break;
    case 'UserPromptSubmit':           await setZeeStatus(zee, 'working'); break;
    case 'PreToolUse':
    case 'PostToolUse':                await setZeeStatus(zee, 'working'); break;
    case 'Stop':                       await setZeeStatus(zee, 'idle', { stopReason: 'end_turn' }); break;
    case 'SessionEnd':                 await setZeeStatus(zee, 'stopped'); break;
    case 'SubagentStop':
    case 'Notification':               await touch(zee); break;
    default:                           await touch(zee);
  }
  return { matched: true, zee_id: zee.id };
}

async function touch(zee) {
  await q(`UPDATE zee SET last_event_at = now() WHERE id = $1`, [zee.id]);
}

// ── the zee's ATTENTION ping (tend) ────────────────────────────────────────────
// A zee can raise "I need a human in the console" (tend) and clear it again. There is no dedicated
// table — the shared dev schema is frozen — so it rides the append-only session_event log: the OPEN
// state of a xell's tend is simply whether its LATEST tend event is a 'tend-request' (vs a
// 'tend-clear'). recordEvent already writes the reason into `raw`. Cleared automatically when the
// zee reports working again (see setTendFromWork), so a stale "needs you" can't dangle after the
// zee moved on.
//
// The reason is the POINT of a tend, not decoration: "a xell needs a human" with no why makes the
// human open a terminal and read a transcript to find out what they were called for. So it is
// recorded (raw.reason), read back with the open state (tendState), and carried to the console.
//
// TWO lengths, because there are two surfaces and clipping the STORED text served neither: the
// hexagon chip and the card row get ONE brief line (they physically cannot hold more), but the
// opened ask gets the whole thing. The first cut of this clamped on write AND on read, which threw
// the tail away — a zee's tend reporting a prod problem read "…re-tasking a manager wi…" and the
// rest existed nowhere a human could reach. So: STORE what the zee said (bounded, not clipped),
// DISPLAY the brief line, and keep the full text one click away.
export const TEND_REASON_MAX = 200;      // the one-line display form (chip / card row)
export const TEND_REASON_STORE_MAX = 2000; // what a tend may CARRY (a bound on the row, not an edit)

// One brief line: collapse whitespace/newlines, trim, cap at `max` (…-elided). null when empty, so
// "no reason" stays distinguishable from "a reason that says nothing".
export function briefReason(reason, max = TEND_REASON_MAX) {
  const s = String(reason ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}
// What actually gets STORED: the same one-line normalisation (a tend is prose, not a document), but
// kept whole up to a bound generous enough that no honest reason ever hits it.
export const storeReason = (reason) => briefReason(reason, TEND_REASON_STORE_MAX);

// Both forms of one reason: `brief` for a one-line surface, `full` only when there IS more to read
// (null when the brief line already IS the whole reason — so a caller never renders "more" twice).
export function reasonPair(reason) {
  const full = storeReason(reason);
  const brief = briefReason(full);
  return { brief, full: full && full !== brief ? full : null };
}

export async function setTend(xellId, on, { reason = null, zeeId = null, source = 'self' } = {}) {
  const why = storeReason(reason);
  await recordEvent({
    source, hook_event_name: on ? 'tend-request' : 'tend-clear',
    zee_id: zeeId, xell_id: xellId, raw: why ? { reason: why } : null,
  });
  broadcast('xell', { id: xellId });
  return { xell_id: xellId, tend: !!on, reason: briefReason(why), reason_full: why };
}

// The xell's tend as the console needs it: is it open, WHY (brief line + the full text when there
// is more), and since when. Latest-event-wins, exactly like tendOpen — which is now this, narrowed.
export async function tendState(xellId) {
  const row = await one(
    `SELECT hook_event_name, ts, raw->>'reason' AS reason FROM session_event
       WHERE xell_id = $1 AND hook_event_name IN ('tend-request','tend-clear')
       ORDER BY ts DESC LIMIT 1`, [xellId]);
  const open = row?.hook_event_name === 'tend-request';
  const { brief, full } = open ? reasonPair(row.reason) : { brief: null, full: null };
  return { open, reason: brief, full, at: open ? row.ts : null };
}

// Is this xell's tend currently OPEN? (latest tend event is a request, not a clear)
export async function tendOpen(xellId) {
  return (await tendState(xellId)).open;
}

// ── the tend NUDGE: an ANSWERED ask that is still up ───────────────────────────
// The failure this closes (ticket #18): a zee raises a tend, a manager/human answers the question
// (a zee_message arrives), and the flag stays up for an hour — because answering a zee's ask is a
// separate act from lowering the flag it raised, and neither party does the second thing. An open
// tend outranks awaiting-done in the hive derivation, so an already-answered one cries "this zee
// needs you" next to real tends, and teaches humans to skim.
//
// So: whenever a zee reads a self verb's answer while its tend is OPEN and a zee_message to it
// arrived SINCE the tend was raised (created_at > tendState.at), hand it ONE line saying so.
// Deliberately NOT auto-cleared — a tend is the zee's own statement, and only the zee (or its own
// working ping) lowers it; this just makes it impossible to forget. Null when there is nothing to
// say, so callers can carry it on a stable field unconditionally. Pass an already-fetched
// tendState as `tend` to save the extra query (selfStatus has one in hand).
export async function tendNudge(xellId, tend = null) {
  const t = tend ?? await tendState(xellId);
  if (!t.open || !t.at) return null;
  // The FIRST reply since the ask — one indexed probe on (to_xell_id, created_at).
  const reply = await one(
    `SELECT from_slug, created_at FROM zee_message
       WHERE to_xell_id = $1 AND created_at > $2
       ORDER BY created_at ASC LIMIT 1`, [xellId, t.at]);
  if (!reply) return null;
  const mins = Math.max(1, Math.round((Date.now() - new Date(t.at).getTime()) / 60000));
  const age = mins >= 90 ? `${Math.round(mins / 60)} h` : `${mins} min`;
  return `Your tend is still open (raised ${age} ago) and you have had a reply since`
    + `${reply.from_slug ? ` (from ${reply.from_slug})` : ''}`
    + ' — clear it with `zee tend --clear` if it is handled.';
}

// ── the zee's READINESS HINT (hint-land / hint-ship) ────────────────────────────
// A zee that is NOT 100% certain the job is done — so it must NOT call the real, gated `zee land`
// / `zee ship` — but HAS reached a landable/shippable checkpoint, drops a HINT: "human, this looks
// ready — consider it." Like tend it opens no gate and blocks nothing; unlike tend it maps to a
// specific verb, so the hive can surface the exact button (land? / ship?) a human would click.
// Same append-only session_event ride as tend (the dev schema is frozen): the OPEN state of a
// hint is whether its LATEST event is a '<kind>hint-request' (vs '<kind>hint-clear'). kind is
// 'land' or 'ship'. Cleared explicitly (`--clear`) or superseded once a real land/ship request or
// done request outranks it in the hive-status derivation.
const HINT_KINDS = new Set(['land', 'ship']);
export async function setHint(xellId, kind, on, { reason = null, zeeId = null, source = 'self' } = {}) {
  if (!HINT_KINDS.has(kind)) throw new Error(`unknown hint kind '${kind}' — use 'land' or 'ship'`);
  await recordEvent({
    source, hook_event_name: on ? `${kind}hint-request` : `${kind}hint-clear`,
    zee_id: zeeId, xell_id: xellId, raw: reason ? { reason } : null,
  });
  broadcast('xell', { id: xellId });
  return { xell_id: xellId, kind, hint: !!on, reason };
}

// Is this xell's <kind> hint currently OPEN? (latest hint event of that kind is a request)
export async function hintOpen(xellId, kind) {
  if (!HINT_KINDS.has(kind)) return false;
  const row = await one(
    `SELECT hook_event_name FROM session_event
       WHERE xell_id = $1 AND hook_event_name IN ($2, $3)
       ORDER BY ts DESC LIMIT 1`, [xellId, `${kind}hint-request`, `${kind}hint-clear`]);
  return row?.hook_event_name === `${kind}hint-request`;
}

// ── a ship ask that was REFUSED (the one ask that used to leave no trace) ──────
// `requestShip` can refuse outright — the work is not landed, the tree is dirty, the ship ref will
// not resolve — and when it does, NO ship_request row exists. That was the whole of the record: a
// line in the queenzee's ring-buffer log, gone on the next restart. So a zee could ask to ship, be
// refused, tell its human "the ship request is waiting for you", and the human would open the
// console and see nothing at all — because there was nothing to see. Reported as "xells insist they
// have ship requests… i see zero".
//
// A refusal is now RECORDED, on the same append-only session_event ride tend/hints use (no DDL,
// the shared schema is frozen): latest-event-wins between 'ship-refused' and 'ship-refused-clear',
// with the reason in raw. It is not a gate and not a request — nothing is held and nothing is
// pending. It is evidence, so the answer to "did anyone ask?" is a fact on the screen rather than
// a zee's word against an empty panel. A successful request (or a decided one) clears it.
export async function setShipRefusal(xellId, reason, { zeeId = null, source = 'self' } = {}) {
  const why = storeReason(reason);
  await recordEvent({
    source, hook_event_name: 'ship-refused',
    zee_id: zeeId, xell_id: xellId, raw: why ? { reason: why } : null,
  });
  broadcast('xell', { id: xellId });
  return { xell_id: xellId, refused: true, reason: briefReason(why), reason_full: why };
}

// The refusal stops being true the moment a real request exists (or the zee lands the work), so
// clearing is part of the same verb rather than a human's chore.
export async function clearShipRefusal(xellId, { zeeId = null, source = 'self' } = {}) {
  await recordEvent({
    source, hook_event_name: 'ship-refused-clear',
    zee_id: zeeId, xell_id: xellId, raw: null,
  });
  broadcast('xell', { id: xellId });
  return { xell_id: xellId, refused: false };
}

// The xell's last ship ask, if it was refused and nothing has superseded it. Same shape as
// tendState: brief line for a chip, full text for the opened ask.
export async function shipRefusalState(xellId) {
  const row = await one(
    `SELECT hook_event_name, ts, raw->>'reason' AS reason FROM session_event
       WHERE xell_id = $1 AND hook_event_name IN ('ship-refused','ship-refused-clear')
       ORDER BY ts DESC LIMIT 1`, [xellId]);
  const refused = row?.hook_event_name === 'ship-refused';
  const { brief, full } = refused ? reasonPair(row.reason) : { brief: null, full: null };
  return { refused, reason: brief, full, at: refused ? row.ts : null };
}

// A zee PINGS that it is actively working. Mirrors what a harness UserPromptSubmit hook would do
// (Channel A is not installed for cxell zees), so the hive can show live activity even when the
// passive poller is blind to a cxell. Reporting work also CLEARS any open tend — asking for a human
// and then carrying on would leave a false "needs you".
export async function pingWorking(zee, { note = null } = {}) {
  if (!zee) return { ok: false, error: 'no live zee to mark working' };
  await setZeeStatus(zee, 'working');
  await recordEvent({
    source: 'self', hook_event_name: 'working-ping',
    zee_id: zee.id, xell_id: zee.xell_id, raw: note ? { note } : null,
  });
  if (await tendOpen(zee.xell_id)) await setTend(zee.xell_id, false, { zeeId: zee.id, reason: 'auto-cleared: zee reported working' });
  return { ok: true, zee_id: zee.id, xell_id: zee.xell_id, status: 'working' };
}

// Channel B: reconcile one managed zee against the passive poller's derived state.
export async function projectPoller(zee, live, derived) {
  if (!ACTIVE.includes(zee.status)) return;
  if (!live) {
    await setZeeStatus(zee, 'stopped');
    await recordEvent({ source: 'poller', hook_event_name: 'session-gone',
      claude_session_id: zee.claude_session_id, zee_id: zee.id, xell_id: zee.xell_id });
    return;
  }
  if ((derived === 'working' || derived === 'idle') && derived !== zee.status) {
    await setZeeStatus(zee, derived, { stopReason: derived === 'idle' ? 'end_turn' : null });
    await recordEvent({ source: 'poller', hook_event_name: `derived-${derived}`,
      claude_session_id: zee.claude_session_id, zee_id: zee.id, xell_id: zee.xell_id });
  }
}

export { ACTIVE };
