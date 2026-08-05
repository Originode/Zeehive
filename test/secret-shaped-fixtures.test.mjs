// NO SECRET-SHAPED STRINGS IN THE TREE — the lint that keeps GitHub's push protection from
// refusing a push over a string nobody ever meant as a credential.
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
// patterns, matched on the source of every tracked file. It is a fixture lint, not a secret scanner
// — it cannot see git HISTORY (where the 2026-08-04 block actually lived), it does not know a real
// credential from an invented one, and GitHub scans hundreds of patterns this does not carry. A
// green run means "no tracked file carries one of THESE shapes", nothing wider.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
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

console.log(failures === 0 ? '\nALL GREEN' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
