// Reverse proxy for xell webapps — the queenzee side of /xell-web/<slug>/ (the console nginx
// fronts it: /xell-web/<slug>/* → /api/xell-web/<slug>/*, then this middleware strips the
// /api/xell-web/<slug> prefix and forwards to the target xell's app tier). See
// docs/common-xell-network-plan.md — this is Decision 5.1/5.2 (path-prefix exposure, Node
// built-ins, no new dependency).
//
// WHY the proxy exists: a Zeehive xell's app tier is a bare process inside the queenzee
// container on zee-hive-net (runner: process). It is health-probed at 127.0.0.1:<port> and
// otherwise unreachable — the stored container URL (10.2.0.16:5383) is a LAN address nothing
// publishes. The proxy gives every xell webapp one stable, reachable URL
//   <console-origin>/xell-web/<slug>/
// for a human's browser AND for other cxells, with zero per-xell configuration.
//
// TWO UPSTREAMS, one route. A reviewed Zeehive webapp is the console itself: its HTML/assets come
// from the xell's Vite dev server, but its /api calls (and the terminal websocket) must reach the
// XELL'S OWN queenzee server — the wrong server answering the same paths is the exact trap
// CLAUDE.md warns about, now browser-side. So:
//   /xell-web/<slug>/api/*      → the xell's OWN server  (127.0.0.1:<server_port>/api/*)
//   /xell-web/<slug>/<anything> → the xell's Vite dev server (127.0.0.1:<webapp_port>/xell-web/<slug>/<anything>)
// Vite is started with base '/xell-web/<slug>/' (vite.config.js), so it answers the prefixed path
// and every asset it emits carries the prefix.
//
// UPSTREAM RESOLUTION (the cross-machine seam):
//   • same daemon as the queenzee (docker_ctx null/'default') → 127.0.0.1:<host_port> inside this
//     container — the same address the health probe already uses (containers.js processProbeUrls).
//   • a remote docker context → host:host_port from the row, reachable over the LAN route or, once
//     a WG mesh exists, a tunnel IP. The proxy needs no transport awareness; it just dials host:port.
//
// The Vite Host-header check: the proxy always forwards Host: localhost:<port> (a Host Vite trusts),
// so the browser's real origin never reaches Vite. Belt and braces — vite.config.js also sets
// allowedHosts:true.
//
// Streaming + websocket: Vite serves unbounded streams (SSE, HMR) and the xell server's /api is a
// websocket target (terminal bridge), so both bodies and 'upgrade' are proxied. Zero new deps:
// Node http.request for the body. A dead upstream is a named 502 — the difference between "app tier
// not built" and "proxy bug" must be visible, not a bare connection reset.
import http from 'node:http';
import { one } from '../db/pool.js';
import { logline } from './logbus.js';

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
// The Vite-side path prefix for a slug — Vite is started with base '/xell-web/<slug>/' (see
// vite.config.js), so EVERY asset it emits and serves is under this prefix.
const basePath = (slug) => `/xell-web/${slug}`;

// The human-facing, browser-reachable URL for a xell webapp: a path on the console origin. The
// console's nginx serves /xell-web/<slug>/* and this app IS the console, so a relative path
// resolves against whatever origin the console is at — a human's browser on the LAN, a cxell
// reaching host.docker.internal:5180, anywhere. This REPLACES the stored container url
// (10.2.0.16:5383), which nothing publishes. Used by fleet.js (the webapp chip's href) and
// selfVerifyWebapp (the verify offer), so they never disagree about where a webapp lives.
export const xellWebappPath = (slug) => `${basePath(slug)}/`;

// One upstream row for a (role, slug): the app tier is the xell's own server OR its webapp. The two
// cases are data, not heuristics: a process-runner role has no docker_ctx and is reached at the
// process's own loopback; a compose/container role is reached at its published host:port.
async function resolveRoleUpstream(slug, role) {
  const row = await one(
    `SELECT c.docker_ctx, c.host, c.host_port, c.url, c.health, c.name
       FROM container c JOIN xell_uses_container uc ON uc.container_id = c.id
       JOIN xell x ON x.id = uc.xell_id
      WHERE x.slug = $1 AND c.role = $2
      ORDER BY c.created_at DESC LIMIT 1`, [slug, role]);
  if (!row) return null;
  const sameDaemon = !row.docker_ctx || row.docker_ctx === 'default';
  const host = sameDaemon ? '127.0.0.1' : (row.host || null);
  const port = row.host_port || null;
  if (!host || !port) return null;
  return {
    upstream: `http://${host}:${port}`,
    // Always a Host Vite trusts. The real origin must never reach Vite unadvertised.
    hostHeader: `localhost:${port}`,
    sameDaemon, row,
  };
}

