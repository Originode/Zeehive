import React, { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { computeGraph } from './hive/graph.js';
import { crewLinks, relatedTo, focusIdOf, REL_DASH_ATTR } from './hive/crew.js';
import { cleanXourceNow, commitXourceStaged, stashXourceNow, getXourceState } from './api.js';
// Dialog + DiffViewer are loaded on click (dynamic import) so GraphPane stays a plain-ESM-friendly
// module for the SSR unit tests that transform only this file — those are JSX and would break them.

// The git graph as the centre divider — proper GitLens-style lanes (ported from GitRail), oriented
// by aspect: a VERTICAL spine in landscape, a HORIZONTAL one in portrait. It is a fixed-step spine
// that SCROLLS along its length so the production xell's commit dot always sits directly across from
// the prod hexagon and tracks it as the honeycomb pans — which is what keeps prod's connector wire a
// straight perpendicular line. The scroll offset is applied imperatively (group transform) on every
// canvas frame so it stays glued without re-rendering. Dots carry data-commit for <Connectors>.
//
// Each row reads like GitLens: <short hash> <commit subject>, the head PREPENDED before the message.
// The pane is user-RESIZABLE (drag the panels-facing edge); its width persists per orientation.
// Squeeze it narrow and it COMPRESSES — the subjects drop out and it shows only the commit heads
// (short hashes). Portrait starts compressed too (a rotated spine parks a short hash against the
// dot), but expand the band PAST the width of those heads and the subjects fan back in along the
// same 45° diagonal, trailing away from the honeycomb into the space the drag just freed.
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

// ── a commit dot's ANCHOR RING: whose xell sits here, and how it relates to the focus ──
// The ring around a dot says "a xell is anchored at this commit" (in that xell's trace colour). On top
// of that it carries the hive's focus vocabulary, the same one the hexes and the wires use:
//   the focus  → a SOLID bright ring (unchanged)
//   related    → the same ring, DASHED (hive/crew.js REL_DASH) — a manager's live crew, marked here as
//                "related to what you are looking at", never as the thing you are looking at
//   otherwise  → the plain anchor ring, or none at all
// Pure so it can be asserted as data; the component below only renders it.
export function anchorRing({ ring = null, hovered = false, related = null }) {
  if (hovered) return { show: true, stroke: 'var(--text)', width: 2.5, dash: null };
  if (related) return { show: true, stroke: 'var(--text)', width: 2, dash: REL_DASH_ATTR };
  return { show: !!ring, stroke: ring, width: 2, dash: null };
}

// Broken-pipe glyph — two pipe halves with a crack. Drawn as inline SVG so it stays crisp at the
// 14px tip size and does not depend on an emoji font. Used when the xource index has staged paths
// (which should never happen on main, but does when a ship/projection/interrupted merge leaves
// dirt behind).
function BrokenPipeIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" className="graph-broken-pipe-icon">
      {/* upper pipe half */}
      <path d="M3 1.5 h4 v5.2 l-1.2 1.2 H3 z" fill="currentColor" opacity="0.95" />
      <path d="M3 1.5 h4" stroke="currentColor" strokeWidth="1.2" fill="none" />
      {/* lower pipe half, offset to read as broken */}
      <path d="M9 8.2 l1.3-1.2 H13 v7.5 H9 z" fill="currentColor" opacity="0.95" />
      {/* crack / X between the halves */}
      <path d="M5.5 7.2 L10.5 10.8 M10.5 7.2 L5.5 10.8" stroke="currentColor" strokeWidth="1.4"
            strokeLinecap="round" />
    </svg>
  );
}

