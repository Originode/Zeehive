// ONE INSTALL PER WORKTREE AT A TIME — ticket #8.
//
// THE DEFECT: `zee build all` builds both roles of a xell, and for a `runner: process` project
// (Zeehive's own spinoff tier) each role spawns scripts/start-xell-process.sh against the SAME
// worktree. On a worktree with no node_modules — which is every Zeehive worktree since the spawn
// template lost its npm step (ticket #68) — both then ran `npm ci` in one directory at the same
// moment. npm ci deletes node_modules and rebuilds it, one symlink per workspace, so the second
// process reifies into the first one's half-built tree and dies on
//   EEXIST: file already exists, symlink '../../web' -> node_modules/@zeehive/web
// Live, 2026-08-04: server and webapp of one xell started 80ms apart and were both DOWN 0.9s
// later; the same build, one role at a time, came up in 13s. It read as a lockfile problem
// because the script asserted that cause for ANY npm ci failure, and only the LAST line of its
// stderr reaches the queenzee's build log.
//
// WHAT THIS FENCES, and why it is not written as a race: whether two racers collide depends on
// scheduling (measured here: ~40% of pairs), and a test that only sometimes fails is worse than
// none. So it asserts the INVARIANT the lock creates instead — a worktree is installed into ONCE,
// no matter how many roles start at once — which fails deterministically without the lock, since
// the unfixed script always ran npm ci in both processes.
//
// It runs the real script against real npm, on a synthetic workspace repo (no network, no daemon,
// no docker) — the same approach as warm-never-rewrites-lock.test.mjs, which covers the npm-ci
// versus npm-install rule in these same lines.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts', 'start-xell-process.sh');

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };
const tmp = mkdtempSync(join(tmpdir(), 'tkt8-'));
const PORTS = { server: 64811, webapp: 64812 };

// A workspace repo with NO external dependencies: `npm ci` is then offline and fast, and still
// does the thing that collided — create node_modules and a symlink per workspace. Its preinstall
// records one line per install ATTEMPT, which is what the assertions count.
function makeWorktree(name, { workspaces = 6 } = {}) {
  const dir = join(tmp, name);
  const ws = Array.from({ length: workspaces }, (_, i) => `pkg${i}`);
  mkdirSync(dir, { recursive: true });
  const trace = join(dir, 'install-trace.txt').replace(/\\/g, '/');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'tkt8', version: '1.0.0', private: true, workspaces: ws,
    // Runs inside npm ci itself, so it counts real installs and nothing else. The sleep widens the
    // window a racing pair would have to survive; the lock makes the window irrelevant.
    scripts: { preinstall: `node -e "require('fs').appendFileSync('${trace}','install\\n')" && sleep 1` },
  }, null, 2));
  const packages = { '': { name: 'tkt8', version: '1.0.0', workspaces: ws } };
  for (const w of ws) {
    mkdirSync(join(dir, w));
    writeFileSync(join(dir, w, 'package.json'), JSON.stringify({ name: `@tkt8/${w}`, version: '1.0.0' }, null, 2));
    packages[w] = { name: `@tkt8/${w}`, version: '1.0.0' };
    packages[`node_modules/@tkt8/${w}`] = { resolved: w, link: true };
  }
  writeFileSync(join(dir, 'package-lock.json'),
    JSON.stringify({ name: 'tkt8', version: '1.0.0', lockfileVersion: 3, requires: true, packages }, null, 2));
  // The "app" each role starts: it answers on its port, so the script's health wait ends in a
  // second instead of its 180s timeout, and it exits by itself so the test leaves nothing running.
  writeFileSync(join(dir, 'serve.mjs'),
    'import http from "node:http";\n'
    + 'const s = http.createServer((_q, r) => r.end("ok"));\n'
    + 's.listen(Number(process.argv[2]));\n'
    + 'setTimeout(() => process.exit(0), 60000).unref?.();\n');
  return dir;
}

const installsIn = (dir) => {
  const f = join(dir, 'install-trace.txt');
  return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).length : 0;
};

