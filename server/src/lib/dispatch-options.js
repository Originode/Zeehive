// WHAT A "＋ prompt" BUTTON MAY DISPATCH — one read model for the console's composer.
//
// THE FLOW THIS SERVES (the change it was written for): the console used to show one prompt button
// per connected AI ACCOUNT, and the persona (harness) was a segmented control buried at the bottom
// of the composer. That put the least consequential choice first — an account is a credential; the
// HARNESS is the manual, the skills and the model policy the zee actually runs under — and it made
// the two choices contradictable: a human could open the composer from a Claude account button and
// then pick a harness whose policy allows only deepseek, which dispatch then refused with a
// sentence (resolveDispatchModel) after the prompt was already written.
//
// So the button is now PER HARNESS, and everything downstream of it is derived from that one
// choice: this function answers "given this persona, on this project, what may a human actually
// pick?" — which providers (accounts connected AND allowed by the effective model policy), which
// models per provider (the policy's allowed set, in its deployment-priority order), which model a
// bare dispatch would land on, and what the autonomy scale really MEANS on each provider.
//
// Every answer here is DERIVED FROM THE SAME CODE THE DISPATCH PATH USES — the policy merge
// (lib/model-policy.js), the provider decision (lib/provider-tokens.js decideDispatchProvider), the
// per-provider runtime (lib/cxell-runtimes.js runtimeKeyForProvider) and the autonomy scale
// (queenzee/intake.js DISPATCH_MODES). A picker that offers what the spawn would refuse is the bug
// this module exists to make impossible, so nothing below restates a list that lives elsewhere.
import { one } from '../db/pool.js';
import { PROVIDERS, listProviderTokens, decideDispatchProvider } from './provider-tokens.js';
import { availableForModel } from './usage-limits.js';
import { effectiveModelPolicy, allowedModelsForProvider, modelSpecs, resolveDispatchModel } from './model-policy.js';
import { resolveHarness, defaultHarnessId } from './harness.js';
import { runtimeKeyForProvider, decideRuntimePairing } from './cxell-runtimes.js';
import { runtimeByKey, runtimeById } from './runtimes.js';
import { DISPATCH_MODES, listDispatchModels } from '../queenzee/intake.js';

// The harness a composer is asking about. Mirrors the composer's own three-state harness value
// exactly (Dispatch.jsx): undefined = "the default for this zee type", '' = core only (no harness),
// a key/id = that harness. Anything else here would make the picker and the spawn disagree about
// what "no choice" means — which is how a project default silently became core-only.
export async function harnessForOptions(projectId, harnessArg, zeeType = 'worker') {
  if (harnessArg === '' || harnessArg === 'none' || harnessArg === null) return null;   // core only
  if (harnessArg !== undefined) return resolveHarness(harnessArg);
  // No harness named → the same default the dispatch path would attach (intake.js): a manager wears
  // the manager harness; a worker wears the project's pool default, if it has one.
  if (zeeType === 'manager') return resolveHarness('manager');
  const id = await defaultHarnessId(projectId, { zeeType: 'worker' });
  return id ? resolveHarness(id) : null;
}

// The RUNTIME a dispatch on this provider would run on. A non-claude provider picks its runtime by
// itself (its own vendor CLI); claude resolves through the project's pool default / runtime toggle.
// Same resolution order as spawnHeadless, and the cxell fallback is the same deliberate one: a xell
// is confined unless a human explicitly opted out.
//
// …and then through the SAME pairing spawnHeadless applies (decideRuntimePairing), because clicking
// an account in this picker NAMES that provider — so on a project whose pool default is another
// vendor's cxell runtime, the spawn runs claude on claude's own runtime and this list would
// otherwise announce deepseek-cxell. That is the "a picker that offers what the spawn would refuse"
// bug this module exists to prevent, one field over: it would have named the wrong CLI.
async function runtimeForProvider(provider, projectId) {
  const key = runtimeKeyForProvider(provider);
  if (key) return runtimeByKey(key);
  const cfg = await one(`SELECT default_runtime_id FROM pool_config WHERE project_id=$1`, [projectId]);
  const rt = (await runtimeById(cfg?.default_runtime_id)) || (await runtimeByKey('claude-code-cxell'));
  const pair = decideRuntimePairing({ provider, providerNamed: true, runtimeKey: rt?.key || null,
                                      runtimeIsCaged: rt?.driver === 'cxell-cli' });
  if (!pair.ok || pair.runtimeKey === rt?.key) return rt;
  return (await runtimeByKey(pair.runtimeKey)) || rt;
}

