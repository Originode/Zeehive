import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { getFleet, getTimeline, getDiffs, getLogs, subscribe, GIT_TYPES, markDone,
         getProjects, createProject, deleteProject, setPoolTarget, buildXell,
         reapXell, pushXell, pullXell, prXell, acceptPull, updateProject, dismissLanding,
         streamFleetXells, dispatchTask, nudgeXell, requestShipXell, getProviderTokens, runBackup,
         sendXellMessage,
         swapXellZee,
         pauseXell, resumeXell, githubAccess, pushProject, pullRequestProject, pullProject, commitXourceDirty,
         routePrompt, deployRouter, redeployRouter, addManagerZee,
         squashHelps, squashOffer } from './api.js';
import { promptButton, hasAnyAccount } from './promptButtons.js';
import MessageComposer from './MessageComposer.jsx';
import SwapZee from './SwapZee.jsx';
import XellEnvironment from './XellEnvironment.jsx';
import Directives from './Directives.jsx';
import XellObservability from './XellObservability.jsx';
import { showAlert, showConfirm, showPrompt } from './Dialog.jsx';
import { restartXellCage } from './cage.js';
import { showDiff } from './DiffViewer.jsx';
import ProjectSetup from './ProjectSetup.jsx';

const buildErr = (e) => showAlert('Build failed: ' + (e?.error || e?.message || e), { variant: 'error' });

import HiveCanvas from './hive/HiveCanvas.jsx';
// the manager↔crew relation, read by every view that draws it (honeycomb, wires, graph — and the DOM)
import { crewLinks } from './hive/crew.js';
// the project-scoping filter for the fleet render surfaces (honeycomb and everything fed from it)
import { projectScoped } from './projectFilter.js';
import CrewChip from './CrewChip.jsx';
import GraphPane from './GraphPane.jsx';
import { beginPaneReposition, readSplit } from './paneSplit.js';
import Connectors from './Connectors.jsx';
import Terminal from './Terminal.jsx';
import ConsoleSettings from './ConsoleSettings.jsx';
import ProjectMenu from './ProjectMenu.jsx';

import BackupsPanel, { BackupsModal } from './Backups.jsx';
import LandingPanel, { LandCard, holdsRunway } from './Landing.jsx';
import ProdAsksPanel, { ProdBindCard, SeedCard } from './ProdData.jsx';
import XourceCleanPanel from './XourceClean.jsx';
import ManagerMintPanel from './ManagerMint.jsx';
import CredentialInjectPanel from './CredentialInject.jsx';
import VisualVerifyPanel from './VisualVerify.jsx';
import { AddManagerButton, DoneSuggestionCard } from './Manager.jsx';
import ShipPanel from './Ship.jsx';
import LandingPad from './LandingPad.jsx';
import { nick } from './nick.js';
import { ContainerMenu, isBusy } from './Container.jsx';
import MachineMatrix from './Machines.jsx';
import ZeeTerminal, { ContainerTerminal } from './ZeeTerminal.jsx';
// a zee's badge: the AI PROVIDER's coin, wearing its harness (the honeycomb draws the same thing)
import FleetPause from './FleetPause.jsx';
import Dispatch from './Dispatch.jsx';
import WorkConsole from './work/WorkConsole.jsx';
// the honeycomb's WORK-NODE hierarchy reads the same plan the board does
import { listWorkItems, deployWorkItem, createWorkItem } from './work/workApi.js';
import DeliveryTelemetry from './DeliveryTelemetry.jsx';
import Toasts from './Toasts.jsx';

const PROJECT_KEY = 'zeehive.project';
const PROJECT_PARAM = 'project';

// Resolve a project from a URL token (?project=…), matched against either the id or the name
// (case-insensitive), so a link/refresh lands on a specific project instead of "the first one".
const findByToken = (ps, token) =>
  token
    ? ps.find((p) => p.id === token || p.name?.toLowerCase() === String(token).toLowerCase())
    : null;

const readProjectParam = () => {
  try { return new URLSearchParams(window.location.search).get(PROJECT_PARAM); }
  catch { return null; }
};

// Keep the URL in step with the selected project (its name — readable, and it survives a refresh)
// WITHOUT adding history entries, so Back doesn't walk through every project you clicked.
const writeProjectParam = (project) => {
  try {
    const url = new URL(window.location.href);
    if (project?.name) url.searchParams.set(PROJECT_PARAM, project.name);
    else url.searchParams.delete(PROJECT_PARAM);
    window.history.replaceState(null, '', url);
  } catch { /* history unavailable — non-fatal */ }
};