// One role start, exactly as build.js spawns it: <worktree> <role> <port> <mode> <start cmd…>
const startRole = (dir, role) => new Promise((res) => {
  const p = spawn('bash', [SCRIPT, dir, role, String(PORTS[role]), 'real', 'node', 'serve.mjs', String(PORTS[role])],
    { cwd: ROOT });
  let out = '', err = '';
  p.stdout.on('data', (d) => (out += d));
  p.stderr.on('data', (d) => (err += d));
  p.on('close', (code) => res({ code, out, err, json: JSON.parse(out.trim().split('\n').filter(Boolean).pop() || '{}') }));
});

try {
  console.log('\n── 1. both roles start at once on one worktree (what `zee build all` does) ──');
  const wt = makeWorktree('build-all');
  const [server, webapp] = await Promise.all([startRole(wt, 'server'), startRole(wt, 'webapp')]);

  ok(server.json.ok === true, `the server role comes up (${(server.out || '').trim().split('\n').pop()})`);
  ok(webapp.json.ok === true, `the webapp role comes up (${(webapp.out || '').trim().split('\n').pop()})`);
  ok(!/EEXIST/.test(server.err + webapp.err), 'neither role hit EEXIST — they did not reify the same tree');
  ok(!/npm-ci-failed/.test(server.out + webapp.out), 'and neither was reported as a lockfile failure');

  ok(installsIn(wt) === 1, `the worktree was installed into exactly ONCE (${installsIn(wt)}) — the invariant the lock exists for`);
  ok(/waiting for it \(not racing it\)|appeared while waiting/.test(server.err + webapp.err),
     'the second role SAYS it waited, instead of silently racing');
  ok(existsSync(join(wt, 'node_modules', '@tkt8', 'pkg0')) && existsSync(join(wt, 'node_modules', '@tkt8', 'pkg5')),
     'and the tree both roles now run against is complete');

  console.log('\n── 2. a worktree already installed is not installed again ──');
  const again = await startRole(wt, 'server');
  ok(again.json.ok === true, 'a later build of the same worktree still starts');
  ok(installsIn(wt) === 1, `and runs no install at all (${installsIn(wt)} total) — node_modules is present`);

  console.log('\n── 3. a FAILED install does not poison the worktree for every later build ──');
  // The guard is `[ ! -d node_modules ]`, so a half-written tree used to read as "installed" and
  // the next build started the app against it — a port that could never answer, 180s of nothing.
  const bad = makeWorktree('bad-lock');
  writeFileSync(join(bad, 'package.json'), JSON.stringify({
    name: 'tkt8', version: '1.0.0', private: true, workspaces: ['pkg0'],
    dependencies: { 'left-pad': '^1.3.0' },          // not in the lockfile → npm ci refuses, offline
  }, null, 2));
  const failed = await startRole(bad, 'server');
  ok(failed.json.ok === false && /npm-ci-failed/.test(failed.out), 'the failure is still reported by name');
  ok(/NOT falling back/.test(failed.err), 'and still says why it does not "fix" it by installing');
  ok(!/package-lock\.json disagrees/.test(failed.err),
     'without asserting a cause it does not know — npm\'s own error is what the log now carries');

  // An install that fails AFTER npm has written the tree is the case that poisoned a worktree:
  // node_modules exists, so every later build skipped the install and started the app against it.
  const half = makeWorktree('half-installed');
  const pkg = JSON.parse(readFileSync(join(half, 'package.json'), 'utf8'));
  pkg.scripts.postinstall = 'node -e "process.exit(3)"';   // fails once the tree is on disk
  writeFileSync(join(half, 'package.json'), JSON.stringify(pkg, null, 2));
  const halfRun = await startRole(half, 'server');
  ok(halfRun.json.ok === false, 'an install that dies after writing the tree is a FAILED start');
  ok(!existsSync(join(half, 'node_modules')),
     'and the half-installed tree is cleared, so the next build installs instead of starting on it');
} finally {
  for (const port of Object.values(PORTS)) spawnSync('bash', ['-lc', `fuser -k -n tcp ${port} >/dev/null 2>&1 || true`]);
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
}

console.log(failures ? `\n${failures} FAILED` : '\nall good');
process.exit(failures ? 1 : 0);
