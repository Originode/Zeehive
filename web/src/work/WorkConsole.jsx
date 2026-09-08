import React, { useCallback, useEffect, useRef, useState } from 'react';
import { subscribe } from '../api.js';
import { showPrompt } from '../Dialog.jsx';
import { createWorkItem, getWorkStatuses, listWorkItems, patchWorkItem, vocabOf } from './workApi.js';
import { ErrLine, KindGlyph, StatusDot } from './bits.jsx';
import Board from './Board.jsx';
import Tickets from './Tickets.jsx';
import Reflections from './Reflections.jsx';
import Gantt from './Gantt.jsx';
import WorkItemDrawer from './WorkItemDrawer.jsx';

// WORK TRACKER — THE CONSOLE. The one surface a human uses to run work: intake (tickets and the
// REFLECTIONS ledger — what the fleet's own zees reported after their work shipped), the plan
// (board), and time (timeline), over a single hierarchy of work items.
//
// WHY IT IS NO LONGER AN OVERLAY: it used to open as a full-screen portalled modal over the
// honeycomb, which made the plan a place you LEAVE the fleet view to visit — and the two are the
// same subject seen two ways (the honeycomb is the plan with a zee on it). So the tracker is now a
// VIEW OF THE HONEYCOMB PANE: App.jsx draws a view selector on that pane (honeycomb · tickets ·
// reflections · board · timeline) and renders this component in the pane's place when a work view
// is picked. Nothing is portalled and nothing floats: `.work-embed` fills the pane the canvas
// would have filled.
//
// WHICH VIEW IS SHOWING IS THEREFORE THE PANE'S STATE, NOT THIS COMPONENT'S: `tab` comes in as a
// prop and `onTabChange` reports a change back (the Reflections screen's "go to tickets" link).
// Two copies of "which view" — one here, one on the selector — is how a selector and a screen end
// up disagreeing about what is on screen.
//
// WHY THE TREE RAIL IS PERMANENT, LEFT OF THE TABS: the hierarchy is the spine of this model — there
// is exactly ONE `kind='project'` item per ZEEHIVE project and every activity and task is its
// descendant. Which SUBTREE you are looking at is therefore a property of the whole console, not of
// one tab: select an activity in the rail and the board and the timeline both scope to it (`root=`),
// which is how a manager looks at one slice of a plan without filtering three times. Selection lives
// here, above the tabs, for exactly that reason.
//
// REPARENTING IS A DRAG IN THE RAIL, AND THE SERVER OWNS THE RULES. Dropping a node on another node
// PATCHes `parent_id`. The browser does NOT pre-judge which moves are legal (a task cannot parent an
// activity, a node cannot become its own descendant, …): duplicating those rules here would create a
// second, drifting authority. It attempts the move and prints the server's refusal SENTENCE.
//
// LIVE UPDATES: zees change this data too — part 3 assigns work items to xells, and the queenzee's
// tick MOVES CARDS on its own by projecting a zee's live hive status onto them. So the console
// subscribes to the console's existing SSE stream and reacts at two speeds: a `work` event is about
// what is on screen and refreshes almost at once, everything else is background and refreshes
// lazily (see the effect below). `subscribe()` in web/src/api.js carries the event-type list and now
// also hands the work payload through `onWork`.
//
// WHAT THIS CONSOLE NEVER DOES: write a status on a timer. The tick owns the live projection
// (assigned/working/blocked/review/shipping — never done/cancelled, which stay a human's call), and
// a UI that also wrote status periodically would fight it, each overwriting the other's idea of the
// plan. The console reads, and writes only what a human asked for.

