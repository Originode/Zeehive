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
const { xourceState, performXourceClean, requestXourceClean, decideXourceClean,
        listXourceCleanRequests, xourceCleanStatusFor } = await import('../server/src/lib/xource-clean.js');
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

  console.log(failures ? `\n${failures} FAILED` : '\nall good');
  process.exit(failures ? 1 : 0);
} finally {
  await pool.end().catch(() => {});
}
