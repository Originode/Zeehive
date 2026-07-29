import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getBoard, getWorkStatuses, patchWorkItem, vocabOf } from './workApi.js';
import { placement } from './order.js';
import { Breadcrumb, Due, ErrLine, KindGlyph, Pips, ZeeChip, statusLabel } from './bits.jsx';

// WORK TRACKER — the KANBAN board.
//
// WHAT IT IS FOR: one screen where a human moves work, rather than reading about it. Everything a
// manager does to a plan in a day is a drag — "this is started", "this is blocked", "do this one
// first" — so the board's whole job is to make those three gestures cost one motion each and to be
// honest when the server says no.
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
// The board is the PLAN. The hive is the FACT. When `live_status` (what the assigned zee is really
// doing) disagrees with the stored `status`, the card carries an advisory marker and NOTHING moves
// on its own — a human decides whether the plan or the zee is wrong. An auto-moving card would
// rewrite a manager's plan from a poller, which is precisely the authority a board must not have.

export default function Board({ projectId, rootId, statuses: statusesProp, onOpen, reloadKey = 0 }) {
  const [statuses, setStatuses] = useState(statusesProp || null);
  const [board, setBoard] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);
  // { id, from } — the card in flight. A ref as well as state: the drop handler runs from a DOM
  // event and must not read a stale closure.
  const dragRef = useRef(null);
  const [dragId, setDragId] = useState(null);
  const [dropAt, setDropAt] = useState(null);   // { key, index } — where the gap marker is drawn

  // The vocabulary. Fetched once (or handed down by WorkConsole, which needs it for the drawer too).
  useEffect(() => {
    if (statusesProp) { setStatuses(statusesProp); return; }
    let live = true;
    getWorkStatuses()
      .then((v) => { if (live) setStatuses(vocabOf(v).statuses); })
      .catch((e) => { if (live) setErr(e); });
    return () => { live = false; };
  }, [statusesProp]);

  const load = useCallback(async () => {
    try {
      const b = await getBoard(projectId, rootId);
      setBoard(b);
      setErr(null);
    } catch (e) { setErr(e); }
    finally { setLoading(false); }
  }, [projectId, rootId]);

  // A live refetch must never yank the board out from under a drag in progress: the SSE stream can
  // fire mid-gesture (another zee moved something), and re-rendering the columns then would drop
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

  // ── the move ───────────────────────────────────────────────────────────────
  // `index` is the slot in the target column the card is dropped INTO (0 = before the first card).
  const move = useCallback(async (itemId, toKey, index) => {
    if (!board) return;
    const prev = board;
    const cols = columns;
    const fromCol = cols.find((c) => (c.items || []).some((i) => i.id === itemId));
    const card = fromCol?.items.find((i) => i.id === itemId);
    if (!card) return;
    const target = cols.find((c) => c.key === toKey);
    if (!target) return;

    // WHERE it lands, and what sort_order that means — pure maths, in order.js, so the awkward
    // cases (first slot, last slot, a card moved DOWN its own column) can be tested without a
    // browser. See that file's header for the midpoint rule and the off-by-one it corrects.
    const { at, sortOrder } = placement(target.items, itemId, index);

    const patch = {};
    if (fromCol.key !== toKey) patch.status = toKey;
    if (sortOrder !== null && sortOrder !== card.sort_order) patch.sort_order = sortOrder;
    if (!Object.keys(patch).length) return;

    // Optimistic: rebuild the payload with the card already where it was dropped.
    const moved = { ...card, ...patch };
    setBoard({
      ...board,
      columns: cols.map((c) => {
        if (c.key === toKey) {
          const list = c.items.filter((i) => i.id !== itemId);
          list.splice(at, 0, moved);
          return { ...c, items: list };
        }
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
  }, [board, columns, load]);

  const onDragStart = (e, card, fromKey) => {
    dragRef.current = { id: card.id, from: fromKey };
    setDragId(card.id);
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', card.id); } catch { /* some browsers refuse on dragstart */ }
  };
  const endDrag = () => {
    dragRef.current = null; setDragId(null); setDropAt(null);
    if (pendingReload.current) { pendingReload.current = false; load(); }
  };

  const onDrop = (e, key, index) => {
    e.preventDefault();
    e.stopPropagation();
    const id = dragRef.current?.id || e.dataTransfer.getData('text/plain');
    endDrag();
    if (id) move(id, key, index);
  };
  const allow = (e, key, index) => {
    if (!dragRef.current) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (index !== undefined && (dropAt?.key !== key || dropAt?.index !== index)) setDropAt({ key, index });
  };

  if (loading && !board) return <div className="work-empty">loading the board…</div>;

  return (
    <div className="work-board" data-testid="work-board">
      <ErrLine err={err} onDismiss={() => setErr(null)} />
      <div className="work-cols">
        {columns.map((col) => (
          <section key={col.key} className={`work-col${col.terminal ? ' terminal' : ''}${col.unknown ? ' unknown' : ''}`}
                   data-col={col.key}
                   onDragOver={(e) => allow(e, col.key, col.items.length)}
                   onDrop={(e) => onDrop(e, col.key, col.items.length)}>
            <header className="work-col-h">
              <span className="work-col-name">{col.label}</span>
              <span className="work-col-n">{col.items.length}</span>
            </header>
            {col.unknown && <div className="work-col-note">not in the status vocabulary</div>}
            <div className="work-col-body">
              {col.items.map((card, i) => (
                <React.Fragment key={card.id}>
                  <Gap on={dropAt?.key === col.key && dropAt?.index === i}
                       onDragOver={(e) => allow(e, col.key, i)} onDrop={(e) => onDrop(e, col.key, i)} />
                  <Card card={card} statuses={statuses} dragging={dragId === card.id}
                        onDragStart={(e) => onDragStart(e, card, col.key)} onDragEnd={endDrag}
                        onDragOver={(e) => allow(e, col.key, halfOf(e, i))}
                        onDrop={(e) => onDrop(e, col.key, halfOf(e, i))}
                        onOpen={() => onOpen?.(card.id)} />
                </React.Fragment>
              ))}
              <Gap on={dropAt?.key === col.key && dropAt?.index === col.items.length} last
                   onDragOver={(e) => allow(e, col.key, col.items.length)}
                   onDrop={(e) => onDrop(e, col.key, col.items.length)} />
              {!col.items.length && <div className="work-col-empty">—</div>}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

// The drop target BETWEEN two cards. It is its own element (not a computed midpoint of a mousemove)
// so the marker a human sees and the index the drop writes are the same thing by construction.
function Gap({ on, last, onDragOver, onDrop }) {
  return (
    <div className={`work-gap${on ? ' on' : ''}${last ? ' last' : ''}`}
         onDragOver={onDragOver} onDrop={onDrop} />
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

function Card({ card, statuses, dragging, onDragStart, onDragEnd, onDragOver, onDrop, onOpen }) {
  // The board is the plan; the hive is the fact. Advisory only — see the header.
  const drift = card.live_status && card.live_status !== card.status ? card.live_status : null;
  return (
    <article className={`work-card${dragging ? ' dragging' : ''}`} draggable
             data-testid="work-card" data-item={card.id}
             onDragStart={onDragStart} onDragEnd={onDragEnd}
             onDragOver={onDragOver} onDrop={onDrop}
             onClick={onOpen}
             onKeyDown={(e) => { if (e.key === 'Enter') onOpen?.(); }}
             tabIndex={0} role="button">
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
