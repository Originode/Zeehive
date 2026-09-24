// A db-prod-readonly xell's DATABASE_URL IS ITS OWN READER'S — and the preflight probes THAT.
//
// Two faults, one measured file. A manager+infra-medic on a project that orchestrates ITSELF
// (Zeehive: the meta-DB IS production) was handed a .zeehive.env that named the SAME read-only
// role, on the SAME host, TWICE, with two DIFFERENT 32-char passwords:
//
//   DATABASE_URL          postgresql://zee_ro_<slug>:<A>@meta-db:5432/zeehive  -> psql: FATAL 28P01
//   ZEEHIVE_META_RO_DSN   postgresql://zee_ro_<slug>:<B>@meta-db:5432/zeehive  -> SELECT 1 OK
//
// Nothing was mis-emitted. TWO MINTS wrote one role name: the manager bind ran
// `CREATE/ALTER ROLE zee_ro_<slug> PASSWORD <A>` and stored that DSN as xell.prod_ro_dsn (the
// DATABASE_URL the file advertises), and the infra-medic bind that follows ran `ALTER ROLE
// zee_ro_<slug> PASSWORD <B>` on the SAME cluster (lib/prod-readonly.js mintMetaReader) — so the
// second mint ROTATED the password out from under the first. The door the harness calls the xell's
// database was dead; the door on the next line worked.
//
// Compounding it, the boot preflight never touched the binding at all: a prod-coupled xell reported
// db-open SKIPPED, so the verdict a manager's row carried was the one from its POOLED provision —
// 'role zeehive at <shared dev db>: 28P01 (dsn source: shared-dev-container)' — a database its
// binding no longer named, FAILING, and carried into the zee's own briefing.
//
// Covered here:
//   A. the two readers have DISTINCT role names by construction (pure);
//   B. on a REAL cluster, the meta mint does NOT rotate the prod reader's credential — and the OLD
//      shared-name mint is shown to do exactly that, so this test would have caught the fault;
//   C. the emitted file names both doors, each with its own role, and the DATABASE_URL it
//      advertises is a credential that actually OPENS;
//   D. db-open PROBES a db-prod-readonly binding's DSN (labelled 'prod-readonly-dsn'), still SKIPS
//      a db-shared-prod WRITE bind, and does not report a false credential fault in simulate mode;
//   E. §4.5 on the MANAGER bind: a dead read-only binding REFUSES the dispatch under
//      readiness_proof='required' and the compensation leaves the xell on the shared dev db holding
//      no production DSN or container link — while the same binding under 'advisory' refuses
//      nothing and only stamps the verdict (what the dispatch loop does with that is not covered
//      here; it needs a live spawn — see the note in section E).
//
// PRODRO_MODE=real is set deliberately: mintMetaReader's SQL runs through the pool, which here is
// the throwaway `zee db-sandbox` postgres — so the mint is exercised for real, on a real cluster,
// inside this cage. The one thing a cage cannot do is the MANAGER half of the mint (that path runs
// psql through `docker exec`, and a cxell has no docker), so the prod reader is minted here with the
// SAME SQL (lib/prod-readonly.js readonlyRoleSql) rather than through mintProdReader.
//
// LIMIT worth stating: the sandbox authenticates by trust, so a WRONG PASSWORD is not refused on it.
// What is observable — and asserted — is the thing the fault actually is: the second mint OVERWRITES
// the credential the first door stored (pg_authid.rolpassword changes). Where passwords are checked,
// that overwritten credential is the 28P01 the manager measured.
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }
process.env.PROVISION_MODE = 'simulate';
process.env.BUILD_MODE = 'simulate';
process.env.TKB_NOTIFY = '0';
process.env.PRODRO_MODE = 'real';      // BEFORE any import that computes it at load

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

