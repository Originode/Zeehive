import React, { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import {
  createProject, updateProject, probeRepo, getReadiness, getSites, createSite, updateSite, deleteSite,
  getPoolConfig, patchPoolConfig, getSharedContainers, createSharedContainer, patchSharedContainer,
  deleteSharedContainer, refreshProjectManifest, draftProjectManifest, getDockerContexts, getRuntimes,
  getMachines, getProviderTokens, putProviderToken, deleteProviderToken,
} from './api.js';

// PROJECT SETUP — the onboarding surface (spec §7 Phase 2.2 + the console half of everything the
// deploy-topology spec models). One modal, whole story: probe the folder, read/draft the manifest,
// place the tiers on docker contexts (sites + ingress: DNS/tunnel/VPN), name the prod build
// source, inventory the prod containers (a ship needs at least one shippable), set the dev spawn
// template, and watch the readiness gates flip. Create mode collects the minimum then flows
// straight into edit mode for the rest.
const INGRESS_KINDS = [
  { key: 'lan', label: 'LAN', hint: 'reached by host IP:port' },
  { key: 'reverse-proxy', label: 'Reverse proxy', hint: 'caddy/nginx in front, DNS points at the host' },
  { key: 'cloudflare-tunnel', label: 'Cloudflare tunnel', hint: 'cloudflared container; DNS at Cloudflare' },
  { key: 'wireguard', label: 'WireGuard', hint: 'site reached over a VPN mesh address' },
];
const ROLES = ['server', 'webapp', 'db', 'infra'];

export default function ProjectSetup({ project: initial, onClose, onChanged, onSelect }) {
  const [project, setProject] = useState(initial);         // null = create mode
  const [contexts, setContexts] = useState([]);
  useEffect(() => { getDockerContexts().then(setContexts).catch(() => setContexts([])); }, []);

  // Portaled to <body>: rendered in place (inside the header's stacking context, z-index 2) the
  // overlay's z-50 cannot escape its ancestor, and the honeycomb connector SVG (z-index 5, one
  // context up) paints its wires OVER the modal. A portal makes z-50 compete at the root.
  return createPortal(
    <div className="term-overlay" onClick={onClose}>
      <div className="setup" onClick={(e) => e.stopPropagation()}>
        <div className="term-head">
          <span className="term-title">⚙ {project ? `Project setup — ${project.name}` : 'Onboard a project'}</span>
          <button className="term-x" onClick={onClose} title="Close">✕</button>
        </div>
        <div className="setup-body">
          <datalist id="zh-docker-ctxs">
            {contexts.map((c) => <option key={c.name} value={c.name}>{c.description || c.endpoint}</option>)}
          </datalist>
          {project
            ? <EditSections project={project} onChanged={onChanged} onProject={setProject} />
            : <CreateForm onCreated={(p) => { setProject(p); onChanged?.(); onSelect?.(p.id); }} />}
        </div>
      </div>
    </div>,
    document.body
  );
}

// ── create: the minimum to exist, guided by a live probe of the folder ────────
function CreateForm({ onCreated }) {
  const [f, setF] = useState({ name: '', repo_root: '', main_branch: 'main', docker_ctx_dev: '', dev_host_ip: '', docker_ctx_prod: '', prod_host_ip: '' });
  const [probe, setProbe] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  const runProbe = async () => {
    if (!f.repo_root.trim()) return;
    try {
      const p = await probeRepo(f.repo_root.trim());
      setProbe(p);
      if (p.ok && p.git.current_branch && f.main_branch === 'main' && !p.git.branches.includes('main')) {
        setF((prev) => ({ ...prev, main_branch: p.git.current_branch }));
      }
    } catch (e) { setProbe({ ok: false, error: e.message }); }
  };

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const p = await createProject({
        name: f.name.trim(), repo_root: f.repo_root.trim(), main_branch: f.main_branch.trim() || 'main',
        docker_ctx_dev: f.docker_ctx_dev.trim() || null, dev_host_ip: f.dev_host_ip.trim() || null,
        docker_ctx_prod: f.docker_ctx_prod.trim() || null, prod_host_ip: f.prod_host_ip.trim() || null,
      });
      onCreated(p);
    } catch (e2) { setErr(e2.message); } finally { setBusy(false); }
  };

  return (
    <form className="setup-sec" onSubmit={submit}>
      <h3>Basics</h3>
      <div className="setup-grid">
        <label>Name<input autoFocus value={f.name} onChange={set('name')} placeholder="MyProject" /></label>
        <label>Folder<input value={f.repo_root} onChange={set('repo_root')} onBlur={runProbe} placeholder="D:\Repos\MyProject" /></label>
        <label>Main branch
          <input list="zh-branches" value={f.main_branch} onChange={set('main_branch')} />
          <datalist id="zh-branches">{(probe?.git?.branches || []).map((b) => <option key={b} value={b} />)}</datalist>
        </label>
      </div>
      {probe && <ProbeChips probe={probe} />}
      <h3>Deployment</h3>
      <div className="setup-grid">
        <label>Dev docker context<input list="zh-docker-ctxs" value={f.docker_ctx_dev} onChange={set('docker_ctx_dev')} placeholder="default (this machine)" /></label>
        <label>Dev host IP<input value={f.dev_host_ip} onChange={set('dev_host_ip')} placeholder="10.1.0.18" /></label>
        <label>Prod docker context <span className="pc">(blank = add later)</span>
          <input list="zh-docker-ctxs" value={f.docker_ctx_prod} onChange={set('docker_ctx_prod')} placeholder="none yet" /></label>
        <label>Prod host IP<input value={f.prod_host_ip} onChange={set('prod_host_ip')} placeholder="10.2.0.16" /></label>
      </div>
      <p className="pc">The pool starts at 0 — no xells are pre-warmed until the readiness gates pass and you raise it.</p>
      {err && <div className="projpop-err">{err}</div>}
      <div className="projpop-formbtns">
        <button type="submit" disabled={busy || !f.name.trim() || !f.repo_root.trim()}>
          {busy ? 'Creating…' : 'Create & configure →'}
        </button>
      </div>
    </form>
  );
}

