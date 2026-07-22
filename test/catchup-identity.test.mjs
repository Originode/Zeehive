// CATCH-UP WITHOUT AMBIENT GIT IDENTITY — proves the durable fix in queenzee/xellgit.js:
// the queenzee's catch-up MERGE (of the xource tip into a diverged zee branch) creates a commit,
// and the queenzee container has NO git identity configured. Before the fix that died with
// "unable to auto-detect email address" and was MISLABELED as a merge conflict, blocking `zee land`.
// Here we reproduce the queenzee's identity-less environment (scrubbed HOME + no GIT_* identity)
// and assert catchUpWorktree MERGES cleanly — and that a REAL conflict is still classified 'conflict'.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ── reproduce "no ambient identity" BEFORE importing the module under test ──────
const EMPTY_HOME = mkdtempSync(join(tmpdir(), 'noid-home-'));
process.env.HOME = EMPTY_HOME;
process.env.USERPROFILE = EMPTY_HOME;
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_SYSTEM = '/dev/null';
for (const k of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']) delete process.env[k];

const { catchUpWorktree } = await import('../server/src/queenzee/xellgit.js');

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };
// setup git: carry an explicit identity ON THE COMMAND so history can be built even though the
// ambient env has none — exactly what the module under test must NOT need for its own commits.
const ID = ['-c', 'user.name=setup', '-c', 'user.email=setup@test'];
const g = (cwd, args) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
const gid = (cwd, args) => spawnSync('git', ['-C', cwd, ...ID, ...args], { encoding: 'utf8' });

// Sanity: confirm the ambient env really has no identity (else the test proves nothing).
{
  const probe = spawnSync('git', ['-C', EMPTY_HOME, 'config', 'user.email'], { encoding: 'utf8' });
  ok(!probe.stdout.trim(), 'ambient git has NO user.email (queenzee-like) — the test is meaningful');
}

function makeDiverged({ conflict }) {
  const root = mkdtempSync(join(tmpdir(), 'noid-repo-'));
  const wt = join(root, 'wt');
  mkdirSync(wt);
  gid(wt, ['init', '-b', 'master']);
  writeFileSync(join(wt, 'shared.txt'), 'base\n');
  writeFileSync(join(wt, 'a.txt'), 'a\n');
  gid(wt, ['add', '-A']); gid(wt, ['commit', '-m', 'base']);
  // master advances (the "work that landed while you ran")
  gid(wt, ['branch', 'work']);
  writeFileSync(join(wt, conflict ? 'shared.txt' : 'master-only.txt'), conflict ? 'MASTER edit\n' : 'm\n');
  gid(wt, ['add', '-A']); gid(wt, ['commit', '-m', 'master moves']);
  // our branch adds its own commit → divergence (a merge, not a ff)
  gid(wt, ['checkout', 'work']);
  writeFileSync(join(wt, conflict ? 'shared.txt' : 'work-only.txt'), conflict ? 'WORK edit\n' : 'w\n');
  gid(wt, ['add', '-A']); gid(wt, ['commit', '-m', 'work moves']);
  return { root, wt };
}

console.log('catch-up with a diverged branch and NO ambient identity');
{
  const { root, wt } = makeDiverged({ conflict: false });
  try {
    const res = catchUpWorktree(wt, 'master');
    ok(res.state === 'merged', `clean divergence → 'merged' (got '${res.state}'${res.output ? ` — ${res.output.split('\n').pop()}` : ''})`);
    // the merge commit exists and carries the queenzee identity from the -c injection
    const author = g(wt, ['log', '-1', '--format=%cn <%ce>']).stdout.trim();
    ok(/queenzee@zeehive\.local/.test(author), `merge commit authored by the queenzee identity (got '${author}')`);
    ok(g(wt, ['merge-base', '--is-ancestor', 'master', 'HEAD']).status === 0, 'HEAD now contains master → a push would fast-forward');
  } finally { rmSync(root, { recursive: true, force: true }); }
}

console.log('a REAL conflict is still classified as a conflict (and aborted)');
{
  const { root, wt } = makeDiverged({ conflict: true });
  try {
    const res = catchUpWorktree(wt, 'master');
    ok(res.state === 'conflict', `overlapping edits → 'conflict' (got '${res.state}')`);
    const status = g(wt, ['status', '--porcelain']).stdout;
    ok(!/^UU/m.test(status), 'merge was ABORTED — no unmerged paths left in the worktree');
  } finally { rmSync(root, { recursive: true, force: true }); }
}

rmSync(EMPTY_HOME, { recursive: true, force: true });
console.log(failures === 0 ? '\nALL GREEN' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
