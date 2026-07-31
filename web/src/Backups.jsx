import React, { useEffect, useState } from 'react';
import { getBackups, setBackupConfig, runBackup, revealBackup, restoreBackup, deleteBackup } from './api.js';
import { showConfirm, showPrompt } from './Dialog.jsx';

const pad = (n) => String(n).padStart(2, '0');

// yyyy_mm_dd_hh_mm_ss (local time) — the label format the panel + modal show.
function stampFmt(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}_${pad(d.getMonth() + 1)}_${pad(d.getDate())}_${pad(d.getHours())}_${pad(d.getMinutes())}_${pad(d.getSeconds())}`;
}

function ago(ts) {
  const s = Math.max(0, Math.floor((Date.now() - new Date(ts).getTime()) / 1000));
  if (s < 60) return `${s} sec${s === 1 ? '' : 's'} ago`;
  const m = Math.floor(s / 60); if (m < 60) return `${m} min${m === 1 ? '' : 's'} ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.floor(h / 24); return `${d} day${d === 1 ? '' : 's'} ago`;
}

function fmtBytes(n) {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB']; let v = n / 1024, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${u[i]}`;
}

// A plain-identifier table name: schema.table (or bare table). Mirrors the server's validator so the
// UI rejects the same bad input up front instead of round-tripping to a 400.
const TABLE_RE = /^[A-Za-z_][A-Za-z0-9_$]*(\.[A-Za-z_][A-Za-z0-9_$]*)?$/;

// ── reusable table picker ─────────────────────────────────────────────────────
// value/onChange is an array of 'schema.table' strings. EMPTY ⇒ "everything" (whole database) — the
// default, shown prominently so a partial selection is never a surprise. `available` is the universe
// to tick (from a backup's TOC); a free-text add covers tables not in that list (or when there's no
// backup yet to enumerate).
function TableSelect({ available = [], value, onChange, allLabel = 'the whole database' }) {
  const [filter, setFilter] = useState('');
  const [entry, setEntry] = useState('');
  const sel = new Set(value);
  const universe = [...new Set([...(available || []), ...value])].sort();
  const shown = universe.filter((t) => t.toLowerCase().includes(filter.trim().toLowerCase()));
  const toggle = (t) => { const n = new Set(sel); n.has(t) ? n.delete(t) : n.add(t); onChange([...n].sort()); };
  const addEntry = () => {
    const t = entry.trim();
    if (!t) return;
    if (!TABLE_RE.test(t)) return;                 // ignore invalid — the input shows the rule
    if (!sel.has(t)) onChange([...value, t].sort());
    setEntry('');
  };
  const entryBad = entry.trim() && !TABLE_RE.test(entry.trim());

  return (
    <div className="tblsel" data-testid="table-select">
      <div className="tblsel-top">
        <span className={`tblsel-mode ${value.length ? 'scoped' : 'all'}`}>
          {value.length ? `${value.length} table(s) selected` : `all tables — ${allLabel}`}
        </span>
        {value.length > 0 && (
          <button type="button" className="bkbtn sm" onClick={() => onChange([])}
                  title="Clear the selection — back up / restore everything">Select all (clear)</button>
        )}
      </div>
      {universe.length > 8 && (
        <input className="tblsel-filter" value={filter} placeholder="filter tables…"
               onChange={(e) => setFilter(e.target.value)} spellCheck={false} />
      )}
      <div className="tblsel-list">
        {shown.length === 0 && (
          <div className="tblsel-empty dim">
            {universe.length === 0
              ? 'no table list yet — add tables below, or take a full backup first to enumerate them'
              : 'no tables match the filter'}
          </div>
        )}
        {shown.map((t) => (
          <label key={t} className="tblsel-row" title={t}>
            <input type="checkbox" checked={sel.has(t)} onChange={() => toggle(t)} />
            <span className="mono">{t}</span>
          </label>
        ))}
      </div>
      <div className="tblsel-add">
        <input value={entry} placeholder="add schema.table" spellCheck={false}
               className={entryBad ? 'bad' : ''}
               onChange={(e) => setEntry(e.target.value)}
               onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addEntry(); } }} />
        <button type="button" className="bkbtn sm" onClick={addEntry} disabled={!entry.trim() || entryBad}>Add</button>
        {entryBad && <span className="tblsel-warn">plain identifiers only (schema.table)</span>}
      </div>
    </div>
  );
}

