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
          gatewayEnvForBase, probeGatewayBase, invalidateGatewayProbe, gatewayIdentified,
          _resetGatewayProbeCache } = await import('../server/src/lib/gateway.js');
  const { recentLogs } = await import('../server/src/lib/logbus.js');

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

  console.log('\n── 8. SINGLE-FLIGHT — N concurrent cold-cache dispatches fire ONE probe, not N ──');
  // A cold cache hit by a fleet of spawns at once used to fire one probe per dispatch — N HTTP
  // requests against an already-suspect port (TKT-179). The probe now single-flights: the first
  // caller starts it, the rest await the same in-flight promise. The mock DELAYS its answer so the
  // window is real (without a delay the first fetch is still in flight when the second caller
  // checks, but this makes the overlap deterministic).
  _resetGatewayProbeCache();
  const slowHits = { count: 0 };
  const slow = http.createServer((req, res) => {
    if (req.url === '/api/hello') {
      slowHits.count++;
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true,"service":"zeehive-llm-gateway"}');
      }, 100);
    } else {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":"not the gateway"}');
    }
  });
  servers.push(slow);
  const S = await new Promise((resolve) => slow.listen(0, '127.0.0.1', () => resolve(slow.address().port)));
  process.env.CXELL_API_BASE = `http://127.0.0.1:${S}`;
  process.env.CXELL_API_FALLBACK = `http://127.0.0.1:4700`;
  process.env.GATEWAY_PORT = String(S);
  const verdicts = await Promise.all([
    probeGatewayBase(`http://127.0.0.1:${S}`),
    probeGatewayBase(`http://127.0.0.1:${S}`),
    probeGatewayBase(`http://127.0.0.1:${S}`),
    probeGatewayBase(`http://127.0.0.1:${S}`),
    probeGatewayBase(`http://127.0.0.1:${S}`),
  ]);
  ok(verdicts.every((v) => v === true), 'all five concurrent callers get the SAME true verdict');
  eq(slowHits.count, 1, 'one HTTP probe hit for five concurrent callers (single-flight)');
  await close(slow);

  console.log('\n── 9. INVALIDATION — a gateway that dies after a good probe is NOT minted for the OK TTL ──');
  // The OK verdict is cached 30s, so a gateway that dies right after a good probe would keep being
  // minted for up to 30s (TKT-179, bounded). When a real dispatch/turn fails against a minted base
  // (classified gateway-unreachable), noteTurnDeath invalidates the OK verdict so the NEXT mint
  // re-probes. This proves the invalidate actually forces a fresh probe.
  _resetGatewayProbeCache();
  const inv = await mockGateway('127.0.0.1');
  const IV = inv.port;
  process.env.CXELL_API_BASE = `http://127.0.0.1:${IV}`;
  process.env.CXELL_API_FALLBACK = `http://127.0.0.1:4700`;
  process.env.GATEWAY_PORT = String(IV);
  const base = `http://127.0.0.1:${IV}`;
  eq(await probeGatewayBase(base), true, 'the first probe is reachable');
  eq(await probeGatewayBase(base), true, 'the second probe is served from the cache');
  eq(inv.hits.count, 1, 'one probe hit so far — the cache skipped the second round-trip');
  invalidateGatewayProbe(base);
  eq(await probeGatewayBase(base), true, 'after invalidation the address is probed again (and still answers)');
  eq(inv.hits.count, 2, 'invalidateGatewayProbe forced a SECOND real probe, not a stale cached verdict');
  invalidateGatewayProbe('http://never-probed:1');   // unknown address — must be a no-op, not a throw
  await close(inv.server);

  console.log('\n── 10. IDENTIFICATION — an answering server that is NOT our gateway stays minted, and says so once ──');
  // TKT-179: ANY HTTP answer = reachable, and the probe must NOT turn an answering address into a
  // refusal. ON TOP of that the gateway answers a tiny unauthenticated signature route
  // (GET /_gw/health, {service:'zeehive-llm-gateway', port}) so a mint can tell "the port serves OUR
  // gateway" from "the port serves SOME server". An unidentified-but-answering address stays
  // REACHABLE and IS minted — the probe only logs ONCE per address, naming it, saying it answered
  // but did not identify as the zeehive LLM gateway.
  _resetGatewayProbeCache();

  // (a) answers /api/hello but NOT the signature route → REACHABLE, unidentified, still minted, warning names it.
  const anon = await mockGateway('127.0.0.1');   // _gw/health falls into the 404 else branch
  const AN = anon.port;
  process.env.CXELL_API_BASE = `http://127.0.0.1:${AN}`;
  process.env.CXELL_API_FALLBACK = `http://127.0.0.1:4700`;
  process.env.GATEWAY_PORT = String(AN);
  const anonBase = `http://127.0.0.1:${AN}`;
  eq(await probeGatewayBase(anonBase), true, 'an address that answers /api/hello but not /_gw/health is still REACHABLE');
  eq(gatewayIdentified(anonBase), false, 'and it is recorded unidentified (answered, but not OUR gateway)');
  const anonEnv = await gatewayEnv({ xellToken: 'tok' });
  eq(anonEnv.ANTHROPIC_BASE_URL, `http://127.0.0.1:${AN}/x/tok/claude`, 'the unidentified-but-answering base is STILL MINTED');
  const warns = recentLogs().filter((l) => l.scope === 'gateway' && /did not identify as our gateway/.test(l.msg));
  ok(warns.length >= 1 && warns.some((l) => l.msg.includes(anonBase)),
     `the warning NAMES the unidentified address once (${JSON.stringify(warns.map((l) => l.msg).slice(-1)[0] || '(none)')})`);
  await close(anon.server);

  // (b) a REAL gateway (answers the signature route) → identified TRUE, no warning at all.
  _resetGatewayProbeCache();
  const realHits = { count: 0 };
  const realGw = http.createServer((req, res) => {
    realHits.count++;
    if (req.url === '/api/hello') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true,"service":"zeehive-llm-gateway"}');
    } else if (req.url === '/_gw/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ service: 'zeehive-llm-gateway', port: 0 }));
    } else {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":"not the gateway"}');
    }
  });
  servers.push(realGw);
  const RG = await new Promise((resolve) => realGw.listen(0, '127.0.0.1', () => resolve(realGw.address().port)));
  process.env.CXELL_API_BASE = `http://127.0.0.1:${RG}`;
  process.env.CXELL_API_FALLBACK = `http://127.0.0.1:4700`;
  process.env.GATEWAY_PORT = String(RG);
  const rgBase = `http://127.0.0.1:${RG}`;
  eq(await probeGatewayBase(rgBase), true, 'the real gateway is reachable');
  eq(gatewayIdentified(rgBase), true, 'and IDENTIFIED as OUR gateway via /_gw/health');
  const realEnv = await gatewayEnv({ xellToken: 'tok' });
  eq(realEnv.ANTHROPIC_BASE_URL, `http://127.0.0.1:${RG}/x/tok/claude`, 'the identified gateway is minted normally');
  const warnsAfter = recentLogs().filter((l) => l.scope === 'gateway' && /did not identify as our gateway/.test(l.msg) && l.msg.includes(rgBase));
  eq(warnsAfter.length, 0, 'an IDENTIFIED gateway logs NO unidentified warning');
  await close(realGw);

  console.log('\n── 11. IN-FLIGHT INVALIDATION — a probe already in flight when the gateway dies cannot re-stamp the cache ──');
  // The sequential case (section 9) proves an invalidate forces a re-probe. THIS is the race the
  // sequential case cannot see: a probe P1 was ALREADY in flight when the gateway died (its
  // /api/hello succeeded, its /_gw/health was still pending). invalidateGatewayProbe deletes the
  // in-flight slot, so a fresh probe P2 starts and records FAIL — then P1 settles and would write
  // its stale OK over that fresh FAIL, re-opening the TKT-179 30s window under concurrency. The
  // fix is an epoch counter: a probe only writes the cache if no invalidate fired while it was in
  // flight. This test holds /_gw/health open to pin P1 in flight, invalidates, releases P1 (it
  // settles OK), then makes /api/hello fail at the socket — and asserts the next probeGatewayBase
  // does NOT serve P1's stale OK.
  _resetGatewayProbeCache();
  let helloHits = 0;
  let failHellos = false;
  let releaseHealth = null;
  let healthArrived;
  const healthArrivedP = new Promise((r) => { healthArrived = r; });
  const racing = http.createServer((req, res) => {
    if (req.url === '/api/hello') {
      helloHits++;
      if (failHellos) { req.socket.destroy(); return; }   // connection-failure family — the dead shape
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true,"service":"zeehive-llm-gateway"}');
    } else if (req.url === '/_gw/health') {
      healthArrived();
      releaseHealth = () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"error":"not the gateway"}');
      };   // HOLD — do not respond until released
    } else {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":"not the gateway"}');
    }
  });
  servers.push(racing);
  const RC = await new Promise((resolve) => racing.listen(0, '127.0.0.1', () => resolve(racing.address().port)));
  process.env.CXELL_API_BASE = `http://127.0.0.1:${RC}`;
  process.env.CXELL_API_FALLBACK = `http://127.0.0.1:4700`;
  process.env.GATEWAY_PORT = String(RC);
  const rcBase = `http://127.0.0.1:${RC}`;
  const p1 = probeGatewayBase(rcBase);          // answers /api/hello (verdict=true), hangs on /_gw/health
  await healthArrivedP;                          // P1 is now in flight, awaiting the held identification probe
  invalidateGatewayProbe(rcBase);                // the gateway dies UNDER the in-flight probe
  releaseHealth();                               // let P1 settle — its verdict is already true (stale)
  eq(await p1, true, 'the in-flight probe settles true (it saw /api/hello before the death)');
  failHellos = true;                             // the gateway is now dead
  eq(await probeGatewayBase(rcBase), false, 'the next probe does NOT serve the stale OK — it fires a fresh probe and sees the death');
  eq(helloHits, 2, 'the fresh probe actually fired (2 hello hits) — not served from the stale cache');
  await close(racing);

  console.log(`\n${fail ? fail + ' FAILED' : 'all good'}`);
} finally {
  for (const s of servers) { try { s.close(); } catch { /* already closed */ } }
}

process.exit(fail ? 1 : 0);
