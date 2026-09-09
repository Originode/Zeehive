// AFTER A LAND, THE CAGE'S origin/main MUST BE REFRESHED — ticket #185.
//
// THE SYMPTOM (load-bearing guard crying wolf): a worker lands commits; a manager's `zee zees`
// still reports `↑N unlanded commit(s) · +X/−Y in F file(s) — that work has not landed`. The done
// gate that exists to stop a human confirming a done over unlanded work then fires on EVERY
// successful land, so the correct human response becomes "ignore the warning" — and the day it is
// telling the truth, it will be ignored too.
//
// THE CAUSE: cxellDiff (and so crewFor / `zee zees`) measures ahead as
// `rev-list refs/remotes/origin/main..HEAD` and the source shortstat against
// merge-base(origin/main, HEAD). The cage's origin/main is handed at spawn (or the last sync) and
// was NEVER refreshed after a land, so every commit that just reached main still looks unlanded.
//
// THE FIX: refreshCxellOriginMain() bundles the worktree's current xource tip as a FULL
// self-contained bundle via refs/zeehive/refresh and fetches it into the LIVE cage as
// refs/remotes/origin/main — touching ONLY that tracking ref (no worktree, no merge). Wired
// best-effort into nudgeXellAfterLand (before resume), selfLand's push.landed path, and
// selfHealSync on merged/up-to-date.
//
// HOW THIS IS DRIVEN. A cxell has no docker socket, so `docker` is a shim on PATH that runs the
// exec'd script locally with /work/repo rewritten to a REAL throwaway git repo (same technique as
// test/cxell-sync-abort-safety.test.mjs). So: the real refreshCxellOriginMain, the real
// bundle+cp+fetch, real git — and a dead-cxell / missing-ref arm that must return refreshed:false
// and NEVER throw. WHAT THIS CANNOT EXERCISE: the docker hop itself (a live container), or the
// landgate/nudge wiring end-to-end (those need a queenzee); the call sites are asserted at source
// level below.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) fail++; };

const tmp = mkdtempSync(join(tmpdir(), 'cxrefresh-'));
const REAL_PATH = process.env.PATH;
const BRANCH = 'spinoff/zt-refresh';

