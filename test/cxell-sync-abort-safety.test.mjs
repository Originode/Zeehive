// `git merge --abort` MUST NEVER RUN ON A TREE WE DID NOT READ — the sync merge, fenced.
//
// THE SYMPTOM (data loss, not cosmetic): a caged zee is halfway through resolving a merge conflict —
// files edited, some `git add`ed, nothing committed yet, because a resolution is not committable until
// it is finished. Its whole resolution therefore lives in the working tree and the index. Then a sync
// runs and the queenzee deletes both.
//
// THE SEQUENCE THAT REACHES IT IS ORDINARY WORKFLOW, which is why this is fenced rather than noted:
//   1. `zee sync` → a genuine CONTENT conflict. The merge is left in progress for the zee (correct).
//   2. the zee starts resolving: edits the conflicted files, `git add`s what it has settled.
//   3. `zee sync` again — the thing every zee is told to do when it is unsure, and the thing `zee land`
//      does BY ITSELF when main has moved. git refuses: "fatal: You have not concluded your merge
//      (MERGE_HEAD exists)." Exit 128, and NOT ONE conflict keyword in that text.
//   4. syncCxellWithXource classified that as an operational error and ran `git merge --abort` inside
//      the cage → the working tree reverts to the pre-merge blobs, the index is dropped, `git status`
//      goes clean, and the resolution is gone with no way back (step 4's own verification is case 4
//      below: the staged content is genuinely unrecoverable, nothing is committed anywhere).
//
// A SECOND, quieter way in (the report this task came from, quiet-harbor-9e6740 at 26fe4415): the
// classification read `String(e.message)` — dk()'s REJECTION message. That message is built for a human
// and caps EACH stream at 400 chars, so a conflict whose "CONFLICT (content):" line sits past the cap
// (a deep path is enough) also read as operational → same abort. Case 3.
//
// THE FIX BEING FENCED. The merge now runs through dkVerdict with DECLARED markers and states its own
// outcome — MERGE_HELD (a merge was already in progress; nothing merged, nothing touched), MERGE_OK,
// MERGE_CONFLICT (unmerged paths in the index), MERGE_STOPPED (the merge WE started, zero unmerged
// paths), MERGE_FAILED (never started) — and an outcome that is missing or unrecognised is state
// 'unknown': the tree is left exactly as it is and the queenzee says so. `git merge --abort` survives
// on ONE path only (MERGE_STOPPED), where the script itself observed there is no conflicted file and
// that the merge in progress is one the queenzee made seconds ago. Case 7 drives that path and proves
// the abort still happens there; every other case asserts NO abort was even attempted.
//
// HOW IT IS DRIVEN. A cxell has no docker socket, so `docker` is a shim on PATH that runs the exec'd
// script locally with /work/repo rewritten to a REAL throwaway git repo (the same technique as
// test/warm-drift-is-reported.test.mjs). So: the real syncCxellWithXource, the real bundle+deliver, the
// real dk/dkVerdict spawn and stream split, the real merge script, real git, real conflicts — and every
// `git merge --abort` the queenzee attempts is recorded AND executed, so a wrong abort destroys the
// fixture exactly as it would destroy a zee's work, and the test sees it.
// WHAT THIS CANNOT EXERCISE: the docker hop itself (a live container, users/ownership), and the
// dk-timeout arm of the 'unknown' branch — a 180s timeout is not runnable here, so it is covered by the
// case that takes the identical branch (an exec that reports nothing, case 5) plus a source assertion
// that the branch is entered on ANY dkVerdict rejection. Everything created lives in one temp dir,
// removed in a finally.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) fail++; };

const tmp = mkdtempSync(join(tmpdir(), 'cxsync-'));
const REAL_PATH = process.env.PATH;
const ABORTS = join(tmp, 'aborts.log');
const BRANCH = 'spinoff/zt-sync';

