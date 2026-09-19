// THE MESH PANEL (ticket #189) — the console half of the NetBird control plane.
//
// A machine hosts (or reaches) the self-hosted NetBird mesh (docs/netbird-mesh-plan.md). This
// panel is the three things a human needs about it, per the card:
//
//   CONFIG    the meta-DB mesh config, edited through a full-size STEP WIZARD (a modal overlay,
//             not the cramped inline form this replaced — "a compact dropdown I can barely
//             click"). The panel shows a read-only summary + a prominent "configure" button; the
//             wizard walks management → coordination → secrets → review with big inputs and the
//             field hints VISIBLE, not hidden in tooltips. The write-only rule is unchanged: a
//             secret is never rendered back — only a stored HINT is — and an empty field on save
//             means UNCHANGED. The datastore encryption key has a Generate button because it is
//             key MATERIAL the server deliberately refuses to invent; the API token and gateway
//             setup key are paste fields, so ROTATION exists even though the bootstrap
//             auto-provisions.
//   STAND UP  the `mesh-control-plane` bootstrap step surfaced as its own human-gated action, with
//             the same typed-word confirmation as the ship/prod gates. It performs ONLY that step
//             (api performBuildBootstrap `kinds`), never the project's networks or dev db.
//   OBSERVE   management health, the mesh_peer counts, and the phase-5 route-source tally
//             (mesh vs legacy-port, per day) — rendered simply, because the question "can we drop
//             legacy ports yet?" is answered by a count, not a chart.
//
// The bodies are PURE FUNCTIONS OF PROPS (the MeshWizardStepBody/MeshWizardReviewBody/
// MeshConfigSummaryBody/MeshStandUpBody/MeshObserveBody split, the same one Directives.jsx makes):
// the fetches live in MeshSections, so a test can render each body with a fixture through
// react-dom/server and read the markup back.
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { showAlert, showPrompt } from './Dialog.jsx';
import { getMeshConfig, putMeshConfig, getMeshStatus, planBuildBootstrap, performBuildBootstrap } from './api.js';

// The non-secret fields the card edits, in render order. Each names where the value is READ from,
// so an operator who sees the field can find the thing it configures.
export const MESH_FIELDS = [
  ['management_url', 'Management URL', 'The NetBird management API the queenzee calls (NETBIRD_API_URL). Empty = the mesh stays a legible no-op and every route answers legacy-port.'],
  ['mesh_domain', 'Mesh domain', 'Peers resolve as <hostname>.<domain> (MESH_DOMAIN). NetBird self-hosted default: netbird.selfhosted.'],
  ['signal_uri', 'Signal URI', 'management.json Signal.URI — the coordination service peers are told about.'],
  ['relay_endpoint', 'Relay endpoint', 'management.json Relay.Endpoint — the fallback hop for peers that cannot connect directly.'],
];

// The secrets. `hint` is the ONLY thing ever sent back from the server (a fingerprint, never the
// value); `generate` marks the one that is key MATERIAL a human must create.
export const MESH_SECRETS = [
  ['api_token', 'API token', false,
   'The management API token the queenzee authenticates with (NETBIRD_API_TOKEN). Paste a freshly minted token to rotate.'],
  ['datastore_encryption_key', 'Datastore encryption key', true,
   'management.json DataStoreEncryptionKey — 32 random bytes, base64. Generate one here, then SAVE; rotating it requires restarting the control plane with the new key.'],
  ['gateway_setup_key', 'Gateway setup key', false,
   'The setup key the mesh-gateway agent joins with (NETBIRD_GATEWAY_SETUP_KEY). Paste a one-off key to rotate.'],
];

// A fresh 32-byte key, base64 — the form management.json wants. The SERVER never generates key
// material (build-bootstrap refuses a placeholder); this is the human's Generate button, in the
// browser, and nothing is stored until the human saves.
export function generateDatastoreKey(bytes = 32) {
  const b = new Uint8Array(bytes);
  (globalThis.crypto || crypto).getRandomValues(b);
  return btoa(String.fromCharCode(...b));
}

// A secret's display line: the stored HINT if one exists, else "not set". NEVER the value.
export function secretHint(s) {
  if (!s || !s.set) return 'not set';
  return s.hint ? `stored (${s.hint})` : 'stored';
}

