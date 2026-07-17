// Monitor — confirms a zee's session is REALLY active per the `claude` CLI itself, not
// per the model. Local/headless zees are checked against `claude agents --json`; remote
// zees against `claude remote list`/`status`. Writes zee.cli_active + surfaces it live.
import { existsSync } from 'node:fs';
import { config } from '../config.js';
import { q, one } from '../db/pool.js';
import { listActiveAgents, remoteList, remoteStatus } from '../lib/claude-cli.js';
import { broadcast } from '../lib/events.js';
import { sessionTitle } from '../lib/session-title.js';
import { worktreeDiff } from '../lib/git.js';
import { logline } from '../lib/logbus.js';

async function setActive(zee, active, source) {
  const prev = zee.cli_active;
  // also refresh the human session title the provider shows (Claude Code / Codex sidebar)
  const title = sessionTitle(zee.claude_session_id) || zee.title || null;
  const row = await one(
    `UPDATE zee SET cli_active=$2, monitor_source=$3, title=$4, last_monitor_at=now() WHERE id=$1 RETURNING *`,
    [zee.id, active, source, title]);
  if (row && (prev !== active || zee.title !== title)) {
    broadcast('zee', row);
    if (prev !== active) logline('monitor', `zee ${zee.title || zee.name || zee.claude_session_id?.slice(0, 8) || zee.id.slice(0, 8)} → ${active ? 'REALLY ACTIVE' : 'not active'} (via ${source})`);
  }
  return row;
}

// ── stale claims: the xell leak ──────────────────────────────────────────────
//
// A failed dispatch strands its xell. `releaseXell` only fires on ONE path (the first-event race
// in spawnHeadless); a zee that dies AFTER init just leaves the xell 'claimed'. And the pool
// reconciler only ever looks at status='ready', so a claimed xell is invisible to it — forever.
// Real case: hotel-complimentary-…-43330c sat 'claimed' from 11:50 (its zee exited -1) until a
// human clicked "Mark done" at 16:34. Nothing automatic would EVER have freed it.
//
// The dangerous half: releasing a xell back to 'ready' hands it to the reconciler, which
// DECOMMISSIONS anything dirty or diverged — i.e. deletes the worktree. A session that merely
// ended (zee 'stopped') can still hold uncommitted work, and a past session reaped Mark's live
// DTR zee exactly this way. So: never release a xell that has anything to lose. Unlanded work is
// a HUMAN's call (House rule 4) — we surface it and leave it alone.
// Say it when it CHANGES, not every 12 seconds. The terminal was ~90% verbatim repeats of the
// census and stale-claim lines — continuous housekeeping noise that drowned the lines that
// actually carried news (a ship's build feed scrolled past in it). The map remembers the last
// thing said per key; an identical line is silence, a changed one logs.
const lastSaid = new Map();
function logChanged(key, msg) {
  if (lastSaid.get(key) === msg) return;
  lastSaid.set(key, msg);
  logline('monitor', msg);
}

