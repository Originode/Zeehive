// THE RECONCILE VERB — re-point local main at the remote when they have DIVERGED.
//
// The shape this exists for, lived through on 2026-08-04→05: the remote `master` was squashed
// clean (a one-commit snapshot of the tree) while the local branch kept its full history —
// including the DeepSeek-shaped hex fixture that had been added and later removed. Push protection
// scans every commit in the push RANGE, so every ordinary PR re-scanned the dirty range and was
// refused with `rule=secrets`. The console's squash offer was the only path that worked, and a
// fast-forward Pull refused because both sides had moved ("reconcile by hand") — with no console
// action that actually reconciled.
//
// `reconcileRemote` (lib/remote-git.js) is that missing verb: it re-points the checked-out local
// <branch> at origin/<branch> after a fetch. What this file proves, against a real bare repo:
//   • the DIVERGED case — local ahead with a dirty range, remote clean — resets local to the
//     remote tip and reports how many local commits were dropped;
//   • a dirty TREE is refused (never discard uncommitted work);
//   • local BEHIND the remote is refused (a fast-forward Pull is the right tool, not a reset);
//   • local == remote is up-to-date, nothing dropped;
//   • the ordinary PR then OPENS from the reconciled branch — no squash needed.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reconcileRemote } from '../server/src/lib/remote-git.js';

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };
const git = (cwd, args) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
const TOKEN = 'ghp_x'.padEnd(30, 'a');
const REMOTE = 'https://github.com/o/r';

// what the remote's push-protection-style rule hunts for — assembled at runtime so this file
// carries no secret-shaped literal (test/secret-shaped-fixtures.test.mjs would fail on one)
const BANNED = `sk-${'2ee284e89d1f4b0e9c7a5d3f8e1b6a4'}${'c'}`;

