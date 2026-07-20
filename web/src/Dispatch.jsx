import React, { useEffect, useRef, useState } from 'react';
import { getDispatchModes, getDispatchModels } from './api.js';

// The "+" composer. A human writes a prompt (rich text, paste-friendly, images welcome) and picks
// the autonomy mode / model / attended flag — then SUBMIT dispatches it exactly like a /xell
// dispatch: the queenzee claims a ready xell for this project and spawns a zee into its worktree
// with the task text (+ any pasted images). This is not a parallel one-off mechanism; it POSTs the
// same /api/xell/dispatch the CLI dispatch does, so the new xell shows up like any other.
//
// The overlay deliberately does NOT close on an outside click — a half-written prompt is real work,
// and losing it to a stray click is worse than one extra button press. Close is ✕ / Cancel only.
//
// SUBMIT IS FIRE-AND-FORGET: dispatching a zee is slow (it uploads any pasted screenshot, renames
// the worktree, then spawns and AWAITS the real zee start), and an attached image made the old
// blocking "Dispatching…" button freeze the modal for seconds. So submit now just validates, hands
// the whole payload up to the parent and closes at once — the parent runs the dispatch and reports
// progress through a toast (including a Retry that reuses this exact payload if it fails).
export default function Dispatch({ projectId, projectName, provider = 'claude', providerLabel, onClose, onDispatch }) {
  const editorRef = useRef(null);
  const [modes, setModes] = useState([]);
  const [models, setModels] = useState([]);
  const [mode, setMode] = useState(5);            // default 5 = bypass (fully unattended)
  const [model, setModel] = useState('opus');     // overwritten by the server's default once loaded
  const [headless, setHeadless] = useState(true); // default headless (fire-and-forget)
  const [prodDb, setProdDb] = useState(false);    // OFF by default — LIVE production data, opt-in only
  const [images, setImages] = useState([]);       // [{ id, name, data(dataURL), size }]
  const [err, setErr] = useState(null);
  const [empty, setEmpty] = useState(true);       // drives the placeholder + submit-disabled state

  useEffect(() => {
    getDispatchModes().then((ms) => setModes(ms)).catch(() => {});
    getDispatchModels().then((ms) => {
      setModels(ms);
      const def = ms.find((m) => m.default) || ms[0];
      if (def) setModel(def.key);
    }).catch(() => {});
    // focus the editor on open so the human can just start typing
    setTimeout(() => editorRef.current?.focus(), 30);
  }, []);

  // Esc closes only when nothing is composed — so it can't silently discard a written prompt.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape' && empty && !images.length) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [empty, images.length, onClose]);

  const addImage = (img) =>
    setImages((prev) => [...prev, { id: `${Date.now()}-${prev.length}`, ...img }]);
  const removeImage = (id) => setImages((prev) => prev.filter((im) => im.id !== id));

  const syncEmpty = () => setEmpty(!(editorRef.current?.innerText || '').trim());

  // Paste: capture image FILES (a pasted screenshot) as attachments rather than letting the browser
  // dump a giant base64 blob into the editor; let text/HTML paste through so formatted text lands
  // sensibly. If the clipboard has both an image and text, we keep the text and grab the image.
  const onPaste = (e) => {
    const items = Array.from(e.clipboardData?.items || []);
    const imgItems = items.filter((it) => it.kind === 'file' && it.type.startsWith('image/'));
    if (!imgItems.length) return; // plain/rich text paste — default behaviour is fine
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain');
    if (text) { document.execCommand('insertText', false, text); syncEmpty(); }
    imgItems.forEach((it, i) => {
      const file = it.getAsFile();
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => addImage({
        name: file.name || `pasted-${Date.now()}-${i + 1}.${(file.type.split('/')[1] || 'png')}`,
        data: reader.result,
        size: file.size,
      });
      reader.readAsDataURL(file);
    });
  };

  const submit = () => {
    const task = (editorRef.current?.innerText || '').trim();
    if (!task) { setErr('Write a prompt first (an image alone is not enough — the zee needs a task).'); return; }
    // Hand the whole payload up and let the parent dispatch it asynchronously (progress → toast).
    // The prompt isn't lost on failure: the parent captures this payload in the toast's Retry.
    onDispatch?.({
      project: projectId,
      task,
      provider,   // which connected AI provider's button opened this composer
      mode,
      model,
      headless,
      // OPT-IN prod DATA access. The value is the full db_coupling ('db-shared-prod'), which the
      // dispatch hands to attachXellDb → the prod db container becomes THIS xell's assigned
      // database. Reads and writes are allowed; the prod guard HARD-BLOCKS schema changes (DDL).
      ...(prodDb ? { db: 'db-shared-prod' } : {}),
      images: images.map(({ name, data }) => ({ name, data })),
    });
  };

  const onKeyDown = (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); submit(); }
  };

  const totalMb = images.reduce((n, im) => n + (im.size || 0), 0) / (1024 * 1024);

  return (
    <div className="disp-overlay">
      <div className="disp" role="dialog" aria-label="Compose a prompt" data-testid="dispatch-modal">
        <div className="disp-head">
          <span className="disp-title">＋ New prompt <span className="disp-sub">→ dispatches a zee into a ready xell{projectName ? ` · ${projectName}` : ''}</span></span>
          <button className="disp-x" onClick={onClose} title="Close">✕</button>
        </div>

        <div className="disp-body">
          <div className="disp-editor-wrap">
            {empty && <div className="disp-placeholder">Describe the task for the zee… (paste text or a screenshot — ⌘/Ctrl+Enter to dispatch)</div>}
            <div className="disp-editor" ref={editorRef} contentEditable suppressContentEditableWarning
                 data-testid="dispatch-editor" role="textbox" aria-multiline="true"
                 onInput={syncEmpty} onPaste={onPaste} onKeyDown={onKeyDown} />
          </div>

          {images.length > 0 && (
            <div className="disp-imgs" data-testid="dispatch-images">
              {images.map((im) => (
                <div className="disp-img" key={im.id} title={im.name}>
                  <img src={im.data} alt={im.name} />
                  <button className="disp-img-x" onClick={() => removeImage(im.id)}
                          title="Remove this image" aria-label="Remove image">✕</button>
                </div>
              ))}
              <span className="disp-imgnote">{images.length} image{images.length === 1 ? '' : 's'} · {totalMb.toFixed(1)} MB — handed to the zee as files in its worktree</span>
            </div>
          )}

          <div className="disp-controls">
            <div className="disp-field">
              <label className="disp-label">Autonomy mode</label>
              <div className="disp-modes" role="group" aria-label="Autonomy mode">
                {(modes.length ? modes : FALLBACK_MODES).map((m) => (
                  <button key={m.mode} className={`disp-seg ${mode === m.mode ? 'on' : ''}`}
                          data-testid={`dispatch-mode-${m.mode}`}
                          title={m.label} onClick={() => setMode(m.mode)}>
                    <b>{m.mode}</b> {m.key}
                  </button>
                ))}
              </div>
              <div className="disp-hint">{(modes.find((m) => m.mode === mode) || FALLBACK_MODES.find((m) => m.mode === mode))?.label}</div>
            </div>

            <div className="disp-field">
              <label className="disp-label">Model</label>
              <div className="disp-models" role="group" aria-label="Model">
                {(models.length ? models : FALLBACK_MODELS).map((m) => (
                  <button key={m.key} className={`disp-seg ${model === m.key ? 'on' : ''}`}
                          data-testid={`dispatch-model-${m.key}`}
                          title={m.note || m.label} onClick={() => setModel(m.key)}>
                    {m.label}{m.default ? ' ·default' : ''}
                  </button>
                ))}
              </div>
            </div>

            <div className="disp-field">
              <label className="disp-label">Supervision</label>
              <div className="disp-sup" role="group" aria-label="Supervision">
                <button className={`disp-seg ${headless ? 'on' : ''}`} data-testid="dispatch-headless"
                        title="Fire-and-forget — the zee decides and keeps going, never stops to ask."
                        onClick={() => setHeadless(true)}>headless</button>
                <button className={`disp-seg ${!headless ? 'on' : ''}`} data-testid="dispatch-attended"
                        title="A human may open the session; the zee may stop and ask on a load-bearing decision."
                        onClick={() => setHeadless(false)}>attended</button>
              </div>
            </div>

            <div className="disp-field">
              <label className="disp-label">Production DB access</label>
              <div className="disp-sup" role="group" aria-label="Production database access">
                <button className={`disp-seg ${!prodDb ? 'on' : ''}`} data-testid="dispatch-proddb-off"
                        title="The xell uses its normal (dev) database — the safe default."
                        onClick={() => setProdDb(false)}>off</button>
                <button className={`disp-seg disp-seg-danger ${prodDb ? 'on' : ''}`} data-testid="dispatch-proddb-on"
                        title="Point this xell at the LIVE PRODUCTION database — real, irreversible writes. Schema changes are hard-blocked."
                        onClick={() => setProdDb(true)}>⚠ LIVE PROD</button>
              </div>
              <div className="disp-hint">For manual data processing on prod. Read + write only — schema changes (DDL) are hard-blocked.</div>
            </div>
          </div>

          {prodDb && (
            <div className="disp-warn" data-testid="dispatch-proddb-warning" role="alert">
              <div className="disp-warn-title">⚠ LIVE PRODUCTION DATABASE</div>
              <div className="disp-warn-body">
                This zee will be pointed at the <b>real production database</b>. Every <b>INSERT / UPDATE / DELETE</b> it
                runs is <b>immediate and irreversible</b> — there is no undo. Only use this for deliberate, manual data
                processing that a human is watching.
                <br />
                <b>Schema changes are hard-blocked:</b> CREATE / ALTER / DROP / TRUNCATE and any other DDL are refused by
                the prod guard — those must go through a migration and a ship, never a live edit.
              </div>
            </div>
          )}

          {err && <div className="disp-err" data-testid="dispatch-error">{err}</div>}
        </div>

        <div className="disp-foot">
          <button className="disp-cancel" onClick={onClose}>Cancel</button>
          <button className="disp-submit" onClick={submit} data-testid="dispatch-submit">
            Dispatch →
          </button>
        </div>
      </div>
    </div>
  );
}

// Shown only if the API calls fail — keeps the composer usable rather than blank.
const FALLBACK_MODES = [
  { mode: 1, key: 'plan',   label: 'read-only recon — investigates, changes nothing' },
  { mode: 2, key: 'edits',  label: 'edit files, no shell' },
  { mode: 3, key: 'shell',  label: 'edit files + run shell' },
  { mode: 4, key: 'auto',   label: 'all tools, auto-accept edits' },
  { mode: 5, key: 'bypass', label: 'bypass all permission prompts (fully unattended)' },
];
const FALLBACK_MODELS = [
  { key: 'opus', label: 'Opus', default: true },
  { key: 'sonnet', label: 'Sonnet' },
  { key: 'haiku', label: 'Haiku' },
];
