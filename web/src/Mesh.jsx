// THE MESH PANEL (ticket #189) — the console half of the NetBird control plane.
//
// A machine hosts (or reaches) the self-hosted NetBird mesh (docs/netbird-mesh-plan.md). This
// panel is the three things a human needs about it, per the card:
//
//   CONFIG    the meta-DB mesh config: non-secret fields + the THREE write-only secrets. A secret
//             is never rendered back — only a stored HINT is — and an empty field on save means
//             UNCHANGED. The datastore encryption key has a Generate button because it is key
//             MATERIAL the server deliberately refuses to invent; the API token and gateway setup
//             key are paste fields, so ROTATION exists even though the bootstrap auto-provisions.
//   STAND UP  the `mesh-control-plane` bootstrap step surfaced as its own human-gated action, with
//             the same typed-word confirmation as the ship/prod gates. It performs ONLY that step
//             (api performBuildBootstrap `kinds`), never the project's networks or dev db.
//   OBSERVE   management health, the mesh_peer counts, and the phase-5 route-source tally
//             (mesh vs legacy-port, per day) — rendered simply, because the question "can we drop
//             legacy ports yet?" is answered by a count, not a chart.
//
// The bodies are PURE FUNCTIONS OF PROPS (the MeshConfigBody/MeshStandUpBody/MeshObserveBody split,
// the same one Directives.jsx makes): the fetches live in MeshSections, so a test can render each
// body with a fixture through react-dom/server and read the markup back.
import React, { useState, useEffect, useCallback } from 'react';
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
// string and a { set, hint } object — the join is then one sync, not a rewrite.
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
  return { fields, secrets, editable: r.editable !== false };
}

