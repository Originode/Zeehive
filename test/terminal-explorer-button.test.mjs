// TERMINAL EXPLORER-BUTTON test — proves the zee terminal header carries ONE file-explorer
// button, not two.
//
// The header used to show 📄 "show file" NEXT TO 📁 "show file explorer" — reported as "these two
// icons are redundant", and they were: 📄 opened the selected path in the explorer and, with
// nothing selected, just opened the explorer — i.e. a strict subset of 📁, whose panel already has
// its own "paste a path" box (and paths in the output are clickable links). They are now one 📁
// button: a path-shaped selection opens that file, otherwise it toggles the panel.
//
// Static source check (the repo's app-dialog-imports pattern): no browser, no DB — the header is
// plain JSX, so reading it is enough to keep the second button from creeping back.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(here, '../web/src/ZeeTerminal.jsx'), 'utf8');

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };

// The header block: from the term-head div to the end of its button row.
const head = src.slice(src.indexOf('<div className={`term-head'), src.indexOf('<div className="zeeterm-main"'));
ok(head.length > 0, 'found the terminal header block');

// ── one explorer door ──
const explorerButtons = [...head.matchAll(/data-testid="(fx-[a-z]+)"/g)].map((m) => m[1]);
ok(explorerButtons.length === 1,
   `header has exactly ONE explorer button (found: ${explorerButtons.join(', ') || 'none'})`);
ok(explorerButtons[0] === 'fx-toggle', 'and it is fx-toggle (the 📁 explorer button)');
ok(!head.includes('📄'), 'the redundant 📄 "show file" button is gone from the header');
ok(!src.includes('fx-showfile'), 'no fx-showfile button anywhere in the terminal modal');
ok((head.match(/📁/g) || []).length === 1, 'exactly one 📁 in the header');

// ── it still does BOTH jobs (nothing was dropped when the buttons merged) ──
ok(/onClick=\{toggleExplorer\}/.test(head), '📁 is wired to toggleExplorer');
const fn = src.slice(src.indexOf('const toggleExplorer'), src.indexOf('return createPortal'));
ok(/pathFromSelection\(/.test(fn), 'toggleExplorer still reads a path out of the terminal selection');
ok(/openInExplorer\(p\)/.test(fn), 'a selected path is opened in the explorer (the old 📄 job)');
ok(/clearSelection/.test(fn), 'the consumed selection is cleared, so the next click toggles the panel');
ok(/setShowFx\(\(v\) => !v\)/.test(fn), 'with no path selected it toggles the panel (the old 📁 job)');

// The other header buttons are untouched (clipboard / fullscreen / close).
ok(head.includes('clip-toggle') && head.includes('⛶') && head.includes('✕'),
   'clipboard, fullscreen and close buttons are still there');

console.log(failures === 0 ? '\nALL PASSED ✓' : `\n${failures} FAILURE(S) ✗`);
process.exit(failures ? 1 : 0);
