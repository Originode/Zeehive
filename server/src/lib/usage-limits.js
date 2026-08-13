// PROVIDER-WIDE + MODEL-WIDE USAGE LIMITS.
//
// An account's usage_limit snapshot (provider_token.usage_limit, migration 203) holds:
//   available_pct / windows / tokens  — PROVIDER-WIDE (binding window or last TPM/RPM)
//   by_model[key]                     — MODEL-WIDE when known (Claude 7d_opus/7d_sonnet, or
//                                       per-call OpenAI-style remaining for that model id)
//
// Resolution:
//   providerWide(snap)              → only the account-level remaining %
//   modelWide(snap, {provider, model}) → only a model-specific remaining % (null if unknown)
//   availableForXell(...)           → model-wide if available, else provider-wide (badge HP bar)
//
// Pure — no db. Shared by gateway merge, dispatch-options, fleet, tests.

// Map a free-form model id onto a Claude-family tier key, or null.
export function claudeTierOf(model) {
  const m = String(model || '').toLowerCase();
  if (!m) return null;
  if (/\bopus\b/.test(m) || m.includes('claude-opus')) return 'opus';
  if (/\bsonnet\b/.test(m) || m.includes('claude-sonnet')) return 'sonnet';
  if (/\bhaiku\b/.test(m) || m.includes('claude-haiku')) return 'haiku';
  if (/\bfable\b/.test(m) || m.includes('claude-fable')) return 'fable';
  if (m === 'opus' || m === 'sonnet' || m === 'haiku' || m === 'fable') return m;
  return null;
}

// Canonical key for by_model storage / lookup. Claude tiers collapse wire ids → opus|sonnet|…
// Other vendors keep a lowercased free-form key.
export function modelKeyOf(model) {
  const tier = claudeTierOf(model);
  if (tier) return tier;
  const m = String(model || '').trim().toLowerCase();
  return m || null;
}

// MODEL-SPECIFIC window keys only (not shared 5h/7d). Claude seat headers alone give these.
export function modelWindowsFor(provider, model) {
  const p = String(provider || '').toLowerCase();
  if (p !== 'claude' && p !== 'anthropic') return [];
  const tier = claudeTierOf(model);
  if (tier === 'opus') return ['7d_opus'];
  if (tier === 'sonnet') return ['7d_sonnet'];
  // fable / haiku: Anthropic does not publish a dedicated weekly pool in the headers we capture
  return [];
}

function pctOf(v) {
  if (v == null || !Number.isFinite(Number(v))) return null;
  return Number(v);
}

// PROVIDER-WIDE remaining % — never walks model tiers.
export function providerWide(usageLimit) {
  if (!usageLimit || typeof usageLimit !== 'object') {
    return { available_pct: null, window: null, source: null };
  }
  const p = pctOf(usageLimit.available_pct);
  if (p != null) {
    return {
      available_pct: p,
      window: usageLimit.representative || null,
      source: 'provider',
    };
  }
  // Shared seat windows / TPM as provider-wide when top-level missing
  const wins = usageLimit.windows || {};
  for (const w of ['5h', '7d']) {
    if (pctOf(wins[w]?.available_pct) != null) {
      return { available_pct: Number(wins[w].available_pct), window: w, source: 'provider' };
    }
  }
  if (pctOf(usageLimit.tokens?.available_pct) != null) {
    return { available_pct: Number(usageLimit.tokens.available_pct), window: 'tokens', source: 'provider' };
  }
  if (pctOf(usageLimit.requests?.available_pct) != null) {
    return { available_pct: Number(usageLimit.requests.available_pct), window: 'requests', source: 'provider' };
  }
  return { available_pct: null, window: null, source: null };
}

// MODEL-WIDE remaining % only — null when we have no model-specific signal.
// Order: by_model[key] → Claude 7d_opus / 7d_sonnet windows. Does NOT fall back to provider-wide.
export function modelWide(usageLimit, { provider = null, model = null } = {}) {
  if (!usageLimit || typeof usageLimit !== 'object' || !model) {
    return { available_pct: null, window: null, source: null };
  }
  const key = modelKeyOf(model);
  const by = usageLimit.by_model || {};
  if (key && by[key] && pctOf(by[key].available_pct) != null) {
    return {
      available_pct: Number(by[key].available_pct),
      window: by[key].window || key,
      source: 'model',
    };
  }
  // Also try raw model string as key (wire id stored as-is)
  const raw = String(model || '').trim().toLowerCase();
  if (raw && raw !== key && by[raw] && pctOf(by[raw].available_pct) != null) {
    return {
      available_pct: Number(by[raw].available_pct),
      window: by[raw].window || raw,
      source: 'model',
    };
  }
  const wins = usageLimit.windows || {};
  for (const w of modelWindowsFor(provider, model)) {
    if (pctOf(wins[w]?.available_pct) != null) {
      return {
        available_pct: Number(wins[w].available_pct),
        window: w,
        source: 'model',
      };
    }
  }
  return { available_pct: null, window: null, source: null };
}

