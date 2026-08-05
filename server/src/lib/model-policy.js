// AI MODEL SPECS + PER-HARNESS MODEL POLICY — the meta-DB registry and the knobs that
// restrict what a zee may run on, resolved at dispatch time.
//
// Two halves (migration 110):
//
// (A) ai_model_spec — one row per (provider, model id/alias): label, note, context window,
//     max output and parameter count. The registry is DATA (house rule: what a zee runs on is
//     data), editable in the console and read on the dispatch path — not a hard-coded list that
//     needs a land/ship to change.
//
// (B) harness.model_policy — jsonb restriction knobs on the harness a zee wears:
//       allow_providers  []string  — providers a wearer may run on (empty = all)
//       allow_models     []string  — model keys a wearer may run on (empty = all)
//       min_context      bigint    — minimum context window a model must have (tokens)
//       max_context      bigint    — maximum context window (tokens)
//       min_params       bigint    — minimum parameter count a model must have (BILLIONS)
//       max_params       bigint    — maximum parameter count (BILLIONS)
//       priorities       {model: n} — DEPLOYMENT PRIORITY per model; default 1; higher deploys
//                                      first (a bare dispatch picks the highest-priority allowed
//                                      model for the provider)
//       default_model    string    — the model a bare dispatch runs when no other preference
//                                      exists (overrides the code DEFAULT_ZEE_MODEL)
//       limit            int       — (139) max LIVE xells that may WEAR this harness per
//                                      project (absent/null = unlimited). Enforced at assign
//                                      time (lib/harness.js assignHarness), so dispatch, swap
//                                      and the console chip all hit one wall. The router
//                                      harness ships with limit 1 — "the router" is singular.
//
// A harness INHERITS policy from its parent chain exactly like persona/skills/memory. The
// restriction lists INTERSECT (a child cannot widen what its parent forbids — that would let a
// worker persona escape a manager's "claude only" rule by authoring a child), the scalar bounds
// and priorities are leaf-wins, and default_model is leaf-wins.
//
// The law layer (core) carries no policy and is never consulted — a harness policy is a config
// layer, not law, exactly like personality/skills.
import { q, one } from '../db/pool.js';

// ── normalization ─────────────────────────────────────────────────────────────
// The column is operator-editable jsonb, so every read is defensive: wrong shapes degrade to
// "not set" rather than throwing on the hot dispatch path.
export function normalizePolicy(p) {
  const pol = (typeof p === 'string' ? JSON.parse(p) : (p || {})) || {};
  const num = (v) => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
  const strArr = (v) => Array.isArray(v) ? [...new Set(v.map(String).map((s) => s.trim()).filter(Boolean))] : [];
  const pri = pol.priorities && typeof pol.priorities === 'object' && !Array.isArray(pol.priorities)
    ? Object.fromEntries(Object.entries(pol.priorities)
        .map(([k, v]) => [String(k).trim(), Number.isFinite(Number(v)) ? Number(v) : 1])
        .filter(([k]) => k))
    : {};
  // SPARSE, deliberately — a policy stores ONLY the fields this harness explicitly overrides.
  // An omitted field means "inherit from the parent chain" (hierarchical harnesses); the merge
  // (mergePolicies) treats an absent field as no restriction and lets an ancestor's value stand.
  // A full-shape policy here would write "null / empty" for every unset field and break reset-
  // to-inherit. The union of the normalized fields is the stored shape.
  const out = {};
  if ('allow_providers' in pol) out.allow_providers = strArr(pol.allow_providers);
  if ('allow_models' in pol) out.allow_models = strArr(pol.allow_models);
  if ('min_context' in pol) out.min_context = num(pol.min_context);
  if ('max_context' in pol) out.max_context = num(pol.max_context);
  if ('min_params' in pol) out.min_params = num(pol.min_params);
  if ('max_params' in pol) out.max_params = num(pol.max_params);
  if (Object.keys(pri).length) out.priorities = pri;
  if ('default_model' in pol) out.default_model = pol.default_model ? String(pol.default_model).trim() : null;
  // limit: a per-project cap on live wearers. A non-negative integer or null; a negative or
  // unparsable value degrades to "not set" like every other field here.
  if ('limit' in pol) {
    const n = num(pol.limit);
    out.limit = n != null && n >= 0 ? Math.floor(n) : null;
  }
  return out;
}

