// THE VERDICT CONTRACT — one door for every cxell exec that states its own outcome, and a guard that
// fires on the MISTAKE rather than on the site.
//
// Three separate callers in server/src/lib/cxell.js lost the same value on the same day, each found in
// production by a different zee, all three the same shape: the script inside the cage prints what it
// DID on stdout, and the caller decided from something else instead —
//
//   • 45d3ebe  writeFileIntoCxellIfChanged — dk() rejected on the non-zero exit BEFORE the verdict was
//              read, so the healthy no-op SAME was stamped as env_cxell_error on every unchanged xell;
//   • 7339182  writeGeneratedDocIntoCxell — read `String(result)` where dk resolves { code, out, err },
//              so the verdict was the literal '[object Object]' and every written doc reported skipped;
//   • 28fa29f  warmCxell — read dk()'s REJECTION MESSAGE, which was `(err || out)` = stderr alone
//              whenever the child wrote any (npm always does), so the WARM_CI_FAILED marker sitting on
//              stdout never reached the classifier and lock drift was reported as a network hiccup.
//
// The guard then found the same shape twice more, which is the point of writing it: the npm-cache fixup
// in ensureCxell (sibling #4, warning falsely off a rejection), and syncCxellWithXource's SYNC MERGE —
// #5 and the worst of them, because that verdict decides whether the queenzee runs `git merge --abort`
// inside a live cage. It classified from dk's rejection message, so a conflict whose text the message
// truncated read as operational, and the operational branch deleted a caged zee's in-progress conflict
// resolution (working tree + index, nothing committed, no way back).
//
// …and then it caught a #6 the cheap way, before it could cost anything: the fleet PAUSE's interrupt
// arrived with no row here, and the count assertion at the bottom of this file is what said so.
//
// What this file pins is therefore the CONTRACT, not three fixes:
//   1. dkVerdict — never lets the exit code decide, always reads stdout, hands back a STRING verdict,
//      rejects only when the exec never ran, and says the oddity out loud when a verdict arrives with
//      a non-zero exit;
//   2. dk's rejection carries BOTH streams and the raw { code, out, err } on `err.dk`, so a verdict
//      can no longer be destroyed by the way a failure is reported;
//   3. EVERY marker-based caller, driven for real, still decides from the verdict when the exec exits
//      NON-ZERO with a valid verdict on stdout and noise on stderr — the exact production shape;
//   4. and the structural guard: every marker any cage script prints must be DECLARED at the exec that
//      runs it, `allowNonZero` no longer exists (dkVerdict is the only way to survive a non-zero
//      exit), nobody hand-rolls verdict parsing, and the guard table below must cover every declared
//      marker set — so a NEW marker-based exec cannot be added without a row here.
//
// HOW IT IS DRIVEN. dk() spawns `docker` off PATH, so a shim on PATH is the REAL code path: real
// spawn, real stream split, real stdin pipe, real parse. WHAT THIS CANNOT EXERCISE: the docker hop
// itself — a live container, the exec'd script actually running in a cage, container users/ownership.
// A cxell has no docker socket, so that half is unexercised here by construction (the same limit the
// three commits above worked under; 45d3ebe verified the script half by hand in a real container).
// Everything it creates lives in one temp dir, deleted in a finally.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) fail++; };

const tmp = mkdtempSync(join(tmpdir(), 'dkverdict-'));
const REAL_PATH = process.env.PATH;

// The shim: says exactly what the test tells it to say, on the streams the test names, with the exit
// code the test names. Nothing else — the point is what the CALLER does with an answer.
const bin = join(tmp, 'bin');
mkdirSync(bin, { recursive: true });
writeFileSync(join(bin, 'docker'), [
  '#!/usr/bin/env bash',
  '# stand-in for the docker CLI (see the header of dk-verdict-contract.test.mjs)',
  'if [ "$1" = "--context" ]; then shift 2; fi',
  // Only an EXEC gets the answer under test. Everything else (network create, run, rm) succeeds
  // quietly, so a caller that does other docker work on the way to its exec still gets there.
  'if [ "$1" != "exec" ]; then exit 0; fi',
  // A caller that runs SEVERAL execs on the way to the one under test (syncCxellWithXource: fetch the
  // delivered bundle, ask whether main is already an ancestor, then MERGE) needs the scripted answer
  // to reach only its verdict exec. With FAKE_ONLY_MERGE set, everything else succeeds silently and
  // the ancestor check refuses, so the caller actually reaches its merge.
  'if [ -n "$FAKE_ONLY_MERGE" ]; then',
  '  case "$*" in',
  '    *"merge --no-edit"*) : ;;',
  '    *"merge-base --is-ancestor"*) exit 1 ;;',
  '    *) exit 0 ;;',
  '  esac',
  'fi',
  'if [ ! -t 0 ]; then cat > /dev/null; fi',      // drain the piped payload like a real exec does
  'if [ -n "$FAKE_STDERR" ]; then printf "%s\\n" "$FAKE_STDERR" >&2; fi',
  'if [ -n "$FAKE_STDOUT" ]; then printf "%s\\n" "$FAKE_STDOUT"; fi',
  'exit "${FAKE_CODE:-0}"',
].join('\n'), { mode: 0o755 });

const say = ({ out = '', err = '', code = 0 }) => {
  process.env.FAKE_STDOUT = out; process.env.FAKE_STDERR = err; process.env.FAKE_CODE = String(code);
};