// Is the newest SUCCESSFUL backup older than the policy that was configured for it? Pure, so the
// wording is testable. `graceRatio` tolerates the scheduler's own tick + a dump's duration — the
// signal is "a whole backup window has gone by", not "we are a minute late".
//
// This exists because "Last backup: (27 hours ago)" is not a reading a human can grade: whether that
// is fine or alarming depends on an interval that lives behind the ⚙, and a FAILED attempt in between
// (which backupDue counts as the window's attempt, delaying the next good dump by a full interval)
// left no mark here at all. TKT-22-4F0E asked whether production data is fully backed up; the honest
// half of that answer is freshness, and it was the one number this panel was not showing.
export function backupFreshness(backup, now = Date.now()) {
  const last = backup?.last;
  const interval = Number(backup?.config?.backup_interval_sec) || 0;
  const attempt = backup?.last_attempt || null;
  // The newest attempt failed and no success has happened since it — the operator must know, whether
  // or not the schedule has slipped yet.
  const failedSince = !!attempt && attempt.status === 'failed'
    && (!last || new Date(attempt.taken_at) > new Date(last.taken_at));
  if (!last) return { state: 'none', failedSince, attempt, ageSec: null, interval };
  const ageSec = Math.max(0, Math.floor((now - new Date(last.taken_at).getTime()) / 1000));
  const graceRatio = 1.25;
  const overdue = interval > 0 && ageSec > interval * graceRatio;
  return {
    state: overdue ? 'overdue' : 'ok', failedSince, attempt, ageSec, interval,
    missedWindows: interval > 0 ? Math.floor(ageSec / interval) : 0,
  };
}


// The row-count reading on a backup row. Says what the number IS (a per-table planner ESTIMATE from
// the SOURCE, taken beside the dump), what changed since the last backup, and — always — what it does
// not prove. A count is not a comparison of contents, and an estimate is not an audit; over-claiming
// here is the same mistake as reading schema drift as a data guarantee. TKT-22-4F0E.
export function rowsTitle(b) {
  const L = [`~${Number(b.row_total).toLocaleString()} estimated rows across ${b.row_tables ?? '?'} table(s), `
    + `read from the SOURCE database when this dump was taken.`];
  const t = b.row_trend;
  if (!t) {
    L.push('No earlier backup carries counts, so there is nothing to compare against yet — the next backup gets a trend.');
  } else {
    const when = t.compared_to ? new Date(t.compared_to).toLocaleString() : 'the previous backup';
    if (t.verdict === 'ok') {
      L.push(`Steady against ${when}: ~${Number(t.total_prev).toLocaleString()} → ~${Number(t.total_now).toLocaleString()} rows `
        + `(${t.counts.grew} grew, ${t.counts.steady} unchanged${t.counts.added ? `, ${t.counts.added} new table(s)` : ''}${t.counts.removed ? `, ${t.counts.removed} table(s) gone` : ''}).`);
    } else {
      L.push(`⚠ Against ${when}: ${t.counts.emptied} table(s) went EMPTY and ${t.counts.shrunk} SHRANK.`);
      for (const w of (t.worst || [])) L.push(`   ${w.table}: ~${Number(w.prev).toLocaleString()} → ${Number(w.now).toLocaleString()}`);
      L.push('An emptied table is the alarming shape; a small drop can be estimate noise. Worth a look either way.');
    }
  }
  L.push('These are planner ESTIMATES (reltuples), not an exact count — production is never counted row by row '
    + 'on a schedule. And a row COUNT is not a comparison of row CONTENTS.');
  return L.join('\n\n');
}

