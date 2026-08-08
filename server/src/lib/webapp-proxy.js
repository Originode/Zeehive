// Xell webapp upstream resolution + the /xell-web COMPATIBILITY REDIRECT.
//
// Xell webapps are reached DIRECTLY on their own port now: http://<console-hostname>:<host_port>/
// — the port the meta-DB already allocates per xell (project web_base + slot), published on the
// queenzee server container as a range and carried to loopback-only / remote upstreams by the
// preview-ports forwarder (lib/preview-ports.js). Decision record:
// docs/visual-verification-diagnosis.md §7, superseding the /xell-web path proxy of
// docs/common-xell-network-plan.md — a human asked for the port, not a path.
//
// What remains here:
//   • resolveRoleUpstream — the one place that maps (slug, role) → dialable upstream, from data
//     the meta-DB already holds. Shared by the redirect, the offer-time liveness probe and the
//     preview forwarder's same-daemon/remote split (targetFor mirrors it).
//   • probeRoleUpstream — offer-time liveness behind `zee verify-webapp` (selfVerifyWebapp): a
//     card in front of a human must never be a dead link.
//   • webappRedirect — old /xell-web/<slug>/... links (open offers, bookmarks, the console nginx
//     block) 302 to the direct port on the hostname the CALLER used, so pre-existing cards keep
//     working. Websocket upgrades at the old path are gone with the proxy; the direct port carries
//     them natively.
import http from 'node:http';
import { one } from '../db/pool.js';

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

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
    hostHeader: `localhost:${port}`,
    sameDaemon, row,
  };
}

// Liveness probe for one role's upstream — the offer-time truth check behind `zee verify-webapp`
// (selfVerifyWebapp). ANY HTTP response (even a 404) proves a process is listening on the port a
// human would be sent to; ECONNREFUSED/timeout proves the offered link would be dead. This module
// owns upstream resolution, so the probe lives here: the offer and the routing can never disagree
// about which address "up" means.
//   { resolved:false }            — no row / no port for that role (nothing to probe; the caller
//                                   decides whether that role is required)
//   { resolved:true, up, upstream } — a dialable upstream, and whether anything answered
export async function probeRoleUpstream(slug, role, { timeoutMs = 1500 } = {}) {
  const web = await resolveRoleUpstream(slug, role).catch(() => null);
  if (!web) return { resolved: false, up: false, upstream: null };
  const path = role === 'webapp' ? '/' : '/api/';
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

// The Location a /xell-web caller is sent to: the xell's own port on the hostname the caller
// reached US at — the one hostname we KNOW their network can resolve (it just did). Pure, tested.
export function redirectTarget(hostHeader, port, rest = '/') {
  const hostname = String(hostHeader || '').split(':')[0] || 'localhost';
  const path = String(rest || '/');
  return `http://${hostname}:${port}${path.startsWith('/') ? path : `/${path}`}`;
}

// Express middleware for /xell-web/:slug/* — 302 to the direct port, path preserved (deep links
// to assets land on the same asset). Old open offers and bookmarks keep working; new URLs are
// minted as direct ports and never come here.
export async function webappRedirect(req, res) {
  const slug = String(req.params.slug || '');
  if (!SLUG_RE.test(slug)) return res.status(404).json({ error: 'not a xell webapp path' });
  const web = await resolveRoleUpstream(slug, 'webapp').catch(() => null);
  if (!web) {
    return res.status(404).json({ error: `no webapp for xell '${slug}' — build it first (\`zee build webapp --wait\`)` });
  }
  return res.redirect(302, redirectTarget(req.headers.host, web.row.host_port, req.url));
}
