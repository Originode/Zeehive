// NO SECRET-SHAPED STRINGS IN THE TREE OR IN THE HISTORY — the lint that keeps GitHub's push
// protection from refusing a push over a string nobody ever meant as a credential.
//
// WHAT IT COST (2026-08-04). A PR from the console failed with GH013 "repository rule violations",
// twice, and nobody could say why: the reason surfaced was git's last 300 characters, which on a
// push-protection block is the "(push declined …)" tail with the rule cut off the front. The block
// was secret-scanning PUSH PROTECTION, and the "secret" was a FABRICATED DeepSeek key written as a
// test fixture — `sk-` followed by 32 invented HEX characters, which is exactly the partner pattern
// GitHub keys DeepSeek on. Two test files, one made-up string, every push to a public repo refused.
//
// A fixture only has to satisfy OUR shape predicates (lib/provider-tokens.js). It must NOT satisfy a
// VENDOR's published pattern. The two techniques that work, both already in the tree:
//   • break the character class — 'sk-notArealDeepseekKey…' is alnum (our shapes accept it) and can
//     never be 32 hex characters (GitHub's pattern cannot match it);
//   • build it at RUNTIME — a PAT assembled from a prefix and a repeat() is a valid shape to our
//     code and does not exist as a literal in any file GitHub scans.
//
// SCOPE, stated so nobody reads more into a green run: these are the HIGH-CONFIDENCE partner
// patterns, matched on (a) the source of every tracked file and (b) every ADDED line in the
// reachable history (`git log -p` `+` lines). It is a fixture lint, not a secret scanner — it does
// not know a real credential from an invented one, and GitHub scans hundreds of patterns this does
// not carry. A green run means "no tracked file carries one of THESE shapes, and no commit in this
// branch's history ever INTRODUCED one".
//
// WHY THE HISTORY HALF EXISTS (2026-08-05). Push protection scans every commit in the push RANGE,
// not the tip. A string added in one commit and removed in a later one is invisible to a tree scan
// but still refuses every push from that branch — exactly the 2026-08-04 incident, where the hex
// fixture sat in the range for 112 commits after its removal was a clean tip. The history scan
// catches the string at the moment it is ADDED, so the range can never quietly carry it again. The
// two known introductions are GRANDFATHERED by commit sha (the same reasoning migration-numbers and
// harness-memory-migrations grandfather landed collisions: a forward-only repo does not rewrite
// history) — and, like those lists, each entry must still describe a real incident or the list
// becomes a licence for the next one.
import { readFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };

// Provider patterns, each as close to the vendor's published shape as a lint can be. Anchored on a
// non-token character so a longer random string is not chopped into a false match.
// The PRIVATE KEY header is assembled rather than written out: a literal would match ITSELF, and a
// lint that fails on its own source is a lint someone deletes.
const BOUND = '(^|[^A-Za-z0-9_/+=-])';
const PATTERNS = [
  { name: 'DeepSeek API key', re: new RegExp(`${BOUND}sk-[0-9a-f]{32}(?![0-9a-zA-Z])`) },
  { name: 'Anthropic API key', re: new RegExp(`${BOUND}sk-ant-(api|oat)[0-9]{2}-[A-Za-z0-9_-]{80,}`) },
  { name: 'OpenAI API key', re: new RegExp(`${BOUND}sk-[A-Za-z0-9]{48}(?![A-Za-z0-9])`) },
  { name: 'OpenAI project key', re: new RegExp(`${BOUND}sk-proj-[A-Za-z0-9_-]{74,}`) },
  { name: 'GitHub PAT (classic)', re: new RegExp(`${BOUND}gh[pousr]_[A-Za-z0-9]{36}(?![A-Za-z0-9])`) },
  { name: 'GitHub PAT (fine-grained)', re: new RegExp(`${BOUND}github_pat_[A-Za-z0-9]{22}_[A-Za-z0-9]{59}`) },
  { name: 'AWS access key id', re: new RegExp(`${BOUND}(AKIA|ASIA)[0-9A-Z]{16}(?![0-9A-Z])`) },
  { name: 'Google API key', re: new RegExp(`${BOUND}AIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])`) },
  { name: 'Slack token', re: new RegExp(`${BOUND}xox[baprs]-[0-9]{10,}-[0-9A-Za-z-]{10,}`) },
  { name: 'Stripe live secret key', re: new RegExp(`${BOUND}sk_live_[0-9A-Za-z]{24,}`) },
  { name: 'GitLab PAT', re: new RegExp(`${BOUND}glpat-[0-9A-Za-z_-]{20}(?![0-9A-Za-z_-])`) },
  { name: 'private key block', re: new RegExp(`-----${'BEGIN'} (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----`) },
];

