// PROVIDER, RUNTIME AND CREDENTIAL MUST NAME THE SAME VENDOR.
//
// A dispatch decides three things separately and they were never checked against each other:
//   • the PROVIDER   — lib/provider-tokens.js decideDispatchProvider (rule 4: an active claude
//                      account wins whenever the caller named nothing);
//   • the RUNTIME    — the caller's `runtime`, else pool_config.default_runtime_id, else the cxell
//                      fallback (queenzee/intake.js);
//   • the CREDENTIAL — spawnCreds(pid, provider), injected into the cage by the RUNTIME's adapter
//                      (lib/cxell-runtimes.js).
// On a project whose pool default is `deepseek-cxell`, a bare dispatch therefore resolved
// provider='claude' (an account is connected), kept the pool's DeepSeek runtime (claude has no
// entry in PROVIDER_RUNTIME, so nothing overrode it) and handed the CLAUDE token to the DeepSeek
// adapter, which sets it as ANTHROPIC_AUTH_TOKEN against api.deepseek.com. DeepSeek answered
// "Authentication Fails, Your api key: ****CAAA is invalid" — a sentence that blames the
// CREDENTIAL, so a human quarantines a perfectly healthy account. Four zees died that way on
// 2026-08-03, each costing a xell and producing nothing.
//
// The pairing is now a PURE decision (lib/cxell-runtimes.js decideRuntimePairing) for the same
// reason decideDispatchProvider is: the project state that broke — a non-claude pool default next
// to a claude account — is one this repo's own meta-DB does not have, so the whole rule has to be
// table-testable without a database.
//
// The rule, and what must not be weakened by it:
//   • EXPLICIT BEATS CONFIGURED, CONFIGURED BEATS INFERRED. A caller-named provider wins over a
//     pool default; the runtime (named or configured by a human) wins over a provider that was
//     merely INFERRED from which accounts happen to be connected, and its own credential is used.
//   • TWO EXPLICIT INSTRUCTIONS THAT DISAGREE ARE REFUSED, never reconciled — with a sentence
//     naming what disagreed and what to change.
//   • A HOST-AUTH RUNTIME (claude-code-remote, the local SDK) reads no meta-DB token, so it is
//     never repaired and never refused.
//
// What this file covers: the pure pairing rule (table), the DISPATCH path's wiring in
// queenzee/intake.js, the SWAP path (queenzee/self.js swapZeeInXell re-dispatches with neither
// provider nor runtime named, so it hit this bug the same way — and is fixed by the same code
// because it owns neither decision), and the console PICKER (lib/dispatch-options.js), which must
// name the CLI the spawn would actually run. It is a static + pure-decision test by design: the
// project state that breaks needs no database to describe.
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) fail++; };
const section = (t) => console.log(`\n── ${t} ──`);

const { decideDispatchProvider } = await import('../server/src/lib/provider-tokens.js');
const rtLib = await import('../server/src/lib/cxell-runtimes.js');
const { runtimeKeyForProvider, adapterFor } = rtLib;
// which vendor CLI the CAGE would actually run for a runtime key, and whose credential env it sets
// (null = no adapter, so no meta-DB credential is injected by it at all)
const adapterProvider = (key) => { try { return adapterFor(key).provider; } catch { return null; } };

// The dispatch decision as spawnHeadless makes it, with NO database: provider first, then the
// runtime+credential pairing. The fallback is intake.js's rule BEFORE the fix ("a non-claude
// provider picks its runtime by itself; otherwise keep the configured one") — kept deliberately so
// this file is a REPRODUCTION: run it against the pre-fix tree and the invariant below fails
// exactly the way those four spawns did.
const pairing = rtLib.decideRuntimePairing
  || (({ provider, runtimeKey }) => ({ ok: true, provider, runtimeKey: runtimeKeyForProvider(provider) || runtimeKey, reason: 'pre-fix' }));

