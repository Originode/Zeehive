// AFTER THE MACHINE COMES BACK — restart the cages the reboot stopped, and RECONNECT the zees that
// were mid-turn inside them.
//
// WHAT ACTUALLY HAPPENS WHEN THE ZEEHIVE HOST RESTARTS. The app tier returns on its own (compose
// restart policies bring the queenzee, the console and the fleet's own containers back), and the
// CXELLS DO NOT: intake.js runs them with `docker run -d … sleep infinity` and NO restart policy, so
// every live xell's cage comes back EXITED. Nothing else in the fleet notices — the reaper skips
// them, the health monitor watches fleet containers rather than cages, and the poller has no opinion
// about a xell whose zee simply stopped speaking. The visible symptom is a dashboard full of xells
// that look alive, with terminals that will not open and agents that never say another word.
//
// AND EVEN A CAGE THAT COMES BACK IS NOT WHOLE, which is the part a restart policy cannot fix (see
// the long note in lib/cxell.js): sshd is a process the queenzee EXECS at spawn (cxell-sshd.sh) and
// the egress seal is iptables rules in the container's OWN network namespace (cxell-firewall.sh).
// Both are RUNTIME state. A cage restarted by dockerd alone comes up with no attend door and — the
// dangerous half — NO FIREWALL: default-allow egress with the fleet's live production databases
// reachable again. So the restart is performed HERE, in the queenzee, in one order that is a safety
// property rather than a preference:
//
//     1. docker start          — the cage, with its disk, its port, its network, its commits
//     2. cxell-sshd.sh         — the attend door (no env passed: see restartCxellSshd)
//     3. cxell-firewall.sh     — THE SEAL, with the same block list the spawn uses
//     4. …only THEN may a turn be resumed in it.
//
// THE OTHER HALF OF "RECONNECT", and the reason a cage restart alone is not enough. A zee whose turn
// the reboot killed is left with status='working' — a turn lock that no longer has a turn behind it
// (lib/turn-record.js claimZeeTurn refuses every resume while it is set), and an open zee_turn ledger
// row that will never be closed. That zee is unreachable FOREVER: a message queues instead of
// resuming (decideMessageDelivery), a landing approval cannot reach it, the reviver cannot revive it.
// So for the cages this loop restarted, the phantom turn is ENDED honestly — the zee row marked
// 'errored', the ledger row closed as errored and unmetered — and the death is filed with
// HOST_RESTART_DEATH, which puts it on the SAME revive ladder a 529 gets: 5/15/45 minutes, three
// attempts, then a human. That reuse is deliberate. The ladder already knows how not to resume a
// paused fleet, a decommissioned zee, a retired xell or the same zee twice, and re-implementing any
// of that here would be a second policy to keep in step with the first.
//
// WHAT IT WILL NOT DO:
//   • it never CREATES a cage. A 'missing' container is reported, never rebuilt: recreating one
//     would destroy work that was never collected, and re-dispatching is a human's decision.
//   • it never restarts a cage whose xell is retired/tearing-down, or whose zee is decommissioned.
//   • it says NOTHING about a cage it could not probe. A docker daemon that is still coming up
//     answers nothing, and the containers.js doctrine is absolute: a probe that cannot run is
//     UNKNOWN, never a false 'down' — a false down here would restart nothing and log a fleet
//     outage that is not happening. The next tick asks again.
//   • it never resumes a turn in a cage it could not SEAL — it stops that cage again (a stop is not
//     a teardown; nothing of the zee's is lost) and raises a human, because a running cage with no
//     iptables rules is strictly more exposed than the stopped one it found.
//
// AND WHAT IT CANNOT SEE AT ALL — the reason restartXellCxell (at the bottom) exists. Every verdict
// above is read off `docker inspect`, so the cage that is RUNNING while nothing inside it works —
// sshd dead, the agent hung, the turn silent — is the sweep's happiest case and the operator's worst
// one. That one needs a human to say "it is wedged", which is a button in the console, not a loop.
import { q, one } from '../db/pool.js';
import { logline } from '../lib/logbus.js';
import { broadcast } from '../lib/events.js';
import { recordEvent, setTend } from '../lib/status.js';
import { cxellName, cxellState, startCxell, stopCxell, restartCxellSshd, sealCxell,
         refreshZeeLiveInLiveCxells } from '../lib/cxell.js';