// THE VIEWS this console can draw, in the order the selector offers them. Exported because the
// selector that switches between them lives on the honeycomb pane (App.jsx) — one list, read by
// both, so a view added here appears in the selector without a second edit.
export const WORK_VIEWS = [
  { id: 'tickets', label: '⛁ tickets', title: 'intake — tickets and their breakdown' },
  { id: 'reflections', label: '✎ reflections', title: 'what zees reported after their work shipped' },
  { id: 'board', label: '▦ board', title: 'the plan as a kanban board' },
  { id: 'timeline', label: '▤ timeline', title: 'the plan as a gantt timeline' },
];
export const WORK_VIEW_IDS = WORK_VIEWS.map((v) => v.id);

export default function WorkConsole({ projectId, projectName, tab, onTabChange, onClose }) {
  const [vocab, setVocab] = useState({ statuses: [], itemKinds: [], ticketKinds: [] });
  const [tree, setTree] = useState(null);
  const [selected, setSelected] = useState(null);      // the work item scoping board + timeline
  const [openItem, setOpenItem] = useState(null);      // the drawer
  const [err, setErr] = useState(null);
  const [collapsed, setCollapsed] = useState(() => new Set());
  const [rev, setRev] = useState(0);                   // bumped to make children refetch
  const dragRef = useRef(null);
  const [dropOn, setDropOn] = useState(null);

  // The status vocabulary is fetched ONCE here and handed to every child: the board, the drawer's
  // picker and the ticket filters must all be talking about the same list, and three fetches of one
  // read-only vocabulary is three chances for them to disagree mid-render.
  useEffect(() => {
    let live = true;
    getWorkStatuses().then((v) => { if (live) setVocab(vocabOf(v)); }).catch((e) => { if (live) setErr(e); });
    return () => { live = false; };
  }, []);

  const loadTree = useCallback(async () => {
    try { setTree(normalise(await listWorkItems(projectId, { tree: 1 }))); setErr(null); }
    catch (e) { setErr(e); }
  }, [projectId]);
  useEffect(() => { loadTree(); }, [loadTree]);

  const refresh = useCallback(() => { loadTree(); setRev((n) => n + 1); }, [loadTree]);

  // LIVE, at TWO speeds — because two very different things reach this console down one stream.
  //
  //   a WORK event (a card created, moved, assigned, or moved by the queenzee's own tick) is about
  //   the thing on screen, so it lands almost at once: 150ms, just enough to collapse the burst one
  //   human action produces;
  //   any OTHER fleet event (a container health flap, a landing, another project's zee) can still
  //   change what this console renders — a zee's hive status colours a card's chip and drives its
  //   live_status — but it is background news, so it refreshes lazily and never competes with a
  //   drag in progress.
  //
  // Before this, subscribe() collapsed every type into one onChange and the tracker refetched the
  // whole tree and board on ALL of it. That was my own bug: correct, and wasteful on a busy hive.
  // `lastWork` keeps the slow path from re-fetching what the fast path just fetched.
  const lastWork = useRef(0);
  useEffect(() => {
    let slow = null;
    let fast = null;
    const onWork = () => { clearTimeout(fast); fast = setTimeout(() => { lastWork.current = Date.now(); refresh(); }, 150); };
    const onChange = () => {
      clearTimeout(slow);
      slow = setTimeout(() => { if (Date.now() - lastWork.current > 3000) refresh(); }, 2500);
    };
    // onSnapshot is a no-op: subscribe() calls it unconditionally, and this console does not want
    // the fleet snapshot — only the nudge that something changed.
    const stop = subscribe(projectId, { onSnapshot: () => {}, onChange, onWork });
    return () => { clearTimeout(slow); clearTimeout(fast); stop(); };
  }, [projectId, refresh]);

  // Escape closes the drawer first, then hands the pane back to the honeycomb (onClose) — the
  // innermost thing goes first, which is what every other surface in the console does and what a
  // human expects from a stack.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      if (openItem) return;         // the drawer handles its own Escape
      // …and so does Dialog.jsx, which is a SINGLETON portalled outside this tree: the "+ activity"
      // quick-add opens a showPrompt, and one Escape used to answer the prompt AND close the whole
      // console behind it — you cancelled a title and lost the board. The dialog owns the key while
      // it is up, so this asks the DOM whether one is open rather than duplicating its queue state.
      if (document.querySelector('.dlg-overlay')) return;
      onClose?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openItem, onClose]);

  const statuses = vocab.statuses;
  const rootId = selected?.id || null;
  const scopeLabel = selected ? selected.title : 'whole project';

  const toggle = (id) => setCollapsed((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });

  const add = async (parent, kind) => {
    const title = await showPrompt(`New ${kind} under “${parent.title}”`, { okLabel: 'Create', placeholder: 'title' });
    if (!title || !title.trim()) return;
    try {
      await createWorkItem({ project: projectId, parent_id: parent.id, kind, title: title.trim() });
      setCollapsed((s) => { const n = new Set(s); n.delete(parent.id); return n; });
      refresh();
    } catch (e) { setErr(e); }
  };

  const reparent = async (nodeId, newParentId) => {
    if (!nodeId || !newParentId || nodeId === newParentId) return;
    try { await patchWorkItem(nodeId, { parent_id: newParentId }); setErr(null); refresh(); }
    catch (e) { setErr(e); }        // e.g. "a task cannot contain an activity" — shown, not swallowed
  };

  return (
    <div className="work-embed" data-testid="work-console">
      <div className="work-shell">
        <header className="work-head">
          <span className="work-h-title">▦ Work — <b>{projectName || 'project'}</b></span>
          <span className="work-scope" title="the board and the timeline are scoped to this node">
            scope: <b>{scopeLabel}</b>
            {selected && <button className="work-mini" onClick={() => setSelected(null)}>clear</button>}
          </span>
        </header>

        <ErrLine err={err} onDismiss={() => setErr(null)} />

        <div className="work-main">
          <aside className="work-rail" data-testid="work-rail">
            {tree === null && <div className="work-empty">loading the tree…</div>}
            {tree !== null && !tree.length && <div className="work-empty">no work items yet</div>}
            {(tree || []).map((n) => (
              <TreeNode key={n.id} node={n} depth={0} statuses={statuses}
                        collapsed={collapsed} onToggle={toggle}
                        selectedId={rootId} onSelect={setSelected} onOpen={setOpenItem}
                        onAdd={add}
                        dropOn={dropOn} setDropOn={setDropOn}
                        onDragStart={(id) => { dragRef.current = id; }}
                        onDragEnd={() => { dragRef.current = null; setDropOn(null); }}
                        onDropNode={(targetId) => {
                          const id = dragRef.current;
                          dragRef.current = null; setDropOn(null);
                          reparent(id, targetId);
                        }} />
            ))}
          </aside>

          <section className="work-pane">
            {tab === 'tickets' && (
              <Tickets projectId={projectId} statuses={statuses} kinds={vocab.ticketKinds}
                       reloadKey={rev} onOpenItem={setOpenItem} />
            )}
            {tab === 'reflections' && (
              <Reflections projectId={projectId} kinds={vocab.ticketKinds} reloadKey={rev}
                           onOpenTickets={() => onTabChange?.('tickets')} />
            )}
            {tab === 'board' && (
              <Board projectId={projectId} rootId={rootId} statuses={statuses} reloadKey={rev}
                     onOpen={setOpenItem} />
            )}
            {tab === 'timeline' && <Gantt projectId={projectId} rootId={rootId} />}
          </section>

          {openItem && (
            <WorkItemDrawer itemId={openItem} projectId={projectId} statuses={statuses}
                            onClose={() => setOpenItem(null)} onChanged={refresh} onOpen={setOpenItem} />
          )}
        </div>
      </div>
    </div>
  );
}

