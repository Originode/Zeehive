// CXELL TALK test — "let me converse with zee managers in the terminal of their xell… when I said
// read-only I didn't mean the TERMINAL was read-only".
//
// The cxell pane has two owners and only one of them can hear you:
//   • between turns  → `claude --resume` holds it, and typing IS the conversation;
//   • DURING a turn  → zee-attach.sh's transcript feed holds it. That feed renders and reads
//     nothing, so every keystroke — a human's in the browser, or the queenzee's send-keys for a
//     📨 message / 💬 nudge / a manager's `zee say` — was swallowed, while the console reported
//     "typed into its live session". A manager zee, whose whole job is conversation, was
//     unreachable in the one place a human goes to talk to it.
//
// What must now hold, and is asserted here:
//   1. the queenzee DECIDES from the cage's real state — type, or queue a file in the talk queue;
//   2. its probe cannot match its own command line (it is interpolated into that command, and a
//      self-match makes every cxell look mid-turn forever);
//   3. the two probes — the queenzee's and zee-attach.sh's — are the SAME pattern;
//   4. zee-attach.sh DRAINS that queue into the interactive session the moment the turn ends;
//   5. sendKeysToCxellZee reports which of the two happened, so a caller can stop promising
//      delivery it did not get.
//
// (1)–(3) are pure/static. (4) runs the REAL drain_talk out of the real script against a REAL tmux
// session, and (5) runs the REAL sendKeysToCxellZee against a throwaway in-process sshd — the same
// seam nudge-sendkeys.test.mjs uses. The tmux half skips itself where there is no tmux (Windows
// host), rather than failing for the wrong reason.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);
const { Server, utils } = require('ssh2');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

let failures = 0;
let skipped = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };
const skip = (msg) => { console.log(`  – SKIP ${msg}`); skipped++; };

const { cxellTalkCommand, CXELL_TALK_DIR, sendKeysToCxellZee, ensureZeehiveKeypair,
        installZeeAttachIntoCxell, zeeAttachInstallCommands, ZEE_ATTACH_DEST, zeeAttachSourcePath }
  = await import('../server/src/lib/cxell.js');
const { HEADLESS_PROC_PATTERN } = await import('../server/src/lib/cxell-runtimes.js');

const SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

// ── 1. the command: one decision, both branches ───────────────────────────────────────────────
console.log('\n── cxellTalkCommand: type when the session owns the pane, QUEUE when the feed does ──');
const cmd = cxellTalkCommand({ text: "what's the crew doing?", sessionId: SID });

ok(cmd.includes('tmux has-session -t zee'), 'attaches-or-creates the pane session (never a rival headless run)');
ok(cmd.includes(`zee-attach.sh ${SID}`),
   'creating it runs the SAME zee-attach.sh the terminal bridge does — which is what will drain the queue');
ok(/if pgrep -f .*; then[\s\S]*__ZEE_TALK_QUEUED__[\s\S]*else[\s\S]*send-keys[\s\S]*__ZEE_KEYS_SENT__/.test(cmd),
   'the two branches are a single `if`: queue while a turn/feed holds the pane, type otherwise');
ok(cmd.includes(`mkdir -p ${CXELL_TALK_DIR}`) && cmd.includes('"$f.part"') && cmd.includes('mv -f "$f.part"'),
   'the queued message is written to a .part and RENAMED — the drainer can never read half a message');
ok(cmd.includes("tmux send-keys -t zee -l 'what'\\''s the crew doing?'"),
   "the typed branch sends the LITERAL text (send-keys -l), apostrophe and all — no shell, no key-name reading");
ok(/sleep 0\.2; tmux send-keys -t zee Enter/.test(cmd), 'and presses Enter, so the agent actually receives it');
ok(cmd.includes('[ "$started" = 1 ] && sleep 6'),
   'it only waits for a TUI it just started — an already-open terminal takes the keys with no added latency');
ok(!/(^|[;&|]\s*)claude /.test(cmd),
   'it never forks a headless `claude` of its own (the old, invisible nudge)');
ok(cxellTalkCommand({ text: 'x', sessionId: '; rm -rf /' }).includes("zee-attach.sh ;") === false,
   'the session id is reduced to uuid characters before it is interpolated');
ok(!cxellTalkCommand({ text: "'; touch /tmp/pwn; '", sessionId: SID }).includes('; touch /tmp/pwn; ;'),
   'and the message text is single-quote escaped, not interpolated');

// ── 2. the probe must not see ITSELF ──────────────────────────────────────────────────────────
console.log('\n── the mid-turn probe: matches a real headless run, never its own command line ──');
const probe = new RegExp(HEADLESS_PROC_PATTERN);
ok(probe.test('claude --bare -p --output-format stream-json --verbose --dangerously-skip-permissions'),
   'it matches the claude headless run the queenzee actually spawns');
ok(probe.test('codex exec --json --dangerously-bypass-approvals-and-sandbox -'), 'and the codex one');
ok(probe.test('kimi -p "$(cat)" --output-format stream-json'), 'and the kimi one');
ok(!probe.test('claude --resume aaaa --dangerously-skip-permissions'),
   'but NOT the interactive session a human drives — that pane can hear you, and must be typed into');
