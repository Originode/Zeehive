// Tiny in-process event bus for SSE fan-out. Queenzee/API emit; /api/stream subscribes.
import { EventEmitter } from 'node:events';

export const bus = new EventEmitter();
bus.setMaxListeners(200);

// type: 'zee' | 'xell' | 'container' | 'task' | 'tick'
export function broadcast(type, payload) {
  bus.emit('event', { type, payload, ts: Date.now() });
}

// ── per-connection queenzee-activity fan-out bound ─────────────────────────────
// The honeycomb's activity feed used to ride every bus event out to every connection: a fleet
// storm (mass provision/land) pushed N events to every connected console, and a project-A tab
// received project-B's arrows and dropped them client-side — wasted fan-out and a privacy smell.
// The client's own caps (14 arrows / 32 buffered) apply AFTER the wire; these bounds apply
// before it, per connection:
//
//   1. PROJECT SCOPING — a connection that asked for a project (via ?project=<id>) receives only
//      the queenzee-activity events whose project_id matches. The events carry project_id from
//      the source (activity() in logbus.js); we filter before the write, so project-B's arrows
//      never reach a project-A browser. An unscoped connection (?project absent) still gets every
//      event, exactly as before — it is the whole-fleet view.
//
//   2. BURST CAP — same (xell_id, dir) events within a flush window collapse to ONE frame (the
//      latest wins; the canvas replaces same-key arrows anyway), and the pending set is capped at
//      ACTIVITY_MAX_PENDING distinct arrows, so a mass provision cannot fan out unboundedly.
//      Sticky ship→production arrows are preferred over flash arrows when the cap forces a drop.
//
//   What happens to event #1 in a quiet system: it is delivered on the very next flush (≤
//   ACTIVITY_FLUSH_MS ≈ 20ms), un-coalesced — there is nothing else in the window to collapse it
//   into. The bound only bites once a burst pushes the pending set past the cap; the one-at-a-time
//   case pays only a single 20ms trailing-edge tick.
export const ACTIVITY_FLUSH_MS = 20;      // trailing-edge flush after the last event in a burst
export const ACTIVITY_MAX_PENDING = 16;   // most distinct arrows buffered per connection at once

// Build the bus handler + close() for ONE stream connection. `projectId` is the connection's
// ?project=<id> (null/'' = whole-fleet view); `send` is the per-frame write. Non-activity events
// ride through unchanged — this bounds only the queenzee-activity fan-out, not the SSE layer.
export function activityFanout(projectId, send) {
  const pending = new Map();   // `${xell_id}:${dir}` → the latest activity event for that arrow
  let timer = null;

  const flush = () => {
    timer = null;
    // pending holds the PAYLOAD (the activity line); the stream writers want the full frame.
    for (const ev of pending.values()) send({ type: 'queenzee-activity', payload: ev });
    pending.clear();
  };

  const onEvent = (e) => {
    if (e.type !== 'queenzee-activity') return send(e);
    const ev = e.payload || {};
    // Project-scope the activity feed: a project-scoped connection sees only its own project's
    // arrows. An event with a missing/unattributable project_id is dropped too — the caller was
    // supposed to stamp it at the source, and a scoped browser has no business seeing it.
    if (projectId && ev.project_id !== projectId) return;
    if (!ev.xell_id || !ev.dir) return;   // malformed — nothing for the canvas to draw
    const key = `${ev.xell_id}:${ev.dir}`;
    pending.set(key, ev);                 // same arrow → the latest frame wins (coalescing)
    while (pending.size > ACTIVITY_MAX_PENDING) {
      // Prefer evicting a flash arrow over a sticky ship→production line mid-deploy.
      let oldest = null;
      for (const [k, v] of pending) {
        const sticky = v.kind === 'ship' && v.dir === 'q2x';
        if (sticky) continue;
        oldest = k; break;
      }
      if (oldest === null) oldest = pending.keys().next().value;   // all sticky — drop the oldest
      pending.delete(oldest);
    }
    if (!timer) timer = setTimeout(flush, ACTIVITY_FLUSH_MS);
  };

  const close = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    pending.clear();
  };
  return { onEvent, close };
}
