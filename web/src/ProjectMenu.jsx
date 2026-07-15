import React, { useState, useRef, useEffect } from 'react';

// The project switcher: an icon beside the "Project:" label. Click it to select another
// managed project, add a new one, or remove one. Read-only dashboard otherwise — this is
// the only place projects are mutated.
export default function ProjectMenu({ projects, currentId, onSelect, onCreate, onDelete }) {
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const ref = useRef(null);

  // close on outside click / Esc
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) close(); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const close = () => { setOpen(false); setAdding(false); setErr(null); };

  const current = projects.find((p) => p.id === currentId);

  const submitAdd = async (body) => {
    setBusy(true); setErr(null);
    try { const p = await onCreate(body); setAdding(false); onSelect(p.id); close(); }
    catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const remove = async (p) => {
    if (!window.confirm(`Remove project "${p.name}"?\n\nThis deletes its xells, containers, and config from ZEEHIVE (the actual repo folder is left untouched).`)) return;
    setBusy(true); setErr(null);
    try {
      await onDelete(p.id, false);
    } catch (e) {
      // offer a force path if it's blocked by live zees
      if (/live zee/.test(e.message) && window.confirm(`${e.message}.\n\nForce-remove anyway?`)) {
        try { await onDelete(p.id, true); } catch (e2) { setErr(e2.message); }
      } else { setErr(e.message); }
    } finally { setBusy(false); }
  };

  return (
    <span className="projmenu" ref={ref}>
      <button className="projmenu-btn" title="Switch, add, or remove a project"
              aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        ⚙
      </button>
      {open && (
        <div className="projpop" role="menu">
          <div className="projpop-h">Projects</div>
          <ul className="projpop-list">
            {projects.map((p) => (
              <li key={p.id} className={p.id === currentId ? 'sel' : ''}>
                <button className="projpop-pick" onClick={() => { onSelect(p.id); close(); }} title={p.repo_root}>
                  <span className="dot">{p.id === currentId ? '●' : '○'}</span>
                  <span className="pn">{p.name}</span>
                  <span className="pc">{p.xell_count ?? 0} xell{Number(p.xell_count) === 1 ? '' : 's'}</span>
                </button>
                <button className="projpop-del" title={`Remove ${p.name}`}
                        disabled={busy || projects.length <= 1} onClick={() => remove(p)}>🗑</button>
              </li>
            ))}
          </ul>
          {err && <div className="projpop-err">{err}</div>}
          {adding
            ? <AddForm busy={busy} onCancel={() => { setAdding(false); setErr(null); }} onSubmit={submitAdd} />
            : <button className="projpop-add" onClick={() => { setAdding(true); setErr(null); }}>＋ Add project</button>}
        </div>
      )}
    </span>
  );
}

function AddForm({ busy, onCancel, onSubmit }) {
  const [name, setName] = useState('');
  const [root, setRoot] = useState('');
  const [branch, setBranch] = useState('main');
  const submit = (e) => {
    e.preventDefault();
    onSubmit({ name: name.trim(), repo_root: root.trim(), main_branch: branch.trim() || 'main' });
  };
  return (
    <form className="projpop-form" onSubmit={submit}>
      <label>Name<input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="MyProject" /></label>
      <label>Folder<input value={root} onChange={(e) => setRoot(e.target.value)} placeholder="D:\Repos\MyProject" /></label>
      <label>Main branch<input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="main" /></label>
      <div className="projpop-formbtns">
        <button type="button" className="ghost" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="submit" disabled={busy || !name.trim() || !root.trim()}>{busy ? 'Adding…' : 'Add'}</button>
      </div>
    </form>
  );
}
