import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { subscribe } from '../api.js';
import { showConfirm } from '../Dialog.jsx';
import {
  addDep, getBoard, getGantt, getWorkStatuses, patchWorkItem, removeDep, vocabOf,
} from './workApi.js';
import { Breadcrumb, ErrLine, KindGlyph, StatusDot, ZeeChip, parseDay, statusLabel } from './bits.jsx';
import {
  END, LINK, MOVE, START, ZOOMS, bands, barSpan, clampSpan, dayKey, daysAt, diffDays, dragDates,
  scheduleWindow, startOfDay, windowFor, xOf, zoomOf,
} from './timescale.js';
import WorkItemDrawer from './WorkItemDrawer.jsx';

// WORK TRACKER — THE TIMELINE (gantt). The third tab: the same work-item tree the rail and the
// board draw, read against TIME instead of against status.
//
// WHY IT IS BUILT THE WAY IT IS:
//
// 1. IT RENDERS THE SERVER'S READ MODEL AND DERIVES NO DATES OF ITS OWN. `/api/gantt` already
//    rolls a parent's span up from its children (`computed_start` / `computed_end`), weights a
//    parent's progress by leaves (`rolled_progress`) and flags the rows that have no dates
//    anywhere (`unscheduled`). Recomputing any of that in the browser would be a second authority
//    that drifts the first time the roll-up rule changes — so this file reads the rows and turns
//    them into pixels, nothing more. The one piece of arithmetic it does own (date ⇄ pixel, snap,
//    drag) lives in `timescale.js`, pure, where the test can exercise it without a browser.
//
// 2. AN UNSCHEDULED ROW NEVER GETS AN INVENTED DATE. A bar drawn from a guess is indistinguishable
//    from a bar drawn from a plan the moment it is on screen. Undated rows are LISTED in the tray
//    under the chart with an explicit "schedule" action, and that action is the only place in the
//    console that proposes dates (today → today + estimate, or one day when there is no estimate).
//
// 3. A SUMMARY ROW IS A BRACKET, NOT A BAR — because a parent's dates are usually its CHILDREN'S,
//    and a solid bar over rolled-up dates reads like a commitment nobody made. What decides
//    DRAGGABILITY is not the shape but the ownership: a row can be dragged exactly when it carries
//    BOTH of its own dates (a parent that states its own span may be dragged, and the server keeps
//    those dates — its children keep theirs). A row whose dates are only computed has no handles,
//    and the tooltip SAYS why rather than leaving a human to discover a dead bar.
//
// 4. THE COLOURS COME FROM ONE PLACE: the `.work-st-<key>` rules in the fenced WORK TRACKER
//    section of `web/src/styles.css` — the very rules that paint the board's status dots, and the
//    only place in the web app where a status key is written down (test/work-console.test.mjs
//    holds that list in lockstep with `server/src/lib/work-status.js`). A bar therefore carries
//    `work-st-${row.status}` as a class and defines no palette of its own; "terminal" and every
//    label come from `GET /api/work-statuses`, never from a list typed in here.
//
// 5. THE LEFT COLUMN AND THE CANVAS SHARE ONE SCROLLER. Vertical scroll must stay row-aligned, and
//    two panes synchronised by JS scroll handlers judder and drift. So both live in a single
//    `overflow:auto` element: the name cells are `position: sticky; left: 0` and the axis header is
//    `position: sticky; top: 0`, which makes horizontal scroll the time axis and vertical scroll
//    shared BY CONSTRUCTION rather than by a listener.
//
// 6. EVERY WRITE IS OPTIMISTIC AND ROLLS BACK WITH THE SERVER'S SENTENCE, exactly like the board.
//    A drag that the server refuses snaps back and prints what it said — the refusal sentence is
//    the only thing that tells a human what to do next.
//
// KNOWN LIMITS (stated, not hidden): drag-and-drop has no keyboard parity (the board has the same
// gap); dependency arrows are drawn between VISIBLE rows only, so collapsing a parent hides the
// arrows into its subtree; an SSE refetch that lands mid-drag repaints under the gesture (the drop
// still commits from the dates the drag STARTED with, held in a ref, so nothing is written wrong);
// and the zee chip is read from `/api/board`, which is the read model that
// resolves LIVE xells (policy 4 — a reaped xell lends a work item nothing), because `/api/gantt`
// carries only `xell_id` and a corpse must not be rendered as an agent.

const ROW = 30;          // one row's height, shared by the name cell, the track and the arrow maths.
                         // 30px leaves room for BOTH bars the gantt can draw per row: the PLAN (a
                         // human's dates, draggable) and the ACTUAL (what the record proves, read-only).
const LEFT = 292;        // the name column's width; the canvas starts here
const ZOOM_KEY = 'zeehive.work.gantt.zoom';

