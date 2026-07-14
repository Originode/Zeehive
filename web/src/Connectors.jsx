import React, { useState, useCallback, useLayoutEffect, useEffect } from 'react';

// SVG overlay that draws a colored connector from each xell's base-commit dot (in the
// GitRail) to the bottom-center of that xell's card. Measured from the live DOM so it
// stays correct across layout/scroll/data changes.
export default function Connectors({ timeline, layoutRef, version }) {
  const [paths, setPaths] = useState([]);
  const [size, setSize] = useState({ w: 0, h: 0 });

  const measure = useCallback(() => {
    const cont = layoutRef.current;
    if (!cont || !timeline) return;
    const cr = cont.getBoundingClientRect();
    setSize({ w: cont.scrollWidth, h: cont.scrollHeight });

    // connectors emerge from the rail's right edge, aligned to the commit's row (so they
    // don't cross the graph/text), then route to the card.
    const rail = cont.querySelector('.gitrail');
    const railRightEdge = rail ? rail.getBoundingClientRect().right - cr.left : 0;

    const items = [];
    for (const x of timeline.xells) {
      const dot = cont.querySelector(`[data-commit="${x.base_commit}"][data-dot]`);
      const card = cont.querySelector(`[data-xell-id="${x.id}"]`);
      if (!dot || !card) continue;
      const n = dot.getBoundingClientRect();
      const k = card.getBoundingClientRect();
      items.push({
        id: x.id, color: x.color,
        x1: railRightEdge, y1: (n.top + n.bottom) / 2 - cr.top,
        cx: k.left - cr.left + k.width / 2, cardTop: k.top - cr.top, cardLeft: k.left - cr.left,
        ci: timeline.commits.findIndex((c) => c.hash === x.base_commit),
      });
    }
    if (!items.length) { setPaths([]); return; }

    // sort by commit recency (leading/topmost first) — same order the cards are laid out in
    items.sort((a, b) => a.ci - b.ci || a.cx - b.cx);

    // routing channel: distinct vertical lane per net in the gap, distinct horizontal bus
    // per net just above the cards → orthogonal "circuit board" traces that never cross.
    const railRight = Math.max(...items.map((i) => i.x1));
    const cardsLeft = Math.min(...items.map((i) => i.cardLeft));
    const topMin = Math.min(...items.map((i) => i.cardTop));
    const n = items.length;
    const laneGap = Math.max(6, Math.min(15, (cardsLeft - railRight - 20) / n));
    const busGap = 11;

    const next = items.map((it, i) => {
      const laneX = railRight + 10 + i * laneGap;     // leftmost net → innermost lane
      const busY = Math.max(8, topMin - 14 - i * busGap); // leftmost → lowest bus (no crossings)
      const endY = it.cardTop;
      // dot → (lane, y1) → (lane, busY) → (cardCenter, busY) → (cardCenter, cardTop)
      const d = `M ${it.x1} ${it.y1} L ${laneX} ${it.y1} L ${laneX} ${busY} L ${it.cx} ${busY} L ${it.cx} ${endY}`;
      return { id: it.id, d, color: it.color, x1: it.x1, y1: it.y1, x2: it.cx, y2: endY };
    });
    setPaths(next);
  }, [timeline, layoutRef]);

  useLayoutEffect(() => { measure(); }, [measure, version]);

  useEffect(() => {
    const on = () => measure();
    window.addEventListener('resize', on);
    window.addEventListener('scroll', on, true);
    const ro = new ResizeObserver(on);
    if (layoutRef.current) ro.observe(layoutRef.current);
    const t = setTimeout(on, 200); // after fonts/layout settle
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
        <g key={p.id}>
          <path d={p.d} fill="none" stroke={p.color} strokeWidth="2"
                strokeLinejoin="round" strokeLinecap="round" opacity="0.92" />
          <circle cx={p.x1} cy={p.y1} r="3" fill={p.color} />
          {/* solder-pad at the card-top termination */}
          <rect x={p.x2 - 3.5} y={p.y2 - 3.5} width="7" height="7" rx="1.5"
                fill={p.color} stroke="#0d1017" strokeWidth="1.5" />
        </g>
      ))}
    </svg>
  );
}
