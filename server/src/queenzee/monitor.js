// Monitor — confirms a zee's session is REALLY active per the `claude` CLI itself, not
// per the model. Local/headless zees are checked against `claude agents --json`; remote
// zees against `claude remote list`/`status`. Writes zee.cli_active + surfaces it live.
import { config } from '../config.js';
import { q, one } from '../db/pool.js';
import { listActiveAgents, remoteList, remoteStatus } from '../lib/claude-cli.js';
import { broadcast } from '../lib/events.js';
import { logline } from '../lib/logbus.js';

async function setActive(zee, active, source) {
  const prev = zee.cli_active;
  const row = await one(
    `UPDATE zee SET cli_active=$2, monitor_source=$3, last_monitor_at=now() WHERE id=$1 RETURNING *`,
    [zee.id, active, source]);
  if (row && prev !== active) {
    broadcast('zee', row);
    logline('monitor', `zee ${zee.name || zee.claude_session_id?.slice(0, 8) || zee.id.slice(0, 8)} → ${active ? 'REALLY ACTIVE' : 'not active'} (via ${source})`);
  }
  return row;
}

export async function monitorTick() {
  const zees = await q(
    `SELECT z.*, r.key AS runtime_key FROM zee z
       LEFT JOIN agent_runtime r ON r.id = z.runtime_id
      WHERE z.status IN ('spawning','online','working','idle')`);
  // regular census of the fleet so the terminal shows continuous housekeeping
  const cen = await one(
    `SELECT count(*) FILTER (WHERE NOT is_production AND status='ready') ready,
            count(*) FILTER (WHERE NOT is_production AND status IN ('working','idle','claimed','awaiting-done')) busy,
            count(*) FILTER (WHERE is_production) prod FROM xell WHERE status<>'retired'`);
  logline('monitor', `housekeeping: ${zees.length} live zee(s) · xells ${cen.busy} busy / ${cen.ready} ready · prod ${cen.prod}`);
  if (!zees.length) return { checked: 0 };

  const local = zees.filter((z) => z.runtime_key !== 'claude-code-remote');
  const remote = zees.filter((z) => z.runtime_key === 'claude-code-remote');

  // local/headless: one CLI call, cross-check session ids
  if (local.length) {
    const active = new Set(listActiveAgents().agents.map((a) => a.sessionId));
    for (const z of local) {
      await setActive(z, z.claude_session_id ? active.has(z.claude_session_id) : false, 'agents-json');
    }
  }

  // remote: one `claude remote list`, then per-session status if needed
  if (remote.length) {
    const rl = remoteList();
    const activeRefs = new Set((rl.sessions || []).map((s) => s.id || s.sessionId || s.name).filter(Boolean));
    for (const z of remote) {
      let active = false;
      const key = z.claude_session_id || z.remote_ref;
      if (rl.ok && key) active = activeRefs.has(key);
      else if (!rl.ok && key) active = remoteStatus(key).active; // fallback per-session probe
      await setActive(z, active, rl.ok ? 'remote-list' : 'remote-status');
    }
  }
  return { checked: zees.length, local: local.length, remote: remote.length };
}

export function startMonitor() {
  if (process.env.MONITOR_ENABLED === 'false') {
    console.log('[queenzee] active-session monitor DISABLED (MONITOR_ENABLED=false)');
    return null;
  }
  const interval = Number(process.env.MONITOR_INTERVAL_MS) || 12000;
  console.log(`[queenzee] active-session monitor started (${interval}ms)`);
  const tick = () => monitorTick().catch((e) => console.error('[monitor]', e.message));
  tick();
  return setInterval(tick, interval);
}
