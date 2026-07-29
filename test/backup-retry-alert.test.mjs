// A FAILED BACKUP MUST SHORTEN THE NEXT WINDOW, NOT CONSUME IT — ticket #26, and somebody must be told.
//
// THE BUG. backupDue() asked "is the newest attempt (any status) older than the policy interval?", so a
// FAILED attempt satisfied its window: one failure pushed the next good dump out by a full interval,
// two in a row cost a day with no restore point, and nothing said a word. Measured on the fleet
// 2026-07-29: omnibiz backs up every 12h, its last good dump was 07-28 18:30, the 19:32 attempt failed
// ("interrupted by server restart"), and the live restore point was ~27 HOURS old.
//
// WHY THIS TEST IS SHAPED LIKE THIS. The whole change is TIMING, and timing you can only reason about is
// timing you get wrong — so the decisions are pure functions driven here by an EXPLICIT CLOCK, never by
// waiting, sleeping or eyeballing the code. Three properties matter more than any single number:
//
//   1. STRICTLY SOONER. A failure can only ever bring the next attempt forward. There is no
//      configuration under which this change schedules an attempt LATER than the old behaviour did —
//      that is what makes it impossible for the fix to regress into the bug.
//   2. NO STORM, BY CONSTRUCTION. Simulated against a real 60-second tick over a full day of continuous
//      failure: the backoff must produce a handful of attempts, not one per tick. A backup takes the
//      prod window and moves gigabytes; hammering would be worse than the bug.
//   3. NEVER INTERRUPT. A running backup is not due at ANY age. An age-only rule would eventually call
//      a long dump overdue and start a second one on top of it.
//
// And the alert: bounded by the AGE OF THE RESTORE POINT (two policy intervals), not by the number of
// failures — because a failure a retry fixes ten minutes later cost nothing, and pinging on it is how an
// alert earns a mute. The first thing a noisy alert costs is the next real one.
process.env.MAINTENANCE_MODE = 'simulate';
process.env.MAINTENANCE_ENABLED = 'false';   // never arm the real scheduler under a test
process.env.TKB_NOTIFY = '0';                // and never ping a real device

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(resolve(here, '..', p), 'utf8');
let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };

const S = await import('../server/src/lib/backup-schedule.js');
const { q, one, pool } = await import('../server/src/db/pool.js');
const maint = await import('../server/src/queenzee/maintenance.js');

const MIN = 60_000, HOUR = 3600_000;
const T0 = Date.parse('2026-07-28T18:30:00Z');          // omnibiz's last good dump, for real
const POLICY_12H = 12 * 3600;                            // omnibiz's real policy, in seconds
const at = (ms) => new Date(ms).toISOString();

