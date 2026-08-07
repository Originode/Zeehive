// XOURCE CLEAN-UP — un-wedge a project's main checkout so landings and ships can move again.
//
// The project xource (the checkout at project.repo_root) is the ONE working tree every landing
// push and every prod build runs against. It is supposed to stay clean — nothing commits into it
// except landings and the queenzee's own projections (.env, harness, docs) — but it sometimes
// gets MANGLED anyway: a mid-deploy interruption leaves a detached HEAD or a half-applied merge,
// a `zee sync` conflict is left for a human who never came, a ship materialises .env and git
// decides it is dirty. Whatever the cause, the symptom is the same and it is fleet-wide:
// `receive.denyCurrentBranch=updateInstead` refuses every landing push over a dirty tree, and a
// ship's build script runs from a tree that is not the clean main it expects. Every zee in the
// project wedges on a checkout nobody asked to be touched, and nothing but a human with a shell
// into the queenzee host could fix it.
//
// This module is the scripted fix, with the same division of labour as every other irreversible
// act:
//   human  → clicks "Clean up xource" in Project setup, or approves a manager's request.
//   manager→ files a REQUEST (`zee xource-clean --reason "…"`) that a human decides.
//   queenzee→ performs the cleanup (pure git, no model): abort any in-progress merge/rebase/
//             cherry-pick/revert, get the checkout back on main, reset index+worktree to the
//             main tip, and remove untracked junk — PRESERVING every xell's worktree under
//             `.claude/worktrees/` (which is gitignored, and therefore also skipped by the
//             no-`-x` clean below).
//
// The PROVISION_MODE=real guard is load-bearing exactly as it is everywhere else: a NESTED
// queenzee's project rows are the REAL fleet's (a clone of the meta-DB), so without it a zee
// booting the server inside its own xell could `git reset --hard` the real main checkout. See
// the guard at the head of cleanXource.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { q, one } from '../db/pool.js';
import { broadcast } from './events.js';
import { logline } from './logbus.js';
import { cleanGitEnv, headCommit } from './git.js';
import { recordXourceHead } from './projects.js';

// Same switch every other real-side-effect module reads (landgate, projects, xellgit, …): 'real'
// touches machines, anything else models. A nested queenzee must never clean a real xource.
const PROVISION_MODE = process.env.PROVISION_MODE === 'real' ? 'real' : 'simulate';

// The queenzee's own git identity, exactly as xellgit uses it — `git merge --abort` needs a
// committer, and the queenzee container has none configured.
const QUEENZEE_IDENTITY = ['-c', 'user.name=Zeehive queenzee', '-c', 'user.email=queenzee@zeehive.local'];

function git(repoRoot, args, timeout = 30000) {
  const r = spawnSync('git', ['-C', repoRoot, ...QUEENZEE_IDENTITY, ...args],
    { encoding: 'utf8', timeout, windowsHide: true, env: cleanGitEnv() });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}
const lastErr = (r, fallback) => (r.err || r.out || '').trim().split('\n').filter(Boolean).pop() || fallback;

const hasDir = (repoRoot, name) => existsSync(join(repoRoot, '.git', name));

// Parse one `git status --porcelain` line into { path, index, worktree, kind }.
// XY path  — X = index (staged) status, Y = worktree (unstaged) status; '??' is untracked.
// A rename is "R  old -> new"; we keep the new path and note the old.
function parsePorcelainLine(line) {
  if (!line || line.length < 3) return null;
  const x = line[0], y = line[1];
  let rest = line.slice(3);
  let path = rest, old_path = null;
  if ((x === 'R' || x === 'C' || y === 'R' || y === 'C') && rest.includes(' -> ')) {
    const parts = rest.split(' -> ');
    old_path = parts[0];
    path = parts.slice(1).join(' -> ');
  }
  path = path.trim();
  if (!path) return null;
  if (x === '?' && y === '?') return { path, index: '?', worktree: '?', kind: 'untracked' };
  const kinds = [];
  if (x !== ' ' && x !== '?') kinds.push('staged');
  if (y !== ' ' && y !== '?') kinds.push('unstaged');
  return { path, old_path, index: x, worktree: y, kind: kinds.join('+') || 'other',
    status: statusLetter(x !== ' ' && x !== '?' ? x : y) };
}

