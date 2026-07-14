// Container health monitor — the deterministic "is it actually running?" oracle. The raw
// probe lives in scripts/check-containers.sh (queenzee runs it, like provision/despawn); this
// Node projector schedules it, maps the Docker state onto our container_health enum, and drives
// the health dots live. Read-only; like the session monitor it trusts the tool, not a model.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { config } from '../config.js';
import { q, one } from '../db/pool.js';
import { broadcast } from '../lib/events.js';
import { logline } from '../lib/logbus.js';

// Run scripts/check-containers.sh over the given contexts → { ctx: Map<name,state> | null },
// where null means the daemon was unreachable (so we report 'unknown', never a false 'down').
function probeContexts(ctxs) {
  const script = resolve(config.repoRoot, 'scripts', 'check-containers.sh');
  const r = spawnSync('bash', [script, ...ctxs], { encoding: 'utf8', timeout: 30000, windowsHide: true });
  const byCtx = {};
  for (const ctx of ctxs) byCtx[ctx] = new Map();     // reachable-but-empty by default
  for (const line of (r.stdout || '').split('\n')) {
    if (!line) continue;
    const [ctx, name, state] = line.split('\t');
    if (!ctx || byCtx[ctx] === undefined) continue;
    if (name === '__UNREACHABLE__') byCtx[ctx] = null;
    else if (name) byCtx[ctx].set(name, state);
  }
  return byCtx;
}

// Docker state → container_health enum.
function toHealth(state) {
  if (state === 'running') return 'up';
  if (state === 'restarting' || state === 'created') return 'building';
  return 'down'; // exited | paused | dead | removing
}

// Health priority so the "best" candidate wins when several containers match a modeled
// name (e.g. a stale exited `omnibiz_db_prod` alongside the running `omnibiz_db_prod_v184`).
const STATE_RANK = { running: 5, restarting: 4, created: 3, paused: 2, exited: 1, dead: 0 };

// Resolve the real container matching a modeled name: exact OR a versioned suffix
// (omnibiz_db_dev → omnibiz_db_dev_gis, omnibiz_db_prod → omnibiz_db_prod_v184), preferring
// the healthiest match so a leftover stopped copy never masks the live one.
function matchState(psMap, name) {
  let best = null, bestRank = -1;
  for (const [real, state] of psMap) {
    if (real !== name && !real.startsWith(name + '_')) continue;
    const rank = STATE_RANK[state] ?? 0;
    if (rank > bestRank) { best = state; bestRank = rank; }
  }
  return best; // null if no candidate on that daemon
}

export async function checkContainers() {
  const containers = await q(`SELECT id, name, docker_ctx, health FROM container WHERE docker_ctx IS NOT NULL`);
  if (!containers.length) return { up: 0, down: 0, unknown: 0, changed: 0 };

  // one script run over every distinct context (queenzee's deterministic probe)
  const psByCtx = probeContexts([...new Set(containers.map((c) => c.docker_ctx))]);

  let up = 0, down = 0, unknown = 0, changed = 0;
  for (const c of containers) {
    const ps = psByCtx[c.docker_ctx];
    let health;
    if (ps == null) health = 'unknown';                 // unreachable daemon — don't claim 'down'
    else {
      const state = matchState(ps, c.name);
      health = state == null ? 'down' : toHealth(state);
    }
    if (health === 'up') up++; else if (health === 'down') down++; else unknown++;
    if (health !== c.health) {
      const row = await one(
        `UPDATE container SET health = $2::container_health,
             last_seen_at = CASE WHEN $2::container_health = 'up' THEN now() ELSE last_seen_at END
           WHERE id=$1 RETURNING *`, [c.id, health]);
      if (row) broadcast('container', row);
      changed++;
    }
  }
  const unreach = Object.entries(psByCtx).filter(([, m]) => m == null).map(([k]) => k);
  logline('containers', `docker health: ${up} up · ${down} down · ${unknown} unknown${unreach.length ? ` (unreachable: ${unreach.join(', ')})` : ''}${changed ? ` · ${changed} changed` : ''}`);
  return { up, down, unknown, changed, unreachable: unreach };
}

export function startContainerMonitor() {
  if (process.env.CONTAINER_MONITOR_ENABLED === 'false') {
    console.log('[queenzee] container health monitor DISABLED (CONTAINER_MONITOR_ENABLED=false)');
    return null;
  }
  const interval = Number(process.env.CONTAINER_MONITOR_INTERVAL_MS) || 30000;
  console.log(`[queenzee] container health monitor started (${interval}ms)`);
  const tick = () => checkContainers().catch((e) => console.error('[containers]', e.message));
  tick();
  return setInterval(tick, interval);
}
