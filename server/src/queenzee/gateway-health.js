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
import { gatewayBaseUrl, chooseGatewayBaseUrl } from '../lib/gateway.js';
import { config } from '../config.js';
import { logline } from '../lib/logbus.js';

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
//
// REACH = ANY HTTP ANSWER, matching the address-mint probe's landed definition (gateway.js
// probeGatewayBase, 7287cd3): a 404 on /api/hello is PROOF the port resolves and a server answers,
// which is exactly what a provider CLI needs to reach the gateway — so it is NOT the outage shape.
// The outage shape is the connection-failure family (refused / ENOTFOUND / timeout / no server at
// all), and that is what the console calls "unreachable". The service-body check is a BONUS detail
// recorded on the snapshot (so a non-gateway answer is discoverable), never a reason to flip to
// 'down' — a wrong server is a different problem, not a dead address.
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
  const t0 = Date.now();
  try {
    // THE MINT'S OWN DECISION — the address cages are ACTUALLY given. chooseGatewayBaseUrl probes
    // primary (host.docker.internal:<port>) THEN fallback (zeehive_server:<port>) and returns the
    // FIRST that answers /api/hello — the exact base-url gatewayEnv() mints into every cage. Any
    // HTTP answer (a 404 included) is reachable, matching the landed probe (7287cd3). This is the
    // only way the health surface can never contradict the address cages are given: today primary
    // REFUSES while fallback answers 404, so a probe that only checks the primary would cry
    // "unreachable at host.docker.internal" while every cage was minted with the fallback that works.
    const chosen = await chooseGatewayBaseUrl();
    cache.state = 'ok';
    cache.address = chosen;
    cache.error = null;
    cache.code = null;
  } catch (e) {
    // chooseGatewayBaseUrl throws ONLY when NEITHER address answers — its refusal sentence names
    // both ("LLM gateway unreachable: neither <a> nor <b> answers /api/hello …"), which is exactly
    // what a human needs to read. cache.address stays the primary (set above) so the chip names one
    // address even when down; the full sentence is in error.
    cache.state = 'down';
    cache.error = String(e?.message || 'gateway unreachable').slice(0, 200);
    cache.code = null;
  }
  cache.at = new Date().toISOString();
  // Say it when it CHANGES, not every 30s — the same change-only discipline as the docker health
  // line, so a healthy gateway is not noise in a shared terminal.
  const line = `gateway health: ${cache.state} at ${cache.address || address}${cache.error ? ` (${cache.error})` : ''} (${Date.now() - t0}ms)`;
  if (line !== lastLine) { lastLine = line; logline('gateway', line); }
  return gatewayHealth();
}
