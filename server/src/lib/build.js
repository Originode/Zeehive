// Container build — a REAL `docker compose build` + `up -d` of a per-xell server/webapp from its
// worktree code, recording the commit it was built at and whether it was a HOT build. The docker
// work lives in scripts/build-container.sh (queenzee-run, mirroring the project's spin-env.sh).
//
// Builds take MINUTES, so this never blocks: the container flips to health='building' (the UI
// shows a spinner), the build runs via async spawn, and the row + SSE update when it finishes.
// BUILD_MODE=simulate opts out of Docker entirely (demo escape hatch); default is REAL.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { config } from '../config.js';
import { q, one } from '../db/pool.js';
import { broadcast } from '../lib/events.js';
import { cleanGitEnv, headCommit } from '../lib/git.js';
import { logline } from '../lib/logbus.js';
import { resolveBash } from './bash.js';
import { spinComposeDbPort } from './provision.js';
import { npmCacheEnv } from '../lib/npm-cache.js';
import {
  processRoleReachableHost, processRolePublishedUrl,
  probePublishedRole, publishedUrl,
} from '../queenzee/containers.js';
import { assertSpinoffNotOnProdNetworks } from './spinoff-network-guard.js';

const MODE = process.env.BUILD_MODE === 'simulate' ? 'simulate' : 'real';
const BUILDABLE = new Set(['server', 'webapp']); // db is shared infra — not a per-xell build

// Cap for container.last_build_error — same ceiling runBuild already keeps in memory. A tooltip and
// a zee --wait print both need the reason; neither needs the full docker scrollback. Exported so
// the test can assert the contract without standing up a build.
export function formatBuildFailure(err, fallback = 'see docker output') {
  const text = String(err ?? '').trim();
  if (!text) return fallback;
  return text.length > 1500 ? text.slice(-1500) : text;
}

// ── BUILD-FAILURE CLASSIFIER — turn a failed build's stderr into INFRA | CODE | UNKNOWN (ticket
// "make zee build return actionable failures"). The raw docker tail STAYS in last_build_error (the
// evidence is never replaced); this decides whether retrying can EVER help, so `zee build --wait`
// can tell a zee "not your code — file a ticket and stop" instead of sending it into a retry loop
// (the mardale-prod address-pool exhaustion, ticket #178, was exactly that: the zee's image built
// fine, the HOST could not create a network, and nothing told it the failure was not its code).
//
// PURE — no I/O. The queenzee calls it at failure time to store last_build_error_class on the row;
// getBuildStatus returns it and a pre-computed next step. Exported for tests. Matches against the
// real text the build path actually produces (docker stderr, the compose-file missing sentence from
// build-container.sh, the compile errors from vite/webpack/tsc) — not a vocabulary invented for the
// classifier. Modeled on lib/ship-failure.js (classifyShipFailure).
//
// FAIL-SAFE: an error that matches NO pattern is UNKNOWN, never CODE. Guessing CODE for a host/
// daemon failure sends a worker hunting a bug it did not write — the exact harm this card exists to
// stop — so the honest answer when the classifier cannot tell is "I cannot tell", with the raw
// stderr as the evidence.

export const BUILD_FAILURE_CLASSES = ['INFRA', 'CODE', 'UNKNOWN'];

// Order matters: INFRA is checked first (host/daemon/network/context problems are never the zee's
// code), then CODE (an error that CONFIDENTLY traces to the worktree), and everything that matches
// neither is UNKNOWN — the classifier never guesses.
const INFRA_PATTERNS = [
  // docker network/address exhaustion (the mardale-prod incident, ticket #178).
  { test: (s) => /all predefined address pools have been fully subnetted|address pool.*(?:exhausted|fully subnetted)/i.test(s) },
  // the daemon itself is gone / unreachable.
  { test: (s) => /cannot connect to the docker daemon|error during connect|is the docker daemon running|docker daemon is (?:not|unreachable|unavailable)|daemon (?:not found|unreachable|unavailable)/i.test(s) },
  // a docker CONTEXT that does not exist / cannot be resolved.
  { test: (s) => /context .* (?:not found|does not exist|missing)|unable to resolve docker endpoint|no such context/i.test(s) },
  // host resource exhaustion — retrying on the same host cannot fix disk/memory/inode pressure.
  // docker compose reports a host-port conflict as 'Bind for 0.0.0.0:PORT failed: port is already
  // allocated' — same host-state fault as 'address already in use'.
  { test: (s) => /no space left on device|ENOSPC|device or resource busy|too many open files|address already in use|port is already allocated|resource (?:temporarily )?unavailable|out of (?:memory|disk space)/i.test(s) },
  // network/dns/transport — a registry or host that cannot be reached from where the build runs.
  { test: (s) => /network .* (?:not found|is unreachable|unreachable)|connect: network is unreachable|no such host|getaddrinfo|name or service not known|connection (?:refused|reset|timed out)|i\/o timeout|context deadline exceeded|dial tcp|failed to (?:push|pull).*(?:timeout|network|tls)|x509:|tls handshake/i.test(s) },
  // registry/image-access refusals — credentials/rate-limits/access, not the zee's code.
  { test: (s) => /pull access denied|unauthorized|authentication required|toomanyrequests|denied: requested access|manifest unknown|no matching manifest|unexpected status from GET request/i.test(s) },
  // the docker daemon answered with a server-side error (status codes are only meaningful near an
  // HTTP status — a bare "502" in a log line is not an infra verdict).
  { test: (s) => /error response from daemon|server error|internal server error|bad gateway|service unavailable|(?:status|HTTP)[ :]50[23]/i.test(s) },
];

