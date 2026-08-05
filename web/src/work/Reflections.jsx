import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { showConfirm } from '../Dialog.jsx';
import { fileReflection, listReflections } from './workApi.js';
import { ErrLine, fmtWhen } from './bits.jsx';
import { TicketCode } from './Tickets.jsx';

// WORK TRACKER — REFLECTIONS: what the fleet told itself, and nobody read.
//
// A reflection is written by a zee right after its work SHIPS (queenzee/shipgate.js re-invokes it,
// gated by the harness's `enable_reflection`): the one moment it knows more about that change than
// anyone else ever will. It is stored as a `zee_message` addressed to that zee's manager — and that
// is where it stopped, because the only readers were the manager's own `zee inbox` and the per-xell
// Directives panel. Dozens were addressed to manager xells that have since been retired, so their
// inbox is unreachable and the finding inside is unreachable with it.
//
// So this tab is the project-wide READ, and one action: FILE AS TICKET. It sits beside Tickets
// deliberately — a reflection is intake, exactly like a ticket, and the thing it becomes is a ticket
// on the same board.
//
// TWO RULES IT LIVES BY:
//
// 1. READING HERE MARKS NOTHING READ. `read_at` is the receipt for the ZEE's own `zee inbox`; a
//    human reading the ledger must not clear an agent's unread flags (Directives.jsx states the same
//    rule for the same table). There is no mark-read control here and there must never be one — the
//    unread emphasis is a fact about the AGENT, not about the human looking at the screen.
// 2. FILED ONCE. Once a reflection has become a ticket the row shows the ticket CODE instead of the
//    button, because the failure this feature exists to prevent is a finding acted on twice — or
//    argued about because two people filed it differently. The server enforces it; this only has to
//    stop offering the action.
//
// The body is COLLAPSED by default and expanded on click: a reflection is a few paragraphs, and a
// ledger of 300 of them fully expanded is not a list a human can scan.
const FILTERS = [
  { id: 'all', label: 'all' },
  { id: 'unread', label: 'unread' },
  { id: 'orphaned', label: 'orphaned' },
  { id: 'unfiled', label: 'not yet filed' },
];
const LIMITS = [50, 100, 200, 500];

