// GitHub OUTBOUND (opt-in, human-gated) — proves the new push/PR plumbing in
// server/src/lib/remote-git.js:
//   • parseGitHubSlug maps github.com AND enterprise hosts to the right REST base
//   • remoteAccess reads the repo `permissions` block and gates can_push/can_pr on WRITE
//   • pushRemote is FAST-FORWARD-ONLY — a diverged remote is refused, never force-pushed
// The git tests run against a real local bare repo (no network); remoteAccess runs against a
// stubbed global fetch so no live GitHub call is made.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseGitHubSlug, remoteAccess, pushRemote } from '../server/src/lib/remote-git.js';

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };
const git = (cwd, args) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });

// ── parseGitHubSlug ───────────────────────────────────────────────────────────
console.log('parseGitHubSlug: URL → {owner, repo, apiBase}');
{
  const a = parseGitHubSlug('https://github.com/Originode/Zeehive.git');
  ok(a && a.owner === 'Originode' && a.repo === 'Zeehive' && a.apiBase === 'https://api.github.com',
    'github.com .git URL → api.github.com');
  const b = parseGitHubSlug('https://github.com/org/repo');
  ok(b && b.repo === 'repo' && b.apiBase === 'https://api.github.com', 'github.com bare URL');
  const c = parseGitHubSlug('https://ghe.corp.example/team/proj/');
  ok(c && c.apiBase === 'https://ghe.corp.example/api/v3', 'enterprise host → /api/v3');
  ok(parseGitHubSlug('git@github.com:org/repo.git') === null, 'ssh URL → null (https only)');
  ok(parseGitHubSlug('') === null, 'empty → null');
}

// ── remoteAccess (stubbed fetch) ────────────────────────────────────────────────
console.log('remoteAccess: write access lights can_push/can_pr, read-only does not');
{
  const realFetch = globalThis.fetch;
  const stub = (perms, { archived = false, ok: httpOk = true, status = 200 } = {}) => {
    globalThis.fetch = async () => ({
      ok: httpOk, status,
      json: async () => ({ permissions: perms, archived, default_branch: 'main', message: 'nope' }),
    });
  };
  try {
    stub({ push: true, pull: true });
    let r = await remoteAccess({ url: 'https://github.com/org/repo', token: 'ghp_x'.padEnd(30, 'a') });
    ok(r.can_push === true && r.can_pr === true, 'Contents:write PAT → can_push && can_pr');

    stub({ push: false, pull: true });
    r = await remoteAccess({ url: 'https://github.com/org/repo', token: 'ghp_x'.padEnd(30, 'a') });
    ok(r.can_push === false && r.can_pr === false && /read-only/i.test(r.reason || ''), 'read-only PAT → neither, with reason');

    stub({ push: true }, { archived: true });
    r = await remoteAccess({ url: 'https://github.com/org/repo', token: 'ghp_x'.padEnd(30, 'a') });
    ok(r.can_push === false && /archived/i.test(r.reason || ''), 'archived repo → no push even with write');

    stub({}, { ok: false, status: 403 });
    r = await remoteAccess({ url: 'https://github.com/org/repo', token: 'ghp_x'.padEnd(30, 'a') });
    ok(r.can_push === false && /not authorised/i.test(r.reason || ''), '403 → not authorised');

    r = await remoteAccess({ url: 'https://github.com/org/repo', token: null });
    ok(r.can_push === false && /no github token/i.test(r.reason || ''), 'no token → refused with reason');

    r = await remoteAccess({ url: 'git@github.com:org/repo.git', token: 'x' });
    ok(r.can_push === false && /not a github url/i.test(r.reason || ''), 'non-GitHub URL → refused');
  } finally { globalThis.fetch = realFetch; }
}

// ── pushRemote: fast-forward only ──────────────────────────────────────────────
console.log('pushRemote: ff push succeeds; a diverged remote is refused (never forced)');
{
  const root = mkdtempSync(join(tmpdir(), 'gho-'));
  const bare = join(root, 'remote.git');
  const work = join(root, 'work');
  const other = join(root, 'other');
  try {
    spawnSync('git', ['init', '--bare', '-b', 'main', bare]);
    spawnSync('git', ['clone', bare, work]);
    const cfg = (d) => { git(d, ['config', 'user.email', 't@t']); git(d, ['config', 'user.name', 't']); };
    cfg(work);
    spawnSync('bash', ['-c', `echo one > ${work}/a.txt`]);
    git(work, ['add', '-A']); git(work, ['commit', '-m', 'one']);

    let r = await pushRemote({ repoRoot: work, branch: 'main', remoteUrl: bare, token: 'ghp_dummy' });
    ok(r.pushed === true, 'first push (local file remote) → pushed');
    ok(git(bare, ['rev-parse', 'main']).stdout.trim().length === 40, 'remote main now points at a commit');

    // up-to-date re-push
    r = await pushRemote({ repoRoot: work, branch: 'main', remoteUrl: bare, token: 'ghp_dummy' });
    ok(r.pushed === true && r.state === 'up-to-date', 're-push with nothing new → up-to-date');

    // make the remote diverge: a second clone commits & pushes
    spawnSync('git', ['clone', bare, other]); cfg(other);
    spawnSync('bash', ['-c', `echo two > ${other}/b.txt`]);
    git(other, ['add', '-A']); git(other, ['commit', '-m', 'two']); git(other, ['push', 'origin', 'main']);
    // and our work makes its OWN divergent commit
    spawnSync('bash', ['-c', `echo three > ${work}/c.txt`]);
    git(work, ['add', '-A']); git(work, ['commit', '-m', 'three']);

    r = await pushRemote({ repoRoot: work, branch: 'main', remoteUrl: bare, token: 'ghp_dummy' });
    ok(r.pushed === false && r.state === 'refused-diverged', 'diverged remote → refused-diverged (not forced)');

    r = await pushRemote({ repoRoot: work, branch: 'nope', remoteUrl: bare, token: 'ghp_dummy' });
    ok(r.pushed === false && /does not exist/.test(r.reason || ''), 'missing local branch → refused');
  } finally { rmSync(root, { recursive: true, force: true }); }
}

console.log(failures === 0 ? '\nALL GREEN' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
