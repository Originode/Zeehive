import React, { useEffect, useState, useCallback, useRef } from 'react';
import { getFleet, getRuntimes, getTimeline, getDiffs, getLogs, subscribe, markDone, setDefaultRuntime,
         getProjects, createProject, deleteProject, setPoolTarget } from './api.js';
import GitRail from './GitRail.jsx';
import Connectors from './Connectors.jsx';
import Terminal from './Terminal.jsx';
import ProjectMenu from './ProjectMenu.jsx';
import { nick } from './nick.js';

const PROJECT_KEY = 'xeehive.project';

const ROLE_LABEL = { db: 'DB', server: 'Server', webapp: 'Webapp', other: 'Other' };
const shortSid = (s) => (s ? s.slice(0, 8) : '—');
const base = (p) => (p ? p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() : '—');

// small square container box: 3-hex nickname + online/offline dot (hover = full name)
function ChipBox({ c }) {
  const inner = (<><span className="cnick">{nick(c.name)}</span><span className={`cdot ${c.health}`} /></>);
  const title = `${c.name}\n${c.tier} · ${c.health}${c.url ? '\n' + c.url : ''}`;
  return c.url
    ? <a className={`cbox h-${c.health}`} href={c.url} target="_blank" rel="noopener" title={title} onClick={(e) => e.stopPropagation()}>{inner}</a>
    : <span className={`cbox h-${c.health}`} title={title}>{inner}</span>;
}

export default function App() {
  const [projects, setProjects] = useState([]);
  const [projectId, setProjectId] = useState(null);
  const [fleet, setFleet] = useState(null);
  const [timeline, setTimeline] = useState(null);
  const [runtimes, setRuntimes] = useState([]);
  const [runtime, setRuntime] = useState(null);
  const [conn, setConn] = useState('connecting');
  const [version, setVersion] = useState(0);
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [diffs, setDiffs] = useState({});
  const [logs, setLogs] = useState([]);
  const [showTerm, setShowTerm] = useState(false);
  const layoutRef = useRef(null);

  // Always-current selected project, so async fetches from a *previous* selection can be
  // dropped instead of clobbering the newly-selected project's data (fixes the switch race).
  const projectIdRef = useRef(null);
  useEffect(() => { projectIdRef.current = projectId; }, [projectId]);
  const applyFleet = useCallback((f) => {
    if (f && (!projectIdRef.current || f.project?.id === projectIdRef.current)) setFleet(f);
  }, []);

  const loadProjects = useCallback(async () => {
    const ps = await getProjects();
    setProjects(ps);
    return ps;
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [f, t, d] = await Promise.all([getFleet(projectId), getTimeline(projectId), getDiffs(projectId)]);
      applyFleet(f);
      if (t) setTimeline(t);
      if (d) setDiffs(d);
      loadProjects();               // keep the switcher's xell counts fresh
      setVersion((v) => v + 1);
    } catch { /* keep last */ }
  }, [projectId, loadProjects, applyFleet]);

  // once: global runtimes + logs, and pick the active project (persisted → first)
  useEffect(() => {
    getRuntimes().then((rs) => {
      const enabled = rs.filter((r) => r.enabled);
      setRuntimes(enabled);
      if (enabled[0]) setRuntime(enabled[0].key);
    });
    getLogs().then((ls) => setLogs(ls));
    loadProjects().then((ps) => {
      const stored = localStorage.getItem(PROJECT_KEY);
      setProjectId(ps.find((p) => p.id === stored) ? stored : (ps[0]?.id || null));
    });
  }, [loadProjects]);

  // (re)load the selected project's data + subscribe to its live stream. Re-runs when the
  // selected project changes (projectId may be null on first paint → server uses the default).
  useEffect(() => {
    setConn('connecting');
    setTimeline(null); setDiffs({});   // don't show the previous project's git graph while loading
    getTimeline(projectId).then((t) => { if (t) { setTimeline(t); setVersion((v) => v + 1); } });
    getDiffs(projectId).then((d) => d && setDiffs(d));
    const unsub = subscribe(projectId, {
      onSnapshot: (f) => { applyFleet(f); setConn('live'); },
      onChange: refresh,
      onStatus: setConn,
      onLog: (l) => setLogs((prev) => [...prev.slice(-499), l]),
    });
    return unsub;
  }, [projectId, refresh, applyFleet]);

  const selectProject = useCallback((id) => {
    setProjectId(id);
    localStorage.setItem(PROJECT_KEY, id);
  }, []);

  const handleCreate = useCallback(async (body) => {
    const p = await createProject(body);
    await loadProjects();
    return p;
  }, [loadProjects]);

  const handleDelete = useCallback(async (id, force) => {
    const r = await deleteProject(id, force);
    const ps = await loadProjects();
    if (id === projectId) {
      const next = ps[0]?.id || null;
      setProjectId(next);
      if (next) localStorage.setItem(PROJECT_KEY, next); else localStorage.removeItem(PROJECT_KEY);
    }
    return r;
  }, [loadProjects, projectId]);

  if (!fleet) return <div className="app"><p className="loading">Connecting to queenzee…</p></div>;

  const { project, status, containers } = fleet;

  // Sort xells left→right by commit recency: the LEADING one (base nearest the tip) goes
  // leftmost, so the timeline connectors fan out monotonically and never tangle.
  const order = {};
  if (timeline) {
    for (const tx of timeline.xells) {
      const ci = timeline.commits.findIndex((c) => c.hash === tx.base_commit);
      order[tx.id] = ci < 0 ? 9999 : ci;
    }
  }
  const xells = [...fleet.xells].sort((a, b) => (order[a.id] ?? 9999) - (order[b.id] ?? 9999));

  return (
    <div className="layout" ref={layoutRef}>
      <Connectors timeline={timeline} layoutRef={layoutRef} version={version} />
      <GitRail timeline={timeline} collapsed={railCollapsed}
               onToggle={() => { setRailCollapsed((c) => !c); setVersion((v) => v + 1); }} />
      <div className="content">
      <header className="topbar">
        <div className="proj">
          <span className="k">Project:</span> <b>{project.name}</b>
          <ProjectMenu projects={projects} currentId={projectId || project.id}
                       onSelect={selectProject} onCreate={handleCreate} onDelete={handleDelete} />
          <span className="k folder">Folder:</span> <span className="mono">{project.repo_root}</span>
        </div>
        <div className="right">
          <RuntimeToggle runtimes={runtimes} value={runtime}
                         onChange={(k) => { setRuntime(k); setDefaultRuntime(k); }} />
          <span className={`conn ${conn}`}>{conn === 'live' ? '● live' : '○ ' + conn}</span>
        </div>
      </header>

      <div className="statusline" data-testid="statusline">
        <span className="k">Status:</span>{' '}
        <b>{status.inUse}</b> of <b>{status.total}</b> xells in use
        <span className="sub"> ({status.working} active · {status.ready} ready)</span>
        <PoolTarget pool={fleet.pool} projectId={projectId || project.id} />
        <button className="term-btn" data-testid="term-btn" title="Open queenzee terminal"
                onClick={() => setShowTerm(true)}>▚_</button>
      </div>

      <section className="inventory">
        {['db', 'server', 'webapp', 'other'].map((role) => (
          <div className="invrow" key={role} data-role={role}>
            <span className="invlabel">{ROLE_LABEL[role]}:</span>
            <span className="boxes">
              {(containers[role] || []).map((c) => <ChipBox key={c.id} c={c} />)}
              {(!containers[role] || containers[role].length === 0) && <span className="cbox empty">—</span>}
            </span>
          </div>
        ))}
      </section>

      <h2 className="xells-h">xells:</h2>
      <section className="xells">
        {xells.map((x) => <XellCard key={x.id} x={x} diff={diffs[x.id]} onDone={refresh} />)}
        {xells.length === 0 && <p className="loading">No active xells. The pool maintainer will fill it shortly…</p>}
      </section>
      </div>
      {showTerm && <Terminal logs={logs} onClose={() => setShowTerm(false)} />}
    </div>
  );
}

