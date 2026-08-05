// A MESSAGE THAT RESTARTS A ZEE MUST BE VISIBLE — and it must go through a door the queenzee owns.
//
// MEASURED (a manager's crew, 2026-08-03), premise and correction both. A reviewer's turn had ENDED
// ('idle', last_stop_reason 'end_turn', $5.05 spent) and it had PROPOSED DONE. Its manager sent the
// next instruction with `zee say`; the verb answered "Delivered into <slug>'s live session — it will
// answer there"; the manager watched, saw nothing move, concluded the channel was dead, and spent a
// whole second xell redoing the work with a worker holding none of the context.
//
// The first reading was "the message reached nobody". The meta-DB timeline says otherwise, and the
// correction matters more than the original story: the message ARRIVED and DID restart the zee —
// that xell landed a commit eight minutes later, then landed seven fixes. What actually failed is
// that NOTHING SAID SO. Its zee row still read status 'idle' with the previous turn's cost for the
// whole of that turn, and `zee zees` (managers.crewFor → `working: zee_status === 'working'`) is the
// only instrument a manager has.
//
// TWO DEFECTS, then, and this test fences both:
//
//   1. A NUDGE IS A TURN AND NOTHING RECORDED IT (nudge.js markZeeTurn). Not just for messages: the
//      landing-approved, stale-landing, runway-cleared, post-ship-reflection and fleet-resume nudges
//      all come through the same shared resume, and not one of them moved the zee's status. Part C
//      proves what the zee row and the CREW READ MODEL show WHILE a messaged zee is really working —
//      taken mid-flight, with the resumed turn held open on the fake docker's stdin read.
//
//   2. ONE WORD FOR THREE OUTCOMES. sendMessageToXell answered `sent` whether the message was typed
//      into a live session, queued behind a live turn, or restarting a finished one, and `zee say`
//      turned that into "Delivered … it will answer there" for all three. Parts A/B route on the
//      zee's own state (lib/zee-turn.js decideMessageDelivery — pure, table-testable, the shape of
//      decideDispatchProvider / decideReaderAddress) and report which one happened.
//
// WHY A FINISHED ZEE IS RESUMED RATHER THAN TYPED AT, now that "it reached nobody" is off the table:
// a keystroke hands the turn to a TUI inside the cage, where no hook, no poller and no pgrep can
// tell a generating session from one sitting at its prompt — reaper.js records exactly that as a
// KNOWN GAP. A turn delivered that way is unobservable by construction, so defect 1 cannot be fixed
// for messages without moving them onto the door the queenzee starts, records and watches end. It
// also drops two guesses that path makes on a finished zee (that a tmux session exists or can be
// created, and that `claude --resume` has its prompt box up inside the six seconds before the keys
// are sent). The keystroke paths remain exactly as they were for the states they suit.
//
// WHAT IS FENCED HERE:
//   A. the DECISION, in a table — including the reported state (turn ENDED → 'resumed');
//   B. the REAL sendMessageToXell against a throwaway postgres and BOTH seams a cxell provides: a
//      fake `docker` on PATH (the resume) and an in-process sshd (the pane). An ended turn reaches
//      the first; a mid-turn zee still reaches the second and is reported QUEUED;
//   C. the visibility: zee row + crewFor + hiveStatus during and after a messaged turn — and that
//      the xell's own 'awaiting-done' is NOT overwritten by it (the reported worker had asked to be
//      finished; mirroring 'working' over that would delete a human's pending decision);
//   D. the rules that must NOT move: a FLEET PAUSE still refuses, a torn-down cxell still says why,
//      a DECOMMISSIONED zee or one in a RETIRED xell is never started, and nothing throws.
//   E. (TKT-60) the RECEIPT is corrected when the delivery it reported dies. `sent` means the resume
//      started or the keystrokes were handed to SSH — never that either survived — so a zee_message
//      row stamped delivered=true and never revisited told a manager its worker had been told
//      something it never heard. The zee row was already corrected; now the message row is too.
//
// Everything it creates is deleted in a finally, whatever happens.
process.env.PROVISION_MODE = 'real';   // read once at import: the real queenzee resumes real cages
process.env.TKB_NOTIFY = '0';

