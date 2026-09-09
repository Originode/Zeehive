// THE GATEWAY-HEALTH PROBE MUST AGREE WITH THE ADDRESS MINT — and its reachability definition is
// pinned so it cannot drift from the landed probe's.
//
// The queenzee's container-health tick probes gateway reachability (queenzee/gateway-health.js) and
// caches the verdict for the fleet read model. It MUST agree with the mint: a cage's provider base-url
// is minted from chooseGatewayBaseUrl() (gatewayEnv → primary-then-fallback, first that answers), so
// the health surface must report the SAME decision — the address cages are ACTUALLY given — or it
// cries "gateway unreachable at host.docker.internal:4701" while every cage was minted with
// zeehive_server:4701 that answers. That contradiction is the 2026-08-22 blind spot in reverse.
//
// The reachability definition itself (landed 7287cd3 / gateway.js probeGatewayBase): ANY HTTP answer
// — a 404 included — is proof the port resolves and a server answers, which is exactly what a
// provider CLI needs to reach the gateway. Only the CONNECTION-FAILURE family (refused / ENOTFOUND /
// timeout) is the outage shape, and that is what the console calls "unreachable".
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };
const close = (s) => new Promise((r) => s.close(r));

const mock = async (helloStatus, body) => {
  const hits = { count: 0 };
  const server = createServer((req, res) => {
    if (req.url === '/api/hello') {
      hits.count++;
      res.writeHead(helloStatus, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    } else {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, port: server.address().port, hits };
};

// The gateway probe cache (gateway.js) is module-level; reset it between scenarios so one case's
// verdict cannot leak into the next (the gateway-address test does the same).
const gw = await import(`file://${join(ROOT, 'server/src/lib/gateway.js')}`);
const probe = await import(`file://${join(ROOT, 'server/src/queenzee/gateway-health.js')}`);

// ── 1. a 404 answer is REACHABLE (the landed definition) ─────────────────────────────────────────
console.log('\n── 1. ANY HTTP answer is reachable — a 404 on /api/hello is NOT a dead address ──');
gw._resetGatewayProbeCache();
const four = await mock(404, { error: 'not the gateway hello' });
process.env.CXELL_API_BASE = `http://127.0.0.1:${four.port}`;
process.env.CXELL_API_FALLBACK = `http://127.0.0.1:${four.port + 1000}`;  // dead — never reached
process.env.GATEWAY_PORT = String(four.port);
process.env.CONTAINER_MONITOR_ENABLED = 'false';
let snap = await probe.probeGatewayHealth();
ok(snap.state === 'ok' && snap.address === `http://127.0.0.1:${four.port}`,
   `a 404 answer is REACHABLE — the chip says ok at the address (${JSON.stringify(snap.state)} at ${snap.address})`);
await close(four.server);

// ── 2. the real gateway hello is ok, no caveat ───────────────────────────────────────────────────
gw._resetGatewayProbeCache();
const two = await mock(200, { ok: true, service: 'zeehive-llm-gateway' });
process.env.CXELL_API_BASE = `http://127.0.0.1:${two.port}`;
process.env.CXELL_API_FALLBACK = `http://127.0.0.1:${two.port + 1000}`;   // dead — never reached
process.env.GATEWAY_PORT = String(two.port);
snap = await probe.probeGatewayHealth();
ok(snap.state === 'ok' && snap.error === null && snap.address === `http://127.0.0.1:${two.port}`,
   `the real gateway hello is ok, no caveat (${JSON.stringify(snap)})`);
await close(two.server);

// ── 3. the connection-failure family is DOWN — and names BOTH genuinely different addresses ──────
console.log('\n── 3. the connection-failure family is unreachable — the outage shape ──');
gw._resetGatewayProbeCache();
const dead = two.port + 1;   // a port nothing listens on
// TWO GENUINELY DIFFERENT candidates — the entire point of f2743e5. The primary (host.docker.internal)
// and the fallback (the compose-network name) share GATEWAY_PORT and differ only in HOST, so the
// test must stand them in with TWO DIFFERENT hosts. 127.0.0.1 and 127.0.0.2 are distinct loopback
// addresses, both dead on the gateway port. (The old fixture made the two differ only in PORT,
// which gatewayFallbackBaseUrl() strips — so primary and fallback collapsed to ONE address and
// "neither X nor Y answers" passed without ever trying a second candidate.)
process.env.CXELL_API_BASE = `http://127.0.0.1:4700`;       // host only — GATEWAY_PORT supplies the port
process.env.CXELL_API_FALLBACK = `http://127.0.0.2:4700`;   // a DIFFERENT host, same dead GATEWAY_PORT
process.env.GATEWAY_PORT = String(dead);
const primaryDead = `http://127.0.0.1:${dead}`;
const fallbackDead = `http://127.0.0.2:${dead}`;
snap = await probe.probeGatewayHealth();
ok(snap.state === 'down', `a closed port is DOWN (${JSON.stringify(snap.state)})`);
ok(snap.address === primaryDead,
   `and names the address cages were given (${JSON.stringify(snap.address)})`);
ok(primaryDead !== fallbackDead, 'the two candidates are GENUINELY DIFFERENT hosts — the point of f2743e5');
ok((snap.error || '').includes(primaryDead) && (snap.error || '').includes(fallbackDead),
   `the why names BOTH DIFFERENT addresses — primary and fallback (${JSON.stringify(snap.error)})`);

// ── 4. gateway-off config is never a false alarm ────────────────────────────────────────────────
// config.gatewayPort is read at module import, so this case needs a FRESH process (env set first).
console.log('\n── 4. GATEWAY_PORT === PORT means no separate gateway — honest "unknown", not a false alarm ──');
const offOut = execFileSync(process.execPath, ['--input-type=module', '-e', `
  process.env.PORT = '4700';
  process.env.CXELL_API_BASE = 'http://127.0.0.1:4700';
  process.env.GATEWAY_PORT = '4700';      // same port → no separate door to probe
  process.env.CONTAINER_MONITOR_ENABLED = 'false';
  const m = await import('${join(ROOT, 'server/src/queenzee/gateway-health.js')}');
  const snap = await m.probeGatewayHealth();
  console.log(JSON.stringify(snap));
`], { encoding: 'utf8' });
const offSnap = JSON.parse(offOut.trim().split('\n').pop());
ok(offSnap.state === 'unknown' && /no separate LLM gateway/.test(offSnap.error || ''),
   `gateway-off config stays 'unknown', never a false 'down' (${JSON.stringify(offSnap.state)})`);
// The off-by-config snapshot must NOT name an address — the API port was never a gateway, so the
// console must not present it as one (S2). The gatewayHealth() fallback (address || gatewayBaseUrl())
// previously resurrected the API port here, showing "gateway not yet probed at http://127.0.0.1:4700"
// forever after the probe HAD already decided the gateway is off.
ok(offSnap.address === null,
   `and names NO address — the API port was never a gateway (${JSON.stringify(offSnap.address)})`);

console.log(failures ? `\n${failures} FAILED` : '\nall good');
process.exit(failures ? 1 : 0);