import { prodDbBlockList } from '../lib/cxell-seal.js';
import { markZeeTurn } from '../lib/turn-record.js';
import { MID_TURN_STATUSES } from '../lib/zee-turn.js';
import { endTurn } from '../lib/turn-ledger.js';
import { HOST_RESTART_DEATH, CAGE_RESTART_DEATH, MAX_REVIVE_ATTEMPTS } from '../lib/turn-death.js';
import { noteTurnDeath, cageRestartRevivePrompt } from './revive.js';
import { nudgeXellForTurnDeath } from './nudge.js';
import { xellPaused } from '../lib/fleet-pause.js';

// The same switch every other real-side-effect module reads. A NESTED queenzee's meta-DB is a CLONE
// of the fleet's, so the cages named by its rows are OTHER ZEES' LIVE CAGES — starting, re-sealing
// or resuming one of those is the exact accident PROVISION_MODE exists to prevent. In simulate it
// probes nothing and states what it would have done.
const PROVISION_MODE = process.env.PROVISION_MODE === 'real' ? 'real' : 'simulate';

// How often the fleet is re-checked after the boot pass. The boot pass is the one that matters (a
// host restart is a boot event, and this runs in the process that boots with the machine); the loop
// is for the cage that stops LATER — an OOM kill, a dockerd restart, someone's stray `docker stop`.
// Ten minutes: a stopped cage is an anomaly, not a queue, and each tick is one `docker inspect` per
// live xell.
const TICK_MS = Number(process.env.CXELL_RECOVER_INTERVAL_MS) || 600000;

// The docker states a stopped-but-present cage can be in. 'running' needs nothing; 'restarting' and
// 'removing' are mid-transition (asking again next tick is the only correct move); 'paused' is
// deliberate and `docker start` does not even undo it (`unpause` does) — leaving it alone keeps the
// one operation a human has for freezing a cage meaningful.
const STARTABLE = ['exited', 'created', 'dead'];

// What the zee row, the ledger and the tend RECORD as the cause of the turn that died. The sweep's
// (a machine went down) and the console button's (a human bounced this cage) — the same sentence in
// every place someone later reads to find out what happened to a turn.
const HOST_RESTART_REASON =
  'the zeehive machine restarted and stopped this cxell mid-turn; the queenzee started the cage '
  + 'again, re-opened its ssh door and re-applied its egress firewall';
const CAGE_RESTART_REASON = (by, forced) =>
  `${by} restarted this cxell by hand from the console`
  + (forced ? ' while it was still running (it had stopped answering)' : '')
  + '; the queenzee started the cage again, re-opened its ssh door and re-applied its egress firewall';

// One sweep at a time. Two overlapping sweeps would race on the same `docker start` (harmless) and
// on the same phantom-turn release (not harmless: two revive schedules for one zee).
let sweeping = false;

// Every live cxell the queenzee owns, newest zee per xell. Same shape as the boot renderer sweep's
// query, plus what the seal and the turn release need. INJECTABLE (see recoverStoppedCxells's
// `list`) for the same reason refreshZeeLiveInLiveCxells takes its lister: this sweep WRITES to the
// zee rows it visits, and a test run against a SHARED meta-DB must be able to say "these xells and
// no others" rather than reaching across somebody else's fleet.
// ONE definition of "a cage this module may touch", so the sweep and the console's single-xell
// button cannot drift into disagreeing about it — a manual restart that accepted a decommissioned
// zee or a tearing-down xell would be a hole in exactly the rules the sweep spells out above.
const CXELL_COLS = `x.id AS xell_id, x.slug, x.project_id, x.db_coupling, x.status AS xell_status,
                    z.id AS zee_id, z.status AS zee_status, z.claude_session_id`;
const CXELL_WHERE = `z.viewer_kind = 'ssh-terminal'
                     AND z.decommissioned_at IS NULL
                     AND z.entrypoint = 'cxell-cli'
                     AND x.status NOT IN ('retired', 'tearing-down')`;

