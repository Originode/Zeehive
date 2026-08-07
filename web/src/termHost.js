// Terminal host: one handle shape over either @xterm/xterm or @wterm/dom.
//
// Both engines drive the same wire protocol (raw bytes down, {t:'i'}/{t:'r'} up),
// so ZeeTerminal and the queenzee firehose mount through this and never branch on
// engine for I/O. Engine-specific extras (canvas selection, DOM links) stay behind
// the handle methods below.
//
// Preference is read at mount time (see termPref.js). Changing it applies on the
// next open — an already-live PTY keeps the engine it was born with.

import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

import { getTermEngine, getTermTheme, TERM_THEME_PALETTES } from './termPref.js';

// Resolve a named theme (dark|light) or a raw xterm-style theme object into the
// palette shape both engines understand. Named themes carry a full ANSI 0–15 so
// reverse-video (DEFAULT bg → index 7 in wterm) stays readable.
function resolvePalette(themeOpt) {
  if (typeof themeOpt === 'string' && TERM_THEME_PALETTES[themeOpt]) {
    return { name: themeOpt, ...TERM_THEME_PALETTES[themeOpt] };
  }
  if (themeOpt && typeof themeOpt === 'object' && (themeOpt.background || themeOpt.foreground)) {
    const name = themeOpt.name && TERM_THEME_PALETTES[themeOpt.name] ? themeOpt.name : null;
    const base = TERM_THEME_PALETTES[name || 'dark'];
    return {
      name: name || 'custom',
      background: themeOpt.background || base.background,
      foreground: themeOpt.foreground || base.foreground,
      cursor: themeOpt.cursor || themeOpt.foreground || base.cursor,
      colors: themeOpt.colors || base.colors,
    };
  }
  const name = getTermTheme();
  return { name, ...TERM_THEME_PALETTES[name] };
}

function xtermThemeFrom(palette, { hideCursor = false } = {}) {
  const c = palette.colors || {};
  return {
    background: palette.background,
    foreground: palette.foreground,
    // Firehose (read-only): paint the cursor the bg colour so it never shows as a stray block.
    cursor: hideCursor ? palette.background : (palette.cursor || palette.foreground),
    black: c[0], red: c[1], green: c[2], yellow: c[3],
    blue: c[4], magenta: c[5], cyan: c[6], white: c[7],
    brightBlack: c[8], brightRed: c[9], brightGreen: c[10], brightYellow: c[11],
    brightBlue: c[12], brightMagenta: c[13], brightCyan: c[14], brightWhite: c[15],
  };
}

// Apply the full wterm CSS custom-property palette. color-0 = bg and color-7 = fg
// so reverse video (DEFAULT→7) paints fg-on-bg instead of a washed yellow/gray.
function applyWtermPalette(el, palette) {
  el.style.setProperty('--term-bg', palette.background);
  el.style.setProperty('--term-fg', palette.foreground);
  el.style.setProperty('--term-cursor', palette.cursor || palette.foreground);
  const colors = palette.colors || {};
  for (let i = 0; i < 16; i++) {
    if (colors[i]) el.style.setProperty(`--term-color-${i}`, colors[i]);
  }
  el.classList.remove('term-theme-dark', 'term-theme-light');
  if (palette.name === 'dark' || palette.name === 'light') {
    el.classList.add(`term-theme-${palette.name}`);
  }
  // Selection: force readable contrast (browser default can look yellow on dark).
  el.style.setProperty('--term-selection-bg', palette.name === 'light' ? 'rgba(26,31,42,.18)' : 'rgba(91,140,255,.35)');
  el.style.setProperty('--term-selection-fg', palette.foreground);
}