// Confident WORKTREE failures — an error that names the zee's own build toolchain. These are only
// consulted after INFRA has already said no, and they must be specific: the whole point of UNKNOWN
// is that a generic failure is NOT called CODE by default.
const CODE_PATTERNS = [
  // build-container.sh early-exits: the compose/env file a build reads from THIS worktree/branch is
  // missing — the file comes from the branch, so it IS the zee's code.
  { test: (s) => /compose file not found:|env file not found:|no such file or directory.*(?:docker-compose|compose\.ya?ml|Dockerfile)|docker-compose\.ya?ml.*(?:not found|no such)/i.test(s) },
  // TypeScript — an error TS#### code, usually with a source file:line.
  { test: (s) => /(?:error|\(ts\))\s+TS\d{1,5}|:\s+error TS\d{1,5}/i.test(s) },
  // vite/webpack/esbuild — module resolution, compile and transform failures.
  { test: (s) => /failed to compile|module not found|cannot find module|can't resolve|could not resolve|unable to resolve|syntax error|transform failed|error during (?:build|bundle)|rollup.*error/i.test(s) },
  // npm/pnpm/yarn — dependency resolution/install/script failures.
  { test: (s) => /npm ERR!|ERESOLVE|ELIFECYCLE|Failed at the .* (?:build|compile) script|peer .*conflicting/i.test(s) },
  // test runners failing.
  { test: (s) => /\b(?:AssertionError|Test suite failed to run|Tests? failed)\b|\d+ tests? (?:failed|failing)/i.test(s) },
];

// The docker address-pool exhaustion from the mardale-prod incident (ticket #178), detected
// separately so the INFRA next-step can name the existing ticket instead of telling a zee to file a
// duplicate.
export function isAddressPoolExhaustion(err) {
  return /all predefined address pools have been fully subnetted/i.test(String(err ?? ''));
}

export function classifyBuildFailure(err) {
  const text = String(err ?? '').trim();
  if (!text) return null;
  if (INFRA_PATTERNS.some((r) => r.test(text))) return 'INFRA';
  if (CODE_PATTERNS.some((r) => r.test(text))) return 'CODE';
  return 'UNKNOWN';
}

// The exact next step for a classified failure — what a zee should DO, not just what happened. The
// server computes it once (here) so getBuildStatus carries it and `zee build --wait`/--watch and the
// host xell-build.mjs print the same sentence; the record and the report cannot disagree.
export function buildFailureNextStep(cls, err, container = null) {
  const text = String(err ?? '').trim();
  if (cls === 'INFRA') {
    const ctxs = [];
    if (container?.build_ctx && container?.docker_ctx && container.build_ctx !== container.docker_ctx) {
      ctxs.push(`compiles on ${container.build_ctx}`);
      ctxs.push(`runs on ${container.docker_ctx}`);
    } else if (container?.docker_ctx) {
      ctxs.push(`docker context ${container.docker_ctx}`);
    }
    const where = ctxs.length ? `Where: ${ctxs.join(', ')}.` : '';
    const ticket = isAddressPoolExhaustion(text)
      ? 'This is docker address-pool exhaustion on the host — already ticketed #178. Retrying will not help; file nothing new, and wait for the pool to free up (or be enlarged).'
      : 'Retrying will not help. File a ticket for the infra team with the docker line below, and STOP the retry loop.';
    return `INFRA — NOT YOUR CODE. This build failed on the host/daemon/network, not on your change. ${where} ${ticket}`.trim();
  }
  if (cls === 'CODE') {
    // CODE: the error text IS the actionable part.
    return 'CODE — this looks like a problem in YOUR worktree (compile/test/compose). Fix the error below and rebuild.';
  }
  // UNKNOWN — the classifier could not tell, and saying nothing would send a zee into a retry loop
  // just as surely as a bare docker tail would. The raw stderr prints below this sentence, so the
  // evidence is right there for the zee (or a human) to judge.
  return 'UNKNOWN — could not classify this failure automatically. Read the raw build output below: '
    + 'if it names a host/daemon/network/context problem it is INFRA (not your code — file a ticket and '
    + 'STOP the retry loop); if it names a file or dependency in YOUR worktree it is CODE (fix and rebuild). '
    + 'When in doubt, raise it to a human with the output below rather than retrying blindly.';
}

// The registry a split build hands its image through: the project's own, else the global default.
// null when neither is set → split builds are simply unavailable (validated where build_ctx is set).
async function registryFor(projectId) {
  const p = await one(`SELECT registry FROM project WHERE id=$1`, [projectId]);
  return (p?.registry && p.registry.trim()) || config.registry || null;
}

// Where does THIS container compile? build_ctx when set, else its run context (docker_ctx). A
// foreign build_ctx with no registry cannot hand the image back — refuse it here, not at push
// time, so the caller gets an actionable error instead of a half-built stack.
async function resolveBuildTarget(c) {
  const runCtx = c.docker_ctx;
  const buildCtx = c.build_ctx || runCtx;
  if (buildCtx === runCtx) return { runCtx, buildCtx, registry: null };
  const registry = await registryFor(c.project_id);
  if (!registry) {
    throw new Error(
      `build_ctx '${buildCtx}' differs from run context '${runCtx}', which needs a registry to hand `
      + `the image over — but no registry is configured. Set project.registry (or SPINOFF_REGISTRY), `
      + `on the LAN, then retry.`);
  }
  return { runCtx, buildCtx, registry };
}

// Async spawn (NOT spawnSync) — a real image build would otherwise freeze the event loop.
// `recorded` carries the meta-DB's compose/env/port facts as env overrides; the script keeps its
// own derivation as fallback, so a bare invocation (or an old row with NULLs) still works.
function runBuild({ worktree, role, ctx, hot, recorded = {} }) {
  return new Promise((res) => {
    const script = resolve(config.repoRoot, 'scripts', 'build-container.sh');
    const env = {};
    for (const [k, v] of Object.entries(recorded)) if (v != null && v !== '') env[k] = String(v);
    const p = spawn(resolveBash(), [script, worktree, role, ctx || 'ugreen-nas', hot ? 'true' : 'false', MODE],
      { env: cleanGitEnv(env), windowsHide: true });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', () => {
      const line = out.trim().split('\n').filter(Boolean).pop();
      let json = null; try { json = JSON.parse(line); } catch { /* no JSON line */ }
      res({ json, err: err.slice(-1500) });
    });
    p.on('error', (e) => res({ json: null, err: String(e.message) }));
  });
}

