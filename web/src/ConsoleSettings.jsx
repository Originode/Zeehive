import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { getTermEngine, setTermEngine, TERM_ENGINES, onTermEngineChange } from './termPref.js';

// Console-wide preferences that live in the browser (localStorage), not the fleet.
// Today: which terminal engine powers the in-browser shells (xterm.js vs wterm).
// Opened from the topbar ⚙ — a single door so the preference is findable, not buried
// inside a project setup form that is about something else.
export default function ConsoleSettings({ onClose }) {
  const [engine, setEngine] = useState(getTermEngine);

  useEffect(() => onTermEngineChange(setEngine), []);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); onClose?.(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const pick = (e) => { setTermEngine(e); setEngine(e); };

  return createPortal(
    <div className="term-choice-back" data-testid="console-settings-back" onClick={onClose}>
      <div className="console-settings" data-testid="console-settings" onClick={(e) => e.stopPropagation()}>
        <div className="cs-head">
          <span className="cs-title">Console settings</span>
          <button type="button" className="term-x" onClick={onClose} title="Close">✕</button>
        </div>

        <section className="cs-section" data-testid="term-engine-section">
          <div className="cs-label">Terminal engine</div>
          <p className="cs-help">
            The in-browser terminal used for cxell zees, container shells, and the queenzee
            firehose. Applies the next time you open a terminal.
          </p>
          <div className="cs-choices" role="radiogroup" aria-label="Terminal engine">
            <label className={`cs-choice${engine === 'xterm' ? ' on' : ''}`} data-testid="term-engine-xterm">
              <input type="radio" name="term-engine" value="xterm"
                     checked={engine === 'xterm'}
                     onChange={() => pick('xterm')} />
              <span>
                <b>xterm.js</b>
                <small>Canvas renderer — the console default. Mature VT, custom selection/clipboard.</small>
              </span>
            </label>
            <label className={`cs-choice${engine === 'wterm' ? ' on' : ''}`} data-testid="term-engine-wterm">
              <input type="radio" name="term-engine" value="wterm"
                     checked={engine === 'wterm'}
                     onChange={() => pick('wterm')} />
              <span>
                <b>wterm</b>
                <small>DOM + WASM (Vercel) — native text selection, browser find, accessibility. Full VT via Ghostty.</small>
              </span>
            </label>
          </div>
          {/* Keep the allowed set honest if a future engine is added without a radio. */}
          {!TERM_ENGINES.includes(engine) && (
            <p className="cs-help warn">Unknown engine “{engine}” — falling back to xterm on next open.</p>
          )}
        </section>

        <div className="cs-foot">
          <button type="button" className="cs-done" data-testid="console-settings-done" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
