// Browser terminals, two doors on one websocket bridge:
//   /api/zees/:id/terminal       — SSH-PTY into a cxell zee (ssh2, tmux attach-or-create)
//   /api/containers/:id/terminal — a shell inside ANY modeled container, via the Docker Engine
//                                  API's exec+hijack (no sshd needed in the target)
// Both are pure JS — ssh2 for the cxell PTY, a hijacked HTTP connection for the exec TTY — so
// there is NO native PTY module and it behaves the same on the Windows host as anywhere.
//
// Wire protocol (identical on both doors): client→server is JSON control frames —
// {t:'i',d:<input>} keystrokes, {t:'r',cols,rows} resize. server→client is raw terminal bytes
// (straight into xterm.write).
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { createRequire } from 'node:module';
import { one } from '../db/pool.js';
import { ensureZeehiveKeypair, cxellSshDest } from './cxell.js';
import { resolveContext } from './docker.js';
import { resolveRealDbContainerCached } from './xell-db.js';
import { logline } from './logbus.js';

const require = createRequire(import.meta.url);
const { Client } = require('ssh2');
const { WebSocketServer } = require('ws');

export function attachTerminalBridge(server) {
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = req.url || '';
    const zee = url.match(/^\/api\/zees\/([0-9a-fA-F-]{36})\/terminal/);
    const cont = url.match(/^\/api\/containers\/([0-9a-fA-F-]{36})\/terminal/);
    if (!zee && !cont) return; // not ours — leave the socket for any other upgrade handler
    wss.handleUpgrade(req, socket, head, (ws) => (zee ? openTerminal(ws, zee[1]) : openContainerShell(ws, cont[1])));
  });
  return wss;
}

async function openTerminal(ws, zeeId) {
  const send = (s) => { if (ws.readyState === 1) ws.send(s); };
  const fail = (msg) => { send(`\r\n\x1b[31m[zeehive] ${msg}\x1b[0m\r\n`); try { ws.close(); } catch {} };

  let zee;
  try {
    zee = await one(`SELECT z.*, x.slug FROM zee z LEFT JOIN xell x ON x.id = z.xell_id WHERE z.id = $1`, [zeeId]);
  } catch (e) { return fail(`lookup failed: ${e.message}`); }
  if (!zee) return fail('no such zee');
  if (zee.viewer_kind !== 'ssh-terminal' || !zee.viewer_url) {
    return fail('this zee has no SSH terminal (only cxell zees do)');
  }

  let port;
  try { port = Number(new URL(zee.viewer_url).port); } catch { return fail('bad viewer url'); }
  const { privateKey } = ensureZeehiveKeypair();

  // First open lands the human in the zee's WORKFLOW; reconnects re-attach the live tmux session
  // (true async — disconnect and it keeps running). zee-attach.sh (baked into the cxell) does the
  // work: while the headless zee is still working it streams the transcript live, then hands off
  // to `claude --resume <sid>` for the full interactive session (all first-run prompts are
  // pre-answered by cxell-claude-seed.mjs, so it drops straight in). It ends in a login shell, so
  // the pane (and the zee's box) stays reachable if claude exits.
  const sid = (zee.claude_session_id || '').replace(/[^0-9a-fA-F-]/g, ''); // uuid only — it is shell-interpolated
  // `\; set -g mouse on` rides every attach: tmux runs fullscreen (alternate buffer), so the
  // browser xterm has NO scrollback of its own — without tmux mouse mode the wheel is dead air
  // ("i cant even seem to scroll it"). Applied per-attach so cxells older than the baked
  // .tmux.conf get it too.
  // window-size latest: size the tmux window to the MOST RECENT client, so a lingering
  // half-closed attach from an earlier open can never clamp a fresh, bigger terminal.
  const cmd = `tmux new -A -s zee -c /work/repo 'zee-attach.sh ${sid}' \\; set -g mouse on \\; set -g history-limit 50000 \\; set -g window-size latest`;

  const conn = new Client();
  // Listen for client frames from the FIRST moment. The browser sends its real size the instant
  // the socket opens, but the SSH exec (where the stream lives) is ready only hundreds of ms
  // later — a handler registered inside the exec callback silently DROPPED that resize, so the
  // PTY stayed at the hardcoded guess and tmux drew a 100×30 window in a full-size panel until
  // some later resize (e.g. the fullscreen toggle) got through. Queue what arrives early: the
  // last size seeds the PTY allocation itself, and queued keystrokes replay once the stream is up.
  let stream = null;
  let lastSize = { cols: 100, rows: 30 };   // fallback only — normally overwritten before exec
  const earlyInput = [];
  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.t === 'i') { if (stream) stream.write(msg.d); else earlyInput.push(msg.d); }
    else if (msg.t === 'r' && msg.cols && msg.rows) {
      lastSize = { cols: msg.cols, rows: msg.rows };
      if (stream) stream.setWindow(msg.rows, msg.cols, 0, 0);
    }
  });
  ws.on('close', () => { try { stream?.close(); } catch {} conn.end(); });
  conn.on('ready', () => {
    conn.exec(cmd, { pty: { term: 'xterm-256color', cols: lastSize.cols, rows: lastSize.rows } }, (err, s) => {
      if (err) return fail(`exec failed: ${err.message}`);
      stream = s;
      logline('cxell', `terminal attached to ${zee.slug} (${sid ? 'resume ' + sid.slice(0, 8) : 'shell'}, ${lastSize.cols}x${lastSize.rows})`);
      stream.setWindow(lastSize.rows, lastSize.cols, 0, 0);   // in case the size moved between exec and now
      for (const d of earlyInput.splice(0)) stream.write(d);
      stream.on('data', (d) => send(d));
      stream.stderr.on('data', (d) => send(d));
      stream.on('close', () => { try { ws.close(); } catch {} conn.end(); });
    });
  });
  conn.on('error', (e) => fail(`ssh error: ${e.message}`));
  // cxellSshDest: published loopback port in host mode; container name over zee-hive-net in
  // network mode (ZEEHIVE_CXELL_SSH=network). The human's 127.0.0.1 viewer door is unchanged.
  conn.connect({ ...cxellSshDest({ slug: zee.slug, sshPort: port }), username: 'zee', privateKey, readyTimeout: 8000 });
}