// Persist one container's build context (normalized). A value equal to the run context or empty
// resets to NULL (= build where you run). Returns the updated row (already broadcast).
async function setBuildCtxRow(c, buildCtx) {
  const s = buildCtx == null ? null : String(buildCtx).trim();
  const norm = (!s || s === c.docker_ctx) ? null : s;
  const row = await one(`UPDATE container SET build_ctx=$2 WHERE id=$1 RETURNING *`, [c.id, norm]);
  broadcast('container', row);
  return row;
}

// Set the build context on ONE buildable container. Validates the registry so a foreign context is
// refused at set time (with the way to fix it), not discovered mid-build.
export async function setContainerBuildCtx(containerId, buildCtx) {
  const c = await one(`SELECT * FROM container WHERE id=$1`, [containerId]);
  if (!c) throw new Error('container not found');
  if (!BUILDABLE.has(c.role) || !c.owner_xell_id) throw new Error('not a buildable per-xell container');
  const row = await setBuildCtxRow(c, buildCtx);
  await resolveBuildTarget(row);   // throws if foreign ctx + no registry
  return { id: row.id, name: row.name, role: row.role, build_ctx: row.build_ctx, run_ctx: row.docker_ctx };
}

// Set the build context on BOTH buildable containers of a xell at once — the per-xell knob a zee
// or the console flips to move its compile to a beefier host.
export async function setXellBuildCtx(xellId, buildCtx) {
  const cs = await q(`SELECT * FROM container WHERE owner_xell_id=$1 AND role = ANY($2) ORDER BY role`,
    [xellId, [...BUILDABLE]]);
  if (!cs.length) throw new Error('xell has no buildable container');
  const containers = [];
  for (const c of cs) {
    const row = await setBuildCtxRow(c, buildCtx);
    await resolveBuildTarget(row);
    containers.push({ id: row.id, name: row.name, role: row.role, build_ctx: row.build_ctx, run_ctx: row.docker_ctx });
  }
  logline('build', `xell build context → ${containers[0]?.build_ctx || '(run host)'} for ${containers.length} role(s) of ${xellId}`);
  return { xell_id: xellId, build_ctx: containers[0]?.build_ctx || null, containers };
}