const root = mkdtempSync(join(tmpdir(), 'ghrec-'));
const bare = join(root, 'remote.git');
const work = join(root, 'work');
const realCfg = process.env.GIT_CONFIG_GLOBAL;
try {
  spawnSync('git', ['init', '--bare', '-b', 'main', bare]);
  spawnSync('git', ['clone', bare, work]);
  git(work, ['config', 'user.email', 't@t']); git(work, ['config', 'user.name', 't']);

  // ── the remote is SQUASHED clean: one base commit ─────────────────────────────
  writeFileSync(join(work, 'a.txt'), 'one\n');
  git(work, ['add', '-A']); git(work, ['commit', '-m', 'one']);
  git(work, ['push', 'origin', 'main']);
  const remoteBase = git(work, ['rev-parse', 'main']).stdout.trim();

  // ── local work: the dirty range added and removed, then real work on top ───────
  writeFileSync(join(work, 'fixture.mjs'), `const DEEPSEEK_TOK = '${BANNED}';\n`);
  git(work, ['add', '-A']); git(work, ['commit', '-m', 'add fixture']);
  writeFileSync(join(work, 'fixture.mjs'), "const DEEPSEEK_TOK = 'sk-notArealDeepseekKeyZZQQWWVVUU';\n");
  git(work, ['add', '-A']); git(work, ['commit', '-m', 'sanitise fixture']);
  const dirtyTip = git(work, ['rev-parse', 'HEAD']).stdout.trim();
  const dirtyCount = git(work, ['rev-list', '--count', `${remoteBase}..HEAD`]).stdout.trim();
  console.log(`local ahead by ${dirtyCount}, dirty range carries hex: ${git(work, ['log', '-S', BANNED, '--oneline']).stdout.trim().split('\n').length} commit(s)`);
  ok(dirtyCount > '1', 'the local range really is ahead of the remote (the case Pull refuses)');

  const cfg = join(root, 'gitconfig');
  writeFileSync(cfg, `[url "${bare.replace(/\\/g, '/')}"]\n\tinsteadOf = ${REMOTE}\n`);
  process.env.GIT_CONFIG_GLOBAL = cfg;

  // ── reconcile the diverged branch ──────────────────────────────────────────────
  const r = await reconcileRemote({ repoRoot: work, remoteUrl: REMOTE, token: TOKEN, branch: 'main' });
  ok(r.reconciled === true && r.state === 'reconciled', 'a diverged branch is reconciled (state=reconciled)');
  ok(r.to === remoteBase, 'local main now points at the remote tip');
  ok(+r.dropped === +dirtyCount, `and reports the ${dirtyCount} local commit(s) it dropped`);
  ok(git(work, ['rev-parse', 'HEAD']).stdout.trim() === remoteBase, 'HEAD is the remote tip after reset');
  ok(git(work, ['status', '--porcelain']).stdout === '', 'and the working tree is clean');

  // ── the ordinary PR now OPENS from the reconciled branch ──────────────────────
  console.log('and an ordinary PR now opens — no squash needed');
  {
    const { openPullRequest } = await import('../server/src/lib/remote-git.js');
    const realFetch = globalThis.fetch;
    let prBody = null;
    globalThis.fetch = async (url, opts) => {
      const u = String(url);
      if (/\/rules\/branches\//.test(u)) return { ok: true, status: 200, json: async () => [] };
      if (/\/pulls$/.test(u)) { prBody = JSON.parse(opts.body); return { ok: true, status: 201, json: async () => ({ html_url: 'https://github.com/o/r/pull/1', number: 1 }) }; }
      return { ok: true, status: 200, json: async () => ({ permissions: { push: true }, default_branch: 'main', archived: false }) };
    };
    try {
      const pr = await openPullRequest({ repoRoot: work, remoteUrl: REMOTE, token: TOKEN, branch: 'main', headBranch: 'zeehive/main' });
      ok(pr.opened === true, 'an ordinary PR opens after reconcile (no squash offered)');
      ok(!prBody?.body?.includes('squashed'), '…and the PR body is not a squashed-snapshot one');
    } finally { globalThis.fetch = realFetch; }
  }

  // ── the guards ─────────────────────────────────────────────────────────────────
  console.log('and the guards hold');
  // now up-to-date
  const up = await reconcileRemote({ repoRoot: work, remoteUrl: REMOTE, token: TOKEN, branch: 'main' });
  ok(up.state === 'up-to-date' && up.reconciled === false, 'local == remote → up-to-date, nothing dropped');

  // dirty tree → refused (a TRACKED modification — untracked files are deliberately not counted,
  // same stance as pullRemote: they are not at risk from a reset, .claude/worktrees being the case
  // in point)
  writeFileSync(join(work, 'a.txt'), 'one\nmodified\n');
  const dirty = await reconcileRemote({ repoRoot: work, remoteUrl: REMOTE, token: TOKEN, branch: 'main' });
  ok(dirty.state === 'refused' && /uncommitted/.test(dirty.reason), 'a dirty TREE is refused (never discard uncommitted work)');
  git(work, ['checkout', '--', 'a.txt']);   // leave the tree clean again

  // wrong branch → refused
  git(work, ['checkout', '-b', 'other']);
  const off = await reconcileRemote({ repoRoot: work, remoteUrl: REMOTE, token: TOKEN, branch: 'main' });
  ok(off.state === 'refused' && /not 'main'/.test(off.reason), 'a checkout not on main is refused (only re-points the checked-out main)');
  git(work, ['checkout', 'main']);
  git(work, ['branch', '-D', 'other']);

  // local BEHIND the remote → refused (a fast-forward Pull is the right tool, not a reset)
  writeFileSync(join(work, 'new.txt'), 'n\n');
  git(work, ['add', '-A']); git(work, ['commit', '-m', 'local ahead']);
  git(work, ['push', 'origin', 'main']);   // now local == remote
  writeFileSync(join(work, 'remote2.txt'), 'r\n');
  git(work, ['add', '-A']); git(work, ['commit', '-m', 'remote-only change']);
  const behindTip = git(work, ['rev-parse', 'HEAD']).stdout.trim();
  git(work, ['push', 'origin', 'main']);   // the REMOTE is now ahead of the rewind point
  git(work, ['reset', '--hard', 'HEAD~1']);   // rewind local so it is BEHIND the remote
  const behind = await reconcileRemote({ repoRoot: work, remoteUrl: REMOTE, token: TOKEN, branch: 'main' });
  ok(behind.state === 'refused' && /behind.*Pull/.test(behind.reason),
    'local BEHIND the remote is refused — a fast-forward Pull is the non-destructive fix');
  git(work, ['reset', '--hard', behindTip]);   // put local back at the tip for the final cleanup
} finally {
  if (realCfg === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = realCfg;
  rmSync(root, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nALL GREEN' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
