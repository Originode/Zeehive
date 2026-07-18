import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { hexPath, pointInHex, flowerCenters, layoutHoneycomb, hexWidth } from './hex.js';
import { computeGraph } from './graph.js';

// ── palette ───────────────────────────────────────────────────────────────────
const COL = {
  bg: '#0d1017', panel: '#161b24', line: '#2a3242', text: '#e6ebf2', muted: '#8b97a8',
  working: '#35c46b', idle: '#e0a53b', ready: '#5b8cff', claimed: '#9b8cff',
  awaiting: '#e0a53b', spawning: '#5b8cff', error: '#e5554e', prod: '#f2c14e',
};
const HEALTH = { up: '#35c46b', building: '#e0a53b', down: '#e5554e', unknown: '#6b7688', starting: '#5b8cff' };
const LANE = ['#e0a53b', '#e26fae', '#9ccf3f', '#5b8cff', '#35c46b', '#9b8cff',
  '#e5554e', '#3bc6c0', '#d98c5f', '#7bd0e0', '#c98cff', '#8cd98c'];

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
// A one-glyph runtime hint for the compact hex (Claude → ✦, others → first letter).
function runtimeGlyph(x) {
  const l = (x.runtime_label || '').toLowerCase();
  if (!l) return '';
  if (l.includes('claude')) return '✦';
  return (x.runtime_label[0] || '').toUpperCase();
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

// truncate a string to fit `maxW` px in the current ctx font, adding an ellipsis.
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

// The geometry frame for a given timeline edge: the honeycomb rect, plus how the timeline band
// lays out (which coord runs ALONG the timeline vs ACROSS it, where the honey-facing merge edge is,
// and which way the lanes grow away from the honeycomb).
const VBAND = 168, HBAND = 138, AXIS_MARGIN = 16;
function frameFor(edge, w, h) {
  if (edge === 'right') {
    const bx = w - VBAND;
    return { vertical: true, honey: { x: 0, y: 0, w: bx, h }, band: { x: bx, y: 0, w: VBAND, h },
      mergeAcross: bx + AXIS_MARGIN, laneDir: 1, alongStart: 20, alongEnd: h - 20 };
  }
  if (edge === 'left') {
    return { vertical: true, honey: { x: VBAND, y: 0, w: w - VBAND, h }, band: { x: 0, y: 0, w: VBAND, h },
      mergeAcross: VBAND - AXIS_MARGIN, laneDir: -1, alongStart: 20, alongEnd: h - 20 };
  }
  if (edge === 'top') {
    return { vertical: false, honey: { x: 0, y: HBAND, w, h: h - HBAND }, band: { x: 0, y: 0, w, h: HBAND },
      mergeAcross: HBAND - AXIS_MARGIN, laneDir: -1, alongStart: 24, alongEnd: w - 24 };
  }
  // default: bottom
  const by = h - HBAND;
  return { vertical: false, honey: { x: 0, y: 0, w, h: by }, band: { x: 0, y: by, w, h: HBAND },
    mergeAcross: by + AXIS_MARGIN, laneDir: 1, alongStart: 24, alongEnd: w - 24 };
}

// A xell's machine (from its server container's docker context), for the flower's machine facet.
function machineOf(x, machines) {
  const ctx = (x.stack || []).find((c) => c.role === 'server' && c.docker_ctx)?.docker_ctx
    || (x.stack || []).find((c) => c.docker_ctx)?.docker_ctx || null;
  if (!ctx) return null;
  const m = (machines || []).find((mm) => mm.docker_ctx === ctx);
  return m ? (m.key || m.label || ctx) : ctx;
}

export default function HiveCanvas({ xells, diffs, timeline, edge, onOpenSession, machines,
                                    expandedId, onExpand }) {
  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const geomRef = useRef({ hexes: [], flower: null });
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hoverId, setHoverId] = useState(null);
  const rafRef = useRef(0);
  const setExpandedId = onExpand || (() => {});

  // The xell currently expanded into a flower — resolved fresh each render so live updates flow.
  const expanded = expandedId ? (xells || []).find((x) => x.id === expandedId) : null;
  // If the expanded xell disappears (reaped), fall back to the honeycomb.
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
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const list = xells || [];
    const fr = frameFor(edge, w, h);
    const toXY = fr.vertical ? (along, across) => [across, along] : (along, across) => [along, across];

    // colour + base-commit per xell from the timeline (anchors the connectors).
    const tById = {};
    for (const tx of (timeline?.xells || [])) tById[tx.id] = tx;

    // 1) honeycomb layout
    const lay = layoutHoneycomb(list.length, fr.honey.w, fr.honey.h);
    const hexes = list.map((x, i) => {
      const cell = lay.cells[i] || { cx: fr.honey.w / 2, cy: fr.honey.h / 2 };
      return { x, id: x.id, cx: fr.honey.x + cell.cx, cy: fr.honey.y + cell.cy, size: lay.size,
        color: tById[x.id]?.color || null };
    });
    const hexById = {};
    for (const hx of hexes) hexById[hx.id] = hx;

    // 2) timeline commit positions (along the axis) + lanes
    const commits = timeline?.commits || [];
    let commitPos = {};
    let graph = null;
    if (commits.length) {
      graph = computeGraph(commits);
      const span = fr.alongEnd - fr.alongStart;
      const gap = Math.max(11, Math.min(30, span / Math.max(1, commits.length - 1)));
      const total = gap * (commits.length - 1);
      const start = fr.alongStart + Math.max(0, (span - total) / 2);
      const laneW = Math.max(7, Math.min(13, (VBAND - AXIS_MARGIN - 96) / Math.max(1, graph.laneCount)));
      for (const { c, lane, row } of graph.rows) {
        const along = start + row * gap;
        const across = fr.mergeAcross + fr.laneDir * lane * laneW;
        commitPos[c.hash] = { along, across, lane, row, laneW,
          dot: toXY(along, across), merge: toXY(along, fr.mergeAcross) };
      }
      // stash for label/edge drawing
      commitPos.__meta = { gap, laneW, start };
    }

    // 3) connectors — merge point (honey edge) → hex centre, coloured per xell. Drawn first so hexes
    //    and the timeline sit on top. Origin on the honey side = "merge points face the honeycomb".
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    for (const tx of (timeline?.xells || [])) {
      const hx = hexById[tx.id];
      const cp = commitPos[tx.base_commit];
      if (!hx || !cp) continue;
      const [mx, my] = cp.merge;
      const col = tx.color || COL.muted;
      ctx.strokeStyle = expandedId ? withAlpha(col, 0.18) : withAlpha(col, 0.85);
      ctx.beginPath();
      ctx.moveTo(mx, my);
      // bow the curve out toward the honeycomb so traces read as roots, not straight spokes.
      const midx = (mx + hx.cx) / 2, midy = (my + hx.cy) / 2;
      const bow = fr.vertical ? [midx, my] : [mx, midy];
      ctx.quadraticCurveTo(bow[0], bow[1], hx.cx, hx.cy);
      ctx.stroke();
      // solder pad at the merge edge
      ctx.fillStyle = ctx.strokeStyle;
      ctx.beginPath(); ctx.arc(mx, my, 2.6, 0, Math.PI * 2); ctx.fill();
    }

    // 4) timeline band
    drawTimeline(ctx, fr, commits, graph, commitPos, toXY, timeline?.branch, expandedId);

    // 5) honeycomb hexes (compact)
    geomRef.current.hexes = hexes;
    for (const hx of hexes) {
      const dim = expandedId && expandedId !== hx.id;
      drawCompactHex(ctx, hx, { hover: hoverId === hx.id, dim, diff: diffs?.[hx.id] });
    }

    // 6) flower overlay
    geomRef.current.flower = null;
    if (expanded) {
      // scrim over the honeycomb (not the timeline band) so the flower reads as focus
      ctx.fillStyle = 'rgba(8,10,15,0.62)';
      ctx.fillRect(fr.honey.x, fr.honey.y, fr.honey.w, fr.honey.h);
      const fsize = Math.min(
        Math.min(fr.honey.w, fr.honey.h) / 6.2,
        118,
      );
      const fcx = fr.honey.x + fr.honey.w / 2;
      const fcy = fr.honey.y + fr.honey.h / 2;
      drawFlower(ctx, fcx, fcy, fsize, expanded, diffs?.[expanded.id], machines);
      geomRef.current.flower = { cx: fcx, cy: fcy, size: fsize, id: expanded.id,
        openable: !!expanded.viewer_url && !expanded.is_production };
    }
  }, [size, xells, diffs, timeline, edge, expandedId, hoverId, expanded, machines]);

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

  // ── interaction ─────────────────────────────────────────────────────────────
  const hitHex = useCallback((mx, my) => {
    for (const hx of geomRef.current.hexes) if (pointInHex(mx, my, hx.cx, hx.cy, hx.size)) return hx;
    return null;
  }, []);
  const inFlower = useCallback((mx, my) => {
    const f = geomRef.current.flower;
    if (!f) return false;
    for (const [cx, cy] of flowerCenters(f.cx, f.cy, f.size)) if (pointInHex(mx, my, cx, cy, f.size)) return true;
    return false;
  }, []);

  const relPos = (e) => {
    const r = canvasRef.current.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };

  const onMove = (e) => {
    const [mx, my] = relPos(e);
    let cursor = 'default';
    if (expandedId) {
      const f = geomRef.current.flower;
      cursor = inFlower(mx, my) ? (f?.openable ? 'pointer' : 'default') : 'default';
      if (hoverId) setHoverId(null);
    } else {
      const hx = hitHex(mx, my);
      const id = hx?.id || null;
      if (id !== hoverId) {
        if (rafRef.current) cancelAnimationFrame(rafRef.current);
        rafRef.current = requestAnimationFrame(() => setHoverId(id));
      }
      cursor = hx ? 'pointer' : 'default';
    }
    canvasRef.current.style.cursor = cursor;
  };

  const onClick = (e) => {
    const [mx, my] = relPos(e);
    if (expandedId) {
      if (inFlower(mx, my)) {
        const f = geomRef.current.flower;
        if (f?.openable) { const x = (xells || []).find((xx) => xx.id === f.id); if (x) onOpenSession?.(x); }
        return;   // clicking the flower opens the session (or does nothing for prod)
      }
      setExpandedId(null);   // click outside collapses
      return;
    }
    const hx = hitHex(mx, my);
    if (hx) setExpandedId(hx.id);
  };

  const onLeave = () => { if (hoverId) setHoverId(null); };

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && expandedId) setExpandedId(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expandedId]);

  return (
    <div ref={wrapRef} className="hive-canvas-wrap">
      <canvas ref={canvasRef} className="hive-canvas"
              style={{ width: size.w, height: size.h, display: 'block' }}
              onMouseMove={onMove} onClick={onClick} onMouseLeave={onLeave} />
      {(!xells || xells.length === 0) && (
        <p className="hive-empty">No active xells. The pool maintainer will fill it shortly…</p>
      )}
    </div>
  );
}

