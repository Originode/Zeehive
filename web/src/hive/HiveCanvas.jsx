import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { hexPath, pointInHex, hexWidth, rowStep, layoutHoneycomb, SQRT3 } from './hex.js';
import { hiveColor, hiveStatusLabel } from './status.js';

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

// Colour a hex by its DISPLAY status (server-derived `hive_status`, palette in hive/status.js) — the
// single vocabulary the whole hive reads by: vac-* / occ-* (incl. the tend/land/ship/done requests) /
// live-*. Falls back to the legacy lifecycle→colour map for a payload that predates hive_status.
function statusColor(x) {
  if (x.hive_status) return hiveColor(x.hive_status, COL.muted);
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
// compact burn formatters (mirror the dashboard's fmtTok/fmtUsd) for the per-xell burn on the flower
const fmtTok = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n || 0));
const fmtUsd = (n) => '$' + (n >= 100 ? Math.round(n) : (n || 0).toFixed(2));

// A zee is ACTIVELY WORKING when its CLI is live (cli_active) or it reports the working status.
// The honeycomb shows that with a yellow blinking dot beside the diff; the animation loop that makes
// it blink only runs while at least one xell is busy (see the effect in HiveCanvas).
const isBusyZee = (x) => !x.is_production && (x.cli_active === true || x.zee_status === 'working');
function drawBusyDot(ctx, x, y, r) {
  const a = 0.2 + 0.8 * (0.5 + 0.5 * Math.sin(performance.now() / 300));   // blink
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = withAlpha('#ffd93b', a);
  ctx.shadowColor = '#ffd93b'; ctx.shadowBlur = r * 1.6 * a;
  ctx.fill();
  ctx.restore();
}
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

// ── text that FILLS its hex ────────────────────────────────────────────────────
// The honeycomb used to pin every label to a fixed fraction of the hex radius (`size * 0.15` …),
// capped small — so a hex could be huge and its diffstat still a whisper. These three helpers size
// text to the room it actually has instead: measure it, grow it to fill the width, and wrap it onto
// a second line rather than shrink-to-truncate when a single line won't fit.

// Interior half-width of a pointy-top hex `dy` above/below its centre. The full flat-width holds
// within the middle band (|dy| ≤ size/2) then tapers straight to the top/bottom vertex — so a line
// drawn off-centre knows the real room it has and text can fill right up to the slanted edges
// without spilling past them.
function hexHalfWidthAt(size, dy) {
  const w = hexWidth(size) / 2;
  const a = Math.abs(dy);
  if (a <= size / 2) return w;
  if (a >= size) return 0;
  return (w * (size - a)) / (size / 2);
}

// Grow a font to FILL `maxW`: binary-search a pixel size in [minPx,maxPx] so `text` is as wide as it
// can be without crossing maxW. `fontFn(px)` builds the CSS font string (weight/family are the
// caller's). Leaves ctx.font set to the winner and returns the chosen px. This is the core of
// "size text to fill the space" — text is measured and scaled up, not fixed to the hex radius.
function fillFont(ctx, text, maxW, minPx, maxPx, fontFn) {
  if (maxPx <= minPx) { ctx.font = fontFn(minPx); return minPx; }
  let lo = minPx, hi = maxPx, best = minPx;
  for (let i = 0; i < 16; i++) {
    const mid = (lo + hi) / 2;
    ctx.font = fontFn(mid);
    if (ctx.measureText(text).width <= maxW) { best = mid; lo = mid; } else hi = mid;
  }
  ctx.font = fontFn(best);
  return best;
}

