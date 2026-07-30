// FLEET PAUSE test — the console's pause/play button: one press stops every zee in every xell,
// managers included; play calls back exactly the ones it stopped.
//
// The failure modes this guards are all of the same family — a pause that is not a pause:
//
//   1. INTERRUPT THE WRONG THING. The kill pattern is interpolated into the shell command that runs
//      it, so a pattern that can match its own wrapper has pkill SIGINT the wrapper and leave the
//      agent running — which reads as a successful pause. (The brackets in HEADLESS_PROC_PATTERN are
//      what stop that; see cxell-talk.test.mjs, where the same trick was earned by a live misfire.)
//      And it must be the HEADLESS pattern, never the broad one: a pause that also kills the
//      interactive `claude --resume` in the pane kills the terminal a human is typing in.
//   2. PAUSE FOR ONE TICK. The queenzee starts turns by itself — a landing lands and nudge.js resumes
//      the zee, a runway clears and it re-calls the holder, a ship succeeds and it asks for a
//      reflection, an operator message is typed into a session, a human dispatches. Every one of those
//      has to be refused while the flag is up, or the fleet re-wakes behind the sweep.
//   3. CLAIM MORE THAN HAPPENED. A cage that could not be reached is not a stopped zee; a resume that
//      was only modelled is not a zee called back. Both must be reported, not rounded up.
//   4. WAKE THE WRONG ZEES. Play must call back the zees the pause interrupted and nobody else —
//      resuming a zee that had legitimately finished, or one parked waiting on a human gate, is a
//      pause with side effects.
//   5. GO QUIET. A paused fleet looks exactly like a quiet one, so `idle` hexagons and a silent
//      `zee status` are how an operator loses track of what they stopped.
//
// Nothing here is mocked where it could be run. §1 executes the REAL escalation script in bash against
// REAL processes; §1b runs the REAL driver against a stub `docker` first on PATH, so a live cage's
// script runs locally and the SIGINT is genuine; §2–§7 run against DATABASE_URL with real rows, torn
// down in a finally; §8 renders the real component through esbuild + SSR. PROVISION_MODE stays
// 'simulate' throughout, so nothing here can reach a machine.
import { execFileSync, spawn } from 'node:child_process';
import { build as esbuild } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }
process.env.PROVISION_MODE = 'simulate';   // never reach a real cage from a test
process.env.TKB_NOTIFY = '0';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
let fail = 0;
let skipped = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };
const skip = (m) => { console.log(`  – SKIP ${m}`); skipped++; };
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const client = new pg.Client({ connectionString: url });
const tmp = mkdtempSync(join(tmpdir(), 'fleetpause-'));
const PID = '00000000-0000-4000-8000-0000000f1000';
const XOURCE = '00000000-0000-4000-8000-0000000f1001';

const { cxellInterruptCommand } = await import('../server/src/lib/cxell.js');
const { HEADLESS_PROC_PATTERN, AGENT_PROC_PATTERN } = await import('../server/src/lib/cxell-runtimes.js');
const { hiveStatus, hiveLabel, HIVE_STATUS } = await import('../server/src/lib/hive-status.js');

// ── 1. the escalation script, run for real ────────────────────────────────────────────────────────
// Everything here is deliberately run FROM FILES (`bash /tmp/x.sh`), never `bash -c '…'`: a wrapper
// whose own command line carries the literal text `claude --bare -p` would be matched by the probe and
// killed alongside the fake agent, and the test would pass for the wrong reason. That is not a
// hypothetical — writing this test the first way killed its own shell.
console.log('\n── the interrupt: SIGINT, then SIGTERM, then say it did NOT stop ──');
const cmd = cxellInterruptCommand({ graceMs: 1500 });

ok(cmd.includes(HEADLESS_PROC_PATTERN),
   'the pattern is HEADLESS_PROC_PATTERN — the queenzee\'s own turn, byte-for-byte the one zee-attach.sh probes');
ok(!cmd.includes(AGENT_PROC_PATTERN),
   'and NOT the broad agent pattern: a pause must not kill the interactive session a human is typing in');
