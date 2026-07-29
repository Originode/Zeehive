// TERMINAL VIEW-CHANNEL test — the ✱/⚒ chips over the REAL websocket bridge.
//
// terminal-feed-filter.test.mjs pins the pieces (the command, the parse, the wiring) and
// zee-live-view.test.mjs pins the far end (the renderer repainting). This one runs the MIDDLE for
// real: a browser-shaped websocket client → attachTerminalBridge → ssh2 → a throwaway in-process
// sshd standing in for the cxell, exactly the seam nudge-sendkeys.test.mjs uses. What it proves:
//
//   1. on attach the bridge POLLS the cage (read-only — it must not write a view nobody chose) and
//      answers the browser with a NUL-tagged control frame, so reopening a terminal shows the view
//      actually in force;
//   2. a chip click writes the two-boolean view file — and does it on a SECOND exec channel, with
//      not one byte entering the PTY (the pane belongs to `claude --resume` after the turn: a
//      "filter" that typed into it would land in the zee's prompt);
//   3. terminal output still arrives as binary and is never mistaken for a control frame.
//
// Needs DATABASE_URL (the meta DB) for a throwaway project/xell/zee, which it deletes in a finally.
import { createRequire } from 'node:module';
import http from 'node:http';
import pg from 'pg';

const require = createRequire(import.meta.url);
const { Server, utils } = require('ssh2');
const WebSocket = require('ws');

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { ensureZeehiveKeypair } = await import('../server/src/lib/cxell.js');
const { attachTerminalBridge, CTRL_PREFIX, ZEE_LIVE_VIEW_FILE } = await import('../server/src/lib/terminal-bridge.js');

// ── the stand-in cxell: authorizes the fleet key, records every exec, answers the view probe ──
const { publicKey } = ensureZeehiveKeypair();
const allowedPub = utils.parseKey(publicKey);
const execs = [];        // { cmd, pty } in the order the bridge ran them
let ptyBytes = null;     // write into the PTY channel (terminal output)

const sshd = new Server({ hostKeys: [utils.generateKeyPairSync('ed25519').private] }, (client) => {
  client.on('authentication', (ctx) => {
    if (ctx.method === 'publickey' && ctx.key.algo === allowedPub.type
        && Buffer.compare(ctx.key.data, allowedPub.getPublicSSH()) === 0) {
      if (ctx.signature) return allowedPub.verify(ctx.blob, ctx.signature, ctx.hashAlgo) ? ctx.accept() : ctx.reject();
      return ctx.accept();
    }
    if (ctx.method === 'none') return ctx.reject(['publickey']);
    return ctx.reject();
  });
  client.on('ready', () => client.on('session', (accept) => {
    const session = accept();
    let pty = false;
    session.on('pty', (a, _r, _info) => { pty = true; a && a(); });
    session.on('exec', (accept2, _reject, info) => {
      execs.push({ cmd: info.command, pty });
      const stream = accept2();
      if (/zee-live/.test(info.command)) {
        // the view probe: answer like a cxell would — a running feed and the file it holds
        stream.write(`ZH-LIVE\n{"thinking":false,"moves":true}\n`);
        stream.exit(0); stream.end();
      } else {
        // the tmux PTY: emit terminal output and stay open, like the real pane
        ptyBytes = () => stream.write('\x1b[32mzee@cxell\x1b[0m $ ');
        ptyBytes();
      }
    });
  }));
});
await new Promise((r) => sshd.listen(0, '127.0.0.1', r));
const sshPort = sshd.address().port;

// ── a throwaway project → xource → xell → zee pointing at that sshd ──
const db = new pg.Client({ connectionString: url });
await db.connect();
const tag = `zt-term-${Date.now()}`;
let projId = null;
let wsClient = null;
let httpSrv = null;