// ── container shell: websocket ↔ Docker Engine exec (hijacked TTY) ────────────────────────────
//
// Arbitrary containers have no sshd, so the ssh2 path above can't reach them. The Engine API can:
// create an exec with Tty:true, then POST /exec/:id/start with `Upgrade: tcp` — the daemon
// answers 101 and the SAME connection becomes a raw byte pipe to the shell (docker's "hijack").
// With a TTY the stream is unmultiplexed, so bytes go straight through in both directions —
// exactly the shape the xterm client already speaks. Resize is a separate POST /exec/:id/resize.

// One-shot JSON request to a daemon (create/resize). Tolerates an empty 2xx body (resize).
function dockerReq(conn, method, path, body, timeout = 15000) {
  return new Promise((res, rej) => {
    const payload = body == null ? null : JSON.stringify(body);
    const req = http.request({
      ...conn, method, path, timeout,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
    }, (r) => {
      let b = '';
      r.setEncoding('utf8');
      r.on('data', (d) => (b += d));
      r.on('end', () => {
        if (r.statusCode < 200 || r.statusCode >= 300) return rej(new Error(`HTTP ${r.statusCode}: ${b.slice(0, 300).trim()}`));
        if (!b.trim()) return res(null);
        try { res(JSON.parse(b)); } catch { res(null); }
      });
      r.on('error', rej);
    });
    req.on('error', rej);
    req.on('timeout', () => req.destroy(new Error(`timeout after ${timeout}ms`)));
    req.end(payload ?? undefined);
  });
}

