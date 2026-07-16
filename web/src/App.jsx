import React, { useEffect, useState, useCallback, useRef } from 'react';
import { getFleet, getRuntimes, getTimeline, getDiffs, getLogs, subscribe, markDone, setDefaultRuntime,
         getProjects, createProject, deleteProject, setPoolTarget, buildXell, revealWorktree,
         reapXell, pushXell, pullXell, prXell, acceptPull } from './api.js';

const buildErr = (e) => alert('Build failed: ' + (e?.error || e?.message || e));
import GitRail from './GitRail.jsx';
import Connectors from './Connectors.jsx';
import Terminal from './Terminal.jsx';
import ProjectMenu from './ProjectMenu.jsx';
import BackupsPanel from './Backups.jsx';
import LandingPanel, { LandCard } from './Landing.jsx';
import ShipPanel, { LockBadge } from './Ship.jsx';
import { nick } from './nick.js';
import { ContainerChip, ContainerMenu, isBuildable, isBusy } from './Container.jsx';

const PROJECT_KEY = 'zeehive.project';

// Display only — the DB role is still 'webapp'. "App" is what the thing IS; "webapp" was naming
// its delivery mechanism, which is the least interesting fact about it.
const ROLE_LABEL = { db: 'DB', server: 'Server', webapp: 'App', other: 'Other' };
const shortSid = (s) => (s ? s.slice(0, 8) : '—');
const base = (p) => (p ? p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() : '—');


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
  const [dismissed, setDismissed] = useState({});
  const [logs, setLogs] = useState([]);
  const [showTerm, setShowTerm] = useState(false);
  const [menu, setMenu] = useState(null); // container context menu {x,y,c}

  // open the container context menu at the cursor — passed down to each xell's ContainerChips.
  // onMenu stops propagation so opening one doesn't trip the document closer below.
  const openMenu = useCallback((e, c) => { e.preventDefault(); e.stopPropagation(); setMenu({ x: e.clientX, y: e.clientY, c }); }, []);
  // Close on any outside interaction — NO full-screen scrim (that could block the whole UI).
  // Effect is keyed on `menu`, so listeners attach only while a menu is open and after the
  // opening event has finished (so it can't immediately close itself).
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e) => e.key === 'Escape' && close();
    document.addEventListener('click', close);
    document.addEventListener('contextmenu', close);
    window.addEventListener('scroll', close, true);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('click', close);
      document.removeEventListener('contextmenu', close);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [menu]);
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
  // Landings/PRs live on the card of the xell they concern, so route them there first. A landing
  // belongs to the xell that RAISED it ("approved — re-push"); a PR belongs to the xource being
  // ASKED, which is a different card entirely — that is the point of a PR.
  const shipByXell = {};
  for (const s of fleet.shipping || []) shipByXell[s.xell_id] ||= s;

  // Dismissed notifications, by request id. VIEW-ONLY and deliberately not persisted: it hides a
  // decided receipt for this sitting, and a reload brings it back. Persisting "I don't want to see
  // this" about a landing that has not actually landed yet would be inventing a third state the
  // server does not have — the request is still open, and the zee is still expected to re-push.
  const dismiss = (id) => setDismissed((d) => ({ ...d, [id]: true }));
  const visible = (rs) => (rs || []).filter((r) => !dismissed[r.id]);

  // Route each landing to the card that will actually RENDER it — which is not the same question as
  // "does it have a xell_id". The fleet only lists xells with status <> 'retired', so a landing
  // whose xell has since been reaped has an id, no card, and (once the top panel stopped taking
  // anything with an id) nowhere at all. That is how nimble-atlas-d6e6d4's approved landing went
  // invisible. Ask whether a card exists, not whether an id does.
  const carded = new Set((fleet.xells || []).map((x) => x.id));
  const landingByXell = {};
  const prsByRef = {};
  const orphanLandings = [];
  for (const r of fleet.landing || []) {
    if (r.kind === 'pull') (prsByRef[r.ref] ||= []).push(r);
    else if (r.xell_id && carded.has(r.xell_id)) (landingByXell[r.xell_id] ||= []).push(r);
    else orphanLandings.push(r);   // no xell (gate could not match the sha), or its xell is gone
  }
  const prsFor = (x) => prsByRef[`refs/heads/${x.remote_source?.ref || ''}`]
    // production IS local main, so PRs against main are production's to answer. Its remote_source
    // is origin (what it tracks), which is NOT what it receives work on — hence the special case.
    || (x.is_production ? prsByRef[`refs/heads/${project.main_branch || 'main'}`] : null)
    || [];

  // Sort: things WAITING ON YOU, then things that are alive, then everything else. The old order
  // was by base commit, which is stable and meaningless to look at — a held landing could sit
  // below four idle pool xells. Ties keep the commit order, so the rail's connectors stay sane.
  const rank = (x) => {
    if ((landingByXell[x.id]?.length || 0) + prsFor(x).length > 0) return 0;
    const live = ['spawning', 'online', 'working'].includes(x.zee_status)
      || ['working', 'claimed', 'awaiting-done'].includes(x.status);
    return live ? 1 : 2;
  };
  const xells = [...fleet.xells].sort((a, b) =>
    (rank(a) - rank(b)) || ((order[a.id] ?? 9999) - (order[b.id] ?? 9999)));

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

      {/* THE BAR. Landings and PRs now live on their xell's card, which is where you can judge them
          — but moving them there quietly cost the property the old panel existed for: "a blocked
          push means a zee is stuck waiting on a human, and this is the only thing on the page that
          can't wait for you to scroll." It stopped being unmissable. A zee said "approve it in the
          console", Mark looked where it had always been, and there was nothing there.
          So: the CARD keeps the decision, and this keeps the interrupt. It is a pointer, not a
          copy — one line, only when something is actually waiting, and it scrolls you to the card
          rather than letting you decide from a banner with no context around it. */}
      <NeedsYouBar xells={xells} landingByXell={landingByXell} prsFor={prsFor} />

      <LandingPanel landing={orphanLandings} onDecided={refresh} />

      {/* Production: ship approvals + the prod lock's countdown. Same altitude as landings —
          both are decisions only a human may make, and both block a zee until made. */}
      <ShipPanel shipping={fleet.shipping} prodLock={fleet.prod_lock}
                 projectId={projectId || project.id} onDecided={refresh} />

      <BackupsPanel backup={fleet.backup} projectId={projectId || project.id} />

      <section className="inventory">
        {['db', 'server', 'webapp', 'other'].map((role) => (
          <div className="invrow" key={role} data-role={role}>
            <span className="invlabel">{ROLE_LABEL[role]}:</span>
            <span className="boxes">
              {(containers[role] || []).map((c) => <ContainerChip key={c.id} c={c} onMenu={openMenu} />)}
              {(!containers[role] || containers[role].length === 0) && <span className="cbox empty">—</span>}
            </span>
          </div>
        ))}
      </section>

      <h2 className="xells-h">xells:</h2>
      <section className="xells">
        {xells.map((x) => <XellCard key={x.id} x={x} diff={diffs[x.id]} onDone={refresh} onMenu={openMenu}
                                   landing={visible(landingByXell[x.id])} prs={visible(prsFor(x))}
                                   ship={shipByXell[x.id]} onDismiss={dismiss}
                                   prodLock={fleet.prod_lock} projectId={projectId || project.id} />)}
        {xells.length === 0 && <p className="loading">No active xells. The pool maintainer will fill it shortly…</p>}
      </section>
      </div>
      {showTerm && <Terminal logs={logs} onClose={() => setShowTerm(false)} />}
      <ContainerMenu menu={menu} onClose={() => setMenu(null)} />
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

