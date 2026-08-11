import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getBoard, getWorkStatuses, patchWorkItem, vocabOf } from './workApi.js';
import { placement } from './order.js';
import { Breadcrumb, Due, ErrLine, KindGlyph, Pips, StatusDot, ZeeChip, statusLabel } from './bits.jsx';

// WORK TRACKER — the KANBAN board, as a swimlane MATRIX.
//
// WHAT IT IS FOR: one screen where a human moves work, rather than reading about it. Everything a
// manager does to a plan in a day is a drag — "this is started", "this is blocked", "do this one
// first" — so the board's whole job is to make those three gestures cost one motion each and to be
// honest when the server says no.
//
// THE MATRIX SHAPE: COLUMNS ARE STATUSES, ROWS ARE PARENTS. The columns are still the fetched
// /api/work-statuses vocabulary (decision 1 below). But a work_node WITH children — any card in the
// payload whose id is some other card's parent_id, plus board.root — renders as a collapsible ROW
// spanning every lane, instead of a card in one column. A node with NO children renders as a CARD
// in its status lane, under its nearest parent row. Nested containers nest as indented rows: every
// band is one flex row (label rail + one cell per lane) and every band shares the SAME label width,
// so a lane is the same horizontal strip at every nesting depth — the columns stay straight.
//
// COLLAPSE: the project root is AUTO-EXPANDED; every other row defaults collapsed, and a collapsed
// row shows per-lane counts of the work hidden under it (a Jira-epic swimlane). The caret toggles;
// the row title opens the drawer. Toggles are remembered in localStorage keyed by item id.
//
// MOVES ARE SCOPED TO A ROW. A card can be dragged (or Alt+arrowed) between the lanes of ITS OWN
// row only — a move is still exactly status/sort_order, never parent_id. Re-parenting stays in the
// drawer; this board deliberately adds NO cross-row drops. The optimistic move + server-sentence
// rollback (decision 2), the drift flag and the keyboard path (below) are unchanged in spirit.
//
// THREE DECISIONS WORTH KNOWING BEFORE YOU EDIT THIS FILE:
//
// 1. THE COLUMNS ARE `/api/work-statuses`, NOT AN ARRAY IN HERE. The status vocabulary
//    (queued…cancelled) is owned by the server — the DB constrains it, the API validates against
//    it, and a zee's live hive status maps onto it. A hardcoded copy in the browser is a copy that
//    silently drifts the day someone adds a status, and the board would then simply not show that
//    work. So the vocabulary is FETCHED, sorted by its own `order`, and the columns ARE that list.
//    `/api/board` supplies the cards; if it omits a column that the vocabulary has, the column
//    still renders (empty) — because "nothing is in review" and "there is no review" are different
//    facts and a board that conflates them lies.
//
// 2. MOVES ARE OPTIMISTIC AND ROLL BACK WITH THE SERVER'S SENTENCE. Drag is a direct-manipulation
//    gesture: waiting on a round trip before the card lands makes the whole board feel broken. So
//    the card moves at once and the PATCH follows. When the server refuses (a dependency not met, a
//    terminal status, a status a zee's live work contradicts) the card snaps BACK and the refusal
//    sentence is printed verbatim — never "failed". The sentence is the only thing that tells a
//    human what to do next.
//
// 3. ORDER IS A MIDPOINT, WHICH IS WHY `sort_order` IS A DOUBLE. Dropping between two cards writes
//    the average of its new neighbours' sort_orders, so re-ordering touches ONE row instead of
//    renumbering a column (a renumber is N writes, races every other client, and turns a drag into
//    a migration). At the ends we step by 1. Doubles run out of precision after ~50 splits in the
//    same gap; the server is free to renormalise a column when it wants to, and nothing here
//    depends on the numbers being pretty.
//
// AND IT IS NOT MOUSE-ONLY: Alt+arrows perform the same move as a drag (see onCardKey). HTML5 drag
// has no keyboard equivalent, so without that the board was readable and not operable for anyone who
// does not use a mouse — the gesture is the feature here, so it needed a second way in. In the
// matrix, Alt+←/→ carries a card to the next STATUS LANE of its own row, and Alt+↑/↓ reorders it
// within that lane.
//
// The board is the PLAN. The hive is the FACT. When `live_status` (what the assigned zee is really
// doing) disagrees with the stored `status`, the card carries an advisory marker and NOTHING moves
// on its own — a human decides whether the plan or the zee is wrong. An auto-moving card would
// rewrite a manager's plan from a poller, which is precisely the authority a board must not have.

