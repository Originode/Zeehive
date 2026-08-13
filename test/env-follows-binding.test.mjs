// TICKET #15, second half — "a xell with prod does not have prod .env attached to it."
//
// The first half (test/prod-env-binding.test.mjs) fixed what emitXellEnv RESOLVES for a xell that
// already holds production. This one covers the fault that made the ticket reproducible in the
// first place: NOTHING RE-EMITTED THE PROJECTION WHEN A BINDING CHANGED. A human granting prod to a
// LIVE xell flips db_coupling AFTER provisioning, and .zeehive.env — the file the zee actually runs
// with — kept the dev environment and the dev DATABASE_URL it was provisioned with.
//
// So every assertion here CHANGES A BINDING through the real API and then RE-READS THE FILE FROM
// DISK. Nothing calls emitXellEnv directly: a test that calls the emitter proves the emitter, and
// the bug was that no one called it.
//
// Covered:
//   • attachProdStack()  (the human console/API prod grant)     → file names the prod env + prod DSN
//   • detachProdStack()  (the way back)                         → file returns to the dev env
//   • attachXellDb()     (any db re-target, the choke point)    → file follows the coupling
//   • the manager shape: prod_ro_dsn minted + db-prod-readonly  → file gets the READ-ONLY DSN,
//     not the throwaway spinoff db the xell still owns
//   • precedence: a xell's COUPLING beats an incidental owned db container — and the two rules that
//     must NOT be weakened by that: a READER is never handed the prod owner's connection string,
//     and an environment can never redirect DATABASE_URL (reserved name).
import { mkdtempSync, rmSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
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
const { attachXellDb } = await import('../server/src/lib/xell-db.js');
const { attachProdStack, detachProdStack } = await import('../server/src/lib/xell-prod.js');
const { emitXellEnv } = await import('../server/src/lib/provision.js');

const tag = randomUUID().slice(0, 8).replace(/[^a-z0-9]/g, '');
const root = mkdtempSync(join(tmpdir(), `bind15-${tag}-`));
let pid = null;

const SHARED_DEV = `postgresql://zeehive@shared_dev_${tag}:5432/devdb`;
const SHARED_PROD = `postgresql://zeehive@shared_prod_${tag}:5432/proddb`;
const RO_DSN = `postgresql://zee_ro_${tag}:pw@prod-host:5432/proddb`;

// what the xell is ACTUALLY running with: its own .zeehive.env, read back off disk
function projection(dir) {
  const path = join(dir, '.zeehive.env');
  if (!existsSync(path)) return { missing: true, vars: {}, text: '' };
  const text = readFileSync(path, 'utf8');
  const vars = {};
  for (const line of text.split('\n')) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (m) vars[m[1]] = m[2];
  }
  return { path, text, vars };
}

