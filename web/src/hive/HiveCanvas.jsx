import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { hexPath, pointInHex, hexWidth, rowStep, layoutHoneycomb, SQRT3 } from './hex.js';
import { hiveColor, hiveStatusLabel, hiveHeat } from './status.js';
import { isManagerXell, crewLinks, relatedTo, focusIdOf, hexDim, relationTag, REL_DASH } from './crew.js';

// ── palette ───────────────────────────────────────────────────────────────────
const COL = {
  bg: '#0d1017', panel: '#161b24', line: '#2a3242', text: '#e6ebf2', muted: '#8b97a8',
  working: '#35c46b', idle: '#e0a53b', ready: '#5b8cff', claimed: '#9b8cff',
  awaiting: '#e0a53b', spawning: '#5b8cff', error: '#e5554e', prod: '#f0913b',
  sha: '#e0a53b', add: '#35c46b', del: '#e5554e',
  // the manager↔crew RELATION mark: a pale steel that is in NO status palette (hive/status.js), so a
  // marked cell can never be misread as having taken on a status of its own
  rel: '#c8d3e8',
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
// Background wash alphas for a hex, modulated by its status HEAT (hive/status.js hiveHeat): a COLD
// xell (violet/blue — provisioning/ready) sits darker (a fainter wash) and a HOT one (orange/red —
// production / a held land or ship) glows brighter, so activity/urgency reads off the fill before the
// hue. Returns {top,bot} gradient alphas; `hover` lifts both a notch. The flower centre passes a
// higher base so the focused bloom stays vivid at every heat.
function heatWash(x, hover, base = 0) {
  const heat = x?.hive_status ? hiveHeat(x.hive_status) : 0.4;
  const lift = hover ? 0.04 : 0;
  return {
    top: base + lift + 0.12 + heat * 0.22,
    bot: base + lift + 0.04 + heat * 0.12,
  };
}
const shortSlug = (s) => String(s || '');
const stripBranch = (b) => String(b || '').replace(/^spinoff\//, '');

// ── a MANAGER zee is not a work-cell ─────────────────────────────────────────
// A manager has ZERO push/PR access to the xource (refused in server/src/queenzee/xellgit.js's
// ctx(), the one door every git write verb passes through): it writes no code and lands none. So its
// head sha and its diffstat count work it can never land — noise dressed as progress. Its hexagon
// therefore drops both and is drawn in the HARNESS BADGE's visual language instead (dashed seat +
// the persona disc it wears), spending the space on what a manager actually IS: its crew, and its
// read-only hold on production. (The predicate itself lives in hive/crew.js with the rest of the
// manager↔crew relation — every layer that draws the relation asks the same question of the same code.)
export { isManagerXell } from './crew.js';

// ── who WEARS a harness vs who its badge is FOR ──────────────────────────────
// `wearer_ids` is every live xell wearing the harness; `consumer_ids` is the subset the badge is
// drawn for — the xells that get a wire routed through its cell. A MANAGER is a wearer and never a
// consumer (server/src/lib/timeline.js), because a manager's hexagon is ALREADY drawn as that
// harness's persona: dashed seat + its avatar disc. Giving the same harness its own cell beside the
// manager seats the identical avatar twice and spends a grid cell saying what the manager xell
// already says. So a harness worn by managers ONLY earns no cell at all — it still travels in the
// payload, because the manager hexagon needs its art.
export const wearersOf = (h) => h?.wearer_ids || h?.consumer_ids || [];   // old payloads: wearers = consumers
export const badgedHarnesses = (harnesses = []) => (harnesses || []).filter((h) => (h?.consumer_ids || []).length > 0);

// ── a manager and its CREW ───────────────────────────────────────────────────
// The relation itself — who is crew, who is live, which xell the hive is focused on, and the DASH that
// says "related" in every layer — lives in hive/crew.js, because the honeycomb is not the only view
// that draws it: the wire overlay (Connectors.jsx) and the git graph's dots (GraphPane.jsx) draw the
// same relationship over the same fleet, and a second copy of the rule is exactly the bug #24 removed
// from this file. Re-exported here so a caller that reads the honeycomb's vocabulary finds it.
export { isLiveXell, crewLinks, relatedTo, focusIdOf, hexDim, relationTag, REL_DASH } from './crew.js';

// What a manager's hexagon says, as data (pure — unit-tested; the drawing below only paints it).
export function managerCard(x, crew = []) {
  const list = crew || [];
  const busy = list.filter((w) => w.cli_active === true || w.zee_status === 'working').length;
  // anything the hive is holding for a human on a crew member: land?/ship?/prod?/seed?/tend?/done?
  const waiting = list.filter((w) => /(Request|Hint|Suggest)$/.test(w.hive_status || '')).length;
  // Two short lines, not one long one: a hexagon is ~14 characters wide at a readable size, so the
  // count rides the identity seam and the activity gets the line a worker spends on its diffstat.
  const crewLine = list.length ? `⬡ ${list.length} crew` : '⬡ no crew yet';
  const activity = [busy ? `▶ ${busy} working` : null, waiting ? `⚑ ${waiting} waiting` : null]
    .filter(Boolean).join(' · ') || null;
  // A pointy-top hex narrows fast toward its bottom vertex — the line under the status pill has only
  // ~half the card's width — so the compact card gets the short form and the bloom's petal the full one.
  const grip = x?.db_coupling === 'db-prod-readonly' ? 'read-only'
    : x?.db_coupling === 'db-shared-prod' ? 'read/write'
    : null;
  return {
    label: `⬢ ${shortSlug(x?.slug)}`,
    role: 'manager',
    crew: crewLine,
    activity,
    count: list.length,
    busy,
    waiting,
    prod: grip ? `🛡 prod · ${grip}` : null,
    prodShort: grip ? `🛡 ${grip}` : null,
  };
}
// compact burn formatters (mirror the dashboard's fmtTok/fmtUsd) for the per-xell burn on the flower
const fmtTok = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n || 0));
const fmtUsd = (n) => '$' + (n >= 100 ? Math.round(n) : (n || 0).toFixed(2));