// Kick off a build. Returns as soon as it's queued (health='building'); the row updates live.
// buildCtx: undefined → leave the container's stored build context as-is; a string/null → set it
// first (one-shot "build on X now"). A value equal to the run context, or empty, resets to NULL.
export async function buildContainer(containerId, { hot = false, buildCtx } = {}) {
  let c = await one(
    `SELECT c.*, x.is_production AS owner_is_production
       FROM container c LEFT JOIN xell x ON x.id = c.owner_xell_id
      WHERE c.id = $1`, [containerId]);
  if (!c) throw new Error('container not found');
  if (!BUILDABLE.has(c.role)) throw new Error(`role '${c.role}' is not buildable (only server/webapp)`);
  // PRODUCTION IS SHIP-ONLY — a prod-tier container, or one owned by a production xell, must not be
  // (re)built by a zee action at all; only the ship gate may rebuild/redeploy it. A server-side
  // guard (not a UI one), the same shape as decommissionContainer's prod refusal: a UI-only guard
  // is bypassed by any direct API call.
  if (c.tier === 'prod' || c.owner_is_production) {
    throw new Error(
      `${c.name} is a PRODUCTION container — it is ship-only. \`zee build\` cannot (re)build or redeploy a `
      + 'production container; only the ship gate (`zee ship`, after the work is landed on main) may '
      + 'rebuild/redeploy it.');
  }
  if (!c.owner_xell_id) throw new Error('not a per-xell container');
  if (c.health === 'building') throw new Error(`${c.name} is already building`);
  const xell = await one(`SELECT slug, worktree_path, project_id FROM xell WHERE id=$1`, [c.owner_xell_id]);
  if (!xell?.worktree_path) throw new Error('owner xell has no worktree');

  // What the meta-DB already recorded about this stack: compose file/project on the container
  // row (stamped at provision), env-file convention on the project, and the ACTUAL allocated
  // host ports of both buildable roles (the compose file interpolates both, whichever we build).
  const project = await one(
    `SELECT repo_root, env_file, manifest, compose_prod, compose_spinoff FROM project WHERE id=$1`,
    [xell.project_id]);

  // runner: process (spec §6.1) — there is no image and no compose; the hammer's verb here is
  // (re)START the role in its worktree. Build-context knobs are meaningless for a process.
  //
  // THE ROW OUTRANKS THE MANIFEST. Provision records what a container IS (a process row carries
  // image_tag=NULL AND docker_ctx=NULL; a compose row carries both), and a build must honor
  // what was provisioned, not what the manifest says TODAY — the manifest cache moves under
  // live xells (the process→compose cutover of the compose-authorship decision record), and a
  // docker build against a row with no image and no context can only fail. So: old xells keep
  // process builds for their whole lives, new xells build containers, and the flip is a
  // per-xell fact instead of a fleet-wide cliff. The manifest check remains for rows from
  // before naming stamped image_tag.
  const runner = project?.manifest?.roles?.[c.role]?.runner
    || project?.manifest?.tiers?.spinoff?.runner || null;
  const isProcessRow = !c.image_tag && !c.docker_ctx;
  if (isProcessRow || (runner === 'process' && !c.image_tag)) return startProcessRole(c, xell, project);

  // SPINOFF MUST NOT JOIN A PROD NETWORK — before any docker work. A comment in a project's
  // spinoff compose is advice; this is the enforcement (lib/spinoff-network-guard.js). Reads the
  // worktree's spinoff compose + the project's prod compose (repo_root) and refuses on overlap.
  {
    const spinRel = c.compose_file
      || project?.manifest?.tiers?.spinoff?.compose
      || project?.compose_spinoff
      || 'docker-compose.spinoff.yml';
    const spinAbs = resolve(String(xell.worktree_path).replace(/\\/g, '/'), spinRel);
    const prodRel = project?.manifest?.tiers?.prod?.compose || project?.compose_prod || null;
    const prodAbs = prodRel && project?.repo_root
      ? resolve(String(project.repo_root).replace(/\\/g, '/'), prodRel)
      : null;
    let spinYaml = null, prodYaml = null;
    try { if (existsSync(spinAbs)) spinYaml = readFileSync(spinAbs, 'utf8'); } catch { /* absent → skip */ }
    try { if (prodAbs && existsSync(prodAbs)) prodYaml = readFileSync(prodAbs, 'utf8'); } catch { /* absent → manifest-only */ }
    if (spinYaml) {
      assertSpinoffNotOnProdNetworks({
        spinComposeYaml: spinYaml,
        manifest: project?.manifest || null,
        prodComposeYaml: prodYaml,
      });
    }
  }

  if (buildCtx !== undefined) c = await setBuildCtxRow(c, buildCtx);
  // Validate the build target NOW (before flipping to 'building'), so a foreign context with no
  // registry fails fast with an actionable error rather than stranding a spinner.
  const target = await resolveBuildTarget(c);
  const siblings = await q(
    `SELECT role, host_port FROM container WHERE owner_xell_id=$1 AND role = ANY($2)`,
    [c.owner_xell_id, [...BUILDABLE, 'db']]);
  const portOf = (role) => siblings.find((s) => s.role === role)?.host_port;
  const recorded = {
    BUILD_COMPOSE_FILE: c.compose_file,
    BUILD_COMPOSE_PROJECT: c.compose_project,
    BUILD_ENV_FILE: project?.env_file && project?.repo_root
      ? `${String(project.repo_root).replace(/\\/g, '/')}/${project.env_file}` : null,
    SPINOFF_SLUG: xell.slug,
    SPINOFF_SERVER_PORT: portOf('server'),
    SPINOFF_WEB_PORT: portOf('webapp'),
    // The GENERATED spinoff compose publishes a per-xell db on ${SPINOFF_DB_PORT}. A recorded db row
    // (provision stamped it) rides along like the server/web ones. With NO per-xell db row
    // (db-shared-dev coupling) the compose would fall back to its default 5500 — the one host port
    // every OTHER row-less spin db also wants, so they collide cross-xell (TKT-85). spinComposeDbPort
    // allocates against real ownership instead; any failure degrades to the old compose default.
    SPINOFF_DB_PORT: await spinComposeDbPort({
      recordedPort: portOf('db'), ctx: c.docker_ctx, slug: xell.slug, project,
    }),
    // Split-build handoff (all no-ops when buildCtx === runCtx / no registry — see build-container.sh).
    BUILD_BUILD_CTX: target.buildCtx,
    BUILD_REGISTRY: target.registry,
    BUILD_IMAGE: c.image_tag,
  };

  // Clear any prior failure when a fresh build starts — the chip must not keep showing a stale
  // reason under a spinner, and a success later clears it again explicitly.
  const building = await one(
    `UPDATE container SET health='building', last_build_error=NULL WHERE id=$1 RETURNING *`,
    [containerId]);
  broadcast('container', building);
  const where = target.buildCtx !== target.runCtx ? ` — compiling on ${target.buildCtx} → run on ${target.runCtx}` : '';
  logline('build', `${hot ? 'HOT ' : ''}build started: ${c.name} (${MODE}) from ${xell.slug}${where}`);

  // background — do NOT await; a real build takes minutes
  (async () => {
    const { json, err } = await runBuild({ worktree: xell.worktree_path, role: c.role, ctx: c.docker_ctx, hot, recorded });
    const ok = !!json && json.ok !== false;
    const failReason = ok ? null : formatBuildFailure(err);
    const failureClass = ok ? null : classifyBuildFailure(failReason);
    const row = await one(
      `UPDATE container
          SET health = $2::container_health, hot_build = $3,
              last_build_commit = COALESCE($4, last_build_commit),
              last_built_at = CASE WHEN $5 THEN now() ELSE last_built_at END,
              last_build_error = $6,
              last_build_error_class = $7
        WHERE id=$1 RETURNING *`,
      [containerId, ok ? 'up' : 'down', !!hot && ok, json?.head && json.head !== 'unknown' ? json.head : null, ok, failReason, failureClass]);
    broadcast('container', row);
    logline('build', ok
      ? `${hot ? 'HOT ' : ''}build OK: ${c.name} @ ${json?.head} (${json?.method})`
      : `build FAILED: ${c.name} — ${(failReason || 'see docker output').split('\n').filter(Boolean).pop()}`);
  })().catch(async (e) => {
    // The ONLY thing that can move this row off 'building' is this callback — the health monitor
    // deliberately skips 'building' so it can't clobber a live build. So an unhandled throw in
    // here (runBuild blowing up, or a single ETIMEDOUT to the NAS meta-DB on the UPDATE above —
    // see the note in index.js; that exact blip has already taken this orchestrator down once)
    // strands the container at 'building' FOREVER, spinner and all, with no build behind it.
    // Land it on a terminal state and say so, rather than leave a permanent lie on the chip.
    // Persist the thrown message too — the catch used to mark down with NO reason on the row.
    const failReason = formatBuildFailure(e?.message || e, 'build errored');
    const failureClass = classifyBuildFailure(failReason);
    try {
      const row = await one(
        `UPDATE container SET health='down', last_build_error=$2, last_build_error_class=$3
          WHERE id=$1 AND health='building' RETURNING *`,
        [containerId, failReason, failureClass]);
      if (row) broadcast('container', row);
    } catch { /* the DB is what failed — the boot-time recoverOrphanBuilds() is the backstop */ }
    logline('build', `build ERRORED: ${c.name} — ${failReason} (marked down; rebuild when ready)`);
  });

  return { status: 'building', container: c.name, role: c.role, hot, mode: MODE };
}

