import React, { useEffect, useMemo, useRef, useState } from 'react';
import { dispatchOverlap } from './api.js';
import { createPortal } from 'react-dom';
import { getDispatchOptions, getHarnesses, getRouterStatus } from './api.js';
import { emptyWarning } from './harnessHealth.js';
import ZeeAvatar from './ZeeAvatar.jsx';
import { providerWide, modelWide, formatLimitChip } from './usageLimits.js';

// MODEL-WIDE only — empty when no model-specific pool is known (do not fall back to provider-wide
// on the model button; that number lives on the provider button).
function modelLimitLabel(provider, modelKey, modelRow, account) {
  if (account?.usage_limit) {
    const lim = modelWide(account.usage_limit, { provider, model: modelKey });
    if (lim.available_pct != null) return formatLimitChip(lim);
  }
  // Server already attaches model-wide only (null when unknown).
  if (modelRow?.available_pct != null && modelRow.limit_source === 'model') {
    return formatLimitChip({
      available_pct: modelRow.available_pct,
      window: modelRow.limit_window,
      source: 'model',
    });
  }
  if (modelRow?.available_pct != null && modelRow.limit_source == null && modelRow.limit_window) {
    // older shape: treat non-null as model when window is a model tier
    return formatLimitChip({
      available_pct: modelRow.available_pct,
      window: modelRow.limit_window,
      source: 'model',
    });
  }
  return '';
}

// PROVIDER-WIDE chip for a provider button.
function providerLimitLabel(providerRow, account) {
  if (account?.usage_limit) {
    return formatLimitChip(providerWide(account.usage_limit));
  }
  if (providerRow?.available_pct != null) {
    return formatLimitChip({ available_pct: providerRow.available_pct, source: 'provider' });
  }
  return '';
}

// Same ceiling as the 📨 MessageComposer: pasted files ride the dispatch JSON body as base64 data
// URLs, and base64 inflates ~33% — so keep the total file payload well under the server's 30mb
// json limit (server/src/index.js) and the webapp nginx's client_max_body_size (nginx-web.conf).
const MAX_BYTES = 20 * 1024 * 1024;