const { q, one, pool } = await import('../server/src/db/pool.js');
const { emitXellEnv } = await import('../server/src/lib/provision.js');
const { preflightXell, PREFLIGHT_TIMEOUT_MS } = await import('../server/src/lib/preflight.js');
const { rePreflightAfterBindingChange } = await import('../server/src/lib/proof-policy.js');
const { unbindManagerFromProdReadonly } = await import('../server/src/lib/manager-spawn.js');
const { roRoleName, metaRoRoleName, readonlyRoleSql, readonlyDsn, dropProdReaderSql, mintMetaReader } =
  await import('../server/src/lib/prod-readonly.js');
const pg = (await import('pg')).default;

const tag = randomUUID().slice(0, 8).replace(/[^a-z0-9]/g, '');
const root = mkdtempSync(join(tmpdir(), `rocol-${tag}-`));
const slug = `rocol-${tag}`;
const SLUG_MGR = `${slug}-mgr`;               // the fixture xell's slug, below
const ROLE = roRoleName(SLUG_MGR);            // the manager's prod reader — zee_ro_<slug>
const META_ROLE = metaRoRoleName(SLUG_MGR);   // the medic's meta reader — zee_meta_ro_<slug> (new)
const PW_A = `pwA_${tag}`;
const PW_B = `pwB_${tag}`;
const u = new URL(url);
const dbName = decodeURIComponent((u.pathname || '/').replace(/^\//, '')) || 'postgres';
const dbOwner = decodeURIComponent(u.username || 'postgres');

// the door a credential names — built with the module's own resolver, never hand-rolled
const dsnFor = (role, pw) => readonlyDsn({ host: u.hostname, port: Number(u.port || 5432),
                                           role, password: pw, dbName });
const DSN_A = dsnFor(ROLE, PW_A);
const UNROUTABLE = 'postgresql://zee_ro_dead:whatever@192.0.2.1:5432/zeehive';   // RFC5737 TEST-NET-1

let pid = null;

// can a DSN actually log in (and read)? the preflight's own question, asked the same way
async function opens(dsn) {
  const c = new pg.Client({ connectionString: dsn, connectionTimeoutMillis: 4000 });
  try { await c.connect(); const r = await c.query('SELECT 1 AS one'); return r.rows?.[0]?.one === 1; }
  catch { return false; } finally { try { await c.end(); } catch { /* never connected */ } }
}
// the stored credential of a role — the thing a later ALTER ROLE … PASSWORD overwrites
const hashOf = async (role) =>
  (await one(`SELECT rolpassword AS h FROM pg_authid WHERE rolname=$1`, [role]))?.h || null;
const roleRow = async (role) =>
  await one(`SELECT rolname, rolcanlogin, rolsuper, rolcreatedb FROM pg_roles WHERE rolname=$1`, [role]);

function projection(dir) {
  const text = readFileSync(join(dir, '.zeehive.env'), 'utf8');
  const vars = {};
  for (const line of text.split('\n')) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (m) vars[m[1]] = m[2];
  }
  return { text, vars };
}
const dsnRole = (dsn) => { try { return decodeURIComponent(new URL(String(dsn)).username); } catch { return null; } };

try {
  // ── A. one name per door — the collision is impossible by construction ───────────────────────
  console.log('\nA. the two readers cannot share a role name');
  ok(ROLE !== META_ROLE, `distinct names (${ROLE} vs ${META_ROLE})`);
  ok(/^[a-z_][a-z0-9_]*$/.test(META_ROLE) && META_ROLE.length <= 63,
     `the meta reader's name is a legal unquoted postgres identifier (${META_ROLE}, ${META_ROLE.length} chars)`);
  // the two names differ by their PREFIX and nothing else: one normalisation, two doors
  ok(metaRoRoleName('A--b_C!') === `zee_meta_ro_${roRoleName('A--b_C!').slice('zee_ro_'.length)}`,
     'the slug is normalised exactly as roRoleName normalises it (dashes/upper-case collapse)');
  ok(META_ROLE.endsWith(SLUG_MGR.replace(/-/g, '_')) && ROLE.endsWith(SLUG_MGR.replace(/-/g, '_')),
     'both names still carry the xell\'s identity — this is per-xell, not one shared reader');

  // ── the fixtures ─────────────────────────────────────────────────────────────────────────────
  pid = (await one(
    `INSERT INTO project (name, repo_root, db_user, db_name) VALUES ($1,$2,$3,$4) RETURNING id`,
    [`rocol-${tag}`, process.cwd(), dbOwner, dbName])).id;
  const xoid = (await one(`INSERT INTO xource (project_id, ref) VALUES ($1,'master') RETURNING id`, [pid])).id;
  const wt = join(root, slug);
  mkdirSync(wt, { recursive: true });
  const mkXell = async (name, { coupling, roDsn }) => {
    const s = `${slug}-${name}`;
    const dir = join(root, s);
    mkdirSync(dir, { recursive: true });
    const x = await one(
      `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status, is_pooled,
                         zee_type, db_coupling, prod_ro_dsn)
         VALUES ($1,$2,$3,$4,$5,'working',false,'worker',$6,$7) RETURNING *`,
      [pid, xoid, s, `spinoff/${s}`, dir, coupling, roDsn]);
    return { ...x, wt: dir };
  };
  const mgr = await mkXell('mgr', { coupling: 'db-prod-readonly', roDsn: DSN_A });
  ok(mgr.slug === SLUG_MGR, `the fixture xell carries the slug the role names were derived from (${mgr.slug})`);

  // ── B. on a REAL cluster: the meta mint must not rotate the prod reader's credential ─────────
  console.log('\nB. two mints, one cluster — the meta mint leaves the prod reader\'s credential alone');
  await q(readonlyRoleSql(ROLE, PW_A, dbName, dbOwner));       // what mintProdReader runs
  const H1 = await hashOf(ROLE);
  ok(!!H1, `the prod reader ${ROLE} exists with a stored credential`);
  ok(await opens(DSN_A), '…and the DSN the manager bind stores as prod_ro_dsn OPENS');
  const prodRow = await roleRow(ROLE);
  ok(prodRow.rolsuper === false && prodRow.rolcanlogin === true,
     'the prod reader is LOGIN + NOSUPERUSER (SELECT-only, as designed)');

  // The OLD shape, reproduced: the meta mint used the SAME role name, so it ROTATED the credential
  // the manager's DATABASE_URL carries. This is the measured fault, on a real cluster.
  await q(readonlyRoleSql(ROLE, PW_B, dbName, dbOwner));
  const H2 = await hashOf(ROLE);
  ok(H2 && H2 !== H1, 'the OLD shared-name meta mint OVERWRITES the prod reader\'s stored credential '
    + '— on a cluster that checks passwords, that is the 28P01 the manager measured');

  await q(readonlyRoleSql(ROLE, PW_A, dbName, dbOwner));       // put the prod reader back
  // A re-mint of the SAME password stores a NEW scram hash (fresh salt), so "untouched" has to be
  // measured against the state immediately before the mint — never against the pre-collision hash.
  const H_RESTORED = await hashOf(ROLE);
  ok(H_RESTORED && H_RESTORED !== H2, 'restored: the prod reader holds its own credential again');

  const minted = await mintMetaReader(mgr);                    // the medic's mint — the real one
  ok(minted.role === META_ROLE, `mintMetaReader mints its OWN role (${minted.role})`);
  ok(minted.role !== ROLE, '…never the prod reader\'s name — which is why it cannot rotate it');
  ok(await hashOf(ROLE) === H_RESTORED,
     'AFTER the meta mint the prod reader\'s stored credential is byte-identical — untouched');
  ok(await opens(DSN_A), '…so the DATABASE_URL credential still OPENS. This is the whole ticket');
  ok(await opens(minted.dsn), `and the meta door\'s own DSN opens too (${String(minted.dsn).replace(/:[^:@/]*@/, ':***@')})`);
  const metaRow = await roleRow(META_ROLE);
  ok(metaRow?.rolcanlogin === true && metaRow?.rolsuper === false,
     'the meta reader is LOGIN + NOSUPERUSER — read-only is not weakened by the rename');
  ok((await one(`SELECT meta_ro_dsn AS d FROM xell WHERE id=$1`, [mgr.id]))?.d === minted.dsn,
     'the minted meta DSN is stored on the xell row (where the projection reads it)');

  // ── C. the file: two doors, two roles, and the advertised one works ──────────────────────────
  console.log('\nC. .zeehive.env names each door with its own role');
  await emitXellEnv(mgr.id);
  const { text, vars } = projection(mgr.wt);
  ok(vars.DATABASE_URL === DSN_A, 'DATABASE_URL is the prod reader DSN the binding minted');
  ok(vars.ZEEHIVE_META_RO_DSN === minted.dsn, '…and ZEEHIVE_META_RO_DSN is the meta reader\'s');
  ok(vars.DATABASE_URL !== vars.ZEEHIVE_META_RO_DSN, 'the two doors are not the same line twice');
  ok(dsnRole(vars.DATABASE_URL) === ROLE && dsnRole(vars.ZEEHIVE_META_RO_DSN) === META_ROLE,
     `the file names DIFFERENT roles (${dsnRole(vars.DATABASE_URL)} / ${dsnRole(vars.ZEEHIVE_META_RO_DSN)}) — `
     + 'the same-role-twice-with-two-passwords shape cannot recur');
  ok(text.split('\n').filter((l) => l.startsWith('DATABASE_URL=')).length === 1,
     'exactly one DATABASE_URL line');
  ok(await opens(vars.DATABASE_URL), 'and the credential the file advertises as the xell\'s database OPENS');

  // ── D. the preflight probes the BINDING's DSN ────────────────────────────────────────────────
  console.log('\nD. db-open probes the binding, and says which rule produced it');
  const v = await preflightXell(mgr.id, { timeout: PREFLIGHT_TIMEOUT_MS });
  const c = v.checks.find((x) => x.check === 'db-open');
  ok(v.ok === true && v.error === null, `the binding is PROVEN (error=${v.error ?? 'null'})`);
  ok(c?.skipped === false && c?.ok === true,
     'db-open RAN against a db-prod-readonly binding — it is the minted SELECT-only reader, not the prod owner');
  ok(/dsn source: prod-readonly-dsn/.test(c?.detail || ''), `…and labels where the string came from (${c?.detail})`);
  ok(new RegExp(`role ${ROLE}\\b`).test(c?.detail || ''), '…naming the reader role it opened as');

  // a dead reader is a FAILURE, not a skip — and the failure names the binding's own door
  const dead = await mkXell('dead', { coupling: 'db-prod-readonly',
                                      roDsn: dsnFor(`nosuchrole_${tag}`, 'pw') });
  const dv = await preflightXell(dead.id, { timeout: 1500 });
  const dc = dv.checks.find((x) => x.check === 'db-open');
  ok(dv.ok === false && dc?.skipped === false, 'a read-only binding that does NOT open condemns the xell');
  ok(new RegExp(`nosuchrole_${tag}`).test(dv.error || '') && /dsn source: prod-readonly-dsn/.test(dv.error || ''),
     `the verdict names the role it dialled and the rule that produced the DSN (${dv.error})`);

  // the WRITE production bind is still never opened — the exemption is the read-only reader only
  const prodDb = await one(
    `INSERT INTO container (project_id, role, tier, isolation, name, docker_ctx, internal_port, conn_ref)
       VALUES ($1,'db','prod','shared',$2,'default',5432,$3) RETURNING id`,
    [pid, `rocol_${tag}_prod_db`, UNROUTABLE]);
  const rw = await mkXell('rw', { coupling: 'db-shared-prod', roDsn: null });
  await q(`INSERT INTO xell_uses_container (xell_id, container_id, relation) VALUES ($1,$2,'uses')`,
          [rw.id, prodDb.id]);
  const t0 = Date.now();
  const rwv = await preflightXell(rw.id, { timeout: 30000 });
  const rwc = rwv.checks.find((x) => x.check === 'db-open');
  ok(rwc?.skipped === true && /production/.test(rwc?.detail || ''),
     `db-shared-prod is still SKIPPED, not probed (${rwc?.detail})`);
  ok(Date.now() - t0 < 1000, 'and it returned immediately — the owner credential was never dialled');

  // …and in PRODRO_MODE=simulate the reader is a deliberate fake: SKIPPED (unproven, not failed).
  // PRODRO_MODE is fixed at module load, so that half runs in a child with the flag set.
  console.log('\nD2. simulate mode: no role was minted, so the reader is unproven — not failed');
  const phony = await mkXell('phony', { coupling: 'db-prod-readonly', roDsn: UNROUTABLE });
  const realV = await preflightXell(phony.id, { timeout: 1200 });
  ok(realV.ok === false, 'in REAL mode the same unroutable reader is dialled and FAILS (bound 1.2s)');
  const childFile = join(root, 'sim-pf.mjs');
  writeFileSync(childFile, [
    `const { preflightXell } = await import(${JSON.stringify(join(process.cwd(), 'server/src/lib/preflight.js'))});`,
    `const v = await preflightXell(process.argv[2], { timeout: 1200 });`,
    `console.log('__V__' + JSON.stringify(v));`,
    `process.exit(0);`,
  ].join('\n'));
  const child = spawnSync(process.execPath, [childFile, phony.id],
    { encoding: 'utf8', env: { ...process.env, PRODRO_MODE: 'simulate' }, timeout: 60000 });
  const line = (child.stdout || '').split('\n').find((l) => l.startsWith('__V__'));
  ok(!!line, `the simulate child answered${line ? '' : ` (stderr: ${(child.stderr || '').slice(-200)})`}`);
  const simV = line ? JSON.parse(line.slice(5)) : { checks: [] };
  const sc = simV.checks?.find((x) => x.check === 'db-open');
  ok(simV.ok === true && sc?.skipped === true,
     'the simulated reader is SKIPPED — a fake DSN must not read as a credential fault');
  ok(/SIMULATED/.test(sc?.detail || ''), `…and it says why (${sc?.detail})`);

  // ── E. §4.5 on the MANAGER bind: a refusal runs the compensation BEFORE it throws ──────────────
  //
  // intake.js's manager path now re-preflights the binding it just minted and, under
  // readiness_proof='required', refuses the dispatch. The three moving parts of that branch need no
  // docker — the policy (a pool_config row), the verdict (a preflight against the binding's own
  // DSN) and the compensation (drop the minted reader, put the xell back on the shared dev db) — so
  // they are DRIVEN here rather than described, with a reader the cluster will refuse (the one
  // shape a refusal can be provoked with off production).
  //
  // WHAT THIS DOES NOT COVER, so the next reader is not misled: the dispatch loop that CALLS these
  // two — dispatching a real manager, seeing the throw, and the pool routing the released xell
  // (§4.6) — is not executed here; that needs a live spawn. What is proven is that the pair
  // intake.js runs does what the branch assumes: refuses under 'required', does not under
  // 'advisory', and leaves no production credential or link behind when it compensates.
  console.log('\nE. §4.5 on the manager bind: a refusal compensates before it throws');
  await q(`INSERT INTO pool_config (project_id, readiness_proof) VALUES ($1,'required')
             ON CONFLICT (project_id) DO UPDATE SET readiness_proof='required'`, [pid]);
  const deadDsn = dsnFor(`nosuchrole_${tag}`, 'pw');
  const badBind = await mkXell('badbind', { coupling: 'db-prod-readonly', roDsn: deadDsn });
  const refused = await rePreflightAfterBindingChange(badBind.id);
  ok(refused.refused === true && refused.policy === 'required',
     'under readiness_proof=required a dead read-only binding REFUSES the dispatch');
  ok(/db-open/.test(refused.reason || '') && new RegExp(`nosuchrole_${tag}`).test(refused.reason || ''),
     `…naming the check that failed and the role it dialled (${(refused.reason || '').slice(0, 120)}…)`);

  // The compensating action intake.js performs BEFORE it throws.
  await unbindManagerFromProdReadonly(badBind.id,
    'its read-only bind failed the §4.5 re-preflight under readiness_proof=required');
  const back = await one(`SELECT db_coupling, prod_ro_dsn FROM xell WHERE id=$1`, [badBind.id]);
  ok(back?.db_coupling === 'db-shared-dev' && back?.prod_ro_dsn === null,
     `the compensation runs first: the xell is back on the shared dev db holding no production DSN `
     + `(${back?.db_coupling}, prod_ro_dsn ${back?.prod_ro_dsn})`);
  const links = await one(
    `SELECT count(*)::int AS n FROM xell_uses_container uc JOIN container c ON c.id=uc.container_id
      WHERE uc.xell_id=$1 AND c.role='db' AND c.tier='prod'`, [badBind.id]);
  ok(links?.n === 0, '…and no LINK to a production container is left on it either');

  // The other half of the policy × verdict table: the SAME dead binding under advisory refuses
  // NOTHING — the verdict is stamped on the row and the spawn proceeds (that is what #47 wants: a
  // failed check that is visible, not a dispatch that silently stops).
  await q(`UPDATE pool_config SET readiness_proof='advisory' WHERE project_id=$1`, [pid]);
  const advBind = await mkXell('advbind', { coupling: 'db-prod-readonly', roDsn: deadDsn });
  const advised = await rePreflightAfterBindingChange(advBind.id);
  ok(advised.refused === false && advised.verdict.ok === false,
     'the same dead binding under advisory refuses nothing — the failure is stamped, not fatal');
  ok(/db-open/.test(advised.verdict.error || ''),
     `…and the stamped verdict still names the check (${advised.verdict.error})`);

  console.log(fail ? `\n${fail} FAILED` : '\nall good');
} catch (e) {
  console.error('TEST ERROR:', e);
  fail++;
} finally {
  // Drop every role this test minted, with the repo's own inverse SQL, and SHOW any residue. The
  // check must FAIL LOUD on an unreadable answer too: `left?.n` alone treats "the count query
  // itself failed" exactly like "the role is gone", which is how a leaked credential hides.
  for (const role of [ROLE, META_ROLE]) {
    let dropErr = null;
    try { await q(dropProdReaderSql(role, dbName, dbOwner)); } catch (e) { dropErr = e; }
    let left = null;
    try { left = await one(`SELECT count(*)::int AS n FROM pg_roles WHERE rolname=$1`, [role]); }
    catch (e) { console.log(`  ⚠ cleanup: could not confirm ${role} is gone — ${e.message}`); continue; }
    if (left?.n) console.log(`  ⚠ cleanup: role ${role} survived teardown${dropErr ? ` — ${dropErr.message}` : ''}`);
  }
  if (pid) {
    // pool_config is deleted EXPLICITLY rather than left to the project cascade: its FK does cascade
    // today (pool_config_project_id_fkey, ON DELETE CASCADE), but this teardown should not depend on
    // a schema detail it does not own — a dropped cascade would turn a green run into a silent leak.
    await q(`DELETE FROM pool_config WHERE project_id=$1`, [pid]).catch(() => {});
    await q(`DELETE FROM xell_uses_container WHERE xell_id IN (SELECT id FROM xell WHERE project_id=$1)`, [pid]).catch(() => {});
    await q(`DELETE FROM container WHERE project_id=$1`, [pid]).catch(() => {});
    await q(`DELETE FROM xell WHERE project_id=$1`, [pid]).catch(() => {});
    await q(`DELETE FROM xource WHERE project_id=$1`, [pid]).catch(() => {});
    await q(`DELETE FROM project WHERE id=$1`, [pid]).catch(() => {});
    // A fixture row left behind is not inert: these rows are status='working', and any test that
    // reads "the working xell" from a shared sandbox (prod-readonly-secrets-migration does) will
    // pick the wrong one. Say so rather than leak it quietly.
    const rowsLeft = await one(`SELECT count(*)::int AS n FROM xell WHERE project_id=$1`, [pid]).catch(() => null);
    if (rowsLeft?.n) console.log(`  ⚠ cleanup: ${rowsLeft.n} fixture xell row(s) survived teardown`);
  }
  await pool.end().catch(() => {});
  try { rmSync(root, { recursive: true, force: true }); } catch { /* tmp */ }
}
process.exit(fail ? 1 : 0);