function dispatchDecision({ accounts = [], poolDefaultRuntime = 'claude-code-cxell',
                            requestedProvider = null, requestedRuntime = null,
                            allowProviders = [], caged = true } = {}) {
  const named = !!String(requestedProvider || '').trim();
  const { provider } = decideDispatchProvider({ requested: requestedProvider, allowProviders, accounts });
  const runtimeKey = requestedRuntime || poolDefaultRuntime;
  const paired = pairing({ provider, providerNamed: named, runtimeKey,
                           runtimeNamed: !!requestedRuntime, runtimeIsCaged: caged, allowProviders });
  if (!paired.ok) return { refused: paired.refuse };
  // spawnCxell: the credential is read for `provider`, the cage is built by the RUNTIME's adapter
  return { credentialProvider: paired.provider, runtimeKey: paired.runtimeKey,
           adapterProvider: adapterProvider(paired.runtimeKey), reason: paired.reason };
}

const A = (provider, paused = false) => ({ provider, paused });

section('THE BUG: the credential a spawn reads and the CLI it feeds must be the same vendor');
{
  // the exact project state that killed four zees: pool default deepseek-cxell, a claude account
  const d = dispatchDecision({ accounts: [A('claude'), A('deepseek')], poolDefaultRuntime: 'deepseek-cxell' });
  ok(!d.refused && d.credentialProvider === d.adapterProvider,
     `a bare dispatch on a deepseek-default pool pairs its own credential `
     + `[credential=${d.credentialProvider} runtime=${d.runtimeKey} adapter=${d.adapterProvider}]`);
  ok(d.credentialProvider === 'deepseek' && d.runtimeKey === 'deepseek-cxell',
     '…and it is the RUNTIME the human configured that decides, not the account that happens to be connected');
}
for (const rtKey of ['claude-code-cxell', 'codex-cxell', 'kimi-code-cxell', 'deepseek-cxell', 'grok-cxell']) {
  for (const accts of [[A('claude')], [A('openai')], [A('kimi')], [A('claude'), A('openai'), A('kimi'), A('deepseek')], []]) {
    const d = dispatchDecision({ accounts: accts, poolDefaultRuntime: rtKey });
    ok(d.refused || d.credentialProvider === d.adapterProvider,
       `pool default ${rtKey} + accounts [${accts.map((a) => a.provider).join(',') || 'none'}] `
       + `→ ${d.refused ? 'refused' : `${d.credentialProvider} on ${d.runtimeKey}`}`);
  }
}

