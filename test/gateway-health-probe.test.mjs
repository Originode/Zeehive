// THE GATEWAY-HEALTH PROBE'S REACHABILITY DEFINITION — pinned so it cannot drift from the
// address-mint probe's.
//
// The queenzee's container-health tick probes <gatewayBaseUrl>/api/hello (queenzee/gateway-health.js)
// and caches the verdict for the fleet read model. The REACH definition must match the address-mint
// probe (server/src/lib/gateway.js probeGatewayBase, landed 7287cd3): ANY HTTP answer — a 404
// included — is proof the port resolves and a server answers, which is exactly what a provider CLI
// needs to reach the gateway. Only the CONNECTION-FAILURE family (refused / ENOTFOUND / timeout) is
// the outage shape, and that is what the console must call "unreachable".
//
// So the fleet-health chip can never say "gateway unreachable at zeehive_server:4701 (HTTP 404)"
// while the mint probe says that same address is reachable — that contradiction is the 2026-08-22
// blind spot in reverse.
import { createServer } from 'node:http';
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

// ── 1. any HTTP answer is REACHABLE (the landed definition) ─────────────────────────────────────
console.log('\n── 1. ANY HTTP answer is reachable — only the connection-failure family is down ──');
const four = await mock(404, { error: 'not the gateway hello' });
process.env.CXELL_API_BASE = `http://127.0.0.1:${four.port}`;
process.env.GATEWAY_PORT = String(four.port);
process.env.CONTAINER_MONITOR_ENABLED = 'false';
const probe = await import(`file://${join(ROOT, 'server/src/queenzee/gateway-health.js')}`).then((m) => m);
let snap = await probe.probeGatewayHealth();
ok(snap.state === 'ok' && snap.address === `http://127.0.0.1:${four.port}`,
   `a 404 answer is REACHABLE — the chip says ok at the address (${JSON.stringify(snap.state)} at ${snap.address})`);
ok((snap.error || '').includes('404'), 'the caveat (404 not-the-gateway-hello) rides the snapshot as a detail, not the verdict');
await close(four.server);

// ── 2. the real gateway hello is ok with no caveat ───────────────────────────────────────────────
const two = await mock(200, { ok: true, service: 'zeehive-llm-gateway' });
process.env.CXELL_API_BASE = `http://127.0.0.1:${two.port}`;
process.env.GATEWAY_PORT = String(two.port);
snap = await probe.probeGatewayHealth();
ok(snap.state === 'ok' && snap.error === null,
   `the real gateway hello is ok, no caveat (${JSON.stringify(snap)})`);
await close(two.server);

// ── 3. the connection-failure family is DOWN — and the code names WHY ──────────────────────────
console.log('\n── 3. the connection-failure family is unreachable — the outage shape ──');
process.env.CXELL_API_BASE = `http://127.0.0.1:${two.port + 1}`;   // a port nothing listens on
process.env.GATEWAY_PORT = String(two.port + 1);
snap = await probe.probeGatewayHealth();
ok(snap.state === 'down', `a closed port is DOWN (${JSON.stringify(snap.state)})`);
ok(/ECONNREFUSED/.test(snap.error || '') && snap.code === 'ECONNREFUSED',
   `and the reason names ECONNREFUSED (${JSON.stringify(snap.error)})`);
ok(snap.address === `http://127.0.0.1:${two.port + 1}`, 'the address named is the one cages were given');

// ── 4. gateway-off config is never a false alarm ────────────────────────────────────────────────
// config.gatewayPort is read at module import, so this case needs a FRESH process (env set first).
console.log('\n── 4. GATEWAY_PORT === PORT means no separate gateway — honest "unknown", not a false alarm ──');
import { execFileSync } from 'node:child_process';
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

console.log(failures ? `\n${failures} FAILED` : '\nall good');
process.exit(failures ? 1 : 0);
