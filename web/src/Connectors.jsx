import React, { useState, useCallback, useLayoutEffect, useEffect, useReducer } from 'react';
import { buildHexGraph, shortestPath, nearestVertex, nearestNode, latticeCells, assignLanes, offsetPolyline } from './hive/maze.js';
import { crewLinks, relatedTo, focusIdOf, hexDim, REL_DASH_ATTR } from './hive/crew.js';

const LANE_PITCH = 5;   // px between parallel channels sharing a corridor

// ── how a wire reads: focus / RELATED / receded / plain ───────────────────────
// The honeycomb marks a manager's live crew (#24); this is the same mark one layer out. A crew
// member's trace must stay VISIBLE while its manager is hovered — a group that keeps its cells and
// loses its traces makes the view contradict itself in the one interaction the feature exists for —
// and it must not read as the FOCUS's own wire any more than a marked hex reads as selected. So:
//
//   related    → nearly full, ordinary width, DASHED — the same dash as the hexagon's tie-ring and
//                the graph's anchor ring, so all three layers teach one idea
//   the focus  → full opacity, THICK, solid   (unchanged: this is the thing you pointed at)
//   receded    → faded (0.1, or 0.12 behind an open bloom), as before
//
// The hover rung sits ABOVE the bloom's 0.12: a hexagon the pointer is on lights up (see hive/crew.js
// hexDim — a hovered hex is never dimmed, even while another xell's flower is open), so its WIRE must
// light up with it or the three layers contradict each other — the hex says "look at me" and the trace
// to its commit says "no". The bloom still recedes everything the pointer is NOT on; it only yields to
// the thing being pointed at. Only "related" sits higher, because a manager whose flower is open is
// exactly when a human is asking "which of these are yours?".
// Pure, so what a human ends up seeing is asserted as data rather than grepped for.
export function wireStyle({ hovered = false, related = null, dim = false, bloomDim = false } = {}) {
  if (related) return { opacity: 0.85, width: 2, dash: REL_DASH_ATTR };
  if (hovered) return { opacity: 1, width: 3.2, dash: null };
  if (bloomDim) return { opacity: 0.12, width: 2, dash: null };
  if (dim) return { opacity: 0.1, width: 2, dash: null };
  return { opacity: 0.92, width: 2, dash: null };
}

// One trace: the corridor path, its commit-dot end and its hexagon end. Exported so a test can render
// the REAL element and read what it emitted (the SVG counterpart of painting into a recording 2D
// context) instead of trusting the source to mean what it says.
export function Wire({ p, hovered = false, related = null, dim = false }) {
  const st = wireStyle({ hovered, related, dim, bloomDim: p.dim });
  return (
    <g opacity={st.opacity} data-wire={p.id} data-rel={related || undefined}>
      <path d={p.d} fill="none" stroke={p.color} strokeWidth={st.width} strokeDasharray={st.dash || undefined}
            strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={p.x1} cy={p.y1} r={hovered ? 4 : 3} fill={p.color} />
      <rect x={p.x2 - 3.5} y={p.y2 - 3.5} width="7" height="7" rx="1.5"
            fill={p.color} stroke="var(--bg)" strokeWidth="1.5" />
    </g>
  );
}