async function reclaimStaleClaims() {
  const stale = await q(
    `SELECT x.id, x.slug, x.worktree_path, x.project_id
       FROM xell x
      WHERE x.status = 'claimed' AND NOT x.is_production
        -- nobody is in there: no zee spawning/online/working, and not even idle (an idle zee is
        -- how a one-shot dispatched zee legitimately waits for its human to prompt it again)
        AND NOT EXISTS (SELECT 1 FROM zee z WHERE z.xell_id = x.id
                          AND z.status IN ('spawning','online','working','idle'))
        -- it HAD a zee, and that zee is done for: errored, or its session stopped
        AND EXISTS (SELECT 1 FROM zee z WHERE z.xell_id = x.id)
        AND (SELECT z.status FROM zee z WHERE z.xell_id = x.id
              ORDER BY z.created_at DESC LIMIT 1) IN ('errored','stopped')`);
  // A claim that stops being stale (resumed, or Marked done) must be able to log again if it
  // ever goes stale anew — forget the silenced lines of everything not in this batch.
  const staleKeys = new Set(stale.map((x) => `stale:${x.slug}`));
  for (const k of lastSaid.keys()) {
    if (k.startsWith('stale:') && !staleKeys.has(k)) lastSaid.delete(k);
  }
  if (!stale.length) return 0;

  let freed = 0;
  for (const x of stale) {
    const project = await one(`SELECT main_branch FROM project WHERE id=$1`, [x.project_id]);
    const src = project?.main_branch || 'main';

    // REPORT ONLY — never repool, never decommission. A claimed xell ends exactly two ways, both
    // human: /xell-done typed, or "Mark done" clicked (Mark, 2026-07-16). This function used to
    // hand dead-zee-clean-tree claims back to the pool, where the trimmer deletes the surplus —
    // but "clean tree, quiet zee" is ALSO precisely what a xell looks like the moment its work
    // lands and ships, resting between strides. Automation cannot tell an abandoned claim from a
    // workspace mid-job, so it no longer tries; it says what it sees and a human decides. (A past
    // session's automation reaped a live DTR zee — House rule 2 exists because of it.)
    if (!x.worktree_path || !existsSync(x.worktree_path)) {
      logChanged(`stale:${x.slug}`,
        `stale claim ${x.slug}: zee is gone and its worktree is missing from disk. Not touching it — `
        + 'if it is finished, Mark done releases it.');
      continue;
    }
    const d = worktreeDiff(x.worktree_path, src);
    logChanged(`stale:${x.slug}`,
      `stale claim ${x.slug}: zee is gone (${d.ahead} commit(s) unlanded, ${d.dirty} dirty file(s)). `
      + 'Not touching it — resume it, or Mark done when it is finished.');
  }
  return freed;
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
  // This line used to say "housekeeping" while doing nothing but counting — which is how a leak
  // sat in plain sight for hours: the census cheerfully reported a dead xell as "busy".
  const freed = await reclaimStaleClaims().catch((e) => { console.error('[monitor] reclaim:', e.message); return 0; });
  logChanged('census', `census: ${zees.length} live zee(s) · xells ${cen.busy} busy / ${cen.ready} ready · prod ${cen.prod}`
    + (freed ? ` · reclaimed ${freed} stale claim(s)` : ''));
  if (!zees.length) return { checked: 0, freed };

  const local = zees.filter((z) => z.runtime_key !== 'claude-code-remote');
  const remote = zees.filter((z) => z.runtime_key === 'claude-code-remote');

  // local/headless: one CLI call, cross-check session ids.
  // TRUST IT ONLY WHEN IT ANSWERED. listActiveAgents() returns {ok:false, agents:[]} on any
  // failure (timeout, busy binary, transient), and an unchecked empty list is indistinguishable
  // from "every session is dead" — one hiccup marked the whole local fleet inactive in a single
  // tick (two zees flipped in the same second, 2026-07-16 01:30:30Z). Same failure class the
  // codebase already paid for twice: the ETIMEDOUT that took the pool loops down, and the crashed
  // prod-guard that failed open. No answer = no verdict; skip the pass and say so.
  if (local.length) {
    const agents = await listActiveAgents();
    if (!agents.ok) {
      logline('monitor', `agents-json unreadable (${agents.error || 'unknown'}) — skipping liveness pass; `
        + 'nobody gets marked dead on a failed reading');
    } else {
      const active = new Set(agents.agents.map((a) => a.sessionId));
      for (const z of local) {
        await setActive(z, z.claude_session_id ? active.has(z.claude_session_id) : false, 'agents-json');
      }
    }
  }

  // remote: one `claude remote list`, then per-session status if needed
  if (remote.length) {
    const rl = await remoteList();
    const activeRefs = new Set((rl.sessions || []).map((s) => s.id || s.sessionId || s.name).filter(Boolean));
    for (const z of remote) {
      let active = false;
      const key = z.claude_session_id || z.remote_ref;
      if (rl.ok && key) active = activeRefs.has(key);
      else if (!rl.ok && key) active = (await remoteStatus(key)).active; // fallback per-session probe
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
