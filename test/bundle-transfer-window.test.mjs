// A CAGE'S REPO BUNDLE MUST NOT DIE ON A FIXED TRANSFER WINDOW — the omnibiz dispatch failure.
//
// THE SYMPTOM. "i can't deploy a router or anything on omnibiz: cxell build failed: docker cp timed
// out after 120000ms" — every dispatch on one project, with a message that names neither the payload
// nor the stage and reads like it was talking about a build (it is not: a router deploy builds
// nothing; what failed was the CAGE build, and inside it the code transfer).
//
// THE CAUSE. `cloneIntoCxell` (server/src/lib/cxell.js) builds a cage around a private clone of the
// xell's branch, handed to it as ONE git bundle over `docker cp`. That single transfer is the only
// step of a cage build whose size scales with the REPOSITORY — everything else on the path is a few
// KB or a local exec — and it ran on dk()'s 120s default: a guess about throughput, not a
// measurement of the payload. This fleet's measured rate for big payloads is ~1.5-3 MB/s
// (queenzee/maintenance.js documents the same measurement killing the fixed backup window), so a
// project with enough history simply cannot be dispatched, and NOTHING said the repository was the
// payload.
//
// THE FIX. The window is sized from the bundle's bytes (lib/transfer-window.js — one rule, shared
// with the backup stream window), floored at dk's own 120s default so no transfer is ever given a
// shorter window than it has today, ceilinged so a wedged daemon still dies and says why, and the
// failure now names the payload, the window, and the stage.
//
// HOW THIS IS DRIVEN. A cxell has no docker socket, so `docker` here is a shim on PATH: `cp` really
// copies the bundle into a temp dir, `exec` runs the exec'd script with /work/repo rewritten to a
// real throwaway git repo. That is the REAL cloneIntoCxell, the REAL bundle, the REAL dk() spawn and
// timeout, real git. WHAT IT CANNOT EXERCISE: the docker hop itself (a live cage), the throughput of
// a real transfer, and whether the ceiling is high enough for a repository larger than this fixture.
// The call sites that were NOT driven (the sync/post-land bundle copies) are pinned at source level
// below — the same technique test/cxell-origin-main-refresh.test.mjs uses for its wiring.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };

const tmp = mkdtempSync(join(tmpdir(), 'bundletw-'));
const REAL_PATH = process.env.PATH;
const BRANCH = 'spinoff/zt-bundle';

const GIT_ID = ['-c', 'user.name=fixture', '-c', 'user.email=fixture@test'];
const g = (cwd, ...a) => String(execFileSync('git', ['-C', cwd, ...GIT_ID, ...a], { encoding: 'utf8' })).trim();

// A worktree on a branch with real history, and a "cage" dir the shim's exec clones into.
function fixture(name) {
  const root = join(tmp, name);
  const wt = join(root, 'wt');
  mkdirSync(wt, { recursive: true });
  g(wt, 'init', '-q', '-b', BRANCH);
  writeFileSync(join(wt, 'README.md'), 'BASE\n');
  g(wt, 'add', '-A'); g(wt, 'commit', '-qm', 'base');
  // Some history, so the bundle is not a degenerate empty pack.
  for (let i = 0; i < 5; i++) {
    writeFileSync(join(wt, `f${i}.txt`), `line ${i}\n`.repeat(50));
    g(wt, 'add', '-A'); g(wt, 'commit', '-qm', `commit ${i}`);
  }
  const head = g(wt, 'rev-parse', 'HEAD');
  return { root, wt, head, cage: join(root, 'cage'), fakeTmp: join(root, 'cagetmp') };
}

