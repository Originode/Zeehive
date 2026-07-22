// Sliding the git-graph "centre" divider. The middle pane keeps its own size (its thickness is a
// SEPARATE control — drag its panels-facing edge for that); this instead moves the whole middle
// pane along the split axis by trading space between the two OUTER panes. Drag toward the honeycomb
// and the honey pane shrinks while the panels pane grows, and vice-versa — so "drag up → top pane
// smaller, bottom pane bigger" (portrait) / "drag left → left pane smaller" (landscape).
//
// The split is stored as the honey pane's FRACTION of the two neighbours' combined size (so it
// survives a window resize), persisted per orientation. honeySide only decides which physical edge
// the honey pane sits on, hence the drag-direction sign.
const MIN_PANE = 80;   // never let an outer pane collapse to nothing

export const splitKey = (orientation) => `zeehive.split.${orientation}`;

export function readSplit(orientation) {
  const v = parseFloat(localStorage.getItem(splitKey(orientation)));
  return Number.isFinite(v) ? v : null;   // null → fall back to the CSS 3:2 default
}

// Wire this to the grip's onPointerDown. `setSplit` receives the honey fraction (0..1) live.
export function beginPaneReposition(e, { layoutRef, orientation, honeySide, setSplit }) {
  e.preventDefault();
  e.stopPropagation();
  const root = layoutRef.current;
  if (!root) return;
  const honeyEl = root.querySelector('.hive-pane.honey');
  const panelsEl = root.querySelector('.hive-pane.panels');
  if (!honeyEl || !panelsEl) return;

  const portrait = orientation === 'portrait';
  const dim = portrait ? 'height' : 'width';
  const axis = (ev) => (portrait ? ev.clientY : ev.clientX);
  const startHoney = honeyEl.getBoundingClientRect()[dim];
  const free = startHoney + panelsEl.getBoundingClientRect()[dim];   // constant: the middle stays fixed
  const dir = honeySide === 'a' ? 1 : -1;    // honey-a → honey on the low edge, so +delta grows it
  const start = axis(e);

  const onMove = (ev) => {
    const nextHoney = Math.max(MIN_PANE, Math.min(free - MIN_PANE, startHoney + (axis(ev) - start) * dir));
    const frac = nextHoney / free;
    setSplit(frac);
    try { localStorage.setItem(splitKey(orientation), String(frac)); } catch { /* private mode */ }
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
}
