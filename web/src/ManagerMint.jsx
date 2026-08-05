// MANAGER MINT — a ROUTER asked a HUMAN for another MANAGER zee (migration 149).
//
// The router is the project's front door: it sees a raw prompt before anyone has sized it, so it is
// the zee that notices when a request is a PROGRAMME (several strands, a crew, work that outlives
// one worker's cage) rather than a task. It may ask; it may not mint. This panel is the other half
// of that sentence — the human's decision.
//
// Approve → the QUEENZEE runs the same createManagerZee the "Add manager" button calls: a xell of
// its own, the manager type stamp, a read-only production role, the manager persona. Reject → the
// row closes and the router dispatches a worker instead, which is the common and correct answer.
//
// Shaped like XourceClean.jsx deliberately: same card, same receipt-after-the-fact behaviour, so a
// human learns one pattern for "an agent is asking you for something the queenzee will then do".
import React, { useState } from 'react';
import { decideManagerMint, dismissManagerMint } from './api.js';
import { showPrompt } from './Dialog.jsx';

const ago = (ts) => {
  if (!ts) return '';
  const s = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
};

export function ManagerMintCard({ req, onDone }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const pending = req.status === 'pending';
  const created = req.status === 'created';
  const failed = req.status === 'failed';

  const decide = async (decision) => {
    if (decision === 'approve') {
      // A typed word, not a click. A manager is not a throwaway worker: it is a zee with production
      // read access and a crew of its own, and the fleet pays for it until a human reaps it. The
      // same bar the xource clean-up asks for, for the same reason — this one is hard to undo.
      const typed = await showPrompt(
        `Approve ${req.live_xell_slug || 'the router'}'s request for ANOTHER MANAGER zee?\n\n`
        + 'The queenzee will add a manager: its own xell, production READ-ONLY, the manager persona '
        + `(${req.harness_key || 'manager'}). It runs — and bills — until a human marks it done.\n\n`
        + 'Type APPROVE to confirm.',
        { title: 'Mint a manager?', okLabel: 'Approve & mint', variant: 'danger', placeholder: 'APPROVE' });
      if (String(typed || '').trim().toUpperCase() !== 'APPROVE') return;
    }
    setBusy(true); setErr(null);
    try { await decideManagerMint(req.id, decision); onDone?.(); }
    catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  return (
    <div className={`land-card manager-mint-card${created ? ' approved' : ''}`} data-testid="manager-mint-card">
      <div className="land-head">
        <span className="land-what">
          {pending && <><b>{req.live_xell_slug || 'a router'}</b> asks for <b>another manager</b></>}
          {created && <>✓ manager minted{req.created_slug ? <> — <b>{req.created_slug}</b></> : null}</>}
          {failed && <>✗ manager mint FAILED</>}
          {req.status === 'rejected' && <>✗ manager mint REJECTED</>}
          {req.status === 'withdrawn' && <>↩ the router withdrew its request</>}
        </span>
        {!pending && (
          <button className="land-x" onClick={() => dismissManagerMint(req.id).then(onDone)}
                  title="Hide this receipt (nothing changes)">✕</button>
        )}
      </div>
      <div className="land-meta">
        {ago(req.requested_at)} · persona {req.harness_key || 'manager'}
        {req.decided_by && <> · {req.status} by {req.decided_by}</>}
      </div>
      {req.reason && <div className="prod-ask-reason">“{req.reason}”</div>}
      {req.task && (
        <div className="prod-ask-note">
          <b>The programme it would be briefed with:</b>
          <pre className="mint-task">{req.task}</pre>
        </div>
      )}
      <div className="prod-ask-note">
        A manager is a peer, not the router's crew: it holds production <b>read-only</b>, lands
        nothing and pushes nothing, and runs until a human marks it done. Rejecting is a normal
        answer — it tells the router to dispatch a worker instead.
      </div>
      {failed && <div className="land-err">{req.result?.error || 'no reason recorded'}</div>}
      {err && <div className="land-err">{err}</div>}
      {pending && (
        <div className="land-actions">
          <button className="land-reject" disabled={busy} onClick={() => decide('reject')}>Reject</button>
          <button className="land-approve" disabled={busy} onClick={() => decide('approve')}>
            {busy ? '…' : 'Approve & mint'}
          </button>
        </div>
      )}
    </div>
  );
}

export default function ManagerMintPanel({ requests, onDone }) {
  const r = requests || [];
  if (!r.length) return null;
  const pending = r.filter((x) => x.status === 'pending').length;
  return (
    <section className={`land-panel manager-mint-panel${pending ? '' : ' settled'}`}>
      <div className="land-title">
        {pending
          ? `⚠ ${pending} manager-mint request${pending === 1 ? '' : 's'} awaiting you`
          : '✓ manager mints — what was added, and by whom'}
      </div>
      {r.map((x) => <ManagerMintCard key={x.id} req={x} onDone={onDone} />)}
    </section>
  );
}
