// XOURCE-CLEAN test — a mangled project xource (dirty/conflicted main checkout) wedges every
// landing and ship; the queenzee can now un-wedge it, and a MANAGER can ask a human to.
//
// Covers the two doors onto the same engine (lib/xource-clean.js):
//   • xourceState reads the truth (clean vs MANGLED, and WHY) off a real git repo;
//   • performXourceClean resets a mangled repo to the main tip — aborting an in-progress merge,
//     discarding staged/uncommitted changes, removing untracked junk, and PRESERVING a
//     .claude/worktrees/ xell worktree;
//   • requestXourceClean raises a pending row for a manager, and selfXourceClean REFUSES a worker;
//   • decideXourceClean approve → the queenzee performs the clean and lands the receipt; reject →
//     nothing is touched;
//   • listXourceCleanRequests / xourceCleanStatusFor surface the ask and its outcome.
//
// Runs the REAL paths against a throwaway postgres + a REAL git repo (PROVISION_MODE=real so the
// approve actually resets the checkout). No mocks of the logic under test.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.PROVISION_MODE = 'real';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const { q, one, pool } = await import('../server/src/db/pool.js');
const { xourceState, performXourceClean, commitXourceStaged, commitXourceDirty, stashXource, requestXourceClean,
        decideXourceClean, listXourceCleanRequests, xourceCleanStatusFor }
  = await import('../server/src/lib/xource-clean.js');
const { xourcePatch } = await import('../server/src/lib/diffview.js');
const { selfXourceClean } = await import('../server/src/queenzee/self.js');

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };
const git = (cwd, args, allowFail = false) => {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  if (r.status !== 0 && !allowFail) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
};

// ── 1. a real git repo, seeded with a main branch ─────────────────────────────
const tmp = mkdtempSync(join(tmpdir(), 'xource-clean-'));
const src = join(tmp, 'xource');
// NOTE: init INSIDE the already-created dir rather than `git -C <tmp> init <subdir>` — the
// `-C` + relative-subdir form does not create the subdir in this environment's git.
mkdirSync(src, { recursive: true });
git(src, ['init', '-q', '-b', 'main']);
git(src, ['config', 'user.email', 'test@zeehive.local']);
git(src, ['config', 'user.name', 'test']);
git(src, ['config', 'receive.denyCurrentBranch', 'ignore']);
writeFileSync(join(src, 'a.txt'), 'A\n');
git(src, ['add', '.']);
git(src, ['commit', '-qm', 'A (base)']);

// ── 2. throwaway rows: a project + a MANAGER xell (and a worker for the refusal) ─
await q(`DELETE FROM project WHERE name='xourcecleantest'`);
const project = await one(
  `INSERT INTO project (name, repo_root, main_branch)
   VALUES ('xourcecleantest', $1, 'main') RETURNING *`, [src]);
const xource = await one(
  `INSERT INTO xource (project_id, ref) VALUES ($1, 'main') RETURNING *`, [project.id]);
const manager = await one(
  `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, head_commit, status, zee_type, self_token_hash)
   VALUES ($1,$2,'xc-manager','spinoff/xc-manager',$3,'head','working','manager','xc-manager-hash') RETURNING *`,
  [project.id, xource.id, src]);
const worker = await one(
  `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, head_commit, status, zee_type, self_token_hash)
   VALUES ($1,$2,'xc-worker','spinoff/xc-worker',$3,'head','working','worker','xc-worker-hash') RETURNING *`,
  [project.id, xource.id, join(tmp, 'worker-wt')]);

