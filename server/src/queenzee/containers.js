// Container health monitor — the deterministic "is it actually running?" oracle. lib/docker.js
// asks each daemon over its HTTP API; this Node projector schedules the probe, maps the Docker
// state onto our container_health enum, and drives the health dots live. Read-only; like the
// session monitor it trusts the tool, not a model.
import { q, one } from '../db/pool.js';
import { broadcast } from '../lib/events.js';
import { logline } from '../lib/logbus.js';
import { dockerPs, stopAndRemoveContainer, removeImage } from '../lib/docker.js';
import { deviceBootState } from '../lib/devices.js';
import { machineDbHost } from '../lib/machines.js';
import { derivedTcpDsn } from '../lib/xell-db.js';
import { config } from '../config.js';
import { probeGatewayHealth } from './gateway-health.js';
import { markJoinedMeshPeers } from '../lib/netbird.js';

// Probe every context → { ctx: Map<name,info> | null }, where info = { state, xell, project,
// role } (the zeehive.* identity labels, null when the container is unlabeled) and a null map
// means the daemon could not be reached, so we report 'unknown' and never a false 'down'.
//
// THE DISTINCTION IS THE WHOLE JOB. This previously shelled out to bash and inferred the fleet
// from the script's STDOUT, treating empty output as "reachable, no containers". When `bash`
// itself failed to run (WSL shadowing Git bash on PATH — exits 1, complains on stderr, stdout
// empty) that inference marked all 35 modeled containers `down` while the entire fleet was up.
// A probe that cannot run must be UNKNOWN. Only a daemon that answers can testify that something
// is absent, so the only path to `down` is a successful response that omits the container.
// Contexts are probed concurrently: one slow daemon shouldn't delay the others.
async function probeContexts(ctxs) {
  const byCtx = {};
  await Promise.all(ctxs.map(async (ctx) => {
    try {
      byCtx[ctx] = await dockerPs(ctx);
    } catch (e) {
      byCtx[ctx] = null;                              // unreachable → 'unknown', never 'down'
      logline('containers', `docker probe FAILED for context '${ctx}': ${e.message} — reporting `
        + 'its containers as unknown (not down); health for that daemon is stale until it answers.');
    }
  }));
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

// WHERE A PROCESS ROLE ACTUALLY IS — ticket #8 + TKT-136 defect #2.
//
// A `runner: process` role has no container: the queenzee spawns it as its OWN child
// (lib/build.js → scripts/start-xell-process.sh), so it shares the QUEENZEE's network namespace.
// It is reachable on the queenzee's localhost AND on whatever hostname a cxell already uses to
// reach the queenzee API (CXELL_API_BASE — `zeehive_server` on the hive net, or
// `host.docker.internal` in the host-era).
//
// Ticket #8: the health sweep used to probe only the row's `url`, which was stamped from the
// dev MACHINE's ip — a real host that does not run this process. Every process role flipped to
// 'down' within 30s of a start the starter had just verified on localhost. Fix: ask localhost
// first for the *monitor* (process alive?), keep the recorded url as fallback.
//
// TKT-136 defect #2: `zee build --wait` then reported UP from that localhost signal while the
// *published* host:port (still the machine ip) refused every connection from the cage. A false
// UP is worse than no signal — it sends the zee on to probe an endpoint that cannot answer.
// Fix: stamp process-role host/url from processRoleReachableHost() (provision + build), and
// make --wait prove the PUBLISHED url via probePublishedRole() (lib/build.getBuildStatus).

// Hostname a CXELL (and anything else on the hive net) already uses to reach THIS queenzee.
// A process-role child shares that namespace, so the same host reaches its ports. Never the
// dev machine's host_ip — that is a different box and is the lie defect #2 measured.
export function processRoleReachableHost() {
  try {
    const u = new URL(config.cxellApiBase || '');
    if (u.hostname) return u.hostname;
  } catch { /* fall through */ }
  return '127.0.0.1';
}

// The URL stamped on the row / offered to a zee. Process roles: the reachable host above.
export function processRolePublishedUrl(hostPort) {
  return `http://${processRoleReachableHost()}:${hostPort}`;
}

// Monitor probe targets (process ALIVE on the queenzee). Localhost first — start-xell-process.sh
// is the only place that has always been right about a just-started process role.
export function processProbeUrls(c) {
  const urls = [];
  if (c.host_port) urls.push(`http://127.0.0.1:${c.host_port}`);
  if (c.url && !urls.includes(c.url)) urls.push(c.url);
  return urls;
}

export async function probeProcessRole(c, { timeout = 5000 } = {}) {
  for (const url of processProbeUrls(c)) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(timeout) });
      if (r.status < 500) return 'up';
    } catch { /* not there — try the next place it could be */ }
  }
  return 'down';
}