function XellCard({ x, diff, onDone, onMenu, prodLock, projectId, landing, prs, ship, onDismiss }) {
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

  // Confirm-and-tear-down. Goes through the task when there is one; otherwise reaps the xell
  // directly — a xell can legitimately have no task row (a dispatched zee that reported done),
  // and gating the only teardown button on task_id stranded those forever.
  const done = async (e) => {
    e.stopPropagation();
    // Teardown deletes the worktree AND the branch, so anything not landed on main dies with it.
    // Spell out exactly what is at stake BEFORE asking — a generic "cannot be undone" let a single
    // click destroy a working xell that had an uncommitted file in it.
    const unlanded = diff && (diff.ahead > 0 || diff.dirty > 0);
    const atStake = unlanded
      ? `\n\n⚠ THIS XELL HAS WORK THAT IS NOT ON MAIN:\n` +
        (diff.ahead > 0 ? `   • ${diff.ahead} commit(s) not landed on main\n` : '') +
        (diff.dirty > 0 ? `   • ${diff.dirty} uncommitted file(s) in the worktree\n` : '') +
        `   This work will be PERMANENTLY LOST.\n`
      : '\n\n(Nothing unlanded — its work is already on main.)\n';
    // ACTIVE = a zee is still in there; the server needs `force` to touch it. It is NOT, on its
    // own, a reason for more friction: marking done is the human's job (House rule 4), and a live
    // zee whose work is already on main loses nothing when it goes — you just restart it.
    const active = !!x.zee_id && (x.cli_active === true || ['spawning', 'online', 'working'].includes(x.zee_status));
    const ok = window.confirm(
      `${x.task_id ? 'Mark done' : 'Clean up'} "${x.slug}"?` +
      (active ? `\n\nIts zee is still ${x.zee_status}${x.cli_active ? ' (really active)' : ''} — this kills the agent mid-task.\n` : '') +
      atStake +
      `\nThis removes its worktree, branch, and per-xell containers, and decommissions its zee` +
      `${x.holds_prod_lock ? ' (it currently HOLDS the prod lock)' : ''}.\nThis cannot be undone.`);
    if (!ok) return;
    // The ONE hard gate, and only where something is actually destroyed forever: unlanded work.
    // Gate on LOSS, not on liveness — keying it to "active" made the common case (a finished zee
    // sitting clean at the source tip) demand a typed 40-char slug to do the very thing the whole
    // system asks you to do, while a stray click on a dirty-but-idle xell only cost one confirm.
    if (unlanded) {
      const typed = window.prompt(
        `"${x.slug}" has work that is NOT on main:\n` +
        (diff.ahead > 0 ? `  • ${diff.ahead} commit(s) not landed\n` : '') +
        (diff.dirty > 0 ? `  • ${diff.dirty} uncommitted file(s)\n` : '') +
        `\nThis will be PERMANENTLY LOST. To confirm, type the xell name exactly:\n${x.slug}`);
      if (typed !== x.slug) { if (typed !== null) alert('Name did not match — nothing was touched.'); return; }
    }
    try {
      const r = x.task_id ? await markDone(x.task_id, 'mark', active) : await reapXell(x.id, 'human-cleanup', active);
      // The xell is retired either way, but don't let a half-teardown pass as clean: if the folder
      // survived (something still holds it open — usually the zee's own session), say so.
      const orphan = r?.orphaned_worktree || r?.reap?.orphaned_worktree;
      if (orphan) {
        alert(`"${x.slug}" was retired, but its worktree could NOT be removed:\n\n${orphan}\n\n` +
              `Something still has it open — usually that zee's session in Claude Code. ` +
              `Close the session, then run Clean up again.`);
      }
      onDone();
    } catch (err) { alert('Cleanup failed: ' + (err?.message || err)); }
  };

  return (
    <div data-xell={x.id}
         className={`card status-${x.status} ${clickable ? 'clickable' : ''} ${isProd ? 'prod' : ''}`}
         data-testid="xell-card" data-slug={x.slug} data-status={x.status} data-xell-id={x.id}
         data-production={isProd ? '1' : '0'}
         onClick={open} title={openHint}>
      {/* CARD HEADER — a real flow row, not floating badges.
          These three used to be position:absolute at top:8, while .stack began at the card's top
          edge — so every badge sat ON the db row, and .lock (right:8) + .xbuild (right:10) landed
          on EACH OTHER whenever a non-prod xell held the prod lock. Laying them out puts the stack
          naturally below and makes the overlap unrepresentable rather than tuned-around. */}
      <div className="cardtop">
        {isProd && <span className="prodtag" data-testid="prod-tag" title="Production — protected, untouchable by zees">🛡 PRODUCTION</span>}
        <span className="cardtop-right">
          {/* The padlock is interactive: hover swaps it to an unlock icon, clicking asks before
              taking prod back. `held` (countdown cancelled) renders differently from a ship that is
              simply still counting down. */}
          {x.holds_prod_lock && (
            <span className="lock" data-testid="prod-lock"
                  title={`Holds the PRODUCTION deploy lock — phase: ${x.prod_lock_phase || 'deploying'}`}
                  onClick={(e) => e.stopPropagation()}>
              🔒 prod
              <LockBadge lock={prodLock && prodLock.xell_id === x.id ? prodLock : null}
                         projectId={projectId} onChanged={onDone} />
            </span>
          )}
          {!isProd && x.stack.some(isBuildable) && (() => {
            const busy = x.stack.some(isBusy);   // don't allow a build-all while anything is building/restoring
            return (
              <button className="xbuild" data-testid="xell-build" disabled={busy}
                      title={busy ? 'A container is busy (building/restoring) — wait for it to finish'
                                  : 'Build all — rebuild this xell\'s server + app (right-click for hot build)'}
                      onClick={(e) => { e.stopPropagation(); if (!busy) buildXell(x.id, false).catch(buildErr); }}
                      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); if (!busy) buildXell(x.id, true).catch(buildErr); }}>
                {busy ? '⏳ busy…' : '🔨 build all'}
              </button>
            );
          })()}
        </span>
      </div>
      {/* One row, no labels: the chip's own glyph says which role it is, so a "db"/"srv"/"web"
          column was naming what you can already see and costing three rows of card height. Order
          is fixed (db, server, webapp) so the shape reads the same on every card. */}
      <div className="stack">
        {['db', 'server', 'webapp'].map((role) => {
          const c = x.stack.find((s) => s.role === role);
          return c
            ? <ContainerChip key={role} c={c} onMenu={onMenu} hammer />
            : <span key={role} className="cbox empty" data-role={role} title={`no ${role} container`}>—</span>;
        })}
      </div>
      <div className="meta">
        {!isProd && (
          <div className="row"><span className="rk">session</span>
            <span className={x.zee_title ? 'sesstitle' : 'mono'} data-testid="session"
                  title={x.zee_title ? `${x.zee_title}\n${shortSid(x.claude_session_id)}` : x.claude_session_id || ''}>
              {x.zee_title || shortSid(x.claude_session_id)}
            </span>
          </div>
        )}
        {!isProd && <Row k="zee" v={working ? x.zee_name : '—'} highlight={working} testid="zee-name" />}
        {isProd
          ? <Row k="worktree" v="(production)" mono />
          : (
            <div className="row"><span className="rk">worktree</span>
              <button className="wtlink" data-testid="worktree"
                      title={`${x.worktree_path}\n(click to open in Explorer)`}
                      onClick={(e) => { e.stopPropagation(); revealWorktree(x.id).catch((err) => alert('Open failed: ' + (err?.message || err))); }}>
                {base(x.worktree_path)}
              </button>
            </div>
          )}
        {/* What this xell TRACKS — its xource — with the head it currently resolves to. The head is
            the point: "source: main" was true and useless, and it stayed on screen while the thing
            behind it sat 542 commits back. A ref name alone cannot tell you the tree moved. */}
        <SourceRow k="remote source" src={x.remote_source} testid="remote-source" />
        {/* SOURCE DIFF — this xell's content vs the source it tracks. Production is a xell too, so
            it gets one: its content is what it has deployed, its source is origin. It was excluded
            here, which is how it drifted unwatched. Prod reads '—' until a ship lands, because
            nothing recorded the hand-deploys that predate the ship gate — that is honest, not a
            placeholder: the system does not know what prod is running. */}
        <div className="row"><span className="rk">source diff</span>
          <span className="diff" data-testid="source-diff"
                title={diff
                  ? (isProd
                    ? `Deployed is ${diff.ahead} commit(s) ahead of origin · ${diff.behind} behind\n${diff.files} file(s), +${diff.insertions}/−${diff.deletions} vs origin`
                    : `${diff.ahead} commit(s) ahead of source · ${diff.behind} behind\n${diff.files} file(s), +${diff.insertions}/−${diff.deletions} vs source (includes uncommitted work)`)
                  : (isProd ? 'No ship has landed yet, so nothing recorded what production is running' : '')}>
            {diff
              ? <>↑{diff.ahead} ↓{diff.behind}<span className="dstat"> · {diff.files}f <span className="ins">+{diff.insertions}</span>/<span className="del">−{diff.deletions}</span></span></>
              : '—'}
          </span>
        </div>
        {/* For prod: the commit it is SERVING. For a work xell: the commit it was provisioned at. */}
        <Row k="commit" mono testid="commit-head"
             v={isProd
               ? (x.deployed_commit ? x.deployed_commit.slice(0, 8) : '—')
               : (x.head_commit ? x.head_commit.slice(0, 8) : '—')} />
        {/* DIFF: work since its own last checkpoint commit — the "not yet saved" number, which
            drops to 0 every time the zee checkpoints. ●N counts dirty files incl. untracked. */}
        {!isProd && (
          <div className="row"><span className="rk">diff</span>
            <span className="diff" data-testid="diff"
                  title={diff?.own
                    ? `Uncommitted: ${diff.own.files} file(s), +${diff.own.insertions}/−${diff.own.deletions} vs its own last checkpoint (HEAD)${diff.dirty ? `\n${diff.dirty} dirty file(s) in the worktree (incl. untracked)` : '\nnothing uncommitted — all work is checkpointed'}`
                    : ''}>
              {diff?.own
                ? <><span className="dstat">{diff.own.files}f <span className="ins">+{diff.own.insertions}</span>/<span className="del">−{diff.own.deletions}</span></span>
                    {diff.dirty > 0 && <span className="dirty" data-testid="dirty" title={`${diff.dirty} dirty file(s) incl. untracked`}> ●{diff.dirty}</span>}</>
                : '—'}
            </span>
          </div>
        )}
        <div className="row">
          <span className="rk">status</span>
          <span className={`badge b-${x.status}`} data-testid="xell-status">{isProd ? 'live · protected' : x.status}</span>
        </div>
        {/* Can this xell ship to prod, and if not, why? Two different "no"s that the gate itself
            treats differently — collapsing them into one "blocked" would be a lie in both
            directions. See shipState(). */}
        {!isProd && (() => {
          const s = shipState(x, diff, prodLock, ship);
          return (
            <div className="row"><span className="rk">ship</span>
              <span className={`shipst s-${s.k}`} data-testid="ship-state" title={s.why}>{s.text}</span>
            </div>
          );
        })()}
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
      {/* What is WAITING on you about this xell, on the xell itself. These used to be one banner at
          the top of the page, which meant reading "nimble-atlas wants to land" and then hunting for
          nimble-atlas to see whether that was reasonable. Cards carrying one of these sort first. */}
      {(landing?.length > 0 || prs?.length > 0) && (
        <div className="xnotify">
          {landing?.map((r) => <LandCard key={r.id} req={r} onDone={onDone} onDismiss={onDismiss} />)}
          {prs?.map((r) => <PrCard key={r.id} req={r} onDone={onDone} onDismiss={onDismiss} />)}
        </div>
      )}

      {/* ── this xell and its xource ───────────────────────────────────────────
          Confirmations here are sized to what is actually at RISK, not applied evenly — the same
          reasoning as the teardown gate above. PULL can entangle a zee's uncommitted work, so it
          says whose tree it is touching. PUSH is gated by the hook anyway, so its confirm is
          informational: it tells you it will be HELD, so a decline reads as the system working
          rather than an error. PR destroys nothing, so it just asks. */}
      {!isProd && x.worktree_path && <XourceActions x={x} diff={diff} onDone={onDone} />}

      {/* Never gate this on task_id: a dispatched zee's xell may have no task row, and without a
          button it can never be confirmed OR reaped — it just strands in awaiting-done forever. */}
      {!isProd && ['working', 'idle', 'claimed', 'awaiting-done'].includes(x.status) && (
        <button className={`donebtn ${x.status === 'awaiting-done' ? 'await' : ''}`} onClick={done}
                data-testid="done-btn"
                title={x.task_id ? 'Mark the task done — the queenzee tears this xell down'
                                 : 'No task row on this xell — this cleans it up (tears it down) directly'}>
          {x.status === 'awaiting-done' ? '✓ Confirm done (zee reported finished)'
            : (x.task_id ? 'Mark done' : 'Clean up xell')}
        </button>
      )}
    </div>
  );
}

