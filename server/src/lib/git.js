// Read-only git helpers for the timeline rail.
import { spawnSync, spawn } from 'node:child_process';

// Inherited git-context env vars (a stray GIT_DIR from the launching shell) override `-C`
// and make git act on the WRONG repo — e.g. Zeehive's .git, which has no `main`, yielding
// "fatal: invalid reference: main". Strip them so git/scripts act only on the repo we point at.
const GIT_CONTEXT_VARS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY'];
export function cleanGitEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const k of GIT_CONTEXT_VARS) delete env[k];
  return env;
}

function git(repoRoot, args, timeout = 15000) {
  const r = spawnSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8', timeout, windowsHide: true, env: cleanGitEnv() });
  return { status: r.status, out: r.stdout || '', err: r.stderr || '' };
}

// Async twin of git() for callers that run per-xell in loops. spawnSync in a loop is an
// event-loop freeze: the monitor's stale-claim sweep ran FOUR sync git calls per claimed xell
// per tick, and on big Windows worktrees that starved every API request for tens of seconds
// (2026-07-19: /api/fleet at 30-90s while the DB sat idle). Same contract as git().
function gitAsync(repoRoot, args, timeout = 15000) {
  return new Promise((resolve) => {
    const p = spawn('git', ['-C', repoRoot, ...args], { windowsHide: true, env: cleanGitEnv() });
    let out = '', err = '';
    const t = setTimeout(() => p.kill(), timeout);
    p.stdout.on('data', (d) => (out += d.toString()));
    p.stderr.on('data', (d) => (err += d.toString()));
    p.on('error', () => { clearTimeout(t); resolve({ status: -1, out, err }); });
    p.on('close', (status) => { clearTimeout(t); resolve({ status, out, err }); });
  });
}

export function headCommit(repoRoot, branch = 'main') {
  const r = git(repoRoot, ['rev-parse', branch]);
  return r.status === 0 ? r.out.trim() : null;
}

// Is commit `a` contained in `b` (an ancestor of, or equal to, b)? Used to answer "is this xell's
// landed work already live in production" — a landed xell whose head is inside the deployed prod
// commit is SHIPPED, not merely ship-ready. Returns false if either ref is missing/unreadable.
export function isAncestor(repoRoot, a, b) {
  if (!a || !b) return false;
  return git(repoRoot, ['merge-base', '--is-ancestor', a, b]).status === 0;
}