// ── drawing primitives ─────────────────────────────────────────────────────────
function withAlpha(hex, a) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function drawCompactHex(ctx, hx, { hover, dim, diff }) {
  const { cx, cy, size, x } = hx;
  const col = statusColor(x);
  ctx.save();
  if (dim) ctx.globalAlpha = 0.32;
  // fill
  hexPath(ctx, cx, cy, size);
  const g = ctx.createLinearGradient(cx, cy - size, cx, cy + size);
  g.addColorStop(0, withAlpha(col, hover ? 0.34 : 0.20));
  g.addColorStop(1, withAlpha(col, hover ? 0.20 : 0.10));
  ctx.fillStyle = g;
  ctx.fill();
  // seam / border
  ctx.lineWidth = hover ? 2.4 : 1.4;
  ctx.strokeStyle = hover ? col : withAlpha(col, 0.6);
  ctx.stroke();

  // connector-colour ring (ties the hex to its commit anchor)
  if (hx.color) {
    hexPath(ctx, cx, cy, size - 3);
    ctx.lineWidth = 1.4; ctx.strokeStyle = withAlpha(hx.color, 0.9); ctx.stroke();
  }

  const w = hexWidth(size);
  // only render text when the hex is big enough to be legible
  if (size >= 30) {
    // production shield / status dot at top
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    if (x.is_production) {
      ctx.font = `${Math.min(15, size * 0.34)}px 'Segoe UI', sans-serif`;
      ctx.fillStyle = COL.prod;
      ctx.fillText('🛡', cx, cy - size * 0.42);
    } else {
      ctx.beginPath(); ctx.arc(cx, cy - size * 0.44, Math.max(2.5, size * 0.07), 0, Math.PI * 2);
      ctx.fillStyle = col; ctx.fill();
      if (x.zee_status === 'working') { ctx.strokeStyle = withAlpha(col, 0.5); ctx.lineWidth = 2; ctx.stroke(); }
    }
    // slug (main label) — abbreviated to fit
    ctx.fillStyle = COL.text;
    ctx.font = `600 ${Math.min(13, Math.max(9, size * 0.24))}px 'Segoe UI', sans-serif`;
    const label = x.is_production ? 'PRODUCTION' : shortSlug(x.slug);
    ctx.fillText(fit(ctx, label, w * 0.82), cx, cy + size * 0.02);
    // status word + runtime glyph
    if (size >= 40) {
      ctx.font = `${Math.min(10, size * 0.18)}px 'Segoe UI', sans-serif`;
      ctx.fillStyle = COL.muted;
      const sub = x.is_production ? 'live' : x.status;
      ctx.fillText(fit(ctx, sub, w * 0.7), cx, cy + size * 0.34);
      const gl = runtimeGlyph(x);
      if (gl && !x.is_production) {
        ctx.fillStyle = withAlpha(col, 0.9);
        ctx.font = `${Math.min(11, size * 0.2)}px 'Segoe UI', sans-serif`;
        ctx.fillText(gl, cx, cy + size * 0.58);
      }
    }
    // dirty marker
    if (diff && diff.dirty > 0 && size >= 34) {
      ctx.fillStyle = COL.idle;
      ctx.beginPath(); ctx.arc(cx + w * 0.34, cy - size * 0.34, 3, 0, Math.PI * 2); ctx.fill();
    }
  } else {
    // tiny hex: just a centred status dot
    ctx.beginPath(); ctx.arc(cx, cy, Math.max(2, size * 0.22), 0, Math.PI * 2);
    ctx.fillStyle = col; ctx.fill();
  }
  ctx.restore();
}

