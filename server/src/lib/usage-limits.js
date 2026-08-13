// MODEL-AWARE PROVIDER USAGE LIMITS.
//
// A provider account's usage_limit snapshot (provider_token.usage_limit, migration 203) carries
// several windows at once — Claude Code seat headers report 5h + 7d + 7d_sonnet + 7d_opus
// utilization side by side. The binding window depends on WHICH MODEL is about to run:
//   opus   → weekly opus pool (7d_opus), else 5h, else general 7d, else provider-wide
//   sonnet → weekly sonnet pool (7d_sonnet), else 5h, else 7d, else provider-wide
//   fable / haiku / unknown → 5h, then 7d, then provider-wide available_pct
//
// Pure module — no db. Used by dispatch-options (model picker labels), fleet (badge HP bar),
// and tests. available_pct is REMAINING (green half of the bar), not used.

// Map a free-form model id (policy key or wire id) onto a Claude-family tier.
// 'opus' | 'sonnet' | 'haiku' | 'fable' | null
export function claudeTierOf(model) {
  const m = String(model || '').toLowerCase();
  if (!m) return null;
  if (/\bopus\b/.test(m) || m.includes('claude-opus')) return 'opus';
  if (/\bsonnet\b/.test(m) || m.includes('claude-sonnet')) return 'sonnet';
  if (/\bhaiku\b/.test(m) || m.includes('claude-haiku')) return 'haiku';
  if (/\bfable\b/.test(m) || m.includes('claude-fable')) return 'fable';
  // short policy keys
  if (m === 'opus' || m === 'sonnet' || m === 'haiku' || m === 'fable') return m;
  return null;
}

// Ordered window keys to try for (provider, model). First hit with a non-null available_pct wins.
export function windowsForModel(provider, model) {
  const p = String(provider || '').toLowerCase();
  if (p === 'claude' || p === 'anthropic') {
    const tier = claudeTierOf(model);
    if (tier === 'opus') return ['7d_opus', '5h', '7d'];
    if (tier === 'sonnet') return ['7d_sonnet', '5h', '7d'];
    // fable / haiku / unknown: session window first, then weekly general
    return ['5h', '7d', '7d_sonnet', '7d_opus'];
  }
  // Other vendors: no model-tiered seat windows in the headers we capture today.
  return [];
}

// Resolve available_pct for a model against one account's usage_limit snapshot.
// Returns { available_pct, window, source: 'model'|'provider'|null, status, windows }.
// Falls back to the snapshot's provider-wide available_pct when no model window applies.
export function availableForModel(usageLimit, { provider = null, model = null } = {}) {
  if (!usageLimit || typeof usageLimit !== 'object') {
    return { available_pct: null, window: null, source: null, status: null, windows: null };
  }
  const wins = usageLimit.windows || {};
  // Only walk model-tiered windows when a model was actually named. A bare provider lookup must
  // return the snapshot's own available_pct (the binding representative), not "first window that
  // happens to be present" — that would make provider-wide lie about a single tier.
  if (model) {
    for (const w of windowsForModel(provider, model)) {
      const row = wins[w];
      if (row && row.available_pct != null && Number.isFinite(Number(row.available_pct))) {
        return {
          available_pct: Number(row.available_pct),
          window: w,
          source: 'model',
          status: row.status || usageLimit.status || null,
          windows: wins,
        };
      }
    }
  }
  // Provider-wide fallback: snapshot's primary available_pct (binding representative window /
  // TPM / RPM), then any known window, then tokens/requests buckets.
  if (usageLimit.available_pct != null && Number.isFinite(Number(usageLimit.available_pct))) {
    return {
      available_pct: Number(usageLimit.available_pct),
      window: usageLimit.representative || null,
      source: 'provider',
      status: usageLimit.status || null,
      windows: wins,
    };
  }
  for (const w of ['5h', '7d', '7d_sonnet', '7d_opus']) {
    if (wins[w]?.available_pct != null) {
      return {
        available_pct: Number(wins[w].available_pct),
        window: w,
        source: 'provider',
        status: wins[w].status || null,
        windows: wins,
      };
    }
  }
  const tok = usageLimit.tokens?.available_pct;
  if (tok != null) {
    return { available_pct: Number(tok), window: 'tokens', source: 'provider',
             status: null, windows: wins };
  }
  return { available_pct: null, window: null, source: null, status: null, windows: wins };
}

// Used% for the HP bar (red half). Null when unknown.
export function usedPctFromAvailable(availablePct) {
  if (availablePct == null || !Number.isFinite(Number(availablePct))) return null;
  return Math.round((100 - Number(availablePct)) * 10) / 10;
}

// Runtime key/vendor → provider key (claude|openai|kimi|deepseek|grok). Same vocabulary as
// providerArt aliases, kept server-side so the fleet snapshot does not restate vendor names.
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