export default function Gantt({ projectId, rootId }) {
  const [model, setModel] = useState(null);
  const [statuses, setStatuses] = useState([]);
  // null = NOT KNOWN (the board has not answered, or its answer failed). A Map is knowledge; null
  // is the absence of it, and the tooltip says which. Starting at an empty Map made "the board did
  // not answer" indistinguishable from "nobody is on this item" — a lie with a confident voice.
  const [zees, setZees] = useState(null);              // item id → the LIVE zee on it, from /api/board
  const [err, setErr] = useState(null);
  const [openItem, setOpenItem] = useState(null);
  // Optimistic date overrides, keyed by item id, cleared when the refetch lands (or the server
  // refuses). `inFlight` is which of them still have a PATCH outstanding: a refetch triggered by
  // somebody else's SSE event used to clear the whole map, which snapped a bar the human was still
  // waiting on back to its old dates — it read as "the drag failed" and then it moved again.
  const [over, setOver] = useState(() => new Map());
  const inFlight = useRef(new Set());

  useEffect(() => {
    let live = true;
    getWorkStatuses().then((v) => { if (live) setStatuses(vocabOf(v).statuses); })
      .catch((e) => { if (live) setErr(e); });
    return () => { live = false; };
  }, []);

  const load = useCallback(async () => {
    // The timeline is /api/gantt. The board is fetched ALONGSIDE it only for "who is on it": that
    // read model resolves the xell and answers null for a retired one, which is the rule the whole
    // tracker follows. It is best-effort — a board that fails must not blank the timeline.
    const [g, b] = await Promise.allSettled([getGantt(projectId, rootId), getBoard(projectId, rootId)]);
    if (g.status === 'fulfilled') {
      setModel(g.value);
      // Keep the overrides whose own PATCH is still outstanding; drop the rest, because this answer
      // already contains them.
      setOver((m) => {
        const n = new Map();
        for (const [id, v] of m) if (inFlight.current.has(id)) n.set(id, v);
        return n;
      });
      setErr(null);
    } else setErr(g.reason);
    if (b.status === 'fulfilled') {
      const m = new Map();
      for (const col of b.value?.columns || []) {
        for (const card of col.items || []) if (card?.zee) m.set(card.id, card.zee);
      }
      setZees(m);
    } else setZees(null);        // unknown, and the tooltip will SAY unknown
  }, [projectId, rootId]);
  useEffect(() => { load(); }, [load]);

  // LIVE — the same nudge the console uses: zees and humans both write this data, and a timeline
  // that is stale about a date is a timeline nobody trusts. Debounced, because one action emits
  // several events.
  useEffect(() => {
    let timer = null;
    const nudge = () => { clearTimeout(timer); timer = setTimeout(load, 400); };
    const stop = subscribe(projectId, { onSnapshot: () => {}, onChange: nudge });
    return () => { clearTimeout(timer); stop(); };
  }, [projectId, load]);

  const rows = useMemo(() => {
    const list = Array.isArray(model) ? model : (model?.rows || []);
    if (!over.size) return list;
    // An override replaces the row's OWN dates and, because an explicitly dated row is its own
    // computed span, its computed ones too. Its ancestors' roll-ups are the server's to recompute —
    // the refetch that follows the PATCH brings them.
    return list.map((r) => {
      const o = over.get(r.id);
      return o ? { ...r, ...o, computed_start: o.starts_on, computed_end: o.due_on } : r;
    });
  }, [model, over]);

  // One write path for every date change (a drag, an edge resize, a tray "schedule"): optimistic,
  // rolled back with the server's own sentence.
  const reschedule = useCallback(async (id, dates) => {
    setOver((m) => new Map(m).set(id, dates));
    inFlight.current.add(id);
    try {
      await patchWorkItem(id, dates);
      setErr(null);
      inFlight.current.delete(id);
      await load();
    } catch (e) {
      setErr(e);
      inFlight.current.delete(id);
      setOver((m) => { const n = new Map(m); n.delete(id); return n; });
    }
  }, [load]);

  const link = useCallback(async (itemId, dependsOnId) => {
    try { await addDep(itemId, dependsOnId); setErr(null); await load(); }
    catch (e) { setErr(e); }
  }, [load]);

  const unlink = useCallback(async (itemId, dependsOnId, label) => {
    if (!(await showConfirm(label, { variant: 'danger', okLabel: 'Remove' }))) return;
    try { await removeDep(itemId, dependsOnId); setErr(null); await load(); }
    catch (e) { setErr(e); }
  }, [load]);

  return (
    <div className="work-gantt" data-testid="work-gantt">
      <ErrLine err={err} onDismiss={() => setErr(null)} />
      {model === null && !err && <div className="work-empty">loading the timeline…</div>}
      {model !== null && (
        <GanttChart rows={rows} statuses={statuses} zees={zees}
                    unscheduledCount={model?.unscheduled_count}
                    onOpen={setOpenItem} onReschedule={reschedule} onLink={link} onUnlink={unlink}
                    onRefuse={(m) => setErr(new Error(m))} />
      )}
      {openItem && (
        <WorkItemDrawer itemId={openItem} projectId={projectId} statuses={statuses}
                        onClose={() => setOpenItem(null)} onChanged={load} onOpen={setOpenItem} />
      )}
    </div>
  );
}

