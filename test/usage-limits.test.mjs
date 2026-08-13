// PROVIDER-WIDE + MODEL-WIDE usage limits (server + web mirrors).
import {
  providerWide, modelWide, availableForXell, mergeUsageLimit, modelKeyOf, claudeTierOf,
  providerFromRuntime,
} from '../server/src/lib/usage-limits.js';
import {
  providerWide as webPW, modelWide as webMW, availableForXell as webXell, formatLimitChip,
} from '../web/src/usageLimits.js';
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (r) => readFileSync(join(ROOT, r), 'utf8');

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };
const eq = (a, b, m) => ok(a === b, `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

const snap = {
  available_pct: 50,
  representative: '5h',
  windows: {
    '5h': { available_pct: 40 },
    '7d': { available_pct: 70 },
    '7d_sonnet': { available_pct: 15 },
    '7d_opus': { available_pct: 90 },
  },
  by_model: {},
};

console.log('\n── keys ──');
eq(modelKeyOf('claude-opus-4-6'), 'opus', 'wire → opus');
eq(modelKeyOf('fable'), 'fable', 'fable key');
eq(modelKeyOf('gpt-5.6-sol'), 'gpt-5.6-sol', 'openai key kept');

console.log('\n── provider-wide ──');
eq(providerWide(snap).available_pct, 50, 'providerWide uses top-level available_pct');
eq(providerWide(snap).source, 'provider', 'providerWide source');
eq(providerWide(null).available_pct, null, 'null snap');

console.log('\n── model-wide (no provider fallback) ──');
eq(modelWide(snap, { provider: 'claude', model: 'opus' }).available_pct, 90, 'opus → 7d_opus');
eq(modelWide(snap, { provider: 'claude', model: 'opus' }).source, 'model', 'opus source model');
eq(modelWide(snap, { provider: 'claude', model: 'sonnet' }).available_pct, 15, 'sonnet → 7d_sonnet');
eq(modelWide(snap, { provider: 'claude', model: 'fable' }).available_pct, null,
   'fable has no model-wide pool → null (not 5h)');
eq(modelWide(snap, { provider: 'claude', model: null }).available_pct, null, 'no model → null');

console.log('\n── xell: model then provider fallback ──');
eq(availableForXell(snap, { provider: 'claude', model: 'opus' }).available_pct, 90, 'xell opus = model');
eq(availableForXell(snap, { provider: 'claude', model: 'fable' }).available_pct, 50,
   'xell fable falls back to provider-wide 50');
eq(availableForXell(snap, { provider: 'claude', model: null }).available_pct, 50,
   'xell no model = provider-wide');

console.log('\n── by_model for non-claude (OpenAI-style) ──');
const openaiSnap = mergeUsageLimit(null, {
  available_pct: 80,
  tokens: { available_pct: 80, remaining: 8000, limit: 10000 },
}, { model: 'gpt-5.6-sol', provider: 'openai' });
eq(openaiSnap.by_model['gpt-5.6-sol']?.available_pct, 80, 'openai call stores by_model');
eq(modelWide(openaiSnap, { provider: 'openai', model: 'gpt-5.6-sol' }).available_pct, 80,
   'openai model-wide from by_model');
eq(modelWide(openaiSnap, { provider: 'openai', model: 'gpt-4o' }).available_pct, null,
   'other openai model still unknown');
// Second model does not wipe the first
const openai2 = mergeUsageLimit(openaiSnap, {
  available_pct: 30,
  tokens: { available_pct: 30 },
}, { model: 'gpt-4o', provider: 'openai' });
eq(openai2.by_model['gpt-5.6-sol']?.available_pct, 80, 'merge keeps earlier model');
eq(openai2.by_model['gpt-4o']?.available_pct, 30, 'merge adds second model');
eq(openai2.available_pct, 30, 'provider-wide updates to latest call');

console.log('\n── claude merge lifts 7d_opus / 7d_sonnet into by_model ──');
const c1 = mergeUsageLimit(null, {
  available_pct: 40,
  windows: { '5h': { available_pct: 40 }, '7d_opus': { available_pct: 88 }, '7d_sonnet': { available_pct: 12 } },
}, { model: 'sonnet', provider: 'claude' });
eq(c1.by_model.opus?.available_pct, 88, 'claude merge stores opus pool');
eq(c1.by_model.sonnet?.available_pct, 12, 'claude merge stores sonnet pool');

console.log('\n── web mirror ──');
eq(webPW(snap).available_pct, 50, 'web providerWide');
eq(webMW(snap, { provider: 'claude', model: 'opus' }).available_pct, 90, 'web modelWide opus');
eq(webXell(snap, { provider: 'claude', model: 'fable' }).available_pct, 50, 'web xell fable fallback');
eq(formatLimitChip({ available_pct: 90, window: '7d_opus', source: 'model' }), '90% free · 7d_opus',
   'format model chip');
eq(formatLimitChip({ available_pct: 50, source: '5h', source: 'provider' }), '50% free',
   'format provider chip has no window tag');

console.log('\n── wiring ──');
ok(/provider-limit-|providerLimitLabel/.test(read('web/src/Dispatch.jsx')),
   'prompt window shows limit on provider buttons');
ok(/modelLimitLabel|model-limit-/.test(read('web/src/Dispatch.jsx')),
   'prompt window shows limit on model buttons');
ok(/modelWide|providerWide/.test(read('server/src/lib/dispatch-options.js')),
   'dispatch-options uses modelWide + providerWide');
ok(/mergeUsageLimit/.test(read('server/src/lib/gateway.js')),
   'gateway merges usage_limit with by_model');
ok(/availableForXell/.test(read('server/src/lib/fleet.js')),
   'fleet badge uses availableForXell (model then provider)');
ok(!/data-testid="provider-limits"/.test(read('web/src/App.jsx')),
   'no statusline limits chip');

console.log(fail ? `\n${fail} FAIL` : '\nall good');
process.exit(fail ? 1 : 0);
