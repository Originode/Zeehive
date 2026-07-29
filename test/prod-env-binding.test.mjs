// TICKET #15 — "a xell with prod does not have the prod .env attached to it."
//
// Two separate defects, one symptom. A xell holding PRODUCTION READ-ONLY (db-prod-readonly — the
// manager binding) was treated as an ordinary dev xell by BOTH halves of the projection:
//
//   1. lib/environments.js resolveEnvironmentFor() asked only `db-shared-prod || is_production`,
//      so a read-only prod xell resolved the default DEV environment and had dev vars written into
//      its .zeehive.env. Same test copied into resolvedEnvView()'s no-environment fallback and into
//      lib/fleet.js's SQL (the console's env badge), so all three said "dev".
//   2. lib/provision.js emitXellEnv() took DATABASE_URL from an OWNED db container FIRST and only
//      fell back to prod_ro_dsn. A xell that has both (every manager: it is a pooled spinoff with
//      its own db container, then bound read-only) therefore never got the DSN its binding
//      advertises — it silently pointed at its own throwaway spinoff database.
//
// What this covers, per db_coupling, against real fixture rows:
//   • which environment resolves (dev vs prod) — resolveEnvironmentFor, resolvedEnvView, streamXells;
//   • what DATABASE_URL emitXellEnv actually writes;
//   • the rules that must NOT move: the reserved-name rule (an environment can never redirect
//     DATABASE_URL), db-clone staying dev, and the §6.2 meta-DB refusal — which now has exactly one
//     exemption, the minted SELECT-only reader, because when ZEEHIVE orchestrates ITSELF production
//     IS the managing meta-DB and refusing there would refuse a manager's entire projection.
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
const { resolveEnvironmentFor, resolvedEnvView } = await import('../server/src/lib/environments.js');
const { emitXellEnv } = await import('../server/src/lib/provision.js');
const { streamXells } = await import('../server/src/lib/fleet.js');

const tag = randomUUID().slice(0, 8).replace(/[^a-z0-9]/g, '');
const root = mkdtempSync(join(tmpdir(), `env15-${tag}-`));
const RO_DSN = `postgresql://zee_ro_${tag}:pw@prod-host:5432/proddb`;
let pid = null; let barePid = null;

// read back the projection emitXellEnv wrote, as a plain KEY=value map (+ the raw lines)
function readEmitted(dir) {
  const text = readFileSync(join(dir, '.zeehive.env'), 'utf8');
  const vars = {};
  const names = [];
  for (const line of text.split('\n')) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    names.push(m[1]);
    vars[m[1]] = m[2];
  }
  return { text, vars, names };
}

