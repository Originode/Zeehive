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
import Dispatch from './Dispatch.jsx';

const ago = (ts) => {
  if (!ts) return '';
  const s = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
};

// ── add a manager zee (unlimited) ────────────────────────────────────────────
//
// THE PROMPT IS THE WHOLE POINT, so it gets a real composer. This used to be a one-line
// showPrompt() `<input>`: a manager's PROGRAMME — the standing brief an agent runs an entire crew
// from, and the longest-lived prompt in the fleet — had to be typed blind into a single-line text
// field, with Enter firing it, no way to see what you had written, no paste of a backlog or a
// screenshot, and no choice of model, autonomy or account. A worker doing one job in one xell got
// the full composer. So the manager now opens the SAME modal (Dispatch, `manager` variant), and
// the payload goes to POST /api/managers instead of the dispatch route.
//
// Leaving it blank is still allowed and still means something: the server hands it
// DEFAULT_MANAGER_BRIEF (study the project, propose a programme, ask a human before starting a
// crew). The composer says so, rather than making a human guess.
export function AddManagerButton({ projectId, projectName, onAdded }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  // WHICH ACCOUNT runs it is chosen INSIDE the composer, and the composer reads that list itself
  // now (GET /api/dispatch/options): a manager has one button, not one per account, so the provider
  // and the account are picked in there — filtered by the manager PERSONA's own model policy, which
  // is the choice this modal makes first. This component used to flatten the account list out of
  // the console's provider read-model and hand it down; that list could not know the policy, so it
  // offered accounts the spawn would refuse.

  const add = async (payload) => {
    setOpen(false);
    setBusy(true);
    try {
      // Same shape the dispatch composer emits; POST /api/managers stamps the type, binds prod
      // read-only and cages the zee in the manager harness. `task` is absent when left blank —
      // the server's DEFAULT_MANAGER_BRIEF then applies (sending '' would be a task of nothing).
      await addManagerZee(payload);
      onAdded?.();
    } catch (e) { await showAlert(`Could not add a manager zee:\n\n${e.message}`, { variant: 'error' }); }
    finally { setBusy(false); }
  };

  return (
    <>
      <button className="mgr-add" data-testid="add-manager-btn" onClick={() => setOpen(true)} disabled={busy}
              title="Add a manager zee: runs a crew of workers, reads production (read-only), cannot push to the xource. Add as many as you like.">
        {busy ? 'adding…' : '⬢ + manager zee'}
      </button>
      {open && (
        <Dispatch manager projectId={projectId} projectName={projectName}
                  onClose={() => setOpen(false)} onDispatch={add} />
      )}
    </>
  );
}

// ── "this xell is finished" (a manager's suggestion; a human decides) ────────
export function DoneSuggestionCard({ req, onDone }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const target = req.live_target_slug || req.target_slug || 'that xell';
  // A PREVIOUS approval the queenzee could not carry out (managers.js refuseApproval): the card came
  // back to pending carrying its reason, so show the reason on it. Without this the human re-clicks
  // an approval that already failed once and is told nothing about why.
  const refused = req.result?.refused ? req.result : null;

  const decide = async (decision) => {
    if (decision === 'approve') {
      // Typed, not clicked. Confirming marks the task done and tears the cxell down (its commits are
      // collected first) — there is no undo, and the agent on the other side may still have work
      // only on its branch. A manager proposing this does not make it true.
      const typed = await showPrompt(
        `Mark ${target} DONE, on ${req.live_manager_slug || req.manager_slug || 'a manager'}'s suggestion?\n\n`
        + `${req.reason ? `Its manager says: “${req.reason}”\n\n` : ''}`
        + `${refused ? `⚠ A PREVIOUS approval was refused and the xell was NOT closed:\n${refused.error}\n\n` : ''}`
        + 'This marks the task done and REAPS the xell: its cxell is torn down and its worktree removed '
        + '(commits are collected first). Anything it has NOT landed lives only on its branch. '
        + 'A manager can only suggest this — you are the one deciding.\n\nType DONE to confirm.',
        { okLabel: 'Mark done', variant: 'danger', placeholder: 'DONE' });
      if (String(typed || '').trim().toUpperCase() !== 'DONE') return;
    }
    setBusy(true); setErr(null);
    try {
      const r = await decideDoneSuggestion(req.id, decision);
      // REFUSED is not decided: the server put the suggestion back to pending with its reason, so the
      // card is still here — say why, rather than letting a refusal read as a successful close.
      if (r?.refused || r?.status === 'failed') {
        setErr(r.error || r.result?.error || r.result?.reap?.error || 'the queenzee could not close that xell');
      }
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
      {refused && (
        <div className="land-err">
          ⚠ approved {ago(refused.at)} by {refused.by || 'a human'} — <b>not closed</b>: {refused.error}
        </div>
      )}
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
