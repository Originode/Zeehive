// Out-of-band human notification. The console already shows a held landing live (SSE), but a
// held push BLOCKS a zee until someone looks — so it must reach Mark even when the dashboard
// isn't on screen. Best-effort by definition: a notifier that can wedge the gate is worse than
// no notifier, so every failure here is swallowed.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

// The T-Keyboard desk notifier (same device the claude:// deep links drive). Opt-out with
// TKB_NOTIFY=0; auto-skips when the script isn't on this machine.
const TKB = process.env.TKB_SCRIPT || 'D:\\Repos\\TKeyboardNotifier\\tkb.ps1';
const ENABLED = process.env.TKB_NOTIFY !== '0';

function ping(title, line, color) {
  if (!ENABLED || !existsSync(TKB)) return;
  try {
    const p = spawn('pwsh', ['-NoProfile', '-File', TKB, 'notify', title, line, '-Color', color],
      { stdio: 'ignore', detached: true, windowsHide: true });
    p.on('error', () => {});   // device unreachable / no pwsh → silent, never throws
    p.unref();
  } catch { /* never let a notifier break the caller */ }
}

// A zee wants to ship to PRODUCTION and is blocked until a human decides.
export function notifyShipRequest({ project, xell, request }) {
  ping('SHIP to prod?',
    `${xell.slug} -> ${project.name} PROD @ ${String(request.commit).slice(0, 8)}: needs your OK`,
    'red');
}

// The queenzee finished shipping — the countdown to auto-release is now running, so this one is
// time-critical: the human has `seconds` to press Hold if they want prod kept.
export function notifyShipDone({ project, xell, ok, seconds }) {
  ping(ok ? 'Shipped to prod' : 'Ship FAILED',
    ok ? `${project.name} prod updated from ${xell.slug}. Lock frees in ${seconds}s — Hold to keep it.`
       : `${xell.slug} -> ${project.name} prod FAILED. Check the console.`,
    ok ? 'green' : 'red');
}

// A zee wants the queenzee to run SQL against the PRODUCTION database (seed data a shipment needs).
// Same urgency class as a ship: prod is about to be written to, and the zee is blocked until a human
// reads the SQL and decides.
export function notifySeedRequest({ project, xell, request }) {
  const n = (request?.files || []).length;
  ping('SEED prod?',
    `${xell?.slug || 'a zee'} -> ${project.name} PROD: ${n} seed file(s) need your OK`,
    'red');
}

// A zee is asking to be BOUND to the production database (prod DATA, live and irreversible). It
// cannot bind itself and cannot reach prod until a human confirms — so nothing happens until this
// reaches someone.
export function notifyProdBindRequest({ project, xell, request }) {
  ping('PROD BIND?',
    `${xell?.slug || 'a zee'} wants ${project.name} PROD DB (live data)`
    + `${request?.reason ? `: ${String(request.reason).slice(0, 60)}` : ''}`,
    'red');
}

// A push to main is being held for verification.
export function notifyLandRequest({ project, xell, commits, request }) {
  const who = xell?.slug || 'unknown xell';
  const n = commits?.length || 0;
  // ASCII only: the device drops non-latin1 glyphs (a '→' arrives as a blank).
  ping('Landing held',
    `${who} -> ${project.name}/${request.ref.replace('refs/heads/', '')}: ${n} commit(s) need your OK`,
    'orange');
}

// PRODUCTION'S RESTORE POINT IS STALE — ticket #26. This is the one notification in here that is not
// about a zee waiting on a decision: nobody is blocked, and that is exactly why it needs the off-screen
// path. A held landing stops work and gets noticed within minutes; a backup that quietly stopped
// happening is only visible to someone who thinks to look at a panel, and the cost of not looking is
// measured in hours of production data with no restore point. It went unnoticed for ~27 hours under a
// 12-hour policy before anyone found it, and only then because a zee was reading the table.
//
// Deliberately BOUNDED by the caller (lib/backup-schedule.js): it fires when the newest GOOD dump is
// older than two policy intervals, then at most once per policy interval. The first thing a chatty
// alert costs is the next real one.
export function notifyBackupStale({ project, ageHours, thresholdHours, lastGoodAt, failStreak }) {
  ping('Prod backup STALE',
    // ASCII only: the device drops non-latin1 glyphs (a '→' arrives as a blank).
    `${project?.name || 'project'}: newest good dump is ${ageHours}h old (policy allows ${thresholdHours}h)`
    + `${failStreak ? `, ${failStreak} failed attempt(s) since` : ''}`,
    'red');
}

// And the same alert standing down. Sent ONLY when a stale alert was outstanding, so a human who was
// woken is told it is fixed and nobody else hears anything at all.
export function notifyBackupRecovered({ project, ageMinutes }) {
  ping('Prod backup OK',
    `${project?.name || 'project'}: a good dump landed ${ageMinutes} min ago — restore point is current`,
    'green');
}
