// Read-only filesystem access INTO a fleet container, over the same docker-exec door the container
// terminal bridge uses (terminal-bridge.js). It powers the in-browser file explorer that rides
// alongside the container shell terminal: list a directory, read a text file. There is NO write
// path here — a human watching a container should be able to SEE what is in it, not edit it.
// Everything is one short-lived docker exec per request (the terminal keeps the long-lived TTY;
// this stays out of its way).
import http from 'node:http';
import { one } from '../db/pool.js';
import { resolveContext } from './docker.js';
import { resolveShellTarget, dockerReq } from './terminal-bridge.js';
import { buildListScript, parseListOutput, buildReadScript, parseReadResult } from './cxell-fs.js';

// The natural explorer root for a real container — the container's filesystem root. A PROCESS-ROLE
// server/webapp (runner:process) has no container of its own: its shell is the queenzee at the
// worktree, so for that case the root is the worktree (resolveShellTarget's workingDir).
export const CONTAINER_ROOT = '/';

// Pin a path into the explorer's tree, collapsing . and .. so a pasted path can't wander outside a
// sane root. Mirrors resolveCxellPath but for a container: a relative path joins under the root, an
// absolute path is kept, and every segment is resolved so no `..` survives.
export function resolveContainerPath(p, root = CONTAINER_ROOT) {
  const raw = String(p ?? '').trim();
  if (!raw) return root;
  let abs = raw.startsWith('/') ? raw : `${root}/${raw}`;
  const parts = [];
  for (const seg of abs.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { if (parts.length) parts.pop(); continue; }
    parts.push(seg);
  }
  return '/' + parts.join('/');
}

// The docker raw-stream framing: a non-TTY exec's stdout/stderr come back multiplexed as
// [8-byte header][payload] frames — header[0] is the stream (1=stdout, 2=stderr) and header[4:8]
// is the big-endian payload size. With Tty:true (the shell) there is no multiplexing; a capture
// must ask for Tty:false and demux here.
export function demuxDockerStream(buf) {
  const out = []; const err = [];
  let off = 0;
  while (off + 8 <= buf.length) {
    const stream = buf[off];
    const size = buf.readUInt32BE(off + 4);
    off += 8;
    if (off + size > buf.length) break; // truncated final frame — keep what is whole
    const chunk = buf.subarray(off, off + size);
    if (stream === 1) out.push(chunk);
    else if (stream === 2) err.push(chunk);
    off += size;
  }
  return { out: Buffer.concat(out), err: Buffer.concat(err) };
}

// Run a shell script inside the target and capture stdout/stderr, non-TTY. The script travels in
// the exec Cmd verbatim (no shell interpolation on our side), and the same base64-pipe technique
// cxell-fs uses is applied INSIDE the script for any path — so a hostile or spacey path cannot
// inject. Resolves { buf, stderr, code, truncated }.
function dockerExecCapture(conn, name, script, { workingDir, maxBytes = 3_000_000 } = {}) {
  return new Promise(async (resolve, reject) => {
    try {
      const created = await dockerReq(conn, 'POST', `/containers/${encodeURIComponent(name)}/exec`, {
        AttachStdin: false, AttachStdout: true, AttachStderr: true, Tty: false,
        Env: ['TERM=xterm-256color'],
        ...(workingDir ? { WorkingDir: workingDir } : {}),
        Cmd: ['/bin/sh', '-c', script],
      });
      const execId = created?.Id;
      if (!execId) throw new Error('daemon returned no exec id');
      const req = http.request({
        ...conn, method: 'POST', path: `/exec/${execId}/start`,
        headers: { 'Content-Type': 'application/json', Connection: 'Upgrade', Upgrade: 'tcp' },
      });
      const chunks = []; let len = 0, truncated = false;
      req.on('upgrade', (_res, s) => {
        s.on('data', (d) => {
          const b = Buffer.from(d);
          if (len < maxBytes) { chunks.push(b); len += b.length; } else truncated = true;
        });
        s.on('error', reject);
        s.on('close', async () => {
          // Exit code comes from a separate inspect, not the hijacked stream. Best-effort: the
          // container may have gone away, in which case the output we already captured is still ours.
          let code = 0;
          try { const j = await dockerReq(conn, 'GET', `/exec/${execId}/json`); code = j?.ExitCode ?? 0; }
          catch { /* container went away mid-read */ }
          const { out, err } = demuxDockerStream(Buffer.concat(chunks));
          resolve({ buf: out, stderr: err.toString('utf8'), code, truncated });
        });
      });
      // A daemon that refuses the hijack answers with a normal response — surface it, not a hang.
      req.on('response', (res) => {
        let b = ''; res.setEncoding('utf8'); res.on('data', (d) => (b += d));
        res.on('end', () => reject(new Error(`exec start failed: HTTP ${res.statusCode} ${b.slice(0, 300).trim()}`)));
      });
      req.on('error', reject);
      req.end(JSON.stringify({ Detach: false, Tty: false }));
    } catch (e) { reject(e); }
  });
}

// Resolve a container row to a docker target, the same way the shell does (mirrors
// terminal-bridge.openContainerShell's first half). Returns { ctx, name, workingDir } or throws.
async function shellTargetFor(containerId) {
  const c = await one(
    `SELECT id, name, role, tier, docker_ctx, owner_xell_id FROM container WHERE id = $1`,
    [containerId]);
  if (!c) throw Object.assign(new Error('no such container'), { status: 404 });
  const target = await resolveShellTarget(c);
  if (target.error) throw Object.assign(new Error(target.error), { status: 400 });
  let conn;
  try { conn = await resolveContext(target.ctx); }
  catch (e) { throw new Error(`docker context '${target.ctx}': ${e.message}`); }
  return { conn, name: target.name, workingDir: target.workingDir || null };
}

// List a directory inside the container (one short-lived docker exec).
export async function listContainerDir(containerId, path) {
  const { conn, name, workingDir } = await shellTargetFor(containerId);
  const root = workingDir || CONTAINER_ROOT;
  const dir = resolveContainerPath(path, root);
  const script = buildListScript(dir);
  const { buf, stderr, code } = await dockerExecCapture(conn, name, script, { workingDir });
  if (code === 4 || /__NOTDIR__/.test(stderr)) throw Object.assign(new Error(`not a directory: ${dir}`), { status: 400 });
  if (code && code !== 0 && !buf.length) throw new Error(stderr.trim() || `list failed (exit ${code})`);
  return parseListOutput(buf, dir, root);
}

// Read a text file inside the container (one short-lived docker exec), capped.
export async function readContainerFile(containerId, path, maxBytes = 512_000) {
  const { conn, name, workingDir } = await shellTargetFor(containerId);
  const root = workingDir || CONTAINER_ROOT;
  const file = resolveContainerPath(path, root);
  const script = buildReadScript(file, maxBytes);
  const { buf, stderr, code, truncated } = await dockerExecCapture(conn, name, script, { workingDir, maxBytes: maxBytes + 4096 });
  if (code === 6 || /__ISDIR__/.test(stderr)) throw Object.assign(new Error(`${file} is a directory`), { status: 400 });
  if (code === 7 || /__NOFILE__/.test(stderr)) throw Object.assign(new Error(`no such file: ${file}`), { status: 404 });
  return parseReadResult(buf, stderr, file, truncated);
}
