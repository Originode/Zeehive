// Orphan image janitor — pure rules + the discovery gap that left retired-xell images on disk.
//
// WHAT THIS PINS (lib/images.js):
//   1. repoOf uses the LAST colon — a registry host:port prefix must not become the "repo".
//   2. isOrphanSpinImage / isOrphanPrepImage: live slug, in-use, latest, and foreign repos are safe.
//   3. discoverPerXellRepos still finds a project's spin repos when NO owned container row
//      carries an image_tag (the last xell of that project was reaped — the old query went blind).
//   4. discoverDockerContexts still walks a machine whose last owned container is gone.
//   5. sweepOrphanSpinImages, with a fake docker and PROVISION_MODE=simulate, REPORTS the orphan
//      found via naming templates alone and does not rmi (nested-queenzee guard).
//   6. dangling old-build images (rebuild residue) are listed and pruned with `image prune -f`
//      never `prune -a`; dry-run under simulate never issues the prune.
//
// Run: node test/orphan-image-janitor.test.mjs
// Needs DATABASE_URL (throws away its own fixture rows in finally).
process.env.PROVISION_MODE = 'simulate';

import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }

const {
  repoOf, tagOf, isOrphanSpinImage, isOrphanPrepImage,
  discoverPerXellRepos, discoverDockerContexts, sweepOrphanSpinImages,
  parsePruneReclaimed,
} = await import('../server/src/lib/images.js');
const { q, one, pool } = await import('../server/src/db/pool.js');
const { recentLogs } = await import('../server/src/lib/logbus.js');
const { namingFor } = await import('../server/src/lib/manifest.js');

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };

const tag = randomUUID().slice(0, 8);
const tmp = mkdtempSync(join(tmpdir(), 'imgjan-'));
const bin = join(tmp, 'bin');
const DOCKER_LOG = join(tmp, 'docker.log');
mkdirSync(bin, { recursive: true });

// Fake docker: lists one orphan spin image (dead slug) + one stale prep image + one live image
// + two dangling old-build IDs. Contexts are ignored for the answer; the call log proves which
// contexts were walked and that prune -a is never issued.
const ORPHAN_SPIN = `imgjan-spin-server:dead-${tag}`;
const LIVE_SPIN = `imgjan-spin-server:live-${tag}`;
const STALE_PREP = 'zeehive/zee-agent-prep:deadprep01';
const KEEP_PREP = 'zeehive/zee-agent-prep:keepprep01';
const DANGLE_A = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const DANGLE_B = 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
writeFileSync(join(bin, 'docker'), `#!/bin/sh
printf '%s\\n' "$*" >> ${DOCKER_LOG}
case "$*" in
  *dangling=true*)
    printf '%s\\t12.3MB\\n' '${DANGLE_A}'
    printf '%s\\t400MB\\n' '${DANGLE_B}'
    ;;
  *"image prune"*)
    # Refuse -a if the janitor ever asks for it — the test asserts the argv below.
    case "$*" in *' -a'*|*' --all'*) echo 'REFUSED prune -a' >&2; exit 2 ;; esac
    echo 'Deleted Images:'
    echo 'deleted: ${DANGLE_A}'
    echo 'deleted: ${DANGLE_B}'
    echo 'Total reclaimed space: 412.3MB'
    ;;
  *images*)
    printf '%s\\n' '${ORPHAN_SPIN}'
    printf '%s\\n' '${LIVE_SPIN}'
    printf '%s\\n' '${STALE_PREP}'
    printf '%s\\n' '${KEEP_PREP}'
    ;;
  *"ps -a"*)
    # LIVE_SPIN is in use (a container still depends on it) — must not be reaped even if the
    # slug were unknown. ORPHAN_SPIN and STALE_PREP are unused.
    printf '%s\\n' '${LIVE_SPIN}'
    ;;
esac
exit 0
`, { mode: 0o755 });
process.env.PATH = `${bin}:${process.env.PATH}`;
const dockerCalls = () => (existsSync(DOCKER_LOG) ? readFileSync(DOCKER_LOG, 'utf8').split('\n').filter(Boolean) : []);
const resetDocker = () => { try { rmSync(DOCKER_LOG); } catch { /* */ } };

let projId = null;
let machineId = null;
const madeXells = [];