import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { Server, utils } = require('ssh2');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── A. THE DECISION (pure — no database, no container) ────────────────────────────────────────
const { decideMessageDelivery, MID_TURN_STATUSES } = await import('../server/src/lib/zee-turn.js');

// A live, resumable claude cxell zee that has FINISHED its turn — the exact row the defect was
// reported on. Each case below changes ONE field of it.
const LIVE = { present: true, status: 'idle', viewerKind: 'ssh-terminal', decommissioned: false,
               xellStatus: 'working', runtimeResumable: true, sessionResumable: true };
const d = (over = {}) => decideMessageDelivery({ ...LIVE, ...over });

console.log('\n── A. which delivery a zee\'s state deserves ──');
ok(d().delivery === 'resumed',
   'THE REPORTED STATE: a zee whose turn has ENDED (idle) is RESUMED with the message as its prompt — '
   + 'the one delivery whose turn the queenzee can record (see part C)');
ok(d({ status: 'errored' }).delivery === 'resumed',
   'a turn that DIED (errored — an API 429, a killed run) has also ended: resumed, not typed at');
ok(d({ status: 'stopped' }).delivery === 'resumed',
   'and so has a stopped one, as long as the zee has not been decommissioned (checked below)');
for (const status of MID_TURN_STATUSES) {
  ok(d({ status }).delivery === 'queued',
     `'${status}' is MID-TURN → QUEUED: the pane is a read-only feed and the cage types it in when the turn ends`);
}
ok(d({ runtimeResumable: false }).delivery === 'typed',
   'a runtime with no resume verb → TYPED: the interactive session in its pane is the only door left');
ok(d({ sessionResumable: false }).delivery === 'typed',
   'and so is a zee whose session id was never captured (claude/codex resume BY id)');
ok(d({ sessionResumable: false }).reason.includes('no session id'),
   '…and the reason says which of the two it was, rather than "typed" with no why');

console.log('\n── A2. nothing may START A TURN on a zee that is gone ──');
ok(d({ present: false }).delivery === 'none'
   && d({ present: false }).reason === 'no cxell zee for this xell (nothing to message)',
   'no cxell zee at all → refused, with the sentence a human/manager already reads');
ok(d({ decommissioned: true }).delivery === 'none',
   'a DECOMMISSIONED zee is never resumed — the reaper writes decommissioned_at and leaves '
   + 'viewer_kind alone, so this must be asked BEFORE "is the cxell live?"');
ok(d({ xellStatus: 'retired' }).delivery === 'none', 'and neither is a zee in a RETIRED xell');
ok(d({ viewerKind: 'none' }).delivery === 'none'
   && d({ viewerKind: 'none' }).reason.includes('viewer_kind=none'),
   'a torn-down cxell still refuses, still naming the viewer_kind it saw');

console.log('\n── A3. the receipt: three deliveries are three different promises ──');
const { deliveryReceipt } = await import('../server/src/lib/managers.js');
ok(/RESUMED/.test(deliveryReceipt('resumed', 'w')) && /acting on it now/.test(deliveryReceipt('resumed', 'w')),
   "'resumed' tells the sender the worker is acting on it now");
ok(/QUEUED/.test(deliveryReceipt('queued', 'w')) && /has NOT read it yet/.test(deliveryReceipt('queued', 'w')),
   "'queued' says plainly that it has NOT read it yet — this is the sentence a manager plans on");
ok(/TYPED/.test(deliveryReceipt('typed', 'w')), "'typed' is the old, true-in-that-one-case promise");
ok(/NOT delivered live/.test(deliveryReceipt('none', 'w', 'no live cxell')) && /zee inbox/.test(deliveryReceipt('none', 'w')),
   'and an undelivered message still points at the durable inbox');