// wterm + ghostty are loaded only when the operator picks that engine — keeps the
// default xterm path free of the ~430 KB Ghostty WASM and the DOM renderer.
// Paths are RELATIVE into the vendored tree (web/vendor/wterm) so resolution does not
// depend on node_modules; vite aliases still rewrite the @wterm/* imports *inside* those
// packages to the same tree.
async function loadWterm() {
  const [{ WTerm }, { GhosttyCore }] = await Promise.all([
    import('../vendor/wterm/dom/dist/index.js'),
    import('../vendor/wterm/ghostty/dist/index.js'),
    import('../vendor/wterm/dom/src/terminal.css'),
  ]);
  return { WTerm, GhosttyCore };
}

// Path tokens to make clickable (same RE the xterm link provider uses). Kept here
// so both engines share one definition.
export const PATH_RE = /(?:\.{0,2}\/)?(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+(?::\d+(?::\d+)?)?|\b[A-Za-z0-9_-]+\.(?:jsx?|tsx?|mjs|cjs|json|css|md|py|sh|ya?ml|html?|sql|txt|toml|ini|env|lock)\b/g;

/**
 * Mount a terminal into `el`. Resolves once the engine is ready to write.
 *
 * @param {HTMLElement} el
 * @param {object} opts
 * @param {'xterm'|'wterm'} [opts.engine]  override preference (tests)
 * @param {string} [opts.fontFamily]
 * @param {number} [opts.fontSize]
 * @param {number} [opts.lineHeight]
 * @param {'dark'|'light'|object} [opts.theme]  named palette or raw xterm theme object
 * @param {boolean} [opts.cursorBlink]
 * @param {number} [opts.scrollback]
 * @param {boolean} [opts.disableStdin]    firehose: no keyboard input
 * @param {(d:string)=>void} [opts.onData]
 * @param {(cols:number,rows:number)=>void} [opts.onResize]
 * @returns {Promise<TermHandle>}
 */
export async function mountTerm(el, opts = {}) {
  const engine = opts.engine || getTermEngine();
  if (engine === 'wterm') return mountWterm(el, opts);
  return mountXterm(el, opts);
}

// ── xterm ────────────────────────────────────────────────────────────────────

function mountXterm(el, opts) {
  let palette = resolvePalette(opts.theme);
  const hideCursor = !!opts.disableStdin;
  const term = new XTerm({
    fontFamily: opts.fontFamily || 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: opts.fontSize || 13,
    lineHeight: opts.lineHeight || 1.2,
    scrollback: opts.scrollback ?? 5000,
    disableStdin: !!opts.disableStdin,
    cursorBlink: opts.cursorBlink !== false && !opts.disableStdin,
    convertEol: !!opts.convertEol,
    theme: xtermThemeFrom(palette, { hideCursor }),
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(el);
  el.classList.add('term-xterm-host');
  el.classList.add(`term-theme-${palette.name === 'light' ? 'light' : 'dark'}`);

  const dataDisp = opts.onData ? term.onData(opts.onData) : null;
  const resizeDisp = opts.onResize
    ? term.onResize(({ cols, rows }) => opts.onResize(cols, rows))
    : null;

  const handle = {
    engine: 'xterm',
    get cols() { return term.cols; },
    get rows() { return term.rows; },
    get theme() { return palette.name; },
    write(data) { term.write(typeof data === 'string' ? data : data); },
    writeln(s) { term.writeln(s); },
    focus() { term.focus(); },
    fit() { try { fit.fit(); } catch { /* holder not laid out / mid-teardown */ } },
    reset() { term.reset(); },
    setTheme(nameOrObj) {
      palette = resolvePalette(nameOrObj);
      try { term.options.theme = xtermThemeFrom(palette, { hideCursor }); } catch { /* older xterm */ }
      el.classList.remove('term-theme-dark', 'term-theme-light');
      if (palette.name === 'dark' || palette.name === 'light') {
        el.classList.add(`term-theme-${palette.name}`);
      }
    },
    getSelection() { return term.getSelection() || ''; },
    hasSelection() { return term.hasSelection(); },
    clearSelection() { try { term.clearSelection(); } catch { /* torn down */ } },
    onSelectionChange(cb) {
      const d = term.onSelectionChange(() => { const s = term.getSelection(); if (s) cb(s); });
      return () => { try { d.dispose(); } catch { /* */ } };
    },
    // Custom key handler: return false to swallow. xterm-only; wterm uses native
    // browser copy/paste so the same chords already work without us.
    attachCustomKeyEventHandler(fn) { term.attachCustomKeyEventHandler(fn); },
    registerPathLinks(activate) {
      const disp = term.registerLinkProvider({
        provideLinks(y, cb) {
          const line = term.buffer.active.getLine(y - 1);
          if (!line) return cb(undefined);
          const text = line.translateToString(true);
          const links = [];
          PATH_RE.lastIndex = 0;
          let m;
          while ((m = PATH_RE.exec(text)) !== null) {
            const raw = m[0];
            const x = m.index + 1;
            links.push({
              text: raw,
              range: { start: { x, y }, end: { x: x + raw.length - 1, y } },
              activate: (_e, t) => activate(t.replace(/:\d+(?::\d+)?$/, '')),
            });
          }
          cb(links.length ? links : undefined);
        },
      });
      return () => { try { disp.dispose(); } catch { /* */ } };
    },
    dispose() {
      try { dataDisp?.dispose(); } catch { /* */ }
      try { resizeDisp?.dispose(); } catch { /* */ }
      try { term.dispose(); } catch { /* */ }
      el.classList.remove('term-xterm-host', 'term-theme-dark', 'term-theme-light');
    },
  };
  handle.fit();
  return Promise.resolve(handle);
}

// ── wterm ────────────────────────────────────────────────────────────────────

async function mountWterm(el, opts) {
  const { WTerm, GhosttyCore } = await loadWterm();
  // Full VT via libghostty — a tmux/claude session needs graphemes, alt screen and
  // the modes the built-in 12 KB core does not cover. Vite emits the wasm asset.
  const core = await GhosttyCore.load({
    scrollbackLimit: Math.max(50_000, (opts.scrollback || 5000) * 200),
  });

  let palette = resolvePalette(opts.theme);
  applyWtermPalette(el, palette);
  if (opts.fontFamily) el.style.setProperty('--term-font-family', opts.fontFamily);
  if (opts.fontSize) el.style.setProperty('--term-font-size', `${opts.fontSize}px`);
  if (opts.lineHeight) el.style.setProperty('--term-line-height', String(opts.lineHeight));
  // Fill the holder; the default wterm chrome (padding, radius, shadow) fights the modal.
  el.classList.add('term-wterm-host');

  const term = new WTerm(el, {
    core,
    autoResize: true,
    cursorBlink: opts.cursorBlink !== false && !opts.disableStdin,
    // Always pass onData so wterm does NOT echo keystrokes (the PTY echoes).
    // Firehose (disableStdin) still gets a no-op so typing never paints locally.
    onData: opts.disableStdin ? () => {} : (opts.onData || (() => {})),
    onResize: opts.onResize || null,
  });
  await term.init();

  // Selection: DOM-native. Mirror into the in-app clipboard tray the same way
  // xterm's onSelectionChange does.
  let selCb = null;
  const onSelChange = () => {
    if (!selCb) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    if (!el.contains(sel.anchorNode)) return;
    const t = sel.toString();
    if (t) selCb(t);
  };
  document.addEventListener('selectionchange', onSelChange);

  // Path clicks: caret under the pointer → expand to a path token on that row.
  let pathActivate = null;
  const onPathClick = (e) => {
    if (!pathActivate) return;
    // A drag-selection is not a path click.
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && el.contains(sel.anchorNode)) return;
    const path = pathAtPoint(el, e.clientX, e.clientY);
    if (path) {
      e.preventDefault();
      e.stopPropagation();
      pathActivate(path.replace(/:\d+(?::\d+)?$/, ''));
    }
  };
  el.addEventListener('click', onPathClick);

  const handle = {
    engine: 'wterm',
    get cols() { return term.cols; },
    get rows() { return term.rows; },
    get theme() { return palette.name; },
    write(data) { term.write(data); },
    writeln(s) { term.write(String(s) + '\r\n'); },
    focus() { term.focus(); },
    // autoResize already observes the holder; fit() is a no-op nudge for callers
    // that refit after a layout settle (fullscreen toggle, etc.).
    fit() {
      try {
        // Force the ResizeObserver path by dispatching a window resize is too blunt;
        // measure the holder and call resize if we can count cells.
        const rh = parseFloat(getComputedStyle(el).getPropertyValue('--term-row-height')) || 17;
        const ch = measureCh(el);
        if (!ch || !rh) return;
        const cols = Math.max(2, Math.floor(el.clientWidth / ch));
        const rows = Math.max(1, Math.floor(el.clientHeight / rh));
        if (cols !== term.cols || rows !== term.rows) term.resize(cols, rows);
      } catch { /* mid-teardown */ }
    },
    // Clear screen + scrollback (CSI 3 J) and home the cursor. Closest to xterm.reset()
    // without tearing the WASM core down.
    reset() { term.write('\x1b[H\x1b[2J\x1b[3J'); },
    setTheme(nameOrObj) {
      palette = resolvePalette(nameOrObj);
      applyWtermPalette(el, palette);
    },
    getSelection() {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) return '';
      if (!el.contains(sel.anchorNode)) return '';
      return sel.toString();
    },
    hasSelection() { return !!handle.getSelection(); },
    clearSelection() {
      try {
        const sel = window.getSelection();
        if (sel && el.contains(sel.anchorNode)) sel.removeAllRanges();
      } catch { /* */ }
    },
    onSelectionChange(cb) { selCb = cb; return () => { if (selCb === cb) selCb = null; }; },
    attachCustomKeyEventHandler() { /* native DOM copy/paste already works */ },
    registerPathLinks(activate) {
      pathActivate = activate;
      return () => { if (pathActivate === activate) pathActivate = null; };
    },
    dispose() {
      document.removeEventListener('selectionchange', onSelChange);
      el.removeEventListener('click', onPathClick);
      selCb = null;
      pathActivate = null;
      try { term.destroy(); } catch { /* */ }
      el.classList.remove('term-wterm-host', 'term-theme-dark', 'term-theme-light');
    },
  };
  return handle;
}

// Average advance of one monospace cell — used only to nudge a manual fit().
function measureCh(el) {
  const probe = document.createElement('span');
  probe.textContent = 'MMMMMMMMMM';
  probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;font:inherit';
  el.appendChild(probe);
  const w = probe.getBoundingClientRect().width / 10;
  probe.remove();
  return w || 0;
}

// Find a path-shaped token under the click, from the row's text content.
function pathAtPoint(root, x, y) {
  let node = null;
  let offset = 0;
  if (document.caretRangeFromPoint) {
    const r = document.caretRangeFromPoint(x, y);
    if (r) { node = r.startContainer; offset = r.startOffset; }
  } else if (document.caretPositionFromPoint) {
    const p = document.caretPositionFromPoint(x, y);
    if (p) { node = p.offsetNode; offset = p.offset; }
  }
  if (!node) return null;
  // Walk up to a .term-row if the renderer tagged one; else use the nearest block.
  let row = node.nodeType === 3 ? node.parentElement : node;
  while (row && row !== root && !row.classList?.contains('term-row')) row = row.parentElement;
  const rowEl = (row && row !== root) ? row : (node.nodeType === 3 ? node.parentElement : node);
  if (!rowEl || !root.contains(rowEl)) return null;
  const text = rowEl.textContent || '';
  if (!text.trim()) return null;
  // Character offset of the caret within the row.
  let abs = 0;
  const walk = document.createTreeWalker(rowEl, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walk.nextNode())) {
    if (n === node) { abs += offset; break; }
    abs += n.textContent.length;
  }
  PATH_RE.lastIndex = 0;
  let m;
  while ((m = PATH_RE.exec(text)) !== null) {
    if (abs >= m.index && abs <= m.index + m[0].length) return m[0];
  }
  return null;
}
