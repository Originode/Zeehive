// A WARM THAT DIES ON LOCKFILE DRIFT MUST BE REPORTED AS LOCKFILE DRIFT — ticket #14, second half.
//
// The first half landed (test/warm-never-rewrites-lock.test.mjs): warmInstallScript() runs `npm ci`
// with no `|| npm install` fallback when a lockfile exists, so the tree the zee lands from is never
// dirtied by its own warm-up. The other half of the ticket — "when the lockfile genuinely cannot
// satisfy `npm ci`, SOMEBODY IS TOLD" — was not actually working, and the script could not show it:
// the telling happens in warmCxell(), one layer up.
//
// THE MECHANISM. The script prints its verdict on STDOUT (`WARM_CI_FAILED`, `WARM_OK`,
// `WARM_LOCK_DIRTY`, the cache line). warmCxell asked dk() for the exec WITHOUT `allowNonZero`, so a
// failing `npm ci` made dk REJECT, and dk's rejection message is `(err || out).slice(0, 400)` —
// stderr ALONE whenever the child wrote any, which npm always does. Every marker was thrown away
// before it was read, so the drift branch (`/WARM_CI_FAILED/.test(out) && npm's prose`) could never
// be true. A lock-drift warm was therefore logged as the reassuring generic line — "warm (npm/build)
// incomplete — the zee will install as needed" — and intake's own report said "warm incomplete — zee
// will install as needed [per-container npm cache — a cold download]", both of which are false: the
// lockfile is broken at this commit, the zee starts with NO node_modules, and nothing will fix it by
// installing. This is the same mistake fixed for writeFileIntoCxellIfChanged in 45d3ebe (the
// container's VERDICT outranks the exec's exit code) and for the sync merge — warmCxell was the
// third instance.
//
// HOW THIS IS DRIVEN. A cxell has no docker socket, so `docker` here is a shim on PATH that runs the
// exec'd script locally with /work/repo rewritten to a temp git repo — the REAL dk() spawn, the REAL
// stream split, the REAL npm, the REAL warmCxell parsing. What that cannot exercise: the docker hop
// itself (a live cage, container users/ownership, the shared cache VOLUME) and intake's dispatch
// path around warmCxell, which needs a queenzee. The intake half is asserted at source level below.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }).trim();
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 16);

const tmp = mkdtempSync(join(tmpdir(), 'warmreport-'));
const REAL_PATH = process.env.PATH;

// A repo whose package.json wants a dependency its lockfile does not carry — the state that makes
// `npm ci` refuse (EUSAGE), reached before any network call.
function makeRepo(name, { lock = 'drift' } = {}) {
  const dir = join(tmp, name);
  mkdirSync(dir, { recursive: true });
  const deps = lock === 'drift' ? { 'left-pad': '^1.3.0' } : {};
  writeFileSync(join(dir, 'package.json'),
    JSON.stringify({ name: `zt-${name}`, version: '1.0.0', private: true, dependencies: deps }, null, 2));
  writeFileSync(join(dir, 'package-lock.json'), JSON.stringify({
    name: `zt-${name}`, version: '1.0.0', lockfileVersion: 3, requires: true,
    packages: { '': { name: `zt-${name}`, version: '1.0.0' } },
  }, null, 2));
  git(dir, 'init', '-q', '-b', 'master');
  git(dir, 'config', 'user.email', 't@t'); git(dir, 'config', 'user.name', 't');
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'base');
  return dir;
}