try {
  process.env.PATH = `${bin}:${REAL_PATH}`;
  const C = await import('../server/src/lib/cxell.js');
  const RT = await import('../server/src/lib/cxell-runtimes.js');
  const { recentLogs } = await import('../server/src/lib/logbus.js');
  const SP = await import('../server/src/lib/spawn-prep.js');
  // cloneIntoCxell bundles a REAL git branch before it touches docker, so its row needs a real
  // worktree — the shim only stands in for the docker half.
  const CLONE_WT = join(tmp, 'clone-wt');
  mkdirSync(CLONE_WT, { recursive: true });
  for (const args of [['init', '-q', '-b', 'zt-branch'], ['config', 'user.email', 't@t'], ['config', 'user.name', 't']]) {
    execFileSync('git', ['-C', CLONE_WT, ...args], { encoding: 'utf8' });
  }
  writeFileSync(join(CLONE_WT, 'f.txt'), 'x\n');
  execFileSync('git', ['-C', CLONE_WT, 'add', '-A'], { encoding: 'utf8' });
  execFileSync('git', ['-C', CLONE_WT, 'commit', '-qm', 'base'], { encoding: 'utf8' });
  // A project whose SPAWN TEMPLATE installs a package — the only shape that makes prepRootCxell run
  // an exec at all (a default template asks for nothing as root, so the site is a no-op).
  const APT_PREP = SP.normalizeSpawnPrep({ steps: [{ key: 'psql', kind: 'apt', packages: ['postgresql-client'] }] });
  const since = () => recentLogs(400).length;
  const linesSince = (n) => recentLogs(400).slice(n).map((l) => l.msg || String(l));
  const src = readFileSync(join(ROOT, 'server/src/lib/cxell.js'), 'utf8');
  // …and the same source with its own COMMENTS stripped. This file's subject matter is a set of bug
  // SIGNATURES, and cxell.js quotes several of them verbatim in the comments explaining why the shape
  // changed ("read `String(await dk(...))`", "the message used to be `(err || out)`"). A naive grep for
  // the mistake therefore finds the EXPLANATION of the mistake, so the structural checks read code.
  const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  // A real (tiny) xource repo: the sync row's caller BUNDLES from it with real git before it ever gets
  // to its exec, and refuses outright if the worktree is not on disk.
  const XOURCE = join(tmp, 'xource');
  mkdirSync(XOURCE, { recursive: true });
  const rungit = (...a) => execFileSync('git', ['-C', XOURCE, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' });
  rungit('init', '-q', '-b', 'master');
  writeFileSync(join(XOURCE, 'f.txt'), 'base\n');
  rungit('add', '-A'); rungit('commit', '-qm', 'base');

  // ── 1. THE GUARD TABLE — every marker-based caller decides from the VERDICT ────────────────────
  //
  // One row per call site, all driven the same way: exit 1, a VALID verdict on stdout, and noise on
  // stderr. That is production's own shape (45d3ebe) plus the stderr that hid the marker (28fa29f).
  // A caller that consults the exit code, or the rejection message, or stringifies dk's result, fails
  // its row. It cannot be passed by accident: §4 asserts this table covers every marker set declared
  // in cxell.js, so a NEW marker-based exec without a row here fails the suite.
  const SITES = [
    {
      name: 'writeFileIntoCxellIfChanged',
      markers: ['SAME', 'WROTE'],
      cases: [
        { what: 'SAME + exit 1 is the healthy NO-OP (the prod defect, byte for byte)',
          out: 'SAME', err: 'docker: connection reset', code: 1,
          run: () => C.writeFileIntoCxellIfChanged({ slug: 'zt-v', relPath: '.zeehive.env', text: 'A=1\n' }),
          want: (r) => r?.changed === false && r?.exit_code === 1 },
        { what: 'WROTE + exit 1 is still a write',
          out: 'WROTE', err: 'docker: connection reset', code: 1,
          run: () => C.writeFileIntoCxellIfChanged({ slug: 'zt-v', relPath: '.zeehive.env', text: 'A=1\n' }),
          want: (r) => r?.changed === true },
        { what: 'and NO verdict is still the one real failure, naming the exit code and both streams',
          out: '', err: 'No such container: cxell_zt-v', code: 1,
          run: () => C.writeFileIntoCxellIfChanged({ slug: 'zt-v', relPath: '.zeehive.env', text: 'A=1\n' }),
          want: (e) => e instanceof Error && /did not report/.test(e.message) && /exit 1/.test(e.message)
                       && /No such container/.test(e.message) },
      ],
    },
    {
      name: 'writeGeneratedDocIntoCxell',
      markers: ['WROTE', 'TRACKED'],
      cases: [
        { what: 'WROTE + exit 1 is a write (this site used to THROW here — the fourth instance)',
          out: 'WROTE', err: 'docker: connection reset', code: 1,
          run: () => C.writeGeneratedDocIntoCxell({ slug: 'zt-v', relPath: 'AGENTS.md', text: 'body\n' }),
          want: (r) => r?.written === true && r?.rel === 'AGENTS.md' },
        { what: 'TRACKED + exit 1 still leaves the project\'s own committed file alone',
          out: 'TRACKED', err: 'docker: connection reset', code: 1,
          run: () => C.writeGeneratedDocIntoCxell({ slug: 'zt-v', relPath: 'AGENTS.md', text: 'body\n' }),
          want: (r) => r?.written === false && r?.skipped === 'tracked' },
        { what: 'a failed exec that says NOTHING still rejects (unchanged policy for this site)',
          out: '', err: 'No such container: cxell_zt-v', code: 1,
          run: () => C.writeGeneratedDocIntoCxell({ slug: 'zt-v', relPath: 'AGENTS.md', text: 'body\n' }),
          want: (e) => e instanceof Error && /exited 1/.test(e.message) && /No such container/.test(e.message) },
        { what: 'and an UNREADABLE answer on a clean exit is loud, not a silent skip',
          out: '[object Object]', err: '', code: 0,
          run: () => C.writeGeneratedDocIntoCxell({ slug: 'zt-v', relPath: 'AGENTS.md', text: 'body\n' }),
          want: (r) => r?.written === false && r?.skipped === 'unknown'
                       && /object Object/.test(r?.reason || '') },
      ],
    },
    {
      // THE CREDENTIAL-INJECTION ENGINE'S /etc/environment WRITE (lib/credential-inject.js). Its
      // verdict decides whether a human-approved key rotation reached a live cage: a cage that cannot
      // say it wrote the file did NOT get the new key, and the receipt must say so. Same shape as its
      // sibling writeFileIntoCxellIfChanged — WROTE wins over a non-zero exit, and silence is a FAILED
      // write, never an assumed one.
      name: 'writeCxellEnvironment (credential injection)',
      markers: ['WROTE'],
      cases: [
        { what: 'WROTE + exit 1 + stderr noise is a written environment (the verdict, not the exit code)',
          out: 'WROTE', err: 'docker: connection reset', code: 1,
          run: () => C.writeCxellEnvironment({ ctx: 'default', slug: 'zt-v', text: 'A=1\n' }),
          want: (r) => r?.ok === true && r?.path === '/etc/environment' },
        { what: 'an unrecognised answer is NOT a write, however the exec exited',
          out: 'something unexpected', err: '', code: 0,
          run: () => C.writeCxellEnvironment({ ctx: 'default', slug: 'zt-v', text: 'A=1\n' }),
          want: (r) => r?.ok === false && r?.path === '/etc/environment' },
        { what: 'and NO verdict is a failed write — silence never means the key landed',
          out: '', err: 'No such container: cxell_zt-v', code: 1,
          run: () => C.writeCxellEnvironment({ ctx: 'default', slug: 'zt-v', text: 'A=1\n' }),
          want: (r) => r?.ok === false && r?.path === '/etc/environment' },
      ],
    },
    {
      name: 'warmCxell',
      markers: C.WARM_MARKERS,
      cases: [
        { what: 'WARM_OK + exit 1 is still a warm',
          out: 'npm cache: /tmp/x\nWARM_OK', err: 'npm warn something', code: 1,
          run: () => C.warmCxell({ ctx: 'default', name: 'cxell_zt-v' }),
          want: (r) => r?.warmed === true },
        { what: 'WARM_CI_FAILED + npm\'s EUSAGE prose ON STDERR is classified as LOCK DRIFT',
          out: 'WARM_CI_FAILED', code: 1,
          err: 'npm error code EUSAGE\nnpm error `npm ci` can only install packages when your package.json and package-lock.json are in sync',
          run: () => C.warmCxell({ ctx: 'default', name: 'cxell_zt-v' }),
          want: (r) => r?.warmed === false && r?.lockDrift === true },
        { what: 'WARM_LOCK_DIRTY rides alongside the decisive marker (the SET is read, not the last line)',
          out: 'WARM_CI_FAILED\nWARM_LOCK_DIRTY', err: 'npm error code EUSAGE', code: 1,
          run: () => C.warmCxell({ ctx: 'default', name: 'cxell_zt-v' }),
          want: (r) => r?.lockDirty === true && r?.lockDrift === true },
        { what: 'and an exec that reports NOTHING is not warmed and not blamed on the lockfile',
          out: '', err: 'No such container: cxell_zt-v', code: 1,
          run: () => C.warmCxell({ ctx: 'default', name: 'cxell_zt-v' }),
          want: (r) => r?.warmed === false && !r?.lockDrift && /No such container/.test(String(r?.error || '')) },
      ],
    },
    {
      // THE TURN-BOUNDARY HOOKS (installTurnHooksIntoCxell). This site landed on main WITHOUT a row
      // here, which the count assertion at the bottom caught: 10 dkVerdict call sites, 9 rows. That
      // is the guard doing exactly its job — a new marker-based exec cannot be added without saying
      // how it reads its verdict — so the row is written here rather than the count relaxed.
      // Its shape is the same as the auth/seed pair it sits beside: a cage that cannot say it
      // installed the hooks did NOT install them, whatever the exit code was.
      name: 'installTurnHooksIntoCxell',
      markers: RT.TURN_HOOK_MARKERS,
      cases: [
        { what: 'TURNHOOK_OK + exit 1 + stderr noise is installed (the verdict, not the exit code)',
          out: 'TURNHOOK_OK', err: 'docker: connection reset', code: 1,
          run: () => C.installTurnHooksIntoCxell({ ctx: 'default', name: 'cxell_zt-v',
                                                   adapter: RT.adapterFor('claude-code-cxell') }),
          want: (r) => r?.ok === true && r?.verdict === 'TURNHOOK_OK' },
        { what: 'TURNHOOK_FAILED + exit 0 is still a failure, carrying what the cage said',
          out: 'could not write the hook\nTURNHOOK_FAILED', err: '', code: 0,
          run: () => C.installTurnHooksIntoCxell({ ctx: 'default', name: 'cxell_zt-v',
                                                   adapter: RT.adapterFor('claude-code-cxell') }),
          want: (r) => r?.ok === false && r?.verdict === 'TURNHOOK_FAILED' && /could not write/.test(String(r?.said)) },
        { what: 'and NO verdict is a failure that says what docker said, not a shrug',
          out: '', err: 'No such container: cxell_zt-v', code: 1,
          run: () => C.installTurnHooksIntoCxell({ ctx: 'default', name: 'cxell_zt-v',
                                                   adapter: RT.adapterFor('claude-code-cxell') }),
          want: (r) => r?.ok === false && !r?.verdict && /No such container/.test(String(r?.said)) },
      ],
    },
    {
      // CLONE INTO THE CAGE — and since the pre-warmed cage landed, it has TWO paths: a fresh clone,
      // or a fetch+reset onto a checkout that is already there (which is what preserves the
      // node_modules provisioning installed). Everything downstream assumes /work/repo is a
      // checkout, so "no verdict" here must THROW rather than hand a zee half a repository — the one
      // site in this table where the strict direction is the safe one.
      name: 'cloneIntoCxell',
      markers: C.CLONE_MARKERS,
      cases: [
        { what: 'CLONE_UPDATED + exit 1 is still an updated checkout (the verdict, not the exit code)',
          out: 'CLONE_UPDATED', err: 'docker: connection reset', code: 1,
          run: () => C.cloneIntoCxell({ ctx: 'default', name: 'cxell_zt-v', worktree: CLONE_WT }),
          want: (r, logs) => logs.some((m) => /updated the existing checkout in place/.test(m)) },
        { what: 'CLONE_FRESH is the ordinary path and says nothing extra',
          out: 'CLONE_FRESH', err: '', code: 0,
          run: () => C.cloneIntoCxell({ ctx: 'default', name: 'cxell_zt-v', worktree: CLONE_WT }),
          want: (r, logs) => !logs.some((m) => /updated the existing checkout/.test(m)) },
        { what: 'and NO verdict THROWS — a half-cloned cage must never be handed to a zee',
          out: '', err: 'No such container: cxell_zt-v', code: 1,
          run: () => C.cloneIntoCxell({ ctx: 'default', name: 'cxell_zt-v', worktree: CLONE_WT }),
          want: (e) => e instanceof Error && /reported nothing/.test(e.message) && /No such container/.test(e.message) },
      ],
    },
    {
      // THE SPAWN TEMPLATE'S ROOT PREP (migration 121) — apt packages installed into a fresh cage
      // before the zee starts. It is best-effort BY POLICY (a missing package is a slower zee, never
      // a failed dispatch), and that is exactly the shape in which a misread verdict hides: nothing
      // downstream fails, the cage simply comes up without the tool a human asked for and the log
      // says the opposite. Hence a row.
      name: 'prepRootCxell (spawn template, root half)',
      markers: ['PREP_ROOT_DONE'],
      cases: [
        { what: 'PREP_ROOT_DONE + exit 1 is a prep that RAN (the verdict, not the exit code)',
          out: 'PREP_STEP psql ok 4\nPREP_ROOT_DONE', err: 'docker: connection reset', code: 1,
          run: () => C.prepRootCxell({ ctx: 'default', name: 'cxell_zt-v', prep: APT_PREP }),
          want: (r) => r?.ran === true && r?.ok === true && r?.steps?.[0]?.key === 'psql' && r.steps[0].ok === true },
        { what: 'a step that did NOT install is named in the log, and the dispatch still goes on',
          out: 'PREP_STEP psql failed 9\nPREP_ROOT_DONE', err: '', code: 0,
          run: () => C.prepRootCxell({ ctx: 'default', name: 'cxell_zt-v', prep: APT_PREP }),
          want: (r, logs) => r?.ran === true && r?.steps?.[0]?.ok === false
                             && logs.some((m) => /prep step\(s\) FAILED/.test(m) && /psql/.test(m)) },
        { what: 'and an exec that reports NOTHING is still not a failed dispatch (best-effort, rule 1)',
          out: '', err: 'No such container: cxell_zt-v', code: 1,
          run: () => C.prepRootCxell({ ctx: 'default', name: 'cxell_zt-v', prep: APT_PREP }),
          want: (r) => r?.ran === true && r?.ok === false && /No such container/.test(String(r?.error || '')) },
      ],
    },
    {
      // The npm-cache fixup in ensureCxell — the sibling this file found. It has no return value: the
      // cage's answer is only ever a WARNING, which is exactly why nobody noticed it was reading the
      // marker out of a rejection and warning falsely.
      name: 'ensureCxell (npm cache fixup)',
      markers: ['CACHE_RW', 'CACHE_RO'],
      cases: [
        { what: 'CACHE_RW + exit 1 is a WRITABLE cache — no false "NOT writable" warning',
          out: 'CACHE_RW', err: 'docker: connection reset', code: 1,
          run: () => C.ensureCxell({ ctx: 'default', slug: 'zt-v', xellId: null }),
          want: (r, logs) => r?.name === 'cxell_zt-v' && !logs.some((m) => /NOT writable/.test(m)) },
        { what: 'CACHE_RO is still warned about, quoting what the cage said',
          out: 'CACHE_RO', err: '', code: 0,
          run: () => C.ensureCxell({ ctx: 'default', slug: 'zt-v', xellId: null }),
          want: (r, logs) => logs.some((m) => /NOT writable/.test(m) && /CACHE_RO/.test(m)) },
        { what: 'and an exec that says nothing is warned about too, quoting docker',
          out: '', err: 'No such container: cxell_zt-v', code: 1,
          run: () => C.ensureCxell({ ctx: 'default', slug: 'zt-v', xellId: null }),
          want: (r, logs) => logs.some((m) => /NOT writable/.test(m) && /No such container/.test(m)) },
      ],
    },
    {
      // The fleet PAUSE's interrupt (lib/fleet-pause.js / queenzee/pause.js). Its verdict decides
      // whether a HUMAN is told something is wrong, and both directions are expensive: read a stuck run
      // as stopped and an operator believes the fleet is still while a zee keeps writing; read a stopped
      // one as unconfirmed and every pause cries wolf until nobody reads the warning. Note the exit code
      // is genuinely uninformative here — pkill and pgrep both exit non-zero for ordinary states — so
      // this site is the clearest case in the file for the rule.
      name: 'interruptCxellZee (fleet pause)',
      markers: C.INTERRUPT_MARKERS,
      cases: [
        { what: 'SIGINT + exit 1 + stderr noise is a STOPPED zee (the verdict, not the exit code)',
          out: '__ZEE_INT_SIGINT__', err: 'docker: connection reset', code: 1,
          run: () => C.interruptCxellZee({ slug: 'zt-v', graceMs: 500 }),
          want: (r) => r?.stopped === true && r?.idle === false && r?.how === 'sigint' },
        { what: 'IDLE is a success, and says there was no turn to stop',
          out: '__ZEE_INT_IDLE__', err: '', code: 0,
          run: () => C.interruptCxellZee({ slug: 'zt-v', graceMs: 500 }),
          want: (r) => r?.stopped === true && r?.idle === true && !r?.how },
        { what: 'STUCK is NOT a stop, however the exec exited — a zee still working must be reportable',
          out: '__ZEE_INT_STUCK__', err: '', code: 0,
          run: () => C.interruptCxellZee({ slug: 'zt-v', graceMs: 500 }),
          want: (r) => r?.stopped === false && r?.how === 'stuck' },
        { what: 'a cage the daemon says is GONE counts with idle (there is provably no turn in it)',
          out: '', err: 'Error response from daemon: No such container: cxell_zt-v', code: 1,
          run: () => C.interruptCxellZee({ slug: 'zt-v', graceMs: 500 }),
          want: (r) => r?.stopped === true && r?.idle === true && r?.gone === true },
        { what: 'and any OTHER answer with no verdict throws rather than claiming a stop',
          out: '', err: 'something nobody has seen before', code: 1,
          run: () => C.interruptCxellZee({ slug: 'zt-v', graceMs: 500 }),
          want: (e) => e instanceof Error && /no verdict/.test(e.message) && /exit 1/.test(e.message)
                       && /nobody has seen/.test(e.message) },
      ],
    },
    {
      // THE SYNC MERGE — the fifth site, and the one this table caught. It is the highest-stakes of them
      // all: its verdict decides whether the queenzee runs `git merge --abort` inside a live cage, so a
      // verdict lost here is not a wrong log line, it is a caged zee's half-finished conflict resolution
      // deleted (working tree + index, nothing committed, no way back). It used to classify from dk's
      // REJECTION MESSAGE — two streams capped at 400 chars each — and was correct only by accident.
      // Driven end to end against real git, with every abort recorded, in
      // test/cxell-sync-abort-safety.test.mjs; the rows here pin the rule this table pins for every
      // other site, plus the one policy that is this site's own: an outcome it cannot read means the
      // tree is not touched ('unknown'), never 'error'.
      name: 'syncCxellWithXource (the sync merge)',
      markers: ['MERGE_OK', 'MERGE_CONFLICT', 'MERGE_STOPPED', 'MERGE_FAILED', 'MERGE_HELD'],
      onlyMerge: true,
      cases: [
        { what: 'MERGE_CONFLICT + exit 1 is the zee\'s conflict, left in progress',
          out: 'CONFLICT (content): Merge conflict in shared.txt\nMERGE_CONFLICT', err: 'docker: connection reset', code: 1,
          run: () => C.syncCxellWithXource({ ctx: 'default', slug: 'zt-v', worktree: XOURCE, ref: 'master' }),
          want: (r) => r?.state === 'conflict' && r?.held === false },
        { what: 'MERGE_HELD + exit 1 means a merge was ALREADY in progress — the sync touched nothing',
          out: 'a merge was already in progress in this cxell — left untouched:\nMERGE_HELD', err: 'docker: connection reset', code: 1,
          run: () => C.syncCxellWithXource({ ctx: 'default', slug: 'zt-v', worktree: XOURCE, ref: 'master' }),
          want: (r) => r?.state === 'conflict' && r?.held === true },
        { what: 'MERGE_OK + exit 1 is still a merge',
          out: 'Merge made by the ort strategy.\nMERGE_OK', err: 'docker: connection reset', code: 1,
          run: () => C.syncCxellWithXource({ ctx: 'default', slug: 'zt-v', worktree: XOURCE, ref: 'master' }),
          want: (r) => r?.state === 'merged' },
        { what: 'and NO verdict is \'unknown\' — NOT \'error\', because an error would license the abort',
          out: '', err: 'Error response from daemon: cannot exec in a stopped container', code: 1,
          run: () => C.syncCxellWithXource({ ctx: 'default', slug: 'zt-v', worktree: XOURCE, ref: 'master' }),
          want: (r) => r?.state === 'unknown' && /stopped container/.test(String(r?.output || '')) },
      ],
    },
    {
      // INSTALLING THE DISPATCHED PROVIDER'S CREDENTIAL (lib/cxell.js prepareCxellAuth) — the site
      // that exists because `codex exec` authenticates from ~/.codex/auth.json, not from
      // OPENAI_API_KEY, and a cage without it 401s on every turn with a message that reads like a
      // bad key. Its verdict is a gate: spawnCxell REFUSES the dispatch on a failure, so reading it
      // from the exit code would either strand good dispatches or start zees that cannot
      // authenticate. `codex login` exits non-zero on some of its own error paths while still
      // printing the verdict, which is this table's whole shape.
      name: 'prepareCxellAuth (the provider credential install)',
      markers: RT.AUTH_MARKERS,
      cases: [
        { what: 'AUTH_OK + exit 1 + stderr noise is an installed credential',
          out: 'AUTH_OK', err: 'docker: connection reset', code: 1,
          run: () => C.prepareCxellAuth({ ctx: 'default', name: 'cxell_zt-v',
                                          adapter: RT.adapterFor('codex-cxell'), token: 'sk-proj-zt' }),
          want: (r) => r?.required === true && r?.ok === true && r?.verdict === 'AUTH_OK' },
        { what: 'AUTH_FAILED + exit 0 is still a failure, carrying what the cage said',
          out: 'No API key provided via stdin.\nAUTH_FAILED', err: '', code: 0,
          run: () => C.prepareCxellAuth({ ctx: 'default', name: 'cxell_zt-v',
                                          adapter: RT.adapterFor('codex-cxell'), token: 'sk-proj-zt' }),
          want: (r) => r?.ok === false && r?.verdict === 'AUTH_FAILED' && /No API key/.test(String(r?.said)) },
        { what: 'and NO verdict is a FAILURE — "we could not tell" must never start a turn',
          out: '', err: 'No such container: cxell_zt-v', code: 1,
          run: () => C.prepareCxellAuth({ ctx: 'default', name: 'cxell_zt-v',
                                          adapter: RT.adapterFor('codex-cxell'), token: 'sk-proj-zt' }),
          want: (r) => r?.ok === false && !r?.verdict && /No such container/.test(String(r?.said)) },
      ],
    },
    {
      // PRE-ANSWERING THE RUNTIME'S FIRST-RUN PROMPTS (lib/cxell.js seedCxellFirstRun) — the auth
      // install's twin, and deliberately the opposite POLICY: this one is not fatal, because a cage
      // whose seed failed still works headless and the whole cost is a prompt in front of an
      // attending human. Which makes reading the verdict correctly matter MORE, not less: nothing
      // downstream fails, so a misread here is only ever visible as a human meeting a gate nobody
      // said was there.
      name: 'seedCxellFirstRun (the vendor first-run seed)',
      markers: RT.SEED_MARKERS,
      cases: [
        { what: 'SEED_OK + exit 1 + stderr noise is a seeded cage',
          out: 'SEED_OK', err: 'docker: connection reset', code: 1,
          run: () => C.seedCxellFirstRun({ ctx: 'default', name: 'cxell_zt-v',
                                           adapter: RT.adapterFor('codex-cxell') }),
          want: (r) => r?.required === true && r?.ok === true && r?.verdict === 'SEED_OK' },
        { what: 'SEED_FAILED + exit 0 is a failure that carries what the cage said',
          out: 'could not write ~/.codex/config.toml\nSEED_FAILED', err: '', code: 0,
          run: () => C.seedCxellFirstRun({ ctx: 'default', name: 'cxell_zt-v',
                                           adapter: RT.adapterFor('codex-cxell') }),
          want: (r) => r?.ok === false && r?.verdict === 'SEED_FAILED' && /config\.toml/.test(String(r?.said)) },
        { what: 'and no verdict is reported, not assumed — silence is not a seeded cage',
          out: '', err: 'No such container: cxell_zt-v', code: 1,
          run: () => C.seedCxellFirstRun({ ctx: 'default', name: 'cxell_zt-v',
                                           adapter: RT.adapterFor('codex-cxell') }),
          want: (r) => r?.ok === false && !r?.verdict && /No such container/.test(String(r?.said)) },
      ],
    },
  ];

  for (const site of SITES) {
    console.log(`\n── ${site.name} — the verdict decides, whatever the exit code said ──`);
    for (const c of site.cases) {
      say(c);
      if (site.onlyMerge) process.env.FAKE_ONLY_MERGE = '1'; else delete process.env.FAKE_ONLY_MERGE;
      const n0 = since();
      const got = await c.run().catch((e) => e);
      // some sites' whole observable IS a logline (ensureCxell warns rather than returning), so the
      // lines this call produced are handed to the expectation alongside its result
      ok(c.want(got, linesSince(n0)),
         `${c.what} [${JSON.stringify(got instanceof Error ? got.message : got).slice(0, 120)}]`);
    }
  }
  delete process.env.FAKE_ONLY_MERGE;   // the shim answers every exec again for the sections below

  // ── 2. the oddity is TRUSTED AND SAID — once, from one place ───────────────────────────────────
  // Believing the verdict over the exit code must not mean swallowing the disagreement: that is the
  // same bug facing the other way, and it would hide on the success path where nobody looks.
  console.log('\n── a verdict with a non-zero exit is logged as an oddity, by the helper ──');
  say({ out: 'SAME', err: 'docker: connection reset', code: 1 });
  let n = since();
  await C.writeFileIntoCxellIfChanged({ slug: 'zt-v', relPath: '.zeehive.env', text: 'A=1\n' });
  const odd = linesSince(n).filter((m) => /trusting the verdict/i.test(m));
  ok(odd.length === 1, `exactly one line, from dkVerdict [${JSON.stringify(odd).slice(0, 150)}]`);
  ok(/exited 1/.test(odd[0] || '') && /SAME/.test(odd[0] || '') && /connection reset/.test(odd[0] || ''),
     'naming the verdict, the exit code and what docker said');
  say({ out: 'SAME', err: '', code: 0 });
  n = since();
  await C.writeFileIntoCxellIfChanged({ slug: 'zt-v', relPath: '.zeehive.env', text: 'A=1\n' });
  ok(!linesSince(n).some((m) => /trusting the verdict/i.test(m)),
     'and a healthy exec logs nothing — the line marks a disagreement, not every write');

  // ── 3. dk's REJECTION cannot hide stdout any more ──────────────────────────────────────────────
  // This is the half that makes the verdict recoverable even for a caller that never reaches
  // dkVerdict: `(err || out)` was stderr ALONE whenever the child wrote any, which is how warmCxell
  // lost a marker that was on stdout the whole time.
  console.log('\n── a non-zero exit still rejects, but the rejection carries BOTH streams ──');
  say({ out: 'A_MARKER_ON_STDOUT', err: 'noise on stderr', code: 3 });
  const rej = await C.warmCxell({ ctx: 'default', name: 'cxell_zt-v' });   // reaches dk through dkVerdict
  ok(rej.warmed === false, 'an unrecognised answer is not a warm');
  // dk's OWN message, through a plain (non-verdict) exec that surfaces it verbatim — this is the half
  // that protects the ~40 call sites here which never reach dkVerdict: even they cannot see
  // stderr-only any more, so a marker on stdout survives being reported as a failure.
  say({ out: 'A_MARKER_ON_STDOUT', err: 'noise on stderr', code: 3 });
  const sealed = await C.sealCxell({ ctx: 'default', name: 'cxell_zt-v' }).catch((e) => e);
  ok(sealed instanceof Error && /A_MARKER_ON_STDOUT/.test(sealed.message) && /noise on stderr/.test(sealed.message)
     && /exited 3/.test(sealed.message),
     `dk's own rejection names the exit code and BOTH streams [${String(sealed?.message).slice(0, 110)}]`);
  say({ out: 'A_MARKER_ON_STDOUT', err: 'noise on stderr', code: 3 });
  const thrown = await C.writeGeneratedDocIntoCxell({ slug: 'zt-v', relPath: 'AGENTS.md', text: 'x' })
    .catch((e) => e);
  ok(thrown instanceof Error && /A_MARKER_ON_STDOUT/.test(thrown.message) && /noise on stderr/.test(thrown.message),
     `stdout AND stderr are in the failure message [${String(thrown?.message).slice(0, 110)}]`);
  ok(!/\(err \|\| out\)\.slice/.test(code) && /exited \$\{code\}: \$\{dkSaid\(/.test(code),
     'the `(err || out).slice(…)` message that dropped stdout is gone — dk builds it with dkSaid, which always says both');
  ok(/e\.dk = \{ code, out, err \}/.test(src),
     'and the rejection carries the raw streams, so dkVerdict reads a FAILED exec\'s stdout without re-running anything');

  // ── 4. THE STRUCTURAL GUARD — the mistake itself, not the sites ────────────────────────────────
  console.log('\n── the shape cannot be got wrong quietly ──');
  ok(!/allowNonZero/.test(code),
     'there is no `allowNonZero` on dk: the ONLY way to survive a non-zero exit is dkVerdict, which reads stdout by construction');
  ok(/async function dkVerdict\(/.test(src) && (src.match(/async function dkVerdict\(/g) || []).length === 1,
     'dkVerdict is defined exactly once');
  // nobody hand-rolls the parse any more — that is how '[object Object]' and the last-line-only
  // reading both got in
  ok(!/split\('\\n'\)[\s\S]{0,40}\.pop\(\)/.test(code),
     'no hand-rolled "last line of stdout" verdict parsing survives outside the helper');
  ok(!/String\(\s*(await )?dk(Verdict)?\(/.test(code),
     'and nothing stringifies a dk call\'s result object (the \'[object Object]\' bug\'s own signature)');
  ok(/\{ \.\.\.r, verdict, verdicts \}/.test(src),
     'the verdict comes back as its own STRING field, so there is no object left to read as one');

  // EVERY marker a cage script prints must be DECLARED at the exec that runs it. This is the guard
  // that fires on the NEXT instance: add `echo NEW_MARKER` to a script and read it off the exit code,
  // and the token is undeclared and this fails.
  // spawn-prep.js is here because migration 121 MOVED the warm script into it: the markers a cage
  // prints are generated from the project's spawn template now, and a guard that only reads cxell.js
  // would have declared every WARM_* marker a ghost.
  const scriptSources = ['server/src/lib/cxell.js', 'server/src/lib/npm-cache.js', 'server/src/lib/spawn-prep.js'];
  const printed = new Set();
  for (const f of scriptSources) {
    const s = readFileSync(join(ROOT, f), 'utf8');
    for (const m of s.matchAll(/echo\s+"?\$?\{?([A-Z][A-Z0-9_]{2,})/g)) printed.add(m[1]);
    for (const m of s.matchAll(/\bV=([A-Z][A-Z0-9_]{2,})/g)) printed.add(m[1]);       // V=SAME / V=WROTE
    for (const m of s.matchAll(/echo\s+[A-Z_]+\s+\|\|\s+echo\s+([A-Z][A-Z0-9_]{2,})/g)) printed.add(m[1]);
  }
  // Declared markers: the `markers:` lists at the dkVerdict call sites, plus the named constant one of
  // them passes (WARM_MARKERS lives beside the script that prints them).
  // The named-constant marker sets, which the `markers: [...]` regex below cannot see because the
  // call site passes a CONSTANT. Each one lives beside the script that prints it.
  const declared = new Set([...C.WARM_MARKERS, ...C.CLONE_MARKERS]);
  for (const m of src.matchAll(/markers:\s*\[([^\]]*)\]/g)) {
    for (const tok of m[1].matchAll(/'([A-Z][A-Z0-9_]*)'/g)) declared.add(tok[1]);
  }
  // Exemptions, each with the reason it is not a verdict-vs-exit-code case. An exemption is a claim,
  // so the claim is asserted below, not just written down.
  const EXEMPT = {
    // __MERGE_RC__ used to be exempted here, on the grounds that an inline `$?` capture is not a verdict
    // and the 2>&1 kept git's own output on stdout anyway. Both halves were true and the conclusion was
    // wrong: the exit code it captured was read in the CATCH, off dk's rejection message, so a conflict
    // the message truncated became an operational error and ran `git merge --abort` on a zee's
    // in-progress resolution. The site is now a real dkVerdict caller with a row in the table above —
    // the last exemption of that kind, and the reason none is left.
    // A per-step TIMING line, not a verdict: it is parsed into a report (how long each prep step
    // cost) and NOTHING decides on it. Asserted below, because "it is only a report" is a claim.
    PREP_STEP: 'a timing/report line from the spawn template, never a decision (asserted below)',
    // A DATA PREFIX, not a verdict: cxellPatchBody echoes `BASE:<sha>` as the first line so cxellPatch
    // (which uses plain dk, NOT dkVerdict — it reads the patch regardless of the exit code) can report
    // the diff base actually used. The line is stripped before the caller parses the patch, so no
    // decision is made from it on any path. Asserted by test/cxell-diff-base.test.mjs, which runs the
    // real body and checks the BASE line names the fork point.
    BASE: 'a data prefix parsed by cxellPatch, not a verdict — stripped before the patch is read',
    // A SHELL VARIABLE, not a marker: `echo "$SRC_OK"` prints its VALUE (`yes`/`no` — lowercase, no
    // `_`-token), and the six field positions of cxellDiff's output are parsed positionally by
    // parseCxellDiff, never read as a verdict off an exit code. The regex catches the `$SRC_OK`
    // expansion; the same pattern already exempted `$SRC`/`$OM`. Asserted by test/cxell-diff-base
    // .test.mjs (the mirror case), which checks the signal is a real sixth field.
    SRC_OK: 'a shell variable echoed for a positional field, not a verdict marker — its value is yes/no',
    __ZEE_TALK_QUEUED__: 'not run by dk at all — sshExecInCxell (asserted below)',
    __ZEE_TALK_FAILED__: 'not run by dk at all — sshExecInCxell (asserted below)',
    __ZEE_KEYS_SENT__: 'not run by dk at all — sshExecInCxell (asserted below)',
  };
  const undeclared = [...printed].filter((t) => !declared.has(t) && !(t in EXEMPT));
  ok(undeclared.length === 0,
     `every marker a cage script prints is declared at its exec or exempted with a reason `
     + `(undeclared: ${JSON.stringify(undeclared)})`);
  ok([...declared].every((t) => printed.has(t)),
     `and no declared marker is a ghost — each one is really printed by a script `
     + `[declared ${JSON.stringify([...declared])}]`);
  // the sync merge's own claim: git's conflict lines must stay on STDOUT, where the verdict is read and
  // where they can be reported to the zee verbatim (its stderr would be a second place to lose them).
  ok(/git \$\{CX_IDENTITY\} merge --no-edit refs\/remotes\/origin\/main 2>&1/.test(src),
     'the sync merge still redirects 2>&1, which is what keeps git\'s conflict lines on stdout');
  // the exemptions' own claims
  ok(/stream\.on\('close', \(code\) => \{[^}]*done\(resolve, \{ code, out, err: errOut \}\)/.test(src),
     '__ZEE_*__: sshExecInCxell resolves { code, out, err } on ANY exit code, so its markers cannot be lost');
  const prepSrc = readFileSync(join(ROOT, 'server/src/lib/spawn-prep.js'), 'utf8');
  ok(/export function parsePrepSteps/.test(prepSrc) && !/verdicts.*PREP_STEP|PREP_STEP.*verdict/.test(src),
     'PREP_STEP: parsed into the per-step timing report and never consulted as a verdict');

  // and the table above must cover every declared marker set — the anti-accident clause
  const tabled = new Set(SITES.flatMap((s) => s.markers));
  const uncovered = [...declared].filter((t) => !tabled.has(t));
  ok(uncovered.length === 0,
     `every declared marker is exercised by a row in the guard table above — a NEW marker-based `
     + `exec cannot be added without one (uncovered: ${JSON.stringify(uncovered)})`);
  const callSites = (src.match(/markers:/g) || []).length;
  ok(callSites === SITES.length,
     `and there are exactly as many dkVerdict call sites as rows (${callSites} vs ${SITES.length})`);

  console.log(fail ? `\n${fail} FAILED` : '\nall good');
} catch (e) {
  console.error('TEST ERROR:', e);
  fail++;
} finally {
  process.env.PATH = REAL_PATH;
  delete process.env.FAKE_STDOUT; delete process.env.FAKE_STDERR; delete process.env.FAKE_CODE; delete process.env.FAKE_ONLY_MERGE;
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
}
process.exit(fail ? 1 : 0);
