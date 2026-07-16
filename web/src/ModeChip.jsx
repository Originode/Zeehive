import React, { useState, useRef, useEffect } from 'react';
import { setZeeMode } from './api.js';

// The harness's permission modes — what a running session can be switched between. Chip text is
// terse (it sits inline in a 12px card row); the dropdown carries the full words. Tool
// allow-lists are fixed at spawn, so this is deliberately the permission half only, not the 1–5
// dispatch scale.
const MODES = [
  { key: 'plan',              chip: 'plan',   label: 'Plan',            desc: 'read-only — investigates, changes nothing' },
  { key: 'default',           chip: 'manual', label: 'Manual approval', desc: 'asks before each sensitive tool' },
  { key: 'acceptEdits',       chip: 'edits',  label: 'Accept edits',    desc: 'file edits auto-approved' },
  { key: 'bypassPermissions', chip: 'bypass', label: 'Bypass',          desc: 'no permission prompts at all' },
];
const byKey = (k) => MODES.find((m) => m.key === k);

// The session's mode, inline in the card's session row. Click → dropdown to change it. The
// server live-applies when it holds the session's handle (headless zees mid-turn); otherwise it
// records the value and returns a note — surfaced here — saying the running session keeps its
// own mode until changed in-session. Hooks re-sync the chip to whatever the session reports.
export default function ModeChip({ zeeId, mode }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ left: 0, top: 0 });
  const [busy, setBusy] = useState(false);
  const ref = useRef(null);

  // close on outside click / Esc / scroll (the popup is position:fixed, so scrolling detaches it)
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    const onScroll = () => setOpen(false);
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open]);

  const toggle = (e) => {
    e.stopPropagation(); // the whole card is a click-to-open-session target
    const r = e.currentTarget.getBoundingClientRect();
    setPos({ left: r.left, top: r.bottom + 4 });
    setOpen((o) => !o);
  };

  const pick = async (e, key) => {
    e.stopPropagation();
    setOpen(false);
    if (key === mode || busy) return;
    setBusy(true);
    try {
      const r = await setZeeMode(zeeId, key);
      // applied:false → recorded on the zee only; tell the human what is (and isn't) real.
      if (r?.note) alert(r.note);
    } catch (err) {
      alert('Mode change failed: ' + (err?.message || err));
    } finally { setBusy(false); }
  };

  const cur = byKey(mode);
  return (
    <span className="modemenu" ref={ref} onClick={(e) => e.stopPropagation()}>
      <button className="modechip" data-mode={mode || 'unknown'} data-testid="mode-chip"
              disabled={busy} aria-haspopup="menu" aria-expanded={open} onClick={toggle}
              title={(cur ? `${cur.label} — ${cur.desc}` : 'mode not reported by this session yet')
                + '\n(click to change)'}>
        {busy ? '…' : (cur ? cur.chip : mode || '?')}
      </button>
      {open && (
        <div className="ctxmenu modepop" style={{ left: pos.left, top: pos.top }} role="menu">
          <div className="ctxhead">session mode</div>
          {MODES.map((m) => (
            <button key={m.key} role="menuitem" data-testid={`mode-${m.key}`}
                    onClick={(e) => pick(e, m.key)}>
              <span className="modedot">{m.key === mode ? '●' : '○'}</span>
              {m.label} <span className="ctxsub">{m.desc}</span>
            </button>
          ))}
        </div>
      )}
    </span>
  );
}
