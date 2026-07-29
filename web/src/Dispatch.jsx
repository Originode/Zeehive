import React, { useEffect, useRef, useState } from 'react';
import { getDispatchModes, getDispatchModels, getHarnesses } from './api.js';

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
//
// ── ONE COMPOSER, TWO ZEE TYPES (`manager`) ─────────────────────────────────────────────────────
// Adding a MANAGER used to be a one-line showPrompt() box: a single `<input>` for what is the most
// consequential prompt in the fleet — the programme an agent runs a whole CREW from. You could not
// see what you had typed, could not paste a backlog or a screenshot, could not pick the model, the
// autonomy mode or the account, and Enter fired it. A worker (one xell, one job) got the full
// composer; the manager above it got a text field. So the manager now opens THIS modal with
// `manager` set, and the differences are only the ones that are actually true of a manager:
//   • it offers MANAGER harnesses (a worker harness on a manager is refused by the DB anyway);
//   • there is NO prod-DB toggle — a manager is always bound to production READ-ONLY, and that is
//     not a switch a human flips here (stated as a note instead of a control that lies);
//   • the brief MAY be left blank — the server then hands it DEFAULT_MANAGER_BRIEF (study the
//     project, propose a plan, ask before starting a crew), which is a real answer, not an empty one.
// Everything else — the editor, images, model, mode, supervision, account — is shared, because a
// manager's prompt deserves at least what a worker's gets.
export default function Dispatch({ projectId, projectName, provider = 'claude', providerLabel, tokenId = null,
                                   manager = false, accounts = null, onClose, onDispatch }) {
  const editorRef = useRef(null);
  const [modes, setModes] = useState([]);
  const [models, setModels] = useState([]);
  // WHICH ACCOUNT runs this zee. The worker composer is opened FROM an account's own button, so it
  // arrives decided (accounts=null → the provider/tokenId props stand). The manager button is one
  // button for the whole fleet, so it passes the list and the choice is made in here.
  const [acct, setAcct] = useState(() => (accounts?.length ? accounts[0] : null));
  const activeProvider = acct?.provider || provider;
  const activeTokenId = acct ? acct.id : tokenId;
  // A xell may only wear a harness of its own zee type (054's guard), so ask for the list this
  // composer is allowed to offer: worker personas for a dispatch, manager ones for a manager.
  const [harnesses, setHarnesses] = useState([]);
  // undefined = use the default (omit; project default for a worker, the manager harness for a
  // manager); '' = core only (send null); 'hermes' = that harness.
  const [harness, setHarness] = useState(undefined);
  const [mode, setMode] = useState(5);            // default 5 = bypass (fully unattended)
  const [model, setModel] = useState('opus');     // overwritten by the server's default once loaded
  const [headless, setHeadless] = useState(true); // default headless (fire-and-forget)
  const [prodDb, setProdDb] = useState(false);    // OFF by default — LIVE production data, opt-in only
  const [images, setImages] = useState([]);       // [{ id, name, data(dataURL), size }]
  const [err, setErr] = useState(null);
  const [empty, setEmpty] = useState(true);       // drives the placeholder + submit-disabled state

  useEffect(() => {
    getDispatchModes().then((ms) => setModes(ms)).catch(() => {});
    // The model list is the PROVIDER'S — a Codex composer offers Codex model ids, a Kimi one
    // Kimi's; claude keeps opus/sonnet/haiku. The server owns the lists (/xell/models?provider=).
    getDispatchModels(activeProvider).then((ms) => {
      setModels(ms);
      const def = ms.find((m) => m.default) || ms[0];
      if (def) setModel(def.key);
    }).catch(() => {});
    // Harnesses are non-core, enabled config layers; core is always-on and implicit, so the picker
    // only offers the extras (plus a "core only" = none).
    getHarnesses(manager ? 'manager' : 'worker')
      .then((hs) => setHarnesses(hs.filter((h) => !h.is_law_core))).catch(() => {});
    // focus the editor on open so the human can just start typing
    setTimeout(() => editorRef.current?.focus(), 30);
  }, [activeProvider, manager]);

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
    // A WORKER with no task is nothing to do. A MANAGER with no task is a defined thing: the server
    // hands it DEFAULT_MANAGER_BRIEF (study the project, propose a programme, ask before starting a
    // crew), which is exactly what the old one-line box allowed by leaving it blank. Keep that.
    if (!task && !manager) { setErr('Write a prompt first (an image alone is not enough — the zee needs a task).'); return; }
    // Hand the whole payload up and let the parent dispatch it asynchronously (progress → toast).
    // The prompt isn't lost on failure: the parent captures this payload in the toast's Retry.
    onDispatch?.({
      project: projectId,
      ...(task ? { task } : {}),
      provider: activeProvider,   // which AI provider TYPE runs this zee (picks the runtime)
      // which exact ACCOUNT of that type — a project can hold several (e.g. two Claude
      // subscriptions); the spawn uses precisely this one's token
      ...(activeTokenId ? { provider_token_id: activeTokenId } : {}),
      mode,
      model,
      headless,
      // OPT-IN prod DATA access. The value is the full db_coupling ('db-shared-prod'), which the
      // dispatch hands to attachXellDb → the prod db container becomes THIS xell's assigned
      // database. Reads and writes are allowed; the prod guard HARD-BLOCKS schema changes (DDL).
      ...(prodDb ? { db: 'db-shared-prod' } : {}),
      // the config layer this zee wears (persona/skills). undefined → omit (project default); ''
      // → core only (null); a key → that harness.
      ...(harness !== undefined ? { harness: harness || null } : {}),
      images: images.map(({ name, data }) => ({ name, data })),
    });
  };

  const onKeyDown = (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); submit(); }
  };

  const totalMb = images.reduce((n, im) => n + (im.size || 0), 0) / (1024 * 1024);

  return (
    <div className="disp-overlay">
      <div className={`disp${manager ? ' disp-mgr' : ''}`} role="dialog"
           aria-label={manager ? 'Add a manager zee' : 'Compose a prompt'}
           data-testid={manager ? 'manager-modal' : 'dispatch-modal'}>
        <div className="disp-head">
          {manager ? (
            <span className="disp-title">⬢ ＋ manager zee <span className="disp-sub">→ runs a CREW: dispatches workers, reads production (read-only), pushes nothing{projectName ? ` · ${projectName}` : ''}</span></span>
          ) : (
            <span className="disp-title">＋ New prompt{providerLabel ? ` · ${providerLabel}` : ''} <span className="disp-sub">→ dispatches a zee into a ready xell{projectName ? ` · ${projectName}` : ''}</span></span>
          )}
          <button className="disp-x" onClick={onClose} title="Close">✕</button>
        </div>

        <div className="disp-body">
          {manager && (
            <p className="disp-note" data-testid="manager-what">
              A manager runs a crew: it dispatches worker zees, talks to them in real time, reads
              their post-ship reflections and suggests when one is done (<b>you</b> confirm). It
              holds the <b>production database READ-ONLY</b> — its own postgres role, granted SELECT
              and nothing else — and it has <b>zero push access</b> to the xource: it writes no code
              and lands none. Give it its <b>programme</b> below.
            </p>
          )}
          <div className="disp-editor-wrap">
            {empty && (
              <div className="disp-placeholder">
                {manager
                  ? 'Its programme — what this crew is FOR, in priority order… (paste a backlog or a screenshot; ⌘/Ctrl+Enter to add. Leave blank and it will study the project, propose a plan and ask you before starting a crew.)'
                  : 'Describe the task for the zee… (paste text or a screenshot — ⌘/Ctrl+Enter to dispatch)'}
              </div>
            )}
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
            {/* WHICH ACCOUNT — only when the opener handed us a list (the manager button, which is
                one button for every connected account). A worker composer is opened from an
                account's own button, so it renders nothing here and nothing changes for it. */}
            {accounts?.length > 1 && (
              <div className="disp-field">
                <label className="disp-label">Account</label>
                <div className="disp-models" role="group" aria-label="AI account">
                  {accounts.map((a) => (
                    <button key={a.id} className={`disp-seg ${acct?.id === a.id ? 'on' : ''}`}
                            data-testid={`dispatch-account-${a.id}`}
                            title={`Run this zee on ${a.name} (${a.typeLabel}) — its own CLI inside the cxell`}
                            onClick={() => setAcct(a)}>
                      {a.name}
                    </button>
                  ))}
                </div>
              </div>
            )}

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
                {(models.length ? models : fallbackModels(activeProvider)).map((m) => (
                  <button key={m.key} className={`disp-seg ${model === m.key ? 'on' : ''}`}
                          data-testid={`dispatch-model-${m.key}`}
                          title={m.note || m.label} onClick={() => setModel(m.key)}>
                    {m.label}{m.default ? ' ·default' : ''}
                  </button>
                ))}
              </div>
            </div>

            {harnesses.length > 0 && (
              <div className="disp-field">
                <label className="disp-label">Harness</label>
                <div className="disp-models" role="group" aria-label="Harness">
                  <button className={`disp-seg ${harness === undefined ? 'on' : ''}`}
                          data-testid="dispatch-harness-default"
                          title={manager
                            ? 'The manager harness — its own persona, skills and manual (the default for a manager)'
                            : "Use this project's default harness"}
                          onClick={() => setHarness(undefined)}>
                    Default
                  </button>
                  {/* A MANAGER is never offered "core only": its manual IS the manager harness (the
                      crew verbs, the read-only-prod and no-push law it must know). Stripping it
                      would cage an agent that does not know what it may do. */}
                  {!manager && (
                    <button className={`disp-seg ${harness === '' ? 'on' : ''}`}
                            data-testid="dispatch-harness-none"
                            title="Core only — the manual + binding rules, no persona/skills layer" onClick={() => setHarness('')}>
                      Core only
                    </button>
                  )}
                  {harnesses.map((h) => (
                    <button key={h.key} className={`disp-seg ${harness === h.key ? 'on' : ''}`}
                            data-testid={`dispatch-harness-${h.key}`}
                            title={h.summary || h.label} onClick={() => setHarness(h.key)}>
                      {h.label}{h.skill_count ? ` ·${h.skill_count}` : ''}
                    </button>
                  ))}
                </div>
              </div>
            )}

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

            {/* Production DB. For a WORKER it is an opt-in toggle; for a MANAGER it is not a
                choice at all — adding one mints a SELECT-only postgres role and binds it, failing
                closed if that cannot be done. So state the fact instead of showing a control that
                would be a lie in either position. */}
            <div className="disp-field">
              <label className="disp-label">Production DB access</label>
              {manager ? (
                <div className="disp-hint" data-testid="manager-proddb-note">
                  <b>READ-ONLY, always.</b> Adding a manager mints it its own postgres role
                  (CONNECT + SELECT, nothing else) on production and binds it — it is not a switch.
                  Every write and every DDL is refused by the server. Rows that must change in
                  production still go through a landed seed a human approves.
                </div>
              ) : (
                <>
                  <div className="disp-sup" role="group" aria-label="Production database access">
                    <button className={`disp-seg ${!prodDb ? 'on' : ''}`} data-testid="dispatch-proddb-off"
                            title="The xell uses its normal (dev) database — the safe default."
                            onClick={() => setProdDb(false)}>off</button>
                    <button className={`disp-seg disp-seg-danger ${prodDb ? 'on' : ''}`} data-testid="dispatch-proddb-on"
                            title="Point this xell at the LIVE PRODUCTION database — real, irreversible writes. Schema changes are hard-blocked."
                            onClick={() => setProdDb(true)}>⚠ LIVE PROD</button>
                  </div>
                  <div className="disp-hint">For manual data processing on prod. Read + write only — schema changes (DDL) are hard-blocked.</div>
                </>
              )}
            </div>
          </div>

          {!manager && prodDb && (
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
          {manager && empty && (
            <span className="disp-hint" data-testid="manager-blank-hint">
              No programme? It will study the project, propose one, and ask you before starting a crew.
            </span>
          )}
          <button className="disp-cancel" onClick={onClose}>Cancel</button>
          <button className="disp-submit" onClick={submit}
                  data-testid={manager ? 'manager-submit' : 'dispatch-submit'}>
            {manager ? 'Add manager zee →' : 'Dispatch →'}
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
// Provider-aware: claude's aliases are safe to guess offline; another vendor's model ids are
// not, so its fallback is the single honest "vendor default" entry (key '' → dispatch sends no
// model and the vendor CLI runs its own default).
const fallbackModels = (provider) => provider === 'claude' || !provider
  ? [{ key: 'opus', label: 'Opus', default: true }, { key: 'sonnet', label: 'Sonnet' }, { key: 'haiku', label: 'Haiku' }]
  : [{ key: '', label: 'default', note: "the vendor CLI's own default model", default: true }];