try {
  // ── the shim: `docker exec <name> bash -lc <script>` → that script, here, in FAKE_WARM_REPO ──
  const bin = join(tmp, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'docker'), [
    '#!/usr/bin/env bash',
    '# stand-in for the docker CLI: run the exec\'d script locally against $FAKE_WARM_REPO.',
    'if [ "$FAKE_WARM_MODE" = nocontainer ]; then',
    '  echo "Error: No such container: $2" >&2; exit 1',
    'fi',
    'if [ "$FAKE_WARM_MODE" = oddexit ]; then',
    '  echo "npm cache: /npm-cache"; echo WARM_OK; echo "docker: connection reset" >&2; exit 1',
    'fi',
    '[ "$1" = exec ] || { echo "unexpected docker argv: $*" >&2; exit 64; }',
    'shift 2; [ "$1" = bash ] && shift; [ "$1" = -lc ] && shift',
    'script=${1//\\/work\\/repo/$FAKE_WARM_REPO}',
    'exec bash -lc "$script"',
  ].join('\n'), { mode: 0o755 });
  process.env.PATH = `${bin}:${REAL_PATH}`;
  process.env.npm_config_audit = 'false';

  const { warmCxell, warmInstallScript } = await import('../server/src/lib/cxell.js');
  const { recentLogs } = await import('../server/src/lib/logbus.js');
  const said = (from) => recentLogs(400).slice(from).filter((l) => l.scope === 'cxell').map((l) => l.msg);

  console.log('\n── 1. a lockfile `npm ci` cannot satisfy: the tree is untouched AND the failure is named ──');
  const drift = makeRepo('drift');
  process.env.FAKE_WARM_REPO = drift;
  const lockBefore = sha(join(drift, 'package-lock.json'));
  const before1 = recentLogs(400).length;
  const warm = await warmCxell({ ctx: 'default', name: 'cxell_zt_drift' });
  const logs1 = said(before1);

  ok(sha(join(drift, 'package-lock.json')) === lockBefore,
     'package-lock.json is byte-identical after the warm — the zee lands nothing it did not write');
  ok(git(drift, 'status', '--porcelain') === '', 'and git sees a completely clean tree');
  ok(warm.warmed === false, 'the warm is reported as NOT warmed');
  ok(warm.lockDrift === true,
     `the failure is CLASSIFIED as lockfile drift (got lockDrift=${JSON.stringify(warm.lockDrift)}) — `
     + 'the marker the script prints on stdout must reach the caller');
  ok(logs1.some((m) => /package-lock\.json disagrees with package\.json/.test(m) && /NOT rewritten/.test(m)),
     `and SAID so, in one line a human can act on (${JSON.stringify(logs1[logs1.length - 1] || null)})`);
  ok(!logs1.some((m) => /install as needed/.test(m)),
     'and NOT as the reassuring generic "the zee will install as needed" — there is nothing to install');
  ok(/EUSAGE|can only install packages when your package\.json and package-lock\.json/.test(String(warm.error || '')),
     'npm\'s own explanation still rides along in .error, which is what makes it diagnosable');
  ok(typeof warm.sharedCache === 'boolean',
     `the report still says WHICH npm cache the warm used (${JSON.stringify(warm.sharedCache)}) — dropping the `
     + 'field made intake print "[per-container npm cache — a cold download]" for every failed warm');

  console.log('\n── 2. a healthy lockfile still warms, and still leaves the tree clean ──');
  const good = makeRepo('good', { lock: 'match' });
  process.env.FAKE_WARM_REPO = good;
  const before2 = recentLogs(400).length;
  const okWarm = await warmCxell({ ctx: 'default', name: 'cxell_zt_good' });
  ok(okWarm.warmed === true, `npm ci runs and the warm completes (${JSON.stringify(okWarm)})`);
  ok(okWarm.lockDirty === false, 'the post-warm check confirms the lockfile was not touched');
  ok(!okWarm.lockDrift, 'and nothing is misreported as drift');
  ok(git(good, 'status', '--porcelain') === '', 'the tree is clean');
  ok(!said(before2).some((m) => /FAILED|!!!/.test(m)), 'nothing alarming is logged for a healthy warm');

  console.log('\n── 3. an exec that reports NOTHING is still an error (a cage that is not there) ──');
  process.env.FAKE_WARM_MODE = 'nocontainer';
  const before3 = recentLogs(400).length;
  const gone = await warmCxell({ ctx: 'default', name: 'cxell_zt_gone' });
  delete process.env.FAKE_WARM_MODE;
  ok(gone.warmed === false && !gone.lockDrift, 'not warmed, and not blamed on the lockfile');
  ok(/No such container/.test(String(gone.error || '')),
     `the docker failure itself is carried (${JSON.stringify(String(gone.error || '').slice(0, 60))})`);
  ok(said(before3).some((m) => /install as needed/.test(m)),
     'and THIS is the case the generic "the zee will install as needed" line belongs to');

  console.log('\n── 3b. a verdict with a non-zero exit is TRUSTED, and the disagreement is still said ──');
  // Trusting the container over its exit code must not mean hiding the mismatch — that is how the
  // same bug hid on the success path in 45d3ebe.
  process.env.FAKE_WARM_MODE = 'oddexit';
  const before3b = recentLogs(400).length;
  const odd = await warmCxell({ ctx: 'default', name: 'cxell_zt_odd' });
  delete process.env.FAKE_WARM_MODE;
  ok(odd.warmed === true, 'WARM_OK on stdout with exit 1 is still a warm (the verdict decides)');
  ok(said(before3b).some((m) => /WARM_OK but the exec exited 1/.test(m)), 'and the oddity is logged rather than swallowed');

  console.log('\n── 4. the lockfile\'s state is reported on the FAILING path too, not only the happy one ──');
  // The guarantee is "the warm never dirties the lockfile", so the check that proves it must not be
  // reachable only when the install succeeded. Assert it against the script's own text: the locked
  // branch reports lock state on both ways out.
  const script = warmInstallScript('.');
  const ciFailBranch = (script.match(/WARM_CI_FAILED[^;]*;[^;]*;/) || [''])[0];
  ok(/lockstate/.test(ciFailBranch),
     `the ci-failure branch reports the lockfile state before exiting (${JSON.stringify(ciFailBranch.trim())})`);
  ok((script.match(/lockstate/g) || []).length >= 3,
     'defined once and called on both ways out of the locked branch (no second copy of the condition)');

  console.log('\n── 5. intake tells the console the same thing warmCxell told it ──');
  const intake = readFileSync(join(ROOT, 'server/src/queenzee/intake.js'), 'utf8');
  ok(/warm\.lockDrift \?/.test(intake) && /lockfile drift/.test(intake),
     'the dispatch report keeps a distinct lock-drift branch (source assertion — intake needs a queenzee to run)');
  ok(/warm\.sharedCache \?/.test(intake), 'and still reports which npm cache the warm used');
  // …and it no longer hard-codes "warmed (deps + web build ready)". That string was printed whatever
  // ran, so a project whose template asks for NOTHING got the most reassuring line in the file after
  // 0.8s of doing nothing — seen live on 2026-08-03, when an empty template was reported as fully
  // warmed. The report now reads the STEPS the warm actually returned.
  ok(/NOTHING WAS INSTALLED/.test(intake) && /didInstall/.test(intake),
     'a spawn that installed nothing says so, instead of borrowing the happy sentence');
  ok(/reusedAll/.test(intake) && /provisioning had already installed everything/.test(intake),
     'and a spawn that reused a pre-warmed cage is its own line, not "warmed" either');
} finally {
  process.env.PATH = REAL_PATH;
  delete process.env.FAKE_WARM_REPO; delete process.env.FAKE_WARM_MODE; delete process.env.npm_config_audit;
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
}

console.log(failures ? `\n${failures} FAILED` : '\nall good');
process.exit(failures ? 1 : 0);