// Last lines of the process-role boot log (worktree/.zeehive-<role>.log). Surfaced by
// getBuildStatus when the published port refuses, so --wait can tell a zee WHY.
export function processBootLogTail(worktree, role, { lines = 30 } = {}) {
  if (!worktree || !role) return null;
  const p = join(worktree, `.zeehive-${role}.log`);
  if (!existsSync(p)) return null;
  try {
    const text = readFileSync(p, 'utf8');
    const all = text.trimEnd().split(/\r?\n/);
    if (!all.length || (all.length === 1 && all[0] === '')) return null;
    return all.slice(-lines).join('\n');
  } catch { return null; }
}

// (Re)start a process role in its worktree — the process-runner twin of the docker build above.
// Same lifecycle contract: health='building' while the script runs, terminal 'up'/'down' set ONLY
// by this callback (the monitor skips 'building'), same strand-guard, same recorded commit. The
// process reads its own ports/DATABASE_URL/modes from the worktree's .zeehive.env, so the script
// is handed nothing but where, what, and which port to wait on.
// The AWAITABLE core of a process-role (re)start: spawn start-xell-process.sh, wait for its JSON
// verdict, and land the row on terminal 'up'/'down' — the SAME transitions a build's background
// callback makes, so the monitor and `--wait` read a reload the same way they read a build.
//
// startProcessRole wraps this in the fire-and-forget background shape a BUILD needs (builds take
// minutes and never block). The env-reload path (restartProcessRoleTier below) needs to KNOW the
// tier came up before it claims the new env is live, so it awaits this directly. The caller must
// have already set health='building' — that transition is the one the two shapes want at different
// moments.
async function runProcessRoleStart(c, xell, project, startCmd, mode = MODE) {
  const { json, err } = await new Promise((res) => {
    const script = resolve(config.repoRoot, 'scripts', 'start-xell-process.sh');
    const p = spawn(resolveBash(),
      [script, String(xell.worktree_path).replace(/\\/g, '/'), c.role, String(c.host_port), mode, ...startCmd.split(/\s+/)],
      // npmCacheEnv points the script's own `npm ci` at the SHARED cache (ticket #7) — the
      // script needs no change for it, and with no repos volume it is a no-op.
      { env: npmCacheEnv(cleanGitEnv()), windowsHide: true });
    let out = '', errBuf = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (errBuf += d));
    p.on('close', () => {
      const line = out.trim().split('\n').filter(Boolean).pop();
      let json = null; try { json = JSON.parse(line); } catch { /* no JSON line */ }
      res({ json, err: errBuf.slice(-1500) });
    });
    p.on('error', (e) => res({ json: null, err: String(e.message) }));
  });
  const ok = !!json && json.ok !== false;
  const failReason = ok ? null : formatBuildFailure(
    err || json?.method, 'see .zeehive log');
  const failureClass = ok ? null : classifyBuildFailure(failReason);
  const row = await one(
    `UPDATE container
        SET health = $2::container_health, hot_build = false,
            last_build_commit = COALESCE($3, last_build_commit),
            last_built_at = CASE WHEN $4 THEN now() ELSE last_built_at END,
            last_build_error = $5,
            last_build_error_class = $6
      WHERE id=$1 RETURNING *`,
    [c.id, ok ? 'up' : 'down', json?.head && json.head !== 'unknown' ? json.head : null, ok, failReason, failureClass]);
  broadcast('container', row);
  logline('build', ok
    ? `process UP: ${c.name} @ ${json?.head} (${json?.method})`
    : `process start FAILED: ${c.name} — ${(failReason || 'see .zeehive log').split('\n').filter(Boolean).pop()}`);
  return { row, ok, json, failReason };
}

