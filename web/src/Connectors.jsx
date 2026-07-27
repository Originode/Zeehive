import React, { useState, useCallback, useLayoutEffect, useEffect, useReducer } from 'react';
import { buildHexGraph, shortestPath, nearestVertex, nearestNode, latticeCells, assignLanes, offsetPolyline } from './hive/maze.js';

const LANE_PITCH = 5;   // px between parallel channels sharing a corridor

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
export default function Connectors({ timeline, layoutRef, version, hexPosRef, harnessPosRef, orientation, honeySide, expandedId, prodIds = [], subscribeGeom, hoverRef, subscribeHover }) {
  const [paths, setPaths] = useState([]);
  const [harnessNodes, setHarnessNodes] = useState([]);   // avatar badges + their inbound wire
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
    // route WIRES: each consumer's wire runs IN SERIES through the harness cell, and the harness's own
    // inbound wire runs from its commit dot in the graph to the cell. Anchored to the grid, not a
    // floating junction — so it stays "as if it were a xell in the grid".
    const harnessPos = (harnessPosRef && harnessPosRef.current) || {};
    const consumerHarness = new Map();     // consumer xellId → harness node
    const hNodes = [];
    for (const h of (timeline.harnesses || [])) {
      const hp = harnessPos[h.id];
      if (!hp) continue;                   // HiveCanvas hasn't published this harness's cell yet
      const hx = hp.x - cr.left, hy = hp.y - cr.top;   // cont-relative, like the dots/hexes
      const hd = cont.querySelector(`[data-commit="${h.base_commit}"][data-dot]`);
      let inbound = null;
      if (hd) { const n = hd.getBoundingClientRect(); inbound = { x: (n.left + n.right) / 2 - cr.left, y: (n.top + n.bottom) / 2 - cr.top }; }
      const node = { id: h.id, color: h.color, x: hx, y: hy, inbound, consumer_ids: h.consumer_ids || [] };
      hNodes.push(node);
      for (const id of h.consumer_ids || []) consumerHarness.set(id, node);
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

    // Each harness's INBOUND wire (its commit dot → its cell) threads the same corridor maze as every
    // other wire, so it reads as one of the family. Compute its lattice path now that the graph exists.
    for (const node of hNodes) {
      if (!node.inbound) { node.inboundD = null; continue; }
      const entry = nearestNode(graph, node.inbound.x, node.inbound.y);
      const midKey = nearestNode(graph, node.x, node.y);
      const pts = (entry && midKey) ? shortestPath(graph, entry, midKey) : null;
      const poly = (pts && pts.length > 1)
        ? [[node.inbound.x, node.inbound.y], ...pts.map((p) => [p.x, p.y]), [node.x, node.y]]
        : [[node.inbound.x, node.inbound.y], [node.x, node.y]];   // fallback: straight if no maze path
      node.inboundD = 'M ' + poly.map((p) => `${f1(p[0])} ${f1(p[1])}`).join(' L ');
    }

    // pass 1: pathfind every wire (prod included) through the corridor maze. A harnessed consumer's
    // wire is forced THROUGH its harness cell — two maze legs (dot→cell, cell→hex) spliced — so it
    // still threads corridors like the rest instead of cutting a straight line across the honeycomb.
    const routed = [];
    for (const dd of dots) {
      const verts = graph.vertsById.get(dd.id);
      if (!verts) continue;
      const target = nearestVertex(verts, dd.dx, dd.dy);   // hex vertex nearest the commit head
      const entryKey = nearestNode(graph, dd.dx, dd.dy);
      const hn = consumerHarness.get(dd.id);
      let path = entryKey ? shortestPath(graph, entryKey, target.key) : null;
      if (hn && entryKey) {
        const midKey = nearestNode(graph, hn.x, hn.y);
        const l1 = shortestPath(graph, entryKey, midKey);
        const l2 = shortestPath(graph, midKey, target.key);
        if (l1 && l2 && l1.length && l2.length) path = [...l1, ...l2.slice(1)];   // splice at the cell
      }
      routed.push({ id: dd.id, color: dd.color, dot: dd, target, pts: path });
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
    setHarnessNodes(hNodes);
  }, [timeline, layoutRef, hexPosRef, orientation, honeySide, expandedId, prodIds.join(',')]);   // eslint-disable-line react-hooks/exhaustive-deps

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

  const hov = hoverRef ? hoverRef.current : { id: null, commit: null };
  const hoverActive = !!(hov.id || hov.commit);
  // which xell(s) are focused (hovered/expanded) → a harness inbound wire lights up when a focused
  // xell wears it, and dims with the rest otherwise (mirrors the badge dim/highlight on the canvas).
  const focusedX = new Set();
  if (expandedId) focusedX.add(expandedId);
  if (hov.id) focusedX.add(hov.id);
  if (hov.commit) for (const t of (timeline?.xells || [])) if (t.base_commit === hov.commit) focusedX.add(t.id);
  const anyFocus = focusedX.size > 0;
  const isHov = (p) => p.id === hov.id || (!!hov.commit && p.base === hov.commit);

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
        const opacity = p.dim ? 0.12 : (hoverActive ? (hovered ? 1 : 0.1) : 0.92);
        return (
        <g key={p.id} opacity={opacity}>
          <path d={p.d} fill="none" stroke={p.color} strokeWidth={hovered ? 3.2 : 2}
                strokeLinejoin="round" strokeLinecap="round" />
          <circle cx={p.x1} cy={p.y1} r={hovered ? 4 : 3} fill={p.color} />
          <rect x={p.x2 - 3.5} y={p.y2 - 3.5} width="7" height="7" rx="1.5"
                fill={p.color} stroke="var(--bg)" strokeWidth="1.5" />
        </g>
        );
      })}
      {/* HARNESS inbound wires — the dashed trace from each harness's own commit dot in the graph to
          its cell in the honeycomb (the trace goes to the harness FIRST, then the consumer wires above
          route through that same cell to the xells). The avatar badge itself is drawn on the canvas
          at the cell centre (HiveCanvas), so here we draw only the wire. */}
      {harnessNodes.map((h) => {
        if (!h.inboundD) return null;
        const hi = (h.consumer_ids || []).some((id) => focusedX.has(id));
        const opacity = anyFocus ? (hi ? 0.95 : 0.1) : 0.85;
        return (
          <path key={`h-${h.id}`} d={h.inboundD}
                fill="none" stroke={h.color} strokeWidth={hi ? 2.6 : 1.8} strokeDasharray="4 3" opacity={opacity}
                strokeLinejoin="round" strokeLinecap="round" />
        );
      })}
    </svg>
  );
}