function statusLetter(c) {
  return ({ M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied',
    U: 'unmerged', T: 'typechange' })[c] || (c === '?' ? 'untracked' : 'changed');
}

// Shortstat of a diff → { files, insertions, deletions, shortstat }. Empty tree → zeros.
function parseShortstat(text) {
  const s = String(text || '').trim();
  return {
    files: +(s.match(/(\d+) files? changed/)?.[1] || 0),
    insertions: +(s.match(/(\d+) insertions?/)?.[1] || 0),
    deletions: +(s.match(/(\d+) deletions?/)?.[1] || 0),
    shortstat: s || 'no changes',
  };
}

// READ-ONLY — what state is the xource in? Pure git reads, never a write. The console renders
// this beside the Clean button (so a human sees WHY a clean is needed, and can confirm the fix
// afterwards), the request card carries the before/after, and the git-graph tip paints a broken
// pipe when anything is STAGED on main (which should never happen — landings and ships both
// assume a clean index).
export function xourceState(repoRoot, mainBranch = 'main') {
  const dir = String(repoRoot || '').trim();
  if (!dir) return { ok: false, error: 'no repo_root' };
  if (!existsSync(dir)) return { ok: false, error: `folder does not exist: ${dir}` };
  const isRepo = git(dir, ['rev-parse', '--git-dir']).ok;
  if (!isRepo) return { ok: false, error: `not a git repo: ${dir}` };

  const branchR = git(dir, ['branch', '--show-current']);
  const branch = branchR.ok ? branchR.out || null : null;
  const head = git(dir, ['rev-parse', 'HEAD']).out || null;
  const porcelain = git(dir, ['status', '--porcelain']).out.split('\n').filter(Boolean);
  const entries = porcelain.map(parsePorcelainLine).filter(Boolean);
  // .claude/ worktrees are NOT dirt: every xell's worktree lives under it and a clean must never
  // read them as something to wipe. Filter them out of every rogue-file list.
  const visible = entries.filter((e) => !e.path.startsWith('.claude'));
  const staged = visible.filter((e) => e.kind.includes('staged'));
  const unstaged = visible.filter((e) => e.kind.includes('unstaged'));
  const untracked = visible.filter((e) => e.kind === 'untracked');
  // Keep the legacy path-string shapes the Project-setup section and older callers already read.
  const stagedPaths = staged.map((e) => e.path);
  const unstagedPaths = unstaged.map((e) => e.path);
  const untrackedPaths = untracked.map((e) => e.path);
  const stash = git(dir, ['stash', 'list']).out.split('\n').filter(Boolean).length;
  const onMain = branch === mainBranch;
  const detached = branch === null && head !== null && git(dir, ['symbolic-ref', '-q', 'HEAD']).out === '';
  const mergeInProgress = git(dir, ['rev-parse', '--verify', '-q', 'MERGE_HEAD']).ok;
  const rebaseInProgress = hasDir(dir, 'rebase-merge') || hasDir(dir, 'rebase-apply')
    || git(dir, ['rev-parse', '--verify', '-q', 'REBASE_HEAD']).ok;
  const cherryPickInProgress = hasDir(dir, 'CHERRY_PICK_HEAD');
  const revertInProgress = hasDir(dir, 'REVERT_HEAD');
  // TRACKED changes plus untracked junk — the count that blocks landings/ships.
  const dirty = stagedPaths.length + unstagedPaths.length + untrackedPaths.length;
  // Diff stats for the two buckets a human acts on (clear vs commit). Pure reads.
  const stagedDiff = parseShortstat(git(dir, ['diff', '--cached', '--shortstat']).out);
  const unstagedDiff = parseShortstat(git(dir, ['diff', '--shortstat']).out);
  const clean = !mergeInProgress && !rebaseInProgress && !cherryPickInProgress
    && !revertInProgress && dirty === 0 && !detached && onMain;
  return {
    ok: true, repo_root: dir.replace(/\\/g, '/'), main_branch: mainBranch,
    branch, head, clean, blocked: !clean, dirty,
    // has_staged is the git-graph tip signal: anything in the index on the xource is a broken
    // pipe — landings refuse over a dirty tree, and the tip should say so without a dig into
    // Project setup.
    has_staged: stagedPaths.length > 0,
    staged_count: stagedPaths.length,
    // Rich file rows for the broken-pipe popover (path + status letter meaning).
    files: visible.map((e) => ({
      path: e.path, old_path: e.old_path || null,
      kind: e.kind, status: e.status,
      index: e.index, worktree: e.worktree,
    })),
    // Legacy shapes (Project setup / older tests): staged as {path,kind}, unstaged/untracked as paths.
    staged: stagedPaths.map((p) => ({ path: p, kind: 'staged' })),
    unstaged: unstagedPaths, untracked: untrackedPaths, stash_count: stash,
    diff: { staged: stagedDiff, unstaged: unstagedDiff },
    merge_in_progress: mergeInProgress, rebase_in_progress: rebaseInProgress,
    cherry_pick_in_progress: cherryPickInProgress, revert_in_progress: revertInProgress,
    detached, on_main: onMain,
    // A one-line human sentence for the console/request card.
    summary: summaryOf({ clean, branch, mainBranch, dirty, mergeInProgress, rebaseInProgress,
      cherryPickInProgress, revertInProgress, detached, onMain, stash,
      staged: stagedPaths.length }),
  };
}