// Normalize the config read. The server half is built in parallel, so this tolerates the two
// plausible spellings of each section (fields|config, secrets|secret_hints) and both a bare hint
// string and a { set, hint } object — the join is then one sync, not a rewrite. `resolved` rides
// through untouched: it is what the queenzee would use RIGHT NOW (store→env→default), and the
// wizard's provision flow reads the plane's address out of it after a stand-up.
export function normalizeMeshConfig(r = {}) {
  const fields = r.fields || r.config || {};
  const raw = r.secrets || r.secret_hints || {};
  const secrets = {};
  for (const [k] of MESH_SECRETS) {
    const s = raw[k];
    secrets[k] = typeof s === 'string' ? { set: !!s, hint: s }
      : s ? { set: s.set !== false, hint: s.hint ?? s.fingerprint ?? s.last4 ?? null }
      : { set: false, hint: null };
  }
  // `enabled`/`configured` are the server's own answer to "is this fleet meant to have a mesh?"
  // (lib/mesh-config.js: a row exists / the console's switch). Carried through UNCOERCED — the mesh
  // status chip's tri-state reads them (meshStatus.js meshConfigured), and dropping them here left
  // the chip unable to tell "deliberately off" from "cannot tell" whenever only the config read
  // answered.
  return { fields, secrets, editable: r.editable !== false, resolved: r.resolved || null,
           enabled: r.enabled ?? null, configured: r.configured ?? null };
}

// The management URL a just-provisioned (or already-running) plane answers at, read from a fresh
// config: the ROW's value when the stand-up recorded one, else what the queenzee RESOLVES right
// now (which includes the compose-internal default an enabled row falls back to). Null means the
// queenzee reaches the plane without a stored URL — legal, and the wizard says so instead of
// inventing an address.
export function provisionedManagementUrl(cfg) {
  return cfg?.fields?.management_url || cfg?.resolved?.values?.api_url || null;
}

// ── CONFIG: the wizard ───────────────────────────────────────────────────────
// The wizard's page plan. Each page names which MESH_FIELDS / MESH_SECRETS it edits, plus a blurb
// that says what this page configures — VISIBLE text, because the compact form buried every
// explanation in a tooltip and the whole point of the wizard is that a human can read and click it.
export const MESH_WIZARD_STEPS = [
  { key: 'management', title: 'Management connection',
    blurb: 'Where the NetBird control plane answers. Leave the management URL empty and the mesh '
      + 'stays a legible no-op: every route falls back to legacy host:port. No server yet? '
      + 'Provision one below, on this Zeehive host itself.',
    fields: ['management_url', 'mesh_domain'], secrets: [] },
  { key: 'coordination', title: 'Signal & relay',
    blurb: 'The coordination services peers are told about: the signal service brokers direct '
      + 'connections, the relay is the fallback hop when a peer cannot connect directly.',
    fields: ['signal_uri', 'relay_endpoint'], secrets: [] },
  { key: 'secrets', title: 'Secrets',
    blurb: 'All three are WRITE-ONLY: the stored value is never shown, only that it is set. '
      + 'An empty field on save means unchanged — type or generate a value only to set or rotate it.',
    fields: [], secrets: ['api_token', 'datastore_encryption_key', 'gateway_setup_key'] },
  { key: 'review', title: 'Review & save',
    blurb: 'Nothing has been stored yet. Check the values below, then save.',
    fields: [], secrets: [] },
];

const fieldDef = (k) => MESH_FIELDS.find((f) => f[0] === k);
const secretDef = (k) => MESH_SECRETS.find((s) => s[0] === k);

// Pure body for ONE wizard page: big labelled inputs, the hint under each field as readable text.
// `fields` is the draft of the non-secret values, `secrets` the STORED state (hints only), `draft`
// the pending secret values (always empty unless the human typed/generated one this session).
// `slots` hangs extra content DIRECTLY UNDER one named field (slots[fieldKey] → rendered right
// after that field) — how the management page puts the install/provision block under the URL it
// fills, instead of somewhere lower a human has to connect back up.
export function MeshWizardStepBody({ step, fields = {}, secrets = {}, draft = {}, setField, setSecret, busy = false, slots = {} }) {
  if (!step) return null;
  return (
    <div className="mx-wizstep" data-testid={`mesh-wizard-step-${step.key}`}>
      <div className="mx-wizblurb">{step.blurb}</div>
      {step.fields.map((k) => {
        const [, label, hint] = fieldDef(k) || [k, k, ''];
        return (
          <React.Fragment key={k}>
            <label className="mx-wizfield">
              <span className="k">{label}</span>
              <input type="text" value={fields[k] ?? ''} disabled={busy} data-testid={`mesh-field-${k}`}
                     placeholder="—" onChange={(e) => setField?.(k, e.target.value)} />
              <span className="mx-wizhint">{hint}</span>
            </label>
            {slots[k] || null}
          </React.Fragment>
        );
      })}
      {step.secrets.map((k) => {
        const [, label, gen, hint] = secretDef(k) || [k, k, false, ''];
        return (
          <label className="mx-wizfield mx-wizsecret" key={k}>
            <span className="k">{label} <em className="mx-wizstored">— {secretHint(secrets[k])}</em></span>
            <span className="mx-wizinrow">
              <input type="password" value={draft[k] ?? ''} disabled={busy} data-testid={`mesh-secret-${k}`}
                     autoComplete="new-password"
                     placeholder={secrets[k]?.set ? 'stored — empty means unchanged' : 'not set — type to set'}
                     onChange={(e) => setSecret?.(k, e.target.value)} />
              {gen && (
                <button type="button" className="mx-wizgen" disabled={busy} data-testid={`mesh-generate-${k}`}
                        title="Generate 32 random bytes (base64) into the field. Nothing is stored until you save; saving replaces the stored key and the control plane must be restarted with it."
                        onClick={() => setSecret?.(k, generateDatastoreKey())}>generate</button>
              )}
            </span>
            <span className="mx-wizhint">{hint}</span>
          </label>
        );
      })}
    </div>
  );
}

