// TERMINAL ENGINE PREFERENCE test — wterm as an alternative to xterm, chosen in Console settings.
//
// The console used to hard-wire @xterm/xterm. Operators can now pick wterm (DOM + WASM, Vercel)
// in Console settings; the preference is browser-local (localStorage) and applies the next time
// a terminal opens. This pins:
//   1. termPref.js — default xterm, round-trip set/get, reject unknown, notify subscribers;
//   2. termHost.js — mounts through one handle for both engines (write/focus/fit/…);
//   3. ConsoleSettings + topbar ⚙ — the only door to the preference;
//   4. ZeeTerminal / Terminal — consume mountTerm and surface the engine pill;
//   5. wterm is VENDORED under web/vendor/wterm (vite aliases @wterm/*); xterm stays on npm.
// Static source check (app-dialog-imports pattern): no browser needed for the preference plumbing.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(resolve(here, rel), 'utf8');

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };

// ── termPref: pure module, exercise it with a fake localStorage ──
console.log('\n── termPref.js ──');
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
};
const pref = await import(resolve(here, '../web/src/termPref.js'));
ok(pref.DEFAULT_TERM_ENGINE === 'xterm', 'default engine is xterm (no surprise on upgrade)');
ok(pref.getTermEngine() === 'xterm', 'getTermEngine returns xterm when storage is empty');
ok(pref.setTermEngine('wterm') === 'wterm', 'setTermEngine accepts wterm');
ok(pref.getTermEngine() === 'wterm', 'and getTermEngine reads it back');
ok(pref.setTermEngine('nope') === 'xterm', 'unknown engine falls back to xterm');
ok(pref.getTermEngine() === 'xterm', 'storage holds the fallback after a bad set');
let heard = null;
const off = pref.onTermEngineChange((e) => { heard = e; });
pref.setTermEngine('wterm');
ok(heard === 'wterm', 'subscribers are notified on change');
off();
heard = null;
pref.setTermEngine('xterm');
ok(heard === null, 'unsubscribe stops notifications');

// ── termHost: source shape ──
console.log('\n── termHost.js ──');
const host = read('../web/src/termHost.js');
ok(/export async function mountTerm/.test(host), 'exports mountTerm');
ok(/from '@xterm\/xterm'/.test(host), 'imports xterm statically (default engine)');
ok(host.includes('vendor/wterm/dom/dist') && host.includes('vendor/wterm/ghostty/dist'),
   'loads wterm + ghostty lazily from the vendored tree');
ok(/GhosttyCore\.load/.test(host),
   'wterm uses GhosttyCore for full VT (tmux/claude need it)');
ok(/engine === 'wterm'/.test(host) && /mountXterm|mountWterm/.test(host),
   'branches on engine');
