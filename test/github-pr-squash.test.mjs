// THE SQUASHED SNAPSHOT — opening a PR when the blocked thing is in the INTERMEDIATE commits.
//
// The case, lived through on 2026-08-04→05: GitHub secret-scanning push protection refused every
// push of Originode/Zeehive because a DeepSeek-SHAPED test fixture (`sk-` + 32 invented hex chars)
// had been added and later removed. Push protection scans every commit in the push RANGE, so
// sanitising the tip could not clear it. The two options on the table were a human clicking the
// unblock URL, or rewriting master. This is the third: ONE commit carrying today's tree, parented on
// the REMOTE base, so the offending commits are not part of the push at all.
//
// It is not a bypass — it is GitHub's own remediation ("remove it from the commits") applied to the
// commits being pushed. What this file proves, against a real bare repo whose pre-receive hook
// scans pushed commits the way push protection does:
//   • the ordinary PR is REFUSED (the banned string is in an intermediate commit)
//   • the squashed PR is ACCEPTED, and its tree is byte-identical to local main's
//   • the squashed commit's parent is the REMOTE base tip, so the PR diff is the real one
//   • the LOCAL repo is untouched: same HEAD, same refs, nothing checked out or rewritten
//   • the PR body says it is a snapshot (a reviewer must not think they see every commit)
//   • the offer is only made for rules a squash can actually fix (squashHelps)
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openPullRequest } from '../server/src/lib/remote-git.js';

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };
const git = (cwd, args) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
const TOKEN = 'ghp_x'.padEnd(30, 'a');
const REMOTE = 'https://github.com/o/r';

// what the hook hunts for — assembled at runtime so this file carries no secret-shaped literal
// (test/secret-shaped-fixtures.test.mjs would fail on one, and rightly)
const BANNED = `sk-${'2ee284e89d1f4b0e9c7a5d3f8e1b6a4'}${'c'}`;