// Where a container row's shell actually lands. Most rows ARE a docker container (db, and any
// compose-built server/webapp) → exec straight into it. But a PROCESS-ROLE server/webapp (spec
// §6.1, runner:process — Zeehive itself) has NO container of its own: start-xell-process.sh runs
// `npm run …` as a child of the QUEENZEE, inside the queenzee's container, cwd = the xell's
// worktree. So its shell is the queenzee's own container opened at that worktree — the exact place
// the process and its code live. Returns { ctx, name, workingDir, banner } or { error }.
async function resolveShellTarget(c) {
  const ctx = c.docker_ctx || 'default';
  if (c.role === 'db') {
    // db rows carry LOGICAL names (omnibiz_db_dev) while the daemon runs versioned ones — the
    // split-brain hazard xell-db.js documents. Same cached resolver, non-blocking after first hit.
    return { ctx, name: resolveRealDbContainerCached(ctx, c.name), workingDir: null, banner: null };
  }
  // server/webapp: is this project's role a process runner? Read it the same way build.js does.
  const proj = c.owner_xell_id
    ? await one(
        `SELECT p.manifest, x.slug, x.worktree_path
           FROM xell x JOIN project p ON p.id = x.project_id WHERE x.id = $1`, [c.owner_xell_id])
    : null;
  const runner = proj?.manifest?.roles?.[c.role]?.runner
    || proj?.manifest?.tiers?.spinoff?.runner
    || null;
  if (runner === 'process') {
    if (!proj?.worktree_path) return { error: `${c.name} is a process role but its worktree is unknown — cannot open a shell` };
    // The queenzee's own container, on the local daemon. hostname() is our container id, which
    // docker accepts as a reference. If we're NOT containerized (host era) this 404s and the
    // caller's message explains the process runs on the host.
    return {
      ctx: 'default', name: hostname(), workingDir: proj.worktree_path, selfContainer: true,
      banner: `\x1b[2m[zeehive] ${c.role} of ${proj.slug} is a process inside the queenzee — shell opened at its worktree\x1b[0m\r\n`,
    };
  }
  // a real compose-built server/webapp container — its name is already the docker name
  return { ctx, name: c.name, workingDir: null, banner: null };
}