// How many ready xells queenzee pre-warms for this project (pool_config.target_ready).
// Takes effect only when the pool maintainer is running (POOL_ENABLED != false).
function PoolTarget({ pool, projectId }) {
  const [n, setN] = useState(pool?.target_ready ?? 0);
  useEffect(() => { setN(pool?.target_ready ?? 0); }, [pool?.target_ready]);
  const set = (v) => {
    const clamped = Math.max(0, Math.min(50, v));
    setN(clamped);
    setPoolTarget(clamped, projectId);
  };
  return (
    <span className="pooltarget"
          title="How many ready (pre-warmed) xells the queenzee keeps in the pool. Requires the pool maintainer running (POOL_ENABLED=true).">
      <span className="k">pool target:</span>
      <button className="step" onClick={() => set(n - 1)} disabled={n <= 0} aria-label="fewer">−</button>
      <b data-testid="pool-target">{n}</b>
      <button className="step" onClick={() => set(n + 1)} aria-label="more">＋</button>
    </span>
  );
}

function RuntimeToggle({ runtimes, value, onChange }) {
  if (!runtimes.length) return null;
  return (
    <div className="toggle" role="group" aria-label="Agent runtime">
      {runtimes.map((r) => (
        <button key={r.key} className={`seg ${value === r.key ? 'on' : ''}`}
                onClick={() => onChange(r.key)} title={r.vendor}>
          {r.label}
        </button>
      ))}
    </div>
  );
}

