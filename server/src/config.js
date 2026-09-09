// Central config, loaded from .env at repo root.
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import dotenv from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..');
// A xell worktree has no .env (gitignored) — its parameters live in the GENERATED .zeehive.env
// projection (spec §6.1: ports, DATABASE_URL → the xell's own db, §6.2 safety modes). Load it
// FIRST so it wins over .env when both exist; dotenv never overrides keys already set, so real
// environment variables still beat both. The live checkout has no .zeehive.env — for it this
// line is a no-op and .env stays truth (the 2026-07-17 lesson).
dotenv.config({ path: resolve(repoRoot, '.zeehive.env') });
dotenv.config({ path: resolve(repoRoot, '.env') });

const int = (v, d) => (v == null || v === '' ? d : parseInt(v, 10));

export const config = {
  // THE SERVER'S OWN TREE — where THIS process's code lives, and nothing else. In the image that is
  // /app; in a checkout it is the repo. Use it to resolve things the server SHIPS WITH:
  // scripts/*.sh|mjs, db/migrations/, docker/zeehive/*.
  //
  // A PROJECT'S FILES ARE `project.repo_root`, NEVER THIS. The two coincide in a checkout and diverge
  // in a container, which is why the distinction has to be remembered rather than observed: harnesses
  // were read from `resolve(config.repoRoot, harness.dir)`, so the deployed queenzee looked under /app
  // (which deliberately carries no harnesses/) instead of the project's clone under /repos — found
  // nothing, kept an empty bundle, and dispatched manager zees with no manual for weeks while every
  // test on a checkout passed. Migration 080 removed that class by moving harnesses into the meta-DB;
  // the naming trap it came from is still here. Audit + why the rename was NOT done:
  // docs/repo-root-audit.md (ticket #4).
  //
  // The one place both meanings are meant at once is self-onboard's third fallback ("the tree I am
  // running from IS a project"), and it says so where it happens.
  repoRoot,
  databaseUrl: process.env.DATABASE_URL || 'postgres://zeehive:zeehive@localhost:5433/zeehive',
  port: int(process.env.PORT, 4700),
  apiBase: process.env.ZEEHIVE_API || `http://localhost:${int(process.env.PORT, 4700)}`,
  // THE LLM GATEWAY'S OWN PORT — the transparent LiteLLM-style door cxell CLIs point their base
  // URLs at (ANTHROPIC_BASE_URL etc → host.docker.internal:<gatewayPort>). A SEPARATE listener so
  // it can never shadow API routes (the API is on PORT). See lib/gateway.js.
  gatewayPort: int(process.env.GATEWAY_PORT, 4701),
  // QUEENZEE_INPROC=false starts an API-ONLY instance (the pre-phase-1 slice of the gateway split,
  // docs/queenzee-gateway-split.md): it serves every HTTP route but does NOT take the
  // single-queenzee advisory lock (715533001) and starts NONE of the background loops. The flag
  // answers "are the queenzee loops in THIS process?" — the design's own escape-hatch name for the
  // loop/API boundary (item 23: QUEENZEE_INPROC=true makes one process behave exactly as pre-split).
  // Default true = today's behavior (THE queenzee, loops in-process). The lock is about DRIVING a
  // fleet, not serving HTTP — an API-only instance must be startable on a meta-DB where the live
  // queenzee already holds it, which is exactly the db-shared-dev spinoff case (TKT-136-FE32 /
  // TKT-137-F266).
  queenzeeInproc: process.env.QUEENZEE_INPROC !== 'false',
  claudeHome: process.env.CLAUDE_HOME || resolve(process.env.USERPROFILE || process.env.HOME || '.', '.claude'),
  // Seed-only (db/seed.js) + a last-resort reaper cwd fallback. No baked-in Windows default:
  // the container era has no D:\ — set OMNIBIZ_ROOT in .env where it applies.
  omnibizRoot: process.env.OMNIBIZ_ROOT || null,
  dockerCtx: process.env.SPINOFF_DOCKER_CONTEXT || 'ugreen-nas',
  // OCI registry for split builds (compile on one docker context, run on another). Global
  // fallback when a project has no registry of its own; NULL ⇒ split builds are unavailable.
  // Keep it on the LAN — a registry across a slow link defeats the point of building elsewhere.
  registry: process.env.SPINOFF_REGISTRY || null,
  // Where the docker CLI keeps contexts/meta/<sha256(name)>/meta.json — lib/docker.js reads the
  // endpoint from there instead of shelling out to `docker context inspect`.
  dockerConfigDir: process.env.DOCKER_CONFIG
    || resolve(process.env.USERPROFILE || process.env.HOME || '.', '.docker'),
  // No baked default: 10.1.0.18 was Mark's NAS, and a fresh bootstrap inherited it into every
  // xhip URL — the health monitor then probed a FOREIGN machine (red chips for live processes,
  // and one fake green where the NAS happened to answer the port). NULL falls through to
  // localhost at the consumers, which is correct wherever the queenzee itself runs the probe.
  devHostIp: process.env.DEV_HOST_IP || null,
  // Default parent dir for repos cloned via New Project → Clone from GitHub. Unset on the host
  // era (the clone form asks for an explicit destination); the containerized queenzee sets it
  // to the repos volume (/repos) so clones land there without the human typing container paths.
  reposDir: process.env.REPOS_DIR || null,
  // How a CXELL reaches the queenzee API. host.docker.internal:4700 works from a cxell whether
  // the queenzee is the host process or a container publishing 4700; override with the compose
  // service name if host publishing ever stops. This is the PRIMARY address injected as
  // ZEEHIVE_API; a cage also gets ZEEHIVE_API_FALLBACK (cxellApiFallback) so a script (and the
  // `zee` CLI) has a second name to try when the first does not resolve — the zeehive_server
  // compose name FLAPS (ENOTFOUND while the container is recreated), so host.docker.internal is
  // the stable one and the compose-network name is the fallback, not the other way round.
  cxellApiBase: process.env.CXELL_API_BASE || 'http://host.docker.internal:4700',
  cxellApiFallback: process.env.CXELL_API_FALLBACK || 'http://host.docker.internal:4700',
  // The EXTERNALLY-REACHABLE base URL for /api/ext/v1 — the address a DEPLOYED project on another
  // host uses to file tickets. DELIBERATELY NOT the cxell address above: cxellApiBase defaults to
  // host.docker.internal:4700, which means "the docker host I am running on" — right for a cxell
  // container sitting beside the queenzee, WRONG for a deployed project on its own host (the
  // omnibiz helpdesk bridge sat silently broken for two weeks on exactly that default). An
  // operator sets EXT_API_BASE to the real address (a LAN host:port, a tunnel URL, a reverse-proxy
  // origin). When unset it falls back to DEV_HOST_IP (the queenzee host's LAN address) on the API
  // port so the default is honest wherever a LAN address is known; when neither is set it is null —
  // meaning "no externally-reachable address configured", which /api/ext/v1/whoami, /api/ext/v1/
  // limits and the console report plainly instead of handing an integrator an address that points
  // at its own docker host.
  extApiBase: process.env.EXT_API_BASE
    || (process.env.DEV_HOST_IP ? `http://${process.env.DEV_HOST_IP}:${int(process.env.PORT, 4700)}` : null),
  poolTargetReady: int(process.env.POOL_TARGET_READY, 3),
  pollerIntervalMs: int(process.env.POLLER_INTERVAL_MS, 4000),
  poolIntervalMs: int(process.env.POOL_INTERVAL_MS, 15000),
  // where prod DB dumps land by default (per-project override via pool_config.backup_dir),
  // and how often the maintenance scheduler wakes to check whether a backup is due.
  backupDir: process.env.BACKUP_DIR || resolve(repoRoot, 'db_backups'),
  maintTickMs: int(process.env.MAINT_TICK_MS, 60000),
  // The PRODUCTION application database to dump (inside the modeled prod db container) — NOT
  // the zeehive meta DB above. db name defaults to the project name; role/tier resolve the
  // container from the inventory, so only user/name need overriding for an off-convention prod.
  prodDbName: process.env.PROD_DB_NAME || null,
  prodDbUser: process.env.PROD_DB_USER || 'postgres',
  // The NetBird control plane (docs/netbird-mesh-plan.md) — the self-hosted management API the
  // queenzee drives peer lifecycle through. BOTH unset = the mesh is disabled and every mesh
  // consumer degrades to legacy host:port answers; the token is a real secret and lives only in
  // the queenzee's env (surfaced as PRESENCE ONLY by `zee infra settings`, never the value).
  netbirdApiUrl: process.env.NETBIRD_API_URL || null,
  netbirdApiToken: process.env.NETBIRD_API_TOKEN || null,
  // The mesh DNS domain peers resolve under (<hostname>.<domain>). NetBird's self-hosted default.
  meshDomain: process.env.MESH_DOMAIN || 'netbird.selfhosted',
};