const say = readFileSync(join(ROOT, 'server/src/queenzee/self.js'), 'utf8');
ok(!/Delivered into \$\{worker\.slug\}/.test(say),
   '`zee say` no longer answers "Delivered into …\'s live session" for every delivery it managed to hand off');

// ── B. THE REAL PATH (throwaway postgres + both seams) ────────────────────────────────────────
const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }

const { q, one, pool } = await import('../server/src/db/pool.js');
const nudge = await import('../server/src/queenzee/nudge.js');
const { setPaused, forgetPauseCache } = await import('../server/src/lib/fleet-pause.js');
const { ensureZeehiveKeypair } = await import('../server/src/lib/cxell.js');

// The `docker` seam: the shared fake on PATH records argv + stdin (the resume prompt) to $DOCKER_LOG.
const DOCKER_LOG = join(process.env.TMPDIR || '/tmp', `msgfin-docker-${process.pid}.log`);
process.env.DOCKER_LOG = DOCKER_LOG;
process.env.PATH = `${join(ROOT, 'test', '_bin')}:${process.env.PATH}`;
const dockerLog = () => (existsSync(DOCKER_LOG) ? readFileSync(DOCKER_LOG, 'utf8') : '');

// The `ssh` seam: a throwaway in-process sshd standing in for the cage's pane door (the same one
// cxell-talk.test.mjs / nudge-sendkeys.test.mjs use). It records the command it was asked to run.
const { publicKey } = ensureZeehiveKeypair();
const allowedPub = utils.parseKey(publicKey);
const pane = { cmds: [] };
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
    accept().on('exec', (accept2, _r, info) => {
      pane.cmds.push(info.command);
      const stream = accept2();
      stream.write('__ZEE_KEYS_SENT__\n');   // "the interactive session took the keystrokes"
      stream.exit(0); stream.end();
    });
  }));
});
await new Promise((r) => sshd.listen(0, '127.0.0.1', r));
const SSH_PORT = sshd.address().port;

const PID = '00000000-0000-4000-8000-0000000f5701';
const SID = 'ffffffff-1111-4222-8333-444444444444';
const cleanup = async () => {
  try { await setPaused(false, { by: 'msg-test' }); } catch { /* the row may not exist */ }
  try { await q(`DELETE FROM project WHERE id=$1`, [PID]); } catch { /* already gone */ }
};

// Wait for a fire-and-forget delivery to actually show up at its seam (both are async by contract).
const waitFor = async (fn, ms = 4000) => {
  for (let i = 0; i < ms / 100; i++) { if (await fn()) return true; await sleep(100); }
  return false;
};