const root = mkdtempSync(join(tmpdir(), 'ghsq-'));
const bare = join(root, 'remote.git');
const work = join(root, 'work');
const realFetch = globalThis.fetch;
const realCfg = process.env.GIT_CONFIG_GLOBAL;
try {
  spawnSync('git', ['init', '--bare', '-b', 'main', bare]);
  spawnSync('git', ['clone', bare, work]);
  git(work, ['config', 'user.email', 't@t']); git(work, ['config', 'user.name', 't']);

  // 1. a base commit that IS on the remote (this is what the squash will be parented on)
  writeFileSync(join(work, 'a.txt'), 'one\n');
  git(work, ['add', '-A']); git(work, ['commit', '-m', 'one']);
  git(work, ['push', 'origin', 'main']);
  const baseSha = git(work, ['rev-parse', 'main']).stdout.trim();

  // 2. the commit that adds the banned string, and 3. the commit that removes it again —
  //    the exact shape of the real incident: a clean TIP over a dirty RANGE
  writeFileSync(join(work, 'fixture.mjs'), `const DEEPSEEK_TOK = '${BANNED}';\n`);
  git(work, ['add', '-A']); git(work, ['commit', '-m', 'add fixture']);
  writeFileSync(join(work, 'fixture.mjs'), "const DEEPSEEK_TOK = 'sk-notArealDeepseekKeyZZQQWWVVUU';\n");
  git(work, ['add', '-A']); git(work, ['commit', '-m', 'sanitise fixture']);
  const tipTree = git(work, ['rev-parse', 'main^{tree}']).stdout.trim();

  ok(!readFileSync(join(work, 'fixture.mjs'), 'utf8').includes(BANNED), 'the TIP is clean…');
  ok(git(work, ['log', '-S', BANNED, '--oneline']).stdout.trim().length > 0, '…and the RANGE is not — the whole problem');

  // url.insteadOf: the REST half needs a github.com URL, the git half must reach the bare repo
  const cfg = join(root, 'gitconfig');
  writeFileSync(cfg, `[url "${bare.replace(/\\/g, '/')}"]\n\tinsteadOf = ${REMOTE}\n`);
  process.env.GIT_CONFIG_GLOBAL = cfg;

  // push protection, in a hook: refuse if any commit being pushed CONTAINS the banned string.
  // (`git log -S` over old..new is the same question GitHub asks of the push range.)
  const hook = join(bare, 'hooks', 'pre-receive');
  writeFileSync(hook,
    '#!/bin/sh\n'
    + 'while read old new ref; do\n'
    + '  case "$old" in 0000000000000000000000000000000000000000) range="$new";; *) range="$old..$new";; esac\n'
    + `  if git log -S'${BANNED}' --oneline $range 2>/dev/null | grep -q .; then\n`
    + '    echo "remote: error: GH013: Repository rule violations found for $ref." >&2\n'
    + '    echo "remote: - GITHUB PUSH PROTECTION" >&2\n'
    + '    echo "remote:     - Push cannot contain secrets" >&2\n'
    + '    echo "remote:       path: fixture.mjs:1" >&2\n'
    + '    echo " ! [remote rejected] main -> $ref (push declined due to repository rule violations)" >&2\n'
    + '    exit 1\n'
    + '  fi\n'
    + 'done\n'
    + 'exit 0\n');
  chmodSync(hook, 0o755);

  let prBody = null;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (/\/rules\/branches\//.test(u)) return { ok: true, status: 200, json: async () => [] };
    if (/\/pulls$/.test(u)) { prBody = JSON.parse(opts.body); return { ok: true, status: 201, json: async () => ({ html_url: 'https://github.com/o/r/pull/11', number: 11 }) }; }
    return { ok: true, status: 200, json: async () => ({ permissions: { push: true }, default_branch: 'main', archived: false }) };
  };

  // ── the ordinary PR: refused, and correctly named ────────────────────────────
  console.log('the ordinary PR is refused — the string is in a commit, not in the tree');
  const plain = await openPullRequest({ repoRoot: work, remoteUrl: REMOTE, token: TOKEN, branch: 'main', headBranch: 'zeehive/main' });
  ok(plain.opened === false && plain.state === 'refused-rules', 'refused-rules');
  ok(plain.rule === 'secrets', 'classified as secrets (push protection)');
  ok(prBody === null, 'no PR was opened');

  // ── the squashed PR: accepted ────────────────────────────────────────────────
  console.log('the squashed snapshot is accepted — same tree, no offending commits in the push');
  const beforeHead = git(work, ['rev-parse', 'HEAD']).stdout.trim();
  const beforeRefs = git(work, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads']).stdout.trim();
  const beforeStatus = git(work, ['status', '--porcelain']).stdout;

  const sq = await openPullRequest({ repoRoot: work, remoteUrl: REMOTE, token: TOKEN, branch: 'main', headBranch: 'zeehive/main-squashed', squash: true });
  ok(sq.opened === true, 'the PR OPENS where the ordinary one could not');
  ok(sq.squashed === true && !!sq.squash_sha, 'the result says it is a squashed snapshot');
  ok(sq.squash_parent === baseSha, 'the snapshot is parented on the REMOTE base tip, so the PR diff is the real one');

  const pushedTree = git(bare, ['rev-parse', 'zeehive/main-squashed^{tree}']).stdout.trim();
  ok(pushedTree === tipTree, 'the pushed tree is byte-identical to local main — the review diff is unchanged');
  ok(git(bare, ['rev-list', '--count', 'zeehive/main-squashed']).stdout.trim() === '2',
    'and it is ONE commit on top of the base (2 total), not the whole range');
  ok(git(bare, ['log', '-S', BANNED, '--oneline', 'zeehive/main-squashed']).stdout.trim() === '',
    'the banned string appears in NO commit of the pushed branch — which is why the hook let it through');

  console.log('and the local repository is untouched');
  ok(git(work, ['rev-parse', 'HEAD']).stdout.trim() === beforeHead, 'HEAD did not move');
  ok(git(work, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads']).stdout.trim() === beforeRefs,
    'no local branch was created, moved or rewritten');
  ok(git(work, ['status', '--porcelain']).stdout === beforeStatus, 'the working tree is exactly as it was');
  ok(git(work, ['log', '-S', BANNED, '--oneline']).stdout.trim().length > 0,
    'local history still carries the string — a snapshot is not a rewrite, and never pretends to be');

  console.log('the PR says what it is');
  ok(/squashed snapshot/i.test(prBody?.body || ''), 'the PR body names the snapshot');
  ok((prBody?.body || '').includes(baseSha.slice(0, 8)), 'and the base it was built on');
  ok(/intermediate commits are not included/i.test(prBody?.body || ''),
    'and warns that the commit list is not the branch\'s — a reviewer is not misled by omission');

  // ── the offer is only made where it helps ───────────────────────────────────
  console.log('the console only offers it for rules a squash can actually fix');
  const { squashHelps } = await import('../web/src/api.js');
  ok(squashHelps({ opened: false, rule: 'secrets' }) === true, 'secrets → offered');
  ok(squashHelps({ opened: false, rule: 'file-size' }) === true, 'file size → offered');
  ok(squashHelps({ opened: false, rule: 'signatures' }) === true, 'unsigned commits → offered');
  ok(squashHelps({ opened: false, rule: 'pull-request-required' }) === false,
    'pull-request-required → NOT offered: that rule is about the REF and would refuse the snapshot too');
  ok(squashHelps({ opened: false, rule: 'branch-name' }) === false, 'branch-name → NOT offered (also about the ref)');
  ok(squashHelps({ opened: false, rule: 'secrets', squashed: true }) === false, 'and never offered twice for the same attempt');
  ok(squashHelps({ opened: true }) === false && squashHelps(null) === false, 'nothing to offer on success or on nothing');
} finally {
  globalThis.fetch = realFetch;
  if (realCfg === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = realCfg;
  rmSync(root, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nALL GREEN' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
