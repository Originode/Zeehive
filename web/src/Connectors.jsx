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
export default function Connectors({ timeline, layoutRef, version, hexPosRef, orientation, honeySide, expandedId, prodIds = [], subscribeGeom, hoverRef, subscribeHover }) {
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

    // "infinite maze": tile invisible cells across the dots→honeycomb bbox, but only on the honeycomb
    // side of the spine, so a wire threads corridors through the gap without ever going backward.
    const xs = realHexes.map((h) => h.cx).concat(dots.map((d) => d.dx));
    const ys = realHexes.map((h) => h.cy).concat(dots.map((d) => d.dy));
    const M = cellSize * 1.5;
    const bbox = { x0: Math.min(...xs) - M, y0: Math.min(...ys) - M, x1: Math.max(...xs) + M, y1: Math.max(...ys) + M };
    // ...and never over the graph pane itself (its lanes/hashes live there) — disregard cells whose
    // centre falls within it, so wires exit the graph perpendicular and only maze once past it.
    const gp = cont.querySelector('.graph-pane');
    let gb = null;
    if (gp) { const g = gp.getBoundingClientRect(); gb = { x0: g.left - cr.left, y0: g.top - cr.top, x1: g.right - cr.left, y1: g.bottom - cr.top }; }
    const overGraph = (cx, cy) => gb && cx >= gb.x0 && cx <= gb.x1 && cy >= gb.y0 && cy <= gb.y1;
    const virtual = latticeCells(realHexes[0].cx, realHexes[0].cy, cellSize, bbox)
      .filter((c) => forward(c.cx, c.cy) && !overGraph(c.cx, c.cy));
    const graph = buildHexGraph(realHexes.concat(virtual));

    // pass 1: pathfind every wire (prod included) through the corridor maze
    const routed = [];
    for (const dd of dots) {
      const verts = graph.vertsById.get(dd.id);
      if (!verts) continue;
      const target = nearestVertex(verts, dd.dx, dd.dy);   // hex vertex nearest the commit head
      const entryKey = nearestNode(graph, dd.dx, dd.dy);
      const path = entryKey ? shortestPath(graph, entryKey, target.key) : null;
      routed.push({ id: dd.id, color: dd.color, dot: dd, target, pts: path });
    }

    // pass 2: where wires share a corridor, split them into parallel channels
    const lanes = assignLanes(routed.filter((r) => r.pts && r.pts.length > 1), LANE_PITCH);

    const items = [];
    for (const r of routed) {
      const { dot: dd, target } = r;
      let d, ex = target.x, ey = target.y;
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
  const isHov = (p) => p.id === hov.id || (!!hov.commit && p.base === hov.commit);

  return (
    <svg className="connectors" width={size.w} height={size.h}
         style={{ position: 'absolute', left: 0, top: 0, pointerEvents: 'none', zIndex: 5 }}>
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
    </svg>
  );
}
