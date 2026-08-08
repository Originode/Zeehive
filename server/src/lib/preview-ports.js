// Direct-port xell webapp preview — the queenzee tracks every xell webapp's port in the meta-DB
// (container.host_port, allocated per project: web_base + slot, mod slot window) and makes THAT
// port answer on its own container's external interface, so docker's published ranges (see the
// server service `ports:` in docker-compose.prod.yml / docker-compose.bootstrap.yml) carry it to
// the host. A human opens http://<console-hostname>:<host_port>/ — same hostname they loaded the
// console from, the xell's own port. No path prefix, no per-xell configuration.
// Decision record: docs/visual-verification-diagnosis.md §7 (supersedes the /xell-web path proxy).
//
// Three upstream shapes, one rule — "the port answers on the external iface":
//   • same-daemon process bound 0.0.0.0 (Zeehive's own vite, host:true) — already answers on the
//     external iface; docker publishing reaches it directly. We must NOT bind: nothing to do.
//   • same-daemon process bound loopback-only (another project's dev server) — we bind
//     <external-iface>:port and pipe to 127.0.0.1:port. Loopback ≠ external iface, so no loop.
//   • remote docker context (a xell whose app tier runs on another machine) — we bind
//     <external-iface>:port and pipe to host:host_port from the row.
//
// TCP-level piping, deliberately: HTTP, SSE and websockets (Vite HMR) all ride through untouched.
//
// THE ONE TRAP — a held bind can break a restarting process. On Linux a wildcard bind
// (0.0.0.0:port) conflicts with ANY specific bind on that port, so if we hold <iface>:port while
// a rebuilt vite tries host:true on the same port, vite fails to start. Mitigation: we only bind
// while the upstream actually answers, we close the moment it stops (every reconcile tick, and
// immediately on a refused forward dial), and same-daemon wildcard binders are never bound at all.
// The residual race is one tick wide and recorded in the decision record.
import net from 'node:net';
import os from 'node:os';
import { q } from '../db/pool.js';
import { logline } from './logbus.js';

// The container's external IPv4 (the compose-network address docker's published ports DNAT to).
export function externalIPv4() {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) if (!a.internal && a.family === 'IPv4') return a.address;
  }
  return null;
}

// Where a row's webapp actually listens, from data the meta-DB already holds — the same
// same-daemon/remote split resolveRoleUpstream (webapp-proxy.js) uses.
export function targetFor(row) {
  const sameDaemon = !row.docker_ctx || row.docker_ctx === 'default';
  return {
    host: sameDaemon ? '127.0.0.1' : (row.host || null),
    port: row.host_port ? Number(row.host_port) : null,
    sameDaemon,
  };
}

// port → { server, target } for listeners WE hold. Module-level: one queenzee, one port namespace.
const held = new Map();

function dialOk(host, port, ms = 400) {
  return new Promise((done) => {
    const s = net.connect({ host, port });
    const t = setTimeout(() => { s.destroy(); done(false); }, ms);
    s.on('connect', () => { clearTimeout(t); s.destroy(); done(true); });
    s.on('error', () => { clearTimeout(t); done(false); });
  });
}

function closeHeld(port) {
  const h = held.get(port);
  if (!h) return;
  held.delete(port);
  try { h.server.close(); } catch { /* already down */ }
}

function bindForward(port, target, bindHost) {
  return new Promise((done) => {
    const server = net.createServer((client) => {
      const upstream = net.connect({ host: target.host, port: target.port }, () => {
        client.pipe(upstream); upstream.pipe(client);
      });
      upstream.on('error', () => {
        client.destroy();
        // A refused dial means the process died under us — release the port NOW so a rebuilt
        // process can take it back, rather than a tick later.
        const cur = held.get(port);
        if (cur && cur.server === server) closeHeld(port);
      });
      client.on('error', () => upstream.destroy());
    });
    server.once('error', () => done(false));           // EADDRINUSE = someone real serves it
    server.listen(port, bindHost, () => { held.set(port, { server, target }); done(true); });
  });
}

// One reconcile pass. `rows` is injectable for tests; the default reads every xell webapp port
// from the meta-DB — the queenzee's port tracking IS the container table.
export async function reconcilePreviewPorts({ rows = null, bindHost = externalIPv4() } = {}) {
  if (!bindHost) return { held: held.size };
  const list = rows ?? await q(
    `SELECT c.host, c.host_port, c.docker_ctx
       FROM container c JOIN xell_uses_container uc ON uc.container_id = c.id
      WHERE c.role = 'webapp' AND c.host_port IS NOT NULL`);
  const want = new Map();
  for (const row of list) {
    const t = targetFor(row);
    if (t.host && t.port) want.set(t.port, t);
  }
  for (const port of [...held.keys()]) if (!want.has(port)) closeHeld(port);
  for (const [port, target] of want) {
    const up = await dialOk(target.host, port);
    if (!up) { closeHeld(port); continue; }           // nothing to forward to — hold no port
    if (held.has(port)) continue;                      // already forwarding
    if (await dialOk(bindHost, port)) continue;        // wildcard-bound process already answers
    const bound = await bindForward(port, target, bindHost);
    if (bound) logline('preview', `forwarding ${bindHost}:${port} → ${target.host}:${port}`);
  }
  return { held: held.size };
}

// Close everything we hold (tests, shutdown).
export function stopPreviewPorts() {
  for (const port of [...held.keys()]) closeHeld(port);
}

// Boot wiring: a reconcile tick every few seconds. Cheap (a couple of dial probes per live
// webapp), and the tick width bounds both staleness and the restart race above.
export function startPreviewPorts({ intervalMs = 5000 } = {}) {
  const tick = () => reconcilePreviewPorts().catch((e) => logline('preview', `reconcile: ${e.message}`));
  tick();
  const t = setInterval(tick, intervalMs);
  t.unref?.();
  return t;
}
