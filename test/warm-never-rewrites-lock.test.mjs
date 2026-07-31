// THE WARM MUST NOT REWRITE THE LOCKFILE THE ZEE THEN LANDS — ticket #14.
//
// `warmCxell()` ran `npm ci … || npm install …`, unconditionally, in /work/repo — the tree the zee
// lands from. `npm install` REWRITES package-lock.json, so any lock drift at dispatch handed the zee
// a dirty tree before it had done anything, and from there into an accidental lockfile change in
// somebody's landing, attributed to a zee that never touched dependencies.
//
// The same mechanism had already cost this repo once on the HOST side, and the fix there was
// commented but NOT enforced: `[ -f lock ] && npm ci || npm install` runs the `||` branch when
// EITHER part fails — including when `npm ci` itself fails. So a drifted worktree WITH a lockfile
// still ran `npm install` and re-armed the provision→build→reap loop the comment warns about.
//
// This test RUNS both scripts for real against real npm in this container — no daemon needed, since
// the scripts are the whole behaviour and `docker exec` only carries them. It proves:
//   1. the OLD idiom really does rewrite the lock on drift (the bug, reproduced, not asserted);
//   2. the NEW warm script leaves package-lock.json byte-identical and fails loudly instead;
//   3. a worktree with NO lockfile still installs — there is nothing to damage;
//   4. a healthy tree still warms;
//   5. start-xell-process.sh does the same, via its own real code path.
// What it CANNOT show: the `docker exec` hop into a live cage. That needs a docker socket, which a
// cxell does not have.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { warmInstallScript } = await import('../server/src/lib/cxell.js');

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }).trim();
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 16);
const sh = (script, cwd) => spawnSync('bash', ['-lc', script],
  { cwd, encoding: 'utf8', timeout: 300000, env: { ...process.env, npm_config_audit: 'false' } });

const tmp = mkdtempSync(join(tmpdir(), 'warm14-'));

// A repo whose package.json wants a dependency its lockfile does not carry — the exact state that
// makes `npm ci` refuse (EUSAGE, "can only install packages when your package.json and
// package-lock.json … are in sync"). No network is needed to produce it: ci fails before fetching.
function makeRepo(name, { lock = 'drift' } = {}) {
  const dir = join(tmp, name);
  mkdirSync(dir, { recursive: true });
  const deps = lock === 'drift' ? { 'left-pad': '^1.3.0' } : {};
  writeFileSync(join(dir, 'package.json'),
    JSON.stringify({ name: `zt-${name}`, version: '1.0.0', private: true, dependencies: deps }, null, 2));
  if (lock !== 'none') {
    writeFileSync(join(dir, 'package-lock.json'), JSON.stringify({
      name: `zt-${name}`, version: '1.0.0', lockfileVersion: 3, requires: true,
      packages: { '': { name: `zt-${name}`, version: '1.0.0' } },
    }, null, 2));
  }
  git(dir, 'init', '-q', '-b', 'master');
  git(dir, 'config', 'user.email', 't@t'); git(dir, 'config', 'user.name', 't');
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'base');
  return dir;
}