// PUBLISHED url only — what a zee / human is told to curl. No localhost shortcut.
// Used by getBuildStatus so --wait cannot say UP while the binding refuses.
export function publishedUrl(c) {
  if (c?.url) return c.url;
  if (c?.host && c?.host_port) return `http://${c.host}:${c.host_port}`;
  return null;
}

// Where to HTTP-probe the published binding. Server roles prefer /health (index.js serves it);
// webapp and anything else get the url as stamped (vite answers on /).
export function publishedProbeTarget(c) {
  const base = publishedUrl(c);
  if (!base) return null;
  if (c.role === 'server') {
    try {
      const u = new URL(base);
      if (!u.pathname || u.pathname === '/') {
        u.pathname = '/health';
        return u.href;
      }
    } catch {
      return `${String(base).replace(/\/?$/, '')}/health`;
    }
  }
  return base;
}

export async function probePublishedRole(c, { timeout = 3000 } = {}) {
  const url = publishedProbeTarget(c);
  if (!url) return 'unknown';
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeout) });
    if (r.status < 500) return 'up';
    return 'down';
  } catch {
    return 'down';
  }
}

// ── address reconciliation for HOSTLESS db rows (the "no URL recorded" heal) ──────
// A dev db provisioned before machineDbHost existed (or on a machine whose host was set
// later) can leave a container row with host_port recorded but host/conn_ref NULL — a db
// that is UP and listening, whose chip says "no URL recorded" (db-dsn-needs-a-host). The
// provision path now writes the address up front; this heals the rows it already wrote.
//
// Only ever FILLS a missing address, and only the exact broken shape: role='db', host IS
// NULL, host_port IS NOT NULL, conn_ref IS NULL. A row whose host or conn_ref is already
// present is untouched — this never overwrites an address a human or a later provision
// recorded. Idempotent: a healed row no longer matches the shape, so the next tick skips it.
export async function healHostlessDbRows() {
  const broken = await q(
    `SELECT c.id, c.name, c.docker_ctx, c.host_port, c.project_id
       FROM container c
      WHERE c.role='db' AND c.host IS NULL AND c.host_port IS NOT NULL AND c.conn_ref IS NULL`);
  let healed = 0;
  for (const c of broken) {
    const [machine, project] = await Promise.all([
      c.docker_ctx ? one(`SELECT * FROM machine WHERE docker_ctx=$1`, [c.docker_ctx]).catch(() => null) : null,
      one(`SELECT * FROM project WHERE id=$1`, [c.project_id]).catch(() => null),
    ]);
    const host = await machineDbHost(machine || {}, project || {}, config);
    if (!host) continue;                       // still no derivable address — leave it, fail closed
    const conn = derivedTcpDsn({ host, host_port: c.host_port },
      { user: project?.db_user || config.prodDbUser || 'postgres',
        name: project?.db_name || config.prodDbName || 'omnibiz' });
    if (!conn) continue;
    const row = await one(
      `UPDATE container SET host=$1, conn_ref=$2 WHERE id=$3 RETURNING *`,
      [host, conn, c.id]).catch(() => null);
    if (row) { broadcast('container', row); healed++; }
  }
  if (healed) logline('containers', `healed ${healed} hostless db row(s) — recorded a URL for a database that had only a port`);
  return healed;
}