try {
  await cleanup();
  await q(`INSERT INTO project (id, name, repo_root, main_branch) VALUES ($1,'msgfin',$2,'main')`,
          [PID, join(ROOT)]);
  const xource = await one(`INSERT INTO xource (project_id, ref) VALUES ($1,'main') RETURNING *`, [PID]);
  const mkXell = async (slug, status = 'working') => one(
    `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status, self_token_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [PID, xource.id, slug, `spinoff/${slug}`, `/tmp/msgfin/${slug}`, status, `hash-${slug}`]);
  const rt = await one(`SELECT id FROM agent_runtime WHERE key='claude-code-cxell'`);
  const mkZee = async (xellId, over = {}) => one(
    `INSERT INTO zee (xell_id, attach_mode, entrypoint, kind, runtime_id, viewer_kind, viewer_url,
                      claude_session_id, model, status, last_stop_reason, decommissioned_at)
     VALUES ($1,'headless-spawn','cxell-cli','headless',$2,$3,$4,$5,'opus',$6,$7,$8) RETURNING *`,
    [xellId, rt?.id || null, over.viewerKind ?? 'ssh-terminal',
     over.viewerUrl ?? `ssh://zee@127.0.0.1:${SSH_PORT}`, over.sid ?? null,
     over.status ?? 'idle', over.stopReason ?? 'end_turn', over.decommissionedAt ?? null]);

  // ── B1. THE REPRODUCTION: a finished zee is RESUMED, and the pane is not touched ────────────
  console.log('\n── B1. the reported case: idle + end_turn, a manager sends the next instruction ──');
  const finished = await mkXell('msgfin-done');
  await mkZee(finished.id, { sid: SID, status: 'idle', stopReason: 'end_turn' });
  pane.cmds.length = 0;
  const r1 = await nudge.sendMessageToXell(finished.id, { text: 'next: fix the failing test in web/', by: 'manager-zee-be2f57' });
  ok(r1.sent === true && r1.delivery === 'resumed',
     `the answer is RESUMED, not a bare "sent" (sent=${r1.sent} delivery=${r1.delivery})`);
  ok(await waitFor(() => /--resume/.test(dockerLog())),
     'the queenzee ran `docker exec … --resume` on the cage — the SAME machinery a landing approval uses');
  const dl = dockerLog();
  ok(dl.includes(SID), `the resume targeted THIS session id (${SID.slice(0, 8)}…)`);
  ok(/claude --bare -p/.test(dl), 'as a headless continuation (`claude --bare -p`), which is a turn the zee actually runs');
  ok(/next: fix the failing test in web\//.test(dl),
     'and the MESSAGE ITSELF is the prompt on stdin — verbatim, not a 160-character summary');
  ok(/A MESSAGE ARRIVED FOR YOU/.test(dl) && /manager-zee-be2f57/.test(dl),
     'the prompt says a message arrived and who sent it, so a session that wakes up knows why');
  ok(/turn had already ENDED/.test(dl) && /Nothing of yours failed/.test(dl),
     'and that nothing failed — an agent resumed with no explanation goes hunting for an error that is not there');
  await sleep(300);
  ok(pane.cmds.length === 0,
     'and NOTHING was typed into the cage pane: one message, one delivery — never both doors, and never '
     + 'the door whose turn nothing in the fleet can see');

  // ── B2. a MID-TURN zee still queues, over the pane door, and is reported as queued ──────────
  console.log('\n── B2. unchanged: a zee MID-TURN is queued in its cage ──');
  const busy = await mkXell('msgfin-busy');
  await mkZee(busy.id, { sid: 'aaaaaaaa-1111-4222-8333-444444444444', status: 'working', stopReason: null });
  pane.cmds.length = 0;
  const beforeDocker = dockerLog().length;
  const r2 = await nudge.sendMessageToXell(busy.id, { text: 'when you surface: rebase first', by: 'human@console' });
  ok(r2.sent === true && r2.delivery === 'queued',
     `a mid-turn zee is reported QUEUED, never "delivered" (delivery=${r2.delivery})`);
  ok(await waitFor(() => pane.cmds.length > 0), 'the message went to the cage pane door (SSH), as it always did');
  ok(/tmux/.test(pane.cmds[0] || '') && /zee-attach\.sh/.test(pane.cmds[0] || ''),
     'as the real talk command — attach-or-create the session that drains the queue');
  ok(dockerLog().length === beforeDocker,
     'and NO session was resumed: a zee mid-turn must not be handed a second turn on top of its own');

  // ── B3. nothing starts a turn on a zee that is gone ─────────────────────────────────────────
  console.log('\n── B3. decommissioned / retired / torn down: refused, with the reason ──');
  const dead = await mkXell('msgfin-dead');
  await mkZee(dead.id, { sid: 'bbbbbbbb-1111-4222-8333-444444444444', status: 'stopped',
                         decommissionedAt: new Date().toISOString() });
  pane.cmds.length = 0;
  const before3 = dockerLog().length;
  const r3 = await nudge.sendMessageToXell(dead.id, { text: 'hello?', by: 'human@console' });
  ok(r3.sent === false && /decommissioned/.test(r3.reason || ''),
     `a DECOMMISSIONED zee is refused and told why (${(r3.reason || '').slice(0, 60)}…)`);
  await sleep(200);
  ok(dockerLog().length === before3 && pane.cmds.length === 0,
     'and neither seam was touched — the cage is gone, so a "best-effort" attempt is just noise');

  const retired = await mkXell('msgfin-retired', 'retired');
  await mkZee(retired.id, { sid: 'cccccccc-1111-4222-8333-444444444444', status: 'idle' });
  const r4 = await nudge.sendMessageToXell(retired.id, { text: 'hello?', by: 'human@console' });
  ok(r4.sent === false && /retired/.test(r4.reason || ''), 'a zee in a RETIRED xell is refused too');

  const torn = await mkXell('msgfin-torn');
  await mkZee(torn.id, { sid: 'dddddddd-1111-4222-8333-444444444444', viewerKind: 'none' });
  const r5 = await nudge.sendMessageToXell(torn.id, { text: 'hello?', by: 'human@console' });
  ok(r5.sent === false && /viewer_kind=none/.test(r5.reason || ''),
     'a torn-down cxell still reports WHY (unchanged behaviour)');

  const noZee = await mkXell('msgfin-empty');
  const r6 = await nudge.sendMessageToXell(noZee.id, { text: 'hello?', by: 'human@console' });
  ok(r6.sent === false && /nothing to message/.test(r6.reason || ''), 'a xell with no cxell zee: unchanged refusal');

  // ── B4. the PAUSE still wins, and a nested queenzee still resumes nothing ───────────────────
  console.log('\n── B4. the rules that must not move ──');
  await setPaused(true, { by: 'msg-test@console', reason: 'rate limit' });
  forgetPauseCache();
  const before4 = dockerLog().length;
  const rp = await nudge.sendMessageToXell(finished.id, { text: 'act on this', by: 'human@console' });
  ok(rp.sent === false && rp.paused === true,
     'a message to a FINISHED zee is still REFUSED while the fleet is paused — a pause a message can '
     + 'undo is not a pause');
  await sleep(200);
  ok(dockerLog().length === before4, 'and it resumed nothing (the refusal is before the delivery, not after it)');
  await setPaused(false, { by: 'msg-test@console' });
  forgetPauseCache();

  const before5 = dockerLog().length;
  const rs = await nudge.sendMessageToXell(finished.id, { text: 'act on this', by: 'human@console', mode: 'simulate' });
  ok(rs.sent === false && rs.dry_run === true,
     'PROVISION_MODE=simulate refuses the resume and SAYS so — a nested queenzee walks a CLONE of the '
     + 'meta-DB, so `cxell_<slug>` off one of those rows is another zee\'s live cage');
  await sleep(200);
  ok(dockerLog().length === before5, 'and it exec\'d nothing');
  ok(!pane.cmds.length,
     '…and did NOT quietly fall back to typing: falling back would post the message into the exact '
     + 'dead drop this change exists to stop claiming as delivered');

  // ── B5. best-effort by contract: it never throws ────────────────────────────────────────────
  const broken = await mkXell('msgfin-broken');
  await mkZee(broken.id, { sid: null, viewerUrl: 'not-a-url' });
  let threw = false;
  let r7;
  try { r7 = await nudge.sendMessageToXell(broken.id, { text: 'hi', by: 'human@console' }); } catch { threw = true; }
  ok(!threw, 'a zee with no session id and a broken viewer_url does not throw — this function is best-effort by contract');
  ok(r7?.sent === false && /SSH port/.test(r7?.reason || ''),
     'it falls to the keystroke path (no session id → nothing to resume) and reports the unreachable door');
  const r8 = await nudge.sendMessageToXell(finished.id, { text: '   ', by: 'human@console' });
  ok(r8.sent === false && /empty message/.test(r8.reason || ''), 'and an empty message is still refused up front');
  // ── C. THE COST OF THE INVISIBLE TURN — what the fleet SHOWS while a messaged zee works ──────
  //
  // This is the defect the manager actually paid for, and the one this block fences. Its worker's
  // turn had ended, it had PROPOSED DONE, and the message restarted it — but `zee zees` kept saying
  // idle for the whole of that turn, so the manager read inaction and spent a second xell redoing
  // work that was already being done. The proof has to be taken WHILE the resumed turn is in flight,
  // so the fake docker is held open on its stdin read (DOCKER_FAKE_SLOW_STDIN_MS) and the read
  // models are asked in that window.
  console.log('\n── C. while the messaged zee is actually working ──');
  const { crewFor } = await import('../server/src/lib/managers.js');
  const { hiveStatus } = await import('../server/src/lib/hive-status.js');

  const manager = await mkXell('msgfin-manager');
  await q(`UPDATE xell SET zee_type='manager' WHERE id=$1`, [manager.id]);   // crewFor's own guard: only a manager holds a crew
  // the worker in the reported state: turn ended, and it has ASKED to be finished
  const worker = await mkXell('msgfin-worker', 'awaiting-done');
  await q(`UPDATE xell SET manager_xell_id=$2 WHERE id=$1`, [worker.id, manager.id]);
  const wz = await mkZee(worker.id, { sid: 'eeeeeeee-1111-4222-8333-444444444444',
                                      status: 'idle', stopReason: 'end_turn' });
  const crew0 = (await crewFor(manager.id)).find((c) => c.xell_id === worker.id);
  ok(crew0?.working === false && crew0?.zee_status === 'idle',
     'before the message the crew view says idle — which is true, and is what makes the next line matter');

  process.env.DOCKER_FAKE_SLOW_STDIN_MS = '2500';   // hold the resumed turn open, deterministically
  const rc = await nudge.sendMessageToXell(worker.id, { text: 'one more thing: also update the docs', by: 'manager-zee-be2f57' });
  ok(rc.delivery === 'resumed', 'the message resumed the finished worker (the delivery under test)');

  const live = await one(`SELECT status, name, last_stop_reason FROM zee WHERE id=$1`, [wz.id]);
  ok(live.status === 'working',
     `THE FIX: the zee row says WORKING while the messaged turn runs (was 'idle' for the whole turn) — got '${live.status}'`);
  ok(!!live.name, 'and it is NAMED, as a working zee is (the same rule lib/status.js applies to a spawn)');
  const crew1 = (await crewFor(manager.id)).find((c) => c.xell_id === worker.id);
  ok(crew1?.working === true,
     "the MANAGER'S OWN INSTRUMENT agrees — `zee zees` reports working: true, which is the read model "
     + 'that said idle while seven fixes were being landed');
  ok(crew1?.zee_status === 'working', 'and it carries the raw zee_status behind it');

  // …without stealing the human's pending decision.
  const wx = await one(`SELECT status FROM xell WHERE id=$1`, [worker.id]);
  ok(wx.status === 'awaiting-done',
     "the xell is STILL 'awaiting-done' — a resumed turn must not mirror 'working' over a decision a "
     + 'human is holding (this worker had proposed done, which is how the report arose)');
  ok(hiveStatus({ status: wx.status, zee_status: 'working' }) === 'occ-doneRequest',
     'so the hexagon still shows done? — the human-actionable ask still outranks plain activity');
  ok(hiveStatus({ status: 'working', zee_status: 'working' }) === 'occ-working',
     'and a worker with no pending ask reads occ-working on the hive while its messaged turn runs');

  // …and the turn ENDS, rather than leaving a zee 'working' forever (the stuck-flag bug class).
  ok(await waitFor(async () => (await one(`SELECT status FROM zee WHERE id=$1`, [wz.id]))?.status === 'idle', 15000),
     'when the resumed turn returns the row goes back to idle — a status that only ever goes up is '
     + 'the same lie in the other direction, and it would block the reap');
  const done = await one(`SELECT status, name, last_stop_reason FROM zee WHERE id=$1`, [wz.id]);
  // TKT-99-1390: the fake resumes print no result event, so the turn's usage is UNMETERED — the row
  // ends 'end_turn (usage unreported)' rather than a silent 'end_turn' beside zeros that reads as
  // "never ran". The turn still ends (idle, nameless), which is the TKT-57 contract this asserts.
  ok(/^end_turn( \(usage unreported\))?$/.test(done.last_stop_reason || '') && done.name === null,
     "…with last_stop_reason 'end_turn' (or the unmetered marker) and the codename dropped, exactly "
     + 'as intake.js ends a spawned turn');
  delete process.env.DOCKER_FAKE_SLOW_STDIN_MS;

  // ── C2. THE SIBLINGS: every other continuation was invisible in the same way ─────────────────
  console.log('\n── C2. the same silence on every other nudge ──');
  const landed = await mkXell('msgfin-landed');
  const lz = await mkZee(landed.id, { sid: '99999999-1111-4222-8333-444444444444', status: 'idle', stopReason: 'end_turn' });
  process.env.DOCKER_FAKE_SLOW_STDIN_MS = '2000';
  await nudge.nudgeXellAfterLand(landed.id, { by: 'human@console' });
  const lrow = await one(`SELECT status FROM zee WHERE id=$1`, [lz.id]);
  ok(lrow.status === 'working',
     'a LANDING-APPROVED nudge marks the turn too — it was the same invisible restart, one caller over '
     + '(so are the stale, clearance, reflection and fleet-resume nudges: one shared delivery)');
  ok(await waitFor(async () => (await one(`SELECT status FROM zee WHERE id=$1`, [lz.id]))?.status === 'idle', 15000),
     'and it comes back to idle when that turn returns');
  delete process.env.DOCKER_FAKE_SLOW_STDIN_MS;

  // A resume that CANNOT run must not leave the zee marked working forever.
  const gone = await mkXell('msgfin-gone');
  const gz = await mkZee(gone.id, { sid: '88888888-1111-4222-8333-444444444444', status: 'idle', stopReason: 'end_turn' });
  process.env.DOCKER_FAKE_EXEC_EXIT = '7';
  await nudge.sendMessageToXell(gone.id, { text: 'are you there?', by: 'human@console' });
  ok(await waitFor(async () => {
       const r = await one(`SELECT status, last_stop_reason FROM zee WHERE id=$1`, [gz.id]);
       return r?.status === 'idle' && /could not run/.test(r?.last_stop_reason || '');
     }, 8000),
     'a resume that dies on the way out puts the row BACK to idle and records why — a stuck "working" '
     + 'is the same lie as a stuck "idle", and it also blocks a reap');
  delete process.env.DOCKER_FAKE_EXEC_EXIT;

  // ── E. A FAILED DELIVERY CORRECTS ITS OWN RECORD (TKT-60) ───────────────────────────────────
  //
  // The durable half of the same honesty. postMessage stamps the zee_message row delivered=true the
  // instant sendMessageToXell answers `sent` — which means the resume STARTED, not that it lived.
  // When it dies, nudgeCxell puts the ZEE row back (asserted above) and, until this, the MESSAGE row
  // kept saying delivered forever: a manager re-reading the conversation to work out why its worker
  // is unresponsive is shown a delivery that never happened.
  console.log('\n── E. a delivery that died must stop reading as delivered ──');
  const { postMessage } = await import('../server/src/lib/managers.js');
  const boss = await mkXell('msgfin-boss');
  await q(`UPDATE xell SET zee_type='manager' WHERE id=$1`, [boss.id]);
  const receiptOf = async (id) => one(`SELECT delivered, delivery FROM zee_message WHERE id=$1`, [id]);

  // 1. the resume dies on the way out
  const hand = await mkXell('msgfin-handoff');
  await mkZee(hand.id, { sid: '77777777-1111-4222-8333-444444444444', status: 'idle', stopReason: 'end_turn' });
  process.env.DOCKER_FAKE_EXEC_EXIT = '7';
  const pm = await postMessage({ from: boss, to: hand, body: 'next: rebase and re-run the suite', kind: 'directive' });
  ok(pm.delivered === true && pm.delivery?.delivery === 'resumed',
     'the send answers RESUMED — all a fire-and-forget delivery can honestly claim at that moment');
  ok(await waitFor(async () => (await receiptOf(pm.message.id))?.delivered === false),
     'THE FIX: when that resume dies, the message row goes back to delivered=false — the record a '
     + 'manager reads is corrected, not just the zee row');
  const corrected = await receiptOf(pm.message.id);
  ok(corrected.delivery?.undelivered === true && /died on the way out/.test(corrected.delivery?.reason || ''),
     `…and says WHY, in the receipt itself (${String(corrected.delivery?.reason || '').slice(0, 60)}…)`);
  delete process.env.DOCKER_FAKE_EXEC_EXIT;

  // 2. the keystroke door never answers (same lie, other delivery)
  const mute = await mkXell('msgfin-mute');
  await mkZee(mute.id, { sid: null, viewerUrl: 'ssh://zee@127.0.0.1:1', status: 'idle' });
  const pm2 = await postMessage({ from: boss, to: mute, body: 'are you there?', kind: 'directive' });
  ok(pm2.delivery?.delivery === 'typed', 'a zee with no session id still falls to the keystroke path');
  ok(await waitFor(async () => (await receiptOf(pm2.message.id))?.delivered === false, 30000),
     'and a TYPED message whose SSH door never answered is corrected too — the keystrokes are just '
     + 'as fire-and-forget as the resume');

  // 3. …and a delivery that WORKED is left alone (the control — a correction that fires on success
  //    would be a worse lie than the one it fixes).
  const heard = await mkXell('msgfin-heard');
  await mkZee(heard.id, { sid: '66666666-1111-4222-8333-444444444444', status: 'idle', stopReason: 'end_turn' });
  const pm3 = await postMessage({ from: boss, to: heard, body: 'good work — carry on', kind: 'directive' });
  ok(await waitFor(() => /66666666/.test(dockerLog())), 'the resume ran for real this time');
  await sleep(500);
  const kept = await receiptOf(pm3.message.id);
  ok(kept.delivered === true && !kept.delivery?.undelivered,
     'a delivery that survived keeps its receipt — only a failure downgrades one');

  // 4. the doors with no durable row (the console 📨 button, the Hermes bridge) still just work.
  const bare = await mkXell('msgfin-bare');
  await mkZee(bare.id, { sid: '55555555-1111-4222-8333-444444444444', status: 'idle', stopReason: 'end_turn' });
  process.env.DOCKER_FAKE_EXEC_EXIT = '7';
  let threw2 = false;
  try { await nudge.sendMessageToXell(bare.id, { text: 'from the console', by: 'human@console' }); }
  catch { threw2 = true; }
  await sleep(300);
  ok(!threw2, 'a message with NO zee_message row behind it (the 📨 button, Hermes) has nothing to '
     + 'correct and does not throw trying');
  delete process.env.DOCKER_FAKE_EXEC_EXIT;
} finally {
  await cleanup();
  try { sshd.close(); } catch { /* already down */ }
  await pool.end().catch(() => {});
}

console.log(`\n${failures === 0 ? 'ALL PASSED ✓' : `${failures} FAILURE(S) ✗`}`);
process.exit(failures === 0 ? 0 : 1);
