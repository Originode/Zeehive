import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { DialogHost } from './Dialog.jsx';
import { DiffViewerHost } from './DiffViewer.jsx';
import { FileViewerHost } from './FileViewer.jsx';
import { baseUrl } from './api.js';
import './styles.css';

// Every `fetch('/api/...')` rides the app's Vite base via baseUrl. Base is '/' everywhere today
// (xell webapps are direct ports, not path prefixes — docs/visual-verification-diagnosis.md §7),
// so this wrapper is the identity; it stays as the one seam a future non-root base would need,
// covering api.js, DeliveryTelemetry.jsx and any other caller in one place. Absolute URLs and
// non-/api paths pass through untouched.
const origFetch = window.fetch.bind(window);
window.fetch = (input, init) =>
  origFetch(typeof input === 'string' && input.startsWith('/api') ? baseUrl(input) : input, init);

// DialogHost is mounted once at the root (a singleton store backs showAlert), so any module —
// even the module-level error helpers — can raise a non-blocking modal without hook plumbing.
// DiffViewerHost rides the same pattern: every diffstat in the console (xell card, hive petal,
// held landing, PR) opens the viewer with showDiff(...), from wherever it is rendered.
// FileViewerHost is the same shape again: the terminal's file explorer opens a file with
// showFileViewer(...), which the root-mounted host routes by file type to the right viewer.
createRoot(document.getElementById('root')).render(
  <React.Fragment>
    <App />
    <DialogHost />
    <DiffViewerHost />
    <FileViewerHost />
  </React.Fragment>,
);
