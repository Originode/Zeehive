import React, { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { GIT_BEHAVIOR_OPTIONS, gitBehaviorLabel } from './hive/plusMenu.js';
import {
  createProject, updateProject, probeRepo, probeRemote, cloneProject, pullProject,
  githubAccess, pushProject, pullRequestProject, squashHelps, squashOffer,
  getReadiness, getSites, createSite, updateSite, deleteSite,
  getPoolConfig, patchPoolConfig, getSharedContainers, createSharedContainer, patchSharedContainer,
  deleteSharedContainer, getProjectManifestInfo, refreshProjectManifest,
  buildProjectManifest, writeProjectManifest,
  getComposeOnboardingPlan, applyComposeOnboarding,
  getDockerContexts, getRuntimes, getHarnesses,
  getMachines, getProviderTokens, addProviderToken, deleteProviderAccount,
  pauseProviderAccount, resumeProviderAccount, setProviderAlertAmount, getReposHome, listFsDirs,
  mountHostFolder, purgeDevXells, subscribeCloneProgress, discoverSite, adoptContainers,
  getEnvironments, createEnvironment, updateEnvironment, deleteEnvironment,
  getEnvVars, setEnvVar, deleteEnvVar, importEnv, exportEnv, lintEnv,
  getProjectDocs, createProjectDoc, updateProjectDoc, deleteProjectDoc, getAgentDocTargets,
  previewProjectDoc,
  getProjectConditions, addProjectCondition, updateProjectCondition, deleteProjectCondition,
  dispatchMedic,
  getXourceState, cleanXourceNow, getXourceCleanRequests, decideXourceClean, dismissXourceClean,
  getWireguard, mintWireguardPeer, setWireguardEndpoint,
  getProjectApiKeys, createProjectApiKey, revokeProjectApiKey, deleteProjectApiKey,
  getExtV1Info,
} from './api.js';
import { showConfirm, showAlert, showPrompt } from './Dialog.jsx';

// PROJECT SETUP — the onboarding surface (spec §7 Phase 2.2 + the console half of everything the
// deploy-topology spec models). One modal, whole story: probe the folder, read/draft the manifest,
// place the tiers on docker contexts (sites + ingress: DNS/tunnel/VPN), name the prod build
// source, inventory the prod containers (a ship needs at least one shippable), set the dev spawn
// template, and watch the readiness gates flip. Create mode collects the minimum then flows
// straight into edit mode for the rest.
const INGRESS_KINDS = [
  { key: 'lan', label: 'LAN', hint: 'reached by host:port (IP or DNS)' },
  { key: 'reverse-proxy', label: 'Reverse proxy', hint: 'caddy/nginx in front, DNS points at the host' },
  { key: 'cloudflare-tunnel', label: 'Cloudflare tunnel', hint: 'cloudflared container; DNS at Cloudflare' },
  { key: 'wireguard', label: 'WireGuard', hint: 'site reached over a VPN mesh address' },
];
const ROLES = ['server', 'webapp', 'db', 'infra'];

export default function ProjectSetup({ project: initial, onClose, onChanged, onSelect, nested = null }) {
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
            : <CreateForm onCreated={(p) => { setProject(p); onChanged?.(); onSelect?.(p.id); }} nested={nested} />}
        </div>
      </div>
    </div>,
    document.body
  );
}