ok(!probe.test(cmd),
   'and NOT the command it is carried in: pgrep -f reads whole cmdlines, so an unbracketed pattern '
   + 'matched its own wrapper and made every cxell look mid-turn forever (caught live)');

// ── 3. the queenzee and the cage must ask the same question ───────────────────────────────────
console.log('\n── lockstep: the queenzee and zee-attach.sh use ONE pattern ──');
const attach = read('docker/zeehive/zee-attach.sh');
const liveRun = (attach.match(/live_run\(\) \{ pgrep -f '([^']+)'/) || [])[1];
ok(!!liveRun, "zee-attach.sh's live_run() is a pgrep on a literal pattern");
ok(liveRun === HEADLESS_PROC_PATTERN,
   `and it is byte-for-byte HEADLESS_PROC_PATTERN (${JSON.stringify(liveRun)}) — the two disagreeing `
   + 'is a message queued that nothing drains, or typed into a feed that eats it');

// ── 4. the cage side: the drainer, and where it is started ────────────────────────────────────
console.log('\n── zee-attach.sh: the queue is drained AFTER the feed hands over, never before ──');
ok(/drain_talk\(\)/.test(attach) && /start_talk_drain\(\)/.test(attach), 'it defines the drainer');
ok(attach.includes('TALK_DIR="${ZEE_TALK_DIR:-/tmp/zee-talk}"')
   && CXELL_TALK_DIR === '/tmp/zee-talk', 'reading the same queue directory the queenzee writes');
// Read the runtime `case` branch by branch: in EVERY one the drainer must start after the wait
// (wait_live/follow_live) and before the vendor's resume takes the pane.
const branches = attach.slice(attach.indexOf('case "$RUNTIME" in')).split(';;');
for (const [branch, wait, tail] of [['codex', 'wait_live', 'codex resume'],
                                    ['kimi', 'wait_live', 'kimi --continue'],
                                    ['claude', 'follow_live', 'claude --resume']]) {
  const b = branches.find((x) => x.includes(tail)) || '';
  const iWait = b.indexOf(wait);
  const iDrain = b.indexOf('start_talk_drain');
  const iTail = b.indexOf(tail);
  ok(iWait >= 0 && iDrain > iWait && iTail > iDrain,
     `the ${branch} branch waits out the turn, THEN starts the drainer, THEN hands the pane over`);
}
ok(!/start_talk_drain/.test(attach.slice(attach.indexOf('follow_live() {'), attach.indexOf('# Vendors without'))),
   'and never from inside the feed itself — typing into the read-only feed is the bug being fixed');
ok(/rm -f "\$f"\n\s*\[\[ -n/.test(attach) || /rm -f "\$f"/.test(attach),
   'a message is removed BEFORE it is typed: a crash mid-delivery loses one rather than repeating it');
ok(/tr '\\r\\n' '  '/.test(attach),
   'newlines are collapsed — Enter SUBMITS in the TUI, so a multi-line paste would fire half-messages');
ok(/READ-ONLY feed/.test(attach),
   'and the feed banner SAYS the pane cannot hear you, and where the door is (this is how it was reported)');

// ── 5. the refresh: the drainer must reach cxells that already exist ──────────────────────────
console.log('\n── the attach script is refreshed like the CLI and the renderer ──');
ok(typeof installZeeAttachIntoCxell === 'function' && ZEE_ATTACH_DEST === '/usr/local/bin/zee-attach.sh',
   'cxell.js installs it over the copy baked into the image');
ok(zeeAttachSourcePath().endsWith(join('docker', 'zeehive', 'zee-attach.sh')), 'from the queenzee\'s own repo');
const install = zeeAttachInstallCommands({ name: 'cxell_zt', src: '/src/zee-attach.sh' });
ok(install[0][0] === 'cp' && install[1].includes('-u') && install[1].includes('0')
   && install[1].join(' ').includes(`install -o root -g root -m 0755 /tmp/zee-attach.sh ${ZEE_ATTACH_DEST}`),
   'root-owned and executable, like the CLI (a zee cannot rewrite the script that drains its own queue)');
const dead = await installZeeAttachIntoCxell({ ctx: 'default', name: 'cxell_zt-does-not-exist' });
ok(dead.installed === false && !!dead.reason, 'an unreachable cage is reported, never thrown (it runs at spawn AND at boot)');
ok(read('server/src/queenzee/intake.js').includes('installZeeAttachIntoCxell({ ctx, name })'), 'the spawn path installs it');
ok(/installZeeAttachIntoCxell\(\{ ctx, name \}\)/.test(read('server/src/lib/cxell.js').slice(
     read('server/src/lib/cxell.js').indexOf('export async function refreshZeeLiveInLiveCxells'))),
   'and the boot sweep refreshes it into every RUNNING cxell — or the queue would fill in cages that cannot drain it');

// ── 6. sendKeysToCxellZee tells the caller WHICH happened ─────────────────────────────────────
console.log('\n── sendKeysToCxellZee: "typed" and "queued" are different promises ──');
const { publicKey } = ensureZeehiveKeypair();
const allowedPub = utils.parseKey(publicKey);
function fakeCxell(answer) {
  const state = { cmd: null };
  const srv = new Server({ hostKeys: [utils.generateKeyPairSync('ed25519').private] }, (client) => {
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
      accept().on('exec', (accept2, _r, info) => {
        state.cmd = info.command;
        const stream = accept2();
        if (answer) stream.write(`${answer}\n`);
        stream.exit(0); stream.end();
      });
    }));
  });
  return { srv, state };
}
{
  const { srv } = fakeCxell('__ZEE_KEYS_SENT__');
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const r = await sendKeysToCxellZee({ sshPort: srv.address().port, text: 'status?', sessionId: SID });
  ok(r.sent === true && r.delivery === 'typed', 'a pane held by the interactive session → { sent, delivery:"typed" }');
  srv.close();
}
{
  const { srv } = fakeCxell('__ZEE_TALK_QUEUED__');
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const r = await sendKeysToCxellZee({ sshPort: srv.address().port, text: 'status?', sessionId: SID });
  ok(r.sent === true && r.delivery === 'queued',
     'a zee MID-TURN → { sent, delivery:"queued" } — the caller must say "when its turn ends", not "delivered"');
  srv.close();
}
{
  const { srv } = fakeCxell('');   // neither marker: the cage answered nothing we understand
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  let threw = false;
  try { await sendKeysToCxellZee({ sshPort: srv.address().port, text: 'x', sessionId: SID }); } catch { threw = true; }
  ok(threw, 'and an unconfirmed send still rejects rather than lying about either one');
  srv.close();
}
ok(/delivery === 'queued'/.test(read('server/src/queenzee/nudge.js')),
   'the message/nudge callers pass that word on into the log instead of claiming delivery');