// Merge two RESTRICTION LIST values. An empty list means "no restriction (yet)" — so an empty
// parent adopts a child's restriction, and an empty child leaves the parent's standing. When both
// are non-empty they INTERSECT: a child cannot widen what its parent forbids, and a parent's
// "no restriction" cannot be narrowed by an empty child.
const intersect = (cur, next) => {
  if (!cur.length) return [...next];
  if (!next.length) return [...cur];
  return cur.filter((x) => next.includes(x));
};

// Merge a CHAIN of raw policies (root → leaf). Restriction lists INTERSECT, scalars are
// leaf-wins, priorities merge with leaf winning per model, default_model leaf-wins.
export function mergePolicies(chain) {
  const merged = {
    allow_providers: [],
    allow_models: [],
    min_context: null,
    max_context: null,
    min_params: null,
    max_params: null,
    priorities: {},
    default_model: null,
    limit: null,
  };
  for (const raw of chain || []) {
    const p = normalizePolicy(raw);
    // The policy is SPARSE (only overridden fields present) — an absent key is "no restriction",
    // which intersect and the scalar reads below already treat as neutral.
    merged.allow_providers = intersect(merged.allow_providers, p.allow_providers || []);
    merged.allow_models = intersect(merged.allow_models, p.allow_models || []);
    for (const k of ['min_context', 'max_context', 'min_params', 'max_params']) {
      if (p[k] != null) merged[k] = p[k];
    }
    for (const [m, pr] of Object.entries(p.priorities || {})) merged.priorities[m] = pr;
    if (p.default_model) merged.default_model = p.default_model;
    // `limit` merges MIN-WINS, not leaf-wins: a cap is a restriction, and a child widening its
    // parent's cap would be the same escape the allow-list intersection exists to prevent.
    if (p.limit != null) merged.limit = merged.limit == null ? p.limit : Math.min(merged.limit, p.limit);
  }
  return merged;
}

// The harness row → its chain (root first). Mirrors effectiveHarness's walk so the policy
// and the persona always agree on who the ancestors are.
export async function harnessChain(leafRow) {
  const chain = [];
  let cur = leafRow, hops = 0;
  while (cur && hops++ < 32) {
    chain.unshift(cur);
    if (!cur.parent_id) break;
    cur = await one(`SELECT * FROM harness WHERE id=$1 AND enabled`, [cur.parent_id]);
  }
  return chain;
}

// The EFFECTIVE policy a wearer is subject to — every policy in the chain, merged.
export async function effectiveModelPolicy(harnessRow) {
  if (!harnessRow) return mergePolicies([]);
  const chain = await harnessChain(harnessRow);
  return mergePolicies(chain.map((r) => r.model_policy));
}

// The policy a harness INHERITS — the effective policy of its PARENT chain (root → … → parent),
// before THIS row's own knobs merge in. Empty (no restriction) for a root harness or one whose
// parent is missing/disabled. The editor shows this as the "inherit" baseline; dispatch enforces
// the merged whole chain (effectiveModelPolicy).
export async function inheritedModelPolicy(harnessRow) {
  if (!harnessRow || !harnessRow.parent_id) return mergePolicies([]);
  const parent = await one(`SELECT * FROM harness WHERE id=$1 AND enabled`, [harnessRow.parent_id]);
  return effectiveModelPolicy(parent);
}

// ── the registry read ─────────────────────────────────────────────────────────
export async function modelSpecs({ provider = null, enabledOnly = true } = {}) {
  const rows = await q(
    `SELECT provider, key, label, note, context_window, max_output, parameters, is_default, enabled, created_at
       FROM ai_model_spec
      WHERE ($1::text IS NULL OR provider = $1)
        AND ($2::boolean OR enabled)
      ORDER BY provider, is_default DESC, label, key`,
    [provider || null, enabledOnly]);
  return rows;
}

export async function modelSpecFor(provider, key) {
  if (!provider || !key) return null;
  return one(`SELECT * FROM ai_model_spec WHERE provider=$1 AND key=$2`, [provider, key]);
}