// THE AUTONOMY SCALE, ANNOTATED FOR THE RUNTIME THIS PROVIDER RUNS ON.
//
// The scale (1 recon … 5 bypass) is real for the SDK runtimes, where it sets the session's
// permission mode and tool allow-list. Inside a CXELL it is not: spawnCxell stores
// 'bypassPermissions' unconditionally and only LOGS the mode that was requested — the cage IS the
// permission system, and the vendor CLIs are launched with their own bypass flags. The console
// offered all five identically on every provider, so picking "1 · plan" for a Codex zee looked like
// read-only recon and dispatched a zee that could do anything. Say so instead.
export function modesForRuntime({ caged = false } = {}) {
  return Object.entries(DISPATCH_MODES).map(([n, m]) => {
    const mode = Number(n);
    const enforced = !caged || mode === 5;
    return {
      mode, key: m.key, permission_mode: m.permissionMode, tools: m.tools || 'all', label: m.label,
      enforced,
      note: enforced ? null
        : 'recorded only — this provider runs its CLI inside the cxell, which always bypasses '
          + 'permissions (the cage is the permission system)',
    };
  });
}

// The models this policy allows on this provider, in the picker's shape. The REGISTRY
// (ai_model_spec) is the source; the code list (listDispatchModels) is the fallback for a provider
// the registry has no rows for, so a fleet whose migration has not run still gets a usable picker
// instead of an empty one.
async function modelsFor(policy, provider) {
  const allowed = await allowedModelsForProvider(policy, provider);
  if (allowed.length) {
    return allowed.map((m) => ({
      key: m.key, label: m.label, note: m.note || null, priority: m.priority,
      context_window: m.context_window, max_output: m.max_output, parameters: m.parameters,
      is_registry_default: !!m.is_default,
    }));
  }
  // Nothing allowed. Two very different reasons, and only one of them is an empty picker: either
  // the registry knows this provider and the POLICY filtered every row out (a real restriction —
  // report it as such), or the registry has no rows at all (fall back to the code list, filtered by
  // the policy's model allow-list so the fallback can never offer more than the policy does).
  const known = await modelSpecs({ provider, enabledOnly: false });
  if (known.length) return [];
  const allow = policy.allow_models || [];
  return listDispatchModels(provider)
    .filter((m) => !allow.length || allow.includes(m.key))
    .map((m) => ({ key: m.key, label: m.label, note: m.note || null, priority: 1,
                   context_window: null, max_output: null, parameters: null,
                   is_registry_default: !!m.default }));
}

// What a BARE dispatch would run on this provider under this policy — resolved by the very function
// the spawn calls, so the "·default" the picker marks is the model the zee would actually get.
// Returns null when the policy refuses this provider outright (the caller already says why).
async function defaultModelFor(harnessRow, provider) {
  const fallback = listDispatchModels(provider).find((m) => m.default)?.key ?? null;
  try {
    const { model } = await resolveDispatchModel({
      harnessRow, provider, requestedModel: null, fallbackModel: fallback,
    });
    return model;
  } catch { return null; }
}