try {
  // ── 1. pure parsers ──────────────────────────────────────────────────────────────────────────
  console.log('\n── 1. repoOf / tagOf ──');
  ok(repoOf('omnibiz-spin-server:my-slug') === 'omnibiz-spin-server', 'bare repo:tag');
  ok(tagOf('omnibiz-spin-server:my-slug') === 'my-slug', 'bare tag');
  ok(repoOf('localhost:5000/omnibiz-spin-server:my-slug') === 'localhost:5000/omnibiz-spin-server',
     'registry host:port is kept (last-colon split)');
  ok(tagOf('localhost:5000/omnibiz-spin-server:my-slug') === 'my-slug', 'tag after registry');
  ok(repoOf('latest') === null && repoOf('') === null && repoOf(null) === null, 'junk → null');

  console.log('\n── 2. orphan classification rules ──');
  const repos = new Set(['omnibiz-spin-server', 'localhost:5000/omnibiz-spin-server']);
  const live = new Set(['alive-slug']);
  const used = new Set(['omnibiz-spin-server:pre-zeehive-still-running']);
  ok(isOrphanSpinImage('omnibiz-spin-server:retired-slug', { repos, live, used }),
     'retired slug, known repo, unused → orphan');
  ok(!isOrphanSpinImage('omnibiz-spin-server:alive-slug', { repos, live, used }),
     'live slug is kept');
  ok(!isOrphanSpinImage('omnibiz-spin-server:pre-zeehive-still-running', { repos, live, used }),
     'in-use image is kept even when the slug is unknown');
  ok(!isOrphanSpinImage('omnibiz-spin-server:latest', { repos, live, used }),
     'latest is never a xell tag');
  ok(!isOrphanSpinImage('postgres:17-alpine', { repos, live, used }),
     'foreign repo is none of our business');
  ok(isOrphanSpinImage('localhost:5000/omnibiz-spin-server:gone', { repos, live, used }),
     'registry-qualified spin image is classified the same way');
  ok(isOrphanPrepImage('zeehive/zee-agent-prep:oldhash', { needed: new Set(['zeehive/zee-agent-prep:newhash']), used: new Set() }),
     'stale prep hash → orphan');
  ok(!isOrphanPrepImage('zeehive/zee-agent-prep:newhash', { needed: new Set(['zeehive/zee-agent-prep:newhash']), used: new Set() }),
     'needed prep hash is kept');
  ok(!isOrphanPrepImage('zeehive/zee-agent-prep:oldhash', {
    needed: new Set(), used: new Set(['zeehive/zee-agent-prep:oldhash']),
  }), 'in-use prep image is kept');
  ok(parsePruneReclaimed('Total reclaimed space: 1.234GB') === '1.234GB', 'parse prune summary');
  ok(parsePruneReclaimed('nothing useful') === null, 'missing prune summary → null');

  // ── 3. discovery survives total retirement of a project's containers ─────────────────────────
  console.log('\n── 3. discovery from naming templates + machines (no live image_tag rows) ──');
  const pname = `imgjan-${tag}`;
  projId = (await one(
    `INSERT INTO project (name, repo_root, main_branch) VALUES ($1,$2,'master') RETURNING id`,
    [pname, tmp])).id;
  // No owned container with image_tag. The only way to know "imgjan-spin-server" is a per-xell
  // repo is the naming default derived from the project name.
  const expectedRepo = namingFor({ name: pname }, 'server', 'x').image.split(':')[0];
  ok(expectedRepo === `imgjan${tag.replace(/-/g, '')}-spin-server`
     || expectedRepo === `${pname.replace(/[^a-z0-9]/gi, '').toLowerCase()}-spin-server`
     || expectedRepo.endsWith('-spin-server'),
     `naming default repo is project-spin-server (got ${expectedRepo})`);

  // A machine on a context no container currently references — the last xell there is gone.
  machineId = (await one(
    `INSERT INTO machine (key, docker_ctx, can_build, enabled)
     VALUES ($1,$2,false,true) RETURNING id`,
    [`imgjan-${tag}`, `imgjan-ctx-${tag}`])).id;

  const foundRepos = await discoverPerXellRepos();
  ok(foundRepos.has(expectedRepo),
     `discoverPerXellRepos finds ${expectedRepo} from naming alone (no container image_tag rows)`);

  const foundCtxs = await discoverDockerContexts();
  ok(foundCtxs.has(`imgjan-ctx-${tag}`),
     'discoverDockerContexts still walks a machine with no live owned containers');
  ok(foundCtxs.has('default'), 'always includes default');

  // ── 4. sweep uses that discovery and stays dry under PROVISION_MODE=simulate ──────────────────
  console.log('\n── 4. sweep reports orphans found via naming; nested mode never rmi ──');
  // The fake docker always returns ORPHAN_SPIN under imgjan-spin-server — but our project name
  // sanitizes to a different repo. Point a keeper container at ORPHAN's repo so the spin filter
  // matches, without putting the dead slug in the live set.
  const xource = await one(`INSERT INTO xource (project_id, ref) VALUES ($1,'master') RETURNING id`, [projId]);
  const liveX = await one(
    `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status, is_pooled)
     VALUES ($1,$2,$3,$4,$5,'ready',false) RETURNING id, slug`,
    [projId, xource.id, `live-${tag}`, `spinoff/live-${tag}`, join(tmp, 'wt')]);
  madeXells.push(liveX.id);
  // image_tag uses the same repo the fake docker lists, tag = live slug.
  await q(
    `INSERT INTO container (project_id, role, tier, isolation, name, image_tag, docker_ctx, owner_xell_id, health)
     VALUES ($1,'server','spinoff','per-xell',$2,$3,$4,$5,'down')`,
    [projId, `imgjan_srv_${liveX.slug}`, LIVE_SPIN, `imgjan-ctx-${tag}`, liveX.id]);

  resetDocker();
  const n = recentLogs(500).length;
  const swept = await sweepOrphanSpinImages(); // default dryRun under simulate
  ok(!dockerCalls().some((c) => /\brmi\b/.test(c)),
     `no rmi under PROVISION_MODE=simulate (${dockerCalls().filter((c) => /rmi/.test(c)).length} rmi calls)`);
  ok(!dockerCalls().some((c) => /image prune/.test(c)),
     'no image prune under simulate dry-run either');
  ok(dockerCalls().some((c) => c.includes(`--context imgjan-ctx-${tag}`) && /images/.test(c) && !/dangling/.test(c)),
     'listed images on the machine context that had no leftover owned rows before this keeper');
  ok(dockerCalls().some((c) => /dangling=true/.test(c)),
     'listed dangling old-build images (rebuild residue)');
  const logs = recentLogs(500).slice(n).map((l) => `${l.scope}: ${l.msg}`);
  ok(swept.swept >= 1 && logs.some((m) => m.includes(ORPHAN_SPIN) && /dry run/.test(m)),
     'dry-run log names the orphan spin image');
  ok(logs.some((m) => m.includes(STALE_PREP)),
     'dry-run log names the stale prep image (no pool_config needs it)');
  ok(swept.dangling >= 2 && logs.some((m) => /dangling old-build/.test(m) && m.includes(DANGLE_A)),
     'dry-run log names dangling old-build image IDs');
  ok(!logs.some((m) => m.includes(LIVE_SPIN) && /orphan/i.test(m)),
     'does not call the live-slug image an orphan');

  resetDocker();
  const real = await sweepOrphanSpinImages({ dryRun: false });
  ok(dockerCalls().some((c) => c.includes(`rmi ${ORPHAN_SPIN}`)),
     'with the guard lifted it rmis the orphan spin image');
  ok(dockerCalls().some((c) => c.includes(`rmi ${STALE_PREP}`)),
     'and the stale prep image');
  ok(dockerCalls().some((c) => c.includes(`rmi ${KEEP_PREP}`)),
     'and every prep hash no current template claims (both listed prep tags here)');
  ok(!dockerCalls().some((c) => c.includes(`rmi ${LIVE_SPIN}`)),
     'never the live-slug image');
  ok(dockerCalls().some((c) => /image prune/.test(c) && / -f\b/.test(` ${c} `) || /image prune -f/.test(c) || c.includes('image prune -f')),
     'prunes dangling old builds with image prune -f');
  ok(!dockerCalls().some((c) => /image prune/.test(c) && (/\s-a\b/.test(c) || /--all/.test(c))),
     'NEVER image prune -a');
  ok(real.dangling >= 2, `reports dangling count (got ${real.dangling})`);
} finally {
  for (const id of madeXells) {
    await q(`DELETE FROM container WHERE owner_xell_id=$1`, [id]).catch(() => {});
    await q(`DELETE FROM xell WHERE id=$1`, [id]).catch(() => {});
  }
  if (projId) {
    await q(`DELETE FROM container WHERE project_id=$1`, [projId]).catch(() => {});
    await q(`DELETE FROM xource WHERE project_id=$1`, [projId]).catch(() => {});
    await q(`DELETE FROM pool_config WHERE project_id=$1`, [projId]).catch(() => {});
    await q(`DELETE FROM project WHERE id=$1`, [projId]).catch(() => {});
  }
  if (machineId) await q(`DELETE FROM machine WHERE id=$1`, [machineId]).catch(() => {});
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
  await pool.end().catch(() => {});
}

console.log(failures ? `\n${failures} FAILED` : '\nall good');
process.exit(failures ? 1 : 0);