// The webapp (Vite) upstream and the xell's own server upstream.
const webappUpstream = (slug) => resolveRoleUpstream(slug, 'webapp');
const serverUpstream = (slug) => resolveRoleUpstream(slug, 'server');

// Liveness probe for one role's upstream — the offer-time truth check behind `zee verify-webapp`
// (selfVerifyWebapp). ANY HTTP response (even a 404) proves a process is listening on the port the
// proxy would dial; ECONNREFUSED/timeout proves the offered link would be a dead 502. This module
// owns upstream resolution, so the probe lives here: the offer and the proxy can never disagree
// about which address "up" means.
//   { resolved:false }            — no row / no port for that role (nothing to probe; the caller
//                                   decides whether that role is required)
//   { resolved:true, up, upstream } — a dialable upstream, and whether anything answered
export async function probeRoleUpstream(slug, role, { timeoutMs = 1500 } = {}) {
  const web = await resolveRoleUpstream(slug, role).catch(() => null);
  if (!web) return { resolved: false, up: false, upstream: null };
  const path = role === 'webapp' ? `${basePath(slug)}/` : '/api/';
  const up = await new Promise((done) => {
    const req = http.request(web.upstream, {
      method: 'GET', path, headers: { host: web.hostHeader }, timeout: timeoutMs,
    }, (res) => { res.resume(); done(true); });
    req.on('timeout', () => { req.destroy(); done(false); });
    req.on('error', () => done(false));
    req.end();
  });
  return { resolved: true, up, upstream: web.upstream };
}

// Proxy one HTTP request. `req.url` here is the path AFTER the router stripped the matched prefix
// (mounted with router.use). `forward` is the path to dial upstream: for Vite it is the base-prefixed
// path (Vite answers /xell-web/<slug>/...); for the xell's own server it is the plain /api/... the
// server expects (its routes are mounted at /api).
function proxyHttp(web, req, res, forwardPath) {
  const hopByHop = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'te', 'trailer', 'transfer-encoding', 'upgrade', 'host']);
  const headers = { ...req.headers };
  for (const h of hopByHop) delete headers[h];
  headers.host = web.hostHeader;

  const proxyReq = http.request(web.upstream, { method: req.method, headers, path: forwardPath });
  proxyReq.on('error', (e) => {
    if (!res.headersSent) {
      res.status(502).json({ error: `webapp ${req.params.slug} unreachable: ${e.message}`, upstream: web.upstream });
    } else { try { res.destroy(); } catch { /* already gone */ } }
  });
  proxyReq.on('response', (proxyRes) => {
    res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
    proxyRes.pipe(res);
  });
  req.pipe(proxyReq);
}

