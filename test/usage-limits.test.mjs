// MODEL-AWARE USAGE LIMITS — pure resolution of available_pct for a model against an
// account's usage_limit snapshot (server/src/lib/usage-limits.js + web/src/usageLimits.js).
//
// Claude Code seat headers carry 5h + 7d + 7d_sonnet + 7d_opus windows at once. opus prefers
// 7d_opus, sonnet prefers 7d_sonnet, fable/haiku fall back through 5h then 7d, and anything
// without a matching window falls back to the snapshot's provider-wide available_pct.
import { availableForModel, windowsForModel, claudeTierOf, providerFromRuntime }
  from '../server/src/lib/usage-limits.js';
import { availableForModel as webAvailable, formatLimitChip }
  from '../web/src/usageLimits.js';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };
const eq = (a, b, m) => ok(a === b, `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

const snap = {
  available_pct: 50,           // provider-wide (binding representative)
  representative: '5h',
  status: 'allowed',
  windows: {
    '5h': { available_pct: 40, status: 'allowed', utilization: 0.6 },
    '7d': { available_pct: 70, status: 'allowed', utilization: 0.3 },
    '7d_sonnet': { available_pct: 15, status: 'allowed', utilization: 0.85 },
    '7d_opus': { available_pct: 90, status: 'allowed', utilization: 0.1 },
  },
};

console.log('\n── tiers ──');
eq(claudeTierOf('opus'), 'opus', 'opus');
eq(claudeTierOf('claude-opus-4-6'), 'opus', 'wire opus');
eq(claudeTierOf('fable'), 'fable', 'fable');
eq(claudeTierOf('sonnet'), 'sonnet', 'sonnet');

console.log('\n── window order ──');
eq(windowsForModel('claude', 'opus')[0], '7d_opus', 'opus tries 7d_opus first');
eq(windowsForModel('claude', 'sonnet')[0], '7d_sonnet', 'sonnet tries 7d_sonnet first');
eq(windowsForModel('claude', 'fable')[0], '5h', 'fable tries 5h first');
eq(windowsForModel('openai', 'gpt-5').length, 0, 'openai has no model-tier seat windows');

console.log('\n── availableForModel ──');
eq(availableForModel(snap, { provider: 'claude', model: 'opus' }).available_pct, 90,
   'opus → 7d_opus 90% free');
eq(availableForModel(snap, { provider: 'claude', model: 'opus' }).source, 'model',
   'opus source is model');
eq(availableForModel(snap, { provider: 'claude', model: 'opus' }).window, '7d_opus',
   'opus window name');
eq(availableForModel(snap, { provider: 'claude', model: 'sonnet' }).available_pct, 15,
   'sonnet → 7d_sonnet 15% free');
eq(availableForModel(snap, { provider: 'claude', model: 'fable' }).available_pct, 40,
   'fable → 5h 40% free');
eq(availableForModel(snap, { provider: 'claude', model: null }).available_pct, 50,
   'no model → provider-wide available_pct 50');
eq(availableForModel(snap, { provider: 'claude', model: null }).source, 'provider',
   'no model source is provider');
// When a model window is ABSENT, fall back to provider-wide.
const noOpus = { ...snap, windows: { '5h': snap.windows['5h'], '7d': snap.windows['7d'] } };
eq(availableForModel(noOpus, { provider: 'claude', model: 'opus' }).available_pct, 40,
   'opus with no 7d_opus → falls through to 5h');
eq(availableForModel(null, { provider: 'claude', model: 'opus' }).available_pct, null,
   'null snapshot → null');

console.log('\n── web mirror agrees ──');
eq(webAvailable(snap, { provider: 'claude', model: 'opus' }).available_pct, 90,
   'web availableForModel matches server for opus');
eq(webAvailable(snap, { provider: 'claude', model: 'fable' }).available_pct, 40,
   'web availableForModel matches server for fable');
eq(formatLimitChip({ available_pct: 93, window: '5h', source: 'model' }), '93% free · 5h',
   'formatLimitChip shows window when model-sourced');
eq(formatLimitChip({ available_pct: 50, source: '5h', source: 'provider' }), '50% free',
   'formatLimitChip omits window when provider fallback');
eq(formatLimitChip(null), '', 'formatLimitChip empty when unknown');

console.log('\n── runtime → provider ──');
eq(providerFromRuntime({ runtime_key: 'claude-code-cxell' }), 'claude', 'claude runtime');
eq(providerFromRuntime({ runtime_vendor: 'xai' }), 'grok', 'xai vendor');
eq(providerFromRuntime({ runtime_key: 'codex-cxell' }), 'openai', 'codex runtime');

// Wiring: statusline must NOT render provider-limits; dispatch + badge must.
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (r) => readFileSync(join(ROOT, r), 'utf8');

console.log('\n── wiring ──');
ok(!/data-testid="provider-limits"/.test(read('web/src/App.jsx')),
   'statusline does NOT render the provider-limits chip');
ok(/model-limit-|disp-limit|formatLimitChip|availableForModel/.test(read('web/src/Dispatch.jsx')),
   'prompt window shows model limit chips');
ok(/zav-hp|availablePct|usage_available_pct/.test(read('web/src/ZeeAvatar.jsx')),
   'DOM badge draws the HP bar');
ok(/availablePct|usage_available_pct/.test(read('web/src/hive/HiveCanvas.jsx')),
   'canvas badge draws the HP bar from usage_available_pct');
ok(/available_pct: lim\.available_pct|limit_window|availableForModel/.test(read('server/src/lib/dispatch-options.js')),
   'dispatch options attach per-model available_pct');

console.log(fail ? `\n${fail} FAIL` : '\nall good');
process.exit(fail ? 1 : 0);