let projId;
try {
  // ── 1. THE FIX: a failure schedules a RETRY, not another whole window ──────────────────────────
  console.log('\n── a failed attempt brings the next attempt FORWARD ──');
  const failedAt = T0 + 1 * HOUR;
  const dec = (now, streak = 1) => S.backupDecision({
    lastAttempt: { status: 'failed', taken_at: at(failedAt) },
    lastGood: { taken_at: at(T0) }, failStreak: streak, intervalSec: POLICY_12H, now });

  ok(dec(failedAt + 9 * MIN).due === false, 'nine minutes after a failure: not due (a retry is not a hammer)');
  ok(dec(failedAt + 10 * MIN).due === true, 'TEN minutes after a failure: DUE — the retry interval, not the policy interval');
  ok(dec(failedAt + 10 * MIN).kind === 'retry', 'and it is labelled a retry, so the log says why it is happening');
  // The old behaviour, stated as an assertion rather than a memory: 12h after the FAILURE.
  ok(dec(failedAt + 11 * HOUR).due === true,
     'and it does not wait the 11 further hours the old rule would have — the failure no longer consumes its window');
  ok(S.retryDelaySec(1, POLICY_12H) === 600, 'the first retry is 10 minutes (the slowest existing tick in this repo)');

  console.log('\n── backoff: back off, do not hammer ──');
  ok(S.retryDelaySec(2, POLICY_12H) === 1200 && S.retryDelaySec(3, POLICY_12H) === 2400,
     'each consecutive failure doubles the wait (10 → 20 → 40 min)');
  ok(S.retryDelaySec(7, POLICY_12H) === 38400, 'still doubling at the 7th (640 min)');
  ok(S.retryDelaySec(99, POLICY_12H) === POLICY_12H,
     'and it CAPS at the policy interval — so a retry can never be scheduled later than the old behaviour');
  ok(Number.isFinite(S.retryDelaySec(1e9, POLICY_12H)),
     'an absurd streak cannot overflow the exponent into Infinity');
  for (const streak of [1, 2, 5, 20, 500]) {
    ok(S.retryDelaySec(streak, POLICY_12H) <= POLICY_12H,
       `STRICTLY SOONER holds at streak ${streak} — never later than policy, at any streak`);
  }
  // …and on a SHORT policy, where a 10-minute base would otherwise be the slower option.
  ok(S.retryDelaySec(1, 300) === 300,
     'with a 5-minute policy the retry is 5 minutes, not 10 — the cap protects short policies too');

  // ── 2. NO STORM, simulated against the real 60-second tick ────────────────────────────────────
  console.log('\n── a retry storm is impossible by construction (24h of continuous failure) ──');
  let clock = T0, attempts = 0, streak = 0;
  let lastAttempt = { status: 'finished', taken_at: at(T0) };
  const TICK = 60 * 1000;
  for (let t = 0; t < 24 * 60; t++) {                     // one day of 60-second ticks
    clock += TICK;
    const d = S.backupDecision({ lastAttempt, lastGood: { taken_at: at(T0) },
                                 failStreak: streak, intervalSec: POLICY_12H, now: clock });
    if (d.due) {                                          // every attempt fails, forever
      attempts++; streak++;
      lastAttempt = { status: 'failed', taken_at: at(clock) };
    }
  }
  ok(attempts > 2, `MORE attempts than the old rule would have made (${attempts} vs 2 in 24h) — the point of the ticket`);
  ok(attempts <= 12, `and nowhere near one per tick (${attempts} attempts, not 1440) — the backoff holds`);
  ok(attempts >= 6 && attempts <= 9,
     `the exact shape is the doubling series: ${attempts} attempts in the first 24h of an outage`);

  // ── 3. NEVER INTERRUPT a running backup ───────────────────────────────────────────────────────
  console.log('\n── a running backup is never due, at any age ──');
  const running = (ageH) => S.backupDecision({
    lastAttempt: { status: 'running', taken_at: at(T0) }, lastGood: { taken_at: at(T0) },
    failStreak: 0, intervalSec: POLICY_12H, now: T0 + ageH * HOUR });
  ok(running(1).due === false, 'an hour in: not due');
  ok(running(48).due === false && running(48).kind === 'running',
     'and STILL not due two days in — an age-only rule would start a second dump on top of a live one');

  console.log('\n── the other ordinary cases ──');
  ok(S.backupDecision({ lastAttempt: null, lastGood: null, intervalSec: POLICY_12H, now: T0 }).due === true,
     'a project with no backup at all is due immediately');
  const good = (h) => S.backupDecision({ lastAttempt: { status: 'finished', taken_at: at(T0) },
    lastGood: { taken_at: at(T0) }, failStreak: 0, intervalSec: POLICY_12H, now: T0 + h * HOUR });
  ok(good(11).due === false && good(12).due === true,
     'after a SUCCESS the policy interval is unchanged — this ticket does not touch the happy path');
  ok(good(12).kind === 'policy', 'and it is labelled policy, not retry');

  // ── 4. THE ALERT: bounded by the age of the RESTORE POINT ──────────────────────────────────────
  console.log('\n── somebody is told, and only when it is worth telling ──');
  const alert = (o) => S.staleAlertDecision({ intervalSec: POLICY_12H, ...o });
  // The real incident: 27h old under a 12h policy.
  const real = alert({ lastGood: { taken_at: at(T0) }, now: T0 + 27 * HOUR });
  ok(real.fire === true, 'the ACTUAL incident fires: 27h old under a 12h policy');
  ok(real.stale === true && Math.round(real.thresholdSec / 3600) === 24,
     `the threshold is two policy intervals (${S.STALE_ALERT_INTERVALS}x = 24h here), not a magic number`);
  // The case that must NOT fire, or the alert gets muted before the real one arrives.
  ok(alert({ lastGood: { taken_at: at(T0) }, now: T0 + 10 * MIN }).fire === false,
     'a single failure that a retry fixes ten minutes later never pings anyone');
  ok(alert({ lastGood: { taken_at: at(T0) }, now: T0 + 23 * HOUR }).fire === false,
     'and one missed window alone does not ping — the retries inside it still have a chance');
  ok(alert({ lastGood: null, now: T0 }).fire === false,
     'a project with NO backups is never alerted about — new or unconfigured is not an incident');

  console.log('\n── and it cannot become chatter ──');
  const justTold = alert({ lastGood: { taken_at: at(T0) }, now: T0 + 27 * HOUR,
                           alertedAt: at(T0 + 26 * HOUR), alertOpen: true });
  ok(justTold.fire === false, 'having just pinged, it stays quiet on the next tick');
  ok(/does not become chatter/.test(justTold.reason), 'and says why, so nobody "fixes" it later');
  const dayLater = alert({ lastGood: { taken_at: at(T0) }, now: T0 + 40 * HOUR,
                           alertedAt: at(T0 + 27 * HOUR), alertOpen: true });
  ok(dayLater.fire === true, 'one policy interval later it reminds — a 3-day outage is a few pings, not 4,320');

  console.log('\n── and it stands down when it is fixed ──');
  const recovered = alert({ lastGood: { taken_at: at(T0 + 40 * HOUR) }, now: T0 + 40 * HOUR + 5 * MIN,
                            alertedAt: at(T0 + 27 * HOUR), alertOpen: true });
  ok(recovered.clear === true && recovered.fire === false, 'a good dump clears the open alert');
  const neverTold = alert({ lastGood: { taken_at: at(T0 + 40 * HOUR) }, now: T0 + 40 * HOUR + 5 * MIN,
                            alertedAt: null, alertOpen: false });
  ok(neverTold.clear === false,
     'but a recovery is announced ONLY to someone who was woken — it can never become chatter on its own');

  // ── 5. THE SAME DECISION, READ OUT OF THE REAL LEDGER ─────────────────────────────────────────
  console.log('\n── backupDue reads the streak from the ledger, so a restart cannot reset it ──');
  projId = (await one(
    `INSERT INTO project (name, repo_root, main_branch, db_name, db_user)
       VALUES ($1,$2,'main','zt','zt') RETURNING id`,
    [`zt-retry-${Date.now()}`, '/tmp/zt-retry'])).id;
  await q(`INSERT INTO pool_config (project_id, backup_interval_sec) VALUES ($1,$2)`, [projId, POLICY_12H]);
  const snap = async (status, takenAt) => (await one(
    `INSERT INTO db_snapshot (project_id, source, dump_path, status, mode, taken_at)
       VALUES ($1,'prod','/tmp/zt.dump',$2,'real',$3::timestamptz) RETURNING id`,
    [projId, status, takenAt])).id;

  ok((await maint.backupDue(projId, T0)).kind === 'first', 'no rows at all → first');

  await snap('finished', at(T0));
  ok((await maint.backupDue(projId, T0 + 1 * HOUR)).due === false, 'a fresh success → not due');

  await snap('failed', at(T0 + 1 * HOUR));
  const d1 = await maint.backupDue(projId, T0 + 1 * HOUR + 11 * MIN);
  ok(d1.due === true && d1.kind === 'retry', 'one failed row → a RETRY is due 11 minutes later (not 12 hours)');
  ok(/attempt 1 since the last success/.test(d1.reason), 'and the reason names which attempt this is');

  await snap('failed', at(T0 + 2 * HOUR));
  const d2 = await maint.backupDue(projId, T0 + 2 * HOUR + 11 * MIN);
  ok(d2.due === false, 'TWO failures → the second retry waits 20 minutes, not 10 (backoff read from the ledger)');
  ok((await maint.backupDue(projId, T0 + 2 * HOUR + 21 * MIN)).due === true, 'and fires at 21 minutes');
  ok(/attempt 2 since the last success/.test(d2.reason),
     'the streak comes from the ROWS, so a server restart mid-outage cannot reset the backoff to 10 min');

  // A success resets everything — including the streak.
  await snap('finished', at(T0 + 3 * HOUR));
  const after = await maint.backupDue(projId, T0 + 3 * HOUR + 30 * MIN);
  ok(after.due === false && after.kind === 'policy', 'a good dump resets to the policy interval');

  // A RUNNING row wins over any age, straight out of the ledger.
  await snap('running', at(T0 + 4 * HOUR));
  ok((await maint.backupDue(projId, T0 + 100 * HOUR)).kind === 'running',
     'and a running row is never due even 96 hours later — nothing interrupts a live dump');

  // ── 6. BEST-EFFORT DISCIPLINE: alerting can never fail a backup ────────────────────────────────
  console.log('\n── the dump is the product ──');
  const m = read('server/src/queenzee/maintenance.js');
  const jobStart = m.indexOf('async function runBackupJob');
  const jobEnd = m.indexOf('export async function housekeepBackups');
  ok(!/notifyBackup/.test(m.slice(jobStart, jobEnd)),
     'runBackupJob never calls the notifier at all — the alert lives in the TICK, not in the job');
  ok(/catch \(e\) \{[\s\S]{0,220}backup-freshness check failed \(backups unaffected\)/.test(m),
     'and the freshness check swallows everything, saying so');
  // Proven, not just read: a bogus project cannot make it throw.
  let threw = false;
  try { await maint.backupDue('00000000-0000-0000-0000-000000000000', T0); } catch { threw = true; }
  ok(!threw, 'backupDue on an unknown project does not throw (it degrades to the default interval)');

  console.log('\n── and the panel tells the truth about it ──');
  const fl = read('server/src/lib/fleet.js');
  ok(/next: await backupDue\(pid\)\.catch\(\(\) => null\)/.test(fl),
     'the dashboard carries WHEN the next attempt is (and a failure there cannot break the fleet payload)');
  // The panel's own words, run for real. Backups.jsx is JSX, so it is transformed the way the other
  // console tests do it — and the two readings #26 owes a human are asserted, not described: what will
  // happen next, and that OVERDUE clears itself the moment a good dump lands.
  const { transformSync } = await import('esbuild');
  const { writeFileSync: w, rmSync } = await import('node:fs');
  const tmp = resolve(here, '..', 'web/src/.retry-line.test-build.mjs');
  w(tmp, transformSync(read('web/src/Backups.jsx'), { loader: 'jsx', format: 'esm' }).code
    .replace(/import[^\n]*\.\/(api|Dialog)\.jsx?['"];?/g, (_m, mod) => ({
      api: 'const getBackups=async()=>({}),setBackupConfig=async()=>{},runBackup=async()=>{},'
         + 'revealBackup=async()=>{},restoreBackup=async()=>{},deleteBackup=async()=>{};',
      Dialog: 'const showConfirm=async()=>true,showPrompt=async()=>null;',
    }[mod] || '')));
  let nextAttemptLine, backupFreshness;
  try {
    const mod = await import(`${tmp}?t=${process.pid}`);
    nextAttemptLine = mod.nextAttemptLine; backupFreshness = mod.backupFreshness;
  } finally { rmSync(tmp, { force: true }); }

  ok(nextAttemptLine({ next: { kind: 'retry', due: false, waitSec: 480 } }) === 'retry in 8 min',
     'a failed attempt shows WHEN it will retry — the red mark is never the end of the sentence');
  ok(nextAttemptLine({ next: { kind: 'retry', due: true, waitSec: 0 } }) === 'retrying now',
     'and says so while it is happening');
  ok(nextAttemptLine({ next: { kind: 'policy', due: false, waitSec: 3600 } }) === null,
     'a healthy schedule says NOTHING — silence is the good news, and one less thing to learn to ignore');
  ok(nextAttemptLine({ next: { kind: 'running' } }) === null
     && nextAttemptLine({ running: {}, next: { kind: 'retry', due: true } }) === null,
     'and it never talks over a backup that is actually running');

  // #26's DONE WHEN: the OVERDUE state clears itself when a good dump lands.
  const twelveH = { config: { backup_interval_sec: POLICY_12H } };
  const wasOverdue = backupFreshness({ ...twelveH, last: { taken_at: at(T0) },
    last_attempt: { taken_at: at(T0 + 1 * HOUR), status: 'failed', error: 'x' } }, T0 + 27 * HOUR);
  ok(wasOverdue.state === 'overdue' && wasOverdue.failedSince === true, 'the incident state: overdue AND last-attempt-failed');
  const nowFixed = backupFreshness({ ...twelveH, last: { taken_at: at(T0 + 28 * HOUR) },
    last_attempt: { taken_at: at(T0 + 28 * HOUR), status: 'finished' } }, T0 + 28 * HOUR + 5 * MIN);
  ok(nowFixed.state === 'ok' && nowFixed.failedSince === false,
     'and a single good dump clears BOTH marks — it is derived from the newest success, so nothing has to remember to reset it');
} finally {
  if (projId) {
    await q(`DELETE FROM db_snapshot WHERE project_id=$1`, [projId]).catch(() => {});
    await q(`DELETE FROM pool_config WHERE project_id=$1`, [projId]).catch(() => {});
    await q(`DELETE FROM project WHERE id=$1`, [projId]).catch(() => {});
  }
  await pool.end().catch(() => {});
}
console.log(`\n${failures === 0 ? 'ALL PASSED ✓' : `${failures} FAILURE(S) ✗`}`);
process.exit(failures === 0 ? 0 : 1);