function summaryOf(s) {
  const bits = [];
  if (s.clean) return `clean — ${s.branch} is level and untouched`;
  if (!s.onMain) bits.push(s.detached ? `DETACHED HEAD (not on ${s.mainBranch})` : `on '${s.branch}', not ${s.mainBranch}`);
  if (s.staged) bits.push(`${s.staged} staged path(s)`);
  if (s.dirty) bits.push(`${s.dirty} uncommitted path(s)`);
  if (s.mergeInProgress) bits.push('a MERGE is in progress');
  if (s.rebaseInProgress) bits.push('a REBASE is in progress');
  if (s.cherryPickInProgress) bits.push('a CHERRY-PICK is in progress');
  if (s.revertInProgress) bits.push('a REVERT is in progress');
  if (s.stash) bits.push(`${s.stash} stash(es)`);
  return bits.join(' · ') + ' — landings/ships are BLOCKED until this is cleaned';
}

// COMMIT the xource's STAGED index as a real commit on main. The rare recovery path when
// something left work in the index that a human wants to KEEP rather than discard: the broken-
// pipe popover on the git-graph tip offers "Commit it" next to "Clear it". Clear is
// performXourceClean (discard); this is the keep. Never auto-stages — only what is already in
// the index lands in the commit, so a half-edited worktree does not ride along by accident.
//
// Same PROVISION_MODE guard as clean: a nested queenzee must not move the real main tip.
export async function commitXourceStaged(projectId, {
  message = null, by = 'human@console', mode = PROVISION_MODE,
} = {}) {
  const project = await one(`SELECT * FROM project WHERE id=$1`, [projectId]);
  if (!project) throw new Error('unknown project');
  const main = project.main_branch || 'main';
  const before = xourceState(project.repo_root, main);
  if (!before.ok) throw new Error(before.error || 'cannot read xource');
  if (!before.has_staged) {
    throw new Error('nothing is staged on the xource — there is nothing to commit. '
      + 'If the tree is dirty but unstaged, stage the paths you want (or Clear to discard them).');
  }
  const msg = String(message || '').trim();
  if (!msg) throw new Error('a commit message is required — this lands on main and is the line the next landing/ship sees');

  if (mode !== 'real') {
    logline('xource-commit', `commit on ${project.name} NOT run — PROVISION_MODE=simulate (this queenzee models the fleet)`);
    return {
      ok: true, dry_run: true, mode, before, after: before,
      commit: null, message: msg, by,
      note: 'NOT run — simulate mode models the fleet; the real xource index was not committed',
    };
  }

  // Refuse mid-merge/rebase etc.: a commit there would be a merge-resolution commit the human
  // did not mean to author from this popover. Clear (abort + reset) is the right door for those.
  if (before.merge_in_progress || before.rebase_in_progress
      || before.cherry_pick_in_progress || before.revert_in_progress) {
    throw new Error('a merge/rebase/cherry-pick/revert is in progress on the xource — '
      + 'Clear it (abort + reset) rather than committing a half-finished resolution from here');
  }
  if (!before.on_main) {
    throw new Error(`xource is not on ${main} (on '${before.branch || 'DETACHED'}') — `
      + 'check out main (or Clear) before committing staged work onto the tip');
  }

  const r = git(project.repo_root, ['commit', '-m', msg], 60000);
  if (!r.ok) {
    throw new Error(`git commit failed: ${lastErr(r, 'no output')}`);
  }
  const newHead = git(project.repo_root, ['rev-parse', 'HEAD']).out || null;
  try {
    await recordXourceHead(project, main, newHead || headCommit(project.repo_root, main));
  } catch { /* advisory — a commit must never fail on bookkeeping */ }

  const after = xourceState(project.repo_root, main);
  broadcast('xource-clean', { project_id: projectId, kind: 'commit', commit: newHead });
  broadcast('project', { id: projectId });
  logline('xource-commit', `xource commit by ${by} on ${project.name}: ${String(newHead || '').slice(0, 8)} — ${msg.slice(0, 80)}`);
  return {
    ok: true, dry_run: false, before, after,
    commit: newHead, short: newHead ? newHead.slice(0, 7) : null,
    message: msg, by, output: (r.out || '').trim(),
  };
}

