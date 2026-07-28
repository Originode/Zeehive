// PROD-DATA asks — the two decisions a zee may only REQUEST about production DATA, rendered on the
// card of the xell that asked.
//
// Code reaching prod has had a gate (Ship.jsx) since the ship flow landed. DATA reaching prod had
// half of one: `zee prod` wrote a prod_bind_request row (migration 029) and the queenzee logged it —
// but nothing in the console ever showed it, so a zee could ask and simply never be answered. And a
// zee that needed rows in production had only that one blunt ask: bind the entire live database.
//
// So there are two cards here, deliberately different in weight:
//
//   ProdBindCard — "give me the production database". Loud, red, typed-word confirmation. It grants
//                  live irreversible writes and re-seals the cxell firewall so it can reach prod.
//   SeedCard     — "run this landed .sql on production for me". The narrow one: the human reads the
//                  exact SQL (fetched at the request's own sha), approves, and the QUEENZEE runs it.
//                  The zee never touches prod, and what ran is readable in the repo afterwards.
import React, { useState, useEffect } from 'react';
import { decideProdBind, decideProdSeed, seedRequestSql, dismissSeed } from './api.js';
import { showConfirm, showPrompt } from './Dialog.jsx';

const ago = (ts) => {
  if (!ts) return '';
  const s = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
};
const base = (f) => String(f || '').split('/').pop();

// ── "bind me to the production database" ─────────────────────────────────────
export function ProdBindCard({ req, onDone }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const decide = async (decision) => {
    if (decision === 'confirm') {
      // A typed word, not a click. Confirming hands a running agent the live production database:
      // every guard below this point is prompt-level only (HANDOFF, "hotfix / data xells"), so this
      // is the last hard stop, and it should cost more than a mis-click.
      const typed = await showPrompt(
        `Bind ${req.xell_slug || 'this xell'} to the PRODUCTION database?\n\n`
        + 'Its assigned db becomes LIVE PRODUCTION: reads are free, writes are real and irreversible, '
        + 'and a cxell has its firewall re-sealed so it can reach prod. This grants prod DATA only — '
        + 'deploying code stays the ship gate.\n\nType BIND to confirm.',
        { okLabel: 'Bind to prod', variant: 'danger', placeholder: 'BIND' });
      if (String(typed || '').trim().toUpperCase() !== 'BIND') return;
    }
    setBusy(true); setErr(null);
    try { await decideProdBind(req.id, decision); onDone?.(); }
    catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  return (
    <div className="land-card prod-ask">
      <div className="land-head">
        <span className="land-what">
          <b>{req.xell_slug || 'a zee'}</b> is asking for the <b>PRODUCTION database</b>
        </span>
      </div>
      <div className="land-meta">{ago(req.requested_at)} · prod DATA, not prod code</div>
      {req.reason && <div className="prod-ask-reason">“{req.reason}”</div>}
      <div className="prod-ask-note">
        Confirming re-points this xell's db to live production (and re-seals a cxell's firewall so it
        can reach it). Writes are prompt-gated only from then on. If the zee just needs ROWS in prod,
        reject this and ask it for a seed file instead — that one you get to read before it runs.
      </div>
      {err && <div className="land-err">{err}</div>}
      <div className="land-actions">
        <button className="land-reject" disabled={busy} onClick={() => decide('reject')}>Reject</button>
        <button className="land-reject" disabled={busy} onClick={() => decide('confirm')}
                title="Hand this xell the live production database">
          {busy ? '…' : 'Bind to PROD'}
        </button>
      </div>
    </div>
  );
}

