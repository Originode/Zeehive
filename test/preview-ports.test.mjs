// PREVIEW-PORTS test — the direct-port forwarder behind xell webapp preview
// (docs/visual-verification-diagnosis.md §7, lib/preview-ports.js).
//
// Real sockets, no database (rows are injected — the DB read is one SELECT the visual-verify test
// already exercises the shape of). Loopback aliases stand in for the interfaces: the "process"
// listens on 127.0.0.1 (the in-container loopback), the forwarder binds 127.0.0.2 (the external
// iface), so the same-port-no-loop property is exercised for real. Asserted:
//   1. a live loopback-only upstream gets a forward on the bind host, and HTTP rides through it;
//   2. an upstream already answering on the bind host (wildcard bind) is NOT double-bound;
//   3. a dead upstream holds NO port (nothing to forward to), and a forward is RELEASED when its
//      upstream dies — the port is free again for a rebuilt process (the restart race mitigation);
//   4. a row that disappears has its forward closed.
// Everything closes in a finally, whatever happens.
import http from 'node:http';
import { reconcilePreviewPorts, stopPreviewPorts, targetFor } from '../server/src/lib/preview-ports.js';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };
const BIND = '127.0.0.2';                       // stands in for the container's external iface

const listen = (srv, port, host) => new Promise((res, rej) => {
  srv.once('error', rej); srv.listen(port, host, () => res(srv.address().port));
});
// agent:false — Node ≥19's global agent keeps sockets alive, and a kept-alive socket SURVIVES a
// listener close (close stops new connections only). Each probe must be a fresh connection or the
// "forward closed" assertions would test the agent's socket pool, not the forwarder.
const get = (host, port, path = '/') => new Promise((res) => {
  const req = http.get({ host, port, path, timeout: 1500, agent: false }, (r) => {
    let b = ''; r.on('data', (d) => { b += d; }); r.on('end', () => res({ status: r.statusCode, body: b }));
  });
  req.on('timeout', () => { req.destroy(); res({ status: 0, body: '' }); });
  req.on('error', () => res({ status: 0, body: '' }));
});

const upstream = http.createServer((_req, res) => res.end('upstream-answer'));
const wildcard = http.createServer((_req, res) => res.end('wildcard-answer'));
try {
  // ── 1. loopback-only upstream → forwarded on the bind host, same port ──
  console.log('\n── forward a loopback-only upstream ──');
  const P = await listen(upstream, 0, '127.0.0.1');
  const row = { host: '10.2.0.16', host_port: P, docker_ctx: null };   // stored LAN host is a lie; targetFor ignores it
  await reconcilePreviewPorts({ rows: [row], bindHost: BIND });
  const r1 = await get(BIND, P);
  ok(r1.status === 200 && r1.body === 'upstream-answer', `HTTP rides ${BIND}:${P} → 127.0.0.1:${P}`);

  // ── 2. an upstream already on the bind host is not double-bound ──
  console.log('\n── a wildcard-bound process is left alone ──');
  const PW = await listen(wildcard, 0, '0.0.0.0');
  const rowW = { host: null, host_port: PW, docker_ctx: null };
  const before = (await reconcilePreviewPorts({ rows: [row, rowW], bindHost: BIND })).held;
  ok(before === 1, `only the loopback-only upstream is held (held=${before}; the wildcard one already answers on ${BIND})`);
  const rw = await get(BIND, PW);
  ok(rw.status === 200 && rw.body === 'wildcard-answer', 'the wildcard-bound process answers directly');

  // ── 3. a dead upstream holds no port / releases its port ──
  console.log('\n── death releases the port ──');
  await new Promise((r) => upstream.close(r));
  await reconcilePreviewPorts({ rows: [row, rowW], bindHost: BIND });
  const r2 = await get(BIND, P);
  ok(r2.status === 0, 'after the upstream dies, the forward is closed (port free for a rebuilt process)');
  const deadRow = { host: null, host_port: 1, docker_ctx: null };      // nothing ever listens on :1
  const heldDead = (await reconcilePreviewPorts({ rows: [deadRow], bindHost: BIND })).held;
  ok(heldDead === 0, 'a dead upstream is never bound in the first place');

  // ── 4. a vanished row has its forward closed ──
  console.log('\n── a vanished row is released ──');
  const upstream2 = http.createServer((_req, res) => res.end('two'));
  const P2 = await listen(upstream2, 0, '127.0.0.1');
  await reconcilePreviewPorts({ rows: [{ host: null, host_port: P2, docker_ctx: null }], bindHost: BIND });
  ok((await get(BIND, P2)).body === 'two', 'second upstream forwarded');
  await reconcilePreviewPorts({ rows: [], bindHost: BIND });
  ok((await get(BIND, P2)).status === 0, 'row gone → forward closed');
  await new Promise((r) => upstream2.close(r));

  // targetFor: the same-daemon/remote split is data, not heuristics (mirrors resolveRoleUpstream)
  ok(targetFor({ host: '10.2.0.16', host_port: 5379, docker_ctx: 'default' }).host === '127.0.0.1',
     "docker_ctx 'default' is same-daemon");
} finally {
  stopPreviewPorts();
  await new Promise((r) => wildcard.close(r));
  try { upstream.close(); } catch { /* already closed */ }
}

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