// STASH the xource's dirty work (staged + unstaged + untracked, excluding ignored .claude/).
// The third recovery door on the broken-pipe modal: Clear discards, Commit keeps on main, Stash
// parks the dirt on the stash stack so the checkout is clean and landings/ships can move — the
// human can `git stash pop` later from a shell if they still want it. Same PROVISION_MODE guard.
export async function stashXource(projectId, {
  message = null, by = 'human@console', mode = PROVISION_MODE,
} = {}) {
  const project = await one(`SELECT * FROM project WHERE id=$1`, [projectId]);
  if (!project) throw new Error('unknown project');
  const main = project.main_branch || 'main';
  const before = xourceState(project.repo_root, main);
  if (!before.ok) throw new Error(before.error || 'cannot read xource');
  if (before.clean || before.dirty === 0) {
    throw new Error('the xource is already clean — there is nothing to stash');
  }
  // Mid-merge/rebase: stash can refuse or leave the tree worse. Clear (abort) is the right door.
  if (before.merge_in_progress || before.rebase_in_progress
      || before.cherry_pick_in_progress || before.revert_in_progress) {
    throw new Error('a merge/rebase/cherry-pick/revert is in progress on the xource — '
      + 'Clear it (abort + reset) rather than stashing a half-finished resolution');
  }

  const msg = String(message || '').trim()
    || `zeehive: xource stash by ${by} (${before.dirty} path(s))`;

  if (mode !== 'real') {
    logline('xource-stash', `stash on ${project.name} NOT run — PROVISION_MODE=simulate`);
    return {
      ok: true, dry_run: true, mode, before, after: before, message: msg, by,
      note: 'NOT run — simulate mode models the fleet; the real xource was not stashed',
    };
  }

  // -u includes untracked junk (the same dirt landings refuse over). Ignored paths (.claude/,
  // .env when ignored) stay put — xell worktrees must never ride into a stash.
  const r = git(project.repo_root, ['stash', 'push', '-u', '-m', msg], 60000);
  if (!r.ok) {
    throw new Error(`git stash failed: ${lastErr(r, 'no output')}`);
  }
  const after = xourceState(project.repo_root, main);
  broadcast('xource-clean', { project_id: projectId, kind: 'stash' });
  broadcast('project', { id: projectId });
  logline('xource-stash', `xource stashed by ${by} on ${project.name}: ${msg.slice(0, 80)}`);
  return {
    ok: true, dry_run: false, before, after, message: msg, by,
    output: (r.out || '').trim(),
    stash_count: after.stash_count,
  };
}

