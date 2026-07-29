import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { showAlert, showConfirm } from '../Dialog.jsx';
import {
  addComment, breakdownTicket, createTicket, deleteWorkItem, getTicket, getTicketManagers,
  listTickets, notifyTicketManager, patchTicket,
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
                 title="1 = most urgent · 3 = the default (the middle of the scale) · 5 = least urgent"
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

  // BREAKING A TICKET DOWN TWICE IS THE ONE PLACE THIS CONSOLE CAN CORRUPT A PLAN.
  //
  // `POST /breakdown` is ADDITIVE by design — a ticket legitimately grows work as it is understood,
  // and the server will not guess which existing items an author meant to keep. That is right for
  // the API and wrong for a button, because a human who edits their plan text and presses the same
  // button again means "this is the plan", not "append a near-duplicate of it". Doing that silently
  // leaves two overlapping trees under one ticket and no way to tell which is current — a data
  // problem in production, not a polish item.
  //
  // So once a ticket HAS items the single button becomes two, each saying exactly what it will do:
  //   ADD      — the API's own behaviour, named out loud, with the existing count in the label.
  //   REPLACE  — delete the linked items first, then create the new plan.
  //
  // REPLACE IS A COMPOSITE THE SERVER NEVER SEES AS ONE OPERATION, so the console owns its safety:
  //   • it refuses outright when a zee is on any of the items being deleted — deleting work someone
  //     is doing is destructive well beyond a plan, and unassigning first is the human's call;
  //   • its confirmation names the exact number going and the number arriving, and says plainly that
  //     the delete happens FIRST and is not atomic with the create;
  //   • it stops at the first refusal and leaves the rest alone rather than half-clearing a plan.
  const runBreakdown = async () => {
    setBusy(true);
    try {
      await breakdownTicket(id, breakdownPayload(parsed.items));
      setPlan(''); setBreaking(false);
      await load(); onChanged?.();
    } catch (e) { setErr(e); }
    finally { setBusy(false); }
  };

  const doAdd = async () => {
    if (!parsed.items.length) return;
    if (items.length) {
      const ok = await showConfirm(
        `Add ${parsed.items.length} item(s) to the plan on #${t.number}?\n\n`
        + `This ticket already has ${items.length}. They stay exactly as they are and the new items `
        + 'are added beside them — this does NOT replace the existing plan.',
        { okLabel: `Add ${parsed.items.length}` });
      if (!ok) return;
    }
    await runBreakdown();
  };

  const doReplace = async () => {
    if (!parsed.items.length || !items.length) return;
    const busyItems = items.filter((i) => i.xell_id);
    if (busyItems.length) {
      await showAlert(
        `Cannot replace this plan: a zee is on ${busyItems.length} of its items `
        + `(${busyItems.map((i) => i.title).join(', ')}).\n\n`
        + 'Replacing deletes those items, and deleting work a zee is doing is not something to do '
        + 'behind its back. Unassign them first, then replace.',
        { variant: 'error', title: 'Somebody is working on this plan' });
      return;
    }
    const ok = await showConfirm(
      `Replace the plan on #${t.number}?\n\n`
      + `This DELETES the ${items.length} existing item(s) and everything beneath them, then creates `
      + `the ${parsed.items.length} above.\n\nThe delete happens FIRST and the two steps are not one `
      + 'transaction: if the create then fails, the old plan is already gone. Nothing here can be undone.',
      { okLabel: 'Replace the plan', variant: 'danger' });
    if (!ok) return;
    setBusy(true);
    try {
      for (const it of items) {
        // A parent takes its descendants with it, so an item already gone is not an error here.
        try { await deleteWorkItem(it.id); }
        catch (e) { if (!/no such work item/i.test(e.message)) throw e; }
      }
      await load();
    } catch (e) {
      setErr(e); setBusy(false);
      return;                       // stop at the first real refusal — a half-cleared plan is worse
    }
    setBusy(false);
    await runBreakdown();
  };

  if (!t) return <div className="work-tdetail"><div className="work-empty">{err ? '' : 'loading…'}<ErrLine err={err} /></div></div>;

  return (
    <div className="work-tdetail" data-testid="work-ticket-detail">
      <header className="work-tdetail-h">
        <span className="work-tnum">#{t.number ?? '—'}</span>
        <TicketCode code={t.code} />
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
      <NotifyManager ticketId={id} onError={setErr} />
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
                {/* The state a human must know BEFORE choosing a button, not after pressing one. */}
                {items.length > 0 && (
                  <div className="work-warn">⚠ this ticket already has {items.length} item(s).
                    “Add” keeps them; “Replace” deletes them first. Nothing here happens silently.</div>
                )}
              </div>
              <div className="work-composer-foot">
                <button className="work-btn" onClick={() => { setBreaking(false); setPlan(''); }}>cancel</button>
                {items.length > 0 && (
                  <button className="work-btn danger" disabled={busy || !parsed.items.length} onClick={doReplace}
                          title={`Delete the ${items.length} existing item(s), then create these`}>
                    replace the plan ({items.length} → {parsed.items.length})
                  </button>
                )}
                <button className="work-btn primary" disabled={busy || !parsed.items.length} onClick={doAdd}>
                  {busy ? 'creating…'
                    : items.length ? `add ${parsed.items.length} to the ${items.length} already here`
                    : `create ${parsed.items.length} item(s)`}
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

// ── the ticket CODE, copyable ────────────────────────────────────────────────
//
// `t.code` is the SERVER'S derivation (TKT-<number>-<4 hex of the id>) and the console never builds
// one of its own: what a human copies here is byte-for-byte what a notified manager receives, and
// that is the entire point of the code.
//
// The code is rendered as real selectable text as well as a copy button, because the console is
// regularly served over plain http from another machine and `navigator.clipboard` does not exist on
// an insecure origin. So: the async API where the browser allows it, a throwaway textarea +
// execCommand where it does not (the same pair ZeeTerminal.jsx carries, for the same reason), and
// if both are blocked the text is still there to select by hand.
function TicketCode({ code }) {
  const [flash, setFlash] = useState('');
  if (!code) return null;
  const copy = () => {
    const done = () => { setFlash('copied'); setTimeout(() => setFlash(''), 1200); };
    try {
      const p = navigator.clipboard?.writeText(code);
      if (p && p.then) { p.then(done).catch(() => { execCopy(code); done(); }); return; }
    } catch { /* insecure origin / denied — fall through to the textarea */ }
    execCopy(code); done();
  };
  return (
    <span className="work-tcode">
      <code>{code}</code>
      <button className="work-mini" onClick={copy}
              title="Copy this ticket's code — paste it into a zee's session to name this ticket exactly">
        {flash || '⧉ copy'}
      </button>
    </span>
  );
}

function execCopy(text) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.focus(); ta.select();
    document.execCommand('copy'); document.body.removeChild(ta);
  } catch { /* nothing more we can do — the code is on screen to select by hand */ }
}

