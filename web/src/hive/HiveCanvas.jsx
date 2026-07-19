import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { hexPath, pointInHex, hexWidth, rowStep, layoutHoneycomb, SQRT3 } from './hex.js';

// ── palette ───────────────────────────────────────────────────────────────────
const COL = {
  bg: '#0d1017', panel: '#161b24', line: '#2a3242', text: '#e6ebf2', muted: '#8b97a8',
  working: '#35c46b', idle: '#e0a53b', ready: '#5b8cff', claimed: '#9b8cff',
  awaiting: '#e0a53b', spawning: '#5b8cff', error: '#e5554e', prod: '#f2c14e',
  sha: '#e0a53b', add: '#35c46b', del: '#e5554e',
};
const HEALTH = { up: '#35c46b', building: '#e0a53b', down: '#e5554e', unknown: '#6b7688', starting: '#5b8cff' };
const LANE = ['#e0a53b', '#e26fae', '#9ccf3f', '#5b8cff', '#35c46b', '#9b8cff',
  '#e5554e', '#3bc6c0', '#d98c5f', '#7bd0e0', '#c98cff', '#8cd98c'];
// role tint, matching the DOM chip's icon colours (Container.jsx / styles.css .cbox[data-role]) —
// so a canvas-drawn container box reads as the same object as the real one in the machine columns.
const ROLE_TINT = { db: '#e08a3b', server: '#9b8cff', webapp: '#5b8cff' };

// The git graph now lives in its own centre-divider pane (<GraphPane>) and the connector wires in
// an SVG overlay (<Connectors>). This canvas is purely the honeycomb: hexes + the bloom flower, on
// a freely pannable/zoomable world. After each draw it publishes every hex's live client-space
// centre+radius (via `hexPosRef` + `onGeometry`) so the overlay can anchor connectors to them.

function statusColor(x) {
  if (x.is_production) return COL.prod;
  const s = x.status;
  if (s === 'working') return COL.working;
  if (s === 'idle') return COL.idle;
  if (s === 'ready') return COL.ready;
  if (s === 'claimed') return COL.claimed;
  if (s === 'awaiting-done') return COL.awaiting;
  if (['errored', 'error', 'stopped'].includes(x.zee_status)) return COL.error;
  return COL.muted;
}
const shortSlug = (s) => String(s || '');
const stripBranch = (b) => String(b || '').replace(/^spinoff\//, '');
const nick = (name) => {
  const s = String(name || '');
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16).slice(0, 3).toUpperCase().padStart(3, '0');
};
function ageText(iso) {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return '';
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
function fit(ctx, s, maxW) {
  s = String(s ?? '');
  if (ctx.measureText(s).width <= maxW) return s;
  let lo = 0, hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(s.slice(0, mid) + '…').width <= maxW) lo = mid; else hi = mid - 1;
  }
  return s.slice(0, lo) + '…';
}
function withAlpha(hex, a) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// A xell's machine (from its server container's docker context).
function machineOf(x, machines) {
  const ctx = (x.stack || []).find((c) => c.role === 'server' && c.docker_ctx)?.docker_ctx
    || (x.stack || []).find((c) => c.docker_ctx)?.docker_ctx || null;
  if (!ctx) return null;
  const m = (machines || []).find((mm) => mm.docker_ctx === ctx);
  return m ? (m.key || m.label || ctx) : ctx;
}
// "no — 2 unlanded" | "no — dirty" | "ready": the zee-facing ship gate answer, derived the same
// way the old card derived it (unlanded = commits ahead of main; dirty = uncommitted files).
function shipLine(x, diff) {
  if (x.is_production) return null;
  if (!diff) return null;
  if (diff.ahead > 0) return `no — ${diff.ahead} unlanded`;
  if (diff.dirty > 0) return `no — dirty`;
  // Landed AND already contained in the live prod commit → its work is deployed. Say so instead of
  // dangling "ship ready" forever on a xell whose commits are already in production.
  if (diff.in_prod) return 'shipped';
  return 'ready';
}

