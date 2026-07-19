import React, { useEffect, useState, useCallback, useRef } from 'react';
import { getFleet, getRuntimes, getTimeline, getDiffs, getLogs, subscribe, markDone, setDefaultRuntime,
         getProjects, createProject, deleteProject, setPoolTarget, buildXell, revealWorktree,
         reapXell, pushXell, pullXell, prXell, acceptPull, updateProject, dismissLanding,
         streamFleetXells } from './api.js';

const buildErr = (e) => alert('Build failed: ' + (e?.error || e?.message || e));
import HiveCanvas from './hive/HiveCanvas.jsx';
import GraphPane from './GraphPane.jsx';
import Connectors from './Connectors.jsx';
import Terminal from './Terminal.jsx';
import ProjectMenu from './ProjectMenu.jsx';
import BackupsPanel from './Backups.jsx';
import LandingPanel, { LandCard } from './Landing.jsx';
import ShipPanel, { LockBadge } from './Ship.jsx';
import { nick } from './nick.js';
import { ContainerChip, ContainerMenu, isBuildable, isBusy } from './Container.jsx';
import MachineMatrix from './Machines.jsx';
import ZeeTerminal from './ZeeTerminal.jsx';
import ModeChip from './ModeChip.jsx';
import Dispatch from './Dispatch.jsx';

const PROJECT_KEY = 'zeehive.project';

// Display only — the DB role is still 'webapp'. "App" is what the thing IS; "webapp" was naming
// its delivery mechanism, which is the least interesting fact about it.
const ROLE_LABEL = { db: 'DB', server: 'Server', webapp: 'App', other: 'Other' };
const shortSid = (s) => (s ? s.slice(0, 8) : '—');
const base = (p) => (p ? p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() : '—');

