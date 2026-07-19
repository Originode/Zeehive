// Browser terminal for a caged zee: a websocket ↔ SSH-PTY bridge. The dashboard's xterm connects
// to /api/zees/:id/terminal; this opens an SSH session into that zee's cage (with the fleet key),
// requests a PTY running `tmux new -A -s zee` (attach-or-create → true async: disconnect and the
// session keeps running), and pipes bytes both ways. Pure JS (ssh2) — no native PTY module, so it
// behaves the same on the Windows host as anywhere.
//
// Wire protocol: client→server is JSON control frames — {t:'i',d:<input>} keystrokes,
// {t:'r',cols,rows} resize. server→client is raw terminal bytes (straight into xterm.write).
import { createRequire } from 'node:module';
import { one } from '../db/pool.js';
import { ensureZeehiveKeypair } from './cage.js';
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
    return fail('this zee has no SSH terminal (only caged zees do)');
  }

  let port;
  try { port = Number(new URL(zee.viewer_url).port); } catch { return fail('bad viewer url'); }
  const { privateKey } = ensureZeehiveKeypair();

  // First open starts the resumed conversation; reconnects re-attach the live tmux session. If
  // claude exits, drop to a login shell so the pane (and the zee's box) stays reachable.
  const sid = zee.claude_session_id;
  const inner = sid
    ? `claude --resume ${sid} 2>/dev/null || claude; exec bash -l`
    : `exec bash -l`;
  const cmd = `tmux new -A -s zee -c /work/repo '${inner}'`;

  const conn = new Client();
  conn.on('ready', () => {
    conn.exec(cmd, { pty: { term: 'xterm-256color', cols: 100, rows: 30 } }, (err, stream) => {
      if (err) return fail(`exec failed: ${err.message}`);
      logline('cage', `terminal attached to ${zee.slug} (${sid ? 'resume ' + sid.slice(0, 8) : 'shell'})`);
      stream.on('data', (d) => send(d));
      stream.stderr.on('data', (d) => send(d));
      stream.on('close', () => { try { ws.close(); } catch {} conn.end(); });
      ws.on('message', (raw) => {
        let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (msg.t === 'i') stream.write(msg.d);
        else if (msg.t === 'r' && msg.cols && msg.rows) stream.setWindow(msg.rows, msg.cols, 0, 0);
      });
      ws.on('close', () => { try { stream.close(); } catch {} conn.end(); });
    });
  });
  conn.on('error', (e) => fail(`ssh error: ${e.message}`));
  conn.connect({ host: '127.0.0.1', port, username: 'zee', privateKey, readyTimeout: 8000 });
}