// Draw a run of differently-coloured text segments centred on `cx` at baseline `y`. `ctx.font` must
// already be set by the caller (all segments share one font — that's what makes the widths add up).
// Used for every colored diffstat (git convention: insertions green, deletions red) so the commit
// hex, the diff·age facet and the compact hex's own-diff line all share one implementation.
function drawDiffRow(ctx, cx, y, parts) {
  const widths = parts.map((p) => ctx.measureText(p.t).width);
  const total = widths.reduce((a, b) => a + b, 0);
  let x0 = cx - total / 2;
  const prevAlign = ctx.textAlign;
  ctx.textAlign = 'left';
  parts.forEach((p, i) => { ctx.fillStyle = p.c; ctx.fillText(p.t, x0, y); x0 += widths[i]; });
  ctx.textAlign = prevAlign;
}

// A tiny role glyph, canvas-drawn to match the DOM chip's SVG icons (Container.jsx / styles.css) —
// same silhouette (cylinder / rack bars / browser window), same low-opacity white stroke.
function drawRoleIcon(ctx, role, cx, cy, s) {
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.6)';
  ctx.lineWidth = Math.max(1, s * 0.13);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  if (role === 'db') {
    const rx = s * 0.5, ry = s * 0.2, top = cy - s * 0.32, bot = cy + s * 0.32;
    ctx.beginPath(); ctx.ellipse(cx, top, rx, ry, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx - rx, top); ctx.lineTo(cx - rx, bot);
    ctx.bezierCurveTo(cx - rx, bot + ry, cx + rx, bot + ry, cx + rx, bot);
    ctx.lineTo(cx + rx, top);
    ctx.stroke();
  } else if (role === 'server') {
    const bw = s * 1.05, bh = s * 0.38, gap = s * 0.16;
    ctx.strokeRect(cx - bw / 2, cy - gap / 2 - bh, bw, bh);
    ctx.strokeRect(cx - bw / 2, cy + gap / 2, bw, bh);
  } else if (role === 'webapp') {
    const bw = s * 1.05, bh = s * 0.85;
    ctx.strokeRect(cx - bw / 2, cy - bh / 2, bw, bh);
    ctx.beginPath();
    ctx.moveTo(cx - bw / 2, cy - bh / 2 + bh * 0.3); ctx.lineTo(cx + bw / 2, cy - bh / 2 + bh * 0.3);
    ctx.stroke();
  }
  ctx.restore();
}

// The real container box — nick + type icon + health dot — rendered wherever a container needs to
// be shown as itself rather than as a dot (the flower's CONTAINERS facet, and the compact hex's
// upper-half stack). Mirrors ContainerChip (Container.jsx): role-tinted rounded box, icon on top,
// nick below, health dot pinned to the top-right corner.
function drawContainerBox(ctx, cx, cy, w, h, c) {
  const r = Math.min(6, w * 0.18, h * 0.18);
  ctx.beginPath();
  ctx.roundRect(cx - w / 2, cy - h / 2, w, h, r);
  const tint = ROLE_TINT[c.role];
  ctx.fillStyle = tint ? withAlpha(tint, 0.18) : withAlpha('#0a0d13', 0.72);
  ctx.fill();
  ctx.lineWidth = 1; ctx.strokeStyle = withAlpha(COL.line, 1); ctx.stroke();
  drawRoleIcon(ctx, c.role, cx, cy - h * 0.16, Math.min(w, h) * 0.62);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = `600 ${Math.max(8, h * 0.24)}px 'Cascadia Code', monospace`;
  ctx.fillStyle = COL.text;
  ctx.fillText(nick(c.name), cx, cy + h * 0.32);
  ctx.beginPath(); ctx.arc(cx + w / 2 - 4, cy - h / 2 + 4, Math.max(2, h * 0.08), 0, Math.PI * 2);
  ctx.fillStyle = c.health ? (HEALTH[c.health] || HEALTH.unknown) : withAlpha(COL.muted, 0.4);
  ctx.fill();
}

// ── offset-grid helpers (odd rows shift right — matches layoutHoneycomb) ───────
const cellKey = (row, col) => row + ',' + col;
function cellCenter(row, col, size, originX, originY) {
  const w = hexWidth(size);
  return [originX + w / 2 + col * w + (row % 2 ? w / 2 : 0), originY + size + row * rowStep(size)];
}
// The six neighbours of an offset cell (odd-r layout).
function cellNeighbors(row, col) {
  const odd = row % 2 === 1;
  return [
    [row, col - 1], [row, col + 1],
    [row - 1, odd ? col : col - 1], [row - 1, odd ? col + 1 : col],
    [row + 1, odd ? col : col - 1], [row + 1, odd ? col + 1 : col],
  ];
}

