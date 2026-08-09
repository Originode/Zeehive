import React, { useEffect, useState } from 'react';
import MarkdownPreview from '@uiw/react-markdown-preview';
import '@uiw/react-markdown-preview/markdown.css';
import { parsePatch } from './DiffViewer.jsx';
import { fileViewerKind } from './fileViewerKind.js';

// ── THE FILE VIEWER — a routed modal that opens a file from the terminal's explorer ────────────
//
// The terminal's file explorer used to dump any opened file's raw text into the sidebar, which
// was unreadable for a .md (all markup) or a .json (one dense line). Now a file opens in THIS
// viewer, routed by the file's type (web/src/fileViewerKind.js):
//
//   .md / .markdown / .mdx → @uiw/react-markdown-preview   (renders the markup)
//   .json / .jsonc          → a formatted, syntax-tinted JSON view
//   .diff / .patch          → the same unified-diff row renderer the diff viewer uses
//   everything else         → plain text (the old behaviour, moved out of the sidebar)
//
// Mounted ONCE at the root (FileViewerHost, like DiffViewerHost) and driven by a singleton store,
// so FileExplorer — deep inside a terminal modal — can open it without prop-drilling a viewer
// through half the app:
//
//   showFileViewer({ path, content, size, binary, truncated, error? })
//
// Read-only, always: it renders what the server read. Nothing here can change a file.

let _current = null;
const _listeners = new Set();
const _emit = () => { for (const fn of _listeners) fn(_current); };

export function showFileViewer(file) {
  _current = { ...file, seq: (_current?.seq || 0) + 1 };
  _emit();
}
export function closeFileViewer() { _current = null; _emit(); }

const baseName = (p) => (p || '').replace(/\/+$/, '').split('/').pop() || '/';
const fmtSize = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} K` : `${(n / 1048576).toFixed(1)} M`);

// ── the per-kind viewers ───────────────────────────────────────────────────────────────────────

// .json — a formatted view (the raw file is one dense line; the point of the component is the
// pretty-print). A half-written JSON file is still something a human needs to see, so a parse
// failure shows the raw text with a note rather than nothing.
function JsonView({ text }) {
  let pretty = text;
  let bad = false;
  try { pretty = JSON.stringify(JSON.parse(text), null, 2); } catch { bad = true; }
  return (
    <div className="fview-json">
      {bad && <div className="fview-note warn">⚠ not valid JSON — showing the raw text</div>}
      <pre className="fview-code">{pretty}</pre>
    </div>
  );
}

// .diff / .patch — the SAME unified-diff row renderer the diff viewer uses (parsePatch from
// DiffViewer.jsx), so a patch file opened from the explorer reads exactly like a diff in the
// console: +green / −red / hunk headers, numbered lines, and the dv-* styling.
function DiffView({ text }) {
  const rows = parsePatch(text);
  if (!rows.length) {
    // A .diff/.patch name but no unified-diff hunks (a binary diff, a mode-only change, or a
    // plain text file misnamed .diff) — show the raw text rather than nothing.
    return (
      <div className="fview-diff">
        <div className="fview-note warn">⚠ not a unified diff — showing the raw text</div>
        <pre className="fview-code">{text}</pre>
      </div>
    );
  }
  return (
    <div className="fview-diff" data-testid="fview-diff">
      {rows.map((r, i) => (
        <div key={i} className={`dv-row r-${r.t}`}>
          <span className="dv-ln">{r.o ?? ''}</span>
          <span className="dv-ln">{r.n ?? ''}</span>
          <span className="dv-sign">{r.t === 'add' ? '+' : r.t === 'del' ? '−' : r.t === 'hunk' ? '@' : ' '}</span>
          <span className="dv-code">{r.t === 'hunk' || r.t === 'meta' ? r.text : (r.text || ' ')}</span>
        </div>
      ))}
    </div>
  );
}

// ── the modal ──────────────────────────────────────────────────────────────────────────────────

function Viewer({ file, onClose }) {
  const kind = fileViewerKind(file.path);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fview-overlay" data-testid="file-viewer"
         onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="fview" role="dialog" aria-modal="true" aria-label="file viewer">
        <div className="fview-head">
          <span className="fview-fname" title={file.path}>{baseName(file.path)}</span>
          <span className="fview-path" title={file.path}>{file.path}</span>
          <span className="fview-meta">{fmtSize(file.size || 0)}{file.truncated ? ' · truncated' : ''}</span>
          <span className="fview-kind">{kind}</span>
          <span className="fview-spacer" />
          <button className="fview-x" onClick={onClose} title="Close (Esc)">✕</button>
        </div>
        <div className="fview-body">
          {file.error ? <div className="fview-empty err">could not read the file: {file.error}</div>
            : file.binary ? <div className="fview-empty">binary file — not shown</div>
            : file.content == null ? <div className="fview-empty">loading…</div>
            : kind === 'markdown' ? <MarkdownPreview source={file.content} wrapperElement={{ 'data-color-mode': 'dark' }} />
            : kind === 'json' ? <JsonView text={file.content} />
            : kind === 'diff' ? <DiffView text={file.content} />
            : <pre className="fview-code">{file.content}</pre>}
        </div>
      </div>
    </div>
  );
}

// Mount ONCE (see main.jsx). Same singleton pattern as DiffViewerHost: any module can open the viewer.
export function FileViewerHost() {
  const [file, setFile] = useState(_current);
  useEffect(() => {
    _listeners.add(setFile);
    return () => { _listeners.delete(setFile); };
  }, []);
  if (!file) return null;
  return <Viewer file={file} onClose={closeFileViewer} />;
}

export default FileViewerHost;