// UPDATE one spec row — an operator records what a model IS (label, note, context window,
// parameter count) so the harness policy editor and the dispatch bounds check see real numbers.
// `key` is immutable (it is the model id the policy references); the rest is editable.
export async function updateModelSpec(provider, key, patch = {}) {
  const row = await modelSpecFor(provider, key);
  if (!row) throw new Error(`no ai_model_spec for provider "${provider}" model "${key}"`);
  const num = (v, d = null) => (v == null || v === '' ? d : Number(v));
  const label = 'label' in patch ? String(patch.label || '').trim() || row.label : row.label;
  const note = 'note' in patch ? String(patch.note ?? '') : row.note;
  const context_window = 'context_window' in patch ? num(patch.context_window) : row.context_window;
  const max_output = 'max_output' in patch ? num(patch.max_output) : row.max_output;
  const parameters = 'parameters' in patch ? num(patch.parameters) : row.parameters;
  const enabled = 'enabled' in patch ? !!patch.enabled : row.enabled;
  // is_default: one per provider. Setting a new default clears the old one; setting false on the
  // current default leaves the provider with no default (the code fallback still applies).
  let is_default = 'is_default' in patch ? !!patch.is_default : row.is_default;
  if (is_default && !row.is_default) {
    await q(`UPDATE ai_model_spec SET is_default=false WHERE provider=$1`, [provider]);
  }
  if ('is_default' in patch && !patch.is_default && row.is_default) is_default = false;
  await q(
    `UPDATE ai_model_spec
        SET label=$3, note=$4, context_window=$5, max_output=$6, parameters=$7, is_default=$8, enabled=$9
      WHERE provider=$1 AND key=$2`,
    [provider, key, label, note, context_window, max_output, parameters, is_default, enabled]);
  return modelSpecFor(provider, key);
}

// ── does a spec fit a policy's bounds? ────────────────────────────────────────
export function specInBounds(spec, p) {
  if (!spec) return true;                    // unknown spec → nothing to measure
  const ctx = spec.context_window;
  if (ctx != null) {
    if (p.min_context != null && Number(ctx) < Number(p.min_context)) return false;
    if (p.max_context != null && Number(ctx) > Number(p.max_context)) return false;
  }
  const params = spec.parameters;
  if (params != null) {
    if (p.min_params != null && Number(params) < Number(p.min_params)) return false;
    if (p.max_params != null && Number(params) > Number(p.max_params)) return false;
  }
  return true;
}

// The SPEC ROWS a policy allows for a provider (provider allowed, model allowed, in bounds),
// each carrying its priority, sorted by (priority DESC, is_default DESC, label).
export async function allowedModelsForProvider(policy, provider) {
  const p = normalizePolicy(policy);
  if ((p.allow_providers || []).length && !p.allow_providers.includes(provider)) return [];
  const specs = await modelSpecs({ provider, enabledOnly: true });
  const out = [];
  for (const s of specs) {
    if ((p.allow_models || []).length && !p.allow_models.includes(s.key)) continue;
    if (!specInBounds(s, p)) continue;
    out.push({ ...s, priority: (p.priorities || {})[s.key] ?? 1 });
  }
  out.sort((a, b) => (b.priority - a.priority)
    || ((b.is_default ? 1 : 0) - (a.is_default ? 1 : 0))
    || String(a.label).localeCompare(String(b.label)));
  return out;
}

