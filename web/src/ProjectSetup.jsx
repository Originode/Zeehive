import React, { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import {
  createProject, updateProject, probeRepo, probeRemote, cloneProject, pullProject,
  getReadiness, getSites, createSite, updateSite, deleteSite,
  getPoolConfig, patchPoolConfig, getSharedContainers, createSharedContainer, patchSharedContainer,
  deleteSharedContainer, refreshProjectManifest, draftProjectManifest, getDockerContexts, getRuntimes,
  getMachines, getProviderTokens, addProviderToken, deleteProviderAccount, getReposHome, listFsDirs,
  mountHostFolder, purgeDevXells, subscribeCloneProgress,
} from './api.js';
import { showConfirm } from './Dialog.jsx';

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
// Two sources: an EXISTING folder on disk, or a fresh CLONE from a GitHub URL. Cloning is
// inbound-only — the clone's origin is only ever fetched from (Pull); Zeehive never pushes.
function CreateForm({ onCreated }) {
  const [source, setSource] = useState('folder');   // 'folder' | 'clone'
  const [f, setF] = useState({ name: '', repo_root: '', main_branch: 'main', docker_ctx_dev: '', dev_host_ip: '', docker_ctx_prod: '', prod_host_ip: '' });
  const [c, setC] = useState({ remote_url: '', dest: '', token: '' });
  const [probe, setProbe] = useState(null);
  const [rprobe, setRprobe] = useState(null);       // remote probe (clone mode)
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [prog, setProg] = useState(null);           // live clone progress frame (clone mode)
  // The Folder path resolves on the QUEENZEE's filesystem, not the browser's machine — a
  // containerized queenzee sees /repos (its volume), never the operator's D:\. Ask the server
  // where its repos home is so the hints speak the world the path will actually be checked in.
  const [home, setHome] = useState(null);
  useEffect(() => { getReposHome().then((r) => setHome(r?.repos_dir || null)).catch(() => {}); }, []);
  const homeDir = home ? home.replace(/[\\/]+$/, '') : null;
  // Folder pickers (one per path field) — FsBrowse walks the QUEENZEE's filesystem, where
  // these paths actually resolve. Booleans just toggle the panels.
  const [showBrowse, setShowBrowse] = useState(false);       // Folder (existing-folder mode)
  const [showDestBrowse, setShowDestBrowse] = useState(false); // Clone into (clone mode)
  const pickFolder = (path) => {
    const name = f.name.trim() || path.split(/[\\/]/).filter(Boolean).pop() || '';
    setF((prev) => ({ ...prev, repo_root: path, name: prev.name.trim() ? prev.name : name }));
    setShowBrowse(false);
    probeRepo(path).then(setProbe).catch((e) => setProbe({ ok: false, error: e.message }));
  };
  // Clone-into picks a PARENT directory — the clone lands in a new folder under it, named
  // after the repo (or whatever the human edits the suffix to).
  const pickDest = (path) => {
    const base = f.name.trim() || c.remote_url.trim().split('/').pop()?.replace(/\.git$/i, '') || '';
    setC((prev) => ({ ...prev, dest: `${path.replace(/[\\/]+$/, '')}/${base}` }));
    setShowDestBrowse(false);
  };
  // Mount a folder from the HOST machine (containerized queenzee only): the server registers the
  // bind and RECREATES ITS OWN CONTAINER to take it — the console blips offline for ~10s, then
  // the folder is under /repos. null = collapsed; {host,name} = editing; {done} = restarting.
  const [mount, setMount] = useState(null);
  const [mountBusy, setMountBusy] = useState(false);
  const [mountErr, setMountErr] = useState(null);
  const doMount = async () => {
    setMountBusy(true); setMountErr(null);
    try {
      const r = await mountHostFolder(mount.host.trim(), mount.name.trim() || undefined);
      setF((prev) => ({ ...prev, repo_root: r.target }));
      setMount({ done: r.target });
    } catch (e) { setMountErr(e?.error || e?.message || String(e)); }
    finally { setMountBusy(false); }
  };
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const setc = (k) => (e) => setC({ ...c, [k]: e.target.value });

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

  const runRemoteProbe = async () => {
    const url = c.remote_url.trim();
    if (!url) return;
    try {
      const p = await probeRemote(url, c.token.trim() || undefined);
      setRprobe(p);
      const base = url.split('/').pop()?.replace(/\.git$/i, '') || '';
      setF((prev) => ({
        ...prev,
        name: prev.name || base,
        main_branch: p.default_branch || prev.main_branch,
      }));
      if (p.repos_dir && !c.dest.trim() && base) {
        setC((prev) => ({ ...prev, dest: `${p.repos_dir.replace(/[\\/]+$/, '')}/${base}` }));
      }
    } catch (e) { setRprobe({ reachable: false, error: e.message }); }
  };

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr(null); setProg(null);
    // Listen for the server's clone frames for the duration of THIS request only. Cloning a big
    // repo is minutes of silence otherwise, which reads as a hung dialog.
    const stop = source === 'clone' ? subscribeCloneProgress(setProg) : null;
    try {
      const common = {
        name: f.name.trim(), main_branch: f.main_branch.trim() || 'main',
        docker_ctx_dev: f.docker_ctx_dev.trim() || null, dev_host_ip: f.dev_host_ip.trim() || null,
        docker_ctx_prod: f.docker_ctx_prod.trim() || null, prod_host_ip: f.prod_host_ip.trim() || null,
      };
      const p = source === 'clone'
        ? await cloneProject({ ...common, remote_url: c.remote_url.trim(), dest: c.dest.trim() || null, token: c.token.trim() || null })
        : await createProject({ ...common, repo_root: f.repo_root.trim() });
      onCreated(p);
    } catch (e2) { setErr(e2.message); } finally { stop?.(); setBusy(false); setProg(null); }
  };

  const cloneReady = c.remote_url.trim() && (c.dest.trim() || rprobe?.repos_dir || homeDir);
  return (
    <form className="setup-sec" onSubmit={submit}>
      <h3>Source</h3>
      <div className="setup-row">
        <button type="button" className={source === 'folder' ? '' : 'ghost'} onClick={() => setSource('folder')}>Existing folder</button>
        <button type="button" className={source === 'clone' ? '' : 'ghost'} onClick={() => setSource('clone')}>Clone from GitHub</button>
        {source === 'clone' && <span className="pc">pull-only — Zeehive never pushes to the remote</span>}
      </div>
      <h3>Basics</h3>
      <div className="setup-grid">
        <label>Name<input autoFocus={source === 'folder'} value={f.name} onChange={set('name')} placeholder="MyProject" /></label>
        {source === 'folder' ? (
          <label>Folder <span className="pc">(a path on the queenzee's own filesystem{homeDir ? ` — this instance keeps repos under ${homeDir}` : ''})</span>
            <span className="setup-row">
              <input value={f.repo_root} onChange={set('repo_root')} onBlur={runProbe}
                     placeholder={homeDir ? `${homeDir}/${f.name || 'MyProject'}` : 'D:\\Repos\\MyProject'} />
              <button type="button" className="ghost" data-testid="fs-browse"
                      title="Browse folders on the queenzee's filesystem"
                      onClick={() => setShowBrowse(!showBrowse)}>
                {showBrowse ? '▾ close' : '📁 browse'}
              </button>
            </span>
            {showBrowse && (
              <FsBrowse start={f.repo_root.trim() || homeDir || ''} repoPicks onPick={pickFolder} />
            )}
            {/* Host-folder mount — only meaningful when the queenzee is containerized (homeDir
                set). The server refuses with a clear message on a host-era install anyway. */}
            {homeDir && !showBrowse && (mount?.done ? (
              <span className="pc" data-testid="mount-restarting">
                ⏳ queenzee is restarting to take the mount — when the ● live pill returns, <b>{mount.done}</b> is ready to probe or browse.
              </span>
            ) : mount ? (
              <span className="fsbrowse" data-testid="mount-panel">
                <span className="pc">Mounts a folder from the <b>host machine</b> (the one running docker) into {homeDir}.
                  The queenzee restarts (~10s) to take the bind — zees in their cxells keep running.
                  Heads-up: a hand-run <span className="mono">docker compose up</span> that omits
                  <span className="mono"> /repos/.zeehive-mounts.yml</span> drops UI mounts.</span>
                <span className="setup-row">
                  <input value={mount.host} placeholder="D:\Repos\MyProject  (host path)"
                         onChange={(e) => setMount({ ...mount, host: e.target.value })} />
                  <input value={mount.name} placeholder="name (default: folder name)" style={{ maxWidth: 180 }}
                         onChange={(e) => setMount({ ...mount, name: e.target.value })} />
                  <button type="button" disabled={mountBusy || !mount.host.trim()} data-testid="mount-go"
                          onClick={doMount}>{mountBusy ? 'Mounting…' : '⇅ Mount & restart'}</button>
                  <button type="button" className="ghost" onClick={() => { setMount(null); setMountErr(null); }}>cancel</button>
                </span>
                {mountErr && <span className="projpop-err">{mountErr}</span>}
              </span>
            ) : (
              <button type="button" className="ghost" data-testid="mount-open"
                      onClick={() => setMount({ host: '', name: '' })}>⇅ mount a folder from the host machine…</button>
            ))}
          </label>
        ) : (
          <>
            <label>Repository URL<input autoFocus value={c.remote_url} onChange={setc('remote_url')} onBlur={runRemoteProbe} placeholder="https://github.com/org/repo" /></label>
            <label>Clone into
              <span className="setup-row">
                <input value={c.dest} onChange={setc('dest')} placeholder={(rprobe?.repos_dir || homeDir) ? `${(rprobe?.repos_dir || homeDir).replace(/[\\/]+$/, '')}/${f.name || '…'}` : 'D:\\Repos\\MyProject'} />
                <button type="button" className="ghost" data-testid="fs-browse-dest"
                        title="Browse folders on the queenzee's filesystem — pick the PARENT; the clone makes its own folder"
                        onClick={() => setShowDestBrowse(!showDestBrowse)}>
                  {showDestBrowse ? '▾ close' : '📁 browse'}
                </button>
              </span>
              {showDestBrowse && (
                <FsBrowse start={c.dest.trim().replace(/[\\/][^\\/]*$/, '') || homeDir || ''}
                          pickLabel="✓ clone under this folder" onPick={pickDest} />
              )}
            </label>
            <label>GitHub token <span className="pc">(read-only PAT — private repos only, stored in the meta-DB)</span>
              <input type="password" autoComplete="off" value={c.token} onChange={setc('token')} placeholder="github_pat_… (blank for public)" /></label>
          </>
        )}
        <label>Main branch
          <input list="zh-branches" value={f.main_branch} onChange={set('main_branch')} />
          <datalist id="zh-branches">{(source === 'clone' ? (rprobe?.branches || []) : (probe?.git?.branches || [])).map((b) => <option key={b} value={b} />)}</datalist>
        </label>
      </div>
      {source === 'folder' && probe && <ProbeChips probe={probe} />}
      {source === 'clone' && rprobe && <RemoteChips probe={rprobe} />}
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
      {busy && source === 'clone' && <CloneProgress prog={prog} />}
      <div className="projpop-formbtns">
        <button type="submit" disabled={busy || !f.name.trim() || (source === 'folder' ? !f.repo_root.trim() : !cloneReady)}>
          {busy ? (source === 'clone' ? 'Cloning…' : 'Creating…') : (source === 'clone' ? 'Clone & configure →' : 'Create & configure →')}
        </button>
      </div>
    </form>
  );
}

// Live clone progress. Until the first frame arrives (probe + connect happen before git prints
// anything) the bar is indeterminate rather than a lying 0% — the work has genuinely started, we
// just cannot size it yet. Percentages are whole-clone, not per-phase; see CLONE_PHASES server-side.
function CloneProgress({ prog }) {
  const pending = !prog || prog.overall == null;
  const pct = pending ? 0 : Math.max(0, Math.min(100, prog.overall));
  return (
    <div className="clone-prog">
      <div className={`clone-prog-bar${pending ? ' indeterminate' : ''}`}>
        <div className="clone-prog-fill" style={pending ? undefined : { width: `${pct}%` }} />
      </div>
      <div className="clone-prog-meta">
        <span className="clone-prog-label">{prog?.label || 'starting clone…'}</span>
        {prog?.detail && <span className="pc">{prog.detail}</span>}
        {!pending && <span className="clone-prog-pct">{pct}%</span>}
      </div>
      <span className="pc">a big repo takes a few minutes — full git output streams to the log rail</span>
    </div>
  );
}

// One-level-at-a-time directory browser over the QUEENZEE's filesystem (GET /api/fs/dirs) —
// shared by the Folder field and Clone-into. repoPicks: clicking a ⎇ git-repo row picks it
// outright (existing-folder mode — a repo is the destination); otherwise every row navigates
// and only the header button picks (clone mode — the pick is a PARENT directory).
function FsBrowse({ start, onPick, repoPicks = false, pickLabel = '✓ use this folder' }) {
  const [lvl, setLvl] = useState(null);
  const go = (p) => listFsDirs(p).then(setLvl).catch((e) => setLvl({ ok: false, error: e.message, dirs: [] }));
  useEffect(() => { go(start || ''); }, []);   // opens at the field's current value / repos home
  if (!lvl) return <span className="pc">loading…</span>;
  return (
    <span className="fsbrowse" data-testid="fs-panel">
      <span className="fsb-head">
        <span className="mono fsb-path">{lvl.path || '—'}</span>
        <button type="button" onClick={() => onPick(lvl.path)} disabled={!lvl.ok}>{pickLabel}</button>
      </span>
      {lvl.error && <span className="projpop-err">{lvl.error}</span>}
      <span className="fsb-list">
        {lvl.parent && <button type="button" className="fsb-dir" onClick={() => go(lvl.parent)}>↰ ..</button>}
        {(lvl.dirs || []).map((d) => {
          const full = `${lvl.path.replace(/[\\/]+$/, '')}/${d.name}`;
          return (
            <button type="button" key={d.name} className={`fsb-dir${d.is_repo ? ' repo' : ''}`}
                    title={d.is_repo ? (repoPicks ? 'a git repo — click to pick it' : 'a git repo') : 'click to enter'}
                    onClick={() => (repoPicks && d.is_repo ? onPick(full) : go(full))}>
              {d.is_repo ? '⎇ ' : '▸ '}{d.name}
            </button>
          );
        })}
        {lvl.ok && !(lvl.dirs || []).length && <span className="pc">no subfolders</span>}
      </span>
    </span>
  );
}

// Remote-probe chips (clone mode): reachable / default branch / private-needs-token.
function RemoteChips({ probe }) {
  const chip = (ok, text, warn = false) => (
    <span className={`gate ${ok ? 'g-pass' : warn ? 'g-warn' : 'g-fail'}`}>{ok ? '✓' : warn ? '△' : '✗'} {text}</span>);
  if (!probe.reachable) {
    return (
      <div className="gates">
        {probe.auth_required
          ? chip(false, 'private repo — a read-only token is required', true)
          : chip(false, `unreachable: ${probe.error || 'unknown'}`)}
      </div>
    );
  }
  return (
    <div className="gates">
      {chip(true, 'remote reachable')}
      {probe.default_branch && chip(true, `default branch: ${probe.default_branch}`)}
      {chip(probe.branches?.length > 0, `${probe.branches?.length || 0} branch(es)`)}
    </div>
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

// ── edit: the full surface, split into tabs ────────────────────────────────────
// One modal held six stacked sections — too tall to scan. They group into four tabs by concern;
// the readiness checklist stays PINNED above the tabs (it is the whole-project verdict, and its
// gates point AT the tabs — a red 'shippable' is fixed under Deploy, a missing token under
// Providers). Clicking a gate jumps to the tab that owns it.
const SETUP_TABS = [
  { key: 'project', label: 'Project', gates: ['repo', 'main_branch', 'env', 'manifest'] },
  { key: 'deploy', label: 'Deploy', gates: ['dev_site', 'prod_site', 'shippable'] },
  { key: 'providers', label: 'Providers', gates: [] },
  { key: 'pool', label: 'Pool', gates: ['pool'] },
  { key: 'danger', label: '⚠ Danger', gates: [], danger: true },
];
const tabForGate = (key) => SETUP_TABS.find((t) => t.gates.includes(key))?.key || null;

function EditSections({ project, onChanged, onProject }) {
  const [readiness, setReadiness] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState('project');

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
      {readiness && <Readiness r={readiness} onJump={(key) => { const t = tabForGate(key); if (t) setTab(t); }} />}
      {err && <div className="projpop-err">{err}</div>}
      <div className="setup-tabs" role="tablist">
        {SETUP_TABS.map((t) => (
          <button key={t.key} role="tab" aria-selected={tab === t.key}
                  className={`setup-tab${tab === t.key ? ' on' : ''}${t.danger ? ' danger' : ''}`} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'project' && <>
        <BasicsSection project={project} run={run} onProject={onProject} />
        <ManifestSection project={project} run={run} onProject={onProject} />
      </>}
      {tab === 'deploy' && <>
        <SitesSection project={project} run={run} busy={busy} />
        <InventorySection project={project} run={run} busy={busy} />
      </>}
      {tab === 'providers' && <TokensSection project={project} run={run} busy={busy} />}
      {tab === 'pool' && <SpawnSection project={project} run={run} />}
      {tab === 'danger' && <DangerSection project={project} onChanged={() => { reload(); onChanged?.(); }} />}
    </>
  );
}

// ── Danger zone: irreversible, project-wide actions ────────────────────────────
// Purge every non-production xell + its containers back to bare prod, mid-work and all.
// Two-stage: a spelled-out warning, then type the project name to arm the button — the same
// bar the container decommission uses for a db, because this is that action times N.
function DangerSection({ project, onChanged }) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [err, setErr] = useState(null);
  const armed = typed.trim() === project.name;

  const purge = async () => {
    if (!armed || busy) return;
    setBusy(true); setErr(null); setResult(null);
    try {
      const r = await purgeDevXells(project.id);
      setResult(r);
      setTyped('');
      onChanged?.();
    } catch (e) { setErr(e?.error || e?.message || String(e)); }
    finally { setBusy(false); }
  };

  return (
    <div className="setup-sec danger-sec">
      <h3>⚠ Danger zone <span className="pc">irreversible — production is never touched</span></h3>
      <div className="danger-box" data-testid="danger-purge">
        <div className="danger-title">Purge dev xells &amp; containers</div>
        <div className="pc danger-desc">
          Reaps <b>every non-production xell</b> in <b>{project.name}</b> — removing each one's
          worktree, branch, and per-xell containers — <b>regardless of current work</b>. A zee
          mid-task is killed. The live <b>production</b> stack (its hex, db, server, app) is left
          completely alone. The ready pool refills afterward unless you also lower the pool target.
        </div>
        <label className="danger-arm">To confirm, type the project name <b>{project.name}</b>:
          <input data-testid="danger-type" value={typed} placeholder={project.name}
                 spellCheck={false} autoComplete="off" onChange={(e) => setTyped(e.target.value)}
                 onKeyDown={(e) => { if (e.key === 'Enter') purge(); }} />
        </label>
        {err && <div className="projpop-err" data-testid="danger-err">{err}</div>}
        {result && (
          <div className="danger-result" data-testid="danger-result">
            ✓ purged {result.reaped}/{result.total} dev xell(s){result.failed?.length ? ` — ${result.failed.length} failed` : ''}. Production intact.
          </div>
        )}
        <button className="ctxdanger" data-testid="danger-go" disabled={!armed || busy} onClick={purge}>
          {busy ? 'Purging…' : '🗑 Purge dev xells'}
        </button>
      </div>
    </div>
  );
}

function Readiness({ r, onJump }) {
  // gates are buttons: clicking one jumps to the tab that fixes it, so a red gate is one click
  // from the field that clears it instead of a hunt.
  return (
    <div className="setup-sec">
      <div className="gates">
        {r.gates.map((g) => {
          const target = tabForGate(g.key);
          return (
            <button key={g.key} type="button" className={`gate g-${g.level}${target ? ' gate-jump' : ''}`}
                    title={target ? `${g.detail}\n\n→ ${SETUP_TABS.find((t) => t.key === target).label} tab` : g.detail}
                    onClick={() => target && onJump?.(g.key)}>
              {g.level === 'pass' ? '✓' : g.level === 'warn' ? '△' : '✗'} {g.key}
            </button>
          );
        })}
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
    registry: project.registry || '', remote_url: project.remote_url || '',
  });
  const [pull, setPull] = useState(null);   // last pull outcome {state, reason, commits, busy}
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const save = () => run(async () => {
    const p = await updateProject(project.id, {
      ...f, ship_ref: f.ship_ref.trim() || null, registry: f.registry.trim() || null,
      remote_url: f.remote_url.trim() || null,
    });
    onProject(p);
  });
  // Pull is fetch + fast-forward ONLY; a refusal ({pulled:false, reason}) is an answer, not an
  // error — show the reason where the button is. Zeehive never pushes to the remote.
  const doPull = async () => {
    setPull({ busy: true });
    try {
      const r = await run(() => pullProject(project.id));
      setPull(r);
    } catch (e) { setPull({ state: 'error', reason: e.message }); }
  };
  const pullLabel = !pull ? null
    : pull.busy ? 'pulling…'
    : pull.state === 'up-to-date' ? '✓ up to date'
    : pull.state === 'fast-forwarded' ? `✓ fast-forwarded (${pull.commits} commit${pull.commits === 1 ? '' : 's'})`
    : pull.reason;
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
        <label>GitHub remote <span className="pc">(pull-only fetch source — Zeehive never pushes; Mark pushes by hand)</span>
          <span className="setup-row">
            <input value={f.remote_url} onChange={set('remote_url')} placeholder="https://github.com/org/repo (none)" />
            <button type="button" disabled={!(project.remote_url || '').trim() || pull?.busy}
                    title={`fetch + fast-forward ${project.main_branch} from the remote (refuses on divergence)`}
                    onClick={doPull}>↓ Pull</button>
          </span>
        </label>
      </div>
      {pullLabel && (
        <div className="gates">
          <span className={`gate ${pull.busy ? 'g-warn' : pull.pulled ? 'g-pass' : 'g-warn'}`}>{pullLabel}</span>
        </div>
      )}
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
  const del = async () => {
    const n = Number(site.container_count);
    if (await showConfirm(n > 0 ? `Site "${site.key}" has ${n} container(s). Force-remove?` : `Remove site "${site.key}"?`, { variant: 'danger', okLabel: 'Remove' })) {
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
                onClick={async () => { const n = Number(c.linked_xells); if (await showConfirm(n > 0 ? `${c.name} is linked to ${n} xell(s). Force?` : `Remove ${c.name}?`, { variant: 'danger', okLabel: 'Remove' })) run(() => deleteSharedContainer(c.id, n > 0)); }}>🗑</button>
      </span>
    </div>
  );
}

// ── agent providers: the per-project credential a CXELLD zee runs on ───────────
// Provider ACCOUNTS, stored in the meta-DB. A project can hold several accounts of one provider
// type — e.g. two Claude subscriptions — each with its own label, its own prompt button in the
// header, and its own last-used date. The human does the OAuth: copy the command, run it in a
// terminal, authorize in the browser, paste the token back (plus an optional label naming the
// account). The server only ever returns a masked hint — a connected token cannot be read back.
function TokensSection({ project, run, busy }) {
  const [tokens, setTokens] = useState(null);
  const [open, setOpen] = useState(null);     // provider key whose add-account panel is open
  const [paste, setPaste] = useState('');
  const [label, setLabel] = useState('');
  const [copied, setCopied] = useState(false);
  const load = useCallback(() => getProviderTokens(project.id).then(setTokens).catch(() => {}), [project.id]);
  useEffect(() => { load(); }, [load]);
  const wrapped = (fn) => run(async () => { await fn(); await load(); });

  const copy = async (cmd) => {
    try { await navigator.clipboard.writeText(cmd); setCopied(true); setTimeout(() => setCopied(false), 1500); }
    catch { /* clipboard denied — the command is visible to select anyway */ }
  };
  const save = (p) => wrapped(() => addProviderToken(project.id, p.provider, paste, label))
    .then(() => { setPaste(''); setLabel(''); setOpen(null); });
  const disconnect = async (p, a) => {
    const name = a.label || `${p.label} ${a.token_hint || ''}`;
    if (await showConfirm(`Disconnect the "${name}" account from ${project.name}?\n\nIts prompt button disappears; zees dispatched on it can no longer authenticate.`, { variant: 'danger', okLabel: 'Disconnect' })) {
      wrapped(() => deleteProviderAccount(project.id, a.id));
    }
  };

  return (
    <div className="setup-sec">
      <h3>Agent providers <span className="pc">(the credential a cxell zee spawns with — stored in the meta-DB, never echoed back. Several accounts of one provider are fine: each gets its own prompt button)</span></h3>
      {(tokens || []).map((p) => (
        <div key={p.provider} className="siteed">
          <div className="setup-row">
            <span className="sitekey">{p.label}</span>
            {!p.connected && <span className="gate g-warn">△ not connected</span>}
            <button type="button" className="ghost"
                    onClick={() => { setOpen(open === p.provider ? null : p.provider); setPaste(''); setLabel(''); }}>
              {open === p.provider ? '▾ cancel' : p.connected ? '＋ add another account' : '＋ connect'}
            </button>
          </div>
          {(p.accounts || []).map((a) => (
            <div className="setup-row" key={a.id} data-testid={`token-account-${p.provider}`}>
              <span className="gate g-pass" title={a.created_at ? `connected ${new Date(a.created_at).toLocaleDateString()}` : ''}>
                ✓ {a.label ? <b>{a.label} · </b> : null}<span className="mono">{a.token_hint}</span>
                {a.last_used_at ? ` · used ${new Date(a.last_used_at).toLocaleDateString()}` : ' · never used'}
              </span>
              <button type="button" className="projpop-del" disabled={busy}
                      title={`Disconnect this ${p.label} account`} onClick={() => disconnect(p, a)}>🗑</button>
            </div>
          ))}
          {open === p.provider && (
            <div className="setup-grid" style={{ gridTemplateColumns: '1fr' }}>
              <label>1 · Run this in any terminal
                <span className="setup-row">
                  <input className="mono" readOnly value={p.command} onFocus={(e) => e.target.select()} />
                  <button type="button" onClick={() => copy(p.command)}>{copied ? '✓ copied' : '⧉ copy'}</button>
                </span>
              </label>
              <span className="pc">2 · {p.steps}</span>
              <label>3 · Paste the token{p.connected ? ' (a new account — existing ones stay)' : ''}
                <span className="setup-row">
                  <input type="password" autoComplete="off" value={paste} placeholder="sk-ant-oat01-…"
                         onChange={(e) => setPaste(e.target.value)}
                         onKeyDown={(e) => { if (e.key === 'Enter' && paste.trim()) { e.preventDefault(); save(p); } }} />
                  <input value={label} placeholder="label (optional) — e.g. work / personal"
                         onChange={(e) => setLabel(e.target.value)}
                         onKeyDown={(e) => { if (e.key === 'Enter' && paste.trim()) { e.preventDefault(); save(p); } }} />
                  <button type="button" disabled={busy || !paste.trim()} onClick={() => save(p)}>Save</button>
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
