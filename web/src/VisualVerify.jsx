// VISUAL-VERIFY offers — a zee built its webapp and OFFERED the live link to a human in the
// console. Not a gate: there is no approve/reject, nothing irreversible, nothing a zee is blocked
// on. The human OPENS the link in a new tab (to see the running webapp for themselves) or
// DISMISSES the card. Rendered on the offering xell's card / a small panel, like ProdData's cards
// but deliberately lighter — the "decision" is a look, not an approval.
import React, { useState } from 'react';
import { dismissVisualVerify } from './api.js';

const ago = (ts) => {
  if (!ts) return '';
  const s = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
};

export function VisualVerifyCard({ offer, onDone }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const open = () => { window.open(offer.url, '_blank', 'noopener'); };
  const dismiss = async () => {
    setBusy(true); setErr(null);
    try { await dismissVisualVerify(offer.xell_id, offer.id); onDone?.(); }
    catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  return (
    <div className="land-card visual-verify-card">
      <div className="land-head">
        <span className="land-what">
          <b>{offer.xell_slug || 'a zee'}</b> wants you to <b>visually verify its webapp</b>
        </span>
        <button className="land-x" onClick={dismiss} disabled={busy}
                title="Hide this offer (the webapp is unchanged)">✕</button>
      </div>
      <div className="land-meta">
        {ago(offer.created_at)}
        {offer.commit && <> · @ {String(offer.commit).slice(0, 8)}</>}
      </div>
      <div className="visual-verify-note">
        The webapp is built and running — open the link in a new tab to see it for yourself.
      </div>
      {err && <div className="land-err">{err}</div>}
      <div className="land-actions">
        <button className="land-reject" disabled={busy} onClick={dismiss}>Dismiss</button>
        <button className="land-approve" disabled={busy} onClick={open}
                title={`Open ${offer.url} in a new tab`}>
          {busy ? '…' : 'Open link →'}
        </button>
      </div>
    </div>
  );
}

// THE PANEL — open visual-verify offers that have no xell chip to live on (a reaped xell), plus
// the ones whose card renders on the xell itself (App.jsx routes those directly). The card is the
// same either way; this is just the "no chip" bucket, mirroring ProdAsksPanel.
export default function VisualVerifyPanel({ offers, onDone }) {
  const o = offers || [];
  if (!o.length) return null;
  return (
    <section className="land-panel visual-verify-panel">
      <div className="land-title">
        <span role="img" aria-label="eye">👁</span> visual verification — {o.length} webapp
        {o.length === 1 ? ' is' : 's are'} ready for your eyes
      </div>
      {o.map((r) => <VisualVerifyCard key={r.id} offer={r} onDone={onDone} />)}
    </section>
  );
}
