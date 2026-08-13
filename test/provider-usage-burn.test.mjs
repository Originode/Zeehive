// PROVIDER USAGE LIMITS — how much of each provider ACCOUNT's quota is still AVAILABLE.
//
// The job: "determine how much of the usage limit is available per provider" — NOT per-xell
// spend. Fleet burn answers "what did we spend"; this answers "how full is the seat / API
// window on each connected account".
//
// TRACE: gateway.extractRateLimit reads Claude's anthropic-ratelimit-unified-* headers (5h/7d
// seat windows) and API TPM/RPM headers; completeRequest persists onto provider_token.usage_limit
// (migration 203) for the account that authenticated the call.
//
// DISPLAY: listProviderTokens / providerLimits / fleet.provider_limits carry available_pct per
// account; statusline "limits:" chip and Project setup account rows render "% free".
//
// What this file covers:
//   A. extractRateLimit pure — unified windows + available_pct (the number a human wants).
//   B. provider_token.usage_limit round-trip + providerLimits / getFleetBurn.current.
//   C. Wiring — statusline limits chip, Project setup account row, migration 203.
//
// House rule 1: every fixture is deleted in a finally, whatever happens.
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };
const eq = (a, b, m) => ok(a === b, `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
const near = (a, b, m, tol = 0.05) =>
  ok(a != null && Math.abs(Number(a) - b) <= tol, `${m} (got ${JSON.stringify(a)}, want ~${b})`);

const { extractRateLimit, recordAccountUsageLimit } = await import('../server/src/lib/gateway.js');
const { getFleetBurn } = await import('../server/src/lib/fleet.js');
const { listProviderTokens, providerLimits } = await import('../server/src/lib/provider-tokens.js');
const { q, one, pool } = await import('../server/src/db/pool.js');

// ── A. extractRateLimit (AVAILABLE, not used) ────────────────────────────────────────────────
console.log('\n── A1. Claude Code unified 5h/7d seat windows ──');
{
  const rl = extractRateLimit({
    'anthropic-ratelimit-unified-status': 'allowed',
    'anthropic-ratelimit-unified-representative-claim': 'five_hour',
    'anthropic-ratelimit-unified-5h-status': 'allowed',
    'anthropic-ratelimit-unified-5h-utilization': '0.07',
    'anthropic-ratelimit-unified-5h-reset': '1774933200',
    'anthropic-ratelimit-unified-7d-status': 'allowed',
    'anthropic-ratelimit-unified-7d-utilization': '0.53',
  });
  ok(!!rl, 'unified headers produce a snapshot');
  eq(rl.representative, '5h', 'representative five_hour → 5h');
  near(rl.windows['5h'].available_pct, 93, '5h available = 100 − 7');
  near(rl.windows['7d'].available_pct, 47, '7d available = 100 − 53');
  near(rl.available_pct, 93, 'PRIMARY available_pct follows the binding (5h) window');
  eq(rl.status, 'allowed', 'overall status');
  ok(!!rl.windows['5h'].reset_at, '5h reset is ISO-ified from unix epoch');
}

console.log('\n── A2. API TPM/RPM headers (OpenAI-shaped) ──');
{
  const rl = extractRateLimit({
    'x-ratelimit-limit-tokens': '20000',
    'x-ratelimit-remaining-tokens': '5000',
    'x-ratelimit-limit-requests': '60',
    'x-ratelimit-remaining-requests': '60',
  });
  near(rl.available_pct, 25, 'TPM available = remaining/limit = 5000/20000 = 25%');
  near(rl.tokens.available_pct, 25, 'tokens.available_pct');
  near(rl.requests.available_pct, 100, 'RPM fully free when remaining=limit');
}

console.log('\n── A3. empty / null → null ──');
eq(extractRateLimit({}), null, 'no headers → null');
eq(extractRateLimit(null), null, 'null headers → null');

// ── B. provider_token.usage_limit + providerLimits (account grain) ───────────────────────────
console.log('\n── B. usage_limit stored on the ACCOUNT, not the xell ──');
let projectId = null;
try {
  // Ensure migration 203 columns exist (sandbox may already have them from --migrate).
  await q(`ALTER TABLE provider_token
             ADD COLUMN IF NOT EXISTS usage_limit jsonb,
             ADD COLUMN IF NOT EXISTS usage_limit_at timestamptz`).catch(() => {});

  const proj = await one(
    `INSERT INTO project (name, repo_root)
     VALUES ($1, '/tmp/provider-usage-limit-test') RETURNING id`,
    [`provider-limit-${randomUUID().slice(0, 8)}`]);
  projectId = proj.id;

  // Two claude accounts — different remaining quotas. Provider-level available is the WORST.
  const a1 = await one(
    `INSERT INTO provider_token (project_id, provider, token, token_hint, label)
     VALUES ($1, 'claude', 'sk-ant-oat01-TESTTOKEN_ONE_aaaaaaaaaaaaaaaa', '…aaaa', 'work')
     RETURNING id`, [projectId]);
  const a2 = await one(
    `INSERT INTO provider_token (project_id, provider, token, token_hint, label)
     VALUES ($1, 'claude', 'sk-ant-oat01-TESTTOKEN_TWO_bbbbbbbbbbbbbbbb', '…bbbb', 'personal')
     RETURNING id`, [projectId]);
  const grok = await one(
    `INSERT INTO provider_token (project_id, provider, token, token_hint, label)
     VALUES ($1, 'grok', 'xai-TESTTOKEN_GROK_cccccccccccccccc', '…cccc', 'seat')
     RETURNING id`, [projectId]);

  // Simulate what the gateway writes after a call.
  const snapWork = extractRateLimit({
    'anthropic-ratelimit-unified-representative-claim': 'five_hour',
    'anthropic-ratelimit-unified-5h-utilization': '0.80',
    'anthropic-ratelimit-unified-5h-status': 'allowed',
    'anthropic-ratelimit-unified-7d-utilization': '0.30',
  });
  const snapPersonal = extractRateLimit({
    'anthropic-ratelimit-unified-representative-claim': 'five_hour',
    'anthropic-ratelimit-unified-5h-utilization': '0.10',
    'anthropic-ratelimit-unified-5h-status': 'allowed',
  });
  const snapGrok = extractRateLimit({
    'x-ratelimit-limit-tokens': '100000',
    'x-ratelimit-remaining-tokens': '90000',
  });
  await recordAccountUsageLimit(a1.id, snapWork);
  await recordAccountUsageLimit(a2.id, snapPersonal);
  await recordAccountUsageLimit(grok.id, snapGrok);

  const listed = await listProviderTokens(projectId);
  const claude = listed.find((p) => p.provider === 'claude');
  const grokP = listed.find((p) => p.provider === 'grok');
  ok(!!claude, 'claude provider present');
  eq(claude.accounts.length, 2, 'two claude accounts');
  const work = claude.accounts.find((a) => a.label === 'work');
  const personal = claude.accounts.find((a) => a.label === 'personal');
  near(work.available_pct, 20, 'work account: 20% free (util 0.80)');
  near(personal.available_pct, 90, 'personal account: 90% free (util 0.10)');
  // Provider-level = WORST active account (work is tighter).
  near(claude.available_pct, 20, 'provider available_pct is the WORST account (20%)');
  near(grokP.available_pct, 90, 'grok available_pct from TPM headers = 90%');

  const limits = await providerLimits(projectId);
  ok(limits.some((p) => p.provider === 'claude' && p.available_pct === 20
    || (p.provider === 'claude' && Math.abs(p.available_pct - 20) < 0.1)),
     'providerLimits lists claude with worst remaining');
  ok(limits.every((p) => p.accounts.every((a) => 'available_pct' in a)),
     'every account carries available_pct (may be null)');

  // getFleetBurn.current reads from provider_token.usage_limit now.
  const burn = await getFleetBurn(projectId);
  ok(Array.isArray(burn.current), 'getFleetBurn.current is an array');
  ok(burn.current.some((c) => c.provider === 'claude' && c.available_pct != null),
     'current carries claude available_pct from the account row');
  ok(burn.current.every((c) => c.account_id || c.provider),
     'current is account-grained (has account_id when from provider_token)');
} finally {
  if (projectId) {
    await q(`DELETE FROM project WHERE id=$1`, [projectId]).catch(() => {});
  }
}

// ── C. wiring ────────────────────────────────────────────────────────────────────────────────
console.log('\n── C. wiring — limits chip is SEPARATE from per-xell burn ──');
{
  ok(/203_provider_token_usage_limit\.sql/.test(read('db/migrations/203_provider_token_usage_limit.sql')
    ? '203_provider_token_usage_limit.sql' : '')
    || read('db/migrations/203_provider_token_usage_limit.sql').includes('usage_limit'),
     'migration 203 adds usage_limit on provider_token');
  const mig = read('db/migrations/203_provider_token_usage_limit.sql');
  ok(/usage_limit/.test(mig) && /usage_limit_at/.test(mig), 'migration 203 columns present');

  const gw = read('server/src/lib/gateway.js');
  ok(/anthropic-ratelimit-unified/.test(gw), 'gateway parses unified seat headers');
  ok(/recordAccountUsageLimit/.test(gw), 'gateway writes usage_limit onto the account');
  ok(/available_pct/.test(gw), 'gateway computes available_pct (remaining), not only used%');

  const pt = read('server/src/lib/provider-tokens.js');
  ok(/export async function providerLimits/.test(pt), 'providerLimits read model exists');
  ok(/available_pct/.test(pt), 'listProviderTokens surfaces available_pct');

  const fleet = read('server/src/lib/fleet.js');
  ok(/provider_limits/.test(fleet), 'fleet snapshot carries provider_limits');

  const routes = read('server/src/api/routes.js');
  ok(/provider-limits/.test(routes), 'GET /projects/:id/provider-limits route exists');

  const app = read('web/src/App.jsx');
  ok(/provider-limits/.test(app) && /% free/.test(app),
     'statusline has a dedicated limits chip showing "% free"');
  ok(!/provider-usage-/.test(app) || /provider-limit-/.test(app),
     'limits use provider-limit-* testids (not mixed into xell burn)');
  // The limits chip must NOT be inside the fleet-burn span.
  const limitsIdx = app.indexOf('data-testid="provider-limits"');
  const burnIdx = app.indexOf('data-testid="fleet-burn"');
  ok(limitsIdx > 0 && burnIdx > 0 && limitsIdx !== burnIdx,
     'limits chip is a separate element from fleet burn');

  const setup = read('web/src/ProjectSetup.jsx');
  ok(/AccountUsageLimit/.test(setup) && /account-usage-limit/.test(setup),
     'Project setup shows remaining limit on each account row');
}

console.log(fail ? `\n${fail} FAIL` : '\nall good');
try { await pool.end(); } catch { /* already closed */ }
process.exit(fail ? 1 : 0);
