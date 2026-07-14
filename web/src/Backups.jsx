import React, { useEffect, useState } from 'react';
import { getBackups, setBackupConfig, runBackup, revealBackup, restoreBackup } from './api.js';

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

// ── the panel (sits above the container inventory) ────────────────────────────
export default function BackupsPanel({ backup, projectId }) {
  const [showList, setShowList] = useState(false);
  const [showCfg, setShowCfg] = useState(false);
  const last = backup?.last;
  const running = !!backup?.running;   // a backup job is in flight

  return (
    <section className="backups" data-testid="backups-panel">
      <span className="bklabel">Last backup:</span>
      <button className={`bklast ${last ? '' : 'none'}`} onClick={() => setShowList(true)}
              title="Show all backups" data-testid="last-backup">
        {last
          ? <><span className="mono">{stampFmt(last.taken_at)}</span>
              <span className="bkago">({ago(last.taken_at)})</span></>
          : <span className="bkago">no backups yet</span>}
      </button>
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
function BackupsModal({ projectId, onClose }) {
  const [backups, setBackups] = useState(null);
  const [targets, setTargets] = useState([]);
  const [targetId, setTargetId] = useState('');
  const [msg, setMsg] = useState('');
  const flash = (m) => { setMsg(m); setTimeout(() => setMsg(''), 2600); };

  const load = () => getBackups(projectId).then((d) => {
    setBackups(d.backups || []);
    setTargets(d.targets || []);
    setTargetId((cur) => cur || (d.targets?.[0]?.id ?? ''));
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
    if (!window.confirm(`Restore this backup into ${selTarget.name}?\n\nThis OVERWRITES that database. `
      + `The container spins and can't be built until it finishes.`)) return;
    try { await restoreBackup(b.id, targetId); await load(); flash(`Restore started → ${selTarget.name}`); }
    catch (e) { flash(e.message || 'Restore failed'); }
  };

  return (
    <div className="term-overlay" onClick={onClose}>
      <div className="bkmodal" onClick={(e) => e.stopPropagation()}>
        <div className="term-head">
          <span className="term-title">▚ production backups{backups ? ` (${backups.length})` : ''}</span>
          <div className="bkhead-actions">
            {msg && <span className="bkmsg">{msg}</span>}
            {targets.length > 0 && (
              <label className="bkrestore-into" title="Restoring a backup writes it into this db container (prod is never a target)">
                restore into
                <select value={targetId} onChange={(e) => setTargetId(e.target.value)}>
                  {targets.map((t) => <option key={t.id} value={t.id}>{t.name}{t.busy_since ? ' (busy)' : ''}</option>)}
                </select>
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
            <div className={`bkrow ${b.status || 'finished'}`} key={b.id} data-testid="backup-row" data-status={b.status}>
              <span className="bkstamp mono">{stampFmt(b.taken_at)}</span>
              <span className="bkago2">{ago(b.taken_at)}</span>
              {b.status === 'running' ? (
                <span className="bkjob" data-testid="backup-row-running"><span className="cspin backup" />backing up…</span>
              ) : b.status === 'failed' ? (
                <span className="bkjob failed" title={b.error || 'backup failed'}>✕ failed</span>
              ) : (
                <>
                  <span className="bksize">{fmtBytes(b.size_bytes)}</span>
                  <span className="bkpath mono" title={b.dump_path}>{b.dump_path}</span>
                  <span className="bkacts">
                    <button className="bkbtn sm" onClick={() => copy(b.dump_path)}>Copy path</button>
                    <button className="bkbtn sm" onClick={() => reveal(b.id)}>Open in Explorer</button>
                    <button className="bkbtn sm" onClick={() => restore(b)}
                            disabled={!targets.length || targetBusy}
                            title={!targets.length ? 'no restore target available'
                              : targetBusy ? 'target is busy — wait for the current restore'
                              : 'Restore this backup into the selected db container'}>
                      Restore
                    </button>
                  </span>
                </>
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
  const [ival, setIval] = useState(init.value);
  const [unit, setUnit] = useState(init.unit);
  const [maxB, setMaxB] = useState(cfg.max_backups ?? 14);
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true); setErr('');
    const mult = UNITS.find(([l]) => l === unit)[1];
    try {
      await setBackupConfig({
        project: projectId,
        backup_dir: dir.trim() || null,
        backup_interval_sec: Math.round(Number(ival) * mult),
        max_backups: Number(maxB),
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
          <label>Backup location
            <input value={dir} placeholder="(default: <repo>/db_backups)"
                   onChange={(e) => setDir(e.target.value)} spellCheck={false} />
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