// WHAT HAPPENS NEXT, in words (#26). A failure now brings the next attempt FORWARD instead of consuming
// its window — and that is worth nothing if the panel shows a red mark next to silence and leaves a human
// wondering whether anything is going to happen. `backup.next` is the server's own decision
// (lib/backup-schedule.js), so this cannot drift from what the scheduler will actually do.
export function nextAttemptLine(backup) {
  const n = backup?.next;
  if (!n || backup?.running) return null;
  if (n.kind === 'running') return null;
  if (n.kind === 'retry') {
    return n.due ? 'retrying now' : `retry in ${Math.max(1, Math.ceil((n.waitSec || 0) / 60))} min`;
  }
  if (n.due) return 'backup due now';
  return null;                       // on schedule and not due — say nothing; silence is the good news
}

// ── the panel (sits above the container inventory) ────────────────────────────
export default function BackupsPanel({ backup, projectId }) {
  const [showList, setShowList] = useState(false);
  const [showCfg, setShowCfg] = useState(false);
  const last = backup?.last;
  const running = !!backup?.running;   // a backup job is in flight
  const fresh = backupFreshness(backup);
  const stale = !running && (fresh.state === 'overdue' || fresh.failedSince);
  const nextAttempt = nextAttemptLine(backup);

  return (
    <section className="backups" data-testid="backups-panel">
      <span className="bklabel">Last backup:</span>
      <button className={`bklast ${last ? '' : 'none'}${stale ? ' stale' : ''}`} onClick={() => setShowList(true)}
              title={last
                ? `The newest SUCCESSFUL dump of production. Policy: every ${Math.round(fresh.interval / 3600) || '?'}h.`
                  + (fresh.state === 'overdue'
                    ? `\n\n⚠ OVERDUE — ${fresh.missedWindows} backup window(s) have passed since it. Production `
                      + `itself is fine; what is old is your restore point.`
                    : '')
                  + (fresh.failedSince
                    ? `\n\n⚠ The most recent ATTEMPT (${stampFmt(fresh.attempt.taken_at)}) FAILED: `
                      + `${fresh.attempt.error || 'no reason recorded'}\nA failed attempt uses up its window, so the `
                      + `next good dump is a full interval away unless you run one now.`
                    : '')
                  + '\n\nThis is about the AGE of the backup. Whether a dump\'s CONTENTS are complete is a '
                  + 'separate question — open the list and read what each archive contains.'
                : 'Show all backups'}
              data-testid="last-backup">
        {last
          ? <><span className="mono">{stampFmt(last.taken_at)}</span>
              <span className="bkago">({ago(last.taken_at)})</span></>
          : <span className="bkago">no backups yet</span>}
      </button>
      {/* Loud where it is read, not buried in a log. Two distinct facts, so both are said. */}
      {!running && fresh.state === 'overdue' && (
        <span className="bkstale" data-testid="backup-overdue"
              title={`No successful backup for ${fresh.missedWindows} window(s) of the configured `
                + `${Math.round(fresh.interval / 3600) || '?'}h interval.`}>⚠ overdue</span>
      )}
      {!running && fresh.failedSince && (
        <span className="bkstale" data-testid="backup-last-failed"
              title={`The last attempt failed: ${fresh.attempt?.error || 'no reason recorded'}`}>
          ⚠ last attempt failed
        </span>
      )}
      {/* …and what the queenzee will DO about it. A failed attempt schedules a RETRY (10 min, doubling,
          capped at the policy interval) instead of waiting out the whole window — so the mark above is
          never the end of the sentence. #26. */}
      {nextAttempt && (
        <span className="bknext" data-testid="backup-next"
              title={backup?.next?.reason
                ? `${backup.next.reason}.\n\nA failed attempt shortens the next window instead of consuming it: `
                  + 'the retry interval starts at 10 minutes and doubles per consecutive failure, capped at '
                  + 'the policy interval — so it is always sooner than the schedule alone, and never a storm.'
                : 'when the next attempt is due'}>
          {nextAttempt}
        </span>
      )}
      {running && (
        <span className="bkrunning" data-testid="backup-running" title="A backup is running">
          <span className="cspin backup" />backing up…
        </span>
      )}
      {backup?.count > 0 && <span className="bkcount">{backup.count} stored</span>}
      <button className="bkcog" onClick={() => setShowCfg(true)}
              title="Backup settings" aria-label="Backup settings" data-testid="backup-cog">⚙</button>

      {showList && <BackupsModal projectId={projectId} onClose={() => setShowList(false)} />}
      {showCfg && <BackupSettings backup={backup} projectId={projectId} onClose={() => setShowCfg(false)} />}
    </section>
  );
}

