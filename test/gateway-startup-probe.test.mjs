// THE STARTUP PROBE (TKT-179) — verifyGatewayReachable is the boot-time half of proving the gateway
// address a cage will actually be handed. It runs once, when the gateway listener comes up, BEFORE
// any dispatch, and answers two questions: "is the address reachable?" and, when it is not, "WHICH
// addresses were tried?". The incident it guards against: a gateway that answered on 127.0.0.1:4701
// inside the container but whose port was NOT published, so every cage got host.docker.internal:4701
// and every provider failed with the VENDOR's words for 13h.
//
// What this file fences:
//   1. a reachable gateway → { ok: true, base } NAMES the chosen address;
//   2. neither candidate answers → { ok: false, error } NAMES BOTH addresses and does NOT throw —
//      the probe must never crash the boot;
//   3. a dead gateway is logged LOUDLY (console.error 'GATEWAY UNREACHABLE AT STARTUP: …');
//   4. the probe is only MOUNTED when the gateway is on — the call sits inside the
//      `if (config.gatewayPort !== config.port)` gate in index.js, so an OFF gateway has no probe.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };
const eq = (a, b, m) => ok(a === b, `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
const close = (s) => new Promise((r) => s.close(r));

const mockGateway = async () => {
  const hits = { count: 0 };
  const server = http.createServer((req, res) => {
    hits.count++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true,"service":"zeehive-llm-gateway"}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, hits, port: server.address().port };
};

const gw = await import(`file://${join(ROOT, 'server/src/lib/gateway.js')}`);

console.log('\n── 1. a reachable gateway is named, and the probe never throws ──');
const up = await mockGateway();
gw._resetGatewayProbeCache();
process.env.CXELL_API_BASE = `http://127.0.0.1:${up.port}`;
process.env.CXELL_API_FALLBACK = `http://127.0.0.1:${up.port}`;   // equal → no second name
process.env.GATEWAY_PORT = String(up.port);
let snap = await gw.verifyGatewayReachable();
ok(snap.ok === true && snap.base === `http://127.0.0.1:${up.port}`,
   `a reachable gateway resolves ok and NAMES the address (${JSON.stringify(snap)})`);
await close(up.server);

console.log('\n── 2. neither candidate answers → ok:false, NAMES both, and does NOT throw ──');
gw._resetGatewayProbeCache();
const dead = up.port + 1;   // nothing listens here
process.env.CXELL_API_BASE = `http://127.0.0.1:${dead}`;
process.env.CXELL_API_FALLBACK = `http://127.0.0.2:${dead}`;   // a DIFFERENT host, same dead GATEWAY_PORT
process.env.GATEWAY_PORT = String(dead);
let threw = false;
try {
  snap = await gw.verifyGatewayReachable();
} catch { threw = true; }
ok(!threw, 'verifyGatewayReachable never THROWS — a boot probe must not crash the boot');
ok(snap.ok === false, `an unreachable gateway resolves ok:false, not a throw (${JSON.stringify(snap)})`);
ok(/LLM gateway unreachable/.test(snap.error || ''), 'the failure NAMES the gateway');
ok((snap.error || '').includes(`http://127.0.0.1:${dead}`) && (snap.error || '').includes(`http://127.0.0.2:${dead}`),
   `and QUOTES both addresses tried (${JSON.stringify(snap.error)})`);

console.log('\n── 3. a dead gateway is logged LOUDLY ──');
// The probe logs via console.error so a human sees it at boot even before logbus (which may need
// the db) is reachable. Intercept console.error to prove the line was written.
const origError = console.error;
let errLines = [];
console.error = (...args) => errLines.push(args.join(' '));
try {
  gw._resetGatewayProbeCache();
  await gw.verifyGatewayReachable();
} finally {
  console.error = origError;
}
ok(errLines.some((l) => /GATEWAY UNREACHABLE AT STARTUP/.test(l)),
   `the boot log line is LOUD and names the failure (${JSON.stringify(errLines[errLines.length - 1] || '(none)')})`);

console.log('\n── 4. the probe is only mounted when the gateway is ON ──');
const indexSrc = readFileSync(join(ROOT, 'server/src/index.js'), 'utf8');
const gateStart = indexSrc.indexOf('if (config.gatewayPort !== config.port)');
ok(gateStart > 0, 'index.js has the off-switch gate (GATEWAY_PORT !== PORT)');
ok(indexSrc.slice(gateStart).includes('verifyGatewayReachable()'),
   'the startup probe call sits INSIDE the off-switch gate — an ON gateway probes');
ok(!indexSrc.slice(0, gateStart).includes('verifyGatewayReachable()'),
   'and it is never called before the gate — an OFF gateway has no startup probe at all');

console.log(fail ? `\n${fail} FAILED` : '\nall good');
process.exit(fail ? 1 : 0);
