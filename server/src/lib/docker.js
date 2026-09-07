// Docker Engine client — talks to the daemons over their HTTP API directly, with no `docker`
// CLI and no shell in the path.
//
// WHY NOT SHELL OUT: this used to run scripts/check-containers.sh via `spawn('bash', ...)`. On
// Windows, plain `bash` resolves to C:\Windows\system32\bash.exe (WSL) before Git bash. With no
// WSL distro installed that exits 1 and prints to STDERR, leaving STDOUT EMPTY — which the caller
// could not distinguish from "the daemon is reachable and has no containers". Result: every
// modeled container was reported `down` while the whole fleet was up. The daemons are plain TCP
// endpoints; going straight to the API removes the shell, the PATH dependency, and that entire
// class of failure. Errors here THROW, so the caller can map them to 'unknown' — never 'down'.
//
// SSH CONTEXTS ARE THE ONE EXCEPTION (mardale-prod-alt, the Cloudflare-Access path to the Mardale
// NAS — see docs/onboard-mardale-prod-alt.md). The docker HTTP API cannot ride SSH, so an SSH
// context's daemon is reachable ONLY through the `docker` CLI. The READ paths that must keep
// working when the LAN route to the prod NAS is down (dockerPs, listContainersDetailed — the
// health monitor and discovery) dial SSH contexts by shelling out to `docker --context <ctx> ps`;
// the WRITE/ACTION paths (stopAndRemoveContainer, removeImage) and the raw connection consumers
// (terminal-bridge) still refuse ssh:// with an explicit error, because a silent SSH dial for a
// destructive action would be worse than a loud one.
import http from 'node:http';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { config } from '../config.js';

// Docker CLI stores each context at contexts/meta/<sha256(name)>/meta.json — the same lookup the
// CLI does for `--context <name>`, so we stay in sync with whatever `docker context` reports.
function metaPathFor(ctx) {
  const digest = createHash('sha256').update(ctx).digest('hex');
  return resolve(config.dockerConfigDir, 'contexts', 'meta', digest, 'meta.json');
}