// Every TRACKED file (git is the truth about what would be pushed), minus this lint — see above for
// why it exempts itself — and minus lockfiles, which carry integrity hashes and no credentials.
const SELF = 'test/secret-shaped-fixtures.test.mjs';
const tracked = execFileSync('git', ['-C', repo, 'ls-files'], { encoding: 'utf8' })
  .split('\n').map((s) => s.trim()).filter(Boolean)
  .filter((f) => f !== SELF && !/(^|\/)package-lock\.json$/.test(f));

console.log(`scanning ${tracked.length} tracked file(s) for ${PATTERNS.length} vendor pattern(s)`);
const hits = [];
for (const f of tracked) {
  let text;
  try { text = readFileSync(resolve(repo, f), 'utf8'); } catch { continue; }   // unreadable/binary
  const lines = text.split('\n');
  for (const p of PATTERNS) {
    if (!p.re.test(text)) continue;
    lines.forEach((l, i) => { if (p.re.test(l)) hits.push(`${f}:${i + 1} — ${p.name}`); });
  }
}
ok(hits.length === 0,
  hits.length === 0
    ? 'no tracked file carries a vendor secret pattern'
    : `${hits.length} secret-SHAPED string(s) — GitHub push protection will refuse a push carrying `
      + `these (GH013), whether or not they are real:\n      ${hits.join('\n      ')}\n    Fix: break `
      + `the character class (letters past 'f' in a hex pattern) or build the fixture at runtime. If `
      + 'one is a REAL credential, rotate it first — it is in the history either way.');

// ── the lint FIRES — proven on fixtures, not inferred from a clean folder ────────────────────────
console.log('and it catches what it is for, rather than merely not complaining');
{
  const hex32 = `sk-${'2ee284e89d1f4b0e9c7a5d3f8e1b6a4'}${'c'}`;   // the 2026-08-04 shape, rebuilt
  const ds = PATTERNS.find((p) => p.name === 'DeepSeek API key');
  ok(ds.re.test(`const DEEPSEEK_TOK = '${hex32}';`), 'the exact fixture that blocked the PR is caught');
  ok(!ds.re.test("const DEEPSEEK_TOK = 'sk-notArealDeepseekKeyZZQQWWVVUU';"),
    'and the fixture that replaced it is NOT — our own shape predicates still accept it, GitHub cannot match it');
  ok(!ds.re.test("const KIMI_TOK = 'kc0123456789abcdefghijklmnop';"), 'an unrelated fixture is not a false positive');

  const gh = PATTERNS.find((p) => p.name === 'GitHub PAT (classic)');
  ok(gh.re.test(`token: 'ghp_${'A'.repeat(36)}'`), 'a classic PAT shape is caught');
  ok(!gh.re.test("token: 'ghp_dummy'"), 'and a short obvious stub is not');

  const pk = PATTERNS.find((p) => p.name === 'private key block');
  ok(pk.re.test(`-----${'BEGIN'} RSA PRIVATE KEY-----`), 'a private key header is caught');
  ok(!PATTERNS.some((p) => p.re.test(readFileSync(resolve(repo, SELF), 'utf8'))),
    'and this file never matches itself (every risky literal here is assembled)');
}

// The two files the block named are the regression: they must keep working AND stay unmatched.
console.log('the two files GitHub named on 2026-08-04 stay clean');
for (const f of ['test/cxell-credential-vendor.test.mjs', 'test/cxell-provider-env.test.mjs']) {
  const text = readFileSync(resolve(repo, f), 'utf8');
  ok(!PATTERNS.some((p) => p.re.test(text)), `${f}: carries no vendor pattern`);
  ok(/DEEPSEEK_TOK\s*=\s*'sk-[A-Za-z0-9]{20,}'/.test(text),
    `${f}: and its DeepSeek fixture is still a shape our own predicates accept`);
}

