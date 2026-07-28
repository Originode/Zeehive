import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { DialogHost } from './Dialog.jsx';
import { DiffViewerHost } from './DiffViewer.jsx';
import './styles.css';

// DialogHost is mounted once at the root (a singleton store backs showAlert), so any module —
// even the module-level error helpers — can raise a non-blocking modal without hook plumbing.
// DiffViewerHost rides the same pattern: every diffstat in the console (xell card, hive petal,
// held landing, PR) opens the viewer with showDiff(...), from wherever it is rendered.
createRoot(document.getElementById('root')).render(
  <React.Fragment>
    <App />
    <DialogHost />
    <DiffViewerHost />
  </React.Fragment>,
);