section('the pairing rule');
ok(typeof rtLib.decideRuntimePairing === 'function', 'lib/cxell-runtimes.js exports decideRuntimePairing');
const CASES = [
  { what: 'THE BUG: an INFERRED claude next to a configured deepseek runtime → the runtime wins, with its own credential',
    in: { provider: 'claude', runtimeKey: 'deepseek-cxell' },
    want: { provider: 'deepseek', runtimeKey: 'deepseek-cxell', reason: 'runtime-provider' } },
  { what: 'the common case is untouched: claude account, claude pool default',
    in: { provider: 'claude', runtimeKey: 'claude-code-cxell' },
    want: { provider: 'claude', runtimeKey: 'claude-code-cxell', reason: 'agree' } },
  { what: "a non-claude provider still picks its own vendor CLI (today's rule, unchanged)",
    in: { provider: 'openai', providerNamed: true, runtimeKey: 'deepseek-cxell' },
    want: { provider: 'openai', runtimeKey: 'codex-cxell', reason: 'provider-runtime' } },
  { what: 'an EXPLICIT claude beats a mere pool default — the account button means what it says',
    in: { provider: 'claude', providerNamed: true, runtimeKey: 'deepseek-cxell' },
    want: { provider: 'claude', runtimeKey: 'claude-code-cxell', reason: 'named-provider' } },
  { what: 'an explicitly NAMED runtime beats an inferred provider, same as the pool default does',
    in: { provider: 'claude', runtimeKey: 'kimi-code-cxell', runtimeNamed: true },
    want: { provider: 'kimi', runtimeKey: 'kimi-code-cxell', reason: 'runtime-provider' } },
  { what: 'BOTH named and disagreeing → refused, never reconciled',
    in: { provider: 'claude', providerNamed: true, runtimeKey: 'deepseek-cxell', runtimeNamed: true },
    want: { refuse: /provider "claude"/ } },
  { what: '…and the refusal names the runtime, its vendor, and what to change',
    in: { provider: 'claude', providerNamed: true, runtimeKey: 'deepseek-cxell', runtimeNamed: true },
    want: { refuse: /deepseek-cxell.*deepseek/s } },
  { what: 'a host-auth runtime (claude remote / the local SDK) is never repaired — it reads no meta-DB token',
    in: { provider: 'claude', runtimeKey: 'claude-code-remote', runtimeIsCaged: false },
    want: { provider: 'claude', runtimeKey: 'claude-code-remote', reason: 'agree' } },
  { what: 'a harness that forbids the runtime\'s vendor refuses rather than running the persona on it',
    in: { provider: 'claude', runtimeKey: 'deepseek-cxell', allowProviders: ['claude'] },
    want: { refuse: /harness/i } },
  { what: '…and allows it when the policy does',
    in: { provider: 'claude', runtimeKey: 'deepseek-cxell', allowProviders: ['claude', 'deepseek'] },
    want: { provider: 'deepseek', runtimeKey: 'deepseek-cxell', reason: 'runtime-provider' } },
  { what: 'an unknown runtime key is left alone — adapterFor already fails the dispatch with a better sentence',
    in: { provider: 'claude', runtimeKey: 'not-a-runtime' },
    want: { provider: 'claude', runtimeKey: 'not-a-runtime', reason: 'unknown-runtime' } },
];
if (typeof rtLib.decideRuntimePairing === 'function') {
  for (const c of CASES) {
    const got = rtLib.decideRuntimePairing(c.in);
    const pass = c.want.refuse
      ? (got.ok === false && c.want.refuse.test(String(got.refuse || '')))
      : (got.ok === true && got.provider === c.want.provider && got.runtimeKey === c.want.runtimeKey
         && got.reason === c.want.reason);
    ok(pass, `${c.what} [${got.ok === false ? `refused: ${String(got.refuse).slice(0, 80)}` : `${got.provider}/${got.runtimeKey}/${got.reason}`}]`);
  }
} else {
  fail += CASES.length;
  console.log(`  ✗ FAIL ${CASES.length} pairing cases not run — the rule does not exist yet`);
}

section('THE SWAP PATH — the same defect, and therefore the same fix site');
// A swap (queenzee/self.js swapZeeInXell — `zee swap`, and the console's POST /api/xells/:id/swap)
// RE-DISPATCHES into a live xell, and it names neither provider nor runtime unless a human typed
// one. So it resolves EXACTLY like a bare dispatch: pool default deepseek-cxell + a connected claude
// account. On 2026-08-03 that is how the swap into this very xell killed the incoming zee at spawn —
// '401 Authentication Fails, Your api key: ****CAAA is invalid' before it read one line of its brief.
{
  const d = dispatchDecision({ accounts: [A('claude'), A('deepseek')], poolDefaultRuntime: 'deepseek-cxell' });
  ok(!d.refused && d.credentialProvider === d.adapterProvider,
     'a SWAP that names neither provider nor runtime pairs its own credential too '
     + `[credential=${d.credentialProvider} runtime=${d.runtimeKey} adapter=${d.adapterProvider}]`);
  const named = dispatchDecision({ accounts: [A('claude')], poolDefaultRuntime: 'claude-code-cxell',
                                   requestedProvider: 'claude', requestedRuntime: 'deepseek-cxell' });
  ok(!!named.refused, 'a swap whose human named a provider AND a contradicting runtime is refused, not started');
}
// …because the swap OWNS neither decision: it hands both through to dispatchXell → spawnHeadless,
// which is the single place the pairing is settled. That is asserted rather than assumed — a swap
// that grew its own runtime/credential resolution would reopen the bug on a path with no test.
const self = readFileSync(join(ROOT, 'server', 'src', 'queenzee', 'self.js'), 'utf8');
const swapBody = self.slice(self.indexOf('export async function swapZeeInXell'),
                            self.indexOf('export async function swapXellZeeAsHuman'));
