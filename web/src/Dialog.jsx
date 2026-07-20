import React, { useEffect, useRef, useState } from 'react';

// ── A non-blocking replacement for window.alert() ──────────────────────────────────────────────
// The native alert()/confirm()/prompt() dialogs are SYNCHRONOUS: they park the browser's event
// loop until the human clicks OK, which freezes the whole page — no repaint, no SSE stream, no
// other button. That is exactly the "push held at the gate" box that pinned the hive graph. This
// module is a tiny imperative modal that looks and is called like alert() (`showAlert('…')` from
// anywhere, no hook plumbing) but renders as a React overlay that never blocks the main thread.
//
// It is a singleton store so module-level helpers (buildErr, fail, …) can call it without a
// component in scope. Dialogs queue FIFO — a second showAlert() while one is open waits its turn,
// matching alert()'s one-at-a-time feel without ever stalling the page underneath.

let _seq = 0;
let _queue = [];
const _listeners = new Set();
const _emit = () => { for (const fn of _listeners) fn(_queue); };

// Push a dialog and resolve when it is dismissed. Returns a Promise so a caller *may* await the
// acknowledgement, but (like alert) nothing is forced to.
function _push(dialog) {
  return new Promise((resolve) => {
    _queue = [..._queue, { ..._dialog(dialog), id: ++_seq, resolve }];
    _emit();
  });
}

function _dialog(d) {
  const message = d.message == null ? '' : String(d.message);
  return { variant: 'info', okLabel: 'OK', ...d, message };
}

function _resolve(id, value) {
  const d = _queue.find((x) => x.id === id);
  _queue = _queue.filter((x) => x.id !== id);
  _emit();
  d?.resolve(value);
}

// showAlert(message) or showAlert(message, { title, variant: 'error'|'info', okLabel })
export function showAlert(message, opts = {}) {
  return _push({ ...opts, message });
}

// Mount ONCE (see main.jsx). Renders the head of the queue as an overlay; the page keeps living.
export function DialogHost() {
  const [queue, setQueue] = useState(_queue);
  useEffect(() => {
    _listeners.add(setQueue);
    return () => { _listeners.delete(setQueue); };
  }, []);

  const current = queue[0] || null;
  const okRef = useRef(null);

  // Focus the OK button when a dialog opens so Enter/Space dismiss it (keyboard parity with alert).
  useEffect(() => { if (current) okRef.current?.focus(); }, [current?.id]);

  // Global keys while a dialog is up: Enter or Escape both dismiss (an alert has one exit).
  useEffect(() => {
    if (!current) return;
    const onKey = (e) => {
      if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); _resolve(current.id); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [current?.id]);

  if (!current) return null;
  const title = current.title || (current.variant === 'error' ? 'Something went wrong' : 'Notice');

  return (
    <div className={`dlg-overlay dlg-${current.variant}`} data-testid="dialog-overlay"
         onMouseDown={(e) => { if (e.target === e.currentTarget) _resolve(current.id); }}>
      <div className="dlg" role="alertdialog" aria-modal="true" aria-label={title}>
        <div className="dlg-head">
          <span className="dlg-icon" aria-hidden="true">{current.variant === 'error' ? '⚠' : 'ℹ'}</span>
          <span className="dlg-title">{title}</span>
        </div>
        <div className="dlg-body" data-testid="dialog-message">{current.message}</div>
        <div className="dlg-foot">
          <button ref={okRef} className="dlg-ok" data-testid="dialog-ok"
                  onClick={() => _resolve(current.id)}>{current.okLabel}</button>
        </div>
      </div>
    </div>
  );
}