// ── the read model ────────────────────────────────────────────────────────────────────────────
// GET /api/dispatch/options?project=…&harness=…&zee_type=…
export async function dispatchOptions({ projectId, harness: harnessArg, zeeType = 'worker' } = {}) {
  if (!projectId) throw new Error('project required');
  const type = zeeType === 'manager' ? 'manager' : 'worker';
  const harnessRow = await harnessForOptions(projectId, harnessArg, type);
  const policy = await effectiveModelPolicy(harnessRow);
  const tokens = await listProviderTokens(projectId);

  const providers = [];
  for (const p of tokens) {
    if (!p.dispatch) continue;                       // github: an infra credential, not a zee runtime
    const allowed = !policy.allow_providers.length || policy.allow_providers.includes(p.provider);
    const rt = await runtimeForProvider(p.provider, projectId);
    // No runtime row resolvable → the dispatch path's own fallback is a cxell, so annotate as caged
    // rather than promising an enforcement that would not happen.
    const caged = !rt || rt.driver === 'cxell-cli';
    const usableAccounts = p.accounts.filter((a) => !a.paused);
    const models = allowed ? await modelsFor(policy, p.provider) : [];
    // USAGE LIMIT for the provider: worst remaining among active accounts (provider-wide).
    // Per-MODEL limits are attached to each model row below (opus vs fable vs sonnet windows).
    const limitSource = usableAccounts.find((a) => a.usage_limit) || p.accounts.find((a) => a.usage_limit) || null;
    const providerLimit = availableForModel(limitSource?.usage_limit, { provider: p.provider, model: null });
    const modelsWithLimit = models.map((m) => {
      const lim = availableForModel(limitSource?.usage_limit, { provider: p.provider, model: m.key });
      return {
        ...m,
        // How much of this model's limit is still AVAILABLE on the project's best-known account.
        // Null until the gateway has seen a call for that account (no snapshot yet).
        available_pct: lim.available_pct,
        limit_window: lim.window,
        limit_source: lim.source,   // 'model' | 'provider' | null
      };
    });
    providers.push({
      provider: p.provider, label: p.label,
      connected: p.connected, all_paused: p.all_paused,
      accounts: p.accounts.map((a) => {
        const al = availableForModel(a.usage_limit, { provider: p.provider, model: null });
        return {
          id: a.id, label: a.label, token_hint: a.token_hint, paused: a.paused,
          // What the console's button called an account: its own label, else the provider type (with
          // the token tail when the project holds several of the type — otherwise two buttons read
          // identically and neither says which subscription it spends).
          name: a.label || (p.accounts.length > 1 ? `${p.label} ·${(a.token_hint || '').slice(-4)}` : p.label),
          available_pct: al.available_pct,
          usage_limit: a.usage_limit || null,
          usage_limit_at: a.usage_limit_at || null,
        };
      }),
      allowed,
      // Why a human cannot pick this provider — ONE sentence, the same shape the spawn would have
      // thrown after the prompt was written. null = pickable.
      blocked_reason: !allowed
        ? `this harness's model policy allows only ${policy.allow_providers.join(', ')}`
        : !p.connected ? `no ${p.label} account is connected to this project — add one in Project setup`
        : !usableAccounts.length ? `every ${p.label} account on this project is PAUSED`
        : (allowed && !models.length) ? "this harness's model policy allows no model on this provider"
        : null,
      models: modelsWithLimit,
      // Provider-wide remaining (fallback when a model has no tier window of its own).
      available_pct: providerLimit.available_pct,
      default_model: allowed ? await defaultModelFor(harnessRow, p.provider) : null,
      runtime: rt ? { key: rt.key, label: rt.label, caged } : { key: null, label: null, caged: true },
      modes: modesForRuntime({ caged }),
    });
  }

  // WHICH PROVIDER THE COMPOSER OPENS ON — the same decision a bare dispatch makes, so the
  // pre-selected segment is the one the spawn would have chosen anyway. accounts arrive
  // freshest-first, exactly as tokenForSpawn picks within a type.
  const accounts = tokens.filter((p) => p.dispatch)
    .flatMap((p) => p.accounts.map((a) => ({ provider: p.provider, paused: a.paused, created_at: a.created_at })))
    .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
  const decided = decideDispatchProvider({ allowProviders: policy.allow_providers, accounts });
  const pickable = providers.filter((p) => !p.blocked_reason);
  const defaultProvider = pickable.find((p) => p.provider === decided.provider)?.provider
    || pickable[0]?.provider || null;

  return {
    harness: harnessRow ? {
      key: harnessRow.key, label: harnessRow.label, zee_type: harnessRow.zee_type,
      glyph: harnessRow.bundle?.glyph || null, summary: harnessRow.bundle?.summary || null,
      scope: harnessRow.project_id ? 'project' : 'global',
      avatar_url: harnessRow.bundle?.avatar_svg ? `/api/harnesses/${harnessRow.key}/avatar` : null,
    } : null,
    // The EFFECTIVE policy (the whole parent chain merged) — what the composer explains to a human,
    // and what dispatch will enforce. Never the row's own knobs: a child that inherits "claude only"
    // has an empty policy of its own and would render as unrestricted.
    policy,
    providers,
    default_provider: defaultProvider,
    default_provider_reason: decided.reason,
    modes: modesForRuntime({ caged: false }),   // the unannotated scale, for a composer with no provider yet
  };
}
