// Channel B loop — reconciles managed zees against harness-written session files.
// Runs regardless of hooks; it's the fallback/audit that needs no agent cooperation.
import { config } from '../config.js';
import { q } from '../db/pool.js';
import { liveSessions, transcriptState } from '../lib/sessions.js';
import { projectPoller } from '../lib/status.js';
import { broadcast } from '../lib/events.js';

export function startPoller() {
  if (process.env.POLLER_ENABLED === 'false') {
    console.log('[queenzee] passive poller DISABLED (POLLER_ENABLED=false)');
    return null;
  }
  const tick = async () => {
    try {
      const live = liveSessions();
      const byId = new Map(live.map((s) => [s.sessionId, s]));
      const zees = await q(
        `SELECT * FROM zee
           WHERE status IN ('spawning','online','working','idle')
             AND claude_session_id IS NOT NULL
             -- cxell zees (claude/codex/kimi alike): the session lives INSIDE the container, so
             -- the host session registry can never see it — this pass would stamp every one
             -- 'session-gone' within a tick (seen live 2026-07-21 on a codex probe). Their
             -- liveness check is the monitor's in-container pgrep, not host session files.
             AND entrypoint <> 'cxell-cli'`);
      for (const zee of zees) {
        const s = byId.get(zee.claude_session_id);
        const isLive = !!(s && s.alive);
        const derived = isLive ? transcriptState(zee.claude_session_id, s.cwd || zee.cwd).state : 'unknown';
        await projectPoller(zee, isLive, derived);
      }
      broadcast('tick', { live: live.length, zees: zees.length });
    } catch (err) {
      console.error('[poller]', err.message);
    }
  };
  tick();
  return setInterval(tick, config.pollerIntervalMs);
}
