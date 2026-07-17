// Container health monitor — the deterministic "is it actually running?" oracle. The raw
// probe lives in scripts/check-containers.sh (queenzee runs it, like provision/despawn); this
// Node projector schedules it, maps the Docker state onto our container_health enum, and drives
// the health dots live. Read-only; like the session monitor it trusts the tool, not a model.
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { config } from '../config.js';
import { q, one } from '../db/pool.js';
import { broadcast } from '../lib/events.js';
import { logline } from '../lib/logbus.js';

// Run scripts/check-containers.sh over the given contexts → { ctx: Map<name,info> | null },
// where info = { state, xell, project, role } (the zeehive.* identity labels, null when the
// container is unlabeled) and a null map means the daemon was unreachable (so we report
// 'unknown', never a false 'down').
// ASYNC — this probe crosses the network (remote docker daemons over TCP) every 30 seconds, and
// as a spawnSync it froze the whole event loop for the round-trip. Same clog class as the
// monitor's CLI call; a periodic loop never gets to block the process it lives in.
function runProbe(script, ctxs, timeout = 30000) {
  return new Promise((res) => {
    let child;
    try { child = spawn('bash', [script, ...ctxs], { windowsHide: true }); }
    catch (e) { return res({ stdout: '', error: String(e.message) }); }
    let stdout = '';
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, timeout);
    child.stdout?.on('data', (d) => (stdout += d));
    child.on('error', () => { clearTimeout(t); res({ stdout }); });
    child.on('close', () => { clearTimeout(t); res({ stdout }); });
  });
}

async function probeContexts(ctxs) {
  const script = resolve(config.repoRoot, 'scripts', 'check-containers.sh');
  const r = await runProbe(script, ctxs);
  const byCtx = {};
  for (const ctx of ctxs) byCtx[ctx] = new Map();     // reachable-but-empty by default
  for (const line of (r.stdout || '').split('\n')) {
    if (!line) continue;
    const [ctx, name, state, xell, project, role] = line.split('\t');
    if (!ctx || byCtx[ctx] === undefined) continue;
    if (name === '__UNREACHABLE__') byCtx[ctx] = null;
    else if (name) {
      byCtx[ctx].set(name, {
        state,
        xell: xell && xell !== '-' ? xell : null,
        project: project && project !== '-' ? project : null,
        role: role && role !== '-' ? role : null,
      });
    }
  }
  return byCtx;
}

// Docker state → container_health enum.
function toHealth(state) {
  if (state === 'running') return 'up';
  // NOTHING HERE MAY EVER RETURN 'building'. That state is owned exclusively by buildContainer,
  // and the monitor SKIPS a 'building' row (below) precisely so it can't clobber a live build's
  // spinner. So any docker state mapped to 'building' here becomes PERMANENT: the row is skipped
  // from then on, no build exists to finish it, and it survives even recoverOrphanBuilds() —
  // which hands the row back as 'unknown' only for this mapping to re-stamp 'building' next tick.
  //
  // 'created'    — compose made the container and never started it (an interrupted build). Not
  //                running, nothing building it → DOWN, so a human/zee knows to rebuild.
  // 'restarting' — the restart policy is bouncing it after a crash. This USED to map to
  //                'building' and had exactly the failure above: one crash-loop pinned the chip's
  //                spinner forever, and it stayed spinning long after the container recovered.
  //                A crash-looping container is not being built by anyone — it is broken. Say
  //                DOWN. If it is merely bouncing, the very next tick sees 'running' and says up;
  //                a truthful one-tick 'down' beats a permanent lie.
  if (state === 'created' || state === 'restarting') return 'down';
  return 'down'; // exited | paused | dead | removing
}

// Health priority so the "best" candidate wins when several containers match a modeled
// name (e.g. a stale exited `omnibiz_db_prod` alongside the running `omnibiz_db_prod_v184`).
const STATE_RANK = { running: 5, restarting: 4, created: 3, paused: 2, exited: 1, dead: 0 };

// Resolve the real container matching a modeled row. Labels first (spec §3.3): a container
// stamped with this row's exact identity (zeehive.project + role + xell slug) matches regardless
// of its name — exact, no heuristics. Fallback for the pre-label fleet: modeled name exact OR a
// versioned suffix (omnibiz_db_dev → omnibiz_db_dev_gis, omnibiz_db_prod → omnibiz_db_prod_v184),
// preferring the healthiest match so a leftover stopped copy never masks the live one.
function matchState(psMap, c) {
  let best = null, bestRank = -1;
  const consider = (state) => {
    const rank = STATE_RANK[state] ?? 0;
    if (rank > bestRank) { best = state; bestRank = rank; }
  };
  if (c.project_token) {
    for (const info of psMap.values()) {
      if (info.project !== c.project_token || info.role !== c.role) continue;
      if ((info.xell || null) !== (c.xell_slug || null)) continue;
      consider(info.state);
    }
    if (best != null) return best;
  }
  for (const [real, info] of psMap) {
    if (real !== c.name && !real.startsWith(c.name + '_')) continue;
    consider(info.state);
  }
  return best; // null if no candidate on that daemon
}

