import React, { useState } from 'react';
import { pauseFleet as apiPauseFleet, resumeFleet as apiResumeFleet } from './api.js';
import { showAlert, showPrompt } from './Dialog.jsx';

// ── PAUSE / PLAY — project-scoped and fleet-wide stop button ─────────────────────────────────────
//
// When a `projectId` is provided, pausing/resuming acts on THAT project only (project-scoped).
// Without `projectId`, it acts on the ENTIRE fleet (fleet-wide).
//
// One control, two states, and the state it is IN is the thing it must communicate: an operator who
// cannot tell at a glance whether the fleet is stopped will assume it is running (that is the safer-
// feeling assumption and it is the wrong one), dispatch into it, and be told no. So the button changes
// word, colour and pulse, and while paused the whole statusline carries a banner beside it.
//
// A pause is NOT confirmed, deliberately. It is the one control on this page whose entire value is
// being fast: it interrupts turns, destroys nothing, moves no gate and is undone by pressing it again,
// so a confirmation dialog would only ever cost the seconds it exists to save. The optional REASON —
// which rides into every resumed zee's prompt, so they know why they were stopped — is a right-click,
// the same idiom as the build button's hot variant.
export default function FleetPause({ pause, projectId, onChanged, pushToast, dismissToast }) {
  const [busy, setBusy] = useState(false);
  const paused = !!pause?.paused;
  const scopeLabel = projectId ? 'project' : 'FLEET';

  const report = (r, kind) => {
    const c = r?.counts || {};
    const id = `fleet-${kind}-${Date.now()}`;
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
      title: kind === 'pause' ? `${scopeLabel} PAUSED — zees stopped` : `${scopeLabel} resumed`, body });
    if (!bad) setTimeout(() => dismissToast(id), 8000);
  };

  const go = async (next, reason = null) => {
    setBusy(true);
    try {
      report(next ? await apiPauseFleet(reason, projectId) : await apiResumeFleet(projectId), next ? 'pause' : 'resume');
      onChanged?.();
    } catch (e) {
      showAlert((next ? 'Pause' : 'Resume') + ' failed: ' + (e?.message || e), { variant: 'error' });
    } finally { setBusy(false); }
  };

  const withReason = async (e) => {
    e.preventDefault();
    if (paused || busy) return;
    const why = await showPrompt(`Why are you pausing ${projectId ? 'this project' : 'the fleet'}?\n\nIt rides into every zee's prompt when you `
      + 'press play, so they know what stopped them.', { okLabel: 'Pause', placeholder: 'e.g. rate limit — holding until tomorrow' });
    if (why === null) return;
    go(true, why.trim() || null);
  };

  return (
    <span className={`fleetpause${paused ? ' paused' : ''}`}>
      <button className="fp-btn" data-testid="fleet-pause-btn" disabled={busy}
              onClick={() => go(!paused)} onContextMenu={withReason}
              title={paused
                ? `PLAY — resume ${projectId ? 'this project' : 'the fleet'}. Every zee the pause stopped is called back.`
                : `${projectId ? 'PAUSE THIS PROJECT' : 'PAUSE EVERY ZEE, in every xell of every project'} — managers included. `
                  + 'Right-click to pause with a reason.'}>
        {busy ? '…' : paused ? '▶' : '⏸'}
      </button>
      {paused && (
        <span className="fp-banner" data-testid="fleet-paused-banner">
          {scopeLabel} PAUSED{pause.by ? ` by ${pause.by}` : ''}
          {pause.interrupted ? ` · ${pause.interrupted} zee(s) stopped` : ''}
          {pause.reason ? ` · ${pause.reason}` : ''}
        </span>
      )}
    </span>
  );
}