// ── all backups, newest first. Jobs run async: a running backup shows a spinner row, and a
//    restoring target shows a spinner. Polls every 3s so in-flight jobs update to done. ─────
// initialTargetId — preselect a db container in the "restore into" picker. Passed when the modal
// is opened from a db container's context menu ("Load backup…"), so the backup you pick restores
// straight into THAT container rather than the default first target.
export function BackupsModal({ projectId, onClose, initialTargetId = '' }) {
  const [backups, setBackups] = useState(null);
  const [targets, setTargets] = useState([]);
  const [targetId, setTargetId] = useState(initialTargetId || '');
  const [picks, setPicks] = useState({});    // { [backupId]: ['schema.table', …] } — [] ⇒ whole dump
  const [openPick, setOpenPick] = useState(null);   // which backup row's table picker is expanded
  const [msg, setMsg] = useState('');
  const flash = (m) => { setMsg(m); setTimeout(() => setMsg(''), 2600); };

  const load = () => getBackups(projectId).then((d) => {
    setBackups(d.backups || []);
    setTargets(d.targets || []);
    // Prefer the caller's requested target, then whatever's already picked, then the first one.
    setTargetId((cur) => cur || initialTargetId || (d.targets?.[0]?.id ?? ''));
  }).catch(() => {});
  useEffect(() => {
    load();
    const t = setInterval(load, 3000);   // keep running backups / restoring targets fresh
    return () => clearInterval(t);
  }, [projectId]);   // eslint-disable-line react-hooks/exhaustive-deps

  const selTarget = targets.find((t) => t.id === targetId);
  const targetBusy = !!selTarget?.busy_since;                 // selected target mid-restore
  const backingUp = !!backups?.some((b) => b.status === 'running');

  const copy = async (p) => {
    try { await navigator.clipboard.writeText(p); flash('Path copied'); }
    catch { flash('Copy failed — select the path manually'); }
  };
  const reveal = async (id) => {
    try { await revealBackup(id); } catch (e) { flash(e.message || 'Open failed'); }
  };
  // async: fire the job, refresh to show its spinner, return immediately (poll finishes it)
  const backupNow = async () => {
    try { await runBackup(projectId); await load(); flash('Backup started'); }
    catch (e) { flash(e.message || 'Backup failed'); }
  };
  const restore = async (b) => {
    if (!selTarget) { flash('Pick a target db container first'); return; }
    const pick = picks[b.id] || [];                                // [] ⇒ restore the whole dump
    const scope = pick.length ? `only ${pick.length} selected table(s)` : 'the whole database';
    let confirmProd = false;
    if (selTarget.is_prod) {
      // Restoring over LIVE production is irreversible — make the human type the db name, not just
      // click OK. The typed name both proves intent and sets the confirm_prod flag the server needs.
      const typed = await showPrompt(
        `⚠ RESTORE OVER PRODUCTION\n\nThis OVERWRITES ${scope} in the LIVE production database "${selTarget.name}" with `
        + `this backup. It cannot be undone. Type the database name to confirm:`,
        { variant: 'danger', okLabel: 'Restore over prod', placeholder: selTarget.name });
      if (typed == null) return;                                   // cancelled
      if (typed.trim() !== selTarget.name) { flash('Name did not match — restore cancelled'); return; }
      confirmProd = true;
    } else if (!(await showConfirm(`Restore ${scope} into ${selTarget.name}?\n\nThis OVERWRITES ${pick.length ? 'those tables in ' : ''}that database. `
      + `The container spins and can't be built until it finishes.`, { variant: 'danger', okLabel: 'Restore' }))) {
      return;
    }
    try { await restoreBackup(b.id, targetId, confirmProd, pick.length ? pick : null); await load(); flash(`Restore started → ${selTarget.name}`); }
    catch (e) { flash(e.message || 'Restore failed'); }
  };
  const del = async (b) => {
    if (!(await showConfirm(`Delete this backup?\n\n${stampFmt(b.taken_at)}\n\n`
      + `This removes the dump file and its record. It cannot be undone.`,
      { variant: 'danger', okLabel: 'Delete' }))) return;
    try { await deleteBackup(b.id); await load(); flash('Backup deleted'); }
    catch (e) { flash(e.message || 'Delete failed'); }
  };

  return (
    <div className="term-overlay" onClick={onClose}>
      <div className="bkmodal" onClick={(e) => e.stopPropagation()}>
        <div className="term-head">
          <span className="term-title">▚ production backups{backups ? ` (${backups.length})` : ''}</span>
          <div className="bkhead-actions">
            {msg && <span className="bkmsg">{msg}</span>}
            {targets.length > 0 && (
              <label className={`bkrestore-into ${selTarget?.is_prod ? 'prod' : ''}`}
                     title="Restoring a backup writes it into this db container. Choosing PRODUCTION overwrites live prod — it asks you to type the db name to confirm.">
                restore into
                <select value={targetId} onChange={(e) => setTargetId(e.target.value)} data-testid="restore-target">
                  {targets.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}{t.is_prod ? ' ⚠ PRODUCTION' : ''}{t.busy_since ? ' (busy)' : ''}
                    </option>
                  ))}
                </select>
                {selTarget?.is_prod && (
                  <span className="bkprod-warn" title="This target is LIVE production — a restore overwrites it">⚠ live prod</span>
                )}
                {targetBusy && <span className="bkrestoring"><span className="cspin restore" />restoring…</span>}
              </label>
            )}
            <button className="bkbtn" onClick={backupNow} disabled={backingUp}>
              {backingUp ? <><span className="cspin backup" />backing up…</> : '＋ Back up now'}
            </button>
            <button className="term-x" onClick={onClose} title="Close">✕</button>
          </div>
        </div>
        <div className="bkbody">
          {!backups && <div className="term-line dim">loading…</div>}
          {backups && backups.length === 0 && <div className="term-line dim">no backups yet</div>}
          {backups && backups.map((b) => (
            <div className={`bkrow ${b.status || 'finished'} ${b.mode === 'simulate' ? 'sim' : ''}`} key={b.id} data-testid="backup-row" data-status={b.status}>
              <span className="bkstamp mono">{stampFmt(b.taken_at)}</span>
              <span className="bkago2">{ago(b.taken_at)}</span>
              {b.status === 'running' ? (
                <span className="bkjob" data-testid="backup-row-running"><span className="cspin backup" />backing up…</span>
              ) : b.status === 'failed' ? (
                <>
                  <span className="bkjob failed" title={b.error || 'backup failed'}>✕ failed</span>
                  <span className="bkacts">
                    <button className="bkbtn sm danger" onClick={() => del(b)}
                            title="Delete this failed backup (removes any partial file and its record)">Delete</button>
                  </span>
                </>
              ) : (
                <>
                  <span className="bksize">{fmtBytes(b.size_bytes)}</span>
                  {b.mode === 'simulate' && (
                    <span className="bksim" data-testid="backup-simulated"
                          title="SIMULATED backup — a placeholder written by the queenzee, NOT a dump of the real database. It cannot be restored.">
                      simulated
                    </span>
                  )}
                  {b.dest_ctx && <span className="bkdest" title={`on docker context ${b.dest_ctx}`}>{b.dest_ctx}</span>}
                  {/* WHAT THIS DUMP CONTAINS, and what was actually checked (TKT-22-4F0E). "is my data
                      backed up?" is asked HERE, and the row used to answer with bytes and a path only
                      — while the archive's own table list was already recorded and unread. State the
                      guarantee AND its limit: the TOC is proof the tables are in the archive; nobody
                      counted a row, so this is not a row-level completeness certificate. */}
                  {/* WHAT IS IN IT, IN ROWS — the reading the ticket was actually asking for, and the
                      one this panel could not give: a per-table row estimate taken from the source next
                      to the dump. Plus the TREND against the previous backup, because a table that
                      SHRANK between two dumps is what "my data is not fully backed up" actually looks
                      like, and nothing here would ever have noticed it. TKT-22-4F0E. */}
                  {b.row_total != null && (
                    <span className={`bkrows${b.row_trend && b.row_trend.verdict !== 'ok' ? ' warn' : ''}`}
                          data-testid="backup-rows"
                          title={rowsTitle(b)}>
                      {b.row_trend && b.row_trend.verdict !== 'ok' ? '⚠ ' : ''}~{Number(b.row_total).toLocaleString()} rows
                    </span>
                  )}
                  {Array.isArray(b.toc_tables) && b.toc_tables.length > 0 && (
                    <span className="bktoc" data-testid="backup-toc"
                          title={`This archive contains ${b.toc_tables.length} table(s) — read back out of the dump `
                            + `itself with pg_restore --list after it was written, and checked against the previous `
                            + `good backup (no lost schemas, no size collapse).\n\nVERIFIED: the archive is a valid `
                            + `pg_dump, and these tables are in it.\nNOT VERIFIED: row counts. A dump's TOC lists `
                            + `tables, not rows — so this is not a row-by-row completeness check of production.\n\n`
                            + b.toc_tables.slice(0, 40).join(', ')
                            + (b.toc_tables.length > 40 ? `, … +${b.toc_tables.length - 40} more` : '')}>
                      {b.toc_tables.length} tables in archive
                    </span>
                  )}
                  {Array.isArray(b.tables) && <span className="bkscoped" title={`this backup captured only: ${b.tables.join(', ')}`}>scoped · {b.tables.length} table(s)</span>}
                  <span className="bkpath mono" title={b.dump_path}>{b.dump_path}</span>
                  <span className="bkacts">
                    <button className="bkbtn sm" onClick={() => copy(b.dump_path)}>Copy path</button>
                    <button className="bkbtn sm" onClick={() => reveal(b.id)}>Open in Explorer</button>
                    {b.mode !== 'simulate' && (
                      <button className={`bkbtn sm ${(picks[b.id]?.length) ? 'active' : ''}`} data-testid="restore-tables-toggle"
                              onClick={() => setOpenPick((o) => (o === b.id ? null : b.id))}
                              title="Choose which tables to restore out of this backup (default: all)">
                        Tables: {picks[b.id]?.length ? `${picks[b.id].length}` : 'all'} ▾
                      </button>
                    )}
                    <button className="bkbtn sm" onClick={() => restore(b)}
                            disabled={!targets.length || targetBusy || b.mode === 'simulate'}
                            title={b.mode === 'simulate' ? 'a simulated backup is a placeholder, not real data — it cannot be restored'
                              : !targets.length ? 'no restore target available'
                              : targetBusy ? 'target is busy — wait for the current restore'
                              : 'Restore this backup into the selected db container'}>
                      Restore
                    </button>
                    <button className="bkbtn sm danger" onClick={() => del(b)}
                            title="Delete this backup (removes the dump file and its record)">Delete</button>
                  </span>
                </>
              )}
              {openPick === b.id && b.status !== 'running' && b.status !== 'failed' && (
                <div className="bkrow-pick">
                  <TableSelect available={b.toc_tables || b.tables || []} value={picks[b.id] || []}
                               onChange={(v) => setPicks((p) => ({ ...p, [b.id]: v }))}
                               allLabel="everything in this dump" />
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── settings (folder / interval / retention) ─────────────────────────────────
const UNITS = [['minutes', 60], ['hours', 3600], ['days', 86400]];

function splitInterval(sec) {
  for (const [label, mult] of [...UNITS].reverse()) {
    if (sec >= mult && sec % mult === 0) return { value: sec / mult, unit: label };
  }
  return { value: Math.max(1, Math.round((sec || 60) / 60)), unit: 'minutes' };
}

function BackupSettings({ backup, projectId, onClose }) {
  const cfg = backup?.config || {};
  const init = splitInterval(cfg.backup_interval_sec ?? 86400);
  const [dir, setDir] = useState(cfg.backup_dir || '');
  const [ctx, setCtx] = useState(cfg.backup_ctx || '');
  const [ival, setIval] = useState(init.value);
  const [unit, setUnit] = useState(init.unit);
  const [maxB, setMaxB] = useState(cfg.max_backups ?? 14);
  const [tables, setTables] = useState(Array.isArray(cfg.backup_tables) ? cfg.backup_tables : []);
  const [universe, setUniverse] = useState([]);   // tables to tick, from the most recent full backup
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);

  // Enumerate tables from the newest backup that recorded a TOC, so the operator ticks real names.
  useEffect(() => {
    getBackups(projectId).then((d) => {
      const withToc = (d.backups || []).find((b) => Array.isArray(b.toc_tables) && b.toc_tables.length);
      if (withToc) setUniverse(withToc.toc_tables);
    }).catch(() => {});
  }, [projectId]);

  const save = async () => {
    setSaving(true); setErr('');
    const mult = UNITS.find(([l]) => l === unit)[1];
    try {
      await setBackupConfig({
        project: projectId,
        backup_dir: dir.trim() || null,
        backup_ctx: ctx.trim() || null,
        backup_interval_sec: Math.round(Number(ival) * mult),
        max_backups: Number(maxB),
        backup_tables: tables.length ? tables : null,
      });
      onClose();
    } catch (e) { setErr(e.message); setSaving(false); }
  };

  return (
    <div className="term-overlay" onClick={onClose}>
      <div className="bkcfg" onClick={(e) => e.stopPropagation()}>
        <div className="term-head">
          <span className="term-title">⚙ backup settings</span>
          <button className="term-x" onClick={onClose} title="Close">✕</button>
        </div>
        <div className="bkcfg-body">
          <label>Destination (docker context)
            <input value={ctx} placeholder="(blank: this host — e.g. ugreen-nas for the NAS)"
                   onChange={(e) => setCtx(e.target.value)} spellCheck={false} data-testid="backup-ctx" />
            <span className="bkhint">a docker context whose host owns the location below (no SMB
              credentials needed). Blank = write to this host. Verified reachable on Save — an
              unreachable context is refused, never silently written locally.</span>
          </label>
          <label>Backup location
            <input value={dir} placeholder="(default: <repo>/db_backups)"
                   onChange={(e) => setDir(e.target.value)} spellCheck={false} />
            <span className="bkhint">a directory ON the destination host
              (e.g. /volume3/maki/Backups/Omnibiz/db)</span>
          </label>
          <label>Backup interval
            <span className="bkival">
              <input type="number" min="1" value={ival} onChange={(e) => setIval(e.target.value)} />
              <select value={unit} onChange={(e) => setUnit(e.target.value)}>
                {UNITS.map(([l]) => <option key={l} value={l}>{l}</option>)}
              </select>
            </span>
          </label>
          <label>Max backups kept
            <input type="number" min="1" max="1000" value={maxB} onChange={(e) => setMaxB(e.target.value)} />
            <span className="bkhint">older backups beyond this are deleted by housekeeping</span>
          </label>
          <label>Tables to back up
            <TableSelect available={universe} value={tables} onChange={setTables} allLabel="the whole database" />
            <span className="bkhint">applies to scheduled AND manual backups. Leave empty to dump the
              whole database (the default). A scoped selection dumps ONLY these tables — smaller, faster,
              but a partial restore of it can't reconstruct the tables you left out.</span>
          </label>
          {err && <div className="bkerr">{err}</div>}
        </div>
        <div className="bkcfg-btns">
          <button className="ghost" onClick={onClose}>Cancel</button>
          <button onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </div>
  );
}
