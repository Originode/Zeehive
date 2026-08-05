// ROUTER POLICY — the operator-tunable knobs behind the ROUTER zee (migration 139).
//
// The router is the project's front door: it accepts a human's RAW prompt, recomposes it into a
// brief a zee can execute, and decides the dispatch (provider, model, autonomy mode, harness).
// HOW it decides is not hard-coded — it is this policy, a jsonb on the router harness row
// (`harness.router_policy`), edited in the console's harness manager and attached VERBATIM to
// every routing request the console hands the router. Turning a knob changes the next request;
// nothing needs a re-brief or a redeploy.
//
// The knobs (all sparse — an absent field means "no preference", exactly like model_policy):
//
//   provider_weights   {provider: n>=0}  relative share of dispatches per provider. The router
//                                        spreads its dispatches so each provider's share of its
//                                        recent dispatches trends toward its weight. 0 = never
//                                        pick it (unless it is the fallback_provider).
//   provider_schedule  {provider: {days:[0-6], hours:[start,end]}}
//                                        when a provider may be picked at all (UTC). A provider
//                                        with no entry is always available; one outside its
//                                        window is not pickable right now.
//   max_concurrent     int               max worker zees the router keeps active at once;
//                                        further routing requests are held, visibly, until a
//                                        slot frees.
//   default_mode       1..5              the autonomy scale a routed dispatch gets unless the
//                                        prompt itself demands eyes on it.
//   rewrite            'concise' | 'structured' | 'verbatim'
//                                        how aggressively the raw prompt is recomposed.
//   max_task_chars     int               target ceiling for the recomposed brief.
//   fallback_provider  key               where a request lands when weights/schedule exclude
//                                        everything else.
//
// Same defensive posture as lib/model-policy.js: the column is operator-editable jsonb, so every
// read degrades a wrong shape to "not set" rather than throwing on the routing path.
import { one } from '../db/pool.js';

export const REWRITE_STYLES = ['concise', 'structured', 'verbatim'];

export function normalizeRouterPolicy(p) {
  const pol = (typeof p === 'string' ? JSON.parse(p) : (p || {})) || {};
  const num = (v) => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
  const out = {};

  if ('provider_weights' in pol && pol.provider_weights && typeof pol.provider_weights === 'object'
      && !Array.isArray(pol.provider_weights)) {
    const w = Object.fromEntries(Object.entries(pol.provider_weights)
      .map(([k, v]) => [String(k).trim(), num(v)])
      .filter(([k, v]) => k && v != null && v >= 0));
    if (Object.keys(w).length) out.provider_weights = w;
  }

  if ('provider_schedule' in pol && pol.provider_schedule && typeof pol.provider_schedule === 'object'
      && !Array.isArray(pol.provider_schedule)) {
    const sched = {};
    for (const [prov, winRaw] of Object.entries(pol.provider_schedule)) {
      const key = String(prov).trim();
      const win = winRaw && typeof winRaw === 'object' && !Array.isArray(winRaw) ? winRaw : {};
      const days = Array.isArray(win.days)
        ? [...new Set(win.days.map((d) => Math.floor(Number(d))).filter((d) => Number.isFinite(d) && d >= 0 && d <= 6))]
        : null;
      const hours = Array.isArray(win.hours) && win.hours.length === 2
        ? win.hours.map((h) => num(h)) : null;
      const hoursOk = hours && hours.every((h) => h != null && h >= 0 && h <= 24);
      const entry = {};
      if (days && days.length) entry.days = days.sort((a, b) => a - b);
      if (hoursOk) entry.hours = [hours[0], hours[1]];
      if (key && Object.keys(entry).length) sched[key] = entry;
    }
    if (Object.keys(sched).length) out.provider_schedule = sched;
  }

  if ('max_concurrent' in pol) {
    const n = num(pol.max_concurrent);
    out.max_concurrent = n != null && n >= 0 ? Math.floor(n) : null;
  }
  if ('default_mode' in pol) {
    const n = num(pol.default_mode);
    out.default_mode = n != null && n >= 1 && n <= 5 ? Math.floor(n) : null;
  }
  if ('rewrite' in pol) {
    const s = String(pol.rewrite || '').trim().toLowerCase();
    out.rewrite = REWRITE_STYLES.includes(s) ? s : null;
  }
  if ('max_task_chars' in pol) {
    const n = num(pol.max_task_chars);
    out.max_task_chars = n != null && n > 0 ? Math.floor(n) : null;
  }
  if ('fallback_provider' in pol) {
    out.fallback_provider = pol.fallback_provider ? String(pol.fallback_provider).trim() : null;
  }
  return out;
}

// Merge a CHAIN of raw router policies (root → leaf). Scalars are leaf-wins; the two maps merge
// per-key with the leaf winning per provider — the same shape model_policy gives `priorities`.
// (No intersection semantics here: routing knobs are PREFERENCES, not restrictions — the walls a
// router lives behind are structural, not in this file.)
export function mergeRouterPolicies(chain) {
  const merged = {
    provider_weights: {},
    provider_schedule: {},
    max_concurrent: null,
    default_mode: null,
    rewrite: null,
    max_task_chars: null,
    fallback_provider: null,
  };
  for (const raw of chain || []) {
    const p = normalizeRouterPolicy(raw);
    for (const [k, v] of Object.entries(p.provider_weights || {})) merged.provider_weights[k] = v;
    for (const [k, v] of Object.entries(p.provider_schedule || {})) merged.provider_schedule[k] = v;
    for (const k of ['max_concurrent', 'default_mode', 'rewrite', 'max_task_chars', 'fallback_provider']) {
      if (p[k] != null) merged[k] = p[k];
    }
  }
  return merged;
}

// The EFFECTIVE router policy a harness carries — every router_policy in its parent chain,
// merged. Mirrors effectiveModelPolicy so the two kinds of knobs always agree on the ancestry.
export async function effectiveRouterPolicy(harnessRow) {
  if (!harnessRow) return mergeRouterPolicies([]);
  const { harnessChain } = await import('./model-policy.js');
  const chain = await harnessChain(harnessRow);
  return mergeRouterPolicies(chain.map((r) => r.router_policy));
}

// Is `provider` inside its schedule window right now? No entry = always. Exported for the read
// model (routerStatus annotates which providers the schedule currently excludes) — the router
// itself applies the policy from the snapshot in its routing request.
export function providerInSchedule(policy, provider, at = new Date()) {
  const win = (policy?.provider_schedule || {})[provider];
  if (!win) return true;
  const day = at.getUTCDay();
  const hour = at.getUTCHours() + at.getUTCMinutes() / 60;
  if (Array.isArray(win.days) && win.days.length && !win.days.includes(day)) return false;
  if (Array.isArray(win.hours) && win.hours.length === 2) {
    const [start, end] = win.hours;
    // A window may wrap midnight (e.g. [22, 6]); [n, n] is degenerate and treated as always.
    if (start !== end) {
      const inside = start < end ? (hour >= start && hour < end) : (hour >= start || hour < end);
      if (!inside) return false;
    }
  }
  return true;
}
