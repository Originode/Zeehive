// TKT-181-9EDA — a worker xell's projected DATABASE_URL always carries a credential that
// authenticates against the database the DSN names.
//
// conn_refs are passwordless BY DESIGN ("secret NAME only, never the password"): a docker-exec
// psql authenticates through the container's socket, so the inventory never needed the role
// password. But a CXELL zee has no docker and reaches postgres over TCP, where postgres demands
// SCRAM — so a passwordless DATABASE_URL is refused before a single query runs. resolveXellDsn
// used to inject the manifest db.password (the committed dev credential) ONLY for process-runner
// xells' OWN dbs, leaving compose-runner xells passwordless and shared dev rows always
// passwordless — and the manifest credential is not even the real password of every shared dev
// db (measured 2026-09-02: ugreen-nas's runs provision-xell-db.sh's default 'omnibiz' while the
// manifest says 'zeehive').
//
// The fix: a new per-container source of truth, container.conn_pw, records the ACTUAL password
// the database was provisioned with; resolveXellDsn injects it into every projected DSN. This
// test pins the projection for every worker coupling:
//   • shared dev db (compose runner) whose row carries conn_pw   → DSN carries conn_pw
//   • … and NEVER the manifest password when they differ         → the ugreen-nas principle
//   • own per-xell db (compose runner) with conn_pw              → DSN carries conn_pw
//   • own per-xell db (process runner) with conn_pw              → DSN carries conn_pw
//   • a shared dev row with NO conn_pw stays passwordless        → never guessed; the preflight
//                                                                  names the fault instead
import { mkdtempSync, rmSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }
process.env.PROVISION_MODE = 'simulate';
process.env.BUILD_MODE = 'simulate';
process.env.TKB_NOTIFY = '0';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

const { q, one, pool } = await import('../server/src/db/pool.js');
const { emitXellEnv } = await import('../server/src/lib/provision.js');
const { postgresPasswordFromEnv } = await import('../server/src/lib/machines.js');

const tag = randomUUID().slice(0, 8).replace(/[^a-z0-9]/g, '');
const root = mkdtempSync(join(tmpdir(), `dsncred-${tag}-`));
let pid = null;
const pids = [];   // one per project fixture — the process-runner case needs its own manifest

function projection(dir) {
  const text = readFileSync(join(dir, '.zeehive.env'), 'utf8');
  const vars = {};
  for (const line of text.split('\n')) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (m) vars[m[1]] = m[2];
  }
  return { text, vars };
}
// the credential a projected DSN carries — the whole point of this ticket. Returns null when the
// DSN has no password (a passwordless DSN is the bug).
function dsnPassword(dsn) {
  const m = /^postgres(?:ql)?:\/\/[^:/@]+:([^@/]*)@/.exec(String(dsn || ''));
  return m ? decodeURIComponent(m[1]) : null;
}

const REAL_SHARED_PW = `omnibiz_${tag}`;     // what the container was actually created with
const MANIFEST_PW    = `manifest_${tag}`;    // the committed dev credential — NOT the shared db's