export async function liveCxells() {
  return q(
    `SELECT DISTINCT ON (x.id) ${CXELL_COLS}
       FROM zee z JOIN xell x ON x.id = z.xell_id
      WHERE ${CXELL_WHERE}
      ORDER BY x.id, z.created_at DESC`);
}

// The same row for ONE xell (the console's button), newest zee, or null if this xell has no cage
// this module may touch.
async function cxellFor(xellId) {
  return one(
    `SELECT DISTINCT ON (x.id) ${CXELL_COLS}
       FROM zee z JOIN xell x ON x.id = z.xell_id
      WHERE ${CXELL_WHERE} AND x.id = $1
      ORDER BY x.id, z.created_at DESC`, [xellId]);
}

// END THE TURN THE REBOOT KILLED, so something can start another one.
//
// Two writes, both required, and the ledger one is not bookkeeping: the zee row's status is the turn
// LOCK (claimZeeTurn), and zee_turn's open row is what the observability tab replays. A turn killed
// by a power cut spent whatever it spent before the cut, and the provider never reported it — so the
// burn is booked as UNMETERED ZERO (`metered: false`) rather than as a measured zero, which is the
// distinction lib/turn-record.js UNMETERED_SUFFIX exists to keep truthful.
async function releasePhantomTurn({ zeeId, zeeStatus, slug, reason }) {
  if (!MID_TURN_STATUSES.includes(String(zeeStatus))) return { released: false, why: 'the zee was not mid-turn' };
  const burn = { cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, metered: false };
  await markZeeTurn(zeeId, 'errored', reason, burn);
  // The ledger row is found by zee, not by id: whoever opened it (intake's spawn, nudge's resume,
  // self.js's interactive turn) died with the machine and cannot close it. `ended_at IS NULL` makes
  // endTurn a one-shot, so a row somebody else already closed is left exactly as they closed it.
  const open = await one(
    `SELECT id FROM zee_turn WHERE zee_id = $1 AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1`,
    [zeeId]).catch(() => null);
  if (open) await endTurn(open.id, { status: 'errored', burn, stopReason: reason });
  logline('cxell-recover', `${slug}: released the turn lock the restart left behind `
    + `(zee was '${zeeStatus}'${open ? ', and closed its open turn row' : ''})`);
  return { released: true, turn_id: open?.id || null };
}