// Connector wires thread the corridors BETWEEN hexes, so the honeycomb is drawn spaced: each hex is
// shrunk inside its (gapless) layout cell to open a gap wide enough for the traces that must pass —
// sized by the grid dimension a wire fans across (columns in portrait, rows in landscape). The
// routing lattice (<Connectors>) still uses the full CELL size so it stays connected; only the drawn
// hex shrinks. WIRE_PITCH is the on-screen width one trace needs (stroke + clearance).
const WIRE_PITCH = 6;

export default function HiveCanvas({ xells, diffs, timeline, orientation, honeySide, onOpenSession, machines,
                                    expandedId, onExpand, hexPosRef, onGeometry,
                                    hoverRef, setHover, subscribeHover }) {
  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const geomRef = useRef({ hexes: [], flower: null });
  const viewRef = useRef({ x: 0, y: 0, k: 1 });          // pan offset + zoom (world → screen)
  const dragRef = useRef(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const rafRef = useRef(0);
  const setExpandedId = onExpand || (() => {});
  const emitHover = setHover || (() => {});
  // the base commit a xell sits on (for tying a hex hover to its commit dot, and vice-versa)
  const baseOf = useCallback((id) => (timeline?.xells || []).find((t) => t.id === id)?.base_commit || null, [timeline]);

  const expanded = expandedId ? (xells || []).find((x) => x.id === expandedId) : null;
  useEffect(() => { if (expandedId && !expanded) setExpandedId?.(null); }, [expandedId, expanded, setExpandedId]);

  // ── draw ──────────────────────────────────────────────────────────────────
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const { w, h } = size;
    if (w <= 0 || h <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext('2d');
    const v = viewRef.current;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const list = xells || [];
    const tById = {};
    for (const tx of (timeline?.xells || [])) tById[tx.id] = tx;

    // honeycomb WORLD layout across the whole pane (initial view = identity, so world ≈ screen
    // until the user pans/zooms). The git graph is a separate pane; nothing is reserved here.
    // Kept tight on purpose — every pixel here is the flower's; pad only enough that a hex's edge
    // stroke doesn't clip against the pane border, and let hexes grow bigger (raised `max`) when
    // there are few enough xells that the honeycomb was previously capped well under the pane size.
    const pad = 6;
    const lay = layoutHoneycomb(list.length, w - pad * 2, h - pad * 2, { min: 24, max: 168, pad: 6 });
    const cellSize = lay.size;                    // gapless layout cell → the routing lattice
    // corridor gap: room for `count` traces to pass (cols in portrait, rows in landscape). Shrink the
    // drawn hex within its cell to open it, but keep enough hex to stay legible.
    const portrait = orientation === 'portrait';
    const count = Math.max(1, portrait ? lay.cols : lay.rows);
    const gap = count * WIRE_PITCH;
    const drawSize = Math.max(cellSize * 0.5, cellSize - gap / SQRT3);   // shrink to open the gap
    const originX = pad, originY = pad;
    // base cell per xell (row-major, exactly layoutHoneycomb's shape)
    const baseCells = {};
    list.forEach((x, i) => {
      const c = lay.cells[i] || { row: 0, col: i };
      baseCells[x.id] = [c.row, c.col];
    });
    // flower reflow: expanded keeps its cell, its 6 neighbours are consumed; everyone else takes
    // the next free cell in reading order (rows extend as needed — the canvas pans).
    const cells = {};
    const reserved = new Set();
    if (expanded && baseCells[expanded.id]) {
      const [er, ec] = baseCells[expanded.id];
      cells[expanded.id] = [er, ec];
      reserved.add(cellKey(er, ec));
      for (const [nr, nc] of cellNeighbors(er, ec)) reserved.add(cellKey(nr, nc));
    }
    {
      const cols = Math.max(1, lay.cols);
      let row = 0, col = 0;
      const nextFree = () => {
        for (;;) {
          const k = cellKey(row, col);
          const taken = reserved.has(k) || Object.values(cells).some(([r2, c2]) => r2 === row && c2 === col);
          const out = [row, col];
          col++; if (col >= cols) { col = 0; row++; }
          if (!taken) return out;
        }
      };
      for (const x of list) { if (!cells[x.id]) cells[x.id] = nextFree(); }
    }
    const hexes = list.map((x) => {
      const [row, col] = cells[x.id];
      const [cx, cy] = cellCenter(row, col, cellSize, originX, originY);   // centres on the gapless grid
      return { x, id: x.id, row, col, cx, cy, size: drawSize, cell: cellSize, color: tById[x.id]?.color || null };
    });
    const hexById = {}; for (const hx of hexes) hexById[hx.id] = hx;

    // hover highlight: a hovered hex OR a hovered commit dot lights up the matching hex(es)
    const H = hoverRef ? hoverRef.current : { id: null, commit: null };
    const hoverActive = !!(H.id || H.commit);
    const isHov = (id) => id === H.id || (!!H.commit && baseOf(id) === H.commit);

    // honeycomb + flower, on the pan/zoom world transform
    ctx.setTransform(dpr * v.k, 0, 0, dpr * v.k, dpr * v.x, dpr * v.y);
    geomRef.current.hexes = hexes;
    for (const hx of hexes) {
      if (expanded && hx.id === expanded.id) continue;     // the flower draws it
      const hovered = isHov(hx.id);
      const dim = (expandedId && expandedId !== hx.id) || (hoverActive && !hovered);
      drawCompactHex(ctx, hx, { hover: hovered, dim, diff: diffs?.[hx.id], machines });
    }
    geomRef.current.flower = null;
    if (expanded && cells[expanded.id]) {
      const [er, ec] = cells[expanded.id];
      const centers = [cellCenter(er, ec, cellSize, originX, originY),
        ...cellNeighbors(er, ec).map(([r, c]) => cellCenter(r, c, cellSize, originX, originY))];
      drawFlower(ctx, centers, cellSize, expanded, diffs?.[expanded.id], machines);
      geomRef.current.flower = { centers, size: cellSize, id: expanded.id,
        openable: !!expanded.viewer_url && !expanded.is_production };
    }

    // publish each hex's live CLIENT-space geometry so <Connectors> can route its wires here and
    // re-route on pan/zoom. `size` is the full CELL radius (the gapless routing lattice); `draw` is
    // the shrunk drawn radius (the visible hex the corridors run between).
    if (hexPosRef) {
      const r = canvas.getBoundingClientRect();
      const pos = {};
      for (const hx of hexes) {
        pos[hx.id] = { x: r.left + v.k * hx.cx + v.x, y: r.top + v.k * hx.cy + v.y,
          size: hx.cell * v.k, draw: hx.size * v.k };
      }
      hexPosRef.current = pos;
    }
    onGeometry && onGeometry();
    // honeySide is a dep so a flip (which moves this pane on screen) re-runs draw and republishes the
    // hexes' fresh client-space positions — otherwise <Connectors> would trace to their old spots.
  }, [size, xells, diffs, timeline, orientation, honeySide, expandedId, expanded, machines, hexPosRef, onGeometry, baseOf]);

  useLayoutEffect(() => { draw(); }, [draw]);

  // redraw the canvas when the shared hover changes (hover is read from a ref, not a draw dep)
  useEffect(() => {
    if (!subscribeHover) return undefined;
    return subscribeHover(() => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(draw);
    });
  }, [subscribeHover, draw]);

  // ── sizing ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ── interaction (screen → world through the pan/zoom transform) ─────────────
  const toWorld = (mx, my) => {
    const v = viewRef.current;
    return [(mx - v.x) / v.k, (my - v.y) / v.k];
  };
  const hitHex = useCallback((wx, wy) => {
    for (const hx of geomRef.current.hexes) if (pointInHex(wx, wy, hx.cx, hx.cy, hx.size)) return hx;
    return null;
  }, []);
  const hitFlower = useCallback((wx, wy) => {
    const f = geomRef.current.flower;
    if (!f) return null;
    for (let i = 0; i < f.centers.length; i++) {
      const [cx, cy] = f.centers[i];
      if (pointInHex(wx, wy, cx, cy, f.size)) return { ...f, cell: i };   // 0 = centre
    }
    return null;
  }, []);

  const relPos = (e) => {
    const r = canvasRef.current.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };

  const onPointerDown = (e) => {
    const [mx, my] = relPos(e);
    dragRef.current = { mx, my, vx: viewRef.current.x, vy: viewRef.current.y, moved: false };
    canvasRef.current.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e) => {
    const [mx, my] = relPos(e);
    const d = dragRef.current;
    if (d) {
      if (Math.abs(mx - d.mx) + Math.abs(my - d.my) > 4) d.moved = true;
      if (d.moved) {
        viewRef.current.x = d.vx + (mx - d.mx);
        viewRef.current.y = d.vy + (my - d.my);
        canvasRef.current.style.cursor = 'grabbing';
        if (rafRef.current) cancelAnimationFrame(rafRef.current);
        rafRef.current = requestAnimationFrame(draw);
        return;
      }
    }
    const [wx, wy] = toWorld(mx, my);
    let cursor = 'default';
    if (expandedId) {
      const f = hitFlower(wx, wy);
      cursor = f && f.cell === 0 && f.openable ? 'pointer' : 'default';
      emitHover({ id: null, commit: null });
    } else {
      const hx = hitHex(wx, wy);
      const id = hx?.id || null;
      emitHover({ id, commit: null });   // a hex is ONE xell → key on id, so only this hex lights up
      cursor = hx ? 'pointer' : 'default';
    }
    canvasRef.current.style.cursor = cursor;
  };
  const onPointerUp = (e) => {
    const d = dragRef.current;
    dragRef.current = null;
    canvasRef.current.style.cursor = 'default';
    if (d?.moved) return;                                    // it was a pan, not a click
    const [wx, wy] = toWorld(...relPos(e));
    if (expandedId) {
      const f = hitFlower(wx, wy);
      if (f) {
        if (f.cell === 0 && f.openable) {
          const x = (xells || []).find((xx) => xx.id === f.id);
          if (x) onOpenSession?.(x);
        }
        return;                                              // petal clicks keep the flower open
      }
      const hx = hitHex(wx, wy);
      if (hx && hx.id !== expandedId) { setExpandedId(hx.id); return; }
      setExpandedId(null);
      return;
    }
    const hx = hitHex(wx, wy);
    if (hx) setExpandedId(hx.id);
  };

  const onWheel = (e) => {
    e.preventDefault();
    const [mx, my] = relPos(e);
    const v = viewRef.current;
    const f = e.deltaY > 0 ? 1 / 1.12 : 1.12;
    const k = Math.min(3.2, Math.max(0.3, v.k * f));
    // zoom about the cursor: keep the world point under the mouse fixed
    v.x = mx - ((mx - v.x) / v.k) * k;
    v.y = my - ((my - v.y) / v.k) * k;
    v.k = k;
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(draw);
  };

  const onLeave = () => { emitHover({ id: null, commit: null }); dragRef.current = null; };

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') {
        if (expandedId) setExpandedId(null);
        else { viewRef.current = { x: 0, y: 0, k: 1 }; draw(); }   // Esc with nothing open: reset view
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expandedId, draw]);

  // wheel must be non-passive to preventDefault page scroll
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  });

  return (
    <div ref={wrapRef} className="hive-canvas-wrap">
      <canvas ref={canvasRef} className="hive-canvas"
              style={{ width: size.w, height: size.h, display: 'block', touchAction: 'none' }}
              onPointerDown={onPointerDown} onPointerMove={onPointerMove}
              onPointerUp={onPointerUp} onMouseLeave={onLeave} />
      {(!xells || xells.length === 0) && (
        <p className="hive-empty">No active xells. The pool maintainer will fill it shortly…</p>
      )}
    </div>
  );
}