// Hand a custom-scheme URL (e.g. claude://resume?session=…) to the OS protocol handler.
// Using an anchor click instead of window.open avoids leaving a blank about:blank tab,
// and unlike setting window.location it never unloads this single-page app.
function openProtocol(url) {
  const a = document.createElement('a');
  a.href = url;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function XellCard({ x, diff, onDone }) {
  const working = x.zee_status === 'working';
  const isProd = x.is_production;
  const clickable = !!x.viewer_url && !isProd;
  // Open the session in the right surface for its runtime: a claude.ai web session opens
  // in a browser tab; a local (desktop-protocol) session deep-links into Claude Desktop.
  const open = () => {
    if (!clickable) return;
    if (x.viewer_kind === 'desktop-protocol') openProtocol(x.viewer_url);
    else window.open(x.viewer_url, '_blank', 'noopener');
  };
  const openHint = !clickable ? ''
    : x.viewer_kind === 'desktop-protocol' ? 'Open this session in Claude Desktop'
    : 'Open this session in claude.ai';

  const done = async (e) => {
    e.stopPropagation();
    if (!x.task_id) return;
    const ok = window.confirm(
      `Mark "${x.slug}" done?\n\n` +
      `This tears the xell down — removes its worktree, branch, and per-xell containers, ` +
      `and decommissions its zee${x.holds_prod_lock ? ' (and it currently HOLDS the prod lock)' : ''}. ` +
      `This cannot be undone.`);
    if (!ok) return;
    await markDone(x.task_id, 'mark');
    onDone();
  };

  return (
    <div className={`card status-${x.status} ${clickable ? 'clickable' : ''} ${isProd ? 'prod' : ''}`}
         data-testid="xell-card" data-slug={x.slug} data-status={x.status} data-xell-id={x.id}
         data-production={isProd ? '1' : '0'}
         onClick={open} title={openHint}>
      {isProd && <span className="prodtag" data-testid="prod-tag" title="Production — protected, untouchable by zees">🛡 PRODUCTION</span>}
      {x.holds_prod_lock && (
        <span className="lock" data-testid="prod-lock"
              title={`Holds the PRODUCTION deploy lock — phase: ${x.prod_lock_phase || 'deploying'}`}>
          🔒 prod
        </span>
      )}
      <div className="stack">
        {['db', 'server', 'webapp'].map((role) => {
          const c = x.stack.find((s) => s.role === role);
          const lbl = role === 'server' ? 'srv' : role === 'webapp' ? 'web' : 'db';
          return (
            <div className="srow" key={role}>
              <span className="srole">{lbl}</span>
              {c ? <ChipBox c={c} /> : <span className="cbox empty">—</span>}
            </div>
          );
        })}
      </div>
      <div className="meta">
        {!isProd && <Row k="session" v={shortSid(x.claude_session_id)} mono />}
        {!isProd && <Row k="zee" v={working ? x.zee_name : '—'} highlight={working} testid="zee-name" />}
        <Row k="worktree" v={isProd ? '(production)' : base(x.worktree_path)} mono />
        <Row k="source" v={x.source || x.xource_ref} />
        {!isProd && <Row k="commit" v={x.head_commit ? x.head_commit.slice(0, 8) : '—'} mono testid="commit-head" />}
        {!isProd && (
          <div className="row"><span className="rk">diff</span>
            <span className="diff" data-testid="diff">
              {diff
                ? <>↑{diff.ahead} ↓{diff.behind}<span className="dstat"> · {diff.files}f <span className="ins">+{diff.insertions}</span>/<span className="del">−{diff.deletions}</span></span></>
                : '—'}
            </span>
          </div>
        )}
        <div className="row">
          <span className="rk">status</span>
          <span className={`badge b-${x.status}`} data-testid="xell-status">{isProd ? 'live · protected' : x.status}</span>
        </div>
        {!isProd && x.runtime_label && (
          <div className="row"><span className="rk">runtime</span>
            <span className="runtime">{x.runtime_label}</span></div>
        )}
        {!isProd && x.zee_id && x.cli_active != null && (
          <div className="row"><span className="rk">monitor</span>
            <span className={`mon ${x.cli_active ? 'on' : 'off'}`} data-testid="monitor"
                  title={`verified via ${x.monitor_source || 'claude CLI'}`}>
              {x.cli_active ? '● really active' : '○ not active'}
            </span>
          </div>
        )}
      </div>
      {!isProd && x.task_id && ['working', 'idle', 'claimed', 'awaiting-done'].includes(x.status) && (
        <button className={`donebtn ${x.status === 'awaiting-done' ? 'await' : ''}`} onClick={done}>
          {x.status === 'awaiting-done' ? '✓ Confirm done (zee reported finished)' : 'Mark done'}
        </button>
      )}
    </div>
  );
}

function Row({ k, v, mono, highlight, testid }) {
  return (
    <div className="row">
      <span className="rk">{k}</span>
      <span className={`rv ${mono ? 'mono' : ''} ${highlight ? 'hot' : ''}`} data-testid={testid}>{v}</span>
    </div>
  );
}