try {
  // ── 3. the CLEAN read ──────────────────────────────────────────────────────
  console.log('\n── the read model on a clean xource ──');
  const cleanState = xourceState(src, 'main');
  ok(cleanState.ok === true, 'xourceState reads a git repo');
  ok(cleanState.clean === true, 'a fresh checkout is CLEAN');
  ok(cleanState.blocked === false, 'and NOT blocked');
  ok(cleanState.branch === 'main', `branch is main (${cleanState.branch})`);
  ok(cleanState.dirty === 0, '0 dirty paths');

  // ── 4. mangle it: staged change + untracked junk + an in-progress merge ─────
  console.log('\n── a MANGLED xource reads as blocked, and says why ──');
  writeFileSync(join(src, 'b.txt'), 'staged change\n');
  git(src, ['add', 'b.txt']);
  writeFileSync(join(src, 'junk.tmp'), 'untracked junk\n');
  git(src, ['checkout', '-q', '-b', 'other']);           // make a branch that conflicts
  writeFileSync(join(src, 'a.txt'), 'B\n');
  git(src, ['add', 'a.txt']);
  git(src, ['commit', '-qm', 'other branch']);
  git(src, ['checkout', '-q', 'main']);
  writeFileSync(join(src, 'a.txt'), 'C\n');              // main also changed a.txt
  git(src, ['add', 'a.txt']);
  git(src, ['commit', '-qm', 'main conflict side']);
  git(src, ['merge', '--no-commit', 'other'], true);      // conflict → MERGE_HEAD left behind
  const mangled = xourceState(src, 'main');
  ok(mangled.clean === false, 'mangled xource is NOT clean');
  ok(mangled.blocked === true, 'and reads as BLOCKED (landings/ships blocked)');
  ok(mangled.merge_in_progress === true, 'a MERGE is in progress');
  ok(mangled.dirty > 0, `uncommitted path(s) counted (${mangled.dirty})`);
  ok((mangled.summary || '').includes('BLOCKED'), 'summary says the block out loud');
  ok(!mangled.untracked.some((p) => p.startsWith('.claude')),
     '.claude/ worktrees are not counted as dirt in the read model');

  // A xell worktree to preserve — the one untracked thing a clean must NEVER delete.
  const keepDir = join(src, '.claude', 'worktrees', 'keep-me');
  mkdirSync(keepDir, { recursive: true });
  writeFileSync(join(keepDir, 'file.txt'), 'do not delete\n');

  // ── 5. the manager ASKS (a pending request), a worker is REFUSED ───────────
  console.log('\n── the manager requests a clean; a worker is refused ──');
  const workerRefusal = await selfXourceClean(worker, { reason: 'let me nuke main' });
  ok(workerRefusal?.ok === false && workerRefusal?.status === 'refused',
     'a WORKER calling zee xource-clean is REFUSED (resetting the xource is not a per-xell act)');
  ok(/MANAGER verb/.test(workerRefusal?.error || ''), 'and the refusal names the MANAGER verb');
  const noReason = await selfXourceClean(manager, { reason: '' });
  ok(noReason?.ok === false, 'xource-clean without a reason is refused (the reason is what a human reads)');

  const asked = await requestXourceClean({ xellId: manager.id, zeeId: null,
    reason: 'a sync left a conflict on main and every landing is being refused' });
  ok(asked.ok === true && asked.request?.status === 'pending', 'manager request records a PENDING row');
  const dup = await requestXourceClean({ xellId: manager.id, zeeId: null, reason: 'again' });
  ok(dup.ok === true && dup.request?.id === asked.request?.id && dup.note,
     're-asking while one is pending hands back the SAME request (one open ask per manager)');

  const statusBefore = await xourceCleanStatusFor(manager.id);
  ok(statusBefore?.id === asked.request?.id && statusBefore?.status === 'pending',
     'xourceCleanStatusFor shows the manager the pending ask');

  // ── 6. the human DECIDES ──────────────────────────────────────────────────
  console.log('\n── the human approves, and the queenzee cleans the checkout ──');
  const rejected = await decideXourceClean(asked.request.id, 'rejected', 'human@test');
  ok(rejected?.status === 'rejected', 'a rejected request flips to rejected');
  ok(xourceState(src, 'main').blocked === true, 'rejecting touches NOTHING (still blocked)');

  const approved = await requestXourceClean({ xellId: manager.id, zeeId: null,
    reason: 'approved this time' });
  const done = await decideXourceClean(approved.request.id, 'approved', 'human@test');
  ok(done?.status === 'completed', `approve performs the clean → COMPLETED (${done?.status})`);
  ok(done?.result?.ok === true, 'the receipt says the clean succeeded');
  ok(Array.isArray(done?.result?.steps) && done.result.steps.length > 0,
     'and lists the steps that were taken');
  const after = xourceState(src, 'main');
  ok(after.clean === true, 'the xource is CLEAN again after the approve');
  ok(after.merge_in_progress === false, 'the in-progress merge was aborted');
  ok(after.dirty === 0, 'staged + untracked junk is gone');
  ok(existsSync(join(keepDir, 'file.txt')),
     'the xell worktree under .claude/worktrees/ SURVIVED the clean');
  const branch = git(src, ['branch', '--show-current']);
  ok(branch.out === 'main', 'the checkout is back on main');

  // ── 7. the reads after the fact ───────────────────────────────────────────
  console.log('\n── the reads after the fact ──');
  const statusAfter = await xourceCleanStatusFor(manager.id);
  ok(statusAfter?.status === 'completed' && statusAfter?.result?.ok === true,
     'the manager sees the completed receipt');
  const list = await listXourceCleanRequests(project.id, { open: true });
  ok(list.some((r) => r.id === done.id), 'listXourceCleanRequests includes the completed receipt');
  ok(!list.some((r) => r.id === rejected.id),
     'a REJECTED request is not in the open view (it is a decided receipt, not a decision)');
  ok(list.some((r) => r.live_xell_slug === 'xc-manager'),
     'the receipt names the manager who asked (live_xell_slug)');
  const all = await listXourceCleanRequests(project.id, { open: false });
  ok(all.some((r) => r.id === rejected.id), 'the rejected one IS in the all/history view');

  // ── 8. staged items: has_staged + commit-the-index recovery ────────────────
  // The broken-pipe tip on the git graph fires on has_staged; Commit keeps the
  // staged work as a real main commit instead of discarding it.
  console.log('\n── staged items: has_staged read + commitXourceStaged ──');
  writeFileSync(join(src, 'kept.txt'), 'keep me on main\n');
  git(src, ['add', 'kept.txt']);
  writeFileSync(join(src, 'loose.txt'), 'unstaged only\n');   // not staged
  const stagedState = xourceState(src, 'main');
  ok(stagedState.has_staged === true, 'has_staged is true when the index has paths');
  ok(stagedState.staged_count >= 1, `staged_count ≥ 1 (${stagedState.staged_count})`);
  ok(Array.isArray(stagedState.files) && stagedState.files.some((f) => f.path === 'kept.txt' && f.kind.includes('staged')),
     'files[] lists the staged path with kind=staged');
  ok(stagedState.files.some((f) => f.path === 'loose.txt' && f.kind === 'untracked'),
     'and the untracked rogue path too');
  ok(stagedState.diff?.staged?.files >= 1, 'diff.staged carries a shortstat (files ≥ 1)');
  ok((stagedState.summary || '').includes('staged'), 'summary names the staged paths');

  const noMsg = await commitXourceStaged(project.id, { message: '', by: 'human@test' })
    .then(() => null).catch((e) => e);
  ok(noMsg instanceof Error && /message is required/i.test(noMsg.message),
     'commit without a message is refused');

  const committed = await commitXourceStaged(project.id, {
    message: 'chore: keep accidental staged work', by: 'human@test',
  });
  ok(committed?.ok === true && committed.dry_run !== true, 'commitXourceStaged lands a real commit');
  ok(!!committed.commit && committed.short?.length >= 7, `returns the new head (${committed.short})`);
  const afterCommit = xourceState(src, 'main');
  ok(afterCommit.has_staged === false, 'has_staged is false after the commit');
  ok(afterCommit.head === committed.commit, 'xource HEAD is the new commit');
  // unstaged/untracked left alone — commit only consumes the index
  ok(afterCommit.untracked.includes('loose.txt') || afterCommit.files?.some((f) => f.path === 'loose.txt'),
     'unstaged/untracked paths were NOT swept into the commit');
  const show = git(src, ['show', '--name-only', '--pretty=format:', committed.commit]);
  ok(show.out.split('\n').filter(Boolean).includes('kept.txt'),
     'the commit contains the staged file');
  ok(!show.out.includes('loose.txt'), 'and does NOT contain the untracked file');

  // nothing staged → refuse
  const nothing = await commitXourceStaged(project.id, { message: 'nope', by: 'human@test' })
    .then(() => null).catch((e) => e);
  ok(nothing instanceof Error && /nothing is staged/i.test(nothing.message),
     'commit with an empty index is refused');

  // ── 8b. commitXourceDirty — the one-step "commit locally" door ──────────────
  console.log('\n── commitXourceDirty: stage + commit in one step ──');
  writeFileSync(join(src, 'tracked-dirty.txt'), 'tracked, modified\n');
  git(src, ['add', 'tracked-dirty.txt']);
  git(src, ['commit', '-m', 'chore: base for dirty-commit']);
  writeFileSync(join(src, 'tracked-dirty.txt'), 'tracked, modified again\n');   // tracked + dirty
  writeFileSync(join(src, 'untracked-junk.txt'), 'should NOT ride along\n');    // untracked
  const dirtyState = xourceState(src, 'main');
  ok(dirtyState.dirty >= 1, 'the tree has dirty tracked work');

  const noMsgDirty = await commitXourceDirty(project.id, { message: '', by: 'human@test' })
    .then(() => null).catch((e) => e);
  ok(noMsgDirty instanceof Error && /message is required/i.test(noMsgDirty.message),
     'commitXourceDirty without a message is refused');

  const dirtyCommit = await commitXourceDirty(project.id, {
    message: 'feat: commit my local work', by: 'human@test',
  });
  ok(dirtyCommit?.ok === true && dirtyCommit.dry_run !== true, 'commitXourceDirty lands a real commit');
  ok(!!dirtyCommit.commit, `returns the new head (${dirtyCommit.short})`);
  const afterDirty = xourceState(src, 'main');
  ok(afterDirty.head === dirtyCommit.commit, 'xource HEAD is the new commit');
  ok(afterDirty.untracked.includes('untracked-junk.txt') || afterDirty.files?.some((f) => f.path === 'untracked-junk.txt'),
     'tracked dirt is committed; the untracked junk is LEFT for the human to decide');
  const dirtyShow = git(src, ['show', '--name-only', '--pretty=format:', dirtyCommit.commit]);
  ok(dirtyShow.out.includes('tracked-dirty.txt'), 'the commit contains the tracked dirty file');
  ok(!dirtyShow.out.includes('untracked-junk.txt'), 'and does NOT sweep untracked junk in');

  // ── 9. xourcePatch (diff preview) + stashXource ────────────────────────────
  console.log('\n── xourcePatch preview + stashXource ──');
  writeFileSync(join(src, 'stage-me.txt'), 'staged body\n');
  git(src, ['add', 'stage-me.txt']);
  writeFileSync(join(src, 'loose-me.txt'), 'untracked body\n');
  const patchStaged = await xourcePatch(project.id, { scope: 'staged' });
  ok(patchStaged.ok === true, 'xourcePatch(staged) returns ok');
  ok(patchStaged.files.some((f) => f.path === 'stage-me.txt'),
     'staged patch lists stage-me.txt');
  ok(patchStaged.files.every((f) => f.path !== 'loose-me.txt'),
     'staged patch does NOT include the untracked file');
  const patchAll = await xourcePatch(project.id, { scope: 'all' });
  ok(patchAll.ok === true && patchAll.files.some((f) => f.path === 'stage-me.txt'),
     'xourcePatch(all) includes the staged file');
  ok(patchAll.files.some((f) => f.path === 'loose-me.txt' && f.status === 'untracked'),
     'and synthesises the untracked file into the preview');

  const stashed = await stashXource(project.id, { by: 'human@test', message: 'park the dirt' });
  ok(stashed?.ok === true && stashed.dry_run !== true, 'stashXource parks the dirt');
  const afterStash = xourceState(src, 'main');
  ok(afterStash.clean === true || afterStash.dirty === 0,
     'xource is clean after stash');
  ok(afterStash.has_staged === false, 'has_staged is false after stash');
  ok((afterStash.stash_count || 0) >= 1, `stash stack grew (${afterStash.stash_count})`);
  const emptyStash = await stashXource(project.id, { by: 'human@test' })
    .then(() => null).catch((e) => e);
  ok(emptyStash instanceof Error && /nothing to stash|already clean/i.test(emptyStash.message),
     'stash on a clean xource is refused');

  console.log(failures ? `\n${failures} FAILED` : '\nall good');
  process.exit(failures ? 1 : 0);
} finally {
  await pool.end().catch(() => {});
}
