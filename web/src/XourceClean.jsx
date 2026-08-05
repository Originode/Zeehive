// XOURCE CLEAN-UP — a manager asked a HUMAN to reset the project xource (the main checkout)
// because a mangled tree is wedging every landing and ship. Rendered as a panel fed by the fleet
// snapshot's `xource_clean` list, exactly like the prod-data asks: pending ones are a DECISION a
// human must make (approve → the queenzee resets the checkout; reject → the ask is declined), and
// recently-completed ones ride along as a receipt so "was it cleaned?" does not vanish.
//
// The same decision also lives in Project setup → Danger → Xource; this panel is the one that
// surfaces without opening the modal, because a wedged xource blocks the whole project and the
// request should not have to wait for a human to go looking.
import React, { useState } from 'react';
import { decideXourceClean, dismissXourceClean } from './api.js';
import { showPrompt } from './Dialog.jsx';

const ago = (ts) => {
  if (!ts) return '';
  const s = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
};

export function XourceCleanCard({ req, onDone }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const pending = req.status === 'pending';
  const completed = req.status === 'completed';
  const failed = req.status === 'failed';

  const decide = async (decision) => {
    if (decision === 'approve') {
      // A typed word, not a click: approving resets the main checkout, discarding whatever
      // uncommitted work is sitting there. Same bar as the Project-setup clean button.
      const typed = await showPrompt(
        `Approve ${req.live_xell_slug || 'a manager'}'s request to clean up the xource?\n\n`
        + 'The queenzee will reset the main checkout to the main tip (aborting merges, discarding '
        + 'uncommitted changes, preserving xell worktrees) — unblocking the landings/ships it was '
        + 'wedging.\n\nType APPROVE to confirm.',
        { title: 'Clean up xource?', okLabel: 'Approve & clean', variant: 'danger', placeholder: 'APPROVE' });
      if (String(typed || '').trim().toUpperCase() !== 'APPROVE') return;
    }
    setBusy(true); setErr(null);
    try { await decideXourceClean(req.id, decision); onDone?.(); }
    catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  return (
    <div className={`land-card xource-clean-card${completed ? ' approved' : ''}`}>
      <div className="land-head">
        <span className="land-what">
          {pending && <><b>{req.live_xell_slug || 'a manager'}</b> wants the <b>xource cleaned</b></>}
          {completed && <>✓ xource cleaned{req.result?.dry_run ? ' (DRY-RUN)' : ''}</>}
          {failed && <>✗ xource-clean FAILED</>}
          {req.status === 'rejected' && <>✗ xource-clean REJECTED</>}
        </span>
        {(completed || failed || req.status === 'rejected') && (
          <button className="land-x" onClick={() => dismissXourceClean(req.id).then(onDone)}
                  title="Hide this receipt (the xource is unchanged)">✕</button>
        )}
      </div>
      <div className="land-meta">
        {ago(req.requested_at)} · {req.live_xell_slug ? 'manager request' : 'human-initiated'}
        {req.decided_by && <> · {req.status} by {req.decided_by}</>}
      </div>
      {req.reason && <div className="prod-ask-reason">“{req.reason}”</div>}
      <div className="prod-ask-note">
        A mangled main checkout blocks <b>every</b> landing and ship in the project. Approving makes
        the queenzee reset it to the main tip — aborting any in-progress merge/rebase, discarding
        uncommitted changes in the main checkout, preserving every xell's worktree.
      </div>
      {failed && <div className="land-err">{req.result?.error || 'no reason recorded'}</div>}
      {completed && req.result?.steps?.length > 0 && (
        <ul className="pc" style={{ margin: '4px 0 0 16px' }}>
          {req.result.steps.map((s, i) => <li key={i}>{s}</li>)}
        </ul>
      )}
      {err && <div className="land-err">{err}</div>}
      {pending && (
        <div className="land-actions">
          <button className="land-reject" disabled={busy} onClick={() => decide('reject')}>Reject</button>
          <button className="land-approve" disabled={busy} onClick={() => decide('approve')}>
            {busy ? '…' : 'Approve & clean'}
          </button>
        </div>
      )}
    </div>
  );
}

export default function XourceCleanPanel({ requests, onDone }) {
  const r = requests || [];
  if (!r.length) return null;
  const pending = r.filter((x) => x.status === 'pending').length;
  return (
    <section className={`land-panel xource-clean-panel${pending ? '' : ' settled'}`}>
      <div className="land-title">
        {pending
          ? `⚠ ${pending} xource-clean request${pending === 1 ? '' : 's'} awaiting you`
          : '✓ xource clean-up — what was cleaned, and by whom'}
      </div>
      {r.map((x) => <XourceCleanCard key={x.id} req={x} onDone={onDone} />)}
    </section>
  );
}
