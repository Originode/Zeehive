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
import http from 'node:http';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { config } from '../config.js';

// Docker CLI stores each context at contexts/meta/<sha256(name)>/meta.json — the same lookup the
// CLI does for `--context <name>`, so we stay in sync with whatever `docker context` reports.
function metaPathFor(ctx) {
  const digest = createHash('sha256').update(ctx).digest('hex');
  return resolve(config.dockerConfigDir, 'contexts', 'meta', digest, 'meta.json');
}

// "tcp://10.1.0.18:2375"            -> { host, port }
// "unix:///var/run/docker.sock"     -> { socketPath: '/var/run/docker.sock' }
// "npipe:////./pipe/dockerEngine"   -> { socketPath: '\\.\pipe\dockerEngine' }
function parseDockerHost(hostStr) {
  if (!hostStr) throw new Error('context has no docker endpoint');
  const tcp = /^tcps?:\/\/([^:/]+):(\d+)/.exec(hostStr);
  if (tcp) return { host: tcp[1], port: Number(tcp[2]) };
  if (hostStr.startsWith('unix://')) return { socketPath: hostStr.slice('unix://'.length) };
  if (hostStr.startsWith('npipe://')) {
    return { socketPath: hostStr.slice('npipe://'.length).replace(/\//g, '\\') };
  }
  throw new Error(`unsupported docker endpoint: ${hostStr}`);
}

// Resolve a context name to connection options. DOCKER_HOST wins for the implicit contexts, as it
// does for the CLI; a named context is always read from disk.
export async function resolveContext(ctx) {
  if ((ctx === 'default' || !ctx) && process.env.DOCKER_HOST) {
    return parseDockerHost(process.env.DOCKER_HOST);
  }
  let raw;
  try {
    raw = await readFile(metaPathFor(ctx), 'utf8');
  } catch {
    throw new Error(`unknown docker context '${ctx}' (no meta.json under ${config.dockerConfigDir})`);
  }
  let meta;
  try { meta = JSON.parse(raw); } catch (e) { throw new Error(`corrupt context meta for '${ctx}': ${e.message}`); }
  return parseDockerHost(meta?.Endpoints?.docker?.Host);
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

// Stop then remove ONE container, by name (docker's HTTP API accepts a name as the id). Best-effort
// and idempotent: a 404 (already gone) is success, so this can run after a partial teardown and
// finish it. `removeVolumes` deletes the container's ANONYMOUS volumes too — the reaper's per-xell
// db is anonymous, so its data goes with it (that is the point of decommissioning a db container).
// Returns { stopped, removed, alreadyGone } — never throws for a missing container.
export async function stopAndRemoveContainer(ctx, name, { removeVolumes = false, timeout = 30000 } = {}) {
  const conn = await resolveContext(ctx);
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

// Remove an image by tag. NEVER force (see lib/images.js): force UNTAGS an image a container still
// uses, and the next restart of that environment then fails "image not found". Plain remove makes
// docker the judge — it refuses (409) while any container depends on it, which is the only
// authority that actually knows. A 404 (already gone) is success. Best-effort: returns a verdict.
export async function removeImage(ctx, tag, { timeout = 60000 } = {}) {
  if (!tag) return { removed: false, reason: 'no image tag' };
  const conn = await resolveContext(ctx);
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
export async function dockerPs(ctx, timeout = 15000) {
  const conn = await resolveContext(ctx);
  const list = await getJson(conn, '/containers/json?all=1', timeout);
  if (!Array.isArray(list)) throw new Error('unexpected /containers/json payload');
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
