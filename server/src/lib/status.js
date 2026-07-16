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