try {
  pid = (await one(
    `INSERT INTO project (name, repo_root, db_user, db_name) VALUES ($1,$2,'zeehive','zeehive') RETURNING id`,
    [`env15-${tag}`, process.cwd()])).id;
  const xoid = (await one(`INSERT INTO xource (project_id, ref) VALUES ($1,'master') RETURNING id`, [pid])).id;

  // dev + prod environments, each the default of its tier, with a var that NAMES its tier so the
  // projection cannot be read ambiguously.
  const mkEnv = async (key, tier, vars) => {
    const e = await one(
      `INSERT INTO environment (project_id,key,tier,label,is_default) VALUES ($1,$2,$3,$4,true) RETURNING *`,
      [pid, key, tier, `${tier} (#15 fixture)`]);
    for (const [name, value] of Object.entries(vars)) {
      await q(`INSERT INTO environment_var (environment_id,name,value,is_secret) VALUES ($1,$2,$3,false)`,
              [e.id, name, value]);
    }
    return e;
  };
  const devEnv = await mkEnv(`dev-${tag}`, 'dev', { WHICH_ENV: 'dev', API_BASE: 'https://dev.example' });
  const prodEnv = await mkEnv(`prod-${tag}`, 'prod', {
    WHICH_ENV: 'prod', API_BASE: 'https://prod.example',
    // an environment must NEVER be able to redirect the db (reserved-name rule)
    DATABASE_URL: 'postgresql://hijack@elsewhere:5432/hijack',
  });

  const mkXell = async (name, { coupling, isProd = false, roDsn = null, ownedDb = null }) => {
    const slug = `env15-${tag}-${name}`;
    const wt = join(root, name);
    mkdirSync(wt, { recursive: true });
    const x = await one(
      `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status, is_pooled,
                         zee_type, db_coupling, is_production, prod_ro_dsn)
         VALUES ($1,$2,$3,$4,$5,'working',false,'worker',$6,$7,$8) RETURNING *`,
      [pid, xoid, slug, `spinoff/${slug}`, wt, coupling, isProd, roDsn]);
    if (ownedDb) {
      await q(`INSERT INTO container (project_id, role, tier, isolation, name, docker_ctx, internal_port,
                                      conn_ref, owner_xell_id)
                 VALUES ($1,'db','spinoff','per-xell',$2,'default',5432,$3,$4)`,
              [pid, `env15_${tag}_${name}_db`, ownedDb, x.id]);
    }
    return { ...x, wt };
  };

  const OWNED = (n) => `postgresql://zeehive@env15_${tag}_${n}_db:5432/zeehive`;

  const xells = {
    // an ordinary spinoff: its own db, dev environment
    iso:    await mkXell('iso',    { coupling: 'db-isolated', ownedDb: OWNED('iso') }),
    // a clone is a THROWAWAY COPY of prod's data, not prod — it stays on dev
    clone:  await mkXell('clone',  { coupling: 'db-clone' }),
    // the live production database, read/write
    rw:     await mkXell('rw',     { coupling: 'db-shared-prod' }),
    // production READ-ONLY with no db of its own
    ro:     await mkXell('ro',     { coupling: 'db-prod-readonly', roDsn: RO_DSN }),
    // production READ-ONLY *and* an owned spinoff db — the real shape of every manager zee
    romgr:  await mkXell('romgr',  { coupling: 'db-prod-readonly', roDsn: RO_DSN, ownedDb: OWNED('romgr') }),
    // read-only coupling but no DSN minted (project with no prod db): must not lose its own db
    rondsn: await mkXell('rondsn', { coupling: 'db-prod-readonly', ownedDb: OWNED('rondsn') }),
    // the production xell itself
    isprod: await mkXell('isprod', { coupling: 'db-shared-dev', isProd: true }),
  };

  // ── 1. which environment RESOLVES, per coupling ─────────────────────────────────────────────
  console.log('resolveEnvironmentFor: which couplings count as "on production"');
  const expectEnv = {
    iso: devEnv, clone: devEnv, rw: prodEnv, ro: prodEnv, romgr: prodEnv, rondsn: prodEnv,
    isprod: prodEnv,
  };
  for (const [name, x] of Object.entries(xells)) {
    const got = await resolveEnvironmentFor(x);
    const want = expectEnv[name];
    ok(got?.id === want.id,
       `${x.db_coupling}${x.is_production ? ' (is_production)' : ''} → ${want.tier} env `
       + `[got ${got?.tier || 'none'}]`);
  }

  // an explicit PIN still outranks the coupling (unchanged precedence)
  await q(`UPDATE xell SET environment_id=$2 WHERE id=$1`, [xells.romgr.id, devEnv.id]);
  const pinned = await resolveEnvironmentFor(await one(`SELECT * FROM xell WHERE id=$1`, [xells.romgr.id]));
  ok(pinned?.id === devEnv.id, 'an explicit environment_id pin still wins over the coupling');
  await q(`UPDATE xell SET environment_id=NULL WHERE id=$1`, [xells.romgr.id]);

  // ── 2. what emitXellEnv actually WRITES ─────────────────────────────────────────────────────
  console.log('emitXellEnv: DATABASE_URL + the merged environment, per coupling');
  const expectDb = {
    iso: OWNED('iso'),
    clone: null,                 // no owned container, no clone instance row → no DATABASE_URL line
    rw: null,
    ro: RO_DSN,
    romgr: RO_DSN,               // the binding it advertises, NOT its leftover spinoff db
    rondsn: OWNED('rondsn'),     // no DSN minted → keep the db it does have
    isprod: null,
  };
  for (const [name, x] of Object.entries(xells)) {
    await emitXellEnv(x.id);
    const { vars, names } = readEmitted(x.wt);
    const want = expectDb[name];
    ok((vars.DATABASE_URL ?? null) === want,
       `${name} (${x.db_coupling}): DATABASE_URL=${vars.DATABASE_URL ?? '(none)'} `
       + `[want ${want ?? '(none)'}]`);
    ok(vars.WHICH_ENV === expectEnv[name].tier,
       `${name}: the ${expectEnv[name].tier} environment's vars are the ones written (WHICH_ENV=${vars.WHICH_ENV})`);
    ok(names.filter((n) => n === 'DATABASE_URL').length <= 1,
       `${name}: exactly one DATABASE_URL line — the environment's own DATABASE_URL never lands`);
  }
  const prodFile = readEmitted(xells.romgr.wt);
  ok(!/hijack/.test(prodFile.text),
     'the prod environment cannot redirect DATABASE_URL past the §6.2 guard (reserved name)');
  ok(prodFile.vars.API_BASE === 'https://prod.example',
     'a read-only prod xell gets the PROD api base, which is the whole of ticket #15');

  // ── 3. §6.2 — the refusal, and its ONE exemption ────────────────────────────────────────────
  // The guard exists so a nested queenzee never OPERATES on the managing instance's meta-DB (two
  // reconcilers reap each other's xells). That needs writes. A minted read-only reader has none —
  // and when ZEEHIVE orchestrates itself, production IS the meta-DB, so refusing there would refuse
  // every manager's whole projection. So: read-only reader through, everything else refused.
  console.log('§6.2: the meta-DB refusal, and the read-only exemption');
  const metaOwner = await mkXell('metaowner', { coupling: 'db-isolated', ownedDb: config.databaseUrl });
  let ownerErr = null;
  try { await emitXellEnv(metaOwner.id); } catch (e) { ownerErr = e.message; }
  ok(/REFUSING to emit/.test(ownerErr || ''),
     `an OWNED db resolving to the meta-DB is still REFUSED [${(ownerErr || 'no error').slice(0, 60)}]`);

  const metaRo = await mkXell('metaro', { coupling: 'db-prod-readonly', roDsn: config.databaseUrl });
  let roErr = null;
  try { await emitXellEnv(metaRo.id); } catch (e) { roErr = e.message; }
  ok(!roErr, `the minted READ-ONLY reader on the meta-DB is emitted, not refused [${roErr || 'no error'}]`);
  ok(!roErr && readEmitted(metaRo.wt).vars.DATABASE_URL === config.databaseUrl,
     'a Zeehive-on-Zeehive manager gets the read-only DSN it was bound to (ticket #15 on this project)');

  // the exemption is bound to THAT DSN: a read-only xell whose owned db happens to be the meta-DB
  // is not a reader, and is refused like anything else.
  const metaRoFake = await mkXell('metarofake', {
    coupling: 'db-prod-readonly', roDsn: null, ownedDb: config.databaseUrl });
  let fakeErr = null;
  try { await emitXellEnv(metaRoFake.id); } catch (e) { fakeErr = e.message; }
  ok(/REFUSING to emit/.test(fakeErr || ''),
     'the exemption is the minted prod_ro_dsn only, not the coupling on its own');

  // ── 4. the console's two other copies of the same rule ──────────────────────────────────────
  console.log('resolvedEnvView + fleet SQL agree with resolveEnvironmentFor');
  const view = await resolvedEnvView(await one(`SELECT * FROM xell WHERE id=$1`, [xells.romgr.id]));
  ok(view.environment?.tier === 'prod', `resolvedEnvView reports the prod environment (${view.environment?.tier})`);

  // …including its no-environment fallback: a project with NO environments at all still has to say
  // which tier a read-only prod xell would be on.
  barePid = (await one(
    `INSERT INTO project (name, repo_root, db_user, db_name) VALUES ($1,$2,'x','x') RETURNING id`,
    [`env15-bare-${tag}`, process.cwd()])).id;
  const bareView = await resolvedEnvView({ id: null, project_id: barePid, db_coupling: 'db-prod-readonly' });
  ok(bareView.environment === null && bareView.tier === 'prod',
     `with no environment configured the fallback tier is still prod (${bareView.tier})`);

  const rows = [];
  await streamXells(pid, (x) => { rows.push(x); });
  const tierOf = (name) => rows.find((r) => r.slug === `env15-${tag}-${name}`)?.env_tier;
  for (const name of ['ro', 'romgr', 'rw', 'isprod']) {
    ok(tierOf(name) === 'prod', `the fleet row for ${name} carries env_tier=prod (${tierOf(name)})`);
  }
  for (const name of ['iso', 'clone']) {
    ok(tierOf(name) === 'dev', `…and ${name} stays on dev (${tierOf(name)})`);
  }

  console.log(fail ? `\n${fail} FAILED` : '\nall good');
} catch (e) {
  console.error('TEST ERROR:', e);
  fail++;
} finally {
  for (const p of [pid, barePid]) {
    if (p) await q(`DELETE FROM project WHERE id=$1`, [p]).catch(() => {});
  }
  await pool.end().catch(() => {});
  try { rmSync(root, { recursive: true, force: true }); } catch { /* */ }
}
process.exit(fail ? 1 : 0);