try {
  // ── the shim: `docker cp` really copies (into $FAKE_TMP), `docker exec` runs the script locally ──
  const bin = join(tmp, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'docker'), [
    '#!/usr/bin/env bash',
    '# stand-in for the docker CLI (see the header of test/bundle-transfer-window.test.mjs)',
    'if [ "$1" = "--context" ]; then shift 2; fi',
    'case "$1" in',
    '  cp)',
    '    src=$2; dst=${3#*:}',
    '    if [ "$FAKE_CP_MODE" = slow ]; then sleep 5; fi',
    '    dst=${dst//\\/tmp\\//$FAKE_TMP/}',
    '    mkdir -p "$(dirname "$dst")"',
    '    cp "$src" "$dst" || exit $?',
    // Record the size here: cloneIntoCxell removes /tmp/task.bundle from the cage once the clone is
    // done (the bundle is a one-shot delivery), so by the time the test could stat it, it is gone.
    '    wc -c < "$dst" > "$FAKE_TMP/.cp-size"',
    '    exit 0 ;;',
    '  exec) shift ;;',
    '  *) exit 0 ;;',
    'esac',
    '# strip exec flags and the container name',
    'while :; do case "$1" in -i) shift ;; -u|-e) shift 2 ;; *) break ;; esac; done',
    'name=$1; shift',
    'if [ "$1" != bash ]; then',
    '  args=(); for a in "$@"; do args+=("${a//\\/tmp\\//$FAKE_TMP/}"); done; exec "${args[@]}"',
    'fi',
    'shift; [ "$1" = -lc ] && shift',
    '# ORDER MATTERS: translate /tmp FIRST, because $FAKE_CXELL_REPO itself lives under /tmp, and',
    '# the other order re-prefixes the cage path with the fake tmp dir (watched it happen).',
    'script=${1//\\/tmp\\//$FAKE_TMP/}',
    'script=${script//\\/work\\/repo/$FAKE_CXELL_REPO}',
    'exec bash -lc "$script"',
  ].join('\n'), { mode: 0o755 });
  process.env.PATH = `${bin}:${REAL_PATH}`;
  process.env.FAKE_TMP = join(tmp, 'cagetmp');
  mkdirSync(process.env.FAKE_TMP, { recursive: true });

  const C = await import('../server/src/lib/cxell.js');
  const { recentLogs } = await import('../server/src/lib/logbus.js');
  const {
    cloneIntoCxell, bundleTransferWindowMs, BUNDLE_WINDOW_FLOOR_MS, BUNDLE_WINDOW_CEILING_MS, CLONE_EXEC_FLOOR_MS,
    bundleSizeText, windowText,
  } = C;
  const src = readFileSync(join(ROOT, 'server/src/lib/cxell.js'), 'utf8');

  // ── 1. the window is a function of the bytes, and never SHORTER than the old fixed default ──────
  console.log('\n── 1. the transfer window is sized from the payload ──');
  {
    const MiB = 1024 * 1024;
    ok(BUNDLE_WINDOW_FLOOR_MS === 120000,
      `the floor is dk's own default (${BUNDLE_WINDOW_FLOOR_MS}ms) — no transfer gets a shorter window than today`);
    ok(bundleTransferWindowMs(null) === BUNDLE_WINDOW_FLOOR_MS && bundleTransferWindowMs(0) === BUNDLE_WINDOW_FLOOR_MS,
      'an unknown or empty payload → the floor, not a zero window');
    ok(bundleTransferWindowMs(4 * 1024) === BUNDLE_WINDOW_FLOOR_MS,
      'a small bundle (KiB) → still the floor — every ordinary repo is unchanged by this fix');
    ok(bundleTransferWindowMs(100 * MiB) === 200_000,
      `a 100 MiB bundle → 200s (size/1MiB/s × 2 margin), past the 120s that killed omnibiz (got ${bundleTransferWindowMs(100 * MiB)})`);
    // THE regression: the window this fix exists for — a payload that cannot cross in 120s.
    ok(bundleTransferWindowMs(400 * MiB) === 800_000,
      `a 400 MiB bundle (omnibiz-sized history) → ${bundleTransferWindowMs(400 * MiB) / 1000}s, NOT the old 120s`);
    ok(bundleTransferWindowMs(30 * 1024 * MiB) === BUNDLE_WINDOW_CEILING_MS,
      `a huge bundle is capped at the ceiling (${BUNDLE_WINDOW_CEILING_MS / 60000} min) — a wedged daemon still dies`);
    ok(bundleTransferWindowMs(200 * MiB) > bundleTransferWindowMs(100 * MiB)
       && bundleTransferWindowMs(100 * MiB) > bundleTransferWindowMs(50 * MiB),
      'the window is monotonic in size between the floor and the cap');
    ok(CLONE_EXEC_FLOOR_MS === 300000,
      `the in-cage clone/unpack keeps its 300s floor (${CLONE_EXEC_FLOOR_MS}ms) and grows with the same payload`);
    // An operator with a bigger repository than the estimate allows has a knob, not a code change.
    const child = execFileSync(process.execPath, ['-e',
      "import('./server/src/lib/cxell.js').then(m => console.log(m.bundleTransferWindowMs(1024*1024*1024)))"],
      { encoding: 'utf8', cwd: ROOT, env: { ...process.env, CXELL_BUNDLE_MIN_RATE: String(4 * 1024 * 1024) } }).trim();
    ok(Number(child) === 512_000,
      `CXELL_BUNDLE_MIN_RATE widens the estimate without a code change (1 GiB at 4 MiB/s → ${Number(child) / 1000}s,`
      + ' where the 1 MiB/s default needs 1800s)');
  }

  // ── 2. the real cloneIntoCxell: the bundle lands, the cage gets the branch, the SIZE is reported ─
  console.log('\n── 2. the real clone, driven through a docker shim ──');
  const fx = fixture('happy');
  process.env.FAKE_CXELL_REPO = fx.cage;
  process.env.FAKE_TMP = fx.fakeTmp;
  mkdirSync(fx.fakeTmp, { recursive: true });
  process.env.FAKE_CP_MODE = '';
  {
    const before = recentLogs(2000).length;
    const r = await cloneIntoCxell({ ctx: 'default', name: 'cxell_zt-bundle', worktree: fx.wt });
    ok(r.updated === false, 'a fresh cage → the clone path (not the in-place update)');
    ok(g(fx.cage, 'rev-parse', '--abbrev-ref', 'HEAD') === BRANCH,
      `the cage holds the branch (${g(fx.cage, 'rev-parse', '--abbrev-ref', 'HEAD')})`);
    ok(g(fx.cage, 'rev-parse', 'HEAD') === fx.head, `at the worktree's tip (${fx.head.slice(0, 8)})`);
    const sizeFile = join(fx.fakeTmp, '.cp-size');
    ok(existsSync(sizeFile), 'the bundle really crossed the shim\'s docker cp');
    const bytes = Number(readFileSync(sizeFile, 'utf8').trim());
    ok(Number.isFinite(bytes) && bytes > 0, `…and its size is known to the shim (${bytes} bytes)`);
    const said = recentLogs(2000).slice(before).map((l) => l.msg).find((m) => m.includes('sending the repo bundle in'));
    ok(!!said, `the spawn log names the transfer (${JSON.stringify(said)})`);
    const size = bundleSizeText(bytes);
    ok(String(said).includes(size),
      `…with the payload's REAL size (${size} for ${bytes} bytes) — measured from the file, not guessed`);
    ok(String(said).includes(`window ${windowText(bundleTransferWindowMs(bytes))}`),
      '…and the window that size maps to, so a slow spawn is attributable from the log alone');
  }

  // ── 3. a transfer that does NOT finish names the payload and the stage (the reported bug) ───────
  console.log('\n── 3. a timed-out transfer says WHAT was being transferred, and that it was not a build ──');
  {
    const fx2 = fixture('timeout');
    process.env.FAKE_CXELL_REPO = fx2.cage;
    process.env.FAKE_TMP = fx2.fakeTmp;
    mkdirSync(fx2.fakeTmp, { recursive: true });
    process.env.FAKE_CP_MODE = 'slow';   // the cp hangs; the injected window must cut it, not the daemon
    // The seam: the window is injectable, so the timeout path is exercised in milliseconds rather
    // than waited out (the same shape as installZeeCliIntoCxell's timeoutMs parameter).
    let err = null;
    try { await cloneIntoCxell({ ctx: 'default', name: 'cxell_zt-slow', worktree: fx2.wt, windowFor: () => 400 }); }
    catch (e) { err = e; }
    process.env.FAKE_CP_MODE = '';
    ok(!!err, 'the transfer that never lands throws rather than handing the cage a half-built tree');
    ok(/the repo bundle \(\d+(\.\d+)? (B|KiB|MiB)\) did not reach cxell_zt-slow within [\d.]+(ms|s)/
      .test(err?.message || ''),
      `the error names the payload and the window (${String(err?.message).slice(0, 120)}…)`);
    ok(/docker cp timed out after 400ms/.test(err?.message || ''),
      '…and carries the underlying docker failure, so the timeout is not swallowed');
    ok(/CAGE's code transfer, not an app build/.test(err?.message || ''),
      '…and says the stage out loud — the exact confusion ("build should not be necessary for routers") the bare message caused');
    ok(/CXELL_BUNDLE_MIN_RATE/.test(err?.message || ''),
      '…and names the lever for a repository that is genuinely this large');
  }

  // ── 4. every host→cage bundle copy carries a sized window (the call sites not driven above) ─────
  console.log('\n── 4. no bundle copy is left on the bare default window ──');
  {
    const unnoticed = src.split('\n')
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => /dk\(ctx, \['cp', bundle,/.test(line))
      .filter(({ line }) => !/timeoutMs:/.test(line));
    ok(unnoticed.length === 0,
      `every \`cp bundle\` in cxell.js is sized (unsized: ${unnoticed.map((u) => u.n).join(', ') || 'none'})`);
    ok((src.match(/bundleTransferWindowMs\(statSync\(bundle\)\.size\)/g) || []).length === 3,
      'the sync delivery (thin + full fallback) and the post-land refresh are all sized from their bytes');
    ok(/const cloneMs = Math\.max\(CLONE_EXEC_FLOOR_MS, transferMs\);/.test(src)
       && /markers: CLONE_MARKERS, label: `\$\{name\}: clone`, timeoutMs: cloneMs/.test(src),
      'the in-cage clone/unpack uses the same sized window, so a big bundle cannot die one step later');
  }
} finally {
  process.env.PATH = REAL_PATH;
  rmSync(tmp, { recursive: true, force: true });
}
console.log(`\n${failures === 0 ? 'ALL PASSED ✓' : `${failures} FAILURE(S) ✗`}`);
process.exit(failures === 0 ? 0 : 1);
