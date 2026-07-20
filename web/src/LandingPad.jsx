// THE LANDING PAD — one chronological runway for every landing and shipment.
//
// The landing panel and the ship panel each answer "what needs my approval". This answers a
// different question the human could not ask before: once approved, in WHAT ORDER does the queenzee
// work through them, and which one is on the pad right now? Landings (⇩ onto main) and shipments
// (⇪ to prod) are merged into ONE list in arrival order, the queenzee processes it first-in-
// first-out, and the item being processed spins until it lands/ships or fails.
//
// Read-only on purpose: the DECISIONS (approve/reject/dismiss) live on the landing + ship cards and
// the "waiting on you" bar. This is the queue those decisions flow into.
import React from 'react';

const ago = (ts) => {
  if (!ts) return '';
  const s = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
};
const short = (s) => (s ? String(s).slice(0, 8) : '—');

// One line per landing/ship. The glyph names the KIND; the phase names where it is on the runway.
const PHASE = {
  'awaiting-approval': { label: 'awaiting approval', cls: 'pad-await' },
  queued:              { label: 'queued',            cls: 'pad-queued' },
  processing:          { label: 'processing…',       cls: 'pad-proc' },
  done:                { label: 'done',               cls: 'pad-done' },
  failed:              { label: 'failed',             cls: 'pad-failed' },
  rejected:            { label: 'rejected',           cls: 'pad-rejected' },
  stale:               { label: 'stale',              cls: 'pad-stale' },
};

function PadRow({ item }) {
  const p = PHASE[item.phase] || { label: item.phase, cls: '' };
  const isLanding = item.kind === 'landing';
  const target = isLanding
    ? (item.ref ? item.ref.replace('refs/heads/', '') : 'main')
    : 'PRODUCTION';
  return (
    <li className={`pad-row ${p.cls}${item.processing ? ' on-pad' : ''}${item.next ? ' next-up' : ''}`}
        data-testid="pad-row" data-kind={item.kind} data-phase={item.phase}>
      <span className="pad-pos">{item.position != null ? `#${item.position}` : '✓'}</span>
      <span className="pad-ico" title={isLanding ? 'landing → main' : 'shipment → production'}>
        {isLanding ? '⇩' : '⇪'}
      </span>
      <span className="pad-what">
        <b>{item.xell_slug}</b>
        <span className="pad-verb"> {isLanding ? 'land' : 'ship'} </span>
        <code>{short(item.sha)}</code>
        <span className="pad-verb"> → {target}</span>
        {item.commits != null && item.commits > 0 && (
          <span className="pad-commits"> · {item.commits} commit{item.commits === 1 ? '' : 's'}</span>
        )}
      </span>
      <span className={`pad-phase ${p.cls}`}>
        {item.processing && <span className="pad-spin" data-testid="pad-spin" aria-label="processing" />}
        {item.next && !item.processing && <span className="pad-nextdot" title="next up" />}
        {p.label}
      </span>
      <span className="pad-age" title={new Date(item.requested_at).toLocaleString()}>{ago(item.requested_at)}</span>
    </li>
  );
}

export default function LandingPad({ pad }) {
  if (!pad || !pad.items || !pad.items.length) return null;
  const active = pad.active || 0;
  const proc = pad.processing;
  return (
    <section className="pad-panel" data-testid="landing-pad">
      <div className="pad-title">
        🛬 landing pad
        <span className="pad-sub">
          {proc
            ? <> — queenzee is processing <b>{proc.xell_slug}</b>’s {proc.kind}</>
            : active
              ? <> — {active} in the queue, FIFO</>
              : ' — idle'}
        </span>
      </div>
      <ul className="pad-list">
        {pad.items.map((it) => <PadRow key={`${it.kind}-${it.id}`} item={it} />)}
      </ul>
    </section>
  );
}