// THE CLEANUP — pure git, run on the xource. Returns { ok, before, after, steps }. `ok` is the
// post-clean state being clean (the thing a landing/ship actually needs). Every step is
// best-effort and the summary says exactly what was done; a step that fails is reported, never
// silently swallowed, but the cleanup continues past it (a stuck rebase must not stop the reset
// that would free it).
export function performXourceClean(repoRoot, mainBranch = 'main') {
  const before = xourceState(repoRoot, mainBranch);
  if (!before.ok) return { ok: false, error: before.error, before, steps: [] };
  const steps = [];

  if (before.mergeInProgress) {
    const r = git(repoRoot, ['merge', '--abort']);
    steps.push(r.ok ? 'aborted the in-progress merge' : `merge --abort failed: ${lastErr(r, 'no output')}`);
  }
  if (before.rebaseInProgress) {
    const r = git(repoRoot, ['rebase', '--abort']);
    steps.push(r.ok ? 'aborted the in-progress rebase' : `rebase --abort failed: ${lastErr(r, 'no output')}`);
  }
  if (before.cherryPickInProgress) {
    const r = git(repoRoot, ['cherry-pick', '--abort']);
    steps.push(r.ok ? 'aborted the in-progress cherry-pick' : `cherry-pick --abort failed: ${lastErr(r, 'no output')}`);
  }
  if (before.revertInProgress) {
    const r = git(repoRoot, ['revert', '--abort']);
    steps.push(r.ok ? 'aborted the in-progress revert' : `revert --abort failed: ${lastErr(r, 'no output')}`);
  }

  if (!before.onMain) {
    const co = git(repoRoot, ['checkout', '-f', mainBranch], 60000);
    steps.push(co.ok ? `checked out ${mainBranch}` : `checkout ${mainBranch} failed: ${lastErr(co, 'no output')}`);
  }

  const reset = git(repoRoot, ['reset', '--hard', 'HEAD'], 60000);
  steps.push(reset.ok ? 'reset the index and working tree to HEAD' : `reset --hard failed: ${lastErr(reset, 'no output')}`);

  // Untracked junk, WITHOUT -x so ignored files (.env, .claude/) survive. The `-e .claude` is
  // belt-and-braces for the day .claude is no longer gitignored: xell worktrees live there and a
  // clean must never delete another xell.
  const cl = git(repoRoot, ['clean', '-fd', '-e', '.claude'], 60000);
  steps.push(cl.ok ? 'removed untracked files (preserving .claude/worktrees)' : `clean -fd failed: ${lastErr(cl, 'no output')}`);

  const after = xourceState(repoRoot, mainBranch);
  return { ok: after.ok && after.clean, error: after.ok ? null : after.summary, before, after, steps };
}

// ── the human's DIRECT clean (Project setup → Xource) ─────────────────────────
// Same engine, no gate to climb (the console IS the human). Writes a completed request row so
// the audit trail shows what was done, by whom, and to which state — a clean with no record is a
// clean that never happened. Refused in a nested queenzee (PROVISION_MODE=simulate).
export async function cleanXourceNow(projectId, { by = 'human@console', reason = null, mode = PROVISION_MODE } = {}) {
  const project = await one(`SELECT * FROM project WHERE id=$1`, [projectId]);
  if (!project) throw new Error('unknown project');

  if (mode !== 'real') {
    logline('xource-clean', `clean of ${project.name} NOT run — PROVISION_MODE=simulate (this queenzee models the fleet)`);
    const before = xourceState(project.repo_root, project.main_branch || 'main');
    const row = await one(
      `INSERT INTO xource_clean_request (project_id, xell_id, zee_id, reason, status, decided_by, decided_at, result)
       VALUES ($1,NULL,NULL,$2,'completed',$3,now(),$4::jsonb) RETURNING *`,
      [projectId, reason || 'human-requested cleanup', by,
        JSON.stringify({ ok: true, dry_run: true, mode, before, after: before, steps: ['NOT run — simulate mode models the fleet'] })]);
    broadcast('xource-clean', row);
    return { ...row, dry_run: true };
  }

  const before = xourceState(project.repo_root, project.main_branch || 'main');
  const result = performXourceClean(project.repo_root, project.main_branch || 'main');
  try {
    await recordXourceHead(project, project.main_branch || 'main',
      headCommit(project.repo_root, project.main_branch || 'main'));
  } catch { /* advisory — a clean must never fail on bookkeeping */ }

  const row = await one(
    `INSERT INTO xource_clean_request (project_id, xell_id, zee_id, reason, status, decided_by, decided_at, result)
     VALUES ($1,NULL,NULL,$2,$3,$4,now(),$5::jsonb) RETURNING *`,
    [projectId, reason || 'human-requested cleanup', result.ok ? 'completed' : 'failed', by, JSON.stringify(result)]);
  broadcast('xource-clean', row);
  logline('xource-clean', `xource cleaned by ${by} (${project.name}): ${result.ok ? 'now clean' : result.error || 'cleanup did not fully clear'}`);
  return row;
}

