import React, { useState, useCallback, useEffect } from 'react';
import { getLangfuseConfig, getLangfuseStatus, provisionLangfuse, teardownLangfuse,
         getLangfuseTraces, revealLangfuse, getLangfuseProjects, syncLangfuseProjects,
         reinjectLangfuseAutoLogin, healLangfuseWriteMode } from './api.js';
import { showConfirm } from './Dialog.jsx';

// LANGFUSE PANEL — the human surface for the ONE system-wide LLM observability instance
// (project-menu → ⚗ Langfuse). Shows whether the plugin is enabled and what the stack's status
// is, provisions / tears it down (mode-gated server-side: real runs docker compose, simulate
// models the config), offers the web UI link with AUTO SIGN-IN, and reveals the credentials to a
// human on demand. Also drives the custom port / org name and the 1:1 project↔Langfuse mapping.
export default function LangfusePanel({ onClose }) {
  const [cfg, setCfg] = useState(null);
  const [status, setStatus] = useState(null);
  const [traces, setTraces] = useState(null);
  const [projs, setProjs] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [revealed, setRevealed] = useState(null);
  // pre-provision setup knobs
  const [setupPort, setSetupPort] = useState('');
  const [setupOrg, setSetupOrg] = useState('');
  const [setupOrgPub, setSetupOrgPub] = useState('');
  const [setupOrgSec, setSetupOrgSec] = useState('');

  const refresh = useCallback(async () => {
    const [c, s] = await Promise.all([
      getLangfuseConfig().catch((e) => ({ error: e.message })),
      getLangfuseStatus().catch((e) => ({ error: e.message })),
    ]);
    setCfg(c); setStatus(s);
    setSetupPort(c?.host_port ? String(c.host_port) : '3000');
    setSetupOrg(c?.org_name || 'ZeeHive');
  }, []);

  const loadProjects = useCallback(async () => {
    try { setProjs(await getLangfuseProjects()); } catch { /* non-fatal */ }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => { if (cfg?.enabled) loadProjects(); }, [cfg?.enabled, loadProjects]);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const run = async (fn) => {
    setBusy(true); setErr(null);
    try { await fn(); await refresh(); }
    catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const doProvision = () => run(async () => {
    await provisionLangfuse({
      host_port: setupPort ? Number(setupPort) : null,
      org_name: setupOrg || undefined,
      org_public_key: setupOrgPub.trim() || undefined,
      org_secret_key: setupOrgSec.trim() || undefined,
    });
    setTraces(null); setRevealed(null); setProjs(null);
  });

  const doTeardown = () => {
    if (!(cfg?.enabled)) return;
    showConfirm('Tear down Langfuse?\n\nThis STOPS the single system-wide observability instance and removes its data volumes (docker compose down -v). All traces are deleted. A human can re-provision it later — it will start fresh.\n\n(When the queenzee runs in simulate mode, nothing real is touched — the config row is cleared.)', {
      variant: 'danger', okLabel: 'Tear down',
    }).then((ok) => { if (ok) run(async () => { await teardownLangfuse(); setRevealed(null); setTraces(null); setProjs(null); }); });
  };

  const doTraces = () => run(async () => {
    const t = await getLangfuseTraces(20);
    if (t?.ok === false) throw new Error(t.error || t.reason || 'could not read traces');
    setTraces(t.traces || []);
  });

  const doReveal = () => run(async () => {
    const r = await revealLangfuse();
    setRevealed(r);
  });

  const doSync = () => run(async () => {
    const r = await syncLangfuseProjects();
    await loadProjects();
    setRevealed(null);
    setErr(r?.failed?.length
      ? `Synced ${r.created.length} project(s); ${r.failed.length} failed (see queenzee log).`
      : null);
  });

  const doReinject = () => run(async () => {
    const r = await reinjectLangfuseAutoLogin();
    if (r?.ok === false) throw new Error(r.err || 'could not inject the auto-login page');
  });

  const doHeal = () => run(async () => {
    const r = await healLangfuseWriteMode();
    if (r?.ok === false) throw new Error(r.error || r.err || 'could not heal the write mode');
    setTraces(null);
  });

  // Auto sign-in: open a popup at the ZEEHIVE-served signin page. It is same-origin to the console
  // (nginx proxies /api → the queenzee), the server does the ONLY cross-origin fetch (Langfuse
  // CSRF), and the popup's hidden form auto-POSTs the admin credentials — a top-level form POST,
  // the one cross-origin request that carries Lax cookies — so Langfuse's session cookie lands in
  // the browser for the Langfuse origin. Then "Open Langfuse UI" is already signed in.
  const doSignIn = () => {
    window.open('/api/langfuse/signin', 'langfuseAuth', 'width=560,height=700');
  };

  const enabled = !!cfg?.enabled;
  // Health is the LIVE probe (`live`), never the stored `status` column — that column is a
  // provisioning-time field the one-shot background probe writes once and can leave stale after a
  // queenzee restart (measured 2026-08-04: a live, trace-ingesting instance sat at 'provisioning').
  // langfuseStatus() probes live AND reconciles the row on read, so `live` is both current and the
  // row heals; the stored status is only a fallback for when the live verdict is unavailable.
  const liveStatus = status?.live || cfg?.status || 'off';
  const mappedCount = projs?.projects?.filter((p) => p.mapped).length ?? 0;

  return (
    <div className="disp-overlay" onClick={onClose}>
      <div className="disp langfuse" role="dialog" aria-label="Langfuse" onClick={(e) => e.stopPropagation()}>
        <div className="disp-head">
          <span className="disp-title">⚗ Langfuse — one observability instance for the whole system</span>
          <button className="disp-x" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="disp-body" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12, overflowY: 'auto' }}>
          {cfg?.error && <div className="disp-err">{cfg.error}</div>}
          {!cfg?.enabled && !cfg?.error && (
            <div className="disp-note">
              Langfuse is <b>off</b>. It is the self-hosted LLM observability stack (web UI + worker +
              postgres + clickhouse + redis + minio). When enabled, the queenzee injects{' '}
              <code>LANGFUSE_*</code> env into every cxell zee, records a trace of every finished zee
              turn (tokens, cost, session), and lets managers analyze their crew through the public
              API. There is exactly ONE instance for the whole system.
            </div>
          )}

          <div className="disp-field">
            <label className="disp-label">Status</label>
            <div className="disp-sup">
              <span className={`langfuse-status ${liveStatus}`} data-testid="langfuse-status">
                {enabled ? (liveStatus === 'up' ? '● up' : liveStatus === 'provisioning' ? '◌ provisioning' : '○ ' + liveStatus) : '○ off'}
              </span>
              {cfg?.mode === 'simulate' && <span className="disp-hint"> · simulate mode — docker is NOT touched, the config row is modeled</span>}
            </div>
          </div>

          {enabled && (
            <>
              <div className="disp-field">
                <label className="disp-label">Web UI</label>
                <div className="disp-sup">
                  {cfg.ui_url
                    ? <a className="langfuse-ui" href={cfg.ui_url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>Open Langfuse UI →</a>
                    : <span className="disp-hint">(no UI url yet)</span>}
                  {cfg.ui_url && (
                    <a className="langfuse-ui" href={`${cfg.ui_url}/project/zeehive/sessions`} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>View sessions →</a>
                  )}
                  {liveStatus === 'up' && (
                    <button className="disp-cancel" disabled={busy} onClick={doSignIn}>Auto sign-in</button>
                  )}
                </div>
                <div className="disp-hint">Auto sign-in opens a popup on the Langfuse origin that logs you in with the stored admin credentials — no password prompt.</div>
                <button className="disp-cancel" style={{ alignSelf: 'flex-start' }} disabled={busy}
                        title="An instance provisioned before this feature has no auto-login page — inject it into the running container without a full re-provision."
                        onClick={doReinject}>Re-inject auto-login page</button>
                <button className="disp-cancel" style={{ alignSelf: 'flex-start' }} disabled={busy}
                        title="A stack stuck in Langfuse v4 `events_only` migration mode has the traces API disabled (the Recent traces read 404s). This flips it to dual write mode and re-injects the auto-login page — no re-provision, no queenzee restart."
                        onClick={doHeal}>Heal write mode</button>
              </div>

              <div className="disp-field">
                <label className="disp-label">Instance</label>
                <div className="disp-mono">{cfg.docker_ctx || 'default'} · :{cfg.host_port ?? '?'} · {cfg.org_name || 'ZeeHive'} · {cfg.compose_project || ''}</div>
                <div className="disp-hint">queenzee-facing: {cfg.base_url || '—'} · cxell-facing: {cfg.client_base_url || '—'}</div>
              </div>

              <div className="disp-field">
                <label className="disp-label">Trace keys</label>
                <div className="disp-mono">public <code>{cfg.public_key_hint || '—'}</code> · secret <code>{cfg.secret_key_hint || '—'}</code></div>
                <div className="disp-hint">injected into every cxell as LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY / LANGFUSE_BASE_URL</div>
                {revealed && (
                  <div className="langfuse-reveal">
                    <div className="disp-mono">public&nbsp;&nbsp;{revealed.public_key}</div>
                    <div className="disp-mono">secret&nbsp;&nbsp;{revealed.secret_key}</div>
                    {revealed.org_public_key && <div className="disp-mono">org&nbsp;public&nbsp;&nbsp;{revealed.org_public_key}</div>}
                    {revealed.org_secret_key && <div className="disp-mono">org&nbsp;secret&nbsp;&nbsp;{revealed.org_secret_key}</div>}
                    {revealed.admin_email && <div className="disp-mono">admin&nbsp;&nbsp;{revealed.admin_email} / {revealed.admin_password}</div>}
                    {revealed.gateway_url && <div className="disp-mono">gateway {revealed.gateway_url}</div>}
                  </div>
                )}
                {!revealed && (
                  <button className="disp-cancel" style={{ alignSelf: 'flex-start' }} disabled={busy} onClick={doReveal}>Reveal credentials…</button>
                )}
              </div>

              {/* 1:1 project ↔ Langfuse mapping */}
              <div className="disp-field">
                <label className="disp-label">Projects → Langfuse <span className="pc">(1:1 mapping)</span></label>
                {!projs ? <div className="disp-hint">(loading…)</div> : (
                  projs.projects.length === 0
                    ? <div className="disp-hint">No ZEEHIVE projects yet.</div>
                    : <ul className="langfuse-traces" style={{ maxHeight: 160 }}>
                        {projs.projects.map((p) => (
                          <li key={p.project_id} className="disp-mono" data-testid={`lf-map-${p.project_name}`}>
                            <span>{p.mapped ? '✓' : '○'} {p.project_name}
                              {p.mapped && <span className="pc"> → {p.langfuse_project_name} ({p.public_key_hint})</span>}
                            </span>
                            {p.mapped && cfg.ui_url && p.langfuse_project_id && (
                              <a className="pc" href={`${cfg.ui_url}/project/${encodeURIComponent(p.langfuse_project_id)}/sessions`} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>sessions →</a>
                            )}
                          </li>
                        ))}
                      </ul>
                )}
                <div className="disp-hint">
                  {projs?.has_org_keys
                    ? `${mappedCount}/${projs.projects.length} projects mapped — each has its own Langfuse project + key pair, so traces land only in that project's scope.`
                    : 'Not mapping — no org-scoped Langfuse API key was provided at Setup. Re-provision with org keys to enable 1:1 mapping.'}
                </div>
                {projs?.has_org_keys && (
                  <button className="disp-cancel" style={{ alignSelf: 'flex-start' }} disabled={busy} onClick={doSync}>Sync projects</button>
                )}
              </div>

              {traces && (
                <div className="disp-field">
                  <label className="disp-label">Recent traces</label>
                  {traces.length === 0
                    ? <div className="disp-hint">No traces yet — the queenzee records a trace when a zee finishes a turn.</div>
                    : <ul className="langfuse-traces">
                        {traces.slice(0, 10).map((t) => (
                          <li key={t.id} className="disp-mono">
                            <span title={JSON.stringify(t.metadata || {})}>
                              {new Date(t.timestamp).toLocaleString()} · {t.name || '(unnamed)'} ·{' '}
                              {t.sessionId
                                ? <a href={`${cfg.ui_url}/project/zeehive/sessions/${encodeURIComponent(t.sessionId)}`} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>session {t.sessionId.slice(0, 8)} →</a>
                                : 'no session'}
                            </span>
                          </li>
                        ))}
                      </ul>}
                  <div className="disp-hint">A session groups every trace that shares a sessionId — the queenzee emits each turn's session under <code>langfuse.session.id</code>, so all of one zee's turns replay together in the Langfuse Sessions view.</div>
                </div>
              )}

              <div className="disp-foot" style={{ marginTop: 4 }}>
                {!traces && <button className="disp-cancel" disabled={busy} onClick={doTraces}>Read recent traces</button>}
                <span style={{ flex: 1 }} />
                <button className="disp-cancel" disabled={busy} onClick={doTeardown}>Tear down</button>
              </div>
            </>
          )}

          {!enabled && (
            <>
              <div className="disp-field">
                <label className="disp-label">Web port <span className="pc">(custom, optional)</span></label>
                <input className="disp-input" type="number" min="1" max="65535"
                       value={setupPort} onChange={(e) => setSetupPort(e.target.value)} placeholder="3000" />
              </div>
              <div className="disp-field">
                <label className="disp-label">Org name <span className="pc">(custom, optional)</span></label>
                <input className="disp-input" value={setupOrg} onChange={(e) => setSetupOrg(e.target.value)} placeholder="ZeeHive" />
              </div>
              <div className="disp-field">
                <label className="disp-label">Org API keys <span className="pc">(for 1:1 project mapping — optional)</span></label>
                <input className="disp-input" type="password" autoComplete="off" placeholder="org public key (pk-lf-…)"
                       value={setupOrgPub} onChange={(e) => setSetupOrgPub(e.target.value)} />
                <input className="disp-input" type="password" autoComplete="off" placeholder="org secret key (sk-lf-…)"
                       value={setupOrgSec} onChange={(e) => setSetupOrgSec(e.target.value)} />
                <div className="disp-hint">An ORG-scoped Langfuse API key (create one in Langfuse → Settings → API keys) lets the queenzee create one Langfuse project per ZEEHIVE project, so each project's traces land in its own scope. Without it, all traces share the system project.</div>
              </div>
              <div className="disp-foot" style={{ marginTop: 4 }}>
                <button className="disp-cancel" onClick={onClose}>Close</button>
                <span style={{ flex: 1 }} />
                <button className="disp-submit" disabled={busy} onClick={doProvision}>{busy ? 'Provisioning…' : 'Setup Langfuse'}</button>
              </div>
            </>
          )}
          {err && <div className="disp-err">{err}</div>}
        </div>
      </div>
    </div>
  );
}