// ── compact hex: the two-half card ────────────────────────────────────────────
// upper half: ⌂ machine + container chips (nick + health dot)
// lower half: head sha · own diff · status pill · ship line
function drawCompactHex(ctx, hx, { hover, dim, diff, machines }) {
  const { cx, cy, size, x } = hx;
  const col = statusColor(x);
  const w = hexWidth(size);
  ctx.save();
  if (dim) ctx.globalAlpha = 0.3;

  hexPath(ctx, cx, cy, size);
  const g = ctx.createLinearGradient(cx, cy - size, cx, cy + size);
  g.addColorStop(0, withAlpha(col, hover ? 0.30 : 0.18));
  g.addColorStop(1, withAlpha(col, hover ? 0.16 : 0.08));
  ctx.fillStyle = g;
  ctx.fill();
  ctx.lineWidth = hover ? 2.4 : 1.4;
  ctx.strokeStyle = hover ? col : withAlpha(col, 0.6);
  ctx.stroke();
  if (hx.color) {
    hexPath(ctx, cx, cy, size - 3);
    ctx.lineWidth = 1.3; ctx.strokeStyle = withAlpha(hx.color, 0.9); ctx.stroke();
  }
  ctx.save();
  hexPath(ctx, cx, cy, size - 2);
  ctx.clip();

  if (size < 30) {                     // tiny: just the status dot
    ctx.beginPath(); ctx.arc(cx, cy, Math.max(2, size * 0.22), 0, Math.PI * 2);
    ctx.fillStyle = col; ctx.fill();
    ctx.restore(); ctx.restore(); return;
  }

  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const full = size >= 52;             // the two-half card needs room; else degrade

  // ── upper half ──
  const mach = machineOf(x, machines);
  if (full && mach) {
    ctx.font = `${Math.max(8, size * 0.14)}px 'Segoe UI', sans-serif`;
    ctx.fillStyle = COL.muted;
    ctx.fillText(fit(ctx, '⌂ ' + mach, w * 0.62), cx, cy - size * 0.62);
  }
  const stack = ['db', 'server', 'webapp']
    .map((r) => (x.stack || []).find((s) => s.role === r))
    .filter(Boolean);
  if (full && stack.length) {
    const chipW = Math.min(30, w * 0.21), chipH = Math.max(12, size * 0.2);
    const gap = 4;
    const total = stack.length * chipW + (stack.length - 1) * gap;
    let px0 = cx - total / 2;
    const py = cy - size * 0.34;
    ctx.font = `600 ${Math.max(7.5, chipH * 0.55)}px 'Cascadia Code', monospace`;
    for (const c of stack) {
      // chip body
      ctx.beginPath();
      ctx.roundRect(px0, py - chipH / 2, chipW, chipH, 3);
      ctx.fillStyle = withAlpha('#0a0d13', 0.72);
      ctx.fill();
      ctx.lineWidth = 1; ctx.strokeStyle = withAlpha(COL.line, 1); ctx.stroke();
      // nick
      ctx.fillStyle = COL.text;
      ctx.fillText(nick(c.name), px0 + chipW / 2, py + 0.5);
      // health dot pinned to the chip's top-right corner
      ctx.beginPath(); ctx.arc(px0 + chipW - 1.5, py - chipH / 2 + 1.5, 2.4, 0, Math.PI * 2);
      ctx.fillStyle = HEALTH[c.health] || HEALTH.unknown; ctx.fill();
      px0 += chipW + gap;
    }
  }

  // ── middle seam: identity ──
  ctx.fillStyle = COL.text;
  ctx.font = `600 ${Math.min(12, Math.max(8.5, size * 0.17))}px 'Segoe UI', sans-serif`;
  const label = x.is_production ? '🛡 PRODUCTION' : shortSlug(x.slug);
  ctx.fillText(fit(ctx, label, w * 0.8), cx, cy - (full ? size * 0.06 : size * 0.2));

  // ── lower half ──
  // Live head (diff.head, read from the worktree) over the frozen head_commit provisioning base, so
  // a xell that has committed/rebased/landed shows where it actually is, not its old fork sha.
  const sha = (x.is_production ? x.deployed_commit : (diff?.head || x.head_commit))?.slice(0, 8);
  if (full) {
    if (sha) {
      ctx.font = `600 ${Math.max(8.5, size * 0.155)}px 'Cascadia Code', monospace`;
      ctx.fillStyle = COL.sha;
      ctx.fillText(sha, cx, cy + size * 0.14);
    }
    // own diff: "0f +0/−0" — bumped up from the old 0.14 factor (min 8) so it reads at a glance;
    // git convention colouring (insertions green, deletions red) via drawDiffRow.
    const own = diff?.own;
    if (own && !x.is_production) {
      const y = cy + size * 0.32;
      ctx.font = `600 ${Math.max(9.5, size * 0.165)}px 'Cascadia Code', monospace`;
      drawDiffRow(ctx, cx, y, [
        { t: `${own.files}f `, c: COL.muted },
        { t: `+${own.insertions}`, c: COL.add },
        { t: `/−${own.deletions}`, c: COL.del },
      ]);
    }
    // status pill
    const st = x.is_production ? 'live · protected' : x.status;
    if (st) {
      ctx.font = `600 ${Math.max(7.5, size * 0.13)}px 'Segoe UI', sans-serif`;
      const pw = ctx.measureText(st).width + 12, ph = Math.max(11, size * 0.19);
      const py2 = cy + size * 0.5;
      ctx.beginPath(); ctx.roundRect(cx - pw / 2, py2 - ph / 2, pw, ph, ph / 2);
      ctx.fillStyle = withAlpha(col, 0.22); ctx.fill();
      ctx.lineWidth = 1; ctx.strokeStyle = withAlpha(col, 0.7); ctx.stroke();
      ctx.fillStyle = col;
      ctx.fillText(st, cx, py2 + 0.5);
    }
    // ship line
    const ship = shipLine(x, diff);
    if (ship) {
      ctx.font = `${Math.max(7.5, size * 0.125)}px 'Segoe UI', sans-serif`;
      ctx.fillStyle = ship === 'ready' ? COL.working : COL.muted;
      ctx.fillText(fit(ctx, ship === 'ready' ? 'ship ready' : ship, w * 0.5), cx, cy + size * 0.7);
    }
  } else {
    // mid sizes: sha + status only
    if (sha) {
      ctx.font = `600 ${Math.max(8, size * 0.17)}px 'Cascadia Code', monospace`;
      ctx.fillStyle = COL.sha;
      ctx.fillText(sha, cx, cy + size * 0.08);
    }
    ctx.font = `${Math.max(7.5, size * 0.15)}px 'Segoe UI', sans-serif`;
    ctx.fillStyle = COL.muted;
    ctx.fillText(fit(ctx, x.is_production ? 'live' : x.status, w * 0.6), cx, cy + size * 0.34);
  }
  ctx.restore();   // unclip
  ctx.restore();
}