// Orphan memory: which labeled-but-unmodeled containers we've already reported, so the log
// says it once per appearance instead of every 30-second tick.
let knownOrphans = '';
// Same discipline for the health summary line: repeat it only when it changes.
let lastHealthLine = '';

export async function checkContainers() {
  // project/xell identity rides along so labeled containers match exactly (sanitized project
  // token = what the compose labels carry, mirroring lib/manifest.js sanitizeName).
  const containers = await q(
    `SELECT c.id, c.name, c.docker_ctx, c.health, c.role,
            lower(regexp_replace(p.name, '[^a-zA-Z0-9]', '', 'g')) AS project_token,
            x.slug AS xell_slug
       FROM container c
       JOIN project p ON p.id = c.project_id
       LEFT JOIN xell x ON x.id = c.owner_xell_id
      WHERE c.docker_ctx IS NOT NULL`);

  // one script run over every distinct context (queenzee's deterministic probe). No early return
  // on empty — process roles (below) are probed by URL and exist without any docker rows.
  const psByCtx = containers.length
    ? await probeContexts([...new Set(containers.map((c) => c.docker_ctx))])
    : {};

  let up = 0, down = 0, unknown = 0, changed = 0, busy = 0;
  for (const c of containers) {
    // A build owns the 'building' state — don't clobber it from `docker ps`. Mid-build the old
    // container may still be Up (or already gone), and overwriting it would kill the UI spinner
    // and lie about what's happening. buildContainer sets the real health when it finishes.
    if (c.health === 'building') { busy++; continue; }
    const ps = psByCtx[c.docker_ctx];
    let health;
    if (ps == null) health = 'unknown';                 // unreachable daemon — don't claim 'down'
    else {
      const state = matchState(ps, c);
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
  // ── orphan reconciliation (spec §3.3/7.3.2) ─────────────────────────────────
  // A container CARRYING zeehive.* labels that no modeled row accounts for is an orphan: either
  // its row was deleted while the container survived (a failed teardown) or something outside
  // the queenzee created it. Exact by construction — labels are identity, not heuristics.
  // Logged once per appearance, not per tick.
  const modeled = new Set(containers.map((c) => `${c.docker_ctx}\0${c.name}`));
  const orphans = [];
  for (const [ctx, psMap] of Object.entries(psByCtx)) {
    if (psMap == null) continue;
    for (const [name, info] of psMap) {
      if (!info.project) continue;                       // unlabeled → not ours to claim
      if (modeled.has(`${ctx}\0${name}`)) continue;      // exact row exists
      // versioned-suffix rows (omnibiz_db_prod → _v184) are accounted for by their base row
      if (containers.some((c) => c.docker_ctx === ctx && name.startsWith(c.name + '_'))) continue;
      orphans.push(`${name}@${ctx} (project=${info.project}${info.xell ? `, xell=${info.xell}` : ''})`);
    }
  }
  const orphanKey = orphans.sort().join('; ');
  if (orphanKey && orphanKey !== knownOrphans) {
    logline('containers', `ORPHANED zeehive-labeled container(s) with no modeled row: ${orphanKey} — `
      + 'a teardown lost track of them, or something outside the queenzee made them. They are not '
      + 'monitored and will never be reaped; remove or re-model them.');
  }
  knownOrphans = orphanKey;

  // ── process roles (spec §6.1: runner: process) ──────────────────────────────
  // Rows with NO docker_ctx but a url are local processes, not containers (Zeehive's own server
  // and web app). `docker ps` cannot see them; the URL answering IS their health.
  const procs = await q(
    `SELECT id, name, url, health FROM container
      WHERE docker_ctx IS NULL AND url IS NOT NULL AND health <> 'building'`);
  for (const c of procs) {
    let health = 'down';
    try {
      const r = await fetch(c.url, { signal: AbortSignal.timeout(5000) });
      health = r.status < 500 ? 'up' : 'down';
    } catch { health = 'down'; }
    if (health === 'up') up++; else down++;
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
  // Change-only: this ran every 30s and said the same thing every 30s, which in a shared
  // terminal is noise wearing a uniform. Note `changed` is part of the line, so any actual
  // health movement always logs.
  const healthLine = `docker health: ${up} up · ${down} down · ${unknown} unknown${busy ? ` · ${busy} building (skipped)` : ''}${procs.length ? ` (incl. ${procs.length} process role(s) by URL)` : ''}${unreach.length ? ` (unreachable: ${unreach.join(', ')})` : ''}${changed ? ` · ${changed} changed` : ''}${orphans.length ? ` · ${orphans.length} ORPHANED` : ''}`;
  if (healthLine !== lastHealthLine) { lastHealthLine = healthLine; logline('containers', healthLine); }
  return { up, down, unknown, changed, building: busy, unreachable: unreach, orphans };
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
