import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { DialogHost } from './Dialog.jsx';
import './styles.css';

// DialogHost is mounted once at the root (a singleton store backs showAlert), so any module —
// even the module-level error helpers — can raise a non-blocking modal without hook plumbing.
createRoot(document.getElementById('root')).render(
  <React.Fragment>
    <App />
    <DialogHost />
  </React.Fragment>,
);