try {
  console.log('\n── 1. the bug, REPRODUCED: the old idiom rewrites the lock on drift ──');
  const old = makeRepo('old-idiom');
  const before = sha(join(old, 'package-lock.json'));
  // verbatim the shape both scripts used to carry
  const oldRun = sh('[ -f package-lock.json ] && npm ci --no-audit --no-fund || npm install --no-audit --no-fund', old);
  ok(oldRun.status === 0, 'the old idiom "succeeds" — the failure of npm ci is swallowed by the fallback');
  ok(sha(join(old, 'package-lock.json')) !== before,
     'and package-lock.json is REWRITTEN — this is the dirty tree a zee would land, unasked');
  ok(git(old, 'status', '--porcelain', 'package-lock.json').includes('package-lock.json'),
     'git agrees it is modified, in the tree the zee lands from');

  console.log('\n── 2. the NEW warm script: fails loudly, touches nothing ──');
  const drift = makeRepo('drift');
  const lockBefore = sha(join(drift, 'package-lock.json'));
  const run = sh(warmInstallScript('.'), drift);
  ok(run.status !== 0, `a drifted lockfile FAILS the warm (exit ${run.status}) instead of being papered over`);
  ok(/WARM_CI_FAILED/.test(run.stdout), 'with the marker that tells the queenzee WHICH failure it was');
  ok(!/WARM_OK/.test(run.stdout), 'and the warm is never reported as done');
  ok(sha(join(drift, 'package-lock.json')) === lockBefore,
     'package-lock.json is byte-identical afterwards — the whole point of the ticket');
  ok(git(drift, 'status', '--porcelain', 'package-lock.json') === '',
     'so the zee starts on a clean tree and lands nothing it did not write');
  ok(/can only install packages when your package\.json and package-lock\.json|Missing:/i.test(run.stdout + run.stderr),
     'npm\'s own explanation survives to the caller, which is what makes the failure actionable');
  ok(!/npm install/.test(warmInstallScript().replace(/nothing to rewrite|npm install \(nothing/g, '').split('else')[0]),
     'the LOCKED branch of the script contains no `npm install` at all');

  console.log('\n── 3. a worktree with NO lockfile still installs (nothing to damage) ──');
  const bare = makeRepo('nolock', { lock: 'none' });
  const bareRun = sh(warmInstallScript('.'), bare);
  ok(bareRun.status === 0 && /WARM_OK/.test(bareRun.stdout), 'it warms');
  ok(/no package-lock\.json/.test(bareRun.stdout), 'saying which branch it took, and why that is safe');
  // npm install WRITES a lockfile where there was none. That is the safe direction — it creates the
  // missing file rather than rewriting a committed one — and it is why this branch survives at all.
  ok(existsSync(join(bare, 'package-lock.json')), 'and npm install creates the lockfile that was missing (creating ≠ rewriting)');

  console.log('\n── 4. a healthy tree warms exactly as before ──');
  const good = makeRepo('good', { lock: 'match' });
  const goodRun = sh(warmInstallScript('.'), good);
  ok(goodRun.status === 0 && /WARM_OK/.test(goodRun.stdout), 'npm ci runs and the warm completes');
  ok(!/WARM_LOCK_DIRTY/.test(goodRun.stdout), 'and the post-warm check confirms the lockfile was not touched');
  ok(git(good, 'status', '--porcelain') === '' || !git(good, 'status', '--porcelain').includes('package-lock.json'),
     'git sees no lockfile change');
  ok(/npm cache:/.test(goodRun.stdout), 'the cache report from ticket #7 is still there (that behaviour is untouched)');

  console.log('\n── 5. start-xell-process.sh: the HOST twin, run for real ──');
  const script = join(ROOT, 'scripts', 'start-xell-process.sh');
  const hostDrift = makeRepo('host-drift');
  const hostBefore = sha(join(hostDrift, 'package-lock.json'));
  // MODE=real so it reaches the npm block; `true` as the start command so nothing is left running.
  const hostRun = spawnSync('bash', [script, hostDrift, 'server', '65431', 'real', 'true'],
    { encoding: 'utf8', timeout: 300000 });
  ok(sha(join(hostDrift, 'package-lock.json')) === hostBefore,
     'a drifted worktree keeps its lockfile byte-for-byte — the reap loop cannot be re-armed');
  ok(/"ok":false/.test(hostRun.stdout) && /npm-ci-failed/.test(hostRun.stdout),
     `the script reports the failure by name (${(hostRun.stdout || '').trim().split('\n').pop()})`);
  ok(/NOT falling back/.test(hostRun.stderr), 'and says out loud why it did not "fix" it by installing');

  const hostBare = makeRepo('host-nolock', { lock: 'none' });
  const hostBareRun = spawnSync('bash', [script, hostBare, 'server', '65432', 'real', 'true'],
    { encoding: 'utf8', timeout: 300000 });
  // The fixture has no server to start, so the run ends at the port wait — what matters here is that
  // it got PAST the npm block on the install branch instead of refusing.
  ok(existsSync(join(hostBare, 'package-lock.json')), 'a lockfile-less worktree still gets its install');
  ok(!/npm-ci-failed|npm-install-failed/.test(hostBareRun.stdout),
     `and is not refused at the npm step (${(hostBareRun.stdout || '').trim().split('\n').pop()})`);
  ok(/NO package-lock\.json/.test(hostBareRun.stderr), 'saying which branch it took and why it is safe');

  console.log('\n── 6. no other path installs into a tree a zee lands from ──');
  // Every `npm install` left in the server/scripts surface, with the reason it is allowed. A new
  // one that is NOT on this list fails here — which is the actual guard, since the danger is a
  // future install added to a path that touches a landed tree.
  const hits = execFileSync('bash', ['-lc',
    `grep -rn "npm install" --include=*.js --include=*.mjs --include=*.sh ${JSON.stringify(ROOT)}/server ${JSON.stringify(ROOT)}/scripts | grep -v node_modules || true`],
    { encoding: 'utf8' }).split('\n').filter(Boolean)
    .map((l) => ({ line: l, code: l.replace(/^[^:]+:\d+:/, '').trim() }))
    .filter((h) => !/^(\/\/|#|\*)/.test(h.code))                      // comments explaining the rule
    .filter((h) => !/^\+ '\/\/|^\/\/ /.test(h.code));
  const allowed = [
    { match: /npm install -g/, why: 'global CLI in an image build — no project tree involved' },
    { match: /WARM_INSTALL_FAILED/, why: 'warmInstallScript: the NO-lockfile branch (creates, never rewrites)' },
    { match: /npm install --no-audit --no-fund\) >&2/, why: 'start-xell-process.sh: the NO-lockfile branch' },
    { match: /'npm install'|`npm install`/, why: 'prose inside a message string, not a command' },
    { match: /echo "no package-lock\.json/, why: 'the echo that ANNOUNCES the no-lockfile branch' },
  ];
  const unexplained = hits.filter((h) => !allowed.some((a) => a.match.test(h.code)));
  ok(unexplained.length === 0,
     unexplained.length
       ? `an UNGUARDED npm install remains: ${unexplained[0].line}`
       : `every remaining \`npm install\` is accounted for (${hits.length}: ${allowed.map((a) => a.why).join(' | ')})`);
  ok(hits.some((h) => /WARM_INSTALL_FAILED/.test(h.code)) && hits.some((h) => /npm install --no-audit --no-fund\) >&2/.test(h.code)),
     'and both lockfile-less branches are still THERE — the fix narrows the fallback, it does not delete it');
} finally {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
}

console.log(failures ? `\n${failures} FAILED` : '\nall good');
process.exit(failures ? 1 : 0);