// Proper-sized modal from the broken-pipe tip: status, clickable diffs (open DiffViewer preview),
// rogue files (click → preview that file), Clear / Stash / Commit. Portaled to <body> so the
// graph pane's stacking context cannot bury it (same lesson as Dispatch / Project setup).
function XourceStagedModal({ projectId, xource, onClose, onChanged }) {
  const [state, setState] = useState(xource || null);
  const [busy, setBusy] = useState(null);   // 'clear' | 'commit' | 'stash' | 'reload' | null
  const [err, setErr] = useState(null);
  const [note, setNote] = useState(null);

  const reload = useCallback(async () => {
    if (!projectId) return;
    setBusy('reload'); setErr(null);
    try {
      const s = await getXourceState(projectId);
      setState(s);
      if (s?.ok && !s.has_staged && s.clean) onClose?.();
    } catch (e) { setErr(e.message); }
    finally { setBusy(null); }
  }, [projectId, onClose]);

  useEffect(() => { if (xource) setState(xource); }, [xource]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); onClose?.(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Open the shared DiffViewer on a xource scope (and optional file). Dynamic import keeps
  // GraphPane's SSR unit tests from having to bundle DiffViewer.jsx.
  const openDiff = async (scope, focusPath = null) => {
    if (!projectId) return;
    const { showDiff } = await import('./DiffViewer.jsx');
    const labels = {
      staged: 'Xource · staged (what Commit would land)',
      unstaged: 'Xource · unstaged + untracked',
      all: 'Xource · all uncommitted',
    };
    showDiff({
      kind: 'xource',
      projectId,
      scope: scope || 'all',
      focusPath: focusPath || undefined,
      title: focusPath ? `${focusPath}` : (labels[scope] || labels.all),
      subtitle: focusPath
        ? `${labels[scope] || labels.all} · click another file in the rail to jump`
        : 'live dirty tree on the main checkout',
    });
  };

  const clear = async () => {
    if (busy || !projectId) return;
    const { showPrompt } = await import('./Dialog.jsx');
    const typed = await showPrompt(
      'Clear the xource (discard staged / uncommitted work on the main checkout)?\n\n'
      + 'The queenzee will reset the main checkout to the main tip: abort any in-progress '
      + 'merge/rebase, discard staged and unstaged changes, remove untracked junk — PRESERVING '
      + 'every xell\'s worktree. This unblocks landings and ships.\n\nType CLEAR to confirm.',
      { title: 'Clear xource?', okLabel: 'Clear xource', variant: 'danger', placeholder: 'CLEAR' });
    if (String(typed || '').trim().toUpperCase() !== 'CLEAR') return;
    setBusy('clear'); setErr(null); setNote(null);
    try {
      const r = await cleanXourceNow(projectId, 'cleared from git-graph broken-pipe tip');
      setNote(r?.dry_run
        ? '✓ cleared (DRY-RUN — this queenzee models the fleet; the real xource was not touched)'
        : '✓ xource cleared — index and worktree reset to the main tip');
      await reload();
      onChanged?.();
    } catch (e) { setErr(e.message); }
    finally { setBusy(null); }
  };

  const stash = async () => {
    if (busy || !projectId) return;
    if (!state?.ok || state.clean || !state.dirty) {
      setErr('nothing dirty to stash');
      return;
    }
    const { showConfirm } = await import('./Dialog.jsx');
    const go = await showConfirm(
      `Stash ${state.dirty} dirty path(s) on the xource?\n\n`
      + 'Staged, unstaged and untracked files are parked on the stash stack (ignored paths like '
      + '.claude/ worktrees stay put). The checkout becomes clean so landings/ships can move. '
      + 'Recover later with `git stash pop` on the host — this console does not pop stashes.\n\n'
      + 'Continue?',
      { title: 'Stash xource dirt?', okLabel: 'Stash it', variant: 'danger' });
    if (!go) return;
    setBusy('stash'); setErr(null); setNote(null);
    try {
      const r = await stashXourceNow(projectId);
      setNote(r?.dry_run
        ? `✓ would stash (DRY-RUN) — ${r.note || 'simulate mode'}`
        : `✓ stashed — ${r.stash_count != null ? `${r.stash_count} stash(es) on the stack` : 'checkout should be clean'}`);
      await reload();
      onChanged?.();
    } catch (e) { setErr(e.message); }
    finally { setBusy(null); }
  };

  const commit = async () => {
    if (busy || !projectId) return;
    if (!state?.has_staged) {
      setErr('nothing is staged — stage the paths you want, or Clear/Stash to remove them');
      return;
    }
    const { showPrompt, showConfirm } = await import('./Dialog.jsx');
    const n = state.staged_count || state.staged?.length || 0;
    const msg = await showPrompt(
      `Commit ${n} staged path(s) on the xource (main checkout)?\n\n`
      + 'This creates a REAL commit on main from whatever is currently in the index. Unstaged '
      + 'and untracked paths are left alone. Prefer Clear or Stash if the staged work was accidental.\n\n'
      + 'Commit message:',
      { title: 'Commit staged xource work', okLabel: 'Commit on main',
        placeholder: 'e.g. chore: keep projected .env out of the dirty index',
        defaultValue: '' });
    if (msg == null) return;
    if (!String(msg).trim()) { setErr('a commit message is required'); return; }
    const go = await showConfirm(
      `Commit to ${state.branch || state.main_branch || 'main'} with message:\n\n“${String(msg).trim()}”\n\n`
      + `${n} staged path(s) will land on main. Continue?`,
      { title: 'Confirm xource commit', okLabel: 'Commit on main', variant: 'danger' });
    if (!go) return;
    setBusy('commit'); setErr(null); setNote(null);
    try {
      const r = await commitXourceStaged(projectId, String(msg).trim());
      setNote(r?.dry_run
        ? `✓ would commit (DRY-RUN) — ${r.note || 'simulate mode'}`
        : `✓ committed ${r.short || ''} on ${state.branch || 'main'}`);
      await reload();
      onChanged?.();
    } catch (e) { setErr(e.message); }
    finally { setBusy(null); }
  };

  const s = state || {};
  const files = Array.isArray(s.files) ? s.files : [];
  const stagedDiff = s.diff?.staged || null;
  const unstagedDiff = s.diff?.unstaged || null;
  const kindLabel = (f) => {
    if (f.kind === 'untracked') return 'untracked';
    if (f.kind === 'staged') return `staged · ${f.status || 'changed'}`;
    if (f.kind === 'unstaged') return `unstaged · ${f.status || 'changed'}`;
    if (f.kind === 'staged+unstaged') return `staged+dirty · ${f.status || 'changed'}`;
    return f.kind || f.status || 'changed';
  };
  // Which patch scope a file click should open: staged-only files → staged; pure untracked →
  // unstaged (includes untracked synth); mixed or unstaged → all so both halves show.
  const scopeForFile = (f) => {
    if (f.kind === 'staged') return 'staged';
    if (f.kind === 'untracked' || f.kind === 'unstaged') return 'unstaged';
    return 'all';
  };
  const fmtStat = (d) => {
    if (!d) return null;
    const f = d.files || 0;
    return `${f} file${f === 1 ? '' : 's'} · +${d.insertions || 0}/−${d.deletions || 0}`;
  };

  // Portal to body: GraphPane sits inside a stacking context the honeycomb wires sit above.
  return createPortal(
    <div className="xource-modal-overlay" data-testid="xource-staged-overlay"
         onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
      <div className="xource-modal" data-testid="xource-staged-pop" role="dialog" aria-modal="true"
           aria-label="Xource staged changes" onMouseDown={(e) => e.stopPropagation()}>
        <div className="xource-modal-head">
          <div className="xource-modal-title">
            <BrokenPipeIcon size={16} />
            <div>
              <div>Broken pipe — xource has staged work</div>
              <div className="xource-modal-sub">
                Main checkout dirt wedges every landing and ship. Inspect the diff, then Clear,
                Stash, or Commit.
              </div>
            </div>
          </div>
          <button className="xource-modal-x" onClick={onClose} title="Close (Esc)" aria-label="Close">✕</button>
        </div>

        <div className="xource-modal-body">
          <div className="xource-modal-status" data-testid="xource-staged-status">
            {s.ok === false && <div className="xource-modal-err">cannot read xource: {s.error}</div>}
            {s.ok && (
              <>
                <div className="xource-modal-summary">{s.summary}</div>
                <div className="xource-modal-meta">
                  <span>branch <b className="mono">{s.branch || '—'}</b></span>
                  {s.head && <span>HEAD <b className="mono">{String(s.head).slice(0, 10)}</b></span>}
                  {!!s.stash_count && <span>stash stack <b>{s.stash_count}</b></span>}
                </div>
              </>
            )}
          </div>

          {/* Diff chips — click opens the full DiffViewer preview. */}
          <div className="xource-modal-diffs" data-testid="xource-staged-diffs">
            <div className="xource-modal-sec-h">Diff <span className="pc">click to preview the changes</span></div>
            <div className="xource-modal-diff-row">
              <button type="button" className="xource-diff-chip" data-testid="xource-diff-staged"
                      disabled={!s.ok || !(stagedDiff?.files > 0 || s.has_staged)}
                      title="Preview the staged index — what Commit it would land on main"
                      onClick={() => openDiff('staged')}>
                <span className="xource-diff-chip-k">Staged</span>
                <span className="xource-diff-chip-v">
                  {fmtStat(stagedDiff) || (s.has_staged ? `${s.staged_count || s.staged?.length || 0} path(s)` : 'none')}
                </span>
                <span className="xource-diff-chip-go">preview →</span>
              </button>
              <button type="button" className="xource-diff-chip" data-testid="xource-diff-unstaged"
                      disabled={!s.ok || !((unstagedDiff?.files > 0) || (s.untracked?.length > 0)
                        || files.some((f) => f.kind === 'unstaged' || f.kind === 'untracked'))}
                      title="Preview unstaged tracked changes and untracked files"
                      onClick={() => openDiff('unstaged')}>
                <span className="xource-diff-chip-k">Unstaged</span>
                <span className="xource-diff-chip-v">
                  {fmtStat(unstagedDiff)
                    || (s.untracked?.length ? `${s.untracked.length} untracked` : 'none')}
                  {!!s.untracked?.length && unstagedDiff?.files > 0
                    ? ` · ${s.untracked.length} untracked` : ''}
                </span>
                <span className="xource-diff-chip-go">preview →</span>
              </button>
              <button type="button" className="xource-diff-chip xource-diff-chip-all"
                      data-testid="xource-diff-all"
                      disabled={!s.ok || s.clean || !s.dirty}
                      title="Preview everything uncommitted on the xource"
                      onClick={() => openDiff('all')}>
                <span className="xource-diff-chip-k">All changes</span>
                <span className="xource-diff-chip-v">
                  {s.dirty ? `${s.dirty} path(s)` : 'none'}
                </span>
                <span className="xource-diff-chip-go">preview →</span>
              </button>
            </div>
          </div>

          <div className="xource-modal-files" data-testid="xource-staged-files">
            <div className="xource-modal-sec-h">
              Rogue files <span className="pc">click a path to preview its diff</span>
            </div>
            {!files.length && <div className="pc">no rogue paths right now</div>}
            <ul>
              {files.map((f) => (
                <li key={`${f.kind}:${f.path}`} data-kind={f.kind}>
                  <button type="button" className="xource-file-btn"
                          title={`Preview diff for ${f.path}`}
                          onClick={() => openDiff(scopeForFile(f), f.path)}>
                    <span className={`graph-xource-kind k-${(f.kind || '').split('+')[0]}`}>{kindLabel(f)}</span>
                    <span className="mono graph-xource-path">
                      {f.old_path ? `${f.old_path} → ${f.path}` : f.path}
                    </span>
                    <span className="xource-file-go">diff →</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>

          {err && <div className="xource-modal-err" data-testid="xource-staged-err">{err}</div>}
          {note && <div className="xource-modal-note" data-testid="xource-staged-note">{note}</div>}
        </div>

        <div className="xource-modal-actions">
          <button className="graph-xource-clear" data-testid="xource-staged-clear"
                  disabled={!!busy || !s.ok || s.clean}
                  title="Discard staged/uncommitted work — reset the main checkout to the main tip"
                  onClick={clear}>
            {busy === 'clear' ? 'Clearing…' : 'Clear it'}
          </button>
          <button className="graph-xource-stash" data-testid="xource-staged-stash"
                  disabled={!!busy || !s.ok || s.clean || !s.dirty}
                  title="Park dirty work on the stash stack so the checkout is clean (recover with git stash pop on the host)"
                  onClick={stash}>
            {busy === 'stash' ? 'Stashing…' : 'Stash it'}
          </button>
          <span className="xource-modal-actions-spacer" />
          <button className="graph-xource-commit" data-testid="xource-staged-commit"
                  disabled={!!busy || !s.ok || !s.has_staged}
                  title="Create a commit on main from the staged index (unstaged paths stay dirty)"
                  onClick={commit}>
            {busy === 'commit' ? 'Committing…' : 'Commit it'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export default function GraphPane({ timeline, xells = [], orientation, honeySide, hexPosRef, prodIds = [],
                                   expandedId = null, subscribeGeom,
                                   hoverRef, setHover, subscribeHover, onFlip, onReposition,
                                   showHarness = true, onToggleHarness,
                                   xource = null, projectId = null, onXourceChanged }) {
  const [pipeOpen, setPipeOpen] = useState(false);
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

  // text room left after the lanes → decides whether we can show subjects at all. In portrait the
  // label reads on a 45° diagonal, so a given band thickness affords √2× the horizontal text length
  // a landscape row of the same size would — which is why expanding the band past the commit heads
  // buys enough room to fan the subjects out beside them.
  const textPx = thickness - labelRaw - PAD;
  const avail = portrait ? textPx * Math.SQRT2 : textPx;
  const compressed = avail < MSG_MIN_PX;                 // heads-only until expanded past the heads
  const msgChars = Math.max(0, Math.floor(avail / CHAR_W) - HASH_COLS);

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

  // which commit(s) are highlighted: a hovered dot, the commit a hovered hex/wire sits on, or — when a
  // harness badge is hovered — the base commits of every xell that wears it (its through-traces all
  // originate from those dots, so they light up together).
  const hov = hoverRef ? hoverRef.current : { id: null, commit: null, harness: null };
  const hovCommits = new Set();
  if (hov.commit) hovCommits.add(hov.commit);
  if (hov.id) { const b = (timeline.xells || []).find((t) => t.id === hov.id)?.base_commit; if (b) hovCommits.add(b); }
  if (hov.harness) {
    const h = (timeline.harnesses || []).find((hh) => hh.id === hov.harness);
    // every xell that WEARS it — a manager wears one without taking a cell or a wire from it, and
    // its commit dot belongs in the same highlight (see wearersOf in hive/HiveCanvas.jsx).
    for (const id of h?.wearer_ids || h?.consumer_ids || []) {
      const b = (timeline.xells || []).find((t) => t.id === id)?.base_commit;
      if (b) hovCommits.add(b);
    }
  }

  // THE CREW RELATION in this projection (#25): the commits a manager's LIVE crew is anchored at (or,
  // focused on a worker, the commit its manager sits on). Same helpers as the honeycomb and the wire
  // overlay — the relationship is read from the fleet list, never re-derived here. A commit the FOCUS
  // itself sits on stays the focus: hovCommits wins, so a shared dot is never demoted to "related".
  const related = relatedTo(xells, focusIdOf(hov, expandedId), crewLinks(xells));
  const relCommits = new Set();
  for (const id of related.keys()) {
    const b = (timeline.xells || []).find((t) => t.id === id)?.base_commit;
    if (b && !hovCommits.has(b)) relCommits.add(b);
  }

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
            const hovered = hovCommits.has(c.hash);
            const rel = relCommits.has(c.hash) ? 'crew' : null;
            const anchor = anchorRing({ ring, hovered, related: rel });
            const subj = c.subject || '';
            const shownSubj = subj.length > msgChars ? subj.slice(0, Math.max(0, msgChars - 1)) + '…' : subj;
            return (
              <g key={c.hash} data-rel={rel || undefined}>
                {anchor.show && <circle cx={cx} cy={cy} r={DOT + 3} fill="none"
                        stroke={anchor.stroke} strokeWidth={anchor.width}
                        strokeDasharray={anchor.dash || undefined} />}
                <circle cx={cx} cy={cy} r={hovered ? DOT + 1 : DOT} data-commit={c.hash} data-dot
                        fill={isMerge ? 'var(--bg)' : LANE[lane % LANE.length]}
                        stroke={LANE[lane % LANE.length]} strokeWidth={isMerge ? 2 : 0} />
                {ring && <circle cx={cx} cy={cy} r={DOT + 6} fill="transparent" style={{ cursor: 'pointer' }}
                        onMouseEnter={() => emitHover({ id: null, commit: c.hash })}
                        onMouseLeave={() => emitHover({ id: null, commit: null })} />}
                {/* head PREPENDED before the subject. Heads-only when compressed; in portrait that is
                    a rotated short hash parked at the dot, and expanding the band past the heads fans
                    the subject out along the same diagonal — down-and-out with the honeycomb up top,
                    up-and-out with it below — so it trails into the freed space, never over the lanes. */}
                {portrait
                  ? (compressed
                      ? <text className="ghash" x={lx} y={ly} textAnchor="middle"
                              transform={`rotate(-45 ${lx} ${ly})`}>{c.short}</text>
                      : <text className={`gline${hovered ? ' hov' : ''}`} x={lx} y={ly} textAnchor="start"
                              transform={`rotate(${honeyLow ? 45 : -45} ${lx} ${ly})`}>
                          <tspan className="ghash">{c.short}</tspan>
                          {shownSubj && <tspan className="gsubj" dx="7">{shownSubj}</tspan>}
                        </text>)
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
      {/* BROKEN PIPE at the git-graph tip — the xource (main checkout) has staged items, which
          should never happen (landings refuse over a dirty tree; ships build from this checkout).
          Click opens the status / rogue-files / Clear / Commit popover. Hidden when the index is
          clean so the tip stays quiet on a healthy xource. */}
      {xource?.ok && xource.has_staged && (
        <button type="button"
                className={`graph-broken-pipe${pipeOpen ? ' open' : ''}`}
                data-orient={orientation}
                data-testid="graph-broken-pipe"
                aria-expanded={pipeOpen}
                aria-label={`Xource has ${xource.staged_count || xource.staged?.length || 0} staged path(s) — open to inspect, clear or commit`}
                title={`Broken pipe — ${xource.staged_count || xource.staged?.length || 0} staged path(s) on the xource. Click for status, rogue files, Clear or Commit.`}
                onClick={(e) => { e.stopPropagation(); setPipeOpen((o) => !o); }}>
          <BrokenPipeIcon size={15} />
          <span className="graph-broken-pipe-n">{xource.staged_count || xource.staged?.length || 0}</span>
        </button>
      )}
      {pipeOpen && (
        <XourceStagedModal
          projectId={projectId}
          xource={xource}
          onClose={() => setPipeOpen(false)}
          onChanged={() => onXourceChanged?.()}
        />
      )}
      {/* flip button lives IN the middle pane, at the end opposite the ⎇ branch label (which sits at
          the top in landscape / the left in portrait, so flip sits at the bottom / right). The SHOW
          HARNESS toggle stacks immediately above it — the one view control that belongs with the
          honeycomb's middle divider, because turning it off re-draws the traces this pane hosts. */}
      {(onFlip || onToggleHarness) && (
        <div className="graph-flip-stack" data-orient={orientation}
             style={{ position: 'absolute', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
                      ...(portrait
                        ? { right: 8, top: '50%', transform: 'translateY(-50%)' }
                        : { bottom: 8, left: '50%', transform: 'translateX(-50%)' }) }}>
          {onToggleHarness && (
            <button className={`graph-harness-toggle${showHarness ? ' on' : ''}`} data-orient={orientation}
                    data-testid="harness-toggle" aria-pressed={!!showHarness} onClick={onToggleHarness}
                    title={showHarness
                      ? 'Hide the harness hexagons — each wire then runs straight from its commit dot to its xell'
                      : 'Show the harness hexagons — a consumer wire routes through the badge it wears'}>
              show harness{showHarness ? ' ✓' : ''}
            </button>
          )}
          {onFlip && (
            <button className="graph-flip" data-orient={orientation} data-testid="flip-btn" onClick={onFlip}
                    title={`Flip the honeycomb to the other side (timeline follows so merge points keep facing it). Now: ${orientation}, honeycomb ${honeySide === 'a' ? (portrait ? 'top' : 'left') : (portrait ? 'bottom' : 'right')}`}>
              ⇄ flip
            </button>
          )}
        </div>
      )}
      {/* drag the panels-facing edge to resize; squeeze it to collapse subjects to heads only */}
      <div className={`graph-resize${compressed && !portrait ? ' compressed' : ''}`} data-orient={orientation}
           onPointerDown={onResizeDown}
           title="Drag to resize the graph — squeeze it to the commit heads, or expand it past them to reveal the commit messages"
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
