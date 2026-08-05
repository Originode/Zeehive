// GitHub REPOSITORY RULE VIOLATIONS (rulesets) — the refusal a good token still gets, and the one
// that produced "failed to do pull request … repository rule violations" (2026-08-04).
//
// Covers, in server/src/lib/remote-git.js:
//   • describeRuleViolation  — git's GH013/GH009/GH006 stderr → {kind, bullets, unblock_url, reason},
//                              quoting GitHub's own rule lines and adding the ONE fix that rule has
//   • pushRemote             — a ruleset refusal is state 'refused-rules' and must NEVER be reported
//                              as a divergence ("pull or reconcile first" fixes nothing here)
//   • openPullRequest        — a ruleset that blocks FORCE updates degrades to a plain push and then
//                              to a fresh sha-suffixed head, instead of failing the PR outright;
//                              every other rule is reported with its fix
//   • branchRules / pushRuleBlock / remoteAccess — the PRE-flight probe (GET /rules/branches/:b) so
//                              the console can warn before a human clicks Push
// git runs against real local bare repos with pre-receive hooks that print GitHub's byte-shape
// (no network); the REST calls run against a stubbed global fetch.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  describeRuleViolation, pushRemote, openPullRequest, branchRules, pushRuleBlock, remoteAccess,
} from '../server/src/lib/remote-git.js';

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };
const git = (cwd, args) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
const TOKEN = 'ghp_x'.padEnd(30, 'a');

// GitHub's real stderr shapes (captured wording, `remote:` prefixes and all).
const GH013_PR = [
  'remote: error: GH013: Repository rule violations found for refs/heads/zeehive/main.        ',
  'remote: ',
  'remote: - Changes must be made through a pull request.',
  'remote: ',
  'To https://github.com/Originode/Zeehive.git',
  ' ! [remote rejected] main -> zeehive/main (push declined due to repository rule violations)',
  "error: failed to push some refs to 'https://github.com/Originode/Zeehive.git'",
].join('\n');

const GH013_FORCE = [
  'remote: error: GH013: Repository rule violations found for refs/heads/zeehive/main.        ',
  'remote: ',
  'remote: - Cannot update this protected ref.',
  'remote: ',
  ' ! [remote rejected] main -> zeehive/main (push declined due to repository rule violations)',
].join('\n');

const GH013_SECRETS = [
  'remote: error: GH013: Repository rule violations found for refs/heads/main.',
  'remote: ',
  'remote: - GITHUB PUSH PROTECTION',
  'remote:   ————————————————————————————————————————————————————',
  'remote:     Resolve the following violations before pushing again',
  'remote: ',
  'remote:     - Push cannot contain secrets',
  'remote: ',
  'remote:      —— Anthropic API Key ——————————————————————————————',
  'remote:       locations:',
  'remote:         - commit: 9b31131c0a1e2f3d4c5b6a7988990011aabbccdd',
  'remote:           path: HANDOFF.md:412',
  'remote: ',
  'remote:       (?) To push, remove secret from commit(s) or follow this URL to allow the secret.',
  'remote:       https://github.com/Originode/Zeehive/security/secret-scanning/unblock-secret/2abcDEF',
  'remote: ',
  ' ! [remote rejected] main -> main (push declined due to repository rule violations)',
].join('\n');

const GH013_SIGN = [
  'remote: error: GH013: Repository rule violations found for refs/heads/main.',
  'remote: - Commits must have verified signatures.',
  ' ! [remote rejected] main -> main (push declined due to repository rule violations)',
].join('\n');

const GH006_REVIEW = [
  'remote: error: GH006: Protected branch update failed for refs/heads/main.',
  'remote: error: At least 1 approving review is required by reviewers with write access.',
  ' ! [remote rejected] main -> main (protected branch hook declined)',
].join('\n');

