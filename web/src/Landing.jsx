// LANDING GATE panel — pushes to main held for human verification.
//
// This is the one place in a deliberately read-only dashboard where a human DECIDES something
// that a zee cannot: whether work reaches main. It renders only when something is held, but then
// it is loud and top-of-page on purpose — a held push means a zee is blocked, waiting on you.
import React, { useState } from 'react';
import { decideLanding } from './api.js';

const shortSha = (s) => (s ? s.slice(0, 10) : '—');
const ago = (ts) => {
  const s = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
};

// Exported because a landing now renders on the CARD of the xell that raised it, not only in the
// top panel: "nimble-atlas wants to land" is information about nimble-atlas, and reading it three
// feet from that xell's own diff and status is the difference between a notice and a nag. The
// panel keeps only the ones with no card to live on (the gate resolves the xell by sha, so an
// unmatched push has no xell_id).
export function LandCard({ req, onDone, onDismiss }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const commits = Array.isArray(req.commits) ? req.commits : [];
  const stat = req.stat || {};
  const approved = req.status === 'approved';
  // Collapse once APPROVED, and only then. A pending card is a decision you owe someone — it earns
  // the space and the commit list you are being asked to read. The moment you approve, it stops
  // being a question and becomes a receipt: still true, still worth seeing, but it should not go on
  // burying the xell's own buttons underneath it. Either state is one click away.
  const [open, setOpen] = useState(!approved);

  const decide = async (decision) => {
    if (decision === 'reject'
      && !confirm(`Reject ${shortSha(req.new_sha)}?\n\nThis sha is refused for good — the zee cannot land it by re-pushing.`)) return;
    setBusy(true); setErr(null);
    try {
      await decideLanding(req.id, decision);
      // Collapse on the CLICK, not on the refetch. `open` is initialised from the status at mount,
      // and this component does not remount when the poll brings the new status back — so without
      // this, approving leaves the full commit list sitting open on top of the xell's buttons,
      // which is the moment it stops being worth the space.
      if (decision === 'approve') setOpen(false);
      onDone?.();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  return (
    <div className={`land-card${approved ? ' approved' : ''}${open ? '' : ' mini'}`}>
      <div className="land-head">
        <button className="land-toggle" onClick={() => setOpen((v) => !v)}
                title={open ? 'Collapse' : 'Show the commits'} aria-expanded={open}>
          {open ? '▾' : '▸'}
        </button>
        <span className="land-what">
          <b>{req.xell_slug || 'unknown xell'}</b> wants to land onto{' '}
          <b>{(req.ref || '').replace('refs/heads/', '')}</b>
        </span>
        {/* Dismiss hides a receipt DURABLY (the server records it — reloads keep it hidden); it
            never rejects anything, and the land reaper keeps working the row. A PENDING card has
            no ✕ on purpose: a held landing means a zee is blocked waiting on you, and letting that
            be swept off the screen is how it gets forgotten. Decide it or leave it. */}
        {onDismiss && approved && (
          <button className="land-x" onClick={() => onDismiss(req.id)}
                  title="Hide this receipt (stays hidden — the queenzee still lands it, or closes it as stale, on its own)">✕</button>
        )}
      </div>

      {!open ? (
        <div className="land-mini">
          ✓ approved — {shortSha(req.new_sha)} · {commits.length} commit{commits.length === 1 ? '' : 's'} · waiting for the zee to re-push
        </div>
      ) : (
        <>
          <div className="land-meta">
            {shortSha(req.old_sha)} → {shortSha(req.new_sha)} · {ago(req.requested_at)}
            {req.attempts > 1 && <> · <span title="pushes seen for this sha">{req.attempts} attempts</span></>}
          </div>

          <div className="land-stat">
            {commits.length} commit{commits.length === 1 ? '' : 's'}
            {stat.files != null && <> · {stat.files}f <span className="ins">+{stat.insertions}</span>/<span className="del">−{stat.deletions}</span></>}
          </div>

          <ul className="land-commits">
            {commits.slice(0, 12).map((c) => (
              <li key={c.short}><code>{c.short}</code> {c.subject} <span className="land-author">{c.author}</span></li>
            ))}
            {commits.length > 12 && <li className="land-more">…and {commits.length - 12} more</li>}
            {!commits.length && <li className="land-more">(no commit list — check the worktree before approving)</li>}
          </ul>

          {err && <div className="land-err">{err}</div>}

          {approved ? (
            <div className="land-approved">
              ✓ approved by {req.decided_by} — waiting for the zee to re-push. Nothing lands until it does.
            </div>
          ) : (
            <div className="land-actions">
              <button className="land-reject" disabled={busy} onClick={() => decide('reject')}>Reject</button>
              <button className="land-approve" disabled={busy} onClick={() => decide('approve')}>
                {busy ? '…' : 'Approve landing'}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// LANDINGS WITH NO CARD. Everything the gate could match to a LIVE xell renders on that xell's
// card now; this catches the two cases a card cannot, both of which would otherwise vanish
// silently while still being open and still gating a push:
//
//   • no xell_id — the hook resolves the pusher by sha (receive-pack runs in the xource, not the
//     worktree), so an unmatched push is gated but belongs to "unknown xell".
//   • its xell is RETIRED — the fleet only lists status <> 'retired', so the id points at a card
//     that no longer exists. This is the one that actually bit: an approved landing sat invisible.
//
// The caller decides what is orphaned (it knows which cards exist); this just renders them.
export default function LandingPanel({ landing, onDecided }) {
  const open = landing || [];
  if (!open.length) return null;
  const held = open.filter((r) => r.status === 'pending').length;
  return (
    <section className={`land-panel${held ? '' : ' settled'}`}>
      <div className="land-title">
        {held
          ? `⚠ ${held} landing${held === 1 ? '' : 's'} HELD with no xell card — needs your verification`
          : '✓ Landing approved, but its xell is gone — nothing will re-push it'}
      </div>
      {open.map((r) => <LandCard key={r.id} req={r} onDone={onDecided} />)}
    </section>
  );
}
