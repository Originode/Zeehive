// Own the browser paste event for in-house terminals so the PTY sees it ONCE.
//
// Both engines already handle paste themselves (xterm: textarea + element listeners
// that stopPropagation but do NOT preventDefault; wterm: textarea paste + input).
// On several browsers that means the same clipboard payload is delivered twice —
// paste event AND the following input/insert, or two listeners — so the PTY types
// the text twice. We own paste in the CAPTURE phase on the host element: swallow
// it before the engine sees it, normalise newlines, honour bracketed-paste when
// the app has enabled it, and call onData exactly once.
//
// `bracketed` is a getter so it always reflects the live DEC mode (tmux/bash turn
// it on after attach), not the value at mount time.

export function attachOwnedPaste(el, { onData, disableStdin, bracketed } = {}) {
  const onPaste = (e) => {
    // Always kill the browser default so the engine's own handlers never see a
    // default-inserted textarea value (the second half of the double-paste).
    e.preventDefault();
    e.stopPropagation();
    if (disableStdin || !onData) return;
    const raw = e.clipboardData?.getData('text/plain') || e.clipboardData?.getData('text') || '';
    if (!raw) return;
    // Same newline fold xterm's prepareTextForTerminal applies.
    let text = raw.replace(/\r?\n/g, '\r');
    let useBracket = false;
    try { useBracket = !!bracketed?.(); } catch { /* torn down */ }
    if (useBracket) {
      // Strip ESC so a payload cannot break out of bracketed paste (wterm does this).
      text = `\x1b[200~${text.replace(/\x1b/g, '')}\x1b[201~`;
    }
    onData(text);
  };
  el.addEventListener('paste', onPaste, true);
  return () => { try { el.removeEventListener('paste', onPaste, true); } catch { /* */ } };
}
