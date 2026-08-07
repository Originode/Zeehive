// THE CAGE CARRIES EVERY CONNECTED PROVIDER'S CREDENTIAL — namespaced, collision-free, no favourite.
//
// spawnCxell used to inject ONLY the dispatched provider's credential (adapter.env({token}) —
// ANTHROPIC_AUTH_TOKEN for the claude AND the deepseek adapter alike). A zee whose task later needs
// another vendor's CLI (a manager swapping a worker onto Codex, a DeepSeek cage asked to compare
// against a Claude answer) had no way to get that vendor's key — the cage only carried the one it
// was born with. Since 2026-08-04 it carries EVERY dispatchable provider's freshest ACTIVE account,
// each under its own NON-COLLIDING namespaced env var, plus a manifest (ZEE_PROVIDERS) the cage can
// read to discover what it holds.
//
// This file is the table test for lib/provider-tokens.js everyProviderEnv — the PURE function that
// builds that set (the same shape as decideDispatchProvider / decideRuntimePairing). The collision it
// must never reintroduce is real and expensive: claude and deepseek BOTH set ANTHROPIC_AUTH_TOKEN, so
// a naive merge of adapter envs is precisely the mix-up that killed ten zees on 2026-08-01→03.
//
// It also asserts the wiring: spawnCxell reads the set and merges it into BOTH doors
// (openCxellSsh's /etc/environment and runZee's exec env), and nudgeCxellZee reads its resume token
// by provider from the namespaced var FIRST — so a resumed cage's token is attributable (the old
// fallback adapter.tokenEnvKey is the key claude and deepseek SHARE, which cannot be attributed).
//
// Static + pure-function by design: the collision cases need no database to describe.
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) fail++; };
const section = (t) => console.log(`\n── ${t} ──`);

const { everyProviderEnv, providerRunEnvFromAccount } = await import('../server/src/lib/provider-tokens.js');
const rt = await import('../server/src/lib/cxell-runtimes.js');

// Real shapes (same generator test/cxell-credential-vendor.test.mjs uses), so the collisions are
// real. Generated at runtime (test/_bin/tokens.mjs) so no vendor-secret-pattern literal exists —
// a hand-written fake that matches a vendor's shape is what GH013'd every push on 2026-08-04.
import { fakeTokens } from './_bin/tokens.mjs';
const CLAUDE_TOK   = fakeTokens.claude();
const DEEPSEEK_TOK = fakeTokens.deepseek();
const OPENAI_TOK   = fakeTokens.openaiProject();
const KIMI_TOK     = fakeTokens.kimi();
const GITHUB_TOK   = fakeTokens.github();
const GROK_TOK     = fakeTokens.grok();

// account rows in the shape allProviderTokenRows hands everyProviderEnv (freshest first)
const A = (provider, token, { label = null, hint = null, paused = false } = {}) =>
  ({ provider, token, label, token_hint: hint, paused, created_at: new Date() });

