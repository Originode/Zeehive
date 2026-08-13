// MODEL-AWARE USAGE LIMITS (console half).
// Mirrors server/src/lib/usage-limits.js — keep the two in step. Pure, no network.
// available_pct is REMAINING (green). used = 100 − available (red on the HP bar).

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

export function windowsForModel(provider, model) {
  const p = String(provider || '').toLowerCase();
  if (p === 'claude' || p === 'anthropic') {
    const tier = claudeTierOf(model);
    if (tier === 'opus') return ['7d_opus', '5h', '7d'];
    if (tier === 'sonnet') return ['7d_sonnet', '5h', '7d'];
    return ['5h', '7d', '7d_sonnet', '7d_opus'];
  }
  return [];
}

export function availableForModel(usageLimit, { provider = null, model = null } = {}) {
  if (!usageLimit || typeof usageLimit !== 'object') {
    return { available_pct: null, window: null, source: null };
  }
  const wins = usageLimit.windows || {};
  // Model named → try its tier windows. No model → provider-wide available_pct only.
  if (model) {
    for (const w of windowsForModel(provider, model)) {
      const row = wins[w];
      if (row && row.available_pct != null && Number.isFinite(Number(row.available_pct))) {
        return { available_pct: Number(row.available_pct), window: w, source: 'model' };
      }
    }
  }
  if (usageLimit.available_pct != null && Number.isFinite(Number(usageLimit.available_pct))) {
    return {
      available_pct: Number(usageLimit.available_pct),
      window: usageLimit.representative || null,
      source: 'provider',
    };
  }
  for (const w of ['5h', '7d', '7d_sonnet', '7d_opus']) {
    if (wins[w]?.available_pct != null) {
      return { available_pct: Number(wins[w].available_pct), window: w, source: 'provider' };
    }
  }
  if (usageLimit.tokens?.available_pct != null) {
    return { available_pct: Number(usageLimit.tokens.available_pct), window: 'tokens', source: 'provider' };
  }
  return { available_pct: null, window: null, source: null };
}

// Format for the model picker chip: "93% free" or "93% free · 5h". Empty string when unknown.
export function formatLimitChip(lim) {
  if (!lim || lim.available_pct == null) return '';
  const pct = Number(lim.available_pct);
  const win = lim.window && lim.source === 'model' ? ` · ${lim.window}` : '';
  return `${pct}% free${win}`;
}
