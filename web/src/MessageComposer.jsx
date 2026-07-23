import React, { useEffect, useRef, useState } from 'react';
import { sendXellMessage } from './api.js';

// A "proper message" composer for a xell's live cxell zee — the answer to "the terminal is annoying
// and difficult to use". Long text and/or image attachments go over the /xells/:id/message API: the
// server hands images + long text to the zee as real files in its .zee-inbox and types a pointer into
// the live session, so the operator never has to fight the raw terminal for a paste or a screenshot.
//
// Images can be attached via the file picker, drag-and-drop, or PASTED straight from the clipboard
// (Ctrl-V a screenshot). Each is read to a data-URL and sent as { name, type, data }.
const MAX_BYTES = 20 * 1024 * 1024; // keep the whole POST under the server's 30mb json limit

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve({ name: file.name || 'pasted-image.png', type: file.type || 'image/png', data: fr.result, size: file.size });
    fr.onerror = () => reject(fr.error || new Error('read failed'));
    fr.readAsDataURL(file);
  });
}

export default function MessageComposer({ xell, onClose, onSent }) {
  const [text, setText] = useState('');
  const [images, setImages] = useState([]);   // [{ name, type, data, size }]
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [drag, setDrag] = useState(false);
  const taRef = useRef(null);
  const fileRef = useRef(null);

  useEffect(() => { taRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const totalBytes = images.reduce((a, i) => a + (i.size || i.data.length * 0.75), 0);

  const addFiles = async (files) => {
    const picked = Array.from(files || []).filter((f) => f.type.startsWith('image/'));
    if (!picked.length) return;
    try {
      const read = await Promise.all(picked.map(readFileAsDataUrl));
      setImages((cur) => {
        const next = [...cur, ...read];
        if (next.reduce((a, i) => a + (i.size || 0), 0) > MAX_BYTES) setErr('Attachments exceed 20 MB — remove one.');
        else setErr(null);
        return next;
      });
    } catch (e) { setErr('Could not read image: ' + (e?.message || e)); }
  };

  const onPaste = (e) => {
    const files = Array.from(e.clipboardData?.items || [])
      .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
      .map((it) => it.getAsFile()).filter(Boolean);
    if (files.length) { e.preventDefault(); addFiles(files); }
  };
  const onDrop = (e) => { e.preventDefault(); setDrag(false); addFiles(e.dataTransfer?.files); };

  const removeImage = (i) => setImages((cur) => cur.filter((_, n) => n !== i));

  const canSend = !busy && (text.trim() || images.length) && totalBytes <= MAX_BYTES;

  const send = async () => {
    if (!canSend) return;
    setBusy(true); setErr(null);
    try {
      const r = await sendXellMessage(xell.id, { text, images });
      if (r?.sent) { onSent?.(r); onClose?.(); }
      else { setErr(r?.reason || r?.error || 'no live cxell zee to reach'); setBusy(false); }
    } catch (e) { setErr(e?.message || String(e)); setBusy(false); }
  };

  const onKeyDown = (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); send(); } };

  return (
    <div className="msg-back" onClick={onClose}>
      <div className="msg-modal" onClick={(e) => e.stopPropagation()}
           onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
           onDragLeave={() => setDrag(false)} onDrop={onDrop}>
        <div className="msg-head">
          <span className="msg-title">📨 Message <b>{xell.slug}</b></span>
          <button className="msg-x" onClick={onClose} aria-label="close">✕</button>
        </div>
        <div className="msg-sub">
          Delivered to the zee's live session. Long text and images are handed over as files in its
          <code> .zee-inbox</code> — no terminal typing required.
        </div>
        <textarea ref={taRef} className={`msg-ta${drag ? ' dragging' : ''}`} value={text}
                  placeholder="Write a proper message… (paste or drop images too)"
                  onChange={(e) => setText(e.target.value)} onPaste={onPaste} onKeyDown={onKeyDown} />
        {images.length > 0 && (
          <div className="msg-thumbs">
            {images.map((img, i) => (
              <div className="msg-thumb" key={i} title={img.name}>
                <img src={img.data} alt={img.name} />
                <button className="msg-thumb-x" onClick={() => removeImage(i)} aria-label="remove">✕</button>
              </div>
            ))}
          </div>
        )}
        {err && <div className="msg-err">{err}</div>}
        <div className="msg-foot">
          <button className="msg-attach" onClick={() => fileRef.current?.click()}>📎 attach image</button>
          <input ref={fileRef} type="file" accept="image/*" multiple hidden
                 onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
          <span className="msg-hint">⌘/Ctrl+Enter to send</span>
          <button className="msg-send" disabled={!canSend} onClick={send}>{busy ? 'Sending…' : 'Send'}</button>
        </div>
      </div>
    </div>
  );
}
