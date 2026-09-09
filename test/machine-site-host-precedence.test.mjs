// TKT-180 — DEPLOY_SITE IS THE SINGLE SOURCE OF A MACHINE-PLACED CONTAINER'S HOST.
//
// THE DEFECT: machine.host_ip was authoritative for where a machine-placed container is
// advertised. ugreen-nas carried host_ip=10.0.1.18 while the deploy_site row and
// docker-compose.prod.yml (ZEEHIVE_CTX_UGREEN=tcp://10.1.0.18:2375) both said 10.1.0.18 — so
// every spin container stamped from that row inherited an address that never answered, and
// `zee build --wait` reported a genuinely-serving container as DOWN.
//
// THE FIX (docs/deploy-topology-spec.md §5): deploy_site is the source of truth for WHERE a
// tier runs. The dev site whose docker_ctx matches the machine's context WINS over the machine
// row's host_ip; machine.host_ip becomes the fallback. A reconcile (healStaleSiteHostRows,
// mirroring healHostlessDbRows) rewrites the rows already stamped under the old precedence and
// no-ops on rows that are already correct.
//
// This file pins all four: the precedence, the fallback, the stale-row heal, and the idempotent
// seed that corrects ugreen-nas's machine row. Requires a REAL throwaway postgres — the cage's
// own `zee db-sandbox` (the shared dev db refuses these fixtures; this test never touches it).
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = resolve(ROOT, 'scripts', 'zee');

let fail = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) fail++; };
const section = (t) => console.log(`\n── ${t} ──`);

// ── start the sandbox and read its DSN (reuses a running one) ─────────────────────────────────
const start = spawnSync(process.execPath, [CLI, 'db-sandbox'], { encoding: 'utf8', timeout: 10 * 60 * 1000 });
let json = null;
try { json = JSON.parse(start.stdout); } catch { /* reported below */ }
if (!json?.dsn) {
  console.error('could not start `zee db-sandbox` — this test needs a real throwaway postgres.');
  console.error(start.stdout || start.stderr || '(no output)');
  process.exit(2);
}
const DSN = json.dsn;

// Set DATABASE_URL BEFORE importing anything that reads config, so config.databaseUrl IS the sandbox.
process.env.DATABASE_URL = DSN;
process.env.PROVISION_MODE = 'simulate';
process.env.BUILD_MODE = 'simulate';
process.env.SHIP_MODE = 'simulate';
process.env.TKB_NOTIFY = '0';

const { machineDbHost, siteHostForMachine, queenzeeHostCtx } =
  await import('../server/src/lib/machines.js');
const { healStaleSiteHostRows } = await import('../server/src/queenzee/containers.js');
const { config } = await import('../server/src/config.js');

const admin = new pg.Client({ connectionString: DSN });
await admin.connect();

// ── fixtures (unique per run so a stale row can never collide) ────────────────────────────────
const tag = randomUUID().slice(0, 8).replace(/[^a-z0-9]/g, '');
const projectName = `tkt180-pj-${tag}`;
const machineKey = 'ugreen-nas';               // the seed targets this exact key
const machineCtx = `ugreen-${tag}`;            // unique ctx so we never touch real fleet data
const siteKey = `tkt180-site-${tag}`;
const staleServer = `tkt180-spin-server-${tag}`;
const correctWeb = `tkt180-spin-web-${tag}`;
const staleDb = `tkt180-db-dev-${tag}`;