async function openContainerShell(ws, containerId) {
  const send = (s) => { if (ws.readyState === 1) ws.send(s); };
  const fail = (msg) => { send(`\r\n\x1b[31m[zeehive] ${msg}\x1b[0m\r\n`); try { ws.close(); } catch {} };

  let c;
  try {
    c = await one(`SELECT id, name, role, tier, docker_ctx, owner_xell_id FROM container WHERE id = $1`, [containerId]);
  } catch (e) { return fail(`lookup failed: ${e.message}`); }
  if (!c) return fail('no such container');

  const target = await resolveShellTarget(c);
  if (target.error) return fail(target.error);
  const { ctx, name, workingDir, banner } = target;

  let conn;
  try { conn = await resolveContext(ctx); } catch (e) { return fail(`docker context '${ctx}': ${e.message}`); }

  // Docker NEVER kills an exec'd process when its attach connection drops (moby#9098) — an
  // interactive bash on a TTY just idles on forever, so every closed modal would leave one
  // behind in the target (seen live: a dozen strays after a test session). Tag the shell with
  // a unique env marker so teardown can find and kill exactly it, nothing else.
  const mark = 'ZEEHIVE_SHELL_' + randomUUID().replace(/-/g, '');
  let execId;
  try {
    const created = await dockerReq(conn, 'POST', `/containers/${encodeURIComponent(name)}/exec`, {
      AttachStdin: true, AttachStdout: true, AttachStderr: true, Tty: true,
      Env: ['TERM=xterm-256color', `ZEEHIVE_SHELL_MARK=${mark}`],
      ...(workingDir ? { WorkingDir: workingDir } : {}),
      // bash where the image has it (postgres, node), sh where it doesn't (alpine)
      Cmd: ['/bin/sh', '-c', 'command -v bash >/dev/null && exec bash || exec sh'],
    });
    execId = created?.Id;
    if (!execId) throw new Error('daemon returned no exec id');
  } catch (e) {
    // A 404 here means the container is modeled but not running — a buildable server/webapp that
    // was never built, one that died since the menu opened, or a process role on a host-era
    // queenzee (no container to enter). Say that, not the raw docker line.
    if (/HTTP 404/.test(e.message)) {
      if (target.selfContainer) return fail(`this ${c.role} runs as a process on the host, not in a container — no shell to open (containerize the queenzee to get one)`);
      return fail(`${name} is not running — nothing to shell into. `
        + `${c.role === 'db' ? 'The database container may be down.' : 'Build this container first (the hammer on its chip), then open a shell.'}`);
    }
    return fail(`cannot exec into ${name}: ${e.message}`);
  }

  // Reap the shell (and anything it spawned that inherited the marker, e.g. an open psql) via a
  // one-shot detached exec. -a: /proc/*/environ is NUL-separated, so grep must read it as text.
  // Pure POSIX sh + busybox-safe — no pgrep/pkill assumptions about the target image.
  let reaped = false;
  const reap = () => {
    if (reaped) return;
    reaped = true;
    const killCmd = 'for p in /proc/[0-9]*; do grep -qa ' + mark + ' "$p/environ" 2>/dev/null'
      + ' && kill -9 "${p##*/}" 2>/dev/null; done; true';
    dockerReq(conn, 'POST', `/containers/${encodeURIComponent(name)}/exec`, {
      AttachStdin: false, AttachStdout: false, AttachStderr: false, Tty: false,
      Cmd: ['/bin/sh', '-c', killCmd],
    }).then((r) => (r?.Id ? dockerReq(conn, 'POST', `/exec/${r.Id}/start`, { Detach: true, Tty: false }) : null))
      .catch(() => { /* container already gone — nothing left to reap */ });
  };

  // Same early-frame lesson as the SSH path above: the browser sends its real size the instant
  // the socket opens, before the hijack is up — queue what arrives early and replay it.
  let sock = null;
  let lastSize = { cols: 100, rows: 30 };   // fallback only — normally overwritten before start
  const earlyInput = [];
  const resize = () =>
    dockerReq(conn, 'POST', `/exec/${execId}/resize?h=${lastSize.rows}&w=${lastSize.cols}`).catch(() => { /* racing shell exit */ });
  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.t === 'i') { if (sock) sock.write(msg.d); else earlyInput.push(msg.d); }
    else if (msg.t === 'r' && msg.cols && msg.rows) {
      lastSize = { cols: msg.cols, rows: msg.rows };
      if (sock) resize();
    }
  });
  // Closing the modal tears the whole chain down: the hijacked socket if it's up, else the
  // still-pending start request — then the reaper kills the shell docker leaves behind.
  ws.on('close', () => { try { (sock || req).destroy(); } catch { /* already down */ } reap(); });

  const req = http.request({
    ...conn, method: 'POST', path: `/exec/${execId}/start`,
    headers: { 'Content-Type': 'application/json', Connection: 'Upgrade', Upgrade: 'tcp' },
  });
  req.on('upgrade', (_res, s, head) => {
    sock = s;
    logline('api', `container shell attached to ${name} (${ctx}, ${lastSize.cols}x${lastSize.rows})`);
    resize();   // TTY starts at the daemon's default size — set the real one before the prompt draws
    if (banner) send(banner);   // say when the shell is the queenzee-at-worktree, not a own container
    if (head?.length) send(head);
    for (const d of earlyInput.splice(0)) sock.write(d);
    sock.on('data', (d) => send(d));
    sock.on('close', () => { try { ws.close(); } catch { /* already closed */ } reap(); });
    sock.on('error', () => { try { ws.close(); } catch { /* already closed */ } });
  });
  // A daemon that refuses the hijack answers with a normal response (409 not running, 500) —
  // surface its body instead of hanging the modal at "connecting".
  req.on('response', (res) => {
    let b = '';
    res.setEncoding('utf8');
    res.on('data', (d) => (b += d));
    res.on('end', () => fail(`exec start failed: HTTP ${res.statusCode} ${b.slice(0, 300).trim()}`));
  });
  req.on('error', (e) => fail(`exec start failed: ${e.message}`));
  req.end(JSON.stringify({ Detach: false, Tty: true }));
}
