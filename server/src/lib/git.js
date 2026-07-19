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
//   SOURCE DIFF (top-level ahead/behind/files/…) — the worktree vs the SOURCE. Everything the
//     zee has produced, committed or not: what would land.
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
  const [rl, ss, st, own] = await Promise.all([
    gitAsync(worktree, ['rev-list', '--left-right', '--count', `${ref}...HEAD`]),
    gitAsync(worktree, ['diff', '--shortstat', ref]),
    gitAsync(worktree, ['status', '--porcelain']),
    // Uncommitted work: tracked changes vs its own last checkpoint. (`git diff HEAD` covers
    // staged + unstaged but NOT untracked files — those only show in `dirty`, which counts them.)
    gitAsync(worktree, ['diff', '--shortstat', 'HEAD']),
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