let projectId, machineId, siteId;
try {
  // ── set up ───────────────────────────────────────────────────────────────────────────────────
  // db_user/db_name drive the derived conn_ref (healHostlessDbRows' shape) — set them so a db
  // row's re-stamped DSN is exactly what the fixture inserted.
  const { rows: [pj] } = await admin.query(
    `INSERT INTO project (name, repo_root, main_branch, db_user, db_name)
     VALUES ($1, $2, 'main', 'zeehive', 'zeehive') RETURNING id`,
    [projectName, `/tmp/${projectName}`]);
  projectId = pj.id;

  const { rows: [m] } = await admin.query(
    `INSERT INTO machine (key, label, docker_ctx, host_ip, can_build, can_device, enabled)
     VALUES ($1, 'TKT-180 test', $2, '10.0.1.18', false, false, true) RETURNING id`,
    [machineKey, machineCtx]);
  machineId = m.id;

  const { rows: [s] } = await admin.query(
    `INSERT INTO deploy_site (project_id, key, tier, docker_ctx, host, is_default)
     VALUES ($1, $2, 'dev', $3, '10.1.0.18', true) RETURNING id`,
    [projectId, siteKey, machineCtx]);
  siteId = s.id;

  const machine = { docker_ctx: machineCtx, host_ip: '10.0.1.18', key: machineKey };
  const project = { id: projectId, name: projectName, dev_host_ip: null, db_user: null, db_name: null };

  // ── 1. the precedence: a matching dev deploy_site WINS over machine.host_ip ────────────────
  section('deploy_site wins — the dev site whose docker_ctx matches the machine');
  ok(await siteHostForMachine(projectId, machineCtx) === '10.1.0.18',
     'siteHostForMachine(project, ctx) returns the matching dev site host (10.1.0.18)');
  ok(await machineDbHost(machine, project, config) === '10.1.0.18',
     'machineDbHost resolves to the SITE host, NOT machine.host_ip (10.0.1.18) — the TKT-180 flip');
  ok(await siteHostForMachine(projectId, 'some-other-ctx') === null,
     'a context with no dev site → null (fallback owns the answer)');

  // ── 2. the heal rewrites stale rows and no-ops on correct ones ─────────────────────────────
  section('healStaleSiteHostRows — rewrites a stale row, leaves a correct one alone');
  // isolation='shared' on purpose: the heal filters on docker_ctx+tier+host, not isolation, and
  // per-xell rows need an owner xell (a whole fixture we do not need to prove the host rewrite).
  await admin.query(
    `INSERT INTO container (project_id, role, tier, isolation, name, docker_ctx, host, host_port, internal_port, url, site_id)
     VALUES ($1, 'server', 'spinoff', 'shared', $2, $3, '10.0.1.18', 4858, 3000, 'http://10.0.1.18:4858', $4)`,
    [projectId, staleServer, machineCtx, siteId]);
  await admin.query(
    `INSERT INTO container (project_id, role, tier, isolation, name, docker_ctx, host, host_port, internal_port, url, site_id)
     VALUES ($1, 'webapp', 'spinoff', 'shared', $2, $3, '10.1.0.18', 5358, 5173, 'http://10.1.0.18:5358', $4)`,
    [projectId, correctWeb, machineCtx, siteId]);
  await admin.query(
    `INSERT INTO container (project_id, role, tier, isolation, name, docker_ctx, host, host_port, conn_ref, site_id)
     VALUES ($1, 'db', 'dev', 'shared', $2, $3, '10.0.1.18', 32772, 'postgresql://zeehive@10.0.1.18:32772/zeehive', $4)`,
    [projectId, staleDb, machineCtx, siteId]);

  const healed1 = await healStaleSiteHostRows();
  ok(healed1 >= 2, `first heal rewrote the stale rows (healed ${healed1})`);

  const { rows: [server] } = await admin.query(
    `SELECT host, url FROM container WHERE name = $1`, [staleServer]);
  ok(server.host === '10.1.0.18' && server.url === 'http://10.1.0.18:4858',
     `the stale server row is re-stamped: host=${server.host}, url=${server.url}`);
  const { rows: [web] } = await admin.query(
    `SELECT host, url FROM container WHERE name = $1`, [correctWeb]);
  ok(web.host === '10.1.0.18' && web.url === 'http://10.1.0.18:5358',
     'the already-correct row is untouched');
  const { rows: [db] } = await admin.query(
    `SELECT host, conn_ref FROM container WHERE name = $1`, [staleDb]);
  ok(db.host === '10.1.0.18' && db.conn_ref === 'postgresql://zeehive@10.1.0.18:32772/zeehive',
     `the shared dev db is re-stamped too, and its conn_ref follows the host (${db.conn_ref})`);

  const healed2 = await healStaleSiteHostRows();
  ok(healed2 === 0, `second heal no-ops (healed ${healed2}) — the rows are already correct`);

  // ── 3. with no site row it falls back to machine.host_ip unchanged ─────────────────────────
  section('no matching deploy_site → machine.host_ip is the fallback');
  await admin.query(`DELETE FROM deploy_site WHERE id = $1`, [siteId]); siteId = null;
  ok(await siteHostForMachine(projectId, machineCtx) === null, 'no dev site for the ctx → null');
  ok(await machineDbHost(machine, project, config) === '10.0.1.18',
     'machineDbHost falls back to machine.host_ip (10.0.1.18) when no site matches');

  // ── 4. the seed corrects ugreen-nas and is idempotent ──────────────────────────────────────
  section('server/sql/seeds/fix_ugreen_nas_host_ip.sql — idempotent machine-row correction');
  const seedSql = readFileSync(resolve(ROOT, 'server', 'sql', 'seeds', 'fix_ugreen_nas_host_ip.sql'), 'utf8');
  ok(/WHERE key = 'ugreen-nas'/.test(seedSql), 'the seed targets the ugreen-nas machine row');
  ok(/host_ip IS DISTINCT FROM '10\.1\.0\.18'/.test(seedSql),
     'and only fires when host_ip is not already 10.1.0.18 (re-runnable)');
  await admin.query(seedSql);
  const { rows: [after] } = await admin.query(`SELECT host_ip FROM machine WHERE id = $1`, [machineId]);
  ok(after.host_ip === '10.1.0.18', 'the seed corrects machine.host_ip to 10.1.0.18');
  await admin.query(seedSql);
  const { rows: [after2] } = await admin.query(`SELECT host_ip FROM machine WHERE id = $1`, [machineId]);
  ok(after2.host_ip === '10.1.0.18', 're-running the seed is a no-op (still 10.1.0.18)');

  // ── sanity: config really pointed at the sandbox (the assertions above are meaningful) ─────
  ok(config.databaseUrl === DSN, `config.databaseUrl is the sandbox DSN (${config.databaseUrl})`);
  ok(queenzeeHostCtx() === 'default', 'queenzeeHostCtx still resolves (module imports clean)');
} finally {
  // Tear down in FK order. The sandbox itself is throwaway and deliberately NOT stopped — other
  // tests / the zee may be using it.
  const clean = async (sql, params) => { try { await admin.query(sql, params); } catch { /* ignore */ } };
  if (siteId) await clean('DELETE FROM deploy_site WHERE id = $1', [siteId]);
  await clean(`DELETE FROM container WHERE name IN ($1,$2,$3)`, [staleServer, correctWeb, staleDb]);
  if (machineId) await clean('DELETE FROM machine WHERE id = $1', [machineId]);
  if (projectId) await clean('DELETE FROM project WHERE id = $1', [projectId]);
  await admin.end().catch(() => {});
}

console.log(fail ? `\n${fail} FAILURE(S)` : '\nall good');
process.exit(fail ? 1 : 0);
