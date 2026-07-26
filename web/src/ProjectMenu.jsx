import React, { useState, useRef, useEffect } from 'react';
import ProjectSetup from './ProjectSetup.jsx';
import HarnessManager from './HarnessManager.jsx';
import { showConfirm } from './Dialog.jsx';

// Two separate controls beside the "Project:" label:
//   ⇄  switch icon → the popup that PICKS / removes / onboards a project (switching only).
//   ⚙  settings cog → opens ProjectSetup for the CURRENT project directly (no popup, no pencil).
// They used to be one ⚙ button whose popup buried "configure" behind a per-row pencil, so reaching
// settings meant cog-then-pencil. Adding/configuring (deploy sites, ingress, container inventory,
// spawn template) still live in the full ProjectSetup modal — a popup can't hold that surface.
export default function ProjectMenu({ projects, currentId, onSelect, onCreate, onDelete, onChanged }) {
  const [open, setOpen] = useState(false);
  const [setup, setSetup] = useState(null);   // false=closed, null-project=create, project=edit
  const [showSetup, setShowSetup] = useState(false);
  const [showHarness, setShowHarness] = useState(false);   // harness web-UI bridge (Hermes) setup
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const ref = useRef(null);

  // close on outside click / Esc (the popup only — the modal manages itself)
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const remove = async (p) => {
    if (!(await showConfirm(`Remove project "${p.name}"?\n\nThis deletes its xells, containers, and config from ZEEHIVE (the actual repo folder is left untouched).`, { variant: 'danger', okLabel: 'Remove' }))) return;
    setBusy(true); setErr(null);
    try {
      await onDelete(p.id, false);
    } catch (e) {
      // offer a force path if it's blocked by live zees
      if (/live zee/.test(e.message) && await showConfirm(`${e.message}.\n\nForce-remove anyway?`, { variant: 'danger', okLabel: 'Force-remove' })) {
        try { await onDelete(p.id, true); } catch (e2) { setErr(e2.message); }
      } else { setErr(e.message); }
    } finally { setBusy(false); }
  };

  const openSetup = (project) => { setSetup(project); setShowSetup(true); setOpen(false); };

  const current = projects.find((p) => p.id === currentId) || null;

  return (
    <span className="projmenu" ref={ref}>
      <button className="projmenu-btn" title="Switch project"
              aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        ⇄
      </button>
      <button className="projmenu-btn" title={current ? `Settings — ${current.name}` : 'Project settings'}
              aria-label="Project settings" disabled={!current} onClick={() => openSetup(current)}>
        ⚙
      </button>
      {open && (
        <div className="projpop" role="menu">
          <div className="projpop-h">Projects</div>
          <ul className="projpop-list">
            {projects.map((p) => (
              <li key={p.id} className={p.id === currentId ? 'sel' : ''}>
                <button className="projpop-pick" onClick={() => { onSelect(p.id); setOpen(false); }} title={p.repo_root}>
                  <span className="dot">{p.id === currentId ? '●' : '○'}</span>
                  <span className="pn">{p.name}</span>
                  <span className="pc">{p.xell_count ?? 0} xell{Number(p.xell_count) === 1 ? '' : 's'}</span>
                </button>
                <button className="projpop-del" title={`Configure ${p.name} (sites, ingress, containers, spawn template)`}
                        disabled={busy} onClick={() => openSetup(p)}>✎</button>
                <button className="projpop-del" title={`Remove ${p.name}`}
                        disabled={busy || projects.length <= 1} onClick={() => remove(p)}>🗑</button>
              </li>
            ))}
          </ul>
          {err && <div className="projpop-err">{err}</div>}
          <button className="projpop-add" onClick={() => openSetup(null)}>＋ Onboard a project</button>
          {/* Harnesses are system-wide (not per-project), so their manager lives here, not in ProjectSetup. */}
          <button className="projpop-add" onClick={() => { setShowHarness(true); setOpen(false); }}>⚙ Harnesses — personas</button>
        </div>
      )}
      {showSetup && (
        <ProjectSetup project={setup} onClose={() => setShowSetup(false)}
                      onChanged={onChanged} onSelect={onSelect} />
      )}
      {showHarness && <HarnessManager onClose={() => setShowHarness(false)} />}
    </span>
  );
}
