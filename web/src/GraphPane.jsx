import React, { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';
import { computeGraph } from './hive/graph.js';

// The git graph as the centre divider — proper GitLens-style lanes (ported from GitRail), oriented
// by aspect: a VERTICAL spine in landscape, a HORIZONTAL one in portrait. It is a fixed-step spine
// that SCROLLS along its length so the production xell's commit dot always sits directly across from
// the prod hexagon and tracks it as the honeycomb pans — which is what keeps prod's connector wire a
// straight perpendicular line. The scroll offset is applied imperatively (group transform) on every
// canvas frame so it stays glued without re-rendering. Dots carry data-commit for <Connectors>.
//
// Each landscape row reads like GitLens: <short hash> <commit subject>, the head PREPENDED before
// the message. The pane is user-RESIZABLE (drag the panels-facing edge); its width persists per
// orientation. Squeeze it narrow and it COMPRESSES — the subjects drop out and it shows only the
// commit heads (short hashes), exactly as it does in portrait where a rotated spine has no room for
// a message anyway.
const LANE = ['#e0a53b', '#e26fae', '#9ccf3f', '#5b8cff', '#35c46b', '#9b8cff',
  '#e5554e', '#3bc6c0', '#d98c5f', '#7bd0e0', '#c98cff', '#8cd98c'];

const LANE_W = 13, DOT = 4.5, PAD = 20, ROW = 24;
const HASH_LABEL = 66;      // room a rotated/short-hash label needs
const MSG_W = 236;          // default room for a commit subject in landscape
const CHAR_W = 6.2;         // ~px per char at the 11px subject font (for truncation)
const HASH_COLS = 8;        // "abc1234 " — hash + trailing space, in char columns
const MSG_MIN_PX = 96;      // below this much text room, compress to heads only

const median = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((p, q) => p - q), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export default function GraphPane({ timeline, orientation, honeySide, hexPosRef, prodIds = [], subscribeGeom,
                                   hoverRef, setHover, subscribeHover, onFlip, onReposition }) {
  const groupRef = useRef(null);
  const portrait = orientation === 'portrait';
  const [, forceHover] = useReducer((x) => x + 1, 0);
  useEffect(() => (subscribeHover ? subscribeHover(forceHover) : undefined), [subscribeHover]);
  const emitHover = setHover || (() => {});

  const commits = timeline?.commits || [];
  const graph = commits.length ? computeGraph(commits) : null;
  const laneCount = graph ? graph.laneCount : 1;

  // across geometry (perpendicular to the spine): lanes on the honey side, labels away from it
  const acrossExtent = laneCount * LANE_W;
  const labelRaw = PAD + acrossExtent + 10;           // where the text column starts (raw coord)

  // ── user-resizable thickness ────────────────────────────────────────────────
  // Width persists PER ORIENTATION: a landscape drag shouldn't dictate the portrait band's height.
  // The stored value is the cross-size in px; it is clamped to [min, max] against the CURRENT lane
  // count so growing the graph can never make the pane smaller than its own lanes + a hash.
  const sizeKey = `zeehive.graphSize.${orientation}`;
  const [userSize, setUserSize] = useState(null);
  useEffect(() => {
    const v = parseFloat(localStorage.getItem(sizeKey));
    setUserSize(Number.isFinite(v) ? v : null);
  }, [sizeKey]);
  const minThickness = labelRaw + HASH_LABEL + PAD;
  const maxThickness = labelRaw + 620;
  const baseThickness = portrait ? minThickness : (labelRaw + MSG_W + PAD);
  const thickness = Math.max(minThickness, Math.min(maxThickness, userSize || baseThickness));

  // text room left after the lanes → decides whether we can show subjects at all
  const textPx = thickness - labelRaw - PAD;
  const compressed = portrait || textPx < MSG_MIN_PX;   // heads-only when squeezed (or rotated)
  const msgChars = Math.max(0, Math.floor(textPx / CHAR_W) - HASH_COLS);

  const persistSize = useCallback((v) => {
    setUserSize(v);
    try { localStorage.setItem(sizeKey, String(Math.round(v))); } catch { /* private mode */ }
  }, [sizeKey]);

  // Drag the panels-facing edge to resize. That edge is the one AWAY from the honeycomb: with the
  // honey low (order 0) the panels sit high, so the handle is on the high edge and dragging further
  // out (toward the panels) widens the pane; flip the honeycomb and both mirror. clientX in
  // landscape, clientY in portrait.
  const honeyLow = honeySide === 'a';
  const onResizeDown = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    const axis = (ev) => (portrait ? ev.clientY : ev.clientX);
    const start = axis(e);
    const from = thickness;
    const dir = honeyLow ? 1 : -1;
    const onMove = (ev) => {
      const next = from + (axis(ev) - start) * dir;
      persistSize(Math.max(minThickness, Math.min(maxThickness, next)));
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
    document.body.style.userSelect = 'none';
    document.body.style.cursor = portrait ? 'row-resize' : 'col-resize';
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [portrait, honeyLow, thickness, persistSize, minThickness, maxThickness]);

  const acrossActual = (raw) => (honeyLow ? raw : thickness - raw);
  const laneRaw = (l) => PAD + l * LANE_W;            // lane 0 nearest the honey side

  const alongOf = (row) => PAD + row * ROW;           // fixed step — the spine scrolls, doesn't squash
  const fullLen = PAD * 2 + Math.max(1, commits.length) * ROW;

  const rowOf = {};
  commits.forEach((c, i) => { rowOf[c.hash] = i; });
  // intrinsic along of each prod's commit dot (before the scroll offset)
  const prodDotAlongs = (timeline?.xells || [])
    .filter((x) => prodIds.includes(x.id) && rowOf[x.base_commit] != null)
    .map((x) => alongOf(rowOf[x.base_commit]));
  const prodIdsKey = prodIds.join(',');

  const P = (a, raw) => (portrait ? [a, acrossActual(raw)] : [acrossActual(raw), a]);
  const pt = (a, raw) => { const [x, y] = P(a, raw); return `${x.toFixed(1)},${y.toFixed(1)}`; };

  // scroll the spine so the MEDIAN prod dot lands across from the MEDIAN prod hexagon → each prod's
  // wire stays a straight, near-perpendicular line that tracks as the honeycomb pans.
  const applyOffset = useCallback(() => {
    const grp = groupRef.current;
    if (!grp) return;
    const svg = grp.ownerSVGElement;
    let O = 0;
    const pos = (hexPosRef && hexPosRef.current) || {};
    const hexAlongs = prodIds.map((id) => pos[id]).filter(Boolean).map((hp) => (portrait ? hp.x : hp.y));
    const mHex = median(hexAlongs), mDot = median(prodDotAlongs);
    if (svg && mHex != null && mDot != null) {
      const sr = svg.getBoundingClientRect();
      const svgStart = portrait ? sr.left : sr.top;
      O = mHex - svgStart - mDot;
    }
    grp.setAttribute('transform', portrait ? `translate(${O.toFixed(1)},0)` : `translate(0,${O.toFixed(1)})`);
  }, [hexPosRef, prodIdsKey, prodDotAlongs.join(','), portrait]);   // eslint-disable-line react-hooks/exhaustive-deps

  // re-apply on every canvas frame (pan/zoom), and after each render / next frame (mount race)
  useEffect(() => subscribeGeom && subscribeGeom(applyOffset), [subscribeGeom, applyOffset]);
  useLayoutEffect(() => {
    applyOffset();
    const r = requestAnimationFrame(applyOffset);
    return () => cancelAnimationFrame(r);
  });

  const svgW = portrait ? fullLen : thickness;
  const svgH = portrait ? thickness : fullLen;
  const paneStyle = portrait
    ? { flex: `0 0 ${thickness}px`, height: thickness, width: '100%' }
    : { flex: `0 0 ${thickness}px`, width: thickness, height: '100%' };

  if (!graph) return <div className="graph-pane" data-orient={orientation} style={paneStyle} />;

  const anchors = {};                                 // base_commit → [xell colors] for the ring
  for (const x of (timeline.xells || [])) (anchors[x.base_commit] ||= []).push(x.color);

  const edgePath = (e) => {
    const fA = alongOf(e.fromRow), fC = laneRaw(e.fromLane);
    const tA = e.dangling ? alongOf(commits.length - 1) + ROW : alongOf(e.toRow), tC = laneRaw(e.toLane);
    if (e.fromLane === e.toLane) return `M${pt(fA, fC)} L${pt(tA, tC)}`;
    // GitLens weave: hold the lane, S-curve across one step, then run straight down the new lane
    return `M${pt(fA, fC)} C${pt(fA + ROW * 0.5, fC)} ${pt(fA + ROW * 0.4, tC)} ${pt(fA + ROW, tC)} L${pt(tA, tC)}`;
  };

  // which commit is highlighted: a hovered dot, or the commit a hovered hex/wire sits on
  const hov = hoverRef ? hoverRef.current : { id: null, commit: null };
  const hovCommit = hov.commit || (hov.id ? (timeline.xells || []).find((t) => t.id === hov.id)?.base_commit : null);

  return (
    <div className="graph-pane" data-orient={orientation} style={paneStyle}>
      <svg className="graph-svg" width={svgW} height={svgH}
           style={{ position: 'absolute', top: 0, left: 0 }}>
        <g ref={groupRef}>
          {graph.edges.map((e, i) => (
            <path key={i} d={edgePath(e)} fill="none" stroke={LANE[e.fromLane % LANE.length]}
                  strokeWidth="1.8" opacity="0.85" strokeLinecap="round" strokeLinejoin="round" />
          ))}
          {graph.rows.map(({ c, lane, row }) => {
            const [cx, cy] = P(alongOf(row), laneRaw(lane));
            const isMerge = c.parents.length > 1;
            const ring = anchors[c.hash]?.[0];
            const [lx, ly] = P(alongOf(row), labelRaw);
            const hovered = hovCommit === c.hash;
            const subj = c.subject || '';
            const shownSubj = subj.length > msgChars ? subj.slice(0, Math.max(0, msgChars - 1)) + '…' : subj;
            return (
              <g key={c.hash}>
                {(ring || hovered) && <circle cx={cx} cy={cy} r={DOT + 3} fill="none"
                        stroke={hovered ? 'var(--text)' : ring} strokeWidth={hovered ? 2.5 : 2} />}
                <circle cx={cx} cy={cy} r={hovered ? DOT + 1 : DOT} data-commit={c.hash} data-dot
                        fill={isMerge ? 'var(--bg)' : LANE[lane % LANE.length]}
                        stroke={LANE[lane % LANE.length]} strokeWidth={isMerge ? 2 : 0} />
                {ring && <circle cx={cx} cy={cy} r={DOT + 6} fill="transparent" style={{ cursor: 'pointer' }}
                        onMouseEnter={() => emitHover({ id: null, commit: c.hash })}
                        onMouseLeave={() => emitHover({ id: null, commit: null })} />}
                {/* head PREPENDED before the subject; heads-only when compressed / rotated */}
                {portrait
                  ? <text className="ghash" x={lx} y={ly} textAnchor="middle"
                          transform={`rotate(-45 ${lx} ${ly})`}>{c.short}</text>
                  : <text className={`gline${hovered ? ' hov' : ''}`} x={lx} y={ly + 3}
                          textAnchor={honeyLow ? 'start' : 'end'}>
                      <tspan className="ghash">{c.short}</tspan>
                      {!compressed && shownSubj && <tspan className="gsubj" dx="7">{shownSubj}</tspan>}
                    </text>}
              </g>
            );
          })}
        </g>
      </svg>
      <span className="graph-branch" data-orient={orientation}>⎇ {timeline.branch}</span>
      {/* flip button lives IN the middle pane, at the end opposite the ⎇ branch label (which sits at
          the top in landscape / the left in portrait, so flip sits at the bottom / right). */}
      {onFlip && (
        <button className="graph-flip" data-orient={orientation} data-testid="flip-btn" onClick={onFlip}
                title={`Flip the honeycomb to the other side (timeline follows so merge points keep facing it). Now: ${orientation}, honeycomb ${honeySide === 'a' ? (portrait ? 'top' : 'left') : (portrait ? 'bottom' : 'right')}`}
                style={portrait
                  ? { position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)' }
                  : { position: 'absolute', bottom: 8, left: '50%', transform: 'translateX(-50%)' }}>
          ⇄ flip
        </button>
      )}
      {/* drag the panels-facing edge to resize; squeeze it to collapse subjects to heads only */}
      <div className={`graph-resize${compressed && !portrait ? ' compressed' : ''}`} data-orient={orientation}
           onPointerDown={onResizeDown}
           title="Drag to resize the graph — squeeze it to show only the commit heads"
           style={portrait
             ? { position: 'absolute', left: 0, right: 0, height: 9, cursor: 'row-resize', [honeyLow ? 'bottom' : 'top']: 0 }
             : { position: 'absolute', top: 0, bottom: 0, width: 9, cursor: 'col-resize', [honeyLow ? 'right' : 'left']: 0 }} />
      {/* a grippable ICON at the pane's centre: drag it to SLIDE the whole middle pane along the
          split axis. The pane keeps its own size — instead the two OUTER panes trade space (drag up
          → top pane smaller, bottom bigger; drag left → left pane smaller). Thickness is the edge
          strip above; this only moves the divider. */}
      {onReposition && (
        <button className="graph-grip" data-orient={orientation} data-testid="graph-grip"
                onPointerDown={onReposition}
                title="Drag to slide the graph — moves the divider so one side pane grows while the other shrinks (the graph keeps its size; drag its edge to resize that)"
                style={{ position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%,-50%)',
                         cursor: portrait ? 'row-resize' : 'col-resize' }}>
          {portrait ? '⇕' : '⇔'}
        </button>
      )}
    </div>
  );
}
