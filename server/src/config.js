// Central config, loaded from .env at repo root.
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import dotenv from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..');
dotenv.config({ path: resolve(repoRoot, '.env') });

const int = (v, d) => (v == null || v === '' ? d : parseInt(v, 10));

export const config = {
  repoRoot,
  databaseUrl: process.env.DATABASE_URL || 'postgres://xeehive:xeehive@localhost:5433/xeehive',
  port: int(process.env.PORT, 4700),
  apiBase: process.env.XEEHIVE_API || `http://localhost:${int(process.env.PORT, 4700)}`,
  claudeHome: process.env.CLAUDE_HOME || resolve(process.env.USERPROFILE || process.env.HOME || '.', '.claude'),
  omnibizRoot: process.env.OMNIBIZ_ROOT || 'D:\\Repos\\OmniBiz\\omnibiz',
  dockerCtx: process.env.SPINOFF_DOCKER_CONTEXT || 'ugreen-nas',
  devHostIp: process.env.DEV_HOST_IP || '10.1.0.18',
  poolTargetReady: int(process.env.POOL_TARGET_READY, 3),
  pollerIntervalMs: int(process.env.POLLER_INTERVAL_MS, 4000),
  poolIntervalMs: int(process.env.POOL_INTERVAL_MS, 15000),
  // where prod DB dumps land by default (per-project override via pool_config.backup_dir),
  // and how often the maintenance scheduler wakes to check whether a backup is due.
  backupDir: process.env.BACKUP_DIR || resolve(repoRoot, 'db_backups'),
  maintTickMs: int(process.env.MAINT_TICK_MS, 60000),
  // The PRODUCTION application database to dump (inside the modeled prod db container) — NOT
  // the xeehive meta DB above. db name defaults to the project name; role/tier resolve the
  // container from the inventory, so only user/name need overriding for an off-convention prod.
  prodDbName: process.env.PROD_DB_NAME || null,
  prodDbUser: process.env.PROD_DB_USER || 'postgres',
};