// The PROVISION block on the management page: stand the NetBird control plane up on the queenzee's
// OWN production compose project (Zeehive's own containers) without leaving the wizard. It is the
// SAME plan/perform seam as the panel's STAND UP section — the plan is a dry run, the perform is
// behind the typed STAND UP gate — surfaced where the human is actually stuck: staring at an empty
// management-URL field with no server to point it at. Pure body; the handlers live in the wizard.
export function MeshWizardProvisionBody({ step, planned = false, busy = false, err = null, note = null,
                                          resolvedUrl = null, onPlan, onProvision, onAdopt }) {
  return (
    <div className="mx-wizprov" data-testid="mesh-wizard-provision">
      <div className="mx-wizprovhead">no management server yet? install one here</div>
      <div className="mx-wizblurb">
        Install/provision NetBird on this Zeehive host itself: the mesh-profile services in the
        queenzee's own production compose project, next to the production containers. It is
        human-gated (a typed STAND UP), creates ONLY the control plane, and a successful install
        generates the management URL and fills the field for you.
      </div>
      {!planned && busy && (
        <div className="mx-meshnote" data-testid="mesh-wizard-provision-checking">checking this host…</div>
      )}
      {!planned && !busy && (
        <button type="button" className="mx-wizprovplan" data-testid="mesh-wizard-provision-plan"
                title="Read the bootstrap plan for this machine (dry run — creates nothing) and show the mesh-control-plane step. The wizard runs this by itself when the page opens; the button re-checks."
                onClick={onPlan}>
          check this host…
        </button>
      )}
      {planned && step && (
        <>
          <div className={`mx-meshstep ${step.status}`} data-testid="mesh-wizard-provision-step">
            <b>{step.status}</b> — {step.detail || step.why}
          </div>
          {step.status === 'planned' && (
            <div className="mx-wizinrow">
              <button type="button" className="mx-wizprovgo" disabled={busy} data-testid="mesh-wizard-provision-go"
                      title={step.action || ''} onClick={onProvision}>
                {busy ? '⏳…' : '🏗 install NetBird — provision the control plane on this host'}
              </button>
            </div>
          )}
          {step.status === 'planned' && step.action && <span className="mx-wizhint">{step.action}</span>}
          {step.status === 'already-present' && (
            <button type="button" className="mx-wizprovuse" disabled={busy} data-testid="mesh-wizard-provision-use"
                    title="The control plane is already running on this host — fill the management URL above with the address the queenzee resolves for it."
                    onClick={onAdopt}>
              use this plane{resolvedUrl ? ` (${resolvedUrl})` : ''}
            </button>
          )}
        </>
      )}
      {planned && !step && (
        <div className="mx-meshnote" data-testid="mesh-wizard-provision-nostep">
          No mesh-control-plane step for this machine — the control plane lives in the queenzee's
          own compose project, so provisioning is offered on the queenzee-host machine only. Point
          the management URL at a plane that already runs elsewhere.
        </div>
      )}
      {err && <div className="mx-mesherr">{err}</div>}
      {note && <div className="mx-meshnote" data-testid="mesh-wizard-provision-note">{note}</div>}
    </div>
  );
}

