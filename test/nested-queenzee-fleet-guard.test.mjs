// A NESTED QUEENZEE MUST NEVER REACH A REAL CXELL, WORKTREE, CONTAINER OR IMAGE.
//
// THE CLASS. A xell's database is a CLONE of the meta-DB, so the fleet rows a NESTED queenzee walks
// (every zee that boots the server inside its own xell — zeehive.yml gives it PROVISION_MODE=
// simulate) are the REAL fleet's rows: real container names, real worktree paths, real image tags.
// Any loop that takes one of those out of the DB and hands it to docker or the filesystem is
// therefore an injection path INTO OTHER ZEES' LIVE CAGES, needing nothing but `npm run server`.
//
// The .zeehive.env boot reconcile was the first one found and is gated (provision.js,
// test/xell-env-reconcile.test.mjs). This test fences the rest of the class, in the same shape:
// 'real' does exactly what it always did, anything else REPORTS what it would have done and
// touches nothing — never a silent skip, because "nothing to do" and "not allowed to do it" must
// not look the same in the log.
//
//   1. HARNESS RE-INJECTION (lib/harness.js) — the reported hole. refreshHarnesses() → 
//      reinjectHarnessIntoLiveXells() → `docker exec cxell_<slug>`, with the slug straight off a
//      fleet row. A zee editing a harness folder and booting the server would have written its own
//      persona files over every other zee's.
//   2. THE ATTEND-PATH BOOT SWEEP (lib/cxell.js refreshZeeLiveInLiveCxells) — same boot, same rows,
//      `docker cp` + `docker exec -u 0` into /usr/local/bin of every live cage.
//   3. TEARDOWN (queenzee/reaper.js reapXell) — the most destructive of all, and it needs no human:
//      the boot janitor finishes every inherited 'tearing-down' row, and the pool maintainer trims
//      'ready' surplus to POOL_TARGET_READY (0 in a xell) five xells a tick. The ROW still retires;
//      the worktree, cxell, containers and images are left alone.
//   4. THE IMAGE JANITOR (lib/images.js sweepOrphanSpinImages) — an hourly `docker rmi` of tags that
//      match no live xell slug. A nested queenzee's xell list is a SNAPSHOT, so every xell created
//      after the clone looks retired and its images look like orphans.
//
// HOW IT IS PROVEN: a fake `docker` on PATH that records every argv it is handed (this cage has no
// docker at all, so "it failed to exec" would prove nothing about whether it TRIED). Real mode must
// still reach for docker with the fleet's own names; simulate must not invoke it once.
process.env.PROVISION_MODE = 'simulate';        // the mode a nested queenzee runs in, before any import

import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { config } = await import('../server/src/config.js');
const { q, one, pool } = await import('../server/src/db/pool.js');
const { recentLogs } = await import('../server/src/lib/logbus.js');
const H = await import('../server/src/lib/harness.js');
const { refreshZeeLiveInLiveCxells } = await import('../server/src/lib/cxell.js');
const { reapXell } = await import('../server/src/queenzee/reaper.js');
const { sweepOrphanSpinImages } = await import('../server/src/lib/images.js');

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };

const tag = randomUUID().slice(0, 8);
const tmp = mkdtempSync(join(tmpdir(), 'nestguard-'));
const repo = join(tmp, 'repo');
const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' }).trim();
const since = () => recentLogs(500).length;
const logsSince = (n) => recentLogs(500).slice(n).map((l) => `${l.scope}: ${l.msg}`);

