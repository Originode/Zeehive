// FILE-VIEWER test — proves the terminal's file explorer opens files through the ROUTED file
// viewer, not as raw text in the sidebar.
//
// The explorer used to dump any opened file's raw text into the panel — unreadable for a .md
// (all markup) or a .json (one dense line). Now opening a file keeps the sidebar on the folder
// the file lives in and routes the file to a viewer by type: markdown → @uiw/react-markdown-preview,
// json → formatted, diff → the diff row renderer, everything else → plain text.
//
// The ROUTER itself (fileViewerKind) is plain JS and imported directly; the component wiring is
// a static source check (the repo's app-dialog-imports pattern) — no browser, no DB.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { fileViewerKind } from '../web/src/fileViewerKind.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const fv = readFileSync(resolve(root, 'web/src/FileViewer.jsx'), 'utf8');
const fe = readFileSync(resolve(root, 'web/src/FileExplorer.jsx'), 'utf8');
const main = readFileSync(resolve(root, 'web/src/main.jsx'), 'utf8');

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };

console.log('\n── the ROUTER: file path → viewer kind (imported, real logic) ──');
ok(fileViewerKind('README.md') === 'markdown', '.md → markdown');
ok(fileViewerKind('docs/HANDOFF.markdown') === 'markdown', '.markdown → markdown');
ok(fileViewerKind('package.json') === 'json', '.json → json');
ok(fileViewerKind('web/src/tsconfig.jsonc') === 'json', '.jsonc → json');
ok(fileViewerKind('change.diff') === 'diff', '.diff → diff');
ok(fileViewerKind('fix.patch') === 'diff', '.patch → diff');
ok(fileViewerKind('App.jsx') === 'text', '.jsx → text (plain text fallback)');
ok(fileViewerKind('README') === 'text', 'no extension → text');
ok(fileViewerKind('') === 'text', 'empty path → text');
ok(fileViewerKind('README.MD') === 'markdown', 'extension match is case-insensitive');

console.log('\n── the viewer: a routed modal that renders by kind ──');
ok(/showFileViewer/.test(fv) && /closeFileViewer/.test(fv), 'exports showFileViewer/closeFileViewer');
ok(/export function FileViewerHost/.test(fv), 'exports FileViewerHost (the root-mounted singleton host)');
ok(/from '@uiw\/react-markdown-preview'/.test(fv), 'routes .md to @uiw/react-markdown-preview');
ok(/<MarkdownPreview source=\{file\.content\}/.test(fv), 'renders MarkdownPreview with the file text');
ok(/import \{ parsePatch \} from '\.\/DiffViewer\.jsx'/.test(fv), 'reuses the diff row renderer (parsePatch)');
ok(/fileViewerKind/.test(fv), 'the viewer consults the router');
ok(/fview-overlay/.test(fv), 'renders as a modal overlay');

console.log('\n── the explorer: opening a file keeps the folder and opens the viewer ──');
ok(/showFileViewer/.test(fe), 'FileExplorer imports the file viewer');
ok(/showFileViewer\(\{ path, content: null \}\)/.test(fe), 'opens the viewer immediately (loading…)');
ok(/showFileViewer\(await read\(path\)\)/.test(fe), 'and fills it from the read');
ok(/parentDir/.test(fe), 'computes the folder a file lives in');
ok(!/fx-code/.test(fe) && !/fx-file/.test(fe), 'no longer renders file content in the sidebar (fx-file/fx-code gone)');
ok(!/binary file — not shown/.test(fe), 'binary handling moved out of the sidebar');
ok(/openFile\(next\)/.test(fe), 'a clicked file entry opens the viewer instead of the inline panel');

console.log('\n── the root mounts the host once ──');
ok(/FileViewerHost/.test(main), 'main.jsx mounts <FileViewerHost />');

console.log(failures === 0 ? '\nALL PASSED ✓' : `\n${failures} FAILURE(S) ✗`);
process.exit(failures ? 1 : 0);
