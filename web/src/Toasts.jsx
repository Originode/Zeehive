import React from 'react';

// A tiny, self-contained toast stack. It exists so a dispatch can be FIRED and forgotten: the
// composer closes the instant you hit submit, and the slow part (uploading a pasted screenshot,
// renaming the worktree, spawning + awaiting the zee) reports its progress here instead of freezing
// the modal behind a "Dispatching…" button. Toasts are owned by App (which keeps running while the
// modal is gone); this component only renders them.
//
// kinds: 'progress' (spinner, sticks until resolved) · 'success' (auto-dismisses) · 'error'
// (sticks, offers Retry so a "no ready xell" doesn't lose the composed prompt — the whole payload
// is captured in the retry closure).
export default function Toasts({ toasts, onDismiss }) {
  if (!toasts?.length) return null;
  return (
    <div className="toast-stack" role="status" aria-live="polite" data-testid="toast-stack">
      {toasts.map((t) => (
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
      ))}
    </div>
  );
}
