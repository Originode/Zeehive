// A CREDENTIAL MUST NEVER LEAVE FOR THE WRONG VENDOR'S API — the fact, not the decision.
//
// MEASURED IN PRODUCTION (queenzee fleet, 2026-08-01 → 2026-08-03): TEN zees on the deepseek-cxell
// runtime died at spawn with
//     "Failed to authenticate. API Error: 401 Authentication Fails, Your api key: ****CAAA is invalid"
// $0 spent, no session, no code, a xell and its containers burned each time. That sentence is
// DEEPSEEK's wording and ****CAAA is the last four of the project's CLAUDE OAuth token
// (provider_token 'v2', sk-ant-oat01-…CAAA) — so the vendor's message blames a CREDENTIAL that is
// perfectly healthy, and the human's next move is to rotate or pause a good account.
//
// decideRuntimePairing (lib/cxell-runtimes.js, test/provider-runtime-credential.test.mjs) fixed the
// DECISION that produced that pairing: provider, runtime and credential are now settled together at
// dispatch. This file covers the other half — the FACT about the token itself, checked at the one
// door every credential leaves by (lib/cxell.js credentialEnvFor → `adapter.env()` →
// `docker exec -e`). The two are not the same check, and the difference is the paths a decision
// never sees:
//   • the RESUME path (nudgeCxellZee) falls back to reading the token back OUT of the cage's
//     /etc/environment by `adapter.tokenEnvKey` — which is ANTHROPIC_AUTH_TOKEN for the claude AND
//     the deepseek adapter, so a token read back from a cage cannot be attributed to a vendor at all;
//   • a cage older than the pairing fix, or one whose account was removed (nudge.js swallows the
//     tokenForSpawn error with `.catch(() => null)`), resumes on whatever the cage already holds;
//   • whatever adapter is added next, which inherits the guard for free.
//
// WHAT IT MUST NOT DO IS FALSE-REFUSE. Identification reuses the PROVIDERS registry the paste box
// already enforces (one source of truth, no second copy to drift). Those predicates are
// deliberately LOOSE at the tail, and MEASURED over one real token of each type they overlap:
//     sk-ant-oat01-…          → [claude]                    → attributable
//     a DeepSeek platform key → [openai, kimi, deepseek]     → AMBIGUOUS, never refused
//     an OpenAI sk-proj- key  → [openai, kimi]               → AMBIGUOUS, never refused
//     a Kimi coding key       → [kimi]                       → attributable
//     github_pat_… / ghp_…    → [kimi, github]               → attributable by SIGNATURE
// — kimi's shape ("20+ of [A-Za-z0-9_-], not sk-ant-") is a superset of almost everything, so shape
// alone attributes only two of the five. A vendor may therefore ALSO declare a `signature`: a prefix
// it and nobody else issues (claude `sk-ant-`, github `ghp_`/`github_pat_`) — an explicit claim, not
// an inference. Anything unattributable is ALLOWED THROUGH, so a vendor changing its key format
// costs a missed catch and never a dead fleet. "Refuse anything that does not match the target's
// shape" is the tempting spelling and is the one that takes the fleet down the day DeepSeek adds a
// prefix (kimi's shape would claim the new key and "another vendor wants it" would look like proof)
// — it is asserted against here on purpose.
//
// The seam is `docker` itself: the fake shim in test/_bin records argv + stdin and answers the one
// read the resume makes (`cat /etc/environment` → a claude-shaped token). No database is needed.
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'cxcred-'));
const DOCKER_LOG = join(tmp, 'docker.log');
process.env.DOCKER_LOG = DOCKER_LOG;
process.env.PATH = `${join(REPO_ROOT, 'test', '_bin')}:${process.env.PATH}`;

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };
const section = (t) => console.log(`\n── ${t} ──`);
const readLog = () => (existsSync(DOCKER_LOG) ? readFileSync(DOCKER_LOG, 'utf8') : '');
const clearLog = () => { rmSync(DOCKER_LOG, { force: true }); };

// The real SHAPES, generated at runtime (test/_bin/tokens.mjs) so no vendor-secret-pattern literal
// exists in this file — a hand-written fake that matches a vendor's shape is what GH013'd every
// push on 2026-08-04. The generator guarantees our predicates accept the shape and GitHub's
// patterns never match it.
import { fakeTokens } from './_bin/tokens.mjs';
const CLAUDE_TOK   = fakeTokens.claude();
const DEEPSEEK_TOK = fakeTokens.deepseek();
const OPENAI_TOK   = fakeTokens.openaiProject();
const KIMI_TOK     = fakeTokens.kimi();
const GITHUB_TOK   = fakeTokens.github();
const GROK_TOK     = fakeTokens.grok();