// Recover ONE xell's cage. Returns a verdict word so the sweep can count without re-deciding:
// 'running' | 'missing' | 'unknown' | 'held' | 'restarted' | 'unsealed' | 'failed' | 'would-restart'.
//
// The options past `reason`/`mode` are all the MANUAL restart's (restartXellCxell below), and they
// exist so a human's button runs THIS sequence rather than a second copy of it: `force` lets it stop
// a cage docker still calls running (the wedged case, which the sweep by design cannot see),
// `death`/`deathReason`/`unsealedLead` make everything a human or an agent reads say what actually
// happened, and `resumeNow` asks for the session back immediately instead of in five minutes.
async function recoverOne(row, { reason, mode, force = false, by = 'the queenzee',
                                 death = HOST_RESTART_DEATH, deathReason = HOST_RESTART_REASON,
                                 unsealedLead = 'after the zeehive machine came back',
                                 resumeNow = false, resumePrompt = null }) {
  const slug = row.slug;
  const probe = await cxellState({ ctx: 'default', slug });

  // A cage that is already up is the sweep's happy path and the manual button's question: docker
  // says RUNNING for a container whose sshd died, whose agent hung and whose turn has gone silent,
  // so `force` is the operator answering "yes, it is wedged, bounce it anyway".
  if (probe.state === 'running' && !force) return { slug, verdict: 'running' };
  if (probe.missing) {
    // Reported once per sweep and NEVER rebuilt: a cage that is gone took the zee's uncollected work
    // with it, and a fresh one wearing the same name would quietly claim to be it.
    logline('cxell-recover', `${slug}: its cxell (${cxellName(slug)}) is GONE — not recreated `
      + '(a new cage would have none of this zee\'s work); a human decides whether to re-dispatch');
    return { slug, verdict: 'missing' };
  }
  if (probe.state === 'unknown') return { slug, verdict: 'unknown', error: probe.error };
  if (probe.state !== 'running' && !STARTABLE.includes(probe.state)) {
    return { slug, verdict: 'held', state: probe.state };
  }

  if (mode !== 'real') {
    logline('cxell-recover', `${slug}: cxell is ${probe.state} — NOT restarted. PROVISION_MODE=simulate: `
      + `this queenzee models the fleet, and ${cxellName(slug)} is the REAL fleet's cage.`);
    return { slug, verdict: 'would-restart', state: probe.state };
  }

  // 0. THE FORCED STOP — only ever on the manual path, and only for a cage docker calls running.
  //    It is a stop, not a teardown: nothing of the zee's is removed, and the turn it kills is the
  //    turn the operator already decided was stuck. Everything below then treats this cage exactly
  //    like one a reboot stopped, which is the point.
  if (probe.state === 'running') {
    logline('cxell-recover', `${slug}: cxell is RUNNING and ${by} asked for a restart anyway — `
      + 'stopping it first (this ends whatever turn was live inside it)');
    await stopCxell({ ctx: 'default', slug });
  }

  // 1. THE CAGE.
  await startCxell({ ctx: 'default', slug });
  // 2. THE DOOR. Best-effort by itself — a cage with no sshd still runs turns (the queenzee resumes
  //    over `docker exec`, not ssh); what it loses is the human's attend terminal. Worth continuing
  //    for, worth saying out loud.
  let door = true;
  try { await restartCxellSshd({ ctx: 'default', slug }); }
  catch (e) { door = false; logline('cxell-recover', `${slug}: cxell is back but its ssh door did not re-open (${String(e.message).slice(0, 140)}) — the terminal will not attach`); }
  // 3. THE SEAL — the one step whose failure stops everything after it.
  let blockTcp = [];
  try {
    blockTcp = await prodDbBlockList({ projectId: row.project_id, dbCoupling: row.db_coupling });
    await sealCxell({ ctx: 'default', name: cxellName(slug), blockTcp });
  } catch (e) {
    // A RUNNING CAGE WITH NO SEAL IS WORSE THAN A STOPPED ONE, so the restart is UNDONE: default-allow
    // egress with the fleet's live production databases reachable is precisely what the firewall
    // exists to prevent, and the cage we found a moment ago could reach nothing at all. Stopping it
    // also makes the next tick a clean retry of the WHOLE sequence (start → door → seal → resume),
    // which is how this heals itself once whatever broke the seal is fixed. No turn is resumed
    // either way — that is the interlock, and it is not negotiable.
    let stopped = true;
    try { await stopCxell({ ctx: 'default', slug }); }
    catch (e2) { stopped = false; logline('cxell-recover', `${slug}: could not stop the unsealed cage again (${String(e2.message).slice(0, 140)})`); }
    const why = `This xell's cxell was restarted ${unsealedLead}, but its EGRESS `
      + `FIREWALL COULD NOT BE RE-APPLIED (${String(e.message).slice(0, 200)}). `
      + (stopped
        ? 'The queenzee STOPPED the cage again rather than leave it running with default-allow egress '
          + '(the fleet\'s production databases would be reachable from it), and did NOT resume the zee\'s '
          + 'turn. Nothing of the zee\'s work is lost — a stop is not a teardown. Fix what is refusing the '
          + 'firewall exec and the queenzee retries the whole restart on its next pass.'
        : 'The queenzee could not stop the cage again either, so it is RUNNING WITH DEFAULT-ALLOW EGRESS '
          + 'right now — the fleet\'s production databases are reachable from it. No turn was resumed. '
          + 'Seal or stop this cage by hand.');
    logline('cxell-recover', `${slug}: RESTARTED BUT NOT SEALED (${String(e.message).slice(0, 140)}) — `
      + `${stopped ? 'cage stopped again' : 'AND STILL RUNNING'}, no turn resumed, raised a tend`);
    await recordEvent({ source: 'queenzee', hook_event_name: 'cxell-recover', zee_id: row.zee_id,
                        xell_id: row.xell_id, raw: { slug, state: probe.state, reason, sealed: false,
                                                     stopped, error: String(e.message).slice(0, 300) } });
    await setTend(row.xell_id, true, { reason: why, zeeId: row.zee_id, source: 'queenzee' });
    return { slug, verdict: 'unsealed', stopped, error: e.message };
  }

  // 3b. THE ATTEND PATH, for the cage that was DOWN when this queenzee's boot sweep ran. index.js
  // refreshes the feed renderer + attach script in every RUNNING cxell at boot — which is also the
  // moment after a ship — and a stopped cage is invisible to it, so a xell that slept through a
  // deploy would keep the old pair until some later boot happened to catch it running. Best-effort
  // by contract (it never throws) and mode-gated inside; a file install is not egress, so its place
  // after the seal is bookkeeping rather than safety.
  await refreshZeeLiveInLiveCxells(async () => [{ ctx: 'default', name: cxellName(slug) }], { mode });

  logline('cxell-recover', `${slug}: cxell was ${probe.state} after ${reason} — RESTARTED, `
    + `ssh ${door ? 're-opened' : 'FAILED'}, re-sealed (${blockTcp.length} prod db(s) blocked)`);
  await recordEvent({ source: 'queenzee', hook_event_name: 'cxell-recover', zee_id: row.zee_id,
                      xell_id: row.xell_id, raw: { slug, state: probe.state, reason, sealed: true,
                                                   ssh: door, blocked: blockTcp.length } });

  // 4. THE ZEE. Only now, and only if the restart actually caught it mid-turn.
  const released = await releasePhantomTurn({ zeeId: row.zee_id, zeeStatus: row.zee_status, slug,
                                              reason: deathReason });
  if (!released.released) return { slug, verdict: 'restarted', resumed: false };
  // File it as the death it was. noteTurnDeath decides everything from here (and refuses a zee with
  // no session to resume, a paused fleet, a spent ladder…) — this loop holds no revive policy.
  const filed = await noteTurnDeath({ zeeId: row.zee_id, xellId: row.xell_id, slug,
                                      reason: deathReason, source: death.signal, death });
  // 5. THE RESUME, for the manual path only. The sweep leaves the ladder to do it (5 minutes is
  //    nothing to a machine that just rebooted, and a fleet coming back all at once should not
  //    resume every zee it owns in the same second) — but a human standing at the console who just
  //    unwedged a cage is WAITING, and five minutes of a blank terminal reads as "it did not work".
  //    So the manual path asks for the session back now, and the schedule noteTurnDeath just wrote
  //    is only cleared once the resume is actually delivered: if the nudge cannot land (a paused
  //    fleet, a runtime that cannot resume, a session id that was never captured), the ladder is
  //    left exactly as it is and picks the zee up in ~5 minutes with the same prompt.
  let resumed = !!filed?.scheduled;
  let now = false;
  // A REVIVE IS A TURN, so every level of the pause switch refuses it — and nudgeCxell enforces only
  // the FLEET-wide one, because the ladder (reviveTick) checks all three before it ever calls in.
  // This path skips the ladder, so it has to ask the same question: a human who paused one project
  // and then unwedges a cage in it wants the CAGE back, not a turn the pause is holding.
  const paused = resumeNow && filed?.scheduled
    ? await xellPaused({ id: row.xell_id, project_id: row.project_id }) : false;
  if (paused) {
    logline('cxell-recover', `${slug}: cage is back, but the fleet/project/xell is PAUSED — the resume is `
      + `HELD, not dropped (the ladder carries it, and play resumes it)`);
  }
  if (resumeNow && filed?.scheduled && !paused) {
    const r = await nudgeXellForTurnDeath(row.xell_id, {
      signal: death.signal, message: deathReason, attempt: 1, max: MAX_REVIVE_ATTEMPTS,
      mode, by, prompt: resumePrompt, why: `${by} restarted this cxell under the turn` });
    if (r?.nudged) {
      now = true;
      await q(`UPDATE zee SET revive_next_at = NULL, revived_at = now() WHERE id = $1`, [row.zee_id]);
      logline('cxell-recover', `${slug}: resumed the session in the restarted cage right away (${by} is waiting on it)`);
    } else {
      logline('cxell-recover', `${slug}: could not resume the session right away `
        + `(${r?.reason || r?.error || 'unknown'}) — left on the revive ladder, which retries in `
        + `${filed.in_minutes} minute(s)`);
    }
  }
  const zee = await one(`SELECT * FROM zee WHERE id=$1`, [row.zee_id]).catch(() => null);
  if (zee) broadcast('zee', zee);
  return { slug, verdict: 'restarted', resumed, resumed_now: now, held_paused: paused,
           in_minutes: now ? 0 : (filed?.in_minutes || null) };
}