// Pure body for the last page: every non-secret value as it will be saved, every secret as
// unchanged / will-be-set — NEVER the secret value itself.
export function MeshWizardReviewBody({ fields = {}, secrets = {}, draft = {} }) {
  return (
    <div className="mx-wizreview" data-testid="mesh-wizard-review">
      {MESH_FIELDS.map(([k, label]) => (
        <div className="mx-wizrevrow" key={k}>
          <span className="k">{label}</span>
          <span className="v">{fields[k] || '—'}</span>
        </div>
      ))}
      {MESH_SECRETS.map(([k, label]) => (
        <div className="mx-wizrevrow" key={k}>
          <span className="k">{label}</span>
          <span className="v">{draft[k] ? (secrets[k]?.set ? 'will be REPLACED' : 'will be SET')
            : `unchanged (${secretHint(secrets[k])})`}</span>
        </div>
      ))}
      <div className="mx-wizhint" data-testid="mesh-secret-note">
        secrets are write-only — the stored value is never shown, only that it is set;
        an empty field on save means unchanged
      </div>
    </div>
  );
}

// The stateful wizard modal: a full-size overlay (the dlg-overlay pattern from Dialog.jsx) with
// one page at a time, a step rail, Back/Next, and Save on the review page. It owns the DRAFT
// (fields seeded from the stored config, secrets always starting empty); nothing reaches the
// server until Save, which hands the write-only-merged body to `onSave`. Escape / backdrop / ✕
// close it and the draft is discarded — the stored config was never touched.
//
// `provision` + `onPlanProvision` + `onProvision` are the management page's stand-up seam:
// onProvision performs the (typed-gate) mesh-control-plane stand-up and resolves to the FRESH
// config read, from which the wizard fills the management URL — never clobbering one the human
// already typed. The one act a provision performs on the wizard's draft is filling that field.
export function MeshWizard({ machineKey, initialFields = {}, secrets = {}, onSave, onClose, busy = false, err = null,
                             provision = null, onPlanProvision = null, onProvision = null }) {
  const [i, setI] = useState(0);
  const [fields, setFields] = useState({ ...initialFields });
  const [draft, setDraft] = useState({});
  const [provNote, setProvNote] = useState(null);
  const step = MESH_WIZARD_STEPS[i];
  const last = i === MESH_WIZARD_STEPS.length - 1;

  // Fill the management URL from a plane address, unless the human already typed one — their
  // draft outranks anything the wizard derives.
  const adoptUrl = (url, how) => {
    if (fields.management_url) {
      setProvNote(`the plane answers at ${url || 'its compose-internal default'} — keeping the URL you typed.`);
    } else if (url) {
      setFields((f) => ({ ...f, management_url: url }));
      setProvNote(`management URL filled from ${how}: ${url}`);
    } else {
      setProvNote(`${how} is up — leaving the URL empty is fine: the queenzee reaches its own plane at the compose-internal default.`);
    }
  };

  const provisionNow = async () => {
    setProvNote(null);
    // null = typed gate declined, the perform failed, or the receipt shows no success (the error
    // then rides provision.err + an error alert — never a false "URL should be here" note).
    const r = await onProvision?.();
    if (!r) return;
    const url = r.result?.management_url || provisionedManagementUrl(r.cfg);
    adoptUrl(url, 'the control plane that just stood up');
  };

  // AUTO-CHECK the host the moment the management page is open: the plan is a dry run (creates
  // nothing, no gate), and running it unprompted is what turns the block from "check, then
  // install" into "install" — the one-click flow the field promises. Once per wizard open; the
  // button in the block re-checks by hand after an error.
  const autoPlanned = useRef(false);
  useEffect(() => {
    if (step.key !== 'management' || !provision || !onPlanProvision) return;
    if (provision.planned || provision.busy || autoPlanned.current) return;
    autoPlanned.current = true;
    onPlanProvision();
  }, [step.key, provision, onPlanProvision]);

  // The install/provision block, hung DIRECTLY UNDER the management URL field it fills.
  const provisionSlot = step.key === 'management' && provision
    ? { management_url: (
        <MeshWizardProvisionBody step={provision.step} planned={provision.planned}
                                 busy={busy || provision.busy} err={provision.err} note={provNote}
                                 resolvedUrl={provision.resolvedUrl}
                                 onPlan={onPlanProvision} onProvision={provisionNow}
                                 onAdopt={() => adoptUrl(provision.resolvedUrl, 'the plane already running on this host')} />
      ) }
    : {};

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); onClose?.(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const save = () => {
    // Empty secret = unchanged (the write-only rule): only non-empty drafts are sent.
    const body = { ...fields };
    for (const [k] of MESH_SECRETS) if (draft[k]) body[k] = draft[k];
    onSave?.(body);
  };

  return (
    <div className="mx-wizoverlay" data-testid="mesh-wizard"
         onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
      <div className="mx-wiz" role="dialog" aria-modal="true" aria-label={`Configure the NetBird control plane on ${machineKey}`}>
        <div className="mx-wizhead">
          <span className="mx-wiztitle">🌐 NetBird control plane — {machineKey}</span>
          <button type="button" className="mx-wizclose" data-testid="mesh-wizard-close" title="Close — discards unsaved edits"
                  onClick={() => onClose?.()}>✕</button>
        </div>
        <div className="mx-wizrail">
          {MESH_WIZARD_STEPS.map((s, n) => (
            <button type="button" key={s.key} data-testid={`mesh-wizard-goto-${s.key}`}
                    className={`mx-wizdot${n === i ? ' on' : ''}${n < i ? ' done' : ''}`}
                    onClick={() => setI(n)}>
              <b>{n + 1}</b> {s.title}
            </button>
          ))}
        </div>
        <div className="mx-wizbody">
          <div className="mx-wizsteptitle">{step.title}</div>
          {step.key === 'review'
            ? <>
                <div className="mx-wizblurb">{step.blurb}</div>
                <MeshWizardReviewBody fields={fields} secrets={secrets} draft={draft} />
              </>
            : <MeshWizardStepBody step={step} fields={fields} secrets={secrets} draft={draft} busy={busy}
                                  slots={provisionSlot}
                                  setField={(k, v) => setFields((f) => ({ ...f, [k]: v }))}
                                  setSecret={(k, v) => setDraft((d) => ({ ...d, [k]: v }))} />}
          {err && <div className="mx-mesherr">{err}</div>}
        </div>
        <div className="mx-wizfoot">
          <button type="button" className="mx-wizback" data-testid="mesh-wizard-back" disabled={busy || i === 0}
                  onClick={() => setI((n) => Math.max(0, n - 1))}>‹ back</button>
          {!last && (
            <button type="button" className="mx-wiznext" data-testid="mesh-wizard-next" disabled={busy}
                    onClick={() => setI((n) => Math.min(MESH_WIZARD_STEPS.length - 1, n + 1))}>next ›</button>
          )}
          {last && (
            <button type="button" className="mx-wizsave" data-testid="mesh-save" disabled={busy || !onSave}
                    title="Save the config. Secrets are write-only: an empty secret field means unchanged."
                    onClick={save}>{busy ? '⏳…' : 'save config'}</button>
          )}
        </div>
      </div>
    </div>
  );
}