function startProcessRole(c, xell, project) {
  const startCmd = project?.manifest?.roles?.[c.role]?.start
    || (c.role === 'server' ? 'npm run server' : 'npm run web');
  return (async () => {
    // Heal a stale published host (pre-TKT-136 rows stamped the dev machine's ip). The process
    // lives in the queenzee's namespace — the binding must say so before --wait probes it.
    const reachHost = processRoleReachableHost();
    const reachUrl = processRolePublishedUrl(c.host_port);
    const building = await one(
      `UPDATE container SET health='building', host=$2, url=$3, last_build_error=NULL WHERE id=$1 RETURNING *`,
      [c.id, reachHost, reachUrl]);
    broadcast('container', building);
    logline('build', `process start: ${c.name} (${MODE}) — "${startCmd}" in ${xell.slug} @ ${reachHost}:${c.host_port}`);

    // background — do NOT await; npm install on a cold worktree takes minutes
    (async () => {
      try {
        await runProcessRoleStart(c, xell, project, startCmd, MODE);
      } catch (e) {
        // Same stranded-'building' hazard as the docker path: this callback is the only thing that
        // can move the row off 'building', so it must always land somewhere terminal. Persist the
        // thrown message — same contract as the docker catch (ticket #173).
        const failReason = formatBuildFailure(e?.message || e, 'process start errored');
        const failureClass = classifyBuildFailure(failReason);
        try {
          const row = await one(
            `UPDATE container SET health='down', last_build_error=$2, last_build_error_class=$3
              WHERE id=$1 AND health='building' RETURNING *`,
            [c.id, failReason, failureClass]);
          if (row) broadcast('container', row);
        } catch { /* the DB is what failed — recoverOrphanBuilds() at boot is the backstop */ }
        logline('build', `process start ERRORED: ${c.name} — ${failReason} (marked down; hammer again when ready)`);
      }
    })();

    return { status: 'building', container: c.name, role: c.role, hot: false, mode: MODE, runner: 'process' };
  })();
}

