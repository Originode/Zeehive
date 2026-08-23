// GATEWAY REACHABILITY — does the LLM gateway answer at the address cages are actually given?
//
// The 2026-08-22 outage: the gateway address minted into cages moved to host.docker.internal:4701,
// a port no compose file published, and for ~13h every dispatch died while the queenzee's OWN view
// of the gateway (it binds inside the queenzee process) looked perfectly healthy. The console had
// no surface for "the port cages are pointed at is closed". This module is that surface.
//
// It probes gatewayBaseUrl() — the ADDRESS CAGES ARE GIVEN, deliberately NOT 127.0.0.1:4701, which
// answers even when the published port is closed — on the EXISTING health-monitor cadence
// (queenzee/containers.js checkContainers, the "docker health: N up · N down" tick), caches the
// result in memory, and serves it to the fleet read model (lib/fleet.js getFleet → gateway_health)
// with NO network at read time. Never a new poller, never a request on the fleet read, never able
// to fail an AI call or a page render: the probe is best-effort, bounded, and a failure just
// records 'down' — it cannot throw out of the container tick.
import { gatewayBaseUrl } from '../lib/gateway.js';
import { config } from '../config.js';
import { logline } from '../lib/logbus.js';

// Bounded so a hung host can delay the container tick by at most this long, never forever.
const PROBE_TIMEOUT_MS = 3000;

// The in-memory cache. `state` is 'ok' | 'down' | 'unknown'; 'unknown' is the honest default until
// the monitor has ticked at least once. `address` is the address probed (the cage-facing one).
const cache = { state: 'unknown', address: null, at: null, error: null, code: null };
// The last health line we logged — so a healthy gateway is said ONCE, not every 30s.
let lastLine = '';

// The cached snapshot — what getFleet reads. No network, never throws.
export function gatewayHealth() {
  return {
    ...cache,
    address: cache.address || gatewayBaseUrl() || null,
  };
}

// Probe the gateway once at the cage-facing address and cache the verdict. Best-effort and NEVER
// throws — it hangs off the container health tick, and a probe failure must not fail that tick.
// The gateway answers `GET <base>/api/hello` with { ok: true, service: 'zeehive-llm-gateway' }
// (lib/gateway.js gatewayHello) — the same probe the CLIs themselves send before their first POST.
export async function probeGatewayHealth() {
  // When the gateway shares the API port there IS no separate door (lib/gateway.js gatewayEnv
  // returns {} and index.js never mounts the gateway listener) — nothing to probe, so stay honest:
  // 'unknown', never a false alarm about a port that was never meant to answer as a gateway.
  if (config.gatewayPort === config.port) {
    cache.state = 'unknown'; cache.address = null; cache.at = new Date().toISOString();
    cache.error = 'no separate LLM gateway (GATEWAY_PORT === PORT)'; cache.code = null;
    return gatewayHealth();
  }
  const address = gatewayBaseUrl();
  if (!address) {
    cache.state = 'unknown'; cache.address = null; cache.at = new Date().toISOString();
    cache.error = 'no gateway address configured'; cache.code = null;
    return gatewayHealth();
  }
  cache.address = address;
  const url = `${address}/api/hello`;
  const t0 = Date.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    const body = await res.json().catch(() => null);
    const ok = res.ok && body?.service === 'zeehive-llm-gateway';
    cache.state = ok ? 'ok' : 'down';
    cache.error = ok ? null : `HTTP ${res.status}`;
    cache.code = ok ? null : null;
  } catch (e) {
    // node's fetch wraps the connect error in `cause` ("fetch failed" ← cause.message
    // "connect ECONNREFUSED 127.0.0.1:4701") — unwrap it so the console says WHY, not just "failed".
    const cause = e?.cause?.message || e?.cause || '';
    const detail = String(cause && cause !== e?.message ? `${e?.message}: ${cause}` : (e?.message || 'connection failed')).slice(0, 120);
    cache.state = 'down';
    cache.error = detail;
    cache.code = /ECONNREFUSED/i.test(detail) ? 'ECONNREFUSED'
      : /ENOTFOUND/i.test(detail) ? 'ENOTFOUND'
      : /ETIMEDOUT/i.test(detail) ? 'ETIMEDOUT'
      : /EAI_AGAIN/i.test(detail) ? 'EAI_AGAIN' : null;
  }
  cache.at = new Date().toISOString();
  // Say it when it CHANGES, not every 30s — the same change-only discipline as the docker health
  // line, so a healthy gateway is not noise in a shared terminal.
  const line = `gateway health: ${cache.state} at ${address}${cache.error ? ` (${cache.error})` : ''} (${Date.now() - t0}ms)`;
  if (line !== lastLine) { lastLine = line; logline('gateway', line); }
  return gatewayHealth();
}
