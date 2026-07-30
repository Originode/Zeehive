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
  const { recentLogs } = await import('../server/src/lib/logbus.js');
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
      // THE SYNC MERGE — the fifth site, and the one this table caught. It is the highest-stakes of the
      // five: its verdict decides whether the queenzee runs `git merge --abort` inside a live cage, so a
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
  // that fires on a FOURTH instance: add `echo NEW_MARKER` to a script and read it off the exit code,
  // and the token is undeclared and this fails.
  const scriptSources = ['server/src/lib/cxell.js', 'server/src/lib/npm-cache.js'];
  const printed = new Set();
  for (const f of scriptSources) {
    const s = readFileSync(join(ROOT, f), 'utf8');
    for (const m of s.matchAll(/echo\s+"?\$?\{?([A-Z][A-Z0-9_]{2,})/g)) printed.add(m[1]);
    for (const m of s.matchAll(/\bV=([A-Z][A-Z0-9_]{2,})/g)) printed.add(m[1]);       // V=SAME / V=WROTE
    for (const m of s.matchAll(/echo\s+[A-Z_]+\s+\|\|\s+echo\s+([A-Z][A-Z0-9_]{2,})/g)) printed.add(m[1]);
  }
  // Declared markers: the `markers:` lists at the dkVerdict call sites, plus the named constant one of
  // them passes (WARM_MARKERS lives beside the script that prints them).
  const declared = new Set(C.WARM_MARKERS);
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
