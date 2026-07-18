import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { hexPath, pointInHex, hexWidth, rowStep, layoutHoneycomb } from './hex.js';

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
  return 'ready';
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

export default function HiveCanvas({ xells, diffs, timeline, onOpenSession, machines,
                                    expandedId, onExpand, hexPosRef, onGeometry }) {
  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const geomRef = useRef({ hexes: [], flower: null });
  const viewRef = useRef({ x: 0, y: 0, k: 1 });          // pan offset + zoom (world → screen)
  const dragRef = useRef(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hoverId, setHoverId] = useState(null);
  const rafRef = useRef(0);
  const setExpandedId = onExpand || (() => {});

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
    const pad = 14;
    const lay = layoutHoneycomb(list.length, w - pad * 2, h - pad * 2, { min: 24 });
    const sizeHex = lay.size;
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
      const [cx, cy] = cellCenter(row, col, sizeHex, originX, originY);
      return { x, id: x.id, row, col, cx, cy, size: sizeHex, color: tById[x.id]?.color || null };
    });
    const hexById = {}; for (const hx of hexes) hexById[hx.id] = hx;

    // honeycomb + flower, on the pan/zoom world transform
    ctx.setTransform(dpr * v.k, 0, 0, dpr * v.k, dpr * v.x, dpr * v.y);
    geomRef.current.hexes = hexes;
    for (const hx of hexes) {
      if (expanded && hx.id === expanded.id) continue;     // the flower draws it
      const dim = expandedId && expandedId !== hx.id;
      drawCompactHex(ctx, hx, { hover: hoverId === hx.id, dim, diff: diffs?.[hx.id], machines });
    }
    geomRef.current.flower = null;
    if (expanded && cells[expanded.id]) {
      const [er, ec] = cells[expanded.id];
      const centers = [cellCenter(er, ec, sizeHex, originX, originY),
        ...cellNeighbors(er, ec).map(([r, c]) => cellCenter(r, c, sizeHex, originX, originY))];
      drawFlower(ctx, centers, sizeHex, expanded, diffs?.[expanded.id], machines);
      geomRef.current.flower = { centers, size: sizeHex, id: expanded.id,
        openable: !!expanded.viewer_url && !expanded.is_production };
    }

    // publish each hex's live CLIENT-space centre+radius so <Connectors> can anchor its wires here
    // and re-route them as the honeycomb is panned/zoomed.
    if (hexPosRef) {
      const r = canvas.getBoundingClientRect();
      const pos = {};
      for (const hx of hexes) {
        pos[hx.id] = { x: r.left + v.k * hx.cx + v.x, y: r.top + v.k * hx.cy + v.y, size: hx.size * v.k };
      }
      hexPosRef.current = pos;
    }
    onGeometry && onGeometry();
  }, [size, xells, diffs, timeline, expandedId, hoverId, expanded, machines, hexPosRef, onGeometry]);

  useLayoutEffect(() => { draw(); }, [draw]);

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
      if (hoverId) setHoverId(null);
    } else {
      const hx = hitHex(wx, wy);
      const id = hx?.id || null;
      if (id !== hoverId) {
        if (rafRef.current) cancelAnimationFrame(rafRef.current);
        rafRef.current = requestAnimationFrame(() => setHoverId(id));
      }
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

  const onLeave = () => { if (hoverId) setHoverId(null); dragRef.current = null; };

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
  const sha = (x.is_production ? x.deployed_commit : x.head_commit)?.slice(0, 8);
  if (full) {
    if (sha) {
      ctx.font = `600 ${Math.max(8.5, size * 0.155)}px 'Cascadia Code', monospace`;
      ctx.fillStyle = COL.sha;
      ctx.fillText(sha, cx, cy + size * 0.14);
    }
    // own diff: "0f +0/−0"
    const own = diff?.own;
    if (own && !x.is_production) {
      const y = cy + size * 0.32;
      ctx.font = `${Math.max(8, size * 0.14)}px 'Cascadia Code', monospace`;
      const fPart = `${own.files}f `, aPart = `+${own.insertions}`, dPart = `/−${own.deletions}`;
      const tw = ctx.measureText(fPart + aPart + dPart).width;
      let tx0 = cx - tw / 2;
      ctx.textAlign = 'left';
      ctx.fillStyle = COL.muted; ctx.fillText(fPart, tx0, y); tx0 += ctx.measureText(fPart).width;
      ctx.fillStyle = COL.add; ctx.fillText(aPart, tx0, y); tx0 += ctx.measureText(aPart).width;
      ctx.fillStyle = COL.del; ctx.fillText(dPart, tx0, y);
      ctx.textAlign = 'center';
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
  const cont = ['db', 'server', 'webapp'].map((r) => {
    const c = stack.find((s) => s.role === r);
    return { r, health: c?.health || null, name: c?.name || null };
  });
  const sd = diff && !x.is_production
    ? `↑${diff.ahead} ↓${diff.behind} · ${diff.files}f`
    : (diff && x.is_production ? `↑${diff.ahead} ↓${diff.behind}` : '—');
  const own = diff?.own ? `${diff.own.files}f +${diff.own.insertions}/−${diff.own.deletions}` : '—';
  return [
    { title: null, lines: [x.is_production ? 'PRODUCTION' : shortSlug(x.slug),
      x.is_production ? 'live · protected' : x.status] },
    { title: 'branch', lines: [stripBranch(x.branch) || '—', `src ${src.ref || '—'}`] },
    { title: 'session', lines: [x.zee_title || (x.claude_session_id ? x.claude_session_id.slice(0, 8) : '—'),
      x.zee_status === 'working' ? (x.zee_name || 'working') : (x.zee_status || '')] },
    { title: 'containers', kind: 'stack', stack: cont },
    { title: 'machine', lines: [machineOf(x, machines) || '—', x.runtime_label || ''] },
    { title: 'commit', lines: [(x.is_production ? x.deployed_commit : x.head_commit)?.slice(0, 8) || '—',
      `src ${sd}`] },
    { title: 'diff · age', lines: [`◈ ${own}`, ageText(x.created_at) ? `age ${ageText(x.created_at)}` : ''] },
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

  if (facet.kind === 'stack') {
    const roles = facet.stack;
    const gapx = size * 0.42;
    const y = cy + size * 0.02;
    ctx.textBaseline = 'middle';
    roles.forEach((rr, i) => {
      const px = cx + (i - 1) * gapx;
      ctx.beginPath(); ctx.arc(px, y - 6, 5, 0, Math.PI * 2);
      ctx.fillStyle = rr.health ? (HEALTH[rr.health] || COL.muted) : withAlpha(COL.muted, 0.4);
      ctx.fill();
      ctx.fillStyle = COL.muted;
      ctx.font = `9px 'Segoe UI', sans-serif`;
      ctx.fillText(rr.r === 'webapp' ? 'app' : rr.r, px, y + 9);
    });
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
