import React, { useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

const SCOPE = {
  poller: '#5b8cff', monitor: '#35c46b', pool: '#9ccf3f', maint: '#e0a53b',
  reaper: '#e5554e', intake: '#9b8cff', lock: '#e26fae', api: '#3bc6c0',
  ship: '#f0883e', shipmigrate: '#d29922', 'xell-db': '#79c0ff',
};

// A zee's output is logged under scope `zee:<slug>`, and the slug can be 50+ chars — long enough
// to eat half the line and crush the message. Middle-truncate it so it fits the fixed scope
// column while keeping BOTH the `zee:` prefix (so you still know it's a zee) and the trailing hash
// (so two zees never collapse to the same label). The full scope is not clipped in the message.
const SCOPE_MAX = 20;
function shortScope(scope) {
  const s = scope || '';
  if (s.length <= SCOPE_MAX) return s;
  return `${s.slice(0, SCOPE_MAX - 7)}…${s.slice(-6)}`;
}

// ── ANSI helpers: the firehose renders into a real xterm now, not a div stack, so the same
// per-scope colour + dim timestamp the DOM version drew are written as truecolor escapes. ─────────
const RESET = '\x1b[0m';
const hexRgb = (hex) => {
  let h = (hex || '').replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const fg = (hex) => { const [r, g, b] = hexRgb(hex); return `\x1b[38;2;${r};${g};${b}m`; };
const DIM = fg('#4a5568');          // timestamp colour, matching the old .term-ts
const padScope = (s) => (s.length >= SCOPE_MAX ? s : s + ' '.repeat(SCOPE_MAX - s.length));

function fmtLine(l) {
  const ts = new Date(l.ts).toLocaleTimeString();
  const scope = padScope(shortScope(l.scope));
  const msg = String(l.msg ?? '').replace(/\r?\n/g, ' ');   // one log = one line; fold embedded newlines
  return `${DIM}${ts}${RESET} ${fg(SCOPE[l.scope] || '#8b97a8')}${scope}${RESET} ${msg}`;
}

// Modal terminal streaming the queenzee's live activity (checks, updates, maintenance…).
// One firehose, but filterable: the scope chips in the header toggle channels on and off, so
// "just the ship" or "everything but the monitor" is one click, not a scroll hunt. The body is a
// real xterm (same engine as the caged-zee terminal) — ANSI colour, native scrollback + selection.
export default function Terminal({ logs, onClose }) {
  const holder = useRef(null);
  const termRef = useRef(null);
  const drawn = useRef({ key: null, count: 0 });   // what the xterm currently shows: filter key + line count
  const [only, setOnly] = useState(() => new Set());   // empty = show everything
  const scopes = [...new Set(logs.map((l) => l.scope).filter(Boolean))].sort();
  const shown = only.size ? logs.filter((l) => only.has(l.scope)) : logs;

  // Create the xterm ONCE and keep it across log/filter changes. A read-only viewer: no stdin, and
  // the cursor is painted the background colour so it never shows as a stray block.
  useEffect(() => {
    const term = new XTerm({
      fontFamily: "'Cascadia Code', ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: 12, lineHeight: 1.2, scrollback: 5000, disableStdin: true, cursorBlink: false,
      convertEol: true, theme: { background: '#0a0d12', foreground: '#c9d3e0', cursor: '#0a0d12' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(holder.current);
    try { fit.fit(); } catch { /* holder not laid out yet — the observer below refits */ }
    termRef.current = term;

    const refit = () => { try { fit.fit(); } catch { /* mid-teardown */ } };
    window.addEventListener('resize', refit);
    const ro = new ResizeObserver(refit);
    if (holder.current) ro.observe(holder.current);
    return () => {
      window.removeEventListener('resize', refit);
      ro.disconnect();
      term.dispose();
      termRef.current = null;
      drawn.current = { key: null, count: 0 };
    };
  }, []);

  // Reconcile the xterm with the current filtered view. Same filter + appended logs → write only the
  // new tail (a firehose must not redraw thousands of lines per tick); a filter change or a shrink →
  // reset and repaint. xterm auto-scrolls to the bottom on write when the viewport is already there.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    const key = only.size ? [...only].sort().join('|') : '*';
    const st = drawn.current;
    if (st.key !== key || shown.length < st.count) { term.reset(); st.key = key; st.count = 0; }
    for (let i = st.count; i < shown.length; i++) term.writeln(fmtLine(shown[i]));
    st.count = shown.length;
  }, [shown, only]);

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
          <div className="term-xterm" ref={holder} />
          {shown.length === 0 && <div className="term-empty">waiting for queenzee activity…</div>}
        </div>
      </div>
    </div>
  );
}