function ProbeChips({ probe }) {
  if (!probe.ok) return <div className="projpop-err">{probe.error}</div>;
  const chip = (ok, text, warn = false) => (
    <span className={`gate ${ok ? 'g-pass' : warn ? 'g-warn' : 'g-fail'}`}>{ok ? '✓' : warn ? '△' : '✗'} {text}</span>);
  return (
    <div className="gates">
      {chip(probe.git.is_repo, probe.git.is_repo ? `git (${probe.git.current_branch})` : 'not a git repo')}
      {chip(probe.manifest.found && probe.manifest.valid,
        probe.manifest.found ? (probe.manifest.valid ? probe.manifest.file : `${probe.manifest.file} INVALID`) : 'no zeehive.yml', !probe.manifest.found)}
      {chip(probe.compose_files.length > 0, `${probe.compose_files.length} compose file(s)`, true)}
      {chip(probe.env.has_env, probe.env.has_env ? '.env present' : 'no .env', true)}
      {probe.git.remotes?.length > 0 && chip(true, `remotes: ${probe.git.remotes.map((r) => r.name).join(', ')}`)}
    </div>
  );
}

// ── edit: the full surface ─────────────────────────────────────────────────────
function EditSections({ project, onChanged, onProject }) {
  const [readiness, setReadiness] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(() => { getReadiness(project.id).then(setReadiness).catch(() => {}); }, [project.id]);
  useEffect(() => { reload(); }, [reload]);

  // every mutation goes through run(): apply → refresh the checklist → tell the app
  const run = async (fn) => {
    setBusy(true); setErr(null);
    try { const r = await fn(); reload(); onChanged?.(); return r; }
    catch (e) { setErr(e.message); throw e; }
    finally { setBusy(false); }
  };

  return (
    <>
      {readiness && <Readiness r={readiness} />}
      {err && <div className="projpop-err">{err}</div>}
      <BasicsSection project={project} run={run} onProject={onProject} />
      <ManifestSection project={project} run={run} onProject={onProject} />
      <SitesSection project={project} run={run} busy={busy} />
      <InventorySection project={project} run={run} busy={busy} />
      <SpawnSection project={project} run={run} />
      <TokensSection project={project} run={run} busy={busy} />
    </>
  );
}

function Readiness({ r }) {
  return (
    <div className="setup-sec">
      <div className="gates">
        {r.gates.map((g) => (
          <span key={g.key} className={`gate g-${g.level}`} title={g.detail}>
            {g.level === 'pass' ? '✓' : g.level === 'warn' ? '△' : '✗'} {g.key}
          </span>
        ))}
        <span className={`gate ${r.can_ship ? 'g-pass' : 'g-fail'} gate-ship`}>
          {r.can_ship ? '⛴ can ship' : '⛴ cannot ship yet'}
        </span>
      </div>
    </div>
  );
}