// Display only — the DB role is still 'webapp'. "App" is what the thing IS; "webapp" was naming
// its delivery mechanism, which is the least interesting fact about it.
const ROLE_LABEL = { db: 'DB', server: 'Server', webapp: 'App', other: 'Other' };
// One line, capped — for the short prose a zee writes for a human (a tend's reason, say), which is
// shown inline on a chip that has no room to wrap. The FULL text always rides the element's title.
const clip = (s, n = 60) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};
const capitalise = (s) => String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1);
// How long a state has been true, coarsely. DAYS are the point of this one rather than a nicety:
// it renders the age of an env-reconcile alert, and that state survives reboots — "1d ago" and
// "4m ago" are the difference between a blip and something the fleet has been living with. Empty
// string for no timestamp, so a caller can concatenate it without guarding twice.
const fmtAgo = (ts) => {
  if (!ts) return '';
  const s = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

// FLEET BURN formatters. Compact token counts (1.2M, 890K, 4.2k → keep it short on a card) and a
// dollar figure that keeps cents but never a distracting tail of zeros. These render fleet-OWN
// consumption. Per-provider breakdown and "current" rate-limit % come from the gateway ledger
// (getFleetBurn.by_provider / .current) — not Admin /usage, which needs keys the fleet does not hold.
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

// Tooltip for the whole fleet-burn chip: total + spend per provider. Limits (remaining %) live
// on a SEPARATE chip — this one is spend only, so a human never confuses the two questions.
function fleetBurnTitle(burn) {
  if (!burn?.fleet) return '';
  const lines = [
    `Every run across this project consumed ${Number(burn.fleet.tokens).toLocaleString()} tokens `
      + `for ${fmtUsd(burn.fleet.cost)}, over ${burn.fleet.zees} zee run(s).`,
  ];
  for (const p of burn.by_provider || []) {
    lines.push(`${p.provider}: ${Number(p.tokens).toLocaleString()} tok · ${fmtUsd(p.cost)}`
      + ` over ${p.requests} gateway call(s)`);
  }
  lines.push('Fleet-own spend only. Remaining provider quotas live on the "limits" chip.');
  return lines.join('\n');
}

// Tooltip for one provider's SPEND segment of the burn chip.
function providerBurnTitle(p) {
  return `${p.provider}: ${Number(p.tokens).toLocaleString()} tokens · ${fmtUsd(p.cost)}`
    + ` · ${p.requests} gateway call(s)\n`
    + `input ${fmtTok(p.input)} · output ${fmtTok(p.output)}`
    + ` · cache R ${fmtTok(p.cache_read)} · W ${fmtTok(p.cache_write)}`;
}



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
// rather than after the whole fleet resolves. Returns [xells, restream, syncXells]:
//   `restream`  re-runs the NDJSON stream (once per project selection — the full-resolve pass).
//   `syncXells` ADOPTS an already-decorated fleet.xells array into the map without a re-stream.
//                Called from snapshot delivery so a live change (which brings the whole fleet read
//                model with it) updates the honeycomb with zero extra /fleet/xells-stream HTTP
//                requests — the "spamming the fleet stream per event" this refactor stops.
// Each pass upserts by id while it streams — existing hexes never flicker — then prunes ids the
// pass didn't see.
function useStreamedXells(projectId) {
  const [xells, setXells] = useState([]);
  const mapRef = useRef(new Map());
  const acRef = useRef(null);
  // FORCE-CLEAR on switch, synchronously. The effect below also resets, but effects run AFTER the
  // render that already saw the new projectId — so for one frame the grid would still hold the
  // PREVIOUS project's hexes (the lingering remnants). Reset-on-prop-change during render (React's
  // documented pattern) drops them before paint, so a switch never flashes the old project.
  const [prevPid, setPrevPid] = useState(projectId);
  if (projectId !== prevPid) {
    setPrevPid(projectId);
    mapRef.current = new Map();
    acRef.current?.abort();
    setXells([]);
  }
  // Always-current selected project, written during render so an ASYNC stream from a PREVIOUS
  // selection can tell it is stale before it writes a single hex into the NEW project's grid. A
  // stale runStream — the previous project's LAST update stream landing after the switch — would
  // otherwise abort the fresh stream, stream the OLD project's xells into the SAME map, and paint
  // the remnants that linger across a project switch.
  const pidRef = useRef(projectId);
  pidRef.current = projectId;
  const runStream = useCallback(async () => {
    acRef.current?.abort();
    const ac = new AbortController();
    acRef.current = ac;
    const seen = new Set();
    const streamProjectId = projectId;         // this stream's project — the staleness witness
    const stillCurrent = () => pidRef.current === streamProjectId;
    try {
      await streamFleetXells(streamProjectId, {
        signal: ac.signal,
        onXell: (x) => {
          if (ac.signal.aborted) return;
          if (!stillCurrent()) { ac.abort(); return; }   // stale — drop this stream, keep the new grid
          seen.add(x.id);
          mapRef.current.set(x.id, x);
          setXells(Array.from(mapRef.current.values()));
        },
      });
      if (ac.signal.aborted) return;
      if (!stillCurrent()) return;   // stale at completion — never prune the new project's map
      for (const id of Array.from(mapRef.current.keys())) if (!seen.has(id)) mapRef.current.delete(id);
      setXells(Array.from(mapRef.current.values()));
    } catch (e) { /* aborted or transient — keep the last good set */ }
  }, [projectId]);

  // Adopt a whole decorated xells array (from a fleet snapshot) into the map, dropping the ids the
  // snapshot doesn't carry. The snapshot IS the authoritative fleet read, so this keeps the map in
  // lockstep with it — the same prune a stream completion does.
  const syncXells = useCallback((rows) => {
    if (pidRef.current !== projectId) return;   // a stale snapshot must not paint the new project
    if (!Array.isArray(rows)) return;
    const next = new Map();
    for (const x of rows) next.set(x.id, x);
    mapRef.current = next;
    setXells(Array.from(next.values()));
  }, [projectId]);

  useEffect(() => {
    mapRef.current = new Map();
    setXells([]);
    runStream();
    return () => acRef.current?.abort();
  }, [projectId, runStream]);

  return [xells, runStream, syncXells];
}

export default function App() {
  const [projects, setProjects] = useState([]);
  const [projectId, setProjectId] = useState(null);
  const [fleet, setFleet] = useState(null);
  const [timeline, setTimeline] = useState(null);
  const [conn, setConn] = useState('connecting');
  const [version, setVersion] = useState(0);
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [diffs, setDiffs] = useState({});
  const [dismissed, setDismissed] = useState({});
  const [logs, setLogs] = useState([]);
  const [shipLogs, setShipLogs] = useState({});   // ship id → live build lines (this sitting only)
  const [showTerm, setShowTerm] = useState(false);
  // Queenzee↔xell activity events from the SSE stream — the honeycomb's animated lines. Each new
  // event is drained by <HiveCanvas> and becomes a short-lived arrow; the buffer stays tiny.
  const [qzActivity, setQzActivity] = useState([]);
  const qzSeq = useRef(0);
  // false | {} — the single "+" prompt composer. No harness is pinned on open: on a router-gated
  // fleet the router picks the persona; on a fleet with no router feature the human chooses it
  // inside the composer (Dispatch.jsx). (Object rather than `true` so a future pin can ride along
  // without flipping the truthy check.)
  const [showDispatch, setShowDispatch] = useState(false);
  const [showManagerMint, setShowManagerMint] = useState(false); // the Dispatch manager-variant, from the + hexagon
  const [showWork, setShowWork] = useState(false);   // the WORK TRACKER console (tickets · board · timeline)
  const [workInitialTab, setWorkInitialTab] = useState(null); // force a tracker tab when opened from the + hexagon
  // ── a NESTED project being onboarded from the + hexagon (project inside this project's tree) ──
  // { parent_id, parent_name, parent_repo_root } — the CreateForm confines its folder picker to the
  // parent's repo_root and forces the git-behavior choice. null = the plain "+ add provider" setup.
  const [nestedProject, setNestedProject] = useState(null);
  // true when the + hexagon's project option opened the setup — ALWAYS create mode (a NEW project).
  // The "+ add provider" button keeps the legacy behaviour: edit the selected project if one exists,
  // create when there is none. The + menu asks for a NEW project either way.
  const [setupCreate, setSetupCreate] = useState(false);
  // ── the honeycomb's WORK-NODE hierarchy (hive levels) ─────────────────────────
  // 'projects' = the TOP level: every hexagon is a project (its root work_node) — what the console
  // opens on. 'nodes' = inside a project: the level named by nodePath (empty = the project root's
  // children), where a child work_node is a hexagon — the assigned xell when it has one, a vacant
  // dashed seat when it does not — and drilling into a node makes IT the context every new prompt
  // is cut under (parent_work_item on the dispatch).
  const [hiveMode, setHiveMode] = useState('projects');
  const [nodePath, setNodePath] = useState([]);      // [{id,title}] from the project root downward
  const [workItems, setWorkItems] = useState([]);    // the selected project's plan (flat, from /work-items)
  const [showDelivery, setShowDelivery] = useState(false); // DELIVERY TELEMETRY (cycle time, waste, gate waits)
  const [providers, setProviders] = useState([]);  // provider-token read model (masked) for the buttons
  const [showSetup, setShowSetup] = useState(false); // Project setup opened from "add provider"
  const [showConsoleSettings, setShowConsoleSettings] = useState(false); // ⚙ browser-local prefs (term engine)
  const [toasts, setToasts] = useState([]);        // async-dispatch progress notifications

  const [githubAccessState, setGithubAccessState] = useState(null); // {can_push, can_pr, default_branch, reason}
  const [githubOut, setGithubOut] = useState(null); // last push/PR outcome {kind, busy, pushed, opened, url, reason}
  const [menu, setMenu] = useState(null); // container context menu {x,y,c}
  const [loadBackupFor, setLoadBackupFor] = useState(null); // db container to restore a backup INTO
  const [shellFor, setShellFor] = useState(null); // container to open a docker-exec shell into

  // ── honeycomb shell ──────────────────────────────────────────────────────────
  const orientation = useOrientation();          // 'portrait' | 'landscape'
  const [honeySide, setHoneySide] = useState('a'); // which half is the honeycomb (flip swaps it)
  // whether the HARNESS hexagons are shown (default ON). Flipped OFF, the harness badges hide and the
  // connector wires trace straight from each git-graph commit dot to its xell — no harness cell to route
  // through. A view preference only: it changes nothing about the fleet or the payload.
  const [showHarness, setShowHarness] = useState(true);
  // honey pane's fraction of the two OUTER panes' combined size — the grip in the graph pane slides
  // this to move the centre divider (null → the CSS 3:2 default). Persisted per orientation.
  const [split, setSplit] = useState(null);
  useEffect(() => { setSplit(readSplit(orientation)); }, [orientation]);
  const [expandedId, setExpandedId] = useState(null); // the xell blown into a flower + action drawer
  const [termXell, setTermXell] = useState(null);  // cxell-zee terminal modal, opened from the flower
  const [msgXell, setMsgXell] = useState(null);    // message-composer modal, opened from the flower's 📨 button
  const [envXell, setEnvXell] = useState(null);    // environment panel (ticket #20) — see/pin/clear what a xell resolves to
  const [directivesXell, setDirectivesXell] = useState(null); // manager-directives panel, opened from the flower's 🧭 button
  const [obsXell, setObsXell] = useState(null); // observability panel, opened from the flower's ◉ button (per-turn ledger)
  // ♻ swap composer, opened from the flower's BRANCH petal: replace the ZEE working this xell and
  // keep the xell (same branch, commits, containers, database, card). It carries the xell's diff so the
  // composer can warn about uncommitted work — the collect saves COMMITS, and only commits.
  const [swapXell, setSwapXell] = useState(null);
  const [termChoice, setTermChoice] = useState(null);  // ⌨ clicked → pick in-house vs deep-linked
  const [streamedXells, restreamXells, syncXells] = useStreamedXells(projectId);
  // hex screen positions published by HiveCanvas each draw. GraphPane + Connectors subscribe to a
  // per-frame "geometry changed" fire so a pan/zoom re-tracks the graph and re-routes the wires
  // WITHOUT re-rendering the whole app.
  const hexPosRef = useRef({});
  const harnessPosRef = useRef({});   // harness grid-cell centres (published by HiveCanvas, read by Connectors)
  const geomListeners = useRef(new Set());
  const subscribeGeom = useCallback((fn) => {
    geomListeners.current.add(fn);
    return () => geomListeners.current.delete(fn);
  }, []);
  const fireGeom = useCallback(() => {
    geomListeners.current.forEach((fn) => { try { fn(); } catch { /* listener detached mid-fire */ } });
  }, []);
  // shared hover: hovering a hex or a commit dot highlights the hex, its wire, and its dot together.
  // `harness` is the third focus target — hovering a harness badge lights up every xell that wears
  // it (and its through-traces), the mirror of a xell hover lighting up the harness it wears.
  // A ref + subscription (not state) so a hover doesn't re-render the whole app.
  const hoverRef = useRef({ id: null, commit: null, harness: null });
  const hoverListeners = useRef(new Set());
  const setHover = useCallback((h) => {
    const n = { id: h.id ?? null, commit: h.commit ?? null, harness: h.harness ?? null };
    const c = hoverRef.current;
    if (c.id === n.id && c.commit === n.commit && c.harness === n.harness) return;
    hoverRef.current = n;
    hoverListeners.current.forEach((fn) => { try { fn(); } catch { /* detached */ } });
  }, []);
  const subscribeHover = useCallback((fn) => {
    hoverListeners.current.add(fn);
    return () => hoverListeners.current.delete(fn);
  }, []);

  // open the container context menu at the cursor — passed down to each xell's ContainerChips.
  // onMenu stops propagation so opening one doesn't trip the document closer below.
  const openMenu = useCallback((e, c) => { e.preventDefault(); e.stopPropagation(); setMenu({ x: e.clientX, y: e.clientY, c }); }, []);
  // The QUEENZEE node's terminal: a docker-exec shell into the queenzee's own server container
  // (tier 'prod', the row the terminal bridge resolves process roles into). Same ContainerTerminal
  // the inventory chips open, so the auth/gating is exactly the existing human-console door —
  // and the same tmux attach-or-create session retention (close the modal, reopen, still there).
  //
  // The node needs to SHOW a "no terminal" state BEFORE the click, not silently no-op after it,
  // so the terminal's availability is resolved here (into qzTerminal) and passed to HiveCanvas.
  // Three states:
  //   'ready'  — a prod server container is shellable (health 'up' for a real container): the
  //              node is live, clicking opens the shell.
  //   'down'   — a prod server container EXISTS but is not shellable. That is a REAL fault in the
  //              container-shell path (the bridge will refuse with "not running"), so the node
  //              says "server down" and the click still opens the shell to surface the bridge error
  //              rather than painting a "no terminal" badge over a genuine breakage.
  //   'none'   — no prod server container at all: the node is explicitly disabled ("no terminal"),
  //              and the click does nothing because there is nothing to shell into.
  const qzTerminal = useMemo(() => {
    const servers = fleet?.containers?.server || [];
    const ready = servers.find((c) => c.tier === 'prod' && c.shellable);
    if (ready) return { status: 'ready', container: ready };
    const present = servers.find((c) => c.tier === 'prod');
    if (present) return { status: 'down', container: present };
    return { status: 'none', container: null };
  }, [fleet]);
  const openQueenzeeTerminal = useCallback(() => {
    const c = qzTerminal.container;
    if (c) setShellFor(c);
  }, [qzTerminal]);
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
  // Written during render (not in an effect) so an in-flight fetch that resolves in the render→
  // effect window already sees the NEW selection — the effect-updated ref let the old project's
  // LAST update stream land one frame late and repaint the previous project's remnants.
  const projectIdRef = useRef(null);
  projectIdRef.current = projectId;
  // Debounce handle for streamChange — one pending re-read at a time, cleared when the next event
  // (or an explicit refresh) supersedes it. Lives in a ref so the debounce survives re-renders.
  const refreshTimer = useRef(null);
  // Which AI provider ACCOUNTS this project can dispatch on. Decides whether the single "+ prompt"
  // button is pressable (or the honest "add provider" fallback) — visibility IS the token store.
  // NB: read the fallback id off `fleet` (state), NOT the `project` const destructured from it
  // further down — referencing that in this deps array is a temporal-dead-zone crash that
  // white-screened the whole console on first render (found 2026-07-21).
  useEffect(() => {
    const pid = projectId || fleet?.project?.id;
    if (!pid) return;
    getProviderTokens(pid).then((t) => setProviders(Array.isArray(t) ? t : [])).catch(() => setProviders([]));
  }, [projectId, fleet?.project?.id, showSetup, showDispatch]);
  // GitHub access check: does the stored token let us push / open PRs to the remote?
  // Re-fetches when the project or the setup modal closes (the operator may have added a token there).
  useEffect(() => {
    const pid = projectId || fleet?.project?.id;
    if (!pid) { setGithubAccessState(null); return; }
    let live = true;
    githubAccess(pid).then((a) => { if (live) setGithubAccessState(a); })
      .catch(() => { if (live) setGithubAccessState(null); });
    return () => { live = false; };
  }, [projectId, fleet?.project?.id, showSetup]);
  // Latest project list, read from callbacks with stable identities (e.g. selectProject) so they
  // can resolve an id → project row for the URL without re-binding on every list change.
  const projectsRef = useRef([]);
  useEffect(() => { projectsRef.current = projects; }, [projects]);
  const applyFleet = useCallback((f) => {
    if (f && (!projectIdRef.current || f.project?.id === projectIdRef.current)) setFleet(f);
  }, []);

  const loadProjects = useCallback(async () => {
    const ps = await getProjects();
    setProjects(ps);
    return ps;
  }, []);

  // The selected project's PLAN — the flat work-item list the honeycomb's node levels are computed
  // from. `pid` is explicit because the default project's id is only known from the fleet snapshot.
  const loadWorkItemsFor = useCallback(async (pid) => {
    if (!pid) return;
    try {
      const items = await listWorkItems(pid);
      // stale-guard, same rule as loadAll: never paint the previous project's plan
      if (!projectIdRef.current || projectIdRef.current === pid) {
        setWorkItems(Array.isArray(items) ? items : []);
      }
    } catch { /* keep last */ }
  }, []);

  // Load EVERYTHING for the selected project: the fleet snapshot, the git graph and the diffs.
  // This is the full-resolve path — a project switch, or a landing/ship (which moves main, so the
  // graph and diffs all change at once). Live churn routes through the cheaper streamChange below,
  // which re-reads only the read models that event type can have changed.
  const loadAll = useCallback(async () => {
    const pid = projectId;
    try {
      const [f, t, d] = await Promise.all([getFleet(pid), getTimeline(pid), getDiffs(pid)]);
      // STALE-GUARD: the selected project can change while this fetch is in flight (a switch, or the
      // previous project's LAST stream event). Drop the WHOLE batch — applying it would repaint the
      // previous project's timeline/diffs AND re-stream its xells into the honeycomb (the lingering
      // remnants across a switch).
      if (projectIdRef.current !== pid) return;
      applyFleet(f);
      if (t) setTimeline(t);
      if (d) setDiffs(d);
      syncXells(f?.xells || []);    // adopt the snapshot's decorated xells — no extra NDJSON stream
      loadProjects();               // keep the switcher's xell counts fresh
      loadWorkItemsFor(pid || f?.project?.id);   // …and the plan the honeycomb's node levels read
      setVersion((v) => v + 1);
    } catch { /* keep last */ }
  }, [projectId, loadProjects, applyFleet, syncXells, loadWorkItemsFor]);

  // An EXPLICIT re-read (the caller just acted — dispatch, build, pause, a gate decision…): full.
  const refresh = useCallback(async () => {
    await loadAll();
  }, [loadAll]);

  // A LIVE stream event, debounced and type-scoped: this is the "stop spamming timeline, diffs and
  // fleet API requests" path. Most events (a zee's status, a container health flap) can only move
  // the FLEET snapshot, so they re-read fleet alone. A `land`/`ship`/`project` event moved main or
  // production, so those re-read the git graph and diffs too. Bursts of same-type events collapse
  // into one re-read, and a burst that overlaps an explicit refresh skips the stale one entirely.
  const streamChange = useCallback((type) => {
    const pid = projectIdRef.current;
    if (!pid) return;
    clearTimeout(refreshTimer.current);
    const git = GIT_TYPES.includes(type);
    const work = () => {
      if (pid !== projectIdRef.current) return;   // project switched while debouncing — drop it
      // The honeycomb renders from streamedXells (not fleet.xells), so the fresh snapshot must
      // ALSO adopt its xells into the honeycomb — the same sync onSnapshot does — or the hexagons
      // would go stale the moment a live event lands.
      const f = getFleet(pid).then((fl) => {
        if (projectIdRef.current !== pid) return;
        applyFleet(fl);
        syncXells(fl?.xells || []);
      });
      if (git) {
        getTimeline(pid).then((t) => { if (projectIdRef.current === pid && t) { setTimeline(t); setVersion((v) => v + 1); } });
        getDiffs(pid).then((d) => { if (projectIdRef.current === pid && d) setDiffs(d); });
      }
      if (type === 'work') loadWorkItemsFor(pid);   // a plan change moves the honeycomb's node levels
      f.catch(() => {});
      loadProjects();
    };
    refreshTimer.current = setTimeout(work, git ? 120 : 400);
  }, [applyFleet, syncXells, loadProjects, loadWorkItemsFor]);

  // ── toast plumbing ───────────────────────────────────────────────────────────
  const dismissToast = useCallback((id) => setToasts((ts) => ts.filter((t) => t.id !== id)), []);
  // Upsert: create or update a toast by id. Used for progress where the same id emits
  // multiple events, and for one-shot notifications (dispatch, pause, etc.) whose ids
  // are always unique — so this single verb replaces the old "push then update" pattern.
  const upsertToast = useCallback((id, props) => {
    setToasts((ts) => {
      const idx = ts.findIndex((t) => t.id === id);
      if (idx >= 0) {
        const updated = [...ts];
        updated[idx] = { ...updated[idx], ...props };
        return updated;
      }
      return [...ts, { id, ...props }];
    });
  }, []);
  // Convenience for callers that pass { id, … } as one object (dispatch, pause, nudge, …).
  // Unpacks to upsertToast(id, rest) so the upsert pattern is shared.
  const pushToast = useCallback((t) => {
    if (t?.id) upsertToast(t.id, t);
  }, [upsertToast]);
  // Update-only for cases where the toast is guaranteed to already exist.
  const updateToast = useCallback((id, patch) =>
    setToasts((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } : t))), []);
  // Append a raw log line to a db-op panel card, creating a minimal running card if it does not
  // exist yet (a log event can race ahead of the first progress event). Capped so a chatty
  // pg_restore cannot eat the tab. Functional update, so bursts of lines never lose an append.
  const appendToastLine = useCallback((id, line) => {
    setToasts((ts) => {
      const idx = ts.findIndex((t) => t.id === id);
      if (idx < 0) {
        return [...ts, { id, kind: 'dbop', status: 'running', title: 'Database operation', body: 'working…', lines: [line] }];
      }
      const updated = [...ts];
      const cur = updated[idx];
      updated[idx] = { ...cur, lines: [...(cur.lines || []), line].slice(-400) };
      return updated;
    });
  }, []);

  // Live progress of db backup / restore / copy — maps SSE events to a WIDE persistent panel card
  // (kind 'dbop') in the notification stack, not a one-line toast. The card id is
  // `dbop-<op>-<id>` so all events for the same operation converge on one card. A running card
  // stays until it finishes; a finished/failed one lingers with its full log and a ✕ (and
  // auto-dismisses, so a settled job does not stack up forever).
  const onDbOpProgress = useCallback((p) => {
    if (!p?.op || !p?.id) return;
    const tid = `dbop-${p.op}-${p.id}`;
    if (p.status === 'finished') {
      upsertToast(tid, { kind: 'dbop', status: 'finished', title: `${capitalise(p.op)} complete`, body: p.msg, pct: 100, onRetry: null });
      setTimeout(() => dismissToast(tid), 15000);
    } else if (p.status === 'failed' || p.status === 'cancelled') {
      const label = p.status === 'cancelled' ? 'cancelled' : 'failed';
      upsertToast(tid, { kind: 'dbop', status: p.status, title: `${capitalise(p.op)} ${label}`, body: p.error || p.msg, pct: 0, onRetry: null });
      setTimeout(() => dismissToast(tid), 30000);
    } else {
      // running — upsert the card with the current phase + progress
      const title = p.label
        ? `${capitalise(p.op)} — ${p.label}`
        : `${capitalise(p.op)} in progress`;
      upsertToast(tid, { kind: 'dbop', status: 'running', title, body: p.msg, pct: p.pct ?? 0, onRetry: null });
    }
  }, [upsertToast, dismissToast]);

  // Raw output lines of the same operations — the actual pg_dump / pg_restore / docker log,
  // appended to the operation's toast so it reads like a build log (the ship card's live feed).
  const onDbOpLog = useCallback((p) => {
    if (!p?.op || !p?.id || p.line == null) return;
    appendToastLine(`dbop-${p.op}-${p.id}`, p.line);
  }, [appendToastLine]);

  // Fire-and-forget dispatch. The composer hands us the whole payload and closes IMMEDIATELY; the
  // slow bits (uploading pasted attachments, renaming the worktree, spawning + awaiting the zee)
  // run here and report through a toast. A failure keeps the payload in a Retry closure, so "no
  // ready xell available" et al. never lose the composed prompt even though the modal is already gone.
  const runDispatch = useCallback(async (payload) => {
    const id = `disp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const nAtt = payload.images?.length || 0;   // `images` is the wire field's legacy name — any file
    // THE ROUTER PAYLOADS (139) ride the same fire-and-forget toast machinery: the composer closed
    // already, so progress/failure/Retry live here whichever door the payload goes through.
    //   via_router      → hand the RAW prompt to the live router (POST /api/router/route)
    //   deploy_router   → deploy the router zee (no prompt — provider/model only)
    //   redeploy_router → same xell, new zee (the "swap it with a better model" button)
    const routerVerb = payload.via_router ? 'route' : payload.deploy_router ? 'deploy'
      : payload.redeploy_router ? 'redeploy' : null;
    pushToast({ id, kind: 'progress',
      title: routerVerb === 'route' ? 'Routing your prompt…'
        : routerVerb ? `${routerVerb === 'redeploy' ? 'Redeploying' : 'Deploying'} the router…`
        : 'Dispatching a zee…',
      body: routerVerb === 'route'
        ? 'Handing the raw prompt to the router zee — it recomposes and dispatches.'
        : routerVerb ? 'Claiming a xell and spawning the router (prod read-only, no land/ship)…'
        : nAtt
        ? `Uploading ${nAtt} attachment${nAtt === 1 ? '' : 's'}, claiming a xell and spawning…`
        : 'Claiming a ready xell and spawning…' });
    // YIELD before the network call. dispatchTask() runs synchronously up to its first await —
    // JSON.stringify()-ing a multi-MB base64 screenshot blocks the main thread for that whole
    // serialization. If we call it inside the same click-handler tick, that blocking happens
    // BEFORE React commits the modal-close + toast, so the window appears to freeze exactly as
    // before. Two rAFs guarantee the browser has painted the closed modal and the progress toast
    // first; the heavy serialization then runs with the UI already updated.
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    try {
      const r = routerVerb === 'route' ? await routePrompt(payload)
        : routerVerb === 'deploy' ? await deployRouter(payload)
        : routerVerb === 'redeploy' ? await redeployRouter(payload)
        : await dispatchTask(payload);
      updateToast(id, { kind: 'success', onRetry: null,
        title: routerVerb === 'route' ? 'Prompt routed' : routerVerb ? 'Router deployed' : 'Zee dispatched',
        body: routerVerb === 'route'
          ? `Handed to the router${r?.router?.slug ? ` in ${r.router.slug}` : ''}${r?.delivered === false ? ' — stored; it reads it on its next turn' : ' — it recomposes and dispatches'}.`
          : r?.slug ? `Running in ${r.slug}.` : 'The zee is on it.' });
      refresh();
      setTimeout(() => dismissToast(id), 7000);
    } catch (e) {
      updateToast(id, { kind: 'error', body: e?.message || String(e),
        title: routerVerb === 'route' ? 'Routing failed' : routerVerb ? 'Router deploy failed' : 'Dispatch failed',
        onRetry: () => { dismissToast(id); runDispatch(payload); } });
    }
  }, [pushToast, updateToast, dismissToast, refresh]);

  // Fire a prod backup from a db chip's "Back up now" menu item. Same async job as the backups
  // panel's button (POST /backups/run) — the server creates the running row and broadcasts
  // db-op-progress / db-op-log, which drive the LIVE panel card in the notification stack. No
  // "Starting…" toast here: the panel IS the progress. A refusal (already running, prod busy)
  // still surfaces as an error toast.
  const runBackupNow = useCallback(async (c) => {
    const id = `bk-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    try {
      await runBackup(projectId || fleet?.project?.id);
      refresh();
    } catch (e) {
      pushToast({ id, kind: 'error', title: 'Backup not started',
        body: e?.error || e?.message || String(e) });
      setTimeout(() => dismissToast(id), 10000);
    }
    // Reads `fleet?.project`, NOT the destructured `project` — and this is not a style choice.
    // `const { project } = fleet` happens far below, after the `if (!fleet) return` early return;
    // a dep array is evaluated on EVERY render, so naming `project` here touched it in its temporal
    // dead zone and threw "Cannot access 'project' before initialization" on the first render. The
    // whole console rendered blank (2026-07-22). Moving this hook below that destructure is not the
    // fix either — it sits after an early return, and hooks must run unconditionally. `fleet` is
    // state declared at the top of the component, so it is always safe to reference here.
  }, [pushToast, dismissToast, refresh, projectId, fleet]);

  // ── GitHub outbound (push / open PR) ───────────────────────────────────────
  // Same flow as ProjectSetup's BasicsSection — confirm, call API, report the outcome.
  const doGitHubPush = useCallback(async () => {
    const pid = projectId || fleet?.project?.id;
    if (!pid || !githubAccessState?.can_push) return;
    if (!(await showConfirm(
      `Push local ${fleet?.project?.main_branch || 'main'} of ${fleet?.project?.name} to the GitHub remote?\n\n`
      + `${fleet?.project?.remote_url || ''}\n\nThis publishes your local history to the remote (fast-forward only — a `
      + `diverged remote is refused, never force-pushed).`
      // ruleset pre-flight: GitHub will refuse this by RULE (GH013) — say so before the click
      + (githubAccessState?.push_rule_block ? `\n\n⚠ ${githubAccessState.push_rule_block}.` : ''),
      { title: 'Push to remote?', okLabel: 'Push' }))) return;
    setGithubOut({ busy: true, kind: 'push' });
    try {
      const r = await pushProject(pid);
      setGithubOut({ ...r, kind: 'push' });
    } catch (e) { setGithubOut({ kind: 'push', reason: e.message }); }
  }, [projectId, fleet?.project?.id, fleet?.project?.main_branch, fleet?.project?.name, fleet?.project?.remote_url, githubAccessState]);

  // Pull is fetch + fast-forward ONLY from the GitHub remote.
  const doGitHubPull = useCallback(async () => {
    const pid = projectId || fleet?.project?.id;
    if (!pid) return;
    setGithubOut({ busy: true, kind: 'pull' });
    try {
      const r = await pullProject(pid);
      setGithubOut({ ...r, kind: 'pull' });
    } catch (e) { setGithubOut({ kind: 'pull', reason: e.message }); }
  }, [projectId, fleet?.project?.id]);

  // Commit the xource's dirty work in ONE step (stage tracked changes, then commit) — the "commit
  // locally" door, so a human can commit their work and then push. Needs a message; confirmed first.
  const doGitHubCommit = useCallback(async () => {
    const pid = projectId || fleet?.project?.id;
    if (!pid) return;
    const msg = await showPrompt(
      `Commit the xource's dirty work (staged + unstaged tracked changes) on ${fleet?.project?.main_branch || 'main'}?\n\n`
      + 'Untracked files and .claude/ worktrees are left alone. After this you can ↑ Push or ⇅ PR.\n\n'
      + 'Commit message:',
      { title: 'Commit local work', okLabel: 'Commit', placeholder: 'e.g. feat: describe your change' });
    if (msg == null) return;
    if (!String(msg).trim()) { setGithubOut({ kind: 'commit', reason: 'a commit message is required' }); return; }
    setGithubOut({ busy: true, kind: 'commit' });
    try {
      const r = await commitXourceDirty(pid, String(msg).trim());
      setGithubOut({ ...r, kind: 'commit' });
    } catch (e) { setGithubOut({ kind: 'commit', reason: e.message }); }
  }, [projectId, fleet?.project?.id, fleet?.project?.main_branch]);

  const doGitHubPR = useCallback(async (merge = false) => {
    const pid = projectId || fleet?.project?.id;
    if (!pid || !githubAccessState?.can_pr) return;
    const headBranch = await showPrompt(
      `${merge ? 'Open a pull request and MERGE it' : 'Open a pull request'} from local ${fleet?.project?.main_branch || 'main'}.\n\n`
      + `A side branch is pushed to the remote and a PR is opened against ${githubAccessState?.default_branch || 'the default branch'}`
      + `${merge ? ', then merged into it on GitHub' : ''}. `
      + `Name the head branch (leave as-is for a generated name):`,
      { title: merge ? 'Open a pull request and merge?' : 'Open a pull request?',
        defaultValue: `zeehive/${fleet?.project?.main_branch || 'main'}`, okLabel: merge ? 'Open & merge' : 'Open PR' });
    if (headBranch === null) return;
    setGithubOut({ busy: true, kind: 'pr', merge });
    try {
      const opts = { headBranch: headBranch.trim() || undefined, merge };
      let r = await pullRequestProject(pid, opts);
      // A rule that scans the COMMITS (push protection, file size, signatures…) is not fixed by a
      // clean tip — offer the squashed snapshot, which needs neither a secret-scanning bypass nor a
      // rewrite of main. Only for the rules it can actually help with (squashHelps).
      if (squashHelps(r)) {
        setGithubOut({ ...r, kind: 'pr', merge });
        if (await showConfirm(squashOffer(r, fleet?.project?.main_branch || 'main'),
          { title: 'Open the PR from a squashed snapshot?', okLabel: 'Open squashed PR' })) {
          setGithubOut({ busy: true, kind: 'pr', merge });
          r = await pullRequestProject(pid, { ...opts, squash: true });
        }
      }
      setGithubOut({ ...r, kind: 'pr', merge });
    } catch (e) { setGithubOut({ kind: 'pr', merge, reason: e.message }); }
  }, [projectId, fleet?.project?.id, fleet?.project?.main_branch, githubAccessState]);

  // once: global logs, and pick the active project (persisted → first)
  useEffect(() => {
    getLogs().then((ls) => setLogs(ls));
    loadProjects().then((ps) => {
      // URL param wins (a shared/refreshed link is explicit intent), then the last-used project
      // from localStorage, and only then fall back to the first project we can see.
      const fromUrl = findByToken(ps, readProjectParam());
      const stored = localStorage.getItem(PROJECT_KEY);
      const picked = fromUrl || ps.find((p) => p.id === stored) || ps[0] || null;
      setProjectId(picked?.id || null);
      writeProjectParam(picked);   // normalise the URL (fill it in, or fix an unknown token)
    });
  }, [loadProjects]);

  // (re)load the selected project's data + subscribe to its live stream. Re-runs when the
  // selected project changes (projectId may be null on first paint → server uses the default).
  useEffect(() => {
    setConn('connecting');
    setTimeline(null); setDiffs({});   // don't show the previous project's git graph while loading
    loadAll();   // full resolve for the NEW project — timeline, diffs, fleet + the honeycomb's xells
    const unsub = subscribe(projectId, {
      // The snapshot delivers the WHOLE fleet read model (the server sends one per connection), so
      // it adopts the xells straight into the honeycomb — no separate NDJSON re-stream per event.
      onSnapshot: (f) => { applyFleet(f); syncXells(f?.xells || []); setConn('live'); },
      // Every later event names its type; re-read only what that type can have moved (fleet alone
      // for most; the git graph too for land/ship/project). Debounced, so a burst collapses.
      onChange: streamChange,
      onStatus: setConn,
      onLog: (l) => setLogs((prev) => [...prev.slice(-1999), l]),
      // Queenzee↔xell activity → the honeycomb's animated lines. The id makes each event unique so
      // HiveCanvas can drain exactly the ones it has not drawn yet (a burst of same-second events
      // for one xell must not collapse into a single line).
      onQueenzeeActivity: (a) => setQzActivity((prev) => [...prev.slice(-31), { ...a, _id: ++qzSeq.current }]),
      // Per-ship build feed, keyed by ship id, capped so a chatty build can't eat the tab.
      onShipLog: (l) => setShipLogs((prev) => ({ ...prev, [l.id]: [...(prev[l.id] || []).slice(-399), l] })),
      // Live progress of db backup / restore / copy — drives progress toasts.
      onDbOpProgress,
      // Raw command output lines of the same operations — appended to their toast as a build log.
      onDbOpLog,
    });
    return () => { clearTimeout(refreshTimer.current); unsub(); };
  }, [projectId, loadAll, streamChange, applyFleet, syncXells, onDbOpProgress, onDbOpLog]);

  const selectProject = useCallback((id) => {
    setProjectId(id);
    localStorage.setItem(PROJECT_KEY, id);
    writeProjectParam(projectsRef.current.find((p) => p.id === id));
    // a project switch lands at ITS root level — the previous project's node path means nothing here
    setHiveMode('nodes');
    setNodePath([]);
    setWorkItems([]);
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
      const nextProject = ps[0] || null;
      const next = nextProject?.id || null;
      setProjectId(next);
      if (next) localStorage.setItem(PROJECT_KEY, next); else localStorage.removeItem(PROJECT_KEY);
      writeProjectParam(nextProject);
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
  // The PROD-DATA asks (a zee asking for the production database, or for a landed seed file to be
  // run on production) live on the card of the xell that asked — the same reasoning as landings:
  // "wise-grove wants prod" is information about wise-grove, and it is decided next to that xell's
  // own diff and status. Before this they had no console surface at all.
  const prodBindByXell = {};
  for (const r of fleet.prod_bind || []) (prodBindByXell[r.xell_id] ||= []).push(r);
  const seedByXell = {};
  for (const r of fleet.prod_seed || []) (seedByXell[r.xell_id] ||= []).push(r);
  // A MANAGER zee's open "this xell is finished" suggestions, keyed by the xell they are ABOUT —
  // they render on that xell's chip, because that is the xell the decision reaps.
  const doneSuggestByXell = {};
  for (const r of fleet.done_suggestions || []) (doneSuggestByXell[r.target_xell_id] ||= []).push(r);

  // Dismissed notifications, by request id. The server records the dismissal (dismissed_at on the
  // row) so it survives reloads and SSE refreshes — receipts used to pop back on every refresh
  // because hiding them was view-only state. The local map is just optimism: the card disappears
  // on the click, not on the round-trip. Visibility only — the land reaper keeps working the row.
  const dismiss = (id) => {
    setDismissed((d) => ({ ...d, [id]: true }));
    dismissLanding(id).catch(() => setDismissed((d) => ({ ...d, [id]: false })));
  };
  // …with ONE exception, and it is the whole of #11's gap 2: a landing that HOLDS THE RUNWAY with zees
  // queued behind it is not a receipt, it is a blocker, and hiding it hid them too (the approach queue
  // renders under the card that owns the runway). Dismissal still does not free the ref — the gate's
  // runwayOccupant ignores dismissed_at on purpose — so the honest resolution is to stop hiding it
  // rather than to let a hidden card silently pass the next push through. See holdsRunway in Landing.jsx.
  const visible = (rs) => (rs || []).filter((r) => holdsRunway(r) || (!dismissed[r.id] && !r.dismissed_at));

  // Route each landing to the card that will actually RENDER it — which is not the same question as
  // "does it have a xell_id". The fleet only lists xells with status <> 'retired', so a landing
  // whose xell has since been reaped has an id, no card, and (once the top panel stopped taking
  // anything with an id) nowhere at all. That is how nimble-atlas-d6e6d4's approved landing went
  // invisible. Ask whether a card exists, not whether an id does.
  // The honeycomb's xells come from the lazy NDJSON stream (hexagons appear as data arrives); fall
  // back to the fleet snapshot if the stream hasn't produced anything yet (e.g. it errored).
  // FORCE-CLEAR on switch: during a project switch the stream is reset to empty while the OLD
  // project's fleet snapshot still sits in state (applyFleet won't overwrite it until the NEW
  // project's snapshot arrives). Falling back to that stale fleet paints the previous project's
  // xells on the canvas — the "remnants that linger". So only use the fleet fallback when it
  // actually belongs to the selected project; otherwise show nothing until the new data lands.
  const fleetMatchesSelection = !projectId || fleet.project?.id === projectId;
  // CLIENT-SIDE PROJECT FILTER, belt-and-braces under the stream guards: every render, drop any xell
  // that demonstrably belongs to a DIFFERENT project before the honeycomb (or anything downstream)
  // sees it. The stream and fleet are project-scoped and the stale-stream guards keep the map clean,
  // but a xell from the previous project's LAST update stream must never paint — the filter is the
  // final gate, and it costs one pass over an already-small list.
  const gridXells = projectScoped(
    streamedXells.length ? streamedXells : (fleetMatchesSelection ? (fleet.xells || []) : []),
    projectId);
  const carded = new Set(gridXells.map((x) => x.id));
  // THE APPROACH QUEUE, by ref (067). One runway per ref, so the queue belongs under the card that
  // is holding it up — keyed the same way, and never merged into `landing` (a holding row is not a
  // card, and putting it there would raise the second question the runway exists to prevent).
  const holdingByRef = {};
  for (const h of fleet.holding || []) (holdingByRef[h.ref] ||= []).push(h);
  const queueFor = (r) => holdingByRef[r?.ref] || [];
  // Attached to the ROW at routing time rather than threaded down as a prop: a LandCard renders in
  // three different component trees, and the queue has to arrive in all of them.
  const withQueue = (r) => ({ ...r, queue: queueFor(r) });

  const landingByXell = {};
  const prsByRef = {};
  const orphanLandings = [];
  const refsWithCard = new Set();
  for (const r of fleet.landing || []) {
    if (r.kind === 'pull') { (prsByRef[r.ref] ||= []).push(r); continue; }
    refsWithCard.add(r.ref);
    if (r.xell_id && carded.has(r.xell_id)) (landingByXell[r.xell_id] ||= []).push(withQueue(r));
    else orphanLandings.push(withQueue(r));   // no xell (gate could not match the sha), or its xell is gone
  }
  // Holders whose runway has NO card to sit under. This should be a blink — the tower clears the
  // queue the moment the runway frees — but if a clearance ever fails to land, those zees would be
  // waiting with nothing on any screen, which is precisely the invisibility this protocol must not
  // introduce. So they get rendered somewhere rather than nowhere.
  const orphanQueues = Object.entries(holdingByRef)
    .filter(([ref]) => !refsWithCard.has(ref))
    .map(([ref, queue]) => ({ ref, queue }));
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

  // ── the honeycomb's WORK-NODE hierarchy: what THIS level's hexagons are ───────
  // Top level ('projects'): one hexagon per project — the root work_nodes. Inside a project
  // ('nodes'): the children of the context node (nodePath's tail, or the project root), each drawn
  // as its live xell when one is assigned, or as a vacant work-node seat when not; PLUS, at the
  // root level only, every xell carrying no open card (the provisioned pool, managers, the router,
  // production). A xell assigned to a deeper node shows at ITS level, not here. The cards pane, the
  // git graph and the wires keep reading the FULL xell list — only the honeycomb is levelled.
  const TERMINAL_WORK = ['done', 'cancelled'];
  const openItems = (workItems || []).filter((i) => i.kind !== 'project' && !TERMINAL_WORK.includes(i.status));
  const rootWorkItem = (workItems || []).find((i) => i.kind === 'project') || null;
  const workItemById = new Map((workItems || []).map((i) => [i.id, i]));
  const nodeChildCount = new Map();
  for (const i of openItems) if (i.parent_id) nodeChildCount.set(i.parent_id, (nodeChildCount.get(i.parent_id) || 0) + 1);
  const ctxItemId = hiveMode === 'nodes'
    ? (nodePath.length ? nodePath[nodePath.length - 1].id : rootWorkItem?.id || null) : null;
  let hiveCells;
  if (hiveMode === 'projects') {
    hiveCells = (projects || []).map((p) => ({ id: `proj:${p.id}`, hex_kind: 'project', slug: p.name, project: p }));
  } else {
    const xellById = new Map(xells.map((x) => [x.id, x]));
    const openXellItem = new Set(openItems.map((i) => i.xell_id).filter(Boolean));
    const level = ctxItemId ? openItems.filter((i) => i.parent_id === ctxItemId) : [];
    const seen = new Set();
    hiveCells = [];
    // the opened node's OWN xell first — clicking a work node opens its flower, so its zee leads the level
    if (nodePath.length && ctxItemId) {
      const ctxItem = workItemById.get(ctxItemId);
      const zx = ctxItem?.xell_id ? xellById.get(ctxItem.xell_id) : null;
      if (zx) { seen.add(zx.id); hiveCells.push({ ...zx, work_item: ctxItem, work_children: nodeChildCount.get(ctxItem.id) || 0 }); }
    }
    for (const it of level) {
      const zx = it.xell_id ? xellById.get(it.xell_id) : null;
      if (zx && !seen.has(zx.id)) {
        seen.add(zx.id);
        hiveCells.push({ ...zx, work_item: it, work_children: nodeChildCount.get(it.id) || 0 });
      } else if (!zx) {
        hiveCells.push({ id: `wn:${it.id}`, hex_kind: 'worknode', slug: it.title, work_item: it,
                         work_children: nodeChildCount.get(it.id) || 0, project_id: it.project_id });
      }
    }
    if (!nodePath.length) {
      for (const x of xells) if (!openXellItem.has(x.id) && !seen.has(x.id)) hiveCells.push(x);
    }
  }

  // drill into a project: select it and land at its root level
  const openProjectLevel = (p) => {
    if (!p?.id) return;
    if (p.id !== projectId) selectProject(p.id);
    else { setHiveMode('nodes'); setNodePath([]); }
    setExpandedId(null);
  };
  // drill into a work node: it becomes the context (new prompts are cut under it); its own live
  // xell — if it has one — opens as the flower at the new level
  const openNodeLevel = (item) => {
    if (!item?.id) return;
    setHiveMode('nodes');
    setNodePath((path) => {
      const at = path.findIndex((n) => n.id === item.id);
      return at >= 0 ? path.slice(0, at + 1) : [...path, { id: item.id, title: item.title }];
    });
    const zx = item.xell_id ? xells.find((x) => x.id === item.xell_id) : null;
    setExpandedId(zx ? zx.id : null);
  };
  // the vacant seat's "assign zee" chip → deploy a fresh worker onto the card (the board's verb)
  const assignNodeZee = async (item) => {
    if (!item?.id) return;
    if (!(await showConfirm(`Deploy a zee onto “${item.title}”?\n\nSpawns a real worker, briefed from the card itself, `
      + 'and assigns it — the same deploy the board runs.', { okLabel: 'Deploy' }))) return;
    const id = `deploy-${item.id}-${Date.now()}`;
    pushToast({ id, kind: 'progress', title: `Deploying a zee onto “${item.title}”…`,
      body: 'Claiming a ready xell and spawning — briefed from the card itself.' });
    try {
      const r = await deployWorkItem(item.id, {});
      updateToast(id, { kind: 'success', title: 'Zee deployed', onRetry: null,
        body: r?.xell?.slug ? `Running in ${r.xell.slug}.` : 'The zee is on it.' });
      refresh();
      setTimeout(() => dismissToast(id), 7000);
    } catch (e) {
      updateToast(id, { kind: 'error', title: 'Deploy failed', body: e?.message || String(e),
        onRetry: () => { dismissToast(id); assignNodeZee(item); } });
    }
  };

  // ── the '+ hexagon' create menu's actions ────────────────────────────────────
  // kind ∈ 'prompt'|'manager'|'ticket' (main level) | 'project'|'activity'|'task' (work_node sub).
  // Each opens the SAME surface the toolbar buttons do — the + menu is a second door, not a second
  // policy. The one genuinely new path is 'project' INSIDE a project: a NESTED project, whose
  // folder is confined to the parent's repo_root and whose git behavior is forced (ProjectSetup's
  // CreateForm renders the choice). Activity/task cut under the current node (server owns legality).
  const handlePlusAction = useCallback(async (kind) => {
    switch (kind) {
      case 'prompt': setShowDispatch({}); return;
      case 'manager': setShowManagerMint(true); return;
      case 'ticket': setWorkInitialTab('tickets'); setShowWork(true); return;
      case 'project': {
        // Inside a project (hiveMode 'nodes') the new project is NESTED — confine its folder to the
        // parent's repo_root and force the git-behavior choice. At the top level it is a plain new
        // project (the existing "＋ add provider" CreateForm, untouched).
        if (hiveMode === 'nodes') {
          const parent = rootWorkItem;   // the current project's root work_item (title = project name)
          setNestedProject({
            parent_id: parent?.id || null,
            parent_name: parent?.title || project?.name || '',
            parent_repo_root: project?.repo_root || '',
          });
        } else {
          setNestedProject(null);
        }
        setSetupCreate(true);
        setShowSetup(true);
        return;
      }
      case 'activity':
      case 'task': {
        const parentId = ctxItemId;   // the current node, or the project root at a project's level
        if (!parentId) {
          showAlert(`Open a node first — a new ${kind} is cut under the current node, and none is open.`, { variant: 'error' });
          return;
        }
        const title = await showPrompt(`New ${kind} under the current node`, { okLabel: 'Create', placeholder: 'title' });
        if (!title || !title.trim()) return;
        try {
          await createWorkItem({ project: projectId || project?.id, parent_id: parentId, kind, title: title.trim() });
          const id = `wi-${kind}-${Date.now()}`;
          pushToast({ id, kind: 'success', title: `${kind} created`, onRetry: null,
            body: `“${title.trim()}” is queued under the current node.` });
          setTimeout(() => dismissToast(id), 5000);
          refresh();
        } catch (e) { showAlert(e?.message || String(e), { variant: 'error' }); }
        return;
      }
      default: return;
    }
  }, [hiveMode, rootWorkItem, project, ctxItemId, projectId, refresh]);

  const expandedXell = expandedId ? xells.find((x) => x.id === expandedId) : null;
  const prodIds = xells.filter((x) => x.is_production).map((x) => x.id);  // graph tracks their median
  // The manager↔crew relation for the DOM surfaces (hive/crew.js — the SAME grouping the honeycomb, the
  // wires and the graph read; live crew only). Computed once here and handed down, not re-derived per row.
  const crewOfFleet = crewLinks(xells);

  // Open a xell's session in the right surface — the honeycomb flower's click target, and the
  // drawer card's. Web sessions open a tab; desktop-protocol sessions deep-link into Claude Desktop.
  const openSession = (x) => {
    if (!x?.viewer_url || x.is_production) return;
    // A cxell zee's viewer is an ssh:// terminal, not a URL a browser can open — open the
    // in-house terminal modal directly (the bloom center and shift+click both land here).
    if (x.viewer_kind === 'ssh-terminal') { setTermXell(x); return; }
    if (x.viewer_kind === 'desktop-protocol') openProtocol(x.viewer_url);
    else window.open(x.viewer_url, '_blank', 'noopener');
  };

  // The flower's canvas action buttons dispatch here (HiveCanvas onAction) — same verbs the old DOM
  // toolbar/drawer ran, with the same confirmations, so nothing changed but WHERE they are clicked.
  const handleFlowerAction = async (kind, x, diff) => {
    if (!x) return;
    // READ-ONLY, so it comes BEFORE the production guard: the flower's two diffstat petals open the
    // diff viewer, and "what has production drifted to?" is a question worth answering on prod too.
    if (kind === 'srcdiff' || kind === 'owndiff') {
      const own = kind === 'owndiff';
      if (own && x.is_production) return;                    // prod has no working tree
      showDiff({ kind: 'xell', xellId: x.id, diffKind: own ? 'own' : 'source',
        title: `${x.slug} · ${own ? 'uncommitted' : 'source diff'}`,
        subtitle: own ? 'work since its own last checkpoint — not yet committed'
          : x.is_production ? 'what is deployed vs the origin mirror'
          : 'everything this xell adds over its fork point — what would land' });
      return;
    }
    if (x.is_production) return;
    const src = x.remote_source?.ref || 'its xource';
    if (kind === 'terminal') { setTermChoice(x); return; }   // ask: in-house vs deep-linked
    // ⟳ CAGE — restart the cxell container. The SAME handler the xell card and the terminal modal
    // call (web/src/cage.js): it probes the live cage first and owns every confirm and refusal, so
    // the three surfaces cannot drift into three different policies.
    if (kind === 'cage') { restartXellCage(x, refresh); return; }
    if (kind === 'message') { setMsgXell(x); return; }       // open the long-text/file composer
    if (kind === 'directives') { setDirectivesXell(x); return; } // read the manager⇄worker conversation
    if (kind === 'env') {
      // Opens the ENVIRONMENT panel (ticket #20): which environment this xell resolved to and why,
      // its var names, and the pin/clear. The raw .zeehive.env dump this used to show is still one
      // click away inside it — but the file alone could not answer "why is it unchanged?", which is
      // the question that actually gets asked.
      setEnvXell(x);
      return;
    }
    if (kind === 'observability') {
      // THE PER-TURN LEDGER — the observability panel. Read-only: the server's turn-ledger rows
      // (zee_turn) with their play-by-play events. Opened from the flower's ◉ button and the
      // right-click context menu.
      setObsXell(x);
      return;
    }
    if (kind === 'build') {
      if (x.stack.some(isBusy)) { showAlert('A container is busy (building/restoring) — wait for it to finish.'); return; }
      buildXell(x.id, false).catch(buildErr); return;
    }
    if (kind === 'done') {
      markXellDone(x, diff, refresh, { landing: landingByXell[x.id], prs: prsFor(x), ship: shipByXell[x.id] });
      return;
    }
    // ♻ SWAP — done's cheaper neighbour: keep the xell, change who is in it. The composer collects
    // the persona (and an optional brief); the server owns every refusal, so nothing is pre-checked
    // here beyond opening the right modal.
    if (kind === 'swap') { setSwapXell({ ...x, diff }); return; }
    if (kind === 'push' || kind === 'land') {
      if (!(await showConfirm(`Land ${x.slug} → ${src}?\n\nThis runs the same gated push a zee runs. Unless a human has ALREADY `
        + `approved this exact commit, the gate HOLDS it and raises it for verification — expected, not a failure. `
        + `Your commits stay on the branch either way.`, { okLabel: 'Land' }))) return;
      pushXell(x.id).then((r) => { if (r?.landed === false) showAlert(r.reason || 'push held at the gate'); refresh(); })
        .catch((e) => showAlert('Push failed: ' + (e?.message || e), { variant: 'error' })); return;
    }
    if (kind === 'ship') {
      if (!(await showConfirm(`Ship ${x.slug} to PRODUCTION?\n\nThis files a ship request. It is REFUSED unless the work is `
        + `already landed on main; a human then approves it in the ship panel, and the queenzee deploys from main.\n\n`
        + `A ship is FLEET-WIDE: it deploys the CURRENT TIP of main — every landing on main at that moment, `
        + `not only ${x.slug}'s work. The ship card names the sha and the migrations that ride with it.`,
        { variant: 'danger', okLabel: 'Request ship' }))) return;
      const id = `ship-${x.id}-${Date.now()}`;
      pushToast({ id, kind: 'progress', title: `Requesting ship of ${x.slug}…` });
      requestShipXell(x.id, `ship ${x.slug} from the dashboard`).then((r) => {
        if (r?.ok) updateToast(id, { kind: 'success', title: 'Ship requested', onRetry: null,
          body: r?.note || 'awaiting approval in the ship panel' });
        else updateToast(id, { kind: 'error', title: 'Ship refused', body: r?.reason || 'not landed', onRetry: null });
        setTimeout(() => dismissToast(id), 7000);
        refresh();
      }).catch((e) => { updateToast(id, { kind: 'error', title: 'Ship failed', body: e?.message || String(e), onRetry: null });
        setTimeout(() => dismissToast(id), 7000); });
      return;
    }
    if (kind === 'pause') {
      // Optimistic update: set local state immediately so the flower shows play
      x.hive_status = 'occ-paused';
      x.hive_status_label = 'paused';
      x.xell_paused = true;
      setVersion((v) => v + 1);
      const id = `xpause-${x.id}-${Date.now()}`;
      pushToast({ id, kind: 'progress', title: `Pausing ${x.slug}…` });
      pauseXell(x.id).then((r) => {
        if (r?.ok) updateToast(id, { kind: 'success', title: `Paused ${x.slug}`, onRetry: null,
          body: r?.counts?.interrupted ? `${r.counts.interrupted} turn(s) interrupted` : 'marked as paused' });
        else updateToast(id, { kind: 'error', title: 'Pause not delivered', onRetry: null,
          body: r?.reason || 'server refused' });
        setTimeout(() => dismissToast(id), 6000);
        refresh();
      }).catch((e) => { updateToast(id, { kind: 'error', title: 'Pause failed', body: e?.message || String(e), onRetry: null });
        setTimeout(() => dismissToast(id), 6000); });
      return;
    }
    if (kind === 'resume') {
      // Optimistic update: set local state immediately so the flower shows pause
      x.hive_status = 'occ-working';
      x.hive_status_label = 'working';
      x.xell_paused = false;
      setVersion((v) => v + 1);
      const id = `xresume-${x.id}-${Date.now()}`;
      pushToast({ id, kind: 'progress', title: `Resuming ${x.slug}…` });
      resumeXell(x.id).then((r) => {
        if (r?.ok) updateToast(id, { kind: 'success', title: `Resumed ${x.slug}`, onRetry: null,
          body: r?.counts?.nudged ? `${r.counts.nudged} zee(s) called back` : 'marked as active' });
        else updateToast(id, { kind: 'error', title: 'Resume not delivered', onRetry: null,
          body: r?.reason || 'server refused' });
        setTimeout(() => dismissToast(id), 6000);
        refresh();
      }).catch((e) => { updateToast(id, { kind: 'error', title: 'Resume failed', body: e?.message || String(e), onRetry: null });
        setTimeout(() => dismissToast(id), 6000); });
      return;
    }
    if (kind === 'nudge') {
      const id = `nudge-${x.id}-${Date.now()}`;
      pushToast({ id, kind: 'progress', title: `Nudging ${x.slug}…`, body: 'typing “status?” into its live session' });
      nudgeXell(x.id).then((r) => {
        if (r?.nudged) updateToast(id, { kind: 'success', title: `Nudged ${x.slug}`, onRetry: null,
          body: `typed “${r.sent || 'status?'}” into its live session over SSH` });
        else updateToast(id, { kind: 'error', title: 'Nudge not delivered', onRetry: null,
          body: r?.reason || r?.error || 'no live zee to reach' });
        setTimeout(() => dismissToast(id), 6000);
      }).catch((e) => { updateToast(id, { kind: 'error', title: 'Nudge failed', body: e?.message || String(e), onRetry: null });
        setTimeout(() => dismissToast(id), 6000); });
      return;
    }
    // The context menu's HELD-GATE rows: send the literal 'zee land'/'zee ship' into the zee's live
    // session (the same operator-message door the 📨 composer uses). Only reachable from the context
    // menu, and only when the gate is holding — see xellContextMenuItems.
    if (kind === 'sendLand' || kind === 'sendShip') {
      const verb = kind === 'sendLand' ? 'land' : 'ship';
      const id = `sendverb-${x.id}-${Date.now()}`;
      pushToast({ id, kind: 'progress', title: `Sending “zee ${verb}” to ${x.slug}…`,
        body: 'typing it into its live session' });
      sendXellMessage(x.id, { text: `zee ${verb}` }).then((r) => {
        if (r?.sent) updateToast(id, { kind: 'success', title: `Sent “zee ${verb}” to ${x.slug}`, onRetry: null,
          body: 'typed into its live session over SSH' });
        else updateToast(id, { kind: 'error', title: `“zee ${verb}” not delivered`, onRetry: null,
          body: r?.reason || r?.error || 'no live zee to reach' });
        setTimeout(() => dismissToast(id), 7000);
      }).catch((e) => { updateToast(id, { kind: 'error', title: `“zee ${verb}” failed`, body: e?.message || String(e), onRetry: null });
        setTimeout(() => dismissToast(id), 7000); });
      return;
    }
    if (kind === 'pull') {
      const dirty = diff?.dirty || 0;
      if (!(await showConfirm(`Pull ${src} into ${x.slug}?\n\nMerges ${src} into ${x.slug}'s working tree on disk`
        + `${x.zee_status === 'working' ? ' — its zee is still working in there' : ''}.`
        + (dirty > 0 ? `\n\n⚠ ${dirty} uncommitted file(s): this will be REFUSED (commit or stash first).` : ''),
        { okLabel: 'Pull' }))) return;
      pullXell(x.id).then((r) => { if (r?.merged === false) showAlert(r.reason || 'pull refused'); refresh(); })
        .catch((e) => showAlert('Pull failed: ' + (e?.message || e), { variant: 'error' })); return;
    }
    if (kind === 'pr') {
      if (!(await showConfirm(`Raise a PR from ${x.slug} → ${src}?\n\nNothing moves now: it appears on ${src}'s card, and a `
        + `human accepts it there.`, { okLabel: 'Raise PR' }))) return;
      prXell(x.id).then(refresh).catch((e) => showAlert('PR failed: ' + (e?.message || e), { variant: 'error' })); return;
    }
  };

  // Three panes: the honeycomb, the git graph as the exact centre divider, and the control panels.
  // Landscape → three columns, portrait → three rows; the graph stays centred while flip swaps which
  // side is honeycomb vs panels. Connector wires bridge each xell's commit dot (graph) to its hex.
  return (
    <div className={`hive-split o-${orientation} honey-${honeySide}`} ref={layoutRef}>
      <section className="hive-pane honey" style={split != null ? { flex: `${split} 1 0` } : undefined}>
        {/* the LEVEL breadcrumb: where in the work-node tree this honeycomb is, and the way back up.
            Every new prompt is cut under the level you are standing on (parent_work_item). */}
        <div className="hive-crumbs">
          <button className={`hive-crumb${hiveMode === 'projects' ? ' on' : ''}`}
                  onClick={() => { setHiveMode('projects'); setExpandedId(null); }}>⬢ projects</button>
          {hiveMode === 'nodes' && (
            <>
              <span className="hive-crumb-sep">›</span>
              <button className={`hive-crumb${!nodePath.length ? ' on' : ''}`}
                      onClick={() => { setNodePath([]); setExpandedId(null); }}>{project.name || '…'}</button>
              {nodePath.map((n, i) => (
                <React.Fragment key={n.id}>
                  <span className="hive-crumb-sep">›</span>
                  <button className={`hive-crumb${i === nodePath.length - 1 ? ' on' : ''}`}
                          onClick={() => { setNodePath(nodePath.slice(0, i + 1)); setExpandedId(null); }}>
                    {n.title}</button>
                </React.Fragment>
              ))}
            </>
          )}
        </div>
        <HiveCanvas xells={hiveCells} diffs={diffs} timeline={timeline} orientation={orientation} honeySide={honeySide}
                    machines={fleet.machines} onOpenSession={openSession} onAction={handleFlowerAction}
                    onContainerMenu={openMenu}
                    expandedId={expandedId} onExpand={setExpandedId}
                    hexPosRef={hexPosRef} harnessPosRef={harnessPosRef} onGeometry={fireGeom}
                    hoverRef={hoverRef} setHover={setHover} subscribeHover={subscribeHover}
                    showHarness={showHarness} redrawKey={version}
                    queenzeeActivity={qzActivity}
                    shipping={fleet.shipping || []}
                    onOpenProject={openProjectLevel} onOpenNode={openNodeLevel} onNodeAssign={assignNodeZee}
                    onPlusAction={handlePlusAction}
                    onQueenzeeTerminal={openQueenzeeTerminal}
                    qzTerminalStatus={qzTerminal.status}
                    onQueenzeeLogs={() => setShowTerm(true)} />
        {/* The per-xell actions (build/pull/push/PR/terminal/mark-done) are drawn ON the flower now
            and hit-tested there — no DOM toolbar. The cxell-zee terminal is the one piece that needs
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
        {/* xellId lights the terminal's 💬 talk composer — the door that reaches this zee even while
            it is mid-turn (the pane is a read-only feed then, so typing reaches nobody). */}
        {termXell && (
          <ZeeTerminal zeeId={termXell.zee_id} slug={termXell.slug} viewerUrl={termXell.viewer_url}
                       xellId={termXell.id}
                       onClose={() => setTermXell(null)} />
        )}
        {envXell && (
          <XellEnvironment xell={envXell} onClose={() => setEnvXell(null)} onChanged={refresh} />
        )}
        {directivesXell && (
          <Directives xell={directivesXell} onClose={() => setDirectivesXell(null)} />
        )}
        {obsXell && (
          <XellObservability xell={obsXell} onClose={() => setObsXell(null)} />
        )}
        {msgXell && (
          <MessageComposer xell={msgXell} initialText={msgXell.initialText || ''} onClose={() => setMsgXell(null)}
                           onSent={(r) => { const id = `msg-${msgXell.id}-${Date.now()}`;
                             // WHICH delivery — the server decided it from the zee's state
                             // (lib/zee-turn.js), and the three do not promise the same thing:
                             // only 'typed' means it is reading this in the session you can watch.
                             const said = r?.delivery === 'resumed'
                               ? 'its turn had ended — the queenzee RESUMED its session with your message as the prompt'
                               : r?.delivery === 'queued'
                                 ? 'it is MID-TURN — QUEUED in its cxell, typed in the moment the turn ends'
                                 : 'typed into its live session';
                             pushToast({ id, kind: 'success', title: `Message sent to ${msgXell.slug}`, onRetry: null,
                               body: r?.attachments?.length ? `${said} · ${r.attachments.length} attachment(s) in its .zee-inbox` : said });
                             setTimeout(() => dismissToast(id), 6000); }} />
        )}
        {/* ♻ SWAP THE ZEE — the console half of `zee swap`. FIRE-AND-FORGET, like the dispatch
            composer: the swap collects the outgoing cage's commits, recreates the cage and spawns a
            zee, which takes seconds, so the modal closes at once and a toast carries the outcome.
            A REFUSAL is the server's own sentence, verbatim — "swap refused" with no reason would
            send a human hunting for a rule (an open landing card, a persona of the wrong type) that
            the answer already named. */}
        {swapXell && (
          <SwapZee xell={swapXell} projectId={projectId} diff={swapXell.diff || null}
                   onClose={() => setSwapXell(null)}
                   onSwap={(payload) => {
                     const x = swapXell;
                     setSwapXell(null);
                     const id = `swap-${x.id}-${Date.now()}`;
                     pushToast({ id, kind: 'progress', title: `Swapping the zee in ${x.slug}…`,
                       body: `collecting its commits, then caging a ${payload.harness} zee on the same branch` });
                     swapXellZee(x.id, payload).then((r) => {
                       updateToast(id, { kind: 'success', onRetry: null,
                         title: `${x.slug} now wears ${r?.harness?.key || payload.harness}`,
                         body: r?.message || 'the incoming zee was briefed that it inherited this xell' });
                       setTimeout(() => dismissToast(id), 9000);
                       refresh();
                     }).catch((e) => {
                       updateToast(id, { kind: 'error', title: `Swap refused · ${x.slug}`,
                         body: e?.message || String(e), onRetry: null });
                       setTimeout(() => dismissToast(id), 14000);
                       refresh();
                     });
                   }} />
        )}
      </section>

      {/* `xells` rides along to BOTH the graph and the wires so the manager↔crew relation is drawn
          from the same fleet list the honeycomb uses (hive/crew.js) — three views, one grouping. */}
      <GraphPane timeline={timeline} xells={xells} orientation={orientation} honeySide={honeySide}
                 hexPosRef={hexPosRef} prodIds={prodIds} expandedId={expandedId} subscribeGeom={subscribeGeom}
                 hoverRef={hoverRef} setHover={setHover} subscribeHover={subscribeHover}
                 showHarness={showHarness} onToggleHarness={() => setShowHarness((s) => !s)}
                 onFlip={() => setHoneySide((s) => (s === 'a' ? 'b' : 'a'))}
                 onReposition={(e) => beginPaneReposition(e, { layoutRef, orientation, honeySide, setSplit })}
                 xource={fleet.xource || null}
                 projectId={projectId || project?.id || null}
                 onXourceChanged={refresh} />

      <Connectors timeline={timeline} xells={xells} layoutRef={layoutRef} version={version}
                  hexPosRef={hexPosRef} harnessPosRef={harnessPosRef} orientation={orientation} honeySide={honeySide}
                  expandedId={expandedId} prodIds={prodIds} subscribeGeom={subscribeGeom}
                  hoverRef={hoverRef} subscribeHover={subscribeHover} showHarness={showHarness} />

      <section className="hive-pane panels" style={split != null ? { flex: `${1 - split} 1 0` } : undefined}>
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
          {/* GitHub remote: push / PR buttons — only surface when the token allows outbound. */}
          {(fleet?.project?.remote_url) && (
            <span className="gh-btns" title={`GitHub: ${fleet?.project?.remote_url}`}>
              <a className="gh-link" href={fleet?.project?.remote_url} target="_blank" rel="noreferrer"
                 title="Open the GitHub remote in your browser">⑂</a>
              <button className={`gh-btn ${githubOut?.kind === 'pull' && githubOut?.busy ? 'busy' : ''}`}
                      disabled={githubOut?.busy}
                      onClick={doGitHubPull}
                      title="Fetch + fast-forward from the GitHub remote">↓ Pull</button>
              <button className={`gh-btn ${githubOut?.kind === 'commit' && githubOut?.busy ? 'busy' : ''}`}
                      disabled={githubOut?.busy}
                      onClick={doGitHubCommit}
                      title="Commit the xource's dirty work (staged + unstaged tracked changes) on main — then ↑ Push or ⇅ PR">⚑ Commit</button>
              {githubAccessState?.can_push && (
                <button className={`gh-btn ${githubOut?.kind === 'push' && githubOut?.busy ? 'busy' : ''}`}
                        disabled={githubOut?.busy}
                        onClick={doGitHubPush}
                        title={githubAccessState?.push_rule_block
                          ? `⚠ ${githubAccessState.push_rule_block}`
                          : 'Push local main to the GitHub remote (fast-forward only)'}>
                  {githubAccessState?.push_rule_block ? '↑ Push ⚠' : '↑ Push'}</button>
              )}
              {githubAccessState?.can_pr && (
                <button className={`gh-btn ${githubOut?.kind === 'pr' && githubOut?.busy ? 'busy' : ''}`}
                        disabled={githubOut?.busy}
                        onClick={() => doGitHubPR(false)}
                        title="Push a side branch and open a pull request on GitHub">⇅ PR</button>
              )}
              {githubAccessState?.can_pr && (
                <button className={`gh-btn ${githubOut?.kind === 'pr' && githubOut?.busy ? 'busy' : ''}`}
                        disabled={githubOut?.busy}
                        onClick={() => doGitHubPR(true)}
                        title="Open a PR AND merge it into the default branch on GitHub">⇅ PR ⟳</button>
              )}
              {githubOut && !githubOut.busy && (
                <a className={`gh-out${!githubOut.pushed && !githubOut.opened && !githubOut.pulled && githubOut.kind !== 'commit' ? ' bad' : ''}`}
                   href={githubOut?.url || null} target="_blank" rel="noreferrer"
                   title={githubOut?.pushed ? 'Pushed successfully'
                     : githubOut?.opened ? (githubOut?.merge?.merged ? 'PR opened & merged' : 'PR opened')
                     : githubOut?.pulled ? (githubOut?.state === 'up-to-date' ? 'Remote already up to date' : 'Pulled from remote')
                     : githubOut?.kind === 'commit' ? (githubOut?.ok ? `Committed ${githubOut?.short || ''} on main — now ↑ Push or ⇅ PR` : (githubOut?.reason || 'commit failed'))
                     : githubOut?.reason || 'result'}>
                  {githubOut?.pushed || githubOut?.pulled ? '✓'
                    : githubOut?.opened ? `#${githubOut?.number || '✓'}`
                    : githubOut?.kind === 'commit' ? (githubOut?.ok ? '✓' : '✗')
                    : '✗'}
                </a>
              )}
            </span>
          )}
          {/* the flip button now lives IN the middle graph pane, opposite the ⎇ branch label */}
          {/* No runtime toggle here: WHICH AI answers a prompt is decided in the composer
              (or by the router on a router-gated fleet), opened from the single "+ prompt" button. */}
          {/* The phone-first mobile chat UI (/m) — a same-tab switch, preserving the project. */}
          <a className="cs-mobile" href={`./m?project=${encodeURIComponent(project.name)}`}
             title="Open the phone-first mobile chat UI">📱 Mobile</a>
          {/* Console settings (browser-local): terminal engine xterm↔wterm, etc. Not project setup. */}
          <button type="button" className="cs-gear" data-testid="console-settings-btn"
                  title="Console settings — terminal engine and other browser-local preferences"
                  onClick={() => setShowConsoleSettings(true)}>⚙</button>
          <span className={`conn ${conn}`}>{conn === 'live' ? '● live' : '○ ' + conn}</span>
        </div>
      </header>
      {showConsoleSettings && <ConsoleSettings onClose={() => setShowConsoleSettings(false)} />}

      <div className="statusline" data-testid="statusline">
        {/* FIRST in the line, before anything that starts work: the one control that stops all of it.
            Its own state is also the answer to "why is nothing happening?", which is the question the
            rest of this line cannot answer while the fleet is paused.
            With a project selected, this operates on the PROJECT (project_pause), not the whole fleet. */}
        <FleetPause pause={fleet.project_pause || fleet.pause}
                    projectId={projectId || project.id} onChanged={refresh}
                    pushToast={pushToast} dismissToast={dismissToast} />
        <span className="k">Status:</span>{' '}
        <b>{status.inUse}</b> of <b>{status.total}</b> xells in use
        <span className="sub"> ({status.working} active · {status.ready} ready)</span>
        {/* FLEET-CUMULATIVE BURN — spend only (tokens + $). Remaining provider quotas are the
            SEPARATE "limits" chip below — deliberately not mixed, so the two questions stay clear. */}
        {fleet.fleet_burn?.fleet && (fleet.fleet_burn.fleet.tokens > 0 || fleet.fleet_burn.fleet.cost > 0
            || (fleet.fleet_burn.by_provider || []).length > 0) && (
          <span className="fleetburn" data-testid="fleet-burn"
                title={fleetBurnTitle(fleet.fleet_burn)}>
            {' · '}fleet burn: <b>{fmtTok(fleet.fleet_burn.fleet.tokens)} tok · {fmtUsd(fleet.fleet_burn.fleet.cost)}</b>
            {(fleet.fleet_burn.by_provider || []).length > 0 && (
              <span className="fleetburn-by-provider" data-testid="fleet-burn-by-provider">
                {(fleet.fleet_burn.by_provider || []).map((p) => (
                  <span key={p.provider} className="fleetburn-prov" data-provider={p.provider}
                        title={providerBurnTitle(p)}>
                    {' · '}<span className="fleetburn-prov-name">{p.provider}</span>
                    {' '}<b>{fmtTok(p.tokens)}/{fmtUsd(p.cost)}</b>
                  </span>
                ))}
              </span>
            )}
          </span>
        )}

        {/* The prewarmed-pool knob, right here in the status line so it never hides in project
            settings. Per-machine pool sizes (matrix column headers) replace this project-wide
            target ONLY when a machine is explicitly configured for the project — EITHER knob
            (dev_priority>0 or pool_size>0); a process-runner project needs the QUEENZEE-HOST
            machine configured, since only that row governs it (queenzee/pool.js). With NO
            per-machine config this knob still governs — machine-aware by DEFAULT means the
            pool spends this target on the project's default machine
            (docs/default-machine-pooling-decision-record.md) — so it stays visible. Mirrors
            the server's own reconcileProject branch. */}
        {!(fleet.machines || []).some((m) => m.enabled && (m.dev_priority > 0 || m.pool_size > 0)
            && ((project.manifest?.roles?.server?.runner || project.manifest?.tiers?.spinoff?.runner) !== 'process'
                || m.is_queenzee_host))
          && <PoolTarget pool={fleet.pool} projectId={projectId || project.id} />}
        <AutoApprove project={project} projectId={projectId || project.id} onChanged={refresh} />
        {/* ONE "+ prompt" BUTTON — opens the composer with no pinned harness. The router layer
            (Dispatch.jsx → routerGate) recomposes the prompt and decides provider/model/mode/
            harness itself on a router-gated fleet; on a fleet with no router feature the human
            picks the persona inside the composer. Persona-level policy is enforced there (and in
            Custom deployment), not by a row of per-persona toolbar buttons.

            Visibility is still the token store: no dispatchable ACCOUNT at all → the one honest
            button is "add provider", straight into Project setup. Every account paused → this
            button stays, disabled, carrying the reason — a control that vanishes reads as
            "it disappeared". */}
        {(() => {
          if (!hasAnyAccount(providers)) {
            return (
              <button className="new-prompt-btn" data-testid="add-provider-btn"
                      title="No AI provider connected — add a Claude, Codex, or Kimi token to dispatch zees"
                      onClick={() => { setSetupCreate(false); setNestedProject(null); setShowSetup(true); }}>＋ add provider</button>
            );
          }
          // Whether the single button can be pressed is a pure decision — promptButton() —
          // so it is testable in plain node and every surface that offers "start a zee" agrees.
          const btn = promptButton(providers);
          const why = btn.blocked
            ? btn.blocked
            : 'Compose a prompt and dispatch a zee into a ready xell'
              + (btn.runsOn.length ? `\nruns on: ${btn.runsOn.map((p) => p.label || p.provider).join(', ')}` : '');
          return (
            <button className="new-prompt-btn" data-testid="new-prompt-btn"
                    disabled={!!btn.blocked} title={why}
                    onClick={() => setShowDispatch({})}>
              ＋ prompt
            </button>
          );
        })()}
        {/* ADD A MANAGER ZEE — unlimited, and only from here: a manager coordinates workers, holds
            production READ-ONLY and cannot push to the xource, and `zee dispatch` refuses the role
            so managers can never mint managers. Sits beside the prompt button because it is the
            same act one level up: starting an agent. */}
        {/* It opens the SAME composer the "+ prompt" button does (Dispatch, manager variant) — a
            manager's programme is a prompt, and it used to get a one-line input box. The PERSONA is
            chosen inside it (one manager button for the fleet), and the provider/account/model
            choices follow from that persona's model policy exactly as they do for a worker — the
            composer reads them itself. */}
        <AddManagerButton projectId={projectId || project.id} projectName={project.name}
                          onAdded={refresh} />
        {/* THE WORK TRACKER — tickets in, a plan on a board, a timeline over it. It sits with the
            prompt button because it is the other half of the same question: the prompt button
            starts work, this is where the work being done is decided and tracked. It opens as a
            portalled overlay (no router in this console), so nothing else on this page moves. */}
        <button className="work-btn-open" data-testid="work-btn" title="Open the work tracker — tickets, board, timeline"
                onClick={() => setShowWork(true)}>▦ work</button>
        {/* DELIVERY TELEMETRY — the same altitude as the work tracker, and the other half of the
            same question: the tracker says what work exists, this says how that work is actually
            going (cycle time, rework, what dies, what a landing costs, how long a human takes).
            Read-only, portalled like every other heavyweight surface. */}
        <button className="dt-btn-open" data-testid="delivery-btn"
                title="Open delivery telemetry — cycle time, turn deaths, cost per landing, rework, gate waits"
                onClick={() => setShowDelivery(true)}>◷ delivery</button>
        {showDelivery && (
          <DeliveryTelemetry projectId={projectId || project.id} projectName={project.name}
                             onClose={() => setShowDelivery(false)} />
        )}
        <button className="term-btn" data-testid="term-btn" title="Open queenzee terminal"
                onClick={() => setShowTerm(true)}>▚_</button>
      </div>

      {/* THE BAR — the one thing on the page that can't wait for you to scroll: a zee blocked on a
          human. A pointer, not a copy; clicking a chip expands that xell's flower + action drawer. */}
      <NeedsYouBar xells={xells} links={crewOfFleet} landingByXell={landingByXell} prsFor={prsFor} onJump={setExpandedId}
                   prodBindByXell={prodBindByXell} seedByXell={seedByXell}
                   doneSuggestByXell={doneSuggestByXell}
                   expandedId={expandedId} onDecided={refresh} onDismiss={dismiss} visible={visible} />

      <LandingPanel landing={orphanLandings} onDecided={refresh} orphanQueues={orphanQueues} />

      {/* PRODUCTION DATA — a zee asking for the live prod database, or for a landed seed file to be
          run on it, plus the receipt of every seed that ran. Live asks render on their xell's chip
          above; this carries the ones with no chip (reaped xell) and the finished receipts. */}
      <ProdAsksPanel bind={(fleet.prod_bind || []).filter((r) => !carded.has(r.xell_id))}
                     seeds={(fleet.prod_seed || []).filter((r) => !carded.has(r.xell_id)
                       || ['seeded', 'failed'].includes(r.status))}
                     onDecided={refresh} />

      {/* VISUAL VERIFICATION — a zee built its webapp and OFFERED the live link to a human in the
          console (a human turned it on at dispatch time). Not a gate: there is nothing to approve,
          only a link to open (or a card to dismiss). The small panel carries every open offer. */}
      <VisualVerifyPanel offers={fleet.visual_verify_offers} onDone={refresh} />

      {/* XOURCE CLEAN-UP — a manager asked for the main checkout to be reset because a mangled
          tree is wedging every landing and ship. A decision (approve → the queenzee cleans) or a
          recent receipt, exactly like the prod-data asks. */}
      <XourceCleanPanel requests={fleet.xource_clean} onDone={refresh} />

      {/* MANAGER MINT — a ROUTER asked for another MANAGER zee (149). The router sees a raw prompt
          before anyone has sized it, so it is the zee that spots a PROGRAMME rather than a task; it
          may ask, and only a human may say yes. Approve → the queenzee adds the manager itself. */}
      <ManagerMintPanel requests={fleet.manager_mint} onDone={refresh} />

      {/* CREDENTIAL INJECTION — the queenzee raised a request (a human rotated an account; a zee
          died on a 401) and a human decides here. Approve → the queenzee injects the current key
          into the named live cages and re-runs the adapter's auth setup. A decision or a recent
          receipt, exactly like xource-clean and the prod-data asks. */}
      <CredentialInjectPanel requests={fleet.credential_inject} onDone={refresh} />

      {/* Production: ship approvals + the prod lock's countdown. Same altitude as landings —
          both are decisions only a human may make, and both block a zee until made. */}
      <ShipPanel shipping={fleet.shipping} prodLock={fleet.prod_lock} shipLogs={shipLogs}
                 refused={fleet.ship_refused} projectId={projectId || project.id} onDecided={refresh}
                 onForwardToZee={(xell, text) => setMsgXell({ ...xell, initialText: text })} />

      {/* THE LANDING PAD — every landing + shipment in one chronological FIFO queue, with the item
          the queenzee is processing right now spinning. A view of the runway, not a decision. */}
      <LandingPad pad={fleet.landing_pad} />

      <BackupsPanel backup={fleet.backup} projectId={projectId || project.id} />

      {/* The inventory as a role × machine MATRIX: one column per machine, so what-runs-where is
          the panel's shape. Chips sit where they RUN; the ⇄ marker says where they compile. */}
      <MachineMatrix machines={fleet.machines} containers={containers}
                     projectId={projectId || project.id}
                     spinoffIsProcess={(project.manifest?.roles?.server?.runner
                       || project.manifest?.tiers?.spinoff?.runner) === 'process'}
                     onMenu={openMenu} onChanged={refresh} />

      {/* The decision UI (held landing / open PR, with Approve/Reject) now renders INLINE under the
          "waiting on you" bar when its chip is clicked — next to nothing else, and the flower on the
          canvas highlights the same xell. No whole-xell drawer at the bottom of the page anymore. */}
      </div>
      </section>
      {showTerm && <Terminal logs={logs} onClose={() => setShowTerm(false)} />}
      {showDispatch && (
        <Dispatch projectId={projectId || project.id} projectName={project.name}
                  onClose={() => setShowDispatch(false)}
                  onDispatch={(payload) => {
                    setShowDispatch(false);
                    // the prompt is cut under the honeycomb level it was written from: the new
                    // work_node becomes a child of the opened node (server default: project root)
                    runDispatch({ ...payload,
                      ...(hiveMode === 'nodes' && nodePath.length
                        ? { parent_work_item: nodePath[nodePath.length - 1].id } : {}) });
                  }} />
      )}
      {/* the + hexagon's MANAGER option — the SAME Dispatch composer, manager variant, that
          AddManagerButton opens; a second door to the same mint. */}
      {showManagerMint && (
        <Dispatch manager projectId={projectId || project.id} projectName={project.name}
                  onClose={() => setShowManagerMint(false)}
                  onDispatch={async (payload) => {
                    setShowManagerMint(false);
                    try {
                      await addManagerZee(payload);
                      refresh();
                      const id = `mgr-${Date.now()}`;
                      pushToast({ id, kind: 'success', title: 'Manager zee added', onRetry: null,
                        body: 'A manager was minted — it will study the project and propose a programme.' });
                      setTimeout(() => dismissToast(id), 6000);
                    } catch (e) { showAlert(e?.message || String(e), { variant: 'error' }); }
                  }} />
      )}
      {/* the + hexagon's PROJECT option: a plain new project at top level; a NESTED project (folder
          confined to the parent's repo_root, git behavior forced) inside a project. `project={null}`
          (setupCreate) puts ProjectSetup in CREATE mode; the nested context rides `nested` so the
          CreateForm can confine and force. The "+ add provider" button keeps setupCreate=false → the
          legacy edit-the-selected-project behaviour. */}
      {showSetup && (
        <ProjectSetup project={setupCreate ? null : project} nested={nestedProject}
                      onClose={() => { setShowSetup(false); setNestedProject(null); setSetupCreate(false); }}
                      onChanged={refresh} onSelect={(id) => selectProject(id)} />
      )}
      {/* the WORK TRACKER, opened from the toolbar OR the + hexagon's TICKET option. The + menu
          forces the Tickets tab (workInitialTab); the toolbar keeps the last-used tab. */}
      {showWork && (
        <WorkConsole projectId={projectId || project.id} projectName={project.name}
                     initialTab={workInitialTab}
                     onClose={() => { setShowWork(false); setWorkInitialTab(null); }} />
      )}
      <Toasts toasts={toasts} onDismiss={dismissToast} />
      <ContainerMenu menu={menu} onClose={() => setMenu(null)}
                     projectName={project.name} onDecommissioned={refresh}
                     onLoadBackup={(c) => setLoadBackupFor(c)}
                     onBackup={runBackupNow}
                     onShell={(c) => setShellFor(c)} />
      {/* docker-exec shell into a container, opened from its chip's context menu */}
      {shellFor && <ContainerTerminal c={shellFor} onClose={() => setShellFor(null)} />}
      {/* Backup selector opened from a db container's "Load backup…" menu item — the same all-backups
          modal the panel uses, but pre-aimed at the container the menu was on so the picked backup
          restores straight into it. */}
      {loadBackupFor && (
        <BackupsModal projectId={projectId || project.id} initialTargetId={loadBackupFor.id}
                      onClose={() => setLoadBackupFor(null)} />
      )}
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

// Operator policy: auto-approve landings, ships, seeds and auto-DONE. Independent switches —
// landing→main is far lower stakes than shipping→prod or seeding→prod, so they toggle separately.
// Enabling ships/seeds/done asks first (ships and seeds put data/code LIVE, done tears xells down,
// all with no human review). Reads the flags off the project row in the fleet snapshot.
function AutoApprove({ project, projectId, onChanged }) {
  const [busy, setBusy] = useState(false);
  const set = async (field, checked) => {
    if (checked) {
      if (field === 'auto_approve_ship'
        && !(await showConfirm('Auto-approve PRODUCTION ships?\n\nEvery ship request will deploy to prod immediately with NO human review. The queenzee still only builds landed work from main, but nobody signs off per ship.',
          { variant: 'danger', okLabel: 'Enable auto-approve' }))) return;
      if (field === 'auto_approve_seed'
        && !(await showConfirm('Auto-approve PRODUCTION seeds?\n\nEvery seed request will run its SQL against the live production database immediately with NO human reading it. The queenzee still only runs files already on main from server/sql/seeds/, but nobody reviews per seed.',
          { variant: 'danger', okLabel: 'Enable auto-seed' }))) return;
      if (field === 'auto_done'
        && !(await showConfirm('Auto-done xells?\n\nA DONE SUGGESTION from a MANAGER zee will be confirmed immediately with NO human review — marking the task done and tearing that xell down. A worker\'s own `zee done` still needs a human. The reap\'s own guards (e.g. an actively-working xell) still apply.',
          { variant: 'danger', okLabel: 'Enable auto-done' }))) return;
    }
    setBusy(true);
    try { await updateProject(projectId, { [field]: checked }); onChanged?.(); }
    catch (e) { showAlert('Auto-approve change failed: ' + e.message, { variant: 'error' }); }
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
      <Switch field="auto_approve_seed" label="seeds" danger
              title="Automatically approve every production seed — SQL runs on the LIVE database with no human reading it (still only files already on main, from server/sql/seeds/)." />
      <Switch field="auto_done" label="done" danger
              title="Automatically confirm a MANAGER's done suggestion — the xell is marked done and torn down with no human review (a worker's own `zee done` still needs a human)." />
    </span>
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
  const ok = await showConfirm(
    `${x.task_id ? 'Mark done' : 'Decommission'} "${x.slug}"?` +
    (active ? `\n\nIts zee is still ${x.zee_status}${x.cli_active ? ' (really active)' : ''} — this kills the agent mid-task.\n` : '') +
    inUseText +
    atStake +
    `\nThis removes its worktree, branch, and per-xell containers, and decommissions its zee` +
    `${x.holds_prod_lock ? ' (it currently HOLDS the prod lock)' : ''}.\nThis cannot be undone.`,
    { variant: 'danger', okLabel: x.task_id ? 'Mark done' : 'Decommission' });
  if (!ok) return;
  // The hard gate — a typed-name confirmation — fires whenever something real is at stake:
  //   • a LIVE zee is in there (active): a claimed xell with a running agent must never go on a
  //     single click — that exact accident (a live claimed xell reaped) is why this gate exists;
  //   • unlanded work that would be LOST;
  //   • a pending decision (landing/PR/ship) that would be CANCELLED.
  // A clean, idle/pooled xell with none of these still costs only the single confirm above.
  if (unlanded || inUse || active) {
    const typed = await showPrompt(
      `"${x.slug}" is not safe to remove without confirmation:\n` +
      (active ? `  • its zee is still ${x.zee_status}${x.cli_active ? ' (really active)' : ''} — this kills it mid-task\n` : '') +
      (diff?.ahead > 0 ? `  • ${diff.ahead} commit(s) not landed\n` : '') +
      (diff?.dirty > 0 ? `  • ${diff.dirty} uncommitted file(s)\n` : '') +
      (heldLanding ? `  • ${heldLanding} landing held for approval\n` : '') +
      (openPr ? `  • ${openPr} open PR\n` : '') +
      (pendingShip ? `  • a production ship is ${pendingShip}\n` : '') +
      `\nProceeding is irreversible. To confirm, type: done`,
      { variant: 'danger', placeholder: 'type: done', okLabel: 'Confirm', title: 'Type to confirm' });
    if ((typed || '').trim().toLowerCase() !== 'done') { if (typed !== null) showAlert('Not confirmed — type "done" to proceed. Nothing was touched.'); return; }
  }
  try {
    const r = x.task_id ? await markDone(x.task_id, 'mark', active) : await reapXell(x.id, 'human-cleanup', active);
    // The xell is retired either way, but don't let a half-teardown pass as clean: if the folder
    // survived (something still holds it open — usually the zee's own session), say so.
    const orphan = r?.orphaned_worktree || r?.reap?.orphaned_worktree;
    if (orphan) {
      showAlert(`"${x.slug}" was retired, but its worktree could NOT be removed:\n\n${orphan}\n\n` +
            `Something still has it open — usually that zee's session in Claude Code. ` +
            `Close the session, then run Clean up again.`, { variant: 'error' });
    }
    onDone();
  } catch (err) { showAlert('Cleanup failed: ' + (err?.message || err), { variant: 'error' }); }
}

// XellCard — the old whole-xell DOM card — was DELETED (TKT-29-3AB6). It was the
// fleet's pre-canvas view: 330 lines of complete-looking UI that nothing rendered, tree-shaken out
// of the production bundle, still collecting tickets (the crew cue #28) aimed at a surface a human
// never met. The flower (HiveCanvas) is the fleet view now. A DOM alternative for accessibility is
// ticket #41, and it will be DESIGNED there rather than this code resurrected. The helpers that
// existed only to serve the card (BuildAllButton, DeviceSlot, shipState, XourceActions, SourceRow,
// Row, shortSid, base, and the dead api.js wrappers that only it called — attachXellDevice,
// detachXellDevice, revealWorktree) went with it; the shared ones it also touched (crewLinks,
// CrewChip, the harness-health words, markXellDone, ZeeTerminal, PrCard, LandCard…) are still used
// by the honeycomb, the wires, the graph and the waiting-on-you bar.
// One line at the top of the page naming every xell that is waiting on a human. Clicking a chip
// EXPANDS that xell's flower (highlighting it on the canvas) AND drops its decision card(s) — the
// held landing / open PR, with the Approve/Reject buttons — inline right below the bar, so the
// judgement is made next to its own commits without hunting for a card at the bottom of the page.
function NeedsYouBar({ xells, links, landingByXell, prsFor, onJump, expandedId, onDecided, onDismiss, visible,
                       prodBindByXell = {}, seedByXell = {}, doneSuggestByXell = {} }) {
  const waiting = xells.map((x) => {
    const held = (landingByXell[x.id] || []).filter((r) => r.status === 'pending').length;
    const prs = (prsFor(x) || []).filter((r) => r.status === 'pending').length;
    // A zee's TEND ping: it asked for a human in the console. No approve/reject — the chip just
    // takes you to it; the zee (or you) clears the tend once handled.
    //
    // Read from x.tend, NOT from hive_status. The hexagon pill can only show ONE word, so any newer
    // signal that outranks tend there (the env alert, #44) would have silently emptied this line of
    // a tend that is still open — the bar and the pill answer different questions, and the bar's is
    // "everything waiting on you", not "the single most urgent thing".
    const tend = x.tend?.open ? 1 : 0;
    // ENV RECONCILE FAILED on a LIVE xell (#44): the queenzee refused to write this xell's
    // .zeehive.env and the zee kept running on the old one. Nobody in the xell raised it and nobody
    // in the xell can clear it, so if it is not on this line it is on no line at all — which is the
    // entire bug: the only previous signal was one line in a boot digest.
    const envAlert = x.env_alert?.open ? 1 : 0;
    const envWhy = envAlert ? (x.env_alert?.reason || null) : null;
    const envFull = envAlert ? (x.env_alert?.full || x.env_alert?.reason || null) : null;
    // …and WHY: the brief reason the zee gave when it raised the tend (fleet: x.tend.reason). The
    // whole point of being called is knowing what you were called for — without it this line could
    // only say "somebody wants you", and the human had to open the session to find out what for.
    const tendWhy = tend ? (x.tend?.reason || null) : null;
    // …and the WHOLE thing, when the brief line is only its head. The chip stays one line (it has
    // no room), but the opened ask must be readable in full: a tend clipped to "…re-tasking a
    // manager wi…" with the rest nowhere is barely better than no reason at all.
    const tendFull = tend ? (x.tend?.full || x.tend?.reason || null) : null;
    // PROD DATA: "bind me to the production database" / "run this landed seed file on production".
    // These are held gates exactly like a landing — the zee cannot proceed until a human answers —
    // so they belong in the one line that says who is waiting on you.
    const bind = (prodBindByXell[x.id] || []).filter((r) => r.status === 'pending').length;
    const seed = (seedByXell[x.id] || []).filter((r) => r.status === 'pending').length;
    // A manager suggested this xell is done. It is a real decision waiting on a human — and the only
    // one raised by another AGENT, so if it were not counted here nobody would ever answer it.
    const doneSug = (doneSuggestByXell[x.id] || []).filter((r) => r.status === 'pending').length;
    // A landing that HOLDS THE RUNWAY with zees queued behind it, after a human already approved it and
    // nothing landed (#11 gap 2). It is not "awaiting approval", so nothing counted it — and if it was
    // also dismissed it was on no screen at all, while the queue behind it waited on a card that had
    // been hidden. It is the one approved landing that genuinely waits on a human: decide it, or let
    // the zee withdraw it. Pending occupants are already counted as `held`.
    const blocking = (landingByXell[x.id] || []).filter((r) => r.status === 'approved' && holdsRunway(r));
    const blocked = blocking.length;
    const blockedBy = blocking[0]?.holders || 0;
    return { x, held, prs, tend, tendWhy, tendFull, envAlert, envWhy, envFull,
      bind, seed, doneSug, blocked, blockedBy,
      // envAlert is APPENDED rather than slotted in beside tend: test/prod-asks-console.test.mjs
      // pins the head of this sum literally (`n: held + prs + tend + bind + seed`) to prove a
      // prod-only ask still reaches this line, and a new term in the middle breaks that reading
      // without breaking anything real. Order in a sum is arbitrary; that assertion is not.
      n: held + prs + tend + bind + seed + doneSug + blocked + envAlert };
  }).filter((w) => w.n > 0);
  if (!waiting.length) return null;

  const go = (id) => onJump?.(id === expandedId ? null : id);  // click the open one again to collapse
  const open = waiting.find((w) => w.x.id === expandedId);
  // pending decisions, PLUS an approved landing that is wedging the runway — that one is a decision
  // again (see `blocked` above), and holdsRunway is why it survives `visible` even when dismissed.
  const landings = open
    ? visible(landingByXell[open.x.id]).filter((r) => r.status === 'pending' || holdsRunway(r)) : [];
  const prs = open ? visible(prsFor(open.x)).filter((r) => r.status === 'pending') : [];
  const binds = open ? (prodBindByXell[open.x.id] || []).filter((r) => r.status === 'pending') : [];
  const seeds = open ? (seedByXell[open.x.id] || []).filter((r) => r.status === 'pending') : [];
  const doneSugs = open ? (doneSuggestByXell[open.x.id] || []).filter((r) => r.status === 'pending') : [];

  return (
    <section className="needsyou">
      <div className="ny-row">
        <span className="ny-t">⚠ waiting on you:</span>
        {waiting.map((w) => (
          <button key={w.x.id} className={`ny-chip ${w.x.id === expandedId ? 'active' : ''}`} onClick={() => go(w.x.id)}
                  title={`${[w.held && `${w.held} landing held`, w.prs && `${w.prs} PR`, w.bind && 'wants the PRODUCTION database', w.seed && 'wants production SEEDED', w.blocked && `an APPROVED landing is holding the runway with ${w.blockedBy} zee(s) queued behind it — it never landed`, w.tend && `tend (needs a human)${w.tendFull ? `: ${w.tendFull}` : ''}`, w.envAlert && `.zeehive.env could NOT be reconciled and a zee is live in it${w.envFull ? `: ${w.envFull}` : ''}`].filter(Boolean).join(' · ')} — click to review`}>
            {w.x.slug}
            {/* WHOSE crew is asking. A held landing from a crew member is a different decision from one
                by a lone xell — there is an agent whose plan it belongs to — and this line was the one
                place a human meets that ask. Same words as the card and the canvas (hive/crew.js). */}
            {links && <CrewChip x={w.x} links={links} />}
            <span className="ny-n">{[
              w.held > 0 && `${w.held} landing${w.held === 1 ? '' : 's'}`,
              w.prs > 0 && `${w.prs} PR${w.prs === 1 ? '' : 's'}`,
              w.bind > 0 && '⚠ wants PROD DB',
              w.seed > 0 && `⚠ seed prod (${w.seed})`,
              w.doneSug > 0 && '⬢ manager says done',
              w.blocked > 0 && `⛔ holds the runway${w.blockedBy ? ` · ${w.blockedBy} queued` : ''}`,
              w.tend > 0 && `🖐 tend${w.tendWhy ? `: ${clip(w.tendWhy, 60)}` : ''}`,
              w.envAlert > 0 && `⚠ env NOT reconciled${w.envWhy ? `: ${clip(w.envWhy, 60)}` : ''}`,
            ].filter(Boolean).join(' · ')}</span>
          </button>
        ))}
      </div>
      {open && (
        <div className="ny-decision">
          {landings.map((r) => <LandCard key={r.id} req={r} onDone={onDecided} onDismiss={onDismiss} />)}
          {prs.map((r) => <PrCard key={r.id} req={r} onDone={onDecided} onDismiss={onDismiss} />)}
          {binds.map((r) => <ProdBindCard key={r.id} req={r} onDone={onDecided} />)}
          {seeds.map((r) => <SeedCard key={r.id} req={r} onDone={onDecided} />)}
          {doneSugs.map((r) => <DoneSuggestionCard key={r.id} req={r} onDone={onDecided} />)}
          {open.tend > 0 && landings.length === 0 && prs.length === 0 && binds.length === 0
            && seeds.length === 0 && doneSugs.length === 0 && (
            <div className="ny-note">🖐 <b>{open.x.slug}</b> raised a <b>tend</b> — its zee asked for a human
              {open.tendFull ? <>: <b className="ny-why">{open.tendFull}</b></> : ' (it gave no reason)'}.
              {' '}Open its session for the detail; it clears when the zee reports working or runs <code>zee tend --clear</code>.</div>
          )}
          {/* The env alert's opened form. Unconditional on the other cards, unlike the tend note
              above: this one is not a request competing for the same slot, it is a statement about
              the machine underneath a xell that may ALSO have a landing held. There is no button
              because there is nothing here a click can decide — the fix is to re-point the xell's
              database, and the next reconcile lowers it by itself. */}
          {open.envAlert > 0 && (
            <div className="ny-note" data-testid="env-alert-note">⚠ <b>{open.x.slug}</b>: the queenzee could
              {' '}<b>NOT reconcile its .zeehive.env</b>, and a zee is live in it — so it is still running on
              whatever that file already said
              {open.envFull ? <>: <b className="ny-why">{open.envFull}</b></> : ' (no reason was recorded)'}.
              {' '}{open.x.env_alert?.count > 1
                ? `Reported on ${open.x.env_alert.count} reconciles, first seen ${fmtAgo(open.x.env_alert.since)}.`
                : 'Reported on the last reconcile.'}
              {' '}Nothing was rewritten — changing a running zee's DSN underneath it is the more dangerous act.
              {' '}Fix the cause (usually: re-point this xell&apos;s database) and the next reconcile clears this;
              the zee cannot.</div>
          )}
        </div>
      )}
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
    if (!(await showConfirm(
      `Accept ${req.xell_slug}'s PR into ${(req.ref || '').replace('refs/heads/', '')}?\n\n`
      + `This fast-forwards to ${String(req.new_sha).slice(0, 10)} — the exact commit listed here. `
      + `It cannot pull in anything you haven't read: if it is no longer a fast-forward, it is `
      + `refused rather than merged.`, { okLabel: 'Accept PR' }))) return;
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
          {/* Same as a held landing: the stat opens the patch you are being asked to accept. */}
          <button className="land-stat difflink" data-testid="pr-diff"
                  title="Read the diff — the exact lines this PR would bring in"
                  onClick={(e) => {
                    e.stopPropagation();
                    showDiff({ kind: 'land', landId: req.id,
                      title: `${req.xell_slug || 'a xell'} → ${(req.ref || '').replace('refs/heads/', '')}`,
                      subtitle: `PR · ${String(req.new_sha).slice(0, 10)} · ${commits.length} commit${commits.length === 1 ? '' : 's'}` });
                  }}>
            {commits.length} commit{commits.length === 1 ? '' : 's'}
            {stat.files != null && <> · {stat.files}f <span className="ins">+{stat.insertions}</span>/<span className="del">−{stat.deletions}</span></>}
            <span className="difflink-hint">view diff</span>
          </button>
          <ul className="land-commits">
            {commits.slice(0, 8).map((c) => (
              <li key={c.short}>
                <code>{c.short}</code> {c.subject}{' '}
                <span className="land-author">{c.author}</span>
                {c.door && <span className="land-door" title={`committer: ${c.committer || ''} <${c.committer_email || ''}>`}>
                  · {c.door}{c.committer && c.door !== c.committer ? ` / ${c.committer}` : ''}
                </span>}
              </li>
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