const COLLAPSE_KEY = 'zeehive.work.board.collapsed.';

export default function Board({ projectId, rootId, statuses: statusesProp, onOpen, reloadKey = 0 }) {
  const [statuses, setStatuses] = useState(statusesProp || null);
  const [board, setBoard] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);
  // { id, from, rowId } — the card in flight. A ref as well as state: the drop handler runs from a
  // DOM event and must not read a stale closure. rowId = the card's nearest parent row, which is
  // what scopes every drop target (a card may only move within its own row's lanes).
  const dragRef = useRef(null);
  const [dragId, setDragId] = useState(null);
  const [dropAt, setDropAt] = useState(null);   // { cardId } | { rowId, key, index } — the drop target highlighted
  const [collapsed, setCollapsed] = useState(() => new Set());

  // The vocabulary. Fetched once (or handed down by WorkConsole, which needs it for the drawer too).
  useEffect(() => {
    if (statusesProp) { setStatuses(statusesProp); return; }
    let live = true;
    getWorkStatuses()
      .then((v) => { if (live) setStatuses(vocabOf(v).statuses); })
      .catch((e) => { if (live) setErr(e); });
    return () => { live = false; };
  }, [statusesProp]);

  // The collapse set is seeded straight from the payload (not from a post-render effect) so the
  // FIRST paint already has the rows collapsed — a flash of everything-expanded would lie about
  // the plan. Root defaults expanded, everything else collapsed, both overridable by localStorage.
  const seedCollapse = useCallback((payload) => {
    setCollapsed((s) => {
      const n = new Set(s);
      let changed = false;
      const byId = new Map();
      if (payload?.root) byId.set(payload.root.id, payload.root);
      const cards = [];
      for (const c of payload?.columns || []) for (const it of c.items || []) cards.push(it);
      for (const it of cards) if (!byId.has(it.id)) byId.set(it.id, it);
      const rows = new Set();
      if (payload?.root) rows.add(payload.root.id);
      for (const it of cards) {
        const parent = it.parent_id ? byId.get(it.parent_id) : null;
        if (parent) rows.add(parent.id);
      }
      for (const id of rows) {
        if (s.has(id)) continue;                       // already decided (by a toggle or an earlier seed)
        const isRoot = payload?.root?.id === id;
        let stored = null;
        try { stored = localStorage.getItem(COLLAPSE_KEY + id); } catch { /* private mode */ }
        if (stored === null ? !isRoot : stored === '1') { n.add(id); changed = true; }
      }
      return changed ? n : s;
    });
  }, []);

  const load = useCallback(async () => {
    try {
      const b = await getBoard(projectId, rootId);
      setBoard(b);
      seedCollapse(b);
      setErr(null);
    } catch (e) { setErr(e); }
    finally { setLoading(false); }
  }, [projectId, rootId, seedCollapse]);

  // A live refetch must never yank the board out from under a drag in progress: the SSE stream can
  // fire mid-gesture (another zee moved something), and re-rendering the lanes then would drop
  // the card the human is holding. So a reload arriving during a drag is DEFERRED to the drop.
  const pendingReload = useRef(false);
  useEffect(() => {
    if (dragRef.current) { pendingReload.current = true; return; }
    setLoading(true); load();
  }, [load, reloadKey]);

  // Columns = the vocabulary, in its own order, filled from the board payload.
  const columns = useMemo(() => {
    const vocab = [...(statuses || [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const byKey = new Map((board?.columns || []).map((c) => [c.key, c]));
    const cols = vocab.map((s) => {
      const c = byKey.get(s.key) || {};
      byKey.delete(s.key);
      return { key: s.key, label: c.label || s.label || s.key, terminal: !!s.terminal, items: c.items || [] };
    });
    // A column the server sent that the vocabulary does not know about is still rendered, last, and
    // flagged — silently dropping the cards in it would hide real work.
    for (const c of byKey.values()) cols.push({ key: c.key, label: c.label || c.key, items: c.items || [], unknown: true });
    return cols;
  }, [statuses, board]);

  // The tree: every card under its parent, plus the root. A node WITH children is a row; a node
  // with NO children is a card in its lane. Pure, so the render test can build and assert on it.
  const forest = useMemo(() => buildForest(board?.root || null, columns), [board, columns]);

  // rowOf: cardId → its nearest parent row. laneStacks: rowId → Map(laneKey → that row's direct
  // leaf cards in that lane). Both are what scopes a move to a row's own lanes.
  const index = useMemo(() => buildIndex(forest), [forest]);

  // The flat band list, in tree order. A row band is followed by its children (when expanded) and
  // then a TAIL band — the per-lane drop targets that append to the row's lanes.
  const bands = useMemo(() => flattenBands(forest, collapsed), [forest, collapsed]);

  const toggle = useCallback((id) => {
    setCollapsed((s) => {
      const n = new Set(s);
      if (n.has(id)) { n.delete(id); try { localStorage.setItem(COLLAPSE_KEY + id, '0'); } catch { /* private */ } }
      else { n.add(id); try { localStorage.setItem(COLLAPSE_KEY + id, '1'); } catch { /* private */ } }
      return n;
    });
  }, []);

  // ── the move ───────────────────────────────────────────────────────────────
  // `index` is the slot in the target LANE (the row's stack for `toKey`) the card is dropped into
  // (0 = before the first card). Scoped by rowOf: the stack is always the dragged card's OWN row.
  const move = useCallback(async (itemId, toKey, index) => {
    if (!board) return;
    const prev = board;
    const fromCol = columns.find((c) => (c.items || []).some((i) => i.id === itemId));
    const card = fromCol?.items.find((i) => i.id === itemId);
    if (!card) return;
    const target = columns.find((c) => c.key === toKey);
    if (!target) return;

    // The lane stack the card lands in — the row's direct-leaf children in the target lane. A card
    // whose parent is not in the payload (an orphan) has no row and can still change status; its
    // stack is just the card itself.
    const rowId = index.rowOf.get(itemId);
    const stack = rowId ? (index.laneStacks.get(rowId)?.get(toKey) || []) : [];
    const { sortOrder } = placement(stack, itemId, index);

    const patch = {};
    if (fromCol.key !== toKey) patch.status = toKey;
    if (sortOrder !== null && sortOrder !== card.sort_order) patch.sort_order = sortOrder;
    if (!Object.keys(patch).length) return;

    // Optimistic: rebuild the payload with the card's new status/sort_order. The forest re-sorts
    // children by sort_order, so the card renders in its new lane/position without waiting.
    const moved = { ...card, ...patch };
    setBoard({
      ...board,
      columns: columns.map((c) => {
        if (c.key === toKey) return { ...c, items: [...c.items.filter((i) => i.id !== itemId), moved] };
        if (c.key === fromCol.key) return { ...c, items: c.items.filter((i) => i.id !== itemId) };
        return c;
      }),
    });
    setErr(null);
    try {
      await patchWorkItem(itemId, patch);
      load();                       // re-read: the server may recompute progress/dates on a status change
    } catch (e) {
      setBoard(prev);               // roll the card back to where the human took it from …
      setErr(e);                    // … and say, in the server's own words, why it would not go
    }
  }, [board, columns, index, load]);

  const onDragStart = (e, card, fromKey) => {
    dragRef.current = { id: card.id, from: fromKey, rowId: index.rowOf.get(card.id) };
    setDragId(card.id);
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', card.id); } catch { /* some browsers refuse on dragstart */ }
  };
  const endDrag = () => {
    dragRef.current = null; setDragId(null); setDropAt(null);
    if (pendingReload.current) { pendingReload.current = false; load(); }
  };

  // Every drop target is scoped to ONE row: a card from another row is not even offered a drop
  // (allow* does not preventDefault, so the browser refuses it). This is the whole "no cross-row
  // re-parenting" rule — there is nothing to enforce in the move, because the drop never fires.
  const allowLane = (e, rowId, key, index) => {
    if (!dragRef.current || dragRef.current.rowId !== rowId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dropAt?.rowId !== rowId || dropAt?.key !== key) setDropAt({ rowId, key, index });
  };
  const allowCard = (e, rowId, cardId, laneIndex) => {
    if (!dragRef.current || dragRef.current.rowId !== rowId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const index = halfOf(e, laneIndex);
    if (dropAt?.cardId !== cardId || dropAt?.index !== index) setDropAt({ cardId, index });
  };
  const onDrop = (e, rowId, key, index) => {
    const id = dragRef.current?.id || e.dataTransfer.getData('text/plain');
    if (!id) return;
    if (dragRef.current && dragRef.current.rowId !== rowId) { endDrag(); return; }
    e.preventDefault();
    e.stopPropagation();
    endDrag();
    move(id, key, index);
  };
  // ── THE SAME MOVE, FROM THE KEYBOARD ───────────────────────────────────────
  // HTML5 drag and drop has no keyboard equivalent at all: with a mouse this board is one gesture,
  // and without one it was READ-ONLY — a card could be focused and opened, never moved. That is not
  // a nicety, it is half the feature missing for anyone who does not drag.
  //
  // So Alt+arrows perform the identical action: Alt+↑/↓ reorders inside the card's own lane,
  // Alt+←/→ carries the card to the next STATUS LANE of its own row (a status change, exactly as
  // dropping it there would be). It funnels into the SAME move() — one implementation, one set of
  // refusals, one optimistic rollback. Alt is required so the arrows keep scrolling for everyone
  // else.
  //
  // Focus is restored onto the card after the board re-reads: a move that silently dumps you back
  // at the top of the document makes the second move harder than the first, which is how a keyboard
  // path ends up unused.
  const refocus = useRef(null);
  useEffect(() => {
    if (!refocus.current) return;
    const el = document.querySelector(`[data-item="${refocus.current}"]`);
    refocus.current = null;
    el?.focus();
  }, [board]);

  const onCardKey = (e, card, colIndex, laneIndex, laneCount) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen?.(card.id); return; }
    if (!e.altKey) return;
    const here = columns[colIndex];
    const to = e.key === 'ArrowLeft' ? columns[colIndex - 1]
      : e.key === 'ArrowRight' ? columns[colIndex + 1] : null;
    if (to) {
      e.preventDefault();
      refocus.current = card.id;
      const rowId = index.rowOf.get(card.id);
      const stack = rowId ? (index.laneStacks.get(rowId)?.get(to.key) || []) : [];
      move(card.id, to.key, stack.length);             // lands at the end of the lane it moves into
      return;
    }
    if (e.key === 'ArrowUp' && laneIndex > 0) {
      e.preventDefault(); refocus.current = card.id;
      move(card.id, here.key, laneIndex - 1);
    } else if (e.key === 'ArrowDown' && laneIndex < laneCount - 1) {
      e.preventDefault(); refocus.current = card.id;
      move(card.id, here.key, laneIndex + 2);           // the gap BELOW the card that is below this one
    }
  };

  if (loading && !board) return <div className="work-empty">loading the board…</div>;

  return (
    <div className="work-board" data-testid="work-board">
      <ErrLine err={err} onDismiss={() => setErr(null)} />
      <div className="work-matrix">
        <div className="work-mhead">
          <div className="work-mh-label">work item</div>
          {columns.map((col) => (
            <section key={col.key}
                     className={`work-col-h${col.terminal ? ' terminal' : ''}${col.unknown ? ' unknown' : ''}`}
                     data-col={col.key}>
              <span className="work-col-name">{col.label}</span>
              <span className="work-col-n">{col.items.length}</span>
            </section>
          ))}
        </div>
        <div className="work-mbody">
          {bands.map((band) => {
            if (band.kind === 'row') {
              return (
                <RowBand key={band.node.id} node={band.node} depth={band.depth} collapsed={band.collapsed}
                         columns={columns} statuses={statuses}
                         onToggle={toggle} onOpen={onOpen} />
              );
            }
            if (band.kind === 'tail') {
              return (
                <RowTail key={`tail-${band.node.id}`} node={band.node} depth={band.depth}
                         columns={columns} index={index} dropAt={dropAt}
                         onDragOver={allowLane} onDrop={onDrop} />
              );
            }
            const card = band.card;
            const rowId = index.rowOf.get(card.id);
            const stack = rowId ? (index.laneStacks.get(rowId)?.get(card.status) || []) : [];
            const laneIndex = stack.findIndex((c) => c.id === card.id);
            const colIndex = columns.findIndex((c) => c.key === card.status);
            return (
              <LeafBand key={card.id} card={card} depth={band.depth} columns={columns}
                        statuses={statuses} dragging={dragId === card.id}
                        dropOn={dropAt?.cardId === card.id}
                        onOpen={() => onOpen?.(card.id)}
                        onKey={(e) => onCardKey(e, card, colIndex, laneIndex, stack.length)}
                        onDragStart={(e) => onDragStart(e, card, card.status)}
                        onDragEnd={endDrag}
                        onDragOver={(e) => allowCard(e, rowId, card.id, laneIndex)}
                        onDrop={(e) => onDrop(e, rowId, card.status, halfOf(e, laneIndex))} />
            );
          })}
          {!bands.length && <div className="work-col-empty">—</div>}
        </div>
      </div>
    </div>
  );
}

// ── the forest: payload → tree ──────────────────────────────────────────────────
// A node WITH children is a ROW; a node with no children is a CARD. Cards whose parent is not in
// the payload (an orphan) are attached to the root so nothing is ever hidden — a defensive read of
// a payload the server should never send, which must not turn into a blank board if it does.
export function buildForest(root, columns) {
  const byId = new Map();
  if (root) byId.set(root.id, { ...root, children: [] });
  const cards = [];
  for (const col of columns || []) for (const item of col.items || []) cards.push(item);
  for (const c of cards) if (!byId.has(c.id)) byId.set(c.id, { ...c, children: [] });
  const orphans = [];
  for (const node of byId.values()) {
    if (root && node.id === root.id) continue;
    const parent = node.parent_id ? byId.get(node.parent_id) : null;
    if (parent) parent.children.push(node); else orphans.push(node);
  }
  if (root) {
    const rootNode = byId.get(root.id);
    rootNode.children.push(...orphans);
    sortTree(rootNode.children);
    rootNode.isRoot = true;                // the root is a ROW even with no children (it was never a card)
    return [rootNode];
  }
  sortTree(orphans);
  return orphans;
}

function sortTree(nodes) {
  nodes.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)
    || String(a.title || '').localeCompare(String(b.title || '')));
  for (const n of nodes) if (n.children) sortTree(n.children);
}