// ── the manager's REQUEST (`zee xource-clean --reason "…"`) ──────────────────
// Records a pending row a human decides. The caller (queenzee/self.js) enforces that the asking
// xell is a MANAGER — this function scopes to the asking xell's own project and refuses nothing
// else, exactly like selfProdRequest records for its xell.
export async function requestXourceClean({ xellId, zeeId = null, reason = null } = {}) {
  if (!xellId) throw new Error('no asking xell');
  const xell = await one(`SELECT * FROM xell WHERE id=$1`, [xellId]);
  if (!xell) throw new Error('unknown xell');
  const project = await one(`SELECT * FROM project WHERE id=$1`, [xell.project_id]);
  if (!project) throw new Error('unknown project');

  const existing = await one(
    `SELECT * FROM xource_clean_request WHERE xell_id=$1 AND status='pending'`, [xellId]);
  if (existing) {
    return { ok: true, request: existing, note: 'you already have an open xource-clean request — a human '
      + 'must decide it before you can file another' };
  }

  const state = xourceState(project.repo_root, project.main_branch || 'main');
  if (state.ok && state.clean) {
    return { ok: false, status: 'refused', request: null,
      reason: `the xource is already clean (${state.summary}) — there is nothing for a human to approve. `
        + 'If landings/ships are still blocked, the block is elsewhere; raise a `zee tend` with what you see.' };
  }

  const row = await one(
    `INSERT INTO xource_clean_request (project_id, xell_id, zee_id, reason)
     VALUES ($1,$2,$3,$4) RETURNING *`,
    [project.id, xellId, zeeId, reason]);
  broadcast('xource-clean', row);
  broadcast('xell', { id: xellId });
  logline('xource-clean', `HELD xource-clean request from ${xell.slug} — ${state.ok ? state.summary : 'xource unreadable'}${reason ? ` (${String(reason).slice(0, 120)})` : ''}`);
  return {
    ok: true, request: row, state,
    message: 'Xource-clean REQUESTED — a human must approve it in the ZEEHIVE console. On approval the '
      + 'queenzee resets the main checkout to the main tip (aborting any in-progress merge/rebase, '
      + 'preserving every xell\'s worktree), which unblocks the landings and ships it was wedging. '
      + 'You never run git on the xource yourself.',
  };
}

// The asking manager's own read (`zee status` → xource_clean) — latest request and where it got to.
export async function xourceCleanStatusFor(xellId) {
  if (!xellId) return null;
  return one(
    `SELECT * FROM xource_clean_request WHERE xell_id=$1 ORDER BY requested_at DESC LIMIT 1`, [xellId]);
}

// ── the human side ───────────────────────────────────────────────────────────
export async function listXourceCleanRequests(projectId, { open = true } = {}) {
  const where = open
    ? `AND (xcr.status = ANY($2) OR (xcr.status IN ('completed','failed')
             AND COALESCE(xcr.finished_at, xcr.decided_at, xcr.requested_at) > now() - interval '15 minutes'))`
    : '';
  const args = open ? [projectId, ['pending', 'approved']] : [projectId];
  return q(
    `SELECT xcr.*, x.slug AS live_xell_slug, x.zee_type AS xell_zee_type
       FROM xource_clean_request xcr
       LEFT JOIN xell x ON x.id = xcr.xell_id
      WHERE xcr.project_id=$1 AND xcr.dismissed_at IS NULL ${where}
      ORDER BY xcr.requested_at DESC LIMIT 50`, args);
}

