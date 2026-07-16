import React, { useState, useRef, useEffect } from 'react';
import { getDockerContexts, getSites, createSite, updateSite, deleteSite, updateProject } from './api.js';

// The project switcher: an icon beside the "Project:" label. Click it to select another
// managed project, add a new one, remove one, or edit its deployment settings (which docker
// context / host each tier runs on — the deploy sites of spec §5). This is the only place
// projects and sites are mutated from the UI.
export default function ProjectMenu({ projects, currentId, onSelect, onCreate, onDelete, onChanged }) {
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(null);   // project object being edited
  const [contexts, setContexts] = useState([]);   // docker contexts on this machine (picker feed)
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

  // the context picker feed — fetched once per popup open, so a typo'd context can't be typed in
  useEffect(() => { if (open) getDockerContexts().then(setContexts).catch(() => setContexts([])); }, [open]);

  const close = () => { setOpen(false); setAdding(false); setEditing(null); setErr(null); };

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
      <button className="projmenu-btn" title="Switch, add, edit, or remove a project"
              aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        ⚙
      </button>
      {open && (
        <div className={`projpop${editing ? ' wide' : ''}`} role="menu">
          {/* one shared datalist feeds every context input in this popup */}
          <datalist id="zh-docker-ctxs">
            {contexts.map((c) => (
              <option key={c.name} value={c.name}>{c.description || c.endpoint}</option>
            ))}
          </datalist>
          {editing ? (
            <EditPanel project={editing} busy={busy} onClose={() => setEditing(null)}
                       onChanged={onChanged} />
          ) : (
            <>
              <div className="projpop-h">Projects</div>
              <ul className="projpop-list">
                {projects.map((p) => (
                  <li key={p.id} className={p.id === currentId ? 'sel' : ''}>
                    <button className="projpop-pick" onClick={() => { onSelect(p.id); close(); }} title={p.repo_root}>
                      <span className="dot">{p.id === currentId ? '●' : '○'}</span>
                      <span className="pn">{p.name}</span>
                      <span className="pc">{p.xell_count ?? 0} xell{Number(p.xell_count) === 1 ? '' : 's'}</span>
                    </button>
                    <button className="projpop-del" title={`Edit ${p.name} (deployment, branches)`}
                            disabled={busy} onClick={() => { setEditing(p); setErr(null); }}>✎</button>
                    <button className="projpop-del" title={`Remove ${p.name}`}
                            disabled={busy || projects.length <= 1} onClick={() => remove(p)}>🗑</button>
                  </li>
                ))}
              </ul>
              {err && <div className="projpop-err">{err}</div>}
              {adding
                ? <AddForm busy={busy} onCancel={() => { setAdding(false); setErr(null); }} onSubmit={submitAdd} />
                : <button className="projpop-add" onClick={() => { setAdding(true); setErr(null); }}>＋ Add project</button>}
            </>
          )}
        </div>
      )}
    </span>
  );
}

// A docker-context input backed by the shared datalist: pick a real context, or type one for a
// machine this box hasn't got configured yet. Empty = 'default' (this machine's daemon).
function CtxInput({ value, onChange, placeholder = 'default (this machine)' }) {
  return <input list="zh-docker-ctxs" value={value} placeholder={placeholder}
                onChange={(e) => onChange(e.target.value)} />;
}

function AddForm({ busy, onCancel, onSubmit }) {
  const [name, setName] = useState('');
  const [root, setRoot] = useState('');
  const [branch, setBranch] = useState('main');
  const [devCtx, setDevCtx] = useState('');
  const [devHost, setDevHost] = useState('');
  const [prodCtx, setProdCtx] = useState('');
  const [prodHost, setProdHost] = useState('');
  const submit = (e) => {
    e.preventDefault();
    onSubmit({
      name: name.trim(), repo_root: root.trim(), main_branch: branch.trim() || 'main',
      docker_ctx_dev: devCtx.trim() || null, dev_host_ip: devHost.trim() || null,
      docker_ctx_prod: prodCtx.trim() || null, prod_host_ip: prodHost.trim() || null,
    });
  };
  return (
    <form className="projpop-form" onSubmit={submit}>
      <label>Name<input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="MyProject" /></label>
      <label>Folder<input value={root} onChange={(e) => setRoot(e.target.value)} placeholder="D:\Repos\MyProject" /></label>
      <label>Main branch<input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="main" /></label>
      <div className="projpop-h" style={{ marginTop: 4 }}>Deployment</div>
      <label>Dev docker context<CtxInput value={devCtx} onChange={setDevCtx} /></label>
      <label>Dev host IP<input value={devHost} onChange={(e) => setDevHost(e.target.value)} placeholder="10.1.0.18 (blank = localhost)" /></label>
      <label>Prod docker context <span className="pc">(blank = no prod yet)</span>
        <CtxInput value={prodCtx} onChange={setProdCtx} placeholder="none — add later via ✎" /></label>
      <label>Prod host IP<input value={prodHost} onChange={(e) => setProdHost(e.target.value)} placeholder="10.2.0.16" /></label>
      <div className="projpop-formbtns">
        <button type="button" className="ghost" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="submit" disabled={busy || !name.trim() || !root.trim()}>{busy ? 'Adding…' : 'Add'}</button>
      </div>
    </form>
  );
}

