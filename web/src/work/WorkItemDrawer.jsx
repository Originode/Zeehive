import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { showConfirm } from '../Dialog.jsx';
import {
  addDep, createWorkItem, deleteWorkItem, getWorkItem, listWorkItems, patchWorkItem, removeDep,
} from './workApi.js';
import { Breadcrumb, Due, ErrLine, KindGlyph, Pips, StatusDot, fmtWhen, legalNext, statusLabel,
         toInputDate } from './bits.jsx';
import DeployZee from './DeployZee.jsx';

// WORK TRACKER — the ITEM DRAWER: everything about one work item, and every edit you can make to it.
//
// WHY A SLIDE-OVER AND NOT A PAGE: the console has no router, and more importantly the board is the
// context. You open an item to change one field — a due date, a status, an assignee — and then you
// want the board back. A drawer keeps the board visible (and live-updating) behind it, so the edit
// is read in the place it matters instead of in a screen you had to navigate away to reach.
//
// EVERY EDIT IS ITS OWN PATCH, SAVED WHERE THE INTENT ENDS. There is no Save button, deliberately:
// a form with a Save button invites a human to change five fields and then close the drawer,
// losing all five. So the title commits on blur/Enter, the body on blur, and every control
// (status, priority, dates, estimate, progress) commits on change. Each one sends ONLY the field it
// owns, so two people editing different fields of the same item cannot clobber each other. Every
// failure prints the SERVER'S SENTENCE and re-reads the item, so what you see is never a hopeful
// local guess about what the server accepted.
//
// DELETE ASKS WITH A NUMBER. Deleting an activity deletes the tasks under it — that is the whole
// point of a tree and also the easiest way to lose a week of planning. So the confirmation states
// how many descendants go with it, and it goes through `showConfirm` from Dialog.jsx: the native
// window.confirm() parks the browser's event loop, which freezes the SSE stream and the hive behind
// this drawer (that is why Dialog.jsx exists at all — see its header).
export default function WorkItemDrawer({ itemId, projectId, statuses, onClose, onChanged, onOpen }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [progress, setProgress] = useState(0);
  const [addingChild, setAddingChild] = useState(false);
  const [childTitle, setChildTitle] = useState('');
  const [depSearch, setDepSearch] = useState(null);   // null = picker closed, '' = open and empty
  const [candidates, setCandidates] = useState(null);
  const titleRef = useRef(null);

  const item = data?.item || data || null;

  const load = useCallback(async () => {
    try {
      const d = await getWorkItem(itemId);
      setData(d);
      const it = d?.item || d;
      setTitle(it?.title || '');
      setBody(it?.body || '');
      setProgress(Number(it?.progress) || 0);
      setErr(null);
    } catch (e) { setErr(e); }
  }, [itemId]);

  useEffect(() => { setData(null); load(); }, [load]);

  // Escape closes the drawer — the same key the rest of the console's overlays answer to.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // ONE field, ONE patch. Nothing here ever sends the whole item back.
  const save = useCallback(async (patch) => {
    setBusy(true);
    try {
      await patchWorkItem(itemId, patch);
      setErr(null);
      await load();
      onChanged?.();
    } catch (e) {
      setErr(e);
      await load();                // the server refused: show what it actually holds, not the edit
    } finally { setBusy(false); }
  }, [itemId, load, onChanged]);

  const doDelete = async () => {
    const n = await countDescendants(itemId, projectId, data);
    const line = n > 0
      ? `Delete “${item.title}” and the ${n} item(s) beneath it?\n\nThe whole subtree goes. This cannot be undone.`
      : `Delete “${item.title}”?\n\nThis cannot be undone.`;
    if (!(await showConfirm(line, { variant: 'danger', okLabel: 'Delete' }))) return;
    setBusy(true);
    try { await deleteWorkItem(itemId); onChanged?.(); onClose?.(); }
    catch (e) { setErr(e); }
    finally { setBusy(false); }
  };

  const quickAddChild = async () => {
    const t = childTitle.trim();
    if (!t) { setAddingChild(false); return; }
    setBusy(true);
    try {
      // A child of an activity is a task; a child of the project root is an activity. The server is
      // the authority on what nesting is legal — this is only the sensible DEFAULT so a quick-add
      // does not make a human pick a kind for the obvious case.
      const kind = item?.kind === 'project' ? 'activity' : 'task';
      await createWorkItem({ project: projectId, parent_id: itemId, kind, title: t });
      setChildTitle(''); setAddingChild(false);
      await load();
      onChanged?.();
    } catch (e) { setErr(e); }
    finally { setBusy(false); }
  };

  // Candidates for a dependency: every item in the project except this one and the ones already
  // depended on. Fetched when the picker opens (not on drawer open) — it is the one call in here
  // that reads the whole project.
  useEffect(() => {
    if (depSearch === null || candidates) return;
    listWorkItems(projectId, {}).then((rows) => setCandidates(flatten(rows))).catch((e) => setErr(e));
  }, [depSearch, candidates, projectId]);

  const deps = data?.deps || [];
  const dependents = data?.dependents || [];
  const children = data?.children || [];
  const events = data?.events || [];
  const ancestors = data?.ancestors || [];
  const depIds = new Set(deps.map((d) => d.id || d.depends_on_id));
  const picks = useMemo(() => {
    const q = String(depSearch || '').toLowerCase();
    return (candidates || [])
      .filter((c) => c.id !== itemId && !depIds.has(c.id))
      .filter((c) => !q || String(c.title || '').toLowerCase().includes(q))
      .slice(0, 12);
  }, [candidates, depSearch, itemId, deps]);

  return (
    <aside className="work-drawer" data-testid="work-drawer" onClick={(e) => e.stopPropagation()}>
      <header className="work-drawer-h">
        <Breadcrumb parts={ancestors.map((a) => a.title)} />
        <button className="work-x" onClick={onClose} title="close (Esc)">✕</button>
      </header>

      {!item && !err && <div className="work-empty">loading…</div>}
      <ErrLine err={err} onDismiss={() => setErr(null)} />

      {item && (
        <div className="work-drawer-body">
          <div className="work-drawer-title">
            <KindGlyph kind={item.kind} />
            <input ref={titleRef} className="work-title-in" value={title} disabled={busy}
                   onChange={(e) => setTitle(e.target.value)}
                   onBlur={() => { if (title.trim() && title !== item.title) save({ title: title.trim() }); }}
                   onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
          </div>

          <div className="work-fields">
            <Field label="status">
              {/* The options are this item's OWN legal transitions (`next_statuses`, generated by
                  the server from the same table it validates against) plus where it already is —
                  so the picker cannot offer a move that will be refused. A dropdown built from the
                  whole vocabulary would offer 'working' on a done item and then show a 409. */}
              <select className="work-in" value={item.status || ''} disabled={busy}
                      onChange={(e) => save({ status: e.target.value })}>
                {legalNext(item, statuses).map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
              </select>
            </Field>
            <Field label="priority">
              <span className="work-prio-edit">
                <input className="work-in num" type="number" min="1" max="5" value={item.priority ?? 3} disabled={busy}
                       title="1 = most urgent · 3 = the default (the middle of the scale) · 5 = least urgent"
                       onChange={(e) => save({ priority: Number(e.target.value) })} />
                <Pips priority={item.priority} />
              </span>
            </Field>
            <Field label="assignee">
              <input className="work-in" defaultValue={item.assignee || ''} disabled={busy} placeholder="—"
                     key={`as-${item.assignee || ''}`}
                     onBlur={(e) => { if ((e.target.value || '') !== (item.assignee || '')) save({ assignee: e.target.value || null }); }} />
            </Field>
            <Field label="starts">
              <input className="work-in" type="date" value={toInputDate(item.starts_on)} disabled={busy}
                     onChange={(e) => save({ starts_on: e.target.value || null })} />
            </Field>
            <Field label="due">
              <span className="work-dueedit">
                <input className="work-in" type="date" value={toInputDate(item.due_on)} disabled={busy}
                       onChange={(e) => save({ due_on: e.target.value || null })} />
                <Due date={item.due_on} />
              </span>
            </Field>
            <Field label="estimate">
              <input className="work-in num" type="number" min="0" step="0.5" defaultValue={item.estimate_hours ?? ''}
                     key={`es-${item.estimate_hours ?? ''}`} disabled={busy} placeholder="h"
                     onBlur={(e) => {
                       const v = e.target.value === '' ? null : Number(e.target.value);
                       if (v !== (item.estimate_hours ?? null)) save({ estimate_hours: v });
                     }} />
            </Field>
            <Field label="progress">
              {/* The slider tracks locally while it is being dragged and PATCHes when the gesture
                  ENDS (mouse up / key up) — one write per decision, not one per pixel. */}
              <span className="work-progress">
                <input type="range" min="0" max="100" step="5" value={progress} disabled={busy}
                       onChange={(e) => setProgress(Number(e.target.value))}
                       onMouseUp={() => { if (progress !== (item.progress ?? 0)) save({ progress }); }}
                       onKeyUp={() => { if (progress !== (item.progress ?? 0)) save({ progress }); }} />
                <b>{progress}%</b>
              </span>
            </Field>
            {/* ── THE ZEE SEAM (part 3 slots its control in HERE) ──────────────────────────────
                Rendered even when nothing is on the item, so the empty state is a place rather
                than an absence: `xell_id` is the zee currently working this item, and part 3's
                "assign / deploy a zee" control belongs in this Field, beside the chip that shows
                who is already on it. It has everything it needs in scope — `item` (id, title,
                status, ticket_id), `data.zee`, and `onChanged`/`load` to refresh the drawer and
                the board after a deploy. Nothing else in this file needs to move. */}
            <Field label="zee">
              <DeployZee item={item} zee={data?.zee} events={events} busy={busy}
                         onDone={() => { load(); onChanged?.(); }} onError={setErr} />
            </Field>
            {data?.ticket && (
              <Field label="ticket">
                <span className="work-tktlink">#{data.ticket.number} {data.ticket.title}</span>
              </Field>
            )}
          </div>

          <label className="work-lbl">notes</label>
          <textarea className="work-body" value={body} rows={5} disabled={busy}
                    placeholder="what this is, and what done looks like"
                    onChange={(e) => setBody(e.target.value)}
                    onBlur={() => { if (body !== (item.body || '')) save({ body }); }} />

          <Section title={`children (${children.length})`}
                   action={<button className="work-mini" onClick={() => setAddingChild((v) => !v)}>＋ add</button>}>
            {addingChild && (
              <div className="work-quickadd">
                <input className="work-in" autoFocus value={childTitle} placeholder="title, then Enter"
                       onChange={(e) => setChildTitle(e.target.value)}
                       onKeyDown={(e) => { if (e.key === 'Enter') quickAddChild(); if (e.key === 'Escape') setAddingChild(false); }} />
                <button className="work-mini" onClick={quickAddChild} disabled={busy}>add</button>
              </div>
            )}
            {children.map((c) => (
              <button key={c.id} className="work-row" onClick={() => onOpen?.(c.id)}>
                <StatusDot status={c.status} statuses={statuses} />
                <KindGlyph kind={c.kind} />
                <span className="work-row-t">{c.title}</span>
                <Due date={c.due_on} />
              </button>
            ))}
            {!children.length && !addingChild && <div className="work-none">no children</div>}
          </Section>

          <Section title={`depends on (${deps.length})`}
                   action={<button className="work-mini" onClick={() => setDepSearch((v) => (v === null ? '' : null))}>＋ add</button>}>
            {depSearch !== null && (
              <div className="work-deppick">
                <input className="work-in" autoFocus value={depSearch} placeholder="search items…"
                       onChange={(e) => setDepSearch(e.target.value)} />
                <div className="work-deplist">
                  {candidates === null && <div className="work-none">loading…</div>}
                  {picks.map((c) => (
                    <button key={c.id} className="work-row" disabled={busy}
                            onClick={async () => {
                              setBusy(true);
                              try { await addDep(itemId, c.id); setDepSearch(null); await load(); onChanged?.(); }
                              catch (e) { setErr(e); } finally { setBusy(false); }
                            }}>
                      <KindGlyph kind={c.kind} /><span className="work-row-t">{c.title}</span>
                    </button>
                  ))}
                  {candidates !== null && !picks.length && <div className="work-none">nothing matches</div>}
                </div>
              </div>
            )}
            {deps.map((d) => (
              <div key={d.id} className="work-row static">
                <StatusDot status={d.status} statuses={statuses} />
                <button className="work-row-t link" onClick={() => onOpen?.(d.id)}>{d.title}</button>
                <button className="work-mini danger" disabled={busy} title="remove this dependency"
                        onClick={async () => {
                          setBusy(true);
                          try { await removeDep(itemId, d.id); await load(); onChanged?.(); }
                          catch (e) { setErr(e); } finally { setBusy(false); }
                        }}>✕</button>
              </div>
            ))}
            {!deps.length && depSearch === null && <div className="work-none">nothing blocking it</div>}
          </Section>

          {!!dependents.length && (
            <Section title={`blocks (${dependents.length})`}>
              {dependents.map((d) => (
                <button key={d.id} className="work-row" onClick={() => onOpen?.(d.id)}>
                  <StatusDot status={d.status} statuses={statuses} />
                  <span className="work-row-t">{d.title}</span>
                </button>
              ))}
            </Section>
          )}

          <Section title={`history (${events.length})`}>
            {events.map((ev, i) => (
              <div key={ev.id || i} className="work-ev">
                <span className="work-ev-when">{fmtWhen(ev.ts || ev.created_at)}</span>
                <span className="work-ev-what">
                  <b>{ev.actor || ev.author || 'system'}</b> {describeEvent(ev, statuses)}
                </span>
              </div>
            ))}
            {!events.length && <div className="work-none">nothing has happened yet</div>}
          </Section>

          <div className="work-drawer-foot">
            <button className="work-del" disabled={busy} onClick={doDelete}>Delete</button>
          </div>
        </div>
      )}
    </aside>
  );
}

function Field({ label, children }) {
  return <label className="work-field"><span className="work-lbl">{label}</span>{children}</label>;
}

function Section({ title, action, children }) {
  return (
    <section className="work-sec">
      <header className="work-sec-h"><span>{title}</span>{action}</header>
      <div className="work-sec-b">{children}</div>
    </section>
  );
}

// An event row reads as a sentence. The ledger's own vocabulary is
// created | status | moved | assigned | edited | comment — note there is NO 'deleted' event, ever
// (work_item_event cascades with the row), so nothing here waits for one. An unrecognised kind is
// printed as itself: a history that hides the event it does not understand is a history you cannot
// trust, and `detail` (jsonb) is where the interesting part of an 'edited' lives.
const EVENT_VERBS = {
  created:  () => 'created it',
  moved:    () => 'moved it in the tree',
  assigned: (ev) => `assigned it${detailText(ev) ? ` — ${detailText(ev)}` : ''}`,
  edited:   (ev) => `edited it${detailText(ev) ? ` — ${detailText(ev)}` : ''}`,
  comment:  (ev) => `commented${detailText(ev) ? ` — ${detailText(ev)}` : ''}`,
  status:   (ev, statuses) => {
    const from = ev.from_status ?? ev.from;
    const to = ev.to_status ?? ev.to;
    return `moved it ${from ? `from ${statusLabel(statuses, from)} ` : ''}to ${statusLabel(statuses, to)}`;
  },
};

function describeEvent(ev, statuses) {
  const verb = EVENT_VERBS[ev.kind];
  return verb ? verb(ev, statuses) : (detailText(ev) || ev.kind || 'changed');
}

// `detail` is free-form jsonb ({fields:[…]}, {added_dep:…}, …). Render the keys, not a JSON blob —
// but never hide it: an event whose detail this code has not met yet still says what it holds.
function detailText(ev) {
  const d = ev.detail;
  if (!d) return '';
  if (typeof d === 'string') return d;
  return Object.entries(d)
    .map(([k, v]) => (Array.isArray(v) ? `${k}: ${v.join(', ')}` : `${k}: ${String(v).slice(0, 40)}`))
    .join(' · ');
}

// `tree=1` may come back nested (children arrays) or flat; the drawer only wants a flat list of
// candidates, so accept either shape rather than betting on one.
export function flatten(rows) {
  const out = [];
  const walk = (list) => { for (const r of list || []) { out.push(r); if (r.children?.length) walk(r.children); } };
  walk(Array.isArray(rows) ? rows : rows?.items || []);
  return out;
}

// How many items go with a delete. Prefer a count the server already computed; otherwise ask for the
// subtree and count it. If neither works the confirmation still fires — it just cannot name a
// number, which is better than not asking at all.
async function countDescendants(itemId, projectId, data) {
  const given = data?.descendant_count ?? data?.item?.descendant_count;   // the detail model carries it
  if (typeof given === 'number') return given;
  try {
    const rows = await listWorkItems(projectId, { root: itemId, tree: 1 });
    return Math.max(0, flatten(rows).filter((r) => r.id !== itemId).length);
  } catch { return (data?.children || []).length; }
}
