// TICKET #53 — THE QUEENZEE MUST OPEN WHAT IT WROTE BEFORE IT CALLS A XELL READY.
//
// .zeehive.env is a projection from meta-DB rows, and 078/082 record whether the FILE was written.
// Nothing has ever opened what is IN it, so a xell whose DATABASE_URL is rejected reads as perfectly
// healthy until an agent trips over it hours later. That is not hypothetical: seven workers in one
// manager's crew of thirteen hit "password authentication failed for user zeehive" in a single
// night (ticket #47), two of them burned three hours and landed nothing, and every projection
// column was green throughout.
//
// Covered here (Part A is pure, Part B needs a real database — DATABASE_URL):
//   • the DSN that OPENS  → db-open passes, the xell's verdict is clean
//   • the DSN that is REJECTED (a role that does not exist) → db-open FAILS, and the failure names
//     the check, the role and the address; the verdict is stamped on the xell row
//   • a xell that fails preflight does NOT read as `ready` on the hive — it reads `dirty`
//   • PRODUCTION is never opened: a prod-coupled xell reports db-open SKIPPED, and the proof it did
//     not probe is that the prod DSN points at an address that could only ever time out
//   • no DATABASE_URL projected (a compose xell on the shared dev db) is SKIPPED, not failed
//   • the probe is READ-ONLY: nothing in the database changes across a preflight
//   • the probe is BOUNDED: an unroutable address returns a verdict instead of hanging
import { randomUUID } from 'node:crypto';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }
process.env.PROVISION_MODE = 'simulate';
process.env.BUILD_MODE = 'simulate';
process.env.TKB_NOTIFY = '0';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

const { hiveStatus } = await import('../server/src/lib/hive-status.js');
const { q, one, pool } = await import('../server/src/db/pool.js');
const { preflightXell, runPreflight, checkDsnOpens } = await import('../server/src/lib/preflight.js');

// ── Part A: the hive vocabulary (pure, no database) ────────────────────────────────────────────
// A vacant xell whose preflight failed must not read `ready`. It reads `dirty` — the existing word
// for "needs queenzee housekeeping" — rather than a new status, because the point is that a human
// scanning the hive sees something other than a clean pool xell, not that the vocabulary grows.
console.log('a xell that FAILS preflight does not read as ready');
const readyXell = { status: 'ready', is_production: false };
ok(hiveStatus(readyXell) === 'vac-ready', 'a clean pool xell still reads ready');
ok(hiveStatus(readyXell, { preflightFailed: true }) === 'vac-dirty',
   'a pool xell whose preflight failed reads dirty, not ready — the ticket');
ok(hiveStatus({ status: 'provisioning', is_production: false }, { preflightFailed: true }) === 'vac-provisioning',
   'a xell still PROVISIONING is not condemned by a preflight that has not run yet');
ok(hiveStatus({ status: 'working', is_production: false, zee_status: 'working' }, { preflightFailed: true }) === 'occ-working',
   'and an occupied xell keeps showing what its zee is doing (the chip carries the fault)');

// ── Part B: against a real database ────────────────────────────────────────────────────────────
const tag = randomUUID().slice(0, 8).replace(/[^a-z0-9]/g, '');
const dead = new URL(url.replace(/^postgres(ql)?:/, 'http:'));
// SAME server, a role that does not exist: a real, immediate credential rejection — the shape of
// the fault this preflight exists to catch, without needing a wrong password on a trust-auth db.
const REJECTED = url.replace(/^(postgres(?:ql)?:\/\/)[^@/]*@/, `$1nosuchrole_${tag}@`);
const UNROUTABLE = 'postgresql://zeehive@192.0.2.1:5432/zeehive';   // RFC5737 TEST-NET-1: goes nowhere
let pid = null;

