// PROVIDER USAGE — trace (gateway rate-limit headers) + display (fleet burn by_provider).
//
// The job: "figure out how to trace and display current usage per provider".
//
// TRACE: the gateway already records every AI call with a provider key (llm_gateway_request,
// migration 154). This change additionally captures the upstream's rate-limit response headers
// into meta.rate_limit (gateway.extractRateLimit) — the free "current usage %" surface, since
// Admin /usage APIs need separate admin keys the fleet does not hold.
//
// DISPLAY: getFleetBurn (GET /api/fleet/burn, and the fleet snapshot's fleet_burn) returns
// by_provider (tokens+$ per provider from the gateway ledger) and current (freshest rate-limit
// snapshot per provider). The console statusline renders both.
//
// What this file covers:
//   A. extractRateLimit pure (also covered in gateway.test.mjs — kept here as the job's contract).
//   B. getFleetBurn.by_provider + .current against a throwaway project (DATABASE_URL).
//   C. Wiring: the read model shape, the console statusline chips, the delivery-telemetry card.
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

const { extractRateLimit } = await import('../server/src/lib/gateway.js');
const { getFleetBurn } = await import('../server/src/lib/fleet.js');
const { q, one, pool } = await import('../server/src/db/pool.js');

// ── A. extractRateLimit (the TRACE half) ─────────────────────────────────────────────────────
console.log('\n── A. extractRateLimit — current usage % off response headers ──');
{
  const rl = extractRateLimit({
    'anthropic-ratelimit-tokens-limit': '1000',
    'anthropic-ratelimit-tokens-remaining': '250',
  });
  eq(rl?.tokens_used_pct, 75, 'used% = 1 − remaining/limit');
  eq(extractRateLimit({}), null, 'no headers → null (the chip then shows nothing for that provider)');
}

// ── B. getFleetBurn.by_provider + .current against a real project ────────────────────────────
console.log('\n── B. getFleetBurn — by_provider + current rate-limit snapshot ──');
let projectId = null;
let xellId = null;
try {
  const proj = await one(
    `INSERT INTO project (name, repo_root)
     VALUES ($1, '/tmp/provider-usage-burn-test') RETURNING id`,
    [`provider-usage-burn-${randomUUID().slice(0, 8)}`]);
  projectId = proj.id;

  // A xource is required for a xell (FK). Minimal row.
  const xource = await one(
    `INSERT INTO xource (project_id, ref) VALUES ($1, 'main') RETURNING id`, [projectId]);
  const xell = await one(
    `INSERT INTO xell (project_id, xource_id, slug, branch, status)
     VALUES ($1, $2, $3, $4, 'working') RETURNING id`,
    [projectId, xource.id, `pu-${randomUUID().slice(0, 8)}`,
     `spinoff/pu-${randomUUID().slice(0, 8)}`]);
  xellId = xell.id;

  // Two providers, known token counts. Claude has a rate-limit snapshot; grok does not.
  // total_tokens is the ledger's own sum column; set it explicitly so the GROUP BY is exact.
  await q(
    `INSERT INTO llm_gateway_request
       (xell_id, project_id, kind, provider, model, method, path,
        input_tokens, output_tokens, total_tokens, cost_usd, status, completed_at, meta)
     VALUES
       ($1, $2, 'messages', 'claude', 'opus', 'POST', '/v1/messages',
        1000, 200, 1200, 0.50, 200, now(),
        $3::jsonb),
       ($1, $2, 'messages', 'claude', 'opus', 'POST', '/v1/messages',
        500, 100, 600, 0.25, 200, now() - interval '1 minute',
        '{}'::jsonb),
       ($1, $2, 'messages', 'grok', 'grok-4.5', 'POST', '/responses',
        300, 50, 350, 0.10, 200, now(),
        '{}'::jsonb)`,
    [xellId, projectId, JSON.stringify({
      rate_limit: {
        tokens_remaining: 40000, tokens_limit: 100000, tokens_used_pct: 60,
        requests_remaining: 10, requests_limit: 50, requests_used_pct: 80,
      },
    })]);

  const burn = await getFleetBurn(projectId);
  ok(!!burn, 'getFleetBurn returns a read model');
  ok(Array.isArray(burn.by_provider), 'by_provider is an array');
  ok(Array.isArray(burn.current), 'current is an array');

  const claude = burn.by_provider.find((p) => p.provider === 'claude');
  const grok = burn.by_provider.find((p) => p.provider === 'grok');
  eq(claude?.tokens, 1800, 'claude tokens = 1200 + 600');
  eq(claude?.cost, 0.75, 'claude cost = 0.50 + 0.25');
  eq(claude?.requests, 2, 'claude requests = 2');
  eq(grok?.tokens, 350, 'grok tokens = 350');
  eq(grok?.cost, 0.10, 'grok cost = 0.10');
  eq(grok?.requests, 1, 'grok requests = 1');

  // by_provider is ordered tokens DESC — claude (1800) before grok (350).
  eq(burn.by_provider[0]?.provider, 'claude', 'by_provider ordered tokens DESC (claude first)');

  const curClaude = burn.current.find((c) => c.provider === 'claude');
  ok(!!curClaude, 'current carries a rate-limit snapshot for claude');
  eq(curClaude?.rate_limit?.tokens_used_pct, 60, 'current claude tokens_used_pct = 60');
  eq(curClaude?.rate_limit?.tokens_remaining, 40000, 'current claude tokens_remaining');
  ok(!burn.current.find((c) => c.provider === 'grok'),
     'grok has no rate-limit headers → absent from current (not a zero-filled row)');
} finally {
  if (projectId) {
    // Cascades: xource, xell, llm_gateway_request (project_id ON DELETE CASCADE).
    await q(`DELETE FROM project WHERE id=$1`, [projectId]).catch(() => {});
  }
}