// ── address reconciliation for STALE machine-placed rows (the wrong-IP heal) ──
// TKT-180: before deploy_site was consulted for WHERE a machine's dev tier runs, a machine-placed
// container's host came straight from machine.host_ip. ugreen-nas carried 10.0.1.18 while the
// docker daemon and every other source said 10.1.0.18 — so every spin container row stamped from
// that machine inherited an address that never answered, and `zee build --wait` reported a
// genuinely-serving container as DOWN.
//
// deploy_site is the single source of truth (docs/deploy-topology-spec.md §5): the dev site whose
// docker_ctx matches the machine's context WINS over the machine row's host_ip. This heals the
// rows already stamped under the old precedence — rewrites host (+ url, and + conn_ref for db
// rows) when the recorded host is not the site host. Skips rows that are already correct.
// Idempotent: a healed row no longer matches, so the next tick no-ops. Mirror of
// healHostlessDbRows — same discipline, different broken shape (wrong address vs no address).
export async function healStaleSiteHostRows() {
  // Machine-placed dev/spinoff rows only: a docker_ctx that names a machine row, a non-null host
  // (hostless is healHostlessDbRows' shape), and a tier that machine placement actually stamps
  // (spinoff per-xell roles + the machine's shared dev db). Process-runner roles have
  // docker_ctx NULL and never join; prod rows live under their prod site and are not dev work.
  const stale = await q(
    `SELECT c.id, c.role, c.docker_ctx, c.host, c.host_port, c.url, c.conn_ref, c.project_id
       FROM container c
       JOIN machine m ON m.docker_ctx = c.docker_ctx
      WHERE c.docker_ctx IS NOT NULL
        AND c.tier IN ('spinoff','dev')
        AND c.host IS NOT NULL`);
  let healed = 0;
  for (const c of stale) {
    const [machine, project] = await Promise.all([
      one(`SELECT * FROM machine WHERE docker_ctx=$1`, [c.docker_ctx]).catch(() => null),
      one(`SELECT * FROM project WHERE id=$1`, [c.project_id]).catch(() => null),
    ]);
    const host = await machineDbHost(machine || {}, project || {}, config);
    if (!host || host === c.host) continue;    // still no derivable address, or already correct
    const sets = ['host=$2'];
    const vals = [c.id, host];
    if (c.host_port && c.url) {                // re-stamp the published URL it advertises
      sets.push(`url=$${vals.length + 1}`); vals.push(`http://${host}:${c.host_port}`);
    }
    if (c.role === 'db' && c.conn_ref) {       // a db's DSN carries the host too — keep it in step
      const conn = derivedTcpDsn({ host, host_port: c.host_port },
        { user: project?.db_user || config.prodDbUser || 'postgres',
          name: project?.db_name || config.prodDbName || 'omnibiz' });
      if (conn) { sets.push(`conn_ref=$${vals.length + 1}`); vals.push(conn); }
    }
    const row = await one(
      `UPDATE container SET ${sets.join(', ')} WHERE id=$1 RETURNING *`, vals).catch(() => null);
    if (row) { broadcast('container', row); healed++; }
  }
  if (healed) {
    logline('containers', `healed ${healed} stale machine-placed row(s) — host re-stamped from the deploy_site that owns the tier`);
  }
  return healed;
}

// Orphan memory: which labeled-but-unmodeled containers we've already reported, so the log
// says it once per appearance instead of every 30-second tick.
let knownOrphans = '';
// Same discipline for the health summary line: repeat it only when it changes.
let lastHealthLine = '';

