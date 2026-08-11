import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { subscribe } from '../api.js';
import { getWorkflowGantt } from './workApi.js';
import { ErrLine, KindGlyph } from './bits.jsx';
import {
  ZOOMS, bands, barSpan, clampSpan, dayKey, diffDays, startOfDay, windowFor, xOf, zoomOf,
} from './timescale.js';

// STAGE 6 — THE TIMELINE RE-POINTED AT THE MODEL. The same tab the work tracker called a gantt
// now draws THE HIERARCHICAL WORKFLOW MODEL's plan (work_node tree) as the top-level trace from
// the plan's start to its end-goal root. Three layers per row, all READ from the model:
//
//   PLANNED — the CPM pass (wn_cpm, migration 184): earliest_start/finish for atoms, subtree
//             span for containers. Critical atoms (zero slack) are marked; slack shows in the
//             tooltip. This is the deterministic pass — nothing here edits the plan.
//   ACTUAL  — execution.started_at/finished_at: what the record PROVES happened. Containers
//             roll their subtree's executions up, exactly like the work-item gantt's actuals.
//   WAITING — held leases on 'waiting' executions: a gate wait (a landing held for a human, a
//             holding pattern) becomes a visible bar from claimed_at → expires_at. The layer
//             must scale across the measured reality (landings avg 10.7 min, holdings avg
//             6.5 DAYS), which is what the timescale's clamp and the zoom exist for.
//
// DEPENDENCY EDGES are the union graph's LEAF-LEVEL edges. A collapsed parent hides its
// children, and an edge that points at a hidden child RE-ANCHORS onto the nearest visible
// ancestor's bar instead of vanishing (visibleAnchor below). The edge is drawn between the
// anchored bars, so collapsing a container collapses its internal edges into its span.
//
// CLICK-THROUGH: clicking a bar opens the WELD WATERFALL — that row's executions, each with
// its turns and each turn's LLM gateway calls (the same nested shape workflowTreeForXell
// serves, from the observability read model). READ-ONLY: no new write path, no agent-submitted
// records — every row is a byproduct of a door (the CPM pass, the turn ledger, the gateway).
//
// KNOWN LIMITS (stated, not hidden): bars are DAY-granular (the timescale is day-based), so a
// lease measured in minutes draws as a one-day bar at minimum width; the tooltip still names
// the exact claimed/expires instants. Drag-to-reschedule is deliberately GONE — a CPM plan is
// computed, not dragged, and the work-item drawer's drag belongs to the old timeline.

const ROW = 30;          // one row's height; three bars share it (plan / actual / waiting)
const LEFT = 292;        // the name column's width; the canvas starts here
const ZOOM_KEY = 'zeehive.work.gantt.zoom';

