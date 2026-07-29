import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  addComment, breakdownTicket, createTicket, getTicket, listTickets, patchTicket,
} from './workApi.js';
import { Breadcrumb, ErrLine, KindGlyph, Pips, StatusDot, legalNext, statusLabel } from './bits.jsx';

// WORK TRACKER — TICKETS: the intake side of the tracker.
//
// WHY TICKETS AND WORK ITEMS ARE DIFFERENT THINGS: a ticket is what someone ASKS FOR ("the board
// flickers when a zee lands"). A work item is what someone will DO about it. Collapsing the two —
// the mistake every home-grown tracker makes — means every stray report becomes a task on the plan,
// and the plan stops being a plan. So intake is its own tab: tickets arrive here, get read, and are
// BROKEN DOWN into a small tree of work items that then lives on the board.
//
// THE BREAKDOWN EDITOR IS A TEXTAREA ON PURPOSE. Breaking a ticket down is thinking, and thinking
// happens at typing speed; a form with "+ add row" buttons turns a two-minute decomposition into
// twenty clicks. So a manager types one item per line and indents with two spaces to nest under the
// line above — the same shape as the plan in their head. The parse is shown back as a TREE PREVIEW
// before anything is posted, because a silent mis-parse (a tab instead of two spaces) would create
// the wrong hierarchy and quietly move on.
//
// KINDS ARE NOT HARDCODED EITHER. `ticket_kinds` (bug / feature / chore / question / incident) rides
// along on GET /api/work-statuses — the same call that carries the status vocabulary — because it is
// the same fact: a postgres enum the server validates against. So the filter and the composer offer
// exactly what the server accepts, and a kind added to the enum appears here with no web change.
export default function Tickets({ projectId, statuses, kinds = [], onOpenItem, reloadKey = 0 }) {
  const [rows, setRows] = useState([]);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);
  const [f, setF] = useState({ status: '', kind: '', q: '' });
  const [openId, setOpenId] = useState(null);
  const [composing, setComposing] = useState(false);

  const load = useCallback(async () => {
    try { setRows(await listTickets(projectId, f) || []); setErr(null); }
    catch (e) { setErr(e); }
    finally { setLoading(false); }
  }, [projectId, f.status, f.kind, f.q]);   // eslint-disable-line react-hooks/exhaustive-deps

  // Debounced so typing in the free-text box does not fire a request per keystroke.
  useEffect(() => { const t = setTimeout(load, f.q ? 250 : 0); return () => clearTimeout(t); }, [load, reloadKey]);

  return (
    <div className="work-tickets" data-testid="work-tickets">
      <div className="work-filters">
        <select className="work-in" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
          {/* A FILTER offers the WHOLE vocabulary on purpose — you may look for work in any status,
              including one nothing is in. Legal-transition filtering belongs on the pickers that
              WRITE a status, not on the one that reads. */}
          <option value="">any status</option>
          {[...(statuses || [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
            .map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select>
        <select className="work-in" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
          <option value="">any kind</option>
          {kinds.map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
        <input className="work-in grow" value={f.q} placeholder="search title / body…"
               onChange={(e) => setF({ ...f, q: e.target.value })} />
        <button className="work-btn primary" onClick={() => setComposing(true)}>＋ new ticket</button>
      </div>

      <ErrLine err={err} onDismiss={() => setErr(null)} />
      {composing && (
        <Composer projectId={projectId} kinds={kinds}
                  onClose={() => setComposing(false)}
                  onCreated={(t) => { setComposing(false); load(); setOpenId(t?.id || t?.ticket?.id || null); }} />
      )}

      <div className="work-tlist">
        {loading && !rows.length && <div className="work-empty">loading tickets…</div>}
        {!loading && !rows.length && <div className="work-empty">no tickets match</div>}
        {rows.map((t) => (
          <button key={t.id} className={`work-trow${openId === t.id ? ' sel' : ''}`}
                  onClick={() => setOpenId(openId === t.id ? null : t.id)}>
            <StatusDot status={t.status} statuses={statuses} />
            <span className="work-tnum">#{t.number ?? '—'}</span>
            <span className="work-row-t">{t.title}</span>
            {t.kind && <span className="work-tkind">{t.kind}</span>}
            <Pips priority={t.priority} />
            {t.work_items_count > 0 && (
              <span className="work-tcount" title={`${t.work_items_count} work item(s) broken out of this ticket`}>
                ▤ {t.work_items_count}
              </span>
            )}
          </button>
        ))}
      </div>

      {openId && (
        <TicketDetail id={openId} projectId={projectId} statuses={statuses}
                      onClose={() => setOpenId(null)} onChanged={load} onOpenItem={onOpenItem} />
      )}
    </div>
  );
}

// ── the composer ─────────────────────────────────────────────────────────────
function Composer({ projectId, kinds, onClose, onCreated }) {
  const [v, setV] = useState({ title: '', body: '', kind: '', priority: 3, reporter: '', labels: '' });
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!v.title.trim()) return;
    setBusy(true);
    try {
      const t = await createTicket({
        project: projectId,
        title: v.title.trim(),
        body: v.body,
        kind: v.kind || undefined,
        priority: Number(v.priority) || 3,
        reporter: v.reporter || undefined,
        // Labels are typed as a comma list because that is how people already write them; the API
        // takes an array, so the split happens here rather than asking a human to type JSON.
        labels: v.labels.split(',').map((s) => s.trim()).filter(Boolean),
      });
      onCreated?.(t);
    } catch (e) { setErr(e); }
    finally { setBusy(false); }
  };

  return (
    <div className="work-composer">
      <ErrLine err={err} onDismiss={() => setErr(null)} />
      <input className="work-in grow" autoFocus placeholder="what is wrong / what is wanted"
             value={v.title} onChange={(e) => setV({ ...v, title: e.target.value })} />
      <textarea className="work-body" rows={4} placeholder="detail, steps, links…"
                value={v.body} onChange={(e) => setV({ ...v, body: e.target.value })} />
      <div className="work-composer-row">
        <label className="work-field"><span className="work-lbl">kind</span>
          <select className="work-in" value={v.kind} onChange={(e) => setV({ ...v, kind: e.target.value })}>
            <option value="">(server default)</option>
            {kinds.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
        </label>
        <label className="work-field"><span className="work-lbl">priority</span>
          <input className="work-in num" type="number" min="1" max="5" value={v.priority}
                 onChange={(e) => setV({ ...v, priority: e.target.value })} />
        </label>
        <label className="work-field"><span className="work-lbl">reporter</span>
          <input className="work-in" value={v.reporter} placeholder="who is asking"
                 onChange={(e) => setV({ ...v, reporter: e.target.value })} />
        </label>
        <label className="work-field grow"><span className="work-lbl">labels</span>
          <input className="work-in" value={v.labels} placeholder="comma, separated"
                 onChange={(e) => setV({ ...v, labels: e.target.value })} />
        </label>
      </div>
      <div className="work-composer-foot">
        <button className="work-btn" onClick={onClose}>cancel</button>
        <button className="work-btn primary" disabled={busy || !v.title.trim()} onClick={submit}>
          {busy ? 'creating…' : 'create ticket'}
        </button>
      </div>
    </div>
  );
}

// ── one ticket: comments + break down ────────────────────────────────────────
function TicketDetail({ id, projectId, statuses, onClose, onChanged, onOpenItem }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [comment, setComment] = useState('');
  const [breaking, setBreaking] = useState(false);
  const [plan, setPlan] = useState('');

  const load = useCallback(async () => {
    try { setD(await getTicket(id)); setErr(null); } catch (e) { setErr(e); }
  }, [id]);
  useEffect(() => { setD(null); load(); }, [load]);

  const t = d?.ticket || d;
  const comments = d?.comments || t?.comments || [];
  const items = d?.work_items || t?.work_items || [];
  const parsed = useMemo(() => parsePlan(plan), [plan]);

  const post = async () => {
    if (!comment.trim()) return;
    setBusy(true);
    try { await addComment(id, { body: comment.trim() }); setComment(''); await load(); }
    catch (e) { setErr(e); }
    finally { setBusy(false); }
  };

  const doBreakdown = async () => {
    if (!parsed.items.length) return;
    setBusy(true);
    try {
      await breakdownTicket(id, breakdownPayload(parsed.items));
      setPlan(''); setBreaking(false);
      await load(); onChanged?.();
    } catch (e) { setErr(e); }
    finally { setBusy(false); }
  };

  if (!t) return <div className="work-tdetail"><div className="work-empty">{err ? '' : 'loading…'}<ErrLine err={err} /></div></div>;

  return (
    <div className="work-tdetail" data-testid="work-ticket-detail">
      <header className="work-tdetail-h">
        <span className="work-tnum">#{t.number ?? '—'}</span>
        <b className="work-row-t">{t.title}</b>
        <select className="work-in" value={t.status || ''} disabled={busy}
                onChange={async (e) => {
                  setBusy(true);
                  try { await patchTicket(id, { status: e.target.value }); await load(); onChanged?.(); }
                  catch (x) { setErr(x); } finally { setBusy(false); }
                }}>
          {/* A ticket carries `next_statuses` exactly like a work item does, so the picker that
              WRITES its status gets the same rule as the drawer's: offer only what the server will
              accept. Offering the whole vocabulary here was my own inconsistency — it handed a
              human an option and then answered it with a 409. */}
          {legalNext(t, statuses).map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select>
        <button className="work-x" onClick={onClose} title="close">✕</button>
      </header>
      <ErrLine err={err} onDismiss={() => setErr(null)} />
      <div className="work-tmeta">
        {t.kind && <span className="work-tkind">{t.kind}</span>}
        <Pips priority={t.priority} />
        {t.reporter && <span className="work-muted">reported by {t.reporter}</span>}
        {(t.labels || []).map((l) => <span key={l} className="work-label">{l}</span>)}
        <span className="work-muted">{statusLabel(statuses, t.status)}</span>
      </div>
      {t.body && <div className="work-tbody">{t.body}</div>}

      <section className="work-sec">
        <header className="work-sec-h">
          <span>work items ({items.length})</span>
          <button className="work-mini" onClick={() => setBreaking((b) => !b)}>
            {breaking ? 'cancel' : '⑃ break down'}
          </button>
        </header>
        <div className="work-sec-b">
          {items.map((it) => (
            <button key={it.id} className="work-row" onClick={() => onOpenItem?.(it.id)}>
              <StatusDot status={it.status} statuses={statuses} />
              <KindGlyph kind={it.kind} />
              <span className="work-row-t">{it.title}</span>
              <Breadcrumb parts={it.breadcrumb} />
            </button>
          ))}
          {!items.length && !breaking && <div className="work-none">nothing broken out yet</div>}

          {breaking && (
            <div className="work-breakdown">
              <textarea className="work-body mono" rows={8} autoFocus value={plan}
                        placeholder={'one item per line — indent two spaces to nest\n\n'
                          + 'reproduce the flicker\n  capture an SSE trace\n  find the re-render\nfix it'}
                        onChange={(e) => setPlan(e.target.value)} />
              <div className="work-preview">
                <div className="work-lbl">preview — this is exactly what will be created</div>
                {parsed.items.map((it, i) => (
                  <div key={i} className="work-prow" style={{ paddingLeft: 8 + it._depth * 16 }}>
                    <KindGlyph kind={it.kind} /> <span>{it.title}</span>
                  </div>
                ))}
                {!parsed.items.length && <div className="work-none">type a line above</div>}
                {parsed.warnings.map((w, i) => <div key={i} className="work-warn">⚠ {w}</div>)}
                {/* Breaking a ticket down twice ADDS a second plan — the API is additive on
                    purpose (a ticket legitimately grows work as it is understood) and it does not
                    reconcile. Said out loud here, because the button does not look additive. */}
                {items.length > 0 && (
                  <div className="work-warn">⚠ this ticket already has {items.length} item(s) —
                    a breakdown ADDS to the plan, it does not replace it</div>
                )}
              </div>
              <div className="work-composer-foot">
                <button className="work-btn" onClick={() => { setBreaking(false); setPlan(''); }}>cancel</button>
                <button className="work-btn primary" disabled={busy || !parsed.items.length} onClick={doBreakdown}>
                  {busy ? 'creating…' : `create ${parsed.items.length} item(s)`}
                </button>
              </div>
            </div>
          )}
        </div>
      </section>

      <section className="work-sec">
        <header className="work-sec-h"><span>comments ({comments.length})</span></header>
        <div className="work-sec-b">
          {comments.map((c, i) => (
            <div key={c.id || i} className="work-comment">
              <b>{c.author || 'someone'}</b>
              <span className="work-muted">{c.created_at ? new Date(c.created_at).toLocaleString() : ''}</span>
              <div className="work-comment-b">{c.body}</div>
            </div>
          ))}
          <div className="work-quickadd">
            <input className="work-in grow" value={comment} placeholder="add a comment…"
                   onChange={(e) => setComment(e.target.value)}
                   onKeyDown={(e) => { if (e.key === 'Enter') post(); }} />
            <button className="work-mini" disabled={busy || !comment.trim()} onClick={post}>post</button>
          </div>
        </div>
      </section>
    </div>
  );
}

// TWO SPACES = ONE LEVEL. Deliberately strict and deliberately simple: a tab, or an odd number of
// spaces, is rounded down to the nearest level AND reported as a warning rather than guessed at
// silently — a mis-parsed indent creates the wrong tree, and the preview is the only chance a human
// has to notice.
//
// NESTING RIDES ON `ref`. The breakdown API lets an entry name an EARLIER entry's caller-supplied
// `ref` as its `parent_id`, which is what makes a whole tree one atomic call (and one transaction:
// all of it, or an untouched ticket). So each line gets a ref, and an indented line names the ref of
// the nearest line above it that is one level shallower. Refs resolve BACKWARDS only — which is
// exactly what an indented text block gives you, so the two agree by construction.
//
// Depth also picks the default KIND: level 0 → activity (it lands under the project root), deeper →
// task. Both `activity under activity` and `task under task` are legal, so this is only a sensible
// default for the common shape, not a rule — the server's own nesting rule (child rank ≥ parent
// rank) is the authority, and it answers in a sentence when a line breaks it.
export function parsePlan(text) {
  const items = [];
  const warnings = [];
  const refAt = [];               // refAt[d] = the ref of the last line seen at depth d
  let prevDepth = 0;
  let n = 0;
  for (const raw of String(text || '').split('\n')) {
    if (!raw.trim()) continue;
    const lead = raw.match(/^[ \t]*/)[0];
    if (lead.includes('\t')) warnings.push('a line is indented with a TAB — two SPACES make a level');
    const spaces = lead.replace(/\t/g, '  ').length;
    if (spaces % 2) warnings.push(`“${raw.trim().slice(0, 30)}” has an odd indent — rounded down`);
    let depth = Math.floor(spaces / 2);
    if (depth > prevDepth + 1) {
      warnings.push(`“${raw.trim().slice(0, 30)}” jumps more than one level — treated as level ${prevDepth + 1}`);
      depth = prevDepth + 1;
    }
    prevDepth = depth;
    const ref = `n${++n}`;
    refAt[depth] = ref;
    refAt.length = depth + 1;     // anything deeper is out of scope now
    const item = { ref, title: raw.trim(), kind: depth === 0 ? 'activity' : 'task', _depth: depth };
    if (depth > 0 && refAt[depth - 1]) item.parent_id = refAt[depth - 1];
    items.push(item);
  }
  return { items, warnings };
}

// What actually goes on the wire: the preview's own bookkeeping (`_depth`) is not the server's
// business. Everything else — including `ref` — is part of the documented entry shape.
export const breakdownPayload = (items) => items.map(({ _depth, ...entry }) => entry);