ok(swapBody.length > 500 && /dispatchXell\(\{/.test(swapBody),
   'swapZeeInXell re-dispatches through dispatchXell (one spawn path, not a second one)');
ok(!/default_runtime_id|runtimeByKey|runtimeById|decideDispatchProvider|spawnCreds/.test(swapBody),
   'the swap resolves NEITHER the runtime NOR the credential itself — so it cannot pair them wrongly');
ok(/\.\.\.\(runtime \? \{ runtime \} : \{\}\)/.test(swapBody) && /\.\.\.\(provider \? \{ provider \} : \{\}\)/.test(swapBody),
   'it passes an explicitly named provider/runtime straight through (so the refusal above is reachable from a swap)');

section('the wiring');
const intake = readFileSync(join(ROOT, 'server', 'src', 'queenzee', 'intake.js'), 'utf8');
ok(/spawnHeadless\(\{[\s\S]{0,400}runtime,[\s\S]{0,400}provider, providerTokenId: provider_token_id/.test(intake),
   'dispatchXell hands the caller\'s runtime AND provider to spawnHeadless — the one path a swap, a crew '
   + 'dispatch and the console all take');
ok(/decideRuntimePairing/.test(intake), 'spawnHeadless resolves the pair through decideRuntimePairing');
ok(!/claudeRt/.test(intake),
   'the variable that holds the pool default is no longer called claudeRt (it holds whatever the pool configured)');
ok(intake.includes('decideRuntimePairing(')
   && intake.indexOf('decideRuntimePairing(') < intake.indexOf('resolveDispatchModel('),
   'the pair is settled BEFORE the model policy, which is asked about that exact provider');
ok(/if \(!pair\.ok\) throw new Error\(pair\.refuse\)/.test(intake),
   'a refused pairing throws the sentence — a mismatch is never started silently');
ok(/pair\.provider !== provider[\s\S]{0,600}await assertProviderDispatchable\(pid, provider\)/.test(intake),
   'a provider the RUNTIME decided is re-checked against the pause gate, like a resolved one');
ok(/spawnCreds\(pid, provider/.test(intake) && /adapterFor\(rt\?\.key\)/.test(intake),
   'spawnCxell still reads the credential for `provider` and builds the cage from the runtime adapter '
   + '(the two the pairing above makes agree)');

section('the console PICKER must name the CLI the spawn would actually run');
// lib/dispatch-options.js answers "what would a bare dispatch do?" for the composer, and its own
// contract is that every answer is derived from the code the dispatch path uses. Clicking an account
// NAMES that provider, so with the pairing in place a claude dispatch on a deepseek-default project
// runs on claude-code-cxell — a picker still reading the raw pool default would announce
// deepseek-cxell and be wrong in the one field this bug is about.
const opts = readFileSync(join(ROOT, 'server', 'src', 'lib', 'dispatch-options.js'), 'utf8');
ok(/decideRuntimePairing\(\{[\s\S]{0,200}providerNamed: true/.test(opts),
   'runtimeForProvider derives the shown runtime through the same pairing, as an explicitly named provider');
{
  const picked = rtLib.decideRuntimePairing?.({ provider: 'claude', providerNamed: true,
                                                runtimeKey: 'deepseek-cxell', runtimeIsCaged: true });
  ok(picked?.ok === true && picked.runtimeKey === 'claude-code-cxell',
     `…so the picker shows claude on ${picked?.runtimeKey || '(no rule)'}, which is what the spawn does`);
}

console.log(fail ? `\n${fail} FAILURE(S)` : '\nall good');
process.exit(fail ? 1 : 0);