// ── describeRuleViolation ─────────────────────────────────────────────────────
console.log('describeRuleViolation: GitHub\'s own rule lines, plus the one fix that rule has');
{
  const pr = describeRuleViolation(GH013_PR, { context: 'push' });
  ok(pr?.kind === 'pull-request-required', 'GH013 "changes must be made through a pull request" → pull-request-required');
  ok(pr.bullets.includes('Changes must be made through a pull request.'), 'GitHub\'s bullet is quoted verbatim');
  ok(pr.ref === 'refs/heads/zeehive/main', 'the refused ref is extracted');
  ok(/Use ⇅ PR/.test(pr.reason), 'a direct push is told to use the PR button instead');
  ok(!/pull or reconcile|fetch first/i.test(pr.reason), 'never sends the human down the divergence path');

  const prSide = describeRuleViolation(GH013_PR, { context: 'pr', head: 'zeehive/main', base: 'main' });
  ok(/every branch|targets every/i.test(prSide.reason) && /bypass|narrow/i.test(prSide.reason),
    'the SAME rule hitting the PR side branch says the ruleset targets every branch (narrow it / bypass)');

  const force = describeRuleViolation(GH013_FORCE, { context: 'pr', head: 'zeehive/main' });
  ok(force?.kind === 'force', '"Cannot update this protected ref" → force');

  const sec = describeRuleViolation(GH013_SECRETS, { context: 'push' });
  ok(sec?.kind === 'secrets', 'push protection → secrets (it wins over every other keyword in the block)');
  ok(sec.unblock_url === 'https://github.com/Originode/Zeehive/security/secret-scanning/unblock-secret/2abcDEF',
    'the unblock URL GitHub printed is surfaced');
  ok(sec.bullets.includes('Push cannot contain secrets'), 'the violation bullet is kept');
  ok(!sec.bullets.some((b) => /^commit:|^path:/i.test(b)), 'the locations: detail lines are not mistaken for rules');
  ok(/rotate|remove/i.test(sec.reason) && /HISTORY/.test(sec.reason), 'the fix says rotate + remove from history');
  ok(sec.locations.includes('HANDOFF.md:412'), 'the FILE the secret is in is kept (a 300-char tail cut exactly this off)');
  ok(sec.reason.includes('HANDOFF.md:412'), 'and it is in the sentence a human reads');

  // the report this whole change came from: the old code sliced the LAST 300 characters, which on a
  // push-protection block is the "(push declined due to repository rule violations)" tail and nothing
  // else — the rule and the file cut off the front. Parsing keeps them; and when GitHub gives us no
  // bullet at all we quote the tail rather than dropping the text entirely.
  ok(GH013_SECRETS.slice(-300).indexOf('Push cannot contain secrets') === -1
     && sec.reason.includes('Push cannot contain secrets'),
    'the rule is OUTSIDE the last 300 characters — proving the old tail-slice could not have shown it');
  const bare = describeRuleViolation(' ! [remote rejected] main -> main (push declined due to repository rule violations)', {});
  ok(bare?.kind === 'rules' && /GitHub said:/.test(bare.reason) && /push declined/.test(bare.reason),
    'a message with no bullets at all still carries GitHub\'s own words, never an empty reason');

  const sign = describeRuleViolation(GH013_SIGN, {});
  ok(sign?.kind === 'signatures' && /unsigned/i.test(sign.reason), 'signed-commits rule → signatures, and says our commits are unsigned');

  const rev = describeRuleViolation(GH006_REVIEW, {});
  ok(rev?.kind === 'pull-request-required', 'classic GH006 "approving review is required" is classified too');

  ok(describeRuleViolation('fatal: Authentication failed for https://github.com/org/repo', {}) === null,
    'an auth failure is NOT a rule violation');
  ok(describeRuleViolation(' ! [rejected] main -> main (non-fast-forward)\nfetch first', {}) === null,
    'a plain non-fast-forward is NOT a rule violation (the divergence path still owns it)');
  ok(describeRuleViolation('', {}) === null && describeRuleViolation(null, {}) === null, 'empty/null → null');
}