// ── the fake docker: records every invocation, answers the two reads the image sweep makes ──────
const bin = join(tmp, 'bin');
const DOCKER_LOG = join(tmp, 'docker.log');
mkdirSync(bin, { recursive: true });
writeFileSync(join(bin, 'docker'), `#!/bin/sh
printf '%s\\n' "$*" >> ${DOCKER_LOG}
case "$*" in
  *dangling=true*) : ;;                                    # no rebuild residue in this fixture
  *"image prune"*) echo 'Total reclaimed space: 0B' ;;     # dangling-only prune (never -a)
  *images*) echo 'zt-fakerepo-${tag}:zt-dead-${tag}' ;;   # one image, tagged with a slug nobody has
  *"ps -a"*) : ;;                                          # nothing running -> nothing protects it
esac
cat > /dev/null 2>/dev/null || true
exit 0
`, { mode: 0o755 });
process.env.PATH = `${bin}:${process.env.PATH}`;
const dockerCalls = () => (existsSync(DOCKER_LOG) ? readFileSync(DOCKER_LOG, 'utf8').split('\n').filter(Boolean) : []);
const resetDocker = () => { try { rmSync(DOCKER_LOG); } catch { /* not written yet */ } };

const REAL_ROOT = config.repoRoot;
let projId = null;
const madeXells = [];
const KEY = `zt-nest-${tag}`;