// SVG overlay spanning the whole hive-split. For each xell it draws a colored wire from the xell's
// commit dot in the centre <GraphPane> (the point in history it sits at) to that xell's hexagon in
// the honeycomb canvas. The dot is measured live from the DOM (data-commit, which already reflects
// the graph's scroll transform); the hex centre comes from HiveCanvas via `hexPosRef`.
//
//   • production: a single STRAIGHT wire — the graph scroll-tracks the prod hexes (median) so each
//     prod dot stays across from its hexagon, keeping this perpendicular. It ends at the prod hex's
//     vertex nearest the dot.
//   • everyone else: the wire threads the honeycomb like a MAZE — it hops from the dot across the
//     open gap to the nearest lattice vertex, then pathfinds along hex EDGES to the target hex's
//     vertex nearest the dot, so it never crosses a hexagon and every segment runs along a hex side.
export default function Connectors({ timeline, xells = [], layoutRef, version, hexPosRef, harnessPosRef, orientation, honeySide, expandedId, prodIds = [], subscribeGeom, hoverRef, subscribeHover, showHarness = true }) {
  const [paths, setPaths] = useState([]);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [, forceHover] = useReducer((x) => x + 1, 0);
  useEffect(() => (subscribeHover ? subscribeHover(forceHover) : undefined), [subscribeHover]);

  const measure = useCallback(() => {
    const cont = layoutRef.current;
    if (!cont || !timeline) { setPaths([]); return; }
    const cr = cont.getBoundingClientRect();
    setSize({ w: cont.clientWidth, h: cont.clientHeight });

    const hexPos = (hexPosRef && hexPosRef.current) || {};
    const portrait = orientation === 'portrait';
    const f1 = (n) => n.toFixed(1);

    // real hexes (cont-relative). `size` is the full CELL radius — the routing lattice is gapless and
    // connected even though the drawn hexes are shrunk, so wires run in the corridors between them.
    const realHexes = Object.entries(hexPos).map(([id, hp]) => ({ id, cx: hp.x - cr.left, cy: hp.y - cr.top, size: hp.size || 20 }));
    if (!realHexes.length) { setPaths([]); return; }
    const cellSize = realHexes[0].size;

    // pre-measure the commit dots so the virtual lattice can span from the graph out to the honeycomb
    const dots = [];
    for (const x of (timeline.xells || [])) {
      const dot = cont.querySelector(`[data-commit="${x.base_commit}"][data-dot]`);
      if (!dot || !hexPos[x.id]) continue;
      const n = dot.getBoundingClientRect();
      dots.push({ id: x.id, base: x.base_commit, color: x.color,
        dx: (n.left + n.right) / 2 - cr.left, dy: (n.top + n.bottom) / 2 - cr.top });
    }

    // forward = from the spine toward the honeycomb; wires must never route backward (past the dots
    // away from the honeycomb). Work on the perpendicular-to-spine axis.
    const perpOf = (px, py) => (portrait ? py : px);
    const mean = (a) => a.reduce((s, v) => s + v, 0) / (a.length || 1);
    const dotPerps = dots.map((d) => perpOf(d.dx, d.dy));
    const fwd = Math.sign(mean(realHexes.map((h) => perpOf(h.cx, h.cy))) - mean(dotPerps)) || -1;
    const spine = fwd < 0 ? Math.max(...dotPerps) : Math.min(...dotPerps);   // backward-most dot line
    // keep a virtual cell only if its whole footprint clears the spine (its backward-most vertex,
    // ≈cellSize from the centre, is still forward) — so no lattice vertex ever sits behind the dots.
    const forward = (cx, cy) => (perpOf(cx, cy) - spine) * fwd >= cellSize;

    // HARNESS NODES (docs §5): each harness occupies its own honeycomb CELL (published by HiveCanvas
    // in harnessPosRef — the badge is drawn on the canvas there, at the hex centre). Here we only
    // record each cell centre so a consumer's wire can be routed IN SERIES through it: the trace is
    // ONE continuous line commit-dot → harness hexagon → xell. There is no separate harness inbound
    // wire — that used to draw a SECOND trace to the same junction; the through-routing IS the inbound.
    // HARNESS NODES are built ONLY when the show-harness toggle is on. Hidden, the consumerHarness map
    // stays empty and every wire traces straight from its commit dot to its xell — the "no harness in
    // the picture" route. (HiveCanvas also publishes an empty harnessPosRef, but this guard is the
    // source of truth: even a stale ref from a prior draw cannot route through a harness that isn't shown.)
    const harnessPos = (harnessPosRef && harnessPosRef.current) || {};
    const consumerHarness = new Map();     // consumer xellId → harness cell centre {x,y}
    if (showHarness) {
      for (const h of (timeline.harnesses || [])) {
        const hp = harnessPos[h.id];
        if (!hp) continue;                 // HiveCanvas hasn't published this harness's cell yet
        const node = { id: h.id, color: h.color, x: hp.x - cr.left, y: hp.y - cr.top };
        // consumer_ids, NOT wearer_ids: a MANAGER wears a harness but is never routed through its cell
        // — its own hexagon is drawn as that persona, so its wire runs straight from the dot to it.
        for (const id of h.consumer_ids || []) consumerHarness.set(id, node);
      }
    }

    // "infinite maze": tile invisible cells across the dots→honeycomb bbox, but only on the honeycomb
    // side of the spine, so a wire threads corridors through the gap without ever going backward.
    const xs = realHexes.map((h) => h.cx).concat(dots.map((d) => d.dx));
    const ys = realHexes.map((h) => h.cy).concat(dots.map((d) => d.dy));
    const M = cellSize * 1.5;
    const bbox = { x0: Math.min(...xs) - M, y0: Math.min(...ys) - M, x1: Math.max(...xs) + M, y1: Math.max(...ys) + M };
    // ...and only inside the honeycomb PANE: a virtual cell is used only if its whole footprint fits
    // within it, so pathfinding never routes through cells clipped at the pane's top/bottom edges (nor
    // over the graph/panels). The perpendicular+90° lead-in bridges the gap from the dot to the pane.
    const honeyEl = cont.querySelector('.hive-pane.honey');
    let hb = null;
    if (honeyEl) { const h = honeyEl.getBoundingClientRect(); hb = { x0: h.left - cr.left, y0: h.top - cr.top, x1: h.right - cr.left, y1: h.bottom - cr.top }; }
    const insideHoney = (cx, cy) => !!hb && cx - cellSize >= hb.x0 && cx + cellSize <= hb.x1 && cy - cellSize >= hb.y0 && cy + cellSize <= hb.y1;
    const virtual = latticeCells(realHexes[0].cx, realHexes[0].cy, cellSize, bbox)
      .filter((c) => forward(c.cx, c.cy) && insideHoney(c.cx, c.cy));
    const graph = buildHexGraph(realHexes.concat(virtual));

    // pass 1: pathfind every wire (prod included) through the corridor maze. A harnessed consumer's
    // wire is forced THROUGH its harness cell — two maze legs (dot→cell, cell→hex) spliced — so it
    // reads as ONE continuous series: commit-dot → harness hexagon → xell (docs §5), instead of the
    // old pair of a xell wire plus a separate harness inbound wire.
    const routed = [];
    for (const dd of dots) {
      const verts = graph.vertsById.get(dd.id);
      if (!verts) continue;
      const target = nearestVertex(verts, dd.dx, dd.dy);   // hex vertex nearest the commit head
      const entryKey = nearestNode(graph, dd.dx, dd.dy);
      const hn = consumerHarness.get(dd.id);
      let path = entryKey ? shortestPath(graph, entryKey, target.key) : null;
      let harnessAt = null, harnessCenter = null;
      if (hn && entryKey) {
        const midKey = nearestNode(graph, hn.x, hn.y);
        const l1 = shortestPath(graph, entryKey, midKey);
        const l2 = shortestPath(graph, midKey, target.key);
        if (l1 && l2 && l1.length && l2.length) {
          path = [...l1, ...l2.slice(1)];   // splice at the cell
          harnessAt = l1.length - 1;        // index of the shared harness vertex in the joined path…
          harnessCenter = [hn.x, hn.y];     // …pinned to the badge centre so the trace runs THROUGH it
        }
      }
      routed.push({ id: dd.id, color: dd.color, dot: dd, target, pts: path, harnessAt, harnessCenter });
    }

    // pass 2: where wires share a corridor, split them into parallel channels
    const lanes = assignLanes(routed.filter((r) => r.pts && r.pts.length > 1), LANE_PITCH);

    const items = [];
    for (const r of routed) {
      const { dot: dd, target } = r;
      let d, ex = target.x, ey = target.y;
      // All wires — harnessed or not — render through the corridor maze. A harnessed consumer's
      // r.pts was already spliced through its harness cell in pass 1, so it threads the honeycomb
      // like the rest instead of a straight diagonal.
      if (r.pts && r.pts.length > 1) {
        const off = lanes.get(r.id) || r.pts.slice(1).map(() => [0, 0]);
        const maze = offsetPolyline(r.pts, off);           // channel-offset corridor path
        // pin the shared through-vertex to the harness badge CENTRE so every consumer's trace visibly
        // runs THROUGH the hexagon (and parallel consumers converge there — reading as one junction).
        // Interior vertices only — never move the entry lead-in or the xell endpoint.
        if (r.harnessAt != null && r.harnessCenter && r.harnessAt > 0 && r.harnessAt < maze.length - 1) {
          maze[r.harnessAt] = r.harnessCenter;
        }
        const e0 = maze[0];                                // offset entry point
        const corner = portrait ? [dd.dx, e0[1]] : [e0[0], dd.dy];  // ⟂ off the spine, then 90° turn
        const poly = [[dd.dx, dd.dy], corner, ...maze];
        d = 'M ' + poly.map((p) => `${f1(p[0])} ${f1(p[1])}`).join(' L ');
        ex = maze[maze.length - 1][0]; ey = maze[maze.length - 1][1];
      } else {
        d = `M ${f1(dd.dx)} ${f1(dd.dy)} L ${f1(ex)} ${f1(ey)}`;   // single-vertex / disconnected
      }
      items.push({ id: r.id, base: dd.base, color: r.color, d, x1: dd.dx, y1: dd.dy, x2: ex, y2: ey,
        dim: expandedId && expandedId !== r.id });
    }
    setPaths(items);
  }, [timeline, layoutRef, hexPosRef, orientation, honeySide, expandedId, prodIds.join(','), showHarness]);   // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => { measure(); }, [measure, version]);

  // re-route on every canvas frame (pan/zoom); nudge the next couple of frames to beat the mount race
  useEffect(() => {
    const off = subscribeGeom && subscribeGeom(measure);
    const r1 = requestAnimationFrame(() => measure());
    const r2 = requestAnimationFrame(() => requestAnimationFrame(() => measure()));
    return () => { off && off(); cancelAnimationFrame(r1); cancelAnimationFrame(r2); };
  }, [measure, subscribeGeom]);

  useEffect(() => {
    const on = () => measure();
    window.addEventListener('resize', on);
    window.addEventListener('scroll', on, true);
    const ro = new ResizeObserver(on);
    if (layoutRef.current) ro.observe(layoutRef.current);
    const t = setTimeout(on, 200);
    return () => {
      window.removeEventListener('resize', on);
      window.removeEventListener('scroll', on, true);
      ro.disconnect();
      clearTimeout(t);
    };
  }, [measure, layoutRef]);

  const hov = hoverRef ? hoverRef.current : { id: null, commit: null, harness: null };
  // hovering a harness badge focuses every xell that WEARS it — so their through-traces light up
  // together, the mirror of a xell hover lighting its harness. Wearers, not consumers: a manager
  // wears a harness without routing through its cell (its own hexagon IS that persona), and its wire
  // still belongs in the family the hover lights.
  const hovHarness = hov.harness ? (timeline?.harnesses || []).find((h) => h.id === hov.harness) : null;
  const hovConsumers = new Set(hovHarness?.wearer_ids || hovHarness?.consumer_ids || []);
  const hoverActive = !!(hov.id || hov.commit || hov.harness);
  const isHov = (p) => p.id === hov.id || (!!hov.commit && p.base === hov.commit) || hovConsumers.has(p.id);

  // THE CREW RELATION, one layer out (#25). Same helpers the honeycomb draws its hexes with, reading
  // the same fleet list — the grouping is never re-derived here, because the bug #24 fixed WAS a second
  // hand-rolled grouping that had drifted from the first. A reaped crew member is not in `related`, so
  // its trace recedes with every other stranger's.
  const related = relatedTo(xells, focusIdOf(hov, expandedId), crewLinks(xells));

  return (
    // zIndex:1 keeps the trace-line overlay a LOW decorative layer: above the honeycomb canvas
    // (which is z-auto inside the honey pane, so the wires still thread the cells) but beneath every
    // dialog and UI surface. Anything positioned (the in-honey terminal-choice/message-composer
    // overlays, all the fixed modals, panel chrome) therefore renders ON TOP of the wires, never
    // buried by them. Do NOT raise this above the dialog layer, and do NOT lift the honey PANE
    // above it — a pane-level z-index makes the pane a stacking context that covers the modals.
    <svg className="connectors" width={size.w} height={size.h}
         style={{ position: 'absolute', left: 0, top: 0, pointerEvents: 'none', zIndex: 1 }}>
      {paths.map((p) => {
        const hovered = isHov(p);
        const rel = related.get(p.id) || null;
        // the SAME dim rule the hexes use (hive/crew.js hexDim): the focus lights its own group and
        // the rest of the fleet recedes — a related trace is never the thing that recedes.
        const dim = hexDim({ hexId: p.id, expandedId, hovered, hoverActive, related: rel });
        return <Wire key={p.id} p={p} hovered={hovered} related={rel} dim={dim} />;
      })}
    </svg>
  );
}