// Can this xell ship to production right now? Mirrors queenzee/shipgate.js — and the distinction it
// makes matters, because the two "no"s are not the same thing:
//
//   UNLANDED  → requestShip() REFUSES outright. A ship builds from main, so unlanded work would
//               simply not be in it. Nothing you can do at the console changes this: land it.
//   PROD HELD → the request is fine and a human can approve it; runShip() then WAITS as 'approved'
//               rather than queue-jumping, and the reaper starts it when the lock frees. So this is
//               "you'll queue", not "you can't" — showing it as blocked would send you hunting for
//               a problem that resolves itself.
//
// Read from data the card already has (diff + prod_lock + the open ship request), so it costs
// nothing and cannot disagree with the numbers displayed right above it.
function shipState(x, diff, prodLock, ship) {
  if (ship) {
    const m = {
      pending:  { k: 'wait',  text: 'awaiting a human', why: 'Ship requested — a human must approve it in the console.' },
      approved: { k: 'go',    text: 'approved — taking prod', why: 'Approved. The queenzee is taking the prod lock.' },
      shipping: { k: 'go',    text: 'shipping now', why: 'The queenzee is building prod from main and holds the lock.' },
    };
    if (m[ship.status]) return m[ship.status];
  }
  const unlanded = diff && (diff.ahead > 0 || diff.dirty > 0);
  if (unlanded) {
    const bits = [
      diff.ahead > 0 ? `${diff.ahead} commit(s) not landed` : null,
      diff.dirty > 0 ? `${diff.dirty} uncommitted file(s)` : null,
    ].filter(Boolean);
    return {
      k: 'no', text: `no — ${diff.ahead > 0 ? `${diff.ahead} unlanded` : `${diff.dirty} dirty`}`,
      why: `A ship builds from main, so this would NOT be in it:\n  • ${bits.join('\n  • ')}\nLand it first — the request is refused until you do.`,
    };
  }
  if (prodLock && prodLock.xell_id !== x.id) {
    return {
      k: 'queue', text: `queues — ${prodLock.xell_slug || 'another xell'} holds prod`,
      why: `${prodLock.xell_slug || 'Another xell'} holds the prod lock (${prodLock.phase || 'busy'}).\n`
        + 'You can still request a ship: it waits for the lock rather than queue-jumping, and starts when prod frees.',
    };
  }
  return { k: 'ready', text: 'ready', why: 'Landed and clean, and prod is free — a ship would start as soon as a human approves it.' };
}

