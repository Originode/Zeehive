// GATEWAY ADDRESS PROOF (TKT-179) — the queenzee must never hand a cage a gateway address it
// cannot reach itself. gatewayEnv() now PROBES /api/hello before minting, chooses
// host.docker.internal:<gatewayPort> primary → the compose-network fallback (from CXELL_API_FALLBACK),
// and REFUSES loudly — naming both addresses — when neither answers. A provider CLI base-url is a
// single string, so the cage cannot try a second name; the queenzee decides.
//
// The two candidates share GATEWAY_PORT and differ only in HOST (primary host.docker.internal vs
// the compose name), so this test uses 127.0.0.1 and 127.0.0.2 — two loopback hosts on the SAME
// port — to stand in for "primary vs fallback". Pure + real HTTP mocks; no database, no docker.
// The probe cache is module-level, so the test calls _resetGatewayProbeCache() between scenarios.
//
// RUN: node test/gateway-address.test.mjs
import http from 'node:http';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };
const eq = (a, b, m) => ok(a === b, `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

const close = (server) => new Promise((res) => server.close(res));
const servers = [];

// A mock gateway on a given HOST (defaults to a random free port): answers /api/hello
// {ok:true} like the real gateway's index.js mount (unless helloStatus says otherwise), and counts
// how many times the probe hit it (to prove the cache skips round-trips). Primary/fallback share
// GATEWAY_PORT and differ only by host, so the fallback mock is created with the SAME port as the
// primary but on 127.0.0.2.
function mockGateway(host, port = 0, helloStatus = 200) {
  const hits = { count: 0 };
  const server = http.createServer((req, res) => {
    if (req.url === '/api/hello') {
      hits.count++;
      res.writeHead(helloStatus, { 'content-type': 'application/json' });
      res.end(JSON.stringify(helloStatus === 200
        ? { ok: true, service: 'zeehive-llm-gateway' }
        : { error: 'not the gateway' }));
    } else {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":"not the gateway"}');
    }
  });
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(port, host, () => resolve({ server, hits, port: server.address().port }));
  });
}

try {
  // The primary mock on 127.0.0.1. GATEWAY_PORT is its port; CXELL_API_BASE names its host.
  const prim = await mockGateway('127.0.0.1');
  const P = prim.port;
  process.env.CXELL_API_BASE = `http://127.0.0.1:${P}`;
  process.env.CXELL_API_FALLBACK = `http://127.0.0.1:4700`;   // SAME host as the base → the no-second-name trap
  process.env.GATEWAY_PORT = String(P);
  const { gatewayBaseUrl, gatewayFallbackBaseUrl, chooseGatewayBaseUrl, gatewayEnv,
          gatewayEnvForBase, probeGatewayBase, _resetGatewayProbeCache } = await import('../server/src/lib/gateway.js');

  console.log('\n── 1. primary and fallback are derived, and the equal-default trap is real ──');
  eq(gatewayBaseUrl(), `http://127.0.0.1:${P}`, 'primary = CXELL_API_BASE host + GATEWAY_PORT');
  eq(gatewayFallbackBaseUrl(), `http://127.0.0.1:${P}`, 'fallback = CXELL_API_FALLBACK host + GATEWAY_PORT');
  ok(gatewayBaseUrl() === gatewayFallbackBaseUrl(),
     'an install with CXELL_API_FALLBACK unset resolves equal — there is NO second name (the trap)');

  console.log('\n── 2. a reachable primary is chosen, and the verdict is CACHED (no round-trip per spawn) ──');
  eq(await chooseGatewayBaseUrl(), `http://127.0.0.1:${P}`, 'choose returns the primary when it answers /api/hello');
  eq(await probeGatewayBase(`http://127.0.0.1:${P}`), true, 'the probe says the primary is reachable');
  eq(prim.hits.count, 1, 'one probe hit — the second probe served the cached verdict, not a round-trip');

  console.log('\n── 3. gatewayEnv mints the provider base-urls for the CHOSEN base ──');
  const env = await gatewayEnv({ xellToken: 'tok123', provider: 'deepseek' });
  eq(env.ANTHROPIC_BASE_URL, `http://127.0.0.1:${P}/x/tok123/deepseek`, 'deepseek env uses the chosen base + /deepseek');
  eq(env.OPENAI_BASE_URL, `http://127.0.0.1:${P}/x/tok123/openai/v1`, 'openai env uses the chosen base + /openai/v1');
  // The pure shape helper is identical for a given base (the async wrapper only CHOOSES the base).
  const pure = gatewayEnvForBase(`http://127.0.0.1:${P}`, { xellToken: 'tok123', provider: 'deepseek' });
  eq(JSON.stringify(pure), JSON.stringify(env), 'gatewayEnvForBase(base) is the same shape as gatewayEnv for that base');

  console.log('\n── 4. OFF SWITCH — GATEWAY_PORT === PORT returns {} without probing ──');
  const { config } = await import('../server/src/config.js');
  const savedPort = config.port;
  const savedGatewayPort = config.gatewayPort;
  config.port = config.gatewayPort;   // mutate the live config (exported object) — the off switch
  const off = await gatewayEnv({ xellToken: 'tok' });
  ok(off && typeof off === 'object' && Object.keys(off).length === 0, 'gatewayEnv returns {} when GATEWAY_PORT === PORT');
  eq(prim.hits.count, 1, 'and the probe never ran (the off switch short-circuits before choosing)');
  config.port = savedPort;
  config.gatewayPort = savedGatewayPort;

  console.log('\n── 5. primary dead, fallback alive → the FALLBACK is minted ──');
  // Same GATEWAY_PORT as the primary, but on a DIFFERENT loopback host (127.0.0.2) — exactly how
  // the real fallback differs from host.docker.internal: both share GATEWAY_PORT, only the host
  // changes (the compose service name). It can sit on the same port number because 127.0.0.2 is a
  // distinct address from 127.0.0.1.
  const fb = await mockGateway('127.0.0.2', P);
  process.env.CXELL_API_FALLBACK = `http://127.0.0.2:4700`;   // a DIFFERENT host, same GATEWAY_PORT
  _resetGatewayProbeCache();
  await close(prim.server);           // the primary host goes dead on the gateway port
  const chosen = await chooseGatewayBaseUrl();
  eq(chosen, `http://127.0.0.2:${P}`, 'the fallback is chosen when the primary is unreachable');
  eq(fb.hits.count, 1, 'the fallback was actually probed');
  const fbEnv = await gatewayEnv({ xellToken: 'tok' });
  eq(fbEnv.ANTHROPIC_BASE_URL, `http://127.0.0.2:${P}/x/tok/claude`, 'a dispatch still gets a working base-url (the fallback)');

  console.log('\n── 6. both dead → a LOUD, NAMED refusal that quotes both addresses ──');
  _resetGatewayProbeCache();
  await close(fb.server);
  let refused = null;
  try { await chooseGatewayBaseUrl(); } catch (e) { refused = e; }
  ok(!!refused, 'chooseGatewayBaseUrl throws when neither candidate answers');
  ok(/LLM gateway unreachable/.test(refused.message), 'the refusal NAMES the gateway');
  ok(refused.message.includes(`http://127.0.0.1:${P}`) && refused.message.includes(`http://127.0.0.2:${P}`),
     'the refusal QUOTES both addresses tried');
  // And gatewayEnv (the minting path) surfaces the same named refusal — never a silent dead env.
  let envRefused = null;
  try { await gatewayEnv({ xellToken: 'tok' }); } catch (e) { envRefused = e; }
  ok(!!envRefused && /LLM gateway unreachable/.test(envRefused.message), 'gatewayEnv refuses loudly too');

  console.log('\n── 7. ANY HTTP answer is reachable — a 404 on /api/hello is still proof the port serves ──');
  // Measured 2026-08-23: from a cage, host.docker.internal:4701 refused (connection refused) while
  // zeehive_server:4701 answered HTTP 404 — 404 IS reachable. What the probe must reject is the
  // dead-address family (refused / ENOTFOUND / timeout), never an HTTP answer of any status.
  _resetGatewayProbeCache();
  const four = await mockGateway('127.0.0.1', 0, 404);   // a server that answers 404, like the compose-name probe
  const Q = four.port;
  process.env.CXELL_API_BASE = `http://127.0.0.1:${Q}`;
  process.env.CXELL_API_FALLBACK = `http://127.0.0.1:4700`;
  process.env.GATEWAY_PORT = String(Q);
  eq(await probeGatewayBase(`http://127.0.0.1:${Q}`), true, 'a 404 answer is REACHABLE (not a dead address)');
  eq(await chooseGatewayBaseUrl(), `http://127.0.0.1:${Q}`, 'choose mints the 404-answering address');
  const fourEnv = await gatewayEnv({ xellToken: 'tok' });
  eq(fourEnv.ANTHROPIC_BASE_URL, `http://127.0.0.1:${Q}/x/tok/claude`, 'a 404-answering base is minted for the cage');
  await close(four.server);

  console.log(`\n${fail ? fail + ' FAILED' : 'all good'}`);
} finally {
  for (const s of servers) { try { s.close(); } catch { /* already closed */ } }
}

process.exit(fail ? 1 : 0);
