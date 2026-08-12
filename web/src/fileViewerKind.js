// THE FILE-VIEWER ROUTER — a file path → the viewer kind that should open it.
//
// The terminal's file explorer opens a file in a ROUTED viewer (web/src/FileViewer.jsx) chosen by
// the file's type, instead of dumping the raw text into the sidebar. This module is the router:
// the path is the only signal, and the same file name renders the same way wherever it lives (a
// README is a README in a zee's worktree or a container's /etc). Anything without a known
// extension falls back to plain text.
//
// Kept free of JSX on purpose so a plain node test (test/file-viewer.test.mjs) can import and
// prove the routing without bundling React.
export function fileViewerKind(path) {
  const name = String(path || '').toLowerCase();
  const i = name.lastIndexOf('.');
  const ext = i >= 0 ? name.slice(i + 1) : '';
  switch (ext) {
    case 'md': case 'markdown': case 'mdx': return 'markdown';
    case 'json': case 'jsonc': case 'json5': return 'json';
    case 'diff': case 'patch': return 'diff';
    default: return 'text';
  }
}
