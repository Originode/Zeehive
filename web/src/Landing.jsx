// LANDING GATE panel — pushes to main held for human verification.
//
// This is the one place in a deliberately read-only dashboard where a human DECIDES something
// that a zee cannot: whether work reaches main. It renders only when something is held, but then
// it is loud and top-of-page on purpose — a held push means a zee is blocked, waiting on you.
import React, { useState } from 'react';
import { decideLanding, withdrawLanding } from './api.js';
import { showConfirm } from './Dialog.jsx';
import { showDiff } from './DiffViewer.jsx';

const shortSha = (s) => (s ? s.slice(0, 10) : '—');
const ago = (ts) => {
  const s = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
};

// THE APPROACH QUEUE — who is stacked up behind the decision you are looking at (067).
//
// The runway takes one landing per ref, so a second zee pushing is not a second card: it holds with
// a position and is nudged when this one clears. That is the right protocol and it was, until this
// rendered, completely invisible — a human approved a landing with no way to know that two more zees
// were waiting on the answer, and a queued zee looked simply idle.
//
// Deliberately INERT: no buttons, no ✕, nothing to decide. These are not asks — the whole point is
// that only ONE thing on this ref is ever a question. It is here so the answer you give has its real
// consequences visible: clearing this card is what releases the next one.
function ApproachQueue({ queue }) {
  if (!queue?.length) return null;
  return (
    <div className="land-queue" data-testid="approach-queue">
      <div className="land-queue-title">
        ✈ {queue.length} {queue.length === 1 ? 'zee is' : 'zees are'} holding for this runway
        <span className="land-queue-note">— queued, not asking: deciding this one clears the next</span>
      </div>
      <ol className="land-queue-list">
        {queue.map((h) => (
          <li key={h.id}>
            <span className="land-queue-pos" title="position in the holding pattern">#{h.position}</span>
            <b>{h.xell_slug || 'unknown xell'}</b>
            <span className="land-queue-sha"><code>{shortSha(h.new_sha)}</code></span>
            <span className="land-queue-commits">
              {h.commit_count ?? 0} commit{h.commit_count === 1 ? '' : 's'} waiting
            </span>
            <span className="land-queue-since">{ago(h.holding_since || h.requested_at)}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

// Exported because a landing now renders on the CARD of the xell that raised it, not only in the
// top panel: "nimble-atlas wants to land" is information about nimble-atlas, and reading it three
// feet from that xell's own diff and status is the difference between a notice and a nag. The
// panel keeps only the ones with no card to live on (the gate resolves the xell by sha, so an
// unmatched push has no xell_id).
//
// `queue` is the approach queue for THIS ref — rendered under the card, because the thing a human
// most needs to know about a queue is which decision is holding it up.
// ── DISMISSAL HIDES A RECEIPT; IT CANNOT HIDE A BLOCKER (#11 gap 2) ───────────
// The gate's runwayOccupant() deliberately ignores `dismissed_at`, and that instinct is right:
// dismissing hides a receipt, it does not free a runway, and an approved-but-hidden landing is still
// about to move the ref. The consequence was the bug — an approved landing that never lands, dismissed,
// occupying the runway with NOTHING on screen, while the zees queued behind it vanished with it (their
// approach queue renders under the card that owns the runway). The stale sweep cannot rescue that: it
// only closes PROVEN non-fast-forwards.
//
// The fix is not to free the runway on dismissal — that would let a human hide a landing and silently
// let the next one through, which is worse than a stuck runway. It is that a landing WITH ZEES BEHIND IT
// is not a receipt at all, so hiding does not apply to it. When nobody is queued a dismissed approval is
// exactly what dismissal is for and stays hidden; the moment it actually blocks someone it is on screen,
// with the reason, and every button it always had.
export const holdsRunway = (r) => !!r?.runway_occupant && (r?.holders || 0) > 0;

// WHO READ THIS DIFF (ticket #56) — the review records attached to the sha being landed. A human
// approving a landing sees whether anyone actually READ it, and what they concluded. A record, not
// a gate: its absence never blocks an approval, and its presence is the information the system was
// missing — a review happened and nobody could see it.
function ReviewNote({ req }) {
  const reviews = Array.isArray(req.reviews) ? req.reviews : [];
  if (!reviews.length) return null;
  return (
    <div className="land-reviews" data-testid="land-reviews">
      {reviews.map((r, i) => (
        <span key={i} className={`review-chip review-${r.verdict}`}
              title={r.report || `${r.reviewer}'s review of ${shortSha(req.new_sha)}`}>
          {r.verdict === 'clean' ? '✓' : '⚠'} reviewed by {r.reviewer} — {r.verdict.replace('_', '-')}
          {Number(r.findings_count) > 0 ? ` · ${r.findings_count} finding${Number(r.findings_count) === 1 ? '' : 's'}` : ''}
        </span>
      ))}
    </div>
  );
}

export function LandCard({ req, onDone, onDismiss, queue = req.queue }) {
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

  // WITHDRAW — the third answer, and the quiet one. Reject BURNS the sha (the gate refuses it for
  // good and says so to the zee); this only takes the question off the screen, so the same work can
  // be asked again. It is what a stack of cards from one xell needs: the zee kept working and left
  // the old asks behind, and none of them deserve a verdict. The zee has the same verb
  // (`zee land --withdraw`) — this is here for the cards whose zee is gone or is not listening.
  const withdraw = async () => {
    if (!(await showConfirm(`Withdraw ${shortSha(req.new_sha)}?\n\nThe card leaves your screen and nothing is decided — no rejection, no landing, and the zee can ask again.`,
      { okLabel: 'Withdraw' }))) return;
    setBusy(true); setErr(null);
    try { await withdrawLanding(req.id, 'withdrawn in the console'); onDone?.(); }
    catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const decide = async (decision) => {
    if (decision === 'reject'
      && !(await showConfirm(`Reject ${shortSha(req.new_sha)}?\n\nThis sha is refused for good — the zee cannot land it by re-pushing.`, { variant: 'danger', okLabel: 'Reject' }))) return;
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

      {/* Why a hidden card is on screen: it holds the runway and zees are queued behind it. Stated in
          words on the card itself — a human who dismissed this needs to know it came back, and why,
          before they wonder whether the ✕ works. */}
      {req.dismissed_at && holdsRunway(req) && (
        <div className="land-blocker" data-testid="land-blocker">
          ⛔ this landing HOLDS the runway — {req.holders} zee{req.holders === 1 ? '' : 's'} queued behind it,
          so it is shown again even though it was dismissed{req.dismissed_by ? ` by ${req.dismissed_by}` : ''}.
          Hiding it would hide them too. Decide it, or let the zee withdraw it — dismissing does not free the ref.
        </div>
      )}

      {/* The queue rides with the card in BOTH states. Collapsing an approved landing must not hide
          the fact that three zees are waiting on it — that is the moment it matters most. */}
      {!open ? (
        <div className="land-mini">
          ✓ approved — {shortSha(req.new_sha)} · {commits.length} commit{commits.length === 1 ? '' : 's'} · waiting for the zee to re-push
          <ApproachQueue queue={queue} />
        </div>
      ) : (
        <>
          <div className="land-meta">
            {shortSha(req.old_sha)} → {shortSha(req.new_sha)} · {ago(req.requested_at)}
            {req.attempts > 1 && <> · <span title="pushes seen for this sha">{req.attempts} attempts</span></>}
          </div>

          <ReviewNote req={req} />

          {/* The diffstat is the BUTTON now. You are being asked to let this reach main; the
              commit subjects say what the zee meant, and this says what it actually wrote. It
              opens the patch for exactly old_sha..new_sha — the range being approved. */}
          <button className="land-stat difflink" data-testid="land-diff"
                  title="Read the diff — the exact lines this push would add to main"
                  onClick={(e) => {
                    e.stopPropagation();
                    showDiff({ kind: 'land', landId: req.id,
                      title: `${req.xell_slug || 'unknown xell'} → ${(req.ref || '').replace('refs/heads/', '')}`,
                      subtitle: `${shortSha(req.old_sha)} → ${shortSha(req.new_sha)} · ${commits.length} commit${commits.length === 1 ? '' : 's'}` });
                  }}>
            {commits.length} commit{commits.length === 1 ? '' : 's'}
            {stat.files != null && <> · {stat.files}f <span className="ins">+{stat.insertions}</span>/<span className="del">−{stat.deletions}</span></>}
            <span className="difflink-hint">view diff</span>
          </button>

          <ul className="land-commits">
            {commits.slice(0, 12).map((c) => (
              <li key={c.short}>
                <code>{c.short}</code> {c.subject}{' '}
                <span className="land-author">{c.author}</span>
                {c.door && <span className="land-door" title={`committer: ${c.committer || ''} <${c.committer_email || ''}>`}>
                  · {c.door}{c.committer && c.door !== c.committer ? ` / ${c.committer}` : ''}
                </span>}
              </li>
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
              <button className="land-withdraw" disabled={busy} onClick={withdraw}
                      title="Take this question off the screen without deciding it — nothing is rejected and the zee can ask again">
                Withdraw
              </button>
              <button className="land-reject" disabled={busy} onClick={() => decide('reject')}>Reject</button>
              <button className="land-approve" disabled={busy} onClick={() => decide('approve')}>
                {busy ? '…' : 'Approve landing'}
              </button>
            </div>
          )}

          <ApproachQueue queue={queue} />
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
//
// `orphanQueues` is the same idea for the APPROACH QUEUE: zees holding for a runway that has no card
// anywhere on the page. That should never last longer than a blink (the tower clears the queue as
// soon as the runway frees), but a clearance that failed would otherwise leave those zees waiting
// with nothing on any screen — the exact invisibility the runway must not introduce. Rendered here,
// loudly, because if you are seeing it something is wrong.
export default function LandingPanel({ landing, onDecided, orphanQueues = [] }) {
  const open = landing || [];
  if (!open.length && !orphanQueues.length) return null;
  const held = open.filter((r) => r.status === 'pending').length;
  return (
    <section className={`land-panel${held ? '' : ' settled'}`}>
      {!!open.length && (
        <div className="land-title">
          {held
            ? `⚠ ${held} landing${held === 1 ? '' : 's'} HELD with no xell card — needs your verification`
            : '✓ Landing approved, but its xell is gone — nothing will re-push it'}
        </div>
      )}
      {open.map((r) => <LandCard key={r.id} req={r} onDone={onDecided} queue={r.queue} />)}
      {orphanQueues.map(({ ref, queue }) => (
        <div key={ref} className="land-orphan-queue">
          <div className="land-title">
            ⚠ {queue.length} zee{queue.length === 1 ? '' : 's'} holding for{' '}
            <b>{ref.replace('refs/heads/', '')}</b> — but nothing is on that runway
          </div>
          <div className="land-queue-note">
            The queue should have been cleared when the last landing finished. Check the queenzee log
            for a clearance that could not be delivered; a `zee sync` + `zee land` from those xells re-asks.
          </div>
          <ApproachQueue queue={queue} />
        </div>
      ))}
    </section>
  );
}
