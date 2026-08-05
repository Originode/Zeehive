import React, { useState, useRef, useEffect } from 'react';
import ProjectSetup from './ProjectSetup.jsx';
import HarnessManager from './HarnessManager.jsx';
import LangfusePanel from './LangfusePanel.jsx';
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
  const [showLangfuse, setShowLangfuse] = useState(false); // the one system-wide observability instance
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

  // What is waiting on a human in a project — a pending ship or a held landing. The console is
  // per-project (production panel, landing banner, honeycomb: all the SELECTED project), so an
  // approval waiting in the OTHER project is invisible until you happen to switch to it, while its
  // zee keeps truthfully saying "it is waiting for you". So the switcher carries it: a dot on the
  // button when it is elsewhere, a count on the row.
  const waiting = (p) => (Number(p.ships_waiting) || 0) + (Number(p.landings_waiting) || 0);
  const waitingElsewhere = projects.filter((p) => p.id !== currentId).reduce((n, p) => n + waiting(p), 0);
  const waitLabel = (p) => [
    Number(p.ships_waiting) ? `${p.ships_waiting} ship${p.ships_waiting === 1 ? '' : 's'}` : null,
    Number(p.landings_waiting) ? `${p.landings_waiting} landing${p.landings_waiting === 1 ? '' : 's'}` : null,
  ].filter(Boolean).join(' + ');

  return (
    <span className="projmenu" ref={ref}>
      <button className={`projmenu-btn${waitingElsewhere ? ' waiting' : ''}`}
              title={waitingElsewhere
                ? `Switch project — ${waitingElsewhere} approval(s) waiting on you in ANOTHER project `
                  + '(this page only ever shows the selected one)'
                : 'Switch project'}
              aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        ⇄{waitingElsewhere ? <span className="projmenu-wait" data-testid="projmenu-waiting">{waitingElsewhere}</span> : null}
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
                  {waiting(p) > 0 && (
                    <span className="pw" data-testid="projpop-waiting"
                          title={`${waitLabel(p)} awaiting your approval in ${p.name}`}>
                      ⚠ {waiting(p)}
                    </span>
                  )}
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
          {/* Langfuse is ONE instance for the whole system — same system-wide home. */}
          <button className="projpop-add" onClick={() => { setShowLangfuse(true); setOpen(false); }}>⚗ Langfuse — observability</button>
        </div>
      )}
      {showSetup && (
        <ProjectSetup project={setup} onClose={() => setShowSetup(false)}
                      onChanged={onChanged} onSelect={onSelect} />
      )}
      {showHarness && <HarnessManager onClose={() => setShowHarness(false)} />}
      {showLangfuse && <LangfusePanel onClose={() => setShowLangfuse(false)} />}
    </span>
  );
}