try {
  const RT = await import('../server/src/lib/cxell-runtimes.js');
  const { identifyTokenVendors, attributeTokenVendor, credentialVendorMismatch } =
    await import('../server/src/lib/provider-tokens.js');
  const { runZee, prepareCxellAuth, nudgeCxellZee } = await import('../server/src/lib/cxell.js');

  // ── 1. identification: only what can be NAMED ───────────────────────────────────────────────
  section('identification — unambiguous or silent');
  ok(JSON.stringify(identifyTokenVendors(CLAUDE_TOK)) === '["claude"]',
     'a claude setup-token matches claude alone (every other slot rejects sk-ant-)');
  ok(JSON.stringify(identifyTokenVendors(KIMI_TOK)) === '["kimi"]',
     'a Kimi coding key matches kimi alone (no sk- prefix, so no sk- shape accepts it)');
  const dsIds = identifyTokenVendors(DEEPSEEK_TOK);
  ok(dsIds.includes('deepseek') && dsIds.includes('openai') && dsIds.includes('kimi'),
     'a DeepSeek key ALSO matches the OpenAI and Kimi shapes — measured, not assumed');
  ok(identifyTokenVendors(GITHUB_TOK).includes('kimi'),
     '…and kimi’s shape even accepts a GitHub PAT: it is a superset of almost every other one');
  ok(identifyTokenVendors('').length === 0 && identifyTokenVendors(null).length === 0,
     'empty/missing matches nothing (the caller decides what "no token" means)');

  ok(attributeTokenVendor(CLAUDE_TOK) === 'claude', 'attribution: sk-ant- is claude, by SIGNATURE');
  ok(attributeTokenVendor(GITHUB_TOK) === 'github' && attributeTokenVendor('ghp_' + 'A'.repeat(36)) === 'github',
     'attribution: both GitHub prefixes are github, by SIGNATURE — the kimi shape does not muddy it');
  ok(attributeTokenVendor(KIMI_TOK) === 'kimi', 'attribution: a unique SHAPE match is enough on its own');
  ok(identifyTokenVendors(GROK_TOK).includes('kimi') && attributeTokenVendor(GROK_TOK) === 'grok',
     'attribution: an xAI key is SHAPE-ambiguous (kimi accepts it too) and is settled by the xai- SIGNATURE');
  ok(attributeTokenVendor(DEEPSEEK_TOK) === null && attributeTokenVendor(OPENAI_TOK) === null,
     'attribution: DeepSeek and OpenAI keys are NOT attributable — no signature, overlapping shapes');
  ok(attributeTokenVendor('sk-something-brand-new-from-a-vendor-2027') === null
     && attributeTokenVendor('') === null && attributeTokenVendor(null) === null,
     'attribution: an unrecognised, empty or missing token says nothing');

  // ── 2. the rule ─────────────────────────────────────────────────────────────────────────────
  section('the rule — refuse only a token that is unmistakably another vendor’s');
  const bad = credentialVendorMismatch({ provider: 'deepseek', token: CLAUDE_TOK });
  ok(!!bad && bad.from === 'claude' && bad.to === 'deepseek',
     'THE PRODUCTION FAILURE: a claude token bound for DeepSeek is a mismatch, named both ways');
  ok(/DeepSeek/.test(bad.sentence) && /Claude/.test(bad.sentence),
     '…and the sentence names both vendors, so nobody has to guess which account to look at');
  ok(bad.sentence.includes('healthy') || /blame/.test(bad.sentence),
     '…and says the blamed account is fine — the whole cost of this bug was believing the vendor');
  ok(!bad.sentence.includes(CLAUDE_TOK) && /sk-ant-oat01-…CAAA/.test(bad.sentence),
     'the token is MASKED to the console’s own hint — matchable to an account, useless to a log reader');

  ok(credentialVendorMismatch({ provider: 'claude', token: CLAUDE_TOK }) === null,
     'the right vendor passes');
  ok(credentialVendorMismatch({ provider: 'deepseek', token: DEEPSEEK_TOK }) === null,
     'a DeepSeek key on DeepSeek passes');
  ok(credentialVendorMismatch({ provider: 'openai', token: DEEPSEEK_TOK }) === null
     && credentialVendorMismatch({ provider: 'deepseek', token: OPENAI_TOK }) === null,
     'an AMBIGUOUS token is never refused, either way round — a wrong guess would kill healthy dispatches');
  ok(credentialVendorMismatch({ provider: 'deepseek', token: 'sk-whatever-new-format-2027-xyz' }) === null,
     'an unrecognised shape is never refused — a vendor changing its keys costs a missed catch, not the fleet');
  ok(credentialVendorMismatch({ provider: 'deepseek', token: null }) === null
     && credentialVendorMismatch({ provider: null, token: CLAUDE_TOK }) === null,
     'no token / no provider is not a mismatch (the "no account connected" error belongs elsewhere)');
  ok(!!credentialVendorMismatch({ provider: 'claude', token: KIMI_TOK }),
     'it is symmetric: a Kimi key bound for the claude CLI is refused too');
  ok(!!credentialVendorMismatch({ provider: 'kimi', token: GITHUB_TOK }),
     'a GitHub PAT never reaches a vendor CLI');
  ok(!!credentialVendorMismatch({ provider: 'grok', token: CLAUDE_TOK })
     && !!credentialVendorMismatch({ provider: 'claude', token: GROK_TOK }),
     'and the newest vendor is inside the rule from the start: an xAI cage refuses a claude token, '
     + 'and a claude cage an xAI one');
  ok(credentialVendorMismatch({ provider: 'grok', token: GROK_TOK }) === null,
     '…while an xAI key on an xAI cage passes');

  // ── 3. the door: the headless RUN ───────────────────────────────────────────────────────────
  section('runZee — the mismatch dies before docker is spawned');
  const deepseek = RT.adapterFor('deepseek-cxell');
  const claude = RT.adapterFor('claude-code-cxell');
  clearLog();
  let threw = null;
  try {
    runZee({ ctx: 'default', name: 'cxell_test', prompt: 'go', model: 'opus',
             adapter: deepseek, token: CLAUDE_TOK, onEvent: () => {} });
  } catch (e) { threw = e; }
  ok(!!threw, 'a claude token on the DeepSeek adapter THROWS out of runZee');
  ok(threw && /claude/i.test(threw.message) && /deepseek/i.test(threw.message),
     '…with both vendors in the message');
  ok(threw && !threw.message.includes(CLAUDE_TOK), '…and never the token itself');
  ok(readLog() === '', '…and no docker exec happened at all — nothing is spent finding this out');

  clearLog();
  const run = runZee({ ctx: 'default', name: 'cxell_test', prompt: 'go', model: 'deepseek-chat',
                       adapter: deepseek, token: DEEPSEEK_TOK, extraEnv: { LANGFUSE_BASE_URL: 'http://lf' },
                       onEvent: () => {} });
  await run.done.catch(() => {});   // the fake docker prints no result event; the exec is the point
  const runLog = readLog();
  ok(/-e ANTHROPIC_AUTH_TOKEN=/.test(runLog) && runLog.includes(DEEPSEEK_TOK),
     'the MATCHING credential goes through untouched — the guard is a filter, not a rewrite');
  ok(/-e ANTHROPIC_BASE_URL=https:\/\/api\.deepseek\.com\/anthropic/.test(runLog),
     '…with the adapter’s own base URL, so the key and the endpoint are the same vendor’s');
  ok(/-e LANGFUSE_BASE_URL=http:\/\/lf/.test(runLog),
     '…and extraEnv (langfuse et al) still rides along');
  const adapterIdx = runLog.indexOf('ANTHROPIC_AUTH_TOKEN');
  ok(runLog.indexOf('LANGFUSE_BASE_URL') < adapterIdx,
     'the adapter’s env comes LAST, so it still wins over extraEnv on a duplicate key (docker keeps the last -e)');

  // ── 4. the door: the RESUME, which is why the guard is not just a dispatch check ─────────────
  section('nudgeCxellZee — the /etc/environment fallback cannot smuggle another vendor’s token');
  // The shim answers `cat /etc/environment` with ANTHROPIC_AUTH_TOKEN=sk-ant-… : a cage that was
  // spawned on claude. Resuming it on the DEEPSEEK adapter reads that same key name back and would
  // have posted a claude token to api.deepseek.com — the production 401, on a path the pairing
  // decision never touches.
  clearLog();
  let resumeErr = null;
  try {
    await nudgeCxellZee({ ctx: 'default', name: 'cxell_test', sessionId: '1234abcd',
                          prompt: 'carry on', model: 'deepseek-chat', adapter: deepseek, token: CLAUDE_TOK });
  } catch (e) { resumeErr = e; }
  ok(!!resumeErr && /claude/i.test(resumeErr.message) && /deepseek/i.test(resumeErr.message),
     'a resume with a claude token on a DeepSeek cage is refused, with both vendors named');
  ok(!readLog().includes(CLAUDE_TOK), '…and the token never reached a docker argv (nor a log)');

  clearLog();
  await nudgeCxellZee({ ctx: 'default', name: 'cxell_test', sessionId: '1234abcd',
                        prompt: 'carry on', model: 'opus', adapter: claude, token: CLAUDE_TOK }).catch(() => {});
  ok(/--resume 1234abcd/.test(readLog()),
     'the ordinary claude resume is unchanged — this guard must cost the common path nothing');

  // ── 5. the door: the codex credential INSTALL ───────────────────────────────────────────────
  section('prepareCxellAuth — a foreign key is never written into the cage as an auth file');
  clearLog();
  process.env.DOCKER_FAKE_CXELL_VERDICT = 'AUTH_OK';
  const auth = await prepareCxellAuth({ ctx: 'default', name: 'cxell_test',
                                        adapter: RT.adapterFor('codex-cxell'), token: CLAUDE_TOK });
  ok(auth.required && !auth.ok, 'installing a claude key as the codex credential is refused');
  ok(readLog() === '', '…without an exec — the cage never writes a ~/.codex/auth.json it would 401 on');
  delete process.env.DOCKER_FAKE_CXELL_VERDICT;

  // ── 5b. …and the model a cage is RECORDED as running must be the one it runs ────────────────
  // The same adapter property, one field over: a claude alias means nothing to a non-claude CLI, so
  // the adapter drops it — and production carries deepseek-cxell zees recorded as `opus`/`fable`
  // (the manager harness's default_model). The console then shows a model that never ran, the
  // cost-per-model telemetry sums DeepSeek spend under claude's name, and the resume path feeds that
  // same string back to the CLI.
  section('the recorded model is the one the cage runs — where the vendor default is KNOWABLE');
  const { effectiveModelFor } = RT;
  ok(effectiveModelFor(deepseek, 'opus') === 'deepseek-chat',
     'deepseek: a dispatch resolved to "opus" is recorded as deepseek-chat — what ANTHROPIC_MODEL says');
  ok(effectiveModelFor(deepseek, 'deepseek-reasoner') === 'deepseek-reasoner',
     '…a real vendor id is kept exactly as asked');
  ok(deepseek.env({ token: DEEPSEEK_TOK, model: 'opus' }).ANTHROPIC_MODEL === effectiveModelFor(deepseek, 'opus'),
     '…and it is the SAME expression the env uses, so what is recorded cannot drift from what is sent');
  const kimi = RT.adapterFor('kimi-code-cxell');
  ok(effectiveModelFor(kimi, 'opus') === kimi.env({ token: KIMI_TOK, model: 'opus' }).KIMI_MODEL_NAME,
     'kimi: same rule, same single expression (KIMI_MODEL_NAME)');
  ok(effectiveModelFor(RT.adapterFor('codex-cxell'), 'opus') === null,
     'codex: NULL — it sends no --model and its own routing picks; a default we do not know is not invented');
  ok(effectiveModelFor(claude, 'opus') === null,
     'claude: null — the alias IS the model it runs, so there is nothing to correct');

  // ── 6. the wiring ───────────────────────────────────────────────────────────────────────────
  section('wiring — the spawn refuses before it claims anything');
  const intake = readFileSync(join(REPO_ROOT, 'server', 'src', 'queenzee', 'intake.js'), 'utf8');
  const spawnCxellSrc = intake.slice(intake.indexOf('async function spawnCxell'));
  const credIdx = spawnCxellSrc.indexOf('credentialVendorMismatch');
  ok(credIdx > 0, 'spawnCxell checks the credential against the adapter’s vendor');
  ok(credIdx < spawnCxellSrc.indexOf('ensureCxell('),
     '…BEFORE the container is built, so a mismatch costs no xell and no image');
  ok(/wrongVendor[\s\S]{0,200}throw new Error/.test(spawnCxellSrc),
     '…and it THROWS rather than starting a zee that cannot authenticate');
  const cxellSrc = readFileSync(join(REPO_ROOT, 'server', 'src', 'lib', 'cxell.js'), 'utf8');
  ok((cxellSrc.match(/credentialEnvFor\(/g) || []).length >= 4,
     'every credential injection point (run, resume, auth install) goes through the ONE guarded door');
  ok(!/adapter\.env\(\{ token/.test(cxellSrc.slice(cxellSrc.indexOf('function credentialEnvFor') + 400)),
     '…and no path builds `adapter.env({token…})` around it');
  ok(/const ranModel = effectiveModelFor\(adapter, model\)/.test(spawnCxellSrc)
     && /VALUES[\s\S]{0,220}\[xell\.id, rt\?\.id \|\| null, ranModel/.test(spawnCxellSrc),
     'the zee row records the model the cage will run, not the alias the picker offered');
  ok(/runZee\(\{[^}]*model: ranModel/.test(spawnCxellSrc),
     '…and the run is handed that same value, so the row, the log and the exec are one string');
} finally {
  delete process.env.DOCKER_FAKE_CXELL_VERDICT;
  rmSync(tmp, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall good');
process.exit(failures ? 1 : 0);
