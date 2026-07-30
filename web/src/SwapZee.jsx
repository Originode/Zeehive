// SWAP THE ZEE WORKING A XELL — the console half of `zee swap`.
//
// A manager zee can already play a Scout, then a Builder, then a Reviewer over ONE piece of work
// (`zee swap`). This is the same act from the honeycomb: a human picks a xell, picks a persona, and
// the xell comes back with a NEW zee on the same row — same branch, same commits, same containers,
// same database, same work-item card. Only WHO is in it changes.
//
// WHY IT IS NOT "switch harness" (assignXellHarness, the chip on the card): that edits the row a
// cage was built FROM, so the agent already running keeps the manual it started with until something
// re-cages it. A swap re-cages deliberately — and the recreate is why the server COLLECTS the
// outgoing zee's commits onto the worktree first, and refuses the whole swap if it cannot.
//
// This composer only COLLECTS THE CHOICE. Every refusal (an open landing/ship/done card on that
// xell, a persona of the wrong zee_type, a retired xell, a collect that failed on a running cage)
// belongs to the server, and its sentence is what the human is shown — see App's swap toast. A
// second copy of those rules in here would be a second thing to keep true.
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { getDispatchModes, getDispatchModels, getHarnesses, getProviderTokens } from './api.js';
import { emptyWarning } from './harnessHealth.js';