// ── C. wiring ────────────────────────────────────────────────────────────────────────────────
console.log('\n── C. wiring — statusline + delivery telemetry surface the fields ──');
{
  const fleetSrc = read('server/src/lib/fleet.js');
  ok(/by_provider/.test(fleetSrc), 'getFleetBurn builds by_provider');
  ok(/rate_limit/.test(fleetSrc) && /current/.test(fleetSrc),
     'getFleetBurn builds current from meta.rate_limit');

  const gwSrc = read('server/src/lib/gateway.js');
  ok(/export function extractRateLimit/.test(gwSrc), 'gateway exports extractRateLimit');
  ok(/rate_limit:\s*rateLimit|rate_limit:\s*rl|rate_limit: rateLimit/.test(gwSrc)
     || /rate_limit:\s*rateLimit/.test(gwSrc.replace(/\s+/g, ' '))
     || /meta\.rate_limit|rate_limit: rateLimit|rate_limit: rl/.test(gwSrc),
     'gateway stores rate_limit on completeRequest meta');
  // A more direct check: the finish path merges rate_limit into metaPatch.
  ok(/extractRateLimit\(proxyRes\.headers\)/.test(gwSrc),
     'gateway reads rate-limit headers off the upstream response');

  const appSrc = read('web/src/App.jsx');
  ok(/fleet-burn-by-provider/.test(appSrc), 'statusline has the by-provider chip');
  ok(/provider-usage-/.test(appSrc), 'statusline has a data-testid per provider usage %');
  ok(/fleetBurnTitle|providerBurnTitle/.test(appSrc), 'tooltips name the per-provider figures');

  const dtSrc = read('server/src/lib/delivery-telemetry.js');
  ok(/usage_by_provider/.test(dtSrc), 'delivery telemetry returns usage_by_provider');
  const dtUi = read('web/src/DeliveryTelemetry.jsx');
  ok(/usage-by-provider/.test(dtUi) && /Usage per provider/.test(dtUi),
     'delivery telemetry panel renders the per-provider card');
}

console.log(fail ? `\n${fail} FAIL` : '\nall good');
try { await pool.end(); } catch { /* already closed */ }
process.exit(fail ? 1 : 0);