// ── "run this landed seed file on production" ────────────────────────────────
export function SeedCard({ req, onDone, onDismiss }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [sql, setSql] = useState(null);
  const [open, setOpen] = useState(false);
  const files = req.files || [];
  const pending = req.status === 'pending';
  const running = ['approved', 'running'].includes(req.status);
  const done = req.status === 'seeded';
  const failed = req.status === 'failed';

  // Fetch the SQL as soon as a decision is being asked for — approving without having read what
  // runs is the whole failure this card exists to prevent, so it should not need a second click.
  useEffect(() => {
    if (!pending || sql) return;
    let live = true;
    seedRequestSql(req.id).then((r) => { if (live) setSql(r); }).catch(() => {});
    return () => { live = false; };
  }, [req.id, pending]);

  const decide = async (decision) => {
    if (decision === 'approve') {
      const prior = sql?.prior || [];
      if (!(await showConfirm(
        `Run ${files.length} seed file(s) on PRODUCTION?\n\n${files.map(base).join('\n')}\n\n`
        + `The queenzee runs them from ${String(req.commit || '').slice(0, 8)} (main), one transaction each, `
        + 'against the live production database. Seeds are not ledgered — they are expected to be idempotent.'
        + (prior.length ? `\n\n⚠ ${prior.length} of these file(s) have ALREADY been run on this production `
          + `(latest ${new Date(prior[0].at).toLocaleString()}). Approving runs them AGAIN.` : ''),
        { okLabel: 'Seed production', variant: 'danger' }))) return;
    }
    setBusy(true); setErr(null);
    try { await decideProdSeed(req.id, decision); onDone?.(); }
    catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const applied = req.result?.applied || [];
  return (
    <div className={`land-card prod-ask seed${done ? ' approved' : ''}`}>
      <div className="land-head">
        <span className="land-what">
          {pending && <><b>{req.xell_slug || 'a zee'}</b> wants to <b>SEED production</b></>}
          {running && <><b>{req.xell_slug || 'a zee'}</b> — seeding production…</>}
          {done && <>✓ production seeded from <b>{req.xell_slug || 'a zee'}</b></>}
          {failed && <>✗ seed FAILED for <b>{req.xell_slug || 'a zee'}</b></>}
        </span>
        {onDismiss && (done || failed) && (
          <button className="land-x" onClick={() => onDismiss(req.id)}
                  title="Hide this receipt (what ran on prod is unchanged)">✕</button>
        )}
      </div>
      <div className="land-meta">
        {ago(req.requested_at)} · {files.length} file{files.length === 1 ? '' : 's'}
        {req.commit && <> · @ {String(req.commit).slice(0, 8)} (main)</>}
        {req.decided_by && <> · {req.status} by {req.decided_by}</>}
      </div>
      {req.reason && <div className="prod-ask-reason">“{req.reason}”</div>}

      <ul className="land-commits">
        {files.map((f) => {
          const a = applied.find((x) => x.file === f);
          return <li key={f}><code>{base(f)}</code>{a ? (a.ok ? ' ✓ ran' : ' ✗ failed') : ''}</li>;
        })}
      </ul>

      {/* THE SQL. Approving prod data you have not read is the same mistake as approving a landing
          you have not read — so it is here, one click away, already loaded. */}
      {sql?.files?.length > 0 && (
        <>
          <button className="land-toggle seed-sql-toggle" onClick={() => setOpen((v) => !v)}>
            {open ? '▾ hide the SQL' : '▸ read the SQL that will run'}
          </button>
          {open && (
            <pre className="seed-sql">
              {sql.files.map((f) => `-- ${f.file}\n${f.sql || '(unreadable at this commit)'}`).join('\n\n')}
            </pre>
          )}
        </>
      )}
      {sql?.prior?.length > 0 && pending && (
        <div className="prod-ask-note warn">
          ⚠ already run on this production: {sql.prior.map((p) => `${p.files.map(base).join(', ')} `
            + `(${new Date(p.at).toLocaleDateString()}${p.by ? `, ${p.by}` : ''})`).join(' · ')}
        </div>
      )}

      {failed && <div className="land-err">{req.result?.error || 'no reason recorded'}</div>}
      {done && <div className="land-approved">
        ✓ {applied.filter((a) => a.ok).length} file(s) ran on {req.result?.database || 'production'}
        {req.result?.mode === 'simulate' ? ' (SIMULATED — SEED_MODE=simulate)' : ''}
      </div>}
      {err && <div className="land-err">{err}</div>}

      {pending && (
        <div className="land-actions">
          <button className="land-reject" disabled={busy} onClick={() => decide('reject')}>Reject</button>
          <button className="land-approve" disabled={busy} onClick={() => decide('approve')}>
            {busy ? '…' : 'Approve & seed prod'}
          </button>
        </div>
      )}
    </div>
  );
}

// THE PANEL — prod-DATA asks that have no xell chip to live on, plus the RECEIPTS of seeds that
// already ran. Same split as LandingPanel: a live ask renders on its xell (NeedsYouBar), and this
// catches what a chip cannot show — an ask whose xell has been reaped, and the "here is what was
// written to production, and by whom" record that must not vanish the moment it finishes.
export default function ProdAsksPanel({ bind, seeds, onDecided }) {
  const b = bind || [];
  const s = seeds || [];
  if (!b.length && !s.length) return null;
  const held = b.length + s.filter((r) => r.status === 'pending').length;
  return (
    <section className={`land-panel prod-panel${held ? '' : ' settled'}`}>
      <div className="land-title">
        {held
          ? `⚠ ${held} PRODUCTION DATA request${held === 1 ? '' : 's'} awaiting you`
          : '✓ production data — what ran, and who approved it'}
      </div>
      {b.map((r) => <ProdBindCard key={r.id} req={r} onDone={onDecided} />)}
      {s.map((r) => (
        <SeedCard key={r.id} req={r} onDone={onDecided}
                  onDismiss={(id) => dismissSeed(id).then(onDecided)} />
      ))}
    </section>
  );
}
