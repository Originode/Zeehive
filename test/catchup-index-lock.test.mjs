// CATCH-UP STALE INDEX.LOCK SELF-HEAL — proves catchUpWorktree (queenzee/xellgit.js) heals a STALE
// index.lock in the worktree admin dir, the catch-up-path twin of the collect-path fix (TKT-86-B3B2,
// which landed for reconcileBundleIntoWorktree only). A git process that crashed mid-write leaves
// index.lock behind; every `git -C <worktree>` index-touching op (merge/stash/commit) then dies with
// "Unable to create '.../index.lock': File exists", and on the CATCH-UP path for a HOST xell that
// lock lives on the host, where a caged zee can neither see nor delete it — taking the zee out of
// service exactly as the collect path used to. The catch-up now resolves the admin dir
// (`git rev-parse --absolute-git-dir` — for a linked worktree that is <repo>/.git/worktrees/<name>),
// clears a STALE lock (present + mtime older than a few minutes — no live op), and retries the failed
// op ONCE. A FRESH lock is never deleted — a live git process may be holding it.
//
// Both sides are asserted: stale → catch-up succeeds and the lock is gone; fresh → catch-up still
// refuses and the lock is preserved. All pure git against scratch repos, no docker.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, utimesSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { catchUpWorktree } = await import('../server/src/queenzee/xellgit.js');

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };
const ID = ['-c', 'user.name=setup', '-c', 'user.email=setup@test'];
const g = (cwd, args) => {
  const r = spawnSync('git', ['-C', cwd, ...ID, ...args], { encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
};
const gx = (cwd, args) => { const r = g(cwd, args); if (!r.ok) throw new Error(`git ${args.join(' ')}: ${r.err || r.out}`); return r.out; };
const rev = (cwd, ref) => gx(cwd, ['rev-parse', ref]);
const write = (dir, f, c) => writeFileSync(join(dir, f), c);
const commit = (dir, f, c, m) => { write(dir, f, c); gx(dir, ['add', '-A']); gx(dir, ['commit', '-m', m]); return rev(dir, 'HEAD'); };

const BRANCH = 'spinoff/test';

// A linked-worktree shape: src has master that ADVANCES past a base, and a separate branch checked
// out in the worktree at that base — so catchUpWorktree(wt, 'master') must fast-forward, which is the
// index-touching merge a stale index.lock would have bricked. Each block cleans its own root up in a
// `finally`; nothing accumulates across blocks.
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'cup-lock-'));
  const src = join(root, 'src'); mkdirSync(src);
  gx(src, ['init', '-b', 'master']);
  const B0 = commit(src, 'base.txt', 'base\n', 'base');
  gx(src, ['branch', BRANCH]);                       // a separate lane parked at the base
  const A1 = commit(src, 'src.txt', 'moved\n', 'master moves');   // master advances past B0
  const wt = join(root, 'wt');
  gx(src, ['worktree', 'add', '-q', wt, BRANCH]);    // linked worktree → admin dir <src>/.git/worktrees/<name>
  return { root, src, wt, B0, A1 };
}
const adminDirOf = (wt) => gx(wt, ['rev-parse', '--absolute-git-dir']);
// 10 minutes back — comfortably older than the ~5-minute STALE_INDEX_LOCK_MS threshold, so the test
// does not depend on that constant's exact value.
const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000);

console.log('catch-up with a STALE index.lock in the worktree admin dir self-heals; a FRESH one still refuses');
{
  // (a) STALE lock → catch-up succeeds and the lock is gone (self-heal)
  {
    const { root, src, wt, B0, A1 } = setup();
    try {
      ok(rev(wt, 'HEAD') === B0 && rev(src, 'master') === A1, 'setup: worktree is BEHIND master (a ff-only merge is what follows)');
      ok(/worktrees\//.test(adminDirOf(wt)), 'setup: linked worktree admin dir is <repo>/.git/worktrees/<name>');
      const lockPath = join(adminDirOf(wt), 'index.lock');
      write(adminDirOf(wt), 'index.lock', '');       // a lock a crashed git process left behind
      utimesSync(lockPath, tenMinAgo, tenMinAgo);    // …and it is STALE (mtime 10 min old)

      const res = catchUpWorktree(wt, 'master', { slug: 'test' });
      ok(res.state === 'fast-forwarded', `STALE lock: catch-up SUCCEEDS (self-heal) → 'fast-forwarded' (got '${res.state}'${res.output ? ` — ${res.output.split('\n').pop()}` : ''})`);
      ok(!existsSync(lockPath), 'STALE lock: the lock file is GONE after the catch-up');
      ok(rev(wt, 'HEAD') === A1, 'STALE lock: the worktree advanced to the master tip (the push that follows is a real fast-forward)');
    } finally { rmSync(root, { recursive: true, force: true }); }
  }

  // (b) FRESH lock → catch-up still refuses exactly as today, and the lock is PRESERVED
  {
    const { root, src, wt } = setup();
    try {
      const lockPath = join(adminDirOf(wt), 'index.lock');
      write(adminDirOf(wt), 'index.lock', '');       // FRESH — current mtime, a live git op may hold it

      const res = catchUpWorktree(wt, 'master', { slug: 'test' });
      ok(res.state === 'error', `FRESH lock: catch-up still REFUSES with a classified ERROR (got '${res.state}')`);
      ok(/File exists/i.test(res.output || ''), `FRESH lock: the failure names the lock — "File exists" (output: ${JSON.stringify(String(res.output || '').slice(0, 120))})`);
      ok(existsSync(lockPath), 'FRESH lock: the lock is PRESERVED (never deleted)');
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
}

console.log(failures === 0 ? '\nALL GREEN' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