// The timeline band: commit graph lanes + dots + hash/subject labels (slanted in portrait).
function drawTimeline(ctx, fr, commits, graph, commitPos, toXY, branch, expandedId) {
  if (!commits.length || !graph) return;
  ctx.save();
  if (expandedId) ctx.globalAlpha = 0.5;
  const meta = commitPos.__meta || {};
  const laneW = meta.laneW || 12;

  // faint divider line marking where the timeline bisects the viewport (the merge edge)
  ctx.strokeStyle = withAlpha(COL.line, 1);
  ctx.lineWidth = 1;
  ctx.beginPath();
  if (fr.vertical) {
    const [x0] = toXY(fr.alongStart, fr.mergeAcross - fr.laneDir * 6);
    ctx.moveTo(x0, fr.honey.y); ctx.lineTo(x0, fr.honey.y + fr.honey.h);
  } else {
    const [, y0] = toXY(fr.alongStart, fr.mergeAcross - fr.laneDir * 6);
    ctx.moveTo(fr.honey.x, y0); ctx.lineTo(fr.honey.x + fr.honey.w, y0);
  }
  ctx.stroke();

  // lane edges (parent lines)
  ctx.lineWidth = 1.6;
  for (const e of graph.edges) {
    const cFrom = commits[e.fromRow]?.hash;
    const from = cFrom && commitPos[cFrom];
    const toHash = commits[e.toRow]?.hash;
    const to = toHash && commitPos[toHash];
    if (!from) continue;
    const fromAcross = fr.mergeAcross + fr.laneDir * e.fromLane * laneW;
    const toAcross = fr.mergeAcross + fr.laneDir * e.toLane * laneW;
    const fromAlong = from.along;
    const toAlong = to ? to.along : (fr.vertical ? fr.honey.y + fr.honey.h : fr.honey.x + fr.honey.w);
    const [x1, y1] = toXY(fromAlong, fromAcross);
    const [x2, y2] = toXY(toAlong, toAcross);
    ctx.strokeStyle = withAlpha(LANE[e.fromLane % LANE.length], 0.8);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    if (fromAcross === toAcross) ctx.lineTo(x2, y2);
    else {
      // gentle S between lanes
      const mAlong = (fromAlong + toAlong) / 2;
      const [cx1, cy1] = toXY(mAlong, fromAcross);
      const [cx2, cy2] = toXY(mAlong, toAcross);
      ctx.bezierCurveTo(cx1, cy1, cx2, cy2, x2, y2);
    }
    ctx.stroke();
  }

  // dots + labels
  ctx.textBaseline = 'middle';
  for (const { c, lane, row } of graph.rows) {
    const cp = commitPos[c.hash];
    if (!cp) continue;
    const [dx, dy] = cp.dot;
    const isMerge = c.parents.length > 1;
    ctx.beginPath(); ctx.arc(dx, dy, isMerge ? 4.5 : 3.4, 0, Math.PI * 2);
    ctx.fillStyle = isMerge ? COL.bg : LANE[lane % LANE.length];
    ctx.fill();
    if (isMerge) { ctx.lineWidth = 2; ctx.strokeStyle = LANE[lane % LANE.length]; ctx.stroke(); }

    // label
    const hash = c.short;
    const subj = c.subject || '';
    if (fr.vertical) {
      // text on the panel side of the lanes
      const tx = fr.mergeAcross + fr.laneDir * (graph.laneCount * laneW + 8);
      ctx.textAlign = fr.laneDir > 0 ? 'left' : 'right';
      ctx.font = `10px 'Cascadia Code', monospace`;
      ctx.fillStyle = COL.muted;
      ctx.fillText(hash, tx, dy);
      const hw = ctx.measureText(hash).width + 6;
      ctx.font = `11px 'Segoe UI', sans-serif`;
      ctx.fillStyle = COL.text;
      const room = fr.laneDir > 0 ? (fr.band.x + fr.band.w - (tx + hw) - 6) : (tx - hw - fr.band.x - 6);
      ctx.fillText(fit(ctx, subj, Math.max(20, room)), tx + fr.laneDir * hw, dy);
      if (row === 0) {
        ctx.fillStyle = COL.ready; ctx.font = `10px 'Cascadia Code', monospace`;
        ctx.textAlign = 'center';
        ctx.fillText('⎇ ' + (branch || ''), dx, dy - 12);
      }
    } else {
      // PORTRAIT: slant the hash/subject diagonally off each dot
      ctx.save();
      ctx.translate(dx, dy + fr.laneDir * -2);
      ctx.rotate(fr.laneDir > 0 ? (34 * Math.PI) / 180 : (-34 * Math.PI) / 180);
      ctx.textAlign = fr.laneDir > 0 ? 'left' : 'right';
      const off = fr.laneDir > 0 ? 8 : -8;
      ctx.font = `10px 'Cascadia Code', monospace`;
      ctx.fillStyle = COL.muted;
      ctx.fillText(hash, off, 0);
      const hw = ctx.measureText(hash).width + 5;
      ctx.font = `11px 'Segoe UI', sans-serif`;
      ctx.fillStyle = COL.text;
      ctx.fillText(fit(ctx, subj, 90), off + fr.laneDir * hw, 0);
      ctx.restore();
      if (row === 0) {
        ctx.fillStyle = COL.ready; ctx.font = `10px 'Cascadia Code', monospace`;
        ctx.textAlign = 'center';
        ctx.fillText('⎇ ' + (branch || ''), dx, dy + fr.laneDir * -14);
      }
    }
  }
  ctx.restore();
}