// ONE SWEEP over every live cxell. Exported so the boot path, the loop and the test can all force a
// pass. NEVER throws: this runs during boot, and a queenzee that will not come up because a docker
// probe failed is a worse outage than the one it is recovering from.
export async function recoverStoppedCxells({ reason = 'boot', mode = PROVISION_MODE,
                                             list = liveCxells } = {}) {
  if (sweeping) return { skipped: 'a sweep is already running' };
  sweeping = true;
  const tally = { checked: 0, running: 0, restarted: 0, resumed: 0, missing: 0, unknown: 0,
                  held: 0, unsealed: 0, failed: 0, would_restart: 0, results: [] };
  try {
    const rows = await list();
    tally.checked = rows.length;
    for (const row of rows) {
      let r;
      try {
        r = await recoverOne(row, { reason, mode });
      } catch (e) {
        // ONE bad cage must never end the sweep — the whole point is the fleet, and the cage that
        // throws is usually the one whose xell most needs the next one to be tried.
        r = { slug: row.slug, verdict: 'failed', error: String(e.message).slice(0, 300) };
        logline('cxell-recover', `${row.slug}: could not be recovered (${String(e.message).slice(0, 160)})`);
      }
      tally.results.push(r);
      if (r.verdict === 'would-restart') tally.would_restart++;
      else tally[r.verdict] = (tally[r.verdict] || 0) + 1;
      if (r.resumed) tally.resumed++;
    }
    // ONE summary line, and only when there was something to say. A fleet whose cages are all
    // running writes nothing on every tick — silence here means "nothing stopped", which is the
    // state this loop hopes to be in.
    if (tally.restarted || tally.missing || tally.unsealed || tally.failed || tally.would_restart) {
      logline('cxell-recover', `${reason}: ${tally.checked} live cxell(s) checked — `
        + `${tally.restarted} restarted (${tally.resumed} zee(s) queued for a revive), `
        + `${tally.missing} gone, ${tally.unsealed} unsealed, ${tally.failed} failed`
        + (tally.would_restart ? `, ${tally.would_restart} would have been restarted (simulate)` : ''));
    }
    return tally;
  } catch (e) {
    logline('cxell-recover', `sweep failed (${String(e.message).slice(0, 160)})`);
    return { ...tally, error: e.message };
  } finally {
    sweeping = false;
  }
}

