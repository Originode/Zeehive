import React, { useEffect, useMemo, useRef, useState } from 'react';
import { getXellPatch, getLandPatch } from './api.js';

// ── THE DIFF VIEWER — click a diffstat, read the diff ───────────────────────────────────────────
//
// Every diffstat in this console ("4f +182/−31") is a summary of a decision: approve this landing,
// mark this xell done, ship this work. Until now the numbers were where the trail ended — the
// actual change lived in a terminal on the host, which the person clicking Approve does not have.
// So a human either approved on trust or went hunting. This component closes that: the same three
// numbers are now a BUTTON, and it opens the lines they were counting.
//
// It is mounted ONCE at the root (DiffViewerHost, like DialogHost) and driven by a singleton
// store, so any card anywhere — a xell card, a held landing, a PR, a canvas hexagon petal — can
// call showDiff(...) without prop-drilling a viewer through half the app.
//
//   showDiff({ kind: 'xell', xellId, diffKind: 'source'|'own', title, subtitle })
//   showDiff({ kind: 'land', landId, title, subtitle })
//
// Read-only, always: it renders a patch the server read. Nothing here can change what lands.

let _current = null;
const _listeners = new Set();
const _emit = () => { for (const fn of _listeners) fn(_current); };

export function showDiff(target) {
  _current = { ...target, seq: (_current?.seq || 0) + 1 };
  _emit();
}
export function closeDiff() { _current = null; _emit(); }

// ── unified-diff → rows ─────────────────────────────────────────────────────────────────────────
// The server hands back one patch per file (the same text git prints). Turning it into numbered
// rows is the client's job because it is purely presentational — and it keeps the payload the
// size of a diff, not the size of a diff exploded into JSON objects.
export function parsePatch(patch) {
  const rows = [];
  const lines = String(patch || '').split('\n');
  let oldLn = 0, newLn = 0, started = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith('@@')) {
      const m = l.match(/^@@+ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@+(.*)$/);
      oldLn = m ? +m[1] : 0;
      newLn = m ? +m[2] : 0;
      rows.push({ t: 'hunk', text: l });
      started = true;
      continue;
    }
    if (!started) {
      // Pre-hunk header lines worth showing: git's own "Binary files … differ" verdict.
      if (l.startsWith('Binary files') || l.startsWith('GIT binary patch')) rows.push({ t: 'meta', text: l });
      continue;
    }
    if (i === lines.length - 1 && l === '') continue;          // trailing newline, not a line
    if (l.startsWith('\\')) { rows.push({ t: 'meta', text: l }); continue; }   // "\ No newline at eof"
    const c = l[0];
    if (c === '+') rows.push({ t: 'add', text: l.slice(1), n: newLn++ });
    else if (c === '-') rows.push({ t: 'del', text: l.slice(1), o: oldLn++ });
    else rows.push({ t: 'ctx', text: l.slice(1), o: oldLn++, n: newLn++ });
  }
  return rows;
}

// A very large file's patch is rendered in slices: React can mount 100k rows, but it takes seconds
// and the scroll never recovers. Show the first slice and let the reader ask for the rest.
const ROW_SLICE = 1200;

const STATUS_LABEL = {
  added: 'added', deleted: 'deleted', modified: 'modified', renamed: 'renamed',
  copied: 'copied', binary: 'binary', untracked: 'untracked',
};

