import React, { useEffect, useRef, useState } from 'react';

// ── A non-blocking replacement for window.alert() / confirm() / prompt() ────────────────────────
// The native alert()/confirm()/prompt() dialogs are SYNCHRONOUS: they park the browser's event
// loop until the human answers, which freezes the whole page — no repaint, no SSE stream, no other
// button. That is the "push held at the gate" box that pinned the hive graph, and every "Land …?",
// "Ship …?", "type: done" prompt did the same. This module is a tiny imperative modal that is
// CALLED like the natives (from anywhere, no hook plumbing) but renders as a React overlay that
// never blocks the main thread:
//
//   await showAlert('done')                        // returns undefined when dismissed
//   if (!(await showConfirm('Land x?'))) return    // true = OK, false = Cancel
//   const name = await showPrompt('type: done')    // string, or null when cancelled
//
// It is a singleton store so module-level helpers can call it without a component in scope. Dialogs
// queue FIFO — a second call while one is open waits its turn, matching the natives' one-at-a-time
// feel without ever stalling the page underneath.

let _seq = 0;
let _queue = [];
const _listeners = new Set();
const _emit = () => { for (const fn of _listeners) fn(_queue); };

// Push a dialog and resolve when it is answered. Returns a Promise the caller awaits (confirm/
// prompt) or may ignore (alert).
function _push(dialog) {
  return new Promise((resolve) => {
    _queue = [..._queue, { ..._defaults(dialog), id: ++_seq, resolve }];
    _emit();
  });
}

function _defaults(d) {
  const message = d.message == null ? '' : String(d.message);
  return { kind: 'alert', variant: 'info', okLabel: 'OK', cancelLabel: 'Cancel', ...d, message };
}

function _answer(id, value) {
  const d = _queue.find((x) => x.id === id);
  _queue = _queue.filter((x) => x.id !== id);
  _emit();
  d?.resolve(value);
}

// showAlert(message[, { title, variant: 'error'|'info', okLabel }]) → Promise<undefined>
export function showAlert(message, opts = {}) {
  return _push({ ...opts, kind: 'alert', message });
}

// showConfirm(message[, { title, variant, okLabel, cancelLabel }]) → Promise<boolean>
export function showConfirm(message, opts = {}) {
  return _push({ ...opts, kind: 'confirm', message });
}

// showPrompt(message[, { title, defaultValue, okLabel, cancelLabel, placeholder }]) → Promise<string|null>
export function showPrompt(message, opts = {}) {
  return _push({ ...opts, kind: 'prompt', message, defaultValue: opts.defaultValue ?? '' });
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
  const inputRef = useRef(null);
  const [text, setText] = useState('');

  // (Re)seed the prompt input and move focus whenever a new dialog surfaces: the input for a
  // prompt, otherwise the OK button (so Enter/Space answer it — keyboard parity with the natives).
  useEffect(() => {
    if (!current) return;
    if (current.kind === 'prompt') {
      setText(current.defaultValue || '');
      const el = inputRef.current;
      if (el) { el.focus(); el.select?.(); }
    } else {
      okRef.current?.focus();
    }
  }, [current?.id]);

  // The negative answer for a dialog: confirm → false, prompt → null, alert → undefined (its one exit).
  const negative = (d) => (d.kind === 'confirm' ? false : d.kind === 'prompt' ? null : undefined);

  // Global keys while a dialog is up. Enter answers positively (submit the prompt / OK / dismiss);
  // Escape answers negatively (Cancel / dismiss). A textarea in the prompt handles its own Enter.
  useEffect(() => {
    if (!current) return;
    const positive = current.kind === 'confirm' ? true : undefined; // prompt handles Enter on its input
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); _answer(current.id, negative(current)); }
      else if (e.key === 'Enter' && current.kind !== 'prompt') { e.preventDefault(); _answer(current.id, positive); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [current?.id]);

  if (!current) return null;
  const { kind, variant } = current;
  const title = current.title
    || (variant === 'error' ? 'Something went wrong'
      : kind === 'confirm' ? 'Please confirm'
      : kind === 'prompt' ? 'Input needed'
      : 'Notice');
  const icon = (variant === 'error' || variant === 'danger') ? '⚠' : kind === 'alert' ? 'ℹ' : '?';
  const confirmValue = kind === 'confirm' ? true : kind === 'prompt' ? text : undefined;

  return (
    <div className={`dlg-overlay dlg-${variant}`} data-testid="dialog-overlay"
         onMouseDown={(e) => { if (e.target === e.currentTarget) _answer(current.id, negative(current)); }}>
      <div className="dlg" role={kind === 'alert' ? 'alertdialog' : 'dialog'} aria-modal="true" aria-label={title}>
        <div className="dlg-head">
          <span className="dlg-icon" aria-hidden="true">{icon}</span>
          <span className="dlg-title">{title}</span>
        </div>
        <div className="dlg-body" data-testid="dialog-message">{current.message}</div>
        {kind === 'prompt' && (
          <div className="dlg-input-wrap">
            <input ref={inputRef} className="dlg-input" data-testid="dialog-input" value={text}
                   placeholder={current.placeholder || ''}
                   onChange={(e) => setText(e.target.value)}
                   onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); _answer(current.id, text); } }} />
          </div>
        )}
        <div className="dlg-foot">
          {kind !== 'alert' && (
            <button className="dlg-cancel" data-testid="dialog-cancel"
                    onClick={() => _answer(current.id, negative(current))}>{current.cancelLabel}</button>
          )}
          <button ref={okRef} className="dlg-ok" data-testid="dialog-ok"
                  onClick={() => _answer(current.id, confirmValue)}>{current.okLabel}</button>
        </div>
      </div>
    </div>
  );
}