try {
  projId = (await db.query(
    `INSERT INTO project (name, repo_root, main_branch) VALUES ($1,$2,'master') RETURNING id`,
    [tag, `/tmp/${tag}`])).rows[0].id;
  const xourceId = (await db.query(
    `INSERT INTO xource (project_id, ref) VALUES ($1,'master') RETURNING id`, [projId])).rows[0].id;
  const xellId = (await db.query(
    `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status, is_pooled)
       VALUES ($1,$2,$3,'spinoff/zt-term',$4,'working',false) RETURNING id`,
    [projId, xourceId, tag, `/tmp/${tag}/wt`])).rows[0].id;
  const zeeId = (await db.query(
    `INSERT INTO zee (xell_id, attach_mode, status, viewer_kind, viewer_url, claude_session_id)
       VALUES ($1,'headless-spawn','working','ssh-terminal',$2,$3) RETURNING id`,
    [xellId, `ssh://zee@127.0.0.1:${sshPort}`, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'])).rows[0].id;

  // ── the bridge, on a real http server ──
  httpSrv = http.createServer((_q, s) => s.end());
  attachTerminalBridge(httpSrv);
  await new Promise((r) => httpSrv.listen(0, '127.0.0.1', r));
  const port = httpSrv.address().port;

  const ctrl = [];    // control frames the browser received
  const bytes = [];   // terminal output the browser received
  wsClient = new WebSocket(`ws://127.0.0.1:${port}/api/zees/${zeeId}/terminal`);
  wsClient.on('message', (data, isBinary) => {
    const s = data.toString();
    if (!isBinary && s.startsWith(CTRL_PREFIX)) { ctrl.push(JSON.parse(s.slice(CTRL_PREFIX.length))); return; }
    bytes.push({ s, isBinary });
  });
  await new Promise((r, j) => { wsClient.on('open', r); wsClient.on('error', j); });
  wsClient.send(JSON.stringify({ t: 'r', cols: 120, rows: 40 }));

  // ── 1. attach POLLS the cage ──────────────────────────────────────────────────────────────
  console.log('\n── on attach: the chips are seeded from the cxell, read-only ──');
  for (let i = 0; i < 60 && ctrl.length < 1; i++) await sleep(50);
  ok(ctrl.length >= 1, 'the browser is sent a view frame without asking');
  ok(ctrl[0]?.t === 'v' && ctrl[0].thinking === false && ctrl[0].moves === true && ctrl[0].live === true,
     `and it carries what the cage actually holds (${JSON.stringify(ctrl[0])})`);
  const probe = execs.find((e) => /zee-live/.test(e.cmd));
  ok(!!probe, 'the bridge ran a view probe in the cxell');
  ok(!probe.cmd.includes('printf'), 'which WRITES NOTHING — attaching must not choose a view for anyone');
  ok(probe.pty === false, 'on a plain exec channel, with no PTY of its own');

  // ── 2. a chip click ───────────────────────────────────────────────────────────────────────
  console.log('\n── a chip click writes the view, on its own channel ──');
  const ptyExecs = () => execs.filter((e) => /tmux/.test(e.cmd)).length;
  for (let i = 0; i < 60 && ptyExecs() === 0; i++) await sleep(50);   // let the PTY session settle first
  const ptyBefore = ptyExecs();
  const written = () => execs.find((e) => /printf/.test(e.cmd));
  wsClient.send(JSON.stringify({ t: 'v', thinking: false, moves: false }));
  for (let i = 0; i < 60 && !written(); i++) await sleep(50);
  const wrote = written() || { cmd: '(no write exec ever ran)', pty: null };
  ok(/printf/.test(wrote.cmd) && wrote.cmd.includes(`mv -f ${ZEE_LIVE_VIEW_FILE}.tmp ${ZEE_LIVE_VIEW_FILE}`),
     'the click writes the view file in the cxell');
  ok(wrote.cmd.includes('{"thinking":false,"moves":false}'), 'with exactly the view the operator chose');
  ok(wrote.pty === false, 'again on a SECOND channel — the PTY never sees it');
  ok(ptyExecs() === ptyBefore, 'and no new terminal session was started (the pane is untouched)');
  for (let i = 0; i < 60 && ctrl.length < 2; i++) await sleep(50);
  ok(ctrl.length >= 2, 'the bridge answers the click with what the cage now reports');

  // ── 3. terminal output is still terminal output ───────────────────────────────────────────
  console.log('\n── terminal bytes and control frames cannot be confused ──');
  ptyBytes?.();
  for (let i = 0; i < 40 && bytes.length < 1; i++) await sleep(50);
  ok(bytes.length >= 1, 'the terminal stream still reaches the browser');
  ok(bytes.every((b) => b.isBinary), 'as BINARY frames — a text frame is by construction a control frame');
  ok(bytes.some((b) => b.s.includes('zee@cxell')), 'carrying the pane\'s actual output');
  ok(!bytes.some((b) => b.s.startsWith(CTRL_PREFIX)), 'and no control frame was written into the terminal');
} finally {
  try { wsClient?.close(); } catch { /* already closed */ }
  await sleep(150);
  try { httpSrv?.close(); } catch { /* not listening */ }
  try { sshd.close(); } catch { /* not listening */ }
  if (projId) await db.query(`DELETE FROM project WHERE id = $1`, [projId]);   // cascades the xell + zee
  await db.end();
}

console.log(failures === 0 ? '\nALL PASSED ✓' : `\n${failures} FAILURE(S) ✗`);
process.exit(failures ? 1 : 0);