try {
  ok(dockerCalls().length === 0 && execFileSync('sh', ['-c', 'command -v docker'], { encoding: 'utf8' }).includes(bin),
     'the fake docker is first on PATH — so "did it try?" is answerable, not inferred from a missing binary');

  // ── fixtures: a project repo with one harness folder, worn by a xell with a LIVE cxell zee ────
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, 'README.md'), `nested guard fixture ${tag}\n`);
  git('init', '-q', '-b', 'master'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  git('add', '-A'); git('commit', '-qm', 'base');

  projId = (await one(`INSERT INTO project (name, repo_root, main_branch) VALUES ($1,$2,'master') RETURNING id`,
    [`zt-nest-${tag}`, repo])).id;
  const xource = await one(`INSERT INTO xource (project_id, ref) VALUES ($1,'master') RETURNING id`, [projId]);
  // DB-owned, like every harness since 080 — its text is in the row, not in a folder.
  const harness = await one(
    `INSERT INTO harness (key,label,bundle,bundle_hash,enabled,is_law_core) VALUES ($1,$1,$2,'v1',true,false) RETURNING id`,
    [KEY, JSON.stringify({ label: KEY, summary: 'fixture', zee_type: 'worker', personality: `persona v1 ${tag}` })]);

  const mkXell = async (slug, { harnessId = null, live = false, worktree = null, status = 'working' } = {}) => {
    const x = await one(
      `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status, is_pooled, harness_id)
         VALUES ($1,$2,$3,$4,$5,$6,false,$7) RETURNING id, slug`,
      [projId, xource.id, slug, `spinoff/${slug}`, worktree, status, harnessId]);
    madeXells.push(x.id);
    if (live) {
      await q(`INSERT INTO zee (xell_id, runtime_id, attach_mode, status, entrypoint, viewer_kind)
               VALUES ($1, (SELECT id FROM agent_runtime LIMIT 1), 'headless-spawn', 'working', 'cxell-cli', 'ssh-terminal')`, [x.id]);
    }
    return x;
  };
  const wearer = await mkXell(`zt-wear-${tag}`, { harnessId: harness.id, live: true });

  // ── 1. HARNESS RE-INJECTION ───────────────────────────────────────────────────────────────────
  console.log('\n── 1. a harness edit does not exec into another zee\'s cxell (PROVISION_MODE=simulate) ──');
  // The path a zee running `npm run server` in its own xell actually hits: since 080 a harness's text
  // changes by SAVE (updateHarness), and a save pushes into the live wearers. In a nested queenzee
  // those "live wearers" are the REAL fleet's zees — its db is a clone of the meta-DB.
  let n = since();
  resetDocker();
  await H.updateHarness(KEY, { personality: `persona v2 ${tag}` });
  ok(dockerCalls().length === 0, `the save execs nothing (${dockerCalls().length} docker calls recorded)`);
  ok(logsSince(n).some((m) => m.includes(wearer.slug) && /PROVISION_MODE=simulate/.test(m) && /NOT injected/i.test(m)),
     'and says so in the log, naming the live xell it left alone — a report, never a silent skip');

  // the injector on its own, now that the bundle above is populated and there really is something
  // it would have written
  resetDocker();
  const dry = await H.reinjectHarnessIntoLiveXells(harness.id);          // the DEFAULT, unasked-for path
  ok(dockerCalls().length === 0, 'and neither does the injector called directly');
  ok(dry.dry_run === true && dry.would_inject === 1 && dry.injected === 0,
     'it reports what it WOULD have injected instead of injecting it');

  // …and REAL mode is untouched: it must still reach for the cxell, by the fleet row's own name
  resetDocker();
  const live = await H.reinjectHarnessIntoLiveXells(harness.id, { mode: 'real' });
  ok(dockerCalls().some((c) => c.includes(`cxell_${wearer.slug}`)),
     `real mode still execs into the live cage (${(dockerCalls()[0] || '(nothing)').slice(0, 60)}…)`);
  ok(live.dry_run === undefined && live.xells === 1,
     'and answers with the same shape it always did (injected/failed/skipped, no dry_run)');

  // ── 2. THE ATTEND-PATH BOOT SWEEP ─────────────────────────────────────────────────────────────
  console.log('\n── 2. the boot sweep does not install files into running cages ──');
  const cages = async () => ([{ ctx: 'default', name: `cxell_${wearer.slug}` }]);
  resetDocker();
  n = since();
  const sweepDry = await refreshZeeLiveInLiveCxells(cages);
  ok(dockerCalls().length === 0, 'no docker cp, no docker exec');
  ok(sweepDry.dry_run === true && sweepDry.swept === 1 && sweepDry.ok === 0, 'it counts the cages and installs into none');
  ok(logsSince(n).some((m) => m.includes(`cxell_${wearer.slug}`) && /PROVISION_MODE=simulate/.test(m)),
     'naming the cages it would have written into');
  resetDocker();
  const sweepReal = await refreshZeeLiveInLiveCxells(cages, { mode: 'real' });
  ok(dockerCalls().some((c) => c.startsWith('cp ') && c.includes(`cxell_${wearer.slug}`)) && sweepReal.swept === 1,
     'real mode still copies the renderer + attach script in');

  // ── 3. TEARDOWN ───────────────────────────────────────────────────────────────────────────────
  // worktree_path deliberately points at nothing on disk: this test fences the DOCKER half of a
  // teardown, and must never be able to run despawn-xell.sh against a real folder.
  console.log('\n── 3. a teardown retires the ROW and tears down no machine ──');
  const doomedSlug = `zt-doom-${tag}`;
  const doomed = await mkXell(doomedSlug, { status: 'ready', worktree: join(tmp, `gone-${doomedSlug}`) });
  await q(`INSERT INTO container (project_id, role, tier, isolation, name, image_tag, docker_ctx, owner_xell_id, health)
           VALUES ($1,'db','spinoff','per-xell',$2,$3,'zt-ctx',$4,'down')`,
    [projId, `zt_db_${doomedSlug}`, `zt-fakerepo-${tag}:${doomedSlug}`, doomed.id]);
  resetDocker();
  n = since();
  const reaped = await reapXell(doomed.id, 'test-simulate');
  ok(reaped.ok === true, 'the reap still succeeds (the model must stay coherent)');
  ok(dockerCalls().length === 0, `no docker rm, no rmi (${dockerCalls().length} recorded)`);
  ok((await one(`SELECT status FROM xell WHERE id=$1`, [doomed.id])).status === 'retired',
     'the xell row is retired exactly as before — only the machines are spared');
  ok(logsSince(n).some((m) => /PROVISION_MODE=simulate/.test(m) && m.includes(`cxell_${doomedSlug}`)),
     'and it says which worktree/cxell/containers it would have removed');

  const doomed2 = await mkXell(`zt-doom2-${tag}`, { status: 'ready', worktree: join(tmp, `gone-2-${tag}`) });
  await q(`INSERT INTO container (project_id, role, tier, isolation, name, image_tag, docker_ctx, owner_xell_id, health)
           VALUES ($1,'db','spinoff','per-xell',$2,$3,'zt-ctx',$4,'down')`,
    [projId, `zt_db_${doomed2.slug}`, `zt-fakerepo-${tag}:${doomed2.slug}`, doomed2.id]);
  resetDocker();
  const reapedReal = await reapXell(doomed2.id, 'test-real', { mode: 'real' });
  ok(reapedReal.ok === true && dockerCalls().some((c) => c.includes(`cxell_${doomed2.slug}`)),
     'real mode still removes the cxell by name');
  ok(dockerCalls().some((c) => c.includes('rmi') && c.includes(doomed2.slug)),
     'and still reclaims the xell\'s images');

  // ── 4. THE IMAGE JANITOR ──────────────────────────────────────────────────────────────────────
  // The fake docker reports one image tagged zt-dead-<tag> — a slug no xell row carries, i.e.
  // exactly what a stale SNAPSHOT of the fleet makes every newer xell's image look like. Both the
  // image LIST and the in-use check come from that fake, so this can only ever "remove" the one
  // string the fixture invented, whatever fleet the runner's database describes.
  console.log('\n── 4. the image janitor deletes nothing it only THINKS is an orphan ──');
  const keeper = await mkXell(`zt-keep-${tag}`, { status: 'ready', worktree: join(tmp, `keep-${tag}`) });
  await q(`INSERT INTO container (project_id, role, tier, isolation, name, image_tag, docker_ctx, owner_xell_id, health)
           VALUES ($1,'server','spinoff','per-xell',$2,$3,'zt-ctx',$4,'down')`,
    [projId, `zt_srv_${keeper.slug}`, `zt-fakerepo-${tag}:${keeper.slug}`, keeper.id]);
  const ORPHAN = `zt-fakerepo-${tag}:zt-dead-${tag}`;
  resetDocker();
  n = since();
  const swept = await sweepOrphanSpinImages();                  // default, as the hourly tick calls it
  ok(!dockerCalls().some((c) => / rmi /.test(c)),
     `no rmi at all (docker was asked ${dockerCalls().length} read-only question(s))`);
  ok(swept.swept >= 1 && logsSince(n).some((m) => m.includes(ORPHAN) && /dry run/.test(m) && /PROVISION_MODE=simulate/.test(m)),
     'it still names the orphan it found, and why it left it');
  resetDocker();
  await sweepOrphanSpinImages({ dryRun: false });
  ok(dockerCalls().some((c) => c.includes(`rmi ${ORPHAN}`)),
     'and with the guard lifted it removes exactly the same image it reported');
  ok(!dockerCalls().some((c) => c.includes(`rmi zt-fakerepo-${tag}:${keeper.slug}`)),
     'never the image of a xell that is still alive');
} finally {
  for (const id of madeXells) await q(`DELETE FROM zee WHERE xell_id=$1`, [id]).catch(() => {});
  for (const id of madeXells) await q(`DELETE FROM container WHERE owner_xell_id=$1`, [id]).catch(() => {});
  for (const id of madeXells) await q(`DELETE FROM xell WHERE id=$1`, [id]).catch(() => {});
  if (projId) await q(`DELETE FROM container WHERE project_id=$1`, [projId]).catch(() => {});
  if (projId) await q(`DELETE FROM project WHERE id=$1`, [projId]).catch(() => {});
  await q(`DELETE FROM harness WHERE key=$1`, [KEY]).catch(() => {});
  config.repoRoot = REAL_ROOT;
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
  await pool.end().catch(() => {});
}

console.log(failures ? `\n${failures} FAILED` : '\nall good');
process.exit(failures ? 1 : 0);
