// Browser-local preferences for the in-browser terminals (zee shell, container shell,
// queenzee firehose). Stored in localStorage so they survive refresh and never need a
// server round-trip.
//
//   termEngine  — xterm (default) | wterm. Opt-in via Console settings ⚙.
//   termTheme   — dark (default) | light. Toggled on the open terminal next to the
//                 engine pill; also applied at the next open.

const ENGINE_KEY = 'zeehive.termEngine';
const THEME_KEY = 'zeehive.termTheme';

export const TERM_ENGINES = Object.freeze(['xterm', 'wterm']);
export const DEFAULT_TERM_ENGINE = 'xterm';
export const TERM_THEMES = Object.freeze(['dark', 'light']);
export const DEFAULT_TERM_THEME = 'dark';

const engineListeners = new Set();
const themeListeners = new Set();

export function getTermEngine() {
  try {
    const v = localStorage.getItem(ENGINE_KEY);
    if (v && TERM_ENGINES.includes(v)) return v;
  } catch { /* private mode / no storage */ }
  return DEFAULT_TERM_ENGINE;
}

export function setTermEngine(engine) {
  const next = TERM_ENGINES.includes(engine) ? engine : DEFAULT_TERM_ENGINE;
  try { localStorage.setItem(ENGINE_KEY, next); } catch { /* private mode */ }
  for (const fn of engineListeners) {
    try { fn(next); } catch { /* a bad subscriber must not break the rest */ }
  }
  return next;
}

export function onTermEngineChange(fn) {
  engineListeners.add(fn);
  return () => engineListeners.delete(fn);
}

export function getTermTheme() {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (v && TERM_THEMES.includes(v)) return v;
  } catch { /* private mode */ }
  return DEFAULT_TERM_THEME;
}

export function setTermTheme(theme) {
  const next = TERM_THEMES.includes(theme) ? theme : DEFAULT_TERM_THEME;
  try { localStorage.setItem(THEME_KEY, next); } catch { /* private mode */ }
  for (const fn of themeListeners) {
    try { fn(next); } catch { /* */ }
  }
  return next;
}

export function onTermThemeChange(fn) {
  themeListeners.add(fn);
  return () => themeListeners.delete(fn);
}

// Palette used by both engines. color-0 = bg and color-7 = fg so reverse-video
// (wterm maps DEFAULT bg → index 7) stays readable instead of a muddy yellow/gray.
export const TERM_THEME_PALETTES = Object.freeze({
  dark: {
    background: '#0b0e14',
    foreground: '#c9d3e0',
    cursor: '#c9d3e0',
    // ANSI 0–15. 0/7/8/15 locked to bg/fg so reverse and dim stay coherent.
    colors: {
      0: '#0b0e14', 1: '#f44747', 2: '#6a9955', 3: '#d7ba7d',
      4: '#569cd6', 5: '#c586c0', 6: '#4ec9b0', 7: '#c9d3e0',
      8: '#5a6577', 9: '#ff6b6b', 10: '#89d185', 11: '#e2c08d',
      12: '#6cb6ff', 13: '#d2a8e8', 14: '#56d4c1', 15: '#eef2f7',
    },
  },
  light: {
    background: '#f4f6f9',
    foreground: '#1a1f2a',
    cursor: '#1a1f2a',
    colors: {
      0: '#1a1f2a', 1: '#c42b2b', 2: '#2f7d32', 3: '#8a6d1d',
      4: '#1b6ec2', 5: '#9b4d96', 6: '#0e7c7b', 7: '#f4f6f9',
      8: '#6b7380', 9: '#e03e3e', 10: '#3fa046', 11: '#b08d24',
      12: '#2b7fd4', 13: '#b45faf', 14: '#149492', 15: '#ffffff',
    },
  },
});