try {
  pid = (await one(
    `INSERT INTO project (name, repo_root, db_user, db_name, manifest)
       VALUES ($1,$2,'zeehive','zeehive',$3::jsonb) RETURNING id`,
    [`dsncred-${tag}`, process.cwd(), JSON.stringify({
      db: { name: 'zeehive', user: 'zeehive', password: MANIFEST_PW },
      tiers: { spinoff: { ports: {
        server: { env: 'PORT', base: 4800, mod: 90 },
        webapp: { env: 'ZEEHIVE_WEB_PORT', base: 5300, mod: 90 },
      } } },
      roles: { server: {}, webapp: {} },
    })])).id;
  pids.push(pid);
  const xoid = (await one(`INSERT INTO xource (project_id, ref) VALUES ($1,'master') RETURNING id`, [pid])).id;

  // ── the shared dev db — the container the fleet's worker xells actually use ───────────────────
  const sharedDevId = (await one(
    `INSERT INTO container (project_id, role, tier, isolation, name, docker_ctx, internal_port,
                            conn_ref, conn_pw)
       VALUES ($1,'db','dev','shared',$2,'default',5432,$3,$4) RETURNING id`,
    [pid, `dsncred_shared_${tag}`,
     `postgresql://zeehive@10.0.0.5:32770/zeehive`, REAL_SHARED_PW])).id;
  // a shared dev db that records no conn_ref but IS published (host+host_port) — the derived-TCP
  // branch of resolveXellDsn — carrying conn_pw for its derived DSN too
  const publishedDevId = (await one(
    `INSERT INTO container (project_id, role, tier, isolation, name, docker_ctx, internal_port,
                            host, host_port, conn_ref, conn_pw)
       VALUES ($1,'db','dev','shared',$2,'default',5432,'10.0.0.9',5433,NULL,$3) RETURNING id`,
    [pid, `dsncred_pub_${tag}`, `pub_pw_${tag}`])).id;
  // a second shared dev db whose row predates conn_pw (the column is new) — nothing to project
  const legacySharedId = (await one(
    `INSERT INTO container (project_id, role, tier, isolation, name, docker_ctx, internal_port,
                            conn_ref)
       VALUES ($1,'db','dev','shared',$2,'default',5432,$3) RETURNING id`,
    [pid, `dsncred_legacy_${tag}`, `postgresql://zeehive@10.0.0.6:32771/zeehive`])).id;

  const mkXell = async (name, { coupling, useShared = null, ownDb = null }) => {
    const slug = `dsncred-${tag}-${name}`;
    const wt = join(root, name);
    mkdirSync(wt, { recursive: true });
    const x = await one(
      `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status, is_pooled,
                         zee_type, db_coupling)
         VALUES ($1,$2,$3,$4,$5,'working',false,'worker',$6) RETURNING *`,
      [pid, xoid, slug, `spinoff/${slug}`, wt, coupling]);
    if (useShared) {
      await q(`INSERT INTO xell_uses_container (xell_id, container_id, relation) VALUES ($1,$2,'uses')`,
              [x.id, useShared]);
    }
    if (ownDb) {
      const c = await one(
        `INSERT INTO container (project_id, role, tier, isolation, name, docker_ctx, internal_port,
                                host, host_port, conn_ref, conn_pw, owner_xell_id)
           VALUES ($1,'db','spinoff','per-xell',$2,'default',5432,$3,$4,$5,$6,$7) RETURNING id`,
        [pid, `${name}_db_${tag}`, '10.0.0.7', 15432 + name.length,
         `postgresql://zeehive@10.0.0.7:${15432 + name.length}/zeehive`, ownDb, x.id]);
      await q(`INSERT INTO xell_uses_container (xell_id, container_id, relation) VALUES ($1,$2,'owns')`,
              [x.id, c.id]);
    }
    await q(`INSERT INTO container (project_id, role, tier, isolation, name, docker_ctx, internal_port,
                                    host_port, owner_xell_id)
               VALUES ($1,'server','spinoff','per-xell',$2,'default',4700,$3,$4)`,
            [pid, `${name}_srv_${tag}`, 4800 + name.length, x.id]);
    return { ...x, wt };
  };

  // ── 1. compose-runner db-shared-dev WITH conn_pw on the row → the DSN carries the REAL password ─
  console.log('\n── compose-runner db-shared-dev: DSN carries container.conn_pw, not the manifest ──');
  const sharedXell = await mkXell('shared', { coupling: 'db-shared-dev', useShared: sharedDevId });
  await emitXellEnv(sharedXell.id);
  const sharedFile = projection(sharedXell.wt);
  ok(sharedFile.vars.DATABASE_URL ===
       `postgresql://zeehive:${REAL_SHARED_PW}@10.0.0.5:32770/zeehive`,
     `DATABASE_URL carries conn_pw (${sharedFile.vars.DATABASE_URL})`);
  ok(dsnPassword(sharedFile.vars.DATABASE_URL) === REAL_SHARED_PW,
     '…and that password is the container’s real one');
  ok(dsnPassword(sharedFile.vars.DATABASE_URL) !== MANIFEST_PW,
     '…NOT the manifest db.password — the ugreen-nas principle (manifest ≠ reality)');

  // ── 1b. the PUBLISHED shared dev db (no conn_ref, derived TCP DSN) carries its conn_pw too ─────
  console.log('\n── published shared dev db: the DERIVED TCP DSN also carries conn_pw ──');
  const publishedXell = await mkXell('pub', { coupling: 'db-shared-dev', useShared: publishedDevId });
  await emitXellEnv(publishedXell.id);
  const publishedFile = projection(publishedXell.wt);
  ok(publishedFile.vars.DATABASE_URL === `postgresql://zeehive:pub_pw_${tag}@10.0.0.9:5433/zeehive`,
     `the derived door carries the recorded password (${publishedFile.vars.DATABASE_URL})`);

  // ── 2. own per-xell db, compose runner → DSN carries the recorded conn_pw ──────────────────────
  console.log('\n── own per-xell db (compose runner): conn_pw lands in the projected DSN ──');
  const ownCompose = await mkXell('owncomp', { coupling: 'db-isolated', ownDb: `own_pw_${tag}` });
  await emitXellEnv(ownCompose.id);
  const ownCompFile = projection(ownCompose.wt);
  ok(dsnPassword(ownCompFile.vars.DATABASE_URL) === `own_pw_${tag}`,
     `DATABASE_URL carries the own db’s conn_pw (${ownCompFile.vars.DATABASE_URL})`);
  ok(dsnPassword(ownCompFile.vars.DATABASE_URL) !== MANIFEST_PW,
     '…which overrides the manifest fallback for an owned row too');

  // ── 3. own per-xell db, PROCESS runner → same rule ────────────────────────────────────────────
  // A separate project whose spinoff tier RUNS AS PROCESSES — the runner the old code singled out
  // for manifest-password injection. Its owned row carries conn_pw='proc_pw' while the manifest
  // says MANIFEST_PW: before this fix the DSN would carry the MANIFEST password (the old process
  // injection path), after it the DSN must carry the recorded conn_pw — the real one.
  console.log('\n── own per-xell db (process runner): conn_pw wins over the manifest injection ──');
  const procPid = (await one(
    `INSERT INTO project (name, repo_root, db_user, db_name, manifest)
       VALUES ($1,$2,'zeehive','zeehive',$3::jsonb) RETURNING id`,
    [`dsncred-proc-${tag}`, process.cwd(), JSON.stringify({
      db: { name: 'zeehive', user: 'zeehive', password: MANIFEST_PW },
      tiers: { spinoff: { runner: 'process', ports: {
        server: { env: 'PORT', base: 4800, mod: 90 },
        webapp: { env: 'ZEEHIVE_WEB_PORT', base: 5300, mod: 90 },
      } } },
      roles: {
        server: { runner: 'process', start: 'npm run server' },
        webapp: { runner: 'process', start: 'npm run web' },
      },
    })])).id;
  pids.push(procPid);
  const procXoid = (await one(`INSERT INTO xource (project_id, ref) VALUES ($1,'master') RETURNING id`, [procPid])).id;
  const procSlug = `dsncred-proc-${tag}-own`;
  const procWt = join(root, 'ownproc');
  mkdirSync(procWt, { recursive: true });
  const ownProc = (await one(
    `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status, is_pooled,
                       zee_type, db_coupling)
       VALUES ($1,$2,$3,$4,$5,'working',false,'worker','db-isolated') RETURNING *`,
    [procPid, procXoid, procSlug, `spinoff/${procSlug}`, procWt])).id;
  const procDbPort = 15499;
  const procDb = (await one(
    `INSERT INTO container (project_id, role, tier, isolation, name, docker_ctx, internal_port,
                            host, host_port, conn_ref, conn_pw, owner_xell_id)
       VALUES ($1,'db','spinoff','per-xell',$2,'default',5432,'10.0.0.8',$3,$4,$5,$6) RETURNING id`,
    [procPid, `ownproc_db_${tag}`, procDbPort,
     `postgresql://zeehive@10.0.0.8:${procDbPort}/zeehive`, `proc_pw_${tag}`, ownProc])).id;
  await q(`INSERT INTO xell_uses_container (xell_id, container_id, relation) VALUES ($1,$2,'owns')`,
          [ownProc, procDb]);
  await q(`INSERT INTO container (project_id, role, tier, isolation, name, docker_ctx, internal_port,
                                  host_port, owner_xell_id)
             VALUES ($1,'server','spinoff','per-xell',$2,'default',4700,$3,$4)`,
          [procPid, `ownproc_srv_${tag}`, 4800 + 6, ownProc]);
  await emitXellEnv(ownProc);
  const ownProcFile = projection(procWt);
  ok(dsnPassword(ownProcFile.vars.DATABASE_URL) === `proc_pw_${tag}`,
     `DATABASE_URL carries the own db’s conn_pw (${ownProcFile.vars.DATABASE_URL})`);
  ok(dsnPassword(ownProcFile.vars.DATABASE_URL) !== MANIFEST_PW,
     '…and NOT the manifest password the old process-runner path would have injected');

  // ── 4. a shared dev row with NO conn_pw is NEVER guessed from the manifest ─────────────────────
  console.log('\n── a conn_pw-less shared dev row stays passwordless (never guessed) ──');
  const legacy = await mkXell('legacy', { coupling: 'db-shared-dev', useShared: legacySharedId });
  await emitXellEnv(legacy.id);
  const legacyFile = projection(legacy.wt);
  ok(dsnPassword(legacyFile.vars.DATABASE_URL) === null,
     `no conn_pw → passwordless DSN, even though the manifest declares one (${legacyFile.vars.DATABASE_URL})`);
  ok(!legacyFile.vars.DATABASE_URL.includes(MANIFEST_PW),
     '…the manifest credential is never injected into a shared db the manifest does not own');

  // ── 5. the docker-inspect parser that feeds the real-mode backfill is exact ───────────────────
  console.log('\n── postgresPasswordFromEnv reads the real container env line ──');
  ok(postgresPasswordFromEnv(['POSTGRES_USER=zeehive', `POSTGRES_PASSWORD=${REAL_SHARED_PW}`, 'PATH=/x']) === REAL_SHARED_PW,
     'finds POSTGRES_PASSWORD among unrelated env lines');
  ok(postgresPasswordFromEnv(['POSTGRES_USER=zeehive']) === null,
     '…and returns null when no POSTGRES_PASSWORD line exists (nothing to record)');

} finally {
  for (const projectId of pids) {
    await q(`DELETE FROM xell_uses_container WHERE xell_id IN (SELECT id FROM xell WHERE project_id=$1)`, [projectId]);
    await q(`DELETE FROM container WHERE project_id=$1`, [projectId]);
    await q(`DELETE FROM xell WHERE project_id=$1`, [projectId]);
    await q(`DELETE FROM xource WHERE project_id=$1`, [projectId]);
    await q(`DELETE FROM project WHERE id=$1`, [projectId]);
  }
  try { rmSync(root, { recursive: true, force: true }); } catch { /* tmp */ }
  await pool.end().catch(() => {});
}

console.log(fail ? `\n${fail} FAILED` : '\nall good');
process.exit(fail ? 1 : 0);
