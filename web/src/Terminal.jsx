import React, { useEffect, useRef } from 'react';

const SCOPE = {
  poller: '#5b8cff', monitor: '#35c46b', pool: '#9ccf3f', maint: '#e0a53b',
  reaper: '#e5554e', intake: '#9b8cff', lock: '#e26fae', api: '#3bc6c0',
};

// Modal terminal streaming the queenzee's live activity (checks, updates, maintenance…).
export default function Terminal({ logs, onClose }) {
  const endRef = useRef(null);
  useEffect(() => { endRef.current?.scrollIntoView(); }, [logs]);
  return (
    <div className="term-overlay" onClick={onClose}>
      <div className="term" onClick={(e) => e.stopPropagation()}>
        <div className="term-head">
          <span className="term-title">▚ queenzee — live activity ({logs.length})</span>
          <button className="term-x" onClick={onClose} title="Close">✕</button>
        </div>
        <div className="term-body">
          {logs.length === 0 && <div className="term-line dim">waiting for queenzee activity…</div>}
          {logs.map((l) => (
            <div className="term-line" key={l.seq}>
              <span className="term-ts">{new Date(l.ts).toLocaleTimeString()}</span>
              <span className="term-scope" style={{ color: SCOPE[l.scope] || '#8b97a8' }}>{(l.scope || '').padEnd(7)}</span>
              <span className="term-msg">{l.msg}</span>
            </div>
          ))}
          <div ref={endRef} />
        </div>
      </div>
    </div>
  );
}
