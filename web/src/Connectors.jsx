import React, { useState, useCallback, useLayoutEffect, useEffect } from 'react';

// SVG overlay spanning the whole hive-split. For each xell it draws a colored wire from the xell's
// commit dot in the centre <GraphPane> (the point in history it sits at) to that xell's hexagon in
// the honeycomb canvas. The dot is measured live from the DOM (data-commit, which already reflects
// the graph's scroll transform); the hex centre comes from HiveCanvas via `hexPosRef`.
//
//   • production: a single STRAIGHT wire — the graph scroll-tracks the prod hexes (median) so each
//     prod dot stays across from its hexagon, keeping this perpendicular.
//   • everyone else: a hex-aligned trace whose segments run only VERTICAL or at ±30° — parallel to
//     a pointy-top hexagon's edges — so a bend is always along a hex side. One bend, two segments:
//     landscape leaves the vertical spine on a 30° diagonal then runs vertical into the hex;
//     portrait leaves the horizontal spine vertically then runs a 30° diagonal into the hex.
const T30 = Math.tan(Math.PI / 6);   // ≈0.5774 — slope of a pointy-top hex's slanted edge

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

    const items = [];
    for (const x of (timeline.xells || [])) {
      const dot = cont.querySelector(`[data-commit="${x.base_commit}"][data-dot]`);
      const hp = hexPos[x.id];
      if (!dot || !hp) continue;
      const n = dot.getBoundingClientRect();
      const dcx = (n.left + n.right) / 2 - cr.left;
      const dcy = (n.top + n.bottom) / 2 - cr.top;
      const hx = hp.x - cr.left, hy = hp.y - cr.top;
      const stop = (hp.size || 20) + 3;
      let d, ex, ey;

      if (prodIds.includes(x.id)) {
        // straight wire to the hex edge (kept ⟂ by the graph tracking the prod-hex median)
        const vx = hx - dcx, vy = hy - dcy, L = Math.hypot(vx, vy) || 1;
        ex = hx - (vx / L) * stop; ey = hy - (vy / L) * stop;
        d = `M ${f1(dcx)} ${f1(dcy)} L ${f1(ex)} ${f1(ey)}`;
      } else {
        // hex-aligned route: a corner C splits it into a VERTICAL leg and a ±30° diagonal leg, the
        // 30° leg carrying the full cross-spine distance (dx). Trim the final point to the hex edge
        // along the incoming leg's direction.
        const dx = hx - dcx, dy = hy - dcy;
        const vDiag = Math.abs(dx) * T30;              // vertical distance the 30° leg spans
        const sgn = dy >= 0 ? 1 : -1;
        let cx, cy;
        if (portrait) { cx = dcx; cy = hy - sgn * vDiag; }   // vertical leg first, then diagonal → hex
        else { cx = hx; cy = dcy + sgn * vDiag; }            // diagonal off the spine, then vertical → hex
        // trim endpoint back along C→hex by `stop`
        const lx = hx - cx, ly = hy - cy, LL = Math.hypot(lx, ly) || 1;
        ex = hx - (lx / LL) * stop; ey = hy - (ly / LL) * stop;
        d = `M ${f1(dcx)} ${f1(dcy)} L ${f1(cx)} ${f1(cy)} L ${f1(ex)} ${f1(ey)}`;
      }
      items.push({ id: x.id, color: x.color, d, x1: dcx, y1: dcy, x2: ex, y2: ey,
        dim: expandedId && expandedId !== x.id });
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