// ── the flower: rendered ON the grid cells it consumes (no overlay) ───────────
function drawFlower(ctx, centers, size, x, diff, machines) {
  const col = statusColor(x);
  const petals = flowerFacets(x, diff, machines);
  centers.forEach(([hx, hy], i) => {
    const facet = petals[i];
    const isCenter = i === 0;
    ctx.save();
    hexPath(ctx, hx, hy, size - 1.5);
    const g = ctx.createLinearGradient(hx, hy - size, hx, hy + size);
    if (isCenter) { g.addColorStop(0, withAlpha(col, 0.42)); g.addColorStop(1, withAlpha(col, 0.16)); }
    else { g.addColorStop(0, withAlpha(COL.panel, 1)); g.addColorStop(1, withAlpha(COL.bg, 1)); }
    ctx.fillStyle = g;
    ctx.fill();
    ctx.lineWidth = isCenter ? 2.4 : 1.4;
    ctx.strokeStyle = isCenter ? col : withAlpha(col, 0.45);
    ctx.stroke();
    ctx.clip();
    drawFacet(ctx, hx, hy, size, facet, col, isCenter, x);
    ctx.restore();
  });
}

function flowerFacets(x, diff, machines) {
  const src = x.remote_source || {};
  const stack = x.stack || [];
  // real container rows (role/health/name — enough for drawContainerBox), not just a health dot.
  const cont = ['db', 'server', 'webapp'].map((r) => {
    const c = stack.find((s) => s.role === r);
    return { role: r, health: c?.health || null, name: c?.name || null, present: !!c };
  });
  return [
    { title: null, lines: [x.is_production ? 'PRODUCTION' : shortSlug(x.slug),
      x.is_production ? 'live · protected' : x.status] },
    { title: 'branch', lines: [stripBranch(x.branch) || '—', `src ${src.ref || '—'}`] },
    { title: 'session', lines: [x.zee_title || (x.claude_session_id ? x.claude_session_id.slice(0, 8) : '—'),
      x.zee_status === 'working' ? (x.zee_name || 'working') : (x.zee_status || '')] },
    { title: 'containers', kind: 'stack', stack: cont },
    { title: 'machine', lines: [machineOf(x, machines) || '—', x.runtime_label || ''] },
    { title: 'commit', kind: 'commitdiff',
      lines: [(x.is_production ? x.deployed_commit : (diff?.head || x.head_commit))?.slice(0, 8) || '—'], diff },
    { title: 'diff · age', kind: 'owndiff', diff, age: ageText(x.created_at) },
  ];
}

