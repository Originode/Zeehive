// THE SHARED PACKAGE CACHE — ticket #7, "so they dont have to install it every time".
//
// Every cxell is a fresh container with its own empty `~/.npm`, so `npm ci` in one has always been
// a full download from the registry — for every xell, of every project, every time. The fix is a
// cache that outlives the container (a docker volume for cxells, a directory beside the repos
// volume for host worktrees), plus warming a POOLED xell's worktree while it sits ready instead of
// on the zee's clock.
//
// The docker side runs through `docker exec` from the queenzee and CANNOT be observed from inside a
// cxell (no docker socket, by design). So this test asserts the two things that are assertable
// without a daemon and that carry the actual risk:
//   • the COMMANDS and CONFIG we construct — the mount, the env var, the ownership fixup, the
//     off-switch — because a wrong argv here is a fleet-wide breakage;
//   • the SAFETY RULES, which are not style: `npm ci` and never `npm install` on a pool-watched
//     worktree (install rewrites the lockfile → the pool reads a dirty worktree → it reaps the xell:
//     a live provision→build→reap loop seen 2026-07-20), and best-effort everywhere — a cold or
//     unwritable cache may never fail a provision or a dispatch.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { config } = await import('../server/src/config.js');

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };

const tmp = mkdtempSync(join(tmpdir(), 'npmcache-'));
const OLD = { vol: process.env.CXELL_NPM_CACHE_VOLUME, host: process.env.ZEEHIVE_NPM_CACHE, repos: config.reposDir };
// import fresh each time: the module reads env at call time, but reposDir comes from config
const N = await import('../server/src/lib/npm-cache.js');

