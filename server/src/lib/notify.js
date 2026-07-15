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

// A push to main is being held for verification.
export function notifyLandRequest({ project, xell, commits, request }) {
  const who = xell?.slug || 'unknown xell';
  const n = commits?.length || 0;
  // ASCII only: the device drops non-latin1 glyphs (a '→' arrives as a blank).
  ping('Landing held',
    `${who} -> ${project.name}/${request.ref.replace('refs/heads/', '')}: ${n} commit(s) need your OK`,
    'orange');
}