ok(/registerPathLinks/.test(host) && /onSelectionChange/.test(host) && /fit\(/.test(host),
   'handle exposes path links, selection, and fit for both engines');
ok(/getTermEngine/.test(host), 'reads the preference at mount when engine is not forced');

// ── Console settings UI ──
console.log('\n── ConsoleSettings + topbar ──');
const settings = read('../web/src/ConsoleSettings.jsx');
const app = read('../web/src/App.jsx');
const css = read('../web/src/styles.css');
ok(/data-testid="console-settings"/.test(settings), 'settings modal has a test id');
ok(/data-testid="term-engine-xterm"/.test(settings) && /data-testid="term-engine-wterm"/.test(settings),
   'both engines are choosable radios');
ok(/setTermEngine/.test(settings) && /getTermEngine/.test(settings),
   'settings reads and writes termPref');
ok(/import ConsoleSettings from '\.\/ConsoleSettings\.jsx'/.test(app), 'App imports ConsoleSettings');
ok(/data-testid="console-settings-btn"/.test(app), 'topbar carries the ⚙ button');
ok(/setShowConsoleSettings\(true\)/.test(app), '⚙ opens the settings modal');
ok(/showConsoleSettings && <ConsoleSettings/.test(app.replace(/\s+/g, ' ')),
   'modal renders when the flag is on');
ok(/\.console-settings/.test(css) && /\.cs-gear/.test(css), 'settings has stylesheet rules');

// ── terminals consume the host ──
console.log('\n── ZeeTerminal + firehose Terminal ──');
const zee = read('../web/src/ZeeTerminal.jsx');
const fire = read('../web/src/Terminal.jsx');
ok(/from '\.\/termHost\.js'/.test(zee) && /mountTerm\(/.test(zee),
   'ZeeTerminal mounts through termHost (not a bare @xterm import)');
ok(!/from '@xterm\/xterm'/.test(zee), 'ZeeTerminal no longer imports @xterm directly');
ok(/from '\.\/termHost\.js'/.test(fire) && /mountTerm\(/.test(fire),
   'firehose Terminal mounts through termHost');
ok(/data-testid="term-engine-pill"/.test(zee) && /data-testid="term-engine-pill"/.test(fire),
   'both terminals surface which engine the open session is on');
ok(/getTermEngine\(/.test(zee) && /getTermEngine\(/.test(fire),
   'both read the preference at open');

// Existing terminal feature tests still look at the header — the engine pill must not displace them.
const head = zee.slice(zee.indexOf('<div className={`term-head'), zee.indexOf('<div className="zeeterm-main"'));
ok(head.includes('fx-toggle') && head.includes('clip-toggle') && head.includes('talk-toggle'),
   'explorer / clipboard / talk header buttons still present after the engine pill');


// ── term theme (dark|light) ──
console.log("\n── term theme ──");
ok(pref.DEFAULT_TERM_THEME === "dark", "default theme is dark");
ok(pref.getTermTheme() === "dark", "getTermTheme defaults to dark");
ok(pref.setTermTheme("light") === "light", "setTermTheme accepts light");
ok(pref.getTermTheme() === "light", "and reads back");
ok(pref.setTermTheme("nope") === "dark", "unknown theme falls back to dark");
ok(pref.TERM_THEME_PALETTES.dark.colors[0] === pref.TERM_THEME_PALETTES.dark.background,
   "dark palette: color-0 matches bg (reverse-video safe)");
ok(pref.TERM_THEME_PALETTES.dark.colors[7] === pref.TERM_THEME_PALETTES.dark.foreground,
   "dark palette: color-7 matches fg (wterm DEFAULT bg → 7)");
ok(pref.TERM_THEME_PALETTES.light.background !== pref.TERM_THEME_PALETTES.light.foreground,
   "light palette has contrasting bg/fg");
ok(host.includes("wheel") && host.includes("[<"), "wterm forwards mouse-wheel to the PTY (SGR) when DOM cannot scroll");
ok(host.includes("setTheme") && host.includes("applyWtermPalette"),
   "termHost exposes setTheme and applies the full wterm CSS palette");
ok(/term-theme-toggle/.test(read('../web/src/styles.css')),
   "stylesheet styles the theme toggle");
ok(/data-testid="term-theme-toggle"/.test(zee) && /data-testid="term-theme-toggle"/.test(fire),
   "both terminals carry the dark/light toggle beside the engine pill");
ok(/setTermTheme/.test(zee) && /setTermTheme/.test(fire),
   "toggle persists via setTermTheme");

// ── xterm on npm; wterm vendored (no host npm ci required for the new engine) ──
console.log('\n── web dependencies + vendor ──');
const pkg = JSON.parse(read('../web/package.json'));
const vite = read('../web/vite.config.js');
ok(!!pkg.dependencies['@xterm/xterm'], '@xterm/xterm stays (default engine, npm)');
ok(!pkg.dependencies?.['@wterm/dom'] && !pkg.dependencies?.['@wterm/ghostty'],
   'wterm is NOT an npm dep — vendored so process-runner spinoffs do not need a fresh npm ci');
ok(existsSync(resolve(here, '../web/vendor/wterm/dom/package.json')), 'web/vendor/wterm/dom is present');
ok(existsSync(resolve(here, '../web/vendor/wterm/core/package.json')), 'web/vendor/wterm/core is present');
ok(existsSync(resolve(here, '../web/vendor/wterm/ghostty/package.json')), 'web/vendor/wterm/ghostty is present');
ok(existsSync(resolve(here, '../web/vendor/wterm/ghostty/wasm/ghostty-vt.wasm')),
   'ghostty WASM binary is vendored alongside the JS');
ok(/['"]@wterm\/dom['"]/.test(vite) && /vendor\/wterm/.test(vite),
   'vite aliases @wterm/* to the vendored tree');

console.log(failures === 0 ? '\nALL PASSED ✓' : `\n${failures} FAILURE(S) ✗`);
process.exit(failures ? 1 : 0);