const ID = ['-c', 'user.name=fixture', '-c', 'user.email=fixture@test'];
const g = (cwd, ...a) => {
  const r = execFileSync('git', ['-C', cwd, ...ID, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return String(r).trim();
};
const gq = (cwd, ...a) => { try { return { ok: true, out: g(cwd, ...a) }; } catch (e) { return { ok: false, out: String(e.stdout || '') + String(e.stderr || '') }; } };
const mergeHead = (cxell) => gq(cxell, 'rev-parse', '-q', '--verify', 'MERGE_HEAD').out.trim();
const unmerged = (cxell) => gq(cxell, 'ls-files', '--unmerged').out.trim();
const aborts = () => (existsSync(ABORTS) ? readFileSync(ABORTS, 'utf8').trim().split('\n').filter(Boolean) : []);
const clearAborts = () => writeFileSync(ABORTS, '');

// A xource ("worktree" from the queenzee's side: it only ever READS refs and bundles from it) plus a
// caged clone of the branch — the real starting condition of a live xell.
//   master:  B0 → A1        (main moved since the cage was cut)
//   branch:  B0 → whatever the case commits inside the cxell
// `file` is the path both sides edit, so the merge conflicts; a case can make it very deep on purpose.
function fixture(name, { file = 'shared.txt', mainText = 'MAIN\n' } = {}) {
  const root = join(tmp, name);
  const wt = join(root, 'wt');
  mkdirSync(wt, { recursive: true });
  g(wt, 'init', '-q', '-b', 'master');
  const deep = join(wt, dirname(file));
  if (dirname(file) !== '.') mkdirSync(deep, { recursive: true });
  writeFileSync(join(wt, file), 'BASE\n');
  writeFileSync(join(wt, 'untouched.txt'), 'untouched\n');
  g(wt, 'add', '-A'); g(wt, 'commit', '-qm', 'base');
  g(wt, 'branch', BRANCH);
  // cage the branch: a bundle of it, cloned — no master ref inside, exactly like a real cxell
  const bundle = join(root, 'task.bundle');
  g(wt, 'bundle', 'create', bundle, BRANCH);
  const cxell = join(root, 'cxell');
  execFileSync('git', ['clone', '-q', '-b', BRANCH, bundle, cxell], { encoding: 'utf8' });
  // main moves on
  writeFileSync(join(wt, file), mainText);
  g(wt, 'add', '-A'); g(wt, 'commit', '-qm', 'master moves');
  g(wt, 'checkout', '-q', BRANCH);          // HEAD back on the branch, at B0 (the provisioning base)
  return { root, wt, cxell, file };
}

let C, sync;   // the module under test + its entry point (imported after PATH is shimmed)

// Run the real sync against a fixture, with the shim pointed at that fixture's cxell.
async function runSync(fx, mode = '') {
  process.env.FAKE_CXELL_REPO = fx.cxell;
  process.env.FAKE_SYNC_MODE = mode;
  clearAborts();
  return sync({ ctx: 'default', slug: 'zt-sync', worktree: fx.wt, ref: 'master' });
}

try {
  // ── the shim: docker cp copies, docker exec runs the script here, aborts are RECORDED and RUN ────
  const bin = join(tmp, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'docker'), [
    '#!/usr/bin/env bash',
    '# stand-in for the docker CLI (see the header of test/cxell-sync-abort-safety.test.mjs)',
    'if [ "$1" = "--context" ]; then shift 2; fi',
    'case "$1" in',
    '  cp) dst=$3; dst=${dst#*:}; cp "$2" "$dst"; exit $? ;;',
    '  exec) shift ;;',
    '  *) exit 0 ;;',
    'esac',
    '# strip exec flags and the container name',
    'while :; do case "$1" in -i) shift ;; -u|-e) shift 2 ;; *) break ;; esac; done',
    'shift',
    'if [ "$1" != bash ]; then exec "$@"; fi',
    'shift; [ "$1" = -lc ] && shift',
    'script=${1//\\/work\\/repo/$FAKE_CXELL_REPO}',
    'case "$1" in *"merge --abort"*) echo "$script" >> "$FAKE_ABORT_LOG" ;; esac',
    'case "$1" in',
    '  *"merge --no-edit"*)',
    '    if [ "$FAKE_SYNC_MODE" = silent ]; then',
    // ran, said nothing we declared: the container is there but its answer is docker's, not the script's
    '      echo "Error response from daemon: cannot exec in a stopped container" >&2; exit 1',
    '    fi',
    '    bash -lc "$script"',
    '    if [ "$FAKE_SYNC_MODE" = oddexit ]; then echo "docker: connection reset by peer" >&2; exit 1; fi',
    '    exit 0 ;;',
    'esac',
    'exec bash -lc "$script"',
  ].join('\n'), { mode: 0o755 });
  process.env.PATH = `${bin}:${REAL_PATH}`;
  process.env.FAKE_ABORT_LOG = ABORTS;

  C = await import('../server/src/lib/cxell.js');
  sync = C.syncCxellWithXource;
  const { recentLogs } = await import('../server/src/lib/logbus.js');
  const since = () => recentLogs(400).length;
  const linesSince = (n) => recentLogs(400).slice(n).map((l) => l.msg || String(l));
  const src = readFileSync(join(ROOT, 'server/src/lib/cxell.js'), 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

  // ── 1. the clean path is unchanged ───────────────────────────────────────────────────────────────
  console.log('\n── 1. a clean merge still merges (and nothing is aborted) ──');
  {
    const fx = fixture('clean', { file: 'shared.txt' });
    g(fx.cxell, 'config', 'user.email', 'z@t'); g(fx.cxell, 'config', 'user.name', 'z');
    writeFileSync(join(fx.cxell, 'zee.txt'), 'zee work\n');     // a DIFFERENT file → no conflict
    g(fx.cxell, 'add', '-A'); g(fx.cxell, 'commit', '-qm', 'zee work');
    const r = await runSync(fx);
    ok(r.state === 'merged', `state 'merged' (got '${r.state}': ${String(r.output || '').slice(0, 120)})`);
    ok(r.head === gq(fx.cxell, 'rev-parse', 'HEAD').out, 'the head it reports IS the cxell\'s new merge commit');
    ok(gq(fx.cxell, 'merge-base', '--is-ancestor', 'refs/remotes/origin/main', 'HEAD').ok,
       'the cxell HEAD now descends from main — the whole point of the sync');
    ok(aborts().length === 0, `and no abort was attempted (${JSON.stringify(aborts())})`);
  }

  // ── 2. a genuine content conflict: the zee's, left in place ──────────────────────────────────────
  console.log('\n── 2. a real content conflict is the zee\'s, left in progress, never aborted ──');
  {
    const fx = fixture('conflict');
    writeFileSync(join(fx.cxell, 'shared.txt'), 'ZEE\n');
    g(fx.cxell, 'add', '-A'); g(fx.cxell, 'commit', '-qm', 'zee edits the same file');
    const r = await runSync(fx);
    ok(r.state === 'conflict', `state 'conflict' (got '${r.state}')`);
    ok(r.held === false, 'and NOT flagged as a pre-existing merge — this sync caused it');
    ok(/CONFLICT \(content\)/.test(String(r.output || '')), 'git\'s own conflict line is reported back');
    ok(mergeHead(fx.cxell) && unmerged(fx.cxell), 'the merge is LEFT in progress with unmerged paths for the zee');
    ok(aborts().length === 0, `no abort (${JSON.stringify(aborts())})`);
  }

  // ── 3. the reported defect: a conflict whose text does not survive the rejection message ─────────
  // Non-zero exit → dk REJECTS → the old code classified `String(e.message)`, which caps each stream at
  // 400 chars. A path deep enough to push "CONFLICT (content):" past the cap made a real conflict read
  // as operational, and the operational branch aborted. The path is contrived; the truncation is not —
  // correctness must not depend on a message's length.
  console.log('\n── 3. a CONFLICT reported on a NON-ZERO exit is still a conflict (not classified from a message) ──');
  {
    const deep = `${Array.from({ length: 9 }, (_, i) => `deep-directory-number-${i}-padded-out-to-defeat-the-cap`).join('/')}/shared.txt`;
    ok(deep.length > 400, `setup: the conflicting path is ${deep.length} chars, so git's CONFLICT line starts past dkSaid's 400-char cap`);
    const fx = fixture('trunc', { file: deep });
    writeFileSync(join(fx.cxell, deep), 'ZEE\n');
    g(fx.cxell, 'add', '-A'); g(fx.cxell, 'commit', '-qm', 'zee edits the deep file');
    const n0 = since();
    const r = await runSync(fx, 'oddexit');
    ok(r.state === 'conflict', `state 'conflict' (got '${r.state}') — decided by the script's verdict, not by git's prose`);
    ok(mergeHead(fx.cxell) && unmerged(fx.cxell), 'the conflict is still in progress for the zee to resolve');
    ok(aborts().length === 0, `NO abort ran (${JSON.stringify(aborts())})`);
    ok(linesSince(n0).some((m) => /trusting the verdict/i.test(m)),
       'and the exit-code-vs-verdict disagreement is said out loud, once, by dkVerdict');
  }

  // ── 4. THE DATA-LOSS PATH: a zee mid-resolution, synced again ───────────────────────────────────
  console.log('\n── 4. a zee\'s IN-PROGRESS resolution survives a second sync (the data-loss path) ──');
  {
    const fx = fixture('midres');
    writeFileSync(join(fx.cxell, 'shared.txt'), 'ZEE\n');
    g(fx.cxell, 'add', '-A'); g(fx.cxell, 'commit', '-qm', 'zee edits the same file');
    const first = await runSync(fx);
    ok(first.state === 'conflict', 'step 1: the first sync hands the zee a conflict');
    // step 2: the zee resolves and stages it — the state that only exists in the tree + index
    writeFileSync(join(fx.cxell, 'shared.txt'), 'RESOLVED BY THE ZEE\n');
    g(fx.cxell, 'add', 'shared.txt');
    const mh = mergeHead(fx.cxell);
    ok(mh && !unmerged(fx.cxell), 'step 2: resolution staged — MERGE_HEAD set, zero unmerged paths, nothing committed');

    const n0 = since();
    const r = await runSync(fx);                                   // step 3: sync again
    ok(readFileSync(join(fx.cxell, 'shared.txt'), 'utf8') === 'RESOLVED BY THE ZEE\n',
       'THE RESOLUTION IS STILL THERE in the working tree');
    ok(gq(fx.cxell, 'diff', '--cached', '--name-only').out.split('\n').includes('shared.txt'),
       'and still STAGED in the index');
    ok(mergeHead(fx.cxell) === mh, 'the merge the zee is concluding is untouched (same MERGE_HEAD)');
    ok(aborts().length === 0, `no abort was attempted (${JSON.stringify(aborts())})`);
    ok(r.state === 'conflict' && r.held === true,
       `reported as a merge already in progress (state '${r.state}', held ${JSON.stringify(r.held)})`);
    ok(/already in progress/i.test(String(r.output || '')), 'the report says so in git\'s and the script\'s own words');
    ok(linesSince(n0).some((m) => /already in progress/i.test(m) && /nothing touched/i.test(m)),
       'and the queenzee log says nothing was merged and nothing touched');
  }

  // ── 5. an exec that says nothing: outcome UNKNOWN → hands off the tree ──────────────────────────
  console.log('\n── 5. an exec that reports NO outcome leaves the tree alone and is reported loudly ──');
  {
    const fx = fixture('silent');
    writeFileSync(join(fx.cxell, 'shared.txt'), 'ZEE\n');
    g(fx.cxell, 'add', '-A'); g(fx.cxell, 'commit', '-qm', 'zee edits the same file');
    const first = await runSync(fx);
    ok(first.state === 'conflict', 'setup: a conflict is in progress in the cxell');
    writeFileSync(join(fx.cxell, 'shared.txt'), 'HALF RESOLVED\n');
    g(fx.cxell, 'add', 'shared.txt');
    const mh = mergeHead(fx.cxell);

    const n0 = since();
    const r = await runSync(fx, 'silent');
    ok(r.state === 'unknown', `state 'unknown' — not 'error' (got '${r.state}')`);
    ok(/cannot exec in a stopped container/.test(String(r.output || '')), 'carrying what docker actually said');
    ok(readFileSync(join(fx.cxell, 'shared.txt'), 'utf8') === 'HALF RESOLVED\n' && mergeHead(fx.cxell) === mh,
       'the half-done resolution and the in-progress merge are both untouched');
    ok(aborts().length === 0, `no abort, because nothing is known about that tree (${JSON.stringify(aborts())})`);
    const said = linesSince(n0);
    ok(said.some((m) => /UNKNOWN/.test(m) && /LEFT EXACTLY AS IT IS/.test(m)),
       `and it is said loudly rather than swallowed (${JSON.stringify(said.slice(-1))})`);
  }

  // ── 6. up-to-date is untouched ───────────────────────────────────────────────────────────────────
  console.log('\n── 6. a cxell that already contains main is reported up-to-date, nothing run ──');
  {
    const fx = fixture('uptodate');
    const r1 = await runSync(fx);                 // fast-forward merge of main
    ok(r1.state === 'merged', `setup merged (${r1.state})`);
    const head = gq(fx.cxell, 'rev-parse', 'HEAD').out;
    const r2 = await runSync(fx);
    ok(r2.state === 'up-to-date' && r2.head === head, `second sync is 'up-to-date' (${r2.state})`);
    ok(aborts().length === 0, 'and no abort');
  }

  // ── 7. the ONE abort that survives, driven for real ─────────────────────────────────────────────
  // A merge that WE started, in progress, with ZERO unmerged paths: a declined pre-merge-commit hook is
  // the real-world shape. Nothing of the zee's is inside it and there is no resolution to lose, so the
  // abort still runs — and this is the only case in this file where it does.
  console.log('\n── 7. MERGE_STOPPED — our own merge, no conflicted file: still aborted, still safe ──');
  {
    const fx = fixture('stopped');
    writeFileSync(join(fx.cxell, 'zee.txt'), 'zee work\n');
    g(fx.cxell, 'add', '-A'); g(fx.cxell, 'commit', '-qm', 'zee work');
    const hook = join(fx.cxell, '.git/hooks/pre-merge-commit');
    writeFileSync(hook, '#!/bin/sh\necho "hook declined the merge commit" >&2\nexit 1\n', { mode: 0o755 });
    const headBefore = gq(fx.cxell, 'rev-parse', 'HEAD').out;
    const r = await runSync(fx);
    ok(r.state === 'error', `state 'error' — nothing for the zee to resolve (got '${r.state}')`);
    ok(aborts().length === 1, `the abort DID run, exactly once (${aborts().length})`);
    ok(!mergeHead(fx.cxell) && gq(fx.cxell, 'rev-parse', 'HEAD').out === headBefore,
       'and it left the cxell back on its own HEAD with no half-merge');
    ok(gq(fx.cxell, 'status', '--porcelain').out === '', 'tree clean — the aborted merge was the queenzee\'s, not the zee\'s');
  }

  // ── 8. the shape cannot regress quietly ─────────────────────────────────────────────────────────
  console.log('\n── 8. structural: the abort is reachable from ONE verdict, and nothing classifies a message ──');
  ok((code.match(/merge --abort/g) || []).length === 1,
     `exactly one \`git merge --abort\` in cxell.js (${(code.match(/merge --abort/g) || []).length})`);
  const stopped = code.slice(code.indexOf("r.verdict === 'MERGE_STOPPED'"));
  ok(stopped.indexOf('merge --abort') > 0 && stopped.indexOf('merge --abort') < stopped.indexOf("return { state: 'error'"),
     'and it lives inside the MERGE_STOPPED branch — the one verdict that says there is nothing to lose');
  ok(!/classifyMergeOutput\(\s*(String\()?e\.message/.test(code) && !/out = String\(e\.message\)/.test(code),
     'nothing classifies a merge from a REJECTION MESSAGE any more');
  ok(/dkVerdict\(ctx, \['exec', name, 'bash', '-lc', syncMergeScript\(\)\]/.test(code),
     'the merge exec goes through dkVerdict (so the verdict is read off stdout whatever the exit code was)');
  ok(/if \(failure \|\| !r\.verdict\)/.test(code),
     'and ANY dkVerdict rejection (spawn failure, the 180s timeout) enters the same untouched-tree branch as a missing verdict');
  const self = readFileSync(join(ROOT, 'server/src/queenzee/self.js'), 'utf8');
  ok(/s\.state === 'unknown'/.test(self) && /NOTHING was aborted or reset/.test(self),
     'selfHealSync has its own branch for the unknown outcome (source assertion — it needs a queenzee to run)');
  ok(/s\.held\s*\n?\s*\?/.test(self) || /s\.held \?/.test(self),
     'and tells a mid-resolution zee its tree was not touched, rather than "you hit a conflict"');

  // the script's markers are FACTS it observed, one of them per answer — assert the four git states
  // really do produce four different verdicts (the classification's whole basis), by running the REAL
  // script against a real repo in each state.
  console.log('\n── 9. the script tells the git states apart, for real (each verdict is an observed fact) ──');
  {
    // The script is exported with a repoDir (like warmInstallScript) so the marker logic can be run
    // against real repos with no docker in the way at all.
    const runScript = (dir) => {
      const out = execFileSync('bash', ['-lc', C.syncMergeScript(dir)], { encoding: 'utf8' });
      return String(out).trim().split('\n').pop();
    };
    const withMain = (name) => {                     // a caged clone that HAS refs/remotes/origin/main
      const fx = fixture(name);
      const b = join(fx.root, 'main.bundle');
      g(fx.wt, 'bundle', 'create', b, 'master');
      g(fx.cxell, 'fetch', '-f', b, 'master:refs/remotes/origin/main');
      return fx;
    };
    const okFx = withMain('mk-ok');
    writeFileSync(join(okFx.cxell, 'zee.txt'), 'zee\n');
    g(okFx.cxell, 'add', '-A'); g(okFx.cxell, 'commit', '-qm', 'zee work');
    ok(runScript(okFx.cxell) === 'MERGE_OK', 'a clean merge → MERGE_OK');

    const cf = withMain('mk-conflict');
    writeFileSync(join(cf.cxell, 'shared.txt'), 'ZEE\n');
    g(cf.cxell, 'add', '-A'); g(cf.cxell, 'commit', '-qm', 'zee edits the same file');
    ok(runScript(cf.cxell) === 'MERGE_CONFLICT', 'unmerged paths in the index → MERGE_CONFLICT');
    g(cf.cxell, 'add', 'shared.txt');                // the zee stages its resolution: no unmerged paths left
    ok(runScript(cf.cxell) === 'MERGE_HELD',
       'a merge already in progress → MERGE_HELD, even once the zee has staged its resolution away '
       + '(the state git refuses with "You have not concluded your merge", which used to read as operational)');

    const df = withMain('mk-failed');
    writeFileSync(join(df.cxell, 'shared.txt'), 'UNCOMMITTED ZEE EDIT\n');   // in the merge's way
    ok(runScript(df.cxell) === 'MERGE_FAILED', 'a merge that cannot start → MERGE_FAILED (nothing in progress)');
    ok(!mergeHead(df.cxell), 'and there is genuinely no merge to abort in that state');
  }
} catch (e) {
  console.error('TEST ERROR:', e);
  fail++;
} finally {
  process.env.PATH = REAL_PATH;
  delete process.env.FAKE_CXELL_REPO; delete process.env.FAKE_SYNC_MODE; delete process.env.FAKE_ABORT_LOG;
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
  try { rmSync('/tmp/main.bundle', { force: true }); } catch { /* */ }
}

console.log(fail ? `\n${fail} FAILED` : '\nall good');
process.exit(fail ? 1 : 0);