// ── THE MANUAL RESTART: one xell's cage, because a human pressed the button ───────────────────────
//
// WHY A BUTTON EXISTS AT ALL, when a loop already restarts stopped cages. The loop can only act on
// what docker will admit to: a cage that is `exited`. The failure an operator actually sits in front
// of is the other one — the container is RUNNING, the terminal will not attach, the agent has not
// said anything for an hour, and every automatic pass above walks straight past it as healthy
// ('running' is the sweep's first and cheapest verdict). Until now the only cure was a host session
// with a docker socket, which most operators of a hive do not have and no cxell zee ever has.
//
// It is the SAME sequence as the sweep — deliberately, down to the refusals: a missing cage is never
// recreated, an unprobeable one is never guessed at, a retired xell is refused, PROVISION_MODE gates
// the whole thing, and a cage that comes back but cannot be SEALED is stopped again with a tend
// raised and no turn resumed. What a human adds is the two things a loop must not decide for itself:
// FORCE (stop a cage docker still calls running — this kills the live turn, so the console asks
// first) and IMMEDIACY (resume the session now rather than on the 5-minute ladder).
//
// Returns { ok, verdict, … } and NEVER throws — the route reports the verdict as-is, because
// "already running", "gone", "paused fleet" and "sealed but not resumed" are all answers an operator
// needs to see rather than a 500.
export async function restartXellCxell(xellId, { by = 'a human', force = false,
                                                 mode = PROVISION_MODE } = {}) {
  try {
    const x = await one(`SELECT id, slug, status FROM xell WHERE id = $1`, [xellId]);
    if (!x) return { ok: false, verdict: 'no-xell', reason: 'no such xell' };
    const row = await cxellFor(xellId);
    if (!row) {
      // Two different "no" answers, and an operator staring at a dead terminal deserves the right
      // one: the xell is on its way out, or it never had a caged zee in the first place.
      return { ok: false, verdict: 'no-cxell', slug: x.slug,
               reason: ['retired', 'tearing-down'].includes(x.status)
                 ? `this xell is ${x.status} — its cxell has already been torn down`
                 : 'this xell has no live caged zee (no cxell to restart)' };
    }
    const forced = force;
    const r = await recoverOne(row, {
      reason: `a manual restart by ${by}`, mode, force, by,
      death: CAGE_RESTART_DEATH, deathReason: CAGE_RESTART_REASON(by, forced),
      unsealedLead: 'by hand from the console',
      resumeNow: true, resumePrompt: cageRestartRevivePrompt({ by }),
    });
    await recordEvent({ source: 'human', hook_event_name: 'cxell-restart', zee_id: row.zee_id,
                        xell_id: row.xell_id, raw: { slug: row.slug, by, force, mode, ...r } })
      .catch(() => {});
    return { ok: r.verdict === 'restarted' || r.verdict === 'would-restart', xell_id: row.xell_id, ...r };
  } catch (e) {
    logline('cxell-recover', `manual restart of xell ${String(xellId).slice(0, 8)} failed `
      + `(${String(e.message).slice(0, 160)})`);
    return { ok: false, verdict: 'failed', error: String(e.message).slice(0, 300) };
  }
}