try {
  pid = (await one(
    `INSERT INTO project (name, repo_root, db_user, db_name) VALUES ($1,$2,'zeehive','zeehive') RETURNING id`,
    [`bind15-${tag}`, process.cwd()])).id;
  const xoid = (await one(`INSERT INTO xource (project_id, ref) VALUES ($1,'master') RETURNING id`, [pid])).id;

  const mkEnv = async (key, tier, vars) => {
    const e = await one(
      `INSERT INTO environment (project_id,key,tier,label,is_default) VALUES ($1,$2,$3,$4,true) RETURNING *`,
      [pid, key, tier, `${tier} (#15 binding fixture)`]);
    for (const [name, value] of Object.entries(vars)) {
      await q(`INSERT INTO environment_var (environment_id,name,value,is_secret) VALUES ($1,$2,$3,false)`,
              [e.id, name, value]);
    }
    return e;
  };
  const devEnv = await mkEnv(`dev-${tag}`, 'dev', { WHICH_ENV: 'dev', API_BASE: 'https://dev.example' });
  await mkEnv(`prod-${tag}`, 'prod', {
    WHICH_ENV: 'prod', API_BASE: 'https://prod.example',
    DATABASE_URL: 'postgresql://hijack@elsewhere:5432/hijack',   // reserved name — must never land
  });

  // the project's SHARED containers: a dev db, and a whole prod tier to be bound to
  const mkShared = async (role, tier, name, connRef = null) => one(
    `INSERT INTO container (project_id, role, tier, isolation, name, docker_ctx, internal_port, conn_ref)
       VALUES ($1,$2,$3,'shared',$4,'default',$5,$6) RETURNING *`,
    [pid, role, tier, name, role === 'db' ? 5432 : 3000, connRef]);
  await mkShared('db', 'dev', `shared_dev_${tag}`, SHARED_DEV);
  await mkShared('db', 'prod', `shared_prod_${tag}`, SHARED_PROD);
  await mkShared('server', 'prod', `prod_server_${tag}`);
  await mkShared('webapp', 'prod', `prod_web_${tag}`);

  // an ORDINARY pooled spinoff, already provisioned: its own db/server/webapp containers, and the
  // .zeehive.env provisioning wrote for it. This is the xell a human then grants prod to.
  const mkXell = async (name) => {
    const slug = `bind15-${tag}-${name}`;
    const wt = join(root, name);
    mkdirSync(wt, { recursive: true });
    const x = await one(
      `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status, is_pooled,
                         zee_type, db_coupling)
         VALUES ($1,$2,$3,$4,$5,'working',false,'worker','db-isolated') RETURNING *`,
      [pid, xoid, slug, `spinoff/${slug}`, wt]);
    const own = await one(
      `INSERT INTO container (project_id, role, tier, isolation, name, docker_ctx, internal_port,
                              host_port, conn_ref, owner_xell_id)
         VALUES ($1,'db','spinoff','per-xell',$2,'default',5432,15432,$3,$4) RETURNING *`,
      [pid, `bind15_${tag}_${name}_db`, `postgresql://zeehive@bind15_${tag}_${name}_db:5432/zeehive`, x.id]);
    await q(`INSERT INTO container (project_id, role, tier, isolation, name, docker_ctx, internal_port,
                                    host_port, owner_xell_id)
               VALUES ($1,'server','spinoff','per-xell',$2,'default',3000,4841,$3)`,
            [pid, `bind15_${tag}_${name}_server`, x.id]);
    await q(`INSERT INTO xell_uses_container (xell_id, container_id, relation) VALUES ($1,$2,'owns')`,
            [x.id, own.id]);
    // what provisioning does, once, at the end of provisionXell
    await emitXellEnv(x.id);
    return { ...x, wt, ownDb: own };
  };

  // ── 1. the ticket itself: a LIVE xell is granted production ─────────────────────────────────
  console.log('a human grants PROD to a live xell (attachProdStack) — no reprovision');
  const w = await mkXell('worker');
  const before = projection(w.wt);
  ok(before.vars.WHICH_ENV === 'dev', `provisioned with the dev environment (WHICH_ENV=${before.vars.WHICH_ENV})`);
  ok(before.vars.DATABASE_URL === w.ownDb.conn_ref, 'and with its own spinoff database');

  await attachProdStack(w.id, { by: 'test' });
  const bound = projection(w.wt);
  ok(!bound.missing, '.zeehive.env still exists after the grant');
  ok(bound.vars.WHICH_ENV === 'prod',
     `the PROD environment is now in the file (WHICH_ENV=${bound.vars.WHICH_ENV ?? '(none)'}) — the ticket`);
  ok(bound.vars.API_BASE === 'https://prod.example',
     `…including the prod API base (${bound.vars.API_BASE ?? '(none)'})`);
  ok(bound.vars.DATABASE_URL === SHARED_PROD,
     `DATABASE_URL is the PRODUCTION database (${bound.vars.DATABASE_URL ?? '(none)'}) — not the spinoff clone`);
  ok(!/hijack/.test(bound.text),
     'the prod environment still cannot redirect DATABASE_URL (reserved name holds)');

  // ── 2. the way back ─────────────────────────────────────────────────────────────────────────
  console.log('…and released again (detachProdStack)');
  await detachProdStack(w.id, { by: 'test' });
  const released = projection(w.wt);
  ok(released.vars.WHICH_ENV === 'dev',
     `the file is back on the dev environment (WHICH_ENV=${released.vars.WHICH_ENV ?? '(none)'}) — `
     + 'a released xell must not keep prod secrets');
  ok(released.vars.DATABASE_URL !== SHARED_PROD,
     `and no longer names production (${released.vars.DATABASE_URL ?? '(none)'})`);

  // ── 2b. the omnibiz shape: a prod db with NO conn_ref but a PUBLISHED address ───────────────
  // omnibiz_db_prod records no conn_ref (it lives on another machine's docker context) but
  // publishes host + host_port — and the cage firewall deliberately leaves a prod-bound xell's own
  // prod db unblocked. The bind used to answer with a docker-exec psql a CXELL cannot run and an
  // env file with no DATABASE_URL, so the zee reported an ONLINE production db as unreachable.
  console.log('a conn_ref-less but published prod db still yields a reachable DSN (the omnibiz bug)');
  await q(`UPDATE container SET conn_ref=NULL, host='10.9.9.9', host_port=6543
            WHERE project_id=$1 AND role='db' AND tier='prod'`, [pid]);
  const t = await mkXell('tcp');
  const tcpBind = await attachProdStack(t.id, { by: 'test' });
  const TCP_DSN = 'postgresql://zeehive@10.9.9.9:6543/zeehive';
  ok(tcpBind.dsn === TCP_DSN,
     `the bind answers with the DSN derived from host:host_port (${tcpBind.dsn ?? '(none)'})`);
  ok(tcpBind.psql === `psql "${TCP_DSN}"`,
     `…and its psql dials that DSN, not a docker exec a cage cannot run (${tcpBind.psql})`);
  ok(projection(t.wt).vars.DATABASE_URL === TCP_DSN,
     `…and .zeehive.env carries the address (${projection(t.wt).vars.DATABASE_URL ?? '(none)'})`);
  await detachProdStack(t.id, { by: 'test' });
  await q(`UPDATE container SET conn_ref=$2, host=NULL, host_port=NULL
            WHERE project_id=$1 AND role='db' AND tier='prod'`, [pid, SHARED_PROD]);

  // ── 3. the choke point: any db re-target ────────────────────────────────────────────────────
  console.log('attachXellDb: the projection follows every re-target');
  await attachXellDb(w.id, { coupling: 'db-shared-prod' });
  const retarget = projection(w.wt);
  ok(retarget.vars.DATABASE_URL === SHARED_PROD && retarget.vars.WHICH_ENV === 'prod',
     `a bare coupling change re-emits too (DATABASE_URL=${retarget.vars.DATABASE_URL ?? '(none)'}, `
     + `WHICH_ENV=${retarget.vars.WHICH_ENV ?? '(none)'})`);
  await attachXellDb(w.id, { coupling: 'db-shared-dev' });
  const backToDev = projection(w.wt);
  ok(backToDev.vars.WHICH_ENV === 'dev', 'and back again');

  // ── 4. the manager shape ────────────────────────────────────────────────────────────────────
  // bindManagerToProdReadonly mints the SELECT-only role (writing xell.prod_ro_dsn) and THEN
  // attaches the coupling. Replayed here in that order, without a live cluster to mint on.
  console.log('a manager is bound to production READ-ONLY');
  const m = await mkXell('manager');
  await q(`UPDATE xell SET zee_type='manager', prod_ro_dsn=$2 WHERE id=$1`, [m.id, RO_DSN]);
  await attachXellDb(m.id, { coupling: 'db-prod-readonly' });
  const mgr = projection(m.wt);
  ok(mgr.vars.DATABASE_URL === RO_DSN,
     `the manager holds its minted READ-ONLY DSN (${mgr.vars.DATABASE_URL ?? '(none)'}), not its own clone`);
  ok(mgr.vars.DATABASE_URL !== SHARED_PROD,
     'and never the prod OWNER credential — a reader is not widened by following the binding');
  ok(mgr.vars.WHICH_ENV === 'prod', `with the prod environment (WHICH_ENV=${mgr.vars.WHICH_ENV ?? '(none)'})`);

  // a read-only coupling with NO minted DSN must NOT be handed the prod owner's connection string
  console.log('a read-only binding with no minted DSN is never handed the owner credential');
  const n = await mkXell('nodsn');
  await attachXellDb(n.id, { coupling: 'db-prod-readonly' });
  const nod = projection(n.wt);
  ok(nod.vars.DATABASE_URL !== SHARED_PROD,
     `no owner DSN leaked to a reader (${nod.vars.DATABASE_URL ?? '(none)'})`);

  // ── 4b. the §6.2 refusal fires at ATTACH time, not just at EMIT time ─────────────────────────
  // Following the binding must never become a way to be HANDED a database. When ZEEHIVE
  // orchestrates itself the production db IS the managing instance's own meta-DB, and a full
  // (writable) bind to it is exactly what §6.2 refuses — two reconcilers on one meta-DB reap each
  // other's xells. The OLD behaviour let the attach succeed and the EMIT fail, leaving the xell
  // coupled to prod with no DATABASE_URL and a permanently-failing reconcile. The refusal now
  // fires UP FRONT in attachXellDb: the bind throws, nothing is half-done, and the xell keeps its
  // previous coupling + file.
  console.log('§6.2: preferring the prod container never smuggles in the managing meta-DB');
  const { config } = await import('../server/src/config.js');
  const g = await mkXell('guard');
  const guardBefore = projection(g.wt).text;
  await q(`UPDATE container SET conn_ref=$2 WHERE project_id=$1 AND role='db' AND tier='prod'`,
          [pid, config.databaseUrl]);
  let guardErr = null;
  try { await attachXellDb(g.id, { coupling: 'db-shared-prod' }); }
  catch (e) { guardErr = e.message; }
  ok(/REFUSING to bind/.test(guardErr || ''),
     `a writable bind to the managing meta-DB is REFUSED at attach [${(guardErr || 'no error').slice(0, 60)}]`);
  ok(projection(g.wt).text === guardBefore, 'the file on disk is untouched — never the meta-DB');
  const guardRow = await one(`SELECT db_coupling FROM xell WHERE id=$1`, [g.id]);
  ok(guardRow.db_coupling === 'db-isolated',
     `and the xell keeps its previous coupling, not a half-done prod bind [${guardRow.db_coupling}]`);
  await q(`UPDATE container SET conn_ref=$2 WHERE project_id=$1 AND role='db' AND tier='prod'`,
          [pid, SHARED_PROD]);

  // …and the CONTAINER-named path (attachXellDb by container id) refuses the same way.
  const g2 = await mkXell('guard2');
  const g2Before = projection(g2.wt).text;
  await q(`UPDATE container SET conn_ref=$2 WHERE project_id=$1 AND role='db' AND tier='prod'`,
          [pid, config.databaseUrl]);
  const prodRow = await one(`SELECT id FROM container WHERE project_id=$1 AND role='db' AND tier='prod'`, [pid]);
  let g2Err = null;
  try { await attachXellDb(g2.id, { container: prodRow.id }); }
  catch (e) { g2Err = e.message; }
  ok(/REFUSING to bind/.test(g2Err || ''),
     `naming the meta-DB container explicitly is refused too [${(g2Err || 'no error').slice(0, 60)}]`);
  ok(projection(g2.wt).text === g2Before, 'and the second xell\'s file is untouched as well');
  await q(`UPDATE container SET conn_ref=$2 WHERE project_id=$1 AND role='db' AND tier='prod'`,
          [pid, SHARED_PROD]);

  // ── 5. an EMPTY environment must not read like a broken merge ───────────────────────────────
  // The third half of the ticket: when a project's environments hold no vars (Zeehive's own dev
  // AND prod do, today) a perfectly correct merge writes nothing — and "my binding says prod and
  // my .zeehive.env plainly does not" is exactly what a BROKEN merge looks like too. So the file
  // states which environment it resolved even when that environment contributes nothing.
  console.log('an empty environment is STATED in the file, not silent');
  await q(`DELETE FROM environment_var WHERE environment_id=$1`, [devEnv.id]);
  await attachXellDb(n.id, { coupling: 'db-shared-dev' });      // a binding change → a fresh emit
  const emptyEnv = projection(n.wt);
  ok(new RegExp(`environment: dev-${tag} \\(dev\\)[^\\n]*0 vars`).test(emptyEnv.text),
     'the projection names the resolved (empty) environment — "empty" is distinguishable from "wrong"');
  ok(emptyEnv.vars.WHICH_ENV === undefined, '…and merges nothing, which is correct');

  console.log(fail ? `\n${fail} FAILED` : '\nall good');
} catch (e) {
  console.error('TEST ERROR:', e);
  fail++;
} finally {
  if (pid) await q(`DELETE FROM project WHERE id=$1`, [pid]).catch(() => {});
  await pool.end().catch(() => {});
  try { rmSync(root, { recursive: true, force: true }); } catch { /* */ }
}
process.exit(fail ? 1 : 0);
