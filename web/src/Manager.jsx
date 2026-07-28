// THE MANAGER LAYER, on the human's side.
//
// Two things a human does with manager zees, and they sit at opposite ends of the weight scale:
//
//   AddManagerButton   — adds one. Unlimited, and deliberately only from here: `zee dispatch`
//                        refuses the manager role, so a manager can never mint managers. Adding one
//                        binds it to production READ-ONLY (its own SELECT-only postgres role) and
//                        cages a zee in it wearing the manager harness.
//   DoneSuggestionCard — answers one. A manager can SUGGEST a xell is finished; it can never mark
//                        it. Approving here marks the task done and REAPS the cxell, which is
//                        irreversible, so it costs a typed confirmation — the same weight as binding
//                        prod, for the same reason: a running agent's work is on the other side of it.
import React, { useState } from 'react';
import { addManagerZee, decideDoneSuggestion, dismissDoneSuggestion } from './api.js';
import { showAlert, showPrompt } from './Dialog.jsx';

const ago = (ts) => {
  if (!ts) return '';
  const s = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
};

// ── add a manager zee (unlimited) ────────────────────────────────────────────
export function AddManagerButton({ projectId, onAdded }) {
  const [busy, setBusy] = useState(false);
  const add = async () => {
    const brief = await showPrompt(
      'Add a MANAGER ZEE.\n\n'
      + 'A manager runs a crew: it dispatches worker zees, talks to them in real time, reads their '
      + 'post-ship reflections and suggests when one is done (you confirm). It holds the PRODUCTION '
      + 'database READ-ONLY — its own postgres role, granted SELECT and nothing else — and it has '
      + 'ZERO push access to the xource: it writes no code and lands none.\n\n'
      + 'Give it its programme (leave blank and it will study the project, propose a plan, and ask you '
      + 'before starting a crew):',
      { okLabel: 'Add manager zee', placeholder: 'e.g. own the console backlog: ship the landing-pad fixes first' });
    if (brief === null) return;                     // cancelled
    setBusy(true);
    try { await addManagerZee({ project: projectId, task: String(brief || '').trim() || undefined }); onAdded?.(); }
    catch (e) { await showAlert(`Could not add a manager zee:\n\n${e.message}`, { variant: 'error' }); }
    finally { setBusy(false); }
  };
  return (
    <button className="mgr-add" onClick={add} disabled={busy}
            title="Add a manager zee: runs a crew of workers, reads production (read-only), cannot push to the xource. Add as many as you like.">
      {busy ? 'adding…' : '⬢ + manager zee'}
    </button>
  );
}

// ── "this xell is finished" (a manager's suggestion; a human decides) ────────
export function DoneSuggestionCard({ req, onDone }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const target = req.live_target_slug || req.target_slug || 'that xell';

  const decide = async (decision) => {
    if (decision === 'approve') {
      // Typed, not clicked. Confirming marks the task done and tears the cxell down (its commits are
      // collected first) — there is no undo, and the agent on the other side may still have work
      // only on its branch. A manager proposing this does not make it true.
      const typed = await showPrompt(
        `Mark ${target} DONE, on ${req.live_manager_slug || req.manager_slug || 'a manager'}'s suggestion?\n\n`
        + `${req.reason ? `Its manager says: “${req.reason}”\n\n` : ''}`
        + 'This marks the task done and REAPS the xell: its cxell is torn down and its worktree removed '
        + '(commits are collected first). Anything it has NOT landed lives only on its branch. '
        + 'A manager can only suggest this — you are the one deciding.\n\nType DONE to confirm.',
        { okLabel: 'Mark done', variant: 'danger', placeholder: 'DONE' });
      if (String(typed || '').trim().toUpperCase() !== 'DONE') return;
    }
    setBusy(true); setErr(null);
    try {
      const r = await decideDoneSuggestion(req.id, decision);
      if (r?.status === 'failed') setErr(r.result?.reap?.reason || r.result?.error || 'the queenzee could not close that xell');
      onDone?.();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const dismiss = async () => {
    setBusy(true);
    try { await dismissDoneSuggestion(req.id); onDone?.(); }
    catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  return (
    <div className="land-card prod-ask">
      <div className="land-head">
        <span className="land-what">
          <b>{req.live_manager_slug || req.manager_slug || 'a manager zee'}</b> suggests <b>{target}</b> is <b>done</b>
        </span>
      </div>
      <div className="land-meta">
        {ago(req.requested_at)} · a suggestion — only you can mark it done
        {req.target_status ? ` · currently ${req.target_status}` : ''}
      </div>
      {req.reason && <div className="prod-ask-reason">“{req.reason}”</div>}
      <div className="prod-ask-note">
        Approving marks the task done and reaps the xell (commits collected first). Check its diff
        before you do: unlanded commits live only on its branch. Reject leaves it working, and its
        manager is told.
      </div>
      {err && <div className="land-err">{err}</div>}
      <div className="land-actions">
        <button className="land-reject" disabled={busy} onClick={dismiss} title="Hide this suggestion without deciding">Dismiss</button>
        <button className="land-reject" disabled={busy} onClick={() => decide('reject')}>Reject</button>
        <button className="land-approve" disabled={busy} onClick={() => decide('approve')}
                title="Mark this xell done and tear it down">
          {busy ? '…' : 'Mark done'}
        </button>
      </div>
    </div>
  );
}