// A zee is ACTIVELY WORKING when its CLI is live (cli_active) or it reports the working status.
// The honeycomb shows that with a yellow blinking dot beside the diff; the animation loop that makes
// it blink only runs while at least one xell is busy (see the effect in HiveCanvas).
const isBusyZee = (x) => !x.is_production && (x.cli_active === true || x.zee_status === 'working');
const isPaused = (x) => !x.is_production && x.hive_status === 'occ-paused';
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
// Red pause icon (two vertical bars) drawn where the yellow "working" dot would be — used when a xell
// is paused (fleet-wide, project-scoped or per-xell). The ⏸ character is clear enough at hex scales.
function drawPausedIcon(ctx, x, y, r) {
  ctx.save();
  ctx.font = `600 ${r * 2}px 'Segoe UI', sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = COL.error;
  ctx.globalAlpha = 0.8;
  // Two vertical bars (⏸ pause symbol) — drawn as actual bars for crispness at any size
  const bw = r * 0.3, gap = r * 0.4, h = r * 1.5;
  const x0 = x - (bw * 2 + gap) / 2;
  ctx.fillRect(x0, y - h / 2, bw, h);
  ctx.fillRect(x0 + bw + gap, y - h / 2, bw, h);
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
// hex, the diff·age facet and the compact hex's source-diff line all share one implementation.
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

// The "this stat is a link" affordance: a hairline under the drawn diffstat plus a small muted
// caption. The flower's two diff petals open the DIFF VIEWER when clicked, and on a canvas there is
// no cursor:pointer to discover by hovering half a pixel — so the affordance has to be drawn.
// A falsy `caption` draws the hairline ALONE — for a facet whose next line already carries the words
// (the crew facet says "hover a dot · click to open" there, because it has one text line to spend and
// spending it twice would push the row out of the petal).
function drawStatLink(ctx, cx, row, caption) {
  const y = row.y + Math.max(6, row.width * 0.02);
  ctx.save();
  ctx.strokeStyle = withAlpha(COL.muted, 0.45);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(cx - row.width / 2, y);
  ctx.lineTo(cx + row.width / 2, y);
  ctx.stroke();
  if (caption) {
    ctx.fillStyle = withAlpha(COL.muted, 0.75);
    ctx.font = "9px 'Segoe UI', sans-serif";
    ctx.textAlign = 'center';
    ctx.fillText(caption, cx, y + 7);
  }
  ctx.restore();
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

// Cells around (row,col) in RINGS, nearest first — a breadth-first walk of the offset lattice out to
// `radius` hops. This is what lets a manager's crew be seated AROUND it: ring 1 is its six touching
// neighbours, ring 2 the twelve beyond, and so on, so a crew stays a visually contiguous cluster
// however large it grows.
function cellsAround(row, col, radius = 4) {
  const seen = new Set([cellKey(row, col)]);
  const out = [];
  let frontier = [[row, col]];
  for (let hop = 0; hop < radius; hop++) {
    const next = [];
    for (const [r, c] of frontier) {
      for (const [nr, nc] of cellNeighbors(r, c)) {
        const k = cellKey(nr, nc);
        if (seen.has(k)) continue;
        seen.add(k);
        next.push([nr, nc]);
        out.push([nr, nc]);
      }
    }
    frontier = next;
  }
  return out;
}

// ── SEATING: a manager's crew sits NEXT TO IT ─────────────────────────────────
// The honeycomb used to lay xells out in pure reading order, which scatters a manager's workers
// across the grid and makes "who belongs to whom" unreadable — the one relationship the hive now
// has. So seating happens in two passes: every MANAGER takes the next free cell and its crew fills
// the free cells nearest to it (ring by ring); everyone else then fills what is left, in reading
// order. With no managers in the fleet this is byte-for-byte the old layout.
//
// `pinned` keeps a cell for a xell whose position is already decided (the expanded flower), and
// `reserved` blocks the cells the flower's petals consume. Pure, so it can be unit-tested.
export function seatXells(list, cols, { reserved = new Set(), pinned = {} } = {}) {
  const cells = {};
  const taken = new Set(reserved);
  const place = (id, rc) => { cells[id] = rc; taken.add(cellKey(rc[0], rc[1])); };
  const free = (r, c) => r >= 0 && c >= 0 && c < cols && !taken.has(cellKey(r, c));
  let scan = 0;
  const nextFree = () => {
    for (;;) {
      const row = Math.floor(scan / cols), col = scan % cols;
      scan++;
      if (free(row, col)) return [row, col];
    }
  };

  for (const [id, rc] of Object.entries(pinned)) if (rc) place(id, rc);

  const managers = list.filter((x) => x.zee_type === 'manager');
  for (const m of managers) {
    if (!cells[m.id]) place(m.id, nextFree());
    const [mr, mc] = cells[m.id];
    const crew = list.filter((w) => w.manager_xell_id === m.id && !cells[w.id]);
    if (!crew.length) continue;
    const ring = cellsAround(mr, mc, Math.max(2, Math.ceil(Math.sqrt(crew.length)) + 1));
    let i = 0;
    for (const w of crew) {
      let seat = null;
      while (i < ring.length && !seat) {
        const [r, c] = ring[i++];
        if (free(r, c)) seat = [r, c];
      }
      place(w.id, seat || nextFree());   // a crew bigger than the room around it spills into the grid
    }
  }

  for (const x of list) if (!cells[x.id]) place(x.id, nextFree());
  return cells;
}

// Connector wires thread the corridors BETWEEN hexes, so the honeycomb is drawn spaced: each hex is
// shrunk inside its (gapless) layout cell to open a gap wide enough for the traces that must pass —
// sized by the grid dimension a wire fans across (columns in portrait, rows in landscape). The
// routing lattice (<Connectors>) still uses the full CELL size so it stays connected; only the drawn
// hex shrinks. WIRE_PITCH is the on-screen width one trace needs (stroke + clearance).
const WIRE_PITCH = 6;

export default function HiveCanvas({ xells, diffs, timeline, orientation, honeySide, onOpenSession, machines,
                                    expandedId, onExpand, hexPosRef, harnessPosRef, onGeometry, onAction, onContainerMenu,
                                    hoverRef, setHover, subscribeHover }) {
  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const geomRef = useRef({ hexes: [], harnesses: [], flower: null, buttons: null, containers: null });
  const imgCacheRef = useRef(new Map());   // avatar_url → HTMLImageElement (harness badge art)
  const drawRef = useRef(() => {});        // latest draw(), so an image onload can trigger a redraw
  const viewRef = useRef({ x: 0, y: 0, k: 1 });          // pan offset + zoom (world → screen)
  const dragRef = useRef(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const rafRef = useRef(0);
  const setExpandedId = onExpand || (() => {});
  const emitHover = setHover || (() => {});
  // ── canvas button tooltip: DOM overlay created imperatively so onPointerMove never re-renders ──
  const tipRef = useRef({ el: null, kind: null });  // .el = DOM element, .kind = current verb kind
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
    // SEATING (see seatXells): managers first, each with its crew in the free cells nearest to it,
    // then everyone else in reading order. Two passes because the flower's petals consume cells:
    // seat once to learn where the expanded xell sits, then re-seat with its six neighbours reserved
    // and its own cell pinned, so the bloom opens exactly where the hexagon already was.
    const cols = Math.max(1, lay.cols);
    const baseCells = seatXells(list, cols);
    const reserved = new Set();
    let cells = baseCells;
    if (expanded && baseCells[expanded.id]) {
      const [er, ec] = baseCells[expanded.id];
      reserved.add(cellKey(er, ec));
      for (const [nr, nc] of cellNeighbors(er, ec)) reserved.add(cellKey(nr, nc));
      cells = seatXells(list, cols, { reserved, pinned: { [expanded.id]: [er, ec] } });
    }
    const hexes = list.map((x) => {
      const [row, col] = cells[x.id];
      const [cx, cy] = cellCenter(row, col, cellSize, originX, originY);   // centres on the gapless grid
      return { x, id: x.id, row, col, cx, cy, size: drawSize, cell: cellSize, color: tById[x.id]?.color || null };
    });
    const hexById = {}; for (const hx of hexes) hexById[hx.id] = hx;

    // Every manager's CREW, and the harness art each xell wears — both needed BEFORE the hexes are
    // drawn, because a manager's hexagon is drawn as a persona badge (its harness avatar) over its
    // crew, not as a work-cell. The avatar loader is shared with the harness badges below (one image
    // cache; a load triggers one redraw).
    const harnesses = timeline?.harnesses || [];
    // LIVE crew only, both ways (crewLinks): a reaped/husk worker is counted by nobody and lights up
    // for nobody — the same rule the work tracker resolves a live zee with.
    const { crewOf, managerOf } = crewLinks(list);
    // WEARS it (wearer_ids), not "is a consumer of" it: a manager is a wearer but never a consumer,
    // because its hexagon IS the badge — the persona disc below is exactly the art this looks up.
    // Falling back to consumer_ids keeps an older payload (and the demo fixture) rendering.
    const harnessOf = (id) => harnesses.find((h) => wearersOf(h).includes(id)) || null;
    const getImg = (url) => {
      if (!url) return null;
      let img = imgCacheRef.current.get(url);
      if (!img) {
        img = new Image();
        img.onload = () => requestAnimationFrame(() => drawRef.current && drawRef.current());
        img.src = url;
        imgCacheRef.current.set(url, img);
      }
      return img;
    };

    // hover highlight: a hovered hex, a hovered commit dot, OR a hovered harness badge lights up the
    // matching hex(es). Hovering a harness highlights every xell that WEARS it — the reverse of a
    // xell hover highlighting the harness it wears. Wearers, not consumers: a manager wears it and
    // belongs in that highlight even though it never takes a cell or a wire from it.
    const H = hoverRef ? hoverRef.current : { id: null, commit: null, harness: null };
    const hovHarness = H.harness ? harnesses.find((h) => h.id === H.harness) : null;
    const hovHarnessConsumers = new Set(wearersOf(hovHarness));
    const hoverActive = !!(H.id || H.commit || H.harness);
    const isHov = (id) => id === H.id || (!!H.commit && baseOf(id) === H.commit) || hovHarnessConsumers.has(id);

    // THE CREW HIGHLIGHT (ticket #24): the focused xell is the hovered hex, or — with nothing hovered
    // — the SELECTED (bloomed) one, so a manager's crew stays marked while its flower is open. Its
    // live crew (or, hovering a worker, the manager it reports to) is marked as RELATED: never
    // dimmed, and drawn with the dashed tie-ring + the word, which is nothing selection uses.
    // focusIdOf is shared with the wire overlay and the graph (#25) — three views, one answer.
    const focusId = focusIdOf(H, expandedId);
    const related = relatedTo(list, focusId, { crewOf, managerOf });
    const focus = focusId ? list.find((x) => x.id === focusId) : null;
    const relColor = focusId ? (tById[focusId]?.color || null) : null;

    // honeycomb + flower, on the pan/zoom world transform
    ctx.setTransform(dpr * v.k, 0, 0, dpr * v.k, dpr * v.x, dpr * v.y);
    geomRef.current.hexes = hexes;
    for (const hx of hexes) {
      if (expanded && hx.id === expanded.id) continue;     // the flower draws it
      const hovered = isHov(hx.id);
      const rel = related.get(hx.id) || null;
      const dim = hexDim({ hexId: hx.id, expandedId, hovered, hoverActive, related: rel });
      const relArgs = { related: rel, relatedTo: rel ? focus?.slug || null : null, relColor };
      if (isManagerXell(hx.x)) {
        const h = harnessOf(hx.id);
        drawManagerHex(ctx, hx, { hover: hovered, dim, crew: crewOf[hx.id] || [],
          harness: h, img: getImg(h?.avatar_url), ...relArgs });
      } else {
        const workerHarness = harnessOf(hx.id);
        drawCompactHex(ctx, hx, { hover: hovered, dim, diff: diffs?.[hx.id], machines,
          harness: workerHarness, harnessImg: getImg(workerHarness?.avatar_url), ...relArgs });
      }
    }
    geomRef.current.flower = null;
    geomRef.current.buttons = null;
    geomRef.current.containers = null;
    geomRef.current.crew = null;
    if (expanded && cells[expanded.id]) {
      const [er, ec] = cells[expanded.id];
      const centers = [cellCenter(er, ec, cellSize, originX, originY),
        ...cellNeighbors(er, ec).map(([r, c]) => cellCenter(r, c, cellSize, originX, originY))];
      // H.id is the hovered CREW DOT while a bloom is open (see onPointerMove): the facet rings that
      // dot and names the worker, and the same id lights its hexagon, its wire and its commit dot.
      drawFlower(ctx, centers, cellSize, expanded, diffs?.[expanded.id], machines,
        tById[expanded.id]?.color || null, crewOf[expanded.id] || [], { hoverId: H.id });
      geomRef.current.flower = { centers, size: cellSize, id: expanded.id,
        openable: !!expanded.viewer_url && !expanded.is_production };
      // Per-xell ACTIONS drawn straight onto the flower (no DOM toolbar): a hit-tested button row
      // under the bloom. Their world-space rects are recorded so onPointerUp can dispatch onAction.
      geomRef.current.buttons = drawFlowerButtons(ctx, centers, cellSize, expanded, diffs?.[expanded.id]);
      // Container icons in the CONTAINERS petal are right-clickable — record their rects so a
      // context-menu event can open the same ContainerMenu the inventory chips use.
      geomRef.current.containers = flowerContainerRects(centers, cellSize, expanded);
      // …and the CREW petal's dots are hoverable/clickable rows: the crew was listed in words here and
      // led nowhere, which is the one surface a human reads AFTER they have already asked "whose crew?".
      geomRef.current.crew = isManagerXell(expanded)
        ? flowerCrewRects(centers, cellSize, crewOf[expanded.id] || []) : null;
    }

    // HARNESSES sit in the honeycomb grid too — each takes its own hexagon CELL (docs §5: the badge
    // is locked to a hex centre, "as if it were a xell in the grid"), reserved AFTER the xells so it
    // never collides with one. The avatar is drawn on the CANVAS (reliable drawImage of a preloaded
    // SVG) rather than an SVG <image> that browsers fail to load; <Connectors> routes the consumer
    // wires through this centre.
    // ...and only the harnesses whose badge is FOR someone: a manager-only harness is skipped here,
    // because the manager's own hexagon (drawn above, in this badge's language) already indicates it.
    const badged = badgedHarnesses(harnesses);
    const harnessCells = [];
    if (badged.length) {
      const cols = Math.max(1, lay.cols);
      const occupied = new Set(Object.values(cells).map(([r, c]) => cellKey(r, c)));
      for (const k of reserved) occupied.add(k);
      let hr = 0, hc = 0;
      const nextFree = () => {
        for (;;) {
          const k = cellKey(hr, hc);
          const out = [hr, hc];
          hc++; if (hc >= cols) { hc = 0; hr++; }
          if (!occupied.has(k)) { occupied.add(k); return out; }
        }
      };
      // which xell(s) are focused right now (hovered/expanded, OR the consumers of a hovered harness)
      // → a harness badge lights up when a focused xell WEARS it, and dims with everything else when
      // the focus is on a xell that doesn't.
      const focusedIds = new Set();
      if (expandedId) focusedIds.add(expandedId);
      if (H.id) focusedIds.add(H.id);
      if (H.commit) for (const t of (timeline?.xells || [])) if (t.base_commit === H.commit) focusedIds.add(t.id);
      for (const id of hovHarnessConsumers) focusedIds.add(id);
      const anyFocus = focusedIds.size > 0 || !!H.harness;
      for (const h of badged) {
        const [row, col] = nextFree();
        const [cx, cy] = cellCenter(row, col, cellSize, originX, originY);
        harnessCells.push({ id: h.id, cx, cy, size: drawSize, cell: cellSize, color: h.color });
        // a harness badge is hi when it is the one being hovered, or a focused xell wears it
        const hi = h.id === H.harness || wearersOf(h).some((id) => focusedIds.has(id));
        drawHarnessBadge(ctx, cx, cy, drawSize, h, getImg(h.avatar_url), { hi, dim: anyFocus && !hi });
      }
    }
    // record harness cells (drawn radius) so a hover/click can hit-test them like a hex
    geomRef.current.harnesses = harnessCells;

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
    // publish harness cell centres separately (NOT into hexPosRef — that would make the wire maze
    // treat a harness as a routing hex). <Connectors> reads this to anchor the badge's wires.
    if (harnessPosRef) {
      const r = canvas.getBoundingClientRect();
      const hp = {};
      for (const hb of harnessCells) {
        hp[hb.id] = { x: r.left + v.k * hb.cx + v.x, y: r.top + v.k * hb.cy + v.y,
          size: hb.cell * v.k, draw: hb.size * v.k, color: hb.color };
      }
      harnessPosRef.current = hp;
    }
    onGeometry && onGeometry();
    // honeySide is a dep so a flip (which moves this pane on screen) re-runs draw and republishes the
    // hexes' fresh client-space positions — otherwise <Connectors> would trace to their old spots.
  }, [size, xells, diffs, timeline, orientation, honeySide, expandedId, expanded, machines, hexPosRef, onGeometry, baseOf]);

  useLayoutEffect(() => { drawRef.current = draw; draw(); }, [draw]);

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
  const hitHarness = useCallback((wx, wy) => {
    for (const hb of geomRef.current.harnesses || []) if (pointInHex(wx, wy, hb.cx, hb.cy, hb.size)) return hb;
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
  // a dot in the open manager's CREW petal → that worker (circular targets, so distance not a box)
  const hitCrew = useCallback((wx, wy) => {
    for (const d of geomRef.current.crew || []) {
      if ((wx - d.x) ** 2 + (wy - d.y) ** 2 <= d.r ** 2) return d;
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
      // A CREW dot answers first: it is the smallest target in the bloom and the only one that means
      // another xell, so hovering it emits THAT worker's id — which is how the crew list leads back to
      // its hexagons (and its wires, and its commit dots). Everything else in a bloom clears the hover.
      const cw = hitCrew(wx, wy);
      const b = cw ? null : hitButton(wx, wy);
      const f = cw ? null : hitFlower(wx, wy);
      cursor = cw || b || (f && ((f.cell === 0 && f.openable) || diffPetal(expanded, f.cell))) ? 'pointer'
        : hitContainer(wx, wy) ? 'context-menu' : 'default';   // right-click hint on an icon
      // Button tooltip — update the persistent DOM element directly on pointer move.
      const tooltip = tipRef.current;
      if (b && VERB_TOOLTIP[b.kind]) {
        if (!tooltip.el) {
          tooltip.el = document.createElement('div');
          tooltip.el.className = 'hive-tooltip';
          tooltip.el.innerHTML = '<span class="hive-tooltip-k"></span><span class="hive-tooltip-t"></span>';
          wrapRef.current?.appendChild(tooltip.el);
        }
        if (tooltip.kind !== b.kind) {
          tooltip.kind = b.kind;
          const k = tooltip.el.children[0], t = tooltip.el.children[1];
          k.textContent = b.kind;
          t.textContent = VERB_TOOLTIP[b.kind];
        }
        const bb = wrapRef.current.getBoundingClientRect();
        tooltip.el.style.left = `${e.clientX - bb.left + 14}px`;
        tooltip.el.style.top = `${e.clientY - bb.top - 32}px`;
        tooltip.el.style.display = 'flex';
      } else if (tooltip.el) {
        tooltip.kind = null;
        tooltip.el.style.display = 'none';
      }
      emitHover({ id: cw?.id || null, commit: null, harness: null });
    } else {
      const hx = hitHex(wx, wy);
      if (hx) {
        emitHover({ id: hx.id, commit: null, harness: null });   // a hex is ONE xell → key on id
        cursor = 'pointer';
      } else {
        // no hex under the cursor → a harness badge lights up its consumer xells (reverse highlight)
        const hb = hitHarness(wx, wy);
        emitHover({ id: null, commit: null, harness: hb?.id || null });
        cursor = hb ? 'pointer' : 'default';
      }
      const tooltip = tipRef.current;                                  // no bloom → no button tooltip
      if (tooltip.el) { tooltip.kind = null; tooltip.el.style.display = 'none'; }
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
      // A crew dot is a jump: open THAT worker's bloom. It comes first for the same reason it does on
      // hover — it is the smallest target and it sits inside a petal whose own click does nothing.
      const cw = hitCrew(wx, wy);
      if (cw && cw.id !== expandedId) { setExpandedId(cw.id); return; }
      // Action buttons next — they sit just below the flower and own their clicks.
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
        } else if (DIFF_PETAL[f.cell]) {
          // The two DIFF petals (commit/source stat, own stat) open the diff viewer — clicking the
          // numbers is how you read the lines they count, here exactly as on the card. A manager's
          // petals 5/6 are CREW and PROD·AGE, so diffPetal() returns null and the click does nothing.
          const x = (xells || []).find((xx) => xx.id === f.id);
          if (x && diffPetal(x, f.cell)) onAction?.(DIFF_PETAL[f.cell], x, diffs?.[f.id]);
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

  const onLeave = () => {
    emitHover({ id: null, commit: null }); dragRef.current = null;
    if (tipRef.current.el) { tipRef.current.kind = null; tipRef.current.el.style.display = 'none'; }
  };

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
  // Clean up the imperative tooltip element on unmount
  useEffect(() => {
    return () => { if (tipRef.current.el) { tipRef.current.el.remove(); tipRef.current.el = null; } };
  }, []);

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


// ── the RELATION mark: "related to the focus", never "also selected" ──────────
// The manager is the thing selected; a crew member was chosen by nobody. So this mark deliberately
// borrows NONE of selection's language — no lifted wash, no thickened status stroke, no bloom — and is
// instead a DASHED tie-ring just outside the seat plus the WORD for the relation. That is two
// independent signals of which only one is colour: the dash pattern says "attached to something else"
// and the word says which relation it is, so the highlight still lands for a reader who cannot
// separate the hues (this file's rule: the word is the signal, colour reinforces).
//
// `color` is the FOCUS's own trace colour where the timeline has one — the same colour its wire and
// its commit dot are drawn in — so the mark reads as "belongs to that line", not as a new status.
export function drawRelationMark(ctx, cx, cy, size, { kind, slug = null, color = null, gap = 3, tagY = -0.62 } = {}) {
  const tag = relationTag(kind, slug);
  if (!tag) return null;
  const col = color || COL.rel;
  ctx.save();
  hexPath(ctx, cx, cy, size + gap);
  ctx.lineWidth = 1.6;
  ctx.strokeStyle = withAlpha(col, 0.95);
  ctx.setLineDash(REL_DASH);          // the SAME dash the related wire and the related commit dot use
  ctx.stroke();
  ctx.setLineDash([]);
  // The word rides an opaque pill INSIDE the seat (never outside it — a label in the corridor would be
  // read as belonging to the wires). `tagY` is a PREFERENCE ORDER of rows, in fractions of the radius:
  // a pointy-top hex narrows fast toward its vertex, so the roomiest row is not always the one that
  // covers least, and the caller lists the rows it would rather give up in order. The first row where
  // the whole word fits wins. A hex too small to read the card's own text keeps the dashed ring alone
  // — still a signal that is not a colour.
  let shown = null;
  if (size >= 30) {
    const pad = 10, nomPx = Math.max(7, size * 0.12);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const font = (px) => `600 ${px}px 'Segoe UI', sans-serif`;
    const widthAt = (t, px) => { ctx.font = font(px); return ctx.measureText(t).width; };
    const long = `${tag.glyph} ${tag.long}`, short = `${tag.glyph} ${tag.word}`;
    let at = null;
    for (const ty of (Array.isArray(tagY) ? tagY : [tagY])) {
      const room = Math.max(0, hexHalfWidthAt(size, Math.abs(size * ty)) * 2 * 0.94 - pad);
      // The long form (which names the other end) if it fits, else the bare relation, else the bare
      // relation SHRUNK to fit. Never an ellipsis: the word IS the signal here and "⬢ manag…" is not a
      // word — if it cannot be read whole even at the floor size, this row is not the row.
      if (widthAt(long, nomPx) <= room) shown = long;
      else if (widthAt(short, nomPx) <= room) shown = short;
      else {
        fillFont(ctx, short, room, 6.5, nomPx, font);
        shown = ctx.measureText(short).width <= room ? short : null;
      }
      if (shown) { at = cy + size * ty; break; }
    }
    if (!shown) { ctx.restore(); return { word: null, kind: tag.kind }; }
    const pw = ctx.measureText(shown).width + pad, ph = Math.max(10, size * 0.17);
    ctx.beginPath();
    ctx.roundRect(cx - pw / 2, at - ph / 2, pw, ph, ph / 2);
    ctx.fillStyle = withAlpha('#0a0d13', 0.86);
    ctx.fill();
    ctx.lineWidth = 1; ctx.strokeStyle = withAlpha(col, 0.85);
    ctx.setLineDash([2, 3]); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = col;
    ctx.fillText(shown, cx, at + 0.5);
  }
  ctx.restore();
  return { word: shown, kind: tag.kind };
}

// ── compact hex: the two-half card ────────────────────────────────────────────
// upper half: ⌂ machine + container chips (nick + health dot)
// lower half: head sha · source diff · status pill · ship line
// This is the WORKER (and production) card — it is built around the git state, so a MANAGER never
// reaches it: drawManagerHex draws that one instead (no sha, no diffstat, a persona and its crew).
// exported for the same reason drawManagerHex is: the crew highlight is a DRAWN state (there is no DOM
// per cell), so the only honest way to assert it is to run this against a recording 2D context
export function drawCompactHex(ctx, hx, { hover, dim, diff, machines, related = null, relatedTo = null, relColor = null,
                                          harness = null, harnessImg = null }) {
  const { cx, cy, size, x } = hx;
  const col = statusColor(x);
  // The commit head reads in the SAME colour the git graph traces this xell with — its connector
  // wire and the ring around its base-commit dot are drawn in hx.color (the timeline's per-xell
  // colour), so painting the head sha that colour ties the hexagon to its line in the graph.
  const shaCol = hx.color || COL.sha;
  const w = hexWidth(size);
  ctx.save();
  if (dim) ctx.globalAlpha = 0.3;

  hexPath(ctx, cx, cy, size);
  const g = ctx.createLinearGradient(cx, cy - size, cx, cy + size);
  const wash = heatWash(x, hover);
  g.addColorStop(0, withAlpha(col, wash.top));
  g.addColorStop(1, withAlpha(col, wash.bot));
  ctx.fillStyle = g;
  ctx.fill();
  ctx.lineWidth = hover ? 2.4 : 1.4;
  ctx.strokeStyle = hover ? col : withAlpha(col, 0.6);
  ctx.stroke();
  if (hx.color) {
    hexPath(ctx, cx, cy, size - 3);
    ctx.lineWidth = 1.3; ctx.strokeStyle = withAlpha(hx.color, 0.9); ctx.stroke();
  }
  // the manager↔crew relation mark, painted LAST (over the card, outside the clip) so its word is not
  // buried under the row it overlays — see drawRelationMark
  const mark = () => (related
    ? drawRelationMark(ctx, cx, cy, size, { kind: related, slug: relatedTo, color: relColor })
    : null);

  ctx.save();
  hexPath(ctx, cx, cy, size - 2);
  ctx.clip();

  if (size < 30) {                     // tiny: just the status dot
    ctx.beginPath(); ctx.arc(cx, cy, Math.max(2, size * 0.22), 0, Math.PI * 2);
    ctx.fillStyle = col; ctx.fill();
    ctx.restore(); mark(); ctx.restore(); return;
  }

  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const full = size >= 52;             // the two-half card needs room; else degrade

  // ── harness avatar badge (10 o'clock / upper-left vertex) ──
  // The upper-left vertex of a pointy-top hex is at 210° math angle (vertex i=4 in hexCorners:
  // cos=‑√3/2, sin=‑½). The badge sits at 75% of the distance from center to that vertex
  // (i.e. 25% from the vertex back toward center), so it stays on the hex body and never
  // overflows the stroke.
  if (full && harness && size >= 48) {
    const avatarR = Math.max(5, size * 0.12);
    const angle = (210 * Math.PI) / 180;   // 210° math = upper-left vertex
    const dist = size * 0.75;               // 75% from center to vertex (25% from vertex inward)
    const ax = cx + dist * Math.cos(angle);
    const ay = cy + dist * Math.sin(angle);
    drawAvatarDisc(ctx, ax, ay, avatarR, harness.color || col,
      { img: harnessImg, glyph: harness.glyph || null, letter: String(harness.label || '?')[0] });
  }

  // ── upper half ──
  // Machine line, prefixed with the cxell lock (🔒 cxell / 🔓 uncxell) so protocol-compliance reads
  // at a glance. The lock is tinted (green/red/amber); the machine name stays muted, so the two are
  // drawn as separate colour segments, centred together.
  const mach = machineOf(x, machines);
  if (full && mach) {
    ctx.font = `${Math.max(8, size * 0.14)}px 'Segoe UI', sans-serif`;
    const lock = cxellLock(x);
    // Ride the machine line with the resolved environment (❖ key; ∅ = empty → nothing merged), so
    // "which env is this xell loaded with" reads at a glance. fit() truncates, never overflows.
    const envSuffix = x.env_key ? ` · ❖${x.env_key}${Number(x.env_var_count) === 0 ? '∅' : ''}` : '';
    const machTxt = fit(ctx, mach + envSuffix, w * 0.5);
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
  // With a session title the seam splits in two: WHO it is (slug) rides just above WHAT it's
  // doing (the zee's task title) — the collapsed card answers both without expanding the flower.
  // Rows below shift down a notch to make the room; no title (ready xells, production) → the
  // layout is exactly what it was.
  // the dispatch convention prefixes titles with "xell : " — identity noise on a card this small
  const ownTitle = full && !x.is_production ? (x.zee_title || '').replace(/^xell\s*:\s*/i, '').trim() : '';
  const zeeTitle = !full || x.is_production ? ''
    // a managed worker names its crew ahead of its task: the cluster around a manager's persona hex
    // should not be a coincidence you have to infer
    : x.manager_slug ? `↳${x.manager_slug}${ownTitle ? ` · ${ownTitle}` : ''}`
    : ownTitle;
  const label = x.is_production ? '🛡 PRODUCTION' : shortSlug(x.slug);
  fillFont(ctx, label, w * 0.82, 8.5, size * 0.2, (p) => `600 ${p}px 'Segoe UI', sans-serif`);
  ctx.fillStyle = COL.text;
  ctx.fillText(fit(ctx, label, w * 0.82), cx, cy - (full ? size * (zeeTitle ? 0.14 : 0.06) : size * 0.2));
  if (zeeTitle) {
    ctx.font = `italic ${Math.max(7.5, size * 0.125)}px 'Segoe UI', sans-serif`;
    ctx.fillStyle = COL.muted;
    ctx.fillText(fit(ctx, zeeTitle, w * 0.88), cx, cy + size * 0.02);
  }

  // ── lower half ──
  // Live head (diff.head, read from the worktree) over the frozen head_commit provisioning base, so
  // a xell that has committed/rebased/landed shows where it actually is, not its old fork sha.
  const sha = (x.is_production ? x.deployed_commit : (diff?.head || x.head_commit))?.slice(0, 8);
  if (full) {
    if (sha) {
      ctx.font = `600 ${Math.max(8.5, size * 0.155)}px 'Cascadia Code', monospace`;
      ctx.fillStyle = shaCol;
      ctx.fillText(sha, cx, cy + size * (zeeTitle ? 0.2 : 0.14));
    }
    // diff: "↑1 ↓7 · 4f +32/−6" — the SOURCE diff (worktree vs its branch's fork off main), i.e.
    // everything this xell would land, matching the expanded flower's COMMIT facet. NOT `diff.own`
    // (uncommitted-since-checkpoint): zees checkpoint-commit constantly, so `own` sits at +0/−0
    // almost always and the collapsed card looked like it never tracked any work. git convention
    // colouring (insertions green, deletions red) via drawDiffRow.
    if (diff && !x.is_production) {
      const y = cy + size * (zeeTitle ? 0.36 : 0.32);
      const parts = [
        { t: `↑${diff.ahead} ↓${diff.behind} · ${diff.files}f `, c: COL.muted },
        { t: `+${diff.insertions}`, c: COL.add },
        { t: `/−${diff.deletions}`, c: COL.del },
      ];
      // fill the card width (capped so it clears the sha above and the status pill below)
      const row = drawDiffFilled(ctx, cx, y, parts, { maxW: w * 0.82, minPx: 9, maxPx: size * 0.17 });
      // yellow blinking "actively working" dot, or red pause icon when paused
      if (isBusyZee(x)) {
        drawBusyDot(ctx, cx - row.width / 2 - size * 0.11, y, Math.max(2.4, size * 0.055));
      } else if (isPaused(x)) {
        drawPausedIcon(ctx, cx - row.width / 2 - size * 0.11, y, Math.max(2.4, size * 0.055));
      }
    }
    // status pill — the DISPLAY status (occ-working / occ-tendRequest / live-protected / …)
    const st = hiveStatusLabel(x);
    if (st) {
      ctx.font = `600 ${Math.max(7.5, size * 0.13)}px 'Segoe UI', sans-serif`;
      const pw = ctx.measureText(st).width + 12, ph = Math.max(11, size * 0.19);
      const py2 = cy + size * (zeeTitle ? 0.53 : 0.5);
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
      ctx.fillStyle = shaCol;
      ctx.fillText(sha, cx, cy + size * 0.08);
    }
    ctx.font = `${Math.max(7.5, size * 0.15)}px 'Segoe UI', sans-serif`;
    ctx.fillStyle = COL.muted;
    ctx.fillText(fit(ctx, hiveStatusLabel(x), w * 0.6), cx, cy + size * 0.34);
  }
  ctx.restore();   // unclip
  mark();
  ctx.restore();
}

// ── harness badge: an avatar seated in its own honeycomb cell (docs §5) ───────
// A harness reads as "a persona worn by xells", not a work-cell — so instead of the two-half card it
// draws a faint dashed hex seat with a circular AVATAR at its centre, its label + consumer count
// below. The avatar image is a preloaded <img> drawn to canvas (reliable, unlike an SVG <image>);
// a lettermark is the fallback while it loads or if it fails.
export function drawHarnessBadge(ctx, cx, cy, size, h, img, { dim = false, hi = false } = {}) {
  const col = h.color || '#5b8cff';
  const ay = cy - size * 0.06;                 // avatar centre, nudged up to leave room for the label
  const r = size * 0.42;
  ctx.save();
  if (dim) ctx.globalAlpha = 0.28;             // dim with the rest when the focus is on a non-consumer
  // faint dashed hex seat — this cell is part of the grid, but clearly not a work-cell
  hexPath(ctx, cx, cy, size);
  ctx.fillStyle = withAlpha(col, hi ? 0.16 : 0.08);
  ctx.fill();
  ctx.lineWidth = hi ? 2 : 1.2; ctx.strokeStyle = withAlpha(col, hi ? 0.9 : 0.5);
  ctx.setLineDash([4, 3]); ctx.stroke(); ctx.setLineDash([]);
  // highlight halo when a focused xell wears this harness
  if (hi) {
    ctx.beginPath(); ctx.arc(cx, ay, r + 4, 0, Math.PI * 2);
    ctx.lineWidth = 2.5; ctx.strokeStyle = COL.text; ctx.stroke();
  }
  drawAvatarDisc(ctx, cx, ay, r, col, { img, glyph: h.glyph, letter: String(h.label || 'H')[0] });
  // label + consumer count
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = `600 ${Math.max(9, size * 0.16)}px 'Segoe UI', sans-serif`;
  ctx.fillStyle = COL.text;
  ctx.fillText(fit(ctx, h.label || '', hexWidth(size) * 0.82), cx, cy + size * 0.5);
  // ×N counts every xell WEARING it, not just the ones wired to this cell — a manager wears a harness
  // without consuming a cell for it (its own hexagon is the persona), and it still counts as harnessed.
  // A harness that carries NOTHING says so in WORDS in place of that count: it looked identical to a
  // full one here (same seat, same disc, same label) while every zee wearing it was briefed with a
  // blank page. Colour is reinforcement; the word is the signal.
  const warn = harnessWarning(h);
  const n = wearersOf(h).length;
  if (warn) {
    ctx.font = `700 ${Math.max(8, size * 0.14)}px 'Segoe UI', sans-serif`;
    ctx.fillStyle = COL.error;
    ctx.fillText(fit(ctx, `${warn}${n ? ` ×${n}` : ''}`, hexWidth(size) * 0.86), cx, cy + size * 0.68);
  } else if (n) {
    ctx.font = `600 ${Math.max(8, size * 0.13)}px 'Segoe UI', sans-serif`;
    ctx.fillStyle = COL.muted;
    ctx.fillText(`×${n}`, cx, cy + size * 0.68);
  }
  ctx.restore();
}

// The badge's word for a harness carrying nothing — `bundle_empty` (the harness row in the Zeehive
// project repo is unreadable from the queenzee) beats `bundle_empty` (no personality/skills/memory),
// because it names the CAUSE. Same two fields, same precedence and nearly the same words as the DOM
// surfaces (web/src/harnessHealth.js) — a canvas cannot import the JSX helper, so the wording is
// kept short here and the two are locked together by test/harness-empty-visible.test.mjs.
export function harnessWarning(h) {
  if (h?.bundle_empty) return '⚠ empty';
  return null;
}

// The persona disc: a preloaded avatar image, else the harness's authored glyph, else a lettermark —
// on a dark disc ringed in the badge's colour. Shared by the HARNESS badge and the MANAGER hexagon,
// so "a persona seated in the grid" is drawn by ONE piece of code and the two cannot drift apart.
function drawAvatarDisc(ctx, cx, cy, r, col, { img, glyph, letter } = {}) {
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = COL.bg; ctx.fill();
  ctx.lineWidth = 2; ctx.strokeStyle = col; ctx.stroke();
  if (img && img.complete && img.naturalWidth) {
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, r - 2, 0, Math.PI * 2); ctx.clip();
    ctx.drawImage(img, cx - (r - 2), cy - (r - 2), (r - 2) * 2, (r - 2) * 2);
    ctx.restore();
    return;
  }
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  if (glyph) {
    // authored persona badge: its chosen glyph (emoji/char) — no image needed
    ctx.font = `${r * 1.1}px 'Segoe UI Emoji', 'Segoe UI', sans-serif`;
    ctx.fillStyle = COL.text;
    ctx.fillText(String(glyph), cx, cy + r * 0.04);
  } else {
    ctx.fillStyle = col;
    ctx.font = `700 ${r}px 'Segoe UI', sans-serif`;
    ctx.fillText(String(letter || 'H'), cx, cy);
  }
}

// ── the MANAGER hexagon: a persona, not a work-cell ───────────────────────────
// Drawn in the HARNESS BADGE's language (dashed seat + the persona disc of the harness it wears) so a
// manager is identifiable across the room, before a single word is read — and deliberately WITHOUT
// the two things a manager can never act on: its head sha and its diffstat. In their place: the crew
// it runs (count, and how many are working / waiting on a human) and its read-only hold on prod. The
// prod-orange outer wall stays — that ring is the "this one holds production" tell.
export function drawManagerHex(ctx, hx, { hover, dim, crew = [], harness = null, img = null,
                                          related = null, relatedTo = null, relColor = null }) {
  const { cx, cy, size, x } = hx;
  const col = statusColor(x);                 // its hive status still colours it — a manager idles too
  const card = managerCard(x, crew);
  const w = hexWidth(size);
  ctx.save();
  if (dim) ctx.globalAlpha = 0.3;

  // seat: the status wash, stroked DASHED — the harness badge's "part of the grid, not a work-cell"
  hexPath(ctx, cx, cy, size);
  const g = ctx.createLinearGradient(cx, cy - size, cx, cy + size);
  const wash = heatWash(x, hover);
  g.addColorStop(0, withAlpha(col, wash.top));
  g.addColorStop(1, withAlpha(col, wash.bot));
  ctx.fillStyle = g;
  ctx.fill();
  ctx.lineWidth = hover ? 2.4 : 1.4;
  ctx.strokeStyle = hover ? col : withAlpha(col, 0.7);
  ctx.setLineDash([5, 3]); ctx.stroke(); ctx.setLineDash([]);
  // double wall in production orange: it runs a crew AND holds production read-only
  hexPath(ctx, cx, cy, size + 2.5);
  ctx.lineWidth = 2; ctx.strokeStyle = withAlpha(COL.prod, hover ? 0.95 : 0.7);
  ctx.setLineDash([5, 3]); ctx.stroke(); ctx.setLineDash([]);
  if (hx.color) {
    hexPath(ctx, cx, cy, size - 3);
    ctx.lineWidth = 1.3; ctx.strokeStyle = withAlpha(hx.color, 0.9); ctx.stroke();
  }

  // its relation mark sits OUTSIDE the prod wall (gap 6, not 3) so the two dashed rings stay two rings,
  // and its word prefers the strip ABOVE the persona disc — only falling onto the disc's top edge on a
  // hex too narrow up there to read the word whole (a manager IS its avatar; cover it last)
  const mark = () => (related
    ? drawRelationMark(ctx, cx, cy, size, { kind: related, slug: relatedTo, color: relColor,
                                            gap: 6, tagY: [-0.78, -0.62] })
    : null);

  ctx.save();
  hexPath(ctx, cx, cy, size - 2);
  ctx.clip();
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';

  if (size < 30) {                            // tiny: the persona dot, ringed prod-orange
    ctx.beginPath(); ctx.arc(cx, cy, Math.max(2, size * 0.24), 0, Math.PI * 2);
    ctx.fillStyle = col; ctx.fill();
    ctx.lineWidth = 1.2; ctx.strokeStyle = withAlpha(COL.prod, 0.9); ctx.stroke();
    ctx.restore(); mark(); ctx.restore(); return;
  }

  const full = size >= 52;
  // the persona it wears: the harness avatar/glyph, ⬢ when it wears none
  const discR = size * (full ? 0.24 : 0.26);
  const discY = cy - size * (full ? 0.42 : 0.3);
  drawAvatarDisc(ctx, cx, discY, discR, harness?.color || COL.prod,
    { img, glyph: harness?.glyph || (harness ? null : '⬢'), letter: String(harness?.label || 'M')[0] });
  // A manager IS its persona here — so when that persona carries nothing, the hexagon must say it.
  // (This is the shape the original bug took: a manager zee, correctly seated, wearing a harness
  // with no manual in it, and nothing on screen different from a manager that had one.)
  const hwarn = harnessWarning(harness);
  if (hwarn) {
    ctx.beginPath(); ctx.arc(cx, discY, discR + 3, 0, Math.PI * 2);
    ctx.lineWidth = 2; ctx.strokeStyle = COL.error; ctx.stroke();
    if (full) {
      ctx.font = `700 ${Math.max(7, size * 0.12)}px 'Segoe UI', sans-serif`;
      ctx.fillStyle = COL.error;
      ctx.fillText(fit(ctx, `${hwarn} harness`, w * 0.8), cx, cy - size * 0.17);
    }
  }

  // identity (⬢ slug), grown to fill the seat
  fillFont(ctx, card.label, w * 0.82, 8.5, size * 0.2, (p) => `600 ${p}px 'Segoe UI', sans-serif`);
  ctx.fillStyle = COL.text;
  ctx.fillText(fit(ctx, card.label, w * 0.82), cx, cy + size * (full ? 0.02 : 0.16));

  if (full) {
    // seam: what it is and how big its crew is — where a worker names its task
    const seam = `${card.role} · ${card.crew}`;
    fillFont(ctx, seam, w * 0.88, 7.5, size * 0.13, (p) => `italic ${p}px 'Segoe UI', sans-serif`);
    ctx.fillStyle = COL.muted;
    ctx.fillText(fit(ctx, seam, w * 0.88), cx, cy + size * 0.19);
    // the crew's ACTIVITY stands where a worker's DIFFSTAT stands — a manager's work is its crew.
    // Sized to FILL the card (the file's rule for every stat): it shrinks to fit rather than clipping
    // "1 working · 1 waiting" down to an ellipsis, which is where the whole line's information is.
    const line = card.activity || (card.count ? 'crew idle' : '—');
    fillFont(ctx, line, w * 0.82, 7, size * 0.15, (p) => `600 ${p}px 'Segoe UI', sans-serif`);
    ctx.fillStyle = card.activity ? COL.text : withAlpha(COL.muted, 0.75);
    const shown = fit(ctx, line, w * 0.82);
    ctx.fillText(shown, cx, cy + size * 0.35);
    // and the yellow "actively working" dot rides beside it, exactly as it does on a worker
    // — or the red pause icon when the xell is paused
    if (isBusyZee(x)) {
      drawBusyDot(ctx, cx - ctx.measureText(shown).width / 2 - size * 0.11, cy + size * 0.35,
        Math.max(2.4, size * 0.055));
    } else if (isPaused(x)) {
      drawPausedIcon(ctx, cx - ctx.measureText(shown).width / 2 - size * 0.11, cy + size * 0.35,
        Math.max(2.4, size * 0.055));
    }
  }

  // status pill — the same pill every hexagon carries
  const st = hiveStatusLabel(x);
  if (full && st) {
    ctx.font = `600 ${Math.max(7.5, size * 0.13)}px 'Segoe UI', sans-serif`;
    const pw = ctx.measureText(st).width + 12, ph = Math.max(11, size * 0.19);
    const py = cy + size * 0.53;
    ctx.beginPath(); ctx.roundRect(cx - pw / 2, py - ph / 2, pw, ph, ph / 2);
    ctx.fillStyle = withAlpha(col, 0.22); ctx.fill();
    ctx.lineWidth = 1; ctx.strokeStyle = withAlpha(col, 0.7); ctx.stroke();
    ctx.fillStyle = col;
    ctx.fillText(st, cx, py + 0.5);
    // where a worker's ship line sits: what this manager holds in production
    if (card.prodShort) {
      // the hex has tapered to ~60% of its width down here — ask the geometry, don't guess a fraction
      const room = hexHalfWidthAt(size, size * 0.7) * 2 * 0.9;
      ctx.font = `${Math.max(7.5, size * 0.125)}px 'Segoe UI', sans-serif`;
      ctx.fillStyle = COL.prod;
      ctx.fillText(fit(ctx, card.prodShort, room), cx, cy + size * 0.7);
    }
  } else if (!full) {
    ctx.font = `${Math.max(7.5, size * 0.15)}px 'Segoe UI', sans-serif`;
    ctx.fillStyle = COL.muted;
    ctx.fillText(fit(ctx, `⬡ ×${card.count} · ${st}`, w * 0.7), cx, cy + size * 0.38);
  }
  ctx.restore();   // unclip
  mark();
  ctx.restore();
}

// ── the CREW facet's dot row, as geometry ─────────────────────────────────────
// One dot per crew member, in petal 5 of a MANAGER's bloom. Pure and SHARED: the facet draws from this
// and the hit-test records from it (flowerCrewRects), so a dot can never be drawn somewhere the pointer
// does not find it — the flower's buttons and container icons are recorded the same way. `max` caps the
// row at what fits; the overflow is counted in words ("+3") rather than crammed in.
export const CREW_PETAL = 5;
export function crewDotLayout(cx, cy, size, count, max = 12) {
  const shown = Math.min(Math.max(0, count), max);
  const r = Math.max(2.5, size * 0.05);
  const gap = r * 2.8;
  const y = cy + size * 0.06;
  const x0 = cx - ((shown - 1) * gap) / 2;
  return {
    r, y, gap, shown, hidden: Math.max(0, count - shown),
    dots: Array.from({ length: shown }, (_, i) => ({ x: x0 + i * gap, y, r })),
  };
}
// World-space pick targets for those dots, one per crew member: hovering one emits that WORKER's id —
// which lights its hexagon, its wire and its commit dot (#24/#25) — and clicking it opens its own
// bloom. The pick radius is padded well past the drawn dot: a 3px disc is a target you have to aim at.
export function flowerCrewRects(centers, size, crew = []) {
  const rows = crew || [];
  const centre = centers?.[CREW_PETAL];
  if (!rows.length || !centre) return null;
  const lay = crewDotLayout(centre[0], centre[1], size, rows.length);
  const pick = Math.max(lay.r * 1.9, 7);
  return lay.dots.map((d, i) => ({ x: d.x, y: d.y, r: pick, id: rows[i].id, slug: rows[i].slug }));
}

// ── the flower: rendered ON the grid cells it consumes (no overlay) ───────────
// Exported for the same reason the two hexagons are: its CREW facet is now an interactive list, and the
// only honest way to assert what a human sees there is to paint it into a recording 2D context.
export function drawFlower(ctx, centers, size, x, diff, machines, traceColor, crew = [], { hoverId = null } = {}) {
  const col = statusColor(x);
  // A manager's bloom keeps the five facets it has (identity, branch, session, containers, machine)
  // and swaps the two GIT facets — commit head and diffstat — for the two things a manager owns:
  // its CREW and its read-only reach into production.
  const petals = isManagerXell(x) ? managerFacets(x, machines, crew) : flowerFacets(x, diff, machines);
  // the focused bloom stays vivid, but still darker when cold / brighter when hot (base lifts it)
  const wash = heatWash(x, false, 0.14);
  centers.forEach(([hx, hy], i) => {
    const facet = petals[i];
    const isCenter = i === 0;
    ctx.save();
    hexPath(ctx, hx, hy, size - 1.5);
    const g = ctx.createLinearGradient(hx, hy - size, hx, hy + size);
    if (isCenter) { g.addColorStop(0, withAlpha(col, wash.top)); g.addColorStop(1, withAlpha(col, wash.bot)); }
    else { g.addColorStop(0, withAlpha(COL.panel, 1)); g.addColorStop(1, withAlpha(COL.bg, 1)); }
    ctx.fillStyle = g;
    ctx.fill();
    ctx.lineWidth = isCenter ? 2.4 : 1.4;
    ctx.strokeStyle = isCenter ? col : withAlpha(col, 0.45);
    ctx.stroke();
    ctx.clip();
    drawFacet(ctx, hx, hy, size, facet, col, isCenter, x, traceColor, { hoverId });
    ctx.restore();
  });
}

// Per-hex CXELL indicator as a small inline lock GLYPH, shown before the machine name. The ︎
// (VS15) forces monochrome text presentation so ctx.fillStyle actually tints it. Reads runtime_key:
// cxell → 🔒 green (confined, on-protocol); local → 🔓 red (uncxell — the one to spot); remote → 🔒
// amber. null (no zee assigned yet) → no lock, keep the plain ⌂ machine glyph.
function cxellLock(x) {
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
// SESSION(2), pull(+land) in COMMIT(5), PR(+ship) in DIFF·AGE(6), mark-done in BRANCH(1).
//
// VISIBILITY follows the STATE OF THE WORK, not whether a request was raised — so a zee that
// finishes is never left hanging waiting for a human who has no button to click (Mark, 2026-07-22):
//   • land  shows whenever there is committed work not yet on main (diff.ahead > 0) — you have
//     something to land — OR a land request is already pending.
//   • ship  shows whenever the work is landed, clean and not yet in prod (shipLine 'ready') — you
//     have something to ship — OR a ship request is already pending.
//   • mark-done is ALWAYS visible, regardless of status — it is the teardown verb and must never be
//     gated behind a particular lifecycle state.
// The natural progression falls out: unlanded → land, landed → ship, and done is always there. A
// pending request is OR'd in so the button still surfaces before the diff has loaded. Buttons sit
// low in their petal so the facet's own text still reads above them.
export function petalVerbs(x, diff) {
  if (x.is_production) return {};
  const buildable = (x.stack || []).some((c) => c.role === 'server' || c.role === 'webapp');
  const cxell = x.viewer_kind === 'ssh-terminal' && !!x.viewer_url;
  const manager = isManagerXell(x);
  const st = x.hive_status;
  const canLand = (!!diff && diff.ahead > 0)                      // committed work not yet on main…
    || st === 'occ-landRequest' || st === 'occ-landHint';         // …or a land request/hint standing
  const canShip = shipLine(x, diff) === 'ready'                   // landed, clean, not in prod…
    || st === 'occ-shipRequest' || st === 'occ-shipHint';         // …or a ship request/hint standing
  const v = {};
  if (buildable) v[3] = ['build'];                                // CONTAINERS petal
  // SESSION petal (2): pause/play per-xell control, then terminal/nudge for live cxells
  const xellHive = x.hive_status;
  const xPaused = xellHive === 'occ-paused';
  v[2] = cxell
    ? (xPaused ? ['resume', 'terminal', 'nudge'] : ['pause', 'terminal', 'nudge'])
    : (xPaused ? ['resume'] : ['pause']);
  v[4] = cxell ? ['env', 'message'] : ['env'];                    // MACHINE petal
  // BRANCH petal — the two ways a xell's current job ENDS, side by side, because they are each
  // other's alternative: SWAP keeps the xell and changes who is in it (same branch, same commits,
  // same containers, same db, same card), DONE tears it down. A human reaching for "mark done"
  // because the persona in there is wrong should see the cheaper verb in the same breath.
  //
  // Not on a MANAGER: re-dispatching a manager re-mints its production read-only role (a live
  // CREATE/ALTER ROLE + password rotation), so the server refuses to re-crew one — and a button that
  // can only ever return a refusal is the same mistake as drawing `land` on a manager.
  v[1] = manager ? ['done'] : ['swap', 'done'];
  // The GIT verbs — pull, land and PR — exist only for a xell that can write to the xource. A MANAGER
  // cannot: xellgit's ctx() refuses every git write verb for it, and the landgate declines its push
  // without even raising a request. Drawing those buttons on a manager offers a human three clicks
  // that can only ever return a refusal, so the manager's two petals (CREW, PROD·AGE) carry neither.
  // SHIP stays: a ship is deliberately NOT blocked for a manager — it is often the agent holding the
  // whole picture, and the ship gate still refuses anything unlanded and still runs from main.
  if (!manager) {
    v[5] = canLand ? ['pull', 'land'] : ['pull'];                 // COMMIT petal
    v[6] = canShip ? ['pr', 'ship'] : ['pr'];                     // DIFF·AGE petal
  } else if (canShip) {
    v[6] = ['ship'];                                              // PROD·AGE petal
  }
  return v;
}

// kind → the label and accent it is drawn with (the verb list above stays pure/testable).
const VERB_LABEL = {
  build: '🔨 build', terminal: '⌨', nudge: '💬', env: '❖ env', message: '📨 message',
  pull: '↓ pull', land: '⬆ land', pr: 'PR', ship: '🚀 ship', swap: '♻ swap zee',
  pause: '⏸', resume: '▶',
};
const VERB_ACCENT = { nudge: 'working', message: 'working', land: 'working', ship: 'prod',
  done: 'error', swap: 'working', pause: 'error', resume: 'working' };
// Verb tooltips shown when hovering an icon-only button on the canvas flower.
const VERB_TOOLTIP = {
  terminal: 'Open a live terminal into this cxell zee',
  nudge: 'Nudge the zee back into its session — calls it after a pause or inactivity',
  build: 'Build the app tier containers',
  env: 'View this xell\'s environment variables',
  message: 'Send a message to this zee',
  pull: 'Pull latest from the remote source',
  land: 'Land your committed work on main',
  pr: 'Open a pull request',
  ship: 'Ship to production',
  swap: 'Swap the zee for a different persona',
  done: 'Mark this xell done',
  pause: 'Pause this xell — interrupts its zee mid-turn',
  resume: 'Resume this xell — calls the zee back',
};

function drawFlowerButtons(ctx, centers, size, x, diff) {
  if (x.is_production) return [];
  const verbs = petalVerbs(x, diff);
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

  // mark-done reads its state (confirm / mark / clean up); every other verb has a fixed label.
  const doneLabel = x.status === 'awaiting-done' ? '✓ confirm done' : (x.task_id ? '✓ mark done' : '✕ clean up');
  const accent = { working: G, prod: P, error: D };
  for (const [petal, kinds] of Object.entries(verbs)) {
    row(Number(petal), (kinds || []).map((kind) => ({
      kind,
      label: kind === 'done' ? doneLabel : VERB_LABEL[kind] || kind,
      accent: accent[VERB_ACCENT[kind]] || R,
    })));
  }
  return rects;
}

// Which PETAL is which diffstat — the two facets whose numbers open the DIFF VIEWER when clicked.
// A petal's index IS its facet index (drawFlower maps centers[i] → flowerFacets()[i]), so this must
// move with the facet order in flowerFacets: 5 = 'commit' (source diff), 6 = 'diff · age' (own diff).
// On a MANAGER those two petals are CREW and PROD·AGE instead (managerFacets), so there is no diff to
// open — hence `diffPetal()` rather than a bare lookup: a dead click beats the wrong viewer.
const DIFF_PETAL = { 5: 'srcdiff', 6: 'owndiff' };
const diffPetal = (x, cell) => (isManagerXell(x) ? null : DIFF_PETAL[cell] || null);

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
    { title: 'machine', lines: [machineOf(x, machines) || '—',
      x.env_key ? `❖ ${x.env_key}${Number(x.env_var_count) === 0 ? ' ∅' : ` ·${x.env_var_count}`}` : (x.runtime_label || '')] },
    { title: 'commit', kind: 'commitdiff',
      lines: [(x.is_production ? x.deployed_commit : (diff?.head || x.head_commit))?.slice(0, 8) || '—'], diff },
    { title: 'diff · age', kind: 'owndiff', diff, age: ageText(x.created_at) },
  ];
}

// The MANAGER bloom: the same seven petals, with the two GIT facets replaced. Petal 5 (commit head +
// source diffstat) and petal 6 (own diffstat) describe landing work — the one thing a manager is
// structurally refused — so they are swapped for CREW (who it runs, and what they are doing) and
// PROD · AGE (its read-only hold on production). Pure, so the swap is unit-tested rather than eyeballed.
export function managerFacets(x, machines, crew = []) {
  const base = flowerFacets(x, null, machines);
  const card = managerCard(x, crew);
  const f = base.slice();
  f[1] = { title: 'branch', lines: [stripBranch(x.branch) || '—', 'lands nothing — dispatches workers'] };
  f[5] = { title: 'crew', kind: 'crew', crew: (crew || []).map((w) => ({
    id: w.id, slug: shortSlug(w.slug), color: statusColor(w), busy: isBusyZee(w),
  })), card };
  f[6] = { title: 'prod · age', lines: [card.prod || 'no prod bind',
    base[6].age ? `age ${base[6].age}` : ''] };
  return f;
}

function drawFacet(ctx, cx, cy, size, facet, col, isCenter, x, traceColor, { hoverId = null } = {}) {
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

  // CREW facet (managers only): one status-coloured dot per worker — the same colour its own hexagon
  // is painted, so the cluster seated around this manager and this row read as the same crew — over
  // the count, and a caption of what they are doing. This is a manager's "diffstat": its work is the
  // crew, not a patch.
  if (facet.kind === 'crew') {
    ctx.textBaseline = 'middle';
    const card = facet.card || {};
    const rows = facet.crew || [];
    const headW = hexHalfWidthAt(size, size * 0.18) * 2 * 0.8;
    fillFont(ctx, `⬡ ×${rows.length}`, headW, 10, size * 0.3, (p) => `700 ${p}px 'Segoe UI', sans-serif`);
    ctx.fillStyle = rows.length ? COL.text : withAlpha(COL.muted, 0.8);
    ctx.fillText(rows.length ? `⬡ ×${rows.length}` : '⬡ no crew', cx, cy - size * 0.18);
    // The dot row is a LIST OF WORKERS, and it is interactive: hovering a dot lights that worker
    // everywhere (hexagon, wire, commit dot) and clicking it opens its own bloom. Two consequences for
    // the drawing. First, the geometry comes from crewDotLayout — the same function the hit-test reads,
    // so the dot you point at is the worker you get. Second, a dot was a COLOUR-ONLY signal (status
    // hue, nothing else): hovering one now NAMES it, because the word is the signal here too.
    const hovered = rows.findIndex((w) => w.id && w.id === hoverId);
    if (rows.length) {
      const lay = crewDotLayout(cx, cy, size, rows.length);
      lay.dots.forEach((d, i) => {
        const wkr = rows[i];
        const on = i === hovered;
        ctx.beginPath(); ctx.arc(d.x, d.y, on ? d.r * 1.6 : d.r, 0, Math.PI * 2);
        ctx.fillStyle = wkr.color; ctx.fill();
        if (on) {                                  // the one under the cursor: ringed, so it is unmissable
          ctx.lineWidth = 1.6; ctx.strokeStyle = COL.text; ctx.stroke();
        } else if (wkr.busy) {
          ctx.lineWidth = 1.2; ctx.strokeStyle = withAlpha('#ffd93b', 0.9); ctx.stroke();
        }
      });
      if (lay.hidden) {
        ctx.font = `${Math.min(9.5, size * 0.12)}px 'Segoe UI', sans-serif`;
        ctx.fillStyle = COL.muted;
        ctx.fillText(`+${lay.hidden}`, cx, lay.y + lay.r * 3);
      }
      // the affordance, DRAWN — this file's rule: on a canvas there is no cursor:pointer to discover by
      // hovering half a pixel. A hairline under the row says "these are links"…
      const rowW = (lay.shown - 1) * lay.gap + lay.r * 2;
      drawStatLink(ctx, cx, { y: lay.y + lay.r * (lay.hidden ? 4.2 : 1.6), width: rowW }, null);
    }
    // …and this line says what you can do with them, in words. It sits BELOW the caption rather than
    // sharing it: the caption is already a full line of information ("1 working · 1 waiting"), and an
    // affordance that has to fight the information for room is the one that loses.
    const room = (dy) => hexHalfWidthAt(size, size * dy) * 2 * 0.9;
    const pick = (variants, r) => variants.find((t) => ctx.measureText(t).width <= r) || null;
    // The caption: the crew's ACTIVITY — unless a dot is under the cursor, in which case it names WHO
    // that is. A named worker beats "1 working · 1 waiting" while you are pointing at one, and until now
    // a dot said nothing at all but its status colour.
    ctx.font = `${Math.min(10, size * 0.13)}px 'Segoe UI', sans-serif`;
    ctx.fillStyle = hovered >= 0 ? COL.text : COL.muted;
    ctx.fillText(fit(ctx, hovered >= 0
      ? `⬡ ${rows[hovered].slug}`
      : card.activity || (card.count ? 'crew idle' : 'nothing dispatched yet'), room(0.3)),
    cx, cy + size * 0.3);
    if (rows.length) {
      ctx.font = "9px 'Segoe UI', sans-serif";
      ctx.fillStyle = withAlpha(COL.muted, 0.75);
      // longest that FITS; if even the short form cannot be read, nothing is drawn rather than an
      // ellipsised instruction (a truncated verb is not an affordance)
      const say = hovered >= 0
        ? pick(['click to open it', 'open it'], room(0.44))
        : pick(['hover a dot · click to open', 'hover a dot'], room(0.44));
      if (say) ctx.fillText(say, cx, cy + size * 0.44);
    }
    return;
  }

  // COMMIT facet: sha, the source diff (↑ahead ↓behind · files, git-coloured +ins/−del), and this
  // xell's own BURN (tokens + $ its zees have consumed). Stacked above the pull/push buttons.
  if (facet.kind === 'commitdiff') {
    ctx.textBaseline = 'middle';
    // the head sha reads in the git graph's trace colour for this xell (its wire + commit-dot ring),
    // tying the bloom to its line in the graph the same way the compact hex does.
    ctx.fillStyle = traceColor || COL.text;
    // sha grows to fill the petal width (this facet is crowded with the burn line + pull/push
    // buttons below, so it stays single-line — width-fill only, no wrap).
    const shaW = hexHalfWidthAt(size, size * 0.16) * 2 * 0.9;
    fillFont(ctx, facet.lines[0] || '—', shaW, 9, size * 0.22,
      (px) => `600 ${px}px 'Cascadia Code', monospace`);
    ctx.fillText(facet.lines[0] || '—', cx, cy - size * 0.16);
    const d = facet.diff;
    if (d) {
      const dW = hexHalfWidthAt(size, size * 0.08) * 2 * 0.9;
      const row = drawDiffFilled(ctx, cx, cy + size * 0.08, [
        { t: `↑${d.ahead} ↓${d.behind} · ${d.files}f `, c: COL.muted },
        { t: `+${d.insertions}`, c: COL.add },
        { t: `/−${d.deletions}`, c: COL.del },
      ], { maxW: dW, minPx: 9, maxPx: size * 0.2 });
      // The stat is CLICKABLE (onPointerUp dispatches 'srcdiff' → the diff viewer), so it is drawn
      // like a link: underlined, with a one-word affordance. A number nobody knows they can click
      // is the same as a number they cannot.
      drawStatLink(ctx, cx, row, 'read the diff');
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
      // yellow blinking "actively working" dot, just left of the (first) diff row, or red pause icon
      if (isBusyZee(x)) {
        drawBusyDot(ctx, cx - row.width / 2 - size * 0.14, row.y, Math.max(3, size * 0.06));
      } else if (isPaused(x)) {
        drawPausedIcon(ctx, cx - row.width / 2 - size * 0.14, row.y, Math.max(3, size * 0.06));
      }
      // clickable, exactly like the source stat above → 'owndiff' (see onPointerUp)
      drawStatLink(ctx, cx, { ...row, y: row.wrapped ? row.y + size * 0.2 : row.y }, 'read the diff');
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
  // MACHINE facet gets the cxell lock prefixed to the machine name (tinted), like the compact hex.
  const lock = facet.title === 'machine' ? cxellLock(x) : null;
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