// ── the HISTORY half — a string ADDED anywhere in this branch's history stays in the push range ──
console.log('and no commit in the history ever INTRODUCED a vendor secret pattern');
{
  // The two commits that introduced the 2026-08-04 hex fixture. They are already in the repo's
  // history — a forward-only repo does not rewrite it — so they are recorded here as the KNOWN
  // incident, and each is verified below to still be exactly that (a real addition of the hex).
  // This is the migration-numbers / harness-memory-migrations grandfather pattern: a record of the
  // bug, not permission to add to it.
  const GRANDFATHERED = new Set([
    'a87222150d1225809a21b960c5e8b31c6a213a54',   // add hex to cxell-credential-vendor
    'e79197122949b110caf6d4ac237ce1448ec7e179',   // add hex to cxell-provider-env
  ]);

  // `git log -p` pipes every commit's diff; the `+` (added) lines are what a future push would
  // carry. `+++` is the file header, not an addition. Lockfiles are exempt for the same reason as
  // the tree scan. `--max-count` is set to the ACTUAL commit count (not a hardcoded ceiling) so the
  // scan can never silently truncate on a bigger repo. ~2s for this repo's 1.2k commits — cheap
  // enough to run on every check.
  const commitCount = +execFileSync('git', ['-C', repo, 'rev-list', '--count', 'HEAD'],
    { encoding: 'utf8' }).trim();
  const patch = execFileSync('git', ['-C', repo, 'log', '-p',
    `--max-count=${commitCount}`, '--', '.', ':!package-lock.json'],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const lines = patch.split('\n');

  const histHits = [];   // {commit, pattern, line}
  let curCommit = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const cm = /^commit ([0-9a-f]{40})/.exec(l);
    if (cm) { curCommit = cm[1]; continue; }
    if (!l.startsWith('+') || l.startsWith('+++')) continue;
    for (const p of PATTERNS) {
      if (p.re.test(l)) {
        histHits.push({ commit: curCommit, pattern: p.name, line: l.trim().slice(0, 110) });
        break;
      }
    }
  }

  // Known incidents are the two hex introductions. Verify each grandfathered sha REALLY introduced
  // the hex — a stale grandfather entry is a standing permit for the next one. Each commit created
  // one of the two test files, so check the file that commit touched. A checkout cut from a
  // rewritten history (e.g. the squashed remote master) may not CONTAIN the commit at all — that is
  // fine, it means there is nothing to grandfather — so the check is skipped when the sha is absent.
  const hex = PATTERNS.find((p) => p.name === 'DeepSeek API key');
  const GRANDFATHERED_PATHS = [
    ['a87222150d1225809a21b960c5e8b31c6a213a54', 'test/cxell-credential-vendor.test.mjs'],
    ['e79197122949b110caf6d4ac237ce1448ec7e179', 'test/cxell-provider-env.test.mjs'],
  ];
  for (const [sha, path] of GRANDFATHERED_PATHS) {
    const probe = spawnSync('git', ['-C', repo, 'cat-file', '-e', `${sha}^{commit}`], { encoding: 'utf8' });
    if (probe.status !== 0) continue;   // commit not in this checkout → nothing to grandfather
    const tree = execFileSync('git', ['-C', repo, 'show', `${sha}:${path}`],
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    ok(hex.re.test(tree), `grandfathered commit ${sha.slice(0, 8)} really carries the 2026-08-04 hex fixture`);
  }

  const unexpected = histHits.filter((h) => !GRANDFATHERED.has(h.commit));
  ok(unexpected.length === 0,
    unexpected.length === 0
      ? 'no commit introduced a vendor secret pattern beyond the recorded 2026-08-04 incident'
      : `${unexpected.length} commit(s) INTRODUCED a vendor secret pattern — GitHub push protection will refuse a push from this branch, even with a clean tip:\n`
        + `      ${unexpected.map((h) => `${h.commit.slice(0, 8)} — ${h.pattern}: ${h.line}`).join('\n      ')}\n`
        + `    Fix: remove the string from the introducing commit's history (the tip is not enough) — `
        + `rewrite it out, or open the PR from a squashed snapshot of the current tree.`);
}

console.log(failures === 0 ? '\nALL GREEN' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
