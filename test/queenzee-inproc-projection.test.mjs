// QUEENZEE_INPROC projection — the LAST slice of TKT-136 / the API-only flag.
//
// The flag itself is landed (server/src/config.js, index.js, test/queenzee-inproc-api-only.test.mjs):
// QUEENZEE_INPROC=false starts the server without advisory lock 715533001 and without any loop.
// Nothing was SETTING the flag, so a spinoff on db-shared-dev still blocked ~90s on the lock the
// live queenzee already holds and never served (TKT-136-FE32).
//
// This pins the projection rule in lib/provision.writeXellEnv / emitXellEnv:
//
//   1. db_coupling === 'db-shared-dev'  →  .zeehive.env carries QUEENZEE_INPROC=false
//      (process-runner Zeehive xells; start-xell-process.sh unsets+reloads the file so the value
//      wins over the parent queenzee's env).
//   2. A xell on its OWN db (clone / isolated / owned container) does NOT get the flag — full
//      inproc stays the default so a nested queenzee on a private meta still takes the lock.
//   3. sameDatabase(DATABASE_URL, managing meta-DB) also projects the flag (the db-prod-readonly
//      exemption path that emits the managing meta-DB DSN under a different coupling name).
//   4. QUEENZEE_INPROC is a reserved structural name — an environment cannot flip it back to true.
//
// Does NOT boot index.js (that is queenzee-inproc-api-only.test.mjs). This only asserts what the
// projection WRITES, which is the start-path seam both eras read.
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
const { config } = await import('../server/src/config.js');
const { emitXellEnv } = await import('../server/src/lib/provision.js');

const tag = randomUUID().slice(0, 8).replace(/[^a-z0-9]/g, '');
const root = mkdtempSync(join(tmpdir(), `inproc-proj-${tag}-`));
let pid = null;

function readEmitted(dir) {
  const text = readFileSync(join(dir, '.zeehive.env'), 'utf8');
  const vars = {};
  for (const line of text.split('\n')) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (m) vars[m[1]] = m[2];
  }
  return { text, vars };
}

