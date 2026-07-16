// Read-only git helpers for the timeline rail.
import { spawnSync } from 'node:child_process';

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

export function headCommit(repoRoot, branch = 'main') {
  const r = git(repoRoot, ['rev-parse', branch]);
  return r.status === 0 ? r.out.trim() : null;
}

// What a ZEE has actually done. TWO different questions, so the card shows two numbers:
//
//   SOURCE DIFF (top-level ahead/behind/files/…) — the worktree vs the SOURCE. Everything the
//     zee has produced, committed or not: what would land.
//   OWN DIFF (`own`) — the worktree vs its OWN HEAD, i.e. work it has not checkpointed yet.
//     Zees checkpoint-commit freely on their branch, so this is the "unsaved" number: it goes
//     to 0 on every checkpoint while the source diff keeps growing.
//
// Do not diff the xell's stored head_commit against main — that is the commit it was PROVISIONED
// at, which is identical for every xell cut from the same tip, so every card renders the same
// meaningless number and a zee's real work never shows. Diff from inside the worktree instead.
export function worktreeDiff(worktree, ref = 'main') {
  const rl = git(worktree, ['rev-list', '--left-right', '--count', `${ref}...HEAD`]);
  let ahead = 0, behind = 0;
  if (rl.status === 0) { const [b, a] = rl.out.trim().split(/\s+/).map(Number); behind = b || 0; ahead = a || 0; }

  const ss = git(worktree, ['diff', '--shortstat', ref]);
  let files = 0, ins = 0, del = 0;
  if (ss.status === 0) {
    files = +(ss.out.match(/(\d+) files? changed/)?.[1] || 0);
    ins = +(ss.out.match(/(\d+) insertions?/)?.[1] || 0);
    del = +(ss.out.match(/(\d+) deletions?/)?.[1] || 0);
  }
  const st = git(worktree, ['status', '--porcelain']);
  const dirty = st.status === 0 ? st.out.split('\n').filter(Boolean).length : 0;

  // Uncommitted work: tracked changes vs its own last checkpoint. (`git diff HEAD` covers staged
  // + unstaged but NOT untracked files — those only show in `dirty`, which counts them.)
  const own = git(worktree, ['diff', '--shortstat', 'HEAD']);
  let ofiles = 0, oins = 0, odel = 0;
  if (own.status === 0) {
    ofiles = +(own.out.match(/(\d+) files? changed/)?.[1] || 0);
    oins = +(own.out.match(/(\d+) insertions?/)?.[1] || 0);
    odel = +(own.out.match(/(\d+) deletions?/)?.[1] || 0);
  }

  return {
    ahead, behind, files, insertions: ins, deletions: del, dirty,
    own: { files: ofiles, insertions: oins, deletions: odel },
  };
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