// RESTART A RUNNING PROCESS-ROLE TIER so it re-reads its worktree's .zeehive.env — the verb the
// boot env reconcile (provision.reconcileXellEnvs) calls after a ship rewrote the projection. A
// process role is a bare process started FROM the file (start-xell-process.sh unsets every key the
// file owns so dotenv re-reads it), so rewriting the file underneath it changes nothing until the
// process restarts — the fix was live on disk and dead in memory, and no one could tell.
//
// This is that restart, AWAITED so the caller knows the tier actually came up on the new file.
// Gated on the tier RUNNING (health='up'): a 'down' tier is not running on any env, so starting it
// is the pool/dispatch's job, and a 'building' tier is already being built — for both, returning
// { restarted:false, reason } lets the reconcile say the state honestly (never "reloaded").
//
// `mode` defaults to the module BUILD_MODE, but the reconcile passes 'real' explicitly: the
// decision to restart lives in PROVISION_MODE, and a real reconcile must spawn a real process even
// when a nested queenzee's BUILD_MODE=simulate.
export async function restartProcessRoleTier(containerId, { mode = MODE } = {}) {
  const c = await one(`SELECT * FROM container WHERE id=$1`, [containerId]);
  if (!c) throw new Error('container not found');
  const isProcessRow = !c.image_tag && !c.docker_ctx;
  if (!isProcessRow) {
    return { restarted: false, containerId, role: c.role, reason: 'not-a-process-row' };
  }
  if (c.health !== 'up') {
    return { restarted: false, containerId, role: c.role, health: c.health,
             reason: c.health === 'building' ? 'already building' : 'not running' };
  }
  const xell = await one(`SELECT slug, worktree_path, project_id FROM xell WHERE id=$1`, [c.owner_xell_id]);
  if (!xell?.worktree_path) {
    return { restarted: false, containerId, role: c.role, reason: 'no worktree' };
  }
  const project = await one(`SELECT repo_root, env_file, manifest FROM project WHERE id=$1`, [xell.project_id]);
  const startCmd = project?.manifest?.roles?.[c.role]?.start
    || (c.role === 'server' ? 'npm run server' : 'npm run web');
  const reachHost = processRoleReachableHost();
  const reachUrl = processRolePublishedUrl(c.host_port);
  const building = await one(
    `UPDATE container SET health='building', host=$2, url=$3, last_build_error=NULL WHERE id=$1 RETURNING *`,
    [c.id, reachHost, reachUrl]);
  broadcast('container', building);
  logline('build', `env reload restart: ${c.name} (${mode}) — "${startCmd}" in ${xell.slug} @ ${reachHost}:${c.host_port}`);
  try {
    const { row, ok, json, failReason } = await runProcessRoleStart(c, xell, project, startCmd, mode);
    return { restarted: true, containerId, role: c.role, ok, health: row.health,
             head: json?.head || null, failReason };
  } catch (e) {
    // Same stranded-'building' guard as the build path: the row must never sit 'building' with no
    // process behind it. Land on 'down' with the reason, so the failure is visible, not stuck.
    const failReason = formatBuildFailure(e?.message || e, 'env reload restart errored');
    const failureClass = classifyBuildFailure(failReason);
    try {
      const row = await one(
        `UPDATE container SET health='down', last_build_error=$2, last_build_error_class=$3 WHERE id=$1 AND health='building' RETURNING *`,
        [c.id, failReason, failureClass]);
      if (row) broadcast('container', row);
    } catch { /* the DB is what failed — recoverOrphanBuilds() at boot is the backstop */ }
    logline('build', `env reload restart ERRORED: ${c.name} — ${failReason} (marked down)`);
    return { restarted: true, containerId, role: c.role, ok: false, health: 'down', failReason };
  }
}

// Is this xell's stack built from the code that is in its worktree RIGHT NOW?
//
// This is the question a zee actually has after a build ("is the container serving MY fix?"), and
// without an answer it invents a curl-poll loop against its own webapp that greps for a string —
// which hangs forever when it guesses the condition wrong. The queenzee already knows: it records
// last_build_commit at build time. So answer it here, from server truth.
// build-container.sh records a SHORT sha (8) while git rev-parse HEAD is the full 40, so `===`
// is never true and every container looks stale. Compare on the shorter one's length.
function sameCommit(a, b) {
  if (!a || !b) return false;
  const n = Math.min(a.length, b.length);
  return n >= 7 && a.slice(0, n) === b.slice(0, n);
}

