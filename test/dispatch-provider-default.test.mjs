// A BARE DISPATCH MUST NOT HAVE A FAVOURITE VENDOR.
//
// Every dispatch entry point defaulted to `provider = 'claude'` in its signature, and a default is
// not a statement of intent: "the caller named no provider" and "the caller asked for claude" were
// the same input. On a project whose only connected account is Codex or Kimi, a bare dispatch — a
// queued task, an MCP call, a manager's `zee dispatch`, a swap that carried no provider, a manager
// created from the console — therefore died on `project has no claude token — connect one in
// Project setup`, naming a vendor the human had deliberately not connected. The cage carries every
// vendor's CLI; the dispatch should not insist on one.
//
// The rule lives in lib/provider-tokens.js decideDispatchProvider as a PURE decision (the same shape
// as prod-readonly.js decideReaderAddress), so the whole of it is table-testable without a database
// — which matters here, because the case that broke is a project state this repo's own meta-DB does
// not have.
//
// The two rules that must NOT be weakened by any of it:
//   • AN EXPLICIT PROVIDER IS AN INSTRUCTION, including 'claude'. Nothing here may second-guess a
//     caller that named one, or the console's per-account buttons stop meaning what they say.
//   • A HOST-AUTH RUNTIME STAYS ON CLAUDE. `claude-code-remote` and the local SDK authenticate from
//     the host's own claude session and read no meta-DB token at all, so "no claude account
//     connected" is not a reason to move them onto another vendor's CLI — that would silently
//     change the RUNTIME, which is a human's choice (and the one that un-cages a zee).
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) fail++; };
const section = (t) => console.log(`\n── ${t} ──`);

const { decideDispatchProvider } = await import('../server/src/lib/provider-tokens.js');

// accounts arrive freshest-first, exactly as tokenForSpawn picks within a type
const A = (provider, paused = false) => ({ provider, paused });

section('the decision table');
const CASES = [
  { what: 'an explicit provider is an instruction, even when nothing is connected',
    in: { requested: 'kimi', accounts: [] }, want: ['kimi', 'requested'] },
  { what: "…and that includes an explicit 'claude'",
    in: { requested: 'claude', accounts: [A('openai')] }, want: ['claude', 'requested'] },
  { what: 'a host-auth runtime (claude remote / the local SDK) stays on claude with no account at all',
    in: { claudeNeedsNoToken: true, accounts: [A('openai')] }, want: ['claude', 'host-auth-runtime'] },
  { what: "today's behaviour is unchanged wherever a claude account is connected",
    in: { accounts: [A('openai'), A('claude')] }, want: ['claude', 'claude-account'] },
  { what: 'the case that broke: one connected provider, and it is not claude',
    in: { accounts: [A('openai')] }, want: ['openai', 'only-connected-provider'] },
  { what: 'several non-claude providers → the freshest connected account decides (tokenForSpawn agrees)',
    in: { accounts: [A('kimi'), A('openai')] }, want: ['kimi', 'freshest-connected-account'] },
  { what: 'a PAUSED claude account does not count as connected — the pause must not be routed around',
    in: { accounts: [A('claude', true), A('openai')] }, want: ['openai', 'only-connected-provider'] },
  { what: 'every account paused → claude, so the refusal a human reads is the familiar one',
    in: { accounts: [A('openai', true)] }, want: ['claude', 'fallback'] },
  { what: 'nothing connected at all → claude (unchanged: "connect one in Project setup")',
    in: { accounts: [] }, want: ['claude', 'fallback'] },
  { what: 'a harness that allows only one provider decides among what it allows',
    in: { allowProviders: ['openai'], accounts: [A('claude'), A('openai')] }, want: ['openai', 'only-connected-provider'] },
  { what: '…and names its own vendor even with nothing connected, so the refusal is about the persona',
    in: { allowProviders: ['kimi'], accounts: [] }, want: ['kimi', 'harness-policy'] },
  { what: 'github is an infra credential, never a provider a zee runs on',
    in: { accounts: [A('github')] }, want: ['claude', 'fallback'] },
];
for (const c of CASES) {
  const got = decideDispatchProvider(c.in);
  ok(got.provider === c.want[0] && got.reason === c.want[1],
     `${c.what} [${got.provider}/${got.reason}]`);
}

section('the wiring');
const intake = readFileSync(join(ROOT, 'server', 'src', 'queenzee', 'intake.js'), 'utf8');
const tokens = readFileSync(join(ROOT, 'server', 'src', 'lib', 'provider-tokens.js'), 'utf8');
const mgr = readFileSync(join(ROOT, 'server', 'src', 'lib', 'manager-spawn.js'), 'utf8');
const sig = (fn) => intake.slice(intake.indexOf(fn)).slice(0, 900);
ok(!/provider = 'claude'/.test(sig('export async function spawnHeadless(')),
   "spawnHeadless no longer defaults to 'claude' in its signature");
ok(!/provider = 'claude'/.test(sig('export async function dispatchXell(')),
   "…nor does dispatchXell");
ok(!/provider = 'claude'/.test(mgr), '…nor does createManagerZee (a manager on a Codex-only project)');
ok(/dispatchProviderFor\(pid, \{[\s\S]{0,200}allowProviders/.test(intake),
   'spawnHeadless resolves through dispatchProviderFor, harness policy included');
ok(/if \(String\(provider \|\| ''\)\.trim\(\)\) await assertProviderDispatchable/.test(intake),
   'the pause pre-flight only runs on a provider the CALLER named (an unresolved one is not a provider)');
ok(/provider = picked\.provider;[\s\S]{0,600}await assertProviderDispatchable\(pid, provider\)/.test(intake),
   '…and runs AGAIN on the resolved one, so a resolution can never route around a paused account');
ok(intake.indexOf('const picked = await dispatchProviderFor') < intake.indexOf('const resolved = await resolveDispatchModel'),
   'the provider is decided BEFORE the model policy, which is asked about that exact provider');
// `configuredRt` was called `claudeRt` until 2026-08-03, when it turned out to hold whatever runtime
// the pool defaults to — deepseek-cxell on this very project (test/provider-runtime-credential.test.mjs).
ok(/claudeNeedsNoToken: configuredRt\?\.key === 'claude-code-remote' \|\| configuredRt\?\.driver !== 'cxell-cli'/.test(intake),
   'a remote/local claude runtime is recognised as host-auth, so it is never moved off claude');
ok(/tokenId: providerTokenId/.test(intake) && /reason: 'named-account'/.test(tokens),
   'an account id with no provider beside it still names its own provider');

console.log(fail ? `\n${fail} FAILURE(S)` : '\nall good');
process.exit(fail ? 1 : 0);