// One line at the top of the page naming every xell that is waiting on a human, and nothing else.
// Deliberately NOT a copy of the cards: it holds no commits and no Approve button, because a
// decision made from a banner is a decision made without the diff, the ship state or the xell's
// own numbers sitting next to it. It answers "is anything waiting, and where" — then gets out of
// the way. Only PENDING counts: an approved landing is a receipt, and dressing receipts up as
// demands is how a warning bar trains you to ignore it.
function NeedsYouBar({ xells, landingByXell, prsFor }) {
  const waiting = xells.map((x) => {
    const held = (landingByXell[x.id] || []).filter((r) => r.status === 'pending').length;
    const prs = (prsFor(x) || []).filter((r) => r.status === 'pending').length;
    return { x, held, prs, n: held + prs };
  }).filter((w) => w.n > 0);
  if (!waiting.length) return null;

  const go = (id) => {
    const el = document.querySelector(`[data-xell="${id}"]`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1200);
  };

  return (
    <section className="needsyou">
      <span className="ny-t">⚠ waiting on you:</span>
      {waiting.map((w) => (
        <button key={w.x.id} className="ny-chip" onClick={() => go(w.x.id)}
                title={`${w.held ? `${w.held} landing held` : ''}${w.held && w.prs ? ' · ' : ''}${w.prs ? `${w.prs} PR` : ''} — jump to the card`}>
          {w.x.slug}
          <span className="ny-n">{w.held > 0 && `${w.held} landing${w.held === 1 ? '' : 's'}`}
            {w.held > 0 && w.prs > 0 && ' · '}
            {w.prs > 0 && `${w.prs} PR${w.prs === 1 ? '' : 's'}`}</span>
        </button>
      ))}
    </section>
  );
}