// The panel's read-only CONFIG summary + the button that opens the wizard. Pure body: the summary
// shows current values (secrets as hints, never values) so the panel still answers "what is set?"
// at a glance; all EDITING lives in the wizard.
export function MeshConfigSummaryBody({ fields = {}, secrets = {}, editable = true, onConfigure, err = null, note = null }) {
  return (
    <div className="mx-meshsec" data-testid="mesh-config">
      <div className="mx-meshhead">config</div>
      {MESH_FIELDS.map(([k, label, hint]) => (
        <div className="mx-meshsumrow" key={k} title={hint}>
          <span className="k">{label}</span>
          <span className="v">{fields[k] || '—'}</span>
        </div>
      ))}
      {MESH_SECRETS.map(([k, label, , hint]) => (
        <div className="mx-meshsumrow" key={k} title={hint}>
          <span className="k">{label}</span>
          <span className="v">{secretHint(secrets[k])}</span>
        </div>
      ))}
      <div className="mx-meshrow">
        <button type="button" className="mx-meshconfigure" data-testid="mesh-configure"
                disabled={!editable || !onConfigure}
                title={editable ? 'Open the setup wizard: management connection, signal & relay, secrets, review — full-size inputs, nothing stored until you save.'
                  : 'this host does not run the control plane; the config is read-only here.'}
                onClick={onConfigure}>
          ⚙ configure control plane…
        </button>
      </div>
      {err && <div className="mx-mesherr">{err}</div>}
      {note && <div className="mx-meshnote">{note}</div>}
    </div>
  );
}