ok(!new RegExp(HEADLESS_PROC_PATTERN).test(cmd),
   'the command CANNOT match its own text — otherwise pkill takes out its own wrapper and the agent survives '
   + 'a "successful" pause (the brackets in the pattern are what make this true)');
ok(cmd.indexOf('pkill -INT') < cmd.indexOf('pkill -TERM'),
   'SIGINT is tried before SIGTERM — the polite stop first, exactly the Ctrl-C a human would type');
ok(/__ZEE_INT_IDLE__/.test(cmd) && cmd.indexOf('__ZEE_INT_IDLE__') < cmd.indexOf('pkill'),
   'nothing running short-circuits to IDLE before any signal (a zee between turns is not a failure to stop)');
ok(cmd.trimEnd().endsWith('echo __ZEE_INT_STUCK__'),
   'the LAST word is STUCK: a run that survived both signals is reported, never rounded up to stopped');

const shFile = (name, body) => { const p = join(tmp, name); writeFileSync(p, body); return p; };
// A fake agent whose COMMAND LINE matches the probe (`exec -a` sets argv0), so the real pkill has a
// real target. It is a `sleep`, so SIGINT ends it — the ordinary case.
const fakeAgent = shFile('fake-agent.sh', "exec -a 'claude --bare -p' sleep 600\n");
// …and one that IGNORES both signals: bash with INT/TERM trapped, carrying the pattern in its argv so
// the probe finds it. This is the STUCK path, which must be reported rather than papered over.
const stuckAgent = shFile('stuck-agent.sh',
  "trap '' INT TERM\nprintf 'claude --bare -p\\n' > /dev/null\nwhile :; do sleep 1; done\n");
const runner = shFile('interrupt.sh', `${cmd}\n`);

const haveProcps = (() => {
  try { execFileSync('bash', ['-lc', 'command -v pgrep >/dev/null && command -v pkill >/dev/null']); return true; }
  catch { return false; }
})();
const alive = () => {
  try { execFileSync('pgrep', ['-f', HEADLESS_PROC_PATTERN], { stdio: 'pipe' }); return true; }
  catch { return false; }
};
const runInterrupt = () => execFileSync('bash', [runner], { encoding: 'utf8' });

if (!haveProcps) {
  skip('pgrep/pkill are absent — the escalation can only be asserted as text on this host');
} else {
  ok(!alive(), 'no agent-shaped process is running before the test starts (a clean baseline)');
  const idle = runInterrupt();
  ok(/__ZEE_INT_IDLE__/.test(idle), 'with nothing running the real script answers IDLE');

  const child = spawn('bash', [fakeAgent], { detached: true, stdio: 'ignore' });
  child.unref();
  await sleep(400);
  ok(alive(), 'the fake agent is running and the probe can see it');
  const out = runInterrupt();
  ok(/__ZEE_INT_SIGINT__/.test(out), `SIGINT stopped it and the script says so (${out.trim() || 'no output'})`);
  ok(!alive(), 'and it really is gone — the verdict is not the only evidence');

  const stuck = spawn('bash', [stuckAgent, 'claude --bare -p'], { detached: true, stdio: 'ignore' });
  stuck.unref();
  await sleep(400);
  if (!alive()) {
    skip('could not build a signal-ignoring process on this host — the STUCK path stays text-only');
  } else {
    const out2 = runInterrupt();
    ok(/__ZEE_INT_STUCK__/.test(out2),
       'a run that survives SIGINT *and* SIGTERM is reported STUCK, not as a stopped zee');
    try { execFileSync('pkill', ['-KILL', '-f', HEADLESS_PROC_PATTERN]); } catch { /* already gone */ }
    await sleep(200);
    ok(!alive(), 'test cleanup: the signal-ignoring process is killed');
  }
}