// ── the chart ───────────────────────────────────────────────────────────────────────────────────
// Split out and EXPORTED so it can be rendered from a fixture with no network at all
// (test/work-gantt.test.mjs server-renders it over real rows and asserts on the markup). It owns
// only view state — zoom, collapse, hover, the gesture in flight — and asks its parent to write.
export function GanttChart({ rows = [], statuses = [], zees, unscheduledCount,
                             onOpen, onReschedule, onLink, onUnlink, onRefuse, today }) {
  const [zoom, setZoom] = useState(() => {
    try { const z = localStorage.getItem(ZOOM_KEY); return ZOOMS.some((x) => x.key === z) ? z : ZOOMS[1].key; }
    catch { return ZOOMS[1].key; }
  });
  const [collapsed, setCollapsed] = useState(() => new Set());
  const [focus, setFocus] = useState(null);       // the row a human is pointing at or has selected
  const [tip, setTip] = useState(null);           // { row, x, y }
  const [ghost, setGhost] = useState(null);       // the live preview of the gesture in flight
  const [active, setActive] = useState(null);     // "<id>:<mode>" while a gesture is live
  const gesture = useRef(null);
  // The rows as of THIS render, for the drop handler to check against — a gesture holds the dates
  // it began with, and a refetch can land under it.
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const dragged = useRef(false);          // a drag that MOVED must not also open the drawer on click
  const scroller = useRef(null);
  const centred = useRef(false);

  useEffect(() => { try { localStorage.setItem(ZOOM_KEY, zoom); } catch { /* private mode */ } }, [zoom]);

  const px = zoomOf(zoom).px;
  // TODAY, memoised on the DAY rather than on the object. `new Date()` as a default prop was a
  // fresh object every render, so this memo — and win, axis and geom below it, which all depend on
  // it — missed on EVERY render, and a render happens on every pointermove of a drag (the ghost is
  // state). The whole ruler was being rebuilt, per mouse event, for nothing.
  const todayKey = today ? dayKey(today) : null;
  const t0 = useMemo(() => startOfDay(today || new Date()), [todayKey]);   // eslint-disable-line
  const byId = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);
  const kidsOf = useMemo(() => {
    const m = new Map();
    for (const r of rows) {
      if (!r.parent_id) continue;
      if (!m.has(r.parent_id)) m.set(r.parent_id, []);
      m.get(r.parent_id).push(r.id);
    }
    return m;
  }, [rows]);

  // A row is hidden when ANY ancestor is collapsed — the tree can nest to any depth (activity under
  // activity, task under task are both legal), so this walks the chain rather than assuming three
  // levels.
  const visible = useMemo(() => rows.filter((r) => {
    let p = r.parent_id;
    while (p) { if (collapsed.has(p)) return false; p = byId.get(p)?.parent_id || null; }
    return true;
  }), [rows, collapsed, byId]);

  // A row is "dated" when it has a PLAN bar, an ACTUAL bar, or both — the whole point of the
  // actuals is that a 470-item schedule with 0 plan dates still gets a window. `unscheduled`
  // (server-derived) is now "no dates at all, planned OR actual", so the tray lists the truly
  // dateless rows and nothing else.
  const dated = useMemo(() => rows.filter((r) =>
    r.computed_start || r.computed_end || r.computed_actual_start || r.computed_actual_end), [rows]);
  const unscheduled = useMemo(() => rows.filter((r) => r.unscheduled), [rows]);

  const win = useMemo(() => windowFor(
    dated.flatMap((r) => [parseDay(r.computed_start), parseDay(r.computed_end),
                           parseDay(r.computed_actual_start), parseDay(r.computed_actual_end)]),
    { today: t0, zoom },
  ), [dated, t0, zoom]);
  const axis = useMemo(() => bands(win.start, win.end, zoom, px), [win, zoom, px]);
  const width = axis.width;
  const todayX = diffDays(win.start, t0) >= 0 && diffDays(t0, win.end) > 0 ? xOf(t0, win.start, px) : null;

  // Geometry, once per render: where every visible row's bar sits. The arrows read it, the ghost
  // reads it, and nothing measures the DOM.
  const geom = useMemo(() => {
    const m = new Map();
    visible.forEach((r, i) => {
      // Clamped to the canvas: see clampSpan. A bar that reaches past the window is drawn to the
      // edge and marked, and one entirely outside it draws nothing — the clamp notice counts it.
      const span = clampSpan(barSpan(parseDay(r.computed_start), parseDay(r.computed_end), win.start, px), width);
      m.set(r.id, { i, top: i * ROW, span });
    });
    return m;
  }, [visible, win, px, width]);

  // The ACTUAL bar's geometry — the same shape as the plan's, from the same clamp, so the two bars
  // of one row share a coordinate space and never disagree about where "today" is.
  const actualGeom = useMemo(() => {
    const m = new Map();
    visible.forEach((r, i) => {
      const span = clampSpan(barSpan(parseDay(r.computed_actual_start), parseDay(r.computed_actual_end), win.start, px), width);
      m.set(r.id, { i, top: i * ROW, span });
    });
    return m;
  }, [visible, win, px, width]);

  // Park the viewport on today the first time there is something to look at (and again on a zoom
  // change, which otherwise leaves a human staring at an empty stretch of ruler).
  useEffect(() => {
    const el = scroller.current;
    if (!el || todayX === null) return;
    if (centred.current === zoom) return;
    centred.current = zoom;
    el.scrollLeft = Math.max(0, todayX - Math.max(120, (el.clientWidth - LEFT) / 3));
  }, [todayX, zoom]);

  const isTerminal = useCallback(
    (key) => !!(statuses || []).find((s) => s.key === key)?.terminal, [statuses],
  );

  const toggle = (id) => setCollapsed((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });

  // ── the gesture ───────────────────────────────────────────────────────────────────────────────
  // One pointer gesture, four modes. It starts on a bar (or one of its handles), tracks on the
  // WINDOW — a pointer that leaves the bar must not abandon the drag — and commits on release.
  const begin = (e, row, mode) => {
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const start = parseDay(row.computed_start);
    const end = parseDay(row.computed_end) || start;
    gesture.current = { id: row.id, mode, x0: e.clientX, start, end };
    dragged.current = false;
    setActive(`${row.id}:${mode}`);
    setTip(null);
    setGhost(mode === LINK
      ? { id: row.id, mode, x: e.clientX, y: e.clientY, target: null }
      : { id: row.id, mode, ...dragDates({ mode, start, end }, 0, zoom) });
  };

  useEffect(() => {
    if (!active) return undefined;
    const hit = (e) => document.elementFromPoint(e.clientX, e.clientY)?.closest?.('[data-gbar]')?.dataset?.gbar || null;
    const move = (e) => {
      const g = gesture.current;
      if (!g) return;
      if (Math.abs(e.clientX - g.x0) > 3) dragged.current = true;
      if (g.mode === LINK) { setGhost({ id: g.id, mode: LINK, x: e.clientX, y: e.clientY, target: hit(e) }); return; }
      setGhost({ id: g.id, mode: g.mode, ...dragDates(g, daysAt(e.clientX - g.x0, px), zoom) });
    };
    const up = (e) => {
      const g = gesture.current;
      gesture.current = null;
      setActive(null);
      setGhost(null);
      // The click that follows this pointerup must be swallowed when the pointer actually MOVED
      // (a drag is not a click) — but only that one: a drag released off a bar never receives the
      // click that would otherwise clear the flag, and the next honest click would be eaten.
      if (dragged.current) setTimeout(() => { dragged.current = false; }, 0);
      if (!g) return;
      if (g.mode === LINK) {
        const target = hit(e);
        if (target && target !== g.id) onLink?.(target, g.id);   // the bar you dropped ON depends on the one you dragged FROM
        return;
      }
      // TWO BELTS against the defect this shipped with: a gesture that never moved cannot write
      // (this line), and dragDates quantises the MOVEMENT rather than the resulting date, so a 0px
      // drag is an identity at every zoom (timescale.js rule 3). Either alone would have been
      // enough; both, because "a click silently rescheduled the item" is the worst kind of bug —
      // it looks like the human did it.
      if (!dragged.current) return;
      // LAST WRITE WINS IS NOT A POLICY, IT IS AN ACCIDENT. The gesture carries the dates it started
      // from; if the row moved underneath it (another zee, another human, the drawer behind this
      // tab) the drop would silently overwrite the newer dates with ones derived from the older.
      // So the drop checks, refuses, and says so — the same shape as a server refusal, for a
      // conflict the server cannot see.
      const now = rowsRef.current.find((r) => r.id === g.id);
      if (now && (now.computed_start !== dayKey(g.start) || now.computed_end !== dayKey(g.end))) {
        onRefuse?.(`“${now.title}” moved while you were dragging it (it now runs ${now.computed_start} → ${now.computed_end}). `
          + 'Nothing was written — look at where it is now and drag it again.');
        return;
      }
      const next = dragDates(g, daysAt(e.clientX - g.x0, px), zoom);
      if (next.starts_on === dayKey(g.start) && next.due_on === dayKey(g.end)) return;
      onReschedule?.(g.id, next);
    };
    // Escape cancels the WRITE — in the CAPTURE phase so it answers here and does not also reach
    // the console's own window listener and close the whole overlay mid-drag. It deliberately does
    // NOT tear the gesture down: `active` is what keeps these listeners alive, so clearing it here
    // removed the pointerup handler before it could run, and the flag that swallows the post-drag
    // click was then never cleared — the NEXT click on any bar was eaten. Every gesture now ends in
    // exactly one place (`up`), cancelled or not.
    const key = (e) => {
      if (e.key !== 'Escape' || !gesture.current) return;
      e.stopPropagation();
      gesture.current = null;
      setGhost(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);   // a cancelled pointer must not strand the gesture
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      window.removeEventListener('keydown', key, true);
    };
  }, [active, px, zoom, onLink, onReschedule, onRefuse]);

  // A dependency whose predecessor has no bar cannot be drawn — and silence reads as "that
  // dependency was deleted". So every undrawable edge is collected WITH ITS REASON and marked on
  // the successor's bar, where a human is already looking.
  const hiddenDeps = useMemo(() => {
    const m = new Map();
    for (const r of visible) {
      const miss = [];
      for (const depId of r.deps || []) {
        if (geom.get(depId)?.span) continue;
        const known = byId.get(depId);
        miss.push({
          id: depId,
          title: known?.title || null,
          why: !known ? 'outside the scope you are looking at'
            : (known.unscheduled || !known.computed_start ? 'has no dates yet'
              : 'inside a collapsed parent'),
        });
      }
      if (miss.length) m.set(r.id, miss);
    }
    return m;
  }, [visible, geom, byId]);

  const arrows = useMemo(() => {
    const out = [];
    for (const r of visible) {
      const to = geom.get(r.id);
      if (!to?.span) continue;
      for (const depId of r.deps || []) {
        const from = geom.get(depId);
        if (!from?.span) continue;
        out.push({ key: `${depId}->${r.id}`, itemId: r.id, depId, from, to, dep: byId.get(depId), row: r });
      }
    }
    return out;
  }, [visible, geom, byId]);

  // Rows the clamped window cannot show. Counting them is the difference between "we are hiding
  // something" and "there is nothing there".
  const outside = useMemo(() => (win.clamped ? dated.filter((r) => {
    const s = parseDay(r.computed_start) || parseDay(r.computed_actual_start)
           || parseDay(r.computed_end) || parseDay(r.computed_actual_end);
    const e = parseDay(r.computed_end) || parseDay(r.computed_actual_end)
           || parseDay(r.computed_start) || parseDay(r.computed_actual_start);
    return diffDays(win.start, e) < 0 || diffDays(s, win.end) < 0;
  }).length : 0), [win, dated]);

  const rowsH = Math.max(ROW, visible.length * ROW);
  const empty = !rows.length;
  const nothingDated = !empty && !dated.length;

  return (
    <div className="work-gchart">
      <div className="work-gtools">
        <span className="work-glbl">zoom</span>
        {ZOOMS.map((z) => (
          <button key={z.key} className={`work-mini${zoom === z.key ? ' on' : ''}`}
                  data-zoom={z.key} onClick={() => { centred.current = null; setZoom(z.key); }}>{z.label}</button>
        ))}
        <button className="work-mini" title="scroll the canvas to today" disabled={todayX === null}
                onClick={() => scrollToToday(scroller, todayX)}>today</button>
        <span className="work-gcount">{visible.length} of {rows.length} row(s)</span>
        {(unscheduledCount ?? unscheduled.length) > 0 &&
          <span className="work-gcount warn">{unscheduledCount ?? unscheduled.length} undated</span>}
        <span className="work-ghint">drag a bar to move it · drag its right dot onto another bar to make that one depend on it</span>
      </div>

      {empty && (
        <div className="work-gempty">
          <b>No work items in this scope yet.</b>
          <span>Break a ticket down on the <b>Tickets</b> tab, or add an activity in the tree on the left —
                then give it dates here or in the item drawer.</span>
        </div>
      )}
      {nothingDated && (
        <div className="work-gempty">
          <b>No dated work items yet.</b>
          <span>Nothing here has a start or a due date, so there is nothing to place on a timeline.
                Schedule one from the tray below, or open an item and give it dates —
                the timeline never invents them.</span>
        </div>
      )}

      {win.clamped && (
        <div className="work-warn work-gclamp" role="status">
          ⚠ these dates span {win.clamped.requested.toLocaleString()} days
          (≈{Math.max(1, Math.round(win.clamped.requested / 365.25)).toLocaleString()} years) — far more
          than a timeline can draw, so this window shows {win.clamped.shown.toLocaleString()} days
          from {win.clamped.from}{outside > 0 ? `, and ${outside} row(s) fall outside it` : ''}.
          That is almost always a mistyped year: open the row and check its dates.
        </div>
      )}
      {!empty && !nothingDated && (
        <div className="work-gscroll" ref={scroller}>
          <div className="work-gsheet" style={{ width: LEFT + width }}>
            <div className="work-ghead" style={{ height: ROW + 18 }}>
              <div className="work-ghead-n" style={{ width: LEFT }}>
                <span className="work-glbl">work item</span>
              </div>
              <div className="work-ghead-t" style={{ width }}>
                <div className="work-gmajor">
                  {axis.major.map((b) => (
                    <span key={b.key} className={`work-gmaj${b.alt ? ' alt' : ''}`} style={{ left: b.x, width: b.w }}>{b.label}</span>
                  ))}
                </div>
                <div className="work-gminor">
                  {axis.minor.map((b) => (
                    <span key={b.key} className={`work-gmin${b.weekend ? ' we' : ''}`} style={{ left: b.x, width: b.w }}>{b.label}</span>
                  ))}
                </div>
              </div>
            </div>

            <div className="work-gbody" style={{ height: rowsH }}>
              <div className="work-gbands" style={{ left: LEFT, width, height: rowsH }}>
                {axis.weekends.map((b) => <i key={b.key} className="work-gwe" style={{ left: b.x, width: b.w }} />)}
                {axis.major.map((b) => <i key={b.key} className="work-gsep" style={{ left: b.x }} />)}
              </div>
              {todayX !== null && (
                <div className="work-gtoday" style={{ left: LEFT + todayX, height: rowsH }} title={`today — ${dayKey(t0)}`} />
              )}

              {visible.map((r) => {
                const g = geom.get(r.id);
                const kids = kidsOf.get(r.id) || [];
                const summary = kids.length > 0;
                const own = !!(r.starts_on && r.due_on);
                const end = parseDay(r.computed_end);
                const late = !!end && diffDays(t0, end) < 0 && !isTerminal(r.status);
                const pct = Math.max(0, Math.min(100, Number(r.rolled_progress ?? r.progress) || 0));
                const gh = ghost && ghost.id === r.id && ghost.mode !== LINK ? ghost : null;
                const span = gh
                  ? clampSpan(barSpan(parseDay(gh.starts_on), parseDay(gh.due_on), win.start, px), width)
                  : g?.span;
                const actualSpan = actualGeom.get(r.id)?.span || null;
                const hot = focus === r.id || ghost?.id === r.id || ghost?.target === r.id;
                return (
                  <div key={r.id} className={`work-grow${hot ? ' hot' : ''}`} style={{ height: ROW }}
                       onMouseEnter={() => setFocus(r.id)} onMouseLeave={() => setFocus((f) => (f === r.id ? null : f))}>
                    <div className="work-gname" style={{ width: LEFT, paddingLeft: 6 + (Number(r.depth) || 0) * 13 }}>
                      <button className={`work-chev${kids.length ? '' : ' none'}`} tabIndex={-1}
                              title={kids.length ? 'collapse / expand this subtree' : ''}
                              onClick={() => kids.length && toggle(r.id)}>
                        {kids.length ? (collapsed.has(r.id) ? '▸' : '▾') : '·'}
                      </button>
                      <StatusDot status={r.status} statuses={statuses} />
                      <KindGlyph kind={r.kind} />
                      <button className="work-gtitle" title={`${r.title} — click to open it`}
                              onClick={() => onOpen?.(r.id)}>{r.title}</button>
                      {!!pct && <span className="work-gpct">{pct}%</span>}
                    </div>
                    <div className="work-gtrack" style={{ width }}>
                      {span && (
                        <div className={`${summary ? 'work-gsum' : 'work-gbar'}${late ? ' over' : ''}`
                                        + `${own ? '' : ' rolled'}${gh ? ' ghosting' : ''}${hot ? ' hot' : ''}`
                                        + `${span.inverted ? ' inverted' : ''}`}
                             data-gbar={r.id} data-testid="work-gbar"
                             style={{ left: span.x, width: span.w }}
                             onPointerDown={(e) => { if (own) begin(e, r, MOVE); }}
                             onClick={() => { if (!dragged.current) onOpen?.(r.id); }}
                             onMouseEnter={(e) => setTip({ row: r, x: e.clientX, y: e.clientY })}
                             onMouseLeave={() => setTip(null)}>
                          {/* The two spans below take their colour from `.work-st-<key>` in
                              styles.css — the board's dot palette, the ONE place a status colour
                              is written down. The track is the same colour at low opacity; the
                              fill is progress. */}
                          <span className={`work-gfill-bg work-st-${r.status || 'unknown'}`} />
                          <span className={`work-gfill work-st-${r.status || 'unknown'}`} style={{ width: `${pct}%` }} />
                          {summary && <><i className={`work-gcap l work-st-${r.status || 'unknown'}`} />
                                        <i className={`work-gcap r work-st-${r.status || 'unknown'}`} /></>}
                          {own && (
                            <>
                              <i className="work-ghandle l" title="drag to change the start"
                                 onPointerDown={(e) => begin(e, r, START)} />
                              <i className="work-ghandle r" title="drag to change the end"
                                 onPointerDown={(e) => begin(e, r, END)} />
                              <i className="work-glink" title="drag onto another bar: that bar will depend on this one"
                                 onPointerDown={(e) => begin(e, r, LINK)} />
                            </>
                          )}
                          {span.open && <i className="work-gopen" title="no due date — this end is open" />}
                          {span.cutLeft && <i className="work-gcut l" title="it starts before this window" />}
                          {span.cutRight && <i className="work-gcut r" title="it continues past this window" />}
                        </div>
                      )}
                      {/* The ACTUAL bar — what the record PROVES happened, read-only. No handles, no
                          drag, no dependency link: actuals are derived facts, never agent-submitted.
                          It draws only when there is evidence (actual_start/actual_end from the
                          ledger), and it is a thin line under the plan's bar so the two read side by
                          side. A null actual_end (still in flight) draws open-ended. */}
                      {actualSpan && (
                        <div className="work-gbar actual" data-testid="work-gbar-actual"
                             style={{ left: actualSpan.x, width: actualSpan.w }}
                             onMouseEnter={(e) => setTip({ row: r, x: e.clientX, y: e.clientY })}
                             onMouseLeave={() => setTip(null)}>
                          <span className="work-gfill-bg actual" />
                          {actualSpan.open && <i className="work-gopen" title="still in flight — no actual end yet" />}
                          {actualSpan.cutLeft && <i className="work-gcut l" title="it starts before this window" />}
                          {actualSpan.cutRight && <i className="work-gcut r" title="it continues past this window" />}
                        </div>
                      )}
                      {span && hiddenDeps.has(r.id) && (
                        <i className="work-gdepx" style={{ left: Math.max(0, span.x - 14) }}
                           title={hiddenTitle(hiddenDeps.get(r.id))}>⋯</i>
                      )}
                    </div>
                  </div>
                );
              })}

              {/* DEPENDENCIES. Routed through the gap ABOVE the successor row rather than straight
                  across, so a line never lies on top of a bar, and dimmed unless one of its two
                  rows is hovered/selected — every arrow at full strength is a hairball. */}
              {/* While a dependency is being DRAWN, the arrows go inert: a hovered arrow's hit path
                  is 9px of stroke sitting above the bars, and releasing on the few pixels where one
                  crosses the target bar found the path instead of the bar — the dependency was
                  silently not created. */}
              <svg className={`work-garrows${ghost?.mode === LINK ? ' linking' : ''}`}
                   style={{ left: LEFT, width, height: rowsH }} width={width} height={rowsH}>
                <defs>
                  <marker id="work-garrowhead" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
                    <path d="M0,0 L7,3.5 L0,7 z" fill="currentColor" />
                  </marker>
                </defs>
                {arrows.map((a) => {
                  const on = focus === a.itemId || focus === a.depId;
                  const d = arrowPath(a.from, a.to);
                  return (
                    <g key={a.key} className={`work-garrow${on ? ' on' : ''}`}>
                      <path d={d} className="work-garrow-line" markerEnd="url(#work-garrowhead)" />
                      <path d={d} className="work-garrow-hit"
                            onClick={() => onUnlink?.(a.itemId, a.depId,
                              `Remove the dependency “${a.row?.title}” waits for “${a.dep?.title || 'that item'}”?`)}>
                        <title>{`${a.row?.title} depends on ${a.dep?.title || 'another item'} — click to remove`}</title>
                      </path>
                    </g>
                  );
                })}
                {ghost?.mode === LINK && <LinkGhost ghost={ghost} geom={geom} scroller={scroller} />}
              </svg>
            </div>
          </div>
        </div>
      )}

      {tip && !ghost && (
        <Tip row={tip.row} x={tip.x} y={tip.y} statuses={statuses} zee={zees?.get?.(tip.row.id)}
             zeesKnown={!!zees}
             crumb={crumbOf(tip.row, byId)} summary={(kidsOf.get(tip.row.id) || []).length > 0}
             hidden={hiddenDeps.get(tip.row.id)} inverted={geom.get(tip.row.id)?.span?.inverted}
             today={t0} terminal={isTerminal(tip.row.status)} />
      )}

      {!!unscheduled.length && (
        <div className="work-gtray" data-testid="work-gtray">
          <header className="work-gtray-h">
            <span>undated — {unscheduled.length} item(s) with no dates anywhere in their subtree</span>
            <span className="work-ghint">the timeline lists them; it does not invent dates for them</span>
          </header>
          <div className="work-gtray-b">
            {unscheduled.map((r) => (
              <div key={r.id} className="work-gtrow">
                <StatusDot status={r.status} statuses={statuses} />
                <KindGlyph kind={r.kind} />
                <button className="work-row-t link" onClick={() => onOpen?.(r.id)}>{r.title}</button>
                {r.estimate_hours != null && <span className="work-gest">{r.estimate_hours}h</span>}
                <button className="work-mini" title={scheduleTitle(r, t0)}
                        onClick={() => onReschedule?.(r.id, scheduleWindow(r, t0))}>schedule</button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── the pieces ──────────────────────────────────────────────────────────────────────────────────

// The rubber line while a dependency is being drawn. It is drawn in the SVG's own coordinate space,
// so the pointer's client position is translated back through the scroller's box.
function LinkGhost({ ghost, geom, scroller }) {
  const from = geom.get(ghost.id);
  const el = scroller.current;
  if (!from?.span || !el) return null;
  const box = el.getBoundingClientRect();
  const x2 = ghost.x - box.left + el.scrollLeft - LEFT;
  const y2 = ghost.y - box.top + el.scrollTop - (ROW + 18);
  const x1 = from.span.x + from.span.w;
  const y1 = from.top + ROW / 2;
  return <path className="work-garrow-drawing" d={`M${x1},${y1} L${x2},${y2}`} />;
}

// finish → start, routed above the successor's row. `from` is the predecessor's geometry.
function arrowPath(from, to) {
  const x1 = from.span.x + from.span.w;
  const y1 = from.top + ROW / 2;
  const x2 = to.span.x;
  const y2 = to.top + ROW / 2;
  const lane = to.top + 3;                 // the gap above the successor — never across a bar
  const out = x1 + 9;
  const inn = Math.max(x2 - 9, out);
  return `M${x1},${y1} H${out} V${lane} H${inn} V${y2} H${x2 - 1}`;
}

// The tooltip. It says what the bar is, WHEN it is, who is on it, and — when the bar cannot be
// dragged — why, because a dead handle with no explanation is the worst kind of UI.
export function Tip({ row, x, y, statuses, zee, zeesKnown = true, crumb, summary, hidden, inverted, today, terminal }) {
  const own = !!(row.starts_on && row.due_on);
  const end = row.computed_end;
  const late = !!end && diffDays(today, end) < 0 && !terminal;
  return (
    <div className="work-gtip" style={{ left: Math.min(x + 14, viewportW() - 290), top: y + 16 }}>
      <div className="work-gtip-t"><KindGlyph kind={row.kind} /> {row.title}</div>
      {crumb.length > 0 && <Breadcrumb parts={crumb} />}
      <div className="work-gtip-r">
        <StatusDot status={row.status} statuses={statuses} />
        <span>{statusLabel(statuses, row.status)}</span>
        <span className="work-gtip-d">{Math.max(0, Math.min(100, Number(row.rolled_progress ?? row.progress) || 0))}%</span>
      </div>
      <div className={`work-gtip-r${late ? ' late' : ''}`}>
        {row.computed_start || '—'} → {end || '—'}{late ? ' · overdue' : ''}
      </div>
      {/* The ACTUAL span, when the record has one. dayKey(parseDay(iso)) normalises a timestamptz to
          the YYYY-MM-DD the gantt draws it at — the same day the bar sits on. */}
      {!!row.computed_actual_start && (
        <div className="work-gtip-r actual">
          actual {dayKey(parseDay(row.computed_actual_start))} →
          {row.computed_actual_end ? ` ${dayKey(parseDay(row.computed_actual_end))}` : ' …'}
          {!row.computed_actual_end ? ' · in flight' : ''}
        </div>
      )}
      {/* Three DIFFERENT facts, and the third one used to be told as the second: a zee is on it, a
          zee is not on it, or the board did not answer and this chart does not know. */}
      {zee ? <ZeeChip zee={zee} /> : (
        <div className="work-gtip-d">
          {!zeesKnown ? 'could not read who is on it — the board did not answer'
            : row.assignee ? `assignee: ${row.assignee}` : 'nobody on it'}
        </div>
      )}
      {inverted && (
        <div className="work-gtip-w">the due date is BEFORE the start date — this bar spans the
          contradiction rather than hiding it. Fix the dates in the item drawer.</div>
      )}
      {!own && (
        <div className="work-gtip-w">
          {summary
            ? 'these dates are rolled up from the children — move the children, or give this row its own dates'
            : 'this row has only one of its two dates — set both in the item drawer to drag it'}
        </div>
      )}
      {own && summary && (
        <div className="work-gtip-d">its own dates, so it can be dragged — the children keep theirs</div>
      )}
      {!!hidden?.length && (
        <div className="work-gtip-w">{hiddenTitle(hidden)}</div>
      )}
    </div>
  );
}

// What an undrawable dependency says for itself. Named once so the marker's tooltip and the item
// tooltip cannot describe the same edge two different ways.
export function hiddenTitle(miss) {
  const list = (miss || []).map((m) => `“${m.title || 'an item'}” (${m.why})`);
  if (!list.length) return '';
  return `waits for ${list.length} item(s) this chart cannot draw: ${list.join(', ')}`;
}

// The ancestor titles, from the rows we already have (the gantt is tree-ordered and includes every
// ancestor in scope) — no second request for a breadcrumb.
export function crumbOf(row, byId) {
  const out = [];
  let p = row?.parent_id;
  const seen = new Set();
  while (p && !seen.has(p)) { seen.add(p); const n = byId.get(p); if (!n) break; out.unshift(n.title); p = n.parent_id; }
  return out;
}

// The tooltip is `position: fixed`, so it is clamped against the VIEWPORT — and this code runs in a
// SERVER render too (the static test renders the chart over a fixture), where there is no window.
const viewportW = () => (typeof window === 'undefined' ? 1200 : window.innerWidth);

const scheduleTitle = (row, today) => {
  const w = scheduleWindow(row, today);
  return `schedule it ${w.starts_on} → ${w.due_on}`;
};

function scrollToToday(scroller, todayX) {
  const el = scroller.current;
  if (!el || todayX === null) return;
  el.scrollLeft = Math.max(0, todayX - Math.max(120, (el.clientWidth - LEFT) / 3));
}