try {
  pid = (await one(
    `INSERT INTO project (name, repo_root, db_user, db_name) VALUES ($1,$2,'zeehive','zeehive') RETURNING id`,
    [`pf53-${tag}`, process.cwd()])).id;
  const xoid = (await one(`INSERT INTO xource (project_id, ref) VALUES ($1,'master') RETURNING id`, [pid])).id;

  // a pooled xell with its own db container, exactly as provisioning leaves it
  const mkXell = async (name, { coupling = 'db-isolated', connRef = null, status = 'ready' } = {}) => {
    const slug = `pf53-${tag}-${name}`;
    const x = await one(
      `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status, is_pooled,
                         zee_type, db_coupling)
         VALUES ($1,$2,$3,$4,$5,$6,true,'worker',$7) RETURNING *`,
      [pid, xoid, slug, `spinoff/${slug}`, `/tmp/pf53/${slug}`, status, coupling]);
    if (connRef !== null) {
      const c = await one(
        `INSERT INTO container (project_id, role, tier, isolation, name, docker_ctx, internal_port,
                                host_port, conn_ref, owner_xell_id)
           VALUES ($1,'db','spinoff','per-xell',$2,'default',5432,15432,$3,$4) RETURNING id`,
        [pid, `pf53_${tag}_${name}_db`, connRef, x.id]);
      await q(`INSERT INTO xell_uses_container (xell_id, container_id, relation) VALUES ($1,$2,'owns')`,
              [x.id, c.id]);
    }
    return x;
  };

  // ── the DSN that opens ──────────────────────────────────────────────────────────────────────
  console.log('\nthe DSN the queenzee wrote OPENS');
  const good = await mkXell('good', { connRef: url });
  const goodV = await runPreflight(good.id);
  const goodCheck = goodV.checks.find((c) => c.check === 'db-open');
  ok(goodV.ok === true, `the verdict is ready (error=${goodV.error ?? 'null'})`);
  ok(goodCheck?.ok === true && !goodCheck.skipped, 'db-open passed — it really opened and ran SELECT 1');
  ok(/dsn source: own-db-container/.test(goodCheck?.detail || ''),
     `…and it says WHICH rule produced the string it opened (${goodCheck?.detail})`);
  const goodRow = await one(`SELECT preflight_at, preflight_error, preflight_checks FROM xell WHERE id=$1`, [good.id]);
  ok(goodRow.preflight_at && goodRow.preflight_error === null, 'the xell row records a clean, timestamped verdict');
  ok(Array.isArray(goodRow.preflight_checks) && goodRow.preflight_checks.length === 1,
     'and keeps every check, not just the failures');
  ok(hiveStatus(await one(`SELECT * FROM xell WHERE id=$1`, [good.id]),
                { preflightFailed: !!goodRow.preflight_error }) === 'vac-ready',
     'a xell that passed still reads ready');

  // ── the DSN that is rejected — the fleet's actual fault ─────────────────────────────────────
  console.log('\nthe DSN the queenzee wrote is REJECTED (ticket #47, seven zees in one night)');
  const bad = await mkXell('bad', { connRef: REJECTED });
  const badV = await runPreflight(bad.id);
  const badCheck = badV.checks.find((c) => c.check === 'db-open');
  ok(badV.ok === false, 'the verdict is NOT ready');
  ok(/^db-open: /.test(badV.error || ''), `…and it NAMES the failing check (${badV.error})`);
  ok(badV.error.includes(`nosuchrole_${tag}`),
     'the error names the ROLE that was refused — the first thing a human triaging needs');
  ok(!badV.error.includes('SELECT 1 did not'), 'it failed at the door, not on the query');
  ok(badCheck?.skipped === false, 'the check RAN — a failure is not a skip');
  const badRow = await one(`SELECT preflight_at, preflight_error FROM xell WHERE id=$1`, [bad.id]);
  ok(badRow.preflight_error === badV.error, 'the xell row carries the named failure for the console');
  ok(hiveStatus(await one(`SELECT * FROM xell WHERE id=$1`, [bad.id]),
                { preflightFailed: !!badRow.preflight_error }) === 'vac-dirty',
     'and the hive stops calling it ready — the whole point of recording a verdict');

  // ── production is never opened ──────────────────────────────────────────────────────────────
  // The prod DSN here is unroutable on purpose: if the preflight probed it, this assertion could
  // only pass after a timeout, and it could never come back `skipped`.
  console.log('\nPRODUCTION is never opened by a preflight');
  const prodDb = await one(
    `INSERT INTO container (project_id, role, tier, isolation, name, docker_ctx, internal_port, conn_ref)
       VALUES ($1,'db','prod','shared',$2,'default',5432,$3) RETURNING id`,
    [pid, `pf53_${tag}_prod_db`, UNROUTABLE]);
  const onProd = await mkXell('prod', { coupling: 'db-shared-prod', connRef: null, status: 'working' });
  await q(`INSERT INTO xell_uses_container (xell_id, container_id, relation) VALUES ($1,$2,'uses')`,
          [onProd.id, prodDb.id]);
  const t0 = Date.now();
  const prodV = await preflightXell(onProd.id, { timeout: 30000 });
  const prodCheck = prodV.checks.find((c) => c.check === 'db-open');
  ok(prodCheck?.skipped === true, 'db-open is SKIPPED for a production binding');
  ok(prodV.ok === true && prodV.error === null, 'a skip asserts nothing, so it never condemns the xell');
  ok(/production/i.test(prodCheck?.detail || ''), `…and says why (${prodCheck?.detail})`);
  // Not a wall-clock threshold in disguise: with a 30s bound, a probe of an unroutable address
  // cannot come back in under a second, so this distinguishes "skipped" from "tried and gave up".
  ok(Date.now() - t0 < 1000, 'and it returned immediately — it never dialled production');

  // ── nothing to open ─────────────────────────────────────────────────────────────────────────
  console.log('\na xell with no projected DATABASE_URL is reported, not condemned');
  const none = await mkXell('none', { coupling: 'db-shared-dev', connRef: null });
  const noneV = await preflightXell(none.id);
  const noneCheck = noneV.checks.find((c) => c.check === 'db-open');
  ok(noneV.ok === true && noneCheck?.skipped === true,
     'a compose xell that gets its db by network alias is not a broken xell');
  ok(/no DATABASE_URL/.test(noneCheck?.detail || ''), `…and the reason is on the record (${noneCheck?.detail})`);

  // ── the verdict reaches the read model, not just the row ────────────────────────────────────
  // The row could carry a perfect verdict and the fleet still call the xell `ready` — that is the
  // shape of the original bug (a fact recorded where nothing reads it). So this asserts through
  // lib/fleet, which is what the console and the honeycomb poll, with NO flag passed by hand.
  console.log('\nthe recorded verdict reaches the fleet read model');
  const { getFleet } = await import('../server/src/lib/fleet.js');
  const fleet = await getFleet(pid);
  const seen = (id) => fleet.xells.find((x) => x.id === id);
  ok(seen(bad.id)?.hive_status === 'vac-dirty',
     `the failing xell reads dirty in the fleet the console polls (${seen(bad.id)?.hive_status})`);
  ok(seen(bad.id)?.preflight_error === badV.error,
     'and the named check rides on the row the card renders from');
  ok(seen(good.id)?.hive_status === 'vac-ready',
     `while the xell that opened still reads ready (${seen(good.id)?.hive_status})`);

  // ── read-only ───────────────────────────────────────────────────────────────────────────────
  console.log('\nthe probe is READ-ONLY');
  const rels = () => one(`SELECT count(*)::int AS n FROM pg_class WHERE relnamespace='public'::regnamespace`);
  const beforeRels = (await rels()).n;
  const probe = await checkDsnOpens(url);
  ok(probe.ok === true, 'the probe opened the database');
  ok((await rels()).n === beforeRels,
     `…and created nothing to test writability (${beforeRels} relations before and after)`);

  // ── bounded ─────────────────────────────────────────────────────────────────────────────────
  // What is asserted is that it RETURNS — a preflight that hangs is worse than none. The ceiling is
  // deliberately far above the 1s bound rather than a measurement of how fast this machine is.
  console.log('\nevery probe is BOUNDED');
  const t1 = Date.now();
  const hung = await checkDsnOpens(UNROUTABLE, { timeout: 1000 });
  ok(hung.ok === false, `an unroutable address answers with a verdict, not a hang (${hung.detail})`);
  ok(Date.now() - t1 < 20000, `…and it comes back (${Date.now() - t1}ms, bound 1000ms)`);
} finally {
  if (pid) {
    await q(`DELETE FROM xell_uses_container WHERE xell_id IN (SELECT id FROM xell WHERE project_id=$1)`, [pid]);
    await q(`DELETE FROM container WHERE project_id=$1`, [pid]);
    await q(`DELETE FROM xell WHERE project_id=$1`, [pid]);
    await q(`DELETE FROM xource WHERE project_id=$1`, [pid]);
    await q(`DELETE FROM project WHERE id=$1`, [pid]);
  }
  await pool.end();
}

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