// Xell badge / "best display" number: model-wide if available, else provider-wide.
export function availableForXell(usageLimit, { provider = null, model = null } = {}) {
  const m = modelWide(usageLimit, { provider, model });
  if (m.available_pct != null) return m;
  const p = providerWide(usageLimit);
  return p;
}

// Back-compat alias used by dispatch-options / older callers.
// With a model: prefer model-wide, else provider-wide (same as availableForXell).
// Without a model: provider-wide only.
export function availableForModel(usageLimit, opts = {}) {
  if (opts.model) return availableForXell(usageLimit, opts);
  return providerWide(usageLimit);
}

// Merge a freshly captured rateLimit into the account's previous usage_limit so:
//   • provider-wide fields update to the latest call
//   • by_model entries accumulate (OpenAI last-call-per-model, Claude tier windows)
//   • earlier model keys are NOT wiped when another model runs
export function mergeUsageLimit(prev, rateLimit, { model = null, provider = null } = {}) {
  if (!rateLimit || typeof rateLimit !== 'object') return prev || null;
  const base = (prev && typeof prev === 'object') ? prev : {};
  const next = {
    ...base,
    ...rateLimit,
    windows: { ...(base.windows || {}), ...(rateLimit.windows || {}) },
    by_model: { ...(base.by_model || {}) },
  };
  // Claude: lift dedicated weekly pools into by_model so every model button can read them
  // even when the binding representative was a different window.
  const wins = next.windows || {};
  if (wins['7d_opus']?.available_pct != null) {
    next.by_model.opus = {
      available_pct: Number(wins['7d_opus'].available_pct),
      window: '7d_opus',
      status: wins['7d_opus'].status || null,
      at: new Date().toISOString(),
    };
  }
  if (wins['7d_sonnet']?.available_pct != null) {
    next.by_model.sonnet = {
      available_pct: Number(wins['7d_sonnet'].available_pct),
      window: '7d_sonnet',
      status: wins['7d_sonnet'].status || null,
      at: new Date().toISOString(),
    };
  }
  // Non-Claude (or any call): store THIS call's available_pct under the model key. OpenAI returns
  // TPM remaining for the model that just ran — that IS the model-wide number.
  const key = modelKeyOf(model);
  const p = String(provider || '').toLowerCase();
  const isClaude = p === 'claude' || p === 'anthropic';
  if (key && rateLimit.available_pct != null && !isClaude) {
    next.by_model[key] = {
      available_pct: Number(rateLimit.available_pct),
      window: rateLimit.tokens ? 'tokens' : (rateLimit.representative || 'tokens'),
      at: new Date().toISOString(),
    };
  }
  // Claude fable/haiku: no dedicated weekly — do not invent a by_model entry from 5h.
  return next;
}

export function usedPctFromAvailable(availablePct) {
  if (availablePct == null || !Number.isFinite(Number(availablePct))) return null;
  return Math.round((100 - Number(availablePct)) * 10) / 10;
}

export function providerFromRuntime({ runtime_key = null, runtime_vendor = null } = {}) {
  const v = String(runtime_vendor || '').toLowerCase();
  if (v === 'anthropic') return 'claude';
  if (v === 'openai') return 'openai';
  if (v === 'moonshot') return 'kimi';
  if (v === 'deepseek') return 'deepseek';
  if (v === 'xai' || v === 'x-ai') return 'grok';
  const k = String(runtime_key || '').toLowerCase();
  if (k.includes('deepseek')) return 'deepseek';
  if (k.includes('codex') || k.includes('openai')) return 'openai';
  if (k.includes('kimi')) return 'kimi';
  if (k.includes('grok')) return 'grok';
  if (k.includes('claude')) return 'claude';
  return null;
}