// Proxy one websocket upgrade: forward the raw upgrade to the upstream, then splice the two raw
// sockets. The client's upgrade reached us as the http server's 'upgrade' event (express never sees
// it), so this runs from attachWebappUpgrade.
function proxyUpgrade(web, req, socket, head, forwardPath) {
  const headers = { ...req.headers };
  delete headers.host;
  headers.host = web.hostHeader;
  headers.connection = 'Upgrade';
  headers.upgrade = 'websocket';

  const proxyReq = http.request(web.upstream, { method: 'GET', headers, path: forwardPath });
  proxyReq.on('error', (e) => {
    try { socket.write(`HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n${e.message}`); } catch { /* socket gone */ }
    socket.destroy();
  });
  proxyReq.on('upgrade', (_proxyRes, proxySocket, proxyHead) => {
    // The upstream agreed to upgrade. Reply 101 to the client and splice the sockets.
    try { socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n'); } catch { /* gone */ }
    proxySocket.pipe(socket).on('error', () => {});
    socket.pipe(proxySocket).on('error', () => {});
    if (proxyHead && proxyHead.length) proxySocket.unshift(proxyHead);
  });
  proxyReq.on('close', () => { try { socket.destroy(); } catch { /* already gone */ } });
  proxyReq.end();
}

// Express middleware for /xell-web/:slug/* — the webapp (Vite) half. req.params.slug is set by
// express; req.url is the remaining path (starting with '/', possibly '/').
export async function webappProxy(req, res) {
  const slug = String(req.params.slug || '');
  if (!SLUG_RE.test(slug)) return res.status(404).json({ error: 'not a xell webapp path' });
  const web = await webappUpstream(slug).catch(() => null);
  if (!web) {
    return res.status(404).json({ error: `no webapp for xell '${slug}' — build it first (\`zee build webapp --wait\`)` });
  }
  const forward = `${basePath(slug)}${req.url}`;
  try { proxyHttp(web, req, res, forward); }
  catch (e) {
    if (!res.headersSent) res.status(500).json({ error: `webapp proxy error: ${e.message}` });
    else try { res.destroy(); } catch { /* gone */ }
    logline('webapp', `proxy ${slug}: ${e.message}`);
  }
}

// Express middleware for /xell-web/:slug/api/* — the xell's OWN server half. Strips the
// /xell-web/<slug> prefix so the server sees plain /api/... (its routes are mounted at /api).
export async function webappApiProxy(req, res) {
  const slug = String(req.params.slug || '');
  if (!SLUG_RE.test(slug)) return res.status(404).json({ error: 'not a xell webapp path' });
  const web = await serverUpstream(slug).catch(() => null);
  if (!web) {
    return res.status(502).json({ error: `no server for xell '${slug}' — build it first (\`zee build server --wait\`)` });
  }
  // req.url is '/api/...' (express stripped /xell-web/<slug>/api from the mount? no — the router
  // mount is /xell-web/:slug/api, so req.url is the /<rest> after it). Rebuild the /api path.
  const forward = req.url.startsWith('/') && req.url !== '/' ? `/api${req.url}` : '/api/';
  try { proxyHttp(web, req, res, forward); }
  catch (e) {
    if (!res.headersSent) res.status(500).json({ error: `xell server proxy error: ${e.message}` });
    else try { res.destroy(); } catch { /* gone */ }
    logline('webapp', `api proxy ${slug}: ${e.message}`);
  }
}

// Websocket half. The upgrade request never reaches express (the server's 'upgrade' event fires
// first); this is wired in index.js beside attachTerminalBridge. It returns WITHOUT resolving when
// the upgrade is not ours, so the terminal bridge (registered on the same event) still sees it.
// /api/xell-web/<slug> (the console nginx forwarded path) is the match — the same shape express
// sees for the HTTP half, with the /api prefix the nginx added.
export function attachWebappUpgrade(server) {
  server.on('upgrade', async (req, socket, head) => {
    const match = /^\/api\/xell-web\/([a-z0-9][a-z0-9-]*)(?:\/)?(api(?:\/.*)?)?$/.exec(req.url || '');
    if (!match) return; // not ours — leave the socket for the terminal bridge
    const slug = match[1];
    const isApi = match[2] !== undefined;              // /api or /api/... → the xell's own server
    const rest = match[2] === 'api' ? '' : (match[2] ? match[2].slice(4) : '');
    req.params = { slug };
    const web = await (isApi ? serverUpstream(slug) : webappUpstream(slug)).catch(() => null);
    if (!web) {
      try { socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\nno app tier for this xell'); } catch { /* gone */ }
      return socket.destroy();
    }
    // Forward path: for the xell's own server, /api/... (its routes are mounted at /api); for Vite,
    // the base-prefixed path (Vite answers /xell-web/<slug>/...).
    const forward = isApi
      ? `/api${rest ? `/${rest}` : '/'}`
      : `${basePath(slug)}/${match[2] || ''}`;
    try { proxyUpgrade(web, req, socket, head, forward); }
    catch (e) { try { socket.destroy(); } catch { /* gone */ } logline('webapp', `ws proxy ${slug}: ${e.message}`); }
  });
}