function BasicsSection({ project, run, onProject }) {
  const [f, setF] = useState({
    name: project.name, main_branch: project.main_branch || 'main', env_file: project.env_file || '.env',
    db_name: project.db_name || '', db_user: project.db_user || '', ship_ref: project.ship_ref || '',
    registry: project.registry || '',
  });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const save = () => run(async () => {
    const p = await updateProject(project.id, {
      ...f, ship_ref: f.ship_ref.trim() || null, registry: f.registry.trim() || null,
    });
    onProject(p);
  });
  return (
    <div className="setup-sec">
      <h3>Project</h3>
      <div className="setup-grid">
        <label>Name<input value={f.name} onChange={set('name')} /></label>
        <label>Main branch<input value={f.main_branch} onChange={set('main_branch')} /></label>
        <label>Env file<input value={f.env_file} onChange={set('env_file')} placeholder=".env" /></label>
        <label>App db name<input value={f.db_name} onChange={set('db_name')} placeholder={project.name.toLowerCase()} /></label>
        <label>App db user<input value={f.db_user} onChange={set('db_user')} placeholder="postgres" /></label>
        <label>Prod build source <span className="pc">(blank = local main; e.g. origin/main = fetch + build remote)</span>
          <input value={f.ship_ref} onChange={set('ship_ref')} placeholder={`local ${f.main_branch}`} /></label>
        <label>Build registry <span className="pc">(blank = split builds off; host:port on the LAN, e.g. 10.1.0.18:5000)</span>
          <input value={f.registry} onChange={set('registry')} placeholder="none — compile on the run host" /></label>
      </div>
      <div className="projpop-formbtns"><button type="button" onClick={save}>Save project</button></div>
    </div>
  );
}

function ManifestSection({ project, run, onProject }) {
  const [draft, setDraft] = useState(null);
  const refresh = () => run(async () => { const p = await refreshProjectManifest(project.id); onProject(p); setDraft(null); });
  const makeDraft = () => run(async () => setDraft((await draftProjectManifest(project.id, false)).draft));
  const writeDraft = () => run(async () => { await draftProjectManifest(project.id, true); setDraft(null); });
  return (
    <div className="setup-sec">
      <h3>Manifest <span className="pc">{project.manifest_hash ? `cached @ ${project.manifest_hash}` : 'none cached'}</span></h3>
      <div className="setup-row">
        <button type="button" onClick={refresh}>↻ Refresh from repo</button>
        <button type="button" className="ghost" onClick={makeDraft}>Generate draft</button>
        {draft && <button type="button" onClick={writeDraft}>Write zeehive.yml to repo</button>}
      </div>
      {draft && <textarea className="setup-draft" readOnly value={draft} rows={12} />}
    </div>
  );
}

