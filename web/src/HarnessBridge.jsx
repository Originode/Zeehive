import React, { useEffect, useState } from 'react';
import { getHarnesses, getHarnessBridge, saveHarnessBridge, testHarnessBridge } from './api.js';

// Setup surface for a harness's external web-UI bridge (Hermes). A human points Zeehive at a running
// Hermes instance (base_url), toggles the outbound mirror + opt-in inbound replies, and TESTS the
// connection (a real discovery-endpoint probe from the queenzee — the honest "did Hermes answer?").
// Config is applied LIVE (harness.bridge_override) — no land/ship. The HARNESS.yml block is the
// default underneath.
export default function HarnessBridge({ onClose }) {
  const [harnesses, setHarnesses] = useState([]);
  const [key, setKey] = useState(null);
  const [cfg, setCfg] = useState(null);
  const [probe, setProbe] = useState(null);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    getHarnesses().then((hs) => {
      const list = hs.filter((h) => !h.is_law_core);
      setHarnesses(list);
      if (list[0]) setKey(list[0].key);
    }).catch((e) => setErr(e.message));
  }, []);

  useEffect(() => {
    if (!key) return;
    setSaved(false);
    getHarnessBridge(key).then((b) => { setCfg(b.config || {}); setProbe(b.probe || null); }).catch((e) => setErr(e.message));
  }, [key]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const set = (k, v) => { setCfg((c) => ({ ...c, [k]: v })); setSaved(false); };
  const save = async () => {
    setBusy(true); setErr(null);
    try { const b = await saveHarnessBridge(key, cfg); setCfg(b.config); setSaved(true); }
    catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const test = async () => {
    setTesting(true); setErr(null);
    try { setProbe(await testHarnessBridge(key)); }
    catch (e) { setErr(e.message); } finally { setTesting(false); }
  };

  return (
    <div className="disp-overlay" onClick={onClose}>
      <div className="disp" role="dialog" aria-label="Harness web-UI bridge" onClick={(e) => e.stopPropagation()}>
        <div className="disp-head">
          <span className="disp-title">⚙ Harness web-UI bridge</span>
          <button className="disp-x" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="disp-body">
          {harnesses.length > 1 && (
            <div className="disp-field">
              <label className="disp-label">Harness</label>
              <div className="disp-models" role="group">
                {harnesses.map((h) => (
                  <button key={h.key} className={`disp-seg ${key === h.key ? 'on' : ''}`} onClick={() => setKey(h.key)}>{h.label}</button>
                ))}
              </div>
            </div>
          )}

          {!cfg && !err && <div className="disp-note">Loading…</div>}

          {cfg && (
            <>
              <p className="disp-note">
                Hermes is a <b>self-hosted</b> agent with its own web UI — Zeehive doesn’t run it, it connects to it.
                Stand up a Hermes instance, then put its URL here. The harness mirrors each zee’s transcript into a Hermes
                thread (keyed by the xell slug) so you can view the conversation there. This is <b>live config</b> — it
                applies to the next dispatched zee, no land/ship.
              </p>

              <div className="disp-field">
                <label className="disp-label">Hermes base URL</label>
                <input className="disp-input" type="text" placeholder="http://your-hermes-host:port"
                       value={cfg.base_url || ''} onChange={(e) => set('base_url', e.target.value)} />
              </div>

              <div className="disp-field">
                <label className="disp-label">Mirror transcript (outbound)</label>
                <div className="disp-sup" role="group">
                  <button className={`disp-seg ${cfg.enabled ? 'on' : ''}`} onClick={() => set('enabled', true)}>on</button>
                  <button className={`disp-seg ${!cfg.enabled ? 'on' : ''}`} onClick={() => set('enabled', false)}>off</button>
                </div>
              </div>

              <div className="disp-field">
                <label className="disp-label">Inbound replies (from Hermes → the zee)</label>
                <div className="disp-sup" role="group">
                  <button className={`disp-seg ${cfg.inbound ? 'on' : ''}`} onClick={() => set('inbound', true)}>on</button>
                  <button className={`disp-seg ${!cfg.inbound ? 'on' : ''}`} onClick={() => set('inbound', false)}>off</button>
                </div>
                <div className="disp-hint">Opt-in control surface into the cxell — requires <code>HARNESS_BRIDGE_TOKEN</code> set on the server, else it fails closed.</div>
              </div>

              <div className="disp-field">
                <label className="disp-label">Thread URL template</label>
                <input className="disp-input" type="text" placeholder="{base_url}/ui/thread/{session_key}"
                       value={cfg.viewer_url_template || ''} onChange={(e) => set('viewer_url_template', e.target.value)} />
                <div className="disp-hint">Where a zee’s conversation opens in the Hermes web UI. <code>{'{session_key}'}</code> = the xell slug.</div>
              </div>

              <div className="disp-field">
                <label className="disp-label">Test connection</label>
                <div className="disp-testrow">
                  <button className="disp-seg" disabled={testing || !cfg.base_url} onClick={test}>
                    {testing ? 'testing…' : '↻ Test connection'}
                  </button>
                  {probe && (
                    <span className={`bridge-probe ${probe.ok ? 'ok' : 'bad'}`} title={probe.url || ''}>
                      {probe.ok ? '✓ reachable' : `✗ ${probe.detail || 'failed'}`}
                    </span>
                  )}
                </div>
                <div className="disp-hint">Probes the instance’s discovery endpoint for real — this is the honest end-to-end check that Hermes actually answered.</div>
              </div>
            </>
          )}

          {err && <div className="disp-err">{err}</div>}
        </div>
        <div className="disp-foot">
          <button className="disp-cancel" onClick={onClose}>Close</button>
          <button className="disp-submit" disabled={busy || !cfg} onClick={save}>
            {saved ? 'Saved ✓' : busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
