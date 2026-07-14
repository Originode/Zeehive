// Queenzee activity log — a ring buffer + live broadcast so the web app's terminal modal
// can show what the orchestrator is doing (checks, updates, maintenance, decommission).
import { broadcast } from './events.js';

const MAX = 500;
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