try {
  console.log('\n── the cxell mount: one volume, mounted at one path, npm pointed at it ──');
  delete process.env.CXELL_NPM_CACHE_VOLUME;
  ok(N.npmCacheVolume() === 'zeehive_npm_cache', 'a default volume name, so a fleet gets this without configuring anything');
  const args = N.cxellCacheRunArgs();
  ok(args.includes('-v') && args.includes(`zeehive_npm_cache:${N.CXELL_NPM_CACHE_DIR}`),
     `the volume is mounted at ${N.CXELL_NPM_CACHE_DIR}`);
  ok(args.includes(`NPM_CONFIG_CACHE=${N.CXELL_NPM_CACHE_DIR}`),
     'and NPM_CONFIG_CACHE points there — every npm in the cage, not just the warm, uses it');

  const { cxellRunArgs } = await import('../server/src/lib/cxell.js');
  const run = cxellRunArgs({ name: 'cxell_test', net: 'zee-hive-net', port: 2222, img: 'zeehive/zee-agent', xellId: 'x' });
  ok(run[0] === 'run' && run.includes('--name') && run.includes('cxell_test'), 'the cage is still created the same way');
  ok(run.join(' ').includes(`zeehive_npm_cache:${N.CXELL_NPM_CACHE_DIR}`),
     'and ensureCxell really passes the mount (the argv is exported so this is the REAL one)');
  ok(run.includes('--cap-add') && run.includes('NET_ADMIN') && run.includes('127.0.0.1:2222:22'),
     'without disturbing the firewall capability or the loopback-only ssh publish');

  console.log('\n── ownership: a fresh named volume is root-owned, npm runs as zee ──');
  const fix = N.cxellCacheFixupCommand('cxell_test');
  ok(fix[0] === 'exec' && fix.includes('-u') && fix.includes('0'), 'the fixup runs as root');
  ok(fix.join(' ').includes(`chown zee:zee ${N.CXELL_NPM_CACHE_DIR}`), 'and chowns the mountpoint to the zee user');
  ok(!/chown -R/.test(fix.join(' ')), 'NOT recursively — a recursive chown over a big cache costs more than the cache saves');
  ok(/test -w/.test(fix.join(' ')) && /CACHE_RW/.test(fix.join(' ')),
     'and it REPORTS writability, so a read-only cache is a logline instead of a mystery npm failure');

  console.log('\n── the off-switch: a shared cache must be abandonable ──');
  for (const off of ['off', 'none', '0', 'false', '']) {
    process.env.CXELL_NPM_CACHE_VOLUME = off;
    ok(N.npmCacheVolume() === null && N.cxellCacheRunArgs().length === 0 && N.cxellCacheFixupCommand('c') === null,
       `CXELL_NPM_CACHE_VOLUME=${off || '(empty)'} → no mount at all (today's behaviour, exactly)`);
  }
  process.env.CXELL_NPM_CACHE_VOLUME = 'my_cache';
  ok(N.cxellCacheRunArgs().includes(`my_cache:${N.CXELL_NPM_CACHE_DIR}`), 'and a fleet can name its own volume');
  delete process.env.CXELL_NPM_CACHE_VOLUME;

  console.log('\n── the host side: shared only where there IS a shared place ──');
  delete process.env.ZEEHIVE_NPM_CACHE;
  config.reposDir = null;
  ok(N.hostNpmCacheDir() === null, 'no repos volume (the host era) → npm keeps its own default, unchanged');
  ok(N.npmCacheEnv({ PATH: 'x' }).NPM_CONFIG_CACHE === undefined, 'and the spawned env is untouched');
  config.reposDir = tmp;
  ok(N.hostNpmCacheDir() === join(tmp, '.npm-cache').replace(/\\/g, '/'),
     'with a repos volume the cache sits beside it — shared by every PROJECT, not per project');
  const env = N.npmCacheEnv({ PATH: 'x' });
  ok(env.NPM_CONFIG_CACHE === N.hostNpmCacheDir() && env.PATH === 'x', 'the env is merged, never replaced');
  ok(existsSync(N.hostNpmCacheDir()), 'and the directory is created on demand');
  process.env.ZEEHIVE_NPM_CACHE = 'off';
  ok(N.hostNpmCacheDir() === null, 'ZEEHIVE_NPM_CACHE=off opts a host out too');
  process.env.ZEEHIVE_NPM_CACHE = join(tmp, 'elsewhere');
  ok(N.hostNpmCacheDir() === join(tmp, 'elsewhere'), 'and an explicit path wins over the default');
  delete process.env.ZEEHIVE_NPM_CACHE;

  console.log('\n── `npm ci`, NEVER `npm install`, on a worktree the pool watches ──');
  ok(N.WARM_ARGS[0] === 'ci' && !N.WARM_ARGS.includes('install'),
     `the warm runs \`npm ${N.WARM_ARGS.join(' ')}\` — install rewrites the lock and the pool reaps a dirty worktree`);
  const wt = join(tmp, 'wt');
  mkdirSync(wt, { recursive: true });
  ok(N.warmableWorktree(join(tmp, 'nope')).warmable === false, 'a worktree that does not exist is not warmed');
  ok(N.warmableWorktree(wt).warmable === false, 'nor one with no package.json');
  writeFileSync(join(wt, 'package.json'), '{"name":"t","private":true}');
  const noLock = N.warmableWorktree(wt);
  ok(noLock.warmable === false && /npm install.*rewrite|rewrite.*lock/i.test(noLock.reason),
     `a worktree with NO lockfile is SKIPPED, and the reason says why: "${noLock.reason}"`);
  writeFileSync(join(wt, 'package-lock.json'), '{"lockfileVersion":3}');
  ok(N.warmableWorktree(wt).warmable === true, 'with a lockfile it is warmable');
  mkdirSync(join(wt, 'node_modules'));
  ok(N.warmableWorktree(wt).warmable === false, 'and already-installed is a no-op, not a reinstall');

  console.log('\n── best-effort: a skip resolves, it never throws ──');
  const skipped = await N.warmWorktree(join(tmp, 'does-not-exist'), { slug: 'zt' });
  ok(skipped.warmed === false && skipped.skipped === true, 'warming a missing worktree RESOLVES (a provision must not die of it)');
  const notNode = await N.warmWorktree(tmp, { slug: 'zt' });
  ok(notNode.warmed === false && !('error' in notNode), 'and a non-node worktree is a quiet skip, not an error');

  console.log('\n── it is wired into the paths that actually pay the cost ──');
  const { readFileSync } = await import('node:fs');
  const provision = readFileSync('server/src/lib/provision.js', 'utf8');
  ok(/warmWorktree\(worktree, \{ slug \}\)/.test(provision), 'provisionXell warms the worktree');
  ok(/warmWorktree\([^)]*\)\.catch\(/.test(provision), 'NOT awaited and .catch()ed — provisioning never waits for npm, and never dies of it');
  const build = readFileSync('server/src/lib/build.js', 'utf8');
  ok(/npmCacheEnv\(cleanGitEnv\(\)\)/.test(build), 'the process-role starter inherits the shared cache (no change to the script itself)');
  const dockerfile = readFileSync('docker/zeehive/Dockerfile.zee-agent', 'utf8');
  ok(/mkdir -p \/npm-cache && chown zee:zee \/npm-cache/.test(dockerfile),
     'the image carries the mountpoint owned by zee, so a fresh volume inherits that ownership');
  ok(!/COPY .*node_modules|npm ci --workspace/.test(dockerfile),
     'and no project node_modules are baked into the shared agent image (it would go stale per project)');
} finally {
  if (OLD.vol === undefined) delete process.env.CXELL_NPM_CACHE_VOLUME; else process.env.CXELL_NPM_CACHE_VOLUME = OLD.vol;
  if (OLD.host === undefined) delete process.env.ZEEHIVE_NPM_CACHE; else process.env.ZEEHIVE_NPM_CACHE = OLD.host;
  config.reposDir = OLD.repos;
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
}

console.log(failures ? `\n${failures} FAILED` : '\nall good');
process.exit(failures ? 1 : 0);
