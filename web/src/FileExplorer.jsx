import React, { useEffect, useState, useCallback } from 'react';
import { listCxellDir, readCxellFile, listContainerDir, readContainerFile } from './api.js';
import { showFileViewer } from './FileViewer.jsx';

// The file-explorer panel that expands beside a terminal. Read-only: it lists the target's
// filesystem and opens a file in the FILE VIEWER (a separate routed modal) so a human can SEE
// what is being talked about ("edited web/src/App.jsx", a config a container is mis-reading)
// without leaving the terminal. Opening a file keeps the SIDEBAR on the folder the file lives
// in — the directory listing is the explorer's job; the file's content belongs to the viewer
// (web/src/FileViewer.jsx), which routes by type (a .md renders as markdown, a .diff as a diff).
//
// Two doors, same panel: `zeeId` browses a cxell zee's worktree over the ssh door; `container`
// browses a fleet container's filesystem over short-lived docker execs. Exactly one is set.
//
// `openReq` ({ path, n }) is a "show file" request from the terminal — a CLICKED path link in the
// output, the 📁 button with a path selected, or the path box below. On each new request the explorer navigates to (a
// dir) or opens (a file) that path; the bumping `n` lets a repeat request on the same path re-open.

const ICON = { dir: '▸', file: '·' };
const fmtSize = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} K` : `${(n / 1048576).toFixed(1)} M`);

// A file path → the folder that contains it, for showing WHERE the file lives in the sidebar.
// Handles absolute (/work/repo/web/src/App.jsx → /work/repo/web/src) and relative
// (web/src/App.jsx → web/src) paths; a bare filename (package.json) has no folder → the root ('').
const parentDir = (p) => {
  const s = String(p || '').trim();
  const i = s.lastIndexOf('/');
  if (i <= 0) return '';          // bare filename or a root-level path → the explorer root
  return s.slice(0, i);
};

export default function FileExplorer({ zeeId, container, openReq, onClose }) {
  const [dir, setDir] = useState(null);          // { path, parent, root, entries }
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [go, setGo] = useState('');              // the "show file" path box — paste a path named in the terminal

  // Both doors answer the same two verbs; the target decides which bridge to ask.
  const list = useCallback(async (path) => {
    if (container) return listContainerDir(container.id, path);
    return listCxellDir(zeeId, path);
  }, [zeeId, container]);

  const read = useCallback(async (path) => {
    if (container) return readContainerFile(container.id, path);
    return readCxellFile(zeeId, path);
  }, [zeeId, container]);

  const load = useCallback(async (path) => {
    setLoading(true); setError(null);
    try { setDir(await list(path)); }
    catch (e) { setError(e.message || String(e)); }
    finally { setLoading(false); }
  }, [list]);

  // Open a file in the ROUTED FILE VIEWER (a separate modal). The sidebar stays on the folder —
  // the file's content belongs to the viewer, not the directory listing. The viewer opens
  // immediately with "loading…" and the read fills it in, so a slow read still gives feedback.
  const openFile = useCallback(async (path) => {
    showFileViewer({ path, content: null });
    try { showFileViewer(await read(path)); }
    catch (e) { showFileViewer({ path, content: '', error: e.message || String(e) }); }
  }, [read]);

  // Show a path named in the terminal: a dir → navigate into it, a file → show its folder and open
  // the routed viewer.
  const show = useCallback(async (path) => {
    if (!path) return;
    try {
      const d = await list(path);
      setDir(d);                        // a directory → navigate into it
    } catch {
      // not a directory → it's a file: keep the sidebar on the folder it lives in, open the viewer
      try { setDir(await list(parentDir(path))); } catch { /* unresolvable folder — leave the listing alone */ }
      openFile(path);
    }
  }, [list, openFile]);

  useEffect(() => { load(null); }, [load]);

  // A "show file" request from the terminal (a clicked path link, or 📁 with a path selected) flows in via
  // openReq. The bumping openReq.n makes a repeat click on the same path re-open it.
  useEffect(() => { if (openReq?.path) show(openReq.path); }, [openReq, show]);

  const onEntry = (e) => {
    const next = `${dir.path === '/' ? '' : dir.path}/${e.name}`;
    if (e.type === 'dir') { load(next); }
    else openFile(next);          // keep the folder listing; the file opens in the routed viewer
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
                onClick={() => load(dir.parent)} title="Up one level">↑</button>
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
    </div>
  );
}
