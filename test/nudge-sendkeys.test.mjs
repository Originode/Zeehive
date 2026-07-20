// NUDGE-SENDKEYS test — proves the operator "nudge" TYPES the literal word into a caged zee's LIVE
// session over SSH, instead of forking a headless `claude --resume -p` whose reply nobody sees (the
// old behaviour, reported as "nudge does not work still").
//
// Runs the REAL sendKeysToCagedZee (server/src/lib/cage.js) against a THROWAWAY in-process ssh2
// server that authorizes the SAME fleet key ensureZeehiveKeypair() hands the client. The one seam is
// the cage itself: the fake sshd stands in for it and CAPTURES the exact remote command — which is
// what we assert on (it must be a `tmux send-keys` of the literal text + Enter, into the `zee`
// session). No DB, no docker, no real container needed.
import { createRequire } from 'node:module';
import { ensureZeehiveKeypair, sendKeysToCagedZee } from '../server/src/lib/cage.js';

const require = createRequire(import.meta.url);
const { Server, utils } = require('ssh2');

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };

// The fleet key the client (sendKeysToCagedZee) will present — authorize exactly it.
const { publicKey } = ensureZeehiveKeypair();
const allowedPub = utils.parseKey(publicKey);

// A minimal sshd that accepts the fleet key, captures the exec command, and (optionally) fails the
// send so we can prove the reject path too.
function makeServer({ failSend = false } = {}) {
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
      accept().on('exec', (accept, _reject, info) => {
        state.cmd = info.command;
        const stream = accept();
        if (!failSend) stream.write('__ZEE_KEYS_SENT__\n');
        stream.exit(failSend ? 1 : 0);
        stream.end();
      });
    }));
  });
  return { srv, state };
}

// ── 1. happy path: types the literal word + Enter into the `zee` tmux session ──
console.log('── sendKeysToCagedZee: delivers the literal keystrokes over SSH ──');
{
  const { srv, state } = makeServer();
  await new Promise((res) => srv.listen(0, '127.0.0.1', res));
  const port = srv.address().port;
  const r = await sendKeysToCagedZee({ sshPort: port, text: 'status?', sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
  ok(r.sent === true, 'resolves { sent:true } once the cage confirms the keys landed');
  ok(/tmux send-keys -t zee -l 'status\?'/.test(state.cmd), "sends the LITERAL word 'status?' (send-keys -l) — not a shell/key-name interpretation");
  ok(/tmux send-keys -t zee Enter/.test(state.cmd), 'presses Enter afterwards so the agent actually receives the message');
  ok(/tmux has-session -t zee/.test(state.cmd), 'attaches-or-creates the live `zee` session (never a rival headless run)');
  ok(state.cmd.includes("zee-attach.sh aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"),
     'if no session is up, starts the SAME interactive session the terminal bridge uses, on this sid');
  ok(!/claude --bare -p/.test(state.cmd), 'does NOT fork a headless `claude --bare -p` (the old, invisible nudge)');
  srv.close();
}

// ── 2. an apostrophe in the text is quoted safely (no shell injection / breakage) ──
console.log('\n── quoting: apostrophes survive intact ──');
{
  const { srv, state } = makeServer();
  await new Promise((res) => srv.listen(0, '127.0.0.1', res));
  const port = srv.address().port;
  await sendKeysToCagedZee({ sshPort: port, text: "what's the status?", sessionId: 'x' });
  ok(state.cmd.includes(`send-keys -t zee -l 'what'\\''s the status?'`),
     "an apostrophe is escaped as '\\'' so the exact text is delivered");
  srv.close();
}

// ── 3. an unreachable / erroring cage REJECTS (so the caller stays best-effort) ──
console.log('\n── failure path: an unreachable cage rejects, never hangs ──');
{
  let threw = false;
  try { await sendKeysToCagedZee({ sshPort: 1, text: 'status?', sessionId: 'x', timeoutMs: 3000 }); }
  catch { threw = true; }
  ok(threw, 'a dead SSH port rejects (the nudge caller logs it best-effort, never crashes)');

  const { srv } = makeServer({ failSend: true });
  await new Promise((res) => srv.listen(0, '127.0.0.1', res));
  const port = srv.address().port;
  let threw2 = false;
  try { await sendKeysToCagedZee({ sshPort: port, text: 'status?', sessionId: 'x', timeoutMs: 5000 }); }
  catch { threw2 = true; }
  ok(threw2, 'a cage with no live tmux session (non-zero send-keys) rejects rather than lying');
  srv.close();
}

console.log(`\n${failures === 0 ? 'ALL PASSED ✓' : `${failures} FAILURE(S) ✗`}`);
process.exit(failures === 0 ? 0 : 1);