export async function checkContainers() {
  // GATEWAY REACHABILITY rides this same health tick — the one cadence the console already polls —
  // rather than a new poller. Best-effort and cached in memory (queenzee/gateway-health.js): a
  // probe failure can never fail this tick, and the fleet read model reads the CACHE, never a fetch.
  await probeGatewayHealth().catch(() => {});

  // Address self-heal first: a db row that has only a port gets its URL filled in (see
  // healHostlessDbRows), and a machine-placed row whose recorded host no longer matches its
  // deploy_site gets re-stamped (healStaleSiteHostRows — TKT-180). Cheap and idempotent — a
  // healthy fleet matches no rows and skips.
  await healHostlessDbRows();
  await healStaleSiteHostRows();

  // project/xell identity rides along so labeled containers match exactly (sanitized project
  // token = what the compose labels carry, mirroring lib/manifest.js sanitizeName).
  const containers = await q(
    `SELECT c.id, c.name, c.docker_ctx, c.health, c.role, c.isolation,
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

  let up = 0, down = 0, unknown = 0, changed = 0, busy = 0, booting = 0;
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
      // Device readiness (035/048): a per-xell emulator that docker calls 'running' is not yet
      // installable — the Android OS inside is still booting. Probe adb boot_completed and hold it
      // at 'booting' until the device will accept an install. An inconclusive probe ('unknown')
      // trusts docker and leaves it 'up', so a probe failure never traps a working device.
      if (health === 'up' && c.role === 'device' && c.isolation === 'per-xell') {
        const boot = await deviceBootState(c).catch(() => 'unknown');
        if (boot === 'booting') health = 'booting';
      }
    }
    if (health === 'up') up++; else if (health === 'down') down++; else if (health === 'booting') booting++; else unknown++;
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
    `SELECT id, name, url, host_port, health FROM container
      WHERE docker_ctx IS NULL AND url IS NOT NULL AND health <> 'building'`);
  for (const c of procs) {
    const health = await probeProcessRole(c);
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

  // ── mesh join sweep (docs/netbird-mesh-plan.md §3.3 / §6 phase 3) ──────────────
  // The monitor's OTHER half of the mesh lifecycle: provision mints the intent row, but stamping
  // 'joined' has to wait until the xell's mesh sidecar agent actually came up with its stack and
  // registered with the control plane. A sidecar has NO container row (its health is the control
  // plane's business, not docker ps), so this asks the control plane whether each minted xell peer
  // answers yet and stamps the ones that do. Best-effort by contract — an unreachable control
  // plane is a legible no-op here (mesh disabled is the same no-op), never a reason this tick
  // fails. Runs unconditionally and returns immediately when the mesh is off.
  await markJoinedMeshPeers().catch(() => {});

  const unreach = Object.entries(psByCtx).filter(([, m]) => m == null).map(([k]) => k);
  // Change-only: this ran every 30s and said the same thing every 30s, which in a shared
  // terminal is noise wearing a uniform. Note `changed` is part of the line, so any actual
  // health movement always logs.
  const healthLine = `docker health: ${up} up · ${down} down · ${unknown} unknown${booting ? ` · ${booting} booting` : ''}${busy ? ` · ${busy} building (skipped)` : ''}${procs.length ? ` (incl. ${procs.length} process role(s) by URL)` : ''}${unreach.length ? ` (unreachable: ${unreach.join(', ')})` : ''}${changed ? ` · ${changed} changed` : ''}${orphans.length ? ` · ${orphans.length} ORPHANED` : ''}`;
  if (healthLine !== lastHealthLine) { lastHealthLine = healthLine; logline('containers', healthLine); }
  return { up, down, unknown, booting, changed, building: busy, unreachable: unreach, orphans };
}

// ── decommission ONE container (the context-menu action) ─────────────────────
//
// Stops + removes the actual docker container, reclaims its image, then drops its meta row so the
// dashboard, health monitor and pool reconciler all see it gone. This is the SINGLE-container
// counterpart to the reaper (which tears down a whole xell); it uses the same docker-by-name
// mechanics, so state stays coherent through the queenzee rather than a hand-rolled second path.
//
// PRODUCTION IS EXCLUDED ENTIRELY — not warned about, refused. tier='prod' covers the prod stack
// AND the pinned prod database (which lives outside compose but is still a tier='prod' row). This
// is a server-side guard, not just a hidden UI item: a UI-only guard is bypassed by any direct
// API call — the same reasoning the reaper states for its active-zee guard.
export async function decommissionContainer(id, { force = false } = {}) {
  const c = await one(
    `SELECT c.*, x.slug AS owner_slug, x.is_production AS owner_is_production, p.name AS project_name
       FROM container c
       LEFT JOIN xell x ON x.id = c.owner_xell_id
       LEFT JOIN project p ON p.id = c.project_id
      WHERE c.id = $1`, [id]);
  if (!c) return { ok: false, error: 'container not found' };

  // Never target production — the stack or the pinned prod db. Refuse outright.
  if (c.tier === 'prod' || c.owner_is_production) {
    return { ok: false, protected: true,
      error: `${c.name} is a PRODUCTION container — it is protected and cannot be decommissioned.` };
  }

  // Mid-operation (a live build, or a db being restored/backed-up): removing it now would mangle
  // the operation and leave the row lying about what happened. Force overrides — a wedged build
  // that will never finish is exactly when you need to remove it — but say what is being overridden.
  if (!force && (c.health === 'building' || c.busy_since)) {
    return { ok: false, busy: true, name: c.name,
      error: `${c.name} is busy (${c.health === 'building' ? 'building' : (c.busy_op || 'in an operation')}) — `
           + 'wait for it to finish, or force to remove it anyway.' };
  }

  // A SHARED device (035) is a real phone modeled as a row — there is NO container to stop and no
  // image to reclaim, so removing it just drops the registration (the phone is untouched). A per-xell
  // emulator, by contrast, IS a real container and goes through the normal stop+remove below.
  const physicalDevice = c.role === 'device' && c.isolation === 'shared';

  logline('containers', physicalDevice
    ? `decommissioning device registration ${c.name} — removing the row (the physical phone is untouched)`
    : `decommissioning container ${c.name}`
      + `${c.owner_slug ? ` (xell ${c.owner_slug})` : ''} — stopping + removing, reclaiming its image`);

  // Stop + remove the real container. removeVolumes for a db so its data goes with it (a db
  // container's whole point is its volume). Best-effort over the daemon HTTP API — a missing
  // container (already gone) is success, and an unreachable daemon must not strand the row.
  let docker = { skipped: true };
  if (c.docker_ctx && !physicalDevice) {
    docker = await stopAndRemoveContainer(c.docker_ctx, c.name, { removeVolumes: c.role === 'db' })
      .catch((e) => ({ error: e.message }));
    if (docker.error) {
      logline('containers', `docker stop/remove FAILED for ${c.name}: ${docker.error} — removing the meta row anyway; the container may leak`);
    }
    // Reclaim its image (never force — docker refuses while anything still depends on it, which is
    // the pre-ZEEHIVE /spin worktrees' safeguard). Also the build host on a split build.
    for (const ctx of [...new Set([c.docker_ctx, c.build_ctx].filter(Boolean))]) {
      if (!c.image_tag) break;
      const img = await removeImage(ctx, c.image_tag).catch((e) => ({ removed: false, reason: e.message }));
      if (img.removed) logline('containers', `reclaimed image ${c.image_tag} (~1.3 GB) from ${c.name}`);
    }
  }

  // Drop the meta row — cascades its xell_uses_container junctions and db_instance rows (001/019).
  await q(`DELETE FROM container WHERE id=$1`, [id]);
  broadcast('container', { id, project_id: c.project_id, deleted: true });
  logline('containers', `container ${c.name} decommissioned ✓`);
  return { ok: true, name: c.name, role: c.role, owner_slug: c.owner_slug || null,
           docker, orphaned: !!(docker && docker.error) };
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
