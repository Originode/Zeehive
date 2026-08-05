// Read-only filesystem access INTO a cxell zee, over the SAME ssh2 door the terminal bridge uses
// (ensureZeehiveKeypair + cxellSshDest). It powers the in-browser file explorer that rides
// alongside the zee terminal: list a directory, read a text file. There is NO write path here —
// a human watching a zee should be able to SEE what the zee touched, not edit it out from under
// the zee. Everything is one short-lived SSH connection per request (the terminal keeps the long
// lived tmux one; this stays out of its way).
import { createRequire } from 'node:module';
import { one } from '../db/pool.js';
import { ensureZeehiveKeypair, cxellSshDest } from './cxell.js';

const require = createRequire(import.meta.url);
const { Client } = require('ssh2');

// The worktree every cxell zee works in — the natural root for the explorer, and what a bare
// (pathless) request lands on. Matches the `-c /work/repo` the terminal attach uses.
export const CXELL_ROOT = '/work/repo';

// A path a zee "presented" in the terminal is usually relative to the worktree ("web/src/App.jsx")
// or an absolute cxell path ("/work/repo/…"). Anything else (a "../" escape, a "~") we pin back to
// the root rather than let it wander the container filesystem.
export function resolveCxellPath(p) {
  const raw = String(p ?? '').trim();
  if (!raw) return CXELL_ROOT;
  let abs = raw.startsWith('/') ? raw : `${CXELL_ROOT}/${raw}`;
  // collapse . and .. segments so the explorer can't be walked out of a sane tree by a pasted path
  const parts = [];
  for (const seg of abs.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { if (parts.length) parts.pop(); continue; }
    parts.push(seg);
  }
  return '/' + parts.join('/');
}

async function zeeSshDest(zeeId) {
  const zee = await one(
    `SELECT z.viewer_kind, z.viewer_url, x.slug FROM zee z LEFT JOIN xell x ON x.id = z.xell_id WHERE z.id = $1`,
    [zeeId]);
  if (!zee) throw new Error('no such zee');
  if (zee.viewer_kind !== 'ssh-terminal' || !zee.viewer_url) throw new Error('this zee has no cxell filesystem (only cxell zees do)');
  let port;
  try { port = Number(new URL(zee.viewer_url).port); } catch { throw new Error('bad viewer url'); }
  const { privateKey } = ensureZeehiveKeypair();
  return { ...cxellSshDest({ slug: zee.slug, sshPort: port }), username: 'zee', privateKey, readyTimeout: 8000 };
}

// One connect → run → disconnect. Keeps no state between requests.
function withConn(dest, fn) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let done = false;
    const finish = (err, val) => { if (done) return; done = true; try { conn.end(); } catch {} err ? reject(err) : resolve(val); };
    conn.on('ready', () => Promise.resolve(fn(conn)).then((v) => finish(null, v), (e) => finish(e)));
    conn.on('error', (e) => finish(e));
    conn.connect(dest);
  });
}

// Run a SCRIPT in the cxell. Critical: ssh2's exec hands the command to the zee's LOGIN shell,
// which parses it before our /bin/sh ever runs — so any `$var` or quote in a naively-wrapped
// command is expanded/mangled by that outer shell (seen live: `[ ! -d "$p" ]` had `$p` eaten by
// the outer bash, leaving `[ ! -d "" ]`, so EVERY path came back "not a directory"). Ship the
// whole script base64-encoded and decode→pipe it into sh: the outer shell then only ever sees
// `echo <b64> | base64 -d | /bin/sh`, which has no metacharacters to misinterpret.
function execCapture(conn, script, maxBytes = 3_000_000) {
  const cmd = `echo ${Buffer.from(script, 'utf8').toString('base64')} | base64 -d | /bin/sh`;
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      const chunks = []; let len = 0, truncated = false; let errb = ''; let code = 0;
      stream.on('data', (d) => {
        if (len < maxBytes) { chunks.push(d); len += d.length; } else truncated = true;
      });
      stream.stderr.on('data', (d) => { errb += d.toString(); });
      stream.on('exit', (c) => { code = c ?? 0; });
      stream.on('close', () => resolve({ buf: Buffer.concat(chunks), stderr: errb, code, truncated }));
    });
  });
}

// base64 the path and decode it remotely — the base64 alphabet is shell-safe, so no pasted path
// (spaces, quotes, $(...)) can inject into the command we run in the cxell.
const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');

// ── the remote commands + their parsers, factored out so a test can run the EXACT script against a
// real shell + temp dir (no ssh, no DB) and prove the parse round-trips. Sentinels (__NOTDIR__ …)
// distinguish "path is wrong" from "shell broke" without a second round-trip. ──────────────────────