// The flat band list the board draws, in tree order. A node WITH children is a ROW band; a node
// with no children is a LEAF band. An expanded row's children follow it, then a TAIL band — the
// per-lane append drop targets. A collapsed row hides its children AND its tail. Pure, so the
// render test can assert exactly what collapse/expand shows.
export function flattenBands(forest, collapsed) {
  const out = [];
  const walk = (nodes, depth) => {
    for (const node of nodes) {
      const isRow = node.isRoot || (node.children || []).length > 0;
      if (!isRow) { out.push({ kind: 'leaf', card: node, depth }); continue; }
      const isCollapsed = collapsed.has(node.id);
      out.push({ kind: 'row', node, depth, collapsed: isCollapsed });
      if (isCollapsed) continue;
      walk(node.children, depth + 1);
      out.push({ kind: 'tail', node, depth: depth + 1 });
    }
  };
  walk(forest || [], 0);
  return out;
}

// rowOf / laneStacks — what scopes a move to a row's own lanes. A leaf's row is its NEAREST parent
// row (the container directly above it); nested rows own their own stacks, so a card can never
// wander into its grandparent's lanes.
export function buildIndex(forest) {
  const rowOf = new Map();
  const laneStacks = new Map();
  const walk = (nodes, rowId) => {
    for (const node of nodes) {
      if (node.isRoot || (node.children || []).length) {
        rowOf.set(node.id, node.id);
        laneStacks.set(node.id, new Map());
        walk(node.children, node.id);
      } else {
        rowOf.set(node.id, rowId);
        if (rowId) {
          const m = laneStacks.get(rowId);
          if (!m.has(node.status)) m.set(node.status, []);
          m.get(node.status).push(node);
        }
      }
    }
  };
  walk(forest || [], null);
  return { rowOf, laneStacks };
}

