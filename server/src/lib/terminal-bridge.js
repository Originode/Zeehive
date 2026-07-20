// Browser terminal for a cxell zee: a websocket ↔ SSH-PTY bridge. The dashboard's xterm connects
// to /api/zees/:id/terminal; this opens an SSH session into that zee's cxell (with the fleet key),
// requests a PTY running `tmux new -A -s zee` (attach-or-create → true async: disconnect and the
// session keeps running), and pipes bytes both ways. Pure JS (ssh2) — no native PTY module, so it
// behaves the same on the Windows host as anywhere.
//
// Wire protocol: client→server is JSON control frames — {t:'i',d:<input>} keystrokes,
// {t:'r',cols,rows} resize. server→client is raw terminal bytes (straight into xterm.write).
import { createRequire } from 'node:module';
import { one } from '../db/pool.js';
import { ensureZeehiveKeypair, cxellSshDest } from './cxell.js';
import { logline } from './logbus.js';

const require = createRequire(import.meta.url);
const { Client } = require('ssh2');
const { WebSocketServer } = require('ws');

export function attachTerminalBridge(server) {
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const m = (req.url || '').match(/^\/api\/zees\/([0-9a-fA-F-]{36})\/terminal/);
    if (!m) return; // not ours — leave the socket for any other upgrade handler
    wss.handleUpgrade(req, socket, head, (ws) => openTerminal(ws, m[1]));
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
