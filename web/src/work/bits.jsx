import React from 'react';
import { HIVE_COLORS, hiveHeat } from '../hive/status.js';

// WORK TRACKER — the small shared PRESENTATION pieces every tracker screen repeats.
//
// A work item is read in four places (tree rail, board card, drawer, ticket) and in all four the
// same five facts have to be legible at a glance: what KIND of node it is, what STATUS it sits in,
// how urgent it is, when it is due, and which zee is on it. Copying that rendering four times is
// how a board ends up with three different ideas of "overdue" — so it lives here once.
//
// Two rules this file exists to hold:
//   1. NO STATUS VOCABULARY IS HARDCODED. Not the keys, not the labels, not the order. Everything
//      status-shaped takes the vocabulary from `/api/work-statuses` (passed in as `statuses`) and
//      looks its label up. The only place a status KEY is ever written down on the web side is a
//      CSS class name (`.work-st-<key>`) for its dot colour — and `test/work-console.test.mjs`
//      holds that list in lockstep with `server/src/lib/work-status.js`.
//   2. THE ZEE COLOURS COME FROM THE HIVE PALETTE. A zee chip on a card is the same agent the
//      honeycomb is drawing two panes away; if the board invented its own greens the console would
//      be telling a human two colours for one fact. So `HIVE_COLORS`/`hiveHeat` are imported from
//      `web/src/hive/status.js` — never re-hexed here.
export const KIND_GLYPH = { project: '▣', activity: '▤', task: '▸' };

export function KindGlyph({ kind, className = '' }) {
  return (
    <span className={`work-kind k-${kind || 'task'} ${className}`} title={kind || 'task'} aria-hidden="true">
      {KIND_GLYPH[kind] || KIND_GLYPH.task}
    </span>
  );
}

// The label for a status key, from the SERVER's vocabulary. Falls back to the raw key rather than
// to a guess: a key with no label means the vocabulary moved and the human should see which key.
export const statusLabel = (statuses, key) =>
  (statuses || []).find((s) => s.key === key)?.label || key || '—';

// The statuses a ROW may actually move to: its own server-generated `next_statuses` plus where it
// already is, in the vocabulary's order. Both a work item and a TICKET carry the field, and both
// pickers must use it — a dropdown built from the whole vocabulary offers 'working' on a done item
// and then hands the human a 409 for taking the option it just gave them.
export function legalNext(row, statuses) {
  const vocab = [...(statuses || [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const allowed = Array.isArray(row?.next_statuses) && row.next_statuses.length
    ? new Set([...row.next_statuses, row.status])
    : null;
  const list = allowed ? vocab.filter((s) => allowed.has(s.key)) : vocab;
  return list.length ? list : vocab;         // an unknown current status must not empty the picker
}

export function StatusDot({ status, statuses, className = '' }) {
  return (
    <span className={`work-dot work-st-${status || 'unknown'} ${className}`}
          title={statusLabel(statuses, status)} aria-label={statusLabel(statuses, status)} />
  );
}

// Priority is 1..5 and the API says nothing about which end is urgent — the tracker treats 1 as the
// most urgent (the usual P1 convention), so the pips FILL as the number drops and the tooltip spells
// it out rather than leaving a human to infer it from five dots.
export function Pips({ priority }) {
  const p = Number(priority) || 3;
  const filled = Math.max(0, Math.min(5, 6 - p));
  return (
    <span className={`work-pips p-${p}`} title={`priority ${p} of 5 (1 = most urgent)`}>
      {[1, 2, 3, 4, 5].map((i) => <i key={i} className={i <= filled ? 'on' : ''} />)}
    </span>
  );
}

// Dates: `Intl`/`Date` only — no date library, per the house rule. A date-only column ('2026-08-01')
// is parsed as a LOCAL date on purpose: `new Date('2026-08-01')` is UTC midnight, which renders as
// the day before for anyone west of Greenwich, and a due date that shows the wrong day is worse
// than no due date at all.
export function parseDay(s) {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s));
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}
const DAY_FMT = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
export const fmtDay = (s) => { const d = parseDay(s); return d ? DAY_FMT.format(d) : ''; };
export const toInputDate = (s) => {
  const d = parseDay(s);
  if (!d) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
// Whole days from today (negative = in the past). Compared at local midnight so "due today" is not
// "overdue by 0.3 of a day".
export function daysOut(s) {
  const d = parseDay(s);
  if (!d) return null;
  const t = new Date(); t.setHours(0, 0, 0, 0);
  return Math.round((d.getTime() - t.getTime()) / 86400000);
}

// A due date carries its own temperature: overdue and today sit at the warm/red end of the palette
// (the same --down / --building the rest of the console uses for "this needs you"), everything
// further out is muted. `terminal` suppresses the heat — a finished item cannot be late.
export function Due({ date, terminal = false }) {
  if (!date) return null;
  const n = daysOut(date);
  const heat = terminal || n === null ? '' : n < 0 ? ' over' : n === 0 ? ' today' : n <= 2 ? ' soon' : '';
  const title = n === null ? `due ${date}`
    : n < 0 ? `due ${date} — ${-n} day(s) overdue`
    : n === 0 ? `due ${date} — today`
    : `due ${date} — in ${n} day(s)`;
  return <span className={`work-due${heat}`} title={title}>⏱ {fmtDay(date)}</span>;
}

// The zee actually working the item, painted in ITS hive colour. `hiveHeat` drives how strongly the
// chip glows, so a xell being landed/shipped (hot) reads off a board card the same way it reads off
// the honeycomb.
export function ZeeChip({ zee, className = '' }) {
  if (!zee || !zee.slug) return null;
  const colour = HIVE_COLORS[zee.hive_status] || 'var(--muted)';
  const heat = hiveHeat(zee.hive_status);
  return (
    <span className={`work-zee ${className}`}
          style={{ color: colour, borderColor: colour, background: `rgba(255,255,255,${0.03 + heat * 0.07})` }}
          title={`zee ${zee.slug} — ${zee.hive_status_label || zee.hive_status || 'unknown'}`}>
      ⬢ {zee.slug}{zee.hive_status_label ? <i> · {zee.hive_status_label}</i> : null}
    </span>
  );
}

// The ancestor trail on a card ("Project › Activity"). Dimmed, because it is context and not the
// thing you are reading; joined with › because that is the console's existing separator.
export function Breadcrumb({ parts, className = '' }) {
  const list = (Array.isArray(parts) ? parts : String(parts || '').split('›')).map((s) => String(s).trim()).filter(Boolean);
  if (!list.length) return null;
  return <span className={`work-crumb ${className}`} title={list.join(' › ')}>{list.join(' › ')}</span>;
}

// One error surface for the whole tracker: it prints the SERVER'S SENTENCE. Every refusal in this
// API is a written explanation ("cannot move an activity under a task"); showing "failed" instead
// throws away the only useful thing in the response.
export function ErrLine({ err, onDismiss }) {
  if (!err) return null;
  return (
    <div className="work-err" role="alert">
      <span>{String(err.message || err)}</span>
      {onDismiss && <button className="work-err-x" onClick={onDismiss} title="dismiss">✕</button>}
    </div>
  );
}
