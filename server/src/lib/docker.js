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