// "Seen it — stop showing me." View-only, like every other dismiss.
export async function dismissXourceClean(id, by = 'human@console') {
  const row = await one(
    `UPDATE xource_clean_request SET dismissed_at=now(), dismissed_by=$2 WHERE id=$1 RETURNING *`, [id, by]);
  if (!row) throw new Error('no such xource-clean request');
  broadcast('xource-clean', row);
  return row;
}

// THE HUMAN'S DECISION. Approve → the queenzee cleans the xource inline (seconds of git, not a
// build) and returns the finished row with the before/after so the card reads as a receipt.
export async function decideXourceClean(id, decision, by = 'human@console', { mode = PROVISION_MODE } = {}) {
  if (!['approved', 'rejected'].includes(decision)) throw new Error(`bad decision: ${decision}`);
  const row = await one(
    `UPDATE xource_clean_request SET status=$2, decided_at=now(), decided_by=$3
       WHERE id=$1 AND status='pending' RETURNING *`, [id, decision, by]);
  if (!row) throw new Error('no such pending xource-clean request (already decided?)');
  broadcast('xource-clean', row);
  if (decision === 'rejected') {
    logline('xource-clean', `xource-clean request ${String(id).slice(0, 8)} REJECTED by ${by}`);
    if (row.xell_id) broadcast('xell', { id: row.xell_id });
    return row;
  }
  return runXourceClean(id, { by, mode });
}

// Execute an approved cleanup. The row is already 'approved'; this performs the clean and lands
// it on 'completed' (or 'failed' if the post-clean state is still not clean). Everything is
// inline because it is fast — a human's approve click gets the real outcome, not a promise.
export async function runXourceClean(id, { by = 'human@console', mode = PROVISION_MODE } = {}) {
  const row = await one(
    `UPDATE xource_clean_request SET status='approved' WHERE id=$1 AND status IN ('approved','pending') RETURNING *`, [id]);
  if (!row) throw new Error('no such approved xource-clean request');
  broadcast('xource-clean', row);
  const project = await one(`SELECT * FROM project WHERE id=$1`, [row.project_id]);
  if (!project) {
    const failed = await one(
      `UPDATE xource_clean_request SET status='failed', finished_at=now(), result=$2::jsonb WHERE id=$1 RETURNING *`,
      [id, JSON.stringify({ ok: false, error: 'project row missing' })]);
    broadcast('xource-clean', failed);
    return failed;
  }
  const main = project.main_branch || 'main';

  if (mode !== 'real') {
    // A NESTED QUEENZEE must not reset the real xource — same guard as landgate/pullProject. It
    // reports what it WOULD have done and marks the request complete, so a click on a nested
    // console never reads as "the clean failed".
    const before = xourceState(project.repo_root, main);
    const done = await one(
      `UPDATE xource_clean_request SET status='completed', finished_at=now(), result=$2::jsonb WHERE id=$1 RETURNING *`,
      [id, JSON.stringify({ ok: true, dry_run: true, mode, before, after: before,
        steps: ['NOT run — PROVISION_MODE=simulate: this queenzee models the fleet, it does not reset a real xource'] })]);
    broadcast('xource-clean', done);
    logline('xource-clean', `xource-clean ${String(id).slice(0, 8)} marked completed as DRY-RUN — PROVISION_MODE=simulate`);
    return done;
  }

  const result = performXourceClean(project.repo_root, main);
  try {
    await recordXourceHead(project, main, headCommit(project.repo_root, main));
  } catch { /* advisory */ }

  const status = result.ok ? 'completed' : 'failed';
  const done = await one(
    `UPDATE xource_clean_request SET status=$2, finished_at=now(), result=$3::jsonb WHERE id=$1 RETURNING *`,
    [id, status, JSON.stringify(result)]);
  broadcast('xource-clean', done);
  if (row.xell_id) broadcast('xell', { id: row.xell_id });
  logline('xource-clean', `xource-clean ${status} for ${project.name} by ${by}: ${result.ok ? 'now clean' : result.error || 'still not clean'}`);
  return done;
}
