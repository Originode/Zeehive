import React, { useEffect, useState, useCallback } from 'react';
import { listCxellDir, readCxellFile } from './api.js';

// The file-explorer panel that expands beside a zee terminal. Read-only: it lists the zee's
// worktree over the same ssh door the terminal uses, and opens a text file in a viewer so a human
// can SEE what a zee is talking about ("edited web/src/App.jsx") without leaving the terminal.
//
// `openPath` is a controlled request from the terminal's right-click "show file" — when it changes
// the explorer navigates to (a dir) or opens (a file) that path. It reports the current directory
// up via onDir so the parent can seed "show file" with the right folder.

const ICON = { dir: '▸', file: '·' };
const fmtSize = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} K` : `${(n / 1048576).toFixed(1)} M`);
const baseName = (p) => (p || '').replace(/\/+$/, '').split('/').pop() || '/';

export default function FileExplorer({ zeeId, openPath, onClose }) {
  const [dir, setDir] = useState(null);          // { path, parent, root, entries }
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [file, setFile] = useState(null);        // open file viewer: { path, content, size, binary, truncated }
  const [fileErr, setFileErr] = useState(null);

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

  useEffect(() => { load(null); }, [load]);

  // A "show file" request from the terminal: figure out whether it's a dir or file by trying to
  // list it; if that fails, treat it as a file and open the viewer.
  useEffect(() => {
    if (!openPath) return;
    let cancelled = false;
    (async () => {
      try { const d = await listCxellDir(zeeId, openPath); if (!cancelled) { setDir(d); setFile(null); } }
      catch { if (!cancelled) openFile(openPath); }
    })();
    return () => { cancelled = true; };
  }, [openPath, zeeId, openFile]);

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