// Break `text` into at most `maxLines` lines that each fit `maxW` at the CURRENT ctx.font, splitting
// at word/slug joints (space / slash / underscore / hyphen) so a long branch like
// `adjust-text-sizes-…` wraps at its dashes instead of being cut off. Only the overflowing final
// line is ellipsised — wrap first, truncate as a last resort. One line is returned when it fits.
function wrapText(ctx, text, maxW, maxLines = 2) {
  text = String(text ?? '');
  if (maxLines <= 1 || ctx.measureText(text).width <= maxW) return [fit(ctx, text, maxW)];
  const toks = text.match(/[^\s/_-]+[\s/_-]*|[\s/_-]+/g) || [text];
  const lines = [];
  let cur = '';
  for (let i = 0; i < toks.length; i++) {
    const tk = toks[i];
    if (cur && ctx.measureText(cur + tk).width > maxW) {
      lines.push(fit(ctx, cur.trimEnd(), maxW));
      cur = tk;
      if (lines.length === maxLines - 1) { cur += toks.slice(i + 1).join(''); break; }
    } else {
      cur += tk;
    }
  }
  lines.push(fit(ctx, cur.trimEnd(), maxW));
  return lines;
}

// Draw a coloured diffstat (the git-convention +ins/−del run) sized to FILL its hex, wrapping onto a
// second line when it can't fit one. `parts` is the [{t,c}] run; `split` is the index the row breaks
// at (head above, tail below) when wrapping is allowed. Returns `{ y, width, wrapped }` describing the
// first drawn line, so the caller can pin the "actively working" dot beside it.
function drawDiffFilled(ctx, cx, cy, parts, { maxW, minPx, maxPx, weight = 600, split = null }) {
  const fontFn = (px) => `${weight} ${px}px 'Cascadia Code', monospace`;
  const full = parts.map((p) => p.t).join('');
  ctx.font = fontFn(minPx);
  const wrap = split != null && split > 0 && split < parts.length && ctx.measureText(full).width > maxW;
  if (!wrap) {
    fillFont(ctx, full, maxW, minPx, maxPx, fontFn);
    drawDiffRow(ctx, cx, cy, parts);
    return { y: cy, width: ctx.measureText(full).width, wrapped: false };
  }
  const head = parts.slice(0, split), tail = parts.slice(split);
  const headTxt = head.map((p) => p.t).join(''), tailTxt = tail.map((p) => p.t).join('');
  // both lines share one size (the smaller of the two fits) so the stat reads as one unit
  const pxH = fillFont(ctx, headTxt, maxW, minPx, maxPx, fontFn);
  const pxT = fillFont(ctx, tailTxt, maxW, minPx, maxPx, fontFn);
  const px = Math.min(pxH, pxT);
  const gap = px * 0.32;
  const y1 = cy - (px + gap) / 2, y2 = cy + (px + gap) / 2;
  ctx.font = fontFn(px);
  drawDiffRow(ctx, cx, y1, head);
  drawDiffRow(ctx, cx, y2, tail);
  return { y: y1, width: ctx.measureText(headTxt).width, wrapped: true };
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

// The CONTAINERS facet draws its three container icons at 75% of their natural size (operator ask:
// smaller icons). Both the drawer AND the right-click hit-test read the geometry from ONE place so a
// click lands exactly on the box that was painted.
const CONTAINER_ICON_SCALE = 0.75;
function containerBoxLayout(cx, cy, size) {
  const boxW = size * 0.42 * CONTAINER_ICON_SCALE;
  const boxH = size * 0.56 * CONTAINER_ICON_SCALE;
  const gapx = size * 0.46;                       // spacing unchanged — only the boxes shrink
  const y = cy + size * 0.08;
  return { boxW, boxH, gapx, y, cxOf: (i) => cx + (i - 1) * gapx };
}
// World-space rects of the expanded flower's container icons (CONTAINERS petal = centers[3]), each
// carrying its FULL stack container so a right-click can open the same ContainerMenu the inventory
// uses. Present containers only — an absent slot is a dashed placeholder with nothing to act on.
const STACK_ROLES = ['db', 'server', 'webapp'];
function flowerContainerRects(centers, size, x) {
  const c3 = centers[3];
  if (!c3) return [];
  const [cx, cy] = c3;
  const { boxW, boxH, y, cxOf } = containerBoxLayout(cx, cy, size);
  const stack = x.stack || [];
  const out = [];
  STACK_ROLES.forEach((role, i) => {
    const c = stack.find((s) => s.role === role);
    if (!c) return;
    const px = cxOf(i);
    out.push({ x: px - boxW / 2, y: y - boxH / 2, w: boxW, h: boxH, c });
  });
  return out;
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
                                    expandedId, onExpand, hexPosRef, onGeometry, onAction, onContainerMenu,
                                    hoverRef, setHover, subscribeHover }) {
  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const geomRef = useRef({ hexes: [], flower: null, buttons: null, containers: null });
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
    geomRef.current.buttons = null;
    geomRef.current.containers = null;
    if (expanded && cells[expanded.id]) {
      const [er, ec] = cells[expanded.id];
      const centers = [cellCenter(er, ec, cellSize, originX, originY),
        ...cellNeighbors(er, ec).map(([r, c]) => cellCenter(r, c, cellSize, originX, originY))];
      drawFlower(ctx, centers, cellSize, expanded, diffs?.[expanded.id], machines);
      geomRef.current.flower = { centers, size: cellSize, id: expanded.id,
        openable: !!expanded.viewer_url && !expanded.is_production };
      // Per-xell ACTIONS drawn straight onto the flower (no DOM toolbar): a hit-tested button row
      // under the bloom. Their world-space rects are recorded so onPointerUp can dispatch onAction.
      geomRef.current.buttons = drawFlowerButtons(ctx, centers, cellSize, expanded, diffs?.[expanded.id]);
      // Container icons in the CONTAINERS petal are right-clickable — record their rects so a
      // context-menu event can open the same ContainerMenu the inventory chips use.
      geomRef.current.containers = flowerContainerRects(centers, cellSize, expanded);
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

  // Blink loop for the "actively working" dot — runs ONLY while at least one zee is busy, and
  // throttles to ~9fps (a redraw of the whole honeycomb is not free). When nothing is working the
  // loop never starts, so an idle fleet costs zero animation frames.
  useEffect(() => {
    const anyBusy = (xells || []).some(isBusyZee);
    if (!anyBusy) return undefined;
    let raf = 0, last = 0;
    const loop = (t) => {
      if (t - last > 110) { last = t; draw(); }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [xells, draw]);

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
  const hitButton = useCallback((wx, wy) => {
    const bs = geomRef.current.buttons;
    if (!bs) return null;
    for (const b of bs) if (wx >= b.x && wx <= b.x + b.w && wy >= b.y && wy <= b.y + b.h) return b;
    return null;
  }, []);
  const hitContainer = useCallback((wx, wy) => {
    const cs = geomRef.current.containers;
    if (!cs) return null;
    for (const r of cs) if (wx >= r.x && wx <= r.x + r.w && wy >= r.y && wy <= r.y + r.h) return r.c;
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
      const b = hitButton(wx, wy);
      const f = hitFlower(wx, wy);
      cursor = b || (f && f.cell === 0 && f.openable) ? 'pointer'
        : hitContainer(wx, wy) ? 'context-menu' : 'default';   // right-click hint on an icon
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
      // Action buttons first — they sit just below the flower and own their clicks.
      const b = hitButton(wx, wy);
      if (b) {
        const x = (xells || []).find((xx) => xx.id === expandedId);
        if (x) onAction?.(b.kind, x, diffs?.[expandedId]);
        return;
      }
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

  // Right-click a container icon in the expanded flower → open the SAME context menu the inventory
  // chips use. Only a hit preventDefaults (swallowing the browser menu); a right-click on empty
  // canvas is left alone.
  const onContextMenu = (e) => {
    if (!expandedId) return;
    const [wx, wy] = toWorld(...relPos(e));
    const c = hitContainer(wx, wy);
    if (!c) return;
    e.preventDefault();
    onContainerMenu?.(e, c);
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
              onPointerUp={onPointerUp} onMouseLeave={onLeave} onContextMenu={onContextMenu} />
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
  // Machine line, prefixed with the cage lock (🔒 caged / 🔓 uncaged) so protocol-compliance reads
  // at a glance. The lock is tinted (green/red/amber); the machine name stays muted, so the two are
  // drawn as separate colour segments, centred together.
  const mach = machineOf(x, machines);
  if (full && mach) {
    ctx.font = `${Math.max(8, size * 0.14)}px 'Segoe UI', sans-serif`;
    const lock = cageLock(x);
    const machTxt = fit(ctx, mach, w * 0.5);
    const y = cy - size * 0.62;
    if (lock) {
      const pre = lock.g + ' ';
      const preW = ctx.measureText(pre).width;
      const txtW = ctx.measureText(machTxt).width;
      const x0 = cx - (preW + txtW) / 2;
      const prev = ctx.textAlign; ctx.textAlign = 'left';
      ctx.fillStyle = lock.c; ctx.fillText(pre, x0, y);
      ctx.fillStyle = COL.muted; ctx.fillText(machTxt, x0 + preW, y);
      ctx.textAlign = prev;
    } else {
      ctx.fillStyle = COL.muted;
      ctx.fillText('⌂ ' + machTxt, cx, y);
    }
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

  // ── middle seam: identity ── grow a short slug to fill the card width (single line — it's the seam)
  const label = x.is_production ? '🛡 PRODUCTION' : shortSlug(x.slug);
  fillFont(ctx, label, w * 0.82, 8.5, size * 0.2, (p) => `600 ${p}px 'Segoe UI', sans-serif`);
  ctx.fillStyle = COL.text;
  ctx.fillText(fit(ctx, label, w * 0.82), cx, cy - (full ? size * 0.06 : size * 0.2));

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
      const parts = [
        { t: `${own.files}f `, c: COL.muted },
        { t: `+${own.insertions}`, c: COL.add },
        { t: `/−${own.deletions}`, c: COL.del },
      ];
      // fill the card width (capped so it clears the sha above and the status pill below)
      const row = drawDiffFilled(ctx, cx, y, parts, { maxW: w * 0.82, minPx: 9, maxPx: size * 0.17 });
      // yellow blinking "actively working" dot, just left of the diff row
      if (isBusyZee(x)) {
        drawBusyDot(ctx, cx - row.width / 2 - size * 0.11, y, Math.max(2.4, size * 0.055));
      }
    }
    // status pill — the DISPLAY status (occ-working / occ-tendRequest / live-protected / …)
    const st = hiveStatusLabel(x);
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
    ctx.fillText(fit(ctx, hiveStatusLabel(x), w * 0.6), cx, cy + size * 0.34);
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

// Per-hex CAGE indicator as a small inline lock GLYPH, shown before the machine name. The ︎
// (VS15) forces monochrome text presentation so ctx.fillStyle actually tints it. Reads runtime_key:
// caged → 🔒 green (confined, on-protocol); local → 🔓 red (uncaged — the one to spot); remote → 🔒
// amber. null (no zee assigned yet) → no lock, keep the plain ⌂ machine glyph.
function cageLock(x) {
  if (x.is_production) return null;
  const rk = x.runtime_key;
  if (!rk) return null;
  if (rk === 'claude-code-local') return { g: '\u{1F513}︎', c: COL.error };   // open lock
  if (rk === 'claude-code-remote') return { g: '\u{1F512}︎', c: COL.idle };   // closed, amber
  return { g: '\u{1F512}︎', c: COL.working };                                  // closed, green
}

// One canvas button centred at (cx, cy). Font must already be set. Returns its WORLD-space rect.
function drawPetalBtn(ctx, cx, cy, label, kind, accent, h, padX) {
  const w = ctx.measureText(label).width + padX * 2;
  ctx.beginPath();
  ctx.roundRect(cx - w / 2, cy - h / 2, w, h, h / 2);
  ctx.fillStyle = withAlpha(COL.panel, 0.96);
  ctx.fill();
  ctx.lineWidth = 1.2;
  ctx.strokeStyle = withAlpha(accent, 0.65);
  ctx.stroke();
  ctx.fillStyle = withAlpha(COL.text, 0.94);
  ctx.fillText(label, cx, cy + 0.5);
  return { x: cx - w / 2, y: cy - h / 2, w, h, kind };
}

// Lay out a row of 1–2 buttons centred at (cx, cy), left→right. Each btn is {label, kind, accent}.
// Returns their WORLD-space rects. (Extends the old bespoke pull/push side-by-side to any short row.)
function drawPetalRow(ctx, cx, cy, btns, { h, padX, gap, accent }) {
  const ws = btns.map((b) => ctx.measureText(b.label).width + padX * 2);
  const total = ws.reduce((a, b) => a + b, 0) + gap * (btns.length - 1);
  let x0 = cx - total / 2;
  const rects = [];
  btns.forEach((b, i) => {
    rects.push(drawPetalBtn(ctx, x0 + ws[i] / 2, cy, b.label, b.kind, b.accent || accent, h, padX));
    x0 += ws[i] + gap;
  });
  return rects;
}

// The flower's per-xell actions, drawn INSIDE the facet each verb belongs to and hit-tested in
// onPointerUp (no DOM toolbar). Placement mirrors meaning: build in CONTAINERS(3), terminal+nudge in
// SESSION(2), pull(+land) in COMMIT(5), PR(+ship) in DIFF·AGE(6), mark-done in BRANCH(1). Land and
// ship appear ONLY when the action is actually available (there is work to land / it is landed &
// clean). Buttons sit low in their petal so the facet's own text still reads above them.
function drawFlowerButtons(ctx, centers, size, x, diff) {
  if (x.is_production) return [];
  const buildable = (x.stack || []).some((c) => c.role === 'server' || c.role === 'webapp');
  const caged = x.viewer_kind === 'ssh-terminal' && !!x.viewer_url;
  const showDone = ['working', 'idle', 'claimed', 'awaiting-done'].includes(x.status);
  const canLand = !!diff && diff.ahead > 0;                       // has committed work to push to main
  const canShip = shipLine(x, diff) === 'ready';                  // landed, clean, not already in prod
  const R = COL.ready, D = COL.error, G = COL.working, P = COL.prod;
  const h = Math.max(15, size * 0.28);
  const padX = size * 0.13;
  const yOff = size * 0.5;                   // preferred depth: low in the petal, below the facet's own text
  const gap = size * 0.06;
  const opts = { h, padX, gap, accent: R };
  ctx.font = `600 ${Math.max(9, size * 0.145)}px 'Segoe UI', sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const rects = [];
  const at = (i) => centers[i];
  // A pointy-top hex narrows toward its bottom vertex, so a button parked at a fixed depth pokes out
  // through the lower slanted edges (worst for the wider two-button rows). Instead, fit each row: given
  // its measured total width, raise it just enough that its bottom corners stay inside the hex — with a
  // small inset off the stroked edge — and never lower than the preferred depth. Each row is also
  // clipped to its own petal as a hard guarantee that nothing can ever escape the hexagon.
  const halfW = hexWidth(size) / 2;                       // half flat-to-flat (widest half-width)
  const inset = size * 0.08;                              // breathing room off the edge stroke
  const rowDepth = (total) => {
    // lower-slant constraint (see pointInHex): a corner at (±total/2, dy) is inside while
    // size·halfW − (size/2)·(total/2) − halfW·dy ≥ 0, i.e. dy ≤ size·(1 − total/(4·halfW)).
    const yMax = size * (1 - total / (4 * halfW)) - h / 2 - inset;
    return Math.max(size * 0.28, Math.min(yOff, yMax));   // fit, but keep clear of the facet text above
  };
  const row = (i, btns) => {
    if (!btns.length || !at(i)) return;
    const total = btns.reduce((a, b) => a + ctx.measureText(b.label).width + padX * 2, 0) + gap * (btns.length - 1);
    const [px, py] = at(i);
    ctx.save();
    hexPath(ctx, px, py, size - 1.5);
    ctx.clip();
    rects.push(...drawPetalRow(ctx, px, py + rowDepth(total), btns, opts));
    ctx.restore();
  };

  // build → CONTAINERS petal
  if (buildable) row(3, [{ label: '🔨 build', kind: 'build' }]);
  // terminal + nudge → SESSION petal (both act on the live zee; only a caged zee is reachable)
  {
    const s = [];
    if (caged) s.push({ label: '⌨ terminal', kind: 'terminal' });
    if (caged) s.push({ label: '💬 nudge', kind: 'nudge', accent: G });
    row(2, s);
  }
  // pull, and LAND when there is work to land → COMMIT petal
  {
    const s = [{ label: '↓ pull', kind: 'pull' }];
    if (canLand) s.push({ label: '⬆ land', kind: 'land', accent: G });
    row(5, s);
  }
  // PR, and SHIP when it is shippable → DIFF·AGE petal
  {
    const s = [{ label: 'PR', kind: 'pr' }];
    if (canShip) s.push({ label: '🚀 ship', kind: 'ship', accent: P });
    row(6, s);
  }
  // mark-done → BRANCH petal (the teardown verb, kept away from the git actions)
  if (showDone) {
    const label = x.status === 'awaiting-done' ? '✓ confirm done' : (x.task_id ? '✓ mark done' : '✕ clean up');
    row(1, [{ label, kind: 'done', accent: D }]);
  }
  return rects;
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
      hiveStatusLabel(x)] },
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
    const titleMaxW = hexHalfWidthAt(size, 0) * 2 * 0.86;
    // grow a short slug to fill the bloom; a long one drops to min and wraps onto a second line
    const px = fillFont(ctx, facet.lines[0], titleMaxW, 11, Math.min(22, size * 0.26),
      (p) => `700 ${p}px 'Segoe UI', sans-serif`);
    const lines = wrapText(ctx, facet.lines[0], titleMaxW, 2);
    const lh = px * 1.06;
    const y0 = cy - size * 0.08 - ((lines.length - 1) * lh) / 2;
    ctx.fillStyle = COL.text;
    lines.forEach((ln, i) => ctx.fillText(ln, cx, y0 + i * lh));
    ctx.fillStyle = withAlpha(col, 0.95);
    fillFont(ctx, facet.lines[1], titleMaxW, 9, Math.min(14, size * 0.17),
      (p) => `${p}px 'Segoe UI', sans-serif`);
    ctx.fillText(facet.lines[1], cx, cy + size * 0.32 + ((lines.length - 1) * lh) / 2);
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
    const { boxW, boxH, y, cxOf } = containerBoxLayout(cx, cy, size);
    roles.forEach((rr, i) => {
      const px = cxOf(i);
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

  // COMMIT facet: sha, the source diff (↑ahead ↓behind · files, git-coloured +ins/−del), and this
  // xell's own BURN (tokens + $ its zees have consumed). Stacked above the pull/push buttons.
  if (facet.kind === 'commitdiff') {
    ctx.textBaseline = 'middle';
    ctx.fillStyle = COL.text;
    // sha grows to fill the petal width (this facet is crowded with the burn line + pull/push
    // buttons below, so it stays single-line — width-fill only, no wrap).
    const shaW = hexHalfWidthAt(size, size * 0.16) * 2 * 0.9;
    fillFont(ctx, facet.lines[0] || '—', shaW, 9, size * 0.22,
      (px) => `600 ${px}px 'Cascadia Code', monospace`);
    ctx.fillText(facet.lines[0] || '—', cx, cy - size * 0.16);
    const d = facet.diff;
    if (d) {
      const dW = hexHalfWidthAt(size, size * 0.08) * 2 * 0.9;
      drawDiffFilled(ctx, cx, cy + size * 0.08, [
        { t: `↑${d.ahead} ↓${d.behind} · ${d.files}f `, c: COL.muted },
        { t: `+${d.insertions}`, c: COL.add },
        { t: `/−${d.deletions}`, c: COL.del },
      ], { maxW: dW, minPx: 9, maxPx: size * 0.2 });
    } else {
      ctx.font = `${Math.min(10, size * 0.13)}px 'Segoe UI', sans-serif`;
      ctx.fillStyle = COL.muted;
      ctx.fillText('src —', cx, cy + size * 0.08);
    }
    const b = x.burn;
    ctx.font = `${Math.min(10.5, size * 0.135)}px 'Segoe UI', sans-serif`;
    if (b && (b.tokens > 0 || b.cost > 0)) {
      drawDiffRow(ctx, cx, cy + size * 0.32, [
        { t: '⚡', c: COL.idle },
        { t: ` ${fmtTok(b.tokens)} tok · `, c: COL.muted },
        { t: fmtUsd(b.cost), c: COL.idle },
      ]);
    } else {
      ctx.fillStyle = withAlpha(COL.muted, 0.6);
      ctx.fillText('⚡ no burn yet', cx, cy + size * 0.32);
    }
    return;
  }

  // DIFF · AGE facet: own (uncommitted-since-checkpoint) diff, git-coloured, then the xell's age.
  // This is the "make the diffs easily visible" facet — the stat is grown to fill the petal width
  // (well past the old 13px cap) and wraps its +ins/−del onto a second line when it runs long.
  if (facet.kind === 'owndiff') {
    ctx.textBaseline = 'middle';
    const own = facet.diff?.own;
    if (own) {
      const parts = [
        { t: '◈ ', c: withAlpha(col, 0.95) },
        { t: `${own.files}f `, c: COL.muted },
        { t: `+${own.insertions}`, c: COL.add },
        { t: `/−${own.deletions}`, c: COL.del },
      ];
      const maxW = hexHalfWidthAt(size, size * 0.05) * 2 * 0.9;
      const row = drawDiffFilled(ctx, cx, cy - size * 0.04, parts,
        { maxW, minPx: 9, maxPx: size * 0.34, split: 2 });
      // yellow blinking "actively working" dot, just left of the (first) diff row
      if (isBusyZee(x)) {
        drawBusyDot(ctx, cx - row.width / 2 - size * 0.14, row.y, Math.max(3, size * 0.06));
      }
    } else {
      fillFont(ctx, '◈ —', hexHalfWidthAt(size, 0) * 2 * 0.9, 9, size * 0.3,
        (px) => `${px}px 'Segoe UI', sans-serif`);
      ctx.fillStyle = COL.text;
      ctx.fillText('◈ —', cx, cy - size * 0.04);
    }
    if (facet.age) {
      ctx.fillStyle = COL.muted;
      ctx.font = `${Math.min(9.5, size * 0.13)}px 'Segoe UI', sans-serif`;
      ctx.fillText(`age ${facet.age}`, cx, cy + size * 0.36);
    }
    return;
  }

  ctx.textBaseline = 'middle';
  const bodyMaxW = hexHalfWidthAt(size, size * 0.1) * 2 * 0.9;
  // MACHINE facet gets the cage lock prefixed to the machine name (tinted), like the compact hex.
  const lock = facet.title === 'machine' ? cageLock(x) : null;
  let subShift = 0;                                   // pushed down when the body wraps to two lines
  if (lock) {
    ctx.font = `${Math.min(11, size * 0.15)}px 'Segoe UI', sans-serif`;
    const name = fit(ctx, facet.lines[0] || '—', bodyMaxW - ctx.measureText(lock.g + ' ').width);
    const pre = lock.g + ' ';
    const preW = ctx.measureText(pre).width;
    const txtW = ctx.measureText(name).width;
    const x0 = cx - (preW + txtW) / 2;
    const prev = ctx.textAlign; ctx.textAlign = 'left';
    ctx.fillStyle = lock.c; ctx.fillText(pre, x0, cy);
    ctx.fillStyle = COL.text; ctx.fillText(name, x0 + preW, cy);
    ctx.textAlign = prev;
  } else {
    // grow to fill; wrap a long branch/session (its dashes/slashes are the break points) rather than
    // clip it, so the whole ref stays readable.
    ctx.fillStyle = COL.text;
    const px = fillFont(ctx, facet.lines[0] || '—', bodyMaxW, 9, size * 0.19,
      (p) => `${p}px 'Segoe UI', sans-serif`);
    const lines = wrapText(ctx, facet.lines[0] || '—', bodyMaxW, 2);
    const lh = px * 1.08;
    const y0 = cy - ((lines.length - 1) * lh) / 2;
    lines.forEach((ln, i) => ctx.fillText(ln, cx, y0 + i * lh));
    if (lines.length > 1) subShift = lh * 0.6;
  }
  if (facet.lines[1]) {
    ctx.fillStyle = COL.muted;
    ctx.font = `${Math.min(9.5, size * 0.13)}px 'Segoe UI', sans-serif`;
    ctx.fillText(fit(ctx, facet.lines[1], bodyMaxW), cx, cy + size * 0.28 + subShift);
  }
}