// ── 1b. interruptCxellZee, end to end, against a FAKE docker on PATH ──────────────────────────────
// The one hop §1 cannot reach from inside a cage (there is no docker CLI in here, by design) is the
// exec itself: which verdict the driver returns, and — the part with real teeth — how it classifies an
// exec that returned NO verdict. A cage whose container is already gone must count as "no turn to
// stop"; anything else uninterpretable must NOT be reported as a stopped zee. dk() spawns docker BY
// NAME, so a stub first on PATH exercises the whole function for real: for a live cage the stub simply
// runs the script locally, which makes the SIGINT below a genuine signal against a genuine process.
console.log('\n── interruptCxellZee: the verdict, and what an unreadable answer must NOT become ──');
const bin = join(tmp, 'bin');
mkdirSync(bin);
writeFileSync(join(bin, 'docker'),
  '#!/bin/sh\n'
  + '# $1=exec  $2=container  $3..=bash -lc <script>\n'
  + 'case "$2" in\n'
  + '  gone_*)  echo "Error response from daemon: No such container: $2" >&2; exit 1 ;;\n'
  + '  weird_*) echo "something nobody has seen before" >&2; exit 1 ;;\n'
  + 'esac\n'
  + 'shift 2\n'
  + 'exec "$@"\n', { mode: 0o755 });
const realPath = process.env.PATH;
process.env.PATH = bin + ':' + realPath;
const { interruptCxellZee } = await import('../server/src/lib/cxell.js');
try {
  if (!haveProcps) {
    skip('no pgrep/pkill — the driver half needs them to have anything to interrupt');
  } else {
    let r = await interruptCxellZee({ slug: 'live-1', graceMs: 1500 });
    ok(r.stopped && r.idle && !r.gone, 'a live cage with no turn running → stopped, idle, not gone');

    const c2 = spawn('bash', [fakeAgent], { detached: true, stdio: 'ignore' });
    c2.unref();
    await sleep(400);
    r = await interruptCxellZee({ slug: 'live-1', graceMs: 1500 });
    ok(r.stopped && !r.idle && r.how === 'sigint', 'a live cage mid-turn → stopped by SIGINT, reported as such');
    ok(!alive(), 'and the process really did die (a real signal, not a mocked one)');
  }

  const gone = await interruptCxellZee({ slug: 'gone-1', name: 'gone_cxell', graceMs: 500 });
  ok(gone.stopped && gone.idle && gone.gone === true,
     'a cage the daemon says does not EXIST counts as "no turn to stop", not as a failure to stop — '
     + 'otherwise one stale zee row makes every pause on a healthy fleet cry wolf');

  let threw = null;
  try { await interruptCxellZee({ slug: 'weird-1', name: 'weird_cxell', graceMs: 500 }); }
  catch (e) { threw = e.message; }
  ok(threw !== null,
     'an answer nobody can interpret THROWS rather than reporting a stop: ' + String(threw).slice(0, 60));
} finally {
  process.env.PATH = realPath;
}

// ── the db-backed half ────────────────────────────────────────────────────────────────────────────
async function cleanup({ files = false } = {}) {
  try { await client.query(`DELETE FROM project WHERE id=$1`, [PID]); } catch { /* */ }
  try { await client.query(`UPDATE fleet_pause SET paused=false, paused_at=NULL, paused_by=NULL, reason=NULL WHERE id=true`); } catch { /* */ }
  if (files) { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } }
}