// ── create: the minimum to exist, guided by a live probe of the folder ────────
// Two sources: an EXISTING folder on disk, or a fresh CLONE from a GitHub URL. Cloning is
// inbound-only — the clone's origin is only ever fetched from (Pull); Zeehive never pushes.
function CreateForm({ onCreated, nested = null }) {
  const [source, setSource] = useState('folder');   // 'folder' | 'clone'
  const [f, setF] = useState({ name: '', repo_root: '', main_branch: 'main', docker_ctx_dev: '', dev_host_ip: '', docker_ctx_prod: '', prod_host_ip: '' });
  const [c, setC] = useState({ remote_url: '', dest: '', token: '' });
  const [probe, setProbe] = useState(null);
  const [rprobe, setRprobe] = useState(null);       // remote probe (clone mode)
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [prog, setProg] = useState(null);           // live clone progress frame (clone mode)
  // A NESTED project (created inside another project's tree): the folder is confined to the
  // parent's repo_root and the human must say HOW the nested repo joins the parent's git. The
  // choice is FORCED (no blank) and persisted on the project row (migration 232); the server
  // validates the same vocabulary (server/src/lib/projects.js GIT_BEHAVIORS).
  const [gitBehavior, setGitBehavior] = useState('submodule');   // default: a submodule — the honest default
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
    // A NESTED project's folder must sit INSIDE the parent's repo tree — the browse picker already
    // confines to it, but the path field is free text, so say the same thing here: a path that
    // escapes the parent is refused with a sentence, not sent to the server to discover.
    if (nested && nested.parent_repo_root) {
      const target = source === 'clone' ? c.dest.trim() : f.repo_root.trim();
      const root = nested.parent_repo_root.replace(/[\\/]+$/, '');
      if (target && !(target.replace(/[\\/]+$/, '') + '/').startsWith(root + '/')) {
        setBusy(false);
        setErr(`A nested project must live inside ${nested.parent_name || 'the parent'}'s repo — `
          + `“${target}” is outside ${root}. Pick a folder under it.`);
        return;
      }
    }
    // Listen for the server's clone frames for the duration of THIS request only. Cloning a big
    // repo is minutes of silence otherwise, which reads as a hung dialog.
    const stop = source === 'clone' ? subscribeCloneProgress(setProg) : null;
    try {
      const common = {
        name: f.name.trim(), main_branch: f.main_branch.trim() || 'main',
        docker_ctx_dev: f.docker_ctx_dev.trim() || null, dev_host_ip: f.dev_host_ip.trim() || null,
        docker_ctx_prod: f.docker_ctx_prod.trim() || null, prod_host_ip: f.prod_host_ip.trim() || null,
        // a NESTED project carries HOW its repo joins the parent's git; a top-level project leaves
        // it null (the server's createProject defaults the empty string to null).
        ...(nested ? { git_behavior: gitBehavior } : {}),
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
              <FsBrowse start={f.repo_root.trim() || (nested ? nested.parent_repo_root : homeDir) || ''}
                        repoPicks onPick={pickFolder}
                        confineTo={nested ? nested.parent_repo_root : null} />
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
                <FsBrowse start={c.dest.trim().replace(/[\\/][^\\/]*$/, '') || (nested ? nested.parent_repo_root : homeDir) || ''}
                          pickLabel="✓ clone under this folder" onPick={pickDest}
                          confineTo={nested ? nested.parent_repo_root : null} />
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

      {/* NESTED project — created INSIDE another project's tree (a monorepo sub-project). The
          folder is confined to the parent's repo_root (the browse pickers never step above it),
          and the human must say HOW the nested repo joins the parent's git. The choice is FORCED —
          there is no "not sure" — because an ambiguous nested git is a parent that cannot track its
          children. The row persists git_behavior (migration 232), so the nesting is self-describing
          long after this dialog is gone. */}
      {nested && (
        <div className="setup-sec nested-proj" data-testid="nested-project">
          <h3>Nested project <span className="pc">inside {nested.parent_name || 'this project'}</span></h3>
          <p className="pc">
            This project will live INSIDE the parent's repo tree — a sub-project of a monorepo.
            Its folder is confined to{' '}
            <span className="mono">{nested.parent_repo_root || 'the parent repo'}</span>.
          </p>
          <label className="nested-git-label">How does the new repo join the parent's git?</label>
          <div className="nested-git-opts">
            {GIT_BEHAVIOR_OPTIONS.map((o) => (
              <label key={o.value} className={`nested-git-opt${gitBehavior === o.value ? ' sel' : ''}`}
                     data-testid={`git-behavior-${o.value}`}>
                <input type="radio" name="git-behavior" checked={gitBehavior === o.value}
                       onChange={() => setGitBehavior(o.value)} />
                <span className="nested-git-opt-label">{o.label}</span>
                <span className="pc">{o.sub}</span>
              </label>
            ))}
          </div>
          <p className="pc">persisted as <span className="mono">git_behavior = {gitBehaviorLabel(gitBehavior)}</span> on the project row</p>
        </div>
      )}
      <h3>Deployment</h3>
      <div className="setup-grid">
        <label>Dev docker context<input list="zh-docker-ctxs" value={f.docker_ctx_dev} onChange={set('docker_ctx_dev')} placeholder="default (this machine)" /></label>
        <label>Dev host<input value={f.dev_host_ip} onChange={set('dev_host_ip')} placeholder="10.1.0.18 or host.local" /></label>
        <label>Prod docker context <span className="pc">(blank = add later)</span>
          <input list="zh-docker-ctxs" value={f.docker_ctx_prod} onChange={set('docker_ctx_prod')} placeholder="none yet" /></label>
        <label>Prod host<input value={f.prod_host_ip} onChange={set('prod_host_ip')} placeholder="10.2.0.16 or host.local" /></label>
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
// `confineTo` (a NESTED project): the picker never steps ABOVE this directory — the ↰ .. button
// disappears at the confine root — so a sub-project cannot escape its parent's repo tree.
function FsBrowse({ start, onPick, repoPicks = false, pickLabel = '✓ use this folder', confineTo = null }) {
  const [lvl, setLvl] = useState(null);
  const go = (p) => listFsDirs(p).then(setLvl).catch((e) => setLvl({ ok: false, error: e.message, dirs: [] }));
  // Clamp the start INTO the confine root if the caller's value somehow sits above it — a nested
  // project's browser must always open INSIDE the parent's repo tree, never at or above its root.
  useEffect(() => {
    const s = start || '';
    if (confineTo && s && !(s.replace(/[\\/]+$/, '') + '/').startsWith(confineTo.replace(/[\\/]+$/, '') + '/')) {
      go(confineTo);
    } else {
      go(s);
    }
  }, []);   // open once at the field's current value / repos home
  if (!lvl) return <span className="pc">loading…</span>;
  const atConfineRoot = confineTo && lvl.path && lvl.path.replace(/[\\/]+$/, '') === confineTo.replace(/[\\/]+$/, '');
  return (
    <span className="fsbrowse" data-testid="fs-panel">
      <span className="fsb-head">
        <span className="mono fsb-path">{lvl.path || '—'}</span>
        <button type="button" onClick={() => onPick(lvl.path)} disabled={!lvl.ok}>{pickLabel}</button>
      </span>
      {confineTo && <span className="pc fsb-confine">confined to <b>{confineTo}</b> — a nested project cannot escape its parent's repo</span>}
      {lvl.error && <span className="projpop-err">{lvl.error}</span>}
      <span className="fsb-list">
        {lvl.parent && !atConfineRoot &&
          <button type="button" className="fsb-dir" onClick={() => go(lvl.parent)}>↰ ..</button>}
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
  { key: 'project', label: 'Project', gates: ['repo', 'main_branch', 'env', 'manifest', 'compose_onboarding'] },
  { key: 'deploy', label: 'Deploy', gates: ['dev_site', 'prod_site', 'shippable'] },
  { key: 'docs', label: 'Docs', gates: [] },
  { key: 'conditions', label: 'Conditions', gates: [] },
  { key: 'env', label: 'Environments', gates: [] },
  { key: 'providers', label: 'Providers', gates: [] },
  { key: 'ticketapi', label: 'Ticket API', gates: [] },
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
        <DeployTree project={project} run={run} busy={busy} />
        <WireguardSection project={project} run={run} busy={busy} />
      </>}
      {tab === 'docs' && <ProjectDocsSection project={project} run={run} busy={busy} />}
      {tab === 'conditions' && <ConditionsSection project={project} run={run} busy={busy} />}
      {tab === 'env' && <EnvironmentsSection project={project} run={run} busy={busy} />}
      {tab === 'providers' && <TokensSection project={project} run={run} busy={busy} />}
      {tab === 'ticketapi' && <ApiKeysSection project={project} run={run} busy={busy} />}
      {tab === 'pool' && <SpawnSection project={project} run={run} />}
      {tab === 'danger' && <>
        <XourceSection project={project} onChanged={() => { reload(); onChanged?.(); }} />
        <DangerSection project={project} onChanged={() => { reload(); onChanged?.(); }} />
      </>}
    </>
  );
}

// ── Xource (main checkout) — the one tree every landing and ship builds from ──
// When it gets MANGLED — a mid-deploy interruption, a conflict a sync left behind — a dirty or
// conflicted checkout blocks EVERY landing (the gate refuses to push over it) and every ship (the
// build runs from it), and the whole project wedges. This section shows the live state and gives
// the human the two doors onto the fix:
//   * "Clean up xource" — the queenzee resets the checkout to the main tip (aborting any
//     in-progress merge/rebase/cherry-pick/revert, preserving every xell's worktree).
//   * a MANAGER's `zee xource-clean` requests, decided here (approve → the queenzee cleans).
// Both are destructive (uncommitted work in the main checkout is discarded) and both go through a
// typed-word confirmation, like the purge below.
function XourceSection({ project, onChanged }) {
  const [state, setState] = useState(null);
  const [requests, setRequests] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [result, setResult] = useState(null);
  const load = useCallback(() => {
    getXourceState(project.id).then(setState).catch(() => {});
    getXourceCleanRequests(project.id).then(setRequests).catch(() => {});
  }, [project.id]);
  useEffect(() => { load(); }, [load]);

  const clean = async () => {
    if (busy) return;
    // A typed word, not a click — this discards whatever uncommitted work is sitting in the main
    // checkout. The same bar the purge uses, because this is that act narrowed to one tree.
    const typed = await showPrompt(
      `Clean up ${project.name}'s xource (the main checkout)?\n\n`
      + 'The queenzee will reset it to the main tip: abort any in-progress merge/rebase/cherry-pick, '
      + 'discard uncommitted changes, and remove untracked junk — PRESERVING every xell\'s worktree. '
      + 'This is what unblocks landings and ships when the checkout is mangled.\n\nType CLEAN to confirm.',
      { title: 'Clean up xource?', okLabel: 'Clean up xource', variant: 'danger', placeholder: 'CLEAN' });
    if (String(typed || '').trim().toUpperCase() !== 'CLEAN') return;
    setBusy(true); setErr(null); setResult(null);
    try {
      const r = await cleanXourceNow(project.id, 'human@console requested cleanup');
      setResult(r);
      load();
      onChanged?.();
    } catch (e) { setErr(e?.error || e?.message || String(e)); }
    finally { setBusy(false); }
  };

  const decide = async (req, decision) => {
    if (busy) return;
    if (decision === 'approve') {
      const typed = await showPrompt(
        `Approve ${req.live_xell_slug || 'a manager'}'s request to clean up the xource?\n\n`
        + 'The queenzee will reset the main checkout to the main tip (aborting merges, discarding '
        + 'uncommitted changes, preserving xell worktrees) — unblocking the landings/ships it was '
        + 'wedging.\n\nType APPROVE to confirm.',
        { title: 'Clean up xource?', okLabel: 'Approve & clean', variant: 'danger', placeholder: 'APPROVE' });
      if (String(typed || '').trim().toUpperCase() !== 'APPROVE') return;
    }
    setBusy(true); setErr(null);
    try { await decideXourceClean(req.id, decision); load(); onChanged?.(); }
    catch (e) { setErr(e?.error || e?.message || String(e)); }
    finally { setBusy(false); }
  };

  const pending = requests.filter((r) => r.status === 'pending');
  const receipts = requests.filter((r) => r.status !== 'pending');
  return (
    <div className="setup-sec danger-sec" data-testid="xource-section">
      <h3>Xource — the main checkout <span className="pc">every landing and ship builds from this one tree</span></h3>
      {state && (
        <div className="gates">
          {state.ok ? (
            state.clean
              ? <span className="gate g-pass">✓ xource clean — {state.branch} is level and untouched</span>
              : <span className="gate g-fail">✗ xource MANGLED — {state.summary}</span>
          ) : <span className="gate g-warn">△ cannot read the xource: {state.error}</span>}
          {!state.ok && <span className="pc">{state.error}</span>}
          {state.ok && !state.clean && (
            <span className="pc">
              This is blocking landings and ships. Cleaning resets the checkout to the main tip —
              uncommitted work in the main checkout is discarded (xell worktrees are preserved).
            </span>
          )}
        </div>
      )}
      <div className="danger-box" data-testid="xource-clean">
        <div className="danger-title">Clean up the xource</div>
        <div className="pc danger-desc">
          Aborts any in-progress merge/rebase/cherry-pick/revert, resets the index and working tree to
          the main tip, and removes untracked junk. <b>Preserves every xell's worktree</b> under
          <span className="mono"> .claude/worktrees/</span>. Discards uncommitted changes in the main
          checkout. Production is never touched.
        </div>
        {err && <div className="projpop-err">{err}</div>}
        {result && (
          <div className="danger-result" data-testid="xource-clean-result">
            {result.ok || result.dry_run
              ? <>✓ xource cleaned{result.dry_run ? ' (DRY-RUN — this queenzee models the fleet)' : ''}</>
              : <>✗ xource still not clean — {result.error || result.result?.error || 'see the queenzee log'}</>}
            {Array.isArray(result.result?.steps) && result.result.steps.length > 0 && (
              <ul className="pc" style={{ margin: '4px 0 0 16px' }}>
                {result.result.steps.map((s, i) => <li key={i}>{s}</li>)}
              </ul>
            )}
          </div>
        )}
        <button className="ctxdanger" data-testid="xource-clean-go" disabled={busy || !state?.ok || state?.clean}
                title={state?.clean ? 'the xource is already clean' : 'reset the main checkout to the main tip'}
                onClick={clean}>
          {busy ? 'Cleaning…' : '🧹 Clean up xource'}
        </button>
      </div>

      {(pending.length > 0 || receipts.length > 0) && (
        <div className="danger-box" style={{ marginTop: 10 }} data-testid="xource-requests">
          <div className="danger-title">
            {pending.length
              ? `⚠ ${pending.length} manager request${pending.length === 1 ? '' : 's'} to clean the xource`
              : '✓ xource-clean requests'}
          </div>
          {(pending.length === 0 && receipts.length > 0) && (
            <div className="pc danger-desc">No open requests — recently-decided ones are shown as receipts.</div>
          )}
          {[...pending, ...receipts].map((r) => (
            <div className="siteed" key={r.id} data-testid={`xource-request-${r.status}`}>
              <div className="setup-row">
                <span className={`sitetier t-${r.status === 'pending' ? 'prod' : 'dev'}`}>{r.status}</span>
                <span className="sitekey">{r.live_xell_slug || 'human'}</span>
                <span className="pc">{new Date(r.requested_at).toLocaleString()}</span>
                {r.decided_by && <span className="pc">· {r.status} by {r.decided_by}</span>}
                {r.status !== 'pending' && (
                  <button className="projpop-del" title="Hide this receipt"
                          onClick={() => dismissXourceClean(r.id).then(load)}>✕</button>
                )}
              </div>
              {r.reason && <div className="prod-ask-reason">“{r.reason}”</div>}
              {r.status === 'pending' && (
                <div className="land-actions">
                  <button className="land-reject" disabled={busy} onClick={() => decide(r, 'reject')}>Reject</button>
                  <button className="land-approve" disabled={busy}
                          title="The queenzee resets the main checkout to the main tip (aborting merges, preserving xell worktrees)"
                          onClick={() => decide(r, 'approve')}>{busy ? '…' : 'Approve & clean'}</button>
                </div>
              )}
              {r.status === 'failed' && <div className="land-err">{r.result?.error || 'cleanup failed'}</div>}
              {r.status === 'completed' && r.result?.dry_run && (
                <div className="pc">DRY-RUN — this queenzee models the fleet; the real xource was not touched.</div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
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
  const [out, setOut] = useState(null);      // last push/PR outcome (shares the status pill)
  const [access, setAccess] = useState(null); // {can_push, can_pr, reason} — gates the outbound buttons
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  // Ask the server whether the stored GitHub PAT actually carries write access. Only then do the
  // Push / PR buttons appear — a read-only (pull-only) token never sees them. Re-probe when the
  // recorded remote changes.
  useEffect(() => {
    let live = true;
    if (!(project.remote_url || '').trim()) { setAccess(null); return; }
    githubAccess(project.id).then((a) => { if (live) setAccess(a); }).catch(() => { if (live) setAccess(null); });
    return () => { live = false; };
  }, [project.id, project.remote_url]);
  const save = () => run(async () => {
    const p = await updateProject(project.id, {
      ...f, ship_ref: f.ship_ref.trim() || null, registry: f.registry.trim() || null,
      remote_url: f.remote_url.trim() || null,
    });
    onProject(p);
  });
  // Pull is fetch + fast-forward ONLY; a refusal ({pulled:false, reason}) is an answer, not an
  // error — show the reason where the button is.
  const doPull = async () => {
    setOut(null); setPull({ busy: true });
    try {
      const r = await run(() => pullProject(project.id));
      setPull(r);
    } catch (e) { setPull({ state: 'error', reason: e.message }); }
  };
  // Push is OUTBOUND and human-gated: confirm first, then local main → the remote (ff-only). A
  // refusal ({pushed:false, reason}) shows in the same status pill.
  const doPush = async () => {
    if (!(await showConfirm(
      `Push local ${project.main_branch} of ${project.name} to the GitHub remote?\n\n`
      + `${project.remote_url}\n\nThis publishes your local history to the remote (fast-forward only — a `
      + `diverged remote is refused, never force-pushed).`
      // the ruleset pre-flight (access.push_rule_block): GitHub will refuse this push by RULE, and
      // it is worth saying so BEFORE the click rather than after the GH013 comes back
      + (access?.push_rule_block ? `\n\n⚠ ${access.push_rule_block}.` : ''),
      { title: 'Push to remote?', okLabel: 'Push' }))) return;
    setPull(null); setOut({ busy: true, kind: 'push' });
    try {
      const r = await run(() => pushProject(project.id));
      setOut({ ...r, kind: 'push' });
    } catch (e) { setOut({ kind: 'push', reason: e.message }); }
  };
  // PR is OUTBOUND and human-gated: prompt for a branch name, then push a side branch + open a PR.
  // With merge=true it goes one step further and MERGES the PR on GitHub (pull-request AND merge) —
  // a refused merge (branch protection, checks pending) still leaves the PR open to finish by hand.
  const doPR = async (merge = false) => {
    const headBranch = await showPrompt(
      `${merge ? 'Open a pull request and MERGE it' : 'Open a pull request'} from local ${project.main_branch} of ${project.name}.\n\n`
      + `A side branch is pushed to the remote and a PR is opened against ${access?.default_branch || 'the default branch'}`
      + `${merge ? ', then merged into it on GitHub' : ''}. `
      + `Name the head branch (leave as-is for a generated name):`,
      { title: merge ? 'Open a pull request and merge?' : 'Open a pull request?',
        defaultValue: `zeehive/${project.main_branch}`, okLabel: merge ? 'Open & merge' : 'Open PR' });
    if (headBranch === null) return;   // cancelled
    setPull(null); setOut({ busy: true, kind: 'pr', merge });
    try {
      const opts = { headBranch: headBranch.trim() || undefined, merge };
      let r = await run(() => pullRequestProject(project.id, opts));
      // A rule that scans the COMMITS (push protection, file size, signatures…) is not fixed by a
      // clean tip, so offer the one remedy that does not need a bypass or a history rewrite — and
      // only for the rules it can actually help with (see squashHelps).
      if (squashHelps(r)) {
        setOut({ ...r, kind: 'pr', merge });
        if (await showConfirm(squashOffer(r, project.main_branch),
          { title: 'Open the PR from a squashed snapshot?', okLabel: 'Open squashed PR' })) {
          setOut({ busy: true, kind: 'pr', merge });
          r = await run(() => pullRequestProject(project.id, { ...opts, squash: true }));
        }
      }
      setOut({ ...r, kind: 'pr', merge });
    } catch (e) { setOut({ kind: 'pr', merge, reason: e.message }); }
  };
  const pullLabel = !pull ? null
    : pull.busy ? 'pulling…'
    : pull.state === 'up-to-date' ? '✓ up to date'
    : pull.state === 'fast-forwarded' ? `✓ fast-forwarded (${pull.commits} commit${pull.commits === 1 ? '' : 's'})`
    : pull.reason;
  const prLabel = (o) => {
    if (!o.opened) return o.reason || 'PR refused';
    const opened = `✓ PR ${o.state === 'existing' ? 'already open' : 'opened'}${o.number ? ` #${o.number}` : ''}`;
    if (!o.merge) return `${opened}${o.url ? ' — open on GitHub ↗' : ''}`;
    // pull-request AND merge: report the merge outcome, but a refused merge still opened a PR.
    return o.merge?.merged
      ? `✓ PR #${o.number} merged → ${o.base}${o.merge.sha ? ` (${o.merge.sha.slice(0, 8)})` : ''}`
      : `${opened} — merge refused: ${o.merge?.reason || 'not mergeable'}${o.url ? ' (finish on GitHub ↗)' : ''}`;
  };
  const outLabel = !out ? null
    : out.busy ? (out.kind === 'push' ? 'pushing…' : out.merge ? 'opening & merging PR…' : 'opening PR…')
    : out.kind === 'push'
      ? (out.pushed ? (out.state === 'up-to-date' ? '✓ remote already up to date' : `✓ pushed ${project.main_branch} → remote`) : (out.reason || 'push refused'))
      : prLabel(out);
  // Green only when fully done: an opened-but-not-merged "PR & merge" is a partial success (warn).
  const outOk = out && (out.pushed || (out.opened && (!out.merge || out.merge?.merged)));
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
        <label>GitHub remote <span className="pc">{access?.can_push
            ? '(write access — Pull, or Push / open a PR; every outbound action is confirmed)'
            : '(pull-only fetch source — connect a write-scoped PAT to enable Push / PR)'}</span>
          <span className="setup-row">
            <input value={f.remote_url} onChange={set('remote_url')} placeholder="https://github.com/org/repo (none)" />
            <button type="button" disabled={!(project.remote_url || '').trim() || pull?.busy || out?.busy}
                    title={`fetch + fast-forward ${project.main_branch} from the remote (refuses on divergence)`}
                    onClick={doPull}>↓ Pull</button>
            {access?.can_push && (
              <button type="button" disabled={pull?.busy || out?.busy}
                      title={access?.push_rule_block
                        ? `⚠ ${access.push_rule_block}`
                        : `push local ${project.main_branch} to the remote (fast-forward only) — you'll be asked to confirm`}
                      onClick={doPush}>↑ Push</button>
            )}
            {access?.can_pr && (
              <button type="button" className="ghost" disabled={pull?.busy || out?.busy}
                      title={`push a side branch off local ${project.main_branch} and open a pull request — you'll be asked to confirm`}
                      onClick={() => doPR(false)}>⇅ PR</button>
            )}
            {access?.can_pr && (
              <button type="button" className="ghost" disabled={pull?.busy || out?.busy}
                      title={`open a pull request off local ${project.main_branch} AND merge it into ${access?.default_branch || 'the default branch'} on GitHub — you'll be asked to confirm`}
                      onClick={() => doPR(true)}>⇅ PR &amp; merge</button>
            )}
          </span>
        </label>
      </div>
      {(pullLabel || outLabel || access?.push_rule_block) && (
        <div className="gates">
          {/* the ruleset pre-flight, standing even before anything has been clicked: a repo whose
              rules require a PR will refuse ↑ Push every time, and the console should say which
              button can actually work. The full sentence is in the title (the pill truncates). */}
          {access?.push_rule_block && !out?.busy && (
            <span className="gate g-warn" title={access.push_rule_block}>⚠ ruleset: use PR, not Push</span>
          )}
          {pullLabel && <span className={`gate ${pull.busy ? 'g-warn' : pull.pulled ? 'g-pass' : 'g-warn'}`} title={pull.reason || pullLabel}>{pullLabel}</span>}
          {outLabel && (out?.url && outOk
            ? <a className="gate g-pass" href={out.url} target="_blank" rel="noreferrer" title={outLabel}>{outLabel}</a>
            : <span className={`gate ${out.busy ? 'g-warn' : outOk ? 'g-pass' : 'g-warn'}`} title={out?.reason || outLabel}>{outLabel}</span>)}
        </div>
      )}
      <div className="projpop-formbtns"><button type="button" onClick={save}>Save project</button></div>
    </div>
  );
}

function ManifestSection({ project, run, onProject }) {
  // GET /manifest — { stored, repo, drift } — is the "is there a manifest in the repo" truth.
  const [info, setInfo] = useState(null);
  // Wizard data: the compose-file scan (file list + tier/role guesses) that pre-fills the form.
  const [suggest, setSuggest] = useState(null);
  const [knobs, setKnobs] = useState(() => emptyManifestKnobs(project));
  // The untouched form, captured once, so the compose-scan pre-fill can't clobber a human who
  // already started typing by the time the scan comes back.
  const untouchedKnobs = useRef(null);
  if (untouchedKnobs.current === null) untouchedKnobs.current = emptyManifestKnobs(project);
  const [step, setStep] = useState('idle');       // idle | knobs | preview (wizard states)
  const [editableYaml, setEditableYaml] = useState('');
  const [minimalManifest, setMinimalManifest] = useState(false); // preview has no tiers/roles
  const [localBusy, setLocalBusy] = useState(false);
  const [wizardErr, setWizardErr] = useState(null);
  const [statusMsg, setStatusMsg] = useState(null);
  const [plan, setPlan] = useState(null);
  const [writeYml, setWriteYml] = useState(true);
  const [applyMeta, setApplyMeta] = useState(true);
  const [planErr, setPlanErr] = useState(null);
  // 'create' = no manifest yet; 'regenerate' = an INVALID manifest is being rebuilt (write
  // passes overwrite:true). The wizard itself is identical; only the intro + write differ.
  const [mode, setMode] = useState('create');

  const loadInfo = useCallback(() => {
    getProjectManifestInfo(project.id).then(setInfo).catch(() => {});
  }, [project.id]);
  useEffect(() => { loadInfo(); }, [loadInfo]);

  const repo = info?.repo;
  const repoFound = repo?.found === true;
  const repoValid = repoFound && !(repo.errors || []).length;
  const regenerating = mode === 'regenerate';

  // Seed the wizard's compose-file scan once, so the form can offer detected files and
  // role guesses. Only meaningful when there's no manifest yet (the wizard is hidden otherwise).
  const loadSuggest = useCallback(() => {
    buildProjectManifest(project.id, {}).then((r) => {
      if (!r?.suggestions) return;
      setSuggest(r.suggestions);
      // Pre-fill from the scan ONLY if the human hasn't typed anything yet.
      setKnobs((k) => (JSON.stringify(k) === JSON.stringify(untouchedKnobs.current)
        ? { ...k, ...knobsFromSuggestions(r.suggestions, project) }
        : k));
    }).catch(() => {});
  }, [project.id, project]);
  useEffect(() => {
    if (info && !repoValid) loadSuggest();
  }, [info, repoValid, loadSuggest]);

  // Wrap a wizard mutation: local busy for button disabling, surface errors inline (the parent
  // `run` helper only covers the section-level buttons, not the wizard's), then re-read state.
  const wizard = async (fn) => {
    setLocalBusy(true); setWizardErr(null); setStatusMsg(null);
    try { const r = await fn(); loadInfo(); return r; }
    catch (e) { setWizardErr(e.message || String(e)); throw e; }
    finally { setLocalBusy(false); }
  };

  const refresh = () => run(async () => {
    const p = await refreshProjectManifest(project.id);
    onProject(p);
    setStatusMsg('✓ Re-read zeehive.yml — the meta-DB cache now matches the repo.');
  });

  // Compose onboarding: detect compose files → show the plan → human approves → apply.
  // The server re-plans on apply and refuses without approved:true.
  const loadPlan = () => run(async () => {
    setPlanErr(null);
    try {
      const p = await getComposeOnboardingPlan(project.id);
      setPlan(p);
      setWriteYml((p.files_to_modify || []).length > 0);
      setApplyMeta(true);
    } catch (e) {
      setPlan(null);
      setPlanErr(e.message || String(e));
    }
  });

  const applyPlan = async () => {
    if (!plan?.applicable) return;
    const files = (plan.files_to_modify || []);
    const meta = (plan.meta_changes || []).filter((c) => c.column !== 'manifest');
    const lines = [
      `Apply compose onboarding for ${project.name}?`,
      '',
      writeYml && files.length
        ? `Files that WILL be written:\n${files.map((f) => `  • ${f.action.toUpperCase()} ${f.path} — ${f.detail}`).join('\n')}`
        : 'Files: none (write zeehive.yml is off)',
      '',
      applyMeta
        ? `Meta-DB project row columns that WILL change:\n${(plan.meta_changes || []).map((c) => `  • ${c.column}: ${c.from ?? '—'} → ${c.to}`).join('\n') || '  (manifest cache only)'}`
        : 'Meta-DB: none (apply meta-DB is off)',
      '',
      'NOT modified (guaranteed):',
      '  • production / spinoff container rows (live stacks keep their stamped compose_file)',
      '  • deploy_site.compose_file',
      ...(plan.warnings || []).length ? ['', 'Warnings:', ...plan.warnings.map((w) => `  ⚠ ${w}`)] : [],
      '',
      'Nothing is written until you confirm.',
    ].filter((x) => x !== false);
    if (!(await showConfirm(lines.join('\n'), {
      title: 'Approve compose onboarding',
      okLabel: 'Apply approved plan',
      variant: files.some((f) => f.action === 'update') ? 'danger' : undefined,
    }))) return;

    const result = await run(async () => applyComposeOnboarding(project.id, {
      approved: true,
      write_yml: writeYml,
      apply_meta: applyMeta,
    }));
    if (result?.project) onProject(result.project);
    setPlan(null);
    loadInfo();
    await showAlert(
      `Compose onboarding applied.`
      + (result?.written?.length ? `\nWrote: ${result.written.map((w) => `${w.action} ${w.path}`).join(', ')}` : '\nNo files written.')
      + '\nProduction containers were not touched.',
      { title: 'Onboarding complete' });
  };

  const fillFromCompose = () => {
    if (!suggest) return;
    setKnobs((k) => ({ ...k, ...knobsFromSuggestions(suggest, project) }));
    setStatusMsg('Filled the tiers and roles from the detected compose files. Adjust anything, then Preview.');
  };

  const previewDraft = () => wizard(async () => {
    const r = await buildProjectManifest(project.id, knobs);
    setEditableYaml(r.yaml);
    // A manifest with no tiers and no roles is the old "generic yaml that does nothing" — say so.
    setMinimalManifest(!r.manifest?.tiers && !r.manifest?.roles);
    setStep('preview');
  });

  const writeDraft = async () => {
    if (!(await showConfirm(
      `${regenerating ? 'Replace' : 'Create'} zeehive.yml in ${project.repo_root}?\n\n`
      + 'This is the ONE file ZEEHIVE writes into a project repo. '
      + (regenerating
        ? 'The current file is invalid and WILL be overwritten.'
        : 'It will be refused if a valid one already exists. ')
      + 'After it is written you still need to commit it in the repo.\n\n'
      + 'The meta-DB project row is updated to match (compose files, ports, roles). '
      + 'Production containers are not touched.',
      { okLabel: regenerating ? 'Replace zeehive.yml' : 'Create zeehive.yml', title: 'Write manifest to repo' }))) return;
    await wizard(async () => {
      const p = await writeProjectManifest(project.id, { yaml: editableYaml, apply_meta: true, overwrite: regenerating });
      onProject(p);
      setMode('create');
      setStep('idle');
      setStatusMsg('✓ zeehive.yml created and applied to the meta-DB. Commit it in the repo, then come back any time to ↻ Re-read it.');
    });
  };

  // ── render ────────────────────────────────────────────────────────────────
  const composeListId = `zh-cf-${project.id}`;
  const svcListId = `zh-svc-${project.id}`;
  const allServices = [...new Set((suggest?.files || []).flatMap((f) => f.services || []))];

  return (
    <div className="setup-sec" data-testid="manifest-section">
      <h3>Manifest <span className="pc">(zeehive.yml — the repo&apos;s shape truth)</span></h3>

      {!info ? (
        <div className="setup-hint">Checking the repo for a manifest…</div>
      ) : repoValid ? (
        <>
          <div className="gates">
            <span className="gate g-pass">✓ {repo.file} valid</span>
            {info.drift
              ? <span className="gate g-warn" title="The repo file changed since it was last read into the meta-DB">△ cached @ {project.manifest_hash || '—'} — repo differs, re-read</span>
              : <span className="gate g-pass" title="The meta-DB cache matches the repo file">✓ cached @ {project.manifest_hash || '—'}</span>}
          </div>
          <ManifestSummary manifest={project.manifest} />
          <div className="setup-row">
            <button type="button" onClick={refresh}
                    title="Re-read zeehive.yml into the meta-DB cache (the pool and provision paths read the cache)">
              ↻ Re-read from repo</button>
            <span className="setup-hint" style={{ margin: 0 }}>The repo file is the truth — edit <span className="mono">zeehive.yml</span> in the repo, then re-read here.</span>
          </div>
          {statusMsg && <div className="manifest-msg" data-testid="manifest-msg">{statusMsg}</div>}
        </>
      ) : (repoFound && !regenerating) ? (
        <>
          <div className="gates"><span className="gate g-fail">✗ {repo.file} INVALID</span></div>
          <div className="projpop-err" data-testid="manifest-invalid-err">
            {(repo.errors || []).map((e, i) => <div key={i}>{e}</div>)}
          </div>
          <div className="setup-row">
            <button type="button" onClick={refresh}>↻ Re-read from repo</button>
            <button type="button" className="ghost" onClick={() => { setMode('regenerate'); setStep('knobs'); setWizardErr(null); }}
                    title="Rebuild zeehive.yml from the form — the generated file replaces the invalid one">Regenerate from the form</button>
            <span className="setup-hint" style={{ margin: 0 }}>Fix the file in the repo, or rebuild it from the form.</span>
          </div>
        </>
      ) : (
        <>
          {/* ── the "no manifest yet" wizard (also shown when regenerating an INVALID manifest) ── */}
          <p className="setup-hint">
            {regenerating ? (
              <>Your <span className="mono">zeehive.yml</span> is invalid. Rebuild it in two steps — the generated
              file will <b>replace</b> the broken one.</>
            ) : (
              <>No <span className="mono">zeehive.yml</span> yet — the project is running on form defaults.
              Build one in two steps: describe the shape, review the generated file, then write it to the repo.</>
            )}
          </p>
          {regenerating && (
            <div className="setup-row" style={{ margin: '0 0 6px' }}>
              <button type="button" className="ghost" onClick={() => { setMode('create'); setStep('idle'); setWizardErr(null); }}
                      disabled={localBusy}>← Cancel — keep the invalid file</button>
            </div>
          )}

          {suggest?.files?.length > 0 && (
            <div className="manifest-detect">
              Detected {suggest.files.length} compose file{suggest.files.length === 1 ? '' : 's'}:
              {' '}<span className="mono">{suggest.files.map((f) => f.file).join(', ')}</span>
              {' '}<button type="button" className="ghost" onClick={fillFromCompose} disabled={localBusy}>Use them to fill the form</button>
            </div>
          )}

          {step === 'preview' ? (
            <div className="manifest-step" data-testid="manifest-preview">
              <div className="manifest-step-head">
                <span className="manifest-step-num">2</span>
                <div>
                  <b>Review the generated zeehive.yml</b>
                  <div className="setup-hint">Edit anything before writing — the text below is what gets written to the repo.</div>
                </div>
              </div>
              {minimalManifest && (
                <div className="manifest-minimal" data-testid="manifest-minimal">
                  ⚠ This manifest declares <b>no tiers or roles</b> — the project will keep running on
                  form defaults for its shape. Go back and add at least one compose file or role, or
                  write it anyway (it only sets the name and naming).
                </div>
              )}
              <textarea className="setup-draft manifest-editor" value={editableYaml} rows={16}
                        onChange={(e) => { setEditableYaml(e.target.value); setWizardErr(null); }} spellCheck={false} />
              <div className="setup-row">
                <button type="button" className="ghost" onClick={() => { setStep('knobs'); setWizardErr(null); }} disabled={localBusy}>← Back to step 1</button>
                <button type="button" data-testid="manifest-write-btn" onClick={writeDraft} disabled={localBusy}>
                  Write zeehive.yml to repo + apply…
                </button>
              </div>
              {wizardErr && <div className="projpop-err" data-testid="manifest-write-err">{wizardErr}</div>}
            </div>
          ) : (
            <div className="manifest-step" data-testid="manifest-knobs">
              <div className="manifest-step-head">
                <span className="manifest-step-num">1</span>
                <div>
                  <b>Describe the shape</b>
                  <div className="setup-hint">Which compose file runs each environment, which service plays each role. Blank = not used.</div>
                </div>
              </div>

              <datalist id={composeListId}>
                {(suggest?.files || []).map((f) => <option key={f.file} value={f.file} />)}
              </datalist>
              <datalist id={svcListId}>
                {allServices.map((s) => <option key={s} value={s} />)}
              </datalist>

              <div className="manifest-knob-group">
                <div className="manifest-knob-label">Compose files — which file runs each environment</div>
                <div className="setup-grid">
                  {MANIFEST_TIERS.map((tier) => (
                    <label key={tier}>{tier} <span className="pc">({tierHint(tier)})</span>
                      <input list={composeListId} placeholder="none"
                             value={knobs.tiers[tier].compose}
                             onChange={(e) => setKnobs({ ...knobs, tiers: { ...knobs.tiers, [tier]: { compose: e.target.value } } })} />
                    </label>
                  ))}
                </div>
              </div>

              <div className="manifest-knob-group">
                <div className="manifest-knob-label">Roles — which compose service plays each role</div>
                <div className="setup-grid">
                  {MANIFEST_ROLES.map(([role, label]) => (
                    <label key={role}>{label} <span className="pc">({role})</span>
                      <input list={svcListId} placeholder="none"
                             value={knobs.roles[role].service}
                             onChange={(e) => setKnobs({ ...knobs, roles: { ...knobs.roles, [role]: { service: e.target.value } } })} />
                    </label>
                  ))}
                </div>
              </div>

              <div className="manifest-knob-group">
                <div className="manifest-knob-label">Ports <span className="pc">(spinoff — per-xell ports are base + slot % mod)</span></div>
                <div className="setup-grid">
                  <label>Server port base
                    <input type="number" value={knobs.ports.server_base} placeholder="3100"
                           onChange={(e) => setKnobs({ ...knobs, ports: { ...knobs.ports, server_base: e.target.value } })} /></label>
                  <label>Webapp port base
                    <input type="number" value={knobs.ports.webapp_base} placeholder="5200"
                           onChange={(e) => setKnobs({ ...knobs, ports: { ...knobs.ports, webapp_base: e.target.value } })} /></label>
                  <label>Slot mod
                    <input type="number" value={knobs.ports.slot_mod} placeholder="90"
                           onChange={(e) => setKnobs({ ...knobs, ports: { ...knobs.ports, slot_mod: e.target.value } })} /></label>
                </div>
              </div>

              <div className="manifest-knob-group">
                <div className="manifest-knob-label">Environment</div>
                <div className="setup-grid">
                  <label>Env file
                    <input value={knobs.env_file} placeholder=".env"
                           onChange={(e) => setKnobs({ ...knobs, env_file: e.target.value })} /></label>
                </div>
              </div>

              <div className="setup-row">
                <button type="button" data-testid="manifest-preview-btn" onClick={previewDraft} disabled={localBusy}>
                  Preview zeehive.yml →
                </button>
                {statusMsg && <span className="manifest-msg">{statusMsg}</span>}
              </div>
              {wizardErr && <div className="projpop-err" data-testid="manifest-preview-err">{wizardErr}</div>}
            </div>
          )}

          {statusMsg && step !== 'knobs' && <div className="manifest-msg" data-testid="manifest-msg">{statusMsg}</div>}
        </>
      )}

      {planErr && <div className="projpop-err" data-testid="compose-plan-err">{planErr}</div>}

      {/* Advanced: compose onboarding — the automatic detect → plan → approve path. */}
      <details className="manifest-advanced" data-testid="manifest-advanced">
          <summary>Advanced — auto-detect from compose files (onboarding plan)</summary>
          <div className="setup-hint">
            Scans <span className="mono">docker-compose*.yml</span>, shows every file and meta-DB column that
            would change, and applies only after you approve. Live production containers are never rewritten.
          </div>
          <button type="button" data-testid="compose-plan-btn"
                  title="Detect compose files and preview meta-DB + yml changes before anything is written"
                  onClick={loadPlan}>Plan compose onboarding</button>
          {plan && (
            <div className="compose-plan" data-testid="compose-plan">
              <h4>Compose onboarding plan</h4>
              {!plan.applicable && (
                <div className="setup-hint">{plan.reason || 'Nothing to apply — already configured.'}</div>
              )}
              <div className="compose-plan-block">
                <div className="compose-plan-label">Detected compose files</div>
                {(plan.compose_files || []).length === 0
                  ? <div className="setup-hint">none at repo root</div>
                  : <ul className="compose-plan-list">
                      {plan.compose_files.map((f) => (
                        <li key={f.file}>
                          <span className="mono">{f.file}</span>
                          {f.tier_guess ? <span className="pc"> → tier {f.tier_guess}</span> : <span className="pc"> → (no tier guess)</span>}
                          {f.services?.length ? <span className="pc"> · services: {f.services.join(', ')}</span> : null}
                        </li>
                      ))}
                    </ul>}
              </div>
              <div className="compose-plan-block">
                <div className="compose-plan-label">Files that would be modified</div>
                {(plan.files_to_modify || []).length === 0
                  ? <div className="setup-hint">none — meta-DB only (or already in sync)</div>
                  : <ul className="compose-plan-list">
                      {plan.files_to_modify.map((f) => (
                        <li key={f.path}>
                          <b>{f.action.toUpperCase()}</b>{' '}
                          <span className="mono">{f.path}</span>
                          <div className="pc">{f.detail}</div>
                        </li>
                      ))}
                    </ul>}
              </div>
              <div className="compose-plan-block">
                <div className="compose-plan-label">Meta-DB project row changes</div>
                {(plan.meta_changes || []).length === 0
                  ? <div className="setup-hint">none</div>
                  : <ul className="compose-plan-list">
                      {plan.meta_changes.map((c) => (
                        <li key={c.column}>
                          <span className="mono">{c.column}</span>
                          {': '}
                          <span className="pc">{c.from == null || c.from === '' ? '—' : String(c.from)}</span>
                          {' → '}
                          <b>{String(c.to)}</b>
                        </li>
                      ))}
                    </ul>}
              </div>
              <div className="compose-plan-block compose-plan-safe">
                <div className="compose-plan-label">Guaranteed untouched</div>
                <ul className="compose-plan-list">
                  <li>Production and spinoff <b>container rows</b> (live stacks keep their stamped compose_file)</li>
                  <li><span className="mono">deploy_site.compose_file</span></li>
                </ul>
              </div>
              {(plan.warnings || []).length > 0 && (
                <div className="compose-plan-block">
                  <div className="compose-plan-label">Warnings</div>
                  <ul className="compose-plan-list">
                    {plan.warnings.map((w, i) => <li key={i} className="compose-plan-warn">⚠ {w}</li>)}
                  </ul>
                </div>
              )}
              {plan.proposed_yml && (
                <details className="compose-plan-yml">
                  <summary>Proposed zeehive.yml preview</summary>
                  <textarea className="setup-draft" readOnly value={plan.proposed_yml} rows={14} />
                </details>
              )}
              {plan.applicable && (
                <div className="compose-plan-actions">
                  <label className="compose-plan-check">
                    <input type="checkbox" checked={writeYml} onChange={(e) => setWriteYml(e.target.checked)}
                           disabled={(plan.files_to_modify || []).length === 0} />
                    Write / update <span className="mono">zeehive.yml</span> in the repo
                    {(plan.files_to_modify || []).length === 0 ? ' (nothing to write)' : ''}
                  </label>
                  <label className="compose-plan-check">
                    <input type="checkbox" checked={applyMeta} onChange={(e) => setApplyMeta(e.target.checked)} />
                    Apply manifest + compose columns to the meta-DB project row
                  </label>
                  <div className="setup-row">
                    <button type="button" data-testid="compose-apply-btn"
                            disabled={!writeYml && !applyMeta}
                            onClick={applyPlan}>
                      Review &amp; approve…
                    </button>
                    <button type="button" className="ghost" onClick={() => setPlan(null)}>Dismiss plan</button>
                  </div>
                </div>
              )}
              {!plan.applicable && (
                <div className="setup-row">
                  <button type="button" className="ghost" onClick={() => setPlan(null)}>Dismiss</button>
                </div>
              )}
            </div>
          )}
        </details>

      <div className="setup-grid" style={{ marginTop: 8 }}>
        <label>compose_spinoff <span className="pc">(meta-DB)</span>
          <input readOnly value={project.compose_spinoff || ''} placeholder="(unset)" /></label>
        <label>compose_prod <span className="pc">(meta-DB)</span>
          <input readOnly value={project.compose_prod || ''} placeholder="(unset)" /></label>
        <label>compose_dev <span className="pc">(meta-DB)</span>
          <input readOnly value={project.compose_dev || ''} placeholder="(unset)" /></label>
      </div>
    </div>
  );
}

// ── manifest wizard helpers ────────────────────────────────────────────────
const MANIFEST_TIERS = ['dev', 'spinoff', 'prod'];
const MANIFEST_ROLES = [['server', 'Server (API)'], ['webapp', 'Webapp (UI)'], ['db', 'Database']];
const tierHint = (t) => ({ dev: 'your machine / dev site', spinoff: 'per-xell sandbox', prod: 'deploy target' }[t] || t);

function emptyManifestKnobs(project) {
  return {
    env_file: project.env_file || '.env',
    tiers: { dev: { compose: '' }, spinoff: { compose: '' }, prod: { compose: '' } },
    roles: { server: { service: '' }, webapp: { service: '' }, db: { service: '' } },
    ports: { server_base: project.port_server_base || 3100, webapp_base: project.port_web_base || 5200, slot_mod: project.port_slot_mod || 90 },
  };
}
function knobsFromSuggestions(suggest, project) {
  const base = emptyManifestKnobs(project);
  return {
    ...base,
    tiers: {
      dev: { compose: suggest.compose?.dev || '' },
      spinoff: { compose: suggest.compose?.spinoff || '' },
      prod: { compose: suggest.compose?.prod || '' },
    },
    roles: {
      server: { service: suggest.roles?.server || '' },
      webapp: { service: suggest.roles?.webapp || '' },
      db: { service: suggest.roles?.db || '' },
    },
  };
}

// A human-readable digest of what a manifest DECLARES — the "what will this actually do"
// answer for an existing zeehive.yml, instead of the raw cached hash.
function ManifestSummary({ manifest }) {
  if (!manifest || typeof manifest !== 'object') return null;
  const tiers = manifest.tiers || {};
  const roles = manifest.roles || {};
  const ports = tiers.spinoff?.ports || {};
  const items = [];
  for (const t of ['dev', 'spinoff', 'prod']) {
    if (tiers[t]?.compose) items.push([`tier ${t}`, `compose ${tiers[t].compose}`]);
  }
  for (const [r, label] of MANIFEST_ROLES) {
    if (roles[r]?.service) items.push([`role ${r}`, `service “${roles[r].service}”${roles[r].buildable === false ? ' (shared, not built)' : ''}`]);
  }
  if (ports.server?.base) items.push(['server port', `base ${ports.server.base}${ports.server.mod ? ` · mod ${ports.server.mod}` : ''}`]);
  if (ports.webapp?.base) items.push(['webapp port', `base ${ports.webapp.base}${ports.webapp.mod ? ` · mod ${ports.webapp.mod}` : ''}`]);
  if (manifest.env?.file) items.push(['env file', manifest.env.file]);
  if (!items.length) {
    return <div className="setup-hint">This manifest only sets the project name and naming templates — no tiers, roles or ports.</div>;
  }
  return (
    <div className="manifest-summary" data-testid="manifest-summary">
      {items.map(([k, v]) => (
        <span key={k} className="manifest-summary-item"><span className="pc">{k}</span> {v}</span>
      ))}
    </div>
  );
}

// ── Deploy sites & inventory as a MASTER-DETAIL TREE ──────────────────────────
// One node per MACHINE (the master), its dev/prod deploy TYPES as the branches, and the shared
// container inventory grouped by ROLE under each. This is the shape the data actually nests in: a
// deploy site names WHERE a tier runs on a machine, and the shared container rows are what runs
// there. Before this, Sites and Inventory were two flat lists that did not say how they relate —
// a machine, a deploy type and a container all lived on the same tab but read as three unrelated
// surfaces. The tree is one surface: machine → dev/prod → db/server/app.
//
// A machine with no deploy sites or containers still shows (its "+ site" affordance is how a
// branch comes into being); a tier with a site but no containers shows an empty inventory (a
// place you can add one); a tier with containers but no site shows a "add site" hint. Per-xell
// spinoff stacks are a xell's throwaway stack, not deploy inventory, so they are not here.
const ROLE_LABEL = { db: 'DB', server: 'Server', webapp: 'App', infra: 'Infra' };

function DeployTree({ project, run, busy, initial = {} }) {
  // `initial` seeds the state (the render test passes a fixture; the live console does not, so the
  // mount effect fetches). Keeping the fetch as the live path means the tree is always current.
  const [machines, setMachines] = useState(initial.machines || []);
  const [sites, setSites] = useState(initial.sites || []);
  const [containers, setContainers] = useState(initial.containers || []);
  const load = useCallback(() => {
    getMachines().then(setMachines).catch(() => setMachines([]));
    getSites(project.id).then(setSites).catch(() => setSites([]));
    getSharedContainers(project.id).then(setContainers).catch(() => setContainers([]));
  }, [project.id]);
  useEffect(() => { load(); }, [load]);
  const wrapped = (fn) => run(async () => { await fn(); await load(); });

  // No machines yet → the pre-machine world: the old flat Sites + Inventory sections, unchanged.
  if (!machines.length) {
    return (<>
      <SitesSection project={project} run={run} busy={busy} />
      <InventorySection project={project} run={run} busy={busy} />
    </>);
  }

  const siteCtx = new Map((sites || []).map((s) => [s.id, s.docker_ctx]));
  const ctxOf = (c) => c.docker_ctx || (c.site_id ? siteCtx.get(c.site_id) : null) || null;
  const known = new Set(machines.map((m) => m.docker_ctx));
  const elsewhere = containers.filter((c) => !known.has(ctxOf(c)));
  const nodes = machines.map((m) => ({
    m,
    devSites: sites.filter((s) => s.docker_ctx === m.docker_ctx && s.tier === 'dev'),
    prodSites: sites.filter((s) => s.docker_ctx === m.docker_ctx && s.tier === 'prod'),
    dev: containers.filter((c) => ctxOf(c) === m.docker_ctx && c.tier === 'dev'),
    prod: containers.filter((c) => ctxOf(c) === m.docker_ctx && c.tier === 'prod'),
  }));

  return (
    <section className="deploy-tree" data-testid="deploy-tree">
      {nodes.map((n) => (
        <DeployMachine key={n.m.id} node={n} sites={sites}
                       project={project} run={wrapped} busy={busy} />
      ))}
      {elsewhere.length > 0 && (
        <div className="dt-machine elsewhere" title="Containers whose docker context matches no machine row — add the machine to claim them">
          <div className="dt-machine-head"><b>elsewhere</b></div>
          <div className="dt-body">
            <DeployBranch tier="dev" sites={[]} containers={elsewhere.filter((c) => c.tier === 'dev')}
                          machine={null} project={project} run={wrapped} busy={busy} />
            <DeployBranch tier="prod" sites={[]} containers={elsewhere.filter((c) => c.tier === 'prod')}
                          machine={null} project={project} run={wrapped} busy={busy} />
          </div>
        </div>
      )}
    </section>
  );
}

function DeployMachine({ node, sites, project, run, busy }) {
  const { m, devSites, prodSites, dev, prod } = node;
  return (
    <div className="dt-machine" data-testid={`deploy-machine-${m.key}`}>
      <div className="dt-machine-head" title={`${m.label || m.key}\ncontext: ${m.docker_ctx}${m.host_ip ? `\nhost: ${m.host_ip}` : ''}${m.notes ? `\n${m.notes}` : ''}`}>
        <b className="dt-machine-key">{m.key}</b>
        <span className="mono">{m.docker_ctx}</span>
        <span className="pc">{m.host_ip ? `host ${m.host_ip}` : 'local'}</span>
        {m.can_build && <span className="dt-badge">🔨 builds</span>}
        <AddSiteInline machine={m} sites={sites} project={project} run={run} busy={busy} />
      </div>
      <div className="dt-body">
        <DeployBranch tier="dev" sites={devSites} containers={dev}
                      machine={m} project={project} run={run} busy={busy} />
        <DeployBranch tier="prod" sites={prodSites} containers={prod}
                      machine={m} project={project} run={run} busy={busy} />
      </div>
    </div>
  );
}

// One deploy TYPE (dev | prod) on a machine: the site(s) that name the branch, then the shared
// container inventory grouped by role. A branch with a site but no containers is a place you can
// add one; a branch with containers but no site tells you to add the site.
function DeployBranch({ tier, sites, containers, machine, project, run, busy }) {
  const site = sites[0];
  if (!sites.length && !containers.length) return null;
  return (
    <div className="dt-branch" data-tier={tier} data-testid={`deploy-branch-${tier}`}>
      <div className="dt-branch-label">{tier}</div>
      <div className="dt-branch-body">
        <div className="dt-branch-sites">
          {sites.map((s) => <SiteEditor key={s.id} site={s} run={run} busy={busy} />)}
          {!sites.length && (
            <div className="pc">no {tier} deploy site on {machine?.key ?? 'this host'} yet — add one above.</div>
          )}
        </div>
        {containers.length > 0 && (
          <div className="dt-branch-inv">
            {ROLES.map((role) => {
              const cs = containers.filter((c) => c.role === role);
              if (!cs.length) return null;
              return (
                <div className="dt-role" key={role} data-role={role}>
                  <span className="invlabel">{ROLE_LABEL[role]}:</span>
                  <div className="dt-rows">
                    {cs.map((c) => <InvRow key={c.id} c={c} run={run} busy={busy} />)}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <AddSharedContainer project={project} tier={tier} ctx={machine?.docker_ctx || null}
                            run={run} busy={busy} />
        {tier === 'prod' && site && <DiscoverSite site={site} project={project} busy={busy} />}
      </div>
    </div>
  );
}

// Add a shared container to THIS branch — the tier and docker context come from the branch, so a
// container you add under "local ▾ dev" lands exactly there, never on the project's default site.
function AddSharedContainer({ project, tier, ctx, run, busy }) {
  const [f, setF] = useState({ name: '', role: 'server', build_script: '' });
  const [open, setOpen] = useState(false);
  const add = () => run(async () => {
    await createSharedContainer(project.id, {
      name: f.name.trim(), role: f.role, tier,
      docker_ctx: ctx || undefined, build_script: f.build_script.trim() || null,
    });
    setF({ name: '', role: 'server', build_script: '' });
  });
  if (!open) {
    return <button type="button" className="ghost dt-addbtn" onClick={() => setOpen(true)}>＋ {tier} container</button>;
  }
  return (
    <div className="setup-row dt-add">
      <input placeholder="container name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
      <select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
        {ROLES.map((r) => <option key={r}>{r}</option>)}
      </select>
      <input placeholder="build script (optional)" value={f.build_script}
             onChange={(e) => setF({ ...f, build_script: e.target.value })} />
      <button type="button" disabled={busy || !f.name.trim()} onClick={add}>Add</button>
      <button type="button" className="ghost" onClick={() => setOpen(false)}>✕</button>
    </div>
  );
}

// Add a deploy site ON a machine — the machine's context is pre-filled, so the site is born in
// the branch it belongs to instead of being a bare context string typed from memory.
function AddSiteInline({ machine, sites, project, run, busy }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ tier: 'dev', key: '', host: machine.host_ip || '' });
  const add = () => run(async () => {
    await createSite(project.id, {
      key: f.key.trim() || `${f.tier}-${machine.key}`,
      tier: f.tier,
      docker_ctx: machine.docker_ctx,
      host: f.host.trim() || null,
      docker_endpoint: null,
      is_default: f.tier === 'prod' && !(sites || []).some((s) => s.tier === 'prod'),
    });
    setOpen(false); setF({ tier: 'dev', key: '', host: machine.host_ip || '' });
  });
  if (!open) {
    return <button type="button" className="ghost" onClick={() => setOpen(true)} title={`Add a deploy site on ${machine.key}`}>＋ site</button>;
  }
  return (
    <div className="setup-row dt-addsite">
      <select value={f.tier} onChange={(e) => setF({ ...f, tier: e.target.value })}>
        <option value="dev">dev</option><option value="prod">prod</option>
      </select>
      <input placeholder={`site key (e.g. ${f.tier}-${machine.key})`} value={f.key}
             onChange={(e) => setF({ ...f, key: e.target.value })} />
      <input placeholder="host (IP or DNS)" value={f.host} onChange={(e) => setF({ ...f, host: e.target.value })} />
      <button type="button" disabled={busy} onClick={add}>Add</button>
      <button type="button" className="ghost" onClick={() => setOpen(false)}>✕</button>
    </div>
  );
}

// Discover + adopt the running containers on ONE prod site, shown under that prod branch. The
// standalone DiscoverPanel (used by the no-machines fallback) picks from all prod sites; here the
// branch already names the site, so this is the scoped version.
function DiscoverSite({ site, project, busy }) {
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState(null);
  const [sel, setSel] = useState({});
  const [working, setWorking] = useState(false);
  const discover = async () => {
    setWorking(true); setResult(null); setSel({});
    try {
      const r = await discoverSite(site.id);
      setResult(r);
      if (r.ok) {
        const next = {};
        for (const c of r.containers) {
          const adoptable = !(c.already_modeled && c.linked_to_prod);
          next[c.name] = { checked: adoptable, role: c.inferred_role || '' };
        }
        setSel(next);
      }
    } catch (e) { setResult({ ok: false, error: e.message }); }
    finally { setWorking(false); }
  };
  const adopt = async () => {
    const containers = (result?.containers || [])
      .filter((c) => sel[c.name]?.checked && !(c.already_modeled && c.linked_to_prod))
      .map((c) => ({ name: c.name, role: sel[c.name].role, image_tag: c.image,
                     compose_project: c.compose_project,
                     host_port: c.ports?.[0]?.public || null,
                     internal_port: c.ports?.[0]?.private || null }));
    const bad = containers.find((c) => !['db', 'server', 'webapp', 'infra'].includes(c.role));
    if (bad) { await showAlert(`Choose a role for "${bad.name}" before adopting.`, { variant: 'error' }); return; }
    if (containers.length === 0) { await showAlert('Nothing selected to adopt.'); return; }
    setWorking(true);
    try {
      const r = await adoptContainers(site.id, containers);
      setResult(null);
      await showAlert(`Adopted ${r.adopted.length}, linked ${r.linked.length} to production`
        + `${r.skipped.length ? `, ${r.skipped.length} already modeled` : ''}.`);
    } catch (e) { await showAlert(e.message, { variant: 'error' }); }
    finally { setWorking(false); }
  };
  const disabled = busy || working;
  return (
    <div className="dt-discover">
      <button type="button" disabled={disabled} onClick={() => { setOpen((o) => !o); if (!open && !result) discover(); }}>
        {working ? '…' : open ? '▾ Discover' : '🔍 Discover running stack'}
      </button>
      {open && result && !result.ok && <div className="pc dt-disc-err">⚠ {result.error}</div>}
      {open && result?.ok && result.count === 0 && (
        <div className="pc">Context <span className="mono">{result.docker_ctx}</span> is reachable but has no containers.</div>
      )}
      {open && result?.ok && result.count > 0 && (
        <div className="dt-disc-list">
          {result.containers.map((c) => {
            const done = c.already_modeled && c.linked_to_prod;
            const s = sel[c.name] || {};
            return (
              <div key={c.name} className="setup-row discover-row" style={{ opacity: done ? 0.55 : 1 }}>
                <input type="checkbox" checked={!!s.checked} disabled={disabled || done} onChange={() => setSel((x) => ({ ...x, [c.name]: { ...x[c.name], checked: !x[c.name]?.checked } }))}
                       title={done ? 'already adopted' : 'select to adopt'} />
                <span className="mono" title={`${c.image || ''} · ${c.status || c.state || ''}`}>{c.name}</span>
                <span className="pc" title="published ports">
                  {c.compose_service ? `${c.compose_project}/${c.compose_service}` : (c.labelled ? '—' : 'unlabelled')}
                  {c.ports?.length ? ` :${c.ports.map((p) => p.public).join(',')}` : ''}
                </span>
                {done
                  ? <span className="pc" style={{ color: 'var(--ok, #6a6)' }}>adopted ✓</span>
                  : c.already_modeled
                    ? <><select value={s.role || ''} disabled><option>{c.modeled_as?.role}</option></select>
                        <span className="pc">modeled — will link to prod</span></>
                    : <>
                        <select value={s.role || ''} disabled={disabled} onChange={(e) => setSel((x) => ({ ...x, [c.name]: { ...x[c.name], role: e.target.value } }))}>
                          <option value="">role?</option>
                          {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                        </select>
                        <span className="pc" title="why this role was guessed">{c.role_reason}</span>
                      </>}
              </div>
            );
          })}
          <div className="setup-row" style={{ marginTop: 4 }}>
            <button type="button" disabled={disabled} onClick={adopt}>＋ Adopt selected</button>
            <span className="pc">build script stays empty — set it below to make a container shippable.</span>
          </div>
        </div>
      )}
    </div>
  );
}

function SitesSection({ project, run, busy }) {
  const [sites, setSites] = useState(null);
  const [machines, setMachines] = useState([]);
  const [add, setAdd] = useState({ key: '', tier: 'prod', docker_ctx: '', host: '', docker_endpoint: '' });
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
        <input className="sitehost" value={add.host} placeholder="host (IP or DNS)" onChange={(e) => setAdd({ ...add, host: e.target.value })} />
        <input className="siteendpoint" value={add.docker_endpoint} placeholder="docker endpoint (e.g. tcp://10.2.0.16:2375)"
               title="The full endpoint the queenzee reconciles this site's docker context to (the tab is the source of truth)"
               onChange={(e) => setAdd({ ...add, docker_endpoint: e.target.value })} />
        <button type="button" disabled={busy || !add.key.trim()}
                onClick={() => wrapped(() => createSite(project.id, {
                  ...add, docker_ctx: add.docker_ctx.trim() || 'default', host: add.host.trim() || null,
                  docker_endpoint: add.docker_endpoint.trim() || null,
                  // the first prod site becomes the default target automatically
                  is_default: add.tier === 'prod' && !(sites || []).some((s) => s.tier === 'prod'),
                })).then(() => setAdd({ key: '', tier: 'prod', docker_ctx: '', host: '', docker_endpoint: '' }))}>＋ Add site</button>
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

// WIREGUARD MESH — ZEEHIVE operated (docs/common-xell-network-plan.md, Decision 5.4). The human's
// door onto the network: a ready .conf to download and import into their WG client. The mesh server
// (public key, endpoint, address space) is minted lazily on first download; peers are keypairs the
// server allocates and hands out. The private key lives ONLY in the downloaded file, never stored.
//
// The inline section is a compact STATUS SUMMARY; the full mesh state (server identity, every peer,
// the download + endpoint editor) lives in a proper MODAL — WireguardModal below — so the summary
// stays one glance and the detail opens on demand, matching how Deploy sites unfold their editors.
function WireguardSection({ project, run, busy }) {
  const [state, setState] = useState(null);
  const [open, setOpen] = useState(false);
  const load = useCallback(() => getWireguard(project.id).then(setState).catch(() => {}), [project.id]);
  useEffect(() => { load(); }, [load]);

  const srv = state?.server;
  return (
    <div className="setup-sec">
      <h3>WireGuard <span className="pc">(the ZEEHIVE network — download a config to join)</span></h3>
      {!state?.enabled ? (
        <div className="pc">Not set up yet. The first download mints the mesh identity and gives you a peer config.</div>
      ) : (
        <div className="setup-row">
          <span className="mono" title="the mesh server's public key">🔑 {srv.public_key.slice(0, 12)}…</span>
          <span className="mono" title="where peers dial">{srv.endpoint}</span>
          <span className="mono" title="the mesh address space">{srv.address}</span>
          <span className="pc">{state.peers.length} peer{state.peers.length === 1 ? '' : 's'}</span>
        </div>
      )}
      <div className="setup-row">
        <button type="button" onClick={() => setOpen(true)}>🗀 Open status</button>
      </div>
      {open && <WireguardModal project={project} run={run} busy={busy}
                               onClose={() => setOpen(false)} onChanged={load} />}
    </div>
  );
}

// The full WireGuard status as a modal — the "proper modalstatus". A real dialog (portaled, click-
// outside / Esc to close, reusing the term-overlay pattern already in this file) showing:
//   • the mesh server: public key (full, copyable), endpoint, address space;
//   • every joined peer (name, tunnel IP, public key, when it was downloaded);
//   • the two actions that change the mesh — download a config (mints a peer) and re-point the
//     endpoint. The private key appears ONLY in the downloaded file, never here.
function WireguardModal({ project, run, busy, onClose, onChanged }) {
  const [state, setState] = useState(null);
  const [peerName, setPeerName] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [err, setErr] = useState(null);
  const load = useCallback(() => getWireguard(project.id).then(setState).catch(() => {}), [project.id]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const download = async () => {
    setErr(null);
    try {
      const { blob, filename } = await mintWireguardPeer(project.id, { name: peerName.trim() || null });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
      await load(); onChanged?.();
    } catch (e) { setErr(e.message); }
  };

  const saveEndpoint = async () => {
    setErr(null);
    try { await setWireguardEndpoint(project.id, endpoint.trim()); await load(); }
    catch (e) { setErr(e.message); }
  };

  const srv = state?.server;
  return (
    <div className="term-overlay" onClick={onClose} data-testid="wireguard-modal">
      <div className="wg-modal" onClick={(e) => e.stopPropagation()}>
        <div className="term-head">
          <span className="term-title">🛡 WireGuard — {project.name}</span>
          <button className="term-x" onClick={onClose} title="Close">✕</button>
        </div>
        <div className="setup-body">
          {!state?.enabled ? (
            <div className="pc">
              This project has no WireGuard mesh yet. The first download mints the mesh identity
              (server key + address space) and gives you a peer config to import.
            </div>
          ) : (
            <>
              <div className="setup-sec">
                <h3>Server <span className="pc">(what peers dial)</span></h3>
                <div className="setup-grid">
                  <label>Public key
                    <input className="mono" readOnly value={srv.public_key}
                           onFocus={(e) => e.target.select()} title="the mesh server's public key" />
                  </label>
                  <label>Endpoint
                    <input className="mono" value={endpoint || srv.endpoint}
                           placeholder={srv.endpoint}
                           onChange={(e) => setEndpoint(e.target.value)} />
                  </label>
                  <label>Address space
                    <input className="mono" readOnly value={srv.address} />
                  </label>
                  <label>Listen port
                    <input className="mono" readOnly value={srv.listen_port} />
                  </label>
                </div>
                {endpoint.trim() && endpoint.trim() !== srv.endpoint && (
                  <div className="setup-row">
                    <button type="button" disabled={busy} onClick={saveEndpoint}>Save endpoint</button>
                  </div>
                )}
              </div>

              <div className="setup-sec">
                <h3>Peers <span className="pc">(who has joined)</span></h3>
                {state.peers.length === 0 ? (
                  <div className="pc">No peers yet — download a config below to join the mesh.</div>
                ) : (
                  <table className="wg-peers">
                    <thead><tr><th>name</th><th>tunnel IP</th><th>public key</th><th>downloaded</th></tr></thead>
                    <tbody>
                      {state.peers.map((p) => (
                        <tr key={p.id}>
                          <td>{p.name}</td>
                          <td className="mono">{p.address}</td>
                          <td className="mono" title={p.public_key}>{p.public_key.slice(0, 12)}…</td>
                          <td>{p.downloaded_at ? new Date(p.downloaded_at).toLocaleString() : 'never'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </>
          )}

          <div className="setup-sec">
            <h3>Join <span className="pc">(mint a peer config — the private key is only in the file)</span></h3>
            <div className="setup-row">
              <input placeholder="peer name (e.g. my-laptop)" value={peerName}
                     onChange={(e) => setPeerName(e.target.value)} />
              <button type="button" disabled={busy} onClick={download}>⬇ Download config</button>
            </div>
          </div>
          {err && <div className="land-err">{err}</div>}
        </div>
      </div>
    </div>
  );
}

function SiteEditor({ site, run, busy }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({
    docker_ctx: site.docker_ctx || '', host: site.host || '',
    docker_endpoint: site.docker_endpoint || '',
    kind: site.ingress?.kind || 'lan', public_url: site.ingress?.public_url || '',
    provider_container: site.ingress?.provider_container || '', notes: site.ingress?.notes || '',
  });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const save = () => run(() => updateSite(site.id, {
    docker_ctx: f.docker_ctx.trim() || 'default', host: f.host.trim() || null,
    docker_endpoint: f.docker_endpoint.trim() || null,
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
        <input className="sitehost" value={f.host} placeholder="host (IP or DNS)" onChange={set('host')} />
        <input className="siteendpoint" value={f.docker_endpoint} placeholder="endpoint (e.g. ssh://mnrevelo@ssh.omnibiz.express)"
               title="The full endpoint the queenzee reconciles this site's docker context to (the tab is the source of truth)"
               onChange={set('docker_endpoint')} />
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

// ── Environments: the meta-DB source of truth for the untracked .env ────────────
// A project holds named environments (dev / prod / staging …); each is a set of KEY=value vars
// stored in the meta-DB, masked here (a secret's value is never returned — only a hint). A xell is
// loaded with one by TIER: a live-prod / production xell gets the default prod env, a dev/spinoff
// xell the default dev env — merged into its .zeehive.env by emitXellEnv.
// ── the project's ENTRY-POINT DOCS — ONE text, one file per AI provider ───────
// What an agent opens before it designs anything. The CONTENTS live in the meta-DB and the queenzee
// generates a file per provider into every xell when a zee is assigned (lib/project-docs.js,
// lib/agent-docs.js) — the same rule the harnesses moved to: one source, and the files in the
// workspace are artefacts of it.
//
// THE TEXTBOX IS THE SOURCE, NOT A PATH. That is the whole shape of this surface: an operator writes
// the project's instructions once, ticks which providers should receive them, and the filenames come
// from the registry — CLAUDE.md for Claude Code, AGENTS.md for the ~20 tools that read the standard,
// GEMINI.md, .github/copilot-instructions.md, .cursor/rules/*.mdc … Nobody pastes the same text into
// four files and watches them drift.
//
// The three things it has to SAY, because they are the three ways an operator gets surprised:
// this text is the SOURCE and the files in a workspace are artefacts of it — a tracked entry-point
// path the row owns is SUPERSEDED (git-excluded + skip-worktree, so it never appears in a landing
// diff), an unrelated tracked path is still protected (the repo's own file wins there), and every
// generated file carries a stamp plus THAT xell's own stack inventory — which is why the copy in a
// workspace is never quite what was typed here.
export function ProjectDocsSection({ project, run, busy }) {
  const [docs, setDocs] = useState(null);
  const [targets, setTargets] = useState([]);
  const [addPath, setAddPath] = useState('');
  const load = useCallback(() => getProjectDocs(project.id).then(setDocs).catch(() => {}), [project.id]);
  useEffect(() => { load(); }, [load]);
  // The catalogue is the server's (vendors rename these files) — an empty answer degrades to
  // custom-path authoring rather than an empty screen.
  useEffect(() => { getAgentDocTargets().then(setTargets).catch(() => setTargets([])); }, []);
  const wrapped = (fn) => run(async () => { await fn(); await load(); });
  const claimed = new Set((docs || []).flatMap((d) => d.targets || []));
  const defaults = targets.filter((t) => t.default && !claimed.has(t.key)).map((t) => t.key);
  return (
    <div className="setup-sec" data-testid="project-docs-section">
      <h3>Docs <span className="pc">(the project's instructions for AI agents — written ONCE here, generated as each provider's entry-point file in every xell)</span></h3>
      <div className="pc">
        What you type below is the <b>single source of truth</b>. ZEEHIVE generates one file per
        provider from it — <code>CLAUDE.md</code>, <code>AGENTS.md</code>, <code>GEMINI.md</code>, … —
        each stamped as generated, each ending with <b>that xell's own stack</b> (its containers, ports,
        database and build verbs), and each added to the xell's git excludes so it never lands in a
        diff. If the project has <b>committed</b> a file at one of those paths, the generated copy
        supersedes it in every xell — the row is the source, the committed file is the artefact. A
        file <b>no row claims</b> is left alone. Saving also regenerates the files in the xells of any
        zees <b>already running</b>, so a fix does not wait for the next dispatch.
      </div>
      {(docs || []).map((d) => (
        <ProjectDocEditor key={d.id} doc={d} targets={targets} run={wrapped} busy={busy} />
      ))}
      {docs && docs.length === 0 && (
        <div className="pc">No instructions yet — write them once below and every AI agent on this
          project gets them at the path it looks for.</div>
      )}
      <div className="setup-row">
        <button type="button" disabled={busy}
                onClick={() => wrapped(() => createProjectDoc(project.id, {
                  title: 'Project instructions', body: '', targets: defaults.length ? defaults : ['claude'],
                }))}>＋ Project instructions</button>
        <span className="pc">generates {(defaults.length ? defaults : ['claude'])
          .map((k) => targets.find((t) => t.key === k)?.path || k).join(' + ')} — tick more providers after</span>
      </div>
      <div className="setup-row">
        <input value={addPath} placeholder="…or one extra doc at a custom path (e.g. docs/agents/ONBOARDING.md)"
               onChange={(e) => setAddPath(e.target.value)}
               title="repo-relative, markdown only; .git/ and .zeehive/ are refused" />
        <button type="button" className="pill" disabled={busy || !addPath.trim()}
                onClick={() => wrapped(() => createProjectDoc(project.id, { rel_path: addPath.trim(), body: '' }))
                  .then(() => setAddPath(''))}>＋ Add custom path</button>
      </div>
    </div>
  );
}

// One source document: its contents, and which provider files it generates. A custom-path row keeps
// the old path box instead of the provider checkboxes — the two modes are exclusive server-side, so
// the UI never offers both at once.
export function ProjectDocEditor({ doc, targets = [], run, busy }) {
  const [body, setBody] = useState(doc.body || '');
  const [title, setTitle] = useState(doc.title || '');
  const [path, setPath] = useState(doc.rel_path || '');
  // The generated file as the queenzee would write it — fetched on demand (it runs the real generator
  // against a real xell) and dropped whenever the row changes, so a stale preview can never be read as
  // the current one.
  const [preview, setPreview] = useState(null);
  const custom = !(doc.targets || []).length;
  const dirty = body !== (doc.body || '') || title !== (doc.title || '')
    || (custom && path !== (doc.rel_path || ''));
  useEffect(() => {
    setBody(doc.body || ''); setTitle(doc.title || ''); setPath(doc.rel_path || ''); setPreview(null);
  }, [doc.id, doc.body, doc.title, doc.rel_path, (doc.targets || []).join(',')]);
  const on = new Set(doc.targets || []);
  const generated = custom ? [doc.rel_path] : targets.filter((t) => on.has(t.key)).map((t) => t.path);
  // Toggling a provider SAVES immediately (like `enabled`): it is one fact, and the pending-edit
  // dance that a text field needs would only make it possible to lose the body you were typing.
  const toggle = (key, want) => {
    const next = want ? [...on, key] : [...on].filter((k) => k !== key);
    // The last one off is refused rather than saved: the server's CHECK would reject it anyway, and a
    // doc that generates no file is text an operator wrote that reaches nobody. Say which action they
    // actually want instead.
    if (!next.length) {
      return showAlert('This is the last provider.\n\nA doc that generates no file reaches nobody — '
        + 'untick "enabled" to stop it being written, or delete it.');
    }
    return run(() => updateProjectDoc(doc.id, { targets: next, rel_path: null, body }));
  };
  return (
    <div className={`setup-sub${doc.enabled ? '' : ' off'}`}
         data-testid={`project-doc-${custom ? doc.rel_path : (doc.targets || []).join('+')}`}>
      <div className="setup-row">
        {custom
          ? <input value={path} onChange={(e) => setPath(e.target.value)} style={{ minWidth: 220 }} />
          : <input value={title} placeholder="what to call this text (cosmetic)"
                   onChange={(e) => setTitle(e.target.value)} style={{ minWidth: 220 }} />}
        <label className="pc" title="a disabled doc is not written into new xells">
          <input type="checkbox" checked={!!doc.enabled} disabled={busy}
                 onChange={(e) => run(() => updateProjectDoc(doc.id, { enabled: e.target.checked }))} /> enabled
        </label>
        <span className="pc">{(body || '').length} chars</span>
        <button type="button" disabled={busy || !dirty}
                onClick={() => run(() => updateProjectDoc(doc.id,
                  custom ? { rel_path: path.trim(), body } : { title: title.trim() || null, body }))}>Save</button>
        <button type="button" className="hm-del" disabled={busy}
                onClick={async () => {
                  if (!await showConfirm(`Delete ${generated.filter(Boolean).join(', ') || 'this doc'}?\n\n`
                    + `New xells stop receiving it. A zee already working keeps the copy it was given — `
                    + `the queenzee does not delete files out of a live workspace.`)) return;
                  run(() => deleteProjectDoc(doc.id));
                }} title="Delete this doc">🗑</button>
      </div>
      <textarea className="setup-md" rows={12} value={body} spellCheck={false}
                placeholder="# How this project works&#10;&#10;What an agent arriving with no context needs to know: what the project IS, how to run and test it, the house rules it must not relearn."
                onChange={(e) => setBody(e.target.value)} />
      <div className="setup-row">
        <button type="button" className="pill" disabled={busy}
                onClick={() => (preview ? setPreview(null)
                  : previewProjectDoc(doc.id).then(setPreview).catch((e) => setPreview({ error: e.message })))}>
          {preview ? 'hide' : 'preview'} what gets written
        </button>
        {preview?.note && <span className="pc">{preview.note}</span>}
        {preview?.error && <span className="pc">could not preview: {preview.error}</span>}
      </div>
      {preview?.files?.map((f) => (
        <div key={f.relPath} className="docpv">
          <div className="pc mono">{f.relPath}</div>
          <pre>{f.text}</pre>
        </div>
      ))}
      {!custom && (
        <div className="docgen">
          <div className="pc">Generate for <b>{generated.length}</b> provider
            {generated.length === 1 ? '' : 's'}:{' '}
            {generated.length
              ? generated.map((p, i) => <span key={p}>{i ? ' · ' : ''}<code>{p}</code></span>)
              : 'nothing — this doc reaches nobody'}
          </div>
          <div className="docgen-grid">
            {targets.map((t) => (
              <label key={t.key} className={`docgen-t${on.has(t.key) ? ' on' : ''}`}
                     title={`${(t.reads || []).join(', ')}${t.note ? `\n\n${t.note}` : ''}`}>
                <input type="checkbox" checked={on.has(t.key)} disabled={busy}
                       onChange={(e) => toggle(t.key, e.target.checked)} />
                <span className="mono">{t.label || t.path}</span>
                <span className="pc">{(t.reads || []).slice(0, 3).join(', ')}
                  {(t.reads || []).length > 3 ? ` +${t.reads.length - 3}` : ''}</span>
              </label>
            ))}
          </div>
          {!targets.length && <div className="pc">(the provider catalogue could not be loaded — reload the console)</div>}
        </div>
      )}
    </div>
  );
}

// CURRENT CONDITIONS — the short, dated, per-PROJECT list of live impediments injected into every
// briefing (ticket #67). The HUMAN's editor; a manager edits the same list with `zee conditions`.
// Explicitly EPHEMERAL — each line renders with the date it was last touched and deleting one is a
// plain button, with no confirm, because stale conditions are worse than none and this list must
// never become a second manual.
function ConditionsSection({ project, run, busy }) {
  const [conds, setConds] = useState(null);
  const [add, setAdd] = useState('');
  const [medicMsg, setMedicMsg] = useState(null);   // result of the last dispatch-medic click
  const load = useCallback(() => getProjectConditions(project.id).then(setConds).catch(() => {}), [project.id]);
  useEffect(() => { load(); }, [load]);
  const wrapped = (fn) => run(async () => { await fn(); await load(); });
  // The ⛑ is the infra-medic dispatch seam (proof-routing §4.6, provision-proof plan §7): the
  // route adds a MANAGER-type medic on the Zeehive project — the orchestrator's own, whose prod
  // database IS the meta-DB — briefed with this card VERBATIM and the card's TARGET project, to
  // fix the project's META-DB CONFIG (not this one xell) so the machine×project pair stops being
  // broken. A human clicks; nothing auto-spawns.
  const dispatch = async (c) => {
    setMedicMsg('⛑ dispatching the infra-medic…');
    try {
      const r = await run(() => dispatchMedic(c.id));
      setMedicMsg(`⛑ medic dispatched → xell ${r?.slug || r?.xell_id || '?'}`);
    } catch { setMedicMsg(null); }   // the panel's err line already told the human why
  };
  return (
    <div className="setup-sec" data-testid="conditions-section">
      <h3>Current conditions <span className="pc">(the short, dated list of LIVE IMPEDIMENTS injected into every briefing — EPHEMERAL, the opposite of the docs)</span></h3>
      <div className="pc">
        Each line is a fact that is <b>true now and should be false soon</b> — "the shared dev DSN is
        stale (TKT-47)", "these two tests are red on main and are not yours (TKT-54, TKT-59)". It is
        injected into every zee briefing on this project, dated with the day it was last touched, and
        read back with <code>zee conditions</code>. This is <b>not documentation</b>: when a line stops
        being true, delete it — a stale line is worse than none, so there is no archive and no confirm.
      </div>
      {medicMsg && <div className="pc" data-testid="medic-dispatch-msg">{medicMsg}</div>}
      {(conds || []).map((c) => {
        const d = String(c.updated_at || c.created_at || '').slice(0, 10);
        const body = String(c.body || '');
        // The ⛑ is the medic's dispatch seam — shown on EVERY row except the rolling CODE fact
        // ("main does not build since <sha>", proof-routing §4.6). A PROVISION-INFRA card is the
        // auto seam, and a HAND-WRITTEN blocker line ("OMNIBIZ cannot provision — the NAS is out of
        // addresses") is the same surface: a human wrote it BECAUSE the project's build/provision
        // is impeded, and the medic (a manager on Zeehive, briefed with this card verbatim) is the
        // config-fixing agent for exactly that. The CODE fact says the machine CAN build — a code
        // fault is that project's crew, never the config-medic, so the button must not point a
        // human at the wrong tool. The server route carries the real walls (MANAGER-only, and the
        // medic's own scope wall once briefed); this is the affordance, and it is better to show it
        // too wide than to hide the one button a human is looking for.
        const showMedic = !body.startsWith('main does not build since');
        return (
          <div key={c.id} className="setup-row" data-testid={`condition-${c.id}`}>
            <input value={c.body} data-condition-id={c.id}
                   onChange={(e) => { const v = e.target.value;
                     const next = (conds || []).map((x) => (x.id === c.id ? { ...x, body: v } : x));
                     setConds(next); }}
                   onBlur={(e) => { const v = String(e.target.value || '').trim();
                     if (v && v !== c.body) wrapped(() => updateProjectCondition(c.id, v, 'human')); }}
                   style={{ minWidth: 360 }} />
            {showMedic && (
              <button type="button" className="pill" disabled={busy}
                      onClick={() => dispatch(c)}
                      title="Dispatch the infra-medic (a manager zee on Zeehive) to fix this project's meta-DB config so the machine×project pair stops being broken">
                ⛑ Dispatch medic
              </button>
            )}
            <span className="pc" title="last touched (the date injected into briefings)">[<b>{d}</b>]</span>
            <span className="pc">{c.updated_by || ''}</span>
            <button type="button" className="hm-del" disabled={busy}
                    onClick={() => wrapped(() => deleteProjectCondition(c.id))}
                    title="Delete this line — trivial on purpose">🗑</button>
          </div>
        );
      })}
      {conds && conds.length === 0 && (
        <div className="pc">No current conditions — nothing is known to be broken right now. When a
          zee reports a broken environment it cannot fix, add one line here (with a ticket ref) so
          the next zee does not rediscover it.</div>
      )}
      <div className="setup-row">
        <input value={add} placeholder='e.g. "the shared dev DSN is stale (TKT-47) — use `zee db-sandbox`"'
               onChange={(e) => setAdd(e.target.value)}
               onKeyDown={(e) => { if (e.key === 'Enter' && add.trim() && !busy) {
                 wrapped(() => addProjectCondition(project.id, add.trim(), 'human')).then(() => setAdd('')); } }} />
        <button type="button" className="pill" disabled={busy || !add.trim()}
                onClick={() => wrapped(() => addProjectCondition(project.id, add.trim(), 'human'))
                  .then(() => setAdd(''))}>＋ Add condition</button>
      </div>
    </div>
  );
}

function EnvironmentsSection({ project, run, busy }) {
  const [envs, setEnvs] = useState(null);
  const [add, setAdd] = useState({ key: '', tier: 'dev', label: '' });
  const load = useCallback(() => getEnvironments(project.id).then(setEnvs).catch(() => {}), [project.id]);
  useEffect(() => { load(); }, [load]);
  const wrapped = (fn) => run(async () => { await fn(); await load(); });
  const dupTier = (envs || []).some((e) => e.tier === add.tier);
  return (
    <div className="setup-sec">
      <h3>Environments <span className="pc">(the meta-DB source of truth for the untracked <code>.env</code> — a xell is loaded with one by tier)</span></h3>
      {(envs || []).map((e) => <EnvironmentEditor key={e.id} env={e} run={wrapped} busy={busy} />)}
      {envs && envs.length === 0 && <div className="pc">No environments yet — every project starts with a default <b>dev</b> and <b>prod</b>; add more (e.g. <i>staging</i>) below.</div>}
      <div className="setup-row">
        <select value={add.tier} onChange={(e) => setAdd({ ...add, tier: e.target.value })}
                title="dev serves dev/spinoff xells; prod serves production xells and any xell bound to the live prod db">
          <option value="dev">dev</option><option value="prod">prod</option>
        </select>
        <input value={add.key} placeholder="key (e.g. staging)" onChange={(e) => setAdd({ ...add, key: e.target.value })} />
        <input value={add.label} placeholder="label (optional)" onChange={(e) => setAdd({ ...add, label: e.target.value })} />
        <button type="button" disabled={busy || !add.key.trim()}
                onClick={() => wrapped(() => createEnvironment(project.id, {
                  key: add.key.trim(), tier: add.tier, label: add.label.trim() || null,
                  // first environment of a tier becomes that tier's default automatically
                  is_default: !dupTier,
                })).then(() => setAdd({ key: '', tier: 'dev', label: '' }))}>＋ Add environment</button>
      </div>
    </div>
  );
}

function EnvironmentEditor({ env, run, busy }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState(null);      // { environment, vars: [{name, is_secret, value|value_hint, length}] }
  const [add, setAdd] = useState({ name: '', value: '', is_secret: true });
  const [blob, setBlob] = useState('');
  const [lint, setLint] = useState(null);
  const loadVars = useCallback(() => getEnvVars(env.id).then(setData).catch(() => {}), [env.id]);
  useEffect(() => { if (open && !data) loadVars(); }, [open, data, loadVars]);
  const wrapped = (fn) => run(async () => { await fn(); await loadVars(); });

  const del = async () => {
    const pinned = Number(env.pinned_xells);
    const msg = env.is_default
      ? `"${env.key}" is the default ${env.tier} environment — ${env.tier}/spinoff xells resolve to it. Force-remove?`
      : pinned > 0 ? `${pinned} xell(s) are pinned to "${env.key}" — they'll fall back to the tier default. Remove?`
      : `Remove environment "${env.key}"?`;
    if (await showConfirm(msg, { variant: 'danger', okLabel: 'Remove' })) run(() => deleteEnvironment(env.id, env.is_default));
  };
  const reveal = async () => {
    const r = await exportEnv(env.id);
    await showAlert(
      <pre style={{ whiteSpace: 'pre-wrap', margin: 0, maxHeight: 360, overflow: 'auto', fontFamily: 'monospace', fontSize: 12 }}>{r.text || '(empty)'}</pre>,
      { title: `${env.key} (${env.tier}) — ${r.count} var(s), full values` });
  };
  const runLint = async () => { try { setLint(await lintEnv(env.id)); } catch (e) { setLint({ ok: false, reason: e.message }); } };
  const addVar = () => {
    if (!add.name.trim()) return;
    wrapped(() => setEnvVar(env.id, add.name.trim(), add.value, add.is_secret))
      .then(() => setAdd({ name: '', value: '', is_secret: true }));
  };
  const doImport = () => {
    if (!blob.trim()) return;
    wrapped(() => importEnv(env.id, blob)).then(() => setBlob(''));
  };

  return (
    <div className="siteed">
      <div className="setup-row">
        <span className={`sitetier t-${env.tier}`}>{env.tier}</span>
        <span className="sitekey">{env.key}{env.is_default ? ' ●' : ''}</span>
        <span className="pc">{env.var_count} var{Number(env.var_count) === 1 ? '' : 's'}{Number(env.pinned_xells) > 0 ? ` · ${env.pinned_xells} pinned` : ''}</span>
        <button type="button" className="ghost" onClick={() => setOpen(!open)}>{open ? '▾' : '▸'} vars</button>
        <button type="button" className="ghost" disabled={busy} onClick={reveal} title="Reveal the full .env (secrets included)">⤓ export</button>
        <button type="button" className="ghost" disabled={busy} onClick={runLint} title="Check coverage vs the repo's .env.example">✓ lint</button>
        {!env.is_default && <button type="button" className="ghost" disabled={busy}
          onClick={() => run(() => updateEnvironment(env.id, { is_default: true }))}>make default</button>}
        <button type="button" className="projpop-del" disabled={busy} title={`Remove ${env.key}`} onClick={del}>🗑</button>
      </div>
      {lint && (
        <div className="pc" style={{ marginLeft: 4 }}>
          {lint.ok
            ? <>vs <code>{lint.example}</code>: {lint.missing.length ? <span className="g-fail">missing {lint.missing.join(', ')}</span> : <span className="g-pass">all {lint.expected} keys present</span>}{lint.extra.length ? <> · extra {lint.extra.join(', ')}</> : null}</>
            : <>lint: {lint.reason}</>}
        </div>
      )}
      {open && (
        <div className="ingress" style={{ paddingLeft: 8 }}>
          {(data?.vars || []).map((v) => (
            <div className="setup-row" key={v.name}>
              <span className="mono" style={{ minWidth: 160 }}>{v.name}</span>
              {v.is_secret
                ? <span className="mono pc" title={`secret · ${v.length} chars`}>{v.value_hint}</span>
                : <span className="mono">{v.value}</span>}
              <span className="pc">{v.is_secret ? '🔒 secret' : 'plain'}</span>
              <button type="button" className="ghost" disabled={busy} title="Replace value"
                onClick={async () => {
                  const nv = await showPrompt(`New value for ${v.name}`, { placeholder: v.is_secret ? 'new secret value' : 'new value' });
                  if (nv !== null) wrapped(() => setEnvVar(env.id, v.name, nv, v.is_secret));
                }}>edit</button>
              <button type="button" className="projpop-del" disabled={busy} title={`Delete ${v.name}`}
                onClick={() => wrapped(() => deleteEnvVar(env.id, v.name))}>🗑</button>
            </div>
          ))}
          {data && data.vars.length === 0 && <div className="pc">No vars yet — add one, or paste a whole <code>.env</code> below.</div>}
          <div className="setup-row">
            <input value={add.name} placeholder="NAME" spellCheck={false}
                   onChange={(e) => setAdd({ ...add, name: e.target.value })} />
            <input value={add.value} placeholder="value" type={add.is_secret ? 'password' : 'text'} autoComplete="off"
                   onChange={(e) => setAdd({ ...add, value: e.target.value })}
                   onKeyDown={(e) => { if (e.key === 'Enter') addVar(); }} />
            <label className="pc" title="secrets are masked in the console; plain vars (ports, flags) show in full">
              <input type="checkbox" checked={add.is_secret} onChange={(e) => setAdd({ ...add, is_secret: e.target.checked })} /> secret</label>
            <button type="button" disabled={busy || !add.name.trim()} onClick={addVar}>＋ Add var</button>
          </div>
          <div className="setup-row" style={{ alignItems: 'flex-start' }}>
            <textarea value={blob} placeholder={'Paste a .env to bulk-import\nKEY=value per line'} rows={3}
                      spellCheck={false} style={{ flex: 1, fontFamily: 'monospace', fontSize: 12 }}
                      onChange={(e) => setBlob(e.target.value)} />
            <button type="button" disabled={busy || !blob.trim()} onClick={doImport} title="Parse KEY=value lines; each imported as a secret">⇪ Import .env</button>
          </div>
        </div>
      )}
    </div>
  );
}

function InventorySection({ project, run, busy }) {
  const [cs, setCs] = useState(null);
  const [sites, setSites] = useState([]);
  const [add, setAdd] = useState({ name: '', role: 'server', tier: 'prod', build_script: '' });
  const load = useCallback(() => getSharedContainers(project.id).then(setCs).catch(() => {}), [project.id]);
  useEffect(() => { load(); getSites(project.id).then((ss) => setSites(ss || [])).catch(() => {}); }, [load, project.id]);
  const wrapped = (fn) => run(async () => { await fn(); await load(); });
  return (
    <div className="setup-sec">
      <h3>Container inventory <span className="pc">(shared/prod — a ship needs ≥1 prod container with a build script)</span></h3>
      <DiscoverPanel project={project} sites={sites} busy={busy} onAdopted={load} />
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

// ── Discover on «site» — see what is really running on a prod site's docker context and adopt a
// chosen subset as that site's production inventory, without hand-typing a single container name.
// Read-only wrt docker (docker ps/inspect); adopt models each row (build_script stays NULL — never
// shippable as a side effect) AND links it to the site's production xell so it shows in the hex.
function DiscoverPanel({ project, sites, busy, onAdopted }) {
  const prodSites = (sites || []).filter((s) => s.tier === 'prod');
  const [siteId, setSiteId] = useState('');
  const [result, setResult] = useState(null);   // discoverSite() response, or null
  const [sel, setSel] = useState({});            // name -> { checked, role }
  const [working, setWorking] = useState(false);

  useEffect(() => { if (!siteId && prodSites[0]) setSiteId(prodSites[0].id); }, [prodSites.length]);
  if (prodSites.length === 0) {
    return <div className="pc" style={{ marginBottom: 8 }}>
      Add a <b>prod</b> deploy site above to discover and adopt a running stack automatically.
    </div>;
  }

  const discover = async () => {
    setWorking(true); setResult(null); setSel({});
    try {
      const r = await discoverSite(siteId);
      setResult(r);
      if (r.ok) {
        // Pre-check the not-yet-adopted containers, seeding each with its inferred role.
        const next = {};
        for (const c of r.containers) {
          const adoptable = !(c.already_modeled && c.linked_to_prod);
          next[c.name] = { checked: adoptable, role: c.inferred_role || '' };
        }
        setSel(next);
      }
    } catch (e) { setResult({ ok: false, error: e.message }); }
    finally { setWorking(false); }
  };

  const adopt = async () => {
    const containers = (result?.containers || [])
      .filter((c) => sel[c.name]?.checked && !(c.already_modeled && c.linked_to_prod))
      .map((c) => ({ name: c.name, role: sel[c.name].role, image_tag: c.image,
                     compose_project: c.compose_project,
                     host_port: c.ports?.[0]?.public || null,
                     internal_port: c.ports?.[0]?.private || null }));
    const bad = containers.find((c) => !['db', 'server', 'webapp', 'infra'].includes(c.role));
    if (bad) { await showAlert(`Choose a role for "${bad.name}" before adopting.`, { variant: 'error' }); return; }
    if (containers.length === 0) { await showAlert('Nothing selected to adopt.'); return; }
    setWorking(true);
    try {
      const r = await adoptContainers(siteId, containers);
      await onAdopted?.();
      await discover();   // re-discover so adopted rows now show as already-modeled (idempotency, visible)
      await showAlert(`Adopted ${r.adopted.length}, linked ${r.linked.length} to production`
        + `${r.skipped.length ? `, ${r.skipped.length} already modeled` : ''}.`);
    } catch (e) { await showAlert(e.message, { variant: 'error' }); }
    finally { setWorking(false); }
  };

  const setRole = (name, role) => setSel((s) => ({ ...s, [name]: { ...s[name], role } }));
  const toggle = (name) => setSel((s) => ({ ...s, [name]: { ...s[name], checked: !s[name]?.checked } }));
  const disabled = busy || working;

  return (
    <div className="siteed" style={{ marginBottom: 10 }}>
      <div className="setup-row">
        <span className="pc">Discover running stack on</span>
        <select value={siteId} onChange={(e) => { setSiteId(e.target.value); setResult(null); }} disabled={disabled}>
          {prodSites.map((s) => <option key={s.id} value={s.id}>{s.key}{s.is_default ? ' ●' : ''} · {s.docker_ctx}</option>)}
        </select>
        <button type="button" disabled={disabled || !siteId} onClick={discover}>{working ? '…' : '🔍 Discover'}</button>
      </div>

      {result && !result.ok && (
        <div className="pc" style={{ color: 'var(--danger, #d66)', marginTop: 6 }}>
          ⚠ {result.error}
        </div>
      )}
      {result?.ok && result.count === 0 && (
        <div className="pc" style={{ marginTop: 6 }}>
          Context <span className="mono">{result.docker_ctx}</span> is reachable but has no containers.
        </div>
      )}
      {result?.ok && result.prod_xell_missing && (
        <div className="pc" style={{ color: 'var(--danger, #d66)', marginTop: 6 }}>
          ⚠ This site has no production xell yet — adopting will model the rows but cannot link them to the hex.
        </div>
      )}
      {result?.ok && result.count > 0 && (
        <div style={{ marginTop: 6 }}>
          {result.containers.map((c) => {
            const done = c.already_modeled && c.linked_to_prod;
            const s = sel[c.name] || {};
            return (
              <div key={c.name} className="setup-row discover-row" style={{ opacity: done ? 0.55 : 1 }}>
                <input type="checkbox" checked={!!s.checked} disabled={disabled || done} onChange={() => toggle(c.name)}
                       title={done ? 'already adopted' : 'select to adopt'} />
                <span className="mono" title={`${c.image || ''} · ${c.status || c.state || ''}`}>{c.name}</span>
                <span className="pc" title="published ports">
                  {c.compose_service ? `${c.compose_project}/${c.compose_service}` : (c.labelled ? '—' : 'unlabelled')}
                  {c.ports?.length ? ` :${c.ports.map((p) => p.public).join(',')}` : ''}
                </span>
                {done
                  ? <span className="pc" style={{ color: 'var(--ok, #6a6)' }}>adopted ✓</span>
                  : c.already_modeled
                    ? <><select value={s.role || ''} disabled><option>{c.modeled_as?.role}</option></select>
                        <span className="pc">modeled — will link to prod</span></>
                    : <>
                        <select value={s.role || ''} disabled={disabled} onChange={(e) => setRole(c.name, e.target.value)}>
                          <option value="">role?</option>
                          {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                        </select>
                        <span className="pc" title="why this role was guessed">{c.role_reason}</span>
                      </>}
              </div>
            );
          })}
          <div className="setup-row" style={{ marginTop: 4 }}>
            <button type="button" disabled={disabled} onClick={adopt}>＋ Adopt selected</button>
            <span className="pc">build script stays empty — set it below to make a container shippable.</span>
          </div>
        </div>
      )}
    </div>
  );
}

// Remaining usage limit for ONE provider account. Source: provider_token.usage_limit (migration
// 203), written by the LLM gateway from the provider's own response headers. Never per-xell.
// "X% free" is available_pct — how much of the binding window is still AVAILABLE.
function AccountUsageLimit({ account }) {
  const pct = account?.available_pct;
  const rl = account?.usage_limit || {};
  const win = rl.windows || {};
  if (pct == null && !account?.usage_limit) {
    return (
      <span className="token-usage-limit is-empty" data-testid="account-usage-limit-empty"
            title="No limit snapshot yet — it appears after a zee call authenticates with this account through the gateway">
        limit: —
      </span>
    );
  }
  const bits = [];
  if (win['5h']?.available_pct != null) bits.push(`5h ${win['5h'].available_pct}%`);
  if (win['7d']?.available_pct != null) bits.push(`7d ${win['7d'].available_pct}%`);
  if (rl.tokens?.available_pct != null && !bits.length) {
    bits.push(`TPM ${rl.tokens.available_pct}%`);
  }
  // A BALANCE snapshot (deepseek: no % window exists, the quota IS a dollar balance). The
  // first balance row is the account's money; is_available says whether calls still work.
  const balanceRow = (Array.isArray(rl.balance) ? rl.balance[0] : null) || null;
  const balanceText = balanceRow?.total_balance
    ? `${balanceRow.currency || ''} ${balanceRow.total_balance}`.trim()
    : null;
  const title = [
    pct != null ? `${pct}% of the binding window still available` : 'limit snapshot present',
    bits.length ? bits.join(' · ') : null,
    rl.representative ? `binding: ${rl.representative}` : null,
    balanceText ? `balance: ${balanceText}` : null,
    account.usage_limit_at ? `as of ${new Date(account.usage_limit_at).toLocaleString()}` : null,
  ].filter(Boolean).join('\n');
  const cls = pct != null && pct < 20 ? ' is-tight' : pct != null && pct < 40 ? ' is-warn' : '';
  return (
    <span className={`token-usage-limit${cls}`} data-testid="account-usage-limit" title={title}>
      {pct != null ? `${pct}% free` : balanceText ? `limit: ${balanceText}` : 'limit: ok'}
      {bits.length ? ` (${bits.join(', ')})` : ''}
    </span>
  );
}

// ── agent providers: the per-project credential a CXELLD zee runs on ───────────
// Provider ACCOUNTS, stored in the meta-DB. A project can hold several accounts of one provider
// type — e.g. two Claude subscriptions — each with its own label, its own prompt button in the
// header, and its own last-used date. The human does the OAuth: copy the command, run it in a
// terminal, authorize in the browser, paste the token back (plus an optional label naming the
// account). The server only ever returns a masked hint — a connected token cannot be read back.
// Remaining usage limit is per ACCOUNT (usage_limit), not per xell.
function TokensSection({ project, run, busy }) {
  const [tokens, setTokens] = useState(null);
  const [open, setOpen] = useState(null);     // provider key whose add-account panel is open
  const [paste, setPaste] = useState('');
  const [label, setLabel] = useState('');
  const [copied, setCopied] = useState(false);
  // Per-provider spend-alert input draft (migration 206): keyed by provider, undefined until the
  // human edits. Kept separate from the loaded row so typing does not fight a refresh — on save the
  // draft is cleared and the row re-reads the saved value.
  const [alertDraft, setAlertDraft] = useState({});
  const load = useCallback(() => getProviderTokens(project.id).then(setTokens).catch(() => {}), [project.id]);
  useEffect(() => { load(); }, [load]);
  const wrapped = (fn) => run(async () => { await fn(); await load(); });
  // Save ONE provider's spend-alert amount (USD). Empty / invalid clears it. The draft is cleared
  // after save so the input re-binds to the server value (null → placeholder).
  const saveAlert = (p) => {
    const raw = alertDraft[p.provider];
    const v = String(raw ?? '').trim();
    wrapped(() => setProviderAlertAmount(project.id, p.provider, v === '' ? null : v))
      .then(() => setAlertDraft((d) => ({ ...d, [p.provider]: undefined })))
      .catch(() => {});
  };

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
  // Pausing disables the account for every dispatch surface without disconnecting it — the token
  // stays connected and can be resumed (or still deleted) at any time.
  const pauseToggle = async (p, a) => {
    const name = a.label || `${p.label} ${a.token_hint || ''}`;
    if (a.paused) {
      if (await showConfirm(`Resume the "${name}" account?\n\nDispatches on it are enabled again.`, { okLabel: 'Resume' })) {
        wrapped(() => resumeProviderAccount(project.id, a.id));
      }
    } else {
      const reason = await showPrompt(`Pause the "${name}" account?\n\nNo dispatch on it can start a zee while it is paused (the token stays connected). You can resume it here any time.\n\nWhy pause it? (optional)`, { placeholder: 'e.g. rate-limited, bad token, billing issue' });
      if (reason !== null) wrapped(() => pauseProviderAccount(project.id, a.id, String(reason || '').trim() || null));
    }
  };

  return (
    <div className="setup-sec">
      <h3>Agent providers <span className="pc">(the credential a cxell zee spawns with — stored in the meta-DB, never echoed back. Several accounts of one provider are fine: each gets its own prompt button. Remaining usage limit is per ACCOUNT, refreshed from the provider's own response headers whenever a call crosses the gateway.)</span></h3>
      {(tokens || []).map((p) => (
        <div key={p.provider} className="siteed">
          <div className="setup-row">
            <span className="sitekey">{p.label}</span>
            {!p.connected && <span className="gate g-warn">△ not connected</span>}
            {p.available_pct != null && (
              <span className={`token-usage-limit${p.available_pct < 20 ? ' is-tight' : p.available_pct < 40 ? ' is-warn' : ''}`}
                    data-testid={`provider-limit-${p.provider}`}
                    title="Worst remaining quota across this provider's active accounts">
                {p.available_pct}% free
              </span>
            )}
            {/* PER-PROVIDER SPEND-ALERT (migration 206): a USD amount — when a xell's gateway-ledger
                spend on this provider exceeds it, that xell's hexagon shows an over-budget indicator.
                Empty clears the alert. Saves on blur / Enter. */}
            <span className="pc" title="When a xell's spend on this provider exceeds this amount (USD), its hexagon shows an over-budget alert.">
              alert $
            </span>
            <input
              className="mono"
              style={{ width: 72 }}
              type="number" min="0" step="0.01"
              placeholder="no alert"
              value={alertDraft[p.provider] ?? p.alert_amount ?? ''}
              onChange={(e) => setAlertDraft((d) => ({ ...d, [p.provider]: e.target.value }))}
              onBlur={() => saveAlert(p)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } }}
              data-testid={`provider-alert-${p.provider}`}
            />
            <button type="button" className="ghost"
                    onClick={() => { setOpen(open === p.provider ? null : p.provider); setPaste(''); setLabel(''); }}>
              {open === p.provider ? '▾ cancel' : p.connected ? '＋ add another account' : '＋ connect'}
            </button>
          </div>
          {(p.accounts || []).map((a) => (
            <div className="setup-row" key={a.id} data-testid={`token-account-${p.provider}`}>
              {a.paused ? (
                <span className="gate g-warn" title={a.reason ? `paused: ${a.reason}` : 'paused'}
                      data-testid={`token-account-${p.provider}-paused`}>
                  ⏸ {a.label ? <b>{a.label} · </b> : null}<span className="mono">{a.token_hint}</span>
                  {a.paused_by ? ` · paused by ${a.paused_by}` : ' · paused'}
                  {a.reason ? ` — ${a.reason}` : ''}
                </span>
              ) : (
                <span className="gate g-pass" title={a.created_at ? `connected ${new Date(a.created_at).toLocaleDateString()}` : ''}>
                  ✓ {a.label ? <b>{a.label} · </b> : null}<span className="mono">{a.token_hint}</span>
                  {a.last_used_at ? ` · used ${new Date(a.last_used_at).toLocaleDateString()}` : ' · never used'}
                </span>
              )}
              {/* Remaining usage limit for THIS account (Claude 5h/7d seat, API TPM/RPM). Null
                  until the gateway has authenticated one call with this key. */}
              <AccountUsageLimit account={a} />
              <button type="button" className="projpop-del" disabled={busy}
                      title={a.paused ? `Resume this ${p.label} account` : `Pause this ${p.label} account — no dispatch can use it while paused`}
                      onClick={() => pauseToggle(p, a)}>{a.paused ? '▶' : '⏸'}</button>
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
                  {/* the SHAPE to paste comes from the provider registry (server-side copy), so a
                      vendor with a different-looking credential — a Grok seat session is a JSON
                      object, not an sk-… string — never shows claude's example */}
                  <input type="password" autoComplete="off" value={paste} placeholder={p.placeholder || 'paste it here'}
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

// ── ticket API keys: the credential a DEPLOYED project files tickets with ─────
// The outside of the work tracker (docs/ticketing-api.md). A key names ONE project, so a deployed
// system — omnibiz, say — can only ever file into its own board; the console is where a human mints
// one and hands it over. The plaintext exists ONCE, in the answer to the mint: the panel shows it
// until the human dismisses it, and after that every read is a masked hint (lib/project-api-keys.js).
function ApiKeysSection({ project, run, busy }) {
  const [keys, setKeys] = useState(null);
  const [label, setLabel] = useState('');
  const [minted, setMinted] = useState(null);   // the plaintext, shown once
  const [copied, setCopied] = useState(false);
  const [ext, setExt] = useState(null);          // { base_url, base_url_note } — the address a deployed project POSTs to
  const load = useCallback(() => getProjectApiKeys(project.id).then(setKeys).catch(() => {}), [project.id]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { getExtV1Info().then(setExt).catch(() => {}); }, []);

  const mint = () => run(async () => {
    const out = await createProjectApiKey(project.id, label.trim());
    setMinted(out); setLabel(''); await load();
  });
  const copy = async (text) => {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }
    catch { /* clipboard denied — the key is visible to select anyway */ }
  };
  // Revoke is the normal end of a key. Delete is offered only for one that filed nothing; the
  // server refuses the rest (a ticket must keep saying where it came from), so this asks first.
  const revoke = async (k) => {
    if (await showConfirm(`Revoke "${k.label}"?\n\nThe next call with this key is refused. Anything it already filed stays on the board.`,
                          { variant: 'danger', okLabel: 'Revoke' })) {
      run(async () => { await revokeProjectApiKey(project.id, k.id); await load(); });
    }
  };
  const drop = async (k) => {
    if (await showConfirm(`Delete "${k.label}"?\n\nIt filed nothing, so nothing loses its provenance.`,
                          { variant: 'danger', okLabel: 'Delete' })) {
      run(async () => { await deleteProjectApiKey(project.id, k.id); await load(); });
    }
  };

  const live = (keys || []).filter((k) => !k.revoked);
  return (
    <div className="setup-sec">
      <h3>Ticketing API keys <span className="pc">(what a deployed {project.name} presents to <span className="mono">/api/ext/v1</span> to file, monitor and update tickets on THIS board — see docs/ticketing-api.md)</span></h3>
      <div className="pc" style={{ marginBottom: 8 }}>
        A key names one project and nothing else: the caller never sends a project id, so it cannot
        reach another board. Tickets filed through it are ordinary tickets — break them down and
        assign zees exactly as usual.
      </div>

      <div className="pc" style={{ marginBottom: 8 }}>
        <b>The address a deployed project uses:</b>{' '}
        {ext?.base_url ? (
          <span className="mono">{ext.base_url}</span>
        ) : (
          <span className="gate g-warn">not configured — no externally-reachable address</span>
        )}{' '}
        <button type="button" className="ghost" onClick={() => navigator.clipboard?.writeText(ext?.base_url || '')}
                title="Copy the base URL">⧉ copy</button>
        {ext?.base_url_note ? <div className="pc">{ext.base_url_note}</div> : null}
      </div>

      {minted && (
        <div className="siteed" data-testid="api-key-minted">
          <div className="setup-row"><span className="gate g-pass">✓ minted “{minted.label}”</span>
            <span className="pc">copy it now — this is the only time it is shown</span></div>
          <div className="setup-row">
            <input className="mono" readOnly value={minted.key} onFocus={(e) => e.target.select()} />
            <button type="button" onClick={() => copy(minted.key)}>{copied ? '✓ copied' : '⧉ copy'}</button>
            <button type="button" className="ghost" onClick={() => setMinted(null)}>done</button>
          </div>
          <div className="pc">Store it as a secret in the deployed project, then:</div>
          <input className="mono" readOnly onFocus={(e) => e.target.select()}
                 value={`curl -X POST $ZEEHIVE/api/ext/v1/tickets -H "Authorization: Bearer ${minted.key}" -H "Content-Type: application/json" -d '{"title":"…","external_ref":"YOUR-ID"}'`} />
        </div>
      )}

      {(keys || []).map((k) => (
        <div className="setup-row" key={k.id} data-testid="api-key-row">
          {k.revoked ? (
            <span className="gate g-warn" title={k.revoked_by ? `revoked by ${k.revoked_by}` : 'revoked'}>
              ⏸ <b>{k.label}</b> · <span className="mono">{k.key_hint}</span> · revoked
            </span>
          ) : (
            <span className="gate g-pass" title={(k.scopes || []).join(', ')}>
              ✓ <b>{k.label}</b> · <span className="mono">{k.key_hint}</span>
              {k.last_used_at ? ` · used ${new Date(k.last_used_at).toLocaleDateString()}` : ' · never used'}
              {k.tickets_filed ? ` · ${k.tickets_filed} ticket${k.tickets_filed === 1 ? '' : 's'} filed` : ''}
            </span>
          )}
          {!k.revoked && <button type="button" className="projpop-del" disabled={busy}
                                 title="Revoke this key — the next call with it is refused"
                                 onClick={() => revoke(k)}>⏸</button>}
          {!k.tickets_filed && <button type="button" className="projpop-del" disabled={busy}
                                       title="Delete this key (it filed nothing)" onClick={() => drop(k)}>🗑</button>}
        </div>
      ))}
      {keys && !keys.length && <div className="pc">No keys yet — nothing outside ZEEHIVE can file a ticket here.</div>}

      <div className="setup-row" style={{ marginTop: 8 }}>
        <input value={label} placeholder="label — who holds it, e.g. “omnibiz helpdesk”"
               onChange={(e) => setLabel(e.target.value)}
               onKeyDown={(e) => { if (e.key === 'Enter' && label.trim()) { e.preventDefault(); mint(); } }} />
        <button type="button" disabled={busy || !label.trim()} onClick={mint}>＋ Mint a key</button>
      </div>
      {live.length > 0 && <div className="pc">Read/write on tickets. Revoke a key the moment it leaks — a revoked key is refused on its next call.</div>}
    </div>
  );
}

function SpawnSection({ project, run }) {
  const [pc, setPc] = useState(null);
  const [runtimes, setRuntimes] = useState([]);
  const [harnesses, setHarnesses] = useState([]);
  const [ctxs, setCtxs] = useState([]);
  useEffect(() => {
    getPoolConfig(project.id).then(setPc).catch(() => {});
    getRuntimes().then(setRuntimes).catch(() => {});
    // Non-core, enabled harnesses only — core is the always-on law layer, never a selectable default.
    // The project DEFAULT harness is what a bare dispatch attaches to a pooled xell — always a
    // worker. A manager gets its harness when a human adds it, so manager personas are not offered.
    // …and scoped to THIS project (084): another project's persona cannot be this project's default
    // (pool_default_harness_scope_guard refuses it), so it is never offered here.
    getHarnesses('worker', project.id).then((hs) => setHarnesses(hs.filter((h) => !h.is_law_core))).catch(() => {});
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
        <label>Default harness <span className="pc">(persona a bare dispatch wears)</span>
          <select value={pc.harness_key || ''} onChange={(e) => save({ default_harness_key: e.target.value })}>
            <option value="">core only (no persona)</option>
            {harnesses.map((h) => <option key={h.key} value={h.key}>{h.label}{h.scope === 'project' ? ' ⌂ (this project)' : ''}</option>)}
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
        <label className="setup-check">Capture LLM gateway bodies
          <input type="checkbox" checked={pc.gateway_body_capture !== false}
                 onChange={(e) => save({ gateway_body_capture: e.target.checked })} />
          <span className="pc">(store the request/response body behind each gateway call for the observability drill-down — 14-day retention, secrets scrubbed)</span>
        </label>
      </div>
      <PrepEditor pc={pc} save={save} />
    </div>
  );
}

// ── the spawn template's DEPENDENCIES and CACHE (migration 121) ────────────────────────────────
// What gets installed into a fresh xell before its zee starts, and how that install is cached. Two
// costs this replaces, both of them paid every single spawn:
//   • the install list was hard-coded in the queenzee (npm ci + the web build, for every project of
//     every fleet), so a project that also needs psql or build tools had every zee discover the gap
//     mid-turn — `psql` is in a zee's own binding and was not in its cage;
//   • the ONE lever that makes a spawn fast (a warm shared cache + --prefer-offline) was a
//     fleet-wide env var, so it could not be tuned per project at all.
// The steps are ordered, and they run in order: root steps (apt) first in their own root exec, then
// the rest as the zee user in /work/repo. Everything here is best-effort at spawn — a step that
// fails makes a slower zee, never a failed dispatch.
// Exported for test/spawn-prep-console.test.mjs: this editor writes a template the QUEENZEE turns
// into a script, so what it emits is asserted against the real normalizer rather than eyeballed.
export function PrepEditor({ pc, save }) {
  const prep = pc.spawn_prep || { steps: [], cache: {} };
  const presets = pc.spawn_prep_presets || [];
  const [adding, setAdding] = useState('');
  const steps = prep.steps || [];
  const cache = prep.cache || {};
  // Always send the WHOLE template — steps, cache AND when. A save that posted only the field the
  // human touched would silently reset the other two to their defaults, because the API normalizes
  // what it is given rather than merging it.
  const put = (next) => save({ spawn_prep: {
    steps: next.steps ?? steps, cache: next.cache ?? cache, when: next.when ?? (prep.when || 'dispatch') } });
  const patchStep = (i, patch) => put({ steps: steps.map((s, n) => (n === i ? { ...s, ...patch } : s)) });
  const removeStep = (i) => put({ steps: steps.filter((_, n) => n !== i) });
  const moveStep = (i, d) => {
    const next = steps.slice();
    const j = i + d;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j], next[i]];
    put({ steps: next });
  };
  const addPreset = (key) => {
    const preset = presets.find((x) => x.key === key);
    if (!preset) return;
    // A second copy of a preset needs its own key — the key is what the PREP_STEP timing markers are
    // reported under, and two steps answering to one name is a report nobody can read.
    let k = preset.key, n = 2;
    while (steps.some((s) => s.key === k)) k = `${preset.key}-${n++}`;
    const { hint, ...step } = preset;
    put({ steps: [...steps, { ...step, key: k, enabled: true }] });
    setAdding('');
  };
  return (
    <div className="setup-sub" data-testid="spawn-prep">
      <h4>Dependencies &amp; cache <span className="pc">
        installed into every new xell before its zee starts
        {pc.spawn_prep_custom ? '' : ' — currently the built-in default'}</span></h4>
      <div className="setup-grid">
        <label>Prep runs <span className="pc">(who pays for the install — the pool, or the waiting human)</span>
          <select value={prep.when || 'dispatch'} data-testid="prep-when"
                  onChange={(e) => put({ when: e.target.value })}>
            <option value="dispatch">at dispatch — in the cage, while a human waits</option>
            <option value="image">bake packages into an image — the pool builds it</option>
            <option value="provision">at provision — the whole cage, prepped in the pool</option>
          </select></label>
        <label>npm cache <span className="pc">(the fleet volume is why a spawn is not a download)</span>
          <select value={cache.npm || 'shared'} data-testid="prep-npm-cache"
                  onChange={(e) => put({ cache: { ...cache, npm: e.target.value } })}>
            <option value="shared">shared across the fleet (fast)</option>
            <option value="container">per-container (cold every time)</option>
          </select></label>
        <label>apt cache <span className="pc">(only mounted when a step installs packages)</span>
          <select value={cache.apt || 'shared'} data-testid="prep-apt-cache"
                  onChange={(e) => put({ cache: { ...cache, apt: e.target.value } })}>
            <option value="shared">shared archive volume</option>
            <option value="off">off</option>
          </select></label>
        <label className="prep-check">
          <span><input type="checkbox" checked={!!cache.npm_prefer_offline} data-testid="prep-prefer-offline"
                       onChange={(e) => put({ cache: { ...cache, npm_prefer_offline: e.target.checked } })} />
            {' '}npm --prefer-offline</span>
          <span className="pc">skip registry revalidation — measured as no faster off a warm cache, keep for a slow one</span>
        </label>
        <label className="prep-check">
          <span><input type="checkbox" checked={!!cache.npm_omit_dev} data-testid="prep-omit-dev"
                       onChange={(e) => put({ cache: { ...cache, npm_omit_dev: e.target.checked } })} />
            {' '}npm --omit=dev</span>
          <span className="pc">skip devDependencies — faster, but a zee cannot run the tests</span>
        </label>
      </div>
      <div className="prep-steps">
        {steps.map((s, i) => (
          <div className={`prep-step${s.enabled ? '' : ' off'}`} key={s.key} data-testid={`prep-step-${s.key}`}>
            <div className="setup-row">
              <input type="checkbox" checked={!!s.enabled} title="run this step at spawn"
                     data-testid={`prep-toggle-${s.key}`}
                     onChange={(e) => patchStep(i, { enabled: e.target.checked })} />
              <span className={`sitetier t-${s.kind === 'apt' ? 'prod' : 'dev'}`}>{s.kind}</span>
              <span className="sitekey">{s.label || s.key}</span>
              {s.kind === 'apt' && (
                <input className="prep-arg" defaultValue={(s.packages || []).join(' ')} spellCheck={false}
                       data-testid={`prep-arg-${s.key}`} placeholder="package names, space separated"
                       onBlur={(e) => e.target.value.trim() !== (s.packages || []).join(' ')
                         && patchStep(i, { packages: e.target.value.trim().split(/[\s,]+/).filter(Boolean) })} />
              )}
              {s.kind === 'npm-run' && (
                <input className="prep-arg" defaultValue={s.script} spellCheck={false}
                       data-testid={`prep-arg-${s.key}`} placeholder="build --workspace web"
                       onBlur={(e) => e.target.value.trim() !== s.script && patchStep(i, { script: e.target.value.trim() })} />
              )}
              {s.kind === 'shell' && (
                <input className="prep-arg" defaultValue={s.run} spellCheck={false}
                       data-testid={`prep-arg-${s.key}`} placeholder="a shell command, run in /work/repo"
                       onBlur={(e) => e.target.value.trim() !== s.run && patchStep(i, { run: e.target.value.trim() })} />
              )}
              {s.kind === 'npm' && <span className="pc">npm ci (npm install only where there is no lockfile)</span>}
              <span className="prep-actions">
                <button className="projpop-del" title="move earlier" disabled={i === 0} onClick={() => moveStep(i, -1)}>↑</button>
                <button className="projpop-del" title="move later" disabled={i === steps.length - 1} onClick={() => moveStep(i, 1)}>↓</button>
                <button className="projpop-del" title="remove this step" data-testid={`prep-remove-${s.key}`}
                        onClick={() => removeStep(i)}>✕</button>
              </span>
            </div>
          </div>
        ))}
        {!steps.length && <div className="pc">No prep at all — every zee installs its own dependencies, on its own clock.</div>}
        {prep.when === 'provision' && (
          <div className="pc" data-testid="prep-when-note">
            Provisioning creates and installs each pooled xell's cage, so a dispatch installs nothing —
            at the cost of one live container per pooled xell. A dispatch still falls back to installing
            in-cage if the pre-warmed cage is gone or the branch's lockfile moved.
          </div>
        )}
        {prep.when === 'image' && (
          <div className="pc" data-testid="prep-when-note">
            The pool bakes the apt packages into a per-template image, so apt costs nothing at spawn.
            The npm steps still run at dispatch — they depend on the branch's lockfile.
          </div>
        )}
      </div>
      <div className="setup-row prep-add">
        <select value={adding} data-testid="prep-add" onChange={(e) => addPreset(e.target.value)}>
          <option value="">+ add a step…</option>
          {presets.map((x) => <option key={x.key} value={x.key}>{x.label}{x.hint ? ` — ${x.hint}` : ''}</option>)}
        </select>
        {pc.spawn_prep_custom && (
          <button className="projpop-del" data-testid="prep-reset"
                  title="back to the built-in default (npm ci + the web prebuild)"
                  onClick={() => save({ spawn_prep: null })}>reset to default</button>
        )}
      </div>
    </div>
  );
}