// ── the flower: one xell blown up into 7 hexes (centre + 6 facet petals) ────────
function drawFlower(ctx, cx, cy, size, x, diff, machines) {
  const centers = flowerCenters(cx, cy, size);
  const col = statusColor(x);

  const petals = flowerFacets(x, diff, machines);
  // petals[0] is the centre; 1..6 the ring
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
    ctx.strokeStyle = isCenter ? col : withAlpha(col, 0.4);
    ctx.stroke();
    ctx.clip();   // keep text inside the petal
    drawFacet(ctx, hx, hy, size, facet, col, isCenter, x);
    ctx.restore();
  });

  // hint ribbon under the flower
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = `11px 'Segoe UI', sans-serif`;
  ctx.fillStyle = COL.muted;
  const hint = x.is_production ? 'production — protected'
    : x.viewer_url ? 'click to open this session · Esc / click away to close'
    : 'no live session · Esc / click away to close';
  ctx.fillText(hint, cx, cy + size * 2 + 6);
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
    // centre
    { title: null, lines: [x.is_production ? 'PRODUCTION' : shortSlug(x.slug),
      x.is_production ? 'live · protected' : x.status] },
    // ring
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
    ctx.font = `700 ${Math.min(16, size * 0.2)}px 'Segoe UI', sans-serif`;
    ctx.fillText(fit(ctx, facet.lines[0], size * 1.5), cx, cy - size * 0.12);
    ctx.fillStyle = withAlpha(col, 0.95);
    ctx.font = `${Math.min(12, size * 0.15)}px 'Segoe UI', sans-serif`;
    ctx.fillText(fit(ctx, facet.lines[1], size * 1.5), cx, cy + size * 0.2);
    return;
  }
  // title
  ctx.textBaseline = 'top';
  ctx.fillStyle = withAlpha(col, 0.9);
  ctx.font = `600 ${Math.min(10, size * 0.14)}px 'Segoe UI', sans-serif`;
  ctx.fillText(String(facet.title || '').toUpperCase(), cx, cy - size * 0.5);

  if (facet.kind === 'stack') {
    // three health dots with role letters
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
  // up to two value lines
  ctx.textBaseline = 'middle';
  ctx.fillStyle = COL.text;
  ctx.font = `${Math.min(12, size * 0.15)}px 'Segoe UI', sans-serif`;
  ctx.fillText(fit(ctx, facet.lines[0] || '—', size * 1.45), cx, cy);
  if (facet.lines[1]) {
    ctx.fillStyle = COL.muted;
    ctx.font = `${Math.min(10, size * 0.13)}px 'Segoe UI', sans-serif`;
    ctx.fillText(fit(ctx, facet.lines[1], size * 1.45), cx, cy + size * 0.28);
  }
}