// "tcp://10.1.0.18:2375"            -> { host, port }
// "tcp://docker.example.com:2375"   -> { host, port }   (a DNS name is a valid docker host)
// "unix:///var/run/docker.sock"     -> { socketPath: '/var/run/docker.sock' }
// "npipe:////./pipe/dockerEngine"   -> { socketPath: '\\.\pipe\dockerEngine' }
// "ssh://mnrevelo@host"             -> { ssh: true, endpoint }
function parseDockerHost(hostStr) {
  if (!hostStr) throw new Error('context has no docker endpoint');
  const tcp = /^tcps?:\/\/([^:/]+):(\d+)/.exec(hostStr);
  if (tcp) return { host: tcp[1], port: Number(tcp[2]) };
  if (hostStr.startsWith('unix://')) return { socketPath: hostStr.slice('unix://'.length) };
  if (hostStr.startsWith('npipe://')) {
    return { socketPath: hostStr.slice('npipe://'.length).replace(/\//g, '\\') };
  }
  if (/^ssh:\/\//.test(hostStr)) return { ssh: true, endpoint: hostStr };
  throw new Error(`unsupported docker endpoint: ${hostStr}`);
}

// Read the raw docker endpoint string for a context name, WITHOUT parsing it into connection
// options. DOCKER_HOST wins for the implicit contexts, as it does for the CLI; a named context is
// always read from disk. Shared by resolveContext (connection options), the SSH-detection the
// read paths need (they cannot dial SSH over HTTP, so they shell out to the CLI instead), and the
// machine connection check (which reports the endpoint a machine's settings dial).
export async function contextEndpoint(ctx) {
  if ((ctx === 'default' || !ctx) && process.env.DOCKER_HOST) return process.env.DOCKER_HOST;
  let raw;
  try {
    raw = await readFile(metaPathFor(ctx), 'utf8');
  } catch {
    throw new Error(`unknown docker context '${ctx}' (no meta.json under ${config.dockerConfigDir})`);
  }
  let meta;
  try { meta = JSON.parse(raw); } catch (e) { throw new Error(`corrupt context meta for '${ctx}': ${e.message}`); }
  return meta?.Endpoints?.docker?.Host;
}

// Resolve a context name to connection options. DOCKER_HOST wins for the implicit contexts, as it
// does for the CLI; a named context is always read from disk.
//
// An SSH context THROWS here with a clear reason: the docker HTTP API cannot ride SSH, and this
// function's result feeds http.request — a caller that only has HTTP must not get a value it will
// silently misuse. The READ paths (dockerPs / listContainersDetailed) never call this: they read
// the endpoint via endpointFor() and dial an SSH context through the docker CLI instead.
export async function resolveContext(ctx) {
  const host = await contextEndpoint(ctx);
  const parsed = parseDockerHost(host);
  if (parsed.ssh) {
    throw new Error(
      `docker endpoint '${parsed.endpoint}' is an SSH context — the docker HTTP API cannot ride SSH. `
      + 'Dial it with `docker --context` on the CLI instead; the queenzee\'s health/discovery do '
      + 'exactly that, but HTTP-only callers (terminal-bridge, stop/remove actions) cannot. '
      + 'See docs/onboard-mardale-prod-alt.md.');
  }
  return parsed;
}

// Whether a context's endpoint is SSH. The read paths use this to decide between the HTTP API and
// the docker CLI — the CLI is the ONLY thing that can ride SSH (the SSH transport lives in the
// docker CLI itself — ssh.omnibiz.express over Cloudflare Access via ~/.ssh/config).
async function isSshContext(ctx) {
  return (await contextEndpoint(ctx))?.startsWith('ssh://') || false;
}

// Shell out to the `docker` CLI for a READ against an SSH context. Best-effort by contract: returns
// null when the CLI is missing or the daemon is unreachable, so callers map it to 'unknown' — never
// a false 'down'. `docker ps --format {{json .}}` emits one full container object per line — the
// same shape /containers/json returns, so the shared parsers below work on either transport.
function dockerCliPs(ctx, timeout) {
  const r = spawnSync('docker', ['--context', ctx, 'ps', '--no-trunc', '--format', '{{json .}}'],
    { encoding: 'utf8', timeout, windowsHide: true });
  if (r.status !== 0 || !r.stdout) return null;
  const list = [];
  for (const line of r.stdout.split('\n')) {
    if (!line.trim()) continue;
    try { list.push(JSON.parse(line)); } catch { /* a malformed line is not the daemon's answer */ }
  }
  return list;
}

function getJson(conn, path, timeout) {
  return new Promise((res, rej) => {
    const req = http.request({ ...conn, path, method: 'GET', timeout }, (r) => {
      let body = '';
      r.setEncoding('utf8');
      r.on('data', (d) => (body += d));
      r.on('end', () => {
        if (r.statusCode < 200 || r.statusCode >= 300) return rej(new Error(`HTTP ${r.statusCode}: ${body.slice(0, 200)}`));
        try { res(JSON.parse(body)); } catch (e) { rej(new Error(`bad JSON from daemon: ${e.message}`)); }
      });
      r.on('error', rej);
    });
    req.on('error', rej);
    // A hung TCP read is the case the old 30s SIGKILL was guarding; keep an explicit deadline so
    // one unreachable daemon can never stall the health tick.
    req.on('timeout', () => req.destroy(new Error(`timeout after ${timeout}ms`)));
    req.end();
  });
}

// A request that does NOT expect a JSON body back (stop/remove return 204/304 empty). Resolves
// with the HTTP status so the caller can tell "done" (2xx) from "already gone" (404) from
// "already in that state" (304). THROWS only on a transport error or an unexpected 5xx — a 404 is
// data, not a failure (the container/image may have been removed already).
function reqNoBody(conn, method, path, timeout) {
  return new Promise((res, rej) => {
    const r = http.request({ ...conn, path, method, timeout }, (resp) => {
      let body = '';
      resp.setEncoding('utf8');
      resp.on('data', (d) => (body += d));
      resp.on('end', () => {
        if (resp.statusCode >= 500) return rej(new Error(`HTTP ${resp.statusCode}: ${body.slice(0, 200)}`));
        res({ status: resp.statusCode, body });
      });
      resp.on('error', rej);
    });
    r.on('error', rej);
    r.on('timeout', () => r.destroy(new Error(`timeout after ${timeout}ms`)));
    r.end();
  });
}

// The container list backing both read paths, HTTP for TCP contexts and the docker CLI for SSH
// contexts. Returns an ARRAY of the same shape docker's /containers/json returns (the CLI's
// `{{json .}}` template emits exactly that object per line). THROWS when the context is unknown or
// the endpoint is unsupported; returns null when the daemon is unreachable (callers say 'unknown',
// never 'down'). `ps` is read-only — this is deliberately the ONLY CLI dial in the module.
async function getContainerList(ctx, timeout) {
  if (await isSshContext(ctx)) {
    // The CLI rides SSH; a missing/unreachable daemon answers status!==0 → null → 'unknown'.
    const list = dockerCliPs(ctx, timeout);
    if (!list) return null;
    if (!Array.isArray(list)) throw new Error('unexpected docker ps payload');
    return list;
  }
  const conn = await resolveContext(ctx);
  const list = await getJson(conn, '/containers/json?all=1', timeout);
  if (!Array.isArray(list)) throw new Error('unexpected /containers/json payload');
  return list;
}

// Stop then remove ONE container, by name (docker's HTTP API accepts a name as the id). Best-effort
// and idempotent: a 404 (already gone) is success, so this can run after a partial teardown and
// finish it. `removeVolumes` deletes the container's ANONYMOUS volumes too — the reaper's per-xell
// db is anonymous, so its data goes with it (that is the point of decommissioning a db container).
// Returns { stopped, removed, alreadyGone } — never throws for a missing container. REFUSES an SSH
// context: a destructive action must never silently ride an unverified SSH dial.
export async function stopAndRemoveContainer(ctx, name, { removeVolumes = false, timeout = 30000 } = {}) {
  const conn = await resolveContext(ctx);   // resolveContext THROWS on ssh:// — a destructive action
  const enc = encodeURIComponent(name);
  let stopped = false, alreadyGone = false;
  const stop = await reqNoBody(conn, 'POST', `/containers/${enc}/stop?t=10`, timeout);
  if (stop.status === 404) alreadyGone = true;                 // nothing to stop
  else if (stop.status < 300 || stop.status === 304) stopped = stop.status !== 304; // 304 = already stopped
  const del = await reqNoBody(conn, 'DELETE',
    `/containers/${enc}?force=true&v=${removeVolumes ? 'true' : 'false'}`, timeout);
  const removed = del.status >= 200 && del.status < 300;
  if (del.status === 404) alreadyGone = true;
  return { stopped, removed, alreadyGone };
}

// Remove a docker NETWORK by name. Best-effort and idempotent like stopAndRemoveContainer: a 404
// (already gone) counts as done. Docker itself refuses to remove a network that still has attached
// containers ("has active endpoints") — that refusal is the authority on "in use", the same
// philosophy as removeImage's never-force, so the caller gets a verdict, never a throw, for an
// in-use network. REFUSES an SSH context (a destructive action, same as stopAndRemoveContainer).
export async function removeNetwork(ctx, name, { timeout = 15000 } = {}) {
  if (!name) return { removed: false, reason: 'no network name' };
  const conn = await resolveContext(ctx);   // resolveContext THROWS on ssh:// — a destructive action
  let r;
  try {
    r = await reqNoBody(conn, 'DELETE', `/networks/${encodeURIComponent(name)}`, timeout);
  } catch (e) {
    // reqNoBody rejects on 5xx — which is exactly how the daemon says "has active endpoints".
    // In-use is a verdict here, not a transport failure.
    return { removed: false, reason: e.message };
  }
  if (r.status >= 200 && r.status < 300) return { removed: true };
  if (r.status === 404) return { removed: false, alreadyGone: true };
  return { removed: false, reason: `HTTP ${r.status}: ${(r.body || '').slice(0, 200)}` };
}

// Remove an image by tag. NEVER force (see lib/images.js): force UNTAGS an image a container still
// uses, and the next restart of that environment then fails "image not found". Plain remove makes
// docker the judge — it refuses (409) while any container depends on it, which is the only
// authority that actually knows. A 404 (already gone) is success. Best-effort: returns a verdict.
// REFUSES an SSH context (a destructive action, same reasoning as stopAndRemoveContainer).
export async function removeImage(ctx, tag, { timeout = 60000 } = {}) {
  if (!tag) return { removed: false, reason: 'no image tag' };
  const conn = await resolveContext(ctx);   // resolveContext THROWS on ssh:// — a destructive action
  const r = await reqNoBody(conn, 'DELETE', `/images/${encodeURIComponent(tag)}`, timeout);
  if (r.status >= 200 && r.status < 300) return { removed: true };
  if (r.status === 404) return { removed: false, reason: 'already gone' };
  if (r.status === 409) return { removed: false, reason: 'still in use by a container' };
  return { removed: false, reason: `HTTP ${r.status}` };
}

// Every container on a context (running or not), keyed by name:
//   { state, xell, project, role }  — identity labels (spec §3.3), null when unlabeled.
// THROWS if the daemon is unreachable/errors. An empty Map means a genuinely empty daemon; the
// two are distinct here by construction, which is the whole point of this module.
// An SSH context (mardale-prod re-pointed at ssh.omnibiz.express) is dialed through the docker CLI.
export async function dockerPs(ctx, timeout = 15000) {
  const list = await getContainerList(ctx, timeout);
  if (list == null) throw new Error(`daemon on context '${ctx}' is unreachable`);
  const out = new Map();
  for (const c of list) {
    const name = (c.Names?.[0] || '').replace(/^\//, '');
    if (!name) continue;
    const L = c.Labels || {};
    out.set(name, {
      state: c.State,                       // running | exited | created | restarting | paused | dead
      xell: L['zeehive.xell'] || null,
      project: L['zeehive.project'] || null,
      role: L['zeehive.role'] || null,
    });
  }
  return out;
}

// Every container on a context, in the DETAIL discovery/adoption needs: what is running, its
// image, human status, PUBLISHED ports, compose project/service (when labeled) and any zeehive.*
// identity labels. Same read-only call as dockerPs — no write verb, nothing that could touch a
// production stack. THROWS on an unreachable/erroring daemon so the caller can say "context
// unreachable" instead of an ambiguous empty list. An SSH context is dialed through the docker CLI.
export async function listContainersDetailed(ctx, timeout = 15000) {
  const list = await getContainerList(ctx, timeout);
  if (list == null) throw new Error(`daemon on context '${ctx}' is unreachable`);
  const out = [];
  for (const c of list) {
    const name = (c.Names?.[0] || '').replace(/^\//, '');
    if (!name) continue;
    const L = c.Labels || {};
    // Published ports only (a PublicPort means it is reachable from the host); collapse the
    // duplicate IPv4/IPv6 rows docker emits per mapping.
    const seen = new Set();
    const ports = [];
    for (const p of c.Ports || []) {
      if (p.PublicPort == null) continue;
      const key = `${p.PublicPort}/${p.PrivatePort}/${p.Type}`;
      if (seen.has(key)) continue;
      seen.add(key);
      ports.push({ ip: p.IP || null, public: p.PublicPort, private: p.PrivatePort, type: p.Type });
    }
    const exposed = [...new Set((c.Ports || []).map((p) => p.PrivatePort).filter(Boolean))];
    out.push({
      name,
      image: c.Image || null,
      state: c.State || null,                 // running | exited | created | restarting | paused | dead
      status: c.Status || null,               // "Up 3 hours", "Exited (0) 2 days ago"
      ports,
      exposed_ports: exposed,
      compose_project: L['com.docker.compose.project'] || null,
      compose_service: L['com.docker.compose.service'] || null,
      zeehive_project: L['zeehive.project'] || null,
      zeehive_xell: L['zeehive.xell'] || null,
      zeehive_role: L['zeehive.role'] || null,
      labels_present: Object.keys(L).length > 0,
    });
  }
  return out;
}