function SitesSection({ project, run, busy }) {
  const [sites, setSites] = useState(null);
  const [machines, setMachines] = useState([]);
  const [add, setAdd] = useState({ key: '', tier: 'prod', docker_ctx: '', host: '' });
  const load = useCallback(() => getSites(project.id).then(setSites).catch(() => {}), [project.id]);
  useEffect(() => { load(); getMachines().then(setMachines).catch(() => {}); }, [load]);
  const wrapped = (fn) => run(async () => { await fn(); await load(); });
  // Picking a machine fills the site's placement (context + host) from the machine row — a
  // PRODUCTION on a machine a human chose, not a context string typed from memory. The fields
  // stay editable after: the machine is a starting point, not a lock.
  const pickMachine = (key) => {
    const m = machines.find((x) => x.key === key);
    if (!m) return;
    setAdd({ ...add, docker_ctx: m.docker_ctx, host: m.host_ip || '', key: add.key || `${add.tier}-${m.key}` });
  };
  return (
    <div className="setup-sec">
      <h3>Deploy sites <span className="pc">(where each tier runs — and how it's reached: DNS, tunnel, VPN)</span></h3>
      {(sites || []).map((s) => <SiteEditor key={s.id} site={s} run={wrapped} busy={busy} />)}
      <div className="setup-row">
        <select value={add.tier} onChange={(e) => setAdd({ ...add, tier: e.target.value })}>
          <option value="dev">dev</option><option value="prod">prod</option>
        </select>
        {machines.length > 0 && (
          <select value={machines.find((m) => m.docker_ctx === add.docker_ctx)?.key || ''}
                  title="Which machine this site runs on — fills context + host from the machine row"
                  onChange={(e) => pickMachine(e.target.value)}>
            <option value="">machine…</option>
            {machines.map((m) => <option key={m.key} value={m.key}>{m.key}</option>)}
          </select>
        )}
        <input value={add.key} placeholder="site key (e.g. vps)" onChange={(e) => setAdd({ ...add, key: e.target.value })} />
        <input list="zh-docker-ctxs" value={add.docker_ctx} placeholder="docker context" onChange={(e) => setAdd({ ...add, docker_ctx: e.target.value })} />
        <input className="sitehost" value={add.host} placeholder="host IP" onChange={(e) => setAdd({ ...add, host: e.target.value })} />
        <button type="button" disabled={busy || !add.key.trim()}
                onClick={() => wrapped(() => createSite(project.id, {
                  ...add, docker_ctx: add.docker_ctx.trim() || 'default', host: add.host.trim() || null,
                  // the first prod site becomes the default target automatically
                  is_default: add.tier === 'prod' && !(sites || []).some((s) => s.tier === 'prod'),
                })).then(() => setAdd({ key: '', tier: 'prod', docker_ctx: '', host: '' }))}>＋ Add site</button>
      </div>
      {add.tier === 'prod' && (
        <div className="pc" style={{ marginTop: 4 }}>
          Adding a <b>prod</b> site creates its production xell — ships can then target it
          (the approve dialog offers the choice when there is more than one).
        </div>
      )}
    </div>
  );
}

function SiteEditor({ site, run, busy }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({
    docker_ctx: site.docker_ctx || '', host: site.host || '',
    kind: site.ingress?.kind || 'lan', public_url: site.ingress?.public_url || '',
    provider_container: site.ingress?.provider_container || '', notes: site.ingress?.notes || '',
  });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const save = () => run(() => updateSite(site.id, {
    docker_ctx: f.docker_ctx.trim() || 'default', host: f.host.trim() || null,
    ingress: {
      ...(site.ingress || {}), kind: f.kind,
      public_url: f.public_url.trim() || undefined,
      provider_container: f.provider_container.trim() || undefined,
      notes: f.notes.trim() || undefined,
    },
  }));
  const del = () => {
    const n = Number(site.container_count);
    if (window.confirm(n > 0 ? `Site "${site.key}" has ${n} container(s). Force-remove?` : `Remove site "${site.key}"?`)) {
      run(() => deleteSite(site.id, n > 0));
    }
  };
  return (
    <div className="siteed">
      <div className="setup-row">
        <span className={`sitetier t-${site.tier}`}>{site.tier}</span>
        <span className="sitekey">{site.key}{site.is_default ? ' ●' : ''}</span>
        <input list="zh-docker-ctxs" value={f.docker_ctx} onChange={set('docker_ctx')} />
        <input className="sitehost" value={f.host} placeholder="host IP" onChange={set('host')} />
        <button type="button" className="ghost" onClick={() => setOpen(!open)}>{open ? '▾' : '▸'} ingress</button>
        <button type="button" disabled={busy} onClick={save}>Save</button>
        {!site.is_default && <button type="button" className="ghost" disabled={busy}
          onClick={() => run(() => updateSite(site.id, { is_default: true }))}>make default</button>}
        <button type="button" className="projpop-del" disabled={busy} title={`Remove ${site.key}`} onClick={del}>🗑</button>
      </div>
      {open && (
        <div className="setup-grid ingress">
          <label>Reachability
            <select value={f.kind} onChange={set('kind')}>
              {INGRESS_KINDS.map((k) => <option key={k.key} value={k.key}>{k.label} — {k.hint}</option>)}
            </select>
          </label>
          <label>Public URL / DNS<input value={f.public_url} onChange={set('public_url')} placeholder="https://app.example.com" /></label>
          <label>Ingress container <span className="pc">(the tunnel/proxy/wg container, if in docker)</span>
            <input value={f.provider_container} onChange={set('provider_container')} placeholder="cloudflare_tunnel" /></label>
          <label>Notes<input value={f.notes} onChange={set('notes')} placeholder="e.g. WebRTC media needs TURN — doesn't traverse the tunnel" /></label>
        </div>
      )}
    </div>
  );
}

function InventorySection({ project, run, busy }) {
  const [cs, setCs] = useState(null);
  const [add, setAdd] = useState({ name: '', role: 'server', tier: 'prod', build_script: '' });
  const load = useCallback(() => getSharedContainers(project.id).then(setCs).catch(() => {}), [project.id]);
  useEffect(() => { load(); }, [load]);
  const wrapped = (fn) => run(async () => { await fn(); await load(); });
  return (
    <div className="setup-sec">
      <h3>Container inventory <span className="pc">(shared/prod — a ship needs ≥1 prod container with a build script)</span></h3>
      <div className="invhead setup-row"><span>name</span><span>role</span><span>tier · site</span><span>build script (shippable)</span><span /></div>
      {(cs || []).map((c) => <InvRow key={c.id} c={c} run={wrapped} busy={busy} />)}
      <div className="setup-row">
        <input value={add.name} placeholder="myapp_server_prod" onChange={(e) => setAdd({ ...add, name: e.target.value })} />
        <select value={add.role} onChange={(e) => setAdd({ ...add, role: e.target.value })}>{ROLES.map((r) => <option key={r}>{r}</option>)}</select>
        <select value={add.tier} onChange={(e) => setAdd({ ...add, tier: e.target.value })}><option>prod</option><option>dev</option></select>
        <input value={add.build_script} placeholder="build script path (optional)" onChange={(e) => setAdd({ ...add, build_script: e.target.value })} />
        <button type="button" disabled={busy || !add.name.trim()}
                onClick={() => wrapped(() => createSharedContainer(project.id, { ...add, build_script: add.build_script.trim() || null })).then(() => setAdd({ name: '', role: 'server', tier: 'prod', build_script: '' }))}>＋</button>
      </div>
    </div>
  );
}

function InvRow({ c, run, busy }) {
  const [script, setScript] = useState(c.build_script || '');
  const dirty = script !== (c.build_script || '');
  return (
    <div className="setup-row invrow">
      <span className="mono">{c.name}</span>
      <span className="pc">{c.role}</span>
      <span className={`sitetier t-${c.tier === 'prod' ? 'prod' : 'dev'}`}>{c.tier}{c.site_key ? ` · ${c.site_key}` : ''}</span>
      <input value={script} placeholder="not shippable — set a build script" onChange={(e) => setScript(e.target.value)} />
      <span className="setup-row">
        <button type="button" disabled={busy || !dirty} title="Save"
                onClick={() => run(() => patchSharedContainer(c.id, { build_script: script.trim() || null }))}>💾</button>
        <button type="button" className="projpop-del" disabled={busy} title={`Remove ${c.name} from the inventory`}
                onClick={() => { const n = Number(c.linked_xells); if (window.confirm(n > 0 ? `${c.name} is linked to ${n} xell(s). Force?` : `Remove ${c.name}?`)) run(() => deleteSharedContainer(c.id, n > 0)); }}>🗑</button>
      </span>
    </div>
  );
}

// ── agent providers: the per-project credential a CAGED zee runs on ───────────
// One token per provider (only Claude today), stored in the meta-DB. The human does the OAuth:
// copy the command, run it in a terminal, authorize in the browser, paste the token back. The
// server only ever returns a masked hint — a connected token cannot be read back out of the UI.
function TokensSection({ project, run, busy }) {
  const [tokens, setTokens] = useState(null);
  const [open, setOpen] = useState(null);     // provider key whose connect panel is open
  const [paste, setPaste] = useState('');
  const [copied, setCopied] = useState(false);
  const load = useCallback(() => getProviderTokens(project.id).then(setTokens).catch(() => {}), [project.id]);
  useEffect(() => { load(); }, [load]);
  const wrapped = (fn) => run(async () => { await fn(); await load(); });

  const copy = async (cmd) => {
    try { await navigator.clipboard.writeText(cmd); setCopied(true); setTimeout(() => setCopied(false), 1500); }
    catch { /* clipboard denied — the command is visible to select anyway */ }
  };
  const save = (p) => wrapped(() => putProviderToken(project.id, p.provider, paste))
    .then(() => { setPaste(''); setOpen(null); });
  const disconnect = (p) => {
    if (window.confirm(`Disconnect ${p.label} from ${project.name}?\n\nCaged zees for this project won't be able to authenticate until a new token is connected.`)) {
      wrapped(() => deleteProviderToken(project.id, p.provider));
    }
  };

  return (
    <div className="setup-sec">
      <h3>Agent providers <span className="pc">(the credential a caged zee spawns with — stored in the meta-DB, never echoed back)</span></h3>
      {(tokens || []).map((p) => (
        <div key={p.provider} className="siteed">
          <div className="setup-row">
            <span className="sitekey">{p.label}</span>
            {p.connected
              ? <span className="gate g-pass" title={p.created_at ? `connected ${new Date(p.created_at).toLocaleDateString()}` : ''}>
                  ✓ <span className="mono">{p.token_hint}</span>
                  {p.last_used_at ? ` · used ${new Date(p.last_used_at).toLocaleDateString()}` : ' · never used'}
                </span>
              : <span className="gate g-warn">△ not connected</span>}
            <button type="button" className="ghost"
                    onClick={() => { setOpen(open === p.provider ? null : p.provider); setPaste(''); }}>
              {open === p.provider ? '▾ cancel' : p.connected ? '↻ replace token' : '＋ connect'}
            </button>
            {p.connected && (
              <button type="button" className="projpop-del" disabled={busy}
                      title={`Disconnect ${p.label}`} onClick={() => disconnect(p)}>🗑</button>
            )}
          </div>
          {open === p.provider && (
            <div className="setup-grid" style={{ gridTemplateColumns: '1fr' }}>
              <label>1 · Run this in any terminal
                <span className="setup-row">
                  <input className="mono" readOnly value={p.command} onFocus={(e) => e.target.select()} />
                  <button type="button" onClick={() => copy(p.command)}>{copied ? '✓ copied' : '⧉ copy'}</button>
                </span>
              </label>
              <span className="pc">2 · {p.steps}</span>
              <label>3 · Paste the token
                <span className="setup-row">
                  <input type="password" autoComplete="off" value={paste} placeholder="sk-ant-oat01-…"
                         onChange={(e) => setPaste(e.target.value)}
                         onKeyDown={(e) => { if (e.key === 'Enter' && paste.trim()) { e.preventDefault(); save(p); } }} />
                  <button type="button" disabled={busy || !paste.trim()} onClick={() => save(p)}>Save token</button>
                </span>
              </label>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function SpawnSection({ project, run }) {
  const [pc, setPc] = useState(null);
  const [runtimes, setRuntimes] = useState([]);
  const [ctxs, setCtxs] = useState([]);
  useEffect(() => {
    getPoolConfig(project.id).then(setPc).catch(() => {});
    getRuntimes().then(setRuntimes).catch(() => {});
    getDockerContexts().then(setCtxs).catch(() => {});
  }, [project.id]);
  if (!pc) return null;
  const save = (patch) => run(async () => setPc(await patchPoolConfig(project.id, patch)));
  return (
    <div className="setup-sec">
      <h3>Spawn template <span className="pc">(what every new xell gets)</span></h3>
      <div className="setup-grid">
        <label>Pool target <span className="pc">(pre-warmed ready xells)</span>
          <input type="number" min="0" max="10" defaultValue={pc.target_ready}
                 onBlur={(e) => Number(e.target.value) !== pc.target_ready && save({ target_ready: Number(e.target.value) })} /></label>
        <label>Database coupling
          <select value={pc.default_db_coupling} onChange={(e) => save({ default_db_coupling: e.target.value })}>
            <option value="db-shared-dev">shared dev db</option>
            <option value="db-isolated">own db (restored from latest prod dump)</option>
          </select></label>
        <label>Default runtime
          <select value={pc.runtime_key || ''} onChange={(e) => save({ default_runtime_key: e.target.value })}>
            {runtimes.filter((r) => r.enabled !== false).map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
          </select></label>
        <label>Compile on <span className="pc">(build host for new xells{project.registry ? '' : ' — set a Build registry to enable'})</span>
          <select value={pc.default_build_ctx || ''} onChange={(e) => save({ default_build_ctx: e.target.value })}
                  disabled={!project.registry}>
            <option value="">run host (default)</option>
            {ctxs.map((k) => <option key={k.name} value={k.name}>{k.name}</option>)}
          </select></label>
        <label>Refresh interval (sec)
          <input type="number" min="60" defaultValue={pc.refresh_interval_sec}
                 onBlur={(e) => Number(e.target.value) !== pc.refresh_interval_sec && save({ refresh_interval_sec: Number(e.target.value) })} /></label>
      </div>
    </div>
  );
}