// Per-project settings: a few project fields + the deploy sites (where each tier runs).
// Site edits apply immediately per row; the meta-DB is truth and edits only affect FUTURE
// containers — nothing live is restarted or moved by anything here.
function EditPanel({ project, onClose, onChanged }) {
  const [name, setName] = useState(project.name);
  const [branch, setBranch] = useState(project.main_branch || 'main');
  const [envFile, setEnvFile] = useState(project.env_file || '.env');
  const [sites, setSites] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  const loadSites = () => getSites(project.id).then(setSites).catch((e) => setErr(e.message));
  useEffect(() => { loadSites(); }, [project.id]);

  const run = async (fn) => {
    setBusy(true); setErr(null);
    try { await fn(); await loadSites(); onChanged?.(); }
    catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const saveProject = () => run(() => updateProject(project.id, {
    name: name.trim(), main_branch: branch.trim(), env_file: envFile.trim() || null,
  }));

  return (
    <div className="projpop-form projedit">
      <div className="projpop-h">Edit — {project.name}</div>
      <label>Name<input value={name} onChange={(e) => setName(e.target.value)} /></label>
      <label>Main branch<input value={branch} onChange={(e) => setBranch(e.target.value)} /></label>
      <label>Env file <span className="pc">(relative to the main checkout)</span>
        <input value={envFile} onChange={(e) => setEnvFile(e.target.value)} placeholder=".env" /></label>
      <div className="projpop-formbtns">
        <button type="button" disabled={busy || !name.trim() || !branch.trim()} onClick={saveProject}>
          {busy ? 'Saving…' : 'Save project'}
        </button>
      </div>

      <div className="projpop-h" style={{ marginTop: 6 }}>Deploy sites</div>
      {sites === null
        ? <div className="pc">loading…</div>
        : sites.map((s) => <SiteRow key={s.id} site={s} busy={busy} run={run} />)}
      <AddSiteRow projectId={project.id} busy={busy} run={run} />

      {err && <div className="projpop-err">{err}</div>}
      <div className="projpop-formbtns">
        <button type="button" className="ghost" onClick={onClose} disabled={busy}>Back</button>
      </div>
    </div>
  );
}

function SiteRow({ site, busy, run }) {
  const [ctx, setCtx] = useState(site.docker_ctx || '');
  const [host, setHost] = useState(site.host || '');
  const dirty = ctx !== (site.docker_ctx || '') || host !== (site.host || '');

  const save = () => run(() => updateSite(site.id, { docker_ctx: ctx.trim() || 'default', host: host.trim() || null }));
  const makeDefault = () => run(() => updateSite(site.id, { is_default: true }));
  const del = () => {
    const n = Number(site.container_count);
    const msg = n > 0
      ? `Site "${site.key}" is referenced by ${n} container(s). Force-remove? (Containers keep running; their rows just lose the site link.)`
      : `Remove site "${site.key}"?`;
    if (window.confirm(msg)) run(() => deleteSite(site.id, n > 0));
  };

  return (
    <div className="siterow" data-testid={`site-${site.key}`}>
      <span className={`sitetier t-${site.tier}`}>{site.tier}</span>
      <span className="sitekey" title={site.ingress?.kind ? `ingress: ${site.ingress.kind}` : undefined}>{site.key}</span>
      <CtxInput value={ctx} onChange={setCtx} />
      <input className="sitehost" value={host} placeholder="host IP"
             onChange={(e) => setHost(e.target.value)} />
      <button type="button" className="projpop-del" disabled={busy || !dirty} title="Save this site" onClick={save}>💾</button>
      <button type="button" className="projpop-del" disabled={busy || site.is_default}
              title={site.is_default ? 'this is the default site for its tier' : 'make default for its tier'}
              onClick={makeDefault}>{site.is_default ? '●' : '○'}</button>
      <button type="button" className="projpop-del" disabled={busy} title={`Remove site ${site.key}`} onClick={del}>🗑</button>
    </div>
  );
}

function AddSiteRow({ projectId, busy, run }) {
  const [key, setKey] = useState('');
  const [tier, setTier] = useState('prod');
  const [ctx, setCtx] = useState('');
  const add = () => run(async () => {
    await createSite(projectId, { key: key.trim(), tier, docker_ctx: ctx.trim() || 'default' });
    setKey(''); setCtx('');
  });
  return (
    <div className="siterow addsite">
      <select value={tier} onChange={(e) => setTier(e.target.value)}>
        <option value="dev">dev</option>
        <option value="prod">prod</option>
      </select>
      <input className="sitekey-in" value={key} placeholder="site key (e.g. vps)"
             onChange={(e) => setKey(e.target.value)} />
      <CtxInput value={ctx} onChange={setCtx} />
      <button type="button" className="projpop-del" disabled={busy || !key.trim()} title="Add site" onClick={add}>＋</button>
    </div>
  );
}
