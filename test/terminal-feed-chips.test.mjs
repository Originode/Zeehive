// FEED-CHIPS test — "it's too difficult to see if the buttons are pressed or not".
//
// That was the first thing reported back about the ✱ thinking / ⚒ moves toggles, and it was a real
// defect rather than a taste argument: they reused `.term-chip`, which styles a background and a
// border but NO colour (the queenzee-log chips it was copied from always pass an inline per-scope
// colour), so the labels inherited the browser's default button colour on a dark panel — and the
// only on/off signal was a single `opacity: .35` step, on an 11px monospace chip whose effect is
// often invisible in the pane (there may be no feed running to repaint).
//
// The rule this test enforces: THE STATE IS TEXT FIRST. A toggle in this header must say `shown` or
// `hidden` in words, and must not depend on colour or opacity alone — those are reinforcement, not
// the signal. So we RENDER the real component (esbuild-compiled, react-dom/server) in both states
// and read the markup, then check the stylesheet backs it with independent cues.
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

// Compile the REAL component and import it. It is deliberately side-effect free (no CSS import, no
// xterm, no websocket), which is the whole reason it can be rendered here at all.
const src = read('web/src/FeedChips.jsx');
const js = transformSync(src, { loader: 'jsx', format: 'esm', jsx: 'transform' }).code;
// Written next to the test rather than imported as a data: URL — a data module cannot resolve the
// bare "react" specifier, and the point is to run the component against the REAL react.
const compiled = join(ROOT, 'test', '.feedchips.compiled.mjs');
writeFileSync(compiled, js);
let FeedChips;
try { ({ default: FeedChips } = await import(`file://${compiled}`)); }
finally { rmSync(compiled, { force: true }); }

const render = (feed) => renderToStaticMarkup(React.createElement(FeedChips, { feed, onToggle: () => {} }));
const chipOf = (html, key) => {
  const i = html.indexOf(`data-testid="feed-${key}"`);
  if (i < 0) return '';
  const start = html.lastIndexOf('<button', i);
  return html.slice(start, html.indexOf('</button>', i) + 9);
};

// ── both on ──────────────────────────────────────────────────────────────────────────────────
console.log('\n── both halves shown ──');
const bothOn = render({ thinking: true, moves: true, live: true });
const thinkOn = chipOf(bothOn, 'thinking');
const movesOn = chipOf(bothOn, 'moves');
ok(!!thinkOn && !!movesOn, 'both chips render');
ok(/>shown</.test(thinkOn) && />shown</.test(movesOn), 'each SAYS "shown" — the state is a word, not a shade');
ok(/aria-pressed="true"/.test(thinkOn), 'and reports pressed to a screen reader');
ok(/class="feedchip on"/.test(thinkOn), 'carrying the .on class the stylesheet colours');
ok(thinkOn.includes('✱') && thinkOn.includes('thinking'), 'labelled with the glyph the feed itself uses');
ok(movesOn.includes('⚒') && movesOn.includes('moves'), 'same for the moves chip');

// ── one off ──────────────────────────────────────────────────────────────────────────────────
console.log('\n── thinking hidden: the difference must be readable, not inferable ──');
const oneOff = render({ thinking: false, moves: true, live: true });
const thinkOff = chipOf(oneOff, 'thinking');
ok(/>hidden</.test(thinkOff), 'the hidden chip SAYS "hidden"');
ok(/aria-pressed="false"/.test(thinkOff), 'and reports unpressed');
ok(/class="feedchip off"/.test(thinkOff), 'with the .off class');
ok(/>shown</.test(chipOf(oneOff, 'moves')), 'while the other chip still says shown — the two states are side by side');
// The defect in one assertion: strip every class and attribute, and the states must STILL differ.
const textOnly = (h) => h.replace(/<[^>]+>/g, '').trim();
ok(textOnly(thinkOn) !== textOnly(thinkOff),
   `on and off differ in TEXT ALONE ("${textOnly(thinkOn)}" vs "${textOnly(thinkOff)}") — a colourblind or low-contrast reader can still tell`);

// ── the idle case gets words too ─────────────────────────────────────────────────────────────
console.log('\n── no feed streaming ──');
const idle = render({ thinking: true, moves: true, live: false });
ok(idle.includes('no live feed'), 'the header SAYS there is no live feed, instead of a click landing on nothing');
ok(/data-testid="feed-idle"/.test(idle), 'as its own marked element');
ok(/next feed opens in/.test(idle), 'and the tooltip explains the click still records a preference');
ok(!render({ thinking: true, moves: true, live: true }).includes('no live feed'), 'and it is absent while a feed IS running');
ok(!render({ thinking: true, moves: true, live: null }).includes('no live feed'), 'and while we have not been told yet (null ≠ known-idle)');

// ── the stylesheet reinforces it independently ───────────────────────────────────────────────
console.log('\n── the CSS adds colour and a strike, and never relies on opacity alone ──');
const css = read('web/src/styles.css');
const block = css.slice(css.indexOf('.feedchips {'), css.indexOf('.zeeterm-foot {'));
ok(/\.feedchip\.on\s*{[^}]*color:\s*var\(--accent\)/.test(block), '.on is accent-coloured');
ok(/\.feedchip\.on\s*{[^}]*border-color:\s*var\(--accent\)/.test(block), 'with an accent border');
ok(/\.feedchip\.on \.fc-state\s*{[^}]*background:\s*var\(--accent\)/.test(block), 'and the state word reversed out (reads as pressed in)');
ok(/\.feedchip\.off \.fc-label\s*{[^}]*line-through/.test(block), '.off strikes the label through — a third, colour-free signal');
ok(/\.feedchip\s*{[^}]*color:\s*var\(--muted\)/.test(block),
   'the base chip sets its OWN colour (the bug was inheriting the default button colour on a dark panel)');
ok(!/\.feedchip[^{]*{[^}]*opacity:/.test(block), 'and no state is expressed by opacity alone — the thing that failed');
ok(!css.includes('.term-chip.idle'), 'the old opacity/dashed .term-chip styling for these is gone');

// ── and the terminal still hands it the right props ──────────────────────────────────────────
console.log('\n── wired into the terminal header ──');
const jsx = read('web/src/ZeeTerminal.jsx');
ok(/import FeedChips from '\.\/FeedChips\.jsx'/.test(jsx), 'ZeeTerminal imports the component');
ok(/\{explorerZeeId && <FeedChips feed=\{feed\} onToggle=\{setFeedFlag\} \/>\}/.test(jsx),
   'renders it only on the zee door, wired to the same setFeedFlag');
ok(!jsx.includes('term-chip'), 'and no longer borrows .term-chip (the colourless class that started this)');

console.log(failures === 0 ? '\nALL PASSED ✓' : `\n${failures} FAILURE(S) ✗`);
process.exit(failures ? 1 : 0);
