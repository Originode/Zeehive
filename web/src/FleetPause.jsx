import React, { useState } from 'react';
import { pauseFleet, resumeFleet } from './api.js';
import { showAlert, showPrompt } from './Dialog.jsx';

// ── PAUSE / PLAY — the fleet-wide stop button ─────────────────────────────────────────────────────
//
// One control, two states, and the state it is IN is the thing it must communicate: an operator who
// cannot tell at a glance whether the fleet is stopped will assume it is running (that is the safer-
// feeling assumption and it is the wrong one), dispatch into it, and be told no. So the button changes
// word, colour and pulse, and while paused the whole statusline carries a banner beside it.
//
// It is FLEET-WIDE, across every project, and the title says so in those words — the button lives in a
// project's statusline for want of anywhere better, and a human would otherwise reasonably read it as
// "pause this project".
//
// A pause is NOT confirmed, deliberately. It is the one control on this page whose entire value is
// being fast: it interrupts turns, destroys nothing, moves no gate and is undone by pressing it again,
// so a confirmation dialog would only ever cost the seconds it exists to save. The optional REASON —
// which rides into every resumed zee's prompt, so they know why they were stopped — is a right-click,
// the same idiom as the build button's hot variant.
export default function FleetPause({ pause, onChanged, pushToast, dismissToast }) {
  const [busy, setBusy] = useState(false);
  const paused = !!pause?.paused;

  // Say what actually happened, per press. "Paused" with no numbers is unfalsifiable — the two things
  // an operator needs are how many zees were really mid-turn and, above all, whether any could NOT be
  // confirmed stopped (a pause that left a zee running is the one outcome that must never be quiet).
  const report = (r, kind) => {
    const c = r?.counts || {};
    const id = `fleet-${kind}-${Date.now()}`;
    // `unreachable` is ALREADY every cage not confirmed stopped — a stuck run is one of them. Adding
    // `stuck` on top would report one zee twice, and a number a human cannot reconcile with the log is
    // worse than no number. The server owns both definitions; this only renders them.
    const bad = kind === 'pause' ? (c.unreachable || 0) : (c.failed || 0);
    const body = kind === 'pause'
      ? `${c.interrupted || 0} zee(s) interrupted mid-turn · ${c.idle || 0} were already between turns`
        + (c.gone ? ` · ${c.gone} cage(s) already gone` : '')
        + (r?.dry_run ? ' · SIMULATE mode: this queenzee models the fleet, no real cage was stopped' : '')
        + (bad ? ` · ⚠ ${bad} NOT confirmed stopped${c.stuck ? ` (${c.stuck} still running)` : ''} — check the queenzee log` : '')
      : `${c.nudged || 0} of ${c.paused_zees || 0} paused zee(s) called back`
        + (c.skipped ? ` · ${c.skipped} already running` : '')
        + (c.dry_run ? ` · ${c.dry_run} modelled only (SIMULATE mode)` : '')
        + (bad ? ` · ⚠ ${bad} could not be resumed` : '');
    pushToast({ id, kind: bad ? 'error' : 'success', onRetry: null,
      title: kind === 'pause' ? 'Fleet PAUSED — every zee stopped' : 'Fleet resumed', body });
    if (!bad) setTimeout(() => dismissToast(id), 8000);
  };

  const go = async (next, reason = null) => {
    setBusy(true);
    try {
      report(next ? await pauseFleet(reason) : await resumeFleet(), next ? 'pause' : 'resume');
      onChanged?.();
    } catch (e) {
      showAlert((next ? 'Pause' : 'Resume') + ' failed: ' + (e?.message || e), { variant: 'error' });
    } finally { setBusy(false); }
  };

  const withReason = async (e) => {
    e.preventDefault();
    if (paused || busy) return;
    const why = await showPrompt('Why are you pausing the fleet?\n\nIt rides into every zee\'s prompt when you '
      + 'press play, so they know what stopped them.', { okLabel: 'Pause', placeholder: 'e.g. rate limit — holding until tomorrow' });
    if (why === null) return;                     // cancelled: do NOT pause
    go(true, why.trim() || null);
  };

  return (
    <span className={`fleetpause${paused ? ' paused' : ''}`}>
      <button className="fp-btn" data-testid="fleet-pause-btn" disabled={busy}
              onClick={() => go(!paused)} onContextMenu={withReason}
              title={paused
                ? 'PLAY — resume the fleet. Every zee the pause stopped, or left waiting on a decision made '
                  + 'while it was down, is called back into its session with a prompt telling it what happened; '
                  + 'dispatch, nudges and messages start working again.'
                : 'PAUSE EVERY ZEE, in every xell of every project — managers included. Their turns are '
                  + 'interrupted where they stand (nothing is lost: no commit, no branch, no request, no gate), '
                  + 'and until you press play nothing is dispatched, no landing/clearance nudge is delivered and '
                  + 'no message reaches a session.\n\nRight-click to pause with a reason.'}>
        {busy ? '…' : paused ? '▶' : '⏸'}
      </button>
      {paused && (
        <span className="fp-banner" data-testid="fleet-paused-banner">
          FLEET PAUSED{pause.by ? ` by ${pause.by}` : ''}
          {pause.interrupted ? ` · ${pause.interrupted} zee(s) stopped` : ''}
          {pause.reason ? ` · ${pause.reason}` : ''}
        </span>
      )}
    </span>
  );
}
