import React, { useEffect, useRef, useState } from 'react';

const SCOPE = {
  poller: '#5b8cff', monitor: '#35c46b', pool: '#9ccf3f', maint: '#e0a53b',
  reaper: '#e5554e', intake: '#9b8cff', lock: '#e26fae', api: '#3bc6c0',
  ship: '#f0883e', shipmigrate: '#d29922', 'xell-db': '#79c0ff',
};

// A zee's output is logged under scope `zee:<slug>`, and the slug can be 50+ chars — long enough
// to eat half the line and crush the message. Middle-truncate it so it fits the fixed scope
// column while keeping BOTH the `zee:` prefix (so you still know it's a zee) and the trailing hash
// (so two zees never collapse to the same label). The full scope is on the row's title tooltip.
const SCOPE_MAX = 20;
function shortScope(scope) {
  const s = scope || '';
  if (s.length <= SCOPE_MAX) return s;
  return `${s.slice(0, SCOPE_MAX - 7)}…${s.slice(-6)}`;
}

// Modal terminal streaming the queenzee's live activity (checks, updates, maintenance…).
// One firehose, but filterable: the scope chips in the header toggle channels on and off, so
// "just the ship" or "everything but the monitor" is one click, not a scroll hunt.
export default function Terminal({ logs, onClose }) {
  const endRef = useRef(null);
  const [only, setOnly] = useState(() => new Set());   // empty = show everything
  const scopes = [...new Set(logs.map((l) => l.scope).filter(Boolean))].sort();
  const shown = only.size ? logs.filter((l) => only.has(l.scope)) : logs;
  useEffect(() => { endRef.current?.scrollIntoView(); }, [shown.length]);
  const toggle = (s) => setOnly((prev) => {
    const next = new Set(prev);
    next.has(s) ? next.delete(s) : next.add(s);
    return next;
  });
  return (
    <div className="term-overlay" onClick={onClose}>
      <div className="term" onClick={(e) => e.stopPropagation()}>
        <div className="term-head">
          <span className="term-title">▚ queenzee — live activity ({shown.length}{only.size ? ` of ${logs.length}` : ''})</span>
          <span className="term-filters">
            {scopes.map((s) => (
              <button key={s} className={`term-chip${only.size && !only.has(s) ? ' off' : ''}`}
                      style={{ color: SCOPE[s] || '#8b97a8' }}
                      onClick={() => toggle(s)}
                      title={only.has(s) ? `showing ${s} — click to unpin` : `show only ${s} (click more to add)`}>
                {s}
              </button>
            ))}
            {only.size > 0 && <button className="term-chip clear" onClick={() => setOnly(new Set())} title="Show all scopes">all</button>}
          </span>
          <button className="term-x" onClick={onClose} title="Close">✕</button>
        </div>
        <div className="term-body">
          {shown.length === 0 && <div className="term-line dim">waiting for queenzee activity…</div>}
          {shown.map((l) => (
            <div className="term-line" key={l.seq} title={l.scope || ''}>
              <span className="term-ts">{new Date(l.ts).toLocaleTimeString()}</span>
              <span className="term-scope" style={{ color: SCOPE[l.scope] || '#8b97a8' }}>{shortScope(l.scope)}</span>
              <span className="term-msg">{l.msg}</span>
            </div>
          ))}
          <div ref={endRef} />
        </div>
      </div>
    </div>
  );
}