// The "+" composer. A human writes a prompt (rich text, paste-friendly, attachments welcome) and
// picks the autonomy mode / model / attended flag — then SUBMIT dispatches it exactly like a /xell
// dispatch: the queenzee claims a ready xell for this project and spawns a zee into its worktree
// with the task text (+ any pasted files). This is not a parallel one-off mechanism; it POSTs the
// same /api/xell/dispatch the CLI dispatch does, so the new xell shows up like any other.
//
// The overlay deliberately does NOT close on an outside click — a half-written prompt is real work,
// and losing it to a stray click is worse than one extra button press. Close is ✕ / Cancel only.
//
// SUBMIT IS FIRE-AND-FORGET: dispatching a zee is slow (it uploads any pasted screenshot, renames
// the worktree, then spawns and AWAITS the real zee start), and an attached file made the old
// blocking "Dispatching…" button freeze the modal for seconds. So submit now just validates, hands
// the whole payload up to the parent and closes at once — the parent runs the dispatch and reports
// progress through a toast (including a Retry that reuses this exact payload if it fails).
//
// ── ONE "+ prompt" BUTTON, PERSONA CHOSEN HERE (OR BY THE ROUTER) ───────────────────────────────
// The console used to show one prompt button per PERSONA (and before that, one per AI ACCOUNT).
// The router layer recomposes the prompt and decides provider/model/mode/harness itself, so a
// toolbar pin was only a hint — App.jsx now opens this composer with no harness pinned. Where the
// persona is chosen depends on the three router states below:
//   • router feature exists and a router is live → the router picks (Custom deployment can pin)
//   • router feature exists but no live router → deploy first; dispatch is disabled
//   • no router feature (or status call failed) → DIRECT dispatch, and the persona is chosen HERE
//     (worker harnesses + "core only"), the same way a manager has always picked its own.
//
// Everything under the chosen persona is derived in one call — GET /api/dispatch/options (server
// lib/dispatch-options.js):
//   • PROVIDERS — only those the harness's EFFECTIVE model policy allows AND the project has an
//     account for. A provider the policy forbids is shown, disabled, with the reason, so a human
//     learns the persona's rule instead of wondering where their account went.
//   • MODELS — the policy's allowed set FOR THE SELECTED PROVIDER, in deployment-priority order,
//     with the model a bare dispatch would actually land on marked ·default.
//   • AUTONOMY — the same 1–5 scale, annotated FOR THAT PROVIDER'S RUNTIME: inside a cxell the
//     scale is not enforced (spawnCxell always runs bypass and only logs what was asked), so those
//     segments say so instead of promising a read-only recon that is nothing of the sort.
//
// ── TWO ZEE TYPES (`manager`) ──────────────────────────────────────────────────────────────────
// Adding a MANAGER used to be a one-line showPrompt() box: a single `<input>` for what is the most
// consequential prompt in the fleet — the programme an agent runs a whole CREW from. So the manager
// now opens THIS modal with `manager` set, and the differences are only the ones that are actually
// true of a manager:
//   • it is ONE button for the fleet, so the persona is chosen HERE (manager harnesses only — a
//     worker harness on a manager is refused by the DB anyway), and the options above re-resolve
//     when it changes;
//   • there is NO prod-DB toggle — a manager is always bound to production READ-ONLY, and that is
//     not a switch a human flips here (stated as a note instead of a control that lies);
//   • the brief MAY be left blank — the server then hands it DEFAULT_MANAGER_BRIEF (study the
//     project, propose a plan, ask before starting a crew), which is a real answer, not an empty one.
// Everything else — the editor, attachments, model, mode, supervision, account — is shared, because
// a manager's prompt deserves at least what a worker's gets.
export default function Dispatch({ projectId, projectName,
                                   // WHICH PERSONA this composer is for. Three-state, and the same
                                   // three states the dispatch payload carries: undefined = the
                                   // project/type default, '' = core only (no harness), a key = that
                                   // harness. The single "+ prompt" button opens with no pin
                                   // (undefined); a manager — and a worker on a no-router fleet —
                                   // pick it below. A caller may still pass a pin.
                                   harness: harnessProp = undefined,
                                   manager = false, onClose, onDispatch }) {
  const editorRef = useRef(null);
  // Persona state: mirrors an optional pin from the opener, then the human may change it in here
  // (manager always; worker when the router gate is off).
  const [harness, setHarness] = useState(harnessProp);
  useEffect(() => { setHarness(harnessProp); }, [harnessProp]);
  const [harnesses, setHarnesses] = useState([]);   // personas for the in-composer picker (type-scoped)

  // WHAT THIS PERSONA MAY DISPATCH — providers, accounts, models, the autonomy scale's real meaning
  // per provider, and the model a bare dispatch would land on. One call, re-run when the persona
  // changes, because every one of those answers is a function of the policy it wears.
  const [opts, setOpts] = useState(null);
  const [optsErr, setOptsErr] = useState(null);

  const [prov, setProv] = useState(null);         // the provider TYPE this zee runs on
  const [acctId, setAcctId] = useState(null);     // which exact ACCOUNT of that type
  const [mode, setMode] = useState(5);            // default 5 = bypass (fully unattended)
  const [model, setModel] = useState('');         // set from the policy's default once loaded
  const [headless, setHeadless] = useState(true); // default headless (fire-and-forget)
  const [prodDb, setProdDb] = useState(false);    // OFF by default — LIVE production data, opt-in only
  const [visualVerify, setVisualVerify] = useState(false); // OFF by default — per-xell VISUAL VERIFICATION (build the webapp, offer the link to a human)
  const [attachments, setAttachments] = useState([]);   // [{ id, name, type, data(dataURL), size }]
  const [err, setErr] = useState(null);
  const [empty, setEmpty] = useState(true);       // drives the placeholder + submit-disabled state
  // ONE SUBMIT PER DOOR (150). submit() is fire-and-forget — it hands the payload up and the
  // parent closes the modal and dispatches asynchronously — so nothing in the modal itself blocks a
  // second call. A double-click on the submit button, or Cmd+Enter landing in the same tick as a
  // click, fired `onDispatch` TWICE for ONE action; the parent then POSTed the same routing request
  // (or the same deploy) twice. `makeDoor` wraps each fire path in a one-shot guard set only when a
  // payload actually goes out — a validation failure (setErr, "write a prompt first") does NOT burn
  // the door, so fixing the error and trying again still works. The guard is per DOOR (Instant and
  // Route are separate doors): the double-click that produced the double-deploy was on ONE button,
  // and clicking two different doors in one session is two deliberate actions, not a double-submit.
  // (The server ALSO refuses a duplicated routing request by client_request_id — this guard is the
  // cheap first line, not the only one.)
  const makeDoor = () => {
    let fired = false;
    return (payload) => {
      if (fired) return;
      fired = true;
      onDispatch?.(payload);
    };
  };
  const instantDispatchOnce = makeDoor();
  const submitDispatchOnce = makeDoor();
  // One stable per-composition request id, minted when the modal opens and reused for every submit
  // of this composition — so a double-submit carries the SAME id and the server's dedup ledger can
  // see it as the duplicate it is.
  const [clientRequestId] = useState(() =>
    (typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`));
  // WHO ELSE IS IN THIS WORK (#33). Debounced while the prompt is written, so the warning is on screen
  // at the moment of the decision instead of in the receipt afterwards. Purely informational: it never
  // disables the button and a failed check simply says nothing — two zees on one file is ordinary work,
  // and the failure this closes was not KNOWING.
  const [overlap, setOverlap] = useState(null);

  // ── THE ROUTER GATE (139) ─────────────────────────────────────────────────────────────────────
  // A WORKER prompt is not dispatched directly any more: it is handed RAW to the project's ROUTER
  // zee, which recomposes it and decides provider/model/mode/harness under the router policy. So
  // the composer asks one question up front — is there a live router? — and the answer decides the
  // footer: present → "Route via router"; absent → Dispatch DISABLED and the one honest button is
  // "Deploy router" (which flips this modal into a no-text deploy: provider + model only, because a
  // router's brief is fixed — DEFAULT_ROUTER_BRIEF — and a human only picks what it THINKS with).
  //
  // The gate applies only where the router feature exists: on a fleet whose meta-DB has no `router`
  // harness yet (routerSt.harness == null), or where the status call itself fails, the composer
  // dispatches directly exactly as before — a gate that bricked every project the day it shipped
  // would be worse than no gate.
  //
  // THREE STATES, NOT ONE. `routerSt === null` used to mean "still loading", "the call failed" and
  // "this fleet has no router feature" at once, and all three read as NO GATE: a project whose
  // status errored dispatched directly with no banner at all (silently — the very failure the gate
  // exists to prevent), and a prompt submitted while the call was in flight bypassed a router that
  // was live. So the failure is now SAID (routerErr) and the in-flight moment DECIDES NOTHING
  // (routerLoading blocks the submit until the answer is in).
  const [routerSt, setRouterSt] = useState(null);       // GET /api/router/status read model
  const [routerErr, setRouterErr] = useState(null);     // the status call failed — say so, don't pretend
  const [routerLoading, setRouterLoading] = useState(!manager);
  const [routerMode, setRouterMode] = useState(null);   // null | 'deploy' | 'redeploy'
  useEffect(() => {
    if (manager) return;
    let live = true;
    // The answer is about ONE project: drop the previous project's status before asking, or the
    // banner keeps naming the last project's router while the new project's call is in flight.
    setRouterSt(null); setRouterErr(null); setRouterLoading(true);
    getRouterStatus(projectId)
      .then((s) => { if (live) { setRouterSt(s); setRouterLoading(false); } })
      .catch((e) => { if (live) { setRouterSt(null); setRouterErr(e?.message || String(e)); setRouterLoading(false); } });
    return () => { live = false; };
  }, [projectId, manager]);
  const routerGate = !manager && !!routerSt?.harness;   // the feature exists on this fleet
  const liveRouter = routerGate && routerSt.present ? routerSt.routers[0] : null;
  // Worker persona picker: only on the DIRECT path (no router feature / status failed). While the
  // status call is in flight we decide nothing — a flash of the picker then a router banner would
  // be worse than waiting. Managers have their own picker below.
  const workerPersonaPicker = !manager && !routerMode && !routerLoading && !routerGate;

  // ── CUSTOM DEPLOYMENT (139 + Instant deploy) ──────────────────────────────────────────────────
  // With a live router the dispatch knobs are the ROUTER's call — that is the point of the gate,
  // and it stays the default. But sometimes a human KNOWS: run this one on opus, in plan mode,
  // wearing the reviewer persona. So the same provider/model/mode/harness pickers a DIRECT dispatch
  // offers are available here too, COLLAPSED (the router deciding is still the norm) and gated on a
  // router being present — with none, this panel does not exist and nothing about direct dispatch
  // changes.
  //
  // What is pinned travels as the human's explicit DECISION. TWO doors then open:
  //   • Route via router — pins ride on the routing request (server routeRawPrompt renders a CUSTOM
  //     DEPLOYMENT block the router obeys). Partial pins are legal; the router decides the rest.
  //   • Instant deploy  — same pins, but POST /api/xell/dispatch DIRECTLY. Skips the router ZEE
  //     (no recompose, no router decision). Does NOT skip server-side validation or the harness
  //     provider-lanes (migration 148) — dispatch still enforces those. Unpinned fields fall back
  //     to the same defaults a bare direct dispatch would open on (policy default provider/model,
  //     mode 5, the button's persona). The button appears once something is pinned OR the human
  //     opts into LIVE PROD (Production DB access) — that flag is a HUMAN decision a manager
  //     (the router included) is structurally refused from handing a worker, so Instant is the
  //     only door that can apply it.
  //
  // Every field starts UNSET and can be put back to "router decides". Only what was set is sent on
  // the via-router path; Instant deploy fills the rest from the options under the pinned persona.
  const [customOpen, setCustomOpen] = useState(false);
  const [cProv, setCProv] = useState(null);
  const [cModel, setCModel] = useState(null);
  const [cMode, setCMode] = useState(null);
  const [cHarness, setCHarness] = useState(null);
  // Account pin is Instant-only (direct dispatch carries provider_token_id). Route via router has
  // no account field on the custom block — the router picks the credential. null = first unpaused
  // of the resolved provider (the silent fill Instant has always done).
  const [cAcctId, setCAcctId] = useState(null);
  const [cOpts, setCOpts] = useState(null);          // options under the PINNED persona (null = use the button's)
  const [workerHarnesses, setWorkerHarnesses] = useState([]);
  // Pinning a persona re-reads what it may run on, exactly as the composer re-reads its options when
  // a manager changes its own — a picker that offered what the pinned policy forbids would put the
  // refusal after the prompt was written, which is the bug dispatch-options.js exists to prevent.
  useEffect(() => {
    if (!customOpen || !liveRouter || cHarness == null) { setCOpts(null); return; }
    let live = true;
    getDispatchOptions({ project: projectId, harness: cHarness, zeeType: 'worker' })
      .then((o) => { if (live) setCOpts(o); })
      .catch(() => { if (live) setCOpts(null); });
    return () => { live = false; };
  }, [customOpen, cHarness, projectId, liveRouter]);
  // The personas a WORKER may wear on this project — the same list (and the same core-only
  // exclusion) App.jsx builds the prompt buttons from.
  useEffect(() => {
    if (!customOpen || !liveRouter) return;
    getHarnesses('worker', projectId)
      .then((hs) => setWorkerHarnesses((Array.isArray(hs) ? hs : []).filter((h) => !h.is_law_core)))
      .catch(() => setWorkerHarnesses([]));
  }, [customOpen, liveRouter, projectId]);
  // A provider switch (or the resolved default changing under a persona pin) drops an account that
  // no longer belongs — same reason the direct panel resets acctId on provider change.
  useEffect(() => { setCAcctId(null); }, [cProv]);
  // ── the read model behind every picker below ──────────────────────────────────────────────────
  useEffect(() => {
    let live = true;
    setOpts(null); setOptsErr(null);
    // In router-deploy mode the options are the ROUTER's, not the button's persona: the deployed
    // zee is a manager-type xell wearing `router`, so the providers/models a human may pick here
    // are what THAT harness's effective policy allows.
    getDispatchOptions(routerMode
      ? { project: projectId, harness: 'router', zeeType: 'manager' }
      : { project: projectId, harness, zeeType: manager ? 'manager' : 'worker' })
      .then((o) => {
        if (!live) return;
        setOpts(o);
        // Open on the provider a BARE dispatch would have chosen (the server ran the same decision),
        // and on the model that provider's policy resolves to — so the composer's initial state is
        // what pressing Dispatch immediately would actually do.
        const pick = o.providers.find((p) => p.provider === o.default_provider)
          || o.providers.find((p) => !p.blocked_reason) || o.providers[0] || null;
        setProv(pick?.provider || null);
      })
      .catch((e) => { if (live) { setOpts(null); setOptsErr(e?.message || String(e)); } });
    return () => { live = false; };
  }, [projectId, manager, harness, routerMode]);

  // PERSONAS FOR THE IN-COMPOSER PICKER. Managers always pick here; workers pick here when the
  // router gate is OFF (on a router fleet the router decides, optionally overridden in Custom
  // deployment which has its own list). Type-scoped (054 refuses a mismatch) and project-scoped
  // (084: system-wide + this project's own, never another project's).
  useEffect(() => {
    getHarnesses(manager ? 'manager' : 'worker', projectId)
      .then((hs) => setHarnesses((Array.isArray(hs) ? hs : []).filter((h) => !h.is_law_core)))
      .catch(() => setHarnesses([]));
  }, [manager, projectId]);

  // focus the editor on open so the human can just start typing
  useEffect(() => { const t = setTimeout(() => editorRef.current?.focus(), 30); return () => clearTimeout(t); }, []);

  // THE SELECTED PROVIDER decides the model list, the account list and what the autonomy scale
  // means — so everything below reads off this one row.
  const providerRows = opts?.providers || [];
  const active = providerRows.find((p) => p.provider === prov) || null;
  const activeProvider = prov || null;
  const models = active?.models?.length ? active.models : fallbackModels(activeProvider);
  const modes = active?.modes?.length ? active.modes : (opts?.modes?.length ? opts.modes : FALLBACK_MODES);
  const accounts = (active?.accounts || []).filter((a) => !a.paused);
  const acct = accounts.find((a) => a.id === acctId) || accounts[0] || null;
  const activeTokenId = acct ? acct.id : null;
  const chosenMode = modes.find((m) => m.mode === mode) || null;

  // THE CUSTOM DEPLOYMENT PANEL reads the SAME answer these pickers do — under the PINNED persona
  // when the panel names one, otherwise the button's. Nothing here is preselected: an unset field
  // means "the router decides", which is what the gate does by default.
  const cOptions = cOpts || opts;
  const cProviderRows = cOptions?.providers || [];
  const cActive = cProviderRows.find((p) => p.provider === cProv) || null;
  // A provider whose registry has no rows offers one entry with an EMPTY key — "the vendor CLI's
  // own default", i.e. send no model at all. That is already what "router decides" means here, and
  // a segment that lights up while nothing travels would be a lie, so it is not offered twice.
  const cModels = (cActive?.models || []).filter((m) => m.key);
  const cModes = cActive?.modes?.length ? cActive.modes : (cOptions?.modes?.length ? cOptions.modes : FALLBACK_MODES);
  const custom = {
    ...(cProv ? { provider: cProv } : {}),
    ...(cModel ? { model: cModel } : {}),
    ...(cMode != null ? { mode: cMode } : {}),
    ...(cHarness ? { harness: cHarness } : {}),
  };
  const customCount = Object.keys(custom).length;
  // Account picker keys off the RESOLVED provider (pinned, else the options default) — Instant
  // fills account from that row, so the picker must name the same accounts Instant would use.
  // Hidden when there is no real choice (0 or 1 unpaused account).
  const cResolvedProv = cProv || cOptions?.default_provider || null;
  const cResolvedRow = cProviderRows.find((p) => p.provider === cResolvedProv) || null;
  const cAccounts = (cResolvedRow?.accounts || []).filter((a) => !a.paused);
  // What Instant will send RIGHT NOW — shared with the fire path so the preview cannot lie.
  // LIVE PROD alone is enough to open the door: it is a human decision Instant must carry, and
  // Route via router cannot (selfDispatch refuses any db choice from a manager/router).
  const wantsInstant = !!(routerGate && liveRouter && (customCount > 0 || prodDb));
  const instantResolved = wantsInstant
    ? resolveInstantDeployment({
        cProv, cModel, cMode, cHarness, cAcctId, harness, options: cOptions,
      })
    : null;
  // A PROVIDER switch re-decides the model — each vendor's CLI takes its own ids, so a model can
  // never survive one. The same rule the direct panel below applies, for the same reason.
  useEffect(() => { setCModel(null); }, [cProv]);
  // A PERSONA switch re-decides what is PICKABLE, not what was picked: a pin the new policy still
  // allows is kept, and only one it forbids (or one this project cannot run) is dropped. Clearing
  // both outright was worse than it sounds — pick provider, model, mode and THEN a persona, and two
  // of the four silently left the payload, which is exactly the "part of my decision vanished"
  // failure this panel exists to avoid.
  useEffect(() => {
    if (!cOptions) return;
    const row = cOptions.providers.find((p) => p.provider === cProv);
    if (cProv && (!row || row.blocked_reason)) { setCProv(null); setCModel(null); return; }
    if (cModel && row && !row.models.some((m) => m.key === cModel)) setCModel(null);
    // Drop an account pin that the (possibly new) resolved provider no longer holds.
    if (cAcctId) {
      const rProv = cProv || cOptions.default_provider || null;
      const rRow = cOptions.providers.find((p) => p.provider === rProv);
      const ok = (rRow?.accounts || []).some((a) => !a.paused && a.id === cAcctId);
      if (!ok) setCAcctId(null);
    }
  }, [cOptions]);   // eslint-disable-line react-hooks/exhaustive-deps

  // A provider switch re-decides the model (each vendor's CLI takes its own ids) and the account.
  // Both are functions of the provider, so neither may survive a switch — a Codex dispatch carrying
  // `opus` is refused by the policy, and an account of the wrong type is refused at spawn.
  useEffect(() => {
    if (!active) return;
    setAcctId(active.accounts.find((a) => !a.paused)?.id || null);
    const def = active.default_model != null ? active.default_model
      : (active.models[0]?.key ?? fallbackModels(active.provider)[0]?.key ?? '');
    setModel(def);
  }, [active?.provider, opts]);   // eslint-disable-line react-hooks/exhaustive-deps

  // Esc closes only when nothing is composed — so it can't silently discard a written prompt.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape' && empty && !attachments.length) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [empty, attachments.length, onClose]);

  // Same per-attachment ceiling as the 📨 MessageComposer (MAX_BYTES there): a pasted file is
  // sent as base64 INSIDE the JSON body, so an oversized attachment fails the whole dispatch with an
  // opaque 413. Say so here, before the POST. Base64 inflates ~33%, and the server's json limit is
  // 30mb — 20mb of files stays comfortably under it. The ceiling is enforced in the functional
  // updater (not from the render closure) so two files pasted in the same tick are summed against
  // it correctly — the same shape MessageComposer's addFiles uses.
  const addFile = (att) =>
    setAttachments((prev) => {
      const next = [...prev, { id: `${Date.now()}-${prev.length}`, ...att }];
      const total = next.reduce((n, im) => n + (im.size || 0), 0);
      if (total > MAX_BYTES) {
        setErr(`Attachments exceed 20 MB — remove one before dispatching (${(total / (1024 * 1024)).toFixed(1)} MB).`);
        return prev;
      }
      setErr(null);
      return next;
    });
  const removeFile = (id) => { setErr(null); setAttachments((prev) => prev.filter((im) => im.id !== id)); };

  const syncEmpty = () => {
    setEmpty(!(editorRef.current?.innerText || '').trim());
    scheduleOverlap();
  };
  // One check per pause in typing, and only for a WORKER dispatch: a manager's programme names the whole
  // project by design, so every word of it would "overlap" everything and the signal would be noise.
  const overlapTimer = useRef(null);
  const scheduleOverlap = () => {
    if (manager) return;
    clearTimeout(overlapTimer.current);
    overlapTimer.current = setTimeout(async () => {
      const task = (editorRef.current?.innerText || '').trim();
      if (task.length < 12) { setOverlap(null); return; }
      const o = await dispatchOverlap({ project: projectId, task }).catch(() => null);
      setOverlap(o && o.warnings?.length ? o : null);
    }, 700);
  };
  useEffect(() => () => clearTimeout(overlapTimer.current), []);

  // Paste: capture FILE attachments (a pasted screenshot, a copied log) rather than letting the
  // browser dump a giant base64 blob into the editor; let text/HTML paste through so formatted text
  // lands sensibly. If the clipboard has both a file and text, we keep the text and grab the file.
  const onPaste = (e) => {
    const items = Array.from(e.clipboardData?.items || []);
    const fileItems = items.filter((it) => it.kind === 'file');
    if (!fileItems.length) return; // plain/rich text paste — default behaviour is fine
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain');
    if (text) { document.execCommand('insertText', false, text); syncEmpty(); }
    fileItems.forEach((it, i) => {
      const file = it.getAsFile();
      if (!file) return;
      const ext = (file.type?.split('/')[1] || '').replace(/[^a-z0-9]/gi, '').slice(0, 8);
      const reader = new FileReader();
      reader.onload = () => addFile({
        name: file.name || `pasted-${Date.now()}-${i + 1}${ext ? `.${ext}` : '.bin'}`,
        type: file.type || 'application/octet-stream',
        data: reader.result,
        size: file.size,
      });
      reader.readAsDataURL(file);
    });
  };

  // DIRECT dispatch payload — the same shape POST /api/xell/dispatch has always taken. Used by the
  // no-router path AND by Instant deploy (custom pins, skip the router zee). Validation stays on
  // the server; this only assembles what the pickers already decided.
  const directPayload = (task, {
    provider: p, provider_token_id: tid, mode: m, model: mdl, harness: h,
  }) => ({
    project: projectId,
    ...(task ? { task } : {}),
    provider: p,
    ...(tid ? { provider_token_id: tid } : {}),
    mode: m,
    model: mdl,
    headless,
    // OPT-IN prod DATA access. The value is the full db_coupling ('db-shared-prod'), which the
    // dispatch hands to attachXellDb → the prod db container becomes THIS xell's assigned
    // database. Reads and writes are allowed; the prod guard HARD-BLOCKS schema changes (DDL).
    ...(prodDb ? { db: 'db-shared-prod' } : {}),
    // OPT-IN per-xell VISUAL VERIFICATION: the zee builds the webapp and OFFERS the live link
    // to a human in the console (Open link / dismiss). Per-xell config; nothing irreversible.
    // Always sent (explicit true/false) — unlike prodDb, this is a per-xell boolean a re-dispatch
    // must be able to CLEAR when the human turns the toggle off, not just set when on.
    visual_verify: !!visualVerify,
    // the config layer this zee wears (persona/skills) — chosen in this composer (or left to
    // the project default / the router). undefined → omit (project default); '' → core only
    // (null); a key → that harness.
    ...(h !== undefined ? { harness: h || null } : {}),
    // `images` is the wire field's legacy name — it carries any file attachment now.
    images: attachments.map(({ name, data }) => ({ name, data })),
  });

  // INSTANT DEPLOY — skip the router zee, dispatch with the custom pins now. Unpinned fields use
  // the same defaults a bare direct dispatch opens on (policy default provider/model, mode 5, the
  // button's persona, first unpaused account). Resolution is ONE pure function shared with the
  // footer preview, so what the human sees is exactly what fires. Refuses up front when the
  // resolved provider is blocked, so the refusal is not waiting for the spawn.
  const instantDeploy = () => {
    const task = (editorRef.current?.innerText || '').trim();
    if (!task) { setErr('Write a prompt first (an attachment alone is not enough — the zee needs a task).'); return; }
    const r = resolveInstantDeployment({
      cProv, cModel, cMode, cHarness, cAcctId, harness, options: cOptions,
    });
    if (!r.ok) { setErr(r.error); return; }
    // Hand the whole payload up and let the parent dispatch it asynchronously (progress → toast).
    // No via_router flag → App.jsx takes the POST /api/xell/dispatch path.
    instantDispatchOnce(directPayload(task, {
      provider: r.provider,
      provider_token_id: r.provider_token_id,
      mode: r.mode,
      model: r.model,
      harness: r.harness,
    }));
  };

  const submit = () => {
    // ROUTER DEPLOY / REDEPLOY: no prompt text by design — a router's brief is fixed (the server's
    // DEFAULT_ROUTER_BRIEF); what a human picks here is only the provider and model it thinks with.
    if (routerMode) {
      if (active?.blocked_reason) { setErr(`Cannot deploy on ${active.label}: ${active.blocked_reason}`); return; }
      submitDispatchOnce({
        [routerMode === 'redeploy' ? 'redeploy_router' : 'deploy_router']: true,
        project: projectId,
        provider: activeProvider,
        ...(activeTokenId ? { provider_token_id: activeTokenId } : {}),
        ...(model ? { model } : {}),
        ...(routerMode === 'redeploy' && liveRouter ? { xell_id: liveRouter.xell_id } : {}),
      });
      return;
    }
    const task = (editorRef.current?.innerText || '').trim();
    // A WORKER with no task is nothing to do. A MANAGER with no task is a defined thing: the server
    // hands it DEFAULT_MANAGER_BRIEF (study the project, propose a programme, ask before starting a
    // crew), which is exactly what the old one-line box allowed by leaving it blank. Keep that.
    if (!task && !manager) { setErr('Write a prompt first (an attachment alone is not enough — the zee needs a task).'); return; }
    // ROUTE VIA ROUTER: the prompt goes RAW to the live router, which recomposes it and decides
    // the dispatch — so none of the controls below ride along, only the words and the attachments. The
    // persona the button chose travels as a HINT (the router decides the harness, but the human's
    // click is a signal worth carrying). Cmd/Ctrl+Enter always takes this door when a router is
    // live — Instant deploy is the explicit second button only.
    //
    // LIVE PROD is the one exception that cannot take this door. selfDispatch refuses every db
    // choice from a manager (the router is one), so a routed worker can never be handed production
    // data. Instant deploy (POST /api/xell/dispatch from this human console) is the path that can.
    // Refuse here rather than silently dropping the flag — a toggle that lights up and then does
    // nothing is worse than a button that says why it will not fire.
    if (routerGate && liveRouter) {
      if (prodDb) {
        setErr('LIVE PROD cannot go through the router — a manager may not hand a worker production. Use Instant deploy.');
        return;
      }
      submitDispatchOnce({
        via_router: true,
        project: projectId,
        prompt: task,
        // ONE PER COMPOSITION (150): the same request id rides every submit of this composition, so
        // a double-submit that slips past the in-flight guard is still refused by the server's dedup
        // ledger as the duplicate it is — never enqueued twice, never two workers for one prompt.
        client_request_id: clientRequestId,
        ...(harness !== undefined && harness !== '' ? { harness_hint: harness } : {}),
        // …and the CUSTOM DEPLOYMENT panel, if the human configured one: their explicit DECISION
        // (provider/model/mode/harness), only the fields actually pinned. Omitted entirely when the
        // panel was never touched, so the routing request is exactly what it was before.
        ...(customCount ? { custom } : {}),
        // `images` is the wire field's legacy name — it carries any file attachment now.
        images: attachments.map(({ name, data }) => ({ name, data })),
      });
      return;
    }
    // A provider the persona forbids (or has no usable account) is never dispatched from here: the
    // spawn would refuse it, and the refusal would arrive after the prompt was written.
    if (active?.blocked_reason) { setErr(`Cannot dispatch on ${active.label}: ${active.blocked_reason}`); return; }
    // Hand the whole payload up and let the parent dispatch it asynchronously (progress → toast).
    // The prompt isn't lost on failure: the parent captures this payload in the toast's Retry.
    submitDispatchOnce(directPayload(task, {
      provider: activeProvider,
      provider_token_id: activeTokenId,
      mode,
      model,
      harness,
    }));
  };

  const onKeyDown = (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); submit(); }
  };

  const totalMb = attachments.reduce((n, im) => n + (im.size || 0), 0) / (1024 * 1024);

  // What the persona RESTRICTS, in one line — rendered next to its name so the rule is visible at
  // the moment of the decision rather than in the refusal afterwards.
  const policyLine = useMemo(() => policySummary(opts?.policy), [opts?.policy]);
  const personaLabel = opts?.harness?.label || (harness === '' ? 'core only' : (harness || 'default'));

  // ── PORTALLED TO <body>, ALWAYS ─────────────────────────────────────────────────────────────
  // A z-index only ranks siblings INSIDE the nearest stacking context, so a full-screen overlay
  // rendered where its button happens to live is ranked among that pane's contents and nothing
  // else. The manager composer opens from the toolbar inside `.content` (`position: relative;
  // z-index: 1`), which is a stacking context — so `.disp-overlay { z-index: 60 }` collapsed to
  // "z-index 1, in the panels pane", and the graph divider + its grip (z 4/5/6 on `.hive-split`)
  // and the <Connectors> line overlay (a later sibling at z 1) painted straight over the modal.
  // Raising the number could not have fixed that: 60 was never being compared with 6.
  //
  // So the overlay leaves the tree entirely and mounts on <body>, where its z-index means what it
  // says against the other real overlays (toasts 80 · dialogs 90 · diff viewer 95, all deliberately
  // above it). This is unconditional rather than manager-only: the worker composer only escaped by
  // luck of being rendered high in App's tree, and the next component to open one should not have
  // to know that.
  return createPortal((
    <div className="disp-overlay">
      <div className={`disp${manager ? ' disp-mgr' : ''}`} role="dialog"
           aria-label={manager ? 'Add a manager zee' : 'Compose a prompt'}
           data-testid={manager ? 'manager-modal' : 'dispatch-modal'}>
        <div className="disp-head">
          {manager ? (
            <span className="disp-title">⬢ ＋ manager zee <span className="disp-sub">→ runs a CREW: dispatches workers, reads production (read-only), pushes nothing{projectName ? ` · ${projectName}` : ''}</span></span>
          ) : routerMode ? (
            <span className="disp-title">⇄ {routerMode === 'redeploy' ? 'Redeploy' : 'Deploy'} router <span className="disp-sub">→ the project's front door: accepts raw prompts, recomposes them and decides every dispatch{projectName ? ` · ${projectName}` : ''}</span></span>
          ) : routerGate && liveRouter ? (
            <span className="disp-title">＋ New prompt <span className="disp-sub">→ handed raw to the router, which recomposes it and decides the dispatch{projectName ? ` · ${projectName}` : ''}</span></span>
          ) : (
            <span className="disp-title">＋ New prompt{personaLabel && personaLabel !== 'default' ? ` · ${personaLabel}` : ''} <span className="disp-sub">→ dispatches a zee into a ready xell{projectName ? ` · ${projectName}` : ''}</span></span>
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

          {/* THE PERSONA — on the direct (no-router) path a WORKER picks it here, including
              "core only". On a router-gated fleet the router picks (see Custom deployment); the
              banner below says so. Managers have their own picker in the controls section. */}
          {workerPersonaPicker && (
            <div className="disp-field" data-testid="dispatch-persona">
              <label className="disp-label">Persona</label>
              <div className="disp-models" role="group" aria-label="Harness">
                <button className={`disp-seg ${harness === undefined ? 'on' : ''}`}
                        data-testid="dispatch-harness-default"
                        title="The project's default worker persona — what a bare dispatch attaches"
                        onClick={() => setHarness(undefined)}>
                  Default
                </button>
                {harnesses.map((h) => {
                  const warn = emptyWarning(h);
                  return (
                    <button key={h.key} className={`disp-seg ${harness === h.key ? 'on' : ''} ${warn ? 'seg-hollow' : ''}`}
                            data-testid={`dispatch-harness-${h.key}`}
                            title={`${warn ? `${warn.chip.replace('⚠ ', '')} — ${warn.why}` : (h.summary || h.label)}`
                              + (h.scope === 'project' ? `  (⌂ this project's own persona)` : '  (system-wide)')}
                            onClick={() => setHarness(h.key)}>
                      {h.label}{h.scope === 'project' ? ' ⌂' : ''}{warn ? ` ${warn.chip}` : (h.skill_count ? ` ·${h.skill_count}` : '')}
                    </button>
                  );
                })}
                {/* CORE ONLY: a dispatch with no persona at all was reachable when the persona was
                    its own toolbar button and must not become impossible now that the choice lives
                    here. Managers are never offered this — their manual IS the manager harness. */}
                <button className={`disp-seg ${harness === '' ? 'on' : ''}`}
                        data-testid="dispatch-harness-none"
                        title="Core only — the manual + binding rules, no persona/skills layer"
                        onClick={() => setHarness('')}>
                  ○ core only
                </button>
              </div>
              <div className="disp-hint disp-policy" data-testid="dispatch-policy">{policyLine}</div>
            </div>
          )}

          {/* THE ROUTER BANNER (139) — the gate's state, said where the decision is made. */}
          {routerGate && !routerMode && (
            liveRouter ? (
              <div className="disp-persona disp-router" data-testid="dispatch-router-live">
                <b>{routerSt.harness?.glyph || '⇄'} Router: {liveRouter.slug}</b>
                <span className="disp-hint"> — {liveRouter.provider || 'provider ?'}{liveRouter.model ? ` / ${liveRouter.model}` : ''}{liveRouter.zee_status ? ` · ${liveRouter.zee_status}` : ''}</span>
                <button className="disp-seg disp-router-swap" data-testid="router-redeploy-button"
                        title="Redeploy the router — same xell, a NEW zee on a provider/model you pick (swap it with a better model)."
                        onClick={() => setRouterMode('redeploy')}>⇄ redeploy / swap model</button>
                <div className="disp-hint">
                  Your prompt is handed <b>raw</b> to the router, which recomposes it and decides the
                  provider, model, autonomy and persona under the router policy — so those controls are
                  its call, not knobs here.
                </div>
              </div>
            ) : (
              <div className="disp-persona disp-router" data-testid="dispatch-router-missing" role="alert">
                <b>⚠ No router on this project.</b>
                <div className="disp-hint">
                  {routerSt.reason || 'No live router — deploy one first.'} Raw prompts are dispatched
                  through a ROUTER zee — it recomposes them and decides the provider, model, autonomy
                  and persona. Deploy one first (button below); dispatch is disabled until it is live.
                </div>
              </div>
            )
          )}
          {/* The two states the gate used to hide behind "no gate": still asking, and asked-and-failed.
              Neither pretends the project has no router — a silent direct dispatch is how "no router"
              went unnoticed on a project that had none. */}
          {!manager && !routerMode && routerLoading && (
            <div className="disp-persona disp-router" data-testid="dispatch-router-loading">
              <b>⇄ Checking this project's router…</b>
            </div>
          )}
          {!manager && !routerMode && routerErr && (
            <div className="disp-persona disp-router" data-testid="dispatch-router-unknown" role="alert">
              <b>⚠ Could not read this project's router status.</b>
              <div className="disp-hint">
                {routerErr} — dispatching from here goes DIRECTLY to a zee, without a router. Fix the
                project or retry before you rely on routing.
              </div>
            </div>
          )}
          {routerMode && (
            <div className="disp-persona disp-router" data-testid="router-deploy-note">
              <b>⇄ A router takes no brief.</b>
              <div className="disp-hint">
                Its job is fixed: accept raw prompts, recompose them into briefs zees can execute, and
                decide each dispatch under the router policy (weights, schedules and rewrite knobs live
                in the harness manager). It is a manager-type zee — production is <b>read-only</b> to it,
                it can <b>never land or ship</b>, and <code>zee sync</code> keeps its worktree current with
                the xource. Pick only the <b>provider</b> and <b>model</b> it thinks with.
                {routerMode === 'redeploy' && liveRouter ? (
                  <> Redeploying <code>{liveRouter.slug}</code>: same xell, same branch, same read-only
                  prod bind — only WHO routes changes.</>
                ) : null}
              </div>
            </div>
          )}

          {!routerMode && (
          <div className="disp-editor-wrap">
            {empty && (
              <div className="disp-placeholder">
                {manager
                  ? 'Its programme — what this crew is FOR, in priority order… (paste a backlog or a screenshot; ⌘/Ctrl+Enter to add. Leave blank and it will study the project, propose a plan and ask you before starting a crew.)'
                  : (liveRouter
                    ? 'Write the raw prompt — the router recomposes it and decides the dispatch… (paste text or a screenshot — ⌘/Ctrl+Enter to route)'
                    : 'Describe the task for the zee… (paste text or a screenshot — ⌘/Ctrl+Enter to dispatch)')}
              </div>
            )}
            <div className="disp-editor" ref={editorRef} contentEditable suppressContentEditableWarning
                 data-testid="dispatch-editor" role="textbox" aria-multiline="true"
                 onInput={syncEmpty} onPaste={onPaste} onKeyDown={onKeyDown} />
          </div>
          )}

          {/* Who else is already in this work — stated, never enforced. It names the xell and the overlap
              so the decision can be made with it in view: re-brief, talk to that xell, or carry on. */}
          {overlap?.warnings?.length > 0 && (
            <div className="disp-overlap" data-testid="dispatch-overlap">
              <b>⚠ {new Set(overlap.warnings.map((w) => w.xell_slug)).size} live xell(s) may already be in this work.</b>
              <ul>
                {[...new Map(overlap.warnings.map((w) => [w.xell_slug, w])).values()].map((w) => (
                  <li key={w.xell_slug}>
                    <code>{w.xell_slug}</code>
                    {w.title ? <> — “{w.title}”</> : null}:{' '}
                    {overlap.warnings.filter((x) => x.xell_slug === w.xell_slug).map((x) => (
                      x.kind === 'ticket'
                        ? `ticket ${x.tickets.join(', ')} (${x.detail})`
                        : `${x.paths.join(', ')}${x.more ? ` +${x.more} more` : ''} (${x.via})`
                    )).join('; ')}
                  </li>
                ))}
              </ul>
              <span className="disp-overlap-note">
                Two zees on one file is ordinary. Two zees on one PROBLEM is a duplicate nobody sees until it
                lands — dispatch anyway if you meant to.
              </span>
            </div>
          )}

          {attachments.length > 0 && !routerMode && (
            <div className="disp-imgs" data-testid="dispatch-attachments">
              {attachments.map((att) => (
                <div className={att.type?.startsWith('image/') ? 'disp-img' : 'disp-filechip'} key={att.id} title={att.name}>
                  {att.type?.startsWith('image/')
                    ? <img src={att.data} alt={att.name} />
                    : <><span className="disp-file-icon">📎</span><span className="disp-file-name">{att.name}</span></>}
                  <button className="disp-img-x" onClick={() => removeFile(att.id)}
                          title="Remove this attachment" aria-label="Remove attachment">✕</button>
                </div>
              ))}
              <span className="disp-imgnote">{attachments.length} attachment{attachments.length === 1 ? '' : 's'} · {totalMb.toFixed(1)} MB — handed to the zee as files in its worktree</span>
            </div>
          )}

          {/* ── CUSTOM DEPLOYMENT — the router's knobs, taken back by a human who knows ──────────
              Only with a LIVE router (with none, the direct panel below is the whole story and
              nothing here renders). COLLAPSED by default: the router deciding is still the norm, and
              a panel that opened itself would read as "fill this in". What is pinned is sent as an
              explicit DECISION the router obeys — unlike the persona HINT, which the router may
              overrule — and every field can be put back to "router decides". */}
          {routerGate && liveRouter && !routerMode && (
            <div className="disp-custom" data-testid="dispatch-custom">
              <button className={`disp-seg disp-custom-toggle ${customOpen ? 'on' : ''}`}
                      data-testid="dispatch-custom-toggle"
                      aria-expanded={customOpen}
                      title="Pin the provider, model, autonomy mode or persona for this dispatch — the router uses what you set here instead of deciding it."
                      onClick={() => setCustomOpen((v) => !v)}>
                {customOpen ? '▾' : '▸'} Custom deployment
                {customCount > 0 ? ` · ${customCount} pinned` : ''}
              </button>
              <div className="disp-hint" data-testid="dispatch-custom-summary">
                {customCount > 0
                  ? `Pinned: ${Object.entries(custom).map(([k, v]) => `${k}=${v}`).join(', ')}. `
                    + '⇄ Route via router carries them as YOUR decision (router fills the rest); '
                    + '⚡ Instant deploy skips the router and dispatches with these settings now.'
                  : 'Optional. Leave it closed and the router decides the provider, model, autonomy and persona itself.'}
              </div>
              {customOpen && (
                <div className="disp-controls" data-testid="dispatch-custom-panel">
                  {/* PERSONA first: it carries the model policy the provider/model choices below are
                      judged against, so changing it re-reads them (and clears a pin its policy may
                      forbid). "core only" is not offered here — a routing request always names a
                      persona or leaves it to the router. */}
                  <div className="disp-field">
                    <label className="disp-label">Persona</label>
                    <div className="disp-models" role="group" aria-label="Custom persona">
                      <button className={`disp-seg ${cHarness === null ? 'on' : ''}`}
                              data-testid="custom-harness-router"
                              title="Leave the persona to the router (the default)."
                              onClick={() => setCHarness(null)}>router decides</button>
                      {workerHarnesses.map((h) => {
                        const warn = emptyWarning(h);
                        return (
                          <button key={h.key} className={`disp-seg ${cHarness === h.key ? 'on' : ''} ${warn ? 'seg-hollow' : ''}`}
                                  data-testid={`custom-harness-${h.key}`}
                                  title={`${warn ? `${warn.chip.replace('⚠ ', '')} — ${warn.why}` : (h.summary || h.label)}`
                                    + (h.scope === 'project' ? '  (⌂ this project\'s own persona)' : '  (system-wide)')}
                                  onClick={() => setCHarness(h.key)}>
                            {h.label}{h.scope === 'project' ? ' ⌂' : ''}{warn ? ` ${warn.chip}` : ''}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* PROVIDER — the same read model the direct panel uses, so a provider the persona
                      forbids is shown disabled with its reason rather than silently missing. */}
                  <div className="disp-field">
                    <label className="disp-label">AI provider</label>
                    <div className="disp-models" role="group" aria-label="Custom AI provider">
                      <button className={`disp-seg ${cProv === null ? 'on' : ''}`}
                              data-testid="custom-provider-router"
                              title="Leave the provider to the router (its policy weights and schedule decide)."
                              onClick={() => setCProv(null)}>router decides</button>
                      {cProviderRows.map((p) => {
                        const pAcct = (p.accounts || []).find((a) => !a.paused && a.usage_limit)
                          || (p.accounts || []).find((a) => !a.paused) || null;
                        const pLim = providerLimitLabel(p, pAcct);
                        return (
                        <button key={p.provider} className={`disp-seg ${cProv === p.provider ? 'on' : ''} ${p.blocked_reason ? 'seg-hollow' : ''}`}
                                data-testid={`custom-provider-${p.provider}`}
                                disabled={!!p.blocked_reason}
                                title={p.blocked_reason
                                  ? `${p.label}: ${p.blocked_reason}`
                                  : `Pin this dispatch to ${p.label} — its own CLI inside the cxell (${p.runtime?.label || p.runtime?.key || 'runtime'})`
                                    + (pLim ? `\nprovider-wide: ${pLim}` : '')}
                                onClick={() => setCProv(p.provider)}>
                          <ZeeAvatar provider={p.provider} size={18}
                                     availablePct={p.available_pct
                                       ?? providerWide(pAcct?.usage_limit).available_pct} />
                          {p.label}
                          {pLim ? <span className="disp-limit" data-testid={`custom-provider-limit-${p.provider}`}> · {pLim}</span> : null}
                        </button>
                        );
                      })}
                      {!cProviderRows.length && (
                        <span className="disp-hint" data-testid="custom-no-providers">
                          {optsErr ? `could not read this project's providers: ${optsErr}` : 'loading…'}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* AUTONOMY — annotated for the runtime the PINNED provider runs on; with none
                      pinned it is the unannotated scale, because which one is real is not known yet. */}
                  <div className="disp-field">
                    <label className="disp-label">Autonomy mode</label>
                    <div className="disp-modes" role="group" aria-label="Custom autonomy mode">
                      <button className={`disp-seg ${cMode === null ? 'on' : ''}`}
                              data-testid="custom-mode-router"
                              title="Leave the autonomy mode to the router (its policy's default_mode)."
                              onClick={() => setCMode(null)}>router decides</button>
                      {cModes.map((m) => (
                        <button key={m.mode} className={`disp-seg ${cMode === m.mode ? 'on' : ''} ${m.enforced === false ? 'seg-hollow' : ''}`}
                                data-testid={`custom-mode-${m.mode}`}
                                title={m.enforced === false ? `${m.label} — ⚠ ${m.note}` : m.label}
                                onClick={() => setCMode(m.mode)}>
                          <b>{m.mode}</b> {m.key}{m.enforced === false ? ' ⚠' : ''}
                        </button>
                      ))}
                    </div>
                    {cMode != null && (
                      <div className="disp-hint">{cModes.find((m) => m.mode === cMode)?.label || ''}</div>
                    )}
                  </div>

                  {/* MODEL — per provider, so it needs one pinned first: `opus` is claude's id and
                      means nothing on another vendor's CLI (the server refuses that combination). */}
                  <div className="disp-field">
                    <label className="disp-label">Model</label>
                    {!cProv ? (
                      <div className="disp-hint" data-testid="custom-model-needs-provider">
                        Pin a provider first — model ids are a vendor's own (`opus` is claude's, not codex's).
                      </div>
                    ) : (
                      <div className="disp-models" role="group" aria-label="Custom model">
                        <button className={`disp-seg ${cModel === null ? 'on' : ''}`}
                                data-testid="custom-model-router"
                                title="Leave the model to the router (the persona's policy resolves it)."
                                onClick={() => setCModel(null)}>router decides</button>
                        {cModels.map((m) => {
                          const cAcc = cAcctId ? cAccounts.find((a) => a.id === cAcctId) : cAccounts[0];
                          const lim = modelLimitLabel(cProv, m.key, m, cAcc);
                          return (
                          <button key={m.key} className={`disp-seg ${cModel === m.key ? 'on' : ''}`}
                                  data-testid={`custom-model-${m.key}`}
                                  title={[m.note || m.label,
                                          lim ? `model limit: ${lim}` : null,
                                          m.context_window ? `context ${Number(m.context_window).toLocaleString()} tokens` : null,
                                          m.parameters ? `${m.parameters}B parameters` : null,
                                          m.priority > 1 ? `deployment priority ${m.priority}` : null].filter(Boolean).join(' · ')}
                                  onClick={() => setCModel(m.key)}>
                            {m.label}{m.key === cActive?.default_model ? ' ·default' : ''}
                            {lim ? <span className="disp-limit" data-testid={`model-limit-${m.key}`}> · {lim}</span> : null}
                          </button>
                          );
                        })}
                        {!cModels.length && (
                          <span className="disp-hint" data-testid="custom-no-models">
                            this persona's model policy allows no model on {cActive?.label || 'this provider'}
                          </span>
                        )}
                      </div>
                    )}
                  </div>

                  {/* ACCOUNT — only when the RESOLVED provider (pinned or Instant's default fill)
                      has more than one unpaused account. Instant dispatches on the pick; with none
                      pinned it keeps the silent "first unpaused" fill. Route via router ignores
                      this (the custom block has no account field). One account → no UI. */}
                  {cAccounts.length > 1 && (
                    <div className="disp-field">
                      <label className="disp-label">Account</label>
                      <div className="disp-models" role="group" aria-label="Custom AI account">
                        <button className={`disp-seg ${cAcctId === null ? 'on' : ''}`}
                                data-testid="custom-account-default"
                                title="Use the first unpaused account of the resolved provider (Instant's silent default)."
                                onClick={() => setCAcctId(null)}>first unpaused</button>
                        {cAccounts.map((a) => (
                          <button key={a.id} className={`disp-seg ${cAcctId === a.id ? 'on' : ''}`}
                                  data-testid={`custom-account-${a.id}`}
                                  title={`Instant deploy on ${a.name || a.label} (${cResolvedRow?.label || cResolvedProv})`}
                                  onClick={() => setCAcctId(a.id)}>
                            <ZeeAvatar provider={cResolvedProv} size={18} />
                            {a.name || a.label}
                          </button>
                        ))}
                      </div>
                      <div className="disp-hint" data-testid="custom-account-hint">
                        Instant deploy only — Route via router still lets the router pick the credential.
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* With the router gate ON the dispatch knobs are the ROUTER's call, so the composer does
              not show them for a worker prompt — except in router-deploy mode, where provider +
              model (what the router THINKS with) are exactly the two things a human picks. */}
          {(!routerGate || routerMode) && (
          <div className="disp-controls">
            {/* THE PERSONA — manager only in this controls block (workers on the direct path pick
                above, before the editor). One manager button serves the whole fleet, so the choice
                is made here; changing it re-resolves the providers/models below, because those
                follow from its policy.
                A MANAGER is never offered "core only": its manual IS the manager harness (the crew
                verbs, the read-only-prod and no-push law it must know). Stripping it would cage an
                agent that does not know what it may do. */}
            {manager && harnesses.length > 0 && (
              <div className="disp-field">
                <label className="disp-label">Persona</label>
                <div className="disp-models" role="group" aria-label="Harness">
                  <button className={`disp-seg ${harness === undefined ? 'on' : ''}`}
                          data-testid="dispatch-harness-default"
                          title="The manager harness — its own persona, skills and manual (the default for a manager)"
                          onClick={() => setHarness(undefined)}>
                    Default
                  </button>
                  {/* A harness that carries NOTHING is offered here exactly like a full one, and the
                      zee you dispatch is the one who pays for it — so say so at the point of choice.
                      bundle_empty comes from GET /api/harnesses. */}
                  {harnesses.map((h) => {
                    const warn = emptyWarning(h);
                    return (
                    <button key={h.key} className={`disp-seg ${harness === h.key ? 'on' : ''} ${warn ? 'seg-hollow' : ''}`}
                            data-testid={`dispatch-harness-${h.key}`}
                            title={`${warn ? `${warn.chip.replace('⚠ ', '')} — ${warn.why}` : (h.summary || h.label)}`
                              + (h.scope === 'project' ? `  (⌂ this project's own persona)` : '  (system-wide)')}
                            onClick={() => setHarness(h.key)}>
                      {h.label}{h.scope === 'project' ? ' ⌂' : ''}{warn ? ` ${warn.chip}` : (h.skill_count ? ` ·${h.skill_count}` : '')}
                    </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* WHICH PROVIDER — the personas's policy decides which of these a human may pick, and
                the project's connected accounts decide which are there at all. A forbidden or
                account-less provider is SHOWN, disabled, carrying its reason: the rule the persona
                imposes is a fact worth seeing, and a segment that silently vanished would read as
                "my account disappeared". */}
            <div className="disp-field">
              <label className="disp-label">AI provider</label>
              <div className="disp-models" role="group" aria-label="AI provider">
                {providerRows.map((p) => {
                  const pAcct = (p.accounts || []).find((a) => !a.paused && a.usage_limit)
                    || (p.accounts || []).find((a) => !a.paused) || null;
                  const pLim = providerLimitLabel(p, pAcct);
                  return (
                  <button key={p.provider} className={`disp-seg ${prov === p.provider ? 'on' : ''} ${p.blocked_reason ? 'seg-hollow' : ''}`}
                          data-testid={`dispatch-provider-${p.provider}`}
                          disabled={!!p.blocked_reason}
                          title={p.blocked_reason
                            ? `${p.label}: ${p.blocked_reason}`
                            : `Run this zee on ${p.label} — its own CLI inside the cxell (${p.runtime?.label || p.runtime?.key || 'runtime'})`
                              + (pLim ? `\nprovider-wide limit: ${pLim}` : '')}
                          onClick={() => setProv(p.provider)}>
                    {/* the vendor's own coin — the badge the dispatched zee will WEAR in the
                        honeycomb (web/src/providerArt.js). Which AI is thinking is the identity,
                        so it is a picture here as well as on the hexagon. */}
                    <ZeeAvatar provider={p.provider} size={18}
                               availablePct={p.available_pct
                                 ?? providerWide(pAcct?.usage_limit).available_pct} />
                    {p.label}
                    {pLim ? <span className="disp-limit" data-testid={`provider-limit-${p.provider}`}> · {pLim}</span> : null}
                  </button>
                  );
                })}
                {!providerRows.length && (
                  <span className="disp-hint" data-testid="dispatch-no-providers">
                    {optsErr ? `could not read this project's providers: ${optsErr}` : 'loading…'}
                  </span>
                )}
              </div>
              {active?.blocked_reason && (
                <div className="disp-hint" data-testid="dispatch-provider-blocked">⚠ {active.label}: {active.blocked_reason}</div>
              )}
            </div>

            {/* WHICH ACCOUNT of that provider type — a project can hold several (two Claude
                subscriptions, say), and the spawn uses precisely this one's token. Only rendered
                when there is a real choice. PAUSED accounts are excluded: the server refuses a
                dispatch on one anyway (spawnCreds → tokenForSpawn). */}
            {accounts.length > 1 && (
              <div className="disp-field">
                <label className="disp-label">Account</label>
                <div className="disp-models" role="group" aria-label="AI account">
                  {accounts.map((a) => {
                    const pw = providerWide(a.usage_limit);
                    const aPct = pw.available_pct ?? a.available_pct ?? null;
                    const aLim = aPct != null
                      ? formatLimitChip({ available_pct: aPct, source: 'provider' })
                      : '';
                    return (
                    <button key={a.id} className={`disp-seg ${acct?.id === a.id ? 'on' : ''}`}
                            data-testid={`dispatch-account-${a.id}`}
                            title={`Run this zee on ${a.name} (${active?.label}) — its own CLI inside the cxell`
                              + (aLim ? `\nprovider-wide: ${aLim}` : '')}
                            onClick={() => setAcctId(a.id)}>
                      <ZeeAvatar provider={active?.provider} size={18} availablePct={aPct} />
                      {a.name}
                      {aLim ? <span className="disp-limit"> · {aLim}</span> : null}
                    </button>
                    );
                  })}
                </div>
              </div>
            )}

            {!routerMode && (
            <div className="disp-field">
              <label className="disp-label">Autonomy mode</label>
              <div className="disp-modes" role="group" aria-label="Autonomy mode">
                {modes.map((m) => (
                  <button key={m.mode} className={`disp-seg ${mode === m.mode ? 'on' : ''} ${m.enforced === false ? 'seg-hollow' : ''}`}
                          data-testid={`dispatch-mode-${m.mode}`}
                          title={m.enforced === false ? `${m.label} — ⚠ ${m.note}` : m.label}
                          onClick={() => setMode(m.mode)}>
                    <b>{m.mode}</b> {m.key}{m.enforced === false ? ' ⚠' : ''}
                  </button>
                ))}
              </div>
              {/* The scale is real on an SDK runtime and NOT real inside a cxell (spawnCxell always
                  runs bypass and only logs what was asked). Say which one this provider is. */}
              <div className="disp-hint">{chosenMode?.label || ''}</div>
              {chosenMode && chosenMode.enforced === false && (
                <div className="disp-hint" data-testid="dispatch-mode-unenforced">
                  ⚠ {chosenMode.note} — on {active?.label || 'this provider'} the zee runs at full autonomy whatever is picked here.
                </div>
              )}
            </div>
            )}

            <div className="disp-field">
              <label className="disp-label">Model</label>
              <div className="disp-models" role="group" aria-label="Model">
                {models.map((m) => {
                  const lim = modelLimitLabel(active?.provider || prov, m.key, m, acct);
                  return (
                  <button key={m.key} className={`disp-seg ${model === m.key ? 'on' : ''}`}
                          data-testid={`dispatch-model-${m.key}`}
                          title={[m.note || m.label,
                                  lim || null,
                                  lim ? 'remaining usage limit for this model on the selected account' : null,
                                  m.context_window ? `context ${Number(m.context_window).toLocaleString()} tokens` : null,
                                  m.parameters ? `${m.parameters}B parameters` : null,
                                  m.priority > 1 ? `deployment priority ${m.priority}` : null].filter(Boolean).join(' · ')}
                          onClick={() => setModel(m.key)}>
                    {m.label}{(active ? m.key === active.default_model : m.default) ? ' ·default' : ''}
                    {lim ? <span className="disp-limit" data-testid={`model-limit-${m.key}`}> · {lim}</span> : null}
                  </button>
                  );
                })}
                {!models.length && (
                  <span className="disp-hint" data-testid="dispatch-no-models">
                    this persona's model policy allows no model on {active?.label || 'this provider'}
                  </span>
                )}
              </div>
            </div>

            {!routerMode && (
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
            )}

            {!routerMode && (
            <>
            {/* Visual verification. A per-xell opt-in, copied from the prodDb toggle's shape: the
                zee builds the webapp and OFFERS the live link to a human in the console. It is a
                look, not a gate — there is nothing to approve, only a link to open or dismiss. */}
            <div className="disp-field">
              <label className="disp-label">Visual verification</label>
              <div className="disp-sup" role="group" aria-label="Visual verification">
                <button className={`disp-seg ${!visualVerify ? 'on' : ''}`} data-testid="dispatch-vv-off"
                        title="The zee does not offer its webapp to a human — the default."
                        onClick={() => setVisualVerify(false)}>off</button>
                <button className={`disp-seg ${visualVerify ? 'on' : ''}`} data-testid="dispatch-vv-on"
                        title="The zee builds the webapp and OFFERS the live link to a human in the console (Open link / dismiss)."
                        onClick={() => setVisualVerify(true)}>👁 on</button>
              </div>
              <div className="disp-hint">The zee builds the webapp and offers the live link to a human in the console — a look, not a gate.</div>
            </div>

            </>
            )}
          </div>
          )}

          {/* Production DB access. A HUMAN decision about the xell, not a router knob — so it lives
              OUTSIDE the router-hidden controls block. With a live router the direct knobs (provider/
              model/mode) stay hidden (the router decides those), but this toggle must still be
              reachable: it used to vanish the day the router gate shipped, which is the bug this
              block closes.
              For a WORKER it is an opt-in toggle applied by Instant deploy / direct dispatch
              (db: 'db-shared-prod'). For a MANAGER it is not a choice at all — adding one mints a
              SELECT-only postgres role and binds it, failing closed if that cannot be done. So
              state the fact instead of showing a control that would be a lie in either position.
              Hidden in router-deploy mode (no worker xell is being composed). */}
          {!routerMode && (
            <div className="disp-controls" data-testid="dispatch-proddb-block">
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
                              title="Point this xell at the LIVE PRODUCTION database — real, irreversible writes. Schema changes are hard-blocked. With a live router this forces Instant deploy (the router cannot hand a worker production)."
                              onClick={() => setProdDb(true)}>⚠ LIVE PROD</button>
                    </div>
                    <div className="disp-hint">
                      For manual data processing on prod. Read + write only — schema changes (DDL) are hard-blocked.
                      {routerGate && liveRouter
                        ? ' With a live router, turning this on opens Instant deploy (the only door that can apply it).'
                        : ''}
                    </div>
                  </>
                )}
              </div>
            </div>
          )}

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
                {routerGate && liveRouter ? (
                  <>
                    <br />
                    <b>Use Instant deploy</b> — Route via router cannot apply LIVE PROD (a manager may not hand a worker production).
                  </>
                ) : null}
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
          {routerMode ? (
            <>
              {/* Back leaves the deploy sub-mode without discarding a half-written prompt behind it. */}
              <button className="disp-cancel" data-testid="router-deploy-back"
                      onClick={() => setRouterMode(null)}>← Back</button>
              <button className="disp-submit" onClick={submit} data-testid="router-deploy-submit">
                {routerMode === 'redeploy' ? '⇄ Redeploy router →' : '⇄ Deploy router →'}
              </button>
            </>
          ) : (
            <>
              <button className="disp-cancel" onClick={onClose}>Cancel</button>
              {/* The router gate's one honest button when nothing can be dispatched: deploy the
                  router. Dispatch stays VISIBLE and DISABLED beside it, carrying the reason — a
                  button that vanished would read as a broken console. */}
              {routerGate && !liveRouter && (
                <button className="disp-submit" data-testid="deploy-router-button"
                        title="Deploy this project's ROUTER zee — raw prompts are dispatched through it."
                        onClick={() => { setErr(null); setRouterMode('deploy'); }}>⇄ Deploy router</button>
              )}
              {/* INSTANT DEPLOY — when a custom deployment is pinned, OR when LIVE PROD is on.
                  Skips the router zee and POSTs /api/xell/dispatch with those settings. Sits
                  BESIDE Route via router (which stays the rightmost / default path when LIVE PROD
                  is off — the router deciding is still the norm). Absent when nothing is pinned
                  and LIVE PROD is off, so the footer is unchanged for the common case.
                  LIVE PROD alone is enough because the router path structurally cannot apply it
                  (selfDispatch refuses every db choice from a manager). Instant is then the only
                  door that can honour the toggle.
                  The one-line preview is the RESOLVED payload (pinned + silent defaults), from the
                  same resolveInstantDeployment() the click fires — so the human sees exactly what
                  will leave the button. Filled defaults are dimmed / marked ·default. */}
              {wantsInstant && instantResolved && (
                <>
                  <div className={`disp-instant-preview ${instantResolved.ok ? '' : 'is-err'}`}
                       data-testid="dispatch-instant-preview"
                       title={instantResolved.ok
                         ? instantPreviewTitle(instantResolved, { prodDb })
                         : instantResolved.error}>
                    {instantResolved.ok ? (
                      <>
                        <span className="disp-instant-preview-label">Instant will send</span>
                        {['provider', 'model', 'mode', 'harness', 'account'].map((k) => (
                          <span key={k}
                                className={`disp-instant-chip ${instantResolved.sources[k] === 'default' ? 'is-default' : 'is-pinned'}`}
                                data-testid={`instant-preview-${k}`}
                                data-source={instantResolved.sources[k]}>
                            {k}={instantResolved.labels[k]}
                            {instantResolved.sources[k] === 'default' ? ' ·default' : ''}
                          </span>
                        ))}
                        {prodDb && (
                          <span className="disp-instant-chip is-pinned disp-seg-danger"
                                data-testid="instant-preview-db"
                                data-source="pinned">
                            db=LIVE PROD
                          </span>
                        )}
                      </>
                    ) : (
                      <span data-testid="instant-preview-error">{instantResolved.error}</span>
                    )}
                  </div>
                  <button className="disp-submit disp-instant" onClick={instantDeploy}
                          title={instantResolved.ok
                            ? `${instantPreviewTitle(instantResolved, { prodDb })} — skips the router zee. Server-side validation and harness provider lanes still apply.`
                            : instantResolved.error}
                          data-testid="dispatch-instant">
                    ⚡ Instant deploy →
                  </button>
                </>
              )}
              {/* Disabled while the router status is IN FLIGHT as well: a prompt submitted in that
                  window used to be dispatched directly, past a router that was live all along.
                  Also disabled when LIVE PROD is on: the router cannot hand a worker production,
                  and Instant is the door that can — leaving Route clickable would either drop the
                  flag silently or refuse after the click. */}
              <button className="disp-submit" onClick={submit}
                      disabled={routerLoading || (routerGate && !liveRouter) || !!(routerGate && liveRouter && prodDb)}
                      title={routerLoading
                        ? 'Checking whether this project has a live router…'
                        : routerGate && !liveRouter
                        ? 'No live router on this project — raw prompts are dispatched through a router; deploy one first.'
                        : (routerGate && liveRouter && prodDb)
                        ? 'LIVE PROD cannot go through the router — use Instant deploy (a manager may not hand a worker production).'
                        : (routerGate && liveRouter && customCount > 0)
                        ? 'Hand the raw prompt to the router — it recomposes and decides the dispatch (your pins travel as a decision).'
                        : undefined}
                      data-testid={manager ? 'manager-submit' : 'dispatch-submit'}>
                {manager ? 'Add manager zee →' : (routerGate && liveRouter) ? '⇄ Route via router →' : 'Dispatch →'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  ), document.body);
}

// RESOLVE WHAT INSTANT DEPLOY WILL SEND.
//
// Instant silently fills every UNPINNED custom-deployment field (mode→5, model→policy default,
// provider→default_provider, harness→button/project default, account→first unpaused). That fill
// used to live only inside the click handler, so a human could not see it before firing. The
// footer preview and the fire path BOTH call this — one function, so the line next to the button
// and the payload that leaves on click cannot disagree.
//
// Returns either { ok:false, error } (nothing to dispatch — same sentences the handler used to
// setErr with) or { ok:true, provider, model, mode, harness, provider_token_id, sources, labels }.
// `sources` is pinned|default per field; `labels` is the human-readable form for the preview chips.
export function resolveInstantDeployment({
  cProv = null, cModel = null, cMode = null, cHarness = null, cAcctId = null,
  harness = undefined, options = null,
} = {}) {
  const pinned = {
    provider: cProv != null && cProv !== '',
    model: cModel != null && cModel !== '',
    mode: cMode != null,
    // cHarness null means "router decides" on the panel; Instant then falls back to the button's
    // persona (harness prop). A pin is only a non-null key (including '' for core-only, which the
    // custom panel does not currently offer — kept for symmetry with the direct path).
    harness: cHarness != null,
    account: cAcctId != null && cAcctId !== '',
  };

  // Persona: pinned wins; else the button that opened this composer (project default if none).
  const instHarness = pinned.harness ? cHarness
    : (harness !== undefined ? harness : undefined);

  const instProv = pinned.provider ? cProv : (options?.default_provider || null);
  const row = (options?.providers || []).find((p) => p.provider === instProv) || null;
  if (!instProv) {
    return { ok: false, error: 'Pin a provider in Custom deployment (or connect one this persona may run on).' };
  }
  if (row?.blocked_reason) {
    return { ok: false, error: `Cannot dispatch on ${row.label}: ${row.blocked_reason}` };
  }

  const instModel = pinned.model ? cModel
    : (row?.default_model != null ? row.default_model
      : (row?.models?.find((m) => m.default)?.key ?? row?.models?.[0]?.key ?? ''));
  const instMode = pinned.mode ? cMode : 5;

  const accounts = (row?.accounts || []).filter((a) => !a.paused);
  let acct = null;
  let accountSource = 'default';
  if (pinned.account) {
    acct = accounts.find((a) => a.id === cAcctId) || null;
    if (acct) accountSource = 'pinned';
  }
  if (!acct) acct = accounts[0] || null;

  const modeMeta = (row?.modes || options?.modes || []).find((m) => m.mode === instMode);
  const modelMeta = (row?.models || []).find((m) => m.key === instModel);
  const harnessLabel = instHarness === undefined ? '(project default)'
    : (instHarness === '' || instHarness === null) ? 'core only'
    : instHarness;

  return {
    ok: true,
    provider: instProv,
    model: instModel,
    mode: instMode,
    harness: instHarness,
    provider_token_id: acct?.id || null,
    sources: {
      provider: pinned.provider ? 'pinned' : 'default',
      model: pinned.model ? 'pinned' : 'default',
      mode: pinned.mode ? 'pinned' : 'default',
      harness: pinned.harness ? 'pinned' : 'default',
      account: accountSource,
    },
    labels: {
      provider: row?.label || instProv,
      model: modelMeta?.label || instModel || '(vendor default)',
      mode: modeMeta ? `${instMode} · ${modeMeta.key}` : String(instMode),
      harness: harnessLabel,
      account: acct?.name || acct?.label || '(none)',
    },
  };
}

// One-line title for the Instant button / preview hover — resolved values, pinned called out.
// `prodDb` is optional: when true the LIVE PROD decision is named too (it rides on the direct
// payload, not on resolveInstantDeployment's knobs).
export function instantPreviewTitle(resolved, { prodDb = false } = {}) {
  if (!resolved?.ok) return resolved?.error || '';
  const bits = ['provider', 'model', 'mode', 'harness', 'account']
    .map((k) => `${k}=${resolved.labels[k]}${resolved.sources[k] === 'default' ? ' (default)' : ''}`);
  if (prodDb) bits.push('db=LIVE PROD');
  return bits.join(' · ');
}

// The persona's EFFECTIVE model policy in one sentence — what it restricts, or that it restricts
// nothing. Exported so the same words can be asserted (and reused) rather than re-typed.
export function policySummary(policy) {
  if (!policy) return 'no model policy — every connected provider and model is available';
  const bits = [];
  if (policy.allow_providers?.length) bits.push(`providers: ${policy.allow_providers.join(', ')}`);
  if (policy.allow_models?.length) bits.push(`models: ${policy.allow_models.join(', ')}`);
  if (policy.default_model) bits.push(`default: ${policy.default_model}`);
  if (policy.min_context != null || policy.max_context != null) {
    bits.push(`context ${policy.min_context ?? '…'}–${policy.max_context ?? '…'}`);
  }
  if (policy.min_params != null || policy.max_params != null) {
    bits.push(`params(B) ${policy.min_params ?? '…'}–${policy.max_params ?? '…'}`);
  }
  return bits.length
    ? `policy — ${bits.join(' · ')} (enforced at dispatch)`
    : 'no model policy — every connected provider and model is available';
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
  ? [{ key: 'opus', label: 'Opus', default: true }, { key: 'sonnet', label: 'Sonnet' }, { key: 'haiku', label: 'Haiku' },
     { key: 'fable', label: 'Fable' }]
  : [{ key: '', label: 'default', note: "the vendor CLI's own default model", default: true }];
