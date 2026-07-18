import React, { useState, useCallback, useLayoutEffect, useEffect } from 'react';
import { buildHexGraph, shortestPath, nearestVertex, nearestNode, latticeCells } from './hive/maze.js';

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
export default function Connectors({ timeline, layoutRef, version, hexPosRef, orientation, honeySide, expandedId, prodIds = [], subscribeGeom }) {
  const [paths, setPaths] = useState([]);
  const [size, setSize] = useState({ w: 0, h: 0 });

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

    // "infinite maze": tile invisible cells across the bbox of the dots + honeycomb (+ margin) so a
    // wire threads corridors through the empty gap too, never a free diagonal.
    const xs = realHexes.map((h) => h.cx).concat(dots.map((d) => d.dx));
    const ys = realHexes.map((h) => h.cy).concat(dots.map((d) => d.dy));
    const M = cellSize * 1.5;
    const bbox = { x0: Math.min(...xs) - M, y0: Math.min(...ys) - M, x1: Math.max(...xs) + M, y1: Math.max(...ys) + M };
    const virtual = latticeCells(realHexes[0].cx, realHexes[0].cy, cellSize, bbox);
    const graph = buildHexGraph(realHexes.concat(virtual));

    const items = [];
    for (const dd of dots) {
      const verts = graph.vertsById.get(dd.id);
      if (!verts) continue;
      const { dx: dcx, dy: dcy } = dd;
      // aim at the vertex of the target hex closest to the commit head (the dot)
      const target = nearestVertex(verts, dcx, dcy);
      let d, ex = target.x, ey = target.y;

      if (prodIds.includes(dd.id)) {
        // straight wire to that vertex (kept ⟂ by the graph tracking the prod-hex median)
        d = `M ${f1(dcx)} ${f1(dcy)} L ${f1(ex)} ${f1(ey)}`;
      } else {
        // leave the graph PERPENDICULAR, a 90° turn onto the lattice, then thread the (infinite)
        // corridor maze to the target — no free diagonal anywhere.
        const entryKey = nearestNode(graph, dcx, dcy);
        const path = entryKey ? shortestPath(graph, entryKey, target.key) : null;
        if (path && path.length) {
          const e0 = path[0];                                   // entry vertex on the lattice
          const corner = portrait ? [dcx, e0.y] : [e0.x, dcy];  // ⟂ off the spine, then 90° turn
          const poly = [[dcx, dcy], corner, ...path.map((p) => [p.x, p.y])];
          d = 'M ' + poly.map((p) => `${f1(p[0])} ${f1(p[1])}`).join(' L ');
        } else {
          d = `M ${f1(dcx)} ${f1(dcy)} L ${f1(ex)} ${f1(ey)}`;   // disconnected fallback: straight
        }
      }
      items.push({ id: dd.id, color: dd.color, d, x1: dcx, y1: dcy, x2: ex, y2: ey,
        dim: expandedId && expandedId !== dd.id });
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

  return (
    <svg className="connectors" width={size.w} height={size.h}
         style={{ position: 'absolute', left: 0, top: 0, pointerEvents: 'none', zIndex: 5 }}>
      {paths.map((p) => (
        <g key={p.id} opacity={p.dim ? 0.12 : 0.92}>
          <path d={p.d} fill="none" stroke={p.color} strokeWidth="2"
                strokeLinejoin="round" strokeLinecap="round" />
          <circle cx={p.x1} cy={p.y1} r="3" fill={p.color} />
          <rect x={p.x2 - 3.5} y={p.y2 - 3.5} width="7" height="7" rx="1.5"
                fill={p.color} stroke="var(--bg)" strokeWidth="1.5" />
        </g>
      ))}
    </svg>
  );
}