// List a directory: dirs first, then files, each with a byte size, one tab-separated line each.
export function buildListScript(dir) {
  return (
    `p=$(printf %s '${b64(dir)}' | base64 -d); ` +
    `if [ ! -d "$p" ]; then echo "__NOTDIR__" >&2; exit 4; fi; ` +
    `cd "$p" || exit 5; ` +
    `for f in * .*; do ` +
    `  [ -e "$f" ] || [ -L "$f" ] || continue; ` +
    `  case "$f" in .|..) continue;; esac; ` +
    `  if [ -d "$f" ]; then t=d; s=0; else t=f; s=$(stat -c %s "$f" 2>/dev/null || echo 0); fi; ` +
    `  printf '%s\\t%s\\t%s\\n' "$t" "$s" "$f"; ` +
    `done`);
}

// Turn the tab-separated `type<TAB>size<TAB>name` lines into sorted {name,type,size} entries.
// `root` is the explorer's home — the directory the ⌂ button and a bare request land on, and the
// one dir whose parent is null. Defaults to the cxell worktree (the zee door); the container door
// passes its own root (the container filesystem root, or a process-role worktree).
export function parseListOutput(buf, dir, root = CXELL_ROOT) {
  const entries = [];
  for (const line of buf.toString('utf8').split('\n')) {
    if (!line) continue;
    const i = line.indexOf('\t'); const j = line.indexOf('\t', i + 1);
    if (i < 0 || j < 0) continue;
    const type = line.slice(0, i) === 'd' ? 'dir' : 'file';
    const size = Number(line.slice(i + 1, j)) || 0;
    const name = line.slice(j + 1);
    entries.push({ name, type, size });
  }
  entries.sort((a, b) =>
    a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name, undefined, { numeric: true }));
  const parent = dir === root ? null : dir.slice(0, dir.lastIndexOf('/')) || '/';
  return { path: dir, parent, root, entries };
}

// Read a text file, capped. Emits the true size on stderr so we can flag truncation even though
// stdout is clipped by `head`.
export function buildReadScript(file, maxBytes) {
  return (
    `p=$(printf %s '${b64(file)}' | base64 -d); ` +
    `if [ -d "$p" ]; then echo "__ISDIR__" >&2; exit 6; fi; ` +
    `if [ ! -f "$p" ]; then echo "__NOFILE__" >&2; exit 7; fi; ` +
    `sz=$(stat -c %s "$p" 2>/dev/null || echo 0); echo "__SIZE__ $sz" >&2; ` +
    `head -c ${maxBytes} -- "$p"`);
}

// Shape the read result: refuse obvious binaries (a NUL byte in the head) so the viewer never
// tries to paint a megabyte of gibberish.
export function parseReadResult(buf, stderr, file, truncated = false) {
  const sizeMatch = stderr.match(/__SIZE__ (\d+)/);
  const size = sizeMatch ? Number(sizeMatch[1]) : buf.length;
  const isBinary = buf.subarray(0, 8000).includes(0);
  return {
    path: file,
    size,
    binary: isBinary,
    truncated: truncated || (size > buf.length),
    content: isBinary ? '' : buf.toString('utf8'),
  };
}

// List a directory inside the cxell (one short-lived ssh exec).
export async function listCxellDir(zeeId, path) {
  const dir = resolveCxellPath(path);
  const dest = await zeeSshDest(zeeId);
  const script = buildListScript(dir);
  const { buf, stderr, code } = await withConn(dest, (c) => execCapture(c, script));
  if (code === 4 || /__NOTDIR__/.test(stderr)) throw Object.assign(new Error(`not a directory: ${dir}`), { status: 400 });
  if (code && code !== 0 && !buf.length) throw new Error(stderr.trim() || `list failed (exit ${code})`);
  return parseListOutput(buf, dir);
}

// Read a text file inside the cxell.
export async function readCxellFile(zeeId, path, maxBytes = 512_000) {
  const file = resolveCxellPath(path);
  const dest = await zeeSshDest(zeeId);
  const script = buildReadScript(file, maxBytes);
  const { buf, stderr, code, truncated } = await withConn(dest, (c) => execCapture(c, script, maxBytes + 4096));
  if (code === 6 || /__ISDIR__/.test(stderr)) throw Object.assign(new Error(`${file} is a directory`), { status: 400 });
  if (code === 7 || /__NOFILE__/.test(stderr)) throw Object.assign(new Error(`no such file: ${file}`), { status: 404 });
  return parseReadResult(buf, stderr, file, truncated);
}