// ── pushRemote: refused-rules, not refused-diverged ───────────────────────────
console.log('pushRemote: a ruleset refusal is refused-rules with the rule named (never a divergence)');
{
  const root = mkdtempSync(join(tmpdir(), 'ghr-push-'));
  const bare = join(root, 'remote.git');
  const work = join(root, 'work');
  try {
    spawnSync('git', ['init', '--bare', '-b', 'main', bare]);
    spawnSync('git', ['clone', bare, work]);
    git(work, ['config', 'user.email', 't@t']); git(work, ['config', 'user.name', 't']);
    writeFileSync(join(work, 'a.txt'), 'one\n');
    git(work, ['add', '-A']); git(work, ['commit', '-m', 'one']);

    const hook = join(bare, 'hooks', 'pre-receive');
    writeFileSync(hook, `#!/bin/sh\ncat <<'EOM' >&2\n${GH013_PR}\nEOM\nexit 1\n`);
    chmodSync(hook, 0o755);

    const r = await pushRemote({ repoRoot: work, branch: 'main', remoteUrl: bare, token: 'ghp_dummy' });
    ok(r.pushed === false, 'rule violation → not pushed');
    ok(r.state === 'refused-rules', 'state is refused-rules (NOT refused-diverged)');
    ok(r.rule === 'pull-request-required', 'the rule kind rides on the result');
    ok(/pull request/i.test(r.reason || ''), 'the reason names the rule');
    ok(!/has commits local|pull or reconcile/i.test(r.reason || ''), 'the reason does not invent a divergence');

    // and a genuine divergence is still a divergence — the new branch must not swallow it
    rmSync(hook);
    const r2 = await pushRemote({ repoRoot: work, branch: 'main', remoteUrl: bare, token: 'ghp_dummy' });
    ok(r2.pushed === true, 'with the hook gone the same push succeeds (the hook was the only refusal)');
  } finally { rmSync(root, { recursive: true, force: true }); }
}

