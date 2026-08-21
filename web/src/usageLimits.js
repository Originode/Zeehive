// PROVIDER-WIDE + MODEL-WIDE USAGE LIMITS (console half).
// Mirrors server/src/lib/usage-limits.js — keep the two in step. Pure, no network.
// available_pct is REMAINING (green).

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

export function modelKeyOf(model) {
  const tier = claudeTierOf(model);
  if (tier) return tier;
  const m = String(model || '').trim().toLowerCase();
  return m || null;
}

function pctOf(v) {
  if (v == null || !Number.isFinite(Number(v))) return null;
  return Number(v);
}

export function providerWide(usageLimit) {
  if (!usageLimit || typeof usageLimit !== 'object') {
    return { available_pct: null, window: null, source: null };
  }
  const p = pctOf(usageLimit.available_pct);
  if (p != null) {
    return { available_pct: p, window: usageLimit.representative || null, source: 'provider' };
  }
  const wins = usageLimit.windows || {};
  for (const w of ['5h', '7d']) {
    if (pctOf(wins[w]?.available_pct) != null) {
      return { available_pct: Number(wins[w].available_pct), window: w, source: 'provider' };
    }
  }
  if (pctOf(usageLimit.tokens?.available_pct) != null) {
    return { available_pct: Number(usageLimit.tokens.available_pct), window: 'tokens', source: 'provider' };
  }
  return { available_pct: null, window: null, source: null };
}

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
  const raw = String(model || '').trim().toLowerCase();
  if (raw && raw !== key && by[raw] && pctOf(by[raw].available_pct) != null) {
    return {
      available_pct: Number(by[raw].available_pct),
      window: by[raw].window || raw,
      source: 'model',
    };
  }
  const p = String(provider || '').toLowerCase();
  const wins = usageLimit.windows || {};
  if (p === 'claude' || p === 'anthropic') {
    const tier = claudeTierOf(model);
    const w = tier === 'opus' ? '7d_opus' : tier === 'sonnet' ? '7d_sonnet' : null;
    if (w && pctOf(wins[w]?.available_pct) != null) {
      return { available_pct: Number(wins[w].available_pct), window: w, source: 'model' };
    }
  }
  return { available_pct: null, window: null, source: null };
}

export function availableForXell(usageLimit, opts = {}) {
  const m = modelWide(usageLimit, opts);
  if (m.available_pct != null) return m;
  return providerWide(usageLimit);
}

// Back-compat
export function availableForModel(usageLimit, opts = {}) {
  if (opts.model) return availableForXell(usageLimit, opts);
  return providerWide(usageLimit);
}

// "93% free" or "93% free · 7d_opus". Empty when unknown.
export function formatLimitChip(lim) {
  if (!lim || lim.available_pct == null) return '';
  const pct = Number(lim.available_pct);
  const win = lim.window && lim.source === 'model' ? ` · ${lim.window}` : '';
  return `${pct}% free${win}`;
}