// The counts a COLLAPSED row shows: every leaf under the row, by lane. Jira-epic style — the number
// is the work hidden behind the caret, not just the direct children.
export function leafLaneCounts(node, out = new Map()) {
  if (!(node.children || []).length) {
    out.set(node.status, (out.get(node.status) || 0) + 1);
  } else {
    for (const c of node.children) leafLaneCounts(c, out);
  }
  return out;
}

// ── the bands ──────────────────────────────────────────────────────────────────
export function RowBand({ node, depth, collapsed, columns, statuses, onToggle, onOpen }) {
  const kids = node.children || [];
  const counts = leafLaneCounts(node);
  return (
    <div className={`work-row work-row-band${collapsed ? ' collapsed' : ''}`}
         data-testid="work-row" data-row={node.id}>
      <div className="work-row-label" style={{ paddingLeft: 6 + depth * 13 }}>
        <button className={`work-chev${kids.length ? '' : ' none'}`} tabIndex={-1}
                title={kids.length ? 'collapse / expand this row' : ''}
                onClick={(e) => { e.stopPropagation(); onToggle(node.id); }}>
          {kids.length ? (collapsed ? '▸' : '▾') : '·'}
        </button>
        <KindGlyph kind={node.kind} />
        <StatusDot status={node.status} statuses={statuses} />
        <button className="work-row-title" title={`${node.title} — click to open`}
                onClick={() => onOpen?.(node.id)}>{node.title}</button>
      </div>
      {columns.map((col) => {
        const n = counts.get(col.key) || 0;
        return (
          <div key={col.key} className="work-row-lane" title={n ? `${n} ${col.label}` : undefined}>
            {collapsed && n ? (
              <span className="work-row-count"><b>{n}</b>{col.label}</span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

// The tail of an EXPANDED row: one drop target per lane, appending to that lane's stack. This is
// how a card reaches an empty lane (there is no card to drop on) and how it joins the END of a lane.
export function RowTail({ node, depth, columns, index, dropAt, onDragOver, onDrop }) {
  const rowId = node.id;
  return (
    <div className="work-row work-tail" data-row={rowId}>
      <div className="work-row-label" style={{ paddingLeft: 6 + depth * 13 }} />
      {columns.map((col) => {
        const stack = index.laneStacks.get(rowId)?.get(col.key) || [];
        const on = dropAt?.rowId === rowId && dropAt?.key === col.key;
        return (
          <div key={col.key} className={`work-row-lane${on ? ' drop' : ''}`}
               onDragOver={(e) => onDragOver(e, rowId, col.key, stack.length)}
               onDrop={(e) => onDrop(e, rowId, col.key, stack.length)}>
            {!stack.length && <span className="work-row-empty">—</span>}
          </div>
        );
      })}
    </div>
  );
}

export function LeafBand({ card, depth, columns, statuses, dragging, dropOn, onOpen, onKey,
                    onDragStart, onDragEnd, onDragOver, onDrop }) {
  return (
    <div className="work-row work-leaf" data-testid="work-row-leaf">
      <div className="work-row-label" style={{ paddingLeft: 6 + depth * 13 }} />
      {columns.map((col) => (
        <div key={col.key} className={`work-row-lane${col.key === card.status ? ' has-card' : ''}`}>
          {col.key === card.status && (
            <Card card={card} statuses={statuses} dragging={dragging} dropOn={dropOn}
                  onDragStart={onDragStart} onDragEnd={onDragEnd}
                  onDragOver={onDragOver} onDrop={onDrop}
                  onKey={onKey} onOpen={onOpen} />
          )}
        </div>
      ))}
    </div>
  );
}

// WHICH SIDE of a card the pointer is on — above its middle means "insert before me", below means
// "after me". Without this the only drop targets were the 6px gaps BETWEEN cards, and a drop on a
// card itself bubbled to the column and silently sent it to the bottom: the commonest aim in the
// whole board ("put this one just here") was the one that missed.
const halfOf = (e, index) => {
  const r = e.currentTarget.getBoundingClientRect();
  return e.clientY < r.top + r.height / 2 ? index : index + 1;
};

// `onKey` is the keyboard half of the same move the drag makes (Board.onCardKey, bound per card to
// its row's lane). It is a PROP, not a free identifier: the first cut of the keyboard path wrote
// `onKeyDown={onKey}` here without ever declaring or passing it, so the very first card React
// rendered threw `ReferenceError: onKey is not defined` and took the whole board down with it —
// vite builds a free identifier happily, and the browser is where it becomes a blank screen.
//
// EXPORTED for that reason. The board itself cannot be rendered outside a browser (its data arrives
// in an effect), but a card is a pure function of its props — so exporting it lets
// test/work-board-render.test.mjs actually RENDER one with react-dom/server and catch a throw the
// way a human's browser would, instead of only reading the source. Nothing imports it but the test.
export function Card({ card, statuses, dragging, dropOn, onDragStart, onDragEnd, onDragOver, onDrop, onKey, onOpen }) {
  // The board is the plan; the hive is the fact. Advisory only — see the header.
  const drift = card.live_status && card.live_status !== card.status ? card.live_status : null;
  return (
    <article className={`work-card${dragging ? ' dragging' : ''}${dropOn ? ' drop-on' : ''}`} draggable
             data-testid="work-card" data-item={card.id}
             onDragStart={onDragStart} onDragEnd={onDragEnd}
             onDragOver={onDragOver} onDrop={onDrop}
             onClick={onOpen}
             onKeyDown={onKey}
             tabIndex={0} role="button"
             aria-label={`${card.title} — ${statusLabel(statuses, card.status)}. Enter opens it; `
               + 'Alt with the arrow keys moves it between columns and reorders it.'}>
      <div className="work-card-top">
        <KindGlyph kind={card.kind} />
        <span className="work-card-title">{card.title}</span>
        {card.ticket?.number != null && (
          <span className="work-card-tkt" title={card.ticket.title || ''}>#{card.ticket.number}</span>
        )}
      </div>
      <Breadcrumb parts={card.breadcrumb} />
      <div className="work-card-foot">
        <Pips priority={card.priority} />
        <Due date={card.due_on} />
        <ZeeChip zee={card.zee} />
      </div>
      {drift && (
        <div className="work-drift" title={'The board is the plan; the hive is the fact. This item is parked in '
          + `“${statusLabel(statuses, card.status)}” but its zee is live at “${statusLabel(statuses, drift)}”. `
          + 'Nothing moved on its own — you decide which one is wrong.'}>
          ⚑ zee is {statusLabel(statuses, drift)}
        </div>
      )}
    </article>
  );
}