function drawFacet(ctx, cx, cy, size, facet, col, isCenter, x) {
  ctx.textAlign = 'center';
  if (isCenter) {
    ctx.textBaseline = 'middle';
    ctx.fillStyle = COL.text;
    ctx.font = `700 ${Math.min(15, size * 0.2)}px 'Segoe UI', sans-serif`;
    ctx.fillText(fit(ctx, facet.lines[0], size * 1.5), cx, cy - size * 0.12);
    ctx.fillStyle = withAlpha(col, 0.95);
    ctx.font = `${Math.min(11, size * 0.15)}px 'Segoe UI', sans-serif`;
    ctx.fillText(fit(ctx, facet.lines[1], size * 1.5), cx, cy + size * 0.2);
    return;
  }
  ctx.textBaseline = 'top';
  ctx.fillStyle = withAlpha(col, 0.9);
  ctx.font = `600 ${Math.min(9.5, size * 0.14)}px 'Segoe UI', sans-serif`;
  ctx.fillText(String(facet.title || '').toUpperCase(), cx, cy - size * 0.5);

  // CONTAINERS facet: the real container boxes (nick + type icon + health dot), not a row of dots —
  // the same object the machine columns show below, just drawn small enough to fit the petal.
  if (facet.kind === 'stack') {
    const roles = facet.stack;
    const boxW = size * 0.42, boxH = size * 0.56, gapx = size * 0.46;
    const y = cy + size * 0.08;
    roles.forEach((rr, i) => {
      const px = cx + (i - 1) * gapx;
      if (rr.present) {
        drawContainerBox(ctx, px, y, boxW, boxH, rr);
      } else {
        ctx.beginPath();
        ctx.roundRect(px - boxW / 2, y - boxH / 2, boxW, boxH, Math.min(5, boxW * 0.18));
        ctx.setLineDash([2, 2]);
        ctx.lineWidth = 1; ctx.strokeStyle = withAlpha(COL.muted, 0.5); ctx.stroke();
        ctx.setLineDash([]);
      }
    });
    return;
  }

  // COMMIT facet: sha, then the source diff (↑ahead ↓behind · files, git-coloured +ins/−del).
  if (facet.kind === 'commitdiff') {
    ctx.textBaseline = 'middle';
    ctx.fillStyle = COL.text;
    ctx.font = `600 ${Math.min(12, size * 0.16)}px 'Cascadia Code', monospace`;
    ctx.fillText(fit(ctx, facet.lines[0] || '—', size * 1.45), cx, cy - size * 0.02);
    const d = facet.diff;
    if (d) {
      ctx.font = `600 ${Math.min(12.5, size * 0.165)}px 'Cascadia Code', monospace`;
      drawDiffRow(ctx, cx, cy + size * 0.3, [
        { t: `↑${d.ahead} ↓${d.behind} · ${d.files}f `, c: COL.muted },
        { t: `+${d.insertions}`, c: COL.add },
        { t: `/−${d.deletions}`, c: COL.del },
      ]);
    } else {
      ctx.font = `${Math.min(10, size * 0.13)}px 'Segoe UI', sans-serif`;
      ctx.fillStyle = COL.muted;
      ctx.fillText('src —', cx, cy + size * 0.3);
    }
    return;
  }

  // DIFF · AGE facet: own (uncommitted-since-checkpoint) diff, git-coloured, then the xell's age.
  if (facet.kind === 'owndiff') {
    ctx.textBaseline = 'middle';
    const own = facet.diff?.own;
    if (own) {
      ctx.font = `600 ${Math.min(13, size * 0.175)}px 'Cascadia Code', monospace`;
      drawDiffRow(ctx, cx, cy - size * 0.02, [
        { t: '◈ ', c: withAlpha(col, 0.95) },
        { t: `${own.files}f `, c: COL.muted },
        { t: `+${own.insertions}`, c: COL.add },
        { t: `/−${own.deletions}`, c: COL.del },
      ]);
    } else {
      ctx.font = `${Math.min(11, size * 0.15)}px 'Segoe UI', sans-serif`;
      ctx.fillStyle = COL.text;
      ctx.fillText('◈ —', cx, cy - size * 0.02);
    }
    if (facet.age) {
      ctx.fillStyle = COL.muted;
      ctx.font = `${Math.min(9.5, size * 0.13)}px 'Segoe UI', sans-serif`;
      ctx.fillText(`age ${facet.age}`, cx, cy + size * 0.3);
    }
    return;
  }

  ctx.textBaseline = 'middle';
  ctx.fillStyle = COL.text;
  ctx.font = `${Math.min(11, size * 0.15)}px 'Segoe UI', sans-serif`;
  ctx.fillText(fit(ctx, facet.lines[0] || '—', size * 1.45), cx, cy);
  if (facet.lines[1]) {
    ctx.fillStyle = COL.muted;
    ctx.font = `${Math.min(9.5, size * 0.13)}px 'Segoe UI', sans-serif`;
    ctx.fillText(fit(ctx, facet.lines[1], size * 1.45), cx, cy + size * 0.28);
  }
}