export default function SwapZee({ xell, projectId, diff = null, onClose, onSwap }) {
  const editorRef = useRef(null);
  const [harnesses, setHarnesses] = useState([]);
  const [harness, setHarness] = useState(null);        // null = nothing picked yet (required)
  const [modes, setModes] = useState([]);
  const [models, setModels] = useState([]);
  const [mode, setMode] = useState(5);                 // 5 = bypass, the fleet's unattended default
  const [model, setModel] = useState('opus');          // replaced by the server's default once loaded
  const [err, setErr] = useState(null);

  // ── provider accounts (providers) and the currently selected account ────────
  // A project can hold several accounts of one provider type (e.g. two Claude subs).
  // The user picks one; the model list then shows that provider's models.
  const [providers, setProviders] = useState([]);       // the provider read-model from the server
  // accounts = flattened [{ id, provider, name, typeLabel }] — one entry per account row
  const [accounts, setAccounts] = useState([]);
  const [acct, setAcct] = useState(null);               // the currently selected account

  // A xell may only wear a harness of its OWN type (054's DB guard), and a swap never changes a
  // xell's type — so the picker asks for exactly the personas this xell may wear: manager personas
  // for a manager xell, worker ones for a worker. Anything else the server refuses by name.
  const zeeType = xell?.zee_type === 'manager' ? 'manager' : 'worker';

  useEffect(() => {
    getHarnesses(zeeType, projectId)
      .then((hs) => setHarnesses((hs || []).filter((h) => !h.is_law_core))).catch(() => {});
    getDispatchModes().then(setModes).catch(() => {});
    // Load the provider-token read model for this project so the user can pick
    // which AI account the incoming zee runs on.
    if (projectId) {
      getProviderTokens(projectId).then((ps) => {
        const list = Array.isArray(ps) ? ps : [];
        setProviders(list);
        const flat = list
          .filter((p) => p.provider !== 'github' && p.dispatch)
          .flatMap((p) => (p.accounts || []).map((a) => ({
            id: a.id,
            provider: p.provider,
            name: a.label || (p.accounts.length > 1 ? `${p.label} ·${(a.token_hint || '').slice(-4)}` : p.label),
            typeLabel: p.label,
          })));
        setAccounts(flat);
        // Default: select the first account so the model picker has a provider to
        // query; if there are none, models will be fetched for the default provider.
        if (flat.length) setAcct(flat[0]);
      }).catch(() => {});
    }
    setTimeout(() => editorRef.current?.focus(), 30);
  }, [zeeType, projectId]);

  // When the selected account changes, re-fetch the model list for that provider.
  const activeProvider = acct?.provider || 'claude';
  const activeTokenId = acct ? acct.id : null;
  useEffect(() => {
    getDispatchModels(activeProvider).then((ms) => {
      setModels(ms);
      const def = (ms || []).find((m) => m.default) || (ms || [])[0];
      if (def) setModel(def.key);
    }).catch(() => {});
  }, [activeProvider]);

  // Esc closes only while nothing has been composed, exactly as the dispatch composer does — a
  // half-written brief is real work.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape' && !(editorRef.current?.innerText || '').trim()) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const current = xell?.harness_label || xell?.harness_key || 'core only';
  const working = ['working', 'online', 'spawning', 'idle'].includes(xell?.zee_status);
  const dirty = diff?.dirty || 0;

  const submit = () => {
    if (!harness) { setErr('Pick the persona the INCOMING zee wears — that is the whole point of a swap.'); return; }
    const task = (editorRef.current?.innerText || '').trim();
    // Fire-and-forget, like the dispatch composer: re-caging a zee is slow (collect → recreate →
    // spawn), and the parent reports it through a toast that carries the server's own sentence.
    onSwap?.({
      harness,
      ...(task ? { task } : {}),
      model,
      mode,
      provider: activeProvider,
      provider_token_id: activeTokenId,
    });
  };

  return createPortal((
    <div className="disp-overlay">
      <div className="disp disp-swap" role="dialog" aria-label="Swap the zee working this xell"
           data-testid="swap-modal">
        <div className="disp-head">
          <span className="disp-title">♻ swap the zee · <code>{xell?.slug}</code>
            <span className="disp-sub"> → same xell, new zee: same branch, commits, containers, database and card</span>
          </span>
          <button className="disp-x" onClick={onClose} title="Close">✕</button>
        </div>

        <div className="disp-body">
          <p className="disp-note" data-testid="swap-what">
            The zee in <b>{xell?.slug}</b> is <b>stopped</b> and a new one is caged in its place wearing the
            persona you pick. The xell is otherwise untouched: <b>{xell?.branch}</b>, its commits, its containers,
            its database and its work-item card all stay. Its commits are <b>collected onto the worktree
            first</b> — if that cannot be done the server refuses the whole swap rather than recreate the cage
            over them. The incoming zee is briefed that it <b>inherited</b> this xell: what the previous zee
            was asked to do, what it last reported, and what is on the branch.
          </p>

          <div className="disp-field">
            <label className="disp-label">Now in this xell</label>
            <div className="swap-now" data-testid="swap-current">
              <span>persona <b>{current}</b></span>
              <span>zee <b>{xell?.zee_status || '—'}</b>{xell?.zee_name ? ` · ${xell.zee_name}` : ''}</span>
              <span>{zeeType} xell</span>
            </div>
          </div>

          <div className="disp-field">
            <label className="disp-label">Incoming persona {harness ? '' : '· required'}</label>
            <div className="disp-models" role="group" aria-label="Incoming harness">
              {harnesses.map((h) => {
                const warn = emptyWarning(h);
                const isCurrent = h.key === xell?.harness_key;
                return (
                  <button key={h.key} className={`disp-seg ${harness === h.key ? 'on' : ''} ${warn ? 'seg-hollow' : ''}`}
                          data-testid={`swap-harness-${h.key}`}
                          title={`${warn ? `${warn.chip.replace('⚠ ', '')} — ${warn.why}` : (h.summary || h.label)}`
                            + (h.scope === 'project' ? '  (⌂ this project\'s own persona)' : '  (system-wide)')
                            + (isCurrent ? '\n\nThis is the persona already worn — swapping to it re-cages the'
                                + ' xell with a fresh zee and a fresh handover brief.' : '')}
                          onClick={() => { setHarness(h.key); setErr(null); }}>
                    {h.label}{h.scope === 'project' ? ' ⌂' : ''}{isCurrent ? ' ·current' : ''}
                    {warn ? ` ${warn.chip}` : (h.skill_count ? ` ·${h.skill_count}` : '')}
                  </button>
                );
              })}
            </div>
            {!harnesses.length && (
              <div className="disp-hint" data-testid="swap-no-harnesses">
                No {zeeType} persona is available to this project — mint one in the harness manager first.
              </div>
            )}
          </div>

          <div className="disp-field">
            <label className="disp-label">What the incoming zee should do (optional)</label>
            <div className="disp-editor-wrap">
              <div className="disp-editor" ref={editorRef} contentEditable suppressContentEditableWarning
                   data-testid="swap-task" role="textbox" aria-multiline="true"
                   onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); submit(); } }} />
            </div>
            <div className="disp-hint">
              Leave it blank and the incoming zee is told to continue this xell's work in the role its
              harness describes. Either way the handover text goes with it.
            </div>
          </div>

          <div className="disp-controls">
            {/* ── WHICH AI ACCOUNT runs the incoming zee — only if there are multiple accounts ── */}
            {accounts.length > 1 && (
              <div className="disp-field">
                <label className="disp-label">AI provider account</label>
                <div className="disp-models" role="group" aria-label="AI provider account">
                  {accounts.map((a) => (
                    <button key={a.id} className={`disp-seg ${acct?.id === a.id ? 'on' : ''}`}
                            data-testid={`swap-account-${a.id}`}
                            title={`Run the incoming zee on ${a.name} (${a.typeLabel})`}
                            onClick={() => setAcct(a)}>
                      {a.name}
                    </button>
                  ))}
                </div>
                <div className="disp-hint">Each account runs its vendor's own CLI inside the cxell (claude / codex / kimi)</div>
              </div>
            )}

            {/* Only show the account label inside the picker when there's exactly one */}
            {accounts.length === 1 && (
              <div className="disp-field">
                <label className="disp-label">Provider</label>
                <div className="swap-now">
                  <span>{accounts[0].name} ({accounts[0].typeLabel})</span>
                </div>
              </div>
            )}

            {accounts.length === 0 && (
              <div className="disp-field">
                <label className="disp-label">Provider</label>
                <div className="disp-hint" data-testid="swap-no-accounts">
                  No AI provider is connected to this project — add one in Project setup to dispatch a zee.
                </div>
              </div>
            )}

            <div className="disp-field">
              <label className="disp-label">Autonomy mode</label>
              <div className="disp-modes" role="group" aria-label="Autonomy mode">
                {modes.map((m) => (
                  <button key={m.mode} className={`disp-seg ${mode === m.mode ? 'on' : ''}`}
                          data-testid={`swap-mode-${m.mode}`} title={m.label} onClick={() => setMode(m.mode)}>
                    <b>{m.mode}</b> {m.key}
                  </button>
                ))}
              </div>
              <div className="disp-hint">{modes.find((m) => m.mode === mode)?.label || ''}</div>
            </div>
            <div className="disp-field">
              <label className="disp-label">Model · {activeProvider}</label>
              <div className="disp-models" role="group" aria-label="Model">
                {models.map((m) => (
                  <button key={m.key} className={`disp-seg ${model === m.key ? 'on' : ''}`}
                          data-testid={`swap-model-${m.key}`} title={m.note || m.label}
                          onClick={() => setModel(m.key)}>
                    {m.label}{m.default ? ' ·default' : ''}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Handover guidance — messages are the way to pass context between zees
              without polluting the branch with tracked handover files. */}
          <div className="disp-field">
            <label className="disp-label">Handing work over</label>
            <div className="disp-hint" data-testid="swap-handover-hint">
              The swap brief already tells the incoming zee what the previous one was asked to do and
              what it last reported. If the outgoing zee has <b>detailed context</b> that should not go
              into a tracked file on the branch, send it as a <b>message</b>: open the xell's
              <b> message composer</b> (the 💬 button on the flower) or use
              <code> zee say --to {xell?.slug || '&lt;slug&gt;'} --message "…"</code> from another
              zee. Messages land as real files in the recipient's <code>.zee-inbox</code> — they are
              never committed to the branch, and they survive a swap because the inbox lives inside the
              cage and the swap brief carries the previous zee's report.
            </div>
          </div>

          {/* The two things a human should know BEFORE clicking, because neither is recoverable by
              re-swapping: a zee mid-turn loses that turn, and work the caged zee never COMMITTED is
              not what the collect saves — the collect bundles commits. */}
          {(working || dirty > 0) && (
            <div className="disp-warn" data-testid="swap-warning" role="alert">
              <div className="disp-warn-title">⚠ read this first</div>
              <div className="disp-warn-body">
                {working && (
                  <>The zee in there is <b>{xell.zee_status}</b> — swapping <b>ends its turn</b>; anything it was
                  about to say or commit is lost. If it is mid-task, message it instead.<br /></>
                )}
                {dirty > 0 && (
                  <><b>{dirty} uncommitted path(s)</b> on this xell. The swap collects <b>commits</b>; work that was
                  never committed is not a commit, and the cage is recreated. Ask the zee to commit first if it
                  matters.</>
                )}
              </div>
            </div>
          )}

          {err && <div className="disp-err" data-testid="swap-error">{err}</div>}
        </div>

        <div className="disp-foot">
          <span className="disp-hint">
            No gate is opened: what comes out is an ordinary caged zee, and its landing and its ship still
            need you. A swap is refused while a landing, ship or done card on this xell is undecided.
          </span>
          <button className="disp-cancel" onClick={onClose}>Cancel</button>
          <button className="disp-submit" data-testid="swap-submit" disabled={!harness} onClick={submit}>
            Swap the zee →
          </button>
        </div>
      </div>
    </div>
  ), document.body);
}