// A PR waiting on THIS xource. It renders on the card being ASKED — production for work aimed at
// main, a parent xell for a child's work — because the side receiving the code is the side that
// decides to take it.
function PrCard({ req, onDone, onDismiss }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [open, setOpen] = useState(true);
  const commits = Array.isArray(req.commits) ? req.commits : [];
  const stat = req.stat || {};

  const accept = async () => {
    if (!confirm(
      `Accept ${req.xell_slug}'s PR into ${(req.ref || '').replace('refs/heads/', '')}?\n\n`
      + `This fast-forwards to ${String(req.new_sha).slice(0, 10)} — the exact commit listed here. `
      + `It cannot pull in anything you haven't read: if it is no longer a fast-forward, it is `
      + `refused rather than merged.`)) return;
    setBusy(true); setErr(null);
    try {
      const r = await acceptPull(req.id);
      if (r?.ok === false) setErr(r.reason || 'refused');
      else onDone?.();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  return (
    <div className={`land-card pr${open ? '' : ' mini'}`}>
      <div className="land-head">
        <button className="land-toggle" onClick={() => setOpen((v) => !v)}
                title={open ? 'Collapse' : 'Show the commits'} aria-expanded={open}>
          {open ? '▾' : '▸'}
        </button>
        <span className="land-what">
          <b>{req.xell_slug || 'a xell'}</b> asks to land into{' '}
          <b>{(req.ref || '').replace('refs/heads/', '')}</b>
        </span>
        {/* No ✕ while it is pending: an unanswered PR is somebody waiting on you. Collapse it if it
            is in the way — that keeps it on the card, which a dismiss would not. */}
      </div>
      {!open ? (
        <div className="land-mini">
          {String(req.new_sha).slice(0, 10)} · {commits.length} commit{commits.length === 1 ? '' : 's'} · awaiting your Accept
        </div>
      ) : (
        <>
          <div className="land-meta">{String(req.new_sha).slice(0, 10)}</div>
          <div className="land-stat">
            {commits.length} commit{commits.length === 1 ? '' : 's'}
            {stat.files != null && <> · {stat.files}f <span className="ins">+{stat.insertions}</span>/<span className="del">−{stat.deletions}</span></>}
          </div>
          <ul className="land-commits">
            {commits.slice(0, 8).map((c) => (
              <li key={c.short}><code>{c.short}</code> {c.subject} <span className="land-author">{c.author}</span></li>
            ))}
            {commits.length > 8 && <li className="land-more">…and {commits.length - 8} more</li>}
          </ul>
          {err && <div className="land-err">{err}</div>}
          <div className="land-actions">
            <button className="land-approve" disabled={busy} onClick={accept}>
              {busy ? '…' : 'Accept PR'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// PUSH / PULL / PR — a human doing, from here, what only a zee could do before (and only by being
// told to, in a prompt). All three act on ONE relationship: this xell and its xource.
function XourceActions({ x, diff, onDone }) {
  const [busy, setBusy] = useState(null);
  const [msg, setMsg] = useState(null);
  const src = x.remote_source?.ref || 'its xource';

  const run = async (verb, fn) => {
    setBusy(verb); setMsg(null);
    try {
      const r = await fn();
      // These verbs answer with a REASON rather than throwing when they refuse — a dirty tree is
      // not an error, it is the check doing its job. Show it as the answer, not as a failure.
      if (r?.ok === false || r?.merged === false || r?.landed === false) {
        setMsg({ bad: true, text: r.reason || (r.output || '').split('\n').filter(Boolean).slice(-1)[0] || 'refused' });
      } else if (verb === 'push') setMsg({ text: `landed on ${src}` });
      else if (verb === 'pull') setMsg({ text: `merged ${src} → ${x.slug}` });
      else setMsg({ text: `PR raised — it is now on ${src}'s card` });
      onDone?.();
    } catch (e) { setMsg({ bad: true, text: e.message }); }
    finally { setBusy(null); }
  };

  const push = () => {
    if (!confirm(
      `Push ${x.slug} → ${src}?\n\n`
      + `This runs the same gated push a zee runs. Unless a human has ALREADY approved this exact `
      + `commit, the gate will HOLD it and raise it for verification — that is the expected outcome, `
      + `not a failure.\n\nNothing is lost either way: your commits stay on the branch.`)) return;
    run('push', () => pushXell(x.id));
  };

  const pull = () => {
    // Say whose worktree is about to move, and warn BEFORE the click rather than let the server's
    // refusal be the first time you hear about it. The server refuses dirty anyway — this is so a
    // human knows what they are aiming at, not a substitute for that check.
    const dirty = diff?.dirty || 0;
    if (!confirm(
      `Pull ${src} into ${x.slug}?\n\n`
      + `This merges ${src} into ${x.slug}'s WORKING TREE on disk`
      + `${x.zee_status === 'working' ? ' — and its zee is still working in there right now' : ''}.\n`
      + (dirty > 0
        ? `\n⚠ It has ${dirty} uncommitted file(s). This will be REFUSED: merging over a dirty tree `
          + `can entangle in-progress work with the merge. Commit or stash first.\n`
        : ''))) return;
    run('pull', () => pullXell(x.id));
  };

  const pr = () => {
    if (!confirm(
      `Raise a PR from ${x.slug} → ${src}?\n\n`
      + `This asks ${src} to take ${x.slug}'s commits in. Nothing moves now: it appears on ${src}'s `
      + `card, and a human accepts it there.`)) return;
    run('pr', () => prXell(x.id));
  };

  return (
    <div className="xact">
      <div className="xact-row">
        <button className="xbtn" disabled={!!busy} onClick={pull} data-testid="pull-btn"
                title={`Merge ${src} into ${x.slug}'s worktree (refused if it has uncommitted work)`}>
          {busy === 'pull' ? '…' : '↓ pull'}
        </button>
        <button className="xbtn" disabled={!!busy} onClick={push} data-testid="push-btn"
                title={`Push ${x.slug}'s commits to ${src} — the gate holds it unless already approved`}>
          {busy === 'push' ? '…' : '↑ push'}
        </button>
        <button className="xbtn pr" disabled={!!busy} onClick={pr} data-testid="pr-btn"
                title={`Ask ${src} to pull ${x.slug} in — a human accepts it on ${src}'s card`}>
          {busy === 'pr' ? '…' : 'PR'}
        </button>
      </div>
      {msg && <div className={`xact-msg${msg.bad ? ' bad' : ''}`}>{msg.text}</div>}
    </div>
  );
}

// "main 8dc4134a" — a ref and the head it currently resolves to, since the head is the whole point.
function SourceRow({ k, src, testid }) {
  if (!src) return null;
  return (
    <div className="row">
      <span className="rk">{k}</span>
      <span className="rv" data-testid={testid} title={src.head ? `${src.ref} @ ${src.head}` : src.ref}>
        {src.ref || '—'}
        {src.head ? <span className="srchead mono">{src.head}</span> : null}
      </span>
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
