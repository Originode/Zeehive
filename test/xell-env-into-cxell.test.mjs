// TICKET #15, THE THIRD HALF — a re-emitted .zeehive.env must reach the ZEE, not just the worktree.
//
// #15 fixed WHAT the projection computes. 078/3d054b03 added the boot reconcile that fixes the file
// on every xell provisioned before that rule. Both of them stop at the HOST WORKTREE — and a cxell
// zee never reads that file. It reads a COPY, `docker cp`d into /work/repo at spawn (lib/cxell.js
// cloneIntoCxell, beside the git bundle). So every zee already in a cage kept the values it was born
// with: a manager bound to production read-only, TOLD it holds production, reading a DATABASE_URL
// that named its own throwaway spinoff db, with no environment block at all.
//
// The reconcile made one thing worse, and it is the reason this cannot be keyed off the host file:
// once it repairs the worktree copy, the HOST comparison says "unchanged" at every later emit, so a
// fix that only fired on host-changed would be inert for exactly the xells that were already
// running when it shipped. The cage's copy is therefore compared IN THE CAGE.
//
// What this pins (lib/provision.js refreshLiveCxellEnv → queenzee/intake.js injectXellEnvIntoCxell
// → lib/cxell.js writeFileIntoCxellIfChanged):
//
//   1. A CHANGED PROJECTION REACHES THE LIVE CXELL — the exact bytes, into /work/repo/.zeehive.env,
//      via the mechanism the harness layer already uses, and the write is LOGGED as the QUEENZEE's
//      doing. A file changing under a working zee must never be indistinguishable from the zee
//      having written it.
//   2. UNCHANGED CONTENT WRITES NOTHING — in the cage as on the host. The comparison is made inside
//      the container, in the same exec, and a SAME verdict is not a write and is not logged as one.
//   3. IT RUNS EVEN WHEN THE HOST FILE DID NOT MOVE. The regression above, stated as a test.
//   4. IT OBEYS PROVISION_MODE (86eede9d): a nested/simulate queenzee REPORTS the cxell it would
//      have refreshed and execs nothing at all. A xell's db is a CLONE of the meta-DB, so the slugs
//      a nested queenzee walks name the REAL fleet's containers.
//   5. A FAILURE IS REPORTED, NEVER SWALLOWED — in the emit result, in the sweep's result, as a loud
//      log line, and on the xell row (env_cxell_error, migration 082) so it outlives the log. It is
//      a SEPARATE column from env_projection_error on purpose: the host file being wrong and the zee
//      not being able to see a correct one need different remedies. And it clears on the next
//      success.
//   6. NO LIVE CXELL IS NOT A FAILURE. A host-side xell has no cage; nothing there is reading a
//      stale copy, so nothing is attempted and nothing is flagged.
//
// The seam is `docker` itself: the fake shim in test/_bin records argv + stdin, and states the
// verdict the container would have printed (DOCKER_FAKE_CXELL_VERDICT). Taking the shim OFF $PATH is
// how the unreachable-cage case is produced — the same seam test/harness-reinject-live.test.mjs uses.
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }
process.env.PROVISION_MODE = 'simulate';
process.env.BUILD_MODE = 'simulate';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHIM = join(REPO_ROOT, 'test', '_bin');
const BARE_PATH = process.env.PATH;                 // no fake docker on it → an unreachable cage
const withDocker = () => { process.env.PATH = `${SHIM}:${BARE_PATH}`; };
const withoutDocker = () => { process.env.PATH = BARE_PATH; };

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

const { q, one, pool } = await import('../server/src/db/pool.js');
const { emitXellEnv, reconcileXellEnvs } = await import('../server/src/lib/provision.js');
const { recentLogs } = await import('../server/src/lib/logbus.js');

const tag = randomUUID().slice(0, 8).replace(/[^a-z0-9]/g, '');
const root = mkdtempSync(join(tmpdir(), `envcage-${tag}-`));
const DOCKER_LOG = join(root, 'docker.log');
process.env.DOCKER_LOG = DOCKER_LOG;