const ID = ['-c', 'user.name=fixture', '-c', 'user.email=fixture@test'];
const g = (cwd, ...a) => {
  const r = execFileSync('git', ['-C', cwd, ...ID, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return String(r).trim();
};
const gq = (cwd, ...a) => {
  try { return { ok: true, out: g(cwd, ...a) }; }
  catch (e) { return { ok: false, out: String(e.stdout || '') + String(e.stderr || '') }; }
};

// A xource worktree + a caged clone whose origin/main is STALE — the live shape after a land
// that nobody refreshed:
//   master (wt):     B0 ………………… then FF'd to Z2 on "land"
//   branch (cxell):  B0 → Z1 → Z2   with refs/remotes/origin/main still at B0
function fixture(name) {
  const root = join(tmp, name);
  const wt = join(root, 'wt');
  mkdirSync(wt, { recursive: true });
  g(wt, 'init', '-q', '-b', 'master');
  writeFileSync(join(wt, 'README.md'), 'BASE\n');
  g(wt, 'add', '-A'); g(wt, 'commit', '-qm', 'base');
  const B0 = g(wt, 'rev-parse', 'HEAD');
  g(wt, 'branch', BRANCH);
  // cage the branch at B0 — a bundle clone, like a real cxell
  const bundle = join(root, 'task.bundle');
  g(wt, 'bundle', 'create', bundle, BRANCH);
  const cxell = join(root, 'cxell');
  execFileSync('git', ['clone', '-q', '-b', BRANCH, bundle, cxell], { encoding: 'utf8' });
  g(cxell, 'config', 'user.email', 'z@t'); g(cxell, 'config', 'user.name', 'z');
  // zee commits two times
  writeFileSync(join(cxell, 'a.txt'), 'one\n');
  g(cxell, 'add', '-A'); g(cxell, 'commit', '-qm', 'zee adds a');
  writeFileSync(join(cxell, 'b.txt'), 'two\n');
  g(cxell, 'add', '-A'); g(cxell, 'commit', '-qm', 'zee adds b');
  const Z2 = g(cxell, 'rev-parse', 'HEAD');
  // the cage still thinks origin/main is the spawn tip — the stale ref the ticket exists to close
  g(cxell, 'update-ref', 'refs/remotes/origin/main', B0);
  // "land": the host worktree's master fast-forwards onto the landed tip (what landgate does)
  g(wt, 'fetch', '-q', cxell, `+${BRANCH}:refs/zeehive/landed`);
  g(wt, 'update-ref', 'refs/heads/master', Z2);
  g(wt, 'checkout', '-q', '-B', BRANCH, Z2); // worktree HEAD on the branch tip, like a real xell
  return { root, wt, cxell, B0, Z2 };
}

try {
  // ── the shim: docker cp copies onto the host, docker exec runs against FAKE_CXELL_REPO ──────────
  const bin = join(tmp, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'docker'), [
    '#!/usr/bin/env bash',
    '# stand-in for the docker CLI (see the header of test/cxell-origin-main-refresh.test.mjs)',
    'if [ "$1" = "--context" ]; then shift 2; fi',
    'if [ "$FAKE_REFRESH_MODE" = dead ]; then',
    '  echo "Error: No such container: $2" >&2; exit 1',
    'fi',
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
    'exec bash -lc "$script"',
  ].join('\n'), { mode: 0o755 });
  process.env.PATH = `${bin}:${REAL_PATH}`;

  const C = await import('../server/src/lib/cxell.js');
  const { refreshCxellOriginMain, cxellDiffScript, parseCxellDiff } = C;
  const src = readFileSync(join(ROOT, 'server/src/lib/cxell.js'), 'utf8');
  const nudgeSrc = readFileSync(join(ROOT, 'server/src/queenzee/nudge.js'), 'utf8');
  const selfSrc = readFileSync(join(ROOT, 'server/src/queenzee/self.js'), 'utf8');

  // ── 0. the bug, pinned: after a land with a STALE origin/main, ahead and the shortstat cry wolf ─
  console.log('\n── 0. the bug, pinned: a landed tip still reads as unlanded against a stale origin/main ──');
  {
    const fx = fixture('bug');
    const before = parseCxellDiff(execFileSync('bash', ['-lc', cxellDiffScript(fx.B0, fx.cxell)], { encoding: 'utf8' }));
    ok(before.ahead === 2,
       `ahead counts the two landed commits as unlanded (ahead=${before.ahead}) — the cry-wolf`);
    ok(before.files === 2 && before.insertions === 2,
       `and the source shortstat still shows them (files=${before.files} ins=${before.insertions})`);
    ok(gq(fx.cxell, 'rev-parse', 'refs/remotes/origin/main').out === fx.B0,
       'setup: origin/main is still the spawn tip, not the landed tip');
  }

  // ── 1. refresh after land → ahead=0, empty source shortstat ────────────────────────────────────
  console.log('\n── 1. refreshCxellOriginMain after a land → 0 ahead, 0 dirty, empty source shortstat ──');
  {
    const fx = fixture('happy');
    process.env.FAKE_CXELL_REPO = fx.cxell;
    process.env.FAKE_REFRESH_MODE = '';
    const r = await refreshCxellOriginMain({
      ctx: 'default', slug: 'zt-refresh', worktree: fx.wt, ref: 'master',
    });
    ok(r.refreshed === true, `refreshed:true (got ${JSON.stringify(r)})`);
    ok(r.tip === fx.Z2, `tip is the landed sha (${String(r.tip).slice(0, 8)})`);
    const om = gq(fx.cxell, 'rev-parse', 'refs/remotes/origin/main').out;
    ok(om === fx.Z2, `cage origin/main now points at the landed tip (${String(om).slice(0, 8)})`);
    const after = parseCxellDiff(execFileSync('bash', ['-lc', cxellDiffScript(fx.B0, fx.cxell)], { encoding: 'utf8' }));
    ok(after.ahead === 0, `ahead is 0 after refresh (ahead=${after.ahead}) — acceptance`);
    ok(after.files === 0 && after.insertions === 0 && after.deletions === 0,
       `source shortstat is empty (files=${after.files} +${after.insertions}/−${after.deletions})`);
    ok(after.dirty === 0, `and dirty is 0 (dirty=${after.dirty})`);
    // the zee's branch / worktree / index must be untouched — refresh is a tracking-ref update only
    ok(gq(fx.cxell, 'rev-parse', 'HEAD').out === fx.Z2, 'HEAD is unchanged');
    ok(gq(fx.cxell, 'status', '--porcelain').out === '', 'worktree is still clean — no merge, no checkout');
    ok(!gq(fx.wt, 'rev-parse', '-q', '--verify', 'refs/zeehive/refresh').ok,
       'the staging ref refs/zeehive/refresh was cleaned up on the worktree');
  }

  // ── 2. a dead cxell returns refreshed:false and NEVER throws ───────────────────────────────────
  console.log('\n── 2. a dead / missing cxell returns refreshed:false and never throws ──');
  {
    const fx = fixture('dead');
    process.env.FAKE_CXELL_REPO = fx.cxell;
    process.env.FAKE_REFRESH_MODE = 'dead';
    let threw = null, r = null;
    try { r = await refreshCxellOriginMain({ ctx: 'default', slug: 'zt-dead', worktree: fx.wt, ref: 'master' }); }
    catch (e) { threw = e; }
    ok(!threw, `did NOT throw (threw=${threw && threw.message})`);
    ok(r && r.refreshed === false, `refreshed:false (got ${JSON.stringify(r)})`);
    ok(/unreachable|No such container|fetch refused/i.test(r.reason || ''),
       `reason names the dead cage (${JSON.stringify(r.reason)})`);
    // and the stale ref was left alone — we must not partially update anything
    ok(gq(fx.cxell, 'rev-parse', 'refs/remotes/origin/main').out === fx.B0,
       'origin/main is untouched when the cage is unreachable');
  }

  // ── 3. a missing xource ref returns refreshed:false and never throws ───────────────────────────
  console.log('\n── 3. a missing xource ref returns refreshed:false and never throws ──');
  {
    const fx = fixture('noref');
    process.env.FAKE_CXELL_REPO = fx.cxell;
    process.env.FAKE_REFRESH_MODE = '';
    let threw = null, r = null;
    try {
      r = await refreshCxellOriginMain({
        ctx: 'default', slug: 'zt-noref', worktree: fx.wt, ref: 'refs/heads/does-not-exist',
      });
    } catch (e) { threw = e; }
    ok(!threw, `did NOT throw (threw=${threw && threw.message})`);
    ok(r && r.refreshed === false, `refreshed:false (got ${JSON.stringify(r)})`);
    ok(/unreadable|no xource ref/i.test(r.reason || ''),
       `reason names the missing ref (${JSON.stringify(r.reason)})`);
  }

  // ── 4. absent inputs (no slug / no worktree / no ref) fail closed, never throw ─────────────────
  console.log('\n── 4. absent inputs fail closed without throwing ──');
  {
    const a = await refreshCxellOriginMain({ ctx: 'default', slug: '', worktree: '/nope', ref: 'master' });
    const b = await refreshCxellOriginMain({ ctx: 'default', slug: 'x', worktree: null, ref: 'master' });
    const c = await refreshCxellOriginMain({ ctx: 'default', slug: 'x', worktree: tmp, ref: null });
    ok(a.refreshed === false && b.refreshed === false && c.refreshed === false,
       `all three refuse closed (a=${a.reason}; b=${b.reason}; c=${c.reason})`);
  }

  // ── 5. the bundle is FULL (no --not) and the fetch mapping is the temp ref ─────────────────────
  console.log('\n── 5. source shape: FULL bundle via refs/zeehive/refresh, wired at the three call sites ──');
  {
    // Strip comments so a prose mention cannot satisfy the assertion.
    const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    ok(/export async function refreshCxellOriginMain\b/.test(code),
       'refreshCxellOriginMain is exported from cxell.js');
    ok(/bundle',\s*'create',\s*bundle,\s*'refs\/zeehive\/refresh'/.test(code)
       || /bundle', 'create', bundle, 'refs\/zeehive\/refresh'/.test(code)
       || /\[\s*'bundle',\s*'create',\s*bundle,\s*'refs\/zeehive\/refresh'\s*\]/.test(code),
       'the bundle is created from refs/zeehive/refresh (the temp tip)');
    ok(!/bundle',\s*'create',\s*bundle,\s*'refs\/zeehive\/refresh',\s*'--not'/.test(code),
       'and it is FULL — no --not boundary (a cage without the base must still fetch)');
    ok(/refs\/zeehive\/refresh:refs\/remotes\/origin\/main/.test(code),
       'the fetch maps the temp ref onto refs/remotes/origin/main only');
    ok(/refreshCxellOriginMain/.test(nudgeSrc) && /nudgeXellAfterLand/.test(nudgeSrc),
       'nudge.js imports/calls refreshCxellOriginMain from nudgeXellAfterLand');
    // The land-nudge must refresh BEFORE the resume — otherwise the worker wakes up and a manager
    // reading zee zees still sees the phantom. Pin the call order in source.
    const nudgeFn = nudgeSrc.slice(nudgeSrc.indexOf('export async function nudgeXellAfterLand'));
    const refreshAt = nudgeFn.indexOf('refreshCxellOriginMain');
    const resumeAt = nudgeFn.indexOf('nudgeCxell(');
    ok(refreshAt >= 0 && resumeAt > refreshAt,
       'nudgeXellAfterLand refreshes origin/main BEFORE resuming the worker');
    ok(/refreshCxellOriginMain/.test(selfSrc) && /push\.landed/.test(selfSrc),
       'self.js calls refreshCxellOriginMain on the push.landed path');
    ok(/selfHealSync[\s\S]*refreshCxellOriginMain/.test(selfSrc)
       || /refreshCxellOriginMain[\s\S]*selfHealSync/.test(selfSrc),
       'selfHealSync also refreshes on merged/up-to-date (belt-and-suspenders with deliver)');
  }

} finally {
  process.env.PATH = REAL_PATH;
  delete process.env.FAKE_CXELL_REPO;
  delete process.env.FAKE_REFRESH_MODE;
  rmSync(tmp, { recursive: true, force: true });
}

console.log(fail ? `\n${fail} FAILURE(S)` : '\nall passed');
process.exit(fail ? 1 : 0);
