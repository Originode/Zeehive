// CREDENTIAL INJECTION — a rotated or repaired provider key reaches LIVE cages without a re-spawn.
// The QUEENZEE raised a request when (a) a human connected/replaced an account in Project setup and
// live cages predate the new key (rotation), or (b) a zee's turn died on a 401 (auth-death, scoped
// to that xell and quoting the vendor's sentence). Rendered as a panel fed by the fleet snapshot's
// `credential_inject` list, exactly like xource-clean: pending ones are a DECISION a human must make
// (approve → the queenzee injects the current key into each named cage and re-runs the adapter's
// auth setup; reject → the ask is declined), and recently-completed ones ride along as a receipt so
// "did the new key actually reach the cages?" does not vanish.
//
// There is deliberately NO zee path to approve: a zee never injects, asks for, or approves an
// injection. Only a human decides here.
import React, { useState } from 'react';
import { decideCredentialInject, dismissCredentialInject } from './api.js';
import { showPrompt } from './Dialog.jsx';
import { PROVIDER_ART } from './providerArt.js';

const ago = (ts) => {
  if (!ts) return '';
  const s = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
};

const providerLabel = (p) => PROVIDER_ART[p]?.label || p;

export function CredentialInjectCard({ req, onDone }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const pending = req.status === 'pending';
  const completed = req.status === 'completed';
  const failed = req.status === 'failed';
  const rotation = req.kind === 'rotation';
  const provider = providerLabel(req.provider);
  const perXell = req.result?.per_xell || [];
  const okCount = perXell.filter((p) => p.ok).length;

  // The cage count on the card is the count AT RAISE TIME; the run recomputes targets at approval
  // (a cage born after the request is skipped, one that came alive is added). The prompt must not
  // say "into 2" when the run may inject into 7 — it says the raise-time count AS OF when it was
  // counted (finding [11]).
  const asOf = req.requested_at ? new Date(req.requested_at).toLocaleString() : 'the request was raised';
  const decide = async (decision) => {
    if (decision === 'approve') {
      // A typed word, not a click: approving injects the current provider key into live cages and
      // re-runs the adapter's auth setup inside them. Same bar as xource-clean's approve.
      const typed = await showPrompt(
        `${rotation ? `Rotate ${provider} into ${perXell.length || (req.cage_count ?? 'some')} live cage(s) as of ${asOf}?`
          : `Inject the current ${provider} key into this xell and resume its zee?`}\n\n`
        + 'The queenzee will recompute the credential env from the meta-DB, rewrite ONLY the credential '
        + 'lines in each named cage\'s /etc/environment (leaving every other line intact), and re-run the '
        + 'adapter\'s auth setup so the vendor\'s auth file is rewritten too. The actual target count is '
        + 'recomputed at approval time.\n\n'
        + 'Type APPROVE to confirm.',
        { title: 'Inject the fresh key?', okLabel: 'Approve & inject', variant: 'danger', placeholder: 'APPROVE' });
      if (String(typed || '').trim().toUpperCase() !== 'APPROVE') return;
    }
    setBusy(true); setErr(null);
    try { await decideCredentialInject(req.id, decision); onDone?.(); }
    catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const settled = completed || failed || req.status === 'rejected';
  return (
    <div className={`land-card credential-inject-card${completed ? ' approved' : ''}`}>
      <div className="land-head">
        <span className="land-what">
          {pending && (rotation
            ? <><b>{provider}</b> key rotated — <b>{perXell.length || req.cage_count || 'some'}</b> live cage(s) hold an older key</>
            : <><b>{req.live_xell_slug || 'a xell'}</b> died on an <b>{provider}</b> auth error</>)}
          {completed && <>✓ {provider} key injected{req.result?.dry_run ? ' (DRY-RUN)' : ''} into {okCount}/{perXell.length || 0} cage(s)</>}
          {failed && <>✗ credential injection FAILED ({okCount}/{perXell.length || 0} cage(s) injected)</>}
          {req.status === 'rejected' && <>✗ {provider} injection REJECTED</>}
        </span>
        {settled && (
          <button className="land-x" onClick={() => dismissCredentialInject(req.id).then(onDone)}
                  title="Hide this receipt (nothing else changes)">✕</button>
        )}
      </div>
      <div className="land-meta">
        {ago(req.requested_at)} · {rotation ? `account rotation${req.account_label ? ` (${req.account_label})` : ''}`
          : `auth-death — ${req.live_xell_slug || 'xell'}`}
        {req.decided_by && <> · {req.status} by {req.decided_by}</>}
      </div>
      {req.reason && <div className="prod-ask-reason">“{req.reason}”</div>}
      <div className="prod-ask-note">
        {rotation
          ? `A ${provider} account was connected/replaced. Cages born before that key were spawned with the old one. `
            + 'Approving injects the current key into them and re-runs the adapter\'s auth setup.'
          : 'The zee\'s turn was cut short by a 401. Approving injects the current key into this cage and may '
            + 'resume the zee on it (one revive, scheduled by the queenzee).'}
      </div>
      {failed && <div className="land-err">{req.result?.error || 'no reason recorded'}</div>}
      {perXell.length > 0 && (
        <ul className="pc" style={{ margin: '4px 0 0 16px' }}>
          {perXell.map((p) => (
            <li key={p.xell_id || p.xell_slug}>
              {p.ok ? '✓' : '✗'} {p.xell_slug}
              {p.dry_run ? ' (DRY-RUN)' : ''}
              {p.changed?.length > 0 ? ` — ${p.changed.length} line(s) rewritten` : ''}
              {p.revive?.ok ? ' · revive scheduled' : (p.revive && !p.revive.ok ? ` · revive: ${p.revive.error}` : '')}
              {p.error ? ` — ${p.error}` : ''}
            </li>
          ))}
        </ul>
      )}
      {err && <div className="land-err">{err}</div>}
      {pending && (
        <div className="land-actions">
          <button className="land-reject" disabled={busy} onClick={() => decide('reject')}>Reject</button>
          <button className="land-approve" disabled={busy} onClick={() => decide('approve')}>
            {busy ? '…' : 'Approve & inject'}
          </button>
        </div>
      )}
    </div>
  );
}

export default function CredentialInjectPanel({ requests, onDone }) {
  const r = requests || [];
  if (!r.length) return null;
  const pending = r.filter((x) => x.status === 'pending').length;
  return (
    <section className={`land-panel credential-inject-panel${pending ? '' : ' settled'}`}>
      <div className="land-title">
        {pending
          ? `⚠ ${pending} credential injection${pending === 1 ? '' : 's'} awaiting you`
          : '✓ credential injections — what reached the live cages, and when'}
      </div>
      {r.map((x) => <CredentialInjectCard key={x.id} req={x} onDone={onDone} />)}
    </section>
  );
}