// ── STAND UP ─────────────────────────────────────────────────────────────────
// Pure body over the PLAN for the `mesh-control-plane` step: null (not planned yet), a step row,
// or { error }. Only a 'planned' step offers the action; a running plane is reported, a 'cannot'
// says why, and a machine that is not the queenzee host has no such step at all.
export function MeshStandUpBody({ step = null, planned = false, busy = false, err = null, onPlan, onPerform }) {
  return (
    <div className="mx-meshsec" data-testid="mesh-standup">
      <div className="mx-meshhead">stand up</div>
      {!planned && (
        <div className="mx-meshrow">
          <button className="mx-meshplan" disabled={busy} data-testid="mesh-plan" onClick={onPlan}
                  title="Read the bootstrap plan for this machine (dry run — creates nothing) and show the mesh-control-plane step.">
            {busy ? '⏳…' : 'plan stand-up'}
          </button>
        </div>
      )}
      {planned && step && (
        <>
          <div className={`mx-meshstep ${step.status}`} data-testid="mesh-step">
            <b>{step.status}</b> — {step.detail || step.why}
          </div>
          {step.status === 'planned' && (
            <div className="mx-meshrow">
              <button className="mx-meshgo" disabled={busy} data-testid="mesh-standup-go"
                      title={step.action || ''} onClick={onPerform}>
                {busy ? '⏳…' : 'stand up control plane'}
              </button>
              <span className="mx-meshhint">{step.action}</span>
            </div>
          )}
        </>
      )}
      {planned && !step && (
        <div className="mx-meshnote" data-testid="mesh-nostep">
          No mesh-control-plane step for this machine — the control plane runs in the queenzee's own
          compose project, so the stand-up is offered on the queenzee-host machine only.
        </div>
      )}
      {err && <div className="mx-mesherr">{err}</div>}
    </div>
  );
}

// ── OBSERVE ──────────────────────────────────────────────────────────────────
// Pure body: management health, peer counts, and the route-source tally. `status` is the server's
// { management:{reachable}, peers:{counts}, tally:{window_days,by_source,by_kind,days,error} }.
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

// The per-day rows reduced for reading: newest first, `mesh/legacy` per day. Exported so a test
// pins the reduction without a DOM.
export function tallyDays(tally) {
  const by = {};
  for (const d of tally?.days || []) {
    const key = String(d.day);
    by[key] = by[key] || { day: key, mesh: 0, legacy: 0 };
    if (d.source === 'mesh') by[key].mesh += num(d.n);
    else if (d.source === 'legacy-port') by[key].legacy += num(d.n);
  }
  return Object.values(by).sort((a, b) => (a.day < b.day ? 1 : -1));
}

