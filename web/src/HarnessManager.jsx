import React, { useEffect, useState, useCallback } from 'react';
import { getHarnesses, getHarnessFull, createHarness, updateHarness, deleteHarness } from './api.js';

// Author harnesses — the personas an AI assumes as a zee. A harness = personality + skills + memory,
// layered into a zee's briefing beneath the law (the manual + binding rules). Unlimited; the `core`
// law harness is not shown here (it is not editable). This is a DB-owned surface: create/edit/delete
// applies live, no land/ship.
const blank = () => ({ label: '', glyph: '', summary: '', personality: '', parent: null, skills: [], memory: [], enabled: true, file_backed: false });

export default function HarnessManager({ onClose }) {
  const [list, setList] = useState([]);
  const [sel, setSel] = useState(null);       // selected key, or '' for a new (unsaved) harness
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState(null);

  const refresh = useCallback(() => getHarnesses().then((hs) => setList(hs.filter((h) => !h.is_law_core))).catch((e) => setErr(e.message)), []);
  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const open = (key) => {
    setSaved(false); setErr(null);
    getHarnessFull(key).then((h) => { setSel(key); setForm({ ...blank(), ...h }); }).catch((e) => setErr(e.message));
  };
  const startNew = () => { setSel(''); setForm(blank()); setSaved(false); setErr(null); };

  const set = (k, v) => { setForm((f) => ({ ...f, [k]: v })); setSaved(false); };
  const setSkill = (i, k, v) => set('skills', form.skills.map((s, j) => (j === i ? { ...s, [k]: v } : s)));
  const addSkill = () => set('skills', [...form.skills, { name: '', when: '', body: '' }]);
  const rmSkill = (i) => set('skills', form.skills.filter((_, j) => j !== i));
  const setMem = (i, k, v) => set('memory', form.memory.map((m, j) => (j === i ? { ...m, [k]: v } : m)));
  const addMem = () => set('memory', [...form.memory, { path: '', text: '' }]);
  const rmMem = (i) => set('memory', form.memory.filter((_, j) => j !== i));

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      if (sel === '') {
        if (!form.label.trim()) throw new Error('give the harness a name');
        const created = await createHarness({ label: form.label, glyph: form.glyph });
        await updateHarness(created.key, form);
        await refresh(); open(created.key);
      } else {
        const h = await updateHarness(sel, form);
        setForm({ ...blank(), ...h }); await refresh();
      }
      setSaved(true);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const remove = async () => {
    if (sel === '' || !sel) { setSel(null); setForm(null); return; }
    setBusy(true); setErr(null);
    try { await deleteHarness(sel); setSel(null); setForm(null); await refresh(); }
    catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  return (
    <div className="disp-overlay" onClick={onClose}>
      <div className="disp hm" role="dialog" aria-label="Harnesses" onClick={(e) => e.stopPropagation()}>
        <div className="disp-head">
          <span className="disp-title">⚙ Harnesses — personas a zee can wear</span>
          <button className="disp-x" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="hm-body">
          <aside className="hm-list">
            {list.map((h) => (
              <button key={h.key} className={`hm-item ${sel === h.key ? 'on' : ''}`} onClick={() => open(h.key)}>
                <span className="hm-glyph">{h.glyph || (h.label || '?')[0]}</span>
                <span className="hm-name">{h.label}</span>
                <span className="hm-meta">{h.skill_count}★{h.file_backed ? ' · repo' : ''}</span>
              </button>
            ))}
            <button className="hm-new" onClick={startNew}>＋ New harness</button>
          </aside>

          <section className="hm-edit">
            {!form && <div className="disp-note">Select a harness, or create one. A harness is a persona — personality, skills, and memory — that a zee wears when it works a xell. It layers below the law (the manual &amp; your binding rules), never over it.</div>}
            {form && (
              <>
                <div className="hm-row2">
                  <div className="disp-field" style={{ flex: 3 }}>
                    <label className="disp-label">Name</label>
                    <input className="disp-input" value={form.label} onChange={(e) => set('label', e.target.value)} placeholder="e.g. Scribe" />
                  </div>
                  <div className="disp-field" style={{ flex: 1 }}>
                    <label className="disp-label">Badge glyph</label>
                    <input className="disp-input" value={form.glyph || ''} onChange={(e) => set('glyph', e.target.value)} placeholder="✒️" maxLength={4} />
                  </div>
                </div>
                {form.file_backed && <div className="disp-hint">Defined in the repo (harnesses/…). Saving here detaches it to dashboard ownership.</div>}

                <div className="disp-field">
                  <label className="disp-label">Inherits (parent harness)</label>
                  <select className="disp-input" value={form.parent || ''} onChange={(e) => set('parent', e.target.value || null)}>
                    <option value="">— none (root) —</option>
                    {list.filter((h) => h.key !== sel).map((h) => (
                      <option key={h.key} value={h.key}>{h.label}</option>
                    ))}
                  </select>
                  <div className="disp-hint">This harness merges its parent's persona, skills &amp; memory (root → this), then the law applies on top.</div>
                </div>

                <div className="disp-field">
                  <label className="disp-label">Summary</label>
                  <input className="disp-input" value={form.summary || ''} onChange={(e) => set('summary', e.target.value)} placeholder="one line — shown on the badge/picker" />
                </div>

                <div className="disp-field">
                  <label className="disp-label">Personality / voice</label>
                  <textarea className="disp-input hm-ta" rows={4} value={form.personality || ''} onChange={(e) => set('personality', e.target.value)}
                            placeholder="How this persona thinks and writes…" />
                </div>

                <div className="disp-field">
                  <label className="disp-label">Skills ({form.skills.length})</label>
                  {form.skills.map((s, i) => (
                    <div key={i} className="hm-sub">
                      <div className="hm-row2">
                        <input className="disp-input" value={s.name} onChange={(e) => setSkill(i, 'name', e.target.value)} placeholder="skill name" />
                        <button className="hm-del" onClick={() => rmSkill(i)} title="Remove skill">🗑</button>
                      </div>
                      <input className="disp-input" value={s.when} onChange={(e) => setSkill(i, 'when', e.target.value)} placeholder="when to use it" />
                      <textarea className="disp-input hm-ta" rows={2} value={s.body} onChange={(e) => setSkill(i, 'body', e.target.value)} placeholder="the instructions" />
                    </div>
                  ))}
                  <button className="hm-add" onClick={addSkill}>＋ Add skill</button>
                </div>

                <div className="disp-field">
                  <label className="disp-label">Memory ({form.memory.length})</label>
                  {form.memory.map((m, i) => (
                    <div key={i} className="hm-sub">
                      <div className="hm-row2">
                        <input className="disp-input" value={m.path} onChange={(e) => setMem(i, 'path', e.target.value)} placeholder="note name" />
                        <button className="hm-del" onClick={() => rmMem(i)} title="Remove memory">🗑</button>
                      </div>
                      <textarea className="disp-input hm-ta" rows={2} value={m.text} onChange={(e) => setMem(i, 'text', e.target.value)} placeholder="a fact the persona always carries" />
                    </div>
                  ))}
                  <button className="hm-add" onClick={addMem}>＋ Add memory</button>
                </div>

                <div className="disp-field">
                  <label className="disp-label">Enabled</label>
                  <div className="disp-sup">
                    <button className={`disp-seg ${form.enabled ? 'on' : ''}`} onClick={() => set('enabled', true)}>on</button>
                    <button className={`disp-seg ${!form.enabled ? 'on' : ''}`} onClick={() => set('enabled', false)}>off</button>
                  </div>
                </div>
              </>
            )}
            {err && <div className="disp-err">{err}</div>}
          </section>
        </div>
        <div className="disp-foot">
          {form && sel !== '' && <button className="disp-cancel" onClick={remove} disabled={busy}>Delete</button>}
          <span style={{ flex: 1 }} />
          <button className="disp-cancel" onClick={onClose}>Close</button>
          {form && <button className="disp-submit" onClick={save} disabled={busy}>{saved ? 'Saved ✓' : busy ? 'Saving…' : (sel === '' ? 'Create' : 'Save')}</button>}
        </div>
      </div>
    </div>
  );
}