// ── notify a manager ─────────────────────────────────────────────────────────
//
// Hand this ticket to one of the managers ACTUALLY DEPLOYED right now. Three rules, all inherited
// from DeployZee.jsx (the other picker-over-the-live-fleet in this console) — same idiom, no new one:
//
// 1. THE LIST IS THE SERVER'S, fetched when the picker OPENS and never cached across opens. A
//    manager is a live agent; a remembered list is a list that offers someone who is gone.
// 2. A MANAGER WITH NO LIVE SESSION IS STILL SHOWN, marked ○ and carrying the server's own `why`
//    line. Hiding it would leave a human wondering where their manager went; what must not happen
//    is a message that quietly reaches nobody, which is rule 3.
// 3. THE VERDICT IS PRINTED, whichever way it went — delivered into the live session, or stored in
//    the inbox because there was none. The server writes that sentence (`note`); this component
//    does not paraphrase it, and refusals go straight to the detail's ErrLine like every other verb.
//
// No confirmation dialog: a notification assigns nothing, opens no gate and cannot be un-sent, but
// neither can an email. Choosing a manager from a list IS the deliberate act.
function NotifyManager({ ticketId, onError }) {
  const [mgrs, setMgrs] = useState(null);        // the whole payload: { managers, note, count }
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [verdict, setVerdict] = useState(null);  // { delivered, note } — what actually happened

  useEffect(() => {
    if (!picking || mgrs) return;
    let alive = true;
    getTicketManagers(ticketId)
      .then((r) => { if (alive) setMgrs(r || { managers: [] }); })
      .catch((e) => { if (alive) { setPicking(false); onError?.(e); } });
    return () => { alive = false; };
  }, [picking, mgrs, ticketId, onError]);

  const notify = async (m) => {
    setBusy(true);
    try {
      const r = await notifyTicketManager(ticketId, m.xell_id);
      setVerdict({ delivered: !!r.delivered, note: r.note || `${m.slug} was told about this ticket.` });
      setPicking(false); setMgrs(null);
    } catch (e) { onError?.(e); }
    finally { setBusy(false); }
  };

  return (
    <div className="work-tnotify" data-testid="work-ticket-notify">
      {!picking && (
        <button className="work-mini" disabled={busy}
                onClick={() => { setVerdict(null); setPicking(true); }}
                title="Tell a deployed manager zee about this ticket — it receives the code, the number and the title">
          🔔 notify manager
        </button>
      )}
      {picking && (
        <span className="work-cands">
          {mgrs === null && <span className="work-muted">looking for deployed managers…</span>}
          {/* When nobody is deployed the server sends its OWN sentence (and it names the way out —
              a human adds a manager). Printing that beats inventing a shorter one here. */}
          {mgrs && !mgrs.managers?.length && (
            <span className="work-muted">{mgrs.note || 'no manager zee is deployed on this project'}</span>
          )}
          {(mgrs?.managers || []).map((m) => (
            <button key={m.xell_id} className="work-cand" disabled={busy} onClick={() => notify(m)}>
              <b>{m.live ? '◉' : '○'} {m.slug}</b>
              {/* the server's OWN 'why' line — the console does not paraphrase it */}
              {m.why && <small>{m.why}</small>}
            </button>
          ))}
          <button className="work-mini" disabled={busy} onClick={() => setPicking(false)}>cancel</button>
        </span>
      )}
      {verdict && (
        <div className={`work-verdict${verdict.delivered ? '' : ' cold'}`}>
          {verdict.delivered ? '✓' : '⚠'} {verdict.note}
        </div>
      )}
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
