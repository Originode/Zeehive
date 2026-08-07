// AI PROVIDER ART — the CIRCLE a zee is recognised by.
//
// A zee is two things at once: WHOSE MODEL is thinking (the AI provider) and WHAT JOB it was
// dressed for (the harness). Until now only the second one had a picture: every hexagon, every
// manager disc and every badge drew the harness avatar, so a Claude builder and a Codex builder
// were the same drawing — and the one fact a human wants at a glance across a room ("which vendor
// is burning here?") was a word in a tooltip.
//
// So the two swapped places, deliberately:
//   • THE PROVIDER IS THE BADGE — a brand coin (its logo on its own disc). It is the identity.
//   • THE HARNESS IS WORN — a COSTUME framed around that coin, cut to the job: a scout gets wings,
//     a builder a hammer, a manager a necktie, a reviewer glasses (./harnessGear.js). A claude
//     builder and an openai builder wear the same hammer; only the coin underneath differs.
// That is the whole rule, and it is drawn twice — once on the canvas (hive/HiveCanvas.jsx
// drawZeeAvatar) and once in the DOM (ZeeAvatar.jsx) — from THIS one registry, so the honeycomb
// and the cards can never disagree about what a provider looks like.
//
// The logo files are static assets under web/public/providers/, i.e. plain URLs on the console's
// own origin (vite serves public/ in dev, nginx serves the built copy in prod). Deliberately NOT
// bundler imports: this module is imported by node tests as-is, and a `import logo from '*.png'`
// would make it unloadable outside vite. And deliberately NOT the meta-DB (where harness avatars
// live, migration 082): a provider is a fixed registry in CODE (server lib/provider-tokens.js
// PROVIDERS + lib/cxell-runtimes.js adapters), not a row a human authors.

// Every provider ZEEHIVE can dress a zee in, plus the ones whose logo is ready before the runtime
// is. `coin` is the disc the logo sits on — chosen per brand so the mark reads (a white knot needs
// a dark coin; a dark monogram needs a light one), `color` is the ring/accent it lends.
export const PROVIDER_ART = {
  claude:   { key: 'claude',   label: 'Claude',        logo: '/providers/claude.png',   color: '#d97757', coin: '#1b1512' },
  openai:   { key: 'openai',   label: 'ChatGPT Codex', logo: '/providers/openai.png',   color: '#c9d2df', coin: '#12151b' },
  kimi:     { key: 'kimi',     label: 'Kimi Code',     logo: '/providers/kimi.png',     color: '#2f7cf6', coin: '#06070a' },
  deepseek: { key: 'deepseek', label: 'DeepSeek',      logo: '/providers/deepseek.png', color: '#4d6bfe', coin: '#0c1120' },
  grok:     { key: 'grok',     label: 'Grok Build',    logo: '/providers/grok.png',     color: '#d6dae0', coin: '#0a0a0a' },
  gemini:   { key: 'gemini',   label: 'Gemini',        logo: '/providers/gemini.png',   color: '#4285f4', coin: '#0f1420' },
  zai:      { key: 'zai',      label: 'Z.ai',          logo: '/providers/zai.png',      color: '#8f96a3', coin: '#eef1f5' },
};

// The words the rest of the fleet uses for the same vendor, all pointing at one coin. Three
// vocabularies meet here and none of them is going to be changed to suit a picture:
//   • provider keys      — 'claude' | 'openai' | 'kimi' | 'deepseek' | 'grok' (lib/provider-tokens.js)
//   • agent_runtime.vendor — 'anthropic' | 'openai' | 'moonshot' | 'deepseek' | 'xai' (migrations 034/037/141)
//   • agent_runtime.key    — 'claude-code-cxell' | 'codex-cxell' | 'kimi-code-cxell' | …
const ALIASES = {
  anthropic: 'claude', claudecode: 'claude',
  codex: 'openai', gpt: 'openai', chatgpt: 'openai',
  moonshot: 'kimi',
  xai: 'grok', 'x-ai': 'grok', 'x.ai': 'grok', grokbuild: 'grok',
  google: 'gemini', googleai: 'gemini',
  zhipu: 'zai', glm: 'zai', 'z-ai': 'zai', 'z.ai': 'zai',
};

const norm = (s) => String(s || '').trim().toLowerCase();
const fromWord = (w) => {
  const k = norm(w);
  if (!k) return null;
  if (PROVIDER_ART[k]) return k;
  return ALIASES[k] || null;
};

// Which provider is this? Accepts a bare key/vendor/runtime word, or any object carrying one:
// a fleet xell row (runtime_key / runtime_vendor), a provider-token row (provider), a dispatch
// button ({ provider }). Returns null when nothing in it names a vendor — the caller then falls
// back to the harness disc, which is exactly what was drawn before this existed.
export function providerKeyOf(src) {
  if (!src) return null;
  if (typeof src === 'string') {
    return fromWord(src) || src.split(/[^a-z0-9.]+/i).map(fromWord).find(Boolean) || null;
  }
  const direct = fromWord(src.provider) || fromWord(src.provider_key) || fromWord(src.runtime_vendor)
    || fromWord(src.vendor);
  if (direct) return direct;
  // 'claude-code-cxell' → claude, 'codex-cxell' → openai, 'kimi-code-cxell' → kimi
  const rk = norm(src.runtime_key || src.runtime || src.key);
  if (rk) return rk.split(/[^a-z0-9.]+/).map(fromWord).find(Boolean) || null;
  return null;
}

export const providerArtOf = (src) => PROVIDER_ART[providerKeyOf(src)] || null;

// ── THE GEAR: what a harness looks like when it is WORN ──────────────────────
// It lives in ./harnessGear.js — a harness's costume grew from "a glyph in a pip" into real
// artwork per role (wings, hammer, necktie, glasses …) and that is a module's worth of shapes,
// not a paragraph. Re-exported here so a surface that needs BOTH halves of a zee's badge still has
// one import, and the two registries stay named side by side.
export { harnessGear, GEAR_ART, GEAR_KEYS, GEAR_EXTENT, gearKeyFor, GEAR_FALLBACK_COLOR,
         gearPathD, drawGearLayer, toneColor,
         ACCESSORY_ART, ACCESSORY_KEYS, ACCESSORY_CATEGORIES, MAX_ACCESSORIES,
         accessoriesFor, accessoriesByCategory, resolveAccessory,
         normalizeAccessories, normalizeCustomAccessories } from './harnessGear.js';

// One sentence for a tooltip, in the badge's own grammar: WHO is thinking · WHAT it is dressed as.
// When the harness wears several accessories the list is named; otherwise the persona label.
export function avatarTitle(provider, gear) {
  const p = provider ? provider.label : 'no provider';
  if (!gear) return p;
  const accs = gear.accessories || [];
  const worn = accs.length > 1
    ? accs.map((a) => a.label).join(' + ')
    : (accs[0]?.label && accs[0].key !== gear.gear ? accs[0].label : gear.label);
  return `${p} · wearing ${worn}${gear.empty ? ' (empty)' : ''}`;
}