export function MeshObserveBody({ status = null, err = null, onRefresh }) {
  const mgmt = status?.management || null;
  const counts = status?.peers?.counts || null;
  const peers = status?.peers?.list || status?.peers?.rows || null;   // present iff the server answers a list
  const tally = status?.tally || null;
  const days = tallyDays(tally);
  return (
    <div className="mx-meshsec" data-testid="mesh-observe">
      <div className="mx-meshhead">
        observe
        {onRefresh && <button className="mx-meshrefresh" data-testid="mesh-refresh" onClick={onRefresh}
                               title="Re-read the management health, peer counts and route tally">↻</button>}
      </div>
      {!status && !err && <div className="mx-meshnote">reading…</div>}
      {status && (
        <div className="mx-meshobs">
          <div className={`mx-meshhealth ${mgmt?.reachable ? 'ok' : 'down'}`} data-testid="mesh-health">
            management: {mgmt?.reachable ? 'reachable ✓' : `unreachable ✗${mgmt?.error ? ` — ${mgmt.error}` : ''}`}
          </div>
          {counts && (
            <div className="mx-meshpeers" data-testid="mesh-peers">
              peers: {Object.entries(counts).map(([k, v]) => `${k} ${num(v)}`).join(' · ') || 'none'}
            </div>
          )}
          {Array.isArray(peers) && peers.length > 0 && (
            <div className="mx-meshpeerlist" data-testid="mesh-peer-list">
              {peers.map((p, i) => (
                <div key={p.id || p.hostname || i}>
                  {p.hostname || p.name || p.id} · {p.kind || '?'} · {p.status || '?'}
                </div>
              ))}
            </div>
          )}
          {tally && (
            <div className="mx-meshtally" data-testid="mesh-tally">
              <div className="mx-meshtally-head">
                routes, last {tally.window_days} day(s) — mesh {num(tally.by_source?.mesh)} · legacy-port {num(tally.by_source?.['legacy-port'])}
              </div>
              {tally.error && <div className="mx-mesherr">tally unavailable: {tally.error}</div>}
              {!tally.error && (
                <table className="mx-meshtable">
                  <thead><tr><th>day</th><th>mesh</th><th>legacy</th></tr></thead>
                  <tbody>
                    {days.length === 0 && <tr><td colSpan="3" className="mx-meshhint">nothing recorded yet</td></tr>}
                    {days.map((d) => (
                      <tr key={d.day}><td>{d.day}</td><td>{d.mesh}</td><td>{d.legacy}</td></tr>
                    ))}
                  </tbody>
                </table>
              )}
              <div className="mx-meshbykind">
                {Object.entries(tally.by_kind || {}).map(([kind, by]) => (
                  <span key={kind} className="mx-meshkind">{kind}: mesh {num(by.mesh)} / legacy {num(by['legacy-port'])}</span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
      {err && <div className="mx-mesherr">{err}</div>}
    </div>
  );
}

// The stateful section loader: one fetch each for config and status, then the pure bodies.
function MeshSections({ m, projectId, onChanged }) {
  const [cfg, setCfg] = useState(null);
  const [fields, setFields] = useState({});
  const [storedSecrets, setStoredSecrets] = useState({});
  const [wizardOpen, setWizardOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [cfgErr, setCfgErr] = useState(null);
  const [cfgNote, setCfgNote] = useState(null);
  const [plan, setPlan] = useState(null);          // undefined = not planned; null = no step
  const [planned, setPlanned] = useState(false);
  const [planErr, setPlanErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(null);
  const [statusErr, setStatusErr] = useState(null);

  const loadConfig = useCallback(async () => {
    try {
      const r = normalizeMeshConfig(await getMeshConfig(m.id));
      setCfg(r); setFields(r.fields || {}); setStoredSecrets(r.secrets || {}); setCfgErr(null);
      return r;
    } catch (e) { setCfgErr(e.message || String(e)); return null; }
  }, [m.id]);

  const loadStatus = useCallback(async () => {
    try { setStatus(await getMeshStatus(m.id)); setStatusErr(null); }
    catch (e) { setStatus(null); setStatusErr(e.message || String(e)); }
  }, [m.id]);

  useEffect(() => { loadConfig(); loadStatus(); }, [loadConfig, loadStatus]);

  // The wizard hands over the write-only-merged body (empty secret = unchanged — the merge lives
  // in MeshWizard.save); a failed save keeps the wizard open with the error, a good one closes it.
  const save = async (body) => {
    setSaving(true); setCfgErr(null); setCfgNote(null);
    try {
      await putMeshConfig(m.id, body);
      setCfgNote('saved.');
      setWizardOpen(false);
      await loadConfig();
      onChanged?.();
    } catch (e) { setCfgErr(e.message || String(e)); }
    finally { setSaving(false); }
  };

  const loadPlan = async () => {
    setBusy(true); setPlanErr(null);
    try {
      const r = await planBuildBootstrap(projectId, m.id);
      // A refused plan (an unreachable daemon) is not "this machine has no control-plane step" —
      // say why, rather than letting the host-only note take the blame.
      if (r?.refused || r?.status === 'refused') { setPlan(null); setPlanErr(r.refused || r.reason || 'the bootstrap refused'); setPlanned(true); return; }
      const steps = r?.plan || r?.steps || [];
      setPlan(steps.find((s) => s.kind === 'mesh-control-plane') || null);
      setPlanned(true);
    } catch (e) { setPlanErr(e.message || String(e)); setPlanned(true); }
    finally { setBusy(false); }
  };

  // The ONE perform path for the mesh-control-plane stand-up — the panel's STAND UP section and
  // the wizard's provision block both land here, so the typed gate and the kinds scope can never
  // fork. It READS THE RECEIPT and branches on what actually happened: a failed/cannot step is an
  // ERROR alert carrying the step's own detail (the old flow showed one generic "requested" alert
  // whatever the outcome, so a failed stand-up looked exactly like a good one and the URL "just
  // did not fill"). On success it returns { cfg, result } — the fresh config read AND the step
  // result, whose typed `management_url` is the address the plane answered at. Null = the typed
  // gate was declined, the perform failed, or the receipt shows no success.
  const standUp = async (step) => {
    const typed = await showPrompt(
      `Stand up the NetBird control plane on ${m.key}?\n\n`
      + `${step?.action || 'the mesh-profile services in the queenzee\'s own compose project'}\n\n`
      + 'This runs docker compose on the queenzee\'s own host and health-checks the management API. '
      + 'It creates ONLY the control plane — no project network, volume or dev db. '
      + 'The API token and gateway setup key stay yours to set.\n\nType STAND UP to confirm.',
      { okLabel: 'Stand up', variant: 'danger', placeholder: 'STAND UP' });
    if (String(typed || '').trim().toUpperCase() !== 'STAND UP') return null;
    setBusy(true); setPlanErr(null);
    try {
      const r = await performBuildBootstrap(projectId, m.id, 'human@console', ['mesh-control-plane']);
      if (r?.status === 'refused') {
        setPlanErr(r.reason || 'the bootstrap refused');
        showAlert(`The stand-up on ${m.key} was REFUSED:\n\n${r.reason || '(no reason given)'}`, { variant: 'error' });
        return null;
      }
      const result = (r?.results || r?.steps || []).find((s) => s.kind === 'mesh-control-plane') || null;
      if (!result) {
        setPlanErr('the perform returned no mesh-control-plane step — nothing was stood up');
        showAlert(`No mesh-control-plane step ran on ${m.key} — the control plane lives on the queenzee-host machine only.`, { variant: 'error' });
        await Promise.all([loadPlan(), loadStatus()]);
        return null;
      }
      if (result.status !== 'created' && result.status !== 'already-present') {
        // failed / cannot: the receipt's detail IS the fix ("set MESH_COMPOSE_FILE…", the compose
        // stderr, the health-check verdict) — show it, do not pretend anything stood up.
        setPlanErr(result.detail || result.why || `the stand-up ended '${result.status}'`);
        showAlert(`The stand-up did NOT complete on ${m.key} (${result.status}):\n\n${result.detail || result.why || ''}`
          + (result.stderr ? `\n\n${result.stderr}` : ''), { variant: 'error' });
        await Promise.all([loadPlan(), loadStatus()]);
        return null;
      }
      showAlert(`NetBird control plane ${result.status === 'created' ? 'is UP' : 'was already running'} on ${m.key}.\n\n`
        + `${result.detail || ''}${result.warning ? `\n\n⚠ ${result.warning}` : ''}`, { variant: 'info' });
      const [fresh] = await Promise.all([loadConfig(), loadPlan(), loadStatus()]);
      onChanged?.();
      return { cfg: fresh, result };
    } catch (e) { setPlanErr(e.message || String(e)); return null; }
    finally { setBusy(false); }
  };

  return (
    <div className="mx-meshsections">
      <MeshConfigSummaryBody fields={fields} secrets={storedSecrets} editable={cfg?.editable !== false}
                             onConfigure={() => { setCfgNote(null); setWizardOpen(true); }}
                             err={cfgErr} note={cfgNote} />
      {wizardOpen && (
        <MeshWizard machineKey={m.key} initialFields={fields} secrets={storedSecrets} busy={saving}
                    onSave={save} onClose={() => setWizardOpen(false)} err={cfgErr}
                    provision={{ step: plan, planned, busy, err: planErr,
                                 resolvedUrl: cfg?.resolved?.values?.api_url || null }}
                    onPlanProvision={loadPlan} onProvision={() => standUp(plan)} />
      )}
      <MeshStandUpBody step={plan} planned={planned} busy={busy} err={planErr}
                       onPlan={loadPlan} onPerform={() => standUp(plan)} />
      <MeshObserveBody status={status} err={statusErr} onRefresh={loadStatus} />
      {cfg?.editable === false && (
        <div className="mx-meshnote">this host does not run the control plane; the config is read-only here.</div>
      )}
    </div>
  );
}

// The toggle MachineHead renders. Closed by default: the panel is an opt-in surface, like 📱 devices.
//
// `focus` is the CLICK-THROUGH from the status line's mesh indicator (MeshStatus.jsx): a changing
// nonce (not a boolean) so every click lands here again, opening THIS machine's panel and scrolling
// it into view. Without it a MESH DOWN chip could only tell a human that something is wrong, not
// take them to the thing the card says fixes it.
export default function MeshPanel({ m, projectId, onChanged = null, focus = null }) {
  const [open, setOpen] = useState(false);
  const box = useRef(null);
  useEffect(() => {
    if (focus == null) return;
    setOpen(true);
    // After the open paints, not before — a closed panel has no height to scroll to.
    const raf = globalThis.requestAnimationFrame || ((f) => setTimeout(f, 0));
    raf(() => box.current?.scrollIntoView?.({ block: 'center', behavior: 'smooth' }));
  }, [focus]);
  return (
    <div className="mx-meshpanel" data-testid={`mx-meshpanel-${m.key}`} ref={box}>
      <button className="mx-meshbtn" disabled={!projectId} onClick={() => setOpen((o) => !o)}
              data-testid={`mx-mesh-${m.key}`}
              title="Mesh control plane (NetBird): configure the management connection, stand the control plane up (human-gated), and observe management health, peer counts and the mesh-vs-legacy route tally">
        🌐 mesh {open ? '▴' : '▾'}
      </button>
      {open && <MeshSections m={m} projectId={projectId} onChanged={onChanged} />}
    </div>
  );
}