function FileBlock({ f, open, onToggle, wrap, refCb }) {
  const [limit, setLimit] = useState(ROW_SLICE);
  const rows = useMemo(() => (open ? parsePatch(f.patch) : []), [f.patch, open]);
  const shown = rows.slice(0, limit);
  return (
    <div className="dv-file" ref={refCb} data-testid="diff-file">
      <button className="dv-file-head" onClick={onToggle} aria-expanded={open}
              title={f.old_path ? `${f.old_path} → ${f.path}` : f.path}>
        <span className="dv-caret">{open ? '▾' : '▸'}</span>
        <span className={`dv-status s-${f.status}`}>{STATUS_LABEL[f.status] || f.status}</span>
        <span className="dv-path">
          {f.old_path && <span className="dv-oldpath">{f.old_path} → </span>}
          {f.path}
        </span>
        <span className="dv-nums">
          <span className="ins">+{f.insertions}</span>/<span className="del">−{f.deletions}</span>
        </span>
      </button>
      {open && (
        <div className={`dv-body${wrap ? ' wrap' : ''}`}>
          {f.binary && <div className="dv-note">binary file — no text diff</div>}
          {!rows.length && !f.binary && <div className="dv-note">no textual change (mode or rename only)</div>}
          {shown.map((r, i) => (
            <div key={i} className={`dv-row r-${r.t}`}>
              <span className="dv-ln">{r.o ?? ''}</span>
              <span className="dv-ln">{r.n ?? ''}</span>
              <span className="dv-sign">{r.t === 'add' ? '+' : r.t === 'del' ? '−' : r.t === 'hunk' ? '@' : ' '}</span>
              <span className="dv-code">{r.t === 'hunk' || r.t === 'meta' ? r.text : (r.text || ' ')}</span>
            </div>
          ))}
          {rows.length > shown.length && (
            <button className="dv-more" onClick={() => setLimit((n) => n + ROW_SLICE * 4)}>
              show {Math.min(ROW_SLICE * 4, rows.length - shown.length)} more of {rows.length - shown.length} remaining lines
            </button>
          )}
          {f.truncated && <div className="dv-note warn">⚠ this file's patch was truncated by the server (too large to send whole)</div>}
        </div>
      )}
    </div>
  );
}

function Viewer({ target, onClose }) {
  const [state, setState] = useState({ loading: true });
  const [closed, setClosed] = useState(() => new Set());
  const [wrap, setWrap] = useState(false);
  const [filter, setFilter] = useState('');
  const fileRefs = useRef({});

  // Load whenever the TARGET changes (seq bumps even when re-opening the same thing, so a second
  // click always refetches — a diff is live data, and a stale patch under an Approve button is
  // exactly the thing this component exists to prevent).
  useEffect(() => {
    let dead = false;
    setState({ loading: true });
    const p = target.kind === 'land'
      ? getLandPatch(target.landId)
      : getXellPatch(target.xellId, target.diffKind || 'source');
    p.then((d) => { if (!dead) setState({ loading: false, data: d }); })
     .catch((e) => { if (!dead) setState({ loading: false, error: e?.message || String(e) }); });
    return () => { dead = true; };
  }, [target.seq]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const data = state.data;
  const files = data?.files || [];
  const q = filter.trim().toLowerCase();
  const visible = q ? files.filter((f) => f.path.toLowerCase().includes(q)) : files;
  const stat = data?.stat || { files: 0, insertions: 0, deletions: 0 };

  const jump = (path) => {
    setClosed((s) => { const n = new Set(s); n.delete(path); return n; });
    requestAnimationFrame(() => fileRefs.current[path]?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
  };

  return (
    <div className="dv-overlay" data-testid="diff-overlay"
         onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dv" role="dialog" aria-modal="true" aria-label="diff viewer">
        <div className="dv-head">
          <span className="dv-title" data-testid="diff-title">{target.title || 'diff'}</span>
          {(target.subtitle || data?.label) && (
            <span className="dv-sub">{target.subtitle || data.label}</span>
          )}
          <span className="dv-spacer" />
          {data?.ok && (
            <span className="dv-stat" data-testid="diff-stat">
              {stat.files} file{stat.files === 1 ? '' : 's'} · <span className="ins">+{stat.insertions}</span>/<span className="del">−{stat.deletions}</span>
            </span>
          )}
          <button className="dv-toggle" onClick={() => setWrap((v) => !v)}
                  title="Wrap long lines">{wrap ? '⤶ wrap on' : '⤶ wrap off'}</button>
          <button className="dv-toggle" title="Collapse every file"
                  onClick={() => setClosed(new Set(files.map((f) => f.path)))}>collapse all</button>
          <button className="dv-toggle" title="Expand every file"
                  onClick={() => setClosed(new Set())}>expand all</button>
          <button className="dv-x" onClick={onClose} title="Close (Esc)">✕</button>
        </div>

        {(data?.base || data?.head || data?.source) && (
          <div className="dv-meta" data-testid="diff-meta">
            {data.source === 'cxell' ? 'read from inside the cxell'
              : data.source === 'worktree' ? 'read from the xell worktree'
              : 'read from the xource'}
            {data.base && <> · <code>{String(data.base).slice(0, 10)}</code></>}
            {data.head && <> → <code>{String(data.head).slice(0, 10)}</code></>}
            {data.note && <span className="dv-note-inline"> · {data.note}</span>}
          </div>
        )}

        {state.loading && <div className="dv-empty">reading the diff…</div>}
        {state.error && <div className="dv-empty err">could not read the diff: {state.error}</div>}
        {data && data.ok === false && (
          <div className="dv-empty err" data-testid="diff-error">could not read the diff: {data.error}</div>
        )}
        {data?.ok && !files.length && (
          <div className="dv-empty" data-testid="diff-empty">
            no changes — nothing differs{data.note ? ` (${data.note})` : ''}
          </div>
        )}

        {data?.ok && files.length > 0 && (
          <div className="dv-split">
            <div className="dv-rail">
              <input className="dv-filter" placeholder="filter files…" value={filter}
                     onChange={(e) => setFilter(e.target.value)} />
              {visible.map((f) => (
                <button key={f.path} className="dv-railitem" onClick={() => jump(f.path)} title={f.path}>
                  <span className={`dv-dot s-${f.status}`} />
                  <span className="dv-railpath">{f.path}</span>
                  <span className="dv-railnums">
                    <span className="ins">+{f.insertions}</span> <span className="del">−{f.deletions}</span>
                  </span>
                </button>
              ))}
              {!visible.length && <div className="dv-note">no file matches “{filter}”</div>}
            </div>
            <div className="dv-files">
              {visible.map((f) => (
                <FileBlock key={f.path} f={f} wrap={wrap} open={!closed.has(f.path)}
                           refCb={(el) => { fileRefs.current[f.path] = el; }}
                           onToggle={() => setClosed((s) => {
                             const n = new Set(s);
                             if (n.has(f.path)) n.delete(f.path); else n.add(f.path);
                             return n;
                           })} />
              ))}
              {data.truncated && (
                <div className="dv-note warn" data-testid="diff-truncated">
                  ⚠ this diff is larger than the viewer carries — {data.files_total} file(s) changed,
                  {' '}{files.length} shown. Read the rest in the worktree.
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// Mount ONCE (see main.jsx). Same singleton pattern as DialogHost: any module can open the viewer.
export function DiffViewerHost() {
  const [target, setTarget] = useState(_current);
  useEffect(() => {
    _listeners.add(setTarget);
    return () => { _listeners.delete(setTarget); };
  }, []);
  if (!target) return null;
  return <Viewer target={target} onClose={closeDiff} />;
}

export default DiffViewerHost;
