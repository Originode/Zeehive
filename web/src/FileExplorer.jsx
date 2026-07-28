import React, { useEffect, useState, useCallback } from 'react';
import { listCxellDir, readCxellFile } from './api.js';

// The file-explorer panel that expands beside a zee terminal. Read-only: it lists the zee's
// worktree over the same ssh door the terminal uses, and opens a text file in a viewer so a human
// can SEE what a zee is talking about ("edited web/src/App.jsx") without leaving the terminal.
//
// `openReq` ({ path, n }) is a "show file" request from the terminal — a CLICKED path link in the
// output, the 📁 button with a path selected, or the path box below. On each new request the explorer navigates to (a
// dir) or opens (a file) that path; the bumping `n` lets a repeat request on the same path re-open.

const ICON = { dir: '▸', file: '·' };
const fmtSize = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} K` : `${(n / 1048576).toFixed(1)} M`);
const baseName = (p) => (p || '').replace(/\/+$/, '').split('/').pop() || '/';

export default function FileExplorer({ zeeId, openReq, onClose }) {
  const [dir, setDir] = useState(null);          // { path, parent, root, entries }
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [file, setFile] = useState(null);        // open file viewer: { path, content, size, binary, truncated }
  const [fileErr, setFileErr] = useState(null);
  const [go, setGo] = useState('');              // the "show file" path box — paste a path a zee named

  const load = useCallback(async (path) => {
    setLoading(true); setError(null);
    try { setDir(await listCxellDir(zeeId, path)); }
    catch (e) { setError(e.message || String(e)); }
    finally { setLoading(false); }
  }, [zeeId]);

  const openFile = useCallback(async (path) => {
    setFile({ path, content: null }); setFileErr(null);
    try { setFile(await readCxellFile(zeeId, path)); }
    catch (e) { setFileErr(e.message || String(e)); setFile({ path, content: '' }); }
  }, [zeeId]);

  // Show a path a zee named: a dir → navigate into it, anything else → open it in the viewer.
  const show = useCallback(async (path) => {
    if (!path) return;
    try { const d = await listCxellDir(zeeId, path); setDir(d); setFile(null); }
    catch { openFile(path); }
  }, [zeeId, openFile]);

  useEffect(() => { load(null); }, [load]);

  // A "show file" request from the terminal (a clicked path link, or 📁 with a path selected) flows in via
  // openReq. The bumping openReq.n makes a repeat click on the same path re-open it.
  useEffect(() => { if (openReq?.path) show(openReq.path); }, [openReq, show]);

  const onEntry = (e) => {
    const next = `${dir.path === '/' ? '' : dir.path}/${e.name}`;
    if (e.type === 'dir') { setFile(null); load(next); }
    else openFile(next);
  };

  return (
    <div className="fx" data-testid="file-explorer">
      <div className="fx-head">
        <span className="fx-title">📁 files</span>
        <button className="fx-x" title="Close explorer" onClick={onClose}>✕</button>
      </div>
      <div className="fx-path" title={dir?.path || ''}>
        <button className="fx-crumb" disabled={!dir || dir.path === (dir.root || '/')}
                onClick={() => load(dir?.root || '/')} title="Go to worktree root">⌂</button>
        <button className="fx-crumb" disabled={!dir?.parent}
                onClick={() => { setFile(null); load(dir.parent); }} title="Up one level">↑</button>
        <span className="fx-cwd">{dir ? dir.path : '…'}</span>
        <button className="fx-crumb" onClick={() => load(dir?.path)} title="Refresh">⟳</button>
      </div>
      {/* Paste a path a zee named in the terminal and open it directly — the reliable, no-selection
          way to "show a file the zee presented". */}
      <form className="fx-go" onSubmit={(e) => { e.preventDefault(); show(go.trim()); }}>
        <input className="fx-goin" value={go} onChange={(e) => setGo(e.target.value)}
               placeholder="show file — paste a path…" spellCheck={false} />
        <button className="fx-crumb" type="submit" disabled={!go.trim()} title="Show this file">→</button>
      </form>

      {file ? (
        <div className="fx-file">
          <div className="fx-fhead">
            <span className="fx-fname" title={file.path}>{baseName(file.path)}</span>
            <span className="fx-fmeta">{fmtSize(file.size || 0)}{file.truncated ? ' · truncated' : ''}</span>
            <button className="fx-crumb" title="Back to folder" onClick={() => setFile(null)}>← back</button>
          </div>
          {fileErr ? <div className="fx-err">{fileErr}</div>
            : file.binary ? <div className="fx-empty">binary file — not shown</div>
            : file.content == null ? <div className="fx-empty">loading…</div>
            : <pre className="fx-code">{file.content}</pre>}
        </div>
      ) : (
        <div className="fx-list">
          {loading && <div className="fx-empty">loading…</div>}
          {error && <div className="fx-err">{error}</div>}
          {!loading && !error && dir?.entries.length === 0 && <div className="fx-empty">(empty)</div>}
          {!loading && !error && dir?.entries.map((e) => (
            <button key={e.name} className={`fx-row fx-${e.type}`} onClick={() => onEntry(e)}
                    title={e.name}>
              <span className="fx-ic">{ICON[e.type]}</span>
              <span className="fx-nm">{e.name}</span>
              {e.type === 'file' && <span className="fx-sz">{fmtSize(e.size)}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
