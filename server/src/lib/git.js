// Read-only git helpers for the timeline rail.
import { spawnSync } from 'node:child_process';

// Inherited git-context env vars (a stray GIT_DIR from the launching shell) override `-C`
// and make git act on the WRONG repo — e.g. Xeehive's .git, which has no `main`, yielding
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

// What a ZEE has actually done: diff its WORKTREE against the source.
//
// Do not diff the xell's stored head_commit against main — that is the commit it was PROVISIONED
// at, which is identical for every xell cut from the same tip, so every card renders the same
// meaningless number and a zee's real work never shows. Diff from inside the worktree instead:
//   ahead/behind → its branch vs the source
//   shortstat    → working tree (INCLUDING uncommitted edits) vs the source, i.e. the live work
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
  return { ahead, behind, files, insertions: ins, deletions: del, dirty };
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