// ── the rail ────────────────────────────────────────────────────────────────
function TreeNode({ node, depth, statuses, collapsed, onToggle, selectedId, onSelect, onOpen, onAdd,
                    dropOn, setDropOn, onDragStart, onDragEnd, onDropNode }) {
  const kids = node.children || [];
  const isCollapsed = collapsed.has(node.id);
  return (
    <div className="work-node">
      <div className={`work-nrow${selectedId === node.id ? ' sel' : ''}${dropOn === node.id ? ' dropon' : ''}`}
           style={{ paddingLeft: 4 + depth * 13 }}
           draggable
           data-node={node.id}
           onDragStart={(e) => { onDragStart(node.id); e.dataTransfer.effectAllowed = 'move';
                                 try { e.dataTransfer.setData('text/plain', node.id); } catch { /* ignore */ } }}
           onDragEnd={onDragEnd}
           onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (dropOn !== node.id) setDropOn(node.id); }}
           onDragLeave={() => { if (dropOn === node.id) setDropOn(null); }}
           onDrop={(e) => { e.preventDefault(); e.stopPropagation(); onDropNode(node.id); }}>
        <button className={`work-chev${kids.length ? '' : ' none'}`} tabIndex={-1}
                onClick={(e) => { e.stopPropagation(); if (kids.length) onToggle(node.id); }}>
          {kids.length ? (isCollapsed ? '▸' : '▾') : '·'}
        </button>
        <StatusDot status={node.status} statuses={statuses} />
        <KindGlyph kind={node.kind} />
        <button className="work-nname" title={`${node.title} — click to scope the board and timeline here`}
                onClick={() => onSelect(node)} onDoubleClick={() => onOpen(node.id)}>
          {node.title}
        </button>
        {/* Hover-only, because a rail with two buttons on every row is unreadable — and quick-add is
            the gesture that keeps a plan honest while a human is reading it. */}
        <span className="work-nadd">
          {/* BOTH buttons on every node, deliberately. An activity may hold an activity and a task
              may hold a task — the hierarchy is by DEPTH, not by a fixed three-level shape — and
              which nestings are legal is the server's rule to state, not this rail's to guess. A
              button hidden on a guess is a legal move a human cannot make; a refused POST at least
              answers in a sentence. */}
          <button className="work-mini" title="add an activity under this node"
                  onClick={(e) => { e.stopPropagation(); onAdd(node, 'activity'); }}>＋ activity</button>
          <button className="work-mini" title="add a task under this node"
                  onClick={(e) => { e.stopPropagation(); onAdd(node, 'task'); }}>＋ task</button>
        </span>
      </div>
      {!isCollapsed && kids.map((k) => (
        <TreeNode key={k.id} node={k} depth={depth + 1} statuses={statuses}
                  collapsed={collapsed} onToggle={onToggle} selectedId={selectedId}
                  onSelect={onSelect} onOpen={onOpen} onAdd={onAdd}
                  dropOn={dropOn} setDropOn={setDropOn}
                  onDragStart={onDragStart} onDragEnd={onDragEnd} onDropNode={onDropNode} />
      ))}
    </div>
  );
}

// `tree=1` may hand back a nested shape (children arrays) or a flat, path-ordered list. Accept BOTH:
// the rail's job is to draw the hierarchy, and refusing to draw it because the server picked the
// other legal shape would be a bug in the console, not in the API.
export function normalise(rows) {
  const list = Array.isArray(rows) ? rows : (rows?.items || rows?.rows || []);
  if (!list.length) return [];
  if (list.some((r) => Array.isArray(r.children))) return list;
  const byId = new Map(list.map((r) => [r.id, { ...r, children: [] }]));
  const roots = [];
  for (const r of byId.values()) {
    const parent = r.parent_id ? byId.get(r.parent_id) : null;
    if (parent) parent.children.push(r); else roots.push(r);
  }
  const sort = (ns) => {
    ns.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || String(a.title).localeCompare(String(b.title)));
    for (const n of ns) sort(n.children);
  };
  sort(roots);
  return roots;
}
