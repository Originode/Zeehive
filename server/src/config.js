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
  repoRoot,
  databaseUrl: process.env.DATABASE_URL || 'postgres://zeehive:zeehive@localhost:5433/zeehive',
  port: int(process.env.PORT, 4700),
  apiBase: process.env.ZEEHIVE_API || `http://localhost:${int(process.env.PORT, 4700)}`,
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
  devHostIp: process.env.DEV_HOST_IP || '10.1.0.18',
  // Default parent dir for repos cloned via New Project → Clone from GitHub. Unset on the host
  // era (the clone form asks for an explicit destination); the containerized queenzee sets it
  // to the repos volume (/repos) so clones land there without the human typing container paths.
  reposDir: process.env.REPOS_DIR || null,
  // How a CAGE reaches the queenzee API. host.docker.internal:4700 works from a cage whether
  // the queenzee is the host process or a container publishing 4700; override with the compose
  // service name if host publishing ever stops.
  cageApiBase: process.env.CAGE_API_BASE || 'http://host.docker.internal:4700',
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
};