section('the env contract — one namespaced var per provider, no shared key');
{
  const { env, skipped } = everyProviderEnv([A('claude', CLAUDE_TOK), A('deepseek', DEEPSEEK_TOK)]);
  ok(env.ZEE_PROVIDER_CLAUDE_TOKEN === CLAUDE_TOK, 'claude: the full token rides ZEE_PROVIDER_CLAUDE_TOKEN');
  ok(env.ZEE_PROVIDER_DEEPSEEK_TOKEN === DEEPSEEK_TOK, 'deepseek: the full token rides ZEE_PROVIDER_DEEPSEEK_TOKEN');
  ok(env.ZEE_PROVIDERS === 'claude,deepseek', 'the manifest names both, in PROVIDERS order');
  const shared = Object.keys(env).filter((k) => ['ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'KIMI_MODEL_API_KEY'].includes(k));
  ok(shared.length === 0, 'NO adapter env key leaks into the set — claude and deepseek cannot collide');
  ok(skipped.length === 0, 'nothing skipped when every token matches its provider');
}
{
  // The ACTIVE vendor env must stay byte-identical to today: everyProviderEnv is BESIDE adapter.env(),
  // never a rewrite of it. The deepseek adapter still sets ANTHROPIC_AUTH_TOKEN for the DISPATCHED key.
  const ds = rt.adapterFor('deepseek-cxell');
  const activeEnv = ds.env({ token: DEEPSEEK_TOK, model: 'deepseek-chat' });
  const { env } = everyProviderEnv([A('claude', CLAUDE_TOK), A('deepseek', DEEPSEEK_TOK)]);
  ok(activeEnv.ANTHROPIC_AUTH_TOKEN === DEEPSEEK_TOK, 'the active vendor env is untouched by the every-provider set');
  ok(env.ZEE_PROVIDER_DEEPSEEK_TOKEN === DEEPSEEK_TOK && !('ANTHROPIC_AUTH_TOKEN' in env),
     '…and the namespaced copy coexists without shadowing it');
}

section('a paused account is never in the set (freshest ACTIVE wins)');
{
  const { env } = everyProviderEnv([A('claude', CLAUDE_TOK, { paused: true })]);
  ok(!env.ZEE_PROVIDER_CLAUDE_TOKEN && !env.ZEE_PROVIDERS, 'a sole paused account → the provider is absent');
  const { env: env2 } = everyProviderEnv([
    A('claude', CLAUDE_TOK, { paused: true }),              // newer, paused
    A('claude', 'sk-ant-oat01-OLDACTIVEtoken0000000-XYZ', { label: 'old active' }), // older, active
  ]);
  ok(env2.ZEE_PROVIDER_CLAUDE_TOKEN === 'sk-ant-oat01-OLDACTIVEtoken0000000-XYZ',
     'an ACTIVE sibling beats a newer PAUSED one (paused never shadows active)');
  ok(env2.ZEE_PROVIDER_CLAUDE_LABEL === 'old active', '…and the label follows the account that was picked');
}

section('nothing connected → empty env; github is never in the set');
{
  const { env, skipped } = everyProviderEnv([]);
  ok(JSON.stringify(env) === '{}' && skipped.length === 0, 'no accounts → no env, no manifest');
  const { env: envG } = everyProviderEnv([A('github', GITHUB_TOK)]);
  ok(!envG.ZEE_PROVIDER_GITHUB_TOKEN && !envG.ZEE_PROVIDERS,
     'github (dispatch:false, an infra credential) is never in the set even when connected');
}

section('a mis-attributed token is refused, never injected under the wrong provider name');
{
  // A claude token sitting in a kimi account row: credentialVendorMismatch can NAME it as claude,
  // so injecting it as ZEE_PROVIDER_KIMI_TOKEN would be exactly the cross-vendor mix-up the guard
  // exists to stop. It is skipped, reported, and the other providers still land.
  const { env, skipped } = everyProviderEnv([A('kimi', CLAUDE_TOK), A('openai', OPENAI_TOK)]);
  ok(!env.ZEE_PROVIDER_KIMI_TOKEN, 'the mis-attributed kimi token is NOT in the env');
  ok(env.ZEE_PROVIDER_OPENAI_TOKEN === OPENAI_TOK, '…and the correctly-attributed provider still lands');
  ok(env.ZEE_PROVIDERS === 'openai', 'the manifest reflects only what actually landed');
  ok(skipped.length === 1 && skipped[0].provider === 'kimi' && /claude/.test(skipped[0].reason),
     'the skip is reported with the provider and the vendor it was named as');
  // An AMBIGUOUS token (a DeepSeek key — no signature, overlapping shape) is NOT a mismatch: it is
  // allowed under its own provider, exactly like the active env's guard.
  const { skipped: sk2 } = everyProviderEnv([A('deepseek', DEEPSEEK_TOK)]);
  ok(sk2.length === 0, 'an unattributable token is never refused — the guard only fires on what it can NAME');
}

section('the read model — label and masked hint ride alongside');
{
  const { env } = everyProviderEnv([A('claude', CLAUDE_TOK, { label: 'work sub', hint: 'sk-ant-oat01-…CAAA' })]);
  ok(env.ZEE_PROVIDER_CLAUDE_LABEL === 'work sub', 'the account label is preserved');
  ok(env.ZEE_PROVIDER_CLAUDE_HINT === 'sk-ant-oat01-…CAAA', 'the masked hint is preserved (matchable to the console)');
}

section('the wiring — the spawn gives BOTH doors the set, and the resume reads by provider');
{
  const intake = readFileSync(join(ROOT, 'server', 'src', 'queenzee', 'intake.js'), 'utf8');
  const tokens = readFileSync(join(ROOT, 'server', 'src', 'lib', 'provider-tokens.js'), 'utf8');
  const cxellLib = readFileSync(join(ROOT, 'server', 'src', 'lib', 'cxell.js'), 'utf8');
  const spawn = intake.slice(intake.indexOf('async function spawnCxell'));

  ok(/everyProviderEnv|allProviderTokenRows/.test(tokens), 'provider-tokens.js exports the pure builder + the read');
  ok(/import\s*{[^}]*everyProviderEnv[^}]*allProviderTokenRows/.test(intake),
     'spawnCxell imports BOTH — the read and the pure builder');
  ok(/allProviderTokenRows\(pid\)[\s\S]{0,80}everyProviderEnv\(rows\)/.test(spawn),
     'spawnCxell reads every account row and builds the namespaced set');
  ok(/openCxellSsh\(\{[\s\S]{0,600}everyEnv\.env/.test(spawn),
     'door 1: the set is merged into openCxellSsh — /etc/environment for an attending human\'s shell');
  ok(/runZee\(\{[\s\S]{0,400}everyEnv\.env/.test(spawn),
     'door 2: the set is merged into runZee — the headless exec env');
  const nudge = cxellLib.slice(cxellLib.indexOf('export async function nudgeCxellZee'));
  ok(/ZEE_PROVIDER_\$\{String\(adapter\.provider\)\.toUpperCase\(\)\}_TOKEN/.test(nudge),
     'nudgeCxellZee reads the resume token from ZEE_PROVIDER_<PROVIDER>_TOKEN FIRST');
  ok(new RegExp(`ZEE_PROVIDER_\\$\\{String\\(adapter\\.provider\\)\\.toUpperCase\\(\\)\\}_TOKEN[\\s\\S]{0,120}adapter\\.tokenEnvKey`).test(nudge),
     '…and falls back to adapter.tokenEnvKey only for a cage spawned before the namespaced set existed');
}

section('the RUNNABLE env — `zee creds --provider <key> --export` is server-computed from the adapter');
// The namespaced token is what the cage holds; the RUNNABLE env is what a vendor CLI actually reads.
// The mapping is the runtime adapters' (lib/cxell-runtimes.js), computed SERVER-side so the CLI never
// carries a second copy. Assert the exact vendor env each adapter would set for a dispatch.
{
  const claude = providerRunEnvFromAccount({ provider: 'claude', token: CLAUDE_TOK, label: 'work', hint: 'sk-ant-oat01-…CAAA' });
  ok(claude.env.CLAUDE_CODE_OAUTH_TOKEN === CLAUDE_TOK && claude.env.ANTHROPIC_AUTH_TOKEN === CLAUDE_TOK,
     'claude: the runnable env is ANTHROPIC_AUTH_TOKEN (+CLAUDE_CODE_OAUTH_TOKEN) — what the claude CLI reads');
  ok(claude.bin === 'claude' && !claude.auth_setup, 'claude: env alone authenticates (no install)');

  const codex = providerRunEnvFromAccount({ provider: 'openai', token: OPENAI_TOK });
  ok(codex.env.OPENAI_API_KEY === OPENAI_TOK, 'openai: the runnable env is OPENAI_API_KEY');
  ok(codex.bin === 'codex' && codex.auth_setup?.required === true
     && /codex login --with-api-key/.test(codex.auth_setup.command),
     'openai: the codex CLI needs an in-cage install, and the exact one-liner comes from the adapter (never the CLI)');

  const kimi = providerRunEnvFromAccount({ provider: 'kimi', token: KIMI_TOK });
  ok(kimi.env.KIMI_MODEL_API_KEY === KIMI_TOK && kimi.env.KIMI_MODEL_PROVIDER_TYPE === 'kimi'
     && /^https:\/\/api\.kimi\.com\/coding\/v1$/.test(kimi.env.KIMI_MODEL_BASE_URL),
     'kimi: the runnable env is the KIMI_MODEL_* family — what the kimi CLI reads (no config.toml needed)');
  ok(kimi.env.KIMI_MODEL_NAME === kimi.env.KIMI_MODEL_NAME && kimi.bin === 'kimi' && !kimi.auth_setup,
     'kimi: env alone authenticates, and the model name is the adapter\'s own default');
  ok(kimi.env.KIMI_MODEL_NAME === rt.adapterFor('kimi-code-cxell').env({ token: KIMI_TOK }).KIMI_MODEL_NAME,
     '…and the export env is byte-identical to the adapter env a spawn would inject (one expression)');

  const ds = providerRunEnvFromAccount({ provider: 'deepseek', token: DEEPSEEK_TOK });
  ok(ds.env.ANTHROPIC_AUTH_TOKEN === DEEPSEEK_TOK && ds.env.ANTHROPIC_MODEL === 'deepseek-chat'
     && /^https:\/\/api\.deepseek\.com\/anthropic$/.test(ds.env.ANTHROPIC_BASE_URL),
     'deepseek: the runnable env is ANTHROPIC_AUTH_TOKEN+BASE_URL+MODEL aimed at DeepSeek\'s endpoint');
  ok(ds.bin === 'claude' && !ds.auth_setup, 'deepseek: the claude CLI reads the env directly');

  const grok = providerRunEnvFromAccount({ provider: 'grok', token: GROK_TOK });
  ok(grok.env.XAI_API_KEY === GROK_TOK && grok.bin === 'grok' && !grok.auth_setup,
     'grok: the runnable env is XAI_API_KEY alone — what the Grok Build CLI reads (measured on 0.2.118)');
  ok(!Object.keys(grok.env).some((k) => k in claude.env || k in codex.env || k in kimi.env),
     '…and it shares no env key with another vendor, so a cage can carry both without a collision');
}
section('the runnable env is refused through the SAME guarded door — never a second copy of the rule');
{
  // A claude token sitting in a kimi slot is refused with the existing named sentence — the same
  // guard the active vendor env and everyProviderEnv go through. The CLI never decides this.
  let threw = null;
  try { providerRunEnvFromAccount({ provider: 'kimi', token: CLAUDE_TOK }); } catch (e) { threw = e; }
  ok(!!threw && /claude/i.test(threw.message) && /kimi/i.test(threw.message) && /sk-ant-oat01-…CAAA/.test(threw.message),
     'a mis-attributed token is refused with the named sentence (masked, both vendors named)');
  ok(!threw.message.includes(CLAUDE_TOK), '…and the full token is never in the message');
  ok(providerRunEnvFromAccount({ provider: 'kimi', token: KIMI_TOK }).env.KIMI_MODEL_API_KEY === KIMI_TOK,
     'the right vendor passes unchanged — the guard is a filter, not a rewrite');
  let gh = null;
  try { providerRunEnvFromAccount({ provider: 'github', token: GITHUB_TOK }); } catch (e) { gh = e; }
  ok(!!gh && /no zee runtime/.test(gh.message), 'github (dispatch:false) is refused — a PAT never reaches a vendor CLI');
  let unknown = null;
  try { providerRunEnvFromAccount({ provider: 'nope', token: KIMI_TOK }); } catch (e) { unknown = e; }
  ok(!!unknown && /unknown provider/.test(unknown.message), 'an unknown provider is refused with a sentence');
  let empty = null;
  try { providerRunEnvFromAccount({ provider: 'kimi', token: '' }); } catch (e) { empty = e; }
  ok(!!empty && /no kimi token/.test(empty.message), 'an absent token is refused with the connect-one fix');
}

section('the wiring — the runnable env is a SERVER-computed endpoint, never a CLI-side mapping');
{
  const routes = readFileSync(join(ROOT, 'server', 'src', 'api', 'routes.js'), 'utf8');
  const self = readFileSync(join(ROOT, 'server', 'src', 'queenzee', 'self.js'), 'utf8');
  const tokens = readFileSync(join(ROOT, 'server', 'src', 'lib', 'provider-tokens.js'), 'utf8');
  const cli = readFileSync(join(ROOT, 'scripts', 'zee'), 'utf8');
  ok(/selfProviderEnv/.test(routes), 'routes.js imports selfProviderEnv from the self module');
  ok(/router\.get\('\/xell\/self\/provider-env'/.test(routes),
     '…and routes GET /xell/self/provider-env (read-only, token-scoped like every self verb)');
  ok(/res\.json\(await selfProviderEnv\(x, \{ provider: req\.query\.provider \|\| null \}\)\)/.test(routes),
     '…and resolves the calling xell FIRST — the token in the answer is only ever this xell\'s own');
  ok(/import \{[^}]*providerRunEnv[^}]*\} from '\.\.\/lib\/provider-tokens\.js'/.test(self),
     'self.js imports providerRunEnv (the I/O read) from the credential module');
  ok(/providerRunEnv\(xell\.project_id, want, \{ xellId: xell\.id \}\)/.test(self),
     '…and computes it against THIS xell\'s project AND its grant record — a zee can only ask for its own xell\'s granted env');
  ok(/xell_provider_grant/.test(tokens),
     '…and the answer comes from the GRANT LEDGER (xell_provider_grant), never the project\'s current key');
  ok(/providerRunEnvFromAccount/.test(tokens), 'provider-tokens.js exports the pure builder');
  // The CLI case may NAME the vendor env keys in prose (its comment says what the server returns)
  // but must never READ or ASSIGN one — the mapping stays in the adapters, not the CLI.
  ok(!/(envVar\(|console\.log\(|=\s*envVar)`['"]?(KIMI_MODEL|OPENAI_API_KEY|ANTHROPIC_AUTH_TOKEN)/.test(
     cli.slice(cli.indexOf('case \'creds\':'), cli.indexOf('case \'device\':'))),
     'the CLI case never reads or assigns a vendor env key itself — the mapping stays in the adapters');
}

console.log(fail ? `\n${fail} FAILURE(S)` : '\nall good');
process.exit(fail ? 1 : 0);