const dockerLog = () => (existsSync(DOCKER_LOG) ? readFileSync(DOCKER_LOG, 'utf8') : '');
const clearDocker = () => { try { truncateSync(DOCKER_LOG, 0); } catch { /* not created yet */ } };
const since = () => recentLogs(600).length;
const linesSince = (n, scope) => recentLogs(600).slice(n).filter((l) => l.scope === scope).map((l) => l.msg);
const OWNED = (n) => `postgresql://zeehive@envcage_${tag}_${n}_db:5432/zeehive`;
const envFile = (x) => join(x.wt, '.zeehive.env');
const read = (x) => readFileSync(envFile(x), 'utf8');
// the file a xell provisioned before the fix is carrying, on the host AND in its cage
const STALE = (n) => [
  '# .zeehive.env — GENERATED by ZEEHIVE from the meta-DB. Do not edit; regenerate via the console.',
  `SPINOFF_SLUG=envcage-${tag}-${n}`,
  `DATABASE_URL=${OWNED(n)}`,
  '',
].join('\n');

let pid = null;
const madeXells = [];

try {
  pid = (await one(
    `INSERT INTO project (name, repo_root, db_user, db_name) VALUES ($1,$2,'zeehive','zeehive') RETURNING id`,
    [`envcage-${tag}`, process.cwd()])).id;
  const xoid = (await one(`INSERT INTO xource (project_id, ref) VALUES ($1,'master') RETURNING id`, [pid])).id;

  const mkXell = async (name, { live }) => {
    const slug = `envcage-${tag}-${name}`;
    const wt = join(root, name);
    mkdirSync(wt, { recursive: true });
    const x = await one(
      `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status, is_pooled,
                         zee_type, db_coupling)
         VALUES ($1,$2,$3,$4,$5,'working',false,'worker','db-isolated') RETURNING *`,
      [pid, xoid, slug, `spinoff/${slug}`, wt]);
    madeXells.push(x.id);
    await q(`INSERT INTO container (project_id, role, tier, isolation, name, docker_ctx, internal_port,
                                    conn_ref, owner_xell_id)
               VALUES ($1,'db','spinoff','per-xell',$2,'default',5432,$3,$4)`,
            [pid, `envcage_${tag}_${name}_db`, OWNED(name), x.id]);
    if (live) {
      // what "a live cxell zee" means to the injector — the same shape reinjectHarnessIntoXell wants
      await q(`INSERT INTO zee (xell_id, attach_mode, entrypoint, status, viewer_kind)
                 VALUES ($1,'headless-spawn','cxell-cli','working','ssh-terminal')`, [x.id]);
    }
    writeFileSync(envFile({ wt }), STALE(name));   // both fixtures start STALE on disk
    return { ...x, wt, name };
  };

  const caged = await mkXell('caged', { live: true });    // a zee working inside a cxell right now
  const hostside = await mkXell('hostside', { live: false });  // no cage at all

  // ── 4. SIMULATE: report the cxell it would have refreshed, exec NOTHING ──────────────────────
  console.log('PROVISION_MODE=simulate: a nested queenzee reports the cage it would refresh, and execs nothing');
  withDocker();
  clearDocker();
  let n = since();
  const dry = await reconcileXellEnvs({ reason: 'test-simulate', mode: 'simulate' });
  ok(dry.cxell_would_refresh >= 1 && (dry.cxell_stale || []).includes(caged.slug),
     `the sweep names the live cxell it would have refreshed [${(dry.cxell_stale || []).join(', ')}]`);
  ok(dry.cxell_refreshed === 0 && dockerLog() === '',
     'and runs NO docker at all — a nested queenzee walks the REAL fleet\'s slugs');
  ok(linesSince(n, 'cxell').some((m) => m.startsWith(`${caged.slug}:`) && /NOT refreshed/.test(m)
       && /PROVISION_MODE=simulate/.test(m)),
     'the report-only outcome is a log line naming the xell, not a silent skip');
  const dryEmit = await emitXellEnv(caged.id, { dryRun: true });
  ok(dryEmit.cxell?.dry_run === true && dryEmit.cxell?.would_refresh === true,
     'emitXellEnv({dryRun}) carries the same report-only shape in its result');

  // ── 1. REAL: the changed projection lands in the live cxell, and says who wrote it ───────────
  console.log('\na changed projection is written into the LIVE cxell, and the write is logged');
  clearDocker();
  n = since();
  process.env.DOCKER_FAKE_CXELL_VERDICT = 'WROTE';        // the cage's copy was stale
  const r1 = await reconcileXellEnvs({ reason: 'test-real', mode: 'real' });
  const dl = dockerLog();
  ok(r1.cxell_refreshed === 1 && (r1.cxell_stale || []).includes(caged.slug),
     `the sweep reports the live cxell it refreshed [${(r1.cxell_stale || []).join(', ') || 'none'}]`);
  ok(new RegExp(`exec -i cxell_${caged.slug} bash -lc`).test(dl),
     'it is a docker exec into THIS xell\'s cxell (the harness layer\'s mechanism, not a second one)');
  ok(/P='\/work\/repo\/\.zeehive\.env'/.test(dl), 'writing /work/repo/.zeehive.env — the file the zee reads');
  ok(/sha256sum/.test(dl) && /echo SAME/.test(dl) && /echo WROTE/.test(dl),
     'the CAGE decides whether anything changed, in the same exec that would do the writing');
  const piped = /STDIN<<\n([\s\S]*?)\n>>STDIN/.exec(dl)?.[1] || '';
  ok(piped === read(caged).replace(/\n$/, ''),
     'the bytes piped in are exactly the projection now on the host — WHERE it lands changed, not WHAT it says');
  ok(/SPINOFF_SLUG=/.test(piped) && /DATABASE_URL=/.test(piped) && /ZEEHIVE_SITE=/.test(piped),
     'and it is the whole projection (slug, database, site), not a patch of one line');
  const cxLines = linesSince(n, 'cxell').filter((m) => m.startsWith(`${caged.slug}:`));
  ok(cxLines.some((m) => /REFRESHED inside the LIVE cxell/.test(m) && /QUEENZEE wrote that file, not the zee/.test(m)),
     `the write is logged as the queenzee's doing [${(cxLines[0] || '(none)').slice(0, 58)}…]`);
  ok(cxLines.some((m) => /old values until it re-reads the file or rebuilds/.test(m)),
     'and says what the zee still holds — a refreshed file is not a refreshed process');
  const cagedRow = await one(`SELECT env_projection_error, env_cxell_error, env_cxell_refreshed_at
                                FROM xell WHERE id=$1`, [caged.id]);
  ok(cagedRow.env_cxell_error === null && cagedRow.env_cxell_refreshed_at !== null,
     'the xell row is stamped: the cage copy was verified, with no error');

  // ── 6. a xell with NO live cxell is not attempted and not flagged ────────────────────────────
  console.log('\na xell with no live cxell is left alone — nothing in a cage is reading a stale copy');
  ok(!new RegExp(`cxell_${hostside.slug}`).test(dl), 'no exec is attempted for it');
  const hostEmit = await emitXellEnv(hostside.id);
  ok(hostEmit.cxell?.live === false && !hostEmit.cxell?.error,
     `the result says so plainly, and it is not an error [${hostEmit.cxell?.reason || ''}]`);
  const hostRow = await one(`SELECT env_cxell_error FROM xell WHERE id=$1`, [hostside.id]);
  ok(hostRow.env_cxell_error === null, 'and its row carries no cage failure it could never have had');

  // ── 2 + 3. the host file is now current: the cage is STILL asked, and SAME writes nothing ────
  console.log('\nthe cage is compared even when the host file did not move — and identical is a no-op');
  clearDocker();
  n = since();
  process.env.DOCKER_FAKE_CXELL_VERDICT = 'SAME';         // the cage already holds these bytes
  const r2 = await reconcileXellEnvs({ reason: 'test-again', mode: 'real' });
  ok(r2.rewritten === 0, 'the host files are already in sync — nothing is rewritten there');
  ok(new RegExp(`exec -i cxell_${caged.slug}`).test(dockerLog()),
     'the live cxell is compared ANYWAY — keying this off the host file is the bug it was written for');
  ok(r2.cxell_refreshed === 0 && !(r2.cxell_stale || []).includes(caged.slug),
     'a cage that already holds the bytes is not counted as refreshed');
  ok(!linesSince(n, 'cxell').some((m) => /REFRESHED inside the LIVE cxell/.test(m)),
     'and it is not logged as a write — an unchanged file under a working zee must not be touched');
  const emitSame = await emitXellEnv(caged.id);
  ok(emitSame.cxell?.refreshed === true && emitSame.cxell?.changed === false,
     'the result distinguishes "verified, identical" from "written"');

  // ── 5. an unreachable cage is REPORTED, on the row, in the result, and loudly ────────────────
  console.log('\na cage that cannot be reached is reported, never swallowed');
  clearDocker();
  n = since();
  withoutDocker();                                        // exec refused: no docker to reach it with
  const r3 = await reconcileXellEnvs({ reason: 'test-broken', mode: 'real' });
  ok(r3.cxell_failed === 1 && (r3.cxell_broken || []).some((b) => b.startsWith(caged.slug)),
     `the sweep reports the failure in its result [${(r3.cxell_broken || [])[0] || 'none'}]`);
  ok(r3.failed === 0, 'the HOST projection is not marked failed — that file is correct, and they are different facts');
  ok(linesSince(n, 'cxell').some((m) => m.startsWith(`${caged.slug}:`) && /could NOT be refreshed/.test(m)
       && /still reading whatever its copy already said/.test(m)),
     'a log line names the xell and the consequence');
  const brokenRow = await one(`SELECT env_projection_error, env_cxell_error FROM xell WHERE id=$1`, [caged.id]);
  ok(brokenRow.env_cxell_error !== null,
     `the xell row carries WHY, so it outlives the log [${(brokenRow.env_cxell_error || 'null').slice(0, 44)}…]`);
  ok(brokenRow.env_projection_error === null,
     'in its OWN column — a correct host file must not fly the "projection failed" badge (078 vs 082)');
  ok(/reconcile \(test-broken\)/.test(linesSince(n, 'env').join('\n'))
     && /UNREACHABLE/.test(linesSince(n, 'env').join('\n')),
     'the sweep\'s one summary line carries the cage half too');

  // …and it clears itself once the cage is reachable again: a stale "broken" badge is its own bug
  withDocker();
  process.env.DOCKER_FAKE_CXELL_VERDICT = 'WROTE';
  await reconcileXellEnvs({ reason: 'test-healed', mode: 'real' });
  const healed = await one(`SELECT env_cxell_error, env_cxell_refreshed_at FROM xell WHERE id=$1`, [caged.id]);
  ok(healed.env_cxell_error === null && healed.env_cxell_refreshed_at !== null,
     'once the cage is reachable the next sweep clears the error and re-stamps the refresh');

  // ── the wiring is the SAME mechanism, not a second one ──────────────────────────────────────
  console.log('\nthe injector reuses the harness layer\'s path');
  const prov = readFileSync('server/src/lib/provision.js', 'utf8');
  ok(/injectXellEnvIntoCxell/.test(prov), 'provision.js delegates the cage write instead of shelling out itself');
  const intake = readFileSync('server/src/queenzee/intake.js', 'utf8');
  ok(/liveCxellZeeFor\(xellId\)/.test(intake)
     && (intake.match(/liveCxellZeeFor\(/g) || []).length >= 3,
     'and "which zee is live in a cage" is ONE definition, shared with reinjectHarnessIntoXell');

  console.log(fail ? `\n${fail} FAILED` : '\nall good');
} catch (e) {
  console.error('TEST ERROR:', e);
  fail++;
} finally {
  delete process.env.DOCKER_FAKE_CXELL_VERDICT;
  process.env.PATH = BARE_PATH;
  for (const id of madeXells) await q(`DELETE FROM zee WHERE xell_id=$1`, [id]).catch(() => {});
  if (pid) await q(`DELETE FROM project WHERE id=$1`, [pid]).catch(() => {});
  await pool.end().catch(() => {});
  try { rmSync(root, { recursive: true, force: true }); } catch { /* */ }
}
process.exit(fail ? 1 : 0);
