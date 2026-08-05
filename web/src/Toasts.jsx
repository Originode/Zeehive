import React, { useEffect, useRef } from 'react';

// A tiny, self-contained toast stack. It exists so a dispatch can be FIRED and forgotten: the
// composer closes the instant you hit submit, and the slow part (uploading a pasted screenshot,
// renaming the worktree, spawning + awaiting the zee) reports its progress here instead of freezing
// the modal behind a "Dispatching…" button. Toasts are owned by App (which keeps running while the
// modal is gone); this component only renders them.
//
// kinds: 'progress' (spinner, sticks until resolved) · 'success' (auto-dismisses) · 'error'
// (sticks, offers Retry so a "no ready xell" doesn't lose the composed prompt — the whole payload
// is captured in the retry closure) · 'dbop' (a live db backup/restore/copy panel — see DbOpCard).
//
// The db operations (backup / restore / duplicate) render as a WIDER persistent card, not a
// one-line toast: header (op + target + %), a progress bar, the current phase, and the RAW
// pg_dump / pg_restore log streaming in live. It follows the tail unless the human scrolls up to
// read something — the same behaviour as the ship card's live build log.
function DbOpCard({ t, onDismiss }) {
  const logRef = useRef(null);
  const follow = useRef(true);
  useEffect(() => {
    const el = logRef.current;
    if (el && follow.current) el.scrollTop = el.scrollHeight;
  }, [t.lines?.length]);
  const onScroll = () => {
    const el = logRef.current;
    if (el) follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };
  const running = t.status === 'running';
  return (
    <div className={`toast toast-dbop dbop-${t.status}`} data-testid="dbop-card" data-status={t.status}>
      <div className="dbop-head">
        <span className="toast-icon" aria-hidden="true">
          {running ? <span className="toast-spin" /> : t.status === 'finished' ? '✓' : '⚠'}
        </span>
        <span className="toast-title">{t.title}</span>
        {running && t.pct != null && <span className="dbop-pct" data-testid="dbop-pct">{Math.round(t.pct)}%</span>}
        {!running && (
          <button className="toast-x" onClick={() => onDismiss(t.id)}
                  title="Dismiss" aria-label="Dismiss">✕</button>
        )}
      </div>
      {t.body && <div className="toast-body">{t.body}</div>}
      {running && t.pct != null && (
        <div className="toast-progress-bar" title={`${Math.round(t.pct)}%`}>
          <div className="toast-progress-fill" style={{ width: `${Math.max(2, Math.min(100, t.pct))}%` }} />
        </div>
      )}
      {t.lines?.length > 0 && (
        <pre className="dbop-log" ref={logRef} onScroll={onScroll} data-testid="dbop-log">
          {t.lines.join('\n')}
        </pre>
      )}
    </div>
  );
}

export default function Toasts({ toasts, onDismiss }) {
  if (!toasts?.length) return null;
  return (
    <div className="toast-stack" role="status" aria-live="polite" data-testid="toast-stack">
      {toasts.map((t) => (
        t.kind === 'dbop'
          ? <DbOpCard key={t.id} t={t} onDismiss={onDismiss} />
          : (
            <div key={t.id} className={`toast toast-${t.kind}`} data-testid={`toast-${t.kind}`}>
              <span className="toast-icon" aria-hidden="true">
                {t.kind === 'progress' ? <span className="toast-spin" />
                  : t.kind === 'success' ? '✓' : '⚠'}
              </span>
              <div className="toast-main">
                <div className="toast-title">{t.title}</div>
                {t.body && <div className="toast-body">{t.body}</div>}
                {t.onRetry && (
                  <button className="toast-retry" data-testid="toast-retry"
                          onClick={() => t.onRetry(t)}>Retry</button>
                )}
              </div>
              <button className="toast-x" onClick={() => onDismiss(t.id)}
                      title="Dismiss" aria-label="Dismiss">✕</button>
            </div>
          )
      ))}
    </div>
  );
}
