// DB-OP PANEL CARD test — the db backup/restore/copy "build event" in the notification stack.
//
// The task (xell: show streaming progress of db backup/restore/copy on the user notification pane
// when ongoing) converged on a WIDE persistent card (kind 'dbop') that streams the RAW
// pg_dump/pg_restore log live, not a one-line toast. This test RENDERS the real component
// (esbuild-compiled, react-dom/server) in every state and reads the markup, then checks the
// stylesheet backs the card with its own rules — the same "render the real thing, read the
// markup" approach as terminal-feed-chips.test.mjs.
//
// The rules it enforces:
//   • a running op card says it is running (data-status), shows its % and the progress bar;
//   • the log <pre> is present and contains the streamed lines;
//   • a finished card turns green, shows ✓, offers a ✕ and KEEPS the log;
//   • a failed card shows the error and still offers ✕;
//   • a running card has NO ✕ (it is the live operation — you cannot dismiss it mid-flight);
//   • plain toasts keep working and do not grow the dbop log block.
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { transformSync } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };

// Compile the REAL component and import it. It is side-effect free (React + the file itself only).
const src = read('web/src/Toasts.jsx');
const js = transformSync(src, { loader: 'jsx', format: 'esm', jsx: 'transform' }).code;
const compiled = join(ROOT, 'test', '.toasts.compiled.mjs');
writeFileSync(compiled, js);
let Toasts;
try { ({ default: Toasts } = await import(`file://${compiled}`)); }
finally { rmSync(compiled, { force: true }); }

const render = (toasts) => renderToStaticMarkup(React.createElement(Toasts, { toasts, onDismiss: () => {} }));
const has = (html, needle) => html.includes(needle);

console.log('\n── a RUNNING db op card ──');
const runHtml = render([{ id: 'dbop-backup-1', kind: 'dbop', status: 'running', title: 'Backup — Zeehive prod',
  body: 'Dumping database…', pct: 30, lines: ['pg_dump: reading schemas', 'pg_dump: dumping contents of table core.app'] }]);
ok(has(runHtml, 'data-testid="dbop-card"') && has(runHtml, 'data-status="running"'), 'renders a dbop card marked running');
ok(has(runHtml, 'Backup — Zeehive prod'), 'title carries the operation + target');
ok(has(runHtml, 'dbop-pct') && has(runHtml, '30%'), 'shows the live percentage');
ok(has(runHtml, 'toast-progress-bar'), 'renders the progress bar');
ok(has(runHtml, 'Dumping database…'), 'shows the current phase');
ok(has(runHtml, 'data-testid="dbop-log"') && has(runHtml, 'pg_dump: reading schemas')
  && has(runHtml, 'pg_dump: dumping contents of table core.app'), 'the log pre contains the streamed lines');
ok(!has(runHtml, 'toast-x'), 'NO dismiss button while running — it is the live operation');

console.log('\n── a FINISHED db op card ──');
const doneHtml = render([{ id: 'dbop-backup-1', kind: 'dbop', status: 'finished', title: 'Backup complete',
  body: 'Backup complete', pct: 100, lines: ['pg_dump: done'] }]);
ok(has(doneHtml, 'data-status="finished"'), 'finished card says finished');
ok(has(doneHtml, 'toast-x'), 'offers a ✕ to dismiss the settled card');
ok(has(doneHtml, 'data-testid="dbop-log"') && has(doneHtml, 'pg_dump: done'), 'keeps the log after finishing');

console.log('\n── a FAILED db op card ──');
const failHtml = render([{ id: 'dbop-restore-9', kind: 'dbop', status: 'failed', title: 'Restore failed',
  body: 'pg_restore: could not open input file', lines: ['pg_restore: connecting', 'pg_restore: error'] }]);
ok(has(failHtml, 'data-status="failed"'), 'failed card says failed');
ok(has(failHtml, 'pg_restore: could not open input file'), 'shows the error');
ok(has(failHtml, 'toast-x'), 'offers a ✕ to dismiss the failed card');
ok(has(failHtml, 'data-testid="dbop-log"') && has(failHtml, 'pg_restore: error'), 'keeps the failing log');

console.log('\n── plain toasts still work ──');
const plainHtml = render([{ id: 'disp-1', kind: 'progress', title: 'Dispatching a zee…', body: 'Claiming a xell…' }]);
ok(has(plainHtml, 'toast-progress') && has(plainHtml, 'Dispatching a zee…'), 'a plain progress toast still renders');
ok(!has(plainHtml, 'dbop-card') && !has(plainHtml, 'dbop-log'), 'a plain toast does not grow the dbop log block');

console.log('\n── the stylesheet backs the card ──');
const css = read('web/src/styles.css');
for (const rule of ['.toast-dbop', '.dbop-head', '.dbop-pct', '.dbop-log', '.toast-progress-bar']) {
  ok(css.includes(rule), `styles.css defines ${rule}`);
}

console.log(failures ? `\n✗ ${failures} assertion(s) FAILED` : '\nALL PASSED ✓');
process.exitCode = failures ? 1 : 0;