// ── CONFIG ───────────────────────────────────────────────────────────────────
// Pure body: `fields` is the draft, `secrets` the STORED state, `draft` the pending secret values
// (always empty unless the human typed/generated one this session).
export function MeshConfigBody({ fields = {}, secrets = {}, draft = {}, setField, setSecret, onSave, busy = false, err = null, note = null }) {
  return (
    <div className="mx-meshsec" data-testid="mesh-config">
      <div className="mx-meshhead">config</div>
      {MESH_FIELDS.map(([k, label, hint]) => (
        <label className="mx-meshfield" key={k} title={hint}>
          <span className="k">{label}</span>
          <input type="text" value={fields[k] ?? ''} disabled={busy} data-testid={`mesh-field-${k}`}
                 placeholder="—" onChange={(e) => setField?.(k, e.target.value)} />
        </label>
      ))}
      {MESH_SECRETS.map(([k, label, gen, hint]) => (
        <label className="mx-meshfield mx-meshsecret" key={k} title={`${hint}\n\nWrite-only: an empty field on save means unchanged.`}>
          <span className="k">{label}</span>
          <input type="password" value={draft[k] ?? ''} disabled={busy} data-testid={`mesh-secret-${k}`}
                 autoComplete="new-password"
                 placeholder={secretHint(secrets[k])} onChange={(e) => setSecret?.(k, e.target.value)} />
          {gen && (
            <button type="button" className="mx-meshgen" disabled={busy} data-testid={`mesh-generate-${k}`}
                    title="Generate 32 random bytes (base64) into the field. Nothing is stored until you save; saving replaces the stored key and the control plane must be restarted with it."
                    onClick={() => setSecret?.(k, generateDatastoreKey())}>generate</button>
          )}
        </label>
      ))}
      <div className="mx-meshrow">
        <button className="mx-meshsave" disabled={busy || !onSave} data-testid="mesh-save"
                title="Save the config. Secrets are write-only: an empty secret field means unchanged." onClick={onSave}>
          {busy ? '⏳…' : 'save config'}
        </button>
        <span className="mx-meshhint" data-testid="mesh-secret-note">
          secrets are write-only — the stored value is never shown, only that it is set
        </span>
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

// The stateful section loader: one fetch each for config and status, then the three pure bodies.
function MeshSections({ m, projectId, onChanged }) {
  const [cfg, setCfg] = useState(null);
  const [fields, setFields] = useState({});
  const [storedSecrets, setStoredSecrets] = useState({});
  const [draft, setDraft] = useState({});
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
      setCfg(r); setFields(r.fields || {}); setStoredSecrets(r.secrets || {}); setDraft({}); setCfgErr(null);
    } catch (e) { setCfgErr(e.message || String(e)); }
  }, [m.id]);

  const loadStatus = useCallback(async () => {
    try { setStatus(await getMeshStatus(m.id)); setStatusErr(null); }
    catch (e) { setStatus(null); setStatusErr(e.message || String(e)); }
  }, [m.id]);

  useEffect(() => { loadConfig(); loadStatus(); }, [loadConfig, loadStatus]);

  const save = async () => {
    setSaving(true); setCfgErr(null); setCfgNote(null);
    try {
      // Empty secret = unchanged (the write-only rule): only non-empty drafts are sent.
      const body = { ...fields };
      for (const [k] of MESH_SECRETS) if (draft[k]) body[k] = draft[k];
      await putMeshConfig(m.id, body);
      setCfgNote('saved.');
      await loadConfig();
      onChanged?.();
    } catch (e) { setCfgErr(e.message || String(e)); }
    finally { setSaving(false); }
  };

  const loadPlan = async () => {
    setBusy(true); setPlanErr(null);
    try {
      const r = await planBuildBootstrap(projectId, m.id);
      const steps = r?.plan || r?.steps || [];
      setPlan(steps.find((s) => s.kind === 'mesh-control-plane') || null);
      setPlanned(true);
    } catch (e) { setPlanErr(e.message || String(e)); setPlanned(true); }
    finally { setBusy(false); }
  };

  const standUp = async (step) => {
    const typed = await showPrompt(
      `Stand up the NetBird control plane on ${m.key}?\n\n`
      + `${step?.action || 'the mesh-profile services in the queenzee\'s own compose project'}\n\n`
      + 'This runs docker compose on the queenzee\'s own host and health-checks the management API. '
      + 'It creates ONLY the control plane — no project network, volume or dev db. '
      + 'The API token and gateway setup key stay yours to set.\n\nType STAND UP to confirm.',
      { okLabel: 'Stand up', variant: 'danger', placeholder: 'STAND UP' });
    if (String(typed || '').trim().toUpperCase() !== 'STAND UP') return;
    setBusy(true); setPlanErr(null);
    try {
      await performBuildBootstrap(projectId, m.id, 'human@console', ['mesh-control-plane']);
      showAlert(`NetBird control plane stand-up requested on ${m.key}. Re-read below; any env a human must still set is in the receipt.`, { variant: 'info' });
      await Promise.all([loadPlan(), loadStatus()]);
      onChanged?.();
    } catch (e) { setPlanErr(e.message || String(e)); }
    finally { setBusy(false); }
  };

  return (
    <div className="mx-meshsections">
      <MeshConfigBody fields={fields} secrets={storedSecrets} draft={draft} busy={saving}
                      setField={(k, v) => setFields((f) => ({ ...f, [k]: v }))}
                      setSecret={(k, v) => setDraft((d) => ({ ...d, [k]: v }))}
                      onSave={save} err={cfgErr} note={cfgNote} />
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
export default function MeshPanel({ m, projectId, onChanged = null }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mx-meshpanel" data-testid={`mx-meshpanel-${m.key}`}>
      <button className="mx-meshbtn" disabled={!projectId} onClick={() => setOpen((o) => !o)}
              data-testid={`mx-mesh-${m.key}`}
              title="Mesh control plane (NetBird): configure the management connection, stand the control plane up (human-gated), and observe management health, peer counts and the mesh-vs-legacy route tally">
        🌐 mesh {open ? '▴' : '▾'}
      </button>
      {open && <MeshSections m={m} projectId={projectId} onChanged={onChanged} />}
    </div>
  );
}