try {
  // Process-runner project (Zeehive's own shape): resolveXellDsn emits the shared-dev conn_ref
  // for db-shared-dev, and start-xell-process.sh is what reads the projection.
  pid = (await one(
    `INSERT INTO project (name, repo_root, db_user, db_name, manifest)
       VALUES ($1,$2,'zeehive','zeehive',$3::jsonb) RETURNING id`,
    [`inproc-proj-${tag}`, process.cwd(), JSON.stringify({
      tiers: { spinoff: { runner: 'process', ports: {
        server: { env: 'PORT', base: 4800, mod: 90 },
        webapp: { env: 'ZEEHIVE_WEB_PORT', base: 5300, mod: 90 },
      } } },
      roles: {
        server: { runner: 'process', start: 'npm run server' },
        webapp: { runner: 'process', start: 'npm run web' },
      },
    })])).id;
  const xoid = (await one(`INSERT INTO xource (project_id, ref) VALUES ($1,'master') RETURNING id`, [pid])).id;

  // An environment that tries to re-enable inproc — the projection must drop it.
  const env = await one(
    `INSERT INTO environment (project_id,key,tier,label,is_default)
       VALUES ($1,$2,'dev','inproc-proj fixture',true) RETURNING *`,
    [pid, `dev-${tag}`]);
  await q(
    `INSERT INTO environment_var (environment_id,name,value,is_secret) VALUES ($1,'QUEENZEE_INPROC','true',false)`,
    [env.id]);
  await q(
    `INSERT INTO environment_var (environment_id,name,value,is_secret) VALUES ($1,'WHICH_ENV','dev',false)`,
    [env.id]);

  const SHARED_DEV = `postgresql://zeehive@shared_dev_${tag}:5432/devdb`;
  const OWNED = (n) => `postgresql://zeehive@inproc_${tag}_${n}_db:5432/zeehive`;

  // Shared-dev container the xell USES (not owns) — the process-runner db-shared-dev path.
  const sharedDevId = (await one(
    `INSERT INTO container (project_id, role, tier, isolation, name, docker_ctx, internal_port, conn_ref)
       VALUES ($1,'db','dev','shared',$2,'default',5432,$3) RETURNING id`,
    [pid, `inproc_shared_${tag}`, SHARED_DEV])).id;

  const mkXell = async (name, { coupling, ownedDb = null, roDsn = null, useShared = false }) => {
    const slug = `inproc-proj-${tag}-${name}`;
    const wt = join(root, name);
    mkdirSync(wt, { recursive: true });
    const x = await one(
      `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status, is_pooled,
                         zee_type, db_coupling, prod_ro_dsn)
         VALUES ($1,$2,$3,$4,$5,'working',false,'worker',$6,$7) RETURNING *`,
      [pid, xoid, slug, `spinoff/${slug}`, wt, coupling, roDsn]);
    if (ownedDb) {
      await q(`INSERT INTO container (project_id, role, tier, isolation, name, docker_ctx, internal_port,
                                      conn_ref, owner_xell_id)
                 VALUES ($1,'db','spinoff','per-xell',$2,'default',5432,$3,$4)`,
              [pid, `inproc_${tag}_${name}_db`, ownedDb, x.id]);
    }
    if (useShared) {
      await q(`INSERT INTO xell_uses_container (xell_id, container_id, relation) VALUES ($1,$2,'uses')`,
              [x.id, sharedDevId]);
    }
    // server row so ports land (emit needs something to stamp)
    await q(`INSERT INTO container (project_id, role, tier, isolation, name, docker_ctx, internal_port,
                                    host_port, owner_xell_id)
               VALUES ($1,'server','spinoff','per-xell',$2,'default',4700,$3,$4)`,
            [pid, `inproc_${tag}_${name}_srv`, 4800 + name.length, x.id]);
    return { ...x, wt };
  };

  const shared = await mkXell('shared', { coupling: 'db-shared-dev', useShared: true });
  const iso    = await mkXell('iso',    { coupling: 'db-isolated', ownedDb: OWNED('iso') });
  const clone  = await mkXell('clone',  { coupling: 'db-clone', ownedDb: OWNED('clone') });

  // ── 1. db-shared-dev → QUEENZEE_INPROC=false ────────────────────────────────────────────────
  console.log('\n── db-shared-dev projects QUEENZEE_INPROC=false ──');
  await emitXellEnv(shared.id);
  const sharedFile = readEmitted(shared.wt);
  ok(sharedFile.vars.QUEENZEE_INPROC === 'false',
     `db-shared-dev → QUEENZEE_INPROC=false (got ${sharedFile.vars.QUEENZEE_INPROC ?? '(unset)'})`);
  ok(sharedFile.vars.DATABASE_URL === SHARED_DEV,
     `db-shared-dev (process runner) still gets the shared-dev DATABASE_URL (${sharedFile.vars.DATABASE_URL})`);
  ok(/shared meta-DB|TKT-136|API-only/i.test(sharedFile.text),
     'the projection comments WHY the flag is there (TKT-136 / API-only / shared meta-DB)');
  ok(sharedFile.vars.WHICH_ENV === 'dev',
     'environment vars still merge (WHICH_ENV=dev) — the flag does not break the rest of the file');

  // ── 2. own-db couplings do NOT get the flag ─────────────────────────────────────────────────
  console.log('\n── own-db couplings keep default inproc (flag absent) ──');
  await emitXellEnv(iso.id);
  const isoFile = readEmitted(iso.wt);
  ok(isoFile.vars.QUEENZEE_INPROC === undefined,
     `db-isolated does NOT set QUEENZEE_INPROC (got ${isoFile.vars.QUEENZEE_INPROC ?? '(unset)'})`);
  ok(isoFile.vars.DATABASE_URL === OWNED('iso'),
     'db-isolated still gets its owned DATABASE_URL');

  await emitXellEnv(clone.id);
  const cloneFile = readEmitted(clone.wt);
  ok(cloneFile.vars.QUEENZEE_INPROC === undefined,
     `db-clone does NOT set QUEENZEE_INPROC (got ${cloneFile.vars.QUEENZEE_INPROC ?? '(unset)'})`);

  // ── 3. sameDatabase(meta) via db-prod-readonly also projects the flag ───────────────────────
  // RO_DSN equals the managing meta-DB (config.databaseUrl). The §6.2 exemption lets it through;
  // the new rule must then mark the instance API-only so a nested server does not take the lock.
  console.log('\n── sameDatabase(managing meta-DB) via db-prod-readonly → QUEENZEE_INPROC=false ──');
  const roDsn = config.databaseUrl; // exactly the managing meta-DB
  const ro = await mkXell('ro', { coupling: 'db-prod-readonly', roDsn });
  await emitXellEnv(ro.id);
  const roFile = readEmitted(ro.wt);
  ok(roFile.vars.DATABASE_URL === roDsn,
     'db-prod-readonly exemption still emits the managing meta-DB DSN');
  ok(roFile.vars.QUEENZEE_INPROC === 'false',
     `sameDatabase(meta) → QUEENZEE_INPROC=false even under db-prod-readonly `
     + `(got ${roFile.vars.QUEENZEE_INPROC ?? '(unset)'})`);

  // ── 4. reserved: an environment cannot flip QUEENZEE_INPROC back to true ────────────────────
  console.log('\n── QUEENZEE_INPROC is reserved — environment cannot override ──');
  ok(sharedFile.vars.QUEENZEE_INPROC === 'false',
     'environment var QUEENZEE_INPROC=true was dropped; projection kept false');
  ok(!/^QUEENZEE_INPROC=true$/m.test(sharedFile.text),
     'no QUEENZEE_INPROC=true line lands from the environment');

} finally {
  if (pid) await q(`DELETE FROM project WHERE id=$1`, [pid]).catch(() => {});
  try { rmSync(root, { recursive: true, force: true }); } catch { /* tmp */ }
  await pool.end().catch(() => {});
}

console.log(fail ? `\n${fail} FAILED` : '\nall good');
process.exit(fail ? 1 : 0);