// Is this directory REALLY the xell's worktree — bound to its branch — or a husk? A de-registered
// worktree (no .git file: /spinon-style cleanup, a prune, a hand deletion) makes `git -C <dir>`
// walk UP and answer for the PARENT repo. Every caller then silently operates on the XOURCE:
// diffs report the xource's dirty files as the xell's (seen live — ooney denied m-dialog for two
// files that belonged to the main checkout), and a `push . HEAD:main` from there would push
// SOMEONE ELSE'S in-progress branch toward main. Check the branch before trusting the directory.
export function worktreeBound(worktree, branch) {
  if (!worktree || !branch) return { bound: false, actual: null };
  const r = git(worktree, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const actual = r.status === 0 ? r.out.trim() : null;
  return { bound: actual === branch, actual };
}

// What a ZEE has actually done. TWO different questions, so the card shows two numbers:
//
//   SOURCE DIFF (top-level ahead/behind/files/…) — the worktree vs the branch's FORK POINT off the
//     source (see the merge-base note in worktreeDiff). Everything the zee has produced, committed or
//     not: what would land. Measured from the fork, not the source tip, so the source's own progress
//     since the fork never leaks into the number.
//   OWN DIFF (`own`) — the worktree vs its OWN HEAD, i.e. work it has not checkpointed yet.
//     Zees checkpoint-commit freely on their branch, so this is the "unsaved" number: it goes
//     to 0 on every checkpoint while the source diff keeps growing.
//
// Do not diff the xell's stored head_commit against main — that is the commit it was PROVISIONED
// at, which is identical for every xell cut from the same tip, so every card renders the same
// meaningless number and a zee's real work never shows. Diff from inside the worktree instead.
// ASYNC (see gitAsync): every caller loops over xells, and the four git calls per xell must
// not block the event loop. They run concurrently — independent read-only queries.
export async function worktreeDiff(worktree, ref = 'main') {
  // The SOURCE DIFF is measured from the FORK POINT (merge-base of the source and HEAD), not from
  // the source TIP. Diffing the worktree straight against `ref` folds the source's own
  // advancement-since-fork into the stat: every line the source gained after this branch left the
  // trunk shows up as a phantom deletion the zee never made. Seen live — a xell three lines ahead of
  // where it forked read "+78/−384", and a xell sitting exactly on the tip (a pool cell, or one whose
  // work is already merged) read "0/0" even with real committed work. Both hid the zee's actual
  // contribution. merge-base(ref, HEAD) is where the branch left the trunk, so diffing the worktree
  // against it yields precisely what the branch adds — committed or not — i.e. what would land. If the
  // branch has merged the source back in, the merge-base IS the source tip, so this still excludes the
  // source and shows only the zee's work. Falls back to `ref` if merge-base can't resolve (unrelated
  // histories / missing ref), which is no worse than the old behaviour.
  const mb = await gitAsync(worktree, ['merge-base', ref, 'HEAD']);
  const base = mb.status === 0 && mb.out.trim() ? mb.out.trim() : ref;
  const [rl, ss, st, own, hd] = await Promise.all([
    gitAsync(worktree, ['rev-list', '--left-right', '--count', `${ref}...HEAD`]),
    gitAsync(worktree, ['diff', '--shortstat', base]),
    gitAsync(worktree, ['status', '--porcelain']),
    // Uncommitted work: tracked changes vs its own last checkpoint. (`git diff HEAD` covers
    // staged + unstaged but NOT untracked files — those only show in `dirty`, which counts them.)
    gitAsync(worktree, ['diff', '--shortstat', 'HEAD']),
    // The LIVE head of the branch — what the zee is actually sitting on right now. The card's sha
    // used to render the stored head_commit (the PROVISIONING base, frozen at cxell-cut), so a xell
    // that had committed/rebased/landed still showed its old fork sha and looked "behind" the tip
    // it was level with. Read it here, next to the diff, so the card can show where it truly is.
    gitAsync(worktree, ['rev-parse', 'HEAD']),
  ]);
  let ahead = 0, behind = 0;
  if (rl.status === 0) { const [b, a] = rl.out.trim().split(/\s+/).map(Number); behind = b || 0; ahead = a || 0; }

  let files = 0, ins = 0, del = 0;
  if (ss.status === 0) {
    files = +(ss.out.match(/(\d+) files? changed/)?.[1] || 0);
    ins = +(ss.out.match(/(\d+) insertions?/)?.[1] || 0);
    del = +(ss.out.match(/(\d+) deletions?/)?.[1] || 0);
  }
  const dirty = st.status === 0 ? st.out.split('\n').filter(Boolean).length : 0;

  let ofiles = 0, oins = 0, odel = 0;
  if (own.status === 0) {
    ofiles = +(own.out.match(/(\d+) files? changed/)?.[1] || 0);
    oins = +(own.out.match(/(\d+) insertions?/)?.[1] || 0);
    odel = +(own.out.match(/(\d+) deletions?/)?.[1] || 0);
  }

  const head = hd.status === 0 ? hd.out.trim() : null;

  return {
    ahead, behind, files, insertions: ins, deletions: del, dirty, head,
    own: { files: ofiles, insertions: oins, deletions: odel },
  };
}

// How far a ref has advanced past a base commit — the commit count of `base..ref`. Used for a
// cxell zee's `behind`: its work (and HEAD) live in the cxell, but the SOURCE ref only exists on the
// host, so "how far the source moved since this branch forked" is answered here, from repo_root.
// Async and count-only (no shortstat) so it never blocks the event loop on a big worktree. 0 on any
// error — a missing ref reads as "not behind", which is the safe blank.
export async function countBehind(repoRoot, base, ref = 'main') {
  if (!base) return 0;
  const r = await gitAsync(repoRoot, ['rev-list', '--count', `${base}..${ref}`]);
  return r.status === 0 ? (+r.out.trim() || 0) : 0;
}

// The live HEAD of a worktree — a one-shot for callers (getTimeline's anchor) that need where a
// xell actually sits without the full diff. Null if the worktree is gone or git can't read it.
export function worktreeHead(worktree) {
  const r = git(worktree, ['rev-parse', 'HEAD']);
  return r.status === 0 ? r.out.trim() : null;
}

// The heads behind each xell's "remote source" — the ref it tracks, plus where that ref actually
// points, so the card can answer "which head is this tracking?" instead of just naming a branch.
//
//   local  → what a work xell tracks.
//   origin → what production tracks. A BACKUP mirror, pushed by hand; nothing here builds from it.
//
// Both are LOCAL ref reads: `origin/main` is the remote-tracking ref, so this never hits the
// network (and is only as fresh as the last push/fetch, which is fine for a label).
export function projectHeads(repoRoot, branch = 'main') {
  const localMain = git(repoRoot, ['rev-parse', '--short', branch]);
  const originMain = git(repoRoot, ['rev-parse', '--short', `origin/${branch}`]);
  return {
    local: { ref: branch, head: localMain.status === 0 ? localMain.out.trim() : null },
    origin: { ref: `origin/${branch}`, head: originMain.status === 0 ? originMain.out.trim() : null },
  };
}

// Divergence + diffstat of a base commit vs a ref (what the xell is "behind"/differs by).
export function diffStat(repoRoot, baseHash, ref = 'main') {
  if (!baseHash) return null;
  const rl = git(repoRoot, ['rev-list', '--left-right', '--count', `${baseHash}...${ref}`]);
  let ahead = 0, behind = 0;
  if (rl.status === 0) { const [a, b] = rl.out.trim().split(/\s+/).map(Number); ahead = a || 0; behind = b || 0; }
  const ss = git(repoRoot, ['diff', '--shortstat', baseHash, ref]);
  let files = 0, ins = 0, del = 0;
  if (ss.status === 0) {
    const m = ss.out;
    files = +(m.match(/(\d+) files? changed/)?.[1] || 0);
    ins = +(m.match(/(\d+) insertions?/)?.[1] || 0);
    del = +(m.match(/(\d+) deletions?/)?.[1] || 0);
  }
  return { ahead, behind, files, insertions: ins, deletions: del };
}

// Recent commits on a branch, newest first, with parent hashes (for branch/merge lines).
export function gitLog(repoRoot, branch = 'main', n = 30) {
  const SEP = '\x1f';
  const r = git(repoRoot, [
    'log', `--pretty=format:%H${SEP}%h${SEP}%s${SEP}%an${SEP}%ad${SEP}%P`,
    '--date=short', '-n', String(n), branch,
  ]);
  if (r.status !== 0) return [];
  return r.out.split('\n').filter(Boolean).map((line) => {
    const [hash, short, subject, author, date, parents] = line.split(SEP);
    return { hash, short, subject, author, date, parents: (parents || '').split(' ').filter(Boolean) };
  });
}
