// ── XELL SEARCH: filter the honeycomb's xells by keywords ──
//
// The honeycomb draws ONE LEVEL of the work-node tree, so "where is the xell working on the auth
// refactor?" used to mean drilling node by node. The search box (🔍 in the crumb strip, hotkey `/`
// or Ctrl/⌘+K) answers it: while a query is set, the level is replaced by EVERY xell of the project
// whose searchable text holds ALL the keywords (AND, case-insensitive, substring). Clearing the
// query puts the level back exactly as it was.
//
// Pure on purpose — App.jsx wires it, test/xell-search.test.mjs runs it for real.

// keywords of a query: whitespace-split, lowercased, empties dropped
export const searchTokens = (q) =>
  String(q || '').toLowerCase().split(/\s+/).filter(Boolean);

// every field a human would plausibly type to find a xell — its name, branch, task, its zee and
// that zee's harness/runtime/model, its status, its environment, and the card it sits on
const FIELDS = ['slug', 'branch', 'status', 'task_text', 'zee_name', 'zee_title', 'zee_status',
  'zee_kind', 'zee_model', 'harness_key', 'harness_label', 'runtime_label', 'runtime_key',
  'runtime_vendor', 'env_key', 'source_coupling', 'db_coupling'];

export const xellHaystack = (x) => {
  if (!x) return '';
  const parts = FIELDS.map((f) => x[f]);
  if (x.is_production) parts.push('production prod');
  if (x.work_item) parts.push(x.work_item.title, x.work_item.status);
  return parts.filter((v) => v != null && v !== '').join(' ').toLowerCase();
};

// does this xell hold EVERY keyword? An empty query matches everything.
export const xellMatches = (x, tokens) => {
  if (!tokens || !tokens.length) return true;
  const hay = xellHaystack(x);
  return tokens.every((t) => hay.includes(t));
};

// the search HOTKEY: `/` (no modifiers), Ctrl/⌘+K or the FIND key Ctrl/⌘+F — but never while the human is typing into
// something else, so a `/` in a composer stays a `/` — and never inside a terminal at all, where
// Ctrl+K is the shell's kill-line.
export const isSearchHotkey = (e) => {
  if (!e) return false;
  const t = e.target;
  if (t && typeof t.closest === 'function' && t.closest('.xterm')) return false;
  const editable = !!t && (!!t.isContentEditable
    || /^(INPUT|TEXTAREA|SELECT)$/.test(String(t.tagName || '').toUpperCase()));
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && ['k', 'f'].includes(String(e.key).toLowerCase())) return true;
  if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey && !editable) return true;
  return false;
};