// ── openPullRequest, end to end over a REAL git remote ───────────────────────
// The git half has to talk to a local bare repo while the REST half needs a URL that parses as
// GitHub. `url.<local>.insteadOf` gives us both: openPullRequest sets origin to the github.com URL
// it was handed, git rewrites it to the bare path, and every push is real — hook, refusal text and
// all. GIT_CONFIG_GLOBAL survives cleanGitEnv (it strips GIT_DIR & friends, not config paths).
console.log('openPullRequest: a force-blocking ruleset degrades to a fresh head; the PR still opens');
{
  const root = mkdtempSync(join(tmpdir(), 'ghr-pr-'));
  const bare = join(root, 'remote.git');
  const work = join(root, 'work');
  const realFetch = globalThis.fetch;
  const realCfg = process.env.GIT_CONFIG_GLOBAL;
  const REMOTE = 'https://github.com/o/r';
  try {
    spawnSync('git', ['init', '--bare', '-b', 'main', bare]);
    spawnSync('git', ['clone', bare, work]);
    git(work, ['config', 'user.email', 't@t']); git(work, ['config', 'user.name', 't']);
    writeFileSync(join(work, 'a.txt'), 'one\n');
    git(work, ['add', '-A']); git(work, ['commit', '-m', 'one']);
    git(work, ['push', 'origin', 'main']);
    const first = git(work, ['rev-parse', 'main']).stdout.trim();

    // a DIVERGENT zeehive/main on the remote: only a force push could move it to our main, which
    // is precisely what a "block force pushes" ruleset refuses
    git(work, ['checkout', '-b', 'side']);
    writeFileSync(join(work, 'side.txt'), 'side\n');
    git(work, ['add', '-A']); git(work, ['commit', '-m', 'side']);
    git(work, ['push', 'origin', 'side:zeehive/main']);
    git(work, ['checkout', 'main']);
    writeFileSync(join(work, 'b.txt'), 'two\n');
    git(work, ['add', '-A']); git(work, ['commit', '-m', 'two']);
    const sha = git(work, ['rev-parse', 'main']).stdout.trim();

    const cfg = join(root, 'gitconfig');
    writeFileSync(cfg, `[url "${bare.replace(/\\/g, '/')}"]\n\tinsteadOf = ${REMOTE}\n`);
    process.env.GIT_CONFIG_GLOBAL = cfg;

    // pre-receive that refuses only a NON-fast-forward update of an existing ref — exactly what a
    // "block force pushes" ruleset does. A create, or a fast-forward, goes through.
    const hook = join(bare, 'hooks', 'pre-receive');
    const forceHook = '#!/bin/sh\n'
      + 'while read old new ref; do\n'
      + '  case "$old" in 0000000000000000000000000000000000000000) continue;; esac\n'
      + '  if ! git merge-base --is-ancestor "$old" "$new" 2>/dev/null; then\n'
      + `    cat <<'EOM' >&2\n${GH013_FORCE}\nEOM\n`
      + '    exit 1\n'
      + '  fi\n'
      + 'done\n'
      + 'exit 0\n';
    writeFileSync(hook, forceHook); chmodSync(hook, 0o755);

    let prBody = null;
    globalThis.fetch = async (url, opts) => {
      const u = String(url);
      if (/\/rules\/branches\//.test(u)) return { ok: true, status: 200, json: async () => [] };
      if (/\/pulls$/.test(u)) { prBody = JSON.parse(opts.body); return { ok: true, status: 201, json: async () => ({ html_url: 'https://github.com/o/r/pull/9', number: 9 }) }; }
      return { ok: true, status: 200, json: async () => ({ permissions: { push: true }, default_branch: 'main', archived: false }) };
    };

    const r = await openPullRequest({
      repoRoot: work, remoteUrl: REMOTE, token: TOKEN, branch: 'main', headBranch: 'zeehive/main',
    });
    const freshHead = `zeehive/main-${sha.slice(0, 8)}`;
    ok(r.opened === true, 'the PR is OPENED even though the ruleset refused the force update');
    ok(r.head === freshHead, `the head fell back to the sha-suffixed branch (${freshHead})`);
    ok(prBody?.head === freshHead && prBody?.base === 'main', 'the PR was opened FROM the branch that actually got pushed');
    ok(git(bare, ['rev-parse', freshHead]).stdout.trim() === sha, 'the fresh head on the remote carries local main');
    ok(git(bare, ['rev-parse', 'zeehive/main']).stdout.trim() !== sha, 'the ref the ruleset protects was left exactly as it was');
    ok(git(bare, ['rev-parse', 'main']).stdout.trim() === first, 'and remote main was never touched');

    // a rule that refuses EVERY push has no workaround — it must fail loudly, with the rule named,
    // and must not thrash the remote with retries
    writeFileSync(hook, `#!/bin/sh\ncat <<'EOM' >&2\n${GH013_PR}\nEOM\nexit 1\n`); chmodSync(hook, 0o755);
    prBody = null;
    const r2 = await openPullRequest({
      repoRoot: work, remoteUrl: REMOTE, token: TOKEN, branch: 'main', headBranch: 'zeehive/other',
    });
    ok(r2.opened === false && r2.state === 'refused-rules', 'a pull-request-required ruleset → refused-rules');
    ok(r2.rule === 'pull-request-required', 'the rule kind rides on the PR result too');
    ok(/targets every branch|narrow/i.test(r2.reason || ''), 'the reason tells the human to narrow the ruleset (not to pull)');
    ok(!/pull or reconcile|fetch first/i.test(r2.reason || ''), 'and never blames a divergence');
    ok((r2.tried || []).length === 1, 'no pointless retries: only the rule that blocks UPDATES has a fallback');
    ok(prBody === null, 'no PR is attempted when the branch never landed on the remote');

    // control: with the hook gone the ordinary path still works, unchanged
    rmSync(hook);
    const r3 = await openPullRequest({
      repoRoot: work, remoteUrl: REMOTE, token: TOKEN, branch: 'main', headBranch: 'zeehive/plain',
    });
    ok(r3.opened === true && r3.head === 'zeehive/plain' && (r3.tried || []).length === 1,
      'unruled remote → the head the human asked for, first try (no behaviour change)');
  } finally {
    globalThis.fetch = realFetch;
    if (realCfg === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = realCfg;
    rmSync(root, { recursive: true, force: true });
  }
}

// ── branchRules / pushRuleBlock / remoteAccess pre-flight ─────────────────────
console.log('branchRules: the ruleset pre-flight, so the console warns BEFORE a human clicks Push');
{
  const realFetch = globalThis.fetch;
  const stub = (body, { ok: httpOk = true, status = 200 } = {}) => {
    globalThis.fetch = async (url) => {
      if (/\/rules\/branches\//.test(String(url))) return { ok: httpOk, status, json: async () => body };
      return { ok: true, status: 200, json: async () => ({ permissions: { push: true }, default_branch: 'main', archived: false }) };
    };
  };
  try {
    stub([
      { type: 'pull_request', ruleset_id: 12345, ruleset_source: 'Originode', ruleset_source_type: 'Organization' },
      { type: 'non_fast_forward', ruleset_id: 12345, ruleset_source: 'Originode' },
    ]);
    let r = await branchRules({ url: 'https://github.com/o/r', token: TOKEN, branch: 'main' });
    ok(r.checked === true && r.requires_pull_request === true && r.blocks_force_push === true,
      'pull_request + non_fast_forward → requires_pull_request / blocks_force_push');
    ok(r.rulesets.includes('Originode #12345'), 'the ruleset that owns the rule is named (findable in Settings → Rules)');
    ok(/pull request/i.test(pushRuleBlock(r, 'main') || ''), 'pushRuleBlock warns that a direct Push will be refused');

    const acc = await remoteAccess({ url: 'https://github.com/o/r', token: TOKEN });
    ok(acc.can_push === true, 'can_push stays TRUE — the token\'s permission is a fact, the ruleset is a separate one');
    ok(/PULL REQUEST/i.test(acc.push_rule_block || ''), 'remoteAccess carries the pre-flight warning for the console');
    ok(acc.rules?.requires_pull_request === true, 'and the raw rule flags for anything else that asks');

    stub([]);
    r = await branchRules({ url: 'https://github.com/o/r', token: TOKEN, branch: 'main' });
    ok(r.checked === true && r.rules.length === 0 && pushRuleBlock(r, 'main') === null, 'no rules → no warning');
    const acc2 = await remoteAccess({ url: 'https://github.com/o/r', token: TOKEN });
    ok(acc2.push_rule_block === null, 'remoteAccess: an unruled repo warns about nothing');

    stub({ message: 'Not Found' }, { ok: false, status: 404 });
    r = await branchRules({ url: 'https://github.com/o/r', token: TOKEN, branch: 'main' });
    ok(r.checked === false && !!r.reason, 'a token that cannot read rules degrades to checked:false, never a throw');
    ok(pushRuleBlock(r, 'main') === null, 'and an unchecked probe never invents a warning');
    const acc3 = await remoteAccess({ url: 'https://github.com/o/r', token: TOKEN });
    ok(acc3.can_push === true && acc3.push_rule_block === null, 'remoteAccess still answers exactly as it did before rulesets');

    stub([{ type: 'required_signatures', ruleset_id: 7 }]);
    r = await branchRules({ url: 'https://github.com/o/r', token: TOKEN, branch: 'main' });
    ok(r.requires_signatures === true && /unsigned/i.test(pushRuleBlock(r, 'main') || ''),
      'a signatures rule warns that Zeehive\'s commits are unsigned');

    ok((await branchRules({ url: 'git@github.com:o/r.git', token: TOKEN, branch: 'main' })).checked === false,
      'non-GitHub URL → checked:false');
    ok((await branchRules({ url: 'https://github.com/o/r', token: TOKEN })).checked === false,
      'no branch → checked:false');

    const noRules = await remoteAccess({ url: 'https://github.com/o/r', token: TOKEN, withRules: false });
    ok(noRules.rules === null && noRules.push_rule_block === null, 'withRules:false skips the probe entirely (the PR path)');
  } finally { globalThis.fetch = realFetch; }
}

console.log(failures === 0 ? '\nALL GREEN' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
