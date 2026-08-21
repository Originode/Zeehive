// Queenzee activity log — a ring buffer + live broadcast so the web app's terminal modal
// can show what the orchestrator is doing (checks, updates, maintenance, decommission).
import { broadcast } from './events.js';

// Queenzee↔xell ACTIVITY events, the honeycomb's animated-line feed. A high-level counterpart
// to logline: logline says WHAT the queenzee did in text; this says WHICH xell an interaction
// touched, in a shape the canvas can animate. Emitted only at the moments a human wants to SEE —
// provisioning/housekeeping/reaping are queenzee→xell, and a zee's land/push/ship-request is
// xell→queenzee — and capped client-side so a busy fleet does not clutter the honeycomb.
//
// project_id is carried AT THE SOURCE so a multi-project console can scope the fan-out before
// the write (see activityFanout in events.js): the callers of activity() already hold the
// project (they resolved the xell row or the project row to do their job), so passing it here
// costs no DB round trip on the hot path — the alternative, resolving xell→project per event,
// would add a query to every emit. A scoped connection drops an event whose project_id is
// missing or different, so an un-stamped event never leaks to a browser it does not belong to.
export function activity(dir, xellId, kind, projectId) {
  if (!xellId) return null;
  const line = { dir, xell_id: xellId, kind, ts: Date.now(), project_id: projectId || null };
  broadcast('queenzee-activity', line);
  return line;
}

// Big enough that a full docker-build feed (a ship streams every build line here) doesn't evict
// the rest of the queenzee's recent history on its way through.
const MAX = 2000;
const ring = [];
let seq = 0;

// scope: 'poller' | 'monitor' | 'pool' | 'maint' | 'reaper' | 'intake' | 'lock' | 'api'
export function logline(scope, msg) {
  const line = { seq: ++seq, ts: Date.now(), scope, msg: String(msg) };
  ring.push(line);
  if (ring.length > MAX) ring.shift();
  broadcast('log', line);
  return line;
}

export function recentLogs(n = 200) {
  return ring.slice(-n);
}
