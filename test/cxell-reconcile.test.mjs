// CXELL RECONCILE — proves a caged zee can reconcile with main on its own, and (the highest-value
// change) that a collect that does NOT fast-forward ANCHORS the cxell's commits instead of stranding
// them. All pure git against scratch repos (no docker), exercising the REAL functions under test:
//   • reconcileBundleIntoWorktree (cxell.js) — the pure-git core of `zee land`'s collect
//   • classifyMergeOutput        (xellgit.js) — conflict vs operational-error, the distinction that
//                                               now reaches a caged zee (Change 4)
//
// The docker wrappers (deliverXourceIntoCxell / syncCxellWithXource) can't run without a container,
// so their GIT MECHANICS are reproduced here with the exact commands they issue, proving the
// end-to-end reconciliation: deliver main → fetch origin/main → merge → collect fast-forwards.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { reconcileBundleIntoWorktree } = await import('../server/src/lib/cxell.js');
const { classifyMergeOutput } = await import('../server/src/queenzee/xellgit.js');

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };
const ID = ['-c', 'user.name=setup', '-c', 'user.email=setup@test'];
const g = (cwd, args) => {
  const r = spawnSync('git', ['-C', cwd, ...ID, ...args], { encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
};
const gx = (cwd, args) => { const r = g(cwd, args); if (!r.ok) throw new Error(`git ${args.join(' ')}: ${r.err || r.out}`); return r.out; };
const rev = (cwd, ref) => gx(cwd, ['rev-parse', ref]);
const contains = (cwd, anc, desc) => g(cwd, ['merge-base', '--is-ancestor', anc, desc]).ok;
// is `commit` reachable from ANY ref in this repo? (a stranded commit is reachable from none)
const reachableFromSomeRef = (cwd, commit) => {
  const all = g(cwd, ['rev-list', '--all']).out.split('\n').filter(Boolean);
  return all.includes(commit);
};
const write = (dir, f, c) => writeFileSync(join(dir, f), c);
const commit = (dir, f, c, m) => { write(dir, f, c); gx(dir, ['add', '-A']); gx(dir, ['commit', '-m', m]); return rev(dir, 'HEAD'); };

const roots = [];
function scratchSrc() {
  const root = mkdtempSync(join(tmpdir(), 'cxrec-src-')); roots.push(root);
  const src = join(root, 'src'); mkdirSync(src);
  gx(src, ['init', '-b', 'master']);
  const B0 = commit(src, 'base.txt', 'base\n', 'base');
  return { root, src, B0 };
}
// mimic caging: a private clone of the branch at B0 (the cxell's /work/repo), whose only remote is
// the frozen task bundle — exactly the cxell's starting condition.
function cageCxell(root, src, branch) {
  const cxell = join(root, 'cxell');
  const bundle = join(root, 'task.bundle');
  gx(src, ['branch', branch]);
  gx(src, ['bundle', 'create', bundle, branch]);
  gx(root, ['clone', '-q', '-b', branch, bundle, cxell]);
  return cxell;
}
// mimic exportCxellDiff: bundle the cxell branch minus everything already on a remote.
function cxellOutBundle(root, cxell, branch) {
  const bundle = join(root, `out-${Math.random().toString(36).slice(2)}.bundle`);
  gx(cxell, ['bundle', 'create', bundle, branch, '--not', '--remotes']);
  return bundle;
}

const BRANCH = 'spinoff/test';

// ── 1. THE STRANDING BUG: a diverged worktree + cxell commits ─────────────────
// Reproduce today's failure: catch-up merged main INTO the host worktree behind the zee (a merge
// commit the cxell lacks), then the cxell committed. The collect can no longer fast-forward.
console.log('1) a non-fast-forward collect ANCHORS the cxell commits instead of stranding them');
{
  const { root, src, B0 } = scratchSrc();
  const cxell = cageCxell(root, src, BRANCH);
  const C1 = commit(cxell, 'work.txt', 'zee work\n', 'cxell work');          // cxell adds a commit
  // master advances, and the host worktree gets a merge of it INTO the branch (the old catch-up)
  const A1 = commit(src, 'src.txt', 'moved\n', 'master moves');
  const wt = join(root, 'wt');
  gx(root, ['clone', '-q', '-b', BRANCH, src, wt]);
  gx(wt, ['merge', '--no-ff', '--no-edit', 'origin/master', '-m', 'Merge master into spinoff/test']);
  const M = rev(wt, 'HEAD');
  ok(!contains(wt, M, C1) && !contains(cxell, M, 'HEAD'), 'setup: worktree merge M and cxell C1 have DIVERGED (no ff possible)');

  const bundle = cxellOutBundle(root, cxell, BRANCH);

  // (a) OLD behaviour — delete the staging ref on an ff miss → C1 reachable from NO ref (stranded)
  {
    const wtOld = join(root, 'wt-old');
    gx(root, ['clone', '-q', '-b', BRANCH, src, wtOld]);
    gx(wtOld, ['merge', '--no-ff', '--no-edit', 'origin/master', '-m', 'Merge master into spinoff/test']);
    gx(wtOld, ['fetch', bundle, `${BRANCH}:refs/zeehive/cxell-land`]);
    ok(reachableFromSomeRef(wtOld, C1), 'OLD: after fetch, C1 is reachable (via the staging ref)');
    const ff = g(wtOld, ['merge', '--ff-only', 'refs/zeehive/cxell-land']);
    ok(!ff.ok, 'OLD: --ff-only refuses the diverged worktree');
    gx(wtOld, ['update-ref', '-d', 'refs/zeehive/cxell-land']);       // ← the stranding line
    ok(!reachableFromSomeRef(wtOld, C1), 'OLD: after the delete, C1 is reachable from NO ref → GC-eligible (STRANDED)');
  }

  // (b) NEW behaviour — reconcileBundleIntoWorktree anchors the work under refs/zeehive/stranded/<slug>
  {
    let threw = null;
    try { await reconcileBundleIntoWorktree(wt, { bundle, slug: BRANCH }); }
    catch (e) { threw = e; }
    ok(threw && /do not fast-forward/i.test(threw.message), 'NEW: reports the non-fast-forward (blocked, not silent)');
    ok(threw && threw.strandedRef === `refs/zeehive/stranded/${BRANCH.replace(/[^A-Za-z0-9._/-]/g, '-')}`, 'NEW: error carries the stranded ref name');
    ok(g(wt, ['rev-parse', threw?.strandedRef]).out === C1, 'NEW: the stranded ref points AT the cxell commit C1');
    ok(reachableFromSomeRef(wt, C1), 'NEW: C1 is still reachable → GC-proof, recoverable (NOT stranded)');
    ok(!g(wt, ['rev-parse', 'refs/zeehive/cxell-land']).ok, 'NEW: the transient staging ref was released (only the durable anchor remains)');
    ok(/anchored/i.test(threw.message), 'NEW: the message tells the zee its work is anchored and safe');
  }
}

// ── 2. RECONCILE SUCCESS: after the zee merges current main, the collect fast-forwards ───────────
// The Change-1 claim, verified rather than assumed: with the worktree read-only for catch-up (it
// stays at a commit that is on master), delivering main into the cxell and merging it there makes the
// cxell HEAD descend from master, so the collect --ff-only succeeds.
console.log('2) delivering main into the cxell + merging there makes the collect fast-forward (self-heal)');
{
  const { root, src, B0 } = scratchSrc();
  const cxell = cageCxell(root, src, BRANCH);
  const C1 = commit(cxell, 'work.txt', 'zee work\n', 'cxell work');
  const A1 = commit(src, 'src.txt', 'moved\n', 'master moves');   // main moved since caging
  // host worktree stays at the caged base B0 (Change 1: never merged behind the zee) — B0 is on master
  const wt = join(root, 'wt');
  gx(root, ['clone', '-q', '-b', BRANCH, src, wt]);
  gx(wt, ['reset', '--hard', B0]);
  ok(rev(wt, 'HEAD') === B0 && contains(src, rev(wt, 'HEAD'), 'master'), 'setup: worktree sits at B0, which is on master');

  // SELF-HEAL mechanics: deliver main → fetch origin/main → merge (the exact commands the sync issues)
  const mainBundle = join(root, 'main.bundle');
  const base = B0; // the caging base — present in both src and cxell (deliver uses merge-base(ref, wtHEAD), = B0 here)
  gx(src, ['bundle', 'create', mainBundle, 'master', '--not', base]);
  gx(cxell, ['fetch', '-f', mainBundle, 'master:refs/remotes/origin/main']);
  const mg = g(cxell, ['merge', '--no-edit', 'refs/remotes/origin/main']);
  ok(mg.ok, 'sync: cxell merges origin/main cleanly (no conflict)');
  const C2 = rev(cxell, 'HEAD');
  ok(contains(cxell, A1, C2), 'sync: cxell HEAD now DESCENDS from the current master tip A1');

  // COLLECT now fast-forwards
  const bundle = cxellOutBundle(root, cxell, BRANCH);
  const res = await reconcileBundleIntoWorktree(wt, { bundle, slug: BRANCH });
  ok(res.collected && res.head === C2, 'collect: --ff-only SUCCEEDS → worktree advanced to the merged cxell HEAD');
  ok(contains(wt, A1, rev(wt, 'HEAD')), 'collect: worktree HEAD contains master → the push that follows is a real fast-forward');
}

// ── 3. GENUINE CONFLICT: reported as a conflict (the zee's to resolve), ref retained ─────────────
console.log('3) a genuine content conflict is classified as a conflict (not an operational error)');
{
  const { root, src, B0 } = scratchSrc();
  const cxell = cageCxell(root, src, BRANCH);
  const C1 = commit(cxell, 'base.txt', 'ZEE edit\n', 'cxell edits base.txt');
  const A1 = commit(src, 'base.txt', 'MASTER edit\n', 'master edits base.txt');  // overlapping edit
  const mainBundle = join(root, 'main.bundle');
  const base = B0; // the caging base — present in both src and cxell (deliver uses merge-base(ref, wtHEAD), = B0 here)
  gx(src, ['bundle', 'create', mainBundle, 'master', '--not', base]);
  gx(cxell, ['fetch', '-f', mainBundle, 'master:refs/remotes/origin/main']);
  const mg = g(cxell, ['merge', '--no-edit', 'refs/remotes/origin/main']);
  ok(!mg.ok, 'sync: the overlapping edits make the merge fail');
  const cls = classifyMergeOutput(`${mg.out}\n${mg.err}`);
  ok(cls.state === 'conflict', `classified as 'conflict' (the zee's to resolve) — got '${cls.state}'`);
  // the merge is LEFT in progress (MERGE_HEAD set) so the zee can resolve in place
  ok(g(cxell, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).ok, 'the merge is left in progress in the cxell for the zee to resolve');
  // an operational failure (no identity, hook refusal, unreadable object) is NOT called a conflict
  ok(classifyMergeOutput('fatal: unable to auto-detect email address (got root@host)').state === 'error',
     'an operational failure is classified as an ERROR, not a phantom conflict');
}

for (const r of roots) rmSync(r, { recursive: true, force: true });
console.log(failures === 0 ? '\nALL GREEN' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