export default function Gantt({ projectId }) {
  const [model, setModel] = useState(null);
  const [err, setErr] = useState(null);
  const [open, setOpen] = useState(null);      // the row whose weld waterfall is open

  const load = useCallback(async () => {
    try {
      // The top-level trace is the PROJECT's plan — the work tracker's scope (a work_item root)
      // is a different tree and has no work_node meaning, so the timeline ignores it.
      const g = await getWorkflowGantt(projectId, null);
      setModel(g); setErr(null);
    } catch (e) { setErr(e); }
  }, [projectId]);
  useEffect(() => { load(); }, [load]);

  // LIVE — the same SSE nudge the console uses: executions, leases and turns all change this
  // data, and a timeline that is stale about a wait is a timeline nobody trusts.
  useEffect(() => {
    let timer = null;
    const nudge = () => { clearTimeout(timer); timer = setTimeout(load, 400); };
    const stop = subscribe(projectId, { onSnapshot: () => {}, onChange: nudge });
    return () => { clearTimeout(timer); stop(); };
  }, [projectId, load]);

  return (
    <div className="work-gantt" data-testid="work-gantt">
      <ErrLine err={err} onDismiss={() => setErr(null)} />
      {model === null && !err && <div className="work-empty">loading the timeline…</div>}
      {model !== null && (
        <GanttChart rows={model.rows || []} planName={model.plan_name} version={model.version}
                    hasDeclaredOrder={model.has_declared_order} edgeCounts={model.edge_counts}
                    durationMix={model.duration_mix}
                    onOpen={setOpen} />
      )}
      {open && <WeldWaterfall row={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

// ── the chart ───────────────────────────────────────────────────────────────────────────────────
// Split out and EXPORTED so it can be rendered from a fixture with no network at all
// (test/workflow-stage6.test.mjs renders it over real rows and asserts on the markup). It owns
// only view state — zoom, collapse, hover, the bar in focus — and asks its parent to open the
// waterfall. The timeline never writes; onOpen is the only callback.
export function GanttChart({ rows = [], planName = null, version = null, hasDeclaredOrder = null, edgeCounts = null, durationMix = null, onOpen, today, initialCollapsed }) {
  const [zoom, setZoom] = useState(() => {
    try { const z = localStorage.getItem(ZOOM_KEY); return ZOOMS.some((x) => x.key === z) ? z : ZOOMS[1].key; }
    catch { return ZOOMS[1].key; }
  });
  // `initialCollapsed` is a TESTABILITY hook: the render tests collapse a parent and assert the
  // re-anchored arrows. Production passes nothing; the collapse state is user-driven from then on.
  const [collapsed, setCollapsed] = useState(() => new Set(initialCollapsed || []));
  const [focus, setFocus] = useState(null);       // the row a human is pointing at
  const [tip, setTip] = useState(null);           // { row, x, y }
  const scroller = useRef(null);
  const centred = useRef(false);

  useEffect(() => { try { localStorage.setItem(ZOOM_KEY, zoom); } catch { /* private mode */ } }, [zoom]);

  const px = zoomOf(zoom).px;
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

  // A row is hidden when ANY ancestor is collapsed — the tree can nest to any depth.
  const visible = useMemo(() => rows.filter((r) => {
    let p = r.parent_id;
    while (p) { if (collapsed.has(p)) return false; p = byId.get(p)?.parent_id || null; }
    return true;
  }), [rows, collapsed, byId]);
  const visibleIds = useMemo(() => new Set(visible.map((r) => r.id)), [visible]);

  // A row is "dated" when it has a PLANNED, ACTUAL or WAITING bar — the whole point of the
  // actual/waiting layers is that a schedule with no plan dates still gets a window.
  const dated = useMemo(() => rows.filter((r) =>
    r.planned_start || r.planned_end || r.actual_start || r.actual_end
    || r.waiting_start || r.waiting_end), [rows]);

  const win = useMemo(() => windowFor(
    dated.flatMap((r) => [pDay(r.planned_start), pDay(r.planned_end),
                           pDay(r.actual_start), pDay(r.actual_end),
                           pDay(r.waiting_start), pDay(r.waiting_end)]),
    { today: t0, zoom },
  ), [dated, t0, zoom]);
  const axis = useMemo(() => bands(win.start, win.end, zoom, px), [win, zoom, px]);
  const width = axis.width;
  const todayX = diffDays(win.start, t0) >= 0 && diffDays(t0, win.end) > 0 ? xOf(t0, win.start, px) : null;

  // Geometry, once per render: where every visible row's PLANNED bar sits. The actual and
  // waiting bars share the same coordinate space and never disagree about "today".
  const geom = useMemo(() => {
    const m = new Map();
    visible.forEach((r, i) => {
      const span = clampSpan(barSpan(pDay(r.planned_start), pDay(r.planned_end), win.start, px), width);
      m.set(r.id, { i, top: i * ROW, span });
    });
    return m;
  }, [visible, win, px, width]);
  const actualGeom = useMemo(() => {
    const m = new Map();
    visible.forEach((r, i) => {
      const span = clampSpan(barSpan(pDay(r.actual_start), pDay(r.actual_end), win.start, px), width);
      m.set(r.id, { i, top: i * ROW, span });
    });
    return m;
  }, [visible, win, px, width]);
  const waitingGeom = useMemo(() => {
    const m = new Map();
    visible.forEach((r, i) => {
      const span = clampSpan(barSpan(pDay(r.waiting_start), pDay(r.waiting_end), win.start, px), width);
      m.set(r.id, { i, top: i * ROW, span });
    });
    return m;
  }, [visible, win, px, width]);

  // Park the viewport on today the first time there is something to look at.
  useEffect(() => {
    const el = scroller.current;
    if (!el || todayX === null) return;
    if (centred.current === zoom) return;
    centred.current = zoom;
    el.scrollLeft = Math.max(0, todayX - Math.max(120, (el.clientWidth - LEFT) / 3));
  }, [todayX, zoom]);

  const toggle = (id) => setCollapsed((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });

  // RE-ANCHORING (the stage-6 edge rule): an edge endpoint that is hidden by a collapsed
  // parent is drawn from/onto the nearest VISIBLE ancestor's bar. Walk the parent chain; the
  // first visible row wins. Returns null only when the whole chain is somehow hidden, which
  // cannot happen for the successor side (it is visible by construction) but can for a dep
  // pointing outside the current scope.
  const visibleAnchor = useCallback((id) => {
    let cur = byId.get(id);
    const seen = new Set();
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      if (visibleIds.has(cur.id)) return cur.id;
      cur = byId.get(cur.parent_id);
    }
    return null;
  }, [byId, visibleIds]);

  // A dependency whose anchored predecessor has no bar cannot be drawn — and silence reads as
  // "that dependency was deleted". So every undrawable edge is collected WITH ITS REASON.
  // deps are now { id, origin } — a sequence-origin predecessor is board order (drawn as a
  // dashed arrow with no arrowhead), a dependency-origin one is a declared chain.
  const hiddenDeps = useMemo(() => {
    const m = new Map();
    for (const r of visible) {
      const miss = [];
      for (const dep of r.deps || []) {
        const depId = typeof dep === 'string' ? dep : dep.id;   // legacy fixture: a bare id = a real dep
        const anchor = visibleAnchor(depId);
        if (!anchor || anchor === r.id) continue;
        if (geom.get(anchor)?.span) continue;
        const known = byId.get(depId);
        miss.push({
          id: anchor, title: known?.name || null,
          why: !known ? 'outside the plan you are looking at'
            : (!geom.get(anchor)?.span ? 'has no planned dates to draw an arrow from' : 'inside a collapsed parent'),
        });
      }
      if (miss.length) m.set(r.id, miss);
    }
    return m;
  }, [visible, geom, byId, visibleAnchor]);

  const arrows = useMemo(() => {
    const out = [];
    const seen = new Set();
    for (const r of visible) {
      const to = geom.get(r.id);
      if (!to?.span) continue;
      for (const dep of r.deps || []) {
        const depId = typeof dep === 'string' ? dep : dep.id;   // legacy fixture: a bare id = a real dep
        const origin = typeof dep === 'string' ? 'dependency' : dep.origin;
        const fromId = visibleAnchor(depId);
        if (!fromId || fromId === r.id) continue;
        const from = geom.get(fromId);
        if (!from?.span) continue;
        const key = `${fromId}->${r.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ key, itemId: r.id, depId: fromId, origin, from, to, dep: byId.get(fromId), row: r });
      }
    }
    return out;
  }, [visible, geom, byId, visibleAnchor]);

  const rowsH = Math.max(ROW, visible.length * ROW);
  const empty = !rows.length;
  const nothingDated = !empty && !dated.length;
  // ORDER HONESTY — the CPM schedules whatever edges it has, and the union graph includes
  // sequence-origin edges (sibling board position) as finish→start. Whether those are the ONLY
  // edges, or a minority next to real chains, is a claim the chart must label, not hide:
  //   • hasDeclaredOrder — at least one 'dependency'-origin edge exists (a real zee-dep chain);
  //   • edgeCounts — the ratio, driven into the plan banner ("322 of 322 scheduling edges are
  //     inferred from board order; no dependencies have been declared, so this critical path
  //     reflects list position, not constraints").
  const noDeclaredOrder = hasDeclaredOrder === false;
  const ec = edgeCounts || null;
  // The critical-path smell: how many atoms are critical, for the banner that flags a mostly
  // synthesised order. "100% critical" is a tell — a real plan essentially never looks like that.
  const allAtoms = rows.filter((r) => r.is_atom).length;
  const critPct = allAtoms ? Math.round((rows.filter((r) => r.is_atom && r.critical).length / allAtoms) * 100) : 0;
  const inferredOrderBanner = ec && ec.sequence > 0
    ? `${ec.sequence} of ${ec.total} scheduling edge${ec.total === 1 ? '' : 's'} ${ec.sequence === 1 ? 'is' : 'are'} `
      + `inferred from board order; ${ec.dependency === 0
        ? 'no dependencies have been declared, so this critical path reflects list position, not constraints'
        : `${ec.dependency} declared chain${ec.dependency === 1 ? '' : 's'} — only those are real constraints`}.`
    : null;

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
        {planName && <span className="work-gcount">{planName}{version != null ? ` v${version}` : ''}</span>}
        <span className="work-ghint">planned from CPM · actual from executions · waiting from gate leases — click a bar for the waterfall</span>
      </div>

      {empty && (
        <div className="work-gempty">
          <b>No workflow plan for this project yet.</b>
          <span>Break a goal into a plan (plan → plan_version → work_node) and the timeline draws
                it from the CPM pass — planned vs actual vs waiting per bar.</span>
        </div>
      )}
      {nothingDated && (
        <div className="work-gempty">
          <b>No dated work yet.</b>
          <span>Nothing here has a plan, an execution or a held lease, so there is nothing to place
                on a timeline.</span>
        </div>
      )}
      {inferredOrderBanner && !empty && !nothingDated && (
        <div className="work-warn work-gorder" role="status">
          <b>Order is inferred.</b>
          <span>{inferredOrderBanner} Declare a real “after” with <code>zee dep</code> (or the
                card’s “depends on” picker) and the chart will draw it as a chain.</span>
        </div>
      )}
      {/* DURATION MIX — ALWAYS surfaced (never gated on a threshold), so a reader never has to
          know a threshold exists to find out what they are looking at. The loud banner is for the
          high-default case; the plain line is for every plan. */}
      {durationMix && durationMix.atoms > 0 && !empty && !nothingDated && (
        <div className={`work-warn work-gorder${durationMix.on_default > 50 ? '' : ' quiet'}`} role="status">
          <b>{durationMix.on_default > 50 ? 'Mostly default durations.' : 'Duration mix.'}</b>
          <span>
            {durationMix.estimate} estimated · {durationMix.actual} measured · {durationMix.default} on
            the 1-day default, of {durationMix.atoms} bars ({durationMix.on_default}% default).
            {durationMix.on_default > 50
              ? ' The default bars are placeholders, not facts — the tooltip on each names which.'
              : ' A default bar is a placeholder, not a fact — the tooltip names it.'}
          </span>
        </div>
      )}
      {/* THE CRITICAL PATH ITSELF — qualified when the ORDER is synthesised. omnibiz is 362/362
          critical: that is an EDGE artefact (a pure board-sort synthesised chain), not a duration
          one, and it must not present as a real finding. When most edges are inferred, the
          critical path is a smell, not a result. */}
      {ec && ec.total > 0 && ec.sequence > 0 && ec.sequence / ec.total > 0.5 && !empty && !nothingDated && (
        <div className="work-warn work-gorder" role="status">
          <b>Critical path is not meaningful.</b>
          <span>Most ({ec.sequence} of {ec.total}) scheduling edges are inferred from board order,
                so the critical path reflects list position, not constraints — {critPct}% of {allAtoms} atoms
                critical is a smell, not a result.</span>
        </div>
      )}

      {win.clamped && (
        <div className="work-warn work-gclamp" role="status">
          ⚠ these dates span {win.clamped.requested.toLocaleString()} days
          (≈{Math.max(1, Math.round(win.clamped.requested / 365.25)).toLocaleString()} years) — far more
          than a timeline can draw, so this window shows {win.clamped.shown.toLocaleString()} days
          from {win.clamped.from} to {win.clamped.to}. That is almost always a mistyped year or a
          waiting lease in the far future — open the row and check it.
        </div>
      )}
      {!empty && !nothingDated && (
        <div className="work-gscroll" ref={scroller}>
          <div className="work-gsheet" style={{ width: LEFT + width }}>
            <div className="work-ghead" style={{ height: ROW + 18 }}>
              <div className="work-ghead-n" style={{ width: LEFT }}>
                <span className="work-glbl">work node</span>
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
                const summary = kids.length > 0 && !r.is_atom;
                const span = g?.span;
                const actualSpan = actualGeom.get(r.id)?.span || null;
                const waitingSpan = waitingGeom.get(r.id)?.span || null;
                const hot = focus === r.id;
                return (
                  <div key={r.id} className={`work-grow${hot ? ' hot' : ''}`} style={{ height: ROW }}
                       onMouseEnter={() => setFocus(r.id)} onMouseLeave={() => setFocus((f) => (f === r.id ? null : f))}>
                    <div className="work-gname" style={{ width: LEFT, paddingLeft: 6 + (Number(r.depth) || 0) * 13 }}>
                      <button className={`work-chev${kids.length ? '' : ' none'}`} tabIndex={-1}
                              title={kids.length ? 'collapse / expand this subtree' : ''}
                              onClick={() => kids.length && toggle(r.id)}>
                        {kids.length ? (collapsed.has(r.id) ? '▸' : '▾') : '·'}
                      </button>
                      <KindGlyph kind={r.kind} />
                      <button className="work-gtitle" title={`${r.name} — click to open the waterfall`}
                              onClick={() => onOpen?.(r)}>{r.name}</button>
                      {hasDeclaredOrder !== false && r.critical &&
                        <span className="work-gcrit" title="on the critical path (zero slack)">crit</span>}
                    </div>
                    <div className="work-gtrack" style={{ width }}>
                      {span && (
                        <div className={`${summary ? 'work-gsum' : 'work-gbar'}${r.critical && !noDeclaredOrder ? ' crit' : ''}${hot ? ' hot' : ''}`
                                        + `${span.inverted ? ' inverted' : ''}`}
                             data-gbar={r.id} data-testid="work-gbar"
                             style={{ left: span.x, width: span.w }}
                             onClick={() => onOpen?.(r)}
                             onMouseEnter={(e) => setTip({ row: r, x: e.clientX, y: e.clientY })}
                             onMouseLeave={() => setTip(null)}>
                          <span className="work-gfill-bg" />
                          {summary && <><i className="work-gcap l" /><i className="work-gcap r" /></>}
                          {span.open && <i className="work-gopen" title="no planned end — this end is open" />}
                          {span.cutLeft && <i className="work-gcut l" title="it starts before this window" />}
                          {span.cutRight && <i className="work-gcut r" title="it continues past this window" />}
                        </div>
                      )}
                      {/* ACTUAL — what the record PROVES happened, read-only. */}
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
                      {/* WAITING — a held lease on a waiting execution (the gate wait). */}
                      {waitingSpan && (
                        <div className="work-gbar waiting" data-testid="work-gbar-waiting"
                             style={{ left: waitingSpan.x, width: waitingSpan.w }}
                             onMouseEnter={(e) => setTip({ row: r, x: e.clientX, y: e.clientY })}
                             onMouseLeave={() => setTip(null)}>
                          <span className="work-gfill-bg waiting" />
                          {waitingSpan.open && <i className="work-gopen" title="waiting without an expiry" />}
                          {waitingSpan.cutLeft && <i className="work-gcut l" title="the wait started before this window" />}
                          {waitingSpan.cutRight && <i className="work-gcut r" title="the wait continues past this window" />}
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

              {/* DEPENDENCIES — re-anchored onto the nearest visible ancestor's bar, routed through
                  the gap above the successor row so a line never lies on top of a bar. */}
              <svg className="work-garrows" style={{ left: LEFT, width, height: rowsH }} width={width} height={rowsH}>
                <defs>
                  <marker id="work-garrowhead" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
                    <path d="M0,0 L7,3.5 L0,7 z" fill="currentColor" />
                  </marker>
                </defs>
                {arrows.map((a) => {
                  const on = focus === a.itemId || focus === a.depId;
                  const d = arrowPath(a.from, a.to);
                  // A SEQUENCE-origin edge is board position, not a declared chain — drawn as a
                  // muted board-order line with NO arrowhead. A DEPENDENCY-origin edge is a real
                  // "after" — the arrowhead stays. The two are never visually the same.
                  const seq = a.origin === 'sequence';
                  return (
                    <g key={a.key} className={`work-garrow${on ? ' on' : ''}${seq ? ' seq' : ''}`}>
                      <path d={d} className="work-garrow-line" markerEnd={seq ? undefined : 'url(#work-garrowhead)'} />
                      <title>{seq
                        ? `${a.row?.name} is ordered after ${a.dep?.name || 'another node'} — order inferred from board position (sort_order), not a declared dependency`
                        : `${a.row?.name} depends on ${a.dep?.name || 'another node'}`}</title>
                    </g>
                  );
                })}
              </svg>
            </div>
          </div>
        </div>
      )}

      {tip && !focus && <Tip row={tip.row} x={tip.x} y={tip.y} />}
    </div>
  );
}

// ── the pieces ──────────────────────────────────────────────────────────────────────────────────

// WHAT A BAR'S DURATION MEANS (migration 194) — the tooltip names the SOURCE so a 1-day bar
// that is a DEFAULT is never mistaken for a 1-day ESTIMATE. estimate → measured actual from
// closed executions → the stated 1-day default. Containers roll up from children.
export const DURATION_SOURCE = {
  estimate: 'estimated',
  actual: 'measured from executions',
  default: '1-day default (no estimate)',
  rollup: 'rollup of children',
};

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

// The tooltip — what the bar is, WHEN each layer is, and whether it is on the critical path.
export function Tip({ row, x, y }) {
  const p = (d) => (d ? d.slice(0, 16).replace('T', ' ') : null);
  return (
    <div className="work-gtip" style={{ left: Math.min(x + 14, viewportW() - 290), top: y + 16 }}>
      <div className="work-gtip-t"><KindGlyph kind={row.kind} /> {row.name}</div>
      {row.critical &&
        <div className="work-gtip-r crit">on the critical path{row.slack ? '' : ' · zero slack'}</div>}
      <div className="work-gtip-r">
        <span>planned</span>
        <span>{p(row.planned_start)} → {p(row.planned_end) || '…'}</span>
      </div>
      {row.duration_source && (
        <div className={`work-gtip-r dur ${row.duration_source}`}>
          <span>duration</span>
          <span>{DURATION_SOURCE[row.duration_source] || row.duration_source}</span>
        </div>
      )}
      {row.slack != null && <div className="work-gtip-r"><span>slack</span><span>{row.slack}</span></div>}
      {!!row.actual_start && (
        <div className="work-gtip-r actual">
          <span>actual</span>
          <span>{p(row.actual_start)} → {row.actual_end ? p(row.actual_end) : '… · in flight'}</span>
        </div>
      )}
      {!!row.waiting_start && (
        <div className="work-gtip-r waiting">
          <span>waiting</span>
          <span>{p(row.waiting_start)} → {row.waiting_end ? p(row.waiting_end) : '…'}</span>
        </div>
      )}
      {(row.executions || []).length > 0 && (
        <div className="work-gtip-d">{row.executions.length} execution(s) — click the bar for the waterfall</div>
      )}
    </div>
  );
}

// What an undrawable dependency says for itself. Named once so the marker and the tooltip cannot
// describe the same edge two different ways.
export function hiddenTitle(miss) {
  const list = (miss || []).map((m) => `“${m.title || 'a node'}” (${m.why})`);
  if (!list.length) return '';
  return `waits for ${list.length} node(s) this chart cannot draw: ${list.join(', ')}`;
}

// ── the weld waterfall ──────────────────────────────────────────────────────────────────────────
// Clicking a bar opens THIS: the row's execution → turn → gateway drill-down, the same nested
// shape the observability read model serves. READ-ONLY — every row here is a byproduct of a door.
export function WeldWaterfall({ row, onClose }) {
  const execs = row.executions || [];
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const p = (d) => (d ? d.slice(0, 16).replace('T', ' ') : null);
  return (
    <div className="dlg-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
      <div className="work-waterfall">
        <header className="work-wf-h">
          <span className="work-wf-t"><KindGlyph kind={row.kind} /> {row.name}</span>
          <button className="work-x" onClick={onClose} title="close (Esc)">✕</button>
        </header>
        <div className="work-wf-meta">
          {row.critical && <span className="work-wf-crit">critical path</span>}
          {row.slack != null && <span>slack {row.slack}</span>}
          {row.planned_start && <span>planned {p(row.planned_start)} → {p(row.planned_end)}</span>}
        </div>
        {!execs.length && <div className="work-empty">no executions for this node yet</div>}
        {execs.map((ex) => (
          <div key={ex.id} className="work-wf-exec">
            <div className="work-wf-exec-h">
              <span className={`work-wf-state st-${ex.state}`}>{ex.state}</span>
              <span>{ex.entity_name || 'no entity'}</span>
              {ex.started_at && <span>{p(ex.started_at)}</span>}
              {ex.finished_at && <span>→ {p(ex.finished_at)}</span>}
              {!ex.finished_at && <span>…</span>}
            </div>
            {(ex.turns || []).map((t) => (
              <div key={t.id} className="work-wf-turn">
                <div className="work-wf-turn-h">
                  <span>{t.kind} turn</span>
                  <span className={`work-wf-state st-${t.status}`}>{t.status}</span>
                  {t.model && <span>{t.model}</span>}
                  {t.zee_name && <span>{t.zee_name}</span>}
                  {t.started_at && <span>{p(t.started_at)}</span>}
                  {t.ended_at && <span>→ {p(t.ended_at)}</span>}
                </div>
                {(t.gateway_requests || []).map((g) => (
                  <div key={g.id} className="work-wf-gw">
                    <span className={`work-wf-state st-gw-${g.status >= 200 && g.status < 300 ? 'ok' : 'err'}`}>{g.status}</span>
                    <span>{g.provider} {g.model}</span>
                    <span>{g.method} {g.path}</span>
                    <span>{(Number(g.input_tokens) || 0) + (Number(g.output_tokens) || 0)} tok</span>
                    {g.cost_usd != null && <span>${Number(g.cost_usd).toFixed(4)}</span>}
                    {g.duration_ms != null && <span>{Math.round(Number(g.duration_ms))}ms</span>}
                  </div>
                ))}
                {!(t.gateway_requests || []).length && <div className="work-wf-none">no gateway calls recorded</div>}
              </div>
            ))}
            {!(ex.turns || []).length && <div className="work-wf-none">no turns recorded</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── helpers ─────────────────────────────────────────────────────────────────────────────────────
// An ISO timestamp → the LOCAL calendar day the bar sits on. dayKey() normalises the same way
// the gantt has always normalised date-only columns; a timestamp is an instant, and its day is
// where the bar belongs.
const pDay = (iso) => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : startOfDay(d);
};
const viewportW = () => (typeof window === 'undefined' ? 1200 : window.innerWidth);

function scrollToToday(scroller, todayX) {
  const el = scroller.current;
  if (!el || todayX === null) return;
  el.scrollLeft = Math.max(0, todayX - Math.max(120, (el.clientWidth - LEFT) / 3));
}