try {
  await client.connect();
  await cleanup();

  const repo = join(tmp, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'master');
  git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
  writeFileSync(join(repo, 'README.md'), '# fleet pause test\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'base');

  await client.query(
    `INSERT INTO project (id, name, repo_root, main_branch, db_name, db_user)
       VALUES ($1,'fleetpause-test',$2,'master','fptest','postgres')`, [PID, repo]);
  await client.query(`INSERT INTO xource (id, project_id, ref) VALUES ($1,$2,'master')`, [XOURCE, PID]);

  // Two live cxells: a WORKER and a MANAGER. The manager is not decoration — "including manager zees"
  // is half the task, and a manager left running keeps dispatching into a stopped crew.
  const mkXell = async (slug, zeeType) => (await client.query(
    `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status, is_pooled, zee_type)
       VALUES ($1,$2,$3,$4,$5,'working',false,$6) RETURNING *`,
    [PID, XOURCE, slug, `spinoff/${slug}`, join(tmp, slug), zeeType])).rows[0];
  // claude_session_id is UNIQUE across the whole table (one session, one zee) — so each test zee gets
  // its own, seeded from the slug rather than a constant.
  let sidN = 0;
  const mkZee = async (xell, extra = {}) => (await client.query(
    `INSERT INTO zee (xell_id, attach_mode, viewer_kind, viewer_url, status, kind, entrypoint,
                      claude_session_id, cwd, last_stop_reason)
       VALUES ($1,'headless-spawn','ssh-terminal',$2,$3,'headless','cxell-cli',$4,$5,$6) RETURNING *`,
    [xell.id, 'ssh://zee@127.0.0.1:2299', extra.status || 'working',
     `11111111-2222-4333-8444-55555555555${++sidN}`, xell.worktree_path, extra.stop || null])).rows[0];

  const w = await mkXell('fleetpause-w1', 'worker');
  const m = await mkXell('fleetpause-mgr', 'manager');
  const wz = await mkZee(w);
  const mz = await mkZee(m);

  const { pauseState, fleetPaused, setPaused, forgetPauseCache, PAUSED_STOP_REASON, PAUSED_REASON }
    = await import('../server/src/lib/fleet-pause.js');
  const { pauseFleet, resumeFleet } = await import('../server/src/queenzee/pause.js');
  const nudge = await import('../server/src/queenzee/nudge.js');
  const { spawnHeadless } = await import('../server/src/queenzee/intake.js');
  const { getFleet } = await import('../server/src/lib/fleet.js');
  const { selfStatus } = await import('../server/src/queenzee/self.js');

  // ── 2. the flag: one row, and it outlives the click ─────────────────────────────────────────────
  console.log('\n── the flag: a singleton that survives a restart ──');
  ok((await pauseState()).paused === false, 'a fresh fleet is not paused');
  try {
    await client.query(`INSERT INTO fleet_pause (id, paused) VALUES (false, true)`);
    ok(false, 'a SECOND pause row is refused by the schema');
  } catch (e) {
    ok(/check|constraint|primary key|duplicate/i.test(e.message),
       `a SECOND pause row is refused by the schema — "is the fleet paused" cannot have two answers (${e.message.split('\n')[0].slice(0, 60)})`);
  }
  await setPaused(true, { by: 'test@console', reason: 'rate limit' });
  const st = await pauseState();
  ok(st.paused && st.by === 'test@console' && st.reason === 'rate limit',
     'the flag records WHO paused and WHY — the reason rides into every resumed zee\'s prompt');
  ok(st.since instanceof Date || typeof st.since === 'string', 'and WHEN, so play can say how long it was down');
  forgetPauseCache();
  ok(await fleetPaused() === true, 'the hot-path read agrees with the row (and re-reads it after the cache is dropped)');
  await setPaused(false, { by: 'test@console' });
  ok((await pauseState()).paused === false && (await pauseState()).reason === null,
     'lowering it clears the reason too — a stale "why" outliving the pause is a lie on the banner');

  // ── 3. the gates: while paused, NOTHING starts a turn ───────────────────────────────────────────
  console.log('\n── the gates: every door that starts a turn is shut ──');
  await setPaused(true, { by: 'test@console', reason: 'gate check' });

  let dispatchErr = null;
  try { await spawnHeadless({ projectId: PID, xellId: w.id, task: 'do a thing' }); }
  catch (e) { dispatchErr = e.message; }
  ok(dispatchErr && /paused/i.test(dispatchErr),
     `a DISPATCH is refused while paused, with the reason (${String(dispatchErr).slice(0, 60)}…)`);
  ok(dispatchErr && dispatchErr.includes('play'),
     'and the refusal says how to undo it (press play) rather than just "no"');

  const statusNudge = await nudge.nudgeXellForStatus(w.id, { by: 'test' });
  ok(statusNudge.nudged === false && statusNudge.paused === true,
     'the status nudge (typed keystrokes) is refused — a `status?` poke would restart the zee');

  const msg = await nudge.sendMessageToXell(w.id, { text: 'hello', by: 'test' });
  ok(msg.sent === false && msg.paused === true,
     'an operator/manager MESSAGE is refused, not queued: a queued one would be typed in later and '
     + 'restart the very zee the operator stopped');

  const reflect = await nudge.nudgeXellForReflection(w.id, { commit: 'abc1234' });
  ok(reflect.nudged === false && reflect.paused === true, 'the post-ship reflection nudge is held too');

  // The stale-landing and clearance nudges degrade an undelivered call to a TEND ("a human is needed
  // here"). While paused that would summon the very human who pressed the button, once per xell.
  const staleR = await nudge.nudgeXellForStaleLanding(w.id, { sha: 'deadbeefcafe', ref: 'refs/heads/master' });
  ok(staleR.paused === true && !staleR.tended,
     'a stale landing does NOT raise a tend while paused — nothing was attempted, so there is nothing to escalate');
  const tends = await client.query(
    `SELECT 1 FROM session_event WHERE xell_id=$1 AND hook_event_name='tend-request'`, [w.id]);
  ok(tends.rowCount === 0, 'and no tend was written to the xell (the console stays clean during a pause)');
  const clearedR = await nudge.nudgeXellForClearedRunway(w.id, { sha: 'deadbeefcafe', ref: 'refs/heads/master' });
  ok(clearedR.paused === true && !clearedR.tended, 'a runway clearance is held the same way');

  // …and the ONE call that must still get through, because it IS the unpause.
  const resumeNudge = await nudge.nudgeXellForFleetResume(w.id, { minutes: 3, reason: 'gate check' });
  ok(resumeNudge.paused !== true,
     'the PLAY nudge is NOT refused by the pause gate — the button would otherwise be unpressable');
  ok(resumeNudge.dry_run === true,
     'and in simulate mode it says it only MODELLED the resume (this queenzee stops/starts no real cage)');

  // ── 4. the fan-out, and what it is allowed to claim ────────────────────────────────────────────
  console.log('\n── the fan-out: workers and managers alike, and an honest receipt ──');
  await setPaused(false, { by: 'test@console' });
  const pausedR = await pauseFleet({ by: 'test@console', reason: 'sweep check' });
  ok(pausedR.paused === true && (await pauseState()).paused === true, 'pause raises the flag');
  const slugs = pausedR.xells.map((x) => x.slug);
  ok(slugs.includes('fleetpause-w1') && slugs.includes('fleetpause-mgr'),
     `the sweep covers every live cxell — the MANAGER included (${slugs.join(', ')})`);
  ok(pausedR.xells.every((x) => x.dry_run) && pausedR.dry_run === true,
     'in simulate mode it reports what it WOULD have stopped and claims no interrupt it did not perform');
  ok(pausedR.counts.interrupted === 0,
     'so the interrupted count is 0, not "2 stopped" — the count a human trusts must not include a model');

  // Play must call back the zees the pause STOPPED and nobody else. Mark only the worker (which is what
  // a real interrupt does) and leave the manager as a zee that was already between turns.
  await client.query(`UPDATE zee SET last_stop_reason=$2 WHERE id=$1`, [wz.id, PAUSED_STOP_REASON]);
  await client.query(`UPDATE zee SET last_stop_reason='end_turn' WHERE id=$1`, [mz.id]);
  const resumed = await resumeFleet({ by: 'test@console' });
  ok(resumed.paused === false && (await pauseState()).paused === false, 'play lowers the flag');
  ok(resumed.xells.length === 1 && resumed.xells[0].slug === 'fleetpause-w1',
     'and calls back ONLY the zee the pause interrupted — a zee that had finished its turn is left alone');
  ok(resumed.counts.nudged === 0 && resumed.xells[0].dry_run === true,
     'a resume that was only modelled counts as 0 called back (it must not claim delivery it did not get)');
  ok(resumed.counts.dry_run === 1 && resumed.counts.failed === 0,
     'and it is counted as MODELLED, not FAILED — a resume that went exactly as designed must not put a '
     + 'red warning on the operator\'s receipt (the same cry-wolf rule as a gone cage)');
  const stillMarked = await client.query(`SELECT last_stop_reason FROM zee WHERE id=$1`, [wz.id]);
  ok(stillMarked.rows[0].last_stop_reason === PAUSED_STOP_REASON,
     'and the zee keeps its paused mark, so a second press of play tries it again rather than losing it');

  // ── 4b. THE ZEE THE PAUSE NEVER INTERRUPTED, AND WOULD HAVE STRANDED ───────────────────────────
  // A zee's turn ENDS at `zee land`, so a zee waiting on a landing is between turns: the pause has
  // nothing to interrupt and does not mark it. But a human at the console keeps deciding while the
  // fleet is stopped, and every one of those decisions reaches its zee through a NUDGE — which the
  // pause refuses. Approve a landing during a pause and, without this, the "you are on main, carry on"
  // is dropped and play does not call that zee back either: it waits forever for a message that was
  // thrown away. So a refused wake-up is RECORDED, and play treats it as a second reason to resume.
  console.log('\n── a wake-up refused during the pause is not a wake-up lost ──');
  await setPaused(true, { by: 'test@console', reason: 'held-nudge check' });
  // the manager is deliberately the subject here: between turns, never interrupted, nothing marked
  await client.query(`UPDATE zee SET last_stop_reason='end_turn', status='idle' WHERE id=$1`, [mz.id]);
  await client.query(`UPDATE zee SET last_stop_reason='end_turn', status='idle' WHERE id=$1`, [wz.id]);
  // §3 refused half a dozen nudges at the WORKER, and every one of those legitimately recorded a held
  // wake-up for it — so clear the worker's record here to get back to the case being tested: one zee
  // owed a call, one zee owed nothing. (That §3 left a record at all is the mechanism working.)
  await client.query(
    `INSERT INTO session_event (source, hook_event_name, xell_id) VALUES ('test','nudge-held-clear',$1)`, [w.id]);
  const landNudge = await nudge.nudgeXellAfterLand(m.id, { by: 'test@console' });
  ok(landNudge.paused === true && landNudge.held === true,
     'a landing-approved nudge during the pause is HELD — and says it was held, not merely refused');
  const heldRows = await client.query(
    `SELECT hook_event_name FROM session_event WHERE xell_id=$1 AND hook_event_name='nudge-held'`, [m.id]);
  ok(heldRows.rowCount === 1, 'and it is RECORDED against the xell (append-only, like tend and the hints)');

  const resumed2 = await resumeFleet({ by: 'test@console' });
  const called = resumed2.xells.map((x) => x.slug);
  ok(called.includes('fleetpause-mgr'),
     'play calls that zee back even though the pause never interrupted it — this is the stranding the '
     + 'record exists to prevent');
  ok(!called.includes('fleetpause-w1'),
     'and still leaves alone the zee with neither a mark nor a held wake-up (a pause must not wake a '
     + 'zee that had legitimately finished)');
  ok(resumed2.xells.find((x) => x.slug === 'fleetpause-mgr')?.why === 'a wake-up was held',
     'the receipt says WHICH of the two reasons called it back');
  // Not delivered (simulate) → the record must SURVIVE, so the next press tries again.
  const stillHeld = await client.query(
    `SELECT hook_event_name FROM session_event WHERE xell_id=$1
        AND hook_event_name IN ('nudge-held','nudge-held-clear') ORDER BY ts DESC LIMIT 1`, [m.id]);
  ok(stillHeld.rows[0].hook_event_name === 'nudge-held',
     'a resume that was only modelled does NOT clear the record — it is cleared by delivery, so nothing '
     + 'is dropped on a queenzee that stops no real cage');

  // ── 5. the hexagon: a paused zee must not read as idle ──────────────────────────────────────────
  console.log('\n── the hive vocabulary: paused is its own word ──');
  ok(!!HIVE_STATUS['occ-paused'] && hiveLabel('occ-paused') === 'paused',
     'the server vocabulary has occ-paused, labelled as a STATE (nobody is being asked anything)');
  const xw = { status: 'working', zee_status: 'working' };
  ok(hiveStatus(xw, { paused: true }) === 'occ-paused',
     'a paused zee reads `paused`, not `working` — the turn really did stop');
  ok(hiveStatus({ status: 'idle', zee_status: 'idle' }, { paused: true }) === 'occ-paused',
     'and not `idle`, which is indistinguishable from a zee that finished');
  ok(hiveStatus(xw, { paused: false }) === 'occ-working', 'without the signal nothing changes');
  for (const [sig, key] of [['landPending', 'occ-landRequest'], ['shipPending', 'occ-shipRequest'],
                            ['tendPending', 'occ-tendRequest'], ['prodBindPending', 'occ-prodRequest'],
                            ['seedPending', 'occ-seedRequest'], ['doneSuggested', 'occ-doneSuggest'],
                            ['landHint', 'occ-landHint'], ['shipHint', 'occ-shipHint'],
                            ['landHolding', 'occ-landHolding']]) {
    ok(hiveStatus(xw, { paused: true, [sig]: true }) === key,
       `${sig} still outranks paused (${key}) — a decision waiting on a human must never be hidden by the pause`);
  }
  const palette = read('web/src/hive/status.js');
  for (const block of ['HIVE_COLORS', 'HIVE_HEAT', 'HIVE_LABELS']) {
    ok(new RegExp(`${block} = \\{[^}]*'occ-paused'`, 's').test(palette), `the web palette's ${block} carries it`);
  }

  // ── 6. the read models: a human and a zee both see it ──────────────────────────────────────────
  console.log('\n── the read models: the console and `zee status` both say so ──');
  await setPaused(true, { by: 'test@console', reason: 'read models' });
  await client.query(`UPDATE zee SET last_stop_reason=$2, status='idle' WHERE id=$1`, [wz.id, PAUSED_STOP_REASON]);
  const fleet = await getFleet(PID);
  ok(fleet.pause?.paused === true && fleet.pause.by === 'test@console',
     'the /fleet snapshot carries the pause, so the button and banner ride the poll every other control rides');
  const rowW = fleet.xells.find((x) => x.slug === 'fleetpause-w1');
  const rowM = fleet.xells.find((x) => x.slug === 'fleetpause-mgr');
  ok(rowW?.hive_status === 'occ-paused', 'the interrupted xell renders as paused on the hive');
  ok(rowM?.hive_status !== 'occ-paused',
     'a xell whose zee was NOT interrupted does not — the flag alone must not paint the whole hive '
     + '(it would tell the operator they stopped work that had already finished)');

  const self = await selfStatus((await client.query(`SELECT * FROM xell WHERE id=$1`, [w.id])).rows[0]);
  ok(self.fleet_pause?.paused === true && self.fleet_pause.paused_here === true,
     '`zee status` says the fleet is paused AND that THIS zee is one it stopped — the resume prompt sends '
     + 'every zee here, so silence would be the one thing it must not answer with');
  ok(/nothing of yours failed/i.test(self.fleet_pause.note || ''),
     'and it says the interrupt was not a failure, because from inside a killed turn that is indistinguishable');
  ok(self.xell.hive_status === 'occ-paused', 'the zee sees the same hexagon a human does');

  // ── 7. the wiring nobody notices until it is missing ───────────────────────────────────────────
  console.log('\n── the wiring: a button, a route, and no verb for a zee ──');
  const routes = read('server/src/api/routes.js');
  ok(/router\.post\('\/fleet\/pause'/.test(routes) && /router\.post\('\/fleet\/resume'/.test(routes),
     'the API has both verbs');
  ok(/router\.get\('\/fleet\/pause'/.test(routes), 'and a GET for a client that wants just the flag');
  // Matched against ROUTE DEFINITIONS and the CLI's verb table, not prose: the comment above those
  // routes explains why no such verb exists, and a regex loose enough to read that as one is a lint
  // that fails on its own documentation.
  ok(!/router\.[a-z]+\('\/xell\/self\/(pause|resume)/.test(routes)
     && !/^\s*(pause|play)\)/m.test(read('scripts/zee')),
     'there is NO pause verb for a ZEE, in the API or the CLI — a zee that can stop the fleet can stop '
     + 'the zee that would land its rival\'s work; everything a zee does here is ASK, never act');
  const app = read('web/src/App.jsx');
  ok(/<FleetPause\s/.test(app) && /pause=\{fleet\.pause\}/.test(app),
     'the console renders the button from the fleet snapshot');
  // The control is its OWN component file (like ModeChip/CrewChip), not another few hundred lines of
  // App.jsx — which is also what lets §8 below render it.
  const ctl = read('web/src/FleetPause.jsx');
  ok(/data-testid="fleet-pause-btn"/.test(ctl) && /data-testid="fleet-paused-banner"/.test(ctl),
     'as a button AND, while paused, a banner — a paused fleet looks exactly like a quiet one');
  // `unreachable` is already every cage not confirmed stopped, stuck ones included. Adding `stuck` to
  // it reports one zee twice, and a figure a human cannot reconcile against the log is worse than none.
  ok(/const bad = kind === 'pause' \? \(c\.unreachable \|\| 0\) :/.test(ctl),
     'and its "not confirmed stopped" figure is `unreachable` alone — never unreachable + stuck, which '
     + 'would count the same zee twice');
  const api = read('web/src/api.js');
  ok(/export async function pauseFleet/.test(api) && /export async function resumeFleet/.test(api),
     'the client has both calls');
  ok(/'fleet-pause'\]/.test(api),
     "and 'fleet-pause' rides the SSE change list — a pause on an empty fleet moves nothing else, so "
     + 'without it every other tab keeps showing the wrong button');

  // ── 8. the control, RENDERED ────────────────────────────────────────────────────────────────────
  // Static greps prove the props are passed; they cannot prove the thing draws. Both states are
  // rendered through the same esbuild+SSR seam the board test uses, because the paused state is the
  // one an operator has to read at a glance and it is the one that only appears when things are wrong.
  console.log('\n── the control, rendered in both states ──');
  const outDir = mkdtempSync(join(ROOT, '.fleetpause-render-'));
  try {
    const bundle = join(outDir, 'bundle.mjs');
    await esbuild({
      stdin: { contents: "export { default as FleetPause } from './web/src/FleetPause.jsx';\n",
               resolveDir: ROOT, sourcefile: 'render-entry.js', loader: 'js' },
      bundle: true, format: 'esm', outfile: bundle, jsx: 'automatic', logLevel: 'silent',
      external: ['react', 'react-dom', 'react/jsx-runtime'],
    });
    const { FleetPause } = await import(pathToFileURL(bundle).href);
    const render = (pause) => renderToStaticMarkup(
      React.createElement(FleetPause, { pause, onChanged: () => {}, pushToast: () => {}, dismissToast: () => {} }));

    const running = render({ paused: false });
    ok(/⏸ pause/.test(running), 'running: the button offers PAUSE');
    ok(!/fleet-paused-banner/.test(running), 'and there is no banner (nothing to warn about)');
    ok(/every zee/i.test(running) && /managers included/i.test(running),
       'its tooltip says what it will actually do — every zee, managers included');

    const paused = render({ paused: true, by: 'mark@console', reason: 'rate limit', interrupted: 7 });
    ok(/▶ play/.test(paused), 'paused: the same button offers PLAY');
    ok(/class="fleetpause paused"/.test(paused), 'and carries the paused class the loud styling hangs off');
    ok(/FLEET PAUSED by mark@console/.test(paused) && /7 zee\(s\) stopped/.test(paused) && /rate limit/.test(paused),
       'the banner says who stopped it, how many zees, and why');

    // A snapshot from a server too old to carry fleet.pause must not blank the console.
    ok(/⏸ pause/.test(renderToStaticMarkup(React.createElement(FleetPause,
        { pause: undefined, onChanged: () => {}, pushToast: () => {}, dismissToast: () => {} }))),
       'and with no pause in the snapshot at all it renders as running rather than throwing');
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }

} finally {
  await cleanup({ files: true });
  await client.end().catch(() => {});
}

console.log(fail ? `\n${fail} FAILED` : `\nall good${skipped ? ` (${skipped} skipped)` : ''}`);
process.exit(fail ? 1 : 0);