// FLEET BURN formatters. Compact token counts (1.2M, 890K, 4.2k → keep it short on a card) and a
// dollar figure that keeps cents but never a distracting tail of zeros. These render fleet-OWN
// consumption; account-wide %/limits are NOT available (only Anthropic's /usage shows those).
const fmtTok = (n) => {
  const v = Number(n || 0);
  if (v >= 1e9) return (v / 1e9).toFixed(v >= 1e10 ? 0 : 1).replace(/\.0$/, '') + 'B';
  if (v >= 1e6) return (v / 1e6).toFixed(v >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(v >= 1e4 ? 0 : 1).replace(/\.0$/, '') + 'K';
  return String(Math.round(v));
};
const fmtUsd = (n) => {
  const v = Number(n || 0);
  return '$' + (v >= 100 ? v.toFixed(0) : v.toFixed(2));
};


// Portrait when the viewport is taller than it is wide. Re-measured on resize so the timeline
// re-orients live when the window is reshaped.
function useOrientation() {
  const [o, setO] = useState(() =>
    (typeof window !== 'undefined' && window.innerHeight > window.innerWidth) ? 'portrait' : 'landscape');
  useEffect(() => {
    const on = () => setO(window.innerHeight > window.innerWidth ? 'portrait' : 'landscape');
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return o;
}

// The honeycomb's xell list, streamed in lazily as NDJSON so hexagons appear as their data arrives
// rather than after the whole fleet resolves. Returns [xells, restream]: `restream` re-runs the
// stream (called on every live change so the grid stays current). Each pass upserts by id while it
// streams — existing hexes never flicker — then prunes ids the pass didn't see.
function useStreamedXells(projectId) {
  const [xells, setXells] = useState([]);
  const mapRef = useRef(new Map());
  const acRef = useRef(null);
  const runStream = useCallback(async () => {
    acRef.current?.abort();
    const ac = new AbortController();
    acRef.current = ac;
    const seen = new Set();
    try {
      await streamFleetXells(projectId, {
        signal: ac.signal,
        onXell: (x) => {
          if (ac.signal.aborted) return;
          seen.add(x.id);
          mapRef.current.set(x.id, x);
          setXells(Array.from(mapRef.current.values()));
        },
      });
      if (ac.signal.aborted) return;
      for (const id of Array.from(mapRef.current.keys())) if (!seen.has(id)) mapRef.current.delete(id);
      setXells(Array.from(mapRef.current.values()));
    } catch (e) { /* aborted or transient — keep the last good set */ }
  }, [projectId]);

  useEffect(() => {
    mapRef.current = new Map();
    setXells([]);
    runStream();
    return () => acRef.current?.abort();
  }, [projectId, runStream]);

  return [xells, runStream];
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
  const [dismissed, setDismissed] = useState({});
  const [logs, setLogs] = useState([]);
  const [shipLogs, setShipLogs] = useState({});   // ship id → live build lines (this sitting only)
  const [showTerm, setShowTerm] = useState(false);
  const [showDispatch, setShowDispatch] = useState(false); // the "+" prompt composer
  const [menu, setMenu] = useState(null); // container context menu {x,y,c}

  // ── honeycomb shell ──────────────────────────────────────────────────────────
  const orientation = useOrientation();          // 'portrait' | 'landscape'
  const [honeySide, setHoneySide] = useState('a'); // which half is the honeycomb (flip swaps it)
  const [expandedId, setExpandedId] = useState(null); // the xell blown into a flower + action drawer
  const [termXell, setTermXell] = useState(null);  // caged-zee terminal modal, opened from the flower
  const [termChoice, setTermChoice] = useState(null);  // ⌨ clicked → pick in-house vs deep-linked
  const [streamedXells, restreamXells] = useStreamedXells(projectId);
  // hex screen positions published by HiveCanvas each draw. GraphPane + Connectors subscribe to a
  // per-frame "geometry changed" fire so a pan/zoom re-tracks the graph and re-routes the wires
  // WITHOUT re-rendering the whole app.
  const hexPosRef = useRef({});
  const geomListeners = useRef(new Set());
  const subscribeGeom = useCallback((fn) => {
    geomListeners.current.add(fn);
    return () => geomListeners.current.delete(fn);
  }, []);
  const fireGeom = useCallback(() => {
    geomListeners.current.forEach((fn) => { try { fn(); } catch { /* listener detached mid-fire */ } });
  }, []);
  // shared hover: hovering a hex or a commit dot highlights the hex, its wire, and its dot together.
  // A ref + subscription (not state) so a hover doesn't re-render the whole app.
  const hoverRef = useRef({ id: null, commit: null });
  const hoverListeners = useRef(new Set());
  const setHover = useCallback((h) => {
    const c = hoverRef.current;
    if (c.id === h.id && c.commit === h.commit) return;
    hoverRef.current = h;
    hoverListeners.current.forEach((fn) => { try { fn(); } catch { /* detached */ } });
  }, []);
  const subscribeHover = useCallback((fn) => {
    hoverListeners.current.add(fn);
    return () => hoverListeners.current.delete(fn);
  }, []);

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
      restreamXells();              // re-stream the honeycomb's xells so the grid stays current
      loadProjects();               // keep the switcher's xell counts fresh
      setVersion((v) => v + 1);
    } catch { /* keep last */ }
  }, [projectId, loadProjects, applyFleet, restreamXells]);

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
      onLog: (l) => setLogs((prev) => [...prev.slice(-1999), l]),
      // Per-ship build feed, keyed by ship id, capped so a chatty build can't eat the tab.
      onShipLog: (l) => setShipLogs((prev) => ({ ...prev, [l.id]: [...(prev[l.id] || []).slice(-399), l] })),
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

  // Dismissed notifications, by request id. The server records the dismissal (dismissed_at on the
  // row) so it survives reloads and SSE refreshes — receipts used to pop back on every refresh
  // because hiding them was view-only state. The local map is just optimism: the card disappears
  // on the click, not on the round-trip. Visibility only — the land reaper keeps working the row.
  const dismiss = (id) => {
    setDismissed((d) => ({ ...d, [id]: true }));
    dismissLanding(id).catch(() => setDismissed((d) => ({ ...d, [id]: false })));
  };
  const visible = (rs) => (rs || []).filter((r) => !dismissed[r.id] && !r.dismissed_at);

  // Route each landing to the card that will actually RENDER it — which is not the same question as
  // "does it have a xell_id". The fleet only lists xells with status <> 'retired', so a landing
  // whose xell has since been reaped has an id, no card, and (once the top panel stopped taking
  // anything with an id) nowhere at all. That is how nimble-atlas-d6e6d4's approved landing went
  // invisible. Ask whether a card exists, not whether an id does.
  // The honeycomb's xells come from the lazy NDJSON stream (hexagons appear as data arrives); fall
  // back to the fleet snapshot if the stream hasn't produced anything yet (e.g. it errored).
  const gridXells = streamedXells.length ? streamedXells : (fleet.xells || []);
  const carded = new Set(gridXells.map((x) => x.id));
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
  const xells = [...gridXells].sort((a, b) =>
    (rank(a) - rank(b)) || ((order[a.id] ?? 9999) - (order[b.id] ?? 9999)));

  const expandedXell = expandedId ? xells.find((x) => x.id === expandedId) : null;
  const prodIds = xells.filter((x) => x.is_production).map((x) => x.id);  // graph tracks their median

  // Open a xell's session in the right surface — the honeycomb flower's click target, and the
  // drawer card's. Web sessions open a tab; desktop-protocol sessions deep-link into Claude Desktop.
  const openSession = (x) => {
    if (!x?.viewer_url || x.is_production) return;
    // A caged zee's viewer is an ssh:// terminal, not a URL a browser can open — its card
    // carries the ⌨ terminal button instead, so ignore the generic open here.
    if (x.viewer_kind === 'ssh-terminal') return;
    if (x.viewer_kind === 'desktop-protocol') openProtocol(x.viewer_url);
    else window.open(x.viewer_url, '_blank', 'noopener');
  };

  // The flower's canvas action buttons dispatch here (HiveCanvas onAction) — same verbs the old DOM
  // toolbar/drawer ran, with the same confirmations, so nothing changed but WHERE they are clicked.
  const handleFlowerAction = (kind, x, diff) => {
    if (!x || x.is_production) return;
    const src = x.remote_source?.ref || 'its xource';
    if (kind === 'terminal') { setTermChoice(x); return; }   // ask: in-house vs deep-linked
    if (kind === 'build') {
      if (x.stack.some(isBusy)) { alert('A container is busy (building/restoring) — wait for it to finish.'); return; }
      buildXell(x.id, false).catch(buildErr); return;
    }
    if (kind === 'done') {
      markXellDone(x, diff, refresh, { landing: landingByXell[x.id], prs: prsFor(x), ship: shipByXell[x.id] });
      return;
    }
    if (kind === 'push') {
      if (!confirm(`Push ${x.slug} → ${src}?\n\nThis runs the same gated push a zee runs. Unless a human has ALREADY `
        + `approved this exact commit, the gate HOLDS it and raises it for verification — expected, not a failure. `
        + `Your commits stay on the branch either way.`)) return;
      pushXell(x.id).then((r) => { if (r?.landed === false) alert(r.reason || 'push held at the gate'); refresh(); })
        .catch((e) => alert('Push failed: ' + (e?.message || e))); return;
    }
    if (kind === 'pull') {
      const dirty = diff?.dirty || 0;
      if (!confirm(`Pull ${src} into ${x.slug}?\n\nMerges ${src} into ${x.slug}'s working tree on disk`
        + `${x.zee_status === 'working' ? ' — its zee is still working in there' : ''}.`
        + (dirty > 0 ? `\n\n⚠ ${dirty} uncommitted file(s): this will be REFUSED (commit or stash first).` : ''))) return;
      pullXell(x.id).then((r) => { if (r?.merged === false) alert(r.reason || 'pull refused'); refresh(); })
        .catch((e) => alert('Pull failed: ' + (e?.message || e))); return;
    }
    if (kind === 'pr') {
      if (!confirm(`Raise a PR from ${x.slug} → ${src}?\n\nNothing moves now: it appears on ${src}'s card, and a `
        + `human accepts it there.`)) return;
      prXell(x.id).then(refresh).catch((e) => alert('PR failed: ' + (e?.message || e))); return;
    }
  };

  // Only the SELECTED xell's pending DECISIONS still need a DOM card (approve/reject with reasons —
  // the one thing the canvas flower can't carry). Everything else (identity, containers, diff, the
  // action buttons) now lives ON the flower, so the drawer appears only when there's something to
  // decide and is otherwise gone.
  const expandedDecides = !!expandedXell && (
    (landingByXell[expandedXell.id] || []).some((r) => r.status === 'pending')
    || (prsFor(expandedXell) || []).some((r) => r.status === 'pending')
    || (shipByXell[expandedXell.id] && ['pending', 'approved', 'shipping'].includes(shipByXell[expandedXell.id].status)));

  // Three panes: the honeycomb, the git graph as the exact centre divider, and the control panels.
  // Landscape → three columns, portrait → three rows; the graph stays centred while flip swaps which
  // side is honeycomb vs panels. Connector wires bridge each xell's commit dot (graph) to its hex.
  return (
    <div className={`hive-split o-${orientation} honey-${honeySide}`} ref={layoutRef}>
      <section className="hive-pane honey">
        <HiveCanvas xells={xells} diffs={diffs} timeline={timeline} orientation={orientation} honeySide={honeySide}
                    machines={fleet.machines} onOpenSession={openSession} onAction={handleFlowerAction}
                    expandedId={expandedId} onExpand={setExpandedId}
                    hexPosRef={hexPosRef} onGeometry={fireGeom}
                    hoverRef={hoverRef} setHover={setHover} subscribeHover={subscribeHover} />
        {/* The per-xell actions (build/pull/push/PR/terminal/mark-done) are drawn ON the flower now
            and hit-tested there — no DOM toolbar. The caged-zee terminal is the one piece that needs
            DOM, so it opens as a modal from the flower's ⌨ button. */}
        {termChoice && (
          <div className="term-choice-back" onClick={() => setTermChoice(null)}>
            <div className="term-choice" onClick={(e) => e.stopPropagation()}>
              <div className="tc-title">Attach to <b>{termChoice.slug}</b></div>
              <button className="tc-opt" onClick={() => { setTermXell(termChoice); setTermChoice(null); }}>
                <span className="tc-ico">🖥</span>
                <span><b>In-house terminal</b><small>live xterm in the dashboard (SSH → tmux)</small></span>
              </button>
              <button className="tc-opt" disabled={!termChoice.viewer_url}
                      onClick={() => { openProtocol(termChoice.viewer_url); setTermChoice(null); }}>
                <span className="tc-ico">🔗</span>
                <span><b>Deep-linked terminal</b>
                  <small>{termChoice.viewer_url ? 'open ssh:// in your own terminal app' : 'no ssh url for this xell'}</small></span>
              </button>
              <button className="tc-cancel" onClick={() => setTermChoice(null)}>cancel</button>
            </div>
          </div>
        )}
        {termXell && (
          <ZeeTerminal zeeId={termXell.zee_id} slug={termXell.slug} viewerUrl={termXell.viewer_url}
                       onClose={() => setTermXell(null)} />
        )}
      </section>

      <GraphPane timeline={timeline} orientation={orientation} honeySide={honeySide}
                 hexPosRef={hexPosRef} prodIds={prodIds} subscribeGeom={subscribeGeom}
                 hoverRef={hoverRef} setHover={setHover} subscribeHover={subscribeHover} />

      <Connectors timeline={timeline} layoutRef={layoutRef} version={version}
                  hexPosRef={hexPosRef} orientation={orientation} honeySide={honeySide}
                  expandedId={expandedId} prodIds={prodIds} subscribeGeom={subscribeGeom}
                  hoverRef={hoverRef} subscribeHover={subscribeHover} />

      <section className="hive-pane panels">
      <div className="content">
      <header className="topbar">
        <div className="proj">
          <span className="k">Project:</span> <b>{project.name}</b>
          <ProjectMenu projects={projects} currentId={projectId || project.id}
                       onSelect={selectProject} onCreate={handleCreate} onDelete={handleDelete}
                       onChanged={loadProjects} />
          <span className="k folder">Folder:</span> <span className="mono">{project.repo_root}</span>
        </div>
        <div className="right">
          <button className="flip-btn" data-testid="flip-btn" onClick={() => setHoneySide((s) => (s === 'a' ? 'b' : 'a'))}
                  title={`Flip the honeycomb to the other side (timeline follows so merge points keep facing it). Now: ${orientation}, honeycomb ${honeySide === 'a' ? (orientation === 'portrait' ? 'top' : 'left') : (orientation === 'portrait' ? 'bottom' : 'right')}`}>
            ⇄ flip
          </button>
          <RuntimeToggle runtimes={runtimes} value={runtime}
                         onChange={(k) => { setRuntime(k); setDefaultRuntime(k, projectId || project.id); }} />
          <span className={`conn ${conn}`}>{conn === 'live' ? '● live' : '○ ' + conn}</span>
        </div>
      </header>

      <div className="statusline" data-testid="statusline">
        <span className="k">Status:</span>{' '}
        <b>{status.inUse}</b> of <b>{status.total}</b> xells in use
        <span className="sub"> ({status.working} active · {status.ready} ready)</span>
        {/* FLEET-CUMULATIVE BURN — every run across the project, tokens + $. Fleet-own consumption
            only; account-wide %/limits are NOT available (Anthropic's /usage alone shows those). */}
        {fleet.fleet_burn?.fleet && (fleet.fleet_burn.fleet.tokens > 0 || fleet.fleet_burn.fleet.cost > 0) && (
          <span className="fleetburn" data-testid="fleet-burn"
                title={`Every run across this project consumed ${Number(fleet.fleet_burn.fleet.tokens).toLocaleString()} tokens `
                  + `for ${fmtUsd(fleet.fleet_burn.fleet.cost)}, over ${fleet.fleet_burn.fleet.zees} zee run(s).\n`
                  + 'Fleet-own consumption only — not your Anthropic account %/limits.'}>
            {' · '}fleet burn: <b>{fmtTok(fleet.fleet_burn.fleet.tokens)} tok · {fmtUsd(fleet.fleet_burn.fleet.cost)}</b>
          </span>
        )}
        {/* The prewarmed-pool knob, right here in the status line so it never hides in project
            settings. Per-machine pool sizes (matrix column headers) replace this project-wide
            target ONLY when they actually govern — i.e. a dev machine exists AND the project has a
            per-xell app tier to place on it (compose_spinoff). A bare-worktree project (no
            compose_spinoff, e.g. Zeehive itself) always pools by the project-wide target no matter
            how many machines exist (see queenzee/pool.js), so its knob must stay visible here —
            otherwise the ONLY working control is buried in the ⚙ Spawn-template modal. Mirrors the
            server's own `!machines.length || !compose_spinoff` branch exactly. */}
        {(!(fleet.machines || []).some((m) => m.enabled && m.dev_priority > 0) || !project.compose_spinoff)
          && <PoolTarget pool={fleet.pool} projectId={projectId || project.id} />}
        <AutoApprove project={project} projectId={projectId || project.id} onChanged={refresh} />
        <button className="new-prompt-btn" data-testid="new-prompt-btn"
                title="Compose a prompt and dispatch a zee into a ready xell"
                onClick={() => setShowDispatch(true)}>＋ new prompt</button>
        <button className="term-btn" data-testid="term-btn" title="Open queenzee terminal"
                onClick={() => setShowTerm(true)}>▚_</button>
      </div>

      {/* THE BAR — the one thing on the page that can't wait for you to scroll: a zee blocked on a
          human. A pointer, not a copy; clicking a chip expands that xell's flower + action drawer. */}
      <NeedsYouBar xells={xells} landingByXell={landingByXell} prsFor={prsFor} onJump={setExpandedId} />

      <LandingPanel landing={orphanLandings} onDecided={refresh} />

      {/* Production: ship approvals + the prod lock's countdown. Same altitude as landings —
          both are decisions only a human may make, and both block a zee until made. */}
      <ShipPanel shipping={fleet.shipping} prodLock={fleet.prod_lock} shipLogs={shipLogs}
                 projectId={projectId || project.id} onDecided={refresh} />

      <BackupsPanel backup={fleet.backup} projectId={projectId || project.id} />

      {/* The inventory as a role × machine MATRIX: one column per machine, so what-runs-where is
          the panel's shape. Chips sit where they RUN; the ⇄ marker says where they compile. */}
      <MachineMatrix machines={fleet.machines} containers={containers}
                     projectId={projectId || project.id} onMenu={openMenu} onChanged={refresh} />

      {/* The selected xell's card appears ONLY when it has a pending DECISION (a held landing, an
          open PR, or an in-flight ship) — the approve/reject-with-reasons UI the canvas flower can't
          carry. Its identity, containers, diff and action buttons all live on the flower now, so in
          the common case there is no drawer here at all. */}
      {expandedDecides && (
        <>
          <h2 className="xells-h">
            decision needed · {expandedXell.slug}
            <button className="drawer-close" onClick={() => setExpandedId(null)} title="Close (Esc)">✕</button>
          </h2>
          <section className="xells drawer">
            <XellCard key={expandedXell.id} x={expandedXell} diff={diffs[expandedXell.id]} onDone={refresh} onMenu={openMenu}
                      landing={visible(landingByXell[expandedXell.id])} prs={visible(prsFor(expandedXell))}
                      ship={shipByXell[expandedXell.id]} onDismiss={dismiss} machines={fleet.machines}
                      prodLock={fleet.prod_lock} projectId={projectId || project.id} />
          </section>
        </>
      )}
      </div>
      </section>
      {showTerm && <Terminal logs={logs} onClose={() => setShowTerm(false)} />}
      {showDispatch && (
        <Dispatch projectId={projectId || project.id} projectName={project.name}
                  onClose={() => setShowDispatch(false)}
                  onDispatched={() => { setShowDispatch(false); refresh(); }} />
      )}
      <ContainerMenu menu={menu} onClose={() => setMenu(null)}
                     projectName={project.name} onDecommissioned={refresh} />
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

// Operator policy: auto-approve landings and/or ships. Two independent switches — landing→main is
// far lower stakes than shipping→prod, so they toggle separately. Enabling ships asks first (it
// puts code LIVE with no human review). Reads the flags off the project row in the fleet snapshot.
function AutoApprove({ project, projectId, onChanged }) {
  const [busy, setBusy] = useState(false);
  const set = async (field, checked) => {
    if (field === 'auto_approve_ship' && checked
      && !confirm('Auto-approve PRODUCTION ships?\n\nEvery ship request will deploy to prod immediately with NO human review. The queenzee still only builds landed work from main, but nobody signs off per ship.')) return;
    setBusy(true);
    try { await updateProject(projectId, { [field]: checked }); onChanged?.(); }
    catch (e) { alert('Auto-approve change failed: ' + e.message); }
    finally { setBusy(false); }
  };
  const Switch = ({ field, label, title, danger }) => (
    <label className={`autoappr${project?.[field] ? ' on' : ''}${danger ? ' danger' : ''}`} title={title}>
      <input type="checkbox" checked={!!project?.[field]} disabled={busy}
             data-testid={`auto-${field}`} onChange={(e) => set(field, e.target.checked)} />
      {label}
    </label>
  );
  return (
    <span className="autoappr-group" data-testid="auto-approve">
      <span className="k">auto-approve:</span>
      <Switch field="auto_approve_land" label="landings"
              title="Automatically approve every push to main — the landing gate lets it through with no human review." />
      <Switch field="auto_approve_ship" label="ships" danger
              title="Automatically approve every production ship — code goes LIVE with no human review (still built from landed main)." />
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

// Build all — rebuild this xell's server + app. Reused by the drawer card's header AND the
// flower toolbar so there is exactly one implementation of "what a build-all click does".
function BuildAllButton({ x }) {
  if (x.is_production || !x.stack.some(isBuildable)) return null;
  const busy = x.stack.some(isBusy);   // don't allow a build-all while anything is building/restoring
  return (
    <button className="xbuild" data-testid="xell-build" disabled={busy}
            title={busy ? 'A container is busy (building/restoring) — wait for it to finish'
                        : "Build all — rebuild this xell's server + app (right-click for hot build)"}
            onClick={(e) => { e.stopPropagation(); if (!busy) buildXell(x.id, false).catch(buildErr); }}
            onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); if (!busy) buildXell(x.id, true).catch(buildErr); }}>
      {busy ? '⏳ busy…' : '🔨 build all'}
    </button>
  );
}

// Confirm-and-tear-down. Goes through the task when there is one; otherwise reaps the xell
// directly — a xell can legitimately have no task row (a dispatched zee that reported done), and
// gating the only teardown button on task_id stranded those forever. Extracted from the drawer
// card so the flower toolbar's "mark done" runs the EXACT same confirm flow, not a second one that
// could drift out of sync with what it warns about.
async function markXellDone(x, diff, onDone, ctx = {}) {
  // ctx = { landing, prs, ship } — the card has these in scope and passes them so the "in use"
  // gate below can fire; the flower toolbar calls with none, which just degrades to inUse=0.
  const { landing, prs, ship } = ctx;
  // Teardown deletes the worktree AND the branch, so anything not landed on main dies with it.
  // Spell out exactly what is at stake BEFORE asking — a generic "cannot be undone" let a single
  // click destroy a working xell that had an uncommitted file in it.
  const unlanded = diff && (diff.ahead > 0 || diff.dirty > 0);
  // A xell awaiting a human decision (a held landing, an open PR into it, or an in-flight ship)
  // is NOT idle — decommissioning it throws that decision away, and a shipping xell holds prod.
  // Treat any of these as "in use": warn hard and demand the same typed-name confirmation as
  // unlanded work. (The reaper withdraws open ships and refuses one it is actively deploying —
  // this stops the click before it gets there.)
  const heldLanding = (landing || []).filter((r) => r.status === 'pending').length;
  const openPr = (prs || []).filter((r) => r.status === 'pending').length;
  const pendingShip = ship && ['pending', 'approved', 'shipping'].includes(ship.status) ? ship.status : null;
  const inUse = heldLanding + openPr > 0 || !!pendingShip;
  const inUseText = inUse
    ? `\n\n⚠ THIS XELL IS WAITING ON A DECISION:\n` +
      (heldLanding ? `   • ${heldLanding} landing held for approval\n` : '') +
      (openPr ? `   • ${openPr} open PR into this xell\n` : '') +
      (pendingShip ? `   • a production ship is ${pendingShip}${pendingShip !== 'pending' ? ' (may hold the prod lock)' : ''}\n` : '') +
      `   Tearing it down cancels that.\n`
    : '';
  const atStake = unlanded
    ? `\n\n⚠ THIS XELL HAS WORK THAT IS NOT ON MAIN:\n` +
      (diff.ahead > 0 ? `   • ${diff.ahead} commit(s) not landed on main\n` : '') +
      (diff.dirty > 0 ? `   • ${diff.dirty} uncommitted file(s) in the worktree\n` : '') +
      `   This work will be PERMANENTLY LOST.\n`
    : (inUse ? '' : '\n\n(Nothing unlanded — its work is already on main.)\n');
  // ACTIVE = a zee is still in there; the server needs `force` to touch it. It is NOT, on its own,
  // a reason for more friction: marking done is the human's job (House rule 4), and a live zee
  // whose work is already on main loses nothing when it goes — you just restart it.
  const active = !!x.zee_id && (x.cli_active === true || ['spawning', 'online', 'working'].includes(x.zee_status));
  const ok = window.confirm(
    `${x.task_id ? 'Mark done' : 'Decommission'} "${x.slug}"?` +
    (active ? `\n\nIts zee is still ${x.zee_status}${x.cli_active ? ' (really active)' : ''} — this kills the agent mid-task.\n` : '') +
    inUseText +
    atStake +
    `\nThis removes its worktree, branch, and per-xell containers, and decommissions its zee` +
    `${x.holds_prod_lock ? ' (it currently HOLDS the prod lock)' : ''}.\nThis cannot be undone.`);
  if (!ok) return;
  // The hard gate — a typed-name confirmation — fires whenever something real is at stake:
  //   • a LIVE zee is in there (active): a claimed xell with a running agent must never go on a
  //     single click — that exact accident (a live claimed xell reaped) is why this gate exists;
  //   • unlanded work that would be LOST;
  //   • a pending decision (landing/PR/ship) that would be CANCELLED.
  // A clean, idle/pooled xell with none of these still costs only the single confirm above.
  if (unlanded || inUse || active) {
    const typed = window.prompt(
      `"${x.slug}" is not safe to remove without confirmation:\n` +
      (active ? `  • its zee is still ${x.zee_status}${x.cli_active ? ' (really active)' : ''} — this kills it mid-task\n` : '') +
      (diff?.ahead > 0 ? `  • ${diff.ahead} commit(s) not landed\n` : '') +
      (diff?.dirty > 0 ? `  • ${diff.dirty} uncommitted file(s)\n` : '') +
      (heldLanding ? `  • ${heldLanding} landing held for approval\n` : '') +
      (openPr ? `  • ${openPr} open PR\n` : '') +
      (pendingShip ? `  • a production ship is ${pendingShip}\n` : '') +
      `\nProceeding is irreversible. To confirm, type the xell name exactly:\n${x.slug}`);
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
}

// (The old DOM FlowerToolbar was removed: its build/pull/push/PR/mark-done buttons are now drawn
// directly on the flower by HiveCanvas and hit-tested there — see handleFlowerAction above.)

function XellCard({ x, diff, onDone, onMenu, prodLock, projectId, landing, prs, ship, onDismiss, machines }) {
  const working = x.zee_status === 'working';
  const isProd = x.is_production;
  const [termOpen, setTermOpen] = useState(false);
  // A caged zee is attended over SSH, not a Desktop deep-link — its viewer is a live terminal.
  const caged = x.viewer_kind === 'ssh-terminal' && !!x.viewer_url && !isProd;

  // WHERE this xell runs. Its stack is context-stamped per container; the machine is the one whose
  // docker_ctx matches the SERVER container (the stack's anchor), falling back to any stack
  // container that carries a ctx. No ctx anywhere → we don't know, so render no chip rather than
  // guess. A ctx with no matching machine row still tells the truth: show the raw ctx.
  const stackCtx = (x.stack.find((c) => c.role === 'server' && c.docker_ctx)
    || x.stack.find((c) => c.docker_ctx))?.docker_ctx || null;
  const machine = stackCtx ? (machines || []).find((m) => m.docker_ctx === stackCtx) : null;
  const clickable = !!x.viewer_url && !isProd && x.viewer_kind !== 'ssh-terminal';
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

  // Confirm-and-tear-down — see markXellDone (shared with the flower toolbar). The card passes its
  // landing/prs/ship context so the "in use" gate (a held landing / open PR / in-flight ship) can
  // fire; the flower toolbar calls markXellDone without it and just degrades to no in-use warning.
  const done = (e) => { e.stopPropagation(); markXellDone(x, diff, onDone, { landing, prs, ship }); };

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
        {stackCtx && (
          <span className="machinechip" data-testid="machine-chip"
                title={machine
                  ? `machine ${machine.key}${machine.label ? ` (${machine.label})` : ''} — ${machine.docker_ctx}@${machine.host_ip || '?'}`
                  : `machine context ${stackCtx}`}>
            ⌂ {machine ? machine.key : stackCtx}
          </span>
        )}
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
          <BuildAllButton x={x} />
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
            {/* The session's mode, inline before its name — click to change it. margin-left:auto
                (in .modemenu) keeps chip + name grouped on the right despite the row's
                space-between; the chip lives OUTSIDE the title span because .sesstitle clips
                overflow, which would eat the chip on a long title. */}
            {x.zee_id && <ModeChip zeeId={x.zee_id} mode={x.permission_mode} />}
            <span className={x.zee_title ? 'sesstitle' : 'mono'} data-testid="session"
                  title={(x.zee_title ? `${x.zee_title}\n${shortSid(x.claude_session_id)}` : x.claude_session_id || '')
                    + (['stopped', 'errored'].includes(x.zee_status) && x.claude_session_id
                      ? '\n\nThe session PROCESS ended (app closed / reboot / liveness blip) but the session itself is on disk — click the card to resume it.' : '')}>
              {x.zee_title || shortSid(x.claude_session_id)}
              {/* Process death is not session death: the transcript persists and the deep-link
                  resumes it. This used to render as session "—", which read as "lost". */}
              {['stopped', 'errored'].includes(x.zee_status) && x.claude_session_id
                && <span className="detached" data-testid="detached">detached · click to resume</span>}
            </span>
            {/* Caged zees are attended in-browser: open a live terminal into the cage (ssh→tmux).
                This replaces the Desktop deep-link, which can't reach a session inside a container. */}
            {caged && (
              <button className="termbtn" title="Open a live terminal into this caged zee"
                      onClick={(e) => { e.stopPropagation(); setTermOpen(true); }}>⌨ terminal</button>
            )}
          </div>
        )}
        {caged && termOpen && (
          <ZeeTerminal zeeId={x.zee_id} slug={x.slug} viewerUrl={x.viewer_url}
                       onClose={() => setTermOpen(false)} />
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
        {/* FLEET BURN — what every zee this xell hosted consumed (tokens + $), summed. Compact by
            design (Σ 1.2M tok · $8.90). This is the xell's OWN spend; account-wide %/limits are not
            available to us (only Anthropic's /usage shows those). Shown once there's anything to show. */}
        {!isProd && x.burn && (x.burn.tokens > 0 || x.burn.cost > 0) && (
          <div className="row"><span className="rk">burn</span>
            <span className="burn" data-testid="xell-burn"
                  title={`This xell's zees consumed ${Number(x.burn.tokens).toLocaleString()} tokens for ${fmtUsd(x.burn.cost)}.\n`
                    + 'Fleet-own consumption only — not your Anthropic account %/limits.'}>
              Σ {fmtTok(x.burn.tokens)} tok · {fmtUsd(x.burn.cost)}
            </span>
          </div>
        )}
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
          button it can never be confirmed OR reaped — it just strands in awaiting-done forever.
          `ready` is included too: an idle POOLED xell nobody needs had no teardown affordance at
          all, so a user could never decommission an unused xell — the whole point of this action.
          Teardown routes through reapXell either way, so the pool reconciler backfills to appetite
          exactly as it does for any other decommission. */}
      {!isProd && ['working', 'idle', 'claimed', 'awaiting-done', 'ready'].includes(x.status) && (
        <button className={`donebtn ${x.status === 'awaiting-done' ? 'await' : ''}`} onClick={done}
                data-testid="done-btn"
                title={x.task_id ? 'Mark the task done — the queenzee tears this xell down'
                     : x.status === 'ready' ? 'Decommission this unused (pooled) xell — the queenzee tears it down; the pool refills as usual'
                     : 'No task row on this xell — this cleans it up (tears it down) directly'}>
          {x.status === 'awaiting-done' ? '✓ Confirm done (zee reported finished)'
            : x.status === 'ready' ? 'Decommission xell'
            : (x.task_id ? 'Mark done' : 'Decommission xell')}
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
function NeedsYouBar({ xells, landingByXell, prsFor, onJump }) {
  const waiting = xells.map((x) => {
    const held = (landingByXell[x.id] || []).filter((r) => r.status === 'pending').length;
    const prs = (prsFor(x) || []).filter((r) => r.status === 'pending').length;
    return { x, held, prs, n: held + prs };
  }).filter((w) => w.n > 0);
  if (!waiting.length) return null;

  // Expand the xell's flower + action drawer — where its landings/PRs can actually be judged.
  const go = (id) => onJump?.(id);

  return (
    <section className="needsyou">
      <span className="ny-t">⚠ waiting on you:</span>
      {waiting.map((w) => (
        <button key={w.x.id} className="ny-chip" onClick={() => go(w.x.id)}
                title={`${w.held ? `${w.held} landing held` : ''}${w.held && w.prs ? ' · ' : ''}${w.prs ? `${w.prs} PR` : ''} — open the card`}>
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
