// APP DIALOG-JSX test — showAlert(JSX) renders the element, not "[object Object]".
//
// The .env export / .zeehive.env reveal dialogs pass a <pre> element as the alert message so the
// operator can read and copy the full text. Dialog.jsx's _defaults() coerced every message with
// String(d.message), which turns a React element into the string "[object Object]" — so the
// "export .env" button in project settings showed exactly that instead of the .env contents.
//
// This test bundles the REAL Dialog.jsx (with its real react/react-dom) through esbuild and renders
// the REAL DialogHost to static markup, asserting what an operator would actually read:
//   1. a JSX message (a <pre> holding .env text) is preserved, not stringified to "[object Object]";
//   2. primitive messages (string, number) still render as before — the coercion that JSX must skip
//      is still what turns numbers into text.
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

const esbuild = await import('esbuild');
const tmp = mkdtempSync(join(tmpdir(), 'dlg-jsx-'));
const cleanup = () => { try { rmSync(tmp, { recursive: true, force: true }); } catch {} };

// Bundle the REAL Dialog.jsx (with its real react + react-dom/server) into a fresh CJS module.
// A fresh outfile matters: Dialog.jsx keeps its queue in module state, and SSR never answers a
// dialog, so the queue head never advances — each scenario needs its own module instance.
let n = 0;
const bundle = async () => {
  const out = join(tmp, `dlg-${n++}.cjs`);
  await esbuild.build({
    stdin: {
      contents: `
        const React = require('react');
        const { renderToStaticMarkup } = require('react-dom/server');
        const { showAlert, DialogHost } = require('./Dialog.jsx');
        module.exports = { React, renderToStaticMarkup, showAlert, DialogHost };`,
      resolveDir: join(ROOT, 'web/src'), loader: 'js',
    },
    bundle: true, format: 'cjs', platform: 'node', outfile: out, jsx: 'automatic',
    logLevel: 'silent', define: { 'process.env.NODE_ENV': '"development"' },
  });
  return createRequire(out)(out);
};

try {
  // ── 1. primitives still coerce — the stringification JSX must skip is kept for plain values ──
  {
    const { React, renderToStaticMarkup, showAlert, DialogHost } = await bundle();
    showAlert(42, { title: 'number message' });
    const numHtml = renderToStaticMarkup(React.createElement(DialogHost));
    ok(numHtml.includes('42'), 'a numeric message still renders as its string form');
  }

  // ── 2. a JSX message — exactly what the env export / .zeehive.env reveal pass ──
  {
    const { React, renderToStaticMarkup, showAlert, DialogHost } = await bundle();
    const envText = '# dev — exported from the ZEEHIVE meta-DB.\n# This is the SOURCE OF TRUTH; edit it in the console, not here.\nDATABASE_URL=postgres://user:pass@host:5432/db\nSECRET_KEY=abc123\n';
    showAlert(
      React.createElement('pre', { style: { whiteSpace: 'pre-wrap' } }, envText),
      { title: 'dev — 2 var(s), full values' });

    // DialogHost's state is seeded from the module-level queue, which showAlert just pushed to, so a
    // single server render shows the queued dialog. (The promise never resolves here — no buttons are
    // ever clicked in SSR — which is fine; we only read the markup.)
    const html = renderToStaticMarkup(React.createElement(DialogHost));

    ok(html.includes('DATABASE_URL=postgres://user:pass@host:5432/db'),
       'the .env text content is rendered inside the dialog');
    ok(html.includes('SECRET_KEY=abc123'),
       'every .env line survives (multi-line JSX message is not flattened)');
    ok(!html.includes('[object Object]'),
       'the JSX message is NOT stringified to "[object Object]"');
    ok(/<pre[^>]*>/.test(html) && html.includes(envText),
       'the <pre> element itself is preserved (monospace formatting for copying)');
  }

  console.log(fail === 0 ? '\nALL PASSED ✓' : `\n${fail} FAILURE(S) ✗`);
} catch (e) {
  console.error(e);
  fail++;
  console.log(`\n${fail} FAILURE(S) ✗`);
} finally {
  cleanup();
}

process.exit(fail ? 1 : 0);