// ── 7. the real thing: the real drainer, a real tmux pane ─────────────────────────────────────
console.log('\n── end to end: a queued message is typed into the session when the pane frees up ──');
const hasTmux = process.platform !== 'win32'
  && spawnSync('tmux', ['-V'], { encoding: 'utf8' }).status === 0;
if (!hasTmux) {
  skip('no tmux on this host — the drainer half needs a real pane (it is proven in the cxell image)');
} else {
  const dir = mkdtempSync(join(tmpdir(), 'zee-talk-'));
  const session = `zt-talk-${process.pid}`;
  const queue = join(dir, 'queue');
  const got = join(dir, 'received.txt');
  const tui = join(dir, 'fake-tui.sh');
  // A stand-in for `claude --resume`: it records every line submitted into the pane.
  writeFileSync(tui, `#!/bin/bash\nwhile IFS= read -r line; do echo "$line" >> ${got}; done\n`);
  execFileSync('chmod', ['+x', tui]);
  writeFileSync(got, '');
  mkdirSync(queue, { recursive: true });
  // Run the REAL drain_talk, lifted out of the REAL script — so this tests what ships.
  const drainFn = (attach.match(/^drain_talk\(\) \{[\s\S]*?^\}/m) || [''])[0];
  ok(!!drainFn, 'drain_talk() was lifted out of the shipped script (this exercises the real code)');
  const runner = join(dir, 'run.sh');
  writeFileSync(runner, [
    '#!/bin/bash', 'set -uo pipefail', drainFn,
    `TALK_DIR=${queue}`, `TALK_TARGET=${session}`,
    'drain_talk 1 & DP=$!',
    // two messages, the second multi-line — they must arrive in order, one submission each
    `sleep 2; printf '%s' 'manager: what is the crew doing?' > ${queue}/1.msg`,
    `sleep 3; printf '%s' 'pause them,\nI am re-scoping' > ${queue}/2.msg`,
    'sleep 4; kill $DP 2>/dev/null; true',
  ].join('\n'));
  try {
    execFileSync('tmux', ['kill-session', '-t', session], { stdio: 'ignore' });
  } catch { /* not running, which is the normal case */ }
  execFileSync('tmux', ['new-session', '-d', '-s', session, '-x', '200', '-y', '50', tui]);
  try {
    execFileSync('bash', [runner], { timeout: 60000 });
    const lines = readFileSync(got, 'utf8').trim().split('\n').filter(Boolean);
    ok(lines[0] === 'manager: what is the crew doing?', 'the first queued message is typed into the live session');
    ok(lines[1] === 'pause them, I am re-scoping',
       'the second arrives after it, as ONE submission (its newline collapsed, not an early Enter)');
    ok(lines.length === 2, `exactly two submissions — nothing duplicated (${JSON.stringify(lines)})`);
    ok(readdirSync(queue).filter((f) => f.endsWith('.msg')).length === 0, 'and the queue is left empty');
  } finally {
    try { execFileSync('tmux', ['kill-session', '-t', session], { stdio: 'ignore' }); } catch { /* gone */ }
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(failures ? `\n${failures} FAILED` : `\nALL PASSED ✓${skipped ? ` (${skipped} skipped)` : ''}`);
process.exit(failures ? 1 : 0);