export default function Reflections({ projectId, kinds = [], reloadKey = 0, onOpenTickets }) {
  const [rows, setRows] = useState([]);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');
  const [limit, setLimit] = useState(100);
  const [openId, setOpenId] = useState(null);

  const load = useCallback(async () => {
    try { setRows(await listReflections(projectId, { limit }) || []); setErr(null); }
    catch (e) { setErr(e); }
    finally { setLoading(false); }
  }, [projectId, limit]);
  useEffect(() => { load(); }, [load, reloadKey]);

  // The filters are CLIENT-side over what was fetched: the server's own knobs are limit/since (a
  // ledger is read from the top), and re-fetching to hide four rows would make "unread" mean
  // "unread among a different page".
  const shown = useMemo(() => filtered(rows, filter), [rows, filter]);
  const counts = useMemo(() => ({
    unread: rows.filter((r) => !r.read_at).length,
    orphaned: rows.filter((r) => r.orphaned).length,
    filed: rows.filter((r) => r.ticket).length,
  }), [rows]);

  const file = async (r, kind) => {
    const ok = await showConfirm(
      `File this reflection as a ${kind} ticket?\n\n`
      + `“${firstLine(r.body)}”\n\n`
      + `The ticket carries the reflection verbatim, plus the xell that wrote it (${r.from || 'unknown'}) `
      + 'and its date. Nothing is assigned and nobody is dispatched — it is a ticket in the intake tab, '
      + 'and this reflection will show its code so it cannot be filed twice.',
      { okLabel: 'File as ticket' });
    if (!ok) return;
    try { await fileReflection(r.id, { kind }); setErr(null); await load(); }
    catch (e) { setErr(e); }        // e.g. "already filed as TKT-12-A1B2" — shown, not swallowed
  };

  return (
    <div className="work-reflections" data-testid="work-reflections">
      <div className="work-filters">
        <select className="work-in" value={filter} onChange={(e) => setFilter(e.target.value)}
                data-testid="refl-filter">
          {FILTERS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
        </select>
        <select className="work-in" value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
          {LIMITS.map((n) => <option key={n} value={n}>newest {n}</option>)}
        </select>
        <span className="work-muted" data-testid="refl-counts">
          {rows.length} shown · {counts.unread} never read by their zee · {counts.orphaned} orphaned
          · {counts.filed} filed
        </span>
      </div>

      <ErrLine err={err} onDismiss={() => setErr(null)} />

      <div className="work-tlist">
        {loading && !rows.length && <div className="work-empty">loading reflections…</div>}
        {!loading && !rows.length && (
          <div className="work-empty">
            No reflections yet. A zee writes one when its work SHIPS — the queenzee re-invokes it and
            asks what it now knows (<code>zee report --kind reflection</code>).
          </div>
        )}
        {!loading && rows.length > 0 && !shown.length && <div className="work-empty">no reflections match this filter</div>}
        <ReflectionList rows={shown} openId={openId} kinds={kinds}
                        onToggle={(id) => setOpenId(openId === id ? null : id)}
                        onFile={file} onOpenTickets={onOpenTickets} />
      </div>
    </div>
  );
}

// The list is PURE — the fetch, the filter and the confirm live in the parent, so a test renders the
// rows and reads the markup back rather than driving a browser (the same split Directives.jsx makes
// for its conversation body).
export function ReflectionList({ rows, openId = null, kinds = [], onToggle, onFile, onOpenTickets }) {
  return (
    <>
      {(rows || []).map((r) => (
        <ReflectionRow key={r.id} r={r} open={openId === r.id} kinds={kinds}
                       onToggle={onToggle} onFile={onFile} onOpenTickets={onOpenTickets} />
      ))}
    </>
  );
}

export function ReflectionRow({ r, open = false, kinds = [], onToggle, onFile, onOpenTickets }) {
  const [kind, setKind] = useState('chore');
  const unread = !r.read_at;
  return (
    <div className={`refl-row${unread ? ' unread' : ''}${r.orphaned ? ' orphan' : ''}${open ? ' open' : ''}`}
         data-testid="refl-row">
      <button className="refl-head" onClick={() => onToggle?.(r.id)}
              title={open ? 'collapse' : 'read the whole reflection'}>
        <span className="refl-chev">{open ? '▾' : '▸'}</span>
        <span className="refl-from">{r.from || r.from_xell_slug || '(unknown xell)'}</span>
        <span className="refl-title">{firstLine(r.body)}</span>
        {unread
          ? <span className="refl-unread" title="its recipient has never read it (`zee inbox` is the only thing that clears this)">unread</span>
          : <span className="refl-readmark" title={`read by its zee at ${fmtWhen(r.read_at)}`}>read</span>}
        {r.orphaned && <span className="refl-orphan" title={r.orphan_reason || 'nobody can read it'}>⚑ orphaned</span>}
        <span className="refl-at">{fmtWhen(r.at)}</span>
      </button>

      <div className="refl-meta">
        <span title="the xell this reflection was written in">
          {r.from_xell_id ? `xell ${r.from_xell_slug || r.from}` : `xell ${r.from_xell_slug || r.from} (reaped)`}
        </span>
        <span title="the manager it was addressed to">
          → {r.to || 'nobody'}{r.recipient_retired ? ' (retired)' : ''}
        </span>
        {/* The server's OWN sentence for why nobody will read it — not paraphrased here. */}
        {r.orphaned && r.orphan_reason && <span className="refl-why">{r.orphan_reason}</span>}
      </div>

      {open && <div className="refl-body" data-testid="refl-body">{r.body}</div>}

      <div className="refl-actions">
        {r.ticket
          ? (
            <span className="refl-filed" data-testid="refl-filed">
              filed as <TicketCode code={r.ticket.code} />
              {onOpenTickets && (
                <button className="work-mini" onClick={() => onOpenTickets(r.ticket)}>open it</button>
              )}
            </span>
          )
          : (
            <>
              <select className="work-in" value={kind} onChange={(e) => setKind(e.target.value)}
                      title="the ticket kind — chore by default, because most reflections are work to do">
                {(kinds.length ? kinds : ['chore']).map((k) => <option key={k} value={k}>{k}</option>)}
              </select>
              <button className="work-mini" data-testid="refl-file" onClick={() => onFile?.(r, kind)}>
                ⤴ file as ticket
              </button>
            </>
          )}
      </div>
    </div>
  );
}

// The first line IS the headline — that is how a zee writes a reflection, and it is what the server
// makes the ticket title from (lib/reflections.reflectionTitle). Shown here so a human sees the same
// sentence before they press the button.
export function firstLine(body) {
  const line = String(body || '').split('\n').map((s) => s.trim()).find((s) => s.length > 0) || '';
  const clean = line.replace(/^[#>*\-\s🪞]+/, '');
  return clean.length > 120 ? `${clean.slice(0, 119)}…` : (clean || '(empty reflection)');
}

export function filtered(rows, filter) {
  const list = rows || [];
  if (filter === 'unread') return list.filter((r) => !r.read_at);
  if (filter === 'orphaned') return list.filter((r) => r.orphaned);
  if (filter === 'unfiled') return list.filter((r) => !r.ticket);
  return list;
}
