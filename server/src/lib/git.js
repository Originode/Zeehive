// Read-only git helpers for the timeline rail.
import { spawnSync } from 'node:child_process';

function git(repoRoot, args, timeout = 15000) {
  const r = spawnSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8', timeout, windowsHide: true });
  return { status: r.status, out: r.stdout || '', err: r.stderr || '' };
}

export function headCommit(repoRoot, branch = 'main') {
  const r = git(repoRoot, ['rev-parse', branch]);
  return r.status === 0 ? r.out.trim() : null;
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