export async function getBuildStatus(xellId) {
  const xell = await one(`SELECT id, slug, worktree_path FROM xell WHERE id=$1`, [xellId]);
  if (!xell) throw new Error('xell not found');
  const head = xell.worktree_path ? headCommit(xell.worktree_path, 'HEAD') : null;

  // c.* (not an explicit column list) so a read path never crashes on a schema the migration has
  // not yet reached — last_build_error_class (233) rides along when present, and a row that lacks
  // it (pre-233, or a failure never classified) is handled honestly: buildFailureNextStep treats a
  // missing class as UNKNOWN and never guesses CODE.
  const cs = await q(
    `SELECT c.*
       FROM container c WHERE c.owner_xell_id=$1 AND c.role = ANY($2) ORDER BY c.role`,
    [xellId, [...BUILDABLE]]);

  // The registry that a split build would use (project's own, else the global default). Reported so
  // a zee can tell whether a foreign build_ctx is even possible before it tries.
  const registry = cs.length ? await registryFor(cs[0].project_id) : (config.registry || null);

  // TKT-136 defect #2: --wait must not report UP from a readiness signal that does not prove the
  // published port serves. Live-probe each settled container at its PUBLISHED host:port (no
  // localhost shortcut). A refused/timed-out port is DOWN for --wait, with the boot-log tail so
  // the zee sees why — even if the monitor row still says 'up' from a localhost-only answer.
  const containers = [];
  for (const c of cs) {
    // Process roles (docker_ctx NULL): restamp a pre-TKT-136 host (dev machine ip) to the
    // queenzee-reachable address before probing, so --watch after ship heals the binding without
    // forcing a rebuild. Compose-backed roles keep their stamped host.
    if (c.docker_ctx == null && c.host_port) {
      const host = processRoleReachableHost();
      const url = processRolePublishedUrl(c.host_port);
      if (c.host !== host || c.url !== url) {
        await one(
          `UPDATE container SET host=$2, url=$3 WHERE id=$1 AND docker_ctx IS NULL`,
          [c.id, host, url]);
        c.host = host;
        c.url = url;
      }
    }
    let published_health = null;
    let boot_log_tail = null;
    let health = c.health;
    if (c.health !== 'building') {
      published_health = await probePublishedRole(c);
      if (published_health === 'down') {
        health = 'down';
        boot_log_tail = processBootLogTail(xell.worktree_path, c.role);
      } else if (published_health === 'up') {
        health = 'up';
      }
    }
    containers.push({
      ...c,
      health,
      // where it COMPILES vs where it RUNS — 'split' when they differ (the image rides the registry).
      build_ctx: c.build_ctx || c.docker_ctx,
      run_ctx: c.docker_ctx,
      split_build: !!c.build_ctx && c.build_ctx !== c.docker_ctx,
      published_url: publishedUrl(c),
      published_health,
      boot_log_tail,
      // The classified cause (INFRA | CODE, migration 233) and the exact next step, so
      // `zee build --wait`/--watch and the host xell-build.mjs print WHAT TO DO, not just the tail.
      last_build_error_class: c.last_build_error_class || null,
      last_build_error_next_step: c.last_build_error
        ? buildFailureNextStep(c.last_build_error_class, c.last_build_error, c)
        : null,
      // A HOT build re-used the old image, so its recorded commit does NOT mean the code is live.
      // serving_head also requires the published port to answer — not just a health row.
      serving_head: !!head && !c.hot_build && health === 'up' && published_health === 'up'
        && sameCommit(c.last_build_commit, head),
      never_built: !c.last_build_commit,
    });
  }
  return {
    xell: { id: xell.id, slug: xell.slug },
    head,
    registry,                                            // null → split builds unavailable
    building: containers.some((c) => c.health === 'building'),
    settled: containers.every((c) => c.health !== 'building'),
    all_serving_head: containers.length > 0 && containers.every((c) => c.serving_head),
    containers,
  };
}

// Recover builds orphaned by a server restart.
//
// buildContainer finalizes health from an in-process background promise, and the health monitor
// deliberately SKIPS health='building' so it can't clobber a live build's spinner. Together that
// means a restart mid-build strands the container at 'building' FOREVER: the promise died, and
// the one thing that would fix it refuses to look. The dashboard spins and a waiting zee waits
// forever. At boot there can be no in-flight build in THIS process, so every 'building' row is by
// definition an orphan — hand them back to the monitor.
export async function recoverOrphanBuilds() {
  const rows = await q(
    `UPDATE container SET health='unknown' WHERE health='building' RETURNING id, name`);
  for (const r of rows) broadcast('container', r);
  if (rows.length) {
    logline('build', `recovered ${rows.length} orphaned build(s) after restart: `
      + `${rows.map((r) => r.name).join(', ')} — health monitor will re-derive from docker`);
  }
  return rows.length;
}

// Build a xell's buildable containers. role=null → both (server + webapp); otherwise just that
// one. This is the sanctioned entry point for a zee: it goes through the queenzee, so the commit,
// hot flag, health and dashboard all stay truthful.
export async function buildXell(xellId, { hot = false, role = null, buildCtx } = {}) {
  if (role && !BUILDABLE.has(role)) throw new Error(`role '${role}' is not buildable (server|webapp|all)`);
  const cs = await q(
    `SELECT id FROM container WHERE owner_xell_id=$1 AND role = ANY($2) ORDER BY role`,
    [xellId, role ? [role] : [...BUILDABLE]]);
  if (!cs.length) throw new Error(`xell has no buildable ${role || 'server/webapp'} container`);
  const started = [];
  for (const c of cs) started.push(await buildContainer(c.id, { hot, buildCtx }).catch((e) => ({ error: e.message })));
  return started;
}