// What the console shows BEFORE it asks. The confirm text has to be true — "this will end the turn
// running inside it" is only true for a cage that is actually up — so the button probes first
// rather than guessing from the dashboard's cached xell row. Read-only: one `docker inspect`, no
// mode gate (reading the fleet's state is not acting on it), and it NEVER throws.
export async function probeXellCxell(xellId) {
  try {
    const row = await cxellFor(xellId);
    if (!row) return { ok: false, verdict: 'no-cxell', state: null };
    const probe = await cxellState({ ctx: 'default', slug: row.slug });
    return { ok: true, slug: row.slug, name: cxellName(row.slug), state: probe.state,
             missing: !!probe.missing, error: probe.error || null,
             zee_status: row.zee_status,
             // "Restarting this ends a live turn" is this, and only this.
             mid_turn: MID_TURN_STATUSES.includes(String(row.zee_status)),
             mode: PROVISION_MODE };
  } catch (e) {
    return { ok: false, verdict: 'unknown', state: 'unknown', error: String(e.message).slice(0, 300) };
  }
}

// The loop, started from index.js with the other queenzee loops. The BOOT pass runs immediately —
// that is the pass a host restart needs, because this process comes back with the machine.
export function startCxellRecovery() {
  if (process.env.CXELL_RECOVER_ENABLED === 'false') {
    console.log('[queenzee] cxell recovery DISABLED (CXELL_RECOVER_ENABLED=false)');
    return null;
  }
  recoverStoppedCxells({ reason: 'boot' })
    .catch((e) => console.error('[cxell-recover] boot sweep failed:', e.message));
  setInterval(() => recoverStoppedCxells({ reason: 'tick' })
    .catch((e) => console.error('[cxell-recover] tick:', e.message)), TICK_MS);
  console.log(`[queenzee] cxell recovery started (${TICK_MS}ms) — restarts + re-seals cages a host restart stopped`);
  return true;
}
