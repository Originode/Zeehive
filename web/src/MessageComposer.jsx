import React, { useEffect, useRef, useState } from 'react';
import { sendXellMessage } from './api.js';

// A "proper message" composer for a xell's live cxell zee — the answer to "the terminal is annoying
// and difficult to use". Long text and/or FILE attachments go over the /xells/:id/message API: the
// server hands files + long text to the zee as real files in its .zee-inbox and types a pointer into
// the live session, so the operator never has to fight the raw terminal for a paste or a screenshot.
//
// Any file can be attached via the file picker, drag-and-drop, or PASTED straight from the clipboard
// (Ctrl-V a screenshot, or a log from a file manager). Each is read to a data-URL and sent as
// { name, type, data }. The wire field is still `images` (legacy name) but it carries any file type.
const MAX_BYTES = 20 * 1024 * 1024; // keep the whole POST under the server's 30mb json limit

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    // A pasted clipboard file often has no name — derive a sane default from its type.
    const ext = (file.type?.split('/')[1] || '').replace(/[^a-z0-9]/gi, '').slice(0, 8);
    const fallback = `pasted${ext ? `.${ext}` : '.bin'}`;
    fr.onload = () => resolve({ name: file.name || fallback, type: file.type || 'application/octet-stream', data: fr.result, size: file.size });
    fr.onerror = () => reject(fr.error || new Error('read failed'));
    fr.readAsDataURL(file);
  });
}

export default function MessageComposer({ xell, onClose, onSent, initialText = '' }) {
  const [text, setText] = useState(initialText);
  const [attachments, setAttachments] = useState([]);   // [{ name, type, data, size }]
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [drag, setDrag] = useState(false);
  const taRef = useRef(null);
  const fileRef = useRef(null);

  // Focus on open. When the composer is pre-filled (e.g. forwarding ship/land error logs), park the
  // cursor at the TOP so the human can type a note above the pasted output instead of at its tail.
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.focus();
    if (initialText) { ta.setSelectionRange(0, 0); ta.scrollTop = 0; }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const totalBytes = attachments.reduce((a, i) => a + (i.size || i.data.length * 0.75), 0);

  const addFiles = async (files) => {
    const picked = Array.from(files || []);
    if (!picked.length) return;
    try {
      const read = await Promise.all(picked.map(readFileAsDataUrl));
      setAttachments((cur) => {
        const next = [...cur, ...read];
        if (next.reduce((a, i) => a + (i.size || 0), 0) > MAX_BYTES) setErr('Attachments exceed 20 MB — remove one.');
        else setErr(null);
        return next;
      });
    } catch (e) { setErr('Could not read file: ' + (e?.message || e)); }
  };

  const onPaste = (e) => {
    const files = Array.from(e.clipboardData?.items || [])
      .filter((it) => it.kind === 'file')
      .map((it) => it.getAsFile()).filter(Boolean);
    if (files.length) { e.preventDefault(); addFiles(files); }
  };
  const onDrop = (e) => { e.preventDefault(); setDrag(false); addFiles(e.dataTransfer?.files); };

  const removeFile = (i) => setAttachments((cur) => cur.filter((_, n) => n !== i));

  const canSend = !busy && (text.trim() || attachments.length) && totalBytes <= MAX_BYTES;

  const send = async () => {
    if (!canSend) return;
    setBusy(true); setErr(null);
    try {
      const r = await sendXellMessage(xell.id, { text, images: attachments.map(({ name, type, data }) => ({ name, type, data })) });
      if (r?.sent && !r?.failed?.length) { onSent?.(r); onClose?.(); }
      else if (r?.sent) {
        // delivered, but some attachments could not be handed over — keep the composer open and say so
        setErr(`Sent, but ${r.failed.length} attachment(s) failed to attach: ${r.failed.join(', ')}`); setBusy(false);
      }
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
          Delivered to the zee's live session. Long text and attachments are handed over as files in its
          <code> .zee-inbox</code> — no terminal typing required.
        </div>
        <textarea ref={taRef} className={`msg-ta${drag ? ' dragging' : ''}`} value={text}
                  placeholder="Write a proper message… (paste or drop files too)"
                  onChange={(e) => setText(e.target.value)} onPaste={onPaste} onKeyDown={onKeyDown} />
        {attachments.length > 0 && (
          <div className="msg-thumbs">
            {attachments.map((att, i) => (
              <div className={att.type?.startsWith('image/') ? 'msg-thumb' : 'msg-filechip'} key={i} title={att.name}>
                {att.type?.startsWith('image/')
                  ? <img src={att.data} alt={att.name} />
                  : <><span className="msg-file-icon">📎</span><span className="msg-file-name">{att.name}</span></>}
                <button className="msg-thumb-x" onClick={() => removeFile(i)} aria-label="remove">✕</button>
              </div>
            ))}
          </div>
        )}
        {err && <div className="msg-err">{err}</div>}
        <div className="msg-foot">
          <button className="msg-attach" onClick={() => fileRef.current?.click()}>📎 attach files</button>
          <input ref={fileRef} type="file" multiple hidden
                 onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
          <span className="msg-hint">⌘/Ctrl+Enter to send</span>
          <button className="msg-send" disabled={!canSend} onClick={send}>{busy ? 'Sending…' : 'Send'}</button>
        </div>
      </div>
    </div>
  );
}