// ── the dispatch resolution — the ONE decision every spawn path funnels through ──
//
// Given the harness a xell wears, the provider the dispatch will use, and what model (if any)
// the caller asked for, decide the model the zee actually runs:
//
//   • explicit model (non-empty) → validated: provider must be allowed, model must be allowed,
//     and the model's spec must fit the context/parameter bounds. Refused loudly otherwise —
//     a policy that silently ignored an operator's restriction is the same class of bug as
//     briefing a zee with the wrong manual.
//   • '' (vendor default) or no model → resolved from the policy: default_model if set and
//     allowed, else the highest-priority allowed model, else the caller's fallback.
//
// Returns { model, policy }. Throws a sentence that names the harness and the restriction.
export async function resolveDispatchModel({ harnessRow = null, provider = 'claude', requestedModel = null, fallbackModel = null }) {
  const policy = await effectiveModelPolicy(harnessRow);
  const p = policy;

  // PROVIDER restriction, up front — a harness that allows only deepseek must refuse a claude
  // dispatch before anything else has a chance to mislead.
  if (p.allow_providers.length && !p.allow_providers.includes(provider)) {
    throw new Error(
      `harness "${harnessRow?.key || '(none)'}" allows only ${p.allow_providers.join(', ')} — `
      + `a zee cannot run on provider "${provider}". Pick an allowed provider (or change the harness policy).`);
  }

  const explicit = requestedModel != null && requestedModel !== '';
  let model;

  if (explicit) {
    model = String(requestedModel).trim();
  } else {
    // No explicit model. Does the policy express a MODEL-level preference? A preference is a
    // default_model, a model allow-list, deployment priorities, or context/parameter bounds —
    // any of these means "pick a specific model that fits", not "let the vendor pick".
    const modelPreference = p.default_model || p.allow_models.length
      || Object.keys(p.priorities).length
      || p.min_context != null || p.max_context != null
      || p.min_params != null || p.max_params != null;
    if (!modelPreference) {
      // NO policy preference — preserve pre-existing behaviour exactly: the caller's fallback
      // (the code DEFAULT_ZEE_MODEL), which a non-claude adapter drops so the vendor runs its
      // own env-driven default. A provider-only restriction was already validated above.
      model = fallbackModel ?? '';
    } else if (p.default_model) {
      model = p.default_model;
    } else {
      const allowed = await allowedModelsForProvider(p, provider);
      const named = allowed.filter((a) => a.key !== '');
      model = (named.length ? named : allowed)[0]?.key ?? fallbackModel ?? '';
    }
  }

  // A resolved '' (vendor default) when the policy expresses a MODEL preference → resolve to a
  // real named model from the allowed set instead (a restriction and a "vendor picks" cannot
  // both be true — the vendor might pick something the policy forbids).
  if (model === '' && (p.allow_models.length || p.default_model || Object.keys(p.priorities).length
      || p.min_context != null || p.max_context != null || p.min_params != null || p.max_params != null)) {
    const allowed = await allowedModelsForProvider(p, provider);
    const named = allowed.filter((a) => a.key !== '');
    if (named.length) model = named[0].key;
  }

  // MODEL restriction + bounds on the FINAL model. The explicit case lands here with the caller's
  // own model; the resolved case lands here too, so a fallback that violates the policy is caught
  // rather than silently run.
  if (model !== '') {
    if (p.allow_models.length && !p.allow_models.includes(model)) {
      throw new Error(
        `harness "${harnessRow?.key || '(none)'}" does not allow model "${model}" on provider `
        + `"${provider}" — allowed models: ${p.allow_models.join(', ')}. Pick one of those, or change the harness policy.`);
    }
    // AN EXPLICIT MODEL MUST BE ONE THE PROVIDER ACTUALLY OFFERS (TKT-97-BD32).
    // The allow-list above is provider-agnostic — a harness inheriting zee-base's allow_models
    // may list `fable`, and on a DEEPSEEK dispatch that name exists nowhere: modelSpecFor returns
    // null, the bounds check below is skipped ("unknown spec → nothing to measure"), and the
    // vendor adapter then silently DROPS the claude alias and runs its own default
    // (effectiveModelFor in spawnCxell). The human asked for fable and got deepseek-chat with no
    // refusal and no note. So an explicit model must have a spec row for THIS provider — a real
    // name the provider can run, refused loudly by name otherwise. This is EXPLICIT-only on
    // purpose: a bare dispatch may still resolve to the harness default_model / fallback even when
    // that name has no spec on the provider (the vendor adapter converts it), and changing that
    // would change the DEFAULT model selection — deliberately out of scope.
    if (explicit && await modelSpecFor(provider, model) == null) {
      const offered = (await modelSpecs({ provider, enabledOnly: true }))
        .map((s) => s.key).filter((k) => k !== '');
      throw new Error(
        `model "${model}" is not offered by provider "${provider}" — harness `
        + `"${harnessRow?.key || '(none)'}" allows it, but there is no ${provider}/${model} model spec. `
        + (offered.length
          ? `Pick one of the models ${provider} actually offers: ${offered.join(', ')}.`
          : `No models are registered for provider "${provider}".`)
        + ' Change the model, or the harness policy.');
    }
    const spec = await modelSpecFor(provider, model);
    if (spec && !specInBounds(spec, p)) {
      const bounds = [];
      if (p.min_context != null || p.max_context != null) {
        bounds.push(`context ${p.min_context ?? '…'}-${p.max_context ?? '…'}`);
      }
      if (p.min_params != null || p.max_params != null) {
        bounds.push(`params(B) ${p.min_params ?? '…'}-${p.max_params ?? '…'}`);
      }
      throw new Error(
        `harness "${harnessRow?.key || '(none)'}" forbids model "${model}" on provider "${provider}" — `
        + `its spec (${spec.context_window ? `ctx ${spec.context_window}` : 'ctx ?'}, `
        + `${spec.parameters ? `${spec.parameters}B` : 'params ?'}) does not fit the policy bounds (${bounds.join(', ')}). `
        + `Change the model, or the policy.`);
    }
  }

  return { model, policy: p };
}
